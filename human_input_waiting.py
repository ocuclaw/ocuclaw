"""Waiting on you (#4979): prompts that block an agent on another surface.

Hermes 0.21.6+ fires ``on_human_input_request`` right before any prompt that
blocks an agent on a person (a dangerous-command approval, a clarify question,
a sudo password) and ``on_human_input_resolved`` exactly once when the wait
ends, with the same ``request_id`` (tools/human_input_hooks.py). This module
turns those two observers into one list the wearer can see: "Desktop is
waiting on you", "Discord is waiting on you".

Rules (wire contract: PROTOCOL.md "Waiting on you"):

* OcuClaw chats are skipped. They keep their own approval and question cards.
* The wearer's ``waiting.settings`` (master switch plus one switch per
  surface) apply before the grace timer: a muted surface sends nothing.
* A wait shows only after a 15 s grace. One answered inside it sends nothing.
* A TTL backstop drops a wait whose resolve never came, at the prompt's own
  timeout plus 60 s.
* Each visible change sends the full list as backend event ``waiting``.
* ``waiting.answer`` (#4983) answers one approval or clarify wait by its exact
  pending id, only while the wearer's answer switch is on.
* A sudo wait is answerable only while the gateway holds its password prompt
  open for a Desktop or TUI chat (``gateway/session_sudo_prompt.py``; the
  table lives in ``gateway/session_server_requests.py`` from 0.22.3). The
  typed password settles that prompt as the viewer's own answer would, and the
  viewer's card is withdrawn. The password is never logged, stored or sent on.
* While "Explain commands" is on (#4985), an approval item carries a
  relay-only ``explain`` block (full command, Hermes' description, and for a
  local chat its last user message) for the shared explainer. The relay never
  forwards it to the app.

Both hooks run ON THE BLOCKED AGENT THREAD. They copy the fields, arm a timer
and return; every read of Hermes state (session row, config, pending entries)
happens later on the timer thread. Nothing here may raise into Hermes.
"""

from __future__ import annotations

import inspect
import logging
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from . import bot_screen

logger = logging.getLogger(__name__)

REQUEST_HOOK_NAME = "on_human_input_request"
RESOLVED_HOOK_NAME = "on_human_input_resolved"
HOOK_NAMES = (REQUEST_HOOK_NAME, RESOLVED_HOOK_NAME)
FEATURE_TOKEN = "human_input_waiting"
WAITING_EVENT_NAME = "waiting"
# Child -> parent RPC: ``{show, answer, surfaces}`` -> ``{ok, supported,
# availableSurfaces}``. Pushed at relay start and on every change.
WAITING_SETTINGS_METHOD = "waiting.settings"
# Child -> parent RPC (#4983): ``{requestId, choice | answer, reason?}`` ->
# ``{requestId, status, reason?, kind?, choice?}``. A refusal is a result,
# never an error.
WAITING_ANSWER_METHOD = "waiting.answer"
ANSWER_REASON_MAX_CHARS = 500

KINDS = ("approval", "clarify", "sudo")
GRACE_S = 15.0
TTL_SLACK_S = 60.0
PREVIEW_MAX_CHARS = 240
# The explainer refuses a longer command (approval-explainer.ts COMMAND_MAX),
# so a longer one is not sent at all rather than cut.
EXPLAIN_COMMAND_MAX_CHARS = 2000
EXPLAIN_DESCRIPTION_MAX_CHARS = 500

# Prompt timeouts as Hermes 0.22.1 applies them.
# approvals: tools/approval_context.py `_get_approval_timeout` (approvals.timeout).
APPROVAL_TIMEOUT_DEFAULT_S = 300
# clarify: tools/clarify_gateway.py `resolve_clarify_timeout` — legacy
# clarify.timeout, else agent.clarify_timeout, else 3600; <= 0 is unlimited.
CLARIFY_TIMEOUT_DEFAULT_S = 3600
# sudo: the TUI/Desktop viewer asks with timeout=120 (tui_gateway/
# agent_callbacks.py); the bare /dev/tty read uses 45. The longer one bounds both.
SUDO_TIMEOUT_S = 120
# An unlimited clarify still needs a backstop: a wait whose resolve hook was
# lost must not sit on the wearer's list forever.
UNLIMITED_TIMEOUT_S = 24 * 60 * 60
# How long chat setup's step 9 question stays off the glasses at most, so a
# lost release never hides other questions for long.
SETUP_QUESTION_HOLD_S = 10 * 60

LOCAL_SURFACES = ("desktop", "tui", "cli")
# Session row ``source`` -> surface (agent/session_source.py: Desktop writes
# ``desktop``, the TUI ``tui``, ``hermes chat`` ``cli``, and a one-shot
# ``hermes chat -q`` ``oneshot``). On 0.22.1 the gateway owns the row and
# stores the client's creation label: Desktop creates with ``gui``
# (gateway/session_policy.py SURFACES maps it to desktop).
_SOURCE_SURFACES = {
    "desktop": "desktop",
    "gui": "desktop",
    "tui": "tui",
    "cli": "cli",
    "oneshot": "cli",
}
# Hook ``platform`` values that are not a messaging chat. Mirrors Hermes's
# gateway/session_context.py NON_MESSAGING_SESSION_SURFACES, plus the local
# sources and automation lanes. For these the surface comes from the session
# row's ``source``; a local turn reports ``platform="local"``.
NON_MESSAGING_PLATFORMS = frozenset({
    "", "acp", "api_server", "batch", "cli", "codex", "cron", "desktop",
    "gateway", "kanban", "local", "msgraph_webhook", "oneshot", "subagent",
    "tool", "tui", "webhook",
})
OCUCLAW_PLATFORM = "ocuclaw"

