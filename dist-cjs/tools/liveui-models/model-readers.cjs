const { GrowF32, GrowU32, MODE, forEachLine, srgbToLinear } = require("./model-doc.cjs");
const { binaryStlCount, indexOfAscii } = require("./model-sniff.cjs");
const { MODEL_CODES, ModelError } = require("./model-limits.cjs");

const decoder = new TextDecoder();

const MAX_OBJ_MATERIALS = 1024;

function unreadable(detail        , format        )             {
  return new ModelError(MODEL_CODES.unreadable, detail, format);
}

function stlClaims(b            )              {
  const binary = binaryStlCount(b);
  if (binary > 0) return { triangles: binary, points: 0, lines: 0 };
  let n = 0;
  let at = indexOfAscii(b, "endfacet");
  while (at >= 0) {
    n++;
    at = indexOfAscii(b, "endfacet", at + 8);
  }
  return { triangles: n, points: 0, lines: 0 };
}

function readStl(b            , maxTriangles = Infinity)             {
  const count = binaryStlCount(b);
  if (count > 0) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const positions = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(o + k * 4, true);
    }
    return [{ mode: MODE.triangles, positions, indices: null, color: null }];
  }
  const text = decoder.decode(b);
  const out = new GrowF32(1 << 14);
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m                        ;
  const maxFloats = maxTriangles * 9;
  while ((m = re.exec(text))) {
    out.push3(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    if (out.len > maxFloats) throw new ModelError(MODEL_CODES.tooBig, `STL has over ${maxTriangles} triangles`, "stl");
  }
  const usable = out.len - (out.len % 9);
  if (usable === 0) throw unreadable("STL has no facets", "stl");
  return [{ mode: MODE.triangles, positions: out.arr.slice(0, usable), indices: null, color: null }];
}

function objClaims(b            )              {
  const counts = { triangles: 0, points: 0, lines: 0 };
  const text = decoder.decode(b);
  forEachLine(text, (line) => {
    const c = line.charCodeAt(0);
    if ((c !== 102 && c !== 108 && c !== 112) || line.charCodeAt(1) !== 32) return;
    const n = line.trim().split(/\s+/).length - 1;
    if (c === 102) counts.triangles += Math.max(0, n - 2);
    else if (c === 108) counts.lines += Math.max(0, n - 1);
    else counts.points += n;
  });
  return counts;
}

function objMaterialLibraries(b            )           {
  const names           = [];
  forEachLine(decoder.decode(b.subarray(0, Math.min(b.length, 1 << 20))), (line) => {

    if (line.startsWith("mtllib ")) for (const name of line.slice(7).trim().split(/\s+/)) if (name && !names.includes(name)) names.push(name);
  });
  return names;
}

function readMtl(bytes                        , into                                       ) {
  if (!bytes) return;
  let current = "";
  forEachLine(decoder.decode(bytes), (raw) => {
    const line = raw.trim();
    if (line.startsWith("newmtl ")) current = line.slice(7).trim();
    else if (current && /^Kd\s/.test(line)) {
      const v = line.split(/\s+/).slice(1, 4).map(Number);
      if (v.length === 3 && v.every((x) => Number.isFinite(x))) {
        into.set(current, [srgbToLinear(v[0]), srgbToLinear(v[1]), srgbToLinear(v[2])]);
      }
    }
  });
}

