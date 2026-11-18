const { MODEL_CODES, ModelError } = require("./model-limits.cjs");

const GLB_BIN = "@glb.bin";

const KEEP_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_meshopt_compression",
  "KHR_mesh_quantization",
  "EXT_mesh_gpu_instancing",
  "KHR_materials_emissive_strength",
]);

const ACCESSOR_COMPONENTS                         = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES                         = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function unreadable(detail        , format        )             {
  return new ModelError(MODEL_CODES.unreadable, detail, format);
}

function parseGlb(b            )                                        {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const length = Math.min(b.length, view.getUint32(8, true));
  let at = 12;
  let json      = null;
  let bin                    = null;
  while (at + 8 <= length) {
    const size = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + size > length) throw unreadable("GLB chunk runs past the end", "glb");
    if (type === 0x4e4f534a && json === null) {
      try {
        json = JSON.parse(new TextDecoder().decode(b.subarray(start, start + size)));
      } catch {
        throw unreadable("GLB JSON does not parse", "glb");
      }
    } else if (type === 0x004e4942 && bin === null) bin = b.slice(start, start + size);
    at = start + ((size + 3) & ~3);
  }
  if (!json || typeof json !== "object") throw unreadable("GLB has no JSON chunk", "glb");
  return { json, bin };
}

function parseGltf(b            )      {
  let json     ;
  try {
    json = JSON.parse(new TextDecoder().decode(b));
  } catch {
    throw unreadable("glTF JSON does not parse", "gltf");
  }
  if (!json || typeof json !== "object" || !json.asset) throw unreadable("glTF has no asset", "gltf");
  if (String(json.asset.version || "").startsWith("1")) {
    throw new ModelError(MODEL_CODES.formatUnsupported, "glTF 1.0", "glTF 1");
  }
  return json;
}

function gltfClaims(json     )              {
  const counts = { triangles: 0, points: 0, lines: 0, vertices: 0, bytes: 0 };
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const countOf = (i     ) => {
    const a = accessors[i];
    return a && Number.isFinite(a.count) ? Math.max(0, a.count) : 0;
  };

  accessors.forEach((a     , i        ) => {
    const size = (ACCESSOR_COMPONENTS[a?.type] || 16) * (COMPONENT_BYTES[a?.componentType] || 4);
    counts.bytes += countOf(i) * size;
  });
  const perMesh = meshes.map((mesh     ) => {
    const c = { triangles: 0, points: 0, lines: 0, vertices: 0 };
    for (const prim of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      c.vertices += countOf(prim.attributes?.POSITION);
      const n = prim.indices !== undefined ? countOf(prim.indices) : countOf(prim.attributes?.POSITION);
      const mode = prim.mode === undefined ? 4 : prim.mode;
      if (mode === 4) c.triangles += Math.floor(n / 3);
      else if (mode === 5 || mode === 6) c.triangles += Math.max(0, n - 2);
      else if (mode === 0) c.points += n;
      else if (mode === 1) c.lines += Math.floor(n / 2);
      else c.lines += Math.max(0, mode === 2 ? n : n - 1);
    }
    return c;
  });
  let visits = 0;
  const visit = (index        , depth        ) => {
    const node = nodes[index];
    if (!node || depth > 64) return;
    if (++visits > 1_000_000) throw new ModelError(MODEL_CODES.tooBig, "glTF scene has too many nodes", "gltf");
    if (node.mesh !== undefined && perMesh[node.mesh]) {
      const inst = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
      let copies = 1;
      if (inst && typeof inst === "object") {

        const trs = [inst.TRANSLATION, inst.ROTATION, inst.SCALE].filter((a) => a !== undefined);
        if (trs.length) copies = Math.max(1, ...trs.map(countOf));
      }
      const m = perMesh[node.mesh];
      counts.triangles += m.triangles * copies;
      counts.points += m.points * copies;
      counts.lines += m.lines * copies;
      counts.vertices += m.vertices * copies;
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, depth + 1);
  };
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const scene = scenes[Number.isInteger(json.scene) ? json.scene : 0];
  if (scene && Array.isArray(scene.nodes) && scene.nodes.length) {
    for (const n of scene.nodes) visit(n, 0);
  } else if (nodes.length) {
    const children = new Set        ();
    for (const node of nodes) for (const c of Array.isArray(node?.children) ? node.children : []) children.add(c);
    nodes.forEach((_     , i        ) => { if (!children.has(i)) visit(i, 0); });
  } else {
    for (const m of perMesh) {
      counts.triangles += m.triangles;
      counts.points += m.points;
      counts.lines += m.lines;
      counts.vertices += m.vertices;
    }
  }
  return counts;
}

function gltfExternalUris(json     )           {
  const uris           = [];
  for (const buffer of Array.isArray(json?.buffers) ? json.buffers : []) {
    if (!buffer || typeof buffer.uri !== "string" || buffer.uri.startsWith("data:")) continue;
    if (buffer.extensions?.EXT_meshopt_compression?.fallback || buffer.extensions?.KHR_meshopt_compression?.fallback) continue;
    uris.push(buffer.uri);
  }
  return uris;
}

function keepOnly(obj     , keep                           ) {
  if (!obj || typeof obj !== "object" || !obj.extensions) return;
  for (const name of Object.keys(obj.extensions)) if (!keep(name)) delete obj.extensions[name];
  if (Object.keys(obj.extensions).length === 0) delete obj.extensions;
}

function stripForGlass(json     ) {
  delete json.images;
  delete json.textures;
  delete json.samplers;
  delete json.animations;
  delete json.extensions;
  for (const m of Array.isArray(json.materials) ? json.materials : []) {
    if (!m) continue;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
      delete m.pbrMetallicRoughness.extensions;
    }
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    keepOnly(m, (name) => name === "KHR_materials_emissive_strength");
  }
  for (const node of Array.isArray(json.nodes) ? json.nodes : []) {
    keepOnly(node, (name) => name === "EXT_mesh_gpu_instancing");
  }
  for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
    for (const prim of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      keepOnly(prim, (name) => name === "KHR_draco_mesh_compression");

      delete prim.targets;
    }
    if (mesh) delete mesh.weights;
  }

  for (const holder of [...(Array.isArray(json.buffers) ? json.buffers : []), ...(Array.isArray(json.bufferViews) ? json.bufferViews : [])]) {
    const ext = holder?.extensions;
    if (ext && ext.KHR_meshopt_compression && !ext.EXT_meshopt_compression) {
      ext.EXT_meshopt_compression = ext.KHR_meshopt_compression;
      delete ext.KHR_meshopt_compression;
    }
  }
  const renameMeshopt = (list     )           =>
    Array.isArray(list) ? [...new Set        (list.map((e        ) => (e === "KHR_meshopt_compression" ? "EXT_meshopt_compression" : e)))] : [];
  json.extensionsUsed = renameMeshopt(json.extensionsUsed).filter((e) => KEEP_EXTENSIONS.has(e));
  json.extensionsRequired = renameMeshopt(json.extensionsRequired).filter((e) => KEEP_EXTENSIONS.has(e));
  if (json.extensionsRequired.length === 0) delete json.extensionsRequired;
}

function usesDraco(json     )          {
  return (Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []).includes("KHR_draco_mesh_compression");
}

module.exports = { GLB_BIN, parseGlb, parseGltf, gltfClaims, gltfExternalUris, stripForGlass, usesDraco };
