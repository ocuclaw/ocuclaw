"""In-process lifecycle of the one Hermes cron job an OcuClaw Task owns (#5029).

Stock Hermes only: every call goes through the public cron API in this
gateway process (``create_job_with_scheduler_registration``, ``update_job``,
``pause_job``, ``resume_job``, ``trigger_job``, ``remove_job``, and
``fill_blueprint`` for a Starter). No native-compat patch is needed.

The Node relay child owns the Task and its When; this module never decides
whether a When is approved. It is handed an exact Task Request and When and
makes the job match them, or says why it cannot. It never forwards a job's
prompt, output or a native exception to the caller.

Ownership: every job made here carries ``origin = {"source": "ocuclaw-task",
"taskId": <id>}``. Hermes stores ``origin`` verbatim and, with no
``platform``/``chat_id`` in it, treats it as no delivery origin, so it marks the
job without changing where it delivers. A job without that mark is never
changed or deleted from here (``job_not_owned``).

Time zone: a Hermes job carries no zone of its own. Cron expressions fire on
the profile's configured zone (``hermes_time``), else the server's. The When
names the phone's IANA zone, so a daily When is translated into the host zone
here. When the two zones keep a fixed offset all year the translation is exact;
otherwise it holds until the next offset change, and ``status`` reports
``scheduleDrift`` so the caller re-sends the same When.
"""
from __future__ import annotations

from datetime import datetime, time as dtime, timedelta
import logging
import re
from types import SimpleNamespace

from .native_readers import running_cron_jobs
from .stock_management import profile_context
from . import task_page_watch, task_reminders
from .task_uses_hook import note_task_job_ended

logger = logging.getLogger(__name__)

# Every job OcuClaw creates starts with these rules: the same constant the
# OcuClaw starters use (starters.py, #5027).
from .glasses_prompt import GLASSES_PROMPT_RULES, GLASSES_URGENT_PROMPT_RULES, asks_nothing_urgent

OWNER_SOURCE = "ocuclaw-task"
DELIVER = "ocuclaw"

OPERATIONS = {
    "taskSchedule.fillStarter", "taskSchedule.create", "taskSchedule.update",
    "taskSchedule.pause", "taskSchedule.resume", "taskSchedule.run",
    "taskSchedule.delete", "taskSchedule.status",
    # The one away-pause switch (#5037, task_away.py).
    "taskSchedule.awayStatus", "taskSchedule.awaySet",
    # "Make it a Task" (#5040): read a job no Task owns, then take it over.
    "taskSchedule.foreign", "taskSchedule.adopt",
    # "See it work" (#6422): run a Task Draft once, as a test, before it is a Task.
    "taskSchedule.test", "taskSchedule.testEnd",
}
# A test job's mark (#6422). Not OWNER_SOURCE: a test is no Task, so the run facts, the
# away pause and the Jobs list never count it, and its result never becomes a Task Result.
TEST_SOURCE = "ocuclaw-task-test"
TEST_KINDS = {"brief"}
# A test job left by a lost reply or a restart is removed by the next test.
TEST_STALE_SECONDS = 30 * 60
# The test jobs this gateway made, so a delivery is known as a test without a store read.
_TEST_JOBS = set()
# A test keeps no chat (#6422): its run's Hermes session goes once the run has ended. A run
# still going is tried again after each of these waits, in seconds.
TEST_SESSION_RETRY_SECONDS = (30, 120, 600)
# Toolsets a Task's job never gets (#6422, job-level limits): scheduling, other agents, memory,
# the board, and the interactive ones Hermes's cron already drops. OcuClaw never offers their
# tools, so a Task cannot ask for them. Skill changes share the ``skills`` toolset with skill
# reads, so ``skill_manage`` stays left out by the tool-call hook alone.
NEVER_TOOLSETS = frozenset({"cronjob", "delegation", "memory", "kanban", "clarify", "messaging"})
READS ={"taskSchedule.fillStarter", "taskSchedule.status", "taskSchedule.awayStatus", "taskSchedule.foreign"}
_AWAY = {"taskSchedule.awayStatus", "taskSchedule.awaySet"}
KINDS = {"brief", "reminder", "alert"}
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
# cron day-of-week: Sunday is 0.
_CRON_DOW = {"mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6, "sun": 0}

_TASK_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
_JOB_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_STARTER_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_SLOT_NAME = re.compile(r"[a-z_][a-z0-9_]{0,31}")
# #6272: the owner's note on a Starter. It goes after the filled prompt, so the
# Task keeps its Starter (fields, skills, the Day wrap-up link) and the note
# steers it. OpenClaw joins it the same way (`openclaw-task-starters.ts`), and
# every "starter changed" check compares the prompt with the note in it.
STARTER_NOTE_LEAD = "Note from the user: "
STARTER_NOTE_MAX = 500
_ZONE = re.compile(r"[A-Za-z0-9_+\-/]{1,64}")
_CLOCK = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])")
_LOCAL_AT = re.compile(r"\d{4}-\d{2}-\d{2}T([01][0-9]|2[0-3]):[0-5][0-9]")
_MONITOR_URL = re.compile(r"https?://[!-~]{1,490}")

# Linked briefs (#5039): a Day wrap-up job reads the latest output of every
# Morning brief job in the same profile through Hermes' ``context_from``. The
# Starter a job came from is kept in its ``origin`` so the links can be found.
BRIEF_STARTER = "ocuclaw:glasses-brief"
WRAP_STARTER = "ocuclaw:day-wrap"

_MESSAGES = {
    "invalid_request": "Invalid Task schedule request.",
    "unsupported": "This Hermes host cannot schedule Tasks. Update Hermes and OcuClaw.",
    "job_missing": "The Task's scheduled job no longer exists in Hermes.",
    "job_not_owned": "That Hermes job is not owned by this Task.",
    "job_owned": "That Hermes job already belongs to a Task.",
    "job_no_prompt": "That Hermes job has no prompt to make a Task from.",
    "job_paused": "The Task's schedule is paused. Resume it before running it now.",
    "already_running": "The Task is running now. Its result comes when this run ends.",
    "starter_missing": "This Starter is no longer offered by Hermes.",
    "starter_invalid": "The Starter's blanks are not filled in correctly.",
    "starter_changed": "This Starter changed since the Task was approved. Review it as a Draft.",
    "schedule_invalid": "Hermes could not schedule this time.",
    "outcome_unknown": "Outcome unknown. Check the Task's schedule status; do not repeat this action.",
    "native_failed": "Hermes could not read the Task's scheduled job.",
}


