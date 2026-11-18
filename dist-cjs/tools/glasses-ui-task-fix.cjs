const { clampLiveUiText } = require("./liveui-compiler/surface-forms.cjs");

const TASK_FIX_RUNS = 2;

const TASK_FIX_SPAN_MS = 60 * 60 * 1000;

const TASK_FIX_KEPT_MAX_BYTES = 16 * 1024;

const TASK_FIX_QUOTE_GRAPHEMES = 40;

const TASK_FIX_CAPABILITY = "programCardsTaskFixV1";

const TASK_FIX_KINDS = Object.freeze(["wrong_type", "words_not_list", "rows_unusable", "other"]         );

const TASK_FIX_CAME = Object.freeze(["text", "number", "bool", "list", "object"]         );
const WANTS = new Set(["text", "number", "bool", "list"]);

const TASK_FIX_CHECKS = Object.freeze(["fits", "needs_fix", "blocked", "none", "never_opened", "still_fails",

  "card_changed",

  "other_cases"]         );

const TASK_FIX_DONE_MS = 24 * 60 * 60 * 1000;
const SOURCES = new Set(["schedule", "run", "test"]);
const MAX_KEYS = 8;
const MAX_TRIES = 99;
const MAX_ROWS = 100000;

const record = (v         )                           => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o     , k        ) => Object.prototype.hasOwnProperty.call(o, k);
const stamp = (v         )              => Number.isSafeInteger(v) && (v          ) >= 0;
const utf8 = new TextEncoder();
const bytes = (v         ) => utf8.encode(JSON.stringify(v)).length;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const graphemes                                                                  =
  typeof Intl !== "undefined" && typeof (Intl       ).Segmenter === "function"
    ? new (Intl       ).Segmenter(undefined, { granularity: "grapheme" }) : null;

function taskFixCame(value         )         {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  return Array.isArray(value) ? "list" : "object";
}

function taskFixQuote(value         )                {
  let text        ;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else return null;
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const parts = graphemes ? [...graphemes.segment(text)].map((g) => g.segment) : Array.from(text);
  if (parts.length <= TASK_FIX_QUOTE_GRAPHEMES) return text;
  return `${parts.slice(0, TASK_FIX_QUOTE_GRAPHEMES).join("").trimEnd()}…`;
}

function taskFixProblem(input                  , raw         )                                                {
  const wants = WANTS.has(input?.type) ? input.type : "text";
  const came = taskFixCame(raw);
  const quote = taskFixQuote(raw);
  const quoted = quote ? { quote } : {};
  if (wants === "list") {
    if (Array.isArray(raw)) return { kind: "rows_unusable", wants, came, rows: Math.min(raw.length, MAX_ROWS) };
    if (typeof raw === "string") return { kind: "words_not_list", wants, came, ...quoted };
    return { kind: "wrong_type", wants, came, ...quoted };
  }

  if (came === wants) return { kind: "other", wants, came };
  return { kind: "wrong_type", wants, came, ...quoted };
}

function nextTaskFix(prior                                 , delivery

 )                      {
  const before = record(prior) && record(prior.keys) ? prior : null;
  const unfit = new Set(Array.isArray(delivery.unfit) ? delivery.unfit : []);
  const raw = record(delivery.raw) ? delivery.raw : {};
  const keys                             = {};
  for (const input of delivery.inputs) {
    const key = input.key;
    const was = before && own(before.keys, key) ? before.keys[key] : null;
    if (unfit.has(key)) {
      keys[key] = { runs: Math.min((was?.runs || 0) + 1, MAX_ROWS), sinceMs: was ? was.sinceMs : delivery.atMs, atMs: delivery.atMs,
        ...taskFixProblem(input, raw[key]) };
    } else if (was && (!own(delivery.values, key) || delivery.values[key] === null)) {
      keys[key] = was;
    }
  }
  if (!Object.keys(keys).length) return null;
  const next               = { keys };
  let kept = before?.kept || null;
  if (unfit.size) {

    let copy      = null;
    try { copy = JSON.parse(JSON.stringify(raw)); } catch (_) { copy = null; }
    kept = record(copy) && bytes(copy) <= TASK_FIX_KEPT_MAX_BYTES
      ? { card: copy, atMs: delivery.atMs, source: SOURCES.has(delivery.source) ? delivery.source : "run",
        ...(typeof delivery.deliveryId === "string" && ID_RE.test(delivery.deliveryId) ? { deliveryId: delivery.deliveryId } : {}) }
      : null;
  }
  if (kept) next.kept = kept;
  if (before?.tries) next.tries = before.tries;
  if (stamp(before?.notNowAtMs)) next.notNowAtMs = before.notNowAtMs;
  return next;
}

