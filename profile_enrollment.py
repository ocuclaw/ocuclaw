"""OcuClaw's own enrollment set (#2940, SPEC #2939 T5).

**A gateway-served list is not an enrollment list.** Hermes decides which
profiles a multiplexing gateway *can* route; OcuClaw decides which of those the
wearer's glasses may actually reach. Until 0.21.3 those two questions shared one
answer — ``gateway.multiplex_profile_allowlist``, which OcuClaw wrote as its
enrollment set (``profile_lifecycle.admit_profile``) and Hermes read as its
served bound. Config migration 42→43 deletes that key and the multiplexer serves
every live profile, so on 0.21.3 the promise in
``docs/hermes/multiplex-beta-contract.md`` — "existing profiles are selectable,
not automatically enrolled" — has no backing left unless OcuClaw keeps its own.

This module is that set, and the admission predicate
(:mod:`.profile_routes`'s ``set_admission`` seam, #2942) that enforces it.

Where it lives
--------------

``platforms.ocuclaw.extra.profile_allowlist`` in the **default** profile's
``config.yaml``. Three reasons, and the first is the load-bearing one:

* the #2944 doctor **already reads exactly this path** (``profiles_report.py``
  ``ENROLLMENT_CONFIG_PATH``, consulted at :func:`profiles_report.collect`
  before the retired gateway key). Writing anywhere else would give the wearer a
  doctor that disagrees with the glasses. This module reads through the doctor's
  own :func:`~.profiles_report.read_profile_config`, so the two cannot diverge
  on readability either.
* ``platforms.<name>.extra`` is an open dict upstream (``gateway/config.py``
  ``PlatformConfig.from_dict`` collects unknown keys into ``extra``), so an
  unknown key is carried, not rejected;
* ``uninstall.py`` already strips ``platforms.ocuclaw``, so the set leaves with
  the plugin instead of outliving it.

Its shape
---------

**Secondary profile names only.** ``default`` is never listed and is always
enrolled: it owns transport (SPEC #2939), so an enrollment set that could
exclude it would be a way to take the wearer's own glasses away. This is also
upstream's own rule for the key being migrated from — ``profiles_to_serve``
drops a ``"default"`` entry from ``profile_allowlist``
(``hermes_cli/profiles.py`` on 0.21.1) — which is what lets migration be a
verbatim copy and the older-engine mirror a verbatim copy back.

Absence is not permission
-------------------------

The four states are distinct on purpose, and only ``bounded`` admits a
secondary:

``bounded``
    OcuClaw has a set. It is the answer, even when it is empty.
``unset``
    No OcuClaw set and nothing to migrate from. **Not** "every profile" — the
    wearer is asked to reselect on the phone. This is the state a 0.21.3 host
    lands in when the config migration removed the old key before OcuClaw could
    copy it, and the one the ticket names explicitly.
``invalid``
    A set that is there but malformed. Fails closed; repair is reselection.
``unreadable``
    The config could not be read at all. Nothing is proven, so a previously
    proven set is retained (see :class:`EnrollmentStore`) and, with nothing
    retained, nothing but ``default`` is admitted.

Dual-engine
-----------

Probed, never inferred from a version string (the probe is #2942's
``EngineCapabilities.allowlist_param``: does the running
``profiles_to_serve`` still take ``profile_allowlist``?).

* **0.21.0–0.21.2** — the key exists and *Hermes* uses it to bound the served
  set. Every write here therefore also writes ``gateway.multiplex_profile_allowlist``
  as a mirror. Without that, enrolling a profile on those hosts would update a
  set nothing serves and the new agent would never appear.
* **0.21.3+** — the key is gone; the mirror is not written, and enforcement is
  entirely plugin-side.

Neither path ever writes ``OCUCLAW_ALLOWED_USERS`` or
``OCUCLAW_ALLOW_ALL_USERS``: transport authentication is the grant (review Q1),
and enrollment is a different question from authorization.

What it does *not* decide
-------------------------

Enrollment bounds **OcuClaw access only**. It does not decide which profiles'
cron jobs or channels the Hermes multiplexer runs — that is the gateway's own
business and setup (#2943) explains it separately. And it deliberately says
nothing about a *preferred agent for new chats* (review Q6): that is Matty's
open product question, so :class:`Enrollment` exposes membership and leaves
preference to a later key alongside this one.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import threading
import time
from typing import Any, Callable, Dict, FrozenSet, List, Mapping, Optional, Sequence, Tuple

from .profile_routes import (
    DEFAULT_PROFILE,
    EngineCapabilities,
    sanitize_profile_name,
)

#: The OcuClaw-owned enrollment set. Kept byte-identical to the doctor's
#: ``profiles_report.ENROLLMENT_CONFIG_PATH``; the assertion that they still
#: agree is a test, not a comment.
ENROLLMENT_CONFIG_PATH: Tuple[str, ...] = (
    "platforms",
    "ocuclaw",
    "extra",
    "profile_allowlist",
)

#: The retired gateway-owned key: migration source, and the mirror target on
#: 0.21.0–0.21.2.
ALLOWLIST_CONFIG_PATH: Tuple[str, ...] = ("gateway", "multiplex_profile_allowlist")

CONFIG_FILENAME = "config.yaml"

# -- states -------------------------------------------------------------------

#: OcuClaw has a set; it is the answer even when empty.
ENROLLMENT_BOUNDED = "bounded"
#: No set and nothing to migrate: reselection, never "everything".
ENROLLMENT_UNSET = "unset"
#: Present but malformed: fails closed, repaired by reselecting.
ENROLLMENT_INVALID = "invalid"
#: The config could not be read; nothing is proven either way.
ENROLLMENT_UNREADABLE = "unreadable"

#: Where a bounded set came from.
SOURCE_OCUCLAW = "platforms.ocuclaw.extra.profile_allowlist"
SOURCE_MIGRATED = "gateway.multiplex_profile_allowlist"

#: A short cache lifetime: long enough that the per-turn admission check is not
#: a stat storm, short enough that a hand-edited config is honoured promptly.
ENROLLMENT_CACHE_TTL_SECONDS = 1.0


class EnrollmentConfigUnreadable(ValueError):
    """The host's ``config.yaml`` could not be parsed, so the set cannot change.

    Distinct from a bad request: nothing the wearer typed is wrong and
    retrying the same tap will not help, so the lane reports it as a native
    read failure rather than telling them to refresh and try again.
    """


@dataclass(frozen=True)
class Enrollment:
    """One reading of the enrollment set.

    ``profiles`` holds secondary names only. ``default`` is not a member and
    does not need to be: :meth:`admits` answers for it directly, so no caller
    can forget the transport owner.
    """

    state: str = ENROLLMENT_UNSET
    profiles: FrozenSet[str] = frozenset()
    source: Optional[str] = None
    #: The config generation this was read from ``(mtime_ns, size)``; the store
    #: re-parses only when it changes.
    stamp: Optional[Tuple[int, int]] = None

    @property
    def bounded(self) -> bool:
        """Is there an OcuClaw-owned answer at all?"""
        return self.state == ENROLLMENT_BOUNDED

    @property
    def requires_reselection(self) -> bool:
        """Must the wearer pick agents on the phone before any are reachable?

        Whenever OcuClaw has no usable set. A bounded-but-empty set is a
        deliberate choice ("just the one agent"), not a prompt -- every other
        state is.

        ``unreadable`` counts. The store only ever *returns* that state when it
        has never proven a set (it retains a proven one across a bad read), so
        it means precisely "only the default agent is reachable and I do not
        know which agents you chose" -- the state that most needs the prompt.
        The client's own defensive fallback already assumes reselection there.
        """
        return self.state in (
            ENROLLMENT_UNSET,
            ENROLLMENT_INVALID,
            ENROLLMENT_UNREADABLE,
        )

    def admits(self, profile: Any) -> bool:
        """May the glasses reach *profile*?

        ``default`` always. Everything else only from a bounded set, so no
        failure mode reads as "every profile".
        """
        name = sanitize_profile_name(profile)
        if name is None:
            return False
        if name == DEFAULT_PROFILE:
            return True
        return self.bounded and name in self.profiles

    def as_list(self) -> List[str]:
        """The set as the sorted list written to config (secondaries only)."""
        return sorted(self.profiles)


#: Nothing known: the fail-closed reading.
CLOSED_ENROLLMENT = Enrollment(state=ENROLLMENT_UNREADABLE)


# -- reading ------------------------------------------------------------------


def _dig(config: Mapping[str, Any], path: Sequence[str]) -> Any:
    """``config[a][b][c]`` or ``None`` — the doctor's own traversal."""
    cursor: Any = config
    for key in path:
        if not isinstance(cursor, Mapping):
            return None
        cursor = cursor.get(key)
    return cursor


