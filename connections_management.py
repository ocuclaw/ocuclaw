"""Existing native connections over the authenticated OcuClaw control link."""
import importlib
from pathlib import Path
import re
import threading
import time

from .management_profiles import management_profile_home
from .native_compat import probe

READS = {"connections.read", "connections.receipt", "mcp.testStatus", "mcp.oauthStatus"}
OPERATIONS = READS | {"mcp.enabled", "mcp.test", "mcp.oauthStart", "mcp.oauthCancel",
                      "channels.enabled", "channels.pauseReconnect", "channels.resumeReconnect"}
ERRORS = {
    "invalid_request": "Review this connection action and confirmation.",
    "unsupported": "Connection management is unavailable in this Hermes integration.",
    "profile_not_served": "This profile is not served by the connected gateway.",
    "native_read_failed": "Hermes could not read this profile's native connections.",
    "config_conflict": "This connection changed elsewhere. Refresh and review the action.",
    "managed_setting": "This connection is inherited or managed and cannot be changed here.",
    "intent_expired": "This action expired before native admission. Review and submit again.",
    "management_path_protected": "The active OcuClaw management connection cannot be disabled or paused here.",
    "runtime_unavailable": "This profile has no supported live gateway connection owner.",
    "reconnect_not_applicable": "Reconnect control applies only to failed retry queues, not healthy connected channels.",
    "oauth_transport_unsupported": "Reauthentication needs a supported installed HTTP connection and an existing configured native callback route.",
    "test_unsupported": "Use an installed native command that does not bootstrap or update software before testing here.",
    "oauth_busy": "A native authorization flow is already active for this connection, or its pending limit was reached.",
    "operation_busy": "Too many connection actions are already running for this profile.",
    "not_found": "This connection or operation is no longer available.",
    "identity_conflict": "This action identity was already used. Check its original receipt.",
    "outcome_unknown": "The action outcome is unknown. Check its original receipt before another action.",
}


def _native():
    import hermes_constants
    if not probe(Path(hermes_constants.__file__).parent, ["connections-management-v1"])["supported"]:
        raise ImportError()
    from hermes_cli import config
    tx = importlib.import_module("hermes_cli.config_transactions")
    from tools.mcp_oauth import HermesTokenStorage
    if (getattr(config, "CONFIG_TRANSACTIONS_API_VERSION", None) != 1 or
            any(getattr(getattr(config, name, None), "__hermes_config_transaction_api__", None) != 1
                for name in ("load_config", "read_raw_config", "read_user_config_raw", "save_config", "set_config_value", "unset_config_value", "atomic_config_write")) or
            any(getattr(getattr(HermesTokenStorage, name, None), "__hermes_connection_credentials_api__", None) != 1
                for name in ("get_tokens", "set_tokens", "get_client_info", "set_client_info", "save_oauth_metadata", "remove", "restore"))):
        raise ImportError()
    modules = [importlib.import_module("hermes_cli." + name) for name in
               ("phone_connections", "connection_operations", "phone_connections_oauth", "phone_channels")]
    if any(module.API_VERSION != 1 for module in modules):
        raise ImportError()
    return tx, *modules


def capabilities():
    try:
        _native()
        supported = True
    except (ImportError, AttributeError, OSError):
        supported = False
    return [{"operation": op, "scope": "profile", "supported": supported,
             "applyTiming": "read_only" if op in READS else "restart_required" if op == "channels.enabled"
             else "new_session_or_restart" if op in {"mcp.enabled", "mcp.oauthStart"} else "active_now"}
            for op in sorted(OPERATIONS)]


