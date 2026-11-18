const DEFAULT_PAINT_FLOOR_MS = 250;

function cleanPatchItems(items     ) {
  return items
    .map((i     ) => {
      if (typeof i === "string") return i;
      if (i && typeof i === "object" && typeof i.label === "string") {
        const o      = { label: i.label };
        if (typeof i.body === "string") o.body = i.body;
        if (typeof i.checked === "boolean") o.checked = i.checked;
        return o;
      }
      return null;
    })
    .filter((i     ) => i !== null);
}

const labelOf = (item     ) => (typeof item === "string" ? item : item.label);

function applyFieldPatchToSpec(spec     , patch     ) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
  if (!patch || typeof patch !== "object") return { ...spec };
  const next      = { ...spec };
  const title = typeof patch.title === "string" ? patch.title : undefined;
  const body = typeof patch.body === "string" ? patch.body : undefined;
  const items = Array.isArray(patch.items) ? cleanPatchItems(patch.items) : undefined;
  if (spec.kind === "paged_text_surface") return next;
  if (title !== undefined) next.title = title;
  const current = Array.isArray(spec.items) ? spec.items : [];
  switch (spec.kind) {
    case "text_surface":
      if (body !== undefined) next.body = body;
      break;
    case "list_surface":
      if (items !== undefined) next.items = items.map(labelOf);
      break;
    case "list_with_details_surface":
      if (items !== undefined) {
        next.items = items.map((item     , i        ) => {
          const existing = current[i];
          const rowBody = typeof item === "object" && item.body !== undefined
            ? item.body
            : body !== undefined
              ? body
              : existing && typeof existing === "object" ? existing.body : undefined;
          return rowBody === undefined ? { label: labelOf(item) } : { label: labelOf(item), body: rowBody };
        });
      } else if (body !== undefined) {
        next.items = current.map((item     ) => ({ ...item, body }));
      }
      break;
    case "checklist_surface":
      if (items !== undefined) {
        next.items = items.map((item     , i        ) => {
          const existing = current[i];
          const checked = typeof item === "object" && item.checked !== undefined
            ? item.checked
            : existing && typeof existing === "object" ? existing.checked : undefined;
          return checked === undefined ? { label: labelOf(item) } : { label: labelOf(item), checked };
        });
      }
      break;
    default:

      if (body !== undefined) next.body = body;
      if (items !== undefined) next.items = items;
  }
  return next;
}

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
    if (isRenderSentinel(base) && incoming && typeof incoming === "object" && !isRenderSentinel(incoming)) {

      const next      = { ...base, __spec: applyFieldPatchToSpec(base.__spec, incoming) };
      if (incoming.__recordedSpec && typeof incoming.__recordedSpec === "object") {
        next.__recordedSpec = incoming.__recordedSpec;
      } else if (base.__recordedSpec !== undefined) {
        next.__recordedSpec = applyFieldPatchToSpec(base.__recordedSpec, incoming);
      }
      if (incoming.marker !== undefined) next.__marker = incoming.marker;
      return next;
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

    if (isRenderSentinel(merged) && (base?.__origin === "agent" || incoming?.__origin === "agent")) {
      merged.__origin = "agent";
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

  function hasPending(surfaceId     ) {
    const st = bySurface.get(surfaceId);
    return !!(st && st.pendingPatch);
  }

  function predictFieldPatch(surfaceId     , phoneSpec     , patch     ) {
    const st = bySurface.get(surfaceId);
    const pending = st ? st.pendingPatch : null;
    if (isRenderSentinel(pending)) return applyFieldPatchToSpec(pending.__spec, patch);
    return applyFieldPatchToSpec(phoneSpec, pending ? mergePatch(pending, patch) : patch);
  }

  function pendingRenderOf(surfaceId     ) {
    const st = bySurface.get(surfaceId);
    return st && isRenderSentinel(st.pendingPatch) ? st.pendingPatch : null;
  }

  return { enqueue, dispose, hasPending, predictFieldPatch, pendingRenderOf, _bySurface: bySurface };
}

module.exports = { DEFAULT_PAINT_FLOOR_MS, applyFieldPatchToSpec, createPaintFloorCoalescer };
