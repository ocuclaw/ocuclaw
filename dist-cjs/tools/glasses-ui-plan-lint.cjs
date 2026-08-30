const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { assertHonestFieldName, DELIVERY_RUNGS, DELIVERY_RUNG_PHRASING } = require("./glasses-ui-delivery-ladder.cjs");
const { buildTemplateRegistryArtifact, WIRE_KIND_ENUM } = require("./glasses-ui-template-registry.cjs");

const PLAN_LINT_CODES = Object.freeze({

  interactive_timeout_short: "warning",
  actuation_missing_stale_guard: "warning",
  actuation_relies_on_expiry: "error",
  label_over_visual_budget: "warning",
  replace_after_push_likely_wrong: "warning",
  template_field_unknown: "warning",
  interval_vs_window: "warning",

  template_not_in_registry: "error",
  template_kind_mismatch: "error",
  template_held: "error",
  template_not_renderable_today: "error",
  template_required_field_missing: "error",
  template_forbidden_field_present: "error",
});

const PLAN_LINT_SEVERITIES = Object.freeze(["error", "warning"]);

const PICKABLE_KINDS = Object.freeze([
  "list_surface",
  "list_with_details_surface",
]);

const ACTUATION_VERB_FORMS = Object.freeze({
  confirm: ["confirm", "confirms", "confirmed", "confirming", "confirmation"],
  approve: ["approve", "approves", "approved", "approving", "approval"],
  authorize: ["authorize", "authorizes", "authorized", "authorizing", "authorization"],
  authorise: ["authorise", "authorises", "authorised", "authorising", "authorisation"],
  accept: ["accept", "accepts", "accepted", "accepting"],
  buy: ["buy", "buys", "bought", "buying"],
  purchase: ["purchase", "purchases", "purchased", "purchasing"],
  pay: ["pay", "pays", "paid", "paying", "payment", "payments"],
  order: ["order", "orders", "ordered", "ordering"],
  checkout: ["checkout", "checkouts"],
  charge: ["charge", "charges", "charged", "charging"],
  send: ["send", "sends", "sent", "sending"],
  submit: ["submit", "submits", "submitted", "submitting", "submission"],
  publish: ["publish", "publishes", "published", "publishing"],
  deploy: ["deploy", "deploys", "deployed", "deploying", "deployment"],
  delete: ["delete", "deletes", "deleted", "deleting", "deletion"],
  erase: ["erase", "erases", "erased", "erasing"],
  wipe: ["wipe", "wipes", "wiped", "wiping"],
  revoke: ["revoke", "revokes", "revoked", "revoking"],
  grant: ["grant", "grants", "granted", "granting"],
  transfer: ["transfer", "transfers", "transferred", "transferring"],
  unlock: ["unlock", "unlocks", "unlocked", "unlocking"],
  overwrite: ["overwrite", "overwrites", "overwrote", "overwritten", "overwriting"],
  merge: ["merge", "merges", "merged", "merging"],
});

const ACTUATION_VERBS = Object.freeze(Object.keys(ACTUATION_VERB_FORMS));

const EXPIRY_LINKING_PATTERNS = Object.freeze([
  "unless you",
  "unless i hear",
  "unless cancelled",
  "unless canceled",
  "unless stopped",
  "if you do not",
  "if you don't",
  "if i do not hear",
  "if i don't hear",
  "if there is no",
  "if no reply",
  "if no response",
  "no reply",
  "no response",
  "otherwise i will",
  "otherwise i'll",
  "otherwise it will",
  "by default i will",
  "by default i'll",
  "will proceed",
  "proceeds automatically",
  "goes ahead automatically",
  "automatically in",
  "automatically when",
  "automatically once",
  "automatically after",
  "auto-approve",
  "auto approve",
  "auto-confirm",
  "auto confirm",
  "silence means",
  "silence counts",
  "silence is",
  "if you do nothing",
  "do nothing and",
  "do nothing to",
  "when it expires",
  "when this expires",
  "when the window closes",
  "on expiry",
]);

const EXPIRY_WEAK_MENTIONS = Object.freeze([
  "deadline",
  "expires in",
  "expires at",
  "expiring",
  "closes at",
  "time limit",
  "countdown",
]);

const EXPIRY_CONSENT_PATTERNS = Object.freeze(
  EXPIRY_LINKING_PATTERNS.concat(EXPIRY_WEAK_MENTIONS),
);

const SYSTEM_STATS_KNOWN_FIELDS = Object.freeze([
  "memTotalMb",
  "memUsedMb",
  "memFreeMb",
  "memUsedPct",
  "cpuPct",
  "loadAvg1",
]);

const IMPLICIT_TEMPLATE_PATHS = Object.freeze(["output"]);

const DEFAULT_RECOMMENDED_LABEL_CHARS = 30;

const SHORT_INTERACTIVE_TIMEOUT_MS = 60_000;

const REPLACE_SUSPICIOUS_STACK_DEPTH = 2;

