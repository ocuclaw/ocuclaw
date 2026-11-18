const IMAGE_COMPONENT                  = {
  name: "image",
  since: 1,

  teach:
    "a picture on the plate. src is a web address, a file path or a named asset; a video link (.mp4, .webm, .m3u8, or a YouTube, X, Twitch or Instagram video page) plays there as slow video with sound on the phone; a 3D model link you were given or found (.glb .gltf .obj .stl .3mf .ply, or a zip of one) shows as a model the wearer turns by tilting their head (never invent one or inline a model; a NASA, Smithsonian or GitHub model page counts only if the wearer sent it; a Sketchfab, Thingiverse or MyMiniFactory page works in inline records during a wearer's run when connected in LiveUI settings, never put tokens or temporary download links in records); alt says what it shows and stands in if the picture fails",
  noun: "picture",
  props: [
    {
      name: "src",
      type: "text",
      required: true,
      takes: "text_or_formula",
      maxChars: 2048,
      overflow: "reject",
      resultType: "text",
      teach: "a web address, a file path or a named asset",
    },
    {
      name: "alt",
      type: "text",
      required: true,
      takes: "text_or_formula",
      maxChars: 64,
      overflow: "cut",
      default: "Picture",
      resultType: "text",
      teach: "what the picture shows, in a few words",
    },
  ],
  propRules: [],
  body: null,
  rows: null,
  state: [],
  behaviours: [],
  drives: { role: "display", rowType: null, takesActions: false, drivesAlone: false },
  outcomes: [],
  consent: "none",
  fits: [{ sizeClass: "plate", linesMin: 0, linesMax: 0 }],
  cost: { lineBytesMax: 0, layers: [], image: true },
  placeholder: "—",
  loading: "···",
  fallback: "Picture: {alt}",
  examples: [
    {
      id: "image.bird",
      frame: "plate",
      records:
        '<ui frame="plate" title="Robin"/>\n<ui id="pic" c="image" in="plate" src="https://example.org/robin.jpg" alt="A robin on a fence"/>\n<ui id="cap" c="text" in="caption" text="European robin"/>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "image.no_alt",
      frame: "plate",
      records: '<ui frame="plate" title="Logo"/>\n<ui id="pic" c="image" in="plate" src="https://example.org/logo.png"/>',
      expect: { repair: ["alt_repaired"] },
    },
    {
      id: "image.in_text_region",
      frame: "full",
      records:
        '<ui frame="full" title="Logo"/>\n<ui id="pic" c="image" in="main" src="https://example.org/logo.png" alt="Logo"/>',
      expect: { reject: "no_fit" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/ImageRenderer.kt",
      symbol: "ImageRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { IMAGE_COMPONENT };
