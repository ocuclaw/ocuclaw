"""The ``/ocuclaw-setup`` skill that shared-gateway Hermes chats can resolve.

Hermes 0.22.1 and later run TUI, classic CLI and Desktop chats as clients of a
shared gateway. A command those chats type reaches the gateway's ``slash.exec``
(``gateway/session_commands.py`` ``execute_command``), which tries registry
commands, quick commands, plugin commands and then skills
(``_skill_directive``), but never skill bundles. The ``/ocuclaw-setup`` bundle
(``setup_bootstrap.py``) therefore answers ``unsupported_command``, which the
TUI prints as "/ocuclaw-setup is not available on the shared gateway yet"
(checked on 0.23.0 and upstream main, 2026-11-07).

This module installs one small filesystem skill named ``ocuclaw-setup`` in the
profile's skills folder, so ``_skill_directive`` finds ``/ocuclaw-setup``
there. Its only instruction is to load the real setup skill,
``ocuclaw:ocuclaw-assist-hermes``. It is the command on every surface: the
messaging gateway, Hermes's own CLI and the pre-0.22.1 TUI slash worker look
bundles up first but fall back to skills. ``setup_bootstrap.retire_setup_bundle``
removes the bundle earlier builds wrote once this skill is in place, because
Hermes's slash completer lists a bundle and a skill of the same name as two
rows.

Ownership follows the TUI pairing widget: the second line of the file is the
marker. A marked file is OcuClaw's and is kept at the shipped bytes; any other
file at that path is the user's and is never touched. Uninstall removes only a
marked file and the folder it leaves empty. Retire this module (and its
uninstall step) once the Hermes floor routes bundles through ``slash.exec``;
``docs/hermes/FUTURE-HERMES.md`` tracks that re-check.
"""

from __future__ import annotations

import os
from pathlib import Path
import secrets
from typing import Any, Dict, Optional

SKILL_NAME = "ocuclaw-setup"
SETUP_SKILL_QUALIFIED_NAME = "ocuclaw:ocuclaw-assist-hermes"
SETUP_TOOL_NAME = "ocuclaw_setup"
SKILL_MARKER = "# Managed by OcuClaw. It makes /ocuclaw-setup work in Hermes chats on a shared gateway."
SKILL_SOURCE = (
    "---\n"
    f"{SKILL_MARKER}\n"
    f"name: {SKILL_NAME}\n"
    "description: The /ocuclaw-setup command. Loads the OcuClaw Setup Assistant "
    f"({SETUP_SKILL_QUALIFIED_NAME}) for OcuClaw setup, updates and troubleshooting.\n"
    # Never offered in <available_skills>: the model already sees the real
    # setup skill there. Hermes hides a skill whose required tool is missing
    # and a fallback skill whose tool is present, so naming the setup tool
    # both ways hides it in every session that reports its tools, and a
    # left-behind copy never reaches a prompt once the plugin is gone. Slash
    # commands and explicit loads ignore these conditions.
    f"metadata: {{\"hermes\": {{\"requires_tools\": [\"{SETUP_TOOL_NAME}\"], "
    f"\"fallback_for_tools\": [\"{SETUP_TOOL_NAME}\"]}}}}\n"
    "---\n"
    "\n"
    "# /ocuclaw-setup\n"
    "\n"
    "The user typed /ocuclaw-setup: they want to set up, update, diagnose or "
    "troubleshoot OcuClaw on Hermes.\n"
    "\n"
    "Load the OcuClaw Setup Assistant now with "
    f'skill_view("{SETUP_SKILL_QUALIFIED_NAME}") and follow it for this '
    "request. This page has no setup guidance of its own; do not answer from it.\n"
    "\n"
    "If that skill cannot be loaded, the OcuClaw plugin is disabled or not "
    "installed in this Hermes profile. Tell the user exactly that, and that "
    "`hermes plugins enable ocuclaw` followed by `hermes gateway restart` turns "
    "it back on (or `hermes plugins install ocuclaw/ocuclaw --enable` if it was "
    "removed). Then stop; do not guess at setup steps.\n"
)
SKILL_RECONCILE_OK = frozenset({"created", "updated", "unchanged"})


