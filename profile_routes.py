"""One live served-profile route resolver, shared by every reader (#2942).

SPEC #2939 keeps **one pairing, one relay credential, and the default profile
owning transport**; multiplex — one gateway serving every profile, sessions
namespaced ``agent:<profile>:…`` — is the only supported multi-agent shape for
that pairing. This module answers the one question both readers ask: *which
profiles can this gateway route right now?*

Before #2942 the answer was computed once, at adapter construction, and frozen
for the life of the process — separately in the adapter and again in
:class:`~.models_rpc.GwRpc`. Hermes 0.21.3 hot-reconciles its served set
(``gateway/run_profile_reconcile.py``: a ``rescan-profiles`` control-socket
signal plus a 30 s safety-net watcher), so a profile created from the glasses
becomes servable without a gateway restart — and a frozen snapshot could not
see it, nor see one go away.

Two route sources, picked by **probing the running engine**, never by a version
string:

``live``
    ``served_profiles`` in the default home's ``gateway_state.json``, written
    by the gateway itself (``gateway/run_adapters.py::_record_served_profiles``
    → ``gateway.status.write_runtime_status``), and re-written by the
    reconciler on 0.21.3, which is how a new profile arrives.

    On 0.21.3 it is read through upstream's own
    ``hermes_cli.gateway_multiplex_served.recorded_served_profiles`` — the one
    private-engine seam here, guarded by a module probe — because its liveness
    proof (pid file **and** lock **and** record, each checked against the
    running process) is stronger than a plugin's. Everywhere else the file is
    read directly and validated exactly the way :mod:`.profiles_report`
    validates it for the doctor — owner home, PID liveness, and Hermes's own
    profile-name charset, through the doctor's own helpers — so the two can
    never disagree about whether a record is usable. The state *words* are the
    doctor's, plus two this module needs and it does not:
    :data:`SERVED_STATE_ABSENT` for a live record whose ``served_profiles`` is
    missing or not a list (which the doctor reports as its ``standalone`` mode
    instead) and :data:`SERVED_STATE_UNKNOWN` for a home that could not be
    resolved at all.

    An **empty** ``served_profiles`` is neither of those. Upstream writes ``[]``
    for a single-profile gateway and treats it as an authoritative "serves
    nobody else", so it is read as a successful answer with no names — see
    :func:`read_served_profiles`.

``enumerated``
    ``hermes_cli.profiles.profiles_to_serve``. The signature is the
    version-tested seam: 0.21.0–0.21.2 take ``profile_allowlist`` (the
    gateway-owned enrollment set config migration 42→43 deletes), 0.21.3 does
    not. Probed with :func:`inspect.signature`, never with a version compare.
    This is the fallback for the window before the gateway has published a
    record (startup pending) and for any engine whose record does not validate.

**The file alone is not proof.** ``served_profiles`` is *eligibility* — that
the multiplexer holds a runtime for that profile. It is not proof of a working
adapter, of provider access, or of admission.

**Discovery is not admission.** Everything here answers "served". Whether a
served profile may be *reached from the glasses* is a separate predicate,
:data:`admission`, which #2940 replaces with OcuClaw's own enrollment set. The
default reproduces today's behaviour exactly (served ⇒ routable) and nothing in
this module ever enrols anything: a profile appearing in the served set changes
no configuration. #2940 plugs in through :meth:`ProfileRouteResolver.set_admission`
or :func:`set_admission` on the shared resolver.

**Degrade, never break.** An unreadable, malformed, foreign-owned or stale
record is *indeterminate*, not empty: the enumeration answers instead, and if
that is unavailable too, the last good snapshot stands. Collapsing a working
route table because a JSON file was being rewritten mid-read would take the
wearer's secondary agents away for no reason. The only determinate way to lose
routes is multiplex actually being off, or the gateway publishing a smaller set.

Note what this does *not* promise: falling back to the enumeration can widen the
set, because ``profiles_to_serve`` lists every live profile directory while the
gateway's record lists only what it actually serves. That is deliberate — it is
the same function the gateway itself serves from, and it is the only thing that
can establish the table at startup, before any record exists.
"""

from __future__ import annotations

import inspect
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import (
    Any,
    Callable,
    Dict,
    FrozenSet,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
)

