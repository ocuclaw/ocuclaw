const { filterDisplayEmojiText } = require("./message-emoji-filter.cjs");
const { stripAllTaggedSpans } = require("./tagged-span-strip.cjs");
const { marked } = require("marked");

const DEFAULT_AGENT_NAME = "Agent";
const REPLY_DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;
const REPLY_DIRECTIVE_SENTINEL = "\u0000";
const STANDALONE_REPLY_DIRECTIVE_LINE_RE = /^[ \t]*\u0000[ \t]*(?:\r?\n)?/gm;
const INLINE_REPLY_DIRECTIVE_RE = /[ \t]*\u0000[ \t]*/g;
const SYNTHETIC_SESSION_START_PREFIX_RE = /^a\s+new\s+session\s+was\s+started\b/;
const SYNTHETIC_SESSION_START_SHAPE_RE =
  /\b(?:new|fresh)\s+session\b|\bsession\b.*\b(?:started|reset|created)\b/;
const SYNTHETIC_SESSION_INSTRUCTION_PATTERNS = [
  /\bgreet\b/,
  /\bconfigured\b.*\b(?:persona|style|voice)\b/,
  /\bbe yourself\b|\bmannerisms\b|\bmood\b/,
  /\b(?:1-3|1 to 3|one to three)\s+sentences?\b/,
  /\bask\b.*\bwhat\b.*\bwant\b.*\bdo\b/,
  /\bdefault(?:_| )model\b/,
  /\bdo not mention\b/,
  /\binternal\b.*\b(?:steps|files|tools|reasoning)\b/,
];

let messages = [];
let agentName = DEFAULT_AGENT_NAME;
let displayEntries = [];
let cachedTranscript = "";
let transcriptDirty = false;
let assistantCommitGeneration = 0;
let assistantCommitPresent = false;
let assistantCommitText = "";

function buildDisplayEntry(msg, options = {}) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return null;

  let text = extractText(msg.content);
  if (!text) return null;

  if (msg.role === "assistant") {
    text = stripAllTaggedSpans(text);
  }

  const { text: plainText } = markdownToPlainText(text, {
    stripReplyTags: msg.role === "assistant",
  });
  if (!plainText) return null;
  if (
    msg.role === "user" &&
    options.isFirstVisibleEntry === true &&
    isLikelySyntheticSessionStarterPrompt(plainText)
  ) {
    return null;
  }

  return {
    role: msg.role,
    text: plainText,
    name: typeof msg.name === "string" && msg.name ? msg.name : null,
  };
}

function normalizeSessionStarterCandidate(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/^\s*>+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function countSyntheticSessionInstructionSignals(normalizedText) {
  let count = 0;
  for (const pattern of SYNTHETIC_SESSION_INSTRUCTION_PATTERNS) {
    if (pattern.test(normalizedText)) count += 1;
  }
  return count;
}

function isLikelySyntheticSessionStarterPrompt(text) {
  const normalized = normalizeSessionStarterCandidate(text);
  if (!normalized) return false;
  if (!normalized.includes("/new") || !normalized.includes("/reset")) return false;

  if (SYNTHETIC_SESSION_START_PREFIX_RE.test(normalized)) {
    return true;
  }
  if (normalized.length < 80) return false;
  if (!SYNTHETIC_SESSION_START_SHAPE_RE.test(normalized)) return false;
  return countSyntheticSessionInstructionSignals(normalized) >= 2;
}

function formatEntry(entry) {
  if (entry.role === "user") return `• ${entry.text}`;
  const name = entry.name || agentName;
  return `${name}: ${entry.text}`;
}

function rebuildDisplayCache() {
  displayEntries = [];
  assistantCommitPresent = false;
  assistantCommitText = "";
  for (const msg of messages) {
    const entry = buildDisplayEntry(msg, {
      isFirstVisibleEntry: displayEntries.length === 0,
    });
    if (entry) {
      displayEntries.push(entry);
      if (entry.role === "assistant") {
        assistantCommitPresent = true;
        assistantCommitText = entry.text;
      }
    }
  }
  transcriptDirty = true;
}

function getTranscript() {
  if (!transcriptDirty) return cachedTranscript;
  cachedTranscript = displayEntries.map((entry) => formatEntry(entry)).join("\n\n");
  transcriptDirty = false;
  return cachedTranscript;
}

function stripReplyDirectives(text) {
  if (!text) return "";

  const withSentinel = text.replace(REPLY_DIRECTIVE_TAG_RE, REPLY_DIRECTIVE_SENTINEL);
  if (withSentinel === text) return text;

  return withSentinel
    .replace(STANDALONE_REPLY_DIRECTIVE_LINE_RE, "")
    .replace(INLINE_REPLY_DIRECTIVE_RE, " ")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\r?\n{3,}/g, "\n\n")
    .replace(/^(?:\r?\n)+/, "")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\u0000/g, "")
    .trimEnd();
}

function renderInlineTokens(tokens) {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "codespan":
        out += token.text;
        break;
      case "strong":
      case "em":
      case "del":
      case "link":
        out += token.tokens ? renderInlineTokens(token.tokens) : (token.text || "");
        break;
      case "br":
        out += "\n";
        break;
      case "escape":
        out += token.text || "";
        break;
      case "html":

        break;
      case "image":
        out += token.text || token.title || "";
        break;
      default:

        if (token.text) out += token.text;
        break;
    }
  }
  return out;
}

