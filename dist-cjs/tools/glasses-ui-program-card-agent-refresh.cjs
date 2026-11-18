const nodeFs = require("node:fs");

const path = require("node:path");

const { createHash } = require("node:crypto");

const { atomicWriteLiveuiLibraryRecord, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const PROGRAM_CARD_AGENT_REFRESH_FILENAME = "program-card-agent-refresh-v1.json";

const PROGRAM_CARD_AGENT_REFRESH_NOT_ALLOWED =
  "agent_refresh_not_allowed: the wearer has not let you refresh this card. Ask them to tap Refresh.";

const PROGRAM_CARD_AGENT_REFRESH_NOT_DECLARED =
  "agent_refresh_not_declared: this card's code does not offer you its Refresh. Ask the wearer to tap Refresh, or add agentRefresh: true to the card and the wearer is asked once.";
const PROGRAM_CARD_AGENT_REFRESH_LIMITS = Object.freeze({ maxCards: 256, maxRunKeys: 64, consentMs: 60_000 });
const PROGRAM_CARD_AGENT_REFRESH_VIAS = Object.freeze(["build", "phone"]);

const APP_KEY = /^app:([a-z0-9][a-z0-9._-]{0,63})$/;
const RUN_KEY = /^run:[A-Za-z0-9][A-Za-z0-9._:#-]{0,95}$/;
const L = PROGRAM_CARD_AGENT_REFRESH_LIMITS;

const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const appIdOf = (key     ) => (typeof key === "string" ? APP_KEY.exec(key)?.[1] ?? null : null);
const validKey = (key     ) => typeof key === "string" && (APP_KEY.test(key) || RUN_KEY.test(key));

function validRecord(raw     ) {
  if (!isPlainObject(raw) || !appIdOf(raw.key) || typeof raw.allowed !== "boolean" ||
      !Number.isSafeInteger(raw.atMs) || raw.atMs < 0 || !PROGRAM_CARD_AGENT_REFRESH_VIAS.includes(raw.via)) return null;
  if (Object.keys(raw).some(field => !["key", "allowed", "atMs", "via"].includes(field))) return null;
  return { key: raw.key, allowed: raw.allowed, atMs: raw.atMs, via: raw.via };
}

function createProgramCardAgentRefreshStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, PROGRAM_CARD_AGENT_REFRESH_FILENAME);

  function read()        {
    let doc     ;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      return [];
    }
    if (!isPlainObject(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.cards)) return [];
    if (Object.keys(doc).some(field => field !== "schemaVersion" && field !== "cards")) return [];
    const cards        = [];
    const seen = new Set        ();
    for (const raw of doc.cards) {
      const record = validRecord(raw);
      if (!record || seen.has(record.key)) return [];
      seen.add(record.key);
      cards.push(record);
    }
    return cards.sort((a, b) => b.atMs - a.atMs).slice(0, L.maxCards);
  }

  function write(records       ) {
    const cards = (Array.isArray(records) ? records : []).map(validRecord).filter(Boolean)
      .sort((a     , b     ) => b.atMs - a.atMs).slice(0, L.maxCards);
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: { schemaVersion: 1, cards } }).status === "written";
  }

  return { file, read, write };
}

