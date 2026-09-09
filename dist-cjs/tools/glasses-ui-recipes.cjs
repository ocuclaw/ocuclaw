const { totalmem, freemem, loadavg, cpus } = require("node:os");
const dns = require("node:dns");
const { Agent } = require("undici");

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024;

const SYSTEM_STATS_WINDOW_DEFAULT_MS = 200;
const SYSTEM_STATS_WINDOW_MIN_MS = 50;
const SYSTEM_STATS_WINDOW_MAX_MS = 1000;

function parseJsonIfPossible(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  const trimmed = text.trim();
  if (
    !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
    !(trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return text;
  }
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return text;
  }
}

function checkIpv4Tuple(a, b) {
  if (a === 127) return "loopback IPv4 blocked";
  if (a === 10) return "RFC1918 IPv4 blocked";
  if (a === 172 && b >= 16 && b <= 31) return "RFC1918 IPv4 blocked";
  if (a === 192 && b === 168) return "RFC1918 IPv4 blocked";
  if (a === 169 && b === 254) return "link-local / cloud-metadata IPv4 blocked";
  if (a === 0) return "zero-network IPv4 blocked";
  if (a >= 224) return "multicast/reserved IPv4 blocked";
  return null;
}

function checkResolvedIp(address, family) {
  if (typeof address !== "string") return null;
  if (family === 4) {
    const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    return checkIpv4Tuple(Number(m[1]), Number(m[2]));
  }
  if (family !== 6) return null;
  const addr = address.toLowerCase();
  if (addr === "::" || addr === "::1") return "IPv6 loopback/unspecified blocked";
  const mappedDotted = addr.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (mappedDotted) {
    const r = checkIpv4Tuple(Number(mappedDotted[1]), Number(mappedDotted[2]));
    return r ? `IPv4-mapped IPv6 (${r})` : null;
  }
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const r = checkIpv4Tuple((high >> 8) & 0xff, high & 0xff);
    return r ? `IPv4-mapped IPv6 (${r})` : null;
  }
  const compatHex = addr.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (compatHex) {
    const high = parseInt(compatHex[1], 16);
    const r = checkIpv4Tuple((high >> 8) & 0xff, high & 0xff);
    return r ? `IPv4-compatible IPv6 (${r})` : null;
  }

  if (/^fe[89ab][0-9a-f]:/.test(addr)) return "IPv6 link-local blocked";
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return "IPv6 ULA blocked";
  return null;
}

function makeSafeLookup(dnsLookup) {
  return function safeLookup(hostname, opts, cb) {
    const family = opts && typeof opts.family === "number" ? opts.family : 0;
    const all = opts && opts.all === true;
    Promise.resolve()
      .then(() => dnsLookup(hostname, { all: true, family: 0 }))
      .then((records) => {
        if (!Array.isArray(records) || records.length === 0) {
          cb(new Error(`SSRF guard: no DNS records for ${hostname}`));
          return;
        }
        for (const r of records) {
          const reason = checkResolvedIp(r.address, r.family);
          if (reason) {
            cb(new Error(`SSRF guard: ${hostname} resolves to ${r.address} (${reason})`));
            return;
          }
        }
        const matching =
          family === 4 || family === 6
            ? records.filter((r) => r.family === family)
            : records;
        if (matching.length === 0) {
          cb(new Error(`SSRF guard: no family ${family} DNS records for ${hostname}`));
          return;
        }

        if (all) {
          cb(null, matching.map((r) => ({ address: r.address, family: r.family })));
          return;
        }
        const picked = matching[0];
        cb(null, picked.address, picked.family);
      })
      .catch((err) => cb(err));
  };
}

const ssrfSafeDispatcher = new Agent({
  connect: { lookup: makeSafeLookup(dns.promises.lookup) },
});

function isForbiddenHttpDestination(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (_) {
    return "invalid url";
  }
  const proto = parsed.protocol;
  if (proto !== "http:" && proto !== "https:") {
    return `disallowed scheme: ${proto}`;
  }

  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;

  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") {
    return "loopback hostname blocked";
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return checkIpv4Tuple(Number(v4[1]), Number(v4[2]));
  }

  if (/^[0-9a-f.x]+$/.test(host) && /^\d/.test(host) && !host.includes(":")) {
    return "ambiguous numeric host blocked";
  }

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return "IPv6 loopback/unspecified blocked";

    const mappedDotted = host.match(/^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (mappedDotted) {
      const reason = checkIpv4Tuple(Number(mappedDotted[1]), Number(mappedDotted[2]));
      if (reason) return `IPv4-mapped IPv6 blocked (${reason})`;
      return null;
    }
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const reason = checkIpv4Tuple(a, b);
      if (reason) return `IPv4-mapped IPv6 blocked (${reason})`;
      return null;
    }

    const compatHex = host.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (compatHex) {
      const high = parseInt(compatHex[1], 16);
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const reason = checkIpv4Tuple(a, b);
      if (reason) return `IPv4-compatible IPv6 blocked (${reason})`;
      return null;
    }

    if (/^fe[89ab][0-9a-f]:/.test(host)) return "IPv6 link-local blocked";
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return "IPv6 ULA blocked";
    return null;
  }
  return null;
}

