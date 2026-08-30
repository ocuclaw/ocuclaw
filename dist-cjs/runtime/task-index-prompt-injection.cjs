const TASK_INDEX_PROMPT_INJECTION_DISABLED_REASON =
  "task_index_prompt_injection_disabled";

const WARNING_SYMBOL = Symbol.for("ocuclaw.task-index.prompt-injection-warning");

function taskIndexPromptInjectionStatus(openclawConfig) {
  const entry = openclawConfig && openclawConfig.plugins &&
    openclawConfig.plugins.entries && openclawConfig.plugins.entries.ocuclaw;
  const disabled = !!(
    entry &&
    entry.hooks &&
    entry.hooks.allowPromptInjection === false
  );
  return {
    status: disabled ? "disabled" : "available",
    reasonCode: disabled ? TASK_INDEX_PROMPT_INJECTION_DISABLED_REASON : null,
    evidence: "plugins.entries.ocuclaw.hooks.allowPromptInjection",
  };
}

function warnTaskIndexPromptInjectionDisabledOnce(
  openclawConfig,
  logger,
  scopeHost = globalThis,
) {
  const status = taskIndexPromptInjectionStatus(openclawConfig);
  if (status.status !== "disabled") return status;
  if (!Reflect.get(scopeHost, WARNING_SYMBOL)) {
    Reflect.set(scopeHost, WARNING_SYMBOL, true);
    try {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[ocuclaw] Task index disabled: allowPromptInjection=false");
      }
    } catch (_) {

    }
  }
  return status;
}

module.exports = { TASK_INDEX_PROMPT_INJECTION_DISABLED_REASON, taskIndexPromptInjectionStatus, warnTaskIndexPromptInjectionDisabledOnce };
