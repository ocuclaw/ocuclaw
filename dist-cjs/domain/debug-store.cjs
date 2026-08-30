const DEFAULT_DEBUG_CATEGORIES = Object.freeze([
  "relay.transport",
  "relay.protocol",
  "relay.health",
  "relay.worker.health",
  "relay.operation",
  "relay.session",
  "openclaw.run",
  "openclaw.seq",
  "openclaw.history",
  "openclaw.message",
  "sdk.frames",
  "sdk.results",
  "sdk.events",
  "sdk.events.menu",
  "sdk.events.summary",
  "sdk.events.raw",
  "app.timeline",
  "app.lifecycle",
  "probe.runtime.main_thread",
  "probe.runtime.memory",
  "probe.runtime.bridge",
  "probe.runtime.bridge_timing",
  "probe.perf.conversation_upgrade",
  "probe.perf.streaming_timing",
  "app.state.diff",
  "render.ownership",
  "render.virtual_pager",
  "render.virtual_pager.summary",
  "render.virtual_pager.diagnostics",
  "render.header_animation",
  "screen.nav",
  "screen.dim",
  "glasses.lifecycle",
  "probe.webview.trace",
  "session.timeline",
  "approvals.timeline",
  "liveui.library.events",
  "approvals.state",
  "voice.timeline",
  "voice.transport",
  "voice.ptt",
  "voice.waveform",
  "evenai",
  "audio.pipeline",
  "settings.loadsave",
  "config.timeline",
  "workflow.profile",
  "workflow.run",
  "hermes.link",

  "activity.status",

  "thinking.stream",
]);

const DEBUG_CATEGORY_ALIASES = Object.freeze({
  "app.timeline": Object.freeze([
    "app.timeline",
    "app.lifecycle",
    "probe.runtime.main_thread",
    "probe.runtime.memory",
    "probe.runtime.bridge",
    "probe.runtime.bridge_timing",
    "probe.perf.conversation_upgrade",
  ]),
  "voice.timeline": Object.freeze([
    "voice.timeline",
    "voice.transport",
    "voice.ptt",
  ]),
  "sdk.events": Object.freeze([
    "sdk.events",
    "sdk.events.menu",
    "sdk.events.summary",
    "sdk.events.raw",
  ]),
  "render.virtual_pager": Object.freeze([
    "render.virtual_pager",
    "render.virtual_pager.summary",
    "render.virtual_pager.diagnostics",
  ]),
});

const DEFAULT_NOISY_CATEGORY_POLICIES = Object.freeze({
  "relay.health": Object.freeze({
    sampleEvery: 1,
    dedupeWindowMs: 250,
    alwaysAllow: Object.freeze([
      "event_loop_lag_spike",
      "gc_pause",
      "ws_send_buffer_high_water",
      "relay_queue_depth",
    ]),
  }),
  "sdk.frames": Object.freeze({

    sampleEvery: 1,
    dedupeWindowMs: 150,
    alwaysAllow: Object.freeze([
      "coalescing_summary",
      "stream_first_visible_latency_v1",
    ]),
  }),
  "audio.pipeline": Object.freeze({
    sampleEvery: 5,
    dedupeWindowMs: 150,
  }),
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizeCategoryList(raw) {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const cat = entry.trim();
    if (!cat) continue;
    dedup.add(cat);
  }
  return Array.from(dedup.values());
}

function expandCategoryAliases(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return [];
  }
  const dedup = new Set();
  for (const category of list) {
    const expanded = DEBUG_CATEGORY_ALIASES[category] || [category];
    for (const entry of expanded) {
      if (typeof entry !== "string" || !entry) continue;
      dedup.add(entry);
    }
  }
  return Array.from(dedup.values());
}

