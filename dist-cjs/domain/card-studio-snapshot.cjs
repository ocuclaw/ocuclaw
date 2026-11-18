const CARD_STUDIO_SNAPSHOT_CATEGORY = "card.studio";

const CARD_STUDIO_SNAPSHOT_LIMITS = Object.freeze({
  budgetBytes: 1_048_576,
  rowChars: 2000,
  codeChars: 131_072,
  jsonChars: 65_536,
  taskBodyBytes: 4096,
  cronLogBytes: 8192,
  runRecordsPerTask: 10,
  revisions: 20,
  noteChars: 200,
  nameChars: 80,
});

const CARD_STUDIO_DROP_ORDER = Object.freeze([
  "test_pictures",
  "previous_code",
  "review",
  "older_cards",
  "task_output",
  "on_screen_code",
]);

const KEY_NAME = /(?:^|[^a-z])(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pass|pwd|passphrase|auth|authorization|bearer|credential|cookie|session[_-]?id|signature|private[_-]?key|client[_-]?secret)s?(?:$|[^a-z])/i;

const WEAK_KEY_NAME = /(?:^|[^a-z])(?:key|appid|app[_-]?id|api)s?(?:$|[^a-z])/i;
const KEY_NAME_CAMEL = /(?:apiKey|accessKey|secretKey|privateKey|clientSecret|authToken|accessToken|refreshToken|idToken|sessionId|appSecret|appKey)$/;
const KEY_SHAPES = [
  /^(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}$/,
  /^sk-ant-[A-Za-z0-9_-]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  /^(?:AKIA|ASIA)[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{30,}$/,

  /^(?:sk|pk|rk)_(?:live_|test_)?[A-Za-z0-9]{16,}$/,
  /^xai-[A-Za-z0-9]{20,}$/,
  /^gsk_[A-Za-z0-9]{20,}$/,
  /^hf_[A-Za-z0-9]{20,}$/,
  /^glpat-[A-Za-z0-9_-]{20,}$/,
  /^tskey-[A-Za-z0-9-]{16,}$/,
  /^ya29\.[0-9A-Za-z_-]{20,}$/,
  /^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/,
  /^(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}$/,
];

const OPAQUE = /^(?=[A-Za-z0-9_\-+/=.]*\d)(?=[A-Za-z0-9_\-+/=.]*[A-Za-z])[A-Za-z0-9_\-+/=.]{32,}$/;

const TEXT_KEYS = /(?:\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bsk-ant-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bya29\.[0-9A-Za-z_-]{20,}|\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|\b(?:sk|pk|rk)_(?:live_|test_)?[A-Za-z0-9]{16,}|\bxai-[A-Za-z0-9]{20,}|\bgsk_[A-Za-z0-9]{20,}|\bhf_[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\btskey-[A-Za-z0-9-]{16,})/g;

const TEXT_PAIRS = /(?<!«)\b((?:[a-z]+[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|password|passwd|secret|cookie|session[_-]?id|authorization|appid|app[_-]id))(\s*["']?\s*[=:]\s*["']?\s*(?:Bearer\s+|Basic\s+)?)([^\s,;"'`&«»]{4,})/gi;
const PLACEHOLDER = /^«secret:\d+»$/;

const HOLE = "\u0001";

function isRecord(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function keyLikeName(name     ) {
  return typeof name === "string" && name.length > 0 && name.length <= 64 && (KEY_NAME.test(name) || KEY_NAME_CAMEL.test(name));
}

function weakKeyValue(name     , value        ) {
  if (typeof name !== "string" || !name || name.length > 64 || !WEAK_KEY_NAME.test(name)) return false;
  const text = value.trim();
  return text.length >= 8 && !/\s/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text) && !/^\$\{[^}]*\}$/.test(text);
}

const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new))\s*$/;

const CONTROL_HEAD = /(?<![.$]\s*)(?<![\p{L}\p{N}_$])(?:if|while|for|with)\s*$/u;

function keyShaped(value        ) {
  const text = value.trim();
  return KEY_SHAPES.some((shape) => shape.test(text)) || (OPAQUE.test(text) && !/^[0-9.]+$/.test(text) && !/^[a-z]+(?:[._/-][a-z]+)+$/i.test(text));
}

function createCodeSecretPass() {
  const numbers = new Map                ();
  let count = 0;

  function placeholder(secret        ) {
    let n = numbers.get(secret);
    if (n === undefined) {
      n = numbers.size + 1;
      numbers.set(secret, n);
    }
    count += 1;
    return `«secret:${n}»`;
  }

  function queryValues(query        ) {
    return query.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!value || PLACEHOLDER.test(value) || value.startsWith("${")) return pair;

      if (value.includes("${") || value.includes(HOLE)) return pair;
      return `${name}=${placeholder(value)}`;
    }).join("&");
  }

  function urlQueries(text        ) {

    const urls = text.replace(/\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s"'`<>]*/gi, (url) => {
      let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:)([^/@\s]+)@/i, (_m, head, pass) => `${head}${placeholder(pass)}@`);
      const q = out.search(/[?]/);
      if (q < 0) return out;
      const rest = out.slice(q + 1);
      const hash = rest.indexOf("#");
      out = out.slice(0, q + 1) + queryValues(hash >= 0 ? rest.slice(0, hash) : rest) + (hash >= 0 ? rest.slice(hash) : "");
      return out;
    });

    const fragment = /^([?&])([A-Za-z0-9_.-]+=[^\s"'`<>#]*)/.exec(urls);
    return fragment ? fragment[1] + queryValues(fragment[2]) + urls.slice(fragment[0].length) : urls;
  }

  function text(raw     ) {
    if (typeof raw !== "string" || !raw) return raw;
    const withUrls = urlQueries(raw);
    const withPairs = withUrls.replace(TEXT_PAIRS, (_m, name, glue, value) =>
      PLACEHOLDER.test(value) || value.includes(HOLE) ? `${name}${glue}${value}` : `${name}${glue}${placeholder(value)}`);
    return withPairs.replace(TEXT_KEYS, (key) => placeholder(key));
  }

  function stringValue(raw        , keyName     ) {
    if (!raw || PLACEHOLDER.test(raw)) return raw;
    if ((keyLikeName(keyName) && raw.trim().length >= 4 && !/^\$\{[^}]*\}$/.test(raw)) || weakKeyValue(keyName, raw) || keyShaped(raw)) {
      return placeholder(raw);
    }
    return text(raw);
  }

  function value(raw     , keyName      = null, depth = 0)      {
    if (typeof raw === "string") return stringValue(raw, keyName);
    if (raw === null || typeof raw !== "object") return raw;
    if (depth > 32) return null;
    if (Array.isArray(raw)) return raw.map((entry) => value(entry, keyName, depth + 1));
    const out      = {};

    for (const [key, entry] of Object.entries(raw)) {
      Object.defineProperty(out, key, { value: value(entry, key, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  function nameBefore(code        , at        ) {
    let i = at - 1;
    while (i >= 0 && /\s/.test(code[i])) i -= 1;
    if (i >= 0 && code[i] === ",") {
      i -= 1;
      while (i >= 0 && /\s/.test(code[i])) i -= 1;
      if (i < 0 || (code[i] !== "\"" && code[i] !== "'")) return null;
      const quote = code[i];
      const end = i;
      i -= 1;
      while (i >= 0 && code[i] !== quote && code[i] !== "\n") i -= 1;
      return i >= 0 && code[i] === quote ? code.slice(i + 1, end) : null;
    }
    if (i < 0 || (code[i] !== ":" && code[i] !== "=")) return null;
    if (code[i] === "=" && i > 0 && /[=!<>]/.test(code[i - 1])) return null;
    i -= 1;
    while (i >= 0 && /\s/.test(code[i])) i -= 1;
    if (i >= 0 && (code[i] === "\"" || code[i] === "'")) {
      const quote = code[i];
      const end = i;
      i -= 1;
      while (i >= 0 && code[i] !== quote) i -= 1;
      return i >= 0 ? code.slice(i + 1, end) : null;
    }
    const end = i + 1;
    while (i >= 0 && /[A-Za-z0-9_$]/.test(code[i])) i -= 1;
    return end > i + 1 ? code.slice(i + 1, end) : null;
  }

  function code(source     ) {
    if (typeof source !== "string" || !source) return source;
    let out = "";

    let outTail = "";
    const emit = (piece        )       => {
      out += piece;
      outTail = (outTail + (piece.length > 16 ? piece.slice(-16) : piece)).slice(-16);
    };
    let i = 0;
    const n = source.length;

    const heads            = [];
    let headEnd = -1;
    let codeTail = "";
    let passEnd = -1;
    while (i < n) {
      const c = source[i];
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        const stop = end < 0 ? n : end;
        emit(text(source.slice(i, stop)));
        i = stop;
        continue;
      }
      if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end < 0 ? n : end + 2;
        emit(text(source.slice(i, stop)));
        i = stop;
        continue;
      }
      if (c === "/" && ((headEnd >= 0 && i - headEnd <= 64 && /^\s*$/.test(source.slice(headEnd, i)))
        || REGEX_AFTER.test(outTail))) {

        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== "\n") {
          if (source[j] === "\\") { j += 2; continue; }
          if (source[j] === "[") inClass = true;
          else if (source[j] === "]") inClass = false;
          else if (source[j] === "/" && !inClass) break;
          j += 1;
        }
        if (j < n && source[j] === "/") {
          j += 1;
          while (j < n && /[a-z]/i.test(source[j])) j += 1;
          emit(source.slice(i, j));
          i = j;
          continue;
        }
      }
      if (c === "\"" || c === "'") {
        let j = i + 1;
        while (j < n && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
        const body = source.slice(i + 1, Math.min(j, n));
        const swapped = stringValue(body, nameBefore(source, i));
        emit(c + swapped + (j < n && source[j] === c ? c : ""));
        i = j < n && source[j] === c ? j + 1 : j;
        continue;
      }
      if (c === "`") {

        let j = i + 1;
        let depth = 0;
        let holeStart = -1;
        let masked = "";
        const holes           = [];
        while (j < n) {
          if (depth === 0 && source[j] === "\\") { masked += source.slice(j, j + 2); j += 2; continue; }
          if (depth === 0 && source[j] === "`") break;
          if (depth === 0 && source[j] === "$" && source[j + 1] === "{") {
            depth = 1;
            holeStart = j;
            j += 2;
            continue;
          }
          if (depth > 0) {
            if (source[j] === "{") depth += 1;
            else if (source[j] === "}") {
              depth -= 1;
              if (depth === 0) {
                masked += `${HOLE}${holes.length}${HOLE}`;
                holes.push(source.slice(holeStart, j + 1));
              }
            }
            j += 1;
            continue;
          }
          masked += source[j];
          j += 1;
        }
        if (depth > 0) masked += source.slice(holeStart, j);
        const swapped = holes.length ? text(masked) : stringValue(masked, nameBefore(source, i));
        emit("`" + swapped.replace(new RegExp(`${HOLE}(\\d+)${HOLE}`, "g"), (_m        , k        ) => holes[Number(k)]) + (j < n ? "`" : ""));
        i = j < n ? j + 1 : n;
        continue;
      }
      if (passEnd !== i) codeTail = "";
      if (c === "(") heads.push(CONTROL_HEAD.test(codeTail));
      emit(c);
      codeTail = (codeTail + c).slice(-32);
      passEnd = i + 1;
      if (c === ")") headEnd = heads.pop() ? passEnd : -1;
      i += 1;
    }
    return out;
  }

  return { code, value, text, count: () => count };
}

function cutAt(text        , max        ) {
  if (text.length <= max) return text.length;
  let at = max;
  const before = text.charCodeAt(at - 1);
  if (before >= 0xd800 && before <= 0xdbff) at -= 1;
  return at;
}

function cardStudioTextRows(text        , max = CARD_STUDIO_SNAPSHOT_LIMITS.rowChars) {
  const rows                                              = [];
  if (typeof text !== "string" || !text) return rows;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let current = "";
  for (let line of lines) {
    if (current.length + line.length <= max) {
      current += line;
      continue;
    }
    if (current) {
      rows.push({ text: current, continued: false });
      current = "";
    }
    while (line.length > max) {
      const at = cutAt(line, max);
      rows.push({ text: line.slice(0, at), continued: true });
      line = line.slice(at);
    }
    current = line;
  }
  if (current) rows.push({ text: current, continued: false });
  return rows;
}

function utf8Bytes(text        ) {
  return new TextEncoder().encode(text).byteLength;
}

function tailBytes(text        , maxBytes        ) {
  if (utf8Bytes(text) <= maxBytes) return { text, cut: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (utf8Bytes(text.slice(mid)) <= maxBytes) hi = mid; else lo = mid + 1;
  }
  let at = lo;
  const c = text.charCodeAt(at);
  if (c >= 0xdc00 && c <= 0xdfff) at += 1;
  return { text: text.slice(at), cut: true };
}

function headBytes(text        , maxBytes        ) {
  if (utf8Bytes(text) <= maxBytes) return { text, cut: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  return { text: text.slice(0, cutAt(text, lo)), cut: true };
}

function shortText(value     , max        ) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, cutAt(text, max)) : null;
}

const stamp = (v     ) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const code = (v     ) => (typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : null);

function jsonText(value     , maxChars        ) {
  if (value === undefined) return null;
  let text                    ;
  try { text = JSON.stringify(value); } catch { return null; }
  if (typeof text !== "string") return null;
  return text.length > maxChars ? { text: text.slice(0, cutAt(text, maxChars)), cut: true } : { text, cut: false };
}

function cardStudioReviewWithoutCode(review     )      {
  const strip = (value     , depth        )      => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.map((entry) => strip(entry, depth + 1));
    if (!isRecord(value)) return value;
    const out      = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "source" && typeof entry === "string") { out.sourceLength = entry.length; continue; }
      if (key === "png" || key === "lz4" || key === "picture" || key === "image") continue;
      out[key] = strip(entry, depth + 1);
    }
    return out;
  };
  return isRecord(review) ? strip(review, 0) : null;
}

