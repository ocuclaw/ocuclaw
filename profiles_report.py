"""The read-only Profiles inventory behind `hermes ocuclaw doctor` (#2944).

SPEC #2939 draws one line through every multi-profile Hermes host: **one
pairing, one relay credential, and the default profile owns transport.**
Secondary profiles are agents, never second relays. Multiplex — one gateway
serving every profile, sessions namespaced ``agent:<profile>:…`` — is the only
supported multi-agent shape for that one pairing.

Nothing in setup, doctor, or the manual has ever told an operator which shape
they are actually in, and Hermes 0.21.3 moves the ground under both: the
served-profile allowlist is retired by config migration 42→43, and
``hermes update`` auto-migrates a host with a secondary gateway (live PID *or
an installed service, even stopped*) onto the multiplexer. The unhandled worst
case is a secondary standalone gateway with OcuClaw installed only there: it
works today as a single-agent island, and the next update folds it, the
adapter guard refuses it, and the glasses go dark with nothing the wearer sees.

This module is the diagnosis half. It is **read-only** by construction:

* it opens no network connection, starts no process, and writes nothing;
* it never mutates ``HERMES_HOME`` or the process environment — every path it
  needs is computed from the default home, so a per-profile question is asked
  by reading that profile's files rather than by pretending to be it (which is
  what Hermes's own ``gateway_migrate._home_env`` does, and what a diagnostic
  must not);
* it never prints a credential **value**, only its presence;
* every Hermes import is guarded, so the section degrades to ``unknown``
  rather than taking the one command an operator runs when things are broken
  down with it.

The collect/derive seam matches the rest of the bundle: :func:`collect` reads
the host, :func:`derive_faults` is pure, and :func:`build_inventory` is the
two of them together. Fault summaries are static text; the only host-derived
strings that reach them are profile names passed through
:func:`_sanitize_profile_name`, which keeps Hermes's own validated charset.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from . import secret_access

PLATFORM_NAME = "ocuclaw"
DEFAULT_PROFILE = "default"
PROFILES_DIRNAME = "profiles"

RELAY_TOKEN_ENV = "OCUCLAW_RELAY_TOKEN"
MULTIPLEX_ENV = "GATEWAY_MULTIPLEX_PROFILES"
#: The one sender id the adapter stamps (health.OCUCLAW_WEARER_USER_ID).
WEARER_USER_ID = "ocuclaw-wearer"
#: Env allowlists Hermes checks for an ocuclaw sender. When either is set,
#: Hermes 0.22 consults only the env lists and never the adapter's in-memory
#: wearer grant (authz_mixin ``_principal_authorized``).
SENDER_ALLOWLIST_ENVS: Tuple[str, ...] = ("GATEWAY_ALLOWED_USERS", "OCUCLAW_ALLOWED_USERS")
#: The Hermes releases whose native admission (``gateway/session_envelope.py``
#: ``_validate_native``) ignores ``authorization_is_upstream``: only 0.22.1.
#: 0.22.0 and 0.22.2 were cut from release/0.22.1, which has no native
#: admission, and 0.22.3 honours the flag again (upstream #139199).
WEARER_GRANT_VERSIONS = frozenset({(0, 22, 1)})

GATEWAY_STATE_FILENAME = "gateway_state.json"
GATEWAY_PID_FILENAME = "gateway.pid"
#: Hermes 0.21.3's migration receipt, written by
#: ``hermes_cli.gateway_migrate.apply_migration`` before its first destructive
#: step. It records time, the previous flag and the secondaries it folded — it
#: does NOT record whether a human or `hermes update` asked for it, so this
#: module reports "migrated on <date>" and never guesses at intent.
MIGRATION_RECEIPT_FILENAME = "gateway_migration.json"

#: The retired gateway-owned enrollment set (0.21.0–0.21.2). Config migration
#: 42→43 deletes it on 0.21.3.
ALLOWLIST_CONFIG_PATH: Tuple[str, ...] = ("gateway", "multiplex_profile_allowlist")
#: The OcuClaw-owned enrollment set #2940 will add. Read when present so this
#: section is already correct on the host that gets it first; absence of BOTH
#: keys is reported as "not bounded" and never silently widened.
ENROLLMENT_CONFIG_PATH: Tuple[str, ...] = (
    "platforms",
    PLATFORM_NAME,
    "extra",
    "profile_allowlist",
)

MODE_MULTIPLEX = "multiplex"
MODE_STANDALONE = "standalone"
MODE_UNKNOWN = "unknown"

#: Hermes derives its gateway service name from HERMES_HOME:
#: ``hermes-gateway`` for the default home, ``hermes-gateway-<profile>`` for a
#: profile under ``<default>/profiles/`` (``hermes_cli.gateway.get_service_name``
#: / ``get_launchd_plist_path``). Both helpers read the *process* home, so
#: calling them per profile would mean mutating the environment. The naming
#: rule is stable and cheap, so the paths are computed here instead and the
#: roots stay injectable for tests.
SERVICE_NAME_BASE = "hermes-gateway"
LAUNCHD_LABEL_BASE = "ai.hermes.gateway"
SYSTEMD_SYSTEM_ROOT = Path("/etc/systemd/system")

#: ``gateway.config._env_multiplex_profiles_override`` vocabulary, mirrored so
#: an override reads the same here as it does in the gateway. Blank or
#: unrecognised is None — NOT False — exactly as upstream documents.
_MULTIPLEX_TRUTHY = frozenset({"1", "true", "yes", "on"})
_MULTIPLEX_FALSY = frozenset({"0", "false", "no", "off"})

#: ``hermes_cli.profiles.validate_profile_name``'s charset.
_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

#: The Hermes release that ships `hermes gateway migrate`.
MIGRATE_COMMAND_MIN_VERSION = (0, 21, 3)

# -- fault vocabulary ---------------------------------------------------------

FAULT_ENABLED_BUT_MISSING = "profile_ocuclaw_enabled_but_missing"
FAULT_OCUCLAW_OUTSIDE_DEFAULT = "ocuclaw_outside_default_profile"
FAULT_SECONDARY_GATEWAY = "secondary_gateway_beside_multiplexer"
FAULT_SECONDARY_TRANSPORT_OWNER = "transport_owner_is_secondary_standalone"
FAULT_MODE_DISAGREEMENT = "profile_mode_disagreement"
FAULT_PROVENANCE_MISSING = "transport_provenance_missing"
FAULT_ALLOWLIST_EXCLUDES_WEARER = "sender_allowlist_excludes_wearer"
FAULT_GATEWAY_ENV_ALLOWLIST_EXCLUDES_WEARER = "gateway_env_allowlist_excludes_wearer"
WARNING_INSTALLED_BUT_DISABLED = "ocuclaw_installed_but_disabled_in_secondary"
#: #6797: a profile still selects the `ocuclaw-agents` delegation backend
#: where OcuClaw is not loaded, so Hermes fails its delegation closed.
FAULT_DELEGATION_BACKEND_STRANDED = "delegation_backend_stranded"

FAULT_CODES: Tuple[str, ...] = (
    FAULT_ENABLED_BUT_MISSING,
    FAULT_OCUCLAW_OUTSIDE_DEFAULT,
    FAULT_SECONDARY_GATEWAY,
    FAULT_SECONDARY_TRANSPORT_OWNER,
    FAULT_MODE_DISAGREEMENT,
    FAULT_PROVENANCE_MISSING,
    FAULT_ALLOWLIST_EXCLUDES_WEARER,
    FAULT_GATEWAY_ENV_ALLOWLIST_EXCLUDES_WEARER,
    WARNING_INSTALLED_BUT_DISABLED,
    FAULT_DELEGATION_BACKEND_STRANDED,
)

SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"


# -- small readers ------------------------------------------------------------


def _sanitize_profile_name(value: Any) -> Optional[str]:
    """A profile name, or None. Nothing else ever reaches rendered text."""
    if not isinstance(value, str):
        return None
    token = value.strip()
    return token if _PROFILE_NAME_RE.match(token) else None


def _names(values: Sequence[str]) -> str:
    return ", ".join(values)


def _read_json(path: Path) -> Tuple[Optional[Dict[str, Any]], str]:
    """``(record, status)`` where status is ok | missing | unreadable.

    Shaped like :func:`receipts._read_json` on purpose: a corrupt file on one
    profile must degrade that profile's row, never the whole report.
    """
    import json

    try:
        # Match Hermes's runtime-status reader; Windows editors may add a BOM.
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return None, "missing"
    except (OSError, UnicodeError):
        return None, "unreadable"
    try:
        record = json.loads(raw)
    except ValueError:
        return None, "unreadable"
    return (record, "ok") if isinstance(record, dict) else (None, "unreadable")


def read_profile_config(home: Path) -> Tuple[Dict[str, Any], bool]:
    """One profile's ``config.yaml`` as a raw mapping, plus readability.

    Hermes's own reader first — it applies the platform's read guards and
    takes an explicit path, so it works against a fixture home without any
    environment mutation. PyYAML is the fallback for a host where the CLI is
    not importable; an unreadable config becomes ``({}, False)`` so every
    derived answer for that profile is `unknown` rather than invented.
    """
    path = home / "config.yaml"
    try:
        from hermes_cli.config import read_user_config_raw

        config = read_user_config_raw(path)
        return (config if isinstance(config, dict) else {}), True
    except Exception:  # noqa: BLE001 - absent/older Hermes falls through
        pass
    try:
        from .yaml_compat import yaml

        if not path.exists():
            return {}, False
        config = yaml.safe_load(path.read_text(encoding="utf-8"))
        return (config if isinstance(config, dict) else {}), True
    except Exception:  # noqa: BLE001 - unreadable becomes unknown, never a guess
        return {}, False


def _dig(config: Mapping[str, Any], path: Sequence[str]) -> Any:
    node: Any = config
    for key in path:
        if not isinstance(node, Mapping):
            return None
        node = node.get(key)
    return node


def env_multiplex_override(env: Mapping[str, str]) -> Optional[bool]:
    """``GATEWAY_MULTIPLEX_PROFILES``, read exactly as the gateway reads it."""
    raw = env.get(MULTIPLEX_ENV)
    if raw is None:
        return None
    token = str(raw).strip().lower()
    if token in _MULTIPLEX_TRUTHY:
        return True
    if token in _MULTIPLEX_FALSY:
        return False
    return None


def relay_credential_present(home: Path) -> Optional[bool]:
    """Whether this profile's own secret store carries a non-empty relay token.

    Presence only. The value is never read into a variable that outlives this
    function, never returned, and never rendered. Read through Hermes's scope
    builder for that profile (catalogue rule 11), without the process
    environment: this process's env belongs to whichever profile launched the
    doctor, not to [home]. ``None`` when the store cannot be read.
    """
    token = secret_access.read_stored_secret(RELAY_TOKEN_ENV, home)
    return None if token is None else bool(token)


def sender_allowlists(home: Path) -> Optional[Dict[str, List[str]]]:
    """The env sender allowlists this profile's own store sets, by name.

    Only :data:`SENDER_ALLOWLIST_ENVS`; an empty value is unset, as Hermes
    reads it. Sender ids are not secrets, but they live in ``.env``, so they
    are read through Hermes's scope builder for [home], never by parsing the
    file, and without the process environment for the same reason as
    :func:`relay_credential_present`. ``None`` when the store cannot be read.
    """
    found: Dict[str, List[str]] = {}
    for key in SENDER_ALLOWLIST_ENVS:
        raw = secret_access.read_stored_secret(key, home)
        if raw is None:
            return None
        ids = _parse_sender_ids(raw)
        if ids:
            found[key] = ids
    return found


#: Hermes' approved-sender files for the ocuclaw platform, current layout then
#: legacy (``gateway/pairing.py``), relative to the profile home.
_APPROVED_SENDER_FILES = (
    "platforms/pairing/ocuclaw-approved.json",
    "pairing/ocuclaw-approved.json",
)


def wearer_sender_approved(home: Path) -> Optional[bool]:
    """Whether Hermes' pairing store approves the wearer in this profile.

    Pairing records it (``sender_approval.py``), and Hermes checks that store
    before the env allowlists, so an approved wearer passes a list that leaves
    it out. Read-only; ``None`` when a store file is unreadable.
    """
    unreadable = False
    for name in _APPROVED_SENDER_FILES:
        try:
            approved = json.loads((home / name).read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, UnicodeError, ValueError):
            unreadable = True
            continue
        if isinstance(approved, dict) and WEARER_USER_ID in approved:
            return True
    return None if unreadable else False


def _parse_sender_ids(raw: str) -> List[str]:
    """One gate value as Hermes's ``_coerce_allow_set`` splits it."""
    raw = raw.strip()
    parts: List[Any] = raw.split(",")
    if raw.startswith("["):  # `hermes config set` writes JSON list literals
        try:
            decoded = json.loads(raw)
        except ValueError:
            decoded = None
        if isinstance(decoded, list):
            parts = decoded
    return [str(part).strip() for part in parts if str(part).strip()]


