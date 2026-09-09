const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const process = require("node:process");

const HERMES_UPLOAD_LIMITS = Object.freeze({
  pcmBytes: 3_999_956, chunkBytes: 16_384, queuedBytes: 262_144,
  uploads: 4, records: 256, idleMs: 30_000, lifetimeMs: 180_000,
});

function wavHeader(bytes) {
  const b = Buffer.alloc(44);
  b.write("RIFF"); b.writeUInt32LE(36 + bytes, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(bytes, 40);
  return b;
}

function createHermesSttUpload(deps) {
  const limits = { ...HERMES_UPLOAD_LIMITS, ...deps.limits };
  const io = deps.fs || fs;
  const records = new Map();
  let queuedBytes = 0;
  let closed = false;
  const now = deps.now || Date.now;
  const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const failure = (message) => ({ success: false, error: { code: "upload_failed", message } });
  const keyFor = (client, id) => JSON.stringify([client, id]);
  const terminal = (r) => r.state === "done" || r.state === "cancelled";

  async function cleanup(r) {
    if (r.file) { const file = r.file; r.file = null; await file.close().catch(() => {}); }
    await io.unlink(r.path).catch(() => {});
    r.cleaned = true;
  }
  async function writeAll(file, bytes, position) {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.write(bytes, offset, bytes.length - offset, position + offset);
      if (!result.bytesWritten) throw new Error("audio staging short write");
      offset += result.bytesWritten;
    }
  }
  function cancel(r, message = "upload cancelled") {
    r.state = "cancelled";
    r.result = failure(message);

    return (r.commit || r.chain).then(() => r.rpc ? undefined : cleanup(r));
  }
  function sweep() {
    const t = now();
    for (const [key, r] of records) {
      if (terminal(r)) {
        if (t - r.touched >= limits.lifetimeMs && r.cleaned && !r.rpc) records.delete(key);
      } else if (r.state === "open" &&
        (t - r.touched >= limits.idleMs || t - r.created >= limits.lifetimeMs || !deps.isReady())) {
        void cancel(r, "upload expired or disconnected");
      }
    }
  }
  const timer = setInterval(sweep, Math.min(limits.idleMs, 1000));
  timer.unref?.();

  const recovery = io.readdir(os.tmpdir()).then(async (names) => {
    for (const name of names) {
      const match = /^ocuclaw-stt-upload-(\d+)-[a-f0-9-]+\.wav$/.exec(name);
      if (!match) continue;
      try { process.kill(Number(match[1]), 0); } catch (error) {
        if (error.code === "ESRCH") await io.unlink(path.join(os.tmpdir(), name)).catch(() => {});
      }
    }
  }).catch(() => {});

  function handle(client, msg) {
    sweep();
    if (closed || !client || !validId(msg.uploadId)) return Promise.resolve(failure("invalid upload identity"));
    const key = keyFor(client, msg.uploadId);
    let r = records.get(key);
    const action = msg.type.split(".").pop();
    if (action === "begin") {
      if (r) return Promise.resolve(failure("upload identity already used"));
      if (!deps.isReady() || !validId(msg.voiceSessionId) || msg.format !== "pcm_s16le" ||
          msg.sampleRateHz !== 16000 || msg.channels !== 1) return Promise.resolve(failure("upload unavailable or invalid PCM format"));
      const active = [...records.values()].filter(v => !terminal(v) || !v.cleaned || v.rpc);
      if (records.size >= limits.records || active.length >= limits.uploads || active.some(v => v.client === client))
        return Promise.resolve(failure("upload capacity exceeded"));
      r = { client, state: "open", created: now(), touched: now(), bytes: 0, chunks: 0,
        file: null, rpc: null, result: null, cleaned: false,
        path: path.join(os.tmpdir(), `ocuclaw-stt-upload-${process.pid}-${randomUUID()}.wav`) };
      records.set(key, r);
      r.chain = recovery.then(async () => {
        if (r.state === "cancelled") return;
        r.file = await io.open(r.path, "wx", 0o600);
        await writeAll(r.file, wavHeader(0), 0);
      }).catch(async () => { r.state = "cancelled"; r.result = failure("audio staging failed"); await cleanup(r); });
      return r.chain.then(() => r.result || { success: true });
    }
    if (!r) return Promise.resolve(failure("unknown upload"));
    r.touched = now();
    if (action === "cancel") return cancel(r).then(() => ({ success: true }));
    if (action === "commit" && r.commit) return msg.requestId === r.requestId
      ? r.commit : Promise.resolve(failure("upload already committed by another request"));
    if (r.state !== "open") return Promise.resolve(r.result || failure("upload is closed"));
    if (action === "chunk") {
      const content = msg.content;
      if (msg.sequence !== r.chunks || typeof content !== "string" || !content.length ||
          content.length > Math.ceil(limits.chunkBytes / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
        return cancel(r, "invalid audio sequence or encoding").then(() => r.result);
      const bytes = Buffer.from(content, "base64");
      if (!bytes.length || bytes.length % 2 || bytes.length > limits.chunkBytes || bytes.toString("base64") !== content ||
          r.bytes + bytes.length > limits.pcmBytes || queuedBytes + bytes.length > limits.queuedBytes)
        return cancel(r, "audio upload limit exceeded").then(() => r.result);
      const position = 44 + r.bytes;
      r.bytes += bytes.length; r.chunks++; queuedBytes += bytes.length;
      r.chain = r.chain.then(async () => {
        if (r.state !== "cancelled") await writeAll(r.file, bytes, position);
      }).catch(async () => { r.state = "cancelled"; r.result = failure("audio staging failed"); await cleanup(r); })
        .finally(() => { queuedBytes -= bytes.length; });
      return r.chain.then(() => r.result || { success: true });
    }
    if (action !== "commit") return Promise.resolve(failure("unknown upload action"));
    if (!validId(msg.requestId) || typeof msg.provider !== "string" || !msg.provider.trim() ||
        !r.bytes || msg.expectedPcmBytes !== r.bytes || msg.expectedChunks !== r.chunks)
      return cancel(r, "incomplete audio upload").then(() => r.result);
    r.state = "committing";
    r.requestId = msg.requestId;
    r.commit = r.chain.then(async () => {
      if (r.state === "cancelled") return r.result;
      try {
        await writeAll(r.file, wavHeader(r.bytes), 0);
        await r.file.close(); r.file = null;
        if (r.state === "cancelled") { await cleanup(r); return r.result; }
        r.rpc = deps.transcribeStaged(msg, r.path);
        const result = await r.rpc;
        if (r.state !== "cancelled") { r.state = "done"; r.result = result; }
        return r.result;
      } catch (_) {
        r.state = "done"; r.result = failure("audio staging failed");
        return r.result;
      } finally { r.rpc = null; r.touched = now(); await cleanup(r); }
    });
    return r.commit;
  }
  async function removeClient(client) {
    await Promise.all([...records.values()].filter(r => r.client === client).map(r => cancel(r)));
  }
  async function dispose() {
    closed = true; clearInterval(timer);
    await Promise.all([...records.values()].map(r => cancel(r)));
  }
  return { handle, removeClient, dispose };
}

module.exports = { HERMES_UPLOAD_LIMITS, createHermesSttUpload };
