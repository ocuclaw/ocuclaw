const fs = require("node:fs");
const path = require("node:path");
const { homedir } = require("node:os");
const WebSocket = require("ws");

const CODEX_TURNS_PAGE_SIZE = 10;
const CODEX_MAX_PAGES = 50;
const CODEX_RPC_TIMEOUT_MS = 12_000;
const CODEX_CONNECT_TIMEOUT_MS = 5_000;

function normalizeText(value) {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function extractTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function claudeEntryToRow(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "user") {
    const text = extractTextContent(entry.message && entry.message.content);
    return text ? { role: "user", content: text } : null;
  }
  if (entry.type === "assistant") {
    const text = extractTextContent(entry.message && entry.message.content);
    return text ? { role: "assistant", content: text } : null;
  }
  return null;
}

function findClaudeSessionFile(sessionId) {
  const normalizedSessionId = normalizeClaudeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  const root = path.join(homedir(), ".claude", "projects");
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.resolve(root, dir.name);
    const candidate = path.resolve(projectDir, `${normalizedSessionId}.jsonl`);
    if (!candidate.startsWith(`${projectDir}${path.sep}`)) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {

    }
  }
  return null;
}

function normalizeClaudeSessionId(sessionId) {
  if (typeof sessionId !== "string") return "";
  const trimmed = sessionId.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) return "";
  return trimmed;
}

function readClaudeJsonlHistory(sessionId) {
  const filePath = findClaudeSessionFile(sessionId);
  if (!filePath) return [];
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const row = claudeEntryToRow(parsed);
    if (row) rows.push(row);
  }
  return rows;
}

async function readClaudeSdkHistory(sessionId) {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    if (!sdk || typeof sdk.getSessionMessages !== "function") return null;
    const messages = await sdk.getSessionMessages(sessionId);
    if (!Array.isArray(messages)) return [];
    return messages
      .map(claudeEntryToRow)
      .filter(Boolean);
  } catch {
    return null;
  }
}

function extractCodexUserMessageText(item) {
  const content = Array.isArray(item && item.content) ? item.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractCodexAgentMessageText(item) {
  return normalizeText(item && item.text);
}

function codexItemsToRows(items) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "userMessage") {
      const text = extractCodexUserMessageText(item);
      if (text) rows.push({ role: "user", content: text });
      continue;
    }
    if (item.type === "agentMessage") {
      const text = extractCodexAgentMessageText(item);
      if (text) rows.push({ role: "assistant", content: text });
    }
  }
  return rows;
}

class PassiveCodexClient {
  constructor(port, opts = {}) {
    this.port = port;
    this.ws = null;
    this.initialized = false;
    this.nextId = 1;
    this.pending = new Map();
    this.timeoutMs = Number.isFinite(opts.timeoutMs)
      ? Math.max(1000, Math.floor(opts.timeoutMs))
      : CODEX_RPC_TIMEOUT_MS;
    this.connectTimeoutMs = Number.isFinite(opts.connectTimeoutMs)
      ? Math.max(1000, Math.floor(opts.connectTimeoutMs))
      : CODEX_CONNECT_TIMEOUT_MS;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized) return;
    await this.openSocket();
    await this.callRaw("initialize", {
      clientInfo: { name: "ocuclaw", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.initialized = true;
    this.send({ jsonrpc: "2.0", method: "initialized" });
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {  }
        reject(new Error(`Codex app-server connect timeout on ${this.port}`));
      }, this.connectTimeoutMs);
      ws.on("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString();
        for (const line of text.split("\n")) {
          if (line.trim()) this.handleLine(line);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        this.rejectAll(err);
        reject(err);
      });
      ws.on("close", () => {
        this.initialized = false;
        this.ws = null;
        this.rejectAll(new Error("Codex app-server socket closed"));
      });
    });
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, "id")) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || "Codex app-server RPC error"));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  rejectAll(err) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  callRaw(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server socket is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server RPC timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async call(method, params) {
    await this.connect();
    return this.callRaw(method, params);
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {  }
    }
    this.ws = null;
    this.initialized = false;
    this.rejectAll(new Error("Codex app-server socket closed"));
  }
}

async function readCodexHistory(sessionId, target, opts = {}) {
  const port = Number(target && target.codexAppServerPort);
  if (!Number.isFinite(port) || port <= 0) return { rows: [], truncated: false };
  const client = new PassiveCodexClient(port, opts);
  const rowsNewestFirst = [];
  const maxPages = Number.isFinite(opts.codexMaxPages)
    ? Math.max(1, Math.floor(opts.codexMaxPages))
    : CODEX_MAX_PAGES;
  let cursor = undefined;
  let truncated = false;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const result = await client.call("thread/turns/list", {
        threadId: sessionId,
        limit: CODEX_TURNS_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      });
      const turns = Array.isArray(result && result.data) ? result.data : [];
      for (const turn of turns) {
        const items = Array.isArray(turn && turn.items) ? turn.items : [];
        rowsNewestFirst.push(...codexItemsToRows(items).reverse());
      }
      if (!result || !result.nextCursor || turns.length === 0) break;
      if (page === maxPages - 1) {
        truncated = true;
        break;
      }
      cursor = result.nextCursor;
    }
  } finally {
    client.close();
  }
  return { rows: rowsNewestFirst.reverse(), truncated };
}

function createEvenTerminalDisplayHistoryReader(opts = {}) {
  const readClaude =
    typeof opts.readClaude === "function"
      ? opts.readClaude
      : async ({ sessionId }) => {
          const sdkRows = await readClaudeSdkHistory(sessionId);
          return Array.isArray(sdkRows) ? sdkRows : readClaudeJsonlHistory(sessionId);
        };
  const readCodex =
    typeof opts.readCodex === "function"
      ? opts.readCodex
      : ({ sessionId, target }) => readCodexHistory(sessionId, target, opts);

  return async function readEvenTerminalDisplayHistory(request) {
    const provider = request && request.provider;
    if (provider === "claude") {
      return readClaude(request);
    }
    if (provider === "codex") {
      return readCodex(request);
    }
    return [];
  };
}

module.exports = { createEvenTerminalDisplayHistoryReader };
