"""The one way this plugin reads a secret (Hermes catalogue rule 11, #6402).

A plugin gets secrets only through Hermes: ``agent.secret_scope.get_secret``
inside the profile's secret scope. It never parses a ``.env`` file and never
reads ``os.environ`` for a secret itself.

``get_secret`` already does the right thing for each deployment. With a scope
installed it reads that profile's ``.env`` overlay, and on a single-profile
gateway it then falls through to the process environment (systemd, ``op run``),
so a deployment-injected value still counts. Under multiplexing with no scope it
raises rather than read another profile's value.

Plugin code often runs outside a turn (pairing, doctor, setup status, the
dashboard), where Hermes has installed no scope. :func:`read_secret` then
installs the scope of the profile it was asked about, or of the gateway's own
home, for the length of the read.

Writes stay on Hermes's own writers, ``hermes_cli.config.save_env_value`` and
``remove_env_value``, under :func:`profile_home_scope` when they target a profile
other than the current one.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator, List, Optional


def _default_home() -> Optional[Path]:
    """The home whose scope a read falls back to when none is installed."""
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - Hermes absent: no home to scope to
        return None


@contextmanager
def secret_scope_for(home: Optional[Path]) -> Iterator[None]:
    """Install [home]'s profile secret scope for the block; no-op without one."""
    if home is None:
        yield
        return
    from agent.secret_scope import (  # type: ignore
        build_profile_secret_scope,
        reset_secret_scope,
        set_secret_scope,
    )

    mapping = build_profile_secret_scope(Path(home))
    try:
        token = set_secret_scope(mapping, profile_home=str(home))
    except TypeError:
        # Hermes 0.21.4 (our floor) has no ``profile_home`` stamp. There a
        # foreign home reads as routed through the home override instead,
        # which ``profile_home_scope`` sets.
        token = set_secret_scope(mapping)
    try:
        yield
    finally:
        reset_secret_scope(token)


def _is_process_home(home: Path) -> bool:
    """Whether [home] is the gateway process's own profile home."""
    try:
        import hermes_constants  # type: ignore

        # Newer Hermes pins the routing identity; 0.21.4 has only the live one.
        resolve = getattr(hermes_constants, "get_routing_process_hermes_home", None) or (
            hermes_constants.get_process_hermes_home
        )
        process = Path(resolve())
    except Exception:  # noqa: BLE001 - Hermes absent: treat as our own
        return True
    try:
        return process.resolve() == Path(home).resolve()
    except OSError:
        return process == Path(home)


def read_secret(name: str, home: Optional[Path] = None) -> str:
    """The value of secret [name], stripped, or "" when it is not set.

    With [home], reads that profile's value. Without it, reads in the scope
    Hermes installed for this turn, or else the gateway's own home. Never
    raises: an unreadable secret reads as unset.
    """
    try:
        from agent.secret_scope import current_secret_scope, get_secret  # type: ignore
    except Exception:  # noqa: BLE001 - Hermes absent
        return ""
    try:
        if home is not None and not _is_process_home(Path(home)):
            # Another profile's value is what its store holds, never this
            # process's environment. Newer Hermes enforces this inside
            # get_secret; Hermes 0.21.4 (our floor) falls through to
            # os.environ on a single-profile gateway, so it is asked here.
            return read_stored_secret(name, Path(home)) or ""
        if home is not None:
            with secret_scope_for(Path(home)):
                value = get_secret(name)
        elif current_secret_scope() is not None:
            value = get_secret(name)
        else:
            with secret_scope_for(_default_home()):
                value = get_secret(name)
    except Exception:  # noqa: BLE001 - includes UnscopedSecretError
        return ""
    return value.strip() if isinstance(value, str) else ""


def secret_present(name: str, home: Optional[Path] = None) -> bool:
    """Whether secret [name] is set, without handing the value to the caller."""
    return bool(read_secret(name, home))


def profile_home() -> Optional[Path]:
    """The home of the profile this code is serving, or None without Hermes.

    Honours Hermes's context-local home override, so a routed profile and a
    :func:`profile_home_scope` block both resolve to their own home. Pass it as
    ``home=`` to :func:`read_secret` for a read rebuilt from the profile's
    files now rather than a scope snapshot installed earlier.
    """
    return _default_home()


def read_stored_secret(name: str, home: Optional[Path] = None) -> Optional[str]:
    """[name] as the profile's own secret store holds it now, stripped.

    This is the scope Hermes builds for the profile (its ``.env`` plus external
    and administrator-managed sources), WITHOUT ``get_secret``'s fall-through
    to the process environment. Use it only to ask "what is saved", e.g. to
    compare against what a running process loaded (a removal that waits on a
    restart must read as removed although this process still holds the value),
    or to ask about another profile from a process that belongs to a different
    one. "" when the store does not set it; None when the store cannot be
    read at all (Hermes absent), so a caller can report "unknown".
    """
    try:
        from agent.secret_scope import build_profile_secret_scope  # type: ignore
    except Exception:  # noqa: BLE001 - Hermes absent
        return None
    target = Path(home) if home is not None else _default_home()
    if target is None:
        return None
    try:
        value = build_profile_secret_scope(target).get(name)
    except Exception:  # noqa: BLE001 - an unbuildable store is unknown
        return None
    return value.strip() if isinstance(value, str) else ""


@contextmanager
def profile_home_scope(home: Path) -> Iterator[None]:
    """Aim Hermes's own ``.env`` writers and readers at [home] for the block.

    ``save_env_value`` and ``remove_env_value`` write ``get_env_path()``, which
    honours Hermes's context-local home override, and publish the change into
    the installed secret scope instead of the shared process environment.
    """
    from hermes_constants import (  # type: ignore
        reset_hermes_home_override,
        set_hermes_home_override,
    )

    override = set_hermes_home_override(str(home))
    try:
        with secret_scope_for(Path(home)):
            yield
    finally:
        reset_hermes_home_override(override)


def copy_stored_secrets(names: Iterable[str], source: Path, target: Path) -> List[str]:
    """Give profile [target] the saved value of each of [names] in [source].

    Hermes reads both stores (``build_profile_secret_scope``: the ``.env`` plus
    external and administrator-managed sources) and Hermes's own
    ``save_env_value`` / ``remove_env_value`` write [target]'s ``.env``, aimed
    there by :func:`profile_home_scope`. Values stay inside this function. A
    name [source] no longer holds is removed from [target], so a replay
    follows the source. Returns the names that could not be carried
    unchanged: a multi-line value (Hermes's writer drops line breaks), or a
    write that does not read back.
    """
    from agent.secret_scope import build_profile_secret_scope  # type: ignore
    from hermes_cli.config import remove_env_value, save_env_value  # type: ignore

    source_scope = build_profile_secret_scope(Path(source))
    target_scope = build_profile_secret_scope(Path(target))
    not_carried: List[str] = []
    for name in sorted(set(names)):
        value = source_scope.get(name)
        if not value:
            if target_scope.get(name):
                with profile_home_scope(Path(target)):
                    remove_env_value(name)
            continue
        if "\n" in value or "\r" in value:
            not_carried.append(name)
            continue
        if target_scope.get(name) == value:
            continue
        with profile_home_scope(Path(target)):
            save_env_value(name, value)
        if build_profile_secret_scope(Path(target)).get(name) != value:
            not_carried.append(name)
    env_path = Path(target) / ".env"
    if env_path.exists():
        os.chmod(env_path, 0o600)
    return not_carried
