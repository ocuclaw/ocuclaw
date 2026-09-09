"""Remembered command permissions and native deny rules, profile scoped."""
from __future__ import annotations

import hashlib
import json
import re
from contextlib import nullcontext
from pathlib import Path

from .approvals_management import _native as approval_native
from .management_profiles import management_profile_home
from .native_compat import probe

OPERATIONS = {"permissions.read", "permissions.revoke", "permissions.receipt", "permissions.recover",
              "permissions.preview", "deny.add", "deny.edit", "deny.remove"}
PATHS = {"remembered": "command_allowlist", "deny": "approvals.deny"}


def _text_length(value):
    return len(value.encode("utf-16-le")) // 2


def _native():
    config, managed, approval, transactions = approval_native()
    import hermes_constants
    from hermes_cli.approvals_test import evaluate_command
    current = (transactions is not None and probe(Path(hermes_constants.__file__).parent, ["permissions-v1"])["supported"]
        and getattr(evaluate_command, "__hermes_permissions_api__", None) == 1
        and all(getattr(getattr(approval, name, None), "__hermes_permissions_api__", None) == 1
                for name in ("is_approved", "_command_matches_permanent_allowlist", "approve_permanent", "save_permanent_allowlist")))
    return config, managed, approval, transactions if current else None


def permissions_capabilities():
    try:
        _, _, _, tx = _native()
    except (ImportError, AttributeError, OSError):
        return []
    return [{"operation": op, "scope": "profile", "supported": op == "permissions.read" or tx is not None,
             "applyTiming": "read_only" if op in {"permissions.read", "permissions.preview", "permissions.receipt"} else "subsequent_guard_checks"}
            for op in sorted(OPERATIONS)]


def _snapshot(config, managed, approval, tx):
    raw = config.require_readable_config_before_write(config.get_config_path())
    directory = managed.get_managed_dir()
    if directory is not None:
        config.require_readable_config_before_write(directory / "config.yaml")
    managed.invalidate_managed_cache()
    if tx:
        from tools.permission_management import current_allowlist
        current_allowlist()
    effective = config.load_config_readonly()
    leaves = tx.read_config_leaves(list(PATHS.values())) if tx else {}
    lists = {}
    for kind, path in PATHS.items():
        value = raw.get("command_allowlist") if kind == "remembered" else (raw.get("approvals") or {}).get("deny")
        values = value if value is not None else []
        resolved = effective.get("command_allowlist") if kind == "remembered" else (effective.get("approvals") or {}).get("deny")
        resolved = resolved if resolved is not None else []
        if any(not isinstance(rows, list) or len(rows) > 200 or any(not isinstance(v, str) or _text_length(v) > 512 for v in rows) for rows in (values, resolved)):
            raise ValueError("Native rules exceed the supported string-list format.")
        locked = bool(config.is_managed() or managed.is_key_managed(path))
        # Show the effective native list, identifying a managed replacement.
        # Never let an effective managed row index mutate a different raw list.
        entries = []
        for index, pattern in enumerate(resolved):
            semantics = "case_insensitive_native_glob" if kind == "deny" else "native_class_alias" if pattern in approval._PATTERN_KEY_ALIASES else "case_sensitive_command_glob" if any(c in pattern for c in "*?[") else "exact_command"
            entries.append({"index": index, "pattern": pattern, "semantics": semantics,
                            "effect": "ignored_empty" if not pattern.strip() else "eligible"})
        revision = leaves[path]["revision"] if tx else hashlib.sha256(json.dumps([values, locked]).encode()).hexdigest()
        lists[kind] = {"entries": entries, "revision": revision,
            "writable": tx is not None and not locked and values == resolved,
            "source": "managed" if managed.is_key_managed(path) else "user" if value is not None else "default"}
    result = {**lists, "cacheEffect": "fresh_profile_each_guard" if tx else "unverified_cached_policy",
            "sessionGrantEffect": "unchanged", "applyTiming": "subsequent_guard_checks",
            "mode": approval._normalize_approval_mode((effective.get("approvals") or {}).get("mode", "manual")),
            "processYolo": bool(approval._YOLO_MODE_FROZEN)}
    if len(json.dumps(result, ensure_ascii=True).encode()) > 750_000:
        raise ValueError("Native rule lists exceed the bounded management response.")
    return result


