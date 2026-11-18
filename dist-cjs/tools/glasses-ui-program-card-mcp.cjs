const { createHash } = require("node:crypto");

const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, canonicalSerialize, programCardCurrentRevision, resolveLiveuiLibraryRoot, resolveLiveuiLibraryTypeDir } = require("./glasses-ui-library.cjs");
const { carryUnknownFields, hasUnknownFields } = require("./saved-format.cjs");

const HOST_COMMANDS_SERVER = "host";

const PROGRAM_CARD_MCP_CAPABILITY = "programCardsMcpV1";

const PROGRAM_CARD_MCP_SENDS_LINE = "Tools a card may send to, after request_card_mcp_write (server · tool):";

const PROGRAM_CARD_MCP_WRITES_CAPABILITY = "programCardsMcpWritesV1";
const PROGRAM_CARD_MCP_FILENAME = "program-card-mcp-v1.json";
const PROGRAM_CARD_MCP_WRITES_FILENAME = "program-card-mcp-writes-v1.json";
const PROGRAM_CARD_MCP_DATA_FRAME = "program_card_mcp_data";
const PROGRAM_CARD_MCP_STATE_FRAME = "program_card_mcp_state";

const PROGRAM_CARD_MCP_CODES = Object.freeze([
  "off", "not_allowed", "limit", "busy", "timeout", "failed", "too_big", "changed", "paused", "declined", "no_gesture",
]);

const PROGRAM_CARD_MCP_WHYS = Object.freeze([
  "not_allowed", "kept_off", "setup_blocked", "unfit", "unavailable", "timed_out", "other",
]);

const PROGRAM_CARD_MCP_HEALTH_REASONS = Object.freeze([
  "switch_off", "host_unsupported", "tools_unlisted", "invalid", "removed", "server_off_for_cards", "server_missing",
  "host_not_granted", "host_blocked", "server_not_connected", "tool_missing", "kept_off", "tool_changed", "waiting",
  "unfit", "paused_slow", "call_limit", "call_busy", "call_timeout", "call_failed", "call_too_big",
]);

const PROGRAM_CARD_MCP_SEND_HEALTH_REASONS = Object.freeze([
  "no_prompt", "host_cannot_send", "not_granted", "waiting", "kept_off", "tool_changed", "send_limit",
]);

const HEALTH_CALL_CODES = new Set(["limit", "busy", "timeout", "failed", "too_big"]);

const PROGRAM_CARD_MCP_TEMPORARY_WHYS = Object.freeze(["unavailable", "timed_out", "other"]);

const PROGRAM_CARD_MCP_GESTURES = Object.freeze(["input", "command", "text", "menu", "remote"]);

const PROGRAM_CARD_MCP_WRITE_NOT_GRANTED = "mcp_write_not_granted";

const PROGRAM_CARD_MCP_LIMITS = Object.freeze({
  maxUses: 4,
  blockBytesMax: 8192,
  titleMax: 40,
  descriptionMax: 160,
  sendsMax: 120,
  getsMax: 120,
  argsBytesMax: 2048,
  varyMax: 8,
  oneOfMax: 16,
  oneOfTextMax: 120,
  textMax: 120,
  everyMinSec: 60,
  everyMaxSec: 3600,
  callIdMax: 40,
  maxCallsPerFrame: 4,
  callArgsBytesMax: 1024,

  callTimeoutMs: 10_000,
  callGraceMs: 1000,

  timeoutRestMs: 10_000,
  perCardPerMinute: 10,
  perCardWindowMs: 60_000,
  perHostPerDay: 500,
  rawBytesMax: 256 * 1024,
  valueBytesMax: 16 * 1024,

  slowMs: 2000,
  slowStrikes: 2,
  maxQueued: 16,
  maxHeldPerSub: 4,
  requestWaitMs: 60_000,
  requestGraceMs: 2000,
  requestQuestionMax: 400,
  cardNameMax: 60,
  maxRecords: 64,

  readsKept: 16,

  maxKept: 256,

  healthKept: 256,
  maxSubscriptions: 4,
  leaseMs: 150_000,

  listTtlMs: 60_000,
  listTimeoutMs: 10_000,
  toolDescriptionMax: 300,
  schemaBytesMax: 16 * 1024,
  maxServers: 32,
  maxToolsPerServer: 200,

  stateEveryMs: 30_000,
  guideToolsMax: 40,
  guideBytesMax: 3072,

  writesPerCardPerMinute: 4,
  writesPerCardPerHour: 30,
  writesPerHostPerDay: 100,

  autoPerMinute: 4,
  autoPerHour: 30,
  confirmWaitMs: 20_000,

  writeTimeoutMs: 15_000,
  confirmValueMax: 60,
  labelMax: 60,

  newGrantMs: 10 * 60_000,
  maxWriteGrants: 128,
  sendsKept: 20,
  writeIdsKept: 64,
});

const L = PROGRAM_CARD_MCP_LIMITS;
const USE_NAME = /^[a-z][A-Za-z0-9_]{0,23}$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const FIELD_LABEL = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

const JSON_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

const APP_KEY = /^app:([a-z0-9][a-z0-9._-]{0,63})$/;
const RUN_KEY = /^run:[A-Za-z0-9][A-Za-z0-9._:#-]{0,95}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const USE_FIELDS = new Set(["name", "server", "tool", "kind", "title", "description", "sends", "gets", "args", "vary", "pick", "every"]);
const TEXT_FIELDS                          = [
  ["title", L.titleMax],
  ["description", L.descriptionMax],
  ["sends", L.sendsMax],
  ["gets", L.getsMax],
];

const READ_STATUSES = new Set(["allowed", "waiting"]);
const RECORD_FIELDS = new Set(["key", "appId", "name", "digest", "uses", "reads", "atMs"]);
const READ_FIELDS = new Set(["reach", "server", "tool", "status", "toolDigest", "atMs"]);
const KEPT_FIELDS = new Set(["key", "server", "tool", "atMs"]);
const OPS = new Set(["open", "call", "close", "ask", "decide", "confirm", "remove", "server", "risk", "write_tool", "auto", "state", "host_command"]);

const GRANT_STATUSES = new Set(["allowed", "denied", "waiting", "paused"]);
const GRANT_FIELDS = new Set(["key", "use", "useDigest", "toolDigest", "status", "card", "spec", "auto", "autoOff", "sends", "atMs"]);

const AUTO_OFFS = new Set(["changed", "breaker_minute", "breaker_hour"]);
const SEND_VIAS = new Set(["glasses", "phone", "auto"]);
const SEND_FIELDS = new Set(["atMs", "via", "outcome", "values"]);
const GRANT_AUTO_FIELDS = new Set(["atMs", "sourceRev"]);

const SEND_OUTCOMES = new Set(["sent", "declined", "timeout", "failed", "unknown"]);
const RISKS = new Set(["normal", "high"]);

const HOST_BLOCKED_FIX = (server        ) => `openclaw mcp configure ${server} --approval approve`;
const FIX_MAX = 200;
const CONTROL_ALL = new RegExp(CONTROL.source, "g");
const fixFor = (name        , server     ) => (server && server.fix) || HOST_BLOCKED_FIX(name);
const ANNOTATIONS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

const HOST_CODES = new Set(["timeout", "busy", "off", "not_allowed", "too_big"]);

const charCount = (text        ) => Array.from(text).length;
const utf8Bytes = (text        ) => new TextEncoder().encode(text).byteLength;
const jsonBytes = (value     ) => {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? utf8Bytes(text) : 0;
  } catch (_) {
    return Infinity;
  }
};
const hasOwn = (object     , key        ) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (error        ) => ({ ok: false         , error });

function singleLine(raw     , max        )                {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || CONTROL.test(text) || charCount(text) > max) return null;
  return text;
}

function jsonClone(value     )      {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return undefined;
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
}

const fieldLabel = (key        ) => (FIELD_LABEL.test(key) ? key : "(unnamed)");

const isScalar = (value     ) =>
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && charCount(value) <= L.oneOfTextMax && !CONTROL.test(value));

function parseVary(raw     )                                                         {
  if (raw === undefined || raw === null) return { ok: true, vary: {} };
  if (!isPlainObject(raw)) return fail("vary is an object of argument name: bound");
  const names = Object.keys(raw);
  if (names.length > L.varyMax) return fail(`vary names at most ${L.varyMax} arguments`);
  const vary      = {};
  for (const name of names) {
    if (!ARG_NAME.test(name)) return fail("vary names are letters, digits or _ (40 at most), starting with a letter or _");
    const spec = raw[name];
    if (!isPlainObject(spec)) return fail(`vary.${name} is { min, max }, { oneOf } or { text }`);
    const keys = Object.keys(spec).sort().join(",");
    if (keys === "max,min") {
      const { min, max } = spec;
      if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        return fail(`vary.${name} min and max are numbers with min at most max`);
      }
      vary[name] = { min, max };
    } else if (keys === "oneOf") {
      const list = spec.oneOf;
      if (!Array.isArray(list) || list.length < 1 || list.length > L.oneOfMax || !list.every(isScalar)) {
        return fail(`vary.${name}.oneOf lists 1 to ${L.oneOfMax} plain values (text up to ${L.oneOfTextMax} characters, numbers or true/false)`);
      }
      vary[name] = { oneOf: [...list] };
    } else if (keys === "text") {
      if (!Number.isInteger(spec.text) || spec.text < 1 || spec.text > L.textMax) {
        return fail(`vary.${name}.text is the longest text a call may send, 1 to ${L.textMax}`);
      }
      vary[name] = { text: spec.text };
    } else {
      return fail(`vary.${name} is exactly one of { min, max }, { oneOf } or { text }`);
    }
  }
  return { ok: true, vary };
}

function parseUse(spec     )                                                        {
  if (!isPlainObject(spec)) return fail("each MCP use is an object");
  const name = spec.name;
  if (typeof name !== "string" || !USE_NAME.test(name)) {
    return fail("use names start with a lowercase letter and use letters, digits or _ (24 at most)");
  }
  for (const key of Object.keys(spec)) {
    if (!USE_FIELDS.has(key)) return fail(`use ${name} has an unknown field ${fieldLabel(key)}`);
  }
  if (typeof spec.server !== "string" || !SERVER_NAME.test(spec.server)) return fail(`use ${name} needs the server's name`);
  if (typeof spec.tool !== "string" || !TOOL_NAME.test(spec.tool)) return fail(`use ${name} needs the tool's name`);
  const kind = spec.kind === undefined || spec.kind === null ? "read" : spec.kind;
  if (kind !== "read" && kind !== "write") return fail(`use ${name} kind is read or write`);
  const use      = { name, server: spec.server, tool: spec.tool, kind };
  for (const [field, max] of TEXT_FIELDS) {
    const line = singleLine(spec[field], max);
    if (line === null) return fail(`use ${name} ${field} must be 1 to ${max} characters of plain text`);
    use[field] = line;
  }
  let args      = {};
  if (spec.args !== undefined && spec.args !== null) {
    if (!isPlainObject(spec.args)) return fail(`use ${name} args is a JSON object`);
    args = jsonClone(spec.args);
    if (!isPlainObject(args)) return fail(`use ${name} args is a JSON object`);
    for (const key of Object.keys(args)) if (!ARG_NAME.test(key)) return fail(`use ${name} args names are letters, digits or _`);
    if (jsonBytes(args) > L.argsBytesMax) return fail(`use ${name} args is at most ${L.argsBytesMax} bytes of JSON`);
  }
  use.args = args;
  const vary = parseVary(spec.vary);
  if (!vary.ok) return fail(`use ${name}: ${vary.error}`);
  for (const key of Object.keys(vary.vary)) if (hasOwn(args, key)) return fail(`use ${name}: ${key} is pinned in args and cannot vary`);
  use.vary = vary.vary;
  if (spec.pick === undefined || spec.pick === null) use.pick = null;
  else if (typeof spec.pick === "string" && JSON_PATH.test(spec.pick)) use.pick = spec.pick;
  else return fail(`use ${name} pick is a path like $.result.items[0]`);
  if (spec.every === undefined || spec.every === null) use.every = null;
  else if (kind === "write") return fail(`use ${name}: a write is never repeated, so it has no every`);
  else if (Number.isInteger(spec.every) && spec.every >= L.everyMinSec && spec.every <= L.everyMaxSec) use.every = spec.every;
  else return fail(`use ${name} every is whole seconds from ${L.everyMinSec} to ${L.everyMaxSec}`);
  return { ok: true, use };
}

function parseProgramCardMcpUses(raw     )                                                           {
  if (!Array.isArray(raw) || raw.length === 0) return fail("mcp needs at least one use");
  if (raw.length > L.maxUses) return fail(`a card may declare at most ${L.maxUses} MCP uses`);
  const uses        = [];
  const names = new Set();
  for (const spec of raw) {
    const parsed = parseUse(spec);
    if (!parsed.ok) return parsed;
    if (names.has(parsed.use.name)) return fail(`use ${parsed.use.name} is declared twice`);
    names.add(parsed.use.name);
    uses.push(parsed.use);
  }
  if (jsonBytes(uses) > L.blockBytesMax) return fail(`the mcp block is over ${L.blockBytesMax} bytes`);
  return { ok: true, uses };
}

const callIdOf = (raw     ) =>
  raw && typeof raw === "object" && typeof raw.id === "string" && raw.id.length >= 1 && raw.id.length <= L.callIdMax && !CONTROL.test(raw.id)
    ? raw.id
    : null;
const callMcpOf = (raw     ) => (raw && typeof raw === "object" && typeof raw.mcp === "string" && USE_NAME.test(raw.mcp) ? raw.mcp : null);

function varyFits(spec     , value     ) {
  if (hasOwn(spec, "min")) return typeof value === "number" && Number.isFinite(value) && value >= spec.min && value <= spec.max;
  if (hasOwn(spec, "oneOf")) return spec.oneOf.some((choice     ) => choice === value);
  if (hasOwn(spec, "text")) return typeof value === "string" && charCount(value) <= spec.text && !CONTROL.test(value);
  return false;
}

function parseProgramCardMcpUse(spec     ) {
  return parseUse(spec);
}

const CALL_FIELDS = new Set(["id", "mcp", "args", "label", "from"]);

function parseProgramCardMcpCall(raw     , uses       ) {
  const id = callIdOf(raw);
  const name = callMcpOf(raw);
  if (!id || !name || !isPlainObject(raw)) return { ok: false          };
  if (Object.keys(raw).some((key) => !CALL_FIELDS.has(key))) return { ok: false          };
  const use = uses.find((u     ) => u.name === name);
  if (!use) return { ok: false          };
  const args = raw.args === undefined || raw.args === null ? {} : raw.args;
  if (!isPlainObject(args) || jsonBytes(args) > L.callArgsBytesMax) return { ok: false          };
  const out      = {};
  for (const key of Object.keys(args)) {
    if (!hasOwn(use.vary, key) || !varyFits(use.vary[key], args[key])) return { ok: false          };
    out[key] = args[key];
  }
  let label                = null;
  if (raw.label !== undefined && raw.label !== null) {
    label = singleLine(raw.label, L.labelMax);
    if (label === null) return { ok: false          };
  }
  const from = typeof raw.from === "string" && /^[a-z_]{1,16}$/.test(raw.from) ? raw.from : "unknown";
  return { ok: true         , call: { id, mcp: name, args: out, ...(label ? { label } : {}) }, use, from };
}

function programCardMcpDigest(uses     ) {
  return createHash("sha256").update(canonicalSerialize(uses)).digest("hex");
}

function programCardMcpReadUses(uses       ) {
  return uses.filter((use     ) => use.kind !== "write");
}

function programCardMcpUseDigest(use     ) {
  return createHash("sha256").update(canonicalSerialize(use)).digest("hex");
}

function programCardMcpReachDigest(use     ) {
  const reach = {
    server: use.server, tool: use.tool, kind: use.kind === "write" ? "write" : "read",
    args: use.args || {}, vary: use.vary || {}, pick: use.pick === undefined ? null : use.pick,
  };
  return createHash("sha256").update(canonicalSerialize(reach)).digest("hex");
}

function programCardMcpToolDigest(uses       , listing     ) {
  const tools = uses.map((use     ) => {
    const tool = toolOf(listing, use.server, use.tool);
    return { server: use.server, tool: use.tool, inputSchema: tool ? tool.inputSchema : null, annotations: tool ? tool.annotations : null };
  });
  return createHash("sha256").update(canonicalSerialize(tools)).digest("hex");
}

function toolOf(listing     , server        , tool        ) {
  const entry = listing && listing.servers instanceof Map ? listing.servers.get(server) : null;
  return entry && entry.tools instanceof Map ? entry.tools.get(tool) || null : null;
}

const schemaTypes = (raw     )                  =>
  typeof raw === "string" ? [raw] : Array.isArray(raw) && raw.every((t     ) => typeof t === "string") ? raw : null;

function typeFits(value     , types          ) {
  return types.some((type) => {
    if (type === "string") return typeof value === "string";
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "object") return isPlainObject(value);
    if (type === "array") return Array.isArray(value);
    if (type === "null") return value === null;
    return true;
  });
}

function varySamples(spec     ) {
  if (hasOwn(spec, "min")) return [spec.min, spec.max];
  if (hasOwn(spec, "oneOf")) return spec.oneOf;
  return [""];
}

