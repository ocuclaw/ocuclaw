"""Setup-time profile enforcement for `/ocuclaw-setup` (#2943, SPEC #2939).

`profiles_report` (#2944) answers "what shape is this host in?" for `doctor`.
This module answers the three questions setup has to settle *before* it
changes anything, and it answers them from the same inventory so a fault the
doctor names and a refusal setup prints can never disagree:

1. **May setup run here at all?** One wearer is one pairing and one relay
   credential, and it lives in the DEFAULT profile. A setup run invoked
   against a secondary profile is refused and told which profile owns
   transport. That holds even when the secondary is a perfectly healthy
   standalone island today, because the next `hermes update` to 0.21.3 folds
   per-profile gateways onto one multiplexer, the adapter refuses to bind
   from a secondary, and the glasses go dark (SPEC "the worst case").

2. **How does this engine turn on multiple agents?** Hermes 0.21.3 ships
   `hermes gateway migrate`, which moves cron and channels onto one process
   with a preview. Hermes 0.21.0 to 0.21.2 have only the config flag. The
   difference is detected by **probing the engine**, never by comparing a
   version string: a version string is a label a host can be wrong about,
   and this decision writes to a live gateway. Either way, a secondary
   gateway — live PID *or* an installed service, stopped or not — blocks a
   bare flag flip, because that is exactly the shape 0.21.3's
   `maybe_auto_migrate_after_update` acts on.

3. **Does transport need to move?** The reporter's shape is OcuClaw's code
   and relay credential living in a secondary profile. :func:`move_plan` and
   :func:`apply_move` relocate them to the default profile *preserving the
   credential byte for byte* — a regenerated credential is every paired
   phone disconnected, silently.

Everything here is pure or takes an injected home, so a fixture directory is
observed by exactly the code a real host is. No function in this module ever
reads a credential value into anything it returns, prints, or logs.

Single versus multiple agents stays a product choice. The mechanism words
("multiplex", "gateway", "profile") may appear in the operator-facing report;
they may never appear in a :data:`SAY_PREFIX` line, which is the sentence the
assistant is allowed to put in front of the user.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import importlib.util
from pathlib import Path
import re
import shutil
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .profiles_report import (
    DEFAULT_PROFILE,
    FAULT_OCUCLAW_OUTSIDE_DEFAULT,
    FAULT_SECONDARY_GATEWAY,
    FAULT_SECONDARY_TRANSPORT_OWNER,
    PLATFORM_NAME,
    PROFILES_DIRNAME,
    RELAY_TOKEN_ENV,
    default_home_for,
)
from .relay_credential import RELAY_CREDENTIAL_MARKER_FILENAME

# -- the sentence the user is allowed to hear ---------------------------------

#: Lines the assistant may quote to the user. Everything else in a rendered
#: report is operator/agent detail. The ratchet asserts no mechanism word ever
#: reaches one of these, which is how "never ask the user to understand
#: multiplexing" survives a later edit.
SAY_PREFIX = "  say: "

#: Words that describe the mechanism rather than the product. None of these
#: may appear in a `say:` line.
MECHANISM_WORDS: Tuple[str, ...] = (
    "multiplex",
    "multiplexer",
    "gateway.multiplex_profiles",
    "allowlist",
    "GATEWAY_MULTIPLEX_PROFILES",
)

# -- invocation verdicts ------------------------------------------------------

VERDICT_PROCEED = "setup_may_proceed"
VERDICT_SECONDARY_INVOCATION = "setup_invoked_in_secondary_profile"
VERDICT_HOME_UNRESOLVED = "setup_home_unresolved"

# -- migration gates ----------------------------------------------------------

#: No secondary profile exists, so "multiple agents" needs no migration at all.
GATE_NOT_NEEDED = "migration_not_needed"
#: This engine has `hermes gateway migrate`: preview, then apply.
GATE_MIGRATE_COMMAND = "migration_via_gateway_migrate"
#: This engine has only the config flag, and nothing blocks flipping it.
GATE_FLAG_FLIP = "migration_via_flag_flip"
#: A secondary gateway or installed service is in the way and this engine has
#: no migrate command to fold it. Refuse until it is stopped and uninstalled.
GATE_BLOCKED = "migration_blocked_by_secondary_gateway"
#: Multiple agents are already on.
GATE_ALREADY = "migration_already_multiplex"

# -- engine capability probe --------------------------------------------------

#: The module Hermes 0.21.3 added for `hermes gateway migrate`. Absent at
#: 0.21.1, along with its `gateway_migrate_guards` / `profile_channels`
#: siblings, so its mere resolvability separates the two engines.
MIGRATE_MODULE = "hermes_cli.gateway_migrate"
#: Callables that module must expose for the command to be real rather than a
#: half-landed import. Probed with `getattr`, so an upstream rename is a miss
#: — the safe direction — not a crash.
MIGRATE_ATTRS: Tuple[str, ...] = (
    "cmd_migrate",
    "build_migration_plan",
    "apply_migration",
)
#: The module's own command constant. Matching it exactly is the strongest
#: confirmation available: it proves both the module and the spelling this
#: bundle is about to hand the user.
MIGRATE_COMMAND_ATTR = "MIGRATE_COMMAND"

#: `hermes_cli.config_migrations` step 42→43 retires
#: `gateway.multiplex_profile_allowlist`, so an ENGINE whose shipped default
#: config is at 43 or later is an engine that has the migrate command.
MULTIPLEX_MIGRATION_CONFIG_VERSION = 43
#: Where the engine declares that number. NOT the on-disk value: a 0.21.3
#: engine sitting on a config it has not migrated yet still reads 41, so the
#: on-disk number answers "has this config been migrated", never "can this
#: engine migrate". Mixing the two was the trap this constant exists to name.
CONFIG_DEFAULTS_MODULE = "hermes_cli.config_defaults"
CONFIG_VERSION_KEY = "_config_version"

PROBE_COMMAND_CONSTANT = "command_constant"
PROBE_ATTRIBUTE = "attribute"
PROBE_MODULE = "module"
PROBE_ENGINE_SCHEMA = "engine_schema"
PROBE_NONE = "none"

MIGRATE_COMMAND = "hermes gateway migrate --multiplex"
MIGRATE_DRY_RUN_COMMAND = "hermes gateway migrate --multiplex --dry-run"
#: Applying needs `--yes`: without it the command prompts at a TTY the setup
#: assistant does not have. The user's consent is taken in the chat first.
MIGRATE_APPLY_COMMAND = "hermes gateway migrate --multiplex --yes"
#: Upstream's rollback on 0.21.3 only. 0.21.4 removed `--standalone` ("there
#: is no rollback command"), so it is offered only where the opt-out is still
#: honoured (:func:`multiplex_opt_out_retired`, #3617).
MIGRATE_ROLLBACK_COMMAND = "hermes gateway migrate --standalone"

#: `hermes gateway migrate --dry-run` exits **0 even when the plan is
#: blocked** (0.21.3 `gateway_migrate.cmd_migrate`: the `--dry-run` branch
#: returns before the blocked branch that would exit 1). Anything that reads
#: the dry run therefore has to read its TEXT for this heading; a zero exit
#: proves only that the preview ran.
DRY_RUN_BLOCKERS_HEADING = "✗ Blockers"
#: The dry run's other two headings, so a reader can tell a step from a
#: consequence.
DRY_RUN_STEPS_HEADING = "Steps:"
DRY_RUN_NOTICES_HEADING = "Notices:"

#: The config keys setup writes for each branch. `multiplex_profile_allowlist`
#: is deliberately absent: it is retired on 0.21.3 and #2940 owns the
#: OcuClaw-side enrollment set that replaces it.
FLAG_KEY = "gateway.multiplex_profiles"
AGENT_MODE_KEY = f"platforms.{PLATFORM_NAME}.extra.agent_mode"

#: Hermes 0.21.4 retired the single-gateway opt-out: an explicit
#: `gateway.multiplex_profiles: false` is ignored once a host has two
#: profiles, and 0.21.5 also rewrites it to `true` at boot (#3618). With one
#: profile it still holds, but there "single" only greys the phone's "+", and
#: most people want to create agents. So OcuClaw never offers "single agent"
#: on a retired engine, whatever the profile count (Matty, 2026-09-25). The
#: module and its reason constant exist only on engines that retire the
#: opt-out.
MULTIPLEX_MODE_MODULE = "hermes_cli.gateway_multiplex_mode"
RETIRED_OPT_OUT_ATTR = "RETIRED_OPT_OUT_REASON"

_OPT_OUT_RETIRED_CACHE: Dict[str, bool] = {}


def multiplex_opt_out_retired(
    *, import_module: Optional[Callable[[str], Any]] = None
) -> bool:
    """Whether THIS ENGINE has retired `gateway.multiplex_profiles: false`.

    A code probe, like :func:`migrate_capability`: the upstream module that
    retires the opt-out carries the reason it prints. An unreadable probe is
    "not retired", which keeps the pre-0.21.4 behaviour every older engine
    needs. The engine cannot change under a running process, so the default
    probe is answered once.
    """
    if import_module is None and "default" in _OPT_OUT_RETIRED_CACHE:
        return _OPT_OUT_RETIRED_CACHE["default"]
    import_fn = importlib.import_module if import_module is None else import_module
    try:
        module = import_fn(MULTIPLEX_MODE_MODULE)
        retired = isinstance(getattr(module, RETIRED_OPT_OUT_ATTR, None), str)
    except Exception:  # noqa: BLE001 - an absent module is an older engine
        retired = False
    if import_module is None:
        _OPT_OUT_RETIRED_CACHE["default"] = retired
    return retired


def single_agent_available(*, opt_out_retired: bool) -> bool:
    """Does OcuClaw offer "single agent" on this engine (#3618)?

    Only on Hermes 0.21.1-0.21.3. On 0.21.4+ the question is never asked,
    whatever the profile count, and "multiple" is recorded silently.
    """
    return not opt_out_retired


def agent_mode_recorded(
    agent_mode: Any,
    multiplex: Any,
    *,
    opt_out_retired: bool,
) -> bool:
    """Is the agent-mode choice recorded, with the gateway switch agreeing?

    One rule for setup status, the doctor and the Cloudways ladder. "single"
    counts only before Hermes 0.21.4. A "single" recorded earlier on an
    engine that has since become 0.21.4+ is not a choice any more; the next
    setup pass records "multiple" without asking.
    """
    if not isinstance(multiplex, bool):
        return False
    if agent_mode == "multiple":
        return multiplex is True
    if agent_mode == "single":
        return multiplex is False and single_agent_available(
            opt_out_retired=opt_out_retired
        )
    return False


def _engine_schema_version(
    import_module: Callable[[str], Any],
) -> Optional[int]:
    """The schema version THIS ENGINE ships, from its own defaults module.

    0.21.1 declares 41 and 0.21.3 declares 44, and the 42→43 step is the one
    that retires the allowlist, so `>= 43` separates them. This is an engine
    fact, unlike the number in the user's `config.yaml`.
    """
    try:
        defaults = import_module(CONFIG_DEFAULTS_MODULE)
        raw = getattr(defaults, "DEFAULT_CONFIG", {}).get(CONFIG_VERSION_KEY)
    except Exception:  # noqa: BLE001 - an unreadable engine is "not available"
        return None
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    return raw


def config_is_post_allowlist(config: Optional[Mapping[str, Any]]) -> Optional[bool]:
    """Whether THIS CONFIG has already had the allowlist migrated away.

    Deliberately separate from :func:`migrate_capability`. The on-disk
    `_config_version` answers "did the 42→43 step already run here", which
    decides whether a `gateway.multiplex_profile_allowlist` still means
    anything — and nothing else. It must never be read as an engine
    capability: a 0.21.3 engine on a config it has not yet migrated still
    reads 41, and every 0.21.3 host that HAS migrated reads 44, so 43 never
    appears alone in any shipped release.
    """
    raw = (config or {}).get(CONFIG_VERSION_KEY)
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    return raw >= MULTIPLEX_MIGRATION_CONFIG_VERSION


def migrate_capability(
    *,
    find_spec: Optional[Callable[[str], Any]] = None,
    import_module: Optional[Callable[[str], Any]] = None,
) -> Dict[str, Any]:
    """Whether this engine has `hermes gateway migrate`, and how we know.

    Four probes, strongest first, and **not one of them reads a version
    string**. A host can report any version it likes — a fork, a dev
    checkout, a half-applied update — and this decision ends in a write to a
    live gateway, so the question asked is always "is the code there?"

    * `hermes_cli.gateway_migrate.MIGRATE_COMMAND` equals the exact command
      this bundle is about to hand the user. That proves the module, the
      entry point and the spelling in one comparison;
    * failing that, one of its documented callables is callable, which
      separates a real command from a stub;
    * failing that, the module merely resolves;
    * failing that, the ENGINE's own shipped schema version is at 43 or
      later, which only an engine carrying the 42→43 step declares.

    An unreadable or absent probe is "not available" — never "available".
    A false positive runs a command that does not exist against a host
    mid-setup; a false negative only routes to the flag-flip branch, which
    works on every supported Hermes.
    """
    spec_fn = importlib.util.find_spec if find_spec is None else find_spec
    import_fn = importlib.import_module if import_module is None else import_module

    module_present = False
    try:
        module_present = spec_fn(MIGRATE_MODULE) is not None
    except Exception:  # noqa: BLE001 - a missing parent package raises here
        module_present = False

    attribute: Optional[str] = None
    command_constant: Optional[str] = None
    importable = False
    if module_present:
        try:
            module = import_fn(MIGRATE_MODULE)
        except Exception:  # noqa: BLE001 - an import error is "not available"
            module = None
        if module is not None:
            importable = True
            raw = getattr(module, MIGRATE_COMMAND_ATTR, None)
            if isinstance(raw, str):
                command_constant = raw
            for name in MIGRATE_ATTRS:
                if callable(getattr(module, name, None)):
                    attribute = name
                    break

    engine_schema = _engine_schema_version(import_fn)

    if command_constant == MIGRATE_COMMAND:
        probe = PROBE_COMMAND_CONSTANT
        evidence = (
            f"{MIGRATE_MODULE}.{MIGRATE_COMMAND_ATTR} is exactly "
            f"`{MIGRATE_COMMAND}`"
        )
    elif attribute is not None:
        probe, evidence = PROBE_ATTRIBUTE, f"{MIGRATE_MODULE}.{attribute} is callable"
    elif importable:
        # `importable`, not `module_present`: a spec that resolves but whose
        # import raises is a broken or vendored tree, and answering
        # "available" there sends the assistant to run a command that is not
        # going to work — the exact false positive this function refuses.
        probe, evidence = PROBE_MODULE, f"{MIGRATE_MODULE} resolves on this engine"
    elif engine_schema is not None and engine_schema >= MULTIPLEX_MIGRATION_CONFIG_VERSION:
        probe = PROBE_ENGINE_SCHEMA
        evidence = (
            f"this engine ships config schema {engine_schema}, at or past "
            f"{MULTIPLEX_MIGRATION_CONFIG_VERSION}"
        )
    else:
        probe, evidence = PROBE_NONE, f"{MIGRATE_MODULE} is absent on this engine"

    return {
        "available": probe != PROBE_NONE,
        "probe": probe,
        "evidence": evidence,
        "moduleResolves": module_present,
        "moduleImportable": importable,
        "attribute": attribute,
        "commandConstant": command_constant,
        "engineSchemaVersion": engine_schema,
    }


# -- 1. may setup run here? ---------------------------------------------------


def invocation_verdict(
    *,
    process_home: Optional[Path],
    default_home: Optional[Path] = None,
) -> Dict[str, Any]:
    """Refuse a setup run that is not pointed at the default profile.

    ``process_home`` is whatever `HERMES_HOME` / `hermes -p <name>` resolved
    for THIS process. A home directly under ``<default>/profiles/`` is a
    secondary — the same rule `health.profile_name` uses — and setup refuses
    there whether or not a multiplexer is running, because a standalone
    secondary island is precisely the shape that dies on the next auto-fold.
    """
    if process_home is None:
        return {
            "verdict": VERDICT_HOME_UNRESOLVED,
            "mayProceed": False,
            "profile": None,
            "defaultProfile": DEFAULT_PROFILE,
            "defaultHome": None,
            "reason": (
                "The Hermes profile for this process could not be resolved, "
                "so setup cannot prove it is running on the profile that owns "
                "transport."
            ),
            "reenter": None,
        }

    resolved_default = default_home_for(process_home) if default_home is None else default_home
    try:
        is_secondary = process_home.parent.name == PROFILES_DIRNAME
        name = process_home.name if is_secondary else DEFAULT_PROFILE
    except (OSError, ValueError):
        is_secondary, name = False, DEFAULT_PROFILE

    if not is_secondary:
        return {
            "verdict": VERDICT_PROCEED,
            "mayProceed": True,
            "profile": DEFAULT_PROFILE,
            "defaultProfile": DEFAULT_PROFILE,
            "defaultHome": str(resolved_default) if resolved_default else None,
            "reason": "This is the default profile, which owns the wearer's pairing.",
            "reenter": None,
        }

    return {
        "verdict": VERDICT_SECONDARY_INVOCATION,
        "mayProceed": False,
        "profile": name,
        "defaultProfile": DEFAULT_PROFILE,
        "defaultHome": str(resolved_default) if resolved_default else None,
        "reason": (
            f"Setup was invoked against the `{name}` profile. The "
            f"`{DEFAULT_PROFILE}` profile owns the wearer's pairing and the "
            "one relay credential; a second install here is a second relay, "
            "and on the next Hermes update this profile's gateway is folded "
            "away and the glasses go dark with nothing the wearer sees."
        ),
        "reenter": f"hermes -p {DEFAULT_PROFILE} ocuclaw setup-preflight",
        "fault": FAULT_OCUCLAW_OUTSIDE_DEFAULT,
    }


# -- 2. / 3. what does turning on multiple agents take here? ------------------


def _secondary_rows(inventory: Mapping[str, Any]) -> List[Mapping[str, Any]]:
    return [
        row
        for row in (inventory.get("profiles") or [])
        if isinstance(row, Mapping) and not row.get("isDefault")
    ]


def _own_gateway_blockers(rows: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """Every secondary that owns a gateway, live PID or installed service.

    An installed-but-stopped service counts. Hermes 0.21.3's
    `maybe_auto_migrate_after_update` triggers on exactly that, so a host that
    looks quiet today is one `hermes update` away from being folded.
    """
    blockers: List[Dict[str, Any]] = []
    for row in rows:
        name = str(row.get("name") or "")
        if not name:
            continue
        live = row.get("gatewayLive") is True
        service = row.get("service")
        if not live and not service:
            continue
        blockers.append(
            {
                "profile": name,
                "gatewayLive": live,
                "service": service if isinstance(service, str) else None,
                "detail": (
                    f"`{name}` is running its own gateway right now"
                    if live
                    else f"`{name}` has a gateway service installed ({service}); "
                    "stopped still counts"
                ),
                "stop": f"hermes -p {name} gateway stop",
                "uninstall": f"hermes -p {name} gateway uninstall",
            }
        )
    return blockers


def migration_plan(
    inventory: Mapping[str, Any],
    *,
    capability: Mapping[str, Any],
    opt_out_retired: bool = False,
) -> Dict[str, Any]:
    """What "multiple agents" costs on THIS host and THIS engine.

    Returns the gate, the blockers in the operator's words, the exact
    commands for the selected branch, and the one plain sentence the
    assistant may say to the user.
    """
    if not inventory.get("observed"):
        return {
            "gate": GATE_BLOCKED,
            "mayProceed": False,
            "secondaries": [],
            "blockers": [],
            "commands": [],
            "say": (
                "I could not read this computer's agent setup, so I will not "
                "change it yet."
            ),
            "capability": dict(capability),
        }

    rows = _secondary_rows(inventory)
    names = sorted(str(row.get("name")) for row in rows if row.get("name"))
    blockers = _own_gateway_blockers(rows)
    mode = inventory.get("mode") or {}
    live_multiplex = mode.get("effective") == "multiplex"
    # The flag being set is not the same as it being in force: a config write
    # without the restart leaves the running gateway standalone. Saying
    # "already on" there would skip the restart that actually turns it on.
    flag_only = not live_multiplex and mode.get("configured") is True
    already = live_multiplex or flag_only

    if already:
        gate, may = GATE_ALREADY, True
        commands = [f"hermes config set --force {AGENT_MODE_KEY} multiple"]
        if flag_only:
            commands.append("hermes gateway restart")
            say = (
                "Multiple agents are switched on for this computer but not "
                "running yet — Hermes needs a restart to pick it up."
            )
        else:
            say = "Multiple agents are already switched on for this computer."
    elif not names:
        gate, may = GATE_NOT_NEEDED, True
        commands = [
            f"hermes config set --force {FLAG_KEY} true",
            f"hermes config set --force {AGENT_MODE_KEY} multiple",
        ]
        say = (
            "This computer has one agent today, so switching on multiple "
            "agents changes nothing else."
        )
    elif capability.get("available"):
        gate, may = GATE_MIGRATE_COMMAND, True
        commands = [
            MIGRATE_DRY_RUN_COMMAND,
            MIGRATE_APPLY_COMMAND,
            f"hermes config set --force {AGENT_MODE_KEY} multiple",
        ]
        say = (
            "You already have other agents on this computer. Bringing them "
            "together means their scheduled jobs and message connections start "
            "running in one place — I will show you exactly what changes "
            "before anything moves"
            + (
                "." if opt_out_retired else ", and it can be undone."
            )
        )
    elif blockers:
        gate, may = GATE_BLOCKED, False
        commands = [
            command
            for blocker in blockers
            for command in (blocker["stop"], blocker["uninstall"])
        ]
        say = (
            "Some of your other agents run their own background service. This "
            "version of Hermes cannot bring them together safely, so those "
            "need to be switched off first — or update Hermes and I can do it "
            "for you."
        )
    else:
        gate, may = GATE_FLAG_FLIP, True
        commands = [
            f"hermes config set --force {FLAG_KEY} true",
            f"hermes config set --force {AGENT_MODE_KEY} multiple",
        ]
        say = (
            "You have other agents on this computer and none of them runs its "
            "own background service, so switching on multiple agents is safe "
            "here."
        )

    return {
        "gate": gate,
        "mayProceed": may,
        "secondaries": names,
        "blockers": blockers,
        "blockerFault": FAULT_SECONDARY_GATEWAY if blockers else None,
        "commands": commands,
        "say": say,
        "capability": dict(capability),
        # Named on every migrate-command plan so no caller has to remember it:
        # a dry run exits 0 whether or not it found blockers.
        "dryRunExitIsNotAVerdict": gate == GATE_MIGRATE_COMMAND,
        "blockersHeading": (
            DRY_RUN_BLOCKERS_HEADING if gate == GATE_MIGRATE_COMMAND else None
        ),
        # 0.21.4+ has no rollback (#3617): never promise one there.
        "rollback": (
            MIGRATE_ROLLBACK_COMMAND
            if gate == GATE_MIGRATE_COMMAND and not opt_out_retired
            else None
        ),
    }


# -- 4. the ownership move ----------------------------------------------------

#: Files OcuClaw owns under ``<home>/state``. Read against
#: `uninstall.PROFILE_STATE_FILES`: anything the uninstall removes from a
#: profile is state this move has to carry, or the move silently drops the
#: pairing it promised to preserve.
#: State files only. `uninstall.PROFILE_STATE_FILES` also lists the hidden
#: lock sidecars beside these receipts; those are deliberately left behind —
#: a lock describes a process that is not running any more, and carrying one
#: into the default profile would be moving a stale claim, not pairing state.
MOVED_STATE_FILES: Tuple[str, ...] = (
    "ocuclaw.app-presence.json",
    "ocuclaw.desktop-credentials.json",
    "ocuclaw.desktop-pairing-activation.json",
    "ocuclaw.desktop-presenter-capability.json",
    "ocuclaw.first-run-phone-candidate.json",
    "ocuclaw.first-run-proof-attempt.json",
    "ocuclaw.first-run-proof.json",
    "ocuclaw.first-run-reply-delivery.json",
    "ocuclaw.pairing-completion.json",
    "ocuclaw.relay-credential.json",
    "ocuclaw.tui-pairing-capability.json",
)

#: The per-profile runtime state directory (`<home>/ocuclaw`). Device key and
#: device token live here; they are pairing state, so they move too.
RUNTIME_STATE_DIRNAME = PLATFORM_NAME

#: `hermes_cli.profiles.validate_profile_name`'s charset, mirrored so a
#: `--from` value is checked before it is ever joined to a path.
PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

MOVE_OK = "move_ready"
MOVE_APPLIED = "move_applied"
#: A step raised mid-move. Because the default profile is populated before
#: the secondary is stood down, this is always a duplicate and never a gap —
#: but the operator is still told exactly how far it got.
MOVE_PARTIAL = "move_partial"
MOVE_NOT_NEEDED = "move_not_needed"
MOVE_REFUSED_GATEWAY_LIVE = "move_refused_gateway_live"
MOVE_REFUSED_CREDENTIAL_CONFLICT = "move_refused_credential_conflict"
MOVE_REFUSED_UNKNOWN_PROFILE = "move_refused_unknown_profile"


def _read_env(path: Path) -> Tuple[List[str], str]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return [], "missing"
    except (OSError, UnicodeError):
        return [], "unreadable"
    return text.splitlines(), "ok"


#: Which assignments a `.env` line defines, mirroring Hermes's own
#: ``hermes_cli.config._env_line_defines_key``. ``load_env()`` accepts the
#: bash-compatible ``export KEY=value`` form, so anything that removes or
#: compares a key has to recognise it too. Missing it is not a cosmetic bug:
#: a "removed" line that this pattern does not match survives, and the value
#: resurrects on the next load.
_ENV_ASSIGNMENT_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


def _env_line_key(line: str) -> Optional[str]:
    """The key this line assigns, or None for a comment/blank/other line."""
    if line.lstrip().startswith("#"):
        return None
    match = _ENV_ASSIGNMENT_RE.match(line)
    return match.group(1) if match is not None else None


def _env_line_for(lines: Sequence[str], key: str) -> Optional[str]:
    """The **raw** line assigning ``key``, verbatim.

    Carrying the line rather than a parsed value is what makes "the
    credential is carried across unchanged" literally true: quoting, the
    `export` prefix and any spacing survive the move exactly as the user's
    Hermes wrote them. Reserializing a parsed value silently turned
    ``TOKEN="a b"`` into ``TOKEN=a b``, which is a different credential.
    """
    for line in lines:
        if _env_line_key(line) == key:
            return line
    return None


def _env_value(lines: Sequence[str], key: str) -> Optional[str]:
    """``key``'s value, normalised only enough to COMPARE two profiles.

    Used for one question — "are these the same credential?" — so quoting
    differences must not read as a conflict. Never written back anywhere and
    never printed; the raw line is what moves.
    """
    line = _env_line_for(lines, key)
    if line is None:
        return None
    _name, _, value = line.partition("=")
    return value.strip().strip("'\"").strip()


def _without_key(lines: Sequence[str], key: str) -> List[str]:
    return [line for line in lines if _env_line_key(line) != key]


def _credential_fingerprint(value: Optional[str]) -> Optional[str]:
    """A short, one-way name for a credential nobody may print.

    The receipt has to say *which* credential was dropped — "a credential was
    removed" is not something an operator can check against anything — and a
    truncated SHA-256 says that without carrying a single token byte. Short
    on purpose: it is an identifier to compare two receipts with, never a
    handle to recover the credential from.
    """
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _credential_minted_at(home: Path) -> Tuple[Optional[str], Any]:
    """When this profile's relay credential was minted, per its own marker.

    Returns the marker's own ``createdAt`` string and the instant it parses
    to. Both are ``None`` whenever the marker is absent, malformed, or
    written for a different profile: the marker is validated against the home
    it sits in, so a `.env` copied between profiles cannot lend its date to
    the profile that copied it. Never raises — a missing date makes the
    conflict report less useful and must never make the refusal itself fail.
    """
    try:
        from .relay_credential import _parse_utc_iso, read_relay_credential_marker

        record = read_relay_credential_marker(home)
        if not isinstance(record, Mapping):
            return None, None
        created = record.get("createdAt")
        if not isinstance(created, str) or not created.strip():
            return None, None
        # The same validator the marker had to pass to be read at all, so the
        # date in the report and the date the comparison uses cannot diverge.
        return created, _parse_utc_iso(created)
    except Exception:  # noqa: BLE001 - a date is never worth a crash
        return None, None


def _credential_conflict_report(
    *, default_home: Path, source_home: Path
) -> Dict[str, Any]:
    """What the assistant needs to ask a good question about two credentials.

    There is no per-profile record of which phones hold which credential — a
    pairing lives on the phone — so nothing here can decide the conflict. What
    it *can* say is which credential is newer, because the overwhelmingly
    common conflict is the one the install order creates: installing the
    bundle in the default profile loads the adapter, which mints a credential
    there before the move has had a chance to run. A default credential minted
    **after** the secondary's is almost always that empty one, and the
    secondary's is the one with phones on it. "Almost always" is why this is
    evidence for a question and never an answer.
    """
    default_created, default_at = _credential_minted_at(default_home)
    source_created, source_at = _credential_minted_at(source_home)
    minted_after: Optional[bool] = None
    if default_at is not None and source_at is not None:
        minted_after = default_at > source_at
    return {
        "defaultCreatedAt": default_created,
        "sourceCreatedAt": source_created,
        "defaultMintedAfterSource": minted_after,
    }


def move_plan(
    *,
    default_home: Path,
    source: str,
    inventory: Optional[Mapping[str, Any]] = None,
    keep_source_credential: bool = False,
) -> Dict[str, Any]:
    """What an ownership move from ``source`` to the default profile would do.

    Pure inspection: reads the two homes, writes nothing. The credential is
    compared, never returned — a conflict is reported as a conflict, and the
    user decides, because silently picking one is silently unpairing a phone.
    """
    # `source` arrives from `--from` on the command line, so it is validated
    # against Hermes's own profile charset BEFORE it is joined to a path.
    # Without that check a name made of parent-directory segments would climb
    # out of the Hermes home, and a move would start rewriting config outside
    # it. The charset admits no dot, slash or backslash, so no such name
    # survives to reach the join below.
    source_home = default_home / PROFILES_DIRNAME / source
    if (
        source == DEFAULT_PROFILE
        or not PROFILE_NAME_RE.match(source or "")
        or not source_home.is_dir()
    ):
        return {
            "status": MOVE_REFUSED_UNKNOWN_PROFILE,
            "source": source,
            "mayApply": False,
            "reason": (
                f"`{_safe_name(source)}` is not a secondary profile of this "
                "Hermes home."
            ),
            "steps": [],
        }

    steps: List[Dict[str, Any]] = []

    # -- code ---------------------------------------------------------------
    source_plugin = source_home / "plugins" / PLATFORM_NAME
    default_plugin = default_home / "plugins" / PLATFORM_NAME
    if source_plugin.is_dir() and not default_plugin.is_dir():
        steps.append(
            {
                "kind": "copy_tree",
                # Copied, not moved. The secondary's tree is left on disk and
                # disabled: deleting a plugin directory is not this command's
                # to do, and the doctor already offers that cleanup as
                # `ocuclaw_installed_but_disabled_in_secondary`.
                "what": (
                    "a copy of the OcuClaw bundle (the original stays on disk "
                    "in the other profile, switched off)"
                ),
                "from": str(source_plugin),
                "to": str(default_plugin),
            }
        )

    # -- relay credential ---------------------------------------------------
    source_env_lines, source_env_state = _read_env(source_home / ".env")
    default_env_lines, default_env_state = _read_env(default_home / ".env")
    source_token = _env_value(source_env_lines, RELAY_TOKEN_ENV)
    default_token = _env_value(default_env_lines, RELAY_TOKEN_ENV)
    credential_conflict = bool(
        source_token and default_token and source_token != default_token
    )
    if source_env_state == "unreadable" or default_env_state == "unreadable":
        return {
            "status": MOVE_REFUSED_CREDENTIAL_CONFLICT,
            "source": source,
            "mayApply": False,
            "reason": (
                "A profile's `.env` could not be read, so the move cannot "
                "prove it would preserve the existing pairing."
            ),
            "steps": [],
        }
    conflict_report = (
        _credential_conflict_report(
            default_home=default_home, source_home=source_home
        )
        if credential_conflict
        else None
    )
    if credential_conflict and not keep_source_credential:
        return {
            "status": MOVE_REFUSED_CREDENTIAL_CONFLICT,
            "source": source,
            "mayApply": False,
            "reason": (
                f"Both the default profile and `{source}` hold a relay "
                "credential, and they are different. Moving either one would "
                "disconnect the phones paired to the other. Decide which "
                "pairing to keep first; this command never regenerates or "
                "overwrites a credential. Installing the bundle in the "
                "default profile mints a credential there, so this conflict "
                "is expected right after that install and "
                "`credentialConflict.defaultMintedAfterSource` says whether "
                "that is what happened. Once the wearer has chosen: to keep "
                f"the pairing that lives in `{source}`, re-run with "
                "`--keep-source-credential`, which drops the default "
                "profile's own credential and carries the other across "
                "unchanged; to keep the default profile's pairing instead, "
                "leave both credentials where they are and do not move "
                "transport."
            ),
            "fault": FAULT_OCUCLAW_OUTSIDE_DEFAULT,
            "credentialConflict": conflict_report,
            "steps": [],
        }
    if credential_conflict:
        # `--keep-source-credential`: the wearer has been asked and chose the
        # pairing that lives in the secondary. Dropping the default's
        # credential is a deletion, never a reissue — the phones paired to it
        # (if any) lose this host, which is exactly what was chosen, and
        # nothing anywhere is regenerated.
        #
        # The marker beside that credential names its *generation*, and
        # `first_run` binds its proof to that generation, so the marker goes
        # with it. Leaving it would have the default profile swearing to a
        # credential it no longer holds. Removing it leaves no marker at all,
        # which is the one state the adapter repairs correctly by itself: on
        # the next load `bootstrap_relay_credential` finds a credential and no
        # marker and ADOPTS — it publishes a marker for the credential that is
        # actually there, and generates nothing.
        default_marker = default_home / "state" / RELAY_CREDENTIAL_MARKER_FILENAME
        steps.append(
            {
                "kind": "drop_default_credential",
                "what": (
                    "the relay credential the default profile holds now — you "
                    f"chose to keep the pairing that lives in `{source}`, so "
                    "this one is removed, not reissued"
                ),
                "from": str(default_home / ".env"),
                "fingerprint": _credential_fingerprint(default_token),
                "removesMarker": default_marker.is_file(),
            }
        )
        steps.append(
            {
                "kind": "move_credential",
                "what": (
                    f"the relay credential ({RELAY_TOKEN_ENV}) from `{source}`, "
                    "carried across unchanged so every phone paired to it "
                    "stays paired"
                ),
                "from": str(source_home / ".env"),
                "to": str(default_home / ".env"),
            }
        )
    elif source_token and not default_token:
        steps.append(
            {
                "kind": "move_credential",
                "what": (
                    f"the relay credential ({RELAY_TOKEN_ENV}), carried across "
                    "unchanged so every paired phone stays paired"
                ),
                "from": str(source_home / ".env"),
                "to": str(default_home / ".env"),
            }
        )
    elif source_token and default_token:
        # Equal tokens — a half-finished move, or somebody copied `.env` by
        # hand. The default profile already has what it needs, so nothing is
        # carried; but leaving the copy behind keeps the secondary looking
        # like a transport owner to the doctor, and keeps a live credential in
        # a profile that must not hold one. Drop it.
        steps.append(
            {
                "kind": "drop_secondary_credential",
                "what": (
                    f"the duplicate relay credential in `{source}` — the "
                    "default profile already holds the same one, so nothing "
                    "is carried and nothing is reissued"
                ),
                "from": str(source_home / ".env"),
            }
        )

    # -- pairing state ------------------------------------------------------
    carried = [
        name
        for name in MOVED_STATE_FILES
        if (source_home / "state" / name).is_file()
        and not (default_home / "state" / name).exists()
    ]
    if carried:
        steps.append(
            {
                "kind": "move_state",
                "what": "pairing and first-run state",
                "files": carried,
                "from": str(source_home / "state"),
                "to": str(default_home / "state"),
            }
        )
    source_runtime = source_home / RUNTIME_STATE_DIRNAME
    if source_runtime.is_dir() and not (default_home / RUNTIME_STATE_DIRNAME).exists():
        steps.append(
            {
                "kind": "move_tree",
                "what": "device key, device token and per-agent settings",
                "from": str(source_runtime),
                "to": str(default_home / RUNTIME_STATE_DIRNAME),
            }
        )

    # -- enable it where it now lives --------------------------------------
    from .profiles_report import read_profile_config

    default_config, default_readable = read_profile_config(default_home)
    default_enabled = (default_config.get("plugins") or {}).get("enabled")
    already_enabled = isinstance(default_enabled, list) and PLATFORM_NAME in default_enabled
    if default_readable and not already_enabled and (
        default_plugin.is_dir() or source_plugin.is_dir()
    ):
        # Copying the code into the default profile without this leaves the
        # host in the mirror image of the reporter's bug: the bundle is on
        # disk where it belongs and nothing loads it.
        steps.append(
            {
                "kind": "enable_in_default",
                "what": (
                    "switching OcuClaw on in the default profile, so the "
                    "bundle that just arrived is actually loaded"
                ),
                "to": str(default_home / "config.yaml"),
            }
        )

    # -- stand the secondary down ------------------------------------------
    source_config, source_readable = read_profile_config(source_home)
    enabled = (source_config.get("plugins") or {}).get("enabled")
    disables = source_readable and isinstance(enabled, list) and PLATFORM_NAME in enabled
    has_platform_block = source_readable and isinstance(
        (source_config.get("platforms") or {}).get(PLATFORM_NAME), Mapping
    )
    if disables or has_platform_block:
        steps.append(
            {
                "kind": "clear_secondary_config",
                "what": (
                    f"OcuClaw's entries in `{source}`'s config, so it stops "
                    "claiming a transport it no longer owns"
                ),
                "from": str(source_home / "config.yaml"),
                "removesPluginEntry": bool(disables),
                "removesPlatformBlock": bool(has_platform_block),
            }
        )

    if not steps:
        return {
            "status": MOVE_NOT_NEEDED,
            "source": source,
            "mayApply": False,
            "reason": (
                f"`{source}` holds no OcuClaw code, credential or pairing "
                "state, so there is nothing to move."
            ),
            "steps": [],
        }

    # A move rewrites both homes' on-disk state. A gateway reading them at the
    # same time is how a half-moved credential becomes a live outage, so the
    # move refuses while either gateway is up rather than racing it.
    live = _live_gateways(inventory, source)
    if live:
        return {
            "status": MOVE_REFUSED_GATEWAY_LIVE,
            "source": source,
            "mayApply": False,
            "reason": (
                "A gateway is running for "
                + ", ".join(f"`{name}`" for name in live)
                + ". Stop it first: "
                + " ; ".join(
                    f"`hermes{'' if name == DEFAULT_PROFILE else f' -p {name}'} "
                    "gateway stop`"
                    for name in live
                )
                + "."
            ),
            "fault": FAULT_SECONDARY_TRANSPORT_OWNER,
            **(
                {"credentialConflict": conflict_report}
                if conflict_report is not None
                else {}
            ),
            "steps": steps,
        }

    return {
        "status": MOVE_OK,
        "source": source,
        "mayApply": True,
        "reason": (
            (
                f"Transport moves from `{source}` to `{DEFAULT_PROFILE}`. The "
                "default profile's own relay credential is dropped as you "
                f"chose, and `{source}`'s is carried across unchanged, so the "
                "phones paired to it stay paired."
            )
            if conflict_report is not None
            else (
                f"Transport moves from `{source}` to `{DEFAULT_PROFILE}`, "
                "credential unchanged."
            )
        ),
        "fault": FAULT_SECONDARY_TRANSPORT_OWNER,
        **(
            {"credentialConflict": conflict_report}
            if conflict_report is not None
            else {}
        ),
        "steps": steps,
    }


def _live_gateways(inventory: Optional[Mapping[str, Any]], source: str) -> List[str]:
    if not isinstance(inventory, Mapping) or not inventory.get("observed"):
        return []
    live: List[str] = []
    for row in inventory.get("profiles") or []:
        if not isinstance(row, Mapping):
            continue
        name = str(row.get("name") or "")
        if name in (DEFAULT_PROFILE, source) and row.get("gatewayLive") is True:
            live.append(name)
    return live


def apply_move(
    *,
    default_home: Path,
    source: str,
    plan: Mapping[str, Any],
) -> Dict[str, Any]:
    """Carry out a :func:`move_plan` that said ``mayApply``.

    Ordered so an interruption never destroys the only copy of anything: the
    default profile is populated first and the secondary is stood down last.
    A crash between the two leaves both homes holding the same credential,
    which the operator can see and the doctor names — far better than a
    window where neither does.
    """
    if not plan.get("mayApply"):
        return {"status": plan.get("status"), "applied": [], "source": source}

    if not PROFILE_NAME_RE.match(source or "") or source == DEFAULT_PROFILE:
        # `apply_move` is public, so it re-checks rather than trusting that
        # the plan beside it came from `move_plan`.
        return {"status": MOVE_REFUSED_UNKNOWN_PROFILE, "applied": [], "source": source}

    source_home = default_home / PROFILES_DIRNAME / source
    applied: List[str] = []
    dropped_fingerprint: Optional[str] = None

    for step in plan.get("steps") or []:
        kind = step.get("kind")
        try:
            _apply_step(
                kind, step, default_home=default_home, source_home=source_home
            )
        except Exception as exc:  # noqa: BLE001 - say which half landed
            # Ordering means a crash here leaves a DUPLICATE, never a gap:
            # the default profile is populated before the secondary is stood
            # down. The operator still has to be told exactly how far it got,
            # because "it failed" without that list is an invitation to rerun
            # blind.
            return {
                "status": MOVE_PARTIAL,
                "source": source,
                "applied": applied,
                **(
                    {"droppedCredentialFingerprint": dropped_fingerprint}
                    if dropped_fingerprint is not None
                    else {}
                ),
                "failedStep": kind,
                "error": type(exc).__name__,
                "next": ["hermes ocuclaw doctor"],
            }
        if kind == "drop_default_credential":
            # Which credential was removed, as a one-way name. "A credential
            # was dropped" is not something an operator can check against
            # anything; the fingerprint is, and it carries no token bytes.
            dropped_fingerprint = step.get("fingerprint")
        applied.append(str(kind))

    return {
        "status": MOVE_APPLIED,
        "source": source,
        "applied": applied,
        **(
            {"droppedCredentialFingerprint": dropped_fingerprint}
            if dropped_fingerprint is not None
            else {}
        ),
        # `plugins.enabled` is the config half. Running Hermes's own enable
        # afterwards is idempotent and lets the plugin manager do whatever
        # registration it owns that a config line does not cover.
        "next": [
            "hermes plugins enable ocuclaw",
            "hermes gateway restart",
        ],
        "restart": "hermes gateway restart",
    }


def _apply_step(
    kind: Any, step: Mapping[str, Any], *, default_home: Path, source_home: Path
) -> None:
    """One move step. Raises; :func:`apply_move` turns that into a receipt."""
    if kind == "copy_tree":
        shutil.copytree(step["from"], step["to"])
    elif kind == "move_credential":
        source_lines, _state = _read_env(source_home / ".env")
        # The raw line, not a reparsed value: quoting and any `export` prefix
        # travel with it, so what lands in the default profile is byte for
        # byte what the secondary held.
        raw = _env_line_for(source_lines, RELAY_TOKEN_ENV)
        if raw is None:
            return
        default_path = default_home / ".env"
        default_lines, _default_state = _read_env(default_path)
        # Never let two assignments coexist, whatever shape the existing one
        # is in. A *different* credential is either refused outright or
        # removed first by `drop_default_credential`, which the plan orders
        # ahead of this step, so anything still here is the same one.
        body = _without_key(default_lines, RELAY_TOKEN_ENV)
        if body and body[-1].strip():
            body.append("")
        body.append(raw)
        _write_env(default_path, body)
        _write_env(source_home / ".env", _without_key(source_lines, RELAY_TOKEN_ENV))
    elif kind == "drop_default_credential":
        default_path = default_home / ".env"
        default_lines, _state = _read_env(default_path)
        # Removed, never reissued: the line goes, and nothing takes its place
        # until `move_credential` carries the chosen one in.
        _write_env(default_path, _without_key(default_lines, RELAY_TOKEN_ENV))
        marker = default_home / "state" / RELAY_CREDENTIAL_MARKER_FILENAME
        if marker.is_file():
            # The marker names the generation that just went. Leaving it
            # behind is the default profile swearing to a credential it no
            # longer holds; removing it lets the next adapter load adopt a
            # marker for the credential that is actually there.
            marker.unlink()
    elif kind == "drop_secondary_credential":
        source_lines, _state = _read_env(source_home / ".env")
        _write_env(source_home / ".env", _without_key(source_lines, RELAY_TOKEN_ENV))
    elif kind == "move_state":
        target = default_home / "state"
        target.mkdir(parents=True, exist_ok=True)
        for name in step.get("files") or []:
            shutil.move(str(source_home / "state" / name), str(target / name))
    elif kind == "move_tree":
        shutil.move(step["from"], step["to"])
    elif kind == "enable_in_default":
        _enable_in_default(default_home)
    elif kind == "clear_secondary_config":
        _clear_secondary_config(source_home)


def _safe_name(value: Any) -> str:
    """A profile name that is safe to put in rendered text.

    `--from` is a command-line string. The charset check gates the PATH; this
    gates the ECHO, so a rejected name cannot smuggle markup or a newline
    into a report an operator reads.
    """
    return value if isinstance(value, str) and PROFILE_NAME_RE.match(value) else "(invalid name)"


def _write_env(path: Path, lines: Sequence[str]) -> None:
    # Deliberate: `write_private` replaces the file at mode 0600 rather than
    # preserving the original. A `.env` holds every secret on that profile,
    # so narrowing a loose mode is the intended outcome, not a side effect.
    # `_read_env`'s splitlines/join also normalises CRLF to LF.
    from .profile_lifecycle import write_private

    text = "\n".join(lines)
    if text and not text.endswith("\n"):
        text += "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.touch(mode=0o600)
    write_private(path, text)


def _enable_in_default(default_home: Path) -> None:
    from hermes_cli.config import atomic_config_write, read_user_config_raw

    path = default_home / "config.yaml"
    config = copy.deepcopy(read_user_config_raw(path))
    plugins = config.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        raise ValueError("Plugin configuration is invalid")
    enabled = plugins.get("enabled")
    if not isinstance(enabled, list):
        enabled = []
    if PLATFORM_NAME not in enabled:
        plugins["enabled"] = [*enabled, PLATFORM_NAME]
        atomic_config_write(path, config)


def _clear_secondary_config(source_home: Path) -> None:
    from hermes_cli.config import atomic_config_write, read_user_config_raw

    path = source_home / "config.yaml"
    config = copy.deepcopy(read_user_config_raw(path))
    plugins = config.get("plugins")
    if isinstance(plugins, dict) and isinstance(plugins.get("enabled"), list):
        plugins["enabled"] = [
            item for item in plugins["enabled"] if item != PLATFORM_NAME
        ]
    platforms = config.get("platforms")
    if isinstance(platforms, dict):
        platforms.pop(PLATFORM_NAME, None)
    atomic_config_write(path, config)


# -- the whole preflight ------------------------------------------------------


def preflight(
    *,
    process_home: Optional[Path],
    inventory: Mapping[str, Any],
    capability: Optional[Mapping[str, Any]] = None,
    opt_out_retired: Optional[bool] = None,
) -> Dict[str, Any]:
    """Every question setup must settle before it writes anything."""
    verdict = invocation_verdict(process_home=process_home)
    if capability is None:
        capability = migrate_capability()
    if opt_out_retired is None:
        opt_out_retired = multiplex_opt_out_retired()

    migration = migration_plan(
        inventory, capability=capability, opt_out_retired=opt_out_retired
    )
    # The migration gate's own count ("this host has one profile").
    has_other_profiles = any(row.get("name") for row in _secondary_rows(inventory))
    transport = inventory.get("transport") or {}
    owner = transport.get("owner")
    move_needed = bool(owner) and owner != DEFAULT_PROFILE

    if move_needed:
        # Ordering, not preference. Upstream's own preflight blocks a
        # migration on "profile '<p>' enables <platform>, which binds its own
        # port" — which is precisely a secondary that still holds OcuClaw. Fold
        # first and the migration refuses; move first and it does not.
        migration = dict(migration)
        migration["mayProceed"] = False
        migration["blockedBy"] = "ownership_move_must_run_first"

    return {
        "invocation": verdict,
        "migration": migration,
        # #3618: on Hermes 0.21.4+ OcuClaw never offers "single agent",
        # whatever the profile count. The guide skips the question SILENTLY
        # and records "multiple". A machine field only: nothing here is said
        # to the person.
        "singleAgent": {
            "available": single_agent_available(opt_out_retired=opt_out_retired),
            "optOutRetired": opt_out_retired,
            "hostHasOtherProfiles": has_other_profiles,
        },
        "ownershipMove": {
            "needed": move_needed,
            "source": owner if move_needed else None,
            "command": (
                f"hermes ocuclaw move-to-default --from {owner}"
                if move_needed
                else None
            ),
            "fault": FAULT_SECONDARY_TRANSPORT_OWNER if move_needed else None,
            "say": (
                "OcuClaw's connection to your glasses is set up under one of "
                "your other agents. I can move it to the main one, keeping "
                "your glasses paired exactly as they are."
                if move_needed
                else "Your glasses connect through the main agent already."
            ),
        },
        # Exit 0 means "setup may proceed", so every gate that must be
        # settled first has to be folded in here. Leaving the migration out
        # let a host whose inventory could not be read at all, or whose
        # secondary gateway blocks the flag flip, still exit 0 — which is the
        # opposite of what the skill is told the exit code means.
        "mayProceed": (
            bool(verdict.get("mayProceed"))
            and not move_needed
            and bool(migration.get("mayProceed"))
        ),
    }


# -- rendering ----------------------------------------------------------------

_GATE_HEADLINES = {
    GATE_ALREADY: "multiple agents are already on",
    GATE_NOT_NEEDED: "nothing to migrate — this host has one profile",
    GATE_MIGRATE_COMMAND: "this engine can fold the other profiles in",
    GATE_FLAG_FLIP: "no secondary gateway is in the way; the flag is enough",
    GATE_BLOCKED: "REFUSED — a secondary gateway is in the way",
}


def _say(text: str) -> str:
    return SAY_PREFIX + text


def _wrap(text: str, width: int = 68) -> List[str]:
    words, line, out = text.split(), "", []
    for word in words:
        if line and len(line) + 1 + len(word) > width:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        out.append(line)
    return out


def render_preflight(report: Mapping[str, Any]) -> List[str]:
    """The operator-facing preflight. `say:` lines are for the user."""
    lines = ["", "Setup preflight — profile ownership, migration, transport"]

    invocation = report.get("invocation") or {}
    profile = invocation.get("profile") or "unknown"
    if invocation.get("verdict") == VERDICT_PROCEED:
        lines.append(
            f"  invoked on               `{profile}` — the profile that owns transport"
        )
    else:
        lines.append(f"  invoked on               `{profile}`")
        lines.append(f"  REFUSED                  {invocation.get('verdict')}")
        for chunk in _wrap(str(invocation.get("reason") or "")):
            lines.append(f"      {chunk}")
        reenter = invocation.get("reenter")
        if reenter:
            lines.append(f"      re-run there: `{reenter}`")
        lines.append(
            _say(
                "OcuClaw's connection to your glasses belongs to your main "
                "agent, so I need to set it up there instead of here."
            )
        )
        return lines

    migration = report.get("migration") or {}
    capability = migration.get("capability") or {}
    lines.append("")
    lines.append(
        "  engine migrate command   "
        + ("available" if capability.get("available") else "absent")
        + f"  (probe: {capability.get('evidence')})"
    )
    gate = migration.get("gate")
    lines.append(
        f"  multiple-agent gate      {gate} — {_GATE_HEADLINES.get(gate, '')}"
    )
    secondaries = migration.get("secondaries") or []
    lines.append(
        "  other profiles           "
        + (", ".join(f"`{name}`" for name in secondaries) if secondaries else "none")
    )

    blockers = migration.get("blockers") or []
    if blockers:
        lines.append(f"  blockers                 {len(blockers)}")
        for blocker in blockers:
            lines.append(f"      {blocker.get('detail')}")
    else:
        lines.append("  blockers                 none")

    if migration.get("blockedBy"):
        lines.append(f"  ordered after            {migration.get('blockedBy')}")

    for command in migration.get("commands") or []:
        lines.append(f"  run                      {command}")
    if migration.get("dryRunExitIsNotAVerdict"):
        lines.append(
            "  READ THE DRY RUN TEXT    `--dry-run` exits 0 even when it is "
            f"blocked; look for a `{migration.get('blockersHeading')}` heading "
            "in its output, never at its exit code"
        )
    if migration.get("rollback"):
        lines.append(f"  undo                     {migration.get('rollback')}")
    lines.append(_say(str(migration.get("say") or "")))

    move = report.get("ownershipMove") or {}
    lines.append("")
    if move.get("needed"):
        lines.append(
            f"  transport owner          `{move.get('source')}` — must move first"
        )
        lines.append(f"  run                      {move.get('command')}")
    else:
        lines.append(f"  transport owner          `{DEFAULT_PROFILE}`")
    lines.append(_say(str(move.get("say") or "")))
    return lines


def render_move(
    plan: Mapping[str, Any], *, applied: Optional[Mapping[str, Any]] = None
) -> List[str]:
    """The ownership-move plan, and its receipt once applied."""
    lines = [
        "",
        f"Ownership move — `{_safe_name(plan.get('source'))}` → `{DEFAULT_PROFILE}`",
    ]
    lines.append(f"  status                   {plan.get('status')}")
    for chunk in _wrap(str(plan.get("reason") or "")):
        lines.append(f"      {chunk}")
    conflict = plan.get("credentialConflict")
    if isinstance(conflict, Mapping):
        # Dates and a verdict, never a token. This is what the assistant reads
        # to ask the wearer a question it can actually answer.
        lines.append("")
        lines.append(f"  default credential made  {conflict.get('defaultCreatedAt')}")
        lines.append(f"  the other one made       {conflict.get('sourceCreatedAt')}")
        lines.append(
            "  default is the newer     "
            f"{conflict.get('defaultMintedAfterSource')}"
        )
    steps = plan.get("steps") or []
    if steps:
        lines.append("")
        lines.append(f"  would move               {len(steps)}")
        for step in steps:
            lines.append(f"      - {step.get('what')}")
            files = step.get("files")
            if files:
                lines.append(f"          {', '.join(files)}")
    if applied is None:
        if plan.get("mayApply"):
            lines.append("")
            lines.append(
                "  nothing has changed. Re-run with --apply to carry it out."
            )
        lines.append(
            _say(
                "I can move your glasses connection to your main agent. Your "
                "glasses stay paired exactly as they are — nothing is reset."
            )
        )
        return lines
    lines.append("")
    lines.append(
        "  applied                  "
        + (", ".join(applied.get("applied") or []) or "nothing")
    )
    dropped = applied.get("droppedCredentialFingerprint")
    if dropped:
        lines.append(f"  credential dropped       {dropped}")
    if applied.get("status") == MOVE_PARTIAL:
        lines.append(f"  STOPPED AT               {applied.get('failedStep')}")
        lines.append(f"  error                    {applied.get('error')}")
        lines.append(
            "      the default profile is populated before the secondary is "
            "stood down, so this left a duplicate, not a gap"
        )
        for command in applied.get("next") or []:
            lines.append(f"  run next                 {command}")
        lines.append(
            _say(
                "I could not finish moving your glasses connection. Nothing "
                "was lost — I will check what is where before trying again."
            )
        )
        return lines
    for command in applied.get("next") or []:
        lines.append(f"  run next                 {command}")
    lines.append(
        _say("Done — your glasses connection now lives with your main agent.")
    )
    return lines
