const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const { createConnection } = require("node:net");
const { dirname, join } = require("node:path");
const { packLevels } = require("../liveui-video/video-look.cjs");
const { encodePngRgb } = require("./png-rgb.cjs");
const { createRfbClient, RFB_MAX_SIDE } = require("./rfb-client.cjs");

const BOT_SCREEN_PROTOCOL = Object.freeze({

  open: "ocuclaw.botscreen.open",

  close: "ocuclaw.botscreen.close",

  statusGet: "ocuclaw.botscreen.status.get",

  want: "ocuclaw.botscreen.want",

  status: "ocuclaw.botscreen.status",

  lease: "ocuclaw.botscreen.lease",

  frame: "ocuclaw.botscreen.frame",

  target: "ocuclaw.botscreen.target",

  step: "ocuclaw.botscreen.step",

  elements: "ocuclaw.botscreen.elements",

  still: "ocuclaw.botscreen.still",

  run: "ocuclaw.botscreen.run",
});
const BOT_SCREEN_VERSION = 1;
const LINK_BOT_SCREEN_STATUS_METHOD = "botScreen.status";
const LINK_BOT_SCREEN_SNAPSHOT_METHOD = "botScreen.snapshot";

const BOT_SCREEN_TARGET_EVENT = "botScreenTarget";

const BOT_SCREEN_STEP_EVENT = "botScreenStep";

const BOT_SCREEN_ELEMENTS_EVENT = "botScreenElements";

const BOT_SCREEN_ELEMENTS_MAX = 100;

const BOT_SCREEN_RUN_EVENT = "botScreenRun";

const BOT_SCREEN_RUN_STALE_MS = 30_000;
const BOT_SCREEN_VIEWERS = Object.freeze(["glasses", "phone"]);

const BOT_SCREEN_TARGET_KINDS = Object.freeze(["element", "point"]);

const BOT_SCREEN_STEP_TOOL = "computer_use";

const BOT_SCREEN_STEP_ACTIONS = Object.freeze([
  "capture", "click", "double_click", "right_click", "middle_click", "drag", "scroll", "type", "key",
  "set_value", "wait", "list_apps", "list_windows", "focus_app",
]);
const BOT_SCREEN_SCROLL_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);

