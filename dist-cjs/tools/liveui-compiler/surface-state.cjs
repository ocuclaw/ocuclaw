const { isWakeRefToken } = require("../glasses-ui-wake.cjs");
const { liveUiDataRowLists, liveUiDataRowRef } = require("./surface-forms.cjs");

const LIVEUI_STATE_MAX_KEYS = 128;
const LIVEUI_STATE_MAX_DERIVED = 64;
const LIVEUI_STATE_MAX_TIMERS = 16;
const LIVEUI_STATE_CACHE_SURFACES = 128;
const LIVEUI_STATE_OUTCOMES_PER_SESSION = 32;

const LIVEUI_STATE_MAX_GROWN_LISTS = 16;
const GROWN_ROWS_MAX = 20;
const GROWN_CELLS_MAX = 8;
const SESSIONS_CAP = 64;
const SURFACE_SESSIONS_CAP = 512;

const LIVEUI_STATE_FRAGMENT_MAX_BYTES = 600;
const LIVEUI_STATE_FRAGMENT_HEAD = "Glasses state the wearer set since you last read it:";
const ACTIVE_NOTE = "(values in get_glasses_ui_state)";
const PARKED_NOTE = "(read them with get_glasses_ui_state)";

const TAP_LINES_MAX_BYTES = 320;

const LIVEUI_STATE_ROWS_NOTE = "rowN counts a component's rows from 1 in the order you wrote them";
const LIVEUI_STATE_ADDED_ROWS_NOTE =
  "added_rows: the rows each list's action added on the glasses, oldest first, one value per col; text shows as its byte count";

const MORE_LINE_BYTES = 16;

const POINTER_RE = /^(?:\/[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}){1,4}$/;
const TIMER_MODES = new Set(["countdown", "elapsed"]);
const TIMER_STATUSES = new Set(["running", "paused", "idle", "done"]);
const OUTCOME_RESULTS = new Set(["action", "selected", "back", "dismissed"]);
const utf8 = new TextEncoder();
const DROP = Symbol("drop");

function plainObject(value         )                                 {
  return value && typeof value === "object" && !Array.isArray(value) ? (value                           ) : null;
}

function textBytes(value         )                         {
  const o = plainObject(value);
  if (!o) return null;
  const keys = Object.keys(o);
  if (keys.length !== 1 || keys[0] !== "text_bytes") return null;
  const n = o.text_bytes;
  return Number.isSafeInteger(n) && (n          ) >= 0 ? { text_bytes: n           } : null;
}

function stateValue(value         )                                 {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : DROP;

  if (typeof value === "string") return isWakeRefToken(value) ? value : DROP;
  return textBytes(value) ?? DROP;
}

function derivedValue(value         )                                   {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : DROP;
  const o = plainObject(value);
  if (o && Object.keys(o).length === 1 && o.present === true) return { present: true };
  return textBytes(value) ?? DROP;
}

