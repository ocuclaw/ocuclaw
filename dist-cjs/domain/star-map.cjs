const STAR_MAP_GRAPH_METHOD = "starmap.graph";

const STAR_MAP_FORGET_METHOD = "starmap.forget";

const STAR_MAP_LIMITS = Object.freeze({
  maxNodes: 400,
  maxLinks: 800,
  idChars: 160,
  groupChars: 40,
  nameChars: 80,
  textChars: 280,
  descriptionChars: 200,
  sourceChars: 80,
  sourcePathChars: 240,
  detailsChars: 1200,
  importanceMax: 10,
});

const STAR_MAP_UNSUPPORTED_CODE = "starmap_unsupported";

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const NODE_KINDS = new Set(["skill", "memory"]);
const NODE_BY = new Set(["agent", "learn", "user", "installed", "dreaming", ""]);
const SNAPSHOT_STATUSES = new Set(["ok", "unsupported", "error"]);
const ERROR_SLUG_RE = /^[a-z][a-z0-9_.-]{0,47}$/;

function starMapStableHash(text        )         {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function clipStarMapText(value         , max        )         {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function wholeNumber(value         , min        , max        )         {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeStarMapNode(raw     )                     {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind;
  if (typeof kind !== "string" || !NODE_KINDS.has(kind)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || Array.from(id).length > STAR_MAP_LIMITS.idChars) return null;
  const isSkill = kind === "skill";
  const text = isSkill ? "" : clipStarMapText(raw.text, STAR_MAP_LIMITS.textChars);
  const name =
    clipStarMapText(raw.name, STAR_MAP_LIMITS.nameChars) ||
    (isSkill ? "" : clipStarMapText(text, STAR_MAP_LIMITS.nameChars));
  if (!name) return null;
  const createdAtMs =
    typeof raw.createdAtMs === "number" && Number.isFinite(raw.createdAtMs) && raw.createdAtMs > 0
      ? Math.floor(raw.createdAtMs)
      : null;
  return {
    id,
    kind: isSkill ? "skill" : "memory",
    group:
      clipStarMapText(raw.group, STAR_MAP_LIMITS.groupChars) || (isSkill ? "Skills" : "Memory"),
    name,
    text,
    description: isSkill ? clipStarMapText(raw.description, STAR_MAP_LIMITS.descriptionChars) : "",
    createdAtMs,
    uses: wholeNumber(raw.uses, 0, Number.MAX_SAFE_INTEGER),
    by: typeof raw.by === "string" && NODE_BY.has(raw.by) ? raw.by : "",
    stale: raw.stale === true,
    pinned: raw.pinned === true,
    importance: wholeNumber(raw.importance, 0, STAR_MAP_LIMITS.importanceMax),
    source: clipStarMapText(raw.source, STAR_MAP_LIMITS.sourceChars),
    ...(raw.origin === "wiki" || raw.origin === "profile" ? {
      origin: raw.origin,
      sourcePath: clipStarMapText(raw.sourcePath, STAR_MAP_LIMITS.sourcePathChars),
      details: clipStarMapText(raw.details, STAR_MAP_LIMITS.detailsChars),
      canForget: raw.origin !== "wiki" && raw.canForget !== false,
    } : {}),
  };
}

function keepRank(a             , b             )         {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.uses !== b.uses) return b.uses - a.uses;
  if (a.importance !== b.importance) return b.importance - a.importance;
  const aAt = a.createdAtMs === null ? -1 : a.createdAtMs;
  const bAt = b.createdAtMs === null ? -1 : b.createdAtMs;
  return bAt - aAt;
}

function normalizeStarMapGraph(raw     )               {
  const rawNodes            = raw && Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawLinks            = raw && Array.isArray(raw.links) ? raw.links : [];
  const seen = new Set        ();
  let nodes                = [];
  for (const entry of rawNodes) {
    const node = normalizeStarMapNode(entry);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  if (nodes.length > STAR_MAP_LIMITS.maxNodes) {
    const order = new Map                     (
      nodes.map((node, index)                        => [node, index]),
    );
    const kept = new Set(
      nodes
        .slice()
        .sort((a, b) => keepRank(a, b) || (order.get(a) ?? 0) - (order.get(b) ?? 0))
        .slice(0, STAR_MAP_LIMITS.maxNodes),
    );
    nodes = nodes.filter((node) => kept.has(node));
  }
  const ids = new Set(nodes.map((node) => node.id));
  const pairs = new Set        ();
  const links                = [];
  for (const entry of rawLinks) {
    if (links.length >= STAR_MAP_LIMITS.maxLinks) break;
    const link      = entry;
    if (!link || typeof link !== "object") continue;
    const a = typeof link.a === "string" ? link.a.trim() : "";
    const b = typeof link.b === "string" ? link.b.trim() : "";
    if (!a || !b || a === b || !ids.has(a) || !ids.has(b)) continue;
    const pair = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    links.push({ a, b });
  }
  return { nodes, links };
}

function createStarMapUnsupportedError(detail         )        {
  const err      = new Error(detail ? `star map unsupported: ${detail}` : "star map unsupported");
  err.code = STAR_MAP_UNSUPPORTED_CODE;
  return err;
}

function isStarMapMethodNotFound(err     )          {
  if (!err || typeof err !== "object") return false;
  const code = err.code ?? (err.error && err.error.code);
  if (code === JSON_RPC_METHOD_NOT_FOUND) return true;
  const text = typeof err.message === "string" ? err.message.toLowerCase() : "";
  return (
    text.includes("method not found") ||
    text.includes("unknown method") ||
    text.includes("no such method")
  );
}

function starMapFailure(err     )                                                         {
  const code = err && typeof err === "object" ? err.code : undefined;
  if (code === STAR_MAP_UNSUPPORTED_CODE) return { status: "unsupported", errorCode: "unsupported" };
  if (isStarMapMethodNotFound(err)) return { status: "unsupported", errorCode: "method_not_found" };
  if (typeof code === "string") {
    const slug = code.trim().toLowerCase();
    if (ERROR_SLUG_RE.test(slug)) return { status: "error", errorCode: slug };
  }
  return { status: "error", errorCode: "starmap_failed" };
}

function buildStarMapSnapshotBody(payload     ) {
  const p = payload && typeof payload === "object" ? payload : {};
  const status = typeof p.status === "string" && SNAPSHOT_STATUSES.has(p.status) ? p.status : "error";
  const backend = p.backend === "hermes" ? "hermes" : "openclaw";
  const fetchedAtMs =
    typeof p.fetchedAtMs === "number" && Number.isFinite(p.fetchedAtMs)
      ? Math.floor(p.fetchedAtMs)
      : Date.now();
  if (status !== "ok") {
    const slug = typeof p.errorCode === "string" ? p.errorCode.trim().toLowerCase() : "";
    return {
      status,
      backend,
      fetchedAtMs,
      errorCode: ERROR_SLUG_RE.test(slug)
        ? slug
        : status === "unsupported"
          ? "unsupported"
          : "starmap_failed",
      nodes: [],
      links: [],
    };
  }
  const graph = normalizeStarMapGraph(p);
  return { status, backend, fetchedAtMs, nodes: graph.nodes, links: graph.links };
}

async function readStarMapSnapshot(input

 ) {
  const now = typeof input.now === "function" ? input.now : Date.now;
  const backend = input.backend === "hermes" ? "hermes" : "openclaw";
  try {
    const graph      = await input.request(STAR_MAP_GRAPH_METHOD, {
      agentId: typeof input.agentId === "string" ? input.agentId : "",
    });
    return buildStarMapSnapshotBody({
      status: "ok",
      backend,
      fetchedAtMs: now(),
      nodes: graph && graph.nodes,
      links: graph && graph.links,
    });
  } catch (err) {
    return buildStarMapSnapshotBody({ ...starMapFailure(err), backend, fetchedAtMs: now() });
  }
}

const STAR_MAP_FORGET_LIMITS = Object.freeze({
  requestIdChars: 64,
  textChars: 2000,
  messageChars: 200,
});

const STAR_MAP_FORGET_REFUSAL_CODES                      = new Set([
  "stale",
  "not_found",
  "ambiguous",
  "pinned",
  "protected",
  "busy",
  "bad_request",
]);

const FORGET_ACTIONS = new Set(["removed", "archived", "turned_off"]);
const FORGET_STATUSES = new Set(["ok", "refused", "unsupported", "error"]);

function createStarMapForgetError(code        , userMessage         )        {
  const err      = new Error(userMessage ? `star map forget ${code}: ${userMessage}` : `star map forget ${code}`);
  err.code = code;
  if (typeof userMessage === "string" && userMessage.trim()) err.userMessage = userMessage;
  return err;
}

function forgetRequestId(value         )         {
  return typeof value === "string" && Array.from(value).length <= STAR_MAP_FORGET_LIMITS.requestIdChars
    ? value
    : "";
}

function forgetEchoId(value         )         {
  if (typeof value !== "string") return "";
  return Array.from(value.trim()).slice(0, STAR_MAP_LIMITS.idChars).join("");
}

function parseStarMapForgetRequest(raw     )                              {
  if (!raw || typeof raw !== "object") return null;
  const requestId = raw.requestId;
  if (typeof requestId !== "string" || !requestId || requestId !== forgetRequestId(requestId)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || Array.from(id).length > STAR_MAP_LIMITS.idChars) return null;
  const kind = raw.kind;
  if (kind !== "skill" && kind !== "memory") return null;
  const text = raw.text;
  if (typeof text !== "string" || !text.trim()) return null;
  if (Array.from(text).length > STAR_MAP_FORGET_LIMITS.textChars) return null;
  return { requestId, id, kind, text };
}

function parseStarMapForgetParams(
  params     ,
)                                                                                 {
  const parsed = parseStarMapForgetRequest({ ...(params && typeof params === "object" ? params : {}), requestId: "x" });
  if (!parsed) return null;
  const agentId = params && typeof params.agentId === "string" ? params.agentId.trim() : "";
  return { agentId, id: parsed.id, kind: parsed.kind, text: parsed.text };
}

function buildStarMapForgottenBody(payload     ) {
  const p = payload && typeof payload === "object" ? payload : {};
  let status = typeof p.status === "string" && FORGET_STATUSES.has(p.status) ? p.status : "error";
  const requestId = forgetRequestId(p.requestId);
  const id = forgetEchoId(p.id);
  const message = clipStarMapText(p.message, STAR_MAP_FORGET_LIMITS.messageChars);
  if (status === "ok") {
    if (typeof p.action === "string" && FORGET_ACTIONS.has(p.action)) {
      return { requestId, id, status, action: p.action                       , ...(message ? { message } : {}) };
    }
    status = "error";
  }
  const slug = typeof p.errorCode === "string" ? p.errorCode.trim().toLowerCase() : "";
  const errorCode = ERROR_SLUG_RE.test(slug)
    ? slug
    : status === "unsupported"
      ? "unsupported"
      : status === "refused"
        ? "bad_request"
        : "forget_failed";
  return { requestId, id, status, errorCode, ...(message ? { message } : {}) };
}

function starMapForgetFailure(err     )                                                          {
  const code = err && typeof err === "object" ? err.code : undefined;
  const userMessage = err && typeof err === "object" && typeof err.userMessage === "string" ? err.userMessage : "";
  const message = userMessage ? { message: userMessage } : {};
  if (code === STAR_MAP_UNSUPPORTED_CODE || isStarMapMethodNotFound(err)) {
    return { status: "unsupported", errorCode: "unsupported", ...message };
  }
  const slug = typeof code === "string" ? code.trim().toLowerCase() : "";
  if (STAR_MAP_FORGET_REFUSAL_CODES.has(slug)) return { status: "refused", errorCode: slug, ...message };
  if (slug === "unsupported") return { status: "unsupported", errorCode: "unsupported", ...message };
  if (ERROR_SLUG_RE.test(slug)) return { status: "error", errorCode: slug, ...message };
  return { status: "error", errorCode: "forget_failed", ...message };
}

async function forgetStarMapNode(input

 ) {
  const echo = { requestId: forgetRequestId(input.requestId), id: forgetEchoId(input.id) };
  const parsed = parseStarMapForgetRequest(input);
  if (!parsed) return buildStarMapForgottenBody({ ...echo, status: "refused", errorCode: "bad_request" });
  try {
    const result      = await input.request(STAR_MAP_FORGET_METHOD, {
      agentId: typeof input.agentId === "string" ? input.agentId : "",
      id: parsed.id,
      kind: parsed.kind,
      text: parsed.text,
    });
    const action = result && typeof result === "object" ? result.action : undefined;
    if (typeof action !== "string" || !FORGET_ACTIONS.has(action)) {
      return buildStarMapForgottenBody({ ...echo, status: "error", errorCode: "forget_failed" });
    }
    return buildStarMapForgottenBody({ ...echo, status: "ok", action });
  } catch (err) {
    return buildStarMapForgottenBody({ ...echo, ...starMapForgetFailure(err) });
  }
}

module.exports = { STAR_MAP_GRAPH_METHOD, STAR_MAP_FORGET_METHOD, STAR_MAP_LIMITS, starMapStableHash, clipStarMapText, normalizeStarMapGraph, createStarMapUnsupportedError, isStarMapMethodNotFound, buildStarMapSnapshotBody, readStarMapSnapshot, STAR_MAP_FORGET_LIMITS, STAR_MAP_FORGET_REFUSAL_CODES, createStarMapForgetError, parseStarMapForgetRequest, parseStarMapForgetParams, buildStarMapForgottenBody, forgetStarMapNode };
