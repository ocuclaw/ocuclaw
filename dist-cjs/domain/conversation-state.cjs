const { filterDisplayEmojiText } = require("./message-emoji-filter.cjs");
const { stripAllTaggedSpans } = require("./tagged-span-strip.cjs");
const { protectSpeckMarkers, restoreSpeckMarkers, stripSpeckMarkers } = require("./speck-marker.cjs");
const { marked } = require("marked");
const { liftReplySources, replySourceMarkFor } = require("./reply-sources.cjs");
const { createFailedTurnTraces, isFailedTurnMessage } = require("./failed-turn-traces.cjs");

const DEFAULT_AGENT_NAME = "Agent";
const REPLY_DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;
const REPLY_DIRECTIVE_SENTINEL = "\u0000";

const EXACT_BEAT_MARKER = "<beat/>";
const BEAT_MARKER_SENTINEL = "".repeat(EXACT_BEAT_MARKER.length);
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

const NOTICE_ROLE = "notice";
const COMPACTION_SUMMARY_MARKER = "— context compacted —";
const HISTORY_TRUNCATED_MARKER = "— earlier messages not loaded —";
const HISTORY_UNAVAILABLE_MARKER = "— history unavailable —";

let messages        = [];
let agentName = DEFAULT_AGENT_NAME;
let displayEntries = [];

let headNotice      = null;
let cachedTranscript = "";
let transcriptDirty = false;
let entriesRevision = 0;
let ledgerCapable = true;
let assistantCommitGeneration = 0;
let assistantCommitPresent = false;
let assistantCommitText = "";

const pendingUserSendIds = new Set();
const PENDING_USER_SEND_MAX_AGE_MS = 120_000;

const failedTurns = createFailedTurnTraces();
const rawTextOf = (msg     ) => extractText(msg?.content) || "";

const DEFAULT_SEQUENCE_SESSION_KEY = "__default__";
const SEQUENCE_SESSION_MAX = 256;
const sequenceStateBySession = new Map();
let activeSequenceState = createSequenceState();
sequenceStateBySession.set(DEFAULT_SEQUENCE_SESSION_KEY, activeSequenceState);

function createSequenceState() {
  return {
    nextSeq: 0,
    seqByAlias: new Map(),
  };
}

function normalizedSequenceSessionKey(sessionKey     ) {
  if (typeof sessionKey !== "string") return DEFAULT_SEQUENCE_SESSION_KEY;
  return sessionKey.trim() || DEFAULT_SEQUENCE_SESSION_KEY;
}

function activateSequenceSession(sessionKey     , reset      = false) {
  const key = normalizedSequenceSessionKey(sessionKey);
  let state = reset ? null : sequenceStateBySession.get(key);
  if (!state) {
    state = createSequenceState();
  }

  sequenceStateBySession.delete(key);
  sequenceStateBySession.set(key, state);
  while (sequenceStateBySession.size > SEQUENCE_SESSION_MAX) {
    sequenceStateBySession.delete(sequenceStateBySession.keys().next().value);
  }
  activeSequenceState = state;
}

function resetAllSequenceSessions() {
  sequenceStateBySession.clear();
  activeSequenceState = createSequenceState();
  sequenceStateBySession.set(DEFAULT_SEQUENCE_SESSION_KEY, activeSequenceState);
}

function sequenceAliases(entry     ) {
  const aliases = [];
  if (entry.idSource === "server") aliases.push(`id:${entry.id}`);
  if (entry.role === "user" && entry.clientSendId) {
    aliases.push(`send:user:${entry.clientSendId}`);
  }
  return aliases;
}

function mappedSequence(state     , entry     ) {
  for (const alias of sequenceAliases(entry)) {
    if (state.seqByAlias.has(alias)) return state.seqByAlias.get(alias);
  }
  return null;
}

function assignSequence(state     , entry     ) {
  let seq = mappedSequence(state, entry);
  if (!Number.isFinite(seq)) {
    seq = state.nextSeq;
    state.nextSeq += 1;
  } else {
    state.nextSeq = Math.max(state.nextSeq, seq + 1);
  }
  for (const alias of sequenceAliases(entry)) {
    state.seqByAlias.set(alias, seq);
  }
  entry.seq = seq;
  if (entry.idSource === "derived") entry.id = `srv:derived:${seq}`;
  return entry;
}

function requiresSequenceRebase(state     , entries     ) {
  const mapped = entries.map((entry     ) => mappedSequence(state, entry));
  if (state.nextSeq > 0 && entries.length > 0 && mapped.every((seq     ) => seq === null)) {
    return true;
  }
  let lastMappedIndex = -1;
  for (let index = mapped.length - 1; index >= 0; index -= 1) {
    if (mapped[index] !== null) {
      lastMappedIndex = index;
      break;
    }
  }
  let lastMapped = -1;
  for (let index = 0; index < mapped.length; index += 1) {
    const seq = mapped[index];
    if (seq === null) {
      if (index < lastMappedIndex) return true;
      continue;
    }
    if (seq <= lastMapped) return true;
    lastMapped = seq;
  }
  return false;
}

