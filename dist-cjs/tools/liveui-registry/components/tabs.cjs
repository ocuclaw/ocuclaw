const TABS_COMPONENT                  = {
  name: "tabs",
  since: 3,
  teach: 'list rows under tabs the wearer switches on the glasses: the first cell names the row\'s tab, then the list\'s cells (cols="tab,label,time")',
  noun: "tabs",
  props: [
    {
      name: "cols",
      type: "list",
      required: false,
      takes: "literal",
      maxItems: 8,
      default: "tab,label",
      teach: "names every cell, comma-separated, the tab first and the label next: tab,label,time",
    },
    {
      name: "rows",
      type: "text",
      required: false,
      takes: "formula",
      resultType: "any",
      teach: "a data list to take rows from, such as data.places; else the body's rows",
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
    teach: "one row per line, cells split by |, the tab's name first",
  },
  rows: {
    source: ["literal", "data"],
    cells: "cols",
    tabCell: 0,
    maxTabs: 4,
    labelCell: 1,
    rightCell: 2,
    maxRows: 20,
    overflow: "trim",
    cellMaxChars: 64,
    hiddenCellMaxChars: 280,
    cellOverflow: "cut",
    selExposes: "cols",
  },
  state: [
    { name: "cursor", type: "row_ref", class: "local", bound: "a row id" },

    { name: "tab", type: "text", class: "local", bound: "one of the row's tab names" },
  ],
  behaviours: [{ name: "select", on: "tab" }],
  drives: { role: "rows", rowType: "item", takesActions: true, drivesAlone: false, head: "tabs" },
  outcomes: ["selected"],
  consent: "explicit_turn_only",
  fits: [
    { sizeClass: "wide", linesMin: 2, linesMax: 8 },
    { sizeClass: "column", linesMin: 2, linesMax: 8 },
  ],
  cost: { lineBytesMax: 387, layers: ["dim", "bright", "cursor"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{rows}",
  examples: [
    {
      id: "tabs.trip",
      frame: "full",
      records:
        '<ui frame="full" title="Lisbon trip"/>\n<ui id="trip" c="tabs" in="main" cols="tab,label,when">\nFlights|TP 1352 Lisbon|11:40\nFlights|FR 8355 Porto|17:15\nHotels|LX Factory Inn|EUR 120\nHotels|Alfama Loft|EUR 140\nFood|Time Out Market|8 min\nFood|Taberna da Rua|21 min\n</ui>',
      expect: { valid: true },
      teach: true,
    },
    {

      id: "tabs.rail_pane",
      frame: "split",
      records:
        '<ui frame="split" title="Weekend"/>\n<ui id="plan" c="tabs" in="rail" cols="tab,label,note">\nSat|Market|Stalls from 8\nSat|Castle|Book ahead\nSun|Beach|Train 25 min\n</ui>\n<ui id="note" c="text" in="pane" text="=note"/>',
      expect: { valid: true },
    },
    {
      id: "tabs.cols_without_tab",
      frame: "full",
      records:
        '<ui frame="full" title="Trip"/>\n<ui id="trip" c="tabs" in="main" cols="label,when">\nFlights|TP 1352|11:40\nHotels|Alfama Loft|EUR 140\n</ui>',
      expect: { repair: ["cols_label_added"] },
    },
    {
      id: "tabs.too_many_tabs",
      frame: "full",
      records:
        '<ui frame="full" title="Week"/>\n<ui id="week" c="tabs" in="main">\nMon|Gym\nTue|Swim\nWed|Run\nThu|Rest\nFri|Climb\n</ui>',
      expect: { repair: ["rows_trimmed"] },
    },
    {
      id: "tabs.no_rows",
      frame: "full",
      records: '<ui frame="full" title="Trip"/>\n<ui id="trip" c="tabs" in="main"/>',
      expect: { reject: "missing_field" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/TabsRenderer.kt",
      symbol: "TabsRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { TABS_COMPONENT };
