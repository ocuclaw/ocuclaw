const { fitTaskValues } = require("./glasses-ui-task-fit.cjs");
const { PROGRAM_CARD_LOOK_CASES, PROGRAM_CARD_LOOK_CASES_MAX_BYTES, validateLookCases } = require("./program-card-look.cjs");

const HOUR_MS = 3_600_000;
const record = (v         )                           => !!v && typeof v === "object" && !Array.isArray(v);
const utf8 = new TextEncoder();
const bytes = (v         ) => utf8.encode(JSON.stringify(v)).length;

const TEXT_MAX_BYTES = 999;

const LIST_MAX_ITEMS = 20;

const FULL_EXTRA_ROWS = 3;

const ROW_TEXT_BYTES = 120;

const LONG_ROWS = 3;

const CASE_BUDGET_BYTES = 3_600;

const TASK_CASE_UNCHECKED_WORDS = "Couldn't check";

const TASK_CASE_MORE_WORDS = "more";

const TASK_CASE_PROBLEMS = Object.freeze({

  crash: "case_crash",

  expect: "case_expect_failed",

  uncheckedLikeEmpty: "case_unchecked_like_empty",

  textCut: "case_text_cut",

  problem: "case_problem",

  skipped: "case_skipped",

  real: "real_result_problem",

  partNoLine: "case_part_no_line",

  keptSkipped: "case_kept_skipped",

  noResult: "case_no_result",
});

const TASK_KEPT_CASE = "last_values";
const keptCase = (name         ) => typeof name === "string" && name.startsWith(TASK_KEPT_CASE);

