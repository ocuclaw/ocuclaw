const LINK_BOARD_MOMENT_PUSH_METHOD = "board.moment.push";
const LINK_BOARD_MOMENT_ACK_METHOD = "board.moment.ack";
const BOARD_MOMENT_FRAME = "ocuclaw.board.moment";
const BOARD_MOMENT_ACK_FRAME = "ocuclaw.board.moment.ack";
const BOARD_MOMENT_VERSION = 1;
const BOARD_MOMENT_ACK_STATES = new Set(["durable", "volatile"]);

const ATTENTION = new Set(["review", "question", "failure", "done"]);
const CODES = new Set([
  "unsupported", "uncertified", "schema_unsupported", "store_missing", "invalid_target",
  "empty_board", "temporarily_unavailable", "disconnected", "stale_target", "stale_scope",
  "expired_request", "outcome_unknown", "deferred",
]);
const ID = /^[A-Za-z0-9_-]{22}$/;
const GATEWAY = /^[0-9a-f]{16}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CARD_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ANCHOR = /^[A-Za-z0-9_-]{16}$/;
const KIND = /^[a-z][a-z_]{0,31}$/;

const BOARD_MOMENT_PUSH_MAX = 20;
const ACK_QUEUE_MAX = 256;
const DEFAULT_RETRY_DELAY_MS = 500;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (v     , keys          ) =>
  record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v     , limit        ) =>
  typeof v === "string" && v.length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v);
const whole = (v     , low = 0) => Number.isSafeInteger(v) && v >= low;

function guard(raw     ) {
  if (!record(raw) || typeof raw.enabled !== "boolean") return null;
  if (raw.enabled) return exactKeys(raw, ["enabled"]) ? { enabled: true } : null;
  if (!Object.keys(raw).every(k => ["enabled", "code", "owner"].includes(k)) || !CODES.has(raw.code)) return null;
  if (raw.owner !== undefined && !whole(raw.owner, 1)) return null;
  return raw.owner === undefined ? { enabled: false, code: raw.code } : { enabled: false, code: raw.code, owner: raw.owner };
}

function boardMoment(raw     )      {
  if (!exactKeys(raw, ["v", "deliveryId", "sourceId", "gateway", "profile", "board", "card", "event",
    "attention", "expiresAt", "display", "actions"])) return null;
  const { board, card, event, display, actions } = raw;
  if (raw.v !== BOARD_MOMENT_VERSION || typeof raw.deliveryId !== "string" || !ID.test(raw.deliveryId) ||
    typeof raw.sourceId !== "string" || !ID.test(raw.sourceId) ||
    typeof raw.gateway !== "string" || !GATEWAY.test(raw.gateway) ||
    typeof raw.profile !== "string" || !PROFILE.test(raw.profile)) return null;
  if (!exactKeys(board, ["slug", "name", "anchor"]) || typeof board.slug !== "string" || !SLUG.test(board.slug) ||
    !text(board.name, 80) || typeof board.anchor !== "string" || !ANCHOR.test(board.anchor)) return null;
  if (!exactKeys(card, ["id", "title"]) || typeof card.id !== "string" || !CARD_ID.test(card.id) || !text(card.title, 200)) return null;
  const withRun = record(event) && Object.hasOwn(event, "runId");
  if (!exactKeys(event, withRun ? ["id", "kind", "at", "runId"] : ["id", "kind", "at"]) || !whole(event.id, 1) ||
    typeof event.kind !== "string" || !KIND.test(event.kind) || !whole(event.at) || (withRun && !whole(event.runId, 1))) return null;
  if (!ATTENTION.has(raw.attention) || !whole(raw.expiresAt)) return null;
  if (!exactKeys(display, ["line"]) || !text(display.line, 120)) return null;
  if (!exactKeys(actions, ["verdict", "answer"])) return null;
  const verdict = guard(actions.verdict);
  const answer = guard(actions.answer);
  if (!verdict || !answer) return null;
  return {
    v: BOARD_MOMENT_VERSION,
    deliveryId: raw.deliveryId,
    sourceId: raw.sourceId,
    gateway: raw.gateway,
    profile: raw.profile,
    board: { slug: board.slug, name: board.name, anchor: board.anchor },
    card: { id: card.id, title: card.title },
    event: withRun ? { id: event.id, kind: event.kind, at: event.at, runId: event.runId } : { id: event.id, kind: event.kind, at: event.at },
    attention: raw.attention,
    expiresAt: raw.expiresAt,
    display: { line: display.line },
    actions: { verdict, answer },
  };
}

