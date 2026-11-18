const { TASK_USES_NOT_ALLOWED, createTaskHeldPolicy, createTaskUsesPolicy, createTaskUsesStore, taskUsesForPhone } = require("./glasses-ui-task-uses.cjs");
const { validateTaskSchedulePlan } = require("./glasses-ui-task-schedule.cjs");
const { fitTaskValues } = require("./glasses-ui-task-fit.cjs");
const { TASK_PRESENTATION_DATA_MAX } = require("./glasses-ui-task-presentation.cjs");
const { LIVEUI_INPUT_KEY_RE, validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");

const TASK_TEST_RESULT_FRAME = "ocuclaw.task.test.result";

const TASK_TEST_CAPABILITY = "taskTestRunV1";

const LINK_TASK_TEST_RESULT_METHOD = "task.test.result";

const TASK_TEST_PASSES_MAX = 3;

const TASK_TEST_WAIT_MS = 10 * 60 * 1000;

const TASK_TEST_KEEP_MS = 60 * 60 * 1000;
const TASK_TEST_MAX = 8;

const TASK_TEST_CLOSED_KEEP_MS = 24 * 60 * 60 * 1000;
const TASK_TEST_CLOSED_MAX = 256;
const TASK_TEST_ACTIONS = new Set(["uses_allow", "uses_keep_off", "uses_undo"]);

const TEST_ID_RE = /^[a-z0-9]{8,40}$/;
const HEADLINE_MAX = 200;
const BODY_MAX = 4000;

function isPlainObject(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const hasText = (value     ) => typeof value === "string" && value.trim().length > 0;

function cut(value     , max        ) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

const TASK_TEST_CARD_VALUES_MAX = 8;

function scalarType(value     ) {
  if (typeof value === "string") return "text";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "bool";
  return null;
}

function inputOf(key        , value     ) {
  if (value === null) return { key, type: "text" };
  const scalar = scalarType(value);
  if (scalar) return { key, type: scalar };
  if (!Array.isArray(value)) return null;
  const rows = value.filter((row) => row !== null && row !== undefined);
  if (rows.length === 0) return { key, type: "list", of: "text" };
  if (rows.every(isPlainObject)) {
    const fields                         = {};
    for (const row of rows) {
      for (const [name, field] of Object.entries(row)) {
        const type = scalarType(field);
        if (!type || !LIVEUI_INPUT_KEY_RE.test(name) || name in fields) continue;
        if (Object.keys(fields).length >= 16) break;
        fields[name] = type;
      }
    }
    return Object.keys(fields).length ? { key, type: "list", fields } : null;
  }
  const types = new Set(rows.map(scalarType));
  return types.size === 1 && !types.has(null) ? { key, type: "list", of: [...types][0] } : null;
}

function taskTestCard(given     , atMs        , pinned               = null) {
  if (!isPlainObject(given)) return null;
  const raw = flatTestValues(given);

  if (pinned) {
    const fitted      = fitTaskValues(pinned, raw, { budgetBytes: TASK_PRESENTATION_DATA_MAX });

    return fitted.status === "fitted" ? { inputs: pinned, values: fitted.values, atMs,
      ...(fitted.missing.length ? { missing: fitted.missing } : {}), ...(fitted.unfit.length ? { unfit: fitted.unfit } : {}) } : null;
  }
  const inputs        = [];
  for (const [key, value] of Object.entries(raw)) {
    if (inputs.length >= TASK_TEST_CARD_VALUES_MAX) break;

    if (!LIVEUI_INPUT_KEY_RE.test(key) || key === "error") continue;
    const input = inputOf(key, value);
    if (input) inputs.push(input);
  }
  if (inputs.length === 0) return null;
  const checked      = validateLiveUiInputs(inputs);
  if (!checked.ok) return null;
  const fit      = fitTaskValues(checked.inputs, raw, { budgetBytes: TASK_PRESENTATION_DATA_MAX });
  if (fit.status !== "fitted") return null;
  return { inputs: checked.inputs, values: fit.values, atMs };
}

function flatTestValues(raw     ) {
  const flat      = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) {
      if (!Object.hasOwn(flat, key)) flat[key] = value;
      continue;
    }
    for (const [part, inner] of Object.entries(value       )) {
      const named = `${key}_${part}`;
      if (!isPlainObject(inner) && !Object.hasOwn(flat, named)) flat[named] = inner;
    }
  }
  return flat;
}

