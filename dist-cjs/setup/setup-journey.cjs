const { createHash } = require("node:crypto");
const { hostname } = require("node:os");
const { resolve } = require("node:path");
const FIRST_USE_SUCCESS = "OcuClaw setup is complete. Optional integrations can wait.";
const OPTIONAL_SETUP_HANDOFF = "Optional: on your phone, open OcuClaw > Settings > Optional setup. Choose what you want, or leave it for later.";

function firstUseSuccess(record) {
  const evidence = record?.confirmation && record.confirmation.source !== "test-input"
    ? "You confirmed the reply appeared on your glasses."
    : record?.replyEvidence === "client_sdk_receipt"
      ? "Your phone reported SDK acceptance of the reply."
      : "";
  return [FIRST_USE_SUCCESS, evidence, OPTIONAL_SETUP_HANDOFF].filter(Boolean).join(" ");
}
const FIRST_USE_RETRY = "Send a new message from the phone in this OpenClaw session, wait for its reply, then run openclaw ocuclaw first-use again.";

function setupInstallation(stateDir) {
  return {
    backend: "openclaw",
    id: stateDir
      ? createHash("sha256")
          .update(JSON.stringify([hostname(), process.getuid?.() ?? null, resolve(stateDir)]))
          .digest("hex")
      : null,
    evidence: stateDir ? "host-state-namespace" : "unknown",
  };
}

function coldCertificateWindow(route, daemon) {
  if (!route || typeof route !== "object") return false;
  if (route.route?.classification !== "ready") return false;
  if (route.ownership?.status !== "owned") return false;
  if (route.reachability?.target !== "listening") return false;
  if (route.reachability?.frontDoor !== "timeout") return false;
  if (daemon && daemon.state !== "running") return false;
  return true;
}

const CLOUDWAYS_INSTALL_ACTION =
  "This is a Cloudways managed host. There is no system Tailscale here and there cannot be: no root, no TUN device, no working installer. Do not look for a `tailscale` binary and do not ask the user whether Cloudways supports Tailscale. Read references/cloudways.md, then in your own terminal run `openclaw ocuclaw cloudways install --json`, then `openclaw ocuclaw cloudways status --wait 45 --json`, then `openclaw ocuclaw cloudways enroll --json` if it reports needs-authorization, and give the user the authorization link it prints. Re-read journey after each step. Never run `openclaw gateway restart` on this host: it is a no-op.";

function cloudwaysRouteBlocked(route, daemon, host) {
  if (!host || host.managed !== "cloudways") return false;
  if (daemon && daemon.state === "absent") return true;

  return route?.route?.readCode === "serve_cli_absent" || route?.evidence === "serve_cli_absent";
}

