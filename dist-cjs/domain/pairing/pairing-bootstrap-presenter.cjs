const { renderQrPayloadToTerminal, renderQrPayloadToTerminalAnsi, serializeQrPayload } = require("./qr-terminal.cjs");

                                                          

                                       

                                                           

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

function renderCodeSection(
  qrPayload                  ,
  lightTerminal         ,
  terminal                      ,
  prefix          ,
)           {

  const fits = (text        , columns        ) => {
    if (terminal.columns > 0 && columns > terminal.columns) return false;
    if (!terminal.rows || terminal.rows <= 0) return true;
    const width = terminal.columns > 0 ? terminal.columns : 80;
    const prefixRows = prefix.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0);
    return prefixRows + text.split("\n").length + 2 <= terminal.rows;
  };
  if (terminal.unicode) {
    const code = renderQrPayloadToTerminal(qrPayload, { invert: !lightTerminal });

    const codeColumns = code.split("\n")[0].length;
    if (fits(code, codeColumns)) {
      return [code];
    }

    return [
      "QR cannot fit in this terminal.",
    ];
  }

  const ansi = renderQrPayloadToTerminalAnsi(qrPayload);
  if (terminal.color && terminal.columns > 0 && fits(ansi.text, ansi.columns)) {
    return [ansi.text];
  }

  return [terminal.color
    ? "QR cannot fit in this terminal."
    : "QR rendering is unavailable."];
}

function renderPairingBootstrap(view                      )         {
  const {
    qrPayload,
    pairingCode,
    expiresInSeconds,
    lightTerminal = false,
    terminal = ASSUMED_TERMINAL,
  } = view;

  const minutes = Math.max(0, Math.round(expiresInSeconds / 60));
  const window =
    expiresInSeconds < 60
      ? `${Math.max(0, Math.round(expiresInSeconds))} seconds`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const instructions = [
    "In OcuClaw tap Pair with your computer > Take a photo of the QR code.",
    `Expires in ${window}. Or tap Enter the pairing code instead and type:`,
  ];
  const manualDetails = [
    `Address: ${qrPayload.address}`,
    `Pairing code: ${pairingCode}`,
  ];
  const prefix = [...instructions, ...manualDetails];
  const section = renderCodeSection(qrPayload, lightTerminal, terminal, prefix);
  if (section.length === 1 && section[0].startsWith("QR ")) {

    return [
      "In the OcuClaw app on your phone, tap Pair with your computer, then",
      `Enter the pairing code instead. Expires in ${window}.`,
      section[0],
      ...manualDetails,
      "",
    ].join("\n");
  }
  return [...prefix, ...section, ""].join("\n");
}

function pairingBootstrapPayloadText(qrPayload                  )         {
  return serializeQrPayload(qrPayload);
}

module.exports = { PAIRING_BOOTSTRAP_FORBIDDEN_SUBSTRINGS, ASSUMED_TERMINAL, NARROW_TERMINAL_COLUMNS, renderPairingBootstrap, pairingBootstrapPayloadText };