function cardStudioTaskFacts(row     ) {
  const run = isRecord(row?.run) ? row.run : {};
  return {
    state: code(run.state),
    reasonCode: code(run.reason),
    startedAtMs: stamp(run.startedAtMs),
    endedAtMs: stamp(run.endedAtMs),
    retryAtMs: stamp(run.retryAtMs),
    skippedWhy: code(run.skippedWhy),
    syncError: code(run.syncError),
    resultAtMs: stamp(row?.latest?.createdAtMs),
    nextAtMs: stamp(row?.nextRunAtMs),
    missedCount: Number.isSafeInteger(row?.missedCount) && row.missedCount >= 0 ? row.missedCount : 0,
    schedule: row?.paused === true ? "paused" : row?.ask === true ? "ask" : stamp(row?.nextRunAtMs) !== null ? "on" : null,
    stale: typeof row?.stale === "boolean" ? row.stale : null,
    unchecked: isRecord(row?.unchecked) ? { atMs: stamp(row.unchecked.atMs), reasonCode: code(row.unchecked.reason) } : null,
  };
}

function flatRecord(entry                         ) {
  const out      = {};
  for (const [key, value] of Object.entries(entry).slice(0, 8)) {
    if (typeof value === "string") out[key] = value.slice(0, cutAt(value, 64));
    else if (value === null || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function runRecordData(record     ) {
  if (!isRecord(record)) return null;
  const out      = {};
  for (const [key, value] of Object.entries(record).slice(0, 32)) {
    if (typeof value === "string") out[key] = value.slice(0, cutAt(value, 200));
    else if (value === null || typeof value === "number" || typeof value === "boolean") out[key] = value;

    else if (Array.isArray(value)) out[key] = value.slice(0, 16).map((entry) => (Array.isArray(entry) ? null : isRecord(entry) ? flatRecord(entry) : entry));
    else if (isRecord(value)) out[key] = Object.fromEntries(Object.entries(value                           ).slice(0, 16).filter(([, v]) => v === null || typeof v !== "object"));
  }
  return out;
}

function buildCardStudioSnapshot(input      = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const budgetBytes = Number.isFinite(input.budgetBytes) && input.budgetBytes > 0 ? input.budgetBytes : CARD_STUDIO_SNAPSHOT_LIMITS.budgetBytes;
  const pass = input.secretPass && typeof input.secretPass.code === "function" ? input.secretPass : createCodeSecretPass();
  const cards = (Array.isArray(input.cards) ? input.cards : []).filter((card     ) => isRecord(card) && typeof card.cardKey === "string");
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).filter((task     ) => isRecord(task) && typeof task.taskId === "string");

  const keptKey = (cards.find((card     ) => card.onScreen === true) || cards[0] || {}).cardKey ?? null;

  const items         = [];
  let order = 0;
  const push = (file              , group        , owner               , event        , data     , ts = nowMs) => {
    items.push({ group, owner, file, order: order++, row: { ts, cat: CARD_STUDIO_SNAPSHOT_CATEGORY, event, severity: "info", data } });
  };
  const chunked = (file              , group        , owner               , event        , base     , text        , key        ) => {
    const rows = cardStudioTextRows(text);
    rows.forEach((row, part) => push(file, group, owner, event, { ...base, part, parts: rows.length, continued: row.continued, [key]: row.text }));
  };

  for (const row of Array.isArray(input.streamRows) ? input.streamRows : []) {
    if (!isRecord(row)) continue;
    const owner = isRecord(row.data) && typeof row.data.cardKey === "string" ? row.data.cardKey : null;

    if (row.event === "card_start_state" && isRecord(row.data)) {
      const { state: raw, ...base } = row.data;
      const state = jsonText(pass.value(raw), CARD_STUDIO_SNAPSHOT_LIMITS.jsonChars);
      if (!state) continue;
      const parts = cardStudioTextRows(state.text);
      parts.forEach((part, index) => push("stream", "stream", owner, "card_start_state",
        { ...base, cut: state.cut, part: index, parts: parts.length, continued: part.continued, json: part.text }, Number.isFinite(row.ts) ? row.ts : nowMs));
      continue;
    }
    items.push({ group: row.event === "card_build_picture" ? "test_pictures" : "stream", owner, file: "stream", order: order++, row });
  }

  for (const card of cards) {
    const owner = card.cardKey;
    const revisions = (Array.isArray(card.revisions) ? card.revisions : []).slice(-CARD_STUDIO_SNAPSHOT_LIMITS.revisions)
      .filter(isRecord).map((revision     ) => ({
        number: Number.isSafeInteger(revision.number) ? revision.number : null,
        by: code(revision.by),
        note: revision.note == null ? null : pass.text(shortText(revision.note, CARD_STUDIO_SNAPSHOT_LIMITS.noteChars)),
        savedAtMs: stamp(revision.savedAtMs),
        digest: typeof revision.digest === "string" ? revision.digest.slice(0, 128) : null,
      }));
    const lastError = isRecord(card.lastError) || typeof card.lastError === "string"
      ? pass.text(shortText(typeof card.lastError === "string" ? card.lastError : card.lastError.message, 500)) : null;
    push("cards", "card", owner, "card_snapshot", {
      cardKey: owner,
      name: pass.text(shortText(card.name, CARD_STUDIO_SNAPSHOT_LIMITS.nameChars)),
      onScreen: card.onScreen === true,
      why: code(card.why),
      touchedAtMs: stamp(card.atMs),
      currentRevision: Number.isSafeInteger(card.currentRevision) ? card.currentRevision : null,
      unsaved: Number.isSafeInteger(card.unsaved) && card.unsaved > 0 ? card.unsaved : 0,
      lastError,
      revisions,
    });
    for (const entry of Array.isArray(card.codes) ? card.codes : []) {
      if (!isRecord(entry) || typeof entry.code !== "string" || !entry.code) continue;
      const which = entry.which === "previous" || entry.which === "draft" ? entry.which : "current";
      const group = which === "previous" ? "previous_code" : owner === keptKey ? "on_screen_code" : "card";
      const source = entry.code.length > CARD_STUDIO_SNAPSHOT_LIMITS.codeChars ? entry.code.slice(0, CARD_STUDIO_SNAPSHOT_LIMITS.codeChars) : entry.code;
      chunked("cards", group, owner, "card_code", {
        cardKey: owner, which, revision: Number.isSafeInteger(entry.revision) ? entry.revision : null, length: entry.code.length,
      }, pass.code(source), "code");
    }
    const state = jsonText(pass.value(card.state), CARD_STUDIO_SNAPSHOT_LIMITS.jsonChars);
    if (state) chunked("cards", "card", owner, "card_state", { cardKey: owner, cut: state.cut }, state.text, "json");
    const review = cardStudioReviewWithoutCode(card.review);
    const reviewText = review ? jsonText(pass.value(review), CARD_STUDIO_SNAPSHOT_LIMITS.jsonChars) : null;
    if (reviewText) chunked("cards", "review", owner, "card_review", { cardKey: owner, cut: reviewText.cut }, reviewText.text, "json");
  }

  for (const task of tasks) {
    const owner = `task:${task.taskId}`;
    push("tasks", "task", owner, "task_snapshot", {
      taskId: task.taskId,
      name: pass.text(shortText(task.name, CARD_STUDIO_SNAPSHOT_LIMITS.nameChars)),
      jobId: typeof task.jobId === "string" ? task.jobId.slice(0, 128) : null,
      kind: code(task.row?.kind),
      ...cardStudioTaskFacts(task.row),
    });
    const records = (Array.isArray(task.runRecords) ? task.runRecords : []).slice(0, CARD_STUDIO_SNAPSHOT_LIMITS.runRecordsPerTask);
    for (const record of records) {
      const data = runRecordData(record);
      if (data) push("tasks", "task", owner, "task_run_record", { taskId: task.taskId, ...data });
    }
    const result = isRecord(task.result) ? task.result : null;
    if (result) {
      const body = typeof result.body === "string" ? headBytes(pass.text(result.body), CARD_STUDIO_SNAPSHOT_LIMITS.taskBodyBytes) : null;
      push("tasks", "task_output", owner, "task_result", {
        taskId: task.taskId,
        status: code(result.status),
        headline: pass.text(shortText(result.headline, 200)),
        createdAtMs: stamp(result.createdAtMs),
        truncated: result.truncated === true,
        bodyCut: body ? body.cut : false,
        hasValues: result.values !== undefined && result.values !== null,
      });
      if (body && body.text) chunked("tasks", "task_output", owner, "task_result_body", { taskId: task.taskId }, body.text, "text");
      const values = result.values === undefined || result.values === null ? null : jsonText(pass.value(result.values), CARD_STUDIO_SNAPSHOT_LIMITS.taskBodyBytes);
      if (values) chunked("tasks", "task_output", owner, "task_result_values", { taskId: task.taskId, cut: values.cut }, values.text, "json");
    }
    const cron = isRecord(task.cronLog) && typeof task.cronLog.text === "string" && task.cronLog.text ? task.cronLog : null;
    if (cron) {
      const tail = tailBytes(pass.text(cron.text), CARD_STUDIO_SNAPSHOT_LIMITS.cronLogBytes);
      chunked("tasks", "task_output", owner, "task_cron_log", { taskId: task.taskId, atMs: stamp(cron.atMs), cut: tail.cut }, tail.text, "text");
    }
  }

  const size = new Map              ();
  const bytesOf = (item      ) => {
    let bytes = size.get(item);
    if (bytes === undefined) {
      bytes = utf8Bytes(JSON.stringify(item.row)) + 24;
      size.set(item, bytes);
    }
    return bytes;
  };
  let total = items.reduce((sum, item) => sum + bytesOf(item), 0);
  const dropped           = [];
  let droppedCards = 0;
  const live = new Set(items);
  const drop = (pick                         ) => {
    let any = false;
    for (const item of items) {
      if (live.has(item) && pick(item)) {
        live.delete(item);
        total -= bytesOf(item);
        any = true;
      }
    }
    return any;
  };
  for (const step of CARD_STUDIO_DROP_ORDER) {
    if (total <= budgetBytes) break;
    if (step === "older_cards") {

      const older = cards.map((card     ) => card.cardKey).filter((key        ) => key !== keptKey).reverse();
      for (const key of older) {
        if (total <= budgetBytes) break;
        if (drop((item) => item.owner === key)) droppedCards += 1;
      }
      if (droppedCards > 0) dropped.push(step);
      continue;
    }
    if (drop((item) => item.group === step)) dropped.push(step);
  }
  if (total > budgetBytes) {

    const rest = items.filter((item) => live.has(item) && item.group !== "card" && item.group !== "task")
      .sort((a, b) => (a.row.ts - b.row.ts) || (a.order - b.order));
    for (const item of rest) {
      if (total <= budgetBytes) break;
      live.delete(item);
      total -= bytesOf(item);
    }
    for (const item of [...items].reverse()) {
      if (total <= budgetBytes) break;
      if (!live.has(item)) continue;
      live.delete(item);
      total -= bytesOf(item);
    }
    dropped.push("over_budget");
  }

  const summary = {
    cards: cards.length,
    tasks: tasks.length,
    secrets: pass.count(),
    budgetBytes,
    bytes: total,
    dropped,
    droppedCards,
  };
  const kept = (file              ) => items.filter((item) => item.file === file && live.has(item)).map((item) => item.row);
  const cardRows = [{ ts: nowMs, cat: CARD_STUDIO_SNAPSHOT_CATEGORY, event: "card_studio_snapshot", severity: "info", data: summary }, ...kept("cards")];
  return { streamRows: kept("stream"), cardRows, taskRows: kept("tasks"), summary };
}

module.exports = { CARD_STUDIO_SNAPSHOT_CATEGORY, CARD_STUDIO_SNAPSHOT_LIMITS, CARD_STUDIO_DROP_ORDER, createCodeSecretPass, cardStudioTextRows, cardStudioReviewWithoutCode, cardStudioTaskFacts, buildCardStudioSnapshot };
