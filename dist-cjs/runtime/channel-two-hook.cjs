const { composeChannelTwoFragment, composeLiveuiTaskIndexChannelTwoFragment } = require("../domain/prompt-channel-fragments.cjs");
const { LIVEUI_TASK_INDEX_MAX_CHARS, formatLiveuiTaskIndex } = require("../tools/glasses-ui-task-index.cjs");

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
    let fragment;
    try {
      const glassesConnected =
        typeof service.hasConnectedAppClient === "function"
          ? service.hasConnectedAppClient()
          : true;
      const glassesWasConnected = everConnected.has(sessionKey);
      fragment = composeChannelTwoFragment({
        startEnabled: service.getDisplayStartStates(sessionKey),
        currentEnabled: service.getDisplayCurrentStates(sessionKey),
        glassesConnected,
        glassesWasConnected,
        renderGateLifted: glassesConnected && renderGatePending.has(sessionKey),
      });
      if (glassesConnected) {
        capped(everConnected).add(sessionKey);
        renderGatePending.delete(sessionKey);
      } else if (glassesWasConnected) {
        capped(renderGatePending).add(sessionKey);
      }
      if (fragment) {
        emitDebug("relay.session", "channel_two_fragment_injected", "debug",
          { sessionKey }, () => ({ chars: fragment.length }));
      }
    } catch (_err) {

      fragment = undefined;
    }

    let taskIndexFragment;
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
    if (!fragment && !taskIndexFragment) return undefined;
    return {
      ...(fragment ? { appendSystemContext: fragment } : {}),
      ...(taskIndexFragment ? { prependContext: taskIndexFragment } : {}),
    };
  };
}

module.exports = { createChannelTwoHook };
