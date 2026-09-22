"""Step 3 of the Cloudways ladder: is OcuClaw loaded, and at most one restart.

What this step is for, in the user's terms: they get to see that OcuClaw is
loaded and ready, and if the gateway has to restart to pick up what the ladder
just wrote, they are told *before* it happens that the container bounces and the
terminal may drop.

The user-facing name of this step is "Checking OcuClaw is loaded", and the words
"Relay Credential" never reach the terminal from here (#3242): they stay in this
code and its docstrings, where they name the thing precisely. What the user can
act on is whether their agent has loaded OcuClaw.

Three rules this module exists to keep:

1. **The credential is read, never minted and never revealed.** The ladder asks
   only whether the name is present (``health.setup_secret_present``, which
   answers a bool and never returns the value) and whether the gateway has
   published its marker. It never calls ``bootstrap_relay_credential`` — that is
   the *gateway's* job at plugin registration, and calling it from the CLI would
   mint a credential in a process that is not the one that has to hold it.
2. **At most one restart per run, none when nothing is pending, and never
   without a yes.** The restart goes through the same bounded lifecycle plan the
   all-device reset uses (``pairing._prepare_gateway_restart`` and its
   wrappers), so there is one restart authority in this bundle, not two, and it
   is gated on ``ctx.ask`` — default No, answered by ``--yes``.
3. **"Restart pending" is never answered from `hermes ocuclaw status`.** That
   verb layers the env file over yaml *in the CLI process*, so it reports a
   value as configured before any gateway has read it (#3098, pet check). It
   describes the next gateway start, never the running gateway.

How "pending" is actually decided, and why each half is there:

* **Within this run**: ``ctx.state["settings_changed"]``, which step 2 sets on
  every path that reaches a verdict. This is exact.
* **Across a crash or a rerun**: the ladder's own pending marker
  (``receipts.write_restart_pending``), stamped by step 2 *before* it writes a
  setting, compared against the moment the *gateway process* started. Before,
  not after: the window between a write and its record is where an interrupted
  setup loses a restart it can never be told about again (#3149 review).
  The start is taken from ``start_time`` in Hermes's own
  ``gateway_state.json`` (``gateway/status.py:420`` at the 0.21.1 floor, commit
  ``2237be355906``, re-stamped from ``_build_pid_record`` on every write and
  validated against PID reuse by ``runtime_status_pid_is_live``). The receipt's
  ``updated_at`` is deliberately NOT used: that field moves on every ordinary
  status write, so it would call a restart pending forever.

  **This is a marker and not a file mtime, and #3149 is why.** The first
  version of this step watched the modification time of ``.env`` and
  ``config.yaml``. Both files belong to Hermes, not to the ladder, and anything
  on the host may write them: a live pet rerun in which step 2 reported
  "already set, nothing was changed" still stopped the ladder with exit 2
  because ``config.yaml`` had been touched nine minutes after the gateway
  started — by Hermes itself, stamping its one-time onboarding hint
  (``agent/onboarding.py`` ``mark_seen`` from ``gateway/run_turn.py`` on a
  session's first turn, through the one config writer that has no managed
  guard), which is to say by the ladder's OWN step 8 first message and through
  a door no OcuClaw code touches. On a real
  Cloudways box that sends a user to their dashboard to restart an agent for a
  change OcuClaw never made, and because a fresh setup needs reruns by design
  (this step's hand-off, step 5's sign-in wait), any process that keeps
  touching those files makes the ladder unfinishable. A restart is pending
  because the LADDER wrote something, so only the ladder's own write may say
  so.

  The comparison keeps the old bias and the old bound: a start within
  :data:`START_MARGIN_S` of the marker is called pending rather than settled,
  because one unnecessary restart instruction is cheap and silently dead
  settings are not. Once a gateway has started after the marker, the marker is
  settled and this step removes it, so the ladder moves on instead of looping.

  When the comparison cannot be made — no ``/proc``, an unreadable boot time,
  no gateway receipt, a marker whose body no longer parses, or a stamp from the
  future because a clock stepped backwards — the step does NOT guess pending.
  Guessing there is exactly the loop the margin is designed to avoid, and it is
  a loop the user cannot clear by doing what they are told. With the marker
  standing it says :data:`SETTINGS_UNVERIFIABLE_MESSAGE` — this command wrote,
  and it can no longer vouch for the rest — and the ladder continues. With no
  marker of ours and no readable start it says :data:`OUTSIDE_CHANGE_NOTE`,
  which is about somebody else's change and always was.

The credential half reads the env file's modification time, and only in one
direction: an mtime OLDER than the gateway start proves every write that file
holds, the credential's included, happened before this gateway booted. A newer
mtime proves nothing at all — step 2 writes the allow-list name into that same
file — so it is never read as evidence of anything.

On a real Cloudways managed Hermes container the restart planner returns no plan
(#3097: ``manager='docker (foreground)'``, no systemd, the gateway is
``hermes gateway run --no-supervise`` under ``/entrypoint.sh``). What happens
there depends on WHY a restart is pending, and #3241 is the difference:

* **The plugin is not loaded** — no credential at all, no credential marker, or
  no running gateway. Nothing after this step can work, so the step still stops
  and asks for the restart (:data:`NOT_LOADED_LINES`, exit 2). The instruction
  leads with the Cloudways dashboard rather than with ``hermes gateway restart``
  for the reason spelled out at those lines.
* **Only settings are waiting** — step 2 wrote ``allow_admin_from``, or an
  earlier run did. That key is read at gateway start and is needed by exactly
  one feature, "Continue here" (``PROTOCOL.md``, ``adapter.py``,
  ``snapshot.py``'s ``continueHereConfigured``). The other setting this ladder
  writes, ``display.platforms.ocuclaw.tool_progress``, is read live. Steps 4 to
  8 name neither. So the ladder used to stop the user at step 3 and make them
  run the whole command again for a feature that is not needed until later: it
  now walks on, the pending marker stays standing so the owed restart is still
  recorded, and the ladder's completion output says in one line that "Continue
  here" switches on at the next restart.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Tuple

from . import health, receipts, relay_credential

# -- what this step reads -----------------------------------------------------

#: The Hermes env file, where the Relay Credential lives. It sits in the profile
#: home, exactly where `hermes_cli.config.get_env_path` puts it
#: (``get_hermes_home() / ".env"`` at the 0.21.1 floor), which is the same home
#: `cloudways.Layout` resolves from ``HERMES_HOME``. Deriving it from the layout
#: keeps the ladder on one home and adds no new platform import.
#:
#: ``config.yaml`` is deliberately NOT watched here (#3149): it is Hermes's file,
#: anything on the host may write it, and a restart is pending because the
#: ladder wrote something, never because a file moved.
ENV_FILENAME = ".env"

#: The adapter state Hermes's own runtime status carries when the relay is up
#: (`snapshot.py` treats exactly this token as connected).
RELAY_CONNECTED_STATE = "connected"

#: How long to wait, after a restart the ladder made itself, for the gateway and
#: the relay to both report healthy again.
RESTART_HEALTH_WAIT_S = 180.0

#: Boot time is published in whole seconds and the recorded start is in clock
#: ticks, so the derived start moment is good to about a second. A marker
#: stamped within this margin of the gateway's start is called pending rather
#: than settled: one extra restart instruction is cheap, silently dead settings
#: are not.
START_MARGIN_S = 2.0

#: What one read of the pending marker can say. ``MARKER_UNUSABLE`` covers both
#: a body that no longer parses and a stamp from the future (a clock that
#: stepped backwards), because the step can do nothing different about either.
MARKER_MISSING = "missing"
MARKER_UNUSABLE = "unusable"
MARKER_OK = "ok"


# -- journal vocabulary (mirrored into cloudways_setup.JOURNAL_DETAILS) -------

DETAIL_CREDENTIAL_MISSING = "credential-missing"
DETAIL_CREDENTIAL_STUCK = "credential-not-adopted"
DETAIL_NOTHING_PENDING = "nothing-pending"
DETAIL_PENDING_UNKNOWN = "pending-unknown"
DETAIL_ALREADY_RESTARTED = "already-restarted"
DETAIL_RESTART_MANUAL = "restart-manual"
#: Settings are waiting for a restart this host cannot make from here, and
#: nothing the ladder still has to do needs them (#3241). The ladder walks on.
DETAIL_RESTART_DEFERRED = "restart-deferred"
DETAIL_RESTART_DECLINED = "restart-declined"
DETAIL_RESTARTED = "restarted"
DETAIL_RESTART_FAILED = "restart-failed"
DETAIL_RESTART_UNHEALTHY = "restart-unhealthy"

JOURNAL_DETAILS = frozenset(
    {
        DETAIL_CREDENTIAL_MISSING,
        DETAIL_CREDENTIAL_STUCK,
        DETAIL_NOTHING_PENDING,
        DETAIL_PENDING_UNKNOWN,
        DETAIL_ALREADY_RESTARTED,
        DETAIL_RESTART_MANUAL,
        DETAIL_RESTART_DEFERRED,
        DETAIL_RESTART_DECLINED,
        DETAIL_RESTARTED,
        DETAIL_RESTART_FAILED,
        DETAIL_RESTART_UNHEALTHY,
    }
)


# -- the lines the user sees --------------------------------------------------

#: The whole happy path of this step, in one line. It is the wearer's question
#: — is my agent running OcuClaw — answered, and the Relay Credential behind it
#: is never named, printed or read (#3242). The OpenClaw ladder prints this
#: string byte for byte.
LOADED_MESSAGE = "OcuClaw is loaded and ready."

#: What the user is told whenever the plugin has not loaded: no credential at
#: all (the gateway mints it as the plugin registers — `adapter.py` ->
#: `relay_credential.bootstrap_relay_credential`), no credential marker yet, or
#: no running gateway to hold either.
#:
#: Why the dashboard comes first, and why the plugin's own reset wording is NOT
#: reused here: that message ("not in a bounded restart lifecycle ... Install and
#: start the Hermes gateway service") tells the user to install a gateway
#: service, which is wrong on a host that has no service manager at all, where
#: the account is unprivileged, and where ``/entrypoint.sh`` owns the gateway.
#:
#: Why `hermes gateway restart` is named second rather than first: at the 0.21.1
#: floor, with no service manager installed, `_cmd_restart` falls through to
#: ``stop_profile_gateway()`` and then runs ``run_gateway()`` in the foreground
#: of the caller's own shell (`hermes_cli/gateway.py:6062-6066`). Stopping the
#: gateway is what bounces the container here, so SSH drops and the foreground
#: gateway that command was about to become dies with the session; PID 1 brings
#: the real one back. That works, and the Hermes install block already describes
#: it as "a container restart there", but it is a side effect rather than the
#: host's own restart control, and #3097 deliberately did not execute it.
NOT_LOADED_MESSAGE = "OcuClaw is installed but your agent has not loaded it yet."
RESTART_AND_RERUN_MESSAGE = "Restart the agent, then run this command again."

NOT_LOADED_LINES = (
    f"  {NOT_LOADED_MESSAGE}",
    "",
    "  1. Restart the agent in your Cloudways dashboard.",
    "  2. Reconnect with your SSH command.",
    "  3. Run hermes ocuclaw cloudways setup again.",
    "",
    "  Terminal alternative: hermes gateway restart",
    "  This restarts the container and disconnects SSH.",
)

#: Printed when this command's own marker stands and nothing can answer it — an
#: unusable stamp, or a host that cannot say when its gateway started. Silence
#: would bury a setting the gateway may never have read. "Nothing is waiting"
#: would be a claim
#: this step cannot make, and exit 2 would be a loop the user cannot clear, so
#: it says the true thing and lets the ladder continue.
SETTINGS_UNVERIFIABLE_MESSAGE = (
    'Could not confirm whether the gateway loaded the saved settings.\n'
    'Restart it once to apply them. Setup can continue.'
)

#: Printed only when the cross-run comparison could not be made. Saying nothing
#: would be the dishonest option; claiming a restart is pending would loop.
OUTSIDE_CHANGE_NOTE = (
    'Could not check when the gateway last started.\n'
    'If you changed Hermes settings outside setup, restart the gateway to apply '
    'them.'
)

PENDING_GATEWAY_DOWN = (
    "Could not confirm Hermes is running.\n"
    "Check hermes gateway status. If it is stopped, start it, then run setup again."
)
PENDING_SETTINGS_CHANGED = 'Setup saved these settings. Restart Hermes to apply them.'
#: Said only on a host that CAN restart its own gateway, just before the consent
#: below. The credential behind it is never named (#3242): what the user can act
#: on is that their agent has not loaded OcuClaw yet.
PENDING_CREDENTIAL_NOT_ADOPTED = 'OcuClaw has not loaded yet. Hermes needs one restart.'
#: The cross-run half of :data:`PENDING_SETTINGS_CHANGED`: an earlier run of
#: this command wrote the settings, and no gateway has started since. It names
#: this command as the writer on purpose — the user is being asked to restart
#: for something OcuClaw did, and #3149 is what happens when that is not true.
PENDING_SETTINGS_WRITTEN_EARLIER = (
    'The settings saved by an earlier setup run are still waiting for a Hermes '
    'restart.'
)

#: The dead end: this gateway booted AFTER the credential was written and still
#: has not published a marker for it. Another restart has already been tried by
#: definition, so the ladder stops and points at the diagnosis instead of asking
#: for the same bounce again.
STILL_NOT_RUNNING_MESSAGE = "Your agent restarted but OcuClaw still is not running."
DOCTOR_MESSAGE = "Run `hermes ocuclaw doctor` to see why."

CREDENTIAL_STUCK_LINES = (
    f"  {STILL_NOT_RUNNING_MESSAGE}",
    f"  {DOCTOR_MESSAGE}",
)

#: The one restart per run is already recorded, so a second entry to this step
#: within the same run reports and stops rather than bouncing the host twice.
ALREADY_RESTARTED_MESSAGE = (
    'Hermes was already restarted once in this run.\n'
    'No second restart was attempted. Run setup again if the problem remains.'
)

#: The consent, asked BEFORE any restart the ladder performs itself. Default No;
#: `--yes` answers it, which is what keeps the verb automatable.
#:
#: This wording is for the path it is printed on, and only that path: a bounded
#: restart plan exists here, which means a service manager owns the gateway and
#: restarts it in place. The container bounce and the dropped terminal belong to
#: :data:`NOT_LOADED_LINES`, where they are what actually happens.
RESTART_CONSENT_LINES = (
    "  Setup will restart the Hermes gateway through this host's service manager.",
    "  OcuClaw will be offline briefly. Your phone will reconnect automatically.",
    "  Setup will wait for the gateway and relay before continuing.",
)

RESTART_FAILED_MESSAGE = (
    'Hermes restart did not complete.\n'
    'Restart the gateway, then run setup again.'
)

RESTART_UNHEALTHY_MESSAGE = (
    'Hermes restarted, but the gateway and relay did not both become healthy in '
    'time.\n'
    'Run hermes ocuclaw doctor, fix the reported problem, then run setup again.'
)

RESTART_HEALTHY_MESSAGE = 'Gateway and relay are healthy.'

WAIT_NOTICE_MESSAGE = 'Waiting for the gateway and relay to restart.'


# -- the seams ----------------------------------------------------------------
# Module-level on purpose, the same way `cloudways_settings` holds its two
# doors: a test replaces them so no suite can reach a real Hermes env file or
# restart a real gateway, and production gets the bundle's own readers with no
# indirection.


def credential_present() -> bool:
    """Whether the Relay Credential name has a value. Never the value itself."""
    return health.setup_secret_present(health.OCUCLAW_RELAY_TOKEN_ENV)


def credential_adopted(home: Optional[Path]) -> bool:
    """Whether a gateway has published this profile's credential marker.

    Deliberately the marker, not `relay_credential.is_profile_established`: that
    predicate answers True on a readable credential alone, which is the question
    already answered above. Only the gateway writes the marker, so its absence
    is evidence that no gateway has registered the plugin against this
    credential yet.
    """
    return relay_credential.read_relay_credential_marker(home) is not None


def gateway_state(home: Optional[Path]) -> Tuple[Optional[dict], str, Optional[bool]]:
    """Hermes's own profile receipt, with its writer identity qualified."""
    return receipts.read_gateway_state(home=home)


