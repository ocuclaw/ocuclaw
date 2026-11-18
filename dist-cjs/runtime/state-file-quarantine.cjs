const fs = require("node:fs");

const MAX_VERSION_SUFFIX_CHARS = 24;

function stripLeadingBom(raw        ) {
  if (typeof raw === "string" && raw.charCodeAt(0) === 0xfeff) {
    return { text: raw.slice(1), hadBom: true };
  }
  return { text: raw, hadBom: false };
}

function versionQuarantineSuffix(version         ) {
  const text = String(version).replace(/[^A-Za-z0-9._]/g, "_");
  return `v${text.slice(0, MAX_VERSION_SUFFIX_CHARS)}`;
}

function describeStateFileLoadError(err     )         {
  if (err && (err instanceof SyntaxError || err.name === "SyntaxError")) {
    const message = typeof err.message === "string" ? err.message : "";
    const position = /at position (\d+)/.exec(message);
    const lineColumn = /line (\d+) column (\d+)/.exec(message);
    if (lineColumn) return `invalid JSON at line ${lineColumn[1]} column ${lineColumn[2]}`;
    if (position) return `invalid JSON at position ${position[1]}`;
    return "invalid JSON";
  }
  if (err && typeof err.code === "string") return err.code;
  if (err && typeof err.message === "string") return err.message;
  return String(err);
}

function quarantineStateFile(statePath        , suffix        , opts      = {}) {
  const fsImpl = opts.fs || fs;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  let stamp = Math.max(0, Math.floor(Number(now()) || 0));
  let quarantinePath = `${statePath}.${suffix}-${stamp}`;

  let free = false;
  for (let tries = 0; tries < 50; tries += 1) {
    let taken = true;
    try {
      taken = fsImpl.existsSync(quarantinePath);
    } catch {
      taken = true;
    }
    if (!taken) {
      free = true;
      break;
    }
    stamp += 1;
    quarantinePath = `${statePath}.${suffix}-${stamp}`;
  }

  let moved = false;
  let errorCode                = null;
  if (!free) {

    errorCode = "quarantine_name_taken";
  } else {
    try {
      fsImpl.renameSync(statePath, quarantinePath);
      moved = true;
    } catch (err     ) {
      errorCode = (err && err.code) || "rename_failed";
    }
  }
  if (moved) {
    try {
      fsImpl.chmodSync(quarantinePath, 0o600);
    } catch {

    }
  }

  let originalGone = false;
  try {
    originalGone = !fsImpl.existsSync(statePath);
  } catch {
    originalGone = false;
  }
  return {
    moved,
    originalGone,
    quarantinePath: moved ? quarantinePath : null,
    errorCode,
  };
}

module.exports = { stripLeadingBom, versionQuarantineSuffix, describeStateFileLoadError, quarantineStateFile };
