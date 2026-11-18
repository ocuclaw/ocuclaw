const { createHash } = require("node:crypto");
const { isProgramCardLookDriveInput, PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES_PER_CALL, programCardLookDriveParameterProperties, validateProgramCardLookDriveFields } = require("./program-card-look-drive.cjs");
const { PROGRAM_CARD_STATE_MAX_BYTES, programCardStateBytes } = require("./glasses-ui-library.cjs");
const { noteProgramCardTestFindings, programCardOpenFindingRows } = require("./program-card-open-findings.cjs");
const { isRetiredLookProblem, withoutRetiredLookProblems } = require("./program-card-retired-problems.cjs");
const { planRequirements } = require("./program-card-plan.cjs");
const { isUnshownLine } = require("./program-card-unshown.cjs");

const PROGRAM_CARD_LOOK_CAPABILITY = "programCardsLookV1";

const PROGRAM_CARD_LOOK_PLAY_CAPABILITY = "programCardsLookPlayV1";
const PROGRAM_CARD_LOOK_PLAY_UNSUPPORTED =
  "invalid_request: this phone app cannot play a step (every); play with input steps between short waits instead";

const PROGRAM_CARD_LOOK_PLAY_RUN_CAPABILITY = "programCardsLookPlayRunV1";
const PROGRAM_CARD_LOOK_PLAY_RUN_UNSUPPORTED =
  "invalid_request: this phone app cannot run a play step (play:<seconds>); play with an input step's times and every instead";
const PROGRAM_CARD_LOOK_PLAY_MAX_S = 180;
const isPlayStep = (step     ) => typeof step?.do === "string" && step.do.startsWith("play:");
const PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY = "programCardsLiveCaptureV1";
const PROGRAM_CARD_FIRMWARE_TEXT_CAPABILITY = "programCardsFirmwareTextV1";
const LOOK_GLASSES_CARD_TOOL_NAME = "look_glasses_card";
const PROGRAM_CARD_LOOK_TIMEOUT_MS = 25_000;

const PROGRAM_CARD_LOOK_GAME_LIVE_S = 15;
const PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS = (PROGRAM_CARD_LOOK_GAME_LIVE_S - 6) * 1_000 + 5_000 + 3_000;

function withGameLive(payload     )                                    {
  if (!Array.isArray(payload?.steps) || !payload.steps.some(isPlayStep)) return { payload, extraMs: 0 };
  return { payload: { ...payload, gameLiveS: PROGRAM_CARD_LOOK_GAME_LIVE_S }, extraMs: PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS };
}
const PROGRAM_CARD_LOOK_MAX_BYTES = 768 * 1024;
const PROGRAM_CARD_LOOK_RESULT_MAX_BYTES = PROGRAM_CARD_LOOK_MAX_BYTES + 16_384;
const MAX_RECORDS = 64;
const record = (v     ) => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (message        ) => ({ ok: false, error: `invalid_request: ${message}` });
const bytes = (v     ) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
const clone = (v     ) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

const isPngBase64 = (s         ) => typeof s === "string" && s.length % 4 === 0 && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(s);

const PROGRAM_CARD_SPECK_PROPERTY = {
  type: "string",

  description: "Fill first: what you do now, ~50 chars, starting with its action; Speck says it to the wearer.",
};

const lookGlassesCardParametersSchema = {
  type: "object",
  properties: {
    speck: PROGRAM_CARD_SPECK_PROPERTY,
    requirements: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 }, description: "The wearer's asks, in your words." },
    steps: {
      type: "array", maxItems: 12,
      items: { type: "object", required: ["do"], properties: {
        do: { type: "string", description: "open, up, down, tap, double, hold, back, menu:<id>, input:<key>[:<side>], text:<words>, wait:<seconds>, play:<seconds> (the phone plays the game, looking ahead, up to 180 s of game time)" },
        say: { type: "string", maxLength: 40, description: "What this tests, in present tense: Testing Pause keeps the time." },
        watch: { type: "number", exclusiveMinimum: 0, maximum: 3600, description: "Advance the private clock until the screen changes and settles, nothing remains scheduled, or this many seconds pass." },
        snap: { type: "string", minLength: 1, maxLength: 80, description: "Take a checkpoint picture after this step, with this short caption." },
        expect: { type: "string", minLength: 1, maxLength: 120, description: "Visible words expected after this step; the result records passed or failed." },
        times: { type: "integer", minimum: 1, maximum: 50, description: "Repeat this gesture or direct input this many times." },
        every: { type: "number", exclusiveMinimum: 0, maximum: 10, description: "With times: seconds between the inputs, the card running between, to play a game." },
        goal: { type: "string", description: "With play: the state value to raise (score)." },
        avoid: { type: "array", items: { type: "string" }, description: "With play: gestures never to make (tap up down double tilt)." },

        proves: { type: "string", maxLength: 80, description: "The ask line this step shows, word for word. The host judges the line from what the step measured: a failed expect or a broken or fix problem fails it." },
      }, additionalProperties: false },
      description: "A short plan. Omit to replay the previous Test (its tagged steps judge their lines again).",
    },
    start: { type: "object", properties: { state: {}, feeds: {} }, additionalProperties: false, description: "Optional frozen state and feed values for the copy; defaults to the live card's latest data." },
    why: { type: "string", maxLength: 60, description: "What this Look is testing." },
    live:{ type: "boolean", description: "A picture of the currently accepted frame, without testing controls." },
    ...programCardLookDriveParameterProperties,
  },
  additionalProperties: false,
};

const RETIRED_LOOK_FIELDS = new Set(["verdicts"]);

function validAction(action     ) {
  if (typeof action !== "string") return false;
  if (/^(open|up|down|tap|double|hold|back)$/.test(action)) return true;

  if (/^menu:[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(action)) return true;
  if (/^input:[A-Za-z0-9_.-]{1,40}(?::(?:left|right|ring))?$/.test(action)) return true;
  if (action.startsWith("text:")) return new TextEncoder().encode(action.slice(5)).byteLength <= 500;

  if (action.startsWith("voice:")) return action.length > 6 && new TextEncoder().encode(action.slice(6)).byteLength <= 500;
  if (/^play:\d+(?:\.\d+)?$/.test(action)) return Number(action.slice(5)) >= 1 && Number(action.slice(5)) <= PROGRAM_CARD_LOOK_PLAY_MAX_S;
  if (!/^wait:\d+(?:\.\d+)?$/.test(action)) return false;
  const seconds = Number(action.slice(5));
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600;
}

const repeatableAction = (action        ) => /^(up|down|tap|double|hold|back|input:)/.test(action);

const PROGRAM_CARD_PLAY_HINTS = Object.freeze(["goal", "avoid"]);
const PLAY_AVOID = new Set(["tap", "up", "down", "double", "tilt"]);
const PLAY_GOAL_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3}$/;
const ECHO_FIELDS = new Set(["do", "say", "watch", "snap", "expect", "times", "every"]);
const PLAN_FIELDS = new Set([...ECHO_FIELDS, ...PROGRAM_CARD_PLAY_HINTS]);

function withoutPlayHints(steps     ) {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step     ) => {
    if (!record(step) || !PROGRAM_CARD_PLAY_HINTS.some(k => k in step)) return step;
    const { goal: _goal, avoid: _avoid, ...rest } = step;
    return rest;
  });
}

const PROGRAM_CARD_LOOK_EVERY_MAX_S = 10;
const PROGRAM_CARD_LOOK_EVERY_TOTAL_S = 60;
const INTERNAL_PLAN_FIELDS = new Set([...PLAN_FIELDS, "label", "fresh", "control"]);

const STEP_TEXT_MAX                         = { say: 40, snap: 80, expect: 120 };

