const { createHash } = require("node:crypto");

const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, canonicalSerialize, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const PROGRAM_CARD_JEV_CAPABILITY = "programCardsJevV1";

const PROGRAM_CARD_JEV_MODEL = "jev-1.14.0";
const PROGRAM_CARD_JEV_FILENAME = "program-card-jev-v1.json";
const PROGRAM_CARD_JEV_DATA_FRAME = "program_card_jev_data";
const PROGRAM_CARD_JEV_STATE_FRAME = "program_card_jev_state";

const PROGRAM_CARD_JEV_CODES = Object.freeze(["off", "not_allowed", "limit", "busy", "timeout", "failed", "paused"]);

const PROGRAM_CARD_JEV_HEALTH_REASONS = Object.freeze([
  "switch_off", "no_key", "invalid", "removed", "waiting", "declined",
  "key_rejected", "unreachable", "call_limit", "call_busy", "call_timeout", "call_failed", "call_misfit",
]);

function healthReasonOf(reason     ) {
  if (reason === "http_401") return "key_rejected";
  if (reason === "network") return "unreachable";
  if (reason === "http_429") return "call_busy";
  if (reason === "timeout") return "call_timeout";
  return "call_failed";
}

const PROGRAM_CARD_JEV_LIMITS = Object.freeze({
  maxUses: 4,
  blockBytesMax: 8192,
  titleMax: 40,
  descriptionMax: 160,
  sendsMax: 120,
  questionMax: 300,
  choicesMin: 2,
  choicesMax: 64,
  choiceTextMax: 200,
  scaleMin: 2,
  scaleMax: 8,
  scaleTextMax: 200,
  askIdMax: 40,
  maxAsksPerFrame: 4,
  askStateBytesMax: 4096,

  maxQueued: 16,
  perCardPerMinute: 20,
  perCardWindowMs: 60_000,
  perHostPerDay: 2000,
  askBudgetMs: 2000,

  askGraceMs: 1000,

  busyPauseMs: 30_000,
  maxHeldPerSub: 4,
  requestWaitMs: 60_000,

  requestGraceMs: 2000,
  requestQuestionMax: 400,
  cardNameMax: 60,
  maxRecords: 64,
  maxSubscriptions: 4,
  leaseMs: 150_000,
});

const L = PROGRAM_CARD_JEV_LIMITS;
const USE_NAME = /^[a-z][A-Za-z0-9_]{0,23}$/;
const CHOICE_KEY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;
const FIELD_LABEL = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

const APP_KEY = /^app:([a-z0-9][a-z0-9._-]{0,63})$/;
const RUN_KEY = /^run:[A-Za-z0-9][A-Za-z0-9._:#-]{0,95}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TEXT_FIELDS                          = [
  ["title", L.titleMax],
  ["description", L.descriptionMax],
  ["sends", L.sendsMax],
  ["question", L.questionMax],
];
const COMMON_FIELDS = ["type", "title", "description", "sends", "question"];
const USE_FIELDS                           = {
  choice: [...COMMON_FIELDS, "choices"],
  noul: COMMON_FIELDS,
  score: [...COMMON_FIELDS, "scale"],
};
const RECORD_STATUSES = new Set(["allowed", "denied", "waiting"]);
const RECORD_FIELDS = new Set(["key", "appId", "name", "digest", "status", "uses", "atMs"]);
const OPS = new Set(["open", "ask", "close", "decide", "remove", "state"]);

const charCount = (text        ) => Array.from(text).length;
const utf8Bytes = (text        ) => new TextEncoder().encode(text).byteLength;
const hasOwn = (object     , key        ) => Object.prototype.hasOwnProperty.call(object, key);
const isFiniteIn = (value     , min        , max        ) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const unit = (value     ) => (isFiniteIn(value, 0, 1) ? value : null);
const fail = (error        ) => ({ ok: false         , error });

function singleLine(raw     , max        )                {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || CONTROL.test(text) || charCount(text) > max) return null;
  return text;
}

const fieldLabel = (key        ) => (FIELD_LABEL.test(key) ? key : "(unnamed)");

function parseChoices(raw     )                                                            {
  let entries                   ;
  if (Array.isArray(raw)) entries = raw.map((key     ) => [key, key]);
  else if (raw && typeof raw === "object") entries = Object.keys(raw).map((key) => [key, raw[key]]);
  else return fail("choices are required: an object of key: text, or a list of keys");
  if (entries.length < L.choicesMin || entries.length > L.choicesMax) {
    return fail(`choices must have ${L.choicesMin} to ${L.choicesMax} entries`);
  }

  const choices      = {};
  for (const [key, text] of entries) {
    if (typeof key !== "string" || !CHOICE_KEY.test(key)) {
      return fail("choice keys are 1 to 32 letters, digits, spaces, _ or -, starting with a letter or digit");
    }
    if (hasOwn(choices, key)) return fail(`choice ${key} is listed twice`);
    const line = singleLine(text, L.choiceTextMax);
    if (line === null) return fail(`choice ${key} text must be 1 to ${L.choiceTextMax} characters of plain text`);
    choices[key] = line;
  }
  return { ok: true, choices };
}

function parseScale(raw     )                                                               {
  if (!Array.isArray(raw) || raw.length < L.scaleMin || raw.length > L.scaleMax) {
    return fail(`scale is required: a list of ${L.scaleMin} to ${L.scaleMax} labels, lowest first`);
  }
  const scale           = [];
  for (const label of raw) {
    const line = singleLine(label, L.scaleTextMax);
    if (line === null) return fail(`each scale label must be 1 to ${L.scaleTextMax} characters of plain text`);
    scale.push(line);
  }
  return { ok: true, scale };
}

