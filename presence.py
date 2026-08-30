"""The Node→Python presence hop (#1317, contract #1273 §9).

**The problem this exists to kill.** For up to thirty seconds after a user
pairs their phone, diagnosis could report ``no-client`` while the phone was
in fact connected. The relay knew the truth the instant the client
authenticated; nothing carried it across the process boundary until the next
poll came round.

**The shape of the fix, and its deliberate limits.** Node pushes *latency*;
Python pulls *truth*. The push frame carries a monotonic dirty revision and
nothing else — no client names, ids, capabilities, sessions, raw snapshots,
or secrets cross this seam, so the push can never be the thing a diagnosis
believes. Python acknowledges it immediately, then performs one bounded
authoritative pull at a time; pushes that arrive while a pull is in flight
coalesce into a single follow-up rather than queueing. A periodic pull is the
fallback, so a dropped or unsupported push degrades to the old latency rather
than to silence.

This is the narrow seam #1273 P3 locked, and nothing more: there is no
general status framework here, no subscription registry, and no second
transport.

**On pull failure Python still writes.** A receipt with null app facts and an
allowlisted error code is the honest record of "the relay did not answer";
refreshing the previous client truth would be worse than useless, because the
snapshot's freshness rules would then treat a stale count as current fact.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .receipts import PULL_ERROR_CODES, build_app_presence_body, now_iso

logger = logging.getLogger(__name__)

#: Node → Python. Params ``{"rev": <monotonic int>}``. Fire-and-forget in
#: practice: Python acknowledges before doing any work.
PRESENCE_DIRTY_METHOD = "presence.dirty"

#: Python → Node. No params. Returns the narrow public-safe projection.
PRESENCE_SNAPSHOT_METHOD = "presence.snapshot"

#: The authoritative pull is bounded hard — a slow relay must never hold a
#: diagnosis open (#1273 §9).
PULL_TIMEOUT_S = 2.0

#: Bounds mirrored from the relay's own projection cap.
CLIENT_VERSION_MAX_CHARS = 32
CLIENT_VERSION_MAX_COUNT = 8
_CLIENT_VERSION_RE = re.compile(r"^[A-Za-z0-9._+\-]+$")


#: Fallback cadence; also the receipt's own "writes every 30 seconds" rule.
PULL_INTERVAL_S = 30.0

PROJECTION_KEYS = (
    "relayListening",
    "authenticatedAppCount",
    "clientVersions",
    "lastTransitionAt",
)


class PresenceLinkUnavailableError(RuntimeError):
    """The control link is absent or not ready, so no pull is possible.

    Distinct from a failed pull: "the link is down" and "the relay's presence
    method failed" are different diagnoses, and the receipt's error code is
    the only place that distinction survives.
    """

# Re-exported next to the pump that emits them: the receipt owns the field,
# this module owns every value that can land in it.
__all__ = [
    "PRESENCE_DIRTY_METHOD",
    "PRESENCE_SNAPSHOT_METHOD",
    "PROJECTION_KEYS",
    "PULL_ERROR_CODES",
    "PULL_INTERVAL_S",
    "PULL_TIMEOUT_S",
    "PresenceLinkUnavailableError",
    "PresencePump",
    "normalize_projection",
]


def normalize_projection(value: Any) -> Optional[Dict[str, Any]]:
    """Accept only the narrow projection shape; anything else is a failure.

    The seam is a trust boundary, so the parse is total and defensive: an
    unexpected shape yields ``None`` (which the caller turns into a
    null-facts receipt carrying an error code) rather than a half-believed
    record. A dict carrying none of the promised keys counts as unexpected —
    silently defaulting it to all-nulls would report "relay answered, knows
    nothing", which is a different and untrue statement from "the relay did
    not answer in the shape we asked for".
    """
    if not isinstance(value, dict):
        return None
    # Validate the WHOLE shape before accepting any part of it. Field-by-field
    # tolerance looks defensive and is the opposite: `{"relayListening":
    # false}` from a skewed or faulty child would otherwise be taken as a
    # successful observation and become an authoritative `relay_not_listening`
    # outage, built from a response that never carried the other three facts.
    # A projection is either the contracted shape or it is not an answer.
    if any(key not in value for key in PROJECTION_KEYS):
        return None

    listening = value["relayListening"]
    if listening is not None and not isinstance(listening, bool):
        return None
    count = value["authenticatedAppCount"]
    if isinstance(count, bool):
        return None
    if count is not None and (not isinstance(count, int) or count < 0):
        return None
    if not isinstance(value["clientVersions"], (list, tuple)):
        return None
    if value["lastTransitionAt"] is not None and not isinstance(
        value["lastTransitionAt"], str
    ):
        return None
    # Bounded again on receipt. The relay already caps this list, but the
    # receipt is written synchronously and fsynced on every pull, so the
    # parent does not take the child's word for how big its own disk write
    # is allowed to get.
    versions: List[str] = []
    for item in value["clientVersions"]:
        if len(versions) >= CLIENT_VERSION_MAX_COUNT:
            break
        if not isinstance(item, str):
            continue
        trimmed = item.strip()
        if not trimmed or len(trimmed) > CLIENT_VERSION_MAX_CHARS:
            continue
        if not _CLIENT_VERSION_RE.match(trimmed):
            continue
        if trimmed not in versions:
            versions.append(trimmed)
    transition = value["lastTransitionAt"]
    if not isinstance(transition, str) or not transition.strip():
        transition = None
    return {
        "relayListening": listening,
        "authenticatedAppCount": count,
        "clientVersions": versions,
        "lastTransitionAt": transition,
    }


class PresencePump:
    """Owns one adapter's app-presence receipt lifecycle.

    Injected collaborators (``pull``/``write``) keep this class free of both
    the control link and the filesystem, so the coalescing rules can be
    tested for what they are — scheduling logic — without a child process or
    a temp dir.
    """

    def __init__(
        self,
        *,
        pull: Callable[[], Awaitable[Any]],
        write: Callable[[Dict[str, Any]], Any],
        profile_fingerprint: Optional[str],
        epoch: Optional[int] = None,
        pull_timeout_s: float = PULL_TIMEOUT_S,
        interval_s: float = PULL_INTERVAL_S,
        log: Optional[logging.Logger] = None,
    ) -> None:
        self._pull = pull
        self._write = write
        self._fingerprint = profile_fingerprint
        self._epoch = epoch
        self._pull_timeout_s = pull_timeout_s
        self._interval_s = interval_s
        self._log = log or logger
        self._task: Optional[asyncio.Task] = None
        self._timer: Optional[asyncio.Task] = None
        self._pending = False
        self._closed = False
        self._last_rev: Optional[int] = None
        self.counters = {
            "pushes": 0,
            "pulls": 0,
            "coalesced": 0,
            "writes": 0,
            "write_failures": 0,
        }

    # -- link surface --------------------------------------------------------

    async def handle_dirty(self, params: Any) -> Dict[str, Any]:
        """The ``presence.dirty`` handler: acknowledge first, work after.

        The child gets its answer without waiting on a pull or a disk write,
        which is what keeps a burst of connects from backing up the link.
        """
        self.counters["pushes"] += 1
        rev = None
        if isinstance(params, dict):
            candidate = params.get("rev")
            if isinstance(candidate, int) and not isinstance(candidate, bool):
                rev = candidate
        if rev is not None:
            if self._last_rev is not None and rev <= self._last_rev:
                # A replayed or out-of-order revision carries no new truth.
                return {"ok": True, "stale": True}
            self._last_rev = rev
        self.schedule()
        return {"ok": True}

    def schedule(self) -> None:
        """Request an authoritative pull, coalescing into one in flight."""
        if self._closed:
            return
        if self._task is not None and not self._task.done():
            self._pending = True
            self.counters["coalesced"] += 1
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._task = loop.create_task(self._run())

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Begin the fallback cadence and take a first reading."""
        self._closed = False
        if self._timer is None or self._timer.done():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            self._timer = loop.create_task(self._tick())
        self.schedule()

    async def stop(self, *, final_write: bool = True) -> None:
        """Cancel the cadence and record the clean shutdown.

        The shutdown receipt states what is true at that moment — the relay
        is going down and no client is connected — rather than leaving the
        last healthy reading to age out over the next two minutes.
        """
        self._closed = True
        for task in (self._timer, self._task):
            if task is not None and not task.done():
                task.cancel()
        self._timer = None
        self._task = None
        if final_write:
            self._write_body(
                relay_listening=False,
                count=0,
                versions=[],
                last_transition_at=now_iso(),
                error_code="shutdown",
            )

    # -- internals -----------------------------------------------------------

    async def _tick(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self._interval_s)
                self.schedule()
        except asyncio.CancelledError:  # pragma: no cover - teardown path
            raise

    async def _run(self) -> None:
        while True:
            await self._pull_once()
            if not self._pending or self._closed:
                return
            self._pending = False

    async def _pull_once(self) -> None:
        self.counters["pulls"] += 1
        projection = None
        error_code: Optional[str] = None
        try:
            raw = await asyncio.wait_for(self._pull(), timeout=self._pull_timeout_s)
            projection = normalize_projection(raw)
            if projection is None:
                error_code = "pull_unsupported"
        except asyncio.TimeoutError:
            error_code = "pull_timeout"
        except asyncio.CancelledError:  # pragma: no cover - teardown path
            raise
        except PresenceLinkUnavailableError as exc:
            error_code = "link_down"
            self._log.debug("[ocuclaw] presence pull skipped: %s", exc)
        except Exception as exc:  # noqa: BLE001 — a failed pull is a receipt
            error_code = "pull_failed"
            self._log.debug("[ocuclaw] presence pull failed: %s", exc)

        if projection is None:
            # Never refresh old client truth on failure.
            self._write_body(
                relay_listening=None,
                count=None,
                versions=[],
                last_transition_at=None,
                error_code=error_code or "pull_failed",
            )
            return
        self._write_body(
            relay_listening=projection["relayListening"],
            count=projection["authenticatedAppCount"],
            versions=projection["clientVersions"],
            last_transition_at=projection["lastTransitionAt"],
            error_code=None,
        )

    def _write_body(
        self,
        *,
        relay_listening: Optional[bool],
        count: Optional[int],
        versions: List[str],
        last_transition_at: Optional[str],
        error_code: Optional[str],
    ) -> None:
        body = build_app_presence_body(
            profile_fingerprint=self._fingerprint,
            epoch=self._epoch,
            relay_listening=relay_listening,
            authenticated_app_count=count,
            client_versions=versions,
            last_transition_at=last_transition_at,
            observation_error_code=error_code,
        )
        try:
            self._write(body)
        except Exception as exc:  # noqa: BLE001 — a receipt write never breaks a turn
            self.counters["write_failures"] += 1
            self._log.warning("[ocuclaw] app-presence receipt write failed: %s", exc)
            return
        self.counters["writes"] += 1
