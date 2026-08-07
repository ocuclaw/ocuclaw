const { validateTemplate } = require("./glasses-ui-template.cjs");
const { createGlassesUiCronEngine } = require("./glasses-ui-cron.cjs");
const { executeHttpRecipe, executeLlmRecipe, executeSystemStatsRecipe, normalizeHttpAllowHosts, isHttpHostAllowed, } = require("./glasses-ui-recipes.cjs");
const { createPendingRenderMap, createSurfaceStore, isTerminalOutcome, normalizeGlassesSessionKey } = require("./glasses-ui-surfaces.cjs");
const { createGlassesWakeController } = require("./glasses-ui-wake.cjs");
const { createGlassesVoicemail } = require("./glasses-ui-voicemail.cjs");
const { createPaintFloorCoalescer, DEFAULT_PAINT_FLOOR_MS } = require("./glasses-ui-paint-floor.cjs");
const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { getKindDescriptor, listKindStrings, buildOneOfBranches, } = require("./glasses-ui-descriptors.cjs");

const GLASSES_UI_REFRESH_LIMITS = {
  intervalMsMin: { http: 1000, "system-stats": 1000, "llm-api": 30_000 },
  intervalMsMax: 3_600_000,
  maxDurationMsMin: 10_000,
  maxDurationMsMax: 7_200_000,
  maxDurationMsDefault: 30 * 60 * 1000,
  maxConsecutiveFailuresMin: 1,
  maxConsecutiveFailuresMax: 100,
  maxConsecutiveFailuresDefault: 5,
  shellHttpTimeoutMsMin: 1000,
  shellHttpTimeoutMsMax: 30_000,
  shellHttpTimeoutMsDefault: 10_000,
  llmTimeoutMsMin: 5000,
  llmTimeoutMsMax: 60_000,
  llmTimeoutMsDefault: 30_000,
  outputCapBytesMin: 1024,
  outputCapBytesMax: 1_048_576,
  outputCapBytesDefault: 65_536,
  maxOutputTokensMin: 16,
  maxOutputTokensMax: 1000,
  maxOutputTokensDefault: 200,

  templateMaxChars: 4096,

  systemStatsWindowMsMin: 50,
  systemStatsWindowMsMax: 1000,
};

const ON_ERROR_VALUES = new Set(["keep_last", "show_error", "stop"]);

function effectiveIntervalFloorMs(tierMinMs) {
  return Math.max(tierMinMs, DEFAULT_PAINT_FLOOR_MS);
}

