const { LIVEUI_REGISTRY } = require("../liveui-registry/index.cjs");

const { LIVEUI_SURFACE_TYPE } = require("../../domain/liveui-v2-client-forms.cjs");

function liveUiPresetForSpec(
  spec         ,
  presets                          = LIVEUI_REGISTRY.presets,
)                      {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const kind = (spec                      ).kind;
  if (typeof kind !== "string" || !kind) return null;
  const template = (spec                          ).template;
  if (typeof template === "string" && template) {
    const listed = presets.find((preset) => preset.v1Kind === kind && preset.v1Templates.includes(template));
    if (listed) return listed;
  }
  return presets.find((preset) => preset.v1Kind === kind && preset.v1Templates.length === 0) ?? null;
}

function liveUiPresetSurfaceMessage(
  render                         ,
  preset              ,
  options                      = {},
)                          {
  const fields = render.spec                           ;
  const seq = Number.isSafeInteger(render.seq) && (render.seq          ) > 0 ? (render.seq          ) : null;
  return {
    type: LIVEUI_SURFACE_TYPE,
    sessionKey: render.sessionKey ?? null,
    liveUiSessionGeneration: render.liveUiSessionGeneration ?? null,
    surfaceId: render.surfaceId,
    depth: render.depth,
    seq,
    specRev: seq ?? 1,
    ...(typeof render.origin === "string" ? { origin: render.origin } : {}),
    streaming: false,
    ...(typeof render.marker === "string" ? { marker: render.marker } : {}),

    ...(typeof render.asked === "string" && render.asked ? { asked: render.asked } : {}),
    spec: {
      v: 2,
      vocab: preset.since,
      title: typeof fields.title === "string" ? fields.title : null,
      preset: {
        name: preset.name,
        fields,
        ...(typeof render.collect === "boolean" ? { collect: render.collect } : {}),
        ...(typeof render.live === "boolean" ? { live: render.live } : {}),
        ...(options.patch ? { patch: true } : {}),
      },
    },
  };
}

function liveUiPresetFrame(
  render                                            ,
  options                                                                  = {},
)                                                                         {
  if (!render || typeof render.surfaceId !== "string" || !render.surfaceId) return null;
  const preset = liveUiPresetForSpec(render.spec, (options.registry ?? LIVEUI_REGISTRY).presets);
  if (!preset) return null;
  return {
    ...liveUiPresetSurfaceMessage(render, preset, { patch: options.patch }),
    liveuiForms: { minVocab: preset.since, fallback: null },
  };
}

module.exports = { liveUiPresetForSpec, liveUiPresetSurfaceMessage, liveUiPresetFrame };
