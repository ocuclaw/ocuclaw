const SETUP_NEXT_CONTRACT = 1;
const SETUP_NEXT_OPERATION = "next";

const SETUP_LANES = Object.freeze(["openclaw", "hermes"]         );
const SETUP_PROFILES = Object.freeze([
  "cloudways",
  "server",
  "container",
  "personal",
  "hermes-desktop",
]         );

const SETUP_STEPS = Object.freeze([
  Object.freeze({ id: "host_model", number: 1, label: "Check host and model" }),
  Object.freeze({ id: "plugin_access", number: 2, label: "Allow OcuClaw" }),
  Object.freeze({ id: "loaded", number: 3, label: "Load OcuClaw" }),
  Object.freeze({ id: "private_network", number: 4, label: "Join Tailscale" }),
  Object.freeze({ id: "approve_machine", number: 5, label: "Approve this machine" }),
  Object.freeze({ id: "private_route", number: 6, label: "Open private route" }),
  Object.freeze({ id: "phone_on_tailnet", number: 7, label: "Find your phone" }),
  Object.freeze({ id: "pair", number: 8, label: "Pair your phone" }),
  Object.freeze({ id: "first_message", number: 9, label: "First glasses message" }),
]         );
const SETUP_CORE_STEP_COUNT = 9;
const SETUP_AFTER_CORE = Object.freeze(["done"]         );
const SETUP_AFTER_CORE_LABELS = Object.freeze({
  done: "Setup complete",
});

const SETUP_STATUSES = Object.freeze(["working", "waiting", "restarting", "stuck", "done"]         );
const SETUP_STEP_STATES = Object.freeze(["todo", "current", "done", "skipped", "stuck"]         );
const SETUP_INPUT_KINDS = Object.freeze(["none", "link", "code", "approval", "choice", "glasses"]         );
const SETUP_THEN_VALUES = Object.freeze(["call_next", "end_turn", "troubleshoot"]         );
const SETUP_APPROVAL_SURFACES = Object.freeze(["card", "popup", "chat_yes"]         );
const SETUP_APPROVAL_OPERATIONS = Object.freeze(["apply_route", "confirm_pairing", "pair_phone"]         );
const SETUP_CODE_OPERATION = "pair_with_phone_code";
const SETUP_CODE_EXPIRES_IN_SECONDS = 600;
const SETUP_FORBIDDEN_OPERATIONS = Object.freeze(["provision_relay_credential"]         );
const SETUP_FORBIDDEN_PHRASES = Object.freeze(["relay credential"]         );
const SETUP_RESTART_HOW_BY_PROFILE = Object.freeze({
  cloudways: "container",
  server: "platform",
  container: "platform",
  personal: "platform",
  "hermes-desktop": "desktop_card",
});

const SETUP_RESTART_HOW_SELF = "self";

const HERMES_SETUP_INTERFACES = Object.freeze(["local", "cli", "tui", "desktop", "webui"]         );

const HEX64 = /^[a-f0-9]{64}$/;
const STEP_IDS                    = SETUP_STEPS.map((step) => step.id);
const ALL_STEP_IDS                    = [...STEP_IDS, ...SETUP_AFTER_CORE];
const OPERATION_STEP                                   = Object.freeze({
  apply_route: "private_route",
  confirm_pairing: "pair",
  pair_phone: "pair",
});

function approvalSurfaceFor(
  lane        ,
  iface        ,
  purpose                      ,
  approvals         ,
)                              {
  if (lane === "openclaw") return "card";
  if (lane !== "hermes") return null;
  if (iface !== "" && !(HERMES_SETUP_INTERFACES                     ).includes(iface)) return null;

  if (purpose === "pairing" && iface === "desktop") return "popup";
  return approvals ? "card" : "chat_yes";
}

function isObject(value         )                               {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringList(value         , nonEmptyItems = false)                    {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && (!nonEmptyItems || item.length > 0));
}

function nonEmptyString(value         )                  {
  return typeof value === "string" && value.length > 0;
}

