const fs = require("node:fs");

const CONTAINER_MARKER_PATHS = ["/.dockerenv", "/run/.containerenv"];

function isLoopbackBindAddress(address) {
  const normalized = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!normalized) return false;
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function isContainerEnvironment(deps = {}) {
  const existsSync = typeof deps.existsSync === "function" ? deps.existsSync : fs.existsSync;
  const markerPaths = Array.isArray(deps.markerPaths) ? deps.markerPaths : CONTAINER_MARKER_PATHS;
  for (const markerPath of markerPaths) {
    try {
      if (existsSync(markerPath)) return true;
    } catch {

    }
  }
  return false;
}

function composeContainerLoopbackNotice(wsBind, wsPort) {
  return (
    `[ocuclaw] relay is listening on ws://${wsBind}:${wsPort} inside a container. ` +
    `This is expected when Tailscale Serve or another ingress proxy shares the relay's same network namespace, ` +
    `and when the container uses host networking. Container detection alone does not prove the relay is unreachable. ` +
    `Keep the loopback bind unless a failed connection and host inspection confirm that ingress crosses a bridge ` +
    `or named network; see the OcuClaw container troubleshooting guide.`
  );
}

module.exports = { isContainerEnvironment, isLoopbackBindAddress, composeContainerLoopbackNotice };
