"""Watched-page Tasks check the page's visible text (#5039 traps D, E, F).

A Task with a page to watch used to give Hermes the URL (``monitor_url``).
Hermes then compared the page's raw bytes, so most real pages looked changed
on every check. Now OcuClaw gives Hermes a ``monitor_script`` instead: the
shared ``page_watch_script.py``, copied to ``<HERMES_HOME>/scripts`` as
``SCRIPT_NAME``. Hermes runs it with no arguments in the job's ``workdir``,
so each Task gets its own folder, ``<HERMES_HOME>/ocuclaw/page-watch/<taskId>/``,
holding ``url.txt`` and the script's last outputs.

Two repairs ride on that folder, applied when a failed run is recorded:

* E: a dead page failed with Hermes's model-timeout copy. The script saves
  the real reason, and ``failure_reason`` returns it.
* F: Hermes saves the new page snapshot before the model runs, so a failed
  model run lost the change. ``rewind`` puts the snapshot from before this
  check back, so the next check sees the change again.

The script is rewritten when it differs, like the reminder script
(task_reminders). Deleting the Task removes its folder; uninstall removes the
script and every folder.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping, Optional

from . import page_watch_script as script

logger = logging.getLogger(__name__)

#: The page check OcuClaw installs in ``<HERMES_HOME>/scripts``.
SCRIPT_NAME = "ocuclaw-page-watch.py"
#: Under the OcuClaw runtime folder ``<HERMES_HOME>/ocuclaw``.
PAGES_DIRNAME = "page-watch"
#: A saved check outcome older than this is not the run being recorded.
STATE_FRESH_SECONDS = 15 * 60
#: Hermes's snapshot file and state key (cron/monitor.py, 0.22.5).
_SNAPSHOT_FILENAME = "monitor_last_output.txt"


def script_body() -> str:
    return Path(script.__file__).read_text(encoding="utf-8")


def script_path(home: Path) -> Path:
    return Path(home) / "scripts" / SCRIPT_NAME


def pages_dir(home: Path) -> Path:
    return Path(home) / "ocuclaw" / PAGES_DIRNAME


def page_dir(home: Path, task_id: str) -> Path:
    return pages_dir(home) / task_id


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
    """Install or update the shared page check; a no-op when it already matches."""
    path = script_path(home)
    body = script_body()
    try:
        if path.read_text(encoding="utf-8") == body:
            return path
    except (OSError, ValueError):
        # Missing, unreadable or not UTF-8 (UnicodeDecodeError is a ValueError): rewrite it.
        pass
    _write_atomic(path, body, 0o644)
    return path


def refresh_script(home: Path) -> Optional[Path]:
    """Bring an installed page check up to this plugin's copy; install none.

    Runs at plugin load for every profile (``refresh_all``) and on every
    schedule call, so an upgrade does not leave watched Tasks running an
    older fetch (the public-address check came in with DeepSec
    finding_5c829641ac22e1ce). Never raises.
    """
    try:
        if not script_path(home).is_file():
            return None
        return ensure_script(home)
    except Exception:  # noqa: BLE001 - a refresh must never fail a load or a schedule call
        logger.warning("Could not refresh the page watch script")
        return None


def refresh_all(home: Optional[Path]) -> list:
    """``refresh_script`` for the Hermes root and every profile under it.

    ``home`` may be the root or one profile's home (``<root>/profiles/<name>``).
    Returns the scripts it rewrote or found current. Never raises.
    """
    if home is None:
        return []
    try:
        home = Path(home)
        root = home.parent.parent if home.parent.name == "profiles" else home
        homes = [root]
        profiles = root / "profiles"
        if profiles.is_dir():
            homes.extend(entry for entry in sorted(profiles.iterdir()) if entry.is_dir())
    except Exception:  # noqa: BLE001
        logger.warning("Could not list profiles to refresh the page watch script")
        return []
    refreshed = []
    for each in homes:
        path = refresh_script(each)
        if path is not None:
            refreshed.append(path)
    return refreshed


def saved_url(home: Path, task_id: str) -> Optional[str]:
    try:
        url = (page_dir(home, task_id) / script.URL_FILENAME).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return url or None


def write_page(home: Path, task_id: str, url: str) -> Path:
    """Save one Task's page to watch and return its folder. A new page starts
    a fresh history, so the first check is a baseline, not a change."""
    ensure_script(home)
    folder = page_dir(home, task_id)
    if saved_url(home, task_id) != url.strip():
        for name in (script.CURRENT_FILENAME, script.PRIOR_FILENAME, script.STATE_FILENAME):
            try:
                (folder / name).unlink()
            except OSError:
                pass
    _write_atomic(folder / script.URL_FILENAME, url.strip() + "\n", 0o644)
    return folder


def remove_page(home: Path, task_id: str) -> None:
    """Remove one Task's folder; a folder already gone is fine."""
    folder = page_dir(home, task_id)
    if folder.is_symlink():
        folder.unlink()
    elif folder.exists():
        shutil.rmtree(folder)


