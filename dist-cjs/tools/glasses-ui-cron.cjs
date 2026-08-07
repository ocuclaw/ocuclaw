const { substituteTemplate } = require("./glasses-ui-template.cjs");

const DEFAULT_FAILURE_BODY_PREFIX = "⚠ Update failed: ";

const DEFAULT_GLASSES_UI_LIMITS = {
  bodyMax: 1000,
  itemMax: 64,
  detailBodyMax: 200,
  maxItems: 20,
};

const BACKOFF_CAP_MS = 60_000;

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

  const active = new Map();

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

  function makeOutcome(state, extra) {
    const ticks = {
      count: state.tickCount,
      succeeded: state.tickSucceeded,
      failed: state.tickFailed,
      lastSuccessAt: state.lastSuccessAt,
    };
    if (state.tickFailed > 0) ticks.lastFailureAt = state.lastFailureAt;
    const outcome = { ticks, lastBody: state.lastBody, lastItems: state.lastItems };
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
    return result;
  }

  async function runOneTick(state) {
    if (state.resolved) return;
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

      if (state.refresh.onError === "stop") {
        resolveAndClean(state, { result: "recipe_failed" });
        return;
      }
      if (state.consecutiveFailures >= state.refresh.maxConsecutiveFailures) {
        resolveAndClean(state, { result: "recipe_failed" });
        return;
      }
      if (state.refresh.onError === "show_error") {
        const errorBody = DEFAULT_FAILURE_BODY_PREFIX + result.error.slice(0, 100);
        if (state.lastBody !== errorBody) {
          state.lastBody = errorBody;
          emitSurfaceUpdate(state, { body: errorBody });
        }
      }

    } else if (result && Object.prototype.hasOwnProperty.call(result, "output")) {
      state.tickSucceeded += 1;
      state.lastSuccessAt = Date.now();
      state.consecutiveFailures = 0;
      state.failureReason = undefined;
      state.pendingRetryAfterMs = null;
      const substituted = substituteIntoTargets(state.refresh.targets, result.output, state.lastRecipeOutput);
      state.lastRecipeOutput = result.output;
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
      if (changed) {
        emitSurfaceUpdate(state, patch);
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

    if (!state.resolved && !state.isSmokeTest && !state.paused) {
      const base = state.refresh.intervalMs;
      let delay = base;
      if (state.consecutiveFailures > 0) {
        delay = Math.min(base * Math.pow(2, state.consecutiveFailures), BACKOFF_CAP_MS);
      }
      if (Number.isFinite(state.pendingRetryAfterMs) && state.pendingRetryAfterMs > 0) {
        delay = state.pendingRetryAfterMs;
      }
      state.nextTickTimer = setTimeoutFn(() => {
        state.nextTickTimer = null;
        runOneTick(state);
      }, delay);
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

    state.nextTickTimer = setTimeoutFn(() => {
      state.nextTickTimer = null;
      runOneTick(state);
    }, state.refresh.intervalMs);
  }

  return {
    start(params) {
      const state = {
        surfaceId: params.surfaceId,
        sessionKey: params.sessionKey,
        refresh: params.refresh,
        recipe: params.refresh.recipe,
        onResolve: params.onResolve,
        startedAt: Date.now(),
        tickCount: 0,
        tickSucceeded: 0,
        tickFailed: 0,
        consecutiveFailures: 0,
        lastBody: params.seedBody,
        lastItems: params.seedItems,
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
        paused: false,
        pendingRetryAfterMs: null,
      };
      active.set(state.surfaceId, state);

      state.maxDurationArmedAtMs = monotonicNowMs();
      state.maxDurationTimer = setTimeoutFn(() => {

        emitLifecycle("cron_max_duration_reached", "debug", {
          surfaceId: state.surfaceId,
          sessionKey: state.sessionKey,
        });
        resolveAndClean(state, { result: "timeout" });
      }, params.refresh.maxDurationMs);

      runSmokeTest(state).catch((err) => {
        resolveAndClean(state, {
          result: "recipe_failed",
          failureReason: `smoke test threw: ${err && err.message ? err.message : err}`,
        });
      });
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
    _debugState(surfaceId) {
      return active.get(surfaceId);
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
      if (state.nextTickTimer) {
        clearTimeoutFn(state.nextTickTimer);
        state.nextTickTimer = null;
      }

      if (state.maxDurationTimer) {
        clearTimeoutFn(state.maxDurationTimer);
        state.maxDurationTimer = null;
        state.maxDurationRemainingMs = Math.max(
          0,
          state.maxDurationRemainingMs - (monotonicNowMs() - state.maxDurationArmedAtMs),
        );
        state.maxDurationArmedAtMs = null;
      }
      state.paused = true;

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

      if (!state.maxDurationTimer) {
        if (state.maxDurationRemainingMs <= 0) {
          emitLifecycle("cron_resume", "debug", {
            surfaceId,
            found: true,
            resolved: false,
            branch: "max_duration_exhausted",
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
      }
      state.paused = false;
      if (state.nextTickTimer) {
        clearTimeoutFn(state.nextTickTimer);
        state.nextTickTimer = null;
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
        state.nextTickTimer = setTimeoutFn(() => {
          state.nextTickTimer = null;
          runOneTick(state);
        }, intervalMs - elapsed);
      }
      return true;
    },
  };
}

module.exports = { createGlassesUiCronEngine };
