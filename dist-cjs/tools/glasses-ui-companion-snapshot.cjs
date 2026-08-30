const fs = require("node:fs");

const path = require("node:path");

const { UI_STATE_COMPANION_FIELDS, UI_STATE_SCHEMA_VERSION, assertCompanionSnapshotExclusions, assertUiStateFieldNamesHonest, projectByEnumeration } = require("./glasses-ui-state-snapshot.cjs");

const COMPANION_SNAPSHOT_FILENAME = "companion-snapshot.json";
const COMPANION_SNAPSHOT_SCHEMA_ID = "ocuclaw/companion-snapshot@1";
const COMPANION_SNAPSHOT_SCHEMA_VERSION = 1;
const COMPANION_SNAPSHOT_AUTHORITY = "read_only";
const COMPANION_SNAPSHOT_MAX_BYTES = 32 * 1024;

const COMPANION_LIVEUI_SCHEMA_VERSION = 6;

const ENVELOPE_FIELDS = Object.freeze([
  "schema",
  "schemaVersion",
  "generatedAtMs",
  "backend",
  "profile",
  "authority",
  "liveui",
]);
const BACKENDS = Object.freeze(["openclaw", "hermes"]);
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CONTENT_FIELDS = Object.freeze([
  "kind",
  "title",
  "body",
  "items",
  "template",
  "imageAsset",
  "imageWidth",
  "imageHeight",
]);

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateProfile(profile) {
  return typeof profile === "string" && PROFILE_PATTERN.test(profile);
}

function validateContent(content) {
  if (content === null || content === undefined) return true;
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  if (Object.keys(content).some((key) => !CONTENT_FIELDS.includes(key))) return false;
  for (const key of ["kind", "title", "body", "template", "imageAsset"]) {
    if (content[key] !== undefined && typeof content[key] !== "string") return false;
  }
  for (const key of ["imageWidth", "imageHeight"]) {
    if (content[key] !== undefined && !Number.isFinite(content[key])) return false;
  }
  if (content.items !== undefined) {
    if (!Array.isArray(content.items) || content.items.length > 20) return false;
    for (const item of content.items) {
      if (typeof item === "string") continue;
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      if (Object.keys(item).some((key) => !["label", "body", "checked"].includes(key))) return false;
      if (typeof item.label !== "string") return false;
      if (item.body !== undefined && typeof item.body !== "string") return false;
      if (item.checked !== undefined && typeof item.checked !== "boolean") return false;
    }
  }
  return true;
}

function companionSnapshotPath(stateDir) {
  const dir = typeof stateDir === "string" ? stateDir.trim() : "";
  return dir ? path.join(dir, COMPANION_SNAPSHOT_FILENAME) : null;
}

function buildCompanionSnapshot(input) {
  if (UI_STATE_SCHEMA_VERSION !== COMPANION_LIVEUI_SCHEMA_VERSION) {
    throw new Error(
      `companion snapshot pins LiveUI schema v${COMPANION_LIVEUI_SCHEMA_VERSION}; ` +
        `current projection is v${UI_STATE_SCHEMA_VERSION}`,
    );
  }
  const backend = input && input.backend;
  const profile = input && input.profile;
  const generatedAtMs = input && input.generatedAtMs;
  if (!BACKENDS.includes(backend)) throw new Error(`unsupported companion backend: ${backend}`);
  if (!validateProfile(profile)) throw new Error("companion profile must be 1-64 safe characters");
  if (!Number.isFinite(generatedAtMs) || generatedAtMs < 0) {
    throw new Error("companion generatedAtMs must be a non-negative finite number");
  }

  const liveui = projectByEnumeration(UI_STATE_COMPANION_FIELDS, input && input.machine);
  if (
    liveui.schemaVersion !== COMPANION_LIVEUI_SCHEMA_VERSION ||
    liveui.schema !== `glasses-ui/state-snapshot@${COMPANION_LIVEUI_SCHEMA_VERSION}`
  ) {
    throw new Error("local companion projection has the wrong LiveUI schema");
  }
  assertCompanionSnapshotExclusions(liveui, "companion snapshot liveui payload");
  assertUiStateFieldNamesHonest(liveui, "companion snapshot liveui payload");
  if (!validateContent(liveui.active && liveui.active.content)) {
    throw new Error("local companion content has the wrong shape");
  }

  const snapshot = projectByEnumeration(ENVELOPE_FIELDS, {
    schema: COMPANION_SNAPSHOT_SCHEMA_ID,
    schemaVersion: COMPANION_SNAPSHOT_SCHEMA_VERSION,
    generatedAtMs,
    backend,
    profile,
    authority: COMPANION_SNAPSHOT_AUTHORITY,
    liveui,
  });
  const serialized = `${JSON.stringify(snapshot)}\n`;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > COMPANION_SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `companion snapshot is ${bytes} bytes; cap is ${COMPANION_SNAPSHOT_MAX_BYTES}`,
    );
  }
  return { snapshot, serialized, bytes };
}

