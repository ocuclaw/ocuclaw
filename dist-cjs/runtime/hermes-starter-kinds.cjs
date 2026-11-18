const { starterCard, starterCardMarkOf } = require("../tools/card-starters.cjs");

const LOOK_AGENDA = "ocuclaw.agenda";
const LOOK_DIGEST = "ocuclaw.digest";
const LOOK_CHECKLIST = "ocuclaw.checklist";
const LOOK_ONE_LINE = "ocuclaw.one-line";

const LOOK_AGENT = "agent";

const DEFAULT_LOOK                              = { brief: LOOK_DIGEST, reminder: LOOK_ONE_LINE, alert: LOOK_ONE_LINE };

const STARTER_KINDS                                      = Object.freeze({
  "morning-brief": { kind: "brief", look: LOOK_AGENDA, hidden: true },

  "evening-winddown": { kind: "brief", look: LOOK_DIGEST },
  "learn-daily": { kind: "brief", look: LOOK_AGENT },
  "on-this-day": { kind: "brief", look: LOOK_ONE_LINE },
  "weekly-review": { kind: "brief", look: LOOK_DIGEST },
  "news-digest": { kind: "brief", look: LOOK_DIGEST },
  "meal-plan": { kind: "brief", look: LOOK_DIGEST },
  "workday-start": { kind: "reminder", look: LOOK_ONE_LINE },
  "custom-reminder": { kind: "reminder", look: LOOK_ONE_LINE, hidden: true },
  "hydration-move": { kind: "reminder", look: LOOK_ONE_LINE },
  "gratitude-journal": { kind: "reminder", look: LOOK_ONE_LINE },
  "bill-renewal-watch": { kind: "reminder", look: LOOK_ONE_LINE },
  "habit-checkin": { kind: "reminder", look: LOOK_CHECKLIST },
  "important-mail": { kind: "alert", look: LOOK_ONE_LINE },
  "price-watch": { kind: "alert", look: LOOK_ONE_LINE },
  "competitor-watch": { kind: "alert", look: LOOK_DIGEST },
  "ocuclaw:glasses-brief": { kind: "brief", look: LOOK_AGENDA },
  "ocuclaw:day-wrap": { kind: "brief", look: LOOK_DIGEST },
  "ocuclaw:glance-reminder": { kind: "reminder", look: LOOK_ONE_LINE },
});

const SKILL_NEEDS                                              = Object.freeze({
  "google-workspace": ["calendar", "mail"],
  "email-inbox-triage": ["mail"],
});

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object = (v     ) => v && typeof v === "object" && !Array.isArray(v);
const text = (v     , max = 500) => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v : "";
const strings = (v     , max = 160, count = 20) => (Array.isArray(v) ? v : []).slice(0, count).map((s     ) => text(s, max)).filter(Boolean);

function isInterval(scheduleTemplate        )          {
  const [minute = "", hour = ""] = scheduleTemplate.trim().split(/\s+/);
  return minute.includes("/") || hour.includes("/");
}

function starterKind(raw                                                                )                                                       {
  const key = text(raw.key, 128);
  const plugin = key.includes(":");
  const mapped = STARTER_KINDS[key];
  const tagged = strings(raw.tags).map(t => /^kind:(brief|reminder|alert)$/.exec(t)?.[1]).find(Boolean)                           ;
  let kind             ;
  if (tagged) kind = tagged;
  else if (mapped) kind = mapped.kind;
  else if (isInterval(text(raw.scheduleTemplate))) kind = "alert";
  else if (/reminder|nudge|prompt/i.test(`${key} ${text(raw.title, 120)}`)) kind = "reminder";
  else kind = "brief";
  const look = mapped && mapped.kind === kind ? mapped.look : DEFAULT_LOOK[kind];

  return { kind, look, hidden: !plugin && mapped?.hidden === true };
}

function starterNeeds(skills     )           {
  const needs = new Set        ();
  for (const skill of strings(skills)) for (const need of SKILL_NEEDS[skill] ?? []) needs.add(need);
  return [...needs].sort();
}

const DAYS_PER_MONTH = 365.25 / 12;

function fieldCount(field        , min        , max        , wrapSeven = false)                {
  const hits = new Set        ();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min, hi = max;
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-").map(Number);
      lo = a; hi = b === undefined ? (match[2] === undefined ? a : max) : b;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) hits.add(wrapSeven && v === 7 ? 0 : v);
  }
  return hits.size;
}

