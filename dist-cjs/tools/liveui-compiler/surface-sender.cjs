const { createLiveUiSurfaceFloor } = require("./surface-floor.cjs");

const { LIVEUI_DATA_ROW_RE, LIVEUI_LIST_DATA_ROW_RE, buildLiveUiFallbackSpec, buildLiveUiSurfaceForms, liveUiDataRowCount, liveUiDataRowLists, liveUiManifestOnlyMessage, liveUiSpecMinVocab, liveUiSurfaceMessage } = require("./surface-forms.cjs");

const { parseLiveUiClientCapabilities } = require("../../domain/liveui-v2-client-forms.cjs");

const { TERMINAL_OUTCOME_RESULTS } = require("../glasses-ui-surfaces.cjs");
const { liveUiPresetFrame } = require("./preset-forms.cjs");

const TERMINAL_RESULTS = new Set        (TERMINAL_OUTCOME_RESULTS);
const ENDED_MEMORY = 64;
const utf8 = new TextEncoder();

function idsOf(spec                          )              {
  const ids = new Set        ();
  if (!spec) return ids;
  for (const comps of Object.values(spec.regions)) {
    for (const comp of comps) {
      ids.add(comp.id);
      const rows = comp.rows;
      if (Array.isArray(rows)) for (const row of rows) if (row && typeof row.ref === "string") ids.add(row.ref);
      for (const key of ["actions", "controls"]) {
        const list = comp[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (item && typeof item.id === "string") ids.add(item.id);
          else if (item && typeof item.verb === "string" && typeof item.timer === "string") ids.add(`${item.verb}:${item.timer}`);
        }
      }
    }
  }
  return ids;
}

const PAGE_TAP_RE = /^(.+)#(0|[1-9][0-9]{0,3})$/;

function pageCountsOf(spec                          )                      {
  const counts = new Map                ();
  if (!spec) return counts;
  for (const comps of Object.values(spec.regions)) {
    for (const comp of comps) {
      const pages = (comp                           ).pages;
      if (comp.c === "pages" && Array.isArray(pages)) counts.set(comp.id, pages.length);
    }
  }
  return counts;
}

