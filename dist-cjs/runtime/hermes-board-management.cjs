const BOARD_OPERATIONS = new Set(["board.status", "board.boards", "board.lanes", "board.cards", "board.card", "board.timeline",
  "board.watch", "board.policy", "board.policy.set", "board.create", "board.receipt", "board.verdict",
  "board.comment", "board.tools.enable", "board.decompose", "board.action", "board.maintenance", "board.export",
  "board.export.part", "board.artifact", "board.artifact.part"]);

const BOARD_WRITES = new Set(["board.watch", "board.policy.set", "board.create", "board.verdict", "board.comment",
  "board.tools.enable", "board.decompose", "board.action", "board.export", "board.export.part"]);

const TOOLS_STATES = new Set(["on", "off", "unknown"]);
const TOOLS_SCOPES = new Set(["platform", "profile"]);
const TOOLS_SETUP = new Set(["uncertified", "unsupported", "unknown", "done", "blocked", "managed", "available"]);
const TOOLS_PLATFORM = /^[a-z][a-z0-9_]{0,31}$/;

const BOARD_MAINTENANCE_OPERATIONS = new Set(["board.maintenance", "board.export", "board.export.part"]);
const MAINTENANCE_GATES = ["diagnostics", "export", "reclaim"];
const STALE_REASONS = new Set(["claim_expired", "heartbeat_stale"]);
const JOURNAL_MODES = new Set(["wal", "delete", "truncate", "persist", "memory", "off", "other"]);
const CLAIM = /^[0-9a-f]{16}$/;
const EXPORT_ID = /^[A-Za-z0-9_-]{22}$/;

const BOARD_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const BOARD_EXPORT_PART_BYTES = 192 * 1024;
const EXPORT_PART_B64_MAX = Math.ceil(BOARD_EXPORT_PART_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const STALE_MAX = 20;

const BOARD_ARTIFACT_OPERATIONS = new Set(["board.artifact", "board.artifact.part"]);
const BOARD_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const ARTIFACT_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const ARTIFACT_NAME_MAX = 120;

const BOARD_UNCERTAIN_WRITES = new Set(["board.create", "board.verdict", "board.comment", "board.tools.enable",
  "board.decompose", "board.action"]);

const COMMENT_MAX = 2000;

const VERDICTS = new Set(["approve", "request_changes"]);
const ATTENTION_HASH = /^[0-9a-f]{64}$/;
const REASON_MAX = 1000;

const CREATE_LANES = new Set(["triage", "ready"]);

const CREATED_STATES = new Set(["triage", "todo", "ready"]);
const PARENTS_MAX = 8;
const CHILDREN_MAX = 20;
const CREATE_WATCH = new Set(["off", "notify"]);
const OPERATION_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const ASSIGNEE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RECEIPT_STATES = new Set(["pending", "succeeded", "refused", "outcome_unknown"]);

const CARD_ACTIONS = ["make_ready", "reassign", "set_model", "retry", "archive"];

const ALL_CARD_ACTIONS = [...CARD_ACTIONS, "reclaim"];
const RETRY_VIA = new Set(["reclaim", "unblock", "promote"]);
const FAILED_RUNS = new Set(["crashed", "timed_out", "spawn_failed", "gave_up"]);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const POLICY_NOW = new Set(["delivering", "quiet", "off", "held"]);
const POLICY_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const POLICY_ZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,31}(?:\/[A-Za-z0-9_+-]{1,32}){0,2}$/;
const BOARD_READS = new Set([...BOARD_OPERATIONS].filter(op => !BOARD_WRITES.has(op)));

const WATCH_MODES = new Set(["off", "notify", "notify_wake"]);

const BOARD_CAPABILITY_KEYS = [
  "browse", "passive_moments", "wake", "agent_tools", "create", "comment",
  "approve", "request_changes", "answer_and_unblock", "make_ready", "reassign", "set_model",
  "retry", "archive", "dependencies", "watch", "maintenance", "artifact_open",
];

const BOARD_CODES = new Set([
  "unsupported", "uncertified", "schema_unsupported", "store_missing", "invalid_target",
  "empty_board", "temporarily_unavailable", "disconnected", "stale_target", "stale_scope",
  "expired_request", "outcome_unknown", "deferred",

  "tools_off",
]);

const BOARD_STATES = new Set(["ready", "empty", "store_missing", "schema_unsupported", "temporarily_unavailable"]);

const BOARD_ERRORS                         = {
  uncertified: "Board isn't available on this Hermes version yet.",
  store_missing: "This Hermes has no kanban board store yet.",
  schema_unsupported: "This Hermes board store's format isn't supported.",
  temporarily_unavailable: "The board store is busy or unreadable. Try again shortly.",
  invalid_target: "That board is not available.",
  native_read_failed: "Hermes could not read its boards. Check the native gateway.",
  invalid_request: "This Board request is not valid.",
  stale_scope: "This list belongs to another profile. Start it again.",
  stale_target: "This board was replaced. Start the list again.",
  expired_request: "This list expired. Start it again.",
  deferred: "That isn't available on this Hermes yet.",
  outcome_unknown: "Hermes can't tell whether that was saved. Check before trying again.",

  unsupported: "Board isn't supported by the connected Hermes.",
  operation_conflict: "This request was already used for something else. Start again.",

  not_configured: "Hermes isn't set up for that yet.",

  wake_unsupported: "Notify + wake isn't supported by this Hermes.",

  too_large: "This board's export is too large to send to the phone.",

  artifact_unsupported: "Opening artifacts isn't supported by this Hermes.",
};

const ARTIFACT_ERRORS                         = {
  invalid_request: "Board couldn't open this artifact.",
  invalid_target: "This artifact is no longer available.",
  stale_target: "This board was replaced. Open the card again.",
  stale_scope: "This artifact was opened for another profile. Open it again.",
  expired_request: "This artifact is no longer ready. Open it again.",
  too_large: "This artifact is too large to open on the phone.",
  temporarily_unavailable: "Board couldn't open this artifact. Try again shortly.",
  artifact_unsupported: "Opening artifacts isn't supported by this Hermes.",
};

const DECOMPOSE_ERRORS                         = {
  invalid_request: "Hermes couldn't split this card.",
  invalid_target: "That card is no longer on this board.",
  stale_target: "This card has left triage, so it can't be split now.",
  stale_scope: "This split was started for another profile.",
  expired_request: "Hermes didn't split this card. Try again.",
  outcome_unknown: "Hermes can't tell whether this card was split. Check the board before trying again.",
  operation_conflict: "This request was already used for a different card. Start again.",
  temporarily_unavailable: "Hermes couldn't split this card right now. Try again shortly.",
  not_configured: "Hermes isn't set up to split cards. Set a decomposer model in Hermes.",
  deferred: "Splitting cards isn't available on this Hermes yet.",
};

