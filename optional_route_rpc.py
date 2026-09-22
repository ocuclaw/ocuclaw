"""Single-use, connection-bound review of the private Even AI Serve route."""
from __future__ import annotations

import copy
import contextlib
import os
import secrets
import subprocess
import threading
import time

from . import even_ai_route as planner, optional_setup as setup, receipts, serve

_APPLY_LOCK = threading.Lock()


@contextlib.contextmanager
def _host_lock(directory):
    # Match OpenClaw's exclusive-create protocol; never remove another holder's lock.
    if directory is None:
        raise ValueError("route_unavailable")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / "ocuclaw.optional-even-ai-route.lock"
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        yield
    finally:
        os.close(fd)
        target.unlink()


def observe(home):
    cli = planner.resolve_host_cli()
    if not planner._valid_cli(cli):
        raise ValueError("route_unavailable")
    node, _ = serve._run_json(cli + ("status", "--json"), timeout_s=serve.READ_TIMEOUT_S)
    graph, _ = serve._run_json(cli + ("serve", "status", "--json"), timeout_s=serve.READ_TIMEOUT_S)
    own = node.get("Self") if isinstance(node, dict) else None
    host = serve.normalize_dns_name(own.get("DNSName")) if isinstance(own, dict) else None
    context = setup.status(home).get("runtimeContext")
    if (not host or node.get("BackendState") != "Running" or own.get("Online") is not True
            or not own.get("ID") or not isinstance(graph, dict) or not isinstance(context, dict)
            or planner.resolve_host_cli() != cli):
        raise ValueError("route_unavailable")
    return {"cli": tuple(cli), "node": {key: own.get(key) for key in
            ("ID", "PublicKey", "DNSName", "TailscaleIPs")}, "host": host,
            "port": context.get("relayPort"), "context": context, "graph": graph}


def _plan(row):
    return planner.plan(row["graph"], dns_name=row["host"], relay_port=row["port"], cli_argv=row["cli"])


def _unrelated(row):
    graph = copy.deepcopy(row["graph"])
    graph.pop("ETag", None)
    for table, key in (("TCP", "8443"), ("Web", row["host"] + ":8443")):
        if isinstance(graph.get(table), dict):
            graph[table].pop(key, None)
            if not graph[table]:
                graph.pop(table)
    return graph