function validStep(step     , internal = false) {
  const fields = internal ? INTERNAL_PLAN_FIELDS : PLAN_FIELDS;
  if (!record(step) || Object.keys(step).some(k => !fields.has(k)) || !validAction(step.do)) return false;
  if (step.say !== undefined && (typeof step.say !== "string" || step.say.length > STEP_TEXT_MAX.say)) return false;
  if (step.watch !== undefined && (!Number.isFinite(step.watch) || step.watch <= 0 || step.watch > 3600 || step.do.startsWith("wait:") || isPlayStep(step))) return false;
  if (step.snap !== undefined && (typeof step.snap !== "string" || !step.snap.trim() || step.snap.length > STEP_TEXT_MAX.snap)) return false;
  if (step.expect !== undefined && (typeof step.expect !== "string" || !step.expect.trim() || step.expect.length > STEP_TEXT_MAX.expect)) return false;
  if (step.times !== undefined && (!Number.isInteger(step.times) || step.times < 1 || step.times > 50 || !repeatableAction(step.do))) return false;
  if (step.every !== undefined && (!Number.isFinite(step.every) || step.every <= 0 || step.every > PROGRAM_CARD_LOOK_EVERY_MAX_S ||
    step.times === undefined || step.watch !== undefined || step.times * step.every > PROGRAM_CARD_LOOK_EVERY_TOTAL_S)) return false;
  if ((step.goal !== undefined || step.avoid !== undefined) && !isPlayStep(step)) return false;
  if (step.goal !== undefined && (typeof step.goal !== "string" || step.goal.length > 64 || !PLAY_GOAL_PATH.test(step.goal))) return false;
  if (step.avoid !== undefined && (!Array.isArray(step.avoid) || step.avoid.length > 5 || step.avoid.some((g     ) => !PLAY_AVOID.has(g)))) return false;
  if (internal && (step.label !== undefined && (typeof step.label !== "string" || step.label.length > 120) ||
    step.fresh !== undefined && step.fresh !== true || step.control !== undefined && (typeof step.control !== "string" || step.control.length > 64))) return false;
  return true;
}

const LOOK_FILLER                                          = {
  drive: v => v === false, stop: v => v === false, live: v => v === false,
  copyId: v => v === "", why: v => typeof v === "string" && !v.trim(),
  steps: v => Array.isArray(v) && !v.length, requirements: v => Array.isArray(v) && !v.length,
  verdicts: v => Array.isArray(v) && !v.length, start: v => record(v) && !Object.keys(v).length,
};

function waitStep(step     ) {
  if (!record(step) || typeof step.do !== "string" || !step.do.startsWith("wait:")) return step;
  if (/^wait:\.\d+$/.test(step.do)) step = { ...step, do: `wait:0${step.do.slice(5)}` };
  const { times, watch, ...rest } = step;
  const seconds = Number(step.do.slice(5));
  const repeat = Number.isInteger(times) && times >= 1 && times <= 50 && Number.isFinite(seconds);
  return { ...rest, ...(repeat ? { do: `wait:${Number((seconds * times).toFixed(3))}` } : times !== undefined ? { times } : {}),
    ...(watch !== undefined && !(Number.isFinite(watch) && watch > 0) ? { watch } : {}) };
}

function normalizeLookInput(input     )      {
  if (!record(input)) return input;
  const out      = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || LOOK_FILLER[key]?.(value)) continue;
    out[key] = key === "steps" && Array.isArray(value) ? value.map(waitStep) : value;
  }
  return out;
}

function sortedJson(value     )         {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${sortedJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function driveIntent(input     , copy                  ) {
  if (typeof input.copyId !== "string" || input.stop === true || input.drive !== true && input.start === undefined) return input;
  const { drive: _drive, start, ...rest } = input;
  if (start === undefined || copy && sortedJson(start) === sortedJson(copy.start)) return rest;
  const { copyId: _copyId, ...fresh } = rest;
  return { ...fresh, drive: true, start };
}

function validateLookStop(input     )      {
  const ignored = Object.keys(input).filter(key => !["stop", "copyId"].includes(key));
  return { ok: true, ...(ignored.length ? { ignored } : {}), payload: { stop: true,
    ...(typeof input.copyId === "string" ? { copyId: input.copyId } : {}) } };
}

function validateLookInput(raw     , copy                  , opts                         = {})      {
  const internal = opts.internal === true;
  if (!record(raw)) return bad("input must be an object");
  if (Object.keys(raw).some(k => !RETIRED_LOOK_FIELDS.has(k) && !Object.prototype.hasOwnProperty.call(lookGlassesCardParametersSchema.properties, k))) return bad("unknown Look field");
  const input = driveIntent(normalizeLookInput(Object.fromEntries(Object.entries(raw).filter(([k]) => !RETIRED_LOOK_FIELDS.has(k)))), copy);
  if (input.stop === true) return validateLookStop(input);
  const drive = validateProgramCardLookDriveFields(input);
  if (!drive.ok) return drive;
  if (input.requirements !== undefined && (!Array.isArray(input.requirements) || input.requirements.length > 6 ||
    input.requirements.some((r     ) => typeof r !== "string" || !r.trim() || r.length > 80))) return bad("requirements must have at most 6 nonempty strings of at most 80 chars");
  if (input.why !== undefined && typeof input.why !== "string") return bad("why must be a string");
  if (typeof input.why === "string" && input.why.length > 60) return bad(`why is ${input.why.length} chars; max 60`);
  if (input.live !== undefined && typeof input.live !== "boolean") return bad("live must be true or false");
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 12) return bad("steps must have 1 to 12 items");
    for (const [i, step] of input.steps.entries()) {
      const long = record(step) ? Object.keys(STEP_TEXT_MAX).find(k => typeof step[k] === "string" && step[k].length > STEP_TEXT_MAX[k]) : undefined;
      if (long) return bad(`steps[${i}].${long} is ${step[long].length} chars; max ${STEP_TEXT_MAX[long]}`);
      if (record(step) && step.every !== undefined && validStep({ ...step, every: undefined }) && !validStep(step)) {
        return bad(`steps[${i}].every needs times and no watch, at most ${PROGRAM_CARD_LOOK_EVERY_MAX_S} s apart and ${PROGRAM_CARD_LOOK_EVERY_TOTAL_S} s in all`);
      }
      if (!validStep(step, internal)) return bad(`steps[${i}] has an invalid do, say, watch, snap, expect, times, every, goal or avoid`);
    }
  }
  if (input.start !== undefined && (!record(input.start) || Object.keys(input.start).some(k => k !== "state" && k !== "feeds"))) return bad("start accepts state and feeds only");
  try { if (input.start && bytes(input.start) > 64 * 1024) return bad("start exceeds 64 KiB"); } catch { return bad("start must be plain JSON"); }
  if (isProgramCardLookDriveInput(input) && input.stop !== true && !input.steps?.length) return bad("a drive call needs steps");
  if (isProgramCardLookDriveInput(input) && input.steps?.filter((step     ) => typeof step?.snap === "string").length >
    PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES_PER_CALL) return bad("a drive call has at most 2 snap steps");
  return { ok: true, payload: {
    ...(input.requirements ? { requirements: input.requirements.map((r        ) => r.trim()) } : {}),
    ...(input.steps ? { steps: input.steps.map((s     ) => ({ do: s.do, ...(s.say ? { say: s.say } : {}),
      ...(s.watch !== undefined ? { watch: s.watch } : {}), ...(s.snap ? { snap: s.snap.trim() } : {}),
      ...(s.expect ? { expect: s.expect.trim() } : {}), ...(s.times !== undefined ? { times: s.times } : {}),
      ...(s.every !== undefined ? { every: s.every } : {}),

      ...(internal ? { ...(typeof s.label === "string" ? { label: s.label.slice(0, 120) } : {}), ...(s.fresh === true ? { fresh: true } : {}),
        ...(typeof s.control === "string" ? { control: s.control.slice(0, 64) } : {}) } : {}) })) } : {}),
    ...(input.start ? { start: input.start } : {}), ...(input.why ? { why: input.why.trim() } : {}),
    ...(input.live === true ? { live: true } : {}),
    ...(input.drive === true ? { drive: true } : {}), ...(input.copyId ? { copyId: input.copyId } : {}),
  } };
}

const PROGRAM_CARD_LOOK_CASES_CAPABILITY = "programCardsLookCasesV1";

const PROGRAM_CARD_LOOK_CASES = Object.freeze({ max: 16, runs: 5, keys: 8, expects: 4, expectWords: 120,
  problems: 12, screenWords: 24, maxAgoMs: 30 * 86_400_000, caseMs: 1_000, budgetMs: 12_000 });
const PROGRAM_CARD_LOOK_CASE_KINDS = Object.freeze(["nothing_yet", "empty", "full", "long", "number_as_text", "missing_field",
  "unchecked", "clock", "runs", "other"]);

const PROGRAM_CARD_LOOK_CASES_HOST_MS = PROGRAM_CARD_LOOK_CASES.budgetMs + 2_000;

const PROGRAM_CARD_LOOK_CASES_MAX_BYTES = 64 * 1024;
const TASK_FACTS_MAX_CHARS = 8000;
const CASE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const CASE_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const caseKinds = new Set        (PROGRAM_CARD_LOOK_CASE_KINDS);

