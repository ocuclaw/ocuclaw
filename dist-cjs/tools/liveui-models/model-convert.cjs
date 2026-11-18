const { createHash } = require("node:crypto");
const { encodeGlassMesh } = require("./glass-mesh.cjs");
const { GLB_BIN, gltfClaims, gltfExternalUris, parseGlb, parseGltf, stripForGlass, usesDraco } = require("./model-gltf.cjs");
const { MODEL_CODES, MODEL_MAX_ACCESSOR_BYTES, MODEL_MAX_INFLATED_BYTES, MODEL_MAX_LINES, MODEL_MAX_POINTS, MODEL_MAX_TRIANGLES, MODEL_MAX_VERTICES, MODEL_TARGET_LINES, MODEL_TARGET_POINTS, MODEL_TARGET_TRIANGLES, ModelError } = require("./model-limits.cjs");
const { runPipeline } = require("./model-pipeline.cjs");
const { objClaims, plyClaims, readObj, readPly, readStl, stlClaims } = require("./model-readers.cjs");
const { read3mf } = require("./model-3mf.cjs");
const { soupToDocument } = require("./model-doc.cjs");
const { sniffModel } = require("./model-sniff.cjs");
const { listModelResources } = require("./model-resources.cjs");
const { listZip, readZipEntry, resolveZipPath, zipFiles, zipModel } = require("./model-zip.cjs");

let libsPromise                       = null;

function loadLibs()                {
  if (!libsPromise) {
    libsPromise = (async () => {
      const core = await import("@gltf-transform/core");
      const extensions = await import("@gltf-transform/extensions");
      const meshopt = await import("meshoptimizer");
      await meshopt.MeshoptSimplifier.ready;
      await meshopt.MeshoptDecoder.ready;
      return { core, extensions, meshopt };
    })();
  }
  return libsPromise;
}

function guardedDraco(module     , limits                )      {
  let faces = 0;
  let points = 0;
  const Base = module.Decoder;
  function Decoder(         ) {
    const decoder = new Base();
    const decode = decoder.DecodeBufferToMesh.bind(decoder);
    decoder.DecodeBufferToMesh = (buffer     , mesh     ) => {
      const status = decode(buffer, mesh);
      faces += mesh.num_faces();
      points += mesh.num_points();
      if (faces > limits.maxTriangles) throw new ModelError(MODEL_CODES.tooBig, `Draco holds over ${limits.maxTriangles} triangles`);
      if (points > limits.maxVertices) throw new ModelError(MODEL_CODES.tooBig, `Draco holds over ${limits.maxVertices} vertices`);
      return status;
    };
    return decoder;
  }
  return new Proxy(module, { get: (target, key) => (key === "Decoder" ? Decoder : Reflect.get(target, key)) });
}

async function gltfIo(libs      , draco         , limits                )               {
  const { core, extensions, meshopt } = libs;
  const io = new core.WebIO()
    .setLogger(new core.Logger(core.Logger.Verbosity.SILENT))
    .registerExtensions(extensions.ALL_EXTENSIONS);
  const deps                          = { "meshopt.decoder": meshopt.MeshoptDecoder };
  if (draco) {

    const mod      = await import("./third-party/draco_decoder_gltf.cjs");
    deps["draco3d.decoder"] = guardedDraco(await (mod.default || mod)(), limits);
  }
  return io.registerDependencies(deps);
}

function guard(claims             , limits                , format        ) {
  if (claims.triangles > limits.maxTriangles) {
    throw new ModelError(MODEL_CODES.tooBig, `claims ${claims.triangles} triangles`, format);
  }
  if (claims.points > limits.maxPoints) throw new ModelError(MODEL_CODES.tooBig, `claims ${claims.points} points`, format);
  if (claims.lines > limits.maxLines) throw new ModelError(MODEL_CODES.tooBig, `claims ${claims.lines} lines`, format);
  if ((claims.vertices || 0) > limits.maxVertices) {
    throw new ModelError(MODEL_CODES.tooBig, `claims ${claims.vertices} vertices`, format);
  }
  if ((claims.bytes || 0) > limits.maxAccessorBytes) {
    throw new ModelError(MODEL_CODES.tooBig, `claims ${Math.round((claims.bytes || 0) / 1048576)} MiB of mesh data`, format);
  }
}

function resourceMap(...sources                                                      )                             {
  const map                             = Object.create(null);
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (value instanceof Uint8Array) map[key] = value;
    }
  }
  return map;
}

async function readGltfJson(
  libs      ,
  json     ,
  resources                            ,
  limits                ,
  format        ,
)                {
  for (const uri of gltfExternalUris(json)) {
    if (!resources[uri]) throw new ModelError(MODEL_CODES.unreadable, `glTF needs ${uri.slice(0, 80)}`, format);
  }
  stripForGlass(json);
  const io = await gltfIo(libs, usesDraco(json), limits);
  try {
    return { doc: await io.readJSON({ json, resources }), up: "y", format };
  } catch (err     ) {
    if (err instanceof ModelError) throw new ModelError(err.code, err.message, format);
    throw new ModelError(MODEL_CODES.unreadable, String(err?.message || err).slice(0, 160), format);
  }
}

