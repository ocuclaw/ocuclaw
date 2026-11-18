const { GrowF32, GrowU32, MODE, determinant3, hexToLinear, linearToSrgb, multiply4 } = require("./model-doc.cjs");
const { MODEL_CODES, ModelError } = require("./model-limits.cjs");
const { findZipEntry, normalizeZipPath, readZipEntry } = require("./model-zip.cjs");

const { is3mf } = require("./model-zip.cjs");

const UNIT_MM                         = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

const MAX_DEPTH = 16;

const MAX_OBJECTS = 100_000;

const TAG = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^<>]*)>/g;
const ATTR = /(?:[\w.-]+:)?([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrs(text        )                         {
  const out                         = {};
  ATTR.lastIndex = 0;
  let m                        ;
  while ((m = ATTR.exec(text))) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function parseTransform(text                    , scale        )                  {
  if (!text) return null;
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || !v.every((x) => Number.isFinite(x))) return null;
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9] * scale, v[10] * scale, v[11] * scale, 1];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function triangleCounter(onCount                     ) {
  const re = /<(?:[A-Za-z_][\w.-]*:)?triangle(?=[\s/>])/g;
  let carry = "";
  let total = 0;
  const decoder = new TextDecoder();
  return (chunk            ) => {
    const text = carry + decoder.decode(chunk, { stream: true });
    re.lastIndex = 0;
    let last = 0;
    let m                        ;
    while ((m = re.exec(text))) {
      total++;
      last = re.lastIndex;
    }

    carry = text.slice(Math.max(last, text.length - 64));
    onCount(total);
  };
}

function parseModelPart(path        , xml        )            {
  const part            = { path, scale: 1, objects: new Map(), colorKeys: [], colors: [], build: [] };
  const colorIndex = new Map                ();
  const groups = new Map                  ();
  const colorOf = (pid                    , index                    )         => {
    if (pid === undefined) return -1;
    const group = groups.get(pid);
    if (!group) return -1;
    const k = group[index === undefined ? 0 : parseInt(index, 10) || 0];
    return k === undefined ? -1 : k;
  };
  const addColor = (hex                    )         => {
    const key = String(hex || "").toLowerCase();
    let k = colorIndex.get(key);
    if (k === undefined) {
      k = part.colorKeys.length;
      part.colorKeys.push(key);
      part.colors.push(hexToLinear(key));
      colorIndex.set(key, k);
    }
    return k;
  };
  let group                  = null;
  let object                                                                                                                                  = null;
  let inBuild = false;
  TAG.lastIndex = 0;
  let m                        ;
  while ((m = TAG.exec(xml))) {
    const closing = m[1] === "/";
    const name = m[2];
    const body = m[3];
    if (closing) {
      if (name === "object" && object) {
        const fallback = colorOf(object.pid, object.pindex);
        const tc = new Int32Array(object.c.len);
        for (let i = 0; i < tc.length; i++) tc[i] = object.c.arr[i] === 0 ? fallback : object.c.arr[i] - 1;
        part.objects.set(object.id, {
          type: object.type,
          vertices: object.v.done(),
          triangles: object.t.done(),
          triangleColor: tc,
          components: object.components,
        });
        object = null;
      } else if (name === "basematerials" || name === "colorgroup") group = null;
      else if (name === "build") inBuild = false;
      continue;
    }
    switch (name) {
      case "vertex": {
        if (!object) break;
        const a = attrs(body);
        object.v.push3(+a.x * part.scale, +a.y * part.scale, +a.z * part.scale);
        break;
      }
      case "triangle": {
        if (!object) break;
        const a = attrs(body);
        object.t.push3(+a.v1, +a.v2, +a.v3);

        const k = a.pid !== undefined || a.p1 !== undefined ? colorOf(a.pid !== undefined ? a.pid : object.pid, a.p1) : -1;
        object.c.push(k >= 0 ? k + 1 : 0);
        break;
      }
      case "model": {
        const a = attrs(body);
        part.scale = UNIT_MM[String(a.unit || "millimeter").toLowerCase()] || 1;
        break;
      }
      case "basematerials":
      case "colorgroup": {
        const a = attrs(body);
        group = [];
        if (a.id !== undefined) groups.set(a.id, group);
        if (body.trim().endsWith("/")) group = null;
        break;
      }
      case "base": {
        if (group) group.push(addColor(attrs(body).displaycolor));
        break;
      }
      case "color": {
        if (group) group.push(addColor(attrs(body).color));
        break;
      }
      case "object": {
        if (part.objects.size >= MAX_OBJECTS) throw new ModelError(MODEL_CODES.tooBig, `3MF has over ${MAX_OBJECTS} objects`, "3mf");
        const a = attrs(body);
        object = {
          id: a.id,
          type: String(a.type || "model").toLowerCase(),
          pid: a.pid,
          pindex: a.pindex,
          v: new GrowF32(16),
          t: new GrowU32(16),
          c: new GrowU32(16),
          components: [],
        };
        break;
      }
      case "component": {
        if (!object) break;
        const a = attrs(body);
        object.components.push({ objectId: a.objectid, matrix: parseTransform(a.transform, part.scale), path: a.path || null });
        break;
      }
      case "build":
        inBuild = !body.trim().endsWith("/");
        break;
      case "item": {
        if (!inBuild) break;
        const a = attrs(body);
        part.build.push({ objectId: a.objectid, matrix: parseTransform(a.transform, part.scale), path: a.path || null });
        break;
      }
      default:
        break;
    }
  }
  return part;
}

function rootPath(zip            , entries            , budget           )         {
  const rels = findZipEntry(entries, "_rels/.rels");
  if (rels) {
    const xml = new TextDecoder().decode(readZipEntry(zip, rels, budget));
    const re = /<Relationship\b[^<>]*>/g;
    let m                        ;
    while ((m = re.exec(xml))) {
      const a = attrs(m[0]);
      if (/3dmodel$/i.test(a.Type || "") && a.Target) return normalizeZipPath(a.Target);
    }
  }
  const fallback = findZipEntry(entries, "3D/3dmodel.model") || entries.find((e) => /\.model$/i.test(e.name));
  if (!fallback) throw new ModelError(MODEL_CODES.unreadable, "3MF has no model part", "3mf");
  return normalizeZipPath(fallback.name);
}

function read3mf(
  zip            ,
  entries            ,
  budget           ,
  limits                                               ,
)             {
  const { maxTriangles, maxVertices } = limits;
  const parts = new Map                   ();
  let counted = 0;
  const load = (path        )                   => {
    const key = normalizeZipPath(path);
    const cached = parts.get(key);
    if (cached) return cached;
    const entry = findZipEntry(entries, key);
    if (!entry) return null;
    const before = counted;
    const count = triangleCounter((n) => {
      if (before + n > maxTriangles) {
        throw new ModelError(MODEL_CODES.tooBig, `3MF claims over ${maxTriangles} triangles`, "3mf");
      }
      counted = before + n;
    });
    const xml = new TextDecoder().decode(readZipEntry(zip, entry, budget, count));
    const part = parseModelPart(key, xml);
    parts.set(key, part);
    return part;
  };
  const root = load(rootPath(zip, entries, budget));
  if (!root) throw new ModelError(MODEL_CODES.unreadable, "3MF model part is missing", "3mf");

  const outByGrey = new Map                                                                                ();
  const out = (color                                 ) => {
    const lum = color ? 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2] : 1;
    const grey = color ? Math.round(15 * linearToSrgb(Math.max(0, Math.min(1, lum)))) : 16;
    let o = outByGrey.get(grey);
    if (!o) {
      o = { color: color ? [lum, lum, lum] : null, pos: new GrowF32(1 << 12), idx: new GrowU32(1 << 12) };
      outByGrey.set(grey, o);
    }
    return o;
  };

  let emittedTriangles = 0;
  let emittedVertices = 0;
  const emitMesh = (part           , obj            , m          ) => {
    const v = obj.vertices;
    const nv = v.length / 3;
    emittedTriangles += obj.triangles.length / 3;
    emittedVertices += nv;
    if (emittedTriangles > maxTriangles) throw new ModelError(MODEL_CODES.tooBig, `3MF builds over ${maxTriangles} triangles`, "3mf");
    if (emittedVertices > maxVertices) throw new ModelError(MODEL_CODES.tooBig, `3MF builds over ${maxVertices} vertices`, "3mf");
    const world = new Float32Array(v.length);
    for (let i = 0; i < nv; i++) {
      const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
      world[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      world[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      world[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    const flip = determinant3(m) < 0;
    const t = obj.triangles;

    const byColor = new Map                  ();
    for (let k = 0; k < t.length / 3; k++) {
      const c = obj.triangleColor[k];
      let list = byColor.get(c);
      if (!list) byColor.set(c, (list = []));
      list.push(k);
    }
    for (const [c, list] of byColor) {
      const o = out(c >= 0 ? part.colors[c] : null);
      const local = new Map                ();
      const vertex = (i        ) => {
        let l = local.get(i);
        if (l === undefined) {
          l = o.pos.len / 3;
          o.pos.push3(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
          local.set(i, l);
        }
        return l;
      };
      for (const k of list) {
        const a = t[k * 3], b = t[k * 3 + 1], cc = t[k * 3 + 2];
        if (a >= nv || b >= nv || cc >= nv) continue;
        if (flip) o.idx.push3(vertex(a), vertex(cc), vertex(b));
        else o.idx.push3(vertex(a), vertex(b), vertex(cc));
      }
    }
  };
  const expand = (part           , objectId        , m          , depth        ) => {
    if (depth > MAX_DEPTH) return;
    const obj = part.objects.get(objectId);
    if (!obj || obj.type === "support" || obj.type === "other") return;
    if (obj.triangles.length) emitMesh(part, obj, m);
    for (const comp of obj.components) {
      const target = comp.path ? load(comp.path) : part;
      if (target) expand(target, comp.objectId, comp.matrix ? multiply4(m, comp.matrix) : m, depth + 1);
    }
  };
  let items = root.build;
  if (items.length === 0) {

    const used = new Set        ();
    for (const obj of root.objects.values()) for (const c of obj.components) if (!c.path) used.add(c.objectId);
    items = [...root.objects.keys()].filter((id) => !used.has(id)).map((id) => ({ objectId: id, matrix: null, path: null }));
  }
  for (const item of items) {
    const target = item.path ? load(item.path) : root;
    if (target) expand(target, item.objectId, item.matrix || IDENTITY, 0);
  }
  const soup             = [];
  for (const o of outByGrey.values()) {
    if (o.idx.len === 0) continue;
    soup.push({ mode: MODE.triangles, positions: o.pos.done(), indices: o.idx.done(), color: o.color });
  }
  return soup;
}

module.exports = { is3mf, read3mf };