function validateRefreshSpec(refresh, glassesUiLiveCfg) {
  if (refresh === undefined || refresh === null) return { ok: true, refresh: undefined };
  if (typeof refresh !== "object" || Array.isArray(refresh)) {
    return { ok: false, code: "refresh_invalid_recipe", message: "refresh must be an object" };
  }
  const cfg = glassesUiLiveCfg && typeof glassesUiLiveCfg === "object" ? glassesUiLiveCfg : {};
  if (cfg.enabled === false) {
    return { ok: false, code: "refresh_disabled", message: "glassesUiLive is disabled by operator config" };
  }
  const recipe = refresh.recipe;
  if (!recipe || typeof recipe !== "object") {
    return { ok: false, code: "refresh_invalid_recipe", message: "refresh.recipe is required" };
  }
  const kind = recipe.kind;
  if (kind !== "http" && kind !== "llm" && kind !== "system-stats") {
    return { ok: false, code: "refresh_invalid_recipe", message: `recipe.kind must be http/llm/system-stats, got ${JSON.stringify(kind)}` };
  }

  const sanitizedRecipe = { kind };
  const bounded = (raw, min, max) => {
    if (!Number.isFinite(raw)) return null;
    if (raw < min || raw > max) return undefined;
    return Math.floor(raw);
  };
  if (kind === "http") {
    if (cfg.httpEnabled === false) return { ok: false, code: "refresh_disabled", message: "http recipes disabled" };
    if (typeof recipe.url !== "string" || !recipe.url.trim()) {
      return { ok: false, code: "refresh_invalid_recipe", message: "http recipe requires url (non-empty string)" };
    }

    const allowHosts = normalizeHttpAllowHosts(cfg.httpAllowHosts);
    let recipeHost = "";
    try { recipeHost = new URL(recipe.url).hostname; } catch (_) {}
    if (!isHttpHostAllowed(recipeHost, allowHosts)) {
      return { ok: false, code: "refresh_host_not_allowed", message: `http recipe host not in allowlist: ${recipeHost || recipe.url.trim()}` };
    }
    sanitizedRecipe.url = recipe.url;
    if (recipe.method !== undefined) {
      const method = typeof recipe.method === "string" ? recipe.method.trim().toUpperCase() : "";
      if (method !== "GET" && method !== "POST") {
        return { ok: false, code: "refresh_invalid_recipe", message: `http.method must be GET or POST, got ${JSON.stringify(recipe.method)}` };
      }
      sanitizedRecipe.method = method;
    }
    if (recipe.headers && typeof recipe.headers === "object") sanitizedRecipe.headers = recipe.headers;
    if (typeof recipe.body === "string") sanitizedRecipe.body = recipe.body;
    if (typeof recipe.jsonPath === "string") sanitizedRecipe.jsonPath = recipe.jsonPath;
    if (recipe.timeoutMs !== undefined) {
      const v = bounded(recipe.timeoutMs, GLASSES_UI_REFRESH_LIMITS.shellHttpTimeoutMsMin, GLASSES_UI_REFRESH_LIMITS.shellHttpTimeoutMsMax);
      if (v === undefined) return { ok: false, code: "refresh_invalid_recipe", message: `http.timeoutMs ${recipe.timeoutMs} out of bounds [${GLASSES_UI_REFRESH_LIMITS.shellHttpTimeoutMsMin}..${GLASSES_UI_REFRESH_LIMITS.shellHttpTimeoutMsMax}]` };
      if (v !== null) sanitizedRecipe.timeoutMs = v;
    }
    if (recipe.outputCapBytes !== undefined) {
      const v = bounded(recipe.outputCapBytes, GLASSES_UI_REFRESH_LIMITS.outputCapBytesMin, GLASSES_UI_REFRESH_LIMITS.outputCapBytesMax);
      if (v === undefined) return { ok: false, code: "refresh_invalid_recipe", message: `http.outputCapBytes ${recipe.outputCapBytes} out of bounds` };
      if (v !== null) sanitizedRecipe.outputCapBytes = v;
    }
  } else if (kind === "llm") {
    if (cfg.llmEnabled === false) return { ok: false, code: "refresh_disabled", message: "llm recipes disabled" };
    if (typeof recipe.prompt !== "string" || !recipe.prompt.trim()) {
      return { ok: false, code: "refresh_invalid_recipe", message: "llm recipe requires prompt (non-empty string)" };
    }
    if (typeof recipe.model === "string" && recipe.model.trim() && cfg.allowAgentModelOverride !== true) {
      return { ok: false, code: "refresh_llm_model_override_denied", message: "agent model override denied by operator config" };
    }
    sanitizedRecipe.prompt = recipe.prompt;
    if (typeof recipe.systemPrompt === "string") sanitizedRecipe.systemPrompt = recipe.systemPrompt;
    if (typeof recipe.model === "string") sanitizedRecipe.model = recipe.model;
    if (recipe.maxOutputTokens !== undefined) {
      const v = bounded(recipe.maxOutputTokens, GLASSES_UI_REFRESH_LIMITS.maxOutputTokensMin, GLASSES_UI_REFRESH_LIMITS.maxOutputTokensMax);
      if (v === undefined) return { ok: false, code: "refresh_invalid_recipe", message: `llm.maxOutputTokens ${recipe.maxOutputTokens} out of bounds` };
      if (v !== null) sanitizedRecipe.maxOutputTokens = v;
    }
  } else if (kind === "system-stats") {

    if (recipe.sampleWindowMs !== undefined) {
      const v = bounded(recipe.sampleWindowMs, GLASSES_UI_REFRESH_LIMITS.systemStatsWindowMsMin, GLASSES_UI_REFRESH_LIMITS.systemStatsWindowMsMax);
      if (v === undefined) return { ok: false, code: "refresh_invalid_recipe", message: `system-stats.sampleWindowMs ${recipe.sampleWindowMs} out of bounds [${GLASSES_UI_REFRESH_LIMITS.systemStatsWindowMsMin}..${GLASSES_UI_REFRESH_LIMITS.systemStatsWindowMsMax}]` };
      if (v !== null) sanitizedRecipe.sampleWindowMs = v;
    }
  }

  const intervalMs = refresh.intervalMs;
  if (!Number.isFinite(intervalMs)) {
    return { ok: false, code: "refresh_invalid_recipe", message: "refresh.intervalMs is required" };
  }
  const minForKind =
    kind === "llm"
      ? GLASSES_UI_REFRESH_LIMITS.intervalMsMin["llm-api"]
      : GLASSES_UI_REFRESH_LIMITS.intervalMsMin[kind];
  const minEffective = effectiveIntervalFloorMs(minForKind);
  if (intervalMs < minEffective) {
    return {
      ok: false,
      code: "refresh_interval_too_low",
      message: `intervalMs ${intervalMs} below minimum ${minEffective} for ${kind}${kind === "llm" ? ` (${cfg.tickBackend})` : ""}`,
    };
  }
  if (intervalMs > GLASSES_UI_REFRESH_LIMITS.intervalMsMax) {
    return { ok: false, code: "refresh_interval_too_high", message: `intervalMs ${intervalMs} above max ${GLASSES_UI_REFRESH_LIMITS.intervalMsMax}` };
  }

  const maxDurationMs = Number.isFinite(refresh.maxDurationMs)
    ? refresh.maxDurationMs
    : GLASSES_UI_REFRESH_LIMITS.maxDurationMsDefault;
  if (maxDurationMs < GLASSES_UI_REFRESH_LIMITS.maxDurationMsMin || maxDurationMs > GLASSES_UI_REFRESH_LIMITS.maxDurationMsMax) {
    return { ok: false, code: "refresh_duration_too_high", message: `maxDurationMs ${maxDurationMs} out of bounds` };
  }

  const onError = typeof refresh.onError === "string" ? refresh.onError : "keep_last";
  if (!ON_ERROR_VALUES.has(onError)) {
    return { ok: false, code: "refresh_invalid_recipe", message: `onError must be keep_last/show_error/stop` };
  }

  const targets = refresh.targets && typeof refresh.targets === "object" ? refresh.targets : {};
  if (typeof targets.body === "string") {
    if (targets.body.length > GLASSES_UI_REFRESH_LIMITS.templateMaxChars) {
      return { ok: false, code: "refresh_template_invalid", message: `targets.body template exceeds ${GLASSES_UI_REFRESH_LIMITS.templateMaxChars} chars` };
    }
    const v = validateTemplate(targets.body);
    if (!v.ok) return v;
  }
  if (Array.isArray(targets.items)) {

    if (targets.items.length > GLASSES_UI_LIMITS.maxItems) {
      return {
        ok: false,
        code: "refresh_invalid_recipe",
        message: `targets.items has ${targets.items.length} entries; max is ${GLASSES_UI_LIMITS.maxItems}`,
      };
    }
    for (let i = 0; i < targets.items.length; i += 1) {
      const item = targets.items[i];
      if (typeof item === "string") {
        if (item.length > GLASSES_UI_REFRESH_LIMITS.templateMaxChars) {
          return { ok: false, code: "refresh_template_invalid", message: `targets.items[${i}] template exceeds ${GLASSES_UI_REFRESH_LIMITS.templateMaxChars} chars` };
        }
        const v = validateTemplate(item);
        if (!v.ok) return v;
      } else if (item && typeof item === "object" && !Array.isArray(item)) {

        if (typeof item.label !== "string") {
          return { ok: false, code: "refresh_template_invalid", message: `targets.items[${i}].label must be a string template` };
        }
        for (const field of ["label", "body"]) {
          const tpl = item[field];
          if (tpl === undefined) continue;
          if (typeof tpl !== "string") {
            return { ok: false, code: "refresh_template_invalid", message: `targets.items[${i}].${field} must be a string template` };
          }
          if (tpl.length > GLASSES_UI_REFRESH_LIMITS.templateMaxChars) {
            return { ok: false, code: "refresh_template_invalid", message: `targets.items[${i}].${field} template exceeds ${GLASSES_UI_REFRESH_LIMITS.templateMaxChars} chars` };
          }
          const v = validateTemplate(tpl);
          if (!v.ok) return v;
        }
      } else {
        return { ok: false, code: "refresh_template_invalid", message: `targets.items[${i}] must be a string or {label, body} template` };
      }
    }
  }

  return {
    ok: true,
    refresh: {
      recipe: sanitizedRecipe,
      intervalMs,
      targets,
      onError,
      maxDurationMs,
      maxConsecutiveFailures: Number.isFinite(refresh.maxConsecutiveFailures)
        ? Math.max(1, Math.min(100, Math.floor(refresh.maxConsecutiveFailures)))
        : GLASSES_UI_REFRESH_LIMITS.maxConsecutiveFailuresDefault,
    },
  };
}

