const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");

const HEARTBEAT_EVERY_CHOICES = ["0m", "15m", "30m", "1h", "2h", "4h"];
const HEARTBEAT_TARGET_CHOICES = ["owner", "last", "none"];
const SETTINGS_PATH = "agents.defaults.heartbeat";

const WAKE_SINGLETON = Symbol.for("openclaw.sessionEventWake");

const PAUSE_STORE = Symbol.for("ocuclaw.openclaw-management.heartbeat-pause");
const DURATION = /^\d{1,5}(ms|s|m|h|d)?$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const BUSY_REASONS = new Set(["requests-in-flight", "cron-in-progress", "min-spacing", "flood", "not-due", "channel-not-ready"]);

function record(value     ) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function text(value     , max     ) {
  const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f]+/g, " ").trim() : "";
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function digest(value     ) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function failure(code     ) {
  return { status: "error", errorCode: code };
}

function clock(value     , end     ) {
  return typeof value === "string" && (CLOCK.test(value) || (end && value === "24:00"));
}

function heartbeatWindow(raw     ) {
  if (!record(raw) || !clock(raw.start, false) || !clock(raw.end, true)) return "";
  return `${raw.start}-${raw.end}`;
}

function everyOf(block     ) {
  const value = typeof block?.every === "string" ? block.every.trim() : "";
  if (!value) return "default";
  return DURATION.test(value) ? value : "custom";
}

function targetOf(block     ) {
  const value = typeof block?.target === "string" ? block.target.trim() : "";
  if (!value) return { target: "default", channel: "" };
  if (HEARTBEAT_TARGET_CHOICES.includes(value)) return { target: value, channel: "" };
  return { target: "channel", channel: text(value, 64) };
}

function entriesOf(config     ) {
  const entries = config?.agents?.entries;
  return record(entries) ? entries : {};
}

function heartbeatView(config     , agentId     ) {
  const block = record(config?.agents?.defaults?.heartbeat) ? config.agents.defaults.heartbeat : {};
  const entries = entriesOf(config);
  const own = Object.keys(entries).filter((id) => record(entries[id]) && record(entries[id].heartbeat));
  const { target, channel } = targetOf(block);
  const windowText = record(block.activeHours) ? heartbeatWindow(block.activeHours) : "";
  return {
    every: everyOf(block),
    activeHours: !record(block.activeHours) ? "all_day" : windowText || "custom",
    target,
    targetChannel: channel,
    lightContext: block.lightContext === true,
    isolatedSession: block.isolatedSession === true,
    model: text(block.model, 160),
    customPrompt: typeof block.prompt === "string" && block.prompt.trim().length > 0,
    agentOwn: own.includes(agentId),
    otherAgentsOwn: own.filter((id) => id !== agentId).length,
    automationsOff: config?.cron?.enabled === false,
  };
}

function processStore() {
  const holder      = globalThis;
  if (!holder[PAUSE_STORE]) holder[PAUSE_STORE] = { bootId: null, paused: null };
  return holder[PAUSE_STORE];
}

function readHeartbeatPaused(ctx     ) {
  const wake      = (globalThis       )[WAKE_SINGLETON];
  if (wake && typeof wake.areSessionEventWakesEnabled === "function") {
    try {
      const enabled = wake.areSessionEventWakesEnabled();
      if (typeof enabled === "boolean") return !enabled;
    } catch {

    }
  }
  const store = processStore();
  const bootId = ctx.bootId();
  return bootId && store.bootId === bootId && typeof store.paused === "boolean" ? store.paused : null;
}

const STATUS      = { sent: "alert", "ok-empty": "ok", "ok-token": "ok", skipped: "skipped", failed: "failed" };

function reasonKind(reason     ) {
  if (reason === "no-route") return "no_route";
  if (reason === "target-none") return "target_none";
  if (reason === "quiet-hours") return "quiet_hours";
  if (reason === "alerts-disabled") return "alerts_off";
  if (reason === "disabled") return "paused";
  if (reason === "background-work") return "background_work";
  if (reason === "dm-blocked") return "dm_blocked";
  if (BUSY_REASONS.has(reason)) return "busy";
  return "other";
}