DEFAULT_NAMESPACE = "main"
DEFAULT_PROFILE = "default"

#: ``gateway_state.json``/``profiles`` names, shared with :mod:`.profiles_report`
#: so the doctor and the router read the same file by the same name.
GATEWAY_STATE_FILENAME = "gateway_state.json"
PROFILES_DIRNAME = "profiles"

#: The durable receipt ``models_rpc._create_profile_with_setup`` writes into a
#: profile it is creating, and marks ``complete`` once the inherited settings,
#: SOUL and config are all in place. Hermes can serve the directory before that
#: finishes, so the receipt is the difference between "a directory exists" and
#: "OcuClaw's profile is ready".
CREATE_RECEIPT_FILENAME = ".ocuclaw-create.json"

#: How long one resolution is reused. The upstream safety-net rescan is 30 s
#: and the control-socket path is immediate, so a one-second cache costs at
#: most one small JSON read per second on the hot paths while still letting a
#: control-socket-triggered change show up effectively at once.
ROUTE_CACHE_TTL_SECONDS = 1.0
#: While the gateway has not published a record yet (startup), retry sooner —
#: the adapter is constructed inside that window.
ROUTE_PENDING_TTL_SECONDS = 0.25

# -- route sources ------------------------------------------------------------

#: Validated ``served_profiles`` from the live gateway record.
ROUTE_SOURCE_LIVE = "live"
#: ``profiles_to_serve`` enumeration (startup pending, or no usable record).
ROUTE_SOURCE_ENUMERATED = "enumerated"
#: Nothing new could be proved; the previous snapshot stands.
ROUTE_SOURCE_RETAINED = "retained"
#: Multiplex is off, or nothing at all is known yet. Default namespace only.
ROUTE_SOURCE_CLOSED = "closed"

# -- served-record states -----------------------------------------------------
# profiles_report's exact vocabulary (`collect()` → `served.state`). Same file,
# same words: a doctor line and a routing decision must never describe the same
# record differently.

SERVED_STATE_OK = "ok"
SERVED_STATE_MISSING = "missing"
SERVED_STATE_UNREADABLE = "unreadable"
SERVED_STATE_WRONG_OWNER = "wrong_owner"
SERVED_STATE_STALE = "stale"
#: A live record from a standalone (non-multiplexing) gateway: no
#: ``served_profiles`` key at all. Distinct from a malformed one.
SERVED_STATE_ABSENT = "absent"
#: No default home resolved — the record cannot even be located.
SERVED_STATE_UNKNOWN = "unknown"

#: ``hermes_cli.profiles.validate_profile_name``'s charset, mirrored from
#: :mod:`.profiles_report` so a hostile or corrupt record cannot inject a path
#: segment through a profile name.
_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def profile_for_namespace(ns: Any) -> str:
    """Map the W07 gw.agent.identity namespace to a Hermes profile name."""
    text = str(ns or "").strip()
    return DEFAULT_PROFILE if text in ("", DEFAULT_NAMESPACE) else text


def namespace_for_profile(profile: Any) -> str:
    """Map a Hermes profile name to the OcuClaw session namespace."""
    name = profile_for_namespace(profile)
    return DEFAULT_NAMESPACE if name == DEFAULT_PROFILE else name


def sanitize_profile_name(value: Any) -> Optional[str]:
    """A valid profile name, or None. Nothing else becomes a route."""
    if not isinstance(value, str):
        return None
    token = value.strip()
    return token if _PROFILE_NAME_RE.match(token) else None


# -- admission ----------------------------------------------------------------


def admit_every_served_profile(
    profile: str, *, home: Path, served: Sequence[str]
) -> bool:
    """Today's admission rule: a served profile is routable (#2942 default).

    This is deliberately *today's behaviour* and nothing wider. #2942 changes
    when the served set is read, not who may be reached, so the default
    predicate must neither widen nor narrow access.

    #2940 replaces it with OcuClaw's own enrollment set. When it does, the
    absence of an enrollment set must NOT be read as "every profile" — that is
    #2940's decision to make explicitly, and this default exists only because
    the pre-#2940 product has no enrollment set to consult.
    """
    return True


