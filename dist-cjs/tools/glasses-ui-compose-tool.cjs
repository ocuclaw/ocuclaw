const { LIVEUI_INPUT_KEY_RE, LIVEUI_INPUTS_MAX, checkLiveUiInputValue, coerceLiveUiInputValue, validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");
const { isLiveUiJsonPointer, readLiveUiJsonPointer } = require("./glasses-ui-cron.cjs");
const { refreshSchemaForToolParams } = require("./glasses-ui-refresh-schema.cjs");

const COMPOSE_GLASSES_UI_TOOL_NAME = "compose_glasses_ui";

const LIVEUI_MODEL_ROUTING_GUIDANCE =
  "Choose the mechanism that meets the request before drawing a LiveUI surface. " +
  "To the wearer, a surface is a screen and a programmable card is a card; a wearer who asks for an app means a card. " +
  "A standard surface's llm refresh generates short text on an interval; it has no tools or conversation memory. " +
  "Anything that calls a model in response to its controls, keeps a model conversation, reads MCP tools or asks Jev needs a programmable card and its respective capability and approval. " +
  "Check current tool availability and capability status. If the needed feature is off or unavailable, explain the prerequisite and ask the wearer to enable it in LiveUI settings. " +
  "Before substituting a standard surface or agent-driven updates, explain what behavior would be lost and get the wearer's agreement. " +
  "Keep a standard llm refresh when it meets the request; describe it as periodic text generation. " +
  "refresh.status=started confirms scheduling, not successful inference. If firstTick.status is pending or absent, say the first model reply is unconfirmed; report any failure and never claim generated output without a confirmed successful tick.";

const LIVEUI_PICTURE_DATA_CALL_MAX_CHARS = 262_144;

const COMPOSE_GLASSES_UI_TOOL_DESCRIPTION =
  "Paints a composed surface on the wearer's glasses from UI records, or attaches a refresh to one. Prefer writing the records inline in your reply: they paint while you write. Use this tool to attach a refresh (refresh with inputs; omit records to refresh the surface already shown), when you cannot write records inline, or with validateOnly to check records. A new surface sends its records in the same call as its refresh, and inputs sits beside refresh, not inside it. records takes exactly the inline text: the frame record first, then one record per component; a later turn's patch omits the frame record. " + LIVEUI_MODEL_ROUTING_GUIDANCE + " Picture bytes go only through this tool, as a data: URL in the image src.";

const DATA_SOURCE_RE = /\bsrc\s*=\s*(["'])(data:[^"']*)\1/gi;

function composeDataSourceChars(records        )         {
  let total = 0;
  for (const match of records.matchAll(DATA_SOURCE_RE)) total += match[2].length;
  return total;
}

const COMPOSE_RECIPE_DESCRIPTION =
  'What fills the inputs each tick. http fetches a URL; its optional jsonPath picks the part targets point into. system-stats reads this machine\'s memory and CPU: {mem_total_mb, mem_used_mb, mem_free_mb, mem_used_pct, cpu_pct, load_avg_1}, nothing else. llm: a model writes one short text each tick, with no web, tools or clock, so it cannot look up live facts; its whole text fills one text input: targets {"<key>": ""}.';

const composeRefreshSchema = {
  ...refreshSchemaForToolParams,
  properties: {
    ...refreshSchemaForToolParams.properties,
    targets: {
      type: "object",
      description: "Each input key to a JSON Pointer into the recipe output (\"\" for all of it).",
      additionalProperties: { type: "string" },
      maxProperties: 16,
    },
    recipe: {
      ...refreshSchemaForToolParams.properties.recipe,
      description: COMPOSE_RECIPE_DESCRIPTION,
    },
  },
};

const composeGlassesUiParametersSchema = {
  type: "object",
  properties: {
    records: {
      type: "string",
      description: "UI records, the same <ui …> text you would write inline.",
    },
    validateOnly: {
      type: "boolean",
      description: "Check the records and return any repairs without painting.",
    },
    refresh: composeRefreshSchema,
    inputs: {
      type: "array",
      maxItems: 16,
      description: "With refresh: each data key the recipe fills, read in formulas as data.<key>.",
      items: {
        type: "object",
        properties: {
          key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
          type: { type: "string", enum: ["number", "text", "bool", "list", "image"] },
          label: { type: "string" },
          required: { type: "boolean" },
        },
        required: ["key", "type"],
      },
    },
  },
  required: [],
};

const COMPOSE_NO_SESSION_MESSAGE =
  "compose_glasses_ui needs a chat session to paint in, and this call came with none.";

function checkComposedRefreshTargets(
  refresh     ,
  inputs                       ,
)                                                          {
  const targets = refresh && refresh.targets;
  const entries =
    targets && typeof targets === "object" && !Array.isArray(targets) ? Object.entries(targets) : [];
  if (entries.length === 0 || entries.length > LIVEUI_INPUTS_MAX) {
    return {
      ok: false,
      code: "refresh_target_invalid",
      message: 'refresh.targets maps each input key it fills to a JSON Pointer into the recipe output ("" for all of it).',
    };
  }
  const byKey = new Map(inputs.map((input) => [input.key, input]));
  for (const [key, pointer] of entries) {
    if (!byKey.has(key)) {
      return { ok: false, code: "refresh_target_unknown", message: `refresh.targets.${key} names no input; declare it in inputs.` };
    }
    if (!isLiveUiJsonPointer(pointer)) {
      return { ok: false, code: "refresh_target_invalid", message: `refresh.targets.${key} must be "" or a JSON Pointer such as "/main/temp".` };
    }
  }
  if (refresh.recipe && refresh.recipe.kind === "llm") {
    const [key, pointer] = entries[0];
    if (entries.length !== 1 || pointer !== "" || byKey.get(key)?.type !== "text") {
      return { ok: false, code: "refresh_llm_target", message: 'An llm recipe fills exactly one text input with its whole output: targets {"<key>": ""}.' };
    }
  }
  return { ok: true, targets: Object.fromEntries(entries)                           };
}

function refused(code        , message        , extra                                  = {})                         {
  return { status: "refused", code, message, ...extra };
}

const COMPOSE_FIRST_TICK_CAP_MS = 2500;

function composedFirstTickWiringFault(error        )          {
  const status = /\bgot status (\d{3})\b/.exec(error);
  if (status) {
    const code = Number(status[1]);
    return code >= 400 && code < 500 && code !== 408 && code !== 429;
  }
  return /destination blocked|missing url|invalid redirect/.test(error);
}

function composedTargetPointer(path         )          {
  if (typeof path !== "string" || path === "" || path.startsWith("/")) return path;
  let rest = path.trim();
  if (rest.startsWith("$")) rest = rest.slice(1);
  else if (rest.includes("/") && !/[.[]/.test(rest)) return `/${rest}`;
  const segments           = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === ".") {
      i += 1;
      continue;
    }
    if (rest[i] === "[") {
      const close = rest.indexOf("]", i);
      if (close < 0) return path;
      let inner = rest.slice(i + 1, close).trim();
      if (/^(['"]).*\1$/.test(inner)) inner = inner.slice(1, -1);
      if (inner === "" || inner === "*") return path;
      segments.push(inner);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < rest.length && rest[j] !== "." && rest[j] !== "[") j += 1;
    const name = rest.slice(i, j);
    if (name === "*") return path;
    segments.push(name);
    i = j;
  }
  return segments.map((segment) => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function repairComposedTargets(refresh     )                                                                     {
  const targets = refresh && refresh.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return { refresh, repairs: [] };
  const entries = Object.entries(targets);
  const llm = !!refresh.recipe && refresh.recipe.kind === "llm";
  const repairs                                          = [];
  const next                          = {};
  for (const [key, pointer] of entries) {
    let value = pointer;
    if (llm && entries.length === 1) {
      if (value !== "") repairs.push({ record: "refresh.targets", code: "llm_target_repaired" });
      value = "";
    } else if (!isLiveUiJsonPointer(value)) {
      const converted = composedTargetPointer(value);
      if (converted !== value && isLiveUiJsonPointer(converted)) {
        value = converted;
        repairs.push({ record: "refresh.targets", code: "target_pointer_repaired" });
      }
    }
    next[key] = value;
  }
  return repairs.length > 0 ? { refresh: { ...refresh, targets: next }, repairs } : { refresh, repairs };
}

function isPlainObject(value         )                                   {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function scalarInputType(value         )                                    {
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "string") return "text";
  if (typeof value === "boolean") return "bool";
  return null;
}

function inferredComposedInput(key        , value         )                             {
  const scalar = scalarInputType(value);
  if (scalar) return { key, type: scalar };
  if (!Array.isArray(value)) return null;
  const sample = value.find((entry) => entry !== null && entry !== undefined);
  if (sample === undefined) return { key, type: "list" };
  if (isPlainObject(sample)) {
    const fields                                     = {};
    for (const [name, field] of Object.entries(sample)) {
      const type = LIVEUI_INPUT_KEY_RE.test(name) ? scalarInputType(field) : null;
      if (type) fields[name] = type;
    }
    return Object.keys(fields).length > 0 ? { key, type: "list", fields } : null;
  }
  const of = scalarInputType(sample);
  return of ? { key, type: "list", of } : null;
}

function nameableFields(output         )           {
  if (!isPlainObject(output)) return [];
  return Object.keys(output).filter(
    (key) => key !== "error" && LIVEUI_INPUT_KEY_RE.test(key) && inferredComposedInput(key, output[key]) !== null,
  );
}

function composedSourceOutline(value         , maxChars = 1200)         {
  const shape = (v         , depth        )          => {
    if (v === null || v === undefined) return "null";
    if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0], depth + 1), `…${v.length} entries`];
    if (typeof v === "object") {
      if (depth >= 4) return "object";
      const keys = Object.keys(v          );
      const out                          = {};
      for (const key of keys.slice(0, 24)) out[key] = shape((v                           )[key], depth + 1);
      if (keys.length > 24) out["…"] = `${keys.length - 24} more keys`;
      return out;
    }
    return typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : "text";
  };
  const text = JSON.stringify(shape(value, 0));
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function hasTargetEntries(refresh     )          {
  return isPlainObject(refresh && refresh.targets) && Object.keys(refresh.targets).length > 0;
}

function inputsMissing(rawInputs         )          {
  return rawInputs === undefined || (Array.isArray(rawInputs) && rawInputs.length === 0);
}

function wireFromFirstTick(
  refresh     ,
  rawInputs         ,
  first                            ,
  firstError               ,
  readsWith                                                            ,
)        {
  const llm = !!refresh.recipe && refresh.recipe.kind === "llm";
  const repairs                                          = [];
  const declared = Array.isArray(rawInputs)
    ? rawInputs.filter(isPlainObject).map((input) => input.key).filter((key)                => typeof key === "string")
    : [];
  const failedNote = firstError ? ` Its first fetch failed (${firstError}).` : "";
  let targets                                = hasTargetEntries(refresh) ? { ...refresh.targets } : null;
  if (!targets) {
    if (llm) {
      const known = readsWith(declared);
      const keys = declared.length > 0 ? declared : known.complete ? known.reads : [];
      if (keys.length !== 1) {
        return { ok: false, code: "refresh_needs_targets", message: 'An llm recipe fills one text input with its whole text: targets {"<key>": ""}.' };
      }
      targets = { [keys[0]]: "" };
    } else {
      if (!first) {
        return {
          ok: false,
          code: "refresh_needs_targets",
          message: `refresh.targets maps each input key it fills to a JSON Pointer into the recipe output.${failedNote}`,
        };
      }
      const output = first.output;
      const source = composedSourceOutline(output);
      const fields = nameableFields(output);
      let keys          ;
      if (declared.length > 0) keys = declared;
      else {
        const known = readsWith(fields);
        keys = known.complete ? known.reads : [...new Set([...known.reads, ...fields])];
      }
      if (!isPlainObject(output)) {
        if (keys.length !== 1 || !scalarInputType(output)) {
          return { ok: false, code: "refresh_needs_targets", message: 'refresh.targets is empty: map the input key to "" for the whole output.', source };
        }
        targets = { [keys[0]]: "" };
      } else {
        const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(output, key));
        if (keys.length === 0 || missing.length > 0 || keys.length > LIVEUI_INPUTS_MAX) {
          const named = missing.length > 0 ? ` The first tick has no field named ${missing.join(", ")}.` : "";
          return {
            ok: false,
            code: "refresh_needs_targets",
            message: `refresh.targets is empty.${named} Map each input key to a JSON Pointer into the recipe output; source shows where its readings sit.`,
            source,
          };
        }
        targets = Object.fromEntries(keys.map((key) => [key, `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`]));
      }
    }
    repairs.push({ record: "refresh.targets", code: "targets_bound_by_name" });
  }
  let inputs                               = null;
  if (inputsMissing(rawInputs)) {
    if (llm) inputs = Object.keys(targets).map((key) => ({ key, type: "text" }));
    else if (first) {
      inputs = [];
      for (const [key, pointer] of Object.entries(targets)) {
        const read      = readLiveUiJsonPointer(first.output, pointer);
        if (!read.ok) {
          return {
            ok: false,
            code: "refresh_target_missing",
            message: `refresh.targets.${key}: the first tick has nothing at ${pointer === "" ? "the top" : `"${pointer}"`}. source shows where its readings sit.`,
            source: composedSourceOutline(first.output),
          };
        }
        const input = inferredComposedInput(key, read.value);
        if (!input) {
          return {
            ok: false,
            code: "refresh_needs_inputs",
            message: `refresh.targets.${key} first read ${valueKind(read.value)}, so its type cannot be told: declare it in inputs.`,
            source: composedSourceOutline(first.output),
          };
        }
        inputs.push(input);
      }
    }
    if (inputs) repairs.push({ record: "inputs", code: "inputs_inferred" });
  }
  return { ok: true, refresh: { ...refresh, targets }, inputs, repairs };
}

async function composeGlassesUi(
  service     ,
  sessionKey        ,
  params     ,
  opts                                                                  = {},
)                                  {
  const handler = opts.handler;
  const refresh = params ? params.refresh : undefined;
  let preparation     ;
  try {
    if (params?.validateOnly !== true && isPlainObject(refresh) && handler && typeof handler.prepareComposedRefresh === "function") {
      preparation = await handler.prepareComposedRefresh({ sessionKey, refresh, signal: opts.signal });
      if (preparation?.ok === false) return refused(preparation.code, preparation.message);
    }
    if (opts.signal?.aborted) return refused("refresh_cancelled", "Refresh preparation was cancelled; no refresh was started.");
    let firstTick                          = null;
    if (
      isPlainObject(refresh) &&
      !(params && params.validateOnly === true) &&
      handler &&
      typeof handler.probeComposedRefresh === "function" &&
      !!service &&
      typeof service.isLiveUiV2Session === "function" &&
      service.isLiveUiV2Session(sessionKey) === true
    ) {
      try {
        firstTick = await handler.probeComposedRefresh({ sessionKey, refresh });
      } catch (_) {
        firstTick = null;
      }
    }

    if (opts.signal?.aborted || preparation?.isCurrent?.() === false) return refused("refresh_cancelled", "Refresh preparation was cancelled; no refresh was started.");
    const result = runComposeGlassesUi(service, sessionKey, params, { ...opts, firstTick });
    if (refresh?.recipe?.kind === "llm" && result.refresh?.status === "started" && !result.firstTick) result.firstTick = { status: "pending" };
    return result;
  } finally {
    preparation?.release?.();
  }
}

function valueKind(value         )         {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return typeof value === "string" ? "text" : typeof value === "number" ? "a number" : typeof value;
}

function runComposeGlassesUi(
  service     ,
  sessionKey        ,
  params     ,
  opts                                                                                 = {},
)                         {
  const v2 =
    !!service && typeof service.isLiveUiV2Session === "function" && service.isLiveUiV2Session(sessionKey) === true;
  if (!v2) return refused("not_a_v2_session", COMPOSE_NO_SESSION_MESSAGE);
  const records = params && typeof params.records === "string" ? params.records : "";
  const hasRecords = records.trim() !== "";
  let refresh = params && params.refresh !== undefined && params.refresh !== null ? params.refresh : undefined;
  let rawInputs = params && params.inputs !== undefined && params.inputs !== null ? params.inputs : undefined;
  const callRepairs                                          = [];

  if (refresh && typeof refresh === "object" && !Array.isArray(refresh) && refresh.inputs !== undefined) {
    const { inputs: nested, ...rest } = refresh;
    refresh = rest;
    if (rawInputs === undefined) {
      rawInputs = nested;
      callRepairs.push({ record: "inputs", code: "inputs_moved" });
    }
  }
  if (rawInputs !== undefined && refresh === undefined) {
    return refused("inputs_need_refresh", "inputs declares the data keys a refresh fills; send it with refresh.");
  }
  if (!hasRecords && refresh === undefined) {
    return refused("records_required", "records is required: the frame record first, then one record per component.");
  }

  if (isPlainObject(refresh)) {
    const repaired = repairComposedTargets(refresh);
    refresh = repaired.refresh;
    callRepairs.push(...repaired.repairs);
  }

  if (composeDataSourceChars(records) > LIVEUI_PICTURE_DATA_CALL_MAX_CHARS) {
    return refused(
      "picture_too_large",
      `The data: sources in one call hold at most ${LIVEUI_PICTURE_DATA_CALL_MAX_CHARS} characters. Send smaller pictures, or fewer in one call.`,
    );
  }
  const validateOnly = Boolean(params && params.validateOnly === true);
  const handler = opts.handler;

  const tick = refresh !== undefined && !validateOnly && opts.firstTick ? opts.firstTick : null;
  const first = tick && tick.status === "ok" ? tick : null;
  const firstError = tick && tick.status === "failed" ? tick.error : null;
  if (tick && tick.status === "failed" && tick.wiring) {
    return refused("first_tick_refused", `The refresh's first fetch failed (${tick.error}). Check its URL and query.`);
  }

  let view     ;
  const viewFor = (keys          ) => {
    if (view === undefined) {
      view =
        typeof service.liveUiV2TopSurface === "function"
          ? service.liveUiV2TopSurface(sessionKey, { refreshKeys: keys })
          : null;
    }
    return view;
  };

  const readsWith = (keys          )                                         => {
    if (hasRecords) {
      const check =
        typeof service.composeLiveUiV2Records === "function"
          ? service.composeLiveUiV2Records(sessionKey, { records, validateOnly: true, callId: opts.callId || null, inputKeys: keys })
          : null;
      return check && Array.isArray(check.reads) ? { reads: check.reads, complete: true } : { reads: [], complete: false };
    }
    const top = viewFor(keys);
    if (!top || !top.spec) return { reads: [], complete: false };

    if (!Array.isArray(top.reads)) return { reads: [], complete: false };
    return { reads: top.reads.filter((key         )                => typeof key === "string"), complete: !top.pending };
  };

  if (refresh !== undefined && !validateOnly && isPlainObject(refresh) && (!hasTargetEntries(refresh) || inputsMissing(rawInputs))) {
    const wired = wireFromFirstTick(refresh, rawInputs, first, firstError, readsWith);
    if (!wired.ok) return refused(wired.code, wired.message, wired.source ? { source: wired.source } : {});
    refresh = wired.refresh;
    if (wired.inputs) rawInputs = wired.inputs;
    callRepairs.push(...wired.repairs);
  }
  if (refresh !== undefined && rawInputs === undefined) {
    return refused(
      "refresh_needs_inputs",
      firstError
        ? `refresh needs inputs beside it: each data key its targets fill, with its type. Its first fetch failed (${firstError}), so their types could not be read from it.`
        : "refresh needs inputs beside it: each data key its targets fill, with its type.",
    );
  }

  let inputs                        = [];
  let preflight      = null;
  if (refresh !== undefined) {
    const checkedInputs = validateLiveUiInputs(rawInputs);
    if (!checkedInputs.ok) return refused(checkedInputs.code, checkedInputs.message);
    inputs = checkedInputs.inputs;
    const checkedTargets = checkComposedRefreshTargets(refresh, inputs);
    if (!checkedTargets.ok) return refused(checkedTargets.code, checkedTargets.message);
    if (!handler || typeof handler.validateComposedRefresh !== "function" || typeof handler.attachComposedRefresh !== "function") {
      return refused("refresh_unavailable", "This host cannot run a refresh on a composed surface.");
    }
    preflight = handler.validateComposedRefresh({ sessionKey, refresh, inputs });
    if (!preflight || (preflight.ok !== true && preflight.code !== "refresh_host_consent_required")) {
      return refused(
        preflight && preflight.code ? preflight.code : "refresh_invalid_recipe",
        preflight && preflight.message ? preflight.message : "refresh failed validation",
      );
    }
  }

  let firstValues                                 = null;
  if (refresh !== undefined && first) {
    firstValues = {};
    const byKey = new Map(inputs.map((input) => [input.key, input]));
    for (const [key, pointer] of Object.entries(refresh.targets                          )) {
      const read      = readLiveUiJsonPointer(first.output, pointer);
      if (!read.ok) {
        return refused(
          "refresh_target_missing",
          `refresh.targets.${key}: the first tick has nothing at ${pointer === "" ? "the top" : `"${pointer}"`}. source shows where its readings sit.`,
          { source: composedSourceOutline(first.output) },
        );
      }
      const input = byKey.get(key)                       ;
      const checked      = checkLiveUiInputValue(input, coerceLiveUiInputValue(input, read.value));
      if (!checked.ok) {
        return refused(
          checked.code,
          `refresh.targets.${key} read ${valueKind(read.value)}, which its ${input.type} input does not take: ${checked.detail}.`,
          { source: composedSourceOutline(first.output) },
        );
      }
      firstValues[key] = checked.value;
    }
  }

  if (refresh !== undefined && !validateOnly) {
    const keys = inputs.map((input) => input.key);
    const { reads, complete } = readsWith(keys);
    if (complete && !keys.some((key) => reads.includes(key))) {
      return refused(
        "refresh_keys_unread",
        `No record reads ${keys.map((key) => `data.${key}`).join(", ")}. Send the records that show them with this refresh.`,
      );
    }
  }
  const refreshPart = ()                                  =>
    refresh === undefined ? {} : { inputs: inputs.map((input) => input.key) };
  const firstTickPart = ()                                  =>
    first ? { firstTick: { status: "ok" } } : firstError ? { firstTick: { status: "failed", error: firstError } } : {};

  if (!hasRecords) {
    const base                         = {
      status: "valid",
      repairs: callRepairs,
      drops: [],
      ...refreshPart(),
    };
    if (validateOnly) {
      base.refresh = preflight.ok
        ? { status: "valid" }
        : { status: "valid", code: preflight.code, ...(preflight.host ? { host: preflight.host } : {}) };
      return base;
    }

    const top = viewFor(inputs.map((input) => input.key));
    if (!top || typeof top.surfaceId !== "string" || !top.surfaceId) {
      return refused("no_surface", "No composed surface is showing. Send its records in the same call as the refresh.", refreshPart());
    }
    const attached = attachRefresh(service, handler, sessionKey, top.surfaceId, refresh, inputs, firstValues, first);
    return {
      ...base,
      status: attached.status === "refused" ? "refused" : "attached",
      ...(attached.status === "refused"
        ? { code: attached.code, ...(attached.message ? { message: attached.message } : {}) }
        : {}),
      surfaceId: top.surfaceId,
      ...(attached.status !== "refused" && top.pending ? { pending: top.pending } : {}),
      refresh: refreshStatus(attached),
      ...firstTickPart(),
    };
  }

  const out =
    service && typeof service.composeLiveUiV2Records === "function"
      ? service.composeLiveUiV2Records(sessionKey, {
          records,
          validateOnly,
          callId: opts.callId || null,
          ...(refresh !== undefined ? { inputs } : {}),
          ...(firstValues ? { values: firstValues } : {}),
        })
      : null;
  if (!out) return { status: "not_painted", reason: "relay_not_ready", ...refreshPart() };
  const notes = Array.isArray(out.notes) ? out.notes : [];
  const result                         = {
    status: validateOnly ? (out.ok ? "valid" : "not_painted") : out.painted ? "painted" : "not_painted",
    mode: out.mode,
    frame: out.frame ?? null,
    placed: Array.isArray(out.placed) ? out.placed : [],
    repairs: [
      ...callRepairs,
      ...notes.filter((note     ) => note.kind === "repair").map((note     ) => ({ record: note.record, code: note.code })),
    ],
    drops: notes
      .filter((note     ) => note.kind === "drop")
      .map((note     ) => ({ record: note.record, code: note.code, detail: note.detail })),
  };
  if (!validateOnly) result.surfaceId = out.surfaceId ?? null;
  if (out.reason) result.reason = out.reason;
  if (refresh === undefined) return result;
  Object.assign(result, refreshPart());
  if (validateOnly) {
    result.refresh = preflight.ok
      ? { status: "valid" }
      : { status: "valid", code: preflight.code, ...(preflight.host ? { host: preflight.host } : {}) };
    return result;
  }

  if (!out.painted || typeof out.surfaceId !== "string" || !out.surfaceId) {
    result.refresh = { status: "refused", code: "surface_not_painted" };
    return result;
  }
  result.refresh = refreshStatus(attachRefresh(service, handler, sessionKey, out.surfaceId, refresh, inputs, firstValues, first));
  Object.assign(result, firstTickPart());
  return result;
}

function attachRefresh(
  service     ,
  handler     ,
  sessionKey        ,
  surfaceId        ,
  refresh     ,
  inputs                       ,
  values                                 = null,
  first                             = null,
)                                                                     {
  if (typeof service.setLiveUiV2Inputs !== "function") {
    return { status: "refused", code: "refresh_unavailable", message: "This relay cannot hold inputs on a composed surface." };
  }

  const set = values ? service.setLiveUiV2Inputs(sessionKey, surfaceId, inputs, values) : service.setLiveUiV2Inputs(sessionKey, surfaceId, inputs);
  if (!set || set.ok !== true) {
    const code = set && typeof set.reason === "string" ? set.reason : "surface_gone";
    return { status: "refused", code, message: code === "surface_gone" ? "The surface left the glasses." : "The relay refused these inputs." };
  }

  const attached = handler.attachComposedRefresh({
    sessionKey,
    surfaceId,
    refresh,
    inputs,
    origin: "agent",
    ...(first ? { first: { output: first.output } } : {}),
  });
  return attached && typeof attached.status === "string"
    ? attached
    : { status: "refused", code: "refresh_unavailable", message: "The refresh did not start." };
}

function refreshStatus(attached                                                                    )                       {
  const status = attached.status                                  ;
  return {
    status,
    ...(attached.code ? { code: attached.code } : {}),
    ...(attached.host ? { host: attached.host } : {}),
    ...(attached.status === "held" && attached.message ? { message: attached.message } : {}),
  };
}

module.exports = { COMPOSE_GLASSES_UI_TOOL_NAME, LIVEUI_MODEL_ROUTING_GUIDANCE, LIVEUI_PICTURE_DATA_CALL_MAX_CHARS, COMPOSE_GLASSES_UI_TOOL_DESCRIPTION, composeDataSourceChars, COMPOSE_RECIPE_DESCRIPTION, composeGlassesUiParametersSchema, COMPOSE_NO_SESSION_MESSAGE, checkComposedRefreshTargets, COMPOSE_FIRST_TICK_CAP_MS, composedFirstTickWiringFault, composedTargetPointer, repairComposedTargets, inferredComposedInput, composedSourceOutline, composeGlassesUi, runComposeGlassesUi };
