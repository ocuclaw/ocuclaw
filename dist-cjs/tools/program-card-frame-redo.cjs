const { createProgramCardFrameLane, programCardFrameLayout, frameDetailOf, frameSkipReason } = require("./program-card-frame-lane.cjs");
const { frameWrapOf, normalizeFrameStyle, unwrapProgramCardFrame, wrapProgramCardFrame } = require("./program-card-frame-wire.cjs");
const { PROGRAM_CARD_REVISIONS_PICTURES_MAX } = require("./program-card-saves.cjs");

const FRAME_CANNOT_CODES                                  = {
  view_too_big: "frame_view_too_big",
  has_backdrop: "frame_has_backdrop",
  no_tiles: "frame_no_room",
};

const FRAME_REDO_NOTE_NEW = "New frame";
const FRAME_REDO_NOTE_REMOVED = "Removed the frame";
const SESSION_PREFIX = "frame:";
const REMEMBERED_MAX = 32;

const FRAME_REDO_PICTURES_MAX = 256 * 1024;

function shareGamePictures(rows       , games                   ) {
  const key = (framed         , game        ) => (framed ? "f" : "p") + game;
  const kept = new Map                ();
  let room = PROGRAM_CARD_REVISIONS_PICTURES_MAX;
  rows.forEach((row, i) => {
    const game = games[i];
    const png = row.picture?.png;
    if (typeof png !== "string" || !png) return;
    room -= png.length;
    if (game !== null && !kept.has(key(row.framed === true, game))) kept.set(key(row.framed === true, game), png);
  });
  return rows.map((row, i) => {
    const game = games[i];
    if (row.picture || game === null) return row;
    const png = kept.get(key(row.framed === true, game)) ?? kept.get(key(row.framed !== true, game));
    if (!png || png.length > room) return row;
    room -= png.length;
    return { ...row, picture: { png } };
  });
}