#: The admission predicate's type: ``(profile_name, *, home, served) -> bool``.
#: ``home`` is that profile's own Hermes home, so an enrollment set stored per
#: profile can be read without resolving anything again; ``served`` is the whole
#: served set, so a policy can reason about the set rather than one name.
AdmissionPredicate = Callable[..., bool]


# -- snapshot -----------------------------------------------------------------


@dataclass(frozen=True)
class RouteSnapshot:
    """What one resolution proved.

    ``admitted`` are the namespaces a new turn may be dispatched to. Draining a
    namespace that has just left the served set is deliberately NOT modelled
    here: only the adapter knows whether it still has work in flight, so it
    owns that set and this stays a statement about the gateway.
    """

    multiplex: bool = False
    admitted: Mapping[str, Path] = field(default_factory=dict)
    source: str = ROUTE_SOURCE_CLOSED
    served_state: str = SERVED_STATE_UNKNOWN
    #: The gateway has not published a usable record yet; retry sooner.
    pending: bool = False
    observed_at: float = 0.0
    #: Every profile this gateway serves, by PROFILE name, before admission and
    #: before the setup-completion gate. It is what #2940's Agents list offers
    #: the wearer to choose from — a profile cannot be enrolled if it is not
    #: here — and recording it on the same resolution that produced
    #: ``admitted`` is what stops the offer and the enforcement from being two
    #: different readings of the host. It is NOT a route: nothing dispatches
    #: from this map.
    served: Mapping[str, Path] = field(default_factory=dict)
    #: Served profiles OcuClaw is still setting up (an incomplete
    #: ``.ocuclaw-create.json`` receipt). They are deliberately kept out of
    #: ``admitted`` by :func:`creation_is_incomplete`; naming them here is what
    #: lets the Agents list say "setup incomplete, retry" instead of leaving
    #: the wearer with a profile that silently does not exist.
    incomplete: FrozenSet[str] = frozenset()

    def routes(self) -> Dict[str, Path]:
        """The admitted namespaces — admission of a new turn."""
        return dict(self.admitted)

    def as_tuple(self) -> Tuple[bool, Dict[str, Path]]:
        """The historical ``(multiplex, homes)`` pair both readers consume."""
        return self.multiplex, self.routes()


#: A closed gate: the fail-closed answer for "nothing is known".
CLOSED_SNAPSHOT = RouteSnapshot()


# -- engine capability probes -------------------------------------------------


@dataclass(frozen=True)
class EngineCapabilities:
    """What the *running* engine can do, probed, never inferred from a version.

    ``served_reader``
        ``hermes_cli.gateway_multiplex_served`` is importable — upstream's own
        "which profiles does the LIVE default multiplexer serve?" helper.
        0.21.3 only. Its liveness proof is stronger than anything a plugin can
        do from the file alone (pid file **and** lock **and** the record, each
        proven against the running process's start time, command line and
        home), so where it exists it is the answer.

    ``hot_reconcile``
        ``gateway.run_profile_reconcile`` exists — the module that re-publishes
        ``served_profiles`` when a profile is added or removed (30 s watcher
        plus an immediate ``rescan-profiles`` control-socket verb). Present on
        0.21.3, absent on 0.21.0–0.21.2, where the record is written once at
        adapter setup and is therefore the boot snapshot by nature.

        Presence-only, and ``gateway`` is not one of the import-surface
        ratchet's platform roots, so nothing pins this name. It is safe for it
        to be unpinned: nothing is imported from the module, and if upstream
        renames it the only effect is that the startup-pending retry uses the
        settled TTL instead of the shorter one.

    ``allowlist_param``
        ``profiles_to_serve`` still takes ``profile_allowlist`` — the retired
        gateway-owned enrollment set (deleted by config migration 42→43). True
        on 0.21.0–0.21.2, False on 0.21.3.

    Every one is a probe of the importable engine: a module that is there or
    is not, and a signature that has a parameter or does not. No version
    string is parsed or compared anywhere in this module.
    """

    served_reader: bool = False
    hot_reconcile: bool = False
    allowlist_param: bool = False
    probed: bool = False


def _module_present(name: str) -> bool:
    try:
        from importlib.util import find_spec

        return find_spec(name) is not None
    except Exception:  # noqa: BLE001 - an unprobeable engine is simply "older"
        return False