def default_home() -> Optional[Path]:
    """The profile home Hermes reads skills from, as the bundle uses it.

    ``get_hermes_home()`` is the context-local profile home: the same root
    ``bundle_path_for`` writes the bundle under and the one the gateway's
    ``_skill_directive`` scans inside ``_profile_runtime_scope``. None when
    Hermes is absent; never a default-profile guess.
    """
    try:
        from hermes_constants import get_hermes_home

        home = get_hermes_home()
    except Exception:  # noqa: BLE001 - absent/older Hermes fails closed
        return None
    try:
        resolved = Path(home)
    except (TypeError, ValueError):
        return None
    return resolved if str(resolved).strip() else None


def skill_dir(home: Path) -> Path:
    return Path(home) / "skills" / SKILL_NAME


def skill_path(home: Path) -> Path:
    return skill_dir(home) / "SKILL.md"


def _safe_skill_path(home: Path) -> Optional[Path]:
    """The skill path, or None when any part of it is a symlink or escapes."""
    resolved_home = Path(home).expanduser().absolute()
    skills = resolved_home / "skills"
    directory = skills / SKILL_NAME
    target = directory / "SKILL.md"
    try:
        for path in (resolved_home, skills, directory, target):
            if path.is_symlink():
                return None
        for path in (skills, directory, target):
            if path.resolve(strict=False) != path.absolute():
                return None
    except OSError:
        return None
    return target


def skill_owned(path: Path) -> bool:
    """True when the file at ``path`` carries OcuClaw's marker line."""
    try:
        with Path(path).open("r", encoding="utf-8") as stream:
            first = stream.readline().rstrip("\n")
            second = stream.readline().rstrip("\n")
    except (OSError, UnicodeError):
        return False
    return first == "---" and second == SKILL_MARKER


def _write_skill(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n", closefd=True) as stream:
            fd = -1
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def reconcile_setup_command_skill(home: Optional[Path] = None) -> Dict[str, Any]:
    """Install or refresh only the marked OcuClaw ``ocuclaw-setup`` skill. Never raises."""
    resolved_home = Path(home) if home is not None else default_home()
    if resolved_home is None:
        return {"status": "error", "reason": "profile_unresolved"}
    target = _safe_skill_path(resolved_home)
    if target is None:
        return {"status": "error", "reason": "unsafe_skill_path"}
    try:
        exists = target.exists()
    except OSError:
        return {"status": "error", "reason": "skill_unreadable"}
    if exists and not skill_owned(target):
        return {"status": "preserved", "reason": "foreign_skill_present", "path": str(target)}
    try:
        current = target.read_text(encoding="utf-8") if exists else None
        if current == SKILL_SOURCE:
            return {"status": "unchanged", "path": str(target)}
        _write_skill(target, SKILL_SOURCE)
    except (OSError, UnicodeError):
        return {"status": "error", "reason": "skill_write_failed"}
    return {"status": "updated" if current is not None else "created", "path": str(target)}


def remove_owned_skill(home: Path, removed: list, failures: list) -> None:
    """Uninstall: remove the marked skill and the folder it leaves empty."""
    target = skill_path(home)
    if not skill_owned(target):
        return
    try:
        target.unlink()
        removed.append(str(target))
    except FileNotFoundError:
        pass
    except OSError:
        failures.append(str(target))
        return
    try:
        target.parent.rmdir()
    except OSError:
        # Something else lives there (a user file): keep the folder.
        pass
    else:
        removed.append(str(target.parent))


__all__ = [
    "SKILL_MARKER",
    "SKILL_NAME",
    "SKILL_RECONCILE_OK",
    "SKILL_SOURCE",
    "default_home",
    "reconcile_setup_command_skill",
    "remove_owned_skill",
    "skill_dir",
    "skill_owned",
    "skill_path",
]
