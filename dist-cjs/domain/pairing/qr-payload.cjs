const { fromCanonicalBase64Url32 } = require("./base64url.cjs");
const { isCanonicalPublicKey } = require("./pairing-prologue.cjs");
const { canonicalizeRelayAddressV1 } = require("./relay-address.cjs");

const EXCHANGE_ID_PATTERN = /^[0-9a-f]{32}$/;

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

function topLevelValueTokens(text        )                             {
  const tokens = new Map                ();
  let index = text.indexOf("{") + 1;
  const skipWhitespace = () => {
    while (index < text.length && " \t\n\r".includes(text[index]          )) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
    index += 1;
    return text.slice(start, index);
  };
  for (;;) {
    skipWhitespace();
    if (index >= text.length || text[index] === "}") return tokens;
    const key = JSON.parse(readString())          ;
    skipWhitespace();
    index += 1;
    skipWhitespace();
    let raw        ;
    if (text[index] === '"') {
      raw = readString();
    } else if (text[index] === "{" || text[index] === "[") {
      return null;
    } else {
      const start = index;
      while (index < text.length && !",} \t\n\r".includes(text[index]          )) index += 1;
      raw = text.slice(start, index);
    }
    if (tokens.has(key)) return null;
    tokens.set(key, raw);
    skipWhitespace();
    if (text[index] === ",") index += 1;
  }
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

  const tokens = topLevelValueTokens(text);
  if (tokens === null || tokens.get("v") !== String(QR_PAYLOAD_VERSION)) return null;

  const address = record["address"];
  const exchangeId = record["exchangeId"];
  const hostKey = record["hostKey"];
  if (typeof address !== "string") return null;
  if (typeof exchangeId !== "string") return null;
  if (typeof hostKey !== "string") return null;

  if (!EXCHANGE_ID_PATTERN.test(exchangeId)) return null;
  const hostKeyBytes = fromCanonicalBase64Url32(hostKey);
  if (hostKeyBytes === null || !isCanonicalPublicKey(hostKeyBytes)) return null;

  const check = canonicalizeRelayAddressV1(address);
  if (!check.ok || check.address !== address) return null;

  return { v: QR_PAYLOAD_VERSION, address, exchangeId, hostKey };
}

module.exports = { serializeQrPayload, parseQrPayload };