const MAINTENANCE_ERRORS                         = {
  invalid_request: "Board couldn't take this maintenance request.",
  invalid_target: "That board is not available for maintenance.",
  stale_target: "This board was replaced. Open Maintenance again.",
  stale_scope: "This export was started for another profile.",
  expired_request: "This export is no longer available. Export the board again.",
  too_large: "This board's export is too large to send to the phone.",
  temporarily_unavailable: "Board couldn't finish this. Try again shortly.",
  unsupported: "This maintenance action isn't available on this Hermes.",
  deferred: "Maintenance isn't available on this Hermes yet.",
};

const CREATE_ERRORS                         = {
  invalid_request: "Hermes couldn't take this card. Check its title and worker.",
  stale_target: "The board changed since this card was started. Refresh and try again.",
  stale_scope: "This card was started for another profile.",
  expired_request: "Hermes didn't save this card. Start it again.",
  outcome_unknown: "Hermes can't tell whether this card was saved. Check the board before trying again.",
  operation_conflict: "This request was already used for a different card. Start again.",
  temporarily_unavailable: "Board couldn't save this card. Try again shortly.",
  deferred: "Creating cards isn't available on this Hermes yet.",
};

const ACTION_ERRORS                         = {
  invalid_request: "Hermes couldn't make this change. Check the card and try again.",
  invalid_target: "That card is no longer available.",
  stale_target: "This card changed since you opened it. Look again before changing it.",
  stale_scope: "This change was started for another profile.",
  expired_request: "Hermes didn't make this change. Try again.",
  outcome_unknown: "Hermes can't tell whether this change was made. Check the card before trying again.",
  operation_conflict: "This request was already used for a different change. Start again.",
  temporarily_unavailable: "Board couldn't make this change. Try again shortly.",
  deferred: "This action isn't available on this Hermes yet.",
};

const VERDICT_ERRORS                         = {
  invalid_request: "Hermes couldn't take this decision.",
  invalid_target: "That card is no longer available.",
  stale_target: "This review changed since you opened it. Look again before deciding.",
  stale_scope: "This decision was started for another profile.",
  expired_request: "Hermes didn't record this decision. Decide again.",
  outcome_unknown: "Hermes can't tell whether your decision was recorded. Check the card before deciding again.",
  operation_conflict: "This request was already used for a different decision. Decide again.",
  temporarily_unavailable: "Board couldn't record this decision. Try again shortly.",
  deferred: "Decisions aren't available on this Hermes yet.",
};

const COMMENT_ERRORS                         = {
  invalid_request: "Hermes couldn't take this comment. Check its text.",
  invalid_target: "That card is no longer available.",
  stale_target: "This board was replaced. Open the card again before commenting.",
  stale_scope: "This comment was started for another profile.",
  expired_request: "Hermes didn't add this comment. You can send it again.",
  outcome_unknown: "Hermes can't tell whether your comment was added. Check the timeline before sending it again.",
  operation_conflict: "This request was already used for something else. Send the comment again.",
  temporarily_unavailable: "Board couldn't add this comment. Try again shortly.",
  deferred: "Comments aren't available on this Hermes yet.",
};

const CARD_ERRORS                         = {
  invalid_target: "That card is no longer available.",
  stale_target: "This board was replaced. Open the card again.",
  stale_scope: "This card belongs to another profile. Open it again.",
  expired_request: "This timeline expired. Open the card again.",
};

const WATCH_ERRORS                         = {
  temporarily_unavailable: "Board couldn't save this watch. Try again shortly.",
  deferred: "Notify + wake isn't available yet.",
  wake_unsupported: "Notify + wake isn't supported by this Hermes.",
};

const POLICY_ERRORS                         = {
  temporarily_unavailable: "Board couldn't reach your moment settings. Try again shortly.",
  invalid_request: "Board can't use these moment settings. Check the times and time zone.",
};

const TOOLS_ERRORS                         = {
  invalid_request: "Confirm on the phone to turn on Board voice tools.",
  unsupported: "Board can't turn on voice tools on this Hermes. Settings › Board says why.",
  temporarily_unavailable: "Hermes didn't turn the tools on. Nothing changed.",
  outcome_unknown: "Hermes didn't confirm the change. Refresh to check.",
};

function boardErrorMessage(op        , code        )         {
  if (op === "board.tools.enable" && Object.hasOwn(TOOLS_ERRORS, code)) return TOOLS_ERRORS[code];
  if ((op === "board.policy" || op === "board.policy.set") && Object.hasOwn(POLICY_ERRORS, code)) return POLICY_ERRORS[code];
  if ((op === "board.create" || op === "board.receipt") && Object.hasOwn(CREATE_ERRORS, code)) return CREATE_ERRORS[code];
  if (op === "board.verdict" && Object.hasOwn(VERDICT_ERRORS, code)) return VERDICT_ERRORS[code];
  if (op === "board.comment" && Object.hasOwn(COMMENT_ERRORS, code)) return COMMENT_ERRORS[code];
  if (op === "board.decompose" && Object.hasOwn(DECOMPOSE_ERRORS, code)) return DECOMPOSE_ERRORS[code];
  if (op === "board.action" && Object.hasOwn(ACTION_ERRORS, code)) return ACTION_ERRORS[code];
  if (BOARD_MAINTENANCE_OPERATIONS.has(op) && Object.hasOwn(MAINTENANCE_ERRORS, code)) return MAINTENANCE_ERRORS[code];
  if (BOARD_ARTIFACT_OPERATIONS.has(op) && Object.hasOwn(ARTIFACT_ERRORS, code)) return ARTIFACT_ERRORS[code];
  if (op === "board.watch" && Object.hasOwn(WATCH_ERRORS, code)) return WATCH_ERRORS[code];
  if ((op === "board.card" || op === "board.timeline" || op === "board.watch") && Object.hasOwn(CARD_ERRORS, code)) return CARD_ERRORS[code];
  return Object.hasOwn(BOARD_ERRORS, code) ? BOARD_ERRORS[code] : BOARD_ERRORS.native_read_failed;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STATUS = /^[a-z][a-z_]{0,31}$/;
const LANE_ORDER = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
const RUN_OUTCOMES = new Set(["completed", "blocked", "crashed", "timed_out", "spawn_failed", "gave_up", "reclaimed", "other"]);
const ATTENTION = new Set(["needs_review", "needs_input", "none"]);
const CURSOR = /^[A-Za-z0-9_-]{1,440}\.[A-Za-z0-9_-]{1,64}$/;
const CARD_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ANCHOR = /^[A-Za-z0-9_-]{16}$/;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,60}$/;
const RELATED_MAX = 20;
const TIMELINE_MAX = 50;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v     , limit        ) => typeof v === "string" && v.length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v);
const count = (v     ) => Number.isSafeInteger(v) && v >= 0;

