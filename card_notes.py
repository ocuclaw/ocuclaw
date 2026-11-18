"""Hermes's glasses card notes (#5849): the one skill where Hermes keeps what it
learned building cards for this user.

Hermes's skills prompt makes the model load any listed skill that looks
relevant, and fix it "before finishing". Inside a card build that cost 6 to
30 s on a pet. So the notes skill carries two gates on the card ask tool, and
Hermes always leaves it out of its skills list: fallback_for_tools hides it
when the card tools are direct, and requires_tools when they sit behind
Hermes's tool search, since the list counts only direct tools (two pet builds
in three loaded it there). A load by exact name (the review after the reply)
still works. The ask's yes
carries the notes instead, capped, so the build reads them with no extra model
call. The yes also names the skill, for the review after the reply: the
per-turn card hint (hermes-liveui-bridge.ts) names none, since a skill named
before the ask was loaded before the ask in three pet builds out of three.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .yaml_compat import yaml

logger = logging.getLogger(__name__)

NOTES_SKILL_NAME = "glasses-card-notes"
NOTES_MAX_CHARS = 1500
ASK_TOOL_NAME = "ask_glasses_card"
NOTES_HEADING = "# Glasses card notes"
NOTES_DESCRIPTION = (
    "Lessons from this user's glasses card builds: short rules within 1,500 characters, "
    "only what the OcuClaw card guide doesn't already say. OcuClaw hands them to every "
    "card build, so edit them after the reply, never during a build."
)
# Hidden when the ask tool is direct, and when it is deferred or off.
GATE_KEYS = ("fallback_for_tools", "requires_tools")
NOTES_SEED = (
    "---\n"
    f"name: {NOTES_SKILL_NAME}\n"
    f"description: \"{NOTES_DESCRIPTION}\"\n"
    "metadata:\n"
    "  hermes:\n"
    + "".join(f"    {key}: [{ASK_TOOL_NAME}]\n" for key in GATE_KEYS)
    + "---\n\n"
    f"{NOTES_HEADING}\n"
)
# skills/<name>/SKILL.md or skills/<category>/<name>/SKILL.md, as Hermes lays them out.
_MAX_DEPTH = 2


def notes_skill_path(home: Path) -> Optional[Path]:
    """The profile's notes skill, wherever Hermes or a seed put it, or None."""
    root = home / "skills"
    if not root.is_dir():
        return None
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        if here.name == NOTES_SKILL_NAME and "SKILL.md" in filenames:
            return here / "SKILL.md"
        depth = len(here.relative_to(root).parts)
        # Hidden dirs hold archives, hub state and backups, never a live skill.
        dirnames[:] = [] if depth >= _MAX_DEPTH else sorted(d for d in dirnames if not d.startswith("."))
    return None


def _split(text: str) -> tuple[Optional[Dict[str, Any]], str]:
    """Frontmatter as a dict (None when absent or unreadable) and the body."""
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end < 0:
        return None, text
    body = text[end + 4:].lstrip("\n")
    try:
        front = yaml.safe_load(text[3:end])
    # A model-written impossible date (`updated: 2026-02-30`) raises ValueError,
    # and frontmatter nested past the recursion limit RecursionError (#7314).
    except (yaml.YAMLError, ValueError, RecursionError):
        return None, body
    return (front if isinstance(front, dict) else None), body


def _gated(hermes: Any, key: str) -> bool:
    gate = hermes.get(key) if isinstance(hermes, dict) else None
    return isinstance(gate, list) and ASK_TOOL_NAME in gate


def _hidden(front: Dict[str, Any]) -> bool:
    metadata = front.get("metadata")
    hermes = metadata.get("hermes") if isinstance(metadata, dict) else None
    return all(_gated(hermes, key) for key in GATE_KEYS)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.ocuclaw-tmp")
    temp.write_text(text, encoding="utf-8")
    os.replace(temp, path)


