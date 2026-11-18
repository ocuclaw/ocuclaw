const { serviceOfError } = require("../domain/task-run-facts.cjs");
const { TASK_PRESENTATION_DATA_MAX } = require("./glasses-ui-task-presentation.cjs");

const TASK_UNCHECKED_WHY = Object.freeze(["sign_in_expired", "not_allowed", "kept_off", "setup_blocked", "unavailable", "timed_out", "other", "unfit"]         );

const TEMPORARY = new Set        (["unavailable", "timed_out", "other"]);

const TASK_UNCHECKED_STILL_RUNS = 3;

const TASK_UNCHECKED_STILL_MS = 60 * 60 * 1000;

const TASK_UNCHECKED_BUDGET_BYTES = TASK_PRESENTATION_DATA_MAX;

const TASK_UNCHECKED_PROMPT =
  "Use null for a value you could not get (a tool, sign-in or service failed). " +
  "Send a real empty as [], 0 or words, never as null.";

const TASK_FIT_PROMPT =
  "Give every key, each in its declared type: numbers as numbers, yes/no as true or false, lists as lists. " +
  "Put a list's most important rows first.";

const TASK_UNCHECKED_PROMPT_CONTRACT = 2;

const record = (v     )                           => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o     , k        ) => Object.prototype.hasOwnProperty.call(o, k);
const stamp = (v     )                => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const bytes = (v         ) => new TextEncoder().encode(JSON.stringify(v)).length;

function taskUncheckedService(value         )                {
  return typeof value === "string" && value && serviceOfError(value) === value ? value : null;
}

function validTaskUncheckedEntry(raw         )                            {
  if (!record(raw)) return null;
  if (!(TASK_UNCHECKED_WHY                     ).includes(raw.why)) return null;
  const sinceMs = stamp(raw.sinceMs);
  if (sinceMs === null || !Number.isSafeInteger(raw.streak) || raw.streak < 0) return null;
  const lastAtMs = stamp(raw.lastAtMs);
  return {
    why: raw.why,
    service: taskUncheckedService(raw.service),
    lastAtMs,
    last: lastAtMs === null || raw.last === undefined ? null : raw.last,
    streak: raw.streak,
    sinceMs,
  };
}

function validTaskUnchecked(raw         , keys                  = null)                                            {
  if (!record(raw)) return null;
  const out                                     = {};
  for (const key of keys || Object.keys(raw).sort()) {
    if (!own(raw, key)) continue;
    const entry = validTaskUncheckedEntry(raw[key]);
    if (entry) out[key] = entry;
  }
  return Object.keys(out).length ? out : null;
}

function taskUncheckedStill(entry                                       , seenAtMs               )          {
  if (!entry || !TEMPORARY.has(entry.why) || entry.streak < TASK_UNCHECKED_STILL_RUNS) return false;
  return seenAtMs !== null && seenAtMs - entry.sinceMs >= TASK_UNCHECKED_STILL_MS;
}

function hasTaskUnchecked(unchecked         )          {
  return record(unchecked) && Object.keys(unchecked).length > 0;
}

function taskUncheckedDataAtMs(atMs         , unchecked         )                {
  const at = stamp(atMs);
  if (!hasTaskUnchecked(unchecked)) return at;
  let oldest                = at;
  for (const entry of Object.values(unchecked                       )) {
    const good = record(entry) ? stamp(entry.lastAtMs) : null;
    if (good === null) return null;
    if (oldest === null || good < oldest) oldest = good;
  }
  return oldest;
}

function taskUncheckedRunFailure(values         , unchecked         , atMs         )
                                                               {
  const at = stamp(atMs);
  if (at === null || !record(values) || !hasTaskUnchecked(unchecked)) return null;
  const all = Object.values(values);
  if (!all.length || !all.every((value) => value === null)) return null;
  const entries = Object.values(unchecked                       ).filter(record);
  const whys = new Set(entries.map((entry) => entry.why));
  if (whys.has("not_allowed") || whys.has("kept_off")) return null;
  if (whys.size === 1 && whys.has("sign_in_expired")) {
    const services = new Set(entries.map((entry) => taskUncheckedService(entry.service)));
    const [service] = services;
    return { atMs: at, reason: "sign_in_expired", note: services.size === 1 ? service : null };
  }
  return { atMs: at, reason: whys.size === 1 && whys.has("timed_out") ? "timed_out" : "other", note: null };
}

function reasonFor(reasons         , key        )                                                    {
  const raw = record(reasons) && own(reasons, key) ? reasons[key] : null;
  if (!record(raw) || !(TASK_UNCHECKED_WHY                     ).includes(raw.why)) return { why: "other", service: null };
  return { why: raw.why, service: taskUncheckedService(raw.service) };
}