function parseUse(name        , spec     , named         )                                                        {
  const at = `use ${name}`;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return fail(`${at} must be an object`);
  const allowed = USE_FIELDS[spec.type === "choice" || spec.type === "noul" || spec.type === "score" ? spec.type : ""];
  if (!allowed) return fail(`${at}: type must be choice, noul or score`);
  const extra = Object.keys(spec).find((key) => !allowed.includes(key) && !(named && key === "name"));
  if (extra !== undefined) return fail(`${at}: unknown field ${fieldLabel(extra)}; allowed: ${allowed.join(", ")}`);
  const use      = { name, type: spec.type };
  for (const [field, max] of TEXT_FIELDS) {
    const line = singleLine(spec[field], max);
    if (line === null) return fail(`${at}: ${field} is required, 1 to ${max} characters of plain text`);
    use[field] = line;
  }
  if (spec.type === "choice") {
    const parsed = parseChoices(spec.choices);
    if (!parsed.ok) return fail(`${at}: ${parsed.error}`);
    use.choices = parsed.choices;
  } else if (spec.type === "score") {
    const parsed = parseScale(spec.scale);
    if (!parsed.ok) return fail(`${at}: ${parsed.error}`);
    use.scale = parsed.scale;
  }
  return { ok: true, use };
}

function parseProgramCardJevUses(raw     )                                                           {
  let pairs                            ;
  if (Array.isArray(raw)) pairs = raw.map((spec     ) => [spec && typeof spec === "object" ? spec.name : undefined, spec, true]);
  else if (raw && typeof raw === "object") pairs = Object.keys(raw).map((name) => [name, raw[name], false]);
  else return fail("jev must be an object of named uses");
  if (pairs.length === 0) return fail("jev declares no uses");
  if (pairs.length > L.maxUses) return fail(`a card may declare at most ${L.maxUses} Jev uses`);
  const seen = new Set();
  const uses        = [];
  for (const [name, spec, named] of pairs) {
    if (typeof name !== "string" || !USE_NAME.test(name)) {
      return fail("Jev use names start with a lowercase letter and use letters, digits or _ (24 at most)");
    }
    if (seen.has(name)) return fail(`use ${name} is declared twice`);
    seen.add(name);
    const parsed = parseUse(name, spec, named);
    if (!parsed.ok) return parsed;
    uses.push(parsed.use);
  }
  const bytes = utf8Bytes(JSON.stringify(uses));
  if (bytes > L.blockBytesMax) return fail(`the jev block is ${bytes} bytes, over ${L.blockBytesMax}`);
  return { ok: true, uses };
}

const askIdOf = (raw     ) =>
  raw && typeof raw === "object" && typeof raw.id === "string" && raw.id.length > 0 && charCount(raw.id) <= L.askIdMax
    ? raw.id
    : null;
const askJevOf = (raw     ) => (raw && typeof raw === "object" && typeof raw.jev === "string" && USE_NAME.test(raw.jev) ? raw.jev : null);

function parseProgramCardJevAsk(raw     , uses     ) {
  const id = askIdOf(raw);
  const jev = askJevOf(raw);
  if (id === null) return { ok: false         , id: null, jev, error: `ask id must be 1 to ${L.askIdMax} characters` };
  const use = Array.isArray(uses) ? uses.find((u     ) => u && u.name === jev) : null;
  if (!use) return { ok: false         , id, jev, error: "ask names no declared Jev use" };
  const state = raw.state;
  const proto = state && typeof state === "object" ? Object.getPrototypeOf(state) : undefined;
  if (Array.isArray(state) || (proto !== Object.prototype && proto !== null)) {
    return { ok: false         , id, jev, error: "ask state must be a plain JSON object" };
  }
  let json     ;
  try {
    json = JSON.stringify(state);
  } catch (_) {
    json = undefined;
  }
  if (typeof json !== "string") return { ok: false         , id, jev, error: "ask state must be a plain JSON object" };
  const bytes = utf8Bytes(json);
  if (bytes > L.askStateBytesMax) {
    return { ok: false         , id, jev, error: `ask state is ${bytes} bytes, over ${L.askStateBytesMax}` };
  }
  return { ok: true         , ask: { id, jev: use.name, state: JSON.parse(json) }, use };
}

function programCardJevDigest(uses     ) {
  return createHash("sha256").update(canonicalSerialize(uses)).digest("hex");
}

function programCardJevQuestion(use     ) {
  if (use.type === "choice") return { type: "choice", instructions: use.question, criteria: { ...use.choices } };
  if (use.type === "score") return { type: "score", instructions: use.question, criteria: [...use.scale] };
  return { type: "noul", instructions: use.question };
}

function programCardJevAnswer(use     , answer     )      {
  const failed = { ok: false, code: "failed" };
  if (!use || !answer || typeof answer !== "object") return failed;
  if (use.type === "choice") {
    if (typeof answer.choice !== "string" || !use.choices || !hasOwn(use.choices, answer.choice)) return failed;
    return { ok: true, choice: answer.choice, confidence: unit(answer.confidence) };
  }
  if (use.type === "noul") return isFiniteIn(answer.noul, 0, 1) ? { ok: true, value: answer.noul } : failed;
  if (use.type === "score" && Array.isArray(use.scale)) {
    return isFiniteIn(answer.score, 0, use.scale.length - 1)
      ? { ok: true, value: answer.score, confidence: unit(answer.confidence) }
      : failed;
  }
  return failed;
}

