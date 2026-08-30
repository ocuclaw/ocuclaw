const { canonicalizeRelayAddressV1 } = require("./relay-address.cjs");

const PAIRING_PROLOGUE_MAGIC = "OCUCLAW-PAIR-V1";

const PAIRING_PROTOCOL_VERSION = 1;

const PAIRING_SUITE_ID = "Noise_NN_25519_AESGCM_SHA256";

const PAIRING_PHRASE_PROFILE_ID = "bip39-en-v1";

const PAIRING_EXCHANGE_ID_BYTES = 16;

const X25519_PUBLIC_KEY_BYTES = 32;

const PAIRING_ADDRESS_MIN_BYTES = 1;
const PAIRING_ADDRESS_MAX_BYTES = 255;

const PAIRING_PROLOGUE_TAGS = {
  protocolVersion: 0x01,
  suiteId: 0x02,
  phraseProfileId: 0x03,
  relayAddress: 0x04,
  exchangeId: 0x05,
  hostEphemeralPublicKey: 0x06,
  phoneEphemeralPublicKey: 0x07,
}         ;

const PROLOGUE_FIXED_BYTES =
  1 +
  PAIRING_PROLOGUE_MAGIC.length +
  (3 + 2) +
  (3 + PAIRING_SUITE_ID.length) +
  (3 + PAIRING_PHRASE_PROFILE_ID.length) +
  (3 + PAIRING_EXCHANGE_ID_BYTES) +
  (3 + X25519_PUBLIC_KEY_BYTES) +
  (3 + X25519_PUBLIC_KEY_BYTES);

const PAIRING_PROLOGUE_MIN_LENGTH =
  PROLOGUE_FIXED_BYTES + 3 + PAIRING_ADDRESS_MIN_BYTES;

const PAIRING_PROLOGUE_MAX_LENGTH =
  PROLOGUE_FIXED_BYTES + 3 + PAIRING_ADDRESS_MAX_BYTES;

class PairingPrologueError extends Error {
           rejection                   ;
  constructor(rejection                   , message        ) {
    super(message);
    this.name = "PairingPrologueError";
    this.rejection = rejection;
  }
}

const FIELD_MODULUS_LE = Object.freeze([
  0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
]);

function isBelowFieldModulus(value            )          {

  for (let i = X25519_PUBLIC_KEY_BYTES - 1; i >= 0; i -= 1) {
    const byte = value[i]          ;
    const limit = FIELD_MODULUS_LE[i]          ;
    if (byte < limit) return true;
    if (byte > limit) return false;
  }
  return false;
}

function requireCanonicalPublicKey(value            , label        )       {
  if (!(value instanceof Uint8Array) || value.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new PairingPrologueError(
      "public-key-length",
      `${label} must be exactly ${X25519_PUBLIC_KEY_BYTES} bytes`,
    );
  }
  const high = value[X25519_PUBLIC_KEY_BYTES - 1]          ;
  if ((high & 0x80) !== 0) {
    throw new PairingPrologueError(
      "public-key-noncanonical",
      `${label} is not a canonical RFC 7748 encoding: the unused high bit is set`,
    );
  }

  if (!isBelowFieldModulus(value)) {
    throw new PairingPrologueError(
      "public-key-noncanonical",
      `${label} is not a canonical RFC 7748 encoding: it is not reduced modulo 2^255 - 19`,
    );
  }
  let accumulated = 0;
  for (let i = 0; i < value.length; i += 1) accumulated |= value[i]          ;
  if (accumulated === 0) {
    throw new PairingPrologueError(
      "public-key-all-zero",
      `${label} is all zero, which forces an all-zero shared secret`,
    );
  }
}

function field(tag        , value            )             {
  const out = new Uint8Array(3 + value.length);
  out[0] = tag;

  out[1] = (value.length >>> 8) & 0xff;
  out[2] = value.length & 0xff;
  out.set(value, 3);
  return out;
}

