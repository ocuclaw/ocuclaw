const { randomUUID } = require("node:crypto");

const fs = require("node:fs");

const path = require("node:path");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { scopeOpenClawSessionKey } = require("../gateway/gateway-bridge.cjs");

const STORE_VERSION = 1;
const STORE_FILENAME = "even-ai-send-journal.json";
const DEFAULT_MAX_ENTRIES = 20;

const DEFAULT_MAX_RESEND_AGE_MS = 15 * 60 * 1000;

const DEFAULT_RECOVERY_SETTLE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_RECOVERY_POLL_MS = 2000;
const HISTORY_LIMIT = 200;

const TEXT_MATCH_SLACK_MS = 5000;

const DEFAULT_VERIFY_DELAY_MS = 1500;
const MAX_RESEND_ATTEMPTS = 3;
const LIVE_PENDING_STATES = Object.freeze(["queued", "running", "accepted", "staged"]);

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneSendOptions(sendOptions) {
  if (!sendOptions || typeof sendOptions !== "object") return {};
  const out = {};
  const prompt = sendOptions.prompt;
  if (prompt && typeof prompt === "object" && typeof prompt.content === "string") {
    out.prompt = {
      content: prompt.content,
      ...(typeof prompt.owner === "string" ? { owner: prompt.owner } : {}),
      ...(typeof prompt.lane === "string" ? { lane: prompt.lane } : {}),
    };
  }
  if (trimString(sendOptions.thinking)) out.thinking = trimString(sendOptions.thinking);
  if (trimString(sendOptions.agentId)) out.agentId = trimString(sendOptions.agentId);
  return out;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const runId = trimString(raw.runId);
  const sessionKey = trimString(raw.sessionKey);
  const text = typeof raw.text === "string" ? raw.text : "";
  const acceptedAtMs = Number(raw.acceptedAtMs);
  if (!runId || !sessionKey || !trimString(text) || !Number.isFinite(acceptedAtMs)) {
    return null;
  }
  return {
    runId,
    sessionKey,
    text,
    acceptedAtMs,
    sendOptions: cloneSendOptions(raw.sendOptions),
    sharesOcuClawSession: raw.sharesOcuClawSession === true,
    resendOf: trimString(raw.resendOf) || null,
  };
}

function createEvenAiSendJournal(opts = {}) {
  const logger = normalizeLogger(opts.logger);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const maxEntries =
    Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
      ? Math.floor(opts.maxEntries)
      : DEFAULT_MAX_ENTRIES;
  const filePath =
    typeof opts.statePath === "string" && opts.statePath.trim()
      ? opts.statePath.trim()
      : typeof opts.stateDir === "string" && opts.stateDir.trim()
        ? path.join(opts.stateDir.trim(), STORE_FILENAME)
        : null;

  const entries = new Map();
  if (filePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (saved && saved.version === STORE_VERSION && Array.isArray(saved.entries)) {
        for (const raw of saved.entries.slice(-maxEntries)) {
          const entry = normalizeEntry(raw);
          if (entry) entries.set(entry.runId, entry);
        }
      }
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        logger.warn(`[evenai] send journal unreadable, starting empty: ${err && err.message}`);
      }
    }
  }
  const previous = Array.from(entries.values());

  function persist() {
    if (!filePath) return;
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          version: STORE_VERSION,
          updatedAtMs: now(),
          entries: Array.from(entries.values()),
        }),
        { mode: 0o600, flag: "wx" },
      );
      fs.renameSync(temporary, filePath);
    } catch (err) {

      logger.warn(`[evenai] send journal write failed: ${err && err.message}`);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }

  return {
    filePath,

    previousEntries() {
      return previous
        .slice()
        .sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);
    },

    record(raw) {
      const entry = normalizeEntry({ acceptedAtMs: now(), ...raw });
      if (!entry) return false;
      entries.delete(entry.runId);
      entries.set(entry.runId, entry);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      persist();
      return true;
    },

    complete(runId) {
      const key = trimString(runId);
      if (!key || !entries.has(key)) return false;
      entries.delete(key);
      persist();
      return true;
    },

    has(runId) {
      return entries.has(trimString(runId));
    },

    size() {
      return entries.size;
    },
  };
}

function messageText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function messageIdempotencyKey(message) {
  if (!message || typeof message !== "object") return "";
  const meta = message.__openclaw && typeof message.__openclaw === "object" ? message.__openclaw : {};
  return trimString(message.idempotencyKey) || trimString(meta.idempotencyKey);
}

