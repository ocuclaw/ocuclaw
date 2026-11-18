const { isUnshownLine } = require("../tools/program-card-unshown.cjs");

const { progressNoteInActionVoice } = require("../domain/activity-prose.cjs");

const CARD_BUILD_TASK_CAPABILITY = "programCardTaskBuildV1";

const CARD_STUDIO_CAPABILITY = "programCardStudioV1";

const STUDIO_TOOL_PHASES                                        = {
  ask_glasses_card: "asking",
  write_glasses_card: "opening",

  edit_glasses_card: null,
  glasses_card_command: "testing",
  look_glasses_card: "testing",
  save_glasses_card: null,
};

const STUDIO_SCRIPT                                              = {
  asking: new Set                (["writing", "opening", "approval"]),
  approval: new Set                (["writing", "opening"]),

  writing: new Set                (["opening", "approval", "fixing"]),
  opening: new Set                (["testing", "writing", "fixing", "approval"]),
  testing: new Set                (["fixing", "finishing"]),
  fixing: new Set                (["testing", "opening", "writing"]),
  finishing: new Set                (),
};

const LEGACY_STEP                                 = { writing: "code", fixing: "changing", finishing: "checking" };

function legacyPhaseOf(phase                , detail                    )                 {
  if (phase === "testing") return typeof detail === "string" && detail.startsWith("Trying ") ? "pressing" : "looking";
  return LEGACY_STEP[phase] ?? phase;
}

function cardBuildReasoningSignal(activity     )                            {
  if (!activity || activity.origin !== "thinking") return null;
  if (activity.thinkingSummarySource === "generic") return "cue";
  if (activity.thinkingSummarySource && activity.summary) return "headline";
  return activity.labelSource === "prose" ? "cue" : null;
}

function cardBuildLegacyFrame                                                                                                                                                                                                                            (frame   )    {
  if (!frame || frame.studio !== true) return frame;

  const { studio: _studio, spoke: _spoke, frameLane: _frameLane, frameIdea: _frameIdea, ...rest } = frame;
  return {
    ...rest,
    ...(typeof frame.note === "string"
      ? {
          note: frame.noteKind === "reply"
            ? fitWords(frame.note, MAX_REPLY_CHARS)
            : frame.noteKind === "reasoning" ? fitWords(frame.note, MAX_NOTE_CHARS) : fit(frame.note, MAX_NOTE_CHARS),
        }
      : {}),
    phase: frame.phase ? legacyPhaseOf(frame.phase, frame.detail) : frame.phase,
    steps: frame.steps.map((step) => {
      const { atMs: _atMs, ...plain } = step;
      return { ...plain, phase: legacyPhaseOf(step.phase, step.detail) };
    }),
  }     ;
}

const CARD_TESTS_PER_TURN = 3;

const CHECK_VERDICTS = new Set(["fits", "needs_fix", "blocked"]);
const CHECK_CASE = /^[a-z][a-z0-9_]{0,31}$/;

function cardBuildCheckOf(raw         )                        {
  const r = raw       ;
  if (!r || typeof r !== "object" || !CHECK_VERDICTS.has(r.verdict)) return null;
  const count = (n         ) => Number.isInteger(n) && (n          ) >= 0 && (n          ) <= 99 ? n           : 0;
  return { verdict: r.verdict, cases: count(r.cases), failed: count(r.failed), real: r.real !== false,
    ...(typeof r.case === "string" && CHECK_CASE.test(r.case) ? { case: r.case } : {}),
    ...(Number.isFinite(r.resultAtMs) && r.resultAtMs > 0 ? { resultAtMs: Math.round(r.resultAtMs) } : {}),
    ...(Number.isInteger(r.kept) && r.kept >= 0 ? { kept: count(r.kept), keptFailed: r.keptFailed === true } : {}) };
}

const LIVE_KINDS = new Set(["feed", "mcp", "jev", "model"]);
const LIVE_PARTS_MAX = 4;
const LIVE_NAME_MAX = 40;

function cardBuildLiveOf(raw         )                       {
  if (!raw || typeof raw !== "object" || (raw       ).status !== "failed" || !Array.isArray((raw       ).parts)) return null;
  const parts                      = [];
  for (const part of (raw       ).parts) {
    if (parts.length >= LIVE_PARTS_MAX) break;
    if (!part || typeof part !== "object" || !LIVE_KINDS.has(part.kind) || typeof part.name !== "string") continue;
    if (typeof part.reason !== "string" || !CHANGE_SAVE_CODE.test(part.reason)) continue;

    const name = part.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, LIVE_NAME_MAX);
    if (!name) continue;
    parts.push({ kind: part.kind, name, reason: part.reason,
      ...(Number.isInteger(part.httpStatus) && part.httpStatus >= 100 && part.httpStatus <= 599 ? { httpStatus: part.httpStatus } : {}) });
  }
  return parts.length ? { status: "failed", parts } : null;
}

const CHANGE_SAVE_STATUS = new Set(["saved", "kept", "rejected"]);
const CHANGE_SAVE_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const CHANGE_SAVE_APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHANGE_SAVE_DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cardBuildChangeSaveOf(raw         )                             {
  if (!raw || typeof raw !== "object") return null;
  const { status, code, revision, appId, draftId } = raw       ;
  if (typeof status !== "string" || !CHANGE_SAVE_STATUS.has(status)) return null;
  return {
    status: status                                 ,
    ...(typeof code === "string" && CHANGE_SAVE_CODE.test(code) ? { code } : {}),
    ...(Number.isSafeInteger(revision) && revision > 0 ? { revision } : {}),
    ...(typeof appId === "string" && CHANGE_SAVE_APP_ID.test(appId) ? { appId } : {}),
    ...(typeof draftId === "string" && CHANGE_SAVE_DRAFT_ID.test(draftId) ? { draftId } : {}),
  };
}

const CARD_TOOL_PHASES                                 = {
  ask_glasses_card: "asking",
  write_glasses_card: "opening",
  edit_glasses_card: "changing",
  glasses_card_command: "pressing",
  look_glasses_card: "looking",
  save_glasses_card: "saving",
};

const REOPENING_TOOLS = new Set(["write_glasses_card", "edit_glasses_card"]);

const MAX_STEPS = 12;
const MAX_BUILDS = 32;

const MAX_NOTE_CHARS = 60;

const MAX_REPLY_CHARS = 52;

const MAX_TESTS = 6;

const CARD_BUILD_DESIGN_QUIET_MS = 20_000;

const CARD_BUILD_TASK_END_KEEP_MS = 30 * 60_000;

const CARD_BUILD_CHAT_END_KEEP_MS = 5 * 60_000;

const CARD_BUILD_CHAT_OPEN_REPLAY_MS = 15 * 60_000;

const CARD_BUILD_UNANSWERED_ASK_KEEP_MS = 30 * 60_000;

const CARD_BUILD_DESIGN_SILENT_MS = 30_000;

const CARD_BUILD_CHANGE_RUN_WAIT_MS = 120_000;
const MAX_DESIGN = 8;
const PART_PHASES = new Set                (["code", "fixing"]);

const STUDIO_PART_PHASES = new Set                (["writing"]);

function isPart(build                      , phase                )          {
  return (build.studio ? STUDIO_PART_PHASES : PART_PHASES).has(phase);
}

function allJudged(tests                             )          {
  return !!tests?.length && tests.every((test) => test.verdict !== "not_tested" && test.verdict !== "still_open");
}
const MAX_TEST_CHARS = 80;
const VERDICTS = new Set(["passed", "fixed", "still_open", "wearer_check", "not_tested"]);

const OUTCOME_VERDICTS                                   = { passed: "passed", failed: "still_open", wearer_check: "wearer_check" };

