function fail(_code        , _path        , message        )        { throw new Error(message); }

const MODEL_LIMITS = Object.freeze({ uses: 4, blockBytes: 16384, inputBytes: 8192, valueBytes: 8192, prompts: 4, idChars: 40, textChars: 2000 });
const MODEL_CODES = Object.freeze(["off", "not_allowed", "limit", "busy", "timeout", "paused", "failed", "invalid_output", "unavailable", "model_changed", "too_big"]);
const NAME = /^[a-z][A-Za-z0-9_]{0,23}$/;
const MODEL_THREAD = /^[a-z][A-Za-z0-9_-]{0,23}$/;
const plain = (v     ) => !!v && typeof v === "object" && !Array.isArray(v);
const bytes = (v     ) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).length;
const bad = (message        )        => fail("model_invalid", "/card/model", message);

function validateModelSchema(schema     ) {
  let properties = 0;
  const visit = (s     , depth        ) => {
    if (!plain(s) || depth > 3) bad("Output schema must have depth at most 3");
    const allowed = ["type", "properties", "required", "additionalProperties", "maxLength", "maxItems", "items", "enum"];
    if (Object.keys(s).some(k => !allowed.includes(k)) || (s.additionalProperties !== undefined && s.additionalProperties !== false)) bad("Unsupported output schema field");
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 32 || s.enum.some((x     ) => x !== null && !["string", "number", "boolean"].includes(typeof x)))) bad("enum needs 1 to 32 scalar values");
    if (!s.type && s.enum) return;
    if (!["object", "string", "number", "integer", "boolean", "array"].includes(s.type)) bad("Unsupported output schema type");
    if (s.type === "string" && (!Number.isInteger(s.maxLength) || s.maxLength < 1 || s.maxLength > 2000)) bad("Strings need maxLength at most 2000");
    if (s.type === "array") {
      if (!Number.isInteger(s.maxItems) || s.maxItems < 1 || s.maxItems > 32) bad("Arrays need maxItems at most 32");
      visit(s.items, depth + 1);
    }
    if (s.type === "object") {
      if (!plain(s.properties)) bad("Objects need properties");
      properties += Object.keys(s.properties).length;
      if (properties > 24 || Object.keys(s.properties).some(k => ["__proto__", "constructor", "prototype"].includes(k))) bad("At most 24 safe properties");
      if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((k     ) => typeof k !== "string" || !Object.hasOwn(s.properties, k)))) bad("required must name properties");
      for (const child of Object.values(s.properties)) visit(child, depth + 1);
    }
  };
  visit(schema, 0);
  return schema;
}

function modelValueErrors(value     , schema     , path = "$")           {
  const errors           = [];
  if (schema.enum && !schema.enum.some((x     ) => x === value)) errors.push(`${path}: not in enum`);
  const type = schema.type;
  if (!type) return errors;
  const fits = type === "object" ? plain(value) : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type;
  if (!fits) return [...errors, `${path}: expected ${type}`];
  if (type === "string" && Array.from(value).length > schema.maxLength) errors.push(`${path}: too long`);
  if (type === "array") {
    if (value.length > schema.maxItems) errors.push(`${path}: too many items`);
    for (let i = 0; i < Math.min(value.length, 33); i++) errors.push(...modelValueErrors(value[i], schema.items, `${path}[${i}]`));
  }
  if (type === "object") {
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) errors.push(`${path}.${k}: required`);
    for (const k of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, k)) errors.push(`${path}: unknown property`);
      else errors.push(...modelValueErrors(value[k], schema.properties[k], `${path}.${k}`));
    }
  }
  return errors.slice(0, 32);
}

