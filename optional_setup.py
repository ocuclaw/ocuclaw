"""Two optional saves, one explicit activation. No secrets in receipts or output."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any

from . import receipts, optional_diagnostics as diagnostics

PENDING = "ocuclaw.optional-pending.json"
ACTIVE = "ocuclaw.optional-active.json"
LOCK = "ocuclaw.optional-setup.lock"
FIELDS = {"soniox": "OCUCLAW_SONIOX_API_KEY", "evenAi": "OCUCLAW_EVEN_AI_TOKEN",
          "typesafe": "OCUCLAW_TYPESAFE_API_KEY"}
# One masked-prompt label per FIELDS key. Saving the TypeSafe key is itself the
# arming gesture for silent input's word ranking (#3359) — there is no second
# switch — so the label names the service, not a feature toggle.
LABELS = {"soniox": "Soniox API key", "evenAi": "Even AI token",
          "typesafe": "TypeSafe API key"}
# `hermes ocuclaw optional-setup save <choice>` spellings, kebab-case for the CLI.
CLI_CHOICES = {"soniox": "soniox", "even-ai": "evenAi", "typesafe": "typesafe"}


def _home() -> Path:
    from hermes_constants import get_hermes_home
    from .profiles_report import default_home_for

    home = receipts.resolve_receipt_home()
    if home is None or home.resolve() != Path(get_hermes_home()).resolve():
        raise ValueError("profile_unavailable")
    if default_home_for(home) != home:
        raise ValueError("primary_runtime_required")
    return home


def _read(home: Path, name: str) -> dict:
    try:
        row = json.loads((receipts.state_dir(home) / name).read_text())
        return row if isinstance(row, dict) and row.get("v") == 1 else {}
    except (OSError, ValueError, TypeError):
        return {}


def _write(home: Path, name: str, row: dict) -> None:
    # Every row is v1; a writer that started from an empty `_read` (no receipt
    # yet, e.g. a receiptless activation) must not produce a row `_read` drops.
    receipts.write_json_receipt(receipts.state_dir(home) / name, {"v": 1, **row}, durable=True)


#: An admission whose gateway never came back within this window is stale: the
#: gateway was stopped for good, not restarting. Saves may proceed again.
#: 600 s, twice the top of the measured Cloudways container restart (1 to 5
#: minutes plus a watchdog tick, once seen at about 5 min 16 s): at 300 s a
#: save late in a slow restart slipped past the fence.
ADMISSION_TTL_S = 600


def _admission_in_flight(admitted: dict, gateway, live) -> bool:
    """Is the admitted restart still underway? False for done or stale admissions.

    `gateway, live` come from `receipts.read_gateway_state`, which returns
    `(None, status, None)` when the record is missing or unreadable.

    - Live gateway record: in flight only while it is the admitted process
      (the restart has not happened yet). A different live gateway means the
      restart is done (its `observe_runtime` also drops the admission).
    - Admission without `requestedAt` (written by a pre-#3357 bundle): no age
      evidence, so the old rule holds: in flight until a different gateway is
      live. The new gateway's observation lifts it after an upgrade in place.
    - No gateway record: the restart is underway; in flight within
      `ADMISSION_TTL_S` of `requestedAt`.
    - A record that is not live: in flight only while it still names the
      admitted process and the window has not elapsed. A later process that
      is not live means the gateway was stopped for good: stale.
    """
    same_process = isinstance(gateway, dict) and (
        (admitted.get("pid"), admitted.get("startTime")) == (gateway.get("pid"), gateway.get("start_time")))
    if isinstance(gateway, dict) and live is True:
        return same_process
    requested_at = admitted.get("requestedAt")
    if type(requested_at) not in (int, float):
        return True
    within = 0 <= time.time() - requested_at <= ADMISSION_TTL_S
    if not isinstance(gateway, dict):
        return within
    return same_process and within


def begin_save(home: Path, selected: str) -> str:
    """Fence BEFORE a write; interrupted saves remain pending, never lost."""
    if selected not in FIELDS and selected not in diagnostics.CHOICES.values():
        raise ValueError("invalid_selection")
    with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
        if not locked:
            raise ValueError("busy")
        old = _read(home, PENDING)
        admitted = old.get("activationRequested")
        if admitted:
            gateway, _, live = receipts.read_gateway_state(home=home)
            if _admission_in_flight(admitted, gateway, live):
                raise ValueError("activation_pending_reconnect")
            admitted = None  # done or stale: the fence no longer applies
        choices = dict(old.get("choices") or {})
        choices[selected] = "saving"
        revision = secrets.token_hex(16)
        choice_revisions = dict(old.get("choiceRevisions") or {})
        choice_revisions[selected] = revision
        _write(home, PENDING, {"revision": revision, "choices": choices,
                             "choiceRevisions": choice_revisions,
                             "activationRequested": admitted,
                             "activationAttempt": old.get("activationAttempt")})
        return revision


#: After a write, completing its receipt retries the state lock (each attempt
#: already waits up to `receipts._ROUTE_LOCK_TIMEOUT_S`) instead of raising a
#: transient `busy` that would strand the choice at `saving`.
FINISH_ATTEMPTS = 3


def finish_save(home: Path, revision: str, selected: str, *, saved: bool) -> None:
    """Complete a `begin_save`. Raises `busy` only after `FINISH_ATTEMPTS` lock waits."""
    for _ in range(FINISH_ATTEMPTS):
        if _finish_save_once(home, revision, selected, saved=saved):
            return
    raise ValueError("busy")


def _finish_save_once(home: Path, revision: str, selected: str, *, saved: bool) -> bool:
    with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
        if not locked:
            return False
        row = _read(home, PENDING)
        # A different choice may advance the shared revision. Only a newer save
        # of THIS choice supersedes this completion (Desktop and enable overlap).
        if (row.get("choiceRevisions") or {}).get(selected) != revision:
            return True
        choices = dict(row.get("choices") or {})
        if choices.get(selected) == "saving":
            choices[selected] = "saved" if saved else "save_failed"
        row["choices"] = choices
        _write(home, PENDING, row)
        return True


def _disk_values() -> tuple[dict, bool]:
    from hermes_cli.config import invalidate_env_cache, load_env, read_raw_config

    invalidate_env_cache()
    env = load_env()
    cfg = read_raw_config()
    extra = ((cfg.get("platforms") or {}).get("ocuclaw") or {}).get("extra") or {}
    return {name: str(env.get(key) or "").strip() for name, key in FIELDS.items()}, extra.get("evenAiEnabled") is True


def _file_revision(home: Path) -> list:
    result = []
    for name in (".env", "config.yaml"):
        try:
            stat = (home / name).stat()
            result.append([stat.st_ino, stat.st_size, stat.st_mtime_ns])
        except FileNotFoundError:
            result.append(None)
    return result


def read_disk(home: Path) -> dict:
    """One read of `.env`/`config.yaml` that `status`/snapshot callers can share."""
    values, enabled = _disk_values()
    return {"values": values, "enabled": enabled, "files": _file_revision(home)}


def read_state(home: Path) -> dict:
    """Everything `status`, `observation_current` and the phone snapshot consult, read once.

    The gateway record (with its liveness probe), both receipts, the disk and
    the configured diagnostics. An `observe_runtime` result carries the same
    `pending`/`active`/`disk`/`permissions` keys, so a caller that just
    observed overlays it instead of reading again. Raises when the
    diagnostics config is ambiguous, which `status` reports as unavailable.
    """
    gateway, _, live = receipts.read_gateway_state(home=home)
    return {"gateway": gateway, "live": live, "pending": _read(home, PENDING),
            "active": _read(home, ACTIVE), "disk": read_disk(home),
            "permissions": diagnostics.configured()}


def observe_runtime(settings: dict, *, home: Path | None = None) -> dict | None:
    """Called only after the actual relay answers, using its loaded settings.

    Presence alone is never activation evidence. Compare the actual loaded
    values privately and retain booleans plus the gateway writer identity.
    Returns what it read and wrote (`disk`, `pending`, `active`,
    `permissions`, see `read_state`) so the caller need not read them again,
    or None when nothing was recorded.
    """
    try:
        home = home or _home()
        from gateway.status import get_process_start_time
        with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
            if not locked:
                return None
            before = _file_revision(home)
            values, enabled = _disk_values()
            permissions = diagnostics.configured()
            marker = _read(home, PENDING)
            if before != _file_revision(home):
                return None
            start_time = get_process_start_time(os.getpid())
            admitted = marker.get("activationRequested")
            if admitted and (admitted.get("pid"), admitted.get("startTime")) != (os.getpid(), start_time):
                # This process is the gateway that came up after the admitted
                # restart: the restart completed, the save fence lifts.
                marker["activationRequested"] = None
                _write(home, PENDING, marker)
            matches = {
                "soniox": bool(values["soniox"]) and settings.get("sonioxApiKey") == values["soniox"],
                "evenAi": bool(values["evenAi"]) and settings.get("evenAiToken") == values["evenAi"]
                and settings.get("evenAiEnabled") is True and enabled,
                # The saved key IS the switch for ranking, so a loaded key is the
                # whole activation evidence — there is no separate enabled flag.
                "typesafe": bool(values["typesafe"]) and settings.get("typesafeApiKey") == values["typesafe"],
            }
            loaded_permissions = {key: settings.get(field) if type(settings.get(field)) is bool else None
                                  for key, field in diagnostics.FIELDS.items()}
            matches.update({diagnostics.CHOICES[key]: loaded_permissions[key] is permissions[key]
                            for key in diagnostics.FIELDS})
            active = {"v": 1, "revision": marker.get("revision"),
                      "pid": os.getpid(), "startTime": start_time,
                      "observedAt": time.time(), "files": before, "matches": matches,
                      # These settings belong to the relay that just answered,
                      # never the CLI's next-start/default configuration.
                      "relayPort": settings.get("wsPort"), "diagnostics": loaded_permissions}
            _write(home, ACTIVE, active)
            return {"disk": {"values": values, "enabled": enabled, "files": before},
                    "pending": {"v": 1, **marker}, "active": active, "permissions": permissions}
    except Exception:
        # Optional evidence must not break the relay or reveal a writer error.
        return None


#: An observation older than this is no activation evidence at all.
OBSERVATION_FRESH_S = 120
#: A status request re-observes past this age, or as soon as the files or the
#: gateway process differ from what the observation described.
OBSERVATION_REFRESH_S = 60


def observation_current(home: Path, state: dict | None = None) -> bool:
    """True while the ACTIVE receipt describes this `.env`/`config.yaml` AND this gateway.

    A save from any path (wizard, hand edit, CLI, Desktop) changes the files
    after the last loaded-runtime observation, and a restart whose ready-hook
    observation lost the lock leaves a receipt from the previous process; in
    both cases the caller may re-observe. It also requires the PENDING
    revision `status()` compares: a same-value retry that repairs a receipt
    advances the revision without touching the files, and must re-observe
    rather than leave a stale `saved_not_activated` restart offer.
    """
    state = state or read_state(home)
    active, gateway = state["active"], state["gateway"]
    return (state["live"] is True and isinstance(gateway, dict)
            and active.get("pid") == gateway.get("pid")
            and active.get("startTime") == gateway.get("start_time")
            and active.get("files") == state["disk"]["files"]
            and active.get("revision") == state["pending"].get("revision")
            and 0 <= time.time() - active.get("observedAt", 0) <= OBSERVATION_REFRESH_S)


def _would_load(name: str, values: dict, even_ai_enabled: bool) -> bool:
    """Would a restart load this disk value? Even AI also needs its enable flag."""
    return bool(values[name]) and (name != "evenAi" or even_ai_enabled)


# `status()["reasons"][name]` for an `unknown` credential, when the cause is known:
#: the gateway restarted for this exact `.env`/`config.yaml` and the relay still
#: loaded a different value (process env, systemd unit or a managed override
#: wins over `.env`); another restart would not change that.
REASON_DIFFERS_AFTER_RESTART = "loaded_value_differs_after_restart"
#: `OCUCLAW_EVEN_AI_TOKEN` is on disk but `platforms.ocuclaw.extra.evenAiEnabled`
#: is not true, so a restart would not activate it.
REASON_EVEN_AI_NOT_ENABLED = "even_ai_not_enabled"


def _attempt_marker(home: Path, gateway: dict | None) -> dict:
    """What an activation was attempted for: the loop breaker's evidence.

    Keyed on the `.env` revision (the credential file) and the gateway process,
    never `config.yaml`: a gateway start may rewrite that file (Hermes
    normalisation, managed entrypoints, the Cloudways container), and the
    breaker must still fire on exactly those hosts.
    """
    gateway = gateway if isinstance(gateway, dict) else {}
    return {"pid": gateway.get("pid"), "startTime": gateway.get("start_time"),
            "env": _file_revision(home)[0]}


def _admission(gateway: dict) -> dict:
    return {"pid": gateway.get("pid"), "startTime": gateway.get("start_time"), "requestedAt": time.time()}


def status(home: Path | None = None, *, state: dict | None = None) -> dict:
    """`state` is a `read_state` result the caller already holds (read once per request)."""
    try:
        home = home or _home()
        from .cloudways_restart_step import _relay_is_connected_now
        state = state or read_state(home)
        gateway, live = state["gateway"], state["live"]
        row, active, disk = state["pending"], state["active"], state["disk"]
        values, even_ai_enabled, current_files = disk["values"], disk["enabled"], disk["files"]
        choices = row.get("choices") or {}
        fresh = (live is True and _relay_is_connected_now(gateway)
                 and active.get("pid") == gateway.get("pid")
                 and active.get("startTime") == gateway.get("start_time")
                 and 0 <= time.time() - active.get("observedAt", 0) <= OBSERVATION_FRESH_S)
        same_revision = active.get("revision") == row.get("revision")
        files_match = active.get("files") == current_files
        current = fresh and same_revision and files_match
        matches = active.get("matches", {})
        # Loop breaker (#3357): an activation was attempted for this exact
        # `.env`, the gateway has restarted since, and the fresh observation
        # still mismatches. Offering another restart would loop forever.
        attempt = row.get("activationAttempt") or {}
        restarted_for_this_env = (
            bool(attempt) and fresh and files_match and attempt.get("env") == current_files[0]
            and isinstance(gateway, dict)
            and (attempt.get("pid"), attempt.get("startTime")) != (gateway.get("pid"), gateway.get("start_time")))
        states, reasons = {}, {}
        for name in FIELDS:
            mismatch_after_restart = restarted_for_this_env and matches.get(name) is False
            loadable = _would_load(name, values, even_ai_enabled)
            if choices.get(name) in {"saving", "save_failed"}:
                states[name] = "save_failed"
            elif current and matches.get(name) is True:
                states[name] = "available_to_test"
            elif not values[name]:
                states[name] = "not_configured"
            elif mismatch_after_restart and loadable:
                states[name] = "unknown"
                reasons[name] = REASON_DIFFERS_AFTER_RESTART
            elif choices.get(name) == "saved" and fresh and (not same_revision or files_match) and loadable:
                states[name] = "saved_not_activated"
            elif fresh and files_match and matches.get(name) is False and loadable:
                # No receipt (terminal wizard, hand-edited .env, an older
                # bundle's save): the live relay loaded something other than
                # this exact disk value, so one restart activates it (#3357).
                states[name] = "saved_not_activated"
            else:
                states[name] = "unknown"
                if name == "evenAi" and not even_ai_enabled:
                    reasons[name] = REASON_EVEN_AI_NOT_ENABLED
        permissions = state["permissions"]
        permission_states = {}
        for key, name in diagnostics.CHOICES.items():
            if choices.get(name) in {"saving", "save_failed"}:
                permission_states[name] = "save_failed"
            elif current and active.get("matches", {}).get(name) is True:
                permission_states[name] = "available_to_test"
            elif choices.get(name) == "saved" and fresh and (not same_revision or files_match):
                permission_states[name] = "saved_not_activated"
            else:
                permission_states[name] = "unknown"
        # Never restart underneath a credential/config writer. A later status
        # can admit the grouped activation once every in-flight save finishes.
        pending = (any(value == "saved_not_activated" for value in (*states.values(), *permission_states.values()))
                   and "saving" not in choices.values())
        admission = row.get("activationRequested") or {}
        admitted_here = (bool(admission) and isinstance(gateway, dict)
                         and admission.get("pid") == gateway.get("pid")
                         and admission.get("startTime") == gateway.get("start_time"))
        port = active.get("relayPort")
        runtime_context = ({"relayPort": port, "pid": gateway.get("pid"),
                            "startTime": gateway.get("start_time"), "revision": row.get("revision")}
                           if current and isinstance(port, int) and not isinstance(port, bool)
                           and 1 <= port <= 65535 else None)
        return {"state": "ready", "capabilities": states, "reasons": reasons, "restartRequired": pending,
                "diagnostics": {"supported": True, **permissions,
                    "activeAccess": (active.get("diagnostics") or {}).get("access") if fresh else None,
                    "activeHandoff": (active.get("diagnostics") or {}).get("handoff") if fresh else None},
                "permissionStates": {name: value for name, value in permission_states.items() if name in choices},
                "activationRequested": admitted_here,
                "revision": row.get("revision"), "runtimeContext": runtime_context}
    except Exception:
        return {"state": "unavailable", "capabilities": {}, "restartRequired": False}


def activation_states(state: dict) -> dict:
    """Include explicitly saved permissions in the existing combined restart."""
    return {**state.get("capabilities", {}), **state.get("permissionStates", {})}


LLM_POLICY_PATH = ("plugins", "entries", "ocuclaw", "llm")


def allow_prediction_model(model_id: str, *, profile_home: Any = None) -> dict:
    """#3359 round 3: let the plugin's PluginLlm override to ONE more model.

    Writes the plugin's own resolved Hermes home (``_home()``, the same home
    the optional-setup saves use): ``plugins.entries.ocuclaw.llm``
    ``allow_model_override: true`` and ``model_id`` appended to
    ``allowed_models``. Never removes or reorders an entry. When the override
    is already on with NO allowlist, PluginLlm reads that as "any model"; a
    one-entry list would NARROW it, so that case is refused, not written.
    A profile other than this home is refused too: its config is not ours.

    PluginLlm resolves this policy on every call ("config edits apply without
    a restart", agent/plugin_llm.py ``_resolve_trust_policy``) and the
    plugin's own reader does too, so no activation step is needed."""
    import copy
    from hermes_cli.config import read_raw_config, save_config

    if not isinstance(model_id, str) or not model_id or model_id == "*":
        return {"status": "policy-denied"}
    home = _home()
    if profile_home is not None and Path(profile_home).resolve() != home.resolve():
        return {"status": "policy-denied"}
    with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
        if not locked:
            return {"status": "error"}
        raw = read_raw_config()
        if not isinstance(raw, dict):
            return {"status": "error"}
        doc = copy.deepcopy(raw)
        node: Any = doc
        for key in LLM_POLICY_PATH:
            if node.get(key) is None:
                node[key] = {}
            node = node[key]
            if not isinstance(node, dict):
                return {"status": "error"}
        if node.get("allow_model_override") is True and not isinstance(node.get("allowed_models"), list):
            return {"status": "policy-denied"}
        allowed = list(node.get("allowed_models") or [])
        if model_id not in allowed:
            allowed.append(model_id)
        node["allow_model_override"] = True
        node["allowed_models"] = allowed
        save_config(doc, strip_defaults=False)
        back: Any = read_raw_config()
        for key in LLM_POLICY_PATH:
            back = back.get(key) if isinstance(back, dict) else None
        if (not isinstance(back, dict) or back.get("allow_model_override") is not True
                or model_id not in (back.get("allowed_models") or [])):
            return {"status": "error"}
    return {"status": "saved", "activation": {"required": False, "mode": "none"}}


def write_even_ai_enabled() -> None:
    """Raw enable through Hermes's config writer with read-back; no receipt."""
    from hermes_cli.config import set_config_value, read_raw_config
    # This supported writer honors managed config; readback catches a no-op.
    set_config_value("platforms.ocuclaw.extra.evenAiEnabled", "true")
    raw = read_raw_config()
    if raw["platforms"]["ocuclaw"]["extra"]["evenAiEnabled"] is not True:
        raise ValueError("save_failed")


#: The refusal line while an admitted restart is still activating saved changes.
SAVE_REFUSED_MESSAGE = (
    "Activation is already in progress. Reconnect and run "
    "hermes ocuclaw optional-setup status before saving again. "
    "Existing successful saves are kept."
)

#: `save_credential`: the Even AI token is saved, its enable did not stick.
ENABLE_FAILED = "even_ai_enable_failed"
#: The line every surface prints for `ENABLE_FAILED`.
ENABLE_FAILED_MESSAGE = (
    "Even AI token saved, but Even AI could not be turned on in config.yaml "
    "(managed configuration?). Turn on evenAiEnabled, then activate."
)

#: Codes `save_credential` raises BEFORE anything is written.
SAVE_REFUSALS = frozenset({"invalid_value", "busy", "activation_pending_reconnect"})


def save_credential(home: Path | None, name: str, value: str) -> bool:
    """The one credential save for the CLI/Desktop form, the phone and the wizard.

    Writes the value when it differs from the on-disk `.env` value and, for
    Even AI, turns on `platforms.ocuclaw.extra.evenAiEnabled` when it is off,
    so a restart can load the token. Both writes share ONE receipt
    transaction (`begin_save` .. `finish_save`). Returns True when anything
    was written. Raises `ValueError(code)`:

    - `SAVE_REFUSALS`: refused before any write; nothing changed.
    - `save_failed`: a write failed; the receipt records `save_failed`.
    - `save_unconfirmed`: the writes succeeded but the receipt could not be
      completed (the lock stayed held); status reports the choice as failed
      until a retry with the same value repairs the receipt.
    - `ENABLE_FAILED` (Even AI only): the token is saved (receipt `saved`)
      but the enable did not stick (a managed `config.yaml`: the writer is a
      no-op or the read-back lacks the key). Status reports the token as
      `unknown` / `even_ai_not_enabled`; a retry with the same token tries
      the enable again.

    `home=None` (no receipt home, terminal wizard only) runs the same writers
    without a receipt; the loaded-runtime observation still detects the save.
    Never logs or returns the value.
    """
    from . import desktop_credentials as credentials

    value = credentials.validate_value(name, value)
    if not value:
        return False
    write_value = not credentials.env_value_matches(name, value)
    enable = name == "evenAi" and not _disk_values()[1]
    if home is None:
        if write_value:
            credentials.write_env_value(name, value)
        if enable:
            try:
                write_even_ai_enabled()
            except Exception:
                raise ValueError(ENABLE_FAILED) from None
        return write_value or enable
    if not (write_value or enable):
        # A previous writer may have succeeded before its receipt completed:
        # the same value again repairs the receipt without replacing it.
        if (_read(home, PENDING).get("choices") or {}).get(name) in {"saving", "save_failed"}:
            revision = begin_save(home, name)
            try:
                finish_save(home, revision, name, saved=True)
            except ValueError:
                raise ValueError("save_unconfirmed") from None
        return False
    revision = begin_save(home, name)  # Refusals raise here, before any write.
    try:
        if write_value:
            credentials.write_env_value(name, value)
    except Exception:
        try:
            finish_save(home, revision, name, saved=False)
        except ValueError:
            pass  # Still `saving`, which status already reports as save_failed.
        raise ValueError("save_failed") from None
    # The token is saved. The enable is a separate outcome: a failure there
    # must not turn a saved token into `save_failed` (a retry with the same
    # token would then skip the write and fail the same way forever).
    enabled = True
    if enable:
        try:
            write_even_ai_enabled()
        except Exception:
            enabled = False
    try:
        finish_save(home, revision, name, saved=True)
    except ValueError:
        raise ValueError("save_unconfirmed") from None
    if not enabled:
        raise ValueError(ENABLE_FAILED)
    return True


def save(selected: str, *, prompt=None, out=None) -> int:
    out = out or sys.stdout
    if selected not in FIELDS:
        return 2
    try:
        home = _home()
        if status(home).get("activationRequested"):
            out.write(SAVE_REFUSED_MESSAGE + "\n")
            return 2
        if prompt is None:
            if not sys.stdin.isatty() or not out.isatty():
                out.write("Use your own interactive terminal for private credential entry.\n")
                return 2
            from hermes_cli.cli_output import prompt
        from . import desktop_credentials
        opened = desktop_credentials.request([selected])
        if opened.get("state") != "pending":
            out.write("Private entry is unavailable or already in use. Keep existing settings and retry.\n")
            return 1
        request_id = desktop_credentials.status(direct=True).get("requestId")
        out.write("Enter privately. Blank keeps an existing value or skips; Ctrl-C cancels.\n")
        try:
            value = prompt(LABELS[selected], password=True)
        except (KeyboardInterrupt, EOFError):
            desktop_credentials.submit(request_id, cancel=True)
            out.write("Cancelled. Existing credentials were kept.\n")
            return 0
        if not str(value or "").strip() and not opened.get("present", {}).get(selected):
            desktop_credentials.submit(request_id, cancel=True)
            out.write("Skipped. Nothing changed.\n")
            return 0
        result = desktop_credentials.submit(request_id, {selected: value or ""})
        if result.get("state") != "saved":
            out.write("Save did not finish. Existing or partially saved choices are kept. If activation was requested, reconnect and run hermes ocuclaw optional-setup status before retrying this choice.\n")
            return 1
        values, enabled = _disk_values()
        if selected == "evenAi" and values["evenAi"] and not enabled:
            # The form keeps a saved token even when its enable did not stick
            # (or a blank entry kept the existing token): try the enable again
            # through the same one-transaction save (value unchanged).
            try:
                save_credential(home, "evenAi", values["evenAi"])
            except ValueError as error:
                if str(error) != ENABLE_FAILED:
                    raise
                out.write(ENABLE_FAILED_MESSAGE + "\n")
                return 1
        # #3359: the same save covers the TypeSafe key, so the line names no one service.
        out.write("Saved. This does not verify that the service accepts the credential. "
                  "Finish your optional saves, then run:\n"
                  "hermes ocuclaw optional-setup status\nhermes ocuclaw optional-setup activate\n")
        return 0
    except Exception:
        out.write("Optional save could not finish. Keep working text chat and retry this choice.\n")
        return 1


def describe_reason(reason: str) -> str:
    """Plain-language line for a `reasons` code (CLI and skill output)."""
    return {
        REASON_DIFFERS_AFTER_RESTART: (
            "Hermes loaded a different value than the one in .env after the restart; "
            "check the gateway's environment (process env, systemd unit or a managed "
            "override wins over .env). Another restart will not change this."),
        REASON_EVEN_AI_NOT_ENABLED: (
            "The Even AI token is saved but platforms.ocuclaw.extra.evenAiEnabled is not "
            "true, so a restart would not activate it. Enable Even AI first."),
    }.get(reason, reason)


def _record_attempt(home: Path) -> None:
    """Best effort: a manual restart handoff still gets the loop breaker."""
    try:
        with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
            if not locked:
                return
            row = _read(home, PENDING)
            gateway, _, live = receipts.read_gateway_state(home=home)
            if live is not True:
                return
            row["activationAttempt"] = _attempt_marker(home, gateway)
            _write(home, PENDING, row)
    except Exception:
        return


#: Printed before the confirm prompt when the activation restart is the
#: Cloudways container bounce (#3357).
CLOUDWAYS_RESTART_WARNING = (
    "This restarts the whole container. SSH will disconnect; reconnect in about a minute. "
    "Your phone reconnects in 1–5 minutes. Active replies are stopped, not finished."
)


def _cloudways_container_restart(gateway) -> bool:
    """Would restarting the running gateway bounce a Cloudways container? False on doubt.

    The CLI half of `restart_rpc`'s Cloudways mode (#3357, Matty 2026-09-23).
    All three must hold: the decisive `cloudways` verdict (never `likely`),
    PID 1 is `/entrypoint.sh`, and the running gateway is PID 1's direct
    child. Then `hermes gateway restart` stops that gateway, the entrypoint
    exits, and Cloudways starts a fresh container with the gateway in it. A
    gateway someone started by hand from a shell has another parent, and
    stopping it would bring nothing back.
    """
    try:
        from .cloudways import DETECT_CLOUDWAYS, _run, detect

        detection = detect()
        if detection.verdict != DETECT_CLOUDWAYS or (detection.signals or {}).get("pid1_entrypoint_sh") is not True:
            return False
        pid = gateway.get("pid") if isinstance(gateway, dict) else None
        if type(pid) is not int or pid <= 1:
            return False
        rc, parent, _ = _run(("ps", "-o", "ppid=", "-p", str(pid)), timeout_s=5.0)
        return rc == 0 and parent.strip() == "1"
    except Exception:  # noqa: BLE001 - an unreadable host is not a Cloudways restart
        return False


def activate(*, confirm=None, out=None) -> int:
    out = out or sys.stdout
    try:
        home = _home()
        from .cloudways_restart_step import restart_plan, restart_gateway
        current = status(home)
        if not current.get("restartRequired"):
            out.write("No verified pending activation. Check optional-setup status; unknown is not activated.\n")
            for name, reason in (current.get("reasons") or {}).items():
                out.write(f"{name}: {describe_reason(reason)}\n")
            return 0 if current.get("state") == "ready" else 1
        if current.get("activationRequested"):
            out.write("Activation was already requested. Reconnect and run optional-setup status; no second restart was sent.\n")
            return 2
        plan = restart_plan()
        timeout_s = getattr(plan, "timeout_s", None)
        container = False
        if plan is None:
            gateway, _, live = receipts.read_gateway_state(home=home)
            container = live is True and _cloudways_container_restart(gateway)
            if container:
                # Bound the restart BEFORE any fence is written: with no bound,
                # `restart_gateway` runs nothing, and a fence written first
                # would refuse every later activate while the key never loads.
                from . import pairing
                timeout_s = pairing._gateway_restart_timeout_s()
                container = timeout_s is not None
        if plan is None and not container:
            # The user restarts by hand; remember what for, so a restart that
            # still leaves the relay on another value is not offered again.
            _record_attempt(home)
            out.write("This host has no supported automatic restart. On Cloudways, restart the agent in its dashboard.\n"
                      "This closes SSH and Hermes. Save your reconnect command first. After reconnecting, run:\n"
                      "hermes ocuclaw optional-setup status\nSaved choices and core pairing are kept.\n")
            return 2
        if container:
            # #3357 (Matty, 2026-09-23): Cloudways has no restart control of its
            # own that this account can reach, so the restart is the container
            # bounce `hermes gateway restart` causes there. Say so first.
            out.write(CLOUDWAYS_RESTART_WARNING + "\n"
                      "Activate all saved optional choices with this restart. This interrupts every profile on this gateway.\n"
                      "After reconnecting run hermes ocuclaw optional-setup status.\n")
        else:
            out.write("Activate all saved optional choices with one gateway restart. This interrupts every profile on this gateway.\n"
                      "Keep your reconnect command. After reconnecting run hermes ocuclaw optional-setup status.\n")
        if confirm is None:
            if not sys.stdin.isatty() or not out.isatty():
                return 2
            confirm = lambda: input("Type ACTIVATE to restart, or Enter to keep the saves pending: ")
        if confirm() != "ACTIVATE":
            out.write("Saved choices remain pending; no restart sent.\n")
            return 0
        with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
            if not locked:
                return 2
            fresh = status(home)
            if (not fresh.get("restartRequired") or fresh.get("revision") != current.get("revision")
                    or fresh.get("activationRequested")):
                out.write("Optional state changed. Check status before choosing activation again.\n")
                return 2
            row = _read(home, PENDING)
            gateway, _, live = receipts.read_gateway_state(home=home)
            if live is not True or not isinstance(gateway, dict):
                return 2
            row["activationRequested"] = _admission(gateway)
            row["activationAttempt"] = _attempt_marker(home, gateway)
            _write(home, PENDING, row)
        # Fence persists before a restart that may terminate this very terminal.
        restarted = restart_gateway(timeout_s)
        out.write("Restart requested. Reconnect and check optional-setup status before testing.\n" if restarted
                  else "Restart could not be confirmed. Check the gateway and optional-setup status; no automatic retry.\n")
        return 0 if restarted else 1
    except (Exception, KeyboardInterrupt, EOFError):
        out.write("Activation not confirmed. Saved choices remain; reconnect and check optional-setup status.\n")
        return 1


def register_cli(subs) -> None:
    parser = subs.add_parser("optional-setup", help="Private optional saves and one explicit activation")
    commands = parser.add_subparsers(dest="optional_action", required=True)
    commands.add_parser("status", help="Read activation state; never installs or restarts")
    save_parser = commands.add_parser("save", help="Privately save one optional credential")
    save_parser.add_argument("optional_choice", choices=tuple(CLI_CHOICES))
    commands.add_parser("activate", help="Review and explicitly activate saved optional choices")


def dispatch(args: argparse.Namespace) -> int:
    if args.optional_action == "save":
        return save(CLI_CHOICES[args.optional_choice])
    if args.optional_action == "activate":
        return activate()
    result = status()
    # stdout stays one JSON object (`| jq .`); the human lines go to stderr.
    print(json.dumps(result, sort_keys=True))
    for name, reason in (result.get("reasons") or {}).items():
        print(f"{name}: {describe_reason(reason)}", file=sys.stderr)
    return 0 if result["state"] == "ready" else 1
