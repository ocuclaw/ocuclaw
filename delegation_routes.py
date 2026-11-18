"""Who a ``delegate_task`` call went to: the route display (#6794).

Hermes 0.22.5+ picks one route per delegated task through the active
delegation backend (``delegation.backend``). A routed task can run as another
Hermes profile (``advanced-delegation``'s ``profile_routes``, OcuClaw's own
``ocuclaw-agents``) or on a named model route (``model_map``). The glasses
header and the phone say which.

Two facts are readable, and this module turns each into the activity frame's
``delegation`` field (PROTOCOL.md "Delegation routes"):

- While the children run: the call's ``args``. ``subagent_start`` carries no
  route on 0.23.0 (``tools/delegate_tool.py`` passes the role and goal only), so
  the task parameter a backend declared names the route instead: ``agent``
  (ocuclaw-agents) and ``profile`` (profile_routes) name a profile, ``option``
  (model_map) a model route.
- After the call: each result entry's ``route`` (``tools/delegate_tool_child_run.py``
  ``_route_report``): ``{backend, label, provider, model, reasoning_effort,
  service_tier, fallback_activated}``, with ``refused: true`` on a task the
  backend refused.

A task with no label (the default backend, an older Hermes) contributes
nothing, so a call with no labelled task carries no ``delegation`` at all and
the lens and phone behave exactly as before. Pure functions; never raises.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional

DELEGATE_TOOL_NAME = "delegate_task"

# Backends whose routes run a task as another Hermes profile. Every other
# labelled route is a model route.
PROFILE_ROUTE_BACKENDS = frozenset({"profile_routes", "ocuclaw-agents"})

# The task parameters that name a route while the child runs, by kind.
PROFILE_TASK_PARAMETERS = ("agent", "profile")
MODEL_TASK_PARAMETERS = ("option",)

KIND_PROFILE = "profile"
KIND_MODEL = "model"

# Bounds: a delegate_task call holds a handful of tasks, and every string here
# is a short display word.
MAX_ROUTES = 8
LABEL_MAX_CHARS = 64
MODEL_MAX_CHARS = 96
RESULT_MAX_BYTES = 512 * 1024

# Result entry status (tools/delegate_tool_child_run.py) -> the wire's word.
_STATUS = {
    "completed": "ok",
    "failed": "error",
    "error": "error",
    "timeout": "error",
    "interrupted": "error",
}


def _word(value: Any, max_chars: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text or len(text) > max_chars:
        return None
    return text


def _tasks(args: Any) -> List[Mapping[str, Any]]:
    """The call's task list: ``tasks``, or the legacy single-goal shape."""
    if not isinstance(args, Mapping):
        return []
    tasks = args.get("tasks")
    if isinstance(tasks, list):
        return [task for task in tasks if isinstance(task, Mapping)]
    if args.get("goal") is not None:
        return [args]
    return []


def _task_route(task: Mapping[str, Any]) -> Optional[Dict[str, str]]:
    for name in PROFILE_TASK_PARAMETERS:
        label = _word(task.get(name), LABEL_MAX_CHARS)
        if label:
            return {"label": label, "kind": KIND_PROFILE}
    for name in MODEL_TASK_PARAMETERS:
        label = _word(task.get(name), LABEL_MAX_CHARS)
        if label:
            return {"label": label, "kind": KIND_MODEL}
    return None


def delegation_from_args(args: Any) -> Optional[Dict[str, Any]]:
    """The ``delegation`` a delegate_task start carries, or None with no labelled task.

    ``tasks`` counts every task of the call, labelled or not, so the header can
    say "Asking planner + 1" while a second child runs on the default route.
    """
    tasks = _tasks(args)
    routes = []
    for task in tasks:
        route = _task_route(task)
        if route is not None and len(routes) < MAX_ROUTES:
            routes.append(route)
    if not routes:
        return None
    return {"routes": routes, "tasks": len(tasks)}