class _Refusal(Exception):
    def __init__(self, code, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def _text(value, limit=160):
    return "".join(c for c in str(value or "") if c.isprintable())[:limit]


def _prompt_text(value, limit=4000):
    """A Starter prompt keeps its line breaks: the Task Request is compared to it."""
    return "".join(c for c in str(value or "") if c.isprintable() or c == "\n")[:limit]


def _api():
    """The stock cron API, or NotImplementedError when this Hermes lacks part of it."""
    try:
        # Each symbol is imported by name so the import-surface ratchet pins it.
        from cron.jobs import (get_job, list_jobs, parse_schedule, pause_job, remove_job,
                               resume_job, trigger_job, update_job, use_cron_store)
        from cron.scheduler import create_job_with_scheduler_registration
    except (ImportError, AttributeError) as exc:
        raise NotImplementedError() from exc
    jobs = SimpleNamespace(get_job=get_job, list_jobs=list_jobs, parse_schedule=parse_schedule,
                           pause_job=pause_job, remove_job=remove_job, resume_job=resume_job,
                           trigger_job=trigger_job, update_job=update_job, use_cron_store=use_cron_store)
    if not all(callable(fn) for fn in (*vars(jobs).values(), create_job_with_scheduler_registration)):
        raise NotImplementedError()
    return jobs, create_job_with_scheduler_registration


def _blueprints():
    try:
        from cron.blueprint_catalog import BlueprintFillError, fill_blueprint, get_blueprint
        return get_blueprint, fill_blueprint, BlueprintFillError
    except (ImportError, AttributeError) as exc:
        raise NotImplementedError() from exc


def supported():
    try:
        _api()
        return True
    except NotImplementedError:
        return False


def capabilities():
    ok = supported()
    try:
        _blueprints()
        starters = ok
    except NotImplementedError:
        starters = False
    return [{"operation": op, "scope": "profile",
             "supported": starters if op == "taskSchedule.fillStarter" else ok,
             "applyTiming": "read_only" if op in READS else "active_now"}
            for op in sorted(OPERATIONS)]


# ---------------------------------------------------------------------------
# Request validation
# ---------------------------------------------------------------------------

def _zone_info(name):
    from zoneinfo import ZoneInfo
    if not isinstance(name, str) or not _ZONE.fullmatch(name):
        raise ValueError()
    try:
        return ZoneInfo(name)
    except Exception as exc:
        raise ValueError() from exc


def _valid_window(window, minutes):
    """#7001: an interval's hour window (Hydration & movement nudge): on the hour from
    ``fromHour`` to ``toHour`` on ``days``, in whole-hour steps, never across midnight."""
    if not isinstance(window, dict) or set(window) != {"days", "fromHour", "toHour"} or minutes % 60:
        raise ValueError()
    hours = (window["fromHour"], window["toHour"])
    if any(isinstance(h, bool) or not isinstance(h, int) or not 0 <= h <= 23 for h in hours) or hours[1] < hours[0]:
        raise ValueError()
    days = window["days"]
    if (not isinstance(days, list) or not days or len(set(days)) != len(days)
            or any(day not in DAYS for day in days)):
        raise ValueError()


def _valid_when(when):
    if not isinstance(when, dict):
        raise ValueError()
    kind = when.get("type")
    _zone_info(when.get("timeZone"))
    if kind == "daily":
        if set(when) != {"type", "time", "days", "timeZone"}:
            raise ValueError()
        if not isinstance(when["time"], str) or not _CLOCK.fullmatch(when["time"]):
            raise ValueError()
        days = when["days"]
        if (not isinstance(days, list) or not days or len(set(days)) != len(days)
                or any(day not in DAYS for day in days)):
            raise ValueError()
    elif kind == "interval":
        if set(when) not in ({"type", "everyMinutes", "timeZone"}, {"type", "everyMinutes", "timeZone", "window"}):
            raise ValueError()
        minutes = when["everyMinutes"]
        if isinstance(minutes, bool) or not isinstance(minutes, int) or not 15 <= minutes <= 1440:
            raise ValueError()
        if "window" in when:
            _valid_window(when["window"], minutes)
    elif kind == "once":
        if set(when) != {"type", "at", "timeZone"}:
            raise ValueError()
        if not isinstance(when["at"], str) or not _LOCAL_AT.fullmatch(when["at"]):
            raise ValueError()
        datetime.fromisoformat(when["at"])
    else:
        raise ValueError()
    return when


def _valid_starter(starter):
    if not isinstance(starter, dict) or not {"key", "slots"} <= set(starter) <= {"key", "slots", "note"}:
        raise ValueError()
    if "note" in starter:
        note = starter["note"]
        if (not isinstance(note, str) or not note.strip() or len(note) > STARTER_NOTE_MAX
                or not note.isprintable()):
            raise ValueError()
    if not isinstance(starter["key"], str) or not _STARTER_KEY.fullmatch(starter["key"]):
        raise ValueError()
    slots = starter["slots"]
    if not isinstance(slots, dict) or len(slots) > 16:
        raise ValueError()
    for name, value in slots.items():
        if not isinstance(name, str) or not _SLOT_NAME.fullmatch(name):
            raise ValueError()
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise ValueError()
        if isinstance(value, str) and (len(value) > 500 or not value.isprintable()):
            raise ValueError()
    return starter


# #5032: a Task's Look as the relay sends it: the card's name and its inputs
# (``liveui-compiler/template-inputs.ts``, already checked there). Only the
# shape is checked here, with the same bounds, because these words go into
# the job's prompt.
_INPUT_KEY = re.compile(r"[a-z][a-z0-9_]{0,31}")
_INPUT_TYPES = {"number", "text", "bool", "list", "image"}
_LIST_SCALARS = {"number", "text", "bool"}
_ROW_FIELD_TYPES = {"number", "text", "bool", "image"}
_INPUT_KEYS = {"key", "type", "label", "required", "min", "max", "maxBytes", "maxItems", "of", "fields"}
LOOK_INPUTS_MAX = 16
_ROW_FIELDS_MAX = 16


def _bounded_int(value, low, high):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def _valid_input(entry):
    if not isinstance(entry, dict) or set(entry) - _INPUT_KEYS:
        raise ValueError()
    if not isinstance(entry.get("key"), str) or not _INPUT_KEY.fullmatch(entry["key"]):
        raise ValueError()
    if entry.get("type") not in _INPUT_TYPES:
        raise ValueError()
    label = entry.get("label")
    if label is not None and (not isinstance(label, str) or len(label) > 64 or not label.isprintable()):
        raise ValueError()
    if "required" in entry and not isinstance(entry["required"], bool):
        raise ValueError()
    for bound in ("min", "max"):
        value = entry.get(bound)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                  or value != value or value in (float("inf"), float("-inf"))):
            raise ValueError()
    if "maxBytes" in entry and not _bounded_int(entry["maxBytes"], 1, 999):
        raise ValueError()
    if "maxItems" in entry and not _bounded_int(entry["maxItems"], 1, 20):
        raise ValueError()
    if "of" in entry and entry["of"] not in _LIST_SCALARS:
        raise ValueError()
    if "fields" in entry:
        fields = entry["fields"]
        if not isinstance(fields, dict) or not 1 <= len(fields) <= _ROW_FIELDS_MAX:
            raise ValueError()
        for name, kind in fields.items():
            if not isinstance(name, str) or not _INPUT_KEY.fullmatch(name) or kind not in _ROW_FIELD_TYPES:
                raise ValueError()


