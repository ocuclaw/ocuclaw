"""Star Map sky for one Hermes profile (``gw.starmap.graph``, ``gw.starmap.forget``).

The phone's Star Map draws the skills an agent has learned and the memories it
keeps, plus the links between them. Hermes already assembles that sky for its
own desktop learning panel: ``agent.learning_graph.build_learning_graph()``.
:func:`read_star_map` runs that builder against one profile home, and
:func:`project_star_map` turns its payload into the Star Map NODE shape pinned
in PROTOCOL.md "Gateway read lane". The projection is pure, so it is testable
without Hermes installed.

Reading is read-only. :func:`forget_star` is the one write: it removes one
memory entry or archives one skill through Hermes' own sanctioned paths. Both
never raise: every failure is a ``status`` the Node bridge maps. A raised error
would cross the link as a bare -32000 and lose its code.
"""

from __future__ import annotations

import inspect
import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

MAX_NODES = 400
MAX_LINKS = 800
GROUP_MAX = 40
NAME_MAX = 80
TEXT_MAX = 280
DESCRIPTION_MAX = 200

#: The constellation for skills the agent made in its flat ``skills/`` folder.
LEARNED_GROUP = "Learned"
#: ``memorySource`` -> constellation. MEMORY.md is the agent's notes, USER.md
#: is what it knows about the wearer.
MEMORY_GROUPS = {"memory": "Memory", "profile": "About you"}
DEFAULT_MEMORY_GROUP = "Memory"
#: Categories that name no real topic: a skill saved straight under
#: ``skills/<name>/`` reports its parent folder, ``skills``, as its category.
_FLAT_CATEGORIES = frozenset(("", "skills"))
#: ``created_by`` values that mean someone made the skill here. Anything else
#: (``installed``, null, an unknown marker) was installed, bundled or hand-copied.
_MAKERS = frozenset(("agent", "learn", "user"))
#: Upstream's skill-scan skip set (``agent/learning_graph.py`` ``_SKIP_PARTS``).
_SKIP_PARTS = frozenset((".archive", ".hub", ".locks", "node_modules", ".git"))
#: Frontmatter sits at the top of SKILL.md; never read a whole large file.
_SKILL_MD_READ_CHARS = 16384
#: Epoch seconds past this are not a date (year 5138); refuse rather than guess.
_MAX_EPOCH_SECONDS = 1e11


def empty(status: str, error_code: str = "") -> Dict[str, Any]:
    """An empty sky with ``status`` (and ``errorCode`` when not ok)."""
    reply: Dict[str, Any] = {"status": status, "nodes": [], "links": []}
    if error_code:
        reply["errorCode"] = error_code
    return reply


def _one_line(value: Any) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def group_for_category(category: Any) -> str:
    """A skill category made display-ready: ``dev-ops_tools`` -> ``Dev ops tools``."""
    text = " ".join(_one_line(category).replace("-", " ").replace("_", " ").split())
    if text.lower() in _FLAT_CATEGORIES:
        return LEARNED_GROUP
    return _clip(text[:1].upper() + text[1:], GROUP_MAX)


def _timestamp_ms(value: Any) -> Optional[int]:
    """Epoch ms from epoch seconds or an ISO string; None for anything else."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        seconds = float(value)
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            seconds = float(text)
        except ValueError:
            if text[-1] in "Zz":
                text = text[:-1] + "+00:00"
            try:
                parsed = datetime.fromisoformat(text)
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            seconds = parsed.timestamp()
    else:
        return None
    if not math.isfinite(seconds) or not 0 < seconds < _MAX_EPOCH_SECONDS:
        return None
    return int(round(seconds * 1000))


def _created_at_ms(record: Mapping[str, Any]) -> Optional[int]:
    """When the skill first appeared. The graph's ``timestamp`` is last activity."""
    for key in ("created_at", "first_seen_at"):
        ms = _timestamp_ms(record.get(key))
        if ms is not None:
            return ms
    return None