def gateway_sender_gate() -> Tuple[Optional[bool], Optional[Dict[str, List[str]]]]:
    """``(multiplexed, allowlists)`` as THIS process's sender gate reads them.

    The gateway half of the gateway-environment check: the adapter calls it
    inside the gateway and records the answer in a receipt, because doctor is
    a separate process and cannot read the gateway's environment. Hermes reads
    these gates through ``platform_gate_env``: a single-profile gateway reads
    ``os.environ`` (which already holds the profile's ``.env``, loaded over
    the launch environment at boot), while a multiplexer reads each profile's
    own secrets and ignores the process environment. So lists come back only
    when not multiplexed; ``(None, None)`` when the mode cannot be read.
    Read-only: nothing here changes who is admitted.
    """
    try:
        from agent.secret_scope import is_multiplex_active

        multiplexed = bool(is_multiplex_active())
    except Exception:  # noqa: BLE001 - an unknown mode proves nothing
        return None, None
    if multiplexed:
        return True, None
    found: Dict[str, List[str]] = {}
    for name in SENDER_ALLOWLIST_ENVS:
        raw = os.environ.get(name)
        if raw is None:
            continue
        ids = _parse_sender_ids(str(raw))
        if ids:
            found[name] = ids
    return False, found


def bundle_version(plugin_dir: Path) -> Optional[str]:
    """The installed bundle's declared version, from its own plugin.yaml."""
    try:
        text = (plugin_dir / "plugin.yaml").read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None
    match = re.search(r"^version:\s*([^\s#]+)", text, re.MULTILINE)
    if match is None:
        return None
    token = match.group(1).strip()
    return token if re.match(r"^[A-Za-z0-9._+-]{1,64}$", token) else None