function buildTaskUnchecked(input

 )                                                                                                                    {
  const { keys, values, atMs } = input;
  const prior = input.prior || {};
  const priorValues = record(prior.values) ? prior.values : {};
  const priorAtMs = stamp(prior.atMs);
  const priorUnchecked = validTaskUnchecked(prior.unchecked, keys) || {};
  const out                                     = {};
  for (const key of keys) {
    if (!own(values, key) || values[key] !== null) continue;
    const before = priorUnchecked[key] || null;
    const { why, service } = reasonFor(input.reasons, key);

    let last          = null;
    let lastAtMs                = null;
    if (own(priorValues, key) && priorValues[key] !== null && priorValues[key] !== undefined && priorAtMs !== null) {
      last = priorValues[key];
      lastAtMs = priorAtMs;
    } else if (before) {
      last = before.last;
      lastAtMs = before.lastAtMs;
    }
    let streak = 0;
    let sinceMs = atMs;
    if (TEMPORARY.has(why)) {
      const going = before && TEMPORARY.has(before.why);
      if (prior.same && before) {
        streak = going ? before.streak : 1;
        sinceMs = going ? before.sinceMs : atMs;
      } else {
        streak = going ? before.streak + 1 : 1;
        sinceMs = going ? before.sinceMs : atMs;
      }
    } else if (before && before.why === why) {

      sinceMs = before.sinceMs;
    }
    out[key] = { why, service, lastAtMs, last: lastAtMs === null ? null : last, streak, sinceMs };
  }
  if (!Object.keys(out).length) return { unchecked: null, seenAtMs: atMs };

  const byLastSize = Object.keys(out).filter((key) => out[key].last !== null)
    .sort((a, b) => bytes(out[b].last) - bytes(out[a].last) || (a < b ? -1 : 1));
  const budget = Number.isSafeInteger(input.budgetBytes) && (input.budgetBytes          ) > 0 ? input.budgetBytes           : TASK_UNCHECKED_BUDGET_BYTES;
  while (bytes(values) + bytes(out) > budget && byLastSize.length) {
    out[byLastSize.shift()          ].last = null;
  }
  if (bytes(values) + bytes(out) > budget) return { status: "rejected", code: "card_values_unfit" };
  return { unchecked: out, seenAtMs: atMs };
}

function taskUncheckedLine(entry                    , opts
                                  )         {
  const thing = entry.service || opts.label;
  let head        ;
  if (entry.why === "sign_in_expired") head = entry.service ? `${entry.service} sign-in expired` : "A sign-in expired";
  else if (entry.why === "not_allowed") head = `${thing} needs your OK`;

  else if (entry.why === "unfit") head = `Couldn't use ${opts.label}`;
  else if (entry.why === "kept_off") return `${thing} kept off`;
  else if (entry.why === "setup_blocked") return `${thing} is off in settings`;
  else head = `${taskUncheckedStill(entry, opts.seenAtMs) ? "Still can't" : "Couldn't"} check ${thing}`;
  return entry.lastAtMs === null ? head : `${head} · last ${opts.when(entry.lastAtMs)}`;
}

function fitTaskUncheckedLine(line        , maxBytes        )         {
  const size = (s        ) => new TextEncoder().encode(s).length;
  if (size(line) <= maxBytes) return line;
  const at = line.lastIndexOf(" · last ");
  const tail = at >= 0 ? line.slice(at) : "";
  let head = Array.from(at >= 0 ? line.slice(0, at) : line);
  while (head.length && size(`${head.join("").trimEnd()}…${tail}`) > maxBytes) head = head.slice(0, -1);
  const fitted = head.length ? `${head.join("").trimEnd()}…${tail}` : tail.trim();
  if (size(fitted) <= maxBytes) return fitted;

  let points = Array.from(line);
  while (points.length && size(points.join("")) > maxBytes) points = points.slice(0, -1);
  return points.join("");
}

module.exports = { TASK_UNCHECKED_WHY, TASK_UNCHECKED_STILL_RUNS, TASK_UNCHECKED_STILL_MS, TASK_UNCHECKED_BUDGET_BYTES, TASK_UNCHECKED_PROMPT, TASK_FIT_PROMPT, TASK_UNCHECKED_PROMPT_CONTRACT, taskUncheckedService, validTaskUncheckedEntry, validTaskUnchecked, taskUncheckedStill, hasTaskUnchecked, taskUncheckedDataAtMs, taskUncheckedRunFailure, buildTaskUnchecked, taskUncheckedLine, fitTaskUncheckedLine };
