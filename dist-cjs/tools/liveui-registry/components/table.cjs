const TABLE_COMPONENT                  = {
  name: "table",
  since: 3,
  teach: 'rows compared in aligned columns under a header of the col names; sort="fare,dep" lets the wearer re-sort by those cols on the glasses (-score: high first)',
  noun: "table",
  props: [
    {
      name: "cols",
      type: "list",
      required: false,
      takes: "literal",
      maxItems: 8,
      default: "label",
      teach: "names every cell, comma-separated; up to five show as columns, under a header that reads them",
    },
    {
      name: "rows",
      type: "text",
      required: false,
      takes: "formula",
      resultType: "any",
      teach: "a data list to take rows from, such as data.trains; else the body's rows",
    },
    {
      name: "sort",
      type: "list",
      required: false,
      takes: "literal",
      maxItems: 4,
      itemsName: "cols",
      teach: "the cols the wearer may sort by, the first sorting the rows at first; a - before one sorts it high to low",
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
  ],
  propRules: [],
  body: {
    form: "rows",
    prop: "rows",
    minItems: 1,
    maxItems: 20,
    overflow: "trim",
    teach: "one row per line, cells split by |; cells that sort as numbers hold bare numbers",
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

    { name: "order", type: "text", class: "local", bound: "one of the sort cols" },
  ],
  behaviours: [
    { name: "select", on: "order" },
    { name: "sort", on: "rows" },
  ],
  drives: { role: "rows", rowType: "item", takesActions: true, drivesAlone: false, head: "sort" },
  outcomes: ["selected"],
  consent: "explicit_turn_only",
  fits: [{ sizeClass: "wide", linesMin: 2, linesMax: 8 }],
  cost: { lineBytesMax: 387, layers: ["dim", "bright", "cursor"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{rows}",
  examples: [
    {
      id: "table.trains",
      frame: "full",
      records:
        '<ui frame="full" title="Lisbon to Porto"/>\n<ui id="trains" c="table" in="main" cols="dep,arr,plat,fare" sort="dep,fare">\n07:09|09:58|4|38\n08:39|11:28|2|31\n09:39|12:13|4|44\n11:09|13:58|6|27\n</ui>',
      expect: { valid: true },
      teach: true,
    },
    {

      id: "table.hotels_stack",
      frame: "stack",
      records:
        '<ui frame="stack" title="Hotels"/>\n<ui let="nights" be="3"/>\n<ui id="stay" c="table" in="top" cols="hotel,rate,walk,score" sort="-score,rate">\nAlfama Loft|140|8 min|9.1\nBaixa Suites|185|2 min|8.7\nLX Factory Inn|120|15 min|8.9\n</ui>\n<ui id="cost" c="facts" in="bottom" label="3 nights" value="nights*rate" fmt="money:EUR"/>',
      expect: { valid: true },
    },
    {
      id: "table.sort_unknown_col",
      frame: "full",
      records:
        '<ui frame="full" title="Phones"/>\n<ui id="phones" c="table" in="main" cols="phone,price" sort="price,weight">\nPixel 11|799\nFold 8|1799\n</ui>',
      expect: { repair: ["field_dropped"] },
    },
    {
      id: "table.in_rail",
      frame: "split",
      records:
        '<ui frame="split" title="Trains"/>\n<ui id="trains" c="table" in="rail" cols="dep,fare">\n07:09|38\n</ui>',
      expect: { reject: "no_fit" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/TableRenderer.kt",
      symbol: "TableRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { TABLE_COMPONENT };