const prose = (v     , limit        ) => typeof v === "string" && v.length > 0 && v.length <= limit && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v);

const onlyKeys = (raw     , keys          ) => Object.keys(raw).every(key => keys.includes(key));

function boardRequest(op        , raw     )      {
  if (!BOARD_OPERATIONS.has(op)) return null;
  if (op === "board.receipt") {
    return record(raw) && onlyKeys(raw, ["key"]) && typeof raw.key === "string" && OPERATION_KEY.test(raw.key) ? { key: raw.key } : null;
  }
  if (op === "board.status" || op === "board.boards" || op === "board.policy") {
    return raw === undefined || raw === null || (record(raw) && Object.keys(raw).length === 0) ? {} : null;
  }
  if (op === "board.policy.set") return policySet(raw);

  if (op === "board.tools.enable") return record(raw) && Object.keys(raw).length === 1 && raw.confirmed === true ? { confirmed: true } : null;
  if (op === "board.export.part") {

    return record(raw) && onlyKeys(raw, ["id", "part"]) && typeof raw.id === "string" && EXPORT_ID.test(raw.id) &&
      count(raw.part) ? { id: raw.id, part: raw.part } : null;
  }
  if (op === "board.artifact.part") {

    return record(raw) && onlyKeys(raw, ["token", "part"]) && typeof raw.token === "string" && ARTIFACT_TOKEN.test(raw.token) &&
      count(raw.part) ? { token: raw.token, part: raw.part } : null;
  }
  if (!record(raw) || typeof raw.slug !== "string" || !SLUG.test(raw.slug)) return null;
  if (op === "board.maintenance") return onlyKeys(raw, ["slug"]) ? { slug: raw.slug } : null;
  if (op === "board.artifact") {

    if (!onlyKeys(raw, ["slug", "anchor", "id", "attachment"]) || typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor) ||
      typeof raw.id !== "string" || !CARD_ID.test(raw.id) || !count(raw.attachment)) return null;
    return { slug: raw.slug, anchor: raw.anchor, id: raw.id, attachment: raw.attachment };
  }
  if (op === "board.export") {

    if (!onlyKeys(raw, ["slug", "anchor", "attachments", "logs"]) || typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor) ||
      typeof raw.attachments !== "boolean" || typeof raw.logs !== "boolean") return null;
    return { slug: raw.slug, anchor: raw.anchor, attachments: raw.attachments, logs: raw.logs };
  }
  if (op === "board.lanes") return onlyKeys(raw, ["slug"]) ? { slug: raw.slug } : null;
  if (op === "board.create") return createRequest(raw);
  if (op === "board.verdict") return verdictRequest(raw);
  if (op === "board.comment") return commentRequest(raw);
  if (op === "board.decompose") return decomposeRequest(raw);
  if (op === "board.action") return actionRequest(raw);
  if (op === "board.card" || op === "board.timeline") return cardRequest(op, raw);
  if (op === "board.watch") {
    if (!onlyKeys(raw, ["slug", "id", "mode"]) || typeof raw.id !== "string" || !CARD_ID.test(raw.id) ||
      typeof raw.mode !== "string" || !WATCH_MODES.has(raw.mode)) return null;
    return { slug: raw.slug, id: raw.id, mode: raw.mode };
  }
  if (!onlyKeys(raw, ["slug", "filter", "cursor", "limit"])) return null;
  if (typeof raw.filter !== "string" || !(raw.filter === "all" || raw.filter === "needs_you" || STATUS.test(raw.filter))) return null;
  const out      = { slug: raw.slug, filter: raw.filter };
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== "string" || !CURSOR.test(raw.cursor)) return null;
    out.cursor = raw.cursor;
  }
  if (raw.limit !== undefined) {
    if (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 50) return null;
    out.limit = raw.limit;
  }
  return out;
}

function quietWindow(raw     )      {
  if (raw === null) return null;
  if (!record(raw) || Object.keys(raw).length !== 3 || !onlyKeys(raw, ["from", "to", "timezone"])) return undefined;
  if (typeof raw.from !== "string" || !POLICY_TIME.test(raw.from) || typeof raw.to !== "string" || !POLICY_TIME.test(raw.to) ||
    raw.from === raw.to || typeof raw.timezone !== "string" || raw.timezone.length > 64 || !POLICY_ZONE.test(raw.timezone)) return undefined;
  return { from: raw.from, to: raw.to, timezone: raw.timezone };
}

function policySet(raw     )      {
  if (!record(raw) || Object.keys(raw).length !== 3 || !onlyKeys(raw, ["moments", "done", "quiet"])) return null;
  if (typeof raw.moments !== "boolean" || typeof raw.done !== "boolean") return null;
  const quiet = quietWindow(raw.quiet);
  return quiet === undefined ? null : { moments: raw.moments, done: raw.done, quiet };
}

function policy(raw     )      {
  if (!record(raw) || !POLICY_NOW.has(raw.now)) throw new Error("policy");
  if (raw.state === "unknown") {
    if (Object.keys(raw).length !== 2 || raw.now !== "held") throw new Error("policy");
    return { state: "unknown", now: "held" };
  }
  if (!["default", "saved"].includes(raw.state) || Object.keys(raw).length !== 5 ||
    !onlyKeys(raw, ["state", "moments", "done", "quiet", "now"])) throw new Error("policy");
  const settings = policySet({ moments: raw.moments, done: raw.done, quiet: raw.quiet });
  if (!settings) throw new Error("policy");
  return { state: raw.state, ...settings, now: raw.now };
}

function cardRequest(op        , raw     )      {
  if (typeof raw.id !== "string" || !CARD_ID.test(raw.id)) return null;
  const out      = { slug: raw.slug, id: raw.id };
  if (op === "board.card") {
    if (!onlyKeys(raw, ["slug", "id", "anchor"])) return null;
    if (raw.anchor !== undefined) {
      if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) return null;
      out.anchor = raw.anchor;
    }
    return out;
  }
  if (!onlyKeys(raw, ["slug", "id", "cursor", "limit"])) return null;
  if (typeof raw.cursor !== "string" || !CURSOR.test(raw.cursor)) return null;
  out.cursor = raw.cursor;
  if (raw.limit !== undefined) {
    if (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > TIMELINE_MAX) return null;
    out.limit = raw.limit;
  }
  return out;
}