function runsPerMonth(schedule     )                {
  const fields = text(schedule).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  const minutes = fieldCount(minute, 0, 59), hours = fieldCount(hour, 0, 23);
  const days = fieldCount(dom, 1, 31), months = fieldCount(month, 1, 12), weekdays = fieldCount(dow, 0, 7, true);
  if ([minutes, hours, days, months, weekdays].some(n => n === null)) return null;

  const byDom = dom === "*" ? null : days  * (DAYS_PER_MONTH / 31);
  const byDow = dow === "*" ? null : DAYS_PER_MONTH * weekdays  / 7;
  const daysPerMonth = byDom === null && byDow === null ? DAYS_PER_MONTH
    : Math.min(DAYS_PER_MONTH, (byDom ?? 0) + (byDow ?? 0));
  return Math.round(minutes  * hours  * daysPerMonth * months  / 12);
}

function slot(raw     )      {
  if (!object(raw) || !/^[A-Za-z_]\w{0,63}$/.test(raw.name)) return null;
  return { name: raw.name, type: text(raw.type, 32), label: text(raw.label, 160),
    default: typeof raw.default === "number" && Number.isFinite(raw.default) ? String(raw.default) : text(raw.default, 4000),
    options: strings(raw.options, 160, 100), optional: raw.optional === true, strict: raw.strict !== false, help: text(raw.help, 500) };
}

function prefill(raw     )      {
  if (!object(raw)) return null;
  const out = { name: text(raw.name), prompt: text(raw.prompt, 16000), schedule: text(raw.schedule), deliver: text(raw.deliver) };
  return out.prompt && out.schedule ? out : null;
}

const KINDS = new Set(["brief", "reminder", "alert"]);
const LOOKS = new Set([LOOK_AGENDA, LOOK_DIGEST, LOOK_CHECKLIST, LOOK_ONE_LINE, LOOK_AGENT]);

function curated(raw     , key        , title        , plugin        , filled     ) {
  if (typeof raw.kind === "string") {
    const kind = KINDS.has(raw.kind) ? raw.kind                : "brief";
    return { glasses: plugin === "ocuclaw" && raw.glasses === true, kind,
      look: LOOKS.has(raw.look) ? raw.look : DEFAULT_LOOK[kind], hidden: raw.hidden === true,
      needs: strings(raw.needs, 32).sort(),
      runsPerMonth: Number.isSafeInteger(raw.runsPerMonth) && raw.runsPerMonth >= 0 ? raw.runsPerMonth : null };
  }
  const tags = strings(raw.tags, 64);
  return { glasses: plugin === "ocuclaw" && tags.includes("glasses"),
    ...starterKind({ key, title, tags, scheduleTemplate: raw.scheduleTemplate }),
    needs: starterNeeds(raw.skills),
    runsPerMonth: filled ? runsPerMonth(filled.schedule) : null };
}

function starterRow(raw     )      {
  if (!object(raw) || typeof raw.key !== "string" || !KEY.test(raw.key)) return null;
  const title = text(raw.title, 120);
  if (!title) return null;
  const plugin = text(raw.plugin, 64);
  const filled = prefill(raw.prefill);
  const { glasses, kind, look, hidden, needs, runsPerMonth: runs } = curated(raw, raw.key, title, plugin, filled);
  const card = typeof raw.kind === "string" && plugin === "ocuclaw" ? starterCardMarkOf(raw.card, raw.key) : null;
  return {
    key: raw.key, title, description: text(raw.description, 4000),

    plugin, glasses, kind, look, hidden, needs,

    category: text(raw.category, 64), tags: strings(raw.tags, 64),
    iconId: typeof raw.iconId === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(raw.iconId) ? raw.iconId : "",
    runsPerMonth: runs,
    slots: (Array.isArray(raw.slots) ? raw.slots : []).slice(0, 20).map(slot).filter(Boolean),
    prefill: filled,

    promptTemplate: text(raw.promptTemplate, 16000),
    skills: strings(raw.skills, 160, 20),

    ...(card ? { card } : {}),
  };
}

function withStarterCards(rows       )        {
  return rows.map((row) => {
    if (!object(row)) return row;
    const { card: _old, ...rest } = row;
    const card = starterCard(row);
    return card ? { ...rest, card } : rest;
  });
}

function starterRows(raw     )        {
  const seen = new Set        ();
  const rows        = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, 100) : []) {
    const row = starterRow(entry);
    if (!row || seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  return rows;
}

module.exports = { LOOK_AGENDA, LOOK_DIGEST, LOOK_CHECKLIST, LOOK_ONE_LINE, LOOK_AGENT, STARTER_KINDS, starterKind, starterNeeds, runsPerMonth, starterRow, withStarterCards, starterRows };