def _count(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def _activity(raw: Mapping[str, Any]) -> float:
    """The graph's last-activity seconds, for dropping the oldest past the cap."""
    value = raw.get("timestamp")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    seconds = float(value)
    return seconds if math.isfinite(seconds) else 0.0


def _maker(created_by: Any) -> str:
    text = created_by.strip().lower() if isinstance(created_by, str) else ""
    return text if text in _MAKERS else "installed"


def _first_line(text: Any) -> str:
    """A memory chunk's first line, cleaned the way upstream builds its title."""
    if not isinstance(text, str) or not text.strip():
        return ""
    return _one_line(text.strip().splitlines()[0].strip().lstrip("# "))


def _memory_card(node_id: str, cards: List[Any]) -> Mapping[str, Any]:
    """The ``memory`` card behind a node id, or ``{}``.

    Ids are ``memory:<source>:<index>`` (Hermes 0.21.5) or
    ``memory:<source>:<index>:<fingerprint>`` (newer), where ``index`` is the
    card's position in the payload's ``memory`` list.
    """
    parts = node_id.split(":")
    if len(parts) not in (3, 4) or parts[0] != "memory" or not parts[2].isdigit():
        return {}
    index = int(parts[2])
    card = cards[index] if index < len(cards) else None
    if not isinstance(card, Mapping) or card.get("source") != parts[1]:
        return {}
    if len(parts) == 4 and card.get("fingerprint") not in (None, parts[3]):
        return {}
    return card


def _base_node(node_id: str, kind: str, group: str, name: str) -> Dict[str, Any]:
    return {
        "id": node_id, "kind": kind, "group": group, "name": name, "text": "",
        "description": "", "createdAtMs": None, "uses": 0, "by": "",
        "stale": False, "pinned": False, "importance": 0, "source": "",
    }


def _skill_node(
    node_id: str,
    raw: Mapping[str, Any],
    usage: Mapping[str, Any],
    descriptions: Mapping[str, str],
) -> Optional[Dict[str, Any]]:
    state = _one_line(raw.get("state")).lower() or "active"
    if state == "archived":
        return None
    name = _clip(_one_line(raw.get("label")) or node_id, NAME_MAX)
    record = usage.get(node_id)
    if not isinstance(record, Mapping):
        record = {}
    description = descriptions.get(node_id)
    node = _base_node(node_id, "skill", group_for_category(raw.get("category")), name)
    node.update(
        description=_clip(_one_line(description), DESCRIPTION_MAX),
        createdAtMs=_created_at_ms(record),
        uses=_count(raw.get("useCount")),
        by=_maker(raw.get("createdBy")),
        stale=state == "stale",
        pinned=raw.get("pinned") is True,
    )
    return node


def memory_key(text: Any) -> str:
    """A memory entry as the date map keys it: whitespace collapsed, case kept."""
    return _one_line(text.strip()) if isinstance(text, str) else ""


def _memory_node(
    node_id: str,
    raw: Mapping[str, Any],
    cards: List[Any],
    memory_dates: Mapping[str, int],
) -> Optional[Dict[str, Any]]:
    card = _memory_card(node_id, cards)
    source = raw.get("memorySource") or card.get("source")
    group = MEMORY_GROUPS.get(source, DEFAULT_MEMORY_GROUP) if isinstance(source, str) else DEFAULT_MEMORY_GROUP
    title = _one_line(raw.get("label")) or _one_line(card.get("title"))
    # The title is the first line cut at 80; the card body keeps the whole line.
    line = _first_line(card.get("body")) or title
    if not line:
        return None
    node = _base_node(node_id, "memory", group, _clip(title or line, NAME_MAX))
    node["text"] = _clip(line, TEXT_MAX)
    # MEMORY.md and USER.md keep no dates; the session history's memory writes do.
    node["createdAtMs"] = memory_dates.get(memory_key(card.get("body")))
    return node


def _within_cap(entries: List[Tuple[Dict[str, Any], float]]) -> List[Dict[str, Any]]:
    """At most MAX_NODES, dropping the oldest, then least used; order kept."""
    if len(entries) <= MAX_NODES:
        return [node for node, _ in entries]
    ranked = sorted(
        range(len(entries)),
        key=lambda i: (-entries[i][1], -entries[i][0]["uses"], i),
    )
    keep = set(ranked[:MAX_NODES])
    return [node for i, (node, _) in enumerate(entries) if i in keep]


def _links(edges: Any, ids: Iterable[str]) -> List[Dict[str, str]]:
    known = set(ids)
    seen = set()
    links: List[Dict[str, str]] = []
    for edge in edges if isinstance(edges, list) else ():
        if len(links) >= MAX_LINKS:
            break
        if not isinstance(edge, Mapping):
            continue
        a, b = edge.get("source"), edge.get("target")
        if not isinstance(a, str) or not isinstance(b, str) or a == b:
            continue
        if a not in known or b not in known:
            continue
        pair = (a, b) if a < b else (b, a)
        if pair in seen:
            continue
        seen.add(pair)
        links.append({"a": a, "b": b})
    return links


def project_star_map(
    graph: Any,
    usage: Mapping[str, Any],
    descriptions: Mapping[str, str],
    memory_dates: Optional[Mapping[str, int]] = None,
) -> Dict[str, Any]:
    """``build_learning_graph()`` output -> ``{status, nodes, links}``.

    ``usage`` is the profile's ``skills/.usage.json`` map (skill name ->
    record), ``descriptions`` maps skill name -> SKILL.md ``description`` and
    ``memory_dates`` maps a memory entry (:func:`memory_key`) -> epoch ms it
    was first written. Pure: no I/O and no Hermes imports.
    """
    if not isinstance(graph, Mapping):
        return empty("error", "graph_malformed")
    raw_nodes = graph.get("nodes")
    if raw_nodes is None:
        raw_nodes = []
    if not isinstance(raw_nodes, list):
        return empty("error", "graph_malformed")
    cards = graph.get("memory")
    cards = cards if isinstance(cards, list) else []
    usage = usage if isinstance(usage, Mapping) else {}
    descriptions = descriptions if isinstance(descriptions, Mapping) else {}
    memory_dates = memory_dates if isinstance(memory_dates, Mapping) else {}

    entries: List[Tuple[Dict[str, Any], float]] = []
    seen_ids = set()
    for raw in raw_nodes:
        if not isinstance(raw, Mapping):
            continue
        node_id = raw.get("id")
        if not isinstance(node_id, str) or not node_id or node_id in seen_ids:
            continue
        kind = raw.get("kind")
        if kind == "skill":
            node = _skill_node(node_id, raw, usage, descriptions)
        elif kind == "memory":
            node = _memory_node(node_id, raw, cards, memory_dates)
        else:
            node = None
        if node is None:
            continue
        seen_ids.add(node_id)
        entries.append((node, _activity(raw)))

    nodes = _within_cap(entries)
    return {
        "status": "ok",
        "nodes": nodes,
        "links": _links(graph.get("edges"), (node["id"] for node in nodes)),
    }


def _load_usage(home: Path) -> Dict[str, Any]:
    """The profile's skill usage map. Call with the home override set."""
    try:
        from tools.skill_usage import load_usage

        data: Any = load_usage()
    except Exception:  # noqa: BLE001 - absent or failing reader: read the file
        try:
            data = json.loads(
                (home / "skills" / ".usage.json").read_text(encoding="utf-8-sig")
            )
        except (OSError, ValueError):
            data = {}
    if not isinstance(data, Mapping):
        return {}
    return {str(key): value for key, value in data.items() if isinstance(value, Mapping)}


def _skill_descriptions(home: Path, names: Iterable[str]) -> Dict[str, str]:
    """Skill name -> SKILL.md frontmatter ``description``. Best effort.

    Names resolve the way the graph names skills: frontmatter ``name``, else
    the skill's folder name, first match wins.
    """
    wanted = {name for name in names if name}
    found: Dict[str, str] = {}
    if not wanted:
        return found
    try:
        from agent.skill_utils import parse_frontmatter
    except Exception:  # noqa: BLE001
        return found
    skills_dir = home / "skills"
    try:
        try:
            from agent.skill_utils import iter_skill_index_files

            paths: Iterable[Path] = iter_skill_index_files(skills_dir, "SKILL.md")
        except Exception:  # noqa: BLE001
            paths = sorted(skills_dir.rglob("SKILL.md"))
        for skill_md in paths:
            if _SKIP_PARTS.intersection(skill_md.parts):
                continue
            try:
                text = skill_md.read_text(encoding="utf-8-sig")[:_SKILL_MD_READ_CHARS]
                frontmatter = parse_frontmatter(text)[0] or {}
            except Exception:  # noqa: BLE001 - one unreadable skill never sinks the rest
                continue
            if not isinstance(frontmatter, Mapping):
                continue
            name = str(frontmatter.get("name") or skill_md.parent.name).strip()
            if name not in wanted or name in found:
                continue
            raw = frontmatter.get("description")
            found[name] = raw.strip().strip("'\"") if isinstance(raw, str) else ""
            if len(found) == len(wanted):
                break
    except Exception:  # noqa: BLE001 - descriptions are decoration, never a failure
        logger.debug("star map: skill description scan stopped early", exc_info=True)
    return found


def _call_writes(call: Any) -> List[str]:
    """The entry texts one stored ``memory`` tool call wrote (add or replace)."""
    if not isinstance(call, Mapping):
        return []
    function = call.get("function") if isinstance(call.get("function"), Mapping) else call
    if function.get("name") != "memory":
        return []
    args: Any = function.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return []
    if not isinstance(args, Mapping):
        return []
    ops = args.get("operations") if isinstance(args.get("operations"), list) else [args]
    texts = []
    for op in ops:
        if isinstance(op, Mapping) and op.get("action") in ("add", "replace"):
            text = op.get("content") or op.get("new_text")
            if isinstance(text, str) and text.strip():
                texts.append(text)
    return texts


def memory_dates_from_rows(rows: Iterable[Tuple[Any, Any]]) -> Dict[str, int]:
    """``(tool_calls, timestamp)`` rows -> memory entry key -> first-written epoch ms.

    Pure. A row's ``tool_calls`` is the stored JSON list; ``timestamp`` is epoch
    seconds. The earliest write of an entry's exact text wins, so a replaced
    entry is dated by its replacement.
    """
    dates: Dict[str, int] = {}
    for raw_calls, timestamp in rows:
        ms = _timestamp_ms(timestamp)
        if ms is None:
            continue
        try:
            calls = json.loads(raw_calls) if isinstance(raw_calls, str) else raw_calls
        except ValueError:
            continue
        for call in calls if isinstance(calls, list) else ():
            for text in _call_writes(call):
                key = memory_key(text)
                if key and (key not in dates or ms < dates[key]):
                    dates[key] = ms
    return dates


#: The rule above and below a memory block's header in a system prompt.
_BLOCK_RULE = "═" * 46


def prompt_memory_entries(prompt: str) -> set:
    """The memory entries (:func:`memory_key`) in a system prompt's memory blocks.

    Upstream renders each block as rule, header, rule, then the entries joined by
    ``\\n§\\n``; the block ends at the next blank line or rule. An entry holding a
    blank line is cut there, so it does not match and stays to the write record.
    """
    found = set()
    lines = prompt.split("\n")
    i = 0
    while i < len(lines):
        if lines[i] == _BLOCK_RULE and i + 2 < len(lines) and lines[i + 2] == _BLOCK_RULE:
            body: List[str] = []
            i += 3
            while i < len(lines) and lines[i].strip() and lines[i] != _BLOCK_RULE:
                body.append(lines[i])
                i += 1
            for entry in "\n".join(body).split("\n§\n"):
                key = memory_key(entry)
                if key:
                    found.add(key)
            continue
        i += 1
    return found


def memory_dates_from_prompts(rows: Iterable[Tuple[Any, Any]], keys: Iterable[str]) -> Dict[str, int]:
    """``(started_at, system_prompt)`` rows, oldest first -> key -> first-seen epoch ms.

    Pure. Each session's system prompt carries the memory as it stood when the
    session began, so the first prompt holding an entry dates it, even one typed
    straight into MEMORY.md. Stops once every key is found.
    """
    wanted = {key for key in keys if key}
    dates: Dict[str, int] = {}
    for started_at, prompt in rows:
        if not wanted:
            break
        ms = _timestamp_ms(started_at)
        if ms is None or not isinstance(prompt, str):
            continue
        for key in wanted & prompt_memory_entries(prompt):
            dates[key] = ms
            wanted.discard(key)
    return dates


#: The memory writes scanned, oldest first; past this the newest go undated.
_MEMORY_WRITE_ROWS = 20000
#: The distinct session prompts scanned, oldest first.
_PROMPT_ROWS = 2000


def _memory_dates(home: Path, entries: Iterable[Any]) -> Dict[str, int]:
    """When each memory entry first appeared, from the profile's session store.

    MEMORY.md and USER.md hold bare text, but ``state.db`` keeps two dated
    traces: every ``memory`` tool call the agent made, and each session's system
    prompt, which carries the memory as it stood. An entry takes the earlier of
    its first write and the first session that already knew it. Read-only; an
    absent or locked store, or pruned sessions, leave entries undated and never
    fail the sky.
    """
    keys = {memory_key(entry) for entry in entries} - {""}
    db = home / "state.db"
    if not keys or not db.is_file():
        return {}
    try:
        import sqlite3

        conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=1.0)
        try:
            writes = memory_dates_from_rows(conn.execute(
                "SELECT tool_calls, timestamp FROM messages "
                "WHERE role = 'assistant' AND tool_calls LIKE '%memory%' "
                "ORDER BY timestamp LIMIT ?",
                (_MEMORY_WRITE_ROWS,),
            ))
            seen: Dict[str, int] = {}
            try:
                seen = memory_dates_from_prompts(conn.execute(
                    "SELECT MIN(s.started_at), COALESCE(p.prompt, s.system_prompt) "
                    "FROM sessions s LEFT JOIN system_prompts p ON p.hash = s.system_prompt_hash "
                    "GROUP BY COALESCE(s.system_prompt_hash, s.system_prompt) "
                    "ORDER BY MIN(s.started_at) LIMIT ?",
                    (_PROMPT_ROWS,),
                ), keys)
            except sqlite3.Error:  # an older store without the prompt table
                logger.debug("star map: session prompts unavailable", exc_info=True)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - dates are decoration, never a failure
        logger.debug("star map: memory dates unavailable", exc_info=True)
        return {}
    return {
        key: min(found)
        for key in keys
        if (found := [ms for ms in (writes.get(key), seen.get(key)) if ms is not None])
    }