function createProgramCardAgentRefresh(deps      = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const later = deps.setTimeoutFn || setTimeout;
  const clear = deps.clearTimeoutFn || clearTimeout;
  const store = deps.store || null;
  const consentMs = Number.isFinite(deps.consentMs) ? deps.consentMs : L.consentMs;

  const runAnswers = new Map                                            ();
  const pending = new Map             ();

  const records = () => (store ? store.read() : []);
  const stored = (key        ) => records().find((r     ) => r.key === key) || null;
  const lifecycle = (event        , data     ) => {
    try { deps.emitLifecycle?.(event, "debug", data); } catch (_) {  }
  };
  const changed = () => {
    try { deps.onChange?.(); } catch (_) {  }
  };

  function answerOf(key        )                                            {
    if (appIdOf(key)) {
      const record = stored(key);
      return record ? { allowed: record.allowed, atMs: record.atMs } : null;
    }
    return runAnswers.get(key) ?? null;
  }

  function keep(key        , allowed         , via        ) {
    const atMs = now();
    if (appIdOf(key)) {
      if (!store) return false;
      const rest = records().filter((r     ) => r.key !== key);
      return store.write([{ key, allowed, atMs, via }, ...rest]);
    }
    runAnswers.delete(key);
    runAnswers.set(key, { allowed, atMs });
    while (runAnswers.size > L.maxRunKeys) runAnswers.delete(runAnswers.keys().next().value          );
    return true;
  }

  function allowed(key     ) {
    return validKey(key) && answerOf(key)?.allowed === true;
  }

  function consider(input      = {})                                              {
    const key = input.key;
    if (!validKey(key)) return Promise.resolve({ answer: "invalid", error: "invalid_key" });
    const known = answerOf(key);
    if (known) return Promise.resolve({ answer: known.allowed ? "allowed" : "declined" });
    if (pending.has(key)) return pending.get(key).promise;
    let resolve     ;
    const promise = new Promise                    (r => { resolve = r; });
    const entry      = {
      promise,
      settle(answer        ) {
        if (pending.get(key) !== entry) return;
        if (entry.timer) clear(entry.timer);
        pending.delete(key);
        lifecycle("program_card_agent_refresh_answer", { answer, cause: typeof input.cause === "string" ? input.cause : null });
        resolve({ answer });
      },
    };
    pending.set(key, entry);
    const task = typeof input.task === "string" && input.task.trim() ? input.task.trim().slice(0, 60) : null;
    const surfaceId = `card-refresh:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
    entry.timer = later(() => entry.settle("no_answer"), consentMs);
    entry.timer?.unref?.();
    let accepted      = false;
    try {
      accepted = deps.presentDecision?.({
        surface: {
          surfaceId,
          sessionKey: input.sessionKey || deps.sessionKey?.() || null,
          kind: "permission",
          title: "Let your agent refresh this card?",
          question: task ? `Each refresh runs ${task}.` : "Each refresh runs its Task.",
          options: [{ key: "allow", label: "Allow" }, { key: "deny", label: "No" }],
          deadlineSec: Math.round(consentMs / 1000),
        },
        expiresAtMs: now() + consentMs,
        onDecision: (d     ) => {
          const choice = d?.choice || d?.key || d?.optionKey;
          if (choice !== "allow" && choice !== "deny") { entry.settle("no_answer"); return; }
          if (pending.get(key) !== entry) return;
          const kept = keep(key, choice === "allow", "build");
          if (kept) changed();
          entry.settle(!kept ? "no_answer" : choice === "allow" ? "allowed" : "declined");
        },
      });
    } catch (_) {
      accepted = false;
    }
    if (accepted !== true && accepted?.presented !== true) entry.settle("no_answer");
    return promise;
  }

  function set(appId     , allow     ) {
    const key = `app:${appId}`;
    if (!appIdOf(key) || typeof allow !== "boolean") return { status: "rejected", code: "agent_refresh_invalid" };
    if (!keep(key, allow, "phone")) return { status: "rejected", code: "agent_refresh_save_failed" };
    pending.get(key)?.settle(allow ? "allowed" : "declined");
    changed();
    return { status: "accepted", allowed: allow };
  }

  function carry(from     , to     ) {
    if (typeof from !== "string" || !RUN_KEY.test(from) || !appIdOf(to)) return false;
    const answer = runAnswers.get(from);
    if (!answer || stored(to)) return false;
    if (!keep(to, answer.allowed, "build")) return false;
    runAnswers.delete(from);
    lifecycle("program_card_agent_refresh_carried", { allowed: answer.allowed });
    changed();
    return true;
  }

  function remove(key     ) {
    if (!validKey(key)) return false;
    pending.get(key)?.settle("no_answer");
    if (!appIdOf(key)) return runAnswers.delete(key);
    if (!store) return false;
    const before = records();
    const rest = before.filter((r     ) => r.key !== key);
    if (rest.length === before.length) return false;
    const written = store.write(rest);
    if (written) changed();
    return written;
  }

  function cards(canSee                             = () => true) {
    return records().filter((r     ) => canSee(appIdOf(r.key)          ))
      .map((r     ) => ({ cardId: appIdOf(r.key), agentRefresh: { allowed: r.allowed, atMs: r.atMs } }));
  }

  return {
    allowed, consider, set, carry, remove, cards,
    stopAll() { for (const entry of [...pending.values()]) entry.settle("no_answer"); runAnswers.clear(); },
  };
}

module.exports = { PROGRAM_CARD_AGENT_REFRESH_FILENAME, PROGRAM_CARD_AGENT_REFRESH_NOT_ALLOWED, PROGRAM_CARD_AGENT_REFRESH_NOT_DECLARED, PROGRAM_CARD_AGENT_REFRESH_LIMITS, PROGRAM_CARD_AGENT_REFRESH_VIAS, createProgramCardAgentRefreshStore, createProgramCardAgentRefresh };
