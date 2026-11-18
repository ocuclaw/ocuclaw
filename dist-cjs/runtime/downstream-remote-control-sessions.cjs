const { parseOptionalTrimmedString, parseEnvelopeOnly } = require("./downstream-parse-optional.cjs");

const SESSION_ACTIONS                           = {
  "send-message"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text.trim()) {
      throw new Error("remote-control send-message requires non-empty text");
    }
    payload.text = text;
    const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
    if (sessionKey) payload.sessionKey = sessionKey;
    return payload;
  },

  "webui-composer-set-text"(msg, payload) {
    payload.text = typeof msg.text === "string" ? msg.text : "";
    return payload;
  },

  "webui-composer-submit": parseEnvelopeOnly,

  "webui-composer-stop": parseEnvelopeOnly,

  "webui-sessions-search"(msg, payload) {
    const operation = parseOptionalTrimmedString(msg.value);
    if (!["set-query", "submit", "clear", "select-result", "subtab", "selection-enter", "selection-exit", "selection-toggle"].includes(operation || "")) {
      throw new Error("remote-control webui-sessions-search requires a supported search operation");
    }
    return { ...payload, value: operation, text: typeof msg.text === "string" ? msg.text : "" };
  },

  "webui-session-select"(msg, payload) {
    const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
    if (!sessionKey) {
      throw new Error("remote-control webui-session-select requires sessionKey");
    }
    payload.sessionKey = sessionKey;
    return payload;
  },

  "webui-session-sheet"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value);

    if (!value || !["open", "rename", "preview", "input", "save", "done", "cancel", "backdrop", "scroll-start", "scroll-end", "close", "pin", "hide", "confirm-hide", "undo-hide", "dismiss-undo", "switch", "continue", "copy", "take-over", "delete", "sources"].includes(value)) {
      throw new Error("remote-control webui-session-sheet requires a supported value");
    }
    if ((value === "open" || value === "input") && typeof msg.text !== "string") {
      throw new Error("remote-control webui-session-sheet open/input requires text");
    }

    return { ...payload, value, ...(typeof msg.text === "string" ? { text: msg.text } : {}) };
  },

  "webui-session-chips-scroll"(msg, payload) {
    const direction = parseOptionalTrimmedString(msg.text)?.toLowerCase();
    if (direction !== "start" && direction !== "end") {
      throw new Error(
        "remote-control webui-session-chips-scroll requires text start|end",
      );
    }
    return { ...payload, text: direction };
  },
};

module.exports = { SESSION_ACTIONS };