const updateSchemaForToolParams = {
  type: "string",
  enum: ["patch", "replace", "push"],
  description:
    "How this render relates to the current surface. " +
    "\"patch\": change some fields of the current screen (cron keeps ticking). " +
    "\"replace\" (default): swap the whole current screen content (no back-target). " +
    "\"push\": stack a new screen; the parent is retained and its cron pauses.",
};

const timeoutMsSchemaForToolParams = {
  type: "integer",
  minimum: 1000,
  maximum: 600_000,
  description:
    "Optional one-shot interaction window for THIS call, in ms (default 90000, " +
    "max 600000). Pass 300000-600000 when expecting the user to read or decide; " +
    "omit for fire-and-forget. Never renewed automatically — re-render to listen again.",
};

const staleAfterMsSchemaForToolParams = {
  type: "integer",
  minimum: 1000,
  maximum: 86_400_000,
  description:
    "Optional per-render staleness window, in ms. A tap parked longer than this " +
    "is still delivered but annotated stale:true — treat a stale actuating tap " +
    "as a re-confirm prompt, never an action. Default absent (no annotation).",
};

const GLASSES_UI_WINDOW_LIMITS = {
  timeoutMsMin: timeoutMsSchemaForToolParams.minimum,
  timeoutMsMax: timeoutMsSchemaForToolParams.maximum,
  staleAfterMsMin: staleAfterMsSchemaForToolParams.minimum,
  staleAfterMsMax: staleAfterMsSchemaForToolParams.maximum,
};

function validateWindowFields(spec) {
  const out = { ok: true, timeoutMs: undefined, staleAfterMs: undefined };
  if (spec && spec.timeoutMs !== undefined) {
    const v = spec.timeoutMs;
    if (
      !Number.isFinite(v) ||
      v < GLASSES_UI_WINDOW_LIMITS.timeoutMsMin ||
      v > GLASSES_UI_WINDOW_LIMITS.timeoutMsMax
    ) {
      return {
        ok: false,
        code: "timeout_ms_out_of_bounds",
        message:
          `timeoutMs ${JSON.stringify(v)} out of bounds ` +
          `[${GLASSES_UI_WINDOW_LIMITS.timeoutMsMin}..${GLASSES_UI_WINDOW_LIMITS.timeoutMsMax}]; ` +
          "pass 300000-600000 when expecting the user to read or decide, omit for fire-and-forget",
      };
    }
    out.timeoutMs = Math.floor(v);
  }
  if (spec && spec.staleAfterMs !== undefined) {
    const v = spec.staleAfterMs;
    if (
      !Number.isFinite(v) ||
      v < GLASSES_UI_WINDOW_LIMITS.staleAfterMsMin ||
      v > GLASSES_UI_WINDOW_LIMITS.staleAfterMsMax
    ) {
      return {
        ok: false,
        code: "stale_after_ms_out_of_bounds",
        message:
          `staleAfterMs ${JSON.stringify(v)} out of bounds ` +
          `[${GLASSES_UI_WINDOW_LIMITS.staleAfterMsMin}..${GLASSES_UI_WINDOW_LIMITS.staleAfterMsMax}]`,
      };
    }
    out.staleAfterMs = Math.floor(v);
  }
  return out;
}

const refreshSchemaForToolParams = {
  type: "object",
  description: "Optional periodic refresh policy; turns this surface into a live-updating one.",
  required: ["recipe", "intervalMs"],
  properties: {
    intervalMs: { type: "integer", minimum: 1000, maximum: 3_600_000 },
    maxDurationMs: { type: "integer", minimum: 10_000, maximum: 7_200_000 },
    maxConsecutiveFailures: { type: "integer", minimum: 1, maximum: 100 },
    onError: { type: "string", enum: ["keep_last", "show_error", "stop"] },
    targets: {
      type: "object",
      properties: {
        body: { type: "string" },
        items: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              { type: "object", required: ["label"], properties: { label: { type: "string" }, body: { type: "string" } } },
            ],
          },
        },
      },
    },
    recipe: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "url"],
          properties: {
            kind: { const: "http" },
            url: { type: "string" },
            method: { type: "string", enum: ["GET", "POST"] },
            headers: { type: "object" },
            body: { type: "string" },
            jsonPath: { type: "string" },
            timeoutMs: { type: "integer" },
            outputCapBytes: { type: "integer" },
          },
        },
        {
          type: "object",
          required: ["kind", "prompt"],
          properties: {
            kind: { const: "llm" },
            prompt: { type: "string" },
            systemPrompt: { type: "string" },
            model: { type: "string" },
            maxOutputTokens: { type: "integer" },
          },
        },
        {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { const: "system-stats" },
            sampleWindowMs: { type: "integer", minimum: 50, maximum: 1000 },
          },
        },
      ],
    },
  },
};

const glassesUiParametersSchema = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: {
      type: "string",

      enum: listKindStrings(),
      description:
        "Surface kind. Each kind expects a different items/body shape — see " +
        "the tool description for examples.",
    },
    title: {
      type: "string",
      maxLength: GLASSES_UI_LIMITS.titleMax,
      description: "Optional ≤64-char title shown at the top of the surface.",
    },
    body: {
      type: "string",
      maxLength: GLASSES_UI_LIMITS.bodyMax,
      description:
        "Required when kind=\"text_surface\". The ≤1000-char block of text to " +
        "display. Ignored for the list kinds.",
    },
    items: {
      type: "array",
      maxItems: GLASSES_UI_LIMITS.maxItems,
      description:
        "Required when kind=\"list_surface\" or kind=\"list_with_details_surface\". " +
        "For list_surface, an array of plain strings (≤64 chars each), e.g. " +
        "[\"Monday\", \"Tuesday\"]. For list_with_details_surface, an array of " +
        "{label, body?} objects (label ≤64 chars, body ≤200 chars), e.g. " +
        "[{\"label\": \"Monday\", \"body\": \"Cloudy 14C, light rain pm\"}, " +
        "{\"label\": \"Tuesday\", \"body\": \"Sunny 19C\"}]. Up to 20 items.",
    },

    refresh: refreshSchemaForToolParams,

    update: updateSchemaForToolParams,

    timeoutMs: timeoutMsSchemaForToolParams,
    staleAfterMs: staleAfterMsSchemaForToolParams,
  },

  oneOf: buildOneOfBranches().map((branch) => ({
    ...branch,
    properties: {
      ...branch.properties,
      refresh: refreshSchemaForToolParams,
      update: updateSchemaForToolParams,
      timeoutMs: timeoutMsSchemaForToolParams,
      staleAfterMs: staleAfterMsSchemaForToolParams,
    },
  })),
};