APPROVAL_CHOICES = ("once", "session", "always", "deny")
SURFACE_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
MAX_SURFACE_KEYS = 32
_WHITESPACE_RE = re.compile(r"\s+")
# (pending_id, choices, multi_select, description) of a wait's pending entry.
_PendingMatch = Tuple[Optional[str], Optional[List[str]], bool, Optional[str]]


# -- settings ---------------------------------------------------------------


class WaitingSettings:
    """The wearer's ``waitingOnYou`` setting as last pushed by the child.

    ``surfaces`` holds only explicit choices. A missing surface follows the
    default rule: Desktop, TUI and CLI on, every other surface off. Until the
    first push the defaults apply (show on, answer off, no explicit choices).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._show = True
        self._answer = False
        self._surfaces: Dict[str, bool] = {}

    def apply(self, params: Any) -> Dict[str, Any]:
        """Replace the state from one push; bad fields fall back to defaults."""
        src = params if isinstance(params, Mapping) else {}
        show = src.get("show")
        answer = src.get("answer")
        surfaces: Dict[str, bool] = {}
        raw = src.get("surfaces")
        if isinstance(raw, Mapping):
            for name in sorted(str(k) for k in raw.keys()):
                if len(surfaces) >= MAX_SURFACE_KEYS:
                    break
                value = raw.get(name)
                if SURFACE_NAME_RE.match(name) and isinstance(value, bool):
                    surfaces[name] = value
        with self._lock:
            self._show = show if isinstance(show, bool) else True
            self._answer = answer if isinstance(answer, bool) else False
            self._surfaces = surfaces
        return {"show": self.show, "answer": self.answer, "surfaces": dict(surfaces)}

    @property
    def show(self) -> bool:
        with self._lock:
            return self._show

    @property
    def answer(self) -> bool:
        with self._lock:
            return self._answer

    def surface_on(self, surface: str) -> bool:
        with self._lock:
            explicit = self._surfaces.get(surface)
        if explicit is not None:
            return explicit
        return surface in LOCAL_SURFACES

    def shows(self, surface: Optional[str]) -> bool:
        return bool(surface) and self.show and self.surface_on(str(surface))

    def any_local_on(self) -> bool:
        return self.show and any(self.surface_on(s) for s in LOCAL_SURFACES)


# -- Hermes readers (guarded; each one is optional) ---------------------------


def list_gateway_approvals(session_key: str) -> List[Dict[str, Any]]:
    """Unresolved gateway approvals for one session (public Hermes API)."""
    from tools.approval import list_gateway_approvals as _list

    return list(_list(session_key) or [])


def pending_clarify(session_key: str) -> Any:
    """Oldest unresolved clarify entry for one session (public Hermes API)."""
    from tools.clarify_gateway import get_pending_for_session

    return get_pending_for_session(session_key, include_choice_prompts=True)


_REQUEST_ID_PROBE: Dict[Any, bool] = {}


def resolver_takes_request_id(resolve: Callable[..., Any]) -> bool:
    """Whether Hermes's ``resolve_gateway_approval`` can target one entry.

    Probed once per function object. Without ``request_id`` it resolves the
    session's FIFO head, which may be a different prompt than the one asked.
    """
    cached = _REQUEST_ID_PROBE.get(resolve)
    if cached is not None:
        return cached
    try:
        params = inspect.signature(resolve).parameters
        supported = "request_id" in params or any(
            p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
        )
    except (TypeError, ValueError):
        supported = False
    _REQUEST_ID_PROBE[resolve] = supported
    return supported


def resolve_approval_by_id(
    session_key: str, choice: str, request_id: str, reason: Optional[str]
) -> Optional[int]:
    """Resolve exactly one gateway approval. ``None``: this Hermes cannot
    target an id, and the queue head is never a stand-in for it."""
    from tools.approval import resolve_gateway_approval

    if not resolver_takes_request_id(resolve_gateway_approval):
        return None
    return int(
        resolve_gateway_approval(
            session_key, choice, reason=reason, request_id=request_id
        )
        or 0
    )


def resolve_clarify(clarify_id: str, response: str) -> bool:
    """Answer one clarify entry (public Hermes API); False when it is gone."""
    from tools.clarify_gateway import resolve_gateway_clarify

    return bool(resolve_gateway_clarify(clarify_id, response))


SUDO_PROMPT_MODULE = "gateway.session_sudo_prompt"
# 0.22.3 moved the open-request table and ``resolve`` out of
# session_sudo_prompt into this module, and its wait now withdraws every
# viewer's card itself once one viewer answers.
SERVER_REQUESTS_MODULE = "gateway.session_server_requests"


def _viewer_requests() -> Tuple[Any, bool]:
    """The loaded module that holds the open viewer requests, and whether it
    withdraws the viewers' cards itself when one settles.

    ``ask_sudo`` imports session_server_requests before it opens a prompt on
    0.22.3, so a process that has an open prompt has the module loaded.
    """
    requests = sys.modules.get(SERVER_REQUESTS_MODULE)
    if requests is not None:
        return requests, True
    return sys.modules.get(SUDO_PROMPT_MODULE), False


def open_viewer_sudo(session_id: str) -> Optional[str]:
    """The ``srq-`` id of the password prompt the gateway holds open for this
    session's attached viewers (Desktop, TUI), else None.

    On 0.22.1 a local viewer's turn asks for the password with a ``sudo``
    server request and waits in ``session_sudo_prompt._open`` until a viewer
    answers (``session_server_requests._open`` from 0.22.3). That table also
    holds the session's ``secret`` and ``clarify`` viewer requests and does
    not record the method, so only a session with exactly one open request
    counts. Read without importing: a process that never loaded the module
    has no open prompt, and an engine without the table reads as none.
    """
    prompts, _ = _viewer_requests()
    lock = getattr(prompts, "_lock", None)
    table = getattr(prompts, "_open", None)
    if not session_id or lock is None or not isinstance(table, dict):
        return None
    with lock:
        ids = [
            prompt_id for prompt_id, pending in table.items()
            if getattr(pending, "session_id", None) == session_id
            and not pending.event.is_set()
        ]
    return ids[0] if len(ids) == 1 else None


def resolve_viewer_sudo(session_id: str, prompt_id: str, password: str) -> bool:
    """Settle one open password prompt with ``password``, as a viewer's answer
    does, then withdraw the viewer's card. False when the prompt is gone."""
    prompts, withdraws_itself = _viewer_requests()
    resolve = getattr(prompts, "resolve", None)
    if not callable(resolve):
        return False
    if not resolve({"id": prompt_id, "result": {"value": password}}):
        return False
    if not withdraws_itself:
        _withdraw_viewer_request(session_id, prompt_id, "sudo")
    return True


