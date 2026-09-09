"""Served-profile tool blocks and installed skills over native transactions."""
from __future__ import annotations

import hashlib
import importlib
import json
import re
import time
from contextlib import contextmanager
from pathlib import Path

from .management_profiles import management_profile_home
from .native_compat import probe

OPERATIONS = {"tools.read", "tools.block", "tools.skillToggle", "tools.receipt", "tools.recover"}
GROUPS = {"web": "web", "files": "file", "terminal": "terminal"}


def validate_intent(payload):
    produced, expires = payload.get("producedAtMs"), payload.get("expiresAtMs")
    now = int(time.time() * 1000)
    if type(produced) is not int or type(expires) is not int or not 0 <= produced <= now + 5000 or not 0 < expires - produced <= 30000 or expires <= now:
        raise ValueError("This change expired before native admission. Your draft was not saved; review and submit again.")


@contextmanager
def settings_tools_context(home):
    """Both profile settings entry points share the native config lock."""
    try:
        import hermes_constants
        if not probe(Path(hermes_constants.__file__).parent, ["config-transactions-v1"])["supported"]:
            raise ImportError()
        tx = importlib.import_module("hermes_cli.config_transactions")
        set_home = hermes_constants.set_hermes_home_override
        reset_home = hermes_constants.reset_hermes_home_override
    except (ImportError, AttributeError, OSError):
        yield None
        return
    token = set_home(home)
    try:
        with tx.config_transaction():
            yield tx
    finally:
        reset_home(token)


def _native():
    import hermes_constants
    from hermes_cli import config
    if not probe(Path(hermes_constants.__file__).parent, ["tools-management-v1"])["supported"]:
        raise ImportError("Native compatibility is required")
    # Separately versioned optional APIs are admitted by exact package hashes,
    # rather than pretending they are part of the certified native baseline.
    tx = importlib.import_module("hermes_cli.config_transactions")
    phone_tools = importlib.import_module("hermes_cli.phone_tools")
    if phone_tools.API_VERSION != 1:
        raise ImportError("Native tool API version is unsupported")
    if getattr(config, "CONFIG_TRANSACTIONS_API_VERSION", None) != 1 or not all(
        getattr(getattr(config, name, None), "__hermes_config_transaction_api__", None) == 1
        for name in ("load_config", "read_raw_config", "read_user_config_raw", "save_config", "set_config_value", "unset_config_value", "atomic_config_write")
    ):
        raise ImportError("Loaded native configuration writers require restart")
    return config, tx, phone_tools


def tools_capabilities():
    try:
        _native()
        supported = True
    except (ImportError, AttributeError, OSError):
        supported = False
    from .stock_management import tools_available
    reads_supported = supported or tools_available()
    return [{"operation": op, "scope": "profile", "supported": supported or (op == "tools.read" and reads_supported),
             "applyTiming": "read_only" if op in {"tools.read", "tools.receipt"} else "new_chat"} for op in sorted(OPERATIONS)]


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _paths(platform):
    if not isinstance(platform, str) or not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", platform):
        raise ValueError()
    return {"blocks": "agent.disabled_toolsets", "skills": f"skills.platform_disabled.{platform}"}


def _capture(config, tx, platform):
    """Caller holds config_transaction; no tool eligibility or cache locks."""
    paths = _paths(platform)
    config.require_readable_config_before_write(config.get_config_path())
    leaves = tx.read_config_leaves([*paths.values(), "skills.disabled"])
    effective = config.load_config_readonly()
    return leaves, effective, _digest([leaves, effective])


def _snapshot(config, tx, native, platform, *, check_availability=True):
    with tx.config_transaction():
        leaves, effective, stamp = _capture(config, tx, platform)
    # Native browser eligibility takes its own provider cache lock and reads
    # config. Holding config_transaction here inverts gateway warmup's locks.
    with native.profile_tool_context():
        result = _snapshot_scoped(native, platform, leaves, effective, check_availability)
    with tx.config_transaction():
        if _capture(config, tx, platform)[2] != stamp:
            raise tx.ConfigConflict()
    return result, leaves, stamp


def _snapshot_scoped(native, platform, leaves, effective, check_availability):
    paths = _paths(platform)
    def names(value):
        if value is None: return []
        if not isinstance(value, list) or len(value) > 500 or any(not isinstance(item, str) or len(item) > 160 for item in value):
            raise ValueError("Unsupported native list")
        return value
    disabled = names((effective.get("skills") or {}).get("disabled"))
    local = names(((effective.get("skills") or {}).get("platform_disabled") or {}).get(platform))
    blocks = names((effective.get("agent") or {}).get("disabled_toolsets"))
    tools = native.tool_roster(effective, platform) if check_availability else [
        {"id": key, "blocked": group in blocks, "availableTools": None, "state": "not_checked"}
        for key, group in GROUPS.items()]
    catalog = native.installed_skills(effective)
    block_leaf, skill_leaf = leaves[paths["blocks"]], leaves[paths["skills"]]
    block_writable = not block_leaf["managed"] and names(block_leaf.get("value")) == blocks
    skill_writable = not skill_leaf["managed"] and names(skill_leaf.get("value")) == local
    revision = _digest([skill_leaf["revision"], leaves["skills.disabled"]["revision"], catalog, local, disabled])
    for row in tools:
        row["writable"] = block_writable
    for row in catalog:
        inherited = row["name"] in disabled and not row["essential"]
        row.update(enabled=row["essential"] or row["name"] not in set(disabled + local),
                   globalBlocked=inherited, writable=skill_writable and not inherited and not row["essential"])
    result = {"platform": platform, "blocksRevision": block_leaf["revision"], "skillsRevision": revision,
              "applyTiming": "new_chat", "refresh": "reload_skills_then_new_chat", "tools": tools, "installedSkills": catalog}
    if len(json.dumps(result).encode()) > 500_000:
        raise ValueError("Catalog exceeds supported size")
    return result


