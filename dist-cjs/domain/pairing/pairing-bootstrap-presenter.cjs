const { serializeQrPayload } = require("./qr-payload.cjs");

                                                          

const ASSUMED_TERMINAL                       = Object.freeze({
  unicode: true,
  color: false,
  columns: 0,
});

const PAIRING_BOOTSTRAP_FORBIDDEN_SUBSTRINGS                    = Object.freeze([
  "relayCredential",
  "relayToken",
  "credential:",
  "token=",
]);

const NARROW_TERMINAL_COLUMNS = 76;

const MANUAL_PAIRING_HEADING = "Manual pairing";

const MANUAL_PAIRING_LEAD = "In OcuClaw tap Pair with your agent > Pair manually, then type:";

function expiryClock(expiresInSeconds        )         {
  const total = Number.isFinite(expiresInSeconds) ? Math.max(0, Math.floor(expiresInSeconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function manualPairingBlock(address        , pairingCode        , expiresInSeconds         )         {
  const known = typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0;
  return [
    MANUAL_PAIRING_HEADING,
    MANUAL_PAIRING_LEAD,
    `  Address:      ${address}`,
    `  Pairing code: ${pairingCode}`,
    `Expires in ${known ? expiryClock(expiresInSeconds          ) : "a few minutes"}.`,
    "",
  ].join("\n");
}

function renderPairingBootstrap(view                      )         {
  return manualPairingBlock(view.qrPayload.address, view.pairingCode, view.expiresInSeconds);
}

function pairingBootstrapPayloadText(qrPayload                  )         {
  return serializeQrPayload(qrPayload);
}

module.exports = { ASSUMED_TERMINAL, PAIRING_BOOTSTRAP_FORBIDDEN_SUBSTRINGS, NARROW_TERMINAL_COLUMNS, MANUAL_PAIRING_HEADING, MANUAL_PAIRING_LEAD, expiryClock, manualPairingBlock, renderPairingBootstrap, pairingBootstrapPayloadText };
