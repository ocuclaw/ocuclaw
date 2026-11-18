const { createHash, randomUUID } = require("node:crypto");

const nodePath = require("node:path");

const CARD_STUDIO_CATEGORY = "card.studio";

const CARD_STUDIO_PRESS_EVENT = "card_studio_press";

const CARD_STUDIO_LIMITS = Object.freeze({
  memoryBuilds: 32,
  diskBuildsPerCard: 5,
  diskMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  touchedCards: 3,
  touchedTasks: 3,
  touchedKept: 64,
  callsPerBuild: 64,
  testsPerBuild: 12,
  taskDataKept: 64,
  valueChars: 2000,
  pictureChars: 262_144,
  stepsPerBuild: 32,
  notesPerBuild: 64,

  noteAfterDoneMs: 60_000,

  notePendingMs: 120_000,
  notePendingPerSession: 16,
  notePendingSessions: 64,
  runsPerBuild: 8,

  doneAfterCloseMs: 300_000,

  pressStarts: 16,
  pressStartCards: 3,

  startStateChars: 65_536,

  lookStartSlackMs: 2000,

  pressFreshMs: 3000,

  cardEventsPerCard: 64,
});

const SOURCE_WORD = /^[a-z][a-z0-9_-]{0,31}$/i;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/;
const CODE_WORD = /^[a-z][a-z0-9_]{0,63}/;
const PRESS_CONTROLS = new Set(["tap", "double", "up", "down", "hold", "release", "back", "menu", "text", "voice"]);
const PROBLEM_KEYS = ["code", "id", "path", "step", "level", "severity"];
const STEP_DROP = new Set(["png", "lz4", "source"]);

const DONE_BY = new Set(["clean_test", "agent_sign_off", "test_limit", "run_end", "stopped"]);

const DONE_LINES = ["passed", "fixed", "wearer_check", "still_open", "not_tested"];

const STEP_PHASE = /^[a-z_]{1,24}$/;

const NOTE_EVENT = /^[a-z][a-z0-9_]{0,63}$/;

const CARD_EVENT = /^card_(review|accept)(_[a-z]{1,16}){0,2}$/;

function stepsOf(raw     ) {
  if (!Array.isArray(raw)) return null;
  const steps = raw.filter((step     ) => isRecord(step) && typeof step.phase === "string" && STEP_PHASE.test(step.phase))
    .slice(0, CARD_STUDIO_LIMITS.stepsPerBuild)
    .map((step     ) => ({
      phase: step.phase,
      atMs: Number.isFinite(step.atMs) ? Math.floor(step.atMs) : null,
      durationMs: Number.isFinite(step.durationMs) && step.durationMs >= 0 ? Math.round(step.durationMs) : null,
      ...(typeof step.detail === "string" && step.detail.trim() ? { detail: step.detail.trim().slice(0, 80) } : {}),
    }));
  return steps.length ? steps : null;
}

function doneLinesOf(raw     ) {
  if (!isRecord(raw)) return null;
  const lines      = {};
  for (const verdict of DONE_LINES) lines[verdict] = Number.isSafeInteger(raw[verdict]) && raw[verdict] >= 0 ? raw[verdict] : 0;
  return lines;
}

function runIdOf(raw     ) {
  return typeof raw === "string" && ID.test(raw) ? raw : null;
}

function sha(text        ) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function isRecord(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cut(text        ) {
  return text.length > CARD_STUDIO_LIMITS.valueChars ? text.slice(0, CARD_STUDIO_LIMITS.valueChars) : text;
}

function codeRef(text        ) {
  return { code: true, hash: sha(text), length: text.length };
}

function bounded(value     , depth = 0, drop                     = null)      {
  if (typeof value === "string") return cut(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 8 || typeof value !== "object") return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => bounded(entry, depth + 1, drop));
  const out      = {};
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    if (drop && drop.has(key)) continue;
    if (key === "source" && typeof entry === "string") out[key] = codeRef(entry);
    else if (key === "edits" && Array.isArray(entry)) {
      out[key] = entry.slice(0, 32).map((edit     ) => isRecord(edit)
        ? Object.fromEntries(Object.entries(edit).map(([k, v]) =>
          [k, (k === "find" || k === "replace") && typeof v === "string" ? codeRef(v) : bounded(v, depth + 2, drop)]))
        : null);
    } else out[key] = bounded(entry, depth + 1, drop);
  }
  return out;
}

function cardStudioArgs(args     ) {
  return isRecord(args) ? bounded(args) : {};
}

