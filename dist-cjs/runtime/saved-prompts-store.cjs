const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");

const STORE_VERSION = 1;
const STORE_FILENAME = "ocuclaw-saved-prompts.json";
const PERSIST_DEBOUNCE_MS = 250;

const SAVED_PROMPTS_CAP = 30;

const SAVED_PROMPT_NAME_MAX = 120;
const SAVED_PROMPT_BODY_MAX = 4000;

const SAVED_PROMPT_TOMBSTONE_LIMIT = 120;

const SAVED_PROMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SAVED_PROMPT_TARGETS = Object.freeze(["current", "new"]);

const SAVED_PROMPT_THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const SAVED_PROMPTS_REJECT_REASONS = Object.freeze([
  "cap_reached",
  "invalid_prompt",
  "not_found",
  "stale_write",
  "unknown_op",
]);

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteInt(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeSavedPromptRouting(value) {
  const source = value && typeof value === "object" ? value : {};
  const target = trimmedString(source.target).toLowerCase();
  const routing = {
    target: SAVED_PROMPT_TARGETS.indexOf(target) === -1 ? "current" : target,
  };
  const agentId = trimmedString(source.agentId);
  if (agentId) routing.agentId = agentId;
  const modelId = trimmedString(source.modelId);
  if (modelId) routing.modelId = modelId;
  const thinking = trimmedString(source.thinking).toLowerCase();
  if (thinking && SAVED_PROMPT_THINKING_LEVELS.indexOf(thinking) !== -1) {
    routing.thinking = thinking;
  }
  return routing;
}

function isValidSavedPromptId(value) {
  return typeof value === "string" && SAVED_PROMPT_ID_RE.test(value);
}

function normalizeSavedPromptRecord(value, nowMs) {
  const source = value && typeof value === "object" ? value : {};
  const id = trimmedString(source.id);
  if (!isValidSavedPromptId(id)) return null;
  const body = typeof source.body === "string" ? source.body : "";
  if (!body.trim()) return null;
  return {
    id,
    name: trimmedString(source.name).slice(0, SAVED_PROMPT_NAME_MAX),
    body: body.slice(0, SAVED_PROMPT_BODY_MAX),
    order: Math.max(0, finiteInt(source.order, 0)),
    routing: normalizeSavedPromptRouting(source.routing),
    updatedAtMs: Math.max(0, finiteInt(source.updatedAtMs, finiteInt(nowMs, 0))),
  };
}

function sortPrompts(prompts) {
  return prompts
    .slice()
    .sort((left, right) =>
      left.order === right.order
        ? left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0
        : left.order - right.order,
    );
}

function renumber(prompts) {
  return sortPrompts(prompts).map((prompt, index) => ({
    ...prompt,
    order: index,
  }));
}

function clonePrompt(prompt) {
  return { ...prompt, routing: { ...prompt.routing } };
}

function normalizeSavedPromptTombstones(value) {
  const source = value && typeof value === "object" ? value : {};
  const entries = [];
  for (const key of Object.keys(source)) {
    const id = trimmedString(key);
    if (!isValidSavedPromptId(id)) continue;
    const deletedAtMs = Math.max(0, finiteInt(source[key], 0));
    if (deletedAtMs <= 0) continue;
    entries.push([id, deletedAtMs]);
  }
  entries.sort((left, right) => right[1] - left[1]);
  const out = {};
  for (const entry of entries.slice(0, SAVED_PROMPT_TOMBSTONE_LIMIT)) {
    out[entry[0]] = entry[1];
  }
  return out;
}

function normalizeSavedPromptsDocument(value, nowMs) {
  const source = value && typeof value === "object" ? value : {};
  const rawPrompts = Array.isArray(source.prompts) ? source.prompts : [];
  const seen = new Set();
  const prompts = [];
  for (const raw of rawPrompts) {
    const record = normalizeSavedPromptRecord(raw, nowMs);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    prompts.push(record);
    if (prompts.length >= SAVED_PROMPTS_CAP) break;
  }
  return {
    hostId: trimmedString(source.hostId),
    orderUpdatedAtMs: Math.max(0, finiteInt(source.orderUpdatedAtMs, 0)),
    deleted: normalizeSavedPromptTombstones(source.deleted),
    prompts: renumber(prompts),
  };
}

function createSavedPromptsStore(opts = {}) {
  const logger = normalizeLogger(opts.logger);
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const newHostId =
    typeof opts.newHostId === "function" ? opts.newHostId : () => randomUUID();
  const statePath =
    typeof opts.statePath === "string" && opts.statePath.trim()
      ? opts.statePath.trim()
      : typeof opts.stateDir === "string" && opts.stateDir.trim()
        ? path.join(opts.stateDir.trim(), STORE_FILENAME)
        : null;

  let pendingWrite = null;
  let pendingWriteTimer = null;
  let writeInFlight = false;
  let inFlightWrite = null;

  async function writeDocumentToDisk(document, reason) {
    const payload =
      JSON.stringify(
        {
          version: STORE_VERSION,
          updatedAtMs: now(),
          hostId: document.hostId,
          orderUpdatedAtMs: document.orderUpdatedAtMs,
          deleted: document.deleted,
          prompts: document.prompts,
        },
        null,
        2,
      ) + "\n";
    const tmpPath = `${statePath}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
      await fs.promises.writeFile(tmpPath, payload, { mode: 0o600 });
      await fs.promises.rename(tmpPath, statePath);
      try {
        await fs.promises.chmod(statePath, 0o600);
      } catch {

      }
      emitDebug("settings.loadsave", "saved_prompts_persisted", "info", null, () => ({
        reason,
        statePath,
        count: document.prompts.length,
      }));
    } catch (err) {
      logger.error(
        `[ocuclaw] failed to persist saved prompts: ${err && err.message ? err.message : err}`,
      );
      emitDebug("settings.loadsave", "saved_prompts_persist_failed", "warn", null, () => ({
        reason,
        statePath,
        message: err && err.message ? err.message : String(err),
      }));
    }
  }

  function flushPendingWrite() {
    if (writeInFlight || !pendingWrite) return;
    const queued = pendingWrite;
    pendingWrite = null;
    writeInFlight = true;
    inFlightWrite = writeDocumentToDisk(queued.document, queued.reason).finally(() => {
      writeInFlight = false;
      inFlightWrite = null;
      if (pendingWrite) flushPendingWrite();
    });
  }

  async function flush() {
    if (pendingWriteTimer) {
      clearTimeout(pendingWriteTimer);
      pendingWriteTimer = null;
    }
    flushPendingWrite();
    while (inFlightWrite) {
      await inFlightWrite;
      flushPendingWrite();
    }
  }

  function persist(document, reason) {
    if (!statePath) {
      emitDebug("settings.loadsave", "saved_prompts_persist_skipped", "debug", null, () => ({
        reason,
        count: document.prompts.length,
      }));
      return;
    }
    pendingWrite = { document, reason };
    if (pendingWriteTimer) clearTimeout(pendingWriteTimer);
    pendingWriteTimer = setTimeout(() => {
      pendingWriteTimer = null;
      flushPendingWrite();
    }, PERSIST_DEBOUNCE_MS);
  }

  function preserveUnusableFile(suffix) {
    if (!statePath) return;
    try {
      fs.renameSync(statePath, `${statePath}.${suffix}-${Date.now()}`);
    } catch {

    }
  }

  function loadInitialDocument() {
    const seeded = { hostId: newHostId(), orderUpdatedAtMs: 0, deleted: {}, prompts: [] };
    if (!statePath || !fs.existsSync(statePath)) {
      persist(seeded, "seed_defaults");
      return seeded;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));

      if (!parsed || parsed.version !== STORE_VERSION) {
        logger.warn(
          `[ocuclaw] saved prompts file is version ${parsed && parsed.version}, expected ${STORE_VERSION}; starting empty`,
        );
        emitDebug("settings.loadsave", "saved_prompts_version_mismatch", "warn", null, () => ({
          statePath,
          found: parsed && parsed.version,
          expected: STORE_VERSION,
        }));
        preserveUnusableFile("v" + (parsed && parsed.version));
        persist(seeded, "rewrite_after_version_mismatch");
        return seeded;
      }
      const loaded = normalizeSavedPromptsDocument(parsed, now());
      if (!loaded.hostId) {
        loaded.hostId = newHostId();
        persist(loaded, "mint_host_id");
      }
      emitDebug("settings.loadsave", "saved_prompts_loaded", "info", null, () => ({
        statePath,
        count: loaded.prompts.length,
      }));
      return loaded;
    } catch (err) {
      logger.warn(
        `[ocuclaw] failed to load saved prompts, starting empty: ${err && err.message ? err.message : err}`,
      );
      emitDebug("settings.loadsave", "saved_prompts_load_failed", "warn", null, () => ({
        statePath,
        message: err && err.message ? err.message : String(err),
      }));
      preserveUnusableFile("corrupt");
      persist(seeded, "rewrite_after_load_failure");
      return seeded;
    }
  }

  let document = loadInitialDocument();

  function snapshot() {
    return {
      hostId: document.hostId,
      cap: SAVED_PROMPTS_CAP,
      count: document.prompts.length,

      orderUpdatedAtMs: document.orderUpdatedAtMs,
      prompts: document.prompts.map(clonePrompt),
    };
  }

  function accepted() {
    return { status: "accepted", ...snapshot() };
  }

  function rejected(reason) {
    return { status: "rejected", reason, ...snapshot() };
  }

  function commit(prompts, orderUpdatedAtMs, reason, deleted) {
    document = {
      hostId: document.hostId,
      orderUpdatedAtMs,
      deleted: normalizeSavedPromptTombstones(deleted || document.deleted),
      prompts: renumber(prompts),
    };
    persist(document, reason);
    return accepted();
  }

  function upsert(input) {
    const record = normalizeSavedPromptRecord(input, now());
    if (!record) return rejected("invalid_prompt");
    const existing = document.prompts.find((prompt) => prompt.id === record.id);
    if (!existing && document.prompts.length >= SAVED_PROMPTS_CAP) {
      return rejected("cap_reached");
    }

    if (existing && record.updatedAtMs < existing.updatedAtMs) {
      return rejected("stale_write");
    }

    const deletedAtMs = document.deleted[record.id];
    if (!existing && Number.isFinite(deletedAtMs) && record.updatedAtMs < deletedAtMs) {
      return rejected("stale_write");
    }

    const order = existing ? existing.order : document.prompts.length;
    const next = document.prompts.filter((prompt) => prompt.id !== record.id);
    next.push({ ...record, order });

    const deleted = { ...document.deleted };
    delete deleted[record.id];
    return commit(next, document.orderUpdatedAtMs, "upsert", deleted);
  }

  function remove(input) {
    const id = trimmedString(input && input.id);
    const existing = document.prompts.find((prompt) => prompt.id === id);
    if (!existing) return rejected("not_found");
    const updatedAtMs = Math.max(0, finiteInt(input && input.updatedAtMs, now()));
    if (updatedAtMs < existing.updatedAtMs) return rejected("stale_write");
    return commit(
      document.prompts.filter((prompt) => prompt.id !== id),
      document.orderUpdatedAtMs,
      "delete",
      { ...document.deleted, [id]: updatedAtMs },
    );
  }

  function reorder(input) {
    const ids = Array.isArray(input && input.ids) ? input.ids : null;
    if (!ids) return rejected("invalid_prompt");
    const updatedAtMs = Math.max(0, finiteInt(input && input.updatedAtMs, now()));
    if (updatedAtMs < document.orderUpdatedAtMs) return rejected("stale_write");
    const byId = new Map(document.prompts.map((prompt) => [prompt.id, prompt]));
    const ordered = [];
    for (const rawId of ids) {
      const id = trimmedString(rawId);
      const prompt = byId.get(id);
      if (!prompt) continue;
      byId.delete(id);
      ordered.push({ ...prompt, order: ordered.length });
    }

    for (const prompt of sortPrompts(Array.from(byId.values()))) {
      ordered.push({ ...prompt, order: ordered.length });
    }

    return commit(ordered, updatedAtMs, "reorder", document.deleted);
  }

  return {
    flush,

    getStatePath() {
      return statePath;
    },

    getHostId() {
      return document.hostId;
    },

    list() {
      return snapshot();
    },

    write(request) {
      const op = trimmedString(request && request.op).toLowerCase();
      if (op === "upsert") {

        const row = (request && request.prompt) || {};
        const stamp = Number.isFinite(row.updatedAtMs)
          ? row.updatedAtMs
          : request && request.updatedAtMs;
        return upsert({ ...row, updatedAtMs: stamp });
      }
      if (op === "delete") return remove(request);
      if (op === "reorder") return reorder(request);
      return rejected("unknown_op");
    },
  };
}

module.exports = { SAVED_PROMPTS_CAP, SAVED_PROMPT_NAME_MAX, SAVED_PROMPT_BODY_MAX, SAVED_PROMPT_TOMBSTONE_LIMIT, SAVED_PROMPT_TARGETS, SAVED_PROMPT_THINKING_LEVELS, SAVED_PROMPTS_REJECT_REASONS, normalizeSavedPromptRouting, isValidSavedPromptId, normalizeSavedPromptRecord, normalizeSavedPromptTombstones, normalizeSavedPromptsDocument, createSavedPromptsStore };