function validateLookCases(value     )      {
  const refuse = (message        ) => ({ ok: false, error: `invalid_look_cases: ${message}` });
  try {
    if (!Array.isArray(value) || value.length > PROGRAM_CARD_LOOK_CASES.max) return refuse(`at most ${PROGRAM_CARD_LOOK_CASES.max} cases`);
    if (bytes(value) > PROGRAM_CARD_LOOK_CASES_MAX_BYTES) return refuse("cases exceed 64 KiB");
    for (const [i, item] of value.entries()) {
      const at = `cases[${i}]`;
      if (!record(item) || !caseKinds.has(item.kind)) return refuse(`${at} needs a known kind`);
      if (Object.keys(item).some(k => !["kind", "name", "clock", "shape", "runs", "task", "expect"].includes(k))) return refuse(`${at} has an unknown field`);
      if (typeof item.name !== "string" || !CASE_NAME.test(item.name)) return refuse(`${at}.name`);
      if (item.clock !== undefined && (typeof item.clock !== "string" || !CASE_CLOCK.test(item.clock))) return refuse(`${at}.clock`);
      if (item.shape !== undefined && item.shape !== "values" && item.shape !== "snapshot") return refuse(`${at}.shape`);
      if (!Array.isArray(item.runs) || item.runs.length > PROGRAM_CARD_LOOK_CASES.runs) return refuse(`${at}.runs`);
      for (const run of item.runs) {
        if (!record(run) || !record(run.values) || Object.keys(run.values).length > PROGRAM_CARD_LOOK_CASES.keys ||
          run.ago !== undefined && (!Number.isFinite(run.ago) || run.ago < 0 || run.ago > PROGRAM_CARD_LOOK_CASES.maxAgoMs) ||
          run.fixes !== undefined && !record(run.fixes)) return refuse(`${at}.runs`);
      }
      if (item.task !== undefined && (!record(item.task) || JSON.stringify(item.task).length > TASK_FACTS_MAX_CHARS)) return refuse(`${at}.task`);
      if (item.expect !== undefined && (!Array.isArray(item.expect) || item.expect.length > PROGRAM_CARD_LOOK_CASES.expects ||
        item.expect.some((w     ) => typeof w !== "string" || !w.trim() || w.length > PROGRAM_CARD_LOOK_CASES.expectWords))) return refuse(`${at}.expect`);
    }
    return { ok: true, cases: clone(value) };
  } catch { return refuse("cases must be plain JSON"); }
}

function lookCasesDebug(report     ) {
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const ran = cases.filter((c     ) => c.skipped === undefined);
  return { cases: cases.length, casesRan: ran.length, casesCrashed: ran.filter((c     ) => c.crashed).length,
    casesMs: Number.isFinite(report?.casesMs) ? Math.round(report.casesMs) : null,
    caseMsMax: ran.length ? Math.max(...ran.map((c     ) => c.ms)) : null };
}

function validLookCaseResults(value     ) {
  if (!Array.isArray(value) || value.length > PROGRAM_CARD_LOOK_CASES.max) return false;
  return value.every((item     , i        ) => record(item) && item.index === i && caseKinds.has(item.kind) &&
    typeof item.name === "string" && CASE_NAME.test(item.name) &&
    Array.isArray(item.problems) && item.problems.length <= PROGRAM_CARD_LOOK_CASES.problems &&
    item.problems.every((p     ) => record(p) && typeof p.code === "string") &&
    (item.skipped === undefined ? typeof item.crashed === "boolean" && Number.isFinite(item.ms) && item.ms >= 0 : item.skipped === "out_of_time") &&
    (item.screen === undefined || Array.isArray(item.screen) && item.screen.length <= PROGRAM_CARD_LOOK_CASES.screenWords &&
      item.screen.every((w     ) => typeof w === "string")) &&
    (item.expects === undefined || Array.isArray(item.expects) && item.expects.length <= PROGRAM_CARD_LOOK_CASES.expects &&
      item.expects.every((e     ) => record(e) && typeof e.words === "string" && ["passed", "failed"].includes(e.outcome))));
}

function validateLookReport(value     , options      = {})      {
  try {
    if (!record(value)) return { ok: false, error: "invalid_look_report" };
    const partial = options.partial === true && value.ok === false;
    if (bytes(value) > PROGRAM_CARD_LOOK_MAX_BYTES) return { ok: false, error: "look_payload_too_large" };
    if (value.version !== 1 || !Array.isArray(value.steps) || value.steps.length > 12 ||
      !Array.isArray(value.problems) || value.problems.length > 256) return { ok: false, error: "invalid_look_report" };
    if (!/^[a-f0-9]{32}$/.test(value.digest) || !/^[a-f0-9]{32}$/.test(value.planHash) ||
      !Number.isFinite(value.t0) || value.t0 < 0 || !Number.isFinite(value.phoneMs) || value.phoneMs < 0) return { ok: false, error: "invalid_look_identity" };
    if (value.plan !== undefined) {

      const planless = partial && value.plan?.length === 0 && value.steps.length === 0;
      if (!Array.isArray(value.plan) || value.plan.length === 0 && !planless || value.plan.length > 12 || value.plan.some((step     ) => !validStep(step, true))) return { ok: false, error: "invalid_look_plan" };
      const actualHash = createHash("sha256").update(JSON.stringify(value.plan), "utf8").digest("hex").slice(0, 32);
      if (actualHash !== value.planHash) return { ok: false, error: "invalid_look_identity" };
      if (partial) {
        if (value.steps.length > value.plan.length || value.steps.some((step     , index        ) => {
          const stepIndex = Number.isInteger(step?.index) ? step.index : index;
          return stepIndex !== index || [...ECHO_FIELDS].some(field => value.plan[index]?.[field] !== step?.[field]);
        })) return { ok: false, error: "invalid_look_plan" };
      } else if (value.plan.length !== value.steps.length || value.plan.some((planned     , index        ) =>
        [...ECHO_FIELDS].some(field => (planned       )[field] !== value.steps[index]?.[field]))) return { ok: false, error: "invalid_look_plan" };
    }
    for (const step of value.steps) {
      if (!record(step) || typeof step.do !== "string" ||
        ["rebuild", "texts", "tiles", "stages"].some(k => !Number.isSafeInteger(step[k]) || step[k] < 0) ||
        !Number.isFinite(step.g2ms) || step.g2ms < 0 || !Array.isArray(step.lz4) || step.lz4.some((n     ) => !Number.isSafeInteger(n) || n < 0) ||
        ["wakes", "elapsedMs", "smallestTextHeight"].some(k => step[k] !== undefined && step[k] !== null && (!Number.isFinite(step[k]) || step[k] < 0))) return { ok: false, error: "invalid_look_metrics" };
      const planned = Object.fromEntries([...ECHO_FIELDS].filter(field => step[field] !== undefined).map(field => [field, step[field]]));
      const watch = step.watchResult;
      if (!validStep(planned) || step.expectOutcome !== undefined && (step.expect === undefined || !["passed", "failed"].includes(step.expectOutcome)) ||
        watch !== undefined && (!record(watch) || step.watch === undefined || !["changed_settled", "nothing_scheduled", "cap_reached"].includes(watch.outcome) ||
          watch.maxSeconds !== step.watch || !Number.isFinite(watch.observedMs) || watch.observedMs < 0 || watch.observedMs > step.watch * 1000 ||
          typeof watch.changed !== "boolean" || ![0, 10_000].includes(watch.costWindowMs) || watch.costWindowMs === 10_000 && watch.outcome !== "cap_reached")) return { ok: false, error: "invalid_look_step" };
    }
    if (value.cases !== undefined && (!validLookCaseResults(value.cases) || !Number.isFinite(value.casesMs) || value.casesMs < 0)) return { ok: false, error: "invalid_look_cases" };
    const indexes = value.steps.map((s     , i        ) => Number.isInteger(s?.index) ? s.index : i);
    if (new Set(indexes).size !== indexes.length || indexes.some((n        ) => n < 0 || n > 11)) return { ok: false, error: "invalid_look_step" };
    let pictures = value.pictures ?? [];
    if (!Array.isArray(pictures) || pictures.length > 6) return { ok: false, error: "invalid_look_pictures" };

    if (partial) pictures = pictures.filter((picture     ) => !record(picture) || indexes.includes(picture.step));
    for (const picture of pictures) {
      if (!record(picture) || !indexes.includes(picture.step) || !["all", "first"].includes(picture.after) ||
        !isPngBase64(picture.png) ||
        picture.caption !== undefined && (typeof picture.caption !== "string" || !picture.caption.trim() || picture.caption.length > 80) ||
        picture.checkpoint !== undefined && picture.checkpoint !== true) return { ok: false, error: "invalid_look_picture" };
    }
    return { ok: true, report: { ...value, steps: value.steps.map((s     , i        ) => ({ ...s, index: indexes[i] })), pictures } };
  } catch { return { ok: false, error: "invalid_look_report" }; }
}