function readObj(b            , resources                             = Object.create(null))             {
  const text = decoder.decode(b);
  const pos = new GrowF32(1 << 14);
  const col = new GrowF32(16);
  let hasColor = false;
  const groups = new Map                  ();
  const materials = new Map                                  ();
  let group                  = null;
  const use = (name        ) => {
    let g = groups.get(name);
    if (!g) {

      if (groups.size >= MAX_OBJ_MATERIALS && group) return group;
      g = { material: name, tris: new GrowU32(16), lines: new GrowU32(16), points: new GrowU32(16) };
      groups.set(name, g);
    }
    group = g;
    return g;
  };
  const index = (token        ) => {
    const n = parseInt(token, 10);
    const count = pos.len / 3;
    const i = n > 0 ? n - 1 : count + n;
    return Number.isFinite(i) && i >= 0 && i < count ? i : -1;
  };
  forEachLine(text, (raw) => {
    const c0 = raw.charCodeAt(0);
    if (c0 === 35 || raw.length < 2) return;
    if (c0 === 118 && raw.charCodeAt(1) === 32) {

      const t = raw.trim().split(/\s+/);
      pos.push3(+t[1], +t[2], +t[3]);
      if (t.length >= 7) {
        hasColor = true;
        while (col.len < pos.len - 3) col.push(1);
        col.push3(srgbToLinear(+t[4]), srgbToLinear(+t[5]), srgbToLinear(+t[6]));
      }
      return;
    }
    if ((c0 === 102 || c0 === 108 || c0 === 112) && raw.charCodeAt(1) === 32) {
      const g = group || use("");
      const t = raw.trim().split(/\s+/);
      const ids           = [];
      for (let k = 1; k < t.length; k++) {
        const i = index(t[k]);
        if (i >= 0) ids.push(i);
      }
      if (c0 === 102) for (let k = 1; k + 1 < ids.length; k++) g.tris.push3(ids[0], ids[k], ids[k + 1]);
      else if (c0 === 108) for (let k = 0; k + 1 < ids.length; k++) { g.lines.push(ids[k]); g.lines.push(ids[k + 1]); }
      else for (const i of ids) g.points.push(i);
      return;
    }
    if (raw.startsWith("usemtl ")) use(raw.slice(7).trim());
    else if (raw.startsWith("mtllib ")) {
      for (const name of raw.slice(7).trim().split(/\s+/)) readMtl(resources[name], materials);
    }
  });
  const positions = pos.done();
  const colors = hasColor ? (() => { while (col.len < pos.len) col.push(1); return col.done(); })() : null;

  const vertexCount = positions.length / 3;
  const stamp = new Int32Array(vertexCount).fill(-1);
  const local = new Uint32Array(vertexCount);
  const parts             = [];
  let partId = 0;
  for (const g of groups.values()) {
    for (const [mode, list] of [[MODE.triangles, g.tris], [MODE.lines, g.lines], [MODE.points, g.points]]         ) {
      if (list.len === 0) continue;
      const src = list.arr.subarray(0, list.len);
      const outPos = new GrowF32(Math.min(src.length * 3, vertexCount * 3));
      const outCol = colors ? new GrowF32(Math.min(src.length * 3, vertexCount * 3)) : null;
      const indices = new Uint32Array(src.length);
      let n = 0;
      for (let k = 0; k < src.length; k++) {
        const v = src[k];
        if (stamp[v] !== partId) {
          stamp[v] = partId;
          local[v] = n++;
          outPos.push3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
          if (outCol && colors) outCol.push3(colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2]);
        }
        indices[k] = local[v];
      }
      parts.push({
        mode,
        positions: outPos.done(),
        indices,
        color: materials.get(g.material) || null,
        colors: outCol ? outCol.done() : null,
      });
      partId++;
    }
  }
  if (parts.length === 0 && vertexCount > 0) {
    parts.push({ mode: MODE.points, positions, indices: null, color: null, colors });
  }
  return parts;
}

const PLY_SIZE                         = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

function plyHeader(b            )            {
  const end = indexOfAscii(b, "end_header", 0, Math.min(b.length, 1 << 16));
  if (end < 0) throw unreadable("PLY header has no end", "ply");
  let bodyStart = end + "end_header".length;
  if (b[bodyStart] === 13) bodyStart++;
  if (b[bodyStart] === 10) bodyStart++;
  const elements               = [];
  let format = "";
  forEachLine(decoder.decode(b.subarray(0, end)), (raw) => {
    const t = raw.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") elements.push({ name: t[1], count: Math.max(0, parseInt(t[2], 10) || 0), props: [] });
    else if (t[0] === "property" && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === "list") el.props.push({ name: t[4], type: t[3], listCount: t[2] });
      else el.props.push({ name: t[2], type: t[1] });
    }
  });
  if (!["ascii", "binary_little_endian", "binary_big_endian"].includes(format)) {
    throw unreadable(`PLY format ${format || "missing"}`, "ply");
  }
  return { format, elements, bodyStart };
}

function plyClaims(b            )              {
  const h = plyHeader(b);
  const face = h.elements.find((e) => e.name === "face");
  const vertex = h.elements.find((e) => e.name === "vertex");
  const edge = h.elements.find((e) => e.name === "edge");
  return {
    triangles: face ? face.count : 0,
    points: face || edge ? 0 : vertex ? vertex.count : 0,
    lines: edge ? edge.count : 0,
    vertices: vertex ? vertex.count : 0,
  };
}