function validateCompanionSnapshot(value) {
  try {
    if (!exactKeys(value, ENVELOPE_FIELDS)) return fail("wrong_shape", "unexpected envelope fields");
    if (
      value.schema !== COMPANION_SNAPSHOT_SCHEMA_ID ||
      value.schemaVersion !== COMPANION_SNAPSHOT_SCHEMA_VERSION
    ) {
      return fail("wrong_schema", "unsupported companion snapshot schema");
    }
    if (!BACKENDS.includes(value.backend)) return fail("wrong_backend", "unsupported backend");
    if (!validateProfile(value.profile)) return fail("wrong_profile", "invalid profile");
    if (value.authority !== COMPANION_SNAPSHOT_AUTHORITY) {
      return fail("wrong_authority", "snapshot is not read-only authority");
    }
    if (!Number.isFinite(value.generatedAtMs) || value.generatedAtMs < 0) {
      return fail("wrong_time", "invalid generatedAtMs");
    }
    if (!value.liveui || typeof value.liveui !== "object" || Array.isArray(value.liveui)) {
      return fail("wrong_liveui", "missing LiveUI projection");
    }
    if (
      value.liveui.schemaVersion !== COMPANION_LIVEUI_SCHEMA_VERSION ||
      value.liveui.schema !== `glasses-ui/state-snapshot@${COMPANION_LIVEUI_SCHEMA_VERSION}`
    ) {
      return fail("wrong_liveui_schema", "unsupported nested LiveUI schema");
    }
    const allowed = new Set(UI_STATE_COMPANION_FIELDS);
    for (const key of Object.keys(value.liveui)) {
      if (!allowed.has(key)) return fail("wrong_liveui_shape", `unexpected LiveUI field: ${key}`);
    }
    assertCompanionSnapshotExclusions(value.liveui, "companion snapshot liveui payload");
    assertUiStateFieldNamesHonest(value.liveui, "companion snapshot liveui payload");
    if (!validateContent(value.liveui.active && value.liveui.active.content)) {
      return fail("wrong_content_shape", "invalid local companion content");
    }
    return { ok: true, snapshot: value };
  } catch (err) {
    return fail("invalid", err && err.message ? err.message : String(err));
  }
}

function writeCompanionSnapshot(input) {
  const target = companionSnapshotPath(input && input.stateDir);
  if (!target) return fail("no_state_dir", "active adapter has no state directory");
  let tmp = null;
  try {
    const built = buildCompanionSnapshot({
      backend: input.backend,
      profile: input.profile,
      generatedAtMs:
        typeof input.nowMs === "function" ? input.nowMs() : Date.now(),
      machine: input.machine,
    });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    tmp = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(tmp, built.serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
    tmp = null;
    return { ok: true, path: target, bytes: built.bytes, snapshot: built.snapshot };
  } catch (err) {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {

      }
    }
    return fail("write_failed", err && err.message ? err.message : String(err), { path: target });
  }
}

function readCompanionSnapshot(input) {
  const target = companionSnapshotPath(input && input.stateDir);
  if (!target) return fail("no_state_dir", "active adapter has no state directory");
  try {
    const stat = fs.statSync(target);
    if (stat.size > COMPANION_SNAPSHOT_MAX_BYTES) {
      return fail("oversized", `snapshot is ${stat.size} bytes`, { path: target });
    }
    const raw = fs.readFileSync(target, "utf8");
    if (new TextEncoder().encode(raw).byteLength > COMPANION_SNAPSHOT_MAX_BYTES) {
      return fail("oversized", "snapshot exceeds byte cap", { path: target });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return fail("corrupt", err && err.message ? err.message : "invalid JSON", { path: target });
    }
    const validated = validateCompanionSnapshot(parsed);
    if (!validated.ok) return { ...validated, path: target };
    const now = typeof input.nowMs === "function" ? input.nowMs() : Date.now();
    const ageMs = Math.max(0, now - parsed.generatedAtMs);
    const maxAgeMs = Number.isFinite(input.maxAgeMs) ? Math.max(0, input.maxAgeMs) : null;
    return {
      ok: true,
      path: target,
      snapshot: parsed,
      ageMs,
      stale: maxAgeMs === null ? null : ageMs > maxAgeMs,
    };
  } catch (err) {
    const code = err && err.code === "ENOENT" ? "missing" : "read_failed";
    return fail(code, err && err.message ? err.message : String(err), { path: target });
  }
}

module.exports = { COMPANION_SNAPSHOT_FILENAME, COMPANION_SNAPSHOT_SCHEMA_ID, COMPANION_SNAPSHOT_SCHEMA_VERSION, COMPANION_SNAPSHOT_AUTHORITY, COMPANION_SNAPSHOT_MAX_BYTES, COMPANION_LIVEUI_SCHEMA_VERSION, companionSnapshotPath, buildCompanionSnapshot, validateCompanionSnapshot, writeCompanionSnapshot, readCompanionSnapshot };
