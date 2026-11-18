const { classifyConfiguredRelayCredential } = require("./relay-credential-provision.cjs");
const { readPrivateRoute } = require("./setup-live.cjs");
const { configuredPhoneAddress } = require("./custom-route.cjs");
const { runPairingTerminal } = require("./pairing-terminal.cjs");
const { compatibilityStatus } = require("./setup-controller.cjs");
const { awaitRelayCredentialSwap, createRelayCredentialRekey, REKEY_CONFIRMATION_WORD, REKEY_WARNING } = require("./relay-credential-rekey.cjs");
const process = require("node:process");

const TERMINAL_PAIRING_HOST_REQUIREMENT =
  "an OpenClaw host inside the plugin's declared compatibility window (2026.9.5 or newer) with Node 24.16+ within 24.x or 26.1+";

const PAIR_PREREQUISITE_MESSAGES = Object.freeze({
  "verify-plugin": "OcuClaw is not loaded by your agent yet.",
  "verify-host": "This computer's OcuClaw setup is not finished yet.",
  "configure-host": "This computer's OcuClaw setup is not finished yet.",
  "verify-relay": "The OcuClaw relay is not running yet.",
  "verify-private-route":
    "The private route for your phone is not ready. Tailscale must be installed,\nsigned in and serving the relay on this computer.",
});

const PAIR_CUSTOM_ROUTE_MESSAGE =
  "The private route for your phone is not ready. Check your phone address,\nyour TLS front door and its certificate on this computer.";

const PAIR_REFUSAL_NEXT_LINES = Object.freeze([
  "Run openclaw ocuclaw journey to see what is missing, then run openclaw ocuclaw pair again.",
  "Existing credentials and phones were preserved.",
]);

const REKEY_PROMPT_TEXT = `Type "${REKEY_CONFIRMATION_WORD}" to make a new key for all phones: `;
const REKEY_CANCELLED_LINE = "Cancelled. The key was not changed.";
const REKEY_DONE_LINES = Object.freeze([
  "New key in use. The relay refuses the old key.",
  "Every phone is disconnected. Pair your phone now.",
]);
const REKEY_RELOAD_PENDING_LINES = Object.freeze([
  "The new key is saved, but the relay has not loaded it yet.",
  "Every phone is disconnected. Restart the gateway, then run",
  "openclaw ocuclaw pair (without --new-key) to pair your phone.",
]);
const REKEY_OLD_KEY_LIVE_LINES = Object.freeze([
  "The relay loaded the new key but still accepts the old one.",
  "Restart the gateway, then run openclaw ocuclaw pair --new-key again.",
]);

function readConfirmationLine(input     )                  {
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (value        ) => {
      input.off?.("data", onData);
      input.off?.("end", onEnd);
      input.pause?.();
      resolve(value);
    };
    const onData = (chunk     ) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(buffer.slice(0, newline));
    };
    const onEnd = () => finish(buffer);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume?.();
  });
}

function terminalPairingCapability(api     ) {

  if (api?.registrationMode === "cli-metadata") return "unavailable";
  const supported = compatibilityStatus(api?.runtime?.version ?? "") === "compatible";
  return supported && typeof api?.registerCli === "function" &&
    typeof api?.runtime?.config?.current === "function" &&
    typeof api?.runtime?.state?.resolveStateDir === "function"
    ? "available" : "unavailable";
}

async function pairingPreflight(api     , controller     , deps      = {}, surface         = "cli") {
  const refused = (reason        , code        ) => ({ ok: false         , reason, code });
  const journey = await controller("journey", { surface });
  if (!journey?.installation?.id || journey.capabilities?.pairing !== "available") return refused("The owning installation and pairing capability could not be verified.", journey?.installation?.id ? "pairing_capability" : "installation");
  const live = api.runtime.config.current();

  const customAddress = configuredPhoneAddress(api);
  const required = ["verify-plugin", "verify-host", "configure-host", "verify-relay", "verify-private-route"];
  const missing = required.find((id) => !journey.checkpoints?.some((c     ) => c.id === id && c.status === "complete"));
  if (missing) {
    const named      = PAIR_PREREQUISITE_MESSAGES;
    if (missing === "verify-private-route" && customAddress !== null) return refused(PAIR_CUSTOM_ROUTE_MESSAGE, "custom_route");
    return refused(named[missing] || "Your agent's OcuClaw setup is not finished yet.", `checkpoint:${missing}`);
  }
  let classified = classifyConfiguredRelayCredential(live);
  let credential                     = classified === "present" ? live.plugins.entries.ocuclaw.config.relayToken : undefined;

  if ((classified === "absent" || classified === "empty") && typeof deps.adoptedRelayCredential === "function") {
    let adopted      = null;
    try { adopted = deps.adoptedRelayCredential(); } catch (_) { adopted = null; }
    if (typeof adopted === "string" && adopted.length > 0) {
      classified = "present";
      credential = adopted;
    }
  }

  if (classified === "absent" || classified === "empty") return refused("OcuClaw is installed but your agent has not loaded it yet, so there is nothing for a phone to pair with. Make sure it is enabled (openclaw plugins enable ocuclaw) and the gateway has started it, then run openclaw ocuclaw doctor.", "not_loaded");
  if (classified !== "present") return refused("The current credential is unreadable or ambiguous. Repair plugins.entries.ocuclaw.config.relayToken through an operator-owned OpenClaw surface; nothing was changed.", "credential_unreadable");
  const port = journey.currentHealth?.privateRoute?.relay?.port;
  let phoneAddress                    ;
  const route = await (deps.readPrivateRoute ?? readPrivateRoute)(port, {
    installation: journey.installation,
    onVerifiedAddress: (address        ) => { phoneAddress = address; },
    ...(customAddress !== null ? { phoneAddress: customAddress, host: journey.host ?? null, relayCredential: credential } : {}),
  });
  if (customAddress !== null) {

    if (route?.mode !== "custom" || (route.status !== "healthy" && route.status !== "unverified") || !phoneAddress) return refused(PAIR_CUSTOM_ROUTE_MESSAGE, "custom_route");
  } else if (route?.status !== "healthy" || route?.ownership?.status !== "owned" || !phoneAddress) return refused("The private phone route is not freshly verified and owned by this installation.", `route:${route?.status ?? "none"}:${route?.ownership?.status ?? "none"}:${phoneAddress ? "address" : "no_address"}`);
  return { ok: true         , journey, port, credential: credential                      , phoneAddress: phoneAddress          , customAddress };
}

