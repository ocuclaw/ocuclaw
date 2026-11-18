const { LIVEUI_REGISTRY } = require("../liveui-registry/index.cjs");

const { foldLiveUiLocalWrites, LIVEUI_WRITE_SINCE } = require("./record-compiler.cjs");

const { checkGlassesUiFit } = require("../glasses-ui-fit.cjs");
const { repairGlassesUiRefusal } = require("../glasses-ui-repair.cjs");
const { LIVEUI_SURFACE_TYPE } = require("../../domain/liveui-v2-client-forms.cjs");

function liveUiSurfaceMessage(envelope                       )                          {
  return {
    type: LIVEUI_SURFACE_TYPE,
    sessionKey: envelope.sessionKey,
    liveUiSessionGeneration: envelope.liveUiSessionGeneration,
    surfaceId: envelope.surfaceId,
    depth: envelope.depth,
    seq: envelope.seq,
    specRev: envelope.specRev,
    origin: envelope.origin,
    streaming: envelope.streaming,
    ...(envelope.streaming && envelope.whole ? { whole: true } : {}),
    ...(envelope.marker !== undefined ? { marker: envelope.marker } : {}),
    ...(envelope.ended ? { ended: envelope.ended } : {}),
    ...(envelope.withdrawn ? { withdrawn: true } : {}),
    ...(envelope.asked && !envelope.withdrawn ? { asked: envelope.asked } : {}),
    ...(envelope.manifest ? { manifest: envelope.manifest } : {}),
    ...(envelope.stateWrite && Object.keys(envelope.stateWrite).length > 0 ? { stateWrite: envelope.stateWrite } : {}),
    ...(envelope.seed ? { seed: envelope.seed } : {}),
    spec: envelope.spec,
  };
}

function liveUiManifestOnlyMessage(fields

 )                          {
  return {
    type: LIVEUI_SURFACE_TYPE,
    sessionKey: fields.sessionKey,
    liveUiSessionGeneration: fields.liveUiSessionGeneration,
    seq: fields.seq,
    manifest: [],
  };
}

function formulaKeys(registry                )              {
  return new Set([...registry.operators.map((o) => o.name), ...registry.roots.map((r) => r.name)]);
}

function isFormulaNode(value         , keys             )          {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === 1 && keys.has(own[0]);
}

const TEXT_CONTAINER_BYTES = 999;
const utf8 = new TextEncoder();
const graphemes                                                                  =
  typeof Intl !== "undefined" && typeof (Intl       ).Segmenter === "function"
    ? new (Intl       ).Segmenter(undefined, { granularity: "grapheme" })
    : null;

function clampLiveUiText(text        , max         = TEXT_CONTAINER_BYTES)         {
  if (utf8.encode(text).length <= max) return text;

  const mark = max >= utf8.encode("…").length + 1 ? "…" : "";
  const room = max - utf8.encode(mark).length;
  let out = "";
  let used = 0;
  const parts                   = graphemes ? [...graphemes.segment(text)].map((g) => g.segment) : Array.from(text);
  for (const part of parts) {
    const bytes = utf8.encode(part).length;
    if (used + bytes > room) break;
    out += part;
    used += bytes;
  }
  return `${out}${mark}`;
}

