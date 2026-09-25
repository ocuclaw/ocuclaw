"""Read native accounting and run bounded, correlated native diagnostics.

Receipts contain no raw command output. They are not an execution queue: a
reserved operation is never relaunched, even after gateway restart.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

# #3700: native Windows has no fcntl. management_rpc imports this module at load, so a hard
# import here took down every management read and showed "Can't reach Hermes" on a healthy host.
try:
    import fcntl
except ImportError:
    fcntl = None

READS = {"health.snapshot", "health.usage", "diagnostics.status"}
OPERATIONS = READS | {"diagnostics.start", "diagnostics.cancel"}
DIAGNOSTICS = {"diagnostics.status", "diagnostics.start", "diagnostics.cancel"}
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
    {  # Hermes 0.21.3 — release v2026.9.14, anchor 345cd2b0 (#2846 recert).
       # doctor.py and security_audit.py are byte-identical to 0.21.1. Only
       # hermes_state.py moved (WAL generation capture, retired-generation
       # handling, mode=ro reader retry on transient SQLITE_IOERR); the
       # surface used here is intact: SessionDB(db_path, read_only=True)
       # still opens `file:...?mode=ro` with no schema init and no write
       # lock, ._conn keeps the sqlite3.Row factory, .close() is unchanged.
       # `sessions` and `session_model_usage` keep every column these
       # queries name (model, started_at, *_tokens, *_cost_usd, task).
        "hermes_state.py": "c92415eeb6bba298ff9bd3f823a6c3f9f9ff762c32af5d058923a7ba740dd5ec",
        "hermes_cli/doctor.py": "8c852b643dc40cb781870cd723ca8497ecffb509668e8b5b3248e7977418f7b2",
        "hermes_cli/security_audit.py": "fea5b62d8fef337474d921e634f9fa226c228ec391a6d7f5b682bc2422fb34d3",
    },
    {  # Hermes 0.21.5 — release v2026.9.24, anchor f97608f1 (0.21.5 recert).
       # security_audit.py is byte-identical to 0.21.1/0.21.3.
       #   doctor.py           adds one untitled check, _check_checkpoint_store,
       #                       right after _check_state_db, so its rows land in
       #                       the Directory Structure section capture_doctor
       #                       already opened; run_doctor now returns an int
       #                       exit code (the worker ignores it) and the ack
       #                       failure text changed. The doctor_report
       #                       primitives and DOCTOR_CHECKS shape are unchanged.
       #   hermes_state.py     the read-only open now builds its URI with
       #                       hermes_state_holders.read_only_db_uri (a
       #                       percent-encoded `...?mode=ro`, still no schema
       #                       init and no write lock) and uses one 5 s read
       #                       busy budget. SessionDB(db_path, read_only=True),
       #                       ._conn with the sqlite3.Row factory and .close()
       #                       are unchanged; SCHEMA_VERSION stays 30, so
       #                       `sessions` and `session_model_usage` keep every
       #                       column these queries name.
        "hermes_state.py": "134fb1af988fd49407433cf54afa74f2188c93021fc4576bcf2c7174e787c2eb",
        "hermes_cli/doctor.py": "4c1400a78f799888ffddc30c5bfda324881f98281deaf07ad4c41861dc3d62d5",
        "hermes_cli/security_audit.py": "fea5b62d8fef337474d921e634f9fa226c228ec391a6d7f5b682bc2422fb34d3",
    },
)


# Compatible tier (#3346). A default Hermes install and `hermes update` track Hermes
# `main`, whose files never hash-match a release and whose version label lags the code,
# so the exact-build table above almost never holds for real users. When no audited
# build matches, the reads are still served if BOTH hold:
#   1. the running Hermes reports a version inside the plugin's supported range
#      (health.SUPPORTED_HERMES_MIN <= v < health.SUPPORTED_HERMES_MAX_EXCLUSIVE),
#      read the way the rest of the plugin reads it; and
#   2. a structural probe of exactly the surface this module uses passes
#      (_probe_reads below). Diagnostics additionally need _probe_diagnostics.
# The probe only observes: it never patches Hermes and never writes into a Hermes home.
# Its one write is a throwaway database in its own temporary directory, and that write
# is how it proves the read-only open really is read-only.
AUDITED = "audited"
COMPATIBLE = "compatible"
UNSUPPORTED = "unsupported"
# Every column the accounting queries in _accounting name, per table.
ACCOUNTING_COLUMNS = {
    "sessions": {"id", "model", "started_at", "input_tokens", "output_tokens",
                 "estimated_cost_usd", "actual_cost_usd"},
    "session_model_usage": {"session_id", "model", "task", "input_tokens", "output_tokens",
                            "estimated_cost_usd"},
}
# The lowest schema the audited in-range builds (0.21.1 onward) were read against.
MIN_SCHEMA_VERSION = 30
PROBE_DEADLINE = 20
_FAILED_PROBE_TTL = 300
_support_cache = {}
_support_lock = threading.Lock()
logger = logging.getLogger(__name__)


class Support:
    """Which tier the running Hermes earned, and whether diagnostics come with it."""

    def __init__(self, root, tier, diagnostics, reason=None):
        self.root, self.tier, self.diagnostics, self.reason = root, tier, diagnostics, reason
        self.expires = math.inf if tier != UNSUPPORTED and diagnostics else time.monotonic() + _FAILED_PROBE_TTL

    @property
    def reads(self):
        return self.tier in (AUDITED, COMPATIBLE)


def native_support():
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
            return Support(root, AUDITED, True)
    # Keyed on the same file digests: `hermes update` changes them, so a new tree is re-probed.
    key = (str(root), tuple(sorted(seen.items())))
    with _support_lock:
        cached = _support_cache.get(key)
        if cached is None or cached.expires <= time.monotonic():
            cached = _probe_compatible(root)
            _support_cache.clear()
            _support_cache[key] = cached
            logger.info("ocuclaw health: Hermes at %s is %s%s", root, cached.tier,
                        f" ({cached.reason})" if cached.reason else "")
    return cached


def native_root():
    support = native_support()
    if not support.reads:
        raise NotImplementedError(support.reason)
    return support.root


def _probe_compatible(root):
    try:
        reason = _version_outside_range() or _probe_reads()
    except Exception as error:  # noqa: BLE001 - any probe failure is a refusal, never a crash
        reason = "read_probe_failed:" + type(error).__name__
    if reason:
        return Support(root, UNSUPPORTED, False, reason)
    diagnostics = None
    if diagnostics_supported():
        diagnostics = _probe_diagnostics(root)
    return Support(root, COMPATIBLE, diagnostics is None and diagnostics_supported(), diagnostics)


def _version_outside_range():
    """The version gate the rest of the plugin uses, reading a main/dev label by its release.

    ``parse_version`` keeps the leading digits of each part, so a main label such as
    ``0.21.4``, ``0.21.4+12.gabc1234`` or ``0.21.5.dev3`` counts as its release line, and
    ``0.22.0.dev0`` counts as 0.22.0: the next line is not the supported one. A missing or
    placeholder label (``0.0.0``) cannot be placed in the range, so it is refused.
    """
    from .health import SUPPORTED_HERMES_MAX_EXCLUSIVE, SUPPORTED_HERMES_MIN, hermes_version, parse_version
    parsed = parse_version(hermes_version())
    if parsed is None or parsed == (0, 0, 0):
        return "hermes_version_unknown"
    if not SUPPORTED_HERMES_MIN <= parsed < SUPPORTED_HERMES_MAX_EXCLUSIVE:
        return "hermes_version_outside_supported_range"
    return None


def _schema_tables(schema_sql):
    """Hermes' own CREATE TABLE statements for the accounting tables, as SQLite reads them."""
    wanted, statement = {}, ""
    for line in schema_sql.splitlines(keepends=True):
        statement += line
        if not sqlite3.complete_statement(statement):
            continue
        # Leading SQL comments ride along with the statement they precede.
        match = re.match(r"(?:\s|--[^\n]*\n)*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"`\[]?(\w+)",
                         statement, re.IGNORECASE)
        if match and match.group(1) in ACCOUNTING_COLUMNS:
            wanted[match.group(1)] = statement
        statement = ""
    return wanted


def _probe_reads():
    """Prove the accounting surface on a throwaway database; return a refusal reason or None.

    Checks exactly what ``usage`` relies on: ``SessionDB(db_path, read_only=True)``, its
    ``_conn`` with the ``sqlite3.Row`` factory and ``close()``; ``SCHEMA_VERSION`` and the
    ``sessions`` / ``session_model_usage`` columns the queries name, taken from Hermes' own
    schema; and that the read-only open really is read-only: it initialises no schema,
    refuses a write, and leaves the database file byte-identical.
    """
    import inspect
    from hermes_state import SessionDB
    from hermes_state_common import SCHEMA_SQL, SCHEMA_VERSION
    if type(SCHEMA_VERSION) is not int or SCHEMA_VERSION < MIN_SCHEMA_VERSION:
        return "schema_version_unrecognised"
    try:
        inspect.signature(SessionDB).bind(Path("state.db"), read_only=True)
    except TypeError:
        return "session_db_signature_changed"
    tables = _schema_tables(SCHEMA_SQL) if isinstance(SCHEMA_SQL, str) else {}
    if set(tables) != set(ACCOUNTING_COLUMNS):
        return "accounting_tables_missing"
    import tempfile
    with tempfile.TemporaryDirectory(prefix="ocuclaw-health-probe-") as scratch:
        path = Path(scratch) / "state.db"
        connection = sqlite3.connect(path)
        try:
            missing = False
            for name, statement in tables.items():
                connection.execute(statement)
                columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{name}")')}
                missing = missing or not ACCOUNTING_COLUMNS[name] <= columns
            connection.commit()
        finally:
            connection.close()
        if missing:
            return "accounting_columns_missing"
        before = path.read_bytes()
        entries = sorted(item.name for item in Path(scratch).iterdir())
        db = SessionDB(path, read_only=True)
        try:
            conn = getattr(db, "_conn", None)
            if not isinstance(conn, sqlite3.Connection) or conn.row_factory is not sqlite3.Row:
                return "read_connection_changed"
            try:
                conn.execute("CREATE TABLE ocuclaw_health_probe(x)")
            except sqlite3.OperationalError as error:
                # SQLITE_READONLY (8): the connection itself refuses writes, i.e. mode=ro.
                if getattr(error, "sqlite_errorcode", 8) != 8 or "readonly" not in str(error).lower():
                    return "read_only_open_unproven"
            else:
                return "read_only_open_unproven"
            # The very statements usage() runs, inside the same explicit read transaction.
            conn.execute("BEGIN")
            try:
                if _accounting(conn, 0)[2] != "available":
                    return "accounting_query_failed"
            finally:
                conn.execute("ROLLBACK")
        finally:
            db.close()
        if path.read_bytes() != before or sorted(item.name for item in Path(scratch).iterdir()) != entries:
            return "read_only_open_unproven"
    return None


def _probe_diagnostics(root):
    """Check the doctor and security-audit surface in a child, as the diagnostics themselves run.

    The gateway never imports native doctor. The worker imports it under a throwaway
    HERMES_HOME, checks the shapes capture_doctor and the audit path rely on, and writes one
    verdict. Returns a refusal reason, or None when diagnostics can be served.
    """
    import tempfile
    worker = Path(__file__).with_name("health_diagnostic_worker.py")
    with tempfile.TemporaryDirectory(prefix="ocuclaw-health-probe-") as scratch:
        home = Path(scratch) / "home"
        home.mkdir()
        output = Path(scratch) / "probe.json"
        env = {**os.environ, "HERMES_HOME": str(home), "HERMES_INTERACTIVE": "0", "PYTHONPATH": str(root)}
        try:
            subprocess.run([sys.executable, str(worker), "probe", str(output), str(PROBE_DEADLINE)], cwd=root,
                           env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, start_new_session=True, timeout=PROBE_DEADLINE + 5)
            verdict = json.loads(output.read_text()) if output.is_file() else {}
        except (OSError, ValueError, subprocess.SubprocessError):
            verdict = {}
    if verdict.get("state") == "compatible":
        return None
    reason = verdict.get("reason")
    return "diagnostics_" + (reason if isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,64}", reason) else "probe_failed")


def diagnostics_supported():
    """The receipt store locks with flock and a timed-out check kills its process group.

    Both are POSIX-only, so diagnostics are unsupported on native Windows. The two plain
    reads (snapshot, usage) need neither and stay available there.
    """
    return fcntl is not None and hasattr(os, "killpg") and hasattr(os, "O_NOFOLLOW")


def capabilities():
    try:
        support = native_support()
    except Exception:
        support = None
    supported = bool(support and support.reads)
    diagnostics = supported and support.diagnostics and diagnostics_supported()
    return [{"operation": op, "scope": "profile", "supported": diagnostics if op in DIAGNOSTICS else supported,
             "applyTiming": "read_only" if op in READS else "active_now"} for op in sorted(OPERATIONS)]


def _accounting(conn, since):
    """The two accounting reads. _probe_reads runs these same statements on its probe DB."""
    fields = "SUM(input_tokens) input, SUM(output_tokens) output, SUM(estimated_cost_usd) estimated, SUM(actual_cost_usd) actual, COUNT(*) records, COUNT(actual_cost_usd) actualRecords, COUNT(estimated_cost_usd) estimatedRecords"
    rows = [dict(row) for row in conn.execute(
        f"SELECT COALESCE(NULLIF(model,''),'unknown') model, {fields} FROM sessions WHERE started_at > ? GROUP BY model", (since,))]
    auxiliary = "available"
    try:
        aux = [dict(row) for row in conn.execute("""SELECT COALESCE(NULLIF(u.model,''),'unknown') model,
            SUM(u.input_tokens) input, SUM(u.output_tokens) output, SUM(u.estimated_cost_usd) estimated,
            COUNT(*) records, COUNT(u.estimated_cost_usd) estimatedRecords
            FROM session_model_usage u JOIN sessions s ON s.id=u.session_id
            WHERE s.started_at > ? AND u.task != '' GROUP BY u.model""", (since,))]
    except Exception:
        aux = []
        auxiliary = "unknown"
    return rows, aux, auxiliary


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
        rows, aux, auxiliary = _accounting(db._conn, now - days * 86400)
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
        support = native_support()
    except Exception:
        return fail("unsupported", "unsupported")
    if not support.reads:
        return fail("unsupported", "unsupported")
    if identity["operation"] in DIAGNOSTICS and not (support.diagnostics and diagnostics_supported()):
        return fail("unsupported", "unsupported")
    root = support.root
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
