function compositorAnchors()                     {
  return [{ file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositor.kt" }];
}

const LIVEUI_GRID             = {
  canvasWidth: 576,
  canvasHeight: 288,
  lineTop: 6,
  lineHeight: 27,
  headerLine: 0,
  ruleY: 39,
  bodyLineFirst: 2,
  bodyLineLast: 9,
  bodyX0: 16,
  bodyX1: 560,
};

const LIVEUI_SIZE_CLASSES                    = [
  {
    name: "wide",
    widthPx: 544,
    linesMin: 4,
    linesMax: 8,
    teach: "the full body width, 4 or more lines: lists, checklists, steppers, reading",
  },
  {
    name: "band",
    widthPx: 544,
    linesMin: 1,
    linesMax: 3,
    teach: "the full width, 1-3 lines: a formula line, facts, a caption, a short note",
  },
  {
    name: "column",
    widthPx: 208,
    linesMin: 8,
    linesMax: 8,
    teach: "a narrow column of 8 lines: a list or steppers with short labels",
  },
  {
    name: "pane",
    widthPx: 312,
    linesMin: 2,
    linesMax: 8,
    teach: "a wider column of 2-8 lines: detail text, facts, a timer, a formula line",
  },
  {
    name: "plate",
    widthPx: 288,
    linesMin: 0,
    linesMax: 0,
    teach: "one image box of at most 288x144: a Graphic or a picture",
  },
];

const LIVEUI_CONTAINERS                    = [
  {
    name: "title",
    box: { x: 16, y: 6, w: 520, h: 27 },
    brightness: 4,
    holds: "the heading",
    eventCapture: false,
  },
  {
    name: "marker",
    box: { x: 548, y: 6, w: 22, h: 37 },
    brightness: 4,
    holds: "the presence glyph",
    eventCapture: false,
  },
  {
    name: "rule",
    box: { x: 16, y: 39, w: 544, h: 2 },
    brightness: 1,
    holds: "the header rule; U+0300 at brightness 0",
    eventCapture: false,
  },
  {
    name: "cursor",
    box: { x: 4, y: 37, w: 556, h: 27 },
    brightness: 1,
    holds: "the split rail's column head, in the band under the rule (G2 ride 4)",
    eventCapture: false,
  },
  {
    name: "dim",
    box: { x: 4, y: 6, w: 556, h: 270 },
    brightness: 1,
    holds: "the position cue on line 0 and every dim line of every Region",
    eventCapture: false,
  },
  {
    name: "bright",
    box: { x: 4, y: 60, w: 556, h: 216 },
    brightness: 4,
    holds: "the focused driver row and every bright line of every Region",
    eventCapture: false,
  },
  {
    name: "live",
    box: { x: 4, y: 60, w: 556, h: 216 },
    brightness: 4,
    holds: "ticking values (F11)",
    eventCapture: false,
  },
  {
    name: "input",
    box: { x: 0, y: 0, w: 576, h: 288 },
    brightness: 0,
    holds: "U+0300, the gesture target (F5)",
    eventCapture: true,
  },
];

const LIVEUI_FRAMES                = [
  {
    name: "full",
    since: 1,
    teach: "one Region for everything",
    regions: [
      {
        name: "main",
        role: "driver",
        sizeClass: "wide",
        text: { x0: 16, x1: 560, lineFirst: 2, lineLast: 9 },
      },
    ],
    choose: {
      what: "One block that fills the display: a set they pick from by name, items they tick off, values they set, or one thing they read or page through. Nothing beside it changes with the row they are on.",
      not_for:
        "A set where each row's detail, a total or a timer has to show beside or under the row they are on; a picture or a chart",
      examples: [
        "which of these three should I take",
        "what's left to pack",
        "ten minutes till the board call — what do I actually need to know",
      ],
    },
    codeAnchors: compositorAnchors(),
  },
  {
    name: "stack",
    since: 1,
    teach: "a Region on top, a short band under it that follows the row",
    regions: [
      {
        name: "top",
        role: "driver",
        sizeClass: "wide",
        text: { x0: 16, x1: 560, lineFirst: 2, lineLast: 5 },
      },
      {
        name: "bottom",
        role: "follower",
        sizeClass: "band",
        text: { x0: 16, x1: 560, lineFirst: 7, lineLast: 9 },
      },
    ],
    choose: {
      what: "A set they pick from, tick or adjust on top, with a line or two under it that follows the row they are on or adds it up: its detail, a running total, a countdown.",
      not_for:
        "Detail longer than a couple of lines for each row; a picture or a chart; one block with nothing under it",
      examples: [
        "what's the shape of today",
        "split the bill four ways and let me nudge the tip",
        "what am I doing in the next hour, and when do I move",
      ],
    },
    codeAnchors: compositorAnchors(),
  },
  {
    name: "split",
    since: 1,
    teach: "a narrow column on the left, a pane on the right that follows the row",
    regions: [
      {
        name: "rail",
        role: "driver",
        sizeClass: "column",
        text: { x0: 16, x1: 224, lineFirst: 2, lineLast: 9 },
      },
      {
        name: "pane",
        role: "follower",
        sizeClass: "pane",
        text: { x0: 248, x1: 560, lineFirst: 2, lineLast: 9 },
      },
    ],
    choose: {
      what: "Named options side by side: a short list in a narrow column, and a wider pane that shows the one they are on with its facts or a number worked out for it, so they can compare before they choose.",
      not_for: "Long names that need the full width; a picture or a chart; one block to read",
      examples: [
        "compare these three hotels for me",
        "which of the two flights is better value",
        "show the three plans and what each costs per month",
      ],
    },
    codeAnchors: compositorAnchors(),
  },
  {
    name: "plate",
    since: 1,
    teach: "one image box, a caption band under it, nothing to pick",
    regions: [
      {
        name: "plate",
        role: "plate",
        sizeClass: "plate",
        image: { x: 144, y: 60, w: 288, h: 144 },
      },
      {
        name: "caption",
        role: "follower",
        sizeClass: "band",
        text: { x0: 16, x1: 560, lineFirst: 8, lineLast: 9 },
      },
    ],
    choose: {
      what: "A picture or a small chart is the answer, with a short caption under it. Nothing to pick.",
      not_for: "A set to pick from; an answer that reads better as words",
      examples: [
        "just the bird and its name, nothing else",
        "how's my step count trending this week",
        "show me the logo",
      ],
    },
    codeAnchors: compositorAnchors(),
  },
  {
    name: "rail-plate",
    since: 1,
    teach: "a narrow column on the left, a picture and a short pane on the right that follow the row",
    regions: [
      {
        name: "rail",
        role: "driver",
        sizeClass: "column",
        text: { x0: 16, x1: 248, lineFirst: 2, lineLast: 9 },
      },
      {
        name: "plate",
        role: "plate",
        sizeClass: "plate",
        image: { x: 272, y: 60, w: 288, h: 144 },
      },
      {
        name: "foot",
        role: "follower",
        sizeClass: "pane",
        text: { x0: 272, x1: 560, lineFirst: 8, lineLast: 9 },
      },
    ],
    choose: {
      what: "A short list of named things in a narrow column, each with its own picture or chart beside it, so they browse by looking at each one.",
      not_for: "One picture with nothing to pick; long names that need the full width",
      examples: [
        "show me the three paint colours and let me flick through them",
        "which of these plants is the monstera",
        "the four dashboards, one chart each",
      ],
    },
    codeAnchors: compositorAnchors(),
  },
];

module.exports = { LIVEUI_GRID, LIVEUI_SIZE_CLASSES, LIVEUI_CONTAINERS, LIVEUI_FRAMES };
