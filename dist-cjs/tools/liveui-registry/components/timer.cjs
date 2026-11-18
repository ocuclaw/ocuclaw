const TIMER_COMPONENT                  = {
  name: "timer",
  since: 1,

  teach:
    "mode countdown with for (12m, 90s, 1h30m), or mode elapsed; label. Never the driver. Read id.remaining, id.elapsed, id.status",
  noun: "timer",
  props: [
    {
      name: "label",
      type: "text",
      required: true,
      takes: "literal",
      maxChars: 24,
      overflow: "cut",
      teach: "what it times",
    },
    {
      name: "mode",
      type: "enum",
      required: false,
      takes: "literal",
      values: ["countdown", "elapsed"],
      default: "countdown",
      teach: "countdown or elapsed",
    },
    {
      name: "for",
      type: "duration",
      required: false,
      takes: "literal",
      teach: "a countdown's length: 90s, 12m, 1h30m",
    },
    {
      name: "until",
      type: "number",
      required: false,
      takes: "formula",
      resultType: "number",
      teach: "a countdown to a data time, such as data.departs",
    },
    {
      name: "since",
      type: "number",
      required: false,
      takes: "formula",
      resultType: "number",
      teach: "an elapsed time from a data time, such as data.started",
    },
  ],
  propRules: [],
  body: null,
  rows: null,
  state: [
    { name: "deadline", type: "timer", class: "context", bound: "an absolute time" },
    { name: "status", type: "text", class: "context", bound: "idle, running, paused or done" },
  ],
  behaviours: [
    { name: "countdown", on: "deadline" },
    { name: "elapsed", on: "deadline" },
  ],
  drives: { role: "display", rowType: null, takesActions: false, drivesAlone: false },
  outcomes: [],
  consent: "none",
  fits: [
    { sizeClass: "band", linesMin: 1, linesMax: 1 },
    { sizeClass: "pane", linesMin: 1, linesMax: 1 },
  ],
  cost: { lineBytesMax: 99, layers: ["dim", "live"], image: false },
  placeholder: "—",
  loading: "···",
  fallback: "{label}",
  examples: [
    {
      id: "timer.pasta",
      frame: "stack",
      records:
        '<ui frame="stack" title="Pasta"/>\n<ui id="steps" c="checklist" in="top" controls="run:boil|reset:boil">\nSalt the water\nPasta in\nDrain\n</ui>\n<ui id="boil" c="timer" in="bottom" label="Boil" for="11m"/>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "timer.unknown_field",
      frame: "stack",
      records:
        '<ui frame="stack" title="Tea"/>\n<ui id="steps" c="checklist" in="top" controls="run:steep">\nKettle on\nPour\n</ui>\n<ui id="steep" c="timer" in="bottom" label="Steep" for="4m" sound="bell"/>',
      expect: { repair: ["field_dropped"] },
    },
    {
      id: "timer.bad_mode",
      frame: "stack",
      records:
        '<ui frame="stack" title="Run"/>\n<ui id="laps" c="checklist" in="top">\nLap 1\nLap 2\n</ui>\n<ui id="clock" c="timer" in="bottom" label="Run" mode="stopwatch"/>',
      expect: { reject: "bad_value" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/TimerRenderer.kt",
      symbol: "TimerRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

module.exports = { TIMER_COMPONENT };