function heartbeatLastRun(raw     ) {
  if (!record(raw) || !Object.hasOwn(STATUS, raw.status) || !Number.isFinite(raw.ts) || raw.ts <= 0) return null;
  const last      = { status: STATUS[raw.status], atMs: Math.floor(raw.ts) };
  if (raw.status === "skipped" || raw.status === "failed") last.reason = reasonKind(typeof raw.reason === "string" ? raw.reason : "");
  if (raw.status === "sent") {
    const preview = text(raw.preview, 160);
    if (preview) last.preview = preview;
  }
  const channel = text(raw.channel, 64);
  if (channel && /^[A-Za-z0-9_.:-]+$/.test(channel)) last.channel = channel;
  return last;
}

async function readState(ctx     , agentId     ) {
  const { config, hash } = await ctx.readConfig();
  const view = heartbeatView(config, agentId);
  return { view, hash, revision: digest(["heartbeat", view]) };
}

async function lastRun(ctx     ) {
  if (!ctx.advertises("last-heartbeat")) return null;
  try {
    return heartbeatLastRun(await ctx.call("last-heartbeat", {}));
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && ctx.connected()) return null;
    throw error;
  }
}

async function snapshot(ctx     , state     ) {
  const out      = {
    revision: state.revision,
    ...state.view,
    writable: ctx.advertises("config.patch"),
    canPause: ctx.advertises("set-heartbeats"),
    paused: ctx.advertises("set-heartbeats") ? readHeartbeatPaused(ctx) : null,
    last: await lastRun(ctx),
  };
  const timing = await ctx.applyTiming(SETTINGS_PATH);
  if (timing) out.applyTiming = timing;
  return out;
}

function patchFor(changes     ) {
  const patch      = {};
  if ("every" in changes) patch.every = changes.every === "default" ? null : changes.every;
  if ("target" in changes) patch.target = changes.target;
  if ("activeHours" in changes) {
    if (changes.activeHours === "all_day") patch.activeHours = null;
    else {
      const [start, end] = changes.activeHours.split("-");
      patch.activeHours = { start, end };
    }
  }
  if ("lightContext" in changes) patch.lightContext = changes.lightContext;
  if ("isolatedSession" in changes) patch.isolatedSession = changes.isolatedSession;
  return patch;
}

function validChanges(changes     ) {
  if (!record(changes) || Object.keys(changes).length === 0) return false;
  for (const [name, value] of Object.entries(changes)       ) {
    if (name === "every" && !(value === "default" || HEARTBEAT_EVERY_CHOICES.includes(value))) return false;
    else if (name === "target" && !HEARTBEAT_TARGET_CHOICES.includes(value)) return false;
    else if (name === "activeHours") {
      if (value === "all_day") continue;
      const [start, end, extra] = typeof value === "string" ? value.split("-") : [];
      if (extra !== undefined || !clock(start, false) || !clock(end, true) || start === end) return false;
    } else if ((name === "lightContext" || name === "isolatedSession") && typeof value !== "boolean") return false;
    else if (!["every", "target", "activeHours", "lightContext", "isolatedSession"].includes(name)) return false;
  }
  return true;
}

function writeFailureCode(error     ) {
  if (!(error instanceof OpenClawManagementError)) throw error;
  if (error.code === "config_changed") return "config_changed";
  if (error.code === "rate_limited") return "rate_limited";

  if (error.code === "management_unavailable" && (error       ).hostCode) return "host_refused";
  return "outcome_unknown";
}

async function readAfterWrite(ctx     , agentId     ) {
  try {
    return { status: "ok", heartbeat: await snapshot(ctx, await readState(ctx, agentId)) };
  } catch {

    return failure("outcome_unknown");
  }
}