const BOT_SCREEN_NAMED_KEYS = Object.freeze([
  "return", "enter", "escape", "esc", "tab", "backspace", "delete", "space", "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown", "insert", "menu", ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

const BOT_SCREEN_SHORTCUT_MODIFIERS = Object.freeze(["ctrl", "alt", "option", "cmd", "super", "meta", "win", "windows", "fn"]);
const BOT_SCREEN_STEP_LABEL_MAX = 60;
const BOT_SCREEN_STEP_APP_MAX = 40;

const ELEMENT_COORD_MAX = 1_000_000;
const STEP_KEYS = /^[A-Za-z0-9+_-]{1,32}$/;

const STEP_CONTROL_RUN = /[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]+/gu;

const BOT_SCREEN_STILL_EVERY_MS = 1_000;

const BOT_SCREEN_PROBE_EVERY_MS = 1_000;

const BOT_SCREEN_CURRENT_MS = 3_000;

const BOT_SCREEN_STATES = Object.freeze([
  "unsupported", "unknown", "missing", "off", "sandboxed", "connecting", "running", "ended",
]);
const HOST_STATES = new Set(["unsupported", "unknown", "missing", "off", "sandboxed", "running"]);

const BOT_SCREEN_NEEDS                      = new Set(["memory", "host"]);

const BOT_SCREEN_ROOTLESS                      = new Set(["ready", "memory"]);

const BOT_SCREEN_TICK_MS = 250;
const BOT_SCREEN_ACTIVITY_EVERY_MS = 60_000;
const BOT_SCREEN_FILE_POLL_MS = 2_000;
const BOT_SCREEN_STATUS_POLL_MS = 15_000;
const BOT_SCREEN_SNAPSHOT_EVERY_MS = 100;

const BOT_SCREEN_SNAPSHOT_MAX = Object.freeze({ w: 720, h: 450 });

const BOT_SCREEN_SNAPSHOT_COLOR_MAX = Object.freeze({ w: 512, h: 320 });
const BOT_SCREEN_MAX_FRAME = Object.freeze({ w: 960, h: 600 });
const STATUS_TIMEOUT_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const RECONNECT_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const MAX_DIRTY = 16;
const REASON_MAX = 200;
const RFB_MIN_REQUEST_MS = 80;

const nodeFiles                 = {
  read(path) {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists(path) {
    try {
      fs.statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  touch(path) {
    try {
      const at = new Date();
      try {
        fs.utimesSync(path, at, at);
      } catch (err     ) {
        if (!err || err.code !== "ENOENT") return false;
        fs.closeSync(fs.openSync(path, "a", 0o600));
      }
      return true;
    } catch {
      return false;
    }
  },
};

function parseLeaseFile(raw               )                 {
  if (raw === null) return { holder: "agent", viewerId: null, since: 0, reason: "", epoch: 0 };
  const closed                 = { holder: "human", viewerId: "unreadable-lease", since: 0, reason: "lease file corrupt", epoch: -1 };
  let data     ;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return closed;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || (data.holder !== "agent" && data.holder !== "human")) return closed;
  return {
    holder: data.holder,
    viewerId: typeof data.viewer_id === "string" && data.viewer_id ? data.viewer_id : null,
    since: typeof data.since === "number" && Number.isFinite(data.since) ? data.since : 0,
    reason: typeof data.reason === "string" ? data.reason : "",
    epoch: Number.isSafeInteger(data.epoch) ? data.epoch : -1,
  };
}

function cleanReason(reason        )         {
  return reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX);
}

function publicLease(lease                       , viewerId        )                          {
  if (!lease) return { known: false, holder: null, mine: false, reason: "", epoch: null, since: null };
  return {
    known: true,
    holder: lease.holder,
    mine: lease.holder === "human" && lease.viewerId === viewerId,
    reason: lease.holder === "human" ? cleanReason(lease.reason) : "",
    epoch: lease.epoch,
    since: Math.round(lease.since * 1000),
  };
}

function clampView(view                      , sw        , sh        )                {
  if (!view) return { x: 0, y: 0, w: sw, h: sh };
  const x = Math.max(0, Math.min(sw - 1, Math.floor(view.x)));
  const y = Math.max(0, Math.min(sh - 1, Math.floor(view.y)));
  const w = Math.max(1, Math.min(sw - x, Math.floor(view.w)));
  const h = Math.max(1, Math.min(sh - y, Math.floor(view.h)));
  return { x, y, w, h };
}

function renderLevels(
  fb            , sw        , sh        , view                      , w        , h        ,
)             {
  const out = new Uint8Array(w * h);
  if (!sw || !sh) return out;
  const v = clampView(view, sw, sh);
  const scale = Math.min(w / v.w, h / v.h);
  const dw = Math.max(1, Math.min(w, Math.round(v.w * scale)));
  const dh = Math.max(1, Math.min(h, Math.round(v.h * scale)));
  const ox = Math.floor((w - dw) / 2);
  const oy = Math.floor((h - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const y0 = v.y + Math.floor((y * v.h) / dh);
    const y1 = Math.max(y0 + 1, v.y + Math.floor(((y + 1) * v.h) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = v.x + Math.floor((x * v.w) / dw);
      const x1 = Math.max(x0 + 1, v.x + Math.floor(((x + 1) * v.w) / dw));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * sw;
        for (let xx = x0; xx < x1; xx++) sum += fb[row + xx];
      }
      const grey = sum / ((y1 - y0) * (x1 - x0));
      out[(oy + y) * w + ox + x] = Math.round((grey * 15) / 255);
    }
  }
  return out;
}

function renderRgb(
  rgb            , sw        , sh        , view                      , w        , h        ,
)             {
  const out = new Uint8Array(w * h * 3);
  if (!sw || !sh) return out;
  const v = clampView(view, sw, sh);
  const scale = Math.min(w / v.w, h / v.h);
  const dw = Math.max(1, Math.min(w, Math.round(v.w * scale)));
  const dh = Math.max(1, Math.min(h, Math.round(v.h * scale)));
  const ox = Math.floor((w - dw) / 2);
  const oy = Math.floor((h - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const y0 = v.y + Math.floor((y * v.h) / dh);
    const y1 = Math.max(y0 + 1, v.y + Math.floor(((y + 1) * v.h) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = v.x + Math.floor((x * v.w) / dw);
      const x1 = Math.max(x0 + 1, v.x + Math.floor(((x + 1) * v.w) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * sw + x0) * 3;
        for (let xx = x0; xx < x1; xx++, p += 3) {
          r += rgb[p];
          g += rgb[p + 1];
          b += rgb[p + 2];
        }
      }
      const area = (y1 - y0) * (x1 - x0);
      const o = ((oy + y) * w + ox + x) * 3;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
    }
  }
  return out;
}

function renderWholeLevels(fb            , sw        , sh        , w        , h        )             {
  return renderLevels(fb, sw, sh, null, w, h);
}

function union(a         , b         )          {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function addDirty(into           , rects           )            {
  const all = into.concat(rects.filter((r) => r.w > 0 && r.h > 0));
  if (all.length <= MAX_DIRTY) return all;
  return [all.reduce(union)];
}

function whole(v     , low        , high        )          {
  return Number.isSafeInteger(v) && v >= low && v <= high;
}

function wantView(raw     )                                   {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const [x, y, w, h] = raw;
  if (!whole(x, 0, RFB_MAX_SIDE) || !whole(y, 0, RFB_MAX_SIDE)) return undefined;
  if (!whole(w, 1, RFB_MAX_SIDE) || !whole(h, 1, RFB_MAX_SIDE)) return undefined;
  return { x, y, w, h };
}

function targetRect(raw     , screen                                 )                  {
  if (!raw || typeof raw !== "object" || raw.v !== BOT_SCREEN_VERSION || !BOT_SCREEN_TARGET_KINDS.includes(raw.kind)) return null;
  const rect = wantView(raw.rect);
  if (!rect) return null;
  if (!screen) return [rect.x, rect.y, rect.w, rect.h];
  if (rect.x >= screen.w || rect.y >= screen.h) return null;
  const cut = clampView(rect, screen.w, screen.h);
  return [cut.x, cut.y, cut.w, cut.h];
}

function stepName(raw     , limit        )                {
  if (typeof raw !== "string") return null;
  const text = Array.from(raw.replace(STEP_CONTROL_RUN, " ").trim()).slice(0, limit).join("").trim();
  return text || null;
}

function stepKeysNameable(keys     )          {
  if (typeof keys !== "string" || !STEP_KEYS.test(keys)) return false;
  const tokens = keys.split(/[+-]/).filter(Boolean).map((t) => t.toLowerCase());
  const pressed = tokens.filter((t) => t !== "shift" && !BOT_SCREEN_SHORTCUT_MODIFIERS.includes(t));
  if (keys.length > 1 && "+-".includes(keys[keys.length - 1]) && "+-".includes(keys[keys.length - 2])) pressed.push(keys[keys.length - 1]);
  if (tokens.some((t) => BOT_SCREEN_SHORTCUT_MODIFIERS.includes(t))) return true;
  return pressed.length > 0 && pressed.every((t) => BOT_SCREEN_NAMED_KEYS.includes(t));
}

function stepBody(raw     , now        )                                 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== BOT_SCREEN_VERSION) return null;
  if (raw.tool !== BOT_SCREEN_STEP_TOOL || !BOT_SCREEN_STEP_ACTIONS.includes(raw.action)) return null;
  const action         = raw.action;
  const body                          = { v: BOT_SCREEN_VERSION, tool: BOT_SCREEN_STEP_TOOL, action };
  for (const [field, limit] of [["label", BOT_SCREEN_STEP_LABEL_MAX], ["app", BOT_SCREEN_STEP_APP_MAX]]         ) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "string") return null;
    const name = stepName(raw[field], limit);
    if (name !== null) body[field] = name;
  }
  if (raw.keys !== undefined) {
    if (action !== "key" || raw.chars !== undefined || !stepKeysNameable(raw.keys)) return null;
    body.keys = raw.keys;
  }
  if (raw.chars !== undefined) {
    const ok = action === "type" ? whole(raw.chars, 0, Number.MAX_SAFE_INTEGER) : action === "key" && raw.chars === 1;
    if (!ok) return null;
    body.chars = raw.chars;
  }
  if (raw.direction !== undefined) {
    if (action !== "scroll" || !BOT_SCREEN_SCROLL_DIRECTIONS.includes(raw.direction)) return null;
    body.direction = raw.direction;
  }
  body.at = whole(raw.at, 0, Number.MAX_SAFE_INTEGER) ? raw.at : now;
  return body;
}

function elementBox(raw     , screen                                 )                                            {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.rect) || raw.rect.length !== 4) return null;
  const [x, y, w, h] = raw.rect;
  if (![x, y, w, h].every((n) => Number.isInteger(n) && Math.abs(n) <= ELEMENT_COORD_MAX)) return null;
  if (w <= 0 || h <= 0) return null;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = screen ? Math.min(screen.w, x + w) : x + w;
  const y1 = screen ? Math.min(screen.h, y + h) : y + h;
  if (x1 <= x0 || y1 <= y0) return null;
  const box                                     = { rect: [x0, y0, x1 - x0, y1 - y0] };
  const label = stepName(raw.label, BOT_SCREEN_STEP_LABEL_MAX);
  if (label !== null) box.label = label;
  return box;
}

function elementsBody(raw     , screen                                 )                                 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== BOT_SCREEN_VERSION) return null;
  if (!Array.isArray(raw.elements) || typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  const elements                                            = [];
  for (const item of raw.elements) {
    const box = elementBox(item, screen);
    if (!box) continue;
    elements.push(box);
    if (elements.length >= BOT_SCREEN_ELEMENTS_MAX) break;
  }
  return { v: BOT_SCREEN_VERSION, elements, at: raw.at };
}

