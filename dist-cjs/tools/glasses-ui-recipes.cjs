const { totalmem, freemem, loadavg, cpus } = require("node:os");
const dns = require("node:dns");
const { Agent, fetch: undiciFetch } = require("undici");

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

function checkIpv4Tuple(a        , b        , c        )                {
  if (a === 127) return "loopback IPv4 blocked";
  if (a === 10) return "RFC1918 IPv4 blocked";
  if (a === 172 && b >= 16 && b <= 31) return "RFC1918 IPv4 blocked";
  if (a === 192 && b === 168) return "RFC1918 IPv4 blocked";
  if (a === 169 && b === 254) return "link-local / cloud-metadata IPv4 blocked";
  if (a === 0) return "zero-network IPv4 blocked";

  if (a === 100 && b >= 64 && b <= 127) return "shared-address 100.64/10 IPv4 blocked";

  if (a === 198 && (b === 18 || b === 19)) return "benchmarking 198.18/15 IPv4 blocked";

  if (a === 192 && b === 0 && c === 0) return "IETF-protocol 192.0.0/24 IPv4 blocked";
  if (a >= 224) return "multicast/reserved IPv4 blocked";
  return null;
}

function checkIpv4Literal(address        )                {
  const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return "unrecognised IPv4 address blocked";
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((n) => n > 255)) return "unrecognised IPv4 address blocked";
  return checkIpv4Tuple(octets[0], octets[1], octets[2]);
}