const appIdOf = (key        ) => {
  const match = APP_KEY.exec(key);
  return match ? match[1] : null;
};
const validKey = (raw     ) => (typeof raw === "string" && (APP_KEY.test(raw) || RUN_KEY.test(raw)) ? raw : null);

function cardName(raw     ) {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text || CONTROL.test(text)) return "Card";
  return Array.from(text).slice(0, L.cardNameMax).join("");
}

const storedUse = (use     ) =>
  use && use.choices && !Array.isArray(use.choices) ? { ...use, choices: Object.entries(use.choices) } : use;

function usesFromFile(raw     ) {
  if (!Array.isArray(raw)) return raw;
  const isPairs = (list     ) => Array.isArray(list) && list.every((pair     ) => Array.isArray(pair) && pair.length === 2);
  return raw.map((use     ) => (use && isPairs(use.choices) ? { ...use, choices: Object.fromEntries(use.choices) } : use));
}

function validStoredRecord(raw     ) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((field) => !RECORD_FIELDS.has(field))) return null;
  const appId = typeof raw.key === "string" ? appIdOf(raw.key) : null;
  if (!appId || raw.appId !== appId) return null;
  if (typeof raw.name !== "string" || cardName(raw.name) !== raw.name) return null;
  if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) return null;
  if (!RECORD_STATUSES.has(raw.status)) return null;
  if (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  const parsed = parseProgramCardJevUses(usesFromFile(raw.uses));
  if (!parsed.ok || programCardJevDigest(parsed.uses) !== raw.digest) return null;
  return { key: raw.key, appId, name: raw.name, digest: raw.digest, status: raw.status, uses: parsed.uses, atMs: raw.atMs };
}

function createProgramCardJevStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, PROGRAM_CARD_JEV_FILENAME);
  const now = typeof opts.now === "function" ? opts.now : Date.now;

  function read() {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      return [];
    }
    let doc     ;
    try {
      doc = JSON.parse(raw);
    } catch (_) {
      return [];
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.cards)) return [];
    if (Object.keys(doc).some((field) => field !== "schemaVersion" && field !== "cards")) return [];
    const out        = [];
    const seen = new Set();
    for (const card of doc.cards) {
      const record = validStoredRecord(card);
      if (!record || seen.has(record.key)) return [];
      seen.add(record.key);

      if (!jevAskFits(record.name, record.uses, L.requestQuestionMax)) continue;
      out.push(record);
    }
    return out.sort((a, b) => b.atMs - a.atMs).slice(0, L.maxRecords);
  }

  function write(records       ) {
    const cards = (Array.isArray(records) ? records : [])
      .filter((r     ) => r && typeof r.key === "string" && appIdOf(r.key))
      .map((r     ) => ({
        key: r.key,
        appId: appIdOf(r.key),
        name: r.name,
        digest: r.digest,
        status: r.status,
        uses: Array.isArray(r.uses) ? r.uses.map(storedUse) : r.uses,
        atMs: Number.isSafeInteger(r.atMs) ? r.atMs : now(),
      }))
      .sort((a     , b     ) => b.atMs - a.atMs)
      .slice(0, L.maxRecords);
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: { schemaVersion: 1, cards } });
  }

  return { file, read, write };
}

function sendsPhrase(sends        ) {
  const [first, second] = Array.from(sends);
  return second && second === second.toLowerCase() && second !== second.toUpperCase() ? first.toLowerCase() + sends.slice(first.length) : sends;
}

function requestQuestion(name        , uses       ) {
  return [`"${name}" wants to ask Jev (TypeSafe):`, ...uses.map((u     ) => `• ${u.title}: sends ${sendsPhrase(u.sends)}`)].join("\n");
}

function jevAskFits(name        , uses       , max        ) {
  return charCount(requestQuestion(name, uses)) <= max;
}

function reasonCode(reason     ) {
  if (reason === "timeout") return "timeout";
  if (reason === "http_429") return "busy";
  if (reason === "no_key" || reason === "disabled") return "off";
  return "failed";
}

const REQUEST_REASONS = new Set(["timeout", "dismissed", "superseded", "display_changed", "cancel"]);