def read_star_map(home: Path) -> Dict[str, Any]:
    """The Star Map sky for the profile living at ``home``. Never raises.

    ``unsupported`` when this Hermes has no learning graph (it arrived after
    some 0.21 builds); ``error`` with a short ``errorCode`` for anything else.
    """
    try:
        from agent.learning_graph import build_learning_graph
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    except (ImportError, AttributeError):
        return empty("unsupported")
    try:
        token = set_hermes_home_override(home)
    except Exception:  # noqa: BLE001
        logger.warning("star map: could not scope the profile home", exc_info=True)
        return empty("error", "graph_failed")
    try:
        try:
            graph = build_learning_graph()
        except Exception:  # noqa: BLE001
            logger.warning("star map: learning graph build failed", exc_info=True)
            return empty("error", "graph_failed")
        raw_nodes = graph.get("nodes") if isinstance(graph, Mapping) else None
        skill_names = [
            raw["id"] for raw in raw_nodes or ()
            if isinstance(raw, Mapping) and raw.get("kind") == "skill" and isinstance(raw.get("id"), str)
        ] if isinstance(raw_nodes, list) else []
        usage = _load_usage(home)
        descriptions = _skill_descriptions(home, skill_names)
    finally:
        reset_hermes_home_override(token)
    cards = graph.get("memory") if isinstance(graph, Mapping) else None
    memory_dates = _memory_dates(
        home, (card.get("body") for card in cards if isinstance(card, Mapping))
        if isinstance(cards, list) else ())
    try:
        return project_star_map(graph, usage, descriptions, memory_dates)
    except Exception:  # noqa: BLE001
        logger.warning("star map: projection failed", exc_info=True)
        return empty("error", "graph_malformed")


