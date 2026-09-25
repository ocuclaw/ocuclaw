"""Hermes Board moment policy (#3053); contract in docs/hermes-board/contract.md
("Policy (#3053)").

The backend owns when a moment may interrupt: moments on or off, the quiet
"done" moment (off by default), and quiet hours in an explicit IANA time
zone that is stored with the preference. This module is the pure part:
validating a wanted policy, reading a stored one, and deciding at an
instant whether moments are delivered, held for quiet hours, off, or held
because the policy is unknown. ``board_moments`` stores it (table
``board_policy`` in OcuClaw's Board store, one row per profile) and applies
it to the tail and the push.

Stock only. Nothing here reads or writes Hermes' config. 0.21.4 adds a
native display key that suppresses warning notifications (0.21.5 keeps it);
Board settings never read or write it (the policy test checks no
Board module names it).

Unknown policy state defers interruptions: a stored row that does not read
back, or a time zone this gateway cannot load, holds every push (the
deliveries stay pending and durable) until the wearer saves a policy again.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import re
import sqlite3
from typing import Any, Optional

POLICY_VERSION = 1

#: What the backend does with moments right now (the ``now`` a read reports).
DELIVERING = "delivering"
QUIET = "quiet"
OFF = "off"
HELD = "held"
DECISIONS = (DELIVERING, QUIET, OFF, HELD)

#: ``state``: nothing stored (the defaults), a stored policy, or a stored row
#: that does not read back.
STATES = ("default", "saved", "unknown")

_TIME = re.compile(r"^([01][0-9]|2[0-3]):([0-5][0-9])$")
#: An IANA name shape (``UTC``, ``Europe/London``, ``America/Argentina/Salta``,
#: ``Etc/GMT+5``). No dots, so never a path.
_ZONE = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]{0,31}(/[A-Za-z0-9_+-]{1,32}){0,2}$")
ZONE_MAX = 64


@dataclass(frozen=True)
class Quiet:
    start: int  # minutes after local midnight, inclusive
    end: int  # minutes after local midnight, exclusive; never equal to start
    zone: str


@dataclass(frozen=True)
class Policy:
    state: str
    moments: bool = True
    done: bool = False
    quiet: Optional[Quiet] = None


DEFAULT = Policy("default")
UNKNOWN = Policy("unknown")

SCHEMA = ("CREATE TABLE IF NOT EXISTS board_policy ("
          " profile TEXT PRIMARY KEY, policy TEXT NOT NULL, updated_at INTEGER NOT NULL)")


def _minutes(value: Any) -> Optional[int]:
    match = _TIME.match(value) if isinstance(value, str) else None
    return None if match is None else int(match.group(1)) * 60 + int(match.group(2))


def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def zone(name: Any):
    """The ``ZoneInfo`` for an IANA name, or None when the name is malformed or
    this gateway has no data for it."""
    if not isinstance(name, str) or len(name) > ZONE_MAX or not _ZONE.match(name):
        return None
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - ZoneInfoNotFoundError, ValueError, OSError: unknown zone
        return None


def _quiet(raw: Any, *, check_zone: bool) -> tuple:
    """``(ok, Quiet|None)`` for a wire ``quiet`` value."""
    if raw is None:
        return True, None
    if not isinstance(raw, dict) or set(raw) != {"from", "to", "timezone"}:
        return False, None
    start, end, name = _minutes(raw["from"]), _minutes(raw["to"]), raw["timezone"]
    if start is None or end is None or start == end:
        return False, None
    if not isinstance(name, str) or len(name) > ZONE_MAX or not _ZONE.match(name):
        return False, None
    if check_zone and zone(name) is None:
        return False, None
    return True, Quiet(start, end, name)


def parse_request(raw: Any) -> Optional[Policy]:
    """A wanted policy (``board.policy.set``): exact keys ``moments``, ``done``,
    ``quiet``; ``quiet`` is null or ``{from, to, timezone}`` with ``HH:MM``
    times that differ and a time zone this gateway can load. None when any of
    it is not valid."""
    if not isinstance(raw, dict) or set(raw) != {"moments", "done", "quiet"}:
        return None
    if not isinstance(raw["moments"], bool) or not isinstance(raw["done"], bool):
        return None
    ok, quiet = _quiet(raw["quiet"], check_zone=True)
    return Policy("saved", raw["moments"], raw["done"], quiet) if ok else None


def to_json(policy: Policy) -> str:
    return json.dumps({"v": POLICY_VERSION, **wire(policy)}, sort_keys=True)


def from_json(text: Any) -> Policy:
    """A stored row. Anything that does not read back is ``UNKNOWN``, never
    the defaults: unknown policy state defers interruptions. A stored zone is
    not loaded here; one the gateway cannot load holds at decision time."""
    try:
        raw = json.loads(text) if isinstance(text, str) else None
    except ValueError:
        return UNKNOWN
    if not isinstance(raw, dict) or raw.get("v") != POLICY_VERSION or set(raw) != {"v", "moments", "done", "quiet"}:
        return UNKNOWN
    if not isinstance(raw["moments"], bool) or not isinstance(raw["done"], bool):
        return UNKNOWN
    ok, quiet = _quiet(raw["quiet"], check_zone=False)
    return Policy("saved", raw["moments"], raw["done"], quiet) if ok else UNKNOWN


def wire(policy: Policy) -> dict:
    """``{moments, done, quiet}`` as the contract spells it."""
    quiet = None if policy.quiet is None else {
        "from": _clock(policy.quiet.start), "to": _clock(policy.quiet.end), "timezone": policy.quiet.zone}
    return {"moments": policy.moments, "done": policy.done, "quiet": quiet}


def in_quiet(quiet: Quiet, now: int) -> Optional[bool]:
    """Whether the instant ``now`` (unix seconds) is inside the quiet window,
    by the wall clock of the window's own time zone. The window starts at
    ``from`` and ends before ``to``; ``to`` earlier than ``from`` crosses
    midnight. None when the zone cannot be loaded (unknown: hold).

    Wall-clock rule on DST days: a skipped local time never happens (a window
    that lies wholly in the skipped hour is empty that night), and a repeated
    local time is inside the window both times it happens."""
    tz = zone(quiet.zone)
    if tz is None:
        return None
    local = datetime.fromtimestamp(int(now), timezone.utc).astimezone(tz)
    minute = local.hour * 60 + local.minute
    if quiet.start < quiet.end:
        return quiet.start <= minute < quiet.end
    return minute >= quiet.start or minute < quiet.end


def decision(policy: Policy, now: int) -> str:
    """What the backend does with a moment for this policy at ``now``."""
    if policy.state == "unknown":
        return HELD
    if not policy.moments:
        return OFF
    if policy.quiet is None:
        return DELIVERING
    quiet = in_quiet(policy.quiet, now)
    if quiet is None:
        return HELD
    return QUIET if quiet else DELIVERING


def view(policy: Policy, now: int) -> dict:
    """The ``policy`` a ``board.policy`` read (or set) answers. An unknown
    policy carries only its state and ``now``: there is nothing true to show."""
    if policy.state == "unknown":
        return {"state": "unknown", "now": HELD}
    return {"state": policy.state, **wire(policy), "now": decision(policy, now)}


def load(conn: sqlite3.Connection, profile: str) -> Policy:
    """This profile's policy from an open Board store connection. No row is
    the defaults; a row that does not read back is unknown. A store error
    propagates (the caller treats it as unknown or refuses)."""
    row = conn.execute("SELECT policy FROM board_policy WHERE profile = ?", [profile]).fetchone()
    return DEFAULT if row is None else from_json(row[0])
