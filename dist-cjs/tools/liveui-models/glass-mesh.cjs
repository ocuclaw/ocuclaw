const GLASS_MESH_MAGIC = "OCGM";
const GLASS_MESH_VERSION = 1;
const HEADER_BYTES = 56;
const PART_BYTES = 12;
const FLAG_INDEX32 = 1;
const PART_TWO_SIDED = 1;

const GLASS_PART_KIND = { triangles: 0, points: 1, lines: 2 }         ;

function pad4(n        )         {
  return (n + 3) & ~3;
}

function layout(vertices        , triangles        , points        , lines        , parts        , wide         ) {
  const ib = wide ? 4 : 2;
  const positions = HEADER_BYTES;
  const tri = pad4(positions + vertices * 6);
  const pts = pad4(tri + triangles * 3 * ib);
  const lns = pad4(pts + points * ib);
  const prt = pad4(lns + lines * 2 * ib);
  return { positions, tri, pts, lns, prt, total: prt + parts * PART_BYTES };
}

function encodeGlassMesh(input                )             {
  const { positions, triangles, points, lines, parts } = input;
  const vertices = positions.length / 3;
  const min                           = [Infinity, Infinity, Infinity];
  const max                           = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (vertices === 0) {
    min.fill(0);
    max.fill(0);
  }
  const wide = vertices >= 65536;
  const tCount = triangles.length / 3;
  const lCount = lines.length / 2;
  const at = layout(vertices, tCount, points.length, lCount, parts.length, wide);
  const out = new Uint8Array(at.total);
  const view = new DataView(out.buffer);
  for (let k = 0; k < 4; k++) out[k] = GLASS_MESH_MAGIC.charCodeAt(k);
  view.setUint16(4, GLASS_MESH_VERSION, true);
  view.setUint16(6, wide ? FLAG_INDEX32 : 0, true);
  view.setUint32(8, vertices, true);
  view.setUint32(12, tCount, true);
  view.setUint32(16, points.length, true);
  view.setUint32(20, lCount, true);
  view.setUint32(24, parts.length, true);
  for (let a = 0; a < 3; a++) {
    view.setFloat32(28 + a * 4, min[a], true);
    view.setFloat32(40 + a * 4, max[a], true);
  }
  for (let i = 0; i < vertices; i++) {
    for (let a = 0; a < 3; a++) {
      const span = max[a] - min[a];
      const q = span > 0 ? Math.round(((positions[i * 3 + a] - min[a]) / span) * 65535) : 0;
      view.setUint16(at.positions + (i * 3 + a) * 2, q, true);
    }
  }
  const putIndices = (offset        , src             ) => {
    for (let i = 0; i < src.length; i++) {
      if (src[i] >= vertices) throw new Error("glass mesh index out of range");
      if (wide) view.setUint32(offset + i * 4, src[i], true);
      else view.setUint16(offset + i * 2, src[i], true);
    }
  };
  putIndices(at.tri, triangles);
  putIndices(at.pts, points);
  putIndices(at.lns, lines);
  parts.forEach((part, n) => {
    const o = at.prt + n * PART_BYTES;
    out[o] = Math.max(0, Math.min(15, Math.round(part.grey)));
    out[o + 1] = part.twoSided ? PART_TWO_SIDED : 0;
    out[o + 2] = part.kind;
    view.setUint32(o + 4, part.start, true);
    view.setUint32(o + 8, part.count, true);
  });
  return out;
}

function decodeGlassMesh(bytes            )            {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES) throw new Error("glass mesh too short");
  for (let k = 0; k < 4; k++) {
    if (bytes[k] !== GLASS_MESH_MAGIC.charCodeAt(k)) throw new Error("not a glass mesh");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== GLASS_MESH_VERSION) throw new Error(`glass mesh version ${version}`);
  const wide = (view.getUint16(6, true) & FLAG_INDEX32) !== 0;
  const vertices = view.getUint32(8, true);
  const tCount = view.getUint32(12, true);
  const pCount = view.getUint32(16, true);
  const lCount = view.getUint32(20, true);
  const partCount = view.getUint32(24, true);
  const at = layout(vertices, tCount, pCount, lCount, partCount, wide);
  if (bytes.length !== at.total) throw new Error("glass mesh length mismatch");
  const min                           = [0, 0, 0];
  const max                           = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    min[a] = view.getFloat32(28 + a * 4, true);
    max[a] = view.getFloat32(40 + a * 4, true);
  }
  const positions = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices * 3; i++) {
    const a = i % 3;
    positions[i] = min[a] + (view.getUint16(at.positions + i * 2, true) / 65535) * (max[a] - min[a]);
  }
  const readIndices = (offset        , n        ) => {
    const arr = wide ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const v = wide ? view.getUint32(offset + i * 4, true) : view.getUint16(offset + i * 2, true);
      if (v >= vertices) throw new Error("glass mesh index out of range");
      arr[i] = v;
    }
    return arr;
  };
  const triangles = readIndices(at.tri, tCount * 3);
  const points = readIndices(at.pts, pCount);
  const lines = readIndices(at.lns, lCount * 2);
  const parts              = [];
  const limit = { 0: tCount, 1: pCount, 2: lCount }                          ;
  for (let n = 0; n < partCount; n++) {
    const o = at.prt + n * PART_BYTES;
    const kind = bytes[o + 2];
    if (!(kind in limit)) throw new Error("glass mesh part kind");
    const start = view.getUint32(o + 4, true);
    const count = view.getUint32(o + 8, true);
    if (start + count > limit[kind]) throw new Error("glass mesh part range");
    parts.push({ grey: bytes[o] & 15, twoSided: (bytes[o + 1] & PART_TWO_SIDED) !== 0, kind: kind                 , start, count });
  }
  return { version, vertexCount: vertices, positions, triangles, points, lines, parts, min, max };
}

module.exports = { GLASS_MESH_MAGIC, GLASS_MESH_VERSION, GLASS_PART_KIND, encodeGlassMesh, decodeGlassMesh };