function messageTimestampMs(message) {
  if (!message || typeof message !== "object") return null;
  const value = Number(message.timestamp);
  return Number.isFinite(value) ? value : null;
}

const HOST_RESUME_PROMPT_PREFIX =
  "[System] Your previous turn was interrupted by a gateway restart";

function historyStampsKeys(messages) {
  return messages.some((message) => message && message.role === "user" && messageIdempotencyKey(message));
}

function evenAiHostResumedOldestEntry(oldestEntry, history) {
  const messages = history && Array.isArray(history.messages) ? history.messages : [];
  if (!oldestEntry || historyStampsKeys(messages)) return false;
  return messages.some((message) => {
    if (!message || message.role !== "user") return false;
    if (!messageText(message).trimStart().startsWith(HOST_RESUME_PROMPT_PREFIX)) return false;
    const ts = messageTimestampMs(message);
    return ts === null || ts >= oldestEntry.acceptedAtMs - TEXT_MATCH_SLACK_MS;
  });
}

function classifyEvenAiJournalEntry(entry, history) {
  const messages = history && Array.isArray(history.messages) ? history.messages : [];
  const prefix = `${entry.runId}:`;
  for (const message of messages) {
    if (!message || message.role !== "user") continue;
    const key = messageIdempotencyKey(message);
    if (key && (key === entry.runId || key.startsWith(prefix))) return "reached";
  }
  if (!historyStampsKeys(messages)) {

    const wanted = entry.text.trim();
    for (const message of messages) {
      if (!message || message.role !== "user") continue;
      if (messageText(message).trim() !== wanted) continue;
      const ts = messageTimestampMs(message);
      if (ts === null || ts >= entry.acceptedAtMs - TEXT_MATCH_SLACK_MS) return "reached";
    }
  }
  const pendingItems =
    history && history.pendingInputs && Array.isArray(history.pendingInputs.items)
      ? history.pendingInputs.items
      : [];
  for (const item of pendingItems) {
    if (!item || trimString(item.runId) !== entry.runId) continue;
    const state = trimString(item.state).toLowerCase();
    return LIVE_PENDING_STATES.includes(state) ? "pending" : "lost";
  }
  return "lost";
}

function isEvenAiRecoverySessionBusy(history) {
  const info = history && history.sessionInfo;
  if (!info || typeof info !== "object") return false;
  const status = trimString(info.status).toLowerCase();
  if (info.hasActiveRun === true || status === "running") return true;

  return info.abortedLastRun === true && status !== "failed" && status !== "killed";
}

function findEntryUserRowIndex(entry, messages) {
  const prefix = `${entry.runId}:`;
  const stamped = historyStampsKeys(messages);
  const wanted = entry.text.trim();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    if (stamped) {
      const key = messageIdempotencyKey(message);
      if (key && (key === entry.runId || key.startsWith(prefix))) return index;
      continue;
    }
    if (messageText(message).trim() !== wanted) continue;
    const ts = messageTimestampMs(message);
    if (ts === null || ts >= entry.acceptedAtMs - TEXT_MATCH_SLACK_MS) return index;
  }
  return -1;
}

function isEvenAiEntryStrandedUnanswered(entry, history) {
  if (isEvenAiRecoverySessionBusy(history)) return false;
  const messages = history && Array.isArray(history.messages) ? history.messages : [];
  const index = findEntryUserRowIndex(entry, messages);
  if (index < 0) return false;
  for (const message of messages.slice(index + 1)) {
    if (!message) continue;
    if (message.role === "assistant" && messageText(message).trim()) return false;
    if (
      message.role === "user" &&
      messageText(message).trimStart().startsWith(HOST_RESUME_PROMPT_PREFIX)
    ) {
      return false;
    }
  }
  return true;
}

function sleep(ms, setTimeoutFn) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

