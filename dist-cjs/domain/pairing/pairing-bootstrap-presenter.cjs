const { renderQrPayloadToTerminal, serializeQrPayload } = require("./qr-terminal.cjs");

                                                          

const PAIRING_BOOTSTRAP_FORBIDDEN_SUBSTRINGS                    = Object.freeze([
  "relayCredential",
  "relayToken",
  "credential:",
  "token=",
]);

const RULE = "─".repeat(64);

function renderPairingBootstrap(view                      )         {
  const { qrPayload, pairingCode, expiresInSeconds, lightTerminal = false } = view;

  const qr = renderQrPayloadToTerminal(qrPayload, { invert: !lightTerminal });
  const minutes = Math.max(0, Math.round(expiresInSeconds / 60));
  const window =
    expiresInSeconds < 60
      ? `${Math.max(0, Math.round(expiresInSeconds))} seconds`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const lines           = [
    RULE,
    "  Pair your phone with OcuClaw",
    RULE,
    "",
    "  Scan this code with the Even app:",
    "",
    qr,
    "",
    `  Or pair manually — in the Even app, choose "Enter manually":`,
    "",
    `    Address:      ${qrPayload.address}`,
    `    Pairing code: ${pairingCode}`,
    "",
    "  Both routes run the same encrypted exchange. The code is not a password;",
    "  it only lets your phone join this one pairing request.",
    "",
    RULE,
    "  Next: your phone will show four words.",
    RULE,
    "",
    "  Check that all four words match the ones printed here, in the same order,",
    "  then approve the pairing on this computer. If even one word is different,",
    "  do not approve — stop and start pairing again.",
    "",
    `  This pairing request expires in ${window}.`,
    "",
  ];

  return lines.join("\n");
}

function pairingBootstrapPayloadText(qrPayload                  )         {
  return serializeQrPayload(qrPayload);
}

module.exports = { PAIRING_BOOTSTRAP_FORBIDDEN_SUBSTRINGS, renderPairingBootstrap, pairingBootstrapPayloadText };
