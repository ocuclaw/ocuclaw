const { GrowF32, GrowU32, MODE, determinant3, linearToSrgb, multiply4 } = require("./model-doc.cjs");
const { MODEL_CODES, ModelError } = require("./model-limits.cjs");
const { GLASS_PART_KIND } = require("./glass-mesh.cjs");

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function floatsOf(acc     )               {
  const arr = acc.getArray();
  if (!arr) return new Float32Array(0);
  if (arr instanceof Float32Array) return arr;
  const out = new Float32Array(arr.length);
  if (!acc.getNormalized()) {
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
    return out;
  }
  let div = 1;
  let signed = false;
  if (arr instanceof Int8Array) { div = 127; signed = true; }
  else if (arr instanceof Uint8Array) div = 255;
  else if (arr instanceof Int16Array) { div = 32767; signed = true; }
  else if (arr instanceof Uint16Array) div = 65535;
  else if (arr instanceof Uint32Array) div = 4294967295;
  for (let i = 0; i < arr.length; i++) out[i] = signed ? Math.max(arr[i] / div, -1) : arr[i] / div;
  return out;
}

function trsMatrix(t                          , r                          , s                          )           {
  const [x, y, z, w] = r ? [r[0], r[1], r[2], r[3]] : [0, 0, 0, 1];
  const [sx, sy, sz] = s ? [s[0], s[1], s[2]] : [1, 1, 1];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    t ? t[0] : 0, t ? t[1] : 0, t ? t[2] : 0, 1,
  ];
}

function greyOf(material     , colors                     , colorSize        )         {
  const f = material ? material.getBaseColorFactor() : [1, 1, 1, 1];
  let r = f[0], g = f[1], b = f[2];
  if (colors && colors.length >= colorSize) {
    const n = colors.length / colorSize;
    const step = Math.max(1, Math.floor(n / 50_000));
    let sr = 0, sg = 0, sb = 0, k = 0;
    for (let i = 0; i < n; i += step, k++) {
      sr += colors[i * colorSize];
      sg += colors[i * colorSize + 1];
      sb += colors[i * colorSize + 2];
    }
    if (k > 0) { r *= sr / k; g *= sg / k; b *= sb / k; }
  }
  let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 0.02 && material) {
    const e = material.getEmissiveFactor();
    lum = Math.max(lum, 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2]);
  }
  return Math.round(15 * linearToSrgb(Math.max(0, Math.min(1, lum))));
}

function transformInto(src              , m          )               {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

function skinned(prim     , skin     , local              )                      {
  const jointsAcc = prim.getAttribute("JOINTS_0");
  const weightsAcc = prim.getAttribute("WEIGHTS_0");
  if (!jointsAcc || !weightsAcc) return null;
  const joints = skin.listJoints();
  const ibmAcc = skin.getInverseBindMatrices();
  const ibm = ibmAcc ? floatsOf(ibmAcc) : null;
  const mats = joints.map((joint     , j        ) => {
    const inv = ibm && ibm.length >= (j + 1) * 16 ? Array.from(ibm.subarray(j * 16, j * 16 + 16)) : IDENTITY;
    return multiply4(joint.getWorldMatrix(), inv);
  });
  const J = jointsAcc.getArray();
  const W = floatsOf(weightsAcc);
  const n = local.length / 3;
  const out = new Float32Array(local.length);
  for (let i = 0; i < n; i++) {
    const x = local[i * 3], y = local[i * 3 + 1], z = local[i * 3 + 2];
    let ox = 0, oy = 0, oz = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const w = W[i * 4 + k];
      if (!w) continue;
      const m = mats[J[i * 4 + k]];
      if (!m) continue;
      ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      wsum += w;
    }
    if (wsum > 0) { out[i * 3] = ox / wsum; out[i * 3 + 1] = oy / wsum; out[i * 3 + 2] = oz / wsum; }
    else { out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z; }
  }
  return out;
}

class Collector {
  accs = new Map             ();
  triangles = 0;
  points = 0;
  lines = 0;
  vertices = 0;
  limits                ;
  constructor(limits                ) {
    this.limits = limits;
  }