def _validate(operation, payload):
    if operation == "permissions.read":
        if payload not in (None, {}):
            raise ValueError()
        return
    if not isinstance(payload, dict):
        raise ValueError()
    if operation == "permissions.preview":
        if set(payload) != {"command"} or not isinstance(payload["command"], str) or not 1 <= _text_length(payload["command"]) <= 512 or "\x00" in payload["command"]:
            raise ValueError()
        return
    keys = {"mutationId"}
    if operation == "permissions.recover":
        keys |= {"kind"}
    elif operation != "permissions.receipt":
        keys |= {"revision", "confirmed"}
        if operation != "deny.add": keys |= {"index"}
        if operation in {"deny.add", "deny.edit"}: keys |= {"pattern"}
    if set(payload) != keys or not isinstance(payload["mutationId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{12,120}", payload["mutationId"]):
        raise ValueError()
    if operation == "permissions.recover":
        if payload["kind"] not in PATHS: raise ValueError()
    elif operation != "permissions.receipt":
        if not isinstance(payload["revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", payload["revision"]): raise ValueError()
        if payload["confirmed"] is not True: raise ValueError()
        if "index" in keys and (type(payload["index"]) is not int or not 0 <= payload["index"] < 200): raise ValueError()
        if "pattern" in keys and (not isinstance(payload["pattern"], str) or not payload["pattern"].strip() or _text_length(payload["pattern"]) > 512 or any(ord(c) < 32 for c in payload["pattern"])): raise ValueError()


def _receipt(receipt):
    return {"mutationId": receipt["mutationId"], "outcome": receipt["outcome"],
            "changedFields": [kind for kind, path in PATHS.items() if path in receipt["changedFields"]]}


def handle_permissions(rpc, identity, payload):
    def fail(code, status="error", snapshot=None):
        messages = {"invalid_request": "Review the selected rule and confirmation.",
            "unsupported": "Editing permission rules and previewing commands are unavailable in this Hermes integration.",
            "profile_not_served": "This profile is not served by the connected gateway.",
            "native_read_failed": "Hermes could not read supported native rule lists.",
            "managed_setting": "These rules are managed or cannot be edited on this host.",
            "config_conflict": "This rule list changed elsewhere. Refresh and review it before editing.",
            "outcome_unknown": "The change outcome is unknown. Check its receipt before another edit."}
        return {**identity, "status": status, "errorCode": code, "errorMessage": messages[code], "capabilities": [],
                **({"permissions": snapshot} if snapshot else {})}
    try:
        if identity["scope"] != "profile": raise ValueError()
        _validate(identity["operation"], payload)
    except (ValueError, TypeError, KeyError):
        return fail("invalid_request")
    home = management_profile_home(rpc, identity["profileId"])
    if home is None: return fail("profile_not_served")
    try:
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        config, managed, approval, tx = _native()
    except (ImportError, AttributeError):
        return fail("unsupported", "unsupported")
    token = set_hermes_home_override(home)
    issued = False
    try:
        with tx.config_transaction() if tx else nullcontext():
            snapshot = _snapshot(config, managed, approval, tx)
            operation = identity["operation"]
            if operation != "permissions.read" and tx is None: return fail("unsupported", "unsupported", snapshot)
            if operation == "permissions.preview":
                from hermes_cli.approvals_test import evaluate_command
                import contextvars
                import uuid
                def preview_profile():
                    profile_token = set_hermes_home_override(home)
                    session_token = approval.set_current_session_key("permission-preview-" + str(uuid.uuid4()))
                    try:
                        return evaluate_command(payload["command"], env_type="local")
                    finally:
                        approval.reset_current_session_key(session_token)
                        reset_hermes_home_override(profile_token)
                result = contextvars.Context().run(preview_profile)
                snapshot["preview"] = {"command": payload["command"], "verdict": result["verdict"], "environment": "local", "sessionEvaluated": False}
            elif operation == "permissions.receipt":
                snapshot["receipt"] = _receipt(tx.config_mutation_receipt(payload["mutationId"]))
            elif operation == "permissions.recover":
                issued = True
                receipt = tx.recover_config_mutation(payload["mutationId"], [PATHS[payload["kind"]]])
                snapshot = _snapshot(config, managed, approval, tx)
                snapshot["receipt"] = _receipt(receipt)
            elif operation != "permissions.read":
                kind = "remembered" if operation == "permissions.revoke" else "deny"
                row = snapshot[kind]
                if not row["writable"]: return fail("managed_setting", snapshot=snapshot)
                if payload["revision"] != row["revision"]: return fail("config_conflict", snapshot=snapshot)
                values = [entry["pattern"] for entry in row["entries"]]
                if operation == "deny.add":
                    if len(values) >= 200: return fail("invalid_request")
                    values.append(payload["pattern"])
                else:
                    if payload["index"] >= len(values): return fail("invalid_request")
                    if operation == "deny.edit": values[payload["index"]] = payload["pattern"]
                    else: values.pop(payload["index"])
                issued = True
                receipt = tx.patch_config_leaves({PATHS[kind]: payload["revision"]}, {PATHS[kind]: values}, payload["mutationId"])
                snapshot = _snapshot(config, managed, approval, tx)
                snapshot["receipt"] = _receipt(receipt)
            return {**identity, "status": "ok", "capabilities": permissions_capabilities(), "permissions": snapshot}
    except Exception as exc:
        if tx and isinstance(exc, tx.ConfigConflict): return fail("config_conflict")
        if tx and isinstance(exc, tx.ConfigManaged): return fail("managed_setting")
        return fail("outcome_unknown" if issued else "native_read_failed")
    finally:
        reset_hermes_home_override(token)