function validateGlassesUiSpec(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "invalid_kind", message: "spec must be an object" };
  }
  const obj = input;

  const descriptor = getKindDescriptor(obj.kind);
  if (!descriptor) {
    return {
      ok: false,
      code: "invalid_kind",
      message:
        `kind must be "text_surface", "list_surface", or "list_with_details_surface"; ` +
        `got ${JSON.stringify(obj.kind)}`,
    };
  }
  return descriptor.validateSpec(obj);
}

const { randomUUID } = require("node:crypto");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, EVEN_AI_THROWAWAY_SESSION_PREFIX, isHermesEvenAiSessionKey, } = require("../domain/even-ai-session-keys.cjs");

function normalizeEvenAiSessionKey(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function isEvenAiAgentSession(sessionKey, dedicatedSessionKey) {
  const normalized = normalizeEvenAiSessionKey(sessionKey);
  if (!normalized) return false;
  if (
    normalized === DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY ||
    normalized.startsWith(EVEN_AI_THROWAWAY_SESSION_PREFIX) ||
    isHermesEvenAiSessionKey(normalized)
  ) {
    return true;
  }
  const normalizedDedicated = normalizeEvenAiSessionKey(dedicatedSessionKey);
  return !!normalizedDedicated && normalized === normalizedDedicated;
}

const DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS = 30 * 60 * 1000;

const GATEWAY_DYNAMIC_TOOL_DEFAULT_TIMEOUT_MS = 90_000;

const WINDOW_EXPIRED_HINT =
  "The listen window closed; the surface is still live on glass and keeps " +
  "updating. New taps park - re-render this surface (e.g. update:\"patch\") " +
  "to collect them in this run, or end your turn and they ride the next one.";

function createGlassesUiToolHandler(deps) {

  const capturedCronOutcome = new Map();

  const TITLE_BUDGET_PX = 540;

  function clipBreadcrumb(s, reserveText = "") {
    if (typeof s !== "string" || s.length === 0) return s;
    const charBudget = Math.floor((TITLE_BUDGET_PX - reserveText.length * 20) / 20);
    if (charBudget <= 0) return "";
    if (s.length <= charBudget) return s;
    const segments = s.split(" › ");

    while (segments.length > 1 && segments.join(" › ").length > charBudget) {
      segments.shift();
    }
    const joined = segments.join(" › ");
    if (joined.length <= charBudget) return joined;

    return joined.slice(0, charBudget);
  }

  function emitMarker(sessionKey, surfaceId) {
    if (!surfaceId) return;
    if (surfaceStore.topSurfaceId(sessionKey) !== surfaceId) return;
    const marker = surfaceStore.markerFor(surfaceId);
    if (!marker) return;
    paintFloor.enqueue({ surfaceId, sessionKey, patch: { marker } });
  }

  const newSurfaceId =
    deps && typeof deps.newSurfaceId === "function"
      ? deps.newSurfaceId
      : () => `ui-${randomUUID().slice(0, 8)}`;

  const storeId =
    typeof deps.storeId === "string" && deps.storeId
      ? deps.storeId
      : `st-${Math.random().toString(36).slice(2, 8)}`;
  const emitLifecycle = (event, severity, data) => {
    if (typeof deps.emitLifecycle === "function") {
      deps.emitLifecycle(event, severity, { storeId, ...(data || {}) });
    }
  };

  function resolveHandlerTimeoutMs() {
    if (!deps || deps.timeoutMs === undefined) return DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS;
    if (typeof deps.timeoutMs === "function") {
      const v = deps.timeoutMs();
      return Number.isFinite(v) ? v : DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS;
    }
    return Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS;
  }

  const paintFloor = createPaintFloorCoalescer({

    paintFloorMs: Number.isFinite(deps.paintFloorMs) ? deps.paintFloorMs : DEFAULT_PAINT_FLOOR_MS,
    send: ({ surfaceId, sessionKey, patch }) => {
      if (patch && patch.__render) {
        deps.relay.sendGlassesUiRender({ sessionKey, surfaceId, depth: patch.__depth, spec: patch.__spec, marker: patch.__marker });
      } else {
        deps.relay.sendGlassesUiSurfaceUpdate({ sessionKey, surfaceId, patch });
      }
    },
    isUnderBackpressure: typeof deps.isUnderBackpressure === "function" ? deps.isUnderBackpressure : () => false,
  });

  const cronEngine = createGlassesUiCronEngine({
    emitLifecycle,
    monotonicNowMs: () => performance.now(),
    executeRecipe: async (recipe, ctx) => {
      if (recipe.kind === "http") {

        const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
        return executeHttpRecipe(recipe, { allowHosts: normalizeHttpAllowHosts(cfg.httpAllowHosts) });
      }
      if (recipe.kind === "system-stats") return executeSystemStatsRecipe(recipe);
      if (recipe.kind === "llm" && typeof deps.executeLlmRecipe === "function") {
        return deps.executeLlmRecipe(recipe, ctx);
      }
      if (recipe.kind === "llm") return executeLlmRecipe(recipe, ctx);
      return { error: `unknown recipe kind: ${recipe.kind}` };
    },
    glassesUiLimits: GLASSES_UI_LIMITS,
    sendSurfaceUpdate: (params) => paintFloor.enqueue({ surfaceId: params.surfaceId, sessionKey: params.sessionKey, patch: params.patch }),
    resolveLlmCtx: (state) => {
      const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
      const agentModel =
        typeof state.recipe.model === "string" && state.recipe.model.trim() && cfg.allowAgentModelOverride === true
          ? state.recipe.model.trim()
          : null;
      const model = agentModel || cfg.tickModel || "";
      const maxOutputTokens = Number.isFinite(state.recipe.maxOutputTokens)
        ? Math.min(state.recipe.maxOutputTokens, cfg.tickMaxOutputTokens || 200)
        : (cfg.tickMaxOutputTokens || 200);
      return {
        backend: cfg.tickBackend || "anthropic-api",
        model,
        baseUrl: cfg.tickApiBaseUrl || "",
        apiKey: deps.resolveLlmApiKey ? deps.resolveLlmApiKey(model) : "",
        maxOutputTokens,
        previousBody: state.lastBody || "",
      };
    },
  });

  const surfaceStore = createSurfaceStore({
    storeId,
    emitLifecycle,

    now: typeof deps.now === "function" ? deps.now : undefined,
    pauseCron: (id) => cronEngine.pause(id),
    resumeCron: (id) => cronEngine.resume(id),

    stopCron: (id, opts) => {
      cronEngine.stop(id, { result: "preempted" }, opts);
      paintFloor.dispose(id);
    },
    mintSurfaceId: newSurfaceId,
  });

  const wakeController = createGlassesWakeController({
    dispatchWake: typeof deps.dispatchWake === "function" ? deps.dispatchWake : null,
    isAgentTurnBusy: typeof deps.isAgentTurnBusy === "function" ? deps.isAgentTurnBusy : () => false,
    emitLifecycle,
    now: typeof deps.now === "function" ? deps.now : Date.now,
    wakeCooldownMs: deps.wakeCooldownMs,
  });

  const voicemail = createGlassesVoicemail({
    now: typeof deps.now === "function" ? deps.now : Date.now,
    ttlMs: deps.voicemailTtlMs,
    drainWakeOutbox: () => wakeController.drainWakeOutbox(),
    drainDeadLetter: (sessionKey) => surfaceStore.drainDeadLetter(sessionKey),
    emitLifecycle,
  });

  deps.relay.onGlassesUiResult((msg) => {
    if (!msg || typeof msg.surfaceId !== "string" || !msg.outcome) return;

    const outcome = {
      ...msg.outcome,
      origin: typeof msg.outcome.origin === "string" ? msg.outcome.origin : "gesture",
      actor: typeof msg.outcome.actor === "string" ? msg.outcome.actor : "wearer",
    };
    const terminal = isTerminalOutcome(outcome);
    if (terminal && cronEngine.isActive(msg.surfaceId)) {

      let merged = outcome;
      capturedCronOutcome.set(msg.surfaceId, (cronOutcome) => { merged = cronOutcome; });
      cronEngine.stop(msg.surfaceId, outcome);
      capturedCronOutcome.delete(msg.surfaceId);
      if (!surfaceStore.resolve(msg.surfaceId, merged)) {
        surfaceStore.queueEvent(msg.surfaceId, merged);
      }
      return;
    }

    const sessionKey = surfaceStore.sessionForSurface(msg.surfaceId);

    emitLifecycle("outcome_received", "debug", {
      surfaceId: msg.surfaceId,
      result: outcome.result,
      knownSurface: !!sessionKey,
      hasPending: surfaceStore.hasPending ? surfaceStore.hasPending(msg.surfaceId) : null,
    });
    if (surfaceStore.resolve(msg.surfaceId, outcome)) {

      emitMarker(sessionKey, msg.surfaceId);
    } else {
      const receipt = surfaceStore.queueEvent(msg.surfaceId, outcome, {
        origin: outcome.origin,
        actor: outcome.actor,
      });

      if (receipt && !receipt.kind) {
        wakeController.onParkedGesture({
          sessionKey: surfaceStore.sessionForSurface(msg.surfaceId),
          surfaceUuid: receipt.surfaceUuid,
          eventId: receipt.eventId,
          result: outcome.result,
          itemIndex: outcome.selected_index,
          origin: outcome.origin,
        });
      }

      emitMarker(sessionKey, msg.surfaceId);
    }
  });

  async function runDynamicUi(params) {
    const validation = validateGlassesUiSpec(params.spec);
    if (!validation.ok) {
      emitLifecycle("render_rejected", "warn", {
        surfaceId: params && typeof params.surfaceId === "string" ? params.surfaceId : null,
        code: validation.code || "invalid_spec",
        reason: validation.error || validation.message || "spec validation failed",
      });
      const err = new Error(`${validation.code}: ${validation.message}`);
      err.code = validation.code;
      throw err;
    }

    const sessionKey = normalizeGlassesSessionKey(
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : "main",
    );
    if (typeof deps.isSessionConnected === "function" && !deps.isSessionConnected(sessionKey)) {
      const err = new Error(
        "glasses_not_connected: no Even glasses client connected for this session",
      );
      err.code = "glasses_not_connected";
      throw err;
    }

    let refreshValidated;
    if (params.spec && params.spec.refresh !== undefined) {
      const glassesUiLiveCfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : { enabled: true };
      const v = validateRefreshSpec(params.spec.refresh, glassesUiLiveCfg);
      if (!v.ok) {
        const err = new Error(`${v.code}: ${v.message}`);
        err.code = v.code;
        throw err;
      }
      refreshValidated = v.refresh;
    }

    const windowFields = validateWindowFields(params.spec);
    if (!windowFields.ok) {
      emitLifecycle("render_rejected", "warn", {
        surfaceId: null,
        code: windowFields.code,
        reason: windowFields.message,
      });
      const err = new Error(`${windowFields.code}: ${windowFields.message}`);
      err.code = windowFields.code;
      throw err;
    }

    const depth = Number.isFinite(params.depth) ? Math.max(1, Math.floor(params.depth)) : 1;
    const update =
      params.spec && (params.spec.update === "patch" || params.spec.update === "push")
        ? params.spec.update
        : "replace";

    if (depth <= 1 && surfaceStore.stackDepth(sessionKey) > 1) {
      const stackDepthBefore = surfaceStore.stackDepth(sessionKey);
      const reapedPending = reapSession(sessionKey, { result: "preempted" });
      emitLifecycle("stale_stack_reaped", "warn", {
        sessionKey,
        stackDepthBefore,
        reapedPending,
      });
    }

    const stackDepthBeforeAttach = surfaceStore.stackDepth(sessionKey);
    const applied = surfaceStore.applyRender(sessionKey, {
      update,
      kind: validation.spec.kind,
    });
    const surfaceId = applied.surfaceId;

    emitLifecycle("surface_attach", "debug", {
      surfaceId,
      sessionKey,
      mode: applied.mode,
      requestedUpdate: update,
      stackDepthBefore: stackDepthBeforeAttach,
    });
    const promise = surfaceStore.register(sessionKey, surfaceId, {
      kind: validation.spec.kind,
      staleAfterMs: windowFields.staleAfterMs,
      title: typeof validation.spec.title === "string" ? validation.spec.title : undefined,
    });

    if (applied.mode === "patch" || applied.mode === "replace") {
      const reattach = surfaceStore.onReattached(surfaceId);
      if (reattach === "discarded_for_exit") {

        if (cronEngine.isActive(surfaceId)) cronEngine.stop(surfaceId, { result: "dismissed" });
        surfaceStore.exit(sessionKey);
        return promise;
      }
      if (reattach === "reattached_stale_latch_dropped") {

        emitLifecycle("stale_cron_summary_dropped", "debug", { surfaceId, sessionKey });
      }
    }

    const wireDepth = Math.max(1, surfaceStore.stackDepth(sessionKey));

    const breadcrumb = surfaceStore.breadcrumbFor(sessionKey);
    if (breadcrumb) validation.spec.title = clipBreadcrumb(breadcrumb);
    paintFloor.enqueue({
      surfaceId,
      sessionKey,

      patch: { __render: true, __depth: wireDepth, __spec: validation.spec, __marker: surfaceStore.markerFor(surfaceId) },
    });

    if (refreshValidated && !(update === "patch" && cronEngine.isActive(surfaceId))) {

      if (refreshValidated.recipe.kind === "llm" && typeof deps.prewarmLlmApiKey === "function") {
        const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
        const agentModel =
          typeof refreshValidated.recipe.model === "string" &&
          refreshValidated.recipe.model.trim() &&
          cfg.allowAgentModelOverride === true
            ? refreshValidated.recipe.model.trim()
            : null;
        const prewarmModel = agentModel || cfg.tickModel || "";
        if (prewarmModel) {
          try {
            await deps.prewarmLlmApiKey(prewarmModel);
          } catch (_) {

          }
        }
      }
      cronEngine.start({
        surfaceId,
        sessionKey,
        refresh: refreshValidated,
        seedBody: validation.spec.body,
        seedItems: validation.spec.items
          ? validation.spec.items.map((it) =>
              typeof it === "string"
                ? it
                : (it && typeof it.label === "string"
                    ? (typeof it.body === "string" ? { label: it.label, body: it.body } : { label: it.label })
                    : ""),
            )
          : undefined,
        onResolve: (cronOutcome) => {

          const capture = capturedCronOutcome.get(surfaceId);
          if (capture) capture(cronOutcome);
          if (isTerminalOutcome(cronOutcome)) {

            const stamped = {
              ...cronOutcome,
              origin: typeof cronOutcome.origin === "string" ? cronOutcome.origin : "system",
            };

            if (!surfaceStore.resolve(surfaceId, stamped)) {
              surfaceStore.queueEvent(surfaceId, stamped);
            }
          }
        },
      });
    }

    const setTimeoutFn =
      deps && typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
    const clearTimeoutFn =
      deps && typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
    const cleanups = [];

    const effectiveWindowMs =
      windowFields.timeoutMs !== undefined
        ? windowFields.timeoutMs
        : GATEWAY_DYNAMIC_TOOL_DEFAULT_TIMEOUT_MS;

    const wrapUpMarginMs = Math.min(5000, Math.max(2000, Math.floor(effectiveWindowMs * 0.05)));
    const wrapUpDelayMs = Math.max(effectiveWindowMs - wrapUpMarginMs, Math.floor(effectiveWindowMs / 2));
    const windowExpiredOutcome = (extra) =>
      Object.assign(
        {
          result: "window_expired",
          surface_still_live: true,
          window_ms: effectiveWindowMs,
          origin: "system",
          hint: WINDOW_EXPIRED_HINT,
        },
        extra,
      );
    const wrapUpHandle = setTimeoutFn(() => {
      if (surfaceStore.resolve(surfaceId, windowExpiredOutcome())) {
        emitLifecycle("window_expired", "debug", {
          surfaceId,
          sessionKey,
          windowMs: effectiveWindowMs,
          via: "wrap_up_timer",
        });

        emitMarker(sessionKey, surfaceId);
      }
    }, wrapUpDelayMs);
    cleanups.push(() => clearTimeoutFn(wrapUpHandle));

    const signal = params.signal;
    if (signal && typeof signal.addEventListener === "function") {
      const onAbort = () => {
        if (surfaceStore.resolve(surfaceId, windowExpiredOutcome({ aborted: true }))) {
          emitLifecycle("window_expired", "debug", {
            surfaceId,
            sessionKey,
            windowMs: effectiveWindowMs,
            via: "abort_signal",
          });
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => {
          if (typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", onAbort);
          }
        });
      }
    }

    const timeoutMs = Number.isFinite(params.timeoutMs)
      ? params.timeoutMs
      : resolveHandlerTimeoutMs();
    if (!refreshValidated && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const handle = setTimeoutFn(() => {

        surfaceStore.resolve(surfaceId, { result: "timeout", timeout_ms: timeoutMs, origin: "system" });
      }, timeoutMs);
      cleanups.push(() => clearTimeoutFn(handle));
    }

    return promise.then((outcome) => {
      for (const fn of cleanups) {
        try { fn(); } catch (_) {  }
      }
      return outcome;
    });
  }

  const navDepthBySession = new Map();

  function handleNavEvent(rawSessionKey, ev) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const newDepth = Number.isFinite(ev.depth) ? Math.max(1, Math.floor(ev.depth)) : 1;
    const lastDepth = navDepthBySession.get(sessionKey) || surfaceStore.stackDepth(sessionKey) || 1;
    const storeDepthBefore = surfaceStore.stackDepth(sessionKey);
    let popCount = 0;
    let resumedParent = null;
    if (newDepth < lastDepth) {

      let guard = 0;
      while (surfaceStore.stackDepth(sessionKey) > newDepth && guard < 64) {
        resumedParent = surfaceStore.popBack(sessionKey);
        popCount += 1;
        guard += 1;
      }
    }
    if (
      popCount === 0 &&
      storeDepthBefore > 1 &&
      surfaceStore.topSurfaceId(sessionKey) === ev.surfaceId
    ) {

      resumedParent = surfaceStore.popBack(sessionKey);
      popCount += 1;
    }

    if (popCount > 0 && resumedParent) {
      emitMarker(sessionKey, resumedParent);
    }
    emitLifecycle("nav_reconcile", "debug", {
      sessionKey,
      evSurfaceId: ev.surfaceId,
      evDepth: ev.depth,
      newDepth,
      lastDepth,
      storeDepthBefore,
      popCount,
      resumedParent,
    });
    navDepthBySession.set(sessionKey, newDepth);
  }

  function reapSession(rawSessionKey, outcome) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    cronEngine.stopAllForSession(sessionKey, outcome);
    const reaped = surfaceStore.drainSession(sessionKey, outcome);
    surfaceStore.exit(sessionKey);
    navDepthBySession.delete(sessionKey);
    return reaped;
  }

  return {
    storeId,
    runDynamicUi,
    handleNavEvent,
    drainSession(sessionKey, outcome) {
      return reapSession(sessionKey, outcome);
    },

    settleSession(sessionKey, outcome) {
      return surfaceStore.settlePending(sessionKey, outcome);
    },
    drainAll(outcome) {
      cronEngine.stopAll(outcome);
      const reaped = surfaceStore.drainAll(outcome);
      for (const sessionKey of surfaceStore.sessionKeys()) {
        surfaceStore.exit(sessionKey);
      }
      navDepthBySession.clear();
      return reaped;
    },

    peekWakeOutbox() {
      return wakeController.peekWakeOutbox();
    },
    drainWakeOutbox() {
      return wakeController.drainWakeOutbox();
    },

    buildVoicemailInjection(sessionKey) {
      return voicemail.buildInjection(sessionKey);
    },
    previewVoicemailInjection(sessionKey) {
      return voicemail.previewInjection(sessionKey);
    },
    ackVoicemailInjection(sessionKey, ackToken) {
      return voicemail.ackInjection(sessionKey, ackToken);
    },
    isCronActive(surfaceId) {
      return cronEngine.isActive(surfaceId);
    },
    isCronPaused(surfaceId) {
      const st = cronEngine._debugState(surfaceId);
      return !!(st && st.paused);
    },
    surfaceStackDepth(sessionKey) {
      return surfaceStore.stackDepth(sessionKey);
    },

    parkMarkerOnAgentEnd(sessionKey) {
      surfaceStore.clearAwaitingResponse(sessionKey);
      const top = surfaceStore.topSurfaceId(sessionKey);
      if (top) emitMarker(sessionKey, top);
    },
    sessionForSurface(surfaceId) {
      return surfaceStore.sessionForSurface(surfaceId);
    },
  };
}