def _withdraw_viewer_request(session_id: str, prompt_id: str, method: str) -> None:
    """Tell the session's viewers the request was answered elsewhere.

    ``resolve`` wakes the waiting agent but sends the viewers nothing, so the
    Desktop or TUI card would stay up. ``request.cancel`` with ``resolved`` is
    what clears it (tui_gateway/contracts/server_requests.py).
    """
    try:
        gateway_run = sys.modules.get("gateway.run")
        authorities = sys.modules.get("gateway.session_authorities")
        runner_ref = getattr(gateway_run, "_gateway_runner_ref", None)
        runner = runner_ref() if callable(runner_ref) else None
        if runner is None or authorities is None:
            return
        for authority in authorities.all_authorities(runner):
            live = authority.sessions.get(session_id)
            if live is not None:
                live.event_stream.publish(
                    session_id,
                    {"id": prompt_id, "method": method, "reason": "resolved"},
                    event_type="request.cancel",
                )
                return
    except Exception:  # noqa: BLE001 - the answer already landed
        logger.debug("[ocuclaw] waiting: viewer card withdraw failed", exc_info=True)


def available_messaging_surfaces(exclude: Sequence[str] = ()) -> List[str]:
    """Messaging platforms this gateway has live adapters for, sorted.

    The source is the running ``GatewayRunner.adapters`` (gateway/run.py
    ``_gateway_runner_ref``): a platform appears only once its adapter
    connected. Non-messaging lanes (api_server, webhook, local ...) and
    OcuClaw itself are dropped. Outside a gateway process the list is empty.
    """
    try:
        # Never import gateway.run here: a process that has not loaded it has
        # no runner, and importing it would boot gateway machinery.
        gateway_run = sys.modules.get("gateway.run")
        runner_ref = getattr(gateway_run, "_gateway_runner_ref", None)
        runner = runner_ref() if callable(runner_ref) else None
        adapters = getattr(runner, "adapters", None) if runner is not None else None
        if not adapters:
            return []
        excluded = NON_MESSAGING_PLATFORMS | {OCUCLAW_PLATFORM} | set(exclude)
        names = set()
        for platform in list(adapters.keys()):
            name = str(getattr(platform, "value", platform) or "").strip().lower()
            if name and name not in excluded and SURFACE_NAME_RE.match(name):
                names.add(name)
        return sorted(names)
    except Exception:  # noqa: BLE001 - a reply must not fail on a probe
        logger.debug("[ocuclaw] waiting: available surfaces probe failed", exc_info=True)
        return []


def prompt_timeout_s(kind: str, config: Mapping[str, Any]) -> int:
    """Seconds the prompt of ``kind`` waits, per the Hermes config."""
    if kind == "sudo":
        return SUDO_TIMEOUT_S
    if kind == "approval":
        approvals = config.get("approvals") if isinstance(config, Mapping) else None
        raw = approvals.get("timeout", APPROVAL_TIMEOUT_DEFAULT_S) if isinstance(approvals, Mapping) else APPROVAL_TIMEOUT_DEFAULT_S
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = APPROVAL_TIMEOUT_DEFAULT_S
        return min(value, UNLIMITED_TIMEOUT_S) if value > 0 else APPROVAL_TIMEOUT_DEFAULT_S
    clarify = config.get("clarify") if isinstance(config, Mapping) else None
    raw = clarify.get("timeout") if isinstance(clarify, Mapping) else None
    if raw is None:
        agent = config.get("agent") if isinstance(config, Mapping) else None
        raw = agent.get("clarify_timeout", CLARIFY_TIMEOUT_DEFAULT_S) if isinstance(agent, Mapping) else CLARIFY_TIMEOUT_DEFAULT_S
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = CLARIFY_TIMEOUT_DEFAULT_S
    return min(value, UNLIMITED_TIMEOUT_S) if value > 0 else UNLIMITED_TIMEOUT_S


