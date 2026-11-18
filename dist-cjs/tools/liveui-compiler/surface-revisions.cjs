const { parseUiRecords } = require("../../domain/ui-record-family.cjs");

const { LIVEUI_PICTURES_PER_REVISION, cloneSurfaceModel, compileSurfaceModel, foldUiRecords, liveUiDrawsNothing } = require("./record-compiler.cjs");
const { classifyPictureSource } = require("../liveui-pictures/picture-source.cjs");
const { liveUiSpecDataKeys } = require("./stored-surface.cjs");

const { LIVEUI_ERROR_INPUT_MAX_BYTES, checkLiveUiInputValue, validateLiveUiInputs } = require("./template-inputs.cjs");

const ORIGINS = new Set        (["agent", "library", "task"]);

function isLiveUiSurfaceOrigin(value         )                               {
  return typeof value === "string" && ORIGINS.has(value);
}

                                              

const SITE_ONLY_TITLE_WORDS = new Set([
  "youtube", "video", "videos", "clip", "requested", "the", "a", "this", "your", "on", "glasses",
  "x", "twitter", "twitch", "vimeo", "instagram", "tiktok", "reddit", "peertube", "dailymotion", "stream", "live",
]);

function isSiteOnlyTitle(title        )          {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.every((w) => SITE_ONLY_TITLE_WORDS.has(w));
}

function publicNote(note                  )                                                                            {
  return { record: note.name, code: note.code, detail: note.detail, kind: note.kind };
}

const drawsNothing = liveUiDrawsNothing;

const LIVEUI_DROP_REPORT_MAX_LINES = 3;
const LIVEUI_DROP_LINE_MAX_BYTES = 120;

const LIVEUI_SURFACE_IDS_MAX_BYTES = 200;

                                         

const STOPPED_RUN_MEMORY = 16;

const utf8 = new TextEncoder();
const byteLength = (text        )         => utf8.encode(text).length;

function cutBytes(text        , max        )         {
  if (byteLength(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (byteLength(out + ch + "…") > max) break;
    out += ch;
  }
  return `${out}…`;
}

const sameJson = (a         , b         )          => JSON.stringify(a) === JSON.stringify(b);

function keepMore(more                        , keep                          )                         {
  return Object.fromEntries(Object.entries(more).filter(([key]) => keep(key)));
}

function errorValue(value         )                                                                     {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, detail: "error is not text" };
  return { ok: true, value: cutBytes(value, LIVEUI_ERROR_INPUT_MAX_BYTES) };
}

function holdsPicture(input                                 , value         )          {
  if (!input) return false;
  if (input.type === "image") return typeof value === "string";
  if (input.type !== "list" || !input.fields || !Array.isArray(value)) return false;
  const fields = Object.keys(input.fields).filter((name) => input.fields [name] === "image");
  return value.some((row) => !!row && typeof row === "object" && fields.some((name) => typeof (row                           )[name] === "string"));
}

function fillLiveUiInputs(
  inputs                                ,
  values                                            ,
  current                          = {},
  rules                          = { assets: true },
)                                                                                                                                       {
  const given = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const declared = new Set(inputs.map((i) => i.key));
  for (const key of Object.keys(given)) {
    if (key !== "error" && !declared.has(key) && given[key] !== undefined) return { ok: false, reason: "unknown_key", key };
  }
  const data                          = {};
  const loading           = [];
  for (const input of inputs) {
    if (Object.hasOwn(given, input.key) && given[input.key] !== undefined) {
      const checked = checkLiveUiInputValue(input, given[input.key], rules);
      if (!checked.ok) return { ok: false, reason: "bad_value", key: input.key, code: checked.code, detail: checked.detail };
      data[input.key] = checked.value;
      continue;
    }
    if (Object.hasOwn(current, input.key)) {
      const kept = checkLiveUiInputValue(input, current[input.key], { files: true, assets: true });
      if (kept.ok) {
        data[input.key] = kept.value;
        continue;
      }
    }
    if (input.required === true) loading.push(input.key);
    else data[input.key] = null;
  }
  if (Object.hasOwn(given, "error") && given.error !== undefined) {
    const error = errorValue(given.error);
    if (!error.ok) return { ok: false, reason: "bad_value", key: "error", code: "input_value_type", detail: error.detail };
    data.error = error.value;
  } else if (Object.hasOwn(current, "error")) {
    data.error = current.error;
  }
  return { ok: true, data, loading };
}

const rowLabel = (row        )         => row.split("|")[0].trim();

function holdRows(before                   , now                   )                                          {
  const used = new Set        ();
  const rows           = [];
  let held = 0;
  for (const row of before) {
    const label = rowLabel(row);
    const at = now.findIndex((r, i) => !used.has(i) && rowLabel(r) === label);
    if (at >= 0) {
      used.add(at);
      rows.push(now[at]);
    } else {
      rows.push(row);
      held += 1;
    }
  }
  if (held === 0) return null;
  now.forEach((row, i) => {
    if (!used.has(i)) rows.push(row);
  });
  return { rows, held };
}

function defaultMint()         {
  return `ui-${Math.random().toString(36).slice(2, 10)}`;
}