function schemaProblem(use     , schema     )                {
  if (!isPlainObject(schema)) return null;
  const props = isPlainObject(schema.properties) ? schema.properties : null;
  const required = Array.isArray(schema.required) ? schema.required.filter((r     ) => typeof r === "string") : [];
  const provided = new Set([...Object.keys(use.args), ...Object.keys(use.vary)]);
  for (const name of required) {
    if (!provided.has(name)) return `the tool needs ${fieldLabel(name)}: pin it in args or let the card vary it`;
  }
  if (!props) return null;
  if (schema.additionalProperties === false) {
    for (const name of provided) if (!hasOwn(props, name)) return `the tool has no argument ${fieldLabel(name)}`;
  }
  for (const name of Object.keys(use.args)) {
    const types = hasOwn(props, name) && isPlainObject(props[name]) ? schemaTypes(props[name].type) : null;
    if (types && !typeFits(use.args[name], types)) return `args.${fieldLabel(name)} should be ${types.join(" or ")}`;
  }
  for (const name of Object.keys(use.vary)) {
    const types = hasOwn(props, name) && isPlainObject(props[name]) ? schemaTypes(props[name].type) : null;
    if (types && !varySamples(use.vary[name]).every((sample     ) => typeFits(sample, types))) {
      return `vary.${fieldLabel(name)} should be ${types.join(" or ")}`;
    }
  }
  return null;
}

function checkProgramCardMcpUses(uses       , listing     , cardServers             , writeTools                                  = null) {
  for (const use of uses) {
    const where = `${use.server} · ${use.tool}`;
    if (!cardServers.has(use.server)) {
      return { ok: false         , code: "not_allowed", error: `MCP server ${use.server} is not turned on for cards (Tool & service access on the phone's LiveUI page, under MCP servers)` };
    }
    const server = listing && listing.servers instanceof Map ? listing.servers.get(use.server) : null;

    const blocked = !!server && server.reason === "host_blocked";
    const hides = blocked && server.writes !== false;
    if (!server || (server.connected !== true && !hides)) return { ok: false         , code: "off", error: `MCP server ${use.server} is not connected on this host` };
    const tool = server.tools.get(use.tool);
    if (!tool && hides) {
      return {
        ok: false         , code: "failed", reason: "host_blocked", fix: fixFor(use.server, server),
        error: `This host hides ${where} until the owner trusts ${use.server}'s tools: \`${fixFor(use.server, server)}\``,
      };
    }
    if (use.kind === "write" && server.hostCommands === true) {
      return { ok: false         , code: "failed", error: `${where} is a host command, and host commands only read` };
    }
    if (use.kind === "write" && server.writes === false) {
      return {
        ok: false         , code: "failed", reason: "host_blocked", fix: fixFor(use.server, server),
        error: `This host would ask its own approval before ${where} sends, so cards cannot send to it. The owner can: ${fixFor(use.server, server)}`,
      };
    }
    if (!tool) return { ok: false         , code: "failed", error: `MCP server ${use.server} has no tool ${use.tool}` };
    const hints = tool.annotations || {};
    if (hints.destructiveHint === true) return { ok: false         , code: "failed", error: `${where} can delete or overwrite, so cards may not use it` };
    const ownerWrite = !!writeTools && !!writeTools.get(use.server) && writeTools.get(use.server) .has(use.tool);
    if (use.kind !== "write" && ownerWrite) {
      return { ok: false         , code: "failed", error: `The owner marked ${where} as a write, so a card cannot read it; declare it as a write` };
    }
    if (use.kind !== "write" && hints.readOnlyHint !== true) {
      return { ok: false         , code: "failed", error: `${where} is not marked read-only by its server, so it counts as a write; declare it as a write` };
    }
    const problem = schemaProblem(use, tool.inputSchema);
    if (problem) return { ok: false         , code: "failed", error: `${where}: ${problem}` };
  }
  return { ok: true         , toolDigest: programCardMcpToolDigest(uses, listing) };
}

function resolveProgramCardMcpPick(value     , pick        ) {
  const steps = pick.slice(1).match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) || [];
  let cursor = value;
  for (const step of steps) {
    if (step.startsWith("[")) {
      const index = Number(step.slice(1, -1));
      if (!Array.isArray(cursor) || index >= cursor.length) return undefined;
      cursor = cursor[index];
    } else {
      const key = step.slice(1);
      if (!isPlainObject(cursor) || !hasOwn(cursor, key)) return undefined;
      cursor = cursor[key];
    }
  }
  return cursor;
}

function parseJsonText(text        ) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    return { ok: false, value: undefined };
  }
}

function programCardMcpValue(use     , out     ) {
  if (!out || out.ok !== true) {
    const code = out && typeof out.code === "string" && HOST_CODES.has(out.code) ? out.code : "failed";
    return { ok: false         , code };
  }
  if (out.isError === true) return { ok: false         , code: "failed" };
  if (out.truncated === true) return { ok: false         , code: "too_big" };
  const hasStructured = out.structured !== undefined && out.structured !== null;
  const text = typeof out.text === "string" ? out.text : null;
  const rawBytes = hasStructured ? jsonBytes(out.structured) : text !== null ? utf8Bytes(text) : 0;
  if (rawBytes > L.rawBytesMax) return { ok: false         , code: "too_big" };
  let data     ;
  let parsed = false;
  if (hasStructured) {
    data = jsonClone(out.structured);
    parsed = data !== undefined;
  } else if (text !== null) {
    const json = parseJsonText(text);
    parsed = json.ok;
    data = json.ok ? json.value : text;
  } else {
    data = null;
    parsed = true;
  }
  let value      = data;
  if (use.pick) {
    if (!parsed) return { ok: false         , code: "failed" };

    let pick = use.pick;
    if (hasStructured && !(isPlainObject(data) && hasOwn(data, "structuredContent"))) {
      const wrapper = /^\$\.structuredContent(?=$|[.[])/.exec(pick);
      if (wrapper) pick = "$" + pick.slice(wrapper[0].length);
    }
    value = resolveProgramCardMcpPick(data, pick);
    if (value === undefined) value = null;
  }
  if (value === undefined) return { ok: false         , code: "failed" };
  if (jsonBytes(value) > L.valueBytesMax) return { ok: false         , code: "too_big" };
  return { ok: true         , value };
}

function parseProgramCardMcpListing(raw     , atMs        ) {
  const out      = { ok: false, reason: "failed", atMs, servers: new Map(), writes: false };
  if (!raw || typeof raw !== "object") return out;
  if (raw.ok !== true) {
    out.reason = raw.reason === "unsupported" || raw.reason === "no_servers" ? raw.reason : "failed";
    return out;
  }
  const list = Array.isArray(raw.servers) ? raw.servers.slice(0, L.maxServers) : [];
  for (const server of list) {
    if (!server || typeof server.name !== "string" || !SERVER_NAME.test(server.name) || out.servers.has(server.name)) continue;
    const tools = new Map();
    for (const tool of Array.isArray(server.tools) ? server.tools.slice(0, L.maxToolsPerServer) : []) {
      if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name) || tools.has(tool.name)) continue;
      const annotations      = {};
      const rawHints = isPlainObject(tool.annotations) ? tool.annotations : {};
      for (const hint of ANNOTATIONS) if (typeof rawHints[hint] === "boolean") annotations[hint] = rawHints[hint];
      const schema = isPlainObject(tool.inputSchema) && jsonBytes(tool.inputSchema) <= L.schemaBytesMax ? jsonClone(tool.inputSchema) : null;
      const description = typeof tool.description === "string" ? tool.description.replace(/\s+/g, " ").replace(CONTROL_ALL, "").replace(/ {2,}/g, " ").trim() : "";
      tools.set(tool.name, {
        description: Array.from(description).slice(0, L.toolDescriptionMax).join(""),
        inputSchema: schema,
        annotations,
      });
    }

    const granted = typeof server.granted === "boolean" ? server.granted : null;

    const reason = server.reason === "host_blocked" ? "host_blocked" : null;

    const fix = reason && typeof server.fix === "string"
      ? Array.from(server.fix.replace(/\s+/g, " ").trim().replace(CONTROL_ALL, "")).slice(0, FIX_MAX).join("") || null
      : null;
    out.servers.set(server.name, { connected: server.connected === true, granted, reason, fix, writes: server.writes !== false, hostCommands: server.hostCommands === true, tools });
  }

  out.writes = raw.writes === true;
  out.ok = true;
  out.reason = out.servers.size ? null : "no_servers";
  return out;
}

const appIdOf = (key        ) => {
  const match = APP_KEY.exec(key);
  return match ? match[1] : null;
};
const validKey = (raw     ) => (typeof raw === "string" && (APP_KEY.test(raw) || RUN_KEY.test(raw)) ? raw : null);

const keptId = (key        , server        , tool        ) => `${key}\n${server}\n${tool}`;

function cardName(raw     ) {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text || CONTROL.test(text)) return "Card";
  return Array.from(text).slice(0, L.cardNameMax).join("");
}

function validStoredRead(raw     ) {
  if (!isPlainObject(raw) || Object.keys(raw).some((field) => !READ_FIELDS.has(field))) return null;
  if (typeof raw.reach !== "string" || !DIGEST.test(raw.reach)) return null;
  if (typeof raw.server !== "string" || !SERVER_NAME.test(raw.server)) return null;
  if (typeof raw.tool !== "string" || !TOOL_NAME.test(raw.tool)) return null;
  if (!READ_STATUSES.has(raw.status)) return null;
  if (typeof raw.toolDigest !== "string" || (raw.toolDigest !== "" && !DIGEST.test(raw.toolDigest))) return null;
  if (raw.status === "allowed" && raw.toolDigest === "") return null;
  if (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  return { reach: raw.reach, server: raw.server, tool: raw.tool, status: raw.status, toolDigest: raw.toolDigest, atMs: raw.atMs };
}

function validStoredRecord(raw     ) {
  if (!isPlainObject(raw)) return null;
  if (Object.keys(raw).some((field) => !RECORD_FIELDS.has(field))) return null;
  const appId = typeof raw.key === "string" ? appIdOf(raw.key) : null;
  if (!appId || raw.appId !== appId) return null;
  if (typeof raw.name !== "string" || cardName(raw.name) !== raw.name) return null;
  if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) return null;
  if (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  const parsed = parseProgramCardMcpUses(raw.uses);
  if (!parsed.ok || parsed.uses.some((use     ) => use.kind === "write") || programCardMcpDigest(parsed.uses) !== raw.digest) return null;

  if (!readAskFits(raw.name, parsed.uses, L.requestQuestionMax)) return null;
  if (!Array.isArray(raw.reads) || raw.reads.length > L.readsKept) return null;
  const reads        = [];
  for (const entry of raw.reads) {
    const read = validStoredRead(entry);
    if (!read || reads.some((r) => r.reach === read.reach)) return null;
    reads.push(read);
  }
  return { key: raw.key, appId, name: raw.name, digest: raw.digest, uses: parsed.uses, reads, atMs: raw.atMs };
}

function validStoredKept(raw     ) {
  if (!isPlainObject(raw) || Object.keys(raw).some((field) => !KEPT_FIELDS.has(field))) return null;
  if (typeof raw.key !== "string" || !appIdOf(raw.key)) return null;
  if (typeof raw.server !== "string" || !SERVER_NAME.test(raw.server)) return null;
  if (typeof raw.tool !== "string" || !TOOL_NAME.test(raw.tool)) return null;
  if (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  return { key: raw.key, server: raw.server, tool: raw.tool, atMs: raw.atMs };
}

function createProgramCardMcpStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, PROGRAM_CARD_MCP_FILENAME);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const empty = () => ({ servers: []            , cards: []         , kept: []          });
  const DOC_FIELDS = new Set(["schemaVersion", "cards", "servers", "kept"]);

  function read() {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      return empty();
    }
    let doc     ;
    try {
      doc = JSON.parse(raw);
    } catch (_) {
      return empty();
    }
    if (!isPlainObject(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.cards) || !Array.isArray(doc.servers)) return empty();
    if (Object.keys(doc).some((field) => !DOC_FIELDS.has(field))) return empty();
    if (doc.kept !== undefined && !Array.isArray(doc.kept)) return empty();
    const servers           = [];
    for (const name of doc.servers) {
      if (typeof name !== "string" || !SERVER_NAME.test(name) || servers.includes(name)) return empty();
      servers.push(name);
    }
    const cards        = [];
    const seen = new Set();
    for (const card of doc.cards) {
      const record = validStoredRecord(card);
      if (!record || seen.has(record.key)) continue;
      seen.add(record.key);
      cards.push(record);
    }
    const kept        = [];
    const keptSeen = new Set();
    for (const raw of doc.kept || []) {
      const no = validStoredKept(raw);
      const id = no ? `${no.key}\n${no.server}\n${no.tool}` : "";
      if (!no || keptSeen.has(id)) continue;
      keptSeen.add(id);
      kept.push(no);
    }
    return {
      servers: servers.slice(0, L.maxServers),
      cards: cards.sort((a, b) => b.atMs - a.atMs).slice(0, L.maxRecords),
      kept: kept.sort((a, b) => b.atMs - a.atMs).slice(0, L.maxKept),
    };
  }

  function write(state     ) {
    const servers = (state && Array.isArray(state.servers) ? state.servers : [])
      .filter((name     ) => typeof name === "string" && SERVER_NAME.test(name))
      .slice(0, L.maxServers);
    const stamp = (atMs     ) => (Number.isSafeInteger(atMs) ? atMs : now());
    const cards = (state && Array.isArray(state.cards) ? state.cards : [])
      .filter((r     ) => r && typeof r.key === "string" && appIdOf(r.key))
      .map((r     ) => ({
        key: r.key,
        appId: appIdOf(r.key),
        name: r.name,
        digest: r.digest,
        uses: r.uses,
        reads: (Array.isArray(r.reads) ? r.reads : []).slice(0, L.readsKept).map((x     ) => ({
          reach: x.reach, server: x.server, tool: x.tool, status: x.status,
          toolDigest: typeof x.toolDigest === "string" ? x.toolDigest : "", atMs: stamp(x.atMs),
        })),
        atMs: stamp(r.atMs),
      }))
      .sort((a     , b     ) => b.atMs - a.atMs)
      .slice(0, L.maxRecords);
    const kept = (state && Array.isArray(state.kept) ? state.kept : [])
      .filter((k     ) => k && typeof k.key === "string" && appIdOf(k.key))
      .map((k     ) => ({ key: k.key, server: k.server, tool: k.tool, atMs: stamp(k.atMs) }))
      .sort((a     , b     ) => b.atMs - a.atMs)
      .slice(0, L.maxKept);
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: { schemaVersion: 1, servers, cards, kept } });
  }

  return { file, read, write };
}

function validSend(raw     ) {
  if (!isPlainObject(raw) || !Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  if (Object.keys(raw).some((field) => !SEND_FIELDS.has(field))) return null;
  if (!SEND_VIAS.has(raw.via) || !SEND_OUTCOMES.has(raw.outcome)) return null;
  const values = typeof raw.values === "string" ? Array.from(raw.values.replace(CONTROL_ALL, "")).slice(0, 200).join("") : "";
  return { atMs: raw.atMs, via: raw.via, outcome: raw.outcome, values };
}

function validStoredGrant(raw     ) {
  if (!isPlainObject(raw)) return null;
  if (Object.keys(raw).some((field) => !GRANT_FIELDS.has(field))) return null;
  if (typeof raw.key !== "string" || !appIdOf(raw.key)) return null;
  if (typeof raw.use !== "string" || !USE_NAME.test(raw.use)) return null;
  if (typeof raw.useDigest !== "string" || !DIGEST.test(raw.useDigest)) return null;
  if (typeof raw.toolDigest !== "string" || !DIGEST.test(raw.toolDigest)) return null;
  if (!GRANT_STATUSES.has(raw.status)) return null;
  if (typeof raw.card !== "string" || cardName(raw.card) !== raw.card) return null;
  if (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  const parsed = parseUse(raw.spec);
  if (!parsed.ok || parsed.use.kind !== "write" || parsed.use.name !== raw.use || programCardMcpUseDigest(parsed.use) !== raw.useDigest) return null;
  let auto      = null;
  if (raw.auto !== null && raw.auto !== undefined) {
    if (!isPlainObject(raw.auto) || !Number.isSafeInteger(raw.auto.atMs) || typeof raw.auto.sourceRev !== "string" || raw.auto.sourceRev.length > 128) return null;
    if (Object.keys(raw.auto).some((field) => !GRANT_AUTO_FIELDS.has(field))) return null;
    auto = { atMs: raw.auto.atMs, sourceRev: raw.auto.sourceRev };
  }
  if (raw.autoOff !== undefined && raw.autoOff !== null && !AUTO_OFFS.has(raw.autoOff)) return null;
  const sends = Array.isArray(raw.sends) ? raw.sends.map(validSend) : [];
  if (sends.some((send     ) => !send)) return null;
  return {
    key: raw.key, use: raw.use, useDigest: raw.useDigest, toolDigest: raw.toolDigest, status: raw.status,
    card: raw.card, spec: parsed.use, auto, autoOff: auto ? null : raw.autoOff || null, sends: sends.slice(-L.sendsKept), atMs: raw.atMs,
  };
}

function validServerSettings(raw     ) {
  if (!isPlainObject(raw) || !RISKS.has(raw.risk) || typeof raw.autoSend !== "boolean" || !Array.isArray(raw.writeTools)) return null;
  const writeTools           = [];
  for (const tool of raw.writeTools) {
    if (typeof tool !== "string" || !TOOL_NAME.test(tool) || writeTools.includes(tool)) return null;
    writeTools.push(tool);
  }
  return { risk: raw.risk, autoSend: raw.autoSend, writeTools: writeTools.slice(0, L.maxToolsPerServer) };
}

const PROGRAM_CARD_MCP_WRITES_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "servers", "grants"],
  maps: { servers: { fields: ["risk", "autoSend", "writeTools"] } },
});

function createProgramCardMcpWritesStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, PROGRAM_CARD_MCP_WRITES_FILENAME);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const empty = () => ({ servers: {}       , grants: []          });

  function whole() {
    let doc     ;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      return null;
    }
    return isPlainObject(doc) && doc.schemaVersion === 1 && isPlainObject(doc.servers) && Array.isArray(doc.grants) ? doc : null;
  }

  function serversOf(doc     ) {
    const servers      = {};
    for (const name of Object.keys(doc.servers).slice(0, L.maxServers)) {
      const settings = SERVER_NAME.test(name) ? validServerSettings(doc.servers[name]) : null;
      if (!settings) return null;
      servers[name] = settings;
    }
    return servers;
  }

  function read() {
    const doc = whole();
    const servers = doc ? serversOf(doc) : null;
    if (!servers) return empty();
    const asksAgain = { servers, grants: []          };

    if (hasUnknownFields(doc, PROGRAM_CARD_MCP_WRITES_SAVED_SHAPE)) return asksAgain;
    const grants        = [];
    const seen = new Set();
    for (const raw of doc.grants) {
      const grant = validStoredGrant(raw);
      const id = grant ? `${grant.key}\n${grant.use}` : "";
      if (!grant || seen.has(id)) return asksAgain;
      seen.add(id);
      grants.push(grant);
    }
    return { servers, grants: grants.sort((a, b) => b.atMs - a.atMs).slice(0, L.maxWriteGrants) };
  }

  function write(state     ) {
    const servers      = {};
    const rawServers = state && isPlainObject(state.servers) ? state.servers : {};
    for (const name of Object.keys(rawServers).slice(0, L.maxServers)) {
      const settings = SERVER_NAME.test(name) ? validServerSettings(rawServers[name]) : null;
      if (settings) servers[name] = settings;
    }
    const grants = (state && Array.isArray(state.grants) ? state.grants : [])
      .filter((g     ) => g && typeof g.key === "string" && appIdOf(g.key))
      .map((g     ) => ({
        key: g.key, use: g.use, useDigest: g.useDigest, toolDigest: g.toolDigest, status: g.status, card: g.card,
        spec: g.spec, auto: g.auto || null, autoOff: g.autoOff || null, sends: (Array.isArray(g.sends) ? g.sends : []).slice(-L.sendsKept),
        atMs: Number.isSafeInteger(g.atMs) ? g.atMs : now(),
      }))
      .sort((a     , b     ) => b.atMs - a.atMs)
      .slice(0, L.maxWriteGrants);
    const record = { schemaVersion: 1, servers, grants };

    const before = whole();
    const kept = before && serversOf(before) && hasUnknownFields(before, PROGRAM_CARD_MCP_WRITES_SAVED_SHAPE)
      ? carryUnknownFields(before, record, PROGRAM_CARD_MCP_WRITES_SAVED_SHAPE)
      : record;
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: kept });
  }

  return { file, read, write };
}

function createProgramCardSourceRev(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const directory = resolveLiveuiLibraryTypeDir("app", opts.libraryDir);
  return (key        )                => {
    const appId = typeof key === "string" ? appIdOf(key) : null;
    if (!appId || !directory) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, `${appId}.json`), "utf8"));
      if (!isPlainObject(record) || !isPlainObject(record.card)) return null;
      return createHash("sha256")
        .update(canonicalSerialize({ card: record.card, revision: programCardCurrentRevision(record) }))
        .digest("hex");
    } catch (_) {
      return null;
    }
  };
}

function requestQuestion(name        , uses       ) {
  return [`"${name}" wants to read your tools:`, ...uses.map((u     ) => `• Reads ${u.server}: ${u.title}`)].join("\n");
}

function readAskFits(name        , uses       , max        ) {
  return charCount(requestQuestion(name, uses)) <= max;
}

function boundWords(name        , spec     ) {
  if (hasOwn(spec, "min")) return `${name} ${spec.min} to ${spec.max}`;
  if (hasOwn(spec, "oneOf")) return `${name}: ${spec.oneOf.map((v     ) => String(v)).join(", ")}`;
  return `${name}: text up to ${spec.text}`;
}

const clip = (text        , max        ) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
};

function writeRequestQuestion(name               , uses       ) {
  const lines = uses.map((u     ) => {
    const bounds = Object.keys(u.vary).map((key) => boundWords(key, u.vary[key])).join("; ");
    return `• ${u.title}: ${u.server} · ${u.tool}, sends ${u.sends}${bounds ? ` (${bounds})` : ""}`;
  });
  return [name ? `Let "${name}" send to your tools?` : "Let a new card send to your tools?", ...lines, "Each send asks you first."].join("\n");
}

function sendValues(use     , args     ) {
  return Object.keys(use.vary)
    .filter((key) => hasOwn(args, key))
    .map((key) => `${key}: ${clip(typeof args[key] === "string" ? args[key] : JSON.stringify(args[key]), L.confirmValueMax)}`);
}

const REQUEST_REASONS = new Set(["timeout", "dismissed", "superseded", "display_changed", "cancel"]);

function withTimeout(promise              , ms        , setTimeoutFn     , clearTimeoutFn     , onTimeout     ) {
  return new Promise((resolve) => {
    let done = false;
    const handle = setTimeoutFn(() => {
      if (done) return;
      done = true;
      resolve(onTimeout);
    }, ms);
    if (handle && typeof handle.unref === "function") handle.unref();
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeoutFn(handle);
        resolve(value);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeoutFn(handle);
        resolve(null);
      },
    );
  });
}

