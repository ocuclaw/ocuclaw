const { randomUUID, createHash } = require("node:crypto");
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const BOT_SCREEN_CONTROL_REQUEST = "ocuclaw.botscreen.control";
const BOT_SCREEN_CONTROL_RESULT = "ocuclaw.botscreen.control.result";
const ACTIONS = new Set(["click", "double_click", "right_click", "scroll_up", "scroll_down", "enter", "tab", "type"]);
const OPS = new Set(["status", "acquire", "input", "release"]);
const ID = /^[a-zA-Z0-9_.:-]{1,100}$/;
const PROFILE = /^[a-z0-9_-]{1,64}$/;

const HOLD_FRESH_MS = 5_000;

function createBotScreenControl(opts         ) {
  const now = opts.now || (() => Date.now());
  const launch = randomUUID();
  const clients = new Map                          ();
  const generations = new Map                ();
  let disposed = false;
  let claims           = [];
  let claimsReady = true;
  const claimFile = opts.stateDir ? join(opts.stateDir, "bot-screen-completions.json") : null;
  if (claimFile) {
    try { const saved = JSON.parse(readFileSync(claimFile, "utf8")); if (!Array.isArray(saved) || !saved.every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) claimsReady = false; else claims = saved.slice(-512); }
    catch (error     ) { if (error?.code !== "ENOENT") claimsReady = false; }
  }
  function claim(id        )          {
    if (!claimsReady) return false;
    const digest = createHash("sha256").update(`${opts.pairingId}:${id}`).digest("hex");
    if (claims.includes(digest)) return false;
    const next = [...claims, digest].slice(-512);
    if (claimFile) {
      try {
        mkdirSync(opts.stateDir , { recursive: true, mode: 0o700 });
        writeFileSync(`${claimFile}.tmp`, JSON.stringify(next), { mode: 0o600 });
        renameSync(`${claimFile}.tmp`, claimFile);
      } catch { claimsReady = false; return false; }
    }
    claims = next;
    return true;
  }
  const connection = (id        ) => `${launch}:${id}`;

  const leases = new Map                                                          ();

  function holds(clientId        )          {
    const lease = leases.get(clientId);
    return !disposed && !!lease && lease.mine && lease.profileId === opts.profile(clientId) && now() - lease.at <= HOLD_FRESH_MS;
  }
  const emit = (clientId        , profileId        , body     ) => {
    if (disposed || !clients.has(clientId)) return;
    try { opts.send(clientId, JSON.stringify({ type: BOT_SCREEN_CONTROL_RESULT, v: 1, profileId, ...body })); } catch {  }
  };
  const fail = (clientId        , profileId        , id        , code        , uncertain = false) =>
    emit(clientId, profileId, { id, ok: false, code, uncertain });

  function cancel(clientId        , profileId        ) {
    const saved = clients.get(clientId)?.get(profileId);
    if (!saved?.source || !Number.isSafeInteger(saved?.lease?.epoch)) return;

    void opts.request("botScreen.control", { v: 1, id: randomUUID(), op: "cancel", profileId,
      pairingId: opts.pairingId, connectionId: connection(clientId),
      source: saved.source, epoch: saved.lease.epoch, resumeToken: saved.resumeToken }).catch(() => {});
  }

  async function dispatch(clientId        , msg     ) {
    let state = clients.get(clientId);
    if (!state) { state = new Map(); clients.set(clientId, state); }
    const selected = opts.profile(clientId);
    const profileId = msg.op === "release" && typeof msg.profileId === "string" ? msg.profileId : selected;
    const id = typeof msg.id === "string" && ID.test(msg.id) ? msg.id : "invalid";
    if (!PROFILE.test(profileId) || typeof msg.id !== "string" || !ID.test(msg.id) || msg.v !== 1 || !OPS.has(msg.op)) {
      fail(clientId, selected, id, "invalid_request"); return;
    }
    if (msg.profileId && msg.profileId !== selected && (msg.op !== "release" || !msg.resumeToken)) {
      fail(clientId, selected, id, "source_changed"); return;
    }
    if (msg.op !== "status" && (typeof msg.source !== "string" || !msg.source || msg.source.length > 128)) {
      fail(clientId, profileId, id, "source_required"); return;
    }
    if (msg.resumeToken != null && (typeof msg.resumeToken !== "string" || msg.resumeToken.length > 256)) {
      fail(clientId, profileId, id, "invalid_request"); return;
    }
    if (["input", "release"].includes(msg.op) && (!Number.isSafeInteger(msg.epoch) || msg.epoch < 0)) {
      fail(clientId, profileId, id, "lease_required"); return;
    }
    if (msg.op === "input") {
      if (!ACTIONS.has(msg.action) || !Number.isSafeInteger(msg.n) || msg.n < 1 ||
          (msg.action === "type" && (typeof msg.text !== "string" || msg.text.length > 1024 || !/^[\x20-\x7e]*$/.test(msg.text))) ||
          (["click", "double_click", "right_click", "scroll_up", "scroll_down"].includes(msg.action) &&
            (!Number.isSafeInteger(msg.x) || !Number.isSafeInteger(msg.y) || msg.x < 0 || msg.y < 0 || msg.x >= 8192 || msg.y >= 8192))) {
        fail(clientId, profileId, id, "invalid_input"); return;
      }
    }
    const generation = generations.get(clientId) || 0;
    const before = opts.session(clientId);
    const params      = { v: 1, id, op: msg.op, profileId, connectionId: connection(clientId), pairingId: opts.pairingId };
    for (const key of ["source", "epoch", "resumeToken"]) if (msg[key] != null) params[key] = msg[key];
    if (msg.op === "acquire") {
      if (!before || profileId !== selected) { fail(clientId, profileId, id, "source_changed"); return; }
      params.sessionKey = before;
      const clarifyId = opts.clarify?.(before);
      if (clarifyId) params.clarifyId = clarifyId;
    }
    if (msg.op === "release") params.continueBot = msg.continueBot === true;
    if (msg.op === "input") {
      for (const key of ["action", "x", "y", "n"]) if (msg[key] != null) params[key] = msg[key];
      if (msg.action === "type") { params.text = msg.text; params.enter = msg.enter === true; }
    }
    let timer     ;
    try {
      const response      = await Promise.race([
        opts.request("botScreen.control", params),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), opts.timeoutMs || 10_000); timer.unref?.(); }),
      ]);
      if (!response) { cancel(clientId, profileId); fail(clientId, profileId, id, "delivery_unknown", msg.op !== "status"); return; }
      if (!clients.has(clientId) || disposed) return;
      if ((generations.get(clientId) || 0) !== generation && msg.op !== "release") {
        cancel(clientId, profileId); return;
      }
      const safe      = { id, ok: response.ok === true, available: response.available === true };
      for (const key of ["code", "source", "resumeToken", "nextN", "sent", "total", "uncertain", "released", "releaseId"])
        if (response[key] != null) safe[key] = response[key];
      if (response.lease && typeof response.lease === "object") {
        const lease = response.lease;
        safe.lease = { known: lease.known === true, holder: ["agent", "human"].includes(lease.holder) ? lease.holder : null,
          mine: lease.mine === true, epoch: Number.isSafeInteger(lease.epoch) ? lease.epoch : 0,
          reason: typeof lease.reason === "string" ? lease.reason : "", since: Number.isFinite(lease.since) ? lease.since : 0 };
      }
      if (response.source && response.lease) {
        state .set(profileId, { source: response.source, lease: response.lease,
          resumeToken: response.resumeToken || state .get(profileId)?.resumeToken });
      }
      if (response.lease && typeof response.lease === "object") {
        leases.set(clientId, { profileId, mine: response.lease.holder === "human" && response.lease.mine === true, at: now() });
      } else if (response.available === false) {
        leases.delete(clientId);
      }
      if (response.lease || response.available === false) opts.onLease?.(clientId, holds(clientId));
      if (((msg.op === "release" && msg.continueBot === true) || (msg.op === "status" && response.continueBot === true)) && response.released === true &&
          typeof response.releaseId === "string" && response.continuation && opts.continueBot) {
        const ctx = response.continuation;
        if (typeof ctx.sessionKey === "string" && /^hermes:[a-z0-9_-]{1,64}:[a-zA-Z0-9_.:-]{1,200}$/.test(ctx.sessionKey) && claim(response.releaseId)) {
          try { await opts.continueBot({ sessionKey: ctx.sessionKey, clarifyId: ctx.clarifyId }); }
          catch { safe.code = "continuation_unknown"; safe.uncertain = true; }
        } else if (!claimsReady) { safe.code = "continuation_unavailable"; safe.uncertain = true; }
      }
      emit(clientId, profileId, safe);
    } catch {
      cancel(clientId, profileId);
      fail(clientId, profileId, id, "delivery_unknown", msg.op !== "status");
    } finally { clearTimeout(timer); }
  }
  return {
    handle(clientId        , msg     )          {
      if (msg?.type !== BOT_SCREEN_CONTROL_REQUEST) return false;
      if (!disposed) void dispatch(clientId, msg);
      return true;
    },
    holds,
    selectionChanged(clientId        ) {
      generations.set(clientId, (generations.get(clientId) || 0) + 1);
      for (const profileId of clients.get(clientId)?.keys() || []) cancel(clientId, profileId);
    },
    clientGone(clientId        ) {
      for (const profileId of clients.get(clientId)?.keys() || []) cancel(clientId, profileId);
      clients.delete(clientId); generations.delete(clientId); leases.delete(clientId);
    },
    dispose() {
      for (const clientId of clients.keys()) this.clientGone(clientId);
      disposed = true;
    },
  };
}

module.exports = { BOT_SCREEN_CONTROL_REQUEST, BOT_SCREEN_CONTROL_RESULT, createBotScreenControl };