function fit(text        , max        )         {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function fitWords(text        , max        )         {
  if (text.length <= max) return text;
  const room = text.slice(0, max);
  const end = room.lastIndexOf(" ");
  if (end < max / 2) return fit(text, max);
  return `${room.slice(0, end).replace(/[\s,;:·-]+$/, "")}…`;
}

function replyFor(build                      , sentence        )                {
  return sentence ? fitWords(sentence, build.studio ? CARD_STUDIO_NOTE_CHARS : MAX_REPLY_CHARS) : null;
}

const CARD_STUDIO_NOTE_CHARS = 160;

const CARD_STUDIO_SPEECH_GAP_MS = 8_000;

const CARD_STUDIO_SAY_MAX = 3;

const MAX_SPEECH = 6;
const MAX_HEARD = 64;

const TYPED_CHARS_PER_SECOND = 40;
const TYPED_HEAD_START_CHARS = 10;

function cardStudioHoldMs(line                           )         {
  const typingMs = (Math.max(0, (line ?? "").length - TYPED_HEAD_START_CHARS) / TYPED_CHARS_PER_SECOND) * 1000;
  return Math.min(5_000, Math.max(3_000, Math.round(typingMs + 2_000)));
}

function buildLine(text        )         {
  return String(progressNoteInActionVoice(text, { imperative: true }));
}

function spokenLine(raw         )                {
  const flat = typeof raw === "string" ? raw.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim() : "";
  const text = flat ? buildLine(flat) : "";
  if (!text) return null;
  return fit(/[.!?…]$/.test(text) ? text : `${text}.`, CARD_STUDIO_NOTE_CHARS);
}

function sentencesOf(raw         , whole         )           {
  const text = typeof raw === "string" ? raw.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim() : "";
  if (!text) return [];
  const pieces = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const last = pieces[pieces.length - 1];
  if (last && !/[.!?…]$/.test(last) && !whole && last.length <= CARD_STUDIO_NOTE_CHARS) pieces.pop();
  return pieces.map((line) => fit(line, CARD_STUDIO_NOTE_CHARS));
}

function firstSentence(raw         , whole         )         {
  const text = typeof raw === "string" ? raw.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim() : "";
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text);
  if (sentence) return sentence[0];
  return whole || text.length > MAX_NOTE_CHARS ? text : "";
}

