"""Fail-soft registration-time bootstrap for the native Hermes setup bundle."""

from __future__ import annotations

import ast
from contextlib import contextmanager
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Dict, Iterator, Tuple
import uuid

from .yaml_compat import yaml


logger = logging.getLogger(__name__)

SETUP_BUNDLE_NAME = "ocuclaw-setup"
SETUP_BUNDLE_SKILL = "ocuclaw:ocuclaw-assist-hermes"

# Keep these ordinary Hermes fields only. Ownership is the semantic tuple,
# never a plugin-private marker that Hermes would discard on its next save.
DESIRED_BUNDLE: Dict[str, Any] = {
    "name": SETUP_BUNDLE_NAME,
    "skills": [SETUP_BUNDLE_SKILL],
    "description": "Set up, update, diagnose, or troubleshoot OcuClaw on Hermes.",
    "instruction": "Follow the OcuClaw Setup Assistant guidance for this request.",
}

_THREAD_LOCK = threading.RLock()
_LOCK_WAIT_SECONDS = 5.0
_BUNDLE_INVALID_CHARS = re.compile(r"[^a-z0-9-]")
_BUNDLE_MULTI_HYPHEN = re.compile(r"-{2,}")


class _RegistrationLockBusy(Exception):
    pass


def _open_registration_lock(lock_path: Path) -> int:
    flags = os.O_CREAT | os.O_RDWR
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(lock_path, flags, 0o600)
    try:
        if os.name == "nt":
            import msvcrt

            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise _RegistrationLockBusy from exc
        else:
            import fcntl

            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise _RegistrationLockBusy from exc
        return fd
    except BaseException:
        os.close(fd)
        raise


def _semantic_tuple(bundle: Dict[str, Any]) -> Tuple[str, Tuple[str, ...], str, str]:
    return (
        str(bundle.get("name") or "").strip(),
        tuple(str(item).strip() for item in (bundle.get("skills") or [])),
        str(bundle.get("description") or "").strip(),
        str(bundle.get("instruction") or "").strip(),
    )


_DESIRED_TUPLE = _semantic_tuple(DESIRED_BUNDLE)


@contextmanager
def _registration_lock(canonical: Path) -> Iterator[None]:
    """Serialize threads and processes with an OS-lifetime file lock."""
    lock_path = canonical.parent / f".{SETUP_BUNDLE_NAME}.lock"
    deadline = time.monotonic() + _LOCK_WAIT_SECONDS
    with _THREAD_LOCK:
        canonical.parent.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                fd = _open_registration_lock(lock_path)
                break
            except _RegistrationLockBusy:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timed out waiting for bundle lock {lock_path}")
                time.sleep(0.01)
        try:
            yield
        finally:
            os.close(fd)


def _bundle_slug(name: str) -> str:
    slug = str(name or "").lower().replace(" ", "-").replace("_", "-")
    slug = _BUNDLE_INVALID_CHARS.sub("", slug)
    return _BUNDLE_MULTI_HYPHEN.sub("-", slug).strip("-")


def _read_bundle_mapping(path: Path) -> Tuple[Dict[str, Any] | None, str | None]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError:
        return None, "unreadable"
    except (UnicodeDecodeError, yaml.YAMLError):
        return None, "malformed"
    if not isinstance(data, dict):
        return None, "malformed"
    return data, None


def _setup_bundle_files(bundle_dir: Path) -> list[Path]:
    """Report every readable sibling that claims the setup slug.

    The effective winner comes only from Hermes's public scanner. This small
    path-level pass exists solely to surface losing siblings that the public
    mapping necessarily omits.
    """
    claimed: list[Path] = []
    files = sorted(bundle_dir.glob("*.yaml")) + sorted(bundle_dir.glob("*.yml"))
    for path in files:
        data, problem = _read_bundle_mapping(path)
        if problem is not None or data is None:
            continue
        name = str(data.get("name") or path.stem).strip()
        if _bundle_slug(name) == SETUP_BUNDLE_NAME:
            claimed.append(path)
    return claimed