function reclaimUnmappedTailSequence(state     , entries     ) {
  const mapped = entries.map((entry     ) => mappedSequence(state, entry));
  const firstUnmappedIndex = mapped.findIndex((seq     ) => seq === null);
  if (firstUnmappedIndex <= 0) return;
  const previousSeq = mapped[firstUnmappedIndex - 1];
  if (Number.isFinite(previousSeq)) state.nextSeq = previousSeq + 1;
}

function buildDisplayEntry(msg, options = {}) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return null;

  if (msg.compactionSummary === "standalone") {
    return { role: NOTICE_ROLE, text: COMPACTION_SUMMARY_MARKER, name: null };
  }

  let text = extractText(msg.content);
  if (!text) return null;

  let sources        = [];
  if (msg.role === "assistant") {
    text = stripAllTaggedSpans(text);
    sources = liftReplySources(text);

    text = protectSpeckMarkers(text.replaceAll(EXACT_BEAT_MARKER, BEAT_MARKER_SENTINEL));
  }

  const { text: markdownText } = markdownToPlainText(text, {
    stripReplyTags: msg.role === "assistant",
    numberLinks: msg.role === "assistant",
  });
  const plainText = restoreSpeckMarkers(
    markdownText.replaceAll(BEAT_MARKER_SENTINEL, EXACT_BEAT_MARKER),
  );
  if (!plainText) return null;
  if (msg.role === "assistant" && isSilentControlReplyText(plainText)) return null;
  const normalizedOptions      = { ...options };
  if (
    msg.role === "user" &&
    normalizedOptions.isFirstVisibleEntry === true &&
    isLikelySyntheticSessionStarterPrompt(plainText)
  ) {
    return null;
  }

  const seq = Number.isFinite(Number(normalizedOptions.seq))
    ? Math.max(0, Math.floor(Number(normalizedOptions.seq)))
    : 0;
  const rawId = msg.id ?? msg.messageId ?? msg.__openclaw?.id;
  const serverId = typeof rawId === "string" || typeof rawId === "number"
    ? String(rawId).trim()
    : "";
  const clientSendId = typeof (msg.clientSendId ?? msg.sendId) === "string"
    ? String(msg.clientSendId ?? msg.sendId).trim()
    : "";
  const runId = typeof msg.runId === "string" ? msg.runId.trim() : "";
  const identity = serverId
    ? { id: `srv:${serverId}`, idSource: "server" }
    : msg.role === "user" && clientSendId
      ? { id: `srv:send:${clientSendId}`, idSource: "send" }
      : { id: `srv:derived:${seq}`, idSource: "derived" };

  const sentAtMs = sentAtMsOf(msg);
  return {
    ...identity,
    seq,
    rev: Number.isFinite(Number(msg.rev)) ? Math.max(0, Math.floor(Number(msg.rev))) : 0,
    role: msg.role,
    text: plainText,
    name: typeof msg.name === "string" && msg.name ? msg.name : null,
    runId: runId || null,
    clientSendId: clientSendId || null,
    ...(sentAtMs !== null ? { sentAtMs } : {}),

    ...(msg.role === "assistant" && msg.pluginMessage === true ? { pluginMessage: true } : {}),

    ...(isFailedTurnMessage(msg) ? { failedCode: String(msg.failedTurn.code) } : {}),

    ...(sources.length > 0 ? { sources } : {}),
  };
}

function sentAtMsOf(msg     ) {
  return authoredMsOf(msg) ?? arrivalMsOf(msg);
}

const EPOCH_MS_FLOOR = 1e12;

function authoredMsOf(msg     ) {
  const raw = msg?.timestamp;
  if (raw === undefined || raw === null || raw === "" || typeof raw === "boolean") return null;
  let value = Number(raw);
  if (!Number.isFinite(value) && typeof raw === "string") value = Date.parse(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value < EPOCH_MS_FLOOR ? value * 1000 : value);
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

const SILENT_CONTROL_REPLY_TOKENS = ["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"];
const SILENT_CONTROL_REPLY_RES = SILENT_CONTROL_REPLY_TOKENS.map(
  (token) => new RegExp(`^\\s*${token}(?:\\s+${token})*\\s*$`, "i"),
);

function isSilentControlReplyText(text     ) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const bare = trimmed.replace(/^\p{P}+|\p{P}+$/gu, "");
  return SILENT_CONTROL_REPLY_RES.some((re) => re.test(trimmed) || re.test(bare));
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

function upstreamMessageIdentity(msg     ) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return null;
  const idempotencyKey = typeof msg.idempotencyKey === "string"
    ? msg.idempotencyKey.trim()
    : "";
  const mirrorIdentity = typeof msg.__openclaw?.mirrorIdentity === "string"
    ? msg.__openclaw.mirrorIdentity.trim()
    : "";
  const identity = idempotencyKey || mirrorIdentity;
  return identity ? `${msg.role}:${identity}` : null;
}

function abortPartialText(msg     ) {
  return (extractText(msg.content) || "").replace(/\s+/g, " ").trim();
}

function isGatewayAbortPartial(msg     ) {
  return !!msg && msg.role === "assistant" && msg.openclawAbort?.aborted === true;
}

function sameAbortedPartial(gatewayText     , other     ) {
  const otherText = abortPartialText(other);
  if (!otherText || !gatewayText) return false;
  return otherText.startsWith(gatewayText) || gatewayText.startsWith(otherText);
}

