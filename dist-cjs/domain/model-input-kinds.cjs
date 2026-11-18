const MODEL_INPUT_KINDS = ["text", "image", "audio", "video", "document"];

function modelInputKey(provider     , modelId     ) {
  if (typeof provider !== "string" || typeof modelId !== "string") return "";
  const p = provider.trim().toLowerCase();
  const id = modelId.trim();
  return p && id ? `${p}\u0000${id}` : "";
}

function modelInputsFromCatalogRows(rows     ) {
  const inputs = new Map();
  if (!Array.isArray(rows)) return inputs;
  const conflicted = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || !Array.isArray(row.input)) continue;
    const key = modelInputKey(row.provider, row.id);
    if (!key || conflicted.has(key)) continue;
    const kinds = MODEL_INPUT_KINDS.filter((kind) => row.input.includes(kind));
    const seen = inputs.get(key);
    if (seen && seen.join(",") !== kinds.join(",")) {
      inputs.set(key, []);
      conflicted.add(key);
      continue;
    }
    inputs.set(key, kinds);
  }
  return inputs;
}

module.exports = { modelInputKey, modelInputsFromCatalogRows };