def _save_desired(bundle_api: Any, *, overwrite: bool) -> Path:
    return Path(
        bundle_api.save_bundle(
            DESIRED_BUNDLE["name"],
            list(DESIRED_BUNDLE["skills"]),
            description=DESIRED_BUNDLE["description"],
            instruction=DESIRED_BUNDLE["instruction"],
            overwrite=overwrite,
        )
    )


def _backup_malformed(canonical: Path) -> Path:
    backup = canonical.with_name(
        f".{canonical.name}.malformed-{os.getpid()}-{uuid.uuid4().hex}.bak"
    )
    canonical.replace(backup)
    return backup


def _reconcile_setup_bundle() -> Dict[str, Any]:
    from agent import skill_bundles as bundle_api

    required = (
        "bundle_path_for",
        "get_skill_bundles",
        "save_bundle",
    )
    missing = [name for name in required if not callable(getattr(bundle_api, name, None))]
    if missing:
        raise RuntimeError(
            "Hermes bundle helper(s) unavailable: " + ", ".join(sorted(missing))
        )

    canonical = Path(bundle_api.bundle_path_for(SETUP_BUNDLE_NAME))
    with _registration_lock(canonical):
        bundles = bundle_api.get_skill_bundles()
        winner = bundles.get(f"/{SETUP_BUNDLE_NAME}")
        claimed = _setup_bundle_files(canonical.parent)
        if len(claimed) > 1:
            winner_path = str((winner or {}).get("path") or "")
            return {
                "status": "preserved",
                "reason": "sibling-collision",
                "winner": winner_path,
                "collisions": [str(path) for path in claimed],
            }

        if isinstance(winner, dict):
            winner_tuple = _semantic_tuple(winner)
            winner_path = str(winner.get("path") or "")
            if winner_tuple == _DESIRED_TUPLE:
                return {
                    "status": "unchanged",
                    "path": winner_path,
                    "winner": winner_path,
                    "collisions": [],
                }
            # Any other winner — a user edit or a bundle this build did not
            # author — is preserved. There is no historical-tuple refresh
            # lane: no install predates this bundle's desired tuple.
            return {
                "status": "preserved",
                "reason": "foreign-winner",
                "winner": winner_path,
                "collisions": [str(path) for path in claimed],
            }

        if claimed and canonical not in claimed:
            return {
                "status": "preserved",
                "reason": "sibling-collision",
                "winner": str(claimed[0]),
                "collisions": [str(path) for path in claimed],
            }

        if canonical.exists():
            canonical_data, problem = _read_bundle_mapping(canonical)
            if problem == "unreadable":
                return {
                    "status": "preserved",
                    "reason": "canonical-unreadable",
                    "winner": str(canonical),
                    "collisions": [],
                }
            if problem is None and canonical_data is not None:
                canonical_name = str(
                    canonical_data.get("name") or canonical.stem
                ).strip()
                if _bundle_slug(canonical_name) != SETUP_BUNDLE_NAME:
                    return {
                        "status": "preserved",
                        "reason": "canonical-foreign",
                        "winner": str(canonical),
                        "collisions": [],
                    }
                return {
                    "status": "preserved",
                    "reason": "canonical-invalid",
                    "winner": str(canonical),
                    "collisions": [str(canonical)],
                }
            backup = _backup_malformed(canonical)
            try:
                path = _save_desired(bundle_api, overwrite=True)
            except Exception as exc:
                # The byte-for-byte backup remains available and a later load
                # may retry; include its otherwise-hidden path in fail-soft logs.
                raise RuntimeError(
                    f"failed to repair malformed bundle; backup={backup}: {exc}"
                ) from exc
            return {
                "status": "repaired",
                "path": str(path),
                "winner": str(path),
                "backup": str(backup),
                "collisions": [],
            }

        path = _save_desired(bundle_api, overwrite=False)
        return {
            "status": "created",
            "path": str(path),
            "winner": str(path),
            "collisions": [],
        }


