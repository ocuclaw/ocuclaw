const OPENCLAW_RUN_COST_SETTLE_MS = 60_000;

const OPENCLAW_RUN_COST_RETRY_MS = 30_000;
const OPENCLAW_RUN_COST_TRIES = 4;

const record = (value     ) => value !== null && typeof value === "object" && !Array.isArray(value);
const tokenCount = (value     ) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function openClawRunTokens(run     )                {
  const usage = record(run) && record(run.usage) ? run.usage : null;
  if (!usage) return null;
  const parts = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
    .map((key) => tokenCount(usage[key]));
  const total = tokenCount(usage.total_tokens);
  if (parts[0] === null && parts[1] === null) return total;

  return Math.max(parts.reduce((sum        , part) => sum + (part ?? 0), 0), total ?? 0);
}

function cronRunKey(sessionKey     )                                                                       {
  if (typeof sessionKey !== "string") return null;
  const match = /^agent:([^:]+):cron:([^:]+)(?::run:([^:]+))?$/.exec(sessionKey);
  if (!match) return null;
  return { agentId: match[1], jobKey: `agent:${match[1]}:cron:${match[2]}`, sessionId: match[3] ?? null };
}

function openClawSignInKind(authStatus     , provider     )                                    {
  if (typeof provider !== "string" || !provider || !record(authStatus) || !Array.isArray(authStatus.providers)) return null;
  const row = authStatus.providers.find((entry     ) => record(entry) &&
    (entry.provider === provider || entry.authProvider === provider));
  if (!row) return null;
  const types = new Set((Array.isArray(row.profiles) ? row.profiles.filter(record) : []).map((profile     ) => profile.type));
  if (record(row.apiKey)) types.add("api_key");
  if (!types.size) return null;
  if (types.size === 1 && types.has("api_key")) return "api_key";
  if ([...types].every((type) => type === "oauth" || type === "token")) return "subscription";
  return null;
}

function openClawSessionCost(reply     , sessionId     )                {
  if (typeof sessionId !== "string" || !sessionId || !record(reply)) return null;
  const sessions = Array.isArray(reply.sessions) ? reply.sessions : [];
  const entry = sessions.find((row     ) => record(row) && row.sessionId === sessionId);
  if (!entry) return null;
  const usage = record(entry.usage) ? entry.usage : null;
  const cost = usage ? usage.totalCost : null;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;

  const missing = usage.missingCostEntries;
  if (Number.isSafeInteger(missing) && missing > 0) return null;
  return cost;
}

const CHATGPT_PROVIDERS = new Set(["openai", "openai-codex"]);

function openClawRunUsage(run     , signIn                                   ) {
  const tokens = openClawRunTokens(run);
  if (tokens === null) return null;
  if (signIn !== "subscription") return { tokens, cost: "unknown", usd: null };
  const chatgpt = record(run) && CHATGPT_PROVIDERS.has(run.provider);
  return { tokens, cost: "included", usd: null, ...(chatgpt ? { plan: "chatgpt" } : {}) };
}

module.exports = { OPENCLAW_RUN_COST_SETTLE_MS, OPENCLAW_RUN_COST_RETRY_MS, OPENCLAW_RUN_COST_TRIES, openClawRunTokens, cronRunKey, openClawSignInKind, openClawSessionCost, openClawRunUsage };
