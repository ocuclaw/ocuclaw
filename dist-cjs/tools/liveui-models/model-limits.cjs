const MODEL_MAX_TRIANGLES = 2_000_000;

const MODEL_MAX_POINTS = 4_000_000;
const MODEL_MAX_LINES = 2_000_000;

const MODEL_MAX_VERTICES = 6_000_000;

const MODEL_MAX_ACCESSOR_BYTES = 256 * 1024 * 1024;

const MODEL_TARGET_TRIANGLES = 10_000;

const MODEL_TARGET_POINTS = 12_000;
const MODEL_TARGET_LINES = 6_000;

const MODEL_MAX_INFLATED_BYTES = 256 * 1024 * 1024;

const MODEL_MAX_ZIP_ENTRIES = 10_000;

const MODEL_ZIP_CROWDED = "zip has too many entries";

const MODEL_MAX_MAIN_JSON_BYTES = 1024 * 1024;

const MODEL_CONVERT_TIMEOUT_MS = 30_000;

const GLASS_MESH_TYPE = "model/x-ocuclaw-glass-mesh";

const MODEL_CODES = {
  formatUnsupported: "model_format_unsupported",
  tooBig: "model_too_big",
  unreadable: "model_unreadable",
  empty: "model_empty",

  needsLogin: "model_needs_login",
  needsDownload: "model_needs_download",
  needsReconnect: "model_needs_reconnect",
  downloadUnavailable: "model_download_unavailable",
  rateLimited: "model_rate_limited",
  providerUnavailable: "model_provider_unavailable",
  scopeRefused: "model_scope_refused",
  importCancelled: "model_import_cancelled",
}         ;

class ModelError extends Error {
  code        ;
  format                    ;
  constructor(code        , detail        , format         ) {
    super(detail);
    this.code = code;
    this.format = format;
  }
}

module.exports = { MODEL_MAX_TRIANGLES, MODEL_MAX_POINTS, MODEL_MAX_LINES, MODEL_MAX_VERTICES, MODEL_MAX_ACCESSOR_BYTES, MODEL_TARGET_TRIANGLES, MODEL_TARGET_POINTS, MODEL_TARGET_LINES, MODEL_MAX_INFLATED_BYTES, MODEL_MAX_ZIP_ENTRIES, MODEL_ZIP_CROWDED, MODEL_MAX_MAIN_JSON_BYTES, MODEL_CONVERT_TIMEOUT_MS, GLASS_MESH_TYPE, MODEL_CODES, ModelError };
