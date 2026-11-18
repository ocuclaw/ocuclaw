const PROGRAM_CARD_PLAN_CAPABILITY = "programCardPlanV1";

const PROGRAM_CARD_CHANGE_CAPABILITY = "programCardChangeV1";

const PROGRAM_CARD_CHOICE_CAPABILITY = "programCardChoiceV1";

const CARD_ASK_CHANGE_WAIT_MS = 90_000;

const CARD_PLAN_MIN_LINES = 3;
const CARD_PLAN_MAX_LINES = 5;

const CARD_PLAN_LINE_TARGET = 40;

const CARD_PLAN_LINE_MAX = 48;

const LOOK_REQUIREMENTS_MAX = 6;

const CARD_PLAN_PROVABLE_RULE =
  'The first Test proves a line only from the card itself, so write each line one of three ways: name a button by the word on it ("Home +1 and Away +1 buttons"), name a time in seconds ("45 s plank, 15 s rest"), or start with "Show" and list what is on screen, with no "when" or "after" ("Show temperature, wind and rain chance"). A game\'s lines say what happens in play. No line about looks or feel.';
const CARD_PLAN_PROVABLE_SHORT =
  'Each line names a button by the word on it, a time in seconds, what happens in a game\'s play, or starts "Show" and lists what is on screen, with no "when" or "after"; none on looks or feel.';

const BANDS = new Set(["top", "middle", "bottom"]);

const cardPlanParameterSchema = {
  type: "array",
  minItems: CARD_PLAN_MIN_LINES,
  maxItems: CARD_PLAN_MAX_LINES,
  description:
    `The card's plan: ${CARD_PLAN_MIN_LINES} to ${CARD_PLAN_MAX_LINES} lines of about ${CARD_PLAN_LINE_TARGET} characters, each one thing the card will do. The wearer reads them before saying yes, and they become the card's test requirements. ${CARD_PLAN_PROVABLE_RULE}`,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["line"],
    properties: {
      line: { type: "string", minLength: 1, maxLength: 60, description: `One plan line, about ${CARD_PLAN_LINE_TARGET} characters.` },
      band: {
        type: "string",
        enum: ["top", "middle", "bottom"],
        description: "Optional: the part of the card the line is about (top, middle or bottom of the screen).",
      },
    },
  },
};

function fitLine(raw         , max         = CARD_PLAN_LINE_MAX)         {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);

  const word = text[cut.length] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(word >= max / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

function fitCardPlan(raw         )                        {
  if (!Array.isArray(raw)) return null;
  const out                 = [];
  const seen = new Set        ();
  for (const item of raw) {
    if (out.length >= CARD_PLAN_MAX_LINES) break;
    const record = item && typeof item === "object" && !Array.isArray(item) ? (item       ) : null;
    const line = fitLine(record ? record.line : item);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    const band = record && typeof record.band === "string" && BANDS.has(record.band) ? (record.band                ) : null;
    out.push(band ? { line, band } : { line });
  }
  return out.length ? out : null;
}

const CARD_DIRECTIONS_MIN = 2;
const CARD_DIRECTIONS_MAX = 3;

const CARD_DIRECTION_LABEL_MAX = 120;

function fitCardDirections(raw         )                         {
  if (!Array.isArray(raw)) return null;
  const out                  = [];
  const seen = new Set        ();
  for (const item of raw) {
    if (out.length >= CARD_DIRECTIONS_MAX) break;
    const record = item && typeof item === "object" && !Array.isArray(item) ? (item       ) : null;
    if (!record) continue;
    const label = fitLine(typeof record.label === "string" ? record.label : record.title, CARD_DIRECTION_LABEL_MAX);
    const plan = fitCardPlan(record.plan);
    if (!label || !plan || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, plan });
  }
  return out.length >= CARD_DIRECTIONS_MIN ? out : null;
}

const CARD_PLAN_SITES_MAX = 3;

const CARD_PLAN_ROWS = 6;

const CARD_PLAN_SITE_HOST_MAX = 40;
const SITE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function fitCardSites(raw         )           {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out           = [];
  for (const item of items) {
    if (out.length >= CARD_PLAN_SITES_MAX) break;
    if (typeof item !== "string") continue;
    const text = item.trim().toLowerCase();

    const host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
    if (!host || host.length > CARD_PLAN_SITE_HOST_MAX || !SITE_HOST.test(host) || /^[0-9.]+$/.test(host) || out.includes(host)) continue;
    out.push(host);
  }
  return out;
}

function cardPlanLines(plan         )           {
  return Array.isArray(plan)
    ? plan.map((item     ) => (item && typeof item.line === "string" ? item.line : "")).filter(Boolean)
    : [];
}

function planRequirements(planLines         , own         )                       {
  const lines = Array.isArray(planLines) ? planLines.filter((l) => typeof l === "string" && l.trim()) : [];
  const mine = Array.isArray(own) ? own.filter((r) => typeof r === "string" && r.trim()) : [];
  if (!lines.length) return Array.isArray(own) ? (own            ) : undefined;
  const out           = [];
  const seen = new Set        ();
  for (const r of [...lines, ...mine]) {
    const key = r.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.trim());
    if (out.length >= LOOK_REQUIREMENTS_MAX) break;
  }
  return out;
}

module.exports = { PROGRAM_CARD_PLAN_CAPABILITY, PROGRAM_CARD_CHANGE_CAPABILITY, PROGRAM_CARD_CHOICE_CAPABILITY, CARD_ASK_CHANGE_WAIT_MS, CARD_PLAN_MIN_LINES, CARD_PLAN_MAX_LINES, CARD_PLAN_LINE_TARGET, CARD_PLAN_LINE_MAX, CARD_PLAN_PROVABLE_RULE, CARD_PLAN_PROVABLE_SHORT, cardPlanParameterSchema, fitCardPlan, CARD_DIRECTIONS_MIN, CARD_DIRECTIONS_MAX, CARD_DIRECTION_LABEL_MAX, fitCardDirections, CARD_PLAN_SITES_MAX, CARD_PLAN_ROWS, CARD_PLAN_SITE_HOST_MAX, fitCardSites, cardPlanLines, planRequirements };
