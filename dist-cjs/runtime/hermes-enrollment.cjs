const crypto = require("node:crypto");
const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");

const HERMES_DEFAULT_PROFILE = "default";
const HERMES_ENROLLMENT_TTL_MS = 60_000;

const HERMES_ENROLLMENT_REREAD_MIN_MS = 5_000;

function createHermesEnrollment(ctx                         ) {
  const { gatewayBridge, emitDebug, rebroadcastAgentsCatalog } = ctx;

  let enrolledAgents                     = null;
  let fetchedAtMs = 0;
  let refreshInFlight                          = null;

  function noteView(view     ) {
    if (!view || typeof view !== "object" || !Array.isArray(view.agents)) {
      return false;
    }
    const enrolled = new Set([HERMES_DEFAULT_PROFILE]);
    for (const row of view.agents) {
      if (!row || typeof row !== "object") continue;
      if (row.enrolled !== true) continue;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (name) enrolled.add(name);
    }
    enrolledAgents = enrolled;
    fetchedAtMs = Date.now();
    return true;
  }

  function refresh(reason = "lazy") {
    if (getActiveBackendKind() !== "hermes") return Promise.resolve(false);
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = Promise.resolve()
      .then(() =>
        gatewayBridge.request("hermes.management", {
          requestId: crypto.randomUUID(),
          profileId: HERMES_DEFAULT_PROFILE,
          scope: "gateway",
          operation: "agents.list",
          agents: {},
        }),
      )
      .then((result     ) => {
        const noted = noteView(result && result.agents);
        emitDebug(
          "relay.session",
          "hermes_enrollment_refreshed",
          "info",
          {},
          () => ({
            reason,
            noted,
            enrolled: enrolledAgents
              ? Array.from(enrolledAgents).sort()
              : null,
          }),
        );
        return noted;
      })
      .catch((error     ) => {

        emitDebug(
          "relay.session",
          "hermes_enrollment_refresh_failed",
          "warn",
          {},
          () => ({ reason, message: error?.message || String(error) }),
        );
        return false;
      })
      .then((noted     ) => {
        refreshInFlight = null;
        return noted;
      });
    return refreshInFlight;
  }

  function reread(reason        ) {
    return Promise.resolve(refreshInFlight).then(() =>
      refresh(reason),
    );
  }

  function lacks(rawAgent     ) {
    if (enrolledAgents === null) return false;
    const normalized = typeof rawAgent === "string" ? rawAgent.trim() : "";
    if (!normalized || normalized === HERMES_DEFAULT_PROFILE) return false;
    return !enrolledAgents.has(normalized);
  }

  function resolveAgentRef(rawAgent     , reason = "mint") {
    if (getActiveBackendKind() !== "hermes") return "";
    const normalized = typeof rawAgent === "string" ? rawAgent.trim() : "";
    if (!normalized || normalized === HERMES_DEFAULT_PROFILE) return "";
    if (!isFresh()) {

      refresh(reason).catch(() => {});
    }
    if (enrolledAgents === null) return "";
    return enrolledAgents.has(normalized) ? normalized : "";
  }

  function agentRefIsUnenrolled(rawAgent     ) {
    if (getActiveBackendKind() !== "hermes") return false;
    const normalized = typeof rawAgent === "string" ? rawAgent.trim() : "";
    if (!normalized || normalized === HERMES_DEFAULT_PROFILE) return false;
    return resolveAgentRef(normalized, "unenrolled_check") === "";
  }

  function isFresh() {
    return (
      enrolledAgents !== null &&
      Date.now() - fetchedAtMs <= HERMES_ENROLLMENT_TTL_MS
    );
  }

  function ensureFresh(reason = "mint") {
    if (getActiveBackendKind() !== "hermes") return Promise.resolve(false);
    if (isFresh()) return Promise.resolve(true);
    return refresh(reason);
  }

  function stampCatalog(snapshot     ) {
    if (getActiveBackendKind() !== "hermes") return snapshot;
    if (!isFresh()) {
      refresh("agents_catalog").then((noted     ) => {

        if (noted) rebroadcastAgentsCatalog();
      }).catch(() => {});
    } else if (
      !refreshInFlight &&
      Date.now() - fetchedAtMs >= HERMES_ENROLLMENT_REREAD_MIN_MS &&
      Array.isArray(snapshot && snapshot.agents) &&
      snapshot.agents.some((entry     ) => lacks(entry && entry.id))
    ) {

      const before = Array.from(enrolledAgents ).sort().join(",");
      reread("agents_catalog_unknown_agent").then((noted     ) => {
        if (!noted) return;
        if (Array.from(enrolledAgents ).sort().join(",") === before) return;
        rebroadcastAgentsCatalog();
      }).catch(() => {});
    }
    if (enrolledAgents === null) return snapshot;
    return {
      ...(snapshot && typeof snapshot === "object" ? snapshot : {}),
      enrolled: Array.from(enrolledAgents).sort(),
    };
  }

  return {
    noteView,
    refresh,
    reread,
    lacks,
    resolveAgentRef,
    agentRefIsUnenrolled,
    ensureFresh,
    stampCatalog,
  };
}

module.exports = { HERMES_DEFAULT_PROFILE, createHermesEnrollment };
