"""Curated profile approval policy over the existing authenticated control link."""
from __future__ import annotations

from contextlib import nullcontext
import hashlib
import importlib
import json
from pathlib import Path
import re

from . import aux_tasks
from .management_profiles import management_profile_home
from .native_compat import probe
from .native_readers import approval_reader

FIELDS = {
    "mode": ("approvals.mode", "_get_approval_mode"),
    "timeoutSeconds": ("approvals.timeout", "_get_approval_timeout"),
    "cronMode": ("approvals.cron_mode", "_get_cron_approval_mode"),
    "oneShotMode": ("approvals.single_query_mode", "_get_single_query_approval_mode"),
    "unattendedMode": ("approvals.unattended_mode", "_get_unattended_approval_mode"),
}
OPERATIONS = {"approvals.read", "approvals.update", "approvals.receipt", "approvals.recover"}
MAX_TIMEOUT = 365 * 24 * 3600

# The model that writes the sentence on glasses approval cards (#5046): the
# "OcuClaw approval explainer" auxiliary task, which inherits `approval`.
# "inherit" writes provider auto and an empty model, base URL and key, the
# same as Hermes' own "Follow Approval". Present only when the host
# registered the task. Pinning a model sends that provider each command, so
# it needs an explicit confirmation like Off and unattended approval do.
EXPLAINER_FIELD = "explainerModel"
EXPLAINER_PATHS = tuple(f"auxiliary.{aux_tasks.APPROVAL_EXPLAIN_TASK}.{key}"
                        for key in ("provider", "model", "base_url", "api_key"))
ALL_FIELDS = (*FIELDS, EXPLAINER_FIELD)
_PROVIDER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,199}")


def _model_key(provider, model):
    """Learning's ``provider|model`` key (learning_management._model_key)."""
    return provider + "|" + model if (isinstance(provider, str) and _PROVIDER.fullmatch(provider)
                                      and isinstance(model, str) and _MODEL.fullmatch(model)) else None


def _route_key(block):
    """``provider|model`` for a pinned auxiliary block, "inherit" when it follows its base."""
    if not isinstance(block, dict):
        return "inherit"
    provider, model = block.get("provider"), block.get("model")
    if not provider or provider == "auto" or not model:
        return "inherit"
    return _model_key(provider, model)


def _leaf(config, path):
    block = config
    for part in path.split("."):
        if not isinstance(block, dict) or part not in block:
            return {"present": False, "value": None}
        block = block[part]
    return {"present": True, "value": block}


def _explainer_snapshot(config, managed_scope, transactions, raw, effective):
    """``(field row, extras)`` for the explainer model."""
    leaves = transactions.read_config_leaves(list(EXPLAINER_PATHS)) if transactions else {
        path: _leaf(raw, path) for path in EXPLAINER_PATHS}
    entries = [leaves[path] for path in EXPLAINER_PATHS]
    present = any(row.get("present") for row in entries)
    selected = _route_key({"provider": entries[0].get("value"), "model": entries[1].get("value")})
    managed = bool(config.is_managed() or any(managed_scope.is_key_managed(path) for path in EXPLAINER_PATHS))
    revision = hashlib.sha256(json.dumps([row.get("revision", row) for row in entries],
                                         sort_keys=True, default=str).encode()).hexdigest()
    row = {
        "savedPresent": present,
        "savedState": "absent" if not present else "recognized" if selected is not None else "unrecognized",
        **({"savedValue": selected} if present and selected is not None else {}),
        "effectiveValue": selected or "unrecognized", "revision": revision,
        "writable": transactions is not None and not managed,
        "source": "managed" if managed else "user" if present else "default",
    }
    try:
        from .learning_management import _models

        models, truncated = _models(effective, selected)
    except Exception:
        models, truncated = ["inherit", *([selected] if selected not in (None, "inherit") else [])], False
    auxiliary = effective.get("auxiliary") if isinstance(effective.get("auxiliary"), dict) else {}
    approval = _route_key(auxiliary.get("approval"))
    custom = any(isinstance(row.get("value"), str) and row["value"] for row in entries[2:])
    return row, {"explainerModels": models, "explainerModelsTruncated": truncated,
                 "approvalModel": "main" if approval in (None, "inherit") else approval,
                 "customExplainerRoute": custom}