function lookReportWithoutPixels(report     ) {

  return { ...report, pictures: (report.pictures ?? []).map(({ png, ...picture }     ) => picture) };
}

const PATH_KEYED_PROBLEMS = new Set(["raster_truncated"]);
function lookProblemKey(p     ) {
  const rect = !PATH_KEYED_PROBLEMS.has(p?.code) && p?.rect && ["x", "y", "w", "h"].every((k) => Number.isFinite(p.rect[k]))
    ? [p.rect.x, p.rect.y, p.rect.w, p.rect.h] : null;
  return JSON.stringify(typeof p?.id === "string" ? [p.code, "id", p.id] : rect ? [p.code, "rect", ...rect] : [p.code, p?.path]);
}
const writeTotal = (r     ) => (r?.steps ?? []).reduce((n        , s     ) => n + (Number(s.rebuild) || 0) + (Number(s.texts) || 0) + (Number(s.tiles) || 0), 0);

function compareLookReports(before     , after     , untested           = []) {
  const previous = new Map((before?.problems ?? []).map((p     ) => [lookProblemKey(p), p]));
  const current = new Map((after?.problems ?? []).map((p     ) => [lookProblemKey(p), p]));
  const oldSteps = new Map((before?.steps ?? []).map((s     ) => [s.index, s]));
  const changedPictures = (after?.steps ?? []).flatMap((s     ) => {
    const old      = oldSteps.get(s.index);
    return old?.pictureHash && s.pictureHash && old.pictureHash !== s.pictureHash ? [{ step: s.index, before: old.pictureHash, after: s.pictureHash }] : [];
  });
  return {
    fixed: Array.from(previous.entries()).filter(([k]) => !current.has(k)).map(([, p]) => p),
    new: Array.from(current.entries()).filter(([k]) => !previous.has(k)).map(([, p]) => p),
    stillThere: Array.from(current.entries()).filter(([k]) => previous.has(k)).map(([, p]) => p),
    changedPictures, writes: { before: writeTotal(before), after: writeTotal(after), delta: writeTotal(after) - writeTotal(before) },
    requirementsWithoutVerdict: untested,
  };
}

const DRIVE_PHONE_RECEIPT_MAX_BYTES = 64 * 1024;
const DRIVE_PHONE_FIXED_MAX = 40;
const DRIVE_PHONE_IDENTITY_FIELD_MAX_BYTES = 512;
const DRIVE_PHONE_IDENTITY_MAX_BYTES = 1024;
const DRIVE_PHONE_ADVICE_MAX = 8;
const DRIVE_PHONE_ADVICE_KEY_MAX_BYTES = 128;
const own = (value     , key        ) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const boundedText = (value     , maximum        ) => typeof value === "string" ? value.slice(0, maximum) : undefined;
const textBytes = (value        ) => new TextEncoder().encode(value).byteLength;

function projectProgramCardLookDriveReceipt(result     , advice           = []) {
  const report = record(result?.report) ? result.report : {};
  const requirements = Array.isArray(result?.requirements) ? result.requirements.slice(0, 6)
    .filter((value     ) => typeof value === "string" && value.length > 0 && value.length <= 80) : [];
  const tests = Array.isArray(result?.tests) ? result.tests.slice(0, 6).flatMap((test     ) => {
    if (!record(test) || typeof test.requirement !== "string" || !test.requirement.length || test.requirement.length > 80) return [];
    const verdict = boundedText(test.verdict, 40);
    return [{ requirement: test.requirement, ...(verdict !== undefined ? { verdict } : {}),
      ...(Number.isInteger(test.step) ? { step: test.step } : {}) }];
  }) : [];
  const projected      = {
    drive: true,
    ...(own(result, "ok") ? { ok: result.ok === true } : {}),
    ...(own(result, "error") ? { error: boundedText(result.error, 120) ?? null } : {}),
    ...(typeof result?.failedCopy === "boolean" && own(result, "failedCopy") ? { failedCopy: result.failedCopy } : {}),
    ...(Number.isInteger(result?.looks) ? { looks: result.looks } : {}),
    requirements,
    tests,
    ...(typeof result?.picturesDelivered === "boolean" ? { picturesDelivered: result.picturesDelivered } : {}),
    ...(own(result, "picturesReason") ? { picturesReason: boundedText(result.picturesReason, 200) ?? null } : {}),
    report: {
      ...(own(report, "ok") ? { ok: report.ok === true } : {}),
      error: boundedText(report.error, 120) ?? null,
      digest: typeof report.digest === "string" && /^[a-f0-9]{32}$/.test(report.digest) ? report.digest : null,
      planHash: typeof report.planHash === "string" && /^[a-f0-9]{32}$/.test(report.planHash) ? report.planHash : null,
    },
    ...(result?.metadataOnly === true ? { metadataOnly: true } : {}),
  };
  const adviceKeys = [...new Set((Array.isArray(advice) ? advice : [])
    .filter((key     ) => typeof key === "string" && key.length > 0 && textBytes(key) <= DRIVE_PHONE_ADVICE_KEY_MAX_BYTES))]
    .slice(0, DRIVE_PHONE_ADVICE_MAX);
  if (adviceKeys.length) {
    const withAdvice = { ...projected, report: { ...projected.report, advice: adviceKeys } };
    if (bytes(withAdvice) <= DRIVE_PHONE_RECEIPT_MAX_BYTES) projected.report = withAdvice.report;
  }
  const fixed        = [];
  for (const problem of Array.isArray(result?.diff?.fixed) ? result.diff.fixed : []) {
    if (fixed.length >= DRIVE_PHONE_FIXED_MAX) break;
    if (typeof problem === "string") {
      if (textBytes(problem) > DRIVE_PHONE_IDENTITY_FIELD_MAX_BYTES) continue;
      const withCandidate = { ...projected, diff: { fixed: [...fixed, problem] } };
      if (bytes(withCandidate) <= DRIVE_PHONE_RECEIPT_MAX_BYTES) fixed.push(problem);
      continue;
    }
    if (!record(problem)) continue;
    const identity      = {};
    let malformed = false;
    for (const key of ["code", "path", "id"]) {
      if (!own(problem, key)) continue;
      if (typeof problem[key] !== "string" || textBytes(problem[key]) > DRIVE_PHONE_IDENTITY_FIELD_MAX_BYTES) {
        malformed = true;
        break;
      }
      identity[key] = problem[key];
    }
    if (malformed || !Object.keys(identity).length || bytes(identity) > DRIVE_PHONE_IDENTITY_MAX_BYTES) continue;
    const candidate = { ...identity, ...(typeof problem.message === "string" ? { message: problem.message.slice(0, 200) } : {}),
      ...(Number.isInteger(problem.step) ? { step: problem.step } : {}) };
    const withCandidate = { ...projected, diff: { fixed: [...fixed, candidate] } };
    if (bytes(withCandidate) <= DRIVE_PHONE_RECEIPT_MAX_BYTES) fixed.push(candidate);
  }
  return fixed.length ? { ...projected, diff: { fixed } } : projected;
}

const withAddedRequirements = (current          , added                      ) =>
  planRequirements(current, added) ?? current;

const WEARER_ONLY = /readab|legib|comfort|eye[ -]?strain|easy to read|physical paint|firmware (?:font|shaping)|ble timing|가독|읽기 쉬|편안|可读|可讀|易读|易讀|舒适|舒適|読みやす|見やす|快適/i;

const isWearerOnlyLine = (line        ) => typeof line === "string" && (WEARER_ONLY.test(line) || isUnshownLine(line));

function programCardLineVerdict(requirement        , outcome        , failedBefore = false) {
  const judged = outcome === "passed" && isWearerOnlyLine(requirement) ? "wearer_check" : outcome;
  return judged === "passed" ? failedBefore ? "fixed" : "passed" : judged === "failed" ? "still_open" : "wearer_check";
}