def record_pid_is_live(record: Optional[Mapping[str, Any]]) -> Optional[bool]:
    """PID liveness for a gateway record, through Hermes's own guard first.

    ``gateway.status.runtime_status_pid_is_live`` takes the record explicitly
    (no home, no environment) and applies the ``start_time`` PID-reuse guard,
    so it is usable against another profile's file. Absent Hermes, the
    bundle's own receipt guard answers the same question tri-state.
    """
    if not isinstance(record, Mapping):
        return None
    try:
        from gateway.status import runtime_status_pid_is_live

        return bool(runtime_status_pid_is_live(dict(record)))
    except Exception:  # noqa: BLE001 - cross-process evidence is fail-soft
        pass
    try:
        from .receipts import writer_is_live

        return writer_is_live(record)
    except Exception:  # noqa: BLE001 - a diagnostic never becomes an outage
        return None


def service_paths(
    profile: str,
    *,
    systemd_user_root: Optional[Path],
    systemd_system_root: Optional[Path],
    launchd_root: Optional[Path],
) -> List[Tuple[str, Path]]:
    """The unit / plist paths Hermes would install for ``profile``."""
    suffix = "" if profile == DEFAULT_PROFILE else f"-{profile}"
    unit = f"{SERVICE_NAME_BASE}{suffix}.service"
    plist = f"{LAUNCHD_LABEL_BASE}{suffix}.plist"
    candidates: List[Tuple[str, Path]] = []
    if systemd_user_root is not None:
        candidates.append(("systemd (user)", systemd_user_root / unit))
    if systemd_system_root is not None:
        candidates.append(("systemd (system)", systemd_system_root / unit))
    if launchd_root is not None:
        candidates.append(("launchd", launchd_root / plist))
    return candidates


def default_home_for(home: Optional[Path]) -> Optional[Path]:
    """The DEFAULT profile home for whichever home this process resolved.

    Same shape as :func:`health.profile_name`: a home directly under
    ``<default>/profiles/`` is a secondary, so its default is two levels up.
    Anything else is already the default home.
    """
    if home is None:
        return None
    try:
        if home.parent.name == PROFILES_DIRNAME:
            return home.parent.parent
        return home
    except (OSError, ValueError):
        return None


# -- collection ---------------------------------------------------------------