const REFERENCES_DIR_FROM_MODULE = "../../skills/glasses-ui/references";

const HTTP_RECIPE_FIELD_SETS_FILE = "http-recipe-field-sets.json";

let cachedHttpRecipeFieldSets;

function referencesDir() {
  return path.resolve(path.dirname(__filename), REFERENCES_DIR_FROM_MODULE);
}

function loadHttpRecipeFieldSets(opts) {
  if (opts && opts.fieldSets) return opts.fieldSets;
  if (cachedHttpRecipeFieldSets !== undefined && !(opts && opts.reload)) {
    return cachedHttpRecipeFieldSets;
  }
  let parsed = null;
  try {
    const raw = fs.readFileSync(path.join(referencesDir(), HTTP_RECIPE_FIELD_SETS_FILE), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  cachedHttpRecipeFieldSets = parsed;
  return parsed;
}

function templateRegistryArtifact() {
  return buildTemplateRegistryArtifact();
}

function resolveTemplateFacts(spec, opts) {
  const requested = spec && typeof spec.template === "string" ? spec.template.trim() : null;
  const findings = [];
  if (!requested) {
    return { requested: null, entry: null, kindMatches: null, factsApplicable: false, findings };
  }
  const artifact = (opts && opts.registry) || templateRegistryArtifact();
  const entries = (artifact && artifact.entries) || [];
  let entry = entries.find((e) => `${e.name}@${e.version}` === requested);
  if (!entry) {
    const byName = entries.filter((e) => e.name === requested);
    byName.sort((a, b) => b.version - a.version);
    entry = byName[0];
  }
  if (!entry) {
    findings.push(
      finding("template_not_in_registry", "template", [
        `template ${JSON.stringify(requested)} resolves to no registry entry.`,
        `The registry is the one source for template identity — an unregistered name`,
        `cannot carry a field set, a consent policy, or a layout budget.`,
      ].join(" ")),
    );
    return { requested, entry: null, kindMatches: null, factsApplicable: false, findings };
  }
  if (entry.disposition === "held") {
    findings.push(
      finding("template_held", "template", [
        `template ${entry.name}@${entry.version} is HELD in the registry`,
        entry.heldReason ? `— ${entry.heldReason}.` : "—",
        `A held entry is never lintable-as-valid; it is registrable, not renderable.`,
      ].join(" ")),
    );
  }
  if (entry.renderableToday === false) {
    const laneNote =
      entry.lane === "kinds_licensed"
        ? `its wire kind ${JSON.stringify(entry.wireKind && entry.wireKind.name)} does not exist in shipped code`
        : `the registry marks it not renderable today`;
    findings.push(
      finding("template_not_renderable_today", "template", [
        `template ${entry.name}@${entry.version} cannot reach a client —`,
        `${laneNote}.`,
        `Rehearsal validates against the host the plan would actually reach, so this`,
        `is an error here rather than a silent no-render at run time.`,
      ].join(" ")),
    );
  }

  const entryKind = (entry.wireKind && entry.wireKind.name) || null;
  const specKind = (spec && spec.kind) || null;
  const kindMatches = entryKind === null || specKind === null ? null : entryKind === specKind;
  if (kindMatches === false) {
    findings.push(
      finding("template_kind_mismatch", "template", [
        `template ${entry.name}@${entry.version} is a template for`,
        `kind ${JSON.stringify(entryKind)}, but the spec declares`,
        `kind ${JSON.stringify(specKind)}.`,
        `Its field set, consent policy and layout budgets describe a different`,
        `surface, so none of them are applied — fix the pairing before reading`,
        `any other finding.`,
      ].join(" ")),
    );
    return { requested, entry, kindMatches, factsApplicable: false, findings };
  }
  for (const field of (entry.fieldSet && entry.fieldSet.fields) || []) {
    const present = spec && spec[field.name] !== undefined && spec[field.name] !== null;
    if (field.requirement === "required" && !present) {
      findings.push(
        finding("template_required_field_missing", field.name, [
          `template ${entry.name}@${entry.version} requires ${field.name}`,
          field.limit ? `(${field.limit})` : "",
          `and the spec omits it.`,
          field.note ? `Registry note — ${field.note}.` : "",
        ].join(" ").replace(/\s+/g, " ").trim()),
      );
    }
    if (field.requirement === "forbidden" && present) {
      findings.push(
        finding("template_forbidden_field_present", field.name, [
          `template ${entry.name}@${entry.version} forbids ${field.name} and the spec sets it.`,
          field.note ? `Registry note — ${field.note}.` : "",
        ].join(" ").replace(/\s+/g, " ").trim()),
      );
    }
  }
  return { requested, entry, kindMatches, factsApplicable: true, findings };
}

function finding(code, field, message) {
  const severity = PLAN_LINT_CODES[code];
  if (!severity) {
    throw new Error(
      `LiveUI plan lint — unknown finding code ${JSON.stringify(code)}. ` +
        `Codes: ${Object.keys(PLAN_LINT_CODES).join(", ")}.`,
    );
  }
  const out = { code, severity, message };
  if (field) out.field = assertHonestFieldName(field, "plan lint finding");
  return out;
}

function collectSpecCopy(spec) {
  const out = [];
  if (!spec || typeof spec !== "object") return out;
  const push = (where, text) => {
    if (typeof text !== "string") return;
    const stripped = text.replace(/\{\{[^}]*\}\}/g, " ").trim();
    if (stripped) out.push({ where, text: stripped });
  };
  push("title", spec.title);
  push("body", spec.body);
  if (Array.isArray(spec.items)) {
    for (let i = 0; i < spec.items.length; i += 1) {
      const item = spec.items[i];
      if (typeof item === "string") push(`items.${i}`, item);
      else if (item && typeof item === "object") {
        push(`items.${i}.label`, item.label);
        push(`items.${i}.body`, item.body);
      }
    }
  }
  const targets = (spec.refresh && spec.refresh.targets) || null;
  if (targets) {
    push("refresh.targets.body", targets.body);
    if (Array.isArray(targets.items)) {
      for (let i = 0; i < targets.items.length; i += 1) {
        const item = targets.items[i];
        if (typeof item === "string") push(`refresh.targets.items.${i}`, item);
        else if (item && typeof item === "object") {
          push(`refresh.targets.items.${i}.label`, item.label);
          push(`refresh.targets.items.${i}.body`, item.body);
        }
      }
    }
    const itemTemplate = targets.itemTemplate;
    if (itemTemplate && typeof itemTemplate === "object") {
      push("refresh.targets.itemTemplate.label", itemTemplate.label);
      push("refresh.targets.itemTemplate.body", itemTemplate.body);
    }
  }
  return out;
}

function copyTexts(copy) {
  return copy.map((c) => (typeof c === "string" ? c : c.text));
}

function tokenize(text) {
  if (typeof text !== "string") return [];
  return text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
}

function findActuationVerbToken(text) {
  const words = tokenize(text);
  for (let i = 0; i < words.length; i += 1) {
    for (const verb of ACTUATION_VERBS) {
      if (ACTUATION_VERB_FORMS[verb].indexOf(words[i]) !== -1) {
        return { verb, form: words[i], index: i };
      }
    }
  }
  return null;
}

function findActuationVerbInText(text) {
  const hit = findActuationVerbToken(text);
  return hit ? hit.verb : null;
}

function findActuationVerb(copy) {
  for (const text of copyTexts(copy)) {
    const hit = findActuationVerbInText(text);
    if (hit) return hit;
  }
  return null;
}

function findPatternInText(text, patterns) {
  if (typeof text !== "string") return null;
  const haystack = text.toLowerCase();
  for (const pattern of patterns) {
    if (haystack.indexOf(pattern) !== -1) return pattern;
  }
  return null;
}

function findExpiryConsentPhrase(copy) {
  for (const text of copyTexts(copy)) {
    const hit = findPatternInText(text, EXPIRY_LINKING_PATTERNS);
    if (hit) return hit;
  }
  return null;
}

function findExpiryWeakMention(copy) {
  for (const text of copyTexts(copy)) {
    const hit = findPatternInText(text, EXPIRY_WEAK_MENTIONS);
    if (hit) return hit;
  }
  return null;
}

function splitConsentClauses(text) {
  if (typeof text !== "string") return [];
  return text
    .split(/[.!?;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function findClauseConsentViolation(clause) {
  const phrase = findPatternInText(clause, EXPIRY_LINKING_PATTERNS);
  if (!phrase) return null;
  const verbToken = findActuationVerbToken(clause);
  if (!verbToken) return null;
  return { verb: verbToken.verb, phrase };
}

function findConsentViolation(copy) {
  for (const record of copy) {
    const text = typeof record === "string" ? record : record.text;
    const where = typeof record === "string" ? null : record.where;
    for (const clause of splitConsentClauses(text)) {
      const hit = findClauseConsentViolation(clause);
      if (hit) return { verb: hit.verb, phrase: hit.phrase, where, text: clause };
    }
  }
  return null;
}

const BUDGET_PROVENANCE = Object.freeze({
  REGISTRY_MEASURED: "registry_measured",
  REGISTRY_UNMEASURED: "registry_unmeasured",
  ENGINE_LIMIT: "engine_limit",
});

const KIND_SCOPED_BUDGET_KEYS = Object.freeze([
  "visibleRowsBeforeFold",
  "maxItems",
  "itemMaxChars",
  "labelMaxChars",
  "recommendedLabelMaxChars",
  "detailBodyMaxChars",
  "maxPages",
  "pageMaxChars",
]);

function resolveLayoutBudgets(spec, entry, opts) {
  const kind = spec && spec.kind;
  const artifact = (opts && opts.registry) || templateRegistryArtifact();
  const entries = (artifact && artifact.entries) || [];

  const kindMeasured = entries.find(
    (e) =>
      e.wireKind &&
      e.wireKind.name === kind &&
      e.layoutBudgets &&
      e.layoutBudgets.measured === true,
  );
  const rawKindBudgets = (kindMeasured && kindMeasured.layoutBudgets.budgets) || {};
  const kindBudgets = {};
  for (const key of KIND_SCOPED_BUDGET_KEYS) {
    if (rawKindBudgets[key] !== undefined) kindBudgets[key] = rawKindBudgets[key];
  }
  const entryBudgets = (entry && entry.layoutBudgets && entry.layoutBudgets.budgets) || {};
  const kindContributes = Object.keys(kindBudgets).length > 0;
  const entryContributes = Object.keys(entryBudgets).length > 0;
  const entryMeasured = Boolean(entry && entry.layoutBudgets && entry.layoutBudgets.measured);
  const sources = [];
  if (kindContributes) sources.push(`template-registry ${kindMeasured.name}@${kindMeasured.version} (measured, kind ${kind})`);
  if (entry) sources.push(`template-registry ${entry.name}@${entry.version} layoutBudgets`);
  sources.push("GLASSES_UI_LIMITS");

  const provenanceByKey = {};
  for (const key of Object.keys(kindBudgets)) {
    provenanceByKey[key] = BUDGET_PROVENANCE.REGISTRY_MEASURED;
  }
  for (const key of Object.keys(entryBudgets)) {
    provenanceByKey[key] = entryMeasured
      ? BUDGET_PROVENANCE.REGISTRY_MEASURED
      : BUDGET_PROVENANCE.REGISTRY_UNMEASURED;
  }
  return {
    budgets: { ...kindBudgets, ...entryBudgets },
    provenanceByKey,
    source: sources.join(" over "),

    registrySourcesMeasured:
      (kindContributes || entryContributes) && (!entryContributes || entryMeasured),
  };
}

function measureLayoutFacts(spec, entry, opts) {
  const resolvedBudgets = resolveLayoutBudgets(spec, entry, opts);
  const budgets = resolvedBudgets.budgets;
  const provenanceByKey = resolvedBudgets.provenanceByKey || {};

  const capFor = (keys, fallback) => {
    for (const key of keys) {
      if (typeof budgets[key] === "number") {
        return {
          value: budgets[key],
          provenance: provenanceByKey[key] || BUDGET_PROVENANCE.REGISTRY_UNMEASURED,
        };
      }
    }
    return { value: fallback, provenance: BUDGET_PROVENANCE.ENGINE_LIMIT };
  };

  const rows = Array.isArray(spec && spec.items) ? spec.items.length : spec && spec.body ? 1 : 0;
  const pageCount = Array.isArray(spec && spec.pages) ? spec.pages.length : 0;
  const fold = capFor(["visibleRowsBeforeFold"], null);
  const visibleRowsBeforeFold = typeof fold.value === "number" ? fold.value : null;
  const folds = visibleRowsBeforeFold !== null && rows > visibleRowsBeforeFold;
  const facts = {
    kind: (spec && spec.kind) || null,
    rows,
    pageCount,
    visibleRowsBeforeFold,
    foldProvenance: visibleRowsBeforeFold === null ? null : fold.provenance,
    foldAfterRowIndex: folds ? visibleRowsBeforeFold - 1 : null,
    rowsBelowFold: folds ? rows - visibleRowsBeforeFold : 0,
    truncations: [],
    budgetSource: resolvedBudgets.source,
    budgetsMeasured: false,
  };
  const titleCap = capFor(["titleMaxChars"], GLASSES_UI_LIMITS.titleMax);
  const bodyCap = capFor(["bodyMaxChars", "captionMaxChars"], GLASSES_UI_LIMITS.bodyMax);
  const itemCap = capFor(["itemMaxChars"], GLASSES_UI_LIMITS.itemMax);
  const labelCap = capFor(["labelMaxChars"], GLASSES_UI_LIMITS.itemMax);
  const detailCap = capFor(["detailBodyMaxChars"], GLASSES_UI_LIMITS.detailBodyMax);
  const pageCap = capFor(["pageMaxChars"], GLASSES_UI_LIMITS.pageMax);
  pushTruncation(facts, "title", spec && spec.title, titleCap);
  pushTruncation(facts, "body", spec && spec.body, bodyCap);
  if (Array.isArray(spec && spec.items)) {
    for (let i = 0; i < spec.items.length; i += 1) {
      const item = spec.items[i];
      if (typeof item === "string") pushTruncation(facts, `items.${i}`, item, itemCap);
      else if (item && typeof item === "object") {
        pushTruncation(facts, `items.${i}.label`, item.label, labelCap);
        pushTruncation(facts, `items.${i}.body`, item.body, detailCap);
      }
    }
  }
  if (Array.isArray(spec && spec.pages)) {
    for (let i = 0; i < spec.pages.length; i += 1) {
      pushTruncation(facts, `pages.${i}`, spec.pages[i], pageCap);
    }
  }

  const factProvenances = facts.truncations.map((t) => t.provenance);
  if (facts.foldProvenance) factProvenances.push(facts.foldProvenance);
  facts.budgetsMeasured =
    resolvedBudgets.registrySourcesMeasured &&
    factProvenances.length > 0 &&
    factProvenances.every((prov) => prov === BUDGET_PROVENANCE.REGISTRY_MEASURED);
  return facts;
}

function pushTruncation(facts, field, value, cap) {
  if (typeof value !== "string" || !cap || typeof cap.value !== "number") return;
  if (value.length <= cap.value) return;
  facts.truncations.push({
    field,
    chars: value.length,
    limitChars: cap.value,
    provenance: cap.provenance,
    overflowChars: value.length - cap.value,
    truncatesAtChar: cap.value,
  });
}

function extractTemplatePaths(template) {
  const out = [];
  if (typeof template !== "string") return out;
  const re = /\{\{([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    const expr = m[1].split("|")[0].trim();
    if (expr) out.push(expr);
  }
  return out;
}

function collectRefreshTemplatePaths(refresh) {
  const targets = (refresh && refresh.targets) || {};
  const out = [];
  const push = (where, template) => {
    for (const p of extractTemplatePaths(template)) out.push({ where, path: p });
  };
  push("refresh.targets.body", targets.body);
  if (Array.isArray(targets.items)) {
    for (let i = 0; i < targets.items.length; i += 1) {
      const item = targets.items[i];
      if (typeof item === "string") push(`refresh.targets.items.${i}`, item);
      else if (item && typeof item === "object") {
        push(`refresh.targets.items.${i}.label`, item.label);
        push(`refresh.targets.items.${i}.body`, item.body);
      }
    }
  }
  const itemTemplate = targets.itemTemplate;
  if (itemTemplate && typeof itemTemplate === "object") {
    push("refresh.targets.itemTemplate.label", itemTemplate.label);
    push("refresh.targets.itemTemplate.body", itemTemplate.body);
  }
  return out;
}

function matchHttpRecipe(recipe, fieldSets) {
  if (!recipe || recipe.kind !== "http" || !fieldSets || !Array.isArray(fieldSets.recipes)) {
    return null;
  }
  let url = null;
  try {
    url = new URL(String(recipe.url));
  } catch {
    return null;
  }
  const method = String(recipe.method || "GET").toUpperCase();
  for (const candidate of fieldSets.recipes) {
    const match = candidate.match || {};
    if (match.method && String(match.method).toUpperCase() !== method) continue;
    if (match.urlHost && match.urlHost !== url.hostname) continue;
    if (match.urlPathPrefix && url.pathname.indexOf(match.urlPathPrefix) !== 0) continue;
    if (match.jsonPath && match.jsonPath !== recipe.jsonPath) continue;
    return candidate;
  }
  return null;
}

function knownPathSet(paths) {
  const set = new Set();
  for (const p of paths) set.add(p);
  return set;
}

function isKnownTemplatePath(rawPath, known, openPrefixes) {
  let p = rawPath;

  if (p.indexOf("previous.") === 0) return p.slice("previous.".length).length > 0;
  if (!p) return true;
  if (IMPLICIT_TEMPLATE_PATHS.indexOf(p) !== -1) return true;
  if (p === "previous") return true;
  if (known.has(p)) return true;
  for (const prefix of openPrefixes) {
    if (prefix && p.indexOf(prefix) === 0) return true;
  }

  for (const candidate of known) {
    if (p.indexOf(`${candidate}.`) === 0) return true;
  }
  return false;
}

function lintGlassesUiPlan(spec, ctx) {
  const options = { ...(ctx || {}) };

  if (!options.registry) options.registry = templateRegistryArtifact();
  const findings = [];
  const resolved = resolveTemplateFacts(spec, options);
  for (const f of resolved.findings) findings.push(f);

  const entry = resolved.factsApplicable ? resolved.entry : null;
  const copy = collectSpecCopy(spec);
  const actuationVerb = findActuationVerb(copy);
  const consentViolation = findConsentViolation(copy);
  const budgets = resolveLayoutBudgets(spec, entry, options).budgets;
  const lifecycle = (entry && entry.lifecycle) || {};
  const consent = (entry && entry.consent) || {};
  const timeoutMs = numberOrNull(spec && spec.timeoutMs);
  const staleAfterMs = numberOrNull(spec && spec.staleAfterMs);
  const refresh = spec && spec.refresh;

  if (PICKABLE_KINDS.indexOf(spec && spec.kind) !== -1 && timeoutMs !== null) {
    const registryMin =
      lifecycle.timeoutMs && typeof lifecycle.timeoutMs.min === "number"
        ? lifecycle.timeoutMs.min
        : null;
    const floor = registryMin !== null ? registryMin : SHORT_INTERACTIVE_TIMEOUT_MS;
    if (timeoutMs < floor) {
      findings.push(
        finding("interactive_timeout_short", "timeoutMs", [
          `timeoutMs ${timeoutMs} on a pickable ${spec.kind} is below the`,
          registryMin !== null
            ? `registry floor for ${entry.name}@${entry.version} (${floor} ms).`
            : `${floor} ms guideline.`,
          `A wearer has to notice the surface, read it, and reach the temple;`,
          `a short window turns a real answer into a window_expired non-answer.`,
        ].join(" ")),
      );
    }
  }

  if (actuationVerb && staleAfterMs === null) {
    findings.push(
      finding("actuation_missing_stale_guard", "staleAfterMs", [
        `copy asks the wearer to "${actuationVerb}" but the spec sets no staleAfterMs.`,
        consent.requiresStaleAfterMs
          ? `Registry entry ${entry.name}@${entry.version} marks the guard required.`
          : "",
        `Without it a tap that arrives minutes later still reads as a fresh answer.`,
      ].join(" ").replace(/\s+/g, " ").trim()),
    );
  }

  if (consentViolation) {
    findings.push(
      finding("actuation_relies_on_expiry", consentViolation.where, [
        `${consentViolation.where || "copy"} pairs the actuating verb`,
        `"${consentViolation.verb}" with the phrase "${consentViolation.phrase}",`,
        `which asserts that NOT responding makes the action happen.`,
        `Silence is never consent and window_expired is the absence of input, not`,
        `an approval. A consequential action must wait for an affirmative tap,`,
        `voice, or chat commitment. A reversible, non-actuating default on a`,
        `stated deadline is the only legal shape here.`,
      ].join(" ")),
    );
  }
  if (consent.actuatesOnExpiry === true) {
    findings.push(
      finding("actuation_relies_on_expiry", "template", [
        `registry entry ${entry.name}@${entry.version} declares`,
        `consent.actuatesOnExpiry true.`,
        `That is only ever legal alongside an explicit expiryRulingRef, and no`,
        `wire field carries one — so rehearsal refuses it.`,
      ].join(" ")),
    );
  }

  if (spec && spec.kind === "list_with_details_surface" && Array.isArray(spec.items)) {
    const recommended =
      typeof budgets.recommendedLabelMaxChars === "number"
        ? budgets.recommendedLabelMaxChars
        : DEFAULT_RECOMMENDED_LABEL_CHARS;
    const hardCap =
      typeof budgets.labelMaxChars === "number" ? budgets.labelMaxChars : GLASSES_UI_LIMITS.itemMax;
    for (let i = 0; i < spec.items.length; i += 1) {
      const item = spec.items[i];
      const label = item && typeof item === "object" ? item.label : null;
      if (typeof label !== "string") continue;
      if (label.length > recommended && label.length <= hardCap) {
        findings.push(
          finding("label_over_visual_budget", `items.${i}.label`, [
            `label is ${label.length} chars — under the ${hardCap}-char hard cap but`,
            `over the ${recommended}-char visual budget, so the client clips it on`,
            `the row and the wearer picks from a truncated string.`,
          ].join(" ")),
        );
      }
    }
  }

  const stackDepth = numberOrNull(options.stackDepth);
  const move = spec && typeof spec.update === "string" ? spec.update : "replace";
  const maxSafeDepth =
    typeof budgets.maxSafeDepthForReplace === "number"
      ? budgets.maxSafeDepthForReplace
      : REPLACE_SUSPICIOUS_STACK_DEPTH - 1;

  if (move === "replace" && stackDepth !== null && stackDepth > maxSafeDepth) {
    findings.push(
      finding("replace_after_push_likely_wrong", "update", [
        `update resolves to "replace"`,
        spec && spec.update === undefined ? `(by default — no update field)` : "",
        `while the session's surface stack is ${stackDepth} deep`,
        `(safe depth for replace is ${maxSafeDepth}).`,
        `Replace overwrites the surface the wearer navigated INTO; "patch" edits it`,
        `in place and "push" opens a child the wearer can back out of.`,
      ].join(" ").replace(/\s+/g, " ").trim()),
    );
  }

  const paths = collectRefreshTemplatePaths(refresh);
  if (paths.length > 0 && refresh && refresh.recipe) {
    const recipeKind = refresh.recipe.kind;
    if (recipeKind === "system-stats") {
      const known = knownPathSet(SYSTEM_STATS_KNOWN_FIELDS);
      for (const p of paths) {
        if (!isKnownTemplatePath(p.path, known, [])) {
          findings.push(
            unknownFieldFinding(p, "error", [
              `system-stats exposes a closed field set —`,
              `${SYSTEM_STATS_KNOWN_FIELDS.join(", ")}.`,
            ].join(" ")),
          );
        }
      }
    } else if (recipeKind === "http") {
      const fieldSets = loadHttpRecipeFieldSets(options);
      const matched = matchHttpRecipe(refresh.recipe, fieldSets);
      if (matched) {
        const mappingPath = refresh.targets && refresh.targets.itemsFromPath;
        const mapping = typeof mappingPath === "string"
          ? (matched.arrayMappings || []).find((candidate) => candidate.path === mappingPath)
          : null;
        if (typeof mappingPath === "string" && !mapping) {
          findings.push(unknownFieldFinding(
            { where: "refresh.targets.itemsFromPath", path: mappingPath },
            matched.fieldSetClosed === true ? "error" : "warning",
            `recipe ${matched.id} does not register this array path.`,
          ));
        }
        const known = knownPathSet(
          ((mapping && mapping.knownFields) || matched.knownFields || []).map((f) => f.path),
        );
        const openPrefixes = (mapping && mapping.openPrefixes) || matched.openPrefixes || [];
        const closed = mapping
          ? mapping.fieldSetClosed === true
          : matched.fieldSetClosed === true;
        for (const p of paths) {
          if (!isKnownTemplatePath(p.path, known, openPrefixes)) {
            findings.push(
              unknownFieldFinding(p, closed ? "error" : "warning", [
                `recipe ${matched.id} ${closed ? "closes" : "leaves open"} its field set`,
                closed ? "" : `(${matched.fieldSetOpenReason || "extensible field set"})`,
                `and does not list this path.`,
              ].join(" ").replace(/\s+/g, " ").trim()),
            );
          }
        }
      }

    }
  }

  const intervalMs = numberOrNull(refresh && refresh.intervalMs);
  if (intervalMs !== null && timeoutMs !== null && intervalMs > timeoutMs) {
    findings.push(
      finding("interval_vs_window", "refresh.intervalMs", [
        `refresh interval ${intervalMs} ms is longer than the ${timeoutMs} ms listen`,
        `window, so the surface never ticks while the wearer can act on it —`,
        `the first tick lands after the window has already closed.`,
      ].join(" ")),
    );
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    template: describeTemplate(resolved),
    layout: measureLayoutFacts(spec, entry, options),
  };
}

function unknownFieldFinding(p, severity, why) {
  const base = finding("template_field_unknown", null, [
    `template path {{${p.path}}} at ${p.where} is not a known field.`,
    why,
  ].join(" "));

  base.severity = severity;
  base.field = assertHonestFieldName(p.where, "plan lint finding");
  return base;
}

function describeTemplate(resolved) {
  if (!resolved || !resolved.entry) {
    return { requested: (resolved && resolved.requested) || null, resolved: false };
  }
  const e = resolved.entry;
  return {
    requested: resolved.requested,
    resolved: true,
    id: `${e.name}@${e.version}`,
    name: e.name,
    version: e.version,
    status: e.status,
    lane: e.lane,
    disposition: e.disposition,
    renderableToday: e.renderableToday === true,
    wireKind: (e.wireKind && e.wireKind.name) || null,
    wireTemplateField: e.wireTemplateField || null,
    fieldSetClosed: Boolean(e.fieldSet && e.fieldSet.closed),
    consentPolicy: (e.consent && e.consent.policy) || null,

    kindMatches: resolved.kindMatches,
    factsApplied: resolved.factsApplicable === true,
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectValidateOnlyChannels(lint, extra) {
  const ok = Boolean(lint && lint.ok);
  const rung = ok ? DELIVERY_RUNGS.VALIDATED : DELIVERY_RUNGS.AUTHORED;
  const errors = (lint && lint.errors) || [];
  const warnings = (lint && lint.warnings) || [];
  const errorCodes = errors.map((f) => f.code);
  const warningCodes = warnings.map((f) => f.code);
  const layout = (lint && lint.layout) || null;
  const template = (lint && lint.template) || null;
  return {

    model: {
      result: "validated",
      ok,
      errors,
      warnings,

      ...(lint && lint.lintSkipped ? { lintSkipped: lint.lintSkipped } : {}),
      normalizedSpec: (extra && extra.normalizedSpec) || null,
      template,
      layout,
      delivery: {
        rung,

        phrasing: DELIVERY_RUNG_PHRASING[rung],
        sendAttempted: false,
        surfaceCreated: false,
      },
    },
    machine: {
      result: "validated",
      ok,
      errorCodes: capCodeList(errorCodes),
      warningCodes: capCodeList(warningCodes),
      errorCount: errorCodes.length,
      warningCount: warningCodes.length,
      template: scrubTemplateRef(template),
      layout: scrubLayoutFacts(layout),
    },
    dev: {
      result: "validated",
      ok,

      errorCodes: capCodeList(errorCodes),
      warningCodes: capCodeList(warningCodes),
      errorCount: errorCodes.length,
      warningCount: warningCodes.length,
      templateId: (template && template.resolved && template.id) || null,
      kind: allowlistWireKind(layout && layout.kind),
      rows: layout ? layout.rows : 0,
      truncationCount: layout ? layout.truncations.length : 0,
      foldAfterRowIndex: layout ? layout.foldAfterRowIndex : null,
    },
  };
}

const MACHINE_PROJECTION_LIST_CAP = 8;

const CAP_SENTINEL_PATTERN = /^\+\d+ more$/;

function isCappedList(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const last = list[list.length - 1];
  return typeof last === "string" && CAP_SENTINEL_PATTERN.test(last);
}

function capCodeList(list) {
  if (!Array.isArray(list)) return [];
  if (isCappedList(list)) return list.slice();
  if (list.length <= MACHINE_PROJECTION_LIST_CAP) return list.slice();
  const head = list.slice(0, MACHINE_PROJECTION_LIST_CAP);
  head.push(`+${list.length - MACHINE_PROJECTION_LIST_CAP} more`);
  return head;
}

function allowlistWireKind(kind) {
  return typeof kind === "string" && WIRE_KIND_ENUM.indexOf(kind) !== -1 ? kind : null;
}

function scrubTemplateRef(template) {
  if (!template) return null;
  if (!template.resolved) {
    return { resolved: false, requestedUnresolved: true, id: null, wireKind: null };
  }
  return {
    resolved: true,
    requestedUnresolved: false,

    id: `${template.name}@${template.version}`,
    name: template.name,
    version: template.version,
    status: template.status,
    lane: template.lane,
    disposition: template.disposition,
    renderableToday: template.renderableToday,
    wireKind: allowlistWireKind(template.wireKind),
    wireTemplateField: template.wireTemplateField,
    fieldSetClosed: template.fieldSetClosed,
    consentPolicy: template.consentPolicy,
    kindMatches: template.kindMatches,
    factsApplied: template.factsApplied,
  };
}

function scrubLayoutFacts(layout) {
  if (!layout) return null;
  const truncations = Array.isArray(layout.truncations) ? layout.truncations : [];
  return {
    kind: allowlistWireKind(layout.kind),
    rows: layout.rows,
    visibleRowsBeforeFold: layout.visibleRowsBeforeFold,
    foldAfterRowIndex: layout.foldAfterRowIndex,
    rowsBelowFold: layout.rowsBelowFold,
    budgetsMeasured: layout.budgetsMeasured,

    truncationCount:
      typeof layout.truncationCount === "number" ? layout.truncationCount : truncations.length,
    truncations: capCodeList(

      truncations.map((t) =>
        typeof t === "string"
          ? t
          : {
              field: t.field,
              chars: t.chars,
              limitChars: t.limitChars,
              overflowChars: t.overflowChars,
              truncatesAtChar: t.truncatesAtChar,
            },
      ),
    ),
  };
}

function boundMachineProjection(machine) {
  if (!machine) return null;
  const errorCodes = capCodeList(machine.errorCodes);
  const warningCodes = capCodeList(machine.warningCodes);
  return {
    result: machine.result,
    ok: machine.ok,
    errorCodes,
    warningCodes,
    errorCount:
      typeof machine.errorCount === "number" ? machine.errorCount : errorCodes.length,
    warningCount:
      typeof machine.warningCount === "number" ? machine.warningCount : warningCodes.length,
    template: scrubTemplateRef(machine.template),
    layout: scrubLayoutFacts(machine.layout),
  };
}

module.exports = { PLAN_LINT_CODES, PLAN_LINT_SEVERITIES, PICKABLE_KINDS, ACTUATION_VERBS, ACTUATION_VERB_FORMS, EXPIRY_CONSENT_PATTERNS, EXPIRY_LINKING_PATTERNS, EXPIRY_WEAK_MENTIONS, SYSTEM_STATS_KNOWN_FIELDS, IMPLICIT_TEMPLATE_PATHS, DEFAULT_RECOMMENDED_LABEL_CHARS, SHORT_INTERACTIVE_TIMEOUT_MS, REPLACE_SUSPICIOUS_STACK_DEPTH, REFERENCES_DIR_FROM_MODULE, HTTP_RECIPE_FIELD_SETS_FILE, loadHttpRecipeFieldSets, templateRegistryArtifact, resolveTemplateFacts, finding, collectSpecCopy, findActuationVerb, findActuationVerbInText, findActuationVerbToken, findExpiryConsentPhrase, findExpiryWeakMention, findConsentViolation, resolveLayoutBudgets, KIND_SCOPED_BUDGET_KEYS, BUDGET_PROVENANCE, measureLayoutFacts, extractTemplatePaths, collectRefreshTemplatePaths, matchHttpRecipe, lintGlassesUiPlan, describeTemplate, projectValidateOnlyChannels, MACHINE_PROJECTION_LIST_CAP, capCodeList, isCappedList, CAP_SENTINEL_PATTERN, allowlistWireKind, scrubTemplateRef, scrubLayoutFacts, boundMachineProjection, splitConsentClauses };
