"""Settle the same agent choice as chat setup before the Cloudways restart.

All writes use Hermes's CLI and are verified by reading the configuration back.
The preflight owns profile and migration safety; this is not a second planner.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import cloudways_restart_step, cloudways_settings, setup_profiles

MODE_KEY = setup_profiles.AGENT_MODE_KEY
FLAG_KEY = setup_profiles.FLAG_KEY
ENROLLMENT_KEY = "platforms.ocuclaw.extra.profile_allowlist"
_UNREADABLE = object()
# Native migration can spend 90 seconds waiting for served profiles, in
# addition to stopping/removing/restarting services and compensating failures.
# Keep ordinary config commands short without killing that lifecycle at 30s.
MIGRATION_CMD_TIMEOUT_S = 15 * 60.0


def _migration_pending(ctx: Any) -> bool:
    home = getattr(getattr(ctx, "layout", None), "hermes_home", None)
    if home is None:
        return False
    try:
        from hermes_cli.gateway_migrate import MANIFEST_NAME
    except ModuleNotFoundError as exc:
        # Older engines without native migration cannot have begun this plan.
        if exc.name in ("hermes_cli", "hermes_cli.gateway_migrate"):
            return False
        raise
    try:
        (Path(home) / MANIFEST_NAME).stat()
    except FileNotFoundError:
        return False
    return True


def _get(ctx: Any, key: str) -> Any:
    code, out, err = cloudways_settings._hermes(ctx, "config", "get", key)
    if code != 0:
        return None if "Config key not set" in (out + err) else _UNREADABLE
    try:
        from .yaml_compat import yaml

        return yaml.safe_load(out.strip())
    except Exception:
        return _UNREADABLE


def configure(ctx: Any) -> Any:
    """Return a failed step record on refusal; None means ready for step 2."""
    from . import cloudways_setup as ladder

    def fail(message: str) -> Any:
        ctx.say(f"  {message}")
        return ladder.StepRecord(
            "settings", ladder.STATUS_FAILED,
            cloudways_settings.DETAIL_READ_BACK_MISMATCH,
            exit_code=ladder.SETUP_EXIT_PROBLEM,
        )

    # The flag is written before native service changes finish. Its presence
    # therefore cannot settle a migration whose recovery manifest still exists.
    # Let Hermes resume/compensate its own plan, rather than planning over it.
    try:
        pending = _migration_pending(ctx)
    except (OSError, ImportError):
        return fail("Could not check pending agent migration. Run hermes gateway migrate --multiplex --dry-run before continuing.")
    if pending:
        return fail("Agent migration is unfinished. Run hermes gateway migrate --multiplex --yes to resume it, then run setup again.")

    code, out, _err = cloudways_settings._hermes(
        ctx, "ocuclaw", "setup-preflight", "--json"
    )
    if code != 0:
        return fail("Agent setup needs attention. Run hermes ocuclaw setup-preflight before continuing.")
    try:
        preflight = json.loads(out)
        invocation = preflight["invocation"]
        single_available = preflight["singleAgent"]["available"]
        migration = preflight["migration"]
        if not isinstance(single_available, bool) or not isinstance(invocation, dict) or not isinstance(migration, dict):
            raise ValueError("invalid preflight")
    except (ValueError, KeyError, TypeError):
        return fail("Could not check agent setup. Run hermes ocuclaw setup-preflight, then run setup again.")
    if not invocation.get("mayProceed") or preflight.get("ownershipMove", {}).get("needed"):
        return fail("Agent setup needs attention. Run hermes ocuclaw setup-preflight before continuing.")

    mode, flag = _get(ctx, MODE_KEY), _get(ctx, FLAG_KEY)
    if setup_profiles.agent_mode_recorded(mode, flag, opt_out_retired=not single_available):
        return None

    wanted = "multiple"
    if single_available:
        answer = ctx.choose(
            ["  Would you like to create and switch between agents (recommended), or use a single agent?",
             "  1. Multiple agents — each has its own chats and memory, using this host's model access and approval rules.",
             "  Creating an agent needs a restart, which waits for running chats to finish.",
             "  2. Single agent"],
            question="Choose 1 or 2: ", choices=("1", "2"),
        ) if ctx.choose else None
        if answer not in ("1", "2"):
            return fail("Choose agent mode in an interactive terminal, then run setup again.")
        wanted = "multiple" if answer == "1" else "single"

    if wanted == "multiple" and not migration.get("mayProceed"):
        return fail(str(migration.get("say") or "Agent setup needs attention. Run hermes ocuclaw setup-preflight."))

    gate = migration.get("gate")
    if wanted == "multiple" and gate == setup_profiles.GATE_MIGRATE_COMMAND:
        # Migration restarts the gateway itself. On Cloudways that can restart
        # the whole container: keep this explicit preview/confirmation door.
        code, preview, _err = cloudways_settings._hermes(
            ctx, "gateway", "migrate", "--multiplex", "--dry-run"
        )
        if code != 0 or not preview or setup_profiles.DRY_RUN_BLOCKERS_HEADING in preview:
            return fail("Hermes could not safely bring these agents together. Run hermes gateway migrate --multiplex --dry-run and resolve its blockers.")
        if not ctx.ask_human(
            ["  Bringing agents together starts their scheduled jobs and message connections under one gateway.", preview],
            question="Apply this migration? Type yes or no: ",
        ):
            return fail("Agent migration was not applied. Run setup again when you are ready.")
    elif wanted == "multiple" and gate not in (
        setup_profiles.GATE_ALREADY, setup_profiles.GATE_NOT_NEEDED, setup_profiles.GATE_FLAG_FLIP
    ):
        return fail("Agent setup returned an unknown migration plan. Run hermes ocuclaw setup-preflight.")

    if not cloudways_restart_step.mark_restart_pending(ctx):
        return fail(cloudways_settings.PENDING_MARKER_FAILED_MESSAGE)
    ctx.state["settings_changed"] = True

    def write(key: str, text: str, expected: Any) -> bool:
        cloudways_settings._hermes(ctx, "config", "set", "--force", key, text)
        actual = _get(ctx, key)
        return actual == expected and (not isinstance(expected, bool) or isinstance(actual, bool))

    if wanted == "multiple":
        # Preserve an existing enrollment set; absence starts with just the
        # default agent. Never silently enroll unrelated Hermes profiles.
        enrolled = _get(ctx, ENROLLMENT_KEY)
        if enrolled is None:
            if not write(ENROLLMENT_KEY, "[]", []):
                return fail("Agent enrollment did not read back after saving. Run setup again.")
        elif not isinstance(enrolled, list) or any(not isinstance(name, str) for name in enrolled):
            return fail("Agent enrollment is invalid. Run hermes ocuclaw doctor before continuing.")
        if gate == setup_profiles.GATE_MIGRATE_COMMAND:
            code, _out, _err = cloudways_settings._hermes(
                ctx, "gateway", "migrate", "--multiplex", "--yes",
                timeout_s=MIGRATION_CMD_TIMEOUT_S,
            )
            try:
                unfinished = _migration_pending(ctx)
            except (OSError, ImportError):
                unfinished = True
            if code != 0 or unfinished or _get(ctx, FLAG_KEY) is not True:
                return fail("Agent migration did not finish. Run hermes gateway migrate --multiplex --yes to resume it, then run setup again.")
        elif not write(FLAG_KEY, "true", True):
            return fail("Multiple agents did not read back as enabled. Run setup again.")
    elif not write(FLAG_KEY, "false", False):
        return fail("Single agent mode did not read back after saving. Run setup again.")
    if not write(MODE_KEY, wanted, wanted):
        return fail("Agent mode did not read back after saving. Run setup again.")
    return None