def _read_config(home: Path) -> Tuple[Dict[str, Any], bool]:
    """The default profile's raw config, through the doctor's reader.

    Sharing :func:`~.profiles_report.read_profile_config` is what guarantees
    "both readers agree": the doctor and the admission gate cannot differ about
    whether a config is readable or what is in it.
    """
    from .profiles_report import read_profile_config

    return read_profile_config(home)


def _clean_names(raw: Any) -> Optional[List[str]]:
    """A profile-name list, or ``None`` when *raw* is not a list at all.

    Invalid *entries* are dropped the way the doctor drops them; an invalid
    *container* is a different fact and is reported as such by the caller.
    """
    if not isinstance(raw, list):
        return None
    names: List[str] = []
    for item in raw:
        name = sanitize_profile_name(item)
        if name is not None and name != DEFAULT_PROFILE and name not in names:
            names.append(name)
    return names


def read_enrollment(home: Optional[Path]) -> Enrollment:
    """Read the enrollment set from *home*'s ``config.yaml``. Never widens.

    The OcuClaw key is the only authority. The retired gateway key is NOT
    consulted here: reading it as a live fallback would make an operator's
    stale 0.21.1 policy silently govern a 0.21.3 host after the engine had
    already retired it. It is a *migration source*, and :func:`ensure_migrated`
    is where it is copied, once, deliberately, into OcuClaw's own key.
    """
    if home is None:
        return Enrollment(state=ENROLLMENT_UNREADABLE)
    config, readable = _read_config(home)
    if not readable:
        return Enrollment(state=ENROLLMENT_UNREADABLE)
    stamp = _config_stamp(home)
    raw = _dig(config, ENROLLMENT_CONFIG_PATH)
    if raw is None:
        return Enrollment(state=ENROLLMENT_UNSET, stamp=stamp)
    names = _clean_names(raw)
    if names is None:
        return Enrollment(state=ENROLLMENT_INVALID, stamp=stamp)
    return Enrollment(
        state=ENROLLMENT_BOUNDED,
        profiles=frozenset(names),
        source=SOURCE_OCUCLAW,
        stamp=stamp,
    )


