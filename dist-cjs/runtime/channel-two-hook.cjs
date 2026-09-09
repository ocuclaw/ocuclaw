const { composeChannelTwoFragment, composeEvenAiTurnChannelTwoFragment, composeLiveuiTaskIndexChannelTwoFragment } = require("../domain/prompt-channel-fragments.cjs");
const { LIVEUI_TASK_INDEX_MAX_CHARS, formatLiveuiTaskIndex } = require("../tools/glasses-ui-task-index.cjs");
const { relaySessionKeyFor } = require("./openclaw-session-key.cjs");

function createChannelTwoHook(service, opts = {}) {
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  let taskIndexErrorEmitted = false;

  const everConnected = new Set();
  const renderGatePending = new Set();
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
    if (!fragment && !taskIndexFragment && !evenAiFragment) return undefined;

    const prependContext = [
      evenAiFragment,
      openClawAgentScoped ? fragment : undefined,
      taskIndexFragment,
    ].filter((part) => typeof part === "string" && part).join("\n\n") || undefined;
    return {
      ...(fragment && !openClawAgentScoped ? { appendSystemContext: fragment } : {}),
      ...(prependContext ? { prependContext } : {}),
    };
  };
}

module.exports = { createChannelTwoHook };
