const { Inflate } = require("fflate");
const { MODEL_CODES, MODEL_MAX_ZIP_ENTRIES, MODEL_ZIP_CROWDED, ModelError } = require("./model-limits.cjs");

const SLICE = 64 * 1024;

function u16(b            , i        )         {
  return b[i] | (b[i + 1] << 8);
}
function u32(b            , i        )         {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}
function u64(b            , i        )         {
  return u32(b, i) + u32(b, i + 4) * 2 ** 32;
}

function unreadable(detail        )             {
  return new ModelError(MODEL_CODES.unreadable, detail);
}

function listZip(b            )             {
  let e = b.length - 22;
  const stop = Math.max(0, b.length - 22 - 65535);
  while (e >= stop && u32(b, e) !== 0x06054b50) e--;
  if (e < stop) throw unreadable("zip has no end record");
  let count = u16(b, e + 10);
  let offset = u32(b, e + 16);
  if (e >= 20 && u32(b, e - 20) === 0x07064b50) {
    const z = u64(b, e - 12);
    if (z + 56 <= b.length && u32(b, z) === 0x06064b50) {
      count = u64(b, z + 32);
      offset = u64(b, z + 48);
    }
  }
  if (count > MODEL_MAX_ZIP_ENTRIES) throw unreadable(MODEL_ZIP_CROWDED);
  const entries             = [];
  const decoder = new TextDecoder();
  let o = offset;
  for (let n = 0; n < count; n++) {
    if (o + 46 > b.length || u32(b, o) !== 0x02014b50) throw unreadable("zip directory is damaged");
    const flags = u16(b, o + 8);
    const method = u16(b, o + 10);
    let compressedSize = u32(b, o + 20);
    let size = u32(b, o + 24);
    const nameLen = u16(b, o + 28);
    const extraLen = u16(b, o + 30);
    const commentLen = u16(b, o + 32);
    let localOffset = u32(b, o + 42);
    const name = decoder.decode(b.subarray(o + 46, o + 46 + nameLen));

    let x = o + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(b, x);
      const len = u16(b, x + 2);
      if (id === 0x0001) {
        let p = x + 4;
        if (size === 0xffffffff) { size = u64(b, p); p += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(b, p); p += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(b, p); }
      }
      x += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, localOffset, encrypted: (flags & 1) !== 0 });
    o = xEnd + commentLen;
  }
  return entries;
}

function readZipEntry(
  b            ,
  entry          ,
  budget           ,
  onChunk                              ,
)             {
  if (entry.encrypted) throw unreadable("zip entry is encrypted");
  const lo = entry.localOffset;
  if (lo + 30 > b.length || u32(b, lo) !== 0x04034b50) throw unreadable("zip entry header is damaged");
  const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
  const end = start + entry.compressedSize;
  if (end > b.length) throw unreadable("zip entry is cut short");
  const data = b.subarray(start, end);
  const tooBig = () => new ModelError(MODEL_CODES.tooBig, "zip contents are over the size cap");
  if (entry.method === 0) {
    if (data.length > budget.left) throw tooBig();
    budget.left -= data.length;
    const copy = data.slice();
    if (onChunk) onChunk(copy);
    return copy;
  }
  if (entry.method !== 8) throw unreadable(`zip compression method ${entry.method}`);
  const chunks               = [];
  let total = 0;
  const inflater = new Inflate((chunk            ) => {
    total += chunk.length;
    if (total > budget.left) throw tooBig();
    chunks.push(chunk);
    if (onChunk) onChunk(chunk);
  });
  try {
    for (let i = 0; i < data.length; i += SLICE) {
      inflater.push(data.subarray(i, Math.min(data.length, i + SLICE)), i + SLICE >= data.length);
    }
    if (data.length === 0) inflater.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof ModelError) throw err;
    throw unreadable("zip entry does not inflate");
  }
  budget.left -= total;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function findZipEntry(entries            , path        )                       {
  const want = normalizeZipPath(path);
  return entries.find((e) => normalizeZipPath(e.name) === want);
}

function normalizeZipPath(path        )         {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function resolveZipPath(base        , uri        )         {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {

  }
  if (decoded.startsWith("/")) return normalizeZipPath(decoded);
  const parts = normalizeZipPath(base).split("/");
  parts.pop();
  for (const seg of decoded.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg.toLowerCase());
  }
  return parts.join("/");
}

const MODEL_ENTRY = /\.(glb|gltf|obj|stl|ply|3mf)$/i;

const REFUSED_ENTRY                          = [
  [/\.usd[acz]?$/i, "USDZ"],
  [/\.fbx$/i, "FBX"],
  [/\.blend$/i, "Blend"],
  [/\.(step|stp)$/i, "STEP"],
  [/\.dae$/i, "Collada"],
];

function is3mf(entries            )          {
  return Boolean(findZipEntry(entries, "3D/3dmodel.model")) ||
    (Boolean(findZipEntry(entries, "[Content_Types].xml")) && entries.some((e) => /\.model$/i.test(e.name)));
}

function zipFiles(entries            )             {
  return entries.filter((e) => !e.name.endsWith("/") && !/(^|\/)(__MACOSX\/|\._)/.test(e.name));
}

function zipModel(files            )           {
  if (is3mf(files)) return { kind: "3mf" };
  for (const [re, name] of REFUSED_ENTRY) {
    if (files.length && re.test(files[0].name)) return { kind: "refused", format: name };
  }
  const models = files.filter((e) => MODEL_ENTRY.test(e.name)).sort((a, b) => b.size - a.size);
  if (models.length) return { kind: "model", entry: models[0] };
  const refused = REFUSED_ENTRY.find(([re]) => files.some((e) => re.test(e.name)));
  return refused ? { kind: "refused", format: refused[1] } : { kind: "none" };
}

module.exports = { listZip, readZipEntry, findZipEntry, normalizeZipPath, resolveZipPath, MODEL_ENTRY, REFUSED_ENTRY, is3mf, zipFiles, zipModel };