async function updateHeartbeat(ctx     , request     ) {
  const { revision, changes } = request.heartbeat || {};
  if (!validChanges(changes)) return failure("invalid_request");
  let state     ;
  try {
    state = await readState(ctx, request.profileId);
  } catch (error     ) {
    if (!(error instanceof OpenClawManagementError) || error.code === "unsupported") throw error;
    return failure("native_read_failed");
  }
  if (state.revision !== revision) return failure("config_changed");
  try {
    await ctx.patchConfig({ patch: { agents: { defaults: { heartbeat: patchFor(changes) } } }, baseHash: state.hash });
  } catch (error     ) {
    return failure(writeFailureCode(error));
  }
  return readAfterWrite(ctx, request.profileId);
}

async function pauseHeartbeat(ctx     , request     ) {
  const paused = request.heartbeat?.paused;
  if (typeof paused !== "boolean") return failure("invalid_request");
  try {
    await ctx.call("set-heartbeats", { enabled: !paused });
  } catch (error     ) {
    return failure(writeFailureCode(error));
  }
  const store = processStore();
  store.bootId = ctx.bootId();
  store.paused = paused;
  return readAfterWrite(ctx, request.profileId);
}

const MINUTES_PER_UNIT      = { "": 1, m: 1, h: 60, d: 1440 };

function heartbeatMinutes(every     ) {
  const match = typeof every === "string" ? /^(\d{1,5})(m|h|d)?$/.exec(every) : null;
  return match ? Number(match[1]) * MINUTES_PER_UNIT[match[2] || ""] : null;
}

async function heartbeatSummary(ctx     , agentId     ) {
  if (!ctx.advertises("config.get")) return null;
  try {
    const { view } = await readState(ctx, agentId);
    const summary      = {};
    const minutes = heartbeatMinutes(view.every);
    if (minutes !== null) summary.heartbeatMinutes = minutes;
    const paused = ctx.advertises("set-heartbeats") ? readHeartbeatPaused(ctx) : null;
    if (paused !== null) summary.heartbeatPaused = paused;
    return Object.keys(summary).length > 0 ? summary : null;
  } catch {
    return null;
  }
}

function supportsOperation(ctx     , operation     ) {
  const reads = ctx.advertises("config.get");
  if (operation === "heartbeat.read") return reads;
  if (operation === "heartbeat.update") return reads && ctx.advertises("config.patch");
  if (operation === "heartbeat.pause") return reads && ctx.advertises("set-heartbeats");
  return false;
}

const heartbeatSection = {
  id: "heartbeat",
  operations: [
    { operation: "heartbeat.read", scope: "profile" },
    { operation: "heartbeat.update", scope: "profile" },
    { operation: "heartbeat.pause", scope: "profile" },
  ],
  supports: (ctx     , operation     ) => supportsOperation(ctx, operation),
  async applyTiming(ctx     , operation     ) {
    return operation === "heartbeat.update" ? ctx.applyTiming(SETTINGS_PATH) : null;
  },
  async handle(env     , request     ) {
    const { ctx } = env;
    if (!ctx.connected()) throw new OpenClawManagementError("management_unavailable");
    const agents = await env.agents();
    if (!agents.some((row     ) => row.id === request.profileId)) return failure("profile_not_served");
    switch (request.operation) {
      case "heartbeat.read":
        try {
          return { status: "ok", heartbeat: await snapshot(ctx, await readState(ctx, request.profileId)) };
        } catch (error     ) {
          if (!(error instanceof OpenClawManagementError) || error.code === "unsupported") throw error;
          return failure("native_read_failed");
        }
      case "heartbeat.update":
        return updateHeartbeat(ctx, request);
      case "heartbeat.pause":
        return pauseHeartbeat(ctx, request);
      default:
        throw new OpenClawManagementError("unsupported");
    }
  },
};

module.exports = { HEARTBEAT_EVERY_CHOICES, HEARTBEAT_TARGET_CHOICES, heartbeatWindow, readHeartbeatPaused, heartbeatLastRun, heartbeatMinutes, heartbeatSummary, heartbeatSection };
