"""Read native accounting and run bounded, correlated native diagnostics.

Receipts contain no raw command output. They are not an execution queue: a
reserved operation is never relaunched, even after gateway restart.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

READS = {"health.snapshot", "health.usage", "diagnostics.status"}
OPERATIONS = READS | {"diagnostics.start", "diagnostics.cancel"}
BOOT = uuid.uuid4().hex
DEADLINE = 90
_running = {}
_reserved = set()
_mutex = threading.RLock()
# Native builds whose internals this adapter has actually been read against.
# Each entry is ONE build and matches all-or-nothing: a tree mixing files from
# two of them is not a build anyone certified, so it is refused.
#
# This is the health feature's own gate and is deliberately narrower than the
# adapter's version range — it says "these exact internals were audited", not
# "this version is supported". It is NOT a certified-identity pin site; the
# project baseline (CERTIFIED_HERMES_COMMIT/TAG/VERSION and friends) stays where
# test_pin_coherence.py holds it.
NATIVE_BUILDS = (
    {  # Hermes 0.21.0 — release v2026.8.31, anchor 29112bef
        "hermes_state.py": "696fd2d37d66a599228f5b1be5d5b76423b744149c83a2fbd59bf3f45a5f3891",
        "hermes_cli/doctor.py": "2712f867aac2ec735af5071d56dfe605e9f669635f734078600ed4e71b333bd9",
        "hermes_cli/security_audit.py": "2069853058cecab6767b47298b69c45347e531595fdd1a4a92ae5dfe748b855c",
    },
    {  # Hermes 0.21.1 — release v2026.9.7, anchor 2237be35. The Sep 2026
       # decomposition (upstream PR #102117) rewrote all three files:
       #   doctor.py           check bodies moved to hermes_cli.doctor_*, the
       #                       printing primitives to doctor_report, and most
       #                       checks lost their section title — handled in
       #                       health_diagnostic_worker.capture_doctor.
       #   security_audit.py   _http_post_json/_http_get_json merged into one
       #                       _http_json; _discover_components, run_audit and
       #                       the Finding/Vulnerability shape are unchanged.
       #   hermes_state.py     decomposed, but the surface used here is intact:
       #                       SessionDB(db_path, read_only=True), ._conn with a
       #                       sqlite3.Row factory, .close(), and a mode=ro open
       #                       that does no schema init and takes no write lock.
       #                       `sessions` only gained columns
       #                       (compression_recovery_deadline, tool_names) and
       #                       `session_model_usage` is byte-identical, so every
       #                       column these queries name still means what it did.
        "hermes_state.py": "9353e4fa0a8353b3e50b1945a87a898cf88b647ef726a4bab8ce5f65dffec431",
        "hermes_cli/doctor.py": "8c852b643dc40cb781870cd723ca8497ecffb509668e8b5b3248e7977418f7b2",
        "hermes_cli/security_audit.py": "fea5b62d8fef337474d921e634f9fa226c228ec391a6d7f5b682bc2422fb34d3",
    },
)


def native_root():
    import hermes_constants
    root = Path(hermes_constants.__file__).resolve().parent
    seen = {}
    for build in NATIVE_BUILDS:
        for path in build:
            if path not in seen:
                try:
                    seen[path] = hashlib.sha256((root / path).read_bytes()).hexdigest()
                except OSError:
                    seen[path] = None
        if all(seen[path] == digest for path, digest in build.items()):
            return root
    raise NotImplementedError()


def capabilities():
    try:
        native_root()
        supported = True
    except Exception:
        supported = False
    return [{"operation": op, "scope": "profile", "supported": supported,
             "applyTiming": "read_only" if op in READS else "active_now"} for op in sorted(OPERATIONS)]


def usage(home, days):
    """Native dashboard window: sessions.started_at, plus auxiliary task rows.

