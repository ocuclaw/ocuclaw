const { stripAllTaggedSpans } = require("../domain/tagged-span-strip.cjs");

const DISTILLER_SESSION_PREFIX = "ocuclaw:title-distiller:";
const TITLE_MAX = 55;

const EXCERPT_FENCE = "<<<OCUCLAW_UNTRUSTED_CONVERSATION>>>";
const EXCERPT_FENCE_END = "<<<END_OCUCLAW_UNTRUSTED_CONVERSATION>>>";

function isDistillerSessionKey(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.startsWith(DISTILLER_SESSION_PREFIX);
}

function stripAgentSessionPrefix(sessionKey) {
  if (typeof sessionKey !== "string") return sessionKey;
  const m = /^agent:[^:]+:(.+)$/.exec(sessionKey);
  return m ? m[1] : sessionKey;
}

function sanitizeTitle(raw) {
  if (typeof raw !== "string") return null;

  let s = raw.split("\n")[0];
  s = stripAllTaggedSpans(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!s) return null;

  let prev;
  do {
    prev = s;
    s = s
      .replace(/^["'“”‘’]+/, "")
      .replace(/["'“”‘’]+$/, "")
      .replace(/[.!?,;:]+$/, "")
      .trim();
  } while (s !== prev && s.length > 0);
  if (!s) return null;
  if (s.toUpperCase() === "SKIP") return null;
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX).trim();
  return s || null;
}

function internalTranscriptFilename(runId) {
  const safe = String(runId == null ? "" : runId)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120) || "run";
  return `${safe}.jsonl`;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function extractAssistantTitleFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role !== "assistant") continue;
    const text = extractText(m.content);
    if (text && text.trim()) return text;
  }
  return "";
}

function buildExcerpt(messages, opts = {}) {
  const maxMessages = Number.isFinite(opts.maxMessages) ? opts.maxMessages : 6;
  const per = Number.isFinite(opts.perMessageChars) ? opts.perMessageChars : 280;
  const recent = (Array.isArray(messages) ? messages : []).slice(-maxMessages);
  return recent
    .map((m) => {
      const role = m && m.role === "assistant" ? "assistant" : "user";
      let text = extractText(m && m.content);

      text = text.split(EXCERPT_FENCE).join(" ").split(EXCERPT_FENCE_END).join(" ");
      text = text.replace(/\s+/g, " ").trim();
      if (text.length > per) text = text.slice(0, per);
      return `${role}: ${text}`;
    })
    .join("\n");
}

function splitModelRef(ref) {
  if (typeof ref !== "string") return null;
  const normalized = ref.trim();
  if (!normalized) return null;
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash >= normalized.length - 1) {
    return { model: normalized };
  }
  const provider = normalized.slice(0, slash).trim();
  const model = normalized.slice(slash + 1).trim();
  if (!provider || !model) return { model: normalized };
  return { provider, model };
}

function buildDistillerAgentParams(opts) {
  const params = {
    message: opts.message,
    sessionKey: opts.sessionKey,
    idempotencyKey: opts.idempotencyKey,
    modelRun: true,
    promptMode: "none",
    sessionEffects: "internal",
    suppressPromptPersistence: true,
    disableMessageTool: true,
    deliver: false,
    lane: "background",
  };

  const ref = splitModelRef(opts.model);
  if (ref) {
    if (ref.provider) params.provider = ref.provider;
    params.model = ref.model;
  }
  return params;
}

module.exports = { DISTILLER_SESSION_PREFIX, TITLE_MAX, EXCERPT_FENCE, EXCERPT_FENCE_END, isDistillerSessionKey, stripAgentSessionPrefix, sanitizeTitle, internalTranscriptFilename, buildExcerpt, splitModelRef, buildDistillerAgentParams, extractAssistantTitleFromMessages };