function createRequest(raw     )      {
  if (!onlyKeys(raw, ["slug", "anchor", "key", "title", "body", "assignee", "priority", "lane", "watch", "parents"])) return null;
  if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) return null;
  if (typeof raw.key !== "string" || !OPERATION_KEY.test(raw.key)) return null;
  if (!text(raw.title, 200) || raw.title.trim() !== raw.title) return null;
  if (!Number.isSafeInteger(raw.priority) || raw.priority < -10 || raw.priority > 10) return null;
  if (!CREATE_LANES.has(raw.lane) || !CREATE_WATCH.has(raw.watch)) return null;
  const out      = { slug: raw.slug, anchor: raw.anchor, key: raw.key, title: raw.title, priority: raw.priority, lane: raw.lane, watch: raw.watch };
  if (raw.body !== undefined) {
    if (!prose(raw.body, 4000) || raw.body.trim() !== raw.body) return null;
    out.body = raw.body;
  }
  if (raw.assignee !== undefined) {
    if (typeof raw.assignee !== "string" || !ASSIGNEE.test(raw.assignee)) return null;
    out.assignee = raw.assignee;
  }

  if (raw.parents !== undefined) {
    if (!cardIds(raw.parents, PARENTS_MAX)) return null;
    if (raw.parents.length > 0) out.parents = [...raw.parents];
  }
  return out;
}

function cardIds(raw     , max        )          {
  return Array.isArray(raw) && raw.length <= max && new Set(raw).size === raw.length &&
    raw.every((id     ) => typeof id === "string" && CARD_ID.test(id));
}

function decomposeRequest(raw     )      {
  if (!onlyKeys(raw, ["slug", "anchor", "key", "id"])) return null;
  if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) return null;
  if (typeof raw.key !== "string" || !OPERATION_KEY.test(raw.key)) return null;
  if (typeof raw.id !== "string" || !CARD_ID.test(raw.id)) return null;
  return { slug: raw.slug, anchor: raw.anchor, key: raw.key, id: raw.id };
}

function actionRequest(raw     )      {
  if (typeof raw.action !== "string" || !ALL_CARD_ACTIONS.includes(raw.action)) return null;
  const values = raw.action === "reassign" ? ["assignee"] : raw.action === "set_model" ? ["model", "provider"] :
    raw.action === "reclaim" ? ["claim"] : [];
  if (!onlyKeys(raw, ["slug", "anchor", "id", "key", "action", "state", "run", ...values])) return null;
  if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) return null;
  if (typeof raw.key !== "string" || !OPERATION_KEY.test(raw.key)) return null;
  if (typeof raw.id !== "string" || !CARD_ID.test(raw.id)) return null;
  if (typeof raw.state !== "string" || !STATUS.test(raw.state) || !count(raw.run)) return null;
  const out      = { slug: raw.slug, anchor: raw.anchor, id: raw.id, key: raw.key, action: raw.action, state: raw.state, run: raw.run };
  if (raw.action === "reassign") {
    if (typeof raw.assignee !== "string" || (raw.assignee !== "" && !ASSIGNEE.test(raw.assignee))) return null;
    out.assignee = raw.assignee;
  }
  if (raw.action === "set_model") {
    if (typeof raw.model !== "string" || (raw.model !== "" && !MODEL.test(raw.model))) return null;
    out.model = raw.model;
    if (raw.provider !== undefined) {
      if (typeof raw.provider !== "string" || !PROVIDER.test(raw.provider) || raw.model === "") return null;
      out.provider = raw.provider;
    }
  }
  if (raw.action === "reclaim") {

    if (typeof raw.claim !== "string" || !CLAIM.test(raw.claim) || raw.state !== "running") return null;
    out.claim = raw.claim;
  }
  return out;
}

function actionReceipt(raw     , out     ) {
  const card = raw.card;
  if (!record(card) || !text(card.id, 64) || !CARD_ID.test(card.id) || typeof card.state !== "string" || !STATUS.test(card.state)) {
    throw new Error("receipt card");
  }
  out.card = { id: card.id, state: card.state };
  if (card.assignee !== undefined) {
    if (!text(card.assignee, 64)) throw new Error("receipt assignee");
    out.card.assignee = card.assignee;
  }
  if (card.model !== undefined) {
    if (!text(card.model, 128)) throw new Error("receipt model");
    out.card.model = card.model;
  }
  if (raw.via !== undefined) {
    if (raw.operation !== "retry" || !RETRY_VIA.has(raw.via)) throw new Error("receipt via");
    out.via = raw.via;
  }
  if (raw.operation === "retry" && out.via === undefined) throw new Error("receipt via");
  if (raw.failedRun !== undefined) {
    if (raw.operation !== "retry" || !FAILED_RUNS.has(raw.failedRun)) throw new Error("receipt failedRun");
    out.failedRun = raw.failedRun;
  }
  return out;
}

function verdictRequest(raw     )      {
  if (!onlyKeys(raw, ["slug", "anchor", "id", "key", "verdict", "attentionEvent", "attentionHash", "reason"])) return null;
  if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) return null;
  if (typeof raw.id !== "string" || !CARD_ID.test(raw.id)) return null;
  if (typeof raw.key !== "string" || !OPERATION_KEY.test(raw.key)) return null;
  if (!VERDICTS.has(raw.verdict)) return null;
  if (!Number.isSafeInteger(raw.attentionEvent) || raw.attentionEvent < 1) return null;
  if (typeof raw.attentionHash !== "string" || !ATTENTION_HASH.test(raw.attentionHash)) return null;
  const out      = { slug: raw.slug, anchor: raw.anchor, id: raw.id, key: raw.key, verdict: raw.verdict,
    attentionEvent: raw.attentionEvent, attentionHash: raw.attentionHash };
  if (raw.verdict === "request_changes") {
    if (!prose(raw.reason, REASON_MAX) || raw.reason.trim() !== raw.reason) return null;
    out.reason = raw.reason;
  } else if (raw.reason !== undefined) return null;
  return out;
}

function commentRequest(raw     )      {
  if (!onlyKeys(raw, ["slug", "anchor", "id", "key", "body"])) return null;
  if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) return null;
  if (typeof raw.id !== "string" || !CARD_ID.test(raw.id)) return null;
  if (typeof raw.key !== "string" || !OPERATION_KEY.test(raw.key)) return null;
  if (!prose(raw.body, COMMENT_MAX) || raw.body.trim() !== raw.body) return null;
  return { slug: raw.slug, anchor: raw.anchor, id: raw.id, key: raw.key, body: raw.body };
}