function redundantAbortPartialIndexes(msgs     ) {
  const skipped = new Set();
  for (let index = 0; index < msgs.length; index += 1) {
    const gatewayRow = msgs[index];
    if (!isGatewayAbortPartial(gatewayRow)) continue;
    const gatewayText = abortPartialText(gatewayRow);
    for (const step of [-1, 1]) {
      let match = -1;
      for (let probe = index + step; probe >= 0 && probe < msgs.length; probe += step) {
        const other = msgs[probe];
        if (!other || other.role === "user") break;
        if (other.role !== "assistant" || isGatewayAbortPartial(other) || skipped.has(probe)) continue;
        if (sameAbortedPartial(gatewayText, other)) {
          match = probe;
          break;
        }
      }
      if (match < 0) continue;
      skipped.add(gatewayText.length > abortPartialText(msgs[match]).length ? match : index);
      break;
    }
  }
  return skipped;
}

function formatEntry(entry) {

  if (entry.role === NOTICE_ROLE) return entry.text;

  if (entry.role === "user") {
    return entry.name ? `• ${entry.name}: ${entry.text}` : `• ${entry.text}`;
  }
  const name = entry.name || agentName;
  return `${name}: ${stripBeatMarkers(entry.text)}`;
}

function stripBeatMarkers(text = "") {
  const withoutSpeck = stripSpeckMarkers(text);
  if (!withoutSpeck.includes(EXACT_BEAT_MARKER)) return withoutSpeck;
  return withoutSpeck.replace(/ ?<beat\/>(?= )/g, "").replaceAll(EXACT_BEAT_MARKER, "");
}

function rebuildDisplayCache() {
  const rebuiltEntries = [];
  assistantCommitPresent = false;
  assistantCommitText = "";
  const lastMessageIndexByUpstreamIdentity = new Map();
  messages.forEach((msg, index) => {
    const identity = upstreamMessageIdentity(msg);
    if (identity) lastMessageIndexByUpstreamIdentity.set(identity, index);
  });
  const redundantAbortPartials = redundantAbortPartialIndexes(messages);

  let messageEntryCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (redundantAbortPartials.has(index)) continue;
    const upstreamIdentity = upstreamMessageIdentity(msg);
    if (
      upstreamIdentity &&
      lastMessageIndexByUpstreamIdentity.get(upstreamIdentity) !== index
    ) continue;
    const entry = buildDisplayEntry(msg, {
      isFirstVisibleEntry: messageEntryCount === 0,
    });
    if (entry) {
      rebuiltEntries.push(entry);
      if (entry.role !== NOTICE_ROLE) messageEntryCount += 1;
    }
  }

  const messageEntries = rebuiltEntries.filter((entry) => entry.role !== NOTICE_ROLE);
  if (requiresSequenceRebase(activeSequenceState, messageEntries)) {
    activeSequenceState.seqByAlias.clear();
    activeSequenceState.nextSeq = 0;
  } else {

    reclaimUnmappedTailSequence(activeSequenceState, messageEntries);
  }
  const entries = rebuiltEntries.map((entry) =>
    entry.role === NOTICE_ROLE ? entry : assignSequence(activeSequenceState, entry)
  );
  const sequencedMessageEntries = entries.filter((entry) => entry.role !== NOTICE_ROLE);
  const retainedAliases = new Set(
    sequencedMessageEntries.flatMap((entry     ) => sequenceAliases(entry)),
  );
  for (const alias of activeSequenceState.seqByAlias.keys()) {
    if (!retainedAliases.has(alias)) activeSequenceState.seqByAlias.delete(alias);
  }
  ledgerCapable = true;
  for (const entry of sequencedMessageEntries) {
    if (entry.idSource === "derived") ledgerCapable = false;

    if (entry.role === "assistant" && !entry.failedCode) {
      assistantCommitPresent = true;
      assistantCommitText = entry.text;
    }
  }
  if (headNotice) {
    entries.unshift({ role: NOTICE_ROLE, text: headNotice, name: null });
  }
  displayEntries = entries;
  transcriptDirty = true;
}

function getTranscript() {
  if (!transcriptDirty) return cachedTranscript;
  cachedTranscript = displayEntries.map((entry) => formatEntry(entry)).join("\n\n");
  transcriptDirty = false;
  return cachedTranscript;
}

const MEDIA_DIRECTIVE_LINE_RE = /^([ \t]*)MEDIA:[ \t]*\S[^\n]*$/gm;

function mediaLinesAsPictures(text        ) {
  if (!text || !text.includes("MEDIA:")) return text;
  return text.replace(MEDIA_DIRECTIVE_LINE_RE, "$1[Picture]");
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

function renderInlineTokens(tokens, refs                  = null) {
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
        out += token.tokens ? renderInlineTokens(token.tokens, refs) : (token.text || "");
        break;
      case "link":
        out += token.tokens ? renderInlineTokens(token.tokens, refs) : (token.text || "");

        if (refs) out += replySourceMarkFor(refs, token.href);
        break;
      case "br":
        out += "\n";
        break;
      case "escape":
        out += token.text || "";
        break;
      case "html":

        break;
      case "image": {

        const alt = String(token.text || token.title || "").replace(/\s+/g, " ").trim();
        out += alt ? `[Picture: ${alt}]` : "[Picture]";
        break;
      }
      default:

        if (token.text) out += token.text;
        break;
    }
  }
  return out;
}

