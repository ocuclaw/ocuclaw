const DRAW_CODE_MAX = 6000;

const DRAW_COMPONENT                  = {
  name: "draw",
  since: 3,
  teach:
    "a custom drawing the slots cannot show (a clock face, a compass, a board, chord or key shapes, a pie, a route): a short program in the body draws it on the phone, sharp at plate size; prefer it to a web address for a chart or diagram you can draw. value passes one value in (value=\"=col\" follows the selected row)",
  noun: "drawing",
  props: [
    {
      name: "code",
      type: "text",
      required: true,
      takes: "literal",
      maxChars: DRAW_CODE_MAX,
      overflow: "reject",
      resultType: "text",
      teach: "the program; the body holds it",
    },
    {
      name: "value",
      type: "text",
      required: false,
      takes: "text_or_formula",
      maxChars: 200,
      overflow: "cut",
      resultType: "text",
      teach: "one value the program reads as `value`, or =formula such as =hour",
    },
  ],
  propRules: [],
  body: { form: "text", prop: "code", teach: "the body is the program" },
  rows: null,
  state: [],
  behaviours: [],
  drives: { role: "display", rowType: null, takesActions: false, drivesAlone: false },
  outcomes: [],
  consent: "none",
  fits: [{ sizeClass: "plate", linesMin: 0, linesMax: 0 }],
  cost: { lineBytesMax: 0, layers: [], image: true },
  placeholder: "—",
  loading: "···",
  fallback: "drawing",
  examples: [
    {
      id: "draw.dial",
      frame: "plate",
      records:
        '<ui frame="plate" title="Wind"/>\n<ui id="dial" c="draw" in="plate">const c = 72, r = 60;\nreturn [circle(144, c, r, 6), text(144, 4, "N", { align: "center" }), line(144, c, ...at(144, c, r - 6, 45 / 360), 15, 3), dot(144, c, 3)];</ui>\n<ui id="cap" c="text" in="caption" text="14 kt from the north-east"/>',
      expect: { valid: true },
      teach: true,
    },
    {
      id: "draw.follows_row",
      frame: "rail-plate",
      records:
        '<ui frame="rail-plate" title="Clocks"/>\n<ui id="city" c="list" in="rail" cols="city,hour">\nTokyo|16.7\nLisbon|8.7\n</ui>\n<ui id="face" c="draw" in="plate" value="=hour">const h = Number(value) % 12;\nreturn [circle(144, 72, 64, 8), line(144, 72, ...at(144, 72, 40, h / 12), 15, 3)];</ui>',
      expect: { valid: true },
    },
    {
      id: "draw.in_text_region",
      frame: "full",
      records: '<ui frame="full" title="Dial"/>\n<ui id="dial" c="draw" in="main">return [circle(144, 72, 60, 8)];</ui>',
      expect: { reject: "no_fit" },
    },
  ],
  codeAnchors: {
    renderer: {
      file: "composeApp/src/webMain/kotlin/com/akelu/ocuclaw/glasses/liveui/components/DrawRenderer.kt",
      symbol: "DrawRenderer",
    },
    tests: [
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiRenderGoldensTest.kt" },
      { file: "composeApp/src/jsTest/kotlin/com/akelu/ocuclaw/glasses/liveui/LiveUiCompositorTest.kt" },
    ],
  },
};

const CODE_PLATE_BODY_LINE =
  "  draw body: JavaScript returning shapes on the black 288x144 plate (x right, y down, grays 0 off to 15 bright): rect(x,y,w,h,gray,radius) frame(x,y,w,h,gray,width) line(x1,y1,x2,y2,gray,width) circle(cx,cy,r,gray) dot(cx,cy,r,gray) arc(cx,cy,r,from,to,gray,width) wedge(cx,cy,r,from,to,gray) poly([[x,y],...],gray) text(x,y,'words',{scale:1|2|3,gray,align:'center'}); angles are turns clockwise from 12 o'clock and at(cx,cy,r,turn) gives [x,y]; text scale 1 is 6 px a letter and 12 px a line. No network, no Date: write the numbers in. e.g. return [circle(144,72,60,6), line(144,72,...at(144,72,52,0.125),15,3)]";
const CODE_PLATE_COMPONENT_LINE = `  draw       [plate] ${DRAW_COMPONENT.teach}.`;

function withCodePlateLines(block        )         {
  const lines = block.split("\n");
  const body = lines.findIndex((l) => l.startsWith("  graphic body:"));
  const image = lines.findIndex((l) => l.startsWith("  image      [plate]"));
  const bodies = lines.findIndex((l) => l.includes("put their content in a body"));
  if (body < 0 || image < 0 || bodies < 0) throw new Error("code plate: the records block lost an anchor line");
  lines[bodies] = lines[bodies].replace(/ and table put their content/, ", table and draw put their content");
  lines.splice(image + 1, 0, CODE_PLATE_COMPONENT_LINE);
  lines.splice(body + 1, 0, CODE_PLATE_BODY_LINE);
  return lines.join("\n");
}

module.exports = { DRAW_CODE_MAX, DRAW_COMPONENT, CODE_PLATE_BODY_LINE, CODE_PLATE_COMPONENT_LINE, withCodePlateLines };