function receipt(raw     , key        ) {
  if (!record(raw) || raw.key !== key || !RECEIPT_STATES.has(raw.state)) throw new Error("receipt");
  if (raw.operation !== "create" && raw.operation !== "decompose" && raw.operation !== "unknown" && raw.operation !== "comment" &&
    !VERDICTS.has(raw.operation) && !ALL_CARD_ACTIONS.includes(raw.operation)) {
    throw new Error("receipt operation");
  }
  const out      = { key: raw.key, operation: raw.operation, state: raw.state };
  if (raw.state === "succeeded" && ALL_CARD_ACTIONS.includes(raw.operation)) return actionReceipt(raw, out);

  if (raw.state === "succeeded" && (VERDICTS.has(raw.operation) || raw.operation === "comment")) {
    const card = raw.card;
    if (!record(card) || !text(card.id, 64) || !CARD_ID.test(card.id) || !validState(card.state)) throw new Error("receipt card");
    out.card = { id: card.id, state: card.state };
  } else if (raw.state === "succeeded" && raw.operation === "decompose") {

    const split = raw.split;
    if (!record(split) || typeof split.id !== "string" || !CARD_ID.test(split.id) || typeof split.fanout !== "boolean" ||
      !cardIds(split.children, CHILDREN_MAX)) throw new Error("receipt split");
    out.split = { id: split.id, fanout: split.fanout, children: [...split.children] };
  } else if (raw.state === "succeeded") {
    const card = raw.card;
    if (!record(card) || !text(card.id, 64) || !CARD_ID.test(card.id) || !text(card.title, 200) || !CREATED_STATES.has(card.state) ||
      !Number.isSafeInteger(card.priority)) throw new Error("receipt card");
    out.card = { id: card.id, title: card.title, state: card.state, priority: card.priority };
    if (card.assignee !== undefined) {
      if (!text(card.assignee, 64)) throw new Error("receipt assignee");
      out.card.assignee = card.assignee;
    }
    if (card.parents !== undefined) {
      if (!cardIds(card.parents, PARENTS_MAX) || card.parents.length === 0) throw new Error("receipt parents");
      out.card.parents = [...card.parents];
    }
    if (!record(raw.watch) || !CREATE_WATCH.has(raw.watch.mode) || typeof raw.watch.applied !== "boolean") throw new Error("receipt watch");
    out.watch = { mode: raw.watch.mode, applied: raw.watch.applied };
  }
  if (raw.state === "refused") {
    if (!Object.hasOwn(BOARD_ERRORS, raw.code) && !Object.hasOwn(CREATE_ERRORS, raw.code) && !Object.hasOwn(VERDICT_ERRORS, raw.code) &&
      !Object.hasOwn(COMMENT_ERRORS, raw.code) && !Object.hasOwn(ACTION_ERRORS, raw.code) &&
      !BOARD_CODES.has(raw.code)) throw new Error("receipt code");
    out.code = raw.code;
  }
  return out;
}

const ENGINE_TIERS = ["certified", "compatible", "uncertified"];
const ENGINE_REASON = /^[a-z_]{1,32}(?::[A-Za-z0-9_.]{1,80})?$/;

function engine(raw     ) {
  if (!record(raw) || !text(raw.version, 32) || !ENGINE_TIERS.includes(raw.certification)) throw new Error("engine");
  const out      = { version: raw.version, certification: raw.certification };
  if (raw.certification === "certified") {
    if (!text(raw.pin, 32)) throw new Error("pin");
    out.pin = raw.pin;
  }
  if (raw.certification === "uncertified" && raw.reason !== undefined) {
    if (typeof raw.reason !== "string" || !ENGINE_REASON.test(raw.reason)) throw new Error("engine reason");
    out.reason = raw.reason;
  }
  return out;
}

function capabilities(raw     ) {
  if (!Array.isArray(raw) || raw.length !== BOARD_CAPABILITY_KEYS.length) throw new Error("capabilities");
  return raw.map((row     , i        ) => {
    if (!record(row) || row.key !== BOARD_CAPABILITY_KEYS[i] || typeof row.enabled !== "boolean") throw new Error("capability");
    if (row.enabled) return { key: row.key, enabled: true };
    if (!BOARD_CODES.has(row.code)) throw new Error("code");
    const out      = { key: row.key, enabled: false, code: row.code };
    if (row.code === "deferred") {
      if (!Number.isSafeInteger(row.owner) || row.owner <= 0) throw new Error("owner");
      out.owner = row.owner;
    }
    return out;
  });
}

function agentTools(raw     ) {
  if (!record(raw) || !onlyKeys(raw, ["platform", "state", "scope", "setup", "command"])) throw new Error("agentTools");
  if (typeof raw.platform !== "string" || !TOOLS_PLATFORM.test(raw.platform) || !TOOLS_STATES.has(raw.state) ||
    !TOOLS_SETUP.has(raw.setup)) throw new Error("agentTools");
  const out      = { platform: raw.platform, state: raw.state };
  if (raw.scope !== undefined) {
    if (raw.state !== "on" || !TOOLS_SCOPES.has(raw.scope)) throw new Error("agentTools scope");
    out.scope = raw.scope;
  }
  out.setup = raw.setup;
  const line = `hermes tools enable kanban --platform ${raw.platform}`;
  if ((raw.setup === "available") !== (raw.command !== undefined) || (raw.command !== undefined && raw.command !== line)) {
    throw new Error("agentTools command");
  }
  if (raw.command !== undefined) out.command = raw.command;

  if (raw.state === "on" && raw.scope === undefined) throw new Error("agentTools scope");
  if (raw.setup === "done" && raw.state !== "on") throw new Error("agentTools done");
  if (raw.setup === "available" && raw.state !== "off") throw new Error("agentTools available");
  return out;
}

function boards(raw     ) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) throw new Error("boards");
  const seen = new Set        ();
  return raw.map((row     , i        ) => {
    if (!record(row) || typeof row.slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.slug) || seen.has(row.slug)) throw new Error("slug");
    seen.add(row.slug);
    if ((i === 0) !== (row.slug === "default") || row.isDefault !== (row.slug === "default")) throw new Error("default");
    if (!text(row.name, 80) || typeof row.archived !== "boolean" || !BOARD_STATES.has(row.state)) throw new Error("row");
    const out      = { slug: row.slug, name: row.name, isDefault: row.isDefault, archived: row.archived, state: row.state };
    if (text(row.description, 240)) out.description = row.description;
    if (text(row.icon, 16)) out.icon = row.icon;
    if (typeof row.color === "string" && /^#[0-9a-fA-F]{6}$/.test(row.color)) out.color = row.color;
    if (row.state === "ready" || row.state === "empty") {
      if (!count(row.cardCount) || (row.state === "empty") !== (row.cardCount === 0)) throw new Error("cardCount");
      out.cardCount = row.cardCount;
    }
    return out;
  });
}

