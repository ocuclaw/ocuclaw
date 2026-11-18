const LIST_COMPONENT                  = {
  name: "list",
  since: 1,
  teach: "rows; the first cell is the label, the second shows on the right, more cells are hidden data. Cells that feed a formula hold bare numbers (140, not €140); the formula's fmt adds the unit",
  noun: "list",
  props: [
    {
      name: "cols",
      type: "list",
      required: false,
      takes: "literal",
      maxItems: 8,
      default: "label",
      teach: "names every cell, comma-separated, label first: label,rate,note",
    },
    {
      name: "rows",
      type: "text",
      required: false,
      takes: "formula",
      resultType: "any",
      teach: "a data list to take rows from, such as data.rooms; else the body's rows",
    },
    {
      name: "tap",
      type: "enum",
      required: false,
      takes: "literal",
      values: ["select", "none"],
      default: "select",
      teach: "none: a tap on a row does nothing",
    },
    {

      name: "on",
      type: "text",
      required: false,
      takes: "name",
      maxChars: 32,
      overflow: "reject",
      teach: "an action id; each tap of it adds the row",
    },
    {
      name: "row",
      type: "text",
      required: false,
      takes: "formula",
      resultType: "any",
      teach: "the row the action adds: one formula per col, split by |",
    },
  ],
  propRules: [],
  body: {
    form: "rows",
    prop: "rows",
    minItems: 1,
    maxItems: 20,
    overflow: "trim",
    teach: "one row per line, cells split by |; cells that feed maths hold bare numbers",
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
    { name: "added", type: "any", class: "context", bound: "the rows append adds, up to 20 with the body's" },
  ],
  behaviours: [{ name: "append", on: "added" }],
  drives: { role: "rows", rowType: "item", takesActions: true, drivesAlone: false },
  outcomes: ["selected"],
  consent: "explicit_turn_only",
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
      id: "list.hotels",
      frame: "split",
      records:
        '<ui frame="split" title="Lisbon hotels"/>\n<ui let="nights" be="3"/>\n<ui id="pick" c="list" in="rail" cols="name,rate,note" actions="book:Book it">\nAlfama Loft|140|Old town, walk-up\nBaixa Suites|185|Metro 2 min\nLX Factory Inn|120|Quiet, tram 15 min\n</ui>\n<ui id="cost" c="facts" in="pane" label="Total" value="nights*rate" fmt="money:EUR"/>',
      expect: { valid: true },
    },
    {

      id: "list.trains",
      frame: "split",
      records:
        '<ui frame="split" title="Porto trains"/>\n<ui let="seats" be="2"/>\n<ui id="trains" c="list" in="rail" cols="time,fare,note" actions="book:Book seats">\n08:10|24|Alfa Pendular\n09:40|19|Intercidades\n</ui>\n<ui id="info" c="facts" in="pane">\nFare|=fmt(fare,\'money\',\'EUR\')\nFor 2|=fmt(seats*fare,\'money\',\'EUR\')\n</ui>',
      expect: { valid: true },
      teach: true,
    },
    {

      id: "list.rail_plate",
      frame: "rail-plate",
      records:
        '<ui frame="rail-plate" title="Trails"/>\n<ui id="pick" c="list" in="rail" cols="name,detail">\nRidge loop|9 km, steep at the midpoint\nCreek path|4 km, flat and shaded\nOld quarry|6 km, loose gravel\n</ui>\n<ui id="rise" c="graphic" in="plate">[{"type":"sparkline","values":[40,120,260,180,90],"label":"Ridge loop climb"}]</ui>\n<ui id="note" c="text" in="foot" text="=sel.detail"/>',
      expect: { valid: true },
    },
    {
      id: "list.cols_without_label",
      frame: "full",
      records:
        '<ui frame="full" title="Flights"/>\n<ui id="pick" c="list" in="main" cols="time">\nEarly|7:40\nLate|9:15\n</ui>',
      expect: { repair: ["cols_label_added"] },
    },
    {
      id: "list.in_follower",
      frame: "split",
      records: '<ui frame="split" title="Plans"/>\n<ui id="pick" c="list" in="pane">\nBasic\nPlus\n</ui>',
      expect: { repair: ["driver_moved"] },
    },
    {
      id: "list.no_driver",
      frame: "plate",
      records: '<ui frame="plate" title="Birds"/>\n<ui id="pick" c="list" in="caption">\nRobin\nWren\n</ui>',
      expect: { reject: "no_driver" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/ListRenderer.kt",
      symbol: "ListRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { LIST_COMPONENT };
