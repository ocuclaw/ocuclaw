"""Plain-English approval cards for Hermes: the purpose line and the context
the shared explainer needs.

The card gets two optional extras, the same on both backends:

* ``purpose`` — the agent's own words for why it runs the command. Hermes's
  ``terminal`` tool has no such argument, so this module adds an optional
  ``purpose`` string to the ``terminal`` schema the model sees (``llm_request``
  middleware, OcuClaw turns only) and pops it again in ``tool_request``
  middleware. Hermes runs request middleware before hooks, guardrails,
  approvals and execution (hermes_cli/middleware.py
  ``apply_tool_request_middleware``), so the dangerous-command check, smart
  approval and auto-approval see exactly the arguments they see today.
* ``explanation`` — one model-written sentence. The prompt and every guard
  live in the shared Node runtime (extensions/ocuclaw/src/runtime/
  approval-explainer.ts). This side only hands it the context
  (``ocuclawApprovalContext`` on the approval event: purpose, the wearer's
  last message, the agent's text and thinking) and answers its model call
  with ``ctx.llm`` (:func:`approval_llm_complete`).

Everything here is best effort: no failure may block, delay or change an
approval decision.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

TERMINAL_TOOL_NAME = "terminal"
PURPOSE_FIELD = "purpose"
PURPOSE_MAX_CHARS = 120
# Same contract as OpenClaw's exec ``title`` ("Every call: short purpose;
# never claim success. No secrets."), worded for the person approving.
PURPOSE_FIELD_DESCRIPTION = (
    "Every call: what this command does and why, in plain words for the "
    "person who may have to approve it, e.g. 'Delete the old build folder so "
    "the rebuild starts clean'. Not 'run the command'. Never claim success. "
    "No secrets."
)
PURPOSE_FIELD_SCHEMA: Dict[str, Any] = {
    "type": "string",
    "description": PURPOSE_FIELD_DESCRIPTION,
}
MIDDLEWARE_SOURCE = "ocuclaw"

# The child asks for the explainer's model call over this link method.
APPROVAL_LLM_COMPLETE_METHOD = "approval.llm.complete"
APPROVAL_LLM_PURPOSE = "ocuclaw.approval.explain"
APPROVAL_LLM_DEFAULT_TIMEOUT_S = 5.0
APPROVAL_LLM_MAX_TIMEOUT_S = 10.0
APPROVAL_LLM_MAX_TOKENS = 1024
APPROVAL_LLM_MAX_MESSAGES = 4
APPROVAL_LLM_MAX_CONTENT_CHARS = 8000

# The child pushes the wearer's "Explain commands" setting over this link
# method: ``{"enabled": bool}``. Off means no ``purpose`` schema field (no
# extra tokens) and no purpose or context on the approval event.
APPROVAL_EXPLAIN_SETTING_METHOD = "approval.explain.setting"

CONTEXT_TEXT_MAX_CHARS = 600
_CONTEXT_TTL_S = 600.0
_MAX_TRACKED = 256

# Control, zero-width and bidi characters. Built from code points so this
# file carries no invisible characters itself.
_INVISIBLE_RANGES = (
    (0x00, 0x1F), (0x7F, 0x9F), (0x200B, 0x200F),
    (0x2028, 0x202E), (0x2060, 0x206F), (0xFEFF, 0xFEFF),
)
_CONTROL_RE = re.compile(
    "[" + "".join(f"\\u{lo:04x}-\\u{hi:04x}" for lo, hi in _INVISIBLE_RANGES) + "]"
)
# Markdown markup, matched as pairs so names like node_modules and *.log
# survive.
_CODE_RE = re.compile(r"`+")
_STRONG_RE = re.compile(r"(\*\*|__)(.+?)\1")
_EMPHASIS_RE = re.compile(r"(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])")
_LEAD_RE = re.compile(r"^[#>\s]+")
_SPACE_RE = re.compile(r"\s+")
# The pair regexes above are lazy and backtrack, so they are quadratic on long
# unclosed runs: a model-written purpose of tens of thousands of " *a" stalled
# the agent thread for seconds (#7326). They only ever run on this many
# characters; the result is capped far below it anyway.
_CLEAN_SCAN_CHARS = 1000


# -- text hygiene ----------------------------------------------------------


def clean_line(value: Any, max_chars: int) -> str:
    """One plain line: markup and control characters stripped, capped.

    Returns "" for anything that is not a non-blank string.
    """
    if not isinstance(value, str):
        return ""
    text = _CONTROL_RE.sub(" ", value)
    text = _SPACE_RE.sub(" ", text).strip()
    # The linear passes run on the whole value first, so long invisible,
    # backtick or "#"/">" padding cannot push the real words past the clip.
    text = _CODE_RE.sub("", text)
    text = _LEAD_RE.sub("", text)
    scan_chars = max(_CLEAN_SCAN_CHARS, max_chars * 2)
    clipped = len(text) > scan_chars
    text = text[:scan_chars]
    text = _STRONG_RE.sub(r"\2", text)
    text = _EMPHASIS_RE.sub(r"\2", text)
    text = _LEAD_RE.sub("", text).strip()
    if len(text) > max_chars or (clipped and text):
        text = text[: max_chars - 1].rstrip() + "…"
    return text


def message_text(value: Any) -> str:
    """Text of a chat message body: a string, or the text parts of a list."""
    if isinstance(value, str):
        return value
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        parts: List[str] = []
        for part in value:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, Mapping) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(parts)
    return ""


def _clip_tail(text: str, max_chars: int) -> str:
    """Keep the END: the words right before the call matter most."""
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return "…" + text[-(max_chars - 1):]


def user_message_context(content: Any) -> str:
    """A stored user message as the explainer's ``userMessage``: its text,
    the end kept, capped like the live capture (#4985)."""
    return _clip_tail(message_text(content), CONTEXT_TEXT_MAX_CHARS)


# -- the purpose field -----------------------------------------------------


def _bare_tool_name(name: Any) -> str:
    if not isinstance(name, str):
        return ""
    # Anthropic OAuth lanes alias tools as ``mcp__<name>`` / ``mcp_<name>``
    # (agent/anthropic_adapter.py _MCP_TOOL_PREFIX).
    for prefix in ("mcp__", "mcp_"):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def _tool_schema_slot(tool: Any) -> Tuple[str, Optional[Dict[str, Any]], bool]:
    """(bare name, parameters schema, strict) for one provider tool entry.

    Covers every shape Hermes 0.21 puts in ``api_kwargs``: chat completions
    ``{"type": "function", "function": {...}}`` (Gemini native converts this
    one later, inside its client), Responses ``{"type": "function", "name",
    "parameters"}``, Anthropic ``{"name", "input_schema"}`` and Bedrock
    ``{"toolSpec": {"name", "inputSchema": {"json"}}}``.
    """
    if not isinstance(tool, dict):
        return "", None, False
    function = tool.get("function")
    if isinstance(function, dict):
        params = function.get("parameters")
        return (
            _bare_tool_name(function.get("name")),
            params if isinstance(params, dict) else None,
            bool(function.get("strict")) or bool(tool.get("strict")),
        )
    spec = tool.get("toolSpec")
    if isinstance(spec, dict):
        input_schema = spec.get("inputSchema")
        schema = input_schema.get("json") if isinstance(input_schema, dict) else None
        return _bare_tool_name(spec.get("name")), schema if isinstance(schema, dict) else None, False
    for key in ("parameters", "input_schema"):
        if isinstance(tool.get(key), dict):
            return _bare_tool_name(tool.get("name")), tool[key], bool(tool.get("strict"))
    return "", None, False


def _tool_lists(request: Dict[str, Any]) -> List[List[Any]]:
    lists: List[List[Any]] = []
    tools = request.get("tools")
    if isinstance(tools, list):
        lists.append(tools)
    tool_config = request.get("toolConfig")
    if isinstance(tool_config, dict) and isinstance(tool_config.get("tools"), list):
        lists.append(tool_config["tools"])
    return lists


def add_purpose_field(request: Any) -> bool:
    """Add the optional ``purpose`` property to the terminal tool, in place.

    Returns True when the request changed. Leaves strict-mode schemas alone:
    strict function calling requires every property to be required, and an
    optional field must never become a required one.
    """
    if not isinstance(request, dict):
        return False
    changed = False
    for tools in _tool_lists(request):
        for tool in tools:
            name, schema, strict = _tool_schema_slot(tool)
            if name != TERMINAL_TOOL_NAME or schema is None or strict:
                continue
            properties = schema.get("properties")
            if not isinstance(properties, dict) or "command" not in properties:
                continue
            if PURPOSE_FIELD in properties:
                continue
            properties[PURPOSE_FIELD] = dict(PURPOSE_FIELD_SCHEMA)
            changed = True
    return changed


def tool_calls_of(assistant_message: Any) -> List[Tuple[str, str, Any]]:
    """(tool_call_id, bare name, arguments) for each call on a message."""
    def field(obj: Any, name: str) -> Any:
        return obj.get(name) if isinstance(obj, Mapping) else getattr(obj, name, None)

    out: List[Tuple[str, str, Any]] = []
    for call in field(assistant_message, "tool_calls") or []:
        call_id = field(call, "id")
        function = field(call, "function")
        if function is None or not isinstance(call_id, str) or not call_id:
            continue
        out.append((call_id, _bare_tool_name(field(function, "name")), field(function, "arguments")))
    return out


def purpose_from_arguments(arguments: Any) -> str:
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except (ValueError, TypeError):
            return ""
    if not isinstance(arguments, Mapping):
        return ""
    return clean_line(arguments.get(PURPOSE_FIELD), PURPOSE_MAX_CHARS)


# -- per-approval context --------------------------------------------------


@dataclass(frozen=True)
class ApprovalContext:
    purpose: str = ""
    user_message: str = ""
    assistant_text: str = ""
    thinking_text: str = ""
    tool_call_id: str = ""

    def payload(self) -> Dict[str, str]:
        """``ocuclawApprovalContext`` for the shared explainer; blanks omitted."""
        fields = (
            ("purpose", self.purpose),
            ("userMessage", self.user_message),
            ("assistantText", self.assistant_text),
            ("thinkingText", self.thinking_text),
        )
        return {key: value for key, value in fields if value}


class ApprovalContextStore:
    """What we know about the turn behind each approval, kept so the
    gateway's ``send_exec_approval`` (session key + redacted command, no tool
    call id) can find it. Bounded and time-limited; thread-safe because the
    hooks run on the agent thread and the lookup on the gateway loop."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._purposes: "OrderedDict[str, Tuple[str, float]]" = OrderedDict()
        self._user_messages: "OrderedDict[str, Tuple[str, float]]" = OrderedDict()
        self._agent_turns: "OrderedDict[str, Tuple[str, str, float]]" = OrderedDict()
        self._requests: "OrderedDict[str, List[Tuple[str, str, float]]]" = OrderedDict()

    @staticmethod
    def _put(table: "OrderedDict[str, Any]", key: str, value: Any) -> None:
        table[key] = value
        table.move_to_end(key)
        while len(table) > _MAX_TRACKED:
            table.popitem(last=False)

    def _fresh(self, stamp: float) -> bool:
        return self._clock() - stamp <= _CONTEXT_TTL_S

    def record_purpose(self, tool_call_id: str, purpose: Any) -> None:
        purpose = clean_line(purpose, PURPOSE_MAX_CHARS)
        if not tool_call_id or not purpose:
            return
        with self._lock:
            self._put(self._purposes, tool_call_id, (purpose, self._clock()))

    def peek_purpose(self, tool_call_id: str) -> str:
        """A call's recorded ``purpose`` WITHOUT consuming it; "" when there
        is none or it went stale.

        The tool's activity frame reads the sentence here, at ``pre_tool_call``;
        :meth:`take` still finds it afterwards for the approval card. A plain
        read: it neither removes the entry nor refreshes its place in the
        bounded table.
        """
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return ""
        with self._lock:
            item = self._purposes.get(tool_call_id)
            return item[0] if item and self._fresh(item[1]) else ""

    def record_user_message(self, session_key: str, text: Any) -> None:
        body = message_text(text).strip()
        if not session_key or not body:
            return
        with self._lock:
            self._put(
                self._user_messages,
                session_key,
                (_clip_tail(body, CONTEXT_TEXT_MAX_CHARS), self._clock()),
            )

    def record_assistant_message(
        self, session_key: str, assistant_message: Any, reasoning: str = ""
    ) -> None:
        """The agent's text and thinking from the model call that asked for
        tools, plus any ``purpose`` it put on its terminal calls."""
        calls = tool_calls_of(assistant_message)
        for call_id, name, args in calls:
            if name == TERMINAL_TOOL_NAME:
                self.record_purpose(call_id, purpose_from_arguments(args))
        if not session_key or not calls:
            return
        content = (
            assistant_message.get("content")
            if isinstance(assistant_message, Mapping)
            else getattr(assistant_message, "content", None)
        )
        text = _clip_tail(message_text(content), CONTEXT_TEXT_MAX_CHARS)
        thinking = _clip_tail(reasoning or "", CONTEXT_TEXT_MAX_CHARS)
        with self._lock:
            self._put(self._agent_turns, session_key, (text, thinking, self._clock()))

    def record_approval_request(self, session_key: str, command: str, tool_call_id: str) -> None:
        if not session_key or not tool_call_id:
            return
        with self._lock:
            pending = [
                item for item in self._requests.get(session_key, []) if self._fresh(item[2])
            ]
            pending.append((command or "", tool_call_id, self._clock()))
            self._put(self._requests, session_key, pending[-8:])

    def _take_tool_call_id(self, session_key: str, command: str, redact) -> str:
        pending = [
            item for item in self._requests.get(session_key, []) if self._fresh(item[2])
        ]
        if not pending:
            self._requests.pop(session_key, None)
            return ""
        match = None
        for index in range(len(pending) - 1, -1, -1):
            raw = pending[index][0]
            if raw == command or (redact is not None and _safe_redact(redact, raw) == command):
                match = index
                break
        if match is None:
            # pre_approval_request fires on the agent thread immediately
            # before the gateway notify that reaches us; with no textual
            # match, the newest request in this session is the one.
            match = len(pending) - 1
        tool_call_id = pending.pop(match)[1]
        if pending:
            self._requests[session_key] = pending
        else:
            self._requests.pop(session_key, None)
        return tool_call_id

    def take(self, session_key: str, command: str, *, redact=None) -> ApprovalContext:
        with self._lock:
            tool_call_id = self._take_tool_call_id(session_key, command, redact)
            purpose = ""
            if tool_call_id:
                item = self._purposes.pop(tool_call_id, None)
                if item and self._fresh(item[1]):
                    purpose = item[0]
            user = self._user_messages.get(session_key)
            agent = self._agent_turns.get(session_key)
            agent_fresh = bool(agent and self._fresh(agent[2]))
            return ApprovalContext(
                purpose=purpose,
                user_message=user[0] if user and self._fresh(user[1]) else "",
                assistant_text=agent[0] if agent_fresh else "",
                thinking_text=agent[1] if agent_fresh else "",
                tool_call_id=tool_call_id,
            )


def _safe_redact(redact, text: str) -> str:
    try:
        return str(redact(text))
    except Exception:  # noqa: BLE001 - matching is best effort
        return text


# -- the wearer's setting ----------------------------------------------------


class ApprovalExplainSetting:
    """The wearer's "Explain commands" setting as last pushed by the child.

    On until the child says otherwise: an older child never pushes, and an
    absent setting means on (ocuclaw-settings-store.ts).
    """

    def __init__(self, enabled: bool = True) -> None:
        self._enabled = bool(enabled)
        self._lock = threading.Lock()

    def is_enabled(self) -> bool:
        with self._lock:
            return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            self._enabled = bool(enabled)

    def apply(self, params: Any) -> Dict[str, Any]:
        """Link handler body: ``{"enabled": bool}``; anything but ``False`` is on."""
        enabled = not (isinstance(params, Mapping) and params.get("enabled") is False)
        self.set_enabled(enabled)
        return {"ok": True, "enabled": enabled}


# -- middleware ------------------------------------------------------------


def make_llm_request_middleware(
    is_ocuclaw_platform: Callable[[Any], bool],
    is_enabled: Optional[Callable[[], bool]] = None,
):
    """``llm_request`` middleware: advertise ``purpose`` on OcuClaw turns only,
    and only while the wearer's "Explain commands" setting is on.

    Other platforms on the same gateway get no schema change at all.
    """

    def _middleware(request: Any = None, platform: Any = "", **_kwargs: Any):
        try:
            if not is_ocuclaw_platform(platform):
                return None
            if is_enabled is not None and not is_enabled():
                return None
            if not add_purpose_field(request):
                return None
            return {
                "request": request,
                "source": MIDDLEWARE_SOURCE,
                "reason": "approval purpose field",
            }
        except Exception:  # noqa: BLE001 - never break a model call
            logger.debug("[ocuclaw] purpose field middleware failed", exc_info=True)
            return None

    return _middleware


def make_tool_request_middleware(store: ApprovalContextStore):
    """``tool_request`` middleware: pop ``purpose`` before Hermes looks at the
    call, on every platform, so no guard ever sees it."""

    def _middleware(
        tool_name: Any = "", args: Any = None, tool_call_id: Any = "", **_kwargs: Any
    ):
        try:
            if _bare_tool_name(tool_name) != TERMINAL_TOOL_NAME:
                return None
            if not isinstance(args, dict) or PURPOSE_FIELD not in args:
                return None
            stripped = dict(args)
            purpose = stripped.pop(PURPOSE_FIELD, None)
            if isinstance(tool_call_id, str) and tool_call_id:
                store.record_purpose(tool_call_id, purpose)
            return {
                "args": stripped,
                "source": MIDDLEWARE_SOURCE,
                "reason": "strip approval purpose",
            }
        except Exception:  # noqa: BLE001 - fail open: terminal ignores the key
            logger.debug("[ocuclaw] purpose strip middleware failed", exc_info=True)
            return None

    return _middleware


# -- the explainer's model call ----------------------------------------------


def _llm_messages(raw: Any) -> Optional[List[Dict[str, str]]]:
    if not isinstance(raw, list) or not raw or len(raw) > APPROVAL_LLM_MAX_MESSAGES:
        return None
    messages: List[Dict[str, str]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            return None
        role, content = item.get("role"), item.get("content")
        if role not in ("system", "user") or not isinstance(content, str):
            return None
        messages.append({"role": role, "content": content[:APPROVAL_LLM_MAX_CONTENT_CHARS]})
    return messages


def _bounded_number(value: Any, default: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return max(low, min(high, float(value)))


async def approval_llm_complete(
    llm: Any, params: Any, *, task: Optional[str] = None
) -> Dict[str, Any]:
    """Answer the shared explainer's model call with ``ctx.llm``.

    ``params``: ``messages`` (system/user only), optional ``maxTokens``,
    ``temperature`` and ``timeoutMs``. Returns ``{"text": ...}`` or
    ``{"error": ...}``; never raises.

    ``task`` is the plugin's own ``ocuclaw_approval_explain`` auxiliary task
    when the host registered it (#5046), else None. There is no model or
    provider override either way, so nothing crosses the ``ctx.llm`` trust
    gate. The task inherits Hermes' ``approval`` task, so by default the
    smart-approvals model writes the sentence and no new provider sees the
    command. An operator who pins a different explainer model under
    ``auxiliary.ocuclaw_approval_explain`` sends that provider the command,
    its working directory and the short context excerpts.
    """
    if not isinstance(params, Mapping):
        return {"error": "invalid_params"}
    messages = _llm_messages(params.get("messages"))
    if messages is None:
        return {"error": "invalid_params"}
    acomplete = getattr(llm, "acomplete", None) if llm is not None else None
    if not callable(acomplete):
        return {"error": "unavailable"}
    timeout_s = _bounded_number(
        params.get("timeoutMs"),
        APPROVAL_LLM_DEFAULT_TIMEOUT_S * 1000,
        100,
        APPROVAL_LLM_MAX_TIMEOUT_S * 1000,
    ) / 1000
    kwargs: Dict[str, Any] = {"timeout": timeout_s, "purpose": APPROVAL_LLM_PURPOSE}
    if task:
        kwargs["task"] = task
    max_tokens = params.get("maxTokens")
    if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
        kwargs["max_tokens"] = min(max_tokens, APPROVAL_LLM_MAX_TOKENS)
    temperature = params.get("temperature")
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
        kwargs["temperature"] = _bounded_number(temperature, 0.0, 0.0, 2.0)
    try:
        result = await asyncio.wait_for(acomplete(messages, **kwargs), timeout=timeout_s)
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError:
        return {"error": "timeout"}
    except Exception as exc:  # noqa: BLE001 - trust gate, provider, network
        logger.debug("[ocuclaw] approval explanation call failed: %s", exc)
        return {"error": type(exc).__name__}
    text = getattr(result, "text", None)
    return {"text": text if isinstance(text, str) else ""}
