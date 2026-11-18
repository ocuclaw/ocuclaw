const { composeChannelTwoFragment, composeEvenAiTurnChannelTwoFragment, composeIntroPictureChannelTwoFragment, composeLiveuiTaskIndexChannelTwoFragment, composeSecretEntryChannelTwoFragment } = require("../domain/prompt-channel-fragments.cjs");
const { LIVEUI_TASK_INDEX_MAX_CHARS, formatLiveuiTaskIndex } = require("../tools/glasses-ui-task-index.cjs");
const { relaySessionKeyFor } = require("./openclaw-session-key.cjs");
const { DEFAULT_REPLY_LANGUAGE, composeReplyLanguageFragment } = require("../domain/reply-language.cjs");

function createChannelTwoHook(service, opts = {}) {
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const readOpt = (name     , fallback     ) => (...args     ) => {
    try {
      const read = Reflect.get(opts, name);
      return typeof read === "function" ? read(...args) : fallback;
    } catch (_err) {
      return fallback;
    }
  };
  const stableContextPlacement = readOpt("getStableContextPlacement", "turn");
  const sessionHarness = readOpt("getSessionHarness", null);
  let taskIndexErrorEmitted = false;

  const everConnected = new Set();
  const renderGatePending = new Set();

  const systemPlacedSessions = new Set();

  const replyLanguageBySession = new Map();
  const capped = (set) => {
    if (set.size >= 512) set.clear();
    return set;
  };
  return function channelTwoBeforePromptBuild(_event, ctx) {
    const sessionKey =
      ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
        ? ctx.sessionKey
        : null;
    if (!sessionKey) return undefined;

    try {
      if (typeof service.isAutomationRun === "function" && service.isAutomationRun(sessionKey) === true) return undefined;
    } catch (_err) {

    }

    const stateSessionKey = relaySessionKeyFor(sessionKey) || sessionKey;
    const openClawAgentScoped = stateSessionKey !== sessionKey;

    const runIdentity =
      ctx && typeof ctx.runId === "string" && ctx.runId.trim() ? ctx.runId : null;
    let promptOwnership = null;
    try {
      promptOwnership =
        typeof service.consumePromptTurnOwnership === "function"
          ? service.consumePromptTurnOwnership(sessionKey, runIdentity)
          : null;
    } catch (_err) {
      promptOwnership = null;
    }
    const evenAiTurn = promptOwnership?.owner === "even-ai";

    let glassesConnected = true;
    try {
      glassesConnected =
        typeof service.hasConnectedAppClient === "function"
          ? service.hasConnectedAppClient()
          : true;
    } catch (_err) {

      glassesConnected = true;
    }
    const glassesWasConnected = everConnected.has(stateSessionKey);
    if (glassesConnected) capped(everConnected).add(stateSessionKey);

    let fragment;
    if (!evenAiTurn) {
      try {
        fragment = composeChannelTwoFragment({
          startEnabled: service.getDisplayStartStates(stateSessionKey),
          currentEnabled: service.getDisplayCurrentStates(stateSessionKey),
          glassesConnected,
          glassesWasConnected,
          renderGateLifted: glassesConnected && renderGatePending.has(stateSessionKey),
        });
        if (glassesConnected) {
          renderGatePending.delete(stateSessionKey);
        } else if (glassesWasConnected) {
          capped(renderGatePending).add(stateSessionKey);
        }
        if (fragment) {
          emitDebug("relay.session", "channel_two_fragment_injected", "debug",
            { sessionKey }, () => ({ chars: fragment.length }));
        }
      } catch (_err) {

        fragment = undefined;
      }
    }

    let evenAiFragment;
    if (evenAiTurn && openClawAgentScoped) {
      try {
        const ownerPrompt =
          typeof service.getEvenAiSystemPrompt === "function"
            ? service.getEvenAiSystemPrompt()
            : "";
        const composed = composeEvenAiTurnChannelTwoFragment(ownerPrompt, {
          sharesOcuClawSession: !!promptOwnership?.sharesOcuClawSession,
        });
        evenAiFragment = composed;

        if (composed) {
          emitDebug("relay.session", "even_ai_prompt_fragment_injected", "debug",
            { sessionKey }, () => ({
              chars: composed.length,
              ownerPromptChars:
                typeof ownerPrompt === "string" ? ownerPrompt.trim().length : 0,
              sharesOcuClawSession: !!promptOwnership?.sharesOcuClawSession,
            }));
        }
      } catch (err) {

        evenAiFragment = undefined;
        try {
          emitDebug("relay.session", "even_ai_prompt_fragment_failed", "warn",
            { sessionKey }, () => ({
              message: String(err),
            }));
        } catch (_) {

        }
      }
    } else if (evenAiTurn) {

      try {
        emitDebug("relay.session", "even_ai_prompt_fragment_undeliverable", "warn",
          { sessionKey }, () => ({
            reason: "session_key_not_agent_scoped",
          }));
      } catch (_) {

      }
    }

    let taskIndexFragment;
    if (!evenAiTurn) {
      try {
        const rows = typeof service.getTaskIndexRows === "function"
          ? service.getTaskIndexRows()
          : [];
        const taskIndex = formatLiveuiTaskIndex(rows);
        if (taskIndex.length > LIVEUI_TASK_INDEX_MAX_CHARS) {
          throw new Error("Task index exceeded the prompt budget");
        }
        taskIndexFragment = composeLiveuiTaskIndexChannelTwoFragment(taskIndex);
        if (taskIndexFragment) {
          emitDebug("relay.session", "task_index_fragment_injected", "debug",
            { sessionKey }, () => ({ chars: taskIndex.length }));
        }
      } catch (err) {
        taskIndexFragment = undefined;
        if (!taskIndexErrorEmitted) {
          taskIndexErrorEmitted = true;
          try {
            emitDebug("relay.session", "task_index_fragment_failed", "warn",
              { sessionKey }, () => ({
                message: String(err),
              }));
          } catch (_) {

          }
        }
      }
    }

    let replyLanguageFragment;
    const replyLanguage = !evenAiTurn ? promptOwnership?.replyLanguage : undefined;
    if (replyLanguage) {
      const previous = replyLanguageBySession.get(stateSessionKey);
      let show;
      if (runIdentity && previous && previous.runId === runIdentity) {

        show = previous.show;
      } else {
        show =
          replyLanguage !== DEFAULT_REPLY_LANGUAGE ||
          (!!previous && previous.language !== replyLanguage);
        if (!replyLanguageBySession.has(stateSessionKey) && replyLanguageBySession.size >= 512) {
          replyLanguageBySession.clear();
        }
        replyLanguageBySession.set(stateSessionKey, {
          language: replyLanguage,
          runId: runIdentity,
          show,
        });
      }
      if (show) replyLanguageFragment = composeReplyLanguageFragment(replyLanguage);
      if (replyLanguageFragment) {
        emitDebug("relay.session", "reply_language_fragment_injected", "debug",
          { sessionKey }, () => ({ replyLanguage, chars: replyLanguageFragment.length }));
      }
    }

    let secretEntryFragment;
    if (!evenAiTurn && openClawAgentScoped) {
      try {
        secretEntryFragment = composeSecretEntryChannelTwoFragment(
          typeof service.hasSecretEntryClient === "function" && service.hasSecretEntryClient(),
        );
      } catch (_err) {
        secretEntryFragment = undefined;
      }
    }

    let introPictureFragment;
    if (!evenAiTurn && openClawAgentScoped) {
      try {
        introPictureFragment = composeIntroPictureChannelTwoFragment(
          typeof service.isAgentBootstrapPending === "function" && service.isAgentBootstrapPending(),
          typeof service.hasConnectedAppClient === "function" && service.hasConnectedAppClient(),
        );
      } catch (_err) {
        introPictureFragment = undefined;
      }
    }
    if (
      !fragment && !taskIndexFragment && !evenAiFragment && !replyLanguageFragment &&
      !secretEntryFragment && !introPictureFragment
    ) {
      return undefined;
    }

    let taskIndexInSystem;
    let evenAiInSystem;
    let replyLanguageInSystem;
    let secretEntryInSystem;
    if (openClawAgentScoped && stableContextPlacement() === "system") {
      const provider = ctx && typeof ctx.modelProviderId === "string" ? ctx.modelProviderId : undefined;
      const model = ctx && typeof ctx.modelId === "string" ? ctx.modelId : undefined;
      const placementKey = `${sessionKey}|${provider || ""}/${model || ""}`;
      const harness = sessionHarness(sessionKey, provider, model);
      const useSystem = harness
        ? !/^codex/i.test(harness)
        : systemPlacedSessions.has(placementKey);
      if (useSystem) {
        capped(systemPlacedSessions).add(placementKey);
      } else {
        systemPlacedSessions.delete(placementKey);
      }
      if (useSystem) {
        taskIndexInSystem = taskIndexFragment;
        taskIndexFragment = undefined;
        replyLanguageInSystem = replyLanguageFragment;
        replyLanguageFragment = undefined;
        secretEntryInSystem = secretEntryFragment;
        secretEntryFragment = undefined;
        if (evenAiFragment && !promptOwnership?.sharesOcuClawSession) {
          evenAiInSystem = evenAiFragment;
          evenAiFragment = undefined;
        }
      }
    }

    const prependContext = [
      evenAiFragment,
      openClawAgentScoped ? fragment : undefined,
      taskIndexFragment,
      replyLanguageFragment,
      secretEntryFragment,
    ].filter((part) => typeof part === "string" && part).join("\n\n") || undefined;
    const appendSystemContext = [
      evenAiInSystem,
      !openClawAgentScoped ? fragment : undefined,
      taskIndexInSystem,
      replyLanguageInSystem,
      secretEntryInSystem,
      introPictureFragment,
    ].filter((part) => typeof part === "string" && part).join("\n\n") || undefined;
    return {
      ...(appendSystemContext ? { appendSystemContext } : {}),
      ...(prependContext ? { prependContext } : {}),
    };
  };
}

module.exports = { createChannelTwoHook };