def probe_engine_capabilities() -> EngineCapabilities:
    """Probe the importable Hermes for the facts routing depends on."""
    allowlist_param = False
    probed = False
    try:
        from hermes_cli.profiles import profiles_to_serve

        allowlist_param = (
            "profile_allowlist" in inspect.signature(profiles_to_serve).parameters
        )
        probed = True
    except Exception:  # noqa: BLE001 - no Hermes on the path is not an outage
        allowlist_param = False
    return EngineCapabilities(
        served_reader=_module_present("hermes_cli.gateway_multiplex_served"),
        hot_reconcile=_module_present("gateway.run_profile_reconcile"),
        allowlist_param=allowlist_param,
        probed=probed,
    )


# -- reading the host ---------------------------------------------------------


def resolve_default_home() -> Optional[Path]:
    """The DEFAULT profile's home, which owns the gateway record.

    Uses the bundle's own receipt home resolution and :mod:`.profiles_report`'s
    ``default_home_for`` so a secondary-scoped process still asks the default
    home the question, without mutating ``HERMES_HOME``.
    """
    try:
        from .profiles_report import default_home_for
        from .receipts import resolve_receipt_home

        return default_home_for(resolve_receipt_home())
    except Exception:  # noqa: BLE001 - unresolvable home is indeterminate
        return None


def _same_path(left: Any, right: Any) -> bool:
    try:
        return os.path.realpath(str(left)) == os.path.realpath(str(right))
    except (OSError, ValueError):
        return False


def upstream_served_profiles(default_home: Path) -> Optional[List[str]]:
    """Hermes's own answer, on the engine that has one. The version seam.

    ``hermes_cli.gateway_multiplex_served.recorded_served_profiles`` is 0.21.3's
    single source for "which profiles does the LIVE default multiplexer serve",
    written for exactly the CLI/dashboard/plugin question this module asks. It
    returns None for "not proved" — no live default gateway, or a record from
    before the multiplexer wrote the key — which is this module's indeterminate.

    Its liveness check resolves the *default root* itself, so it is used only
    when that is the home being asked about; anywhere else the validated file
    read below answers, and it is the only path on 0.21.0–0.21.2 where the
    module does not exist at all.
    """
    try:
        from hermes_constants import get_default_hermes_root

        if not _same_path(get_default_hermes_root(), default_home):
            return None
        from hermes_cli.gateway_multiplex_served import recorded_served_profiles

        served = recorded_served_profiles(Path(default_home))
    except Exception:  # noqa: BLE001 - absent/older engine falls through
        return None
    if not isinstance(served, list):
        return None
    return [n for n in (sanitize_profile_name(item) for item in served) if n is not None]


def read_served_profiles(
    default_home: Optional[Path],
    *,
    capabilities: Optional[EngineCapabilities] = None,
) -> Tuple[Optional[List[str]], str]:
    """``(names, state)`` for the profiles this gateway publishes as served.

    ``names`` is None for every state except :data:`SERVED_STATE_OK`; None
    means *indeterminate*, never *empty*. The validation is
    :mod:`.profiles_report`'s, reused rather than restated:

    * owner — ``hermes_home`` must be this default home, so a record copied
      or inherited from another install is refused;
    * liveness — ``gateway.status.runtime_status_pid_is_live`` applies the
      ``start_time`` PID-reuse guard, so a dead gateway's leftover record
      cannot keep a profile routable;
    * names — Hermes's own profile charset, so nothing that is not a profile
      name can become a route.
    """
    if default_home is None:
        return None, SERVED_STATE_UNKNOWN
    caps = probe_engine_capabilities() if capabilities is None else capabilities
    if caps.served_reader:
        upstream = upstream_served_profiles(Path(default_home))
        if upstream:
            return upstream, SERVED_STATE_OK
    from .profiles_report import _read_json, record_pid_is_live

    record, status = _read_json(Path(default_home) / GATEWAY_STATE_FILENAME)
    if status != "ok" or record is None:
        # "missing" and "unreadable" verbatim from profiles_report._read_json.
        return None, status
    owner = record.get("hermes_home")
    if isinstance(owner, str) and not _same_path(owner, default_home):
        return None, SERVED_STATE_WRONG_OWNER
    if record_pid_is_live(record) is not True:
        return None, SERVED_STATE_STALE
    raw = record.get("served_profiles")
    if not isinstance(raw, list):
        # A LIVE record whose `served_profiles` is missing or not a list is a
        # standalone gateway, not a malformed file.
        return None, SERVED_STATE_ABSENT
    # An EMPTY list is a different shape, and it is authoritative: upstream
    # writes `[]` for a single-profile gateway (`gateway/status.py` documents
    # it as "absent/empty for a single-profile gateway", and
    # `hermes_cli/gateway_multiplex_served.py` reads it as "serves nobody
    # else"). It is reported as OK-with-no-names rather than ABSENT, because
    # the record really did answer the question.
    #
    # It reaches `resolve_routes` only when multiplex is configured ON — a
    # standalone host is refused at the multiplex gate long before this — so in
    # practice `[]` there is the startup window: the multiplexer has stamped a
    # live PID beside an inherited empty set and has not yet run
    # `_record_served_profiles`. The default profile is then missing from the
    # table, which that function treats as indeterminate: retain, and retry
    # sooner. Never "every secondary went away".
    names = [n for n in (sanitize_profile_name(item) for item in raw) if n is not None]
    return names, SERVED_STATE_OK