def collect(
    *,
    default_home: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
    systemd_user_root: Optional[Path] = None,
    systemd_system_root: Optional[Path] = None,
    launchd_root: Optional[Path] = None,
    hermes_version: Optional[str] = None,
    provenance_observed: Optional[bool] = None,
) -> Dict[str, Any]:
    """Read every profile fact this section reports. Mutates nothing.

    ``default_home`` is injectable so a fixture home is observed by exactly
    the code a real host is. ``provenance_observed`` is the one fact this
    process genuinely cannot see: only the gateway holds transport provenance
    for a routed turn, so the CLI passes ``None`` ("not observed from this
    process") and the in-gateway `ocuclaw_setup` caller passes what it knows.
    """
    environment = os.environ if env is None else env
    if default_home is None:
        try:
            from .receipts import resolve_receipt_home

            default_home = default_home_for(resolve_receipt_home())
        except Exception:  # noqa: BLE001 - unresolved home is not an outage
            default_home = None
    if default_home is None:
        return {
            "observed": False,
            "mode": {
                "effective": MODE_UNKNOWN,
                "effectiveSource": "none",
                "configured": None,
                "configuredFromFile": None,
                "envOverride": None,
                "agentMode": None,
            },
            "served": {"state": "unknown", "profiles": []},
            "enrolled": {"state": "unknown", "source": None, "profiles": []},
            "migration": {"state": "unknown"},
            "transport": {
                "credentialProfiles": [],
                "codeProfiles": [],
                "owner": None,
                "provenanceObserved": provenance_observed,
            },
            "profiles": [],
            "hermesVersion": hermes_version,
        }

    if systemd_user_root is None and launchd_root is None and systemd_system_root is None:
        home_dir = Path(os.path.expanduser("~"))
        systemd_user_root = home_dir / ".config" / "systemd" / "user"
        systemd_system_root = SYSTEMD_SYSTEM_ROOT
        launchd_root = home_dir / "Library" / "LaunchAgents"

    if hermes_version is None:
        try:
            from .health import hermes_version as _hermes_version

            hermes_version = _hermes_version() or None
        except Exception:  # noqa: BLE001 - version only changes a fix line
            hermes_version = None

    default_config, default_readable = read_profile_config(default_home)

    # -- mode ----------------------------------------------------------------
    configured_raw = _dig(default_config, ("gateway", "multiplex_profiles"))
    configured_file = configured_raw if isinstance(configured_raw, bool) else None
    override = env_multiplex_override(environment)
    configured = override if override is not None else configured_file
    agent_mode_raw = _dig(default_config, ("platforms", PLATFORM_NAME, "extra", "agent_mode"))
    agent_mode = agent_mode_raw if agent_mode_raw in ("multiple", "single") else None

    # -- the live gateway record --------------------------------------------
    state_record, state_status = _read_json(default_home / GATEWAY_STATE_FILENAME)
    served_state = state_status
    served_profiles: List[str] = []
    default_gateway_live: Optional[bool] = None
    effective = MODE_UNKNOWN
    effective_source = "none"
    if state_status == "ok" and state_record is not None:
        owner = state_record.get("hermes_home")
        if isinstance(owner, str) and not _same_path(owner, default_home):
            served_state = "wrong_owner"
        else:
            live = record_pid_is_live(state_record)
            default_gateway_live = live
            if live is not True:
                served_state = "stale"
            else:
                served_state = "ok"
                raw_served = state_record.get("served_profiles")
                if isinstance(raw_served, list):
                    served_profiles = [
                        name
                        for name in (_sanitize_profile_name(item) for item in raw_served)
                        if name is not None
                    ]
                # It is the CONTENT of `served_profiles`, never its presence,
                # that carries the mode. Upstream says so in its own words:
                # `gateway/status.py` documents the field as "absent/empty for
                # a single-profile gateway", `hermes_cli/
                # gateway_multiplex_served.py` as "an empty list is an
                # authoritative 'serves nobody else'", and
                # `gateway/control_socket.py` gates on `served` being truthy
                # rather than present.
                #
                # A multiplexer always records itself plus its secondaries
                # (`gateway/run_adapters.py::_record_served_profiles` writes
                # `[active] + secondaries`), so a non-empty list is positive
                # evidence of multiplex and a multiplex write is never empty.
                # An EMPTY list on a live record is positive evidence of
                # standalone: 0.21.3 clears the set on a single-profile start
                # precisely so a previous multiplexer's record cannot leak
                # forward. An absent key is the same statement made by an
                # engine that never writes it.
                #
                # Reading presence alone called every standalone 0.21.3 host a
                # multiplexer, because that engine always writes the key.
                #
                # `raw_served`, not the sanitized list: a record whose names
                # all fail the charset is unreadable, not standalone, and the
                # two are different questions.
                if state_record.get("gateway_state") not in ("running", "degraded"):
                    # Live PID, but the record is not authoritative yet. A
                    # starting gateway re-stamps its identity
                    # (`gateway/status.py::write_runtime_status` is
                    # read-modify-write) well before `_record_served_profiles`
                    # runs at the end of the adapter-connect phase, so a
                    # multiplexer that is still booting would present a live
                    # PID beside an inherited empty set. Saying "unknown" for
                    # that window is the honest answer; it closes right after
                    # the restart that `/ocuclaw-setup` itself performs.
                    effective = MODE_UNKNOWN
                    effective_source = "none"
                else:
                    effective = (
                        MODE_MULTIPLEX
                        if isinstance(raw_served, list) and raw_served
                        else MODE_STANDALONE
                    )
                    effective_source = "gateway-state"
    elif state_status == "missing":
        served_state = "missing"

    # -- enrolled set --------------------------------------------------------
    ocuclaw_allowlist = _dig(default_config, ENROLLMENT_CONFIG_PATH)
    gateway_allowlist = _dig(default_config, ALLOWLIST_CONFIG_PATH)
    enrolled: Dict[str, Any] = {"state": "not_bounded", "source": None, "profiles": []}
    if not default_readable:
        enrolled = {"state": "unknown", "source": None, "profiles": []}
    else:
        for source, raw in (
            ("platforms.ocuclaw.extra.profile_allowlist", ocuclaw_allowlist),
            ("gateway.multiplex_profile_allowlist", gateway_allowlist),
        ):
            if raw is None:
                continue
            if not isinstance(raw, list):
                enrolled = {"state": "invalid", "source": source, "profiles": []}
                break
            enrolled = {
                "state": "bounded",
                "source": source,
                "profiles": [
                    name
                    for name in (_sanitize_profile_name(item) for item in raw)
                    if name is not None
                ],
            }
            break

    # -- migration receipt ---------------------------------------------------
    migration = _collect_migration(default_home)

    # -- per-profile rows ----------------------------------------------------
    rows: List[Dict[str, Any]] = [
        _collect_profile(
            DEFAULT_PROFILE,
            default_home,
            config=default_config,
            config_readable=default_readable,
            state_record=state_record if served_state != "wrong_owner" else None,
            gateway_live=default_gateway_live,
            systemd_user_root=systemd_user_root,
            systemd_system_root=systemd_system_root,
            launchd_root=launchd_root,
        )
    ]
    for name in _secondary_profile_names(default_home):
        home = default_home / PROFILES_DIRNAME / name
        config, readable = read_profile_config(home)
        rows.append(
            _collect_profile(
                name,
                home,
                config=config,
                config_readable=readable,
                state_record=None,
                gateway_live=None,
                systemd_user_root=systemd_user_root,
                systemd_system_root=systemd_system_root,
                launchd_root=launchd_root,
            )
        )

    credential_profiles = [row["name"] for row in rows if row["relayCredential"] is True]
    code_profiles = [row["name"] for row in rows if row["codePresent"] is True]
    owner = None
    if len(credential_profiles) == 1:
        owner = credential_profiles[0]
    elif not credential_profiles and len(code_profiles) == 1:
        owner = code_profiles[0]

    return {
        "observed": True,
        "mode": {
            "effective": effective,
            "effectiveSource": effective_source,
            "configured": configured,
            "configuredFromFile": configured_file,
            "envOverride": override,
            "agentMode": agent_mode,
            "optOutRetired": _opt_out_retired(),
        },
        "served": {"state": served_state, "profiles": served_profiles},
        "enrolled": enrolled,
        "migration": migration,
        "transport": {
            "credentialProfiles": credential_profiles,
            "codeProfiles": code_profiles,
            "owner": owner,
            "provenanceObserved": provenance_observed,
            "senderApproved": wearer_sender_approved(default_home),
            "senderAllowlists": sender_allowlists(default_home),
            "gatewayEnv": _collect_gateway_env(default_home),
        },
        "profiles": rows,
        "hermesVersion": hermes_version,
    }


