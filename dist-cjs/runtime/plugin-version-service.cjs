const { PLUGIN_VERSION, REQUIRES_CLIENT_VERSION, BUILD_INPUT_HASH } = require("../version.cjs");
const { readOpenClawHostVersion } = require("./openclaw-host-version.cjs");

function createPluginVersionService() {
  function getPluginVersion() {
    return typeof PLUGIN_VERSION === "string" && PLUGIN_VERSION.length > 0
      ? PLUGIN_VERSION
      : null;
  }

  function getRequiresClientVersion() {
    return typeof REQUIRES_CLIENT_VERSION === "string" && REQUIRES_CLIENT_VERSION.length > 0
      ? REQUIRES_CLIENT_VERSION
      : null;
  }

  function getOpenClawHostVersion() {
    return readOpenClawHostVersion();
  }

  function getDistHash() {
    return typeof BUILD_INPUT_HASH === "string" && BUILD_INPUT_HASH.length > 0
      ? BUILD_INPUT_HASH
      : null;
  }

  return { getPluginVersion, getRequiresClientVersion, getOpenClawHostVersion, getDistHash };
}

module.exports = { createPluginVersionService };
