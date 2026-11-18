const PAGES_COMPONENT                  = {
  name: "pages",
  since: 1,
  teach: "a long read in up to 10 pages (body, pages split by a line ---); the wearer swipes; it drives alone",
  noun: "pages",
  props: [],
  propRules: [],
  body: {
    form: "pages",
    prop: "pages",
    minItems: 1,
    maxItems: 10,
    overflow: "trim",
    itemMaxChars: 600,
    itemOverflow: "cut",
    teach: "pages split by a line that is exactly ---",
  },
  rows: null,
  state: [{ name: "page", type: "page_index", class: "local", bound: "0 to the last page" }],
  behaviours: [],
  drives: { role: "pages", rowType: "page", takesActions: false, drivesAlone: true },
  outcomes: ["selected"],
  consent: "explicit_turn_only",
  fits: [{ sizeClass: "wide", linesMin: 4, linesMax: 8 }],
  cost: { lineBytesMax: 999, layers: ["dim", "bright"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{pages}",
  examples: [
    {
      id: "pages.brief",
      frame: "full",
      records:
        '<ui frame="full" title="Board call"/>\n<ui id="brief" c="pages" in="main">\nRevenue is up 4% on plan.\n---\nHiring is paused until March.\n---\nAsk: approve the Q3 budget.\n</ui>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "pages.too_many",
      frame: "full",
      records:
        '<ui frame="full" title="Steps"/>\n<ui id="steps" c="pages" in="main">\n1\n---\n2\n---\n3\n---\n4\n---\n5\n---\n6\n---\n7\n---\n8\n---\n9\n---\n10\n---\n11\n</ui>',
      expect: { repair: ["pages_trimmed"] },
    },
    {
      id: "pages.no_driver",
      frame: "plate",
      records: '<ui frame="plate" title="Notes"/>\n<ui id="notes" c="pages" in="caption">One\n---\nTwo</ui>',
      expect: { reject: "no_driver" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/PagesRenderer.kt",
      symbol: "PagesRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { PAGES_COMPONENT };