function createEvenAiRestartRecovery(opts = {}) {
  const journal = opts.journal;
  const gatewayBridge = opts.gatewayBridge;
  if (!journal || typeof journal.record !== "function") {
    throw new Error("Even AI restart recovery requires a send journal");
  }
  if (!gatewayBridge || typeof gatewayBridge.on !== "function") {
    throw new Error("Even AI restart recovery requires gatewayBridge.on()");
  }
  const logger = normalizeLogger(opts.logger);
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const setTimeoutFn = typeof opts.setTimeout === "function" ? opts.setTimeout : setTimeout;
  const maxResendAgeMs =
    Number.isFinite(opts.maxResendAgeMs) && opts.maxResendAgeMs >= 0
      ? opts.maxResendAgeMs
      : DEFAULT_MAX_RESEND_AGE_MS;
  const settleTimeoutMs =
    Number.isFinite(opts.settleTimeoutMs) && opts.settleTimeoutMs >= 0
      ? opts.settleTimeoutMs
      : DEFAULT_RECOVERY_SETTLE_TIMEOUT_MS;
  const pollMs =
    Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : DEFAULT_RECOVERY_POLL_MS;
  const verifyDelayMs =
    Number.isFinite(opts.verifyDelayMs) && opts.verifyDelayMs >= 0
      ? opts.verifyDelayMs
      : DEFAULT_VERIFY_DELAY_MS;
  const dispatchUserSend =
    typeof opts.dispatchGatewayUserSend === "function"
      ? opts.dispatchGatewayUserSend
      : (_sessionKey, send) => send();
  const beginPromptTurnOwnership =
    typeof opts.beginPromptTurnOwnership === "function" ? opts.beginPromptTurnOwnership : () => null;
  const cancelPromptTurnOwnership =
    typeof opts.cancelPromptTurnOwnership === "function" ? opts.cancelPromptTurnOwnership : () => {};

  let recoveryStarted = false;
  let recoveryPromise = null;
  let closed = false;

  const offMessage = gatewayBridge.on("message", (data) => {
    if (data && typeof data.role === "string" && data.role !== "assistant") return;
    journal.complete(data && data.runId);
  });
  const offActivity = gatewayBridge.on("activity", (data) => {
    const phase = trimString(data && data.phase).toLowerCase();

    if (phase === "error") journal.complete(data && data.runId);
  });
  const offConnected = gatewayBridge.on("connected", () => {
    if (recoveryStarted || closed) return;
    recoveryStarted = true;
    recoveryPromise = recover().catch((err) => {
      logger.warn(`[evenai] restart recovery failed: ${err && err.message ? err.message : String(err)}`);
    });
  });

  async function readHistory(gatewaySessionKey) {
    return gatewayBridge.request("chat.history", {
      sessionKey: gatewaySessionKey,
      limit: HISTORY_LIMIT,
    });
  }

  async function readSettledHistory(gatewaySessionKey) {
    const deadline = now() + settleTimeoutMs;
    let history = await readHistory(gatewaySessionKey);
    while (!closed && isEvenAiRecoverySessionBusy(history) && now() < deadline) {
      await sleep(pollMs, setTimeoutFn);
      history = await readHistory(gatewaySessionKey);
    }
    return history;
  }

  async function resend(entry) {
    const sendOptions = cloneSendOptions(entry.sendOptions);
    let ticket = null;

    const ack = await dispatchUserSend(entry.sessionKey, () => {
      ticket = beginPromptTurnOwnership(entry.sessionKey, {
        owner: "even-ai",
        lane: "turn-scoped",
        sharesOcuClawSession: entry.sharesOcuClawSession,
      });
      return Promise.resolve(
        gatewayBridge.sendMessage(entry.text, entry.sessionKey, null, sendOptions),
      ).catch((err) => {
        cancelPromptTurnOwnership(ticket);
        throw err;
      });
    });
    const runId = trimString(ack && ack.runId);
    const status = trimString(ack && ack.status);
    if (!runId || (status && status !== "accepted" && status !== "started")) {
      cancelPromptTurnOwnership(ticket);
      throw new Error(trimString(ack && ack.error) || `resend returned ${status || "no runId"}`);
    }
    const replacement = {
      runId,
      sessionKey: entry.sessionKey,
      text: entry.text,
      sendOptions,
      sharesOcuClawSession: entry.sharesOcuClawSession,
      resendOf: entry.resendOf || entry.runId,
      acceptedAtMs: now(),
    };
    journal.record(replacement);
    journal.complete(entry.runId);
    return replacement;
  }

  async function resendAndConfirm(gatewaySessionKey, entry) {
    let current = entry;
    for (let attempt = 1; attempt <= MAX_RESEND_ATTEMPTS; attempt += 1) {
      current = await resend(current);
      if (closed) return { entry: current, attempts: attempt };
      await sleep(verifyDelayMs, setTimeoutFn);
      const history = await readSettledHistory(gatewaySessionKey);
      const verdict = classifyEvenAiJournalEntry(current, history);
      if (verdict !== "lost" || isEvenAiRecoverySessionBusy(history)) {
        return { entry: current, attempts: attempt };
      }
      emitDebug("evenai", "restart_recovery_resend_dropped", "warn", { sessionKey: gatewaySessionKey, runId: current.runId }, () => ({
        attempt,
      }));
    }

    journal.complete(current.runId);
    throw new Error(`re-send was dropped ${MAX_RESEND_ATTEMPTS} times`);
  }

  async function recover() {
    const candidates = journal.previousEntries().filter((entry) => journal.has(entry.runId));
    const summary = { candidates: candidates.length, resent: 0, reached: 0, pending: 0, stale: 0, failed: 0 };
    if (candidates.length === 0) return summary;

    const bySession = new Map();
    for (const entry of candidates) {
      if (now() - entry.acceptedAtMs > maxResendAgeMs) {
        summary.stale += 1;
        journal.complete(entry.runId);
        emitDebug("evenai", "restart_recovery_skipped_stale", "warn", { sessionKey: entry.sessionKey, runId: entry.runId }, () => ({
          ageMs: now() - entry.acceptedAtMs,
          maxResendAgeMs,
          textChars: entry.text.length,
        }));
        continue;
      }
      const gatewaySessionKey = scopeOpenClawSessionKey(entry.sessionKey, entry.sendOptions);
      if (!bySession.has(gatewaySessionKey)) bySession.set(gatewaySessionKey, []);
      bySession.get(gatewaySessionKey).push(entry);
    }

    for (const [gatewaySessionKey, sessionEntries] of bySession) {
      if (closed) break;
      let history;
      try {
        history = await readSettledHistory(gatewaySessionKey);
      } catch (err) {

        summary.failed += sessionEntries.length;
        emitDebug("evenai", "restart_recovery_history_failed", "warn", { sessionKey: gatewaySessionKey }, () => ({
          message: err && err.message ? err.message : String(err),
          entries: sessionEntries.length,
        }));
        continue;
      }
      const hostResumedOldest = evenAiHostResumedOldestEntry(sessionEntries[0], history);
      for (const entry of sessionEntries) {
        if (closed) break;
        let verdict =
          hostResumedOldest && entry === sessionEntries[0]
            ? "reached"
            : classifyEvenAiJournalEntry(entry, history);
        if (verdict === "reached" && isEvenAiEntryStrandedUnanswered(entry, history)) {
          verdict = "lost";
        }
        if (verdict !== "lost") {
          summary[verdict] += 1;
          if (verdict === "reached") journal.complete(entry.runId);
          emitDebug("evenai", `restart_recovery_${verdict}`, "info", { sessionKey: gatewaySessionKey, runId: entry.runId }, () => ({
            ageMs: now() - entry.acceptedAtMs,
          }));
          continue;
        }
        try {
          const result = await resendAndConfirm(gatewaySessionKey, entry);
          summary.resent += 1;
          emitDebug("evenai", "restart_recovery_resent", "warn", { sessionKey: gatewaySessionKey, runId: result.entry.runId }, () => ({
            lostRunId: entry.runId,
            attempts: result.attempts,
            ageMs: now() - entry.acceptedAtMs,
            textChars: entry.text.length,
          }));
        } catch (err) {
          summary.failed += 1;
          emitDebug("evenai", "restart_recovery_resend_failed", "warn", { sessionKey: gatewaySessionKey, runId: entry.runId }, () => ({
            message: err && err.message ? err.message : String(err),
          }));
        }
      }
    }
    logger.info(
      `[evenai] restart recovery: resent=${summary.resent} reached=${summary.reached} pending=${summary.pending} stale=${summary.stale} failed=${summary.failed}`,
    );
    return summary;
  }

  return {

    recordAcceptedSend(params = {}) {
      try {
        return journal.record(params);
      } catch (err) {
        logger.warn(`[evenai] send journal record failed: ${err && err.message}`);
        return false;
      }
    },

    whenRecovered() {
      return recoveryPromise || Promise.resolve(null);
    },

    close() {
      closed = true;
      for (const off of [offMessage, offActivity, offConnected]) {
        if (typeof off === "function") off();
      }
    },
  };
}

module.exports = { classifyEvenAiJournalEntry, createEvenAiRestartRecovery, createEvenAiSendJournal, evenAiHostResumedOldestEntry, isEvenAiEntryStrandedUnanswered, isEvenAiRecoverySessionBusy };
