const APP_CLIENT_NAME = "ocuclaw-app";

const RELAY_CLIENT_NAME_KINDS = Object.freeze({

  "ocuclaw-app": "app",

  debugctl: "debug",

  director: "debug",

  petctl: "app",

  "install-lab": "app",

  "session-list-mock": "app",
  "model-catalog-mock": "app",

  "silent-input-bench": "app",
  "silent-input-open-bench": "app",

  "ocuclaw-adhoc-debug": "app",
});

function relayClientKindForName(clientName) {
  if (typeof clientName !== "string") return "app";
  const kinds = RELAY_CLIENT_NAME_KINDS;
  if (!Object.prototype.hasOwnProperty.call(kinds, clientName)) return "app";
  return kinds[clientName] === "debug" ? "debug" : "app";
}

module.exports = { APP_CLIENT_NAME, RELAY_CLIENT_NAME_KINDS, relayClientKindForName };