function createLiveUiSurfaceRevisions(options                                = {}) {
  const sessions = new Map                      ();
  const onRevision = typeof options.onRevision === "function" ? options.onRevision : () => {};
  const trace = typeof options.trace === "function" ? options.trace : () => {};
  const mint = typeof options.mintSurfaceId === "function" ? options.mintSurfaceId : defaultMint;

  function session(sessionKey        )               {
    let s = sessions.get(sessionKey);
    if (!s) {
      s = {
        surfaces: new Map(),
        stack: [],
        ended: new Set(),
        messages: new Map(),
        openByRun: new Map(),
        stopped: new Set(),
        commitCounter: 0,
        dropLines: [],
        compactionOwed: false,
        reservation: null,
        namedFrame: null,
        unframed: null,
      };
      sessions.set(sessionKey, s);
    }
    return s;
  }

  function newSurface(surfaceId        , seed                           = null)               {
    const surface               = {
      surfaceId,
      specRev: 0,
      lastSpecJson: null,
      lastSpec: null,
      lastStreaming: false,
      lastWhole: false,
      lastEnded: null,
      committed: null,
      committedSpec: null,
      validEntries: new Map(),
      refs: new Map(),
      refCounter: 0,
      pics: new Map(),
      picCounter: 0,
      lastPictures: [],
      committedPictures: [],
      modelKnown: new Map(),
      declared: new Set(),
      live: false,
      reserved: false,
      inputs: seed && Array.isArray(seed.inputs) ? seed.inputs : null,
      data: seed && seed.data ? { ...seed.data } : {},
      loading: seed && Array.isArray(seed.loading) ? [...seed.loading] : [],
      more: seed && seed.more && typeof seed.more === "object" ? { ...seed.more } : {},
      origin: seed && isLiveUiSurfaceOrigin(seed.origin) ? seed.origin : "agent",
      passive: seed ? seed.passive === true : false,
      dataPics: new Map(),
      assets: seed && seed.assets && typeof seed.assets === "object" ? { ...seed.assets } : null,
      icon: null,
      askedRunId: null,
      asked: null,
    };
    syncDataPics(surface, null);
    return surface;
  }

  function newRunSurface(
    sessionKey        ,
    msg              ,
    surface               = newSurface(mint(), msg.seed),
  )               {
    const icon = options.decidedIcon ? options.decidedIcon(sessionKey, msg.runId) : null;
    surface.icon = typeof icon === "string" && icon ? icon : null;

    if (surface.specRev === 0) {
      surface.askedRunId = msg.runId;
      surface.asked = null;
      askedOf(sessionKey, surface);
    }
    return surface;
  }

  function askedOf(sessionKey        , surface              )                {
    if (surface.asked || !surface.askedRunId || !options.askedWords) return surface.asked;
    const words = options.askedWords(sessionKey, surface.askedRunId);
    if (typeof words === "string" && words) surface.asked = words;
    return surface.asked;
  }

  function assetBytes(surface              , name        )                {
    const bytes = surface.assets && Object.hasOwn(surface.assets, name) ? surface.assets[name] : null;
    return typeof bytes === "string" && classifyPictureSource(bytes).kind === "bytes" ? bytes : null;
  }

  function mintPic(surface              )         {
    surface.picCounter += 1;
    return `p${surface.picCounter}`;
  }

  function syncDataPics(surface              , fresh                            )       {
    const next = new Map                          ();
    const take = (slot        , key        , value         , componentId        , eager         ) => {
      if (typeof value !== "string") return;
      const kind = classifyPictureSource(value).kind;
      const src = kind === "asset" ? assetBytes(surface, value.trim()) : kind === "invalid" ? null : value;
      if (src === null) return;
      const before = surface.dataPics.get(slot);
      let id        ;
      if (fresh && fresh.has(key)) id = mintPic(surface);
      else if (before && before.src === src) id = before.id;
      else {
        id = surface.pics.get(src) ?? mintPic(surface);
        surface.pics.set(src, id);
      }
      next.set(slot, { id, src, componentId, eager });
    };
    for (const input of surface.inputs ?? []) {
      const value = surface.data[input.key];
      if (input.type === "image") take(input.key, input.key, value, input.key, true);
      if (input.type !== "list" || !input.fields || !Array.isArray(value)) continue;
      const imageFields = Object.keys(input.fields).filter((name) => input.fields [name] === "image");
      value.forEach((row, rowIndex) => {
        if (!row || typeof row !== "object") return;
        for (const name of imageFields) {

          take(`${input.key}\u0000${rowIndex}\u0000${name}`, input.key, (row                           )[name], `${input.key}[${rowIndex}].${name}`, rowIndex < 3);
        }
      });
    }
    surface.dataPics = next;
  }

  function dataView(surface              , specPictures        )                                                              {
    const data                          = { ...surface.data };
    const refs                     = [];
    if (surface.dataPics.size === 0) return { data, refs };
    let room = Math.max(0, LIVEUI_PICTURES_PER_REVISION - specPictures);
    const ids = new Set        ();
    const copied = new Set        ();
    for (const [slot, ref] of surface.dataPics) {
      const admitted = ids.has(ref.id) || room > 0;
      if (admitted && !ids.has(ref.id)) {
        ids.add(ref.id);
        refs.push(ref);
        room -= 1;
      }
      const [key, row, field] = slot.split("\u0000");
      if (row === undefined) {
        data[key] = admitted ? ref.id : null;
        continue;
      }
      if (!copied.has(key)) {
        data[key] = (data[key]             ).map((r) => (r && typeof r === "object" ? { ...(r                           ) } : r));
        copied.add(key);
      }
      ((data[key]             )[Number(row)]                           )[field] = admitted ? ref.id : null;
    }
    return { data, refs };
  }

  function plateTitle(spec                   , pictures                             )                     {
    if (!options.pictureTitle || spec.frame !== "plate" || !isSiteOnlyTitle(spec.title)) return {};
    for (const pic of pictures) {
      const title = options.pictureTitle(pic.src);
      if (title) return { title };
    }
    return {};
  }

  function dress(surface              , spec                   , pictures                             )                    {
    const { loading: _loading, icon: _icon, more: _more, ...rest } = spec;
    return {
      ...rest,
      ...plateTitle(spec, pictures),
      data: dataView(surface, pictures.length).data,
      ...(surface.loading.length > 0 ? { loading: [...surface.loading] } : {}),

      ...(Object.keys(surface.more).length > 0 ? { more: { ...surface.more } } : {}),

      ...(surface.icon ? { icon: surface.icon } : {}),
    };
  }

  function storedSurface(sessionKey        , surfaceId        )                      {
    const s = sessions.get(sessionKey);
    if (!s || typeof surfaceId !== "string" || s.ended.has(surfaceId)) return null;
    return s.surfaces.get(surfaceId) ?? null;
  }

  function cutData(sessionKey        , surface              )                               {
    if (surface.committedSpec) surface.committedSpec = dress(surface, surface.committedSpec, surface.committedPictures);
    const s = sessions.get(sessionKey);
    if (!surface.live && s && surface.lastStreaming && surface.lastSpec && openSurfaceOf(s) === surface) {
      return cut(sessionKey, surface, {
        cause: "tick",
        streaming: true,
        spec: surface.lastSpec,
        runId: null,
        pictures: surface.lastPictures,
      });
    }
    if (!surface.live || !surface.committedSpec) return null;
    const pending = surface.lastStreaming && surface.lastSpec !== null;
    return cut(sessionKey, surface, {
      cause: "tick",
      streaming: pending,
      whole: pending && surface.lastWhole,
      spec: pending ? surface.lastSpec : surface.committedSpec,
      runId: null,
      pictures: pending ? surface.lastPictures : surface.committedPictures,
    });
  }

  function patchTargetOf(sessionKey        , s              )                      {
    const own                     = s.stack.map((surfaceId) => ({ surfaceId, kind: "composed" }));
    const view = options.stackView ? options.stackView(sessionKey, own) : own;
    const top = view[view.length - 1];
    if (!top) return null;
    const id = top.kind === "composed" ? top.surfaceId : top.kind === "preloaded_child" ? top.parentId : undefined;
    if (!id || s.ended.has(id)) return null;
    const surface = s.surfaces.get(id);
    return surface && surface.live && surface.committed ? surface : null;
  }

  function openSurfaceOf(s              )                      {
    let open                      = null;
    for (const key of s.openByRun.values()) {
      const msg = s.messages.get(key);
      if (!msg || msg.ended || !msg.isNew || !msg.surfaceId || s.ended.has(msg.surfaceId)) continue;
      const surface = s.surfaces.get(msg.surfaceId);
      if (surface && !surface.live && surface.lastSpec) open = surface;
    }
    return open;
  }

  function namedFrameOf(s              , self                      = null)                                          {
    if (s.namedFrame) return s.namedFrame;
    for (const key of s.openByRun.values()) {
      const msg = s.messages.get(key);
      if (!msg || msg === self || msg.ended || !msg.isNew || !msg.painted || msg.painted.entries.length > 0) continue;
      if (msg.surfaceId && !s.ended.has(msg.surfaceId)) return { frame: msg.painted.frame, title: msg.painted.title };
    }
    return null;
  }

  function newSurfaceFor(sessionKey        , s              , msg              )               {
    const id = s.reservation;
    const held = id && !msg.seed && !s.ended.has(id) ? s.surfaces.get(id) : undefined;
    if (held && held.reserved) {
      s.reservation = null;
      trace("liveui_v2_refresh_reservation_taken", { sessionKey, surfaceId: held.surfaceId });
      return newRunSurface(sessionKey, msg, held);
    }
    return newRunSurface(sessionKey, msg);
  }

  function dropUnpainted(s              , surface              )       {
    if (surface.reserved) s.reservation = surface.surfaceId;
    else s.surfaces.delete(surface.surfaceId);
  }

  function compileFor(
    surface              ,
    model                    ,
    msg              ,
    final         ,
  )                      {
    const fallbacks = new Map                          (msg.isNew ? [] : surface.validEntries);
    for (const [key, entry] of msg.layerValid) fallbacks.set(key, entry);
    const result = compileSurfaceModel(model, {
      final,
      fallbacks,
      pictureBytes: msg.viaTool,
      rowRef(componentId, label, nth) {
        const k = `${componentId}\u0000${label}\u0000${nth}`;
        let ref = surface.refs.get(k);
        if (!ref) {
          surface.refCounter += 1;
          ref = `r${surface.refCounter}`;
          surface.refs.set(k, ref);
        }
        return ref;
      },
      picId(src) {
        let id = surface.pics.get(src);
        if (!id) {
          id = mintPic(surface);
          surface.pics.set(src, id);
        }
        return id;
      },
      assetSource: (name) => assetBytes(surface, name),

      inputs: surface.inputs ? surface.inputs.map((input) => input.key) : [],
    });

    return { ...result, spec: dress(surface, result.spec, result.pictures) };
  }

  function cut(
    sessionKey        ,
    surface              ,
    fields

     ,
  )                        {
    surface.specRev += 1;
    surface.reserved = false;
    surface.lastPictures = fields.spec ? fields.pictures ?? surface.committedPictures : [];
    const spec = fields.spec ? dress(surface, fields.spec, surface.lastPictures) : null;
    const specJson = spec ? JSON.stringify(spec) : null;
    surface.lastSpecJson = specJson;
    surface.lastSpec = spec;
    surface.lastStreaming = fields.streaming;
    surface.lastWhole = fields.streaming && fields.whole === true;
    surface.lastEnded = fields.ended && !fields.withdrawn ? fields.ended : null;

    const pictures = spec ? [...surface.lastPictures, ...dataView(surface, surface.lastPictures.length).refs] : [];
    const asked = fields.withdrawn ? null : askedOf(sessionKey, surface);
    const revision                        = {
      sessionKey,
      surfaceId: surface.surfaceId,
      specRev: surface.specRev,
      cause: fields.cause,
      origin: surface.origin,
      streaming: fields.streaming,
      ...(surface.lastWhole ? { whole: true          } : {}),
      ...(surface.lastEnded ? { ended: surface.lastEnded } : {}),
      ...(fields.withdrawn ? { withdrawn: true          } : {}),
      ...(asked ? { asked } : {}),
      ...(fields.stateWrite && Object.keys(fields.stateWrite).length > 0 ? { stateWrite: fields.stateWrite } : {}),
      ...(fields.replaces ? { replaces: fields.replaces } : {}),
      spec,
      runId: fields.runId,
      pictures,
    };
    trace("liveui_v2_revision", {
      sessionKey,
      surfaceId: surface.surfaceId,
      specRev: revision.specRev,
      cause: revision.cause,
      origin: revision.origin,
      streaming: revision.streaming,
      whole: revision.whole === true,
      ended: revision.ended ?? null,
      withdrawn: revision.withdrawn === true,

      asked: revision.asked !== undefined,
      records: fields.records ?? null,
      bytes: specJson ? byteLength(specJson) : 0,
      stateWriteKeys: revision.stateWrite ? Object.keys(revision.stateWrite) : [],

      dataKeys: spec ? Object.keys(spec.data) : [],
      loading: spec && spec.loading ? spec.loading.length : 0,
      runId: fields.runId,
    });
    onRevision(revision);
    return revision;
  }

  function messageFor(
    s              ,
    sessionKey        ,
    ids                                                                                 ,
  )               {
    const runId = ids.runId;
    const runKey = runId ?? "";
    const openKey = s.openByRun.get(runKey);
    const open = openKey ? s.messages.get(openKey) : undefined;
    const index = ids.messageIndex;
    if (open && !open.ended) {
      const same =
        (index === null || open.index === null || index === open.index) &&
        (!ids.messageId || !open.messageId || ids.messageId === open.messageId);
      if (same) return open;

      commitMessage(sessionKey, s, open, open.text, "end");
    }

    for (const [otherRun, key] of [...s.openByRun]) {
      if (otherRun === runKey) continue;
      const other = s.messages.get(key);
      if (other && !other.ended) commitMessage(sessionKey, s, other, other.text, "end");
    }
    const key = `${runKey}#${index ?? ids.messageId ?? 0}#${s.commitCounter++}`;
    const msg               = {
      key,
      runId,
      index,
      messageId: ids.messageId,
      text: "",
      surfaceId: null,
      isNew: false,
      replaces: null,
      base: null,
      painted: null,
      touched: new Set(),
      layerValid: new Map(),
      stateWritten: new Map(),
      traced: new Set(),
      progress: new Map(),
      ended: false,
      viaTool: false,
      seed: null,
    };
    s.messages.set(key, msg);
    s.openByRun.set(runKey, key);

    if (s.messages.size > 32) {
      for (const [k, m] of s.messages) {
        if (s.messages.size <= 16) break;
        if (m.ended) s.messages.delete(k);
      }
    }
    return msg;
  }

  function records(text        , mode                            )                 {
    if (mode === "end") return parseUiRecords(text, { final: true }).records;
    const parsed = parseUiRecords(text, { final: false }).records;

    return mode === "abort" ? parsed.map((r) => ({ ...r, closed: true })) : parsed;
  }

  function streamWhole(text        , parsed                                   )          {
    const recs = parsed.records;
    const last = recs[recs.length - 1];
    if (!last || parsed.trailingPartialTag || recs.some((r) => !r.closed)) return false;
    return /\S/.test(text.slice(last.rawEnd));
  }

  function traceProgress(sessionKey        , msg              , recs                )       {
    recs.forEach((rec, index) => {
      const attrs = rec.attrs || {};
      const key = rec.kind === "frame" ? "frame" : attrs.id ? `id:${attrs.id}` : attrs.let ? `let:${attrs.let}` : `record:${index}`;
      const rows = rec.rows.length;
      const last = msg.progress.get(key);
      if (last && last.rows >= rows && (last.closed || !rec.closed)) return;
      msg.progress.set(key, { rows, closed: rec.closed });
      trace("liveui_v2_record_progress", {
        sessionKey,
        runId: msg.runId,
        key,
        kind: rec.kind,
        component: typeof attrs.c === "string" ? attrs.c : null,
        rows,
        closed: rec.closed,
      });
    });
  }

  function traceOnce(msg              , tag        , event        , data                         )       {
    if (msg.traced.has(tag)) return;
    msg.traced.add(tag);
    trace(event, data);
  }

  function applyHolds(sessionKey        , msg              , fold                  , model                    )       {
    const painted = msg.painted;
    if (!painted) return;
    const present = new Set(fold.touched);
    for (const key of msg.touched) {
      const before = painted.entries.find((e) => e.key === key);
      if (key === "frame" || !before) continue;
      const index = model.entries.findIndex((e) => e.key === key);
      if (!present.has(key)) {
        if (index >= 0) model.entries[index] = before;
        else model.entries.push(before);
        traceOnce(msg, `held:${key}`, "liveui_v2_record_held", { sessionKey, surfaceId: msg.surfaceId, key, what: "record" });
        continue;
      }
      const now = index >= 0 ? model.entries[index] : null;
      const kept = now && before.rows.length > 0 ? holdRows(before.rows, now.rows) : null;
      if (now && kept) {
        model.entries[index] = { ...now, body: now.body ?? before.body, rows: kept.rows };
        traceOnce(msg, `held-rows:${key}:${kept.held}`, "liveui_v2_record_held", {
          sessionKey,
          surfaceId: msg.surfaceId,
          key,
          what: "rows",
          rows: kept.held,
        });
      }
    }

    const titleFill = painted.frame === model.frame && painted.title === "";
    if (msg.isNew && painted.entries.length > 0 && !titleFill && (painted.frame !== model.frame || painted.title !== model.title)) {
      model.frame = painted.frame;
      model.title = painted.title;
      traceOnce(msg, `held-frame:${model.frame}`, "liveui_v2_record_held", { sessionKey, surfaceId: msg.surfaceId, key: "frame", what: "frame" });
    }
  }

  function stateWriteFor(surface              , msg              , seeds                                 )                                  {
    const write                                  = {};
    if (msg.isNew) return write;
    for (const [key, value] of Object.entries(seeds)) {
      if (!surface.modelKnown.has(key)) continue;
      if (surface.modelKnown.get(key) === value) continue;
      if (msg.stateWritten.get(key) === value) continue;
      write[key] = value;
      msg.stateWritten.set(key, value);
    }
    return write;
  }

  function streamText(
    sessionKey        ,
    input                                                                                                  ,
  )                               {
    if (typeof sessionKey !== "string" || !sessionKey || typeof input.text !== "string") return null;
    const s = session(sessionKey);
    const runId = input.runId ?? null;
    const messageId = typeof input.messageId === "string" && input.messageId ? input.messageId : null;
    if (messageId && endedMessageOf(s, runId, messageId)) {

      return null;
    }
    const msg = messageFor(s, sessionKey, {
      runId,
      messageIndex: Number.isInteger(input.messageIndex) ? (input.messageIndex          ) : null,
      messageId,
    });
    const rewrite = msg.text.length > 0 && !input.text.startsWith(msg.text);
    msg.text = input.text;
    const parsed = parseUiRecords(input.text, { final: false });
    const recs = parsed.records;
    if (recs.length === 0) return null;
    const whole = streamWhole(input.text, parsed);
    traceProgress(sessionKey, msg, recs);

    let target                     ;
    if (msg.surfaceId) {
      target = msg.isNew ? null : s.surfaces.get(msg.surfaceId) ?? null;
    } else {
      target = patchTargetOf(sessionKey, s);
    }
    const base = msg.surfaceId ? msg.base : target?.committed ?? null;
    const fold = foldUiRecords(recs, {
      base,
      final: false,
      decidedFrame: options.decidedFrame ? options.decidedFrame(sessionKey, msg.runId) : null,
      namedFrame: msg.surfaceId && !msg.isNew ? null : namedFrameOf(s, msg),
    });
    if (fold.mode === "none" || fold.mode === "text" || !fold.model) return null;
    if (msg.surfaceId && (fold.mode === "new") !== msg.isNew) {

      traceOnce(msg, "held-mode", "liveui_v2_record_held", { sessionKey, surfaceId: msg.surfaceId, key: "frame", what: "mode" });
      return null;
    }

    let surface              ;
    if (!msg.surfaceId) {
      msg.isNew = fold.mode === "new";
      if (msg.isNew) {
        surface = newSurfaceFor(sessionKey, s, msg);
        s.surfaces.set(surface.surfaceId, surface);
        msg.replaces = target ? target.surfaceId : null;
        msg.base = null;
      } else {
        surface = target ;
        msg.base = cloneSurfaceModel(target .committed );
      }
    } else {
      surface = s.surfaces.get(msg.surfaceId) ;
      if (!surface || s.ended.has(surface.surfaceId)) return null;
    }

    const model = cloneSurfaceModel(fold.model);
    applyHolds(sessionKey, msg, fold, model);
    const result = compileFor(surface, model, msg, false);
    if (!msg.surfaceId && msg.isNew && fold.frameRepaired && result.placed.length === 0) {

      dropUnpainted(s, surface);
      msg.replaces = null;
      return null;
    }
    for (const entry of result.placed) if (result.valid.has(entry.key)) msg.layerValid.set(entry.key, entry);
    for (const id of result.declared) surface.declared.add(id);
    const specJson = JSON.stringify(result.spec);

    if (specJson === surface.lastSpecJson && surface.lastStreaming && surface.lastWhole === whole) {
      msg.surfaceId = surface.surfaceId;
      return null;
    }
    if (!msg.surfaceId && specJson === surface.lastSpecJson) {

      return null;
    }
    msg.surfaceId = surface.surfaceId;
    msg.painted = model;
    for (const key of fold.touched) msg.touched.add(key);
    return cut(sessionKey, surface, {
      cause: rewrite ? "rewrite" : msg.isNew ? "records" : "patch",
      streaming: true,
      whole,
      spec: result.spec,
      stateWrite: stateWriteFor(surface, msg, result.stateSeeds),
      replaces: msg.isNew ? msg.replaces : null,
      runId: msg.runId,
      records: result.placed.length,
      pictures: result.pictures,
    });
  }

  function dropLine(note                  )         {
    return cutBytes(`record ${note.name} dropped: ${note.detail}`, LIVEUI_DROP_LINE_MAX_BYTES);
  }

  function reportNotes(sessionKey        , s              , surfaceId               , notes                    )       {
    const seen = new Set        ();
    for (const note of notes) {
      const tag = `${note.kind}:${note.key}:${note.code}:${note.detail}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      if (note.kind === "repair") {
        trace("liveui_v2_record_repaired", { sessionKey, surfaceId, key: note.key, code: note.code });
        continue;
      }
      trace("liveui_v2_record_dropped", { sessionKey, surfaceId, key: note.key, code: note.code, detail: note.detail });
      s.dropLines.push(dropLine(note));
    }
  }

  function runPainted(s              , msg              )          {
    for (const other of s.messages.values()) {
      if (other !== msg && other.runId === msg.runId && other.surfaceId) return true;
    }
    return false;
  }

  function commitMessage(
    sessionKey        ,
    s              ,
    msg              ,
    text        ,
    mode                 ,
    endedAs                  = null,
  )                               {
    msg.ended = true;
    msg.text = text;
    const runKey = msg.runId ?? "";
    if (s.openByRun.get(runKey) === msg.key) s.openByRun.delete(runKey);
    let recs = records(text, mode);

    if (options.pictureFallback && mode === "end" && !endedAs && recs.length === 0 && !msg.surfaceId && !msg.viaTool && !runPainted(s, msg)) {
      let fallback                = null;
      try {
        fallback = options.pictureFallback(text);
      } catch {
        fallback = null;
      }
      if (fallback) {
        recs = parseUiRecords(fallback, { final: true }).records;
        trace("liveui_v2_picture_fallback", { sessionKey, runId: msg.runId, records: recs.length });
      }
    }
    traceProgress(sessionKey, msg, recs);

    const painted = msg.surfaceId ? s.surfaces.get(msg.surfaceId) ?? null : null;
    if (msg.surfaceId && !painted) {

      trace("liveui_v2_patch_discarded", { sessionKey, surfaceId: msg.surfaceId, runId: msg.runId });
      return null;
    }
    const target = msg.surfaceId ? (msg.isNew ? null : painted) : patchTargetOf(sessionKey, s);
    const base = msg.surfaceId ? msg.base : target?.committed ?? null;
    const fold = recs.length
      ? foldUiRecords(recs, {
          base,
          final: true,
          decidedFrame: options.decidedFrame ? options.decidedFrame(sessionKey, msg.runId) : null,
          namedFrame: msg.surfaceId && !msg.isNew ? null : namedFrameOf(s, msg),
        })
      : null;

    if (!fold || fold.mode === "none" || fold.mode === "text" || !fold.model) {
      if (fold) {
        if (fold.mode === "text") trace("liveui_v2_records_text", { sessionKey, runId: msg.runId, records: recs.length });
        reportNotes(sessionKey, s, msg.surfaceId, fold.notes);
      }
      return endPainted(sessionKey, s, msg, painted, endedAs);
    }
    const isNew = fold.mode === "new";
    if (msg.surfaceId && isNew !== msg.isNew) {

      endPainted(sessionKey, s, msg, painted);
      msg.surfaceId = null;
      msg.painted = null;
      return commitFresh(sessionKey, s, msg, fold, isNew ? patchTargetOf(sessionKey, s) : target, endedAs);
    }
    if (!msg.surfaceId) return commitFresh(sessionKey, s, msg, fold, target, endedAs);
    return commitSurface(sessionKey, s, msg, painted , fold, endedAs);
  }

  function commitFresh(
    sessionKey        ,
    s              ,
    msg              ,
    fold                  ,
    target                     ,
    endedAs                 ,
  )                               {
    msg.isNew = fold.mode === "new";
    let surface              ;
    if (msg.isNew) {
      surface = newSurfaceFor(sessionKey, s, msg);
      s.surfaces.set(surface.surfaceId, surface);
      msg.replaces = target ? target.surfaceId : null;
    } else {
      if (!target) return null;
      surface = target;
      msg.base = cloneSurfaceModel(target.committed );
    }
    msg.surfaceId = surface.surfaceId;
    return commitSurface(sessionKey, s, msg, surface, fold, endedAs);
  }

  function endPainted(
    sessionKey        ,
    s              ,
    msg              ,
    painted                     ,
    endedAs                  = null,
  )                               {
    if (!painted || !msg.surfaceId) return null;
    if (msg.isNew) return retract(sessionKey, s, msg, painted);

    const owed = endedAs !== null && painted.lastEnded !== endedAs;
    if (painted.lastSpecJson !== JSON.stringify(painted.committedSpec) || painted.lastStreaming || owed) {

      return cut(sessionKey, painted, {
        cause: "commit",
        streaming: false,
        spec: painted.committedSpec,
        ended: endedAs,
        runId: msg.runId,
      });
    }
    return null;
  }

  function retract(sessionKey        , s              , msg              , surface              )                        {
    s.ended.add(surface.surfaceId);
    s.surfaces.delete(surface.surfaceId);
    s.stack = s.stack.filter((id) => id !== surface.surfaceId);
    trace("liveui_v2_retracted", {
      sessionKey,
      surfaceId: surface.surfaceId,
      restored: msg.replaces && s.surfaces.get(msg.replaces)?.live ? msg.replaces : null,
      runId: msg.runId,
    });
    return cut(sessionKey, surface, {
      cause: "commit",
      streaming: false,
      spec: null,
      withdrawn: true,
      replaces: msg.replaces,
      runId: msg.runId,
    });
  }

  function commitSurface(
    sessionKey        ,
    s              ,
    msg              ,
    surface              ,
    fold                  ,
    endedAs                 ,
  )                               {
    if (!msg.isNew && (s.ended.has(surface.surfaceId) || !surface.live)) {

      trace("liveui_v2_patch_discarded", { sessionKey, surfaceId: surface.surfaceId, runId: msg.runId });
      return null;
    }
    const model = fold.model ;
    const result = compileFor(surface, model, msg, true);
    reportNotes(sessionKey, s, surface.surfaceId, [...fold.notes, ...result.notes]);
    for (const key of msg.touched) {

      if (key !== "frame" && !fold.touched.includes(key)) {
        trace("liveui_v2_record_removed", { sessionKey, surfaceId: surface.surfaceId, key, reason: "commit" });
      }
    }
    for (const key of fold.removes) {
      trace("liveui_v2_record_removed", { sessionKey, surfaceId: surface.surfaceId, key, reason: "remove" });
    }

    if (msg.isNew && drawsNothing(result.placed)) {

      const owed = fold.frameRepaired ? null : s.unframed;
      if (!fold.frameRepaired) s.namedFrame = { frame: model.frame, title: model.title };
      let left                               = null;
      if (surface.specRev > 0) left = retract(sessionKey, s, msg, surface);
      else dropUnpainted(s, surface);
      if (!owed) return left;

      s.unframed = null;
      const call = messageFor(s, sessionKey, { runId: owed.runId, messageIndex: null, messageId: null });
      call.viaTool = true;
      return commitMessage(sessionKey, s, call, owed.text, "end") ?? left;
    }
    if (msg.isNew) {
      s.namedFrame = null;
      s.unframed = null;
    }

    surface.committed = { frame: model.frame, title: model.title, entries: result.placed.map((e) => ({ ...e, closed: true })) };
    surface.committedSpec = result.spec;
    surface.committedPictures = result.pictures;
    surface.validEntries = new Map(result.placed.map((e) => [e.key, e]));
    for (const id of result.declared) surface.declared.add(id);
    const stateWrite = stateWriteFor(surface, msg, result.stateSeeds);
    for (const [key, value] of Object.entries(result.stateSeeds)) surface.modelKnown.set(key, value);
    for (const [key, value] of Object.entries(result.keptStarts)) if (!surface.modelKnown.has(key)) surface.modelKnown.set(key, value);

    const liveRefs = new Set(result.declared);
    for (const [k, ref] of surface.refs) if (!liveRefs.has(ref)) surface.refs.delete(k);

    let left                = null;
    if (msg.isNew && !surface.live) {
      surface.live = true;
      if (msg.replaces && msg.replaces !== surface.surfaceId) {

        s.stack = s.stack.filter((id) => id !== msg.replaces);
        s.ended.add(msg.replaces);
        s.surfaces.delete(msg.replaces);
        left = msg.replaces;
      }
      s.stack.push(surface.surfaceId);
    }
    const specJson = JSON.stringify(result.spec);

    const owed = endedAs !== null && surface.lastEnded !== endedAs;
    if (specJson === surface.lastSpecJson && !surface.lastStreaming && Object.keys(stateWrite).length === 0 && !owed) return null;
    return cut(sessionKey, surface, {
      cause: "commit",
      streaming: false,
      spec: result.spec,
      ended: endedAs,
      stateWrite,
      replaces: left,
      runId: msg.runId,
      records: result.placed.length,
      pictures: result.pictures,
    });
  }

  function endedMessageOf(s              , runId               , messageId        )                      {
    for (const msg of s.messages.values()) if (msg.ended && msg.messageId === messageId && msg.runId === runId) return msg;
    return null;
  }

  function findCommitTarget(s              , runId               , messageId               )                      {
    if (messageId) {
      for (const msg of s.messages.values()) if (msg.messageId === messageId && msg.runId === runId) return msg;
    }
    const openKey = s.openByRun.get(runId ?? "");
    return openKey ? s.messages.get(openKey) ?? null : null;
  }

  return {
    streamText,

    commitText(
      sessionKey        ,
      input                                                                                                                        ,
    )                               {
      if (typeof sessionKey !== "string" || !sessionKey || typeof input.text !== "string") return null;
      const s = session(sessionKey);
      const runId = input.runId ?? null;
      const messageId = typeof input.messageId === "string" && input.messageId ? input.messageId : null;
      let msg = findCommitTarget(s, runId, messageId);
      if (!msg) {

        if (!input.text.includes("<ui") && !input.text.includes("![") && !input.text.includes("MEDIA:")) return null;
        msg = messageFor(s, sessionKey, { runId, messageIndex: null, messageId });
      }
      const stopped = s.stopped.has(runId ?? "");
      if (msg.ended && !stopped && input.text === msg.text && input.viaTool !== true && !input.seed) {

        trace("liveui_v2_commit_repeat", { sessionKey, surfaceId: msg.surfaceId, runId });
        return null;
      }
      if (input.viaTool === true) msg.viaTool = true;

      if (input.seed && !msg.surfaceId) msg.seed = input.seed;
      if (msg.ended) {

        msg.ended = false;
        s.openByRun.set(msg.runId ?? "", msg.key);
      }
      return commitMessage(sessionKey, s, msg, input.text, stopped ? "abort" : "end");
    },

    noteStopped(sessionKey        , runIds                    = [])       {
      if (typeof sessionKey !== "string" || !sessionKey) return;
      const s = session(sessionKey);

      const runs = new Set([...runIds, ...s.openByRun.keys()].filter((runKey) => runKey));
      for (const runKey of runs) {
        s.stopped.delete(runKey);
        s.stopped.add(runKey);
      }
      while (s.stopped.size > STOPPED_RUN_MEMORY) s.stopped.delete(s.stopped.values().next().value          );
      trace("liveui_v2_stop_noted", { sessionKey, runs: runs.size });
    },

    abortRun(
      sessionKey        ,
      runId               ,
      reason                         = "failed",
    )                               {
      const s = sessions.get(sessionKey);
      if (!s) return null;
      const key = s.openByRun.get(runId ?? "");
      const msg = key ? s.messages.get(key) : undefined;
      if (!msg || msg.ended) return null;
      return commitMessage(sessionKey, s, msg, msg.text, "abort", reason === "failed" ? "failed" : null);
    },

    noteEnded(sessionKey        , surfaceId        )       {
      const s = sessions.get(sessionKey);
      if (!s) return;
      s.ended.add(surfaceId);
      s.stack = s.stack.filter((id) => id !== surfaceId);
      s.surfaces.delete(surfaceId);
      if (typeof options.onSurfaceEnded === "function") options.onSurfaceEnded(sessionKey, surfaceId);
    },

    withdraw(sessionKey        , surfaceId        , reason        )                               {
      const s = sessions.get(sessionKey);
      const surface = storedSurface(sessionKey, surfaceId);
      if (!s || !surface) return null;
      s.ended.add(surfaceId);
      s.surfaces.delete(surfaceId);
      s.stack = s.stack.filter((id) => id !== surfaceId);
      trace("liveui_v2_withdrawn", { sessionKey, surfaceId, reason });
      return cut(sessionKey, surface, { cause: "commit", streaming: false, spec: null, withdrawn: true, runId: null });
    },

    setInputs(
      sessionKey        ,
      surfaceId        ,
      inputs                       ,
      values                          ,
    )

                                                                              {
      const surface = storedSurface(sessionKey, surfaceId);
      if (!surface) return { ok: false, reason: "surface_gone" };
      const valid = validateLiveUiInputs(inputs);
      if (!valid.ok) return { ok: false, reason: "inputs_invalid", code: valid.code, detail: valid.message };
      const filled = fillLiveUiInputs(valid.inputs, values, surface.data);
      if (!filled.ok) {
        const code = filled.reason === "unknown_key" ? "unknown_key" : filled.code;
        const detail = filled.reason === "unknown_key" ? `no input ${filled.key}` : filled.detail;
        return { ok: false, reason: "inputs_invalid", code, detail };
      }
      surface.inputs = valid.inputs;

      const declared = new Set(valid.inputs.map((input) => input.key));
      const more = keepMore(surface.more, (key) => declared.has(key) && (!values || values[key] === undefined));
      const changed = !sameJson(filled.data, surface.data) || !sameJson(filled.loading, surface.loading) ||
        !sameJson(more, surface.more);
      surface.data = filled.data;
      surface.loading = filled.loading;
      surface.more = more;
      syncDataPics(surface, null);
      trace("liveui_v2_inputs_set", {
        sessionKey,
        surfaceId,
        inputs: valid.inputs.map((i) => i.key),
        loading: filled.loading,
        changed,
      });
      if (changed) cutData(sessionKey, surface);
      return { ok: true, specRev: surface.specRev };
    },

    writeData(
      sessionKey        ,
      surfaceId        ,
      patch                         ,
      opts                     = {},
    )                                                                      {
      const surface = storedSurface(sessionKey, surfaceId);
      if (!surface) return { ok: false, reason: "surface_gone" };
      const byKey = new Map((surface.inputs ?? []).map((input) => [input.key, input]));
      const entries = patch && typeof patch === "object" && !Array.isArray(patch) ? Object.entries(patch) : [];
      const next                          = { ...surface.data };
      const written = new Set        ();
      for (const [key, value] of entries) {
        if (value === undefined) continue;
        if (key === "error") {
          const error = errorValue(value);
          if (!error.ok) return { ok: false, reason: "bad_value", key, code: "input_value_type", detail: error.detail };
          next.error = error.value;
        } else {
          const input = byKey.get(key);
          if (!input) {
            trace("liveui_v2_data_refused", { sessionKey, surfaceId, key, reason: "unknown_key" });
            return { ok: false, reason: "unknown_key", key };
          }
          const checked = checkLiveUiInputValue(input, value);
          if (!checked.ok) {
            trace("liveui_v2_data_refused", { sessionKey, surfaceId, key, reason: "bad_value", code: checked.code });
            return { ok: false, reason: "bad_value", key, code: checked.code, detail: checked.detail };
          }
          next[key] = checked.value;
        }
        written.add(key);
      }
      const loading = surface.loading.filter((key) => !written.has(key));

      const more = keepMore(surface.more, (key) => !written.has(key));
      const fresh = new Set        ();
      if ((opts.cause ?? "tick") === "tick") {
        for (const key of written) if (holdsPicture(byKey.get(key), next[key])) fresh.add(key);
      }
      if (
        fresh.size === 0 && sameJson(next, surface.data) && loading.length === surface.loading.length &&
        sameJson(more, surface.more)
      ) {
        return { ok: true, specRev: surface.specRev, changed: false };
      }
      surface.data = next;
      surface.loading = loading;
      surface.more = more;
      syncDataPics(surface, fresh);
      cutData(sessionKey, surface);
      return { ok: true, specRev: surface.specRev, changed: true };
    },

    refreshPictureTitles()       {
      if (!options.pictureTitle) return;
      for (const [sessionKey, s] of sessions) {
        for (const surface of s.surfaces.values()) {
          if (s.ended.has(surface.surfaceId)) continue;
          const spec = surface.committedSpec ?? surface.lastSpec;
          const pictures = surface.committedSpec ? surface.committedPictures : surface.lastPictures;
          if (!spec || !plateTitle(spec, pictures).title) continue;
          trace("liveui_v2_plate_title", { sessionKey, surfaceId: surface.surfaceId, late: true });
          cutData(sessionKey, surface);
        }
      }
    },

    isLive(sessionKey        , surfaceId        )          {
      const surface = storedSurface(sessionKey, surfaceId);
      if (!surface) return false;
      return surface.live || surface.reserved || openSurfaceOf(sessions.get(sessionKey) ) === surface;
    },

    refreshTarget(
      sessionKey        ,
      keys                    = [],
    )                                                                  {
      if (typeof sessionKey !== "string" || !sessionKey) return null;
      const s = session(sessionKey);
      const open = openSurfaceOf(s);
      if (open) return { surfaceId: open.surfaceId, kind: "open" };
      const top = patchTargetOf(sessionKey, s);
      const wanted = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === "string" && key);

      const specs = top ? [top.committedSpec, top.lastStreaming ? top.lastSpec : null] : [];
      const reads = new Set(specs.flatMap((spec) => (spec ? [...liveUiSpecDataKeys(spec)] : [])));
      if (top && (wanted.length === 0 || wanted.some((key) => reads.has(key)))) {
        return { surfaceId: top.surfaceId, kind: "top" };
      }
      if (wanted.length === 0) return null;
      const held = s.reservation && !s.ended.has(s.reservation) ? s.surfaces.get(s.reservation) : undefined;
      if (held && held.reserved) return { surfaceId: held.surfaceId, kind: "reserved" };
      const surface = newSurface(mint());
      surface.reserved = true;
      s.surfaces.set(surface.surfaceId, surface);
      s.reservation = surface.surfaceId;
      trace("liveui_v2_refresh_reserved", { sessionKey, surfaceId: surface.surfaceId, top: top ? top.surfaceId : null });
      return { surfaceId: surface.surfaceId, kind: "reserved" };
    },

    noteUnframed(sessionKey        , input                                 )       {
      if (typeof sessionKey !== "string" || !sessionKey || typeof input.text !== "string") return;
      session(sessionKey).unframed = { runId: input.runId, text: input.text };
    },

    endNamedFrame(sessionKey        )       {
      const s = sessions.get(sessionKey);
      if (!s) return;
      s.namedFrame = null;
      s.unframed = null;
    },

    endReservation(sessionKey        )       {
      const s = sessions.get(sessionKey);
      const id = s ? s.reservation : null;
      if (!s || !id) return;
      s.reservation = null;
      const surface = s.surfaces.get(id);
      if (!surface || !surface.reserved) return;
      s.surfaces.delete(id);
      s.ended.add(id);
      s.dropLines.push(cutBytes(`refresh on ${id} dropped: the reply wrote no new surface for it`, LIVEUI_DROP_LINE_MAX_BYTES));
      trace("liveui_v2_refresh_reservation_ended", { sessionKey, surfaceId: id });
      if (typeof options.onSurfaceEnded === "function") options.onSurfaceEnded(sessionKey, id);
    },

    surfaceMeta(
      sessionKey        ,
      surfaceId        ,
    )

             {
      const surface = storedSurface(sessionKey, surfaceId);
      if (!surface) return null;
      return {
        origin: surface.origin,
        passive: surface.passive,
        inputs: surface.inputs ? surface.inputs.map((input) => ({ ...input })) : null,
        data: { ...surface.data },

        pictureSources: Object.fromEntries(surface.committedPictures.map((p) => [p.id, p.src])),
      };
    },

    markSurface(sessionKey        , surfaceId        , meta                                                     )          {
      const surface = storedSurface(sessionKey, surfaceId);
      if (!surface || !meta || typeof meta !== "object") return false;
      if (isLiveUiSurfaceOrigin(meta.origin)) surface.origin = meta.origin;
      if (typeof meta.passive === "boolean") surface.passive = meta.passive;
      return true;
    },

    noteModelShownState(sessionKey        , surfaceId        , key        , value                 )       {
      const surface = sessions.get(sessionKey)?.surfaces.get(surfaceId);
      if (surface) surface.modelKnown.set(key, value);
    },

    modelState(sessionKey        , surfaceId        )                                         {
      const surface = sessions.get(sessionKey)?.surfaces.get(surfaceId);
      return surface ? Object.fromEntries(surface.modelKnown) : null;
    },

    noteCompaction(sessionKey        )       {
      session(sessionKey).compactionOwed = true;
    },

    noteDropLine(sessionKey        , text        )       {
      if (typeof sessionKey !== "string" || !sessionKey || typeof text !== "string" || !text.trim()) return;
      session(sessionKey).dropLines.push(cutBytes(text.trim(), LIVEUI_DROP_LINE_MAX_BYTES));
      trace("liveui_v2_drop_line", { sessionKey, kind: "picture" });
    },

    takeFenceFragments(sessionKey        )                        {
      const s = sessions.get(sessionKey);
      if (!s) return [];
      const out                        = [];
      if (s.dropLines.length > 0) {
        const lines = s.dropLines.slice(0, LIVEUI_DROP_REPORT_MAX_LINES);
        const more = s.dropLines.length - lines.length;
        if (more > 0) lines.push(`and ${more} more`);
        out.push({ kind: "liveui_drop_report", text: lines.join("\n") });
        trace("liveui_v2_drop_report_taken", { sessionKey, lines: s.dropLines.length });
        s.dropLines = [];
      }
      if (s.compactionOwed) {
        s.compactionOwed = false;
        const target = patchTargetOf(sessionKey, s);
        if (target && target.committed) {
          const line = surfaceIdsLine(target.committed);
          if (line) out.push({ kind: "liveui_surface_ids", text: line });
        }
      }
      return out;
    },

    patchTarget(sessionKey        )                {
      const s = sessions.get(sessionKey);
      return s ? patchTargetOf(sessionKey, s)?.surfaceId ?? null : null;
    },

    checkText(sessionKey        , text        , opts                                 = {})                     {
      const recs = typeof text === "string" ? records(text, "end") : [];
      const s = sessions.get(sessionKey);
      const target = s ? patchTargetOf(sessionKey, s) : null;
      const targetId = target ? target.surfaceId : null;
      if (recs.length === 0) return { ok: false, mode: "none", target: targetId, frame: null, placed: [], notes: [], reason: "no_records" };
      const fold = foldUiRecords(recs, {
        base: target?.committed ?? null,
        final: true,
        decidedFrame: null,
        namedFrame: s ? namedFrameOf(s) : null,
      });
      const foldNotes = fold.notes.map(publicNote);

      if (fold.mode === "none" || fold.mode === "text" || !fold.model) {
        return {
          ok: false,
          mode: fold.mode,
          target: targetId,
          frame: null,
          placed: [],
          notes: foldNotes,
          reason: fold.mode === "text" ? "no_patch_target" : "no_surface",
        };
      }
      const fallbacks = new Map                          (fold.mode === "new" || !target ? [] : target.validEntries);

      const inputs = opts.inputs ?? (fold.mode !== "new" && target && target.inputs ? target.inputs.map((input) => input.key) : []);
      const result = compileSurfaceModel(cloneSurfaceModel(fold.model), { final: true, fallbacks, pictureBytes: true, inputs });
      const placed = result.placed.filter((entry) => result.valid.has(entry.key)).map((entry) => entry.key);
      const ok = fold.mode === "new" ? !drawsNothing(result.placed) : true;
      return {
        ok,
        mode: fold.mode,
        target: targetId,
        frame: fold.model.frame,
        placed,
        notes: [...foldNotes, ...result.notes.map(publicNote)],
        reason: ok ? null : "nothing_placed",
        reads: [...liveUiSpecDataKeys(result.spec)],
      };
    },

    stack(sessionKey        )           {
      return [...(sessions.get(sessionKey)?.stack ?? [])];
    },

    getSurface(sessionKey        , surfaceId        )                               {
      const surface = sessions.get(sessionKey)?.surfaces.get(surfaceId);
      if (!surface) return null;
      return {
        surfaceId,
        specRev: surface.specRev,
        spec: surface.lastSpec,
        committedSpec: surface.committedSpec,
        streaming: surface.lastStreaming,
        ...(surface.lastWhole ? { whole: true          } : {}),
        ...(surface.lastEnded ? { ended: surface.lastEnded } : {}),
        ...(surface.asked ? { asked: surface.asked } : {}),
        live: surface.live,
        declared: [...surface.declared],
        origin: surface.origin,
      };
    },

    clearSession(sessionKey        )       {
      sessions.delete(sessionKey);
    },
  };
}

function surfaceIdsLine(model                    )                {
  const ids = model.entries.filter((e) => e.kind === "component").map((e) => e.name);
  const lets = model.entries.filter((e) => e.kind === "let").map((e) => `let ${e.name}`);
  const all = [...ids, ...lets];
  if (all.length === 0) return null;
  const head = `Open glasses surface (${model.frame}) ids: `;
  let line = head + all.join(", ");
  if (byteLength(line) <= LIVEUI_SURFACE_IDS_MAX_BYTES) return line;
  for (let n = all.length - 1; n >= 0; n -= 1) {
    line = `${head}${all.slice(0, n).join(", ")}${n > 0 ? ", " : ""}and ${all.length - n} more`;
    if (byteLength(line) <= LIVEUI_SURFACE_IDS_MAX_BYTES) return line;
  }
  return null;
}

module.exports = { isLiveUiSurfaceOrigin, isSiteOnlyTitle, LIVEUI_DROP_REPORT_MAX_LINES, LIVEUI_DROP_LINE_MAX_BYTES, LIVEUI_SURFACE_IDS_MAX_BYTES, fillLiveUiInputs, createLiveUiSurfaceRevisions, surfaceIdsLine };
