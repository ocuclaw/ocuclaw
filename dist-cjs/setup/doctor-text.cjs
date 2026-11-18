const { hostIsCloudways } = require("./cloudways-host.cjs");
const { CAPABILITY_CONSENT_COMMAND } = require("./capability-consent.cjs");
const { CODEX_LIVE_REASONING_NOTE_ID } = require("./codex-engine.cjs");

const DOCTOR_JSON_HINT = "Add --json for the full report.";

const RERUN = "openclaw ocuclaw doctor";

function restartStep(cloudways         ) {
  return cloudways
    ? `wait a few seconds (Cloudways reloads OpenClaw by itself), then run ${RERUN} again`
    : `run openclaw gateway restart, then run ${RERUN} again`;
}

const CHECKS = Object.freeze([
  { label: "Plugin permissions", ids: ["plugin.capability-consent-required"] },
  { label: "Task list and Even AI prompt", ids: ["task_index_prompt_injection_disabled"] },
  { label: "OcuClaw settings", ids: ["configuration.invalid", "configuration.evidence-unavailable"] },
  { label: "Gateway token", ids: ["configuration.gateway-token-absent"] },
  {
    label: "Phone connection key",
    ids: ["configuration.relay-token-absent", "configuration.relay-credential-mint-blocked"],
  },
  { label: "OpenClaw version", ids: ["compatibility.host-incompatible", "compatibility.evidence-unavailable"] },
  {
    label: "OcuClaw service",
    ids: ["runtime.start-pending-bind", "runtime.not-running", "runtime.evidence-unavailable"],
  },
  { label: "Agent setup tool", ids: ["tool-policy.evidence-unavailable"] },
]);

function settingNames(issueIds     ) {
  const ids = Array.isArray(issueIds) ? issueIds.filter((id     ) => typeof id === "string") : [];
  return ids.map((id        ) => id.replace(/-invalid$/, "").replace(/-/g, " "));
}

function plainFinding(item     , cloudways         ) {
  switch (item.id) {
    case "plugin.capability-consent-required":
      return {
        summary: "OpenClaw needs you to approve OcuClaw's permissions again (common after an OpenClaw update).",
        fix: CAPABILITY_CONSENT_COMMAND,
      };
    case "task_index_prompt_injection_disabled":
      return {
        summary: "OpenClaw is blocking OcuClaw from adding notes to your agent's turns, so the task list on your glasses and your saved Even AI prompt are off.",
        fix: `openclaw config set plugins.entries.ocuclaw.hooks.allowPromptInjection true --strict-json, then ${restartStep(cloudways)}`,
      };
    case "configuration.invalid": {
      const names = settingNames(item.evidence);
      return {
        summary: names.length > 0
          ? `Some OcuClaw settings have values that are not allowed: ${names.join(", ")}.`
          : "Some OcuClaw settings have values that are not allowed.",
        fix: `correct those values under plugins.entries.ocuclaw.config in your OpenClaw config file, then ${restartStep(cloudways)}`,
      };
    }
    case "configuration.evidence-unavailable":
      return {
        summary: "Could not fully check OcuClaw's settings from this terminal. OpenClaw checks them when it loads OcuClaw.",
        fix: null,
      };
    case "configuration.gateway-token-absent":
      return {
        summary: "OpenClaw has no gateway token, so OcuClaw cannot sign in to your agent.",
        fix: "run openclaw onboard to finish OpenClaw's setup (it creates the token)",
      };
    case "configuration.relay-token-absent":
      return {
        summary: "OcuClaw has not created the key your phone uses to connect yet. It creates one by itself when OpenClaw loads it.",
        fix: `openclaw plugins enable ocuclaw, then ${restartStep(cloudways)}`,
      };
    case "configuration.relay-credential-mint-blocked":
      return {
        summary: "OcuClaw could not save the key your phone uses to connect.",
        fix: `make sure OpenClaw can write its config file and the plugins.entries.ocuclaw.config section in it is valid, then ${restartStep(cloudways)}`,
      };
    case "compatibility.host-incompatible":
      return {
        summary: "Your OpenClaw is too old for this version of OcuClaw.",
        fix: "openclaw update",
      };
    case "compatibility.evidence-unavailable":
      return {
        summary: "Could not read your OpenClaw version from this terminal.",
        fix: null,
      };
    case "runtime.not-running":
      return {
        summary: "OcuClaw is not running inside OpenClaw right now, so your phone cannot connect.",
        fix: cloudways ? restartStep(true) : "openclaw gateway restart",
      };
    case "runtime.start-pending-bind":
      return {
        summary: "OcuClaw could not start, most likely because another program is using its network port.",
        fix: `run openclaw logs and look for "address already in use"; stop that program or pick a free port (openclaw config set plugins.entries.ocuclaw.config.wsPort <port> --strict-json), then ${restartStep(cloudways)}`,
      };
    case "runtime.evidence-unavailable":
      return {
        summary: "Could not check from this terminal whether OcuClaw is running inside OpenClaw. The OcuClaw app shows whether your phone is connected.",
        fix: null,
      };
    case "tool-policy.evidence-unavailable":
      return {
        summary: "Could not check from this terminal whether your agent can use OcuClaw's setup tool.",
        fix: null,
      };
    default:
      return {
        summary: typeof item.explanation === "string" && item.explanation
          ? item.explanation
          : "A check reported a problem.",
        fix: null,
      };
  }
}

