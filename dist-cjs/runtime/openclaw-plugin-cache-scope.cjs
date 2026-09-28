const FRAMES_KEY = Symbol.for("openclaw.pluginInstanceInvocation");
const CACHE_STATE_KEY = Symbol.for("openclaw.pluginCache");
const RETAINERS_KEY = Symbol.for("openclaw.pluginCacheRetainers");
const host = globalThis;

function isRetired(cache) {
  if (!cache || typeof cache !== "object") return false;
  if (cache.retirement) return true;
  const retainers = host[RETAINERS_KEY];
  return !!(retainers && typeof retainers.get === "function" && retainers.get(cache)?.retirement);
}

function liveScope(scope) {
  const chain = [];
  for (let s = scope; s; s = s.parent) chain.push(s);
  let live;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (isRetired(chain[i].cache)) break;
    live = chain[i];
  }
  return live;
}

function outsideRetiredScopeStore(run) {
  const store = host[CACHE_STATE_KEY]?.scope;
  if (!store || typeof store.getStore !== "function" || typeof store.run !== "function") return run();
  const scope = store.getStore();
  if (!scope) return run();
  const live = liveScope(scope);
  if (live === scope) return run();
  if (live) return store.run(live, run);
  return typeof store.exit === "function" ? store.exit(run) : store.run(undefined, run);
}

function outsideRetiredFrameScope(run) {
  const frames = host[FRAMES_KEY];
  if (!frames || typeof frames.getFrame !== "function" || typeof frames.runFrame !== "function") return run();
  const frame = frames.getFrame();
  if (!frame || !frame.cacheScope || typeof frame.withScopes !== "function") return run();
  const scope = liveScope(frame.cacheScope);
  if (scope === frame.cacheScope) return run();
  return frames.runFrame(frame.withScopes({ ...frame, cacheScope: scope }), run);
}

function runOutsideRetiredPluginCache(run) {
  return outsideRetiredScopeStore(() => outsideRetiredFrameScope(run));
}

module.exports = { runOutsideRetiredPluginCache };