function privateRouteAction(route, daemon = null, host = null) {

  if (cloudwaysRouteBlocked(route, daemon, host)) return CLOUDWAYS_INSTALL_ACTION;
  if (!route || typeof route !== "object" || !route.route) {
    return host?.managed === "cloudways"
      ? CLOUDWAYS_INSTALL_ACTION
      : "Use the existing private-route checks to resolve the exact live route; inspect ownership before proposing any change.";
  }
  const port = route.servePort;
  const reobserve = "then re-read journey so the controller observes the applied route fresh before pairing.";
  if (route.evidence === "route_receipt_unavailable" || route.proposal?.reason === "route_receipt_unavailable") {
    return "Route ownership could not be recorded. Have the installation owner check host-state write access and the existing receipt lock, then retry journey. Do not remove a lock while its owner is active; pairing remains blocked.";
  }
  if (route.evidence === "route_receipt_not_written_route_not_fully_identified" ||
      route.proposal?.reason === "route_receipt_not_written_route_not_fully_identified") {
    return "Route ownership could not be tied to this installation. Resolve the host installation identity, then retry journey; pairing remains blocked.";
  }
  switch (route.status) {
    case "healthy":
      return `The private route on :${port} is verified and owned by this installation; resume without reconfiguring it. The phone address is wss://<this node's tailnet name from your own tailscale status>:${port}.`;
    case "missing":
    case "stale":
      if (route.proposal?.status === "presented" && route.proposal.applyCommand) {
        return `${route.status === "stale" ? "This installation's route is stale and must be re-applied" : "No private route exists yet"}. In your own terminal (with sudo or an administrator shell where Tailscale requires it) run exactly: ${route.proposal.applyCommand} — ${reobserve}`;
      }
      return `The private route on :${port} is ${route.status} but no apply command can be presented (${route.proposal?.reason ?? "unknown"}); resolve that first, ${reobserve}`;
    case "foreign":
      return `Something else occupies :${port} on this host (${route.evidence}). Do not replace it: inspect what owns it with tailscale serve status, decide with its owner, ${reobserve}`;
    case "conflicting":
      return `:${port} is claimed by another gateway or a web handler (${route.evidence}). This installation must not overwrite it; resolve the claim with its owner, ${reobserve}`;
    case "exposed":
      return `The :${port} route is published beyond the tailnet by Funnel. Remove the Funnel exposure through Tailscale before continuing — OcuClaw never uses Funnel — ${reobserve}`;
    case "unreachable":

      if (coldCertificateWindow(route, daemon)) {
        return `The :${port} route is applied and this installation owns it, the relay is listening, and the only thing missing is the TLS certificate Tailscale issues on the first connection. That first secure connection can take up to a minute. Do the wait inside this same turn: sleep 60 seconds in your own terminal, or re-read journey up to 3 times about 30 seconds apart, and only then answer. Never say you will re-check later and end the turn, because nothing wakes you; if you must stop, ask the user to say "check the route again" in a minute. Only a repeat timeout after that wait points at MagicDNS, HTTPS Certificates in the tailnet admin console, or the relay itself. Change nothing in the meantime.`;
      }
      return `The :${port} route is configured for this relay but did not prove reachable (${route.evidence}). Check that the relay is listening on its loopback port and that HTTPS certificates are enabled for this tailnet, ${reobserve}`;
    case "offline":
      return "Tailscale on this host is not running and online; sign in and bring it up, then re-read journey.";
    default:
      return `The private route could not be classified (${route.evidence}). Inspect tailscale serve status --json; an unreadable route is never treated as ready or as absent.`;
  }
}

function tailnetDaemonBlock(tailnetDaemon) {
  if (!tailnetDaemon || typeof tailnetDaemon !== "object") return null;
  const daemonState = typeof tailnetDaemon.state === "string" ? tailnetDaemon.state : "unknown";
  return {
    state: daemonState,
    detail: typeof tailnetDaemon.detail === "string" ? tailnetDaemon.detail : "",
    blocking: daemonState !== "running",
  };
}

function tailnetDaemonAction(daemon) {
  if (daemon.state === "absent") return CLOUDWAYS_INSTALL_ACTION;
  if (daemon.state === "needs-authorization") {
    return "The Cloudways Tailscale node is not authorized yet. Run `openclaw ocuclaw cloudways enroll --json`, give the user the https://login.tailscale.com link it returns and ask them to approve the node on a device signed in to their tailnet, then run `openclaw ocuclaw cloudways status --wait 45 --json` until it reports running. Never ask for their identity-provider password.";
  }
  if (daemon.state === "starting") {
    return "The Cloudways Tailscale daemon is still starting. Run `openclaw ocuclaw cloudways status --wait 45 --json` before judging the route. Change nothing else.";
  }
  if (daemon.state === "stopped") {
    return "The Cloudways Tailscale daemon is installed but not answering. Run `openclaw ocuclaw cloudways status --json`; if its supervisor reports disabled run `openclaw ocuclaw cloudways enable --json`, otherwise run `openclaw ocuclaw cloudways status --wait 120 --json` (the plugin restarts it on its own within about a minute). Never start tailscaled by hand and never run `openclaw gateway restart` on this host.";
  }
  return "The Cloudways Tailscale daemon state could not be read. Run `openclaw ocuclaw cloudways status --json` and follow references/cloudways.md. Do not start tailscaled by hand.";
}