def _native():
    import hermes_constants
    from hermes_cli import config, managed_scope
    from tools import approval
    if not callable(getattr(config, "require_readable_config_before_write", None)):
        raise ImportError("Strict native config read is unavailable.")
    transactional = (probe(Path(hermes_constants.__file__).parent, ["config-transactions-v1"])["supported"]
                     and getattr(config, "CONFIG_TRANSACTIONS_API_VERSION", None) == 1
                     and all(getattr(getattr(config, name, None), "__hermes_config_transaction_api__", None) == 1
                             for name in ("load_config", "read_raw_config", "read_user_config_raw", "save_config", "set_config_value", "unset_config_value", "atomic_config_write")))
    transactions = None
    if transactional:
        # This is the separately versioned optional native package, admitted
        # only by exact source/frontend attestation and loaded writer markers.
        transactions = importlib.import_module("hermes_cli.config_transactions")
    return config, managed_scope, approval, transactions


def approvals_capabilities():
    try:
        _, _, _, transactions = _native()
    except (ImportError, AttributeError, OSError):
        return []
    return [{"operation": op, "scope": "profile", "supported": op == "approvals.read" or transactions is not None,
             **({"applyTiming": "subsequent_guard_checks" if op == "approvals.update" else "read_only"} if op != "approvals.recover" else {})}
            for op in sorted(OPERATIONS)]


def _saved_value(name, value):
    # Never echo arbitrary native leaf contents, even from an allowlisted key.
    if name == "timeoutSeconds":
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, str)) and re.fullmatch(r"-?[0-9]{1,12}", str(value)):
            return str(value)
        return None
    if value is False:
        return "false"
    options = {"manual", "smart", "off"} if name == "mode" else {"deny", "approve", "off", "allow", "yes"}
    return value if isinstance(value, str) and value in options else None


def _snapshot(config, managed_scope, approval, transactions):
    raw = config.require_readable_config_before_write(config.get_config_path())
    # Native behavioral loaders deliberately fall back on malformed managed
    # config. An administration surface must not call that a healthy read.
    directory = managed_scope.get_managed_dir()
    if directory is not None:
        managed_path = directory / "config.yaml"
        config.require_readable_config_before_write(managed_path)
    managed_scope.invalidate_managed_cache()
    readers = {name: approval_reader(approval, getter) for name, (_, getter) in FIELDS.items()}
    names = list(readers)
    native_fields = transactions.read_config_leaves([FIELDS[name][0] for name in names]) if transactions else None
    effective = config.load_config_readonly()
    result = {}
    for name in names:
        path, getter = FIELDS[name]
        leaf = path.split(".")[-1]
        raw_block = raw.get("approvals")
        present = isinstance(raw_block, dict) and leaf in raw_block
        value = raw_block[leaf] if present else None
        if name == "mode":
            # Profile policy is deliberately neutral with respect to room and
            # session context; report their separate override scope below.
            block = effective.get("approvals") or {}
            resolved = approval_reader(approval, "_normalize_approval_mode")(block.get("mode", "manual"))
        else:
            resolved = readers[name]()
        saved = _saved_value(name, value) if present else None
        managed = bool(config.is_managed() or managed_scope.is_key_managed(path))
        revision = native_fields[path]["revision"] if native_fields else hashlib.sha256(
            json.dumps([present, value, managed], sort_keys=True, default=str).encode()).hexdigest()
        result[name] = {
            "savedPresent": present,
            "savedState": "absent" if not present else "recognized" if saved is not None else "unrecognized",
            **({"savedValue": saved} if saved is not None else {}),
            "effectiveValue": str(resolved), "revision": revision,
            "writable": transactions is not None and not managed,
            "source": "managed" if managed_scope.is_key_managed(path) else "user" if present else "default",
        }
    try:
        from agent.deadline import MAX_SAFE_TIMEOUT_S
        maximum = min(MAX_TIMEOUT, int(MAX_SAFE_TIMEOUT_S))
    except (ImportError, ValueError, TypeError):
        maximum = MAX_TIMEOUT
    snapshot = {"fields": result, "maxTimeoutSeconds": maximum,
                "applyTiming": "subsequent_guard_checks",
                "processYolo": bool(getattr(approval, "_YOLO_MODE_FROZEN", False)),
                "sessionOverrides": "not_evaluated", "roomOverrides": "not_evaluated",
                # The host has the "OcuClaw approval explainer" model row (#5046).
                "explainerTaskRegistered": aux_tasks.is_registered(aux_tasks.APPROVAL_EXPLAIN_TASK)}
    if snapshot["explainerTaskRegistered"]:
        result[EXPLAINER_FIELD], extras = _explainer_snapshot(config, managed_scope, transactions, raw, effective)
        snapshot.update(extras)
    return snapshot