def _parse_result(result: Any) -> Optional[Mapping[str, Any]]:
    if isinstance(result, (bytes, bytearray)):
        if len(result) > RESULT_MAX_BYTES:
            return None
        try:
            result = result.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if isinstance(result, str):
        if len(result) > RESULT_MAX_BYTES:
            return None
        try:
            result = json.loads(result)
        except (TypeError, ValueError):
            return None
    return result if isinstance(result, Mapping) else None


def _entry_route(entry: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    route = entry.get("route")
    if not isinstance(route, Mapping):
        return None
    label = _word(route.get("label"), LABEL_MAX_CHARS)
    if not label:
        return None
    backend = _word(route.get("backend"), LABEL_MAX_CHARS)
    out: Dict[str, Any] = {
        "label": label,
        "kind": KIND_PROFILE if backend in PROFILE_ROUTE_BACKENDS else KIND_MODEL,
    }
    if backend:
        out["backend"] = backend
    model = _word(route.get("model"), MODEL_MAX_CHARS)
    if model:
        out["model"] = model
    provider = _word(route.get("provider"), LABEL_MAX_CHARS)
    if provider:
        out["provider"] = provider
    seconds = entry.get("duration_seconds")
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and seconds >= 0:
        out["durationMs"] = int(round(seconds * 1000))
    if route.get("refused") is True:
        out["status"] = "refused"
    else:
        status = _STATUS.get(str(entry.get("status") or "").strip().lower())
        if status:
            out["status"] = status
    return out


def delegation_from_result(result: Any) -> Optional[Dict[str, Any]]:
    """The ``delegation`` a delegate_task end carries, or None with no labelled route.

    Reads a synchronous call's ``results`` and a background call's
    ``inline_results`` (the units that ran inline). A background unit's result
    re-enters the chat later as its own message and is not read here.
    """
    parsed = _parse_result(result)
    if parsed is None:
        return None
    entries: List[Mapping[str, Any]] = []
    for key in ("results", "inline_results"):
        value = parsed.get(key)
        if isinstance(value, list):
            entries.extend(entry for entry in value if isinstance(entry, Mapping))
    routes = []
    for entry in entries:
        route = _entry_route(entry)
        if route is not None and len(routes) < MAX_ROUTES:
            routes.append(route)
    if not routes:
        return None
    return {"routes": routes, "tasks": len(entries)}



def _is_background_dispatch(parsed: Optional[Mapping[str, Any]]) -> bool:
    return (
        parsed is not None
        and parsed.get("status") == "dispatched"
        and parsed.get("mode") == "background"
    )


# How Hermes opens the turn that hands a background call's results back
# (tools/process_registry_notifications.py: "[ASYNC DELEGATION BATCH COMPLETE — id]",
# "[ASYNC DELEGATION COMPLETE — id]", "[ASYNC DELEGATION TASK FAILED — id, …]").
HELPER_RESULT_TURN_PREFIX = "[ASYNC DELEGATION "


def is_helper_result_turn(text: Any) -> bool:
    """True when [text] is the turn Hermes starts itself to hand back a
    background delegate_task's results. No OcuClaw send started it, so the
    adapter opens its run (the reply then streams like any other)."""
    return isinstance(text, str) and text.lstrip().startswith(HELPER_RESULT_TURN_PREFIX)


def _key(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text or None


class BackgroundDelegations:
    """Background delegate_task calls: who each child ran as, once it is done.

    A background call (``delegation.gateway_mode`` background, or ``auto`` on a
    chat with interim messages) returns only ``{status: "dispatched", ...}``; its
    children finish later and their results re-enter the chat as a turn of their
    own ("[ASYNC DELEGATION BATCH COMPLETE …]") that has no OcuClaw run. The
    route never reaches a public hook then, so the call's arguments name each
    task's route, ``subagent_start`` ties a child to its task by goal, and
    ``subagent_stop`` gives its status and time. Each finished route is handed
    back with the dispatching run, whose closing frame carries it as
    ``background: true``; the app credits the next reply of that chat. No model:
    only the result entry has it. Bounded; thread-safe; never raises.
    """

    MAX_SESSIONS = 32
    MAX_CHILDREN = 64

    def __init__(self) -> None:
        import threading
        from collections import OrderedDict

        self._lock = threading.Lock()
        # parent session id -> {"tasks", "count", "run", "background", "done"}
        self._calls: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        # child session id -> (parent session id, route)
        self._children: "OrderedDict[str, Any]" = OrderedDict()

    @staticmethod
    def _bound(store: Any, limit: int) -> None:
        while len(store) > limit:
            store.popitem(last=False)

    @staticmethod
    def _out(call: Mapping[str, Any], routes: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {
            "run": call["run"],
            "delegation": {"routes": routes, "tasks": call["count"], "background": True},
        }

    def note_call(self, session_id: Any, args: Any, run: Any = None) -> None:
        """A delegate_task call starts in ``run``: remember each labelled task's route by goal."""
        session = _key(session_id)
        if not session:
            return
        all_tasks = _tasks(args)
        tasks = []
        for task in all_tasks:
            route = _task_route(task)
            goal = _key(task.get("goal"))
            if route is not None and goal and len(tasks) < MAX_ROUTES:
                tasks.append((goal, route))
        with self._lock:
            self._calls.pop(session, None)
            if tasks:
                self._calls[session] = {
                    "tasks": tasks,
                    "count": len(all_tasks),
                    "run": run,
                    "background": False,
                    "done": [],
                }
                self._bound(self._calls, self.MAX_SESSIONS)

    def note_result(self, session_id: Any, result: Any) -> Optional[Dict[str, Any]]:
        """The call returned. A background dispatch hands back routes already done, if any."""
        session = _key(session_id)
        if not session:
            return None
        background = _is_background_dispatch(_parse_result(result))
        with self._lock:
            call = self._calls.get(session)
            if call is None:
                return None
            if not background:
                # The result entries carried the routes; nothing is left to send.
                self._calls.pop(session, None)
                for child in [c for c, (p, _r) in self._children.items() if p == session]:
                    self._children.pop(child, None)
                return None
            call["background"] = True
            done, call["done"] = call["done"], []
            return self._out(call, done) if done else None

    def note_child(self, parent_session_id: Any, child_session_id: Any, child_goal: Any) -> None:
        """``subagent_start``: tie the child to its task by goal."""
        parent, child, goal = _key(parent_session_id), _key(child_session_id), _key(child_goal)
        if not (parent and child and goal):
            return
        with self._lock:
            call = self._calls.get(parent)
            if call is None:
                return
            for index, (task_goal, route) in enumerate(call["tasks"]):
                if task_goal == goal:
                    # One child per task: two tasks with the same goal take turns.
                    call["tasks"].pop(index)
                    self._children[child] = (parent, dict(route))
                    self._bound(self._children, self.MAX_CHILDREN)
                    return

    def child_done(self, child_session_id: Any, child_status: Any, duration_ms: Any) -> Optional[Dict[str, Any]]:
        """``subagent_stop``: the child's route finished. A background call's comes back to send."""
        child = _key(child_session_id)
        if not child:
            return None
        with self._lock:
            held = self._children.pop(child, None)
            if held is None:
                return None
            parent, route = held
            status = _STATUS.get(str(child_status or "").strip().lower())
            if status:
                route["status"] = status
            if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool) and duration_ms > 0:
                route["durationMs"] = int(duration_ms)
            call = self._calls.get(parent)
            if call is None:
                return None
            if not call["background"]:
                # The call has not returned yet: it may still be an inline one.
                call["done"].append(route)
                return None
            if not call["tasks"] and not any(p == parent for p, _r in self._children.values()):
                self._calls.pop(parent, None)
            return self._out(call, [route])
