const { detect, disable, DETECT_LIKELY, enable, enroll, install, resolveLayout, rollback, STALE_ENROLLMENT_MESSAGE, STATE_RUNNING, status } = require("./cloudways.cjs");

const EXIT_OK = 0;
const EXIT_PROBLEM = 1;
const EXIT_REFUSED = 2;

const CLOUDWAYS_VERBS = [
  "detect", "install", "enroll", "status", "retry", "enable", "disable", "rollback",
];

function yesNo(value     ) {
  return value ? "yes" : "no";
}

function refused(report     ) {
  return String((report && report.error) || "").includes("never run two supervisors");
}

function renderDetect(report     ) {
  const lines = [`Cloudways detection — ${report.verdict}`, `  hostname  ${report.hostname}`];
  for (const name of Object.keys(report.signals || {}).sort()) {
    lines.push(`  ${report.signals[name] ? "yes" : " . "} ${name}`);
  }
  if (report.verdict === DETECT_LIKELY) {
    lines.push("  Not decisive: ask the user whether this is a Cloudways Managed AI Agents host.");
  }
  return lines;
}

function renderInstall(report     ) {
  const lines = [`Cloudways install — ${report.ok ? "ok" : "FAILED"}`];
  if (report.error) lines.push(`  error     ${report.error}`);
  if (report.binaries) lines.push(`  binaries  ${report.binaries}  (${report.version})`);
  if (report.receipt) lines.push(`  receipt   ${report.receipt}`);
  if (report.daemon) lines.push(`  daemon    ${report.daemon.action}  ${report.daemon.state}  ${report.daemon.detail || ""}`.trimEnd());
  if (report.ok) lines.push("  next: openclaw ocuclaw cloudways status --wait 45, then enroll");
  return lines;
}

function renderEnroll(report     ) {
  const lines = [`Cloudways enroll — ${report.state}`];
  if (report.staleMarkerCleared === true) lines.push(`  ${STALE_ENROLLMENT_MESSAGE}`);
  if (report.authUrl) {
    lines.push("  Open this link on any device signed in to the tailnet, then approve the node:");
    lines.push(`    ${report.authUrl}`);
    lines.push("  Then: openclaw ocuclaw cloudways status --wait 45");
  } else if (report.state === STATE_RUNNING) {
    lines.push(`  node ${report.nodeName} (${report.dnsName}) is authorized and running`);
    lines.push("  Next: read the private route checkpoint and run its printed apply command");
  }
  if (report.error) lines.push(`  error     ${report.error}`);
  return lines;
}

function renderStatus(report     ) {
  const daemon = report.daemon || {};
  const supervisor = report.supervisor || {};
  const legacy = report.legacy || {};
  const lines = [`Cloudways Tailscale — daemon ${daemon.state}`];
  if (daemon.detail) lines.push(`  ${daemon.detail}`);
  if (daemon.nodeName) {
    lines.push(`  node      ${daemon.nodeName}  (${daemon.dnsName || "?"})  online=${yesNo(daemon.online)}`);
  }
  if (daemon.keyExpiry) {
    lines.push(`  key expiry ${daemon.keyExpiry}  (disable expiry for this node in the admin console)`);
  }
  lines.push(`  receipt   ${report.receipt ? "present" : "absent"}  ${(report.layout || {}).receipt || ""}`.trimEnd());
  lines.push(`  supervisor ${supervisor.enabled ? "enabled" : "disabled"}  (${supervisor.owner})`);
  lines.push(`  binaries  ${(report.binaries || {}).present ? "present" : "absent"}  ${(report.binaries || {}).path || ""}`.trimEnd());
  if (daemon.authUrl) {
    lines.push("  authorization needed — open this link on a device signed in to the tailnet, then approve the node:");
    lines.push(`    ${daemon.authUrl}`);
  } else if (report.authorizationPending) {
    lines.push("  authorization needed — run: openclaw ocuclaw cloudways retry");
  } else if (report.needsAuthorizationMarker) {

    lines.push("  stale authorization marker (node is running); the next enable/install pass clears it");
  }
  if (legacy.legacySupervisorPresent) {
    lines.push(`  legacy    supervisor dir present at ${legacy.legacySupervisorDir}  (inactive, left alone)`);
  }
  if ((legacy.foreignDaemonProcesses || []).length > 0) {
    lines.push("  WARNING  another tailscaled is running:");
    for (const item of legacy.foreignDaemonProcesses) lines.push(`    ${item}`);
  }
  return lines;
}