def _valid_look(look):
    if not isinstance(look, dict) or set(look) != {"name", "inputs"}:
        raise ValueError()
    name = look["name"]
    if not isinstance(name, str) or not name.strip() or len(name) > 120 or not name.isprintable():
        raise ValueError()
    inputs = look["inputs"]
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= LOOK_INPUTS_MAX:
        raise ValueError()
    for entry in inputs:
        _valid_input(entry)
    if len({entry["key"] for entry in inputs}) != len(inputs):
        raise ValueError()
    return look


def _validate(operation, payload):
    p = payload if payload is not None else {}
    if not isinstance(p, dict):
        raise ValueError()
    if operation == "taskSchedule.awayStatus":
        if p:
            raise ValueError()
        return p
    if operation == "taskSchedule.awaySet":
        if set(p) != {"enabled"} or not isinstance(p["enabled"], bool):
            raise ValueError()
        return p
    if operation == "taskSchedule.fillStarter":
        if set(p) != {"starter"}:
            raise ValueError()
        _valid_starter(p["starter"])
        return p
    if operation == "taskSchedule.foreign":
        if set(p) != {"jobId"} or not isinstance(p["jobId"], str) or not _JOB_ID.fullmatch(p["jobId"]):
            raise ValueError()
        return p
    if operation in {"taskSchedule.test", "taskSchedule.testEnd"}:
        return _valid_test(operation, p)
    required = {"taskId"}
    allowed = {"taskId"}
    if operation in {"taskSchedule.create", "taskSchedule.update"}:
        required |= {"name", "request", "kind", "when"}
        allowed |= required | {"starter", "monitorUrl"}
        allowed |= {"look"}  # #5032
    if operation == "taskSchedule.create":
        # #6772: the Task's stale card job this new job replaces.
        allowed |= {"replacesJobId"}
        if "replacesJobId" in p and (not isinstance(p["replacesJobId"], str)
                                     or not _JOB_ID.fullmatch(p["replacesJobId"])):
            raise ValueError()
    if operation != "taskSchedule.create":
        required |= {"jobId"}
        allowed |= {"jobId"}
    if operation == "taskSchedule.status":
        # Optional: the When the job was made from, so a translated daily
        # schedule can report drift after an offset change.
        allowed |= {"when"}
        if "when" in p:
            _valid_when(p["when"])
    if not required <= set(p) or set(p) - allowed:
        raise ValueError()
    if not isinstance(p["taskId"], str) or not _TASK_ID.fullmatch(p["taskId"]):
        raise ValueError()
    if "jobId" in p and (not isinstance(p["jobId"], str) or not _JOB_ID.fullmatch(p["jobId"])):
        raise ValueError()
    if "name" in p:
        name = p["name"]
        if not isinstance(name, str) or not name.strip() or len(name) > 120 or not name.isprintable():
            raise ValueError()
        request = p["request"]
        if not isinstance(request, str) or not request.strip() or len(request) > 4000:
            raise ValueError()
        if p["kind"] not in KINDS:
            raise ValueError()
        _valid_when(p["when"])
        if "starter" in p and p["starter"] is not None:
            _valid_starter(p["starter"])
        if p.get("monitorUrl") is not None:
            # A cheap check first; the model runs only when its output changed
            # (#5039). Hermes refuses one on a no-model reminder.
            if (not isinstance(p["monitorUrl"], str) or not _MONITOR_URL.fullmatch(p["monitorUrl"])
                    or p["kind"] == "reminder"):
                raise ValueError()
        if "look" in p and p["look"] is not None:
            _valid_look(p["look"])
    return p


def _valid_test(operation, p):
    """A test's request: the Draft's name, request, kind, and its Starter and Look, or the job to end."""
    if not isinstance(p.get("taskId"), str) or not _TASK_ID.fullmatch(p["taskId"]):
        raise ValueError()
    if operation == "taskSchedule.testEnd":
        if set(p) != {"taskId", "jobId"} or not isinstance(p["jobId"], str) or not _JOB_ID.fullmatch(p["jobId"]):
            raise ValueError()
        return p
    if not {"taskId", "name", "request", "kind"} <= set(p) or set(p) - {"taskId", "name", "request", "kind",
                                                                         "starter", "look", "openCard", "cardInputs"}:
        raise ValueError()
    # #6423 T5: a Draft whose card is still to be built names its own values (never with a Look).
    if "openCard" in p and (p["openCard"] is not True or p.get("look") is not None):
        raise ValueError()
    # #6423 (Matt, 2026-11-05: pin names once built): a card already built on these names keeps
    # them, so the run fills exactly these keys, as a saved card's run does.
    if "cardInputs" in p:
        if p.get("openCard") is not True:
            raise ValueError()
        _valid_look({"name": p["name"], "inputs": p["cardInputs"]})
    name, request = p["name"], p["request"]
    if not isinstance(name, str) or not name.strip() or len(name) > 120 or not name.isprintable():
        raise ValueError()
    if not isinstance(request, str) or not request.strip() or len(request) > 4000:
        raise ValueError()
    # A reminder is fixed text and an alert's page check is the host's: only the model's answer is tested.
    if p["kind"] not in TEST_KINDS:
        raise ValueError()
    if p.get("starter") is not None:
        _valid_starter(p["starter"])
    if p.get("look") is not None:
        _valid_look(p["look"])
    return p


# ---------------------------------------------------------------------------
# When -> Hermes schedule
# ---------------------------------------------------------------------------

def _host_zone():
    """The zone Hermes's cron matching uses for the active profile, and its name ("" = server)."""
    try:
        from hermes_time import get_timezone, get_timezone_name
        zone = get_timezone()
        if zone is not None:
            return zone, _text(get_timezone_name(), 64) or _text(zone, 64)
    except (ImportError, AttributeError):
        pass
    return datetime.now().astimezone().tzinfo, ""


def _zone_key(zone):
    return getattr(zone, "key", None)