function createTerminalPairingCommand(api     , controller     , deps      = {}) {
  return async function pair(options      = {}, io      = {}) {
    const input = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    const error = io.error ?? process.stderr;
    const env = io.env ?? process.env;
    const refuse = (reason        ) => {

      error.write(`${reason}\n${PAIR_REFUSAL_NEXT_LINES.join("\n")}\n`);
      return { exitCode: 2, outcome: "preflight-refused" };
    };
    if (!input.isTTY || !output.isTTY) return refuse("Pairing requires your own interactive terminal; piped input/output cannot approve.");
    if (terminalPairingCapability(api) !== "available") return refuse(`This host cannot run the terminal pairing lane. It needs ${TERMINAL_PAIRING_HOST_REQUIREMENT}.`);
    let credential                    ;
    let keyChanged = false;
    try {
      const checked      = await pairingPreflight(api, controller, deps);
      if (!checked.ok) return refuse(checked.reason);
      const { journey, port, phoneAddress, customAddress } = checked;
      credential = checked.credential;
      checked.credential = undefined;
      if (options.newKey === true) {

        output.write(`\nWARNING: ${REKEY_WARNING}\n\n${REKEY_PROMPT_TEXT}`);
        const answer = String(await (deps.confirm ?? readConfirmationLine)(input) ?? "");
        if (answer.trim().toLowerCase() !== REKEY_CONFIRMATION_WORD) {
          output.write(`\n${REKEY_CANCELLED_LINE}\n`);
          return { exitCode: 1, outcome: "rekey-cancelled" };
        }
        let rotated     ;
        try {
          rotated = await (deps.rekey ?? createRelayCredentialRekey(api))({ previous: credential });
          keyChanged = true;
        } catch (err     ) {

          const message = typeof err?.message === "string" ? err.message.replace(/^[a-z_]+: /, "") : "";
          error.write(`The new key could not be saved: ${message || "unknown error."}\n`);
          return { exitCode: 2, outcome: "rekey-failed", code: typeof err?.code === "string" ? err.code : "rekey_failed" };
        }
        output.write("\nNew key saved. Waiting for the relay to load it...\n");
        const swap = await (deps.awaitSwap ?? awaitRelayCredentialSwap)({
          port, replacement: rotated.credential, previous: credential,
        });
        if (swap?.replacement !== "accepted") {
          error.write(`${REKEY_RELOAD_PENDING_LINES.join("\n")}\n`);
          return { exitCode: 2, outcome: "rekey-reload-pending" };
        }
        if (swap?.previous !== "rejected") {
          error.write(`${REKEY_OLD_KEY_LIVE_LINES.join("\n")}\n`);
          return { exitCode: 2, outcome: "rekey-old-key-live" };
        }
        output.write(`${REKEY_DONE_LINES.join("\n")}\n`);
        credential = rotated.credential;
        rotated = undefined;
      }

      const dashboard = env.OPENCLAW_TERMINAL === "1" ? { dashboardTerminal: true } : {};
      return await (deps.runTerminal ?? runPairingTerminal)({
        port, relayCredential: credential, phoneAddress,
        installationId: journey.installation.id, lightTerminal: options.lightTerminal === true,
        ...(customAddress !== null ? { customRoute: true } : {}),
        ...dashboard,
      }, { ...io, input, output, error });
    } catch (_) {

      if (keyChanged) {

        error.write("Pairing could not verify or contact this installation safely.\n" +
          "The new key is in use and every phone is disconnected. Run openclaw ocuclaw pair.\n");
        return { exitCode: 2, outcome: "pairing-failed-after-rekey" };
      }
      return refuse("Pairing could not verify or contact this installation safely.");
    } finally {
      credential = undefined;
    }
  };
}

module.exports = { TERMINAL_PAIRING_HOST_REQUIREMENT, PAIR_PREREQUISITE_MESSAGES, PAIR_CUSTOM_ROUTE_MESSAGE, PAIR_REFUSAL_NEXT_LINES, REKEY_PROMPT_TEXT, REKEY_CANCELLED_LINE, REKEY_DONE_LINES, REKEY_RELOAD_PENDING_LINES, REKEY_OLD_KEY_LIVE_LINES, terminalPairingCapability, pairingPreflight, createTerminalPairingCommand };
