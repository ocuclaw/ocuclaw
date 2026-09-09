"""Desktop-owned machine inventory, separate from gateway execution routes.

Only the capability-gated Desktop presenter may publish. The gateway reads a
bounded, atomic snapshot; neither a cached roster nor an SDK route descriptor
grants permission to dispatch an OcuClaw turn on a remote machine.
"""
from __future__ import annotations

import hashlib
import json
import socket
import threading
import time
from pathlib import Path
from typing import Any

from .profile_lifecycle import write_private
from .receipts import resolve_receipt_home

SCHEMA = "ocuclaw.desktop-fleet@1"
FILENAME = "ocuclaw-desktop-fleet.json"
MAX_BYTES = 256 * 1024
MAX_MACHINES = 64
MAX_PROFILES = 512
STALE_AFTER_MS = 45_000
# Desktop's untouched local-connection labels (plus our own publish fallback).
# A user-set label is kept verbatim; only these placeholders give way to the
# gateway host's name.
GENERIC_LABELS = frozenset({"this device", "this machine", "hermes machine"})
_LOCK = threading.Lock()


def _path() -> Path:
    home = resolve_receipt_home()
    if home is None:
        raise ValueError("fleet receiver unavailable")
    return home / "state" / FILENAME


def _text(value: Any, limit: int = 160) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError("invalid fleet text")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("invalid fleet text")
    return value.strip()


def profile_id(connection_id: str, profile: str) -> str:
    """Opaque, deterministic pair identity; display labels never route requests."""
    pair = json.dumps([connection_id, profile], ensure_ascii=False, separators=(",", ":"))
    return "hermes-fleet-" + hashlib.sha256(pair.encode()).hexdigest()[:32]


def normalize_snapshot(value: Any) -> dict:
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise ValueError("invalid fleet schema")
    machines = value.get("machines")
    if not isinstance(machines, list) or len(machines) > MAX_MACHINES:
        raise ValueError("invalid fleet machines")
    receiver = value.get("receiver")
    if not isinstance(receiver, dict):
        raise ValueError("invalid fleet receiver")
    receiver_id = _text(receiver.get("connectionId"))
    receiver_profile = _text(receiver.get("profile"))
    seen_machines, seen_profiles = set(), set()
    rows = []
    for machine in machines:
        if not isinstance(machine, dict):
            raise ValueError("invalid fleet machine")
        connection_id = _text(machine.get("connectionId"))
        if connection_id in seen_machines:
            raise ValueError("duplicate fleet machine")
        seen_machines.add(connection_id)
        kind = machine.get("kind")
        if kind not in {"local", "remote", "ssh", "cloud"}:
            kind = "unknown"
        availability = machine.get("availability")
        if availability not in {"reachable", "unavailable", "unknown"}:
            availability = "unknown"
        profiles = machine.get("profiles")
        if not isinstance(profiles, list):
            raise ValueError("invalid fleet profiles")
        profile_rows = []
        for profile in profiles:
            if not isinstance(profile, dict):
                raise ValueError("invalid fleet profile")
            name = _text(profile.get("profile"))
            identity = profile_id(connection_id, name)
            if identity in seen_profiles:
                raise ValueError("duplicate fleet profile")
            seen_profiles.add(identity)
            if len(seen_profiles) > MAX_PROFILES:
                raise ValueError("too many fleet profiles")
            profile_rows.append({
                "id": identity,
                "profile": name,
                "displayName": _text(profile.get("displayName") or name),
                # A route descriptor is useful inventory, not OcuClaw support.
                "execution": "inventory_only",
            })
        rows.append({
            "connectionId": connection_id,
            "label": _text(machine.get("label")),
            "kind": kind,
            "availability": availability,
            "isReceiver": connection_id == receiver_id,
            "profiles": profile_rows,
        })
    return {
        "schema": SCHEMA,
        "receiver": {"connectionId": receiver_id, "profile": receiver_profile},
        "machines": rows,
    }


def publish(value: Any) -> dict:
    snapshot = normalize_snapshot(value)
    snapshot["observedAtMs"] = int(time.time() * 1000)
    raw = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if len(raw.encode()) > MAX_BYTES:
        raise ValueError("fleet snapshot too large")
    with _LOCK:
        path = _path()
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_private(path, raw)
    return {"ok": True, "observedAtMs": snapshot["observedAtMs"]}


def host_label() -> str | None:
    """Short hostname of the box this gateway runs on, or None when unusable."""
    try:
        name = socket.gethostname().split(".")[0]
        return _text(name, limit=64)
    except (OSError, ValueError):
        return None


def with_host_label(snapshot: dict) -> dict:
    """Name the receiver machine after this host when Desktop left it generic.

    The receiver is the connection whose gateway is THIS process, so its
    hostname is known here; the other machines' names are Desktop's to keep.
    """
    machines = []
    for machine in snapshot.get("machines", []):
        if machine.get("isReceiver") and str(machine.get("label", "")).lower() in GENERIC_LABELS:
            name = host_label()
            if name:
                machine = {**machine, "label": name}
        machines.append(machine)
    return {**snapshot, "machines": machines}


def read() -> dict:
    """Return display data only, marking stale Desktop snapshots explicitly."""
    empty = {"schema": SCHEMA, "status": "unavailable", "stale": True,
             "observedAtMs": 0, "staleAfterMs": STALE_AFTER_MS, "machines": []}
    try:
        path = _path()
        if path.stat().st_size > MAX_BYTES:
            return empty
        raw = json.loads(path.read_text(encoding="utf-8"))
        snapshot = with_host_label(normalize_snapshot(raw))
        stamp = raw.get("observedAtMs")
        if type(stamp) is not int or stamp <= 0:
            return empty
        age = int(time.time() * 1000) - stamp
        stale = age < 0 or age > STALE_AFTER_MS
        return {**snapshot, "observedAtMs": stamp, "staleAfterMs": STALE_AFTER_MS,
                "stale": stale, "status": "stale" if stale else "ready"}
    except (OSError, ValueError, TypeError, AttributeError):
        return empty