  reserveVertices(n        ) {
    this.vertices += n;
    if (this.vertices > this.limits.maxVertices) throw this.tooBig(`${this.limits.maxVertices} vertices`);
  }
  acc(kind               , grey        , twoSided         )      {
    const key = `${kind}:${grey}:${twoSided ? 1 : 0}`;
    let a = this.accs.get(key);
    if (!a) {
      a = { kind, grey, twoSided, pos: new GrowF32(1 << 12), idx: new GrowU32(1 << 12) };
      this.accs.set(key, a);
    }
    return a;
  }
  tooBig(what        ) {
    return new ModelError(MODEL_CODES.tooBig, `model has over ${what}`);
  }
  add(prim     , world              , flip         , grey        , doubleSided         ) {
    const n = world.length / 3;
    if (n === 0) return;
    const idxAcc = prim.getIndices();
    const raw                           = idxAcc ? idxAcc.getArray() : null;
    const count = raw ? raw.length : n;
    const at = (i        ) => (raw ? raw[i] : i);
    const mode = prim.getMode();
    const list = new GrowU32(Math.max(16, count));
    let kind                = GLASS_PART_KIND.triangles;
    if (mode === MODE.triangles) {
      for (let i = 0; i + 2 < count; i += 3) {
        if (flip) list.push3(at(i), at(i + 2), at(i + 1));
        else list.push3(at(i), at(i + 1), at(i + 2));
      }
    } else if (mode === MODE.strip) {
      for (let i = 0; i + 2 < count; i++) {
        const even = (i & 1) === 0 ? !flip : flip;
        if (even) list.push3(at(i), at(i + 1), at(i + 2));
        else list.push3(at(i + 1), at(i), at(i + 2));
      }
    } else if (mode === MODE.fan) {
      for (let i = 1; i + 1 < count; i++) {
        if (flip) list.push3(at(0), at(i + 1), at(i));
        else list.push3(at(0), at(i), at(i + 1));
      }
    } else if (mode === MODE.points) {
      kind = GLASS_PART_KIND.points;
      for (let i = 0; i < count; i++) list.push(at(i));
    } else {
      kind = GLASS_PART_KIND.lines;
      if (mode === MODE.lines) for (let i = 0; i + 1 < count; i += 2) { list.push(at(i)); list.push(at(i + 1)); }
      else {
        for (let i = 0; i + 1 < count; i++) { list.push(at(i)); list.push(at(i + 1)); }
        if (mode === MODE.lineLoop && count > 2) { list.push(at(count - 1)); list.push(at(0)); }
      }
    }
    if (kind === GLASS_PART_KIND.triangles) {
      this.triangles += list.len / 3;
      if (this.triangles > this.limits.maxTriangles) throw this.tooBig(`${this.limits.maxTriangles} triangles`);
    } else if (kind === GLASS_PART_KIND.points) {
      this.points += list.len;
      if (this.points > this.limits.maxPoints) throw this.tooBig(`${this.limits.maxPoints} points`);
    } else {
      this.lines += list.len / 2;
      if (this.lines > this.limits.maxLines) throw this.tooBig(`${this.limits.maxLines} lines`);
    }
    if (list.len === 0) return;
    const a = this.acc(kind, grey, doubleSided);
    const base = a.pos.len / 3;
    for (let i = 0; i < world.length; i += 3) a.pos.push3(world[i], world[i + 1], world[i + 2]);
    for (let i = 0; i < list.len; i++) {
      const v = list.arr[i];
      if (v >= n) throw new ModelError(MODEL_CODES.unreadable, "index out of range");
      a.idx.push(base + v);
    }
  }
}

