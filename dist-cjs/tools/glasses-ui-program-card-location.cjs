const { createHash } = require("node:crypto");

const PROGRAM_CARD_LOCATION_CAPABILITY = "programCardsLocationV1";
const PROGRAM_CARD_LOCATION_ANSWER_FRAME = "program_card_location_answer";
const PROGRAM_CARD_LOCATION_LIMITS = Object.freeze({
  consentMs: 60_000,
  cardChars: 40,
  whyChars: 80,
  hosts: 4,
  hostChars: 253,

  declinedMs: 10 * 60_000,

  statusesKept: 128,
});

const PROGRAM_CARD_LOCATION_SETTLE = Object.freeze({ arriveMs: 3_000, answerMs: 65_000, returnMs: 1_500, pollMs: 100 });

const KEY = /^(?:app:[a-z0-9][a-z0-9._-]{0,63}|run:[A-Za-z0-9][A-Za-z0-9._:#-]{0,95})$/;
const HOST = /^[a-z0-9.-]{1,253}$/;

function words(value     , max        ) {
  if (typeof value !== "string") return "";

  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function parseProgramCardLocationAsk(frame     ) {
  const L = PROGRAM_CARD_LOCATION_LIMITS;
  if (!frame || frame.op !== "ask" || typeof frame.key !== "string" || !KEY.test(frame.key)) return null;
  const why = words(frame.why, L.whyChars);
  if (!why) return null;
  const hosts = Array.isArray(frame.hosts) ? frame.hosts : [];
  if (hosts.length > L.hosts || !hosts.every((h     ) => typeof h === "string" && HOST.test(h))) return null;
  return { key: frame.key, card: words(frame.card, L.cardChars) || "This card", why, hosts: [...new Set(hosts            )].sort() };
}

const PROGRAM_CARD_LOCATION_STATUSES = Object.freeze(["ok", "off", "not_allowed", "waiting", "unavailable"]);

const PROGRAM_CARD_LOCATION_HEALTH_REASONS = Object.freeze(["location_off", "not_allowed", "waiting", "no_fix"]);
const STATUS_REASON                                   = Object.freeze({
  off: "location_off", not_allowed: "not_allowed", waiting: "waiting", unavailable: "no_fix",
});

function parseProgramCardLocationStatus(frame     ) {
  if (!frame || frame.op !== "status" || typeof frame.key !== "string" || !KEY.test(frame.key)) return null;
  if (typeof frame.status !== "string" || !PROGRAM_CARD_LOCATION_STATUSES.includes(frame.status)) return null;
  return { key: frame.key, status: frame.status };
}

function parseProgramCardSiteAsk(frame     ) {
  const L = PROGRAM_CARD_LOCATION_LIMITS;
  if (!frame || frame.op !== "site" || typeof frame.key !== "string" || !KEY.test(frame.key)) return null;
  if (typeof frame.host !== "string" || frame.host.length > L.hostChars || !HOST.test(frame.host)) return null;
  return { key: frame.key, card: words(frame.card, L.cardChars) || "This card", host: frame.host, location: frame.location === true };
}

function programCardSiteQuestion(ask                                                                  ) {

  const who = ask.what === "screen" ? "Your agent" : ask.what === "card" && !ask.card ? "A card" : `"${ask.card}"`;
  const lines = [`${who} wants live data from ${ask.host}.`];
  if (ask.location) lines.push("It sends your location there, rounded to about 1 km.");
  return lines.join("\n");
}

function programCardLocationQuestion(ask                                                ) {
  const lines = [`"${ask.card}" wants your location: ${ask.why}${/[.!?…]$/.test(ask.why) ? "" : "."}`];
  lines.push(ask.hosts.length
    ? `It sends it, rounded to about 1 km, to ${ask.hosts.join(", ")}.`
    : "It stays on the card, and the agent sees what the card shows.");
  return lines.join("\n");
}

function createProgramCardLocation(deps      = {}) {
  const limits = { ...PROGRAM_CARD_LOCATION_LIMITS, ...(deps.limits || {}) };
  const send = typeof deps.send === "function" ? deps.send : () => false;
  const presentDecision = typeof deps.presentDecision === "function" ? deps.presentDecision : () => false;

  const grantSite = typeof deps.grantSite === "function" ? deps.grantSite : () => ({ ok: false });

  const siteListed = typeof deps.siteListed === "function" ? deps.siteListed : () => null;
  const activeSessionKey = typeof deps.sessionKey === "function" ? deps.sessionKey : () => null;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const emitLifecycle = typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};

  const pending = new Set        ();

  const siteAsks = new Map                                                                                ();

  const declined = new Map                ();

  const answeredForCard = new Map                                        ();

  const statuses = new Map                                        ();

  const cardHash = (key        ) => createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
  function emit(event        , level        , data     ) {
    try {
      emitLifecycle(event, level, data);
    } catch (_) {

    }
  }

  function siteListedNow(host        ) {
    try {
      const listed = siteListed(host);
      return typeof listed === "boolean" ? listed : null;
    } catch (_) {
      return null;
    }
  }

  function answer(clientId        , frame     , result        ) {
    try {
      send(clientId, { type: PROGRAM_CARD_LOCATION_ANSWER_FRAME, ...frame, answer: result });
    } catch (_) {

    }
  }

  function present(kind        , id        , sessionKey     , title        , question        , onAnswer                                          ) {
    let settled = false;
    const settle = (result        , reason        ) => {
      if (settled) return;
      settled = true;
      onAnswer(result, reason);
    };
    let accepted = false;
    try {
      const result = presentDecision({
        surface: {
          surfaceId: `card-${kind}:${id}:${now().toString(36)}`,
          sessionKey,
          kind: "permission",
          title,
          question,
          options: [
            { key: "allow", label: "Allow" },
            { key: "deny", label: "Not now" },
          ],
          deadlineSec: Math.ceil(limits.consentMs / 1000),
        },
        expiresAtMs: now() + limits.consentMs,
        onDecision: (decision     ) => {
          const choice = decision && decision.choice;
          if (choice === "allow" || choice === "deny") settle(choice, "selected");
          else if (kind === "site" && decision && decision.reason === "dismissed" && decision.doubleTap === true) settle("deny", "double_tap");
          else settle("no_answer", decision && typeof decision.reason === "string" ? decision.reason.slice(0, 24) : "cancel");
        },
      });
      accepted = result === true || (!!result && typeof result === "object" && result.presented === true);
    } catch (_) {
      accepted = false;
    }
    if (!accepted) settle("no_answer", "presentation_failed");
  }

  function siteAsk(host        , sessionKey     , question        , from        , waiter                                                                 ) {
    const waiting = siteAsks.get(host);
    if (waiting) {
      waiting.push(waiter);
      return "waiting";
    }
    siteAsks.set(host, [waiter]);
    emit("program_card_location_request", "info", { site: true, from });
    let shown = true;
    present("site", createHash("sha256").update(host).digest("hex").slice(0, 12), sessionKey, "Allow live data?", question, (result, reason) => {
      if (reason === "presentation_failed") shown = false;
      let final = result;
      let why = reason;

      let grantFailed = false;
      if (result === "allow") {
        let granted      = null;
        try {
          granted = grantSite(host);
        } catch (_) {
          granted = null;
        }
        if (!granted || granted.ok !== true) {
          final = "no_answer";
          why = granted && typeof granted.code === "string" ? granted.code.slice(0, 24) : "grant_failed";
          grantFailed = true;
        }
      }
      const waiters = siteAsks.get(host) || [];
      siteAsks.delete(host);
      emit("program_card_location_answer", "info", { site: true, from, answer: final, reason: why });
      for (const tell of waiters) {
        try {
          tell(final, why, grantFailed);
        } catch (_) {

        }
      }
    });

    return shown ? "asked" : "unavailable";
  }

  function handle(clientId        , frame     ) {
    const status = parseProgramCardLocationStatus(frame);
    if (status) {
      statuses.delete(status.key);
      statuses.set(status.key, { status: status.status, at: now() });
      while (statuses.size > limits.statusesKept) statuses.delete(statuses.keys().next().value          );
      return true;
    }
    const ask = parseProgramCardLocationAsk(frame);
    const site = ask ? null : parseProgramCardSiteAsk(frame);
    if (!ask && !site) {
      emit("program_card_location_ignored", "debug", { reason: "malformed" });
      return false;
    }
    if (site) {

      let before = answeredForCard.get(site.host);

      if (before && before.answer === "allow" && siteListedNow(site.host) === false) {
        answeredForCard.delete(site.host);
        before = undefined;
      }
      if (before && now() - before.at < limits.declinedMs && !siteAsks.has(site.host)) {
        emit("program_card_location_answer", "info", { site: true, from: "card", answer: before.answer, reason: "answered_before" });
        answer(clientId, { key: site.key, site: site.host }, before.answer);
        return true;
      }
      siteAsk(site.host, activeSessionKey(), programCardSiteQuestion(site), "card", (result) => {
        answer(clientId, { key: site.key, site: site.host }, result);
      });
      return true;
    }
    const key = ask .key;
    const id = `${clientId}\n${key}\n${ask .hosts.join(",")}`;
    if (pending.has(id)) return true;
    pending.add(id);
    emit("program_card_location_request", "info", { card: cardHash(key), hosts: ask .hosts.length });
    present("location", cardHash(key), activeSessionKey(), "Share your location?", programCardLocationQuestion(ask ), (result, reason) => {
      pending.delete(id);
      emit("program_card_location_answer", "info", { card: cardHash(key), answer: result, reason });
      answer(clientId, { key, hosts: ask .hosts }, result);
    });
    return true;
  }

  function askSite(request     ) {
    const host = request && typeof request.host === "string" ? request.host.toLowerCase() : "";
    if (!host || host.length > limits.hostChars || !HOST.test(host)) return "invalid";
    const what = request.what === "card" ? "card" : "screen";
    const onAnswer = typeof request.onAnswer === "function" ? request.onAnswer : () => {};
    const at = declined.get(host);
    if (at !== undefined && now() - at < limits.declinedMs && !siteAsks.has(host)) return "declined";
    const sessionKey = typeof request.sessionKey === "string" && request.sessionKey ? request.sessionKey : activeSessionKey();
    const card = what === "card" ? words(request.card, limits.cardChars) : "";
    return siteAsk(host, sessionKey, programCardSiteQuestion({ card, host, location: false, what }), what === "card" ? (card ? "new_card" : "old_card") : "screen", (result        , reason        , grantFailed          ) => {
      const answered = result === "allow" || (reason !== "superseded" && reason !== "presentation_failed");
      if (result === "allow") declined.delete(host);
      else if (answered) declined.set(host, now());
      if (card) {

        if (result === "allow" || reason === "selected" || reason === "double_tap" || grantFailed) {
          answeredForCard.set(host, { answer: result === "allow" ? "allow" : "no_answer", at: now() });
        } else if (answered) answeredForCard.delete(host);
      }
      onAnswer(result);
    });
  }

  function health(key     ) {
    const kept = typeof key === "string" ? statuses.get(key) : undefined;
    const reason = kept && Object.hasOwn(STATUS_REASON, kept.status) ? STATUS_REASON[kept.status] : "";
    return reason ? [{ part: "location", use: "", reason, atMs: kept .at }] : [];
  }

  function asking() {
    return pending.size > 0;
  }

  return { handle, askSite, health, asking };
}

module.exports = { PROGRAM_CARD_LOCATION_CAPABILITY, PROGRAM_CARD_LOCATION_ANSWER_FRAME, PROGRAM_CARD_LOCATION_LIMITS, PROGRAM_CARD_LOCATION_SETTLE, parseProgramCardLocationAsk, PROGRAM_CARD_LOCATION_STATUSES, PROGRAM_CARD_LOCATION_HEALTH_REASONS, parseProgramCardLocationStatus, parseProgramCardSiteAsk, programCardSiteQuestion, programCardLocationQuestion, createProgramCardLocation };
