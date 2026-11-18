function isObject(value     ) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function messagePhase(message     ) {
  return typeof message.phase === "string" ? message.phase.trim().toLowerCase() : null;
}

function projectOpenClawConversationHistory(messages       ) {
  return messages.flatMap((message) => {
    if (!isObject(message) || message.role !== "assistant") return [message];
    const fallback = message.openclawStreamFallback;

    if (messagePhase(message) === "commentary" ||
        (isObject(fallback) && fallback.source === "segment" &&
         typeof fallback.itemId === "string" && fallback.itemId.trim())) return [];
    if (!Array.isArray(message.content)) return [message];
    const content = message.content.filter((block     ) => {
      if (!isObject(block) || block.type !== "text" || typeof block.textSignature !== "string") return true;
      try {
        const signature = JSON.parse(block.textSignature);
        return !isObject(signature) || signature.v !== 1 || messagePhase(signature) !== "commentary";
      } catch {
        return true;
      }
    });
    return content.length === message.content.length ? [message] : [{ ...message, content }];
  });
}

module.exports = { projectOpenClawConversationHistory };
