const { createServer } = require("node:http");
const { mkdirSync, writeFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { FIXTURE_SESSIONS, claudeTextTurn, codexTextTurn } = require("./fixtures.cjs");

function turnFor(provider, sessionId) {
  return provider === "codex" ? codexTextTurn(sessionId) : claudeTextTurn(sessionId);
}

async function startStubEvenTerminal(opts) {
  const token = (opts && opts.token) ? opts.token : "stub-token";
  const cwd = (opts && opts.cwd) ? opts.cwd : "/tmp/even-terminal-fixture-project";

  const posts = [];

  let createdCount = 0;

  function authed(req) {
    const header = req.headers["authorization"];
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const provided = header && header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
    return provided === token;
  }

  function sendJson(res, code, body) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!authed(req)) return sendJson(res, 401, { error: "Unauthorized" });
    const provider = url.searchParams.get("provider") ?? "claude";

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = FIXTURE_SESSIONS.filter((s) => s.provider === provider).map((s) => ({
        id: s.id,
        title: s.title,
        timestamp: new Date(s.updatedAt).toISOString(),
        cwd: s.cwd,
        provider: s.provider,
        status: "idle",
      }));
      return sendJson(res, 200, { sessions });
    }

    if (req.method === "GET" && /^\/api\/sessions\/[^/]+\/history$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const frames = turnFor(provider, id);
      const history = frames
        .filter((f) => f.type === "user_prompt" || f.type === "result")
        .map((f) =>
          f.type === "user_prompt"
            ? { role: "user", text: String(f.text ?? "") }
            : { role: "assistant", text: String(f.text ?? "") },
        );
      return sendJson(res, 200, { history });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(":ok\n\n");
      let id = 0;
      for (const frame of turnFor(provider, sessionId)) {
        id += 1;
        res.write(`id: ${id}\ndata: ${JSON.stringify(frame)}\n\n`);
      }

      return;
    }

    if (req.method === "GET" && url.pathname === "/api/messages") {
      return sendJson(res, 200, { messages: [], state: "idle" });
    }

    if (req.method === "POST") {

      let rawBody = "";
      await new Promise((resolve) => {
        req.on("data", (chunk) => { rawBody += chunk; });
        req.on("end", resolve);
      });
      let body = {};
      try { body = JSON.parse(rawBody); } catch {  }
      posts.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/prompt")) {

        const promptProvider = (body && typeof body.provider === "string" && body.provider)
          ? body.provider
          : provider;
        const sessionId = (body && typeof body.sessionId === "string" && body.sessionId)
          ? body.sessionId
          : `created-${promptProvider}-${++createdCount}`;
        return sendJson(res, 202, { ok: true, sessionId, provider: promptProvider });
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  let pidfilePath = "";
  if (opts && opts.instanceDir) {
    mkdirSync(opts.instanceDir, { recursive: true });
    pidfilePath = join(opts.instanceDir, `${process.pid}.json`);
    writeFileSync(
      pidfilePath,
      JSON.stringify({
        pid: process.pid,
        platform: process.platform,
        startedAt: 1_700_000_000_000,
        port,
        token,
        cwd,
        codexAppServerPort: port + 1,
      }),
      { mode: 0o600 },
    );
  }

  return {
    port,
    token,
    cwd,
    pidfilePath,
    posts,
    close: () =>
      new Promise((resolve) => {
        if (pidfilePath) {
          try {
            unlinkSync(pidfilePath);
          } catch {

          }
        }

        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      }),
  };
}

module.exports = { startStubEvenTerminal };
