"""Task results from a process without the live adapter (#5031).

``hermes cron run <id>`` runs a job in the terminal, where no OcuClaw adapter
is live. Hermes then calls the platform's ``standalone_sender_fn``
(``tools/send_message_tool.py`` ``_send_via_adapter`` in Hermes 0.22.1)::

    await sender(pconfig, chat_id, message, thread_id=None, media_files=None,
                 force_document=False)
    -> {"success": True, "message_id": ...} | {"error": str}

with no ``metadata``, so no job id beside the text. :func:`standalone_send`
reads the job id from Hermes' wrapper and keeps the result in the inbox
(``task_results``) with the same stripping as a live send, marked
undelivered. Text that names no job is kept as a plain pending message. The
sender needs only SQLite under ``<HERMES_HOME>/state``: no adapter, no relay.

The running gateway's :class:`InboxPump` sends what is undelivered through
the adapter's own ``send()``, once, and marks it delivered. Results that
``send()`` stored itself are delivered already, so they are never sent twice.
Delivered is not acked: the wearer's ack belongs to the glasses.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Awaitable, Callable, Dict, Optional

from . import task_results
from .task_results import TaskResultStore, TaskResultStoreError

logger = logging.getLogger(__name__)

#: The home chat Hermes resolves for ``deliver=ocuclaw`` (#5025). Only the
#: fallback for an entry that names no chat.
HOME_CHANNEL_ENV = "OCUCLAW_HOME_CHANNEL"
INTERVAL_SECONDS = 5.0


def queue_delivery(chat_id: Any, message: Any, store: Optional[TaskResultStore] = None) -> str:
    """Keep one standalone delivery undelivered; return its id."""
    store = store or TaskResultStore()
    text = "" if message is None else str(message)
    if task_results.parse_cron_delivery(text)["job_id"]:
        return store.record_result(None, None, text, delivered=False, chat_id=chat_id).id
    return store.record_message(chat_id, text).id


async def standalone_send(pconfig: Any, chat_id: Any, message: Any, *, thread_id: Any = None,
                          media_files: Any = None, force_document: bool = False,
                          **_extra: Any) -> Dict[str, Any]:
    """Hermes' ``standalone_sender_fn`` for OcuClaw: queue for the gateway."""
    if not str(message or "").strip():
        return {"error": "OcuClaw delivers text only; the message was empty"}
    if media_files:
        logger.info("[ocuclaw] standalone delivery keeps the text; %d attachment(s) dropped", len(media_files))
    try:
        entry_id = await asyncio.to_thread(queue_delivery, chat_id, message)
    except (TaskResultStoreError, ValueError) as exc:
        return {"error": f"OcuClaw could not keep the message for the gateway: {exc}"}
    logger.info("[ocuclaw] standalone delivery %s queued for the gateway", entry_id)
    return {"success": True, "message_id": entry_id, "platform": "ocuclaw", "chat_id": chat_id, "queued": True}


def _home_chat() -> Optional[str]:
    return (os.environ.get(HOME_CHANNEL_ENV) or "").strip() or None


def _succeeded(result: Any) -> bool:
    if isinstance(result, dict):
        return bool(result.get("success"))
    return bool(getattr(result, "success", False))


class InboxPump:
    """Every ``interval`` seconds while the control link is up, send each
    undelivered inbox entry through ``send(chat_id, text)`` (the adapter's
    ``send()``) and mark it delivered. A failed send is retried next tick.

    A Task result goes to ``push_result(result_id)``, the Task push the live
    send uses, so the glasses get its pop-up and can ack it, now or on the
    next connect. Only when that returns False (the store cannot read it)
    does its clean text go to the chat, as live."""

    def __init__(self, send: Callable[[str, str], Awaitable[Any]], *, interval: float = INTERVAL_SECONDS,
                 store: Optional[TaskResultStore] = None,
                 home_chat: Callable[[], Optional[str]] = _home_chat,
                 push_result: Optional[Callable[[str], Awaitable[bool]]] = None,
                 watch_runs: Optional[Callable[[], Awaitable[Any]]] = None):
        self._send = send
        self._push_result = push_result
        # #6420: each tick also looks for a Task run that started or ended.
        self._watch_runs = watch_runs
        self._interval = interval
        self._store = store
        self._home_chat = home_chat
        self._task: Optional[asyncio.Task] = None
        self._warned: set = set()

    async def tick(self) -> int:
        """Deliver what is pending; return how many were sent."""
        try:
            store = self._store or TaskResultStore()
            pending = await asyncio.to_thread(store.list_undelivered)
        except TaskResultStoreError as exc:
            logger.debug("[ocuclaw] task inbox unavailable: %s", exc)
            return 0
        sent = 0
        for entry in pending:
            chat_id = entry.chat_id or self._home_chat()
            if not chat_id:
                self._warn(entry.id, "no chat to deliver to")
                continue
            if not await asyncio.to_thread(store.mark_delivered, entry.id):
                continue  # another tick got there first
            try:
                ok = (entry.job_id is not None and self._push_result is not None
                      and await self._push_result(entry.id))
                if not ok:
                    ok = _succeeded(await self._send(chat_id, entry.text))
            except asyncio.CancelledError:
                await asyncio.to_thread(store.unmark_delivered, entry.id)
                raise
            except Exception as exc:  # noqa: BLE001 - stays pending; sent again later
                logger.debug("[ocuclaw] task inbox send raised: %s", exc)
                ok = False
            if not ok:
                await asyncio.to_thread(store.unmark_delivered, entry.id)
                self._warn(entry.id, "send failed; retrying")
                break  # keep the order: nothing newer goes first
            sent += 1
        return sent

    def _warn(self, entry_id: str, why: str) -> None:
        if entry_id not in self._warned:
            self._warned.add(entry_id)
            logger.warning("[ocuclaw] task inbox entry %s not delivered: %s", entry_id, why)

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - the inbox never takes the gateway down
                logger.exception("[ocuclaw] task inbox tick failed")
            if self._watch_runs is not None:
                try:
                    await self._watch_runs()
                except Exception:  # noqa: BLE001
                    logger.exception("[ocuclaw] task run watch failed")

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
