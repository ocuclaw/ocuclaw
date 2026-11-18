const OPENCLAW_MANAGEMENT_EVENTS      = {
  cron: "jobs",
  "exec.approval.requested": "approvals",
  "exec.approval.resolved": "approvals",
  "skills.changed": "skills",
  "plugins.changed": "plugins",

  heartbeat: "heartbeat",
  "update.run.changed": "maintenance",
  "update.available": "maintenance",
  "device.pair.requested": "plugins",
  "device.pair.resolved": "plugins",
  "node.pair.requested": "plugins",
  "node.pair.resolved": "plugins",

};

function applyTimingForReloadKind(reloadKind     ) {
  if (reloadKind === "restart") return "restart_required";
  if (reloadKind === "hot" || reloadKind === "none") return "active_now";
  return null;
}

function errorText(error     ) {
  return typeof error?.message === "string" ? error.message : "";
}

function isScopeRefusal(error     ) {
  return error?.code === "FORBIDDEN" || /missing scope|unauthorized role/i.test(errorText(error));
}

function isUnknownMethod(error     ) {
  return error?.code === -32601 || /unknown method|method not found/i.test(errorText(error));
}

function isStaleWrite(error     ) {
  return /changed since last load|base hash (required|unavailable)|approvals changed; reload|no longer matches the loaded version|changed since it was read|skill proposal revision changed/i.test(errorText(error));
}

function hostCode(error     ) {
  return typeof error?.code === "string" && /^[A-Z][A-Z_]*$/.test(error.code) ? error.code : "";
}

function isRateLimited(error     ) {
  return /rate limit exceeded/i.test(errorText(error));
}

class OpenClawManagementError extends Error {
  code     ;

  hostCode     ;

  hostDetails     ;
  hostMessage     ;

  constructor(code     , message = code) {
    super(message);
    this.code = code;
  }
}

function createOpenClawManagementContext(opts     ) {
  const gatewayBridge = opts.gatewayBridge;
  const readHello = typeof opts.getHello === "function" ? opts.getHello : () => null;
  const isConnected = typeof opts.isConnected === "function" ? opts.isConnected : () => false;
  const refused = new Set();
  const reloadKinds = new Map();
  let helloKey      = null;

  function hello() {
    const value = readHello();
    const key = value && typeof value === "object" ? value : null;
    if (key !== helloKey) {
      helloKey = key;
      refused.clear();
      reloadKinds.clear();
    }
    return key;
  }

  function advertisedMethods() {
    const methods = hello()?.methods;
    return Array.isArray(methods) ? methods : null;
  }

  const ctx      = {
    connected: () => isConnected() === true,
    now: typeof opts.now === "function" ? opts.now : () => Date.now(),

    agentTools: opts.agentTools || null,

    agentDefaults: opts.agentDefaults || null,

    taskSchedulesAvailable: () => {
      try {
        return typeof opts.taskSchedulesAvailable === "function" && opts.taskSchedulesAvailable() === true;
      } catch {
        return false;
      }
    },

    taskPagesWatched: () => {
      try {
        return typeof opts.taskPagesWatched === "function" && opts.taskPagesWatched() === true;
      } catch {
        return false;
      }
    },

    advertises(method     ) {
      const methods = advertisedMethods();
      return Boolean(methods && methods.includes(method) && !refused.has(method));
    },
    advertisesAll: (...methods     ) => methods.every((method     ) => ctx.advertises(method)),
    refused: (method     ) => { hello(); return refused.has(method); },

    bootId: () => { const id = hello()?.bootId; return typeof id === "string" && id ? id : null; },

    hostVersion: () => { const version = hello()?.version; return typeof version === "string" && version ? version : null; },

    async call(method     , params      = {}) {
      if (!ctx.connected()) throw new OpenClawManagementError("management_unavailable");
      try {
        return await gatewayBridge.request(method, params);
      } catch (error     ) {
        hello();
        if (isScopeRefusal(error) || isUnknownMethod(error)) {
          refused.add(method);
          throw new OpenClawManagementError("unsupported");
        }
        if (isStaleWrite(error)) throw new OpenClawManagementError("config_changed");
        if (isRateLimited(error)) throw new OpenClawManagementError("rate_limited");

        throw Object.assign(new OpenClawManagementError("management_unavailable"), {
          hostCode: hostCode(error),
          hostDetails: error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : null,
          hostMessage: errorText(error).slice(0, 500),
        });
      }
    },

    async readConfig() {
      const snapshot      = await ctx.call("config.get", {});
      const config = snapshot?.config && typeof snapshot.config === "object" ? snapshot.config
        : snapshot?.parsed && typeof snapshot.parsed === "object" ? snapshot.parsed : {};
      return { config, hash: typeof snapshot?.hash === "string" ? snapshot.hash : null };
    },

    async patchConfig({ patch, baseHash, replacePaths }     ) {
      if (typeof baseHash !== "string" || !baseHash) throw new OpenClawManagementError("config_changed");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new OpenClawManagementError("invalid_request");
      return ctx.call("config.patch", {
        baseHash,
        raw: JSON.stringify(patch),
        ...(Array.isArray(replacePaths) && replacePaths.length > 0 ? { replacePaths } : {}),
      });
    },

    async applyTiming(path     ) {
      hello();
      if (reloadKinds.has(path)) return reloadKinds.get(path);
      if (!ctx.advertises("config.schema.lookup")) return null;
      let timing      = null;
      try {
        const lookup      = await ctx.call("config.schema.lookup", { path });
        timing = applyTimingForReloadKind(lookup?.reloadKind);
      } catch {
        timing = null;
      }
      reloadKinds.set(path, timing);
      return timing;
    },
  };
  return ctx;
}

function unsupportedSection(id     , operations     ) {
  return {
    id,
    operations,
    supports: () => false,
    async handle() {
      throw new OpenClawManagementError("unsupported");
    },
  };
}

module.exports = { OPENCLAW_MANAGEMENT_EVENTS, applyTimingForReloadKind, isScopeRefusal, isUnknownMethod, isStaleWrite, isRateLimited, OpenClawManagementError, createOpenClawManagementContext, unsupportedSection };