function readResult(result     )                                                                    {
  let body      = result;
  let picture      = null;
  if (isRecord(result) && Array.isArray(result.content)) {
    body = null;
    for (const block of result.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && body === null && typeof block.text === "string") {
        try { body = JSON.parse(block.text); } catch { body = block.text; }
      }
      if (block.type === "image" && typeof block.data === "string" && block.data) {
        picture = { data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" };
      }
    }
  }
  return { body, picture };
}

function outcomeOf(body     )                                    {
  if (typeof body === "string") return { result: "text" };
  if (!isRecord(body)) return { result: "none" };
  if (typeof body.answer === "string" && CODE_WORD.test(body.answer)) return { result: body.answer.match(CODE_WORD) [0] };
  if (body.ok === true) return { result: "ok" };
  if (body.ok === false || typeof body.error === "string") {
    const match = typeof body.error === "string" ? body.error.trim().match(CODE_WORD) : null;
    return match ? { result: "error", code: match[0] } : { result: "error" };
  }
  return { result: "none" };
}

function madeOf(body     ) {
  if (!isRecord(body)) return null;
  const made      = {};
  const draft = body.draft;
  const draftId = isRecord(draft) ? draft.draftId ?? draft.id : typeof draft === "string" ? draft : body.draftId;
  if (typeof draftId === "string" && ID.test(draftId)) made.draftId = draftId;
  const revision = isRecord(draft) && Number.isSafeInteger(draft.revision) ? draft.revision : body.revision;
  if (Number.isSafeInteger(revision) && revision >= 1) made.revision = revision;
  if (typeof body.appId === "string" && ID.test(body.appId)) made.appId = body.appId;
  return Object.keys(made).length ? made : null;
}

function testOf(body     ) {
  if (!isRecord(body)) return null;
  const report = isRecord(body.report) ? body.report : isRecord(body.firstLook) && isRecord(body.firstLook.report) ? body.firstLook.report : null;
  if (!report || !Array.isArray(report.steps)) return null;
  const verdictSource = [body.tested?.verdicts, body.verdicts, body.firstLook?.verdicts, body.tests].find(Array.isArray);
  return {
    steps: report.steps.slice(0, 32).map((step     ) => bounded(step, 1, STEP_DROP)),
    problems: (Array.isArray(report.problems) ? report.problems : []).slice(0, 64).filter(isRecord)
      .map((problem     ) => Object.fromEntries(PROBLEM_KEYS.filter((key) => problem[key] !== undefined).map((key) => [key, bounded(problem[key], 2)]))),
    verdicts: verdictSource ? bounded(verdictSource, 1) : [],
    ...(Number.isFinite(report.phoneMs) ? { phoneMs: report.phoneMs } : {}),
  };
}

function cardStudioValueDigest(values     ) {
  const canonical = (value     )      => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  return sha(JSON.stringify(canonical(values ?? null)));
}

function cardStudioPressData(raw     ) {
  if (!isRecord(raw) || typeof raw.control !== "string" || !PRESS_CONTROLS.has(raw.control)) return null;
  const out      = { control: raw.control, focusId: typeof raw.focusId === "string" && ID.test(raw.focusId) ? raw.focusId : null };
  if (typeof raw.cardKey === "string" && ID.test(raw.cardKey)) out.cardKey = raw.cardKey;
  if (Number.isFinite(raw.heldMs) && raw.heldMs >= 0) out.heldMs = Math.round(raw.heldMs);
  out.atMs = Number.isFinite(raw.atMs) ? Math.floor(raw.atMs) : null;
  return out;
}

function fitCodesOf(fixes     , unchecked     ) {
  const codes           = [];
  if (isRecord(fixes)) {
    for (const [key, fix] of Object.entries(fixes)) {
      if (!ID.test(key) || !isRecord(fix)) continue;
      for (const kind of ["hidden", "cut", "dropped"]) if ((fix       )[kind]) codes.push(`${key}:${kind}`);
    }
  }
  if (isRecord(unchecked)) for (const key of Object.keys(unchecked)) if (ID.test(key)) codes.push(`${key}:unchecked`);
  return codes.slice(0, 32);
}

const OPEN_SOURCE_MAX = 131_072;

function onScreenRecord(card     ) {
  const source = typeof card.source === "string" && card.source.length <= OPEN_SOURCE_MAX ? card.source : null;
  let state      = null;
  try {
    const text = card.state === undefined ? null : JSON.stringify(card.state);
    state = typeof text === "string" && text.length <= 65_536 ? JSON.parse(text) : null;
  } catch {
    state = null;
  }
  const error = isRecord(card.lastError) && typeof card.lastError.message === "string" ? card.lastError.message
    : typeof card.failure === "string" ? card.failure : null;
  return {
    source,
    state,
    lastError: error ? cut(error).slice(0, 500) : null,
    savedRevision: isRecord(card.saved) && Number.isSafeInteger(card.saved.revision) && card.saved.revision > 0 ? card.saved.revision : null,
    unsaved: Number.isSafeInteger(card.unsaved) && card.unsaved > 0 ? card.unsaved : 0,
  };
}