async function readFormat(
  libs      ,
  bytes            ,
  resources                            ,
  limits                ,
  budget           ,
  depth        ,
)                {
  const sniff = sniffModel(bytes);
  if (sniff.kind === "refused") throw new ModelError(MODEL_CODES.formatUnsupported, sniff.format, sniff.format);
  if (sniff.kind === "unknown") throw new ModelError(MODEL_CODES.unreadable, "not a model file");
  const format = sniff.format;
  switch (format) {
    case "glb": {
      const { json, bin } = parseGlb(bytes);
      guard(gltfClaims(json), limits, format);
      return readGltfJson(libs, json, bin ? resourceMap(resources, { [GLB_BIN]: bin }) : resources, limits, format);
    }
    case "gltf": {
      const json = parseGltf(bytes);
      guard(gltfClaims(json), limits, format);
      return readGltfJson(libs, json, resources, limits, format);
    }
    case "stl":
      guard(stlClaims(bytes), limits, format);
      return { doc: soupToDocument(libs.core, readStl(bytes, limits.maxTriangles)), up: "z", format };
    case "obj":
      guard(objClaims(bytes), limits, format);
      return { doc: soupToDocument(libs.core, readObj(bytes, resources)), up: "guess", format };
    case "ply":
      guard(plyClaims(bytes), limits, format);
      return { doc: soupToDocument(libs.core, readPly(bytes, limits.maxTriangles)), up: "guess", format };
    case "zip":
      return readZip(libs, bytes, limits, budget, depth);
    default:
      throw new ModelError(MODEL_CODES.unreadable, "not a model file");
  }
}

async function readZip(libs      , bytes            , limits                , budget           , depth        )                {
  const entries = zipFiles(listZip(bytes));
  const held = zipModel(entries);
  if (held.kind === "3mf") {
    const soup = read3mf(bytes, entries, budget, limits);
    return { doc: soupToDocument(libs.core, soup), up: "z", format: "3mf" };
  }
  if (held.kind === "refused") throw new ModelError(MODEL_CODES.formatUnsupported, held.format, held.format);
  if (held.kind === "none") throw new ModelError(MODEL_CODES.unreadable, "zip holds no model file", "zip");
  if (depth > 0) throw new ModelError(MODEL_CODES.unreadable, "zip inside a zip", "zip");
  const main = held.entry;
  const inner = readZipEntry(bytes, main, budget);

  const resources = resourceMap();
  const wanted = listModelResources(inner);
  for (const uri of [...wanted.required, ...wanted.optional]) {
    const path = resolveZipPath(main.name, uri);
    const entry = entries.find((e          ) => e.name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase() === path);
    if (entry) resources[uri] = readZipEntry(bytes, entry, budget);
  }
  const read = await readFormat(libs, inner, resources, limits, budget, depth + 1);
  return { ...read, format: `zip/${read.format}` };
}

async function convertModel(input                   , overrides                     = {})                              {
  const started = Date.now();
  const limits                 = {
    targetTriangles: overrides.targetTriangles ?? MODEL_TARGET_TRIANGLES,
    targetPoints: overrides.targetPoints ?? MODEL_TARGET_POINTS,
    targetLines: overrides.targetLines ?? MODEL_TARGET_LINES,
    maxTriangles: overrides.maxTriangles ?? MODEL_MAX_TRIANGLES,
    maxPoints: overrides.maxPoints ?? MODEL_MAX_POINTS,
    maxLines: overrides.maxLines ?? MODEL_MAX_LINES,
    maxVertices: overrides.maxVertices ?? MODEL_MAX_VERTICES,
    maxAccessorBytes: overrides.maxAccessorBytes ?? MODEL_MAX_ACCESSOR_BYTES,
  };
  const budget = { left: overrides.maxInflatedBytes ?? MODEL_MAX_INFLATED_BYTES };
  let format                    ;
  try {
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes       );
    const libs = await loadLibs();
    const read = await readFormat(libs, bytes, resourceMap(input.resources), limits, budget, 0);
    format = read.format;
    const out = await runPipeline(read.doc, read.up, libs.meshopt.MeshoptSimplifier, limits);
    const mesh = encodeGlassMesh(out.mesh);
    return {
      ok: true,
      mesh,
      sha256: createHash("sha256").update(mesh).digest("hex"),
      format,
      up: out.up,
      trianglesIn: out.trianglesIn,
      trianglesOut: out.mesh.triangles.length / 3,
      pointsOut: out.mesh.points.length,
      linesOut: out.mesh.lines.length / 2,
      parts: out.mesh.parts.length,
      ms: Date.now() - started,
    };
  } catch (err     ) {
    const ms = Date.now() - started;
    if (err instanceof ModelError) return { ok: false, code: err.code, format: err.format || format, detail: err.message, ms };
    return { ok: false, code: MODEL_CODES.unreadable, format, detail: String(err?.message || err).slice(0, 160), ms };
  }
}

module.exports = { listModelResources, convertModel };