function taskCardPartsWithoutLine(source         , parts         )           {
  if (typeof source !== "string" || !Array.isArray(parts)) return [];
  const names = parts.filter((p)              => typeof p === "string" && !!p);
  if (names.length < 2) return [];
  const drawn = new Set        ();
  const call = /\btaskLine\s*\(/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    let depth = 1, i = call.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    const args = source.slice(call.lastIndex, i - 1);
    const slot = /\bslot\s*:\s*(["'`])([^"'`]*)\1/.exec(args);
    if (slot) drawn.add(slot[2]);
    else if (/\bslot\b/.test(args)) return [];
    else drawn.add("task");
  }
  return names.filter((name) => !drawn.has(name));
}

const CUT_CODES = new Set(["raster_truncated", "native_truncated"]);

const PAST_LIMITS = new Set(["long", "full"]);

const CUT_FIX_LOOKS = 2;

function caseName(prefix        , key        , taken             )         {
  const base = `${prefix}_${key.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.replace(/_+/g, "_").slice(0, 32).replace(/_$/, "");
  let name = base, n = 2;
  while (taken.has(name)) name = `${base.slice(0, 29)}_${n++}`;
  taken.add(name);
  return name;
}

function wideText(max        )         {
  const words = ["WWWWMMMM", "MWMWMWMW", "WMMWWMMW"];
  let out = "";
  for (let i = 0; ; i++) {
    const next = (out ? out + " " : "") + words[i % words.length];
    if (utf8.encode(next).length > max) return out || "W".repeat(Math.max(1, max));
    out = next;
  }
}

function cjkText(max        )         {
  const chars = Array.from("会議室の予約は午後三時から第二会議室で行います");
  let out = "";
  for (let i = 0; utf8.encode(out + chars[i % chars.length]).length <= max; i++) out += chars[i % chars.length];
  return out || "会";
}

function madeUpNumber(input       , at = 0)         {
  const lo = Number.isFinite(input.min) ? input.min           : 0;
  const hi = Number.isFinite(input.max) ? input.max           : lo + 10_000;
  return Math.min(hi, Math.max(lo, lo + 1_204 + at));
}

function madeUpScalar(type        , at        )          {
  if (type === "number") return 3 + at;
  if (type === "bool") return at % 2 === 0;
  if (type === "text") return `Item ${at + 1}`;
  return null;
}

function madeUpRow(input       , real         , at        )          {
  if (input.fields) {
    const first = Array.isArray(real) && record(real[0]) ? real[0] : null;
    const row                          = {};
    for (const [name, type] of Object.entries(input.fields)) {
      const made = madeUpScalar(type, at);
      row[name] = type === "image" ? first?.[name] ?? null : made;
    }
    return row;
  }
  return madeUpScalar(input.of ?? "text", at);
}

function madeUpList(input       , real         , rows        )            {
  return Array.from({ length: Math.max(0, rows) }, (_, at) => madeUpRow(input, real, at));
}

function longList(input       , real         , text                         )            {
  const rows = Math.min(input.maxItems ?? LONG_ROWS, LONG_ROWS);
  return madeUpList(input, real, rows).map((row) => {
    if (!input.fields) return (input.of ?? "text") === "text" ? text(ROW_TEXT_BYTES) : row;
    const out                          = { ...(row                           ) };
    for (const [name, type] of Object.entries(input.fields)) if (type === "text") out[name] = text(ROW_TEXT_BYTES);
    return out;
  });
}

function shaped(input       , real         , shape        )          {
  const textMax = input.maxBytes ?? TEXT_MAX_BYTES;
  switch (shape) {
    case "empty":
      if (input.type === "number") return (!Number.isFinite(input.min) || (input.min          ) <= 0) && (!Number.isFinite(input.max) || (input.max          ) >= 0) ? 0 : undefined;
      return input.type === "text" ? "" : input.type === "list" ? [] : undefined;
    case "full":
      return input.type === "list" ? madeUpList(input, real, (input.maxItems ?? LIST_MAX_ITEMS) + FULL_EXTRA_ROWS) : undefined;
    case "long":
      return input.type === "text" ? wideText(textMax) : input.type === "list" ? longList(input, real, wideText) : undefined;
    case "cjk":
      return input.type === "text" ? cjkText(textMax) : input.type === "list" ? longList(input, real, cjkText) : undefined;
    case "number_as_text":
      if (input.type === "number") {
        const n = madeUpNumber(input);
        return n >= 1_000 ? n.toLocaleString("en-US") : ` ${n} `;
      }
      if (input.type === "list" && input.fields && Object.values(input.fields).includes("number")) {
        return madeUpList(input, real, Math.min(input.maxItems ?? 3, 3)).map((row     ) => {
          const out = { ...row };
          for (const [name, type] of Object.entries(input.fields                          )) if (type === "number") out[name] = ` ${row[name]} `;
          return out;
        });
      }
      if (input.type === "list" && input.of === "number") return [" 7 ", "1,204", "12"];
      return undefined;
    case "missing_field":
      if (input.type === "list" && input.fields && Object.keys(input.fields).length > 1) {
        const names = Object.keys(input.fields);
        return madeUpList(input, real, Math.min(input.maxItems ?? 3, 3)).map((row     , at) => {
          const out = { ...row };
          delete out[names[at % names.length]];
          return out;
        });
      }
      return undefined;
    default:
      return undefined;
  }
}

function shapes(inputs         , real                         , shape        )                                 {
  let changed = false;
  const out                          = { ...real };
  for (const input of inputs) {
    const value = shaped(input, real[input.key], shape);
    if (value !== undefined) { out[input.key] = value; changed = true; }
  }
  return changed ? out : null;
}

function uncheckedLine(input       )         {
  const name = typeof input.label === "string" && input.label.trim() ? input.label.trim() : input.key.replace(/_/g, " ");
  return `${TASK_CASE_UNCHECKED_WORDS} ${name}`.slice(0, 120);
}

function uncheckedFacts(inputs         , keys          , why = "timed_out") {
  const unchecked = Object.fromEntries(inputs.filter((input) => keys.includes(input.key))
    .map((input) => [input.key, { why, line: uncheckedLine(input) }]));
  return { task: { state: "done", unchecked } };
}

function taskHardCaseList(card     )                {

  if (Array.isArray(card?.parts) && card.parts.length > 1) return partedCaseList(card);
  const inputs          = (Array.isArray(card?.inputs) ? card.inputs : [])
    .filter((input     ) => record(input) && typeof input.key === "string" && typeof input.type === "string")
    .slice(0, PROGRAM_CARD_LOOK_CASES.keys);
  if (!inputs.length || !record(card?.values)) return null;
  const keys = inputs.map((input) => input.key);
  const fit = (raw                         , runs = 1) => {
    const fitted      = fitTaskValues(inputs       , raw, { budgetBytes: Math.floor(CASE_BUDGET_BYTES / Math.max(1, runs)) });
    if (fitted.status !== "fitted") return null;
    return { values: fitted.values, ...(Object.keys(fitted.fixes ?? {}).length ? { fixes: fitted.fixes } : {}) };
  };
  const real = fit(card.values);

  const realAgain = fit(card.values, 5);
  if (!real) return null;
  const run = (values     , ago = 0) => ({ ago, ...values });
  const out         = [];
  const taken = new Set        ();
  const add = (item     , about        ) => { taken.add(item.name); out.push({ item, about }); };

  const kept = record(card?.kept) ? fit(card.kept) : null;
  if (kept) add({ kind: "other", name: TASK_KEPT_CASE, runs: [run(kept)] },
    "the card's last values (a blank filled from that value's last good one): it must still show them");
  add({ kind: "nothing_yet", name: "nothing_yet", runs: [] }, "no run's values yet: the waiting view");
  const shapesOf                                                     = [
    ["empty", "empty", "empty", "every list is [] and every text is \"\": a real empty answer"],
    ["full", "full", "full", `every list at its most rows, and ${FULL_EXTRA_ROWS} more the host left out (+N more)`, [TASK_CASE_MORE_WORDS]],
    ["long", "long_text", "long", "every text at its longest, in wide letters"],
    ["long", "cjk_text", "cjk", "every text at its longest, in Japanese"],
    ["number_as_text", "number_as_text", "number_as_text", "numbers sent as words (\"1,204\", \" 7 \"), fitted back to numbers"],
    ["missing_field", "missing_field", "missing_field", "list rows each without one of their fields"],
  ];
  for (const [kind, name, shape, about, expect] of shapesOf) {
    const raw = shapes(inputs, card.values, shape);

    const values = raw ? fit(raw) : null;
    if (!values) continue;
    const cut = Object.values((values       ).fixes ?? {}).some((fix     ) => fix?.hidden > 0);
    add({ kind, name, ...(shape === "full" ? { shape: "snapshot" } : {}), runs: [run(values)],
      ...(expect && (shape !== "full" || cut) ? { expect } : {}) }, about);
  }
  const blank = fit(Object.fromEntries(keys.map((key) => [key, null])));
  if (blank) add({ kind: "unchecked", name: "unchecked_all", runs: [run(blank)], task: uncheckedFacts(inputs, keys),
    expect: [TASK_CASE_UNCHECKED_WORDS] }, "every value null: the run couldn't check any of them");
  add({ kind: "clock", name: "old_26h", runs: [run(real, 26 * HOUR_MS)] }, "your values, 26 h old");
  add({ kind: "clock", name: "clock_2359", clock: "2026-10-20T23:59", runs: [run(real)] }, "the clock reads 23:59");
  add({ kind: "clock", name: "monday_0001", clock: "2026-10-26T00:01", runs: [run(real, 2 * 60_000)] }, "the clock reads Monday 00:01");
  if (realAgain) add({ kind: "runs", name: "five_runs", runs: [4, 3, 2, 1, 0].map((hours) => run(realAgain, hours * HOUR_MS)) },
    "five runs in a row with no reset");

  if (keys.length > 1) {
    for (const input of inputs) {
      if (out.length >= PROGRAM_CARD_LOOK_CASES.max) break;
      const values = fit({ ...card.values, [input.key]: null });
      if (!values) continue;
      add({ kind: "unchecked", name: caseName("unchecked", input.key, taken), runs: [run(values)],
        task: uncheckedFacts(inputs, [input.key]), expect: [TASK_CASE_UNCHECKED_WORDS] },
        `${input.key} null, the rest checked: the run couldn't check it`);
    }
  }
  return withinOneLook(out);
}

