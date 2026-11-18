const crypto = require("node:crypto");

const TOKEN_USAGE_CATEGORY = "token.usage";

const TOKEN_PRICE_WEIGHTS = Object.freeze({
  openai: Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 }),
  anthropic: Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }),
  default: Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }),
});

const OCUCLAW_TOOL_NAMES = Object.freeze([
  "render_glasses_ui",
  "manage_liveui_templates",
  "manage_liveui_tasks",
  "get_glasses_ui_state",
  "set_session_title",
  "get_evenrealities_device_info",
  "get_current_location",
  "save_glasses_card",
  "ocuclaw_setup",
  "write_glasses_card",
  "ask_glasses_card",
  "glasses_card_command",
  "edit_glasses_card",
  "get_ocuclaw_settings",
  "set_ocuclaw_setting",
  "show_bot_screen",
]);

const CACHE_BOUNDARY = "<!-- OPENCLAW_CACHE_BOUNDARY -->";
const MAX_TRACKED_SESSIONS = 256;

const CATALOG_BRIDGE_TOOLS = new Set(["tool_search", "tool_describe", "tool_call", "tool_search_code"]);

function catalogTarget(params     ) {
  for (const key of ["id", "name", "tool", "toolName"]) {
    const value = params[key];
    if (typeof value === "string" && value.length <= 120) return value;
  }
  return null;
}

function classifyToolError(message     ) {
  const text = String(message || "").toLowerCase();
  if (/abort|cancel/.test(text)) return "aborted";
  if (/timed? ?out|timeout|deadline/.test(text)) return "timeout";
  if (/invalid|validation|schema|required|must be|expected|unknown (field|property|kind)/.test(text)) {
    return "invalid_arguments";
  }
  if (/not connected|disconnected|no (app )?client|unavailable|not (found|registered|available)/.test(text)) {
    return "environment";
  }
  if (/rate limit|429|5\d\d|overloaded|provider/.test(text)) return "provider";
  return "unknown";
}

function count(value     ) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function hash(text     ) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function priceFamilyFor(provider     , model     ) {
  const ref = `${typeof provider === "string" ? provider : ""}/${typeof model === "string" ? model : ""}`.toLowerCase();
  if (/anthropic|claude/.test(ref)) return "anthropic";
  if (/openai|codex|gpt|\bo\d/.test(ref)) return "openai";
  return "default";
}

function weighUsage(usage     , family     ) {
  const weights = Reflect.get(TOKEN_PRICE_WEIGHTS, family) || TOKEN_PRICE_WEIGHTS.default;
  const known = !!(usage && typeof usage === "object");
  const input = count(known && usage.input);
  const cacheRead = count(known && usage.cacheRead);
  const cacheWrite = count(known && usage.cacheWrite);
  const output = count(known && usage.output);
  const promptTokens = input + cacheRead + cacheWrite;
  const weighted =
    input * weights.input +
    cacheRead * weights.cacheRead +
    cacheWrite * weights.cacheWrite +
    output * weights.output;
  return {
    known,
    input,
    cacheRead,
    cacheWrite,
    output,
    cacheHitRate: promptTokens > 0 ? Number((cacheRead / promptTokens).toFixed(4)) : null,
    weightedInputEquivalent: Math.round(weighted),
  };
}

function textLength(content     ) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (typeof block === "string") total += block.length;
      else if (block && typeof block === "object") {
        if (typeof block.text === "string") total += block.text.length;
        else if (typeof block.thinking === "string") total += block.thinking.length;
        else if (block.content !== undefined) total += textLength(block.content);
        else if (block.arguments !== undefined) {
          total += typeof block.arguments === "string"
            ? block.arguments.length
            : safeJsonLength(block.arguments);
        }
      }
    }
    return total;
  }
  if (content && typeof content === "object") return safeJsonLength(content);
  return 0;
}

function safeJsonLength(value     ) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch (_err) {
    return 0;
  }
}

