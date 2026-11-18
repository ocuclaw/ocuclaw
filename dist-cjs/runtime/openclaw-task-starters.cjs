const { GLASSES_URGENT_PROMPT_RULES, OPENCLAW_SILENT_TOKEN } = require("./openclaw-task-prompt.cjs");

const RECURRENCES = Object.freeze({ everyday: "*", weekdays: "1-5", weekends: "0,6" }                          );
const DAY_TO_DOW = Object.freeze({ sunday: "0", monday: "1", tuesday: "2", wednesday: "3", thursday: "4",
  friday: "5", saturday: "6" }                          );
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

class StarterRefusal extends Error {
  code        ;
  constructor(code        ) {
    super(code);
    this.code = code;
  }
}

function slot(name        , type        , label        , fallback        , options           = [], help = "") {
  return { name, type, label, default: fallback, options, optional: false, strict: true, help };
}

const time = (fallback        ) => slot("time", "time", "What time?", fallback, [], "24h local time, e.g. 07:15");

const days = (fallback        ) => slot("recurrence", "weekdays", "Which days?", fallback, Object.keys(RECURRENCES));

const hermesTime = (fallback        ) => slot("time", "time", "What time?", fallback, [], "24h local time, e.g. 08:00");
const hermesRepeat = (fallback        ) => slot("recurrence", "weekdays", "Repeat on", fallback, Object.keys(RECURRENCES));

const modelPrompt = (task        ) => `${GLASSES_URGENT_PROMPT_RULES}\n\n${task}`;

const OPENCLAW_STARTERS                     = Object.freeze([
  {
    key: "ocuclaw:glasses-brief",
    title: "Morning brief",
    description: "A short morning brief on your glasses: today's calendar, the weather and anything urgent.",
    category: "daily",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: modelPrompt(
      "Give the user a morning brief for today: calendar events in " +
      "time order, the local weather, and anything urgent waiting on " +
      "them. Use connected calendar and mail when they are set up. If " +
      "none are, give the date and the weather."),
    slots: [time("07:15"), days("weekdays")],
    tags: ["glasses", "kind:brief", "daily"],
  },
  {
    key: "ocuclaw:day-wrap",
    title: "Day wrap-up",
    description: "An end-of-day wrap-up on your glasses: what is still open and what tomorrow starts with.",
    category: "daily",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: modelPrompt(
      "Give the user a short wrap-up of their day: anything still open " +
      "from today, tomorrow's first commitments in time order, and " +
      "anything to prepare tonight. Use connected calendar and mail " +
      "when they are set up."),
    slots: [time("17:30"), days("weekdays")],
    tags: ["glasses", "kind:brief", "evening"],
  },
  {
    key: "ocuclaw:glance-reminder",
    title: "Reminder",
    description: "A reminder in your own words, shown on your glasses on your schedule.",
    category: "general",
    scheduleTemplate: "{minute} {hour} * * {dow}",

    promptTemplate: "Output this reminder text exactly as written, on one line, with " +
      "nothing before or after it:\n{text}",
    slots: [slot("text", "text", "Reminder text", "Stand up and stretch"), time("09:00"), days("weekdays")],
    tags: ["glasses", "kind:reminder"],
  },
]);