def preview_text(prompt: Any) -> str:
    """One trimmed line of the hook's (already redacted) prompt."""
    text = _WHITESPACE_RE.sub(" ", str(prompt or "")).strip()
    if len(text) > PREVIEW_MAX_CHARS:
        text = text[: PREVIEW_MAX_CHARS - 1].rstrip() + "…"
    return text


def _thread_schedule(delay_s: float, fn: Callable[[], None]) -> Any:
    timer = threading.Timer(max(0.0, delay_s), fn)
    timer.daemon = True
    timer.start()
    return timer


# -- the open-waits table -----------------------------------------------------


@dataclass
class _Wait:
    request_id: str
    kind: str
    platform: str
    session_id: str
    session_key: str
    preview: str
    started_at_ms: int
    surface: Optional[str] = None
    title: Optional[str] = None
    timeout_at_ms: int = 0
    shown: bool = False
    pending_id: Optional[str] = None
    pending_found: bool = False
    choices: Optional[List[str]] = None
    multi_select: bool = False
    session_ref: Optional[Dict[str, Any]] = None
    # #5151: a clarify raised in a turn that used the bot's screen.
    bot_screen: bool = False
    # #4985, approvals only: what the shared explainer gets. Never app-bound.
    command: Optional[str] = None
    description: Optional[str] = None
    user_message: Optional[str] = None
    timers: List[Any] = field(default_factory=list)