function renderBlockTokens(tokens, refs                  = null) {
  const blocks = [];

  for (const token of tokens) {
    switch (token.type) {
      case "paragraph":
        blocks.push(token.tokens ? renderInlineTokens(token.tokens, refs) : token.text);
        break;

      case "heading":
        blocks.push(token.tokens ? renderInlineTokens(token.tokens, refs) : token.text);
        break;

      case "text":

        blocks.push(token.tokens ? renderInlineTokens(token.tokens, refs) : token.text);
        break;

      case "code":
        blocks.push(token.text);
        break;

      case "blockquote":
        if (token.tokens) {
          const inner = renderBlockTokens(token.tokens, refs);
          blocks.push(...inner);
        }
        break;

      case "list": {
        const items = [];
        for (const item of token.items) {
          const itemText = item.tokens ? renderBlockTokens(item.tokens, refs).join("\n") : item.text;
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
          token.header.map((cell) => renderInlineTokens(cell.tokens, refs)).join(" | ")
        );

        for (const row of token.rows) {
          rows.push(
            row.map((cell) => renderInlineTokens(cell.tokens, refs)).join(" | ")
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
          blocks.push(...renderBlockTokens(token.tokens, refs));
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
  const source = options.stripReplyTags ? mediaLinesAsPictures(stripReplyDirectives(markdown)) : markdown;
  if (!source) return { text: "" };
  const numberLinks = (options       ).numberLinks === true;
  const prefixCache = (options       ).prefixCache;
  if (prefixCache && typeof prefixCache === "object") {
    return { text: streamingMarkdownToPlainText(source, prefixCache, numberLinks) };
  }

  const tokens = marked.lexer(source);
  const blocks = renderBlockTokens(tokens, numberLinks ? [] : null);
  const text = cleanupDisplayWhitespace(
    filterDisplayEmojiText(blocks.join("\n\n"))
  );

  return { text };
}

const STREAM_CACHE_MAX_ENTRIES = 4;

const STREAM_CARRIAGE_RETURN_RE = /\r\n|\r/g;
const STABLE_BLOCK_START_RE = /^\p{L}/u;

const INLINE_STATE_TAG_RE = /<(?:a\s|pre|code|kbd|script)/i;

function cleanDisplayText(text        )         {
  return cleanupDisplayWhitespace(filterDisplayEmojiText(text));
}

function newLineCache()                  {
  return { lineIn: "", lineOut: "", midIn: "", midOut: "" };
}

function isAsciiAlnum(code        )          {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  );
}

function lastFilterResumePoint(line        , from        )         {
  for (let k = line.length - 1; k > from; k--) {
    if (isAsciiAlnum(line.charCodeAt(k)) && isAsciiAlnum(line.charCodeAt(k - 1))) return k;
  }
  return -1;
}

function cleanDisplayTextIncremental(joined        , lines                 )         {
  if (!joined.startsWith(lines.lineIn)) {
    lines.lineIn = "";
    lines.lineOut = "";
    lines.midIn = "";
    lines.midOut = "";
  }
  let rest = joined.slice(lines.lineIn.length);
  const lastNewline = rest.lastIndexOf("\n");
  if (lastNewline >= 0) {
    const settled = rest.slice(0, lastNewline + 1);
    lines.lineIn += settled;
    lines.lineOut += cleanDisplayText(settled);
    rest = rest.slice(lastNewline + 1);
    lines.midIn = "";
    lines.midOut = "";
  }
  if (!rest.startsWith(lines.midIn)) {
    lines.midIn = "";
    lines.midOut = "";
  }
  const resumeAt = lastFilterResumePoint(rest, lines.midIn.length);
  if (resumeAt > lines.midIn.length) {
    lines.midOut += filterDisplayEmojiText(rest.slice(lines.midIn.length, resumeAt));
    lines.midIn = rest.slice(0, resumeAt);
  }
  const openLine = lines.midOut + filterDisplayEmojiText(rest.slice(lines.midIn.length));
  return lines.lineOut + cleanupDisplayWhitespace(openLine);
}

function joinBlockText(
  headOut        ,
  headBlocks        ,
  restOut        ,
  restBlocks        ,
)         {
  if (headBlocks === 0) return restOut;
  if (restBlocks === 0) return headOut;
  return `${headOut}\n\n${restOut}`;
}

function continuesStablePrefix(source        , stableSrc        )          {
  if (!stableSrc) return true;
  return (
    source.startsWith(stableSrc) &&
    STABLE_BLOCK_START_RE.test(source.slice(stableSrc.length, stableSrc.length + 2))
  );
}

function pickStreamCacheEntry(
  cache                                  ,
  source        ,
  numberLinks         ,
)                   {
  if (!Array.isArray(cache.entries)) cache.entries = [];
  const entries = cache.entries;
  let best = -1;
  let bestLength = -1;
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i].stableSrc;
    if (entries[i].numberLinks !== numberLinks) continue;
    if (key.length > bestLength && continuesStablePrefix(source, key)) {
      best = i;
      bestLength = key.length;
    }
  }
  let entry;
  if (best >= 0) {
    entry = entries.splice(best, 1)[0];
  } else {
    entry = {
      stableSrc: "",
      stableBlocks: 0,
      stableOut: "",
      numberLinks,
      stableRefs: [],
      tailLines: newLineCache(),
      wholeLines: newLineCache(),
    };
    if (entries.length >= STREAM_CACHE_MAX_ENTRIES) entries.pop();
  }
  entries.unshift(entry);
  return entry;
}

function hasReferenceLinks(tokens                    )          {
  for (const _tag in tokens.links) return true;
  return false;
}

function settledBoundary(
  tail        ,
  tokens                                ,
)                                    {
  let total = 0;
  for (const token of tokens) total += token.raw.length;
  if (total !== tail.length) return { count: 0, length: 0 };
  const stateTagAt = tail.search(INLINE_STATE_TAG_RE);
  let offset = total;
  for (let j = tokens.length - 1; j >= 1; j--) {
    offset -= tokens[j].raw.length;
    if (stateTagAt >= 0 && stateTagAt < offset) continue;
    if (
      offset >= 2 &&
      tail.charCodeAt(offset - 1) === 10 &&
      tail.charCodeAt(offset - 2) === 10 &&
      STABLE_BLOCK_START_RE.test(tail.slice(offset, offset + 2))
    ) {
      return { count: j, length: offset };
    }
  }
  return { count: 0, length: 0 };
}

function streamingMarkdownToPlainText(source        , cache        , numberLinks         )         {
  const src = source.includes("\r") ? source.replace(STREAM_CARRIAGE_RETURN_RE, "\n") : source;
  const entry = pickStreamCacheEntry(cache, src, numberLinks);
  const tail = src.slice(entry.stableSrc.length);
  const tokens = marked.lexer(tail);
  if (hasReferenceLinks(tokens)) {
    const all = entry.stableSrc ? marked.lexer(src) : tokens;
    return cleanDisplayTextIncremental(renderBlockTokens(all, numberLinks ? [] : null).join("\n\n"), entry.wholeLines);
  }
  let tailTokens            = tokens;
  const boundary = settledBoundary(tail, tokens);
  if (boundary.count > 0) {
    const settledRefs = numberLinks ? [...entry.stableRefs] : null;
    const settled = renderBlockTokens(tokens.slice(0, boundary.count), settledRefs);
    if (settledRefs) entry.stableRefs = settledRefs;
    entry.stableOut = joinBlockText(
      entry.stableOut,
      entry.stableBlocks,
      cleanDisplayText(settled.join("\n\n")),
      settled.length,
    );
    entry.stableBlocks += settled.length;
    entry.stableSrc = src.slice(0, entry.stableSrc.length + boundary.length);
    tailTokens = tokens.slice(boundary.count);
  }
  const tailBlocks = renderBlockTokens(tailTokens, numberLinks ? [...entry.stableRefs] : null);
  const tailOut = cleanDisplayTextIncremental(tailBlocks.join("\n\n"), entry.tailLines);
  return joinBlockText(entry.stableOut, entry.stableBlocks, tailOut, tailBlocks.length);
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

const messageArrivalMs = new WeakMap();

function normalizeRetagMatchText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function stampArrival(msg     , atMs     ) {
  if (msg && typeof msg === "object" && Number.isFinite(atMs)) {
    messageArrivalMs.set(msg, atMs);
  }
}

function arrivalMsOf(msg     ) {
  if (!msg || typeof msg !== "object") return null;
  const value = messageArrivalMs.get(msg);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimmedId(value     ) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function arrivalCarryKeys(msg     ) {
  const keys = [];
  const sendId = trimmedId(msg.clientSendId ?? msg.sendId);
  if (sendId) keys.push(`send:${sendId}`);

  const idempotencyKey = trimmedId(msg.idempotencyKey);
  if (idempotencyKey) keys.push(`send:${idempotencyKey}`);
  const serverId = trimmedId(msg.id ?? msg.messageId ?? msg.__openclaw?.id);
  if (serverId) keys.push(`id:${msg.role}:${serverId}`);
  const upstream = upstreamMessageIdentity(msg);
  if (upstream) keys.push(`up:${upstream}`);
  return keys;
}

function carryArrivalStamps(previous     , next     ) {
  if (!Array.isArray(previous) || previous.length === 0) return;
  const byKey = new Map();
  const userByText = new Map();
  for (const msg of previous) {
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    const arrival = arrivalMsOf(msg);
    if (arrival === null) continue;
    for (const key of arrivalCarryKeys(msg)) {
      if (!byKey.has(key)) byKey.set(key, arrival);
    }
    if (msg.role === "user") {
      const text = normalizeRetagMatchText(extractText(msg.content));
      if (!text) continue;
      const queue = userByText.get(text) ?? [];
      queue.push(arrival);
      userByText.set(text, queue);
    }
  }
  if (byKey.size === 0 && userByText.size === 0) return;
  for (const msg of next) {
    if (!msg || typeof msg !== "object" || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (authoredMsOf(msg) !== null || arrivalMsOf(msg) !== null) continue;
    const keyed = arrivalCarryKeys(msg).map((key) => byKey.get(key)).find((value) => value !== undefined);
    if (keyed !== undefined) {
      stampArrival(msg, keyed);
      continue;
    }
    if (msg.role !== "user") continue;
    const queue = userByText.get(normalizeRetagMatchText(extractText(msg.content)));
    if (queue && queue.length > 0) stampArrival(msg, queue.shift());
  }
}

function carryCommitRunId(next     , runId     , text     ) {
  const normalizedRunId = typeof runId === "string" ? runId.trim() : "";
  const target = normalizeRetagMatchText(text);
  if (!normalizedRunId || !target || !Array.isArray(next)) return;
  let match = null;
  for (const msg of next) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") continue;
    if (normalizeRetagMatchText(extractText(msg.content)) !== target) continue;

    if (match) return;
    match = msg;
  }

  if (!match || (typeof match.runId === "string" && match.runId.trim())) return;
  match.runId = normalizedRunId;
}

function serverIdOf(msg     ) {
  return trimmedId(msg.id ?? msg.messageId ?? msg.__openclaw?.id);
}

function carryPendingUserSends(previous     , next     , commitRunId     ) {
  if (pendingUserSendIds.size === 0) return;
  const seenUserIds = new Set();
  for (const msg of previous) {
    if (msg && msg.role === "user" && serverIdOf(msg)) seenUserIds.add(serverIdOf(msg));
  }
  const echoedSendIds = new Set();
  const addedUserTexts = new Map();
  for (const msg of next) {
    if (!msg || typeof msg !== "object" || msg.role !== "user") continue;
    for (const key of [msg.clientSendId, msg.sendId, msg.idempotencyKey]) {
      if (trimmedId(key)) echoedSendIds.add(trimmedId(key));
    }

    if (seenUserIds.has(serverIdOf(msg))) continue;
    const text = normalizeRetagMatchText(extractText(msg.content));
    if (text) addedUserTexts.set(text, (addedUserTexts.get(text) ?? 0) + 1);
  }
  const committedRunId = trimmedId(commitRunId);
  const stillPending = new Set();
  for (const msg of previous) {
    if (!msg || msg.role !== "user" || serverIdOf(msg)) continue;
    const sendId = trimmedId(msg.clientSendId ?? msg.sendId);
    if (!sendId || !pendingUserSendIds.has(sendId)) continue;
    if (echoedSendIds.has(sendId)) continue;
    const text = normalizeRetagMatchText(extractText(msg.content));
    const added = addedUserTexts.get(text) ?? 0;
    if (text && added > 0) {
      addedUserTexts.set(text, added - 1);
      continue;
    }
    if (committedRunId && trimmedId(msg.runId) === committedRunId) continue;
    const arrival = arrivalMsOf(msg);
    if (arrival === null || Date.now() - arrival > PENDING_USER_SEND_MAX_AGE_MS) continue;
    next.push(msg);
    stillPending.add(sendId);
  }
  pendingUserSendIds.clear();
  for (const sendId of stillPending) pendingUserSendIds.add(sendId);
}

function findNarrationMessageIndex(target     , messageId      = null) {
  const wantedId = typeof messageId === "string" || typeof messageId === "number"
    ? String(messageId).trim()
    : "";
  let prefixIndex = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    const msg = messages[cursor];
    if (!msg) continue;
    if (msg.role === "user") break;
    if (msg.role !== "assistant") continue;
    const text = normalizeRetagMatchText(extractText(msg.content));
    if (wantedId) {
      const rawId = msg.id ?? msg.messageId;
      const msgId = typeof rawId === "string" || typeof rawId === "number"
        ? String(rawId).trim()
        : "";
      if (msgId && msgId === wantedId) {
        return { index: cursor, truncated: Boolean(text) && text !== target };
      }
    }
    if (!text) continue;
    if (text === target) return { index: cursor, truncated: false };
    if (prefixIndex < 0 && target.startsWith(text)) prefixIndex = cursor;
  }
  if (prefixIndex >= 0) return { index: prefixIndex, truncated: true };
  return null;
}

function originInsertIndex(originAtMs     ) {
  let index = messages.length;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    const msg = messages[cursor];
    if (!msg) continue;
    if (msg.role === "user") break;
    const arrival = arrivalMsOf(msg);
    if (arrival === null || arrival <= originAtMs) break;
    index = cursor;
  }
  return index;
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

  hydrate(msgs     , name     , sessionKeyOrOptions      = null, maybeOptions      = undefined) {
    const sessionKey = typeof sessionKeyOrOptions === "string" ? sessionKeyOrOptions : null;
    const previousSequenceState = activeSequenceState;
    if (sessionKey !== null && sessionKey !== undefined) {
      activateSequenceSession(sessionKey);
    }
    const previousMessages = conversationState.getRawMessages();
    const nextMessages      = Array.isArray(msgs) ? [...msgs] : [];
    const options = sessionKey === null ? sessionKeyOrOptions : maybeOptions;
    const opts = options && typeof options === "object" ? options : {};
    if (activeSequenceState === previousSequenceState) {
      carryArrivalStamps(previousMessages, nextMessages);
    }

    carryPendingUserSends(previousMessages, nextMessages, opts.commitRunId);
    messages = failedTurns.weave(nextMessages, rawTextOf);
    if (name) agentName = name;

    headNotice = opts.historyUnavailable === true
      ? HISTORY_UNAVAILABLE_MARKER
      : opts.truncatedHead === true
        ? HISTORY_TRUNCATED_MARKER
        : null;

    carryCommitRunId(messages, opts.commitRunId, opts.commitText);
    rebuildDisplayCache();
    entriesRevision += 1;

  },

  addMessage(role     , content     , name     , metadata      = {}) {
    const clientSendId = typeof (metadata.clientSendId ?? metadata.sendId) === "string"
      ? String(metadata.clientSendId ?? metadata.sendId).trim()
      : "";
    if (role === "user" && clientSendId) {
      const messageList =  (messages);
      const existingIndex = messageList.findIndex((message) =>
        message.role === "user" &&
        String(message.clientSendId ?? message.sendId ?? "").trim() === clientSendId
      );
      if (existingIndex >= 0) {
        const existing = messageList[existingIndex];
        const definedMetadata = Object.fromEntries(
          Object.entries(metadata).filter(([, value]) => value !== undefined),
        );
        const reconciled      = { ...existing, role, content, ...definedMetadata };
        if (name) reconciled.name = name;

        stampArrival(reconciled, arrivalMsOf(existing));
        messages[existingIndex] = reconciled;

        if (serverIdOf(reconciled)) pendingUserSendIds.delete(clientSendId);
        rebuildDisplayCache();
        entriesRevision += 1;
        return;
      }
    }
    const msg = { role, content, ...metadata };
    if (name) msg.name = name;
    stampArrival(msg, Date.now());
    messages.push(msg);

    const entry = buildDisplayEntry(msg, {
      isFirstVisibleEntry: displayEntries.every((item) => item.role === NOTICE_ROLE),
    });
    if (!entry) return;

    const sequencedEntry = entry.role === NOTICE_ROLE
      ? entry
      : assignSequence(activeSequenceState, entry);
    displayEntries.push(sequencedEntry);
    if (entry.role !== NOTICE_ROLE && entry.idSource === "derived") ledgerCapable = false;
    entriesRevision += 1;
    if (entry.role === "assistant") {
      assistantCommitGeneration += 1;
      assistantCommitPresent = true;
      assistantCommitText = entry.text;
    }
    const nextLine = formatEntry(entry);
    if (transcriptDirty) return;
    if (!cachedTranscript) {
      cachedTranscript = nextLine;
    } else {
      cachedTranscript += `\n\n${nextLine}`;
    }
  },

  addAssistantMessageAtOrigin(
    content     ,
    originAtMs     ,
    name     ,
    metadata      = {},
  ) {
    if (!Number.isFinite(originAtMs)) {
      conversationState.addMessage("assistant", content, name, metadata);
      return false;
    }
    const index = originInsertIndex(originAtMs);
    if (index >= messages.length) {
      conversationState.addMessage("assistant", content, name, metadata);
      stampArrival(messages[messages.length - 1], originAtMs);
      return false;
    }
    const msg      = { role: "assistant", content, ...metadata };
    if (name) msg.name = name;
    stampArrival(msg, originAtMs);
    messages.splice(index, 0, msg);
    rebuildDisplayCache();
    const entry = buildDisplayEntry(msg);
    if (entry && entry.role !== NOTICE_ROLE) {
      entriesRevision += 1;
      assistantCommitGeneration += 1;
      assistantCommitPresent = entry.role === "assistant";
      assistantCommitText = entry.role === "assistant" ? entry.text : assistantCommitText;
    }
    return true;
  },

  repositionAssistantMessageMatching(
    runId     ,
    text     ,
    originAtMs     ,
    messageId      = null,
  ) {
    const target = normalizeRetagMatchText(text);
    if (!target) return false;
    const match = findNarrationMessageIndex(target, messageId);
    if (!match) return false;
    const cursor = match.index;
    const msg = messages[cursor];
    let changed = false;
    if (match.truncated) {

      msg.content = typeof text === "string" && text.trim() ? text : target;
      changed = true;
    }
    if (Number.isFinite(originAtMs)) {
      messages.splice(cursor, 1);
      stampArrival(msg, originAtMs);
      const index = originInsertIndex(originAtMs);
      messages.splice(index, 0, msg);
      if (index !== cursor) changed = true;
    }
    if (!changed) return false;
    rebuildDisplayCache();
    entriesRevision += 1;
    return true;
  },

  removeLastAssistantMessageMatching(runId     , text     , messageId      = null) {
    const target = normalizeRetagMatchText(text);
    if (!target) return false;

    const match = findNarrationMessageIndex(target, messageId);
    if (!match) return false;
    messages.splice(match.index, 1);
    rebuildDisplayCache();
    entriesRevision += 1;
    return true;
  },

  replaceAssistantMessageContent(messageId     , content     ) {
    const id = trimmedId(messageId);
    if (!id) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const msg      = messages[index];
      if (!msg || msg.role !== "assistant" || serverIdOf(msg) !== id) continue;
      msg.content = content;
      msg.rev = Number.isFinite(Number(msg.rev)) ? Math.floor(Number(msg.rev)) + 1 : 1;
      rebuildDisplayCache();
      entriesRevision += 1;
      return true;
    }
    return false;
  },

  replaceLatestUserMessage(content, name) {
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== "user") {
      index -= 1;
    }

    const msg = { role: "user", content };
    if (name) msg.name = name;
    stampArrival(msg, Date.now());

    if (index >= 0) {
      messages = messages.slice(0, index);
    }
    messages.push(msg);
    rebuildDisplayCache();
    entriesRevision += 1;
  },

  markUserSendPending(clientSendId = "") {
    const sendId = trimmedId(clientSendId);
    if (!sendId) return false;
    const present = conversationState.getRawMessages().some((msg     ) =>
      msg && msg.role === "user" && !serverIdOf(msg) &&
      trimmedId(msg.clientSendId ?? msg.sendId) === sendId
    );
    if (present) pendingUserSendIds.add(sendId);
    return present;
  },

  settleUserSend(clientSendId = "") {
    return pendingUserSendIds.delete(trimmedId(clientSendId));
  },

  bindRunIdToClientSendId(clientSendId = "", runId = "") {
    if (typeof clientSendId !== "string" || !clientSendId.trim()) return false;
    if (typeof runId !== "string" || !runId.trim()) return false;
    const sendId = clientSendId.trim();
    const normalizedRunId = runId.trim();
    let messageChanged = false;
    for (const msg of  (messages)) {
      if ((msg.clientSendId ?? msg.sendId) !== sendId) continue;
      if (msg.runId !== normalizedRunId) {
        msg.runId = normalizedRunId;
        msg.rev = Number.isFinite(Number(msg.rev)) ? Math.floor(Number(msg.rev)) + 1 : 1;
        messageChanged = true;
      }
    }
    if (!messageChanged) return false;
    let entryChanged = false;
    for (const entry of  (displayEntries)) {
      if (entry.clientSendId !== sendId || entry.runId === normalizedRunId) continue;
      entry.runId = normalizedRunId;
      entry.rev = Number.isFinite(Number(entry.rev)) ? Math.floor(Number(entry.rev)) + 1 : 1;
      entryChanged = true;
    }
    if (!entryChanged) return false;
    entriesRevision += 1;
    return true;
  },

  setAgentName(name = "") {
    const next = name || DEFAULT_AGENT_NAME;
    if (agentName === next) return;
    agentName = next;
    transcriptDirty = true;
  },

  getPages() {
    return paginate();
  },

  getEntries() {
    const entries =  (displayEntries)
      .filter((entry) => entry.role !== NOTICE_ROLE)
      .map((entry) => ({ ...entry }));
    return {
      entriesRevision,
      baseSeq: entries.length > 0 ? entries[0].seq : 0,
      lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : -1,
      complete: true,
      ledgerV1: ledgerCapable,
      entries,
    };
  },

  isLedgerCapable() {
    return ledgerCapable;
  },

  getPageCount() {
    return displayEntries.length > 0 ? 1 : 0;
  },

  getRawMessages() {
    return messages.filter((msg) => !isFailedTurnMessage(msg));
  },

  getAssistantCommitSnapshot() {
    if (!assistantCommitPresent) return null;
    return {
      generation: assistantCommitGeneration,
      text: assistantCommitText,
    };
  },

  recordFailedTurn(input                                                               ) {
    if (!failedTurns.record(input, messages, rawTextOf)) return false;
    messages = failedTurns.weave(messages, rawTextOf);
    rebuildDisplayCache();
    entriesRevision += 1;
    return true;
  },

  clear(sessionKey      = null, resetSequence      = false) {
    if (sessionKey === null || sessionKey === undefined) {
      failedTurns.reset();
      resetAllSequenceSessions();
    } else {
      activateSequenceSession(sessionKey, resetSequence === true);
    }
    messages = [];
    agentName = DEFAULT_AGENT_NAME;
    displayEntries = [];
    cachedTranscript = "";
    transcriptDirty = false;
    ledgerCapable = true;
    entriesRevision += 1;
    assistantCommitPresent = false;
    assistantCommitText = "";
    headNotice = null;
    pendingUserSendIds.clear();
  },

  _markdownToPlainText: markdownToPlainText,
  _extractText: extractText,
  _isLikelySyntheticSessionStarterPrompt: isLikelySyntheticSessionStarterPrompt,
  _COMPACTION_SUMMARY_MARKER: COMPACTION_SUMMARY_MARKER,
  _HISTORY_TRUNCATED_MARKER: HISTORY_TRUNCATED_MARKER,
  _HISTORY_UNAVAILABLE_MARKER: HISTORY_UNAVAILABLE_MARKER,
  serverIdOf,
};

const {
  hydrate,
  addMessage,
  addAssistantMessageAtOrigin,
  repositionAssistantMessageMatching,
  removeLastAssistantMessageMatching,
  replaceAssistantMessageContent,
  replaceLatestUserMessage,
  markUserSendPending,
  settleUserSend,
  bindRunIdToClientSendId,
  setAgentName,
  getPages,
  getEntries,
  isLedgerCapable,
  getPageCount,
  getRawMessages,
  getAssistantCommitSnapshot,
  recordFailedTurn,
  clear,
  _markdownToPlainText,
  _extractText,
  _isLikelySyntheticSessionStarterPrompt,
  _COMPACTION_SUMMARY_MARKER,
  _HISTORY_TRUNCATED_MARKER,
  _HISTORY_UNAVAILABLE_MARKER,
} = conversationState;

module.exports = conversationState;