function validKey(raw         )                    {
  if (!record(raw) || !Number.isSafeInteger(raw.runs) || raw.runs < 1 || raw.runs > MAX_ROWS) return null;
  if (!stamp(raw.sinceMs) || !stamp(raw.atMs) || raw.atMs < raw.sinceMs) return null;
  if (!(TASK_FIX_KINDS                     ).includes(raw.kind) || !WANTS.has(raw.wants) ||
      !(TASK_FIX_CAME                     ).includes(raw.came)) return null;
  const out             = { runs: raw.runs, sinceMs: raw.sinceMs, atMs: raw.atMs, kind: raw.kind, wants: raw.wants, came: raw.came };
  if (typeof raw.quote === "string") {
    const quote = taskFixQuote(raw.quote.endsWith("…") ? raw.quote.slice(0, -1) : raw.quote);
    if (quote) out.quote = raw.quote.endsWith("…") && !quote.endsWith("…") ? `${quote}…` : quote;
  }
  if (Number.isSafeInteger(raw.rows) && raw.rows >= 0 && raw.rows <= MAX_ROWS) out.rows = raw.rows;
  return out;
}

function validTaskFix(raw         , keys          )                      {
  if (!record(raw) || !record(raw.keys)) return null;
  const out               = { keys: {} };
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (!KEY_RE.test(key) || !own(raw.keys, key)) continue;
    const entry = validKey(raw.keys[key]);
    if (entry) out.keys[key] = entry;
  }
  if (!Object.keys(out.keys).length) return null;
  const kept = raw.kept;
  if (record(kept) && record(kept.card) && stamp(kept.atMs) && SOURCES.has(kept.source) && bytes(kept.card) <= TASK_FIX_KEPT_MAX_BYTES) {
    out.kept = { card: kept.card, atMs: kept.atMs, source: kept.source,
      ...(typeof kept.deliveryId === "string" && ID_RE.test(kept.deliveryId) ? { deliveryId: kept.deliveryId } : {}) };
  }
  const tries = raw.tries;
  if (record(tries) && Number.isSafeInteger(tries.count) && tries.count >= 0 && tries.count <= MAX_TRIES) {
    const last = record(tries.last) && (TASK_FIX_CHECKS                     ).includes(tries.last.check) && stamp(tries.last.atMs)
      ? { check: tries.last.check, atMs: tries.last.atMs } : null;
    out.tries = { count: tries.count, ...(last ? { last } : {}) };
  }
  if (stamp(raw.notNowAtMs)) out.notNowAtMs = raw.notNowAtMs;
  return out;
}

function taskFixDue(entry                               )          {
  return !!entry && entry.runs >= TASK_FIX_RUNS && entry.atMs - entry.sinceMs >= TASK_FIX_SPAN_MS;
}

function taskFixOffer(fix                                 , inputs                                        ) {
  if (!fix || !record(fix.keys)) return null;
  for (const input of inputs) {
    const entry = own(fix.keys, input.key) ? fix.keys[input.key] : null;
    if (!taskFixDue(entry) || (stamp(fix.notNowAtMs) && fix.notNowAtMs >= (entry              ).sinceMs)) continue;
    const due = entry              ;
    return {
      key: input.key,
      ...(typeof input.label === "string" && input.label ? { label: input.label } : {}),
      kind: due.kind,
      wants: due.wants,
      came: due.came,
      runs: due.runs,
      sinceMs: due.sinceMs,
      atMs: due.atMs,
      ...(typeof due.quote === "string" ? { quote: due.quote } : {}),
      ...(Number.isSafeInteger(due.rows) ? { rows: due.rows } : {}),
      tries: fix.tries ? fix.tries.count : 0,
      ...(fix.tries?.last ? { lastCheck: fix.tries.last.check } : {}),
    };
  }
  return null;
}

