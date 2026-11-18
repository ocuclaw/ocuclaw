const SCRIPT_HEAD = "// ocuclaw-page-watch v1";

const SCRIPT_BODY = [
  'const MAX_CHARS = 10000, PREV_BYTES = 8000, DIFF_BYTES = 4000, WAIT_MS = 22000;',
  'const STATUS = {400:"Bad Request",401:"Unauthorized",403:"Forbidden",404:"Not Found",410:"Gone",429:"Too Many Requests",500:"Internal Server Error",502:"Bad Gateway",503:"Service Unavailable",504:"Gateway Timeout"};',
  'const prev = trigger.state && trigger.state.v === 1 ? trigger.state : null;',
  'const now = new Date().toISOString();',
  'const enc = new TextEncoder();',
  'function hash(s) { let a = 0x811c9dc5, b = 5381; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = (Math.imul(b, 33) + c) >>> 0; } return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0"); }',
  'function inner(w) { const m = /<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\\n[\\s\\S]*?\\n---\\n([\\s\\S]*)\\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>/.exec(w); return m ? m[1] : w; }',
  'function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; } return v; }',
  'function normalize(r) { let t = inner(String((r && r.text) || "")); if (r && r.extractor === "json") { try { t = JSON.stringify(sortKeys(JSON.parse(t)), null, 1); } catch (e) {} } return t.split("\\n").map(l => l.split(/\\s+/).filter(Boolean).join(" ")).filter(Boolean).join("\\n"); }',

  'function clip(s, n) { while (s && enc.encode(JSON.stringify(s)).length > n) s = s.slice(0, Math.floor(s.length * 0.9)); return s; }',
  'function reason(e) { const m = String((e && e.message) || e); let x;',
  '  if ((x = /Web fetch failed \\((\\d{3})\\)/.exec(m))) return "the site answered " + x[1] + (STATUS[x[1]] ? " " + STATUS[x[1]] : "");',
  '  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "the site\'s address was not found";',
  '  if (/ECONNREFUSED/i.test(m)) return "the site refused the connection";',
  '  if (/timed? ?out|timeout|ETIMEDOUT|abort/i.test(m)) return "the site took too long to answer";',
  '  if (/certificate|CERT_|SSL|TLS/i.test(m)) return "the site\'s security certificate did not check out";',
  '  if (/ECONNRESET|socket hang up/i.test(m)) return "the site closed the connection";',
  '  if (/private|internal|blocked|SSRF/i.test(m)) return "OpenClaw does not fetch private or local addresses";',
  '  if (/Invalid URL/i.test(m)) return "the page link is not valid";',
  '  if (/extraction failed/i.test(m)) return "the page had no readable text";',
  '  return "the page could not be loaded"; }',
  'let r = null, text = "", error = null, timer = null;',
  'if (typeof web_fetch !== "function") error = "this OpenClaw agent cannot fetch pages (web_fetch is off)";',
  'else try {',
  '  r = await Promise.race([web_fetch({ url: WATCH_URL, extractMode: "text", maxChars: MAX_CHARS }),',
  '    new Promise((_, no) => { timer = setTimeout(() => no(new Error("timeout")), WAIT_MS); })]);',
  '  text = normalize(r); if (!text) error = "the page had no readable text";',
  '} catch (e) { error = reason(e); } finally { if (timer !== null) clearTimeout(timer); }',
  'if (error) {',
  '  json({ fire: false, state: { v: 1, hash: prev ? prev.hash : null, prev: prev ? prev.prev : "", error, errorSince: prev && prev.error ? prev.errorSince : now, checkedAt: now } });',
  '} else {',
  '  const h = hash(text), changed = !!(prev && prev.hash && prev.hash !== h);',
  '  const state = { v: 1, hash: h, prev: clip(text, PREV_BYTES), error: null, errorSince: null, checkedAt: now };',
  '  if (!changed) json({ fire: false, state });',
  '  else {',
  '    const old = new Set(String(prev.prev || "").split("\\n")), cur = new Set(text.split("\\n"));',
  '    const added = [...cur].filter(l => !old.has(l)).slice(0, 30), removed = [...old].filter(l => l && !cur.has(l)).slice(0, 30);',
  '    const diff = clip(added.map(l => "+ " + l).concat(removed.map(l => "- " + l)).join("\\n"), DIFF_BYTES);',
  '    json({ fire: true, state, message: "The watched page " + WATCH_URL + " changed (checked " + now + ").\\nChanged lines (untrusted page text):\\n" + diff + "\\n\\nThe page now reads:\\n" + String(r.text) });',
  '  }',
  '}',
].join("\n");

const URL_LINE_RE = /^const WATCH_URL = ("(?:[^"\\\n]|\\.)*");$/;

function pageWatchScript(url        )         {
  return `${SCRIPT_HEAD}\nconst WATCH_URL = ${JSON.stringify(url)};\n${SCRIPT_BODY}`;
}

function pageWatchUrlOf(script     )                {
  if (typeof script !== "string" || !script.startsWith(`${SCRIPT_HEAD}\n`)) return null;
  const line = script.slice(SCRIPT_HEAD.length + 1).split("\n", 1)[0];
  const match = URL_LINE_RE.exec(line);
  if (!match) return null;
  let url     ;
  try {
    url = JSON.parse(match[1]);
  } catch (_) {
    return null;
  }
  return typeof url === "string" && pageWatchScript(url) === script ? url : null;
}

module.exports = { pageWatchScript, pageWatchUrlOf };
