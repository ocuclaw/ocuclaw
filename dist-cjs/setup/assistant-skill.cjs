const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const process = require("node:process");

const ASSISTANT_SKILL_NAME = "ocuclaw-assist";

const BUNDLED_SKILL_SOURCE = "openclaw-extra";

const BUNDLED_SKILL_FROM_MODULE = "../../skills/ocuclaw-assist/SKILL.md";

const ASSISTANT_SHADOW_ACTION =
  "A separately installed copy of the OcuClaw Setup Assistant is shadowing the one this plugin ships, so this conversation is running an older guide than the installed plugin carries. Tell the user in plain words and name both guide versions. Then have them clear it in their own terminal: `openclaw skills remove ocuclaw-assist` on hosts that have that verb, and on hosts that do not (OpenClaw 2026.7.x has no `skills remove`), delete the folder holding the SKILL.md that `openclaw skills info ocuclaw-assist --json` reports as `filePath`. Re-read journey afterwards. The assistant ships only inside the plugin now and is updated with the plugin: `openclaw plugins update ocuclaw@latest` when it came from npm, `openclaw plugins update ocuclaw` when it came from ClawHub. This is a named condition, not a halt: setup continues either way.";

const DEFAULT_TIMEOUT_MS = 15000;

const PROBE_GUARD_ENV = "OCUCLAW_ASSISTANT_SKILL_PROBE";

const PROBE_SKIP_ENV = "OCUCLAW_SKIP_ASSISTANT_SKILL_PROBE";

function probeDisabled() {
  const env = process.env || {};
  return env[PROBE_GUARD_ENV] === "1" || env[PROBE_SKIP_ENV] === "1";
}

function parseGuideVersion(source) {
  const match = /\*\*Guide version:\*\*[ \t]*(.+?)[ \t]*$/m.exec(String(source || ""));
  return match ? match[1] : null;
}

function readGuideVersionFile(filePath) {
  try {
    return parseGuideVersion(fs.readFileSync(String(filePath), "utf8"));
  } catch (_) {
    return null;
  }
}

function bundledGuideVersion(options = {}) {
  if (typeof options.bundledGuideVersion === "string") return options.bundledGuideVersion;
  try {
    const here = path.dirname(__filename);
    return readGuideVersionFile(path.resolve(here, BUNDLED_SKILL_FROM_MODULE));
  } catch (_) {
    return null;
  }
}

function readSkillListing(options = {}) {
  if (typeof options.readSkillListing === "function") {
    try {
      return Promise.resolve(options.readSkillListing()).catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }
  if (probeDisabled()) return Promise.resolve(null);
  const cli = typeof options.cli === "string" && options.cli ? options.cli : "openclaw";
  const timeout = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    try {
      execFile(
        cli,
        ["skills", "info", ASSISTANT_SKILL_NAME, "--json"],
        {
          encoding: "utf8",
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...(process.env || {}), [PROBE_GUARD_ENV]: "1" },
        },
        (error, stdout) => {
          if (error) return resolve(null);
          try {
            const parsed = JSON.parse(String(stdout));
            resolve(parsed && typeof parsed === "object" ? parsed : null);
          } catch (_) {
            resolve(null);
          }
        },
      );
    } catch (_) {
      resolve(null);
    }
  });
}

function activeGuideVersion(listing, bundled) {
  const fromFile = listing.filePath ? readGuideVersionFile(listing.filePath) : null;
  if (fromFile) return fromFile;

  return listing.source === BUNDLED_SKILL_SOURCE ? bundled : null;
}

function unknownAssistantSkill(bundled = null) {
  return {
    name: ASSISTANT_SKILL_NAME,
    activeSource: "unknown",
    activeGuideVersion: null,
    bundledGuideVersion: bundled,
    shadowed: null,
    evidence: "skill-listing-unavailable",
    nextAction: null,
  };
}

function assistantSkillSummary(options = {}) {
  const bundled = bundledGuideVersion(options);
  return Promise.resolve(readSkillListing(options)).then((listing) => {
    if (!listing || typeof listing.source !== "string" || !listing.source) {
      return unknownAssistantSkill(bundled);
    }
    const shadowed = listing.source !== BUNDLED_SKILL_SOURCE;
    return {
      name: ASSISTANT_SKILL_NAME,
      activeSource: listing.source,
      activeGuideVersion: activeGuideVersion(listing, bundled),
      bundledGuideVersion: bundled,
      shadowed,
      evidence: "host-skill-listing",
      nextAction: shadowed ? ASSISTANT_SHADOW_ACTION : null,
    };
  }).catch(() => unknownAssistantSkill(bundled));
}

module.exports = { ASSISTANT_SHADOW_ACTION, ASSISTANT_SKILL_NAME, BUNDLED_SKILL_FROM_MODULE, BUNDLED_SKILL_SOURCE, assistantSkillSummary, bundledGuideVersion, parseGuideVersion, readSkillListing, unknownAssistantSkill };
