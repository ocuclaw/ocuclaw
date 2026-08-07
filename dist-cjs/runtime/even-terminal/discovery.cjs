const { homedir } = require("node:os");
const { join } = require("node:path");
const { readdirSync, readFileSync, unlinkSync } = require("node:fs");

function defaultInstanceDir() {
  return join(homedir(), ".even-terminal", "instances");
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function listLiveEvenTerminalInstances(opts = {}) {
  const dir = opts.instanceDir ?? defaultInstanceDir();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const live = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let info;
    try {
      info = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      try {
        unlinkSync(file);
      } catch {

      }
      continue;
    }

    const pid = typeof info.pid === "number" ? info.pid : NaN;
    if (!Number.isFinite(pid) || !isPidAlive(pid)) {
      try {
        unlinkSync(file);
      } catch {

      }
      continue;
    }

    live.push({
      pid,
      port: Number(info.port),
      token: String(info.token ?? ""),
      cwd: String(info.cwd ?? ""),
      codexAppServerPort:
        typeof info.codexAppServerPort === "number" ? info.codexAppServerPort : null,
      startedAt: typeof info.startedAt === "number" ? info.startedAt : 0,
    });
  }

  live.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return live;
}

module.exports = { listLiveEvenTerminalInstances };