function toolName(tool     ) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name;
  if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  return "";
}

function measureLlmInput(event     ) {
  const systemPrompt = event && typeof event.systemPrompt === "string" ? event.systemPrompt : "";
  const boundaryAt = systemPrompt.indexOf(CACHE_BOUNDARY);
  const stableSystem = boundaryAt >= 0 ? systemPrompt.slice(0, boundaryAt) : systemPrompt;
  const tools = event && Array.isArray(event.tools) ? event.tools : [];
  const ours = new Set(OCUCLAW_TOOL_NAMES);
  let toolChars = 0;
  let ocuclawToolChars = 0;
  const toolNames      = [];
  for (const tool of tools) {
    const size = safeJsonLength(tool);
    const name = toolName(tool);
    toolNames.push(name);
    toolChars += size;
    if (ours.has(name)) ocuclawToolChars += size;
  }
  const history = event && Array.isArray(event.historyMessages) ? event.historyMessages : [];
  const historyChars = { user: 0, assistant: 0, toolResult: 0, other: 0 };
  for (const message of history) {
    const role = message && typeof message.role === "string" ? message.role : "other";
    const size = textLength(message && message.content);
    if (role === "user") historyChars.user += size;
    else if (role === "assistant") historyChars.assistant += size;
    else if (role === "toolResult" || role === "tool") historyChars.toolResult += size;
    else historyChars.other += size;
  }
  const prompt = event && typeof event.prompt === "string" ? event.prompt : "";
  return {
    systemChars: systemPrompt.length,
    systemStableChars: stableSystem.length,
    systemDynamicChars: boundaryAt >= 0 ? systemPrompt.length - boundaryAt : 0,
    toolCount: tools.length,
    toolChars,
    ocuclawToolChars,
    historyMessages: history.length,
    historyChars,
    promptChars: prompt.length,

    toolsHash: hash(toolNames.join("\n") + "\n" + String(toolChars)),
    stableSystemHash: hash(stableSystem),
    systemHash: hash(systemPrompt),
  };
}