function createProgramCardJev(deps      = {}) {
  const limits = { ...PROGRAM_CARD_JEV_LIMITS, ...(deps.limits || {}) };
  const config = deps.config && typeof deps.config === "object" ? deps.config : {};

  let enabled = config.enabled === true;
  const apiKey = typeof config.apiKey === "string" ? config.apiKey : "";
  const keyed = apiKey !== "";
  const isArmed = () => enabled && keyed;
  const send = typeof deps.send === "function" ? deps.send : () => {};
  const presentDecision = typeof deps.presentDecision === "function" ? deps.presentDecision : () => false;
  const activeSessionKey = typeof deps.sessionKey === "function" ? deps.sessionKey : () => null;
  const createClient = typeof deps.createClient === "function" ? deps.createClient : null;
  const store = deps.store && typeof deps.store.read === "function" ? deps.store : null;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const emitLifecycle = typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};
  const noteActivity = typeof deps.noteActivity === "function" ? deps.noteActivity : () => {};

  const records = new Map();
  const subs = new Map();
  const pending = new Map();
  const queue        = [];
  const windows = new Map();
  const lastAsks = new Map();
  let today = { day: "", count: 0 };
  let inFlight      = null;
  let busyUntil = 0;
  let presence = "unknown";
  let client      = null;
  let generation = 0;

  const cardHash = (key        ) => createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
  const pendingId = (key        , digest        ) => `${key}\n${digest}`;
  const presenceAway = () => presence === "absent" || presence === "in_case";
  const errorCode = (err     ) => (err && typeof err.code === "string" ? err.code.slice(0, 32) : "error");

  function emit(event        , level        , data     ) {
    try {
      emitLifecycle(event, level, data);
    } catch (_) {

    }
  }

  function timer(fn     , ms        ) {
    const handle = setTimeoutFn(fn, Math.max(0, ms));

    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  if (store) {
    try {
      for (const record of store.read()) if (record && typeof record.key === "string") records.set(record.key, record);
    } catch (err     ) {
      emit("program_card_jev_store_failed", "warn", { op: "read", code: errorCode(err) });
    }
  }

  function sendFrame(frame     ) {
    try {
      send(frame);
    } catch (err     ) {
      emit("program_card_jev_send_failed", "warn", { kind: frame.kind || "state", code: errorCode(err) });
    }
  }

  function sendStatus(entry     ) {
    sendFrame({ type: PROGRAM_CARD_JEV_DATA_FRAME, sub: entry.sub, kind: "status", status: entry.status });
  }

  function sendResult(sub        , ask     , result     ) {
    const frame      = { type: PROGRAM_CARD_JEV_DATA_FRAME, sub, kind: "result", id: ask.id, jev: ask.jev, ok: result.ok === true };
    if (frame.ok) {
      if (hasOwn(result, "choice")) frame.choice = result.choice;
      if (hasOwn(result, "value")) frame.value = result.value;
      if (hasOwn(result, "confidence")) frame.confidence = result.confidence;
    } else {
      frame.code = result.code;
    }
    sendFrame(frame);
  }

  const isLive = (entry     ) => !entry.closed && subs.get(entry.sub) === entry && now() <= entry.leaseUntil;

  function answer(job     , code        ) {
    if (isLive(job.entry)) sendResult(job.entry.sub, job.ask, { ok: false, code });
  }

  function stateFrame() {
    const cards = [...records.values()]
      .sort((a     , b     ) => b.atMs - a.atMs)
      .map((r     ) => ({
        key: r.key,
        appId: r.appId,
        name: r.name,
        status: r.status,
        digest: r.digest,
        uses: JSON.parse(JSON.stringify(r.uses)),
        atMs: r.atMs,
      }));
    return { type: PROGRAM_CARD_JEV_STATE_FRAME, armed: isArmed(), enabled, keyed, cards };
  }

  const sendState = () => sendFrame(stateFrame());

  function persist() {
    if (!store || typeof store.write !== "function") return;
    try {
      store.write([...records.values()].filter((r     ) => r.appId));
    } catch (err     ) {
      emit("program_card_jev_store_failed", "warn", { op: "write", code: errorCode(err) });
    }
  }

  function capRecords() {
    for (const saved of [true, false]) {
      const list = [...records.values()].filter((r     ) => !!r.appId === saved);
      if (list.length <= limits.maxRecords) continue;
      list.sort((a     , b     ) => a.atMs - b.atMs);
      for (const r of list.slice(0, list.length - limits.maxRecords)) records.delete(r.key);
    }
  }

  function putRecord(key        , fields     ) {
    const record = { key, appId: appIdOf(key), name: fields.name, digest: fields.digest, status: fields.status, uses: fields.uses, atMs: now() };
    records.delete(key);
    records.set(key, record);
    capRecords();
    if (record.appId) persist();
    return record;
  }

  function recordFor(key        , digest        ) {
    const record = records.get(key);
    return record && record.digest === digest && jevAskFits(record.name, record.uses, limits.requestQuestionMax) ? record : null;
  }

  function statusOf(entry     ) {
    if (!isArmed() || entry.invalid || entry.removed) return "off";
    const record = recordFor(entry.key, entry.digest);
    if (record && record.status === "allowed") return "on";
    if (record && record.status === "denied") return "off";
    return "waiting";
  }

  function refusal(entry     ) {
    if (!isArmed() || entry.invalid) return "off";
    if (entry.removed) return "not_allowed";
    const record = recordFor(entry.key, entry.digest);
    if (record && record.status === "denied") return "not_allowed";
    if (presenceAway()) return "paused";
    if (!record || record.status !== "allowed") return "hold";
    if (now() < busyUntil) return "busy";
    return null;
  }

  function dropSub(entry     , reason        ) {
    entry.closed = true;
    entry.held = [];
    if (subs.get(entry.sub) === entry) subs.delete(entry.sub);
    for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i].entry === entry) queue.splice(i, 1);
    emit("program_card_jev_closed", "debug", { card: cardHash(entry.key), reason });
  }

  function expireSubs() {
    for (const entry of [...subs.values()]) if (now() > entry.leaseUntil) dropSub(entry, "lease_expired");
  }

  function enqueue(job     ) {
    if (queue.length >= limits.maxQueued) {
      noteReason(job.key, job.use.name, "call_limit");
      answer(job, "limit");
    } else queue.push(job);
  }

  function flushHeld(entry     , code        ) {
    const held = entry.held;
    entry.held = [];
    for (const job of held) answer(job, code);
    if (held.length) emit("program_card_jev_held_answered", "debug", { card: cardHash(entry.key), outcome: code, count: held.length });
  }

  function releaseHeld(entry     ) {
    const held = entry.held;
    entry.held = [];
    for (const job of held) {
      const code = refusal(entry);
      if (code === "hold") entry.held.push(job);
      else if (code) answer(job, code);
      else enqueue(job);
    }
  }

  function refreshKey(key        ) {
    for (const entry of [...subs.values()]) {
      if (entry.key !== key) continue;
      if (now() > entry.leaseUntil) {
        dropSub(entry, "lease_expired");
        continue;
      }
      const status = statusOf(entry);
      if (status !== entry.status) {
        entry.status = status;
        sendStatus(entry);
      }
      if (status === "on") releaseHeld(entry);
      else if (status === "off") flushHeld(entry, refusal(entry) || "not_allowed");
      if (status !== "on") {

        for (let i = queue.length - 1; i >= 0; i -= 1) {
          if (queue[i].entry !== entry) continue;
          const [job] = queue.splice(i, 1);
          const code = refusal(entry);
          answer(job, code && code !== "hold" ? code : "not_allowed");
        }
      }
    }
    pump();
  }

  function noAnswerHeld(key        , digest        ) {
    for (const entry of subs.values()) if (entry.key === key && entry.digest === digest) flushHeld(entry, "not_allowed");
  }

  function decideRecord(key        , digest        , status        , source     , via        ) {
    putRecord(key, { name: source.name, digest, status, uses: source.uses });

    for (const entry of subs.values()) if (entry.key === key && entry.digest === digest) entry.removed = false;
    emit("program_card_jev_decided", "info", { card: cardHash(key), status, via });
    sendState();
    refreshKey(key);
  }

  function settle(card     , outcome        , reason        ) {
    if (card.settled) return;
    card.settled = true;
    if (card.timer) clearTimeoutFn(card.timer);
    card.timer = null;
    if (pending.get(card.id) === card) pending.delete(card.id);
    if (outcome === "no_answer") noAnswerHeld(card.key, card.digest);
    emit("program_card_jev_request_done", "info", { card: cardHash(card.key), outcome, reason });
    for (const resolve of card.waiters.splice(0)) resolve({ answer: outcome });
  }

  function onCardDecision(card     , decision     ) {

    if (card.settled) return;
    const choice = decision && decision.choice;
    if (choice === "allow" || choice === "deny") {

      decideRecord(card.key, card.digest, choice === "allow" ? "allowed" : "denied", card, "glasses");
      settle(card, choice === "allow" ? "allowed" : "declined", "selected");
      return;
    }
    const reason = decision && REQUEST_REASONS.has(decision.reason) ? decision.reason : "cancel";
    settle(card, "no_answer", reason);
  }

  function present(card     , cause        , sessionKeyIn     )               {
    let sessionKey = typeof sessionKeyIn === "string" && sessionKeyIn.trim() ? sessionKeyIn.trim() : "";
    if (!sessionKey) {
      try {
        const active = activeSessionKey();
        sessionKey = typeof active === "string" && active.trim() ? active.trim() : "";
      } catch (_) {
        sessionKey = "";
      }
    }
    const hash = cardHash(card.key);
    if (!sessionKey) {
      emit("program_card_jev_request_done", "info", { card: hash, outcome: "no_answer", reason: "no_session" });
      noAnswerHeld(card.key, card.digest);
      return Promise.resolve({ answer: "no_answer" });
    }
    const entry      = { ...card, id: pendingId(card.key, card.digest), waiters: [], settled: false, timer: null };
    const promise = new Promise((resolve) => entry.waiters.push(resolve));
    pending.set(entry.id, entry);
    emit("program_card_jev_request", "info", { card: hash, cause, uses: card.uses.length });
    let accepted = false;
    try {
      const result = presentDecision({
        surface: {
          surfaceId: `card-jev:${hash}:${now().toString(36)}`,
          sessionKey,
          kind: "permission",
          title: "Let this card use Jev?",
          question: card.question,
          options: [
            { key: "allow", label: "Allow" },
            { key: "deny", label: "Not now" },
          ],
          deadlineSec: Math.ceil(limits.requestWaitMs / 1000),
        },
        expiresAtMs: now() + limits.requestWaitMs,
        onDecision: (decision     ) => {
          try {
            onCardDecision(entry, decision);
          } catch (_) {
            settle(entry, "no_answer", "cancel");
          }
        },
      });
      accepted = result === true || (!!result && typeof result === "object" && result.presented === true);
    } catch (_) {
      accepted = false;
    }
    if (!accepted) settle(entry, "no_answer", "presentation_failed");
    else if (!entry.settled) {
      entry.timer = timer(() => {
        entry.timer = null;
        settle(entry, "no_answer", "timeout");
      }, limits.requestWaitMs + limits.requestGraceMs);
    }
    return promise;
  }

  function considerNow(input     )               {

    const cause = input.cause === "open" || input.cause === "edit" ? input.cause : "write";
    const parsed = parseProgramCardJevUses(input.uses);
    if (!parsed.ok) return Promise.resolve({ answer: "invalid", error: parsed.error });
    const key = validKey(input.key);
    if (!key) return Promise.resolve({ answer: "invalid", error: "bad card key" });
    if (!isArmed()) return Promise.resolve({ answer: "off" });
    const uses = parsed.uses;
    const digest = programCardJevDigest(uses);
    const name = cardName(input.name);

    const question = requestQuestion(name, uses);
    const length = charCount(question);
    if (length > limits.requestQuestionMax) {
      return Promise.resolve({
        answer: "invalid",
        error: `the ask would not fit on the glasses (${length} of ${limits.requestQuestionMax} characters): use shorter titles or sends, or declare fewer uses`,
      });
    }
    const existing = recordFor(key, digest);
    if (existing && existing.status === "allowed") return Promise.resolve({ answer: "allowed" });
    if (existing && existing.status === "denied") return Promise.resolve({ answer: "declined" });
    const open = pending.get(pendingId(key, digest));
    if (open) return new Promise((resolve) => open.waiters.push(resolve));

    if (existing && cause === "open") return Promise.resolve({ answer: "no_answer" });
    if (!existing) {

      putRecord(key, { name, digest, status: "waiting", uses });
      sendState();
      refreshKey(key);
    }
    return present({ key, digest, name, uses, question }, cause, input.sessionKey);
  }

  function consider(input     )               {
    try {
      return considerNow(input && typeof input === "object" ? input : {}).catch(() => ({ answer: "no_answer" }));
    } catch (_) {
      return Promise.resolve({ answer: "no_answer" });
    }
  }

  function askOnOpen(entry     ) {
    void consider({ sessionKey: null, key: entry.key, name: entry.name, uses: entry.uses, cause: "open" });
  }

  function carry(from     , entry     ) {
    if (typeof from !== "string" || !RUN_KEY.test(from) || !appIdOf(entry.key)) return false;
    const was = recordFor(from, entry.digest);
    if (!was || (was.status !== "allowed" && was.status !== "denied")) return false;
    const mine = recordFor(entry.key, entry.digest);
    if (mine && mine.status !== "waiting") return false;
    records.delete(from);
    putRecord(entry.key, { name: entry.name, digest: entry.digest, status: was.status, uses: entry.uses });
    emit("program_card_jev_carried", "debug", { card: cardHash(entry.key), status: was.status });
    return true;
  }

  function open(msg     ) {
    const sub = typeof msg.sub === "string" && msg.sub.length <= 80 ? msg.sub : "";
    const key = msg.card && typeof msg.card === "object" ? validKey(msg.card.key) : null;
    if (!sub || !key) {
      emit("program_card_jev_dropped", "debug", { op: "open", reason: "bad_frame" });
      return;
    }
    const name = cardName(msg.card.name);
    const parsed = parseProgramCardJevUses(msg.uses);
    const uses = parsed.ok ? parsed.uses : [];
    const digest = parsed.ok ? programCardJevDigest(uses) : "";
    expireSubs();
    let entry = subs.get(sub);
    if (entry && (entry.key !== key || entry.digest !== digest)) {

      flushHeld(entry, "not_allowed");
      dropSub(entry, "replaced");
      entry = undefined;
    }
    if (!entry) {
      while (subs.size >= limits.maxSubscriptions) dropSub(subs.values().next().value, "evicted");
      entry = { sub, key, name, uses, digest, invalid: !parsed.ok, removed: false, held: [], status: "", leaseUntil: 0, closed: false };
      subs.set(sub, entry);
      if (!parsed.ok) emit("program_card_jev_invalid", "debug", { card: cardHash(key), outcome: "invalid_uses" });
    }
    entry.name = name;

    const tooLong = parsed.ok && !jevAskFits(name, uses, limits.requestQuestionMax);
    if (tooLong && !entry.invalid) emit("program_card_jev_invalid", "debug", { card: cardHash(key), outcome: "ask_too_long" });
    entry.invalid = !parsed.ok || tooLong;
    if (tooLong) flushHeld(entry, "off");
    entry.leaseUntil = now() + limits.leaseMs;
    const carried = parsed.ok && !tooLong ? carry(msg.from, entry) : false;
    entry.status = statusOf(entry);
    sendStatus(entry);
    if (carried) sendState();
    emit("program_card_jev_open", "debug", { card: cardHash(key), uses: uses.length, status: entry.status });
    if (entry.status === "waiting") askOnOpen(entry);
    else if (entry.status === "on") {
      releaseHeld(entry);
      pump();
    }
  }

  function ask(msg     ) {
    const entry = typeof msg.sub === "string" ? subs.get(msg.sub) : null;
    if (!entry) {
      emit("program_card_jev_dropped", "debug", { op: "ask", reason: "unknown_sub" });
      return;
    }
    if (now() > entry.leaseUntil) {
      dropSub(entry, "lease_expired");
      return;
    }
    const list = Array.isArray(msg.asks) ? msg.asks : [];
    list.forEach((raw     , index        ) => {
      const id = askIdOf(raw);
      if (id === null) return;

      const reply = (code        ) => sendResult(entry.sub, { id, jev: askJevOf(raw) || "" }, { ok: false, code });
      if (index >= limits.maxAsksPerFrame) return reply("limit");
      if (!isArmed() || entry.invalid) return reply("off");
      const parsed = parseProgramCardJevAsk(raw, entry.uses);
      if (!parsed.ok) return reply("failed");
      const job = { entry, key: entry.key, ask: parsed.ask, use: parsed.use };

      const same = (other     ) => other && other.entry === entry && other.ask.id === id;
      if (entry.held.some(same) || queue.some(same) || (inFlight && same(inFlight.job))) return;
      const code = refusal(entry);
      if (code === "hold") {
        if (entry.held.length >= limits.maxHeldPerSub) reply("limit");
        else entry.held.push(job);
      } else if (code) reply(code);
      else enqueue(job);
    });
    pump();
  }

  function decide(msg     ) {
    const key = validKey(msg.key);
    const digest = typeof msg.digest === "string" && DIGEST.test(msg.digest) ? msg.digest : "";
    if (!key || !digest || typeof msg.allow !== "boolean") {
      emit("program_card_jev_dropped", "debug", { op: "decide", reason: "bad_frame" });
      return;
    }
    const card = pending.get(pendingId(key, digest));
    const source = recordFor(key, digest) ||
      [...subs.values()].find((e     ) => e.key === key && e.digest === digest && !e.invalid) ||
      card;
    if (!source) {

      emit("program_card_jev_dropped", "debug", { op: "decide", reason: "no_record" });
      sendState();
      return;
    }

    if (msg.allow && !jevAskFits(source.name, source.uses, limits.requestQuestionMax)) {
      emit("program_card_jev_dropped", "debug", { op: "decide", reason: "ask_too_long" });
      sendState();
      return;
    }
    decideRecord(key, digest, msg.allow ? "allowed" : "denied", source, "phone");
    if (card) settle(card, msg.allow ? "allowed" : "declined", "phone");
  }

  function remove(msg     ) {
    const key = validKey(msg.key);
    if (!key) {
      emit("program_card_jev_dropped", "debug", { op: "remove", reason: "bad_frame" });
      return;
    }
    const record = records.get(key);
    if (record) {
      records.delete(key);
      if (record.appId) persist();
    }

    for (const entry of subs.values()) if (entry.key === key) entry.removed = true;
    emit("program_card_jev_removed", "info", { card: cardHash(key), had: !!record });
    sendState();
    refreshKey(key);
  }

  function windowFor(key        ) {
    const since = now() - limits.perCardWindowMs;
    const times = (windows.get(key) || []).filter((at        ) => at > since);
    if (times.length) windows.set(key, times);
    else windows.delete(key);
    return times;
  }

  function dayCount() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (today.day !== day) today = { day, count: 0 };
    return today.count;
  }

  function sendRefusal(job     ) {
    const entry = job.entry;
    if (!isLive(entry)) {
      if (!entry.closed && now() > entry.leaseUntil) dropSub(entry, "lease_expired");
      return "drop";
    }
    const code = refusal(entry);
    if (code) return code === "hold" ? "not_allowed" : code;
    if (windowFor(job.key).length >= limits.perCardPerMinute) return "limit";
    if (dayCount() >= limits.perHostPerDay) return "limit";
    return null;
  }

  function clientFor() {
    if (!isArmed() || !createClient) return null;
    if (!client) {
      try {
        client = createClient({ apiKey, enabled: true, model: PROGRAM_CARD_JEV_MODEL, connection: deps.connection || null });
      } catch (_) {
        client = null;
      }
    }
    return client && typeof client.decide === "function" ? client : null;
  }

  function pauseBusy() {
    busyUntil = now() + limits.busyPauseMs;
    const flushed = queue.splice(0);
    for (const job of flushed) answer(job, "busy");
    emit("program_card_jev_busy", "info", { pauseMs: limits.busyPauseMs, count: flushed.length });
  }

  function noteReason(key        , use        , reason               ) {
    const id = `${key}\n${use}`;
    lastAsks.delete(id);
    if (!reason) return;
    lastAsks.set(id, { reason, atMs: now() });
    while (lastAsks.size > 256) lastAsks.delete(lastAsks.keys().next().value);
  }

  function noteAsk(key        , use        , out     , result     ) {
    if (result && result.ok === true) noteReason(key, use, null);
    else if (out && out.ok === true) noteReason(key, use, "call_misfit");

    else if (out && (out.reason === "no_key" || out.reason === "disabled")) noteReason(key, use, null);
    else noteReason(key, use, healthReasonOf(out && out.reason));
  }

  function health(key     , declared      = null) {
    if (!validKey(key)) return [];
    const entry      = [...subs.values()].find((e     ) => e.key === key && isLive(e));
    const record = records.get(key);

    const named = !entry && !record && Array.isArray(declared)
      ? declared.filter((use     ) => use && typeof use.name === "string" && USE_NAME.test(use.name)).slice(0, limits.maxUses) : [];
    const uses        = entry ? entry.uses : record ? record.uses : named;
    const all = (reason        ) => uses.map((use     ) => ({ part: "jev", use: use.name, reason }));
    if (entry && entry.invalid) return [{ part: "jev", use: "", reason: "invalid" }];
    if (!enabled) return all("switch_off");
    if (!keyed) return all("no_key");
    if (entry && entry.removed) return all("removed");
    const answered = entry ? recordFor(key, entry.digest) : record;
    if (!answered || answered.status === "waiting") return all("waiting");
    if (answered.status === "denied") return all("declined");
    const out        = [];
    for (const use of uses) {
      const last = lastAsks.get(`${key}\n${use.name}`);
      if (last) out.push({ part: "jev", use: use.name, reason: last.reason, atMs: last.atMs });
    }
    return out;
  }

  function healthJudges(key     ) {
    if (!validKey(key)) return "no_record";
    const entry      = [...subs.values()].find((e     ) => e.key === key && isLive(e));
    if (entry && entry.invalid) return "yes";
    const record = records.get(key);
    return (entry ? entry.uses : record ? record.uses : []).length ? "yes" : "no_record";
  }

  function hostHealth() {
    return !enabled ? "switch_off" : !keyed ? "no_key" : "";
  }

  function deliver(job     , out     , ms        ) {
    let result     ;
    if (out && out.ok === true) {
      result = programCardJevAnswer(job.use, out.answers && typeof out.answers === "object" ? out.answers[job.use.name] : null);
    } else {
      result = { ok: false, code: reasonCode(out && out.reason) };
    }
    noteAsk(job.key, job.use.name, out, result);

    const code = refusal(job.entry);
    if (job.switchedOff) result = { ok: false, code: "off" };
    else if (code === "not_allowed" || code === "off") result = { ok: false, code };
    const live = isLive(job.entry);
    if (!live && !job.entry.closed && now() > job.entry.leaseUntil) dropSub(job.entry, "lease_expired");
    emit("program_card_jev_ask", "debug", {
      card: cardHash(job.key),
      use: job.use.name,
      outcome: result.ok ? "ok" : result.code,
      ms: Math.max(0, Math.round(ms)),
      inputTokens: out && Number.isFinite(out.inputTokens) ? out.inputTokens : null,
      delivered: live,
    });
    if (live) sendResult(job.entry.sub, job.ask, result);

    if (out && out.ok !== true && out.reason === "http_429") pauseBusy();
  }

  function start(job     ) {
    const jevClient = clientFor();
    if (!jevClient) {
      answer(job, "off");
      return false;
    }
    windows.set(job.key, [...windowFor(job.key), now()]);
    dayCount();
    today.count += 1;
    try {
      noteActivity();
    } catch (_) {

    }
    const gen = generation;
    const startedAt = now();
    const run      = { job, settled: false, guard: null };
    inFlight = run;
    const finish = (out     ) => {
      if (run.settled) return;
      run.settled = true;
      if (run.guard) clearTimeoutFn(run.guard);
      run.guard = null;
      if (inFlight === run) inFlight = null;
      if (gen !== generation) return;
      try {
        deliver(job, out, out && Number.isFinite(out.ms) ? out.ms : now() - startedAt);
      } catch (_) {
        emit("program_card_jev_dropped", "debug", { op: "result", reason: "error" });
      }
      pump();
    };
    run.guard = timer(() => {
      run.guard = null;
      finish({ ok: false, reason: "timeout" });
    }, limits.askBudgetMs + limits.askGraceMs);
    let call              ;
    try {
      call = Promise.resolve(jevClient.decide(job.ask.state, {
        budgetMs: limits.askBudgetMs,
        questions: { [job.use.name]: programCardJevQuestion(job.use) },
      }));
    } catch (_) {
      call = Promise.resolve({ ok: false, reason: "network" });
    }
    call.then(finish, () => finish({ ok: false, reason: "network" }));
    return true;
  }

  function pump() {
    while (!inFlight && queue.length) {
      const job = queue.shift();
      const code = sendRefusal(job);
      if (code === "drop") continue;
      if (code) {
        if (code === "limit") noteReason(job.key, job.use.name, "call_limit");
        answer(job, code);
        continue;
      }
      start(job);
    }
  }

  return {

    handle(msg     ) {
      const op = msg && typeof msg === "object" && OPS.has(msg.op) ? msg.op : "unknown";
      try {
        if (op === "open") open(msg);
        else if (op === "ask") ask(msg);
        else if (op === "close") {
          const entry = typeof msg.sub === "string" ? subs.get(msg.sub) : null;
          if (entry) dropSub(entry, "closed");
        } else if (op === "decide") decide(msg);
        else if (op === "remove") remove(msg);
        else if (op === "state") sendState();
        else emit("program_card_jev_dropped", "debug", { op, reason: "unknown_op" });
      } catch (_) {
        emit("program_card_jev_dropped", "debug", { op, reason: "error" });
      }
    },

    consider,

    setPresence(value     ) {
      presence = typeof value === "string" ? value : "unknown";
      if (!presenceAway()) return;
      const flushed = queue.splice(0);
      for (const job of flushed) answer(job, "paused");
      if (flushed.length) emit("program_card_jev_paused", "debug", { count: flushed.length });
    },

    state: stateFrame,
    health,
    healthJudges,
    hostHealth,

    askAgainFor(key     , sessionKey     )                         {
      const record = validKey(key) ? records.get(key) : null;
      if (!record || record.status !== "waiting" || !isArmed()) return Promise.resolve(null);
      return consider({ sessionKey, key, name: record.name, uses: record.uses, cause: "edit" }).then((out     ) => String(out?.answer || "no_answer"));
    },
    armed: isArmed,
    setEnabled(value         ) {
      enabled = value === true;
      if (!enabled) {
        if (inFlight) inFlight.job.switchedOff = true;
        for (const job of queue.splice(0)) answer(job, "off");
        for (const entry of subs.values()) flushHeld(entry, "off");
      }
      for (const key of new Set([...subs.values()].map((entry     ) => entry.key))) refreshKey(key);
      if (enabled) for (const entry of subs.values()) if (!entry.removed && statusOf(entry) === "waiting") askOnOpen(entry);
      sendState();
      pump();
      return { enabled };
    },
    stopAll() {
      generation += 1;
      for (const entry of [...subs.values()]) dropSub(entry, "stopped");
      queue.length = 0;
      if (inFlight) {
        inFlight.settled = true;
        if (inFlight.guard) clearTimeoutFn(inFlight.guard);
        inFlight = null;
      }
      for (const card of [...pending.values()]) settle(card, "no_answer", "stopped");
      const owned = client;
      client = null;
      try {
        if (owned && typeof owned.close === "function") Promise.resolve(owned.close()).catch(() => {});
      } catch (_) {

      }
    },
  };
}

module.exports = { PROGRAM_CARD_JEV_CAPABILITY, PROGRAM_CARD_JEV_MODEL, PROGRAM_CARD_JEV_FILENAME, PROGRAM_CARD_JEV_DATA_FRAME, PROGRAM_CARD_JEV_STATE_FRAME, PROGRAM_CARD_JEV_CODES, PROGRAM_CARD_JEV_HEALTH_REASONS, PROGRAM_CARD_JEV_LIMITS, parseProgramCardJevUses, parseProgramCardJevAsk, programCardJevDigest, programCardJevQuestion, programCardJevAnswer, createProgramCardJevStore, createProgramCardJev };