def _same_path(left: Any, right: Any) -> bool:
    try:
        return os.path.realpath(str(left)) == os.path.realpath(str(right))
    except (OSError, ValueError):
        return False


def _secondary_profile_names(default_home: Path) -> List[str]:
    """Every profile directory under ``<default>/profiles/``, sorted.

    Hermes's own ``list_profile_names`` enumerates exactly this directory; it
    is reimplemented here rather than imported because the helper resolves the
    *process* profiles root, which is the wrong one whenever doctor runs from
    a secondary profile — and because a fixture home must be readable without
    a Hermes tree at all.
    """
    root = default_home / PROFILES_DIRNAME
    try:
        entries = sorted(root.iterdir())
    except (OSError, ValueError):
        return []
    names: List[str] = []
    for entry in entries:
        try:
            if not entry.is_dir():
                continue
        except OSError:
            continue
        name = _sanitize_profile_name(entry.name)
        if name is not None and name != DEFAULT_PROFILE:
            names.append(name)
    return names


def _collect_migration(default_home: Path) -> Dict[str, Any]:
    record, status = _read_json(default_home / MIGRATION_RECEIPT_FILENAME)
    if status != "ok" or record is None:
        return {"state": status}
    migrated_at = record.get("migrated_at")
    date = None
    if isinstance(migrated_at, str) and re.match(r"^\d{4}-\d{2}-\d{2}", migrated_at.strip()):
        date = migrated_at.strip()[:10]
    flag_was = record.get("flag_was")
    secondaries: List[str] = []
    raw = record.get("secondaries")
    if isinstance(raw, list):
        for item in raw:
            name = _sanitize_profile_name(
                item.get("profile") if isinstance(item, Mapping) else item
            )
            if name is not None:
                secondaries.append(name)
    return {
        "state": "present",
        "migratedOn": date,
        "flagWas": flag_was if isinstance(flag_was, bool) else None,
        "secondaries": secondaries,
    }


def _collect_gateway_env(default_home: Path) -> Dict[str, Any]:
    """The sender allowlists the live default gateway reads from its process.

    This process cannot see the gateway's environment, so it reads the
    receipt the adapter writes from inside the gateway
    (:func:`gateway_sender_gate`). Only a receipt for this home whose writer
    is still alive counts: a dead gateway's view says nothing about the next
    one. ``senderAllowlists`` is set only when the state is ``observed``.
    """
    try:
        from .receipts import fingerprint_home, read_gateway_sender_gate

        record, status = read_gateway_sender_gate(
            fingerprint_home(default_home), home=default_home
        )
    except Exception:  # noqa: BLE001 - a diagnostic never becomes an outage
        return {"state": "unknown", "senderAllowlists": None}
    if status != "ok" or record is None:
        return {"state": status, "senderAllowlists": None}
    if record_pid_is_live(record) is not True:
        return {"state": "stale", "senderAllowlists": None}
    multiplexed = record.get("multiplexed")
    if multiplexed is True:
        return {"state": "multiplexed", "senderAllowlists": None}
    raw = record.get("senderAllowlists")
    if multiplexed is not False or not isinstance(raw, Mapping):
        return {"state": "unknown", "senderAllowlists": None}
    lists = {
        name: [item for item in ids if isinstance(item, str)]
        for name, ids in raw.items()
        if name in SENDER_ALLOWLIST_ENVS and isinstance(ids, list)
    }
    return {"state": "observed", "senderAllowlists": lists}


def _collect_profile(
    name: str,
    home: Path,
    *,
    config: Mapping[str, Any],
    config_readable: bool,
    state_record: Optional[Mapping[str, Any]],
    gateway_live: Optional[bool],
    systemd_user_root: Optional[Path],
    systemd_system_root: Optional[Path],
    launchd_root: Optional[Path],
) -> Dict[str, Any]:
    enabled_raw = _dig(config, ("plugins", "enabled"))
    if not config_readable:
        plugin_enabled: Optional[bool] = None
    elif isinstance(enabled_raw, list):
        plugin_enabled = PLATFORM_NAME in enabled_raw
    else:
        plugin_enabled = False

    plugin_dir = home / "plugins" / PLATFORM_NAME
    try:
        code_present: Optional[bool] = plugin_dir.is_dir()
    except OSError:
        code_present = None

    if state_record is None and name != DEFAULT_PROFILE:
        # A secondary's own gateway leaves the same two files in its own home.
        record, status = _read_json(home / GATEWAY_STATE_FILENAME)
        if status != "ok":
            record, status = _read_json(home / GATEWAY_PID_FILENAME)
        state_record = record if status == "ok" else None
        gateway_live = record_pid_is_live(state_record)

    service = None
    for label, path in service_paths(
        name,
        systemd_user_root=systemd_user_root,
        systemd_system_root=systemd_system_root,
        launchd_root=launchd_root,
    ):
        try:
            if path.exists():
                service = label
                break
        except OSError:
            continue

    delegation_backend = None
    delegation_previous = None
    if config_readable:
        from . import delegation_handoffs

        delegation = _dig(config, ("delegation",))
        delegation_backend = delegation_handoffs.backend_name(
            delegation.get("backend") if isinstance(delegation, Mapping) else None
        )
        if delegation_backend == delegation_handoffs.BACKEND_NAME:
            delegation_previous = delegation_handoffs.previous_backend(
                delegation_handoffs.own_settings(delegation)
            )

    return {
        "name": name,
        "isDefault": name == DEFAULT_PROFILE,
        "configReadable": config_readable,
        "delegationBackend": delegation_backend,
        "delegationPrevious": delegation_previous,
        "pluginEnabled": plugin_enabled,
        "codePresent": code_present,
        "bundleVersion": bundle_version(plugin_dir) if code_present else None,
        "relayCredential": relay_credential_present(home),
        "gatewayLive": gateway_live is True,
        "service": service,
    }


# -- derivation ---------------------------------------------------------------


def _fault(code: str, severity: str, profiles: Sequence[str], summary: str, fix: str) -> Dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "profiles": list(profiles),
        "summary": summary,
        "fix": fix,
    }


def _version_at_least(hermes_version: Any, minimum: Tuple[int, int, int]) -> bool:
    try:
        from .health import parse_version

        parsed = parse_version(str(hermes_version or ""))
    except Exception:  # noqa: BLE001 - an unreadable version proves nothing
        return False
    return parsed is not None and parsed >= minimum