function createLiveUiSurfaceSender(options                            ) {
  const trace = typeof options.trace === "function" ? options.trace : () => {};
  const sessionContext = typeof options.sessionContext === "function" ? options.sessionContext : () => null;
  const sends = new Map                      ();

  const replacing = new Map                ();

  const restoreAfter = new Map                ();

  const painting = new Map                ();

  const pagesDeclared = new Map                             ();

  const dataRowsDeclared = new Map                ();

  const listRowsDeclared = new Map                             ();
  const sessionsWithSurfaces = new Set        ();
  const ended           = [];
  let seqCounter = 0;

  const floor = createLiveUiSurfaceFloor({
    send: (release) => sendRelease(release),
    floorMs: options.floorMs,
    nowMs: options.nowMs,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
    isUnderBackpressure: options.isUnderBackpressure,
  });

  function readClients(server                    )               {
    let snapshot                                                                      = null;
    try {
      snapshot = typeof server.getReadinessSnapshot === "function" ? server.getReadinessSnapshot() : null;
    } catch {
      snapshot = null;
    }
    const clients = snapshot && Array.isArray(snapshot.clients) ? snapshot.clients : [];
    return clients
      .filter((c) => c && typeof c.clientId === "string")
      .map((c) => ({ clientId: c.clientId          , caps: parseLiveUiClientCapabilities(c.clientCapabilities) }));
  }

  function depthOf(sessionKey        , surfaceId        )         {
    const stack = options.surfaces.stack(sessionKey);
    const at = stack.indexOf(surfaceId);
    if (at >= 0) return at + 1;
    const under = replacing.get(surfaceId) ?? restoreAfter.get(surfaceId);
    const below = under ? stack.indexOf(under) : -1;
    return below >= 0 ? below + 1 : stack.length + 1;
  }

  function sendsOf(sessionKey        , surfaceId        )               {
    let st = sends.get(surfaceId);
    if (!st) {
      st = { sessionKey, firstSeq: null, lastOrigin: "agent", components: new Map(), fallback: null, fallbackOnly: false };
      sends.set(surfaceId, st);
    }
    return st;
  }

  function changedRecords(st              , spec                          )                                       {
    const out                                       = [];
    const next = new Map                ();
    if (spec) {
      for (const comps of Object.values(spec.regions)) {
        for (const comp of comps) {
          const json = JSON.stringify(comp);
          next.set(comp.id, json);
          if (st.components.get(comp.id) === json) continue;
          out.push(Array.isArray(comp.rows) ? { id: comp.id, rows: comp.rows.length } : { id: comp.id });
        }
      }
    }
    st.components = next;
    return out;
  }

  function fallbackFrame(
    st              ,
    surfaceId        ,
    spec                   ,
    ctx                                                                       ,
    seq        ,
    depth        ,
    meta             ,
  )                                 {
    const v1 = buildLiveUiFallbackSpec(spec);
    const json = JSON.stringify(v1);
    const prev = meta.fallbackRender ? null : st.fallback;
    if (prev && prev.json === json) return null;
    st.fallback = { kind: String(v1.kind), json };
    const frame = liveUiPresetFrame(
      {
        sessionKey: ctx.sessionKey,
        liveUiSessionGeneration: ctx.liveUiSessionGeneration,
        surfaceId,
        seq,
        depth,
        spec: v1,

        origin: meta.origin,
        collect: false,
        live: false,
      },
      { patch: !!prev && prev.kind === v1.kind },
    );
    if (!frame) return null;
    const { liveuiForms: _forms, ...wire } = frame;
    return wire;
  }

  function deliver(revision                       , meta             )                {
    const server = options.getServer();
    if (!server || typeof server.broadcast !== "function") {
      trace("liveui_v2_send_skipped", { sessionKey: revision.sessionKey, surfaceId: revision.surfaceId, reason: "no_server" });
      return null;
    }
    const seq = ++seqCounter;
    const st = sendsOf(revision.sessionKey, revision.surfaceId);
    const ctxIn = sessionContext(revision.sessionKey) || {};
    const ctx = {
      sessionKey: typeof ctxIn.sessionKey === "string" ? ctxIn.sessionKey : revision.sessionKey,
      liveUiSessionGeneration: typeof ctxIn.liveUiSessionGeneration === "string" ? ctxIn.liveUiSessionGeneration : null,
    };
    const depth = depthOf(revision.sessionKey, revision.surfaceId);
    const clients = readClients(server);
    const minVocab = liveUiSpecMinVocab(revision.spec);
    const v2Vocabs = clients.filter((c) => c.caps.v2).map((c) => c.caps.vocab          );
    const oldClients = clients.filter((c) => !c.caps.v2 || (minVocab !== null && (c.caps.vocab          ) < minVocab)).length;

    const fallbackSpec =
      meta.fallbackSpec !== undefined ? meta.fallbackSpec : revision.streaming || revision.withdrawn ? null : revision.spec;
    let fallback                                 = null;
    if (oldClients > 0 && fallbackSpec) {
      fallback = fallbackFrame(st, revision.surfaceId, fallbackSpec, ctx, seq, depth, meta);
    } else if (oldClients === 0) {

      st.fallback = null;
    }
    const message = liveUiSurfaceMessage({
      sessionKey: ctx.sessionKey,
      liveUiSessionGeneration: ctx.liveUiSessionGeneration,
      surfaceId: revision.surfaceId,
      depth,
      seq,
      specRev: revision.specRev,
      origin: meta.origin,
      streaming: revision.streaming,
      ...(revision.streaming && revision.whole ? { whole: true          } : {}),
      ...(revision.ended ? { ended: revision.ended } : {}),
      ...(revision.withdrawn ? { withdrawn: true          } : {}),
      ...(revision.asked ? { asked: revision.asked } : {}),
      ...(meta.manifest ? { manifest: meta.manifest } : {}),
      ...(revision.stateWrite ? { stateWrite: revision.stateWrite } : {}),
      ...(meta.seed ? { seed: meta.seed } : {}),
      spec: revision.spec,
    });
    const forms = buildLiveUiSurfaceForms(revision.spec, v2Vocabs, fallback);
    server.broadcast(JSON.stringify({ ...message, liveuiForms: forms }));
    if (st.firstSeq === null) st.firstSeq = seq;
    st.lastOrigin = meta.origin;
    st.fallbackOnly = v2Vocabs.length === 0 && oldClients > 0;
    sessionsWithSurfaces.add(revision.sessionKey);
    trace("surface_send", {
      sessionKey: revision.sessionKey,
      surfaceId: revision.surfaceId,
      mode: "liveui_surface",
      seq,
      depth,
      origin: meta.origin,

      specRev: revision.specRev,
      cause: meta.cause,
      streaming: revision.streaming,
      whole: revision.streaming && revision.whole === true,
      ended: revision.ended ?? null,
      withdrawn: revision.withdrawn === true,
      heldMs: meta.heldMs,
      superseded: meta.superseded,
      shed: meta.shed,
      bytes: utf8.encode(JSON.stringify(message)).length,
      records: changedRecords(st, revision.spec),
      manifest: meta.manifest ? meta.manifest.length : null,

      v2Clients: v2Vocabs.length,
      fallbackClients: oldClients,
      fallback: fallback ? String(fallback.type) : null,

      seed: meta.seed && Number.isInteger(meta.seed.rev) ? meta.seed.rev : null,
    });
    return seq;
  }

  function forget(surfaceId        )       {
    sends.delete(surfaceId);
    pagesDeclared.delete(surfaceId);
    dataRowsDeclared.delete(surfaceId);
    listRowsDeclared.delete(surfaceId);
    replacing.delete(surfaceId);
    restoreAfter.delete(surfaceId);
    painting.delete(surfaceId);
    floor.dispose(surfaceId);
    ended.push(surfaceId);
    while (ended.length > ENDED_MEMORY) ended.shift();
  }

  function restore(sessionKey        , surfaceId        )       {
    if (floor.release(surfaceId)) return;
    const snapshot = options.surfaces.getSurface(sessionKey, surfaceId);
    if (!snapshot || !snapshot.live) return;
    const st = sends.get(surfaceId);

    const origin = (snapshot.origin ?? (st ? st.lastOrigin : "agent"))                                   ;
    deliver(
      {
        sessionKey,
        surfaceId,
        specRev: snapshot.specRev,
        cause: "commit",
        origin,
        streaming: snapshot.streaming,
        ...(snapshot.whole ? { whole: true          } : {}),
        ...(snapshot.ended ? { ended: snapshot.ended } : {}),
        ...(snapshot.asked ? { asked: snapshot.asked } : {}),
        spec: snapshot.spec,
        runId: null,

        pictures: [],
      },

      { origin, cause: "restore", heldMs: 0, superseded: 0, shed: false, fallbackSpec: null },
    );
    floor.noteSent(surfaceId);
  }

  function sendRelease(release                    )       {
    const revision = release.revision;
    deliver(revision, {
      origin: release.origin,
      cause: revision.cause,
      heldMs: release.heldMs,
      superseded: release.superseded,
      shed: release.shed,
    });
    if (revision.withdrawn) {
      const back = restoreAfter.get(revision.surfaceId);
      forget(revision.surfaceId);
      if (back) restore(revision.sessionKey, back);
    }
  }

  function end(sessionKey        , surfaceId        , reason        )       {
    const back = replacing.get(surfaceId);
    forget(surfaceId);
    try {
      options.surfaces.noteEnded(sessionKey, surfaceId);
    } finally {
      trace("liveui_v2_surface_ended", { sessionKey, surfaceId, reason });
    }

    if (back) restore(sessionKey, back);
  }

  function owns(surfaceId         )                      {
    return typeof surfaceId === "string" && (sends.has(surfaceId) || ended.includes(surfaceId));
  }

  function checkTap(surfaceId        , id        )                                                              {
    const st = sends.get(surfaceId);
    if (!st) return { known: false, removed: false, reason: "ended" };
    const snapshot = options.surfaces.getSurface(st.sessionKey, surfaceId);
    if (!snapshot) return { known: false, removed: false, reason: "ended" };

    const page = PAGE_TAP_RE.exec(id);
    if (page) {
      const index = Number(page[2]);
      const most = pagesDeclared.get(surfaceId)?.get(page[1]) ?? 0;
      if (!snapshot.declared.includes(page[1]) || index >= most) return { known: false, removed: false, reason: "undeclared" };
      return { known: true, removed: index >= (pageCountsOf(snapshot.spec).get(page[1]) ?? 0), reason: null };
    }

    const dataRow = LIVEUI_DATA_ROW_RE.exec(id);
    if (dataRow) {
      const index = Number(dataRow[1]);
      if (index >= (dataRowsDeclared.get(surfaceId) ?? 0)) return { known: false, removed: false, reason: "undeclared" };
      return { known: true, removed: index >= liveUiDataRowCount(snapshot.spec), reason: null };
    }

    const listRow = LIVEUI_LIST_DATA_ROW_RE.exec(id);
    const listMost = listRow ? listRowsDeclared.get(surfaceId)?.get(listRow[1]) : undefined;
    if (listRow && listMost !== undefined) {
      const index = Number(listRow[2]);
      if (index >= listMost) return { known: false, removed: false, reason: "undeclared" };
      const now = liveUiDataRowLists(snapshot.spec).slice(1).find((list) => list.component === listRow[1])?.rows ?? 0;
      return { known: true, removed: index >= now, reason: null };
    }
    if (!snapshot.declared.includes(id)) return { known: false, removed: false, reason: "undeclared" };
    return { known: true, removed: !idsOf(snapshot.spec).has(id), reason: null };
  }

  return {

    onRevision(revision                       , origin = "agent")       {
      if (!revision || typeof revision.surfaceId !== "string" || typeof revision.sessionKey !== "string") return;
      const { sessionKey, surfaceId } = revision;
      sendsOf(sessionKey, surfaceId);
      for (const [id, count] of pageCountsOf(revision.withdrawn ? null : revision.spec)) {
        const most = pagesDeclared.get(surfaceId) ?? new Map                ();
        if (count > (most.get(id) ?? 0)) most.set(id, count);
        pagesDeclared.set(surfaceId, most);
      }
      const dataRows = liveUiDataRowCount(revision.withdrawn ? null : revision.spec);
      if (dataRows > (dataRowsDeclared.get(surfaceId) ?? 0)) dataRowsDeclared.set(surfaceId, dataRows);
      for (const list of liveUiDataRowLists(revision.withdrawn ? null : revision.spec).slice(1)) {
        const most = listRowsDeclared.get(surfaceId) ?? new Map                ();
        if (list.rows > (most.get(list.component) ?? -1)) most.set(list.component, list.rows);
        listRowsDeclared.set(surfaceId, most);
      }
      if (revision.withdrawn) {
        painting.delete(surfaceId);
        replacing.delete(surfaceId);
        if (revision.replaces) restoreAfter.set(surfaceId, revision.replaces);
      } else if (revision.streaming) {
        const live = options.surfaces.getSurface(sessionKey, surfaceId)?.live === true;
        if (!live) painting.set(surfaceId, sessionKey);
        if (revision.replaces) {
          replacing.set(surfaceId, revision.replaces);
          floor.holdFor(revision.replaces, surfaceId);
        }
      } else {
        painting.delete(surfaceId);
        replacing.delete(surfaceId);

        if (revision.replaces) forget(revision.replaces);
      }

      floor.enqueue(revision, typeof revision.origin === "string" ? revision.origin : origin);
    },

    replaySession(sessionKey        , reason                = null)                                            {
      if (!sessionsWithSurfaces.has(sessionKey)) return { replayed: false, surfaces: [] };
      const server = options.getServer();
      if (!server || typeof server.broadcast !== "function") return { replayed: false, surfaces: [] };
      const ids           = [];
      for (const id of options.surfaces.stack(sessionKey)) {
        const replacement = [...replacing].find(([, under]) => under === id)?.[0];
        ids.push(replacement ?? id);
      }
      for (const [id, owner] of painting) if (owner === sessionKey && !ids.includes(id)) ids.push(id);
      const live = ids
        .map((id) => ({ id, snapshot: options.surfaces.getSurface(sessionKey, id) }))
        .filter((e) => e.snapshot !== null);
      const manifest                        = live.map((e) => ({ surfaceId: e.id, specRev: e.snapshot .specRev }));
      if (live.length === 0) {
        const ctxIn = sessionContext(sessionKey) || {};
        const seq = ++seqCounter;
        const frame = liveUiManifestOnlyMessage({
          sessionKey: typeof ctxIn.sessionKey === "string" ? ctxIn.sessionKey : sessionKey,
          liveUiSessionGeneration: typeof ctxIn.liveUiSessionGeneration === "string" ? ctxIn.liveUiSessionGeneration : null,
          seq,
        });
        server.broadcast(JSON.stringify({ ...frame, liveuiForms: { fallback: null } }));
        trace("surface_send", { sessionKey, surfaceId: null, mode: "liveui_surface", seq, cause: "replay", manifest: 0, reason });
        return { replayed: true, surfaces: [] };
      }
      for (const { id, snapshot } of live) {
        floor.takeHeld(id);
        const st = sends.get(id);
        const origin = (snapshot .origin ?? (st ? st.lastOrigin : "agent"))                                   ;
        deliver(
          {
            sessionKey,
            surfaceId: id,
            specRev: snapshot .specRev,
            cause: "commit",
            origin,

            streaming: snapshot .streaming,

            ...(snapshot .whole ? { whole: true          } : {}),

            ...(snapshot .ended ? { ended: snapshot .ended } : {}),

            ...(snapshot .asked ? { asked: snapshot .asked } : {}),

            spec: snapshot .spec,
            runId: null,
            pictures: [],
          },
          {
            origin,
            cause: "replay",
            heldMs: 0,
            superseded: 0,
            shed: false,
            manifest,
            fallbackSpec: snapshot .committedSpec,
            fallbackRender: true,

            seed: typeof options.seedFor === "function" ? options.seedFor(id) : null,
          },
        );
        floor.noteSent(id);
      }
      return { replayed: true, surfaces: live.map((e) => e.id) };
    },

    owns,

    noteRenderError(input                                                                                                   ) {
      if (!owns(input.surfaceId)) return null;
      const st = sends.get(input.surfaceId);
      const seq = Number.isFinite(input.seq) ? Math.floor(input.seq          ) : null;
      const first = !!st && st.firstSeq !== null && seq === st.firstSeq;
      const terminal = first && input.authoritative === true;
      trace(terminal ? "liveui_v2_render_failed" : "liveui_v2_render_error", {
        sessionKey: st ? st.sessionKey : null,
        surfaceId: input.surfaceId,
        seq,
        code: typeof input.code === "string" ? input.code : null,
        clientId: typeof input.clientId === "string" ? input.clientId : null,
        terminal,
        reason: terminal ? null : !st ? "ended" : first ? "not_authoritative" : "later_revision",
      });
      if (terminal && st) end(st.sessionKey, input.surfaceId, "render_failed");
      return { terminal };
    },

    noteReceipt(input                                      ) {
      if (!owns(input.surfaceId)) return false;
      const st = sends.get(input.surfaceId);
      trace("liveui_v2_receipt", {
        sessionKey: st ? st.sessionKey : null,
        surfaceId: input.surfaceId,
        seq: Number.isFinite(input.seq) ? Math.floor(input.seq          ) : null,
      });
      return true;
    },

    checkTap,

    noteOutcome(surfaceId         , outcome         ) {
      if (!owns(surfaceId)) return null;
      const st = sends.get(surfaceId);
      const o = outcome && typeof outcome === "object" ? (outcome                           ) : {};
      const result = typeof o.result === "string" ? o.result : null;
      if (!st) {

        trace("liveui_v2_outcome_dropped", { surfaceId, result, reason: "ended" });
        return { ended: true, known: false, removed: false, sessionKey: null, ref: null, reason: "ended" };
      }
      const sessionKey = st.sessionKey;
      if (result === "back" || (result && TERMINAL_RESULTS.has(result))) {
        end(sessionKey, surfaceId, result);
        return { ended: true, known: true, removed: false, sessionKey, ref: null, reason: null };
      }

      const order = result === "action" ? [o.action, o.row, o.ref] : [o.row, o.action, o.ref];
      const ref = order.find((v) => typeof v === "string")                      ;
      const check = ref ? checkTap(surfaceId, ref) : { known: false, removed: false, reason: "no_ref" };
      trace("liveui_v2_outcome", { sessionKey, surfaceId, result, ref: ref ?? null, ...check });
      return { ended: false, known: check.known, removed: check.removed, sessionKey, ref: ref ?? null, reason: check.reason };
    },

    fallbackOnly(surfaceId         )          {
      const st = typeof surfaceId === "string" ? sends.get(surfaceId) : undefined;
      return !!st && st.fallbackOnly;
    },

    noteEnded(surfaceId         , reason = "dismissed")          {
      if (!owns(surfaceId)) return false;
      const st = sends.get(surfaceId);
      if (st) end(st.sessionKey, surfaceId, reason);
      return true;
    },

    surfacesOf(sessionKey        )           {
      return [...sends].filter(([, st]) => st.sessionKey === sessionKey).map(([id]) => id);
    },

    surfaceSessionOf(surfaceId         )                {
      const st = typeof surfaceId === "string" ? sends.get(surfaceId) : undefined;
      return st ? st.sessionKey : null;
    },

    hasHeld(surfaceId        )          {
      return floor.hasHeld(surfaceId);
    },
  };
}

module.exports = { createLiveUiSurfaceSender };