def running_under_secondary_scope() -> bool:
    """Is a secondary profile's HERMES_HOME override in effect right now?

    Hermes scopes a secondary profile's work with a context-local home override
    (``gateway.run._profile_runtime_scope``), and this resolver is now on hot
    paths reachable from inside one — silent input prediction enters a
    secondary's scope on a worker thread. ``load_gateway_config()`` honours that
    override, so under it the answer describes the SECONDARY's config, not the
    default profile's. A secondary has no ``gateway.multiplex_profiles`` key, so
    believing that read would mean "multiplex is off" from inside a multiplexer.

    Same three helpers ``_guard_secondary_port_binding_scope`` uses.
    """
    try:
        from hermes_constants import (
            get_hermes_home,
            get_hermes_home_override,
            get_process_hermes_home,
        )

        if not get_hermes_home_override():
            return False
        return not _same_path(get_hermes_home(), get_process_hermes_home())
    except Exception:  # noqa: BLE001 - unprobeable means "assume unscoped"
        return False


def read_multiplex_enabled() -> Optional[bool]:
    """``gateway.multiplex_profiles`` as the gateway resolved it.

    None means the gateway config could not be read *for the default profile* —
    indeterminate, which is not the same as "multiplex is off". A secondary
    runtime scope makes the read indeterminate for exactly that reason.
    """
    if running_under_secondary_scope():
        return None
    try:
        from gateway.config import load_gateway_config

        return bool(load_gateway_config().multiplex_profiles)
    except Exception:  # noqa: BLE001
        return None


def enumerate_profile_homes(
    *, capabilities: Optional[EngineCapabilities] = None
) -> Optional[Dict[str, Path]]:
    """``{profile name: home}`` from ``hermes_cli.profiles.profiles_to_serve``.

    The ``profile_allowlist`` keyword is passed only when the running engine's
    signature still has it (0.21.0–0.21.2), so the operator's retired
    gateway-owned enrollment set keeps narrowing the set on those hosts and the
    call does not raise on 0.21.3, which dropped the parameter.
    """
    caps = probe_engine_capabilities() if capabilities is None else capabilities
    try:
        from hermes_cli.profiles import profiles_to_serve

        kwargs: Dict[str, Any] = {"multiplex": True}
        if caps.allowlist_param:
            allowlist = None
            try:
                from gateway.config import load_gateway_config

                allowlist = getattr(
                    load_gateway_config(), "multiplex_profile_allowlist", None
                )
            except Exception:  # noqa: BLE001 - no config, no narrowing
                allowlist = None
            kwargs["profile_allowlist"] = allowlist
        rows = profiles_to_serve(**kwargs)
        homes: Dict[str, Path] = {}
        for name, home in rows:
            canon = sanitize_profile_name(name)
            if canon is None:
                continue
            try:
                homes[canon] = Path(home)
            except (TypeError, ValueError):
                continue
        return homes
    except Exception:  # noqa: BLE001 - indeterminate, never "no profiles"
        return None