function createCardStudioStore(opts      = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const matchKey = typeof opts.matchKey === "function" ? opts.matchKey : (key        ) => key;
  const fs = opts.fs && typeof opts.dir === "string" && opts.dir ? opts.fs : null;
  const dir = fs ? opts.dir : null;
  const builds        = [];
  const openBySession = new Map             ();
  const touches          = [];
  const taskRows        = [];

  const pendingNotes = new Map               ();

  const cardEvents = new Map               ();
  let cardEventSeq = 0;

  const sessionCards = new Map                                             ();
  let onScreen                                                                          = null;

  const lookStarts = new Map                   ();
  const pressStarts = new Map                                                                  ();
  let quickestPressLagMs                = null;

  function touch(entry                                                                                         ) {
    if (!entry || (entry.kind !== "card" && entry.kind !== "task") || typeof entry.id !== "string" || !entry.id) return;
    const prior = touches.findIndex((t) => t.kind === entry.kind && t.id === entry.id);
    const name = typeof entry.name === "string" && entry.name.trim() ? cut(entry.name.trim()).slice(0, 80)
      : prior >= 0 ? touches[prior].name : null;
    if (prior >= 0) touches.splice(prior, 1);
    touches.push({ kind: entry.kind, id: entry.id, name, why: entry.why, atMs: Number.isFinite(entry.atMs) ? entry.atMs           : now() });
    if (touches.length > CARD_STUDIO_LIMITS.touchedKept) touches.shift();
  }

  function rekey(from        , to        ) {
    for (const t of touches) if (t.kind === "card" && t.id === from) t.id = to;
    for (let i = touches.length - 1; i >= 0; i -= 1) {
      if (touches[i].kind === "card" && touches[i].id === to && touches.findIndex((t) => t.kind === "card" && t.id === to) !== i) touches.splice(i, 1);
    }
  }

  function touched({ windowMs = null }                               = {}) {
    const from = Number.isFinite(windowMs) && (windowMs          ) > 0 ? now() - (windowMs          ) : -Infinity;
    const pick = (kind                 , cap        , first       ) => {
      const out = [...first];
      for (let i = touches.length - 1; i >= 0 && out.length < cap; i -= 1) {
        const t = touches[i];
        if (t.kind !== kind || t.atMs < from || out.some((o) => o.id === t.id)) continue;
        out.push({ id: t.id, name: t.name, why: t.why, atMs: t.atMs });
      }
      return out;
    };
    const screen = onScreen ? [{ id: onScreen.id, name: onScreen.name ?? touches.find((t) => t.id === onScreen .id)?.name ?? null, why: "on_screen", atMs: now() }] : [];
    return { cards: pick("card", CARD_STUDIO_LIMITS.touchedCards, screen), tasks: pick("task", CARD_STUDIO_LIMITS.touchedTasks, []) };
  }

  function fileFor(cardKey        ) {
    return nodePath.join(dir, `${createHash("sha256").update(cardKey, "utf8").digest("hex").slice(0, 24)}.json`);
  }
  function fresh(build     ) {
    return (build.endedAtMs ?? build.startedAtMs) >= now() - CARD_STUDIO_LIMITS.diskMaxAgeMs;
  }

  function readDoc(cardKey        )                                   {
    if (!fs) return { builds: [], events: [] };
    const file = fileFor(cardKey);
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isRecord(doc) || doc.v !== 1 || doc.cardKey !== cardKey || !Array.isArray(doc.builds)) return { builds: [], events: [] };
      const builds = doc.builds.filter((build     ) => isRecord(build) && typeof build.buildId === "string" && fresh(build));
      const events = (Array.isArray(doc.events) ? doc.events : []).filter((entry     ) => isRecord(entry) && typeof entry.id === "string" &&
        typeof entry.event === "string" && CARD_EVENT.test(entry.event) && isRecord(entry.data) && Number.isFinite(entry.atMs) && entry.atMs >= now() - CARD_STUDIO_LIMITS.diskMaxAgeMs);
      if (!builds.length && !events.length) { try { fs.unlinkSync(file); } catch {  } }
      return { builds, events };
    } catch {
      return { builds: [], events: [] };
    }
  }
  function readDisk(cardKey        )        {
    return readDoc(cardKey).builds;
  }
  function writeDoc(cardKey        , builds       , events       ) {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(cardKey);
    const tmp = `${file}.${(globalThis       ).process?.pid ?? 0}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, cardKey, builds, ...(events.length ? { events } : {}) }));
    fs.renameSync(tmp, file);
  }

  let swept = false;
  function sweep() {
    if (swept) return;
    swept = true;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
        const file = nodePath.join(dir, name);
        try { if (fs.statSync(file).mtimeMs < now() - CARD_STUDIO_LIMITS.diskMaxAgeMs) fs.unlinkSync(file); } catch {  }
      }
    } catch {

    }
  }
  function persist(build     ) {
    if (!fs || !build.cardKey || build.cardKey.startsWith("build:")) return;
    sweep();
    try {
      const doc = readDoc(build.cardKey);
      const prior = doc.builds.filter((b     ) => b.buildId !== build.buildId);
      const next = [...prior, snapshot(build)].sort((a, b) => a.startedAtMs - b.startedAtMs).slice(-CARD_STUDIO_LIMITS.diskBuildsPerCard);
      writeDoc(build.cardKey, next, doc.events);
    } catch {

    }
  }

  function snapshot(build     ) {
    const { sessionKey: _sessionKey, ...kept } = build;
    return JSON.parse(JSON.stringify(kept));
  }

  function close(build     , outcome               ) {
    if (build.endedAtMs == null) build.endedAtMs = now();
    if (outcome && build.outcome == null) build.outcome = outcome;
    openBySession.delete(build.sessionKey);
    persist(build);
  }

  function cardKeyFor(session        , buildId        ) {
    return sessionCards.get(session)?.id ?? `build:${buildId}`;
  }

  function adoptCard(build     , card                                     ) {
    if (build.cardKey === card.id) return;

    if (build.cardKey.startsWith("app:") && !card.id.startsWith("app:")) return;
    const from = build.cardKey;
    build.cardKey = card.id;
    if (!build.name && card.name) build.name = card.name;
    rekey(from, card.id);
  }

  function stateText(value     )                {
    if (value === undefined || value === null) return null;
    try {
      const text = JSON.stringify(value);
      return typeof text === "string" && text.length <= CARD_STUDIO_LIMITS.startStateChars ? text : null;
    } catch {
      return null;
    }
  }

  function noteLookStart(look     ) {
    if (!look || typeof look.sessionKey !== "string" || !look.sessionKey) return;
    const session = matchKey(look.sessionKey);
    const given = isRecord(look.start) && look.start.state !== undefined && look.start.state !== null;
    const live = onScreen && onScreen.session === session && onScreen.open ? onScreen.open.state : null;
    const entry            = { atMs: now(), text: stateText(given ? look.start.state : live), from: given ? "call" : "live" };
    lookStarts.set(session, entry);
  }

  function testStartOf(session        , startedAtMs        , endedAtMs        ) {
    const slack = CARD_STUDIO_LIMITS.lookStartSlackMs;
    const look = lookStarts.get(session);
    const fresh = look && look.atMs >= startedAtMs - slack && look.atMs <= endedAtMs + slack ? look : null;
    return fresh && fresh.text !== null ? { from: fresh.from, text: fresh.text } : null;
  }

  function notePress(press     ) {
    if (!isRecord(press) || typeof press.cardKey !== "string" || press.control === "release" || !Number.isFinite(press.atMs)) return;
    const lag = now() - press.atMs;
    quickestPressLagMs = quickestPressLagMs === null ? lag : Math.min(quickestPressLagMs, lag);
    if (lag - quickestPressLagMs > CARD_STUDIO_LIMITS.pressFreshMs) return;
    if (!onScreen || onScreen.id !== press.cardKey || !onScreen.open) return;
    const text = stateText(onScreen.open.state);
    if (text === null) return;
    const ring = pressStarts.get(press.cardKey) ?? [];
    pressStarts.delete(press.cardKey);
    pressStarts.set(press.cardKey, ring);
    while (pressStarts.size > CARD_STUDIO_LIMITS.pressStartCards) pressStarts.delete(pressStarts.keys().next().value          );
    ring.push({ pressAtMs: Math.floor(press.atMs), atMs: now(), text });
    if (ring.length > CARD_STUDIO_LIMITS.pressStarts) ring.shift();
  }

  function toolCall(call     ) {
    if (!call || typeof call.tool !== "string" || typeof call.sessionKey !== "string" || !call.sessionKey) return null;
    const session = matchKey(call.sessionKey);
    const startedAtMs = Number.isFinite(call.startedAtMs) ? call.startedAtMs : now();
    const endedAtMs = Number.isFinite(call.endedAtMs) ? call.endedAtMs : now();
    let build = openBySession.get(session);

    if (build && call.tool === "ask_glasses_card" && build.calls.some((c     ) => c.tool !== "ask_glasses_card")) {
      close(build, "stopped");
      build = undefined;
    }

    let late = false;
    if (!build && call.tool !== "ask_glasses_card") {
      const last = lastBuildOf(session);
      if (last && last.endedAtMs != null && last.startedAtMs <= startedAtMs && last.endedAtMs > startedAtMs) {
        build = last;
        late = true;
      }
    }

    const early        = [];
    if (!build) {

      const prev = lastBuildOf(session);
      if (prev && prev.endedAtMs != null && Array.isArray(prev.notes) && prev.notes.length) {
        const kept        = [];
        for (const entry of prev.notes) {
          if (entry.atMs >= startedAtMs && entry.atCall >= prev.calls.length) early.push(entry);
          else kept.push(entry);
        }
        if (early.length) {
          prev.notes = kept.map((entry     , i        ) => ({ ...entry, index: i }));
          persist(prev);
        }
      }
      const buildId = String(randomUUID()).slice(0, 18);
      build = { buildId, sessionKey: session, cardKey: cardKeyFor(session, buildId), name: null, startedAtMs,
        endedAtMs: null, outcome: null, runId: null, calls: [], tests: [], notes: [], picture: null };
      openBySession.set(session, build);
      builds.push(build);
      while (builds.length > CARD_STUDIO_LIMITS.memoryBuilds) {
        const old = builds.shift();

        if (openBySession.get(old.sessionKey) === old) close(old, "evicted");
      }
    }
    noteRun(build, runIdOf(call.runId));
    const waiting = pendingNotes.get(session);
    if (waiting) {
      pendingNotes.delete(session);
      for (const entry of waiting) if (entry.atMs >= startedAtMs && entry.atMs >= now() - CARD_STUDIO_LIMITS.notePendingMs) early.push(entry);
    }
    early.sort((a, b) => a.atMs - b.atMs);
    for (const entry of early) addNote(build, entry);
    const args = cardStudioArgs(call.args);
    if (!build.name && typeof args.title === "string" && args.title.trim()) build.name = args.title.trim().slice(0, 80);
    const { body, picture } = readResult(call.result);
    const outcome = call.threw ? { result: "threw" } : outcomeOf(body);
    const made = madeOf(body);
    const index = build.calls.length;
    if (index < CARD_STUDIO_LIMITS.callsPerBuild) {
      build.calls.push({ index, tool: call.tool.slice(0, 64), atMs: startedAtMs, durationMs: Math.max(0, endedAtMs - startedAtMs),
        ...outcome, args, ...(made ? { made } : {}) });
    }
    const test = testOf(body);
    if (test && build.tests.length < CARD_STUDIO_LIMITS.testsPerBuild) {
      const start = testStartOf(session, startedAtMs, endedAtMs);

      for (const older of build.tests) delete older.startState;
      build.tests.push({ index, tool: call.tool.slice(0, 64), atMs: endedAtMs, ...test, ...(start ? { startState: start } : {}) });
    }
    lookStarts.delete(session);
    if (picture && picture.data.length <= CARD_STUDIO_LIMITS.pictureChars) build.picture = { ...picture, atMs: endedAtMs, index };
    if (made?.appId) adoptCard(build, { id: `app:${made.appId}`, name: build.name });
    if (late) persist(build);
    touch({ kind: "card", id: build.cardKey, name: build.name, why: "built", atMs: endedAtMs });
    return { buildId: build.buildId, cardKey: build.cardKey, index, tool: call.tool, ...outcome };
  }

  function buildDone(done     ) {
    if (!done || typeof done.sessionKey !== "string") return;
    const session = matchKey(done.sessionKey);

    const doneBy = typeof done.doneBy === "string" && DONE_BY.has(done.doneBy) ? done.doneBy : null;
    const doneRun = runIdOf(done.runId);

    const fill = (build     ) => {
      let changed = false;
      const set = (key        , value     ) => {
        if (value == null || build[key] != null) return;
        build[key] = value;
        changed = true;
      };
      set("doneBy", doneBy);
      if (doneRun) {
        if (noteRun(build, doneRun)) changed = true;
        if (!build.runFromDone && build.runIds.includes(doneRun)) {
          build.runFromDone = true;
          build.runId = doneRun;
          changed = true;
        }
      }
      set("steps", stepsOf(done.steps));
      set("doneLines", doneLinesOf(done.lines));
      set("doneMs", Number.isFinite(done.ms) && done.ms >= 0 ? Math.round(done.ms) : null);
      return changed;
    };
    const build = openBySession.get(session);
    if (!build) {

      const last = lastBuildOf(session);
      const seen = last ? (Array.isArray(last.runIds) ? last.runIds : last.runId ? [last.runId] : []) : [];
      const otherRun = !!doneRun && seen.length > 0 && !seen.includes(doneRun);
      const recent = last && last.endedAtMs != null && last.endedAtMs >= now() - CARD_STUDIO_LIMITS.doneAfterCloseMs;
      if (recent && !otherRun && fill(last)) persist(last);
      return;
    }
    fill(build);
    close(build, typeof done.outcome === "string" ? done.outcome : null);
  }

  function noteRun(build     , run               ) {
    if (!run) return false;
    if (!Array.isArray(build.runIds)) build.runIds = build.runId ? [build.runId] : [];
    if (build.runId == null) build.runId = run;
    if (build.runIds.includes(run) || build.runIds.length >= CARD_STUDIO_LIMITS.runsPerBuild) return false;
    build.runIds.push(run);
    return true;
  }

  function lastBuildOf(session        ) {
    for (let i = builds.length - 1; i >= 0; i--) if (builds[i].sessionKey === session) return builds[i];
    return null;
  }

  function addNote(build     , entry     ) {
    if (!Array.isArray(build.notes)) build.notes = [];
    if (build.notes.length >= CARD_STUDIO_LIMITS.notesPerBuild) return false;
    const { event, atMs, severity, data } = entry;
    build.notes.push({ index: build.notes.length, atCall: build.calls.length, event, atMs, severity, data });
    return true;
  }

  function note(raw     ) {
    if (!raw || typeof raw.sessionKey !== "string" || !raw.sessionKey || typeof raw.event !== "string" || !NOTE_EVENT.test(raw.event)) return null;
    const session = matchKey(raw.sessionKey);
    const data = isRecord(raw.data) ? bounded(raw.data) : {};

    if (isRecord(raw.data) && typeof raw.data.source === "string" && SOURCE_WORD.test(raw.data.source)) data.source = raw.data.source;
    const entry      = { event: raw.event, atMs: Number.isFinite(raw.atMs) ? Math.floor(raw.atMs) : now(),
      severity: ["debug", "info", "warn", "error"].includes(raw.severity) ? raw.severity : "debug", data };
    const open = openBySession.get(session);
    if (open) {
      addNote(open, entry);
      return open.buildId;
    }
    const last = lastBuildOf(session);
    if (last && last.endedAtMs != null && last.endedAtMs >= now() - CARD_STUDIO_LIMITS.noteAfterDoneMs) {
      if (addNote(last, entry)) persist(last);
      return last.buildId;
    }
    const waiting = (pendingNotes.get(session) ?? []).filter((e) => e.atMs >= now() - CARD_STUDIO_LIMITS.notePendingMs);
    if (waiting.length < CARD_STUDIO_LIMITS.notePendingPerSession) waiting.push(entry);
    pendingNotes.delete(session);
    pendingNotes.set(session, waiting);
    while (pendingNotes.size > CARD_STUDIO_LIMITS.notePendingSessions) pendingNotes.delete(pendingNotes.keys().next().value          );
    return null;
  }

  function cardEvent(raw     ) {
    if (!raw || typeof raw.cardKey !== "string" || !ID.test(raw.cardKey) || typeof raw.event !== "string" || !CARD_EVENT.test(raw.event)) return null;
    const atMs = Number.isFinite(raw.atMs) ? Math.floor(raw.atMs) : now();
    let data      = isRecord(raw.data) ? raw.data : {};
    if (raw.event === "card_accept_test") {
      const { look, ...ids } = data;
      data = { ...bounded(ids), ...(testOf({ report: look }) ?? { steps: [], problems: [], verdicts: [] }) };
    } else data = bounded(data);
    cardEventSeq += 1;
    const entry = { id: `${atMs.toString(36)}-${cardEventSeq.toString(36)}-${String(randomUUID()).slice(0, 8)}`, event: raw.event, atMs, data };
    const list = cardEvents.get(raw.cardKey) ?? [];
    list.push(entry);
    if (list.length > CARD_STUDIO_LIMITS.cardEventsPerCard) list.shift();
    cardEvents.delete(raw.cardKey);
    cardEvents.set(raw.cardKey, list);
    while (cardEvents.size > CARD_STUDIO_LIMITS.touchedKept) cardEvents.delete(cardEvents.keys().next().value          );
    if (fs && !raw.cardKey.startsWith("build:")) {
      sweep();
      try {
        const doc = readDoc(raw.cardKey);
        writeDoc(raw.cardKey, doc.builds, [...doc.events, entry].slice(-CARD_STUDIO_LIMITS.cardEventsPerCard));
      } catch {

      }
    }
    return entry.id;
  }

  function eventsOf(cardKey        ) {
    const byId = new Map             ();
    for (const entry of readDoc(cardKey).events) byId.set(entry.id, entry);
    for (const entry of cardEvents.get(cardKey) ?? []) byId.set(entry.id, entry);
    return [...byId.values()].map((entry, order) => ({ entry, order })).sort((a, b) => a.entry.atMs - b.entry.atMs || a.order - b.order)
      .map(({ entry }) => entry).slice(-CARD_STUDIO_LIMITS.cardEventsPerCard);
  }

  function noteContext(frame     ) {
    if (!frame || typeof frame.sessionKey !== "string" || !frame.sessionKey) return;
    const session = matchKey(frame.sessionKey);
    const card = isRecord(frame.card) ? frame.card : null;
    const key = card && card.open === true && typeof card.key === "string" && ID.test(card.key) ? card.key : null;
    if (!key) {
      sessionCards.delete(session);
      if (onScreen && onScreen.session === session) onScreen = null;
      return;
    }
    const name = typeof card .saved?.name === "string" && card .saved.name.trim() ? card .saved.name.trim()
      : typeof card .title === "string" && card .title.trim() ? card .title.trim() : null;
    const before = sessionCards.get(session)?.id;
    const entry = { id: key, name: name ? name.slice(0, 80) : null };
    sessionCards.set(session, entry);

    onScreen = { ...entry, session, open: onScreenRecord(card) };
    const build = openBySession.get(session);
    if (build) adoptCard(build, entry);
    if (before !== key) touch({ kind: "card", id: key, name: entry.name, why: "opened" });
  }

  function taskData(delivery     ) {
    if (!delivery || typeof delivery.taskId !== "string" || !ID.test(delivery.taskId)) return null;
    const cardKey = typeof delivery.cardId === "string" && ID.test(delivery.cardId) ? `app:${delivery.cardId}` : null;
    const row = {
      taskId: delivery.taskId,
      ...(cardKey ? { cardKey } : {}),
      slot: typeof delivery.slot === "string" && ID.test(delivery.slot) ? delivery.slot : "task",
      resultAtMs: Number.isFinite(delivery.resultAtMs) ? Math.floor(delivery.resultAtMs) : null,
      atMs: now(),
      valueDigest: cardStudioValueDigest(delivery.values),
      fitCodes: fitCodesOf(delivery.fixes, delivery.unchecked),
    };
    taskRows.push(row);
    if (taskRows.length > CARD_STUDIO_LIMITS.taskDataKept) taskRows.shift();
    touch({ kind: "task", id: delivery.taskId, name: typeof delivery.taskName === "string" ? delivery.taskName : null, why: "run" });
    if (cardKey) touch({ kind: "card", id: cardKey, why: "run" });
    return row;
  }

  function parsedState(text        ) {
    try { return JSON.parse(text); } catch { return undefined; }
  }

  function reportRows({ windowMs = null }                               = {}) {
    const at = now();
    const list = touched({ windowMs });
    const cardIds = new Set(list.cards.map((card     ) => card.id));
    const taskIds = new Set(list.tasks.map((task     ) => task.id));
    const byId = new Map             ();
    for (const id of cardIds) for (const build of readDisk(id)) byId.set(build.buildId, build);
    for (const build of builds) if (cardIds.has(build.cardKey)) byId.set(build.buildId, snapshot(build));
    const perCard = new Map               ();
    for (const build of byId.values()) {
      if (!cardIds.has(build.cardKey)) continue;
      const list2 = perCard.get(build.cardKey) ?? [];
      list2.push(build);
      perCard.set(build.cardKey, list2);
    }
    const rows        = [];
    const row = (ts        , event        , data     ) => rows.push({ ts, cat: CARD_STUDIO_CATEGORY, event, severity: "info", data });
    row(at, "card_studio_touched", { windowMs: Number.isFinite(windowMs) ? windowMs : null, cards: list.cards, tasks: list.tasks });
    for (const [cardKey, cardBuilds] of perCard) {
      cardBuilds.sort((a, b) => a.startedAtMs - b.startedAtMs);
      const kept = cardBuilds.slice(-CARD_STUDIO_LIMITS.diskBuildsPerCard);
      for (const build of kept) {
        const notes = Array.isArray(build.notes) ? build.notes : [];
        row(build.startedAtMs, "card_build", { buildId: build.buildId, cardKey, name: build.name ?? null, startedAtMs: build.startedAtMs,
          endedAtMs: build.endedAtMs ?? null, outcome: build.outcome ?? null, ...(build.doneBy ? { doneBy: build.doneBy } : {}),

          ...(build.runId ? { runId: build.runId } : {}),
          ...(Array.isArray(build.runIds) && build.runIds.length > 1 ? { runIds: build.runIds } : {}),
          ...(build.steps ? { steps: build.steps } : {}),
          ...(build.doneLines ? { doneLines: build.doneLines } : {}), ...(Number.isFinite(build.doneMs) ? { doneMs: build.doneMs } : {}),
          calls: build.calls.length, tests: build.tests.length, notes: notes.length });
        for (const call of build.calls) row(call.atMs, "card_build_call", { buildId: build.buildId, cardKey, ...call });
        for (const test of build.tests) {
          const { startState: _start, ...shown } = test;
          row(test.atMs, "card_build_test", { buildId: build.buildId, cardKey, ...shown });
        }
        for (const entry of notes) {
          const { atMs, severity, ...rest } = entry;
          rows.push({ ts: atMs, cat: CARD_STUDIO_CATEGORY, event: "card_build_note", severity: "info",
            data: { buildId: build.buildId, cardKey, ...rest, severity } });
        }
      }

      let newestTest                                   = null;
      for (const build of kept) {
        for (const test of build.tests) if (!newestTest || test.atMs >= newestTest.test.atMs) newestTest = { build, test };
      }
      const testStart = newestTest?.test.startState;
      const testState = testStart ? parsedState(testStart.text) : undefined;
      if (testStart && testState !== undefined) {
        row(newestTest .test.atMs, "card_start_state", { cardKey, why: "test", buildId: newestTest .build.buildId,
          index: newestTest .test.index, from: testStart.from === "call" ? "call" : "live", atMs: newestTest .test.atMs, state: testState });
      }
      const newest = [...kept].reverse().find((build) => build.picture && typeof build.picture.data === "string");
      if (newest) {
        const { data, mimeType, atMs, index } = newest.picture;
        const parts = Math.ceil(data.length / CARD_STUDIO_LIMITS.valueChars);
        for (let part = 0; part < parts; part += 1) {
          row(atMs, "card_build_picture", { buildId: newest.buildId, cardKey, index, part, parts, mimeType,
            data: data.slice(part * CARD_STUDIO_LIMITS.valueChars, (part + 1) * CARD_STUDIO_LIMITS.valueChars) });
        }
      }
    }

    const windowFrom = Number.isFinite(windowMs) && (windowMs          ) > 0 ? at - (windowMs          ) : -Infinity;
    for (const cardKey of cardIds) {
      const ring = pressStarts.get(cardKey) ?? [];
      const first = ring.findIndex((entry) => entry.atMs >= windowFrom);
      const state = first >= 0 ? parsedState(ring[first].text) : undefined;
      if (first < 0 || state === undefined) continue;
      row(ring[first].atMs, "card_start_state", { cardKey, why: "press", pressAtMs: ring[first].pressAtMs, atMs: ring[first].atMs,
        presses: ring.length - first, state });
    }

    for (const cardKey of cardIds) {
      for (const entry of eventsOf(cardKey)) row(entry.atMs, entry.event, { cardKey, ...entry.data });
    }
    for (const task of taskRows) {
      if (taskIds.has(task.taskId) || (task.cardKey && cardIds.has(task.cardKey))) row(task.atMs, "task_data", { ...task });
    }

    return rows.map((r, order) => ({ r, order })).sort((a, b) => a.r.ts - b.r.ts || a.order - b.order).map(({ r }) => r);
  }

  return {
    toolCall,
    buildDone,
    note,
    cardEvent,
    noteContext,
    noteLookStart,
    notePress,
    taskData,
    touch,
    touched,
    reportRows,

    onScreenCard: () => (onScreen ? { id: onScreen.id, name: onScreen.name, ...(onScreen.open || {}) } : null),
    buildCount: () => builds.length,
  };
}

module.exports = { CARD_STUDIO_CATEGORY, CARD_STUDIO_PRESS_EVENT, CARD_STUDIO_LIMITS, cardStudioArgs, cardStudioValueDigest, cardStudioPressData, createCardStudioStore };