def reconcile_setup_bundle() -> Dict[str, Any]:
    """Ensure the native setup alias exists without taking ownership from users."""
    try:
        report = _reconcile_setup_bundle()
    except Exception as exc:  # noqa: BLE001 - plugin registration is fail-soft
        report = {"status": "error", "error": str(exc)}
        logger.warning(
            "[ocuclaw] /%s bundle reconciliation failed: %s",
            SETUP_BUNDLE_NAME,
            exc,
        )
        return report

    if report["status"] == "preserved":
        logger.warning(
            "[ocuclaw] /%s bundle preserved (%s); winner=%s collisions=%s",
            SETUP_BUNDLE_NAME,
            report.get("reason"),
            report.get("winner"),
            report.get("collisions"),
        )
    elif report["status"] == "repaired":
        logger.warning(
            "[ocuclaw] /%s malformed bundle backed up and repaired; backup=%s",
            SETUP_BUNDLE_NAME,
            report.get("backup"),
        )
    else:
        logger.info(
            "[ocuclaw] /%s bundle reconciliation: %s",
            SETUP_BUNDLE_NAME,
            report["status"],
        )
    return report


def _retire_setup_bundle() -> Dict[str, Any]:
    from agent import skill_bundles as bundle_api

    path_for = getattr(bundle_api, "bundle_path_for", None)
    if not callable(path_for):
        raise RuntimeError("Hermes bundle helper unavailable: bundle_path_for")
    canonical = Path(path_for(SETUP_BUNDLE_NAME))
    if not canonical.exists():
        # Never create the bundles folder just to find it empty.
        return {"status": "absent", "path": str(canonical)}
    with _registration_lock(canonical):
        if not canonical.exists():
            return {"status": "absent", "path": str(canonical)}
        data, problem = _read_bundle_mapping(canonical)
        if problem is not None or data is None or _semantic_tuple(data) != _DESIRED_TUPLE:
            # A user's own /ocuclaw-setup bundle, or one OcuClaw never wrote:
            # theirs to keep. Where Hermes expands bundles it wins over the
            # setup skill, as they chose by naming it.
            return {
                "status": "preserved",
                "reason": "foreign-bundle" if problem is None else f"bundle-{problem}",
                "path": str(canonical),
            }
        canonical.unlink()
    try:
        canonical.with_name(f".{SETUP_BUNDLE_NAME}.lock").unlink()
    except OSError:
        pass
    return {"status": "retired", "path": str(canonical)}


def retire_setup_bundle() -> Dict[str, Any]:
    """Remove the ``/ocuclaw-setup`` bundle earlier OcuClaw builds wrote.

    The ``ocuclaw-setup`` skill (``setup_command_skill.py``) now answers
    ``/ocuclaw-setup`` on every surface. A bundle of the same name next to it
    would list the command twice in Hermes's slash menus (its completer emits
    bundles and skills separately), so OcuClaw's own bundle goes. Only the
    file whose fields still match the one OcuClaw wrote is removed. Fail-soft.
    """
    try:
        report = _retire_setup_bundle()
    except Exception as exc:  # noqa: BLE001 - plugin registration is fail-soft
        logger.warning("[ocuclaw] /%s bundle retirement failed: %s", SETUP_BUNDLE_NAME, exc)
        return {"status": "error", "error": str(exc)}
    if report["status"] == "preserved":
        logger.warning(
            "[ocuclaw] /%s bundle kept (%s): %s",
            SETUP_BUNDLE_NAME,
            report.get("reason"),
            report.get("path"),
        )
    else:
        logger.info("[ocuclaw] /%s bundle retirement: %s", SETUP_BUNDLE_NAME, report["status"])
    return report