function plainNote(item     ) {
  switch (item.id) {
    case CODEX_LIVE_REASONING_NOTE_ID:
      return {
        label: "Live reasoning",
        summary: "Your agent uses OpenClaw's Codex engine. Live reasoning on the glasses needs an OpenClaw release with upstream fix #188076, and none has shipped yet. Until then the glasses show \"Reasoning...\" and each tool action.",
        next: "nothing to do now; run openclaw update once a release includes #188076",
      };
    default:
      return {
        label: "Note",
        summary: typeof item.explanation === "string" && item.explanation ? item.explanation : "See the full report.",
        next: null,
      };
  }
}

function mark(item     ) {
  return item.severity === "error" ? "✗" : "!";
}

function doctorBlocked(report     ) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  return report?.health === "blocked" || findings.some((item     ) => item?.severity === "error");
}

function doctorExitCode(report     ) {
  return doctorBlocked(report) ? 1 : 0;
}

function verdict(report     , findings       ) {
  if (doctorBlocked(report)) {
    const count = findings.filter((item) => item.severity === "error").length;
    return `Not ready: fix the ${count === 1 ? "✗ item" : `${count} ✗ items`} above, then run ${RERUN} again.`;
  }
  const actionable = findings.filter((item) => !String(item.id).endsWith("evidence-unavailable"));
  if (actionable.length > 0) {
    return `OcuClaw can run, but ${actionable.length === 1 ? "1 item needs" : `${actionable.length} items need`} your attention (marked !).`;
  }
  if (findings.length > 0) return "No problems found, but some checks could not run from this terminal (marked !).";
  return "All checks passed.";
}

function renderDoctorText(report     ) {
  const cloudways = hostIsCloudways(report?.host);
  const findings = (Array.isArray(report?.findings) ? report.findings : [])
    .filter((item     ) => item && typeof item.id === "string");
  const lines = ["OcuClaw doctor", ""];
  const shown = new Set();
  const printFinding = (label        , item     ) => {
    const plain = plainFinding(item, cloudways);
    lines.push(`${mark(item)} ${label}: ${plain.summary}`);
    if (plain.fix) lines.push(`  Fix: ${plain.fix}`);
    shown.add(item);
  };
  for (const check of CHECKS) {
    const matched = findings.filter((item     ) => check.ids.includes(item.id));
    if (matched.length === 0) {
      lines.push(`✓ ${check.label}: no problems found`);
      continue;
    }
    for (const item of matched) printFinding(check.label, item);
  }
  for (const item of findings) {
    if (!shown.has(item)) printFinding("Other", item);
  }

  const notes = (Array.isArray(report?.notes) ? report.notes : [])
    .filter((item     ) => item && typeof item.id === "string");
  for (const item of notes) {
    const plain = plainNote(item);
    lines.push(`i ${plain.label}: ${plain.summary}`);
    if (plain.next) lines.push(`  Next: ${plain.next}`);
  }
  lines.push("", verdict(report, findings), DOCTOR_JSON_HINT);
  return `${lines.join("\n")}\n`;
}

module.exports = { DOCTOR_JSON_HINT, doctorBlocked, doctorExitCode, renderDoctorText };