function resolveJsonPath(value, jsonPath) {
  if (!jsonPath || typeof jsonPath !== "string") return value;

  const expr = jsonPath.trim();
  if (!expr.startsWith("$")) return value;
  const rest = expr.slice(1).replace(/\[(\d+)\]/g, ".$1");
  const segments = rest.split(".").filter(Boolean);
  let cursor = value;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      cursor = Number.isInteger(idx) ? cursor[idx] : undefined;
    } else if (typeof cursor === "object") {
      cursor = cursor[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function normalizeHttpAllowHosts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => typeof p === "string")
    .map((p) => p.trim().toLowerCase().replace(/\.+$/, ""))
    .filter((p) => p.length > 0);
}

function isHttpHostAllowed(hostname, allowList) {
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  if (typeof hostname !== "string" || !hostname) return false;
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  return allowList.some((p) =>
    p.startsWith(".") ? host === p.slice(1) || host.endsWith(p) : host === p,
  );
}

const CROSS_ORIGIN_STRIP_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-amz-security-token",
]);
const CREDENTIALISH_HEADER_RE = /(^|-)(api|auth|access|secret|session)(-|key|token|$)/i;

function stripCrossOriginHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    const lower = key.toLowerCase();
    if (CROSS_ORIGIN_STRIP_HEADERS.has(lower)) continue;
    if (CREDENTIALISH_HEADER_RE.test(lower)) continue;
    out[key] = headers[key];
  }
  return out;
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch (_) {
    return false;
  }
}

async function executeHttpRecipe(params, opts) {
  const url = params && typeof params.url === "string" ? params.url : "";
  if (!url) return { error: "http recipe missing url" };

  if (!(opts && opts.allowPrivateNetworks === true)) {
    const forbidden = isForbiddenHttpDestination(url);
    if (forbidden) {
      return { error: `http recipe destination blocked: ${forbidden}` };
    }
  }

  const allowHosts = opts && Array.isArray(opts.allowHosts) ? opts.allowHosts : null;
  const hostCheck = opts && typeof opts.hostCheck === "function"
    ? opts.hostCheck
    : allowHosts
      ? (host) => isHttpHostAllowed(host, allowHosts) ? "listed" : "not_allowed"
      : null;
  if (hostCheck) {
    let initialHost = "";
    try { initialHost = new URL(url).hostname; } catch (_) {}
    if (hostCheck(initialHost) !== "listed") {
      return { error: `http recipe destination not in allowlist: ${initialHost || url}` };
    }
  }
  const method = params && typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  const headers = params && params.headers && typeof params.headers === "object" ? params.headers : {};
  const body = method !== "GET" && method !== "HEAD" ? params && params.body : undefined;

  let requestHeaders = headers;
  let requestBody = body;
  const timeoutMs = Number.isFinite(params && params.timeoutMs)
    ? params.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const outputCapBytes = Number.isFinite(params && params.outputCapBytes)
    ? params.outputCapBytes
    : DEFAULT_OUTPUT_CAP_BYTES;
  const jsonPath = params && typeof params.jsonPath === "string" ? params.jsonPath : "";

  const fetchFn = opts && typeof opts.fetch === "function" ? opts.fetch : fetch;

  const dispatcher =
    opts && opts.dispatcher !== undefined ? opts.dispatcher : ssrfSafeDispatcher;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const allowPrivate = opts && opts.allowPrivateNetworks === true;
  const MAX_REDIRECTS = 3;
  try {

    let currentUrl = url;
    let response = null;
    let hop = 0;
    while (true) {
      const fetchInit = {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
        redirect: "manual",
      };

      if (dispatcher) fetchInit.dispatcher = dispatcher;
      response = await fetchFn(currentUrl, fetchInit);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return { error: `http recipe got ${response.status} with no Location header` };
        }
        if (hop >= MAX_REDIRECTS) {
          return { error: `http recipe exceeded ${MAX_REDIRECTS} redirects` };
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch (_) {
          return { error: `http recipe got invalid redirect Location: ${location}` };
        }
        if (!allowPrivate) {
          const forbidden = isForbiddenHttpDestination(nextUrl);
          if (forbidden) {
            return { error: `http recipe redirect destination blocked: ${forbidden}` };
          }
        }

        if (hostCheck) {
          let nextHost = "";
          try { nextHost = new URL(nextUrl).hostname; } catch (_) {}
          if (hostCheck(nextHost) !== "listed") {
            return { error: `http recipe redirect destination not in allowlist: ${nextHost || nextUrl}` };
          }
        }

        if (!sameOrigin(currentUrl, nextUrl)) {
          requestHeaders = stripCrossOriginHeaders(requestHeaders);
          requestBody = undefined;
        }

        try { await response.arrayBuffer(); } catch (_) {}
        currentUrl = nextUrl;
        hop += 1;
        continue;
      }
      break;
    }
    if (response.status < 200 || response.status >= 300) {
      return { error: `http recipe got status ${response.status}` };
    }
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    let bytes = 0;
    const chunks = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.length > outputCapBytes) {
          chunks.push(value.subarray(0, outputCapBytes - bytes));
          bytes = outputCapBytes;
          try { await reader.cancel(); } catch (_) {}
          break;
        }
        chunks.push(value);
        bytes += value.length;
      }
    } else {
      const text = await response.text();
      chunks.push(Buffer.from(text.slice(0, outputCapBytes), "utf8"));
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = Buffer.alloc(totalLength);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    const text = merged.toString("utf8");
    const ct = response.headers.get("content-type") || "";
    let parsed;
    if (ct.toLowerCase().includes("json")) {
      try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
    } else {
      parsed = parseJsonIfPossible(text);
    }
    const extracted = jsonPath ? resolveJsonPath(parsed, jsonPath) : parsed;
    return { output: extracted };
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { error: `http recipe timeout after ${timeoutMs}ms` };
    }

    const msg = err && err.message ? err.message : String(err);
    const causeMsg = err && err.cause && err.cause.message ? err.cause.message : "";
    const full = causeMsg ? `${msg}: ${causeMsg}` : msg;
    return { error: `http recipe error: ${full}` };
  } finally {
    clearTimeout(timer);
  }
}