const HERMES_BUILT_IN_STARTERS                     = Object.freeze([
  {
    key: "weekly-review",
    title: "Weekly review",
    description: "A weekly recap: what got done, what's still open, and what's coming up.",
    category: "weekly",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: "Run the weekly-review-planning skill's procedure for the user: review " +
      "the completed week and coming 1-2 weeks across connected calendar, tasks, " +
      "notes, and email; surface commitments, stalled projects, and waiting items; " +
      "build a capacity-aware plan for next week. Recommendations and drafts only " +
      "— no mutations without approval. Keep the output in the skill's " +
      "seven-section shape.",
    slots: [
      hermesTime("18:00"),
      slot("day", "enum", "Which day?", "sunday", ["sunday", "monday", "friday", "saturday"]),
    ],

    skills: ["weekly-review-planning"],
    tags: ["weekly", "review"],
  },
  {
    key: "workday-start",
    title: "Workday start reminder",
    description: "A weekday nudge with your agenda and top priorities.",
    category: "daily",
    scheduleTemplate: "{minute} {hour} * * 1-5",
    promptTemplate: "Give the user a brief weekday start-of-day nudge: today's calendar " +
      "and the 1-3 highest-priority things to focus on, inferred from " +
      "recent context and any task tools. Encouraging, short, one message.",
    slots: [hermesTime("09:00")],
    tags: ["daily", "focus"],
  },
  {
    key: "evening-winddown",
    title: "Evening wind-down",
    description: "An end-of-day check-in: tomorrow's calendar at a glance " +
      "and anything you should prep tonight.",
    category: "daily",
    scheduleTemplate: "{minute} {hour} * * *",
    promptTemplate: "Give the user a short evening wind-down: tomorrow's calendar, any " +
      "early commitments to prep for, and one gentle nudge to wrap up " +
      "loose ends from today. Keep it calm and brief — one message. If no " +
      "calendar is connected, just offer a friendly sign-off and the " +
      "weather for tomorrow.",
    slots: [hermesTime("21:00")],
    tags: ["daily", "evening"],
  },
  {
    key: "news-digest",
    title: "Topic news digest",
    description: "A recurring digest on a topic you care about — deduped " +
      "against what was already sent, so only genuinely new items land.",
    category: "general",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: "Search the web for new and noteworthy items about: {topic}. " +
      "Dedupe against what you sent in previous runs — only include " +
      "genuinely new developments. Deliver a tight digest of at most " +
      "{count} bullets, each one line with a link. If nothing new since " +
      `last run, respond with ${OPENCLAW_SILENT_TOKEN}.`,
    slots: [
      slot("topic", "text", "What topic?", "AI and technology", [], "a subject, product, person, or search phrase"),
      hermesTime("18:00"),
      hermesRepeat("weekdays"),
      slot("count", "enum", "How many bullets?", "5", ["3", "5", "8"]),
    ],
    tags: ["digest", "research"],
  },
  {
    key: "bill-renewal-watch",
    title: "Bills & renewals reminder",
    description: "A heads-up before a recurring payment, subscription " +
      "renewal, or due date — so nothing auto-charges by surprise.",
    category: "general",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: "Remind the user about an upcoming payment or renewal: {what}. " +
      "Phrase it as an actionable heads-up (e.g. 'review or cancel before " +
      "it renews'), not just a notification. One short message.",
    slots: [
      slot("what", "text", "What's due?", "my streaming subscription renews soon"),
      hermesTime("10:00"),
      hermesRepeat("everyday"),
    ],
    tags: ["reminder", "finance"],
  },
  {
    key: "habit-checkin",
    title: "Habit check-in",
    description: "A recurring nudge to keep a habit on track and reflect " +
      "on whether you did it.",
    category: "general",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: "Nudge the user about their habit: {habit}. Ask whether they did it " +
      "today, keep it warm and non-judgmental, and offer a one-line word " +
      "of encouragement. One short message.",
    slots: [slot("habit", "text", "Which habit?", "20 minutes of reading"), hermesTime("20:00"), hermesRepeat("everyday")],
    tags: ["habit", "wellbeing"],
  },
  {
    key: "meal-plan",
    title: "Weekly meal plan",
    description: "A weekly meal plan plus a consolidated grocery list, " +
      "tuned to your diet and how much time you have to cook.",
    category: "weekly",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: "Build the user a meal plan for the coming week: {meals} per day, " +
      "suited to a {diet} diet and roughly {effort} cooking effort. " +
      "Include a consolidated grocery list grouped by aisle. Keep blueprints " +
      "simple and skimmable.",
    slots: [
      slot("diet", "enum", "Diet?", "no restrictions", ["no restrictions", "vegetarian", "vegan", "high-protein", "low-carb"]),
      slot("meals", "enum", "Meals per day?", "dinner only", ["dinner only", "lunch and dinner", "all three"]),
      slot("effort", "enum", "Cooking effort?", "quick", ["quick", "medium", "ambitious"]),
      hermesTime("17:00"),
      slot("day", "enum", "Which day?", "sunday", ["sunday", "monday", "friday", "saturday"]),
    ],
    tags: ["weekly", "food"],
  },
  {
    key: "learn-daily",
    title: "Daily learning drip",
    description: "One bite-sized lesson a day on a topic you want to learn, " +
      "building progressively over time.",
    category: "daily",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: "Teach the user one bite-sized lesson about: {topic}. Build on " +
      "earlier lessons so it progresses rather than repeating. Keep it to " +
      "a couple of short paragraphs with one concrete example, and end " +
      "with a single question to check understanding.",
    slots: [slot("topic", "text", "Learn about…", "Spanish vocabulary"), hermesTime("08:30"), hermesRepeat("weekdays")],
    tags: ["learning", "daily"],
  },
  {
    key: "gratitude-journal",
    title: "Gratitude & reflection prompt",
    description: "A gentle evening prompt to reflect on the day and note " +
      "what went well.",
    category: "general",
    scheduleTemplate: "{minute} {hour} * * {dow}",
    promptTemplate: "Send the user a short, warm reflection prompt for the end of the " +
      "day — invite them to note one thing that went well, one thing they " +
      "are grateful for, and one small win. If they reply, acknowledge it " +
      "kindly. One message.",
    slots: [hermesTime("21:30"), hermesRepeat("everyday")],
    tags: ["wellbeing", "reflection"],
  },
  {
    key: "on-this-day",
    title: "On-this-day discovery",
    description: "A daily dose of curiosity: a notable historical event, " +
      "fact, or word for the day.",
    category: "daily",
    scheduleTemplate: "{minute} {hour} * * *",
    promptTemplate: "Give the user one interesting '{flavor}' item for today — keep it " +
      "short, surprising, and genuinely interesting. One or two sentences, " +
      "no filler.",
    slots: [
      slot("flavor", "enum", "What kind?", "on this day in history",
        ["on this day in history", "word of the day", "science fact", "quote of the day"]),
      hermesTime("07:30"),
    ],
    tags: ["daily", "curiosity"],
  },
]);