function readPly(b            , maxTriangles = Infinity)             {
  const h = plyHeader(b);
  const ascii = h.format === "ascii";
  const little = h.format === "binary_little_endian";
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = h.bodyStart;
  const text = ascii ? decoder.decode(b.subarray(h.bodyStart)) : "";
  let tAt = 0;
  const nextToken = ()         => {
    while (tAt < text.length && text.charCodeAt(tAt) <= 32) tAt++;
    const start = tAt;
    while (tAt < text.length && text.charCodeAt(tAt) > 32) tAt++;
    if (start === tAt) throw unreadable("PLY body is cut short", "ply");
    return Number(text.slice(start, tAt));
  };
  const read = (type        )         => {
    if (ascii) return nextToken();
    const size = PLY_SIZE[type];
    if (!size || at + size > b.length) throw unreadable("PLY body is cut short", "ply");
    let v        ;
    switch (type) {
      case "char": case "int8": v = view.getInt8(at); break;
      case "uchar": case "uint8": v = view.getUint8(at); break;
      case "short": case "int16": v = view.getInt16(at, little); break;
      case "ushort": case "uint16": v = view.getUint16(at, little); break;
      case "int": case "int32": v = view.getInt32(at, little); break;
      case "uint": case "uint32": v = view.getUint32(at, little); break;
      case "float": case "float32": v = view.getFloat32(at, little); break;
      default: v = view.getFloat64(at, little); break;
    }
    at += size;
    return v;
  };
  let positions = new Float32Array(0);
  let colors                      = null;
  const tris = new GrowU32(1 << 12);
  const lines = new GrowU32(16);
  let sawFaces = false;
  for (const el of h.elements) {
    if (el.name === "vertex") {
      positions = new Float32Array(el.count * 3);
      const ix = el.props.findIndex((p) => p.name === "x");
      const iy = el.props.findIndex((p) => p.name === "y");
      const iz = el.props.findIndex((p) => p.name === "z");
      const red = el.props.findIndex((p) => p.name === "red" || p.name === "r" || p.name === "diffuse_red");
      const green = el.props.findIndex((p) => p.name === "green" || p.name === "g" || p.name === "diffuse_green");
      const blue = el.props.findIndex((p) => p.name === "blue" || p.name === "b" || p.name === "diffuse_blue");
      if (ix < 0 || iy < 0 || iz < 0) throw unreadable("PLY vertices have no x y z", "ply");
      const hasColor = red >= 0 && green >= 0 && blue >= 0;
      if (hasColor) colors = new Float32Array(el.count * 3);
      const scale = hasColor && /float|double/.test(el.props[red].type) ? 1 : 1 / 255;
      const row = new Array        (el.props.length);
      for (let i = 0; i < el.count; i++) {
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p];
          if (prop.listCount) {
            const n = read(prop.listCount);
            for (let k = 0; k < n; k++) read(prop.type);
            row[p] = 0;
          } else row[p] = read(prop.type);
        }
        positions[i * 3] = row[ix];
        positions[i * 3 + 1] = row[iy];
        positions[i * 3 + 2] = row[iz];
        if (colors) {
          colors[i * 3] = srgbToLinear(Math.min(1, row[red] * scale));
          colors[i * 3 + 1] = srgbToLinear(Math.min(1, row[green] * scale));
          colors[i * 3 + 2] = srgbToLinear(Math.min(1, row[blue] * scale));
        }
      }
    } else if (el.name === "face" || el.name === "edge") {
      const isFace = el.name === "face";
      if (isFace) sawFaces = true;
      const vertexCount = positions.length / 3;
      const ids           = [];
      for (let i = 0; i < el.count; i++) {
        let v1 = -1;
        let v2 = -1;
        for (const prop of el.props) {
          if (prop.listCount) {
            const n = read(prop.listCount);
            const wanted = prop.name === "vertex_indices" || prop.name === "vertex_index";
            ids.length = 0;
            for (let k = 0; k < n; k++) {
              const v = read(prop.type);
              if (wanted) ids.push(v);
            }
            if (wanted && isFace) {
              const inRange = (v        ) => v >= 0 && v < vertexCount;
              for (let k = 1; k + 1 < ids.length; k++) {
                if (inRange(ids[0]) && inRange(ids[k]) && inRange(ids[k + 1])) tris.push3(ids[0], ids[k], ids[k + 1]);
              }
              if (tris.len > maxTriangles * 3) throw new ModelError(MODEL_CODES.tooBig, `PLY has over ${maxTriangles} triangles`, "ply");
            }
          } else {
            const v = read(prop.type);
            if (prop.name === "vertex1") v1 = v;
            else if (prop.name === "vertex2") v2 = v;
          }
        }
        if (!isFace && v1 >= 0 && v2 >= 0 && v1 < vertexCount && v2 < vertexCount) {
          lines.push(v1);
          lines.push(v2);
        }
      }
    } else {
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (prop.listCount) {
            const n = read(prop.listCount);
            for (let k = 0; k < n; k++) read(prop.type);
          } else read(prop.type);
        }
      }
    }
  }
  const parts             = [];
  if (tris.len > 0) parts.push({ mode: MODE.triangles, positions, indices: tris.done(), color: null, colors });
  if (lines.len > 0) parts.push({ mode: MODE.lines, positions, indices: lines.done(), color: null, colors });
  if (parts.length === 0 && !sawFaces && positions.length > 0) {
    parts.push({ mode: MODE.points, positions, indices: null, color: null, colors });
  }
  return parts;
}

module.exports = { stlClaims, readStl, objClaims, objMaterialLibraries, readObj, plyClaims, readPly };