function key(raw         )                {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function iconOf(raw         )                {
  return typeof raw === "string" && /^[a-z0-9-]{1,32}$/.test(raw) ? raw : null;
}

function requirementOf(raw         )                {
  const line = key(raw);
  return line && line.length <= MAX_TEST_CHARS ? line : null;
}

function verdictOf(entry     )                          {
  if (typeof entry?.verdict === "string" && VERDICTS.has(entry.verdict)) return entry.verdict                    ;
  return typeof entry?.outcome === "string" ? OUTCOME_VERDICTS[entry.outcome] ?? null : null;
}

const TASK_HANDLE = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_TASK_NAME_CHARS = 60;
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TASK_TEST_ID = /^[a-z0-9]{8,40}$/;
function cardBuildTaskTestOf(raw         )                {
  const testId = raw && typeof raw === "object" ? (raw       ).testId : null;
  return typeof testId === "string" && TASK_TEST_ID.test(testId) ? testId : null;
}

const TASK_ADD_TO = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function cardBuildTaskAddOf(raw         )                {
  const addTo = raw && typeof raw === "object" ? (raw       ).addTo : null;
  return typeof addTo === "string" && TASK_ADD_TO.test(addTo) ? addTo : null;
}

const TASK_PART = /^task(_[a-z][a-z0-9_]{0,18})?$/;

function cardBuildTaskOf(raw         )                       {
  if (!raw || typeof raw !== "object") return null;
  const handle = (raw       ).handle;
  const name = typeof (raw       ).name === "string" ? (raw       ).name.replace(/\s+/g, " ").trim() : "";
  if (typeof handle !== "string" || !TASK_HANDLE.test(handle) || !name) return null;

  const addTo = cardBuildTaskAddOf(raw);

  const fix = !addTo ? cardBuildTaskFixOf(raw) : null;

  const part = (addTo || fix) && typeof (raw       ).part === "string" && TASK_PART.test((raw       ).part) ? (raw       ).part : null;
  return { handle, name: fit(name, MAX_TASK_NAME_CHARS), ...(addTo ? { addTo } : {}), ...(part ? { part } : {}),
    ...(fix ? { fix } : {}) };
}

function cardBuildTaskFixOf(raw         )                {
  const fix = raw && typeof raw === "object" ? (raw       ).fix : null;
  return typeof fix === "string" && TASK_ADD_TO.test(fix) ? fix : null;
}

function cardBuildTaskSendOf(raw         )                                               {
  const marked = cardBuildTaskOf(raw);
  const { part: _part, ...task } = marked || ({}                 );
  const testId = marked ? cardBuildTaskTestOf(raw) : null;
  if (!marked) return null;
  return testId ? { ...task, testId } : task;
}

function cardChangeSendOf(raw         )                                         {
  const appId = raw && typeof raw === "object" ? (raw       ).appId : null;
  if (typeof appId !== "string" || !TASK_ADD_TO.test(appId)) return null;

  return (raw       ).again === true ? { appId, again: true } : { appId };
}

function frameTest(test               )                {
  return test.verdict === "wearer_check" && isUnshownLine(test.line) ? { ...test, cant: true } : { ...test };
}

function cardCheckSendOf(raw         )                           {
  const appId = raw && typeof raw === "object" ? (raw       ).appId : null;
  return typeof appId === "string" && TASK_ADD_TO.test(appId) ? { appId } : null;
}

function sameTests(left                             , right                 )          {
  return !!left && left.length === right.length && left.every((test, i) => test.line === right[i].line && test.verdict === right[i].verdict);
}

function isCardBuildTool(tool         )          {
  return typeof tool === "string" && Object.prototype.hasOwnProperty.call(CARD_TOOL_PHASES, tool);
}

function createCardBuildPhases(
  options

    = {},
) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  const onRunMismatch = typeof options.onRunMismatch === "function" ? options.onRunMismatch : null;
  const studioFor = typeof options.studio === "function" ? options.studio : () => false;
  const onStepDeviation = typeof options.onStepDeviation === "function" ? options.onStepDeviation : null;
  const onDone = typeof options.onDone === "function" ? options.onDone : null;
  const changeFor = typeof options.change === "function" ? options.change : null;

  function adoptChange(build       ) {
    if (!changeFor || !build.studio || build.plan) return;
    let change                                           = null;
    try {
      change = changeFor(build.sessionKey);
    } catch {

    }
    const name = typeof change?.name === "string" ? change.name.trim() : "";
    const lines = Array.isArray(change?.lines)
      ? change.lines.filter((line         ) => typeof line === "string" && line.trim()).map((line        ) => ({ line: line.trim() }))
      : [];
    if (!name || !lines.length) return;
    build.name = name;
    build.plan = lines;
  }

  const unanswered = new Map                                                                                             ();
  function keepUnanswered(build       ) {
    const at = matchKey(build.sessionKey);
    unanswered.delete(at);
    if (!build.plan?.length || !build.steps.some((step) => step.phase === "asking")) return;
    unanswered.set(at, { name: build.name ?? null, plan: build.plan.map((line) => ({ ...line })), icon: build.icon ?? null, at: now() });
    if (unanswered.size > MAX_BUILDS) unanswered.delete(unanswered.keys().next().value          );
  }

  function adoptUnanswered(build       ) {
    const at = matchKey(build.sessionKey);
    const kept = unanswered.get(at);
    unanswered.delete(at);
    if (!kept || build.plan || now() - kept.at > CARD_BUILD_UNANSWERED_ASK_KEEP_MS) return;
    build.name = kept.name;
    build.plan = kept.plan;
    build.icon = kept.icon;
  }
  function deviate(build       , from        , to                ) {
    if (!onStepDeviation) return;
    try {
      onStepDeviation({ sessionKey: build.sessionKey, runId: build.runId, from, to });
    } catch {

    }
  }

  const matchKey = typeof options.matchKey === "function" ? options.matchKey : (sessionKey        ) => sessionKey;
  const store = new Map               ();
  const builds = {
    get: (sessionKey        ) => store.get(matchKey(sessionKey)),
    set: (sessionKey        , build       ) => store.set(matchKey(sessionKey), build),
    delete: (sessionKey        ) => store.delete(matchKey(sessionKey)),
    get size() {
      return store.size;
    },
    dropOldest: () => store.delete(store.keys().next().value          ),
  };

  const closed = new Map               ();

  const ended = new Map               ();

  const heldDone = new Map                                                                            ();

  const liveRuns = new Map                  ();
  const LIVE_RUNS_PER_CHAT = 8;
  function runIsLive(sessionKey               , runId               ) {
    if (!sessionKey || !runId) return;
    const at = matchKey(sessionKey);
    const going = liveRuns.get(at) ?? [];
    if (going.includes(runId)) return;
    going.push(runId);
    if (going.length > LIVE_RUNS_PER_CHAT) going.shift();
    liveRuns.delete(at);
    liveRuns.set(at, going);
    if (liveRuns.size > MAX_BUILDS) liveRuns.delete(liveRuns.keys().next().value          );
  }
  function runIsOver(sessionKey               , runId               ) {
    if (!sessionKey) return;
    const at = matchKey(sessionKey);
    const going = liveRuns.get(at);
    if (!going) return;
    const left = runId ? going.filter((id) => id !== runId) : [];
    if (left.length) liveRuns.set(at, left);
    else liveRuns.delete(at);
  }

  const origins = new Map                                ();

  const tasks = new Map                       ();

  const taskTests = new Map                ();

  const taskEnds = new Map                        ();

  const asks = new Map                               ();

  const chatEnds = new Map                        ();

  function keepChatEnd(done                       ) {
    if (!done || done.task) return;
    const at = matchKey(done.sessionKey);
    chatEnds.delete(at);
    chatEnds.set(at, done);
    if (chatEnds.size > MAX_BUILDS) chatEnds.delete(chatEnds.keys().next().value          );
  }

  function keepTaskEnd(done                       ) {

    keepChatEnd(done);
    if (!done || !done.task) return;
    taskEnds.delete(done.task.handle);
    taskEnds.set(done.task.handle, done);
    if (taskEnds.size > MAX_BUILDS) taskEnds.delete(taskEnds.keys().next().value          );
  }

  function newBuild(sessionKey        , runId               )        {

    flushHeldDone(sessionKey);
    let studio = false;
    try {
      studio = studioFor(sessionKey) === true;
    } catch {

    }
    return { sessionKey, runId, steps: [], cardOpen: false, cardFailed: false, note: null, noteKind: null, reply: null,
      origin: origins.get(matchKey(sessionKey)) ?? null, task: tasks.get(matchKey(sessionKey)) ?? null,
      ...(studio ? { studio: true } : {}) };
  }

  function frame(build       , done         )                 {
    adoptChange(build);
    const atMs = now();
    const current = build.steps[build.steps.length - 1];
    return {
      sessionKey: build.sessionKey,
      runId: build.runId,
      phase: done || !current ? null : current.phase,
      done,
      steps: build.steps.map((step) => ({
        phase: step.phase,
        durationMs: step.endedAt == null && !done ? null : Math.max(0, (step.endedAt ?? atMs) - step.startedAt),
        ...(step.detail ? { detail: step.detail } : {}),

        ...(build.studio ? { atMs: step.startedAt } : {}),
      })),
      note: done ? build.reply : build.note,
      noteKind: done ? (build.reply ? "reply" : null) : build.note ? build.noteKind : null,
      atMs,
      ...(!done && current?.detail ? { detail: current.detail } : {}),
      ...(build.plan ? { name: build.name ?? null, plan: build.plan.map((line) => ({ ...line })) } : {}),
      ...(build.plan && build.change ? { change: build.change } : {}),
      ...(build.tests?.length ? { tests: build.tests.map(frameTest) } : {}),
      ...(build.plan && build.icon ? { icon: build.icon } : {}),
      ...(build.origin ? { origin: build.origin } : {}),
      ...(!done && current && isPart(build, current.phase) && build.part ? { part: build.part } : {}),
      ...(build.design?.length ? { design: [...build.design] } : {}),
      ...((build.attempt ?? 1) > 1 ? { attempt: build.attempt } : {}),
      ...(!done && build.awaitRun ? { handedOff: true } : {}),
      ...(!done && build.part === "write" && build.reasoningAt != null ? { partAgoMs: Math.max(0, atMs - build.reasoningAt) } : {}),
      ...(build.task ? { task: { ...build.task } } : {}),
      ...(done && build.outcome ? { outcome: build.outcome } : {}),

      ...(done && (build.outcome === "draft" || build.outcome === "no_fit") && build.draftId ? { draftId: build.draftId } : {}),
      ...(build.task && build.check ? { check: { ...build.check } } : {}),
      ...(build.studio ? { studio: true } : {}),
      ...(build.studio && build.spoke ? { spoke: true } : {}),
      ...(done && build.studio && build.frameLane ? { frameLane: build.frameLane } : {}),
      ...(done && build.studio && build.frameLane && build.frameIdea ? { frameIdea: build.frameIdea } : {}),
      ...(done && build.changeSave ? { changeSave: { ...build.changeSave } } : {}),
      ...(done && build.changePending && !build.changeSave ? { changePending: true } : {}),
      ...(done && build.live ? { live: { status: build.live.status, parts: build.live.parts.map((part) => ({ ...part })) } } : {}),
    };
  }

  function outcomeOf(build       , end              )                   {
    if (end === "said_no" || end === "no_answer") return end;
    if (build.cardOpen) return build.task && build.check && build.check.verdict !== "fits" ? "no_fit" : "draft";
    return end === "stopped" ? "stopped" : "failed";
  }

  function beginDesign(build       , at        ) {
    build.part = "design";
    build.reasoningAt = null;
    build.callStartedAt = at;
    build.toolInCall = false;
  }

  function writeDueAt(build       )                {
    const current = build.steps[build.steps.length - 1];
    if (!current || !isPart(build, current.phase) || build.part !== "design" || build.toolInCall) return null;
    if (build.reasoningAt != null) return build.reasoningAt + CARD_BUILD_DESIGN_QUIET_MS;
    return build.callStartedAt != null ? build.callStartedAt + CARD_BUILD_DESIGN_SILENT_MS : null;
  }

  function enter(build       , phase                )                        {
    const current = build.steps[build.steps.length - 1];
    if (current && current.phase === phase) return null;
    const at = now();

    const script = build.studio && current ? STUDIO_SCRIPT[current.phase] : undefined;
    if (current && script && !script.has(phase)) deviate(build, current.phase, phase);

    const rewrite = build.studio && phase === "writing" && build.steps.some((step) => step.phase === "writing" || step.phase === "opening");
    if (current) current.endedAt = at;
    const previous = build.steps[build.steps.length - 2];

    const keep = current && (current.phase === "changing" || current.phase === "fixing");
    if (!build.studio && previous && previous.phase === phase && current && !keep && at - current.startedAt < 1000) {
      build.steps.pop();
      previous.endedAt = null;
    } else {
      build.steps.push({ phase, startedAt: at, endedAt: null });
      if (build.steps.length > MAX_STEPS) build.steps.shift();
    }
    if (isPart(build, phase)) {

      if (phase === "fixing" || rewrite) build.attempt = (build.attempt ?? 1) + 1;
      build.design = [];
      beginDesign(build, at);
    } else {
      build.part = null;
    }
    return frame(build, false);
  }

  function doneByAt(build       , end              )                  {
    if (end === "stopped" || end === "said_no") return "stopped";
    if (end === "no_answer") return "run_end";
    if (!allJudged(build.tests) && (build.looks ?? 0) >= CARD_TESTS_PER_TURN) return "test_limit";
    return build.reply ? "agent_sign_off" : "run_end";
  }

  function flushHeldDone(sessionKey               )               {
    if (!sessionKey) return null;
    const at = matchKey(sessionKey);
    const held = heldDone.get(at);
    if (!held) return null;
    heldDone.delete(at);
    const pending = held.build.changePending === true;
    noteDone(held.build, held.signed ? "agent_sign_off" : "run_end", held.at);

    return held.build.changeSave || pending ? held.build : null;
  }

  function heldFor(sessionKey               , runId               ) {
    const held = sessionKey ? heldDone.get(matchKey(sessionKey)) : undefined;
    return held && (!runId || !held.build.runId || runId === held.build.runId) ? held : undefined;
  }

  function noteDone(build       , by                 , at        ) {
    build.changePending = false;
    if (!onDone || !build.studio || !build.outcome) return;
    const lines                                   = { passed: 0, fixed: 0, wearer_check: 0, still_open: 0, not_tested: 0 };
    for (const test of build.tests ?? []) lines[test.verdict] = (lines[test.verdict] ?? 0) + 1;
    const first = build.steps[0];
    try {
      const answer = onDone({ sessionKey: build.sessionKey, runId: build.runId, by, lines, ms: first ? Math.max(0, at - first.startedAt) : null,
        outcome: build.outcome });

      const changeSave = answer ? cardBuildChangeSaveOf(answer.changeSave) : null;
      if (changeSave) build.changeSave = changeSave;

      const live = answer && !changeSave && build.cardOpen ? cardBuildLiveOf(answer.live) : null;
      if (live) build.live = live;
    } catch {

    }
  }

  function changeOpen(sessionKey        )          {
    if (!changeFor) return false;
    try {
      return changeFor(sessionKey) != null;
    } catch {
      return false;
    }
  }

  function finish(sessionKey        , end               = null, by                         = null)                        {
    const build = builds.get(sessionKey);
    if (!build) return null;
    builds.delete(sessionKey);
    const at = now();
    const current = build.steps[build.steps.length - 1];
    if (current && current.endedAt == null) current.endedAt = at;
    build.outcome = outcomeOf(build, end);
    if (end === "no_answer") keepUnanswered(build);
    const doneBy = by ?? doneByAt(build, end);

    if (by == null && end === null && doneBy === "run_end" && build.studio && build.cardOpen && onDone) {
      flushHeldDone(sessionKey);

      build.changePending = changeOpen(sessionKey);
      heldDone.set(matchKey(sessionKey), { build, at });
      if (heldDone.size > MAX_BUILDS) heldDone.delete(heldDone.keys().next().value          );
    } else {
      noteDone(build, doneBy, at);
    }

    const before = build.task ? taskEnds.get(build.task.handle) : undefined;
    if (!build.draftId && (build.outcome === "draft" || build.outcome === "no_fit") && before?.draftId
      && before.sessionKey === build.sessionKey) build.draftId = before.draftId;
    const done = frame(build, true);
    keepTaskEnd(done);

    ended.delete(matchKey(sessionKey));
    if (build.frameLane) {
      ended.set(matchKey(sessionKey), build);
      if (ended.size > MAX_BUILDS) ended.delete(ended.keys().next().value          );
    }
    return done;
  }

  function reopened(build       )                 {
    const current = build.steps[build.steps.length - 1];
    if (current) current.endedAt = null;
    return frame(build, false);
  }

  function activeBuild(sessionKey               , runId               , edge = "")               {
    if (!sessionKey) return null;
    const build = builds.get(sessionKey);
    if (!build) return null;
    if (build.awaitRun) {

      if (!runId || (build.priorRunIds || []).includes(runId)) {

        if (runId && build.changeWaitAt != null) return null;
        return edge === "runEnd" ? null : build;
      }

      const sendRunEnded = edge === "runEnd" && !!build.sendRunId && runId === build.sendRunId;
      if (edge !== "toolStart" && edge !== "modelCallStart" && !sendRunEnded) return null;

      if (edge === "modelCallStart" && build.changeWaitAt != null && build.sendRunId && runId !== build.sendRunId) return null;

      if (!sendRunEnded && build.changeWaitAt != null) build.reply = null;
      build.runId = runId;
      build.awaitRun = false;
      build.priorRunIds = [];
      build.changeWaitAt = null;
      build.sendRunId = null;
      return build;
    }
    if (runId && build.runId && runId !== build.runId) {
      if (onRunMismatch) onRunMismatch({ sessionKey: build.sessionKey, edge, runId, buildRunId: build.runId });
      return null;
    }
    return build;
  }

  function closedBuild(sessionKey               , runId               )               {
    const build = sessionKey ? closed.get(matchKey(sessionKey)) : undefined;
    return build && (!runId || !build.runId || runId === build.runId) ? build : null;
  }

  function setNote(sessionKey         , runId         , text         , kind                   )                   {
    const build = activeBuild(key(sessionKey), key(runId), kind);
    const headline = key(text);
    if (!build || !headline || build.steps.length === 0) return [];

    const cut = kind === "reasoning" ? fitWords : fit;

    const step = build.steps[build.steps.length - 1];
    let designed = false;
    if (kind === "reasoning" && isPart(build, step.phase)) {
      const line = cut(headline, MAX_NOTE_CHARS);
      const design = build.design ?? (build.design = []);
      if (!design.includes(line)) {
        design.push(line);
        if (design.length > MAX_DESIGN) design.shift();
        designed = true;
      }
      build.reasoningAt = now();
      if (build.part === "write") {

        build.part = "design";
        designed = true;
      }
    }

    if (build.studio) {
      const at = now();
      if (build.speech?.length || at < heldUntil(build)) return designed ? [frame(build, false)] : [];
      const note = cut(headline, CARD_STUDIO_NOTE_CHARS);
      if (note === build.note && kind === build.noteKind) return designed ? [frame(build, false)] : [];
      showLine(build, note, kind, at, false);
      return [frame(build, false)];
    }

    if (kind === "reasoning" && build.note && build.noteKind === "agent") return designed ? [frame(build, false)] : [];
    const note = cut(headline, MAX_NOTE_CHARS);
    if (note === build.note && kind === build.noteKind) return designed ? [frame(build, false)] : [];
    build.note = note;
    build.noteKind = kind;
    return [frame(build, false)];
  }

  function heldUntil(build       )         {
    if (!build.note || build.noteShownAt == null) return 0;
    return build.noteShownAt + cardStudioHoldMs(build.note);
  }

  function showLine(build       , text        , kind                   , at        , spoke         ) {
    build.note = text;
    build.noteKind = kind;
    build.noteShownAt = at;
    if (spoke) build.spoke = true;
  }

  function speechDueAt(build       )                {
    const next = build.speech?.[0];
    if (!build.studio || !next) return null;
    const held = heldUntil(build);
    if (!next.spaced || build.noteShownAt == null) return held;
    return Math.max(held, build.noteShownAt + CARD_STUDIO_SPEECH_GAP_MS);
  }

  function releaseSpeech(build       , at        )                   {
    const due = speechDueAt(build);
    if (due == null || due > at || !build.speech?.length) return [];
    const line = build.speech.shift()              ;
    showLine(build, line.text, "agent", at, true);
    return [frame(build, false)];
  }

  function studioSpeak(build       , lines          )                   {
    if (build.steps.length === 0 || lines.length === 0) return [];
    const heard = build.heard ?? (build.heard = []);
    const fresh = lines.filter((line, i) => !heard.includes(line) && lines.indexOf(line) === i);
    if (fresh.length === 0) return [];
    heard.push(...fresh);
    if (heard.length > MAX_HEARD) heard.splice(0, heard.length - MAX_HEARD);
    const queue = build.speech ?? (build.speech = []);
    const firstAsk = queue.findIndex((line) => line.ask === true);
    queue.splice(firstAsk < 0 ? queue.length : firstAsk, 0, ...fresh.map((text) => ({ text, spaced: lines.indexOf(text) > 0 })));

    if (queue.length > MAX_SPEECH) queue.splice(0, queue.length - MAX_SPEECH);
    return releaseSpeech(build, now());
  }

  function dropSpeech(build       ) {
    if (build.speech?.length) build.speech = [];
  }

  function studioFinishing(build       )                        {
    const current = build.steps[build.steps.length - 1];
    if (!build.studio || build.testRunning || current?.phase !== "testing" || !allJudged(build.tests)) return null;
    return enter(build, "finishing");
  }

  function modelPhase(build       )                 {
    if (build.cardOpen) return "checking";
    return build.cardFailed ? "fixing" : "code";
  }

  return {

    toolStart(event                                                           )                   {
      const sessionKey = key(event.sessionKey);
      let runId = key(event.runId);
      const tool = key(event.tool);
      runIsLive(sessionKey, runId);
      if (!sessionKey || !tool) return [];

      const waiting = builds.get(sessionKey);
      if (waiting?.awaitRun && waiting.changeWaitAt != null && isCardBuildTool(tool)) {

        if (!runId && waiting.sendRunId) runId = waiting.sendRunId;
        if (runId && waiting.priorRunIds?.includes(runId)) waiting.priorRunIds = waiting.priorRunIds.filter((id) => id !== runId);
      }
      const out                   = [];
      let build = activeBuild(sessionKey, runId, "toolStart");
      if (tool === "ask_glasses_card") {

        if (build && !build.runId && !build.awaitRun && runId) build.runId = runId;

        if (asks.get(matchKey(sessionKey))?.answered) return out;
      }
      if (build) build.toolInCall = true;

      if (build && !build.runId && build.steps.length === 0 && runId) build.runId = runId;
      if (isCardBuildTool(tool)) {
        let resumed               = null;
        if (!build) {

          const ended = tool === "ask_glasses_card" ? null : closedBuild(sessionKey, runId);

          if (ended?.studio) {
            if (tool === "write_glasses_card") deviate(ended, "done", "opening");

            if (tool === "edit_glasses_card") ended.editing = true;
            return out;
          }
          if (ended && !REOPENING_TOOLS.has(tool)) return out;

          const stale = finish(sessionKey, "stopped");
          if (stale) out.push(stale);
          resumed = ended;
          closed.delete(matchKey(sessionKey));
          build = resumed ?? newBuild(sessionKey, runId);
          if (!resumed && tool === "write_glasses_card") adoptUnanswered(build);
          builds.set(sessionKey, build);
          if (builds.size > MAX_BUILDS) builds.dropOldest();
        }
        if (tool === "look_glasses_card") {
          if (build.studio && !build.cardOpen) dropSpeech(build);
          build.cardOpen = true;
        }
        if (build.studio) {

          if (tool === "edit_glasses_card") build.editing = true;

          if (tool === "write_glasses_card") build.looks = 0;
          const phase = STUDIO_TOOL_PHASES[tool];
          const entered = phase ? enter(build, phase) : null;
          if (entered) out.push(entered);
          return out;
        }
        const entered = enter(build, CARD_TOOL_PHASES[tool]);
        if (entered) out.push(entered);
        else if (resumed) out.push(reopened(resumed));
        return out;
      }

      if (build && build.cardOpen && !build.studio) {
        const entered = enter(build, "checking");
        if (entered) out.push(entered);
      }
      return out;
    },

    modelCallStart(event                                           )                   {
      runIsLive(key(event.sessionKey), key(event.runId));
      const build = activeBuild(key(event.sessionKey), key(event.runId), "modelCallStart");
      if (!build) return [];
      const current = build.steps[build.steps.length - 1];
      const at = now();
      if (build.studio) {

        let cleared = false;
        if (build.cardOpen && build.noteKind === "reasoning" && build.note) {
          build.note = null;
          build.noteKind = null;
          cleared = true;
        }
        if (current && isPart(build, current.phase)) {
          const wasWriting = build.part === "write";
          beginDesign(build, at);
          return wasWriting || cleared ? [frame(build, false)] : [];
        }
        return cleared ? [frame(build, false)] : [];
      }

      if (current && current.phase === "code" && build.part === "write" && !build.toolInCall && !build.cardOpen) {
        build.cardFailed = true;
      }

      let cleared = false;
      if (build.cardOpen && build.noteKind === "reasoning" && build.note) {
        build.note = null;
        build.noteKind = null;
        cleared = true;
      }
      const entered = enter(build, modelPhase(build));
      if (entered) return [entered];
      if (current && isPart(build, current.phase)) {

        const wasWriting = build.part === "write";
        beginDesign(build, at);
        return wasWriting || cleared ? [frame(build, false)] : [];
      }
      return cleared ? [frame(build, false)] : [];
    },

    lookProgress(event                                            )                   {
      const sessionKey = key(event.sessionKey);
      const detail = typeof event.detail === "string" ? fit(event.detail.replace(/[\r\n\t]+/g, " ").trim(), 100) : "";
      let build = activeBuild(sessionKey, null);

      const ended = !build && detail ? closedBuild(sessionKey, null) : null;
      const resumed = ended && !ended.studio ? ended : null;
      if (resumed) {
        closed.delete(matchKey(resumed.sessionKey));
        builds.set(resumed.sessionKey, resumed);
        if (builds.size > MAX_BUILDS) builds.dropOldest();
        enter(resumed, "looking");
        build = resumed;
      }
      const current = build ? build.steps[build.steps.length - 1] : null;
      if (!build || !current || current.phase !== (build.studio ? "testing" : "looking") || !detail
        || (!resumed && current.detail === detail)) return [];
      current.detail = detail;
      return [resumed ? reopened(resumed) : frame(build, false)];
    },

    lookTests(event                                                                                                        )                   {
      const build = activeBuild(key(event.sessionKey), null);
      if (!build || build.steps.length === 0) return [];

      if (Number.isInteger(event.looks) && (event.looks          ) >= 0) build.looks = event.looks          ;
      const previous = new Map((build.tests ?? []).map((test) => [test.line, test.verdict]));
      let tests                 ;
      if (Array.isArray(event.tests)) {
        tests = event.tests.flatMap((entry     ) => {
          const line = requirementOf(entry?.requirement);
          return line ? [{ line, verdict: verdictOf(entry) ?? previous.get(line) ?? "not_tested" }] : [];
        });
      } else {
        const lines = Array.isArray(event.requirements)
          ? event.requirements.map(requirementOf).filter((line)                 => line !== null)
          : (build.tests ?? []).map((test) => test.line);
        const sent = new Map                          ();
        for (const entry of Array.isArray(event.verdicts) ? event.verdicts : []) {
          const line = requirementOf(entry?.requirement);
          const verdict = verdictOf(entry);
          if (line && verdict) sent.set(line, verdict);
        }
        tests = lines.map((line) => ({ line, verdict: sent.get(line) ?? previous.get(line) ?? "not_tested" }));
      }
      tests = tests.filter((test, i) => tests.findIndex((other) => other.line === test.line) === i).slice(0, MAX_TESTS);
      if (tests.length === 0 || sameTests(build.tests, tests)) return [];
      build.tests = tests;

      const finished = studioFinishing(build);
      return [finished ?? frame(build, false)];
    },

    lookCheck(event                                           )                   {
      const build = activeBuild(key(event.sessionKey), null);
      const check = cardBuildCheckOf(event.check);
      if (!build || !build.task || !check) return [];
      if (build.check && JSON.stringify(build.check) === JSON.stringify(check)) return [];
      build.check = check;
      return [frame(build, false)];
    },

    lookStart(event                          )                   {
      const build = activeBuild(key(event.sessionKey), null);
      if (!build) return [];

      if (build.studio && !build.cardOpen) dropSpeech(build);
      build.cardOpen = true;
      if (build.studio) build.testRunning = true;
      const entered = enter(build, build.studio ? "testing" : "looking");
      return entered ? [entered] : [];
    },

    cardRequest(event                                                         )                   {
      const sessionKey = key(event.sessionKey);
      if (event.op !== "edit" && event.op !== "draft_prepare") return [];
      const agent = event.agent === true;
      const build = activeBuild(sessionKey, null);
      if (!build) {
        const ended = closedBuild(sessionKey, null);
        if (ended?.studio && (ended.editing || agent)) {
          ended.editing = false;
          deviate(ended, "done", "fixing");
        }
        return [];
      }
      if (!build.studio || !(build.editing || agent)) return [];
      const entered = enter(build, "fixing");
      return entered ? [entered] : [];
    },

    testsFor(sessionKey         )                         {
      const build = activeBuild(key(sessionKey), null) ?? closedBuild(key(sessionKey), null);
      return build?.tests?.length ? build.tests.map((test) => ({ ...test })) : null;
    },

    commandStart(event                                                               )                   {
      const build = activeBuild(key(event.sessionKey), null);
      if (!build) return [];
      if (event.cardOpen === true) build.cardOpen = true;
      const label = typeof event.label === "string" ? event.label.replace(/\s+/g, " ").trim() : "";
      if (!label) return [];

      enter(build, build.studio ? "testing" : "pressing");
      const current = build.steps[build.steps.length - 1];
      const detail = fit(`Trying ${label}`, 100);
      if (current.detail === detail) return [];
      current.detail = detail;
      return [frame(build, false)];
    },

    reasoningHeadline(event                                                               )                   {
      return setNote(event.sessionKey, event.runId, event.headline, "reasoning");
    },

    agentNote(event                                                           )                   {

      const build = activeBuild(key(event.sessionKey), key(event.runId), "agent");
      if (!build) return [];

      const text = typeof event.text === "string" ? buildLine(event.text) : event.text;
      if (build.studio) return studioSpeak(build, sentencesOf(text, false));
      const headline = firstSentence(text, false);
      if (!headline) return [];
      return setNote(event.sessionKey, event.runId, headline, "agent");
    },

    speck(event                                                           )                   {
      const line = spokenLine(event.text);
      if (!line) return [];
      const build = activeBuild(key(event.sessionKey), key(event.runId), "agent");
      if (!build) return [];
      if (build.studio) return studioSpeak(build, [line]);
      return setNote(event.sessionKey, event.runId, line, "agent");
    },

    askSay(event                                                           )                   {
      const build = activeBuild(key(event.sessionKey), null);
      const current = build ? build.steps[build.steps.length - 1] : null;
      if (!build || !build.studio || (current && current.phase !== "asking")) return [];
      build.askReason = spokenLine(event.reason);
      build.askSay = (Array.isArray(event.say) ? event.say : [])
        .map(spokenLine).filter((line)                 => !!line).slice(0, CARD_STUDIO_SAY_MAX);
      return [];
    },

    finalReply(event                                                           )                   {
      const sessionKey = key(event.sessionKey);
      const runId = key(event.runId);
      const open = activeBuild(sessionKey, runId, "finalReply");

      const late = open ? undefined : heldFor(sessionKey, runId);
      const build = open ?? closedBuild(sessionKey, runId) ?? late?.build ?? null;

      if (!build && sessionKey && runId) {
        const waiting = builds.get(sessionKey);
        if (waiting?.awaitRun && waiting.changeWaitAt != null && waiting.sendRunId === runId) {
          const first = replyFor(waiting, firstSentence(event.text, true));
          if (first) waiting.reply = first;
        }
      }
      if (!build || !build.cardOpen) return [];
      const reply = replyFor(build, firstSentence(event.text, true));
      const changed = reply !== build.reply;
      build.reply = reply;
      let noted = false;
      if (late && build === late.build && reply) {
        heldDone.delete(matchKey(sessionKey          ));
        const pending = build.changePending === true;
        noteDone(build, "agent_sign_off", late.at);

        noted = build.changeSave !== undefined || pending;
      }
      if (open || (!changed && !noted) || !reply) return [];
      const done = frame(build, true);
      keepTaskEnd(done);
      return [done];
    },

    plan(event                                                                                            )                   {
      const sessionKey = key(event.sessionKey);
      const lines = Array.isArray(event.plan)
        ? event.plan
            .filter((item     ) => item && typeof item.line === "string" && item.line.trim())
            .map((item     ) => ({
              line: item.line.trim(),
              ...(item.band === "top" || item.band === "middle" || item.band === "bottom" ? { band: item.band } : {}),
            }))
        : [];
      const choice = event.choice === true && lines.length === 0;
      if (!sessionKey || (lines.length === 0 && !choice)) return [];
      closed.delete(matchKey(sessionKey));

      unanswered.delete(matchKey(sessionKey));
      const out                   = [];
      let build = activeBuild(sessionKey, null);
      const current = build ? build.steps[build.steps.length - 1] : null;
      if (build && current && current.phase !== "asking") {
        const done = finish(sessionKey, "stopped");
        if (done) out.push(done);
        build = null;
      }
      if (!build) {
        build = newBuild(sessionKey, null);
        builds.set(sessionKey, build);
        if (builds.size > MAX_BUILDS) builds.dropOldest();
      }
      build.name = key(event.name);

      if (choice) delete build.plan;
      else build.plan = lines;
      build.icon = iconOf(event.icon);
      if (build.steps.length > 0) out.push(frame(build, false));
      return out;
    },

    changeOpened(event                                                          )                   {
      const sessionKey = key(event.sessionKey);
      if (!sessionKey) return [];
      const lines = Array.isArray(event.plan)
        ? event.plan.filter((line         ) => typeof line === "string" && line.trim()).map((line        ) => ({ line: line.trim() }))
        : [];
      closed.delete(matchKey(sessionKey));

      unanswered.delete(matchKey(sessionKey));
      const out                   = [];
      const stale = finish(sessionKey, "stopped");
      if (stale) out.push(stale);
      const build = newBuild(sessionKey, null);
      builds.set(sessionKey, build);
      if (builds.size > MAX_BUILDS) builds.dropOldest();
      build.name = key(event.name);
      if (lines.length) build.plan = lines;
      build.cardOpen = true;

      build.task = null;
      build.changeBuild = true;

      build.awaitRun = true;
      build.changeWaitAt = now();

      const going = liveRuns.get(matchKey(sessionKey));
      if (going?.length) build.priorRunIds = going.slice();
      const entered = enter(build, "opening");
      if (entered) out.push(entered);
      return out;
    },

    icon(event                                          )                   {
      const build = activeBuild(key(event.sessionKey), null);
      const icon = iconOf(event.icon);
      if (!build || !build.plan || !icon || icon === build.icon) return [];
      build.icon = icon;
      return build.steps.length > 0 ? [frame(build, false)] : [];
    },

    askStart(event                          )                   {
      const sessionKey = key(event.sessionKey);
      if (!sessionKey) return [];
      const at = matchKey(sessionKey);
      asks.delete(at);
      asks.set(at, { answered: false });
      if (asks.size > MAX_BUILDS) asks.delete(asks.keys().next().value          );
      unanswered.delete(at);
      let build = activeBuild(sessionKey, null);
      if (!build) {
        closed.delete(at);
        build = newBuild(sessionKey, null);
        builds.set(sessionKey, build);
        if (builds.size > MAX_BUILDS) builds.dropOldest();
      }
      const entered = enter(build, "asking");
      return entered ? [entered] : [];
    },

    askAnswer(event                                                              )                   {
      const sessionKey = key(event.sessionKey);
      if (!sessionKey) return [];

      const ask = asks.get(matchKey(sessionKey));
      if (ask) ask.answered = true;
      if (event.answer === "yes") {
        const build = activeBuild(sessionKey, null);
        const current = build ? build.steps[build.steps.length - 1] : null;
        if (!build || !current || current.phase !== "asking") return [];
        const change = typeof event.change === "string" ? event.change.replace(/\s+/g, " ").trim().slice(0, 280) : "";
        if (change && build.plan) build.change = change;

        const reason = build.studio ? build.askReason ?? null : null;
        const say = build.studio && !change ? build.askSay ?? [] : [];
        build.askReason = null;
        build.askSay = [];
        if (reason) showLine(build, reason, "agent", now(), false);
        if (say.length) {
          const heard = build.heard ?? (build.heard = []);
          const queue = build.speech ?? (build.speech = []);
          for (const text of say) {
            if (heard.includes(text)) continue;
            heard.push(text);
            queue.push({ text, spaced: true, ask: true });
          }
        }
        const entered = enter(build, build.studio ? "writing" : "code");
        const released = build.studio && !reason ? releaseSpeech(build, now()) : [];
        if (released.length) return released;
        return entered ? [entered] : reason ? [frame(build, false)] : [];
      }
      const done = finish(sessionKey, event.answer === "no" ? "said_no" : "no_answer");
      return done ? [done] : [];
    },

    askNotShown(event                          )                   {
      const sessionKey = key(event.sessionKey);
      if (!sessionKey) return [];
      const at = matchKey(sessionKey);
      asks.delete(at);
      asks.set(at, { answered: true });
      if (asks.size > MAX_BUILDS) asks.delete(asks.keys().next().value          );
      const build = activeBuild(sessionKey, null);
      const current = build ? build.steps[build.steps.length - 1] : null;
      if (!build || !current || current.phase !== "asking") return [];
      const done = finish(sessionKey, "no_answer");
      return done ? [done] : [];
    },

    approvalStart(event                          )                   {
      const build = activeBuild(key(event.sessionKey), null);
      if (!build) return [];
      const entered = enter(build, "approval");
      return entered ? [entered] : [];
    },

    approvalEnd(event                          )                   {
      const build = activeBuild(key(event.sessionKey), null);
      if (!build) return [];
      const current = build.steps[build.steps.length - 1];
      if (!current || current.phase !== "approval") return [];
      const entered = enter(build, "opening");
      return entered ? [entered] : [];
    },

    cardResponse(event                                                                         )                   {
      const build = activeBuild(key(event.sessionKey), null);
      if (!build || event.op === "command" || event.op === "draft_cancel" || event.op === "draft_removed") return [];
      if (event.op === "draft_prepare" && event.ok === true) return [];
      if (event.op === "look" && build.studio) {

        build.testRunning = false;
        const finished = studioFinishing(build);
        return finished ? [finished] : [];
      }
      if (event.op === "look") {
        const entered = enter(build, "checking");
        return entered ? [entered] : [];
      }

      if (event.op === "draft_launch" && event.ok === true && typeof event.draftId === "string" && DRAFT_ID.test(event.draftId)) {
        build.draftId = event.draftId;
      }
      if (event.ok === true) {

        if (!build.cardOpen && build.studio) {
          dropSpeech(build);
          if (build.noteKind !== "agent") {
            build.note = null;
            build.noteKind = null;
          }
        } else if (!build.cardOpen) {
          build.note = null;
          build.noteKind = null;
        }
        build.cardOpen = true;
        build.cardFailed = false;
      } else if (!build.cardOpen) {
        build.cardFailed = true;
      }
      return [];
    },

    checked(event                          )                   {
      const sessionKey = key(event.sessionKey);
      const build = activeBuild(sessionKey, null);
      if (!build || !build.cardOpen) return [];

      const done = finish(build.sessionKey, null, "clean_test");
      closed.set(matchKey(build.sessionKey), build);
      if (closed.size > MAX_BUILDS) closed.delete(closed.keys().next().value          );
      return done ? [done] : [];
    },

    requestOrigin(event                                            )       {
      const sessionKey = key(event.sessionKey);
      if (!sessionKey) return;
      const origin = event.origin === "phone" || event.origin === "glasses" ? event.origin : null;
      const at = matchKey(sessionKey);
      origins.delete(at);
      origins.set(at, origin);
      if (origins.size > MAX_BUILDS) origins.delete(origins.keys().next().value          );
    },

    lateReply(event                                                           )                   {
      const held = heldFor(key(event.sessionKey), key(event.runId));
      if (!held) return [];
      const reply = replyFor(held.build, firstSentence(event.text, true));
      if (!reply) return [];
      held.signed = true;

      held.repliedAt = now();
      if (reply === held.build.reply) return [];
      held.build.reply = reply;
      const done = frame(held.build, true);
      keepTaskEnd(done);
      return [done];
    },

    frameLane(event                                           )                   {
      const sessionKey = key(event.sessionKey);
      const state                            = event.state === "drawing" || event.state === "added" || event.state === "none" ? event.state : null;
      if (!sessionKey || !state) return [];
      const build = activeBuild(sessionKey, null);
      if (build) {
        if (build.studio && state === "drawing" && build.frameLane !== "drawing") delete build.frameIdea;
        if (build.studio && (state === "drawing" || build.frameLane === "drawing")) build.frameLane = state;
        return [];
      }
      const done = ended.get(matchKey(sessionKey));
      if (!done || !done.studio || done.frameLane !== "drawing" || state === "drawing") return [];
      done.frameLane = state;
      const out = frame(done, true);
      keepTaskEnd(out);
      return [out];
    },

    frameIdea(event                                          )                   {
      const sessionKey = key(event.sessionKey);
      const idea = typeof event.idea === "string" ? event.idea.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      if (!sessionKey || !idea) return [];
      const build = activeBuild(sessionKey, null);
      if (build) {
        if (build.studio && build.frameLane === "drawing") build.frameIdea = idea;
        return [];
      }
      const done = ended.get(matchKey(sessionKey));
      if (!done || !done.studio || done.frameLane !== "drawing" || done.frameIdea === idea) return [];
      done.frameIdea = idea;
      const out = frame(done, true);
      keepTaskEnd(out);
      return [out];
    },

    flushQuietDone(event                                             )                   {

      const held = heldFor(key(event.sessionKey), null);
      const quiet = typeof event.quietMs === "number" && Number.isFinite(event.quietMs) ? Math.max(0, event.quietMs) : 0;
      if (!held || !held.signed || held.repliedAt == null || now() - held.repliedAt < quiet) return [];
      const build = flushHeldDone(key(event.sessionKey));
      if (!build) return [];
      const done = frame(build, true);
      keepTaskEnd(done);
      return [done];
    },

    flushDone(event                          )                   {
      const build = flushHeldDone(key(event.sessionKey));
      if (!build) return [];

      const done = frame(build, true);
      keepTaskEnd(done);
      return [done];
    },

    runEnd(event                                                              )                   {
      const sessionKey = key(event.sessionKey);

      if (sessionKey) closed.delete(matchKey(sessionKey));

      if (sessionKey) asks.delete(matchKey(sessionKey));
      runIsOver(sessionKey, key(event.runId));
      if (!activeBuild(sessionKey, key(event.runId), "runEnd")) return [];
      const done = finish(sessionKey          , event.aborted === true ? "stopped" : null);
      return done ? [done] : [];
    },

    requestTask(event                                          )                   {
      const sessionKey = key(event.sessionKey);
      const task = cardBuildTaskOf(event.task);
      if (!sessionKey || !task) return [];
      const at = matchKey(sessionKey);
      tasks.delete(at);
      tasks.set(at, task);
      if (tasks.size > MAX_BUILDS) tasks.delete(tasks.keys().next().value          );

      const testId = cardBuildTaskTestOf(event.task);
      taskTests.delete(at);
      if (testId) taskTests.set(at, testId);
      if (taskTests.size > MAX_BUILDS) taskTests.delete(taskTests.keys().next().value          );
      const build = builds.get(sessionKey);
      if (!build || build.changeBuild || (build.task && build.task.handle === task.handle && build.task.name === task.name)) return [];
      build.task = task;
      return build.steps.length > 0 ? [frame(build, false)] : [];
    },

    taskBuilds()                   {
      const at = now();
      const out                   = [];
      const open = new Set        ();
      for (const build of store.values()) {
        if (!build.task || build.steps.length === 0) continue;
        out.push(frame(build, false));
        open.add(build.task.handle);
      }
      for (const [handle, done] of [...taskEnds]) {
        if (at - done.atMs > CARD_BUILD_TASK_END_KEEP_MS) {
          taskEnds.delete(handle);
          continue;
        }
        if (!open.has(handle)) out.push({ ...done, steps: done.steps.map((step) => ({ ...step })) });
      }
      return out;
    },

    taskEnd(handle         )
                                                                                   {
      const done = typeof handle === "string" ? taskEnds.get(handle) : undefined;
      if (!done || now() - done.atMs > CARD_BUILD_TASK_END_KEEP_MS) return null;

      const adds = done.task?.addTo ? { addTo: done.task.addTo, ...(done.task.part ? { part: done.task.part } : {}) } : {};

      const fixes = done.task?.fix ? { fix: done.task.fix, ...(done.check ? { check: { ...done.check } } : {}) } : {};
      return { sessionKey: done.sessionKey, draftId: done.draftId || null, outcome: done.outcome || null, ...adds, ...fixes };
    },

    forgetTaskEnd(handle         )          {
      return typeof handle === "string" && taskEnds.delete(handle);
    },

    taskTestFor(sessionKey         )                {
      const at = key(sessionKey);
      return at && tasks.has(matchKey(at)) ? taskTests.get(matchKey(at)) ?? null : null;
    },

    taskFor(sessionKey         )                       {
      const at = key(sessionKey);
      const task = at ? tasks.get(matchKey(at)) : undefined;
      return task ? { ...task } : null;
    },

    handOff(event                                           )                   {

      const runId = key(event.runId);
      const build = activeBuild(key(event.sessionKey), null, "handOff");
      if (!build) return [];
      const prior = build.priorRunIds || [];
      for (const id of [build.runId, runId]) if (id && !prior.includes(id)) prior.push(id);
      build.priorRunIds = prior;
      build.runId = null;
      build.awaitRun = true;
      return [];
    },

    release(event                          )                   {
      const sessionKey = key(event.sessionKey);
      const build = sessionKey ? builds.get(sessionKey) : undefined;
      if (!build || !build.awaitRun) return [];
      const done = finish(sessionKey          );
      return done ? [done] : [];
    },

    changeSendRun(event                                           )       {
      const sessionKey = key(event.sessionKey);
      const runId = key(event.runId);
      const build = sessionKey ? builds.get(sessionKey) : undefined;
      if (!build || !runId || !build.awaitRun || build.changeWaitAt == null) return;
      build.sendRunId = runId;

      if (build.priorRunIds?.includes(runId)) build.priorRunIds = build.priorRunIds.filter((id) => id !== runId);
    },

    releaseChange(event                          )                   {
      const sessionKey = key(event.sessionKey);
      const build = sessionKey ? builds.get(sessionKey) : undefined;
      if (!build || !build.awaitRun || build.changeWaitAt == null) return [];
      if (now() - build.changeWaitAt < CARD_BUILD_CHANGE_RUN_WAIT_MS) return [];
      const done = finish(sessionKey          );
      return done ? [done] : [];
    },

    reasoning(event                                           )                   {
      const build = activeBuild(key(event.sessionKey), key(event.runId), "reasoning");
      const current = build ? build.steps[build.steps.length - 1] : null;
      if (!build || !current || !isPart(build, current.phase)) return [];
      build.reasoningAt = now();
      if (build.part !== "write") return [];
      build.part = "design";
      return [frame(build, false)];
    },

    toolEnd(event                                                           )                   {
      const build = activeBuild(key(event.sessionKey), key(event.runId), "toolEnd");

      const askKey = event.tool === "ask_glasses_card" ? key(event.sessionKey) : null;
      if (askKey) asks.delete(matchKey(askKey));
      if (event.tool === "edit_glasses_card") {

        const ended = build ?? closedBuild(key(event.sessionKey), key(event.runId));
        if (ended) ended.editing = false;
      }
      if (!build || build.cardOpen) return [];
      if (event.tool === "write_glasses_card") build.cardFailed = true;

      if (event.tool === "write_glasses_card" && build.studio) {
        const entered = enter(build, "writing");
        return entered ? [entered] : [];
      }
      return [];
    },

    tick()                   {
      const at = now();
      const out                   = [];
      for (const build of store.values()) {

        out.push(...releaseSpeech(build, at));
        const due = writeDueAt(build);
        if (due == null || due > at) continue;
        build.part = "write";
        out.push(frame(build, false));
      }
      return out;
    },

    nextTickAt()                {
      let next                = null;
      for (const build of store.values()) {
        for (const due of [writeDueAt(build), speechDueAt(build)]) {
          if (due != null && (next == null || due < next)) next = due;
        }
      }
      return next;
    },

    chatBuilds()                   {
      const at = now();
      const out                   = [];
      const open = new Set        ();
      for (const [session, build] of store) {
        if (build.task || build.steps.length === 0) continue;

        if (at - build.steps[build.steps.length - 1].startedAt > CARD_BUILD_CHAT_OPEN_REPLAY_MS) continue;
        out.push(frame(build, false));
        open.add(session);
      }
      for (const [session, done] of [...chatEnds]) {
        if (at - done.atMs > CARD_BUILD_CHAT_END_KEEP_MS) {
          chatEnds.delete(session);
          continue;
        }
        if (!open.has(session)) out.push({ ...done, steps: done.steps.map((step) => ({ ...step })) });
      }
      return out;
    },

    current(sessionKey         )                        {
      const build = activeBuild(key(sessionKey), null);
      return build && build.steps.length > 0 ? frame(build, false) : null;
    },

    activeCount()         {
      return builds.size;
    },
  };
}

