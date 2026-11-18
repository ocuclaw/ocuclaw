const STEPPER_COMPONENT                  = {
  name: "stepper",
  since: 1,

  teach:
    'a number the wearer sets: label, init, min, max, by, fmt. Its id is its name in formulas. options="s:Small|l:Large" makes it a choice; its value is the chosen id',
  noun: "stepper",
  props: [
    {
      name: "label",
      type: "text",
      required: true,
      takes: "literal",
      maxChars: 18,
      overflow: "cut",
      teach: "the row's label",
    },
    {
      name: "init",
      type: "text",
      required: false,
      takes: "literal",
      maxChars: 32,
      overflow: "reject",
      teach: "the start value: a number, or an option's id",
    },
    {
      name: "min",
      type: "number",
      required: false,
      takes: "formula",
      resultType: "number",
      teach: "the lowest value; needed unless options are given",
    },
    {
      name: "max",
      type: "number",
      required: false,
      takes: "formula",
      resultType: "number",
      teach: "the highest value; needed unless options are given",
    },
    {
      name: "by",
      type: "number",
      required: false,
      takes: "formula",
      default: 1,
      resultType: "number",
      teach: "the step",
    },
    {
      name: "wrap",
      type: "bool",
      required: false,
      takes: "literal",
      default: false,
      teach: "true wraps past the ends instead of stopping",
    },
    {
      name: "fmt",
      type: "text",
      required: false,
      takes: "literal",
      maxChars: 16,
      overflow: "reject",
      teach: "how the value shows: num, num:1, pct, money:EUR, dur",
    },
    {
      name: "options",
      type: "pairs",
      required: false,
      takes: "literal",
      maxItems: 20,
      labelMaxChars: 18,
      overflow: "trim",
      teach: "s:Small|m:Medium|l:Large makes it a choice; its value is the id",
    },
  ],
  propRules: [{ op: "le", left: "min", right: "max", code: "bad_range" }],
  body: null,
  rows: null,
  state: [
    { name: "value", type: "any", class: "context", bound: "min to max, or an option id" },
    { name: "draft", type: "any", class: "local", bound: "min to max, or an option id" },
  ],
  behaviours: [
    { name: "step", on: "value" },
    { name: "select", on: "value" },
  ],
  drives: { role: "rows", rowType: "stepper", takesActions: true, drivesAlone: false },
  outcomes: [],
  consent: "local_commit_only",
  fits: [
    { sizeClass: "wide", linesMin: 1, linesMax: 6 },
    { sizeClass: "column", linesMin: 1, linesMax: 6 },
  ],
  cost: { lineBytesMax: 129, layers: ["dim", "bright", "cursor"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{label}: {init}",
  mergeRecords: 6,
  examples: [
    {
      id: "stepper.split_bill",
      frame: "stack",
      records:
        '<ui frame="stack" title="Split the bill"/>\n<ui id="tip" c="stepper" in="top" label="Tip %" init="10" min="0" max="25" by="5"/>\n<ui id="each" c="facts" in="bottom" label="Each" value="120*(1+tip/100)/4" fmt="money:EUR"/>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "stepper.size_choice",
      frame: "full",
      records:
        '<ui frame="full" title="Coffee"/>\n<ui id="size" c="stepper" in="main" label="Size" init="m" options="s:Small|m:Medium|l:Large"/>',
      expect: { valid: true },
    },
    {
      id: "stepper.in_follower",
      frame: "stack",
      records:
        '<ui frame="stack" title="Guests"/>\n<ui id="note" c="text" in="top" text="Party on Friday"/>\n<ui id="guests" c="stepper" in="bottom" label="Guests" init="4" min="1" max="12"/>',
      expect: { repair: ["driver_moved"] },
    },
    {
      id: "stepper.min_over_max",
      frame: "full",
      records: '<ui frame="full" title="Guests"/>\n<ui id="guests" c="stepper" in="main" label="Guests" init="4" min="12" max="1"/>',
      expect: { reject: "bad_range" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/StepperRenderer.kt",
      symbol: "StepperRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { STEPPER_COMPONENT };
