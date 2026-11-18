const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { ModelSiteError, modelSiteSecretFree, modelSiteSafeText } = require("./sketchfab-client.cjs");
const { modelSourceLink, modelSiteProvider } = require("../liveui-pictures/model-source.cjs");

const MODEL_SITES_DIRECTORY = "model-sites";
const MODEL_SITES_FILENAME = "credentials-v1.json";
const EMPTY                 = { version: 1, revision: "absent", credential: null };
const MAX_FILE_BYTES = 16 * 1024;
const privateMode = (s     , directory         ) => {
  if (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) return false;
  return process.platform === "win32" || ((s.mode & 0o077) === 0 && (typeof process.getuid !== "function" || s.uid === process.getuid()));
};

function processBirth(pid        )         {

  if (process.platform !== "linux") return "";
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] || "";
  } catch { return ""; }
}

function ownerAlive(pid        , birth        )          {
  try { process.kill(pid, 0); }
  catch (error     ) { return error?.code !== "ESRCH"; }
  const current = processBirth(pid);
  return !(birth && current && birth !== current);
}

function createModelSitesStore(stateDir        , provider                    = "sketchfab") {
  if (!modelSiteProvider(provider)) throw new ModelSiteError("invalid_request");
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) throw new ModelSiteError("unavailable");
  const directory = path.join(stateDir, MODEL_SITES_DIRECTORY);

  const file = path.join(directory, provider === "sketchfab" ? MODEL_SITES_FILENAME : `${provider}-credentials-v1.json`);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  function checkDirectory(create = false)          {
    try {
      if (create) fs.mkdirSync(directory, { mode: 0o700, recursive: true });
      if (!privateMode(fs.lstatSync(directory), true)) throw new ModelSiteError("unavailable");
      return true;
    } catch (error     ) {
      if (!create && error?.code === "ENOENT") return false;
      throw new ModelSiteError("unavailable");
    }
  }
  function read()                 {
    if (!checkDirectory()) return { ...EMPTY };
    let fd                    ;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(fd);
      if (!privateMode(stat, false) || stat.size > MAX_FILE_BYTES) throw new ModelSiteError("unavailable");
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (value?.version !== 1 || typeof value.revision !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.revision)
        || !Object.hasOwn(value, "credential")) throw new ModelSiteError("unavailable");
      const c = value.credential;
      if (c !== null && (!c || typeof c.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(c.token)
        || !c.account || typeof c.account.id !== "string" || typeof c.account.name !== "string")) throw new ModelSiteError("unavailable");
      if (c === null) return { version: 1, revision: value.revision, credential: null };
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(c.account.id) || !modelSiteSecretFree(c.account.id, c.token)) throw new ModelSiteError("unavailable");
      const url = modelSiteSecretFree(c.account.url, c.token) ? modelSourceLink(c.account.url) : undefined;
      return { version: 1, revision: value.revision, credential: {
        token: c.token, account: { id: c.account.id, name: modelSiteSafeText(c.account.name, 160, c.token), ...(url ? { url } : {}) },
      } };
    } catch (error     ) {
      if (error?.code === "ENOENT") return { ...EMPTY };
      throw new ModelSiteError("unavailable");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function claimWriter()             {
    const claims = path.join(directory, ".write-locks");
    fs.mkdirSync(claims, { mode: 0o700, recursive: true });
    if (!privateMode(fs.lstatSync(claims), true)) throw new ModelSiteError("unavailable");

    const name = `${process.pid}-${randomUUID()}.lock`;
    const claim = path.join(claims, name);
    const release = () => { try { fs.unlinkSync(claim); } catch {  } };
    const fd = fs.openSync(claim, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ birth: processBirth(process.pid) }), "utf8"); }
    catch (error) { release(); throw error; }
    finally { fs.closeSync(fd); }
    try {
      for (const other of fs.readdirSync(claims)) {
        if (other === name) continue;
        const match = /^([1-9][0-9]*)-[0-9a-f-]{36}\.lock$/.exec(other);
        if (!match) throw new ModelSiteError("busy");
        const target = path.join(claims, other);
        let otherFd                    ;
        try {
          otherFd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
          const info = fs.fstatSync(otherFd);
          if (!privateMode(info, false) || info.size > 512) throw new ModelSiteError("busy");
          let birth = "";
          try { const value = JSON.parse(fs.readFileSync(otherFd, "utf8")); birth = typeof value.birth === "string" ? value.birth : ""; }
          catch {  }
          if (ownerAlive(Number(match[1]), birth)) throw new ModelSiteError("busy");
          try { fs.unlinkSync(target); } catch (error     ) { if (error?.code !== "ENOENT") throw error; }
        } catch (error     ) { if (error?.code !== "ENOENT") throw error; }
        finally { if (otherFd !== undefined) fs.closeSync(otherFd); }
      }
      return release;
    } catch (error) { release(); throw error; }
  }
  function write(expected        , credential                            )                 {
    checkDirectory(true);
    let release            ;
    try { release = claimWriter(); }
    catch (error) { throw error instanceof ModelSiteError ? error : new ModelSiteError("save_failed"); }
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    let fd                    ;
    let committed = false;
    try {

      for (const name of fs.readdirSync(directory)) {
        if (/^\.pending-[0-9a-f-]{36}$/.test(name)) fs.unlinkSync(path.join(directory, name));
      }
      if (read().revision !== expected) throw new ModelSiteError("configuration_changed");
      const next                 = { version: 1, revision: randomUUID(), credential };
      const bytes = JSON.stringify(next);
      if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw new ModelSiteError("save_failed");
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
      fs.writeFileSync(fd, bytes, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
      committed = true;
      if (process.platform !== "win32") {
        const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | noFollow);
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
      const saved = read();
      if (saved.revision !== next.revision || saved.credential?.token !== credential?.token) throw new ModelSiteError("save_failed");
      return saved;
    } catch (error) {
      if (committed) {
        const uncertain = new ModelSiteError("outcome_unknown");
        uncertain.committed = true;
        throw uncertain;
      }
      if (error instanceof ModelSiteError) throw error;
      throw new ModelSiteError("save_failed");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {  }
      release();
    }
  }
  return { read, write };
}

module.exports = { MODEL_SITES_DIRECTORY, MODEL_SITES_FILENAME, createModelSitesStore };