class HumanInputWaiting:
    """Open waits keyed by the hook ``request_id``.

    One table per process: Hermes registers plugin hooks process-wide, every
    adapter in this process serves the same Hermes home, so they share one
    list. ``emit`` fans each snapshot out to the live adapters.
    """

    def __init__(
        self,
        *,
        emit: Callable[[Dict[str, Any]], None],
        settings: WaitingSettings,
        is_ocuclaw_session: Callable[[str], bool],
        session_row: Callable[[str], Optional[Mapping[str, Any]]] = lambda _sid: None,
        config: Callable[[], Mapping[str, Any]] = dict,
        approvals: Callable[[str], List[Dict[str, Any]]] = list_gateway_approvals,
        clarify: Callable[[str], Any] = pending_clarify,
        screen_ask: Callable[[str, str], bool] = lambda _sid, _key: False,
        resolve_approval: Callable[
            [str, str, str, Optional[str]], Optional[int]
        ] = resolve_approval_by_id,
        resolve_clarify: Callable[[str, str], bool] = resolve_clarify,
        sudo_prompt: Callable[[str], Optional[str]] = open_viewer_sudo,
        resolve_sudo: Callable[[str, str, str], bool] = resolve_viewer_sudo,
        explain_on: Callable[[], bool] = lambda: False,
        user_message: Callable[[str], Optional[str]] = lambda _sid: None,
        clock: Callable[[], float] = time.time,
        schedule: Callable[[float, Callable[[], None]], Any] = _thread_schedule,
        grace_s: float = GRACE_S,
    ) -> None:
        self._emit = emit
        self._settings = settings
        self._is_ocuclaw_session = is_ocuclaw_session
        self._session_row = session_row
        self._config = config
        self._approvals = approvals
        self._clarify = clarify
        # #5151: (session id, session key) -> the session's turn used the bot's
        # screen. In-memory and cheap: it runs on the agent thread.
        self._screen_ask = screen_ask
        self._resolve_approval = resolve_approval
        self._resolve_clarify = resolve_clarify
        self._sudo_prompt = sudo_prompt
        self._resolve_sudo = resolve_sudo
        self._explain_on = explain_on
        self._user_message = user_message
        self._clock = clock
        self._schedule = schedule
        self._grace_s = float(grace_s)
        self._lock = threading.RLock()
        self._waits: Dict[str, _Wait] = {}
        self._last_items: List[Dict[str, Any]] = []
        # Chat setup step 9 asks "did my reply appear on your glasses?". Its
        # card would cover that very reply, so the question is held off the
        # glasses while it is open: (session key, until in epoch seconds).
        self._setup_question: Optional[Tuple[str, float]] = None

    @property
    def settings(self) -> WaitingSettings:
        return self._settings

    def hold_setup_question(self, session_key: str, hold_s: float = SETUP_QUESTION_HOLD_S) -> None:
        """Chat setup's step 9 question is open in ``session_key``'s chat."""
        with self._lock:
            self._setup_question = (str(session_key or "").strip(), self._clock() + hold_s)

    def release_setup_question(self) -> None:
        with self._lock:
            self._setup_question = None

    def _setup_question_held(self, platform: str, session_key: str) -> bool:
        with self._lock:
            held = self._setup_question
        if held is None or held[1] <= self._clock():
            return False
        if held[0] and session_key:
            return held[0] == session_key
        # A turn outside the gateway may carry no session key: then a local
        # question is taken as the setup's, for the few minutes the hold lasts.
        return platform in NON_MESSAGING_PLATFORMS

    def open_request_ids(self) -> Tuple[str, ...]:
        with self._lock:
            return tuple(self._waits)

    # -- hooks (agent thread) -------------------------------------------------

    def on_request(self, **kwargs: Any) -> None:
        try:
            self._on_request(kwargs)
        except Exception:  # noqa: BLE001 - never raise into a human prompt
            logger.debug("[ocuclaw] waiting: request hook failed", exc_info=True)

    def on_resolved(self, **kwargs: Any) -> None:
        try:
            self._on_resolved(kwargs)
        except Exception:  # noqa: BLE001 - never raise into a human prompt
            logger.debug("[ocuclaw] waiting: resolved hook failed", exc_info=True)

    def _on_request(self, kwargs: Mapping[str, Any]) -> None:
        request_id = str(kwargs.get("request_id") or "").strip()
        kind = str(kwargs.get("kind") or "").strip()
        if not request_id or kind not in KINDS:
            return
        platform = str(kwargs.get("platform") or "").strip().lower()
        session_key = str(kwargs.get("session_key") or "").strip()
        if platform == OCUCLAW_PLATFORM or (session_key and self._is_ocuclaw_session(session_key)):
            return
        if kind == "clarify" and self._setup_question_held(platform, session_key):
            return
        settings = self._settings
        if platform not in NON_MESSAGING_PLATFORMS:
            surface: Optional[str] = platform
            if not settings.shows(surface):
                return
        else:
            # The exact local surface needs the session row; read it at grace
            # time, off this thread. Here only the cheap "all off" check runs.
            surface = None
            if not settings.show:
                return
        wait = _Wait(
            request_id=request_id,
            kind=kind,
            platform=platform,
            session_id=str(kwargs.get("session_id") or "").strip(),
            session_key=session_key,
            preview=preview_text(kwargs.get("prompt")),
            started_at_ms=int(self._clock() * 1000),
            surface=surface,
            command=explain_command(kwargs.get("prompt")) if kind == "approval" else None,
        )
        if kind == "clarify":
            try:
                wait.bot_screen = bool(self._screen_ask(wait.session_id, session_key))
            except Exception:  # noqa: BLE001 - a plain question card then
                logger.debug("[ocuclaw] waiting: screen ask unread", exc_info=True)
        with self._lock:
            if request_id in self._waits:
                return
            self._waits[request_id] = wait
            wait.timers.append(
                self._schedule(self._grace_s, lambda: self._on_grace(request_id))
            )

    def _on_resolved(self, kwargs: Mapping[str, Any]) -> None:
        request_id = str(kwargs.get("request_id") or "").strip()
        if not request_id:
            return
        outcome = str(kwargs.get("outcome") or "error")
        with self._lock:
            wait = self._waits.pop(request_id, None)
            if wait is None:
                return
            self._cancel_timers(wait)
            if wait.shown:
                self._publish_locked(cleared={"requestId": request_id, "outcome": outcome})

    # -- timers ---------------------------------------------------------------

    def _on_grace(self, request_id: str) -> None:
        try:
            self._grace(request_id)
        except Exception:  # noqa: BLE001 - a timer thread must not die loudly
            logger.debug("[ocuclaw] waiting: grace step failed", exc_info=True)

    def _grace(self, request_id: str) -> None:
        with self._lock:
            wait = self._waits.get(request_id)
            if wait is None or wait.shown:
                return
            kind, platform = wait.kind, wait.platform
            session_id, session_key = wait.session_id, wait.session_key
            surface, preview = wait.surface, wait.preview
            claimed = {w.pending_id for w in self._waits.values() if w.pending_id}
        # Reads happen outside the lock: SQLite and Hermes locks, never the
        # agent thread.
        row = self._read_row(session_id)
        if surface is None:
            surface = local_surface(platform, row)
        title = _row_title(row)
        session_ref = _session_ref(row)
        timeout_s = prompt_timeout_s(kind, self._read_config())
        pending = self._read_pending(kind, session_id, session_key, preview, claimed)
        # #4985: the wearer's own last message, for the explainer only. Local
        # chats only: in a messaging chat the last sender may be someone else,
        # and the explainer trusts this text as the wearer's.
        user_message = None
        if (
            kind == "approval"
            and surface in LOCAL_SURFACES
            and self._settings.shows(surface)
            and self._explain_enabled()
        ):
            user_message = self._read_user_message(session_id)
        now_ms = int(self._clock() * 1000)
        with self._lock:
            wait = self._waits.get(request_id)
            if wait is None or wait.shown:
                return
            if not self._settings.shows(surface):
                self._waits.pop(request_id, None)
                self._cancel_timers(wait)
                return
            wait.surface = surface
            wait.title = title
            wait.session_ref = session_ref
            wait.timeout_at_ms = wait.started_at_ms + timeout_s * 1000
            wait.user_message = user_message
            if pending is not None:
                wait.pending_found = True
                wait.pending_id, wait.choices, wait.multi_select, wait.description = pending
            ttl_at_ms = wait.timeout_at_ms + int(TTL_SLACK_S * 1000)
            if ttl_at_ms <= now_ms:
                self._waits.pop(request_id, None)
                self._cancel_timers(wait)
                return
            wait.shown = True
            wait.timers.append(
                self._schedule((ttl_at_ms - now_ms) / 1000.0, lambda: self._on_ttl(request_id))
            )
            self._publish_locked()

    def _on_ttl(self, request_id: str) -> None:
        try:
            with self._lock:
                wait = self._waits.pop(request_id, None)
                if wait is None:
                    return
                self._cancel_timers(wait)
                if wait.shown:
                    self._publish_locked(cleared={"requestId": request_id, "outcome": "expired"})
        except Exception:  # noqa: BLE001
            logger.debug("[ocuclaw] waiting: ttl step failed", exc_info=True)

    @staticmethod
    def _cancel_timers(wait: _Wait) -> None:
        for timer in wait.timers:
            cancel = getattr(timer, "cancel", None)
            if callable(cancel):
                try:
                    cancel()
                except Exception:  # noqa: BLE001
                    pass
        wait.timers = []

    # -- settings -------------------------------------------------------------

    def apply_settings(self, params: Any) -> None:
        """Apply a pushed setting and re-send the list.

        The list is sent when it changed, and also whenever it is non-empty:
        the push comes at every relay start, so a restarted relay (which lost
        its cached list) gets the open waits back.
        """
        self._settings.apply(params)
        with self._lock:
            items = self._items_locked()
            if items != self._last_items or items:
                self._publish_locked(items=items)

    def refresh(self) -> None:
        """Re-send the list if it changed under a setting read at build time
        (#4985: "Explain commands" adds or drops the ``explain`` block)."""
        try:
            with self._lock:
                items = self._items_locked()
                if items != self._last_items:
                    self._publish_locked(items=items)
        except Exception:  # noqa: BLE001 - a setting push must not fail on this
            logger.debug("[ocuclaw] waiting: refresh failed", exc_info=True)

    # -- answer (#4983) -------------------------------------------------------

    def answer(self, params: Any) -> Dict[str, Any]:
        """Answer one open wait from the glasses, by its exact pending id.

        Gated by the wearer's "Answer them from the glasses" setting. A
        refusal is a result, never an exception. The list itself updates when
        Hermes fires the resolved hook, not here.

        No profile check: Hermes session rows carry no profile (each profile
        is its own home and state DB), and the approval and clarify queues are
        process-wide, keyed by session key and entry id. ``profile_mismatch``
        stays reserved in the wire contract.
        """
        p = params if isinstance(params, Mapping) else {}
        raw_id = p.get("requestId")
        request_id = raw_id.strip() if isinstance(raw_id, str) else ""
        if not request_id:
            return _answer_result(request_id, "refused", reason="bad_request")
        if not self._settings.answer:
            return _answer_result(request_id, "refused", reason="answer_off")
        with self._lock:
            wait = self._waits.get(request_id)
            if wait is None:
                return _answer_result(request_id, "already_answered")
            kind, session_key = wait.kind, wait.session_key
            pending_id, pending_found = wait.pending_id, wait.pending_found
            choices = list(wait.choices or [])
            surface, title = wait.surface, wait.title
            visible = wait.shown and self._settings.shows(surface)
            session_id = wait.session_id
        if kind == "sudo":
            if not visible or not pending_found or not pending_id or not session_id:
                return _answer_result(request_id, "refused", reason="not_answerable", kind=kind)
            return self._answer_sudo(request_id, session_id, pending_id, p.get("answer"),
                                     surface, title)
        if not visible or not pending_found or not pending_id or not session_key:
            return _answer_result(request_id, "refused", reason="not_answerable", kind=kind)
        # Hermes calls run outside the table lock.
        if kind == "approval":
            choice = p.get("choice")
            if not isinstance(choice, str) or not choice:
                return _answer_result(request_id, "refused", reason="bad_request", kind=kind)
            if choice not in choices:
                return _answer_result(
                    request_id, "refused", reason="choice_not_allowed", kind=kind
                )
            reason = _deny_reason(p.get("reason")) if choice == "deny" else None
            if not any(
                isinstance(e, Mapping) and str(e.get("request_id") or "") == pending_id
                for e in self._approvals(session_key)
            ):
                return _answer_result(request_id, "already_answered", kind=kind)
            resolved = self._resolve_approval(session_key, choice, pending_id, reason)
            if resolved is None:
                return _answer_result(request_id, "refused", reason="unsupported", kind=kind)
            if resolved <= 0:
                return _answer_result(request_id, "already_answered", kind=kind)
            logger.info(
                "[ocuclaw] waiting: approved from glasses surface=%s chat=%r kind=%s choice=%s",
                surface, title, kind, choice,
            )
            return _answer_result(request_id, "answered", kind=kind, choice=choice)
        text = p.get("answer")
        if not isinstance(text, str) or not text.strip():
            return _answer_result(request_id, "refused", reason="bad_request", kind=kind)
        if not self._resolve_clarify(pending_id, text.strip()):
            return _answer_result(request_id, "already_answered", kind=kind)
        logger.info(
            "[ocuclaw] waiting: answered from glasses surface=%s chat=%r kind=%s",
            surface, title, kind,
        )
        return _answer_result(request_id, "answered", kind=kind)

    def _answer_sudo(
        self,
        request_id: str,
        session_id: str,
        prompt_id: str,
        password: Any,
        surface: Optional[str],
        title: Optional[str],
    ) -> Dict[str, Any]:
        """Hand the typed password to the open viewer prompt, as typed: no
        trimming. It goes nowhere else, and no line logs it."""
        kind = "sudo"
        if not isinstance(password, str) or not password.strip():
            return _answer_result(request_id, "refused", reason="bad_request", kind=kind)
        try:
            if self._sudo_prompt(session_id) != prompt_id:
                return _answer_result(request_id, "already_answered", kind=kind)
            if not self._resolve_sudo(session_id, prompt_id, password):
                return _answer_result(request_id, "already_answered", kind=kind)
        # Worded without "sudo <word>": Hermes' plugin scanner reads that as a command (HIGH).
        except Exception:  # noqa: BLE001 - no traceback: it could carry the frame
            logger.debug("[ocuclaw] waiting: password answer failed")
            return _answer_result(request_id, "refused", reason="unavailable", kind=kind)
        logger.info(
            "[ocuclaw] waiting: answered from glasses surface=%s chat=%r kind=%s",
            surface, title, kind,
        )
        return _answer_result(request_id, "answered", kind=kind)

    # -- snapshot -------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {"items": self._items_locked()}

    def _items_locked(self) -> List[Dict[str, Any]]:
        settings = self._settings
        answer = settings.answer
        explain = self._explain_enabled()
        shown = [w for w in self._waits.values() if w.shown and settings.shows(w.surface)]
        shown.sort(key=lambda w: (w.started_at_ms, w.request_id))
        return [_item(w, answer, explain) for w in shown]

    def _publish_locked(
        self,
        *,
        cleared: Optional[Dict[str, str]] = None,
        items: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if items is None:
            items = self._items_locked()
        if cleared is not None and not any(
            i["requestId"] == cleared["requestId"] for i in self._last_items
        ):
            # The ended wait was not on the wearer's list (its surface was
            # muted after it showed): nothing visible to clear.
            cleared = None
            if items == self._last_items:
                return
        payload: Dict[str, Any] = {"items": items}
        if cleared is not None:
            payload["cleared"] = cleared
        self._last_items = items
        try:
            # Fire-and-forget (the adapter's emit schedules onto its loop), so
            # calling it under the lock keeps snapshots in order.
            self._emit(payload)
        except Exception:  # noqa: BLE001
            logger.debug("[ocuclaw] waiting: emit failed", exc_info=True)

    # -- reads ----------------------------------------------------------------

    def _read_row(self, session_id: str) -> Optional[Mapping[str, Any]]:
        if not session_id:
            return None
        try:
            row = self._session_row(session_id)
        except Exception:  # noqa: BLE001
            logger.debug("[ocuclaw] waiting: session row read failed", exc_info=True)
            return None
        return row if isinstance(row, Mapping) else None

    def _explain_enabled(self) -> bool:
        try:
            return bool(self._explain_on())
        except Exception:  # noqa: BLE001 - an unreadable setting reads as off
            return False

    def _read_user_message(self, session_id: str) -> Optional[str]:
        if not session_id:
            return None
        try:
            text = self._user_message(session_id)
        except Exception:  # noqa: BLE001 - the explainer works without it
            logger.debug("[ocuclaw] waiting: last user message read failed", exc_info=True)
            return None
        return (text.strip() or None) if isinstance(text, str) else None

    def _read_config(self) -> Mapping[str, Any]:
        try:
            config = self._config()
        except Exception:  # noqa: BLE001
            return {}
        return config if isinstance(config, Mapping) else {}

    def _read_pending(
        self, kind: str, session_id: str, session_key: str, prompt: str, claimed: set
    ) -> Optional[_PendingMatch]:
        """``(pending_id, choices, multi_select, description)`` of this wait's
        pending entry. ``description`` is Hermes' approval description (its
        risk labels joined with "; "), else None.

        The hook's ``request_id`` is minted by tools/human_input_hooks.py and
        never stored on the pending entry, so the match is by content within
        the session. A sudo wait's entry is the viewer prompt open for its
        session id; a sudo asked at a bare terminal has none.
        """
        try:
            if kind == "sudo":
                prompt_id = self._sudo_prompt(session_id)
                if not prompt_id or prompt_id in claimed:
                    return None
                return prompt_id, None, False, None
            if not session_key:
                return None
            if kind == "approval":
                return _match_approval(self._approvals(session_key), prompt, claimed)
            return _match_clarify(self._clarify(session_key))
        except Exception:  # noqa: BLE001 - absent API reads as "not found"
            logger.debug("[ocuclaw] waiting: pending read failed", exc_info=True)
            return None


def local_surface(platform: str, row: Optional[Mapping[str, Any]]) -> str:
    """Desktop, TUI or CLI for a local turn; otherwise the hook platform.

    Hermes 0.22.1 changes a completed TUI/CLI turn's ``source`` to
    ``local``. Its immutable ``created_source`` keeps the actual surface,
    including the notification switch to apply on later turns.
    """
    for field in ("created_source", "source"):
        source = str((row or {}).get(field) or "").strip().lower()
        if source in _SOURCE_SURFACES:
            return _SOURCE_SURFACES[source]
    if platform in _SOURCE_SURFACES:
        return _SOURCE_SURFACES[platform]
    if platform in ("", "local"):
        return "cli"
    return platform


def _row_title(row: Optional[Mapping[str, Any]]) -> Optional[str]:
    title = (row or {}).get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    return None


def _session_ref(row: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """The fields the relay derives the chat's public session key from (#4981).

    The same shape as the session list's wire row (``session_rpc._row_to_wire``):
    the relay runs it through ``deriveHermesPublicKey`` and sends the app only
    the public key, which is how the glasses session picker keys its rows.
    """
    if not row:
        return None
    row_id = str(row.get("id") or "").strip()
    if not row_id:
        return None
    root = str(row.get("_lineage_root_id") or "").strip() or row_id
    key = row.get("session_key")
    return {
        "id": row_id,
        "sessionKey": key if isinstance(key, str) and key.strip() else None,
        "source": str(row.get("source") or "").strip() or None,
        "lineageRootId": root,
    }


def _match_approval(
    entries: Sequence[Mapping[str, Any]], prompt: str, claimed: set
) -> Optional[_PendingMatch]:
    # Same command text first (the entry holds the gateway's display
    # redaction, the hook the forced one; they agree for ordinary commands),
    # then the oldest entry no other open wait has taken.
    open_entries = [
        e for e in entries
        if isinstance(e, Mapping) and str(e.get("request_id") or "") not in claimed
    ]
    match = next(
        (e for e in open_entries if preview_text(e.get("command")) == prompt), None
    ) or (open_entries[0] if open_entries else None)
    if match is None:
        return None
    smart_denied = bool(match.get("smart_denied"))
    choices = [
        c for c in APPROVAL_CHOICES
        if not (c == "session" and (smart_denied or match.get("allow_session") is False))
        and not (c == "always" and (smart_denied or match.get("allow_permanent") is False))
    ]
    pending_id = str(match.get("request_id") or "") or None
    return pending_id, choices, False, _description(match.get("description"))


def _description(raw: Any) -> Optional[str]:
    """Hermes' approval description (already redacted for display), capped."""
    if not isinstance(raw, str):
        return None
    text = _WHITESPACE_RE.sub(" ", raw).strip()
    return text[:EXPLAIN_DESCRIPTION_MAX_CHARS].rstrip() or None


def explain_command(prompt: Any) -> Optional[str]:
    """The hook's (force-redacted) command as the explainer needs it: whole,
    line breaks kept. None when blank or longer than the explainer accepts."""
    text = str(prompt or "").strip()
    if not text or len(text) > EXPLAIN_COMMAND_MAX_CHARS:
        return None
    return text


def _match_clarify(entry: Any) -> Optional[_PendingMatch]:
    # One agent thread per session asks one clarify card at a time, so the
    # session's oldest pending entry is this wait's.
    if entry is None:
        return None
    raw = getattr(entry, "choices", None)
    choices = [str(c) for c in raw] if isinstance(raw, (list, tuple)) and raw else None
    pending_id = str(getattr(entry, "clarify_id", "") or "") or None
    return pending_id, choices, bool(getattr(entry, "multi_select", False)) and bool(choices), None


def _answer_result(
    request_id: str,
    status: str,
    *,
    reason: Optional[str] = None,
    kind: Optional[str] = None,
    choice: Optional[str] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {"requestId": request_id, "status": status}
    if reason is not None:
        result["reason"] = reason
    if kind is not None:
        result["kind"] = kind
    if choice is not None:
        result["choice"] = choice
    return result


def _deny_reason(raw: Any) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    text = raw.strip()[:ANSWER_REASON_MAX_CHARS].strip()
    return text or None


def _item(wait: _Wait, answer_on: bool, explain_on: bool = False) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "requestId": wait.request_id,
        "kind": wait.kind,
        "surface": wait.surface,
        "sessionTitle": wait.title,
        # #5152: a computer_use approval's prompt quotes what a `type` call
        # types; the list shows its command line without it. The table keeps
        # the hook's own text, which only matches the wait to its entry.
        "preview": bot_screen.approval_preview(wait.preview) if wait.kind == "approval" else wait.preview,
        "startedAtMs": wait.started_at_ms,
        "timeoutAtMs": wait.timeout_at_ms,
        "answerable": bool(answer_on and wait.pending_found),
    }
    if wait.choices:
        item["choices"] = list(wait.choices)
        item["multiSelect"] = bool(wait.multi_select)
    if wait.bot_screen:
        item["botScreen"] = True
    if wait.session_ref:
        # Relay-only: it becomes the app's public ``sessionKey`` and never
        # reaches the app as is (#4981).
        item["session"] = dict(wait.session_ref)
    if explain_on and wait.kind == "approval" and wait.command:
        # #4985, relay-only: the shared explainer's input. The relay keeps it
        # out of every app frame; ``userMessage`` is chat text. A computer_use
        # approval's command goes without what it types (#5152).
        explain: Dict[str, Any] = {"command": bot_screen.approval_preview(wait.command)}
        if wait.description:
            explain["description"] = wait.description
        if wait.user_message:
            explain["userMessage"] = wait.user_message
        item["explain"] = explain
    return item
