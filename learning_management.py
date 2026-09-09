"""Profile learning policy, with native interpretation and durable leaf CAS."""
from __future__ import annotations

from contextlib import nullcontext
import copy
import hashlib
import json
from pathlib import Path
import re

from .approvals_management import _native as config_native
from .management_profiles import management_profile_home

OPERATIONS = {"learning.read", "learning.update", "learning.receipt", "learning.recover"}
FIELDS = {
    "memoryApproval": ("memory.write_approval",),
    "skillApproval": ("skills.write_approval",),
    "reviewEnabled": ("auxiliary.background_review.enabled",),
    "reviewModel": tuple("auxiliary.background_review." + key for key in ("provider", "model", "base_url", "api_key")),
    "notifications": ("display.memory_notifications",),
}
TIMING = {"memoryApproval": "next_guard_check", "skillApproval": "next_guard_check",
          "reviewEnabled": "next_automatic_review", "reviewModel": "next_review_fork", "notifications": "next_agent_creation"}
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,199}")
PROVIDER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}")


def _native():
    config, managed, _, tx = config_native()
    from agent import background_review
    from tools import write_approval
    # Gate semantics are supplied by the pinned native implementation; the
    # independent proposal compatibility packages may patch its write paths.
    if hashlib.sha256(Path(background_review.__file__).read_bytes()).hexdigest() != "478c5e2b226e1813b7874b7922af66f63e989e2794699e937bacf55f5eb910a0":
        raise ImportError("Unverified native review semantics.")
    if tx is not None and not callable(getattr(tx, "validate_request_window", None)):
        tx = None
    return config, managed, write_approval, background_review, tx


def learning_capabilities():
    try:
        *_, tx = _native()
    except Exception:
        return []
    return [{"operation": op, "scope": "profile", "supported": op == "learning.read" or tx is not None,
             "applyTiming": "future_native_work" if op == "learning.update" else "read_only" if op in ("learning.read", "learning.receipt") else "explicit_reconciliation"}
            for op in sorted(OPERATIONS)]


def _leaf(config, path):
    block = config
    for part in path.split("."):
        if not isinstance(block, dict) or part not in block:
            return {"present": False, "value": None}
        block = block[part]
    return {"present": True, "value": block}


def _model_key(provider, model):
    return provider + "|" + model if (isinstance(provider, str) and PROVIDER.fullmatch(provider)
        and isinstance(model, str) and MODEL.fullmatch(model)) else None


def _main_model(config):
    raw = config.get("model")
    if isinstance(raw, dict):
        return _model_key(raw.get("provider"), raw.get("default"))
    return None


def _models(config, selected):
    from agent.models_dev import list_provider_models
    from hermes_cli.models import CANONICAL_PROVIDERS
    from hermes_cli.config import is_provider_enabled
    rows = []
    seen = set()
    def add(key):
        if key and key not in seen:
            seen.add(key); rows.append(key)
    add(_main_model(config))
    for entry in CANONICAL_PROVIDERS:
        provider = getattr(entry, "slug", None)
        if not isinstance(provider, str) or not PROVIDER.fullmatch(provider):
            continue
        providers = config.get("providers")
        if not is_provider_enabled(providers.get(provider) if isinstance(providers, dict) else None):
            continue
        for model in list_provider_models(provider, allow_network=False):
            add(_model_key(provider, model))
    # Keep the selected entry if it exists in the full native catalog even
    # when the bounded picker would otherwise truncate it.
    if selected in seen:
        rows.remove(selected); rows.insert(0, selected)
    return ["inherit", *rows[:999]], len(rows) > 999


def _route(config, review, task, selected):
    """Resolve a FUTURE fork using configured parent settings, never a live claim."""
    import hermes_cli.runtime_provider as runtime_provider
    parent_key = _main_model(config)
    if parent_key is None:
        return {"state": "unavailable", "model": None}
    provider, model = parent_key.split("|", 1)
    try:
        runtime = runtime_provider.resolve_runtime_provider(requested=provider, target_model=model)
        class Parent:
            def _current_main_runtime(self):
                return runtime
        parent = Parent()
        parent.provider, parent.model = runtime.get("provider") or provider, runtime.get("model") or model
        resolved = review._resolve_review_runtime(parent, task_cfg=task)
        key = _model_key(resolved.get("provider"), resolved.get("model"))
        if key is None:
            return {"state": "unavailable", "model": None}
        state = "inherited" if selected == "inherit" else "resolved" if key == selected else "fallback"
        return {"state": state, "model": key}
    except Exception:
        return {"state": "unavailable", "model": None}