function withinOneLook(out        )         {
  const list = out.slice(0, PROGRAM_CARD_LOOK_CASES.max);
  const stays = (made      ) => made.item.kind === "nothing_yet" || keptCase(made.item.name);
  while (list.length > 1 && bytes(list.map((made) => made.item)) > PROGRAM_CARD_LOOK_CASES_MAX_BYTES - 1_024) {
    let largest = -1;
    for (let i = 1; i < list.length; i++) {
      if (!stays(list[i]) && (largest < 0 || bytes(list[i].item) > bytes(list[largest].item))) largest = i;
    }
    if (largest < 0) break;
    list.splice(largest, 1);
  }
  return list;
}

const TASK_PART_CASES = Object.freeze({
  all: { name: "all_parts", kind: "other", about: "every part at its real values" },
  apart: { name: "parts_far_apart", kind: "clock", about: "one part's values 26 h old, the new part's fresh" },
  neverRun: { name: "part_never_run", kind: "other", about: "a part whose Task has not run yet: its waiting view beside the others" },
  unlinked: { name: "part_no_task", kind: "other", about: "the new part with no Task (its values never come): the others still show" },
  reverse: { name: "parts_other_order", kind: "runs", about: "the parts' values arriving the other way round" },
  unchecked: { name: "parts_unchecked", kind: "unchecked", about: "every part's run couldn't check any value" },
  full: { name: "parts_full", kind: "full", about: "every part at its most: every list at its most rows, every text at its longest" },
});

