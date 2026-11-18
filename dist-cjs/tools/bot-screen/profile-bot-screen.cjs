const { createBotScreenSource, BOT_SCREEN_PROTOCOL } = require("./bot-screen-source.cjs");

const { createBotScreenControl } = require("./bot-screen-control.cjs");
const { createBotScreenAim } = require("./bot-screen-aim.cjs");

const BOT_SCREEN_START_REQUEST = "ocuclaw.botscreen.start";
const BOT_SCREEN_START_RESULT = "ocuclaw.botscreen.start.result";
const LINK_BOT_SCREEN_START_METHOD = "botScreen.start";

const BOT_SCREEN_START_TIMEOUT_MS = 30_000;
const START_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

const START_CODES = new Set([
  "memory", "missing", "unsupported", "sandboxed", "unknown", "start_failed",
  "profile_unavailable", "profile_scope_unavailable", "start_unavailable", "start_unknown",
]);
const START_STATES = new Set(["unsupported", "unknown", "missing", "off", "sandboxed", "running"]);

function createProfileBotScreenSource(opts         ) {
  const entries = new Map               ();
  const control = createBotScreenControl({
    ...opts, session: opts.session || (() => null), pairingId: opts.pairingId || "",
    onLease: (clientId, holds) => { if (!holds) aim.released(clientId); },
  });
  let disposed = false;
  const current = (e       ) => !disposed && entries.get(e.clientId) === e && opts.profile(e.clientId) === e.profileId;

  const aim = createBotScreenAim({
    frame: (clientId) => {
      const e = entries.get(clientId);
      return e && current(e) && e.source ? e.source.colour() : null;
    },
    keepColour: (clientId, on) => {
      const e = entries.get(clientId);
      if (!e) return;
      e.colour = on;
      e.source?.keepColour(on);
    },
    inControl: (clientId) => control.holds(clientId),
    profile: opts.profile,
    decide: opts.jevDecide || null,
    send: opts.send,
    budgetMs: opts.jevBudgetMs,
    warm: opts.jevWarm,
  });
  const wire = (e       , body     ) => {
    try { opts.send(e.clientId, JSON.stringify({ ...body, profileId: e.profileId })); }
    catch {  }
  };
  const routeKey = (route     ) => JSON.stringify([route.socket,
    route.probe.lease === true, route.probe.status === true, route.probe.snapshot === true]);

  async function resolve(e       )               {
    let timer     ;
    try {
      const route = await Promise.race([
        opts.request("botScreen.route", { profileId: e.profileId }),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 5_000); timer.unref?.(); }),
      ]);
      if (!current(e) || !route || route.v !== 1 || route.profileId !== e.profileId ||
          typeof route.socket !== "string" || !route.socket || !route.probe) return null;
      return route;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function clear(e       ) {
    e.generation++;
    e.source?.dispose();
    e.source = null;
    e.routeKey = "";
    e.outbox.clear();
    e.events.clear();
  }

  function unavailable(e       ) {
    clear(e);
    if (!current(e) || e.blocked) return;
    e.blocked = true;
    wire(e, { type: "ocuclaw.botscreen.reset", v: 1 });
    wire(e, { type: BOT_SCREEN_PROTOCOL.status, v: 1, state: "unknown", screen: null, placement: null, control: "unknown" });
  }

  async function flush(e       ) {
    if (e.flushing || !current(e)) return;
    e.flushing = true;
    try {
      while (current(e) && e.outbox.size) {
        const route = await resolve(e);
        if (!current(e)) return;
        if (!route || routeKey(route) !== e.routeKey) { unavailable(e); return; }
        const batch = Array.from(e.outbox.values());
        e.outbox.clear();
        for (const frame of batch) {
          if (!current(e)) return;
          wire(e, frame);
        }
      }
    } finally {
      e.flushing = false;
    }
  }

  function queue(e       , frame        ) {
    if (!current(e)) return;
    const body = JSON.parse(frame);

    const key = `${body.type}:${body.viewer || ""}`;
    e.outbox.set(key, body);
    void flush(e);
  }

  async function pump(e       ) {
    if (e.loading || !current(e)) return;
    e.loading = true;
    try {
      if (!e.source) {
        const route = await resolve(e);
        if (!current(e)) return;
        if (!route) { e.inbox.clear(); unavailable(e); return; }
        e.blocked = false;
        e.routeKey = routeKey(route);
        const generation = e.generation;
        e.source = createBotScreenSource({
          socket: route.socket,
          probe: route.probe,
          request: (method, params) => opts.request(method, { ...params, profileId: e.profileId }),
          send: (_id, frame) => { if (generation === e.generation) queue(e, frame); },
          trace: opts.trace,
          clients: () => current(e) ? [e.clientId] : [],

          startHandled: true,
        });
        for (const viewer of e.viewers) e.source.handle(e.clientId, { type: BOT_SCREEN_PROTOCOL.open, viewer });
        if (e.colour) e.source.keepColour(true);
      }
      for (const [kind, data] of e.events) e.source?.[kind](data);
      e.events.clear();
      while (current(e) && e.source && e.inbox.size) {
        const batch = Array.from(e.inbox.values());
        e.inbox.clear();
        for (const msg of batch) {
          const reply = e.source.handle(e.clientId, msg);
          if (reply) queue(e, reply);
        }
      }
    } finally {
      e.loading = false;
    }
  }

  function select(clientId        )        {
    const profileId = opts.profile(clientId);
    const old = entries.get(clientId);
    if (old && old.profileId === profileId) return old;
    const viewers = new Set(old?.viewers);
    if (old) clear(old);
    const e        = { clientId, profileId, starting: null, source: null, routeKey: "", loading: false, flushing: false, blocked: false, generation: 0,
      inbox: new Map(), outbox: new Map(), viewers, events: new Map(), colour: false };
    entries.set(clientId, e);
    wire(e, { type: "ocuclaw.botscreen.reset", v: 1 });
    for (const viewer of viewers) e.inbox.set(`open:${viewer}`, { type: BOT_SCREEN_PROTOCOL.open, viewer });
    e.inbox.set("status", { type: BOT_SCREEN_PROTOCOL.statusGet });
    void pump(e);
    return e;
  }

  async function runStart(e       )                       {

    const route = await resolve(e);
    if (!route || route.probe.start !== true) return { ok: false, code: "start_unavailable" };
    let timer     ;
    try {
      const raw      = await Promise.race([
        opts.request(LINK_BOT_SCREEN_START_METHOD, { profileId: e.profileId }),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), BOT_SCREEN_START_TIMEOUT_MS); timer.unref?.(); }),
      ]);
      if (!raw || typeof raw !== "object") return { ok: false, code: "start_unknown" };
      const answer              = { ok: raw.ok === true };
      if (START_STATES.has(raw.state)) answer.state = raw.state;
      if (answer.ok && raw.already === true) answer.already = true;
      if (!answer.ok) answer.code = START_CODES.has(raw.code) ? raw.code : "start_failed";
      return answer;
    } catch {
      return { ok: false, code: "start_unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function start(clientId        , msg     ) {
    const id = typeof msg.id === "string" && START_ID.test(msg.id) ? msg.id : null;
    const e = select(clientId);
    if (!id || msg.v !== 1) {
      wire(e, { type: BOT_SCREEN_START_RESULT, v: 1, id: id || "invalid", ok: false, code: "invalid_request" });
      return;
    }
    if (!e.starting) {
      const run = runStart(e);
      e.starting = run;
      void run.finally(() => { if (e.starting === run) e.starting = null; });
    }
    const answer = await e.starting;
    opts.trace?.("bot_screen_start", { ok: answer.ok, code: answer.code || null, already: answer.already === true });
    if (!current(e)) return;
    wire(e, { type: BOT_SCREEN_START_RESULT, v: 1, id, ...answer });

    if (e.source) e.source.refresh();
    else { e.inbox.set("status", { type: BOT_SCREEN_PROTOCOL.statusGet }); void pump(e); }
  }

  return {
    handle(clientId        , msg     )       {
      if (control.handle(clientId, msg) || aim.handle(clientId, msg)) return null;
      if (!disposed && msg?.type === BOT_SCREEN_START_REQUEST) { void start(clientId, msg); return null; }
      if (disposed || !msg || ![BOT_SCREEN_PROTOCOL.open, BOT_SCREEN_PROTOCOL.close,
          BOT_SCREEN_PROTOCOL.want, BOT_SCREEN_PROTOCOL.statusGet].includes(msg.type)) return null;
      if (msg.type !== BOT_SCREEN_PROTOCOL.statusGet && !["phone", "glasses"].includes(msg.viewer)) return null;
      const e = select(clientId);
      if (msg.type === BOT_SCREEN_PROTOCOL.close) {
        e.viewers.delete(msg.viewer);
        e.inbox.delete(`open:${msg.viewer}`);
        e.inbox.delete(`${BOT_SCREEN_PROTOCOL.want}:${msg.viewer}`);
      } else if (msg.type === BOT_SCREEN_PROTOCOL.open && ["phone", "glasses"].includes(msg.viewer)) {
        e.viewers.add(msg.viewer);
      }
      e.inbox.set(msg.type === BOT_SCREEN_PROTOCOL.open ? `open:${msg.viewer}` : `${msg.type}:${msg.viewer || ""}`, msg);
      void pump(e);
      return null;
    },
    selectionChanged(clientId        ) {
      control.selectionChanged(clientId);
      aim.released(clientId);
      if (!disposed) select(clientId);
    },
    target(data     ) { this.event("target", data); },
    step(data     ) { this.event("step", data); },
    elements(data     ) { this.event("elements", data); },
    run(data     ) { this.event("run", data); },
    event(kind                                        , data     ) {

      const profileId = typeof data?.profileId === "string" ? data.profileId : "default";
      for (const clientId of opts.clients()) {
        if (opts.profile(clientId) !== profileId) continue;
        const e = select(clientId);
        if (e.source) e.source[kind](data);
        else { e.events.set(kind, data); void pump(e); }
      }
    },
    clientGone(clientId        ) {
      control.clientGone(clientId);
      aim.clientGone(clientId);
      const e = entries.get(clientId);
      entries.delete(clientId);
      if (e) clear(e);
    },
    dispose() {
      control.dispose();
      aim.dispose();
      disposed = true;
      for (const e of entries.values()) clear(e);
      entries.clear();
    },
  };
}

module.exports = { BOT_SCREEN_START_REQUEST, BOT_SCREEN_START_RESULT, LINK_BOT_SCREEN_START_METHOD, BOT_SCREEN_START_TIMEOUT_MS, createProfileBotScreenSource };