def _config_stamp(home: Path) -> Optional[Tuple[int, int]]:
    """``(mtime_ns, size)`` of the config, or ``None`` when it cannot be stat'd."""
    try:
        status = (Path(home) / CONFIG_FILENAME).stat()
    except OSError:
        return None
    return (status.st_mtime_ns, status.st_size)


# -- writing ------------------------------------------------------------------


def _write_names(
    home: Path, names: Sequence[str], *, mirror: bool
) -> None:
    """Write the enrollment set, and the mirror when the engine still reads one.

    One atomic write for both keys: a crash between them would leave a host
    whose enforcement and served set disagree, which is the exact failure the
    mirror exists to prevent.

    The mirror is only ever *updated*, never *created*. Upstream reads an
    absent ``gateway.multiplex_profile_allowlist`` as "serve every live
    profile" and a present one as "serve only these"
    (``hermes_cli/profiles.py::profiles_to_serve``), so writing the key onto a
    host that never had it would stop the multiplexer serving every profile
    the wearer did not enrol -- taking their cron jobs and channels down with
    it. Enrollment bounds OcuClaw access only; which profiles Hermes serves is
    Hermes's business. When the key is absent the engine already serves
    everything, so a newly enrolled profile is reachable there regardless and
    the mirror has nothing to add.
    """
    from hermes_cli.config import atomic_config_write, read_user_config_raw

    path = Path(home) / CONFIG_FILENAME
    config = read_user_config_raw(path)
    if not isinstance(config, dict):
        raise ValueError("Hermes configuration is invalid")
    ordered = sorted(dict.fromkeys(names))

    platforms = config.setdefault("platforms", {})
    if not isinstance(platforms, dict):
        raise ValueError("Platform configuration is invalid")
    ocuclaw = platforms.setdefault(ENROLLMENT_CONFIG_PATH[1], {})
    if not isinstance(ocuclaw, dict):
        raise ValueError("OcuClaw platform configuration is invalid")
    extra = ocuclaw.setdefault(ENROLLMENT_CONFIG_PATH[2], {})
    if not isinstance(extra, dict):
        raise ValueError("OcuClaw platform settings are invalid")
    extra[ENROLLMENT_CONFIG_PATH[3]] = list(ordered)

    # Update an allowlist the operator already set; never bring one into being.
    if mirror and _dig(config, ALLOWLIST_CONFIG_PATH) is not None:
        gateway = config.setdefault(ALLOWLIST_CONFIG_PATH[0], {})
        if not isinstance(gateway, dict):
            raise ValueError("Gateway configuration is invalid")
        gateway[ALLOWLIST_CONFIG_PATH[1]] = list(ordered)

    atomic_config_write(path, config)