def watches(job: Mapping[str, Any]) -> Optional[Path]:
    """The Task folder of an OcuClaw page check job, or None for any other job."""
    if not isinstance(job, Mapping) or (job.get("monitor_script") or "").strip() != SCRIPT_NAME:
        return None
    workdir = (job.get("workdir") or "").strip()
    if not workdir:
        return None
    folder = Path(workdir)
    return folder if folder.parent.name == PAGES_DIRNAME else None


def job_url(job: Mapping[str, Any]) -> Optional[str]:
    """The page a job watches: its folder's for OcuClaw's check, else Hermes's own."""
    folder = watches(job)
    if folder is not None:
        try:
            return (folder / script.URL_FILENAME).read_text(encoding="utf-8").strip() or None
        except OSError:
            return None
    url = job.get("monitor_url") if isinstance(job, Mapping) else None
    return url.strip() if isinstance(url, str) and url.strip() else None


def _state(folder: Path, now: float) -> Optional[dict]:
    try:
        state = json.loads((folder / script.STATE_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(state, dict) or not isinstance(state.get("at"), (int, float)):
        return None
    return state if 0 <= now - state["at"] <= STATE_FRESH_SECONDS else None


def failure_reason(job: Mapping[str, Any], *, now: Optional[float] = None) -> Optional[str]:
    """Why this run failed, when the page check itself failed just now."""
    folder = watches(job)
    if folder is None:
        return None
    state = _state(folder, time.time() if now is None else now)
    if state is None or state.get("ok") is not False:
        return None
    reason = state.get("error")
    reason = reason.strip() if isinstance(reason, str) else ""
    return f"Couldn't open the watched page: {reason or 'it could not be loaded'}"


def _hermes_hash(text: str) -> str:
    """The hash Hermes stores for this output: its script runner redacts stdout first."""
    try:
        from agent.redact import redact_sensitive_text
        text = redact_sensitive_text(text)
    except Exception:
        pass
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def rewind(jobs: Any, job: Mapping[str, Any], *, now: Optional[float] = None) -> bool:
    """After a failed model run on a changed page, put Hermes's snapshot back
    to the page as it was before this check, so the next check sees the change
    again. True when it rewound. Only when the check itself worked and Hermes's
    stored hash is this check's text, so a stale or foreign state is left alone."""
    folder = watches(job)
    if folder is None:
        return False
    state = _state(folder, time.time() if now is None else now)
    if state is None or state.get("ok") is not True:
        return False
    try:
        current = (folder / script.CURRENT_FILENAME).read_text(encoding="utf-8")
    except OSError:
        return False
    monitor = job.get("monitor_state") if isinstance(job.get("monitor_state"), Mapping) else {}
    if monitor.get("last_output_hash") != _hermes_hash(current):
        return False
    job_id = str(job.get("id") or "")
    try:
        prior = (folder / script.PRIOR_FILENAME).read_text(encoding="utf-8")
    except OSError:
        prior = None
    try:
        if prior is None:
            # The first check failed: the next one is a baseline again.
            jobs.update_job(job_id, {"monitor_state": None})
        else:
            snapshot = Path(jobs._job_output_dir(job_id)) / _SNAPSHOT_FILENAME
            _write_atomic(snapshot, prior, 0o644)
            jobs.update_job(job_id, {"monitor_state": {**monitor, "last_output_hash": _hermes_hash(prior)}})
    except Exception as exc:
        logger.warning("[ocuclaw] page watch for job %s not rewound (%s)", job_id, type(exc).__name__)
        return False
    return True


def on_failed_run(job_id: Any) -> Optional[str]:
    """A failed run of *job_id* was delivered: rewind a lost page change, and
    return the real reason when the page check failed. Never raises."""
    try:
        from cron import jobs
        job = jobs.get_job(str(job_id))
        if job is None or watches(job) is None:
            return None
        reason = failure_reason(job)
        if reason is None and rewind(jobs, job):
            logger.info("[ocuclaw] page watch for job %s rewound after a failed run", job_id)
        return reason
    except Exception as exc:
        logger.warning("[ocuclaw] page watch failure check for job %s skipped (%s)", job_id, type(exc).__name__)
        return None