def _allowlist_can_refuse_wearer(hermes_version: Any) -> bool:
    """True on the Hermes releases whose admission reads only the env
    allowlists for an ocuclaw sender (``WEARER_GRANT_VERSIONS``)."""
    try:
        from .health import parse_version

        parsed = parse_version(str(hermes_version or ""))
    except Exception:  # noqa: BLE001 - an unreadable version proves nothing
        return False
    return parsed in WEARER_GRANT_VERSIONS


def _migrate_fix(hermes_version: Optional[str], profiles: Sequence[str]) -> str:
    """The version-correct repair for a secondary gateway beside a multiplexer."""
    supports_migrate = False
    try:
        from .health import parse_version

        parsed = parse_version(hermes_version or "")
        supports_migrate = parsed is not None and parsed >= MIGRATE_COMMAND_MIN_VERSION
    except Exception:  # noqa: BLE001 - fall back to the always-correct repair
        supports_migrate = False
    if supports_migrate:
        return (
            "Fold it onto the multiplexer — preview first: "
            "`hermes gateway migrate --multiplex --dry-run`, then run it "
            "without --dry-run."
        )
    return (
        "Stop and uninstall that profile's gateway service: "
        + " ; ".join(
            f"`hermes -p {name} gateway stop && hermes -p {name} gateway uninstall`"
            for name in profiles
        )
        + ". This Hermes has no `gateway migrate`; upgrade to 0.21.3 for it."
    )


def _opt_out_retired() -> bool:
    """Does this engine ignore `gateway.multiplex_profiles: false` (#3618)?"""
    try:
        from .setup_profiles import multiplex_opt_out_retired

        return multiplex_opt_out_retired()
    except Exception:  # noqa: BLE001 - only changes a fix line
        return False