def mirror_is_required(capabilities: Optional[EngineCapabilities] = None) -> bool:
    """Does the running engine still read the gateway-owned allowlist?

    Probed through #2942's capability record — the ``profile_allowlist``
    parameter on ``profiles_to_serve`` — so a host is classified by what its
    engine can do, never by a version string. An unprobeable engine gets no
    mirror: writing a key the engine has retired is the harmless direction to
    be wrong in only if the engine really is older, and guessing "older"
    without evidence would resurrect a key 0.21.3 deliberately deleted.
    """
    caps = capabilities
    if caps is None:
        from .profile_routes import RESOLVER

        caps = RESOLVER.capabilities()
    return bool(caps.allowlist_param)


# -- the store ----------------------------------------------------------------


class EnrollmentStore:
    """The process-wide enrollment set: cached reads, serialized writes.

    The cache matters because :meth:`admission` is called once per profile per
    route resolution, on the gateway's own loop. It is invalidated by this
    store's own writes and, otherwise, by the config's ``(mtime_ns, size)``
    changing — so a ``hermes config set`` from a terminal is picked up without
    a restart, at most one TTL later.

    An unreadable config **retains** the last proven set rather than emptying
    the wearer's agent list on a transient. Retention cannot widen access: the
    set only ever changes through a write here, and a write invalidates the
    cache. With nothing retained, nothing but ``default`` is admitted.
    """

    def __init__(
        self,
        *,
        ttl: float = ENROLLMENT_CACHE_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        home_resolver: Optional[Callable[[], Optional[Path]]] = None,
        reader: Optional[Callable[[Optional[Path]], Enrollment]] = None,
    ) -> None:
        self._ttl = float(ttl)
        self._clock = clock
        self._home_resolver = home_resolver
        self._read = read_enrollment if reader is None else reader
        self._lock = threading.RLock()
        self._cached: Optional[Enrollment] = None
        self._read_at: float = 0.0

    # -- plumbing ---------------------------------------------------------

    def _home(self) -> Optional[Path]:
        if self._home_resolver is not None:
            return self._home_resolver()
        from .profile_routes import resolve_default_home

        return resolve_default_home()

    def reset(self) -> None:
        """Forget everything, retained set included (tests, restart)."""
        with self._lock:
            self._cached = None
            self._read_at = 0.0

    def invalidate(self) -> None:
        """Drop the cache; the next read goes to the host."""
        with self._lock:
            self._read_at = 0.0

    # -- reading ----------------------------------------------------------

    def current(self) -> Enrollment:
        """The enrollment set, re-reading the config at most once per TTL."""
        now = self._clock()
        with self._lock:
            cached = self._cached
            if cached is not None and now - self._read_at < self._ttl:
                return cached
        try:
            fresh = self._read(self._home())
        except Exception:  # noqa: BLE001 - a failed read proves nothing
            fresh = Enrollment(state=ENROLLMENT_UNREADABLE)
        with self._lock:
            previous = self._cached
            self._read_at = now
            if fresh.state == ENROLLMENT_UNREADABLE and previous is not None:
                # Indeterminate: keep what was proven. Narrower-or-equal by
                # construction, so this can never widen access.
                self._cached = previous
            else:
                self._cached = fresh
            return self._cached

    def admission(self) -> Callable[..., bool]:
        """The predicate for :func:`.profile_routes.set_admission`.

        Signature is #2942's: ``(profile, *, home, served) -> bool``. Neither
        ``home`` nor ``served`` is consulted — enrollment is a property of the
        wearer's choice, not of what the gateway happens to be serving, and
        reading ``served`` here is precisely how a served list would turn back
        into an enrollment list.
        """

        def predicate(profile: str, *, home: Path, served: Sequence[str]) -> bool:
            return self.current().admits(profile)

        return predicate

    # -- writing ----------------------------------------------------------

    def _legacy_names(self, home: Path) -> Optional[List[str]]:
        """The retired gateway allowlist's selection, or ``None``."""
        config, readable = _read_config(home)
        if not readable:
            return None
        return _clean_names(_dig(config, ALLOWLIST_CONFIG_PATH))

    def _mutate(
        self,
        change: Callable[[List[str]], List[str]],
        *,
        capabilities: Optional[EngineCapabilities] = None,
    ) -> Enrollment:
        """Read-modify-write the set under the shared profile mutation lock.

        Serialized against ``profile_lifecycle``'s own config writes (creation,
        bootstrap) because they edit the same ``config.yaml``.
        """
        from .profile_lifecycle import PROFILE_MUTATION_LOCK

        home = self._home()
        if home is None:
            raise ValueError("No Hermes home to record agent selection in")
        mirror = mirror_is_required(capabilities)
        with PROFILE_MUTATION_LOCK:
            current = self._read(home)
            if current.state == ENROLLMENT_UNREADABLE:
                raise EnrollmentConfigUnreadable(
                    "The Hermes configuration could not be read. "
                    "Repair it before changing agents."
                )
            # An invalid or absent set becomes a fresh, bounded one: a write is
            # the wearer's explicit selection, which is exactly the repair.
            #
            # An absent one rescues the retired allowlist first. Startup
            # migration normally did that already, but a write must not depend
            # on having booted through it: enrolling one agent is no reason to
            # silently drop a selection the operator made before 0.21.3 deleted
            # the key. An *invalid* set is not rescued — it is the thing being
            # repaired.
            if current.bounded:
                base = current.as_list()
            elif current.state == ENROLLMENT_UNSET:
                base = self._legacy_names(home) or []
            else:
                base = []
            updated = change(list(base))
            _write_names(home, updated, mirror=mirror)
        with self._lock:
            self._cached = None
            self._read_at = 0.0
        return self.current()

    def enrol(
        self, profile: Any, *, capabilities: Optional[EngineCapabilities] = None
    ) -> Enrollment:
        """Add *profile* to the set. ``default`` is already in it, always."""
        name = sanitize_profile_name(profile)
        if name is None:
            raise ValueError("That is not a valid agent name")
        if name == DEFAULT_PROFILE:
            return self.current()

        def change(names: List[str]) -> List[str]:
            if name not in names:
                names.append(name)
            return names

        return self._mutate(change, capabilities=capabilities)

    def remove(
        self, profile: Any, *, capabilities: Optional[EngineCapabilities] = None
    ) -> Enrollment:
        """Drop *profile* from the set.

        Removing ``default`` is refused rather than ignored: it owns transport,
        and a silent no-op would leave the phone showing a removal that did not
        happen.
        """
        name = sanitize_profile_name(profile)
        if name is None:
            raise ValueError("That is not a valid agent name")
        if name == DEFAULT_PROFILE:
            raise ValueError(
                "The default agent carries this pairing and cannot be removed"
            )

        def change(names: List[str]) -> List[str]:
            return [item for item in names if item != name]

        return self._mutate(change, capabilities=capabilities)

    # -- migration --------------------------------------------------------

    def ensure_migrated(
        self, *, capabilities: Optional[EngineCapabilities] = None
    ) -> Enrollment:
        """Copy the retired allowlist into OcuClaw's key, once.

        Runs at startup, not inside the predicate: a read path that writes
        would turn every route resolution into a possible config write.

        Three outcomes, and the third is the one the ticket is about:

        * an OcuClaw set already exists — nothing happens, whatever the old key
          still says;
        * the old key is still there (0.21.0–0.21.2, or a 0.21.3 host whose
          config has not been migrated yet) — it is copied verbatim, preserving
          a selection the wearer made before upstream could delete it;
        * neither exists — **nothing is written and nothing is admitted**. The
          phone asks the wearer to reselect. Writing an empty set here would
          be indistinguishable from a deliberate choice, and reading the
          absence as "every profile" is the exact widening this ticket exists
          to prevent.
        """
        home = self._home()
        if home is None:
            return Enrollment(state=ENROLLMENT_UNREADABLE)
        current = self._read(home)
        if current.state != ENROLLMENT_UNSET:
            return current
        legacy = self._legacy_names(home)
        if legacy is None:
            # No old selection to rescue. Reselection, not "everything".
            return current
        from .profile_lifecycle import PROFILE_MUTATION_LOCK

        mirror = mirror_is_required(capabilities)
        with PROFILE_MUTATION_LOCK:
            _write_names(home, legacy, mirror=mirror)
        with self._lock:
            self._cached = None
            self._read_at = 0.0
        migrated = self.current()
        if migrated.bounded:
            return Enrollment(
                state=migrated.state,
                profiles=migrated.profiles,
                source=SOURCE_MIGRATED,
                stamp=migrated.stamp,
            )
        return migrated


