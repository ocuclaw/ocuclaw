const LIVEUI_V2_PAINT_FLOOR_MS = 250;

const LATCH_RECHECK_MIN_MS = 16;

function createLiveUiSurfaceFloor(options                           ) {
  const floorMs = Number.isFinite(options.floorMs) ? (options.floorMs          ) : LIVEUI_V2_PAINT_FLOOR_MS;
  const now = typeof options.nowMs === "function" ? options.nowMs : () => performance.now();
  const setTimer = options.setTimeoutFn || ((fn            , ms        ) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutFn || ((t         ) => clearTimeout(t                                 ));
  const latched = typeof options.isUnderBackpressure === "function" ? options.isUnderBackpressure : () => false;
  const bySurface = new Map                    ();

  function stateOf(surfaceId        )             {
    let st = bySurface.get(surfaceId);
    if (!st) {
      st = { sent: false, lastSentAt: -Infinity, held: null, timer: null, waitingOn: null };
      bySurface.set(surfaceId, st);
    }
    return st;
  }

  function cancel(st            )       {
    if (st.timer !== null) clearTimer(st.timer);
    st.timer = null;
  }

  function emit(st            , held      )       {
    st.sent = true;
    st.lastSentAt = now();
    options.send({
      revision: held.revision,
      origin: held.origin,
      heldMs: Math.max(0, Math.round(now() - held.since)),
      superseded: held.superseded,
      shed: held.shed,
    });
  }

  function hold(st            , revision                       , origin        )       {
    const prev = st.held;
    st.held = prev
      ? {
          revision,
          origin: prev.origin === "agent" || origin === "agent" ? "agent" : origin,
          since: prev.since,
          superseded: prev.superseded + 1,
          shed: prev.shed,
        }
      : { revision, origin, since: now(), superseded: 0, shed: false };
  }

  function flush(surfaceId        )       {
    const st = bySurface.get(surfaceId);
    if (!st) return;
    st.timer = null;
    if (!st.held || st.waitingOn) return;
    if (latched()) {

      st.held.shed = true;
      st.timer = setTimer(() => flush(surfaceId), Math.max(LATCH_RECHECK_MIN_MS, floorMs));
      return;
    }
    const held = st.held;
    st.held = null;
    emit(st, held);
  }

  function arm(surfaceId        , st            )       {
    if (st.timer !== null || st.waitingOn) return;
    const wait = Math.max(0, floorMs - (now() - st.lastSentAt));
    st.timer = setTimer(() => flush(surfaceId), latched() ? Math.max(LATCH_RECHECK_MIN_MS, wait) : wait);
  }

  return {

    enqueue(revision                       , origin = "agent")       {
      const st = stateOf(revision.surfaceId);
      if (st.waitingOn) {

        hold(st, revision, origin);
        return;
      }
      if (!st.sent && !st.held) {

        emit(st, { revision, origin, since: now(), superseded: 0, shed: false });
        return;
      }
      const elapsed = now() - st.lastSentAt;
      if (!st.held && st.timer === null && elapsed >= floorMs && !latched()) {
        emit(st, { revision, origin, since: now(), superseded: 0, shed: false });
        return;
      }
      hold(st, revision, origin);
      if (latched() && st.held) st.held.shed = true;
      arm(revision.surfaceId, st);
    },

    holdFor(surfaceId        , replacementId        )       {
      const st = stateOf(surfaceId);
      st.waitingOn = replacementId;
      cancel(st);
    },

    release(surfaceId        )          {
      const st = bySurface.get(surfaceId);
      if (!st) return false;
      st.waitingOn = null;
      cancel(st);
      if (!st.held) return false;
      const held = st.held;
      st.held = null;
      emit(st, held);
      return true;
    },

    takeHeld(surfaceId        )                               {
      const st = bySurface.get(surfaceId);
      if (!st || !st.held) return null;
      cancel(st);
      const held = st.held;
      st.held = null;
      return held.revision;
    },

    noteSent(surfaceId        )       {
      const st = stateOf(surfaceId);
      st.sent = true;
      st.lastSentAt = now();
    },

    dispose(surfaceId        )       {
      const st = bySurface.get(surfaceId);
      if (st) cancel(st);
      bySurface.delete(surfaceId);
    },

    hasHeld(surfaceId        )          {
      return !!bySurface.get(surfaceId)?.held;
    },
  };
}

module.exports = { LIVEUI_V2_PAINT_FLOOR_MS, createLiveUiSurfaceFloor };