def _daily_schedule(when, host, *, now=None):
    phone = _zone_info(when["timeZone"])
    hour, minute = (int(part) for part in when["time"].split(":"))
    today = (now or datetime.now(phone)).astimezone(phone).date()
    local = datetime.combine(today, dtime(hour, minute), tzinfo=phone)
    host_wall = local.astimezone(host)
    shift = (host_wall.date() - local.date()).days
    if len(when["days"]) == 7:
        dow = "*"
    else:
        dow = ",".join(str(day) for day in sorted({(_CRON_DOW[d] + shift) % 7 for d in when["days"]}))
    expr = f"{host_wall.minute} {host_wall.hour} * * {dow}"
    if _zone_key(phone) is not None and _zone_key(phone) == _zone_key(host):
        exact = True
    else:
        deltas = set()
        for offset in range(0, 366, 1):
            at = datetime.combine(today + timedelta(days=offset), dtime(hour, minute), tzinfo=phone)
            deltas.add(at.utcoffset() - at.astimezone(host).utcoffset())
            if len(deltas) > 1:
                break
        exact = len(deltas) == 1
    return expr, exact


def _window_schedule(when, host, *, now=None):
    """#7001: a windowed interval as one cron on its run hours, each translated as a daily When.

    The runs must share the host's minute and days. A window that the zone shift splits across two
    host days on chosen days cannot be one cron, so it is refused, never run on the wrong days."""
    window = when["window"]
    step = when["everyMinutes"] // 60
    minute = dow = None
    hours, exact = [], True
    for hour in range(window["fromHour"], window["toHour"] + 1, step):
        daily = {"type": "daily", "time": f"{hour:02d}:00", "days": window["days"], "timeZone": when["timeZone"]}
        expr, one_exact = _daily_schedule(daily, host, now=now)
        run_minute, run_hour, _, _, run_dow = expr.split(" ")
        if minute is None:
            minute, dow = run_minute, run_dow
        elif (run_minute, run_dow) != (minute, dow):
            raise _Refusal("schedule_invalid")
        hours.append(int(run_hour))
        exact = exact and one_exact
    return f"{minute} {','.join(str(h) for h in sorted(set(hours)))} * * {dow}", exact


def _schedule_for(when, host):
    """(schedule string for parse_schedule, exact?) for a validated When."""
    if when["type"] == "interval" and "window" in when:
        return _window_schedule(when, host)
    if when["type"] == "interval":
        return f"every {when['everyMinutes']}m", True
    if when["type"] == "once":
        at = datetime.fromisoformat(when["at"]).replace(tzinfo=_zone_info(when["timeZone"]))
        return at.isoformat(), True
    return _daily_schedule(when, host)


def _zone_view(when, host_name, exact):
    return {"requested": when["timeZone"], "host": host_name, "exact": bool(exact)}


# ---------------------------------------------------------------------------
# Job helpers
# ---------------------------------------------------------------------------

def _origin(task_id, starter_key=None):
    origin = {"source": OWNER_SOURCE, "taskId": task_id}
    if starter_key:
        origin["starter"] = starter_key
    return origin


def _starter_of(job):
    origin = job.get("origin") if isinstance(job, dict) else None
    if not isinstance(origin, dict) or origin.get("source") != OWNER_SOURCE:
        return None
    return origin.get("starter")


def _relink_wraps(jobs):
    """Point every Day wrap-up job at the profile's Morning brief jobs (#5039).

    Runs after any change to an owned job, so a brief made, removed or made
    from another Starter after the wrap-up still lands in its context. A job
    already linked right is left untouched.
    """
    owned = jobs.list_jobs(include_disabled=True)
    briefs = sorted(str(job["id"]) for job in owned if _starter_of(job) == BRIEF_STARTER)
    for job in owned:
        if _starter_of(job) == WRAP_STARTER and list(job.get("context_from") or []) != briefs:
            jobs.update_job(job["id"], {"context_from": briefs or None})


def _owned(job, task_id):
    origin = job.get("origin") if isinstance(job, dict) else None
    return isinstance(origin, dict) and origin.get("source") == OWNER_SOURCE and origin.get("taskId") == task_id


_SCALAR_WORDS = {"number": "a number", "text": "text", "bool": "true or false", "image": "a picture link"}


def _input_words(entry):
    kind = entry["type"]
    if kind == "list":
        most = entry.get("maxItems", 20)
        fields = entry.get("fields")
        if fields:
            row = ", ".join(f"{name} ({_SCALAR_WORDS[field]})" for name, field in fields.items())
            return f"a list of at most {most} rows, each an object with {row}"
        return f"a list of at most {most} items, each {_SCALAR_WORDS[entry.get('of', 'text')]}"
    words = _SCALAR_WORDS[kind]
    if kind == "text" and "maxBytes" in entry:
        words += f", at most {entry['maxBytes']} bytes"
    if kind == "number":
        low, high = entry.get("min"), entry.get("max")
        if low is not None and high is not None:
            words += f" from {low:g} to {high:g}"
        elif low is not None:
            words += f", at least {low:g}"
        elif high is not None:
            words += f", at most {high:g}"
    return words


def look_prompt(look):
    """#5032: the card a Task's Look fills, named with its inputs, so every
    run asks for that card's values only and its layout stays the same."""
    lines = [f'This Task\'s card is "{look["name"].strip()}". In the ocuclaw-card block, '
             "give one JSON object with exactly these keys:"]
    for entry in look["inputs"]:
        label = (entry.get("label") or "").strip()
        named = f'{entry["key"]} ({label})' if label and label != entry["key"] else entry["key"]
        lines.append(f"- {named}: {_input_words(entry)}")
    # #6426 ruling 2: every key, in its declared type. Kept word for word with
    # TASK_FIT_PROMPT (glasses-ui-task-unchecked.ts); a test reads both.
    lines.append("Give every key, each in its declared type: numbers as numbers, yes/no as true or false, "
                 "lists as lists. Put a list's most important rows first.")
    # #6427 ruling 1: a null marks a value the run couldn't check. Kept word for
    # word with TASK_UNCHECKED_PROMPT (glasses-ui-task-unchecked.ts); a test reads both.
    lines.append("Use null for a value you could not get (a tool, sign-in or service failed). "
                 "Send a real empty as [], 0 or words, never as null.")
    return "\n".join(lines)


def open_card_prompt():
    """#6423 T5: a test for a Task whose card is still to be built. The run names the values a
    card would show; the card is then built on those names and this result, and keeps them."""
    return "\n".join([
        "This Task's card is still to be built. In the ocuclaw-card block, give one JSON object with "
        "the values this run found, 1 to 8 keys, each one thing a glanceable card would show.",
        "Name each key in lowercase English letters, digits and _ (at most 32), starting with a letter, "
        "and keep the same names every run.",
        "Give each value in its own type: numbers as numbers, yes/no as true or false, lists as lists, "
        "a list's rows as objects with the same keys. Put a list's most important rows first.",
        "Never give a value as one object: give each of its parts its own key "
        "(next_meeting_title and next_meeting_time, not next_meeting with both inside).",
        # Kept word for word with look_prompt's line (#6427 ruling 1).
        "Use null for a value you could not get (a tool, sign-in or service failed). "
        "Send a real empty as [], 0 or words, never as null.",
    ])


