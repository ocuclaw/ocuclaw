const { mintedHermesSessionKey } = require("./hermes-session-keys.cjs");

const LINK_HOST_HOOK_METHOD = "backend.hook";

function normalizeHostHookFrame(frame) {
  const event =
    frame && frame.event && typeof frame.event === "object" ? frame.event : {};
  const rawCtx =
    frame && frame.ctx && typeof frame.ctx === "object" ? frame.ctx : {};
  const ctx = {};
  if (typeof rawCtx.sessionKey === "string" && rawCtx.sessionKey) {
    ctx.sessionKey = rawCtx.sessionKey;
  } else if (rawCtx.sessionIdentity && typeof rawCtx.sessionIdentity === "object") {
    try {
      ctx.sessionKey = mintedHermesSessionKey(
        rawCtx.sessionIdentity.chatId,
        rawCtx.sessionIdentity.ns,
      );
    } catch {

    }
  }
  if (typeof rawCtx.agentId === "string" && rawCtx.agentId.trim()) {
    ctx.agentId = rawCtx.agentId.trim();
  }

  if (typeof rawCtx.runId === "string" && rawCtx.runId.trim()) {
    ctx.runId = rawCtx.runId.trim();
  }
  return { event, ctx };
}

function createHermesHostHooks(opts) {
  const logger = (opts && opts.logger) || console;
  const listeners = new Map();

  function on(hookName, listener) {
    if (typeof listener !== "function") {
      throw new Error("hostHooks.on requires a listener function");
    }
    let set = listeners.get(hookName);
    if (!set) {
      set = new Set();
      listeners.set(hookName, set);
    }
    set.add(listener);
    return () => off(hookName, listener);
  }

  function off(hookName, listener) {
    const set = listeners.get(hookName);
    if (set) {
      set.delete(listener);
      if (set.size === 0) listeners.delete(hookName);
    }
  }

  function dispatchHookFrame(frame) {
    const name = frame && typeof frame.name === "string" ? frame.name : "";
    if (!name) {
      throw new Error("backend.hook requires a name");
    }
    const set = listeners.get(name);
    if (!set || set.size === 0) return;
    const { event, ctx } = normalizeHostHookFrame(frame);
    for (const listener of Array.from(set)) {
      try {
        listener(event, ctx);
      } catch (err) {
        logger.warn(
          `[hermes-hooks] "${name}" listener threw: ${err && err.message ? err.message : err}`,
        );
      }
    }
  }

  return { on, off, dispatchHookFrame };
}

module.exports = { LINK_HOST_HOOK_METHOD, normalizeHostHookFrame, createHermesHostHooks };