function boardMomentAck(raw     )      {
  if (!exactKeys(raw, ["type", "deliveryId", "state"]) || raw.type !== BOARD_MOMENT_ACK_FRAME) return null;
  if (typeof raw.deliveryId !== "string" || !ID.test(raw.deliveryId) || !BOARD_MOMENT_ACK_STATES.has(raw.state)) return null;
  return { deliveryId: raw.deliveryId, state: raw.state };
}

function formatBoardMoment(moment     )         {
  return JSON.stringify({ type: BOARD_MOMENT_FRAME, moment });
}

function createHermesBoardMoments({
  relay,
  link,
  logger,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}     ) {
  let disposed = false;
  let inFlight = false;
  let retryTimer      = null;

  const queue = new Map             ();

  function warn(message     ) {
    if (logger && typeof logger.warn === "function") logger.warn(`[hermes-board-moments] ${message}`);
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== null) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      drain();
    }, retryDelayMs);
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
  }

  function drain() {
    if (disposed || inFlight || retryTimer !== null || queue.size === 0) return;
    const [deliveryId, params]      = queue.entries().next().value;
    inFlight = true;
    let pending     ;
    try {
      pending = link.request(LINK_BOARD_MOMENT_ACK_METHOD, params);
    } catch (err     ) {
      inFlight = false;
      warn(`ack failed: ${err && err.message ? err.message : err}`);
      scheduleRetry();
      return;
    }
    Promise.resolve(pending).then(
      (result     ) => {
        if (disposed) return;
        inFlight = false;
        if (result && result.ok === false && result.error === "invalid_params") {

          if (queue.get(deliveryId) === params) queue.delete(deliveryId);
          warn("ack refused: invalid_params");
          drain();
          return;
        }
        if (!result || result.ok !== true) {
          warn(`ack refused: ${result?.error || "unknown"}`);
          scheduleRetry();
          return;
        }
        if (queue.get(deliveryId) === params) queue.delete(deliveryId);
        drain();
      },
      (err     ) => {
        if (disposed) return;
        inFlight = false;
        warn(`ack failed: ${err && err.message ? err.message : err}`);
        scheduleRetry();
      },
    );
  }

  function ack(raw     )          {
    if (disposed || !record(raw) || typeof raw.deliveryId !== "string" || !ID.test(raw.deliveryId) ||
      !BOARD_MOMENT_ACK_STATES.has(raw.state)) return false;
    if (!queue.has(raw.deliveryId)) {
      if (queue.size >= ACK_QUEUE_MAX) {

        warn("ack queue full");
        return false;
      }
      queue.set(raw.deliveryId, { deliveryId: raw.deliveryId, state: raw.state });
    }
    drain();
    return true;
  }

  const methods      = {};
  methods[LINK_BOARD_MOMENT_PUSH_METHOD] = (params     ) => {
    const list = record(params) && Array.isArray(params.moments) ? params.moments : null;
    if (!list || list.length > BOARD_MOMENT_PUSH_MAX) return { ok: false, error: "invalid_params" };
    let sent = 0;
    let refused = 0;
    for (const raw of list) {
      const moment = boardMoment(raw);
      if (!moment) {
        refused += 1;
        continue;
      }
      if (relay && typeof relay.sendBoardMoment === "function") sent += Number(relay.sendBoardMoment(moment)) || 0;
    }
    if (refused) warn(`refused ${refused} moment(s) that failed validation`);
    return { ok: true, sent, refused };
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (retryTimer !== null) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
    queue.clear();
  }

  return { methods, ack, dispose, pendingAcks: () => queue.size };
}

module.exports = { LINK_BOARD_MOMENT_PUSH_METHOD, LINK_BOARD_MOMENT_ACK_METHOD, BOARD_MOMENT_FRAME, BOARD_MOMENT_ACK_FRAME, BOARD_MOMENT_VERSION, BOARD_MOMENT_ACK_STATES, BOARD_MOMENT_PUSH_MAX, boardMoment, boardMomentAck, formatBoardMoment, createHermesBoardMoments };