class OptionalRouteRpc:
    def __init__(self, *, clock=time.time, observer=observe, runner=subprocess.run, host_state_dir=None):
        self.clock, self.observer, self.runner = clock, observer, runner
        self.rows = {}
        self.state_lock = threading.Lock()
        self.inflight = {}
        self.host_state_dir = host_state_dir

    def disconnect(self, owner):
        with self.state_lock:
            for row in list(self.rows.values()) + list(self.inflight.values()):
                if row["owner"] == owner:
                    row["cancelled"].set()

    def handle(self, operation, owner, home, revision, operation_id=None):
        cancelled = threading.Event()
        token = secrets.token_hex(16)
        with self.state_lock:
            self.inflight[token] = {"owner": owner, "cancelled": cancelled}
        try:
            return self._handle(operation, owner, home, revision, operation_id, cancelled)
        finally:
            with self.state_lock:
                self.inflight.pop(token, None)

    def _handle(self, operation, owner, home, revision, operation_id, cancelled):
        with _APPLY_LOCK:
            now = self.clock()
            revision_reader = revision if callable(revision) else lambda: revision
            revision = revision_reader()
            with self.state_lock:
                self.rows = {key: row for key, row in self.rows.items()
                             if row["expires"] > now and not row["cancelled"].is_set()}
            if cancelled.is_set():
                return self._response(operation_id, {"expires": now, "state": "refused",
                    "reason": "context_changed", "observed": None})
            if operation == "route.preview":
                operation_id = secrets.token_urlsafe(24)
                row = {"owner": owner, "revision": revision, "expires": now + 120,
                       "used": False, "observed": None, "cancelled": cancelled}
                with self.state_lock:
                    while len(self.rows) >= 64:
                        self.rows.pop(next(iter(self.rows)))
                    self.rows[operation_id] = row
                try:
                    row["observed"] = copy.deepcopy(self.observer(home))
                    decision = _plan(row["observed"])
                    state, reason = (("preview", "route_absent") if decision.state == "approval_required"
                                     else ("ready", "route_matches") if decision.state == "verified_noop"
                                     else ("refused", "route_conflict"))
                except Exception:
                    state, reason = "unknown", "route_unavailable"
                if cancelled.is_set():
                    state, reason = "refused", "context_changed"
                row["state"], row["reason"] = state, reason
                return self._response(operation_id, row)
            row = self.rows.get(operation_id) if isinstance(operation_id, str) else None
            if row is None or row["owner"] != owner or row["revision"] != revision or row["cancelled"].is_set():
                return self._response(operation_id, {"expires": now, "state": "refused",
                    "reason": "context_changed", "observed": None})
            if operation == "route.status":
                # Status is read-only, including after an ambiguous command outcome.
                try:
                    fresh = self.observer(home)
                    old = row["observed"]
                    same = old and all(fresh[k] == old[k] for k in old if k != "graph")
                    ready = same and _unrelated(fresh) == _unrelated(old) and _plan(fresh).state == "verified_noop"
                    row["state"], row["reason"] = (("ready", "route_matches") if ready else
                        ("unknown", "apply_unconfirmed") if row["used"] else
                        (row["state"], row["reason"]) if fresh == old else ("refused", "context_changed"))
                except Exception:
                    row["state"], row["reason"] = "unknown", "route_unavailable"
                return self._response(operation_id, row)
            if row["used"] or row["state"] != "preview":
                return self._response(operation_id, {**row, "state": "refused", "reason": "context_changed"})
            row["used"] = True
            try:
                with _host_lock(self.host_state_dir if self.host_state_dir is not None else receipts.host_state_dir()):
                    return self._apply(operation_id, row, home, revision_reader, cancelled)
            except Exception:
                row["state"], row["reason"] = "unknown", "apply_unconfirmed"
            return self._response(operation_id, row)

    def _apply(self, operation_id, row, home, revision_reader, cancelled):
        fresh = self.observer(home)
        if (fresh != row["observed"] or _plan(fresh).state != "approval_required"
                or revision_reader() != row["revision"] or self.clock() >= row["expires"]
                or cancelled.is_set() or row["cancelled"].is_set()):
            row["state"], row["reason"] = "refused", "context_changed"
            return self._response(operation_id, row)
        # Never execute the planner's display command or any phone-provided argv.
        argv = fresh["cli"] + ("serve", "--bg", "--https=8443", f"http://127.0.0.1:{fresh['port']}")
        row["state"], row["reason"] = "unknown", "apply_unconfirmed"
        try:
            self.runner(argv, shell=False, capture_output=True, timeout=20, check=False)
        except Exception:
            pass  # A timed-out process may have applied; only fresh readback proves it.
        after = self.observer(home)
        if (not cancelled.is_set() and not row["cancelled"].is_set() and revision_reader() == row["revision"]
                and all(after[k] == fresh[k] for k in fresh if k != "graph")
                and _unrelated(after) == _unrelated(fresh) and _plan(after).state == "verified_noop"):
            row["state"], row["reason"] = "ready", "route_matches"
        return self._response(operation_id, row)

    @staticmethod
    def _response(operation_id, row):
        observed = row.get("observed") or {}
        host = observed.get("host")
        return {"operationId": operation_id, "expiresAtMs": int(row["expires"] * 1000),
                "state": row["state"], "reason": row["reason"], "host": host,
                "agentUrl": planner._agent_url(host), "relayPort": observed.get("port"),
                "tailnetOnly": True, "requestVerified": False}