const requirementKey = (text        ) => text.toLowerCase().replace(/["'`‘’“”]/g, "")
  .replace(/[\s.,;:!?…]+/g, " ").trim();

function matchLookRequirement(requirements          , named        )                {
  if (requirements.includes(named)) return named;
  const key = requirementKey(named);
  const keys = requirements.map(requirementKey);
  const same = requirements.filter((_, i) => keys[i] === key);
  if (same.length === 1) return same[0];
  if (same.length > 1 || key.length < 8) return null;
  const overlap = requirements.filter((_, i) => keys[i].length >= 8 && (keys[i].includes(key) || key.includes(keys[i])));
  return overlap.length === 1 ? overlap[0] : null;
}

const stepIndexes = (report     ) => Array.isArray(report?.steps) ? report.steps.map((step     ) => step?.index).filter(Number.isInteger) : [];

const PROGRAM_CARD_TESTS_PER_TURN = 3;

const PROGRAM_CARD_TESTS_GIVEN_BACK_PER_TURN = 3;

const TEST_COULD_NOT_RUN = new Set(["look_not_direct", "look_not_playable", "look_control_missing", "look_no_text_control",
  "look_no_voice", "look_plan", "look_cases"]);

const programCardTestCouldNotRun = (error         ) => typeof error === "string" && TEST_COULD_NOT_RUN.has(error);

function giveBack(entry     )          {
  if (!entry.charged || entry.looks <= 0 || entry.returned >= PROGRAM_CARD_TESTS_GIVEN_BACK_PER_TURN) return false;
  entry.charged = false;
  entry.looks--;
  entry.returned++;
  return true;
}

function createProgramCardLookHistory(options      = {}) {
  const history = new Map             ();
  const sessionKey = (s        ) => typeof options.keyOf === "function" ? options.keyOf(s) : s;
  const key = (s        , card        ) => `${sessionKey(s)}\u0000${card}`;
  function get(s        , card        ) { return history.get(key(s, card)); }
  function tests(entry     ) {
    return entry.requirements.map((requirement        ) => ({ requirement, ...(entry.verdicts.get(requirement) ?? { verdict: "not_tested" }) }));
  }

  function verdicts(s        , card        , supplied       , added           )      {
    const entry = get(s, card);
    if (!supplied.length) return { ok: true, verdicts: entry ? Array.from(entry.verdicts.values()) : [] };
    if (!entry?.last) return { ok: false, error: "invalid_verdict_step: no previous Look" };
    const requirements = withAddedRequirements(entry.requirements, added);

    const indexes = new Set([...stepIndexes(entry.lastBatch), ...stepIndexes(entry.last)]);
    const normalized        = [], wearerChecks           = [];
    for (const v of supplied) {
      const requirement = matchLookRequirement(requirements, v.requirement);

      if (!requirement && WEARER_ONLY.test(v.requirement)) { wearerChecks.push(v.requirement); continue; }
      if (!requirement) return bad(`verdict names an unknown requirement "${v.requirement}"; name one of ${requirements.map(r => JSON.stringify(r)).join(", ")}`);
      const outcome = v.outcome === "passed" && isWearerOnlyLine(requirement) ? "wearer_check" : v.outcome;

      const known = indexes.has(v.step);
      if (!known && outcome === "passed") {
        const sorted = [...indexes].sort((a, b) => a - b);
        return { ok: false, error: `invalid_verdict_step: step ${v.step} is not in the previous Look${sorted.length ? `, whose steps are ${sorted[0]}-${sorted.at(-1)}` : ""}` };
      }
      const failedBefore = entry.failed.has(requirement);
      normalized.push({ requirement, ...(known ? { step: v.step } : {}), outcome,
        verdict: programCardLineVerdict(requirement, outcome, failedBefore) });
    }
    for (const v of normalized) { if (v.outcome === "failed") entry.failed.add(v.requirement); entry.verdicts.set(v.requirement, v); }
    return { ok: true, verdicts: Array.from(entry.verdicts.values()), ...(wearerChecks.length ? { wearerChecks } : {}) };
  }

  function lookVerdicts(s        , card        , input     )      {
    const accepted = verdicts(s, card, input.verdicts ?? [], input.requirements);
    return accepted.ok || get(s, card)?.last ? accepted : { ok: true, verdicts: [] };
  }
  return {
    reserve(s        , card        , input     )      {
      const accepted = lookVerdicts(s, card, input);
      if (!accepted.ok) return accepted;
      let entry = get(s, card);
      if (!entry) {
        if (history.size >= MAX_RECORDS) return { ok: false, error: "look_capacity" };
        entry = { session: sessionKey(s), card, looks: 0, returned: 0, charged: false, requirements: [], verdicts: new Map(), failed: new Set(), last: null,
          lastBatch: null, plan: null, planMode: null, planStart: undefined, driveStart: undefined,
          drivePrevious: null, driveReport: null, open: new Map(), lookStart: undefined };
        history.set(key(s, card), entry);
      }
      if (entry.looks >= PROGRAM_CARD_TESTS_PER_TURN) return { ok: false, error: "look_limit" };
      entry.requirements = withAddedRequirements(entry.requirements, input.requirements);
      entry.looks++;
      entry.charged = true;
      entry.lookStart = clone(input.start);
      return { ok: true, payload: { ...input, requirements: entry.requirements,
        ...(input.steps ? {} : entry.plan ? { steps: entry.plan } : {}),
        ...(input.verdicts ? { verdicts: accepted.verdicts } : {}), cardId: card } };
    },
    complete(s        , card        , report     , delivery      = {}, requestId         ) {
      const entry = get(s, card);
      const previous = entry.last;
      const withoutPixels = lookReportWithoutPixels(report);
      const plan = report.plan ?? report.steps.map((step     ) => ({ do: step.do, ...(step.say ? { say: step.say } : {}),
        ...(step.watch !== undefined ? { watch: step.watch } : {}), ...(step.snap ? { snap: step.snap } : {}),
        ...(step.expect ? { expect: step.expect } : {}), ...(step.times !== undefined ? { times: step.times } : {}),
        ...(step.every !== undefined ? { every: step.every } : {}) }));

      if (plan.length) {
        entry.plan = plan;
        entry.planMode = "plain";
        entry.planStart = undefined;
      }

      noteProgramCardTestFindings(entry.open, withoutPixels, plan, entry.lookStart);
      entry.last = withoutPixels;
      entry.lastBatch = withoutPixels;
      entry.delivery = delivery;
      entry.receiptRequestId = requestId;
      const notCounted = delivery?.ok === false && programCardTestCouldNotRun(delivery.error) && giveBack(entry);
      const untested = entry.requirements.filter((r        ) => !entry.verdicts.has(r));
      return { looks: entry.looks, ...(notCounted ? { notCounted: true } : {}), requirements: entry.requirements, verdicts: Array.from(entry.verdicts.values()), tests: tests(entry),
        ...(previous ? { diff: compareLookReports(previous, withoutPixels, untested) } : {}) };
    },
    reserveDrive(s        , card        , input     )      {
      const accepted = lookVerdicts(s, card, input);
      if (!accepted.ok) return accepted;
      let entry = get(s, card);
      if (!entry) {
        if (history.size >= MAX_RECORDS) return { ok: false, error: "look_capacity" };
        entry = { session: sessionKey(s), card, looks: 0, returned: 0, charged: false, requirements: [], verdicts: new Map(), failed: new Set(), last: null,
          lastBatch: null, plan: null, planMode: null, planStart: undefined, driveStart: undefined,
          drivePrevious: null, driveReport: null, open: new Map(), lookStart: undefined };
        history.set(key(s, card), entry);
      }
      if (entry.looks >= PROGRAM_CARD_TESTS_PER_TURN) return { ok: false, error: "look_limit" };
      entry.requirements = withAddedRequirements(entry.requirements, input.requirements);
      entry.looks++;
      entry.charged = true;
      entry.drivePrevious = entry.last;
      entry.driveReport = null;
      entry.driveStart = clone(input.start);
      return { ok: true, payload: { ...input, requirements: entry.requirements,
        ...(input.verdicts ? { verdicts: accepted.verdicts } : {}) } };
    },
    continueDrive(s        , card        , input     )      {
      const entry = get(s, card);
      if (!entry) return { ok: false, error: "drive_history_not_found" };
      const accepted = lookVerdicts(s, card, input);
      if (!accepted.ok) return accepted;
      return { ok: true, payload: { ...input, requirements: entry.requirements,
        ...(input.verdicts ? { verdicts: accepted.verdicts } : {}) } };
    },
    completeDrive(s        , card        , batch     , replayPlan     , delivery      = {}, requestId         ) {
      const entry = get(s, card);
      if (!entry) return { ok: false, error: "drive_history_not_found" };
      const previousBatch = entry.driveReport;
      const offset = previousBatch?.steps?.length ?? 0;
      if (!Array.isArray(replayPlan?.steps) || replayPlan.steps.length !== offset + batch.steps.length) {
        return { ok: false, error: "drive_plan_changed" };
      }
      if (JSON.stringify(replayPlan.start ?? null) !== JSON.stringify(entry.driveStart ?? null)) {
        return { ok: false, error: "drive_start_changed" };
      }
      const shifted = (value     ) => Number.isInteger(value?.step) ? { ...value, step: value.step + offset } : { ...value };
      const batchWithoutPixels = lookReportWithoutPixels(batch);
      const aggregate = {
        ...batchWithoutPixels,
        plan: replayPlan.steps,
        planHash: replayPlan.planHash,
        steps: [...(previousBatch?.steps ?? []), ...batchWithoutPixels.steps.map((step     ) => ({ ...step, index: step.index + offset }))],
        problems: [...(previousBatch?.problems ?? []), ...batchWithoutPixels.problems.map(shifted)],
        pictures: [...(previousBatch?.pictures ?? []), ...batchWithoutPixels.pictures.map(shifted)],
        phoneSamples: [...(previousBatch?.phoneSamples ?? []), ...(batchWithoutPixels.phoneSamples ?? [])].slice(0, 24),
        wallMs: (previousBatch?.wallMs ?? 0) + (batchWithoutPixels.wallMs ?? 0),
        frames: (previousBatch?.frames ?? 0) + (batchWithoutPixels.frames ?? 0),
      };
      noteProgramCardTestFindings(entry.open, aggregate, replayPlan.steps, entry.driveStart);
      entry.driveReport = aggregate;
      entry.last = aggregate;
      entry.lastBatch = batchWithoutPixels;
      entry.plan = replayPlan.steps;
      entry.planMode = "drive";
      entry.planStart = clone(entry.driveStart);
      entry.delivery = delivery;
      entry.receiptRequestId = requestId;
      const untested = entry.requirements.filter((r        ) => !entry.verdicts.has(r));
      return { ok: true, looks: entry.looks, requirements: entry.requirements, verdicts: Array.from(entry.verdicts.values()), tests: tests(entry),
        ...(entry.drivePrevious ? { diff: compareLookReports(entry.drivePrevious, aggregate, untested) } : {}), report: aggregate };
    },
    completeDriveFailure(s        , card        , batch     , delivery      = {}, requestId         ) {
      const entry = get(s, card);
      if (!entry) return { ok: false, error: "drive_history_not_found" };
      const previousBatch = entry.driveReport;
      const offset = previousBatch?.steps?.length ?? 0;
      const batchWithoutPixels = lookReportWithoutPixels(batch);
      const completedPlan = batchWithoutPixels.steps.map((step     , index        ) =>
        batchWithoutPixels.plan?.[Number.isInteger(step.index) ? step.index : index]);
      if (completedPlan.some((step     ) => !step)) return { ok: false, error: "drive_plan_changed" };
      const retainedPlan = [...(previousBatch?.plan ?? []), ...clone(completedPlan)];
      const shifted = (value     ) => Number.isInteger(value?.step) ? { ...value, step: value.step + offset } : { ...value };
      const aggregate = {
        ...batchWithoutPixels,
        ok: false,
        plan: retainedPlan,
        planHash: createHash("sha256").update(JSON.stringify(retainedPlan), "utf8").digest("hex").slice(0, 32),
        steps: [...(previousBatch?.steps ?? []), ...batchWithoutPixels.steps.map((step     ) => ({ ...step, index: step.index + offset }))],
        problems: [...(previousBatch?.problems ?? []), ...batchWithoutPixels.problems.map(shifted)],
        pictures: [...(previousBatch?.pictures ?? []), ...batchWithoutPixels.pictures.map(shifted)],
        phoneSamples: [...(previousBatch?.phoneSamples ?? []), ...(batchWithoutPixels.phoneSamples ?? [])].slice(0, 24),
        wallMs: (previousBatch?.wallMs ?? 0) + (batchWithoutPixels.wallMs ?? 0),
        frames: (previousBatch?.frames ?? 0) + (batchWithoutPixels.frames ?? 0),
      };
      noteProgramCardTestFindings(entry.open, aggregate, retainedPlan, entry.driveStart);
      entry.driveReport = aggregate;
      entry.last = aggregate;
      entry.lastBatch = batchWithoutPixels;
      entry.plan = retainedPlan;
      entry.planMode = "drive";
      entry.planStart = clone(entry.driveStart);
      entry.delivery = delivery;
      entry.receiptRequestId = requestId;
      const notCounted = programCardTestCouldNotRun(delivery?.error) && giveBack(entry);
      const untested = entry.requirements.filter((r        ) => !entry.verdicts.has(r));
      return { ok: true, looks: entry.looks, ...(notCounted ? { notCounted: true } : {}), requirements: entry.requirements, verdicts: Array.from(entry.verdicts.values()), tests: tests(entry),
        ...(entry.drivePrevious ? { diff: compareLookReports(entry.drivePrevious, aggregate, untested) } : {}), report: aggregate };
    },

    completeSplit(s        , card        , report     , plan       ) {
      const entry = get(s, card);
      if (!entry) return { ok: false, error: "drive_history_not_found" };
      const withoutPixels = lookReportWithoutPixels(report);

      noteProgramCardTestFindings(entry.open, withoutPixels, plan, entry.driveStart);
      entry.last = withoutPixels;
      entry.lastBatch = withoutPixels;
      entry.driveReport = null;
      entry.plan = clone(plan);
      entry.planMode = "plain";
      entry.planStart = undefined;
      const untested = entry.requirements.filter((r        ) => !entry.verdicts.has(r));
      return { ok: true, looks: entry.looks, requirements: entry.requirements, verdicts: Array.from(entry.verdicts.values()), tests: tests(entry),
        ...(entry.drivePrevious ? { diff: compareLookReports(entry.drivePrevious, withoutPixels, untested) } : {}) };
    },

    recordVerdictReport(s        , card        , report     ) {
      const entry = get(s, card);
      if (entry) entry.lastBatch = lookReportWithoutPixels(report);
    },
    recordVerdicts: verdicts,

    notCounted(s        , card        )          {
      const entry = get(s, card);
      return !!entry && giveBack(entry);
    },

    testsLeft(s        , card        )         { return Math.max(0, PROGRAM_CARD_TESTS_PER_TURN - (get(s, card)?.looks ?? 0)); },
    recordDelivery(s        , card        , delivery     ) {
      const entry = get(s, card);
      if (entry?.last) entry.delivery = delivery;
    },
    receiptRequestId(s        , card        ) { return get(s, card)?.receiptRequestId; },

    sentPictures(s        , card        )           { return Array.from(get(s, card)?.sentPictures ?? []); },
    recordSentPictures(s        , card        , hashes          ) {
      const entry = get(s, card);
      if (entry) entry.sentPictures = new Set([...(entry.sentPictures ?? []), ...hashes]);
    },
    plan(s        , card        ) { return clone(get(s, card)?.plan ?? null); },

    openFindings(s        , card        )        { return programCardOpenFindingRows(get(s, card)?.open); },
    replay(s        , card        ) {
      const entry = get(s, card);
      if (!Array.isArray(entry?.plan)) return null;
      return clone({ mode: entry.planMode === "drive" ? "drive" : "plain", steps: entry.plan,
        ...(entry.planMode === "drive" && entry.planStart !== undefined ? { start: entry.planStart } : {}) });
    },
    snapshot(s        , card        ) {
      const entry = get(s, card);
      if (!entry?.last) return null;
      const snapshot = { looks: entry.looks, requirements: entry.requirements, verdicts: Array.from(entry.verdicts.values()), tests: tests(entry), report: entry.last, ...entry.delivery };
      return entry.planMode === "drive" ? { ...snapshot, drive: true } : snapshot;
    },
    clear(s         ) { for (const [k, entry] of history) if (s === undefined || entry.session === sessionKey(s)) history.delete(k); },
  };
}

function programCardImageModel(config     , context      = {}, hostInput                                           ) {
  const active = context.activeModel ?? context;
  const providerHint = active.provider ?? active.modelProviderId;
  const rawRef = active.modelId ?? active.modelRef ?? (typeof active.model === "string" ? active.model : null);
  const ref = typeof rawRef === "string" ? rawRef : "";
  const provider = typeof providerHint === "string" ? providerHint : ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : "";
  const prefix = ref.slice(0, ref.indexOf("/"));
  const model = provider && ref.includes("/") && prefix.toLowerCase() === provider.toLowerCase() ? ref.slice(prefix.length + 1) : ref;
  const providers = config?.models?.providers ?? {};

  const matches = provider ? Object.keys(providers).filter(key => key.toLowerCase() === provider.toLowerCase()) : [];
  const providerKey = !provider ? undefined : Object.prototype.hasOwnProperty.call(providers, provider) ? provider : matches.length === 1 ? matches[0] : undefined;
  const models = providerKey === undefined ? undefined : providers[providerKey]?.models;
  const configured = Array.isArray(models) ? models.find((m     ) => m?.id === model) : undefined;
  const name = provider && model ? `${provider}/${model}` : "unknown";
  if (Array.isArray(configured?.input)) return { host: "openclaw", model: name, input: configured.input, inputSource: "config" };

  if (configured !== undefined && configured !== null) return { host: "openclaw", model: name, input: [], inputSource: "config" };

  const askable = provider && model && typeof hostInput === "function" && (providerKey !== undefined || matches.length === 0);
  let declared      = null;
  if (askable) { try { declared = hostInput(provider, model); } catch {  } }
  return Array.isArray(declared) ? { host: "openclaw", model: name, input: declared.filter((kind     ) => typeof kind === "string"), inputSource: "host_catalog" }
    : { host: "openclaw", model: name, input: [], inputSource: "none" };
}

function lookToolPictures(report     , model     ) {
  const supported = Array.isArray(model?.input) && model.input.includes("image");
  const images = supported ? (report.pictures ?? []).map((picture     ) => ({ type: "image", data: picture.png, mimeType: "image/png" })) : [];
  const picturesReason = !supported ? `pictures not delivered: ${model?.model ?? "configured model"} input does not include image`
    : !images.length ? "pictures not delivered: the phone returned no pictures" : null;
  return { images, picturesDelivered: images.length > 0, picturesReason };
}

function validateProgramCardCapture(value     , expectedCardId        )      {
  try {
    if (!record(value)) return { ok: false, error: "invalid_capture_receipt" };
    if (bytes(value) > PROGRAM_CARD_LOOK_MAX_BYTES) return { ok: false, error: "look_payload_too_large" };
    if (!["complete", "partial", "superseded", "card_changed"].includes(value.status) || value.label !== "accepted by the glasses SDK") return { ok: false, error: "invalid_capture_receipt" };
    if (["requestedSeq", "currentSeq", "requestedVersion", "currentVersion"].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
      (value.frameVersion !== undefined && (!Number.isSafeInteger(value.frameVersion) || value.frameVersion < 0)) ||
      (value.status !== "card_changed" && value.frameVersion === undefined)) return { ok: false, error: "invalid_capture_version" };
    const identity = (card     ) => record(card) && typeof card.cardId === "string" && card.cardId.length > 0 && card.cardId.length <= 80 &&
      typeof card.instance === "string" && card.instance.length > 0 && card.instance.length <= 160 && Number.isSafeInteger(card.revision) && card.revision >= 0;
    if (!identity(value.requestedCard) || (value.currentCard !== null && !identity(value.currentCard)) || value.requestedCard.cardId !== expectedCardId) return { ok: false, error: "card_changed" };
    const sameCard = value.currentCard && value.requestedCard.cardId === value.currentCard.cardId &&
      value.requestedCard.instance === value.currentCard.instance && value.requestedCard.revision === value.currentCard.revision;
    if (value.status !== "card_changed" && !sameCard) return { ok: false, error: "card_changed" };
    const behind = value.behind ?? [];
    if (!Array.isArray(behind) || behind.length > 64 || behind.some((name     ) => typeof name !== "string" || name.length > 120)) return { ok: false, error: "invalid_capture_receipt" };
    for (const key of ["drained", "pendingCard", "pendingCodeEdit", "waitedForCard"]) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") return { ok: false, error: "invalid_capture_receipt" };
    }
    if (value.startedVersion !== undefined && (!Number.isSafeInteger(value.startedVersion) || value.startedVersion < 0)) return { ok: false, error: "invalid_capture_version" };
    if (value.status === "complete" && (value.requestedSeq !== value.currentSeq || value.requestedVersion !== value.currentVersion ||
      value.frameVersion !== value.requestedVersion || behind.length || value.drained === false || value.pendingCard || value.pendingCodeEdit)) return { ok: false, error: "invalid_capture_complete" };
    const pictures = value.pictures ?? [];
    if (!Array.isArray(pictures) || pictures.length > 1 || (value.status === "card_changed" && pictures.length)) return { ok: false, error: "invalid_capture_pictures" };
    for (const picture of pictures) if (!record(picture) || picture.step !== 0 || picture.after !== "all" || picture.width !== 1152 || picture.height !== 576 ||
      !/^[a-f0-9]{64}$/.test(picture.hash) || !isPngBase64(picture.png)) return { ok: false, error: "invalid_capture_picture" };
    const capture      = { status: value.status, label: "accepted by the glasses SDK", requestedSeq: value.requestedSeq, currentSeq: value.currentSeq,
      requestedVersion: value.requestedVersion, currentVersion: value.currentVersion,
      requestedCard: { cardId: value.requestedCard.cardId, instance: value.requestedCard.instance, revision: value.requestedCard.revision },
      currentCard: value.currentCard ? { cardId: value.currentCard.cardId, instance: value.currentCard.instance, revision: value.currentCard.revision } : null,
      ...(value.frameVersion !== undefined ? { frameVersion: value.frameVersion } : {}),
      pictures: pictures.map((picture     ) => ({ step: 0, after: "all", png: picture.png, hash: picture.hash, width: 1152, height: 576 })),
    };
    for (const key of ["behind", "drained", "pendingCard", "pendingCodeEdit", "waitedForCard", "startedVersion"]) if (value[key] !== undefined) capture[key] = value[key];
    if (typeof value.picturesReason === "string") capture.picturesReason = value.picturesReason.slice(0, 300);
    return { ok: true, capture };
  } catch { return { ok: false, error: "invalid_capture_receipt" }; }
}

function lookToolImageContent(report     , images       ) {
  return images.flatMap((image     , index        ) => {
    const { step, after, hash } = report.pictures[index];
    return [{ type: "text", text: `Card picture (canonical 1x mirror): ${JSON.stringify({ step, after, hash: hash ?? null })}` }, image];
  });
}

const LOOK_MODEL_COMPACT_NOTE = "controls and commands are listed once at the top. Each step's controls and commands are same (as the step before) or what changed: changed (id, label and changed fields), added, removed (ids), or all. A step's state is whole when the step before had none; otherwise it is same, or only the top-level keys that changed, with their new values (null when a key went away). problems are listed once, with the steps where they occur.";
const LOOK_PICTURES_UNCHANGED_NOTE = "Not sent again: each picture in picturesUnchanged has the same hash as one already sent for this card this turn.";
const same = (a     , b     ) => JSON.stringify(a) === JSON.stringify(b);

const commandKey = (command     ) => JSON.stringify([command?.id, command?.args ?? null]);
const controlKey = (control     ) => typeof control?.id === "string" ? control.id : JSON.stringify(control);
const STEP_TELEMETRY = new Set(["problems", "lz4", "frameStages", "stagesMedian"]);

function listDelta(before       , after       , keyOf                        ) {
  if (same(before, after)) return { same: true };
  const old = new Map(before.map(value => [keyOf(value), value]));
  const now = new Map(after.map(value => [keyOf(value), value]));
  if (old.size !== before.length || now.size !== after.length) return { all: after };
  const changed        = [], added        = [], removed        = [];
  for (const value of after) {
    const previous = old.get(keyOf(value));
    if (!previous) { added.push(value); continue; }
    if (same(previous, value)) continue;
    const fields      = { id: value.id, ...(value.args !== undefined ? { args: value.args } : {}), label: value.label ?? null };
    for (const key of new Set([...Object.keys(previous), ...Object.keys(value)])) {
      if (!same(previous[key], value[key])) fields[key] = value[key] ?? null;
    }
    changed.push(fields);
  }
  for (const [key, value] of old) if (!now.has(key)) removed.push(value?.id ?? key);
  const delta = { ...(changed.length ? { changed } : {}), ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) };

  return !Object.keys(delta).length || bytes(delta) >= bytes(after) ? { all: after } : delta;
}

