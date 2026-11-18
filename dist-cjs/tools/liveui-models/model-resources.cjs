const { gltfExternalUris, parseGlb, parseGltf } = require("./model-gltf.cjs");
const { objMaterialLibraries } = require("./model-readers.cjs");
const { sniffModel } = require("./model-sniff.cjs");

const NONE = () => ({ required: []            , optional: []             });

function glbJsonLength(b            )         {
  if (b.length < 20) return -1;
  return (b[12] | (b[13] << 8) | (b[14] << 16) | (b[15] << 24)) >>> 0;
}

function listModelResources(bytes            , maxJsonBytes = Infinity)                                             {
  const sniff = sniffModel(bytes);
  if (sniff.kind !== "model") return NONE();
  try {
    if (sniff.format === "gltf") {
      if (bytes.length > maxJsonBytes) return NONE();
      return { required: gltfExternalUris(parseGltf(bytes)), optional: [] };
    }
    if (sniff.format === "glb") {
      const jsonLength = glbJsonLength(bytes);
      if (jsonLength < 0 || jsonLength > maxJsonBytes) return NONE();
      return { required: gltfExternalUris(parseGlb(bytes).json), optional: [] };
    }
    if (sniff.format === "obj") return { required: [], optional: objMaterialLibraries(bytes) };
  } catch {

  }
  return NONE();
}

module.exports = { listModelResources };
