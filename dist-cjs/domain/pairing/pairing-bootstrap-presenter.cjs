const { renderQrPayloadToTerminal, renderQrPayloadToTerminalAnsi, renderQrPayloadToTerminalColour, serializeQrPayload } = require("./qr-terminal.cjs");

                                                          

                                       

                                                           

function zoomKeyFor(env     , platform     )         {
  const e = env || {};
  if (e.TERM_PROGRAM === "Apple_Terminal" || e.TERM_PROGRAM === "iTerm.app") return "mac";
  if (e.WT_SESSION) return "pc";

  if (e.SSH_CONNECTION !== undefined || e.SSH_CLIENT !== undefined || e.SSH_TTY !== undefined) return "any";
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "pc";
  if (platform === "linux" && (e.DISPLAY !== undefined || e.WAYLAND_DISPLAY !== undefined)) return "pc";
  return "any";
}

const QR_REDRAW_RESERVED_ROWS = 3;

const QR_REDRAW_BIGGER_LINE = "Make the window bigger or zoom out, and the code will appear here.";

const QR_REDRAW_PAIRING_LEAD = "The code fits now. In OcuClaw tap Take a photo of the QR code.";

const QR_REDRAW_APPROVAL_LEAD = "The code fits now. Point your phone's camera at it to approve this server:";

function qrRedrawHintLines(code        , window                                     , zoom         )           {
  const need = `${code.columns}x${code.rows + QR_REDRAW_RESERVED_ROWS}`;
  const columns = Number(window.columns) || 0;
  const rows = Number(window.rows) || 0;
  const have = columns > 0 && rows > 0 ? `; this one is ${columns}x${rows}` : "";
  const key = zoom === "mac"
    ? "Zoom out: Cmd+minus."
    : zoom === "pc"
      ? "Zoom out: Ctrl+minus."
      : "Zoom out: Cmd+minus on Mac, Ctrl+minus on Windows and Linux.";
  return [`QR needs a ${need} window${have}.`, QR_REDRAW_BIGGER_LINE, key];
}

function qrFitsWindow(
  code        ,
  window                                     ,
  since                                      ,
)          {
  const columns = Number(window.columns) || 0;
  const rows = Number(window.rows) || 0;
  if (since && columns === (Number(since.columns) || 0) && rows === (Number(since.rows) || 0)) return false;
  if (columns <= 0 || code.columns > columns) return false;
  return rows <= 0 || code.rows + QR_REDRAW_RESERVED_ROWS <= rows;
}

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

function renderPairingQr(
  qrPayload                  ,
  terminal                      ,
  lightTerminal         ,
)                                                                                    {
  if (terminal.unicode) {
    if (terminal.color) return renderQrPayloadToTerminalColour(qrPayload);
    const text = renderQrPayloadToTerminal(qrPayload, { invert: !lightTerminal });
    const lines = text.split("\n");

    return { text, columns: lines[0].length, rows: lines.length };
  }
  if (terminal.color) return renderQrPayloadToTerminalAnsi(qrPayload);
  return null;
}

function renderCodeSection(
  qrPayload                  ,
  lightTerminal         ,
  terminal                      ,
  prefix          ,
)                                                       {

  const fits = (text        , columns        ) => {
    if (terminal.columns > 0 && columns > terminal.columns) return false;
    if (!terminal.rows || terminal.rows <= 0) return true;
    const width = terminal.columns > 0 ? terminal.columns : 80;
    const prefixRows = prefix.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0);
    return prefixRows + text.split("\n").length + 2 <= terminal.rows;
  };
  const code = renderPairingQr(qrPayload, terminal, lightTerminal);

  if (code === null) return { note: ["QR rendering is unavailable."] };

  const widthKnown = terminal.unicode || terminal.columns > 0;
  if (widthKnown && fits(code.text, code.columns)) return { code: code.text };
  if (terminal.redraw === true) {
    return { note: qrRedrawHintLines(code, terminal, terminal.zoom) };
  }
  return { note: ["QR cannot fit in this terminal."] };
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
    "In OcuClaw tap the Pair button > Take a photo of the QR code.",
    `Expires in ${window}. Or tap Enter the pairing code instead and type:`,
  ];
  const manualDetails = [
    `Address: ${qrPayload.address}`,
    `Pairing code: ${pairingCode}`,
  ];
  const prefix = [...instructions, ...manualDetails];
  const section = renderCodeSection(qrPayload, lightTerminal, terminal, prefix);
  if (section.note) {

    return [
      "In the OcuClaw app on your phone, tap the Pair button, then",
      `Enter the pairing code instead. Expires in ${window}.`,
      ...section.note,
      ...manualDetails,
      "",
    ].join("\n");
  }
  return [...prefix, section.code, ""].join("\n");
}

function pairingBootstrapPayloadText(qrPayload                  )         {
  return serializeQrPayload(qrPayload);
}

module.exports = { PAIRING_BOOTSTRAP_FORBIDDEN_SUBSTRINGS, ASSUMED_TERMINAL, NARROW_TERMINAL_COLUMNS, renderPairingBootstrap, pairingBootstrapPayloadText, renderPairingQr, zoomKeyFor, qrRedrawHintLines, qrFitsWindow, QR_REDRAW_RESERVED_ROWS, QR_REDRAW_BIGGER_LINE, QR_REDRAW_PAIRING_LEAD, QR_REDRAW_APPROVAL_LEAD };