def request_without_glasses_rules(request):
    """#6677: OcuClaw's own Starters start their request with the glasses rules,
    and the job's prompt adds them too. The request without that leading
    paragraph, so they appear once. Only an exact copy is taken off: a
    Starter's request is its current fill (``starter_changed``). #7241: either
    form of the rules is such a copy."""
    text = request.strip()
    for rules in (GLASSES_URGENT_PROMPT_RULES, GLASSES_PROMPT_RULES):
        if text.startswith(rules):
            return text[len(rules):].strip()
    return text


def _prompt(request, look=None, open_card=False):
    # #5032: a Look's card inputs follow the glasses rules, before the request.
    card = f"{look_prompt(look)}\n\n" if look else f"{open_card_prompt()}\n\n" if open_card else ""
    # #7241: "Nothing urgent" only in a run that looks for urgent things.
    rules = GLASSES_URGENT_PROMPT_RULES if asks_nothing_urgent(request, look) else GLASSES_PROMPT_RULES
    return f"{rules}\n\n{card}{request_without_glasses_rules(request)}"


def _starter_prompt(starter):
    get_blueprint, fill_blueprint, fill_error = _blueprints()
    blueprint = get_blueprint(starter["key"])
    if blueprint is None:
        raise _Refusal("starter_missing")
    try:
        spec = fill_blueprint(blueprint, dict(starter["slots"]))
    except fill_error as exc:
        raise _Refusal("starter_invalid") from exc
    note = starter.get("note")
    if note:
        spec = dict(spec)
        spec["prompt"] = starter_prompt_with_note(_prompt_text(spec.get("prompt")), note)
    return blueprint, spec


def starter_prompt_with_note(prompt, note):
    """#6272: a filled Starter prompt with the owner's note after it."""
    return f"{prompt.rstrip()}\n\n{STARTER_NOTE_LEAD}{note.strip()}"


def _definition(p, host, home):
    """create_job kwargs for this exact Task Request and When.

    A fixed-text reminder (#5036) becomes a ``no_agent`` job: the shared
    OcuClaw script prints the text saved in the reminder's own folder, so it
    costs no model call. The caller writes that folder (task_reminders).
    """
    skills = None
    if p.get("starter") is not None:
        _, spec = _starter_prompt(p["starter"])
        # No silent change: the job runs the approved request, never a Starter
        # text that moved under a Hermes upgrade.
        if _prompt_text(spec.get("prompt")).strip() != p["request"].strip():
            raise _Refusal("starter_changed", starterPrompt=_prompt_text(spec.get("prompt")))
        skills = list(spec.get("skills") or []) or None
    schedule, exact = _schedule_for(p["when"], host[0])
    definition = {"prompt": _prompt(p["request"], p.get("look")), "schedule": schedule, "name": p["name"].strip(),
                  "deliver": DELIVER, "attach_to_session": True,
                  "origin": _origin(p["taskId"], (p.get("starter") or {}).get("key")),
                  "no_agent": False, "script": None, "workdir": None,
                  "monitor_url": None, "monitor_script": None}
    if p.get("monitorUrl"):
        # The page's visible text, not its raw bytes (task_page_watch). The
        # caller writes the Task's folder.
        definition.update(monitor_script=task_page_watch.SCRIPT_NAME,
                          workdir=str(task_page_watch.page_dir(home, p["taskId"])))
    if task_reminders.reminder_text(p) is not None:
        definition.update(prompt="", no_agent=True, script=task_reminders.SCRIPT_NAME,
                          workdir=str(task_reminders.reminder_dir(home, p["taskId"])))
        skills = None
    if skills:
        definition["skills"] = skills
    toolsets = None if definition["no_agent"] else task_toolsets()
    if toolsets is not None:
        definition["enabled_toolsets"] = toolsets
    return definition, _zone_view(p["when"], host[1], exact)


def task_toolsets():
    """A Task job's own ``enabled_toolsets``: the profile's cron toolsets less ``NEVER_TOOLSETS``.

    Frozen when the Task is saved; each run still adds the enabled MCP servers. None when this
    Hermes cannot name its cron toolsets: the job then keeps the profile's cron default, and the
    tool-call hook alone leaves those tools out.
    """
    try:
        from hermes_cli.config import load_config_readonly
        from .native_readers import cron_platform_toolsets

        names = cron_platform_toolsets(load_config_readonly())
    except Exception as exc:  # noqa: BLE001 - no limit is the old behaviour, never a failed save
        logger.info("Task toolsets unavailable (%s)", type(exc).__name__)
        return None
    return sorted(name for name in names if isinstance(name, str) and name not in NEVER_TOOLSETS)


def _expected_expr(job, when, host):
    if not isinstance(when, dict):
        return None
    try:
        if when.get("type") == "interval" and "window" in when:
            return _window_schedule(when, host)[0]
        if when.get("type") != "daily":
            return None
        return _daily_schedule(when, host)[0]
    except (ValueError, _Refusal):
        return None


def _context_view(job):
    linked = job.get("context_from") if isinstance(job.get("context_from"), list) else []
    return [_text(job_id, 128) for job_id in linked if isinstance(job_id, str)][:16]


def _running_now(job_id):
    """#6420: Hermes never writes ``state = "running"``; its scheduler keeps the
    jobs running now in memory, in this gateway process."""
    try:
        return any(isinstance(d, dict) and d.get("job_id") == job_id for d in running_cron_jobs() or [])
    except Exception:  # noqa: BLE001 - unknown is not running
        return False


def _queued_now(job):
    """#6420: a Send one now waiting for the scheduler's next tick reads as
    running from the tap, as the Task rows say (``task_push.queued_run_since``)."""
    from . import task_push

    return task_push.queued_run_since(job, int(datetime.now().timestamp() * 1000)) is not None