def creation_is_incomplete(home: Optional[Path]) -> bool:
    """Is OcuClaw still setting this profile up? (#2942, review race note.)

    Hermes notices a new profile directory as soon as it exists — on 0.21.3
    within a control-socket ping — which can be BEFORE OcuClaw has finished
    writing the inherited settings it promised the wearer. Routing it then
    would hand the wearer a half-built agent and, worse, would make "the
    gateway found a directory" equivalent to "OcuClaw admitted a profile".

    Only a receipt that exists and is readable and is not complete blocks. A
    profile with no receipt was never created through OcuClaw (the wearer made
    it in Hermes), and an unreadable one is not evidence of anything, so
    neither is held back: this gate delays OcuClaw's own creations, it does not
    become a second, accidental enrollment set.

    Deliberate consequence: a creation that came back ``status: "partial"``
    leaves the receipt incomplete, so that profile stays out of the agent list
    until setup is retried and succeeds. That is what the partial result
    already tells the wearer to do ("Retry setup on this same profile"), and
    the retry is the same ``gw.profiles.create`` call with the same request id.
    A half-built agent that is selectable is worse than one that is not yet
    there; surfacing the retry is #2940's enrollment UI to own, not this
    resolver's.
    """
    if home is None:
        return False
    import json

    try:
        raw = (Path(home) / CREATE_RECEIPT_FILENAME).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return False
    try:
        receipt = json.loads(raw)
    except ValueError:
        return False
    return isinstance(receipt, dict) and not receipt.get("complete")


def _directory_home(name: str, *, default_home: Optional[Path]) -> Optional[Path]:
    """``<default>/profiles/<name>``, or the default home for ``default``.

    Hermes's own ``profiles_to_serve`` builds its pairs from exactly these
    directories, and :mod:`.profiles_report` relies on the same rule so the
    doctor can ask a per-profile question without mutating the environment.
    A name with no directory behind it is not a home.
    """
    if default_home is None:
        return None
    candidate = (
        Path(default_home)
        if name == DEFAULT_PROFILE
        else Path(default_home) / PROFILES_DIRNAME / name
    )
    try:
        return candidate if candidate.is_dir() else None
    except OSError:
        return None


# -- resolution ---------------------------------------------------------------


def _apply_admission(
    homes: Mapping[str, Path], admission: Optional[AdmissionPredicate]
) -> Tuple[Dict[str, Path], List[str]]:
    """``(admitted namespaces, incomplete profile names)`` for *homes*.

    Split out so the retained-snapshot path can re-apply the CURRENT policy to
    a previously discovered served set instead of copying a stale admitted
    table. Discovery may legitimately go indeterminate -- a status file being
    rewritten mid-read -- but the enrollment set never does: it is a local,
    cheap read. Copying the old table there would let a just-removed agent stay
    routable for as long as reads stayed indeterminate, which on a host that
    spends time inside a secondary's scope could be indefinitely.
    """
    predicate = admit_every_served_profile if admission is None else admission
    served_names = sorted(homes)
    admitted: Dict[str, Path] = {}
    incomplete: List[str] = []
    for name in served_names:
        if name != DEFAULT_PROFILE:
            # Setup completion first, and outside the predicate: a profile
            # OcuClaw has not finished building is not routable whatever the
            # enrollment policy says, so #2940 cannot re-admit it by accident.
            try:
                if creation_is_incomplete(homes[name]):
                    incomplete.append(name)
                    continue
            except Exception:  # noqa: BLE001 - an unreadable receipt is not routable
                incomplete.append(name)
                continue
            try:
                if not predicate(name, home=homes[name], served=served_names):
                    continue
            except Exception:  # noqa: BLE001 - admission fails CLOSED
                continue
        admitted[namespace_for_profile(name)] = homes[name]
    return admitted, incomplete


