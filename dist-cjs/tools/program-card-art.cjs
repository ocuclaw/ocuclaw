const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { carryUnknownFields, knownFields } = require("./saved-format.cjs");
const { FRAME_DETAIL_DEFAULT, frameDetailOf } = require("./program-card-frame-lane.cjs");

const PROGRAM_CARD_ART_FRAME = "program_card_art";
const PROGRAM_CARD_ART_STATE_FRAME = "program_card_art_state";
const PROGRAM_CARD_ART_FILENAME = "program-card-art-v1.json";
const PROGRAM_CARD_ART_MAX_MODEL_CHARS = 120;
const PROGRAM_CARD_ART_MAX_ASKERS = 8;

function programCardArtModelName(value         )                {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > PROGRAM_CARD_ART_MAX_MODEL_CHARS || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

const PROGRAM_CARD_ART_SAVED_SHAPE             = Object.freeze({ fields: ["schemaVersion", "model", "detail"] });

function createProgramCardArtStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, PROGRAM_CARD_ART_FILENAME);

  function onDisk()      {
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.schemaVersion !== 1) return null;
      return doc;
    } catch (_) {
      return null;
    }
  }
  function read()                {
    const doc = onDisk();
    return doc ? programCardArtModelName(knownFields(doc, PROGRAM_CARD_ART_SAVED_SHAPE).model) : null;
  }
  function readDetail()                     {
    const doc = onDisk();
    return doc ? frameDetailOf(knownFields(doc, PROGRAM_CARD_ART_SAVED_SHAPE).detail) : null;
  }

  function put(change                                                        ) {
    const was = onDisk();
    const model = "model" in change ? programCardArtModelName(change.model) : (was ? programCardArtModelName(was.model) : null);
    const detail = "detail" in change ? frameDetailOf(change.detail) : (was ? frameDetailOf(was.detail) : null);
    const next = { schemaVersion: 1, model, ...(detail ? { detail } : {}) };
    const record = carryUnknownFields(was, next, PROGRAM_CARD_ART_SAVED_SHAPE);
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record });
  }
  return {
    file,
    read,
    write: (model               ) => put({ model }),
    readDetail,
    writeDetail: (detail                    ) => put({ detail }),
  };
}

function createProgramCardArt(deps

 ) {
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const store = deps.store && typeof deps.store === "object" ? deps.store : null;
  const askers = new Set        ();
  let detailPicked              = FRAME_DETAIL_DEFAULT;
  try { detailPicked = store?.readDetail?.() ?? FRAME_DETAIL_DEFAULT; } catch (_) { detailPicked = FRAME_DETAIL_DEFAULT; }
  const takesDetail = () => {
    try { return deps.takesDetail?.() === true; } catch (_) { return false; }
  };

  function state()                             {
    let host          = null;
    try { host = deps.host(); } catch (_) { host = null; }
    if (host !== "openclaw" && host !== "hermes") return null;
    return {
      type: PROGRAM_CARD_ART_STATE_FRAME, host, painting: false, why: "off", model: null, pick: null, choices: [], canPick: false,
      ...(takesDetail() ? { detail: detailPicked } : {}),
    };
  }

  function handle(frame     , clientId        ) {
    const op = frame && typeof frame.op === "string" ? frame.op : "";
    if (op === "detail") {
      const asked = frameDetailOf(frame.detail);

      if (asked && takesDetail()) {
        const changed = asked !== detailPicked;
        detailPicked = asked;
        try { store?.writeDetail?.(asked); } catch (err     ) { emit("program_card_art_store_failed", "warn", { code: String(err?.code ?? "write") }); }
        emit("program_card_art_detail", "info", { detail: asked });
        if (changed) tell(clientId);
      }
    } else if (op !== "state" && op !== "pick") {
      return;
    }
    const answer = state();
    if (!answer || typeof clientId !== "string" || !clientId) return;

    askers.delete(clientId);
    askers.add(clientId);
    if (askers.size > PROGRAM_CARD_ART_MAX_ASKERS) askers.delete(askers.values().next().value          );
    deps.send(clientId, answer);
  }

  function tell(except         ) {
    try {
      if (askers.size === 0) return;
      const answer = state();
      if (answer) for (const clientId of [...askers]) if (clientId !== except) deps.send(clientId, answer);
    } catch (_) {  }
  }

  return {

    handle: (frame     , clientId        ) => { try { handle(frame, clientId); } catch (_) {  } },
    state,

    detail: ()                     => (takesDetail() ? detailPicked : null),

    forget: (clientId        ) => { askers.delete(clientId); },
  };
}

module.exports = { PROGRAM_CARD_ART_FRAME, PROGRAM_CARD_ART_STATE_FRAME, PROGRAM_CARD_ART_FILENAME, PROGRAM_CARD_ART_MAX_MODEL_CHARS, programCardArtModelName, PROGRAM_CARD_ART_SAVED_SHAPE, createProgramCardArtStore, createProgramCardArt };