const GLASSES_UI_TOOL_DESCRIPTION = [
  "Render a dynamic interface on the user's Even G2 glasses HUD instead of",
  "replying with text. Three surface kinds:",
  "  text_surface              — one formatted read-only block (≤1000 chars).",
  "  list_surface              — a short pickable list, label-only (≤20 × 64 chars).",
  "  list_with_details_surface — a pickable list where each item also carries a",
  "                              short detail body (≤200 chars) shown as the user",
  "                              scrolls; use when options need a 1-2 sentence",
  "                              compare-before-choosing detail.",
  "The call carries one one-shot listen window. result is one of: selected,",
  "back, dismissed, window_expired, timeout, recipe_failed, glasses_disconnected.",
  "",
  "Optional params:",
  "  refresh — make the surface self-update on a timer (e.g. live host stats via",
  "            the built-in system-stats tier). The plugin runs a recipe and",
  "            patches the surface in place until the user exits.",
  "  update  — how this render relates to the current surface: \"patch\" (edit",
  "            fields; cron keeps ticking), \"replace\" (default; swap content in",
  "            place, no back-target), \"push\" (stack a child screen; the parent",
  "            is retained and its cron pauses, resuming on back).",
  "  timeoutMs — listen ms (default 90000, max 600000); 300000-600000 when the",
  "            user must read or decide; omit for fire-and-forget.",
  "window_expired is NOT an error: the surface stays live; taps park — re-render",
  "(update:\"patch\") to collect, or end your turn (parked taps wake you).",
  "",
  "Before authoring any refreshing/live surface, per-item detail list, or",
  "multi-screen flow, load the \"glasses-ui\" skill — it is the authoring source",
  "of truth: the capability-tier ladder (system-stats host metrics, http data),",
  "picking the lowest tier, recipe recon, the patch/replace/push moves and",
  "exit-to-chat policy, the {{path|filter}} template + per-item {label,body}",
  "reference, and worked examples (including a live system-stats",
  "list_with_details surface). Keep this description lean; depth lives in the skill.",
  "",
  "After the call resolves, your NEXT output decides the glasses: another",
  "render_glasses_ui replaces the surface (drill-down / next step); a short text",
  "reply hands the screen back to chat (the surface disappears); a silent run-end",
  "leaves the surface up until the user dismisses it. A \"back\" result means the",
  "user wants to revise their previous answer — re-render it or pivot; after a",
  "\"selected\" result, follow up with another render or a brief one-line ack.",
].join("\n");