function createDebugStore(opts) {
  const options = opts || {};
  const capacity = clampInt(options.capacity, 1, 100000, 100000);
  const defaultTtlMs = clampInt(options.defaultTtlMs, 1, 600000, 120000);
  const maxTtlMs = clampInt(options.maxTtlMs, 1, 3600000, 600000);
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  const configuredCategories =
    Array.isArray(options.categories) && options.categories.length > 0
      ? normalizeCategoryList(options.categories)
      : DEFAULT_DEBUG_CATEGORIES;
  const categories = new Set(configuredCategories);

  const noisyPolicies = {
    ...DEFAULT_NOISY_CATEGORY_POLICIES,
    ...(options.noisyPolicies || {}),
  };

  const enabledUntil = new Map();

  if (Array.isArray(options.initialEnabled)) {
    const seedNow = nowFn();
    for (const entry of options.initialEnabled) {
      if (!entry || typeof entry.cat !== "string") continue;
      if (!categories.has(entry.cat)) continue;
      const expiresAtMs = Number(entry.expiresAtMs);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= seedNow) continue;
      enabledUntil.set(entry.cat, Math.floor(expiresAtMs));
    }
  }

  const noisyCounters = new Map();

  const noisyLast = new Map();

  const ring = new Array(capacity);
  let ringWrite = 0;
  let ringSize = 0;
  let seq = 0;

  function pruneExpired(nowMs) {
    for (const [cat, expiresAt] of enabledUntil) {
      if (expiresAt <= nowMs) {
        enabledUntil.delete(cat);
      }
    }
  }

  function getEnabledCategories(nowMs) {
    const ts = Number.isFinite(nowMs) ? nowMs : nowFn();
    pruneExpired(ts);
    return Array.from(enabledUntil.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, expiresAtMs]) => ({ cat, expiresAtMs }));
  }

  function isEnabled(category, nowMs) {
    if (typeof category !== "string" || !category) return false;
    const ts = Number.isFinite(nowMs) ? nowMs : nowFn();
    const expiresAt = enabledUntil.get(category);
    if (!expiresAt) return false;
    if (expiresAt <= ts) {
      enabledUntil.delete(category);
      return false;
    }
    return true;
  }

  function unknownCategories(list) {
    const unknown = [];
    for (const cat of list) {
      if (!categories.has(cat)) unknown.push(cat);
    }
    return unknown;
  }

  function setCategories(request) {
    const req = request || {};
    const enable = expandCategoryAliases(normalizeCategoryList(req.enable));
    const disable = expandCategoryAliases(normalizeCategoryList(req.disable));
    const nowMs = nowFn();

    if (enable.length === 0 && disable.length === 0) {
      return {
        ok: false,
        error: "debug-set requires at least one category in enable or disable",
      };
    }

    const overlap = enable.filter((cat) => disable.includes(cat));
    if (overlap.length > 0) {
      return {
        ok: false,
        error: `debug-set category cannot be both enabled and disabled: ${overlap.join(", ")}`,
      };
    }

    const unknown = unknownCategories([...enable, ...disable]);
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Unknown debug categories: ${unknown.join(", ")}`,
      };
    }

    let ttlMs = null;
    let expiresAtMs = null;
    if (enable.length > 0) {
      const rawTtl = req.ttlMs === undefined || req.ttlMs === null ? defaultTtlMs : Number(req.ttlMs);
      if (!Number.isFinite(rawTtl) || rawTtl <= 0) {
        return {
          ok: false,
          error: "debug-set ttlMs must be a positive number",
        };
      }
      ttlMs = Math.min(Math.floor(rawTtl), maxTtlMs);
      expiresAtMs = nowMs + ttlMs;
      for (const cat of enable) {
        enabledUntil.set(cat, expiresAtMs);
      }
    }

    if (disable.length > 0) {
      for (const cat of disable) {
        enabledUntil.delete(cat);
      }
    }

    return {
      ok: true,
      nowMs,
      ttlMs,
      expiresAtMs,
      applied: { enable, disable },
      enabled: getEnabledCategories(nowMs),
    };
  }

  function normalizeData(data) {
    let normalized = data;
    if (normalized === undefined) {
      normalized = {};
    } else if (
      normalized === null ||
      typeof normalized !== "object" ||
      Array.isArray(normalized)
    ) {
      normalized = { value: normalized };
    }

    let serialized;
    try {
      serialized = JSON.stringify(normalized);
    } catch {
      normalized = { _serializationError: true };
      serialized = JSON.stringify(normalized);
    }

    return { data: normalized, serialized };
  }

  function allowByNoisyPolicy(cat, eventName, serializedData, ts) {
    const rawPolicy = noisyPolicies[cat];
    if (!rawPolicy) return true;

    const alwaysAllow = rawPolicy.alwaysAllow;
    if (Array.isArray(alwaysAllow) && alwaysAllow.includes(eventName)) {
      return true;
    }

    const sampleEvery = clampInt(rawPolicy.sampleEvery, 1, 1000, 1);
    const dedupeWindowMs = clampInt(rawPolicy.dedupeWindowMs, 0, 60000, 0);

    const nextCount = (noisyCounters.get(cat) || 0) + 1;
    noisyCounters.set(cat, nextCount);
    if (sampleEvery > 1 && nextCount % sampleEvery !== 1) {
      return false;
    }

    if (dedupeWindowMs > 0) {
      const key = `${eventName}|${serializedData.slice(0, 160)}`;
      const prev = noisyLast.get(cat);
      if (prev && prev.key === key && ts - prev.ts <= dedupeWindowMs) {
        return false;
      }
      noisyLast.set(cat, { key, ts });
    }

    return true;
  }

  function append(event) {
    ring[ringWrite] = event;
    ringWrite = (ringWrite + 1) % capacity;
    if (ringSize < capacity) {
      ringSize += 1;
    }
  }

  function emit(event, options) {
    const raw = event || {};
    const cat = typeof raw.cat === "string" ? raw.cat.trim() : "";
    const force = !!(options && options.force === true);
    if (!cat) return false;
    if (!force && !isEnabled(cat)) return false;

    const ts = Number.isFinite(raw.ts) ? Math.floor(raw.ts) : nowFn();
    const eventName =
      typeof raw.event === "string" && raw.event.trim()
        ? raw.event.trim()
        : "event";
    const severity =
      raw.severity === "info" ||
      raw.severity === "warn" ||
      raw.severity === "error"
        ? raw.severity
        : "debug";

    const normalized = normalizeData(raw.data);
    if (!allowByNoisyPolicy(cat, eventName, normalized.serialized, ts)) {
      return false;
    }

    const out = {
      ts,
      cat,
      event: eventName,
      severity,
      seq: ++seq,
      data: normalized.data,
    };

    if (typeof raw.sessionKey === "string" && raw.sessionKey) {
      out.sessionKey = raw.sessionKey;
    }
    if (typeof raw.runId === "string" && raw.runId) {
      out.runId = raw.runId;
    }
    if (typeof raw.screen === "string" && raw.screen) {
      out.screen = raw.screen;
    }

    append(out);
    return true;
  }

  function getAllEvents() {
    if (ringSize === 0) return [];
    const out = [];
    const oldest = (ringWrite - ringSize + capacity) % capacity;
    for (let i = 0; i < ringSize; i += 1) {
      out.push(ring[(oldest + i) % capacity]);
    }
    return out;
  }

  function formatEventForDump(evt) {
    const out = {
      ts: evt.ts,
      cat: evt.cat,
      event: evt.event,
      severity: evt.severity,
      seq: evt.seq,
      data: evt.data,
    };

    if (typeof evt.sessionKey === "string" && evt.sessionKey) {
      out.sessionKey = evt.sessionKey;
    }
    if (typeof evt.runId === "string" && evt.runId) {
      out.runId = evt.runId;
    }
    if (typeof evt.screen === "string" && evt.screen) {
      out.screen = evt.screen;
    }

    return out;
  }

  function dump(request) {
    const req = request || {};
    const nowMs = nowFn();
    const categoriesFilter = expandCategoryAliases(
      normalizeCategoryList(req.categories),
    );
    const unknown = unknownCategories(categoriesFilter);
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Unknown debug categories: ${unknown.join(", ")}`,
      };
    }

    if (
      req.limit !== undefined &&
      (!Number.isFinite(Number(req.limit)) || Number(req.limit) <= 0)
    ) {
      return {
        ok: false,
        error: "debug-dump limit must be a positive number",
      };
    }

    if (
      req.sinceMs !== undefined &&
      (!Number.isFinite(Number(req.sinceMs)) || Number(req.sinceMs) < 0)
    ) {
      return {
        ok: false,
        error: "debug-dump sinceMs must be a non-negative number",
      };
    }

    if (
      req.sinceAgeMs !== undefined &&
      (!Number.isFinite(Number(req.sinceAgeMs)) || Number(req.sinceAgeMs) < 0)
    ) {
      return {
        ok: false,
        error: "debug-dump sinceAgeMs must be a non-negative number",
      };
    }

    if (
      req.untilMs !== undefined &&
      (!Number.isFinite(Number(req.untilMs)) || Number(req.untilMs) < 0)
    ) {
      return {
        ok: false,
        error: "debug-dump untilMs must be a non-negative number",
      };
    }

    const limit =
      req.limit !== undefined && Number.isFinite(Number(req.limit)) && Number(req.limit) > 0
        ? Math.floor(Number(req.limit))
        : null;
    const sinceMs =
      req.sinceMs !== undefined
        ? Math.floor(Number(req.sinceMs))
        : req.sinceAgeMs !== undefined
          ? nowMs - Math.floor(Number(req.sinceAgeMs))
          : null;
    const untilMs =
      req.untilMs !== undefined ? Math.floor(Number(req.untilMs)) : null;

    if (
      sinceMs !== null &&
      untilMs !== null &&
      Number.isFinite(sinceMs) &&
      Number.isFinite(untilMs) &&
      untilMs < sinceMs
    ) {
      return {
        ok: false,
        error: "debug-dump untilMs must be greater than or equal to sinceMs",
      };
    }

    const categorySet =
      categoriesFilter.length > 0 ? new Set(categoriesFilter) : null;
    const filtered = [];

    let oldestMatchedMs = null;
    const all = getAllEvents();
    for (const evt of all) {
      if (categorySet && !categorySet.has(evt.cat)) continue;
      if (oldestMatchedMs === null || evt.ts < oldestMatchedMs) oldestMatchedMs = evt.ts;
      if (sinceMs !== null && evt.ts < sinceMs) continue;
      if (untilMs !== null && evt.ts > untilMs) continue;
      filtered.push(evt);
    }

    const events =
      limit !== null && filtered.length > limit
        ? filtered.slice(filtered.length - limit)
        : filtered;
    const formattedEvents = events.map((evt) => formatEventForDump(evt));

    return {
      ok: true,
      nowMs,
      sinceMs,
      untilMs,
      categories: categoriesFilter,
      limit: limit === null ? undefined : limit,
      totalMatched: filtered.length,
      returned: formattedEvents.length,
      dropped: Math.max(0, filtered.length - formattedEvents.length),
      enabled: getEnabledCategories(nowMs),
      events: formattedEvents,
      ringEvents: ringSize,
      ringCapacity: capacity,
      oldestMatchedMs,
    };
  }

  function getSnapshot(nowMs) {
    const serverNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : nowFn();
    return {
      serverNowMs,
      enabled: getEnabledCategories(serverNowMs),
    };
  }

  return {
    setCategories,
    dump,
    emit,
    isEnabled,
    getSnapshot,
    getEnabledCategories,
    getKnownCategories() {
      return Array.from(categories.values()).sort();
    },
    getConfig() {
      return {
        capacity,
        defaultTtlMs,
        maxTtlMs,
      };
    },
  };
}

module.exports = { createDebugStore, DEFAULT_DEBUG_CATEGORIES, DEFAULT_NOISY_CATEGORY_POLICIES };
