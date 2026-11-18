const TEXT_COMPONENT                  = {
  name: "text",
  since: 1,
  teach: "a short paragraph (body)",
  noun: "text",
  props: [
    {
      name: "text",
      type: "text",
      required: true,
      takes: "text_or_formula",
      maxChars: 1000,
      overflow: "cut",
      resultType: "text",
      teach: "the text, or =formula such as =sel.detail; the body may hold it instead",
    },
  ],
  propRules: [],
  body: { form: "text", prop: "text", teach: "the body is the text" },
  rows: null,
  state: [],
  behaviours: [],
  drives: { role: "display", rowType: null, takesActions: true, drivesAlone: false },
  outcomes: [],
  consent: "none",
  fits: [
    { sizeClass: "wide", linesMin: 1, linesMax: 8 },
    { sizeClass: "band", linesMin: 1, linesMax: 3 },
    { sizeClass: "column", linesMin: 1, linesMax: 8 },
    { sizeClass: "pane", linesMin: 1, linesMax: 8 },
  ],
  cost: { lineBytesMax: 999, layers: ["dim", "bright"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{text}",
  examples: [
    {
      id: "text.verdict",
      frame: "full",
      records: '<ui frame="full" title="Surf check"/>\n<ui id="verdict" c="text" in="main">Go after 3pm: 1.2 m and offshore wind.</ui>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "text.follows_row",
      frame: "stack",
      records:
        '<ui frame="stack" title="Today"/>\n<ui id="day" c="list" in="top" cols="label,detail">\nStandup|9:00 in room 2\nDentist|11:30, bring the card\n</ui>\n<ui id="more" c="text" in="bottom" text="=sel.detail"/>',
      expect: { valid: true },
    },
    {
      id: "text.unknown_field",
      frame: "full",
      records: '<ui frame="full" title="Note"/>\n<ui id="note" c="text" in="main" colour="red">Back by six.</ui>',
      expect: { repair: ["field_dropped"] },
    },
    {
      id: "text.unknown_region",
      frame: "full",
      records: '<ui frame="full" title="Note"/>\n<ui id="note" c="text" in="side">Back by six.</ui>',
      expect: { reject: "unknown_region" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/TextRenderer.kt",
      symbol: "TextRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { TEXT_COMPONENT };
