const GRAPHIC_COMPONENT                  = {
  name: "graphic",
  since: 1,
  teach:
    '1-2 Graphic slots: metric, sparkline, bars, progress, ring, gauge, keyvalue or status. A slot field may name a column to follow the selected row; "values":"=trend" reads a cell of numbers like 14 15 17',
  noun: "chart",
  props: [],
  propRules: [],
  body: {
    form: "slots",
    prop: "slots",
    minItems: 1,
    maxItems: 2,
    overflow: "trim",
    teach: "a JSON array of 1-2 Graphic Slots; a field may be a '=formula' string, and `values` may name a column whose cells hold numbers split by spaces, so the chart follows the selected row, or one number each, so the chart is the whole column with the selected row marked",
  },
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
  fallback: "{slots}",
  examples: [
    {
      id: "graphic.trend",
      frame: "plate",
      records:
        '<ui frame="plate" title="Wind"/>\n<ui id="wind" c="graphic" in="plate">[{"type":"metric","value":"12.5","unit":"kt","label":"Wind","delta":1.5},{"type":"sparkline","values":[9,11,10,12.5],"label":"Last hour"}]</ui>\n<ui id="cap" c="text" in="caption" text="12.5 kt at the slip, up 1.5"/>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "graphic.column",
      frame: "rail-plate",
      records:
        '<ui frame="rail-plate" title="Ride"/>\n<ui id="hrs" c="list" in="rail" cols="hour,temp,note">\n7:00|12|Cool start\n8:00|14|Still calm\n9:00|17|Best window to set off\n10:00|19|Headwind on the way back\n</ui>\n<ui id="chart" c="graphic" in="plate">[{"type":"sparkline","values":"=temp","label":"=hour"}]</ui>\n<ui id="note" c="text" in="foot" text="=note"/>',
      expect: { valid: true },
    },
    {
      id: "graphic.three_slots",
      frame: "plate",
      records:
        '<ui frame="plate" title="Upload"/>\n<ui id="up" c="graphic" in="plate">[{"type":"progress","value":0.69,"label":"Photos"},{"type":"progress","value":0.4,"label":"Videos"},{"type":"progress","value":0.1,"label":"Docs"}]</ui>',
      expect: { repair: ["slots_trimmed"] },
    },
    {
      id: "graphic.in_text_region",
      frame: "full",
      records:
        '<ui frame="full" title="Upload"/>\n<ui id="up" c="graphic" in="main">[{"type":"progress","value":0.69,"label":"Photos"}]</ui>',
      expect: { reject: "no_fit" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/GraphicRenderer.kt",
      symbol: "GraphicRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { GRAPHIC_COMPONENT };