const BOT_SCREEN_APPROVAL_ACTIONS = Object.freeze([...BOT_SCREEN_STEP_ACTIONS, "bring_to_front"]);

function approvalBotScreenBody(raw     )                                 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== BOT_SCREEN_VERSION) return null;
  if (raw.tool !== BOT_SCREEN_STEP_TOOL) return null;
  const body                          = {
    v: BOT_SCREEN_VERSION,
    tool: BOT_SCREEN_STEP_TOOL,
    mode: raw.mode === "foreground" ? "foreground" : "background",
  };
  const action = BOT_SCREEN_APPROVAL_ACTIONS.includes(raw.action) ? raw.action : null;
  if (action) body.action = action;
  for (const [field, limit] of [["label", BOT_SCREEN_STEP_LABEL_MAX], ["app", BOT_SCREEN_STEP_APP_MAX]]         ) {
    const name = stepName(raw[field], limit);
    if (name !== null) body[field] = name;
  }
  if (action === "key" && stepKeysNameable(raw.keys)) body.keys = raw.keys;
  if (action === "scroll" && BOT_SCREEN_SCROLL_DIRECTIONS.includes(raw.direction)) body.direction = raw.direction;
  const rect = BOT_SCREEN_TARGET_KINDS.includes(raw.kind) ? wantView(raw.rect) : null;
  if (rect) {
    body.rect = [rect.x, rect.y, rect.w, rect.h];
    body.kind = raw.kind;
    if (raw.field === true && (action === "type" || action === "key")) body.field = true;
  }
  return body;
}