const looksLikeGame = (source     ) => typeof source === "string" && /\binput\s*:\s*["'`]direct["'`]/.test(source);

function createProgramCardFrameRedo(deps               ) {
  const running = new Map                 ();
  const savedNumbers = new Map                ();
  const debug = (event        , severity        , data     , appId        ) => {
    try { deps.debug?.(event, severity, data, SESSION_PREFIX + appId); } catch {  }
  };
  const appIdOf = (sessionKey        ) => sessionKey.slice(SESSION_PREFIX.length);

  function current(appId        ) {
    const source      = deps.saves.source({ appId });
    if (!source || source.status !== "accepted") return null;
    if (source.card?.kind !== "source" || typeof source.card.source !== "string") return { ...source, code: null };
    return { ...source, code: source.card.source           };
  }

  function save(appId        , code        , note        , push         , change                                                   ) {
    const loaded      = deps.saves.load(appId);
    if (!loaded || loaded.status !== "accepted") return { status: "rejected", code: "app_not_found" };
    const record = loaded.record;
    const result      = deps.saves.save({ appId, name: record.name, card: { kind: "source", source: code },
      state: record.checkpoint?.state ?? null, mode: "revision", by: "phone", note });
    if (result?.status !== "saved") return { status: "rejected", code: result?.code || "save_failed" };
    if (push) try { deps.saved(appId, result.revision); } catch {  }
    try {
      const after      = deps.saves.source({ appId });
      const sourceHash = after?.status === "accepted" && after.revision === result.revision && typeof after.sourceHash === "string" ? after.sourceHash : null;
      deps.changed?.({ appId, number: result.revision, sourceHash, code, ...change });
    } catch (err     ) {
      debug("program_card_frame_changed", "warn", { appId, error: String(err?.message ?? err).slice(0, 200) }, appId);
    }
    return { status: "saved", number: result.revision };
  }

  const lane = createProgramCardFrameLane({
    complete: (params     ) => {
      const complete = deps.complete();
      if (!complete) throw new Error("no_model_call");
      return complete(params);
    },
    draw: (_sessionKey        , code        ) => deps.draw(code),
    wire: async (job          , frame            ) => {
      const appId = appIdOf(job.sessionKey);
      const run = running.get(appId);
      const now = current(appId);

      if (!run || !now?.code || now.revision !== run.base.revision || now.sourceHash !== run.base.sourceHash) {
        return { ok: false, error: "card_changed" };
      }

      running.delete(appId);
      const style = normalizeFrameStyle(job.game.style);
      const { style: _style, ...game } = job.game;
      const code = wrapProgramCardFrame(now.code          , { png: frame.png, art: frame.art, place: frame.place,
        brief: { layout: job.layout, game, ...(style ? { style } : {}) } });
      const saved      = save(appId, code, style ? `${FRAME_REDO_NOTE_NEW}: ${style}` : FRAME_REDO_NOTE_NEW, true,
        { base: run.base, frame, brief: { layout: job.layout, game: job.game } });
      if (saved.status !== "saved") return { ok: false, error: saved.code };
      savedNumbers.set(appId, saved.number);
      return { ok: true };
    },
    idea: () => deps.canIdea?.() === true,

    onIdea: (job          , idea        ) => {
      const appId = appIdOf(job.sessionKey);
      const run = running.get(appId);
      if (!run) return;
      run.idea = idea;
      deps.notify({ appId, requestId: run.requestId, lane: "drawing", ...(run.style ? { style: run.style } : {}), idea });
    },
    debug: (event, severity, data, sessionKey) => debug(event, severity, data, appIdOf(sessionKey)),
  });

  function keptBrief(appId        , code        , wrap                  )                        {
    if (wrap?.brief) return wrap.brief;
    const game = unwrapProgramCardFrame(code);
    try {
      const recalled = deps.recall?.(game);
      if (recalled) return recalled;
    } catch {  }
    const listed      = deps.saves.listRevisions({ appId, seen: false });
    for (const row of listed?.status === "accepted" ? listed.revisions : []) {
      const found      = deps.saves.loadRevision(appId, row.number);
      const source = found?.status === "accepted" ? found.revision?.card?.source : null;
      const kept = frameWrapOf(source);
      if (kept?.brief && unwrapProgramCardFrame(source) === game) return kept.brief;
    }
    return null;
  }

  function frameBlockedOf(appId        , code        )                {
    const wrap = frameWrapOf(code);
    const layout = programCardFrameLayout(keptBrief(appId, code, wrap)?.layout);
    const cannot = layout ? frameSkipReason(layout) : null;
    return cannot ? FRAME_CANNOT_CODES[cannot] : null;
  }

  function givenLayout(given     , wrap                  )                     {
    const layout = programCardFrameLayout(given);
    if (!layout || !wrap) return layout;
    const [x, y, w, h] = layout.view;
    const view                      = wrap.place ? [Math.max(0, x - wrap.place.dx), Math.max(0, y - wrap.place.dy), w, h] : layout.view;
    return { ...layout, view, back: Math.max(0, layout.back - wrap.art.length) };
  }

  return {

    redraw(params                                                                                    ) {
      const { appId, requestId } = params;
      if (running.has(appId)) return { status: "rejected", code: "frame_busy" };
      const now = current(appId);
      if (!now) return { status: "rejected", code: "app_not_found" };
      if (!now.code) return { status: "rejected", code: "not_a_game" };
      const wrap = frameWrapOf(now.code);
      const kept = keptBrief(appId, now.code, wrap);
      const layout = kept?.layout ? programCardFrameLayout(kept.layout) : givenLayout(params.frameLayout, wrap);
      if (!layout) return { status: "rejected", code: wrap || looksLikeGame(now.code) ? "frame_layout_needed" : "not_a_game" };

      const cannot = frameSkipReason(layout);
      if (cannot) {
        debug("program_card_frame_redraw", "warn", { appId, ok: false, code: FRAME_CANNOT_CODES[cannot], view: layout.view }, appId);
        return { status: "rejected", code: FRAME_CANNOT_CODES[cannot] };
      }
      if (!deps.complete() || !deps.canDraw()) return { status: "rejected", code: "frame_unavailable" };
      const style = params.style === undefined || params.style === null ? (kept?.style ?? "") : normalizeFrameStyle(params.style);
      const game            = { ...(kept?.game ?? {}), title: kept?.game?.title || now.name || "", ...(style ? { style } : {}) };
      const sessionKey = SESSION_PREFIX + appId;
      lane.forget(sessionKey);
      const run          = { requestId, style, base: { revision: now.revision, sourceHash: now.sourceHash } };
      running.set(appId, run);
      savedNumbers.delete(appId);
      let detail = frameDetailOf(params.detail);
      if (!detail) try { detail = frameDetailOf(deps.detail?.()); } catch { detail = null; }
      const started = lane.start({ sessionKey, cardId: appId, layout, game, ...(detail ? { detail } : {}) });
      if (started.status !== "drawing") {
        running.delete(appId);
        const reason = started.reason                                                 ;
        return { status: "rejected", code: reason === "no_model_call" ? "frame_unavailable" : (reason && FRAME_CANNOT_CODES[reason]) || "frame_failed" };
      }
      debug("program_card_frame_redraw", "debug", { appId, revision: now.revision, styled: !!style, kept: !!kept, detail }, appId);
      const event = (lane               , more                          = {}) =>
        ({ appId, requestId, lane, ...(style ? { style } : {}), ...(run.idea ? { idea: run.idea } : {}), ...more });
      deps.notify(event("drawing"));
      void lane.settled(sessionKey).then((status                    ) => {
        const number = savedNumbers.get(appId);
        const reason = lane.status(sessionKey, appId)?.reason ?? "";
        running.delete(appId);
        savedNumbers.delete(appId);
        lane.forget(sessionKey);
        if (status === "wired" && number) return deps.notify(event("added", { number }));
        const code = /card_changed/.test(reason) ? "card_changed" : status === "skipped" ? "frame_skipped" : "frame_failed";
        debug("program_card_frame_redraw", "warn", { appId, ok: false, code, reason: reason.slice(0, 200) }, appId);
        deps.notify(event("none", { code }));
      }, () => {
        running.delete(appId);
        deps.notify(event("none", { code: "frame_failed" }));
      });
      return { status: "drawing" };
    },

    remove(params                   ) {
      const { appId } = params;
      if (running.has(appId)) return { status: "rejected", code: "frame_busy" };
      const now = current(appId);
      if (!now) return { status: "rejected", code: "app_not_found" };
      if (!now.code || !frameWrapOf(now.code)) return { status: "rejected", code: "frame_none" };
      const kept = frameWrapOf(now.code)?.brief ?? null;
      const brief                    = kept ? { layout: kept.layout, game: { ...kept.game, ...(kept.style ? { style: kept.style } : {}) } } : null;
      const saved      = save(appId, unwrapProgramCardFrame(now.code), FRAME_REDO_NOTE_REMOVED, false,
        { base: { revision: now.revision, sourceHash: now.sourceHash }, frame: null, brief });
      debug("program_card_frame_remove", saved.status === "saved" ? "debug" : "warn", { appId, ...saved }, appId);
      return saved;
    },

    decorate(result     ) {
      if (!result || result.status !== "accepted" || !Array.isArray(result.revisions)) return result;
      const appId = result.appId;
      let game = false;
      let currentSource                = null;
      let pictureRoom = FRAME_REDO_PICTURES_MAX;
      const games                    = [];
      const revisions = result.revisions.map((row     ) => {
        const found      = deps.saves.loadRevision(appId, row.number);
        const source = found?.status === "accepted" ? found.revision?.card?.source : null;
        games.push(typeof source === "string" ? unwrapProgramCardFrame(source) : null);
        if (row.current && typeof source === "string") currentSource = source;
        const wrap = frameWrapOf(source);
        if (wrap || (row.current && looksLikeGame(source))) game = true;
        if (!wrap) return row;
        const fits = !!wrap.png && wrap.png.length <= pictureRoom;
        if (fits) pictureRoom -= (wrap.png          ).length;
        return { ...row, framed: true, ...(wrap.brief?.style ? { frameStyle: wrap.brief.style } : {}), ...(fits ? { framePng: wrap.png } : {}) };
      });
      const blocked = game && currentSource ? frameBlockedOf(appId, currentSource) : null;
      return { ...result, revisions: game ? shareGamePictures(revisions, games) : revisions, game,
        ...(blocked ? { frameBlocked: blocked } : {}), ...(running.has(appId) ? { frameLane: "drawing" } : {}) };
    },

    drawing: (appId        ) => running.has(appId),
  };
}

function createFrameBriefMemory(max = REMEMBERED_MAX) {
  const kept = new Map                        ();
  return {
    note(game     , brief     ) {
      if (typeof game !== "string" || !game) return;
      const layout = programCardFrameLayout(brief?.layout);
      if (!layout) return;
      const g = brief?.game && typeof brief.game === "object" ? brief.game : {};
      kept.delete(game);
      kept.set(game, { layout, game: { title: typeof g.title === "string" ? g.title.slice(0, 80) : "",
        ...(Array.isArray(g.plan) ? { plan: g.plan.filter((l     ) => typeof l === "string").slice(0, 5).map((l        ) => l.slice(0, 200)) } : {}),
        ...(typeof g.request === "string" && g.request ? { request: g.request.slice(0, 300) } : {}) } });
      while (kept.size > max) kept.delete(kept.keys().next().value          );
    },
    recall: (game        ) => kept.get(game) ?? null,
  };
}

module.exports = { FRAME_CANNOT_CODES, FRAME_REDO_NOTE_NEW, FRAME_REDO_NOTE_REMOVED, FRAME_REDO_PICTURES_MAX, looksLikeGame, createProgramCardFrameRedo, createFrameBriefMemory };