function setupJourney(state, installation, route = null, firstUse = null, tailnetDaemon = null) {
  const daemon = tailnetDaemonBlock(tailnetDaemon);

  const host = state.host && typeof state.host === "object" ? state.host : null;

  const assistantSkill = state.assistantSkill && typeof state.assistantSkill === "object"
    ? state.assistantSkill
    : null;
  const testComplete = firstUse?.confirmation?.source === "test-input";
  const coreComplete = firstUse?.status === "completed" && !testComplete;
  const replyConfirmed = !!firstUse?.confirmation && !testComplete;

  const receiptEvidenced = firstUse?.replyEvidence === "client_sdk_receipt";
  const firstUseStatus = testComplete && firstUse?.status === "completed" ? "awaiting-confirmation" : firstUse?.status ?? "awaiting-reply";
  const awaitingWelcome = firstUseStatus === "awaiting-welcome";
  const welcomeAction = coreComplete ? "Welcome dismissed. No action needed."
    : state.capabilities.welcome !== "available"
    ? "The welcome capability is unavailable or could not be verified. Check the owning runtime and tool policy; preserve the confirmed reply and do not claim welcome completion."
    : firstUse?.welcome?.attempts >= 2
    ? "Welcome remains incomplete after its one retry. Preserve the confirmed reply and diagnose the failure; do not render again automatically."
    : firstUse?.welcome
      ? "The previous welcome wait ended or was interrupted. Offer one explicit first_use_welcome_retry with the saved reply binding; do not replay the prior surface."
      : "Tell the wearer a welcome image is coming and to double-tap it to return to the conversation, then immediately call first_use_welcome with the confirmed reply binding. Observe the dismissal automatically.";
  const firstUseAction = coreComplete ? firstUseSuccess(firstUse)
    : firstUseStatus === "unavailable" ? "Have the installation owner check setup state access and ownership. Preserve the existing record; do not claim completion."
    : awaitingWelcome ? welcomeAction
    : firstUse?.observation?.answer === "no" ? "The wearer reported that the reply did not appear. Preserve that observation, diagnose the glasses path, then offer an explicit fresh first_use_retry; do not ask the same visibility question again or show welcome."
    : state.capabilities.toolFirstUse === "unknown" ? "The owning runtime could not be reached. Check its health before choosing the supported first-use flow; preserve the checkpoint."
    : state.capabilities.toolFirstUse === "available"
      ? firstUseStatus === "awaiting-confirmation"
        ? "Call first_use_wait to read the bound reply, then ask: Did that reply appear on your glasses? Record only the explicit wearer answer with first_use_confirm and its binding. A negative answer leaves setup unfinished; repair the path before an explicit first_use_retry."
        : "Call first_use_begin to arm or resume the intended phone session before asking for a fresh phone message; then first_use_wait. Preserve the binding on normal resume."
    : firstUseStatus === "awaiting-confirmation"
      ? "A completed phone reply is recorded. In your own terminal run openclaw ocuclaw first-use and confirm only if that reply appeared on G2. If it never appeared, run openclaw ocuclaw first-use --retry before a fresh phone send. The assistant must not answer for you."
      : firstUse ? FIRST_USE_RETRY
      : "Open the intended OpenClaw conversation on the phone, then run openclaw ocuclaw first-use in your own terminal to begin this installation's first-reply checkpoint.";
  const configured = state.configuration.issueIds.length === 0 &&
    state.secrets.relayToken.presence === "present" &&
    state.secrets.gatewayToken.presence === "present";
  const unavailableEvidence = { status: "unknown", evidence: "not-observable-by-controller" };

  const credentialPresent = state.secrets.relayToken.presence === "present";
  const provisioningAvailable = state.capabilities.credentialProvisioning === "available";
  const pairingAvailable = state.capabilities.pairing === "available";
  const credentialDisposition = credentialPresent
    ? "preserve-existing"
    : provisioningAvailable && pairingAvailable
      ? "host-provisionable"
      : "operator-entry-required";
  const credentialDispositionReason = credentialPresent
    ? "credential-already-configured"
    : credentialDisposition === "host-provisionable"
      ? "host-provisioning-available"
      : provisioningAvailable
        ? "pairing-unavailable"
        : "credential-provisioning-unavailable";
  const canProvisionCredential = credentialDisposition === "host-provisionable";

  const load = state.relayCredentialLoad && typeof state.relayCredentialLoad === "object"
    ? state.relayCredentialLoad
    : null;
  const credentialOrigin = !credentialPresent
    ? null
    : load && load.origin === "host-minted-at-load"
      ? "host-minted-at-load"
      : "pre-existing";
  const mintOnLoad = load && load.mintOnLoad && typeof load.mintOnLoad === "object"
    ? {
        status: load.mintOnLoad.status,
        code: load.mintOnLoad.code,
        detail: load.mintOnLoad.detail,
        adoptedInProcess: load.adoptedInProcess === true,
      }
    : { status: "not-observable", code: null, detail: null, adoptedInProcess: false };
  const configureHostAction = canProvisionCredential
    ? "Have this host generate the Relay Credential through the approved provision_relay_credential setup operation instead of asking the user to invent, copy or retype a password; it only runs on verified-empty configuration and preserves any existing credential. Resolve the remaining required configuration through the existing setup or recovery guide."
    : "Use the existing setup or recovery guide to resolve required configuration; preserve existing credentials.";
  const checkpoints = [
    {
      id: "verify-plugin", status: state.plugin.enabled === false ? "disabled"
        : state.plugin.status === "loaded" ? "complete" : "unknown",
      reason: state.plugin.enabled === false ? "plugin-disabled" : "plugin-load-unverified",
      action: "Use the existing bootstrap or plugin recovery checks to verify OcuClaw is enabled and loaded in this host.",
    },
    {
      id: "verify-host", status: state.compatibility.status === "compatible" ? "complete" : state.compatibility.status,
      reason: "host-compatibility-unverified",
      action: "Verify the supported OpenClaw host version before continuing.",
    },
    {
      id: "configure-host", status: configured ? "complete" : "incomplete",
      reason: state.configuration.status === "invalid" ? "invalid-required-configuration" : "missing-required-configuration",
      action: configureHostAction,
    },
    {
      id: "verify-relay", status: state.runtime.status === "running" ? "complete" : state.runtime.status,
      reason: `relay-${state.runtime.status}`,
      action: state.runtime.status === "starting"
        ? "Inspect the gateway log for the pending relay bind before requesting another restart."
        : "Verify the relay in the owning gateway; use the existing gateway recovery path if it is unavailable.",
    },
    {
      id: "verify-private-route", status: route?.status === "healthy" ? "complete" : route?.status ?? "unknown", reason: route?.evidence ?? "private-route-evidence-unavailable",

      action: daemon?.blocking ? tailnetDaemonAction(daemon) : privateRouteAction(route, daemon, host),
      ...(daemon ? { tailnetDaemon: daemon } : {}),
    },
    {
      id: "pair-phone", status: pairingAvailable ? (state.runtime.appClientConnected === true ? "complete" : "incomplete") : "unavailable",
      reason: pairingAvailable ? "direct-terminal-pairing" : "pairing-operation-unavailable",
      action: pairingAvailable
        ? "In your own interactive terminal run openclaw ocuclaw pair. Scan QR or use its short-lived Manual code, compare all four words on the phone and terminal, then explicitly approve or refuse. The assistant must not run or capture this ceremony. Re-read journey afterwards to resume this installation; an already connected phone is current health, not durable pairing or first-use proof."
        : "This host cannot offer the production terminal ceremony: it is outside the plugin's declared OpenClaw compatibility window (2026.6.9 or newer) or lacks the runtime APIs the ceremony uses. Move to a supported host (recommended OpenClaw 2026.9.4) and re-read journey; preserve existing credentials.",
    },
    {

      id: "phone-origin-proof", status: replyConfirmed || receiptEvidenced ? "complete" : awaitingWelcome ? "awaiting-confirmation" : firstUseStatus,
      reason: replyConfirmed ? "wearer-confirmed-phone-reply"
        : receiptEvidenced ? "client-sdk-receipt-phone-reply"
        : awaitingWelcome ? "awaiting-confirmation" : firstUseStatus,
      action: firstUseAction,
    },
    ...(firstUse?.completionPolicy === "reply-and-welcome" ? [{

      id: "welcome-round-trip", status: coreComplete ? "complete"
        : firstUse?.welcome?.status === "completed" ? "incomplete" : firstUse?.welcome?.status ?? "not-started",
      reason: coreComplete ? "bound-phone-welcome-dismissal" : firstUse?.welcome?.reason ?? "welcome-dismissal-required",
      action: welcomeAction,
    }] : []),
  ];
  const next = checkpoints.find((checkpoint) => checkpoint.status !== "complete");
  return {
    schemaVersion: 1,
    operation: "journey",
    observedAt: new Date().toISOString(),
    ...(host ? { host } : {}),
    ...(assistantSkill ? { assistantSkill } : {}),
    installation,
    capabilities: state.capabilities,
    toolPolicy: state.toolPolicy,
    durableFacts: {
      requiredConfiguration: {
        status: configured ? "complete" : "incomplete",
        evidence: "current-owning-host-configuration",
        validation: state.configuration,
      },
      installation: state.plugin.install,

      relayCredential: {
        ...state.secrets.relayToken,
        provisioning: state.capabilities.credentialProvisioning,
        disposition: credentialDisposition,
        dispositionReason: credentialDispositionReason,

        origin: credentialOrigin,
        mintOnLoad: mintOnLoad,
      },
      securePairing: unavailableEvidence,
    },
    currentHealth: {
      relay: state.runtime.status,
      relayEvidence: state.runtime.statusEvidence,
      phone: state.runtime.appClientConnected === null ? "unknown"
        : state.runtime.appClientConnected ? "connected" : "disconnected",
      privateRoute: route ?? unavailableEvidence,
      ...(daemon ? { tailnetDaemon: daemon } : {}),
    },
    ...(daemon?.blocking && next?.id === "verify-private-route" ? { subCheck: "tailnet-daemon" } : {}),
    firstUse: {
      status: firstUseStatus,
      evidence: firstUse ? "installation-scoped-checkpoint" : "not-started",
      sessionKey: firstUse?.sessionKey ?? null,
      phoneOriginRoundTrip: firstUse?.reply ? "complete" : "not-proven",
      wearerConfirmedG2Reply: replyConfirmed ? "confirmed" : "not-confirmed",
      acceptance: testComplete ? "test-input-only" : replyConfirmed ? "wearer-confirmed" : "not-confirmed",
      confirmationSource: firstUse?.confirmation?.source ?? null,
      replyEvidence: firstUse?.replyEvidence ?? "wearer_confirmed",
      replyEvidenceReason: firstUse?.replyEvidenceReason ?? null,
      welcome: firstUse?.completionPolicy === "reply-and-welcome" ? firstUse?.welcome?.status ?? "not-started" : "not-required-legacy",
      action: firstUseAction,
    },
    checkpoints,
    nextCheckpoint: coreComplete ? null : awaitingWelcome ? checkpoints.find((c) => c.id === "welcome-round-trip")
      : firstUse?.reply ? checkpoints.find((c) => c.id === "phone-origin-proof") : next,
    recoveryCheckpoint: next && next.id !== "phone-origin-proof" ? next : null,
    outcome: coreComplete ? "completed" : "incomplete",
    message: firstUseAction,
    failureReason: coreComplete ? null : next?.reason ?? "checkpoint-evidence-unavailable",
    coreComplete,
    mutationPerformed: false,
    receiptPolicy: "observation-only-recheck-owning-host-on-every-call",
  };
}

module.exports = { setupInstallation, setupJourney, FIRST_USE_SUCCESS, FIRST_USE_RETRY, firstUseSuccess };
