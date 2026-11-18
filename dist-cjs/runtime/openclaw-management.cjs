const { OPENCLAW_MANAGEMENT_SECTIONS } = require("./openclaw-management/sections.cjs");
const { OPENCLAW_MANAGEMENT_EVENTS, OpenClawManagementError, createOpenClawManagementContext } = require("./openclaw-management/shared.cjs");

const CAPABILITY_LIMIT = 100;

const EVENT_THROTTLE_MS = 2000;

function createOpenClawManagement(opts     ) {
  const ctx = createOpenClawManagementContext(opts);
  const sections = Array.isArray(opts.sections) ? opts.sections : OPENCLAW_MANAGEMENT_SECTIONS;
  const readAgents = typeof opts.getAgents === "function" ? opts.getAgents : () => [];
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const lastEventAt = new Map();

  function sectionFor(operation     , scope     ) {
    return sections.find((section     ) =>
      section.operations.some((entry     ) => entry.operation === operation && entry.scope === scope)) || null;
  }

  async function agents() {
    const rows = await readAgents();
    return Array.isArray(rows) ? rows.filter((row     ) => row && typeof row.id === "string" && row.id) : [];
  }

  async function capabilities() {

    if (typeof opts.beforeCapabilities === "function") {
      try {
        await opts.beforeCapabilities();
      } catch {}
    }
    const supported      = [];
    const unsupported      = [];
    for (const section of sections) {
      for (const { operation, scope } of section.operations) {
        if (section.supports(ctx, operation, scope) !== true) {
          unsupported.push({ operation, scope, supported: false });
          continue;
        }
        const row      = { operation, scope, supported: true };
        const timing = typeof section.applyTiming === "function" ? await section.applyTiming(ctx, operation) : null;
        if (timing) row.applyTiming = timing;
        supported.push(row);
      }
    }
    return [...supported, ...unsupported].slice(0, CAPABILITY_LIMIT);
  }

  async function handle(request     ) {
    const identity = {
      requestId: request.requestId,
      operation: request.operation,
      scope: request.scope,
      profileId: request.profileId,
    };
    const section = sectionFor(request.operation, request.scope);
    if (!section || section.supports(ctx, request.operation, request.scope) !== true) {
      return { status: "unsupported", capabilities: [], ...identity };
    }
    try {
      const raw = await section.handle({ ctx, agents, capabilities }, request);
      return { capabilities: [], ...(raw && typeof raw === "object" ? raw : {}), ...identity };
    } catch (error     ) {
      if (!(error instanceof OpenClawManagementError)) throw error;
      if (error.code === "unsupported") return { status: "unsupported", capabilities: [], ...identity };

      if (error.code === "management_unavailable") throw error;
      return { status: "error", errorCode: error.code, capabilities: [], ...identity };
    }
  }

  function eventNotice(eventName     ) {
    const section = Object.hasOwn(OPENCLAW_MANAGEMENT_EVENTS, eventName) ? OPENCLAW_MANAGEMENT_EVENTS[eventName] : null;
    if (!section) return null;
    const at = now();
    if (at - (lastEventAt.get(section) ?? -Infinity) < EVENT_THROTTLE_MS) return null;
    lastEventAt.set(section, at);
    return { section, event: eventName };
  }

  return { handle, capabilities, eventNotice, context: ctx };
}

module.exports = { createOpenClawManagement };
