const { normalizeEvenAiDefaultAgent } = require("../even-ai/even-ai-settings-store.cjs");
const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { HERMES_DEFAULT_PROFILE } = require("./hermes-enrollment.cjs");

const { ocuClawDefaultAgentAsAgentId } = require("./ocuclaw-settings-store.cjs");

function createMintAgentRefs(ctx                      ) {
  const { ocuClawSettingsStore, evenAiSettingsStore, logger, emitDebug, hermesEnrollment } = ctx;

  let appBindingMismatchLogged = false;

  function getAppPathwayAgentRef() {
    const pathways = ocuClawSettingsStore.getSnapshot().pathways;
    const app =
      pathways && typeof pathways === "object"
        ? Reflect.get(pathways, "app")
        : null;
    const rawBinding =
      app && typeof app === "object" ? Reflect.get(app, "binding") : null;
    const binding = Object.assign(
      { backend: "", agentRef: "" },
      rawBinding && typeof rawBinding === "object" ? rawBinding : {},
    );
    const localBackendKind = getActiveBackendKind();
    if (binding.backend && binding.backend !== localBackendKind) {
      if (!appBindingMismatchLogged) {
        appBindingMismatchLogged = true;
        logger.warn(
          `[relay] pathways.app binding targets ${binding.backend}; ` +
            `local backend is ${localBackendKind}, using the local default`,
        );
      }
      return "";
    }
    appBindingMismatchLogged = false;
    return typeof binding.agentRef === "string" ? binding.agentRef.trim() : "";
  }

  function getOcuClawDefaultAgentRefForMint() {
    return hermesEnrollment.resolveAgentRef(
      ocuClawDefaultAgentAsAgentId(ocuClawSettingsStore.getSnapshot().defaultAgent),
      "ocuclaw_default_agent",
    );
  }

  function getEvenAiDefaultAgentRefForMint() {
    return hermesEnrollment.resolveAgentRef(
      normalizeEvenAiDefaultAgent(evenAiSettingsStore.getSnapshot().defaultAgent),
      "even_ai_default_agent",
    );
  }

  function getAppPathwayAgentRefForMint() {
    const raw = getAppPathwayAgentRef();
    if (!raw) return "";
    if (!hermesEnrollment.agentRefIsUnenrolled(raw)) return raw;
    emitDebug(
      "relay.session",
      "hermes_agent_ref_not_enrolled",
      "warn",
      {},
      () => ({
        source: "app_pathway_binding",
        requested: raw,
        fallback: getOcuClawDefaultAgentRefForMint() || HERMES_DEFAULT_PROFILE,
      }),
    );
    return "";
  }

  function getDefaultSessionAgentRef() {
    return getAppPathwayAgentRefForMint() || getOcuClawDefaultAgentRefForMint();
  }

  async function resolveEvenAiMintAgentRef(input      = {}) {
    const oneShotAgentRef =
      typeof input.oneShotAgentRef === "string" ? input.oneShotAgentRef.trim() : "";
    const bindingAgentRef =
      typeof input.bindingAgentRef === "string" ? input.bindingAgentRef.trim() : "";
    await hermesEnrollment.ensureFresh("even_ai_mint");
    if (getActiveBackendKind() !== "hermes") {
      return {
        agentRef: oneShotAgentRef || bindingAgentRef || "",
        oneShotHonoured: !!oneShotAgentRef,
      };
    }
    const noteFallback = (source     , requested     ) => {
      emitDebug(
        "relay.session",
        "hermes_agent_ref_not_enrolled",
        "warn",
        {},
        () => ({
          source,
          requested,
          fallback: getEvenAiDefaultAgentRefForMint() || HERMES_DEFAULT_PROFILE,
        }),
      );
    };
    if (oneShotAgentRef) {
      if (!hermesEnrollment.agentRefIsUnenrolled(oneShotAgentRef)) {
        return { agentRef: oneShotAgentRef, oneShotHonoured: true };
      }
      noteFallback("even_ai_agent_once", oneShotAgentRef);
    }
    if (bindingAgentRef) {
      if (!hermesEnrollment.agentRefIsUnenrolled(bindingAgentRef)) {
        return { agentRef: bindingAgentRef, oneShotHonoured: false };
      }
      noteFallback("hey_even_pathway_binding", bindingAgentRef);
    }
    return {
      agentRef: getEvenAiDefaultAgentRefForMint(),
      oneShotHonoured: false,
    };
  }

  return {
    getAppPathwayAgentRef,
    getOcuClawDefaultAgentRefForMint,
    getEvenAiDefaultAgentRefForMint,
    getDefaultSessionAgentRef,
    resolveEvenAiMintAgentRef,
  };
}

module.exports = { createMintAgentRefs };