# -- forget this star (``gw.starmap.forget``) ---------------------------------

FORGET_ID_MAX = 160
FORGET_MESSAGE_MAX = 200
FORGET_KINDS = frozenset(("skill", "memory"))
#: ``memorySource`` -> (file under ``<home>/memories``, MemoryStore target).
_MEMORY_FILES = {"memory": ("MEMORY.md", "memory"), "profile": ("USER.md", "user")}
#: Upstream's ``_memory_cards`` keeps ``body = chunk[:1200]``.
_MEMORY_BODY_MAX = 1200
#: Words in a refused archive that mean the host owns the skill, not the agent.
_PROTECTED_WORDS = ("built-in", "hub-installed", "protected", "read-only")
_STALE_MESSAGE = "This star changed since the sky was read. Refresh and try again."
_AMBIGUOUS_MESSAGE = "More than one memory matches this star, so nothing was removed."


def _forget_error(code: str, message: Any = "") -> Dict[str, Any]:
    """``{status:"error", errorCode, message?}``; the message is one short line."""
    reply: Dict[str, Any] = {"status": "error", "errorCode": code}
    text = _clip(_one_line(message), FORGET_MESSAGE_MAX)
    if text:
        reply["message"] = text
    return reply


def _accepts_matched_entry(method: Any) -> bool:
    """True when ``MemoryStore.remove`` pins the exact entry (Hermes 0.21.5+)."""
    try:
        return "matched_entry" in inspect.signature(method).parameters
    except (TypeError, ValueError):
        return False