function collect(doc     , limits                )            {
  const out = new Collector(limits);
  const root = doc.getRoot();
  const visitMesh = (node     , mesh     , matrices            ) => {
    const skin = node ? node.getSkin() : null;
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute("POSITION");
      if (!posAcc) continue;
      const local = floatsOf(posAcc);
      const material = prim.getMaterial();
      const colorAcc = prim.getAttribute("COLOR_0");
      const grey = greyOf(material, colorAcc ? floatsOf(colorAcc) : null, colorAcc ? colorAcc.getElementSize() : 3);
      const doubleSided = material ? Boolean(material.getDoubleSided()) : false;
      const rest = skin ? skinned(prim, skin, local) : null;
      if (rest) {
        out.reserveVertices(local.length / 3);
        out.add(prim, rest, false, grey, doubleSided);
        continue;
      }
      out.reserveVertices((local.length / 3) * matrices.length);
      for (const m of matrices) out.add(prim, transformInto(local, m), determinant3(m) < 0, grey, doubleSided);
    }
  };
  const visitNode = (node     ) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const world = node.getWorldMatrix();
    const inst = node.getExtension("EXT_mesh_gpu_instancing");
    let matrices = [world];
    if (inst) {
      const t = inst.getAttribute("TRANSLATION");
      const r = inst.getAttribute("ROTATION");
      const s = inst.getAttribute("SCALE");

      const counts = [t, r, s].filter(Boolean).map((a     ) => a.getCount());
      const count = counts.length ? Math.min(...counts) : 0;
      if (count > 0) {
        const tv = t ? floatsOf(t) : null, rv = r ? floatsOf(r) : null, sv = s ? floatsOf(s) : null;
        matrices = [];
        for (let i = 0; i < count; i++) {
          matrices.push(multiply4(world, trsMatrix(
            tv ? tv.subarray(i * 3, i * 3 + 3) : null,
            rv ? rv.subarray(i * 4, i * 4 + 4) : null,
            sv ? sv.subarray(i * 3, i * 3 + 3) : null,
          )));
        }
      }
    }
    visitMesh(node, mesh, matrices);
  };
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (scene) scene.traverse(visitNode);
  if (out.accs.size === 0) {

    for (const node of root.listNodes()) if (!node.getParentNode()) node.traverse(visitNode);
    if (out.accs.size === 0) for (const mesh of root.listMeshes()) visitMesh(null, mesh, [IDENTITY]);
  }
  return out;
}

const ROTATE                                = {
  "+y": null,
  "+z": (x, y, z, o, i) => { o[i] = x; o[i + 1] = z; o[i + 2] = -y; },
  "+x": (x, y, z, o, i) => { o[i] = -y; o[i + 1] = x; o[i + 2] = z; },
};

function guessUp(accs       )         {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const a of accs) {
    const p = a.pos.arr;
    for (let i = 0; i < a.pos.len; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    }
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const near = extent * 0.01;
  const base = [0, 0, 0];
  let total = 0;
  const cos = Math.cos((10 * Math.PI) / 180);
  for (const a of accs) {
    const p = a.pos.arr;
    const idx = a.idx.arr;
    for (let t = 0; t + 2 < a.idx.len; t += 3) {
      const i = idx[t] * 3, j = idx[t + 1] * 3, k = idx[t + 2] * 3;
      const ux = p[j] - p[i], uy = p[j + 1] - p[i + 1], uz = p[j + 2] - p[i + 2];
      const vx = p[k] - p[i], vy = p[k + 1] - p[i + 1], vz = p[k + 2] - p[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len === 0) continue;
      total += len;
      const n = [nx / len, ny / len, nz / len];
      for (let axis = 0; axis < 3; axis++) {
        if (Math.abs(n[axis]) < cos) continue;
        const c = (p[i + axis] + p[j + axis] + p[k + axis]) / 3;
        if (c - min[axis] <= near) base[axis] += len;
      }
    }
  }
  const best = base.indexOf(Math.max(...base));
  if (total === 0 || base[best] < total * 0.03 || best === 1 || base[1] >= base[best] * 0.8) return "+y";

  return best === 0 ? "+x" : "+z";
}

function weld(simplifier     , pos              , idx             )                                          {
  const remap              = simplifier.generatePositionRemap(pos, 3);
  const keep = new GrowU32(idx.length);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    keep.push3(a, b, c);
  }
  return compact(pos, keep.done());
}

function compact(pos              , idx             )                                          {
  const map = new Int32Array(pos.length / 3).fill(-1);
  const out = new GrowF32(Math.min(pos.length, idx.length * 3));
  const outIdx = new Uint32Array(idx.length);
  let n = 0;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (map[v] < 0) {
      map[v] = n++;
      out.push3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    }
    outIdx[i] = map[v];
  }
  return { pos: out.done(), idx: outIdx };
}

function isClosed(idx             , vertexCount        )          {
  if (idx.length === 0) return false;
  const edges = new Map                ();
  const key = (a        , b        ) => a * vertexCount + b;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = key(idx[t + e], idx[t + ((e + 1) % 3)]);
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let matched = 0;
  for (const [k, n] of edges) {
    const a = Math.floor(k / vertexCount), b = k % vertexCount;
    if (n === 1 && edges.get(key(b, a)) === 1) matched++;
  }
  return matched >= edges.size * 0.98;
}

function openness(pos              , idx             )         {
  let vx = 0, vy = 0, vz = 0, area = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    vx += nx; vy += ny; vz += nz;
    area += Math.hypot(nx, ny, nz);
  }
  return area > 0 ? Math.hypot(vx, vy, vz) / area : 1;
}

