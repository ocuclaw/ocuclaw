const { parseOptionalTrimmedString, parseEnvelopeOnly } = require("./downstream-parse-optional.cjs");

const PAIRING_ACTIONS                           = {

  "webui-pair-open": parseEnvelopeOnly,
  "webui-pair-read-code": parseEnvelopeOnly,
  "webui-pair-phrase-match": parseEnvelopeOnly,
  "webui-pair-phrase-mismatch": parseEnvelopeOnly,
  "webui-pair-dismiss": parseEnvelopeOnly,

  "webui-pair-scan-payload"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);
    if (!text) {
      throw new Error("remote-control webui-pair-scan-payload requires text");
    }
    return { ...payload, text };
  },

  "webui-pair-manual"(msg, payload) {

    const text = parseOptionalTrimmedString(msg.text);
    const value = parseOptionalTrimmedString(msg.value);
    if (!text) {
      throw new Error("remote-control webui-pair-manual requires text (the address)");
    }
    if (!value) {
      throw new Error("remote-control webui-pair-manual requires value (the pairing code)");
    }
    return { ...payload, text, value };
  },
};

module.exports = { PAIRING_ACTIONS };