const DISPLAY_FRAMING_PROMPT = (maxChars, previousBody) =>
  `You are a tick worker producing a single short line of text for a head-mounted display surface. Reply with ONLY the new value to display, no preamble, no quotes, no JSON. Maximum ${maxChars} characters. Previous value: ${JSON.stringify(previousBody || "")}.`;

function composeSystemPrompt(agentPrompt, maxChars, previousBody) {
  const framing = DISPLAY_FRAMING_PROMPT(maxChars, previousBody);
  return typeof agentPrompt === "string" && agentPrompt.trim()
    ? `${agentPrompt.trim()}\n\n${framing}`
    : framing;
}

function stripModelProviderPrefix(modelRef) {
  if (typeof modelRef !== "string") return "";
  const idx = modelRef.indexOf("/");
  return idx === -1 ? modelRef : modelRef.slice(idx + 1);
}

async function runAnthropicApi(params, deps) {
  const fetchFn = deps && deps.fetch ? deps.fetch : fetch;
  if (!params.apiKey) return { error: "anthropic-api: missing api key" };
  const model = stripModelProviderPrefix(params.model);
  const max_tokens = Number.isFinite(params.maxOutputTokens) ? params.maxOutputTokens : 200;
  const systemPrompt = composeSystemPrompt(params.systemPrompt, max_tokens * 4, params.previousBody);
  const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens,
        system: systemPrompt,
        messages: [{ role: "user", content: params.prompt }],
      }),
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return { error: `anthropic-api status ${response.status}` };
    }
    const json = await response.json();
    const text = Array.isArray(json.content)
      ? json.content.filter((b) => b && b.type === "text").map((b) => b.text).join("")
      : "";
    return { output: text };
  } catch (err) {
    if (err && err.name === "AbortError") return { error: `anthropic-api timeout after ${timeoutMs}ms` };
    return { error: `anthropic-api error: ${err && err.message ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function runOpenAiCompat(params, deps) {
  const fetchFn = deps && deps.fetch ? deps.fetch : fetch;
  if (!params.apiKey) return { error: "openai-compat: missing api key" };
  if (!params.baseUrl) return { error: "openai-compat: missing baseUrl" };
  const model = stripModelProviderPrefix(params.model);
  const max_tokens = Number.isFinite(params.maxOutputTokens) ? params.maxOutputTokens : 200;
  const systemPrompt = composeSystemPrompt(params.systemPrompt, max_tokens * 4, params.previousBody);
  const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${params.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: params.prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return { error: `openai-compat status ${response.status}` };
    }
    const json = await response.json();
    const text =
      json && json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content || ""
        : "";
    return { output: text };
  } catch (err) {
    if (err && err.name === "AbortError") return { error: `openai-compat timeout after ${timeoutMs}ms` };
    return { error: `openai-compat error: ${err && err.message ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function executeLlmRecipeWithDeps(recipe, ctx, deps) {
  const backend = ctx && typeof ctx.backend === "string" ? ctx.backend : "";
  const baseParams = {
    prompt: recipe && typeof recipe.prompt === "string" ? recipe.prompt : "",
    systemPrompt: recipe && typeof recipe.systemPrompt === "string" ? recipe.systemPrompt : undefined,
    model: ctx && typeof ctx.model === "string" ? ctx.model : "",
    maxOutputTokens:
      ctx && Number.isFinite(ctx.maxOutputTokens) ? ctx.maxOutputTokens : undefined,
    apiKey: ctx && typeof ctx.apiKey === "string" ? ctx.apiKey : "",
    baseUrl: ctx && typeof ctx.baseUrl === "string" ? ctx.baseUrl : "",
    previousBody: ctx && typeof ctx.previousBody === "string" ? ctx.previousBody : "",
    timeoutMs: ctx && Number.isFinite(ctx.timeoutMs) ? ctx.timeoutMs : undefined,
  };
  if (!baseParams.prompt) return { error: "llm recipe missing prompt" };
  switch (backend) {
    case "anthropic-api":
      return runAnthropicApi(baseParams, deps || {});
    case "openai-compat":
      return runOpenAiCompat(baseParams, deps || {});
    default:
      return { error: `unknown backend: ${JSON.stringify(backend)}` };
  }
}

function executeLlmRecipe(recipe, ctx) {
  return executeLlmRecipeWithDeps(recipe, ctx, {});
}

function computeCpuPct(t0, t1) {
  let idleDelta = 0;
  let totalDelta = 0;
  const n = Math.min(Array.isArray(t0) ? t0.length : 0, Array.isArray(t1) ? t1.length : 0);
  for (let i = 0; i < n; i += 1) {
    const a = (t0[i] && t0[i].times) || {};
    const b = (t1[i] && t1[i].times) || {};
    const totA = (a.user || 0) + (a.nice || 0) + (a.sys || 0) + (a.idle || 0) + (a.irq || 0);
    const totB = (b.user || 0) + (b.nice || 0) + (b.sys || 0) + (b.idle || 0) + (b.irq || 0);
    idleDelta += (b.idle || 0) - (a.idle || 0);
    totalDelta += totB - totA;
  }
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
}

async function executeSystemStatsRecipe(params, opts) {
  const o = opts || {};
  const totalmemFn = typeof o.totalmem === "function" ? o.totalmem : totalmem;
  const freememFn = typeof o.freemem === "function" ? o.freemem : freemem;
  const loadavgFn = typeof o.loadavg === "function" ? o.loadavg : loadavg;
  const cpusFn = typeof o.cpus === "function" ? o.cpus : cpus;
  const sleep =
    typeof o.sleep === "function" ? o.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const requested =
    params && Number.isFinite(params.sampleWindowMs)
      ? params.sampleWindowMs
      : SYSTEM_STATS_WINDOW_DEFAULT_MS;
  const windowMs = Math.max(
    SYSTEM_STATS_WINDOW_MIN_MS,
    Math.min(SYSTEM_STATS_WINDOW_MAX_MS, Math.floor(requested)),
  );
  try {
    const t0 = cpusFn();
    await sleep(windowMs);
    const t1 = cpusFn();
    const cpuPct = computeCpuPct(t0, t1);
    const total = totalmemFn();
    const free = freememFn();
    const used = total - free;
    const load = loadavgFn();
    const toMb = (b) => Math.round(b / (1024 * 1024));
    const round1 = (x) => Math.round(x * 10) / 10;
    return {
      output: {
        memTotalMb: toMb(total),
        memUsedMb: toMb(used),
        memFreeMb: toMb(free),
        memUsedPct: total > 0 ? round1((used / total) * 100) : 0,
        cpuPct: round1(cpuPct),
        loadAvg1: Array.isArray(load) && load.length > 0 ? Math.round(load[0] * 100) / 100 : 0,
      },
    };
  } catch (err) {
    return { error: `system-stats read failed: ${err && err.message ? err.message : err}` };
  }
}

module.exports = { executeHttpRecipe, executeLlmRecipe, executeLlmRecipeWithDeps, makeSafeLookup, executeSystemStatsRecipe, computeCpuPct, normalizeHttpAllowHosts, isHttpHostAllowed };
