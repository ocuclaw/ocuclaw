const LIVEUI_CONTEXT_FENCE_TAG = "ocuclaw_liveui_context_v1";

function buildLiveuiContextFence(fragments     , taskIndex      = "") {
  const usable = (Array.isArray(fragments) ? fragments : []).filter(
    (f) => f && typeof f.text === "string" && f.text.trim(),
  );
  const usableTaskIndex = typeof taskIndex === "string" ? taskIndex : "";
  if (usable.length === 0 && !usableTaskIndex) return null;
  return [
    `<${LIVEUI_CONTEXT_FENCE_TAG}>`,
    JSON.stringify({
      source: "ocuclaw-plugin",
      provenance: "plugin-generated",
      target: "user_message_ephemeral",
      fragments: usable.map((f) => ({ kind: f.kind, text: f.text })),
      ...(usableTaskIndex ? { task_index: usableTaskIndex } : {}),
    }),
    `</${LIVEUI_CONTEXT_FENCE_TAG}>`,
  ].join("\n");
}

function userMessageText(message     ) {
  if (!message || typeof message !== "object") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const block = content.find((b     ) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string");
  return block ? block.text : null;
}

function appendLiveuiContextFenceToUserMessage(message     , fence        , words           = []) {
  const text = userMessageText(message);
  if (typeof text !== "string" || !text.trim() || typeof fence !== "string" || !fence) return null;
  if (text.includes(`<${LIVEUI_CONTEXT_FENCE_TAG}>`)) return null;
  const candidates = (Array.isArray(words) ? words : []).filter((w) => typeof w === "string" && w.trim());
  if (candidates.length > 0 && !candidates.some((w) => text.includes(w.trim()))) return null;
  const fenced = `${text}\n\n${fence}`;
  if (typeof message.content === "string") return { ...message, content: fenced };
  let replaced = false;
  const content = message.content.map((block     ) => {
    if (replaced || !block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
      return block;
    }
    replaced = true;
    return { ...block, text: fenced };
  });
  return { ...message, content };
}

const FENCE_TAIL_RE = new RegExp(`(?:^|\\s+)<${LIVEUI_CONTEXT_FENCE_TAG}>[\\s\\S]*$`);

function stripLiveuiContextFence(text     ) {
  if (typeof text !== "string" || !text.includes(`<${LIVEUI_CONTEXT_FENCE_TAG}>`)) return text;
  return text.replace(FENCE_TAIL_RE, "");
}

function stripFenceFromMessage(message     ) {
  if (!message || typeof message !== "object" || message.role !== "user") return message;
  let next = message;
  if (typeof message.content === "string") {
    const content = stripLiveuiContextFence(message.content);
    if (content !== message.content) next = { ...next, content };
  } else if (Array.isArray(message.content)) {
    let changed = false;
    const content = message.content.map((block     ) => {
      if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return block;
      const text = stripLiveuiContextFence(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });
    if (changed) next = { ...next, content };
  }
  if (typeof message.text === "string") {
    const text = stripLiveuiContextFence(message.text);
    if (text !== message.text) next = { ...next, text };
  }
  return next;
}

function stripFenceFromMessages(messages     ) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((message     ) => {
    const stripped = stripFenceFromMessage(message);
    if (stripped !== message) changed = true;
    return stripped;
  });
  return changed ? next : messages;
}

const SESSION_ROW_EXCERPT_FIELDS = ["displayName", "derivedTitle", "lastMessagePreview"];

function stripLiveuiContextFenceFromHistoryResult(method     , result     ) {
  if (!result || typeof result !== "object") return result;
  if (method === "chat.history") {
    const messages = stripFenceFromMessages(result.messages);
    return messages === result.messages ? result : { ...result, messages };
  }
  if (method === "sessions.list" && Array.isArray(result.sessions)) {
    let changed = false;
    const sessions = result.sessions.map((row     ) => {
      if (!row || typeof row !== "object") return row;
      let next = row;
      const messages = stripFenceFromMessages(row.messages);
      if (messages !== row.messages) next = { ...next, messages };
      for (const field of SESSION_ROW_EXCERPT_FIELDS) {
        const value = stripLiveuiContextFence(row[field]);
        if (value !== row[field]) next = { ...next, [field]: value };
      }
      if (next !== row) changed = true;
      return next;
    });
    return changed ? { ...result, sessions } : result;
  }
  return result;
}

function openClawStoresFenceFromWriteHook(hostVersion     ) {
  if (typeof hostVersion !== "string") return false;
  const match = hostVersion.trim().match(/^(\d{4})\.(\d+)\.(\d+)/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year === 2026 && month === 7;
}

module.exports = { LIVEUI_CONTEXT_FENCE_TAG, buildLiveuiContextFence, appendLiveuiContextFenceToUserMessage, stripLiveuiContextFence, stripLiveuiContextFenceFromHistoryResult, openClawStoresFenceFromWriteHook };