Use the native read-only DB constructor and one transaction. Main task ledger
rows duplicate session counters and are deliberately excluded. NULL actual
cost is never replaced by estimated cost or reported as a billed zero.
"""
    from hermes_state import SessionDB
    db = SessionDB(Path(home) / "state.db", read_only=True)
    now = time.time()
    try:
        db._conn.execute("BEGIN")
        fields = "SUM(input_tokens) input, SUM(output_tokens) output, SUM(estimated_cost_usd) estimated, SUM(actual_cost_usd) actual, COUNT(*) records, COUNT(actual_cost_usd) actualRecords, COUNT(estimated_cost_usd) estimatedRecords"
        rows = [dict(row) for row in db._conn.execute(
            f"SELECT COALESCE(NULLIF(model,''),'unknown') model, {fields} FROM sessions WHERE started_at > ? GROUP BY model", (now - days * 86400,))]
        auxiliary = "available"
        try:
            aux = [dict(row) for row in db._conn.execute("""SELECT COALESCE(NULLIF(u.model,''),'unknown') model,
                SUM(u.input_tokens) input, SUM(u.output_tokens) output, SUM(u.estimated_cost_usd) estimated,
                COUNT(*) records, COUNT(u.estimated_cost_usd) estimatedRecords
                FROM session_model_usage u JOIN sessions s ON s.id=u.session_id
                WHERE s.started_at > ? AND u.task != '' GROUP BY u.model""", (now - days * 86400,))]
        except Exception:
            aux = []
            auxiliary = "unknown"
        models = {}
        for row in rows:
            models[row["model"]] = row
        for row in aux:
            target = models.setdefault(row["model"], dict(model=row["model"], input=0, output=0, estimated=None,
                                                          actual=None, records=0, actualRecords=0, estimatedRecords=0))
            for key in ("input", "output", "records", "estimatedRecords"):
                target[key] = (target[key] or 0) + (row[key] or 0)
            if row["estimated"] is not None:
                target["estimated"] = (target["estimated"] or 0) + row["estimated"]
        result = []
        for row in models.values():
            # Model names are accounting identifiers, never prompts/config.
            model = row["model"] if re.fullmatch(r"[A-Za-z0-9_.:/@+-]{1,160}", row["model"]) else "redacted-model"
            result.append({**row, "model": model, "input": row["input"] or 0, "output": row["output"] or 0})
        totals = {key: sum(row[key] or 0 for row in result) for key in ("input", "output", "records", "actualRecords", "estimatedRecords")}
        for key, coverage in (("estimated", "estimatedRecords"), ("actual", "actualRecords")):
            totals[key] = sum(row[key] or 0 for row in result) if totals[coverage] else None
        result.sort(key=lambda row: row["input"] + row["output"], reverse=True)
        return {"observedAt": now * 1000, "source": "native_session_accounting", "periodDays": days,
                "window": "session_start", "auxiliary": auxiliary, "totals": totals,
                "models": result[:100], "truncated": len(result) > 100}
    finally:
        db.close()


def snapshot(home):
    now = time.time() * 1000
    result = {"observedAt": now, "source": "native_gateway", "gateway": "responding",
              "provider": "unknown", "providerFailures": None, "jobFailures": None, "diskFree": None}
    try:
        result["diskFree"] = shutil.disk_usage(home).free
    except OSError:
        pass
    # Inspect the existing execution ledger without recovery or schema writes.
    import sqlite3
    path = Path(home) / "cron" / "executions.db"
    if path.is_file():
        try:
            with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
                result["jobFailures"] = connection.execute(
                    "SELECT COUNT(*) FROM executions WHERE status='failed' AND CAST(strftime('%s', started_at) AS INTEGER)>?", (time.time() - 7 * 86400,)).fetchone()[0]
        except Exception:
            pass
    return result


@contextmanager
def _store(home, create=False):
    directory = Path(home) / "phone-diagnostics"
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
    if not directory.is_dir() or directory.is_symlink():
        raise FileNotFoundError()
    with _mutex:
        descriptor = os.open(directory / ".lock", os.O_RDWR | (os.O_CREAT if create else 0) | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield directory
        finally:
            os.close(descriptor)


def _read(directory, operation_id):
    path = directory / (operation_id + ".json")
    if path.is_symlink():
        raise PermissionError()
    return json.loads(path.read_text()) if path.exists() else None


def _write(directory, row):
    path = directory / (row["operationId"] + ".json")
    temporary = directory / (uuid.uuid4().hex + ".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump(row, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def receipt(home, operation_id):
    try:
        with _store(home) as directory:
            row = _read(directory, operation_id)
    except FileNotFoundError:
        row = None
    if row is None:
        return {"operationId": operation_id, "state": "not_found", "findings": []}
    if row["state"] in {"reserved", "running"} and row["bootId"] != BOOT:
        row = {**row, "state": "unknown", "phase": "gateway_changed"}
    if row["state"] == "running":
        progress = Path(home) / "phone-diagnostics" / (operation_id + ".result")
        if not progress.is_symlink() and progress.is_file() and progress.stat().st_size <= 65536:
            try:
                partial = json.loads(progress.read_text())
                row.update({key: partial[key] for key in ("phase", "findings", "checks") if key in partial})
            except (ValueError, OSError):
                pass
    return {key: value for key, value in row.items() if key != "bootId"}


def _kill(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _run(home, root, operation_id, kind):
    key = (str(home), operation_id)
    try:
        with _store(home) as directory:
            row = _read(directory, operation_id)
            if row["state"] == "cancelled":
                return
            env = {**os.environ, "HERMES_HOME": str(home), "HERMES_INTERACTIVE": "0", "PYTHONPATH": str(root)}
            # Native output goes to /dev/null. Only a bounded, curated JSON file
            # can cross back; the process group deadline includes descendants.
            output = directory / (operation_id + ".result")
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("health_diagnostic_worker.py")),
                                        kind, str(output), str(DEADLINE)], cwd=root, env=env,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, start_new_session=True)
            _running[key] = process
            row.update(state="running", phase="native_checks", updatedAt=time.time() * 1000)
            _write(directory, row)
        state = "completed"
        try:
            process.wait(timeout=DEADLINE)
        except subprocess.TimeoutExpired:
            state = "timeout"
            _kill(process)
            process.wait()
        with _store(home) as directory:
            row = _read(directory, operation_id)
            if row["state"] == "cancelled":
                return
            data = {}
            if state == "completed":
                if process.returncode != 0 or not output.is_file() or output.stat().st_size > 65536:
                    state = "native_failed"
                else:
                    data = json.loads(output.read_text())
                    state = data.pop("state", "native_failed")
            row.update(data, state=state, phase="finished", updatedAt=time.time() * 1000)
            _write(directory, row)
            output.unlink(missing_ok=True)
    except Exception:
        try:
            with _store(home) as directory:
                row = _read(directory, operation_id)
                if row and row["state"] != "cancelled":
                    row.update(state="unknown", phase="result_unavailable", updatedAt=time.time() * 1000)
                    _write(directory, row)
        except Exception:
            pass
    finally:
        with _mutex:
            process = _running.pop(key, None)
            _reserved.discard(key)
            if process is not None:
                _kill(process)


def mutate(home, root, operation, payload):
    operation_id = payload["operationId"]
    with _store(home, create=True) as directory:
        row = _read(directory, operation_id)
        if operation == "diagnostics.cancel":
            if row is None:
                row = {"operationId": operation_id, "kind": "unknown", "bootId": BOOT, "findings": []}
            if row.get("state") in {"reserved", "running", "unknown"} and row.get("bootId") != BOOT:
                row.update(state="unknown", phase="cancel_unconfirmed", updatedAt=time.time() * 1000)
                _write(directory, row)
            elif row.get("state") not in {"completed", "timeout", "native_failed", "permission_denied", "partial"}:
                row.update(state="cancelled", phase="finished", updatedAt=time.time() * 1000)
                _write(directory, row)
                process = _running.get((str(home), operation_id))
                if process is not None:
                    _kill(process)
        elif row is None:
            # Bounded receipts, expiring admissions: old receipts can be removed
            # without allowing their original start request to execute again.
            for path in directory.glob("*.json"):
                if path.stat().st_mtime < time.time() - 7 * 86400:
                    path.unlink()
            if len(list(directory.glob("*.json"))) >= 256 or _reserved:
                raise ValueError("diagnostic_busy")
            row = {"operationId": operation_id, "kind": payload["kind"], "bootId": BOOT,
                   "state": "reserved", "phase": "admitted", "startedAt": time.time() * 1000,
                   "updatedAt": time.time() * 1000, "deadlineSeconds": DEADLINE, "findings": []}
            _write(directory, row)
            key = (str(home), operation_id)
            _reserved.add(key)
            try:
                threading.Thread(target=_run, args=(home, root, operation_id, payload["kind"]), daemon=True).start()
            except BaseException:
                _reserved.discard(key)
                raise
        elif row.get("kind") != payload["kind"] and row.get("state") != "cancelled":
            raise ValueError("operation_conflict")
    return receipt(home, operation_id)


def handle_health(rpc, identity, payload):
    def fail(code, status="error"):
        return {**identity, "status": status, "capabilities": [], "errorCode": code,
                "errorMessage": "Native health is unavailable. Reconnect and check the diagnostic receipt before starting another check."}
    try:
        root = native_root()
    except Exception:
        return fail("unsupported", "unsupported")
    from .management_profiles import management_profile_home
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return fail("profile_not_served")
    op = identity["operation"]
    p = payload if isinstance(payload, dict) else {}
    keys = {"health.snapshot": set(), "health.usage": {"periodDays"}, "diagnostics.status": {"operationId"},
            "diagnostics.start": {"operationId", "kind", "producedAt", "expiresAt"},
            "diagnostics.cancel": {"operationId", "producedAt", "expiresAt"}}[op]
    if identity["scope"] != "profile" or set(p) != keys:
        return fail("invalid_request")
    if "operationId" in p and (not isinstance(p["operationId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", p["operationId"])):
        return fail("invalid_request")
    if op == "health.usage" and (type(p["periodDays"]) is not int or p["periodDays"] not in (7, 30, 90)):
        return fail("invalid_request")
    if op not in READS:
        if any(type(p[key]) not in (int, float) or not math.isfinite(p[key]) for key in ("producedAt", "expiresAt")):
            return fail("invalid_request")
        now = time.time() * 1000
        if not p["producedAt"] <= now + 1000 or not now < p["expiresAt"] <= p["producedAt"] + 15000:
            return fail("invalid_request")
        if op == "diagnostics.start" and p["kind"] not in ("doctor", "security"):
            return fail("invalid_request")
    try:
        data = {"snapshot": snapshot(home)} if op == "health.snapshot" else {"usage": usage(home, p["periodDays"])} if op == "health.usage" else {
            "receipt": receipt(home, p["operationId"]) if op == "diagnostics.status" else mutate(home, root, op, p)}
        return {**identity, "status": "ok", "capabilities": [], "health": data}
    except PermissionError:
        return fail("permission_denied")
    except Exception:
        return fail("native_read_failed" if op in READS else "outcome_unknown")