function taskFixNotNow(fix                                 , atMs        )                      {
  if (!fix || !record(fix.keys) || !Object.keys(fix.keys).length || !stamp(atMs)) return null;
  return { ...fix, notNowAtMs: atMs };
}

function taskFixTry(fix                                 , check        , atMs        , counts         )                      {
  if (!fix || !record(fix.keys) || !(TASK_FIX_CHECKS                     ).includes(check) || !stamp(atMs)) return null;
  const count = Math.min((fix.tries?.count || 0) + (counts ? 1 : 0), MAX_TRIES);
  return { ...fix, tries: { count, last: { check, atMs } } };
}

function taskFixEnding(outcome         , check     )                                            {
  if (outcome === "said_no" || outcome === "no_answer") return null;
  const verdict = check && typeof check.verdict === "string" ? check.verdict : null;
  let word = outcome === "failed" ? "never_opened" : verdict || "none";
  if ((word === "needs_fix" || word === "blocked") && check.real === true && check.keptFailed !== true) word = "other_cases";
  return { check: word, counts: word === "never_opened" || word === "needs_fix" || word === "blocked" || word === "other_cases" };
}

function taskFixDoneOpen(fixed     , nowMs        )          {
  return record(fixed) && stamp(fixed.atMs) && !stamp(fixed.closedAtMs) && nowMs - fixed.atMs < TASK_FIX_DONE_MS;
}

function taskFixDone(fixed     , inputs                                        , nowMs        , notSynced = false) {
  if (!taskFixDoneOpen(fixed, nowMs) || typeof fixed.key !== "string" || typeof fixed.change !== "string") return null;
  const input = inputs.find((entry) => entry.key === fixed.key);
  return {
    atMs: fixed.atMs,
    key: fixed.key,
    ...(typeof input?.label === "string" && input.label ? { label: input.label } : {}),
    change: fixed.change,
    revision: fixed.revision,
    ...(stamp(fixed.stillFailsAtMs) ? { stillFails: true } : {}),
    ...(notSynced ? { notSynced: true } : {}),
  };
}

function taskFixStillFails(fixed     , fix                                 , unfit          , atMs        ) {
  if (!record(fixed) || stamp(fixed.stillFailsAtMs) || !Array.isArray(unfit) || !unfit.includes(fixed.key) || !stamp(atMs)) return null;
  const tries = Number.isSafeInteger(fixed.tries) && fixed.tries >= 0 ? fixed.tries : 0;
  const next = fix && record(fix.keys) ? taskFixTry({ ...fix, tries: { count: Math.max(tries, fix.tries?.count || 0) } }, "still_fails", atMs, true) : null;
  return { fixed: { ...fixed, stillFailsAtMs: atMs }, fix: next };
}

function taskFixLog(fix                     )                {
  if (!fix) return null;
  const parts = Object.entries(fix.keys).map(([key, entry]) => `${key}:${entry.kind}/runs${entry.runs}${taskFixDue(entry) ? "/due" : ""}`);
  return parts.length ? parts.join(" ") : null;
}

module.exports = { TASK_FIX_RUNS, TASK_FIX_SPAN_MS, TASK_FIX_KEPT_MAX_BYTES, TASK_FIX_QUOTE_GRAPHEMES, TASK_FIX_CAPABILITY, TASK_FIX_KINDS, TASK_FIX_CAME, TASK_FIX_CHECKS, TASK_FIX_DONE_MS, taskFixCame, taskFixQuote, taskFixProblem, nextTaskFix, validTaskFix, taskFixDue, taskFixOffer, taskFixNotNow, taskFixTry, taskFixEnding, taskFixDoneOpen, taskFixDone, taskFixStillFails, taskFixLog };