function parseIpv6Groups(text        )                  {
  let addr = text.toLowerCase();
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  if (!addr.includes(":")) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parsePart = (part        , dottedTail         )                  => {
    if (part === "") return [];
    const out           = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (dottedTail && i === pieces.length - 1 && piece.includes(".")) {
        const m = piece.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!m) return null;
        const o = [m[1], m[2], m[3], m[4]].map(Number);
        if (o.some((n) => n > 255)) return null;
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const all = parsePart(halves[0], true);
    return all && all.length === 8 ? all : null;
  }
  const head = parsePart(halves[0], false);
  const tail = parsePart(halves[1], true);
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

function checkIpv6Literal(address        )                {
  const g = parseIpv6Groups(address);
  if (!g) return "unrecognised IPv6 address blocked";
  const zeroBefore = (n        ) => g.slice(0, n).every((x) => x === 0);
  const embedded = () => checkIpv4Tuple(g[6] >> 8, g[6] & 0xff, g[7] >> 8);
  if (zeroBefore(7) && (g[7] === 0 || g[7] === 1)) return "IPv6 loopback/unspecified blocked";

  if (zeroBefore(5) && g[5] === 0xffff) {
    const r = embedded();
    return r ? `IPv4-mapped IPv6 blocked (${r})` : null;
  }

  if (zeroBefore(4) && g[4] === 0xffff && g[5] === 0) {
    const r = embedded();
    return r ? `IPv4-translated IPv6 blocked (${r})` : null;
  }

  if (zeroBefore(6)) {
    const r = embedded();
    return r ? `IPv4-compatible IPv6 blocked (${r})` : null;
  }

  if (g[0] === 0x64 && g[1] === 0xff9b) return "NAT64 IPv6 blocked";

  if (g[0] === 0x2002) return "6to4 IPv6 blocked";

  if ((g[0] & 0xffc0) === 0xfe80) return "IPv6 link-local blocked";

  if ((g[0] & 0xffc0) === 0xfec0) return "IPv6 site-local blocked";

  if ((g[0] & 0xfe00) === 0xfc00) return "IPv6 ULA blocked";
  if ((g[0] & 0xff00) === 0xff00) return "IPv6 multicast blocked";
  return null;
}

function isForbiddenAddress(address        , family         )                {
  if (typeof address !== "string" || address.length === 0) return "invalid address blocked";
  const fam = family === 4 || family === 6 ? family : address.includes(":") ? 6 : 4;
  return fam === 6 ? checkIpv6Literal(address) : checkIpv4Literal(address);
}

function checkResolvedIp(address        , family        )                {
  return isForbiddenAddress(address, family);
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

function createSsrfSafeDispatcher(dnsLookup                                                                              ) {
  return new Agent({
    connect: { lookup: makeSafeLookup(dnsLookup || dns.promises.lookup) },
  });
}

const ssrfSafeDispatcher = createSsrfSafeDispatcher();

function isForbiddenHttpDestination(urlString        )                {
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

  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) {
    return checkIpv4Literal(host);
  }

  if (/^[0-9a-f.x]+$/.test(host) && /^\d/.test(host) && !host.includes(":")) {
    return "ambiguous numeric host blocked";
  }

  if (host.includes(":")) {
    return checkIpv6Literal(host);
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

const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "content-type", "content-language",
  "cache-control", "pragma", "user-agent", "range", "if-range", "if-match",
  "if-none-match", "if-modified-since", "if-unmodified-since",
  "x-trace", "x-request-id", "x-correlation-id",
]);

function stripCrossOriginHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    const lower = key.toLowerCase();
    if (!CROSS_ORIGIN_SAFE_HEADERS.has(lower)) continue;
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
      ? (host     ) => isHttpHostAllowed(host, allowHosts) ? "listed" : "not_allowed"
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

  const fetchFn = opts && typeof opts.fetch === "function" ? opts.fetch : undiciFetch;

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
      if (response.status < 200 || response.status >= 300) {

        try { await response.body?.cancel(); } catch (_) {}
      }
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

function composeSystemPrompt(agentPrompt     , maxChars     , previousBody     ) {
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

const ANTHROPIC_THINKING_ROOM_TOKENS = 1024;
const ANTHROPIC_MODELS_THAT_THINK = new Set        ();

function anthropicReplyText(json                )         {
  return Array.isArray(json?.content)
    ? json.content.filter((b) => b && b.type === "text").map((b) => b.text).join("")
    : "";
}

async function runAnthropicApi(params, deps) {
  const fetchFn = deps && deps.fetch ? deps.fetch : fetch;
  if (!params.apiKey) return { error: "anthropic-api: missing api key" };
  const model = stripModelProviderPrefix(params.model);
  const max_tokens = Number.isFinite(params.maxOutputTokens) ? params.maxOutputTokens : 200;
  const systemPrompt = composeSystemPrompt(params.systemPrompt, max_tokens * 4, params.previousBody);
  const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 30_000;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  params.signal?.addEventListener("abort", cancel, { once: true });
  if (params.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ask = async (roomTokens        )                                                      => {
      const response = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        redirect: "error",
        headers: {
          "x-api-key": params.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: max_tokens + roomTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: params.prompt }],
        }),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) return { status: response.status };
      return { json: (await response.json())                   };
    };
    let thinks = ANTHROPIC_MODELS_THAT_THINK.has(model);
    let reply = await ask(thinks ? ANTHROPIC_THINKING_ROOM_TOKENS : 0);
    if (reply.json && !thinks) {
      const ranOut = reply.json.stop_reason === "max_tokens";
      const blocks = Array.isArray(reply.json.content) ? reply.json.content : [];
      thinks = blocks.some((b) => b && (b.type === "thinking" || b.type === "redacted_thinking"))
        || (ranOut && !anthropicReplyText(reply.json));
      if (thinks) {
        ANTHROPIC_MODELS_THAT_THINK.add(model);

        if (ranOut) reply = await ask(ANTHROPIC_THINKING_ROOM_TOKENS);
      }
    }
    if (!reply.json) {
      return { error: `anthropic-api status ${reply.status}` };
    }
    const text = anthropicReplyText(reply.json);

    return { output: thinks ? Array.from(text).slice(0, max_tokens * 4).join("") : text };
  } catch (err) {
    if (params.signal?.aborted) return { error: "anthropic-api: cancelled" };
    if (err && err.name === "AbortError") return { error: `anthropic-api timeout after ${timeoutMs}ms` };
    return { error: `anthropic-api error: ${err && err.message ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", cancel);
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
  const cancel = () => controller.abort();
  params.signal?.addEventListener("abort", cancel, { once: true });
  if (params.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = params.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const response = await fetchFn(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      redirect: "error",
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
    if (params.signal?.aborted) return { error: "openai-compat: cancelled" };
    if (err && err.name === "AbortError") return { error: `openai-compat timeout after ${timeoutMs}ms` };
    return { error: `openai-compat error: ${err && err.message ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", cancel);
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
    signal: ctx?.signal,
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
    const stats = {
      memTotalMb: toMb(total),
      memUsedMb: toMb(used),
      memFreeMb: toMb(free),
      memUsedPct: total > 0 ? round1((used / total) * 100) : 0,
      cpuPct: round1(cpuPct),
      loadAvg1: Array.isArray(load) && load.length > 0 ? Math.round(load[0] * 100) / 100 : 0,
    };

    return {
      output: {
        ...stats,
        mem_total_mb: stats.memTotalMb,
        mem_used_mb: stats.memUsedMb,
        mem_free_mb: stats.memFreeMb,
        mem_used_pct: stats.memUsedPct,
        cpu_pct: stats.cpuPct,
        load_avg_1: stats.loadAvg1,
      },
    };
  } catch (err) {
    return { error: `system-stats read failed: ${err && err.message ? err.message : err}` };
  }
}

module.exports = { isForbiddenAddress, makeSafeLookup, createSsrfSafeDispatcher, isForbiddenHttpDestination, normalizeHttpAllowHosts, isHttpHostAllowed, executeHttpRecipe, executeLlmRecipeWithDeps, executeLlmRecipe, computeCpuPct, executeSystemStatsRecipe };