def _validate(op, payload):
    if op == "connections.read":
        if payload not in (None, {}):
            raise ValueError()
        return
    if not isinstance(payload, dict):
        raise ValueError()
    keys = {"mutationId"}
    if op not in READS:
        keys |= {"confirmed", "producedAtMs", "expiresAtMs"}
        if op != "mcp.oauthCancel":
            keys |= {"name", "revision"}
        if op in {"mcp.enabled", "channels.enabled"}:
            keys |= {"value"}
    if set(payload) != keys or not isinstance(payload.get("mutationId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{12,120}", payload["mutationId"]):
        raise ValueError()
    if op in READS:
        return
    if payload["confirmed"] is not True:
        raise ValueError()
    if op != "mcp.oauthCancel":
        if (not isinstance(payload["name"], str) or not payload["name"].strip() or len(payload["name"]) > 160
                or any(ord(c) < 32 for c in payload["name"]) or not isinstance(payload["revision"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", payload["revision"])):
            raise ValueError()
    if "value" in keys and type(payload["value"]) is not bool:
        raise ValueError()


def _test(home, name, revision, key, native, operations, tx):
    try:
        from hermes_cli.mcp_config import _probe_single_server, _oauth_tokens_present
        from tools.mcp_oauth import suppress_interactive_oauth
        with native.profile_context(home):
            cfg, _, _ = native.capture_server(name, revision)
            if not native.test_support(cfg)[0]:
                raise ValueError("test_unsupported")
            if cfg.get("auth") == "oauth" and not _oauth_tokens_present(name):
                operations.finish(home, key, "failed", errorCode="oauth_required")
                return
            # Native token refresh may run, but testing never starts browser auth.
            with suppress_interactive_oauth():
                found = _probe_single_server(name, cfg, connect_timeout=30)
            native.capture_server(name, revision)
            if cfg.get("auth") == "oauth" and not _oauth_tokens_present(name):
                operations.finish(home, key, "failed", errorCode="oauth_required")
                return
            operations.finish(home, key, "committed", toolCount=min(len(found), 10000), observedAtMs=int(time.time() * 1000))
    except tx.ConfigConflict:
        operations.finish(home, key, "failed", errorCode="config_conflict")
    except Exception:
        operations.finish(home, key, "failed", errorCode="test_failed")


def handle_connections(rpc, identity, payload):
    op = identity["operation"]
    def fail(code, receipt=None):
        return {**identity, "status": "unsupported" if code == "unsupported" else "error", "capabilities": [],
                "errorCode": code, "errorMessage": ERRORS[code], **({"connections": {"receipt": receipt}} if receipt else {})}
    try:
        if identity["scope"] != "profile":
            raise ValueError()
        _validate(op, payload)
    except (KeyError, ValueError, TypeError):
        return fail("invalid_request")
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return fail("profile_not_served")
    try:
        tx, native, operations, oauth, channels = _native()
    except (ImportError, AttributeError, OSError):
        return fail("unsupported")
    admitted = False
    completed = False
    try:
        with native.profile_context(home):
            if op == "connections.read":
                result = {"snapshot": native.snapshot(home, identity["profileId"], getattr(rpc, "_management_adapter", None))}
            elif op in READS:
                row = oauth.status(home, payload["mutationId"]) if op == "mcp.oauthStatus" else operations.receipt(home, payload["mutationId"])
                if op in {"mcp.testStatus", "mcp.oauthStatus"} and row["outcome"] != "not_found" and row["operation"] != ("mcp.test" if op == "mcp.testStatus" else "mcp.oauthStart"):
                    return fail("not_found")
                result = {"receipt": row}
            else:
                tx.validate_request_window(payload["producedAtMs"], payload["expiresAtMs"])
                if op == "mcp.oauthCancel":
                    admitted = True
                    result = {"receipt": oauth.cancel(home, payload["mutationId"],
                              produced_at_ms=payload["producedAtMs"], expires_at_ms=payload["expiresAtMs"])}
                else:
                    expires = int(time.time() * 1000) + (315000 if op == "mcp.oauthStart" else 45000 if op == "mcp.test" else 30000)
                    timing = "new_session_or_restart" if op in {"mcp.enabled", "mcp.oauthStart"} else "restart_required" if op == "channels.enabled" else "active_now"
                    fresh, row = operations.reserve(home, payload["mutationId"], op, payload, expires_at_ms=expires, apply_timing=timing)
                    if not fresh:
                        return {**identity, "status": "ok", "capabilities": [], "connections": {"receipt": row}}
                    admitted = True
                    tx.validate_request_window(payload["producedAtMs"], payload["expiresAtMs"])
                    if op in {"mcp.enabled", "channels.enabled"}:
                        native.set_enabled(home, identity["profileId"], getattr(rpc, "_management_adapter", None),
                                           "mcp_servers" if op == "mcp.enabled" else "platforms", payload)
                        completed = True
                        row = operations.finish(home, payload["mutationId"], "committed", savedEnabled=payload["value"])
                    elif op == "mcp.test":
                        cfg, _, _ = native.capture_server(payload["name"], payload["revision"])
                        if not native.test_support(cfg)[0]:
                            raise NotImplementedError("test_unsupported")
                        tx.validate_request_window(payload["producedAtMs"], payload["expiresAtMs"])
                        threading.Thread(target=_test, args=(home, payload["name"], payload["revision"], payload["mutationId"], native, operations, tx),
                                         daemon=True, name="native-phone-mcp-test").start()
                    elif op == "mcp.oauthStart":
                        oauth.start(home, identity["profileId"], payload["name"], payload["revision"], payload["mutationId"],
                                    produced_at_ms=payload["producedAtMs"], expires_at_ms=payload["expiresAtMs"])
                        row = oauth.status(home, payload["mutationId"])
                    else:
                        runtime = channels.reconnect(home, identity["profileId"], getattr(rpc, "_management_adapter", None),
                                           payload["name"], payload["revision"], pause=op == "channels.pauseReconnect",
                                           produced_at_ms=payload["producedAtMs"], expires_at_ms=payload["expiresAtMs"])
                        completed = True
                        row = operations.finish(home, payload["mutationId"], "committed", effective=runtime["effective"])
                    result = {"receipt": row}
            return {**identity, "status": "ok", "capabilities": [], "connections": result}
    except tx.ConfigRequestExpired:
        code = "intent_expired"
    except tx.ConfigConflict:
        code = "outcome_unknown" if completed else "config_conflict"
    except tx.ConfigManaged:
        code = "outcome_unknown" if completed else "managed_setting"
    except tx.ConfigOutcomeUnknown:
        code = "outcome_unknown"
    except (PermissionError, NotImplementedError, ValueError) as error:
        code = str(error) if str(error) in ERRORS else "native_read_failed"
        if completed:
            code = "outcome_unknown"
    except Exception:
        code = "outcome_unknown" if admitted else "native_read_failed"
    row = None
    if admitted and op != "mcp.oauthCancel":
        try:
            row = operations.finish(home, payload["mutationId"], "unknown" if code == "outcome_unknown" else "failed", errorCode=code)
        except Exception:
            code = "outcome_unknown"
    return fail(code, row)
