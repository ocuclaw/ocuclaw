const { substituteTemplate } = require("./glasses-ui-template.cjs");
const { mapArrayItems } = require("./glasses-ui-array-mapping.cjs");
const { LIVEUI_TEMPLATE_ERROR_PREFIX, fillLiveuiTemplate, liveuiTemplateHasErrorPresentation, readLiveuiTemplateRefreshPath } = require("./glasses-ui-template-slots.cjs");

const DEFAULT_FAILURE_BODY_PREFIX = LIVEUI_TEMPLATE_ERROR_PREFIX;

const DEFAULT_GLASSES_UI_LIMITS = {
  bodyMax: 1000,
  itemMax: 64,
  detailBodyMax: 200,
  maxItems: 20,
  totalDetailPayloadMax: 6 * 1024,
};

const BACKOFF_CAP_MS = 60_000;

const GLASSES_PRESENCE_STATES = Object.freeze([
  "worn",
  "absent",
  "in_case",
  "unknown",
]);

const HTTP_ABSENT_MIN_INTERVAL_MS = 5 * 60_000;

function normalizePresence(value) {
  return GLASSES_PRESENCE_STATES.includes(value) ? value : "unknown";
}

function presenceIsExplicitlyAbsent(value) {
  return value === "absent" || value === "in_case";
}

function refreshTier(recipe) {
  if (recipe && recipe.kind === "llm") return "llm-api";
  if (recipe && recipe.kind === "http") return "http";
  return "local";
}

