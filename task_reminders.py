"""Fixed-text reminders that run with no model call (#5036).

A reminder Task ("Pay rent" at 09:00 on the 1st) needs no model: its job is a
Hermes ``no_agent`` job whose script prints the reminder text, and Hermes
delivers that output as is. A live 0.22.1 gateway delivered one this way with
no model request (spike on #5036).

Hermes runs a job script only from ``<HERMES_HOME>/scripts/``, with no
arguments and no job id, in the job's ``workdir``, which must be an existing
absolute folder. So OcuClaw installs one shared script, ``SCRIPT_NAME``, that
prints ``reminder.txt`` from its working folder, and each reminder Task gets
its own folder, ``<HERMES_HOME>/ocuclaw/reminders/<taskId>/``.

* The script is written when a reminder is made or changed, and rewritten when
  its text differs, so a plugin update reaches it on the next reminder change.
* Deleting the Task removes its folder. Uninstall removes the script and every
  reminder folder (``uninstall.py``).
* Cron is per profile, so every path here hangs off the profile's own home.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping, Optional

#: The one OcuClaw script in ``<HERMES_HOME>/scripts``.
SCRIPT_NAME = "ocuclaw-reminder.sh"
#: Under the OcuClaw runtime folder ``<HERMES_HOME>/ocuclaw``.
REMINDERS_DIRNAME = "reminders"
TEXT_FILENAME = "reminder.txt"
#: The OcuClaw starter whose ``text`` slot is the reminder (starters.py, #5027).
STARTER_KEY = "ocuclaw:glance-reminder"
REMINDER_KIND = "reminder"

SCRIPT_BODY = (
    "#!/usr/bin/env bash\n"
    "# OcuClaw (#5036): prints this reminder's text. Hermes runs it in the\n"
    "# reminder's own folder and delivers the output with no model call.\n"
    "set -eu\n"
    f"cat {TEXT_FILENAME}\n"
)


def script_path(home: Path) -> Path:
    return Path(home) / "scripts" / SCRIPT_NAME


def reminders_dir(home: Path) -> Path:
    return Path(home) / "ocuclaw" / REMINDERS_DIRNAME


def reminder_dir(home: Path, task_id: str) -> Path:
    return reminders_dir(home) / task_id


def reminder_text(p: Mapping[str, Any]) -> Optional[str]:
    """The fixed text of a reminder Task, or None when the Task needs the model.

    A reminder made from the OcuClaw starter carries its text in the ``text``
    slot. A reminder with no starter is its own request. Any other Starter
    (a Hermes one) keeps its model prompt.
    """
    if p.get("kind") != REMINDER_KIND:
        return None
    starter = p.get("starter")
    if starter is None:
        text = p.get("request")
    elif starter.get("key") == STARTER_KEY:
        text = (starter.get("slots") or {}).get("text")
    else:
        return None
    if not isinstance(text, str) or not text.strip():
        return None
    return text.strip()


def _write_atomic(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ensure_script(home: Path) -> Path:
    """Install or update the shared script; a no-op when it already matches."""
    path = script_path(home)
    try:
        if path.read_text(encoding="utf-8") == SCRIPT_BODY:
            return path
    except OSError:
        pass
    _write_atomic(path, SCRIPT_BODY, 0o755)
    return path


def write_reminder(home: Path, task_id: str, text: str) -> Path:
    """Save one reminder's text in its own folder and return the folder."""
    ensure_script(home)
    folder = reminder_dir(home, task_id)
    _write_atomic(folder / TEXT_FILENAME, text.strip() + "\n", 0o644)
    return folder


def remove_reminder(home: Path, task_id: str) -> None:
    """Remove one reminder's folder; a folder already gone is fine."""
    folder = reminder_dir(home, task_id)
    if folder.is_symlink():
        folder.unlink()
    elif folder.exists():
        shutil.rmtree(folder)
