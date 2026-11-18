const { Buffer } = require("node:buffer");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const { pictureLooksLike, sniffPicture } = require("./picture-sniff.cjs");
const { modelResourcePlan } = require("./picture-fetch.cjs");

const PICTURE_FILE_MAX_BYTES = 4 * 1024 * 1024;

const PICTURE_FILE_MODEL_MAX_BYTES = 32 * 1024 * 1024;

const FILE_HEAD_BYTES = 4096;

const UNREADABLE                       = { ok: false, code: "picture_unreadable", detail: "unreadable" };

function expandPath(rawPath        )                {
  if (typeof rawPath !== "string") return null;
  const value = rawPath.trim();
  if (!value || value.includes("\0")) return null;
  let out        ;
  if (/^file:\/\//i.test(value)) {
    try {
      out = fileURLToPath(new URL(value));
    } catch {
      return null;
    }
  } else if (value.startsWith("~/")) {
    out = path.join(os.homedir(), value.slice(2));
  } else {
    out = value;
  }
  return path.isAbsolute(out) ? path.resolve(out) : null;
}

function isUnder(real        , root        )          {
  if (real === root) return false;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return real.startsWith(withSep);
}

async function realRoots(roots          )                    {
  const list = Array.isArray(roots) ? roots.filter((r) => typeof r === "string" && path.isAbsolute(r)) : [];
  const out = await Promise.all(list.map((r) => fs.promises.realpath(r).catch(() => null)));
  return out.filter((r         )              => typeof r === "string");
}

async function openFileRealPath(
  handle                        ,
  resolvedPath        ,
  fdStat          ,
  mode                           ,
)                         {
  if (mode === "proc" || (mode === "auto" && os.platform() === "linux")) {
    try {
      const real = await fs.promises.readlink(`/proc/self/fd/${handle.fd}`);

      if (real.endsWith(" (deleted)") || !path.isAbsolute(real)) return null;
      return real;
    } catch {
      if (mode === "proc") return null;
    }
  }
  try {
    const real = await fs.promises.realpath(resolvedPath);
    const nameStat = await fs.promises.stat(real);
    if (nameStat.dev !== fdStat.dev || nameStat.ino !== fdStat.ino) return null;
    return real;
  } catch {
    return null;
  }
}

async function readAtMost(handle                        , limit        )                         {
  const buffer = Buffer.alloc(limit + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }

  if (total > limit) return null;
  return buffer.subarray(0, total);
}

async function openUnderRoots(resolvedPath        , roots          , mode                           )                             {
  const nameReal = await fs.promises.realpath(resolvedPath).catch(() => null);
  if (!nameReal || !roots.some((root) => isUnder(nameReal, root))) return null;

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOCTTY || 0);
  const handle = await fs.promises.open(resolvedPath, flags);
  let kept = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const real = await openFileRealPath(handle, resolvedPath, stat, mode);
    if (!real || !roots.some((root) => isUnder(real, root))) return null;
    kept = true;
    return { handle, stat, real };
  } finally {
    if (!kept) await handle.close().catch(() => {});
  }
}

function modelSideFilePath(uri        , dir        )                {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return null;
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {

  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded.startsWith("/") || path.isAbsolute(decoded)) return null;
  if (decoded.split("/").some((seg) => seg === "..")) return null;
  const out = path.resolve(dir, decoded);
  return isUnder(out, dir) ? out : null;
}

async function withSideFiles(
  model                      ,
  body        ,
  dir        ,
  roots          ,
  mode                           ,
  opts                    ,
  laneTaken         ,
)                                {
  if (!model.ok) return model;
  const plan = modelResourcePlan(opts.models, body);
  if (plan === "too_many") return UNREADABLE;
  const resources                         = Object.create(null);
  let held = body.length;
  for (const { uri, need } of plan) {
    const file = modelSideFilePath(uri, dir);
    const opened = file ? await openUnderRoots(file, roots, mode).catch(() => null) : null;
    if (!opened) {
      if (need) return UNREADABLE;
      continue;
    }
    try {
      if (opened.stat.size > PICTURE_FILE_MODEL_MAX_BYTES - held) {
        if (need) return UNREADABLE;
        continue;
      }
      if (!laneTaken && held + opened.stat.size > PICTURE_FILE_MAX_BYTES) {
        laneTaken = true;

        if (typeof opts.modelGate === "function") await opts.modelGate();
      }
      const bytes = await readAtMost(opened.handle, opened.stat.size).catch(() => null);
      if (!bytes) {
        if (need) return UNREADABLE;
        continue;
      }
      held += bytes.length;
      resources[uri] = bytes;
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }
  return Object.keys(resources).length > 0 ? { ...model, resources } : model;
}

async function readPictureFile(rawPath        , opts                    )                                {
  if (!opts || opts.filesAllowed !== true) {
    return { ok: false, code: "picture_source_refused", detail: "file pictures off here" };
  }
  const mode = opts.fdPathMode === "proc" || opts.fdPathMode === "inode" ? opts.fdPathMode : "auto";
  let handle                                = null;
  try {
    const resolvedPath = expandPath(rawPath);
    if (!resolvedPath) return UNREADABLE;
    const roots = await realRoots(opts.roots);
    if (roots.length === 0) return UNREADABLE;
    const opened = await openUnderRoots(resolvedPath, roots, mode);
    if (!opened) return UNREADABLE;
    handle = opened.handle;
    const fdStat = opened.stat;

    const bigModel = !!opts.models && fdStat.size > PICTURE_FILE_MAX_BYTES && fdStat.size <= PICTURE_FILE_MODEL_MAX_BYTES;
    if (fdStat.size > PICTURE_FILE_MAX_BYTES && !bigModel) return UNREADABLE;
    if (bigModel) {
      const head = Buffer.alloc(FILE_HEAD_BYTES);
      const { bytesRead } = await handle.read(head, 0, FILE_HEAD_BYTES, 0);
      if ((opts.models                 ).headOf(head.subarray(0, bytesRead), fdStat.size) !== "model") return UNREADABLE;
      if (typeof opts.modelGate === "function") await opts.modelGate();
    }
    const bytes = await readAtMost(handle, Math.min(fdStat.size, bigModel ? PICTURE_FILE_MODEL_MAX_BYTES : PICTURE_FILE_MAX_BYTES));
    if (!bytes || bytes.length === 0) return UNREADABLE;
    const sniff = sniffPicture(bytes);

    if (!sniff.ok) {
      if (sniff.code !== "picture_type_unsupported") return UNREADABLE;
      const model = opts.models ? opts.models.sourceOf(bytes) : null;
      if (model) {
        if (!model.ok) return UNREADABLE;

        return await withSideFiles(model, bytes, path.dirname(opened.real), roots, mode, opts, bigModel);
      }
      return { ok: false, code: "picture_unreadable", detail: "unreadable", seen: pictureLooksLike(bytes) };
    }
    return { ok: true, bytes, mime: sniff.mime, type: sniff.type, width: sniff.width, height: sniff.height };
  } catch {
    return UNREADABLE;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { PICTURE_FILE_MAX_BYTES, PICTURE_FILE_MODEL_MAX_BYTES, modelSideFilePath, readPictureFile };