def _capture_config(config, managed, approval, review, tx):
    """Caller holds the config transaction. No catalog or provider resolution."""
    raw = config.require_readable_config_before_write(config.get_config_path())
    managed_dir = managed.get_managed_dir()
    managed_raw = None
    if managed_dir is not None:
        managed_raw = config.require_readable_config_before_write(managed_dir / "config.yaml")
    managed.invalidate_managed_cache()
    effective = config.load_config_readonly()
    paths = [path for group in FIELDS.values() for path in group]
    leaves = tx.read_config_leaves(paths) if tx else {path: _leaf(raw, path) for path in paths}
    # Avoid native fail-open loaders masking unreadable configuration: the
    # strict raw+managed reads above precede the actual behavioral getters.
    enabled, task = review.load_background_review_settings()
    provider, model = task.get("provider"), task.get("model")
    selected = "inherit" if not provider or provider == "auto" or not model else _model_key(provider, model)
    notices = _leaf(effective, FIELDS["notifications"][0])["value"]
    notices = "on" if notices is True else "off" if notices is False else str(notices).lower() if notices else "on"
    future = {"memoryApproval": "on" if approval.write_approval_enabled("memory") else "off",
              "skillApproval": "on" if approval.write_approval_enabled("skills") else "off",
              "reviewEnabled": "on" if enabled else "off", "reviewModel": selected or "unrecognized",
              "notifications": notices if notices in ("on", "off", "verbose") else "unrecognized"}
    result = {}
    for name, group in FIELDS.items():
        entries = [leaves[path] for path in group]
        present = any(row["present"] for row in entries)
        locked = bool(config.is_managed() or any(managed.is_key_managed(path) for path in group))
        saved = None
        if name == "reviewModel":
            saved_provider, saved_model = entries[0].get("value"), entries[1].get("value")
            saved = "inherit" if not saved_provider or saved_provider == "auto" or not saved_model else _model_key(saved_provider, saved_model)
        elif present:
            value = entries[0]["value"]
            if type(value) is bool:
                saved = "on" if value else "off"
            elif isinstance(value, str) and value.lower() in ("on", "off", "true", "false", "yes", "no", "1", "0", "approve", "enabled", "verbose"):
                saved = value.lower()
        revision = hashlib.sha256(json.dumps([row.get("revision", row) for row in entries], sort_keys=True, default=str).encode()).hexdigest()
        result[name] = {"savedPresent": present, "savedState": "absent" if not present else "recognized" if saved is not None else "unrecognized",
                        **({"savedValue": saved} if present and saved is not None else {}),
                        "effectiveValue": future[name], "revision": revision, "writable": tx is not None and not locked,
                        "source": "managed" if locked else "user" if present else "default", "applyTiming": TIMING[name]}
    # Bind every config input, including parent provider settings and managed
    # policy, rather than only the five editable learning leaf groups.
    fingerprint = hashlib.sha256(json.dumps([raw, managed_raw, effective, result],
        sort_keys=True, default=str).encode()).hexdigest()
    return {"fields": result, "effective": copy.deepcopy(effective), "task": copy.deepcopy(task),
            "selected": selected, "fingerprint": fingerprint}


def _capture(*native):
    tx = native[-1]
    with tx.config_transaction() if tx else nullcontext():
        return _capture_config(*native)


def _project(captured, review, *, resolve_route=False):
    effective, task, selected = captured["effective"], captured["task"], captured["selected"]
    options, truncated = _models(effective, selected)
    return {"fields": captured["fields"], "models": options, "modelsTruncated": truncated,
            "selectedModelAvailable": selected in options,
            "futureRoute": _route(effective, review, task, selected) if resolve_route else {"state": "unknown", "model": None},
            "customReviewRoute": bool(task.get("base_url") or task.get("api_key")),
            "currentWork": "unchanged_not_observed", "pendingProposals": "preserved"}


def _snapshot(*native, resolve_route=True):
    captured = _capture(*native)
    projected = _project(captured, native[3], resolve_route=resolve_route)
    current = _capture(*native)
    # A resolved route belongs only to the configuration that was captured
    # before the resolver ran. Never retry network work under the lock.
    return projected if current["fingerprint"] == captured["fingerprint"] else _project(current, native[3])


def _validate(operation, payload):
    if operation == "learning.read":
        if payload not in (None, {}): raise ValueError()
        return
    keys = {"mutationId"}
    if operation == "learning.recover": keys |= {"fields", "confirmed", "producedAtMs", "expiresAtMs"}
    if operation == "learning.update": keys |= {"changes", "expected", "confirmed", "producedAtMs", "expiresAtMs"}
    if not isinstance(payload, dict) or set(payload) != keys or not isinstance(payload.get("mutationId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{12,120}", payload["mutationId"]):
        raise ValueError()
    if operation == "learning.receipt": return
    if payload["confirmed"] is not True: raise ValueError()
    if operation == "learning.recover":
        fields = payload["fields"]
        if not isinstance(fields, list) or not 1 <= len(fields) <= len(FIELDS) or any(name not in FIELDS for name in fields) or len(set(fields)) != len(fields): raise ValueError()
        return
    changes, expected = payload["changes"], payload["expected"]
    if not isinstance(changes, dict) or not changes or not set(changes) <= set(FIELDS) or not isinstance(expected, dict) or set(changes) != set(expected): raise ValueError()
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in expected.values()): raise ValueError()
    for name, value in changes.items():
        if not isinstance(value, str): raise ValueError()
        if name == "reviewModel":
            if value != "inherit" and (value.count("|") != 1 or _model_key(*value.split("|")) != value): raise ValueError()
        elif value not in (("off", "on", "verbose") if name == "notifications" else ("off", "on")): raise ValueError()


