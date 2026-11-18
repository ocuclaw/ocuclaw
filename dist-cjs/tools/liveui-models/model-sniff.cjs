const { Buffer } = require("node:buffer");

function ascii(b            , i        , text        )          {
  if (i + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) {
    if (b[i + k] !== text.charCodeAt(k)) return false;
  }
  return true;
}

function u32le(b            , i        )         {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function firstText(b            )         {
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return i;
}

function indexOfAscii(b            , text        , from = 0, to = b.length)         {
  const start = Math.max(0, from);
  const end = Math.min(to, b.length);
  if (text.length === 0 || end - start < text.length) return -1;

  const at = Buffer.from(b.buffer, b.byteOffset + start, end - start).indexOf(text, 0, "latin1");
  return at < 0 ? -1 : at + start;
}

function looksBinary(b            , upto        )          {
  const end = Math.min(upto, b.length);
  for (let i = 0; i < end; i++) if (b[i] === 0) return true;
  return false;
}

function hasLine(b            , tag        )          {
  if (ascii(b, 0, tag)) return true;
  return indexOfAscii(b, `\n${tag}`) >= 0;
}

function binaryStlCount(b            )         {
  if (b.length < 84) return -1;
  const count = u32le(b, 80);
  const expected = 84 + 50 * count;
  if (count > 0 && b.length >= expected && b.length - expected <= 4096) return count;
  return -1;
}

function sniffModel(b            )             {
  if (!(b instanceof Uint8Array) || b.length < 4) return { kind: "unknown" };
  if (ascii(b, 0, "glTF")) {
    const version = b.length >= 8 ? u32le(b, 4) : 0;
    return version === 2 ? { kind: "model", format: "glb" } : { kind: "refused", format: `glTF ${version || "?"}` };
  }
  if (ascii(b, 0, "PK\x03\x04") || ascii(b, 0, "PK\x05\x06")) return { kind: "model", format: "zip" };
  if (ascii(b, 0, "Kaydara FBX Binary")) return { kind: "refused", format: "FBX" };
  if (ascii(b, 0, "BLENDER")) return { kind: "refused", format: "Blend" };
  if (ascii(b, 0, "PXR-USDC")) return { kind: "refused", format: "USD" };

  if (binaryStlCount(b) > 0) return { kind: "model", format: "stl" };
  const t = firstText(b);
  if (ascii(b, t, "ply\n") || ascii(b, t, "ply\r\n")) return { kind: "model", format: "ply" };
  if (ascii(b, t, "ISO-10303-21")) return { kind: "refused", format: "STEP" };
  if (ascii(b, t, "#usda")) return { kind: "refused", format: "USD" };
  if (ascii(b, t, "; FBX")) return { kind: "refused", format: "FBX" };
  if (looksBinary(b, 4096)) return { kind: "unknown" };
  if (b[t] === 0x7b  && indexOfAscii(b, '"asset"') >= 0) return { kind: "model", format: "gltf" };
  if (ascii(b, t, "solid") && indexOfAscii(b, "facet", t, t + 4096) >= 0) return { kind: "model", format: "stl" };
  if (b[t] === 0x3c ) {
    if (indexOfAscii(b, "<COLLADA", t, t + 4096) >= 0) return { kind: "refused", format: "Collada" };
    return { kind: "unknown" };
  }
  if (hasLine(b, "v ") && (hasLine(b, "f ") || hasLine(b, "l ") || hasLine(b, "p "))) {
    return { kind: "model", format: "obj" };
  }
  return { kind: "unknown" };
}

function firstStlTriangleLooksReal(b            )          {
  if (b.length < 84 + 50) return false;
  const view = new DataView(b.buffer, b.byteOffset + 84, 48);
  for (let i = 0; i < 12; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) return false;
    if (i < 3 ? Math.abs(v) > 1.001 : Math.abs(v) > 1e9) return false;
  }
  return true;
}

const OBJ_STATEMENT_RE =
  /^[ \t]*(?:#.*|(?:v|vt|vn|vp|f|l|p|g|o|s|mg|usemtl|mtllib|usemap|maplib|cstype|deg|bmat|step|curv|curv2|surf|parm|trim|hole|scrv|sp|end|con|bevel|c_interp|d_interp|lod|shadow_obj|trace_obj|ctech|stech)(?:[ \t].*)?)?\r?$/;
const OBJ_VERTEX_LINE_RE = /^[ \t]*v[ \t]+[-+]?\.?\d\S*[ \t]+[-+]?\.?\d\S*[ \t]+[-+]?\.?\d/;
const OBJ_HEAD_VERTICES = 3;

const GLTF_HEAD_KEYS = [/"accessors"\s*:/, /"bufferViews"\s*:/, /"buffers"\s*:/, /"meshes"\s*:/, /"nodes"\s*:/, /"scenes"\s*:/];
const GLTF_HEAD_KEYS_NEEDED = 2;

function objHead(text        , whole         )          {
  const lines = text.split("\n");

  if (!whole) lines.pop();
  let vertices = 0;
  for (const line of lines) {
    if (!OBJ_STATEMENT_RE.test(line)) return false;
    if (OBJ_VERTEX_LINE_RE.test(line)) vertices++;
  }
  return vertices >= OBJ_HEAD_VERTICES;
}

function gltfHead(text        )          {
  let keys = 0;
  for (const key of GLTF_HEAD_KEYS) if (key.test(text)) keys++;
  return keys >= GLTF_HEAD_KEYS_NEEDED;
}

function sniffModelHead(b            , length               )                                      {
  const whole = sniffModel(b);
  if (whole.kind === "model" && whole.format === "stl" && binaryStlCount(b) > 0) return { ...whole, triangles: binaryStlCount(b) };
  if (whole.kind !== "unknown") return whole;
  if (!(b instanceof Uint8Array) || b.length < 4) return whole;

  if (looksBinary(b, 4096)) {
    const count = b.length >= 84 ? u32le(b, 80) : 0;
    const expected = 84 + 50 * count;
    if (count > 0) {
      const fits = length !== null ? length >= expected && length - expected <= 4096 : b.length < expected && firstStlTriangleLooksReal(b);
      if (fits) return { kind: "model", format: "stl", triangles: count };
    }
    return whole;
  }
  const t = firstText(b);
  const end = Math.min(b.length, t + 4096);
  const text = String.fromCharCode(...b.subarray(t, end));
  if (b[t] === 0x7b  && gltfHead(text)) return { kind: "model", format: "gltf" };
  if (objHead(text, end === b.length && length !== null && length <= b.length)) return { kind: "model", format: "obj" };
  return whole;
}

module.exports = { indexOfAscii, binaryStlCount, sniffModel, sniffModelHead };