function pieces(idx             , vertexCount        )                                       {
  const parent = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) parent[v] = v;
  const find = (v        ) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = find(idx[t]);
    for (let e = 1; e < 3; e++) {
      const b = find(idx[t + e]);
      if (b !== a) parent[b] = a;
    }
  }
  const tris = Math.floor(idx.length / 3);
  const ids = new Map                ();
  const pieceOf = new Int32Array(tris);
  const counts           = [];
  for (let t = 0; t < tris; t++) {
    const root = find(idx[t * 3]);
    let k = ids.get(root);
    if (k === undefined) {
      k = counts.length;
      ids.set(root, k);
      counts.push(0);
    }
    pieceOf[t] = k;
    counts[k]++;
  }
  const runs = [0];
  for (const c of counts) runs.push(runs[runs.length - 1] + c);
  const fill = runs.slice(0, -1);
  const out = new Uint32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const at = fill[pieceOf[t]]++ * 3;
    out[at] = idx[t * 3];
    out[at + 1] = idx[t * 3 + 1];
    out[at + 2] = idx[t * 3 + 2];
  }
  return { idx: out, runs };
}

function signedVolume(pos              , idx             )         {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < idx.length; i++) { cx += pos[idx[i] * 3]; cy += pos[idx[i] * 3 + 1]; cz += pos[idx[i] * 3 + 2]; }
  const n = idx.length || 1;
  cx /= n; cy /= n; cz /= n;
  let v = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a] - cx, ay = pos[a + 1] - cy, az = pos[a + 2] - cz;
    const bx = pos[b] - cx, by = pos[b + 1] - cy, bz = pos[b + 2] - cz;
    const qx = pos[c] - cx, qy = pos[c + 1] - cy, qz = pos[c + 2] - cz;
    v += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
  }
  return v / 6;
}

const CLOSED_OPENNESS = 0.1;

function simplifyTriangles(simplifier     , a     , target        )            {
  let { pos, idx } = weld(simplifier, a.pos.done(), a.idx.done());
  const tris = idx.length / 3;
  if (tris > target) {
    const [out] = simplifier.simplify(idx, pos, 3, target * 3, 1, []);
    let next              = out;
    if (next.length / 3 > target * 1.5) {
      const [sloppy] = simplifier.simplifySloppy(idx, pos, 3, null, target * 3, 1);
      next = sloppy;
    }
    ({ pos, idx } = compact(pos, next));
  }

  const vertexCount = pos.length / 3;
  const split = pieces(idx, vertexCount);
  const closed = new GrowU32(split.idx.length);
  const open = new GrowU32(16);
  for (let k = 0; k + 1 < split.runs.length; k++) {
    const piece = split.idx.subarray(split.runs[k] * 3, split.runs[k + 1] * 3);
    const isShut = isClosed(piece, vertexCount) && openness(pos, piece) < CLOSED_OPENNESS;
    if (isShut && signedVolume(pos, piece) < 0) {
      for (let t = 0; t + 2 < piece.length; t += 3) {
        const b = piece[t + 1];
        piece[t + 1] = piece[t + 2];
        piece[t + 2] = b;
      }
    }
    const into = isShut ? closed : open;
    for (let t = 0; t + 2 < piece.length; t += 3) into.push3(piece[t], piece[t + 1], piece[t + 2]);
  }
  const out            = [];
  for (const [list, twoSided] of [[closed, a.twoSided], [open, true]]         ) {
    if (list.len === 0) continue;
    const c = compact(pos, list.done());
    out.push({ kind: a.kind, grey: a.grey, twoSided, pos: c.pos, idx: c.idx });
  }
  return out;
}

function thinPoints(simplifier     , a     , target        )          {
  const src = a.idx.done();
  const gathered = new Float32Array(src.length * 3);
  for (let i = 0; i < src.length; i++) {
    gathered[i * 3] = a.pos.arr[src[i] * 3];
    gathered[i * 3 + 1] = a.pos.arr[src[i] * 3 + 1];
    gathered[i * 3 + 2] = a.pos.arr[src[i] * 3 + 2];
  }
  let idx = new Uint32Array(src.length).map((_, i) => i);
  if (src.length > target) idx = simplifier.simplifyPoints(gathered, 3, target);
  const c = compact(gathered, idx);
  return { kind: a.kind, grey: a.grey, twoSided: true, pos: c.pos, idx: c.idx };
}

