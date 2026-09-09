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

const RULE = "─".repeat(64);

const ASCII_RULE = "-".repeat(64);

const NARROW_TERMINAL_COLUMNS = 76;

function renderCodeSection(
  qrPayload                  ,
  lightTerminal         ,
  terminal                      ,
)           {
  if (terminal.unicode) {
    return [
      "  Scan this code with the Even app:",
      "",
      renderQrPayloadToTerminal(qrPayload, { invert: !lightTerminal }),
    ];
  }

  const ansi = renderQrPayloadToTerminalAnsi(qrPayload);
  if (terminal.color && terminal.columns > 0 && ansi.columns <= terminal.columns) {
    return ["  Scan this code with the Even app:", "", ansi.text];
  }

  const detail           = !terminal.color
    ? ["  Colour, which would work around that, is not available here either."]
    : terminal.columns > 0
      ? [
          `  The colour version would fit, but needs ${ansi.columns} columns and this`,
          `  terminal has ${terminal.columns}.`,
        ]
      : [
          "  Colour would work around it, but this terminal's width could not be",
          "  measured, and a code wide enough to wrap is a code that will not scan.",
        ];

  return [
    "  No code is shown here.",
    "",
    "  This terminal is not set to UTF-8, so the block characters the code is",
    "  drawn with would reach you as unreadable text rather than as something",
    "  your camera could scan.",
    ...detail,
    "",
    "  Pair with the address and code below, or set a UTF-8 locale",
    "  (LANG=C.UTF-8) and run this again to get the code.",
  ];
}

function renderPairingBootstrap(view                      )         {
  const {
    qrPayload,
    pairingCode,
    expiresInSeconds,
    lightTerminal = false,
    terminal = ASSUMED_TERMINAL,
  } = view;

  const rule = terminal.unicode ? RULE : ASCII_RULE;
  const dash = terminal.unicode ? "—" : "-";
  const codeSection = renderCodeSection(qrPayload, lightTerminal, terminal);
  const minutes = Math.max(0, Math.round(expiresInSeconds / 60));
  const window =
    expiresInSeconds < 60
      ? `${Math.max(0, Math.round(expiresInSeconds))} seconds`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const lines           = [
    rule,
    "  Pair your phone with OcuClaw",
    rule,
    "",
    ...codeSection,
    "",
    `  Or pair manually ${dash} in the Even app, choose "Enter manually":`,
    "",
    `    Address:      ${qrPayload.address}`,
    `    Pairing code: ${pairingCode}`,
    "",
    "  Both routes run the same encrypted exchange. The code is not a password;",
    "  it only lets your phone join this one pairing request.",
    "",
    rule,
    "  Next: your phone will show four words.",
    rule,
    "",
    "  Check that all four words match the ones printed here, in the same order,",
    "  then approve the pairing on this computer. If even one word is different,",
    `  do not approve ${dash} stop and start pairing again.`,
    "",
    `  This pairing request expires in ${window}.`,
    "",
  ];

  return lines.join("\n");
}

function pairingBootstrapPayloadText(qrPayload                  )         {
  return serializeQrPayload(qrPayload);
}

module.exports = { PAIRING_BOOTSTRAP_FORBIDDEN_SUBSTRINGS, ASSUMED_TERMINAL, NARROW_TERMINAL_COLUMNS, renderPairingBootstrap, pairingBootstrapPayloadText };