def _view(job, task_id, zone=None, drift=False):
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    state = _text(job.get("state"), 32)
    if state == "scheduled" and job.get("enabled", True) and (_running_now(job.get("id")) or _queued_now(job)):
        state = "running"
    view = {"id": _text(job.get("id"), 128), "taskId": task_id, "name": _text(job.get("name"), 120),
            "state": state if state in {"scheduled", "paused", "running", "completed", "error"} else "unknown",
            "paused": not job.get("enabled", True),
            "schedule": _text(job.get("schedule_display") or schedule.get("display")),
            "nextRunAt": _text(job.get("next_run_at"), 64), "lastRunAt": _text(job.get("last_run_at"), 64),
            "lastStatus": _text(job.get("last_status"), 32),
            "deliver": _text(job.get("deliver"), 64), "attachToSession": job.get("attach_to_session") is True,
            # A fixed-text reminder runs with no model call (#5036).
            "noModel": job.get("no_agent") is True,
            # #5039: a cheap check runs first; the jobs whose output it reads.
            "monitored": bool(job.get("monitor_url") or job.get("monitor_script")),
            "monitorUrl": _text(task_page_watch.job_url(job), 490) or None,
            "contextFrom": _context_view(job),
            "scheduleDrift": bool(drift)}
    if zone is not None:
        view["timeZone"] = zone
    return view


def _notify():
    try:
        from cron.scheduler import _notify_provider_jobs_changed
        _notify_provider_jobs_changed()
    except Exception:
        pass


def _owned_job(jobs, p):
    job = jobs.get_job(p["jobId"])
    if job is None:
        raise _Refusal("job_missing")
    if not _owned(job, p["taskId"]):
        raise _Refusal("job_not_owned")
    return job


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

def _fill_starter(p):
    blueprint, spec = _starter_prompt(p["starter"])
    return {"starter": {"key": _text(blueprint.key, 128), "title": _text(blueprint.title, 120),
                        # A Task made from it shows this short line, not its prompt.
                        "description": _text(getattr(blueprint, "description", ""), 300),
                        "prompt": _prompt_text(spec.get("prompt")),
                        "schedule": _text(spec.get("schedule"), 160),
                        "skills": [_text(skill, 80) for skill in (spec.get("skills") or [])][:16]}}


def _foreign_job(jobs, job_id):
    """#5040: a job no OcuClaw Task owns (one made on Desktop or in chat), or a refusal."""
    job = jobs.get_job(job_id)
    if job is None:
        raise _Refusal("job_missing")
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}
    if origin.get("source") == OWNER_SOURCE:
        raise _Refusal("job_owned")
    return job


def _foreign(jobs, p):
    """"Make it a Task", first half: the job's name and prompt, so the Task keeps
    the very request the job runs. A script-only job has none to keep."""
    job = _foreign_job(jobs, p["jobId"])
    prompt = _prompt_text(job.get("prompt")).strip()
    if not prompt or job.get("no_agent") is True:
        raise _Refusal("job_no_prompt")
    view = {"id": _text(job.get("id"), 128), "name": _text(job.get("name") or job.get("id"), 120),
            "prompt": prompt}
    # A job's own page to watch carries over, else adopting it would drop it.
    url = job.get("monitor_url")
    if isinstance(url, str) and _MONITOR_URL.fullmatch(url.strip()):
        view["monitorUrl"] = url.strip()
    return {"job": view}


def _adopt(jobs, p):
    """"Make it a Task", second half: the job now belongs to this Task, so the
    next update brings it to the Task's approved definition. Idempotent for the
    same Task; a job another Task owns is refused."""
    job = jobs.get_job(p["jobId"])
    if job is None:
        raise _Refusal("job_missing")
    if not _owned(job, p["taskId"]):
        job = _foreign_job(jobs, p["jobId"])
        job = jobs.update_job(p["jobId"], {"origin": _origin(p["taskId"])})
        if job is None:
            raise _Refusal("job_missing")
        _notify()
    return {"job": _view(job, p["taskId"])}


def _drop_results(job_id):
    """Forget a deleted job's kept Task Results; never fails the delete."""
    from . import task_results

    try:
        dropped = task_results.TaskResultStore().drop_job(job_id)
    except (task_results.TaskResultStoreError, OSError):
        return
    if dropped:
        logger.info("[ocuclaw] dropped %d task result(s) of deleted job %s", dropped, job_id)


def _replace_results(jobs, task_id, old_id, new_id):
    """#6772: the Task's new job replaces *old_id*: remove the old job, if this Task still owns
    it, and give the new job the old one's results the app already received, so the Task's Runs
    keep them. The rest go, as on a delete: a run of the old card never feeds the new one. A job
    another Task or no Task owns is left alone, with its results. A failed remove fails the
    create: Node keeps the old job, and its retry adopts the new one."""
    from . import task_results

    old = jobs.get_job(old_id)
    if old is not None:
        if not _owned(old, task_id):
            return
        # The relay places only the Task's current job, so a run of the old one still going
        # would go unchecked: held (DeepSec finding_865f515d3a39d62a, same removal).
        note_task_job_ended(old_id)
        jobs.remove_job(old_id)
        _notify()
    try:
        moved, dropped = task_results.TaskResultStore().move_job(old_id, new_id)
    except (task_results.TaskResultStoreError, OSError):
        return
    if moved or dropped:
        logger.info("[ocuclaw] job %s replaced by %s: kept %d task result(s), dropped %d",
                    old_id, new_id, moved, dropped)


def _forget_reminder(home, task_id):
    """Remove a reminder's folder; never fails the operation that asked."""
    try:
        task_reminders.remove_reminder(home, task_id)
    except OSError:
        pass


def _forget_page(home, task_id):
    """Remove a watched page's folder; never fails the operation that asked."""
    try:
        task_page_watch.remove_page(home, task_id)
    except OSError:
        pass


def _create(jobs, create, p, host, home):
    # #6772: a card's Task whose card changed gets a new job in place of this one.
    replaces = p.get("replacesJobId")
    p = {key: value for key, value in p.items() if key != "replacesJobId"}
    data = _create_job(jobs, create, p, host, home, replaces)
    if replaces and replaces != data["job"]["id"]:
        _replace_results(jobs, p["taskId"], replaces, data["job"]["id"])
    return data


def _create_job(jobs, create, p, host, home, replaces=None):
    definition, zone = _definition(p, host, home)
    # A reply lost after a create must not mint a second job on retry: adopt
    # the one this Task already owns and bring it to this definition (never the one it replaces).
    owned = [job for job in jobs.list_jobs(include_disabled=True) if _owned(job, p["taskId"]) and job.get("id") != replaces]
    if owned:
        return _update(jobs, {**p, "jobId": owned[0]["id"]}, host, home, adopted=True)
    text = task_reminders.reminder_text(p)
    if text is not None:
        # Hermes refuses a workdir that does not exist yet.
        task_reminders.write_reminder(home, p["taskId"], text)
    if p.get("monitorUrl"):
        task_page_watch.write_page(home, p["taskId"], p["monitorUrl"])
    try:
        job = create(**definition)
    except ValueError as exc:
        if text is not None:
            _forget_reminder(home, p["taskId"])
        if p.get("monitorUrl"):
            _forget_page(home, p["taskId"])
        raise _Refusal("schedule_invalid") from exc
    return {"job": _view(job, p["taskId"], zone), "adopted": False}


