const path = require("node:path");
const { clipBreadcrumb, mintPreloadedChildren } = require("./glasses-ui-children.cjs");
const { createLiveuiTemplateLibrary, createLiveuiGlassesLibraryController, dispatchLiveuiTemplateOperation, runLiveuiTemplateRenderLifecycle, LIVEUI_TEMPLATE_TOOL_DESCRIPTION, LIVEUI_TEMPLATE_LIBRARY_DIRNAME, LIVEUI_TEMPLATE_TOOL_NAME, liveuiTemplateToolParametersSchema } = require("./glasses-ui-template-library.cjs");
const { createLiveuiTaskLibrary, dispatchLiveuiTaskOperation, LIVEUI_TASK_TOOL_DESCRIPTION, LIVEUI_TASK_TOOL_NAME, LIVEUI_TASK_UNKNOWN_APPROVAL_BEHAVIOUR, liveuiTaskToolParametersSchema, projectTaskForApproval } = require("./glasses-ui-task-library.cjs");
const { createLiveuiLibraryOrganization, findLiveuiVisibleNameClash, isLiveuiLibraryItemVisible, rejectLiveuiVisibleNameClash } = require("./glasses-ui-library-organization.cjs");
const { liveuiLibraryItemKey, orderLiveuiLibraryItems } = require("./glasses-ui-library.cjs");
const { createLiveuiTaskDeletionHookRegistry, findLiveuiTasksReferencingTemplate } = require("./glasses-ui-task-deletion-hooks.cjs");
const { createLiveuiTaskRunRecordStore } = require("./glasses-ui-task-run-records.cjs");
const { validateTemplate } = require("./glasses-ui-template.cjs");
const { fillLiveuiTemplate } = require("./glasses-ui-template-slots.cjs");
const { createGlassesUiCronEngine } = require("./glasses-ui-cron.cjs");
const { createLiveuiPrefs, defaultLiveuiPrefsInput, isLiveuiSwitchedOff, liveuiDisabledError, liveuiDisabledResult } = require("./glasses-ui-prefs.cjs");
const { createLiveuiGrantsStore, normalizeGrantHost } = require("./glasses-ui-grants.cjs");
const { executeHttpRecipe, executeLlmRecipe, executeSystemStatsRecipe, normalizeHttpAllowHosts, isHttpHostAllowed } = require("./glasses-ui-recipes.cjs");
const { createPendingRenderMap, createSurfaceStore, isTerminalOutcome, normalizeGlassesSessionKey } = require("./glasses-ui-surfaces.cjs");

const { deliveryLadderState } = require("./glasses-ui-delivery-ladder.cjs");
const { createGlassesWakeController, readAgentRunId } = require("./glasses-ui-wake.cjs");
const { createGlassesVoicemail } = require("./glasses-ui-voicemail.cjs");
const { createGlassesFeedbackLedger } = require("./glasses-ui-feedback-ledger.cjs");
const { createPaintFloorCoalescer, DEFAULT_PAINT_FLOOR_MS } = require("./glasses-ui-paint-floor.cjs");
const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { validateItemsFromPath } = require("./glasses-ui-array-mapping.cjs");
const { refreshSchemaForToolParams } = require("./glasses-ui-refresh-schema.cjs");
const { lintGlassesUiPlan, projectValidateOnlyChannels } = require("./glasses-ui-plan-lint.cjs");

const { buildHostCapabilityManifest, deriveReadingProfile, deriveRenderContext, emptyUiStateFacts, projectDelivery, projectUiStateChannels } = require("./glasses-ui-state-snapshot.cjs");
const { writeCompanionSnapshot } = require("./glasses-ui-companion-snapshot.cjs");
const { getKindDescriptor, listKindStrings, buildOneOfBranches, GLASSES_UI_CHILDREN_SCHEMA } = require("./glasses-ui-descriptors.cjs");
const { DEFAULT_STAGE_GRACE_MS } = require("./glasses-ui-limits.cjs");
const { checkGlassesUiFit } = require("./glasses-ui-fit.cjs");

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

function resolveEffectiveHostCheck(cfgInput, grantsStore) {
  const cfg = cfgInput && typeof cfgInput === "object" ? cfgInput : {};
  const operatorHosts = normalizeHttpAllowHosts(cfg.httpAllowHosts);

  const ownerDelegated = cfg.httpHostPolicy === "owner-grants";
  let grantsInvalid = false;
  if (ownerDelegated && grantsStore && typeof grantsStore.load === "function") {
    try {
      grantsInvalid = !!grantsStore.load().grantsInvalid;
    } catch (_) {
      grantsInvalid = true;
    }
  }
  return (hostname) => {
    if (isHttpHostAllowed(hostname, operatorHosts)) return "listed";
    if (!ownerDelegated || grantsInvalid) return "not_allowed";
    if (grantsStore && typeof grantsStore.isDenied === "function" && grantsStore.isDenied(hostname)) {
      return "denied";
    }
    if (grantsStore && typeof grantsStore.isGranted === "function" && grantsStore.isGranted(hostname)) {
      return "listed";
    }
    return "consent";
  };
}

