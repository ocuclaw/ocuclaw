const { parseOptionalTrimmedString, parseEnvelopeOnly } = require("./downstream-parse-optional.cjs");

const JA_WORD = /^[々ぁ-ゟ゠-ヿ㐀-䶿一-鿿A-Za-z]{1,31}$/;

const JA_READING = /^[ぁ-ゟ゠-ヿA-Za-z]{1,31}$/;

const SILENT_INPUT_ACTIONS                           = {

  "webui-silent-input-prediction-test": parseEnvelopeOnly,

  "webui-silent-input-word"(msg, payload) {

    const operation = parseOptionalTrimmedString(msg.value);

    const storeOps = ["add", "remove", "favourite", "unfavourite", "hide", "restore"];
    const sectionOps = [
      "open", "open-words", "back", "search", "draft", "submit", "edit", "edit-draft", "save", "cancel", "remove-row", "star", "undo", "dismiss", "replace-stored",
      "hide-row", "restore-row", "find", "hide-found", "favourite-found", "restore-hidden",

      "row-menu",

      "storage-fault",

      "forget-spelled",
    ];
    if (!operation || (!storeOps.includes(operation) && !sectionOps.includes(operation))) {
      throw new Error("remote-control webui-silent-input-word requires a supported operation");
    }
    if (storeOps.includes(operation)) {
      const word = parseOptionalTrimmedString(msg.text);

      if (msg.locale === "ja") {
        const [display = "", reading, extra] = (word ?? "").split("|").map((part) => part.trim());
        const readingOk = reading === undefined || (operation === "add" && JA_READING.test(reading));
        if (!JA_WORD.test(display) || !readingOk || extra !== undefined) {
          throw new Error("remote-control webui-silent-input-word requires text: a Japanese word, 1-31, and on add |reading");
        }
        return { ...payload, value: operation, text: reading === undefined ? display : `${display}|${reading}` };
      }
      if (!word || !/^(?:[A-Za-z]{1,31}|[\u3131-\u3163\uAC00-\uD7A3]{1,31})$/.test(word)) {
        throw new Error("remote-control webui-silent-input-word requires text: 1-31 English letters or Hangul");
      }
      return { ...payload, value: operation, text: word };
    }
    const text = typeof msg.text === "string" ? msg.text : "";
    if (text.length > 200 || text.includes("\n")) {
      throw new Error("remote-control webui-silent-input-word requires a single line of at most 200 chars");
    }
    return { ...payload, value: operation, text };
  },

  "webui-silent-input-suggestions"(msg, payload) {

    const operation = parseOptionalTrimmedString(msg.value);
    const ops = [
      "check:replies", "off:replies",
      "add-key-paste", "add-key-save", "add-key-cancel",

      "key-remove", "key-refresh", "liveui-jev-on", "liveui-jev-off", "liveui-key-open",
      "liveui-apply", "liveui-title-icons-on", "liveui-title-icons-off",
      "liveui-video-subtitles-on", "liveui-video-subtitles-off",
    ];

    const modelPick = /^model:[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(operation || "");
    if (!operation || (!ops.includes(operation) && !modelPick)) {
      throw new Error("remote-control webui-silent-input-suggestions requires a supported operation");
    }
    if (operation === "add-key-paste") {
      const key = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!key || !/^[\x21-\x7e]{1,4096}$/.test(key)) {
        throw new Error("remote-control webui-silent-input-suggestions add-key-paste requires text: one printable line of at most 4096 chars");
      }
      return { ...payload, value: operation, text: key };
    }
    return { ...payload, value: operation, text: "" };
  },
};

module.exports = { SILENT_INPUT_ACTIONS };
