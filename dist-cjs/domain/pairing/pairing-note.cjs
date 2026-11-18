const { constantTimeEqual } = require("../constant-time-equal.cjs");
const { canonicalizeRelayAddressV1, MAX_RELAY_ADDRESS_LENGTH } = require("./relay-address.cjs");
const { normalizePairingCode } = require("./pairing-exchange.cjs");
const { fromCanonicalBase64Url32, toBase64Url } = require("./base64url.cjs");

const INFO = new TextEncoder().encode("ocuclaw-pair-note-v1");
const COMMIT_INFO = new TextEncoder().encode("ocuclaw-pair-commit-v1");

async function phoneKeyCommitment(publicKey            )                      {
  try {
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new Error("Pairing stopped");
    const input = new Uint8Array(COMMIT_INFO.length + 32);
    input.set(COMMIT_INFO);
    input.set(publicKey, COMMIT_INFO.length);
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
  } catch {
    throw new Error("Pairing stopped");
  }
}

async function verifyPhoneKeyCommitment(publicKey            , expected            )                   {
  if (!(expected instanceof Uint8Array) || expected.length !== 32) return false;
  const pinned = new Uint8Array(expected);
  try {
    return constantTimeEqual(toBase64Url(await phoneKeyCommitment(publicKey)), toBase64Url(pinned));
  } catch {
    return false;
  }
}

function normalizePhoneCode(input         )                 {
  if (typeof input !== "string" || input.length > 64) return { kind: "invalid" };
  const trimmed = input.trim();
  if (/^(?:[0-9]{6}|[0-9]{3}[ -][0-9]{3})$/.test(trimmed)) {
    return { kind: "phone-code", code: trimmed.replace(/[ -]/, "") };
  }
  const manual = normalizePairingCode(trimmed);
  return manual === null ? { kind: "invalid" } : { kind: "pairing-code", code: manual };
}

function isPhoneCodeAddress(address         )          {
  if (typeof address !== "string" || address.length > MAX_RELAY_ADDRESS_LENGTH) return false;
  const match = /^wss:\/\/([^/:]+)(?::([0-9]+))?\/?$/.exec(address);
  if (!match) return false;

  const checked = canonicalizeRelayAddressV1(match[2] ? address : `wss://${match[1]}:443`);
  if (!checked.ok) return false;
  const host = checked.address.slice(6, checked.address.lastIndexOf(":"));
  if (host.endsWith(".ts.net")) return true;
  const ipv4 = /^100\.([0-9]+)\.[0-9]+\.[0-9]+$/.exec(host);
  return ipv4 !== null && Number(ipv4[1]) >= 64 && Number(ipv4[1]) <= 127;
}

function decodeKey(value        )             {
  const bytes = fromCanonicalBase64Url32(value);
  if (!bytes) throw new Error("Pairing stopped");

  const high = bytes[31]          ;
  const unreduced = high === 0x7f && (bytes[0]          ) >= 0xed &&
    bytes.subarray(1, 31).every((byte) => byte === 0xff);
  if ((high & 0x80) !== 0 || unreduced || bytes.every((byte) => byte === 0)) {
    throw new Error("Pairing stopped");
  }
  return bytes;
}

async function sealPairingNote(input

 )                       {
  let shared                        ;
  let prk                        ;
  let key                        ;
  try {
    const { appKey, code, payloadText } = input;
    if (typeof code !== "string" || !/^[0-9]{6}$/.test(code) || typeof payloadText !== "string") {
      throw new Error("Pairing stopped");
    }
    const plaintext = new TextEncoder().encode(payloadText);

    if (plaintext.length > 1008) throw new Error("Pairing stopped");
    const appPublic = decodeKey(appKey);
    const subtle = globalThis.crypto.subtle;
    const peer = await subtle.importKey("raw", appPublic                , "X25519", false, []);
    const ephemeral = await subtle.generateKey("X25519", false, ["deriveBits"])                 ;
    const publicKey = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));
    shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peer }, ephemeral.privateKey, 256));
    if (shared.length !== 32 || shared.every((byte) => byte === 0)) throw new Error("Pairing stopped");
    const salt = new Uint8Array(64);
    salt.set(publicKey);
    salt.set(appPublic, 32);
    const hmac = async (secret            , data            )                      => {
      const imported = await subtle.importKey("raw", secret                , { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await subtle.sign("HMAC", imported, data                ));
    };
    prk = await hmac(salt, shared);
    const infoBlock = new Uint8Array(INFO.length + 1);
    infoBlock.set(INFO);
    infoBlock[INFO.length] = 1;
    key = await hmac(prk, infoBlock);
    const aes = await subtle.importKey("raw", key                , "AES-GCM", false, ["encrypt"]);
    const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12),
      additionalData: new TextEncoder().encode(code), tagLength: 128 }, aes, plaintext);
    return { v: 1, epk: toBase64Url(publicKey), ct: toBase64Url(new Uint8Array(ciphertext)) };
  } catch {

    throw new Error("Pairing stopped");
  } finally {
    shared?.fill(0);
    prk?.fill(0);
    key?.fill(0);
  }
}

module.exports = { phoneKeyCommitment, verifyPhoneKeyCommitment, normalizePhoneCode, isPhoneCodeAddress, sealPairingNote };
