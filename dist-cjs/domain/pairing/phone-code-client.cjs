const { env } = require("node:process");
const { isPhoneCodeAddress } = require("./pairing-note.cjs");

const PHONE_CODE_DEFAULT_URL = "https://pair.ocuclaw.com";

function phoneCodeServiceUrl()                {
  const value = env.OCUCLAW_PAIR_URL?.trim() || PHONE_CODE_DEFAULT_URL;
  if (value.toLowerCase() === "off") return null;
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch { return null; }
}

async function phoneCodeRequest(base        , path        ,
  options                                     = {}, timeoutMs = 5000)                          {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await globalThis.fetch(`${base}${path}`, { ...options,
      headers: { "content-type": "application/json" }, signal: controller.signal, redirect: "error" });
    if (response.status === 404) return { ok: false, reason: "no_code" };
    if (response.status === 409) return { ok: false, reason: "spent" };
    if (response.status !== 200 && response.status !== 201) return { ok: false, reason: "unavailable" };
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
          if (text.length > 2048) return { ok: false, reason: "unavailable" };
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
    }
    const json = text ? JSON.parse(text) : {};
    if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "unavailable" };
    return { ok: true, json };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally { clearTimeout(timer); }
}

async function phoneCodeStatus(address         , isCustomRoute                = () => false)

   {
  const base = phoneCodeServiceUrl();
  if (!base) return { available: false, reason: "off" };
  if (isCustomRoute() || !isPhoneCodeAddress(address)) return { available: false, reason: "custom_route" };
  const reply = await phoneCodeRequest(base, "/v1/health", {}, 3000);
  return reply.ok && reply.json.ok === true ? { available: true } : { available: false, reason: "unavailable" };
}

module.exports = { phoneCodeServiceUrl, phoneCodeRequest, phoneCodeStatus };