function renderGeneric(title     , report     ) {
  const lines = [`${title} — ${report.ok ? "ok" : "FAILED"}`];
  for (const key of Object.keys(report).sort()) {
    if (key === "ok") continue;
    const value = report[key];
    lines.push(`  ${key.padEnd(12)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }
  return lines;
}

const PLUGIN_UNINSTALL_HINT = [
  "  next: to remove the plugin too, run both lines:",
  "    openclaw plugins uninstall ocuclaw --force",
  "    openclaw config unset plugins.entries.ocuclaw",
  "  (the second line stops OpenClaw 2026.9 keeping OcuClaw switched off on a later install;",
  "   \"Config path not found\" there means nothing was left to clear)",
];

function renderRollback(report     ) {
  const lines = renderGeneric("Cloudways rollback", report);
  return report.ok ? [...lines, ...PLUGIN_UNINSTALL_HINT] : lines;
}

async function runCloudwaysVerb(verb     , options      = {}, deps      = {}) {
  const layout = deps.layout || resolveLayout(options);
  if (verb === "detect") {
    const report = await detect(deps);
    return { exitCode: EXIT_OK, report, lines: renderDetect(report) };
  }
  if (verb === "install") {
    const report = await install(layout, deps);
    const exitCode = report.ok ? EXIT_OK : refused(report) ? EXIT_REFUSED : EXIT_PROBLEM;
    return { exitCode, report, lines: renderInstall(report) };
  }
  if (verb === "enroll" || verb === "retry") {
    const report = await enroll(layout, deps, {
      hostname: options.hostname || null,
      waitS: options.wait === undefined ? 90 : Number(options.wait),
    });
    return { exitCode: report.ok ? EXIT_OK : EXIT_PROBLEM, report, lines: renderEnroll(report) };
  }
  if (verb === "status") {
    const report = await status(layout, deps, { waitS: Number(options.wait || 0) });
    return { exitCode: EXIT_OK, report, lines: renderStatus(report) };
  }
  if (verb === "enable") {
    const report = await enable(layout, deps);
    const exitCode = report.ok ? EXIT_OK : refused(report) ? EXIT_REFUSED : EXIT_PROBLEM;
    return { exitCode, report, lines: renderGeneric("Cloudways enable", report) };
  }
  if (verb === "disable") {
    const report = await disable(layout, deps);
    return { exitCode: report.ok ? EXIT_OK : EXIT_PROBLEM, report, lines: renderGeneric("Cloudways disable", report) };
  }
  if (verb === "rollback") {
    if (options.yes !== true) {
      const report = {
        ok: false,
        error: "rollback stops the daemon and removes the binaries, receipts and state this install created; re-run with --yes",
      };
      return { exitCode: EXIT_REFUSED, report, lines: renderGeneric("Cloudways rollback", report) };
    }
    const report = await rollback(layout, deps, { purgeIdentity: options.purgeIdentity === true });
    return { exitCode: report.ok ? EXIT_OK : EXIT_PROBLEM, report, lines: renderRollback(report) };
  }
  return {
    exitCode: EXIT_REFUSED,
    report: { ok: false, error: `unknown verb: ${verb}` },
    lines: [`openclaw ocuclaw cloudways: unknown verb ${verb}`],
  };
}

function renderCloudwaysOutput(result     , options      = {}) {
  if (options.json === true) return `${JSON.stringify(result.report, null, 2)}\n`;
  return `${result.lines.join("\n")}\n`;
}

module.exports = { EXIT_OK, EXIT_PROBLEM, EXIT_REFUSED, CLOUDWAYS_VERBS, renderDetect, renderInstall, renderEnroll, renderStatus, renderGeneric, PLUGIN_UNINSTALL_HINT, renderRollback, runCloudwaysVerb, renderCloudwaysOutput };