def boot_epoch() -> Optional[float]:
    """This host's boot moment as UNIX seconds, from ``/proc/stat``'s ``btime``.

    None off Linux, which is also the only place the recorded ``start_time`` is
    in clock ticks since boot: Hermes falls back to psutil centiseconds
    elsewhere, and the two units must never be mixed.
    """
    try:
        with open("/proc/stat", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("btime "):
                    return float(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def clock_ticks_per_second() -> Optional[float]:
    try:
        ticks = float(os.sysconf("SC_CLK_TCK"))
    except (AttributeError, ValueError, OSError):
        return None
    return ticks if ticks > 0 else None


def restart_plan() -> Optional[Any]:
    """The bundle's ONE bounded restart plan, or None when there is no lifecycle."""
    from . import pairing

    return pairing._prepare_gateway_restart()


def restart_gateway(timeout_s: Optional[float]) -> bool:
    """Run the bounded restart the all-device reset runs, and nothing else."""
    from . import pairing

    return pairing._restart_hermes_gateway(timeout_s=timeout_s)


# -- reading the host ---------------------------------------------------------


@dataclass(frozen=True)
class GatewayHealth:
    """What one read of Hermes's runtime receipt says, in this step's terms."""

    live: bool
    relay_connected: bool
    #: When the gateway PROCESS started, as UNIX seconds, or None when this host
    #: cannot say. Never derived from the receipt's ``updated_at``.
    started_at: Optional[float]

    @property
    def healthy(self) -> bool:
        return self.live and self.relay_connected


def read_gateway_health(home: Optional[Path]) -> GatewayHealth:
    record, status, live = gateway_state(home)
    facts = health.gateway_facts_from_receipt(record, status, live)
    is_live = facts["gatewayLive"] is True
    return GatewayHealth(
        live=is_live,
        relay_connected=is_live and _relay_is_connected_now(record),
        started_at=_started_at(record) if is_live else None,
    )


def _relay_is_connected_now(record: Optional[Mapping[str, Any]]) -> bool:
    """`connected`, AND written by the gateway process that is running now.

    Why this is not `health.gateway_facts_from_receipt`'s answer: Hermes keeps
    the primary platform entry across a restart, so a receipt written seconds
    after a bounce still carries the OLD process's ``state: connected`` until the
    new adapter reconnects and overwrites it. Waiting on that fact alone would
    call the relay healthy while it is still down.

    Hermes solves this for its own ``/api/status`` with per-entry writer
    provenance: ``writer_pid`` / ``writer_start_time`` stamped on every platform
    write (``gateway/status.py:837-840`` at the 0.21.1 floor, commit
    ``2237be355906``), compared for exact equality with the top-level record.
    That is the same comparison made here.

    This lives in the step rather than in `gateway_facts_from_receipt` on
    purpose. The other callers of that helper — the health collector, the
    adapter's own facts and the snapshot — deliberately want the preserved
    transition: the snapshot documents a stored transition as valid while the
    recording process stays live, and gates it with its own TTL instead.
    Narrowing it there would change what every presenter reports. Only this
    step is asking the narrower question "has the NEW process reconnected yet".
    """
    if not isinstance(record, Mapping):
        return False
    platforms = record.get("platforms")
    entry = platforms.get(health.PLATFORM_NAME) if isinstance(platforms, Mapping) else None
    if not isinstance(entry, Mapping):
        return False
    if str(entry.get("state") or "").strip() != RELAY_CONNECTED_STATE:
        return False
    return _entry_written_by_this_process(record, entry)


def _entry_written_by_this_process(
    record: Mapping[str, Any], entry: Mapping[str, Any]
) -> bool:
    writer_pid = entry.get("writer_pid")
    writer_start = entry.get("writer_start_time")
    if writer_pid is not None or writer_start is not None:
        return writer_pid == record.get("pid") and writer_start == record.get(
            "start_time"
        )
    # No provenance on the entry (an older writer than the floor). Fall back to
    # the entry's own timestamp against the process start: a transition stamped
    # before this process existed is the previous gateway's, not this one's.
    observed = _parse_iso(entry.get("updated_at"))
    started = _started_at(record)
    return observed is not None and started is not None and observed > started


def _parse_iso(value: Any) -> Optional[float]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _started_at(record: Optional[Mapping[str, Any]]) -> Optional[float]:
    if not isinstance(record, Mapping):
        return None
    ticks = record.get("start_time")
    if isinstance(ticks, bool) or not isinstance(ticks, int):
        return None
    boot = boot_epoch()
    hertz = clock_ticks_per_second()
    if boot is None or hertz is None:
        return None
    return boot + (ticks / hertz)


def env_write_time(hermes_home: Optional[Path]) -> Optional[float]:
    """When the Hermes env file was last written, or None if it cannot be read."""
    if hermes_home is None:
        return None
    try:
        return (Path(hermes_home) / ENV_FILENAME).stat().st_mtime
    except OSError:
        return None


# -- the ladder's own pending marker ------------------------------------------
# The cross-run answer to "did THIS command write something the gateway has not
# read yet". Step 2 stamps it when it really writes; this step settles it.


def marker_clock() -> float:
    """Wall-clock seconds for the marker.

    Deliberately not ``ctx.clock``: the ladder's injected clock defaults to
    ``time.monotonic``, whose zero is arbitrary, and this value is compared with
    a gateway start moment derived from the boot clock.
    """
    return time.time()


def read_pending_marker(hermes_home: Optional[Path]) -> Tuple[Optional[float], str]:
    """``(written_at, status)``: ``"missing"``, ``"unusable"`` or ``"ok"``.

    A stamp from the future is ``"unusable"``, in the same class as a body that
    no longer parses. Its cause is a clock that stepped backwards — a container
    resync, a restored snapshot — and a marker no later start time can ever
    exceed is an exit 2 the user cannot clear by doing what they are told.
    """
    written_at, status = receipts.read_restart_pending(home=hermes_home)
    if status == "ok" and written_at is not None:
        if written_at > marker_clock() + START_MARGIN_S:
            return None, MARKER_UNUSABLE
    return written_at, MARKER_UNUSABLE if status == "unreadable" else status


def mark_restart_pending(ctx: Any) -> bool:
    """Record that this command is about to write what the gateway must reload.

    Called by step 2 BEFORE its first write, never after: between the write and
    its record lies the Ctrl-C, the dropped SSH session and the container bounce
    that a Cloudways setup is expected to go through, and a setting that
    survives that window with nothing saying the gateway has not read it is a
    silently dead setting. #3149 review.

    Returns False rather than raising, and the caller treats False as a stop:
    the marker is a precondition of the write, not a receipt for it.
    """
    home = getattr(getattr(ctx, "layout", None), "hermes_home", None)
    try:
        receipts.write_restart_pending(marker_clock(), home=home)
    except Exception:  # noqa: BLE001 - the caller owns what an unstamped host means
        return False
    return True


def forget_pending_marker(hermes_home: Optional[Path]) -> bool:
    """Remove a marker a gateway start has already answered.

    Best effort, and never load-bearing: if the removal fails, the same clock
    comparison settles it again on the next run. It exists so a host that later
    loses its boot clock does not inherit a marker nothing can answer.
    """
    try:
        return bool(receipts.remove_restart_pending(home=hermes_home))
    except Exception:  # noqa: BLE001 - see above
        return False


def marker_settled(
    written_at: Optional[float], status: str, started_at: Optional[float]
) -> Optional[bool]:
    """Has a gateway started since the ladder's last write?

    ``True`` — nothing of the ladder's is waiting: either no marker at all, or
    a gateway started after it. ``False`` — the marker stands and this gateway
    predates it. ``None`` — there is a marker and this host cannot say, which is
    the honest unknown and never a guess in either direction.
    """
    if status == MARKER_MISSING:
        return True
    if status != MARKER_OK or written_at is None or started_at is None:
        return None
    return started_at > written_at + START_MARGIN_S


def credential_predates_start(
    state: "GatewayHealth", hermes_home: Optional[Path]
) -> bool:
    """Was the Relay Credential already on disk when THIS gateway started?

    The env file's modification time is an upper bound on every write it holds,
    the credential's included, so an mtime older than the start proves the
    credential was there at boot. The implication runs one way only: step 2
    writes the allow-list name into the same file, so a NEWER mtime says
    nothing about the credential and is never treated as evidence.
    """
    written = env_write_time(hermes_home)
    return (
        state.started_at is not None
        and written is not None
        and state.started_at > written + START_MARGIN_S
    )


# -- is a restart pending? ----------------------------------------------------


@dataclass(frozen=True)
class Pending:
    """Why a restart is needed, or what to say when none is."""

    message: Optional[str]
    #: What to say when no restart is pending. Normally nothing at all: the
    #: step's own one line has already said OcuClaw is loaded and ready, and
    #: "nothing is waiting for a gateway restart" is noise on top of it. A case
    #: this step cannot fully vouch for fills this in rather than staying
    #: silent about a setting the gateway may never have read.
    settled_message: Optional[str] = None
    #: An extra honest line after :attr:`settled_message`.
    note: Optional[str] = None
    #: True when nothing after this step can work until the restart happens:
    #: the plugin is not loaded, or there is no running gateway at all. False
    #: when the restart is owed only for a setting nothing in the rest of the
    #: ladder reads, which is what lets #3241 walk on instead of stopping.
    blocking: bool = True
    #: True when a restart is demonstrably NOT the remedy. The step reports and
    #: stops with a problem code instead of asking for another bounce.
    dead_end: bool = False
    #: The journal word for a settled outcome, when it is not the plain one.
    settled_detail: str = DETAIL_NOTHING_PENDING

    @property
    def needed(self) -> bool:
        return self.message is not None


def assess_pending(
    ctx: Any, state: GatewayHealth, *, adopted: bool, hermes_home: Optional[Path]
) -> Pending:
    if not state.live:
        # No running gateway means nothing has read anything, and the receipt's
        # start time is not this host's answer to anything either.
        return Pending(PENDING_GATEWAY_DOWN)
    if bool(ctx.state.get("settings_changed")):
        return Pending(PENDING_SETTINGS_CHANGED, blocking=False)

    written_at, marker_status = read_pending_marker(hermes_home)
    settled = marker_settled(written_at, marker_status, state.started_at)
    marker_stands = marker_status != MARKER_MISSING

    if not adopted:
        # The gateway is NEWER than the credential write and has still published
        # no CREDENTIAL marker. A restart has effectively been tried already, so
        # asking for another one is a loop with a friendly face. Unless the
        # ladder's own pending marker is still waiting: then the restart is owed
        # anyway, and after it the next run reaches this dead end with a clean
        # conscience.
        if settled is not False and credential_predates_start(state, hermes_home):
            # `message` is the reason, not the print: a dead end says its own
            # two lines (:data:`CREDENTIAL_STUCK_LINES`) and stops.
            return Pending(STILL_NOT_RUNNING_MESSAGE, dead_end=True)
        return Pending(PENDING_CREDENTIAL_NOT_ADOPTED)

    if settled is False:
        return Pending(PENDING_SETTINGS_WRITTEN_EARLIER, blocking=False)
    if settled is None and marker_stands:
        # The marker stands and there is no way to tell whether it has been
        # answered — an unusable stamp, or a host that cannot say when its
        # gateway started. Calling it pending is the exit 2 loop #3149 is
        # about; calling it settled would bury a dead setting. So it says the
        # true thing: this command wrote, and it can no longer vouch for the
        # rest. The ladder continues, because a restart the user may not need
        # must not be a gate.
        return Pending(
            None,
            settled_message=SETTINGS_UNVERIFIABLE_MESSAGE,
            settled_detail=DETAIL_PENDING_UNKNOWN,
        )
    if state.started_at is None:
        # Nothing of this command's is waiting, and this host cannot say when
        # its gateway started, so it cannot speak for anybody else's change
        # either. That is the user's to know.
        return Pending(None, note=OUTSIDE_CHANGE_NOTE)
    if marker_status == MARKER_OK:
        forget_pending_marker(hermes_home)
    return Pending(None)


# -- the step -----------------------------------------------------------------


def run_relay_credential(ctx: Any) -> Any:
    """Step 3. Say whether OcuClaw is loaded, then at most one announced restart."""
    # Imported here, not at module scope: `cloudways_setup` is what calls this
    # module, and importing it back at import time would be a cycle.
    from . import cloudways_setup as ladder

    hermes_home = getattr(ctx.layout, "hermes_home", None)

    if ctx.state.get("gateway_restarted"):
        # At most ONE restart per run is the contract, and this is where it is
        # enforced rather than merely recorded: a second entry to step 3 in the
        # same run reports and stops instead of bouncing the host twice.
        ctx.say(f"  {ALREADY_RESTARTED_MESSAGE}")
        return ladder.StepRecord(
            "relay-credential", ladder.STATUS_SKIPPED, DETAIL_ALREADY_RESTARTED
        )

    if not credential_present():
        # No credential at all means the plugin has never registered: the
        # gateway mints it as OcuClaw loads.
        for line in NOT_LOADED_LINES:
            ctx.say(line)
        return ladder.StepRecord(
            "relay-credential",
            ladder.STATUS_REFUSED,
            DETAIL_CREDENTIAL_MISSING,
            exit_code=ladder.SETUP_EXIT_STOPPED,
        )

    adopted = credential_adopted(hermes_home)
    state = read_gateway_health(hermes_home)
    pending = assess_pending(ctx, state, adopted=adopted, hermes_home=hermes_home)

    if pending.dead_end:
        # Never the restart instruction here: it is the one thing already known
        # not to help.
        for line in CREDENTIAL_STUCK_LINES:
            ctx.say(line)
        return ladder.StepRecord(
            "relay-credential",
            ladder.STATUS_FAILED,
            DETAIL_CREDENTIAL_STUCK,
            exit_code=ladder.SETUP_EXIT_PROBLEM,
        )

    # The step's one line, and only where it is true: a gateway that is running
    # and holding the credential is a gateway that has loaded OcuClaw.
    if adopted and state.live:
        ctx.say(f"  {LOADED_MESSAGE}")

    if not pending.needed:
        if pending.settled_message:
            ctx.say(f"  {pending.settled_message}")
        if pending.note:
            ctx.say(f"  {pending.note}")
        return ladder.StepRecord(
            "relay-credential", ladder.STATUS_SKIPPED, pending.settled_detail
        )

    try:
        plan = restart_plan()
    except Exception:  # noqa: BLE001 - an unreadable lifecycle is no lifecycle
        plan = None
    if plan is None:
        if not pending.blocking:
            # #3241. Every real Cloudways container lands here after step 2
            # wrote the settings, and the ladder used to stop and make the user
            # restart and run the whole command again. Nothing between here and
            # step 8 reads either setting: `tool_progress` is read live, and
            # `allow_admin_from` is read at gateway start for "Continue here"
            # alone. The marker is deliberately NOT removed: it is the only
            # record that the restart is still owed, the next run settles it
            # when a gateway has started, and the ladder's completion output
            # names it in one line meanwhile.
            return ladder.StepRecord(
                "relay-credential", ladder.STATUS_SKIPPED, DETAIL_RESTART_DEFERRED
            )
        for line in NOT_LOADED_LINES:
            ctx.say(line)
        return ladder.StepRecord(
            "relay-credential",
            ladder.STATUS_REFUSED,
            DETAIL_RESTART_MANUAL,
            exit_code=ladder.SETUP_EXIT_STOPPED,
        )

    ctx.say(f"  {pending.message}")

    # The consent, not an announcement: this stops and starts the user's gateway,
    # so a person says yes to it (or `--yes` does, deliberately).
    if not ctx.ask(list(RESTART_CONSENT_LINES)):
        ctx.say(f"  {ladder.RESUME_MESSAGE}")
        return ladder.StepRecord(
            "relay-credential",
            ladder.STATUS_DECLINED,
            DETAIL_RESTART_DECLINED,
            exit_code=ladder.SETUP_EXIT_STOPPED,
        )

    # One restart per run, recorded before it is attempted: a run that comes
    # back from a bounce must never decide to bounce again.
    ctx.state["gateway_restarted"] = True
    try:
        restarted = bool(restart_gateway(getattr(plan, "timeout_s", None)))
    except Exception:  # noqa: BLE001 - a failed restart is a stable outcome
        restarted = False
    if not restarted:
        ctx.say(f"  {RESTART_FAILED_MESSAGE}")
        return ladder.StepRecord(
            "relay-credential",
            ladder.STATUS_FAILED,
            DETAIL_RESTART_FAILED,
            exit_code=ladder.SETUP_EXIT_PROBLEM,
        )

    if not wait_for_healthy(ctx, hermes_home):
        ctx.say(f"  {RESTART_UNHEALTHY_MESSAGE}")
        return ladder.StepRecord(
            "relay-credential",
            ladder.STATUS_FAILED,
            DETAIL_RESTART_UNHEALTHY,
            exit_code=ladder.SETUP_EXIT_PROBLEM,
        )

    # The gateway this run just started is newer than anything the ladder wrote,
    # so the marker is answered. The clock comparison would settle it on the
    # next run anyway; clearing it here means a host that later cannot read its
    # boot clock does not inherit a question nothing can answer.
    forget_pending_marker(hermes_home)
    ctx.say(f"  {RESTART_HEALTHY_MESSAGE}")
    return ladder.StepRecord("relay-credential", ladder.STATUS_DONE, DETAIL_RESTARTED)


def wait_for_healthy(ctx: Any, hermes_home: Optional[Path]) -> bool:
    """Bounded wait for the gateway AND the relay, on positive evidence only.

    Positive evidence in `first_use_cli._gateway_running`'s sense: only a
    readable receipt whose PID validates counts as live. Unknown is not healthy.
    """
    deadline = ctx.clock() + RESTART_HEALTH_WAIT_S
    last_notice = ctx.clock()
    while True:
        if read_gateway_health(hermes_home).healthy:
            return True
        if ctx.clock() >= deadline:
            return False
        if ctx.clock() - last_notice >= ctx.notice_s:
            last_notice = ctx.clock()
            ctx.say(f"  {WAIT_NOTICE_MESSAGE}")
        ctx.sleep(min(ctx.poll_s, max(0.0, deadline - ctx.clock())))


__all__ = [
    "ALREADY_RESTARTED_MESSAGE",
    "CREDENTIAL_STUCK_LINES",
    "DETAIL_ALREADY_RESTARTED",
    "DETAIL_CREDENTIAL_MISSING",
    "DETAIL_CREDENTIAL_STUCK",
    "DETAIL_NOTHING_PENDING",
    "DETAIL_PENDING_UNKNOWN",
    "DETAIL_RESTARTED",
    "DETAIL_RESTART_DECLINED",
    "DETAIL_RESTART_DEFERRED",
    "DETAIL_RESTART_FAILED",
    "DETAIL_RESTART_MANUAL",
    "DETAIL_RESTART_UNHEALTHY",
    "DOCTOR_MESSAGE",
    "GatewayHealth",
    "MARKER_MISSING",
    "MARKER_OK",
    "MARKER_UNUSABLE",
    "JOURNAL_DETAILS",
    "LOADED_MESSAGE",
    "NOT_LOADED_LINES",
    "NOT_LOADED_MESSAGE",
    "OUTSIDE_CHANGE_NOTE",
    "PENDING_CREDENTIAL_NOT_ADOPTED",
    "PENDING_GATEWAY_DOWN",
    "PENDING_SETTINGS_CHANGED",
    "PENDING_SETTINGS_WRITTEN_EARLIER",
    "RESTART_AND_RERUN_MESSAGE",
    "SETTINGS_UNVERIFIABLE_MESSAGE",
    "STILL_NOT_RUNNING_MESSAGE",
    "Pending",
    "RESTART_CONSENT_LINES",
    "RESTART_FAILED_MESSAGE",
    "RESTART_HEALTHY_MESSAGE",
    "RESTART_HEALTH_WAIT_S",
    "RESTART_UNHEALTHY_MESSAGE",
    "WAIT_NOTICE_MESSAGE",
    "START_MARGIN_S",
    "assess_pending",
    "boot_epoch",
    "clock_ticks_per_second",
    "credential_adopted",
    "credential_predates_start",
    "credential_present",
    "env_write_time",
    "forget_pending_marker",
    "gateway_state",
    "mark_restart_pending",
    "marker_clock",
    "marker_settled",
    "read_gateway_health",
    "read_pending_marker",
    "restart_gateway",
    "restart_plan",
    "run_relay_credential",
    "wait_for_healthy",
]
