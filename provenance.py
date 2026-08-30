"""Cached, advisory Hermes source provenance (#1323 / P25).

The receipt has exactly three public states:

``certified-source``
    The installed package version and a complete, clean Git checkout match the
    certified Hermes release.
``drifted``
    An inspectable checkout differs by package version, commit, or worktree.
``unknown``
    Provenance cannot be established cheaply and safely. Shallow, partial,
    incomplete, non-Git, timed-out, and malformed sources all land here.

This receipt is support evidence only. It never participates in setup,
admission, or doctor exit-code decisions. Inspection is bounded and cached in
memory per profile. A small source-specific metadata marker invalidates the
cache when the checkout identity changes; the five-minute TTL bounds staleness
for source edits that do not update those identity inputs.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import subprocess
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Callable, Dict, Mapping, Optional, Sequence

STATE_CERTIFIED_SOURCE = "certified-source"
STATE_DRIFTED = "drifted"
STATE_UNKNOWN = "unknown"
STATES = (STATE_CERTIFIED_SOURCE, STATE_DRIFTED, STATE_UNKNOWN)

PROVENANCE_SCHEMA_VERSION = 1
PROVENANCE_CACHE_TTL_S = 300.0
GIT_TIMEOUT_S = 2.0
MEMORY_CACHE_MAX_PROFILES = 32

_FULL_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_PACKAGE_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.!+_-]{0,127}$")
_GIT_ENV_REMOVE = frozenset(
    {
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_DIR",
        "GIT_INDEX_FILE",
        "GIT_NAMESPACE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_PREFIX",
        "GIT_WORK_TREE",
    }
)
_CACHE_KEYS = frozenset(
    {
        "schemaVersion",
        "state",
        "reason",
        "certifiedCommitShort",
        "observedCommitShort",
        "shallow",
        "cachedAt",
        "sourceMarker",
    }
)

GitRunner = Callable[[Sequence[str], Path], Optional[str]]
_MEMORY_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_MEMORY_CACHE_LOCK = RLock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(instant: datetime) -> str:
    if instant.tzinfo is None or instant.tzinfo.utcoffset(instant) is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(timezone.utc).isoformat()


def _parse_instant(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    text = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.tzinfo.utcoffset(parsed) is None:
        return None
    return parsed.astimezone(timezone.utc)


def _git(args: Sequence[str], root: Path) -> Optional[str]:
    """Run one read-only Git query with a hard time bound."""
    try:
        git_env = dict(os.environ)
        for name in tuple(git_env):
            if (
                name in _GIT_ENV_REMOVE
                or name.startswith("GIT_CONFIG_KEY_")
                or name.startswith("GIT_CONFIG_VALUE_")
            ):
                git_env.pop(name, None)
        git_env["GIT_NO_LAZY_FETCH"] = "1"
        git_env["GIT_NO_REPLACE_OBJECTS"] = "1"
        git_env["GIT_OPTIONAL_LOCKS"] = "0"
        git_env["GIT_CONFIG_NOSYSTEM"] = "1"
        git_env["GIT_CONFIG_GLOBAL"] = os.devnull
        completed = subprocess.run(
            ["git", "-c", "core.fsmonitor=false", *args],
            cwd=str(root),
            env=git_env,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=GIT_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip() if completed.returncode == 0 else None


def locate_hermes_source_root() -> Optional[Path]:
    """Find the Git checkout whose tracked source supplies ``hermes_cli``."""
    try:
        spec = importlib.util.find_spec("hermes_cli")
        origin = Path(spec.origin).resolve() if spec and spec.origin else None
    except (ImportError, OSError, TypeError, ValueError):
        return None
    if origin is None:
        return None
    for candidate in (origin.parent, *origin.parents):
        try:
            if not (candidate / ".git").exists():
                continue
            relative_origin = origin.relative_to(candidate).as_posix()
        except (OSError, ValueError):
            return None
        tracked = _git(
            ["ls-files", "--error-unmatch", "--", relative_origin], candidate
        )
        return candidate if tracked is not None else None
    return None


def _git_dir(root: Path) -> Optional[Path]:
    marker = root / ".git"
    try:
        if marker.is_dir():
            return marker
        if not marker.is_file():
            return None
        line = marker.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not line.startswith("gitdir:"):
        return None
    try:
        target = Path(line.split(":", 1)[1].strip())
        return target if target.is_absolute() else (root / target).resolve()
    except (OSError, ValueError):
        return None


def _common_git_dir(git_dir: Path) -> Path:
    marker = git_dir / "commondir"
    try:
        text = marker.read_text(encoding="utf-8", errors="replace").strip()
        candidate = Path(text)
        return candidate if candidate.is_absolute() else (git_dir / candidate).resolve()
    except (OSError, ValueError):
        return git_dir


def _control_file_fact(path: Path) -> str:
    """Return secret-free metadata and small identity-file contents."""
    try:
        stat = path.stat()
    except OSError:
        return "missing"
    body = ""
    try:
        if path.is_file() and stat.st_size <= 4096:
            body = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        body = "unreadable"
    body_hash = hashlib.sha256(body.encode("utf-8", "replace")).hexdigest()
    return f"{stat.st_mtime_ns}:{stat.st_size}:{body_hash}"


def source_freshness_marker(root: Optional[Path], identity: str) -> str:
    """Hash a fixed, cheap set of source identity inputs without invoking Git.

    HEAD/ref contents cover the resolved commit for ordinary loose-ref
    checkouts. Packed refs and the index/config/shallow metadata cover the
    remaining identity inputs. An edit that changes only source bytes can reuse
    a young advisory receipt, but never beyond ``PROVENANCE_CACHE_TTL_S``.
    """
    parts = [f"identity={identity}"]
    if root is None:
        parts.append("source=non-git")
    else:
        try:
            source_identity = os.path.realpath(str(root)).encode(
                "utf-8", "surrogatepass"
            )
            parts.append("source=" + hashlib.sha256(source_identity).hexdigest())
        except (OSError, ValueError):
            parts.append("source=unresolved")
        git_dir = _git_dir(root)
        if git_dir is None:
            parts.append("git=missing")
        else:
            common_dir = _common_git_dir(git_dir)
            head = git_dir / "HEAD"
            parts.append("HEAD=" + _control_file_fact(head))
            try:
                head_text = head.read_text(
                    encoding="utf-8", errors="replace"
                ).strip()
            except OSError:
                head_text = ""
            if head_text.startswith("ref:"):
                ref_name = head_text.split(":", 1)[1].strip()
                if ref_name and ".." not in ref_name:
                    parts.append("ref=" + _control_file_fact(common_dir / ref_name))
            for label, path in (
                ("packed", common_dir / "packed-refs"),
                ("index", git_dir / "index"),
                ("shallow", common_dir / "shallow"),
                ("config", common_dir / "config"),
                ("worktree-config", git_dir / "config.worktree"),
            ):
                parts.append(f"{label}=" + _control_file_fact(path))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def _receipt(
    *,
    state: str,
    reason: str,
    observed_commit: Optional[str],
    shallow: Optional[bool],
    cached_at: datetime,
    source_marker: str,
    certified_commit: str,
) -> Dict[str, Any]:
    return {
        "schemaVersion": PROVENANCE_SCHEMA_VERSION,
        "state": state if state in STATES else STATE_UNKNOWN,
        "reason": reason,
        "certifiedCommitShort": certified_commit[:12],
        "observedCommitShort": (
            observed_commit[:12]
            if isinstance(observed_commit, str)
            and _FULL_COMMIT_RE.fullmatch(observed_commit)
            else None
        ),
        "shallow": shallow if isinstance(shallow, bool) else None,
        "cachedAt": _iso(cached_at),
        "sourceMarker": source_marker,
    }


def inspect_hermes_source(
    root: Optional[Path],
    package_version: str,
    *,
    certified_version: str,
    certified_commit: str,
    cached_at: Optional[datetime] = None,
    source_marker: Optional[str] = None,
    git_runner: GitRunner = _git,
) -> Dict[str, Any]:
    """Run one bounded inspection. It never raises and never gates anything."""
    instant = cached_at or _now()
    marker = source_marker or source_freshness_marker(root, package_version or "")

    def unknown(
        reason: str,
        observed: Optional[str] = None,
        shallow: Optional[bool] = None,
    ) -> Dict[str, Any]:
        return _receipt(
            state=STATE_UNKNOWN,
            reason=reason,
            observed_commit=observed,
            shallow=shallow,
            cached_at=instant,
            source_marker=marker,
            certified_commit=certified_commit,
        )

    if not isinstance(package_version, str) or not _PACKAGE_VERSION_RE.fullmatch(
        package_version
    ):
        return unknown("package_version_unavailable")
    if not _FULL_COMMIT_RE.fullmatch(certified_commit):
        return unknown("certified_identity_unavailable")
    if root is None or _git_dir(root) is None:
        return unknown("non_git_install")

    shallow_text = git_runner(["rev-parse", "--is-shallow-repository"], root)
    if shallow_text not in ("true", "false"):
        return unknown("git_inspection_failed")
    observed = git_runner(["rev-parse", "HEAD"], root)
    if not isinstance(observed, str) or not _FULL_COMMIT_RE.fullmatch(observed):
        return unknown("head_object_missing", shallow=shallow_text == "true")
    if shallow_text == "true":
        return unknown("shallow_repository", observed, True)

    config_names = git_runner(["config", "--local", "--name-only", "--list"], root)
    if config_names is None:
        return unknown("git_config_inspection_failed", observed, False)
    names = {line.strip().lower() for line in config_names.splitlines()}
    if "extensions.partialclone" in names or any(
        name.startswith("remote.")
        and (name.endswith(".promisor") or name.endswith(".partialclonefilter"))
        for name in names
    ):
        return unknown("partial_repository", observed, False)

    if git_runner(["cat-file", "-e", "HEAD^{commit}"], root) is None:
        return unknown("head_object_missing", observed, False)
    if git_runner(["cat-file", "-e", f"{certified_commit}^{{commit}}"], root) is None:
        return unknown("certified_object_missing", observed, False)
    if git_runner(["rev-list", "--objects", "--quiet", "HEAD"], root) is None:
        return unknown("head_object_graph_incomplete", observed, False)
    index_entries = git_runner(["ls-files", "-v", "-z"], root)
    if index_entries is None:
        return unknown("index_inspection_failed", observed, False)
    index_tags = {
        entry[0] for entry in index_entries.split("\0") if entry
    }
    if "S" in index_tags or any(tag.islower() for tag in index_tags):
        return unknown("index_mode_unsupported", observed, False)
    status = git_runner(
        ["status", "--porcelain=v1", "--untracked-files=normal"], root
    )
    if status is None:
        return unknown("worktree_inspection_failed", observed, False)

    if package_version != certified_version:
        state, reason = STATE_DRIFTED, "package_version_differs"
    elif observed != certified_commit:
        state, reason = STATE_DRIFTED, "commit_differs"
    elif status:
        state, reason = STATE_DRIFTED, "worktree_changes_present"
    else:
        state, reason = STATE_CERTIFIED_SOURCE, "certified_commit_clean"
    return _receipt(
        state=state,
        reason=reason,
        observed_commit=observed,
        shallow=False,
        cached_at=instant,
        source_marker=marker,
        certified_commit=certified_commit,
    )


def _cache_key(home: Optional[Path]) -> Optional[str]:
    if home is None:
        return None
    try:
        identity = os.path.realpath(str(home))
    except (OSError, ValueError):
        return None
    return hashlib.sha256(identity.encode("utf-8", "surrogatepass")).hexdigest()


def _read_cache(
    key: Optional[str], marker: str, now: datetime
) -> Optional[Dict[str, Any]]:
    if key is None:
        return None
    with _MEMORY_CACHE_LOCK:
        body = _MEMORY_CACHE.get(key)
        if body is not None:
            _MEMORY_CACHE.move_to_end(key)
    if not isinstance(body, dict) or set(body) != _CACHE_KEYS:
        return None
    if body.get("schemaVersion") != PROVENANCE_SCHEMA_VERSION:
        return None
    if body.get("state") not in STATES or body.get("sourceMarker") != marker:
        return None
    cached_at = _parse_instant(body.get("cachedAt"))
    if cached_at is None:
        return None
    age = (now.astimezone(timezone.utc) - cached_at).total_seconds()
    if age < 0 or age > PROVENANCE_CACHE_TTL_S:
        return None
    return dict(body)


def _write_cache(key: Optional[str], receipt: Mapping[str, Any]) -> None:
    if key is None:
        return
    with _MEMORY_CACHE_LOCK:
        _MEMORY_CACHE[key] = dict(receipt)
        _MEMORY_CACHE.move_to_end(key)
        while len(_MEMORY_CACHE) > MEMORY_CACHE_MAX_PROFILES:
            _MEMORY_CACHE.popitem(last=False)


def collect_hermes_source(
    package_version: str,
    *,
    certified_version: str,
    certified_commit: str,
    profile_home: Optional[Path],
    source_root: Optional[Path] = None,
    now: Optional[datetime] = None,
    git_runner: GitRunner = _git,
) -> Dict[str, Any]:
    """Return a cached or freshly inspected secret-free provenance receipt."""
    instant = now or _now()
    root = source_root if source_root is not None else locate_hermes_source_root()
    marker = source_freshness_marker(
        root, f"{package_version}|{certified_version}|{certified_commit}"
    )
    key = _cache_key(profile_home)
    cached = _read_cache(key, marker, instant)
    if cached is not None:
        return cached
    receipt = inspect_hermes_source(
        root,
        package_version,
        certified_version=certified_version,
        certified_commit=certified_commit,
        cached_at=instant,
        source_marker=marker,
        git_runner=git_runner,
    )
    _write_cache(key, receipt)
    return receipt