function maintenanceResult(raw     ) {
  if (!record(raw) || !onlyKeys(raw, ["gates", "diagnostics", "stale"])) throw new Error("maintenance");
  if (!Array.isArray(raw.gates) || raw.gates.length !== MAINTENANCE_GATES.length) throw new Error("gates");
  const gates = raw.gates.map((row     , i        ) => {
    if (!record(row) || row.key !== MAINTENANCE_GATES[i] || typeof row.enabled !== "boolean") throw new Error("gate");
    if (row.enabled) return { key: row.key, enabled: true };
    if (!BOARD_CODES.has(row.code)) throw new Error("gate code");
    return { key: row.key, enabled: false, code: row.code };
  });
  const out      = { gates };
  const diagnosticsOn = gates[0].enabled;
  if ((raw.diagnostics === undefined) !== !diagnosticsOn || (raw.stale === undefined) !== !diagnosticsOn) throw new Error("diagnostics");
  if (!diagnosticsOn) return out;
  const d = raw.diagnostics;
  const counts = ["checkedAt", "sizeBytes", "cards", "archived", "running", "runs", "events", "comments", "attachments", "stale"];
  if (!record(d) || !onlyKeys(d, [...counts, "journal", "receipts"]) || !counts.every(key => count(d[key])) ||
    !JOURNAL_MODES.has(d.journal)) throw new Error("diagnostics");
  const diagnostics      = Object.fromEntries(counts.map(key => [key, d[key]]));
  diagnostics.journal = d.journal;
  if (d.receipts !== undefined) {
    if (!record(d.receipts) || !onlyKeys(d.receipts, ["pending", "unknown"]) || !count(d.receipts.pending) ||
      !count(d.receipts.unknown)) throw new Error("receipts");
    diagnostics.receipts = { pending: d.receipts.pending, unknown: d.receipts.unknown };
  }
  out.diagnostics = diagnostics;
  if (!Array.isArray(raw.stale) || raw.stale.length > STALE_MAX || raw.stale.length > diagnostics.stale) throw new Error("stale");
  const seen = new Set        ();
  out.stale = raw.stale.map((row     ) => {
    if (!record(row) || !onlyKeys(row, ["id", "title", "worker", "run", "claim", "reason", "staleFor"]) ||
      typeof row.id !== "string" || !CARD_ID.test(row.id) || seen.has(row.id) || !text(row.title, 200) ||
      !count(row.run) || typeof row.claim !== "string" || !CLAIM.test(row.claim) || !STALE_REASONS.has(row.reason) ||
      !count(row.staleFor)) throw new Error("stale row");
    seen.add(row.id);
    const card      = { id: row.id, title: row.title, run: row.run, claim: row.claim, reason: row.reason, staleFor: row.staleFor };
    if (row.worker !== undefined) {
      if (!text(row.worker, 64)) throw new Error("stale worker");
      card.worker = row.worker;
    }
    return card;
  });
  return out;
}

function target(raw     , slug        ) {
  if (!record(raw) || raw.slug !== slug || !text(raw.name, 80)) throw new Error("target");
  return { slug: raw.slug, name: raw.name };
}

function lanes(raw     ) {
  if (!Array.isArray(raw) || raw.length < LANE_ORDER.length || raw.length > 64) throw new Error("lanes");
  const seen = new Set        ();
  return raw.map((row     , i        ) => {
    if (!record(row) || typeof row.status !== "string" || !STATUS.test(row.status) || seen.has(row.status) || !count(row.count)) throw new Error("lane");
    seen.add(row.status);
    const known = i < LANE_ORDER.length;
    if (row.known !== known || (known && row.status !== LANE_ORDER[i]) || (!known && LANE_ORDER.includes(row.status))) throw new Error("lane order");
    return { status: row.status, count: row.count, known };
  });
}

function cards(raw     ) {
  if (!Array.isArray(raw) || raw.length > 50) throw new Error("cards");
  const seen = new Set        ();
  return raw.map((row     ) => {
    if (!record(row) || seen.has(row.id)) throw new Error("card");
    seen.add(row.id);
    return cardRow(row);
  });
}

function cardRow(row     ) {
  if (!record(row) || !text(row.id, 64) || !text(row.title, 200)) throw new Error("card");
  if (!validState(row.state)) throw new Error("state");
  if (!Number.isSafeInteger(row.priority) || !count(row.createdAt) || !ATTENTION.has(row.attention)) throw new Error("card fields");
  const out      = { id: row.id, title: row.title, state: row.state, priority: row.priority, createdAt: row.createdAt, attention: row.attention };
  if (text(row.assignee, 64)) out.assignee = row.assignee;
  if (row.runOutcome !== undefined) {
    if (!RUN_OUTCOMES.has(row.runOutcome)) throw new Error("outcome");
    out.runOutcome = row.runOutcome;
  }

  if (row.runStartedAt !== undefined) {
    if (!count(row.runStartedAt)) throw new Error("run start");
    out.runStartedAt = row.runStartedAt;
  }

  if (row.watch !== undefined) {
    if (!WATCH_MODES.has(row.watch)) throw new Error("watch");
    out.watch = row.watch;
  }
  return out;
}

const validState = (v     ) => typeof v === "string" && (v === "unknown" || STATUS.test(v));
const positive = (v     ) => Number.isSafeInteger(v) && v > 0;

function latestRun(raw     ) {
  if (!record(raw) || !positive(raw.id) || !validState(raw.status) || !count(raw.startedAt)) throw new Error("run");
  const out      = { id: raw.id, status: raw.status, startedAt: raw.startedAt };
  if (raw.outcome !== undefined) {
    if (!RUN_OUTCOMES.has(raw.outcome)) throw new Error("run outcome");
    out.outcome = raw.outcome;
  }
  if (text(raw.worker, 64)) out.worker = raw.worker;
  if (prose(raw.summary, 1000)) out.summary = raw.summary;
  if (raw.endedAt !== undefined) {
    if (!count(raw.endedAt)) throw new Error("run end");
    out.endedAt = raw.endedAt;
  }
  return out;
}

function related(raw     ) {
  if (!Array.isArray(raw) || raw.length > RELATED_MAX) throw new Error("related");
  const seen = new Set        ();
  return raw.map((row     ) => {
    if (!record(row) || !text(row.id, 64) || seen.has(row.id) || !text(row.title, 200) || !validState(row.state)) throw new Error("link");
    seen.add(row.id);
    return { id: row.id, title: row.title, state: row.state };
  });
}