function stateDelta(before     , after     ) {
  if (same(before, after)) return { same: true };
  const delta      = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[key], after[key])) delta[key] = after[key] ?? null;
  }
  return delta;
}

function problemsOnce(report     ) {
  const grouped = new Map             ();
  const add = (problem     , step     ) => {
    if (!record(problem) || isRetiredLookProblem(problem)) return;
    const { step: _step, ...rest } = problem;
    const key = JSON.stringify(rest);
    const entry = grouped.get(key) ?? { ...rest, steps: [] };
    const at = Number.isInteger(step) ? step : problem.step;
    if (Number.isInteger(at) && !entry.steps.includes(at)) entry.steps.push(at);
    grouped.set(key, entry);
  };
  for (const step of report.steps) for (const problem of Array.isArray(step?.problems) ? step.problems : []) add(problem, step.index);
  for (const problem of Array.isArray(report.problems) ? report.problems : []) add(problem, undefined);
  const coverage = report.coverage;
  return Array.from(grouped.values(), (problem     ) => {
    problem.steps.sort((a        , b        ) => a - b);

    if (problem.code === "controls_unreached" && Array.isArray(coverage?.unreached) && same(problem.controls, coverage.unreached)) {
      const { controls: _controls, ...rest } = problem;
      return rest;
    }
    if (problem.code === "pages_unreached" && Array.isArray(coverage?.unreachedPages) && same(problem.pages, coverage.unreachedPages)) {
      const { pages: _pages, ...rest } = problem;
      return rest;
    }
    return problem;
  });
}