function createProgramCardMcp(deps      = {}) {
  const limits = { ...PROGRAM_CARD_MCP_LIMITS, ...(deps.limits || {}) };
  const config = deps.config && typeof deps.config === "object" ? deps.config : {};
  let enabled = config.enabled === true;
  const agentHost = deps.host && typeof deps.host.list === "function" && typeof deps.host.call === "function" ? deps.host : null;

  const hostCommands = deps.hostCommands && deps.hostCommands.enabled === true && typeof deps.hostCommands.wrap === "function"
    ? deps.hostCommands : null;

  const host = hostCommands ? hostCommands.wrap(agentHost) : agentHost;
  const hostKind = host && host.kind === "hermes" ? "hermes" : "openclaw";
  const isArmed = () => enabled && host !== null;
  const send = typeof deps.send === "function" ? deps.send : () => {};
  const presentDecision = typeof deps.presentDecision === "function" ? deps.presentDecision : () => false;

  const cancelDecision = typeof deps.cancelDecision === "function" ? deps.cancelDecision : () => false;
  const withdraw = (surfaceId     ) => {
    if (typeof surfaceId !== "string" || !surfaceId) return;
    try { cancelDecision(surfaceId); } catch (_) {  }
  };
  const activeSessionKey = typeof deps.sessionKey === "function" ? deps.sessionKey : () => null;
  const store = deps.store && typeof deps.store.read === "function" ? deps.store : null;
  const writesStore = deps.writesStore && typeof deps.writesStore.read === "function" ? deps.writesStore : null;

  const writesCapable = typeof deps.writesCapable === "function" ? deps.writesCapable : () => false;

  const sourceRev = typeof deps.sourceRev === "function" ? deps.sourceRev : () => null;
  const now =typeof deps.now === "function" ? deps.now : Date.now;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const emitLifecycle = typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};

  const records = new Map();
  const kept = new Map();
  const cardServers = new Set        ();
  const lastCalls = new Map();
  const limited = new Map                ();
  const subs = new Map();
  const pending = new Map();
  const queue        = [];
  const inFlight = new Map();
  const restUntil = new Map();
  const windows = new Map();
  let today = { day: "", count: 0 };
  const grants = new Map();
  const serverSettings = new Map();

  const sessionGrants = new Map();
  const writeRequests = new Map();
  const confirms = new Map();
  const writeTimes = new Map();
  const autoTimes = new Map();
  let writeDay = { day: "", count: 0 };
  let requestSeq = 0;
  let presence = "unknown";
  let generation = 0;
  let listing      = { ok: false, reason: host ? null : "unsupported", atMs: 0, servers: new Map() };
  let listingPromise                      = null;
  let lastStateAt = 0;

  const cardHash = (key        ) => createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
  const pendingId = (key        , digest        ) => `${key}\n${digest}`;
  const presenceAway = () => presence === "absent" || presence === "in_case";
  const errorCode = (err     ) => (err && typeof err.code === "string" ? err.code.slice(0, 32) : "error");

  function emit(event        , level        , data     ) {
    try {
      emitLifecycle(event, level, data);
    } catch (_) {

    }
  }

  function timer(fn     , ms        ) {
    const handle = setTimeoutFn(fn, Math.max(0, ms));

    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  if (store) {
    try {
      const saved = store.read();
      for (const name of saved.servers || []) cardServers.add(name);
      for (const record of saved.cards || []) if (record && typeof record.key === "string") records.set(record.key, record);
      for (const no of saved.kept || []) if (no && typeof no.key === "string") kept.set(keptId(no.key, no.server, no.tool), no);
    } catch (err     ) {
      emit("program_card_mcp_store_failed", "warn", { op: "read", code: errorCode(err) });
    }
  }
  if (hostCommands) {
    hostCommands.bind({
      onChange: () => {
        sendState();
        void loadListing(true);
      },

      onAdded: () => {
        if (!cardServers.has(HOST_COMMANDS_SERVER) && cardServers.size < limits.maxServers) {
          cardServers.add(HOST_COMMANDS_SERVER);
          persist();
          emit("program_card_mcp_server", "info", { server: HOST_COMMANDS_SERVER, allow: true });
        }
      },
    });
  }
  if (writesStore) {
    try {
      const saved = writesStore.read();
      for (const name of Object.keys(saved.servers || {})) {
        const s = saved.servers[name];
        serverSettings.set(name, { risk: s.risk, autoSend: s.autoSend, writeTools: new Set(s.writeTools) });
      }
      for (const grant of saved.grants || []) {
        if (!grants.has(grant.key)) grants.set(grant.key, new Map());
        grants.get(grant.key).set(grant.use, grant);
      }
    } catch (err     ) {
      emit("program_card_mcp_store_failed", "warn", { op: "read_writes", code: errorCode(err) });
    }
  }

  function sendFrame(frame     ) {
    try {
      send(frame);
    } catch (err     ) {
      emit("program_card_mcp_send_failed", "warn", { kind: frame.kind || "state", code: errorCode(err) });
    }
  }

  const asking = (key        ) => [...pending.values()].some((card     ) => card.key === key && !card.settled);

  const tapAsks = (entry     ) => RUN_KEY.test(entry.key) && entry.status === "waiting" && !asking(entry.key);

  function sendStatus(entry     ) {
    const extra = asking(entry.key) ? { asking: true } : tapAsks(entry) ? { tap: true } : {};
    sendFrame({ type: PROGRAM_CARD_MCP_DATA_FRAME, sub: entry.sub, kind: "status", status: entry.status, ...extra });
  }

  function askAgain(msg     ) {
    const entry = typeof msg.sub === "string" ? subs.get(msg.sub) : null;
    if (!entry || !isLive(entry) || !tapAsks(entry)) {
      emit("program_card_mcp_dropped", "debug", { op: "ask", reason: entry ? "not_waiting" : "unknown_sub" });
      if (entry && isLive(entry)) sendStatus(entry);
      return;
    }

    const same = (a     , b     ) => a.call.id === b.call.id;
    for (const job of entry.missed || []) {
      if (entry.held.length < limits.maxHeldPerSub && !entry.held.some((h     ) => same(h, job))) entry.held.push(job);
    }
    entry.missed = [];
    void consider({ sessionKey: null, key: entry.key, name: entry.name, uses: entry.uses, cause: "tap" });
  }

  function sendStatusFor(key        ) {
    for (const entry of subs.values()) if (entry.key === key && isLive(entry)) sendStatus(entry);
  }

  function badCheckOf(entry     , use     , write         ) {
    if (write) {
      const check = entry.writeChecks.get(use.name);
      return check && check.state === "bad" ? { code: check.cause || check.code, reason: check.reason || null } : null;
    }
    const own = useCheck(entry, use);
    return own && !own.ok ? { code: own.code, reason: own.reason || null } : null;
  }

  const whyOfCheck = (bad     ) => bad.code === "off" ? "unavailable"
    : bad.code === "not_allowed" || bad.reason === "host_blocked" ? "setup_blocked" : "unfit";

  function whyOf(ctx     , code        ) {
    if (!ctx || !ctx.entry || !ctx.use) return null;
    const { entry, use, cause } = ctx;
    const write = ctx.write === true || use.kind === "write";
    if (code === "limit" || code === "no_gesture" || code === "declined") return null;
    if (code === "timeout") return "timed_out";
    if (code === "too_big") return "unfit";
    if (code === "changed") return "not_allowed";

    if (code === "paused") return !presenceAway() && entry.pausedUses.has(use.name) ? "unavailable" : null;

    if (code === "busy") return cause === "host" ? "unavailable" : null;
    if (code === "not_allowed") {
      if (cause === "host") return "setup_blocked";
      if (keptOff(entry, use)) return "kept_off";
      if (entry.removed) return "not_allowed";
      const bad = badCheckOf(entry, use, write);
      return bad ? whyOfCheck(bad) : "not_allowed";
    }
    if (code === "off") {
      if (cause === "host") return "unavailable";
      if (cause === "switched" || !isArmed()) return "setup_blocked";
      if (entry.invalid) return null;
      if (write && listing.ok && (writesCapable() !== true || listing.writes !== true)) return "setup_blocked";
      const bad = badCheckOf(entry, use, write);
      return bad ? whyOfCheck(bad) : "unavailable";
    }
    if (code === "failed") {
      if (cause === "parse") return null;
      if (cause === "host" || cause === "value") return "other";
      const bad = badCheckOf(entry, use, write);
      return bad ? whyOfCheck(bad) : "other";
    }
    return null;
  }

  const health = new Map();

  function healthOf(key        , use        ) {
    const id = `${key}\n${use}`;
    let row = health.get(id);
    if (!row) {
      row = { okAtMs: 0, streak: 0, sinceMs: 0 };
      health.set(id, row);
      while (health.size > limits.healthKept) health.delete(health.keys().next().value);
    }
    return row;
  }

  function noteHealth(key        , use        , ok         , why               ) {
    const row = healthOf(key, use);
    if (ok) {
      row.okAtMs = now();
      row.streak = 0;
      row.sinceMs = 0;
    } else if (why && PROGRAM_CARD_MCP_TEMPORARY_WHYS.includes(why)) {
      if (!row.streak) row.sinceMs = now();
      row.streak += 1;
    } else if (why) {
      row.streak = 0;
      row.sinceMs = 0;
    }
    return row;
  }

  function sendResult(sub        , call     , result     , ctx      = null) {
    const frame      = { type: PROGRAM_CARD_MCP_DATA_FRAME, sub, kind: "result", id: call.id, mcp: call.mcp, ok: result.ok === true };
    const known = !!(ctx && ctx.entry && ctx.use);
    if (frame.ok) {
      frame.value = result.value;
      frame.at = now();
      if (known) noteHealth(ctx.entry.key, ctx.use.name, true, null);
    } else {
      frame.code = result.code;
      const why = whyOf(ctx, result.code);
      if (known) {
        const row = noteHealth(ctx.entry.key, ctx.use.name, false, why);
        if (why) {
          frame.why = why;
          frame.title = ctx.use.title;
          if (row.okAtMs) frame.lastAtMs = row.okAtMs;
          if (row.streak >= 3 && now() - row.sinceMs >= 3_600_000) frame.still = true;
        }
      }
    }
    sendFrame(frame);
  }

  const isLive = (entry     ) => !entry.closed && subs.get(entry.sub) === entry && now() <= entry.leaseUntil;

  function answer(job     , code        , cause                = null) {
    if (isLive(job.entry)) sendResult(job.entry.sub, job.call, { ok: false, code }, { entry: job.entry, use: job.use, write: job.write === true, cause });
  }

  function toolInfo(use     ) {
    const tool = toolOf(listing, use.server, use.tool);
    return tool ? tool.description : "";
  }

  function useHealth(entry     , key        , use     , last     ) {
    const write = use.kind === "write";
    if (!cardServers.has(use.server)) return { reason: "server_off_for_cards" };
    const server = listing.servers.get(use.server);
    if (!server) return { reason: "server_missing" };
    if (server.granted === false) return { reason: "host_not_granted" };
    const tool = server.tools.get(use.tool);

    const hides = server.reason === "host_blocked" && server.writes !== false;
    if (server.connected !== true && !hides) return { reason: "server_not_connected" };
    if ((!tool && hides) || (write && server.writes === false)) return { reason: "host_blocked", fix: fixFor(use.server, server) };
    if (!tool) return { reason: "tool_missing" };

    if (write) return sendHealth(entry, key, use);

    const status = useStatus(key, use, listedToolDigest(use));
    if (status === "denied") return { reason: "kept_off" };
    if (!checkProgramCardMcpUses([use], listing, usableServers(), writeToolsMap()).ok) return { reason: "unfit" };
    if (status === "changed") return { reason: "tool_changed" };
    if (status === "waiting") return { reason: "waiting" };
    if (entry && entry.pausedUses.has(use.name)) return { reason: "paused_slow" };

    const limitedAt = limited.get(`${key}\n${use.name}`) || 0;
    if (limitedAt && (!last || limitedAt >= last.atMs)) return { reason: "call_limit", atMs: limitedAt };
    if (last && HEALTH_CALL_CODES.has(last.outcome)) return { reason: `call_${last.outcome}`, atMs: last.atMs };
    return null;
  }

  function sendHealth(entry     , key        , use     ) {
    if (writesCapable() !== true) return { part: "send", reason: "no_prompt" };
    if (listing.ok && listing.writes !== true) return { part: "send", reason: "host_cannot_send" };
    const grant = grantFor(key, use.name);
    if (isKept(key, use.server, use.tool) || (grant && grant.status === "denied" && grant.useDigest === programCardMcpUseDigest(use))) return { part: "send", reason: "kept_off" };
    if (!grant || grant.useDigest !== programCardMcpUseDigest(use)) return { part: "send", reason: "not_granted" };
    if (grant.status === "waiting") return { part: "send", reason: "waiting" };
    if (grant.status === "paused") return { part: "send", reason: "tool_changed" };
    if (grant.status !== "allowed") return { part: "send", reason: "not_granted" };
    const check      = checkWrite(use);
    if (check.state === "ok" && check.toolDigest !== grant.toolDigest) return { part: "send", reason: "tool_changed" };
    if (entry && entry.pausedUses.has(use.name)) return { reason: "paused_slow" };
    if (writeCapped(key)) return { part: "send", reason: "send_limit" };
    return null;
  }

  function cardHealth(key     , declared      = null) {
    if (!validKey(key)) return [];
    const entry      = [...subs.values()].find((e     ) => e.key === key && isLive(e));
    if (entry && entry.invalid) return [{ part: "mcp", use: "", reason: "invalid" }];
    const record = records.get(key);

    const named = !entry && !record && declared ? parseProgramCardMcpUses(declared) : null;
    const uses        = entry ? entry.uses : record ? record.uses : named && named.ok ? named.uses : [];
    if (!uses.length) return [];
    const all = (reason        ) => uses.map((use     ) => ({ part: "mcp", use: use.name, server: use.server, reason }));
    if (!enabled) return all("switch_off");
    if (host === null) return all("host_unsupported");
    if (entry && entry.removed) return all("removed");

    if (now() - listing.atMs >= limits.listTtlMs) void loadListing(false);
    if (!listing.atMs) return [];
    if (!listing.ok) return all(listing.reason === "unsupported" ? "host_unsupported" : "tools_unlisted");
    const last = lastCalls.get(key);
    const out        = [];
    for (const use of uses) {
      const found = useHealth(entry, key, use, last ? last.get(use.name) : null);
      if (found) out.push({ part: "mcp", use: use.name, server: use.server, ...found });
    }
    return out;
  }

  function healthJudges(key     ) {
    if (!validKey(key)) return "no_record";
    const entry      = [...subs.values()].find((e     ) => e.key === key && isLive(e));
    if (entry && entry.invalid) return "yes";
    const record = records.get(key);
    const uses        = entry ? entry.uses : record ? record.uses : [];
    if (!uses.length) return "no_record";
    return enabled && host !== null && !(entry && entry.removed) && !listing.atMs ? "not_ready" : "yes";
  }

  function hostHealth() {
    if (!enabled) return "switch_off";
    if (host === null) return "host_unsupported";
    if (!listing.atMs || listing.ok) return "";
    if (listing.reason === "unsupported") return "host_unsupported";
    return now() - listing.atMs < limits.listTtlMs ? "tools_unlisted" : "";
  }

  function hostHealthKnown() {
    if (!enabled || host === null) return true;
    if (!listing.atMs) return false;
    return listing.ok || listing.reason === "unsupported" || now() - listing.atMs < limits.listTtlMs;
  }

  function stateFrame() {

    for (const key of [...grants.keys()]) autoLive(key);
    const servers        = [];
    for (const [name, server] of listing.servers) {
      let reads = 0;
      let writes = 0;
      for (const [toolName, tool] of server.tools) {
        if (isReadTool(name, toolName, tool)) reads += 1;
        else writes += 1;
      }

      const readTools = [...server.tools.entries()]
        .filter(([, tool]     ) => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true)
        .map(([toolName]     ) => toolName)
        .sort()
        .slice(0, limits.maxToolsPerServer);
      servers.push({
        name, cards: cardServers.has(name) && server.granted !== false, connected: server.connected === true, reads, writes,
        ...settingsOf(name), readTools, ...(server.reason ? { reason: server.reason, fix: fixFor(name, server) } : {}),
      });
    }

    for (const name of cardServers) {
      if (!listing.servers.has(name)) servers.push({ name, cards: true, connected: false, reads: 0, writes: 0, ...settingsOf(name), readTools: [] });
    }
    servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const cards = [...records.values()]
      .sort((a     , b     ) => b.atMs - a.atMs)
      .map((r     ) => {
        const last = lastCalls.get(r.key);
        const checked = r.uses.every((use     ) => toolOf(listing, use.server, use.tool));

        const useStatuses = r.uses.map((use     ) => useStatus(r.key, use, listedToolDigest(use)));
        return {
          key: r.key,
          appId: r.appId,
          name: r.name,
          status: cardStatus(useStatuses),
          digest: r.digest,
          uses: r.uses.map((use     , i        ) => ({ ...JSON.parse(JSON.stringify(use)), toolDescription: toolInfo(use), status: useStatuses[i] })),
          last: last ? [...last.values()].map((l     ) => ({ ...l })) : [],
          checkedAtMs: checked ? listing.atMs : 0,
          atMs: r.atMs,
        };
      });
    return {
      type: PROGRAM_CARD_MCP_STATE_FRAME,
      armed: isArmed() && listing.ok === true,
      enabled,
      host: hostKind,
      available: host !== null && listing.ok === true,
      reason: host === null ? "unsupported" : listing.ok ? listing.reason : listing.atMs ? listing.reason || "failed" : null,
      servers,
      cards,

      writes: [...grants.entries()]
        .map(([key, byUse]     ) => {
          const list = [...byUse.values()];
          return {
            key, appId: appIdOf(key), name: list[0] ? list[0].card : "Card",
            atMs: Math.max(0, ...list.map((g     ) => g.atMs)),

            auto: list.some((g     ) => !!g.auto),
            autoOff: (list.find((g     ) => g.autoOff) || { autoOff: null }).autoOff,
            canAuto: canAuto(key),
            risk: list.some((g     ) => settingsOf(g.spec.server).risk === "high") ? "high" : "normal",
            uses: list.map((g     ) => ({
              ...JSON.parse(JSON.stringify(g.spec)), status: g.status, keptOff: isKept(key, g.spec.server, g.spec.tool), auto: g.auto ? { ...g.auto } : null,

              history: g.sends.map((s     ) => ({ ...s })), atMs: g.atMs, toolDescription: toolInfo(g.spec),
            })),
          };
        })
        .sort((a     , b     ) => b.atMs - a.atMs),

      requests: [...writeRequests.values()].filter((r     ) => !r.settled).map((r     ) => ({
        id: r.id, key: r.key, name: r.name, uses: r.uses.map((u     ) => JSON.parse(JSON.stringify(u))), expiresAtMs: r.expiresAtMs,
      })),

      ...(hostCommands ? { hostCommands: hostCommands.state() } : {}),
    };
  }

  function settingsOf(server        ) {
    const s = serverSettings.get(server);
    return { risk: s ? s.risk : "normal", autoSend: s ? s.autoSend : false, writeTools: s ? [...s.writeTools].sort() : [] };
  }

  function ownerWrite(server        , tool        ) {
    const s = serverSettings.get(server);
    return !!s && s.writeTools.has(tool);
  }

  function isReadTool(server        , toolName        , tool     ) {
    return tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true && !ownerWrite(server, toolName);
  }

  function writeToolsMap() {
    const out = new Map                     ();
    for (const [name, s] of serverSettings) if (s.writeTools.size) out.set(name, s.writeTools);
    return out;
  }

  const sendState = () => {
    lastStateAt = now();
    sendFrame(stateFrame());
  };

  function persist() {
    if (!store || typeof store.write !== "function") return;
    try {
      store.write({
        servers: [...cardServers],
        cards: [...records.values()].filter((r     ) => r.appId),
        kept: [...kept.values()].filter((k     ) => appIdOf(k.key)),
      });
    } catch (err     ) {
      emit("program_card_mcp_store_failed", "warn", { op: "write", code: errorCode(err) });
    }
  }

  function capRecords() {
    for (const saved of [true, false]) {
      const list = [...records.values()].filter((r     ) => !!r.appId === saved);
      if (list.length <= limits.maxRecords) continue;
      list.sort((a     , b     ) => a.atMs - b.atMs);
      for (const r of list.slice(0, list.length - limits.maxRecords)) {
        records.delete(r.key);
        lastCalls.delete(r.key);
      }
    }
  }

  function putRecord(key        , fields     ) {
    const was = records.get(key);
    const reads = Array.isArray(fields.reads) ? fields.reads : was ? was.reads : [];
    const record = {
      key, appId: appIdOf(key), name: fields.name, digest: programCardMcpDigest(fields.uses), uses: fields.uses,
      reads: reads.slice(0, limits.readsKept), atMs: now(),
    };
    records.delete(key);
    records.set(key, record);
    capRecords();
    if (record.appId) persist();
    return record;
  }

  function readOf(key        , use     ) {
    const record = records.get(key);
    if (!record || !readAskFits(record.name, record.uses, limits.requestQuestionMax)) return null;
    const reach = programCardMcpReachDigest(use);
    return record.reads.find((r     ) => r.reach === reach) || null;
  }

  function noteReads(key        , name        , block       , answers       ) {
    const was = records.get(key);
    let reads        = was ? was.reads.slice() : [];
    for (const answer of answers) {
      const reach = programCardMcpReachDigest(answer.use);
      if (answer.status === "waiting" && reads.some((r     ) => r.reach === reach)) continue;
      reads = reads.filter((r     ) => r.reach !== reach);
      reads.unshift({
        reach, server: answer.use.server, tool: answer.use.tool, status: answer.status,
        toolDigest: answer.status === "allowed" ? answer.toolDigest : "", atMs: now(),
      });
    }
    return putRecord(key, { name, uses: block, reads });
  }

  const isKept = (key        , server        , tool        ) => kept.has(keptId(key, server, tool));

  function setKept(key        , server        , tool        , on         ) {
    const id = keptId(key, server, tool);
    let changed = false;
    if (on) {
      if (!kept.has(id)) changed = true;
      kept.delete(id);
      kept.set(id, { key, server, tool, atMs: now() });
      const record = records.get(key);
      if (record) {
        const reads = record.reads.filter((r     ) => r.server !== server || r.tool !== tool);
        if (reads.length !== record.reads.length) changed = true;
        record.reads = reads;
      }
      for (const saved of [true, false]) {
        const list = [...kept.values()].filter((k     ) => !!appIdOf(k.key) === saved);
        if (list.length <= limits.maxKept) continue;
        list.sort((a     , b     ) => a.atMs - b.atMs);
        for (const old of list.slice(0, list.length - limits.maxKept)) kept.delete(keptId(old.key, old.server, old.tool));
      }
    } else if (kept.delete(id)) changed = true;
    if (!changed) return false;
    emit("program_card_mcp_kept_off", "info", { card: cardHash(key), on, server, tool });
    if (appIdOf(key)) persist();
    return true;
  }

  function dropKept(key        , tools                     = null) {
    let dropped = false;
    for (const [id, no] of [...kept.entries()]) {
      if (no.key !== key || (tools && !tools.has(`${no.server}\n${no.tool}`))) continue;
      kept.delete(id);
      dropped = true;
    }
    return dropped;
  }

  function listedToolDigest(use     ) {
    return toolOf(listing, use.server, use.tool) ? programCardMcpToolDigest([use], listing) : null;
  }

  function useStatus(key        , use     , toolDigest               ) {
    if (isKept(key, use.server, use.tool)) return "denied";
    const read = readOf(key, use);
    if (!read || read.status !== "allowed") return "waiting";
    if (toolDigest && read.toolDigest !== toolDigest) return "changed";
    return "allowed";
  }

  function cardStatus(statuses          ) {
    if (statuses.some((s) => s === "waiting" || s === "changed")) return "waiting";
    if (statuses.length && statuses.every((s) => s === "allowed")) return "allowed";
    return "denied";
  }

  function persistWrites() {
    if (!writesStore || typeof writesStore.write !== "function") return;
    const servers      = {};
    for (const [name, s] of serverSettings) servers[name] = { risk: s.risk, autoSend: s.autoSend, writeTools: [...s.writeTools] };
    const list        = [];
    for (const byUse of grants.values()) for (const g of byUse.values()) if (appIdOf(g.key)) list.push(g);
    try {
      writesStore.write({ servers, grants: list });
    } catch (err     ) {
      emit("program_card_mcp_store_failed", "warn", { op: "write_writes", code: errorCode(err) });
    }
  }

  function grantFor(key        , use        ) {
    const byUse = grants.get(key);
    return byUse ? byUse.get(use) || null : null;
  }

  function putGrant(key        , fields     ) {
    const grant = {
      key, use: fields.spec.name, useDigest: programCardMcpUseDigest(fields.spec), toolDigest: fields.toolDigest,
      status: fields.status, card: cardName(fields.card), spec: fields.spec, auto: null,
      sends: Array.isArray(fields.sends) ? fields.sends.slice(-limits.sendsKept) : [], atMs: now(),
    };
    if (!grants.has(key)) grants.set(key, new Map());
    grants.get(key).set(grant.use, grant);

    for (const saved of [true, false]) {
      const all        = [];
      for (const byUse of grants.values()) for (const g of byUse.values()) if (!!appIdOf(g.key) === saved) all.push(g);
      if (all.length <= limits.maxWriteGrants) continue;
      all.sort((a, b) => a.atMs - b.atMs);
      for (const old of all.slice(0, all.length - limits.maxWriteGrants)) dropGrant(old.key, old.use);
    }
    if (appIdOf(key)) persistWrites();
    return grant;
  }

  function dropGrant(key        , use        ) {
    const byUse = grants.get(key);
    if (!byUse) return;
    byUse.delete(use);
    if (!byUse.size) grants.delete(key);
  }

  function noteSend(job     , via        , outcome        ) {
    const grant = grantFor(job.key, job.use.name);
    if (!grant) return;
    grant.sends.push({ atMs: now(), via, outcome, values: sendValues(job.use, job.call.args).join(", ") });
    if (grant.sends.length > limits.sendsKept) grant.sends.splice(0, grant.sends.length - limits.sendsKept);
    if (appIdOf(job.key)) persistWrites();
  }

  const writesOn = () => isArmed() && writesCapable() === true && listing.ok === true && listing.writes === true;

  function canAuto(key        ) {
    const byUse = grants.get(key);
    if (!appIdOf(key) || !byUse) return false;
    const allowed = [...byUse.values()].filter((g     ) => g.status === "allowed");
    return allowed.length > 0 && allowed.every((g     ) => {
      const s = settingsOf(g.spec.server);
      return cardServers.has(g.spec.server) && (s.risk !== "high" || s.autoSend);
    });
  }

  function autoOff(key        , why               ) {
    const byUse = grants.get(key);
    if (!byUse || ![...byUse.values()].some((g     ) => g.auto)) return;
    for (const g of byUse.values()) {
      g.auto = null;
      g.autoOff = why;
    }
    autoTimes.delete(key);
    if (appIdOf(key)) persistWrites();
    emit("program_card_mcp_auto", "info", { card: cardHash(key), on: false, reason: why || "off" });
  }

  function autoLive(key        ) {
    const byUse = grants.get(key);
    const on = byUse ? [...byUse.values()].filter((g     ) => g.auto) : [];
    if (!on.length) return false;
    const rev = sourceRev(key);
    if (!rev || on.some((g     ) => g.auto.sourceRev !== rev)) {
      autoOff(key, "changed");
      return false;
    }
    if (!isArmed() || !canAuto(key)) {
      autoOff(key, null);
      return false;
    }
    return true;
  }

  function autoWindow(key        ) {
    const since = now() - 3_600_000;
    const times = (autoTimes.get(key) || []).filter((at        ) => at > since);
    if (times.length) autoTimes.set(key, times);
    else autoTimes.delete(key);
    return times;
  }

  function autoTripped(key        ) {
    const times = autoWindow(key);
    if (times.filter((at        ) => at > now() - 60_000).length >= limits.autoPerMinute) return "breaker_minute";
    if (times.length >= limits.autoPerHour) return "breaker_hour";
    return null;
  }

  function setAuto(msg     ) {
    const key = typeof msg.key === "string" && appIdOf(msg.key) ? msg.key : null;
    if (!key || typeof msg.on !== "boolean" || (msg.on && msg.warned !== true)) {
      emit("program_card_mcp_dropped", "debug", { op: "auto", reason: "bad_frame" });
      return;
    }
    const byUse = grants.get(key);
    if (!msg.on) {
      if (byUse) for (const g of byUse.values()) g.autoOff = null;
      autoOff(key, null);
      if (byUse && appIdOf(key)) persistWrites();
      sendState();
      return;
    }
    const rev = sourceRev(key);
    if (!isArmed() || !canAuto(key) || !rev) {
      emit("program_card_mcp_dropped", "debug", { op: "auto", reason: "not_allowed" });
      sendState();
      return;
    }
    for (const g of byUse.values()) {
      g.auto = g.status === "allowed" ? { atMs: now(), sourceRev: rev } : null;
      g.autoOff = null;
    }
    autoTimes.delete(key);
    persistWrites();
    emit("program_card_mcp_auto", "info", { card: cardHash(key), on: true });
    sendState();
  }

  function sessionGrantsOf(sessionKey     ) {
    const id = typeof sessionKey === "string" && sessionKey ? sessionKey : "";
    const held = sessionGrants.get(id);
    if (!held) return null;
    for (const [use, entry] of [...held.entries()]) if (now() > entry.untilMs) held.delete(use);
    if (!held.size) {
      sessionGrants.delete(id);
      return null;
    }
    return held;
  }

  function holdForSession(sessionKey     , key               , grant     ) {
    const id = typeof sessionKey === "string" && sessionKey ? sessionKey : "";
    if (!id) return;
    if (!sessionGrants.has(id)) sessionGrants.set(id, new Map());
    sessionGrants.get(id).set(grant.use, { grant, key, untilMs: now() + limits.newGrantMs });

    while (sessionGrants.size > limits.maxSubscriptions * 4) sessionGrants.delete(sessionGrants.keys().next().value);
  }

  function checkWrite(use     ) {
    if (!listing.atMs) return { state: "pending" };
    if (!listing.ok) return { state: "bad", code: "off" };
    const checked      = checkProgramCardMcpUses([use], listing, usableServers());

    if (!checked.ok) return { state: "bad", code: checked.code === "off" ? "off" : "not_allowed", cause: checked.code, error: checked.error, reason: checked.reason, fix: checked.fix };
    return { state: "ok", toolDigest: checked.toolDigest };
  }

  function loadListing(force         )               {
    if (!host) return Promise.resolve(listing);
    if (!force && listing.atMs && now() - listing.atMs < limits.listTtlMs) return Promise.resolve(listing);
    if (listingPromise) return listingPromise;
    const gen = generation;
    const startedAt = now();
    let call              ;
    try {

      call = Promise.resolve(host.list({ servers: isArmed() ? [...cardServers] : [], ...(force ? { fresh: true } : {}) }));
    } catch (_) {
      call = Promise.resolve(null);
    }
    listingPromise = withTimeout(call, limits.listTimeoutMs, setTimeoutFn, clearTimeoutFn, { ok: false, reason: "failed" }).then((raw     ) => {
      listingPromise = null;
      if (gen !== generation) return listing;
      const before = listingSignature(listing);
      listing = parseProgramCardMcpListing(raw, now());
      emit("program_card_mcp_listed", "debug", {
        outcome: listing.ok ? "ok" : listing.reason,
        servers: listing.servers.size,
        ms: Math.max(0, Math.round(now() - startedAt)),
      });
      if (listingSignature(listing) !== before) {
        recheckAll();
        sendState();
      }
      return listing;
    });
    return listingPromise;
  }

  function listingSignature(value     ) {
    const servers        = [];
    for (const [name, server] of value.servers) {
      servers.push([name, server.connected, server.granted, server.reason, server.fix, server.writes, [...server.tools.entries()].map(([tool, info]     ) => [tool, info.inputSchema, info.annotations])]);
    }
    return canonicalSerialize({ ok: value.ok, reason: value.reason, writes: value.writes === true, servers });
  }

  function checkEntry(entry     ) {
    if (entry.invalid) return;
    entry.writeChecks = new Map(entry.writeUses.map((use     ) => [use.name, checkWrite(use)]));
    if (!listing.atMs) {
      entry.check = { state: "pending" };
      return;
    }
    if (!listing.ok) {
      entry.check = { state: "bad", code: "off", cause: "listing" };
      return;
    }
    if (!entry.readUses.length) {
      entry.check = { state: "ok", toolDigest: "", tools: new Map(), uses: new Map() };
      return;
    }

    const uses = new Map             ();
    const tools = new Map                ();
    for (const use of entry.readUses) {
      const checked      = checkProgramCardMcpUses([use], listing, usableServers(), writeToolsMap());
      if (checked.ok) {
        uses.set(use.name, { ok: true });
        tools.set(use.name, checked.toolDigest);
      } else uses.set(use.name, { ok: false, code: checked.code, reason: checked.reason || null });
    }
    const bad = [...uses.values()].filter((u     ) => !u.ok);
    entry.check = bad.length === entry.readUses.length
      ? { state: "bad", code: bad[0].code, reason: bad[0].reason, uses, tools }
      : { state: "ok", toolDigest: programCardMcpToolDigest(entry.readUses, listing), uses, tools };
  }

  function useCheck(entry     , use     ) {
    return entry.check && entry.check.uses ? entry.check.uses.get(use.name) || null : null;
  }

  function entryUseStatus(entry     , use     ) {
    const toolDigest = entry.check.state === "ok" && entry.check.tools ? entry.check.tools.get(use.name) || null : null;
    return useStatus(entry.key, use, toolDigest);
  }

  function usableServers() {
    const out = new Set        ();
    for (const name of cardServers) {
      const server = listing.servers.get(name);
      if (!server || server.granted !== false) out.add(name);
    }
    return out;
  }

  function statusOf(entry     ) {
    const reads = readStatusOf(entry);
    return reads === "on" && entry.writeUses.length && !writesOn() ? "reads_only" : reads;
  }

  function readStatusOf(entry     ) {
    if (!isArmed() || entry.invalid || entry.removed) return "off";
    if (entry.check.state === "bad") return "off";
    if (!entry.readUses.length) return "on";

    const statuses = entry.readUses.filter((use     ) => useCheck(entry, use)?.ok !== false)
      .map((use     ) => entryUseStatus(entry, use));
    if (statuses.every((s        ) => s === "denied")) return "off";
    if (statuses.some((s        ) => s === "waiting" || s === "changed")) return "waiting";
    return "on";
  }

  function keptOff(entry     , use     ) {
    return !!use && isKept(entry.key, use.server, use.tool);
  }

  function refusal(entry     , use      = null) {
    if (!isArmed() || entry.invalid) return "off";
    if (entry.removed) return "not_allowed";
    if (!entry.readUses.length) return null;
    if (use ? keptOff(entry, use) : entry.readUses.every((u     ) => keptOff(entry, u))) return "not_allowed";

    const own = use ? useCheck(entry, use) : null;
    if (own && !own.ok) return own.code || "off";
    if (entry.check.state === "bad") return entry.check.code || "off";
    if (presenceAway()) return "paused";
    if (use && entry.pausedUses.has(use.name)) return "paused";
    if (entry.check.state === "pending") return "hold";
    if (!use) return null;
    const status = entryUseStatus(entry, use);
    if (status === "changed") return "changed";
    return status === "allowed" ? null : "hold";
  }

  function writeRefusal(entry     , use     , from        , sending = false) {
    if (!writesOn() || entry.invalid) return "off";
    if (entry.removed) return "not_allowed";
    const check = entry.writeChecks.get(use.name) || { state: "pending" };
    if (check.state === "pending") return "busy";
    if (check.state === "bad") return check.code === "off" ? "off" : "not_allowed";
    if (keptOff(entry, use)) return "not_allowed";
    const grant = grantFor(entry.key, use.name);
    if (!grant || grant.useDigest !== programCardMcpUseDigest(use) || grant.status === "denied" || grant.status === "waiting") return "not_allowed";
    if (grant.status === "paused" || grant.toolDigest !== check.toolDigest) return "changed";
    if (!sending && !PROGRAM_CARD_MCP_GESTURES.includes(from)) return "no_gesture";
    if (presenceAway()) return "paused";
    if (entry.pausedUses.has(use.name)) return "paused";
    if (writeCapped(entry.key)) return "limit";

    if (!sending && (restUntil.get(use.server) || 0) > now()) return "busy";
    if (!sending && confirms.has(entry.key)) return "busy";
    return null;
  }

  function clearRefresh(entry     , name                = null) {
    for (const [useName, refresh] of [...entry.refresh.entries()]) {
      if (name !== null && useName !== name) continue;
      if (refresh.timer) clearTimeoutFn(refresh.timer);
      entry.refresh.delete(useName);
    }
  }

  function dropSub(entry     , reason        ) {

    const prompt = confirms.get(entry.key);
    if (prompt && prompt.entry === entry) closeConfirm(entry.key, "declined", "declined");
    entry.closed = true;
    entry.held = [];
    clearRefresh(entry);
    if (subs.get(entry.sub) === entry) subs.delete(entry.sub);
    for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i].entry === entry) queue.splice(i, 1);
    emit("program_card_mcp_closed", "debug", { card: cardHash(entry.key), reason });
  }

  function expireSubs() {
    for (const entry of [...subs.values()]) if (now() > entry.leaseUntil) dropSub(entry, "lease_expired");
  }

  function noteLimited(job     ) {
    if (job.write) return;
    const id = `${job.key}\n${job.use.name}`;
    limited.delete(id);
    limited.set(id, now());
    while (limited.size > 256) limited.delete(limited.keys().next().value );
  }

  function enqueue(job     ) {
    if (queue.length >= limits.maxQueued) {
      noteLimited(job);
      answer(job, "limit");
    } else queue.push(job);
  }

  function ownCode(entry     , job     , code        ) {
    const own = refusal(entry, job.use);
    return own && own !== "hold" && own !== "paused" ? own : code;
  }

  function flushHeld(entry     , code        ) {
    const held = entry.held;
    entry.held = [];
    for (const job of held) answer(job, ownCode(entry, job, code));
    if (held.length) emit("program_card_mcp_held_answered", "debug", { card: cardHash(entry.key), outcome: code, count: held.length });
  }

  function releaseHeld(entry     ) {
    const held = entry.held;
    entry.held = [];
    for (const job of held) {
      const code = refusal(entry, job.use);
      if (code === "hold") entry.held.push(job);
      else if (code) answer(job, code);
      else enqueue(job);
    }
  }

  function refreshEntry(entry     ) {
    if (now() > entry.leaseUntil) {
      dropSub(entry, "lease_expired");
      return;
    }
    const status = statusOf(entry);
    if (status !== entry.status) {
      entry.status = status;
      sendStatus(entry);
    }
    const code = refusal(entry);
    const stop = (useName               , why        ) => {

      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i].entry !== entry || queue[i].write || (useName !== null && queue[i].use.name !== useName)) continue;
        const [job] = queue.splice(i, 1);
        answer(job, useName === null ? ownCode(entry, job, why) : why);
      }
      clearRefresh(entry, useName);
    };
    let changed = false;
    if (code === null) {
      releaseHeld(entry);

      for (const use of entry.readUses) {
        const own = refusal(entry, use);
        if (own === "changed") changed = true;
        if (own !== null && own !== "hold" && own !== "paused") stop(use.name, own);
      }
    } else if (code !== "hold" && code !== "paused") {
      flushHeld(entry, code);
      stop(null, code);
    }
    refreshWrites(entry);

    if (changed && !entry.reasked) {
      entry.reasked = true;
      void consider({ sessionKey: null, key: entry.key, name: entry.name, uses: entry.uses, cause: "changed" });
    }
  }

  function refreshWrites(entry     ) {
    for (const use of entry.writeUses) {
      const check = entry.writeChecks.get(use.name);
      const grant = grantFor(entry.key, use.name);
      if (grant && grant.status === "allowed" && check && check.state === "ok" && grant.toolDigest !== check.toolDigest) {
        grant.status = "paused";
        grant.auto = null;
        grant.atMs = now();
        if (appIdOf(entry.key)) persistWrites();
        emit("program_card_mcp_write_paused", "info", { card: cardHash(entry.key), use: use.name, reason: "tool_changed" });
        sendState();
      }
      const code = writeRefusal(entry, use, "", true);
      if (code === null || code === "limit" || code === "paused" || code === "busy") continue;
      const open = confirms.get(entry.key);
      if (open && open.entry === entry && open.job.use.name === use.name) closeConfirm(entry.key, "refused", code);
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i].entry !== entry || !queue[i].write || queue[i].use.name !== use.name) continue;
        const [job] = queue.splice(i, 1);
        answer(job, code);
      }
    }
  }

  function writeWindow(key        ) {
    const since = now() - 3_600_000;
    const times = (writeTimes.get(key) || []).filter((at        ) => at > since);
    if (times.length) writeTimes.set(key, times);
    else writeTimes.delete(key);
    return times;
  }

  function writeDayCount() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (writeDay.day !== day) writeDay = { day, count: 0 };
    return writeDay.count;
  }

  function writeCapped(key        ) {
    const times = writeWindow(key);
    const minute = times.filter((at        ) => at > now() - 60_000).length;
    return minute >= limits.writesPerCardPerMinute || times.length >= limits.writesPerCardPerHour || writeDayCount() >= limits.writesPerHostPerDay;
  }

  function noteWriteStart(key        ) {
    writeTimes.set(key, [...writeWindow(key), now()]);
    writeDayCount();
    writeDay.count += 1;
  }

  function callWrite(entry     , job     , from        , reply                        ) {
    const id = job.call.id;

    if (entry.writeIds.has(id)) return;
    entry.writeIds.add(id);
    if (entry.writeIds.size > limits.writeIdsKept) entry.writeIds.delete(entry.writeIds.values().next().value);

    const wearer = from !== "remote" && PROGRAM_CARD_MCP_GESTURES.includes(from);
    const grant = grantFor(entry.key, job.use.name);
    const hadAuto = wearer && !!grant && !!grant.auto;
    let auto = hadAuto && autoLive(entry.key);

    const tripped = auto ? autoTripped(entry.key) : null;
    if (tripped) autoOff(entry.key, tripped);
    if (tripped) auto = false;

    if (hadAuto && !auto) sendState();
    const code = writeRefusal(entry, job.use, from);
    if (code) {
      emit("program_card_mcp_write", "debug", { card: cardHash(entry.key), use: job.use.name, outcome: code, from });
      return reply(code);
    }
    if (auto) {
      autoTimes.set(entry.key, [...autoWindow(entry.key), now()]);
      emit("program_card_mcp_write", "debug", { card: cardHash(entry.key), use: job.use.name, outcome: "auto", from });

      queue.unshift({ ...job, write: true, from, via: "auto", auto: true });
      pump();
      return;
    }
    const values = sendValues(job.use, job.call.args);
    const expiresAtMs = now() + limits.confirmWaitMs;
    const prompt      = { entry, job: { ...job, write: true, from }, id, expiresAtMs, timer: null };
    prompt.timer = timer(() => {
      prompt.timer = null;
      if (confirms.get(entry.key) === prompt) closeConfirm(entry.key, "timeout", "declined");
    }, limits.confirmWaitMs);
    confirms.set(entry.key, prompt);
    emit("program_card_mcp_write", "debug", { card: cardHash(entry.key), use: job.use.name, outcome: "prompt", from });

    sendFrame({
      type: PROGRAM_CARD_MCP_DATA_FRAME, sub: entry.sub, kind: "confirm", id, name: entry.name, mcp: job.use.name,
      title: job.use.title, server: job.use.server, tool: job.use.tool, values,
      args: { ...job.use.args, ...job.call.args },
      label: job.call.label || null, deadlineSec: Math.ceil(limits.confirmWaitMs / 1000), expiresAtMs,

      ...(grant && grant.autoOff === "breaker_minute" ? { paused: "minute" } : grant && grant.autoOff === "breaker_hour" ? { paused: "hour" } : {}),
    });
  }

  function closeConfirm(key        , outcome        , code               ) {
    const prompt = confirms.get(key);
    if (!prompt) return;
    confirms.delete(key);
    if (prompt.timer) clearTimeoutFn(prompt.timer);
    prompt.timer = null;
    if (code) answer(prompt.job, code);

    if (outcome === "declined" || outcome === "timeout") noteSend(prompt.job, prompt.via || "glasses", outcome);
    sendFrame({ type: PROGRAM_CARD_MCP_DATA_FRAME, sub: prompt.entry.sub, kind: "confirm_done", id: prompt.id, outcome });
    emit("program_card_mcp_write", "debug", { card: cardHash(key), use: prompt.job.use.name, outcome });
  }

  function confirm(msg     ) {
    const entry = typeof msg.sub === "string" ? subs.get(msg.sub) : null;
    const prompt = entry ? confirms.get(entry.key) : null;
    if (!entry || !prompt || prompt.entry !== entry || prompt.id !== msg.id || typeof msg.send !== "boolean") {
      emit("program_card_mcp_dropped", "debug", { op: "confirm", reason: "no_prompt" });
      return;
    }
    prompt.via = msg.via === "phone" ? "phone" : "glasses";
    if (!msg.send) {
      closeConfirm(entry.key, "declined", "declined");
      return;
    }
    const code = writeRefusal(entry, prompt.job.use, prompt.job.from, true);
    if (code) {
      closeConfirm(entry.key, "refused", code);
      return;
    }
    confirms.delete(entry.key);
    if (prompt.timer) clearTimeoutFn(prompt.timer);
    sendFrame({ type: PROGRAM_CARD_MCP_DATA_FRAME, sub: entry.sub, kind: "confirm_done", id: prompt.id, outcome: "sent" });

    queue.unshift({ ...prompt.job, via: prompt.via });
    pump();
  }

  function parseWriteUses(raw     ) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > limits.maxUses) return fail(`uses lists 1 to ${limits.maxUses} write uses`);
    const uses        = [];
    for (const spec of raw) {
      const parsed = parseUse(spec);
      if (!parsed.ok) return parsed;
      if (parsed.use.kind !== "write") return fail(`use ${parsed.use.name} is not a write: set kind to "write"`);
      if (uses.some((u) => u.name === parsed.use.name)) return fail(`use ${parsed.use.name} is listed twice`);
      uses.push(parsed.use);
    }
    return { ok: true         , uses };
  }

  function pasteable(uses       ) {
    const out      = {};
    for (const use of uses) {
      const { name, ...rest } = use;
      const clean      = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v === null || (isPlainObject(v) && !Object.keys(v       ).length)) continue;
        clean[k] = v;
      }
      out[name] = clean;
    }
    return out;
  }

  async function considerWriteNow(input     )               {
    const parsed = parseWriteUses(input.uses);
    if (!parsed.ok) return { answer: "invalid", error: parsed.error };
    let key                = null;
    if (input.card !== "new") {
      const appId = typeof input.card === "string" ? input.card.replace(/^app:/, "") : "";
      key = validKey(`app:${appId}`);
      if (!key) return { answer: "invalid", error: 'card is "new" or a saved card\'s app id' };
    }
    const uses = parsed.uses;
    if (!isArmed() || writesCapable() !== true) return { answer: "off" };
    await loadListing(true);
    if (!listing.ok || listing.writes !== true) return { answer: "off" };
    const checks        = [];
    for (const use of uses) {
      const check      = checkWrite(use);
      if (check.state !== "ok") {
        if (check.code === "off") return { answer: "off" };
        return { answer: "invalid", error: check.error || "the tool cannot take writes", ...(check.reason ? { reason: check.reason, fix: check.fix } : {}) };
      }
      checks.push(check);
    }
    const existing = key ? grants.get(key) : null;
    const name = key
      ? cardName((existing && existing.size ? [...existing.values()][0].card : null) || (records.get(key) || {}).name || input.name || appIdOf(key))
      : null;
    const fresh = uses.map((use, i) => ({ use, toolDigest: checks[i].toolDigest }));
    const same = (g     , f     ) => g && g.useDigest === programCardMcpUseDigest(f.use) && g.toolDigest === f.toolDigest;
    if (key && fresh.every((f) => { const g = grantFor(key , f.use.name); return same(g, f) && g.status === "allowed"; })) {
      for (const f of fresh) holdForSession(input.sessionKey, key, grantFor(key, f.use.name));
      return { answer: "allowed", uses: pasteable(uses) };
    }
    if (key && fresh.some((f) => { const g = grantFor(key , f.use.name); return same(g, f) && g.status === "denied"; })) return { answer: "declined" };

    if (key && uses.some((use) => isKept(key , use.server, use.tool))) return { answer: "declined" };

    const question = writeRequestQuestion(name, uses);
    const tooLong = refuseTooLong(question, "use fewer or shorter vary.oneOf choices, a shorter sends, or ask for fewer uses at a time");
    if (tooLong) return tooLong;
    const sessionKey = presentSessionKey(input.sessionKey);
    if (!sessionKey) {
      emit("program_card_mcp_write_request_done", "info", { card: key ? cardHash(key) : "new", outcome: "no_answer", reason: "no_session" });
      return { answer: "no_answer" };
    }

    if (key) {
      for (const f of fresh) {
        const g = grantFor(key, f.use.name);
        if (!same(g, f) || g.status !== "allowed") putGrant(key, { spec: f.use, toolDigest: f.toolDigest, status: "waiting", card: name, sends: g ? g.sends : [] });
      }
    }
    return presentWrite({ key, name, uses, fresh, question, sessionKey, agentSession: input.sessionKey });
  }

  function considerWrite(input     )               {
    try {
      return considerWriteNow(input && typeof input === "object" ? input : {}).catch(() => ({ answer: "no_answer" }));
    } catch (_) {
      return Promise.resolve({ answer: "no_answer" });
    }
  }

  function refuseTooLong(question        , fix        ) {
    const length = charCount(question);
    if (length <= limits.requestQuestionMax) return null;
    return { answer: "invalid", error: `the ask would not fit on the glasses (${length} of ${limits.requestQuestionMax} characters): ${fix}` };
  }

  function presentSessionKey(sessionKeyIn     ) {
    if (typeof sessionKeyIn === "string" && sessionKeyIn.trim()) return sessionKeyIn.trim();
    try {
      const active = activeSessionKey();
      return typeof active === "string" && active.trim() ? active.trim() : "";
    } catch (_) {
      return "";
    }
  }

  function presentWrite(req     )               {
    const hash = req.key ? cardHash(req.key) : "new";
    requestSeq += 1;
    const entry      = {
      ...req, id: `w${now().toString(36)}${requestSeq.toString(36)}`, waiters: [], settled: false, timer: null,
      expiresAtMs: now() + limits.requestWaitMs,
    };
    const promise = new Promise((resolve) => entry.waiters.push(resolve));
    writeRequests.set(entry.id, entry);
    emit("program_card_mcp_write_request", "info", { card: hash, uses: req.uses.length });
    sendState();
    let accepted = false;
    try {
      const result = presentDecision({
        surface: {
          surfaceId: (entry.surfaceId = `card-mcp-write:${hash}:${entry.id}`),
          sessionKey: req.sessionKey,
          kind: "permission",
          title: "Let this card send to your tools?",
          question: req.question,
          options: [
            { key: "allow", label: "Allow" },
            { key: "deny", label: "Not now" },
          ],
          deadlineSec: Math.ceil(limits.requestWaitMs / 1000),
        },
        expiresAtMs: entry.expiresAtMs,
        onDecision: (decision     ) => {
          try {
            if (entry.settled) return;
            const choice = decision && decision.choice;
            if (choice === "allow" || choice === "deny") decideWriteRequest(entry, choice === "allow", "glasses");
            else settleWrite(entry, "no_answer", decision && REQUEST_REASONS.has(decision.reason) ? decision.reason : "cancel");
          } catch (_) {
            settleWrite(entry, "no_answer", "cancel");
          }
        },
      });
      accepted = result === true || (!!result && typeof result === "object" && result.presented === true);
    } catch (_) {
      accepted = false;
    }
    if (!accepted) settleWrite(entry, "no_answer", "presentation_failed");
    else if (!entry.settled) {
      entry.timer = timer(() => {
        entry.timer = null;
        settleWrite(entry, "no_answer", "timeout");
      }, limits.requestWaitMs + limits.requestGraceMs);
    }
    return promise;
  }

  function settleWrite(entry     , outcome        , reason        , extra      = {}) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeoutFn(entry.timer);
    entry.timer = null;
    writeRequests.delete(entry.id);
    if (reason === "phone") withdraw(entry.surfaceId);
    emit("program_card_mcp_write_request_done", "info", { card: entry.key ? cardHash(entry.key) : "new", outcome, reason });
    sendState();
    for (const resolve of entry.waiters.splice(0)) resolve({ answer: outcome, ...extra });
  }

  function decideWriteRequest(entry     , allow         , via        ) {
    if (entry.settled) return;
    if (!allow) {

      if (entry.key) for (const f of entry.fresh) {
        putGrant(entry.key, { spec: f.use, toolDigest: f.toolDigest, status: "denied", card: entry.name, sends: (grantFor(entry.key, f.use.name) || {}).sends });
        setKept(entry.key, f.use.server, f.use.tool, true);
      }
      emit("program_card_mcp_write_decided", "info", { card: entry.key ? cardHash(entry.key) : "new", status: "denied", via });
      settleWrite(entry, "declined", via);
      return;
    }
    for (const f of entry.fresh) {
      if (entry.key && isKept(entry.key, f.use.server, f.use.tool)) setKept(entry.key, f.use.server, f.use.tool, false);
      const fields = { spec: f.use, toolDigest: f.toolDigest, status: "allowed", card: entry.name || "Card", sends: entry.key ? (grantFor(entry.key, f.use.name) || {}).sends : [] };

      const grant = entry.key ? putGrant(entry.key, fields) : { ...fields, key: null, use: f.use.name, useDigest: programCardMcpUseDigest(f.use), auto: null, sends: [], atMs: now() };
      holdForSession(entry.agentSession || entry.sessionKey, entry.key, grant);
    }
    emit("program_card_mcp_write_decided", "info", { card: entry.key ? cardHash(entry.key) : "new", status: "allowed", via });
    if (entry.key) refreshKey(entry.key);
    settleWrite(entry, "allowed", via, { uses: pasteable(entry.uses) });
  }

  function decideWrite(msg     ) {
    if (typeof msg.request === "string") {
      const entry = writeRequests.get(msg.request);
      if (!entry || typeof msg.allow !== "boolean") {
        emit("program_card_mcp_dropped", "debug", { op: "decide", reason: "no_request" });
        sendState();
        return;
      }

      void loadListing(false).then(() => {
        if (!msg.allow) return decideWriteRequest(entry, false, "phone");
        const checks = entry.uses.map((use     ) => checkWrite(use));
        if (!writesOn() || checks.some((c     ) => c.state !== "ok")) {
          emit("program_card_mcp_dropped", "debug", { op: "decide", reason: "unfit" });
          sendState();
          return;
        }
        entry.fresh = entry.uses.map((use     , i        ) => ({ use, toolDigest: checks[i].toolDigest }));
        decideWriteRequest(entry, true, "phone");
      });
      return;
    }
    const key = validKey(msg.key);
    const grant = key && typeof msg.use === "string" ? grantFor(key, msg.use) : null;
    if (!grant || typeof msg.allow !== "boolean") {
      emit("program_card_mcp_dropped", "debug", { op: "decide", reason: "no_grant" });
      sendState();
      return;
    }
    void loadListing(false).then(() => {
      const check      = msg.allow ? checkWrite(grant.spec) : null;
      if (msg.allow && (!check || check.state !== "ok")) {
        emit("program_card_mcp_dropped", "debug", { op: "decide", reason: "unfit" });
        sendState();
        return;
      }
      putGrant(key , { spec: grant.spec, toolDigest: msg.allow ? check.toolDigest : grant.toolDigest, status: msg.allow ? "allowed" : "denied", card: grant.card, sends: grant.sends });

      setKept(key , grant.spec.server, grant.spec.tool, !msg.allow);
      emit("program_card_mcp_write_decided", "info", { card: cardHash(key ), status: msg.allow ? "allowed" : "denied", via: "phone" });
      sendState();
      refreshKey(key );
    });
  }

  async function checkWriteGrants(input     )               {
    const raw = input && Array.isArray(input.uses) ? input.uses : [];

    const keys = input && input.keys === "open"
      ? [...subs.values()].filter((entry     ) => isLive(entry)).map((entry     ) => entry.key)
      : (input && Array.isArray(input.keys) ? input.keys : []).filter((k     ) => validKey(k));
    if (!raw.length) return { ok: true };
    const held = sessionGrantsOf(input.sessionKey);
    if (isArmed() && host) await loadListing(false);
    const refused        = [];
    for (const spec of raw) {
      const parsed = parseUse(spec);
      if (!parsed.ok || parsed.use.kind !== "write") {
        refused.push({ name: isPlainObject(spec) && typeof spec.name === "string" ? spec.name.slice(0, 24) : "?", why: parsed.ok ? "not_write" : "invalid", error: parsed.ok ? undefined : parsed.error });
        continue;
      }
      const use = parsed.use;
      const digest = programCardMcpUseDigest(use);
      const candidates        = [];
      for (const key of keys) {
        const g = grantFor(key, use.name);
        if (g) candidates.push(g);
      }
      const mine = held ? held.get(use.name) : null;
      if (mine) candidates.push(mine.grant);
      const match = candidates.find((g     ) => g.useDigest === digest);
      if (!match) {
        refused.push({ name: use.name, why: candidates.length ? "different" : "missing" });
        continue;
      }
      if (match.status === "denied") refused.push({ name: use.name, why: "declined" });
      else if (match.status === "paused") refused.push({ name: use.name, why: "changed" });
      else if (match.status !== "allowed") refused.push({ name: use.name, why: "missing" });
      else if (listing.ok && listing.atMs) {
        const check      = checkWrite(use);
        if (check.state === "ok" && check.toolDigest !== match.toolDigest) refused.push({ name: use.name, why: "changed" });
      }
    }
    return refused.length ? { ok: false, error: PROGRAM_CARD_MCP_WRITE_NOT_GRANTED, uses: refused } : { ok: true };
  }

  function bindWrites(sessionKey     , key        , name        , writeUses       ) {
    const held = sessionGrantsOf(sessionKey);
    let bound = 0;
    let missing = 0;
    for (const use of writeUses) {
      const digest = programCardMcpUseDigest(use);
      const own = grantFor(key, use.name);
      if (own && own.useDigest === digest && own.status === "allowed") {
        bound += 1;
        continue;
      }
      const mine = held ? held.get(use.name) : null;
      if (mine && mine.key === null && mine.grant.useDigest === digest && mine.grant.status === "allowed") {
        putGrant(key, { spec: mine.grant.spec, toolDigest: mine.grant.toolDigest, status: "allowed", card: name, sends: [] });
        held.delete(use.name);
        bound += 1;
        emit("program_card_mcp_write_bound", "debug", { card: cardHash(key), use: use.name });
        continue;
      }
      missing += 1;
    }
    if (bound) {
      sendState();
      refreshKey(key);
    }
    return missing ? "not_granted" : "allowed";
  }

  function refreshKey(key        ) {
    for (const entry of [...subs.values()]) if (entry.key === key) refreshEntry(entry);
    pump();
  }

  function recheckAll() {
    for (const entry of [...subs.values()]) {
      checkEntry(entry);
      refreshEntry(entry);
    }
    pump();
  }

  function noAnswerHeld(key        , digest        ) {
    for (const entry of subs.values()) {
      if (entry.key !== key || entry.digest !== digest) continue;

      if (RUN_KEY.test(key)) entry.missed = entry.held.slice(0, limits.maxHeldPerSub);
      flushHeld(entry, "not_allowed");
    }
  }

  function decideReads(key        , name        , block       , answers       , allow         , via        ) {
    if (allow) {
      for (const a of answers) if (isKept(key, a.use.server, a.use.tool)) setKept(key, a.use.server, a.use.tool, false);
      noteReads(key, name, block, answers.map((a     ) => ({ use: a.use, status: "allowed", toolDigest: a.toolDigest })));
    } else {
      noteReads(key, name, block, []);
      for (const a of answers) setKept(key, a.use.server, a.use.tool, true);
    }

    for (const entry of subs.values()) {
      if (entry.key === key) {
        entry.removed = false;
        entry.reasked = false;
      }
    }
    emit("program_card_mcp_decided", "info", { card: cardHash(key), status: allow ? "allowed" : "denied", via, uses: answers.length });
    sendState();
    refreshKey(key);
  }

  function settleIfAnswered(card     , reason        ) {
    if (!card || card.settled) return;
    const statuses = card.asks.map((a     ) => useStatus(card.key, a.use, a.toolDigest));
    if (statuses.some((s        ) => s === "waiting" || s === "changed")) return;
    settle(card, statuses.every((s        ) => s === "allowed") ? "allowed" : "declined", reason);
  }

  function settle(card     , outcome        , reason        ) {
    if (card.settled) return;
    card.settled = true;
    if (card.timer) clearTimeoutFn(card.timer);
    card.timer = null;
    if (pending.get(card.id) === card) pending.delete(card.id);

    if (reason === "phone") withdraw(card.surfaceId);

    sendStatusFor(card.key);
    if (outcome === "no_answer") noAnswerHeld(card.key, card.digest);
    emit("program_card_mcp_request_done", "info", { card: cardHash(card.key), outcome, reason });
    for (const resolve of card.waiters.splice(0)) resolve({ answer: outcome });
  }

  function onCardDecision(card     , decision     ) {

    if (card.settled) return;
    const choice = decision && decision.choice;
    if (choice === "allow" || choice === "deny") {

      decideReads(card.key, card.name, card.uses, card.asks, choice === "allow", "glasses");
      settle(card, choice === "allow" ? "allowed" : "declined", "selected");
      return;
    }
    const reason = decision && REQUEST_REASONS.has(decision.reason) ? decision.reason : "cancel";
    settle(card, "no_answer", reason);
  }

  function present(card     , cause        , sessionKeyIn     )               {
    let sessionKey = typeof sessionKeyIn === "string" && sessionKeyIn.trim() ? sessionKeyIn.trim() : "";
    if (!sessionKey) {
      try {
        const active = activeSessionKey();
        sessionKey = typeof active === "string" && active.trim() ? active.trim() : "";
      } catch (_) {
        sessionKey = "";
      }
    }
    const hash = cardHash(card.key);
    if (!sessionKey) {
      emit("program_card_mcp_request_done", "info", { card: hash, outcome: "no_answer", reason: "no_session" });
      noAnswerHeld(card.key, card.digest);
      return Promise.resolve({ answer: "no_answer" });
    }
    const entry      = { ...card, id: pendingId(card.key, card.digest), waiters: [], settled: false, timer: null };
    const promise = new Promise((resolve) => entry.waiters.push(resolve));
    pending.set(entry.id, entry);
    sendStatusFor(card.key);
    emit("program_card_mcp_request", "info", { card: hash, cause, uses: card.asks.length });
    let accepted = false;
    try {
      const result = presentDecision({
        surface: {
          surfaceId: (entry.surfaceId = `card-mcp:${hash}:${now().toString(36)}`),
          sessionKey,
          kind: "permission",
          title: "Let this card use your tools?",
          question: card.question,
          options: [
            { key: "allow", label: "Allow" },
            { key: "deny", label: "Not now" },
          ],
          deadlineSec: Math.ceil(limits.requestWaitMs / 1000),
        },
        expiresAtMs: now() + limits.requestWaitMs,
        onDecision: (decision     ) => {
          try {
            onCardDecision(entry, decision);
          } catch (_) {
            settle(entry, "no_answer", "cancel");
          }
        },
      });
      accepted = result === true || (!!result && typeof result === "object" && result.presented === true);
    } catch (_) {
      accepted = false;
    }
    if (!accepted) settle(entry, "no_answer", "presentation_failed");
    else if (!entry.settled) {
      entry.timer = timer(() => {
        entry.timer = null;
        settle(entry, "no_answer", "timeout");
      }, limits.requestWaitMs + limits.requestGraceMs);
    }
    return promise;
  }

  async function considerNow(input     )               {

    const cause = ["open", "edit", "changed", "tap"].includes(input.cause) ? input.cause : "write";
    const parsed = parseProgramCardMcpUses(input.uses);
    if (!parsed.ok) return { answer: "invalid", error: parsed.error };
    const key = validKey(input.key);
    if (!key) return { answer: "invalid", error: "bad card key" };
    const name = cardName(input.name);
    const writeUses = parsed.uses.filter((use     ) => use.kind === "write");

    const writes = writeUses.length && (cause === "write" || cause === "edit") ? bindWrites(input.sessionKey, key, name, writeUses) : null;
    const withWrites = (out     ) => (writes ? { ...out, writes: writesOn() ? writes : "off" } : out);
    if (!isArmed()) return withWrites({ answer: "off" });
    const uses = programCardMcpReadUses(parsed.uses);
    if (!uses.length) return withWrites({ answer: "allowed", reads: 0 });

    const tooLong = refuseTooLong(requestQuestion(name, uses), "use shorter titles, or ask for fewer reads at a time");
    if (tooLong) return withWrites(tooLong);
    const digest = programCardMcpDigest(uses);

    await loadListing(cause === "write" || cause === "edit");
    if (!listing.ok) return withWrites({ answer: "off" });

    const fits = cause === "open" || cause === "changed" || cause === "tap"
      ? uses.filter((use     ) => checkProgramCardMcpUses([use], listing, usableServers(), writeToolsMap()).ok)
      : uses;
    const checked = checkProgramCardMcpUses(fits.length ? fits : uses, listing, usableServers(), writeToolsMap());
    if (!checked.ok) return withWrites(checked.code === "off" ? { answer: "off" } : { answer: "invalid", error: checked.error });

    const statuses = fits.map((use     ) => ({ use, toolDigest: programCardMcpToolDigest([use], listing) }))
      .map((a     ) => ({ ...a, status: useStatus(key, a.use, a.toolDigest) }));
    const record = records.get(key);
    if (!record || record.digest !== digest) {

      noteReads(key, name, uses, []);
      sendState();
      refreshKey(key);
    }
    let asks = statuses.filter((a     ) => a.status === "waiting" || a.status === "changed");
    if (!asks.length) return withWrites({ answer: statuses.every((a     ) => a.status === "allowed") ? "allowed" : "declined" });
    const open = pending.get(pendingId(key, digest));
    if (open) return new Promise((resolve) => open.waiters.push((out     ) => resolve(withWrites(out))));

    if (cause === "open") asks = asks.filter((a     ) => a.status === "changed" || !readOf(key, a.use));
    if (!asks.length) return withWrites({ answer: "no_answer" });

    const question = requestQuestion(name, asks.map((a     ) => a.use));
    noteReads(key, name, uses, asks.map((a     ) => ({ use: a.use, status: "waiting" })));
    return present({ key, digest, name, uses, question, asks: asks.map((a     ) => ({ use: a.use, toolDigest: a.toolDigest })) }, cause, input.sessionKey).then(withWrites);
  }

  function consider(input     )               {
    try {
      return considerNow(input && typeof input === "object" ? input : {}).catch(() => ({ answer: "no_answer" }));
    } catch (_) {
      return Promise.resolve({ answer: "no_answer" });
    }
  }

  function carry(from     , entry     ) {
    if (typeof from !== "string" || !RUN_KEY.test(from) || !appIdOf(entry.key)) return false;
    const wrote = carryWrites(from, entry);
    const read = carryReads(from, entry);
    return carryKept(from, entry) || read || wrote;
  }

  function carryKept(from        , entry     ) {
    const nos = [...kept.values()].filter((no     ) => no.key === from);
    for (const no of nos) {
      kept.delete(keptId(no.key, no.server, no.tool));
      setKept(entry.key, no.server, no.tool, true);
    }
    return nos.length > 0;
  }

  function carryWrites(from        , entry     ) {
    let moved = false;
    for (const use of entry.writeUses) {
      const was = grantFor(from, use.name);
      if (!was || was.useDigest !== programCardMcpUseDigest(use) || was.status === "waiting") continue;
      const mine = grantFor(entry.key, use.name);
      if (mine && mine.useDigest === was.useDigest && mine.status !== "waiting") continue;
      dropGrant(from, use.name);
      putGrant(entry.key, { spec: was.spec, toolDigest: was.toolDigest, status: was.status, card: entry.name, sends: was.sends });
      emit("program_card_mcp_carried", "debug", { card: cardHash(entry.key), status: was.status, use: use.name });
      moved = true;
    }
    return moved;
  }

  function carryReads(from        , entry     ) {
    if (!entry.readUses.length) return false;
    const was = records.get(from);

    const fitsWhole = was && readAskFits(was.name, was.uses, limits.requestQuestionMax) && readAskFits(entry.name, entry.readUses, limits.requestQuestionMax);
    const yeses = fitsWhole ? was.reads.filter((r     ) => r.status === "allowed") : [];
    if (!yeses.length) return false;
    const mine = records.get(entry.key);
    let reads        = mine ? mine.reads.slice() : [];
    for (const yes of yeses.slice().reverse()) {
      if (reads.some((r     ) => r.reach === yes.reach && r.status === "allowed")) continue;
      reads = reads.filter((r     ) => r.reach !== yes.reach);
      reads.unshift({ ...yes });
    }
    records.delete(from);
    lastCalls.delete(from);
    putRecord(entry.key, { name: entry.name, uses: entry.readUses, reads });
    emit("program_card_mcp_carried", "debug", { card: cardHash(entry.key), status: "allowed", uses: yeses.length });
    return true;
  }

  function afterCheck(entry     ) {
    if (!isLive(entry)) return;
    checkEntry(entry);
    refreshEntry(entry);
    const unasked = entry.readUses.some((use     ) => entryUseStatus(entry, use) === "waiting" && !readOf(entry.key, use));
    if (entry.readUses.length && entry.status === "waiting" && entry.check.state === "ok" && unasked && !entry.asked) {
      entry.asked = true;
      void consider({ sessionKey: null, key: entry.key, name: entry.name, uses: entry.uses, cause: "open" });
    }

    if (!entry.autoNoted && entry.writeUses.length && writesOn() && autoLive(entry.key)) {
      entry.autoNoted = true;
      sendFrame({ type: PROGRAM_CARD_MCP_DATA_FRAME, sub: entry.sub, kind: "auto_on" });
    }
    pump();
  }

  function open(msg     ) {
    const sub = typeof msg.sub === "string" && msg.sub.length <= 80 ? msg.sub : "";
    const key = msg.card && typeof msg.card === "object" ? validKey(msg.card.key) : null;
    if (!sub || !key) {
      emit("program_card_mcp_dropped", "debug", { op: "open", reason: "bad_frame" });
      return;
    }
    const name = cardName(msg.card.name);
    const parsed = parseProgramCardMcpUses(msg.uses);
    const uses = parsed.ok ? parsed.uses : [];
    const readUses = programCardMcpReadUses(uses);

    const digest = readUses.length ? programCardMcpDigest(readUses) : "";
    const blockDigest = parsed.ok ? programCardMcpDigest(uses) : "";
    expireSubs();
    let entry = subs.get(sub);
    if (entry && (entry.key !== key || entry.blockDigest !== blockDigest)) {

      flushHeld(entry, "not_allowed");
      dropSub(entry, "replaced");
      entry = undefined;
    }
    if (!entry) {
      while (subs.size >= limits.maxSubscriptions) dropSub(subs.values().next().value, "evicted");
      entry = {
        sub, key, name, uses, digest, blockDigest, readUses, writeUses: uses.filter((use     ) => use.kind === "write"),
        invalid: !parsed.ok, removed: false, held: [], status: "", leaseUntil: 0, closed: false,
        check: { state: "pending" }, writeChecks: new Map(), writeIds: new Set(), refresh: new Map(), slow: new Map(),
        pausedUses: new Set(), asked: false, reasked: false, autoNoted: false, missed: [],
      };
      subs.set(sub, entry);
      if (!parsed.ok) emit("program_card_mcp_invalid", "debug", { card: cardHash(key), outcome: "invalid_uses" });
    }
    entry.name = name;

    const tooLong = parsed.ok && readUses.length > 0 && !readAskFits(name, readUses, limits.requestQuestionMax);
    if (tooLong && !entry.invalid) emit("program_card_mcp_invalid", "debug", { card: cardHash(key), outcome: "ask_too_long" });
    entry.invalid = !parsed.ok || tooLong;
    if (tooLong) flushHeld(entry, "off");
    entry.leaseUntil = now() + limits.leaseMs;
    const carried = parsed.ok && !tooLong ? carry(msg.from, entry) : false;
    checkEntry(entry);
    entry.status = statusOf(entry);
    sendStatus(entry);
    if (carried) sendState();
    emit("program_card_mcp_open", "debug", { card: cardHash(key), uses: uses.length, status: entry.status });
    if (!entry.invalid && isArmed()) {
      const opened = entry;
      void loadListing(false).then(() => afterCheck(opened));
    }
  }

  function call(msg     ) {
    const entry = typeof msg.sub === "string" ? subs.get(msg.sub) : null;
    if (!entry) {
      emit("program_card_mcp_dropped", "debug", { op: "call", reason: "unknown_sub" });
      return;
    }
    if (now() > entry.leaseUntil) {
      dropSub(entry, "lease_expired");
      return;
    }
    const list = Array.isArray(msg.calls) ? msg.calls : [];
    list.forEach((raw     , index        ) => {
      const id = callIdOf(raw);
      if (id === null) return;

      const named = entry.uses.find((use     ) => use.name === callMcpOf(raw)) || null;
      let cause                = null;
      const reply = (code        ) => sendResult(entry.sub, { id, mcp: callMcpOf(raw) || "" }, { ok: false, code }, { entry, use: named, cause });
      if (index >= limits.maxCallsPerFrame) return reply("limit");
      if (!isArmed() || entry.invalid) return reply("off");
      const parsed = parseProgramCardMcpCall(raw, entry.uses);
      cause = parsed.ok ? null : "parse";
      if (!parsed.ok) return reply("failed");
      const job = { entry, key: entry.key, call: parsed.call, use: parsed.use, refresh: false };
      if (parsed.use.kind === "write") return callWrite(entry, job, parsed.from, reply);

      const same = (other     ) => other && other.entry === entry && other.call.id === id;
      if (entry.held.some(same) || queue.some(same) || [...inFlight.values()].some((run     ) => same(run.job))) return;

      const slot = entry.refresh.get(parsed.use.name);
      if (slot && slot.call.id === id && canonicalSerialize(slot.call.args) === canonicalSerialize(parsed.call.args)) return;

      clearRefresh(entry, parsed.use.name);
      const code = refusal(entry, parsed.use);
      if (code === "hold") {
        if (entry.held.length >= limits.maxHeldPerSub) reply("limit");
        else entry.held.push(job);
      } else if (code) reply(code);
      else enqueue(job);
    });
    pump();
  }

  function decide(msg     ) {

    const read = typeof msg.digest === "string" && typeof msg.request !== "string";
    if (!read && (typeof msg.request === "string" || typeof msg.use === "string")) return decideWrite(msg);
    const key = validKey(msg.key);
    const digest = typeof msg.digest === "string" && DIGEST.test(msg.digest) ? msg.digest : "";
    const useName = msg.use === undefined || msg.use === null ? null : typeof msg.use === "string" && USE_NAME.test(msg.use) ? msg.use : "";
    if (!key || !digest || typeof msg.allow !== "boolean" || useName === "") {
      emit("program_card_mcp_dropped", "debug", { op: "decide", reason: "bad_frame" });
      return;
    }
    const card = pending.get(pendingId(key, digest));
    const opened      = [...subs.values()].find((e     ) => e.key === key && e.digest === digest && !e.invalid && e.readUses.length);
    const record = records.get(key);
    const source = (record && record.digest === digest ? { name: record.name, uses: record.uses } : null)
      || (opened ? { name: opened.name, uses: opened.readUses } : null)
      || (card ? { name: card.name, uses: card.uses } : null);
    const targets = source ? source.uses.filter((use     ) => useName === null || use.name === useName) : [];
    if (!source || !targets.length) {

      emit("program_card_mcp_dropped", "debug", { op: "decide", reason: "no_record" });
      sendState();
      return;
    }
    if (!msg.allow) {

      decideReads(key, source.name, source.uses, targets.map((use     ) => ({ use, toolDigest: "" })), false, "phone");
      settleIfAnswered(card, "phone");
      return;
    }

    if (!readAskFits(source.name, source.uses, limits.requestQuestionMax)) {
      emit("program_card_mcp_dropped", "debug", { op: "decide", reason: "ask_too_long" });
      sendState();
      return;
    }

    void loadListing(false).then(() => {
      const checked = isArmed() && listing.ok ? checkProgramCardMcpUses(targets, listing, usableServers(), writeToolsMap()) : null;
      if (!checked || !checked.ok) {
        emit("program_card_mcp_dropped", "debug", { op: "decide", reason: checked ? checked.code : "off" });
        sendState();
        return;
      }
      const answers = targets.map((use     ) => ({ use, toolDigest: programCardMcpToolDigest([use], listing) }));
      decideReads(key, source.name, source.uses, answers, true, "phone");
      settleIfAnswered(pending.get(pendingId(key, digest)), "phone");
    });
  }

  function remove(msg     ) {
    const key = validKey(msg.key);
    const part = msg.part === undefined ? null : msg.part;
    if (!key || (part !== null && part !== "reads" && part !== "writes")) {
      emit("program_card_mcp_dropped", "debug", { op: "remove", reason: "bad_frame" });
      return;
    }

    const tools = new Set        ();
    const record = part === "writes" ? null : records.get(key);
    if (part === "reads") {
      if (record) for (const r of [...record.uses, ...record.reads]) tools.add(`${r.server}\n${r.tool}`);
      for (const entry of subs.values()) if (entry.key === key) for (const use of entry.readUses) tools.add(`${use.server}\n${use.tool}`);
    } else if (part === "writes" && grants.has(key)) {
      for (const g of grants.get(key).values()) tools.add(`${g.spec.server}\n${g.spec.tool}`);
    }
    const hadKept = dropKept(key, part === null ? null : tools);
    if (record) {
      records.delete(key);
      lastCalls.delete(key);
    }
    if ((record || hadKept) && appIdOf(key)) persist();
    const hadWrites = part !== "reads" && grants.has(key);
    if (hadWrites) {
      autoTimes.delete(key);
      grants.delete(key);
      if (appIdOf(key)) persistWrites();
    }

    if (part !== "writes") for (const entry of subs.values()) if (entry.key === key) entry.removed = true;
    emit("program_card_mcp_removed", "info", { card: cardHash(key), had: !!record || hadWrites || hadKept, ...(part ? { part } : {}) });
    sendState();
    refreshKey(key);
  }

  function setServer(msg     ) {
    const server = typeof msg.server === "string" && SERVER_NAME.test(msg.server) ? msg.server : null;
    if (!server || typeof msg.allow !== "boolean") {
      emit("program_card_mcp_dropped", "debug", { op: "server", reason: "bad_frame" });
      return;
    }
    if (msg.allow && cardServers.size >= limits.maxServers && !cardServers.has(server)) {
      emit("program_card_mcp_dropped", "debug", { op: "server", reason: "limit" });
      sendState();
      return;
    }
    const had = cardServers.has(server);
    if (msg.allow) cardServers.add(server);
    else cardServers.delete(server);
    if (had !== msg.allow) persist();
    emit("program_card_mcp_server", "info", { server, allow: msg.allow });
    const apply = host && typeof host.allow === "function" ? host.allow(server, msg.allow) : null;

    void Promise.resolve(apply)
      .catch((err     ) => {
        emit("program_card_mcp_server_failed", "warn", { server, code: errorCode(err) });
        return null;
      })
      .then((result     ) => {
        if (result && result.ok === false) emit("program_card_mcp_server_failed", "warn", { server, code: String(result.code || "failed").slice(0, 32) });
        recheckAll();
        sendState();
        return loadListing(true);
      });
  }

  function settingsFor(server        ) {
    if (!serverSettings.has(server)) serverSettings.set(server, { risk: "normal", autoSend: false, writeTools: new Set        () });
    return serverSettings.get(server);
  }

  function setRisk(msg     ) {
    const server = typeof msg.server === "string" && SERVER_NAME.test(msg.server) ? msg.server : null;
    if (!server || !RISKS.has(msg.level) || typeof msg.autoSend !== "boolean" || (!serverSettings.has(server) && serverSettings.size >= limits.maxServers)) {
      emit("program_card_mcp_dropped", "debug", { op: "risk", reason: "bad_frame" });
      return;
    }
    const s = settingsFor(server);
    s.risk = msg.level;
    s.autoSend = msg.autoSend;

    if (s.risk === "high" && !s.autoSend) {
      for (const byUse of grants.values()) for (const g of byUse.values()) if (g.spec.server === server) g.auto = null;
    }
    persistWrites();
    emit("program_card_mcp_risk", "info", { server, level: s.risk, autoSend: s.autoSend });
    sendState();
  }

  function setWriteTool(msg     ) {
    const server = typeof msg.server === "string" && SERVER_NAME.test(msg.server) ? msg.server : null;
    const tool = typeof msg.tool === "string" && TOOL_NAME.test(msg.tool) ? msg.tool : null;
    if (!server || !tool || typeof msg.write !== "boolean" || (!serverSettings.has(server) && serverSettings.size >= limits.maxServers)) {
      emit("program_card_mcp_dropped", "debug", { op: "write_tool", reason: "bad_frame" });
      return;
    }
    const s = settingsFor(server);
    if (msg.write && s.writeTools.size >= limits.maxToolsPerServer && !s.writeTools.has(tool)) return;
    if (msg.write) s.writeTools.add(tool);
    else s.writeTools.delete(tool);
    persistWrites();
    emit("program_card_mcp_write_tool", "info", { server, tool, write: msg.write });
    recheckAll();
    sendState();
  }

  function windowFor(key        ) {
    const since = now() - limits.perCardWindowMs;
    const times = (windows.get(key) || []).filter((at        ) => at > since);
    if (times.length) windows.set(key, times);
    else windows.delete(key);
    return times;
  }

  function dayCount() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (today.day !== day) today = { day, count: 0 };
    return today.count;
  }

  function sendRefusal(job     ) {
    const entry = job.entry;
    if (!isLive(entry)) {
      if (!entry.closed && now() > entry.leaseUntil) dropSub(entry, "lease_expired");
      return "drop";
    }
    const code = job.write ? writeRefusal(entry, job.use, job.from, true) : refusal(entry, job.use);
    if (code) return code === "hold" ? "not_allowed" : code;
    if ((restUntil.get(job.use.server) || 0) > now()) return "busy";
    if (windowFor(job.key).length >= limits.perCardPerMinute) return "limit";
    if (dayCount() >= limits.perHostPerDay) return "limit";
    return null;
  }

  function noteLast(job     , outcome        ) {
    limited.delete(`${job.key}\n${job.use.name}`);
    let last = lastCalls.get(job.key);
    if (!last) {
      if (!records.has(job.key)) return;
      last = new Map();
      lastCalls.set(job.key, last);
    }
    last.set(job.use.name, { mcp: job.use.name, atMs: now(), outcome });
    if (now() - lastStateAt >= limits.stateEveryMs) sendState();
  }

  function scheduleRefresh(job     ) {
    const entry = job.entry;
    const use = job.use;
    if (!use.every || !isLive(entry) || entry.pausedUses.has(use.name)) return;
    const current = entry.refresh.get(use.name);
    if (current && current.call.id !== job.call.id) return;
    if (current && current.timer) clearTimeoutFn(current.timer);
    const slot      = { call: job.call, timer: null };
    slot.timer = timer(() => {
      slot.timer = null;
      if (entry.refresh.get(use.name) !== slot || !isLive(entry)) return;

      if (presenceAway()) {
        scheduleRefresh({ ...job, refresh: true });
        return;
      }
      const same = (other     ) => other && other.entry === entry && other.call.id === job.call.id;
      if (queue.some(same) || [...inFlight.values()].some((run     ) => same(run.job))) return;
      enqueue({ entry, key: entry.key, call: job.call, use, refresh: true });
      pump();
    }, use.every * 1000);
    entry.refresh.set(use.name, slot);
  }

  function deliver(job     , out     , ms        ) {
    let result      = programCardMcpValue(job.use, out);

    const code = job.write ? null : refusal(job.entry, job.use);

    let cause                = !out || out.ok !== true ? "host" : "value";
    if (job.switchedOff && !job.write) {
      result = { ok: false, code: "off" };
      cause = "switched";
    } else if (code === "not_allowed" || code === "off" || code === "changed") {
      result = { ok: false, code };
      cause = null;
    }
    const sent = job.write ? writeOutcome(out, result) : null;
    if (sent) noteSend(job, job.via || "glasses", sent);
    const live = isLive(job.entry);

    if (job.auto && live) {
      sendFrame({ type: PROGRAM_CARD_MCP_DATA_FRAME, sub: job.entry.sub, kind: "auto", id: job.call.id, mcp: job.use.name, title: job.use.title, outcome: sent });
    }
    if (!live && !job.entry.closed && now() > job.entry.leaseUntil) dropSub(job.entry, "lease_expired");
    const duration = Math.max(0, Math.round(ms));
    const strikes = duration > limits.slowMs ? (job.entry.slow.get(job.use.name) || 0) + 1 : 0;
    job.entry.slow.set(job.use.name, strikes);
    if (strikes >= limits.slowStrikes) {
      job.entry.pausedUses.add(job.use.name);
      clearRefresh(job.entry, job.use.name);
    }
    emit("program_card_mcp_call", "debug", {
      card: cardHash(job.key),
      use: job.use.name,
      server: job.use.server,
      tool: job.use.tool,
      outcome: result.ok ? "ok" : result.code,
      ms: duration,
      bytes: result.ok ? jsonBytes(result.value) : 0,
      refresh: job.refresh === true,
      delivered: live,
    });
    noteLast(job, result.ok ? "ok" : result.code);
    if (live) sendResult(job.entry.sub, job.call, result, { entry: job.entry, use: job.use, write: job.write === true, cause });
    if (live && result.code !== "not_allowed" && result.code !== "off" && result.code !== "changed") scheduleRefresh(job);
    if (strikes >= limits.slowStrikes) emit("program_card_mcp_paused", "info", { card: cardHash(job.key), use: job.use.name });
  }

  function writeOutcome(out     , result     ) {
    if (result.ok || (out && out.ok === true && out.isError !== true)) return "sent";
    if (out && out.ok === true) return "failed";
    const code = out && out.code;
    return !out || code === "timeout" || code === "failed" || !HOST_CODES.has(code) ? "unknown" : "failed";
  }

  function start(job     ) {
    windows.set(job.key, [...windowFor(job.key), now()]);
    dayCount();
    today.count += 1;

    if (job.write) noteWriteStart(job.key);
    const callTimeoutMs = job.write ? limits.writeTimeoutMs : limits.callTimeoutMs;
    const gen = generation;
    const startedAt = now();
    const server = job.use.server;
    const run      = { job, settled: false, guard: null };
    inFlight.set(server, run);
    const finish = (out     ) => {
      if (run.settled) return;
      run.settled = true;
      if (run.guard) clearTimeoutFn(run.guard);
      run.guard = null;
      if (inFlight.get(server) === run) inFlight.delete(server);
      if (gen !== generation) return;
      if (out && out.code === "timeout") restUntil.set(server, now() + limits.timeoutRestMs);
      try {
        deliver(job, out, now() - startedAt);
      } catch (_) {
        emit("program_card_mcp_dropped", "debug", { op: "result", reason: "error" });
      }
      pump();
    };
    run.guard = timer(() => {
      run.guard = null;
      finish({ ok: false, code: "timeout" });
    }, callTimeoutMs + limits.callGraceMs);
    let callPromise              ;
    try {
      callPromise = Promise.resolve(host.call({
        server,
        tool: job.use.tool,
        args: { ...job.use.args, ...job.call.args },
        timeoutMs: callTimeoutMs,
        ...(job.write ? { write: true } : {}),

        ...(ownerWrite(server, job.use.tool) ? { ownerWrite: true } : {}),
      }));
    } catch (_) {
      callPromise = Promise.resolve({ ok: false, code: "failed" });
    }
    callPromise.then(finish, () => finish({ ok: false, code: "failed" }));
  }

  function pump() {
    let i = 0;
    while (i < queue.length) {
      const job = queue[i];
      if (inFlight.has(job.use.server)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      const code = sendRefusal(job);
      if (code === "drop") continue;
      if (code) {
        if (code === "limit") noteLimited(job);
        answer(job, code);
        continue;
      }
      start(job);
    }
  }

  function taughtTools() {
    if (!isArmed()) return "";

    if (now() - listing.atMs >= limits.listTtlMs) void loadListing(false);
    if (!listing.ok) return "";
    const reads           = [];
    const sends           = [];
    let bytes = writesOn() ? utf8Bytes(PROGRAM_CARD_MCP_SENDS_LINE) + 1 : 0;
    let count = 0;

    for (const writes of [false, true]) {
      if (writes && !writesOn()) break;
      const lines = writes ? sends : reads;
      for (const [name, server] of listing.servers) {
        if (!cardServers.has(name) || server.granted === false || server.connected !== true) continue;
        for (const [toolName, tool] of server.tools) {
          if (writes ? tool.annotations.destructiveHint === true || isReadTool(name, toolName, tool) : !isReadTool(name, toolName, tool)) continue;
          if (count >= limits.guideToolsMax) break;
          const props = tool.inputSchema && isPlainObject(tool.inputSchema.properties) ? Object.keys(tool.inputSchema.properties).slice(0, 8) : [];
          const what = Array.from(tool.description).slice(0, 80).join("");
          const line = `- ${name} · ${toolName}${what ? `: ${what}` : ""}${props.length ? ` (args: ${props.map(fieldLabel).join(", ")})` : ""}`;
          const size = utf8Bytes(line) + 1;
          if (bytes + size > limits.guideBytesMax) break;
          lines.push(line);
          bytes += size;
          count += 1;
        }
      }
    }
    return [...reads, ...(sends.length ? [PROGRAM_CARD_MCP_SENDS_LINE, ...sends] : [])].join("\n");
  }

  return {

    handle(msg     ) {
      const op = msg && typeof msg === "object" && OPS.has(msg.op) ? msg.op : "unknown";
      try {
        if (op === "open") open(msg);
        else if (op === "call") call(msg);
        else if (op === "ask") askAgain(msg);
        else if (op === "close") {
          const entry = typeof msg.sub === "string" ? subs.get(msg.sub) : null;
          if (entry) dropSub(entry, "closed");
        } else if (op === "decide") decide(msg);
        else if (op === "confirm") confirm(msg);
        else if (op === "remove") remove(msg);
        else if (op === "server") setServer(msg);
        else if (op === "risk") setRisk(msg);
        else if (op === "write_tool") setWriteTool(msg);
        else if (op === "auto") setAuto(msg);
        else if (op === "host_command") {

          if (!hostCommands || !hostCommands.handle(msg)) {
            emit("program_card_mcp_dropped", "debug", { op, reason: hostCommands ? "bad_frame" : "off" });
            sendState();
          }
        } else if (op === "state") {
          sendState();

          void loadListing(false);
        } else emit("program_card_mcp_dropped", "debug", { op, reason: "unknown_op" });
      } catch (_) {
        emit("program_card_mcp_dropped", "debug", { op, reason: "error" });
      }
    },

    consider,

    lastCallsOf(key     ) {
      const last = typeof key === "string" ? lastCalls.get(key) : null;
      return last ? [...last.values()].map((row     ) => ({ mcp: row.mcp, atMs: row.atMs, outcome: row.outcome })) : [];
    },

    writeMarksOf(server        , tool        ) {
      if (isArmed() && listing.atMs && now() - listing.atMs >= limits.listTtlMs) void loadListing(false);
      const listed = toolOf(listing, server, tool);
      const hints = listed && listed.annotations && typeof listed.annotations === "object" ? listed.annotations : {};
      const cardsOn = isArmed() && cardServers.has(server);
      return {
        ownerWrite: ownerWrite(server, tool),
        destructive: hints.destructiveHint === true,
        writeMarked: hints.readOnlyHint === false,
        readMarked: !!listed && cardsOn && isReadTool(server, tool, { annotations: hints }),
        listed: !!listed,
        cardsOn,
      };
    },

    considerWrite,

    considerHostCommand(params      = {}) {
      if (!hostCommands || !enabled) return Promise.resolve({ answer: "off" });
      return Promise.resolve(hostCommands.consider(params || {})).catch(() => ({ answer: "no_answer" }));
    },

    hostCommandsOn: () => !!hostCommands && isArmed(),
    health: cardHealth,
    healthJudges,
    hostHealthKnown,
    hostHealth,

    askAgainFor(key     , sessionKey     )                         {
      const record = validKey(key) ? records.get(key) : null;
      if (!record || !isArmed()) return Promise.resolve(null);
      const waits = record.uses.some((use     ) => ["waiting", "changed"].includes(useStatus(record.key, use, listedToolDigest(use))));
      if (!waits) return Promise.resolve(null);
      return consider({ sessionKey, key: record.key, name: record.name, uses: record.uses, cause: "tap" }).then((out     ) => String(out?.answer || "no_answer"));
    },

    allowServerForCards(server     ) {
      setServer({ server, allow: true });
    },

    checkWriteGrants,

    writesOn,

    setPresence(value     ) {
      presence = typeof value === "string" ? value : "unknown";
      if (!presenceAway()) return;

      for (const key of [...confirms.keys()]) closeConfirm(key, "refused", "paused");
      const flushed = queue.splice(0);
      for (const job of flushed) answer(job, "paused");
      if (flushed.length) emit("program_card_mcp_paused", "debug", { count: flushed.length });
    },

    state: stateFrame,
    armed: isArmed,
    setEnabled(value         ) {
      enabled = value === true;
      if (!enabled) for (const run of inFlight.values()) run.job.switchedOff = true;
      for (const entry of subs.values()) refreshEntry(entry);
      sendState();
      if (enabled) void loadListing(true).then(() => {
        for (const entry of subs.values()) if (!entry.removed && statusOf(entry) === "waiting") {
          void consider({ key: entry.key, name: entry.name, uses: entry.uses, cause: "open" });
        }
      });
      pump();
      return { enabled };
    },

    taughtTools,

    refresh: () => loadListing(true),
    stopAll() {
      generation += 1;
      for (const entry of [...subs.values()]) dropSub(entry, "stopped");
      queue.length = 0;
      for (const run of inFlight.values()) {
        run.settled = true;
        if (run.guard) clearTimeoutFn(run.guard);
      }
      inFlight.clear();
      listingPromise = null;
      for (const card of [...pending.values()]) settle(card, "no_answer", "stopped");
      for (const request of [...writeRequests.values()]) settleWrite(request, "no_answer", "stopped");
      if (hostCommands) hostCommands.stopAll();
      try {
        if (host && typeof host.dispose === "function") Promise.resolve(host.dispose()).catch(() => {});
      } catch (_) {

      }
    },
  };
}