function ascii(value        )             {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code > 0x7f) {
      throw new PairingPrologueError("address-not-canonical", "prologue values must be ASCII");
    }
    out[i] = code;
  }
  return out;
}

function buildPairingPrologue(input                      )             {

  const canonical = canonicalizeRelayAddressV1(input.address);
  if (!canonical.ok || canonical.address !== input.address) {
    throw new PairingPrologueError(
      "address-not-canonical",
      "the relay address is not in canonical v1 form",
    );
  }
  const addressBytes = ascii(canonical.address);
  if (
    addressBytes.length < PAIRING_ADDRESS_MIN_BYTES ||
    addressBytes.length > PAIRING_ADDRESS_MAX_BYTES
  ) {
    throw new PairingPrologueError(
      "address-length",
      `the relay address must be ${PAIRING_ADDRESS_MIN_BYTES}-${PAIRING_ADDRESS_MAX_BYTES} ASCII bytes`,
    );
  }

  if (
    !(input.exchangeId instanceof Uint8Array) ||
    input.exchangeId.length !== PAIRING_EXCHANGE_ID_BYTES
  ) {
    throw new PairingPrologueError(
      "exchange-id-length",
      `the exchange ID must be exactly ${PAIRING_EXCHANGE_ID_BYTES} bytes`,
    );
  }

  requireCanonicalPublicKey(input.hostEphemeralPublicKey, "the host ephemeral public key");
  requireCanonicalPublicKey(input.phoneEphemeralPublicKey, "the phone ephemeral public key");

  const version = new Uint8Array([
    (PAIRING_PROTOCOL_VERSION >>> 8) & 0xff,
    PAIRING_PROTOCOL_VERSION & 0xff,
  ]);

  const parts               = [
    ascii(PAIRING_PROLOGUE_MAGIC),
    new Uint8Array([0x00]),
    field(PAIRING_PROLOGUE_TAGS.protocolVersion, version),
    field(PAIRING_PROLOGUE_TAGS.suiteId, ascii(PAIRING_SUITE_ID)),
    field(PAIRING_PROLOGUE_TAGS.phraseProfileId, ascii(PAIRING_PHRASE_PROFILE_ID)),
    field(PAIRING_PROLOGUE_TAGS.relayAddress, addressBytes),
    field(PAIRING_PROLOGUE_TAGS.exchangeId, input.exchangeId),
    field(PAIRING_PROLOGUE_TAGS.hostEphemeralPublicKey, input.hostEphemeralPublicKey),
    field(PAIRING_PROLOGUE_TAGS.phoneEphemeralPublicKey, input.phoneEphemeralPublicKey),
  ];

  let total = 0;
  for (const part of parts) total += part.length;

  if (total < PAIRING_PROLOGUE_MIN_LENGTH || total > PAIRING_PROLOGUE_MAX_LENGTH) {
    throw new PairingPrologueError(
      "length-out-of-bounds",
      `the prologue must be ${PAIRING_PROLOGUE_MIN_LENGTH}-${PAIRING_PROLOGUE_MAX_LENGTH} bytes, got ${total}`,
    );
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function assertPrologueSuiteMatches(protocolName        )       {
  if (protocolName !== PAIRING_SUITE_ID) {
    throw new PairingPrologueError(
      "address-not-canonical",
      `the Noise suite ${protocolName} does not match the frozen prologue suite ${PAIRING_SUITE_ID}`,
    );
  }
}

module.exports = { PAIRING_PROLOGUE_MAGIC, PAIRING_PROTOCOL_VERSION, PAIRING_SUITE_ID, PAIRING_PHRASE_PROFILE_ID, PAIRING_EXCHANGE_ID_BYTES, X25519_PUBLIC_KEY_BYTES, PAIRING_ADDRESS_MIN_BYTES, PAIRING_ADDRESS_MAX_BYTES, PAIRING_PROLOGUE_TAGS, PAIRING_PROLOGUE_MIN_LENGTH, PAIRING_PROLOGUE_MAX_LENGTH, PairingPrologueError, buildPairingPrologue, assertPrologueSuiteMatches };