function partedCaseList(card     )                {
  const parts         = card.parts.filter((part     ) => record(part) && typeof part.name === "string" && Array.isArray(part.inputs))
    .map((part     ) => ({ ...part, inputs: part.inputs.filter((input     ) => record(input) && typeof input.key === "string"
      && typeof input.type === "string").slice(0, PROGRAM_CARD_LOOK_CASES.keys) }));
  const added = parts.find((part) => part.isNew);
  if (parts.length < 2 || !added || !record(added.values)) return null;
  const share = Math.floor(CASE_BUDGET_BYTES / parts.length);
  const fit = (part      , raw         , runs = 1) => {
    const fitted      = fitTaskValues(part.inputs       , raw, { budgetBytes: Math.floor(share / Math.max(1, runs)) });
    return fitted.status === "fitted" ? fitted.values : null;
  };

  const real = new Map                                 ();
  for (const part of parts) {
    const values = record(part.values) ? fit(part, part.values) : null;
    if (values) real.set(part.name, values);
  }
  if (!real.has(added.name)) return null;
  const allReal = () => Object.fromEntries([...real]);
  const others = parts.filter((part) => part !== added);
  const older = others.find((part) => real.has(part.name)) ?? null;
  const out         = [];
  const taken = new Set        ();
  const add = (item     , about        ) => { taken.add(item.name); out.push({ item, about }); };
  const named = (entry                                , rest     ) => ({ kind: entry.kind, name: entry.name, ...rest });

  const kept = record(card.kept) ? fit(added, card.kept) : null;
  if (kept) add({ kind: "other", name: TASK_KEPT_CASE, runs: [{ ago: 0, values: { ...allReal(), [added.name]: kept } }] },
    `${added.name}: the card's last values (a blank filled from that value's last good one), the other parts at their real values: it must still show them`);
  add({ kind: "nothing_yet", name: "nothing_yet", runs: [] }, "no part's values yet: every part's waiting view");
  add(named(TASK_PART_CASES.all, { runs: [{ ago: 0, values: allReal() }] }), TASK_PART_CASES.all.about);
  if (older) {
    add(named(TASK_PART_CASES.apart, { runs: [{ ago: 26 * HOUR_MS, values: { [older.name]: real.get(older.name) } },
      { ago: 0, values: { [added.name]: real.get(added.name) } }] }), TASK_PART_CASES.apart.about);
    const rest = Object.fromEntries([...real].filter(([name]) => name !== older.name));
    add(named(TASK_PART_CASES.neverRun, { runs: [{ ago: 0, values: rest }], task: { [older.name]: { state: "waiting" } } }),
      `${older.name}: ${TASK_PART_CASES.neverRun.about}`);
  }
  const withoutNew = Object.fromEntries([...real].filter(([name]) => name !== added.name));

  if (Object.keys(withoutNew).length && !kept) add(named(TASK_PART_CASES.unlinked, { runs: [{ ago: 0, values: withoutNew }] }), TASK_PART_CASES.unlinked.about);
  const order = parts.filter((part) => real.has(part.name)).reverse();
  add(named(TASK_PART_CASES.reverse, { runs: order.map((part, at) => ({ ago: (order.length - 1 - at) * 60_000,
    values: { [part.name]: fit(part, part.values, order.length) ?? real.get(part.name) } })) }), TASK_PART_CASES.reverse.about);
  const blanks                          = {};
  const facts                      = {};
  for (const part of parts) {
    const blank = fit(part, Object.fromEntries(part.inputs.map((input) => [input.key, null])));
    if (!blank) continue;
    blanks[part.name] = blank;
    facts[part.name] = uncheckedFacts(part.inputs, part.inputs.map((input) => input.key)).task;
  }
  if (Object.keys(blanks).length) add(named(TASK_PART_CASES.unchecked, { runs: [{ ago: 0, values: blanks }], task: facts,
    expect: [TASK_CASE_UNCHECKED_WORDS] }), TASK_PART_CASES.unchecked.about);
  const fullest                          = {};
  for (const part of parts) {
    const base = real.get(part.name) ?? {};
    const wide = shapes(part.inputs, { ...base, ...(shapes(part.inputs, base, "full") ?? {}) }, "long");
    const values = wide ? fit(part, wide) : null;
    if (values) fullest[part.name] = values;
  }
  if (Object.keys(fullest).length) add(named(TASK_PART_CASES.full, { runs: [{ ago: 0, values: { ...allReal(), ...fullest } }] }), TASK_PART_CASES.full.about);

  const own                                  = [["empty", "empty", "every list [] and every text \"\""],
    ["long", "long", "every text at its longest, in wide letters"], ["long", "cjk", "every text at its longest, in Japanese"],
    ["number_as_text", "number_as_text", "numbers sent as words"], ["missing_field", "missing_field", "list rows each without a field"]];
  for (const part of [added, ...others]) {
    const base = real.get(part.name);
    if (!base) continue;
    for (const [kind, shape, about] of own) {
      if (out.length >= PROGRAM_CARD_LOOK_CASES.max) break;
      const raw = shapes(part.inputs, base, shape);
      const values = raw ? fit(part, raw) : null;
      if (!values) continue;
      add({ kind, name: caseName(shape, part.name, taken), runs: [{ ago: 0, values: { ...allReal(), [part.name]: values } }] },
        `${part.name}: ${about}; the other parts at their real values`);
    }
    if (out.length < PROGRAM_CARD_LOOK_CASES.max) {
      const values = fit(part, Object.fromEntries(part.inputs.map((input) => [input.key, null])));
      if (values) add({ kind: "unchecked", name: caseName("unchecked", part.name, taken), runs: [{ ago: 0, values: { ...allReal(), [part.name]: values } }],
        task: { [part.name]: uncheckedFacts(part.inputs, part.inputs.map((input) => input.key)).task }, expect: [TASK_CASE_UNCHECKED_WORDS] },
        `${part.name}: its run couldn't check any value; the other parts at their real values`);
    }
  }
  return withinOneLook(out);
}

