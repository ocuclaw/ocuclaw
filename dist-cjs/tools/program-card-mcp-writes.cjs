const REQUEST_CARD_MCP_WRITE_TOOL_NAME = "request_card_mcp_write";

const REQUEST_CARD_MCP_WRITE_TOOL_DESCRIPTION =
  "Ask the wearer to let a glasses card send to one of the owner's MCP tools (log a habit, mark a task done, toggle a light). " +
  "Call it BEFORE writing or editing card code that declares a kind: \"write\" use: write_glasses_card and edit_glasses_card refuse a write use without the wearer's grant (mcp_write_not_granted). " +
  "card is \"new\" for the next card you write in this chat (the grant waits 10 minutes), or a saved card's app id. " +
  "uses lists 1 to 4 write uses in the card's own use shape: { name, server, tool, kind: \"write\", title, description, sends, gets, args, vary, pick } (no every; a write is never repeated). " +
  "The wearer sees only what the uses say, so title, description and sends must say plainly what the card sends. " +
  "Returns answer: allowed (with uses, the exact mcp block to paste), declined, no_answer, off, or invalid with error (reason host_blocked comes with fix, a command for the owner). " +
  "Even after allowed, each send asks the wearer on the glasses, and a write call counts only from a wearer input step (a tap, a command, a menu pick), never from ticks, data or results.";

const USE_PROPERTIES = {
  name: { type: "string", description: "The use's name in the card's mcp block." },
  server: { type: "string" },
  tool: { type: "string" },
  kind: { type: "string", enum: ["write"] },
  title: { type: "string", description: "At most 40 characters, for the wearer." },
  description: { type: "string", description: "At most 160 characters, for the wearer." },
  sends: { type: "string", description: "What the card sends to the tool, at most 120 characters." },
  gets: { type: "string", description: "What comes back, at most 120 characters." },

  args: { type: "object", properties: {}, additionalProperties: true, description: "The tool's fixed arguments." },
  vary: { type: "object", properties: {}, additionalProperties: true, description: "{ argName: { min, max } | { oneOf: [...] } | { text: N } }: what a call may set." },
  pick: { type: "string", description: "Part of the result to keep, like $.result." },
};

const requestCardMcpWriteParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["card", "why", "uses"],
  properties: {
    card: { type: "string", description: "\"new\", or the saved card's app id." },
    why: { type: "string", maxLength: 140, description: "One line: why the card needs to send. Not shown to the wearer." },
    uses: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "object", additionalProperties: false, required: ["name", "server", "tool", "kind", "title", "description", "sends", "gets"], properties: USE_PROPERTIES },
    },
  },
};

const NEXT                         = {
  allowed: "The wearer allowed these writes for this card. Paste uses into the card's mcp block exactly as returned (any change needs a new request). Return a write call only from the step of the wearer's input, under a new id, like calls: s => s.n ? [{ id: \"log\" + s.n, mcp: \"log\", args: {}, label: \"Water +1\" }] : [] with each tap adding 1 to s.n. Each send still asks the wearer.",
  declined: "The wearer said not now. Do not write the card with these writes; offer a version without them.",
  no_answer: "The wearer did not answer. Do not write the card with these writes; you may ask again later.",
  off: "Card writes are off here: MCP in cards is off, the phone cannot show the send prompt yet, or this host cannot send. Write the card without writes.",
  invalid: "The host refused these uses; fix what error says and ask again.",
};

const PROGRAM_CARD_MCP_WRITE_NOT_GRANTED_NEXT =
  "Nothing was written. Call request_card_mcp_write with exactly each refused use (card \"new\" for a new card, or the saved card's app id), then write the card again with the uses it returns.";
const PROGRAM_CARD_MCP_WRITE_NOT_LITERAL_NEXT =
  "Nothing was written. The host must read the card's mcp block to check its writes: write the mcp block as a plain object literal (no variables, spreads or computed values), then write again.";

const WRITE_MARK = /["'`]?kind["'`]?\s*:\s*(["'`])write\1/;
const MCP_KEY = /(^|[^\w$.])(["']?)mcp\2\s*:\s*\{/g;
const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class NotLiteral extends Error {}

function readLiteral(text        , start        ) {
  let i = start;
  const space = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text.startsWith("//", i)) {
        const end = text.indexOf("\n", i);
        i = end < 0 ? text.length : end + 1;
      } else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) throw new NotLiteral();
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const quote = text[i];
    let out = "";
    i += 1;
    while (i < text.length && text[i] !== quote) {
      if (quote === "`" && text.startsWith("${", i)) throw new NotLiteral();
      if (text[i] === "\\") {
        const next = text[i + 1];
        const map      = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
        if (next === "u") {
          const hex = /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)) ? text.slice(i + 2, i + 6) : null;
          if (!hex) throw new NotLiteral();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += next in map ? map[next] : next;
        i += 2;
        continue;
      }
      out += text[i];
      i += 1;
    }
    if (i >= text.length) throw new NotLiteral();
    i += 1;
    return out;
  };
  const value = ()      => {
    space();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === "\"" || c === "'" || c === "`") return string();
    NUMBER.lastIndex = i;
    const n = NUMBER.exec(text);
    if (n) {
      i += n[0].length;
      return Number(n[0]);
    }
    IDENT.lastIndex = i;
    const word = IDENT.exec(text);
    if (word && (word[0] === "true" || word[0] === "false" || word[0] === "null")) {
      i += word[0].length;
      return word[0] === "true" ? true : word[0] === "false" ? false : null;
    }
    throw new NotLiteral();
  };
  const object = () => {
    const out      = {};
    i += 1;
    for (;;) {
      space();
      if (text[i] === "}") {
        i += 1;
        return out;
      }
      let key        ;
      if (text[i] === "\"" || text[i] === "'") key = string();
      else {
        IDENT.lastIndex = i;
        const word = IDENT.exec(text);
        if (!word) throw new NotLiteral();
        key = word[0];
        i += key.length;
      }
      space();
      if (text[i] !== ":") throw new NotLiteral();
      i += 1;
      if (key === "__proto__") throw new NotLiteral();
      out[key] = value();
      space();
      if (text[i] === ",") i += 1;
      else if (text[i] !== "}") throw new NotLiteral();
    }
  };
  const array = () => {
    const out        = [];
    i += 1;
    for (;;) {
      space();
      if (text[i] === "]") {
        i += 1;
        return out;
      }
      out.push(value());
      space();
      if (text[i] === ",") i += 1;
      else if (text[i] !== "]") throw new NotLiteral();
    }
  };
  return object();
}