function fail(error        )                 {
  return { ok: false, error };
}

function mentionsForbiddenPhrase(lines         )          {
  if (!Array.isArray(lines)) return false;
  return lines.some(
    (line) => typeof line === "string" && SETUP_FORBIDDEN_PHRASES.some((phrase) => line.toLowerCase().includes(phrase)),
  );
}

const STATUS_INPUT                                                                    = Object.freeze({
  working: (input) => input.kind === "none" && input.then === "call_next",
  waiting: (input) => input.kind !== "none",
  restarting: (input) => input.kind === "none" && input.then === "end_turn",
  stuck: (input) => input.kind === "none" && input.then === "troubleshoot",
  done: (input) => input.kind === "none" && input.then === "end_turn",
});

function checkInput(result                     )                        {
  const input = result.input;
  if (input.kind === "link") {
    const urlOk = input.url === null || (typeof input.url === "string" && input.url.startsWith("https://"));
    if (!urlOk || input.reply !== "done") return fail("bad_input");
  } else if (input.kind === "code") {
    if (input.operation !== SETUP_CODE_OPERATION || result.step !== "pair") return fail("bad_operation");
    if (input.param !== "code" || input.expiresInSeconds !== SETUP_CODE_EXPIRES_IN_SECONDS) return fail("bad_input");
  } else if (input.kind === "approval") {
    if (!(SETUP_APPROVAL_SURFACES                     ).includes(input.surface)) return fail("bad_surface");
    if (!(SETUP_APPROVAL_OPERATIONS                     ).includes(input.operation)) return fail("bad_operation");
    const popup = input.surface === "popup";
    if (popup !== (input.operation === "pair_phone") || (popup && result.lane !== "hermes")) return fail("bad_surface");
    if (OPERATION_STEP[input.operation] !== result.step) return fail("bad_operation");
    if (!popup) {
      if (typeof input.binding !== "string" || !HEX64.test(input.binding)) return fail("bad_binding");
      if (!isStringList(input.shows, true) || input.shows.length === 0) return fail("approval_without_words");
      if (input.surface === "chat_yes") {
        if (input.param !== "answer") return fail("bad_input");
        if (!input.shows.every((line        ) => result.say.includes(line))) return fail("words_not_shown");
      }
    }
  } else if (input.kind === "glasses") {

    if (result.step !== "first_message") return fail("bad_input");
    if (input.then !== "end_turn" && input.then !== "call_next") return fail("bad_input");
  } else if (input.kind === "choice") {
    if (input.chooser !== "user" && input.chooser !== "agent") return fail("bad_input");
    if (input.param !== "choice" || !Array.isArray(input.options) || input.options.length < 2) return fail("bad_input");
    const ids = new Set();
    for (const option of input.options) {
      if (!isObject(option) || !nonEmptyString(option.id) || !nonEmptyString(option.label) || ids.has(option.id)) {
        return fail("bad_input");
      }
      ids.add(option.id);
    }
  }
  return null;
}

function checkRestart(result                     )                        {
  if (result.status !== "restarting") return result.restart === undefined ? null : fail("bad_restart");
  if (result.lane === "openclaw" && result.profile === "cloudways") return fail("forbidden_restart");
  const restart = result.restart;
  const own = (SETUP_RESTART_HOW_BY_PROFILE                          )[result.profile];
  if (
    !isObject(restart) ||
    !(restart.how === own || (restart.how === SETUP_RESTART_HOW_SELF && own !== "desktop_card")) ||
    !Number.isInteger(restart.approxSeconds) ||
    restart.approxSeconds <= 0 ||
    restart.resumeWord !== "continue" ||
    result.step !== "loaded"
  ) {
    return fail("bad_restart");
  }
  return null;
}

function checkStuck(result                     )                        {
  if (result.status !== "stuck") return result.stuck === undefined ? null : fail("bad_stuck");
  const stuck = result.stuck;
  if (!isObject(stuck) || !nonEmptyString(stuck.code) || !isStringList(stuck.checked) || !isStringList(stuck.tried)) {
    return fail("bad_stuck");
  }
  return null;
}