function createGlassesUiCronEngine(deps) {
  const executeRecipe = deps.executeRecipe;
  const sendSurfaceUpdate = deps.sendSurfaceUpdate;
  const resolveLlmCtx = deps.resolveLlmCtx || (() => ({}));
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;

  const monotonicNowMs =
    typeof deps.monotonicNowMs === "function" ? deps.monotonicNowMs : () => performance.now();
  const limits = deps.glassesUiLimits && typeof deps.glassesUiLimits === "object"
    ? { ...DEFAULT_GLASSES_UI_LIMITS, ...deps.glassesUiLimits }
    : DEFAULT_GLASSES_UI_LIMITS;

  const emitLifecycle =
    typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};

  const includeLastRender =
    typeof deps.includeLastRender === "function"
      ? () => deps.includeLastRender() === true
      : () => deps.includeLastRender === true;
  const validateTemplateSpec = typeof deps.validateTemplateSpec === "function"
    ? deps.validateTemplateSpec
    : ({ spec }) => ({ ok: true, spec });

  const isRefreshPaused = typeof deps.isRefreshPaused === "function"
    ? () => deps.isRefreshPaused() === true
    : () => false;

  const active = new Map();
  let currentPresence = "unknown";

  function isPaused(state) {
    return !!(isRefreshPaused() || state.ownerPaused || state.presencePaused);
  }

  function syncPausedFlag(state) {
    state.paused = isPaused(state);
  }

  function clearNextTick(state) {
    if (state.nextTickTimer) clearTimeoutFn(state.nextTickTimer);
    state.nextTickTimer = null;
  }

  function scheduleNextTick(state, delayMs) {
    clearNextTick(state);
    if (state.resolved || isPaused(state)) return;
    const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : state.refresh.intervalMs);
    state.nextTickTimer = setTimeoutFn(() => {
      state.nextTickTimer = null;
      runOneTick(state);
    }, delay);
  }

  function pauseActiveDuration(state) {
    if (!state.maxDurationTimer) return;
    clearTimeoutFn(state.maxDurationTimer);
    state.maxDurationTimer = null;
    state.maxDurationRemainingMs = Math.max(
      0,
      state.maxDurationRemainingMs - (monotonicNowMs() - state.maxDurationArmedAtMs),
    );
    state.maxDurationArmedAtMs = null;
  }

  function armActiveDuration(state) {
    if (state.resolved || isPaused(state) || state.maxDurationTimer) return true;
    if (state.maxDurationRemainingMs <= 0) {
      emitLifecycle("cron_max_duration_reached", "debug", {
        surfaceId: state.surfaceId,
        sessionKey: state.sessionKey,
      });
      resolveAndClean(state, { result: "timeout" });
      return false;
    }
    state.maxDurationArmedAtMs = monotonicNowMs();
    state.maxDurationTimer = setTimeoutFn(() => {
      emitLifecycle("cron_max_duration_reached", "debug", {
        surfaceId: state.surfaceId,
        sessionKey: state.sessionKey,
      });
      resolveAndClean(state, { result: "timeout" });
    }, state.maxDurationRemainingMs);
    return true;
  }

  function gapOutcome(state) {
    const gapMs = Number.isFinite(state.presenceGapStartedAtMs)
      ? Math.max(0, monotonicNowMs() - state.presenceGapStartedAtMs)
      : 0;
    return Number.isFinite(state.staleAfterMs) && state.staleAfterMs >= 0 && gapMs > state.staleAfterMs
      ? "expired"
      : "queued_with_expiry";
  }

  function effectiveCadenceDelay(state, delayMs) {

    if (state.tier === "http" && state.presenceGapStartedAtMs !== null) {
      return Math.max(delayMs, HTTP_ABSENT_MIN_INTERVAL_MS);
    }
    return delayMs;
  }

  function emitSurfaceUpdate(state, patch) {
    try {
      sendSurfaceUpdate({ sessionKey: state.sessionKey, surfaceId: state.surfaceId, patch });
      emitLifecycle("cron_tick_emit", "debug", {
        surfaceId: state.surfaceId,
        sessionKey: state.sessionKey,
        generationToken: state.generationToken,
        paused: !!state.paused,
      });
    } catch (err) {

      state.tickFailed += 1;
      state.lastFailureAt = Date.now();
      state.failureReason = `relay send failed: ${err && err.message ? err.message : err}`;
      state.consecutiveFailures += 1;
    }
  }

  function staticValuesCopy(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const output = {};
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        output[key] = descriptor.value;
      }
    }
    return output;
  }

  function prepareTemplateSpec(state, values, error, overrides = {}) {
    const filled = fillLiveuiTemplate(
      state.templateRuntime.template,
      values,
      error === undefined ? {} : { error },
    );
    if (Array.isArray(filled.invalid) && filled.invalid.length > 0) {
      return {
        ok: false,
        code: "slot_value_invalid",
        message: filled.invalid.map((entry) => entry.key).join(", "),
      };
    }
    const validation = validateTemplateSpec({
      spec: { ...filled.spec, ...overrides },
      sessionKey: state.sessionKey,
      surfaceId: state.surfaceId,
    });
    if (!validation || validation.ok !== true || !validation.spec) {
      return {
        ok: false,
        code: validation && validation.code ? validation.code : "template_spec_invalid",
        message: validation && validation.message
          ? validation.message
          : "filled Template failed Engine validation",
      };
    }
    return { ok: true, status: filled.status, spec: validation.spec };
  }

  function specsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function emitTemplateSpec(state, prepared) {
    if (specsEqual(state.lastSpec, prepared.spec)) return;
    state.lastSpec = prepared.spec;
    state.lastBody = prepared.spec.body;
    state.lastItems = prepared.spec.items;
    try {
      deps.sendSurfaceRender({
        sessionKey: state.sessionKey,
        surfaceId: state.surfaceId,
        depth: state.wireDepth,
        spec: prepared.spec,
      });
      emitLifecycle("cron_tick_emit", "debug", {
        surfaceId: state.surfaceId,
        sessionKey: state.sessionKey,
        generationToken: state.generationToken,
        paused: !!state.paused,
        templateStatus: prepared.status,
      });
    } catch (err) {
      state.tickFailed += 1;
      state.lastFailureAt = Date.now();
      state.failureReason = `relay send failed: ${err && err.message ? err.message : err}`;
      state.consecutiveFailures += 1;
    }
  }

  function emitTemplateErrorPresentation(state, error) {
    if (!state.templateRuntime ||
        !liveuiTemplateHasErrorPresentation(state.templateRuntime.template) ||
        typeof deps.sendSurfaceRender !== "function") return false;
    const prepared = prepareTemplateSpec(state, state.templateValues, error);
    if (!prepared.ok) return false;
    emitTemplateSpec(state, prepared);
    return true;
  }

  function describeLastRender(state) {
    const hasBody = typeof state.lastBody === "string";
    const items = Array.isArray(state.lastItems) ? state.lastItems : null;
    const hasDetail =
      !!items && items.some((i) => i && typeof i === "object" && typeof i.body === "string");
    const desc = {
      kind: items ? (hasDetail ? "list_with_details" : "list") : hasBody ? "text" : "unknown",
    };
    if (hasBody) desc.body_chars = state.lastBody.length;
    if (items) desc.item_count = items.length;
    return desc;
  }

  function makeOutcome(state, extra) {
    const ticks = {
      count: state.tickCount,
      succeeded: state.tickSucceeded,
      failed: state.tickFailed,
      lastSuccessAt: state.lastSuccessAt,
    };
    if (state.tickFailed > 0) ticks.lastFailureAt = state.lastFailureAt;
    const outcome = { ticks, last_render: describeLastRender(state) };

    if (includeLastRender()) {
      outcome.lastBody = state.lastBody;
      outcome.lastItems = state.lastItems;
    }
    if (state.failureReason) outcome.failureReason = state.failureReason;
    return Object.assign({}, outcome, extra);
  }

  function resolveAndClean(state, extra, opts) {
    if (state.resolved) return;
    state.resolved = true;
    if (state.nextTickTimer) clearTimeoutFn(state.nextTickTimer);
    if (state.maxDurationTimer) clearTimeoutFn(state.maxDurationTimer);
    state.nextTickTimer = null;
    state.maxDurationTimer = null;
    active.delete(state.surfaceId);

    if (opts && opts.silent === true) return;
    try {
      state.onResolve(makeOutcome(state, extra));
    } catch (_) {

    }
  }

  function wrapForTemplate(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...value, output: value };
    }
    return { output: value };
  }

  function substituteOneItemTemplate(tpl, dataForTemplate, opts) {

    if (tpl && typeof tpl === "object" && !Array.isArray(tpl)) {
      const labelRaw =
        typeof tpl.label === "string" ? substituteTemplate(tpl.label, dataForTemplate, opts) : "";
      const out = { label: typeof labelRaw === "string" ? labelRaw.slice(0, limits.itemMax) : "" };
      if (typeof tpl.body === "string") {
        const bodyRaw = substituteTemplate(tpl.body, dataForTemplate, opts);
        const cap = limits.detailBodyMax || limits.itemMax;
        out.body = typeof bodyRaw === "string" ? bodyRaw.slice(0, cap) : bodyRaw;
      }
      return out;
    }
    const it = substituteTemplate(tpl, dataForTemplate, opts);
    return typeof it === "string" ? it.slice(0, limits.itemMax) : it;
  }

  function itemsEqual(prev, next) {
    if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return false;
    for (let i = 0; i < prev.length; i += 1) {
      const a = prev[i];
      const b = next[i];
      if (typeof a === "string" || typeof b === "string") {
        if (a !== b) return false;
      } else if (a && b && typeof a === "object" && typeof b === "object") {
        if (a.label !== b.label || a.body !== b.body) return false;
      } else {
        return false;
      }
    }
    return true;
  }

  function substituteIntoTargets(targets, output, previousOutput) {
    const opts =
      previousOutput !== undefined ? { previous: wrapForTemplate(previousOutput) } : undefined;
    const dataForTemplate = wrapForTemplate(output);
    const result = {};
    if (typeof targets.body === "string") {
      const body = substituteTemplate(targets.body, dataForTemplate, opts);

      result.body = typeof body === "string" ? body.slice(0, limits.bodyMax) : body;
    }
    if (Array.isArray(targets.items)) {

      result.items = targets.items
        .slice(0, limits.maxItems)
        .map((tpl) => substituteOneItemTemplate(tpl, dataForTemplate, opts));
    }
    if (typeof targets.itemsFromPath === "string" && targets.itemTemplate) {
      const mapped = mapArrayItems({
        output,
        previousOutput,
        itemsFromPath: targets.itemsFromPath,
        itemTemplate: targets.itemTemplate,
        surfaceKind: targets.surfaceKind,
        limits,
      });
      if (!mapped.ok) return mapped;
      result.items = mapped.items;
      result.diagnostics = mapped.diagnostics;
    }
    return { ok: true, ...result };
  }

  async function runOneTick(state) {
    if (state.resolved || isPaused(state)) return;
    state.lastTickAt = monotonicNowMs();
    const tickGeneration = state.generationToken;
    state.tickCount += 1;
    let result;
    try {
      const ctx =
        state.recipe.kind === "llm" ? resolveLlmCtx(state) : null;
      result = await executeRecipe(state.recipe, ctx);
    } catch (err) {
      result = { error: `recipe threw: ${err && err.message ? err.message : err}` };
    }

    if (state.resolved) return;

    if (tickGeneration !== state.generationToken) {
      return;
    }

    if (result && typeof result.error === "string") {
      state.tickFailed += 1;
      state.lastFailureAt = Date.now();
      state.failureReason = result.error;
      state.consecutiveFailures += 1;
      state.pendingRetryAfterMs = Number.isFinite(result && result.retryAfterMs)
        ? result.retryAfterMs
        : null;

      const templateErrorShown = emitTemplateErrorPresentation(state, result.error);

      if (state.refresh.onError === "stop") {
        resolveAndClean(state, { result: "recipe_failed" });
        return;
      }
      if (state.consecutiveFailures >= state.refresh.maxConsecutiveFailures) {
        resolveAndClean(state, { result: "recipe_failed" });
        return;
      }
      if (state.refresh.onError === "show_error" && !templateErrorShown) {
        const errorBody = DEFAULT_FAILURE_BODY_PREFIX + result.error.slice(0, 100);
        if (state.lastBody !== errorBody) {
          state.lastBody = errorBody;
          emitSurfaceUpdate(state, { body: errorBody });
        }
      }

    } else if (result && Object.prototype.hasOwnProperty.call(result, "output")) {
      const substituted = substituteIntoTargets(
        { ...state.refresh.targets, surfaceKind: state.surfaceKind },
        result.output,
        state.lastRecipeOutput,
      );
      if (substituted.ok && state.templateRuntime &&
          typeof state.refresh.targets.slot === "string") {
        const slotValue = readLiveuiTemplateRefreshPath(
          result.output,
          state.refresh.targets.path,
        );
        const nextValues = {
          ...staticValuesCopy(state.templateValues),
          [state.refresh.targets.slot]: slotValue,
        };
        const overrides = {};
        if (substituted.body !== undefined) overrides.body = substituted.body;
        if (substituted.items !== undefined) overrides.items = substituted.items;
        const prepared = prepareTemplateSpec(state, nextValues, undefined, overrides);
        if (!prepared.ok) {
          substituted.ok = false;
          substituted.code = prepared.code;
          substituted.message = prepared.message;
        } else {
          substituted.templatePrepared = prepared;
          substituted.templateValues = nextValues;
        }
      }
      if (!substituted.ok) {
        state.tickFailed += 1;
        state.lastFailureAt = Date.now();
        state.failureReason = `${substituted.code}: ${substituted.message}`;
        state.consecutiveFailures += 1;
        state.pendingRetryAfterMs = null;
        emitLifecycle("cron_items_mapping_diagnostic", "warn", {
          surfaceId: state.surfaceId,
          sessionKey: state.sessionKey,
          code: substituted.code,
        });
        const templateErrorShown = emitTemplateErrorPresentation(state, state.failureReason);
        if (state.refresh.onError === "show_error" && !templateErrorShown) {
          const errorBody = DEFAULT_FAILURE_BODY_PREFIX + state.failureReason.slice(0, 100);
          if (state.lastBody !== errorBody) {
            state.lastBody = errorBody;
            emitSurfaceUpdate(state, { body: errorBody });
          }
        }
        if (state.refresh.onError === "stop" || state.consecutiveFailures >= state.refresh.maxConsecutiveFailures) {
          resolveAndClean(state, { result: "recipe_failed" });
          return;
        }
      } else {
        state.tickSucceeded += 1;
        state.lastSuccessAt = Date.now();
        state.consecutiveFailures = 0;
        state.failureReason = undefined;
        state.pendingRetryAfterMs = null;
        state.lastRecipeOutput = result.output;
        if (substituted.templatePrepared) {
          state.templateValues = substituted.templateValues;
          emitTemplateSpec(state, substituted.templatePrepared);
        }
        const patch = {};
        let changed = false;
        if (substituted.body !== undefined && substituted.body !== state.lastBody) {
          patch.body = substituted.body;
          state.lastBody = substituted.body;
          changed = true;
        }
        if (substituted.items !== undefined) {
          if (!itemsEqual(state.lastItems, substituted.items)) {
            patch.items = substituted.items;
            state.lastItems = substituted.items;
            changed = true;
          }
        }
        if (changed && !substituted.templatePrepared) {
          emitSurfaceUpdate(state, patch);
        }
        for (const diagnostic of substituted.diagnostics || []) {
          emitLifecycle("cron_items_mapping_diagnostic", "debug", {
            surfaceId: state.surfaceId,
            sessionKey: state.sessionKey,
            ...diagnostic,
          });
        }
      }
    } else {
      state.tickFailed += 1;
      state.failureReason = "recipe returned no output";
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= state.refresh.maxConsecutiveFailures) {
        resolveAndClean(state, { result: "recipe_failed" });
        return;
      }
    }

    if (!state.resolved && !state.isSmokeTest && !isPaused(state)) {
      const base = state.refresh.intervalMs;
      let delay = base;
      if (state.consecutiveFailures > 0) {
        delay = Math.min(base * Math.pow(2, state.consecutiveFailures), BACKOFF_CAP_MS);
      }
      if (Number.isFinite(state.pendingRetryAfterMs) && state.pendingRetryAfterMs > 0) {
        delay = state.pendingRetryAfterMs;
      }
      scheduleNextTick(state, effectiveCadenceDelay(state, delay));
    }
  }

  async function runSmokeTest(state) {
    state.isSmokeTest = true;
    await runOneTick(state);
    state.isSmokeTest = false;
    if (state.resolved) return;

    if (state.tickFailed > 0) {
      resolveAndClean(state, { result: "recipe_failed" });
      return;
    }

    scheduleNextTick(state, effectiveCadenceDelay(state, state.refresh.intervalMs));
  }

  function runImmediateRefresh(state) {

    if (state.tickCount === 0) {
      runSmokeTest(state).catch((err) => {
        resolveAndClean(state, {
          result: "recipe_failed",
          failureReason: `smoke test threw: ${err && err.message ? err.message : err}`,
        });
      });
      return;
    }
    runOneTick(state);
  }

  return {
    start(params) {
      const state = {
        surfaceId: params.surfaceId,
        sessionKey: params.sessionKey,
        refresh: params.refresh,
        surfaceKind: params.surfaceKind,
        recipe: params.refresh.recipe,
        onResolve: params.onResolve,
        startedAt: Date.now(),
        tickCount: 0,
        tickSucceeded: 0,
        tickFailed: 0,
        consecutiveFailures: 0,
        lastBody: params.seedBody,
        lastItems: params.seedItems,
        lastSpec: params.seedSpec,
        wireDepth: Number.isFinite(params.wireDepth) ? params.wireDepth : 1,
        templateRuntime: params.templateRuntime || null,
        templateValues: staticValuesCopy(
          params.templateRuntime && params.templateRuntime.values,
        ),
        lastRecipeOutput: undefined,
        lastSuccessAt: undefined,
        lastFailureAt: undefined,
        failureReason: undefined,
        resolved: false,
        nextTickTimer: null,
        maxDurationTimer: null,

        maxDurationRemainingMs: params.refresh.maxDurationMs,
        maxDurationArmedAtMs: null,
        isSmokeTest: false,
        lastTickAt: null,
        generationToken: 0,
        ownerPaused: false,
        presencePaused: false,
        paused: false,
        pendingRetryAfterMs: null,
        tier: refreshTier(params.refresh.recipe),
        staleAfterMs: Number.isFinite(params.staleAfterMs) ? params.staleAfterMs : null,
        presenceGapStartedAtMs: null,
        presenceGapOutcome: null,
        presenceCatchUpPending: false,
      };
      active.set(state.surfaceId, state);

      syncPausedFlag(state);
      if (presenceIsExplicitlyAbsent(currentPresence) && state.tier !== "local") {
        state.presenceGapStartedAtMs = monotonicNowMs();
        state.presenceGapOutcome = "queued_with_expiry";
        state.presenceCatchUpPending = true;
        if (state.tier === "llm-api") state.presencePaused = true;
        syncPausedFlag(state);
        emitLifecycle("cron_presence_gap", "debug", {
          surfaceId: state.surfaceId,
          sessionKey: state.sessionKey,
          presence: currentPresence,
          tier: state.tier,
          policy: state.tier === "llm-api" ? "paused" : "deep_throttled",
          outcome: "queued_with_expiry",
        });
      }

      armActiveDuration(state);

      if (!isPaused(state)) {
        runSmokeTest(state).catch((err) => {
          resolveAndClean(state, {
            result: "recipe_failed",
            failureReason: `smoke test threw: ${err && err.message ? err.message : err}`,
          });
        });
      }
    },
    stop(surfaceId, outcome, opts) {
      const state = active.get(surfaceId);
      if (!state) return false;
      resolveAndClean(state, outcome || { result: "preempted" }, opts);
      return true;
    },
    stopAllForSession(sessionKey, outcome) {
      const matches = [];
      for (const [sid, state] of active) {
        if (state.sessionKey === sessionKey) matches.push(sid);
      }
      for (const sid of matches) this.stop(sid, outcome);
      return matches.length;
    },
    stopAll(outcome) {
      const ids = [...active.keys()];
      for (const sid of ids) this.stop(sid, outcome);
      return ids.length;
    },
    activeCount() {
      return active.size;
    },
    isActive(surfaceId) {
      return active.has(surfaceId);
    },
    sessionKeysForHttpHost(host) {
      const keys = new Set();
      for (const state of active.values()) {
        if (!state.recipe || state.recipe.kind !== "http") continue;
        let recipeHost = "";
        try { recipeHost = new URL(state.recipe.url).hostname; } catch (_) {}
        if (recipeHost === host) keys.add(state.sessionKey);
      }
      return [...keys];
    },
    _debugState(surfaceId) {
      return active.get(surfaceId);
    },

    snapshotOf(surfaceId) {
      const state = active.get(surfaceId);
      if (!state) {
        return { active: false, paused: false, ticks: null, lastRender: null };
      }
      const ticks = {
        count: state.tickCount,
        succeeded: state.tickSucceeded,
        failed: state.tickFailed,
        lastSuccessAt: state.lastSuccessAt,
      };
      if (state.tickFailed > 0) ticks.lastFailureAt = state.lastFailureAt;
      return {
        active: true,
        paused: isPaused(state),
        ticks,
        lastRender: describeLastRender(state),
        presence: {
          state: currentPresence,
          tier: state.tier,
          policy: state.presencePaused
            ? "paused"
            : state.tier === "http" && state.presenceGapStartedAtMs !== null
              ? "deep_throttled"
              : "active",
          gap: state.presenceGapOutcome,
        },
      };
    },

    syncRefreshPause() {
      const paused = isRefreshPaused();
      for (const state of active.values()) {
        if (state.resolved) continue;
        const wasPaused = state.paused;
        syncPausedFlag(state);
        if (state.paused && !wasPaused) {
          clearNextTick(state);
          pauseActiveDuration(state);
          state.generationToken += 1;
        } else if (!state.paused && wasPaused) {
          if (armActiveDuration(state)) scheduleNextTick(state, state.refresh.intervalMs);
        }
      }
      emitLifecycle("cron_refresh_pause_sync", "debug", { paused, surfaces: active.size });
      return paused;
    },
    bumpGeneration(surfaceId) {
      const state = active.get(surfaceId);
      if (!state) return false;
      state.generationToken += 1;
      return true;
    },
    pause(surfaceId) {
      const state = active.get(surfaceId);
      if (!state || state.resolved) {
        emitLifecycle("cron_pause", "debug", {
          surfaceId,
          found: !!state,
          resolved: !!(state && state.resolved),
        });
        return false;
      }
      const wasPaused = isPaused(state);
      clearNextTick(state);

      if (!wasPaused) pauseActiveDuration(state);
      state.ownerPaused = true;
      syncPausedFlag(state);

      state.generationToken += 1;
      emitLifecycle("cron_pause", "debug", { surfaceId, found: true, resolved: false });
      return true;
    },
    resume(surfaceId) {
      const state = active.get(surfaceId);
      if (!state || state.resolved) {
        emitLifecycle("cron_resume", "debug", {
          surfaceId,
          found: !!state,
          resolved: !!(state && state.resolved),
          branch: "noop",
        });
        return false;
      }
      state.ownerPaused = false;
      syncPausedFlag(state);
      if (isPaused(state)) {
        emitLifecycle("cron_resume", "debug", {
          surfaceId,
          found: true,
          resolved: false,
          branch: "presence_blocked",
        });
        return true;
      }
      if (!armActiveDuration(state)) return false;
      clearNextTick(state);
      if (state.presenceCatchUpPending && currentPresence === "worn") {
        state.presenceCatchUpPending = false;
        runImmediateRefresh(state);
        return true;
      }
      const lastTickAt = Number.isFinite(state.lastTickAt) ? state.lastTickAt : 0;
      const elapsed = monotonicNowMs() - lastTickAt;
      const intervalMs = state.refresh.intervalMs;
      emitLifecycle("cron_resume", "debug", {
        surfaceId,
        found: true,
        resolved: false,
        elapsedMs: Math.round(elapsed),
        intervalMs,
        branch: elapsed >= intervalMs ? "refire" : "schedule",
      });
      if (elapsed >= intervalMs) {

        runOneTick(state);
      } else {
        scheduleNextTick(state, effectiveCadenceDelay(state, intervalMs - elapsed));
      }
      return true;
    },
    setPresence(value) {
      const next = normalizePresence(value);
      const prior = currentPresence;
      currentPresence = next;
      if (next === prior) return 0;
      let changed = 0;
      for (const state of active.values()) {
        if (state.resolved || state.tier === "local") continue;
        if (presenceIsExplicitlyAbsent(next)) {
          if (state.presenceGapStartedAtMs === null) {
            state.presenceGapStartedAtMs = monotonicNowMs();
            state.presenceGapOutcome = "queued_with_expiry";
            state.presenceCatchUpPending = true;
            emitLifecycle("cron_presence_gap", "debug", {
              surfaceId: state.surfaceId,
              sessionKey: state.sessionKey,
              presence: next,
              tier: state.tier,
              policy: state.tier === "llm-api" ? "paused" : "deep_throttled",
              outcome: "queued_with_expiry",
            });
          }
          if (state.tier === "llm-api" && !state.presencePaused) {
            const wasPaused = isPaused(state);
            state.presencePaused = true;
            syncPausedFlag(state);
            clearNextTick(state);
            if (!wasPaused) pauseActiveDuration(state);
            state.generationToken += 1;
          } else if (state.tier === "http" && !state.isSmokeTest) {
            scheduleNextTick(state, HTTP_ABSENT_MIN_INTERVAL_MS);
          }
          changed += 1;
          continue;
        }

        if (next !== "worn" || state.presenceGapStartedAtMs === null) continue;
        state.presenceGapOutcome = gapOutcome(state);
        state.presencePaused = false;
        syncPausedFlag(state);
        const deferredByOwner = state.ownerPaused;
        emitLifecycle("cron_presence_resume", "debug", {
          surfaceId: state.surfaceId,
          sessionKey: state.sessionKey,
          presence: next,
          tier: state.tier,
          gapOutcome: state.presenceGapOutcome,
          refresh: deferredByOwner ? "deferred_until_visible" : "immediate_silent",
        });
        state.presenceGapStartedAtMs = null;

        state.presenceGapOutcome = null;
        if (!deferredByOwner) {
          if (!armActiveDuration(state)) continue;
          clearNextTick(state);

          state.presenceCatchUpPending = false;
          runImmediateRefresh(state);
        }
        changed += 1;
      }
      return changed;
    },
    getPresence() {
      return currentPresence;
    },
  };
}

module.exports = { createGlassesUiCronEngine };
