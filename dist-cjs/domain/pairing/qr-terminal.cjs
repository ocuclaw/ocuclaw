const { canonicalizeRelayAddressV1 } = require("./relay-address.cjs");

const { qrMatrix, QR_QUIET_ZONE_MODULES } = require("./qr-matrix.cjs");

const QR_TERMINAL_GLYPHS = Object.freeze({

  full: "█",

  upper: "▀",

  lower: "▄",

  blank: " ",
}         );

                                                        

const EXCHANGE_ID_PATTERN = /^[0-9a-f]{32}$/;

const HOST_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function isCanonicalBase64Url32(value        )          {
  if (!HOST_KEY_PATTERN.test(value)) return false;
  const finalDigit = BASE64URL_ALPHABET.indexOf(value[42]);
  return finalDigit >= 0 && finalDigit % 4 === 0;
}

const QR_PAYLOAD_KEYS = ["v", "address", "exchangeId", "hostKey"]         ;

const QR_PAYLOAD_VERSION = 1;

function serializeQrPayload(payload                  )         {
  return JSON.stringify({
    v: payload.v,
    address: payload.address,
    exchangeId: payload.exchangeId,
    hostKey: payload.hostKey,
  });
}

function parseQrPayload(text        )                          {
  if (typeof text !== "string") return null;

  let parsed         ;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed                           ;

  const keys = Object.keys(record);
  if (keys.length !== QR_PAYLOAD_KEYS.length) return null;
  for (const key of QR_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  }

  if (record["v"] !== QR_PAYLOAD_VERSION) return null;

  const address = record["address"];
  const exchangeId = record["exchangeId"];
  const hostKey = record["hostKey"];
  if (typeof address !== "string") return null;
  if (typeof exchangeId !== "string") return null;
  if (typeof hostKey !== "string") return null;

  if (!EXCHANGE_ID_PATTERN.test(exchangeId)) return null;
  if (!isCanonicalBase64Url32(hostKey)) return null;

  const check = canonicalizeRelayAddressV1(address);
  if (!check.ok || check.address !== address) return null;

  return { v: QR_PAYLOAD_VERSION, address, exchangeId, hostKey };
}

function stripBorder(matrix                                 , count        )              {
  if (count <= 0) return matrix.map((row) => [...row]);
  const height = matrix.length;
  if (height <= 2 * count) return [];
  return matrix
    .slice(count, height - count)
    .map((row) => row.slice(count, row.length - count));
}

function renderMatrix(matrix                                 , invert         )         {
  if (matrix.length === 0) return "";
  const width = matrix[0].length;
  const lines           = [];
  for (let r = 0; r < matrix.length; r += 2) {
    const top                     = matrix[r];
    const bottom                                 = matrix[r + 1];
    let line = "";
    for (let c = 0; c < width; c++) {

      const topDark = top[c] === true;
      const bottomDark = bottom === undefined ? false : bottom[c] === true;
      const topInk = invert ? !topDark : topDark;
      const bottomInk = invert ? !bottomDark : bottomDark;
      if (topInk && bottomInk) line += QR_TERMINAL_GLYPHS.full;
      else if (topInk) line += QR_TERMINAL_GLYPHS.upper;
      else if (bottomInk) line += QR_TERMINAL_GLYPHS.lower;
      else line += QR_TERMINAL_GLYPHS.blank;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function renderQrPayloadToTerminal(
  payload                  ,
  options                          ,
)         {
  const quietZone = options?.quietZone ?? true;
  const invert = options?.invert ?? true;
  const matrix = qrMatrix(serializeQrPayload(payload));
  const trimmed = quietZone ? matrix : stripBorder(matrix, QR_QUIET_ZONE_MODULES);
  return renderMatrix(trimmed, invert);
}

module.exports = { QR_TERMINAL_GLYPHS, serializeQrPayload, parseQrPayload, renderQrPayloadToTerminal };
