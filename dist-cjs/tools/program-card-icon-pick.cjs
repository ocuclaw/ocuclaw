const { CARD_ICON_QUESTIONS, cardIconKey, cardIconOf, cardIconState, keywordCardIcon } = require("../domain/program-card-icons.cjs");

const PROGRAM_CARD_ICON_BUDGET_MS = 3000;
const PLANNED_KEYWORD_ICONS_MAX = 64;

function createProgramCardIconPicker(deps      = {}) {
  const saves = deps.saves;
  const budgetMs = Number.isFinite(deps.budgetMs) ? deps.budgetMs : PROGRAM_CARD_ICON_BUDGET_MS;
  const asking = new Map                ();

  const plannedKeywordIcons = new Map                ();
  let backfilled = false;
  let queue               = Promise.resolve();

  function jevClient() {
    try {
      const client = typeof deps.jev === "function" ? deps.jev() : null;
      return client && client.hasKey && typeof client.decide === "function" ? client : null;
    } catch (_) {
      return null;
    }
  }

  function budgetFor(client     ) {
    return Number.isFinite(client && client.budgetMs) && client.budgetMs > 0 ? client.budgetMs : budgetMs;
  }

  function via(client     ) {
    return client && client.kind === "model" ? { via: "model" } : {};
  }

  function report(payload     ) {
    if (typeof deps.report !== "function") return;
    try {
      deps.report(payload);
    } catch (_) {

    }
  }

  function textOf(record     ) {
    const description = (record.cosmetic && record.cosmetic.description) || null;
    return { name: record.name, description, key: cardIconKey(record.name, description) };
  }

  function pick(appId     )               {
    const loaded      = saves.load(appId);
    if (!loaded || loaded.status !== "accepted") return Promise.resolve({ appId, outcome: "skipped", reason: "app_not_found" });
    const cosmetic = loaded.record.cosmetic || {};
    if (cosmetic.iconBy === "wearer") return Promise.resolve({ appId, outcome: "skipped", reason: "wearer" });
    const { name, description, key } = textOf(loaded.record);
    const jev = jevClient();
    if (cosmetic.iconFor === key && cosmetic.iconBy === "jev") {
      return Promise.resolve({ appId, outcome: "skipped", reason: "unchanged" });
    }
    if (asking.get(appId) === key) return Promise.resolve({ appId, outcome: "skipped", reason: "asking" });
    asking.set(appId, key);
    const ask = jev
      ? Promise.resolve()
        .then(() => jev.decide(cardIconState(name, description), { budgetMs: budgetFor(jev), questions: CARD_ICON_QUESTIONS }))
        .catch(() => null)
      : Promise.resolve(null);
    return ask.then((result     ) => {
      if (asking.get(appId) === key) asking.delete(appId);
      const answered = !!(result && result.ok === true);

      const keepKeywords = answered && !cardIconOf(result.answers) && !!jev && jev.kind === "model";
      let icon = answered && !keepKeywords ? cardIconOf(result.answers) : keywordCardIcon(name, description);
      const by = answered ? "jev" : "keywords";
      const answer = answered && result.answers ? result.answers.icon : null;
      const row      = {
        appId,
        by,
        icon,
        confidence: answer && Number.isFinite(answer.confidence) ? answer.confidence : null,
        ms: result && Number.isFinite(result.ms) ? result.ms : null,
        ...via(jev),
        ...(keepKeywords ? { keptKeywords: true } : {}),
        ...(jev && !answered ? { jevFailed: (result && result.reason) || "unknown" } : {}),
      };
      const now      = saves.load(appId);
      if (!now || now.status !== "accepted") return { ...row, outcome: "dropped", reason: "app_not_found" };
      if (textOf(now.record).key !== key) {
        report({ ...row, outcome: "dropped", reason: "changed" });
        return { ...row, outcome: "dropped", reason: "changed" };
      }
      const before = (now.record.cosmetic && now.record.cosmetic.icon) || null;
      const planned = plannedKeywordIcons.get(appId) === key && now.record.cosmetic?.iconBy === "keywords";

      if (keepKeywords && !icon && planned && before) {
        icon = before;
        row.icon = before;
      }
      if (!answered && (before === icon || (planned && before))) {
        report({ ...row, outcome: "unchanged" });
        return { ...row, outcome: "unchanged" };
      }
      const written      = saves.setIcon({ appId, icon, by, ...(answered ? { iconFor: key } : {}) });
      const outcome = written.status === "saved" ? "picked" : written.status === "kept" ? "kept" : "failed";
      report({ ...row, outcome });
      if (outcome === "picked" && before !== (written.icon || null) && typeof deps.onChanged === "function") {
        try {
          deps.onChanged(appId);
        } catch (_) {

        }
      }
      return { ...row, outcome };
    });
  }

  function schedule(appId     )               {
    const next = queue.then(() => pick(appId), () => pick(appId));
    queue = next.catch(() => null);
    return next;
  }

  function planPick(name     , description     ) {
    const title = typeof name === "string" ? name.trim() : "";
    const text = typeof description === "string" ? description.trim() : "";
    const icon = keywordCardIcon(title, text);
    const client = jevClient();
    if (!client) return { icon, jev: null };
    const state = title ? cardIconState(title, text) : { app: text };
    const jev = Promise.resolve()
      .then(() => client.decide(state, { budgetMs: budgetFor(client), questions: CARD_ICON_QUESTIONS }))
      .catch(() => null)
      .then((result     ) => {
        const answered = !!(result && result.ok === true);
        const answer = answered && result.answers ? result.answers.icon : null;
        return {
          icon: answered ? cardIconOf(result.answers) : null,
          confidence: answer && Number.isFinite(answer.confidence) ? answer.confidence : null,
          ms: result && Number.isFinite(result.ms) ? result.ms : null,
          ...via(client),
          ...(answered ? {} : { jevFailed: (result && result.reason) || "unknown" }),
        };
      });
    return { icon, jev };
  }

  function stamp(appId     , planned     ) {
    const icon = planned && typeof planned.icon === "string" && planned.icon ? planned.icon : null;
    const by = planned && (planned.by === "jev" || planned.by === "keywords") ? planned.by : null;
    if (!icon || !by) return { appId, outcome: "skipped", reason: "no_pick" };
    const loaded      = saves.load(appId);
    if (!loaded || loaded.status !== "accepted") return { appId, outcome: "skipped", reason: "app_not_found" };
    if (loaded.record.cosmetic && loaded.record.cosmetic.iconBy === "wearer") {
      return { appId, outcome: "skipped", reason: "wearer" };
    }
    const { key } = textOf(loaded.record);
    const written      = saves.setIcon({ appId, icon, by, ...(by === "jev" ? { iconFor: key } : {}) });
    const outcome = written.status === "saved" ? "planned" : written.status === "kept" ? "kept" : "failed";
    plannedKeywordIcons.delete(appId);
    if (outcome === "planned" && by === "keywords") {
      plannedKeywordIcons.set(appId, key);
      if (plannedKeywordIcons.size > PLANNED_KEYWORD_ICONS_MAX) {
        plannedKeywordIcons.delete(plannedKeywordIcons.keys().next().value          );
      }
    }
    report({ appId, by, icon, outcome });
    return { appId, by, icon, outcome };
  }

  function backfill(items     ) {
    if (backfilled || !Array.isArray(items)) return false;
    backfilled = true;
    for (const item of items) {
      if (item && item.itemType === "app" && typeof item.itemId === "string") schedule(item.itemId);
    }
    return true;
  }

  return { pick, schedule, backfill, planPick, stamp };
}

module.exports = { PROGRAM_CARD_ICON_BUDGET_MS, createProgramCardIconPicker };
