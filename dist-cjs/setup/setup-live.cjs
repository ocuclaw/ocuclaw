const { realpathSync } = require("node:fs");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { createPrivateRouteReader } = require("./private-route.cjs");
const { createCustomRouteReader } = require("./custom-route.cjs");
const { daemonSummary } = require("./cloudways.cjs");

const JOURNEY_METHOD = "ocuclaw.setup.journey";

function registerSetupJourneyReader(api     , controller     ) {
  if (api?.registrationMode !== "full" || typeof api.registerGatewayMethod !== "function") return;
  api.registerGatewayMethod(JOURNEY_METHOD, async ({ params, respond }     ) => {
    const result = await controller("journey");
    if (!result.installation.id || params?.installationId !== result.installation.id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "setup installation context does not match" });
      return;
    }
    respond(true, result);
  }, { scope: "operator.read" });
}

async function readLiveSetupJourney(local     ) {
  if (!local.installation.id) return local;
  try {

    const sdkName = "openclaw/plugin-sdk/gateway-runtime";

    const sdk = await import(sdkName).catch(() => {
      const hostRequire = createRequire(realpathSync(process.argv[1]));
      return import(pathToFileURL(hostRequire.resolve(sdkName)).href);
    });
    if (typeof sdk.callGatewayFromCli !== "function") return local;
    const result = await sdk.callGatewayFromCli(JOURNEY_METHOD,

      { timeout: "30000", json: true }, { installationId: local.installation.id },

      { scopes: ["operator.read"], progress: false, clientName: "gateway-client", mode: "backend", deviceIdentity: null });
    if (result?.operation !== "journey" || result?.installation?.id !== local.installation.id) return local;
    return result;
  } catch (_) {
    return local;
  }
}

const readServeRoute = createPrivateRouteReader();
const readCustomRoute = createCustomRouteReader();
function readPrivateRoute(relayPort     , context      = {}) {
  return context && typeof context.phoneAddress === "string"
    ? readCustomRoute(relayPort, context)
    : readServeRoute(relayPort, context);
}

async function readTailnetDaemon() {
  try {
    return await daemonSummary();
  } catch (_) {
    return null;
  }
}

module.exports = { registerSetupJourneyReader, readLiveSetupJourney, readPrivateRoute, readTailnetDaemon };