function taskHardCases(card     )               {
  const list = taskHardCaseList(card);
  if (!list?.length) return null;
  const checked = validateLookCases(list.map((made) => made.item));
  return checked.ok ? checked.cases : null;
}

function taskHardCaseBrief(card     )                  {
  const list = taskHardCaseList(card);
  return list?.length ? list.map((made) => `${made.item.name}: ${made.about}`) : null;
}

const MESSAGE_MAX = 200;
const VERDICT_PROBLEMS_MAX = 12;
const say = (text         ) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);

function hhmm(atMs         )         {
  if (!Number.isFinite(atMs)) return "";
  const at = new Date(atMs          );
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function taskCaseVerdict(cases       , report     ,
  options                                                                                                  = {}) {
  const looks = Number.isInteger(options.looks) ? options.looks           : 1;
  const problems                    = [];

  for (const part of taskCardPartsWithoutLine(options.source, options.parts)) {
    problems.push({ case: "parts", kind: "parts", tier: "fix", code: TASK_CASE_PROBLEMS.partNoLine,
      message: say(`No line for the ${part} part: put taskLine(ctx${part === "task" ? "" : `, { slot: "${part}" }`}) in its section.`) });
  }
  const results = Array.isArray(report?.cases) ? report.cases : [];
  let ran = 0;
  let keptRan = 0;
  const failedCases = new Set        ();
  const answered = new Set        ();

  const keptSent = (Array.isArray(cases) ? cases : []).filter((item) => keptCase(item?.name)).length;
  for (const result of results) {
    const item = cases[result?.index] ?? {};
    if (Number.isInteger(result?.index)) answered.add(result.index);
    const name = typeof result?.name === "string" ? result.name : String(item.name ?? "case");
    const kind = typeof result?.kind === "string" ? result.kind : String(item.kind ?? "other");
    const push = (tier              , code        , message        ) => {
      problems.push({ case: name, kind, tier, code, message: say(message) });
      if (tier !== "advice") failedCases.add(name);
    };
    if (result?.skipped !== undefined) {

      if (keptCase(name)) push("fix", TASK_CASE_PROBLEMS.keptSkipped,
        "The time ran out before your last values were checked: make the card quicker to start, then Look again.");
      else push("advice", TASK_CASE_PROBLEMS.skipped, "The sweep's time ran out before this case.");
      continue;
    }
    ran++;
    if (keptCase(name)) keptRan++;
    const list = Array.isArray(result?.problems) ? result.problems : [];
    if (result?.crashed === true) {
      const first = list.find((p     ) => ["error_screen", "card_error", "scene_error", "look_failed"].includes(p?.code)) ?? list[0];
      push("block", TASK_CASE_PROBLEMS.crash, `It broke on this case (${first?.code ?? "crash"}): ${first?.message ?? ""}`);
      continue;
    }
    for (const expect of Array.isArray(result?.expects) ? result.expects : []) {
      if (expect?.outcome !== "failed") continue;
      if (kind === "unchecked") push("fix", TASK_CASE_PROBLEMS.uncheckedLikeEmpty,
        `A value the run couldn't check is drawn like an empty one: "${expect.words}" is not on the card. Draw ui.unchecked(ctx.task?.unchecked?.[key]) ?? row.`);
      else push("block", TASK_CASE_PROBLEMS.expect, `"${expect.words}" is not on the card.`);
    }
    for (const problem of list) {
      const severity = problem?.severity;
      if (CUT_CODES.has(problem?.code)) {
        const soft = PAST_LIMITS.has(kind) && looks > CUT_FIX_LOOKS;
        push(soft ? "advice" : "fix", TASK_CASE_PROBLEMS.textCut,
          `Text runs off its box (${problem.code}): ${problem?.message ?? ""} Cut it with ui.fit(text, w, { lines }).`);
      } else if (severity === "broken" || severity === "fix") {
        push("fix", TASK_CASE_PROBLEMS.problem, `${problem?.code}: ${problem?.message ?? ""}`);
      }
    }
  }

  if (keptSent) {
    (cases         ).forEach((item, index) => {
      if (answered.has(index)) return;
      const name = String(item?.name ?? "case");
      problems.push({ case: name, kind: String(item?.kind ?? "other"), tier: "fix", code: TASK_CASE_PROBLEMS.noResult,
        message: say("No result came back for this case: Look again.") });
      failedCases.add(name);
    });
  }

  let realFailed = false;
  if (report?.ok === false) {
    realFailed = true;
    problems.push({ case: "real", kind: "real", tier: "fix", code: TASK_CASE_PROBLEMS.real,
      message: say(`The Look on your result stopped (${report?.error ?? "look_failed"}).`) });
  }
  for (const problem of Array.isArray(report?.problems) ? report.problems : []) {
    if (problem?.severity !== "broken" && problem?.severity !== "fix") continue;
    realFailed = true;
    problems.push({ case: "real", kind: "real", tier: "fix", code: TASK_CASE_PROBLEMS.real,
      message: say(`${problem?.code}: ${problem?.message ?? ""}`) });
  }
  const blocked = problems.some((p) => p.tier === "block");
  const fixing = problems.some((p) => p.tier === "fix");
  const verdict                  = blocked ? "blocked" : fixing ? "needs_fix" : "fits";
  const time = hhmm(options.resultAtMs);
  const yours = time ? `your ${time} result` : "your result";
  const firstBlock = problems.find((p) => p.tier === "block");

  const keptFailed = [...failedCases].some(keptCase);
  const hardRan = ran - keptRan;
  const hardFailed = [...failedCases].filter((name) => !keptCase(name)).length;
  const run = time ? `your ${time} run` : "your run";
  const fixLine = !keptSent ? null : verdict === "fits" ? `Fits ${run}, your last values and ${hardRan} hard cases`
    : verdict === "blocked" ? null
      : `Needs a fix: ${[hardFailed ? `${hardFailed} of ${hardRan} hard cases` : "", keptFailed ? "your last values" : "",
        realFailed ? run : ""].filter(Boolean).join(", ") || run}`;
  const line = fixLine ? fixLine : verdict === "fits" ? `Fits ${yours} and ${ran} hard cases`
    : verdict === "blocked" ? `Breaks on the ${firstBlock?.case} case: it can't be saved`

      : !failedCases.size && !realFailed && problems.some((p) => p.code === TASK_CASE_PROBLEMS.partNoLine)
        ? "Needs a fix: a Task's part shows no line"
      : !failedCases.size ? `Needs a fix: ${yours}`
        : `Needs a fix: ${failedCases.size} of ${ran} hard cases${realFailed ? ` and ${yours}` : ""}`;

  const order                               = { block: 0, fix: 1, advice: 2 };
  const shown = problems.slice().sort((a, b) => order[a.tier] - order[b.tier]).slice(0, VERDICT_PROBLEMS_MAX);

  const sourceHash = typeof options.sourceHash === "string" && options.sourceHash ? options.sourceHash : null;
  return {
    verdict, line, ran, failed: failedCases.size, real: !realFailed, looks, problems: shown,
    ...(keptSent ? { kept: keptRan, keptFailed } : {}),
    ...(sourceHash ? { sourceHash } : {}),

    check: { verdict, cases: keptSent ? hardRan : ran, failed: keptSent ? hardFailed : failedCases.size, real: !realFailed,
      ...(keptSent ? { kept: keptRan, keptFailed } : {}),
      ...(firstBlock ? { case: firstBlock.case } : {}),
      ...(Number.isFinite(options.resultAtMs) ? { resultAtMs: options.resultAtMs           } : {}) },
  };
}

function taskCaseVerdictNext(verdict                 , looksLeft        )                {
  if (verdict === "fits") return null;
  if (looksLeft <= 0) return "That was this card's last Look and it still does not pass the host's check (hardCases), " +
    "so the build ends \"Couldn't fit\" and the card is not saved. Tell the wearer in one line, and do not save it.";
  return "The host's check on the hard cases did not pass (hardCases.problems: block and fix tiers hold the card back). " +
    "Fix them with edit_glasses_card, then look_glasses_card again: every Look runs the hard cases again.";
}

module.exports = { TASK_CASE_UNCHECKED_WORDS, TASK_CASE_MORE_WORDS, TASK_CASE_PROBLEMS, TASK_KEPT_CASE, taskCardPartsWithoutLine, taskHardCaseList, TASK_PART_CASES, taskHardCases, taskHardCaseBrief, taskCaseVerdict, taskCaseVerdictNext };