function epochOrSpan(value         )                     {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timerValue(value         )                                  {
  const o = plainObject(value);
  if (!o || !TIMER_MODES.has(o.mode          ) || !TIMER_STATUSES.has(o.status          )) return DROP;
  const out                    = { mode: o.mode                             , status: o.status                                };
  for (const key of ["deadlineAt", "startedAt", "heldMs", "lengthMs"]         ) {
    const n = epochOrSpan(o[key]);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

function rowCell(value         )                {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return textBytes(value);
}

function grownRows(value         )                                  {
  if (!Array.isArray(value)) return DROP;
  const rows                    = [];
  for (const row of value.slice(0, GROWN_ROWS_MAX)) {
    if (!Array.isArray(row)) return DROP;
    rows.push(row.slice(0, GROWN_CELLS_MAX).map(rowCell));
  }
  return rows;
}

function focusValue(value         )                         {
  if (typeof value === "string") return isWakeRefToken(value) ? value : null;
  if (Number.isSafeInteger(value) && (value          ) >= 0) return value          ;
  return null;
}

function cutMap   (input         , keyOk                          , value                                 , cap        )                    {
  const out                    = {};
  const o = plainObject(input);
  if (!o) return out;
  let n = 0;
  for (const [key, raw] of Object.entries(o)) {
    if (n >= cap) break;
    if (key === "__proto__" || !keyOk(key)) continue;
    const v = value(raw);
    if (v === DROP) continue;
    out[key] = v     ;
    n += 1;
  }
  return out;
}

function sanitizeLiveUiStateReport(input         , surfaceId                )                           {
  const o = plainObject(input);
  if (!o) return null;
  const own = typeof o.surface === "string" ? o.surface : null;
  if (surfaceId && own !== null && own !== surfaceId) return null;
  const surface = own ?? surfaceId ?? null;
  if (!surface || !isWakeRefToken(surface)) return null;
  const rev = o.rev;
  if (!Number.isSafeInteger(rev) || (rev          ) < 1) return null;
  const rows = cutMap(o.rows, isWakeRefToken, grownRows, LIVEUI_STATE_MAX_GROWN_LISTS);
  return {
    surface,
    rev: rev          ,
    at: epochOrSpan(o.at) ?? null,
    state: cutMap(o.state, (k) => POINTER_RE.test(k), stateValue, LIVEUI_STATE_MAX_KEYS),
    derived: cutMap(o.derived, isWakeRefToken, derivedValue, LIVEUI_STATE_MAX_DERIVED),
    timers: cutMap(o.timers, isWakeRefToken, timerValue, LIVEUI_STATE_MAX_TIMERS),
    ...(Object.keys(rows).length > 0 ? { rows } : {}),
    focus: focusValue(o.focus),
  };
}

function liveUiTimerView(timer                   , at        )                          {
  const head = { mode: timer.mode };
  if (timer.status === "running" && timer.mode === "countdown" && timer.deadlineAt !== undefined) {
    const left = timer.deadlineAt - at;
    return left <= 0 ? { ...head, status: "done" } : { ...head, status: "running", remaining_ms: Math.round(left) };
  }
  if (timer.status === "running" && timer.mode === "elapsed" && timer.startedAt !== undefined) {
    return { ...head, status: "running", elapsed_ms: Math.max(0, Math.round(at - timer.startedAt)) };
  }
  if (timer.status === "paused" && timer.heldMs !== undefined) return { ...head, status: "paused", held_ms: timer.heldMs };
  if (timer.status === "idle" && timer.lengthMs !== undefined) return { ...head, status: "idle", length_ms: timer.lengthMs };
  return { ...head, status: timer.status };
}

function timersView(report                   , at        )                                          {
  const out                                          = {};
  for (const [name, timer] of Object.entries(report.timers)) out[name] = liveUiTimerView(timer, at);
  return out;
}

function tokenOf(value                                       )         {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  if ("text_bytes" in value) return `bytes:${value.text_bytes}`;
  return "present";
}

function tokensOf(report                   , at        )                      {
  const tokens = new Map                ();
  for (const [key, value] of Object.entries(report.state)) tokens.set(key, tokenOf(value));
  for (const [name, value] of Object.entries(report.derived)) tokens.set(name, tokenOf(value));
  for (const [name, timer] of Object.entries(report.timers)) tokens.set(`timer:${name}`, String(liveUiTimerView(timer, at).status));
  for (const [name, rows] of Object.entries(report.rows ?? {})) tokens.set(`rows:${name}`, String(rows.length));
  tokens.set("focus", report.focus === null ? "null" : String(report.focus));
  return tokens;
}

function byteLength(text        )         {
  return utf8.encode(text).length;
}

function liveUiRowNames(spec         )                                                             {
  const regions = plainObject(plainObject(spec)?.regions);
  if (!regions) return null;
  const out                                                      = {};
  liveUiDataRowLists(spec                     ).forEach((dataList, at) => {
    for (let i = 0; i < dataList.rows; i += 1) {
      out[liveUiDataRowRef(dataList.component, i, at === 0)] = { component: dataList.component, line: i + 1 };
    }
  });
  for (const comps of Object.values(regions)) {
    if (!Array.isArray(comps)) continue;
    for (const comp of comps) {
      const c = plainObject(comp);
      if (!c || typeof c.id !== "string" || !Array.isArray(c.rows)) continue;
      const component = c.id;
      c.rows.forEach((row, i) => {
        const ref = plainObject(row)?.ref;
        if (typeof ref === "string" && ref) out[ref] = { component, line: i + 1 };
      });
    }
  }
  return out;
}

function createLiveUiSurfaceState(options                            = {}) {
  const now = typeof options.nowMs === "function" ? options.nowMs : Date.now;
  const trace = typeof options.trace === "function" ? options.trace : () => {};
  const authoredState = typeof options.authoredState === "function" ? options.authoredState : () => null;
  const onShown = typeof options.onShown === "function" ? options.onShown : () => {};
  const rowRefs = typeof options.rowRefs === "function" ? options.rowRefs : () => null;

  const rowNames = new Map                             ();

  const cache = new Map                ();
  const surfaceSession = new Map                ();
  const outcomes = new Map                               ();
  const seen = new Map              ();

  const announced = new Map                ();

  const lined = new Map                     ();
  let eventCounter = 0;

  function sessionOf(surfaceId        )                {
    return surfaceSession.get(surfaceId) ?? null;
  }

  function namesOf(surfaceId        )                      {
    let names = rowNames.get(surfaceId);
    const sessionKey = sessionOf(surfaceId);
    const live = sessionKey ? rowRefs(sessionKey, surfaceId) : null;
    if (live) {
      if (!names) {
        names = new Map();
        rowNames.set(surfaceId, names);
        while (rowNames.size > LIVEUI_STATE_CACHE_SURFACES) rowNames.delete(rowNames.keys().next().value          );
      }
      for (const [ref, row] of Object.entries(live)) names.set(ref, `${row.component}/row${row.line}`);
    }
    return names ?? new Map();
  }

  function modelRef(names                     , ref                        )                         {
    return typeof ref === "string" ? names.get(ref) ?? ref : ref;
  }

  function modelKey(names                     , key        )         {
    const m = /^\/([^/]+)\/([^/]+)$/.exec(key);
    const name = m ? names.get(m[2]) : undefined;
    return name && name.startsWith(`${m [1]}/`) ? `/${name}` : key;
  }

  function modelState(names                     , state                                  )                                   {
    const out                                   = {};
    for (const [key, value] of Object.entries(state)) out[modelKey(names, key)] = value;
    return out;
  }

  function namesRows(names                     , report                   )          {
    if (typeof report.focus === "string" && names.has(report.focus)) return true;
    return Object.keys(report.state).some((key) => modelKey(names, key) !== key);
  }

  function baseline(report                   )                      {
    const tokens = tokensOf(report, now());
    const sessionKey = sessionOf(report.surface);
    const authored = sessionKey ? authoredState(sessionKey, report.surface) : null;
    if (authored) {
      for (const [name, value] of Object.entries(authored)) {
        const key = `/${name}`;
        if (tokens.has(key)) tokens.set(key, String(value));
      }
    }
    return tokens;
  }

  function show(surfaceId        , report                   , keys                  )       {
    const sessionKey = sessionOf(surfaceId);
    if (!sessionKey) return;
    for (const key of keys) {
      const value = report.state[key];

      if ((typeof value === "number" || typeof value === "string") && /^\/[^/]+$/.test(key)) {
        onShown(sessionKey, surfaceId, key.slice(1), value);
      }
    }
  }

  function markSeen(surfaceId        )                {
    const hit = cache.get(surfaceId);
    if (!hit) return null;
    seen.set(surfaceId, { rev: hit.report.rev, tokens: tokensOf(hit.report, now()) });
    show(surfaceId, hit.report, Object.keys(hit.report.state));
    return hit.report.rev;
  }

  function reportBody(report                   , at        )                          {
    const names = namesOf(report.surface);
    return {
      rev: report.rev,
      state: modelState(names, report.state),
      derived: { ...report.derived },
      timers: timersView(report, at),
      ...(report.rows ? { added_rows: report.rows, added_rows_note: LIVEUI_STATE_ADDED_ROWS_NOTE } : {}),
      focus: modelRef(names, report.focus),
      ...(namesRows(names, report) ? { rows_note: LIVEUI_STATE_ROWS_NOTE } : {}),
    };
  }

  function stateBlock(surfaceId        , opts                         = {})                          {
    const hit = cache.get(surfaceId);
    if (hit) {
      const at = now();
      return { surface: surfaceId, ...reportBody(hit.report, at), age_ms: Math.max(0, at - hit.receivedAt) };
    }
    if (opts.fallback) return { surface: surfaceId, fallback: true };
    return { surface: surfaceId, report: null };
  }

  return {

    noteSurface(sessionKey        , surfaceId        )       {
      if (typeof sessionKey !== "string" || typeof surfaceId !== "string") return;
      surfaceSession.delete(surfaceId);
      surfaceSession.set(surfaceId, sessionKey);
      while (surfaceSession.size > SURFACE_SESSIONS_CAP) surfaceSession.delete(surfaceSession.keys().next().value          );
    },

    sessionOf,

    knows(surfaceId         )          {
      return typeof surfaceId === "string" && surfaceSession.has(surfaceId);
    },

    accept(report                   )                                                                         {
      const prev = cache.get(report.surface);
      const cachedRev = prev ? prev.report.rev : null;
      if (prev && report.rev <= prev.report.rev) return { accepted: false, reason: "stale_rev", cachedRev };
      cache.delete(report.surface);
      cache.set(report.surface, { report, receivedAt: now() });

      if (!seen.has(report.surface)) seen.set(report.surface, { rev: 0, tokens: baseline(report) });
      while (cache.size > LIVEUI_STATE_CACHE_SURFACES) {
        const oldest = cache.keys().next().value          ;
        cache.delete(oldest);
        seen.delete(oldest);
      }
      return { accepted: true, reason: null, cachedRev };
    },

    cached(surfaceId        )                                                           {
      const hit = cache.get(surfaceId);
      return hit ? { report: hit.report, receivedAt: hit.receivedAt } : null;
    },

    latestSurfaceOf(sessionKey        )                {
      let latest                = null;
      for (const surfaceId of cache.keys()) if (surfaceSession.get(surfaceId) === sessionKey) latest = surfaceId;
      return latest;
    },

    park(input                                                   )                      {
      const entry                      = { ...input, eventId: ++eventCounter, parkedAt: now() };
      let list = outcomes.get(input.sessionKey);
      if (!list) {
        list = [];
        outcomes.set(input.sessionKey, list);
        while (outcomes.size > SESSIONS_CAP) outcomes.delete(outcomes.keys().next().value          );
      }
      list.push(entry);
      if (list.length > LIVEUI_STATE_OUTCOMES_PER_SESSION) {
        const evicted = list.splice(0, list.length - LIVEUI_STATE_OUTCOMES_PER_SESSION);
        trace("liveui_v2_outcome_evicted", { sessionKey: input.sessionKey, evicted: evicted.length });
      }
      return entry;
    },

    pendingOutcomes(sessionKey        )         {
      return outcomes.get(sessionKey)?.length ?? 0;
    },

    stateBlock,

    collect(sessionKey        , activeSurface               , opts                         = {})

      {
      const state = activeSurface ? stateBlock(activeSurface, opts) : null;
      if (activeSurface) markSeen(activeSurface);
      const at = now();
      const taken = outcomes.get(sessionKey) ?? [];
      outcomes.delete(sessionKey);
      lined.delete(sessionKey);
      return {
        state,
        outcomes: taken.map((entry) => {
          const later = cache.get(entry.surface);
          const laterRev = later && entry.report && later.report.rev > entry.report.rev ? later.report.rev : null;
          const row = entry.row !== undefined ? modelRef(namesOf(entry.surface), entry.row) : undefined;
          return {
            surface: entry.surface,
            result: entry.result,
            ...(entry.action !== undefined ? { action: entry.action } : {}),
            ...(row !== undefined ? { row, selected_index: entry.selectedIndex ?? null } : {}),
            ...(entry.removed ? { removed: true } : {}),
            report: entry.report ? reportBody(entry.report, entry.report.at ?? entry.parkedAt) : null,

            ...(laterRev !== null ? { later_rev: laterRev } : {}),
            age_ms: Math.max(0, at - entry.parkedAt),
          };
        }),
      };
    },

    markSeen,

    takeFragment(sessionKey        , activeSurface               )

             {
      const at = now();
      const rows                                                                                                        = [];
      for (const [surfaceId, hit] of cache) {
        if (surfaceSession.get(surfaceId) !== sessionKey) continue;
        const last = seen.get(surfaceId);
        if (last && hit.report.rev <= last.rev) continue;
        const tokens = tokensOf(hit.report, at);
        const changed = [...tokens.keys()].filter((key) => !last || last.tokens.get(key) !== tokens.get(key));
        if (changed.length === 0) {
          seen.set(surfaceId, { rev: hit.report.rev, tokens });
          continue;
        }
        rows.push({ surface: surfaceId, report: hit.report, tokens, changed });
      }
      const pending = outcomes.get(sessionKey) ?? [];
      const unnamed = pending.filter((entry) => entry.eventId > (announced.get(sessionKey) ?? 0));
      if (rows.length === 0 && unnamed.length === 0) return null;

      const tail = (surfaceId        ) => (surfaceId === activeSurface ? ` ${ACTIVE_NOTE}` : "");

      const named = rows.map((r) => namesOf(r.surface));
      const pair = (r                       , names                     , key        ) => {
        if (key !== "focus") return `${modelKey(names, key)}=${r.tokens.get(key)}`;
        return `focus=${r.report.focus === null ? "null" : String(modelRef(names, r.report.focus))}`;
      };
      const full = rows.map(
        (r, i) => `${r.surface} rev=${r.report.rev} ${r.changed.map((key) => pair(r, named[i], key)).join(" ")}${tail(r.surface)}`,
      );
      const capped = rows.map((r) => `${r.surface} rev=${r.report.rev} changed=${r.changed.length}${tail(r.surface)}`);

      let tapNamesARow = false;
      const tapLine = (entry                     ) => {
        const names = namesOf(entry.surface);

        const ref =
          entry.action !== undefined
            ? `action=${entry.action}${entry.row !== undefined ? ` row=${String(modelRef(names, entry.row))}` : ""}`
            : entry.row !== undefined
              ? `row=${String(modelRef(names, entry.row))}`
              : entry.result;
        if (entry.row !== undefined && names.has(entry.row)) tapNamesARow = true;
        const values = entry.report
          ? [...tokensOf(entry.report, at)]
              .filter(([key]) => key !== "focus")
              .map(([key, value]) => {
                if (modelKey(names, key) !== key) tapNamesARow = true;
                return `${modelKey(names, key)}=${value}`;
              })
          : [];

        const rev = entry.report ? ` rev=${entry.report.rev}` : "";
        const removed = entry.removed ? " removed=true" : "";
        return `tap ${entry.surface}${rev} ${ref}${removed}${values.length > 0 ? ` values ${values.join(" ")}` : ""}`;
      };
      const tapLines = unnamed.map(tapLine);
      const tapsFit = tapLines.reduce((sum, line) => sum + byteLength(line) + 1, 0) <= TAP_LINES_MAX_BYTES;
      if (!tapsFit) tapNamesARow = false;
      const parkedLines =
        unnamed.length === 0 ? [] : tapsFit ? tapLines : [`parked taps=${unnamed.length} ${PARKED_NOTE}`];
      const namesARow = (r                       , names                     ) =>
        r.changed.some((key) =>
          key === "focus" ? typeof r.report.focus === "string" && names.has(r.report.focus) : modelKey(names, key) !== key,
        );
      const rowsHead = tapNamesARow || rows.some((r, i) => namesARow(r, named[i])) ? ` (${LIVEUI_STATE_ROWS_NOTE})` : "";
      const head = `${LIVEUI_STATE_FRAGMENT_HEAD}${rowsHead}`;
      const lines           = [];

      const withValues            = [];
      let used = byteLength(head) + parkedLines.reduce((sum, line) => sum + byteLength(line) + 1, 0);

      const cappedBytes = capped.map((line) => byteLength(line) + 1);
      let restCapped = cappedBytes.reduce((sum, n) => sum + n, 0);
      for (let i = 0; i < rows.length; i += 1) {
        restCapped -= cappedBytes[i];
        const fullBytes = byteLength(full[i]) + 1;
        if (used + fullBytes + restCapped <= LIVEUI_STATE_FRAGMENT_MAX_BYTES) {
          lines.push(full[i]);
          withValues.push(true);
          used += fullBytes;
        } else if (used + cappedBytes[i] + (i < rows.length - 1 ? MORE_LINE_BYTES : 0) <= LIVEUI_STATE_FRAGMENT_MAX_BYTES) {
          lines.push(capped[i]);
          withValues.push(false);
          used += cappedBytes[i];
        } else {
          lines.push(`and ${rows.length - i} more`);
          break;
        }
      }
      lines.push(...parkedLines);
      const text = [head, ...lines].join("\n");

      if (tapsFit) {
        for (const entry of unnamed) if (entry.report) show(entry.surface, entry.report, Object.keys(entry.report.state));
      }

      const surfaces                                                                            = [];
      withValues.forEach((values, i) => {
        const r = rows[i];
        seen.set(r.surface, { rev: r.report.rev, tokens: r.tokens });
        if (values) show(r.surface, r.report, r.changed.filter((key) => key.startsWith("/")));
        surfaces.push({ surface: r.surface, rev: r.report.rev, changed: r.changed.length, values });
      });
      if (unnamed.length > 0) announced.set(sessionKey, unnamed[unnamed.length - 1].eventId);

      if (tapsFit && unnamed.length > 0) {
        const ids = lined.get(sessionKey) ?? new Set        ();
        for (const entry of unnamed) ids.add(entry.eventId);
        lined.set(sessionKey, ids);
        while (lined.size > SESSIONS_CAP) lined.delete(lined.keys().next().value          );
      }
      return { text, bytes: byteLength(text), surfaces, parked: unnamed.length, tapLines: tapsFit ? unnamed.length : 0 };
    },

    endTurn(sessionKey        )         {
      const ids = lined.get(sessionKey);
      if (!ids) return 0;
      lined.delete(sessionKey);
      const pending = outcomes.get(sessionKey) ?? [];
      const left = pending.filter((entry) => !ids.has(entry.eventId));
      if (left.length > 0) outcomes.set(sessionKey, left);
      else outcomes.delete(sessionKey);
      return pending.length - left.length;
    },

    tapOwed(sessionKey        , eventId        )          {
      if (lined.get(sessionKey)?.has(eventId)) return false;
      return (outcomes.get(sessionKey) ?? []).some((entry) => entry.eventId === eventId);
    },
  };
}

function isLiveUiParkedResult(result         )                                          {
  return typeof result === "string" && OUTCOME_RESULTS.has(result);
}

module.exports = { LIVEUI_STATE_MAX_KEYS, LIVEUI_STATE_MAX_DERIVED, LIVEUI_STATE_MAX_TIMERS, LIVEUI_STATE_CACHE_SURFACES, LIVEUI_STATE_OUTCOMES_PER_SESSION, LIVEUI_STATE_MAX_GROWN_LISTS, LIVEUI_STATE_FRAGMENT_MAX_BYTES, LIVEUI_STATE_FRAGMENT_HEAD, LIVEUI_STATE_ROWS_NOTE, LIVEUI_STATE_ADDED_ROWS_NOTE, sanitizeLiveUiStateReport, liveUiTimerView, liveUiRowNames, createLiveUiSurfaceState, isLiveUiParkedResult };