def _update(jobs, p, host, home, adopted=False):
    before = _owned_job(jobs, p)
    definition, zone = _definition(p, host, home)
    text = task_reminders.reminder_text(p)
    if text is not None:
        # The folder must exist for Hermes to accept it. The text changes only
        # once the job does, so a refused update leaves the old reminder whole.
        task_reminders.ensure_script(home)
        task_reminders.reminder_dir(home, p["taskId"]).mkdir(parents=True, exist_ok=True)
    url = p.get("monitorUrl")
    if url:
        task_page_watch.ensure_script(home)
        task_page_watch.page_dir(home, p["taskId"]).mkdir(parents=True, exist_ok=True)
    try:
        parsed = jobs.parse_schedule(definition.pop("schedule"))
        updates = dict(definition)
        # #7256: Hermes works out the next run again from now whenever an update carries a
        # schedule, so an "every 6 hours" job that only took a new prompt would wait 6 hours
        # from the update. The same schedule is left out, so the next run stays where it was.
        if not isinstance(before, dict) or before.get("schedule") != parsed:
            updates.update(schedule=parsed, schedule_display=parsed.get("display"))
        if "skills" not in updates:
            updates["skills"] = []
        # A Reminder runs no agent; a Brief whose limit Hermes could not name keeps the default.
        updates.setdefault("enabled_toolsets", None)
        if url and (task_page_watch.watches(before) is None or task_page_watch.job_url(before) != url.strip()):
            # A new page, or Hermes's raw-byte check before: its old snapshot
            # is not this page's text, so the next check is a baseline.
            updates["monitor_state"] = None
        job = jobs.update_job(p["jobId"], updates)
    except ValueError as exc:
        raise _Refusal("schedule_invalid") from exc
    if job is None:
        raise _Refusal("job_missing")
    if text is not None:
        task_reminders.write_reminder(home, p["taskId"], text)
    else:
        _forget_reminder(home, p["taskId"])
    if url:
        task_page_watch.write_page(home, p["taskId"], url)
    else:
        _forget_page(home, p["taskId"])
    _notify()
    return {"job": _view(job, p["taskId"], zone), "adopted": adopted}


def _linked(jobs, data):
    """Relink Day wrap-ups after a change; best effort, the next change retries."""
    try:
        _relink_wraps(jobs)
        if data is not None:
            fresh = jobs.get_job(data["job"]["id"])
            if fresh is not None:
                data["job"]["contextFrom"] = _context_view(fresh)
    except Exception:
        pass
    return data


def _status(jobs, p, host, when=None):
    job = _owned_job(jobs, p)
    expected = _expected_expr(job, when, host[0])
    drift = expected is not None and (job.get("schedule") or {}).get("expr") != expected
    return {"job": _view(job, p["taskId"], drift=drift)}


def _test_origin(test_id):
    return {"source": TEST_SOURCE, "taskId": test_id}


def is_test_job(job_id, get_job=None):
    """True when *job_id* is a "See it work" test (#6422): its delivery goes to the Draft, never the Task Results."""
    if not isinstance(job_id, str) or not job_id:
        return False
    if job_id in _TEST_JOBS:
        return True
    try:
        if get_job is None:
            from cron.jobs import get_job
        job = get_job(job_id)
    except Exception:  # noqa: BLE001 - an unreadable job is no test
        return False
    origin = job.get("origin") if isinstance(job, dict) else None
    return isinstance(origin, dict) and origin.get("source") == TEST_SOURCE


def _test_jobs(jobs, test_id=None):
    return [job for job in jobs.list_jobs(include_disabled=True)
            if isinstance(job, dict) and isinstance(job.get("origin"), dict)
            and job["origin"].get("source") == TEST_SOURCE
            and (test_id is None or job["origin"].get("taskId") == test_id)]


def _stale_test(job, now):
    try:
        made = datetime.fromisoformat(str(job.get("created_at") or ""))
    except ValueError:
        return True
    if made.tzinfo is None:
        return True
    return (now - made).total_seconds() > TEST_STALE_SECONDS


def _remove_test(jobs, job_id, home=None):
    # DeepSec finding_865f515d3a39d62a: removing the job never stops a run in flight, and the Task
    # hook would no longer see the job as a test's. Held first, so there is no gap.
    note_task_job_ended(job_id)
    _TEST_JOBS.discard(job_id)
    removed = bool(jobs.remove_job(job_id))
    _drop_results(job_id)
    if home is not None:
        _delete_test_sessions(home, job_id)
    return removed


def _delete_test_sessions(home, job_id, attempt=0):
    """Delete the Hermes session a test's run made, so the test leaves no chat behind (#6422).

    A run still going keeps its session; it is tried again after each ``TEST_SESSION_RETRY_SECONDS``
    wait. A home with no session store, or a Hermes that cannot delete, has nothing to clean.
    """
    from pathlib import Path
    from .session_rpc import SessionRpc

    rpc = SessionRpc(Path(home) / "state.db")
    retry = False
    try:
        result = rpc.delete_cron_job_sessions(job_id)
        retry = result["running"] > 0
    except Exception as exc:  # noqa: BLE001 - cleanup never fails the test's own answer
        # A missing store, or an engine without the writer, stays so; anything else (a busy
        # store, a run's ledger not yet settled) may clear.
        retry = str(exc) not in ("session_store_unavailable", "session_writer_unsupported")
        if retry:
            logger.info("Test session cleanup deferred (%s)", type(exc).__name__)
    finally:
        rpc.close()
    if retry and attempt < len(TEST_SESSION_RETRY_SECONDS):
        import threading

        timer = threading.Timer(TEST_SESSION_RETRY_SECONDS[attempt], _delete_test_sessions,
                                args=(home, job_id, attempt + 1))
        timer.daemon = True
        timer.start()


