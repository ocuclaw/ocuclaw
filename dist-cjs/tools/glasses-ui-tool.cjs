const path = require("node:path");
const { clipBreadcrumb, mintPreloadedChildren } = require("./glasses-ui-children.cjs");
const { createLiveuiTemplateLibrary, createLiveuiGlassesLibraryController, dispatchLiveuiTemplateOperation, runLiveuiTemplateRenderLifecycle, LIVEUI_TEMPLATE_TOOL_DESCRIPTION, LIVEUI_TEMPLATE_LIBRARY_DIRNAME, LIVEUI_TEMPLATE_TOOL_NAME, liveuiTemplateToolParametersSchemaFor } = require("./glasses-ui-template-library.cjs");
const { liveuiTemplateValuesOwner, passiveTemplateValues } = require("./glasses-ui-template-values.cjs");
const { createLiveuiTaskLibrary, dispatchLiveuiTaskOperation, LIVEUI_TASK_TOOL_DESCRIPTION, LIVEUI_TASK_TOOL_NAME, LIVEUI_TASK_UNKNOWN_APPROVAL_BEHAVIOUR, liveuiTaskToolParametersSchema, projectTaskForApproval } = require("./glasses-ui-task-library.cjs");
const { createProgramCardFeedStore, programCardLinkFromAgent, programCardLook, programCardProposalBoundTo } = require("./glasses-ui-program-card-feed.cjs");
const { createLiveuiLibraryOrganization, findLiveuiVisibleNameClash, isLiveuiLibraryItemVisible, rejectLiveuiVisibleNameClash } = require("./glasses-ui-library-organization.cjs");
const { liveuiLibraryItemKey, orderLiveuiLibraryItems } = require("./glasses-ui-library.cjs");
const { createLiveuiTaskDeletionHookRegistry, findLiveuiTasksReferencingTemplate } = require("./glasses-ui-task-deletion-hooks.cjs");
const { createLiveuiTaskRunRecordStore } = require("./glasses-ui-task-run-records.cjs");
const { createLiveuiTaskScheduler } = require("./glasses-ui-task-schedule.cjs");
const { createLiveuiTaskVoice } = require("./glasses-ui-task-voice.cjs");
const { createLiveuiTaskSheet } = require("./glasses-ui-task-sheet.cjs");
const { createLiveuiTaskPage } = require("./glasses-ui-task-page.cjs");
const { validateTemplate } = require("./glasses-ui-template.cjs");
const { fillLiveuiTemplate } = require("./glasses-ui-template-slots.cjs");
const { createGlassesUiCronEngine } = require("./glasses-ui-cron.cjs");
const { createOpenClawLiveUiAuth } = require("./glasses-ui-openclaw-auth.cjs");
const { createProgramCardFeeds, PROGRAM_CARD_FEED_LIMITS } = require("./glasses-ui-program-card-feeds.cjs");
const { COMPOSE_FIRST_TICK_CAP_MS, COMPOSE_GLASSES_UI_TOOL_DESCRIPTION, COMPOSE_GLASSES_UI_TOOL_NAME, checkComposedRefreshTargets, composeGlassesUi, composedFirstTickWiringFault, composeGlassesUiParametersSchema } = require("./glasses-ui-compose-tool.cjs");
const { validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");
const { fillStoredSurface, storedSurfaceRecords } = require("./liveui-compiler/stored-surface.cjs");
const { isLiveuiTemplateComposed, templateExampleSummary } = require("./glasses-ui-template-v2.cjs");
const { createLiveuiPrefs, defaultLiveuiPrefsInput, isLiveuiSwitchedOff, liveuiDisabledError, liveuiDisabledResult } = require("./glasses-ui-prefs.cjs");
const { createLiveuiGrantsStore, normalizeGrantHost } = require("./glasses-ui-grants.cjs");
const { executeHttpRecipe, executeLlmRecipe, executeSystemStatsRecipe, normalizeHttpAllowHosts, isHttpHostAllowed } = require("./glasses-ui-recipes.cjs");
const { createPendingRenderMap, createSurfaceStore, isTerminalOutcome, normalizeGlassesSessionKey, RENDER_DROP_CODES } = require("./glasses-ui-surfaces.cjs");

const { deliveryLadderState } = require("./glasses-ui-delivery-ladder.cjs");
const { createGlassesWakeController, readAgentRunId } = require("./glasses-ui-wake.cjs");
const { createGlassesVoicemail } = require("./glasses-ui-voicemail.cjs");
const { createGlassesFeedbackLedger } = require("./glasses-ui-feedback-ledger.cjs");
const { applyFieldPatchToSpec, createPaintFloorCoalescer, DEFAULT_PAINT_FLOOR_MS } = require("./glasses-ui-paint-floor.cjs");
const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { validateItemsFromPath } = require("./glasses-ui-array-mapping.cjs");
const { refreshSchemaForToolParams } = require("./glasses-ui-refresh-schema.cjs");
const { lintGlassesUiPlan, projectValidateOnlyChannels } = require("./glasses-ui-plan-lint.cjs");

const { attachLiveUiV2Read, buildHostCapabilityManifest, deriveReadingProfile, deriveRenderContext, emptyUiStateFacts, projectDelivery, projectUiStateChannels } = require("./glasses-ui-state-snapshot.cjs");
const { writeCompanionSnapshot } = require("./glasses-ui-companion-snapshot.cjs");
const { getKindDescriptor, listKindStrings, buildOneOfBranches, GLASSES_UI_CHILDREN_SCHEMA, GLASSES_UI_GRAPHIC_SCHEMA, GLASSES_UI_DURATION_PICKER_SCHEMA } = require("./glasses-ui-descriptors.cjs");
const { DEFAULT_STAGE_GRACE_MS } = require("./glasses-ui-limits.cjs");
const { checkGlassesUiFit } = require("./glasses-ui-fit.cjs");
const { GLASSES_UI_REPAIR_MAX_PASSES, repairGlassesUiRefusal } = require("./glasses-ui-repair.cjs");

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

function resolveEffectiveHostCheck(cfgInput     , grantsStore     ) {
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
  return (hostname     ) => {
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
  surfaceKind      = undefined,
  options      = {},
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
  const sanitizedTargets      = {};
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
    const pathValidation      = validateItemsFromPath(targets.itemsFromPath);
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
        targets.path.split(".").some((segment     ) =>
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
        message: `the wearer allows a new http recipe host on the glasses first: ${httpHost}`,
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

function validateQueueMode(spec     )      {
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
      enum: ["image_caption", "graphic", "graphic_v2", "duration_picker"],
      description:
        "Optional text_surface template. image_caption places one centered image above body, " +
        "which remains the caption and the fallback on 2.0.0 clients. An optional title uses the shared heading. " +
        "graphic draws graphic.slots above body (1-64 char caption, no title, no refresh). " +
        "graphic_v2 supports a full-width timeline or comparison. duration_picker is a list_surface local minute editor with durationPicker and matching items.",
    },
    graphic: GLASSES_UI_GRAPHIC_SCHEMA,
    durationPicker: GLASSES_UI_DURATION_PICKER_SCHEMA,
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

const { oneOf: _perKindBranches, ...glassesUiFlatSchemaFields } = glassesUiParametersSchema;
const glassesUiFlatParametersSchema = glassesUiFlatSchemaFields;

function glassesUiParametersSchemaFor(mode     ) {
  return mode === "full" ? glassesUiParametersSchema : glassesUiFlatParametersSchema;
}

function tokenEfficiencyOf(service     ) {
  try {
    const cfg      = service.getRuntimeConfig?.();
    return (cfg && cfg.tokenEfficiency) || {};
  } catch (_err) {
    return {};
  }
}

function validateGlassesUiSpec(input) {
  const repairs      = [];
  let obj = input;
  let result      = validateGlassesUiSpecOnce(obj);
  for (let pass = 0; result.ok !== true && pass < GLASSES_UI_REPAIR_MAX_PASSES; pass += 1) {
    const repaired      = repairGlassesUiRefusal(obj, result);
    if (!repaired) break;

    if (JSON.stringify(repaired.spec) === JSON.stringify(obj)) break;
    repairs.push(repaired.repair);
    obj = repaired.spec;
    result = validateGlassesUiSpecOnce(obj);
  }
  if (result.ok !== true || repairs.length === 0) return result;
  const own = Array.isArray(result.repairs) ? result.repairs : [];
  return { ...result, repairs: [...own, ...repairs] };
}

function validateGlassesUiSpecOnce(input     ) {
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

  const descriptorAny      = descriptor;
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

function pickToolLayerFields(spec     ) {
  const picked      = {};
  if (!spec || typeof spec !== "object") return picked;
  for (const field of GLASSES_UI_TOOL_LAYER_FIELDS) {
    if (spec[field] !== undefined) picked[field] = spec[field];
  }
  return picked;
}

function validateRenderControlFields(input     ) {
  const spec = input && typeof input === "object" ? input : {};
  if (spec.update !== undefined && !["patch", "replace", "push"].includes(spec.update)) {
    return { ok: false, code: "update_invalid", message: "update must be patch, replace, or push" };
  }
  if (spec.validateOnly !== undefined && typeof spec.validateOnly !== "boolean") {
    return { ok: false, code: "validate_only_invalid", message: "validateOnly must be boolean" };
  }
  return { ok: true };
}

function validateGlassesUiInjectSpec(input     , glassesUiLiveCfg      = undefined, options      = {}) {
  const validation      = validateGlassesUiSpec(input);
  if (!validation.ok) return validation;

  if (input.refresh !== undefined) {
    const hasRuntimePolicy = glassesUiLiveCfg && typeof glassesUiLiveCfg === "object";
    let refreshValidation     ;
    if (hasRuntimePolicy) {

      refreshValidation = validateRefreshSpec(input.refresh, glassesUiLiveCfg, input.kind, {
        hostCheck: typeof options.hostCheck === "function" ? options.hostCheck : undefined,
      });
    } else {

      refreshValidation = validateRefreshSpec(input.refresh, {}, input.kind, { shapeOnly: true });
    }
    if (!refreshValidation.ok) return refreshValidation;
  }

  const windowValidation      = validateWindowFields(input);
  if (!windowValidation.ok) return windowValidation;
  const queueValidation      = validateQueueMode(input);
  if (!queueValidation.ok) return queueValidation;
  const controlValidation      = validateRenderControlFields(input);
  if (!controlValidation.ok) return controlValidation;

  const spec = { ...validation.spec };
  for (const key of GLASSES_UI_TOOL_LAYER_FIELDS) {
    if (Object.hasOwn(input, key)) spec[key] = input[key];
  }

  const validationAny      = validation;
  const injectRepairs      = validationAny.repairs;
  return Array.isArray(injectRepairs) && injectRepairs.length > 0
    ? { ok: true, spec, repairs: injectRepairs.map((repair     ) => ({ ...repair })) }
    : { ok: true, spec };
}

const { randomUUID } = require("node:crypto");
const { createTaskOpenUpdateStore } = require("./glasses-ui-task-open-update.cjs");
const { createTaskUsesStore } = require("./glasses-ui-task-uses.cjs");
const { createTaskFitStore } = require("./glasses-ui-task-fit-records.cjs");
const { createTaskRunsWeekStore } = require("./glasses-ui-task-runs-week.cjs");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, EVEN_AI_THROWAWAY_SESSION_PREFIX, isHermesEvenAiSessionKey } = require("../domain/even-ai-session-keys.cjs");
const { appendLiveuiContextFenceToUserMessage, buildLiveuiContextFence, openClawStoresFenceFromWriteHook } = require("./glasses-ui-context-fence.cjs");

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

function summarizeLiveuiTemplateSpec(spec     , slots      = undefined) {
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
    ? slots.map((slot     ) => slot && slot.key).filter((key     ) => typeof key === "string")
    : [];
  const suffix = slotKeys.length > 0 ? ` · Slots: ${slotKeys.join(", ")}` : "";
  return `${surfaceKind} · Fields: ${fields.length > 0 ? fields.join(", ") : "none"}${suffix}`.slice(0, 200);
}

const WINDOW_EXPIRED_HINT =
  "The listen window closed; the surface is still live on glass and keeps " +
  "updating. New taps park - re-render this surface (e.g. update:\"patch\") " +
  "to collect them in this run, or end your turn and they ride the next one.";

const SHOWN_CLOSE_HINT =
  "Finish your turn now with one short line about the content. Don't report " +
  "the delivery or quote the delivery rung.";
const SHOWN_CONFIRMED_HINT =
  "The glasses confirmed this surface is showing. It stays live; the wearer's " +
  "taps arrive as a new message. " + SHOWN_CLOSE_HINT;
const SHOWN_UNCONFIRMED_HINT =
  "This surface was sent to the glasses and stays live; the client has not " +
  "confirmed the paint yet. The wearer's taps arrive as a new message. " +
  SHOWN_CLOSE_HINT;

const SETTLE_ON_DELIVERY_CAP_MS = 5_000;

function isCodeModeNestedToolCallId(toolCallId     ) {
  return typeof toolCallId === "string" && toolCallId.startsWith("exec-");
}

function createGlassesUiToolHandler(deps                ) {
  let publicApi      = null;
  let templateLibrary      = null;
  let taskLibrary      = null;
  let taskRunRecordStore      = null;
  let taskScheduler      = null;
  let libraryOrganization      = null;
  const injectedLibraryRoot = () =>
    typeof deps.libraryDir === "string" && deps.libraryDir.trim()
      ? deps.libraryDir
      : typeof deps.templateLibraryDir === "string" && deps.templateLibraryDir.trim()
        ? path.dirname(deps.templateLibraryDir)
        : undefined;

  let liveuiPrefsStore      = null;
  let liveuiGrantsStore      = null;
  let cachedLiveuiPrefs      = null;
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
  function currentHostCheck(cfg     ) {
    return resolveEffectiveHostCheck(
      cfg,
      cfg && cfg.httpHostPolicy === "owner-grants" ? getLiveuiGrantsStore() : null,
    );
  }

  function programCardHostCheck(cfg     , block     , sites     ) {
    const check = currentHostCheck(cfg);
    if (sites !== "ask" && sites !== "off") return check;
    const off = Array.isArray(block) ? block : [];
    return (hostname     ) => {
      const decision = check(hostname);
      if (decision !== "listed" && decision !== "consent") return decision;
      if (sites === "off" || off.includes(String(hostname).toLowerCase())) return "not_allowed";
      return decision;
    };
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

  async function executeRefreshRecipe(recipe     , ctx      )               {
    if (recipe.kind === "http") {
      const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
      return executeHttpRecipe(recipe, {
        hostCheck: currentHostCheck(cfg),
        ...(typeof deps.httpRecipeFetch === "function" ? { fetch: deps.httpRecipeFetch } : {}),
      });
    }
    if (recipe.kind === "system-stats") return executeSystemStatsRecipe(recipe);
    if (recipe.kind === "llm" && typeof deps.executeLlmRecipe === "function") {
      return deps.executeLlmRecipe(recipe, ctx);
    }
    if (recipe.kind === "llm") return executeLlmRecipe(recipe, ctx);
    return { error: `unknown recipe kind: ${recipe.kind}` };
  }
  const refreshPreparations = new Set     ();
  async function prepareComposedRefresh(params     )               {
    if (params?.refresh?.recipe?.kind !== "llm" || typeof deps.prewarmLlmApiKey !== "function") return { ok: true };
    const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
    if (cfg.llmDisabledReason === "no_backend") return { ok: false, code: "refresh_route_unsupported", message: "Standard HTTP refresh has no backend for this model provider. Native Codex turns are separate; no refresh was started." };
    const { targets: _targets, ...fields } = params.refresh;
    const checked      = validateRefreshSpec(fields, cfg, undefined, { hostCheck: currentHostCheck(cfg) });
    if (!checked.ok) return checked;
    const recipe = checked.refresh.recipe;
    const modelRef = cfg.allowAgentModelOverride === true && typeof recipe.model === "string" && recipe.model.trim() ? recipe.model.trim() : cfg.tickModel || "";
    const controller = new AbortController();
    const sessionKey = normalizeGlassesSessionKey(params.sessionKey);
    const entry = { sessionKey, controller };
    const abort = () => controller.abort();
    params.signal?.addEventListener("abort", abort, { once: true });
    if (params.signal?.aborted) controller.abort();
    refreshPreparations.add(entry);
    const release = () => {
      refreshPreparations.delete(entry);
      params.signal?.removeEventListener("abort", abort);
    };
    let handedOff = false;
    try {
      const prepared      = await deps.prewarmLlmApiKey(modelRef, { backend: cfg.tickBackend, baseUrl: cfg.tickApiBaseUrl, sessionKey: params.sessionKey, signal: controller.signal });
      if (controller.signal.aborted) return { ok: false, code: "refresh_cancelled", message: "Refresh preparation was cancelled; no refresh was started." };
      if (prepared?.ok === false) return prepared;
      handedOff = true;
      return { ok: true, isCurrent: () => !controller.signal.aborted, release };
    } finally {
      if (!handedOff) release();
    }
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
  function visibleNameClash(itemType     , itemId     , name     , options      = {}) {
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
        validateSpec(spec     ) {
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
        findVisibleNameClash(taskId     , name     ) {
          return visibleNameClash("task", taskId, name);
        },
        rejectNameClash: rejectLiveuiVisibleNameClash,
        removeOrganizationEntry(itemType     , itemId     ) {
          return getLibraryOrganization().removeLibraryItem(itemType, itemId);
        },
        resolveTemplateHint(templateId     ) {
          return resolvePreferredTemplateHint(templateId);
        },
        currentSurfaceSpecForSession(sessionKey     ) {
          return surfaceStore.currentSurfaceSpecForSession(sessionKey);
        },
        currentComposedSurfaceForSession(sessionKey     ) {
          return composedTopSurface(sessionKey);
        },
        saveHelperTemplate(template     , helperOf     , selfCheckValues     ) {
          return getTemplateLibrary().save(template, {
            ifAbsent: true,
            helperOf,

            ...(selfCheckValues === undefined ? {} : { selfCheckValues }),
          });
        },
        hideHelperTemplate(templateId     ) {
          return getLibraryOrganization().hideLibraryItemForHelper(
            liveuiLibraryItemKey("template", templateId),
          );
        },
        rollbackHelperTemplate(templateId     , digest     ) {
          getLibraryOrganization().removeLibraryItem("template", templateId);
          return getTemplateLibrary().delete(templateId, { expectedDigest: digest });
        },
        deletionHooks: createLiveuiTaskDeletionHookRegistry({
          runRecordsOnTaskDeleted(taskId     ) {

            createTaskOpenUpdateStore({ libraryDir: injectedLibraryRoot() }).clear(taskId);

            createTaskUsesStore({ libraryDir: injectedLibraryRoot() }).clear(taskId);

            createTaskFitStore({ libraryDir: injectedLibraryRoot() }).clear(taskId);

            createTaskRunsWeekStore({ libraryDir: injectedLibraryRoot() }).clear(taskId);
            return getTaskRunRecordStore().deleteForTask(taskId);
          },
          readTemplate(templateId     ) {
            return getTemplateLibrary().read(templateId);
          },
          loadOrganization() {
            return currentOrganization();
          },
          taskLibrary() {
            return getTaskLibrary();
          },
          deleteHelperTemplate(templateId     , digest     ) {
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
  function describeTaskApprovalBehaviour(task     ) {
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
  function projectTask(task     , row      = null) {
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

  function displayedMarkerFor(surfaceId     ) {
    const marker = surfaceStore.markerFor(surfaceId);
    if (marker !== "inflight") {
      const refresh = cronEngine.snapshotOf(surfaceId);
      if (marker && refresh.active && !refresh.paused && refresh.presence?.tier === "http" &&
          refresh.presence.policy === "active" &&
          !["absent", "in_case"].includes(refresh.presence.state)) return "refreshing";
      return marker;
    }
    const sessionKey = surfaceStore.sessionForSurface(surfaceId);
    if (!sessionKey || typeof deps.isAgentTurnBusy !== "function") return marker;
    try {
      return deps.isAgentTurnBusy(sessionKey) ? "processing" : marker;
    } catch (_) {
      return marker;
    }
  }

  function renderOriginOf(value     ) {
    return value === "agent" || value === "task" ? value : undefined;
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

  const lastWireRenderBySurface      = new Map();
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

        lastWireRenderBySurface.set(surfaceId, {
          depth: patch.__depth, spec: patch.__spec, origin: patch.__origin, live: patch.__live, phoneSpec: patch.__spec,
        });
        if (lastWireRenderBySurface.size > 32) pruneLastWireRenders();
        emitLifecycle("render_sent", "debug", { surfaceId, sessionKey, seq });
        deps.relay.sendGlassesUiRender({
          sessionKey, surfaceId, seq, depth: patch.__depth, spec: patch.__spec, marker: patch.__marker, origin: patch.__origin,
          collect: patch.__collect, live: patch.__live,
        });
      } else {
        const wire      = lastWireRenderBySurface.get(surfaceId);
        if (wire) wire.phoneSpec = applyFieldPatchToSpec(wire.phoneSpec, patch);

        if (patch.__recordedSpec && typeof patch.__recordedSpec === "object") {
          surfaceStore.recordSpec(surfaceId, patch.__recordedSpec);
          if (wire) wire.spec = applyFieldPatchToSpec(wire.spec, patch);
        }
        const wirePatch      = {};
        for (const key of Object.keys(patch || {})) if (!key.startsWith("__")) wirePatch[key] = patch[key];
        deps.relay.sendGlassesUiSurfaceUpdate({ sessionKey, surfaceId, seq, patch: wirePatch });
      }
      scheduleCompanionSnapshot({ surfaceId, sessionKey });
    },
    isUnderBackpressure: typeof deps.isUnderBackpressure === "function" ? deps.isUnderBackpressure : () => false,
  });

  const cronEngine = createGlassesUiCronEngine({
    emitLifecycle,
    onStateChanged: emitMarker,

    writeSurfaceData: (sessionKey     , surfaceId     , patch     ) =>
      typeof deps.relay.writeLiveUiV2Data === "function"
        ? deps.relay.writeLiveUiV2Data(sessionKey, surfaceId, patch)
        : null,

    prefetchSurfacePicture: (sessionKey     , surfaceId     , src     , key     ) =>
      typeof deps.relay.prefetchLiveUiV2Picture === "function"
        ? deps.relay.prefetchLiveUiV2Picture(sessionKey, surfaceId, src, key)
        : Promise.resolve({ ok: true }),
    isSurfaceLive: (sessionKey     , surfaceId     ) =>
      typeof deps.relay.isLiveUiV2SurfaceLive === "function"
        ? deps.relay.isLiveUiV2SurfaceLive(sessionKey, surfaceId) === true
        : false,

    isRefreshPaused: liveuiRefreshPaused,
    monotonicNowMs: () => performance.now(),
    executeRecipe: executeRefreshRecipe,
    glassesUiLimits: GLASSES_UI_LIMITS,
    validateTemplateSpec: ({ spec, sessionKey }     ) => {
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
    sendSurfaceUpdate: (params     ) => paintFloor.enqueue({ surfaceId: params.surfaceId, sessionKey: params.sessionKey, patch: params.patch }),
    sendSurfaceRender: (params     ) => paintFloor.enqueue({
      surfaceId: params.surfaceId,
      sessionKey: params.sessionKey,
      patch: {
        __render: true,
        __depth: params.depth,
        __spec: params.spec,
        __recordedSpec: params.spec,
        __marker: displayedMarkerFor(params.surfaceId),

        __origin: "cron",
        __live: true,
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
        sessionKey: state.sessionKey,
      };
    },
  });

  const programCardFeeds = createProgramCardFeeds({
    emitLifecycle,
    executeRecipe: (recipe     , block     , sites     ) => {
      if (recipe.kind !== "http") return executeRefreshRecipe(recipe);
      const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
      return executeHttpRecipe(recipe, {
        hostCheck: programCardHostCheck(cfg, block, sites),
        ...(typeof deps.httpRecipeFetch === "function" ? { fetch: deps.httpRecipeFetch } : {}),
      });
    },
    isPaused: liveuiRefreshPaused,
    send: (frame     ) => {
      if (typeof deps.relay.sendProgramCardData === "function") deps.relay.sendProgramCardData(frame);
    },
    validate: (feed     , block     , sites     ) => {
      if (feed.kind === "http" && sites === "off") return { ok: false, message: "sites are off in LiveUI Settings" };
      if (feed.kind === "http" && sites === "ask") {
        let host = "";
        try { host = new URL(feed.url).hostname.toLowerCase(); } catch (_) {}
        if (host && Array.isArray(block) && block.includes(host)) return { ok: false, message: `${host} is off for this card` };
      }
      const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : {};
      const recipe = feed.kind === "http"
        ? { kind: "http", url: feed.url, timeoutMs: PROGRAM_CARD_FEED_LIMITS.httpTimeoutMs, ...(feed.path ? { jsonPath: feed.path } : {}) }
        : { kind: feed.kind };
      const v      = validateRefreshSpec({ recipe, intervalMs: feed.every * 1000 }, cfg, undefined, {
        hostCheck: programCardHostCheck(cfg, block, sites),
      });
      if (v.ok) return { ok: true, recipe: v.refresh.recipe };
      if (v.code === "refresh_host_consent_required" && sites === "ask") {

        return { ok: false, message: `allow ${v.host} on the glasses`, site: v.host };
      }
      if (v.code === "refresh_host_consent_required") {

        askLiveuiSite(v.host, null, "card");
        return { ok: false, message: `allow ${v.host} on the glasses` };
      }

      return { ok: false, message: v.message || v.code, code: v.code };
    },
  });

  if (typeof deps.relay.onGlassesPresenceChanged === "function") {
    deps.relay.onGlassesPresenceChanged((msg     ) => {
      cronEngine.setPresence(msg && msg.presence);
      programCardFeeds.setPresence(msg && msg.presence);
    });
  }
  if (typeof deps.relay.onProgramCardFeeds === "function") {
    deps.relay.onProgramCardFeeds((msg     ) => programCardFeeds.handle(msg));
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

  function companionTargetSession(rawSessionKey     , data      = {}) {
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

  function publishCompanionSnapshotNow(rawSessionKey     ) {
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

  function scheduleCompanionSnapshot(data      = {}) {
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

    isTapOwed: (sessionKey        , eventId        ) => {
      if (typeof deps.relay.isLiveUiV2TapOwed !== "function") return null;
      try {
        const owed = deps.relay.isLiveUiV2TapOwed(sessionKey, eventId);
        return typeof owed === "boolean" ? owed : null;
      } catch (_) {
        return null;
      }
    },
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

  const receiptWaitersBySurface      = new Map();
  if (typeof deps.relay.onGlassesUiRenderReceipt === "function") {
    deps.relay.onGlassesUiRenderReceipt((msg     ) => {
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

      const waiters = receiptWaitersBySurface.get(msg.surfaceId);
      if (waiters) {
        for (const waiter of [...waiters]) {
          try { waiter(); } catch (_) {  }
        }
      }
    });
  }

  function handleClientRenderDrop(msg     ) {
    const sessionKey = surfaceStore.sessionForSurface(msg.surfaceId);
    const reportedSessionKey = normalizeGlassesSessionKey(msg.sessionKey);
    const activeSessionKey = normalizeGlassesSessionKey(msg.activeSessionKey);

    const hold = (reason     ) => {
      emitLifecycle("render_drop_held", "debug", {
        surfaceId: msg.surfaceId, sessionKey, seq: msg.seq,
        clientId: msg.clientId, code: msg.code, reason,
        reportedSessionKey: reportedSessionKey || null,
        activeSessionKey: activeSessionKey || null,
      });
    };
    const verdict = surfaceStore.validateClientRenderDrop(msg.surfaceId, msg);
    if (!verdict.ok) return hold(verdict.reason);
    if (!sessionKey) return hold("unknown_surface");
    if (reportedSessionKey && reportedSessionKey !== sessionKey) return hold("render_session_moved");
    if (activeSessionKey && activeSessionKey === sessionKey) return hold("client_on_this_session");

    const outcome = { result: "preempted", origin: "system", reason: "session_not_viewed" };
    const released = releaseSurfaceTerminally(msg.surfaceId, outcome, null, "client_render_drop");
    emitLifecycle("client_render_drop_release", "info", {
      surfaceId: msg.surfaceId, sessionKey, seq: msg.seq,
      clientId: msg.clientId, code: msg.code,
      activeSessionKey: activeSessionKey || null, released,
    });
  }

  if (typeof deps.relay.onGlassesUiClientFailure === "function") {
    deps.relay.onGlassesUiClientFailure((msg     ) => {
      if (!msg || typeof msg.surfaceId !== "string" || !msg.surfaceId) return;
      if (RENDER_DROP_CODES.includes(msg.code)) {
        handleClientRenderDrop(msg);
        return;
      }
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
        capturedCronOutcome.set(msg.surfaceId, (cronOutcome     ) => { merged = cronOutcome; });
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

  if (typeof deps.relay.onLiveUiV2Outcome === "function") {
    deps.relay.onLiveUiV2Outcome((msg     ) => {
      if (!msg || typeof msg.surfaceId !== "string" || typeof msg.sessionKey !== "string") return;
      wakeController.onParkedGesture({
        sessionKey: msg.sessionKey,
        surfaceUuid: msg.surfaceId,
        eventId: msg.eventId,
        result: msg.result,
        itemIndex: msg.selectedIndex,
        origin: "gesture",
        queuedAtMs: msg.queuedAtMs,
        liveuiV2: true,
        ...(typeof msg.action === "string" ? { action: msg.action } : {}),
        ...(typeof msg.row === "string" ? { row: msg.row } : {}),
      });
    });
  }

  function validateStaticPlan(spec     , opts      = {}) {
    const errors = [];
    const push = (result     ) => {
      if (result && result.ok === false) {
        errors.push({
          code: result.code || "invalid_spec",
          message: result.message || "spec validation failed",
        });
        return false;
      }
      return true;
    };
    const validation      = validateGlassesUiSpec(spec);
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
    let refreshValidation      = null;
    if (spec && spec.refresh !== undefined) {
      const glassesUiLiveCfg = deps.getGlassesUiLiveConfig
        ? deps.getGlassesUiLiveConfig()
        : { enabled: true };
      refreshValidation = validateRefreshSpec(spec.refresh, glassesUiLiveCfg, spec.kind, {
        hostCheck: currentHostCheck(glassesUiLiveCfg),
      });
      push(refreshValidation);
    }
    const windowValidation      = validateWindowFields(spec);
    const queueValidation      = validateQueueMode(spec);
    const controlValidation      = validateRenderControlFields(spec);
    push(windowValidation);
    push(queueValidation);
    push(controlValidation);

    const specValidated = Boolean(validation && validation.ok);

    const lintInput = specValidated && Array.isArray(validation.repairs) && validation.repairs.length > 0
      ? { ...pickToolLayerFields(spec), ...validation.spec }
      : spec;
    const lint = specValidated
      ? lintGlassesUiPlan(lintInput, {
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
    let normalizedSpec      = null;
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

    const dryRunValidation      = validation;
    if (dryRunValidation && dryRunValidation.ok && Array.isArray(dryRunValidation.repairs) &&
        dryRunValidation.repairs.length > 0) {
      const modelChannel      = channels.model;
      modelChannel.repairs = dryRunValidation.repairs.map((repair     ) => ({ ...repair }));
    }

    emitLifecycle("render_validate_only", "debug", {
      surfaceId: null,
      sessionKey,
      ...channels.dev,

      machine: channels.machine,
    });
    return channels.model;
  }

  function recordRenderRefusal(params     , code     ) {
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

  const liveuiGrantsListeners      = new Set();

  const liveuiTasksListeners      = new Set();
  function notifyLiveuiTasksChanged() {
    for (const listener of [...liveuiTasksListeners]) {
      try { listener(); } catch (_) {  }
    }
  }
  function notifyLiveuiGrantsChanged() {
    for (const listener of liveuiGrantsListeners) {
      try {
        listener();
      } catch (_) {

      }
    }
  }
  function mayAskForSite(params     ) {
    return !!params && params.spec && params.spec.validateOnly !== true;
  }
  function discardHeldConsentRenders(host     ) {
    for (const [key, held] of heldConsentRenders) {
      if (held.host === host) heldConsentRenders.delete(key);
    }
  }
  function holdConsentRender(host     , params     , validation     , refresh     ) {

    discardHeldConsentRenders(host);
    while (heldConsentRenders.size >= 5) {
      heldConsentRenders.delete(heldConsentRenders.keys().next().value);
    }
    const heldSpec      = {
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
        requireViewedSession: params.requireViewedSession === true,

        origin: "task",
      },
    });
  }
  function startHeldConsentRenders(host     ) {
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

  const composedRefreshJobs = new Map();
  const heldComposedRefreshes = new Map();
  let composedRefreshToken = 0;
  const composedJobKey = (surfaceId     ) => `v2:${surfaceId}`;

  function httpHostOf(recipe     ) {
    if (!recipe || recipe.kind !== "http") return "";
    try {
      return new URL(recipe.url).hostname;
    } catch (_) {
      return "";
    }
  }

  function validateComposedRefresh(params     ) {
    const refresh = params && params.refresh;
    if (!refresh || typeof refresh !== "object" || Array.isArray(refresh)) {
      return { ok: false, code: "refresh_invalid_recipe", message: "refresh must be an object" };
    }
    const checkedInputs      = validateLiveUiInputs(params.inputs);
    if (!checkedInputs.ok) return checkedInputs;
    const checkedTargets      = checkComposedRefreshTargets(refresh, checkedInputs.inputs);
    if (!checkedTargets.ok) return checkedTargets;
    const { targets: _v2Targets, inputs: _nestedInputs, ...v1Fields } = refresh;
    const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : { enabled: true };
    const v      = validateRefreshSpec(v1Fields, cfg, undefined, { hostCheck: currentHostCheck(cfg) });
    const withTargets = (sanitized     ) => (sanitized ? { ...sanitized, targets: checkedTargets.targets } : sanitized);
    if (!v.ok) {
      return {
        ok: false,
        code: v.code,
        message: v.message,
        ...(v.host ? { host: v.host } : {}),
        ...(v.refresh ? { refresh: withTargets(v.refresh) } : {}),
        inputs: checkedInputs.inputs,
      };
    }
    return { ok: true, refresh: withTargets(v.refresh), inputs: checkedInputs.inputs };
  }

  async function probeComposedRefresh(params     )               {
    const refresh = params && params.refresh;
    if (!refresh || typeof refresh !== "object" || Array.isArray(refresh)) {
      return { status: "skipped", reason: "no_refresh" };
    }
    if (liveuiRefreshPaused()) return { status: "skipped", reason: "paused" };
    const { targets: _v2Targets, inputs: _nestedInputs, ...v1Fields } = refresh;
    const cfg = deps.getGlassesUiLiveConfig ? deps.getGlassesUiLiveConfig() : { enabled: true };
    const v      = validateRefreshSpec(v1Fields, cfg, undefined, { hostCheck: currentHostCheck(cfg) });
    if (!v.ok || !v.refresh || !v.refresh.recipe) return { status: "skipped", reason: v.code || "invalid" };
    const recipe = v.refresh.recipe;
    if (recipe.kind === "llm") return { status: "skipped", reason: "llm" };
    const capped =
      recipe.kind === "http"
        ? {
            ...recipe,
            timeoutMs: Math.min(
              Number.isFinite(recipe.timeoutMs) ? recipe.timeoutMs : COMPOSE_FIRST_TICK_CAP_MS,
              COMPOSE_FIRST_TICK_CAP_MS,
            ),
          }
        : recipe;
    let timer      = null;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ error: "first tick timed out" }), COMPOSE_FIRST_TICK_CAP_MS + 250);
    });
    let result     ;
    try {
      result = await Promise.race([executeRefreshRecipe(capped, { sessionKey: params.sessionKey }), late]);
    } catch (err     ) {
      result = { error: err && err.message ? String(err.message) : "first tick failed" };
    } finally {
      clearTimeout(timer);
    }
    if (result && typeof result === "object" && !result.error && Object.prototype.hasOwnProperty.call(result, "output")) {
      return { status: "ok", output: result.output };
    }
    const error = result && typeof result.error === "string" ? result.error : "first tick returned nothing";
    return { status: "failed", error, wiring: composedFirstTickWiringFault(error) };
  }

  function liveUiV2SurfaceLive(sessionKey     , surfaceId     ) {
    if (typeof deps.relay.isLiveUiV2SurfaceLive !== "function") return false;
    try {
      return deps.relay.isLiveUiV2SurfaceLive(sessionKey, surfaceId) === true;
    } catch (_) {
      return false;
    }
  }

  function composedTopSurface(sessionKey     ) {
    if (typeof deps.relay.liveUiV2TopSurface !== "function") return null;
    try {
      return deps.relay.liveUiV2TopSurface(sessionKey) || null;
    } catch (_) {
      return null;
    }
  }

  function composedSeedValues(sessionKey     , surfaceId     ) {
    if (typeof deps.relay.liveUiV2TopSurface !== "function") return {};
    try {
      const top      = deps.relay.liveUiV2TopSurface(sessionKey);
      return top && top.surfaceId === surfaceId && top.data && typeof top.data === "object" ? { ...top.data } : {};
    } catch (_) {
      return {};
    }
  }

  function discardHeldComposedRefreshes(host     ) {
    for (const [key, held] of heldComposedRefreshes) {
      if (held.host === host) heldComposedRefreshes.delete(key);
    }
  }

  function holdComposedRefresh(host     , attach     ) {
    discardHeldComposedRefreshes(host);
    while (heldComposedRefreshes.size >= 5) {
      heldComposedRefreshes.delete(heldComposedRefreshes.keys().next().value);
    }
    heldComposedRefreshes.set(`${attach.sessionKey}\u0000${host}`, {
      host,
      attach: JSON.parse(JSON.stringify(attach)),
    });
  }

  function startHeldComposedRefreshes(host     ) {
    const held = [...heldComposedRefreshes.values()].filter((entry) => entry.host === host);
    discardHeldComposedRefreshes(host);
    for (const entry of held) {
      const { sessionKey, surfaceId } = entry.attach;
      if (!liveUiV2SurfaceLive(sessionKey, surfaceId)) {
        emitLifecycle("composed_refresh_held_discarded", "debug", { sessionKey, surfaceId, host, reason: "surface_gone" });
        continue;
      }
      const started      = attachComposedRefresh(entry.attach);
      if (started.status !== "started") {
        emitLifecycle("held_render_start_failed", "warn", { sessionKey, surfaceId, host, code: started.code || started.status });
      }
    }
  }

  function grantLiveuiSite(hostInput     ) {
    const cfg      = typeof deps.getGlassesUiLiveConfig === "function"
      ? deps.getGlassesUiLiveConfig() || {}
      : {};
    if (cfg.httpHostPolicy !== "owner-grants") return { ok: false, code: "grants_policy_operator_only" };
    const granted      = getLiveuiGrantsStore().grant(hostInput);
    if (!granted || granted.ok !== true) {
      return { ok: false, code: granted && typeof granted.code === "string" ? granted.code : "grants_write_failed" };
    }
    const host = normalizeGrantHost(hostInput).host;
    startHeldConsentRenders(host);
    startHeldComposedRefreshes(host);
    programCardFeeds.grantsChanged();
    if (granted.granted === true) notifyLiveuiGrantsChanged();
    return { ok: true, host };
  }

  function askLiveuiSite(host     , sessionKey     , what                   ) {
    if (typeof deps.relay.askLiveuiSite !== "function") return "unavailable";
    let asked     ;
    try {
      asked = deps.relay.askLiveuiSite({
        host,
        what,
        sessionKey: typeof sessionKey === "string" && sessionKey ? sessionKey : null,
        onAnswer: (answer     ) => {

          if (answer === "allow" && grantLiveuiSite(host).ok) return;
          discardHeldConsentRenders(host);
          discardHeldComposedRefreshes(host);
          emitLifecycle("held_for_host_consent_dropped", "info", { host, answer: String(answer || "") });
        },
      });
    } catch (_) {
      asked = "unavailable";
    }
    return asked === "asked" || asked === "waiting" || asked === "declined" ? asked : "unavailable";
  }

  function stopComposedRefreshesForHost(host     ) {
    const stopped = [];
    for (const [surfaceId, job] of [...composedRefreshJobs]) {
      if (job.host !== host) continue;
      cronEngine.stop(composedJobKey(surfaceId), { result: "preempted", reason: "refresh_host_revoked" }, {});
      stopped.push(surfaceId);
    }
    return stopped;
  }

  function attachComposedRefresh(params     ) {

    const relaySessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : "";
    const sessionKey = normalizeGlassesSessionKey(relaySessionKey);
    const surfaceId = params && typeof params.surfaceId === "string" ? params.surfaceId : "";
    const origin = params && typeof params.origin === "string" ? params.origin : "agent";
    if (!sessionKey || !surfaceId) {
      return { status: "refused", code: "surface_gone", message: "attach needs a session and a surface" };
    }
    if (typeof deps.relay.writeLiveUiV2Data !== "function") {
      return { status: "refused", code: "refresh_unavailable", message: "this relay cannot write composed-surface data" };
    }
    const checked      = validateComposedRefresh(params);
    if (!checked.ok && checked.code !== "refresh_host_consent_required") {
      emitLifecycle("composed_refresh_refused", "warn", { sessionKey, surfaceId, code: checked.code, origin });
      return { status: "refused", code: checked.code, message: checked.message };
    }
    if (!liveUiV2SurfaceLive(relaySessionKey, surfaceId)) {
      return { status: "refused", code: "surface_gone", message: "the surface left the glasses" };
    }
    if (!checked.ok) {

      holdComposedRefresh(checked.host, {
        sessionKey: relaySessionKey,
        surfaceId,
        refresh: params.refresh,
        inputs: checked.inputs,
        origin,
      });
      const asked = askLiveuiSite(checked.host, relaySessionKey, "screen");
      if (asked === "declined" || asked === "unavailable") {
        discardHeldComposedRefreshes(checked.host);
        return {
          status: "refused",
          code: "refresh_host_consent_required",
          host: checked.host,
          message: asked === "declined"
            ? `The wearer said Not now to ${checked.host} on the glasses a moment ago.`
            : `The wearer allows a new site on the glasses, and none can ask for ${checked.host} now.`,
        };
      }
      emitLifecycle("composed_refresh_held_for_host_consent", "info", {
        sessionKey,
        surfaceId,
        host: checked.host,
        asked: asked === "asked",
      });
      return {
        status: "held",
        code: "refresh_host_consent_required",
        host: checked.host,
        message: "The glasses ask the wearer to allow this site; the refresh fills the surface once they allow it. Leave the surface as it is: add no permission note, and do not send the wearer to LiveUI settings.",
      };
    }
    const replacing = composedRefreshJobs.has(surfaceId);
    const { maxConcurrentSurfacesPerHost } = readStageConfig();
    if (!replacing && composedRefreshJobs.size >= maxConcurrentSurfacesPerHost) {
      emitLifecycle("composed_refresh_refused", "warn", { sessionKey, surfaceId, code: "refresh_concurrent_limit", origin });
      return {
        status: "refused",
        code: "refresh_concurrent_limit",
        message: `at most ${maxConcurrentSurfacesPerHost} composed refreshes run at once`,
      };
    }

    if (replacing) {
      cronEngine.stop(composedJobKey(surfaceId), { result: "preempted", reason: "refresh_replaced" }, { silent: true });
      composedRefreshJobs.delete(surfaceId);
    }
    const host = httpHostOf(checked.refresh.recipe);
    const token = (composedRefreshToken += 1);
    composedRefreshJobs.set(surfaceId, { sessionKey, host, origin, token });
    cronEngine.start({
      surfaceId,
      jobKey: composedJobKey(surfaceId),
      sessionKey,
      refresh: checked.refresh,
      data: {
        sessionKey: relaySessionKey,
        inputs: checked.inputs,
        targets: checked.refresh.targets,
        seed: composedSeedValues(relaySessionKey, surfaceId),

        first: params.first && typeof params.first === "object" ? params.first : null,
      },
      onResolve: (outcome     ) => {
        const job = composedRefreshJobs.get(surfaceId);
        if (job && job.token === token) composedRefreshJobs.delete(surfaceId);
        emitLifecycle("composed_refresh_stopped", "debug", {
          sessionKey,
          surfaceId,
          result: outcome && outcome.result,
          ticks: outcome && outcome.ticks ? outcome.ticks.count : 0,
        });
      },
    });
    emitLifecycle("composed_refresh_started", "debug", {
      sessionKey,
      surfaceId,
      kind: checked.refresh.recipe.kind,
      intervalMs: checked.refresh.intervalMs,
      targets: Object.keys(checked.refresh.targets),
      origin,
    });
    return { status: "started" };
  }

  function stopComposedRefresh(surfaceId     ) {
    let found = false;
    for (const [key, held] of heldComposedRefreshes) {
      if (held.attach.surfaceId === surfaceId) {
        heldComposedRefreshes.delete(key);
        found = true;
      }
    }
    if (cronEngine.stop(composedJobKey(surfaceId), { result: "stopped" }, {})) found = true;
    return found;
  }

  const composedLibraryOpens = new Map                ();

  async function renderComposedTemplate(params     ) {
    const stored = params.template;
    const sessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : "";
    const library = params.origin === "task";
    const origin = library ? "library" : "agent";
    const rejectedOpen = (code        , message        , extra                          = {}) => {
      emitLifecycle("composed_template_open_refused", "warn", {
        sessionKey: normalizeGlassesSessionKey(sessionKey),
        templateId: stored.templateId,
        origin,
        code,
      });
      return { status: "rejected", code, message, templateId: stored.templateId, ...extra };
    };
    if (typeof deps.relay.openLiveUiV2Records !== "function") {
      return rejectedOpen("relay_not_ready", "this relay cannot open a composed template");
    }
    const prepared = await prepareComposedRefresh({ sessionKey, refresh: stored.refresh, signal: params.signal });
    if (!prepared.ok) return rejectedOpen(prepared.code, prepared.message);
    const cancelled = prepared.isCurrent?.() === false || params.signal?.aborted;
    prepared.release?.();
    if (cancelled) return rejectedOpen("refresh_cancelled", "Refresh preparation was cancelled; no refresh was started.");
    const inputs = Array.isArray(stored.inputs) ? stored.inputs : [];
    const values = params.values && typeof params.values === "object" && !Array.isArray(params.values) ? params.values : {};

    const surface = typeof params.title === "string" && params.title.trim()
      ? { ...stored.body.surface, title: params.title.replace(/\s+/g, " ").trim() }
      : stored.body.surface;
    let records        ;
    try {
      records = storedSurfaceRecords(fillStoredSurface(surface, values, inputs));
    } catch (err     ) {
      return rejectedOpen("template_surface_invalid", err && err.message ? err.message : "the stored surface did not decompile");
    }

    const pictures = stored.assets && stored.assets.pictures;
    const ownPictures = !!pictures && typeof pictures === "object" && !Array.isArray(pictures);

    const more = params.more && typeof params.more === "object" && !Array.isArray(params.more) ? params.more : null;
    const out      = deps.relay.openLiveUiV2Records(sessionKey, {
      records,
      inputs,
      values,
      origin,
      passive: library,
      ...(more ? { more } : {}),
      ...(ownPictures ? { assets: pictures } : {}),
      wearer: params.wearerInitiated === true,
    });
    if (!out || out.ok !== true || typeof out.surfaceId !== "string") {
      const reason = out && typeof out.reason === "string" ? out.reason : "template_open_failed";
      if (reason === "inputs_invalid") {

        const message = out.code === "picture_source_refused"
          ? "a picture value names a file, which only a wearer's open may read; send a web address or bytes"
          : out.code === "picture_too_large"
            ? "a picture value is over the picture size cap"
            : "a value does not fit its input";
        return rejectedOpen(out.code || "template_values_invalid", message, out.key ? { key: out.key } : {});
      }
      return rejectedOpen(reason, "the template did not paint");
    }
    if (library) composedLibraryOpens.set(out.surfaceId, sessionKey);
    if (typeof params.onOpened === "function") params.onOpened({ surfaceId: out.surfaceId });
    let refresh      = null;
    if (stored.refresh && typeof stored.refresh === "object") {
      refresh = attachComposedRefresh({ sessionKey, surfaceId: out.surfaceId, refresh: stored.refresh, inputs, origin });
    }
    emitLifecycle("composed_template_opened", "info", {
      sessionKey: normalizeGlassesSessionKey(sessionKey),
      templateId: stored.templateId,
      surfaceId: out.surfaceId,
      specRev: out.specRev,
      origin,
      refresh: refresh ? refresh.status : null,
    });
    return {
      status: "rendered",
      templateId: stored.templateId,
      digest: stored.digest,
      outcome: { result: "painted", surfaceId: out.surfaceId },
      ...(refresh
        ? {
            refresh: {
              status: refresh.status,
              ...(refresh.code ? { code: refresh.code } : {}),
              ...(refresh.host ? { host: refresh.host } : {}),
            },
          }
        : {}),
    };
  }

  function releaseComposedLibraryOpen(surfaceId     , reason     ) {
    const sessionKey = composedLibraryOpens.get(surfaceId);
    if (sessionKey === undefined) return false;
    composedLibraryOpens.delete(surfaceId);
    stopComposedRefresh(surfaceId);
    if (typeof deps.relay.withdrawLiveUiV2Surface !== "function") return false;
    try {
      return deps.relay.withdrawLiveUiV2Surface(sessionKey, surfaceId, typeof reason === "string" ? reason : "library_template_reopen") === true;
    } catch (_) {
      return false;
    }
  }

  const RENDER_CONTROL_FIELDS = Object.freeze(["update", "timeoutMs", "staleAfterMs", "queueMode"]);

  function sortedKeysReplacer(_key     , value     ) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const sorted      = {};
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return sorted;
  }

  function renderContentKey(spec     ) {
    const content      = {};
    for (const key of Object.keys(spec)) {
      if (!RENDER_CONTROL_FIELDS.includes(key)) content[key] = spec[key];
    }
    return JSON.stringify(content, sortedKeysReplacer);
  }

  function unchangedGraphicRender(sessionKey     , update     , depth     , stagePlan     , validation     , params     ) {
    const spec      = validation && validation.spec;
    if (!spec || spec.kind !== "text_surface" || !["graphic","graphic_v2"].includes(spec.template)) return null;
    if (update !== "patch" && update !== "replace") return null;
    if (params.wearerInitiated === true || typeof params.onOpened === "function") return null;
    if (!stagePlan || stagePlan.action !== "retain") return null;
    const stackDepth = surfaceStore.stackDepth(sessionKey);
    if (stackDepth === 0 || (depth <= 1 && stackDepth > 1)) return null;
    if (surfaceStore.adoptedChildFor(sessionKey)) return null;
    const surfaceId = surfaceStore.topSurfaceId(sessionKey);
    const facts      = surfaceStore.surfaceFactsFor(surfaceId);
    if (!facts || facts.state === "exiting" || facts.exitLatched || facts.parkedEventCount > 0) return null;
    if (surfaceStore.hasAgentRunEnded(surfaceId)) return null;
    if (cronEngine.isActive(surfaceId) || paintFloor.hasPending(surfaceId)) return null;
    const recorded = surfaceStore.currentSurfaceSpecForSession(sessionKey);
    if (!recorded || renderContentKey(recorded) !== renderContentKey(spec)) return null;
    const lastRender      = surfaceStore.lastRenderSendOf(surfaceId);
    if (!lastRender) return null;
    const failures      = surfaceStore.clientFailuresOf(surfaceId);
    if (failures && failures.clients.some((client     ) =>
      Number.isFinite(client.lastSeq) && client.lastSeq >= lastRender.seq)) {
      return null;
    }
    const deliveryState      = readDeliveryState(surfaceId);
    const attempt = deliveryState && deliveryState.lastAttemptedSend;
    const receiptPresent = attempt
      ? surfaceStore.hasClientReceipt(deliveryState.surfaceUuid, attempt.seq)
      : false;
    emitLifecycle("render_unchanged", "debug", {
      surfaceId,
      sessionKey,
      template: spec.template,
      requestedUpdate: update,
      renderSeq: lastRender.seq,
      repairCodes: lifecycleRepairCodes(validation),
    });
    return {
      result: "unchanged",
      unchanged: true,
      surfaceUuid: facts.surfaceUuid,
      surface_still_live: true,
      delivery: projectDelivery(deliveryState, receiptPresent),
    };
  }

  function agentPatchAsFieldPatch(input     ) {
    const {
      sessionKey, surfaceId, params, wireSpec, wireDepth, renderLive, patchFromLaterRun,
      collectedParkedTap, refreshValidated,
    } = input;
    if (patchFromLaterRun || collectedParkedTap || refreshValidated) return null;
    if (renderOriginOf(params.origin) !== "agent") return null;
    if (params.wearerInitiated === true || typeof params.onOpened === "function" || params.templateRuntime) {
      return null;
    }
    if (surfaceStore.topSurfaceId(sessionKey) !== surfaceId) return null;
    const wire      = lastWireRenderBySurface.get(surfaceId) || null;
    const queued      = paintFloor.pendingRenderOf(surfaceId);
    const held      = queued
      ? { origin: queued.__origin, depth: queued.__depth, live: queued.__live }
      : wire;
    if (!held || held.origin !== "agent" || held.depth !== wireDepth || held.live !== renderLive) return null;
    const marker = displayedMarkerFor(surfaceId);
    if (!marker) return null;
    const patch      = {};
    if (typeof wireSpec.title === "string") patch.title = wireSpec.title;
    if (typeof wireSpec.body === "string") patch.body = wireSpec.body;
    if (Array.isArray(wireSpec.items)) patch.items = wireSpec.items;
    const painted = paintFloor.predictFieldPatch(surfaceId, wire ? wire.phoneSpec : null, patch);
    if (JSON.stringify(painted, sortedKeysReplacer) !== JSON.stringify(wireSpec, sortedKeysReplacer)) return null;
    patch.marker = marker;
    return patch;
  }

  function lifecycleTemplate(spec     ) {
    const template = spec && typeof spec === "object" ? spec.template : null;
    return ["graphic","graphic_v2","image_caption","duration_picker"].includes(template) ? template : null;
  }
  function lifecycleRepairCodes(validation     ) {
    const repairs = validation && Array.isArray(validation.repairs) ? validation.repairs : [];
    return repairs
      .map((repair     ) => (repair && typeof repair.code === "string" ? repair.code : null))
      .filter((code     ) => code !== null);
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

        template: lifecycleTemplate(params && params.spec),
      });
      recordRenderRefusal(params, validation.code || "invalid_spec");
      const err = new Error(`${validation.code}: ${validation.message}`);
      err.code = validation.code;
      throw err;
    }

    const validatedWithRepairs      = validation;
    const validatedRepairs      = validatedWithRepairs.repairs;
    const withRepairs = (outcome     ) =>
      Array.isArray(validatedRepairs) && validatedRepairs.length > 0 &&
      outcome && typeof outcome === "object" && !Array.isArray(outcome)
        ? { ...outcome, repairs: validatedRepairs.map((repair     ) => ({ ...repair })) }
        : outcome;

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
        if (v.code === "refresh_host_consent_required" && mayAskForSite(params)) {
          const windowCheck      = validateWindowFields(params.spec);
          const queueCheck      = validateQueueMode(params.spec);
          if (!windowCheck.ok || !queueCheck.ok) {
            const rejected      = !windowCheck.ok ? windowCheck : queueCheck;
            const err      = new Error(`${rejected.code}: ${rejected.message}`);
            err.code = rejected.code;
            throw err;
          }

          holdConsentRender(v.host, { ...params, sessionKey }, validation, v.refresh);
          const asked = askLiveuiSite(v.host, sessionKey, "screen");
          if (asked === "asked" || asked === "waiting") {
            emitLifecycle("render_held_for_host_consent", "info", {
              sessionKey,
              host: v.host,
              asked: asked === "asked",
            });
            return {
              status: "held",
              code: "refresh_host_consent_required",
              host: v.host,
              message: "The glasses ask the wearer to allow this site; the surface starts if they allow it.",
            };
          }
          discardHeldConsentRenders(v.host);
          const err      = new Error(asked === "declined"
            ? `refresh_host_consent_required: the wearer said Not now to ${v.host} on the glasses a moment ago`
            : `refresh_host_consent_required: the wearer allows a new site on the glasses, and none can ask for ${v.host} now`);
          err.code = "refresh_host_consent_required";
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
      const err      = new Error(`${queueModeField.code}: ${queueModeField.message}`);
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
        const declaredWindow      = windowFields;
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
          template: lifecycleTemplate(validation.spec),
          repairCodes: lifecycleRepairCodes(validation),
        });

        return withRepairs(latchedOutcome);
      }

      exitLatchBySession.delete(sessionKey);
      emitLifecycle("stale_cron_summary_dropped", "debug", {
        surfaceId: sessionExitLatch.surfaceId,
        sessionKey,
      });
    }

    let newRootIntoUnviewedSession = false;
    if (
      params.wearerInitiated !== true &&
      surfaceStore.stackDepth(sessionKey) === 0 &&
      typeof deps.getViewedSessionKeys === "function"
    ) {
      let viewed      = null;
      try { viewed = deps.getViewedSessionKeys(); } catch (_) { viewed = null; }
      newRootIntoUnviewedSession =
        Array.isArray(viewed) &&
        viewed.length > 0 &&
        !viewed.some((key     ) => normalizeGlassesSessionKey(key) === sessionKey);
    }
    if (newRootIntoUnviewedSession && params.requireViewedSession === true) {
      const reason =
        "the wearer is in another chat, so nothing would show on the glasses; " +
        "answer in text instead, it waits in this chat";
      emitLifecycle("render_rejected", "warn", {
        surfaceId: null,
        sessionKey,
        code: "session_not_viewed",
        reason,
      });
      recordRenderRefusal({ ...params, sessionKey }, "session_not_viewed");
      const err      = new Error(`session_not_viewed: ${reason}`);
      err.code = "session_not_viewed";
      throw err;
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
      const err      = new Error(`refresh_concurrent_limit: ${reason}`);
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
      const err      = new Error(reason);
      err.code = "stage_incumbent_busy";
      err.retryAfterMs = stagePlan.retryAfterMs;
      throw err;
    }

    const unchanged = unchangedGraphicRender(sessionKey, update, depth, stagePlan, validation, params);
    if (unchanged) return withRepairs(unchanged);

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

    const patchFromLaterRun = applied.mode === "patch" && surfaceStore.hasAgentRunEnded(surfaceId);

    const declarationId = nextDeclarationId();

    const declaredWindow      = windowFields;
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

      template: lifecycleTemplate(validation.spec),
      repairCodes: lifecycleRepairCodes(validation),
    });

    const promise = surfaceStore.register(sessionKey, surfaceId, {
      kind: validation.spec.kind,
      declarationId,
      settleOnSupersede: params.settleOnSupersede === true,
      wearerInitiated: params.wearerInitiated === true,
      staleAfterMs: windowFields.staleAfterMs,
      queueMode: queueModeField.queueMode,
      title: typeof validation.spec.title === "string" ? validation.spec.title : undefined,
    });

    let collectedParkedTap = false;
    if (applied.mode === "patch" || applied.mode === "replace") {
      const reattach = surfaceStore.onReattached(surfaceId);
      if (reattach === "discarded_for_exit") {

        if (cronEngine.isActive(surfaceId)) cronEngine.stop(surfaceId, { result: "dismissed" });
        surfaceStore.exit(sessionKey);
        return promise.then(withRepairs);
      }
      if (reattach === "reattached_stale_latch_dropped") {

        emitLifecycle("stale_cron_summary_dropped", "debug", { surfaceId, sessionKey });
      }

      const factsAfterReattach = surfaceStore.surfaceFactsFor(surfaceId);
      collectedParkedTap = !!factsAfterReattach && factsAfterReattach.pendingRender === false;
    }

    openedChildBySurface.delete(surfaceId);
    const wireDepth = Math.max(
      1,
      Number.isFinite(applied.depth) ? applied.depth : surfaceStore.stackDepth(sessionKey),
    );

    const validationAny      = validation;
    const validationSpec      = validationAny.spec;
    const recordedSpec      = { ...validationSpec };
    if (["replace", "patch", "push"].includes(params.spec && params.spec.update)) {
      recordedSpec.update = params.spec.update;
    }
    if (declaredWindow.timeoutMs !== undefined) recordedSpec.timeoutMs = declaredWindow.timeoutMs;
    if (declaredWindow.staleAfterMs !== undefined) recordedSpec.staleAfterMs = declaredWindow.staleAfterMs;
    if (queueModeField.queueMode !== undefined) recordedSpec.queueMode = queueModeField.queueMode;
    if (refreshValidated !== undefined) recordedSpec.refresh = refreshValidated;
    const breadcrumb = surfaceStore.breadcrumbFor(sessionKey, wireDepth);

    if (breadcrumb) {
      validation.spec.title = breadcrumb === validation.spec.title ? breadcrumb : clipBreadcrumb(breadcrumb);
    }

    const wireSpec      = { ...validation.spec };
    if (Array.isArray(validation.spec.children)) {
      wireSpec.children = mintPreloadedChildren(
        surfaceId,
        validation.spec.title,
        validation.spec.children,
        declarationSeq,
      );
    }
    const renderLive = !!refreshValidated || cronEngine.isActive(surfaceId);

    const fieldPatch = applied.mode === "patch" ? agentPatchAsFieldPatch({
      sessionKey, surfaceId, params, wireSpec, wireDepth, renderLive, patchFromLaterRun,
      collectedParkedTap, refreshValidated,
    }) : null;
    if (fieldPatch) {
      emitLifecycle("agent_patch_as_update", "debug", { surfaceId, sessionKey, declarationId });
      paintFloor.enqueue({ surfaceId, sessionKey, patch: { ...fieldPatch, __recordedSpec: recordedSpec } });
    } else {
      paintFloor.enqueue({
        surfaceId,
        sessionKey,

        patch: {
          __render: true,
          __depth: wireDepth,
          __spec: wireSpec,
          __recordedSpec: recordedSpec,
          __marker: displayedMarkerFor(surfaceId),

          __origin: renderOriginOf(params.origin),

          __collect: collectedParkedTap,
          __live: renderLive,
        },
      });
    }

    if (typeof params.onOpened === "function") {
      params.onOpened({ surfaceId, sessionKey, declarationId });
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
    const ownsDeclaration = () => params.settleOnSupersede !== true ||
      surfaceStore.isCurrentDeclaration(surfaceId, declarationId);

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
      if (!ownsDeclaration()) return;

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

    if (params.settleOnDelivery === true) {
      let released = false;
      let capHandle      = null;
      const onReceipt = () => settleOnDelivery("client_receipt");
      const release = () => {
        if (released) return;
        released = true;
        if (capHandle !== null) clearTimeoutFn(capHandle);
        const set = receiptWaitersBySurface.get(surfaceId);
        if (!set) return;
        set.delete(onReceipt);
        if (set.size === 0) receiptWaitersBySurface.delete(surfaceId);
      };
      function settleOnDelivery(via     ) {
        if (released) return;

        if (!surfaceStore.isCurrentDeclaration(surfaceId, declarationId)) {
          release();
          return;
        }
        const deliveryState      = readDeliveryState(surfaceId);
        const attempt = deliveryState && deliveryState.lastAttemptedSend;
        const receiptPresent = attempt
          ? surfaceStore.hasClientReceipt(deliveryState.surfaceUuid, attempt.seq)
          : false;

        if (via !== "cap" && !receiptPresent) return;
        release();

        const { phrase: _phrase, ...delivery } = projectDelivery(deliveryState, receiptPresent);
        const outcome = {
          result: "shown",
          surface_still_live: true,
          origin: "system",
          delivery,
          hint: receiptPresent ? SHOWN_CONFIRMED_HINT : SHOWN_UNCONFIRMED_HINT,
        };
        if (surfaceStore.resolve(surfaceId, outcome)) {
          emitLifecycle("surface_settled", "info", {
            surfaceId,
            sessionKey,
            outcome: { result: outcome.result, clientReceiptPresent: receiptPresent },
            via: via === "cap" ? "settle_on_delivery_cap" : "settle_on_delivery",
            declarationId,
            staleAfterMs: declaredStaleAfterMs,
            declaredTimeoutMs,
          });

          emitMarker(sessionKey, surfaceId);
        }
      }
      let waiters = receiptWaitersBySurface.get(surfaceId);
      if (!waiters) {
        waiters = new Set();
        receiptWaitersBySurface.set(surfaceId, waiters);
      }
      waiters.add(onReceipt);
      capHandle = setTimeoutFn(
        () => settleOnDelivery("cap"),
        Math.min(SETTLE_ON_DELIVERY_CAP_MS, wrapUpDelayMs),
      );
      cleanups.push(release);

      settleOnDelivery("already_received");
    }

    const signal = params.signal;
    if (signal && typeof signal.addEventListener === "function") {
      const onAbort = () => {
        if (!ownsDeclaration()) return;
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
        if (!ownsDeclaration()) return;

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

    if (newRootIntoUnviewedSession) {
      const outcome = {
        result: "preempted",
        origin: "system",
        reason: "session_not_viewed",
      };
      const released = releaseSurfaceTerminally(surfaceId, outcome, declarationId, "session_not_viewed");
      emitLifecycle("session_not_viewed_release", "info", {
        surfaceId,
        sessionKey,
        declarationId,
        released,
      });
    }

    return promise.then((outcome) => {
      for (const fn of cleanups) {
        try { fn(); } catch (_) {  }
      }
      return withRepairs(outcome);
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
    pruneLastWireRenders();
    return reaped;
  }

  function pruneLastWireRenders() {
    for (const surfaceId of [...lastWireRenderBySurface.keys()]) {
      if (!surfaceStore.sessionForSurface(surfaceId)) lastWireRenderBySurface.delete(surfaceId);
    }
  }

  function releaseSurfaceTerminally(
    surfaceId     ,
    outcome     ,
    expectedDeclarationId     ,
    via     ,
  ) {
    if (expectedDeclarationId !== null && !surfaceStore.isCurrentDeclaration(surfaceId, expectedDeclarationId)) return false;
    const sessionKey = surfaceStore.sessionForSurface(surfaceId);
    const terminalOutcome =
      outcome && isTerminalOutcome(outcome)
        ? outcome
        : { result: "preempted", origin: "system", reason: via };
    let merged = terminalOutcome;
    if (cronEngine.isActive(surfaceId)) {
      capturedCronOutcome.set(surfaceId, (cronOutcome     ) => { merged = cronOutcome; });
      cronEngine.stop(surfaceId, terminalOutcome, undefined);
      capturedCronOutcome.delete(surfaceId);
    }
    if (!surfaceStore.resolve(surfaceId, merged)) {
      surfaceStore.queueEvent(surfaceId, merged, undefined);
    }
    const released = releaseTerminalTop(surfaceId, merged, via);
    if (released) scheduleCompanionSnapshot({ sessionKey });
    return released;
  }

  function releaseTerminalTop(surfaceId     , outcome     , via     ) {
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

  function readDeliveryState(surfaceId     ) {
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

  function safeBool(read     ) {
    try {
      const value = read();
      return value === undefined || value === null ? null : !!value;
    } catch (_) {
      return null;
    }
  }

  function renameTemplate(templateId     , options      = {}) {
    const stored = getTemplateLibrary().read(templateId);
    if (stored.status !== "accepted") return stored;
    const clash = visibleNameClash("template", templateId, options.name);
    if (clash) return rejectLiveuiVisibleNameClash(clash);

    return getTemplateLibrary().renameTemplateRecord(templateId, options.name, {
      expectedDigest: options.expectedDigest,
    });
  }

  function resolvePreferredTemplateHint(templateId     ) {
    try {
      const stored = getTemplateLibrary().read(templateId);
      if (!stored || stored.status !== "accepted") return null;

      const example      = stored.envelope ? templateExampleSummary(stored.envelope) : null;
      return {
        templateId: stored.template.templateId,
        name: stored.template.name,
        summary: example && example.form === "composed"
          ? example.summary
          : summarizeLiveuiTemplateSpec(stored.template.spec, stored.template.slots),
      };
    } catch (_) {
      return null;
    }
  }

  function reorderLibrary(options      = {}) {
    return getLibraryOrganization().reorderLibrary(options);
  }

  function setLibraryItemHidden(options      = {}) {
    return getLibraryOrganization().setLibraryItemHidden(options);
  }

  function updateTaskCosmetic(taskId     , options      = {}) {
    return getTaskLibrary().updateTaskCosmetic(taskId, options);
  }

  function updateTaskSettingValues(taskId     , values     , options      = {}) {
    const result = getTaskLibrary().updateTaskSettingValues(taskId, values, options);
    return result && result.status === "saved"
      ? { ...result, task: projectTask(result.task) }
      : result;
  }

  function getTaskScheduler() {
    if (!taskScheduler) {
      taskScheduler = createLiveuiTaskScheduler({
        libraryDir: injectedLibraryRoot(),
        host: deps.host === "hermes" ? "hermes" : "openclaw",
        taskLibrary: () => getTaskLibrary(),
        request: typeof deps.taskScheduleRequest === "function" ? deps.taskScheduleRequest : null,
        available: typeof deps.taskScheduleAvailable === "function" ? deps.taskScheduleAvailable : undefined,

        watchesPages: typeof deps.taskPageWatchAvailable === "function" ? deps.taskPageWatchAvailable : undefined,
        logger: { warn: (message     ) => taskScheduleWarning(message) },

        onSyncChanged: () => {
          if (typeof deps.taskSyncChanged === "function") deps.taskSyncChanged();
        },

        looks: {
          card(templateId     ) {
            const stored      = getTemplateLibrary().read(templateId);
            const envelope = stored && stored.status === "accepted" ? stored.envelope : null;
            return envelope ? { name: envelope.name, inputs: envelope.inputs, digest: envelope.digest,
              taskPresentation: !!envelope.helperOf && templateId.startsWith("result-") } : null;
          },

          filledBy(templateId     , taskId     ) {
            const stored      = getTemplateLibrary().read(templateId);
            if (!stored || stored.status !== "accepted") return null;
            const owner = liveuiTemplateValuesOwner({ taskId });
            const resultOf = (file     ) =>
              passiveTemplateValues(stored.envelope, file) && typeof file.resultId === "string" ? file.resultId : null;
            const mine = owner ? resultOf(getTemplateLibrary().readDeliveredValues(templateId, { owner })) : null;
            return mine || resultOf(getTemplateLibrary().readDeliveredValues(templateId, { owner: null }));
          },

          programCard(taskId     ) {
            return programCardLook(createProgramCardFeedStore({ libraryDir: injectedLibraryRoot() }).read(taskId));
          },
        },
      });
    }
    return taskScheduler;
  }

  let taskVoice      = null;
  function getTaskVoice() {
    if (!taskVoice) {
      taskVoice = createLiveuiTaskVoice({
        enabled: () => {
          try {
            return typeof deps.scheduledTasksEnabled === "function" && deps.scheduledTasksEnabled() === true;
          } catch (_) {
            return false;
          }
        },
        scheduler: () => getTaskScheduler(),
        createDraft: (input     , context     ) => publicApi.createTaskDraft(input, context),
        readTask: (taskId     ) => getTaskLibrary().read(taskId),
        listTasks: () => getTaskLibrary().list(),
        reviewTask: (params     ) => publicApi.reviewTask(params),
        presentConfirm: (request     ) =>
          typeof deps.presentTaskConfirm === "function"
            ? deps.presentTaskConfirm(request)
            : { presented: false, reason: "unavailable" },
        emit: (event     , fields     ) => {
          if (typeof deps.emitLifecycle === "function") deps.emitLifecycle(event, "info", { storeId, ...fields });
        },
      });
    }
    return taskVoice;
  }

  let taskSheet      = null;
  function getTaskSheet() {
    if (!taskSheet) {
      taskSheet = createLiveuiTaskSheet({
        enabled: () => {
          try {
            return typeof deps.scheduledTasksEnabled === "function" && deps.scheduledTasksEnabled() === true;
          } catch (_) {
            return false;
          }
        },
        scheduler: () => getTaskScheduler(),
        createDraft: (input     , context     ) => publicApi.createTaskDraft(input, context),
        readTask: (taskId     ) => getTaskLibrary().read(taskId),
        listTasks: () => getTaskLibrary().list(),
        approveTask: (taskId     , digest     ) => getTaskLibrary().approveTask(taskId, { expectedDigest: digest }),
        rejectTask: (taskId     , digest     ) => getTaskLibrary().rejectTask(taskId, { expectedDigest: digest }),
      });
    }
    return taskSheet;
  }

  function getTaskPage(options      = {}) {
    return createLiveuiTaskPage({
      enabled: () => {
        try {
          return typeof deps.scheduledTasksEnabled === "function" && deps.scheduledTasksEnabled() === true;
        } catch (_) {
          return false;
        }
      },
      scheduler: () => getTaskScheduler(),
      readTask: (taskId     ) => getTaskLibrary().read(taskId),

      deleteTask: (taskId     , deleteOptions     ) => deleteTask(taskId, deleteOptions),
      reviewTask: (params     ) => publicApi.reviewTask(params),

      approveTask: (taskId     , digest     ) => getTaskLibrary().approveTask(taskId, { expectedDigest: digest }),
      rejectTask: (taskId     , digest     ) => getTaskLibrary().rejectTask(taskId, { expectedDigest: digest }),
      recentResults: options && typeof options.recentResults === "function" ? options.recentResults : null,

      uses: createTaskUsesStore({ libraryDir: injectedLibraryRoot() }),

      fits: createTaskFitStore({ libraryDir: injectedLibraryRoot() }),

      runs: createTaskRunsWeekStore({ libraryDir: injectedLibraryRoot() }),

      starterCard: options && typeof options.starterCard === "function" ? options.starterCard : null,
    });
  }

  function schedulesHere() {
    return deps.host === "hermes" || getTaskScheduler().canSchedule === true;
  }

  function offerTaskLook(result     , input     ) {
    if (!schedulesHere() || typeof deps.onTaskLookOffer !== "function") return;
    if (!result || result.status !== "saved" || !input || typeof input.taskId !== "string") return;
    const templateId = typeof result.templateId === "string" ? result.templateId : null;
    if (!templateId) return;
    try {
      if (!getTaskScheduler().offersLook(input.taskId, templateId)) return;
      const task      = getTaskLibrary().read(input.taskId);
      const stored      = getTemplateLibrary().read(templateId);
      const name = stored && stored.status === "accepted" && typeof stored.envelope.name === "string"
        ? stored.envelope.name
        : templateId;
      deps.onTaskLookOffer({
        taskId: input.taskId,
        templateId,
        name,
        ...(task && task.status === "accepted" && typeof task.task.name === "string" ? { taskName: task.task.name } : {}),
      });
    } catch (err     ) {
      taskScheduleWarning(`look offer failed for ${input.taskId}: ${err && err.message ? err.message : err}`);
    }
  }

  function keepTaskPlan(taskId     ) {
    try {
      const kept      = getTaskScheduler().keepPlan(taskId);
      if (kept && kept.status === "rejected") taskScheduleWarning(`keeping the When failed for ${taskId}: ${kept.code}`);
    } catch (err     ) {
      taskScheduleWarning(`keeping the When failed for ${taskId}: ${err && err.message ? err.message : err}`);
    }
  }

  function syncTaskSchedule(taskId     , deleted = false) {
    if (!schedulesHere()) return;
    const scheduler = getTaskScheduler();
    Promise.resolve()
      .then(() => (deleted ? scheduler.onTaskDeleted(taskId) : scheduler.reconcile(taskId)))

      .then(() => notifyLiveuiTasksChanged())
      .catch((err     ) => {
        taskScheduleWarning(`sync failed for ${taskId}: ${err && err.message ? err.message : err}`);
      });
  }

  function taskScheduleWarning(message     ) {
    if (typeof deps.emitLifecycle === "function") {
      deps.emitLifecycle("task_schedule_warning", "warn", { storeId, message: String(message).slice(0, 240) });
    }
  }

  function programCardStore() {
    return createProgramCardFeedStore({ libraryDir: injectedLibraryRoot(), now: deps.now });
  }
  function programCardsOn() {
    const relay      = (deps       ).relay;
    return !!relay && typeof relay.hasClientCapability === "function" &&

      safeBool(() => relay.hasClientCapability("programCardsV1")) === true;
  }
  function programCardWarning(message     ) {
    if (typeof deps.emitLifecycle === "function") {
      deps.emitLifecycle("program_card_link_warning", "warn", { storeId, message: String(message).slice(0, 240) });
    }
  }

  function splitCardLink(input     ) {
    if (!input || typeof input !== "object" || !Object.prototype.hasOwnProperty.call(input, "card")) {
      return { input, link: null };
    }
    const { card, ...rest } = input;
    if (card === null || card === undefined) return { input: rest, link: null };
    if (!programCardsOn()) {
      return {
        refused: {
          status: "rejected",
          code: "program_cards_off",
          message: "Programmable cards are off on the phone. Save the Task without card, and say the card link needs them on.",
        },
      };
    }
    const checked      = programCardLinkFromAgent(card);
    if (checked.status !== "accepted") return { refused: checked };
    return { input: rest, link: checked.link };
  }
  const sameLink = (left     , right     ) => !!left && !!right && left.cardId === right.cardId &&
    JSON.stringify(left.inputs) === JSON.stringify(right.inputs);

  function proposeCardLink(saved     , link     , options      = {}) {
    if (!saved || !["saved", "unchanged"].includes(saved.status) || !saved.task) return saved;
    const store = programCardStore();
    let task = saved.task;
    const taskId = task.taskId;
    const outcome = (cardLink     , nextTask      = task) => ({ ...saved, task: nextTask, cardLink });
    if (!task.versions.pending) {
      if (sameLink(store.read(taskId), link)) return outcome({ status: "unchanged", cardName: link.cardName });
      const opened      = getTaskLibrary().createDraftFromApproved(taskId, {
        expectedDigest: task.digest,
        authoredBy: "agent",
      });
      if (opened.status !== "saved") return opened;
      task = opened.task;
    } else if (options.draftExisted) {
      const current = store.readProposal(taskId);
      if (programCardProposalBoundTo(current, task.versions.pending)) {
        if (sameLink(current, link)) return outcome({ status: "unchanged", cardName: link.cardName });
        if (options.replacePendingDraft !== true) {
          return {
            status: "rejected",
            code: "task_draft_pending",
            message: "The pending Draft already proposes a card link. Ask the user before replacing it, then pass replacePendingDraft: true.",
          };
        }
      }
    }
    let proposed     ;
    try {
      proposed = store.propose(taskId, task.versions.pending, link, { authoredBy: "agent" });
    } catch (err     ) {
      programCardWarning(`card link proposal failed for ${taskId}: ${err && err.message ? err.message : err}`);
      proposed = { status: "rejected", code: "card_link_failed" };
    }
    if (proposed.status !== "accepted") return outcome(proposed, task);
    return outcome({
      status: "proposed",
      cardName: link.cardName,
      values: link.inputs.map((entry     ) => entry.label || entry.key),
      note: "The phone owner approves the card link in Review, with this Draft.",
    }, task);
  }

  function onlyCardLinkEdit(input     ) {
    return Object.keys(input).every((key) => ["taskId", "expectedDigest", "replacePendingDraft"].includes(key));
  }
  function updateDraftWithCardLink(input     , link     , context     ) {
    const before      = getTaskLibrary().read(input.taskId);
    const draftExisted = !!(before && before.status === "accepted" && before.task.versions.pending);
    if (!onlyCardLinkEdit(input)) {
      return proposeCardLink(getTaskLibrary().updateDraft(input, context), link, {
        draftExisted,
        replacePendingDraft: input.replacePendingDraft,
      });
    }
    if (!before || before.status !== "accepted") return before;
    if (typeof input.expectedDigest !== "string" || !input.expectedDigest) {
      return { status: "rejected", code: "task_base_required", message: "expectedDigest is required for every Task edit" };
    }
    if (input.expectedDigest !== before.task.digest) {
      return { status: "rejected", code: "library_conflict", message: "saved item changed since it was read", currentDigest: before.task.digest };
    }
    return proposeCardLink({ status: "saved", task: before.task }, link, {
      draftExisted,
      replacePendingDraft: input.replacePendingDraft,
    });
  }

  function cardLinkBeforeReview(taskId     , action     , shownDigest     ) {
    if (action !== "approve" && action !== "reject") return { proposal: null };
    let proposal      = null;
    try {
      const loaded      = getTaskLibrary().read(taskId);
      const pending = loaded && loaded.status === "accepted" ? loaded.task.versions.pending : null;
      const stored = programCardStore().readProposal(taskId);
      proposal = programCardProposalBoundTo(stored, pending) ? stored : null;
    } catch (_) {
      proposal = null;
    }
    if (action === "approve" && proposal && typeof shownDigest === "string" && shownDigest !== proposal.digest) {
      return { refused: { status: "rejected", code: "card_link_changed" } };
    }
    return { proposal: action === "approve" && proposal && shownDigest === proposal.digest ? proposal : null };
  }
  function cardLinkAfterReview(taskId     , action     , applied     , taskGone     ) {
    if (action !== "approve" && action !== "reject") return null;
    const store = programCardStore();
    let cardLink      = null;
    try {
      if (applied) {
        const bound      = store.bind({ taskId, cardId: applied.cardId, cardName: applied.cardName, inputs: applied.inputs });
        cardLink = bound.status === "accepted" ? "applied" : null;
        if (bound.status !== "accepted") programCardWarning(`card link refused for ${taskId}: ${bound.code}`);
      }
      store.clearProposal(taskId);

      if (taskGone) store.clear(taskId);
    } catch (err     ) {
      programCardWarning(`card link review cleanup failed for ${taskId}: ${err && err.message ? err.message : err}`);
    }
    return cardLink;
  }

  function deleteTask(taskId     , options      = {}) {
    const result = getTaskLibrary().deleteTask(taskId, options);
    if (result && result.status === "deleted") {

      try {
        const store = programCardStore();
        store.clear(taskId);
        store.clearProposal(taskId);
      } catch (err     ) {
        programCardWarning(`card link cleanup failed for ${taskId}: ${err && err.message ? err.message : err}`);
      }

      try {
        getTemplateLibrary().clearOwnerValues(`task.${taskId}`);
      } catch (err     ) {
        taskScheduleWarning(`values cleanup failed for ${taskId}: ${err && err.message ? err.message : err}`);
      }

      syncTaskSchedule(taskId, true);
    }
    return result;
  }

  function deleteTemplate(templateId     , options      = {}) {
    const references      = findLiveuiTasksReferencingTemplate(
      getTaskLibrary(),
      templateId,
    );
    const organization = getLibraryOrganization().removeLibraryItem("template", templateId);
    if (!organization || organization.status !== "saved") return organization;
    const deleted = getTemplateLibrary().delete(templateId, options);
    if (!deleted || deleted.status !== "deleted") return deleted;
    const clearedPreferredTemplateTaskIds      = [];
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

  function deleteSavedCard(appId     ) {
    const organization = getLibraryOrganization().removeLibraryItem("app", appId);
    if (!organization || organization.status !== "saved") return organization;
    return getTemplateLibrary().deleteSavedCard(appId);
  }

  function liveuiGrantsSnapshot() {
    const cfg      = typeof deps.getGlassesUiLiveConfig === "function"
      ? deps.getGlassesUiLiveConfig() || {}
      : {};
    const httpHostPolicy = cfg.httpHostPolicy === "owner-grants"
      ? "owner-grants"
      : "operator-only";
    const state = getLiveuiGrantsStore().load();
    const lists = httpHostPolicy === "owner-grants"
      ? {
          pending: state.pending.map((row     ) => ({ ...row })),
          granted: state.granted.map((row     ) => ({ ...row })),
          denied: state.denied.map((row     ) => ({ ...row })),
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

    validateComposedRefresh,
    attachComposedRefresh,
    prepareComposedRefresh,
    probeComposedRefresh,
    stopComposedRefresh,
    liveuiPrefs() {
      return currentLiveuiPrefs();
    },
    setLiveuiPrefs(patch     ) {
      const before = currentLiveuiPrefs().prefs;
      const saved      = getLiveuiPrefsStore().save(patch);
      if (saved.status !== "saved") return saved;
      cachedLiveuiPrefs = null;
      const after = saved.prefs;

      const flippedOff = before.enabled !== false && after.enabled === false;

      const clearedSessionKeys = flippedOff
        ? surfaceStore.sessionKeys().filter((key     ) => surfaceStore.stackDepth(key) > 0)
        : [];
      if (flippedOff && publicApi) {
        publicApi.drainAll({ result: "preempted", reason: "liveui_disabled" });
      }
      cronEngine.syncRefreshPause();
      return { status: "accepted", prefs: after, clearedSessionKeys };
    },
    liveuiGrantsSnapshot,

    onLiveuiGrantsChanged(listener     ) {
      if (typeof listener !== "function") return () => {};
      liveuiGrantsListeners.add(listener);
      return () => liveuiGrantsListeners.delete(listener);
    },
    onLiveuiTasksChanged(listener     ) {
      if (typeof listener !== "function") return () => {};
      liveuiTasksListeners.add(listener);
      return () => liveuiTasksListeners.delete(listener);
    },

    liveuiHostCheck() {
      const cfg      = typeof deps.getGlassesUiLiveConfig === "function"
        ? deps.getGlassesUiLiveConfig() || {}
        : {};
      return currentHostCheck(cfg);
    },

    grantLiveuiSite(host     ) {
      return grantLiveuiSite(host);
    },

    programCardFeedOutcomes(request      = {}) {
      const card = typeof request.card === "string" ? request.card : "";
      if (!card) return Promise.resolve(null);
      return programCardFeeds.outcomes(card, { sinceMs: request.sinceMs, waitMs: request.waitMs, subscribeWaitMs: request.subscribeWaitMs });
    },

    programCardFeedHealth(card     ) {
      return typeof card === "string" && card ? programCardFeeds.health(card) : [];
    },

    settleProgramCardFeeds(request      = {}) {
      const card = typeof request.card === "string" ? request.card : "";
      if (!card) return Promise.resolve({ feeds: 0, asked: 0, allowed: 0, ready: true, ms: 0 });
      return programCardFeeds.settle(card, {
        askSite: (host        ) => new Promise((resolve) => {
          if (typeof deps.relay.askLiveuiSite !== "function") return resolve("unavailable");
          let status     ;
          try {
            status = deps.relay.askLiveuiSite({
              host,
              what: "card",
              card: typeof request.name === "string" ? request.name : "",
              sessionKey: typeof request.sessionKey === "string" && request.sessionKey ? request.sessionKey : null,
              onAnswer: (answer     ) => {

                if (answer === "allow") grantLiveuiSite(host);
                resolve(answer);
              },
            });
          } catch (_) {
            status = "unavailable";
          }

          if (status !== "asked" && status !== "waiting") resolve(status);
        }),
      });
    },
    applyLiveuiGrantIntent(intent     ) {
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
      let clearedSessionKeys      = [];
      if (intent.action === "deny" || intent.action === "remove") {
        discardHeldConsentRenders(host);

        discardHeldComposedRefreshes(host);
        stopComposedRefreshesForHost(host);
        clearedSessionKeys = cronEngine.sessionKeysForHttpHost(host)
          .filter((key     ) => surfaceStore.stackDepth(key) > 0);
        for (const key of clearedSessionKeys) {
          publicApi.drainSession(key, {
            result: "preempted",
            reason: "refresh_host_revoked",
          });
        }
      } else if (intent.action === "allow") {
        startHeldConsentRenders(host);
        startHeldComposedRefreshes(host);
      }

      programCardFeeds.grantsChanged();
      return {
        status: "accepted",
        ...((intent.action === "deny" || intent.action === "remove")
          ? { clearedSessionKeys }
          : {}),
        snapshot: liveuiGrantsSnapshot(),
      };
    },
    liveuiStatus() {
      const cfg      = typeof deps.getGlassesUiLiveConfig === "function"
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
    validateTemplateSpec(spec     ) {
      const result = validateStaticPlan(spec, {
        includeConnectivity: false,
        stackDepth: 0,
      });
      return {
        ...result.merged,
        normalizedSpec: result.merged.ok ? result.normalizedSpec : null,
      };
    },
    saveTemplate(template     , options      = {}) {
      return getTemplateLibrary().save(template, options);
    },
    readTemplate(templateId     ) {
      return getTemplateLibrary().read(templateId);
    },

    readDeliveredTemplateValues(templateId     , query      = {}) {
      return getTemplateLibrary().readDeliveredValues(templateId, query);
    },

    writeDeliveredTemplateValues(templateId     , delivery     ) {
      return getTemplateLibrary().writeDeliveredValues(templateId, delivery);
    },

    onTaskResultDelivered(result     ) {

      const injected = Reflect.get(deps, "resolveTaskResultLook");
      const resolveLook = typeof injected === "function"
        ? injected
        : (delivered     ) => getTaskScheduler().lookForResult(delivered);

      const resolveTask = (delivered     ) => getTaskScheduler().taskForResult(delivered);
      return getTemplateLibrary().applyTaskResult(result, { resolveLook, resolveTask });
    },
    resolveTemplateHint(templateId     ) {
      return resolvePreferredTemplateHint(templateId);
    },
    listTemplates() {
      return getTemplateLibrary().list();
    },
    listLibrary(options      = {}) {
      return getTemplateLibrary().listItems(options);
    },
    getLibraryOrganization() {
      return currentOrganization();
    },
    currentSurfaceSpecForSession(sessionKey     ) {
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

    readTaskSchedule(taskId     ) {
      return getTaskScheduler().read(taskId);
    },
    setTaskSchedule(taskId     , plan     , options      = {}) {
      return getTaskScheduler().set(taskId, plan, options);
    },
    pauseTaskSchedule(taskId     ) {
      return getTaskScheduler().pause(taskId);
    },
    resumeTaskSchedule(taskId     ) {
      return getTaskScheduler().resume(taskId);
    },
    runTaskScheduleNow(taskId     ) {
      return getTaskScheduler().runNow(taskId);
    },
    reconcileTaskSchedule(taskId     ) {
      return getTaskScheduler().reconcile(taskId);
    },

    async retryUnsyncedTaskSchedules() {
      const scheduler = getTaskScheduler();
      const tried = await scheduler.retryUnsynced();
      await scheduler.resendStale();
      return tried;
    },

    listTaskSchedules() {
      return getTaskScheduler().listForGlasses();
    },

    listVoiceTaskSchedules() {
      return getTaskVoice().listSchedules();
    },
    scheduleTask(input     , context      = {}) {
      return getTaskVoice().scheduleTask(input, context);
    },
    lessenTaskSchedule(action     , input     ) {
      return getTaskVoice().lessen(action, input);
    },

    saveTaskFromSheet(input     , context      = {}) {
      return getTaskSheet().save(input, context);
    },
    runTaskFromSheet(taskId     ) {

      const runs = createTaskRunsWeekStore({ libraryDir: injectedLibraryRoot() });
      const atMs = Date.now();
      try { runs.expectRunNow(taskId, atMs); } catch (_) {  }
      const forget = () => {
        try { runs.forgetRunNow(taskId, atMs); } catch (_) {  }
      };
      return Promise.resolve(getTaskSheet().run(taskId)).then((outcome     ) => {
        if (!outcome || outcome.status !== "accepted" || outcome.state === "job_missing") forget();
        return outcome;
      }, (err     ) => {
        forget();
        throw err;
      });
    },

    taskTestScheduler() {
      try {
        if (typeof deps.scheduledTasksEnabled !== "function" || deps.scheduledTasksEnabled() !== true) return null;
      } catch (_) {
        return null;
      }
      return schedulesHere() ? getTaskScheduler() : null;
    },

    async readTaskPage(taskId     , options      = {}) {
      const taskPage = getTaskPage(options);
      const list = taskPage.list();
      return taskId ? { list, page: await taskPage.page(taskId) } : { list };
    },

    async actOnTaskPage(taskId     , action     , expectedDigest      = null, options      = {}, input      = {}) {
      const taskPage = getTaskPage(options);
      const act = await taskPage.act(taskId, action, expectedDigest, input);
      const list = taskPage.list();

      if (act.status === "done" && action === "delete") return { act, list };
      return { act, list, page: await taskPage.page(taskId) };
    },

    quietTaskFromSheet(taskId     ) {
      return getTaskSheet().quiet(taskId);
    },

    taskForTaskResult(result     ) {
      return schedulesHere() ? getTaskScheduler().taskForResult(result) : null;
    },

    listTaskStarterJobs() {
      return schedulesHere() ? getTaskScheduler().listStarterJobs() : [];
    },

    isTaskScheduleQuiet(taskId     ) {
      return schedulesHere() && getTaskScheduler().isQuiet(taskId);
    },

    setTaskLook(taskId     , look     , options      = {}) {
      return getTaskScheduler().setLook(taskId, look, options);
    },
    saveUiAsHelper(input     , context      = {}) {
      const result = getTaskLibrary().saveUiAsHelper(input, context);

      offerTaskLook(result, input);
      return result;
    },
    createTaskDraft(input     , context      = {}) {
      const split      = splitCardLink(input);
      if (split.refused) return split.refused;
      const saved = getTaskLibrary().createDraft(split.input, context);
      const result = split.link ? proposeCardLink(saved, split.link) : saved;
      if (saved.status === "saved") notifyLiveuiTasksChanged();
      return result;
    },
    updateTaskDraft(input     , context      = {}) {
      const split      = splitCardLink(input);
      if (split.refused) return split.refused;
      if (!split.link) return getTaskLibrary().updateDraft(split.input, context);
      return updateDraftWithCardLink(split.input, split.link, context);
    },
    updateTaskExecutor(taskId     , executor     ) {
      return getTaskLibrary().updateTaskExecutor(taskId, executor);
    },
    setTaskPreferredTemplate(taskId     , templateId     , options      = {}) {
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
    updateTaskContext(taskId     , context     ) {
      return getTaskLibrary().updateTaskContext(taskId, context);
    },
    readTask(taskId     ) {
      return getTaskLibrary().read(taskId);
    },
    listTasks() {
      return getTaskLibrary().list();
    },
    appendTaskRunRecord(record     ) {
      return getTaskRunRecordStore().append(record);
    },
    listTaskRunRecords(taskId     ) {
      return getTaskRunRecordStore().list(taskId);
    },
    findTasks(query     ) {
      return getTaskLibrary().findTasks(query);
    },
    listTasksForPhone(executorStateProvider      = null) {
      const listed = getTaskLibrary().listItems({ executorStateProvider });
      const organizationState = currentOrganization();
      const ordered = orderLiveuiLibraryItems(listed.items, organizationState.organization);
      const tasks      = [];
      const templates      = [];
      const invalid      = [];
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
    reviewTask(params     ) {
      const taskId = params && typeof params.taskId === "string" ? params.taskId : "";
      const action = params && typeof params.action === "string" ? params.action : "";
      const expectedDigest = params && params.expectedDigest;
      const cardLinkDigest = params && typeof params.cardLinkDigest === "string" ? params.cardLinkDigest : null;
      const cardLinkReview      = cardLinkBeforeReview(taskId, action, cardLinkDigest);
      if (cardLinkReview.refused) return { taskId, action, ...cardLinkReview.refused };
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

      const cardLink = cardLinkAfterReview(taskId, action, cardLinkReview.proposal, result.task === null);

      if (action === "approve" && result.task) keepTaskPlan(taskId);

      syncTaskSchedule(taskId);
      return {
        taskId,
        action,
        status: "accepted",
        ...(result.task ? { task: projectTask(result.task) } : {}),
        ...(cardLink ? { cardLink } : {}),
      };
    },
    organizeLibrary(params     ) {
      const action = params && typeof params.action === "string" ? params.action : "";
      const itemType = params && typeof params.itemType === "string" ? params.itemType : "";
      const itemId = params && typeof params.itemId === "string" ? params.itemId : "";
      const expectedDigest = params && params.expectedDigest;
      let result     ;
      if (action === "reorder") {
        result = reorderLibrary({
          expectedDigest,
          order: params && params.order,
        });
      } else if (action === "hide" || action === "show") {
        const row = (currentLibraryItems().items || []).find(
          (entry     ) => entry && entry.itemType === itemType && entry.itemId === itemId,
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
      } else if (action === "delete" && itemType === "app") {
        result = deleteSavedCard(itemId);
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
    async renderStoredTemplate(params     ) {
      const stored = params && params.template;
      if (isLiveuiTemplateComposed(stored)) return renderComposedTemplate(params);
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
        requireViewedSession: params.requireViewedSession === true,
        origin: params.origin,
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
    isCurrentDeclaration(surfaceId     , declarationId     ) {
      return surfaceStore.isCurrentDeclaration(surfaceId, declarationId);
    },
    releaseLibraryTemplateSurface(surfaceId     , outcome     , expectedDeclarationId      = null) {
      if (composedLibraryOpens.has(surfaceId)) {
        return releaseComposedLibraryOpen(surfaceId, outcome && outcome.reason);
      }
      return releaseSurfaceTerminally(surfaceId, outcome, expectedDeclarationId, "library_template_reopen");
    },

    replaySessionTop(rawSessionKey     , reason     ) {
      const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
      const surfaceId = surfaceStore.topSurfaceId(sessionKey);
      if (!surfaceId) return { replayed: false, reason: "no_surface" };
      const facts      = surfaceStore.surfaceFactsFor(surfaceId);
      if (!facts || facts.state === "exiting" || facts.exitLatched) {
        return { replayed: false, surfaceId, reason: "exiting" };
      }
      const wire      = lastWireRenderBySurface.get(surfaceId) || null;
      const recordedSpec = surfaceStore.currentSurfaceSpecForSession(sessionKey);
      const baseSpec = wire ? wire.spec : recordedSpec;
      const sent      = cronEngine.takeValuesForFullResend(surfaceId);
      if (!baseSpec) {
        emitLifecycle("reconnect_replay_skipped", "debug", { sessionKey, surfaceId, reason: "no_spec" });
        return { replayed: false, surfaceId, reason: "no_spec" };
      }
      const spec      = { ...baseSpec };
      if (sent && !sent.templated) {
        if (sent.body !== undefined) spec.body = sent.body;
        if (sent.items !== undefined) spec.items = sent.items;
      }
      paintFloor.enqueue({
        surfaceId,
        sessionKey,
        patch: {
          __render: true,
          __depth: wire ? wire.depth : surfaceStore.stackDepth(sessionKey),
          __spec: spec,
          __recordedSpec: recordedSpec || spec,
          __marker: displayedMarkerFor(surfaceId),

          __origin: wire ? wire.origin : undefined,
          __collect: false,
          __live: cronEngine.isActive(surfaceId),
        },
      });
      emitLifecycle("reconnect_replay", "info", {
        sessionKey,
        surfaceId,
        reason: reason || null,
        source: wire ? "wire" : "recorded",
        cronValues: !!sent,
      });
      return { replayed: true, surfaceId, cronValues: !!sent };
    },
    drainSession(sessionKey     , outcome     ) {
      for (const entry of refreshPreparations) if (entry.sessionKey === normalizeGlassesSessionKey(sessionKey)) entry.controller.abort();
      const reaped = reapSession(sessionKey, outcome);
      exitLatchBySession.delete(normalizeGlassesSessionKey(sessionKey));
      scheduleCompanionSnapshot({ sessionKey });
      return reaped;
    },

    settleSession(sessionKey, outcome) {
      return surfaceStore.settlePending(sessionKey, outcome);
    },
    releaseTerminalTopOnAgentEnd(sessionKey     , outcome     ) {
      const normalizedSessionKey = normalizeGlassesSessionKey(sessionKey);
      const top = surfaceStore.topSurfaceId(normalizedSessionKey);
      const released = top ? releaseTerminalTop(top, outcome, "agent_end") : false;

      exitLatchBySession.delete(normalizedSessionKey);
      surfaceStore.markAgentRunEnded(normalizedSessionKey);
      return released;
    },
    drainAll(outcome) {
      for (const entry of refreshPreparations) entry.controller.abort();
      cronEngine.stopAll(outcome);
      programCardFeeds.stopAll();
      const reaped = surfaceStore.drainAll(outcome);
      for (const sessionKey of surfaceStore.sessionKeys()) {
        surfaceStore.exit(sessionKey);
      }
      navDepthBySession.clear();
      exitLatchBySession.clear();
      scheduleCompanionSnapshot({ sessionKey: companionSessionKey });
      return reaped;
    },
    setGlassesPresence(presence     ) {
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

    deliveryStateOf(surfaceId     ) {
      return readDeliveryState(surfaceId);
    },
    hasClientReceipt(surfaceUuid     , seq     ) {
      return surfaceStore.hasClientReceipt(surfaceUuid, seq);
    },

    snapshotUiState(rawSessionKey     ) {
      const sessionKey = normalizeGlassesSessionKey(rawSessionKey || "main");

      const port      = deps;
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
        .map((id     ) => surfaceStore.surfaceFactsFor(id))
        .filter((f     ) => f !== null);

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

      const facts      = surfaceStore.surfaceFactsFor(topSurfaceId);
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

    collectUiState(rawSessionKey     ) {
      const sessionKey = normalizeGlassesSessionKey(rawSessionKey || "main");
      const channels = publicApi.snapshotUiState(sessionKey);
      const port      = deps.relay;
      if (!port || typeof port.collectLiveUiV2State !== "function") return channels;
      let read      = null;
      try {
        read = port.collectLiveUiV2State(sessionKey);
      } catch (err     ) {
        emitLifecycle("liveui_v2_collect_failed", "warn", {
          sessionKey,
          error: err && err.message ? err.message : String(err),
        });
        return channels;
      }
      return read ? { ...channels, model: attachLiveUiV2Read(channels.model, read) } : channels;
    },
    publishCompanionSnapshot(rawSessionKey     ) {
      return publishCompanionSnapshotNow(rawSessionKey);
    },

    parkMarkerOnAgentEnd(sessionKey) {
      surfaceStore.clearAwaitingResponse(sessionKey);
      const top = surfaceStore.topSurfaceId(sessionKey);
      if (top) emitMarker(sessionKey, top);
    },
    refreshMarkerForAgentTurn(sessionKey     ) {
      const normalizedSessionKey = normalizeGlassesSessionKey(sessionKey);
      const top = surfaceStore.topSurfaceId(normalizedSessionKey);
      if (top && surfaceStore.markerFor(top) === "inflight") {
        emitMarker(normalizedSessionKey, top);
      }
    },

    agentTurnEnded(sessionKey     ) {
      return wakeController.onAgentTurnIdle(sessionKey);
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
  "  marker        — listening | inflight | processing | refreshing | parked.",
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

const TRANSCRIPT_FENCE_TTL_MS = 30_000;

function getRegisteredGlassesUiHandler(scopeHost      = globalThis) {
  return (scopeHost && Reflect.get(scopeHost, HANDLER_SCOPE_SYMBOL))?.handler ?? null;
}

function getRegisteredLiveuiGlassesLibraryController(
  scopeHost      = globalThis,
  options      = {},
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
    nextDepth(rawSessionKey     ) {
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
  const injectedIsEvenAiRun =
    opts && typeof opts === "object" ? Reflect.get(opts, "isEvenAiRun") : undefined;
  const isEvenAiRun = typeof injectedIsEvenAiRun === "function" ? injectedIsEvenAiRun : () => false;

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

  const liveUiAuth = createOpenClawLiveUiAuth(api);

  let lastModel = null;
  let lastKey = "";
  async function prewarmLlmApiKey(modelRef, context      = {}) {
    const cfg = service.getRuntimeConfig?.()?.glassesUiLive || {};
    const prepared = await liveUiAuth.prepare({ modelRef, backend: context.backend || cfg.tickBackend, baseUrl: context.baseUrl || cfg.tickApiBaseUrl, ...context });
    lastModel = prepared.ok ? modelRef : null;
    lastKey = prepared.ok ? prepared.apiKey : "";
    return prepared.ok ? { ok: true } : prepared;
  }
  function resolveLlmApiKeySync(modelRef) {
    return modelRef === lastModel ? lastKey : "";
  }

  let scopeRecord = scopeHost[HANDLER_SCOPE_SYMBOL];
  const createsHandler = !scopeRecord || !scopeRecord.handler;

  let capturedOnGlassesUiResult = null;
  let capturedOnLiveUiV2Outcome = null;
  let capturedOnGlassesUiRenderReceipt = null;
  let capturedOnGlassesUiClientFailure = null;
  let capturedOnGlassesPresenceChanged = null;
  let capturedOnProgramCardFeeds = null;
  const handler = createsHandler ? createGlassesUiToolHandler({
    relay: {
      sendGlassesUiRender: (msg) => service.sendGlassesUiRender(msg),
      sendGlassesUiSurfaceUpdate: (msg) => service.sendGlassesUiSurfaceUpdate(msg),
      onGlassesUiResult: (cb) => {
        capturedOnGlassesUiResult = cb;
        return service.onGlassesUiResult(cb);
      },

      onLiveUiV2Outcome:
        typeof service.onLiveUiV2Outcome === "function"
          ? (cb) => {
              capturedOnLiveUiV2Outcome = cb;
              return service.onLiveUiV2Outcome(cb);
            }
          : undefined,
      collectLiveUiV2State:
        typeof service.collectLiveUiV2State === "function"
          ? (sessionKey) => service.collectLiveUiV2State(sessionKey)
          : undefined,
      isLiveUiV2TapOwed:
        typeof service.isLiveUiV2TapOwed === "function"
          ? (sessionKey, eventId) => service.isLiveUiV2TapOwed(sessionKey, eventId)
          : undefined,

      writeLiveUiV2Data:
        typeof service.writeLiveUiV2Data === "function"
          ? (sessionKey, surfaceId, patch) => service.writeLiveUiV2Data(sessionKey, surfaceId, patch)
          : undefined,

      prefetchLiveUiV2Picture:
        typeof service.prefetchLiveUiV2Picture === "function"
          ? (sessionKey     , surfaceId     , src     , componentId     ) => service.prefetchLiveUiV2Picture(sessionKey, surfaceId, src, componentId)
          : undefined,
      isLiveUiV2SurfaceLive:
        typeof service.isLiveUiV2SurfaceLive === "function"
          ? (sessionKey, surfaceId) => service.isLiveUiV2SurfaceLive(sessionKey, surfaceId)
          : undefined,
      setLiveUiV2Inputs:
        typeof service.setLiveUiV2Inputs === "function"
          ? (sessionKey, surfaceId, inputs, values) => service.setLiveUiV2Inputs(sessionKey, surfaceId, inputs, values)
          : undefined,
      liveUiV2TopSurface:
        typeof service.liveUiV2TopSurface === "function"
          ? (sessionKey, opts) => service.liveUiV2TopSurface(sessionKey, opts)
          : undefined,
      openLiveUiV2Records:
        typeof service.openLiveUiV2Records === "function"
          ? (sessionKey, input) => service.openLiveUiV2Records(sessionKey, input)
          : undefined,
      withdrawLiveUiV2Surface:
        typeof service.withdrawLiveUiV2Surface === "function"
          ? (sessionKey, surfaceId, reason) => service.withdrawLiveUiV2Surface(sessionKey, surfaceId, reason)
          : undefined,

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
      onProgramCardFeeds:
        typeof service.onProgramCardFeeds === "function"
          ? (cb) => {
              capturedOnProgramCardFeeds = cb;
              return service.onProgramCardFeeds(cb);
            }
          : undefined,
      sendProgramCardData:
        typeof service.sendProgramCardData === "function"
          ? (frame) => service.sendProgramCardData(frame)
          : undefined,
      askLiveuiSite:
        typeof service.askLiveuiSite === "function"
          ? (request) => service.askLiveuiSite(request)
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
    executeLlmRecipe: async (recipe     , context     ) => {
      const prepared = await liveUiAuth.prepare({ modelRef: context?.model, backend: context?.backend, baseUrl: context?.baseUrl, signal: context?.signal, sessionKey: context?.sessionKey });
      if (!prepared.ok) return { error: prepared.message, code: prepared.code };
      return executeLlmRecipe(recipe, { ...context, apiKey: prepared.apiKey });
    },

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

    getViewedSessionKeys: () =>
      typeof service.getAppViewedSessionKeys === "function"
        ? service.getAppViewedSessionKeys()
        : null,
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

    scheduledTasksEnabled: () =>
      typeof service.hasConnectedAppClientCapability === "function" &&
      service.hasConnectedAppClientCapability("taskResultPushV1") === true,

    taskScheduleRequest: (identity     ) =>
      typeof service.taskScheduleRequest === "function"
        ? service.taskScheduleRequest(identity)
        : Promise.reject(Object.assign(new Error("capability_unavailable"), { code: "capability_unavailable" })),
    taskScheduleAvailable: () =>
      typeof service.openClawTaskSchedulesAvailable === "function" &&
      service.openClawTaskSchedulesAvailable() === true,

    taskSyncChanged: () => {
      if (typeof service.taskRowsChanged === "function") service.taskRowsChanged();
    },

    taskPageWatchAvailable: () =>
      typeof service.openClawTaskPageWatchAvailable === "function" &&
      service.openClawTaskPageWatchAvailable() === true,

    presentTaskConfirm: (request     ) =>
      typeof service.presentTaskConfirm === "function"
        ? service.presentTaskConfirm(request)
        : { presented: false, reason: "unavailable" },
    now: typeof injectedNow === "function" ? injectedNow : undefined,
    describeToolApprovalBehaviour: (executor     ) => {
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
    const onLogicalSessionReset = ({ sessionKey, reason }     ) => {
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

    const onSessionLeft = ({ sessionKey, nextSessionKey }      = {}) => {
      if (!sessionKey) return;
      const normalizedSessionKey = normalizeGlassesSessionKey(sessionKey);
      const drained = handler.drainSession(normalizedSessionKey, {
        result: "preempted",
        reason: "session_left",
      });
      resetDepth(normalizedSessionKey);
      try {
        if (typeof service.emitGlassesUiLifecycle === "function") {
          service.emitGlassesUiLifecycle("session_left_drain", "info", {
            sessionKey: normalizedSessionKey,
            nextSessionKey: nextSessionKey || null,
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
    const onAgentTurnChanged = ({ sessionKey, busy }     ) => {
      if (!sessionKey) return;
      handler.refreshMarkerForAgentTurn(sessionKey);
      if (busy === false) handler.agentTurnEnded(sessionKey);
    };

    const onAppPresenceChanged = (event     ) => {
      const reason = event && typeof event === "object" ? event.reason : event;
      if (reason !== "grace_resumed") return;
      const viewed =
        typeof service.getAppViewedSessionKeys === "function"
          ? service.getAppViewedSessionKeys()
          : null;
      if (!Array.isArray(viewed)) return;
      for (const sessionKey of viewed) {
        try {
          handler.replaySessionTop(sessionKey, "grace_resumed");
        } catch (err     ) {
          try {
            if (typeof service.emitGlassesUiLifecycle === "function") {
              service.emitGlassesUiLifecycle("reconnect_replay_failed", "warn", {
                sessionKey,
                error: err && err.message ? err.message : String(err),
              });
            }
          } catch (_) {

          }
        }
      }
    };
    scopeRecord = {
      handler,
      refs: 0,
      relayCallbacks: {
        onGlassesUiResult: capturedOnGlassesUiResult,
        onLiveUiV2Outcome: capturedOnLiveUiV2Outcome,
        onGlassesUiRenderReceipt: capturedOnGlassesUiRenderReceipt,
        onGlassesUiClientFailure: capturedOnGlassesUiClientFailure,
        onGlassesPresenceChanged: capturedOnGlassesPresenceChanged,
        onProgramCardFeeds: capturedOnProgramCardFeeds,
        onAppClientDisconnect: onDisconnect,
        onAppClientSessionLeft: onSessionLeft,
        onLogicalSessionReset,
        onGlassesUiNavEvent: onNavEvent,
        onAgentTurnChanged,
        onAppPresenceChanged,
      },
    };
    scopeHost[HANDLER_SCOPE_SYMBOL] = scopeRecord;
    if (typeof service.onAppClientDisconnect === "function") {
      service.onAppClientDisconnect(onDisconnect);
    }
    if (typeof service.onAppClientSessionLeft === "function") {
      service.onAppClientSessionLeft(onSessionLeft);
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
    if (typeof service.onAppPresenceChanged === "function") {
      service.onAppPresenceChanged(onAppPresenceChanged);
    }
  } else if (scopeRecord && scopeRecord.relayCallbacks) {

    const callbacks = scopeRecord.relayCallbacks;
    if (callbacks.onGlassesUiResult) {
      service.onGlassesUiResult(callbacks.onGlassesUiResult);
    }
    if (callbacks.onLiveUiV2Outcome && typeof service.onLiveUiV2Outcome === "function") {
      service.onLiveUiV2Outcome(callbacks.onLiveUiV2Outcome);
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
    if (callbacks.onProgramCardFeeds && typeof service.onProgramCardFeeds === "function") {
      service.onProgramCardFeeds(callbacks.onProgramCardFeeds);
    }
    if (callbacks.onAppClientDisconnect && typeof service.onAppClientDisconnect === "function") {
      service.onAppClientDisconnect(callbacks.onAppClientDisconnect);
    }
    if (callbacks.onAppClientSessionLeft && typeof service.onAppClientSessionLeft === "function") {
      service.onAppClientSessionLeft(callbacks.onAppClientSessionLeft);
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
    if (callbacks.onAppPresenceChanged && typeof service.onAppPresenceChanged === "function") {
      service.onAppPresenceChanged(callbacks.onAppPresenceChanged);
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
    (ctx     ) => {

      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const factorySessionKey = sessionKey || "main";
      return {
        name: COMPOSE_GLASSES_UI_TOOL_NAME,
        description: COMPOSE_GLASSES_UI_TOOL_DESCRIPTION,
        parameters: composeGlassesUiParametersSchema,
        ...(tokenEfficiencyOf(service).glassesUiToolLoading === "direct"
          ? { catalogMode: "direct-only" }
          : {}),
        async execute(toolCallId     , params     , signal     ) {
          if (disposedThisContext) return { content: [{ type: "text", text: JSON.stringify({ status: "refused", code: "refresh_cancelled", message: "This tool registration has stopped; no refresh was started." }) }] };
          if (liveuiSwitchedOff()) throw liveuiDisabledError();
          const result = await composeGlassesUi(service, factorySessionKey, params, {
            callId: typeof toolCallId === "string" ? toolCallId : null,
            handler,
            signal,
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    },
    { name: COMPOSE_GLASSES_UI_TOOL_NAME },
  );

  api.registerTool(
    (ctx     ) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";

      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const factorySessionKey = sessionKey || null;
      return {
        name: "get_glasses_ui_state",
        description: GET_GLASSES_UI_STATE_TOOL_DESCRIPTION,
        parameters: getGlassesUiStateParametersSchema,
        async execute(_toolCallId     , _params     ) {
          if (liveuiSwitchedOff()) return liveuiDisabledContent();
          const resolvedSessionKey = normalizeGlassesSessionKey(factorySessionKey || "main");

          const channels = handler.collectUiState(resolvedSessionKey);
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
    (ctx     ) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const factorySessionKey = sessionKey || null;
      return {
        name: LIVEUI_TEMPLATE_TOOL_NAME,
        description: LIVEUI_TEMPLATE_TOOL_DESCRIPTION,

        parameters: liveuiTemplateToolParametersSchemaFor(
          "lean",
        ),
        async execute(_toolCallId     , params     , signal     ) {
          if (liveuiSwitchedOff()) return liveuiDisabledContent();
          const result = await dispatchLiveuiTemplateOperation(
            handler,
            params,
            async (template     , values     ) => {
              const resolvedSessionKey = normalizeGlassesSessionKey(factorySessionKey || "main");

              if (isLiveuiTemplateComposed(template)) {
                return handler.renderStoredTemplate({ template, values, sessionKey: resolvedSessionKey, signal, origin: "agent" });
              }
              return runLiveuiTemplateRenderLifecycle({
                template,
                values,
                sessionKey: resolvedSessionKey,
                signal,
                depthBySession,
                nextDepth,
                requireViewedSession: true,
                origin: "agent",
                renderStoredTemplate: (renderInput     ) =>
                  handler.renderStoredTemplate(renderInput),
              });
            },

            { v2: true },
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    },
    { name: LIVEUI_TEMPLATE_TOOL_NAME },
  );

  api.registerTool(
    (ctx     ) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey())) {
        return null;
      }
      const agentId = ctx && typeof ctx.agentId === "string" ? ctx.agentId : undefined;
      return {
        name: LIVEUI_TASK_TOOL_NAME,
        description: LIVEUI_TASK_TOOL_DESCRIPTION,
        parameters: liveuiTaskToolParametersSchema,
        async execute(_toolCallId     , params     ) {
          if (liveuiSwitchedOff()) return liveuiDisabledContent();
          const result = await dispatchLiveuiTaskOperation({
            createTaskDraft: (input     ) => handler.createTaskDraft(input, { agentId }),
            updateTaskDraft: (input     ) => handler.updateTaskDraft(input, { agentId }),

            readTask: (taskId     ) => (typeof service.taskReadWithHealth === "function"
              ? service.taskReadWithHealth(handler.readTask(taskId), taskId, () => handler.listTaskRunRecords(taskId))
              : handler.readTask(taskId)),
            listTasks: () => handler.listTasks(),

            check: (input     ) => (typeof service.cardCheck === "function"
              ? service.cardCheck(input, sessionKey, () => handler.listTasks())
              : { status: "rejected", code: "check_unavailable", message: "check is not available here" }),
            findTasks: (query     ) => handler.findTasks(query),
            saveUiAsHelper: (input     ) => handler.saveUiAsHelper(input, {
              sessionKey,
              agentId,
            }),

            feedCard: (input     ) => typeof service.feedProgramCard === "function"
              ? service.feedProgramCard({ sessionKey, values: input.values })
              : { status: "rejected", code: "no_feed_run" },

            listVoiceTaskSchedules: () => handler.listVoiceTaskSchedules(),
            scheduleTask: (input     ) => handler.scheduleTask(input, { agentId, sessionKey }),
            lessenTaskSchedule: (action     , input     ) => handler.lessenTaskSchedule(action, input),
          }, params);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    },
    { name: LIVEUI_TASK_TOOL_NAME },
  );

  const injectedHostVersion =
    opts && typeof opts === "object" ? Reflect.get(opts, "hostVersion") : undefined;
  const hostVersion =
    typeof injectedHostVersion === "string"
      ? injectedHostVersion
      : api.runtime && typeof api.runtime.version === "string"
        ? api.runtime.version
        : "";
  const storeFenceInTranscript = openClawStoresFenceFromWriteHook(hostVersion);
  if (!(scopeRecord.transcriptFences instanceof Map)) scopeRecord.transcriptFences = new Map();
  const transcriptFences = scopeRecord.transcriptFences;
  const nowMs = typeof injectedNow === "function" ? injectedNow : () => Date.now();

  if (typeof api.on === "function") {

    api.on("before_prompt_build", async (event, ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
      if (!sessionKey) return undefined;
      const parts = [];
      let decisionFence = null;
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
      try {

        const evenAiTurn = (() => {
          try {
            return isEvenAiRun(ctx && ctx.runId) === true;
          } catch (_) {
            return false;
          }
        })();
        if (!evenAiTurn && typeof service.takeSurfaceDecisionForPrompt === "function") {

          const prompt = event && typeof event.prompt === "string" ? event.prompt : undefined;
          const current =
            event && typeof event.currentUserMessage === "string" ? event.currentUserMessage : undefined;
          const decided = await service.takeSurfaceDecisionForPrompt(sessionKey, {
            text: prompt,
            ...(current !== undefined && current !== prompt ? { texts: [current] } : {}),
          });

          const v2Fragments =
            typeof service.takeLiveUiV2FenceFragments === "function"
              ? service.takeLiveUiV2FenceFragments(sessionKey)
              : [];
          const fragments = [
            ...(decided && decided.oneLine
              ? [{ kind: "surface_decision", text: decided.oneLine }]
              : []),
            ...(Array.isArray(v2Fragments) ? v2Fragments : []),
          ];
          if (fragments.length) {
            decisionFence = buildLiveuiContextFence(fragments);
          }
          if (decisionFence && storeFenceInTranscript) {
            transcriptFences.set(sessionKey, {
              fence: decisionFence,
              words: [prompt, current].filter((text) => typeof text === "string" && text.trim()),
              at: nowMs(),
            });
          } else {
            transcriptFences.delete(sessionKey);
          }
        }
      } catch (_) {

      }
      if (!parts.length && !decisionFence) return undefined;
      return {
        ...(parts.length ? { appendSystemContext: parts.join("\n\n") } : {}),
        ...(decisionFence ? { appendContext: decisionFence } : {}),
      };
    });

    if (storeFenceInTranscript) {
      api.on("before_message_write", (event     , ctx     ) => {
        try {
          const message = event && event.message;
          if (!message || message.role !== "user") return undefined;
          const sessionKey =
            ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey
              ? ctx.sessionKey
              : event && typeof event.sessionKey === "string" && event.sessionKey
                ? event.sessionKey
                : null;
          if (!sessionKey) return undefined;
          const owed = transcriptFences.get(sessionKey);
          if (!owed) return undefined;
          if (nowMs() - owed.at > TRANSCRIPT_FENCE_TTL_MS) {
            transcriptFences.delete(sessionKey);
            return undefined;
          }
          const stored = appendLiveuiContextFenceToUserMessage(message, owed.fence, owed.words);
          if (!stored) return undefined;
          transcriptFences.delete(sessionKey);
          return { message: stored };
        } catch (_) {

          return undefined;
        }
      });
    }

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

module.exports = { createPendingRenderMap, createSurfaceStore, GLASSES_UI_LIMITS, GLASSES_UI_REFRESH_LIMITS, resolveEffectiveHostCheck, validateRefreshSpec, GLASSES_UI_WINDOW_LIMITS, GLASSES_UI_QUEUE_MODES, glassesUiParametersSchema, glassesUiFlatParametersSchema, glassesUiParametersSchemaFor, validateGlassesUiSpec, GLASSES_UI_TOOL_LAYER_FIELDS, validateGlassesUiInjectSpec, isEvenAiAgentSession, DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS, GATEWAY_DYNAMIC_TOOL_DEFAULT_TIMEOUT_MS, summarizeLiveuiTemplateSpec, SETTLE_ON_DELIVERY_CAP_MS, isCodeModeNestedToolCallId, createGlassesUiToolHandler, getGlassesUiStateParametersSchema, GET_GLASSES_UI_STATE_TOOL_DESCRIPTION, getRegisteredGlassesUiHandler, getRegisteredLiveuiGlassesLibraryController, registerGlassesUiTool };