function validateRefreshSpec(
  refresh,
  glassesUiLiveCfg,
  surfaceKind = undefined,
  options = {},
) {
  if (refresh === undefined || refresh === null) return { ok: true, refresh: undefined };
  if (typeof refresh !== "object" || Array.isArray(refresh)) {
    return { ok: false, code: "refresh_invalid_recipe", message: "refresh must be an object" };
  }
  const cfg = glassesUiLiveCfg && typeof glassesUiLiveCfg === "object" ? glassesUiLiveCfg : {};
  const shapeOnly = options && options.shapeOnly === true;
  if (!shapeOnly && cfg.enabled === false) {
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
  let httpHost = "";
  let httpHostDecision = "listed";
  const bounded = (raw, min, max) => {
    if (!Number.isFinite(raw)) return null;
    if (raw < min || raw > max) return undefined;
    return Math.floor(raw);
  };
  if (kind === "http") {
    if (!shapeOnly && cfg.httpEnabled === false) return { ok: false, code: "refresh_disabled", message: "http recipes disabled" };
    if (typeof recipe.url !== "string" || !recipe.url.trim()) {
      return { ok: false, code: "refresh_invalid_recipe", message: "http recipe requires url (non-empty string)" };
    }
    let parsedUrl = null;
    try { parsedUrl = new URL(recipe.url); } catch (_) {}
    if (
      !parsedUrl ||
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      !parsedUrl.hostname
    ) {
      return {
        ok: false,
        code: "refresh_invalid_recipe",
        message: "http recipe url must be an absolute http(s) URL with a hostname",
      };
    }
    httpHost = parsedUrl.hostname;
    const hostCheck = typeof options.hostCheck === "function"
      ? options.hostCheck
      : resolveEffectiveHostCheck(cfg, options.grantsStore);
    httpHostDecision = shapeOnly ? "listed" : hostCheck(httpHost);
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
    if (!shapeOnly && cfg.llmEnabled === false) return { ok: false, code: "refresh_disabled", message: "llm recipes disabled" };
    if (typeof recipe.prompt !== "string" || !recipe.prompt.trim()) {
      return { ok: false, code: "refresh_invalid_recipe", message: "llm recipe requires prompt (non-empty string)" };
    }
    if (!shapeOnly && typeof recipe.model === "string" && recipe.model.trim() && cfg.allowAgentModelOverride !== true) {
      return { ok: false, code: "refresh_llm_model_override_denied", message: "agent model override denied by operator config" };
    }
    sanitizedRecipe.prompt = recipe.prompt.slice(0, GLASSES_UI_REFRESH_LIMITS.templateMaxChars);
    if (typeof recipe.systemPrompt === "string") {
      sanitizedRecipe.systemPrompt = recipe.systemPrompt.slice(0, GLASSES_UI_REFRESH_LIMITS.templateMaxChars);
    }
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
  const sanitizedTargets = {};
  if (typeof targets.body === "string") {
    if (targets.body.length > GLASSES_UI_REFRESH_LIMITS.templateMaxChars) {
      return { ok: false, code: "refresh_template_invalid", message: `targets.body template exceeds ${GLASSES_UI_REFRESH_LIMITS.templateMaxChars} chars` };
    }
    const v = validateTemplate(targets.body);
    if (!v.ok) return v;
    sanitizedTargets.body = targets.body;
  }
  if (Array.isArray(targets.items)) {

    if (targets.items.length > GLASSES_UI_LIMITS.maxItems) {
      return {
        ok: false,
        code: "refresh_invalid_recipe",
        message: `targets.items has ${targets.items.length} entries; max is ${GLASSES_UI_LIMITS.maxItems}`,
      };
    }
    const sanitizedItems = [];
    for (let i = 0; i < targets.items.length; i += 1) {
      const item = targets.items[i];
      if (typeof item === "string") {
        if (item.length > GLASSES_UI_REFRESH_LIMITS.templateMaxChars) {
          return { ok: false, code: "refresh_template_invalid", message: `targets.items[${i}] template exceeds ${GLASSES_UI_REFRESH_LIMITS.templateMaxChars} chars` };
        }
        const v = validateTemplate(item);
        if (!v.ok) return v;
        sanitizedItems.push(item);
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
        sanitizedItems.push({
          label: item.label,
          ...(typeof item.body === "string" ? { body: item.body } : {}),
        });
      } else {
        return { ok: false, code: "refresh_template_invalid", message: `targets.items[${i}] must be a string or {label, body} template` };
      }
    }
    sanitizedTargets.items = sanitizedItems;
  }
  const hasItemsFromPath = targets.itemsFromPath !== undefined;
  const hasItemTemplate = targets.itemTemplate !== undefined;
  if (hasItemsFromPath || hasItemTemplate) {
    if (surfaceKind !== "list_surface" && surfaceKind !== "list_with_details_surface") {
      return {
        ok: false,
        code: "refresh_items_mapping_invalid",
        message: "itemsFromPath mapping is only valid on list_surface or list_with_details_surface",
      };
    }
    if (Array.isArray(targets.items)) {
      return {
        ok: false,
        code: "refresh_items_mapping_conflict",
        message: "targets.items and targets.itemsFromPath are mutually exclusive",
      };
    }
    if (!hasItemsFromPath || !hasItemTemplate) {
      return {
        ok: false,
        code: "refresh_items_mapping_invalid",
        message: "targets.itemsFromPath and targets.itemTemplate must be supplied together",
      };
    }
    const pathValidation = validateItemsFromPath(targets.itemsFromPath);
    if (!pathValidation.ok) return pathValidation;
    if (!targets.itemTemplate || typeof targets.itemTemplate !== "object" || Array.isArray(targets.itemTemplate)) {
      return {
        ok: false,
        code: "refresh_items_mapping_invalid",
        message: "targets.itemTemplate must be a {label, body?} template",
      };
    }
    if (typeof targets.itemTemplate.label !== "string") {
      return {
        ok: false,
        code: "refresh_items_mapping_invalid",
        message: "targets.itemTemplate.label must be a string template",
      };
    }
    if (surfaceKind === "list_surface" && targets.itemTemplate.body !== undefined) {
      return {
        ok: false,
        code: "refresh_items_mapping_invalid",
        message: "targets.itemTemplate.body is only valid on list_with_details_surface",
      };
    }
    for (const field of ["label", "body"]) {
      const template = targets.itemTemplate[field];
      if (template === undefined) continue;
      if (typeof template !== "string" || template.length > GLASSES_UI_REFRESH_LIMITS.templateMaxChars) {
        return {
          ok: false,
          code: "refresh_template_invalid",
          message: `targets.itemTemplate.${field} must be a string no longer than ${GLASSES_UI_REFRESH_LIMITS.templateMaxChars} chars`,
        };
      }
      const templateValidation = validateTemplate(template);
      if (!templateValidation.ok) return templateValidation;
    }
    sanitizedTargets.itemsFromPath = targets.itemsFromPath;
    sanitizedTargets.itemTemplate = {
      label: targets.itemTemplate.label,
      ...(typeof targets.itemTemplate.body === "string"
        ? { body: targets.itemTemplate.body }
        : {}),
    };
  }
  const hasSlot = targets.slot !== undefined;
  const hasSlotPath = targets.path !== undefined;
  if (hasSlot || hasSlotPath) {
    if (!hasSlot || !hasSlotPath || typeof targets.slot !== "string" ||
        !/^[a-z][a-z0-9_]{0,31}$/.test(targets.slot)) {
      return {
        ok: false,
        code: "refresh_slot_target_invalid",
        message: "targets.slot and targets.path must be supplied together with a valid slot key",
      };
    }
    if (typeof targets.path !== "string" || !targets.path.trim() ||
        targets.path.length > GLASSES_UI_REFRESH_LIMITS.templateMaxChars ||
        targets.path.split(".").some((segment) =>
          ["__proto__", "prototype", "constructor"].includes(segment))) {
      return {
        ok: false,
        code: "refresh_slot_target_invalid",
        message: "targets.path must be a bounded safe template-expression path",
      };
    }
    const pathTemplate = validateTemplate(`{{${targets.path.trim()}}}`);
    if (!pathTemplate.ok) return pathTemplate;
    sanitizedTargets.slot = targets.slot;
    sanitizedTargets.path = targets.path.trim();
  }

  const sanitizedRefresh = {
    ok: true,
    refresh: {
      recipe: sanitizedRecipe,
      intervalMs,
      targets: sanitizedTargets,
      onError,
      maxDurationMs,
      maxConsecutiveFailures: Number.isFinite(refresh.maxConsecutiveFailures)
        ? Math.max(1, Math.min(100, Math.floor(refresh.maxConsecutiveFailures)))
        : GLASSES_UI_REFRESH_LIMITS.maxConsecutiveFailuresDefault,
    },
  };
  if (kind === "http" && !shapeOnly && httpHostDecision !== "listed") {
    if (httpHostDecision === "consent") {
      return {
        ok: false,
        code: "refresh_host_consent_required",
        host: httpHost,
        message: `phone owner approval required for http recipe host: ${httpHost}`,
        refresh: sanitizedRefresh.refresh,
      };
    }
    return {
      ok: false,
      code: "refresh_host_not_allowed",
      message: `http recipe host not allowed: ${httpHost}`,
    };
  }
  return sanitizedRefresh;
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

const GLASSES_UI_QUEUE_MODES = ["latest", "log"];

const queueModeSchemaForToolParams = {
  type: "string",
  enum: GLASSES_UI_QUEUE_MODES,
  description:
    "Optional parked-tap delivery policy for this surface. \"latest\" (default) " +
    "delivers only the NEWEST parked tap when you re-render to collect — right for " +
    "pick-one surfaces, where earlier taps are corrections. \"log\" delivers EVERY " +
    "parked outcome, oldest first, as {mode:\"log\", events:[...]} — checklist_surface " +
    "requires it for its one full-state close; multi-select may use it for multiple outcomes. Declare it once; " +
    "it sticks to the surface across later renders. The log holds the last 32 taps.",
};

function validateQueueMode(spec) {
  if (!spec || spec.queueMode === undefined) return { ok: true, queueMode: undefined };
  if (GLASSES_UI_QUEUE_MODES.includes(spec.queueMode)) {
    return { ok: true, queueMode: spec.queueMode };
  }
  return {
    ok: false,
    code: "queue_mode_invalid",
    message:
      `queueMode ${JSON.stringify(spec.queueMode)} must be one of ` +
      `${GLASSES_UI_QUEUE_MODES.map((m) => JSON.stringify(m)).join(", ")}`,
  };
}

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

const validateOnlySchemaForToolParams = {
  type: "boolean",
  description:
    "Dry run. When true, validate and lint this spec and return the findings " +
    "WITHOUT rendering: no surface is created, the stack is untouched, and " +
    "nothing is sent to the glasses. Returns {result:\"validated\", ok, errors, " +
    "warnings, normalizedSpec, template, layout}. Unsure whether a spec is a " +
    "good idea? Send it once with validateOnly:true, then send it for real.",
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
    template: {
      type: "string",
      enum: ["image_caption"],
      description:
        "Optional text_surface template. image_caption places one centered image above body, " +
        "which remains the single-line caption and the fallback on 2.0.0 clients.",
    },
    imageAsset: {
      type: "string",
      enum: ["hermes_welcome"],
      description: "Built-in image for template=\"image_caption\". Use this or the inline image fields, never both.",
    },
    imageBase64: {
      type: "string",
      maxLength: GLASSES_UI_LIMITS.imagePayloadBase64Max,
      description: "Base64 PNG for an inline image; IHDR dimensions must match imageWidth/imageHeight.",
    },
    imageWidth: {
      type: "integer",
      minimum: GLASSES_UI_LIMITS.imageWidthMin,
      maximum: GLASSES_UI_LIMITS.imageWidthMax,
      description: "Inline image width in pixels (maximum 288).",
    },
    imageHeight: {
      type: "integer",
      minimum: GLASSES_UI_LIMITS.imageHeightMin,
      maximum: GLASSES_UI_LIMITS.imageHeightMax,
      description: "Inline image height in pixels (maximum 144).",
    },
    items: {
      type: "array",
      maxItems: GLASSES_UI_LIMITS.maxItems,
      description:
        "Required for list_surface, list_with_details_surface, and checklist_surface. " +
        "For list_surface, an array of plain strings (≤64 chars each), e.g. " +
        "[\"Monday\", \"Tuesday\"]. For list_with_details_surface, an array of " +
        "{label, body?} objects (label ≤64 chars, body ≤200 chars), e.g. " +
        "[{\"label\": \"Monday\", \"body\": \"Cloudy 14C, light rain pm\"}, " +
        "{\"label\": \"Tuesday\", \"body\": \"Sunny 19C\"}]. For checklist_surface, " +
        "use {label, checked?} objects; checked defaults false. Up to 20 items.",
    },
    pages: {
      type: "array",
      minItems: 1,
      maxItems: GLASSES_UI_LIMITS.maxPages,
      items: { type: "string", maxLength: GLASSES_UI_LIMITS.pageMax },
      description:
        "Required for paged_text_surface. Supply the complete document as 1-10 pages, " +
        "each no longer than 600 characters. Page flips stay local; tap returns the current page.",
    },

    children: GLASSES_UI_CHILDREN_SCHEMA,

    refresh: refreshSchemaForToolParams,

    update: updateSchemaForToolParams,

    timeoutMs: timeoutMsSchemaForToolParams,
    staleAfterMs: staleAfterMsSchemaForToolParams,

    queueMode: queueModeSchemaForToolParams,

    validateOnly: validateOnlySchemaForToolParams,
  },

  oneOf: buildOneOfBranches().map((branch) => ({
    ...branch,
    properties: {
      ...branch.properties,
      refresh: refreshSchemaForToolParams,
      update: updateSchemaForToolParams,
      timeoutMs: timeoutMsSchemaForToolParams,
      staleAfterMs: staleAfterMsSchemaForToolParams,
      queueMode: queueModeSchemaForToolParams,
      validateOnly: validateOnlySchemaForToolParams,
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
        `kind must be one of ${listKindStrings().map((kind) => JSON.stringify(kind)).join(", ")}; ` +
        `got ${JSON.stringify(obj.kind)}`,
    };
  }

  const descriptorAny = descriptor;
  if (obj.children !== undefined && !descriptorAny.supportsChildren) {
    return {
      ok: false,
      code: "children_unsupported",
      message: `children is only supported on list_surface and list_with_details_surface; got ${JSON.stringify(obj.kind)}`,
    };
  }
  if (obj.children !== undefined && obj.refresh !== undefined) {
    return {
      ok: false,
      code: "refresh_children_conflict",
      message: "children and refresh cannot ride one render: a refresh tick rewrites items and would misalign the children array",
    };
  }
  const result = descriptor.validateSpec(obj);
  if (!result || result.ok !== true) return result;

  const fitErr = checkGlassesUiFit(result.spec);
  if (fitErr) return fitErr;
  return result;
}

const GLASSES_UI_TOOL_LAYER_FIELDS = Object.freeze([
  "refresh", "update", "timeoutMs", "staleAfterMs", "queueMode",
]);

function validateRenderControlFields(input) {
  const spec = input && typeof input === "object" ? input : {};
  if (spec.update !== undefined && !["patch", "replace", "push"].includes(spec.update)) {
    return { ok: false, code: "update_invalid", message: "update must be patch, replace, or push" };
  }
  if (spec.validateOnly !== undefined && typeof spec.validateOnly !== "boolean") {
    return { ok: false, code: "validate_only_invalid", message: "validateOnly must be boolean" };
  }
  return { ok: true };
}

function validateGlassesUiInjectSpec(input, glassesUiLiveCfg = undefined, options = {}) {
  const validation = validateGlassesUiSpec(input);
  if (!validation.ok) return validation;

  if (input.refresh !== undefined) {
    const hasRuntimePolicy = glassesUiLiveCfg && typeof glassesUiLiveCfg === "object";
    let refreshValidation;
    if (hasRuntimePolicy) {

      refreshValidation = validateRefreshSpec(input.refresh, glassesUiLiveCfg, input.kind, {
        hostCheck: typeof options.hostCheck === "function" ? options.hostCheck : undefined,
      });
    } else {

      refreshValidation = validateRefreshSpec(input.refresh, {}, input.kind, { shapeOnly: true });
    }
    if (!refreshValidation.ok) return refreshValidation;
  }

  const windowValidation = validateWindowFields(input);
  if (!windowValidation.ok) return windowValidation;
  const queueValidation = validateQueueMode(input);
  if (!queueValidation.ok) return queueValidation;
  const controlValidation = validateRenderControlFields(input);
  if (!controlValidation.ok) return controlValidation;

  const spec = { ...validation.spec };
  for (const key of GLASSES_UI_TOOL_LAYER_FIELDS) {
    if (Object.hasOwn(input, key)) spec[key] = input[key];
  }
  return { ok: true, spec };
}

const { randomUUID } = require("node:crypto");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, EVEN_AI_THROWAWAY_SESSION_PREFIX, isHermesEvenAiSessionKey } = require("../domain/even-ai-session-keys.cjs");

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

const LIVEUI_TEMPLATE_SUMMARY_FIELDS = Object.freeze([
  "title",
  "body",
  "items",
  "pages",
  "template",
  "imageAsset",
  "imageUrl",
]);

function summarizeLiveuiTemplateSpec(spec, slots = undefined) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "";
  const surfaceKind = typeof spec.kind === "string" && spec.kind
    ? spec.kind
    : typeof spec.template === "string" && spec.template
      ? spec.template
      : "LiveUI surface";
  const fields = LIVEUI_TEMPLATE_SUMMARY_FIELDS.filter(
    (key) => Object.prototype.hasOwnProperty.call(spec, key),
  );
  const slotKeys = Array.isArray(slots)
    ? slots.map((slot) => slot && slot.key).filter((key) => typeof key === "string")
    : [];
  const suffix = slotKeys.length > 0 ? ` · Slots: ${slotKeys.join(", ")}` : "";
  return `${surfaceKind} · Fields: ${fields.length > 0 ? fields.join(", ") : "none"}${suffix}`.slice(0, 200);
}

const WINDOW_EXPIRED_HINT =
  "The listen window closed; the surface is still live on glass and keeps " +
  "updating. New taps park - re-render this surface (e.g. update:\"patch\") " +
  "to collect them in this run, or end your turn and they ride the next one.";

function createGlassesUiToolHandler(deps) {
  let publicApi = null;
  let templateLibrary = null;
  let taskLibrary = null;
  let taskRunRecordStore = null;
  let libraryOrganization = null;
  const injectedLibraryRoot = () =>
    typeof deps.libraryDir === "string" && deps.libraryDir.trim()
      ? deps.libraryDir
      : typeof deps.templateLibraryDir === "string" && deps.templateLibraryDir.trim()
        ? path.dirname(deps.templateLibraryDir)
        : undefined;

  let liveuiPrefsStore = null;
  let liveuiGrantsStore = null;
  let cachedLiveuiPrefs = null;
  let cachedLiveuiPrefsAtMs = 0;
  function getLiveuiPrefsStore() {
    if (!liveuiPrefsStore) {
      liveuiPrefsStore = createLiveuiPrefs({ libraryDir: injectedLibraryRoot() });
    }
    return liveuiPrefsStore;
  }
  function getLiveuiGrantsStore() {
    if (!liveuiGrantsStore) {
      const injected = Reflect.get(deps, "grantsStore");
      liveuiGrantsStore = injected || createLiveuiGrantsStore({
        dir: injectedLibraryRoot(),
        now: typeof deps.now === "function" ? deps.now : undefined,
      });
    }
    return liveuiGrantsStore;
  }
  function currentHostCheck(cfg) {
    return resolveEffectiveHostCheck(
      cfg,
      cfg && cfg.httpHostPolicy === "owner-grants" ? getLiveuiGrantsStore() : null,
    );
  }
  function currentLiveuiPrefs() {
    const nowMs = Date.now();
    if (cachedLiveuiPrefs && nowMs - cachedLiveuiPrefsAtMs < 1_000) return cachedLiveuiPrefs;
    let loaded;
    try {
      loaded = getLiveuiPrefsStore().load();
    } catch (_) {
      const digestInput = defaultLiveuiPrefsInput();
      loaded = { status: "accepted", prefs: { ...digestInput, digest: "" } };
    }
    cachedLiveuiPrefs = loaded;
    cachedLiveuiPrefsAtMs = nowMs;
    return loaded;
  }
  function liveuiRefreshPaused() {
    const prefs = currentLiveuiPrefs().prefs;
    return prefs.enabled === false || prefs.pauseApps === true;
  }
  function getLibraryOrganization() {
    if (!libraryOrganization) {
      libraryOrganization = createLiveuiLibraryOrganization({
        libraryDir: injectedLibraryRoot(),
      });
    }
    return libraryOrganization;
  }
  function currentOrganization() {
    return getLibraryOrganization().load();
  }
  function currentLibraryItems() {
    return getTemplateLibrary().listItems();
  }
  function visibleNameClash(itemType, itemId, name, options = {}) {
    const organization = currentOrganization().organization;
    if (
      options.forceVisible !== true &&
      !isLiveuiLibraryItemVisible(organization, itemType, itemId)
    ) return null;
    return findLiveuiVisibleNameClash(
      currentLibraryItems().items,
      organization,
      { itemType, itemId, name },
    );
  }
  function getTemplateLibrary() {
    if (!templateLibrary) {
      templateLibrary = createLiveuiTemplateLibrary({
        libraryDir:
          typeof deps.templateLibraryDir === "string" && deps.templateLibraryDir.trim()
            ? deps.templateLibraryDir
            : typeof deps.libraryDir === "string" && deps.libraryDir.trim()
              ? path.join(deps.libraryDir, LIVEUI_TEMPLATE_LIBRARY_DIRNAME)
              : undefined,
        validateSpec(spec) {
          const result = validateStaticPlan(spec, {
            includeConnectivity: false,
            stackDepth: 0,
          });
          return {
            ...result.merged,
            normalizedSpec: result.merged.ok ? result.normalizedSpec : null,
          };
        },
      });
    }
    return templateLibrary;
  }
  function getTaskLibrary() {
    if (!taskLibrary) {
      taskLibrary = createLiveuiTaskLibrary({
        libraryDir: injectedLibraryRoot(),
        host: deps.host === "hermes" ? "hermes" : "openclaw",
        now: deps.now,
        taskDefaults() {
          const prefs = currentLiveuiPrefs().prefs;
          return {
            defaultContext: prefs.defaultContext,
            defaultExecutor: prefs.defaultExecutor,
          };
        },
        findVisibleNameClash(taskId, name) {
          return visibleNameClash("task", taskId, name);
        },
        rejectNameClash: rejectLiveuiVisibleNameClash,
        removeOrganizationEntry(itemType, itemId) {
          return getLibraryOrganization().removeLibraryItem(itemType, itemId);
        },
        resolveTemplateHint(templateId) {
          return resolvePreferredTemplateHint(templateId);
        },
        currentSurfaceSpecForSession(sessionKey) {
          return surfaceStore.currentSurfaceSpecForSession(sessionKey);
        },
        saveHelperTemplate(template, helperOf) {
          return getTemplateLibrary().save(template, {
            ifAbsent: true,
            helperOf,
          });
        },
        hideHelperTemplate(templateId) {
          return getLibraryOrganization().hideLibraryItemForHelper(
            liveuiLibraryItemKey("template", templateId),
          );
        },
        rollbackHelperTemplate(templateId, digest) {
          getLibraryOrganization().removeLibraryItem("template", templateId);
          return getTemplateLibrary().delete(templateId, { expectedDigest: digest });
        },
        deletionHooks: createLiveuiTaskDeletionHookRegistry({
          runRecordsOnTaskDeleted(taskId) {
            return getTaskRunRecordStore().deleteForTask(taskId);
          },
          readTemplate(templateId) {
            return getTemplateLibrary().read(templateId);
          },
          loadOrganization() {
            return currentOrganization();
          },
          taskLibrary() {
            return getTaskLibrary();
          },
          deleteHelperTemplate(templateId, digest) {
            getLibraryOrganization().removeLibraryItem("template", templateId);
            return getTemplateLibrary().delete(templateId, { expectedDigest: digest });
          },
        }),
      });
    }
    return taskLibrary;
  }
  function getTaskRunRecordStore() {
    if (!taskRunRecordStore) {
      taskRunRecordStore = createLiveuiTaskRunRecordStore({
        rootDir: injectedLibraryRoot(),
        now: deps.now,
      });
    }
    return taskRunRecordStore;
  }
  function describeTaskApprovalBehaviour(task) {
    const version = task && task.versions && (task.versions.pending || task.versions.approved);
    const executor = version && version.executor;
    if (executor && typeof deps.describeToolApprovalBehaviour === "function") {
      try {
        const description = deps.describeToolApprovalBehaviour(executor);
        if (typeof description === "string" && description.trim()) return description.trim();
      } catch (_) {

      }
    }
    return LIVEUI_TASK_UNKNOWN_APPROVAL_BEHAVIOUR;
  }
  function projectTask(task, row = null) {
    return {
      ...projectTaskForApproval(task, {
        toolApprovalBehaviour: describeTaskApprovalBehaviour(task),
        resolveTemplateHint: resolvePreferredTemplateHint,
      }),
      status: row && typeof row.status === "string" ? row.status : "draft",
      reason: row && typeof row.reason === "string" ? row.reason : null,
    };
  }
  let companionPublishPending = false;
  let companionSessionKey = "main";

  const capturedCronOutcome = new Map();

  const exitLatchBySession = new Map();

  let declarationSeq = 0;
  const declarationSalt = Math.random().toString(36).slice(2, 8);
  function nextDeclarationId() {
    declarationSeq += 1;
    return `decl-${declarationSalt}-${declarationSeq}`;
  }

  function emitMarker(sessionKey, surfaceId) {
    if (!surfaceId) return;
    const normalizedSessionKey = normalizeGlassesSessionKey(sessionKey);
    if (surfaceStore.topSurfaceId(normalizedSessionKey) !== surfaceId) return;
    const marker = displayedMarkerFor(surfaceId);
    if (!marker) return;
    paintFloor.enqueue({ surfaceId, sessionKey: normalizedSessionKey, patch: { marker } });
  }

  function displayedMarkerFor(surfaceId) {
    const marker = surfaceStore.markerFor(surfaceId);
    if (marker !== "inflight") return marker;
    const sessionKey = surfaceStore.sessionForSurface(surfaceId);
    if (!sessionKey || typeof deps.isAgentTurnBusy !== "function") return marker;
    try {
      return deps.isAgentTurnBusy(sessionKey) ? "processing" : marker;
    } catch (_) {
      return marker;
    }
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
    scheduleCompanionSnapshot(data);
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
      surfaceStore.recordContent(surfaceId, patch);

      const isRender = !!(patch && patch.__render);
      if (isRender) {
        surfaceStore.recordPreloadedChildren(surfaceId, patch.__spec?.children,
          patch.__recordedSpec?.children || patch.__spec?.children);

        const adoptedChild = surfaceStore.adoptedChildFor(sessionKey);
        if (adoptedChild && adoptedChild.parentId === surfaceId &&
            !patch.__spec?.children?.[adoptedChild.itemIndex]) {
          surfaceStore.popBack(sessionKey);
          navDepthBySession.set(sessionKey, surfaceStore.stackDepth(sessionKey));
          emitLifecycle("child_dropped_by_parent_render", "debug", {
            sessionKey, parent: surfaceId, child: adoptedChild.childId, itemIndex: adoptedChild.itemIndex,
          });
        }
        surfaceStore.recordSpec(
          surfaceId,
          patch.__recordedSpec && typeof patch.__recordedSpec === "object"
            ? patch.__recordedSpec
            : patch.__spec,
        );
      }
      const attempt = surfaceStore.recordSendAttempt(surfaceId, {
        mode: isRender ? "render" : "update",
      });
      const seq = attempt ? attempt.seq : null;
      if (!attempt) {

        emitLifecycle("send_attempt_unregistered", "warn", { surfaceId, mode: isRender ? "render" : "update" });
      }
      if (isRender) {
        emitLifecycle("render_sent", "debug", { surfaceId, sessionKey, seq });
        deps.relay.sendGlassesUiRender({ sessionKey, surfaceId, seq, depth: patch.__depth, spec: patch.__spec, marker: patch.__marker });
      } else {
        deps.relay.sendGlassesUiSurfaceUpdate({ sessionKey, surfaceId, seq, patch });
      }
      scheduleCompanionSnapshot({ surfaceId, sessionKey });
    },
    isUnderBackpressure: typeof deps.isUnderBackpressure === "function" ? deps.isUnderBackpressure : () => false,
  });

  const cronEngine = createGlassesUiCronEngine({
    emitLifecycle,

    isRefreshPaused: liveuiRefreshPaused,
    monotonicNowMs: () => performance.now(),
    executeRecipe: async (recipe, ctx) => {
      if (recipe.kind === "http") {
        const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
        return executeHttpRecipe(recipe, { hostCheck: currentHostCheck(cfg) });
      }
      if (recipe.kind === "system-stats") return executeSystemStatsRecipe(recipe);
      if (recipe.kind === "llm" && typeof deps.executeLlmRecipe === "function") {
        return deps.executeLlmRecipe(recipe, ctx);
      }
      if (recipe.kind === "llm") return executeLlmRecipe(recipe, ctx);
      return { error: `unknown recipe kind: ${recipe.kind}` };
    },
    glassesUiLimits: GLASSES_UI_LIMITS,
    validateTemplateSpec: ({ spec, sessionKey }) => {
      const checked = validateStaticPlan(spec, {
        sessionKey,
        includeConnectivity: false,
        stackDepth: surfaceStore.stackDepth(sessionKey),
      });
      if (!checked.merged.ok || !checked.validation || !checked.validation.ok) {
        const first = checked.merged.errors && checked.merged.errors[0];
        return {
          ok: false,
          code: first && first.code ? first.code : "template_spec_invalid",
          message: first && first.message
            ? first.message
            : "filled Template failed Engine validation",
        };
      }
      return { ok: true, spec: checked.validation.spec };
    },

    includeLastRender: () => {
      const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
      return !!cfg && cfg.includeLastRenderInOutcome === true;
    },
    sendSurfaceUpdate: (params) => paintFloor.enqueue({ surfaceId: params.surfaceId, sessionKey: params.sessionKey, patch: params.patch }),
    sendSurfaceRender: (params) => paintFloor.enqueue({
      surfaceId: params.surfaceId,
      sessionKey: params.sessionKey,
      patch: {
        __render: true,
        __depth: params.depth,
        __spec: params.spec,
        __recordedSpec: params.spec,
        __marker: displayedMarkerFor(params.surfaceId),
      },
    }),
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

  if (typeof deps.relay.onGlassesPresenceChanged === "function") {
    deps.relay.onGlassesPresenceChanged((msg) => {
      cronEngine.setPresence(msg && msg.presence);
    });
  }

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

  function companionTargetSession(rawSessionKey, data = {}) {
    let candidate =
      typeof rawSessionKey === "string" && rawSessionKey
        ? rawSessionKey
        : typeof data.sessionKey === "string" && data.sessionKey
          ? data.sessionKey
          : typeof data.surfaceId === "string"
            ? surfaceStore.sessionForSurface(data.surfaceId)
            : companionSessionKey;
    candidate = normalizeGlassesSessionKey(candidate || "main");
    const stage = surfaceStore.stageState(candidate, {
      graceMs: readStageConfig().stageGraceMs,
    });
    return typeof stage.holderSessionKey === "string" && stage.holderSessionKey
      ? stage.holderSessionKey
      : candidate;
  }

  function publishCompanionSnapshotNow(rawSessionKey) {
    if (typeof deps.publishCompanionSnapshot !== "function" || !publicApi) return null;
    try {
      const targetSessionKey = companionTargetSession(rawSessionKey);
      companionSessionKey = targetSessionKey;
      const companion = publicApi.snapshotUiState(targetSessionKey).companion;
      deps.publishCompanionSnapshot(companion);
      return companion;
    } catch (_) {

      return null;
    }
  }

  function scheduleCompanionSnapshot(data = {}) {
    if (typeof deps.publishCompanionSnapshot !== "function") return;
    if (typeof data.sessionKey === "string" && data.sessionKey) {
      companionSessionKey = normalizeGlassesSessionKey(data.sessionKey);
    } else if (typeof data.surfaceId === "string") {
      const owner = surfaceStore.sessionForSurface(data.surfaceId);
      if (owner) companionSessionKey = owner;
    }
    if (companionPublishPending) return;
    companionPublishPending = true;
    Promise.resolve().then(() => {
      companionPublishPending = false;
      publishCompanionSnapshotNow(companionSessionKey);
    });
  }

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

  const feedbackLedger = createGlassesFeedbackLedger({
    now: typeof deps.now === "function" ? deps.now : Date.now,
    ttlMs: deps.feedbackTtlMs,
    emitLifecycle,
  });

  if (typeof deps.relay.onGlassesUiRenderReceipt === "function") {
    deps.relay.onGlassesUiRenderReceipt((msg) => {
      if (!msg || typeof msg.surfaceId !== "string" || !msg.surfaceId) return;
      const result = surfaceStore.recordClientReceipt(msg.surfaceId, {
        seq: msg.seq,
        surfaceUuid: msg.surfaceUuid,
      });
      if (!result.ok) {

        emitLifecycle("render_receipt_rejected", "debug", {
          surfaceId: msg.surfaceId,
          sessionKey: surfaceStore.sessionForSurface(msg.surfaceId),
          reason: result.reason,
          seq: Number.isFinite(msg.seq) ? Math.floor(msg.seq) : null,
          expectedSeq: result.expectedSeq === undefined ? null : result.expectedSeq,
        });

        feedbackLedger.record({
          sessionKey: surfaceStore.sessionForSurface(msg.surfaceId),
          class: "receipt_rejected",
          code: result.reason,
          surfaceUuid: result.surfaceUuid,
          seq: Number.isFinite(msg.seq) ? Math.floor(msg.seq) : null,
          expectedSeq: result.expectedSeq === undefined ? null : result.expectedSeq,
        });
        return;
      }
      const delivery = surfaceStore.deliveryEvidenceOf(msg.surfaceId);
      const state = delivery ? deliveryLadderState(delivery.evidence) : null;
      emitLifecycle("render_receipt", "debug", {
        surfaceId: msg.surfaceId,
        surfaceUuid: result.surfaceUuid,
        seq: result.seq,
        superseded: result.superseded === true,

        rung: state ? state.rung : null,
        skipped: state && state.skipped.length ? state.skipped.join(",") : null,
      });
    });
  }

  if (typeof deps.relay.onGlassesUiClientFailure === "function") {
    deps.relay.onGlassesUiClientFailure((msg) => {
      if (!msg || typeof msg.surfaceId !== "string" || !msg.surfaceId) return;
      const result = surfaceStore.recordClientFailureEvidence(msg.surfaceId, {
        seq: msg.seq,
        code: msg.code,
        clientId: msg.clientId,
        deduplicate: true,
      });
      if (!result.ok) {

        emitLifecycle("render_failure_rejected", "debug", {
          surfaceId: msg.surfaceId,
          sessionKey: surfaceStore.sessionForSurface(msg.surfaceId),
          reason: result.reason,
          clientId: typeof msg.clientId === "string" ? msg.clientId : null,
          seq: Number.isFinite(msg.seq) ? Math.floor(msg.seq) : null,
          expectedSeq: result.expectedSeq === undefined ? null : result.expectedSeq,
        });
        return;
      }
      const delivery = surfaceStore.deliveryEvidenceOf(msg.surfaceId);
      const state = delivery ? deliveryLadderState(delivery.evidence) : null;
      if (!result.duplicate) emitLifecycle("render_failure_evidence", "debug", {
        surfaceId: msg.surfaceId,
        sessionKey: surfaceStore.sessionForSurface(msg.surfaceId),
        surfaceUuid: result.surfaceUuid,
        clientId: result.clientId,
        code: result.code,
        seq: result.seq,

        rung: state ? state.rung : null,
      });

      if (!result.duplicate) feedbackLedger.record({
        sessionKey: surfaceStore.sessionForSurface(msg.surfaceId),
        class: "render_error",
        code: result.code,
        surfaceUuid: result.surfaceUuid,
        seq: result.seq,
      });
      if (msg.channel !== "render_error") return;
      const verdict = surfaceStore.validateClientRenderError(msg.surfaceId, msg);
      if (!verdict.ok) {
        emitLifecycle("render_error_held", "debug", {
          surfaceId: msg.surfaceId, seq: msg.seq, clientId: msg.clientId,
          code: msg.code, reason: verdict.reason,
        });
        return;
      }
      const sessionKey = surfaceStore.sessionForSurface(msg.surfaceId);
      const outcome = {
        result: "render_failed", code: msg.code, clientId: msg.clientId,
        seq: msg.seq, origin: "client_render", actor: "client",
      };

      emitLifecycle("render_error_terminal", "warn", {
        surfaceId: msg.surfaceId, sessionKey, seq: msg.seq,
        clientId: msg.clientId, code: msg.code,
      });
      let merged = outcome;
      if (cronEngine.isActive(msg.surfaceId)) {
        capturedCronOutcome.set(msg.surfaceId, (cronOutcome) => { merged = cronOutcome; });
        cronEngine.stop(msg.surfaceId, outcome, undefined);
        capturedCronOutcome.delete(msg.surfaceId);
      }
      if (!surfaceStore.resolve(msg.surfaceId, merged)) surfaceStore.queueEvent(msg.surfaceId, merged, undefined);
      releaseTerminalTop(msg.surfaceId, merged, "render_error");
    });
  }

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
      releaseTerminalTop(msg.surfaceId, merged, "glasses_result");
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
    if (terminal) releaseTerminalTop(msg.surfaceId, outcome, "glasses_result");
  });

  function validateStaticPlan(spec, opts = {}) {
    const errors = [];
    const push = (result) => {
      if (result && result.ok === false) {
        errors.push({
          code: result.code || "invalid_spec",
          message: result.message || "spec validation failed",
        });
        return false;
      }
      return true;
    };
    const validation = validateGlassesUiSpec(spec);
    push(validation);
    const sessionKey = normalizeGlassesSessionKey(opts.sessionKey || "main");

    if (
      opts.includeConnectivity === true &&
      typeof deps.isSessionConnected === "function" &&
      !deps.isSessionConnected(sessionKey)
    ) {
      errors.push({
        code: "glasses_not_connected",
        message: "no Even glasses client connected for this session",
      });
    }
    let refreshValidation = null;
    if (spec && spec.refresh !== undefined) {
      const glassesUiLiveCfg = deps.getGlassesUiLiveConfig
        ? deps.getGlassesUiLiveConfig()
        : { enabled: true };
      refreshValidation = validateRefreshSpec(spec.refresh, glassesUiLiveCfg, spec.kind, {
        hostCheck: currentHostCheck(glassesUiLiveCfg),
      });
      push(refreshValidation);
    }
    const windowValidation = validateWindowFields(spec);
    const queueValidation = validateQueueMode(spec);
    const controlValidation = validateRenderControlFields(spec);
    push(windowValidation);
    push(queueValidation);
    push(controlValidation);

    const specValidated = Boolean(validation && validation.ok);
    const lint = specValidated
      ? lintGlassesUiPlan(spec, {
          stackDepth: Number.isFinite(opts.stackDepth) ? opts.stackDepth : 0,
        })
      : { ok: true, errors: [], warnings: [], template: null, layout: null };

    const merged = {
      ok: errors.length === 0 && lint.ok,
      errors: errors
        .map((e) => ({ code: e.code, severity: "error", message: e.message }))
        .concat(lint.errors),
      warnings: lint.warnings,
      template: lint.template,
      layout: lint.layout,
      ...(specValidated ? {} : { lintSkipped: "spec_invalid" }),
    };
    let normalizedSpec = null;
    if (validation && validation.ok) {
      normalizedSpec = { ...validation.spec };
      if (spec.update === "patch" || spec.update === "push") {
        normalizedSpec.update = spec.update;
      }
      if (windowValidation && windowValidation.ok) {
        if (windowValidation.timeoutMs !== undefined) {
          normalizedSpec.timeoutMs = windowValidation.timeoutMs;
        }
        if (windowValidation.staleAfterMs !== undefined) {
          normalizedSpec.staleAfterMs = windowValidation.staleAfterMs;
        }
      }
      if (queueValidation && queueValidation.ok && queueValidation.queueMode !== undefined) {
        normalizedSpec.queueMode = queueValidation.queueMode;
      }
      if (refreshValidation && refreshValidation.ok) {
        normalizedSpec.refresh = refreshValidation.refresh;
      }
    }
    return { merged, validation, normalizedSpec, sessionKey };
  }

  function runValidateOnly(params) {
    const spec = (params && params.spec) || {};
    const sessionKey = normalizeGlassesSessionKey(
      params && typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : "main",
    );
    const { merged, validation } = validateStaticPlan(spec, {
      sessionKey,
      includeConnectivity: true,
      stackDepth: surfaceStore.stackDepth(sessionKey),
    });
    const channels = projectValidateOnlyChannels(merged, {
      normalizedSpec: validation && validation.ok ? validation.spec : null,
    });

    emitLifecycle("render_validate_only", "debug", {
      surfaceId: null,
      sessionKey,
      ...channels.dev,

      machine: channels.machine,
    });
    return channels.model;
  }

  function recordRenderRefusal(params, code) {
    try {
      const surfaceId =
        params && typeof params.surfaceId === "string" && params.surfaceId ? params.surfaceId : null;
      feedbackLedger.record({
        sessionKey:
          params && typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : "main",
        class: "render_rejected",
        code,
        surfaceUuid: surfaceId ? surfaceStore.uuidOf(surfaceId) : null,
      });
    } catch (_) {

    }
  }

  function readStageConfig() {
    const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
    const maxConcurrentSurfacesPerHost = Number.isFinite(cfg.maxConcurrentSurfacesPerHost)
      ? Math.max(1, Math.min(64, Math.floor(cfg.maxConcurrentSurfacesPerHost)))
      : 4;
    const stageGraceMs = Number.isFinite(cfg.stageGraceMs)
      ? Math.max(1_000, Math.min(5 * 60_000, Math.floor(cfg.stageGraceMs)))
      : DEFAULT_STAGE_GRACE_MS;
    return { maxConcurrentSurfacesPerHost, stageGraceMs };
  }

  const heldConsentRenders = new Map();

  const liveuiGrantsListeners = new Set();
  function notifyLiveuiGrantsChanged() {
    for (const listener of liveuiGrantsListeners) {
      try {
        listener();
      } catch (_) {

      }
    }
  }
  function mayFilePendingGrant(params) {
    return !!params && params.spec && params.spec.validateOnly !== true;
  }
  function discardHeldConsentRenders(host) {
    for (const [key, held] of heldConsentRenders) {
      if (held.host === host) heldConsentRenders.delete(key);
    }
  }
  function holdConsentRender(host, params, validation, refresh) {

    discardHeldConsentRenders(host);
    while (heldConsentRenders.size >= 5) {
      heldConsentRenders.delete(heldConsentRenders.keys().next().value);
    }
    const heldSpec = {
      ...JSON.parse(JSON.stringify(validation.spec)),
      refresh: JSON.parse(JSON.stringify(refresh)),
    };
    for (const key of ["update", "timeoutMs", "staleAfterMs", "queueMode"]) {
      if (Object.prototype.hasOwnProperty.call(params.spec, key)) heldSpec[key] = params.spec[key];
    }
    const key = `${params.sessionKey}\u0000${host}`;
    heldConsentRenders.set(key, {
      host,
      params: {
        sessionKey: params.sessionKey,
        depth: params.depth,
        spec: heldSpec,
        wearerInitiated: params.wearerInitiated === true,
      },
    });
  }
  function startHeldConsentRenders(host) {
    const held = [...heldConsentRenders.values()].filter((entry) => entry.host === host);
    discardHeldConsentRenders(host);
    for (const entry of held) {
      void runDynamicUi(entry.params).catch((err) => {
        emitLifecycle("held_render_start_failed", "warn", {
          sessionKey: entry.params.sessionKey,
          host,
          code: err && typeof err.code === "string" ? err.code : "render_failed",
        });
      });
    }
  }

  async function runDynamicUi(params) {
    if (currentLiveuiPrefs().prefs.enabled === false) return liveuiDisabledResult();
    const sessionKey = normalizeGlassesSessionKey(
      params && typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : "main",
    );

    if (params && params.spec && params.spec.validateOnly === true) {
      return runValidateOnly(params);
    }
    const validation = validateGlassesUiSpec(params.spec);
    if (!validation.ok) {
      emitLifecycle("render_rejected", "warn", {
        surfaceId: params && typeof params.surfaceId === "string" ? params.surfaceId : null,
        sessionKey,
        code: validation.code || "invalid_spec",
        reason: validation.error || validation.message || "spec validation failed",
      });
      recordRenderRefusal(params, validation.code || "invalid_spec");
      const err = new Error(`${validation.code}: ${validation.message}`);
      err.code = validation.code;
      throw err;
    }

    if (typeof deps.isSessionConnected === "function" && !deps.isSessionConnected(sessionKey)) {
      emitLifecycle("render_rejected", "warn", {
        surfaceId: null,
        sessionKey,
        code: "glasses_not_connected",
        reason: "no Even glasses client connected for this session",
      });
      recordRenderRefusal({ ...params, sessionKey }, "glasses_not_connected");
      const err = new Error(
        "glasses_not_connected: no Even glasses client connected for this session",
      );
      err.code = "glasses_not_connected";
      throw err;
    }

    let refreshValidated;
    if (params.spec && params.spec.refresh !== undefined) {
      const glassesUiLiveCfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : { enabled: true };
      const v = validateRefreshSpec(params.spec.refresh, glassesUiLiveCfg, params.spec.kind, {
        hostCheck: currentHostCheck(glassesUiLiveCfg),
      });
      if (!v.ok) {
        if (v.code === "refresh_host_consent_required" && mayFilePendingGrant(params)) {
          const windowCheck = validateWindowFields(params.spec);
          const queueCheck = validateQueueMode(params.spec);
          if (!windowCheck.ok || !queueCheck.ok) {
            const rejected = !windowCheck.ok ? windowCheck : queueCheck;
            const err = new Error(`${rejected.code}: ${rejected.message}`);
            err.code = rejected.code;
            throw err;
          }
          const recipe = v.refresh.recipe;
          const filed = getLiveuiGrantsStore().filePending({
            host: v.host,
            method: typeof recipe.method === "string" ? recipe.method : "GET",
            hasHeaders: !!recipe.headers && Object.keys(recipe.headers).length > 0,
            hasBody: typeof recipe.body === "string" && recipe.body.length > 0,
          });
          if (filed && filed.ok === true) {
            holdConsentRender(v.host, { ...params, sessionKey }, validation, v.refresh);
            emitLifecycle("render_held_for_host_consent", "info", {
              sessionKey,
              host: v.host,
              filed: filed.filed === true,
            });
            if (filed.filed === true) notifyLiveuiGrantsChanged();
            return {
              status: "held",
              code: "refresh_host_consent_required",
              host: v.host,
              message: "The phone owner can approve this site and the surface will start automatically.",
            };
          }
          const err = new Error(`${filed.code}: host approval request could not be filed`);
          err.code = filed.code;
          throw err;
        }
        emitLifecycle("render_rejected", "warn", {
          surfaceId: null,
          sessionKey,
          code: v.code,
          reason: v.message,
        });
        recordRenderRefusal({ ...params, sessionKey }, v.code);
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
        sessionKey,
        code: windowFields.code,
        reason: windowFields.message,
      });
      recordRenderRefusal(params, windowFields.code);
      const err = new Error(`${windowFields.code}: ${windowFields.message}`);
      err.code = windowFields.code;
      throw err;
    }

    const queueModeField = validateQueueMode(params.spec);
    if (!queueModeField.ok) {
      emitLifecycle("render_rejected", "warn", {
        surfaceId: null,
        sessionKey,
        code: queueModeField.code,
        reason: queueModeField.message,
      });
      recordRenderRefusal(params, queueModeField.code);
      const err = new Error(`${queueModeField.code}: ${queueModeField.message}`);
      err.code = queueModeField.code;
      throw err;
    }

    const depth = Number.isFinite(params.depth) ? Math.max(1, Math.floor(params.depth)) : 1;
    const update =
      params.spec && (params.spec.update === "patch" || params.spec.update === "push")
        ? params.spec.update
        : "replace";

    const sessionExitLatch = exitLatchBySession.get(sessionKey);
    if (sessionExitLatch && params.wearerInitiated === true) {

      exitLatchBySession.delete(sessionKey);
      emitLifecycle("wearer_open_exit_latch_cleared", "debug", {
        surfaceId: sessionExitLatch.surfaceId,
        sessionKey,
      });
    } else if (sessionExitLatch) {
      const latchedOutcome = sessionExitLatch.outcome || { result: "dismissed" };
      const latchedOrigin =
        typeof latchedOutcome.origin === "string" ? latchedOutcome.origin : "gesture";
      if (latchedOrigin === "gesture") {

        const declarationId = nextDeclarationId();
        const declaredWindow = windowFields;
        emitLifecycle("surface_attach", "debug", {
          surfaceId: sessionExitLatch.surfaceId,
          sessionKey,
          mode: update,
          requestedUpdate: update,
          stackDepthBefore: surfaceStore.stackDepth(sessionKey),
          declarationId,
          staleAfterMs: Number.isFinite(declaredWindow.staleAfterMs)
            ? declaredWindow.staleAfterMs
            : null,
          declaredTimeoutMs: Number.isFinite(declaredWindow.timeoutMs)
            ? declaredWindow.timeoutMs
            : null,
          discardedForExit: true,
        });
        return latchedOutcome;
      }

      exitLatchBySession.delete(sessionKey);
      emitLifecycle("stale_cron_summary_dropped", "debug", {
        surfaceId: sessionExitLatch.surfaceId,
        sessionKey,
      });
    }

    const stageCfg = readStageConfig();
    if (
      surfaceStore.stackDepth(sessionKey) === 0 &&
      surfaceStore.activeSessionCount() >= stageCfg.maxConcurrentSurfacesPerHost
    ) {
      const reason =
        `host already tracks ${surfaceStore.activeSessionCount()} live session stack(s); ` +
        `limit is ${stageCfg.maxConcurrentSurfacesPerHost}`;
      emitLifecycle("render_rejected", "warn", {
        surfaceId: null,
        sessionKey,
        code: "refresh_concurrent_limit",
        reason,
        maxConcurrentSurfacesPerHost: stageCfg.maxConcurrentSurfacesPerHost,
      });
      recordRenderRefusal({ ...params, sessionKey }, "refresh_concurrent_limit");
      const err = new Error(`refresh_concurrent_limit: ${reason}`);
      err.code = "refresh_concurrent_limit";
      throw err;
    }

    const stagePlan = surfaceStore.planStageGrant(sessionKey, {
      graceMs: stageCfg.stageGraceMs,
    });
    if (!stagePlan.ok) {
      const reason =
        `stage_incumbent_busy: session ${stagePlan.incumbentSessionKey} is ` +
        `${stagePlan.incumbentMarker}; retry after ${stagePlan.retryAfterMs}ms`;
      emitLifecycle("render_rejected", "warn", {
        surfaceId: stagePlan.incumbentSurfaceId,
        sessionKey,
        code: "stage_incumbent_busy",
        reason,
        retryAfterMs: stagePlan.retryAfterMs,
      });
      recordRenderRefusal({ ...params, sessionKey }, "stage_incumbent_busy");
      const err = new Error(reason);
      err.code = "stage_incumbent_busy";
      err.retryAfterMs = stagePlan.retryAfterMs;
      throw err;
    }

    if (depth <= 1 && surfaceStore.stackDepth(sessionKey) > 1) {
      const stackDepthBefore = surfaceStore.stackDepth(sessionKey);
      const reapedPending = reapSession(sessionKey, { result: "preempted" });
      emitLifecycle("stale_stack_reaped", "warn", {
        sessionKey,
        stackDepthBefore,
        reapedPending,
      });
    }
    surfaceStore.commitStageGrant(sessionKey, stagePlan);

    const stackDepthBeforeAttach = surfaceStore.stackDepth(sessionKey);
    const applied = surfaceStore.applyRender(sessionKey, {
      update,
      kind: validation.spec.kind,
    });
    const surfaceId = applied.surfaceId;

    const declarationId = nextDeclarationId();

    const declaredWindow = windowFields;
    const declaredStaleAfterMs = Number.isFinite(declaredWindow.staleAfterMs)
      ? declaredWindow.staleAfterMs
      : null;
    const declaredTimeoutMs = Number.isFinite(declaredWindow.timeoutMs)
      ? declaredWindow.timeoutMs
      : null;

    emitLifecycle("surface_attach", "debug", {
      surfaceId,
      sessionKey,
      mode: applied.mode,
      requestedUpdate: update,
      stackDepthBefore: stackDepthBeforeAttach,

      declarationId,
      staleAfterMs: declaredStaleAfterMs,
      declaredTimeoutMs,
    });

    const promise = surfaceStore.register(sessionKey, surfaceId, {
      kind: validation.spec.kind,
      wearerInitiated: params.wearerInitiated === true,
      staleAfterMs: windowFields.staleAfterMs,
      queueMode: queueModeField.queueMode,
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

    openedChildBySurface.delete(surfaceId);
    const wireDepth = Math.max(
      1,
      Number.isFinite(applied.depth) ? applied.depth : surfaceStore.stackDepth(sessionKey),
    );

    const validationAny = validation;
    const validationSpec = validationAny.spec;
    const recordedSpec = { ...validationSpec };
    if (["replace", "patch", "push"].includes(params.spec && params.spec.update)) {
      recordedSpec.update = params.spec.update;
    }
    if (declaredWindow.timeoutMs !== undefined) recordedSpec.timeoutMs = declaredWindow.timeoutMs;
    if (declaredWindow.staleAfterMs !== undefined) recordedSpec.staleAfterMs = declaredWindow.staleAfterMs;
    if (queueModeField.queueMode !== undefined) recordedSpec.queueMode = queueModeField.queueMode;
    if (refreshValidated !== undefined) recordedSpec.refresh = refreshValidated;
    const breadcrumb = surfaceStore.breadcrumbFor(sessionKey, wireDepth);
    if (breadcrumb) validation.spec.title = clipBreadcrumb(breadcrumb);

    const wireSpec = { ...validation.spec };
    if (Array.isArray(validation.spec.children)) {
      wireSpec.children = mintPreloadedChildren(
        surfaceId,
        validation.spec.title,
        validation.spec.children,
        declarationSeq,
      );
    }
    paintFloor.enqueue({
      surfaceId,
      sessionKey,

      patch: {
        __render: true,
        __depth: wireDepth,
        __spec: wireSpec,
        __recordedSpec: recordedSpec,
        __marker: displayedMarkerFor(surfaceId),
      },
    });

    if (typeof params.onOpened === "function") {
      params.onOpened({ surfaceId, sessionKey });
    }

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
        surfaceKind: validation.spec.kind,
        staleAfterMs: declaredStaleAfterMs,
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
        seedSpec: validation.spec,
        wireDepth,
        templateRuntime: params.templateRuntime,
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

            if (!capture) releaseTerminalTop(surfaceId, stamped, "cron_terminal");
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

      const openedChild = openedChildBySurface.get(surfaceId);
      if (surfaceStore.resolve(surfaceId, windowExpiredOutcome(openedChild ? { opened_child: openedChild } : undefined))) {
        emitLifecycle("window_expired", "debug", {
          surfaceId,
          sessionKey,
          windowMs: effectiveWindowMs,
          via: "wrap_up_timer",

          openedChild: openedChild || null,

          declarationId,
          staleAfterMs: declaredStaleAfterMs,
          declaredTimeoutMs,
        });

        emitMarker(sessionKey, surfaceId);
      }
    }, wrapUpDelayMs);
    cleanups.push(() => clearTimeoutFn(wrapUpHandle));

    const signal = params.signal;
    if (signal && typeof signal.addEventListener === "function") {
      const onAbort = () => {
        const outcome = {
          result: "cancelled",
          origin: "system",
          surface_still_live: true,
        };
        if (surfaceStore.resolve(surfaceId, outcome)) {
          emitLifecycle("surface_settled", "info", {
            surfaceId,
            sessionKey,
            outcome,
            via: "abort_signal",

            declarationId,
            staleAfterMs: declaredStaleAfterMs,
            declaredTimeoutMs,
          });

          emitMarker(sessionKey, surfaceId);
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

        const outcome = {
          result: "timeout",
          timeout_ms: timeoutMs,
          origin: "system",
        };
        if (surfaceStore.resolve(surfaceId, outcome)) {
          releaseTerminalTop(surfaceId, outcome, "terminal_janitor");
        }
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

  const openedChildBySurface = new Map();

  function handleNavEvent(rawSessionKey, ev) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);

    if (ev.depth === 0 && ev.action !== "push_local") {
      const storeDepthBefore = surfaceStore.stackDepth(sessionKey);
      const matched = storeDepthBefore > 0 && surfaceStore.topSurfaceId(sessionKey) === ev.surfaceId;
      if (matched) reapSession(sessionKey, { result: "dismissed" });
      emitLifecycle("nav_reconcile", "debug", {
        sessionKey, evSurfaceId: ev.surfaceId, evDepth: 0,
        newDepth: matched ? 0 : storeDepthBefore,
        lastDepth: storeDepthBefore, storeDepthBefore,
        popCount: matched ? storeDepthBefore : 0,
        resumedParent: null, reason: matched ? "chat_return" : "stale_chat_return",
      });
      return;
    }
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
      surfaceStore.topSurfaceId(sessionKey) === ev.surfaceId &&

      ev.action !== "push_local"
    ) {

      resumedParent = surfaceStore.popBack(sessionKey);
      popCount += 1;
    }

    if (popCount > 0 && resumedParent) {
      emitMarker(sessionKey, resumedParent);
    }

    let adopt = null;
    if (ev.action === "push_local" && typeof ev.childSurfaceId === "string" && ev.childSurfaceId) {
      const itemIndex = Number.isInteger(ev.itemIndex) && ev.itemIndex >= 0 ? ev.itemIndex : null;
      adopt = surfaceStore.adoptClientPush(sessionKey, ev.childSurfaceId, {
        parentId: ev.surfaceId,
        itemIndex,
      });
      if (adopt.ok && adopt.mode === "adopted") {

        openedChildBySurface.set(ev.surfaceId, { surfaceId: ev.childSurfaceId, itemIndex });

        surfaceStore.queueEvent(
          ev.childSurfaceId,
          {
            result: "opened",
            selected_index: itemIndex,
            child_surface_id: ev.childSurfaceId,
            origin: "gesture",
            actor: "wearer",
          },
          { origin: "gesture", actor: "wearer" },
        );
        emitLifecycle("child_opened_local", "info", {
          sessionKey,
          parent: ev.surfaceId,
          child: ev.childSurfaceId,
          itemIndex,
          kind: adopt.kind,
        });
      }
    }
    emitLifecycle("nav_reconcile", "debug", {
      sessionKey,
      evSurfaceId: ev.surfaceId,
      evDepth: ev.depth,
      evAction: typeof ev.action === "string" ? ev.action : null,
      evChildSurfaceId: typeof ev.childSurfaceId === "string" ? ev.childSurfaceId : null,
      newDepth,
      lastDepth,
      storeDepthBefore,
      popCount,
      resumedParent,
      adopt,
    });
    navDepthBySession.set(sessionKey, adopt && !adopt.ok ? surfaceStore.stackDepth(sessionKey) : newDepth);
  }

  function reapSession(rawSessionKey, outcome) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    cronEngine.stopAllForSession(sessionKey, outcome);
    const reaped = surfaceStore.drainSession(sessionKey, outcome);
    surfaceStore.exit(sessionKey);
    navDepthBySession.delete(sessionKey);

    for (const parentId of [...openedChildBySurface.keys()]) {
      if (!surfaceStore.sessionForSurface(parentId)) openedChildBySurface.delete(parentId);
    }
    return reaped;
  }

  function releaseTerminalTop(surfaceId, outcome, via) {
    const sessionKey = surfaceStore.sessionForSurface(surfaceId);
    if (!sessionKey || surfaceStore.topSurfaceId(sessionKey) !== surfaceId) return false;
    const facts = surfaceStore.surfaceFactsFor(surfaceId);
    const terminal =
      isTerminalOutcome(outcome) ||
      !!(facts && facts.exitLatched) ||
      !!(facts && isTerminalOutcome({ result: facts.terminationCause }));
    if (!terminal) return false;

    const stackDepthBefore = surfaceStore.stackDepth(sessionKey);
    if (stackDepthBefore <= 0) return false;
    let resumedParent = null;
    if (stackDepthBefore === 1) {

      let ownerlessSurface = false;
      if ((surfaceStore.isWearerInitiated(surfaceId) || surfaceStore.hasAgentRunEnded(surfaceId)) &&
          !facts?.awaitingAgentResponse &&
          typeof deps.isAgentTurnBusy === "function") {
        try { ownerlessSurface = deps.isAgentTurnBusy(sessionKey) === false; } catch (_) {  }
      }
      const latchedOutcome =
        outcome && typeof outcome === "object" && !Array.isArray(outcome)
          ? {
              ...outcome,
              ...(outcome.surfaceUuid === undefined && facts && facts.surfaceUuid
                ? { surfaceUuid: facts.surfaceUuid }
                : {}),
            }
          : outcome;
      reapSession(sessionKey, outcome);
      if (!ownerlessSurface) {
        exitLatchBySession.set(sessionKey, {
          surfaceId,
          outcome: latchedOutcome || { result: "dismissed" },
        });
      }
    } else {
      resumedParent = surfaceStore.popBack(sessionKey);
      navDepthBySession.set(sessionKey, surfaceStore.stackDepth(sessionKey));
      if (resumedParent) emitMarker(sessionKey, resumedParent);
    }
    emitLifecycle("terminal_surface_released", "debug", {
      sessionKey,
      surfaceId,
      result: outcome && outcome.result,
      via,
      stackDepthBefore,
      stackDepthAfter: surfaceStore.stackDepth(sessionKey),
      resumedParent,
    });
    return true;
  }

  function readDeliveryState(surfaceId) {
    const delivery = surfaceStore.deliveryEvidenceOf(surfaceId);
    if (!delivery) return null;
    const state = deliveryLadderState(delivery.evidence);
    return {
      surfaceUuid: delivery.surfaceUuid,
      lastAttemptedSend: delivery.lastAttemptedSend,
      lastPaintedAt: delivery.lastPaintedAt,
      evidence: delivery.evidence,
      rung: state.rung,
      phrase: state.phrase,
      skipped: [...state.skipped],
    };
  }

  const nowMs = typeof deps.now === "function" ? deps.now : Date.now;

  function safeBool(read) {
    try {
      const value = read();
      return value === undefined || value === null ? null : !!value;
    } catch (_) {
      return null;
    }
  }

  function renameTemplate(templateId, options = {}) {
    const stored = getTemplateLibrary().read(templateId);
    if (stored.status !== "accepted") return stored;
    const clash = visibleNameClash("template", templateId, options.name);
    if (clash) return rejectLiveuiVisibleNameClash(clash);
    const template = stored.template;
    return getTemplateLibrary().save({
      schemaVersion: template.schemaVersion,
      templateId: template.templateId,
      name: options.name,
      defaults: template.defaults,
      fields: template.fields,
      assets: template.assets,
      ...(template.slots === undefined ? {} : { slots: template.slots }),
      ...(template.presentations === undefined ? {} : { presentations: template.presentations }),
      ...(template.recipe === undefined ? {} : { recipe: template.recipe }),
    }, {
      expectedDigest: options.expectedDigest,
      ...(template.helperOf === undefined ? {} : { helperOf: template.helperOf }),
    });
  }

  function resolvePreferredTemplateHint(templateId) {
    try {
      const stored = getTemplateLibrary().read(templateId);
      if (!stored || stored.status !== "accepted") return null;
      return {
        templateId: stored.template.templateId,
        name: stored.template.name,
        summary: summarizeLiveuiTemplateSpec(stored.template.spec, stored.template.slots),
      };
    } catch (_) {
      return null;
    }
  }

  function reorderLibrary(options = {}) {
    return getLibraryOrganization().reorderLibrary(options);
  }

  function setLibraryItemHidden(options = {}) {
    return getLibraryOrganization().setLibraryItemHidden(options);
  }

  function updateTaskCosmetic(taskId, options = {}) {
    return getTaskLibrary().updateTaskCosmetic(taskId, options);
  }

  function updateTaskSettingValues(taskId, values, options = {}) {
    const result = getTaskLibrary().updateTaskSettingValues(taskId, values, options);
    return result && result.status === "saved"
      ? { ...result, task: projectTask(result.task) }
      : result;
  }

  function deleteTask(taskId, options = {}) {
    return getTaskLibrary().deleteTask(taskId, options);
  }

  function deleteTemplate(templateId, options = {}) {
    const references = findLiveuiTasksReferencingTemplate(
      getTaskLibrary(),
      templateId,
    );
    const organization = getLibraryOrganization().removeLibraryItem("template", templateId);
    if (!organization || organization.status !== "saved") return organization;
    const deleted = getTemplateLibrary().delete(templateId, options);
    if (!deleted || deleted.status !== "deleted") return deleted;
    const clearedPreferredTemplateTaskIds = [];
    for (const reference of references) {
      const cleared = getTaskLibrary().setTaskPreferredTemplate(
        reference.taskId,
        null,
        { expectedDigest: reference.digest },
      );
      if (cleared && ["saved", "unchanged"].includes(cleared.status)) {
        clearedPreferredTemplateTaskIds.push(reference.taskId);
      }
    }
    return { ...deleted, clearedPreferredTemplateTaskIds };
  }

  function liveuiGrantsSnapshot() {
    const cfg = typeof deps.getGlassesUiLiveConfig === "function"
      ? deps.getGlassesUiLiveConfig() || {}
      : {};
    const httpHostPolicy = cfg.httpHostPolicy === "owner-grants"
      ? "owner-grants"
      : "operator-only";
    const state = getLiveuiGrantsStore().load();
    const lists = httpHostPolicy === "owner-grants"
      ? {
          pending: state.pending.map((row) => ({ ...row })),
          granted: state.granted.map((row) => ({ ...row })),
          denied: state.denied.map((row) => ({ ...row })),
        }
      : { pending: [], granted: [], denied: [] };
    return {
      httpHostPolicy,
      digest: state.digest,
      ...(state.grantsInvalid ? { grantsInvalid: state.grantsInvalid } : {}),
      ...lists,
    };
  }

  publicApi = {
    storeId,
    runDynamicUi,
    liveuiPrefs() {
      return currentLiveuiPrefs();
    },
    setLiveuiPrefs(patch) {
      const before = currentLiveuiPrefs().prefs;
      const saved = getLiveuiPrefsStore().save(patch);
      if (saved.status !== "saved") return saved;
      cachedLiveuiPrefs = null;
      const after = saved.prefs;

      const flippedOff = before.enabled !== false && after.enabled === false;

      const clearedSessionKeys = flippedOff
        ? surfaceStore.sessionKeys().filter((key) => surfaceStore.stackDepth(key) > 0)
        : [];
      if (flippedOff && publicApi) {
        publicApi.drainAll({ result: "preempted", reason: "liveui_disabled" });
      }
      cronEngine.syncRefreshPause();
      return { status: "accepted", prefs: after, clearedSessionKeys };
    },
    liveuiGrantsSnapshot,

    onLiveuiGrantsChanged(listener) {
      if (typeof listener !== "function") return () => {};
      liveuiGrantsListeners.add(listener);
      return () => liveuiGrantsListeners.delete(listener);
    },

    liveuiHostCheck() {
      const cfg = typeof deps.getGlassesUiLiveConfig === "function"
        ? deps.getGlassesUiLiveConfig() || {}
        : {};
      return currentHostCheck(cfg);
    },
    applyLiveuiGrantIntent(intent) {
      const snapshotBefore = liveuiGrantsSnapshot();
      if (snapshotBefore.httpHostPolicy !== "owner-grants") {
        return {
          status: "rejected",
          code: "grants_policy_operator_only",
          snapshot: snapshotBefore,
        };
      }
      const applied = getLiveuiGrantsStore().apply(intent);
      if (!applied || applied.ok !== true) {
        return {
          status: "rejected",
          code: applied && typeof applied.code === "string"
            ? applied.code
            : "grants_write_failed",
          snapshot: liveuiGrantsSnapshot(),
        };
      }
      const normalized = normalizeGrantHost(intent && intent.host);
      const host = normalized.ok ? normalized.host : "";
      let clearedSessionKeys = [];
      if (intent.action === "deny" || intent.action === "remove") {
        discardHeldConsentRenders(host);
        clearedSessionKeys = cronEngine.sessionKeysForHttpHost(host)
          .filter((key) => surfaceStore.stackDepth(key) > 0);
        for (const key of clearedSessionKeys) {
          publicApi.drainSession(key, {
            result: "preempted",
            reason: "refresh_host_revoked",
          });
        }
      } else if (intent.action === "allow") {
        startHeldConsentRenders(host);
      }
      return {
        status: "accepted",
        ...((intent.action === "deny" || intent.action === "remove")
          ? { clearedSessionKeys }
          : {}),
        snapshot: liveuiGrantsSnapshot(),
      };
    },
    liveuiStatus() {
      const cfg = typeof deps.getGlassesUiLiveConfig === "function"
        ? deps.getGlassesUiLiveConfig() || {}
        : {};
      const stage = readStageConfig();
      const prefs = currentLiveuiPrefs().prefs;
      const grants = liveuiGrantsSnapshot();
      const tickAuth = deps.host === "hermes"
        ? "ok"
        : cfg.llmDisabledReason === "no_backend"
          ? "no_backend"
          : (typeof deps.resolveLlmApiKey === "function" && deps.resolveLlmApiKey(cfg.tickModel || ""))
            ? "ok"
            : "missing_key";
      return {
        host: deps.host === "hermes" ? "hermes" : "openclaw",
        enabled: prefs.enabled !== false,
        pauseApps: prefs.pauseApps === true,
        refreshEnabled: cfg.enabled !== false,
        httpEnabled: cfg.httpEnabled === true,
        allowedDomains: Array.isArray(cfg.httpAllowHosts) ? cfg.httpAllowHosts.length : 0,
        httpHostPolicy: grants.httpHostPolicy,
        ownerGrants: grants.httpHostPolicy === "owner-grants" ? grants.granted.length : 0,
        tickAuth,
        ...(grants.grantsInvalid ? { grantsInvalid: grants.grantsInvalid } : {}),
        llmEnabled: cfg.llmEnabled === true,
        allowAgentModelOverride: cfg.allowAgentModelOverride === true,
        tickModel: typeof cfg.tickModel === "string" && cfg.tickModel ? cfg.tickModel : null,
        tickBackend: typeof cfg.tickBackend === "string" && cfg.tickBackend ? cfg.tickBackend : null,
        surfaces: surfaceStore.activeSessionCount(),
        maxSurfaces: stage.maxConcurrentSurfacesPerHost,
        stageGraceMs: stage.stageGraceMs,

        approvalHudSupported: deps.host !== "hermes",
      };
    },
    validateTemplateSpec(spec) {
      const result = validateStaticPlan(spec, {
        includeConnectivity: false,
        stackDepth: 0,
      });
      return {
        ...result.merged,
        normalizedSpec: result.merged.ok ? result.normalizedSpec : null,
      };
    },
    saveTemplate(template, options = {}) {
      return getTemplateLibrary().save(template, options);
    },
    readTemplate(templateId) {
      return getTemplateLibrary().read(templateId);
    },
    resolveTemplateHint(templateId) {
      return resolvePreferredTemplateHint(templateId);
    },
    listTemplates() {
      return getTemplateLibrary().list();
    },
    listLibrary(options = {}) {
      return getTemplateLibrary().listItems(options);
    },
    getLibraryOrganization() {
      return currentOrganization();
    },
    currentSurfaceSpecForSession(sessionKey) {
      return surfaceStore.currentSurfaceSpecForSession(
        normalizeGlassesSessionKey(sessionKey),
      );
    },
    renameTemplate,
    reorderLibrary,
    setLibraryItemHidden,
    updateTaskCosmetic,
    updateTaskSettingValues,
    deleteTask,
    saveUiAsHelper(input, context = {}) {
      return getTaskLibrary().saveUiAsHelper(input, context);
    },
    createTaskDraft(input, context = {}) {
      return getTaskLibrary().createDraft(input, context);
    },
    updateTaskDraft(input, context = {}) {
      return getTaskLibrary().updateDraft(input, context);
    },
    updateTaskExecutor(taskId, executor) {
      return getTaskLibrary().updateTaskExecutor(taskId, executor);
    },
    setTaskPreferredTemplate(taskId, templateId, options = {}) {
      const result = getTaskLibrary().setTaskPreferredTemplate(taskId, templateId, options);
      if (!result || !["saved", "unchanged"].includes(result.status)) {
        return {
          taskId,
          status: "rejected",
          code: result && typeof result.code === "string"
            ? result.code
            : "task_preferred_template_update_failed",
        };
      }
      return { taskId, status: "accepted", task: projectTask(result.task) };
    },
    updateTaskContext(taskId, context) {
      return getTaskLibrary().updateTaskContext(taskId, context);
    },
    readTask(taskId) {
      return getTaskLibrary().read(taskId);
    },
    listTasks() {
      return getTaskLibrary().list();
    },
    appendTaskRunRecord(record) {
      return getTaskRunRecordStore().append(record);
    },
    listTaskRunRecords(taskId) {
      return getTaskRunRecordStore().list(taskId);
    },
    findTasks(query) {
      return getTaskLibrary().findTasks(query);
    },
    listTasksForPhone(executorStateProvider = null) {
      const listed = getTaskLibrary().listItems({ executorStateProvider });
      const organizationState = currentOrganization();
      const ordered = orderLiveuiLibraryItems(listed.items, organizationState.organization);
      const tasks = [];
      const templates = [];
      const invalid = [];
      for (const row of ordered) {
        if (!row) continue;
        if (row.status === "invalid") {
          invalid.push({
            itemType: row.itemType,
            itemId: row.itemId,
            ...(typeof row.name === "string" ? { name: row.name } : {}),
            reason: row.reason,
          });
          continue;
        }
        if (row.itemType === "template") {
          const loaded = getTemplateLibrary().read(row.itemId);
          if (loaded.status === "accepted") {
            templates.push({
              templateId: loaded.template.templateId,
              name: loaded.template.name,
              digest: loaded.template.digest,
              helper: !!loaded.template.helperOf,
            });
          }
          continue;
        }
        if (row.itemType === "task") {
          const loaded = getTaskLibrary().read(row.itemId);
          if (loaded.status === "accepted") tasks.push(projectTask(loaded.task, row));
          else invalid.push({
            itemType: "task",
            itemId: row.itemId,
            reason: loaded.reason || loaded.code || "library_record_malformed",
          });
        }
      }
      return {
        tasks,
        templates,
        invalid,
        organization: organizationState.organization,
        ...(organizationState.organizationInvalid
          ? { organizationInvalid: organizationState.organizationInvalid }
          : {}),
      };
    },
    reviewTask(params) {
      const taskId = params && typeof params.taskId === "string" ? params.taskId : "";
      const action = params && typeof params.action === "string" ? params.action : "";
      const expectedDigest = params && params.expectedDigest;
      let result;
      if (action === "approve") {
        result = getTaskLibrary().approveTask(taskId, { expectedDigest });
      } else if (action === "reject") {
        result = getTaskLibrary().rejectTask(taskId, { expectedDigest });
      } else if (action === "undo") {
        result = getTaskLibrary().undoTaskUpdate(taskId, { expectedDigest });
      } else {
        result = { status: "rejected", code: "task_review_action_invalid" };
      }
      if (!result || result.status !== "saved") {
        return {
          taskId,
          action,
          status: "rejected",
          code: result && typeof result.code === "string" ? result.code : "task_review_failed",
          ...(result && result.code === "library_name_clash" && typeof result.message === "string"
            ? { message: result.message }
            : {}),
        };
      }
      return {
        taskId,
        action,
        status: "accepted",
        ...(result.task ? { task: projectTask(result.task) } : {}),
      };
    },
    organizeLibrary(params) {
      const action = params && typeof params.action === "string" ? params.action : "";
      const itemType = params && typeof params.itemType === "string" ? params.itemType : "";
      const itemId = params && typeof params.itemId === "string" ? params.itemId : "";
      const expectedDigest = params && params.expectedDigest;
      let result;
      if (action === "reorder") {
        result = reorderLibrary({
          expectedDigest,
          order: params && params.order,
        });
      } else if (action === "hide" || action === "show") {
        const row = (currentLibraryItems().items || []).find(
          (entry) => entry && entry.itemType === itemType && entry.itemId === itemId,
        );
        if (!row || row.status === "invalid") {
          result = {
            status: "rejected",
            code: "item_unavailable",
            message: "Library item is unavailable",
          };
        } else if (action === "show") {
          const clash = visibleNameClash(itemType, itemId, row.name, { forceVisible: true });
          result = clash
            ? rejectLiveuiVisibleNameClash(clash)
            : setLibraryItemHidden({
              expectedDigest,
              itemType,
              itemId,
              hidden: false,
            });
        } else {
          result = setLibraryItemHidden({
            expectedDigest,
            itemType,
            itemId,
            hidden: true,
          });
        }
      } else if (action === "rename" && itemType === "template") {
        result = renameTemplate(itemId, { expectedDigest, name: params.name });
      } else if (action === "cosmetic" && itemType === "task") {
        result = updateTaskCosmetic(itemId, {
          expectedDigest,
          ...(Object.prototype.hasOwnProperty.call(params || {}, "name") ? { name: params.name } : {}),
          ...(Object.prototype.hasOwnProperty.call(params || {}, "description")
            ? { description: params.description }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(params || {}, "icon") ? { icon: params.icon } : {}),
        });
      } else if (action === "delete" && itemType === "task") {
        result = deleteTask(itemId, { expectedDigest });
      } else if (action === "delete" && itemType === "template") {
        result = deleteTemplate(itemId, { expectedDigest });
      } else {
        result = {
          status: "rejected",
          code: "library_organize_action_invalid",
          message: "action and item type do not match a Library owner operation",
        };
      }
      const accepted = result && ["saved", "deleted"].includes(result.status);
      return {
        action,
        status: accepted ? "accepted" : "rejected",
        ...(accepted && Array.isArray(result.clearedPreferredTemplateTaskIds)
          ? { clearedPreferredTemplateTaskIds: result.clearedPreferredTemplateTaskIds }
          : {}),
        ...(accepted ? {} : {
          code: result && typeof result.code === "string" ? result.code : "library_organize_failed",
          ...(result && typeof result.message === "string" ? { message: result.message } : {}),
        }),
      };
    },
    async renderStoredTemplate(params) {
      const stored = params && params.template;
      const filled = fillLiveuiTemplate(stored, params && params.values, {
        ...(params && params.error !== undefined ? { error: params.error } : {}),
      });
      const outcome = await runDynamicUi({
        sessionKey: params.sessionKey,
        depth: params.depth,
        spec: filled.spec,
        signal: params.signal,
        onOpened: params.onOpened,
        wearerInitiated: params.wearerInitiated === true,
        templateRuntime: {
          template: stored,
          values: params && params.values,
        },
      });
      return {
        status: "rendered",
        templateId: stored.templateId,
        digest: stored.digest,
        outcome,
      };
    },
    handleNavEvent,
    releaseLibraryTemplateSurface(surfaceId, outcome) {
      const sessionKey = surfaceStore.sessionForSurface(surfaceId);
      const terminalOutcome =
        outcome && isTerminalOutcome(outcome)
          ? outcome
          : { result: "preempted", origin: "system", reason: "library_template_reopen" };
      let merged = terminalOutcome;
      if (cronEngine.isActive(surfaceId)) {

        capturedCronOutcome.set(surfaceId, (cronOutcome) => { merged = cronOutcome; });
        cronEngine.stop(surfaceId, terminalOutcome, undefined);
        capturedCronOutcome.delete(surfaceId);
      }
      if (!surfaceStore.resolve(surfaceId, merged)) {
        surfaceStore.queueEvent(surfaceId, merged, undefined);
      }
      const released = releaseTerminalTop(surfaceId, merged, "library_template_reopen");
      if (released) scheduleCompanionSnapshot({ sessionKey });
      return released;
    },
    drainSession(sessionKey, outcome) {
      const reaped = reapSession(sessionKey, outcome);
      exitLatchBySession.delete(normalizeGlassesSessionKey(sessionKey));
      scheduleCompanionSnapshot({ sessionKey });
      return reaped;
    },

    settleSession(sessionKey, outcome) {
      return surfaceStore.settlePending(sessionKey, outcome);
    },
    releaseTerminalTopOnAgentEnd(sessionKey, outcome) {
      const normalizedSessionKey = normalizeGlassesSessionKey(sessionKey);
      const top = surfaceStore.topSurfaceId(normalizedSessionKey);
      const released = top ? releaseTerminalTop(top, outcome, "agent_end") : false;

      exitLatchBySession.delete(normalizedSessionKey);
      surfaceStore.markAgentRunEnded(normalizedSessionKey);
      return released;
    },
    drainAll(outcome) {
      cronEngine.stopAll(outcome);
      const reaped = surfaceStore.drainAll(outcome);
      for (const sessionKey of surfaceStore.sessionKeys()) {
        surfaceStore.exit(sessionKey);
      }
      navDepthBySession.clear();
      exitLatchBySession.clear();
      scheduleCompanionSnapshot({ sessionKey: companionSessionKey });
      return reaped;
    },
    setGlassesPresence(presence) {
      return cronEngine.setPresence(presence);
    },
    getGlassesPresence() {
      return cronEngine.getPresence();
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

    buildFeedbackInjection(sessionKey) {
      return feedbackLedger.buildInjection(sessionKey);
    },
    previewFeedbackInjection(sessionKey) {
      return feedbackLedger.previewInjection(sessionKey);
    },
    ackFeedbackInjection(sessionKey, ackToken) {
      return feedbackLedger.ackInjection(sessionKey, ackToken);
    },
    recordRenderRefusal(input) {
      return feedbackLedger.record(input);
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
    activeSessionCount() {
      return surfaceStore.activeSessionCount();
    },

    deliveryStateOf(surfaceId) {
      return readDeliveryState(surfaceId);
    },
    hasClientReceipt(surfaceUuid, seq) {
      return surfaceStore.hasClientReceipt(surfaceUuid, seq);
    },

    snapshotUiState(rawSessionKey) {
      const sessionKey = normalizeGlassesSessionKey(rawSessionKey || "main");

      const port = deps;
      const hostCapabilities = buildHostCapabilityManifest(deps);

      const renderContext = deriveRenderContext({
        linkPresence: hostCapabilities.sessionConnectivity
          ? safeBool(() => port.isSessionConnected(sessionKey))
          : null,
        glassesPresence: cronEngine.getPresence(),
        backpressure: hostCapabilities.backpressureSignal
          ? safeBool(() => port.isUnderBackpressure())
          : null,
        agentTurnBusy: hostCapabilities.agentTurnBusy
          ? safeBool(() => port.isAgentTurnBusy(sessionKey))
          : null,
      });

      const deadLetterCount = surfaceStore.deadLetterEventCount(sessionKey);

      const errorChannelAvailable = hostCapabilities.clientCapabilityRead
        ? safeBool(() => port.relay.hasClientCapability("liveui-failure-events"))
        : null;
      const stage = surfaceStore.stageState(sessionKey, {
        graceMs: readStageConfig().stageGraceMs,
      });
      const topSurfaceId = surfaceStore.topSurfaceId(sessionKey);
      const stackIds = surfaceStore.stackSurfaceIds(sessionKey);
      const stack = stackIds
        .map((id) => surfaceStore.surfaceFactsFor(id))
        .filter((f) => f !== null);

      if (!topSurfaceId) {

        return projectUiStateChannels(
          emptyUiStateFacts(sessionKey, {
            storeId,
            snapshotAtMs: nowMs(),
            renderContext,
            readingProfile: deriveReadingProfile(null, null),
            hostCapabilities,
            stage,

            deadLetterCount,

            errorChannelAvailable,
          }),
        );
      }

      const facts = surfaceStore.surfaceFactsFor(topSurfaceId);
      const cron = cronEngine.snapshotOf(topSurfaceId);
      const deliveryState = readDeliveryState(topSurfaceId);

      const attempt = deliveryState && deliveryState.lastAttemptedSend;
      const receiptPresent =
        deliveryState && attempt
          ? surfaceStore.hasClientReceipt(deliveryState.surfaceUuid, attempt.seq)
          : false;

      return projectUiStateChannels({
        sessionKey,
        storeId,
        snapshotAtMs: nowMs(),
        activeSurfaceId: topSurfaceId,
        active: {
          surfaceUuid: facts.surfaceUuid,
          kind: facts.kind,
          title: facts.title,
          state: facts.state,
          terminationCause: facts.terminationCause,
          marker: displayedMarkerFor(topSurfaceId),
          queueMode: facts.queueMode,
          staleAfterMs: facts.staleAfterMs,
          content: facts.content,

          lastRender: cron.lastRender,
        },
        stage,
        stack,
        stackDepth: surfaceStore.stackDepth(sessionKey),
        breadcrumb: surfaceStore.breadcrumbFor(sessionKey),
        marker: displayedMarkerFor(topSurfaceId),
        pendingRender: facts.pendingRender,

        listening: facts.pendingRender,
        parkedEventCount: facts.parkedEventCount,
        deadLetterCount,
        cron,
        delivery: projectDelivery(deliveryState, receiptPresent),
        deliveryEvidence: deliveryState ? deliveryState.evidence : null,

        clientFailures: surfaceStore.clientFailuresOf(topSurfaceId),
        errorChannelAvailable,
        renderContext,
        readingProfile: deriveReadingProfile(facts.kind, null),
        hostCapabilities,
      });
    },
    publishCompanionSnapshot(rawSessionKey) {
      return publishCompanionSnapshotNow(rawSessionKey);
    },

    parkMarkerOnAgentEnd(sessionKey) {
      surfaceStore.clearAwaitingResponse(sessionKey);
      const top = surfaceStore.topSurfaceId(sessionKey);
      if (top) emitMarker(sessionKey, top);
    },
    refreshMarkerForAgentTurn(sessionKey) {
      const normalizedSessionKey = normalizeGlassesSessionKey(sessionKey);
      const top = surfaceStore.topSurfaceId(normalizedSessionKey);
      if (top && surfaceStore.markerFor(top) === "inflight") {
        emitMarker(normalizedSessionKey, top);
      }
    },
    sessionForSurface(surfaceId) {
      return surfaceStore.sessionForSurface(surfaceId);
    },
  };
  return publicApi;
}

const getGlassesUiStateParametersSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const GET_GLASSES_UI_STATE_TOOL_DESCRIPTION = [
  "Read the current state of the glasses HUD surface for this session. Read-only:",
  "it renders nothing, sends nothing, and never resolves a pending surface.",
  "",
  "Returns refs and counts, not the wearer's on-glass text. You get:",
  "  active        — surfaceUuid, kind, titleChars, state, marker, queueMode.",
  "  stack         — depth plus one ref per level (root first).",
  "  marker        — listening | inflight | processing | parked.",
  "  listening     — whether a render is still awaiting a wearer response.",
  "  parkedEventCount / deadLetterCount — wearer taps waiting to reach you.",
  "  cron          — { active, paused, ticks, lastRender } for a refreshing surface.",
  "  delivery      — the delivery-ladder rung actually earned, its honest phrase,",
  "                  lastAttemptedSend { seq, atMs, mode } and clientReceiptPresent.",
  "  renderContext — coarse link/backpressure/agent-turn enums (no wearer sensing).",
  "  readingProfile — the layout budgets governing the active kind, with provenance.",
  "  hostCapabilities — which host hooks exist, so you can tell 'not supported'",
  "                  apart from 'did not happen'.",
  "",
  "READ delivery.rung LITERALLY. `send_attempted` means the frame was handed to",
  "the transport and nothing has confirmed it — the honest phrase is 'attempted,",
  "unconfirmed'. `client_receipt` means the client reported painting that exact",
  "seq. Neither rung says a person looked at the HUD; only a wearer gesture is",
  "evidence of that, and it arrives as a tap, not as a state field.",
  "",
  "clientReceiptPresent: false is a normal answer, not an error. Do not retry a",
  "render because of it, and do not tell the user their glasses failed.",
  "",
  "The body and item text you rendered are NOT returned, on purpose. If you need",
  "to know what is on the HUD, you already authored it this turn or you should",
  "render again rather than read it back.",
].join("\n");

const GLASSES_UI_TOOL_DESCRIPTION = [
  "Paint a surface on the wearer's Even G2 HUD instead of, or beside, a text reply.",
  "",
  "RENDER when: they PICK from a set; a value they look at more than once; it",
  "changes by itself as it sits; it is visual - picture/glyph/card",
  "(template:\"image_caption\", body<=64, imageAsset|imageBase64); or one glanceable",
  "atom, hands or eyes committed - a 14-char surface to someone mid-task is a good",
  "render, not a small one.",
  "Moments nobody wrote down still count.",
  "CHAT when: they asked for prose in full. A named destination wins outright -",
  "\"just tell me\", \"put it on the glasses\"; a bare \"show me\" names nothing.",
  "MOMENT: attention free -> render richly, long is fine; hands busy -> one quiet",
  "sticky thing; on a person or driving -> wearer-initiated, only what they asked",
  "for.",
  "Not rendering is a move; so is rendering what you could have said - but",
  "under-rendering is the quiet mistake: they reach for their phone and you never",
  "hear about it.",
  "",
  "LAYOUT by what the wearer DOES, not content volume: they read it ->",
  "text_surface; they pick, label IS the answer -> list_surface; each row needs a",
  "reason -> list_with_details_surface (detail<=200); they mark a routine locally ->",
  "checklist_surface (queueMode:\"log\", tap stays local, double-tap sends all state);",
  "they page through one document -> paged_text_surface (1-10 pages, <=600 each;",
  "scroll stays local, tap sends the current page).",
  "Labels alone decide it -> list_surface; criteria that DISCRIMINATE between",
  "rows, or consequences differing materially per row -> details, each body the",
  "reason for THAT row in their terms. A question they answer by picking is never",
  "a text body: don't resolve it yourself and paint the answer.",
  "",
  "MOVE - choose one every render; omitting update means replace, which swaps the",
  "surface AND stops its cron. patch = same thing updated, ALWAYS after",
  "window_expired or back; push = a child they must back out of, never replace at",
  "depth>=2; replace = a different thing, no way back. One surface per outcome.",
  "",
  "result: selected|back|dismissed|window_expired|timeout|recipe_failed|",
  "glasses_disconnected. window_expired is NOT an error: taps park, patch to",
  "collect. timeoutMs default 90000; 300000-600000 to decide. refresh",
  "self-updates. HTTP refresh_host_consent_required holds for phone approval,",
  "then starts automatically; do not retry or ask again. back = revise: re-render",
  "or pivot; selected = follow up or ack.",
  "Authoring depth (tiers, recipes, {{path|filter}}, examples): load the",
  "\"glasses-ui\" skill.",
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

function getRegisteredLiveuiGlassesLibraryController(
  scopeHost = globalThis,
  options = {},
) {
  const shared = scopeHost && Reflect.get(scopeHost, HANDLER_SCOPE_SYMBOL);
  if (!shared || !shared.handler) return null;
  const depthBySession = getSharedDepthMap();
  return createLiveuiGlassesLibraryController({
    handler: shared.handler,
    depthBySession,
    normalizeSessionKey: normalizeGlassesSessionKey,
    taskRunController: options && options.taskRunController,
    resolveExecutorState: options && options.resolveExecutorState,
    nextDepth(rawSessionKey) {
      const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
      const next = (depthBySession.get(sessionKey) || 0) + 1;
      depthBySession.set(sessionKey, next);
      return next;
    },
  });
}

function registerGlassesUiTool(api, service, opts = {}) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerGlassesUiTool requires api.registerTool");
  }
  if (!service) {
    throw new Error("registerGlassesUiTool requires the OcuClaw relay service");
  }
  const injectedPaintFloorMs =
    opts && typeof opts === "object" ? Reflect.get(opts, "paintFloorMs") : undefined;
  const injectedTemplateLibraryDir =
    opts && typeof opts === "object" ? Reflect.get(opts, "templateLibraryDir") : undefined;
  const injectedLibraryDir =
    opts && typeof opts === "object" ? Reflect.get(opts, "libraryDir") : undefined;
  const injectedNow =
    opts && typeof opts === "object" ? Reflect.get(opts, "now") : undefined;
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
  let capturedOnGlassesUiRenderReceipt = null;
  let capturedOnGlassesUiClientFailure = null;
  let capturedOnGlassesPresenceChanged = null;
  const handler = createsHandler ? createGlassesUiToolHandler({
    relay: {
      sendGlassesUiRender: (msg) => service.sendGlassesUiRender(msg),
      sendGlassesUiSurfaceUpdate: (msg) => service.sendGlassesUiSurfaceUpdate(msg),
      onGlassesUiResult: (cb) => {
        capturedOnGlassesUiResult = cb;
        return service.onGlassesUiResult(cb);
      },

      onGlassesUiRenderReceipt:
        typeof service.onGlassesUiRenderReceipt === "function"
          ? (cb) => {
              capturedOnGlassesUiRenderReceipt = cb;
              return service.onGlassesUiRenderReceipt(cb);
            }
          : undefined,

      onGlassesUiClientFailure:
        typeof service.onGlassesUiClientFailure === "function"
          ? (cb) => {
              capturedOnGlassesUiClientFailure = cb;
              return service.onGlassesUiClientFailure(cb);
            }
          : undefined,
      hasClientCapability:
        typeof service.hasConnectedAppClientCapability === "function"
          ? (capability) => service.hasConnectedAppClientCapability(capability)
          : undefined,
      onGlassesPresenceChanged:
        typeof service.onGlassesPresenceChanged === "function"
          ? (cb) => {
              capturedOnGlassesPresenceChanged = cb;
              return service.onGlassesPresenceChanged(cb);
            }
          : undefined,
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
        const busy = typeof service.isAgentTurnBusy === "function"
          ? service.isAgentTurnBusy(sessionKey)
          : null;
        return typeof busy === "boolean" ? busy : null;
      } catch (_) {
        return null;
      }
    },
    publishCompanionSnapshot: (machine) =>
      writeCompanionSnapshot({
        stateDir:
          service && typeof service.getStateDir === "function"
            ? service.getStateDir()
            : undefined,
        backend: "openclaw",
        profile: "default",
        machine,
      }),
    templateLibraryDir:
      typeof injectedTemplateLibraryDir === "string" ? injectedTemplateLibraryDir : undefined,
    libraryDir: typeof injectedLibraryDir === "string" ? injectedLibraryDir : undefined,
    host: "openclaw",
    now: typeof injectedNow === "function" ? injectedNow : undefined,
    describeToolApprovalBehaviour: (executor) => {
      try {
        if (typeof service.describeToolApprovalBehaviour === "function") {
          const value = service.describeToolApprovalBehaviour(executor);
          if (typeof value === "string" && value.trim()) return value.trim();
        }
      } catch (_) {

      }
      return LIVEUI_TASK_UNKNOWN_APPROVAL_BEHAVIOUR;
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
    const onLogicalSessionReset = ({ sessionKey, reason }) => {
      if (!sessionKey) return;
      const normalizedSessionKey = normalizeGlassesSessionKey(sessionKey);
      const drained = handler.drainSession(normalizedSessionKey, {
        result: "session_reset",
        reason: reason || "logical_reset",
      });
      resetDepth(normalizedSessionKey);
      try {
        if (typeof service.emitGlassesUiLifecycle === "function") {
          service.emitGlassesUiLifecycle("session_reset_drain", "info", {
            sessionKey: normalizedSessionKey,
            reason: reason || "logical_reset",
            drained,
            storeId: handler.storeId,
          });
        }
      } catch (_) {

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
    const onAgentTurnChanged = ({ sessionKey }) => {
      if (sessionKey) handler.refreshMarkerForAgentTurn(sessionKey);
    };
    scopeRecord = {
      handler,
      refs: 0,
      relayCallbacks: {
        onGlassesUiResult: capturedOnGlassesUiResult,
        onGlassesUiRenderReceipt: capturedOnGlassesUiRenderReceipt,
        onGlassesUiClientFailure: capturedOnGlassesUiClientFailure,
        onGlassesPresenceChanged: capturedOnGlassesPresenceChanged,
        onAppClientDisconnect: onDisconnect,
        onLogicalSessionReset,
        onGlassesUiNavEvent: onNavEvent,
        onAgentTurnChanged,
      },
    };
    scopeHost[HANDLER_SCOPE_SYMBOL] = scopeRecord;
    if (typeof service.onAppClientDisconnect === "function") {
      service.onAppClientDisconnect(onDisconnect);
    }
    if (typeof service.onLogicalSessionReset === "function") {
      service.onLogicalSessionReset(onLogicalSessionReset);
    }
    if (typeof service.onGlassesUiNavEvent === "function") {
      service.onGlassesUiNavEvent(onNavEvent);
    }
    if (typeof service.onAgentTurnChanged === "function") {
      service.onAgentTurnChanged(onAgentTurnChanged);
    }
  } else if (scopeRecord && scopeRecord.relayCallbacks) {

    const callbacks = scopeRecord.relayCallbacks;
    if (callbacks.onGlassesUiResult) {
      service.onGlassesUiResult(callbacks.onGlassesUiResult);
    }
    if (callbacks.onGlassesUiRenderReceipt && typeof service.onGlassesUiRenderReceipt === "function") {
      service.onGlassesUiRenderReceipt(callbacks.onGlassesUiRenderReceipt);
    }
    if (callbacks.onGlassesUiClientFailure && typeof service.onGlassesUiClientFailure === "function") {
      service.onGlassesUiClientFailure(callbacks.onGlassesUiClientFailure);
    }
    if (callbacks.onGlassesPresenceChanged && typeof service.onGlassesPresenceChanged === "function") {
      service.onGlassesPresenceChanged(callbacks.onGlassesPresenceChanged);
    }
    if (callbacks.onAppClientDisconnect && typeof service.onAppClientDisconnect === "function") {
      service.onAppClientDisconnect(callbacks.onAppClientDisconnect);
    }
    if (callbacks.onLogicalSessionReset && typeof service.onLogicalSessionReset === "function") {
      service.onLogicalSessionReset(callbacks.onLogicalSessionReset);
    }
    if (callbacks.onGlassesUiNavEvent && typeof service.onGlassesUiNavEvent === "function") {
      service.onGlassesUiNavEvent(callbacks.onGlassesUiNavEvent);
    }
    if (callbacks.onAgentTurnChanged && typeof service.onAgentTurnChanged === "function") {
      service.onAgentTurnChanged(callbacks.onAgentTurnChanged);
    }
  }

  function liveuiSwitchedOff() {
    return isLiveuiSwitchedOff(handler);
  }

  function liveuiDisabledContent() {
    return { content: [{ type: "text", text: JSON.stringify(liveuiDisabledResult()) }] };
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
          if (liveuiSwitchedOff()) throw liveuiDisabledError();
          const resolvedSessionKey = normalizeGlassesSessionKey(factorySessionKey || "main");

          const validateOnly = Boolean(params && params.validateOnly === true);
          const depth = validateOnly ? 0 : nextDepth(resolvedSessionKey);
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
            if (!validateOnly) {
              const prev = depthBySession.get(resolvedSessionKey) || 0;
              depthBySession.set(resolvedSessionKey, Math.max(0, prev - 1));
            }
            throw err;
          }
        },
      };
    },
    { name: "render_glasses_ui" },
  );

  api.registerTool(
    (ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";

      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const factorySessionKey = sessionKey || null;
      return {
        name: "get_glasses_ui_state",
        description: GET_GLASSES_UI_STATE_TOOL_DESCRIPTION,
        parameters: getGlassesUiStateParametersSchema,
        async execute(_toolCallId, _params) {
          if (liveuiSwitchedOff()) return liveuiDisabledContent();
          const resolvedSessionKey = normalizeGlassesSessionKey(factorySessionKey || "main");
          const channels = handler.snapshotUiState(resolvedSessionKey);
          handler.publishCompanionSnapshot(resolvedSessionKey);

          try {
            if (typeof service.emitGlassesUiLifecycle === "function") {
              service.emitGlassesUiLifecycle("ui_state_snapshot", "debug", {
                sessionKey: resolvedSessionKey,
                ...channels.dev,
                machine: channels.machine,
              });
            }
          } catch (_) {

          }

          return {
            content: [{ type: "text", text: JSON.stringify(channels.model) }],
          };
        },
      };
    },
    { name: "get_glasses_ui_state" },
  );

  api.registerTool(
    (ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const factorySessionKey = sessionKey || null;
      return {
        name: LIVEUI_TEMPLATE_TOOL_NAME,
        description: LIVEUI_TEMPLATE_TOOL_DESCRIPTION,
        parameters: liveuiTemplateToolParametersSchema,
        async execute(_toolCallId, params, signal) {
          if (liveuiSwitchedOff()) return liveuiDisabledContent();
          const result = await dispatchLiveuiTemplateOperation(
            handler,
            params,
            async (template, values) => {
              const resolvedSessionKey = normalizeGlassesSessionKey(factorySessionKey || "main");
              return runLiveuiTemplateRenderLifecycle({
                template,
                values,
                sessionKey: resolvedSessionKey,
                signal,
                depthBySession,
                nextDepth,
                renderStoredTemplate: (renderInput) =>
                  handler.renderStoredTemplate(renderInput),
              });
            },
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    },
    { name: LIVEUI_TEMPLATE_TOOL_NAME },
  );

  api.registerTool(
    (ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const agentId = ctx && typeof ctx.agentId === "string" ? ctx.agentId : undefined;
      return {
        name: LIVEUI_TASK_TOOL_NAME,
        description: LIVEUI_TASK_TOOL_DESCRIPTION,
        parameters: liveuiTaskToolParametersSchema,
        async execute(_toolCallId, params) {
          if (liveuiSwitchedOff()) return liveuiDisabledContent();
          const result = await dispatchLiveuiTaskOperation({
            createTaskDraft: (input) => handler.createTaskDraft(input, { agentId }),
            updateTaskDraft: (input) => handler.updateTaskDraft(input, { agentId }),
            readTask: (taskId) => handler.readTask(taskId),
            listTasks: () => handler.listTasks(),
            findTasks: (query) => handler.findTasks(query),
            saveUiAsHelper: (input) => handler.saveUiAsHelper(input, {
              sessionKey,
              agentId,
            }),
          }, params);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    },
    { name: LIVEUI_TASK_TOOL_NAME },
  );

  if (typeof api.on === "function") {

    api.on("before_prompt_build", (_event, ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
      if (!sessionKey) return undefined;
      const parts = [];
      try {
        const fragment = handler.buildVoicemailInjection(sessionKey);
        if (fragment) parts.push(fragment);
      } catch (_) {

      }
      try {

        const feedback = handler.buildFeedbackInjection(sessionKey);
        if (feedback) parts.push(feedback);
      } catch (_) {

      }
      return parts.length ? { appendSystemContext: parts.join("\n\n") } : undefined;
    });

    api.on("agent_end", (event, ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;

      if (sessionKey) {
        const stackDepth = handler.surfaceStackDepth(sessionKey);
        const settledPending = handler.settleSession(sessionKey, { result: "aborted" });
        const releasedTerminalTop = handler.releaseTerminalTopOnAgentEnd(
          sessionKey,
          { result: "aborted", origin: "system" },
        );

        try {
          if (typeof service.emitGlassesUiLifecycle === "function") {
            service.emitGlassesUiLifecycle("agent_end_settle", "debug", {
              sessionKey: normalizeGlassesSessionKey(sessionKey),
              stackDepth,
              settledPending,
              settlement: settledPending > 0 ? "aborted" : null,
              releasedTerminalTop,
              storeId: handler.storeId,

              ...readAgentRunId(service, sessionKey, ctx, event),
            });
          }
        } catch (_) {

        }

        if (!releasedTerminalTop) handler.parkMarkerOnAgentEnd(sessionKey);
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

module.exports = { GLASSES_UI_LIMITS, GLASSES_UI_REFRESH_LIMITS, GLASSES_UI_WINDOW_LIMITS, GLASSES_UI_QUEUE_MODES, DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS, glassesUiParametersSchema, GLASSES_UI_TOOL_DESCRIPTION, GET_GLASSES_UI_STATE_TOOL_DESCRIPTION, getGlassesUiStateParametersSchema, GLASSES_UI_TOOL_LAYER_FIELDS, validateGlassesUiInjectSpec, validateGlassesUiSpec, validateRefreshSpec, resolveEffectiveHostCheck, summarizeLiveuiTemplateSpec, createPendingRenderMap, createSurfaceStore, createGlassesUiToolHandler, getRegisteredLiveuiGlassesLibraryController, registerGlassesUiTool, isEvenAiAgentSession };