def _receipt(raw):
    fields = raw["changedFields"]
    # Never silently drop unknown or incomplete field sets from native receipts.
    names = [name for name, paths in FIELDS.items() if set(paths) <= set(fields)]
    if set(fields) != {path for name in names for path in FIELDS[name]}:
        raise ValueError("Receipt fields do not match learning settings.")
    return {"mutationId": raw["mutationId"], "outcome": raw["outcome"], "changedFields": names}


def handle_learning(rpc, identity, payload):
    def fail(code, snapshot=None):
        return {**identity, "status": "unsupported" if code == "unsupported" else "error", "capabilities": [],
                "errorCode": code, "errorMessage": "Learning settings are unavailable. Read back the selected profile before saving again.",
                **({"learning": snapshot} if snapshot is not None else {})}
    try:
        if identity["scope"] != "profile": raise ValueError()
        _validate(identity["operation"], payload)
    except (ValueError, TypeError, KeyError): return fail("invalid_request")
    home = management_profile_home(rpc, identity["profileId"])
    if home is None: return fail("profile_not_served")
    try:
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
        native = _native()
    except Exception: return fail("unsupported")
    config, managed, approval, review, tx = native
    operation = identity["operation"]
    token = set_hermes_home_override(home)
    secret_token = None
    issued = False
    try:
        secret_token = set_secret_scope(build_profile_secret_scope(home))
        if operation != "learning.read" and tx is None: return fail("unsupported")
        window = {} if operation in ("learning.read", "learning.receipt") else {"produced_at_ms": payload["producedAtMs"], "expires_at_ms": payload["expiresAtMs"]}
        if window:
            # Optional native-operator API must never make remote bounds optional.
            if any(value is None for value in window.values()): return fail("invalid_request")
            tx.validate_request_window(**window)
        receipt = None
        if operation == "learning.read":
            snapshot = _snapshot(*native)
        elif operation == "learning.update":
            captured = _capture(*native)
            snapshot = _project(captured, review)
            changes = payload["changes"]
            if any(snapshot["fields"][name]["revision"] != value for name, value in payload["expected"].items()):
                return fail("config_conflict", snapshot)
            if any(not snapshot["fields"][name]["writable"] for name in changes): return fail("managed_setting", snapshot)
            route = None
            if "reviewModel" in changes:
                selected = changes["reviewModel"]
                if selected not in snapshot["models"]: return fail("model_unavailable", snapshot)
                task = {} if selected == "inherit" else dict(zip(("provider", "model"), selected.split("|")))
                # Native providers may refresh OAuth credentials over the
                # network. Both profile contexts remain active, but no config
                # transaction may cover this call.
                route = _route(captured["effective"], review, task, selected)
            values = {}
            for name, value in changes.items():
                if name == "reviewModel":
                    provider, model = ("auto", "") if value == "inherit" else value.split("|")
                    values.update(dict(zip(FIELDS[name], (provider, model, "", ""))))
                else: values[FIELDS[name][0]] = value if name == "notifications" else value == "on"
            with tx.config_transaction():
                tx.validate_request_window(**window)
                current = _capture_config(*native)
                if current["fingerprint"] != captured["fingerprint"]: return fail("config_conflict")
                if route is not None and route["state"] not in ("inherited", "resolved"):
                    return fail("model_unavailable", snapshot)
                leaves = tx.read_config_leaves(values)
                expected = {path: row["revision"] for path, row in leaves.items()}
                issued = True
                receipt = tx.patch_config_leaves(expected, values, payload["mutationId"], **window)
            snapshot = _snapshot(*native, resolve_route=False)
        elif operation == "learning.recover":
            # Recovery depends on the durable operation, not whether a model
            # provider can currently authenticate or contact its servers.
            issued = True
            receipt = tx.recover_config_mutation(payload["mutationId"], [path for name in payload["fields"] for path in FIELDS[name]], **window)
            snapshot = _snapshot(*native, resolve_route=False)
        else:
            receipt = tx.config_mutation_receipt(payload["mutationId"])
            snapshot = _snapshot(*native, resolve_route=False)
        if receipt is not None: snapshot["receipt"] = _receipt(receipt)
        return {**identity, "status": "ok", "capabilities": [], "learning": snapshot}
    except Exception as exc:
        # A native write/recovery may already have a durable receipt. Keep the
        # phone's original identity pending if subsequent projection fails.
        if issued: return fail("outcome_unknown")
        if tx is not None and isinstance(exc, tx.ConfigRequestExpired): return fail("request_expired")
        if tx is not None and isinstance(exc, tx.ConfigConflict): return fail("config_conflict")
        if tx is not None and isinstance(exc, tx.ConfigManaged): return fail("managed_setting")
        return fail("native_read_failed")
    finally:
        if secret_token is not None:
            reset_secret_scope(secret_token)
        reset_hermes_home_override(token)
