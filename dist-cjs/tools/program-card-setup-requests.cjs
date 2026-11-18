const nodeFs = require("node:fs");

const path = require("node:path");

const { atomicWriteLiveuiLibraryRecord, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { carryUnknownFields, knownFields } = require("./saved-format.cjs");

const PROGRAM_CARD_SETUP_REQUESTS_FILENAME = "program-card-setup-requests-v1.json";

const PROGRAM_CARD_SETUP_REQUESTS_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "keptOff"],
  lists: { keptOff: { fields: ["target", "atMs"], by: "target" } },
});
const PROGRAM_CARD_SETUP_LIMITS = Object.freeze({
  requestWaitMs: 60_000,
  requestGraceMs: 2000,

  usesWaitMs: 4 * 60_000,

  saveMs: 20_000,

  maxUnanswered: 2,

  maxShown: 6,
  shownWindowMs: 10 * 60_000,

  maxKeptOff: 256,
  maxSessions: 64,
});
const PROGRAM_CARD_SETUP_SWITCHES = Object.freeze(["mcp", "jev", "model"]         );

const L = PROGRAM_CARD_SETUP_LIMITS;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TARGET = /^(?:switch:(?:mcp|jev|model)|server:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

const HOST_COMMANDS_SERVER = "host";
const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const isSwitch = (value     )                           => PROGRAM_CARD_SETUP_SWITCHES.includes(value);

const SWITCH_WORDS                                                                     = Object.freeze({
  mcp: { name: "MCP in cards", means: "Cards could read your MCP tools." },
  jev: { name: "Jev in cards", means: "Cards could ask Jev questions with this host's key." },
  model: { name: "Models in cards", means: "Cards could call a model." },
});
const EACH_CARD_ASKS = "Each card still asks you first.";

const USE_SHOWN_ANSWERS = new Set(["allowed", "declined", "no_answer"]);

function createProgramCardSetupRequestsStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, PROGRAM_CARD_SETUP_REQUESTS_FILENAME);
  const named = (raw     ) => isPlainObject(raw) && typeof raw.target === "string" && TARGET.test(raw.target);
  const timed = (raw     ) => Number.isSafeInteger(raw.atMs) && raw.atMs >= 0;
  const valid = (raw     ) => (named(raw) && timed(raw) ? { target: raw.target, atMs: raw.atMs } : null);

  const UNREADABLE         = { rows: [], state: "unreadable" };

  function saved()      {
    let text        ;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error     ) {
      return error && error.code === "ENOENT" ? null : undefined;
    }
    let doc     ;
    try {
      doc = JSON.parse(text);
    } catch (_) {
      return undefined;
    }
    return isPlainObject(doc) && doc.schemaVersion === 1 && Array.isArray(doc.keptOff) ? doc : undefined;
  }

  function load()         {
    const onDisk = saved();
    if (onDisk === null) return { rows: [], state: "ok" };
    if (onDisk === undefined) return UNREADABLE;
    const doc = knownFields(onDisk, PROGRAM_CARD_SETUP_REQUESTS_SAVED_SHAPE);
    const byTarget = new Map                                          ();
    let whole = doc.keptOff.length <= L.maxKeptOff;
    for (const raw of doc.keptOff) {
      if (!named(raw)) {
        whole = false;
        continue;
      }

      const row = { target: raw.target          , atMs: timed(raw) ? raw.atMs           : 0 };
      if (!timed(raw) || byTarget.has(row.target)) whole = false;
      if ((byTarget.get(row.target)?.atMs ?? -1) < row.atMs) byTarget.set(row.target, row);
    }
    const rows = [...byTarget.values()].sort((a, b) => b.atMs - a.atMs).slice(0, L.maxKeptOff);
    return { rows, state: whole ? "ok" : "partial" };
  }

  const read = () => load().rows;
  const broken = () => load().state !== "ok";
  const unreadable = () => load().state === "unreadable";

  function write(rows       ) {
    const keptOff = (Array.isArray(rows) ? rows : []).map(valid).filter(Boolean)
      .sort((a     , b     ) => b.atMs - a.atMs).slice(0, L.maxKeptOff);
    const next = { schemaVersion: 1, keptOff };
    const save = (record     ) => {
      try {
        return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record }).status === "written";
      } catch (_) {
        return false;
      }
    };

    let carried      = null;
    try {
      const before = saved();
      if (before) {
        const times = new Map                ();
        for (const row of before.keptOff) if (named(row)) times.set(row.target, (times.get(row.target) || 0) + 1);
        const once = before.keptOff.filter((row     ) => named(row) && times.get(row.target) === 1);
        carried = carryUnknownFields({ ...before, keptOff: once }, next, PROGRAM_CARD_SETUP_REQUESTS_SAVED_SHAPE);
      }
    } catch (_) {
      carried = null;
    }

    return (carried !== null && save(carried)) || save(next);
  }

  return { file, read, broken, unreadable, write };
}