function renderBlockTokens(tokens) {
  const blocks = [];

  for (const token of tokens) {
    switch (token.type) {
      case "paragraph":
        blocks.push(token.tokens ? renderInlineTokens(token.tokens) : token.text);
        break;

      case "heading":
        blocks.push(token.tokens ? renderInlineTokens(token.tokens) : token.text);
        break;

      case "text":

        blocks.push(token.tokens ? renderInlineTokens(token.tokens) : token.text);
        break;

      case "code":
        blocks.push(token.text);
        break;

      case "blockquote":
        if (token.tokens) {
          const inner = renderBlockTokens(token.tokens);
          blocks.push(...inner);
        }
        break;

      case "list": {
        const items = [];
        for (const item of token.items) {
          const itemText = item.tokens ? renderBlockTokens(item.tokens).join("\n") : item.text;
          const bullet = token.ordered
            ? `${items.length + 1}. `
            : "- ";
          items.push(bullet + itemText);
        }
        blocks.push(items.join("\n"));
        break;
      }

      case "table": {
        const rows = [];

        rows.push(
          token.header.map((cell) => renderInlineTokens(cell.tokens)).join(" | ")
        );

        for (const row of token.rows) {
          rows.push(
            row.map((cell) => renderInlineTokens(cell.tokens)).join(" | ")
          );
        }
        blocks.push(rows.join("\n"));
        break;
      }

      case "hr":

        break;

      case "space":

        break;

      case "html":

        break;

      default:

        if (token.tokens) {
          blocks.push(...renderBlockTokens(token.tokens));
        } else if (token.text) {
          blocks.push(token.text);
        }
        break;
    }
  }

  return blocks;
}

function cleanupDisplayWhitespace(text) {
  return text
    .replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ")
    .replace(/[ \t]+$/gm, "");
}

function markdownToPlainText(markdown, options = {}) {
  if (!markdown) return { text: "" };
  const source = options.stripReplyTags ? stripReplyDirectives(markdown) : markdown;
  if (!source) return { text: "" };

  const tokens = marked.lexer(source);
  const blocks = renderBlockTokens(tokens);
  const text = cleanupDisplayWhitespace(
    filterDisplayEmojiText(blocks.join("\n\n"))
  );

  return { text };
}

function extractText(content) {
  if (typeof content === "string") {
    return content || null;
  }

  if (!Array.isArray(content)) return null;

  const textParts = [];
  let hasImage = false;
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
    if (block && block.type === "image") {
      hasImage = true;
    }
  }

  const text = textParts.length > 0 ? textParts.join("\n\n") : null;
  if (!hasImage) return text;
  if (!text) return "[Image]";
  return `[Image] ${text}`;
}

function filterAndFormat() {
  return displayEntries.map((entry) => ({
    text: formatEntry(entry),
    role: entry.role,
  }));
}

function groupIntoTurns(formatted) {
  const turns = [];
  let current = [];

  for (const entry of formatted) {
    if (entry.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(entry);
  }

  if (current.length > 0) {
    turns.push(current);
  }

  return turns;
}

function paginate() {
  if (displayEntries.length === 0) return [];

  const allText = getTranscript();

  return [{ content: allText, subPage: null, turn: null }];
}

const conversationState = {

  hydrate(msgs, name) {
    messages = Array.isArray(msgs) ? [...msgs] : [];
    if (name) agentName = name;
    rebuildDisplayCache();

  },

  addMessage(role, content, name) {
    const msg = { role, content };
    if (name) msg.name = name;
    messages.push(msg);

    const entry = buildDisplayEntry(msg, {
      isFirstVisibleEntry: displayEntries.length === 0,
    });
    if (!entry) return;

    if (entry.role === "assistant") {
      assistantCommitGeneration += 1;
      assistantCommitPresent = true;
      assistantCommitText = entry.text;
    }

    displayEntries.push(entry);
    const nextLine = formatEntry(entry);
    if (transcriptDirty) return;
    if (!cachedTranscript) {
      cachedTranscript = nextLine;
    } else {
      cachedTranscript += `\n\n${nextLine}`;
    }
  },

  replaceLatestUserMessage(content, name) {
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== "user") {
      index -= 1;
    }

    const msg = { role: "user", content };
    if (name) msg.name = name;

    if (index >= 0) {
      messages = messages.slice(0, index);
    }
    messages.push(msg);
    rebuildDisplayCache();
  },

  setAgentName(name) {
    const next = name || DEFAULT_AGENT_NAME;
    if (agentName === next) return;
    agentName = next;
    transcriptDirty = true;
  },

  getPages() {
    return paginate();
  },

  getPageCount() {
    return displayEntries.length > 0 ? 1 : 0;
  },

  getRawMessages() {
    return [...messages];
  },

  getAssistantCommitSnapshot() {
    if (!assistantCommitPresent) return null;
    return {
      generation: assistantCommitGeneration,
      text: assistantCommitText,
    };
  },

  clear() {
    messages = [];
    agentName = DEFAULT_AGENT_NAME;
    displayEntries = [];
    cachedTranscript = "";
    transcriptDirty = false;
    assistantCommitPresent = false;
    assistantCommitText = "";
  },

  _markdownToPlainText: markdownToPlainText,
  _extractText: extractText,
  _isLikelySyntheticSessionStarterPrompt: isLikelySyntheticSessionStarterPrompt,
};

const {
  hydrate,
  addMessage,
  replaceLatestUserMessage,
  setAgentName,
  getPages,
  getPageCount,
  getRawMessages,
  getAssistantCommitSnapshot,
  clear,
  _markdownToPlainText,
  _extractText,
  _isLikelySyntheticSessionStarterPrompt,
} = conversationState;

module.exports = conversationState;
