const verifiedPluginHotReloadVersions = new Set(["2026.5.3-1", "2026.7.1", "2026.7.1-2", "2026.9.4"]);

function planOptionalSetupActivation(config     , hostVersion     ) {
  const raw = config?.gateway?.reload?.mode;
  const versionSupported = verifiedPluginHotReloadVersions.has(hostVersion);
  const policy = raw === undefined && versionSupported ? "hybrid" : raw;
  const hotReloadAllowed = versionSupported && (policy === "hot" || policy === "hybrid");
  return {
    afterWrite: { mode: hotReloadAllowed ? "auto" : "none" },
    policy: typeof policy === "string" ? policy : "unknown",
    hostVersion: typeof hostVersion === "string" ? hostVersion : "unknown",
    reason: !versionSupported ? "host_reload_semantics_unverified"
      : hotReloadAllowed ? "plugin_hot_reload_supported" : "host_reload_policy_blocks_activation",
    action: hotReloadAllowed
      ? "This host supports plugin hot reload. After saving or enabling, reconnect and re-read status; the saved value alone does not prove activation."
      : "The setting is saved, but this host's reload policy or version cannot safely activate it automatically. Run openclaw config get gateway.reload.mode and openclaw gateway status in this host's terminal. A local service owner may explicitly run openclaw gateway restart after checking that status; on Cloudways use its managed-host controls instead. Reconnect and re-read status afterward.",
  };
}

module.exports = { planOptionalSetupActivation };
