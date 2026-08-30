const NOISE_NN_PROTOCOL_NAME = "Noise_NN_25519_AESGCM_SHA256";

const HASHLEN = 32;

const DHLEN = 32;

const TAGLEN = 16;

const MAX_NONCE = (1n << 64n) - 1n;

const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

function subtleCrypto()               {
  const api = globalThis.crypto?.subtle;
  if (!api) {
    throw new Error(
      "WebCrypto (crypto.subtle) is unavailable; " +
        `${NOISE_NN_PROTOCOL_NAME} cannot be assembled in this runtime.`,
    );
  }
  return api;
}

function concat(...parts                       )             {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function wipe(bytes                   )       {
  if (bytes) bytes.fill(0);
}

async function hash(data            )                      {
  return new Uint8Array(await subtleCrypto().digest("SHA-256", data                ));
}

async function hmacSha256(key            , data            )                      {
  const subtle = subtleCrypto();
  const imported = await subtle.importKey(
    "raw",
    key                ,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", imported, data                ));
}

async function hkdf2(
  chainingKey            ,
  inputKeyMaterial            ,
)                                             {
  const tempKey = await hmacSha256(chainingKey, inputKeyMaterial);
  const output1 = await hmacSha256(tempKey, Uint8Array.of(0x01));
  const output2 = await hmacSha256(tempKey, concat(output1, Uint8Array.of(0x02)));
  wipe(tempKey);
  return [output1, output2]         ;
}

function aesGcmNonce(counter        )             {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, counter, false);
  return nonce;
}

async function importAesKey(raw            )                     {
  return subtleCrypto().importKey("raw", raw                , { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function createCipherState()

  {
  let key                   = null;
  let nonce = 0n;

  let destroyed = false;

  let chain                   = Promise.resolve();

  function serialize   (operation                  )             {
    const result = chain.then(operation, operation);

    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function requireLive()                   {
    if (destroyed) {
      throw new Error("Noise cipher state has been destroyed");
    }

    if (nonce >= MAX_NONCE) {
      throw new Error("Noise nonce space exhausted");
    }
    return key;
  }

  return {
    initializeKey(raw) {

      return serialize(async () => {
        if (destroyed) throw new Error("Noise cipher state has been destroyed");
        key = raw === null ? null : await importAesKey(raw);
        nonce = 0n;
      });
    },
    hasKey() {
      return key !== null;
    },
    encryptWithAd(associatedData, plaintext) {
      return serialize(async () => {
        const active = requireLive();

        if (!active) return plaintext;
        const sealed = new Uint8Array(
          await subtleCrypto().encrypt(
            {
              name: "AES-GCM",
              iv: aesGcmNonce(nonce)                ,
              additionalData: associatedData                ,
              tagLength: TAGLEN * 8,
            },
            active,
            plaintext                ,
          ),
        );
        nonce += 1n;
        return sealed;
      });
    },
    decryptWithAd(associatedData, ciphertext) {
      return serialize(async () => {
        const active = requireLive();
        if (!active) return ciphertext;
        const opened = new Uint8Array(
          await subtleCrypto().decrypt(
            {
              name: "AES-GCM",
              iv: aesGcmNonce(nonce)                ,
              additionalData: associatedData                ,
              tagLength: TAGLEN * 8,
            },
            active,
            ciphertext                ,
          ),
        );

        nonce += 1n;
        return opened;
      });
    },
    destroy() {
      destroyed = true;
      key = null;
    },
  };
}

async function generateNoiseKeyPair()                        {
  const subtle = subtleCrypto();
  const pair = (await subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ]))                 ;
  const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  if (publicKey.length !== DHLEN) {
    throw new Error(`X25519 public key was ${publicKey.length} bytes, expected ${DHLEN}`);
  }
  return Object.freeze({ privateKey: pair.privateKey, publicKey });
}

async function importNoiseKeyPairFromPrivateScalar(
  privateScalar            ,
)                        {
  if (privateScalar.length !== DHLEN) {
    throw new Error(`X25519 private scalar must be ${DHLEN} bytes`);
  }
  const subtle = subtleCrypto();
  const privateKey = await subtle.importKey(
    "pkcs8",
    concat(PKCS8_X25519_PREFIX, privateScalar)                ,
    { name: "X25519" },
    true,
    ["deriveBits"],
  );
  const jwk = (await subtle.exportKey("jwk", privateKey))                  ;
  if (typeof jwk.x !== "string") {
    throw new Error("WebCrypto did not expose the X25519 public key");
  }
  return Object.freeze({ privateKey, publicKey: base64UrlToBytes(jwk.x) });
}

function base64UrlToBytes(value        )             {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function diffieHellman(
  privateKey           ,
  peerPublicKey            ,
)                      {
  const subtle = subtleCrypto();
  const peer = await subtle.importKey(
    "raw",
    peerPublicKey                ,
    { name: "X25519" },
    true,
    [],
  );
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: "X25519", public: peer }, privateKey, DHLEN * 8),
  );

  if (shared.length !== DHLEN) {
    throw new Error(`X25519 produced ${shared.length} bytes, expected ${DHLEN}`);
  }
  return shared;
}

async function initializeSymmetric(protocolName        )                          {
  const nameBytes = new TextEncoder().encode(protocolName);

  const handshakeHash =
    nameBytes.length <= HASHLEN
      ? concat(nameBytes, new Uint8Array(HASHLEN - nameBytes.length))
      : await hash(nameBytes);
  const cipher = createCipherState();
  await cipher.initializeKey(null);
  return { cipher, chainingKey: handshakeHash.slice(), handshakeHash };
}

async function mixKey(state                , inputKeyMaterial            )                {
  const [chainingKey, temporaryKey] = await hkdf2(state.chainingKey, inputKeyMaterial);
  state.chainingKey = chainingKey;
  await state.cipher.initializeKey(temporaryKey);
  wipe(temporaryKey);
}

async function mixHash(state                , data            )                {
  state.handshakeHash = await hash(concat(state.handshakeHash, data));
}

async function encryptAndHash(state                , plaintext            )                      {
  const ciphertext = await state.cipher.encryptWithAd(state.handshakeHash, plaintext);
  await mixHash(state, ciphertext);
  return ciphertext;
}

async function decryptAndHash(state                , ciphertext            )                      {
  const plaintext = await state.cipher.decryptWithAd(state.handshakeHash, ciphertext);

  await mixHash(state, ciphertext);
  return plaintext;
}

async function split(
  state                ,
)                                                         {
  const [key1, key2] = await hkdf2(state.chainingKey, new Uint8Array(0));
  const first = createCipherState();
  const second = createCipherState();
  await first.initializeKey(key1);
  await second.initializeKey(key2);
  wipe(key1);
  wipe(key2);
  return [first, second]         ;
}

                                                 

async function createNoiseNNHandshake(
  options                         ,
)                            {
  const { role, prologue } = options;
  const state = await initializeSymmetric(NOISE_NN_PROTOCOL_NAME);
  await mixHash(state, prologue);

  const local = options.ephemeral ?? (await generateNoiseKeyPair());
  let remotePublicKey                    = null;
  let step = 0;
  let destroyed = false;
  let splitDone = false;

  const writeTurn = role === "initiator" ? 0 : 1;
  const readTurn = role === "initiator" ? 1 : 0;

  function requireUsable()       {
    if (destroyed) throw new Error("Noise handshake has been destroyed");
  }

  const handshake                   = {
    role,
    isComplete() {
      return step === 2;
    },
    handshakeHash() {
      if (step !== 2) throw new Error("handshake hash is not final until the handshake completes");
      return state.handshakeHash.slice();
    },
    async writeMessage(payload) {
      requireUsable();
      if (step !== writeTurn) throw new Error(`Noise NN: unexpected write at step ${step}`);

      await mixHash(state, local.publicKey);
      if (role === "responder") {
        if (!remotePublicKey) throw new Error("Noise NN: responder has no remote ephemeral");
        const shared = await diffieHellman(local.privateKey, remotePublicKey);
        await mixKey(state, shared);
        wipe(shared);
      }
      const ciphertext = await encryptAndHash(state, payload);
      step += 1;
      return concat(local.publicKey, ciphertext);
    },
    async readMessage(message) {
      requireUsable();
      if (step !== readTurn) throw new Error(`Noise NN: unexpected read at step ${step}`);
      if (message.length < DHLEN) throw new Error("Noise NN: message is shorter than an ephemeral");
      remotePublicKey = message.slice(0, DHLEN);
      await mixHash(state, remotePublicKey);
      if (role === "initiator") {
        const shared = await diffieHellman(local.privateKey, remotePublicKey);
        await mixKey(state, shared);
        wipe(shared);
      }
      const payload = await decryptAndHash(state, message.slice(DHLEN));
      step += 1;
      return payload;
    },
    async split() {
      requireUsable();
      if (step !== 2) throw new Error("Noise NN: split before the handshake completed");
      if (splitDone) throw new Error("Noise NN: split called twice");
      splitDone = true;
      const [first, second] = await split(state);

      return role === "initiator"
        ? Object.freeze({ send: first, receive: second })
        : Object.freeze({ send: second, receive: first });
    },
    destroy() {
      destroyed = true;
      state.cipher.destroy();
      wipe(state.chainingKey);
    },
  };

  return Object.freeze(handshake);
}

const NOISE_NN_INITIATOR_MESSAGE_BYTES = DHLEN;

const NOISE_NN_RESPONDER_MESSAGE_BYTES = DHLEN + TAGLEN;

module.exports = { NOISE_NN_PROTOCOL_NAME, NOISE_NN_INITIATOR_MESSAGE_BYTES, NOISE_NN_RESPONDER_MESSAGE_BYTES, generateNoiseKeyPair, importNoiseKeyPairFromPrivateScalar, createNoiseNNHandshake };
