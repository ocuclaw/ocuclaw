const ENDPOINT_URL = "https://api.typesafe.ai/v1/systemone";

const JEV_REASONS = Object.freeze([
  "no_key",
  "disabled",
  "misconfigured",
  "aborted",
  "timeout",
  "http_401",
  "http_422",
  "http_429",
  "http_529",
  "http_other",
  "network",
  "bad_json",
]);

const MAPPED_STATUSES = new Set([401, 422, 429, 529]);

function failure(reason, ms) {
  return { ok: false, reason, ms };
}

function isTimeout(error) {
  if (!error) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}

function requestSignal(budgetMs, callerSignal) {
  const budget = AbortSignal.timeout(budgetMs);
  const ctor = AbortSignal;
  if (!callerSignal || typeof ctor.any !== "function") return budget;
  return ctor.any([budget, callerSignal]);
}

function createJevClient(options = {}) {
  const opts = options || {};
  const apiKey = typeof opts.apiKey === "string" && opts.apiKey ? opts.apiKey : null;
  const enabled = opts.enabled !== false;
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const url = typeof opts.url === "string" && opts.url ? opts.url : ENDPOINT_URL;
  const model = typeof opts.model === "string" && opts.model ? opts.model : "";
  const defaultQuestions = opts.questions && typeof opts.questions === "object" ? opts.questions : null;

  async function decide(state, callOptions = {}) {
    const startedAt = now();
    const elapsed = () => now() - startedAt;
    const budgetMs = Number.isFinite(callOptions && callOptions.budgetMs) ? callOptions.budgetMs : 400;
    const turnId = (callOptions && callOptions.turnId) || null;

    const questions = (callOptions && callOptions.questions) || defaultQuestions;
    const callerSignal = (callOptions && callOptions.signal) || null;

    if (!enabled) return failure("disabled", elapsed());
    if (!apiKey) return failure("no_key", elapsed());

    if (!model || !questions || Object.keys(questions).length === 0) {
      return failure("misconfigured", elapsed());
    }
    if (typeof fetchImpl !== "function") return failure("network", elapsed());
    if (callerSignal && callerSignal.aborted) return failure("aborted", elapsed());

    let response = null;
    let text = "";
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
        signal: requestSignal(budgetMs, callerSignal),
      });
      text = await response.text();
    } catch (error) {

      if (callerSignal && callerSignal.aborted) return failure("aborted", elapsed());
      return failure(isTimeout(error) ? "timeout" : "network", elapsed());
    }

    const status = response && Number.isFinite(response.status) ? response.status : 0;
    if (!response || !response.ok) {

      return failure(MAPPED_STATUSES.has(status) ? `http_${status}` : "http_other", elapsed());
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return failure("bad_json", elapsed());
    }
    if (!parsed || typeof parsed.answers !== "object" || !parsed.answers) {
      return failure("bad_json", elapsed());
    }

    const inputTokens = parsed.usage && Number.isFinite(Number(parsed.usage.input_tokens))
      ? Number(parsed.usage.input_tokens)
      : null;
    return { ok: true, answers: parsed.answers, ms: elapsed(), inputTokens, turnId };
  }

  return { decide, enabled, hasKey: Boolean(apiKey), model };
}

module.exports = { JEV_REASONS, createJevClient };
