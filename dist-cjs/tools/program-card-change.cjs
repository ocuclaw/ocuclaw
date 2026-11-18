const CARD_CHANGE_LINES_MAX = 6;

const CARD_CHANGE_LINE_MAX = 80;

const CARD_CHANGE_NOTE_MAX = 200;

const CARD_CHANGE_MATCHES_MAX = 3;

const CARD_CHANGE_CODES = Object.freeze({

  unclear: "which_card",

  none: "no_saved_card",

  notOpened: "card_not_opened",
});

const FILLER = new Set(["a", "an", "the", "my", "our", "your", "this", "that", "card", "cards", "app", "apps", "game", "one", "please"]);

function norm(text         )         {
  return typeof text === "string" ? text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim() : "";
}
function words(text        )           {
  return text ? text.split(" ").filter((word) => !FILLER.has(word)) : [];
}
function bigrams(text        )                      {
  const squashed = text.replace(/ /g, "");
  const out = new Map                ();
  for (let i = 0; i < squashed.length - 1; i += 1) {
    const pair = squashed.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

function likeness(a        , b        )         {
  const left = bigrams(a), right = bigrams(b);
  let total = 0, shared = 0;
  for (const count of left.values()) total += count;
  for (const [pair, count] of right) {
    total += count;
    shared += Math.min(count, left.get(pair) ?? 0);
  }
  return total ? (2 * shared) / total : 0;
}

function findSavedCard(cards                , query         )                 {
  const rows = Array.isArray(cards) ? cards.filter((card) => card && typeof card.appId === "string" && typeof card.name === "string") : [];
  const asked = norm(query);
  if (!asked || !rows.length) return { status: "none", matches: [] };
  const raw = typeof query === "string" ? query.trim() : "";
  const byId = rows.find((card) => card.appId === raw);
  if (byId) return { status: "found", card: byId };
  const pick = (found                )                        =>
    found.length === 1 ? { status: "found", card: found[0] }
      : found.length > 1 ? { status: "unclear", matches: found.slice(0, CARD_CHANGE_MATCHES_MAX) } : null;
  const named = pick(rows.filter((card) => norm(card.name) === asked));
  if (named) return named;
  const said = words(asked);
  if (said.length) {
    const holds = pick(rows.filter((card) => {
      const name = words(norm(card.name));
      return name.length > 0 && (said.every((word) => name.includes(word)) || name.every((word) => said.includes(word)));
    }));
    if (holds) return holds;
  }
  const scored = rows.map((card) => ({ card, score: likeness(said.join(" ") || asked, words(norm(card.name)).join(" ") || norm(card.name)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const matches = scored.slice(0, CARD_CHANGE_MATCHES_MAX).map((entry) => entry.card);
  return matches.length ? { status: "unclear", matches } : { status: "none", matches: [] };
}

function fitLine(line         )         {
  if (typeof line !== "string") return "";
  const one = line.replace(/\s+/g, " ").trim();
  return one.length > CARD_CHANGE_LINE_MAX ? `${one.slice(0, CARD_CHANGE_LINE_MAX - 1).trimEnd()}…` : one;
}

function changeAskLines(changeLines         , savedAsks         )           {
  const out           = [];
  const seen = new Set        ();
  for (const raw of [...(Array.isArray(changeLines) ? changeLines : []), ...(Array.isArray(savedAsks) ? savedAsks : [])]) {
    const line = fitLine(raw);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
    if (out.length >= CARD_CHANGE_LINES_MAX) break;
  }
  return out;
}

function changeRevisionNote(wearerWords         , changeLines         )         {
  const words = typeof wearerWords === "string" ? wearerWords.replace(/\s+/g, " ").trim() : "";
  const lines = Array.isArray(changeLines) ? changeLines.map(fitLine).filter(Boolean) : [];
  const note = words || lines.join("; ");
  return note.length > CARD_CHANGE_NOTE_MAX ? `${note.slice(0, CARD_CHANGE_NOTE_MAX - 1).trimEnd()}…` : note;
}

const CARD_CHANGE_WORD_LINES_MAX = 3;

function changeLinesOfWords(words         )           {
  if (typeof words !== "string") return [];
  return words.split(/(?<=[.!?;])\s+|\n+/).map(fitLine).filter(Boolean).slice(0, CARD_CHANGE_WORD_LINES_MAX);
}

function cardChangeTurnLine(change     )         {
  if (!change || change.saved || typeof change.name !== "string" || !Array.isArray(change.lines)) return "";
  const revision = Number.isSafeInteger(change.revision) ? `, revision ${change.revision}` : "";

  if (change.ended === true) {
    const again = change.lines.length ? ` The host then Tests these lines again: ${change.lines.map((line        , i        ) => `${i + 1}. "${line}"`).join("; ")}.` : "";
    return `[Card change] The wearer's change to their saved card "${change.name}"${revision} was not saved, and they may have kept or discarded its draft on their phone since. Do nothing about it unless they ask. If they ask you to fix it and its draft is still the open card, change that open card with edit_glasses_card.${again} Done then saves the change as the card's next revision. Never write a new card, and never save it yourself.`;
  }

  const firstSaved = Number.isSafeInteger(change.firstSaved) ? change.firstSaved : 0;
  const replaces = firstSaved >= 1 && firstSaved <= change.lines.length
    ? ` From number ${firstSaved} they are the card's own asks: if the change replaces one (a new time for an old one), put its number in \`replaces\` on your first edit.` : "";
  const own = firstSaved >= 1 ? firstSaved - 1 : change.lines.length;
  const notChecks = own >= 1 ? ` ${own === 1 ? "Line 1 is" : `Lines 1 to ${own} are`} the wearer's words: if one only tells you something (how to answer, what not to do) and is nothing the card should do, put its number in \`notChecks\` on your first edit.` : "";
  const lines = change.lines.length ? ` The host Tests these lines after your first edit: ${change.lines.map((line        , i        ) => `${i + 1}. "${line}"`).join("; ")}.${notChecks}${replaces} An old line that now fails blocks Done, so fix it.` : "";
  return `[Card change] The wearer is changing their saved card "${change.name}"${revision}. The host opened it on the glasses as a draft: change that open card with edit_glasses_card. Never write a new card, and never save it yourself.${lines} Done saves the change as the card's next revision, by you, noted with the wearer's words.`;
}

const CARD_CHANGE_UNCLEAR_NEXT =
  "Nothing was shown. The name fits more than one saved card, or none exactly: ask the wearer in chat which card they mean, naming the cards in `matches`, then ask again with savedCard set to that card's id.";
const CARD_CHANGE_NONE_NEXT =
  "Nothing was shown. The wearer has no saved card by that name: tell them in one line, and offer to build a new card instead.";

const CARD_ASK_CHANGE_NEXT =
  " It changes a saved card: the host opened cardChange.card as a draft of its saved code (cardChange.draftId). Never write a new card. Just before your first edit, say one or two short sentences on what you will change; then change the open draft with edit_glasses_card. The host then tests cardChange.lines: the change's, then from number cardChange.firstSaved the card's own asks. On your first edit, put the number of a change line that only tells you something (how to answer, what not to do) in `notChecks`, and of an old ask the change replaces (a new time for an old one) in `replaces`. An old line that now fails blocks Done, so fix it. Done saves the change as a new revision of the card: never save it yourself.";

const NOT_OPENED_NEXT = "The card could not be opened for the change. Tell the wearer in one line, and build nothing.";

const notOpenedNext = (why        ) =>
  `The card could not be opened for the change. ${why} Tell the wearer the fix in one short line, and build nothing.`;

function cardChangeHandOff(change     , opened     , why = "") {
  const draft = opened?.ok === true ? opened.draft : null;
  if (!draft || typeof draft.draftId !== "string") {
    return {
      refused: CARD_CHANGE_CODES.notOpened,
      ...(typeof change?.name === "string" ? { card: change.name } : {}),
      openError: typeof opened?.error === "string" ? opened.error : "draft_unavailable",
      ...(why ? { openWhy: why } : {}),
      next: why ? notOpenedNext(why) : NOT_OPENED_NEXT,
    };
  }
  const lines = Array.isArray(change.lines) ? change.lines.slice() : [];

  const firstSaved = Number.isSafeInteger(change.own?.length) ? change.own.length + 1 : 0;
  return {
    card: change.name,
    appId: change.appId,
    draftId: draft.draftId,
    ...(Number.isSafeInteger(draft.base?.revision) ? { revision: draft.base.revision } : {}),
    lines,
    ...(firstSaved >= 1 && firstSaved <= lines.length ? { firstSaved } : {}),
    ...(opened.shown !== true ? { onPhone: true } : {}),
  };
}

const CARD_CHANGE_REPLACES_MAX = CARD_CHANGE_LINES_MAX;

function changeReplacesOf(raw         )                  {
  if (!Array.isArray(raw) || !raw.length || raw.length > CARD_CHANGE_REPLACES_MAX) return null;
  const out           = [];
  for (const value of raw) {
    if (!Number.isSafeInteger(value) || (value          ) < 1 || (value          ) > CARD_CHANGE_LINES_MAX) return null;
    if (!out.includes(value          )) out.push(value          );
  }
  return out;
}

const PROGRAM_CARD_CHANGE_SAVED_TYPE = "ocuclaw.program_card.change.saved";

const CARD_CHANGE_TTL_MS = 30 * 60_000;
const CARD_CHANGE_SESSIONS_MAX = 64;

function createCardChanges(deps     ) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const keyOf = typeof deps.keyOf === "function" ? deps.keyOf : (sessionKey        ) => sessionKey;
  const changes = new Map             ();
  const current = (sessionKey        ) => {
    const key = keyOf(sessionKey);
    const change = changes.get(key);
    if (change && now() - change.at > CARD_CHANGE_TTL_MS) changes.delete(key);
    return changes.get(key) ?? null;
  };

  const draftStillOpen = async (sessionKey        , draftId        ) => {
    if (typeof deps.draftOpen !== "function") return true;
    try {
      return (await deps.draftOpen(sessionKey, draftId)) !== false;
    } catch (_) {
      return true;
    }
  };
  const api      = {

    find(query         )                 {
      let rows        = [];
      try {
        rows = Array.isArray(deps.list?.()) ? deps.list() : [];
      } catch (_) {
        rows = [];
      }
      return findSavedCard(rows.map((row) => ({ appId: row.appId, name: row.name,
        ...(Number.isSafeInteger(row.revision) ? { revision: row.revision } : {}) })), query);
    },

    async open(sessionKey        , input     ) {
      const appId = typeof input?.appId === "string" ? input.appId : "";

      const key = keyOf(sessionKey);
      changes.delete(key);
      const loaded = appId ? deps.load?.(appId) : null;
      if (loaded?.status !== "accepted") return cardChangeHandOff({ appId }, { ok: false, error: "not_found" });
      const asks = loaded.record.asks && typeof loaded.record.asks === "object" ? loaded.record.asks : null;

      const own = changeAskLines(input.lines, []);
      const savedAsks = changeAskLines(asks?.requirements, []);
      const change = {
        appId,
        name: loaded.record.name,
        own,
        savedAsks,
        replaced: []            ,
        lines: changeAskLines(own, savedAsks),
        ...(typeof asks?.request === "string" ? { request: asks.request } : {}),
        note: typeof input.note === "string" ? input.note : "",
      };

      const opts = { ...(input.approved === true ? { approved: true } : {}), ...(input.state !== undefined ? { state: input.state } : {}) };
      let opened      = null;
      try {
        opened = Object.keys(opts).length ? await deps.openSaved(sessionKey, appId, opts) : await deps.openSaved(sessionKey, appId);
      } catch (_) {
        opened = null;
      }
      let why = "";
      if (opened?.ok !== true && typeof opened?.error === "string" && typeof deps.openWhy === "function") {
        try {
          const told = deps.openWhy(sessionKey, opened.error);
          why = typeof told === "string" ? told : "";
        } catch (_) {
          why = "";
        }
      }
      const handOff      = cardChangeHandOff(change, opened, why);
      if (!handOff.refused) {
        changes.set(key, { ...change, draftId: handOff.draftId, ...(Number.isSafeInteger(handOff.revision) ? { revision: handOff.revision } : {}),
          at: now(), saved: null });
        while (changes.size > CARD_CHANGE_SESSIONS_MAX) changes.delete(changes.keys().next().value          );
      }
      return handOff;
    },

    of(sessionKey        ) {
      const change = current(sessionKey);
      return change ? { appId: change.appId, name: change.name, draftId: change.draftId,
        ...(Number.isSafeInteger(change.revision) ? { revision: change.revision } : {}), lines: change.lines.slice(),
        ...(change.own.length < change.lines.length ? { firstSaved: change.own.length + 1 } : {}),
        replaced: change.replaced.slice(), saved: change.saved ? { ...change.saved } : null, ...(change.tested ? { tested: true } : {}),
        ...(change.ended ? { ended: true } : {}), ...(change.round ? { round: change.round } : {}) } : null;
    },

    replace(sessionKey        , numbers         , notChecks          ) {
      const change = current(sessionKey);
      if (!change || change.saved) return null;
      const picked = changeReplacesOf(numbers) ?? [];
      const drop = picked.filter((number) => number > change.own.length && number <= change.lines.length)
        .map((number) => change.lines[number - 1]);

      const told = (changeReplacesOf(notChecks) ?? []).filter((number) => number <= change.own.length)
        .map((number) => change.lines[number - 1]);
      if (!drop.length && !told.length) return { lines: change.lines.slice(), replaced: [], notChecks: [] };
      const gone = new Set(drop.map((line        ) => line.toLowerCase()));
      const said = new Set(told.map((line        ) => line.toLowerCase()));
      change.replaced.push(...drop);
      change.notChecks = [...(change.notChecks ?? []), ...told];
      change.own = change.own.filter((line        ) => !said.has(line.toLowerCase()));
      change.savedAsks = change.savedAsks.filter((line        ) => !gone.has(line.toLowerCase()));
      change.lines = changeAskLines(change.own, change.savedAsks);
      return { lines: change.lines.slice(), replaced: drop, notChecks: told };
    },

    async ask(sessionKey        , input     ) {
      const appId = typeof input?.appId === "string" ? input.appId : "";

      const again = input?.again === true;
      const words = again ? "" : typeof input?.words === "string" ? input.words.replace(/\s+/g, " ").trim() : "";
      const going = current(sessionKey);

      if (going && !going.saved && going.appId === appId && !(await draftStillOpen(sessionKey, going.draftId))) {
        changes.delete(keyOf(sessionKey));
        return api.open(sessionKey, { appId, lines: changeLinesOfWords(words), note: changeRevisionNote(words, []),
          ...(input?.approved === true ? { approved: true } : {}), ...(input?.state !== undefined ? { state: input.state } : {}) });
      }

      if (going && !going.saved && going.appId === appId && input?.fresh !== true) {

        const told = new Set((going.notChecks ?? []).map((line        ) => line.toLowerCase()));
        const fresh = changeLinesOfWords(words).filter((line) => !going.own.includes(line) && !told.has(line.toLowerCase()));
        going.own = [...fresh, ...going.own];
        going.lines = changeAskLines(going.own, going.savedAsks);
        if (words && fresh.length) going.note = changeRevisionNote(going.note ? `${going.note}; ${words}` : words, []);
        going.at = now();
        delete going.ended;
        return { card: going.name, appId, draftId: going.draftId, ...(Number.isSafeInteger(going.revision) ? { revision: going.revision } : {}),
          lines: going.lines.slice(), ...(going.own.length < going.lines.length ? { firstSaved: going.own.length + 1 } : {}), kept: true };
      }

      const carried = input?.carry === true && going && !going.saved && going.appId === appId ? going : null;
      if (carried) {
        const told = new Set((carried.notChecks ?? []).map((line        ) => line.toLowerCase()));
        const fresh = changeLinesOfWords(words).filter((line) => !carried.own.includes(line) && !told.has(line.toLowerCase()));
        const note = words && fresh.length ? changeRevisionNote(carried.note ? `${carried.note}; ${words}` : words, []) : carried.note;
        return api.open(sessionKey, { appId, lines: [...fresh, ...carried.own], note: typeof note === "string" ? note : "",
          ...(input?.approved === true ? { approved: true } : {}), ...(input?.state !== undefined ? { state: input.state } : {}) });
      }
      return api.open(sessionKey, { appId, lines: changeLinesOfWords(words), note: changeRevisionNote(words, []),
        ...(input?.approved === true ? { approved: true } : {}), ...(input?.state !== undefined ? { state: input.state } : {}) });
    },

    done(sessionKey        ) {
      const change = current(sessionKey);
      if (!change) return null;
      if (change.saved) return { status: "saved", card: change.name, appId: change.appId, revision: change.saved.revision };
      const asks = change.lines.length ? { ...(change.request ? { request: change.request } : {}), requirements: change.lines.slice() }
        : change.request ? { request: change.request } : null;
      let result      = null;
      try {
        result = deps.promoteChange(sessionKey, change.draftId, { by: "agent", note: change.note, ...(asks ? { asks } : {}) });
      } catch (_) {
        result = null;
      }
      if (result?.status !== "saved" || !Number.isSafeInteger(result.revision)) {
        return { status: "rejected", card: change.name, appId: change.appId, code: typeof result?.code === "string" ? result.code : "save_failed" };
      }
      change.saved = { revision: result.revision };
      try {

        deps.onSaved?.(change.appId, { draftId: change.draftId, revision: result.revision, name: change.name });
      } catch (_) {

      }
      return { status: "saved", card: change.name, appId: change.appId, revision: result.revision };
    },

    tested(sessionKey        , on = true) {
      const change = current(sessionKey);
      if (!change || change.saved) return false;

      change.tested = on;
      return true;
    },

    liveFailed(sessionKey        , failed         ) {
      const change = current(sessionKey);
      if (!change || change.saved) return false;
      change.liveFailed = failed === true;
      return true;
    },

    setAside(sessionKey        ) {
      const change = current(sessionKey);
      if (!change || change.saved) return false;
      change.ended = true;

      change.tested = false;
      change.round = (Number.isSafeInteger(change.round) ? change.round : 0) + 1;
      return true;
    },

    async revive(sessionKey        , draftId         ) {
      const change = current(sessionKey);
      if (!change || change.saved) return false;
      if (typeof draftId === "string" && draftId !== change.draftId) return false;
      if (!change.ended) return true;
      if (await draftStillOpen(sessionKey, change.draftId)) {
        delete change.ended;
        return true;
      }
      if (changes.get(keyOf(sessionKey)) === change) changes.delete(keyOf(sessionKey));
      return false;
    },

    doneAt(sessionKey        , done                                                  ) {
      const change = current(sessionKey);

      if (!change || change.saved || change.ended || !change.tested || done?.by === "stopped" || done?.outcome !== "draft") return null;
      const failed = Number(done?.lines?.still_open);
      if (Number.isFinite(failed) && failed > 0) return { status: "kept", card: change.name, appId: change.appId, code: "line_failed" };
      if (change.liveFailed === true) return { status: "kept", card: change.name, appId: change.appId, code: "live_failed" };
      return api.done(sessionKey);
    },
  };
  return api;
}

module.exports = { CARD_CHANGE_LINES_MAX, CARD_CHANGE_LINE_MAX, CARD_CHANGE_NOTE_MAX, CARD_CHANGE_MATCHES_MAX, CARD_CHANGE_CODES, findSavedCard, changeAskLines, changeRevisionNote, CARD_CHANGE_WORD_LINES_MAX, changeLinesOfWords, cardChangeTurnLine, CARD_CHANGE_UNCLEAR_NEXT, CARD_CHANGE_NONE_NEXT, CARD_ASK_CHANGE_NEXT, cardChangeHandOff, CARD_CHANGE_REPLACES_MAX, changeReplacesOf, PROGRAM_CARD_CHANGE_SAVED_TYPE, CARD_CHANGE_TTL_MS, createCardChanges };