def derive_faults(inventory: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Every named fault this inventory proves. Pure; no host access."""
    if not inventory.get("observed"):
        return []
    rows = [row for row in (inventory.get("profiles") or []) if isinstance(row, Mapping)]
    by_name = {str(row.get("name")): row for row in rows}
    default_row = by_name.get(DEFAULT_PROFILE)
    secondaries = [row for row in rows if not row.get("isDefault")]
    mode = inventory.get("mode") or {}
    faults: List[Dict[str, Any]] = []

    # 1. enabled-but-missing. A plain `--clone` (and the Desktop create dialog)
    #    copies config.yaml but not `plugins/`, so the new profile lists
    #    ocuclaw with no code behind it — the reporter's "empty shell". The
    #    repair is to drop the stale entry. Installing OcuClaw there would
    #    create a SECOND relay, which is the one thing this arc forbids.
    #    Scoped to secondaries: on the default, a missing bundle is a broken
    #    install, and the Setup section already names it.
    orphans = [
        str(row["name"])
        for row in secondaries
        if row.get("pluginEnabled") is True and row.get("codePresent") is False
    ]
    if orphans:
        faults.append(
            _fault(
                FAULT_ENABLED_BUT_MISSING,
                SEVERITY_ERROR,
                orphans,
                "These profiles list ocuclaw in plugins.enabled but have no "
                "plugins/ocuclaw/ on disk — a plain profile clone copies the "
                "config without the plugin code.",
                "Remove the stale `ocuclaw` entry from plugins.enabled in "
                + _names(f"profiles/{name}/config.yaml" for name in orphans)
                + ". Do NOT install OcuClaw there: the default profile owns "
                "transport, and a second install is a second relay.",
            )
        )

    # 2. OcuClaw outside the default profile — code that is actually enabled,
    #    or a relay credential. Either one breaks the one-pairing rule.
    outside = sorted(
        {
            str(row["name"])
            for row in secondaries
            if row.get("relayCredential") is True
            or (row.get("codePresent") is True and row.get("pluginEnabled") is True)
        }
    )
    if outside:
        faults.append(
            _fault(
                FAULT_OCUCLAW_OUTSIDE_DEFAULT,
                SEVERITY_ERROR,
                outside,
                "OcuClaw is installed or holds a relay credential outside the "
                "default profile. One wearer is one pairing and one relay "
                "credential, and it lives in the default profile.",
                "Remove it there: "
                + " ; ".join(f"`hermes -p {name} ocuclaw uninstall`" for name in outside)
                + ", and delete OCUCLAW_RELAY_TOKEN from "
                + _names(f"profiles/{name}/.env" for name in outside)
                + ".",
            )
        )

    # 3. A secondary gateway beside a multiplexer. An installed service counts
    #    even when it is stopped: that is exactly what 0.21.3's
    #    `maybe_auto_migrate_after_update` triggers on.
    if mode.get("effective") == MODE_MULTIPLEX or mode.get("configured") is True:
        standalone = [
            str(row["name"])
            for row in secondaries
            if row.get("gatewayLive") is True or row.get("service")
        ]
        if standalone:
            faults.append(
                _fault(
                    FAULT_SECONDARY_GATEWAY,
                    SEVERITY_ERROR,
                    standalone,
                    "These profiles still have their own gateway (a live PID "
                    "or an installed service, stopped or not) while the "
                    "default profile multiplexes. Two gateways for one host "
                    "is the shape OcuClaw cannot route.",
                    _migrate_fix(inventory.get("hermesVersion"), standalone),
                )
            )

    # 4. The reporter's worst case: transport lives in a secondary standalone
    #    gateway. It works today and the next `hermes update` to 0.21.3 folds
    #    it — the adapter guard refuses the secondary construction, the
    #    default profile has no OcuClaw, and the glasses go dark silently.
    if default_row is not None:
        default_has_ocuclaw = (
            default_row.get("codePresent") is True or default_row.get("relayCredential") is True
        )
        default_has_gateway = bool(
            default_row.get("gatewayLive") is True or default_row.get("service")
        )
        islands = [
            str(row["name"])
            for row in secondaries
            if (row.get("codePresent") is True or row.get("relayCredential") is True)
            and (row.get("gatewayLive") is True or row.get("service"))
        ]
        if islands and not default_has_ocuclaw and not default_has_gateway:
            faults.append(
                _fault(
                    FAULT_SECONDARY_TRANSPORT_OWNER,
                    SEVERITY_ERROR,
                    islands,
                    "OcuClaw runs only in a secondary profile with its own "
                    "gateway, and the default profile has neither. This works "
                    "today and will not survive the next update: Hermes 0.21.3 "
                    "folds per-profile gateways onto one multiplexer, the "
                    "adapter refuses to bind from a secondary profile, and the "
                    "glasses go dark with nothing the wearer sees.",
                    "Install OcuClaw in the DEFAULT profile and move the relay "
                    "credential there before updating — `hermes ocuclaw setup` "
                    "on the default profile, then remove the secondary install "
                    "(#2943 automates this ownership move).",
                )
            )

    # 5. Mode disagreement, across every pair that is actually known.
    known: List[Tuple[str, str]] = []
    if mode.get("effective") in (MODE_MULTIPLEX, MODE_STANDALONE):
        known.append(("the live gateway", str(mode["effective"])))
    if isinstance(mode.get("configuredFromFile"), bool):
        known.append(
            (
                "gateway.multiplex_profiles",
                MODE_MULTIPLEX if mode["configuredFromFile"] else MODE_STANDALONE,
            )
        )
    if isinstance(mode.get("envOverride"), bool):
        known.append(
            (
                MULTIPLEX_ENV,
                MODE_MULTIPLEX if mode["envOverride"] else MODE_STANDALONE,
            )
        )
    # #3618: on Hermes 0.21.4+ OcuClaw no longer offers "single agent",
    # whatever the profile count. A saved "single" there is outgrown, not a
    # disagreement: the next setup pass records "multiple" without asking.
    # Leave the stale word out of the agreement check so the doctor does not
    # raise an error the person cannot act on.
    opt_out_retired = bool(mode.get("optOutRetired"))
    single_outgrown = opt_out_retired and mode.get("agentMode") == "single"
    if mode.get("agentMode") in ("multiple", "single") and not single_outgrown:
        known.append(
            (
                "platforms.ocuclaw.extra.agent_mode",
                MODE_MULTIPLEX if mode["agentMode"] == "multiple" else MODE_STANDALONE,
            )
        )
    if len({value for _label, value in known}) > 1:
        if opt_out_retired:
            # #3618: on 0.21.4+ "false" and "single" are not fixes. This
            # Hermes ignores `multiplex_profiles: false` once the host has two
            # profiles (0.21.5 rewrites it), and OcuClaw does not offer
            # single agent there at all. Only the multiplex side can agree.
            fix = (
                "OcuClaw does not offer single agent on Hermes 0.21.4 and "
                "later, which ignores `gateway.multiplex_profiles: false` "
                "once the host has two profiles. Agree on "
                "multiple agents: `hermes config set "
                "gateway.multiplex_profiles true` and `hermes config set "
                "--force platforms.ocuclaw.extra.agent_mode multiple`, unset "
                f"any {MULTIPLEX_ENV} override, then restart the gateway (or "
                "re-run `/ocuclaw-setup`, which does this)."
            )
        else:
            fix = (
                "Pick one mode and make all three agree: "
                "`hermes config set gateway.multiplex_profiles true|false`, "
                f"unset any {MULTIPLEX_ENV} override, and re-run "
                "`/ocuclaw-setup` so platforms.ocuclaw.extra.agent_mode "
                "matches."
            )
        faults.append(
            _fault(
                FAULT_MODE_DISAGREEMENT,
                SEVERITY_ERROR,
                [],
                "The gateway mode is not agreed: "
                + ", ".join(f"{label} says {value}" for label, value in known)
                + ".",
                fix,
            )
        )

    # 6. Missing transport provenance on a routed turn. Only the gateway can
    #    see this, so it fires only when a caller that CAN see it says so. It
    #    is a diagnosis — an unsupported bundle or a restored source that lost
    #    the live transport reference — and never a suggestion to widen
    #    authorization: transport authentication IS the grant (SPEC #2939).
    transport = inventory.get("transport") or {}
    if transport.get("provenanceObserved") is False:
        faults.append(
            _fault(
                FAULT_PROVENANCE_MISSING,
                SEVERITY_ERROR,
                [],
                "A routed turn arrived without transport provenance. The relay "
                "authenticated it, so this is the bundle losing its live "
                "transport reference — an unsupported bundle, or a source "
                "restored outside the supported install.",
                "Reinstall the supported OcuClaw bundle in the default profile "
                "and restart the gateway. Do NOT set OCUCLAW_ALLOWED_USERS: "
                "the relay credential is the grant, and an allow line would "
                "paper over a broken install.",
            )
        )

    # 6b. An env allowlist that leaves the wearer out. Hermes 0.22.1 authorizes
    #     glasses turns through the adapter's in-memory wearer grant, but only
    #     while no env allowlist is set; once one is, Hermes reads the env
    #     lists alone and every glasses message is refused. 0.21.x, 0.22.0,
    #     0.22.2 and 0.22.3+ answer from the delegated relay grant first, so
    #     the fault is 0.22.1's alone (``WEARER_GRANT_VERSIONS``).
    #     A wearer approved in Hermes' pairing store (pairing records it) is
    #     admitted before any env list is read, so the list shuts nobody out.
    allowlists = transport.get("senderAllowlists")
    shadowing = sorted(
        name
        for name, ids in (allowlists.items() if isinstance(allowlists, Mapping) else ())
        if isinstance(ids, list) and WEARER_USER_ID not in ids and "*" not in ids
    )
    if transport.get("senderApproved") is True:
        shadowing = []
    if shadowing and _allowlist_can_refuse_wearer(inventory.get("hermesVersion")):
        # OcuClaw has one sender, so its own list is never needed: remove it.
        # The global list serves other platforms too: add the wearer to it.
        steps = []
        if "OCUCLAW_ALLOWED_USERS" in shadowing:
            steps.append("remove the OCUCLAW_ALLOWED_USERS line")
        if "GATEWAY_ALLOWED_USERS" in shadowing:
            steps.append("add " + WEARER_USER_ID + " to GATEWAY_ALLOWED_USERS")
        faults.append(
            _fault(
                FAULT_ALLOWLIST_EXCLUDES_WEARER,
                SEVERITY_ERROR,
                [DEFAULT_PROFILE],
                "The default profile's .env sets "
                + _names(shadowing)
                + " without the glasses' sender id, so Hermes refuses every "
                "glasses message.",
                "Pair the glasses again: approving the pairing also approves "
                "them in Hermes. Or, in the default profile's .env, "
                + " and ".join(steps)
                + ", then restart the gateway.",
            )
        )

    # 6c. The same refusal from a list this process cannot read: one exported
    #     in the environment the gateway was started in (a shell, a service
    #     unit, a container). A single-profile gateway reads these gates from
    #     its process environment; a multiplexer ignores it, so the adapter
    #     records lists only when not multiplexed, and only a live writer's
    #     view counts. A name 6b already names is left to it: .env wins over
    #     the launch environment at boot, so fixing .env fixes that one. The
    #     repair never widens admission: add the wearer, or drop the list.
    #     A wearer approved in the pairing store passes here too, as in 6b.
    env_lists = allowlists if isinstance(allowlists, Mapping) else None
    gateway_env = transport.get("gatewayEnv")
    gateway_lists = (
        gateway_env.get("senderAllowlists") if isinstance(gateway_env, Mapping) else None
    )
    exported = sorted(
        name
        for name, ids in (gateway_lists.items() if isinstance(gateway_lists, Mapping) else ())
        if name in SENDER_ALLOWLIST_ENVS
        and isinstance(ids, list)
        and WEARER_USER_ID not in ids
        and "*" not in ids
        and name not in shadowing
    )
    if transport.get("senderApproved") is True:
        exported = []
    if (
        exported
        and env_lists is not None
        and _allowlist_can_refuse_wearer(inventory.get("hermesVersion"))
    ):
        # Absent from .env: it comes from the launch environment. Present in
        # .env (and admitting the wearer, or 6b would own it): .env changed
        # after this gateway started, so a restart alone repairs it.
        launch = [name for name in exported if name not in env_lists]
        restarted = [name for name in exported if name in env_lists]
        summary = (
            "The running gateway's environment sets "
            + _names(exported)
            + " without the glasses' sender id, so Hermes refuses every "
            "glasses message."
        )
        if launch:
            summary += (
                " The default profile's .env does not set "
                + _names(launch)
                + ", so it comes from the environment the gateway was "
                "started in."
            )
        if restarted:
            summary += (
                " The default profile's .env admits the wearer in "
                + _names(restarted)
                + " now; the gateway started before that change."
            )
        steps = []
        if "GATEWAY_ALLOWED_USERS" in launch:
            steps.append(
                "add " + WEARER_USER_ID + " to GATEWAY_ALLOWED_USERS, or unset "
                "it if no other platform relies on it"
            )
        if "OCUCLAW_ALLOWED_USERS" in launch:
            steps.append("unset OCUCLAW_ALLOWED_USERS")
        if steps:
            fix = (
                "Pair the glasses again: approving the pairing also approves "
                "them in Hermes. Or, in the environment the gateway starts in "
                "(shell profile, "
                "service unit or container), "
                + " and ".join(steps)
                + ", then restart the gateway."
            )
        else:
            fix = "Restart the gateway so it reads the default profile's .env again."
        faults.append(
            _fault(
                FAULT_GATEWAY_ENV_ALLOWLIST_EXCLUDES_WEARER,
                SEVERITY_ERROR,
                [DEFAULT_PROFILE],
                summary,
                fix,
            )
        )

    # 8. "Asks other agents" left on where OcuClaw is not loaded (#6797).
    #    Hermes fails a missing delegation backend closed: every delegate_task
    #    in that agent is a tool error until the backend is put back. OcuClaw
    #    is loaded for the default profile when it is enabled with its code on
    #    disk, and for a secondary only when that gateway also serves it.
    from .delegation_handoffs import BACKEND_NAME as HANDOFF_BACKEND

    default_loads = bool(
        default_row
        and default_row.get("pluginEnabled") is True
        and default_row.get("codePresent") is True
    )
    # An unknown mode is no proof that a secondary goes unserved.
    standalone = mode.get("effective") == MODE_STANDALONE
    stranded = [
        row
        for row in rows
        if row.get("delegationBackend") == HANDOFF_BACKEND
        and (not default_loads or (not row.get("isDefault") and standalone))
    ]
    if stranded:
        names = [str(row["name"]) for row in stranded]
        commands = []
        for row in stranded:
            previous = str(row.get("delegationPrevious") or "default")
            prefix = "hermes" if row.get("isDefault") else f"hermes -p {row['name']}"
            commands.append(f"`{prefix} config set delegation.backend {previous}`")
        faults.append(
            _fault(
                FAULT_DELEGATION_BACKEND_STRANDED,
                SEVERITY_ERROR,
                names,
                "These agents still hand work to other agents through OcuClaw, "
                "but OcuClaw is not loaded where they run, so Hermes refuses "
                "every delegated task.",
                "Turn off Asks other agents for them on the phone, or put the "
                "previous delegation backend back: " + " ; ".join(commands) + ".",
            )
        )

    # 7. Installed-but-disabled code in a secondary. Not a fault — the adapter
    #    is never constructed for it, so it is not a second listener and not a
    #    port clash. It is dead weight, and cleanup is optional.
    disabled = [
        str(row["name"])
        for row in secondaries
        if row.get("codePresent") is True
        and row.get("pluginEnabled") is False
        and row.get("relayCredential") is not True
    ]
    if disabled:
        faults.append(
            _fault(
                WARNING_INSTALLED_BUT_DISABLED,
                SEVERITY_WARNING,
                disabled,
                "These profiles carry OcuClaw code on disk with the plugin "
                "disabled. Nothing loads it and it is not a second listener — "
                "it is leftover weight from a full profile clone.",
                "Optional cleanup: delete "
                + _names(f"profiles/{name}/plugins/ocuclaw/" for name in disabled)
                + " when you no longer need it.",
            )
        )

    return faults


def build_inventory(**kwargs: Any) -> Dict[str, Any]:
    """Collect the host's profile facts and name every fault they prove."""
    inventory = collect(**kwargs)
    inventory["faults"] = derive_faults(inventory)
    return inventory


__all__ = [
    "DEFAULT_PROFILE",
    "FAULT_CODES",
    "FAULT_ENABLED_BUT_MISSING",
    "FAULT_GATEWAY_ENV_ALLOWLIST_EXCLUDES_WEARER",
    "FAULT_MODE_DISAGREEMENT",
    "FAULT_OCUCLAW_OUTSIDE_DEFAULT",
    "FAULT_PROVENANCE_MISSING",
    "FAULT_SECONDARY_GATEWAY",
    "FAULT_SECONDARY_TRANSPORT_OWNER",
    "MODE_MULTIPLEX",
    "MODE_STANDALONE",
    "MODE_UNKNOWN",
    "SEVERITY_ERROR",
    "SEVERITY_WARNING",
    "WARNING_INSTALLED_BUT_DISABLED",
    "build_inventory",
    "collect",
    "default_home_for",
    "derive_faults",
    "gateway_sender_gate",
]
