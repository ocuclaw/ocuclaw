const { createSseParser } = require("./sse-parse.cjs");

function subscribeEvents(opts) {
  const doFetch = opts.fetchImpl || fetch;
  const controller = new AbortController();
  if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort());
  let stopped = false;
  let lastId = 0;
  let backoffMs = 250;

  function emit(frame, id) {
    if (id != null) {
      if (id <= lastId) return;
      lastId = id;
    }
    try { opts.onFrame(frame, id); } catch {  }
  }

  async function gapFill() {
    if (lastId <= 0) return;
    try {
      const url = `http://127.0.0.1:${opts.port}/api/messages?sessionId=${encodeURIComponent(opts.sessionId)}&after=${lastId}`;
      const res = await doFetch(url, { headers: { authorization: `Bearer ${opts.token}` }, signal: controller.signal });
      if (!res.ok) return;
      const body = await res.json();
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      for (const m of msgs) {
        const id = typeof m.id === "number" ? m.id : null;
        emit(m, id);
      }
    } catch {  }
  }

  async function runOnce(needReplay) {
    const url =
      `http://127.0.0.1:${opts.port}/api/events?sessionId=${encodeURIComponent(opts.sessionId)}` +
      `&needReplay=${needReplay ? "true" : "false"}`;
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${opts.token}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const events = parser.push(decoder.decode(value, { stream: true }));
      for (const ev of events) {
        let frame;
        try { frame = JSON.parse(ev.data); } catch { continue; }
        emit(frame, ev.id);
      }
    }
  }

  (async () => {
    let first = true;
    while (!stopped) {
      try {
        if (!first) await gapFill();
        await runOnce(first ? (opts.needReplay !== false) : false);
        backoffMs = 250;
      } catch {
        if (stopped) break;
      }
      first = false;
      if (stopped) break;

      await new Promise((r) => {
        const t = setTimeout(r, backoffMs);
        if (typeof t.unref === "function") t.unref();
        controller.signal.addEventListener("abort", () => { clearTimeout(t); r(undefined); }, { once: true });
      });
      backoffMs = Math.min(backoffMs * 2, 5000);
    }
  })();

  return {
    stop() {
      stopped = true;
      controller.abort();
    },
  };
}

module.exports = { subscribeEvents };
