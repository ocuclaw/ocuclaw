const REPLY_LANGUAGE_NAMES                         = {
  en: "English",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  "zh-Hans": "Simplified Chinese (简体中文)",
  "zh-Hant": "Traditional Chinese (繁體中文)",
};

const DEFAULT_REPLY_LANGUAGE = "en";

function normalizeReplyLanguageTag(value         )                {
  if (typeof value !== "string") return null;
  const tag = value.trim();
  return Object.prototype.hasOwnProperty.call(REPLY_LANGUAGE_NAMES, tag) ? tag : null;
}

function replyLanguageName(tag         )                {
  const normalized = normalizeReplyLanguageTag(tag);
  return normalized ? REPLY_LANGUAGE_NAMES[normalized] : null;
}

function composeReplyLanguageFragment(tag         )                     {
  const normalized = normalizeReplyLanguageTag(tag);
  if (!normalized) return undefined;
  const name = REPLY_LANGUAGE_NAMES[normalized];
  return (
    `<reply_language>\n` +
    `The user's OcuClaw app is set to ${name} [${normalized}]. Write this reply in ` +
    `${name}, including text you author for the glasses display (LiveUI ` +
    `surfaces, labels and UI records), even if earlier replies used another ` +
    `language. Exceptions: if this message asks for another language, use it ` +
    `for this reply; if the user asked you to always reply in a specific ` +
    `language from now on, or the owner instructions name a reply language, ` +
    `follow that. A one-off language request in an earlier message applied to ` +
    `that message only. Keep code, commands, identifiers, names and quoted ` +
    `text unchanged.\n` +
    `</reply_language>`
  );
}

module.exports = { DEFAULT_REPLY_LANGUAGE, normalizeReplyLanguageTag, replyLanguageName, composeReplyLanguageFragment };