def _test(jobs, create, p, home=None):
    """"See it work" (#6422): one run of a Task Draft, now, as a job no Task owns.

    The job runs once on the next scheduler tick and delivers to OcuClaw like a Task's job, but
    its mark is ``TEST_SOURCE``: the adapter hands its answer to the Draft on the phone and keeps
    no Task Result (``TaskPush.deliver_test``). Node ends it (``taskSchedule.testEnd``) once the
    answer is taken. A test job this Draft left, or any test left for over 30 minutes, goes first.
    """
    now = datetime.now().astimezone()
    for job in _test_jobs(jobs):
        if job["origin"].get("taskId") == p["taskId"] or _stale_test(job, now):
            _remove_test(jobs, job["id"], home)
    skills = None
    if p.get("starter") is not None:
        _, spec = _starter_prompt(p["starter"])
        if _prompt_text(spec.get("prompt")).strip() != p["request"].strip():
            raise _Refusal("starter_changed", starterPrompt=_prompt_text(spec.get("prompt")))
        skills = list(spec.get("skills") or []) or None
    pinned = {"name": p["name"].strip(), "inputs": p["cardInputs"]} if p.get("cardInputs") else None
    definition = {"prompt": _prompt(p["request"], pinned or p.get("look"), p.get("openCard") is True), "schedule": "in 1m",
                  "name": f"Test · {p['name'].strip()}"[:120], "deliver": DELIVER, "attach_to_session": False,
                  "origin": _test_origin(p["taskId"]), "no_agent": False, "script": None, "workdir": None,
                  "monitor_url": None, "monitor_script": None}
    if skills:
        definition["skills"] = skills
    # The test runs with the toolsets the Task's own job will have.
    toolsets = task_toolsets()
    if toolsets is not None:
        definition["enabled_toolsets"] = toolsets
    try:
        job = create(**definition)
    except ValueError as exc:
        raise _Refusal("schedule_invalid") from exc
    _TEST_JOBS.add(job["id"])
    # Run it on the next tick rather than in a minute.
    try:
        jobs.trigger_job(job["id"])
    except ValueError:
        pass
    _notify()
    return {"job": {"id": job["id"], "state": "running"}}


def _test_end(jobs, p, home=None):
    job = jobs.get_job(p["jobId"])
    if job is None:
        # Gone already, but the test's run may still be going: held like any ended test.
        note_task_job_ended(p["jobId"])
        made_here = p["jobId"] in _TEST_JOBS
        _TEST_JOBS.discard(p["jobId"])
        _drop_results(p["jobId"])
        if made_here and home is not None:
            # Gone already (a sweep or a restart), but this gateway made it a test: its chat goes too.
            _delete_test_sessions(home, p["jobId"])
        return {"deleted": False, "jobMissing": True}
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}
    if origin.get("source") != TEST_SOURCE or origin.get("taskId") != p["taskId"]:
        raise _Refusal("job_not_owned")
    deleted = _remove_test(jobs, p["jobId"], home)
    _notify()
    return {"deleted": deleted, "jobMissing": False}


def _lifecycle(jobs, operation, p):
    job = _owned_job(jobs, p)
    try:
        if operation == "taskSchedule.pause":
            changed = jobs.pause_job(p["jobId"], reason="Paused from OcuClaw")
        elif operation == "taskSchedule.resume":
            changed = jobs.resume_job(p["jobId"])
        else:
            if not job.get("enabled", True):
                # trigger_job would silently resume a paused job.
                raise _Refusal("job_paused")
            # #6547: trigger_job on a job running now returns it as if accepted, and the run's
            # end writes the next time over the request: that Send one now is lost with no
            # sign. One waiting for the next tick already runs once. Say so instead.
            if _running_now(p["jobId"]) or _queued_now(job):
                raise _Refusal("already_running")
            changed = jobs.trigger_job(p["jobId"])
    except ValueError as exc:
        # A one-shot whose time has passed cannot resume or run again.
        raise _Refusal("schedule_invalid") from exc
    if changed is None:
        raise _Refusal("job_missing")
    return changed


def handle_task_schedule(identity, payload, rpc):
    operation = identity["operation"]

    def fail(code, status="error", **extra):
        return {**identity, "status": status, "capabilities": [], "errorCode": code,
                "errorMessage": _MESSAGES[code], **({"taskSchedule": extra} if extra else {})}

    if operation not in OPERATIONS or identity.get("scope") != "profile":
        return fail("invalid_request")
    try:
        p = _validate(operation, payload)
    except ValueError:
        return fail("invalid_request")
    try:
        jobs, create = _api()
        if operation == "taskSchedule.fillStarter":
            _blueprints()
    except NotImplementedError:
        return fail("unsupported", "unsupported")
    try:
        with profile_context(rpc, identity["profileId"]) as home, jobs.use_cron_store(home):
            task_page_watch.refresh_script(home)
            host = _host_zone()
            if operation in _AWAY:
                from . import task_away

                if operation == "taskSchedule.awaySet":
                    # Off resumes OcuClaw's own away pauses at once.
                    task_away.set_enabled(p["enabled"], home=home)
                    _notify()
                data = {"away": task_away.view(home)}
            elif operation == "taskSchedule.fillStarter":
                data = _fill_starter(p)
            elif operation == "taskSchedule.foreign":
                data = _foreign(jobs, p)
            elif operation == "taskSchedule.adopt":
                data = _adopt(jobs, p)
            elif operation == "taskSchedule.test":
                data = _test(jobs, create, p, home)
            elif operation == "taskSchedule.testEnd":
                data = _test_end(jobs, p, home)
            elif operation == "taskSchedule.create":
                data = _linked(jobs, _create(jobs, create, p, host, home))
            elif operation == "taskSchedule.update":
                data = _linked(jobs, _update(jobs, p, host, home))
            elif operation == "taskSchedule.status":
                data = _status(jobs, p, host, p.get("when"))
            elif operation in {"taskSchedule.pause", "taskSchedule.resume", "taskSchedule.run"}:
                data = {"job": _view(_lifecycle(jobs, operation, p), p["taskId"])}
                _notify()
            else:  # taskSchedule.delete — idempotent: a job already gone is reported, not an error
                job = jobs.get_job(p["jobId"])
                if job is None:
                    data = {"deleted": False, "jobMissing": True}
                elif not _owned(job, p["taskId"]):
                    raise _Refusal("job_not_owned")
                else:
                    # A deleted Task's run in flight goes on with no list to hold it to: held.
                    note_task_job_ended(p["jobId"])
                    data = {"deleted": bool(jobs.remove_job(p["jobId"])), "jobMissing": False}
                    _notify()
                # #5036: the job's kept results go with it, else they come back on the glasses
                # as a "From Hermes" row. Only a job this Task owned (or one already gone) is here.
                _drop_results(p["jobId"])
                # A reminder's folder goes with the last job its Task owns.
                if not any(_owned(other, p["taskId"]) for other in jobs.list_jobs(include_disabled=True)):
                    _forget_reminder(home, p["taskId"])
                    _forget_page(home, p["taskId"])
                _linked(jobs, None)
        return {**identity, "status": "ok", "capabilities": [], "taskSchedule": data}
    except _Refusal as refusal:
        return fail(refusal.code, **refusal.extra)
    except Exception as exc:
        # Native failures can depend on the gateway's profile context. Keep a
        # bounded local diagnostic without logging prompts, secrets or exception text.
        logger.warning("Task schedule %s failed (%s)", operation, type(exc).__name__[:80])
        return fail("native_failed" if operation in READS else "outcome_unknown")
