const { checkLiveUiInputValue } = require("./liveui-compiler/template-inputs.cjs");

const { clampLiveUiText } = require("./liveui-compiler/surface-forms.cjs");

const TEXT_MAX_BYTES = 999;

const LIST_MAX_ITEMS = 20;

const record = (v         )                           => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o     , k        ) => Object.prototype.hasOwnProperty.call(o, k);
const utf8 = new TextEncoder();
const bytes = (v         ) => utf8.encode(JSON.stringify(v)).length;

const NUMBER_TEXT = /^[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const YES = new Set(["true", "yes", "1"]);
const NO = new Set(["false", "no", "0"]);

function parseTaskNumber(text        )                {
  const trimmed = text.trim();
  if (!NUMBER_TEXT.test(trimmed)) return null;
  const n = Number(trimmed.replace(/−/, "-").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseTaskBool(value         )                 {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  if (YES.has(word)) return true;
  if (NO.has(word)) return false;
  return null;
}

const blank = (v         ) => typeof v === "string" && v.trim() === "";

function fitText(text        , maxBytes        )         {
  if (utf8.encode(text).length <= maxBytes) return { kind: "ok", value: text, cut: false };
  const cut = clampLiveUiText(text, maxBytes);

  if (cut === "" || cut === "…") return { kind: "unfit" };
  return { kind: "ok", value: cut, cut: true };
}

function fitScalar(type        , value         , maxBytes        )         {
  if (type === "number") {
    if (typeof value === "number") return Number.isFinite(value) ? { kind: "ok", value, cut: false } : { kind: "unfit" };
    if (blank(value)) return { kind: "missing" };
    const n = typeof value === "string" ? parseTaskNumber(value) : null;
    return n === null ? { kind: "unfit" } : { kind: "ok", value: n, cut: false };
  }
  if (type === "bool") {
    if (blank(value)) return { kind: "missing" };
    const b = parseTaskBool(value);
    return b === null ? { kind: "unfit" } : { kind: "ok", value: b, cut: false };
  }
  if (type === "text") {
    if (typeof value === "number" && Number.isFinite(value)) return fitText(String(value), maxBytes);
    if (typeof value !== "string") return { kind: "unfit" };
    return fitText(value, maxBytes);
  }

  return { kind: "unfit" };
}

function numberInRange(input                     , n        )          {
  return !((input.min !== undefined && n < input.min) || (input.max !== undefined && n > input.max));
}

function add(fixes                            , key        , kind                  , n = 1) {
  if (n <= 0) return;
  const entry = fixes[key] || (fixes[key] = {});
  entry[kind] = (entry[kind] || 0) + n;
}

function fitList(input                     , raw         )          {
  if (!Array.isArray(raw)) return { kind: "unfit" };
  let cut = 0;
  let dropped = 0;
  const kept            = [];
  if (input.fields) {
    for (const row of raw) {
      if (!record(row)) {
        dropped += 1;
        continue;
      }
      const out                          = {};
      let rowDropped = 0;
      let rowCut = 0;
      for (const [name, fieldType] of Object.entries(input.fields)) {
        if (!own(row, name) || row[name] === null || row[name] === undefined) continue;
        const fitted = fitScalar(fieldType, row[name], TEXT_MAX_BYTES);
        if (fitted.kind === "missing") continue;
        if (fitted.kind === "unfit") {
          rowDropped += 1;
          continue;
        }
        if (fitted.cut) rowCut += 1;
        out[name] = fitted.value;
      }

      if (!Object.keys(out).length) {
        dropped += 1;
        continue;
      }
      dropped += rowDropped;
      cut += rowCut;
      kept.push(out);
    }
  } else {
    const of = input.of ?? "text";
    for (const entry of raw) {
      if (entry === null) {
        kept.push(null);
        continue;
      }
      const fitted = fitScalar(of, entry, TEXT_MAX_BYTES);
      if (fitted.kind === "missing") {
        kept.push(null);
        continue;
      }
      if (fitted.kind === "unfit") {
        dropped += 1;
        continue;
      }
      if (fitted.cut) cut += 1;
      kept.push(fitted.value);
    }
  }

  if (raw.length > 0 && kept.length === 0) return { kind: "unfit" };
  const maxItems = input.maxItems ?? LIST_MAX_ITEMS;
  const hidden = Math.max(0, kept.length - maxItems);
  if (hidden) kept.length = maxItems;
  return { kind: "ok", value: kept, cut, dropped, hidden };
}

const NULL_ENTRY_RESERVE = bytes({ why: "sign_in_expired", service: "x".repeat(40), lastAtMs: null, last: null,
  streak: 99999, sinceMs: 9999999999999 });

function fitTaskValues(inputs                       , raw         , opts                           = {})                {
  if (!record(raw)) return { status: "refused", code: "card_values_invalid" };
  const declared = new Set(inputs.map((input) => input.key));
  const extra = Object.keys(raw).filter((key) => !declared.has(key));
  const values                          = {};
  const fixes                             = {};
  const unfit           = [];
  const missing           = [];
  for (const input of inputs) {
    const key = input.key;
    if (!own(raw, key) || raw[key] === undefined) {
      values[key] = null;
      missing.push(key);
      continue;
    }
    const value = raw[key];
    if (value === null) {

      values[key] = null;
      continue;
    }
    if (input.type === "list") {
      const fitted = fitList(input, value);
      if (fitted.kind === "unfit") {
        values[key] = null;
        unfit.push(key);
        continue;
      }
      values[key] = fitted.value;
      add(fixes, key, "dropped", fitted.dropped);
      add(fixes, key, "cut", fitted.cut);
      add(fixes, key, "hidden", fitted.hidden);
      continue;
    }
    const fitted = fitScalar(input.type, value, input.type === "text" ? input.maxBytes ?? TEXT_MAX_BYTES : TEXT_MAX_BYTES);
    if (fitted.kind === "missing") {
      values[key] = null;
      missing.push(key);
      continue;
    }
    if (fitted.kind === "unfit" || (input.type === "number" && !numberInRange(input, fitted.value          ))) {
      values[key] = null;
      unfit.push(key);
      continue;
    }
    values[key] = fitted.value;
    if (fitted.cut) add(fixes, key, "cut");
  }
  const budget = Number.isSafeInteger(opts.budgetBytes) && (opts.budgetBytes          ) > 0 ? opts.budgetBytes           : null;
  if (budget !== null) {
    const nulls = Object.keys(values).filter((key) => values[key] === null).length;
    const size = () => bytes(values) + bytes(fixes) + nulls * NULL_ENTRY_RESERVE;
    while (size() > budget) {

      let longest                = null;
      for (const key of Object.keys(values)) {
        const list = values[key];
        if (Array.isArray(list) && list.length > 1 && (longest === null || bytes(list) > bytes(values[longest]))) longest = key;
      }
      if (longest === null) return { status: "refused", code: "card_values_unfit" };
      (values[longest]             ).pop();
      add(fixes, longest, "hidden");
    }
  }

  for (const input of inputs) {
    if (!checkLiveUiInputValue(input, values[input.key]).ok) return { status: "refused", code: "card_values_unfit" };
  }
  return { status: "fitted", values, fixes, unfit, missing, extra };
}

function taskFitReasons(fit                     , hostReasons          = null)                          {
  const out                          = record(hostReasons) ? { ...hostReasons } : {};
  for (const key of fit.unfit) out[key] = { why: "unfit" };
  return out;
}

function validTaskFixes(raw         , keys                  = null)                                    {
  if (!record(raw)) return null;
  const out                             = {};
  for (const key of keys || Object.keys(raw).sort()) {
    if (!own(raw, key) || !record(raw[key])) continue;
    const entry             = {};
    for (const kind of ["hidden", "cut", "dropped"]         ) {
      const n = raw[key][kind];
      if (Number.isSafeInteger(n) && n > 0 && n <= 100000) entry[kind] = n;
    }
    if (Object.keys(entry).length) out[key] = entry;
  }
  return Object.keys(out).length ? out : null;
}

function taskFitLog(fit                                              )                {
  const parts           = [];
  if (fit.extra.length) parts.push(`extra=${fit.extra.filter((key) => /^[A-Za-z0-9_-]{1,40}$/.test(key)).slice(0, 8).join(",")}`);
  if (fit.missing.length) parts.push(`missing=${fit.missing.join(",")}`);
  if (fit.unfit.length) parts.push(`unfit=${fit.unfit.join(",")}`);
  for (const [key, fix] of Object.entries(fit.fixes)) {
    parts.push(`${key}:${Object.entries(fix).map(([kind, n]) => `${kind}${n}`).join("/")}`);
  }
  return parts.length ? parts.join(" ") : null;
}

module.exports = { parseTaskNumber, parseTaskBool, fitTaskValues, taskFitReasons, validTaskFixes, taskFitLog };