function programCardMcpWritesOf(source        )                                                           {
  const text = typeof source === "string" ? source : "";
  if (!WRITE_MARK.test(text)) return { ok: true, uses: [] };
  const uses        = [];
  let unreadable = false;
  MCP_KEY.lastIndex = 0;
  for (let match = MCP_KEY.exec(text); match; match = MCP_KEY.exec(text)) {
    const at = match.index + match[0].length - 1;
    let block     ;
    try {
      block = readLiteral(text, at);
    } catch (_) {
      unreadable = true;
      continue;
    }
    for (const name of Object.keys(block)) {
      const spec = block[name];
      if (spec && typeof spec === "object" && !Array.isArray(spec) && spec.kind === "write") uses.push({ ...spec, name });
    }
  }

  if (unreadable || !uses.length) return { ok: false, error: "not_literal" };
  return { ok: true, uses };
}

function programCardSourceAfterEdits(source                           , edits     ) {
  if (typeof source !== "string" || !Array.isArray(edits)) return null;
  let out = source;
  for (const edit of edits) {
    if (!edit || typeof edit.find !== "string" || !edit.find || typeof edit.replace !== "string") return null;
    const at = out.indexOf(edit.find);
    if (at < 0 || out.indexOf(edit.find, at + 1) >= 0) return null;
    out = out.slice(0, at) + edit.replace + out.slice(at + edit.find.length);
  }
  return out;
}

function programCardMcpWriteGate(check     , sessionKey        , source               , keys     )      {
  if (typeof source !== "string") return null;
  const found = programCardMcpWritesOf(source);
  if (!found.ok) return { ok: false, error: "mcp_write_not_granted", reason: "mcp_not_literal", next: PROGRAM_CARD_MCP_WRITE_NOT_LITERAL_NEXT };
  if (!found.uses.length) return null;
  return askWriteGrants(check, sessionKey, keys, found.uses);
}

async function askWriteGrants(check     , sessionKey        , keys     , writeUses       ) {
  const found = { uses: writeUses };
  let verdict      = null;
  try {
    verdict = typeof check === "function" ? await check({ sessionKey, keys, uses: found.uses }) : null;
  } catch (_) {
    verdict = null;
  }
  if (verdict && verdict.ok === true) return null;
  const uses = verdict && Array.isArray(verdict.uses) ? verdict.uses : found.uses.map((use     ) => ({ name: String(use.name).slice(0, 24), why: "missing" }));
  return { ok: false, error: "mcp_write_not_granted", writeUses: uses, next: PROGRAM_CARD_MCP_WRITE_NOT_GRANTED_NEXT };
}

function createRequestCardMcpWriteHandler(deps     ) {
  return async function requestWrite(sessionKey        , params     ) {
    const card = params && typeof params.card === "string" ? params.card.trim() : "";
    const why = params && typeof params.why === "string" ? params.why.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    if (!card || !why) return { answer: "invalid", error: "card and why are required", next: NEXT.invalid };
    let verdict      = null;
    try {
      verdict = typeof deps.considerWrite === "function"
        ? await deps.considerWrite({ sessionKey, card, why, uses: params.uses })
        : { answer: "off" };
    } catch (_) {
      verdict = null;
    }
    const answer = verdict && typeof verdict.answer === "string" && NEXT[verdict.answer] ? verdict.answer : "no_answer";
    const out      = { answer };
    if (answer === "allowed" && verdict.uses) out.uses = verdict.uses;
    if (answer === "invalid") {
      out.error = String(verdict.error || "invalid").slice(0, 300);
      if (verdict.reason) out.reason = verdict.reason;
      if (verdict.fix) out.fix = String(verdict.fix).slice(0, 200);
    }
    out.next = answer === "invalid" && verdict.reason === "host_blocked"
      ? `This host blocks that tool until the owner trusts the server. Tell the owner: ${out.fix}. Then ask again.`
      : NEXT[answer];
    return out;
  };
}

module.exports = { REQUEST_CARD_MCP_WRITE_TOOL_NAME, REQUEST_CARD_MCP_WRITE_TOOL_DESCRIPTION, requestCardMcpWriteParametersSchema, PROGRAM_CARD_MCP_WRITE_NOT_GRANTED_NEXT, PROGRAM_CARD_MCP_WRITE_NOT_LITERAL_NEXT, programCardMcpWritesOf, programCardSourceAfterEdits, programCardMcpWriteGate, createRequestCardMcpWriteHandler };
