function normalizeAgentCreateSetup(input) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid agent setup.");
  const allowed = ["instructions", "model", "provider", "workspace", "blockedTools"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unsupported agent setting.");
  const result = {};
  for (const [key, limit] of Object.entries({ instructions: 8000, model: 200, provider: 100, workspace: 500 })) {
    const value = input[key] ?? "";
    if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error(`Invalid ${key}.`);
    result[key] = value.trim();
  }
  if (result.workspace && !/^(\/|~\/)/.test(result.workspace)) throw new Error("Use an absolute folder path or ~/.");
  if (/[\r\n]/.test(result.workspace)) throw new Error("Use one line for the folder.");
  if (Boolean(result.model) !== Boolean(result.provider)) throw new Error("Choose a model and its provider.");
  const blocked = input.blockedTools ?? [];
  if (!Array.isArray(blocked) || blocked.length > 3 || blocked.some(x => !["web", "files", "terminal"].includes(x))) {
    throw new Error("Invalid tool blocks.");
  }
  result.blockedTools = [...new Set(blocked)].sort();
  return result;
}

module.exports = { normalizeAgentCreateSetup };
