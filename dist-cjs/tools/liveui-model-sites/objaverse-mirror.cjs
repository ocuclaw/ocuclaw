const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { fetch: undiciFetch } = require("undici");
const { createSsrfSafeDispatcher } = require("../glasses-ui-recipes.cjs");

const OBJAVERSE_HOST = "huggingface.co";
const DATASET = `https://${OBJAVERSE_HOST}/datasets/allenai/objaverse/resolve/main`;
const OBJAVERSE_INDEX_URL = `${DATASET}/object-paths.json.gz`;
const OBJAVERSE_INDEX_FILE = "objaverse-index.bin";
const MAGIC = Buffer.from("OBJV1\n", "latin1");
const RECORD = 17;

const OBJAVERSE_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const INDEX_TIMEOUT_MS = 60_000;

const OBJAVERSE_RETRY_MS = 10 * 60_000;
const ROW = /"([0-9a-f]{32})"\s*:\s*"glbs\/000-(\d{3})\/\1\.glb"/g;

function objaverseFileUrl(id        , folder        )         {
  return `${DATASET}/glbs/000-${String(folder).padStart(3, "0")}/${id}.glb`;
}

function createObjaverseIndexBuilder() {

  let records = Buffer.alloc(RECORD * 65536);
  let count = 0;
  let tail = "";
  function scan(text        , last         ) {
    const all = tail + text;

    const cut = last ? all.length : all.lastIndexOf(",") + 1;
    const whole = all.slice(0, cut);
    tail = all.slice(cut);

    if (tail.length > 4096) tail = tail.slice(-128);
    ROW.lastIndex = 0;
    let match                        ;
    while ((match = ROW.exec(whole)) !== null) {
      const folder = Number(match[2]);
      if (folder > 255) continue;
      if ((count + 1) * RECORD > records.length) {
        const grown = Buffer.alloc(records.length * 2);
        records.copy(grown);
        records = grown;
      }
      records.write(match[1], count * RECORD, 16, "hex");
      records[count * RECORD + 16] = folder;
      count += 1;
    }
  }
  return {
    push(text        ) { scan(text, false); },
    finish()         {
      scan("", true);
      const prefix = new Uint32Array(count);
      const order = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) { prefix[i] = records.readUInt32BE(i * RECORD); order[i] = i; }
      order.sort((a, b) => prefix[a] - prefix[b]
        || records.compare(records, b * RECORD, b * RECORD + 16, a * RECORD, a * RECORD + 16));
      const out = Buffer.alloc(MAGIC.length + count * RECORD);
      MAGIC.copy(out, 0);
      for (let i = 0; i < count; i += 1) records.copy(out, MAGIC.length + i * RECORD, order[i] * RECORD, order[i] * RECORD + RECORD);
      return out;
    },
  };
}

function objaverseFolder(index        , id        )         {
  if (!/^[0-9a-f]{32}$/.test(id) || !isIndex(index)) return -1;
  const key = Buffer.from(id, "hex");
  let lo = 0;
  let hi = (index.length - MAGIC.length) / RECORD - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = MAGIC.length + mid * RECORD;
    const order = Buffer.compare(index.subarray(at, at + 16), key);
    if (order === 0) return index[at + 16];
    if (order < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function isIndex(index     )          {
  return Buffer.isBuffer(index) && index.length > MAGIC.length
    && (index.length - MAGIC.length) % RECORD === 0 && index.subarray(0, MAGIC.length).equals(MAGIC);
}

function createObjaverseMirror(options                        ) {
  const now = options.now || Date.now;
  const file = path.join(options.stateDir, OBJAVERSE_INDEX_FILE);
  let index                = null;
  let loading                                = null;
  let failedAt = -Infinity;
  let ownDispatcher      = null;
  let closed = false;

  function allowed(reach                )          {
    if (closed || options.httpEnabled() !== true) return false;
    if (reach !== "hosts") return true;
    try { return options.hostCheck()?.(OBJAVERSE_HOST) === "listed"; } catch { return false; }
  }

  function readSaved()                {
    try {
      const saved = fs.readFileSync(file);
      return isIndex(saved) ? saved : null;
    } catch { return null; }
  }

  async function download()                  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INDEX_TIMEOUT_MS);
    try {
      const dispatcher = options.dispatcher !== undefined ? options.dispatcher : (ownDispatcher ||= createSsrfSafeDispatcher());
      const fetch = options.fetch || undiciFetch                                                           ;
      const response = await fetch(OBJAVERSE_INDEX_URL, {
        method: "GET", redirect: "follow", credentials: "omit", signal: controller.signal,
        headers: { Accept: "application/gzip,*/*;q=0.1", "User-Agent": "OcuClaw-ModelSites/1" },
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (Number(response?.status) !== 200 || !response.body?.getReader) throw new Error("objaverse index unavailable");
      const length = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(length) && length > OBJAVERSE_INDEX_MAX_BYTES) throw new Error("objaverse index too large");
      const builder = createObjaverseIndexBuilder();
      const gunzip = zlib.createGunzip();
      gunzip.setEncoding("utf8");
      const done = new Promise      ((resolve, reject) => {
        gunzip.on("data", (text        ) => builder.push(text));
        gunzip.on("end", () => resolve());
        gunzip.on("error", reject);
      });
      const reader = response.body.getReader();
      let size = 0;
      for (;;) {
        const row = await reader.read();
        if (row.done) break;
        size += row.value.byteLength;
        if (size > OBJAVERSE_INDEX_MAX_BYTES) { try { await reader.cancel(); } catch {  } throw new Error("objaverse index too large"); }
        if (!gunzip.write(Buffer.from(row.value))) await new Promise(resolve => gunzip.once("drain", resolve));
      }
      gunzip.end();
      await done;
      const built = builder.finish();
      if (built.length <= MAGIC.length) throw new Error("objaverse index empty");
      return built;
    } finally {
      clearTimeout(timer);
    }
  }

  function save(built        ) {
    try {
      fs.mkdirSync(options.stateDir, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, built);
      fs.renameSync(temp, file);
    } catch {  }
  }

  async function load(reach                )                         {
    if (index) return index;
    const saved = readSaved();
    if (saved) return (index = saved);
    if (!allowed(reach) || now() - failedAt < OBJAVERSE_RETRY_MS) return null;
    loading ||= download().then(built => {
      save(built);
      index = built;
      return built;
    }, () => {
      failedAt = now();
      return null;
    }).finally(() => { loading = null; });
    return loading;
  }

  return {

    async fileUrl(id        , reach                )                         {
      if (!allowed(reach)) return null;
      const loaded = await load(reach);
      if (!loaded) return null;
      const folder = objaverseFolder(loaded, id);
      return folder < 0 ? null : objaverseFileUrl(id, folder);
    },
    close() {
      closed = true;
      if (ownDispatcher) { void ownDispatcher.close(); ownDispatcher = null; }
    },
  };
}

module.exports = { OBJAVERSE_HOST, OBJAVERSE_INDEX_URL, OBJAVERSE_INDEX_FILE, OBJAVERSE_INDEX_MAX_BYTES, OBJAVERSE_RETRY_MS, objaverseFileUrl, createObjaverseIndexBuilder, objaverseFolder, createObjaverseMirror };