function createTokenUsageTelemetry(opts      = {}) {
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};

  const lastPrefixBySession = new Map();

  const totalsBySession = new Map();

  const harnessBySession = new Map();

  const harnessByAgent = new Map();

  function modelKeyOf(provider     , model     ) {
    return typeof provider === "string" && provider && typeof model === "string" && model
      ? `${provider}/${model}`
      : null;
  }

  function agentScopeOf(sessionKey     ) {
    const match = typeof sessionKey === "string" ? /^agent:[^:]+/.exec(sessionKey) : null;
    return match ? match[0] : null;
  }

  function remember(map     , key     , value     ) {
    if (!map.has(key) && map.size >= MAX_TRACKED_SESSIONS) {
      map.delete(map.keys().next().value);
    }
    map.set(key, value);
  }

  function sessionKeyOf(event     , ctx     ) {
    if (ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey) return ctx.sessionKey;
    if (event && typeof event.sessionId === "string" && event.sessionId) return event.sessionId;
    return "";
  }

  function onLlmInput(event     , ctx     ) {
    try {
      const sessionKey = sessionKeyOf(event, ctx);
      emitDebug(TOKEN_USAGE_CATEGORY, "llm_input_sections", "debug",
        { sessionKey, runId: event && event.runId }, () => {
          const measured = measureLlmInput(event);
          const previous = sessionKey ? lastPrefixBySession.get(sessionKey) : null;
          const prefix = {
            toolsHash: measured.toolsHash,
            stableSystemHash: measured.stableSystemHash,
            systemHash: measured.systemHash,
          };
          if (sessionKey) remember(lastPrefixBySession, sessionKey, prefix);
          return {
            provider: event && event.provider,
            model: event && event.model,
            ...measured,
            prefixChanged: previous
              ? {
                tools: previous.toolsHash !== prefix.toolsHash,
                stableSystem: previous.stableSystemHash !== prefix.stableSystemHash,
                system: previous.systemHash !== prefix.systemHash,
              }
              : null,
          };
        });
    } catch (_err) {

    }
  }

  function onLlmOutput(event     , ctx     ) {
    try {
      const sessionKey = sessionKeyOf(event, ctx);
      const family = priceFamilyFor(event && event.provider, event && event.model);
      const weighed = weighUsage(event && event.usage, family);
      const prior = (sessionKey && totalsBySession.get(sessionKey)) || {
        attempts: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, weightedInputEquivalent: 0,
      };
      const totals = {
        attempts: prior.attempts + 1,
        input: prior.input + weighed.input,
        cacheRead: prior.cacheRead + weighed.cacheRead,
        cacheWrite: prior.cacheWrite + weighed.cacheWrite,
        output: prior.output + weighed.output,
        weightedInputEquivalent: prior.weightedInputEquivalent + weighed.weightedInputEquivalent,
      };
      if (sessionKey) remember(totalsBySession, sessionKey, totals);
      if (sessionKey && event && typeof event.harnessId === "string" && event.harnessId) {
        const modelKey = modelKeyOf(event.provider, event.model);
        remember(harnessBySession, sessionKey, { harness: event.harnessId, modelKey });
        const agentScope = agentScopeOf(sessionKey);
        if (agentScope && modelKey) remember(harnessByAgent, `${agentScope}|${modelKey}`, event.harnessId);
      }
      emitDebug(TOKEN_USAGE_CATEGORY, "llm_attempt_usage", "info",
        { sessionKey, runId: event && event.runId }, () => ({
          provider: event && event.provider,
          model: event && event.model,
          harnessId: event && typeof event.harnessId === "string" ? event.harnessId : null,
          trigger: ctx && typeof ctx.trigger === "string" ? ctx.trigger : null,
          priceFamily: family,
          ...weighed,
          session: totals,
        }));
    } catch (_err) {

    }
  }

  function onAfterToolCall(event     , ctx     ) {
    try {
      const sessionKey = sessionKeyOf(event, ctx);
      emitDebug(TOKEN_USAGE_CATEGORY, "tool_call", "debug",
        { sessionKey, runId: event && event.runId }, () => {
          const toolName = event && typeof event.toolName === "string" ? event.toolName : "";
          const params = event && event.params && typeof event.params === "object" ? event.params : {};
          const target = CATALOG_BRIDGE_TOOLS.has(toolName)
            ? catalogTarget(params)
            : null;
          const error = event && typeof event.error === "string" ? event.error : "";
          return {
            toolName,
            target,
            ok: !error,
            errorClass: error ? classifyToolError(error) : null,
            durationMs: event && Number.isFinite(event.durationMs) ? event.durationMs : null,
            resultChars: event && event.result !== undefined ? textLength(
              event.result && typeof event.result === "object" && "content" in event.result
                ? event.result.content
                : event.result,
            ) : 0,
          };
        });
    } catch (_err) {

    }
  }

  function harnessFor(sessionKey     , provider      = undefined, model      = undefined) {
    if (typeof sessionKey !== "string") return null;
    const own = harnessBySession.get(sessionKey);
    const modelKey = modelKeyOf(provider, model);
    if (!modelKey) return own ? own.harness : null;
    if (own && own.modelKey === modelKey) return own.harness;
    const agentScope = agentScopeOf(sessionKey);
    return (agentScope && harnessByAgent.get(`${agentScope}|${modelKey}`)) || null;
  }

  return {
    onLlmInput,
    onLlmOutput,
    onAfterToolCall,
    harnessFor,
    _sessions: () => totalsBySession.size,
  };
}

module.exports = { TOKEN_USAGE_CATEGORY, TOKEN_PRICE_WEIGHTS, OCUCLAW_TOOL_NAMES, classifyToolError, priceFamilyFor, weighUsage, measureLlmInput, createTokenUsageTelemetry };