function cardBuildView(frame                )         {
  const shown = JSON.stringify([
    frame.phase, frame.done, frame.steps.map((step) => [step.phase, step.detail ?? null]), frame.note, frame.noteKind,
    frame.detail ?? null, frame.name ?? null, frame.plan ?? null, frame.change ?? null, frame.tests ?? null,
    frame.icon ?? null, frame.part ?? null, frame.design ?? null, frame.attempt ?? null, frame.outcome ?? null,
    frame.check ?? null, frame.handedOff ?? null, frame.spoke ?? null,

    ...(frame.changeSave ? [frame.changeSave] : []),
    ...(frame.changePending ? ["changePending"] : []),

    ...(frame.live ? [frame.live] : []),
  ]);

  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < shown.length; i++) {
    const c = shown.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 12);
}

module.exports = { CARD_BUILD_TASK_CAPABILITY, CARD_STUDIO_CAPABILITY, cardBuildReasoningSignal, cardBuildLegacyFrame, cardBuildCheckOf, cardBuildLiveOf, cardBuildChangeSaveOf, CARD_BUILD_DESIGN_QUIET_MS, CARD_BUILD_TASK_END_KEEP_MS, CARD_BUILD_CHAT_END_KEEP_MS, CARD_BUILD_CHAT_OPEN_REPLAY_MS, CARD_BUILD_UNANSWERED_ASK_KEEP_MS, CARD_BUILD_DESIGN_SILENT_MS, CARD_BUILD_CHANGE_RUN_WAIT_MS, CARD_STUDIO_NOTE_CHARS, CARD_STUDIO_SPEECH_GAP_MS, CARD_STUDIO_SAY_MAX, cardStudioHoldMs, cardBuildTaskTestOf, cardBuildTaskAddOf, cardBuildTaskOf, cardBuildTaskFixOf, cardBuildTaskSendOf, cardChangeSendOf, cardCheckSendOf, isCardBuildTool, createCardBuildPhases, cardBuildView };
