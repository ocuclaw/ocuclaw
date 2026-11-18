const { parseOptionalTrimmedString } = require("./downstream-parse-optional.cjs");

const SETTINGS_ACTIONS                           = {
  "setting-set"(msg, payload) {
    const settingKey = parseOptionalTrimmedString(msg.settingKey);

    const value = typeof msg.value === "string" ? msg.value.trim() : null;
    if (!settingKey) {
      throw new Error("remote-control setting-set requires settingKey");
    }
    if (value === null) {
      throw new Error("remote-control setting-set requires value");
    }
    payload.settingKey = settingKey;
    payload.value = value;
    return payload;
  },

  "webui-open-tab"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value);
    if (!value) {
      throw new Error("remote-control webui-open-tab requires value");
    }
    payload.value = value;
    return payload;
  },

  "webui-liveui-grant"(msg, payload) {
    const grantAction = parseOptionalTrimmedString(msg.value);
    const host = parseOptionalTrimmedString(msg.text);
    if (grantAction !== "allow" && grantAction !== "deny" && grantAction !== "remove") {
      throw new Error("remote-control webui-liveui-grant requires value allow|deny|remove");
    }
    if (!host) {
      throw new Error("remote-control webui-liveui-grant requires text (the host)");
    }
    return { ...payload, value: grantAction, text: host };
  },

  "webui-secret-entry"(msg, payload) {
    const operation = parseOptionalTrimmedString(msg.value);
    if (operation !== "submit" && operation !== "skip") {
      throw new Error("remote-control webui-secret-entry requires value submit|skip");
    }
    const text = operation === "submit" && typeof msg.text === "string" ? msg.text : "";
    if (operation === "submit" && !text.trim()) {
      throw new Error("remote-control webui-secret-entry submit requires text (the key)");
    }
    return { ...payload, value: operation, text };
  },

  "webui-card-write-prompt"(msg, payload) {
    const operation = parseOptionalTrimmedString(msg.value);
    if (operation !== "send" && operation !== "not-now") {
      throw new Error("remote-control webui-card-write-prompt requires value send|not-now");
    }
    return { ...payload, value: operation };
  },

  "webui-card-write-auto"(msg, payload) {
    const operation = parseOptionalTrimmedString(msg.value);
    if (operation !== "on" && operation !== "confirm" && operation !== "keep" && operation !== "off") {
      throw new Error("remote-control webui-card-write-auto requires value on|confirm|keep|off");
    }
    const text = parseOptionalTrimmedString(msg.text);
    if ((operation === "on" || operation === "off") && !text) {
      throw new Error("remote-control webui-card-write-auto on|off requires text (the card's app id)");
    }
    return { ...payload, value: operation, text: text || "" };
  },

  "webui-temple-editor"(msg, payload) {

    const operation = parseOptionalTrimmedString(msg.value);
    if (!operation || !["open", "picker", "search", "choose", "back", "set", "cancel", "apply"].includes(operation)) {
      throw new Error(
        "remote-control webui-temple-editor requires open|picker|search|choose|back|set|cancel|apply",
      );
    }
    const text = typeof msg.text === "string" ? msg.text : "";

    if (operation === "set" && !/^(LEFT|RIGHT)=[^|,\r\n]{0,200}$/.test(text)) {
      throw new Error(
        "remote-control webui-temple-editor set requires LEFT=<token> or RIGHT=<token> " +
          "(empty for Default; no ',', '|' or newline; max 200 chars)",
      );
    }
    if (operation === "picker" && !/^(LEFT|RIGHT)$/.test(text)) {
      throw new Error("remote-control webui-temple-editor picker requires text LEFT or RIGHT");
    }

    if (operation === "choose" &&
        (typeof msg.text !== "string" || !/^[^|,\r\n]{0,200}$/.test(text))) {
      throw new Error(
        "remote-control webui-temple-editor choose requires a storage token in text " +
          "(empty string for Default; no ',', '|' or newline; max 200 chars)",
      );
    }
    if (operation === "search" &&
        (typeof msg.text !== "string" || text.length > 200 || /[\r\n]/.test(text))) {
      throw new Error(
        "remote-control webui-temple-editor search requires text: a single line of at most 200 chars",
      );
    }
    const carriesText = operation === "set" || operation === "picker" ||
      operation === "choose" || operation === "search";
    return { ...payload, value: operation, text: carriesText ? text : "" };
  },

  "webui-saved-prompts"(msg, payload) {

    const operation = parseOptionalTrimmedString(msg.value);
    if (!operation || !["list", "close", "open", "new", "set", "choose", "apply",
      "cancel", "delete"].includes(operation)) {
      throw new Error(
        "remote-control webui-saved-prompts requires " +
          "list|close|open|new|set|choose|apply|cancel|delete",
      );
    }
    const text = typeof msg.text === "string" ? msg.text : "";

    if ((operation === "set" || operation === "choose") &&
        (typeof msg.text !== "string" || !/^[A-Z]{1,16}=[\s\S]{0,4000}$/.test(text))) {
      throw new Error(
        `remote-control webui-saved-prompts ${operation} requires FIELD=value in text ` +
          "(max 4000 chars)",
      );
    }
    if (operation === "open" && !/^[^|,\r\n]{1,200}$/.test(text)) {
      throw new Error("remote-control webui-saved-prompts open requires a prompt id in text");
    }
    const carriesText = operation === "set" || operation === "choose" || operation === "open";
    return { ...payload, value: operation, text: carriesText ? text : "" };
  },

  "webui-menu-editor"(msg, payload) {
    const operation = parseOptionalTrimmedString(msg.value);
    if (!operation || !["open", "picker", "search", "review", "select", "add", "up", "down", "highlight-up", "highlight-down", "remove", "cancel", "apply"].includes(operation)) {
      throw new Error("remote-control webui-menu-editor requires a supported editor operation");
    }
    if (typeof msg.text !== "string" || msg.text.length > 8192) {
      throw new Error("remote-control webui-menu-editor requires bounded text");
    }
    return { ...payload, value: operation, text: msg.text };
  },

  "webui-reasoning-settings"(msg, payload) {
    const operation = parseOptionalTrimmedString(msg.value);
    if (!operation || !/^(reasoning:(on|off)|activity:(off|status-bar|show-the-work|narration)|notes:(on|off)|live-reasoning:(accept|dismiss)|open-session)$/.test(operation)) {
      throw new Error("remote-control webui-reasoning-settings requires a supported reasoning operation");
    }
    return { ...payload, value: operation };
  },

  "webui-settings-scroll"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);

    const direction = text?.startsWith("sheet:") ? text.slice("sheet:".length) : text;
    if (!direction || !(["start", "end", "up", "down"].includes(direction) || /^to:\d{1,6}$/.test(direction) || (direction === text && /^anchor:[a-z0-9-]{1,64}$/.test(direction)))) throw new Error("Invalid settings scroll direction");
    return { ...payload, text };
  },
};

module.exports = { SETTINGS_ACTIONS };
