"""MCP in program cards (reads, and writes behind the engine's grant): the owner's MCP tools, through Hermes's own client.

The engine lives in the shared Node runtime
(extensions/ocuclaw/src/tools/glasses-ui-program-card-mcp.ts): the gate, the
wearer's yes, the limits and the card's `pick`. On Hermes its host adapter
(src/runtime/program-card-mcp-hosts.ts) asks this parent over the control link.
Every call rides the MCP connection Hermes already holds, so no token, URL or
second connection is made here.

``program_card.mcp.list`` ``{}``
    -> ``{ok: true, writes: true, servers: [{name, connected, writes?, reason?,
    fix?, tools: [{name, description, inputSchema, annotations}]}]}`` or
    ``{ok: false, reason: "unsupported" | "failed" | "no_servers"}``.
    ``writes: true`` tells the engine this parent runs a card's granted write
    (a parent before #6111 leaves it out, so the engine answers writes ``off``).
    A server whose write tools Hermes would ask about itself (``trust:
    untrusted``) or charge against a spend limit (``tool_costs`` /
    ``spend_limit``) lists ``writes: false, reason: "host_blocked"`` and the
    owner's ``fix``: the card's prompt must be the only prompt, and Hermes's own
    would land where nobody answers it. One row per enabled server in ``mcp_servers``.
    ``connected`` says whether Hermes's MCP client has a live session for it.
    ``tools`` are the tools that client knows for it, after the server's own
    ``tools.include`` / ``tools.exclude`` filter. ``annotations`` carries the
    four MCP hints as booleans when known. ``readOnlyHint`` is true only when
    the server marks the tool read-only AND Hermes recorded it as read-only at
    discovery, which is the fact Hermes's own trust gate uses. Hermes has no
    public listing API, so this reads its MCP client's state (``tools.mcp_tool``)
    behind a feature check. Any missing piece answers ``unsupported`` and logs
    one warning; nothing here raises.

``program_card.mcp.call`` ``{server, tool, args, timeoutMs, write?, ownerWrite?}``
    -> ``{ok: true, structured?, text?, isError?, truncated?}`` or ``{ok: false,
    code: "not_allowed" | "timeout" | "busy" | "failed"}``. The documented
    ``ctx.call_mcp`` runs on this module's own small thread pool with the
    call's own deadline (1 to 30 s). It answers only for a server in
    ``plugins.entries.ocuclaw.mcp_allowlist``; any other raises PermissionError,
    which reads ``not_allowed``. A call without ``write`` is a read: the parent
    refuses (``not_allowed``) a tool the listing would not call a read, or one
    the owner marked "Treat as a write" (``ownerWrite``). ``write: true`` is a
    write the engine already checked (the wearer's grant, the prompt or
    auto-send, the caps): the parent still refuses a tool outside the server's
    filter, a ``destructiveHint`` tool and a ``host_blocked`` server. A write
    runs once. Hermes's client does not replay a call that may have reached the
    server (a session expiry or a stdio child that died mid-call answers
    "outcome uncertain"; it retries only a 401 or a child already dead before
    dispatch), and nothing here retries.

``program_card.mcp.allow`` ``{server, allow}`` -> ``{ok: true}`` or
    ``{ok: false, code}``. The owner's per-server switch: adds the server to, or
    takes it off, ``plugins.entries.ocuclaw.mcp_allowlist`` in config.yaml, with
    the same raw write and read-back as ``optional_setup.allow_prediction_model``.
    ``ctx.call_mcp`` reads that list on every call, so no restart is needed.

Main profile only. Under a profile multiplexer the listing and the calls
resolve servers in the gateway's current scope, so another profile's servers
are not listed (a known gap).

Tool arguments and results are never logged.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import copy
import json
import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

PROGRAM_CARD_MCP_LIST_METHOD = "program_card.mcp.list"
PROGRAM_CARD_MCP_CALL_METHOD = "program_card.mcp.call"
PROGRAM_CARD_MCP_ALLOW_METHOD = "program_card.mcp.allow"

#: ``ctx.call_mcp`` reads its per-server grant at ``plugins.entries.<plugin>.mcp_allowlist``.
ALLOWLIST_ENTRY_PATH = ("plugins", "entries", "ocuclaw")
ALLOWLIST_KEY = "mcp_allowlist"

# The engine's own name rules (glasses-ui-program-card-mcp.ts SERVER_NAME / TOOL_NAME).
SERVER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
LISTED_TOOL_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$")
TOOL_NAME_MAX = 128
HINTS = ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint")
_SNAKE_HINTS = {
    "readOnlyHint": "read_only_hint",
    "destructiveHint": "destructive_hint",
    "idempotentHint": "idempotent_hint",
    "openWorldHint": "open_world_hint",
}

CALL_TIMEOUT_DEFAULT_MS = 10_000
CALL_TIMEOUT_MIN_MS = 1000
CALL_TIMEOUT_MAX_MS = 30_000
# The child's link waits 2 s past the call's deadline; the parent answers inside that.
CALL_GRACE_S = 1.0
# Calls run on their own small pool: a call that outlives its answer keeps its
# thread until Hermes gives up, and must not starve the loop's default executor.
CALL_WORKERS = 4
# Calls waiting or running at once; past this the answer is `busy` (the engine queues 16).
CALL_MAX_IN_FLIGHT = 16
MAX_SERVERS = 32
MAX_TOOLS_PER_SERVER = 200
DESCRIPTION_MAX = 300
SCHEMA_BYTES_MAX = 16 * 1024
# The answer rides one link frame (LINK_MAX_LINE_BYTES, 1 MiB). Schemas past
# this budget go out as null; the engine reads a null schema as "none given".
LISTING_SCHEMA_BUDGET = 640 * 1024
LOCK_WAIT_S = 2.0
# How Hermes words a call that ran out of time (tools/mcp_tool_loop.py).
_TIMEOUT_TEXT = re.compile(r"TimeoutError|timed out", re.IGNORECASE)
_ALLOW_CODES = frozenset({"profile_unavailable", "primary_runtime_required"})

_FAILED: Dict[str, Any] = {"ok": False, "code": "failed"}


def _is_control(ch: str) -> bool:
    """C0, DEL and C1 (the engine's CONTROL class): Unicode category Cc."""
    return unicodedata.category(ch) == "Cc"


class _Unsupported(Exception):
    """Hermes's MCP client state is not the shape this reader knows."""


@dataclass(frozen=True)
class _Internals:
    servers: Dict[Any, Any]
    hints: Dict[Any, Any]
    lock: Any
    resolve_key: Callable[[str], Any]
    tool_filter: Callable[[str, dict], Callable[[str], bool]]
    enabled: Callable[[dict], bool]


_warned: set = set()


def _warn_once(reason: str) -> None:
    if reason in _warned:
        return
    _warned.add(reason)
    logger.warning(
        "[ocuclaw] MCP in cards: Hermes's MCP client state is not readable (%s); cards read no MCP tools",
        reason,
    )


def _internals() -> _Internals:
    """Hermes's MCP client ledgers, checked for the shape this reader knows.

    Not a pinned version: the attributes must exist with the expected types.
    ``_core`` is ``tools.mcp_tool`` itself, resolved on access. These four
    private imports are deliberate (no public listing API) and sit in
    tests/fixtures/private-surface-baseline.json.
    """
    try:
        from tools.mcp_tool_common import _core, mcp_server_enabled
        from tools.mcp_tool_registration import _make_tool_filter
        from tools.mcp_tool_scope import _resolve_server_key
    except Exception as exc:  # noqa: BLE001 - an older or newer Hermes
        raise _Unsupported(f"import: {type(exc).__name__}") from None
    try:
        servers = _core._servers
        hints = _core._tool_read_only_hints
        lock = _core._lock
    except Exception as exc:  # noqa: BLE001 - renamed or moved ledgers
        raise _Unsupported(f"ledger: {type(exc).__name__}") from None
    if not isinstance(servers, dict) or not isinstance(hints, dict):
        raise _Unsupported("ledger shape")
    if not callable(getattr(lock, "acquire", None)) or not callable(getattr(lock, "release", None)):
        raise _Unsupported("lock shape")
    for helper in (_resolve_server_key, _make_tool_filter, mcp_server_enabled):
        if not callable(helper):
            raise _Unsupported("helper shape")
    return _Internals(servers, hints, lock, _resolve_server_key, _make_tool_filter, mcp_server_enabled)


def _configured_servers(enabled: Callable[[dict], bool]) -> Dict[str, dict]:
    """The owner's enabled ``mcp_servers``, by name, sorted (only names and filters are read)."""
    from hermes_cli.config import read_raw_config

    raw = read_raw_config()
    if not isinstance(raw, Mapping):
        raise ValueError("config")
    servers = raw.get("mcp_servers")
    if servers is None:
        return {}
    if not isinstance(servers, Mapping):
        raise ValueError("mcp_servers")
    out: Dict[str, dict] = {}
    for name in sorted(key for key in servers if isinstance(key, str)):
        spec = servers[name]
        if not SERVER_NAME.match(name) or not isinstance(spec, Mapping):
            continue
        spec = dict(spec)
        if enabled(spec):
            out[name] = spec
    return out


def _snapshot(internals: _Internals, names: List[str]) -> Dict[str, Dict[str, Any]]:
    """Each server's session, tools and recorded read-only hints, copied under Hermes's lock.

    The key comes from ``_resolve_server_key``, the resolver ``ctx.call_mcp``'s
    own path uses, so the listing names the connection a call would reach.
    """
    if not internals.lock.acquire(timeout=LOCK_WAIT_S):
        raise TimeoutError("mcp lock")
    try:
        out: Dict[str, Dict[str, Any]] = {}
        for name in names:
            key = internals.resolve_key(name)
            server = internals.servers.get(key)
            recorded = internals.hints.get(key)
            out[name] = {
                "connected": server is not None and getattr(server, "session", None) is not None,
                "tools": list(getattr(server, "_tools", None) or ()) if server is not None else [],
                "hints": dict(recorded) if isinstance(recorded, Mapping) else {},
            }
        return out
    finally:
        internals.lock.release()


def _hints_of(tool: Any) -> Dict[str, bool]:
    """The server's own MCP hints for ``tool``, booleans only."""
    annotations = getattr(tool, "annotations", None)
    if annotations is None:
        return {}
    if isinstance(annotations, Mapping):
        raw: Any = annotations
    elif callable(getattr(annotations, "model_dump", None)):
        try:
            raw = annotations.model_dump(by_alias=True, exclude_none=True)
        except Exception:  # noqa: BLE001 - a model that will not dump has no hints
            raw = {}
    else:
        raw = {hint: getattr(annotations, hint, getattr(annotations, _SNAKE_HINTS[hint], None))
               for hint in HINTS}
    out: Dict[str, bool] = {}
    if isinstance(raw, Mapping):
        for hint in HINTS:
            value = raw.get(hint, raw.get(_SNAKE_HINTS[hint]))
            if isinstance(value, bool):
                out[hint] = value
    return out


def _effective_hints(tool: Any, name: str, recorded: Mapping[str, Any]) -> Dict[str, bool]:
    """``readOnlyHint`` is true only when the server says so and Hermes recorded it so."""
    hints = _hints_of(tool)
    if "readOnlyHint" in hints or name in recorded:
        hints["readOnlyHint"] = hints.get("readOnlyHint") is True and recorded.get(name) is True
    return hints


def _is_read(hints: Mapping[str, bool]) -> bool:
    return hints.get("readOnlyHint") is True and hints.get("destructiveHint") is not True


def _write_block(name: str, spec: Mapping[str, Any]) -> Optional[str]:
    """The owner's fix when Hermes would put its own prompt or budget in front of a card's write.

    ``trust`` reads as Hermes normalizes it (tools/mcp_tool_registration.py
    ``_normalize_server_trust``): missing is ``full``, anything but ``full`` or
    ``untrusted`` is ``untrusted``. Hermes asks before an untrusted server's
    write tool, and before a costed call past the chat's spend limit; from a
    card's worker thread nobody can answer that, so such writes stay off.
    """
    trust = spec.get("trust")
    if trust is not None and str(trust).strip().lower() != "full":
        return f"Set trust: full on mcp_servers.{name} in Hermes's config.yaml"
    if spec.get("tool_costs") is not None or spec.get("spend_limit") is not None:
        return f"Cards cannot send to {name} while mcp_servers.{name} has tool_costs or spend_limit in Hermes's config.yaml"
    return None


def _schema(tool: Any, budget: List[int]) -> Optional[dict]:
    raw = getattr(tool, "inputSchema", None)
    if raw is None:
        raw = getattr(tool, "input_schema", None)
    if not isinstance(raw, Mapping):
        return None
    try:
        # Compact, as the engine (glasses-ui-program-card-mcp.ts jsonBytes) and
        # the link frame measure it. A lone surrogate fails here, not the listing.
        text = json.dumps(raw, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        size = len(text.encode("utf-8"))
    except (TypeError, ValueError):
        return None
    if size > SCHEMA_BYTES_MAX or size > budget[0]:
        return None
    budget[0] -= size
    return json.loads(text)


def _description(tool: Any) -> str:
    raw = getattr(tool, "description", None)
    if not isinstance(raw, str):
        return ""
    return "".join(ch for ch in " ".join(raw.split()) if not _is_control(ch))[:DESCRIPTION_MAX]


def _tool_filter(internals: _Internals, name: str, spec: dict) -> Callable[[str], bool]:
    """The server's own ``tools.include`` / ``tools.exclude`` rule; a malformed one offers nothing."""
    try:
        allowed = internals.tool_filter(name, spec)
    except Exception:  # noqa: BLE001 - one server's bad filter must not hide the others
        allowed = None
    return allowed if callable(allowed) else (lambda _tool: False)


def list_tools_sync() -> Dict[str, Any]:
    """The listing (blocking: reads config.yaml and takes Hermes's MCP lock)."""
    try:
        internals = _internals()
    except _Unsupported as exc:
        _warn_once(str(exc))
        return {"ok": False, "reason": "unsupported"}
    try:
        configured = _configured_servers(internals.enabled)
    except Exception as exc:  # noqa: BLE001 - unreadable config
        logger.warning("[ocuclaw] MCP in cards: mcp_servers is not readable (%s)", type(exc).__name__)
        return {"ok": False, "reason": "failed"}
    if not configured:
        return {"ok": False, "reason": "no_servers"}
    names = list(configured)[:MAX_SERVERS]
    try:
        state = _snapshot(internals, names)
    except TimeoutError:
        logger.warning("[ocuclaw] MCP in cards: Hermes's MCP client is busy; tool list skipped")
        return {"ok": False, "reason": "failed"}
    except Exception as exc:  # noqa: BLE001 - changed ledger shape
        _warn_once(f"snapshot: {type(exc).__name__}")
        return {"ok": False, "reason": "unsupported"}
    granted = _granted_servers()
    budget = [LISTING_SCHEMA_BUDGET]
    servers: List[Dict[str, Any]] = []
    try:
        for name in names:
            entry = state[name]
            allowed = _tool_filter(internals, name, configured[name])
            tools: List[Dict[str, Any]] = []
            seen = set()
            for tool in entry["tools"]:
                if len(tools) >= MAX_TOOLS_PER_SERVER:
                    break
                tool_name = getattr(tool, "name", None)
                if (not isinstance(tool_name, str) or not LISTED_TOOL_NAME.match(tool_name)
                        or tool_name in seen or not allowed(tool_name)):
                    continue
                seen.add(tool_name)
                tools.append({
                    "name": tool_name,
                    "description": _description(tool),
                    "inputSchema": _schema(tool, budget),
                    "annotations": _effective_hints(tool, tool_name, entry["hints"]),
                })
            row: Dict[str, Any] = {"name": name, "connected": entry["connected"], "tools": tools}
            if granted is not None:
                row["granted"] = name in granted
            fix = _write_block(name, configured[name])
            if fix is not None:
                row.update({"writes": False, "reason": "host_blocked", "fix": fix})
            servers.append(row)
    except Exception as exc:  # noqa: BLE001 - changed tool shape
        _warn_once(f"tools: {type(exc).__name__}")
        return {"ok": False, "reason": "unsupported"}
    return {"ok": True, "writes": True, "servers": servers}


def _tool_gate(server: str, tool: str, write: bool) -> Optional[bool]:
    """Whether the listing would offer ``server``/``tool`` for this call; None when unknowable.

    A read must be a read. A write needs the tool inside the server's filter,
    not destructive, on a server Hermes will not stop with its own prompt.
    """
    try:
        internals = _internals()
    except _Unsupported as exc:
        _warn_once(str(exc))
        return None
    try:
        configured = _configured_servers(internals.enabled)
        spec = configured.get(server)
        if spec is None or not _tool_filter(internals, server, spec)(tool):
            return False
        if write and _write_block(server, spec) is not None:
            return False
        entry = _snapshot(internals, [server])[server]
        for known in entry["tools"]:
            if getattr(known, "name", None) == tool:
                hints = _effective_hints(known, tool, entry["hints"])
                return hints.get("destructiveHint") is not True if write else _is_read(hints)
        return False
    except Exception as exc:  # noqa: BLE001 - unreadable config or changed shape
        logger.warning("[ocuclaw] MCP in cards: could not check a tool before a call (%s)", type(exc).__name__)
        return None


def _registered_part(value: str) -> str:
    """One part of Hermes's registered MCP tool name (``mcp__<server>__<tool>``, sanitized)."""
    return re.sub(r"[^A-Za-z0-9_]", "_", value)


def tool_call_mcp(tool_name: str) -> Optional[Dict[str, Any]]:
    """#6422: ``{server, tool, annotations}`` when an agent's tool call is one of the owner's MCP tools.

    Hermes registers an MCP tool as ``mcp__<server>__<tool>`` (older hosts
    ``mcp_<server>_<tool>``), each part sanitized. The server is matched by
    name, longest first; the tool's hints come from the same snapshot the
    card listing uses. A tool not found in the snapshot keeps empty hints, so
    it counts as a step to allow, never a read. None for any other tool.
    """
    name = str(tool_name or "")
    if not name.startswith("mcp_"):
        return None
    try:
        internals = _internals()
        configured = _configured_servers(internals.enabled)
    except Exception:  # noqa: BLE001 - unreadable config or another Hermes
        return None
    for server in sorted(configured, key=len, reverse=True):
        part = _registered_part(server)
        rest = None
        for prefix in (f"mcp__{part}__", f"mcp_{part}_"):
            if name.startswith(prefix) and len(name) > len(prefix):
                rest = name[len(prefix):]
                break
        if rest is None:
            continue
        annotations: Dict[str, bool] = {}
        tool = rest
        try:
            entry = _snapshot(internals, [server])[server]
            for known in entry["tools"]:
                raw = getattr(known, "name", None)
                if isinstance(raw, str) and _registered_part(raw) == rest:
                    tool = raw
                    annotations = _effective_hints(known, raw, entry["hints"])
                    break
        except Exception:  # noqa: BLE001 - no hints: the step asks
            annotations = {}
        return {"server": server, "tool": tool, "annotations": annotations}
    return None


def _call_request(params: Any) -> Optional[tuple]:
    """``(server, tool, args, timeout_s, write, owner_write)`` from the child's params, or None when malformed."""
    if not isinstance(params, Mapping):
        return None
    server, tool, args = params.get("server"), params.get("tool"), params.get("args")
    if not isinstance(server, str) or not SERVER_NAME.match(server):
        return None
    if not isinstance(tool, str) or not tool or len(tool) > TOOL_NAME_MAX or any(map(_is_control, tool)):
        return None
    if not isinstance(args, dict):
        return None
    timeout_ms = params.get("timeoutMs")
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or timeout_ms != timeout_ms:
        timeout_ms = CALL_TIMEOUT_DEFAULT_MS
    timeout_ms = max(CALL_TIMEOUT_MIN_MS, min(CALL_TIMEOUT_MAX_MS, float(timeout_ms)))
    return server, tool, args, timeout_ms / 1000, params.get("write") is True, params.get("ownerWrite") is True


def call_answer(envelope: Any) -> Dict[str, Any]:
    """``ctx.call_mcp``'s envelope as the engine's call answer.

    The envelope (hermes_cli/plugins.py ``_mcp_envelope``): ``{ok: true,
    result, structuredContent?}`` or ``{ok: false, error}``, plus
    ``truncated: true`` past 64 KB (``result`` is then the cut raw text, which
    is not worth sending). ``result`` is the tool's text, or its structured
    content when the server sent no text. ``{ok: false}`` is a tool's error
    result or a transport failure; Hermes words a deadline as a TimeoutError.
    """
    if not isinstance(envelope, Mapping):
        return dict(_FAILED)
    if envelope.get("truncated") is True:
        return {"ok": True, "truncated": True}
    if envelope.get("ok") is not True:
        error = envelope.get("error")
        if isinstance(error, str) and _TIMEOUT_TEXT.search(error):
            return {"ok": False, "code": "timeout"}
        return {"ok": True, "isError": True}
    out: Dict[str, Any] = {"ok": True}
    structured = envelope.get("structuredContent")
    result = envelope.get("result")
    if structured is not None:
        out["structured"] = structured
    if isinstance(result, str):
        out["text"] = result
    elif result is not None and structured is None:
        out["structured"] = result
    return out


def _call_sync(call_mcp: Callable[..., Any], server: str, tool: str, args: dict, timeout_s: float,
               write: bool = False, owner_write: bool = False) -> Dict[str, Any]:
    if owner_write and not write:
        return {"ok": False, "code": "not_allowed"}
    gate = _tool_gate(server, tool, write)
    if gate is None:
        return dict(_FAILED)
    if gate is False:
        return {"ok": False, "code": "not_allowed"}
    return call_answer(call_mcp(server, tool, args, timeout=timeout_s))


_CALL_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=CALL_WORKERS, thread_name_prefix="ocuclaw-card-mcp"
)
_in_flight = 0


async def program_card_mcp_list(params: Any = None) -> Dict[str, Any]:
    """``program_card.mcp.list``: never raises (except cancellation)."""
    try:
        return await asyncio.to_thread(list_tools_sync)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - executor failure
        logger.warning("[ocuclaw] MCP in cards: tool list failed (%s)", type(exc).__name__)
        return {"ok": False, "reason": "failed"}


async def program_card_mcp_call(ctx: Any, params: Any) -> Dict[str, Any]:
    """``program_card.mcp.call`` through ``ctx.call_mcp``: never raises (except cancellation)."""
    global _in_flight
    request = _call_request(params)
    if request is None:
        return dict(_FAILED)
    server, tool, args, timeout_s, write, owner_write = request
    call_mcp = getattr(ctx, "call_mcp", None) if ctx is not None else None
    if not callable(call_mcp):
        return dict(_FAILED)
    if _in_flight >= CALL_MAX_IN_FLIGHT:
        return {"ok": False, "code": "busy"}
    _in_flight += 1
    try:
        # A call still queued when its deadline passes is cancelled before it runs.
        return await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(
                _CALL_POOL, _call_sync, call_mcp, server, tool, args, timeout_s, write, owner_write
            ),
            timeout=timeout_s + CALL_GRACE_S,
        )
    except asyncio.CancelledError:
        raise
    except PermissionError:
        return {"ok": False, "code": "not_allowed"}
    except (asyncio.TimeoutError, TimeoutError):
        return {"ok": False, "code": "timeout"}
    except Exception as exc:  # noqa: BLE001 - Hermes, transport or server failure
        logger.warning("[ocuclaw] MCP in cards: a call to %s failed (%s)", server, type(exc).__name__)
        return dict(_FAILED)
    finally:
        _in_flight -= 1