function hash12(bytes            )         {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function createBotScreenSource(opts                        )                  {
  const socketPath = typeof opts.socket === "string" && opts.socket ? opts.socket : null;
  const dir = socketPath ? dirname(socketPath) : null;
  const probe                 = {
    lease: !!(opts.probe && opts.probe.lease),
    status: !!(opts.probe && opts.probe.status),
    snapshot: !!(opts.probe && opts.probe.snapshot),
    start: !!(opts.probe && opts.probe.start),
  };
  const request = typeof opts.request === "function" ? opts.request : null;
  const files = opts.files || nodeFiles;
  const connect = opts.connect || ((path        ) => createConnection(path));
  const now = opts.now || (() => Date.now());
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const viewerId = opts.viewerId || randomBytes(16).toString("base64url");

  const viewers = new Map                             ();

  const askers = new Set        ();
  let state = socketPath ? "unknown" : "unsupported";
  let screen                                  = null;
  let placement                = null;

  let need                = null;

  let hostKind                = null;

  let rootless                = null;
  let rfb                   = null;
  let rfbReady = false;
  let colourWanted = false;
  let snapshot                 = null;
  let snapshotHash = "";

  let snapshotColorAsked = false;
  let changeSeq = 0;
  let changedAt = 0;
  let lease                        = null;
  let leaseKey = "";
  let lastTouch = Number.NEGATIVE_INFINITY;
  let lastFilePoll = Number.NEGATIVE_INFINITY;
  let lastStatusAt = Number.NEGATIVE_INFINITY;
  let lastSnapshotAt = Number.NEGATIVE_INFINITY;
  let socketSeen = false;
  let statusInFlight = false;
  let snapshotInFlight = false;
  let snapshotTimer      = null;
  let reconnectAttempt = 0;
  let reconnectAt = Number.POSITIVE_INFINITY;
  let tickTimer      = null;
  let generation = 0;
  let disposed = false;
  let touches = 0;
  let framesSent = 0;

  let lastElements                                 = null;
  let targetsSent = 0;
  let stepsSent = 0;
  let elementsSent = 0;
  let stillsSent = 0;
  let runsSent = 0;
  let probes = 0;
  let lastProbeAt = Number.NEGATIVE_INFINITY;

  function trace(event        , data                         )       {
    if (!opts.trace) return;
    try {
      opts.trace(event, data);
    } catch {

    }
  }

  function send(clientId        , frame                         )       {
    try {
      opts.send(clientId, JSON.stringify(frame));
    } catch {

    }
  }

  function viewerCount()         {
    let n = 0;
    for (const m of viewers.values()) n += m.size;
    return n;
  }

  function statusFrame()                          {
    return {
      type: BOT_SCREEN_PROTOCOL.status,
      v: BOT_SCREEN_VERSION,
      state,
      screen: screen ? { w: screen.w, h: screen.h } : null,
      placement,
      need,
      host: hostKind,
      rootless,
      control: probe.lease && dir ? "lease" : "unknown",

      startable: !!(probe.start && request && opts.startHandled === true),
      at: now(),
    };
  }

  function leaseFrame()                          {
    return { type: BOT_SCREEN_PROTOCOL.lease, v: BOT_SCREEN_VERSION, ...publicLease(probe.lease ? lease : null, viewerId) };
  }

  function broadcast(frame                         )       {
    for (const clientId of viewers.keys()) send(clientId, frame);
  }

  function setState(next        , why        )       {
    if (next === state) return;
    const was = state;
    state = next;
    trace("bot_screen_state", { state, was, why, w: screen ? screen.w : null, h: screen ? screen.h : null, placement });
    const frame = statusFrame();
    broadcast(frame);

    for (const clientId of askers) if (!viewers.has(clientId)) send(clientId, frame);
  }

  function freePictures()       {
    snapshot = null;
    snapshotHash = "";
    snapshotColorAsked = false;
  }

  function forgetElements()       {
    lastElements = null;
  }

  function closeRfb()       {
    const r = rfb;
    rfb = null;
    rfbReady = false;
    if (r) r.close();
  }

  function picture()                 {
    if (rfb && rfbReady && rfb.width && rfb.height) {
      const rgb = rfb.framebufferRgb();
      return {
        fb: rfb.framebuffer(),
        rgb: rgb.length === rfb.width * rfb.height * 3 ? rgb : null,
        w: rfb.width,
        h: rfb.height,
        source: "rfb",
      };
    }
    return snapshot;
  }

  function flushViewer(clientId        , name        , v        )       {
    const want = v.want;
    if (!want) return;
    const pic = picture();
    if (!pic) return;

    const space = pic.source === "snapshot" && screen ? screen : { w: pic.w, h: pic.h };
    const view = clampView(want.view, space.w, space.h);
    const viewKey = `${view.x},${view.y},${view.w},${view.h}`;

    if (want.color && !pic.rgb && pic.source === "snapshot" && !snapshotColorAsked) return;
    const color = want.color && !!pic.rgb;
    const sameShape = v.sentW === want.w && v.sentH === want.h && v.sentView === viewKey && v.sentColor === color;
    if (v.sentSeq === changeSeq && sameShape) return;
    const kx = pic.w / space.w;
    const ky = pic.h / space.h;
    const picView = clampView({ x: view.x * kx, y: view.y * ky, w: Math.ceil(view.w * kx), h: Math.ceil(view.h * ky) }, pic.w, pic.h);

    const data = color
      ? encodePngRgb(renderRgb(pic.rgb , pic.w, pic.h, picView, want.w, want.h), want.w, want.h)
      : packLevels(renderLevels(pic.fb, pic.w, pic.h, picView, want.w, want.h));
    const all = [{ x: 0, y: 0, w: space.w, h: space.h }];
    const dirty = v.sentSeq < 0 || !sameShape || pic.source === "snapshot" ? all : v.dirty;
    v.want = null;
    v.sentSeq = changeSeq;
    v.sentW = want.w;
    v.sentH = want.h;
    v.sentView = viewKey;
    v.sentColor = color;
    v.dirty = [];
    v.frames++;
    framesSent++;
    const frame                          = {
      type: BOT_SCREEN_PROTOCOL.frame,
      v: BOT_SCREEN_VERSION,
      viewer: name,
      n: want.n,
      seq: changeSeq,
      w: want.w,
      h: want.h,
      data: data.toString("base64"),
      screen: { w: space.w, h: space.h },
      view: [view.x, view.y, view.w, view.h],
      dirty: dirty.map((r) => [r.x, r.y, r.w, r.h]),
      at: changedAt,
      source: pic.source,
    };
    if (color) frame.fmt = "png";
    send(clientId, frame);
    trace("bot_screen_frame", {
      viewer: name,
      n: want.n,
      seq: changeSeq,
      w: want.w,
      h: want.h,
      dirty: dirty.length,
      source: pic.source,
      color,
    });
  }

  function flushAll()       {
    for (const [clientId, m] of viewers) for (const [name, v] of m) flushViewer(clientId, name, v);
  }

  function wantsWaiting()          {
    for (const m of viewers.values()) for (const v of m.values()) if (v.want && v.sentSeq >= 0) return true;
    return false;
  }

  function sendStills(at        , paced         )       {
    let sent = 0;
    for (const [clientId, m] of viewers) {
      for (const [name, v] of m) {
        const want = v.want;

        if (!want || v.sentSeq < 0) continue;
        if (paced && at - Math.max(want.at, want.stillAt) < BOT_SCREEN_STILL_EVERY_MS) continue;
        want.stillAt = at;
        send(clientId, { type: BOT_SCREEN_PROTOCOL.still, v: BOT_SCREEN_VERSION, viewer: name, n: want.n });
        sent++;
      }
    }
    if (!sent) return;
    stillsSent += sent;
    trace("bot_screen_still", { stills: sent, viewers: viewerCount() });
  }

  function stillTick(at        )       {
    const client = rfb;
    if (!client || !rfbReady || !wantsWaiting()) return;
    if (at - lastProbeAt >= BOT_SCREEN_PROBE_EVERY_MS && client.probe()) {
      lastProbeAt = at;
      probes++;
    }
    if (at - client.lastUpdateAt <= BOT_SCREEN_CURRENT_MS) sendStills(at, true);
  }

  function screenChanged(rects           , resized         )       {
    changeSeq++;
    changedAt = now();
    for (const m of viewers.values()) {
      for (const v of m.values()) v.dirty = resized ? rects.slice(0, 1) : addDirty(v.dirty, rects);
    }
    flushAll();
  }

  function connectRfb()       {
    if (rfb || !socketPath || disposed) return;
    const gen = generation;
    setState("connecting", "socket");
    let client                   = null;
    client = createRfbClient({
      connect: () => connect(socketPath),
      minRequestMs: RFB_MIN_REQUEST_MS,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      onReady: (info) => {
        if (gen !== generation || rfb !== client) return;
        rfbReady = true;
        reconnectAttempt = 0;
        reconnectAt = Number.POSITIVE_INFINITY;
        screen = { w: info.width, h: info.height };
        freePictures();
        if (colourWanted && client) client.keepColour(true);
        trace("bot_screen_rfb", { phase: "connected", w: info.width, h: info.height });
        if (state === "running") broadcast(statusFrame());
        else setState("running", "connected");

        stampActivity();
      },
      onUpdate: (update           ) => {
        if (gen !== generation || rfb !== client) return;
        if (update.resized) {
          screen = { w: update.width, h: update.height };
          trace("bot_screen_rfb", { phase: "resized", w: update.width, h: update.height });
          broadcast(statusFrame());
        }
        screenChanged(update.rects, update.resized);
      },
      onEnd: (reason) => {
        if (gen !== generation || rfb !== client) return;
        const wasReady = rfbReady;
        const stats = client ? client.stats() : null;
        rfb = null;
        rfbReady = false;
        trace("bot_screen_rfb", {
          phase: "ended",
          reason: reason || "remote_closed",
          updates: stats ? stats.updates : 0,
          rects: stats ? stats.rects : 0,
          bytes: stats ? stats.bytes : 0,
        });
        forgetElements();
        if (!viewerCount()) return;
        reconnectAt = now() + RECONNECT_MS[Math.min(reconnectAttempt, RECONNECT_MS.length - 1)];
        reconnectAttempt++;
        if (wasReady) setState("ended", reason || "remote_closed");
        else if (state === "connecting") setState("off", reason || "connect_failed");
      },
    });
    rfb = client;
  }

  function hostStatus(raw     )                    {
    if (!raw || typeof raw !== "object" || raw.v !== 1 || !HOST_STATES.has(raw.state)) return null;
    const s = raw.screen;
    const size = s && whole(s.w, 1, 16384) && whole(s.h, 1, 16384) ? { w: s.w, h: s.h } : null;
    const where = typeof raw.placement === "string" && /^[a-z]+(:[a-z0-9_-]{1,32})?$/.test(raw.placement) ? raw.placement : null;
    const why = BOT_SCREEN_NEEDS.has(raw.need) ? raw.need : null;
    const host = why && raw.host === "cloudways" ? "cloudways" : null;
    const offer = why === "host" && BOT_SCREEN_ROOTLESS.has(raw.rootless) ? raw.rootless : null;
    return { state: raw.state, screen: size, placement: where, need: why, host, rootless: offer };
  }

  function applyHostStatus(st            )       {
    placement = st.placement;
    if (st.need !== need || st.host !== hostKind || st.rootless !== rootless) {
      need = st.need;
      hostKind = st.host;
      rootless = st.rootless;

      if (st.state === state) {
        const frame = statusFrame();
        broadcast(frame);
        for (const clientId of askers) if (!viewers.has(clientId)) send(clientId, frame);
      }
    }
    if (st.screen && !(rfb && rfbReady)) screen = st.screen;
    if (st.state === "running") {
      if (socketPath && files.exists(socketPath)) {
        if (!rfb) connectRfb();
      } else {

        setState("unknown", "no_socket");
      }
      return;
    }
    closeRfb();
    if (st.state === "sandboxed") {
      const entering = state !== "sandboxed";
      setState("sandboxed", "status");
      if (entering) lastSnapshotAt = Number.NEGATIVE_INFINITY;
      if (probe.snapshot && !snapshot) pollSnapshot();
      else scheduleSnapshot();
      return;
    }
    freePictures();
    forgetElements();

    if (st.state === "off" && state === "ended") return;
    setState(st.state, "status");
  }

  function refreshStatus(why        )       {
    if (statusInFlight || disposed || !viewerCount()) return;
    lastStatusAt = now();
    if (!socketPath) {
      setState("unsupported", why);
      return;
    }
    if (!probe.status || !request) {

      if (files.exists(socketPath)) {
        if (!rfb) connectRfb();
      } else if (state !== "ended") setState("unknown", "no_status");
      return;
    }
    const gen = generation;
    statusInFlight = true;
    let settled = false;
    const timer = setTimeoutFn(() => finish(null, "timeout"), STATUS_TIMEOUT_MS);
    function finish(raw     , error               )       {
      if (settled) return;
      settled = true;
      statusInFlight = false;
      clearTimeoutFn(timer);
      if (gen !== generation || disposed || !viewerCount()) return;
      const st = error ? null : hostStatus(raw);
      if (!st) {
        trace("bot_screen_status", { ok: false, why, error: error || "invalid" });
        if (state !== "ended" && state !== "running") setState("unknown", error || "invalid");
        return;
      }
      trace("bot_screen_status", { ok: true, why, state: st.state });
      applyHostStatus(st);
    }
    Promise.resolve()
      .then(() => request(LINK_BOT_SCREEN_STATUS_METHOD, {}))
      .then((raw) => finish(raw, null), (err) => finish(null, String((err && err.code) || "request_failed").slice(0, 40)));
  }

  function colorWanted()          {
    for (const m of viewers.values()) for (const v of m.values()) if (v.color) return true;
    return false;
  }

  function pollSnapshot()       {
    if (snapshotInFlight || !probe.snapshot || !request || state !== "sandboxed") return;
    lastSnapshotAt = now();
    const gen = generation;
    snapshotInFlight = true;
    let settled = false;
    const timer = setTimeoutFn(() => finish(null), SNAPSHOT_TIMEOUT_MS);
    function finish(raw     )       {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      if (gen !== generation || disposed || state !== "sandboxed") return;
      snapshotInFlight = false;
      if (!raw || raw.v !== 1 || typeof raw.gray !== "string") {
        trace("bot_screen_snapshot", { ok: false, reason: raw && typeof raw.reason === "string" ? raw.reason.slice(0, 40) : "none" });
        scheduleSnapshot(1_000);
        return;
      }
      const w = raw.w;
      const h = raw.h;
      if (!whole(w, 1, BOT_SCREEN_SNAPSHOT_MAX.w) || !whole(h, 1, BOT_SCREEN_SNAPSHOT_MAX.h)) { scheduleSnapshot(1_000); return; }
      const gray = new Uint8Array(Buffer.from(raw.gray, "base64"));
      if (gray.length !== w * h) { scheduleSnapshot(1_000); return; }

      let rgb                    = null;
      if (typeof raw.rgb === "string") {
        const bytes = new Uint8Array(Buffer.from(raw.rgb, "base64"));
        if (bytes.length === w * h * 3) rgb = bytes;
      }
      const digest = rgb
        ? createHash("sha256").update(gray).update(rgb).digest("hex").slice(0, 12)
        : hash12(gray);
      const resized = !snapshot || snapshot.w !== w || snapshot.h !== h;
      snapshot = { fb: gray, rgb, w, h, source: "snapshot" };
      snapshotColorAsked = color;
      trace("bot_screen_snapshot", { ok: true, w, h, color: !!rgb, changed: digest !== snapshotHash, ms: now() - lastSnapshotAt });
      if (digest === snapshotHash) {

        flushAll();
        sendStills(now(), true);
        scheduleSnapshot();
        return;
      }
      snapshotHash = digest;
      if (resized) broadcast(statusFrame());
      screenChanged([{ x: 0, y: 0, w, h }], resized);
      scheduleSnapshot();
    }

    const color = colorWanted();
    const max = color ? BOT_SCREEN_SNAPSHOT_COLOR_MAX : BOT_SCREEN_SNAPSHOT_MAX;
    const params                          = { maxW: max.w, maxH: max.h };
    if (color) params.color = true;
    Promise.resolve()
      .then(() => request(LINK_BOT_SCREEN_SNAPSHOT_METHOD, params))
      .then((raw) => finish(raw), () => finish(null));
  }

  function scheduleSnapshot(backoffMs = 0)       {
    if (snapshotTimer !== null || snapshotInFlight || disposed || state !== "sandboxed") return;
    const pending = Array.from(viewers.values()).some(m => Array.from(m.values()).some(v => v.want));
    if (!pending) return;
    const gen = generation;
    const delay = Math.max(backoffMs, BOT_SCREEN_SNAPSHOT_EVERY_MS - (now() - lastSnapshotAt), 0);
    snapshotTimer = setTimeoutFn(() => {
      snapshotTimer = null;
      if (gen === generation && !disposed) pollSnapshot();
    }, delay);
    if (snapshotTimer && typeof snapshotTimer.unref === "function") snapshotTimer.unref();
  }

  function readLease(announce         )       {
    if (!probe.lease || !dir) return;
    const next = parseLeaseFile(files.read(join(dir, "lease.json")));
    const pub = publicLease(next, viewerId);
    const key = JSON.stringify(pub);
    lease = next;
    if (key === leaseKey) return;
    leaseKey = key;
    trace("bot_screen_lease", { holder: pub.holder, mine: pub.mine, epoch: pub.epoch });
    if (announce) broadcast(leaseFrame());
  }

  function stampActivity()       {
    if (!dir || (state !== "running" && state !== "connecting")) return;
    const at = now();
    if (at - lastTouch < BOT_SCREEN_ACTIVITY_EVERY_MS) return;
    lastTouch = at;
    if (files.touch(join(dir, "activity"))) touches++;
  }

  function tick()       {
    tickTimer = null;
    if (disposed || !viewerCount()) return;
    const at = now();
    readLease(true);
    stampActivity();
    if (state === "running") {
      stillTick(at);
    } else if (state === "sandboxed") {
      scheduleSnapshot();
      if (at - lastStatusAt >= BOT_SCREEN_STATUS_POLL_MS) refreshStatus("poll");
    } else if (state !== "running" && state !== "connecting" && state !== "unsupported") {
      if (socketPath && at - lastFilePoll >= BOT_SCREEN_FILE_POLL_MS) {
        lastFilePoll = at;
        const seen = files.exists(socketPath);
        const appeared = seen && !socketSeen;
        socketSeen = seen;
        if (appeared || at >= reconnectAt || at - lastStatusAt >= BOT_SCREEN_STATUS_POLL_MS) {
          reconnectAt = Number.POSITIVE_INFINITY;
          refreshStatus(appeared ? "socket" : "poll");
        }
      }
    }
    scheduleTick();
  }

  function start()       {
    generation++;
    reconnectAttempt = 0;
    reconnectAt = Number.POSITIVE_INFINITY;
    lastFilePoll = Number.NEGATIVE_INFINITY;
    socketSeen = !!socketPath && files.exists(socketPath);
    if (socketPath) state = "unknown";
    leaseKey = "";

    readLease(false);
    refreshStatus("open");
    stampActivity();
    if (socketPath) scheduleTick();
  }

  function scheduleTick()       {
    if (tickTimer !== null) return;
    tickTimer = setTimeoutFn(tick, BOT_SCREEN_TICK_MS);

    if (tickTimer && typeof tickTimer.unref === "function") tickTimer.unref();
  }

  function stop()       {
    generation++;
    if (tickTimer !== null) clearTimeoutFn(tickTimer);
    tickTimer = null;
    if (snapshotTimer !== null) clearTimeoutFn(snapshotTimer);
    snapshotTimer = null;
    closeRfb();
    freePictures();
    forgetElements();
    statusInFlight = false;
    snapshotInFlight = false;
    lastProbeAt = Number.NEGATIVE_INFINITY;
    if (socketPath) state = "unknown";
    trace("bot_screen_viewer", { phase: "stopped", touches });
  }

  function open(clientId        , name        )       {
    let m = viewers.get(clientId);
    if (!m) {
      m = new Map();
      viewers.set(clientId, m);
    }
    const first = viewerCount() === 0;
    if (!m.has(name)) {
      m.set(name, { want: null, color: false, sentColor: false, sentSeq: -1, sentW: 0, sentH: 0, sentView: "", dirty: [], frames: 0 });
    } else {

      const v = m.get(name) ;
      v.sentSeq = -1;
      v.want = null;
      v.color = false;
      v.dirty = [];
    }
    trace("bot_screen_viewer", { phase: "open", viewer: name, viewers: viewerCount() });
    if (first) start();
    send(clientId, statusFrame());
    send(clientId, leaseFrame());

    const kept = lastElements ? elementsBody(lastElements, screen) : null;
    if (kept) send(clientId, { type: BOT_SCREEN_PROTOCOL.elements, ...kept });
  }

  function close(clientId        , name               )       {
    const m = viewers.get(clientId);
    if (!m) return;
    if (name === null) m.clear();
    else m.delete(name);
    if (!m.size) viewers.delete(clientId);
    trace("bot_screen_viewer", { phase: "close", viewer: name || "all", viewers: viewerCount() });
    if (!viewerCount()) stop();
  }

  function viewerName(msg     )                {
    return typeof msg.viewer === "string" && BOT_SCREEN_VIEWERS.includes(msg.viewer) ? msg.viewer : null;
  }

  function sendTarget(raw     )         {
    if (disposed || !viewers.size) return 0;
    const rect = targetRect(raw, screen);
    if (!rect) {
      trace("bot_screen_target", { sent: false, why: "malformed" });
      return 0;
    }
    const frame = {
      type: BOT_SCREEN_PROTOCOL.target,
      v: BOT_SCREEN_VERSION,
      rect,
      kind: raw.kind,
      at: whole(raw.at, 0, Number.MAX_SAFE_INTEGER) ? raw.at : now(),
    };
    for (const clientId of viewers.keys()) send(clientId, frame);
    targetsSent++;
    trace("bot_screen_target", { sent: true, kind: raw.kind, clients: viewers.size });
    return viewers.size;
  }

  function sendStep(raw     )         {
    if (disposed || !viewers.size) return 0;
    const body = stepBody(raw, now());
    if (!body) {
      trace("bot_screen_step", { sent: false, why: "malformed" });
      return 0;
    }
    const frame = { type: BOT_SCREEN_PROTOCOL.step, ...body };
    for (const clientId of viewers.keys()) send(clientId, frame);
    stepsSent++;

    const fields = ["label", "app", "keys", "chars", "direction"].filter((k) => k in body).join(",");
    trace("bot_screen_step", { sent: true, action: body.action, fields, clients: viewers.size });
    return viewers.size;
  }

  function sendElements(raw     )         {
    if (disposed) return 0;
    const body = elementsBody(raw, screen);
    if (!body) {
      trace("bot_screen_elements", { sent: false, why: "malformed" });
      return 0;
    }
    lastElements = body;
    const count = (body.elements             ).length;
    if (!viewers.size) {
      trace("bot_screen_elements", { sent: false, why: "no_view", elements: count });
      return 0;
    }
    const frame = { type: BOT_SCREEN_PROTOCOL.elements, ...body };
    for (const clientId of viewers.keys()) send(clientId, frame);
    elementsSent++;

    trace("bot_screen_elements", { sent: true, elements: count, clients: viewers.size });
    return viewers.size;
  }

  function sendRun(raw     )         {
    if (disposed || !opts.clients) return 0;
    const at = raw && whole(raw.at, 0, Number.MAX_SAFE_INTEGER) ? raw.at : now();
    if (!raw || typeof raw !== "object" || raw.v !== BOT_SCREEN_VERSION || now() - at > BOT_SCREEN_RUN_STALE_MS) {
      trace("bot_screen_run", { sent: false, why: !raw || raw.v !== BOT_SCREEN_VERSION ? "malformed" : "stale" });
      return 0;
    }
    let clients          ;
    try {
      clients = Array.from(opts.clients());
    } catch {
      clients = [];
    }
    const frame = { type: BOT_SCREEN_PROTOCOL.run, v: BOT_SCREEN_VERSION, at };
    for (const clientId of clients) send(clientId, frame);
    runsSent++;
    trace("bot_screen_run", { sent: true, clients: clients.length });
    return clients.length;
  }

  function answerStatus(clientId        , ask         )                {
    if (ask && socketPath && probe.status && request) {

      Promise.resolve()
        .then(() => request(LINK_BOT_SCREEN_STATUS_METHOD, {}))
        .then((raw) => {
          const st = hostStatus(raw);
          send(clientId, {
            ...statusFrame(),
            state: st ? st.state : "unknown",
            screen: st ? st.screen : null,
            placement: st ? st.placement : null,
            need: st ? st.need : null,
            host: st ? st.host : null,
            rootless: st ? st.rootless : null,
          });
        }, () => send(clientId, { ...statusFrame(), state: "unknown" }));
      return null;
    }
    return JSON.stringify(statusFrame());
  }

  return {
    handle(clientId, msg) {
      if (disposed || !msg || typeof msg !== "object" || typeof clientId !== "string") return null;
      switch (msg.type) {
        case BOT_SCREEN_PROTOCOL.open: {
          const name = viewerName(msg);
          if (name) open(clientId, name);
          return null;
        }
        case BOT_SCREEN_PROTOCOL.close: {
          const name = viewerName(msg);
          if (name) close(clientId, name);
          return null;
        }
        case BOT_SCREEN_PROTOCOL.statusGet:
          if (!viewers.has(clientId)) askers.add(clientId);

          return answerStatus(clientId, !viewerCount() || state === "unknown" || state === "connecting");
        case BOT_SCREEN_PROTOCOL.want: {
          const name = viewerName(msg);
          const m = viewers.get(clientId);
          const v = name && m ? m.get(name) : null;
          if (!v || !whole(msg.n, 0, Number.MAX_SAFE_INTEGER)) return null;
          if (!whole(msg.w, 2, BOT_SCREEN_MAX_FRAME.w) || !whole(msg.h, 2, BOT_SCREEN_MAX_FRAME.h)) return null;
          const view = wantView(msg.view);
          if (view === undefined) return null;
          const color = msg.color === true;
          v.color = color;
          v.want = { n: msg.n, w: msg.w, h: msg.h, view, color, at: now(), stillAt: Number.NEGATIVE_INFINITY };
          flushViewer(clientId, name , v);
          scheduleSnapshot();
          return null;
        }
        default:
          return null;
      }
    },
    target: sendTarget,
    step: sendStep,
    elements: sendElements,
    run: sendRun,
    keepColour(on) {
      colourWanted = on && !disposed;
      if (rfb && rfbReady) rfb.keepColour(colourWanted);
    },
    colour: () => (rfb && rfbReady ? rfb.colour() : null),
    refresh() {
      if (disposed) return;

      refreshStatus("start");
      for (const clientId of askers) {
        if (viewers.has(clientId)) continue;
        const reply = answerStatus(clientId, true);
        if (reply) {
          try { opts.send(clientId, reply); } catch {  }
        }
      }
    },
    clientGone(clientId) {
      askers.delete(clientId);
      if (viewers.has(clientId)) close(clientId, null);
    },
    dispose() {
      if (disposed) return;
      viewers.clear();
      askers.clear();
      stop();
      disposed = true;
    },
    stats: () => ({
      state,
      viewers: viewerCount(),
      connected: !!(rfb && rfbReady),
      changeSeq,
      framesSent,
      targetsSent,
      stepsSent,
      elementsSent,
      stillsSent,
      runsSent,
      probes,
      touches,
      control: probe.lease && dir ? "lease" : "unknown",
    }),
  };
}

function botScreenFromHello(config     )                                                          {
  if (!config || typeof config.botScreenSocket !== "string" || !config.botScreenSocket) return null;
  const found = config.botScreenProbe;
  return {
    socket: config.botScreenSocket,
    probe: found && typeof found === "object"
      ? { lease: found.lease === true, status: found.status === true, snapshot: found.snapshot === true, start: found.start === true }
      : null,
  };
}

function unsupportedBotScreenStatus(now         = Date.now())         {
  return JSON.stringify({
    type: BOT_SCREEN_PROTOCOL.status,
    v: BOT_SCREEN_VERSION,
    state: "unsupported",
    screen: null,
    placement: null,
    control: "unknown",
    at: now,
  });
}

module.exports = { BOT_SCREEN_PROTOCOL, BOT_SCREEN_VERSION, LINK_BOT_SCREEN_STATUS_METHOD, LINK_BOT_SCREEN_SNAPSHOT_METHOD, BOT_SCREEN_TARGET_EVENT, BOT_SCREEN_STEP_EVENT, BOT_SCREEN_ELEMENTS_EVENT, BOT_SCREEN_ELEMENTS_MAX, BOT_SCREEN_RUN_EVENT, BOT_SCREEN_RUN_STALE_MS, BOT_SCREEN_VIEWERS, BOT_SCREEN_TARGET_KINDS, BOT_SCREEN_STEP_TOOL, BOT_SCREEN_STEP_ACTIONS, BOT_SCREEN_SCROLL_DIRECTIONS, BOT_SCREEN_NAMED_KEYS, BOT_SCREEN_SHORTCUT_MODIFIERS, BOT_SCREEN_STEP_LABEL_MAX, BOT_SCREEN_STEP_APP_MAX, BOT_SCREEN_STILL_EVERY_MS, BOT_SCREEN_PROBE_EVERY_MS, BOT_SCREEN_CURRENT_MS, BOT_SCREEN_STATES, BOT_SCREEN_NEEDS, BOT_SCREEN_TICK_MS, BOT_SCREEN_ACTIVITY_EVERY_MS, BOT_SCREEN_FILE_POLL_MS, BOT_SCREEN_STATUS_POLL_MS, BOT_SCREEN_SNAPSHOT_EVERY_MS, BOT_SCREEN_SNAPSHOT_MAX, BOT_SCREEN_SNAPSHOT_COLOR_MAX, BOT_SCREEN_MAX_FRAME, parseLeaseFile, publicLease, clampView, renderLevels, renderRgb, renderWholeLevels, addDirty, targetRect, stepName, stepKeysNameable, stepBody, elementsBody, BOT_SCREEN_APPROVAL_ACTIONS, approvalBotScreenBody, createBotScreenSource, botScreenFromHello, unsupportedBotScreenStatus };
