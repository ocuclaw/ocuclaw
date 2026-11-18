const { normalizeReplyLanguageTag } = require("../domain/reply-language.cjs");

const PROMPT_TURN_OWNERSHIP_TTL_MS = 60_000;
const MAX_PENDING_PER_SESSION = 8;
const MAX_SESSIONS = 512;

function normalizeSessionKey(value         )         {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = /^agent:[^:]+:(.+)$/.exec(raw);
  return match ? match[1] : raw;
}

function createPromptTurnOwnership() {
  const pendingBySession = new Map                            ();
  let sequence = 0;

  const lastConsumedBySession = new Map                               ();

  function begin(sessionKey         , ownership                 )                          {
    const key = normalizeSessionKey(sessionKey);
    const owner = ownership && ownership.owner;
    const lane = ownership && ownership.lane;
    if (
      !key ||
      (owner !== "ocuclaw" && owner !== "even-ai") ||
      (lane !== "logical-session-frozen" && lane !== "turn-scoped")
    ) return null;
    const replyLanguage = normalizeReplyLanguageTag(ownership.replyLanguage);
    const entry                   = {
      id: ++sequence,
      key,
      owner,
      lane,
      sharesOcuClawSession: ownership.sharesOcuClawSession === true,
      ...(replyLanguage ? { replyLanguage } : {}),
      ...(typeof ownership.cardCheck === "string" && ownership.cardCheck ? { cardCheck: ownership.cardCheck } : {}),
      expiresAtMs: Date.now() + PROMPT_TURN_OWNERSHIP_TTL_MS,
    };
    const pending = pendingBySession.get(key) || [];
    if (pending.length >= MAX_PENDING_PER_SESSION) pending.shift();
    pending.push(entry);
    if (!pendingBySession.has(key) && pendingBySession.size >= MAX_SESSIONS) {
      pendingBySession.delete(pendingBySession.keys().next().value          );
    }
    pendingBySession.set(key, pending);
    return entry;
  }

  function cancel(ticket                                                    )          {
    if (!ticket || !ticket.key) return false;
    const pending = pendingBySession.get(ticket.key          );
    if (!Array.isArray(pending)) return false;
    const index = pending.findIndex((entry) => entry.id === ticket.id);
    if (index < 0) return false;
    pending.splice(index, 1);
    if (pending.length === 0) pendingBySession.delete(ticket.key          );
    return true;
  }

  function consume(sessionKey         , identity          = null)                             {
    const key = normalizeSessionKey(sessionKey);
    const runIdentity =
      typeof identity === "string" && identity.trim() ? identity.trim() : "";
    const nowMs = Date.now();
    const pending = pendingBySession.get(key);
    let entry                          = null;
    if (Array.isArray(pending)) {
      while (pending.length > 0 && pending[0].expiresAtMs <= nowMs) pending.shift();
      entry = pending.shift() || null;
      if (pending.length === 0) pendingBySession.delete(key);
    }
    if (!entry) {

      const last = lastConsumedBySession.get(key);
      if (
        runIdentity &&
        last &&
        last.identity === runIdentity &&
        last.expiresAtMs > nowMs
      ) {

        last.expiresAtMs = nowMs + PROMPT_TURN_OWNERSHIP_TTL_MS;
        return { ...last.ownership };
      }
      if (last && last.expiresAtMs <= nowMs) {
        lastConsumedBySession.delete(key);
      }
      return null;
    }
    const ownership                      = {
      owner: entry.owner,
      lane: entry.lane,
      sharesOcuClawSession: entry.sharesOcuClawSession === true,
      ...(entry.replyLanguage ? { replyLanguage: entry.replyLanguage } : {}),
      ...(entry.cardCheck ? { cardCheck: entry.cardCheck } : {}),
    };
    if (runIdentity) {

      if (
        !lastConsumedBySession.has(key) &&
        lastConsumedBySession.size >= MAX_SESSIONS
      ) {
        lastConsumedBySession.delete(
          lastConsumedBySession.keys().next().value          ,
        );
      }
      lastConsumedBySession.set(key, {
        identity: runIdentity,
        ownership,
        expiresAtMs: nowMs + PROMPT_TURN_OWNERSHIP_TTL_MS,
      });
    } else {

      lastConsumedBySession.delete(key);
    }
    return { ...ownership };
  }

  return { begin, cancel, consume };
}

module.exports = { createPromptTurnOwnership };