# -- the Agents list ----------------------------------------------------------

#: The transport owner. Always enrolled, never removable.
AGENT_STATE_DEFAULT = "default"
#: Served and enrolled: reachable from the glasses.
AGENT_STATE_ENROLLED = "enrolled"
#: Served but not enrolled: offered to the wearer, reachable from nothing.
AGENT_STATE_AVAILABLE = "available"
#: Served, but OcuClaw has not finished building it. "Setup incomplete, retry" —
#: the retry is the same ``gw.profiles.create`` call with the same request id
#: and fingerprint, so the wearer is never stuck with a half-built agent that
#: cannot be repaired.
AGENT_STATE_INCOMPLETE = "incomplete"
#: Enrolled, but this gateway no longer serves it (deleted or stopped in
#: Hermes). Shown so a stale selection can be cleared instead of silently
#: haunting the set.
AGENT_STATE_MISSING = "missing"


def agents_view(
    snapshot: Optional[Any] = None, *, enrollment: Optional[Enrollment] = None
) -> Dict[str, Any]:
    """The phone's Agents list: every served profile and what may be done to it.

    Read from **one** route resolution, so the set the wearer is offered and
    the set that is enforced cannot be two different readings of the host.

    This is deliberately the one surface that sees past admission, and it is
    safe because of what it returns: profile *names* and states. No transcript,
    no session, no settings, no dispatch. Enrolling is how a name becomes
    reachable; nothing here reaches it.

    **Standalone hosts get exactly one row.** Without multiplex this gateway
    serves one profile and there is no second agent to enrol, so the list is
    the default agent alone, with nothing offered. Saying that plainly is
    better than an empty list, which would read as "your agents are gone".
    """
    from . import profile_routes

    if snapshot is None:
        snapshot = profile_routes.RESOLVER.snapshot()
    current = current_enrollment() if enrollment is None else enrollment

    if not getattr(snapshot, "multiplex", False):
        return {
            "agents": [
                {
                    "name": DEFAULT_PROFILE,
                    "state": AGENT_STATE_DEFAULT,
                    "enrolled": True,
                    "removable": False,
                    "enrollable": False,
                }
            ],
            "enrollment": {
                "state": current.state,
                "source": current.source,
                # Nothing to reselect among: one agent is the whole host.
                "requiresReselection": False,
            },
            "multiplex": False,
        }

    served = dict(getattr(snapshot, "served", {}) or {})
    incomplete = set(getattr(snapshot, "incomplete", frozenset()) or frozenset())
    rows: List[Dict[str, Any]] = []

    for name in sorted(served):
        if name == DEFAULT_PROFILE:
            state = AGENT_STATE_DEFAULT
        elif name in incomplete:
            state = AGENT_STATE_INCOMPLETE
        elif current.admits(name):
            state = AGENT_STATE_ENROLLED
        else:
            state = AGENT_STATE_AVAILABLE
        rows.append(
            {
                "name": name,
                "state": state,
                "enrolled": state in (AGENT_STATE_DEFAULT, AGENT_STATE_ENROLLED),
                # The default agent carries the pairing; offering a removal
                # that would be refused is worse than not offering it.
                #
                # An INCOMPLETE agent is removable only if it somehow made it
                # into the set -- creation enrols just before stamping the
                # receipt complete, so a crash in that gap leaves exactly that
                # shape. Without this the wearer would see a permanent row they
                # could neither finish nor clear.
                "removable": (
                    state not in (AGENT_STATE_DEFAULT, AGENT_STATE_INCOMPLETE)
                    or (state == AGENT_STATE_INCOMPLETE and name in current.profiles)
                ),
                "enrollable": state == AGENT_STATE_AVAILABLE,
            }
        )

    # An enrolled profile this gateway no longer serves: keep it visible so the
    # wearer can clear it. Never silently dropped — a selection that vanished
    # without being shown is how a stale set becomes invisible.
    for name in sorted(current.profiles - set(served)):
        rows.append(
            {
                "name": name,
                "state": AGENT_STATE_MISSING,
                "enrolled": True,
                "removable": True,
                "enrollable": False,
            }
        )

    return {
        "agents": rows,
        "enrollment": {
            "state": current.state,
            "source": current.source,
            "requiresReselection": current.requires_reselection,
        },
        "multiplex": bool(getattr(snapshot, "multiplex", False)),
    }


#: The process-wide store. One instance so every reader and the admission
#: predicate share one cache.
STORE = EnrollmentStore()


def install_admission() -> Enrollment:
    """Migrate if needed, then enforce the set on every route resolution.

    The single call the adapter makes at startup. After it, *every* consumer of
    :func:`.profile_routes.load_profile_routing_snapshot` — the menu, the RPC
    facade, dispatch, session resolution — is bounded by the same set, because
    they all read the one resolver this installs the predicate on.
    """
    from . import profile_routes

    enrollment = STORE.ensure_migrated()
    profile_routes.set_admission(STORE.admission())
    return enrollment


def current_enrollment() -> Enrollment:
    """The process-wide enrollment set."""
    return STORE.current()