def resolve_routes(
    *,
    default_home: Optional[Path] = None,
    capabilities: Optional[EngineCapabilities] = None,
    admission: Optional[AdmissionPredicate] = None,
    now: Optional[float] = None,
) -> RouteSnapshot:
    """One uncached resolution. Pure apart from the host reads it names.

    Order: the multiplex gate, then the live record, then the enumeration.
    Anything indeterminate returns :data:`ROUTE_SOURCE_RETAINED` so a caller
    holding a previous snapshot keeps it; a caller with none fails closed.
    """
    observed_at = time.monotonic() if now is None else now
    multiplex = read_multiplex_enabled()
    if multiplex is None:
        return RouteSnapshot(
            source=ROUTE_SOURCE_RETAINED,
            served_state=SERVED_STATE_UNKNOWN,
            observed_at=observed_at,
        )
    if not multiplex:
        # Determinate: this gateway serves one profile. Narrowing here is the
        # configured truth, not a failed read.
        return RouteSnapshot(
            multiplex=False,
            source=ROUTE_SOURCE_CLOSED,
            served_state=SERVED_STATE_ABSENT,
            observed_at=observed_at,
        )

    caps = probe_engine_capabilities() if capabilities is None else capabilities
    home = resolve_default_home() if default_home is None else default_home
    names, served_state = read_served_profiles(home, capabilities=caps)

    homes: Dict[str, Path] = {}
    if names is not None:
        source = ROUTE_SOURCE_LIVE
        pending = False
        # The record carries NAMES; the homes come from the directory rule,
        # which is the same one upstream's `profiles_to_serve` builds its pairs
        # from. That matters for cost as much as correctness: the enumeration
        # is a directory scan plus a config read per profile, this resolution
        # runs on the gateway's loop, and the live path is the common one — so
        # the enumeration is consulted ONLY for a name the rule cannot place,
        # which is the race where the gateway serves a layout we cannot see.
        unplaced: List[str] = []
        for name in names:
            resolved = _directory_home(name, default_home=home)
            if resolved is None:
                unplaced.append(name)
            else:
                homes[name] = resolved
        if unplaced:
            for name, resolved in (enumerate_profile_homes(capabilities=caps) or {}).items():
                if name in unplaced:
                    homes[name] = resolved
    else:
        # Startup pending, a standalone record, or an unusable one: the
        # enumeration is the boot snapshot, and is what 0.21.0-0.21.2 uses for
        # the life of the process. Here it produced the names, so it is also
        # the authority on where they live.
        enumerated = enumerate_profile_homes(capabilities=caps)
        if enumerated is None:
            return RouteSnapshot(
                source=ROUTE_SOURCE_RETAINED,
                served_state=served_state,
                observed_at=observed_at,
            )
        source = ROUTE_SOURCE_ENUMERATED
        homes = dict(enumerated)
        # Only an engine that republishes the record can converge on it.
        pending = caps.hot_reconcile and served_state in (
            SERVED_STATE_MISSING,
            SERVED_STATE_STALE,
            SERVED_STATE_UNREADABLE,
        )

    if DEFAULT_PROFILE not in homes:
        # Multiplex without the default profile is not a route table this
        # bundle can act on — the default profile owns transport. Indeterminate.
        return RouteSnapshot(
            source=ROUTE_SOURCE_RETAINED,
            served_state=served_state,
            pending=True,
            observed_at=observed_at,
        )

    admitted, incomplete = _apply_admission(homes, admission)

    return RouteSnapshot(
        multiplex=True,
        admitted=admitted,
        source=source,
        served_state=served_state,
        pending=pending,
        observed_at=observed_at,
        served=dict(homes),
        incomplete=frozenset(incomplete),
    )