const LOOK_STATE_UNSAVEABLE = "state_unsaveable";
function lookStateLimitProblem(report     ) {
  if (!record(report) || !Array.isArray(report.steps)) return null;
  let most = -1;
  const steps           = [];
  for (const step of report.steps) {
    if (!record(step) || !("state" in step)) continue;
    const n = programCardStateBytes(step.state);
    if (n <= PROGRAM_CARD_STATE_MAX_BYTES) continue;
    most = Math.max(most, n);
    if (Number.isInteger(step.index)) steps.push(step.index);
  }
  if (most < 0) return null;
  return { code: LOOK_STATE_UNSAVEABLE, path: "/state", severity: "advice", bytes: most, limit: PROGRAM_CARD_STATE_MAX_BYTES,
    message: `State is ${most} bytes of JSON in UTF-8; the Library keeps ${PROGRAM_CARD_STATE_MAX_BYTES / 1024} KB at most, so Save card, save slots and checkpoints refuse it. Keep less in state.`,
    steps };
}

function withLookStateLimitProblem(report     , problems       ) {
  const over = lookStateLimitProblem(report);
  return over ? [...problems.filter((problem     ) => problem?.code !== LOOK_STATE_UNSAVEABLE), over] : problems;
}

function lookReportForModel(report     ) {
  if (!record(report) || !Array.isArray(report.steps)) return report;

  const { phoneSamples: _samples, frames: _frames, setupMs: _setupMs, steps: _steps, problems: _problems, frameLayout: _frameLayout, ...rest } = report;
  const firstControls = report.steps.find((step     ) => Array.isArray(step?.controls))?.controls;
  const firstCommands = report.steps.find((step     ) => Array.isArray(step?.commands))?.commands;
  let controls = firstControls, commands = firstCommands, state      = undefined;
  const steps = report.steps.map((step     ) => {
    if (!record(step)) return step;
    const out      = {};
    for (const [key, value] of Object.entries(step)) if (!STEP_TELEMETRY.has(key)) out[key] = value;
    if (Array.isArray(step.controls)) { out.controls = listDelta(controls, step.controls, controlKey); controls = step.controls; }
    if (Array.isArray(step.commands)) { out.commands = listDelta(commands, step.commands, commandKey); commands = step.commands; }

    if (record(step.state)) {
      if (record(state)) out.state = stateDelta(state, step.state);
      state = step.state;
    } else if ("state" in step) state = undefined;
    return out;
  });
  return { compact: LOOK_MODEL_COMPACT_NOTE, ...rest,
    ...(firstControls ? { controls: firstControls } : {}), ...(firstCommands ? { commands: firstCommands } : {}),
    steps, problems: withLookStateLimitProblem(report, problemsOnce(report)) };
}

