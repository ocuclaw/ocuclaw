"""Native, gateway-scoped restart admission. Never retry an admitted operation.

Called synchronously on the gateway event loop: no timeout-surviving worker queue.
The durable dispatch fence precedes the native call. Retention is bounded by
refusing new admissions when full, never by forgetting a previous operation.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import tempfile
import time
from pathlib import Path

_OPERATIONS = {"restart.preview", "restart.request", "restart.status"}
_ID = re.compile(r"[A-Za-z0-9_-]{16,128}\Z")


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class RestartRpc:
    def __init__(self, adapter, rpc):
        self.adapter, self.rpc = adapter, rpc

    def _snapshot(self):
        from hermes_constants import get_process_hermes_home
        from hermes_cli.profiles import get_active_profile_name
        from gateway.restart import is_gateway_supervisor_process
        from gateway.status import get_process_start_time

        runner = getattr(self.adapter, "gateway_runner", None)
        if runner is None or not callable(getattr(runner, "request_restart", None)):
            raise NotImplementedError()
        if not runner._running:
            raise RuntimeError("gateway not ready")
        # Native secondary adapter maps and the routing map captured by GwRpc
        # at construction reflect loaded profiles, not a fresh filesystem scan.
        profiles = {get_active_profile_name() or "default"}
        profiles.update(getattr(runner, "_profile_adapters", {}))
        profiles.update("default" if name == "main" else name
                        for name in self.rpc._served_profile_homes)
        profiles = sorted(profiles)
        home = Path(get_process_hermes_home()).resolve()
        started = get_process_start_time(os.getpid())
        if started is None:
            raise NotImplementedError()
        home_stat = home.stat()
        return runner, home, {
            "gatewayId": _digest([socket.gethostname(), str(home), home_stat.st_dev, home_stat.st_ino]),
            "bootId": _digest([os.getpid(), started]),
            "scopeRevision": _digest(profiles), "affectedProfiles": profiles,
            "activeWork": max(0, int(runner._active_work_count())),
            "waitSeconds": max(0, int(runner._restart_after_turn_timeout)),
            "drainSeconds": max(0, int(runner._restart_drain_timeout)),
            "phase": "draining" if runner._draining else "ready",
            "supported": bool(is_gateway_supervisor_process()),
        }

    @staticmethod
    def _load(path):
        if not path.exists():
            return {}
        if path.is_symlink() or path.stat().st_size > 262144:
            raise ValueError("invalid receipt store")
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or len(data) > 128:
            raise ValueError("invalid receipt store")
        return data

    @staticmethod
    def _save(path, data):
        encoded = json.dumps(data).encode()
        if len(encoded) > 262144:
            raise ValueError("receipt store full")
        fd, tmp = tempfile.mkstemp(prefix=".restart-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    async def handle(self, params):
        if not isinstance(params, dict) or params.get("operation") not in _OPERATIONS:
            result = await self.rpc.hermes_management(params)
            if (isinstance(result, dict) and result.get("status") == "ok"
                    and isinstance(result.get("overview"), dict)):
                # This native total includes gateway chat, cron and API work.
                # Never label it as the selected profile's activity.
                try:
                    runner = getattr(self.adapter, "gateway_runner", None)
                    count = runner._active_work_count()
                    if type(count) is int and count >= 0:
                        result["overview"].update(activeWork=count, activeWorkScope="gateway")
                        result["capabilities"] = [row for row in result.get("capabilities", [])
                                                  if row.get("operation") != "activeWork"]
                        result["capabilities"].append({"operation": "activeWork", "scope": "gateway",
                                                       "supported": True, "applyTiming": "read_only"})
                except Exception:
                    pass
            return result
        identity = {key: params.get(key, "") for key in ("requestId", "operation", "scope", "profileId")}

        def fail(code, unsupported=False):
            return {**identity, "status": "unsupported" if unsupported else "error",
                    "capabilities": [], "errorCode": code,
                    "errorMessage": "Restart could not be confirmed. Refresh the gateway state."}

        if (set(params) - {*identity, "payload"} or identity["scope"] != "gateway"
                or any(not isinstance(v, str) or not v or len(v) > 128 for v in identity.values())):
            return fail("invalid_request")
        try:
            runner, home, snapshot = self._snapshot()
            served = self.rpc._sync_profiles_list({}).get("profiles", [])
            if not any(row.get("name") == identity["profileId"] for row in served):
                return fail("profile_not_served")
        except (ImportError, AttributeError, NotImplementedError):
            return fail("unsupported", True)
        except Exception:
            return fail("native_read_failed")
        result = {**identity, "status": "ok", "capabilities": [], "restart": snapshot}
        payload = params.get("payload", {})
        if identity["operation"] == "restart.preview":
            return result if payload == {} else fail("invalid_request")
        expected = {"operationId", "gatewayId"}
        if identity["operation"] == "restart.request":
            expected |= {"bootId", "scopeRevision"}
        if not isinstance(payload, dict) or set(payload) != expected or any(
                not isinstance(v, str) or not _ID.fullmatch(v) for v in payload.values()):
            return fail("invalid_request")
        if payload["gatewayId"] != snapshot["gatewayId"]:
            return fail("gateway_changed")
        path = home / "ocuclaw-restart-receipts.json"
        try:
            receipts = self._load(path)
        except Exception:
            return fail("receipt_unavailable")
        operation_id = payload["operationId"]
        receipt = receipts.get(operation_id)
        if receipt:
            if identity["operation"] == "restart.request" and receipt["fingerprint"] != _digest(payload):
                return fail("operation_conflict")
            public = {key: value for key, value in receipt.items() if key != "fingerprint"}
            # Execution on this authenticated link, with a new process boot and
            # the selected served profile, proves the gateway returned.
            if (receipt["phase"] in ("accepted", "dispatching", "unconfirmed")
                    and receipt["oldBootId"] != snapshot["bootId"] and snapshot["phase"] == "ready"
                    and receipt["scopeRevision"] == snapshot["scopeRevision"]):
                public["phase"] = "recovered"
            elif public["phase"] == "dispatching":
                public["phase"] = "unconfirmed"
            snapshot["receipt"] = public
            return result
        if identity["operation"] == "restart.status":
            return fail("receipt_not_found")
        if not snapshot["supported"]:
            return fail("unsupported", True)
        if any(payload[key] != snapshot[key] for key in ("bootId", "scopeRevision")):
            return fail("stale_preview")
        if snapshot["phase"] != "ready":
            return fail("already_draining")
        if len(receipts) >= 128:
            return fail("receipt_store_full")
        receipt = {"operationId": operation_id, "gatewayId": snapshot["gatewayId"],
                   "oldBootId": snapshot["bootId"], "scopeRevision": snapshot["scopeRevision"],
                   "affectedProfiles": snapshot["affectedProfiles"],
                   "requestedAt": int(time.time() * 1000), "phase": "dispatching",
                   "fingerprint": _digest(payload)}
        receipts[operation_id] = receipt
        try:
            self._save(path, receipts)
        except Exception:
            return fail("receipt_unavailable")
        try:
            accepted = runner.request_restart(detached=False, via_service=True)
            receipt["phase"] = "accepted" if accepted else "rejected"
        except Exception:
            receipt["phase"] = "unconfirmed"
        try:
            self._save(path, receipts)
        except Exception:
            receipt["phase"] = "unconfirmed"
        snapshot["receipt"] = {key: value for key, value in receipt.items() if key != "fingerprint"}
        snapshot["phase"] = "draining" if runner._draining else "ready"
        return result
