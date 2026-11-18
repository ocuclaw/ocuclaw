function forgetDeletedProgramCard(appId        , deps      = {})           {
  const key = `app:${appId}`;
  if (deps.jev && typeof deps.jev.handle === "function") deps.jev.handle({ op: "remove", key });

  if (deps.mcp && typeof deps.mcp.handle === "function") deps.mcp.handle({ op: "remove", key });
  if (deps.model && typeof deps.model.remove === "function") deps.model.remove(key, true);
  const store = deps.feedStore;
  return store && typeof store.clearCard === "function" ? store.clearCard(appId) : [];
}

module.exports = { forgetDeletedProgramCard };