function artifacts(raw     ) {
  if (!Array.isArray(raw) || raw.length > RELATED_MAX) throw new Error("artifacts");
  const seen = new Set        ();
  return raw.map((row     ) => {
    if (!record(row) || !count(row.id) || seen.has(row.id) || !text(row.name, 120) || /[\\/]/.test(row.name) ||
      !count(row.size) || !count(row.createdAt)) throw new Error("artifact");
    seen.add(row.id);
    const out      = { id: row.id, name: row.name, size: row.size, createdAt: row.createdAt };
    if (typeof row.contentType === "string" && CONTENT_TYPE.test(row.contentType)) out.contentType = row.contentType;
    return out;
  });
}

function artifactResult(got     , request     ) {
  if (!record(got) || !onlyKeys(got, ["token", "card", "attachment", "name", "contentType", "size", "parts"]) ||
    typeof got.token !== "string" || !ARTIFACT_TOKEN.test(got.token) || got.card !== request.id ||
    got.attachment !== request.attachment || !text(got.name, ARTIFACT_NAME_MAX) || /[\\/]/.test(got.name) ||
    got.name.trim() !== got.name || !Number.isSafeInteger(got.size) || got.size < 0 || got.size > BOARD_ARTIFACT_MAX_BYTES ||
    got.parts !== Math.max(1, Math.ceil(got.size / BOARD_EXPORT_PART_BYTES))) throw new Error("artifact");
  if (got.contentType !== undefined && (typeof got.contentType !== "string" || !CONTENT_TYPE.test(got.contentType))) {
    throw new Error("artifact type");
  }
  const out      = { token: got.token, card: got.card, attachment: got.attachment, name: got.name, size: got.size, parts: got.parts };
  if (got.contentType !== undefined) out.contentType = got.contentType;
  return out;
}

function cardDetail(raw     , id        ) {
  const out      = cardRow(raw);
  if (out.id !== id) throw new Error("card id");
  if (prose(raw.brief, 4000)) out.brief = raw.brief;
  if (typeof raw.blockKind === "string" && STATUS.test(raw.blockKind)) out.blockKind = raw.blockKind;
  if (raw.completedAt !== undefined) {
    if (!count(raw.completedAt)) throw new Error("completedAt");
    out.completedAt = raw.completedAt;
  }
  if (prose(raw.result, 1000)) out.result = raw.result;
  if (raw.attentionEvent !== undefined) {
    if (!positive(raw.attentionEvent)) throw new Error("attentionEvent");
    out.attentionEvent = raw.attentionEvent;

    if (raw.attentionHash !== undefined) {
      if (typeof raw.attentionHash !== "string" || !ATTENTION_HASH.test(raw.attentionHash)) throw new Error("attentionHash");
      out.attentionHash = raw.attentionHash;
    }
  } else if (raw.attentionHash !== undefined) {
    throw new Error("attentionHash");
  }
  if (prose(raw.question, 1000)) out.question = raw.question;

  if (raw.blockLoop !== undefined) {
    if (!record(raw.blockLoop) || !onlyKeys(raw.blockLoop, ["kind", "reason"]) || out.state !== "triage") throw new Error("blockLoop");
    const loop      = {};
    if (raw.blockLoop.kind !== undefined) {
      if (typeof raw.blockLoop.kind !== "string" || !STATUS.test(raw.blockLoop.kind)) throw new Error("blockLoop kind");
      loop.kind = raw.blockLoop.kind;
    }
    if (prose(raw.blockLoop.reason, 1000)) loop.reason = raw.blockLoop.reason;
    out.blockLoop = loop;
  }
  if (raw.latestRun !== undefined) out.latestRun = latestRun(raw.latestRun);
  out.parents = related(raw.parents);
  out.children = related(raw.children);
  out.artifacts = artifacts(raw.artifacts);
  if (!count(raw.artifactCount) || raw.artifactCount < out.artifacts.length) throw new Error("artifactCount");
  out.artifactCount = raw.artifactCount;

  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || raw.actions.some((a     ) => !CARD_ACTIONS.includes(a))) throw new Error("actions");
    const order = raw.actions.map((a        ) => CARD_ACTIONS.indexOf(a));
    if (order.some((n        , i        ) => i > 0 && n <= order[i - 1])) throw new Error("actions order");
    out.actions = [...raw.actions];
  }
  if (raw.model !== undefined) {
    if (!text(raw.model, 128)) throw new Error("model");
    out.model = raw.model;
  }
  return out;
}

function timeline(raw     ) {
  if (!Array.isArray(raw) || raw.length > TIMELINE_MAX) throw new Error("timeline");
  let last = Infinity;
  return raw.map((row     ) => {
    if (!record(row) || !positive(row.id) || row.id >= last || !count(row.at)) throw new Error("entry");
    if (typeof row.kind !== "string" || !(row.kind === "other" || STATUS.test(row.kind))) throw new Error("entry kind");
    last = row.id;
    const out      = { id: row.id, kind: row.kind, at: row.at };
    if (row.runId !== undefined) {
      if (!count(row.runId)) throw new Error("entry run");
      out.runId = row.runId;
    }
    if (text(row.author, 64)) out.author = row.author;
    if (prose(row.text, 2000)) out.text = row.text;
    return out;
  });
}