const problemIdentity = (problem     ) => record(problem)
  ? Object.fromEntries(["code", "path", "id"].filter(key => problem[key] !== undefined).map(key => [key, problem[key]]))
  : problem;

function lookResultForModel(result     )      {
  if (!record(result)) return result;
  const out      = { ...result };
  if (record(result.report) && Array.isArray(result.report.steps)) out.report = lookReportForModel(result.report);
  if (record(result.diff) && out.report !== result.report) {

    const listed = new Set(out.report.problems.map((problem     ) => lookProblemKey(problem)));
    const named = (problems       ) => problems.map(problem => record(problem) && listed.has(lookProblemKey(problem)) ? problemIdentity(problem) : problem);
    out.diff = { ...result.diff,
      ...(Array.isArray(result.diff.fixed) ? { fixed: withoutRetiredLookProblems(result.diff.fixed) } : {}),
      ...(Array.isArray(result.diff.new) ? { new: named(withoutRetiredLookProblems(result.diff.new)) } : {}),
      ...(Array.isArray(result.diff.stillThere) ? { stillThere: named(withoutRetiredLookProblems(result.diff.stillThere)) } : {}) };
  }
  if (record(result.tested)) out.tested = lookResultForModel(result.tested);
  return out;
}

function lookPicturesNotYetSent(report     , images       , sent                   = []) {
  const seen = new Set(sent);
  const kept        = [], pictures        = [], unchanged        = [];
  (report?.pictures ?? []).forEach((picture     , index        ) => {
    const image = images[index];
    if (!image) return;
    const { png: _png, ...ref } = picture;
    const hash = typeof picture.hash === "string" && picture.hash ? picture.hash : null;
    if (hash && seen.has(hash)) { unchanged.push({ step: picture.step, after: picture.after, hash }); return; }
    if (hash) seen.add(hash);
    kept.push(image);
    pictures.push(ref);
  });
  return { images: kept, pictures, unchanged, sent: Array.from(seen) };
}

module.exports = { PROGRAM_CARD_LOOK_CAPABILITY, PROGRAM_CARD_LOOK_PLAY_CAPABILITY, PROGRAM_CARD_LOOK_PLAY_UNSUPPORTED, PROGRAM_CARD_LOOK_PLAY_RUN_CAPABILITY, PROGRAM_CARD_LOOK_PLAY_RUN_UNSUPPORTED, PROGRAM_CARD_LOOK_PLAY_MAX_S, isPlayStep, PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY, PROGRAM_CARD_FIRMWARE_TEXT_CAPABILITY, LOOK_GLASSES_CARD_TOOL_NAME, PROGRAM_CARD_LOOK_TIMEOUT_MS, PROGRAM_CARD_LOOK_GAME_LIVE_S, PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS, withGameLive, PROGRAM_CARD_LOOK_MAX_BYTES, PROGRAM_CARD_LOOK_RESULT_MAX_BYTES, PROGRAM_CARD_SPECK_PROPERTY, lookGlassesCardParametersSchema, PROGRAM_CARD_PLAY_HINTS, withoutPlayHints, PROGRAM_CARD_LOOK_EVERY_MAX_S, PROGRAM_CARD_LOOK_EVERY_TOTAL_S, normalizeLookInput, validateLookInput, PROGRAM_CARD_LOOK_CASES_CAPABILITY, PROGRAM_CARD_LOOK_CASES, PROGRAM_CARD_LOOK_CASE_KINDS, PROGRAM_CARD_LOOK_CASES_HOST_MS, PROGRAM_CARD_LOOK_CASES_MAX_BYTES, validateLookCases, lookCasesDebug, validateLookReport, lookReportWithoutPixels, compareLookReports, projectProgramCardLookDriveReceipt, isWearerOnlyLine, programCardLineVerdict, matchLookRequirement, PROGRAM_CARD_TESTS_PER_TURN, PROGRAM_CARD_TESTS_GIVEN_BACK_PER_TURN, programCardTestCouldNotRun, createProgramCardLookHistory, programCardImageModel, lookToolPictures, validateProgramCardCapture, lookToolImageContent, LOOK_MODEL_COMPACT_NOTE, LOOK_PICTURES_UNCHANGED_NOTE, LOOK_STATE_UNSAVEABLE, lookStateLimitProblem, withLookStateLimitProblem, lookReportForModel, lookResultForModel, lookPicturesNotYetSent };