function checkProgress(result                     )                        {
  const progress = result.progress;
  if (!isObject(progress) || progress.of !== SETUP_CORE_STEP_COUNT || progress.current !== result.step) {
    return fail("bad_progress");
  }
  const index = STEP_IDS.indexOf(result.step);
  const core = index === -1 ? null : SETUP_STEPS[index];
  const label = core ? core.label : (SETUP_AFTER_CORE_LABELS                          )[result.step];
  if (progress.number !== (core ? core.number : null) || progress.label !== label) return fail("bad_progress");
  const steps = progress.steps;
  if (!Array.isArray(steps) || steps.length !== SETUP_CORE_STEP_COUNT) return fail("bad_progress");
  const here = result.status === "stuck" ? "stuck" : "current";
  for (let i = 0; i < SETUP_STEPS.length; i += 1) {
    const step = steps[i];
    const want = SETUP_STEPS[i];
    if (!isObject(step) || step.id !== want.id || step.number !== want.number || step.label !== want.label) {
      return fail("bad_progress");
    }
    const before = index === -1 || i < index;
    const stateOk = before
      ? step.state === "done" || step.state === "skipped"
      : i === index
        ? step.state === here
        : step.state === "todo";
    if (!stateOk) return fail("bad_progress");
  }
  for (const step of steps) {
    if (step.state === "skipped" && !nonEmptyString(step.note)) return fail("skip_without_reason");
  }
  return null;
}

function validateNextResult(result         )                 {
  if (!isObject(result) || result.contract !== SETUP_NEXT_CONTRACT) return fail("bad_contract");
  if (!(SETUP_LANES                     ).includes(result.lane)) return fail("bad_lane");
  if (
    !(SETUP_PROFILES                     ).includes(result.profile) ||
    (result.profile === "hermes-desktop" && result.lane !== "hermes")
  ) {
    return fail("bad_profile");
  }
  if (!ALL_STEP_IDS.includes(result.step)) return fail("bad_step");
  if (!(SETUP_STATUSES                     ).includes(result.status)) return fail("bad_status");
  if ((result.status === "done") !== (result.step === "done")) return fail("bad_step");
  if (!isStringList(result.say)) return fail("bad_say");
  const input = result.input;
  if (!isObject(input) || !(SETUP_INPUT_KINDS                     ).includes(input.kind)) return fail("bad_input");
  if (input.kind === "none" && !(SETUP_THEN_VALUES                     ).includes(input.then)) return fail("bad_input");
  if (mentionsForbiddenPhrase(result.say) || mentionsForbiddenPhrase(input.shows)) {
    return fail("mentions_relay_credential");
  }
  if ((SETUP_FORBIDDEN_OPERATIONS                     ).includes(input.operation)) return fail("forbidden_operation");
  if (!STATUS_INPUT[result.status](input)) return fail("status_input_mismatch");
  return checkInput(result) ?? checkRestart(result) ?? checkStuck(result) ?? checkProgress(result) ?? { ok: true };
}

module.exports = { SETUP_NEXT_CONTRACT, SETUP_NEXT_OPERATION, SETUP_LANES, SETUP_PROFILES, SETUP_STEPS, SETUP_CORE_STEP_COUNT, SETUP_AFTER_CORE, SETUP_AFTER_CORE_LABELS, SETUP_STATUSES, SETUP_STEP_STATES, SETUP_INPUT_KINDS, SETUP_THEN_VALUES, SETUP_APPROVAL_SURFACES, SETUP_APPROVAL_OPERATIONS, SETUP_CODE_OPERATION, SETUP_CODE_EXPIRES_IN_SECONDS, SETUP_FORBIDDEN_OPERATIONS, SETUP_FORBIDDEN_PHRASES, SETUP_RESTART_HOW_BY_PROFILE, SETUP_RESTART_HOW_SELF, HERMES_SETUP_INTERFACES, approvalSurfaceFor, validateNextResult };
