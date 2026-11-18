const FACTS_COMPONENT                  = {
  name: "facts",
  since: 1,
  teach: "label|value lines in a body, or one computed line as label, value (a formula) and fmt",
  noun: "facts",
  props: [
    {
      name: "label",
      type: "text",
      required: false,
      takes: "literal",
      maxChars: 24,
      overflow: "cut",
      teach: "the one line's label",
    },
    {
      name: "value",
      type: "text",
      required: false,
      takes: "formula",
      resultType: "any",
      teach: "the one line's formula, such as nights*rate",
    },
    {
      name: "fmt",
      type: "text",
      required: false,
      takes: "literal",
      maxChars: 16,
      overflow: "reject",
      teach: "how the value shows: num, num:2, pct, money:EUR, dur",
    },
  ],
  propRules: [],
  body: {
    form: "pairs",
    prop: "pairs",
    minItems: 1,
    maxItems: 8,
    overflow: "trim",
    itemMaxChars: 64,
    itemOverflow: "cut",
    labelMaxChars: 24,
    teach: "label|value lines; a value starting with = is a formula",
  },
  rows: null,
  state: [],
  behaviours: [],
  drives: { role: "display", rowType: null, takesActions: true, drivesAlone: false },
  outcomes: [],
  consent: "none",
  fits: [
    { sizeClass: "band", linesMin: 1, linesMax: 3 },
    { sizeClass: "pane", linesMin: 1, linesMax: 8 },
    { sizeClass: "column", linesMin: 1, linesMax: 8 },
    { sizeClass: "wide", linesMin: 1, linesMax: 8 },
  ],
  cost: { lineBytesMax: 267, layers: ["dim", "bright"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{pairs}",
  examples: [
    {
      id: "facts.hotel_pane",
      frame: "split",
      records:
        '<ui frame="split" title="Lisbon hotels"/>\n<ui id="pick" c="list" in="rail" cols="name,rate,note">\nAlfama Loft|140|Old town, walk-up\nBaixa Suites|185|Metro 2 min\n</ui>\n<ui id="info" c="facts" in="pane">\nNote|=note\nRate|=fmt(rate,\'money\',\'EUR\')\n</ui>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "facts.and_written_as_symbols",
      frame: "stack",
      records:
        '<ui frame="stack" title="Budget"/>\n<ui id="spend" c="stepper" in="top" label="Spend" init="40" min="0" max="200" by="10"/>\n<ui id="warn" c="facts" in="bottom" label="Over" value="spend-150" show="spend>150 && spend<200"/>',
      expect: { repair: ["formula_operator_repaired"] },
    },
    {
      id: "facts.undeclared_name",
      frame: "full",
      records: '<ui frame="full" title="Stay"/>\n<ui id="cost" c="facts" in="main" label="Total" value="nightly*rate"/>',
      expect: { reject: "undeclared_name" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/FactsRenderer.kt",
      symbol: "FactsRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { FACTS_COMPONENT };
