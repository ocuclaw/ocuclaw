"""Keep each ``pre_llm_call`` result under Hermes' hook output cap.

Hermes replaces any ONE hook result longer than ``hooks.output_spill.max_chars``
(10,000 characters by default, in every engine from 0.21.4) with a 500-character
head, a 500-character tail and the path of a file holding the rest
(``tools/hook_output_spill.py``, applied per result in ``agent/turn_context.py``).
OcuClaw's per-turn context is one result, and on 13 Nov 2026 it reached 10,317
characters: the agent then read only the two ends of its glasses guidance
(cross-OS e2e run 43864264846).

Hermes joins the results of every registered ``pre_llm_call`` callback with a
blank line, so the same text can go out as several results, each under the cap.
``split_for_cap`` cuts the text; ``TurnPieces`` hands the pieces to the
callbacks ``adapter.py`` registers.

Stdlib only, and no Hermes import at module load.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

#: Hermes' default ``hooks.output_spill.max_chars``. A result of exactly this
#: length passes (``len(text) <= max_chars``).
DEFAULT_SPILL_CAP = 10_000

#: Hermes joins hook results with this, and the plugin joins its own blocks
#: (the Task run words, the Board words line, the fence, the Bot Screen note)
#: the same way. Cutting between blocks therefore changes nothing the agent reads.
BLOCK_JOIN = "\n\n"

#: The fence the Node runtime builds (``glasses-ui-context-fence.ts``): the tag
#: line, one JSON line, the closing tag line.
FENCE_TAG = "ocuclaw_liveui_context_v1"
_FENCE_OPEN = f"<{FENCE_TAG}>"
_FENCE_CLOSE = f"</{FENCE_TAG}>"

#: Room a fence needs beyond its empty shape before splitting one is worth it.
_FENCE_HEADROOM = 256

#: Where a long text may be cut, best first.
_BREAKS = ("\n\n", "\n", ". ", " ")


def spill_cap() -> Optional[int]:
    """The length above which this Hermes spills one hook result, or None when
    its spill is switched off. Reads the ``hooks.output_spill`` config keys as
    Hermes' ``get_spill_config`` does (``enabled``, default on; ``max_chars``,
    a positive whole number or the default), through Hermes' public config
    reader. Never raises: a config that cannot be read gets the default."""
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
        hooks = config.get("hooks") if isinstance(config, dict) else None
        section = hooks.get("output_spill") if isinstance(hooks, dict) else None
        if not isinstance(section, dict):
            return DEFAULT_SPILL_CAP
        enabled = section.get("enabled", True)
        if enabled is not None and not enabled:
            return None
        try:
            cap = int(section.get("max_chars"))
        except (TypeError, ValueError):
            return DEFAULT_SPILL_CAP
        return cap if cap >= 1 else DEFAULT_SPILL_CAP
    except Exception:  # noqa: BLE001 - a size limit must never break a turn
        return DEFAULT_SPILL_CAP


def split_for_cap(text: Optional[str], cap: Optional[int]) -> List[str]:
    """``text`` as pieces of at most ``cap`` characters, in order.

    Joined with a blank line, the pieces are ``text`` itself whenever every
    block already fits. A LiveUI fence that is too long alone becomes several
    fences of the same shape with its fragments shared out; any other block
    that is too long is cut at a paragraph, line, sentence or word.
    ``cap`` None (spill off) or a text that fits gives the text back whole.
    """
    if not text:
        return []
    if cap is None or len(text) <= cap:
        return [text]
    blocks: List[str] = []
    for block in text.split(BLOCK_JOIN):
        if len(block) <= cap:
            blocks.append(block)
            continue
        fences = _split_fence(block, cap)
        blocks.extend(fences if fences is not None else _split_plain(block, cap))
    pieces: List[str] = []
    for block in blocks:
        if pieces and len(pieces[-1]) + len(BLOCK_JOIN) + len(block) <= cap:
            pieces[-1] = pieces[-1] + BLOCK_JOIN + block
        else:
            pieces.append(block)
    return pieces


def _split_plain(text: str, cap: int) -> List[str]:
    parts: List[str] = []
    rest = text
    while len(rest) > cap:
        cut = _cut_point(rest, cap)
        parts.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        parts.append(rest)
    return parts


def _cut_point(text: str, limit: int) -> int:
    """Where to cut ``text`` at or before ``limit``: the last good break in the
    second half of that span, else the limit itself."""
    floor = limit // 2
    for mark in _BREAKS:
        at = text.rfind(mark, floor, limit)
        if at > 0:
            return at + len(mark)
    return limit


def _fence(envelope: Dict[str, Any], items: List[Tuple[str, str, str]]) -> str:
    """One fence holding ``items``: ``("fragment", kind, text)`` rows and at
    most one ``("task_index", "", text)``. Written as the Node runtime writes
    it (``JSON.stringify``: no spaces, non-ASCII as is)."""
    body = dict(envelope)
    body["fragments"] = [{"kind": kind, "text": text} for slot, kind, text in items if slot == "fragment"]
    index = "".join(text for slot, _kind, text in items if slot == "task_index")
    if index:
        body["task_index"] = index
    return "\n".join((_FENCE_OPEN, json.dumps(body, ensure_ascii=False, separators=(",", ":")), _FENCE_CLOSE))


def _split_fence(block: str, cap: int) -> Optional[List[str]]:
    """``block`` as several fences that each fit, or None when it is not a
    LiveUI fence this module can read (the caller then cuts it as plain text)."""
    lines = block.split("\n")
    if len(lines) != 3 or lines[0] != _FENCE_OPEN or lines[2] != _FENCE_CLOSE:
        return None
    try:
        body = json.loads(lines[1])
    except ValueError:
        return None
    if not isinstance(body, dict) or not isinstance(body.get("fragments"), list):
        return None
    envelope = {key: value for key, value in body.items() if key not in ("fragments", "task_index")}
    items: List[Tuple[str, str, str]] = []
    for fragment in body["fragments"]:
        if not isinstance(fragment, dict) or not isinstance(fragment.get("text"), str):
            return None
        items.append(("fragment", str(fragment.get("kind") or ""), fragment["text"]))
    index = body.get("task_index")
    if isinstance(index, str) and index:
        items.append(("task_index", "", index))
    elif index:
        return None
    # A cap with no room for a fence and some text: leave it to the plain cut.
    if len(_fence(envelope, [])) + _FENCE_HEADROOM > cap:
        return None

    fences: List[str] = []
    held: List[Tuple[str, str, str]] = []

    def flush() -> None:
        if held:
            fences.append(_fence(envelope, held))
            held.clear()

    for item in items:
        slot, kind, text = item
        while text:
            if slot == "task_index" and any(row[0] == "task_index" for row in held):
                flush()
            if len(_fence(envelope, held + [(slot, kind, text)])) <= cap:
                held.append((slot, kind, text))
                break
            if held:
                # Start a new fence before cutting a fragment in two.
                flush()
                continue
            cut = _fitting_cut(envelope, slot, kind, text, cap)
            fences.append(_fence(envelope, [(slot, kind, text[:cut])]))
            text = text[cut:]
    flush()
    return fences


def _fitting_cut(envelope: Dict[str, Any], slot: str, kind: str, text: str, cap: int) -> int:
    """How many characters of ``text`` fit a fence of their own, cut at a good
    break. JSON escaping makes the written text longer than ``text``, so the
    length is found by writing it."""
    low, high = 1, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if len(_fence(envelope, [(slot, kind, text[:middle])])) <= cap:
            low = middle
        else:
            high = middle - 1
    return _cut_point(text, low) if low < len(text) else low


class TurnPieces:
    """Hands one turn's pieces to several ``pre_llm_call`` callbacks.

    Hermes calls a hook's callbacks in the order they were registered and
    spills each result on its own. The first callback builds the turn's text
    and gives ``first`` the whole of it: ``first`` returns the first piece and
    keeps the rest for ``callbacks``, which are registered straight after and
    each return one kept piece. A turn is known by its session and turn ids;
    a call without both gets its text back whole, as before this module.
    """

    def __init__(self, extra_callbacks: int = 3, keep_seconds: float = 120.0, clock: Callable[[], float] = time.monotonic):
        self._keep_seconds = keep_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._kept: Dict[Tuple[str, str], Tuple[float, List[Optional[str]]]] = {}
        self.callbacks: Tuple[Callable[..., Optional[Dict[str, str]]], ...] = tuple(
            self._callback(slot) for slot in range(extra_callbacks)
        )

    def first(self, kwargs: Dict[str, Any], text: Optional[str], cap: Optional[int]) -> Optional[str]:
        """The piece the building callback returns; the rest wait for ``callbacks``."""
        if not text:
            return None
        key = _turn_key(kwargs)
        pieces = split_for_cap(text, cap) if key and self.callbacks else [text]
        rest: List[Optional[str]] = list(pieces[1:])
        if len(rest) > len(self.callbacks):
            # More pieces than callbacks: the last callback carries the tail,
            # and Hermes spills it if it is over the cap. Nothing is dropped.
            last = len(self.callbacks) - 1
            rest[last:] = [BLOCK_JOIN.join(piece for piece in rest[last:] if piece)]
        if key:
            now = self._clock()
            with self._lock:
                for stale in [k for k, (at, _rest) in self._kept.items() if now - at > self._keep_seconds]:
                    del self._kept[stale]
                if rest:
                    self._kept[key] = (now, rest)
                else:
                    self._kept.pop(key, None)
        return pieces[0]

    def _take(self, slot: int, kwargs: Dict[str, Any]) -> Optional[str]:
        key = _turn_key(kwargs)
        if not key:
            return None
        with self._lock:
            kept = self._kept.get(key)
            if kept is None or slot >= len(kept[1]):
                return None
            piece, kept[1][slot] = kept[1][slot], None
            if not any(kept[1]):
                del self._kept[key]
        return piece

    def _callback(self, slot: int) -> Callable[..., Optional[Dict[str, str]]]:
        def more(**kwargs: Any) -> Optional[Dict[str, str]]:
            piece = self._take(slot, kwargs)
            return {"context": piece} if piece else None

        # Hermes names a callback in its logs and tells callbacks apart by identity.
        more.__name__ = more.__qualname__ = f"_on_pre_llm_call_more_{slot + 1}"
        return more


def _turn_key(kwargs: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    session, turn = str(kwargs.get("session_id") or "").strip(), str(kwargs.get("turn_id") or "").strip()
    return (session, turn) if session and turn else None


__all__ = ["BLOCK_JOIN", "DEFAULT_SPILL_CAP", "FENCE_TAG", "TurnPieces", "spill_cap", "split_for_cap"]
