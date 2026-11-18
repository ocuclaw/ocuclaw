const MODE = { points: 0, lines: 1, lineLoop: 2, lineStrip: 3, triangles: 4, strip: 5, fan: 6 }         ;

class GrowF32 {
  arr              ;
  len        ;
  constructor(capacity = 1024) {
    this.arr = new Float32Array(Math.max(16, capacity));
    this.len = 0;
  }
  push(v        ) {
    if (this.len === this.arr.length) this.grow(this.len + 1);
    this.arr[this.len++] = v;
  }
  push3(a        , b        , c        ) {
    if (this.len + 3 > this.arr.length) this.grow(this.len + 3);
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
    this.arr[this.len++] = c;
  }
  grow(min        ) {
    const next = new Float32Array(Math.max(min, this.arr.length * 2));
    next.set(this.arr.subarray(0, this.len));
    this.arr = next;
  }
  done()               {
    return this.arr.slice(0, this.len);
  }
}

class GrowU32 {
  arr             ;
  len        ;
  constructor(capacity = 1024) {
    this.arr = new Uint32Array(Math.max(16, capacity));
    this.len = 0;
  }
  push(v        ) {
    if (this.len === this.arr.length) this.grow(this.len + 1);
    this.arr[this.len++] = v;
  }
  push3(a        , b        , c        ) {
    if (this.len + 3 > this.arr.length) this.grow(this.len + 3);
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
    this.arr[this.len++] = c;
  }
  grow(min        ) {
    const next = new Uint32Array(Math.max(min, this.arr.length * 2));
    next.set(this.arr.subarray(0, this.len));
    this.arr = next;
  }
  done()              {
    return this.arr.slice(0, this.len);
  }
}

function srgbToLinear(c        )         {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c        )         {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToLinear(hex                           )                                  {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
}

function multiply4(a          , b          )           {
  const out = new Array        (16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function determinant3(m          )         {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

function soupToDocument(core     , parts            )      {
  const doc = new core.Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh();
  for (const part of parts) {
    if (part.positions.length === 0) continue;
    const prim = doc.createPrimitive().setMode(part.mode);
    prim.setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(part.positions).setBuffer(buffer));
    if (part.indices) prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(part.indices).setBuffer(buffer));
    if (part.colors && part.colors.length === part.positions.length) {
      prim.setAttribute("COLOR_0", doc.createAccessor().setType("VEC3").setArray(part.colors).setBuffer(buffer));
    }
    const material = doc.createMaterial();
    if (part.color) material.setBaseColorFactor([part.color[0], part.color[1], part.color[2], 1]);
    if (part.doubleSided) material.setDoubleSided(true);
    prim.setMaterial(material);
    mesh.addPrimitive(prim);
  }
  const node = doc.createNode().setMesh(mesh);
  doc.createScene().addChild(node);
  return doc;
}

function forEachLine(text        , fn                        ) {
  let at = 0;
  while (at < text.length) {
    let nl = text.indexOf("\n", at);
    if (nl < 0) nl = text.length;
    let end = nl;
    if (end > at && text.charCodeAt(end - 1) === 13) end--;
    fn(text.slice(at, end));
    at = nl + 1;
  }
}

module.exports = { MODE, GrowF32, GrowU32, srgbToLinear, linearToSrgb, hexToLinear, multiply4, determinant3, soupToDocument, forEachLine };
