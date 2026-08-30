const { NOISE_NN_PROTOCOL_NAME, NOISE_NN_RESPONDER_MESSAGE_BYTES, createNoiseNNHandshake, generateNoiseKeyPair } = require("./noise-engine.cjs");

const PAIRING_NOISE_PROTOCOL_NAME = NOISE_NN_PROTOCOL_NAME;

const NOISE_PUBLIC_KEY_LENGTH = 32;

const NOISE_TAG_LENGTH = 16;

const NOISE_NN_INITIATOR_MESSAGE_LENGTH = NOISE_PUBLIC_KEY_LENGTH;

const NOISE_NN_RESPONDER_MESSAGE_LENGTH = NOISE_NN_RESPONDER_MESSAGE_BYTES;

                                                                

                                                                     

const NOISE_SUITE_UNAVAILABLE_REASON =
  `This device cannot run ${PAIRING_NOISE_PROTOCOL_NAME}: WebCrypto X25519 is ` +
  "unavailable. Secure pairing requires iOS 18.4 or later, or a current Android " +
  "System WebView (Chromium 133 or later). Pairing stays held rather than falling " +
  "back to weaker cryptography.";

const EMPTY_PAYLOAD = new Uint8Array(0);
const EMPTY_ASSOCIATED_DATA = new Uint8Array(0);

function createSession(send                  , receive                  )                        {
  return Object.freeze({
    async encrypt(plaintext            ) {
      return send.encryptWithAd(EMPTY_ASSOCIATED_DATA, plaintext);
    },
    async decrypt(ciphertext            ) {
      return receive.decryptWithAd(EMPTY_ASSOCIATED_DATA, ciphertext);
    },
    destroy() {
      send.destroy();
      receive.destroy();
    },
  });
}

const VENDOR_NOISE_SUITE             = Object.freeze({
  protocolName: PAIRING_NOISE_PROTOCOL_NAME,
  implementation: "ocuclaw/noise-engine (WebCrypto, no third-party crypto)",
  assurance: "vendor-primitives-official-vectors"         ,

  async generateEphemeral()                                 {
    const pair = await generateNoiseKeyPair();
    return Object.freeze({
      publicKey: pair.publicKey,

      keyPair: pair,
      destroy() {

      },
    }                          );
  },

  async createInitiator({
    prologue,
    ephemeral,
  }

   ) {
    const { keyPair } = ephemeral                            ;
    if (!keyPair) {

      throw new Error("the ephemeral was not produced by this Noise suite");
    }
    const handshake = await createNoiseNNHandshake({
      role: "initiator",
      prologue,
      ephemeral: keyPair,
    });

    const initiatorMessage = await handshake.writeMessage(EMPTY_PAYLOAD);

    return Object.freeze({
      initiatorMessage,
      async readResponderMessage(responderMessage            ) {
        await handshake.readMessage(responderMessage);
        const handshakeDigest = handshake.handshakeHash();
        const { send, receive } = await handshake.split();

        handshake.destroy();
        return Object.freeze({
          handshakeDigest,
          session: createSession(send, receive),
        });
      },
      destroy() {
        handshake.destroy();
      },
    });
  },
});

async function isVendorNoiseSuiteSupported()                   {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  try {
    const alice = await generateNoiseKeyPair();
    const bob = await generateNoiseKeyPair();
    const peerOfAlice = await subtle.importKey(
      "raw",
      bob.publicKey                ,
      { name: "X25519" },
      true,
      [],
    );
    const peerOfBob = await subtle.importKey(
      "raw",
      alice.publicKey                ,
      { name: "X25519" },
      true,
      [],
    );
    const first = new Uint8Array(
      await subtle.deriveBits({ name: "X25519", public: peerOfAlice }, alice.privateKey, 256),
    );
    const second = new Uint8Array(
      await subtle.deriveBits({ name: "X25519", public: peerOfBob }, bob.privateKey, 256),
    );
    if (first.length !== 32 || second.length !== 32) return false;
    let mismatch = 0;
    for (let i = 0; i < first.length; i += 1) mismatch |= (first[i]          ) ^ (second[i]          );
    if (mismatch !== 0) return false;

    const aesKey = await subtle.importKey("raw", first, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    const iv = new Uint8Array(12);
    const sealed = await subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, aesKey, second);
    const opened = new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, aesKey, sealed),
    );
    if (opened.length !== second.length) return false;
    const digest = new Uint8Array(await subtle.digest("SHA-256", first));
    return digest.length === 32;
  } catch {

    return false;
  }
}

async function resolveNoiseSuite()                             {
  return (await isVendorNoiseSuiteSupported()) ? VENDOR_NOISE_SUITE : null;
}

module.exports = { PAIRING_NOISE_PROTOCOL_NAME, NOISE_PUBLIC_KEY_LENGTH, NOISE_TAG_LENGTH, NOISE_NN_INITIATOR_MESSAGE_LENGTH, NOISE_NN_RESPONDER_MESSAGE_LENGTH, NOISE_SUITE_UNAVAILABLE_REASON, VENDOR_NOISE_SUITE, isVendorNoiseSuiteSupported, resolveNoiseSuite };