function pinnedCardInputs(card     , keys     ) {
  if (!card || !Array.isArray(card.inputs) || !Array.isArray(keys) || keys.length !== card.inputs.length) return null;
  return card.inputs.every((input     , i        ) => input.key === keys[i]) ? card.inputs : null;
}

function taskTestTaskId(testId        ) {
  return `test-${testId}`;
}

function createLiveuiTaskTests(deps      = {}) {
  const enabled = typeof deps.enabled === "function" ? deps.enabled : () => false;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const setTimer = typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
  const clearTimer = typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
  const send = typeof deps.send === "function" ? deps.send : () => false;
  const logger = deps.logger || null;

  const starterCheck = deps.starterCheck && typeof deps.starterCheck.start === "function" &&
    typeof deps.starterCheck.verdict === "function" ? deps.starterCheck : null;
  const memory = new Map             ();
  const store = createTaskUsesStore({ memory, now });
  const tests = new Map             ();
  const byJob = new Map                ();
  const glassesTools = deps.glassesTools instanceof Set ? deps.glassesTools : new Set        ();

  const closedJobs = new Map                                          ();

  const launching = new Map                ();
  let launchSeq = 0;

  const closedPolicy = createTaskHeldPolicy({
    logger, glassesTools, tag: "[task-test]", label: "closed test job", why: "test_closed",
    reason: `${TASK_USES_NOT_ALLOWED}: this test run was stopped, so OcuClaw skipped this step. Finish now without it.`,
  });

  function closeJob(jobId        , taskId        ) {
    closedJobs.delete(jobId);
    closedJobs.set(jobId, { taskId, atMs: now() });
    const cutoff = now() - TASK_TEST_CLOSED_KEEP_MS;
    for (const [id, closed] of closedJobs) {
      if (closedJobs.size > TASK_TEST_CLOSED_MAX || closed.atMs < cutoff) closedJobs.delete(id);
      else break;
    }
  }

  const policy = createTaskUsesPolicy({
    store,
    logger,
    glassesTools,

    onNeeds: (taskId        , step     ) => {
      const test = testOfTaskId(taskId);
      if (!test) return;
      const key = Array.isArray(step?.keys) ? step.keys.join("+") : "";
      const need = store.read(taskId)?.needs.find((entry     ) => entry.key === key);
      if (need) test.asked.set(key, need);
    },
  });

  function testOfTaskId(taskId     ) {
    if (typeof taskId !== "string" || !taskId.startsWith("test-")) return null;
    return tests.get(taskId.slice(5)) || null;
  }

  function frame(test     , requestId     , extra      = {}) {
    const out      = {
      type: TASK_TEST_RESULT_FRAME,
      v: 1,
      ...(hasText(requestId) ? { requestId } : {}),
      testId: test.testId,
      pass: test.passes,
      passesLeft: Math.max(0, TASK_TEST_PASSES_MAX - test.passes),
      status: test.status,
      uses: taskUsesForPhone(store.read(test.taskId)),
      ...(test.startedAtMs ? { startedAtMs: test.startedAtMs } : {}),
      ...(test.endedAtMs ? { endedAtMs: test.endedAtMs } : {}),
      ...(test.answer ? { answer: test.answer } : {}),
      ...(test.card ? { card: test.card } : {}),
      ...(test.code ? { code: test.code } : {}),

      ...(test.starterFit ? { starterFit: test.starterFit } : {}),
      ...extra,
    };
    return out;
  }

  function tell(test     , requestId      = null) {
    try {
      send(test.clientId, frame(test, requestId));
    } catch (err     ) {
      logger?.warn?.(`[task-test] could not send a test frame: ${err?.message || err}`);
    }
  }

  function rejectedFrame(testId     , requestId     , code        ) {
    return {
      type: TASK_TEST_RESULT_FRAME,
      v: 1,
      ...(hasText(requestId) ? { requestId } : {}),
      testId: typeof testId === "string" ? testId : "",
      pass: 0,
      passesLeft: 0,
      status: "rejected",
      code,
      uses: taskUsesForPhone(null),
    };
  }

  function clearWait(test     ) {
    if (test.timer) clearTimer(test.timer);
    test.timer = null;
  }

  async function endJob(test     , answered = false) {
    const jobId = test.jobId;
    if (!jobId) return;
    test.jobId = null;
    if (!answered) closeJob(jobId, test.taskId);
    byJob.delete(jobId);
    await removeHostJob(test, jobId);
  }

  async function removeHostJob(test     , jobId        ) {
    try {
      const scheduler = deps.scheduler();
      await scheduler?.testEnd?.(test.taskId, jobId, test.profileId);
    } catch (err     ) {
      logger?.warn?.(`[task-test] could not remove test job ${jobId}: ${err?.message || err}`);
    }
  }

  function forget(test     ) {
    clearWait(test);

    if (test.launch) test.launch.cancelled = true;
    tests.delete(test.testId);
    store.clear(test.taskId);
    void endJob(test);
  }

  function sweep() {
    const cutoff = now() - TASK_TEST_KEEP_MS;
    for (const test of [...tests.values()]) {
      if (test.status !== "running" && !test.launch && test.touchedAtMs < cutoff) forget(test);
    }
  }

  function refusal(test     , requestId     ) {
    if (test && (test.status === "running" || test.launch)) return frame(test, requestId, { status: "rejected", code: "test_busy" });
    if (test && test.passes >= TASK_TEST_PASSES_MAX) return frame(test, requestId, { status: "rejected", code: "test_cap" });
    return null;
  }

  async function prepare(input     , profileId        , scheduler     , starterCard      = null) {
    if (!isPlainObject(input) || !hasText(input.name)) return { code: "task_name_invalid" };
    if (input.kind !== "brief") return { code: "test_kind" };

    const plan      = validateTaskSchedulePlan({
      when: input.when === undefined ? null : input.when,
      kind: input.kind,
      ...(input.starter ? { starter: input.starter } : {}),
      ...(input.look && !starterCard ? { look: input.look } : {}),
    });
    if (plan.status !== "accepted") return { code: plan.code || "task_plan_invalid" };
    let request = hasText(input.request) ? input.request.trim() : "";
    if (plan.plan.starter) {
      const filled      = await scheduler.fillStarter(plan.plan.starter, profileId);
      if (!filled || filled.status !== "ok") return { code: `task_starter_${(filled && filled.code) || "failed"}` };
      request = filled.starter.prompt;
    }
    if (!request) return { code: "task_request_invalid" };

    if (starterCard) {
      const asked = request.trimEnd();
      if (asked !== starterCard.prompt && !asked.endsWith(`\n${starterCard.prompt}`)) return { code: "starter_card_changed" };
      return { plan: plan.plan, request, name: input.name.trim().slice(0, 120), openCard: true };
    }

    const openCard = input.openCard === true && plan.plan.look?.kind !== "template";
    return { plan: plan.plan, request, name: input.name.trim().slice(0, 120), openCard };
  }

  async function run(clientId     , requestId     , testId     , input     , context      = {}) {
    if (!enabled()) return rejectedFrame(testId, requestId, "scheduled_tasks_off");
    if (typeof testId !== "string" || !TEST_ID_RE.test(testId)) return rejectedFrame(testId, requestId, "test_invalid");
    sweep();
    const scheduler = deps.scheduler();
    if (!scheduler || typeof scheduler.testRun !== "function") return rejectedFrame(testId, requestId, "test_unsupported");
    let test = tests.get(testId);
    const busy = refusal(test, requestId);
    if (busy) return busy;

    const launch = { cancelled: false, stopped: false };
    if (test) test.launch = launch;
    const profileId = hasText(context.agentId) ? context.agentId : "default";
    const starterCard = isPlainObject(context.starterCard) ? context.starterCard : null;
    let prepared      = null;
    try {
      prepared = await prepare(input, profileId, scheduler, starterCard);
    } finally {
      if (test && test.launch === launch && (prepared === null || prepared.code)) test.launch = null;
    }

    if (test && (launch.cancelled || tests.get(testId) !== test)) return rejectedFrame(testId, requestId, "test_missing");
    if (test && launch.stopped) {
      test.launch = null;
      return frame(test, requestId);
    }
    if (prepared.code) return test ? frame(test, requestId, { status: "rejected", code: prepared.code }) : rejectedFrame(testId, requestId, prepared.code);
    if (!test) {

      test = tests.get(testId);
      const taken = refusal(test, requestId);
      if (taken) return taken;
    }
    if (!test) {
      if (tests.size >= TASK_TEST_MAX) {

        const oldest = [...tests.values()].filter((other) => other.status !== "running" && !other.launch)
          .sort((a, b) => a.touchedAtMs - b.touchedAtMs)[0];
        if (!oldest) return rejectedFrame(testId, requestId, "test_busy");
        forget(oldest);
      }
      test = {
        testId, taskId: taskTestTaskId(testId), clientId, passes: 0, status: "new", jobId: null, profileId,
        startedAtMs: 0, endedAtMs: 0, answer: null, code: null, timer: null, touchedAtMs: now(),
        asked: new Map             (), launch: null,
      };
      tests.set(testId, test);
      store.seed(test.taskId, { entries: [], needs: [], keptOff: [] });
    }
    test.launch = launch;
    test.clientId = clientId;
    test.profileId = profileId;

    const record = store.read(test.taskId);
    if (record) store.seed(test.taskId, { ...record, needs: [] });

    const pinned = starterCard ? [...starterCard.inputs]
      : prepared.openCard ? (Array.isArray(context.pinned) && context.pinned.length ? context.pinned
        : pinnedCardInputs(test.card, input.cardKeys)) : null;

    const launchKey = `${testId}:${++launchSeq}`;
    launching.set(launchKey, test.taskId);
    let started      = null;
    try {
      started = await scheduler.testRun(test.taskId, prepared.name, prepared.request, prepared.plan, profileId,
        prepared.openCard ? { openCard: true, ...(pinned ? { inputs: pinned } : {}) } : {});
    } catch (err) {

      launching.delete(launchKey);
      if (test.launch === launch) test.launch = null;
      throw err;
    }
    const jobId = started && started.status === "ok" && typeof started.job?.id === "string" && started.job.id ? started.job.id : null;

    if (launch.cancelled || launch.stopped || tests.get(testId) !== test) {
      if (jobId) {
        closeJob(jobId, test.taskId);
        launching.delete(launchKey);
        void removeHostJob(test, jobId);
      } else launching.delete(launchKey);
      if (test.launch === launch) test.launch = null;
      if (launch.cancelled || tests.get(testId) !== test) return rejectedFrame(testId, requestId, "test_missing");
      if (jobId) {
        test.passes += 1;
        test.status = "stopped";
        test.startedAtMs = now();
        test.endedAtMs = now();
        test.touchedAtMs = now();
      }
      return frame(test, requestId);
    }
    if (!jobId) {

      launching.delete(launchKey);
      test.launch = null;
      test.code = (started && started.code) || "test_failed";
      return frame(test, requestId, { status: "rejected", code: test.code });
    }
    test.passes += 1;
    test.status = "running";
    test.jobId = jobId;

    byJob.set(jobId, testId);
    launching.delete(launchKey);
    test.launch = null;
    test.openCard = prepared.openCard;
    test.pinned = pinned;

    test.starterCard = starterCard ? starterCard.starterId : null;
    test.starter = starterCard;

    test.starterLocale = starterCard && typeof context.starterLocale === "string" ? context.starterLocale : "en";
    test.starterFit = null;
    test.starterCheck = null;
    test.starterHeld = null;

    test.savedTaskId = typeof context.savedTaskId === "string" ? context.savedTaskId : null;
    test.answer = null;
    test.code = null;
    test.startedAtMs = now();
    test.endedAtMs = 0;
    test.touchedAtMs = now();
    clearWait(test);
    test.timer = setTimer(() => {
      if (test.status !== "running" || test.jobId !== jobId) return;
      test.status = "failed";
      test.code = "test_timeout";
      test.endedAtMs = now();
      void endJob(test);
      tell(test);
    }, TASK_TEST_WAIT_MS);
    return frame(test, requestId);
  }

  function onResult(params     ) {
    const jobId = isPlainObject(params) && typeof params.jobId === "string" ? params.jobId : "";
    const testId = byJob.get(jobId);
    const test = testId ? tests.get(testId) : null;
    if (!test || test.jobId !== jobId) {

      closedJobs.delete(jobId);
      return { ok: false, error: "unknown_test" };
    }
    clearWait(test);
    const failed = params.failed === true;
    test.status = failed ? "failed" : "done";
    test.code = failed ? "test_run_failed" : null;
    test.answer = { failed, headline: cut(params.headline, HEADLINE_MAX), body: cut(params.body, BODY_MAX) };
    test.endedAtMs = now();

    const named = test.openCard && !failed ? taskTestCard(params.card, test.endedAtMs, test.pinned || null) : null;
    if (named) test.card = named;

    if (test.starter && !failed && starterCheck) {
      const started = starterCheck.start(test.starter, named || { values: {}, atMs: test.endedAtMs }, test.starterLocale);
      test.starterCheck = started.pending;
      test.starterFit = started.forPhone;
    }
    test.touchedAtMs = now();
    void endJob(test, true);
    tell(test);
    return { ok: true };
  }

  function starterReport(clientId     , requestId     , testId     , checkId     , report     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    if (!test) return rejectedFrame(testId, requestId, "test_missing");
    if (test.clientId !== clientId || !test.starterCheck || test.status !== "done") {
      return frame(test, requestId, { status: "rejected", code: "starter_check_missing" });
    }
    const judged = starterCheck ? starterCheck.verdict(test.starterCheck, checkId, report) : null;
    if (!judged) return frame(test, requestId, { status: "rejected", code: "starter_report_invalid" });
    test.starterCheck = null;
    test.starterFit = judged.fit;
    test.starterHeld = { ...judged.held, testId: test.testId, pass: test.passes };
    test.touchedAtMs = now();
    return frame(test, requestId);
  }

  function starterFitOf(testId     , clientId      = undefined) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    if (!test || (clientId !== undefined && test.clientId !== clientId)) return null;
    return test.starterHeld && test.starterHeld.pass === test.passes && test.starterFit?.status === test.starterHeld.status
      ? test.starterHeld : null;
  }

  function starterOf(testId     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    return test && test.starter ? { starter: test.starter, locale: test.starterLocale || "en" } : null;
  }

  function act(requestId     , testId     , action     , useKey     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    if (!test) return rejectedFrame(testId, requestId, "test_missing");
    if (!TASK_TEST_ACTIONS.has(action) || typeof useKey !== "string" || !useKey) {
      return frame(test, requestId, { status: "rejected", code: "test_act_invalid" });
    }
    test.touchedAtMs = now();
    let done      = null;
    if (action === "uses_allow") done = store.allowNeeds(test.taskId, useKey);
    else if (action === "uses_keep_off") done = store.keepOffNeeds(test.taskId, useKey);
    else done = store.reopen(test.taskId, useKey, test.asked.get(useKey));
    if (!done || done.status === "missing") return frame(test, requestId, { status: "rejected", code: "use_missing" });
    return frame(test, requestId);
  }

  async function stop(requestId     , testId     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    if (!test) return rejectedFrame(testId, requestId, "test_missing");

    if (test.launch) test.launch.stopped = true;
    if (test.status === "running") {
      clearWait(test);
      test.status = "stopped";
      test.endedAtMs = now();
      await endJob(test);
    }
    return frame(test, requestId);
  }

  function drop(testId     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    if (test) forget(test);
    return !!test;
  }

  function takeForTask(testId     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    if (!test) return null;
    const record = store.read(test.taskId);
    forget(test);
    return record ? { entries: record.entries, needs: record.needs, keptOff: record.keptOff, answer: test.answer } : null;
  }

  function cardOf(testId     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    return test?.card || null;
  }

  function draftOf(testId     , clientId     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    if (!test || test.savedTaskId || test.clientId !== clientId) return null;
    return { profileId: test.profileId, card: test.card || null };
  }

  function cardOfTask(testId     , taskId     ) {
    const test = typeof testId === "string" ? tests.get(testId) : null;
    return test && test.savedTaskId && test.savedTaskId === taskId ? test.card || null : null;
  }

  function testOfJob(jobId     ) {
    const testId = typeof jobId === "string" ? byJob.get(jobId) : null;
    const test = testId ? tests.get(testId) : null;

    if (test && test.status === "running" && test.jobId === jobId) return { taskId: test.taskId };

    const closed = typeof jobId === "string" ? closedJobs.get(jobId) : null;
    return closed ? { taskId: closed.taskId, closed: true } : null;
  }

  function testLaunching() {
    for (const taskId of launching.values()) return { taskId, closed: true };
    return null;
  }

  function dispose() {
    for (const test of [...tests.values()]) forget(test);
  }

  return { run, onResult, act, stop, drop, takeForTask, cardOf, cardOfTask, draftOf, testOfJob, starterReport, starterFitOf,
    starterOf, policy, closedPolicy, testLaunching, dispose };
}

module.exports = { TASK_TEST_RESULT_FRAME, TASK_TEST_CAPABILITY, LINK_TASK_TEST_RESULT_METHOD, TASK_TEST_PASSES_MAX, TASK_TEST_WAIT_MS, TASK_TEST_KEEP_MS, TASK_TEST_MAX, TASK_TEST_CLOSED_KEEP_MS, TASK_TEST_CLOSED_MAX, TASK_TEST_ACTIONS, TASK_TEST_CARD_VALUES_MAX, taskTestCard, taskTestTaskId, createLiveuiTaskTests };