def _allowlist_entry(doc: dict, create: bool) -> Optional[dict]:
    """``plugins.entries.ocuclaw`` in ``doc``; None when absent and not created."""
    node = doc
    for key in ALLOWLIST_ENTRY_PATH:
        child = node.get(key)
        if child is None:
            if not create:
                return None
            child = node[key] = {}
        if not isinstance(child, dict):
            raise ValueError("malformed")
        node = child
    return node


def _granted_servers() -> Optional[set]:
    """The servers ``ctx.call_mcp`` will call for this plugin now; None when unreadable.

    The listing reports each server's grant, so the engine reads a switch whose
    allowlist entry is missing (taken off by hand, or saved while another host
    served the same card library) as off instead of calling into a refusal.
    """
    from hermes_cli.config import read_raw_config

    try:
        raw = read_raw_config()
        entry = _allowlist_entry(raw, create=False) if isinstance(raw, dict) else None
    except Exception:  # noqa: BLE001 - malformed entry or unreadable config
        return None
    listed = entry.get(ALLOWLIST_KEY) if entry is not None else []
    if listed is None:
        listed = []
    if not isinstance(listed, list):
        return None
    return {item for item in listed if isinstance(item, str)}


def _next_allowlist(current: list, server: str, allow: bool) -> list:
    """``current`` with ``server`` listed once (allow) or not at all; other entries kept as they are."""
    if not allow:
        return [item for item in current if item != server]
    out, seen = [], False
    for item in current:
        if item == server:
            if seen:
                continue
            seen = True
        out.append(item)
    if not seen:
        out.append(server)
    return out


