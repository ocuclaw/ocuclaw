const DEFAULT_PAINT_FLOOR_MS = 250;

function createPaintFloorCoalescer(deps) {
  const paintFloorMs = Number.isFinite(deps.paintFloorMs) ? deps.paintFloorMs : DEFAULT_PAINT_FLOOR_MS;
  const send = deps.send;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const isUnderBackpressure =
    typeof deps.isUnderBackpressure === "function" ? deps.isUnderBackpressure : () => false;

  const bySurface = new Map();

  function isRenderSentinel(p) {
    return !!(p && p.__render === true);
  }

  function markerOf(p) {
    if (!p) return undefined;
    return p.__marker !== undefined ? p.__marker : p.marker;
  }
  function isMarkerOnly(p) {
    return !!p && !isRenderSentinel(p) && Object.keys(p).length === 1 && p.marker !== undefined;
  }

  function mergePatch(base, incoming) {

    if (isMarkerOnly(incoming) && isRenderSentinel(base)) {
      return { ...base, __marker: incoming.marker };
    }
    if (isRenderSentinel(base) !== isRenderSentinel(incoming)) {

      const next = incoming && typeof incoming === "object" ? { ...incoming } : {};
      if (markerOf(next) === undefined) {
        const m = markerOf(base);
        if (m !== undefined) { if (isRenderSentinel(next)) next.__marker = m; else next.marker = m; }
      }
      return next;
    }
    const merged = base ? { ...base } : {};
    if (incoming && typeof incoming === "object") {
      for (const k of Object.keys(incoming)) merged[k] = incoming[k];
    }
    return merged;
  }

  function flush(surfaceId) {
    const st = bySurface.get(surfaceId);
    if (!st || !st.pendingPatch) return;
    st.timer = null;
    if (isUnderBackpressure()) {

      st.timer = setTimeoutFn(() => flush(surfaceId), Math.max(16, paintFloorMs));
      return;
    }
    const patch = st.pendingPatch;
    st.pendingPatch = null;
    st.lastSentAt = nowMs();
    send({ surfaceId, sessionKey: st.sessionKey, patch });
  }

  function enqueue(params) {
    const { surfaceId, sessionKey, patch } = params;
    let st = bySurface.get(surfaceId);
    if (!st) {
      st = { sessionKey, lastSentAt: -Infinity, pendingPatch: null, timer: null };
      bySurface.set(surfaceId, st);
    }
    st.sessionKey = sessionKey;
    const elapsed = nowMs() - st.lastSentAt;
    if (elapsed >= paintFloorMs && !st.timer) {

      st.lastSentAt = nowMs();
      send({ surfaceId, sessionKey, patch });
      return;
    }

    st.pendingPatch = mergePatch(st.pendingPatch, patch);
    if (!st.timer) {
      const wait = Math.max(0, paintFloorMs - elapsed);
      st.timer = setTimeoutFn(() => flush(surfaceId), wait);
    }
  }

  function dispose(surfaceId) {
    const st = bySurface.get(surfaceId);
    if (st && st.timer) clearTimeoutFn(st.timer);
    bySurface.delete(surfaceId);
  }

  return { enqueue, dispose, _bySurface: bySurface };
}

module.exports = { createPaintFloorCoalescer, DEFAULT_PAINT_FLOOR_MS };