function cardSetupQuestion(target                                                                              , during         = "") {

  const forCard = during === "setup" ? "Your agent asks, during setup." : "Your agent asks, to fix a card.";
  if (target.kind === "switch") {
    const words = SWITCH_WORDS[target.name];
    return { title: `Turn on ${words.name}?`, question: [forCard, `${words.means} ${EACH_CARD_ASKS}`].join("\n") };
  }

  const shown = target.name.length > 44 ? `${target.name.slice(0, 43)}…` : target.name;
  return { title: `Let cards read ${shown}?`, question: [forCard, `Cards could read this MCP server's tools. ${EACH_CARD_ASKS}`].join("\n") };
}

function createProgramCardSetupRequests(deps      = {}) {
  const store = deps.store || null;
  const presentDecision = typeof deps.presentDecision === "function" ? deps.presentDecision : () => false;
  const cancelDecision = typeof deps.cancelDecision === "function" ? deps.cancelDecision : () => false;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const emit = (event        , data     ) => {
    try { deps.emitLifecycle?.(event, "info", data); } catch (_) {  }
  };

  let open      = null;
  let usesAsking = false;
  let seq = 0;

  const chats = new Map                                                     ();
  const NO_CHAT = Object.freeze({ notNow: new Set        ()                       , unanswered: 0 });
  const seen = (sessionKey        ) => chats.get(sessionKey) || NO_CHAT;
  const chat = (sessionKey        ) => {
    let row = chats.get(sessionKey);
    if (row) chats.delete(sessionKey);
    else row = { notNow: new Set(), unanswered: 0 };
    chats.set(sessionKey, row);
    while (chats.size > L.maxSessions) chats.delete(chats.keys().next().value          );
    return row;
  };

  const shown           = [];
  const shownTooMany = () => {
    const from = now() - L.shownWindowMs;
    while (shown.length && shown[0] <= from) shown.shift();
    return shown.length >= L.maxShown;
  };

  const capped = (mine                        ) => (mine.unanswered >= L.maxUnanswered ? "chat" : shownTooMany() ? "window" : null);
  const notShown = (because        ) => ({ answer: "no_answer", asked: false, because });

  const keptOff = ()        => {
    try { return store ? store.read() : []; } catch (_) { return []; }
  };
  const storeBroken = () => {
    try { return !!store && typeof store.broken === "function" && store.broken() === true; } catch (_) { return true; }
  };
  const storeUnreadable = () => {
    try { return !!store && typeof store.unreadable === "function" && store.unreadable() === true; } catch (_) { return true; }
  };
  const isKeptOff = (target        ) => keptOff().some((row     ) => row.target === target);
  function keepOff(target        ) {
    if (!store) return false;
    try {
      return store.write([{ target, atMs: now() }, ...keptOff().filter((row     ) => row.target !== target)]) === true;
    } catch (_) {
      return false;
    }
  }

  function noteOn(target     ) {
    if (typeof target !== "string" || !TARGET.test(target)) return false;
    for (const row of chats.values()) row.notNow.delete(target);
    if (!store || storeUnreadable()) return false;
    const broken = storeBroken();
    if (!broken && !isKeptOff(target)) return false;
    emit("program_card_setup_kept_off_cleared", { target });
    try {
      return store.write(keptOff().filter((row     ) => row.target !== target)) === true;
    } catch (_) {
      return false;
    }
  }

  const switchesNow = () => {
    try {
      const s = deps.switches?.();
      return isPlainObject(s) ? s : {};
    } catch (_) {
      return {};
    }
  };
  const serversNow = async ()                 => {
    try {
      const rows = await deps.servers?.();
      return Array.isArray(rows) ? rows.filter((row     ) => isPlainObject(row) && typeof row.name === "string") : [];
    } catch (_) {
      return [];
    }
  };

  function ask(target        , sessionKey        , words                                     )                  {
    if (open) return Promise.resolve("busy");
    const id = `cs${(++seq).toString(36)}${now().toString(36)}`;
    let resolve     ;
    const promise = new Promise        ((r) => { resolve = r; });
    const entry      = { id, target, surfaceId: `card-setup:${id}`, settled: false, timer: null };
    const settle = (answer        , viaGlasses         ) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer) clearTimeoutFn(entry.timer);
      if (open === entry) open = null;
      if (!viaGlasses) {
        try { cancelDecision(entry.surfaceId); } catch (_) {  }
      }
      resolve(answer);
    };
    entry.settle = settle;
    open = entry;
    let accepted = false;
    try {
      const result = presentDecision({
        surface: {
          surfaceId: entry.surfaceId,
          sessionKey,
          kind: "permission",
          title: words.title,
          question: words.question,
          options: [
            { key: "allow", label: "Allow" },
            { key: "deny", label: "Not now" },
            { key: "never", label: "Keep it off" },
          ],
          deadlineSec: Math.ceil(L.requestWaitMs / 1000),
        },
        expiresAtMs: now() + L.requestWaitMs,
        onDecision: (decision     ) => {
          const choice = decision && (decision.choice || decision.key || decision.optionKey);
          settle(choice === "allow" ? "allow" : choice === "deny" ? "not_now" : choice === "never" ? "keep_off" : "no_answer", true);
        },
      });
      accepted = result === true || (!!result && typeof result === "object" && result.presented === true);
    } catch (_) {
      accepted = false;
    }
    if (accepted) shown.push(now());
    if (!accepted) settle("no_glasses", true);
    else if (!entry.settled) {
      const handle = setTimeoutFn(() => settle("no_answer", false), L.requestWaitMs + L.requestGraceMs);
      if (handle && typeof handle.unref === "function") handle.unref();
      entry.timer = handle;
    }
    return promise;
  }

  async function considerTarget(sessionKey        , target        , words                                     ,
    isOn               , turnOn                        )               {
    const broken = storeBroken();
    if (isOn()) {

      if (!broken) noteOn(target);
      return { answer: "on" };
    }
    if (isKeptOff(target)) return { answer: "kept_off" };
    if (broken) {
      emit("program_card_setup_record_unreadable", { target });
      return notShown("record");
    }
    const before = seen(sessionKey);
    if (before.notNow.has(target)) return { answer: "not_now" };
    const cap = capped(before);
    if (cap) return notShown(cap);
    if (open || usesAsking) return { answer: "busy" };
    emit("program_card_setup_request", { target });
    const choice = await ask(target, sessionKey, words);

    if (choice === "no_glasses" || choice === "busy") return { answer: choice };
    const mine = chat(sessionKey);
    let answer = "no_answer";
    if (choice === "allow") {

      const done = await new Promise         ((resolve) => {
        const handle = setTimeoutFn(() => resolve(false), L.saveMs);
        if (handle && typeof handle.unref === "function") handle.unref();
        Promise.resolve().then(turnOn).then(
          (ok         ) => { clearTimeoutFn(handle); resolve(ok === true); },
          () => { clearTimeoutFn(handle); resolve(false); },
        );
      });
      answer = done ? "allowed" : "failed";
      mine.unanswered = 0;
    } else if (choice === "not_now") {
      mine.notNow.add(target);
      mine.unanswered = 0;
      answer = "not_now";
    } else if (choice === "keep_off") {

      mine.notNow.add(target);
      mine.unanswered = 0;
      answer = keepOff(target) ? "kept_off" : "not_now";
    } else {
      mine.unanswered += 1;
    }
    emit("program_card_setup_answer", { target, answer });
    return { answer };
  }

  async function considerNow(input     )               {
    const sessionKey = typeof input.sessionKey === "string" && input.sessionKey.trim() ? input.sessionKey.trim() : "";
    if (!sessionKey) return { answer: "no_answer", asked: false };
    const what = input.what;
    const during = input.during === "setup" ? "setup" : "";
    if (isSwitch(what)) {
      return considerTarget(sessionKey, `switch:${what}`, cardSetupQuestion({ kind: "switch", name: what }, during),
        () => switchesNow()[what] === true,
        () => Promise.resolve(deps.saveSwitch?.(what)).then((ok     ) => ok === true));
    }
    if (what === "server") {
      const server = typeof input.server === "string" && SERVER.test(input.server) ? input.server : "";
      if (!server || server === HOST_COMMANDS_SERVER) return { answer: "invalid", error: "server must be the name of one of the host's MCP servers" };
      if (switchesNow().mcp !== true) return { answer: "needs_switch", needs: "mcp" };
      const row = (await serversNow()).find((r     ) => r.name === server);
      if (!row) return { answer: "invalid", error: `the host lists no MCP server named ${server}` };
      const out = await considerTarget(sessionKey, `server:${server}`, cardSetupQuestion({ kind: "server", name: server }, during),
        () => row.cards === true,

        async () => {
          await deps.allowServer?.(server);
          return (await serversNow()).some((r     ) => r.name === server && r.cards === true);
        });
      return { ...out, server };
    }
    if (what === "use") {
      const key = typeof input.card?.key === "string" ? input.card.key : "";
      if (!key) return { answer: "no_card" };

      if (storeBroken()) {
        emit("program_card_setup_record_unreadable", { target: "use" });
        return notShown("record");
      }
      const cap = capped(seen(sessionKey));
      if (cap) return notShown(cap);
      if (open || usesAsking) return { answer: "busy" };

      const canShow = typeof deps.canShow === "function" ? () => { try { return deps.canShow() !== false; } catch (_) { return true; } } : null;
      if (canShow && !canShow()) return { answer: "no_glasses" };
      const count = () => {
        try {
          const n = deps.requestsShown?.();
          return Number.isSafeInteger(n) ? n           : null;
        } catch (_) {
          return null;
        }
      };
      const before = count();
      let parts      = {};
      let timedOut = false;
      usesAsking = true;
      try {

        parts = (await new Promise     ((resolve) => {
          const handle = setTimeoutFn(() => { timedOut = true; resolve({}); }, L.usesWaitMs);
          if (handle && typeof handle.unref === "function") handle.unref();
          Promise.resolve().then(() => deps.askUses?.({ key, sessionKey })).then(
            (out     ) => { clearTimeoutFn(handle); resolve(out); },
            () => { clearTimeoutFn(handle); resolve({}); },
          );
        })) || {};
      } catch (_) {
        parts = {};
      } finally {
        usesAsking = false;
      }
      if (timedOut) {
        chat(sessionKey).unanswered += 1;
        const late = count();
        const some = before != null && late != null ? Math.max(0, late - before) : 1;
        for (let i = 0; i < Math.min(some, 3); i += 1) shown.push(now());
        emit("program_card_setup_answer", { target: "use", answer: "no_answer" });
        return { answer: "no_answer" };
      }
      const asked = Object.entries(isPlainObject(parts) ? parts : {})
        .filter(([part, answer]) => ["mcp", "jev", "model"].includes(part) && typeof answer === "string")                           ;

      const shownAnswers = asked.map(([, answer]) => answer).filter((a) => USE_SHOWN_ANSWERS.has(a));
      if (!shownAnswers.length) return asked.length ? { answer: "nothing_waiting", parts: Object.fromEntries(asked) } : { answer: "nothing_waiting" };

      const after = count();
      const took = before != null && after != null ? Math.max(0, after - before) : shownAnswers.length;

      const joined = !took && shownAnswers.includes("no_answer");
      if (joined && !canShow) return { answer: "no_glasses" };
      for (let i = 0; i < Math.min(took, 3); i += 1) shown.push(now());
      const answer = shownAnswers.includes("declined") ? "declined" : shownAnswers.every((a) => a === "allowed") ? "allowed" : "no_answer";

      if (took || joined) {
        const mine = chat(sessionKey);
        if (answer === "no_answer") mine.unanswered += 1;
        else mine.unanswered = 0;
      }
      emit("program_card_setup_answer", { target: "use", answer });
      return { answer, parts: Object.fromEntries(asked) };
    }
    return { answer: "invalid", error: "what must be mcp, jev, model, server or use" };
  }

  function consider(input     )               {
    try {
      return considerNow(isPlainObject(input) ? input : {}).catch(() => ({ answer: "no_answer" }));
    } catch (_) {
      return Promise.resolve({ answer: "no_answer" });
    }
  }

  function stopAll() {
    if (open) open.settle("no_answer", false);
  }

  return { consider, noteOn, stopAll, keptOff: () => keptOff().map((row     ) => row.target) };
}