def _validate(op, value):
    if op == "tools.read":
        if value not in (None, {}): raise ValueError()
        return
    if not isinstance(value, dict): raise ValueError()
    keys = {"mutationId"}
    if op == "tools.recover": keys |= {"kind", "confirmed"}
    elif op in {"tools.block", "tools.skillToggle"}:
        keys |= {"name", "revision", "value", "confirmed"}
    if op != "tools.receipt": keys |= {"producedAtMs", "expiresAtMs"}
    if set(value) != keys or not isinstance(value["mutationId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{12,120}", value["mutationId"]): raise ValueError()
    if op == "tools.receipt": return
    if value["confirmed"] is not True: raise ValueError()
    if op == "tools.recover":
        if value["kind"] not in {"blocks", "skills"}: raise ValueError()
        return
    if type(value["value"]) is not bool or not isinstance(value["revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["revision"]): raise ValueError()
    if not isinstance(value["name"], str) or not 1 <= len(value["name"]) <= 160: raise ValueError()
    if op == "tools.block" and value["name"] not in GROUPS: raise ValueError()


def handle_tools(rpc, identity, payload):
    messages = {"invalid_request": "Review this change and confirmation.", "unsupported": "Tool settings are read only in this Hermes integration.",
        "profile_not_served": "This profile is not served by the connected gateway.", "native_read_failed": "Hermes could not read this profile's native tool catalog.",
        "managed_setting": "This setting is inherited, essential, or managed and cannot be changed here.",
        "config_conflict": "Settings or installed skills changed elsewhere. Refresh and review your change.",
        "outcome_unknown": "The change outcome is unknown. Check its receipt before another edit."}
    messages["intent_expired"] = "This change expired before native admission. Review current settings before another change."
    def fail(code, snapshot=None):
        return {**identity, "status": "unsupported" if code == "unsupported" else "error", "capabilities": [],
                "errorCode": code, "errorMessage": messages[code], **({"tools": snapshot} if snapshot else {})}
    try:
        if identity["scope"] != "profile": raise ValueError()
        _validate(identity["operation"], payload)
    except (KeyError, ValueError, TypeError): return fail("invalid_request")
    home = management_profile_home(rpc, identity["profileId"])
    if home is None: return fail("profile_not_served")
    try:
        config, tx, native = _native()
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    except (ImportError, AttributeError, OSError):
        if identity["operation"] != "tools.read":
            return fail("unsupported")
        try:
            from .stock_management import tools_snapshot
            return {**identity, "status": "ok", "capabilities": [],
                    "tools": tools_snapshot(rpc, identity["profileId"])}
        except Exception:
            return fail("native_read_failed")
    token = set_hermes_home_override(home)
    issued = False
    try:
        platform = rpc._platform_name
        paths = _paths(platform)
        op = identity["operation"]
        if op not in {"tools.read", "tools.receipt"}:
            try: validate_intent(payload)
            except ValueError: return fail("intent_expired")
        snapshot, leaves, stamp = _snapshot(config, tx, native, platform,
            check_availability=op not in {"tools.receipt", "tools.recover"})
        receipt = None
        with tx.config_transaction():
            if op not in {"tools.read", "tools.receipt"}:
                try: validate_intent(payload)
                except ValueError: return fail("intent_expired")
            if _capture(config, tx, platform)[2] != stamp:
                return fail("config_conflict")
            if op == "tools.receipt": receipt = tx.config_mutation_receipt(payload["mutationId"])
            elif op == "tools.recover":
                try: validate_intent(payload)
                except ValueError: return fail("intent_expired")
                issued = True
                receipt = tx.recover_config_mutation(payload["mutationId"], [paths[payload["kind"]]])
            elif op != "tools.read":
                kind = "blocks" if op == "tools.block" else "skills"
                if payload["revision"] != snapshot[kind + "Revision"]: return fail("config_conflict", snapshot)
                row = next((r for r in snapshot["tools" if kind == "blocks" else "installedSkills"] if r["id" if kind == "blocks" else "name"] == payload["name"]), None)
                if row is None: return fail("config_conflict", snapshot)
                if not row["writable"]: return fail("managed_setting", snapshot)
                path = paths[kind]
                values = set(leaves[path].get("value") or [])
                name = GROUPS[payload["name"]] if kind == "blocks" else payload["name"]
                disable = payload["value"] if kind == "blocks" else not payload["value"]
                if disable: values.add(name)
                else: values.discard(name)
                try: validate_intent(payload)
                except ValueError: return fail("intent_expired")
                issued = True
                receipt = tx.patch_config_leaves({path: leaves[path]["revision"]}, {path: sorted(values)}, payload["mutationId"])
        if receipt is not None:
            snapshot, _, _ = _snapshot(config, tx, native, platform,
                check_availability=op not in {"tools.receipt", "tools.recover"})
            snapshot["receipt"] = {"mutationId": receipt["mutationId"], "outcome": receipt["outcome"],
                "changedFields": [kind for kind, path in paths.items() if path in receipt["changedFields"]]}
        return {**identity, "status": "ok", "capabilities": [], "tools": snapshot}
    # Once native issuance begins, a failure during unlocked readback is not
    # a definitive rejection. Keep the original ID available for receipt recovery.
    except tx.ConfigConflict: return fail("outcome_unknown" if issued else "config_conflict")
    except tx.ConfigManaged: return fail("outcome_unknown" if issued else "managed_setting")
    except tx.ConfigOutcomeUnknown: return fail("outcome_unknown")
    except Exception: return fail("outcome_unknown" if issued else "native_read_failed")
    finally: reset_hermes_home_override(token)