def allow_server(server: str, allow: bool) -> Dict[str, Any]:
    """Write ``plugins.entries.ocuclaw.mcp_allowlist`` for one server (blocking).

    The plugin's own resolved home (``optional_setup._home``, which refuses any
    profile but the Primary Runtime), under the optional-setup lock: the raw
    document, every other key untouched, saved without default stripping and
    read back. Idempotent; a no-op change writes nothing.
    """
    from hermes_cli.config import read_raw_config, save_config

    from . import optional_setup as setup
    from . import receipts

    home = setup._home()
    with receipts.receipt_state_lock(receipts.state_dir(home), setup.LOCK) as locked:
        if not locked:
            return {"ok": False, "code": "busy"}
        raw = read_raw_config()
        if not isinstance(raw, dict):
            return dict(_FAILED)
        doc = copy.deepcopy(raw)
        try:
            entry = _allowlist_entry(doc, create=allow)
        except ValueError:
            return dict(_FAILED)
        if entry is None:
            return {"ok": True}
        current = entry.get(ALLOWLIST_KEY)
        if current is None:
            current = []
        if not isinstance(current, list):
            return dict(_FAILED)
        wanted = _next_allowlist(current, server, allow)
        if wanted == current:
            return {"ok": True}
        entry[ALLOWLIST_KEY] = wanted
        save_config(doc, strip_defaults=False)
        back = read_raw_config()
        try:
            back_entry = _allowlist_entry(back, create=False) if isinstance(back, dict) else None
        except ValueError:
            back_entry = None
        listed = back_entry.get(ALLOWLIST_KEY) if back_entry is not None else None
        if not isinstance(listed, list) or (server in listed) is not allow:
            return dict(_FAILED)
    return {"ok": True}


async def program_card_mcp_allow(params: Any) -> Dict[str, Any]:
    """``program_card.mcp.allow``: never raises (except cancellation)."""
    if not isinstance(params, Mapping):
        return {"ok": False, "code": "invalid"}
    server, allow = params.get("server"), params.get("allow")
    if not isinstance(server, str) or not SERVER_NAME.match(server) or type(allow) is not bool:
        return {"ok": False, "code": "invalid"}
    try:
        return await asyncio.to_thread(allow_server, server, allow)
    except asyncio.CancelledError:
        raise
    except ValueError as exc:
        return {"ok": False, "code": str(exc) if str(exc) in _ALLOW_CODES else "failed"}
    except Exception as exc:  # noqa: BLE001 - config writer or lock failure
        logger.warning("[ocuclaw] MCP in cards: the switch for %s was not saved (%s)", server, type(exc).__name__)
        return dict(_FAILED)