const REQUEST_CARD_SETUP_TOOL_NAME = "request_card_setup";

const REQUEST_CARD_SETUP_TOOL_DESCRIPTION =
  "Ask the wearer to turn on something a card needs, with one request on their glasses: they tap Allow, Not now or Keep it off. Nothing changes without their tap, and you never press it for them. " +
  "Use it when a \"Not working\" line says the fixer is the wearer and names a switch, instead of telling them where the switch is. " +
  "what: \"mcp\", \"jev\" or \"model\" asks for that switch (MCP in cards, Jev in cards, Models in cards); \"server\" with server asks for one MCP server's Use in cards; " +
  "\"use\" asks again for the open card's own uses that still wait on the wearer (never one they declined or removed). " +
  "In chat setup's Tools for cards, pass during \"setup\" with what \"mcp\" or \"server\", one request for each server the wearer named. " +
  "It cannot add a key, sign in, or change anything on the host computer. " +
  "Returns answer: on (already on), allowed, not_now, kept_off, no_answer, no_glasses, needs_switch, nothing_waiting, no_card, failed or invalid, with next saying what to do.";

const requestCardSetupParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["what", "why"],
  properties: {
    what: { type: "string", enum: ["mcp", "jev", "model", "server", "use"], description: "What to ask for." },
    server: { type: "string", maxLength: 64, description: "With what \"server\": the MCP server's name, as the host lists it." },
    why: { type: "string", maxLength: 140, description: "One line on which card part needs it. Not shown to the wearer." },
    during: { type: "string", enum: ["setup"], description: "Only in chat setup's Tools for cards: the request then says it is asked during setup." },
  },
};