def _validate(operation, payload, maximum):
    if operation == "approvals.read":
        if payload not in (None, {}):
            raise ValueError("Read has no payload.")
        return
    if not isinstance(payload, dict):
        raise ValueError("Approval payload is required.")
    allowed = {"mutationId"} if operation == "approvals.receipt" else {"mutationId", "fields"} if operation == "approvals.recover" else {"mutationId", "changes", "expected", "confirmations"}
    if set(payload) != allowed or not isinstance(payload.get("mutationId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{12,120}", payload["mutationId"]):
        raise ValueError("Invalid approval mutation identity.")
    if operation == "approvals.receipt":
        return
    if operation == "approvals.recover":
        fields = payload["fields"]
        if (not isinstance(fields, list) or not 1 <= len(fields) <= len(ALL_FIELDS)
                or any(not isinstance(name, str) or name not in ALL_FIELDS for name in fields)
                or len(set(fields)) != len(fields)):
            raise ValueError("Expected changed fields are required for recovery.")
        return
    changes, expected, confirmations = (payload[key] for key in ("changes", "expected", "confirmations"))
    if (not isinstance(changes, dict) or not changes or not set(changes) <= set(ALL_FIELDS)
            or not isinstance(expected, dict) or set(expected) != set(changes)
            or any(not isinstance(v, str) or not re.fullmatch(r"[a-f0-9]{64}", v) for v in expected.values())):
        raise ValueError("Changed fields require their original revisions.")
    risky = set()
    for name, value in changes.items():
        if name == "timeoutSeconds":
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
                raise ValueError("Timeout must be a positive supported number of seconds.")
        elif name == EXPLAINER_FIELD:
            if not isinstance(value, str) or (value != "inherit" and (
                    value.count("|") != 1 or _model_key(*value.split("|")) != value)):
                raise ValueError("Invalid explainer model.")
            if value != "inherit":
                risky.add(name)
        else:
            options = {"manual", "smart", "off"} if name == "mode" else {"deny", "approve"}
            if not isinstance(value, str) or value not in options:
                raise ValueError("Invalid approval policy.")
            if value == ("off" if name == "mode" else "approve"):
                risky.add(name)
    if not isinstance(confirmations, list) or any(not isinstance(name, str) for name in confirmations) or len(confirmations) != len(set(confirmations)) or set(confirmations) != risky:
        raise ValueError("Explicit confirmation is required for Off, unattended approval and a pinned explainer model.")


def handle_approvals(rpc, identity, payload):
    def fail(code, status="error", approvals=None):
        messages = {
            "invalid_request": "Invalid approval change. Check the fields and confirmations.",
            "unsupported": "Saving approval policy is unavailable in this Hermes integration.",
            "profile_not_served": "This profile is not served by the connected gateway.",
            "native_read_failed": "Hermes could not read the approval policy. Check native configuration.",
            "managed_setting": "These settings are managed by the administrator.",
            "config_conflict": "A changed field was edited elsewhere. Refresh and review your draft before saving.",
            "native_write_failed": "Hermes rejected the save. No successful write was confirmed.",
            "outcome_unknown": "Save outcome is unknown. Check its receipt and current saved state before making another change.",
            "model_unavailable": "That model is no longer available. Refresh and pick another.",
        }
        return {**identity, "status": status, "errorCode": code, "errorMessage": messages[code], "capabilities": [],
                **({"approvals": approvals} if approvals is not None else {})}
    if identity["scope"] != "profile":
        return fail("invalid_request")
    try:
        _validate(identity["operation"], payload, MAX_TIMEOUT)
    except ValueError:
        return fail("invalid_request")
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return fail("profile_not_served")
    try:
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        config, managed_scope, approval, transactions = _native()
    except (ImportError, AttributeError):
        return fail("unsupported", "unsupported")
    token = set_hermes_home_override(home)
    mutation_call_started = False
    try:
        with transactions.config_transaction() if transactions else nullcontext():
            try:
                snapshot = _snapshot(config, managed_scope, approval, transactions)
            except Exception:
                return fail("native_read_failed")
            operation = identity["operation"]
            if operation != "approvals.read" and transactions is None:
                return fail("unsupported", "unsupported", snapshot)
            if operation == "approvals.update":
                try:
                    _validate(operation, payload, snapshot["maxTimeoutSeconds"])
                    if not set(payload["changes"]) <= set(snapshot["fields"]):
                        return fail("unsupported", "unsupported", snapshot)
                    changes = payload["changes"]
                    expected = {FIELDS[name][0]: value for name, value in payload["expected"].items() if name in FIELDS}
                    values = {FIELDS[name][0]: value for name, value in changes.items() if name in FIELDS}
                    if EXPLAINER_FIELD in changes:
                        # One field over four leaves: check its group revision
                        # here, then hand the native writer each leaf's own,
                        # all under the same config transaction.
                        choice, row = changes[EXPLAINER_FIELD], snapshot["fields"][EXPLAINER_FIELD]
                        if choice not in snapshot["explainerModels"]:
                            return fail("model_unavailable", approvals=snapshot)
                        if payload["expected"][EXPLAINER_FIELD] != row["revision"]:
                            return fail("config_conflict", approvals=snapshot)
                        if not row["writable"]:
                            return fail("managed_setting", approvals=snapshot)
                        leaves = transactions.read_config_leaves(list(EXPLAINER_PATHS))
                        expected.update({path: leaves[path]["revision"] for path in EXPLAINER_PATHS})
                        provider, model = ("auto", "") if choice == "inherit" else choice.split("|")
                        values.update(zip(EXPLAINER_PATHS, (provider, model, "", "")))
                    mutation_call_started = True
                    receipt = transactions.patch_config_leaves(expected, values, payload["mutationId"])
                except transactions.ConfigConflict:
                    return fail("config_conflict", approvals=_snapshot(config, managed_scope, approval, transactions))
                except transactions.ConfigManaged:
                    return fail("managed_setting", approvals=snapshot)
                except transactions.ConfigOutcomeUnknown:
                    return fail("outcome_unknown")
                except ValueError:
                    return fail("outcome_unknown" if mutation_call_started else "invalid_request")
                except Exception:
                    # An unexpected native error may follow its durable write
                    # or committed journal (including receipt readback). Keep
                    # the mutation identity for read-only reconciliation.
                    return fail("outcome_unknown")
                try:
                    snapshot = _snapshot(config, managed_scope, approval, transactions)
                except Exception:
                    return fail("outcome_unknown")
                snapshot["receipt"] = _public_receipt(receipt)
            elif operation == "approvals.recover":
                mutation_call_started = True
                try:
                    receipt = transactions.recover_config_mutation(payload["mutationId"], _field_paths(payload["fields"]))
                    snapshot = _snapshot(config, managed_scope, approval, transactions)
                    snapshot["receipt"] = _public_receipt(receipt)
                except Exception:
                    return fail("outcome_unknown")
            elif operation == "approvals.receipt":
                try:
                    snapshot["receipt"] = _public_receipt(transactions.config_mutation_receipt(payload["mutationId"]))
                except Exception:
                    return fail("outcome_unknown")
            return {**identity, "status": "ok", "capabilities": approvals_capabilities(), "approvals": snapshot}
    except Exception:
        return fail("outcome_unknown" if mutation_call_started else "native_read_failed")
    finally:
        reset_hermes_home_override(token)


def _field_paths(names):
    paths = []
    for name in names:
        paths.extend(EXPLAINER_PATHS if name == EXPLAINER_FIELD else (FIELDS[name][0],))
    return paths


def _public_receipt(receipt):
    reverse = {value[0]: key for key, value in FIELDS.items()}
    reverse.update({path: EXPLAINER_FIELD for path in EXPLAINER_PATHS})
    names = []
    for path in receipt["changedFields"]:
        name = reverse.get(path)
        if name is not None and name not in names:
            names.append(name)
    return {"mutationId": receipt["mutationId"], "outcome": receipt["outcome"], "changedFields": names}
