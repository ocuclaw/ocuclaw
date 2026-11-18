"""Private Bot Desktop input lane, backed by Hermes's native human lease.

No input goes through tools, chat, logging, a clipboard or the generic cua driver.
The separate RFB connection sends only the small allowlisted input transactions.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib
import json
import os
import re
import secrets
import select
import socket
import stat
import struct
import sys
import time
from pathlib import Path
from typing import Any, Callable

METHOD = "botScreen.control"
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
_ACTIONS = frozenset(("click", "double_click", "right_click", "scroll_up", "scroll_down", "enter", "tab", "type"))
_MAX_TEXT = 1024
_RECEIPTS = 64
_IO_TIMEOUT = 0.3
_LOCK_TIMEOUT = 0.4



class _Refused(Exception):
    def __init__(self, code: str, *, uncertain: bool = False):
        self.code, self.uncertain = code, uncertain


def _modules():
    try:
        lease = importlib.import_module("tools.bot_desktop.lease")
        runtime = importlib.import_module("tools.bot_desktop.runtime")
        required = ("get", "acquire", "release", "_path", "_read", "_locked", "_private_dir", "_open_private")
        fc = getattr(lease, "fcntl", None)
        if (not all(callable(getattr(lease, n, None)) for n in required)
                or lease.AGENT != "agent" or lease.HUMAN != "human" or fc is None
                or not callable(getattr(fc, "flock", None)) or not callable(getattr(runtime, "status", None))):
            return None, None
        return lease, runtime
    except Exception:
        return None, None


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_ID.fullmatch(value))


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _stamp(path: Path) -> list:
    s = path.stat()
    return [s.st_dev, s.st_ino, s.st_mtime_ns, s.st_size]


def _source(home: Path, placement: str) -> str | None:
    """Local generation evidence only: never a slow sandbox query under a lease lock."""
    try:
        if placement.startswith("terminal:"):
            parts = ["sandbox", placement, _stamp(home / "bot-desktop" / "sandbox.json")]
        elif placement == "gateway":
            path = home / "bot-desktop" / "rfb.sock"
            if not stat.S_ISSOCK(path.stat().st_mode):
                return None
            parts = ["native", _stamp(path)]
            for name in ("launcher.pid", "env"):
                p = home / "bot-desktop" / name
                parts.append(_stamp(p) if p.exists() else None)
        else:
            return None
        return hashlib.sha256(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()
    except (OSError, ValueError):
        return None


@contextlib.contextmanager
def _file_lock(path: Path, lease: Any, *, timeout: float = _LOCK_TIMEOUT):
    lease._private_dir(path)
    fh = open(path, "a+", encoding="utf-8", opener=lease._open_private)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                lease.fcntl.flock(fh.fileno(), lease.fcntl.LOCK_EX | lease.fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise _Refused("control_busy") from None
                time.sleep(0.005)
        yield
    finally:
        lease.fcntl.flock(fh.fileno(), lease.fcntl.LOCK_UN)
        fh.close()


def _record_path(home: Path) -> Path:
    return home / "bot-desktop" / "ocuclaw-control.json"


def _read_record(home: Path) -> dict:
    try:
        p = _record_path(home)
        if p.stat().st_size > 65536:
            return {}
        raw = json.loads(p.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) and raw.get("v") == 1 else {}
    except (OSError, ValueError):
        return {}


def _write_record(home: Path, value: dict, lease: Any) -> None:
    path = _record_path(home)
    lease._private_dir(path)
    tmp = path.with_name(".ocuclaw-control-" + secrets.token_hex(8))
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, separators=(",", ":"))
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _identity(record: dict, p: dict) -> bool:
    if not record or record.get("pairing") != p.get("pairingId") or record.get("profile") != p.get("profileId"):
        return False
    if record.get("connection") == p.get("connectionId"):
        return True
    token = p.get("resumeToken")
    return isinstance(token, str) and bool(token) and secrets.compare_digest(token, record.get("resume", ""))


def _native_state(native: Any, record: dict, p: dict, source: str | None) -> dict:
    mine = bool(_identity(record, p) and record.get("source") == source and native.holder == "human"
                and native.viewer_id == record.get("viewer") and native.epoch == record.get("epoch"))
    return {"known": True, "holder": native.holder if native.holder in ("human", "agent") else "unknown",
            "mine": mine, "epoch": native.epoch if _integer(native.epoch) else 0,
            "reason": "OcuClaw" if native.reason == "OcuClaw" else "",
            "since": int(native.since * 1000) if isinstance(native.since, (int, float)) else 0}


def _continuation(p: dict) -> dict:
    """Only source identifiers, never a clarify question or input value."""
    key = p.get("sessionKey")
    if key is None:
        return {}
    if not isinstance(key, str) or not 1 <= len(key) <= 512 or any(ord(c) < 32 for c in key):
        raise _Refused("invalid_session")
    if key.startswith("agent:"):
        from .dispatch import parse_ocuclaw_session_key
        from .profile_routes import namespace_for_profile
        identity = parse_ocuclaw_session_key(key)
        if identity is None or identity["ns"] != namespace_for_profile(p.get("profileId")):
            raise _Refused("invalid_session")
    context = {"sessionKey": key}
    clarify = p.get("clarifyId")
    if clarify is not None:
        if not _valid_id(clarify):
            raise _Refused("invalid_clarify")
        context["clarifyId"] = clarify
    return context


class _Rfb:
    """Private None-auth RFB 3.8 writer. No arbitrary client-message entry point."""
    def __init__(self, runtime: Any, home: Path, placement: str):
        self.sock = None
        self.proc = None
        self.rfd = self.wfd = -1
        try:
            if placement.startswith("terminal:"):
                if not callable(getattr(runtime, "open_rfb_stream", None)):
                    raise _Refused("sandbox_input_unavailable")
                self.proc = runtime.open_rfb_stream()
                self.rfd, self.wfd = self.proc.stdout.fileno(), self.proc.stdin.fileno()
            else:
                expected = home / "bot-desktop" / "rfb.sock"
                if Path(runtime.rfb_socket_path()) != expected:
                    raise _Refused("source_changed")
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.settimeout(_IO_TIMEOUT)
                self.sock.connect(str(expected))
                self.rfd = self.wfd = self.sock.fileno()
            os.set_blocking(self.rfd, False)
            os.set_blocking(self.wfd, False)
            if self._read(12) != b"RFB 003.008\n":
                raise _Refused("rfb_unsupported")
            self._write(b"RFB 003.008\n")
            n = self._read(1)[0]
            if not 1 <= n <= 32 or 1 not in self._read(n):
                raise _Refused("rfb_unsupported")
            self._write(b"\x01")
            if self._read(4) != b"\0\0\0\0":
                raise _Refused("rfb_unsupported")
            self._write(b"\x01")  # shared viewer; never evict the live picture client
            init = self._read(24)
            self.width, self.height = struct.unpack(">HH", init[:4])
            name_size = struct.unpack(">I", init[20:24])[0]
            if not 1 <= self.width <= 16384 or not 1 <= self.height <= 16384 or name_size > 4096:
                raise _Refused("rfb_unsupported")
            self._read(name_size)
        except Exception:
            self.close()
            raise

    def _read(self, size: int) -> bytes:
        chunks = bytearray()
        deadline = time.monotonic() + _IO_TIMEOUT
        while len(chunks) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.rfd], [], [], remaining)[0]:
                raise _Refused("transport_unavailable")
            part = os.read(self.rfd, size - len(chunks))
            if not part:
                raise _Refused("transport_unavailable")
            chunks.extend(part)
        return bytes(chunks)

    def _write(self, payload: bytes) -> None:
        deadline = time.monotonic() + _IO_TIMEOUT
        sent = 0
        while sent < len(payload):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [self.wfd], [], remaining)[1]:
                raise _Refused("delivery_uncertain", uncertain=True)
            try:
                wrote = os.write(self.wfd, payload[sent:])
            except OSError:
                raise _Refused("delivery_uncertain", uncertain=True) from None
            if wrote <= 0:
                raise _Refused("delivery_uncertain", uncertain=True)
            sent += wrote

    def send(self, payload: bytes) -> None:
        self._write(payload)

    def close(self) -> None:
        if self.sock is not None:
            self.sock.close()
        if self.proc is not None:
            for pipe in (self.proc.stdin, self.proc.stdout):
                if pipe is not None:
                    pipe.close()
            try:
                self.proc.wait(timeout=0.2)
            except Exception:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=0.3)
                except Exception:
                    self.proc.kill()
                    self.proc.wait(timeout=0.3)


def _key(key: int, down: bool) -> bytes:
    return struct.pack(">BBHI", 4, int(down), 0, key)


def _character(char: str) -> bytes:
    # RFB KeyEvent carries an X keysym, not a physical US key code. Xvnc
    # synthesizes the modifier for that symbol; Shift + a lowercase keysym
    # makes Xvnc undo Shift and silently types lowercase instead.
    return _key(ord(char), True) + _key(ord(char), False)


def _units(p: dict, width: int, height: int) -> list[bytes]:
    action = p.get("action")
    if action not in _ACTIONS:
        raise _Refused("invalid_action")
    if action == "type":
        text = p.get("text")
        if (not isinstance(text, str) or not 1 <= len(text) <= _MAX_TEXT
                or any(ord(c) < 32 or ord(c) > 126 for c in text)
                or not isinstance(p.get("enter", False), bool)):
            raise _Refused("unsupported_text")
        units = [_character(c) for c in text]
        if p.get("enter"):
            units.append(_key(0xFF0D, True) + _key(0xFF0D, False))
        return units
    if action in ("enter", "tab"):
        key = 0xFF0D if action == "enter" else 0xFF09
        return [_key(key, True) + _key(key, False)]
    x, y = p.get("x"), p.get("y")
    if not _integer(x) or not _integer(y) or not 0 <= x < width or not 0 <= y < height:
        raise _Refused("invalid_target")
    button = {"click": 1, "double_click": 1, "right_click": 4, "scroll_up": 8, "scroll_down": 16}[action]
    unit = struct.pack(">BBHH", 5, button, x, y) + struct.pack(">BBHH", 5, 0, x, y)
    return [unit, unit] if action == "double_click" else [unit]


class ControlBroker:
    def _describe(self, home: Path, lease: Any, runtime: Any) -> tuple:
        expected = home / "bot-desktop" / "lease.json"
        if Path(lease._path(str(home))) != expected or lease._locked(expected)._lockfile != expected.with_suffix(".lock"):
            raise _Refused("lease_contract_unavailable")
        raw = runtime.status()
        data = raw.as_dict() if hasattr(raw, "as_dict") else vars(raw)
        placement = data.get("placement") or "gateway"
        # Hermes supports a Linux sandbox from a macOS gateway. Its native
        # fcntl lease is valid there too; only local gateway desktops are Linux-only.
        if placement == "gateway" and not sys.platform.startswith("linux"):
            return None, placement, "native_input_unavailable", None
        if not isinstance(placement, str) or not data.get("supported") or not data.get("running"):
            return None, placement, "desktop_unavailable", None
        source = _source(home, placement)
        if source is None:
            return None, placement, "source_unavailable", None
        if placement.startswith("terminal:") and not callable(getattr(runtime, "open_rfb_stream", None)):
            return None, placement, "sandbox_input_unavailable", None
        if placement == "gateway" and not callable(getattr(runtime, "rfb_socket_path", None)):
            return None, placement, "native_input_unavailable", None
        geometry = data.get("geometry", "")
        match = re.fullmatch(r"(\d{1,5})x(\d{1,5})", geometry) if isinstance(geometry, str) else None
        if not match:
            return None, placement, "source_unavailable", None
        return source, placement, None, tuple(map(int, match.groups()))

    def call(self, home: Path, params: Any, *, enrolled: Callable[[], bool] = lambda: False) -> dict:
        p = params if isinstance(params, dict) else {}
        result = {"v": 1, "id": p.get("id") if _valid_id(p.get("id")) else None,
                  "available": False, "source": None,
                  "lease": {"known": False, "holder": "unknown", "mine": False, "epoch": 0, "reason": "", "since": 0}, "ok": False}
        lease, runtime = _modules()
        if lease is None:
            return {**result, "code": "control_unavailable"}
        try:
            home = Path(home)
            if not all(_valid_id(p.get(k)) for k in ("profileId", "connectionId", "pairingId", "id")):
                raise _Refused("invalid_request")
            if not enrolled():
                raise _Refused("profile_unavailable")
            # Disconnect cancellation must not queue behind a sandbox status query.
            if p.get("op") == "cancel":
                with _file_lock(home / "bot-desktop" / "ocuclaw-control.lock", lease):
                    record = _read_record(home)
                    if not _identity(record, p):
                        raise _Refused("not_owner")
                    if (p.get("source") != record.get("source") or not _integer(p.get("epoch"))
                            or p.get("epoch") != record.get("epoch")):
                        raise _Refused("control_changed")
                    record["cancel"] = record.get("cancel", 0) + 1
                    _write_record(home, record, lease)
                return {**result, "ok": True}
            try:
                source, placement, reason, geometry = self._describe(home, lease, runtime)
            except _Refused:
                raise
            except Exception:
                if p.get("op") in ("status", "release"):
                    source, placement, reason, geometry = None, None, "desktop_unavailable", None
                else:
                    raise
            result.update(available=source is not None, source=source)
            record = _read_record(home)
            native = lease.get(profile_key=str(home))
            result["lease"] = _native_state(native, record, p, source)
            op = p.get("op")
            if op == "status":
                if _identity(record, p):
                    with _file_lock(home / "bot-desktop" / "ocuclaw-control.lock", lease):
                        record = _read_record(home)
                        if _identity(record, p):
                            record["connection"] = p["connectionId"]
                            release = record.get("release", {})
                            if release and native.holder == "agent" and native.epoch == release.get("epoch", -2) + 1:
                                release["done"] = True
                            _write_record(home, record, lease)
                    result["resumeToken"] = record.get("resume")
                    result["nextN"] = record.get("sequence", 0) + 1
                    release = record.get("release", {})
                    if release:
                        result.update(releaseId=release["id"], released=bool(release.get("done")),
                                      continueBot=bool(release.get("continueBot")))
                        if record.get("continuation"):
                            result["continuation"] = record["continuation"]
                return {**result, "ok": True, **({"code": reason} if reason else {})}
            if op == "acquire":
                if not source:
                    raise _Refused(reason or "control_unavailable")
                if p.get("source") != source:
                    raise _Refused("source_changed")
                continuation = _continuation(p)
                with _file_lock(home / "bot-desktop" / "ocuclaw-control.lock", lease):
                    if not enrolled() or _source(home, placement) != source:
                        raise _Refused("profile_unavailable")
                    previous = _read_record(home)
                    native = lease.get(profile_key=str(home))
                    if (previous.get("acquireId") == p["id"] and _identity(previous, p)
                            and previous.get("source") == source and native.holder == "human"
                            and native.viewer_id == previous.get("viewer") and native.epoch == previous.get("epoch")):
                        result.update(lease=_native_state(native, previous, p, source), resumeToken=previous["resume"],
                                      nextN=previous.get("sequence", 0) + 1, ok=True, duplicate=True)
                        return result
                    record = {"v": 1, "profile": p["profileId"], "pairing": p["pairingId"],
                              "connection": p["connectionId"], "source": source, "viewer": "ocuclaw-" + secrets.token_urlsafe(32),
                              "resume": secrets.token_urlsafe(32), "sequence": 0, "cancel": 0, "receipts": [],
                              "acquireId": p["id"], "continuation": continuation}
                    native = lease.acquire(record["viewer"], profile_key=str(home), reason="OcuClaw")
                    record["epoch"] = native.epoch
                    _write_record(home, record, lease)
                result.update(lease=_native_state(native, record, p, source), resumeToken=record["resume"], nextN=1, ok=True)
                return result
            if not _identity(record, p):
                raise _Refused("not_owner")
            if (p.get("source") != record.get("source") or not _integer(p.get("epoch"))
                    or p.get("epoch") != record.get("epoch")):
                raise _Refused("control_changed")
            if op == "release":
                with _file_lock(home / "bot-desktop" / "ocuclaw-control.lock", lease):
                    current = _read_record(home)
                    if current.get("viewer") != record.get("viewer") or not _identity(current, p):
                        raise _Refused("control_changed")
                    native = lease.get(profile_key=str(home))
                    release = current.get("release")
                    if release:
                        if native.holder == "agent" and native.epoch == release.get("epoch", -2) + 1:
                            release["done"] = True
                    else:
                        if native.viewer_id != record["viewer"] or native.epoch != record["epoch"]:
                            raise _Refused("control_changed")
                        release = {"id": secrets.token_urlsafe(24), "epoch": record["epoch"], "done": False,
                                   "continueBot": p.get("continueBot") is True}
                        current["release"] = release
                        _write_record(home, current, lease)
                        native = lease.release(record["viewer"], profile_key=str(home))
                        release["done"] = native.holder == "agent" and native.epoch == record["epoch"] + 1
                    _write_record(home, current, lease)
                result.update(lease=_native_state(native, current, p, source), releaseId=release["id"],
                              released=bool(release["done"]), continueBot=bool(release.get("continueBot")),
                              ok=bool(release["done"]))
                if current.get("continuation"):
                    result["continuation"] = current["continuation"]
                if not result["ok"]:
                    result["code"] = "control_changed"
                return result
            if op != "input":
                raise _Refused("invalid_operation")
            if not source or source != record.get("source"):
                raise _Refused("source_changed")
            if not _integer(p.get("n")) or not 1 <= p["n"] < 2 ** 31:
                raise _Refused("invalid_sequence")
            # A separate nonblocking batch lock prevents concurrent key sequences, including
            # from another gateway process, without holding the native lease between units.
            with _file_lock(home / "bot-desktop" / "ocuclaw-control-input.lock", lease, timeout=0):
                return self._input(home, p, record, source, placement, geometry, lease, runtime, enrolled, result)
        except _Refused as exc:
            result.update(ok=False, code=exc.code)
            if exc.uncertain:
                result["uncertain"] = True
            return result
        except Exception:
            return {**result, "ok": False, "code": "control_unavailable"}

    def _input(self, home, p, record, source, placement, geometry, lease, runtime, enrolled, result):
        writer = None
        sent, units = 0, []
        # Validate the whole draft before opening a transport or reserving any delivery.
        width, height = geometry
        units = _units(p, width, height)
        with _file_lock(home / "bot-desktop" / "ocuclaw-control.lock", lease):
            current = _read_record(home)
            if current.get("viewer") != record.get("viewer") or not _identity(current, p):
                raise _Refused("control_changed")
            for receipt in current.get("receipts", []):
                if receipt.get("id") == p["id"]:
                    return {**result, **receipt, "id": p["id"], "duplicate": True}
            if p["n"] <= current.get("sequence", 0):
                raise _Refused("stale_sequence")
            current["sequence"] = p["n"]
            cancellation = current.get("cancel", 0)
            receipt = {"id": p["id"], "ok": False, "code": "delivery_uncertain", "uncertain": True}
            current["receipts"] = (current.get("receipts", []) + [receipt])[-_RECEIPTS:]
            _write_record(home, current, lease)
        try:
            writer = _Rfb(runtime, home, placement)
            if (writer.width, writer.height) != (width, height):
                raise _Refused("source_changed")
            for unit in units:
                # Exact native cross-process lock and disk read. A transition can only
                # happen before or after the complete modifier/down/up transaction.
                with _file_lock(lease._path(str(home)).with_suffix(".lock"), lease):
                    if not enrolled():
                        raise _Refused("profile_unavailable")
                    if _source(home, placement) != source:
                        raise _Refused("source_changed")
                    current = _read_record(home)
                    native = lease._read(lease._path(str(home)))
                    if (current.get("viewer") != record["viewer"] or native.holder != lease.HUMAN
                            or native.viewer_id != record["viewer"] or native.epoch != p["epoch"]):
                        raise _Refused("control_changed")
                    if current.get("cancel", 0) != cancellation:
                        raise _Refused("input_cancelled")
                    writer.send(unit)
                sent += 1
            result.update(ok=True, sent=sent, total=len(units), uncertain=False)
        except _Refused as exc:
            result.update(ok=False, code=exc.code, sent=sent, total=len(units), uncertain=exc.uncertain)
        except Exception:
            result.update(ok=False, code="delivery_uncertain", sent=sent, total=len(units), uncertain=writer is not None)
        finally:
            if writer is not None:
                try:
                    writer.close()
                except Exception:
                    pass
        # Durable receipts never contain draft text, input hashes or lengths.
        with _file_lock(home / "bot-desktop" / "ocuclaw-control.lock", lease):
            current = _read_record(home)
            if current.get("viewer") == record["viewer"]:
                safe = {k: result[k] for k in ("ok", "code", "uncertain") if k in result}
                for receipt in current.get("receipts", []):
                    if receipt.get("id") == p["id"]:
                        receipt.update(safe)
                _write_record(home, current, lease)
        native = lease.get(profile_key=str(home))
        result["lease"] = _native_state(native, _read_record(home), p, source)
        return result