const DEPTH_MAP_SYMBOL = Symbol.for("ocuclaw.glasses-ui.depthBySession");
function getSharedDepthMap() {
  let m = globalThis[DEPTH_MAP_SYMBOL];
  if (!(m instanceof Map)) {
    m = new Map();
    globalThis[DEPTH_MAP_SYMBOL] = m;
  }
  return m;
}

const HANDLER_SCOPE_SYMBOL = Symbol.for("ocuclaw.glasses-ui.sharedHandler");

function registerGlassesUiTool(api, service, opts = {}) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerGlassesUiTool requires api.registerTool");
  }
  if (!service) {
    throw new Error("registerGlassesUiTool requires the OcuClaw relay service");
  }
  const injectedPaintFloorMs =
    opts && typeof opts === "object" ? Reflect.get(opts, "paintFloorMs") : undefined;
  const scopeHost =
    opts && opts.scopeHost && typeof opts.scopeHost === "object" ? opts.scopeHost : globalThis;

  const depthBySession = getSharedDepthMap();

  function nextDepth(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const prev = depthBySession.get(sessionKey) || 0;
    const next = prev + 1;
    depthBySession.set(sessionKey, next);
    return next;
  }

  function resetDepth(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (sessionKey) {
      depthBySession.delete(sessionKey);
    } else {
      depthBySession.clear();
    }
  }

  async function resolveLlmApiKey(modelRef) {
    if (!modelRef) return "";
    try {
      if (
        api.runtime &&
        api.runtime.modelAuth &&
        typeof api.runtime.modelAuth.getApiKeyForModel === "function"
      ) {
        const cfg = api.config;
        const key = await api.runtime.modelAuth.getApiKeyForModel({ model: modelRef, cfg });
        return typeof key === "string" ? key : "";
      }
    } catch (_) {

    }
    return "";
  }

  let lastModel = null;
  let lastKey = "";
  async function prewarmLlmApiKey(modelRef) {
    if (!modelRef || modelRef === lastModel) return;
    const key = await resolveLlmApiKey(modelRef);
    lastModel = modelRef;
    lastKey = key;
  }
  function resolveLlmApiKeySync(modelRef) {
    if (modelRef === lastModel) return lastKey;

    resolveLlmApiKey(modelRef).then((key) => {
      lastModel = modelRef;
      lastKey = key;
    });
    return "";
  }

  let scopeRecord = scopeHost[HANDLER_SCOPE_SYMBOL];
  const createsHandler = !scopeRecord || !scopeRecord.handler;

  let capturedOnGlassesUiResult = null;
  const handler = createsHandler ? createGlassesUiToolHandler({
    relay: {
      sendGlassesUiRender: (msg) => service.sendGlassesUiRender(msg),
      sendGlassesUiSurfaceUpdate: (msg) => service.sendGlassesUiSurfaceUpdate(msg),
      onGlassesUiResult: (cb) => {
        capturedOnGlassesUiResult = cb;
        return service.onGlassesUiResult(cb);
      },
    },
    emitLifecycle: (event, severity, data) => {
      try {
        if (service && typeof service.emitGlassesUiLifecycle === "function") {
          service.emitGlassesUiLifecycle(event, severity, data);
        }
      } catch (_) {

      }
    },
    getGlassesUiLiveConfig: () => {
      try {
        const cfg = service.getRuntimeConfig && service.getRuntimeConfig();
        return cfg && cfg.glassesUiLive ? cfg.glassesUiLive : { enabled: false };
      } catch (_) {
        return { enabled: false };
      }
    },
    resolveLlmApiKey: resolveLlmApiKeySync,
    prewarmLlmApiKey,

    paintFloorMs: Number.isFinite(injectedPaintFloorMs) ? injectedPaintFloorMs : undefined,
    timeoutMs: () => {

      try {
        const cfg = service.getRuntimeConfig && service.getRuntimeConfig();
        const v = cfg && cfg.renderGlassesUiTimeoutMs;
        return Number.isFinite(v) ? v : DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS;
      } catch (_) {
        return DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS;
      }
    },
    isSessionConnected: () => {

      if (typeof service.hasConnectedAppClient === "function") {
        return service.hasConnectedAppClient();
      }
      return false;
    },
    isUnderBackpressure: () => {

      try {
        return typeof service.isGlassesSendBufferOverHighWater === "function"
          ? service.isGlassesSendBufferOverHighWater()
          : false;
      } catch (_) {
        return false;
      }
    },

    dispatchWake:
      typeof service.dispatchGlassesWake === "function"
        ? (params) => service.dispatchGlassesWake(params)
        : null,
    isAgentTurnBusy: (sessionKey) => {
      try {
        return typeof service.isAgentTurnBusy === "function"
          ? !!service.isAgentTurnBusy(sessionKey)
          : false;
      } catch (_) {
        return false;
      }
    },
  }) : scopeRecord.handler;

  if (createsHandler) {

    const onDisconnect = ({ sessionKey }) => {
      const target = sessionKey || null;
      if (target) {
        handler.drainSession(target, { result: "glasses_disconnected" });
      } else {
        handler.drainAll({ result: "glasses_disconnected" });
      }
    };

    const onNavEvent = (ev) => {
      const sessionKey = handler.sessionForSurface(ev.surfaceId);
      if (!sessionKey) {
        try {
          if (typeof service.emitGlassesUiLifecycle === "function") {
            service.emitGlassesUiLifecycle("nav_event_skipped_foreign_surface", "debug", {
              evSurfaceId: ev.surfaceId,
              evDepth: ev.depth,
            });
          }
        } catch (_) {

        }
        return;
      }
      handler.handleNavEvent(sessionKey, ev);
    };
    scopeRecord = {
      handler,
      refs: 0,
      relayCallbacks: {
        onGlassesUiResult: capturedOnGlassesUiResult,
        onAppClientDisconnect: onDisconnect,
        onGlassesUiNavEvent: onNavEvent,
      },
    };
    scopeHost[HANDLER_SCOPE_SYMBOL] = scopeRecord;
    if (typeof service.onAppClientDisconnect === "function") {
      service.onAppClientDisconnect(onDisconnect);
    }
    if (typeof service.onGlassesUiNavEvent === "function") {
      service.onGlassesUiNavEvent(onNavEvent);
    }
  } else if (scopeRecord && scopeRecord.relayCallbacks) {

    const callbacks = scopeRecord.relayCallbacks;
    if (callbacks.onGlassesUiResult) {
      service.onGlassesUiResult(callbacks.onGlassesUiResult);
    }
    if (callbacks.onAppClientDisconnect && typeof service.onAppClientDisconnect === "function") {
      service.onAppClientDisconnect(callbacks.onAppClientDisconnect);
    }
    if (callbacks.onGlassesUiNavEvent && typeof service.onGlassesUiNavEvent === "function") {
      service.onGlassesUiNavEvent(callbacks.onGlassesUiNavEvent);
    }
  }

  function resolveDedicatedEvenAiSessionKey() {
    try {
      return service?.getRuntimeConfig?.()?.evenAiDedicatedSessionKey || null;
    } catch (_) {
      return null;
    }
  }

  api.registerTool(
    (ctx) => {

      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const factorySessionKey = sessionKey || null;
      return {
        name: "render_glasses_ui",
        description: GLASSES_UI_TOOL_DESCRIPTION,
        parameters: glassesUiParametersSchema,
        async execute(_toolCallId, params, signal) {
          const resolvedSessionKey = normalizeGlassesSessionKey(factorySessionKey || "main");
          const depth = nextDepth(resolvedSessionKey);
          try {

            const outcome = await handler.runDynamicUi({
              sessionKey: resolvedSessionKey,
              depth,
              spec: params,
              signal,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(outcome) }],
            };
          } catch (err) {
            const prev = depthBySession.get(resolvedSessionKey) || 0;
            depthBySession.set(resolvedSessionKey, Math.max(0, prev - 1));
            throw err;
          }
        },
      };
    },
    { name: "render_glasses_ui" },
  );

  if (typeof api.on === "function") {

    api.on("before_prompt_build", (_event, ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
      if (!sessionKey) return undefined;
      try {
        const fragment = handler.buildVoicemailInjection(sessionKey);
        return fragment ? { appendSystemContext: fragment } : undefined;
      } catch (_) {

        return undefined;
      }
    });

    api.on("agent_end", (_event, ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;

      if (sessionKey) {
        const stackDepth = handler.surfaceStackDepth(sessionKey);
        const settledPending = handler.settleSession(sessionKey, { result: "preempted" });

        try {
          if (typeof service.emitGlassesUiLifecycle === "function") {
            service.emitGlassesUiLifecycle("agent_end_settle", "debug", {
              sessionKey: normalizeGlassesSessionKey(sessionKey),
              stackDepth,
              settledPending,
              storeId: handler.storeId,
            });
          }
        } catch (_) {

        }

        handler.parkMarkerOnAgentEnd(sessionKey);
      }
      resetDepth(sessionKey);
    });
  }

  scopeRecord.refs += 1;
  let disposedThisContext = false;
  return function dispose() {
    if (disposedThisContext) return;
    disposedThisContext = true;
    scopeRecord.refs -= 1;
    if (scopeRecord.refs > 0) return;
    handler.drainAll({ result: "preempted" });
    depthBySession.clear();

    if (scopeHost[HANDLER_SCOPE_SYMBOL] === scopeRecord) {
      delete scopeHost[HANDLER_SCOPE_SYMBOL];
    }
  };
}

module.exports = { GLASSES_UI_LIMITS, GLASSES_UI_REFRESH_LIMITS, GLASSES_UI_WINDOW_LIMITS, DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS, glassesUiParametersSchema, GLASSES_UI_TOOL_DESCRIPTION, validateGlassesUiSpec, validateRefreshSpec, createPendingRenderMap, createSurfaceStore, createGlassesUiToolHandler, registerGlassesUiTool, isEvenAiAgentSession };