function plainDecimal(n        )         {
  const text = String(n);
  if (!/e/i.test(text)) return text;
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

function pointerSegments(pointer         )                  {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return null;
  return pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readData(data                                     , segments          )          {
  let at          = data;
  for (const segment of segments) {
    if (Array.isArray(at) && /^(0|[1-9][0-9]*)$/.test(segment)) at = at[Number(segment)];
    else if (at && typeof at === "object" && !Array.isArray(at) && Object.hasOwn(at, segment)) at = (at                           )[segment];
    else return undefined;
  }
  return at;
}

function bareDataText(value         , data                                     )                {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== 1 || own[0] !== "data") return null;
  const segments = pointerSegments((value                           ).data);
  if (!segments || segments.length !== 1 || !segments[0]) return null;
  const read = readData(data, segments);
  if (typeof read === "number") return Number.isFinite(read) ? plainDecimal(read) : "";
  if (typeof read === "string") return clampLiveUiText(read);
  if (typeof read === "boolean") return String(read);

  return "";
}

const LIVEUI_DATA_ROW_RE = /^row:(0|[1-9][0-9]{0,3})$/;

const LIVEUI_LIST_DATA_ROW_RE = /^(.+):row:(0|[1-9][0-9]{0,3})$/;

function liveUiDataRowRef(component        , index        , first         )         {
  return first ? `row:${index}` : `${component}:row:${index}`;
}

function liveUiDataRowLists(
  spec                          ,
  registry                 = LIVEUI_REGISTRY,
)                                             {
  const out                                             = [];
  if (!spec || !spec.regions) return out;
  const frame = registry.frames.find((f) => f.name === spec.frame);
  const drivers = frame ? frame.regions.filter((r) => r.role === "driver").map((r) => r.name) : [];
  for (const region of drivers) {
    for (const comp of spec.regions[region] ?? []) {
      const rows = comp.rows;
      if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
      const own = Object.keys(rows);
      const segments = own.length === 1 && own[0] === "data" ? pointerSegments((rows                           ).data) : null;
      if (!segments) continue;
      const list = readData(spec.data, segments.filter(Boolean));
      out.push({ component: comp.id, rows: Array.isArray(list) ? list.length : 0 });
    }
  }
  return out;
}

function liveUiDataRowList(
  spec                          ,
  registry                 = LIVEUI_REGISTRY,
)                                             {
  return liveUiDataRowLists(spec, registry)[0] ?? null;
}

function liveUiDataRowCount(spec                          , registry                 = LIVEUI_REGISTRY)         {
  return liveUiDataRowList(spec, registry)?.rows ?? 0;
}

function literalText(value         , keys             , data                          )         {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return bareDataText(value, data) ?? "";
}

function slotText(slot                         , keys             , data                          )         {
  const reading = [slot.value, slot.unit].map((v) => literalText(v, keys, data)).filter(Boolean).join(" ");
  return [slot.label, slot.text].map((v) => literalText(v, keys, data)).concat(reading).filter(Boolean).join(" ").trim();
}

function propText(value         , keys             , data                          )         {
  if (!Array.isArray(value)) return literalText(value, keys, data);
  const lines           = [];
  for (const item of value) {
    if (typeof item === "string" || typeof item === "number") {
      lines.push(String(item));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (isFormulaNode(item, keys)) {
      const bare = bareDataText(item, data);
      if (bare) lines.push(bare);
      continue;
    }
    const obj = item                           ;
    if (Array.isArray(obj.cells)) {
      lines.push(obj.cells.map((cell) => literalText(cell, keys, data)).filter(Boolean).join(" · "));
    } else if (typeof obj.label === "string" && "value" in obj) {
      const v = literalText(obj.value, keys, data);
      lines.push(v ? `${obj.label}: ${v}` : obj.label);
    } else if (typeof obj.type === "string") {
      lines.push(slotText(obj, keys, data));
    } else if (typeof obj.label === "string") {
      lines.push(obj.label);
    }
  }
  const joiner = value.length > 0 && value.every((v) => v && typeof v === "object" && typeof (v       ).type === "string") ? " · " : "\n";
  return lines.filter(Boolean).join(joiner);
}

function liveUiFallbackLine(
  comp                     ,
  registry                 = LIVEUI_REGISTRY,
  data                          ,
)         {
  const keys = formulaKeys(registry);
  const entry = registry.components.find((c) => c.name === comp.c);
  const template = entry ? entry.fallback : "";
  const line = template.replace(/\{([^}]*)\}/g, (_m, name        ) => propText(comp[name], keys, data)).trim();
  const bare = template.replace(/\{([^}]*)\}/g, "").trim();
  if (line && line !== bare) return line;
  const label = literalText(comp.label, keys, data);
  if (!label) return line;
  const value = literalText(comp.value, keys, data);
  return value ? `${label}: ${value}` : label;
}

function regionOrder(spec                   , registry                )           {
  const frame = registry.frames.find((f) => f.name === spec.frame);
  const ordered = frame ? frame.regions.map((r) => r.name) : [];
  const rest = Object.keys(spec.regions).filter((r) => !ordered.includes(r)).sort();
  return [...ordered, ...rest];
}