function thinLines(a     , target        )          {
  const src = a.idx.done();
  const count = src.length / 2;
  let idx = src;
  if (count > target) {
    const step = count / target;
    idx = new Uint32Array(target * 2);
    for (let k = 0; k < target; k++) {
      const s = Math.floor(k * step) * 2;
      idx[k * 2] = src[s];
      idx[k * 2 + 1] = src[s + 1];
    }
  }
  const c = compact(a.pos.arr.subarray(0, a.pos.len), idx);
  return { kind: a.kind, grey: a.grey, twoSided: true, pos: c.pos, idx: c.idx };
}

async function runPipeline(doc     , up        , simplifier     , limits                )                          {
  const collected = collect(doc, limits);
  const accs = [...collected.accs.values()];
  if (accs.length === 0) throw new ModelError(MODEL_CODES.empty, "model has no faces, points or lines");
  const tris = accs.filter((a) => a.kind === GLASS_PART_KIND.triangles);
  const axis = up === "y" ? "+y" : up === "z" ? "+z" : guessUp(tris);
  const rotate = ROTATE[axis];
  if (rotate) {
    for (const a of accs) {
      const p = a.pos.arr;
      for (let i = 0; i < a.pos.len; i += 3) rotate(p[i], p[i + 1], p[i + 2], p, i);
    }
  }
  const total = collected.triangles;
  const parts            = [];
  for (const a of tris) {
    const n = a.idx.len / 3;
    const share = total > limits.targetTriangles ? Math.max(Math.min(n, 16), Math.floor((limits.targetTriangles * n) / total)) : n;
    for (const part of simplifyTriangles(simplifier, a, share)) if (part.idx.length) parts.push(part);
  }
  const pointAccs = accs.filter((a) => a.kind === GLASS_PART_KIND.points);
  for (const a of pointAccs) {
    const share = Math.max(1, Math.floor((limits.targetPoints * a.idx.len) / Math.max(1, collected.points)));
    parts.push(thinPoints(simplifier, a, share));
  }
  const lineAccs = accs.filter((a) => a.kind === GLASS_PART_KIND.lines);
  for (const a of lineAccs) {
    const share = Math.max(1, Math.floor((limits.targetLines * (a.idx.len / 2)) / Math.max(1, collected.lines)));
    parts.push(thinLines(a, share));
  }
  const live = parts.filter((p) => p.idx.length > 0);
  if (live.length === 0) throw new ModelError(MODEL_CODES.empty, "model has no faces, points or lines");

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of live) {
    for (let i = 0; i < p.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.pos[i + k];
        if (!Number.isFinite(v)) throw new ModelError(MODEL_CODES.unreadable, "model has a position that is not a number");
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  const centre = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  const half = Math.max(...[0, 1, 2].map((k) => (max[k] - min[k]) / 2));
  const scale = half > 0 ? 1 / half : 1;

  const order = [GLASS_PART_KIND.triangles, GLASS_PART_KIND.points, GLASS_PART_KIND.lines];
  live.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const vertexTotal = live.reduce((s, p) => s + p.pos.length / 3, 0);
  const positions = new Float32Array(vertexTotal * 3);
  const triangles = new GrowU32(1 << 12);
  const points = new GrowU32(16);
  const lines = new GrowU32(16);
  const table              = [];
  let base = 0;
  for (const p of live) {
    for (let i = 0; i < p.pos.length; i += 3) {
      positions[base * 3 + i] = (p.pos[i] - centre[0]) * scale;
      positions[base * 3 + i + 1] = (p.pos[i + 1] - centre[1]) * scale;
      positions[base * 3 + i + 2] = (p.pos[i + 2] - centre[2]) * scale;
    }
    const target = p.kind === GLASS_PART_KIND.triangles ? triangles : p.kind === GLASS_PART_KIND.points ? points : lines;
    const per = p.kind === GLASS_PART_KIND.triangles ? 3 : p.kind === GLASS_PART_KIND.points ? 1 : 2;
    const start = target.len / per;
    for (let i = 0; i < p.idx.length; i++) target.push(base + p.idx[i]);
    table.push({ grey: p.grey, twoSided: p.twoSided, kind: p.kind, start, count: p.idx.length / per });
    base += p.pos.length / 3;
  }
  return {
    mesh: { positions, triangles: triangles.done(), points: points.done(), lines: lines.done(), parts: table },
    trianglesIn: collected.triangles,
    pointsIn: collected.points,
    linesIn: collected.lines,
    up: axis,
  };
}

module.exports = { runPipeline };