const WHERE = "Tool & service access on the phone's LiveUI page";
const NEXT                         = {
  on: "It is already on, so this was not the cause. Read the card's Not working lines again on your next turn.",
  allowed: "The wearer allowed it and it is on now. Tell them in one sentence, then check the card's Not working lines on your next turn; the card may still need its own Allow.",
  not_now: "The wearer said not now. Do not ask for this again in this chat. Offer a version of the card that does not need it.",
  kept_off: "The wearer chose Keep it off. Never ask for this again, in any chat: only they can turn it on (" + WHERE + "). Offer a version of the card that does not need it.",
  no_answer: "The wearer did not answer, and the request has left their glasses: nothing is waiting there now. (A request waits a minute, and a newer request on the glasses takes its place.) Tell them so, and ask again only when they say they are ready, at most once more in this chat.",
  no_glasses: "The request could not be shown: the glasses app is not connected. Tell the wearer so; a switch they can turn on themselves is in " + WHERE + ".",
  busy: "Another request is on the glasses now. Wait for its answer before you ask again.",
  needs_switch: "MCP in cards is off, so no server can be turned on for cards yet. Ask for that first with what \"mcp\".",
  nothing_waiting: "No request was shown: no use of the open card can be asked for now. When parts is given, it says why for each kind: off or unavailable means a switch, a server or the phone is not ready, so read the card's Not working lines. A use the wearer declined or removed is never asked again by you: only they can undo it (" + WHERE + ").",
  no_card: "No card is open in this chat, so there is no use to ask about. Open the card first.",
  declined: "The wearer said no to a use. A no lasts: never ask again by yourself. Offer a version of the card without it.",
  failed: "The wearer allowed it, but the host did not confirm that it is on. Do not say it is on. Ask them to look at the switch themselves (" + WHERE + ") and turn it on there if it is still off.",
  invalid: "Nothing was asked; fix what error says.",
};
const REQUEST_CARD_SETUP_ANSWERS = Object.freeze(Object.keys(NEXT));

