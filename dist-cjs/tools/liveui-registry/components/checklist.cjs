const CHECKLIST_COMPONENT                  = {
  name: "checklist",
  since: 1,
  teach: "rows the wearer ticks; the same body as list",
  noun: "checklist",
  props: [
    {
      name: "cols",
      type: "list",
      required: false,
      takes: "literal",
      maxItems: 8,
      default: "label",
      teach: "names every cell, comma-separated, label first",
    },
    {
      name: "rows",
      type: "text",
      required: false,
      takes: "formula",
      resultType: "any",
      teach: "a data list to take rows from, such as data.items; else the body's rows",
    },
  ],
  propRules: [],
  body: {
    form: "rows",
    prop: "rows",
    minItems: 1,
    maxItems: 20,
    overflow: "trim",
    teach: "one item per line, cells split by |",
  },
  rows: {
    source: ["literal", "data"],
    cells: "cols",
    labelCell: 0,
    rightCell: 1,
    maxRows: 20,
    overflow: "trim",
    cellMaxChars: 64,
    hiddenCellMaxChars: 280,
    cellOverflow: "cut",
    selExposes: "cols",
  },
  state: [
    { name: "cursor", type: "row_ref", class: "local", bound: "a row id" },
    { name: "marks", type: "bool", class: "context", bound: "one per row" },
  ],
  behaviours: [{ name: "toggle", on: "marks" }],
  drives: { role: "rows", rowType: "check", takesActions: true, drivesAlone: false },
  outcomes: [],
  consent: "local_commit_only",
  fits: [
    { sizeClass: "wide", linesMin: 1, linesMax: 8 },
    { sizeClass: "column", linesMin: 1, linesMax: 8 },
  ],
  cost: { lineBytesMax: 387, layers: ["dim", "bright", "cursor"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{rows}",
  examples: [
    {
      id: "checklist.packing",
      frame: "full",
      records:
        '<ui frame="full" title="Packing"/>\n<ui id="pack" c="checklist" in="main">\nPassport\nCharger\nRain jacket\n</ui>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "checklist.too_many",
      frame: "full",
      records:
        '<ui frame="full" title="Jobs"/>\n<ui id="jobs" c="checklist" in="main">\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\n</ui>',
      expect: { repair: ["rows_trimmed"] },
    },
    {
      id: "checklist.no_rows",
      frame: "full",
      records: '<ui frame="full" title="Packing"/>\n<ui id="pack" c="checklist" in="main"/>',
      expect: { reject: "missing_field" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/ChecklistRenderer.kt",
      symbol: "ChecklistRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { CHECKLIST_COMPONENT };