def _forget_memory(
    home: Path, node_id: str, text: str, graph: Any,
    load_on_disk_store: Any, memory_store: Any,
) -> Dict[str, Any]:
    """Remove the one memory entry behind ``node_id``. Call with the home override set."""
    cards = graph.get("memory") if isinstance(graph, Mapping) else None
    card = _memory_card(node_id, cards if isinstance(cards, list) else [])
    body = card.get("body")
    if not isinstance(body, str) or not body:
        return _forget_error("stale", _STALE_MESSAGE)
    # Exactly the text the sky sent for this node (see _memory_node).
    if _clip(_first_line(body), TEXT_MAX) != text:
        return _forget_error("stale", _STALE_MESSAGE)
    file_name, target = _MEMORY_FILES[node_id.split(":")[1]]
    entries = memory_store._read_file(home / "memories" / file_name)
    matches = [
        entry for entry in entries
        if isinstance(entry, str) and entry.strip()[:_MEMORY_BODY_MAX] == body
    ]
    if not matches:
        return _forget_error("stale", _STALE_MESSAGE)
    if len(matches) > 1:
        return _forget_error("ambiguous", _AMBIGUOUS_MESSAGE)
    full = matches[0]
    store = load_on_disk_store()
    try:
        if _accepts_matched_entry(store.remove):
            result = store.remove(target, full, matched_entry=full)
        else:  # Hermes 0.21.1: still locked and re-read under ``_mutate``.
            result = store.remove(target, full)
    except Exception as exc:  # noqa: BLE001 - e.g. the atomic write failed
        logger.warning("star map: memory remove failed", exc_info=True)
        return _forget_error("forget_failed", exc)
    if isinstance(result, Mapping) and result.get("success") is True:
        return {"status": "ok", "action": "removed"}
    error = result.get("error") if isinstance(result, Mapping) else ""
    error = error if isinstance(error, str) else ""
    # The store words its match misses for the model ("check current_entries
    # below"); the wearer gets ours. Anything else (drift, an unreadable file)
    # is the store's own refusal and says what to fix.
    if error.startswith("Multiple entries matched"):
        return _forget_error("ambiguous", _AMBIGUOUS_MESSAGE)
    if not error or error.startswith(("No entry matched", "Entry changed since")):
        return _forget_error("stale", _STALE_MESSAGE)
    return _forget_error("stale", error)