# The chat the Desktop card starts setup in. For a Desktop chat, Hermes's own
# slash worker passed this platform to the bundle expansion
# (`_resolve_session_platform()`), so `skills.platform_disabled.desktop`
# applies here as it did there.
DESKTOP_SETUP_PLATFORM = "desktop"


def build_setup_invocation(platform: str = DESKTOP_SETUP_PLATFORM) -> Dict[str, Any]:
    """Expand ``/ocuclaw-setup`` with Hermes's own bundle expansion. Read-only.

    Hermes Desktop resolves a skill command with ``slash.exec``, then
    ``command.dispatch``. Through 0.22.0 both reached the TUI slash worker,
    whose ``_dispatch_bundle`` expanded a skill bundle. Hermes 0.22.1 sends
    both through ``gateway/session_commands.py``, which looks only in
    ``get_skill_commands()`` (filesystem skills), so this bundle answers
    ``unsupported_command`` there. The Desktop card asks for this only after
    both of those failed.

    The message is Hermes's own: the bundle that wins ``/ocuclaw-setup`` in
    the active profile, expanded by ``build_bundle_invocation_message`` with
    the arguments that worker passed (no user instruction, the Desktop
    platform). The session's task id is not known here; it only fills a
    ``${HERMES_SESSION_ID}`` template, which the setup skill does not use.
    Nothing here writes a bundle or reads a secret. Every failure is a reason,
    never a message built by hand.
    """
    try:
        from agent.skill_bundles import (
            build_bundle_invocation_message,
            resolve_bundle_command_key,
        )
    except ImportError:
        return {"ok": False, "reason": "bundle_api_unavailable"}
    try:
        key = resolve_bundle_command_key(SETUP_BUNDLE_NAME)
        if not key:
            return {"ok": False, "reason": "bundle_missing"}
        built = build_bundle_invocation_message(key, "", task_id=None, platform=platform)
    except Exception as exc:  # noqa: BLE001 - one reason, never a traceback
        logger.warning("[ocuclaw] /%s expansion failed: %s", SETUP_BUNDLE_NAME, exc)
        return {"ok": False, "reason": "bundle_expansion_failed"}
    message = built[0] if isinstance(built, tuple) and built else None
    if not isinstance(message, str) or not message.strip():
        # Hermes returns nothing when no member skill loads (missing,
        # disabled for this platform, or a safe worker).
        return {"ok": False, "reason": "bundle_unloadable"}
    return {"ok": True, "type": "send", "message": message}


def _load_hermes_config() -> Dict[str, Any]:
    from hermes_cli.config import load_config

    config = load_config()
    return config if isinstance(config, dict) else {}


def setup_skill_switches(platform: str = DESKTOP_SETUP_PLATFORM) -> Dict[str, bool]:
    """Is the setup skill switched off for the Desktop setup chat? Read-only.

    Hermes refuses a plugin skill named in the global ``skills.disabled`` or
    in ``skills.platform_disabled.<platform>``. Desktop's capabilities bridge
    cannot see either for this skill: ``GET /api/skills`` lists filesystem
    skills only, never plugin skills. Its ``skills.setEnabled`` does clear the
    global entry; nothing in Desktop clears a per-platform one.
    """
    skills = _load_hermes_config().get("skills")
    skills = skills if isinstance(skills, dict) else {}
    per_platform = skills.get("platform_disabled")
    per_platform = per_platform if isinstance(per_platform, dict) else {}

    # Read lists the way Hermes does (agent.skill_utils.parse_config_string_list):
    # ``hermes config set`` can store a list as a "[...]" string, and a plain
    # string is one name.
    def listed(value: Any) -> bool:
        if isinstance(value, str) and value.strip().startswith("["):
            try:
                value = ast.literal_eval(value.strip())
            except (ValueError, SyntaxError):
                pass
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, (list, tuple)):
            return False
        return SETUP_BUNDLE_SKILL in {str(item).strip() for item in value}

    return {
        "skillDisabled": listed(skills.get("disabled")),
        "skillDisabledForPlatform": listed(per_platform.get(platform)),
    }