def ensure_notes_skill(home: Path) -> Path:
    """Seed the notes skill when the profile has none, and keep it out of the list.

    A review that rewrote the whole SKILL.md can drop a gate; it goes back on
    here, the body untouched. Unreadable frontmatter is left alone.
    """
    path = notes_skill_path(home)
    if path is None:
        path = home / "skills" / NOTES_SKILL_NAME / "SKILL.md"
        _write(path, NOTES_SEED)
        logger.info("[ocuclaw] seeded the card notes skill at %s", path)
        return path
    text = path.read_text(encoding="utf-8")
    front, body = _split(text)
    if front is None or _hidden(front):
        return path
    metadata = front.get("metadata") if isinstance(front.get("metadata"), dict) else {}
    hermes = metadata.get("hermes") if isinstance(metadata.get("hermes"), dict) else {}
    gates = {
        key: [*(hermes[key] if isinstance(hermes.get(key), list) else []), ASK_TOOL_NAME]
        for key in GATE_KEYS if not _gated(hermes, key)
    }
    front["metadata"] = {**metadata, "hermes": {**hermes, **gates}}
    dumped = yaml.safe_dump(front, sort_keys=False, allow_unicode=True)
    _write(path, f"---\n{dumped}---\n\n{body}")
    logger.info("[ocuclaw] put the card notes skill back out of the skills list")
    return path


def notes_text(path: Path) -> str:
    """The notes body for the build: no frontmatter or seed heading, capped."""
    _front, body = _split(path.read_text(encoding="utf-8"))
    body = body.strip()
    if body.startswith(NOTES_HEADING):
        body = body[len(NOTES_HEADING):].strip()
    if len(body) <= NOTES_MAX_CHARS:
        return body
    cut = body.rfind("\n", 0, NOTES_MAX_CHARS)
    kept = body[: cut if cut > 0 else NOTES_MAX_CHARS].rstrip()
    return (
        f"{kept}\n[Notes cut at {NOTES_MAX_CHARS} characters. The review after the "
        "reply merges or drops rules so they fit.]"
    )


def with_card_notes(result: Any, home: Optional[Path]) -> Any:
    """The ask's answer, with the notes skill's name and notes on a yes.

    Every ask seeds the hidden skill.
    """
    if home is None or not isinstance(result, dict):
        return result
    try:
        path = ensure_notes_skill(home)
        notes = notes_text(path) if result.get("answer") == "yes" else ""
    # Never lose the wearer's answer to the notes (#7314): a non-UTF-8 byte, or
    # an error from the ruamel backend, leaves the answer as it was.
    except Exception as exc:
        logger.warning("[ocuclaw] card notes unavailable: %s", exc)
        return result
    if result.get("answer") != "yes":
        return result
    return {**result, "card_notes_skill": NOTES_SKILL_NAME, **({"card_notes": notes} if notes else {})}


# The card tools a build calls after the yes. Hermes lists them by name until
# the model describes them, so every build spent two model calls on
# tool_describe, one before the write and one before the first edit (16 s a
# build on pets, 11b eval). The yes hands over what tool_describe would.
BUILD_TOOL_NAMES = ("write_glasses_card", "look_glasses_card", "edit_glasses_card")
BUILD_TOOLS_NOTE = (
    "card_tools holds write_glasses_card, look_glasses_card and edit_glasses_card as "
    "tool_describe gives them, with the card guide: call them straight through tool_call, "
    "no tool_describe needed."
)


def with_card_tools(result: Any, descriptors: Any) -> Any:
    """The ask's answer, with the build tools' descriptions and parameters on a yes.

    ``descriptors`` is the runtime hello's ``phoneTools`` list, the source the
    tools were registered from.
    """
    if not isinstance(result, dict) or result.get("answer") != "yes":
        return result
    tools: Dict[str, Any] = {}
    for descriptor in descriptors if isinstance(descriptors, list) else []:
        if not isinstance(descriptor, dict):
            continue
        name = descriptor.get("name")
        schema = descriptor.get("schema")
        if name not in BUILD_TOOL_NAMES or name in tools or not isinstance(schema, dict):
            continue
        tools[name] = {
            "description": str(descriptor.get("description") or schema.get("description") or ""),
            "parameters": schema.get("parameters") if isinstance(schema.get("parameters"), dict) else {},
        }
    if not tools:
        return result
    return {**result, "card_tools_note": BUILD_TOOLS_NOTE, "card_tools": tools}