def _forget_skill(node_id: str, graph: Any, delete_node: Any) -> Dict[str, Any]:
    """Archive the learned skill ``node_id``. Call with the home override set."""
    raw_nodes = graph.get("nodes") if isinstance(graph, Mapping) else None
    node = next((
        raw for raw in (raw_nodes if isinstance(raw_nodes, list) else ())
        if isinstance(raw, Mapping) and raw.get("kind") == "skill" and raw.get("id") == node_id
    ), None)
    if node is None or _one_line(node.get("state")).lower() == "archived":
        return _forget_error("stale", _STALE_MESSAGE)
    result = delete_node(node_id)
    if not isinstance(result, Mapping):
        return _forget_error("forget_failed")
    if result.get("ok") is True:
        return {"status": "ok", "action": "archived"}
    message = result.get("message") if isinstance(result.get("message"), str) else ""
    # Match on the host's words, not the skill's name (``pinned-notes`` is a name).
    words = message.replace(node_id, "").lower()
    if "pinned" in words:
        code = "pinned"
    elif any(word in words for word in _PROTECTED_WORDS):
        code = "protected"
    elif "not found" in words:
        code = "not_found"
    else:
        code = "forget_failed"
    return _forget_error(code, message)


def forget_star(home: Path, node_id: Any, kind: Any, text: Any) -> Dict[str, Any]:
    """Forget one star of the profile living at ``home``. Never raises.

    A memory (``memory:<source>:<index>[:<fp>]``) is removed from MEMORY.md or
    USER.md through the memory tool's own locked remove, only when its card
    still shows ``text`` and exactly one entry holds it. A skill (its name) is
    archived through ``agent.learning_mutations.delete_node``; ``hermes
    curator restore <name>`` brings it back. Returns ``{status:"ok", action}``,
    ``{status:"error", errorCode, message?}`` or ``{status:"unsupported"}``.
    """
    if (
        not isinstance(node_id, str) or not node_id or len(node_id) > FORGET_ID_MAX
        or kind not in FORGET_KINDS or not isinstance(text, str)
        or (kind == "memory") != node_id.startswith("memory:")
    ):
        return _forget_error("bad_request")
    if kind == "memory":
        parts = node_id.split(":")
        if len(parts) not in (3, 4) or parts[1] not in _MEMORY_FILES or not parts[2].isdigit():
            return _forget_error("bad_request")
    try:
        from agent.learning_graph import build_learning_graph
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        if kind == "memory":
            from tools.memory_tool import MemoryStore, load_on_disk_store
        else:
            from agent.learning_mutations import delete_node
    except (ImportError, AttributeError):
        return {"status": "unsupported"}
    try:
        token = set_hermes_home_override(home)
    except Exception:  # noqa: BLE001
        logger.warning("star map: could not scope the profile home", exc_info=True)
        return _forget_error("forget_failed")
    try:
        try:
            graph = build_learning_graph()
        except Exception:  # noqa: BLE001
            logger.warning("star map: learning graph build failed", exc_info=True)
            return _forget_error("forget_failed")
        if kind == "memory":
            return _forget_memory(home, node_id, text, graph, load_on_disk_store, MemoryStore)
        return _forget_skill(node_id, graph, delete_node)
    except Exception:  # noqa: BLE001 - never raise across the link
        logger.warning("star map: forget failed", exc_info=True)
        return _forget_error("forget_failed")
    finally:
        reset_hermes_home_override(token)
