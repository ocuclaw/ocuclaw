async function probeSessions(
  instance,
  provider,
  opts,
) {
  const doFetch = opts?.fetchImpl ?? fetch;
  const limit = opts?.limit ?? 10;
  const url =
    `http://127.0.0.1:${instance.port}/api/sessions` +
    `?provider=${encodeURIComponent(provider)}` +
    `&cwd=${encodeURIComponent(instance.cwd)}` +
    `&limit=${limit}`;
  try {
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${instance.token}` },
    });
    if (!res.ok) return [];
    const body = await res.json();
    const rows = Array.isArray(body.sessions) ? body.sessions : [];
    return rows.map((raw) => {
      const r = raw;
      const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : Number(r.updatedAt);
      return {
        id: String(r.id ?? ""),
        title: String(r.title ?? ""),
        updatedAt: Number.isFinite(ts) ? ts : 0,
        cwd: String(r.cwd ?? instance.cwd),
        provider,
        status: typeof r.status === "string" ? r.status : null,
      };
    }).filter((s) => s.id);
  } catch {
    return [];
  }
}

async function fetchSessionStatus(instance, provider, sessionId, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const url =
    `http://127.0.0.1:${instance.port}/api/status` +
    `?provider=${encodeURIComponent(provider)}` +
    `&sessionId=${encodeURIComponent(sessionId)}`;
  try {
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${instance.token}` },
    });
    if (res.status === 404) {
      return { found: false, state: "idle", status: res.status };
    }
    if (!res.ok) {
      return { found: null, state: null, status: res.status };
    }
    const body = await res.json();
    const state = typeof (body && body.state) === "string" && body.state.trim()
      ? body.state.trim()
      : null;
    return { found: true, state, status: res.status };
  } catch {
    return { found: null, state: null };
  }
}

async function fetchHistory(instance, provider, sessionId, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const url =
    `http://127.0.0.1:${instance.port}/api/sessions/${encodeURIComponent(sessionId)}/history` +
    `?provider=${encodeURIComponent(provider)}&limit=10`;
  try {
    const res = await doFetch(url, { headers: { authorization: `Bearer ${instance.token}` } });
    if (!res.ok) return [];
    const body = await res.json();
    const rows = body && Array.isArray(body.history) ? body.history : [];
    return rows.map((r) => ({
      role: r && r.role === "assistant" ? "assistant" : "user",
      content: typeof (r && r.text) === "string" ? r.text : String((r && r.content) || ""),
    }));
  } catch {
    return [];
  }
}

async function postPrompt(instance, provider, sessionId, text, opts) {
  const doFetch = (opts && opts.fetchImpl) ? opts.fetchImpl : fetch;
  const url = `http://127.0.0.1:${instance.port}/api/prompt`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${instance.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text, provider, sessionId, cwd: instance.cwd }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

async function createPromptSession(instance, provider, text, opts) {
  const doFetch = (opts && opts.fetchImpl) ? opts.fetchImpl : fetch;
  const url = `http://127.0.0.1:${instance.port}/api/prompt`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${instance.token}`,
        "content-type": "application/json",
      },

      body: JSON.stringify({ text, provider, cwd: instance.cwd }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    let body = {};
    try { body = await res.json(); } catch {  }
    const sessionId = body && typeof body.sessionId === "string" ? body.sessionId : "";
    const respProvider = body && typeof body.provider === "string" ? body.provider : provider;
    return { ok: true, status: res.status, sessionId, provider: respProvider };
  } catch {
    return { ok: false };
  }
}

async function postInterrupt(instance, provider, sessionId, opts) {
  const doFetch = (opts && opts.fetchImpl) ? opts.fetchImpl : fetch;
  const url = `http://127.0.0.1:${instance.port}/api/interrupt`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${instance.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, provider }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

async function postPermissionResponse(instance, provider, sessionId, decision, opts) {
  const doFetch = (opts && opts.fetchImpl) ? opts.fetchImpl : fetch;
  const url = `http://127.0.0.1:${instance.port}/api/permission-response`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${instance.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, decision, provider }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

async function postQuestionResponse(instance, provider, sessionId, answer, opts) {
  const doFetch = (opts && opts.fetchImpl) ? opts.fetchImpl : fetch;
  const url = `http://127.0.0.1:${instance.port}/api/question-response`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${instance.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, answer, provider }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

module.exports = { probeSessions, fetchSessionStatus, fetchHistory, postPrompt, createPromptSession, postInterrupt, postPermissionResponse, postQuestionResponse };