module.exports = { PROGRAM_CARD_MCP_CAPABILITY, PROGRAM_CARD_MCP_SENDS_LINE, PROGRAM_CARD_MCP_WRITES_CAPABILITY, PROGRAM_CARD_MCP_FILENAME, PROGRAM_CARD_MCP_WRITES_FILENAME, PROGRAM_CARD_MCP_DATA_FRAME, PROGRAM_CARD_MCP_STATE_FRAME, PROGRAM_CARD_MCP_CODES, PROGRAM_CARD_MCP_WHYS, PROGRAM_CARD_MCP_HEALTH_REASONS, PROGRAM_CARD_MCP_SEND_HEALTH_REASONS, PROGRAM_CARD_MCP_TEMPORARY_WHYS, PROGRAM_CARD_MCP_GESTURES, PROGRAM_CARD_MCP_WRITE_NOT_GRANTED, PROGRAM_CARD_MCP_LIMITS, parseProgramCardMcpUses, parseProgramCardMcpUse, parseProgramCardMcpCall, programCardMcpDigest, programCardMcpReadUses, programCardMcpUseDigest, programCardMcpReachDigest, programCardMcpToolDigest, checkProgramCardMcpUses, resolveProgramCardMcpPick, programCardMcpValue, parseProgramCardMcpListing, createProgramCardMcpStore, PROGRAM_CARD_MCP_WRITES_SAVED_SHAPE, createProgramCardMcpWritesStore, createProgramCardSourceRev, createProgramCardMcp };
