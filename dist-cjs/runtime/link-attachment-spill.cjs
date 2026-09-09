const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LINK_SPILL_FILE_PREFIX = "ocuclaw-attach-";

const SPILL_DECODE_CHUNK_CHARS = 1 << 20;

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

async function writeDecodedBase64(handle, base64) {
  const chunked =
    base64.length > SPILL_DECODE_CHUNK_CHARS && STRICT_BASE64.test(base64);
  const step = chunked ? SPILL_DECODE_CHUNK_CHARS : base64.length || 1;
  for (let at = 0; at < base64.length; at += step) {
    const buf = Buffer.from(base64.slice(at, at + step), "base64");

    let written = 0;
    while (written < buf.length) {
      const res = await handle.write(buf, written, buf.length - written);
      const n = res && Number.isFinite(res.bytesWritten) ? res.bytesWritten : 0;
      if (n <= 0) throw new Error("spill write made no progress");
      written += n;
    }
  }
}

async function writeLinkSpillFile(base64Content, opts = {}) {
  const prefix =
    opts && typeof opts.prefix === "string" && opts.prefix
      ? opts.prefix
      : LINK_SPILL_FILE_PREFIX;
  const dir = opts && typeof opts.dir === "string" && opts.dir ? opts.dir : os.tmpdir();
  const spillPath = path.join(
    dir,
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const content = typeof base64Content === "string" ? base64Content : "";

  const handle = await fs.promises.open(spillPath, "wx", 0o600);
  let closed = false;
  try {
    await writeDecodedBase64(handle, content);

    closed = true;
    await handle.close();
  } catch (err) {
    if (!closed) await handle.close().catch(() => {});
    await discardLinkSpillFileAsync(spillPath);
    throw err;
  }
  return spillPath;
}

function discardLinkSpillFile(spillPath) {
  if (typeof spillPath !== "string" || !spillPath) return false;
  try {
    fs.unlinkSync(spillPath);
    return true;
  } catch {
    return false;
  }
}

async function discardLinkSpillFileAsync(spillPath) {
  if (typeof spillPath !== "string" || !spillPath) return false;
  try {
    await fs.promises.unlink(spillPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { LINK_SPILL_FILE_PREFIX, writeLinkSpillFile, discardLinkSpillFile, discardLinkSpillFileAsync };