function liveUiFallbackText(spec                   , registry                 = LIVEUI_REGISTRY)         {
  const lines           = [];
  for (const region of regionOrder(spec, registry)) {
    for (const comp of spec.regions[region] ?? []) {
      const line = liveUiFallbackLine(comp, registry, spec.data);
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}

const FALLBACK_FIT_PASSES = 8;

function buildLiveUiFallbackSpec(
  spec                   ,
  registry                 = LIVEUI_REGISTRY,
)                          {
  const text = liveUiFallbackText(spec, registry);
  let out                          = { kind: "text_surface", body: text || "—" };
  if (typeof spec.title === "string" && spec.title.trim()) out = { kind: "text_surface", title: spec.title.trim(), body: out.body };
  for (let pass = 0; pass < FALLBACK_FIT_PASSES; pass += 1) {
    const refusal = checkGlassesUiFit(out);
    if (!refusal) break;
    const repaired = repairGlassesUiRefusal(out, refusal);
    if (!repaired || !repaired.spec) break;
    out = repaired.spec;
  }
  return out;
}

function newerComponent(name        , vocab        , registry                )                         {
  const entry = registry.components.find((c) => c.name === name);
  return entry && entry.since > vocab ? entry : null;
}

function downgradeValue(value         , vocab        , registry                , keys             )          {
  if (Array.isArray(value)) return value.map((v) => downgradeValue(v, vocab, registry, keys));
  if (!value || typeof value !== "object") return value;
  if (isFormulaNode(value, keys)) {
    const [key] = Object.keys(value);
    const op = registry.operators.find((o) => o.name === key);

    if (op && op.since > vocab) return null;
    const args = (value                           )[key];
    if (Array.isArray(args)) {
      const next = args.map((a) => downgradeValue(a, vocab, registry, keys));
      if (next.some((a, i) => a === null && args[i] !== null && typeof args[i] === "object")) return null;
      return { [key]: next };
    }
    return value;
  }
  const out                          = {};
  for (const [k, v] of Object.entries(value)) out[k] = downgradeValue(v, vocab, registry, keys);
  return out;
}

function downgradeLiveUiSpec(
  spec                   ,
  vocab        ,
  registry                 = LIVEUI_REGISTRY,
)                           {
  const frame = registry.frames.find((f) => f.name === spec.frame);
  if (frame && frame.since > vocab) return null;
  if (spec.vocab <= vocab) return spec;
  if (vocab < LIVEUI_WRITE_SINCE) spec = foldLiveUiLocalWrites(spec);
  const keys = formulaKeys(registry);
  const regions                                        = {};
  for (const [region, comps] of Object.entries(spec.regions)) {
    regions[region] = comps.map((comp) => {
      if (newerComponent(comp.c, vocab, registry)) {
        return { id: comp.id, c: "text", text: liveUiFallbackLine(comp, registry, spec.data) };
      }
      return downgradeValue(comp, vocab, registry, keys)                       ;
    });
  }
  const derive                          = {};
  for (const [name, tree] of Object.entries(spec.derive)) derive[name] = downgradeValue(tree, vocab, registry, keys);
  return { ...spec, vocab, derive: derive                               , regions };
}

function liveUiSpecMinVocab(spec                          , registry                 = LIVEUI_REGISTRY)                {
  if (!spec) return null;
  const frame = registry.frames.find((f) => f.name === spec.frame);
  return frame ? frame.since : null;
}

function buildLiveUiSurfaceForms(
  spec                          ,
  clientVocabs                   ,
  fallback                                ,
  registry                 = LIVEUI_REGISTRY,
)                     {
  const byVocab                          = {};
  if (spec) {
    for (const vocab of new Set(clientVocabs)) {
      if (!Number.isInteger(vocab) || vocab >= spec.vocab) continue;
      const older = downgradeLiveUiSpec(spec, vocab, registry);
      if (older) byVocab[String(vocab)] = older;
    }
  }
  return {
    ...(Object.keys(byVocab).length > 0 ? { byVocab } : {}),
    minVocab: liveUiSpecMinVocab(spec, registry),
    fallback,
  };
}

module.exports = { liveUiSurfaceMessage, liveUiManifestOnlyMessage, clampLiveUiText, LIVEUI_DATA_ROW_RE, LIVEUI_LIST_DATA_ROW_RE, liveUiDataRowRef, liveUiDataRowLists, liveUiDataRowList, liveUiDataRowCount, liveUiFallbackLine, liveUiFallbackText, buildLiveUiFallbackSpec, downgradeLiveUiSpec, liveUiSpecMinVocab, buildLiveUiSurfaceForms };