function normalizeModel(raw     )        {
  if (raw == null) return [];
  if (!plain(raw) || Object.keys(raw).length > 4) bad("model must declare at most four named uses");
  const uses = (Object.entries(raw)                        ).map(([name, s]) => {
    if (!NAME.test(name) || !plain(s)) bad("Invalid model use name or declaration");
    if (Object.keys(s).some(k => !["title", "description", "sends", "instructions", "output", "memory", "maxTokens", "request"].includes(k))) bad("Unknown model use field");
    for (const [k, max] of [["title", 40], ["description", 160], ["sends", 120], ["instructions", 4096]]                           ) {
      if (typeof s[k] !== "string" || !s[k].trim() || Array.from(s[k]).length > max) bad(`${k} is required, at most ${max} characters`);

      if (k !== "instructions" && /[\p{Cc}\p{Zl}\p{Zp}]/u.test(s[k])) bad(`${k} must be one line of printable text`);
    }
    if (s.output !== "text") validateModelSchema(s.output);
    if (s.memory !== undefined && !["none", "thread"].includes(s.memory)) bad("memory is none or thread");
    if (s.maxTokens !== undefined && (!Number.isInteger(s.maxTokens) || s.maxTokens < 1 || s.maxTokens > 800)) bad("maxTokens must be 1 to 800; only the owner may raise it");
    if (s.request !== undefined && (!plain(s.request) || Object.keys(s.request).some(k => !["model", "reasoning"].includes(k)) || Object.values(s.request).some(v => typeof v !== "string" || !v || v.length > 200))) bad("Invalid model request");
    return { name, ...s, memory: s.memory || "none", maxTokens: s.maxTokens ?? 300 };
  });
  if (bytes(uses) > MODEL_LIMITS.blockBytes) bad("model block is over 16 KB");
  return uses;
}

function normalizePrompts(raw     , uses       )        {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 4) bad("prompts returns at most four requests");
  return raw.map((p     ) => {
    const use = uses.find((u     ) => u.name === p?.model);
    if (!plain(p) || typeof p.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:#-]{0,39}$/.test(p.id) || !use) bad("A prompt needs a valid id and declared model use");
    if (Object.keys(p).some(k => !["id", "model", "input", "thread", "reset"].includes(k))) bad("Unknown prompt field");
    if (p.reset !== undefined) {
      if (use.memory !== "thread" || typeof p.reset !== "string" || !MODEL_THREAD.test(p.reset) || p.input !== undefined || p.thread !== undefined) bad("reset needs a thread name and no input");
      return { id: p.id, model: p.model, reset: p.reset };
    }
    if (typeof p.input !== "string" || !p.input.trim() || bytes(p.input) > MODEL_LIMITS.inputBytes) bad("input must be text under 8 KB UTF-8");
    if (use.memory === "thread" ? typeof p.thread !== "string" || !MODEL_THREAD.test(p.thread) : p.thread !== undefined) bad("Thread prompts need a valid thread name; memory none has no thread");
    return { id: p.id, model: p.model, input: p.input, ...(p.thread ? { thread: p.thread } : {}) };
  });
}

function modelEvent(raw     ) {
  if (!plain(raw) || typeof raw.id !== "string" || typeof raw.model !== "string" || typeof raw.ok !== "boolean") return null;
  if (!raw.ok) return MODEL_CODES.includes(raw.code) ? { type: "model", id: raw.id, model: raw.model, ok: false, code: raw.code } : null;
  if (typeof raw.reset === "string" && MODEL_THREAD.test(raw.reset)) return { type: "model", id: raw.id, model: raw.model, ok: true, reset: raw.reset };
  if (!plain(raw.ran) || typeof raw.ran.provider !== "string" || typeof raw.ran.model !== "string") return null;
  if (raw.text !== undefined ? typeof raw.text !== "string" || Array.from(raw.text).length > 2000 : raw.value === undefined || bytes(raw.value) > 8192) return null;
  return { type: "model", id: raw.id, model: raw.model, ok: true, ...(raw.text !== undefined ? { text: raw.text } : { value: raw.value }), ran: raw.ran };
}

const MODEL_SANDBOX_SOURCE = `
const MODEL_LIMITS = ${JSON.stringify(MODEL_LIMITS)};
const NAME = ${NAME}; const MODEL_THREAD = ${MODEL_THREAD};
const modelPlain = v => !!v && typeof v === "object" && !Array.isArray(v);
// UTF-8 bytes as TextEncoder counts them: a lone surrogate is U+FFFD, 3 bytes, never a throw (#7336).
const modelBytes = v => { const s = String(typeof v === "string" ? v : JSON.stringify(v)); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 3; } return n; };
const modelBad = message => { throw new Error(message); };
${[validateModelSchema, normalizeModel, normalizePrompts].map(fn => fn.toString().replace(/\bplain\(/g, "modelPlain(").replace(/\bbytes\(/g, "modelBytes(").replace(/\bbad\(/g, "modelBad(")).join("\n")}
`;

module.exports = { MODEL_LIMITS, MODEL_CODES, MODEL_THREAD, validateModelSchema, modelValueErrors, normalizeModel, normalizePrompts, modelEvent, MODEL_SANDBOX_SOURCE };