const NOT_SHOWN                         = {
  chat: "No request was shown: this chat's last requests went unanswered. Do not ask again in this chat; tell the wearer where the switch is (" + WHERE + ").",
  window: "No request was shown: the glasses were shown several requests in the last few minutes. Do not ask again for now; tell the wearer where the switch is (" + WHERE + ").",

  record: "No request was shown: the host cannot read its record of what the wearer keeps off, so it shows no requests. The wearer chose nothing here, and this is not yours to repair. Tell them where the switch is (" + WHERE + "), and that the host's owner needs to look at the gateway.",
};

function createRequestCardSetupHandler(deps     ) {
  return async function requestCardSetup(sessionKey        , params     ) {
    const p = isPlainObject(params) ? params : {};
    let verdict      = null;
    try {
      const open = typeof deps.getOpenCard === "function" ? deps.getOpenCard(sessionKey) : null;
      const card = open && open.open !== false && typeof open.key === "string" ? { key: open.key } : null;
      verdict = typeof deps.considerSetup === "function"
        ? await deps.considerSetup({ sessionKey, what: p.what, server: p.server, card, ...(p.during === "setup" ? { during: "setup" } : {}) })
        : { answer: "no_glasses" };
    } catch (_) {
      verdict = null;
    }
    const answer = verdict && typeof verdict.answer === "string" && NEXT[verdict.answer] ? verdict.answer : "no_answer";
    const out      = { answer };
    if (typeof verdict?.server === "string") out.server = verdict.server;
    if (answer === "needs_switch") out.needs = "mcp";
    if (isPlainObject(verdict?.parts)) out.parts = verdict.parts;
    if (answer === "invalid") out.error = String(verdict.error || "invalid").slice(0, 300);
    out.next = answer === "no_answer" && verdict?.asked === false
      ? NOT_SHOWN[verdict.because] || "No request was shown. Tell the wearer where the switch is (" + WHERE + ")."
      : NEXT[answer];
    return out;
  };
}

module.exports = { PROGRAM_CARD_SETUP_REQUESTS_FILENAME, PROGRAM_CARD_SETUP_REQUESTS_SAVED_SHAPE, PROGRAM_CARD_SETUP_LIMITS, PROGRAM_CARD_SETUP_SWITCHES, createProgramCardSetupRequestsStore, cardSetupQuestion, createProgramCardSetupRequests, REQUEST_CARD_SETUP_TOOL_NAME, REQUEST_CARD_SETUP_TOOL_DESCRIPTION, requestCardSetupParametersSchema, REQUEST_CARD_SETUP_ANSWERS, createRequestCardSetupHandler };