function boardResult(op        , raw     , request      = {})      {
  if (!record(raw)) throw new Error("board");
  const out      = { engine: engine(raw.engine), capabilities: capabilities(raw.capabilities) };
  if (op === "board.boards") out.boards = boards(raw.boards);

  if (op === "board.status" && raw.agentTools !== undefined) out.agentTools = agentTools(raw.agentTools);
  if (op === "board.tools.enable") {
    out.agentTools = agentTools(raw.agentTools);
    if (out.agentTools.state !== "on" || out.agentTools.setup !== "done") throw new Error("agentTools enable");
    return out;
  }
  if (op === "board.policy" || op === "board.policy.set") {
    out.policy = policy(raw.policy);

    if (op === "board.policy.set" && (out.policy.state !== "saved" || out.policy.moments !== request.moments ||
      out.policy.done !== request.done || JSON.stringify(out.policy.quiet) !== JSON.stringify(request.quiet))) throw new Error("policy set");
    return out;
  }
  if (op === "board.watch") {
    out.target = target(raw.target, request.slug);

    if (!record(raw.watch) || raw.watch.id !== request.id || raw.watch.mode !== request.mode) throw new Error("watch");
    out.watch = { id: raw.watch.id, mode: raw.watch.mode };
    return out;
  }
  if (op === "board.create") {

    out.target = target(raw.target, request.slug);
    out.receipt = receipt(raw.receipt, request.key);
    if (out.receipt.state !== "succeeded" || out.receipt.operation !== "create") throw new Error("create receipt");
    return out;
  }
  if (op === "board.verdict") {

    out.target = target(raw.target, request.slug);
    out.receipt = receipt(raw.receipt, request.key);
    if (out.receipt.state !== "succeeded" || out.receipt.operation !== request.verdict || out.receipt.card?.id !== request.id) {
      throw new Error("verdict receipt");
    }
    return out;
  }
  if (op === "board.comment") {

    out.target = target(raw.target, request.slug);
    out.receipt = receipt(raw.receipt, request.key);
    if (out.receipt.state !== "succeeded" || out.receipt.operation !== "comment" || out.receipt.card?.id !== request.id) {
      throw new Error("comment receipt");
    }
    return out;
  }
  if (op === "board.decompose") {

    out.target = target(raw.target, request.slug);
    out.receipt = receipt(raw.receipt, request.key);
    if (out.receipt.state !== "succeeded" || out.receipt.operation !== "decompose" || out.receipt.split.id !== request.id) {
      throw new Error("decompose receipt");
    }
    return out;
  }
  if (op === "board.action") {

    out.target = target(raw.target, request.slug);
    out.receipt = receipt(raw.receipt, request.key);
    if (out.receipt.state !== "succeeded" || out.receipt.operation !== request.action || out.receipt.card?.id !== request.id) {
      throw new Error("action receipt");
    }
    return out;
  }
  if (op === "board.maintenance") {
    out.target = target(raw.target, request.slug);
    if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) throw new Error("anchor");
    out.anchor = raw.anchor;
    out.maintenance = maintenanceResult(raw.maintenance);
    return out;
  }
  if (op === "board.export") {

    out.target = target(raw.target, request.slug);
    const got = raw.export;
    if (!record(got) || !onlyKeys(got, ["id", "name", "size", "parts", "attachments", "logs"]) ||
      typeof got.id !== "string" || !EXPORT_ID.test(got.id) || got.name !== `${request.slug}.tar.gz` ||
      !Number.isSafeInteger(got.size) || got.size <= 0 || got.size > BOARD_EXPORT_MAX_BYTES ||
      got.parts !== Math.max(1, Math.ceil(got.size / BOARD_EXPORT_PART_BYTES)) ||
      got.attachments !== request.attachments || got.logs !== request.logs) throw new Error("export");
    out.export = { id: got.id, name: got.name, size: got.size, parts: got.parts, attachments: got.attachments, logs: got.logs };
    return out;
  }
  if (op === "board.export.part") {

    const got = raw.export;
    if (!record(got) || !onlyKeys(got, ["id", "part", "parts", "data"]) || got.id !== request.id || got.part !== request.part ||
      !Number.isSafeInteger(got.parts) || got.parts <= got.part || got.parts > Math.ceil(BOARD_EXPORT_MAX_BYTES / BOARD_EXPORT_PART_BYTES) ||
      typeof got.data !== "string" || got.data.length === 0 || got.data.length > EXPORT_PART_B64_MAX ||
      got.data.length % 4 !== 0 || !BASE64.test(got.data)) throw new Error("export part");
    out.export = { id: got.id, part: got.part, parts: got.parts, data: got.data };
    return out;
  }
  if (op === "board.artifact") {

    out.target = target(raw.target, request.slug);
    out.artifact = artifactResult(raw.artifact, request);
    return out;
  }
  if (op === "board.artifact.part") {

    const got = raw.artifact;
    if (!record(got) || !onlyKeys(got, ["token", "part", "parts", "data"]) || got.token !== request.token ||
      got.part !== request.part || !Number.isSafeInteger(got.parts) || got.parts <= got.part ||
      got.parts > Math.ceil(BOARD_ARTIFACT_MAX_BYTES / BOARD_EXPORT_PART_BYTES) || typeof got.data !== "string" ||
      (got.data.length === 0 && got.parts !== 1) || got.data.length > EXPORT_PART_B64_MAX ||
      got.data.length % 4 !== 0 || !BASE64.test(got.data)) throw new Error("artifact part");
    out.artifact = { token: got.token, part: got.part, parts: got.parts, data: got.data };
    return out;
  }
  if (op === "board.receipt") {
    out.receipt = receipt(raw.receipt, request.key);
    if (raw.target !== undefined) {
      if (!record(raw.target) || typeof raw.target.slug !== "string" || !SLUG.test(raw.target.slug)) throw new Error("receipt target");
      out.target = target(raw.target, raw.target.slug);
    }
    if (out.receipt.state === "succeeded" && !out.target) throw new Error("receipt target");
    return out;
  }
  if (op === "board.lanes" || op === "board.cards" || op === "board.card" || op === "board.timeline") {
    out.target = target(raw.target, request.slug);
    if (!count(raw.total)) throw new Error("total");
    out.total = raw.total;
  }
  if (op === "board.card" || op === "board.timeline") {
    if (op === "board.card") {
      if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) throw new Error("anchor");

      if (request.anchor !== undefined && raw.anchor !== request.anchor) throw new Error("anchor mismatch");
      out.anchor = raw.anchor;
      out.card = cardDetail(raw.card, request.id);
    }
    out.timeline = timeline(raw.timeline);
    if (raw.nextCursor !== undefined) {
      if (typeof raw.nextCursor !== "string" || !CURSOR.test(raw.nextCursor) || out.timeline.length === 0) throw new Error("cursor");
      out.nextCursor = raw.nextCursor;
    }
  }
  if (op === "board.lanes") {

    if (raw.anchor !== undefined) {
      if (typeof raw.anchor !== "string" || !ANCHOR.test(raw.anchor)) throw new Error("anchor");
      out.anchor = raw.anchor;
    }
    out.lanes = lanes(raw.lanes);
    if (!count(raw.needsYou)) throw new Error("needsYou");
    out.needsYou = raw.needsYou;

    if (raw.failed !== undefined) {
      if (!count(raw.failed)) throw new Error("failed");
      out.failed = raw.failed;
    }
  }
  if (op === "board.cards") {
    out.cards = cards(raw.cards);
    if (raw.nextCursor !== undefined) {
      if (typeof raw.nextCursor !== "string" || !CURSOR.test(raw.nextCursor) || out.cards.length === 0) throw new Error("cursor");
      out.nextCursor = raw.nextCursor;
    }
  }
  return out;
}

module.exports = { BOARD_OPERATIONS, BOARD_READS, BOARD_WRITES, BOARD_UNCERTAIN_WRITES, BOARD_CAPABILITY_KEYS, BOARD_CODES, BOARD_ERRORS, BOARD_MAINTENANCE_OPERATIONS, BOARD_EXPORT_MAX_BYTES, BOARD_EXPORT_PART_BYTES, BOARD_ARTIFACT_OPERATIONS, BOARD_ARTIFACT_MAX_BYTES, boardErrorMessage, boardRequest, boardResult };