const ALL_STARTERS                     = Object.freeze([...HERMES_BUILT_IN_STARTERS, ...OPENCLAW_STARTERS]);

function schedule(template        , resolved                        ) {
  const repl                         = {};
  if (template.includes("{minute}") || template.includes("{hour}")) {
    const at = TIME_RE.exec(String(resolved.time ?? "").trim());
    if (!at) throw new StarterRefusal("starter_invalid");
    repl.hour = String(Number(at[1]));
    repl.minute = String(Number(at[2]));
  }
  if (template.includes("{dow}")) {
    let dow                     = "*";
    if ("recurrence" in resolved) dow = RECURRENCES[resolved.recurrence.toLowerCase()];
    else if ("day" in resolved) dow = DAY_TO_DOW[resolved.day.toLowerCase()];
    if (dow === undefined) throw new StarterRefusal("starter_invalid");
    repl.dow = dow;
  }
  return template.replace(/\{(\w+)\}/g, (_        , name        ) => {
    const value = repl[name] ?? resolved[name];
    if (value === undefined) throw new StarterRefusal("starter_invalid");
    return value;
  });
}

function fill(starter     , values     ) {
  const known = new Set(starter.slots.map((slot     ) => slot.name));
  if (Object.keys(values).some((name) => !known.has(name))) throw new StarterRefusal("starter_invalid");
  const resolved                         = {};
  for (const slot of starter.slots) {
    const raw = Object.prototype.hasOwnProperty.call(values, slot.name) ? values[slot.name] : slot.default;
    if (raw === null || raw === undefined || raw === "") {
      if (slot.optional) continue;
      throw new StarterRefusal("starter_invalid");
    }
    if (typeof raw !== "string") throw new StarterRefusal("starter_invalid");
    if (slot.type === "enum" && slot.strict && slot.options.length && !slot.options.includes(raw)) {
      throw new StarterRefusal("starter_invalid");
    }
    resolved[slot.name] = raw;
  }
  const prompt = starter.promptTemplate.replace(/\{(\w+)\}/g,
    (_        , name        ) => resolved[name] ?? `{${name}}`);
  return { prompt, schedule: schedule(starter.scheduleTemplate, resolved), name: starter.title };
}

const STARTER_NOTE_LEAD = "Note from the user: ";
const STARTER_NOTE_MAX = 500;

function validStarterNote(note     )          {
  if (typeof note !== "string" || !note.trim() || note.length > STARTER_NOTE_MAX) return false;
  for (const ch of note) {
    const code = ch.codePointAt(0)          ;

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

function starterPromptWithNote(prompt        , note        )         {
  return `${prompt.trimEnd()}\n\n${STARTER_NOTE_LEAD}${note.trim()}`;
}

function starterByKey(key     ) {
  return ALL_STARTERS.find((starter) => starter.key === key) || null;
}

function fillOpenClawStarter(request     ) {
  const starter = starterByKey(request && request.key);
  if (!starter) throw new StarterRefusal("starter_missing");
  const values = request.slots && typeof request.slots === "object" && !Array.isArray(request.slots) ? request.slots : null;
  if (!values) throw new StarterRefusal("starter_invalid");
  const spec = fill(starter, values);
  const note = request.note;
  if (note !== undefined && !validStarterNote(note)) throw new StarterRefusal("starter_invalid");
  const prompt = note === undefined ? spec.prompt : starterPromptWithNote(spec.prompt, note);
  return { key: starter.key, title: starter.title, description: starter.description, prompt,
    schedule: spec.schedule, skills: [...(starter.skills || [])]             };
}

function listOpenClawStarters() {
  return ALL_STARTERS.map((starter) => {
    const spec = fill(starter, {});
    return {
      key: starter.key,
      title: starter.title,
      description: starter.description,
      category: starter.category,
      iconId: "",

      plugin: starter.key.includes(":") ? "ocuclaw" : "",
      tags: [...starter.tags],
      skills: [...(starter.skills || [])],
      scheduleTemplate: starter.scheduleTemplate,
      promptTemplate: starter.promptTemplate,
      deliverDefault: "none",
      slots: starter.slots.map((slot     ) => ({ ...slot, options: [...slot.options] })),
      prefill: { name: spec.name, prompt: spec.prompt, schedule: spec.schedule, deliver: "none" },
    };
  });
}

module.exports = { StarterRefusal, OPENCLAW_STARTERS, HERMES_BUILT_IN_STARTERS, STARTER_NOTE_LEAD, STARTER_NOTE_MAX, validStarterNote, starterPromptWithNote, fillOpenClawStarter, listOpenClawStarters };
