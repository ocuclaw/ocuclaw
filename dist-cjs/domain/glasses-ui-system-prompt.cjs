const { LIVEUI_RECORDS_BLOCK } = require("./glasses-ui-records-block.generated.cjs");
const { withCodePlateLines } = require("../tools/liveui-registry/components/draw.cjs");

const hostEnv = ()      => Reflect.get(globalThis, "process")?.env ?? {};

function composeGlassesUiChannelOne(env      = hostEnv(), phoneCodePlate = false) {
  return phoneCodePlate || codePlateEnabled(env) ? withCodePlateLines(LIVEUI_RECORDS_BLOCK) : LIVEUI_RECORDS_BLOCK;
}

function codePlateEnabled(env      = hostEnv()) {
  return env.OCUCLAW_LIVEUI_CODE_PLATE === "1";
}

const CODE_PLATE_CAPABILITY = "liveuiCodePlateV1";

const RETIRED_V1_CHANNEL_ONE_MARKER = "If render_glasses_ui is not in your current tool list";

module.exports = { composeGlassesUiChannelOne, codePlateEnabled, CODE_PLATE_CAPABILITY, RETIRED_V1_CHANNEL_ONE_MARKER };
