const DEFAULT_STAGE_GRACE_MS = 30_000;
const MIN_STAGE_GRACE_MS = 1_000;
const MAX_STAGE_GRACE_MS = 5 * 60_000;

const LIVEUI_TEMPLATE_RENDER_TIMEOUT_MAX_MS = 85_000;

const GLASSES_UI_LIMITS = {
  bodyMax: 1000,
  pageMax: 600,
  maxPages: 10,
  imageCaptionMax: 64,
  imageWidthMin: 20,
  imageWidthMax: 288,
  imageHeightMin: 20,
  imageHeightMax: 144,
  imagePayloadMax: 288 * 144,
  imagePayloadBase64Max: 73_728,
  itemMax: 64,
  titleMax: 64,
  maxItems: 20,
  detailBodyMax: 200,
  totalDetailPayloadMax: 6 * 1024,

  totalChildPayloadMax: 8 * 1024,
  maxChildPages: 3,
};

module.exports = { GLASSES_UI_LIMITS, DEFAULT_STAGE_GRACE_MS, MIN_STAGE_GRACE_MS, MAX_STAGE_GRACE_MS, LIVEUI_TEMPLATE_RENDER_TIMEOUT_MAX_MS };