class ProfileRouteResolver:
    """The shared, TTL-cached resolver both readers hold.

    The cache exists so the hot paths (outbound namespace attribution, session
    flag reads, per-turn home resolution) do not each pay a JSON read. It is
    short enough that a control-socket-driven change is visible effectively at
    once, and :meth:`invalidate` forces the next read to go to the host.
    """

    def __init__(
        self,
        *,
        ttl: float = ROUTE_CACHE_TTL_SECONDS,
        pending_ttl: float = ROUTE_PENDING_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        admission: Optional[AdmissionPredicate] = None,
        resolver: Optional[Callable[..., RouteSnapshot]] = None,
    ) -> None:
        self._ttl = float(ttl)
        self._pending_ttl = float(pending_ttl)
        self._clock = clock
        self._admission: Optional[AdmissionPredicate] = admission
        self._resolve = resolve_routes if resolver is None else resolver
        self._lock = threading.Lock()
        self._snapshot: Optional[RouteSnapshot] = None
        self._read_at: float = 0.0
        self._capabilities: Optional[EngineCapabilities] = None

    # -- the #2940 seam ---------------------------------------------------

    def set_admission(self, predicate: Optional[AdmissionPredicate]) -> None:
        """Install the admission predicate (#2940's enrollment set).

        ``None`` restores :func:`admit_every_served_profile`, today's rule.
        Discovery never calls this: nothing enrols a profile by finding it.
        """
        with self._lock:
            self._admission = predicate
            self._snapshot = None
            self._read_at = 0.0

    def capabilities(self) -> EngineCapabilities:
        """The engine probe, done once per process."""
        with self._lock:
            if self._capabilities is None:
                self._capabilities = probe_engine_capabilities()
            return self._capabilities

    def invalidate(self) -> None:
        """Drop the cache; the next read goes to the host."""
        with self._lock:
            self._read_at = 0.0

    def reset(self) -> None:
        """Forget everything, including the retained snapshot (tests, restart)."""
        with self._lock:
            self._snapshot = None
            self._read_at = 0.0
            self._capabilities = None

    # -- reading ----------------------------------------------------------

    def snapshot(self) -> RouteSnapshot:
        """The current routes, re-reading the host at most once per TTL."""
        now = self._clock()
        with self._lock:
            cached = self._snapshot
            if cached is not None:
                ttl = self._pending_ttl if cached.pending else self._ttl
                if now - self._read_at < ttl:
                    return cached
            capabilities = self._capabilities
            admission = self._admission
        if capabilities is None:
            capabilities = self.capabilities()
        try:
            fresh = self._resolve(
                capabilities=capabilities, admission=admission, now=now
            )
        except Exception:  # noqa: BLE001 - a failed read never drops routes
            fresh = RouteSnapshot(
                source=ROUTE_SOURCE_RETAINED,
                served_state=SERVED_STATE_UNKNOWN,
                observed_at=now,
            )
        with self._lock:
            previous = self._snapshot
            self._read_at = now
            if fresh.source == ROUTE_SOURCE_RETAINED and previous is not None:
                # Indeterminate: keep the last good table, but remember that
                # this read proved nothing so a caller can say so.
                # Keep the last good SERVED set -- that is the part this read
                # failed to prove -- but re-apply the current admission policy
                # to it. Enrollment is not discovery: a removal must bite even
                # while route reads stay indeterminate (#2940).
                if previous.multiplex and previous.served:
                    retained_admitted, retained_incomplete = _apply_admission(
                        dict(previous.served), admission
                    )
                else:
                    retained_admitted = dict(previous.admitted)
                    retained_incomplete = list(previous.incomplete)
                self._snapshot = RouteSnapshot(
                    multiplex=previous.multiplex,
                    admitted=retained_admitted,
                    source=ROUTE_SOURCE_RETAINED,
                    served_state=fresh.served_state,
                    pending=fresh.pending or previous.pending,
                    observed_at=now,
                    served=dict(previous.served),
                    incomplete=frozenset(retained_incomplete),
                )
            else:
                self._snapshot = fresh
            return self._snapshot

    def routes(self) -> Tuple[bool, Dict[str, Path]]:
        """``(multiplex, admitted homes)`` — the readers' historical shape."""
        return self.snapshot().as_tuple()


#: The process-wide resolver. One instance so the adapter and every RPC reader
#: share one cache and one admission predicate.
RESOLVER = ProfileRouteResolver()


def set_admission(predicate: Optional[AdmissionPredicate]) -> None:
    """Install the admission predicate on the shared resolver (#2940)."""
    RESOLVER.set_admission(predicate)


def load_profile_routing_snapshot() -> Tuple[bool, Dict[str, Path]]:
    """Live snapshot of the profiles this gateway can route.

    Kept at its original name and call shape: every existing caller asked for
    ``(multiplex, {namespace: home})`` and still gets it — what changed is that
    the answer is now current instead of frozen at boot.
    """
    return RESOLVER.routes()
