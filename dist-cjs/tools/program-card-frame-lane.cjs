const { saveProgramCardFrame, frameScreenOf, FRAME_SCREEN_H, FRAME_VIEW_GAP, FRAME_SCREEN_W, FRAME_VIEW_MAX_H, FRAME_VIEW_MAX_W } = require("./program-card-frame-save.cjs");

const { PROGRAM_CARD_FRAMES_CAPABILITY } = require("./program-card-guide.cjs");

const PROGRAM_CARD_FRAME_DRAW_CAPABILITY = PROGRAM_CARD_FRAMES_CAPABILITY;
const FRAME_LANE_PURPOSE = "ocuclaw program card frame";

const FRAME_MODEL_MAX_TOKENS = 16_000;
const FRAME_MODEL_TIMEOUT_MS = 240_000;

const FRAME_MODEL_REASONING = "medium";

const FRAME_DETAILS                         = Object.freeze(["low", "medium", "high"]);
const FRAME_DETAIL_DEFAULT              = FRAME_MODEL_REASONING;
const FRAME_DETAIL_TIMEOUT_MS                                        = Object.freeze({
  low: FRAME_MODEL_TIMEOUT_MS, medium: FRAME_MODEL_TIMEOUT_MS, high: 420_000 });
const frameDetailOf = (value         )                     =>
  (FRAME_DETAILS                      ).includes(value) ? value                : null;

function frameDrawLimits(detail          ) {
  const level = frameDetailOf(detail) ?? FRAME_DETAIL_DEFAULT;
  return { maxTokens: FRAME_MODEL_MAX_TOKENS, reasoning: level, timeoutMs: FRAME_DETAIL_TIMEOUT_MS[level] };
}

const PROGRAM_CARD_FRAME_IDEA_CAPABILITY = "programCardsFrameIdeaV1";
const FRAME_IDEA_REASONING = "minimal";
const FRAME_IDEA_MAX_TOKENS = 400;
const FRAME_IDEA_TIMEOUT_MS = 15_000;

const FRAME_IDEA_MAX = 120;
const FRAME_CODE_MAX = 24_000;

const FRAME_PAYLOAD_MAX = 40_000;
const framePayloadLength = (code        ) => JSON.stringify({ code }).length;

const FRAME_MODEL_MESSAGE_MAX = 40_000;

function frameRepairMessage(brief        , code        , note        )         {
  const echoed = `${brief}\n\nYour script was:\n\`\`\`js\n${code}\n\`\`\`\n${note} Send the whole fixed script, in one \`\`\`js block.`;
  if (echoed.length <= FRAME_MODEL_MESSAGE_MAX) return echoed;
  return `${brief}\n\nYour script was ${code.length} characters, too long to show again. ${note}`
    + ` Send a whole new, shorter script (under ${FRAME_CODE_MAX} characters), in one \`\`\`js block.`;
}

const FRAME_SCENE_TILES = 4;
const FRAME_STARTS_PER_CARD = 2;
const MAX_SESSIONS = 32;

const box = (b          ) => b.join(",");
const record = (v     ) => !!v && typeof v === "object" && !Array.isArray(v);
const isBox = (b     )                => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isInteger(v) && v >= 0);

function programCardFrameLayout(value     )                     {
  if (!record(value) || !isBox(value.view)) return null;
  const id = (v     ) => typeof v === "string" && v && v.length <= 64 ? { id: v } : {};
  const text = (v     ) => (typeof v === "string" ? v.trim().slice(0, 80) : "");

  const least = (w     ) => (Number.isInteger(w.least) && w.least > 0 && w.least < w.box[2] ? { least: w.least, longest: text(w.longest) } : {});
  const words = Array.isArray(value.words) ? value.words.filter((w     ) => record(w) && isBox(w.box)).slice(0, 8)
    .map((w     ) => ({ ...id(w.id), box: w.box            , text: text(w.text), ...least(w) })) : [];
  const tiles = Number.isInteger(value.tiles) && value.tiles >= 0 ? value.tiles : 1;
  const back = Number.isInteger(value.back) && value.back >= 0 ? value.back : 0;
  const viewId = id(value.viewId).id;
  const fronts = Number.isInteger(value.fronts) && value.fronts >= 0 ? value.fronts : undefined;
  return { view: value.view, ...(viewId ? { viewId } : {}), ...(fronts !== undefined ? { fronts } : {}), words, tiles, back,
    ...(value.browse === true ? { browse: true          } : {}) };
}

const frameLayoutMovable = (layout             ) => !!layout.viewId && layout.fronts === 1
  && layout.words.every((w) => !!w.id) && new Set(layout.words.map((w) => w.id)).size === layout.words.length
  && (layout.browse !== true || frameBoardCentred(layout));

function frameBoardCentred(layout             ) {
  const centred = frameCentredView(layout);
  return !!centred && centred.every((v, i) => v === layout.view[i]);
}

const FRAME_CENTRE_SLACK = 1;

const FRAME_WORD_RIM = 2;

function frameWordsFitRound(view          , words                      ) {
  const [x, y, vw, vh] = view;
  const above = y - FRAME_WORD_RIM, below = FRAME_SCREEN_H - y - vh - FRAME_WORD_RIM;
  const left = x - FRAME_WORD_RIM, right = FRAME_SCREEN_W - x - vw - FRAME_WORD_RIM;
  const splits = [
    [[FRAME_SCREEN_W, above], [FRAME_SCREEN_W, below], [left, vh], [right, vh]],
    [[vw, above], [vw, below], [left, FRAME_SCREEN_H], [right, FRAME_SCREEN_H]],
  ];
  const sizes = words.slice(0, 8).map((w) => [frameLeastWidth(w), w.box[3]]);
  const sum = (picked            , axis        ) => picked.reduce((total, s) => total + s[axis], FRAME_WORD_RIM * (picked.length - 1));
  const holds = ([w, h]          , picked            ) => picked.length === 0
    || (picked.every((s) => s[0] <= w) && sum(picked, 1) <= h)
    || (picked.every((s) => s[1] <= h) && sum(picked, 0) <= w);
  for (let pick = 0; pick < 4 ** sizes.length; pick++) {
    const strips               = [[], [], [], []];
    sizes.forEach((s, i) => strips[Math.floor(pick / 4 ** i) % 4].push(s));
    if (splits.some((split) => split.every((strip, i) => holds(strip, strips[i])))) return true;
  }
  return false;
}

function frameCentredView(layout             )                  {
  const view = frameMiddleView(layout);
  return view && frameWordsFitRound(view, layout.words) ? view : null;
}

function frameMiddleView(layout             )                  {
  const [, , vw, vh] = layout.view;
  if (vw > FRAME_SCREEN_W || vh > FRAME_SCREEN_H) return null;
  return [2 * Math.floor((FRAME_SCREEN_W - vw) / 4), 2 * Math.floor((FRAME_SCREEN_H - vh) / 4), vw, vh];
}

const frameArtUnits = (layout             ) => Math.max(0, Math.min(3, FRAME_SCENE_TILES - layout.tiles));

function frameTileMenu(layout             )                           {
  if (!frameLayoutMovable(layout) || frameArtUnits(layout) < 3) return null;
  const view = frameCentredView(layout);
  if (!view) return null;

  const s = 2 * Math.floor(Math.max(0, Math.min(96, view[1] - 28)) / 2);
  const T = 288, S = FRAME_SCREEN_H, mid = (FRAME_SCREEN_W - T) / 2;
  const box = (x        , y        , w        , h        )           => [x, y, w, h];

  return [
    { name: "gate", art: [box(0, s, T, 144), box(T, s, T, 144), box(mid, s + 144, T, S - s - 144)],
      about: "two wings meet over the view and run down both its sides, and a base stands under it, like a gate, a cabinet or a stage; the black is a strip along the screen's top and the two bottom corners" },
    { name: "marquee", art: [box(mid, 0, T, 117), box(0, 117, T, 144), box(T, 117, T, 144)],
      about: "a sign over the view, offset half a tile from a console the screen's width under it; the black is the two top corners, beside the view's upper sides" },
    { name: "title_band", art: [box(0, 0, T, 144), box(T, 0, T, 144), box(mid, 144, T, S - 144)],
      about: "a band the screen's width over the view and down its sides, with a base under it; the black is the two bottom corners, beside the view's lower sides" },
    ...pillars(view),
  ];
}

function pillars(view          )                    {
  const [vx, vy, , vh] = view, base = vy + vh, w = Math.min(288, vx);
  const y = Math.max(0, 2 * Math.floor((vy - (144 - vh) / 2) / 2)), h = Math.min(144, base - y);
  if (w < 64 || FRAME_SCREEN_H - base < 24 || h < vh) return [];
  return [{ name: "pillars", art: [[0, y, w, h], [FRAME_SCREEN_W - w, y, w, h], [(FRAME_SCREEN_W - 288) / 2, base, 288, Math.min(144, FRAME_SCREEN_H - base)]],
    about: "a column down each side of the view and a base under it, like a stage's wings or a console's side panels; the black is a strip along the screen's top and the two bottom corners" }];
}

function frameBlackEdges(art            , view          )                                                                                    {
  const inside = (b          , x        , y        ) => x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3];
  const black = (x        , y        ) => x >= 0 && y >= 0 && x < FRAME_SCREEN_W && y < FRAME_SCREEN_H
    && !inside(view, x, y) && !art.some((a) => inside(a, x, y));
  const out                                                                                    = [];
  art.forEach(([x, y, w, h], i) => {
    const sides                                                                                  = [
      ["top", y, x, x + w, (k) => [k, y - 1]], ["bottom", y + h, x, x + w, (k) => [k, y + h]],
      ["left", x, y, y + h, (k) => [x - 1, k]], ["right", x + w, y, y + h, (k) => [x + w, k]],
    ];
    for (const [side, at, a, b, past] of sides) {
      let start = -1;
      for (let k = a; k <= b; k++) {
        const open = k < b && black(...past(k));
        if (open && start < 0) start = k;
        if (!open && start >= 0) { if (k - start >= 4) out.push({ art: i, side, at, from: start, to: k }); start = -1; }
      }
    }
  });
  return out;
}

function tileMenuLine(entry                 , view          ) {

  const runs                                                                   = [];
  const edges = frameBlackEdges(entry.art, view).map((e) => ({ axis: e.side === "top" || e.side === "bottom" ? "y"          : "x"         , at: e.at, from: e.from, to: e.to }))
    .sort((a, b) => a.axis.localeCompare(b.axis) || a.at - b.at || a.from - b.from);
  for (const e of edges) {
    const last = runs.at(-1);
    if (last && last.axis === e.axis && last.at === e.at && e.from <= last.to) last.to = Math.max(last.to, e.to);
    else runs.push({ ...e });
  }
  const lines = runs.map((r) => (r.axis === "y" ? `y ${r.at} from x ${r.from} to ${r.to}` : `x ${r.at} from y ${r.from} to ${r.to}`));
  return `"${entry.name}": ${entry.about}. Rectangles ${entry.art.map((a) => a.join(",")).join("; ")}; its art meets black along ${lines.join(", ")}.`;
}

function frameSkipReason(layout             , framedArt = 0)                         {
  if (layout.back > framedArt) return "has_backdrop";
  if (frameArtUnits(layout) < 1) return "no_tiles";

  if (layout.view[2] > FRAME_VIEW_MAX_W || layout.view[3] > FRAME_VIEW_MAX_H) return "view_too_big";
  return null;
}

const quote = (text        ) => `"${text.replace(/\s+/g, " ").replace(/"/g, "'")}"`;

function gameLine(game           ) {
  const plan = (game.plan ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 5);
  return [game.title.trim() || "a game", ...plan].join("; ")
    + (game.request?.trim() ? `; the wearer asked for it as ${quote(game.request.trim().slice(0, 300))}` : "");
}

function styleLine(game           ) {
  const style = typeof game.style === "string" ? game.style.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return style ? `The wearer asked for this frame's look: ${quote(style)}. Draw it that way; where it differs from the direction above, the wearer's words win, but every rule below still holds. ` : "";
}

function rectangles(units        ) {
  return units >= 3 ? "at most 3 rectangles that overlap neither each other nor the view (each up to 288x144, or one up to 576x144 that counts as two)"
    : units === 2 ? "at most 2 rectangles that overlap neither each other nor the view (each up to 288x144, or one up to 576x144 that counts as two)"
      : "one rectangle up to 288x144 that does not overlap the view";
}

const FRAME_WIDE_WORD = 288 - 6;

function wideWordLine(layout             , units        , lapsView         ) {
  const wide = layout.words.filter((w) => frameLeastWidth(w) > FRAME_WIDE_WORD);
  if (!wide.length || units < 2) return "";
  const name = wide[0].text ? quote(wide[0].text) : "a readout";
  const rest = units >= 3 ? ` and spend the last rectangle on the view's opposite side` : "";
  return `The word box ${name} is wider than one rectangle, so its plate takes a 576-wide rectangle, two of your ${units}: run that band along the box and against the view${lapsView ? " (it may lap over the view's top or bottom)" : ""}${rest}. Sides of the view the art cannot reach then stay black, and that is fine: a frame always fits, so never answer without a script. `;
}

const ART_DIRECTION = "Everything else is yours to invent: a bold, finished pixel-art frame that belongs to this game and no other, like the art on a great arcade cabinet or a modern indie game. "
  + "Fill it with the game's own things, drawn large: its characters and creatures, its vehicles and tools, the stuff it is made of, the place it happens in. "
  + "They hold the view as its window and run out from it to the screen's edges, so the frame extends the game's world past the play area. "
  + "Make it a control panel only when the game is itself about a machine, and then hang the world's own things on it; rows of buttons and meters round every game is the dull answer. "
  + "Use most of each rectangle: big readable shapes, thick dark outlines, flat solid tones with a little shading, mid greys (51 to 119) for the big fills with darker shading inside them, bright outlines, rims and highlights (153 and up) on every main shape, and labels bright on dark plates. "
  + "Keep the bright to lines and small spots, never whole fills: the glasses show every grey above 153 alike, so a bright fill loses its shading, while a frame mostly in dark greys looks faint. ";
const SCRIPT_CALLS = "Write a short JavaScript script that draws it pixel by pixel on a 288x131 grid (x right, y down, all black to start) with these calls, already defined for it: px(x, y, g) sets one pixel of grey g (0-255); rect(x, y, w, h, g) a filled rectangle; line(x0, y0, x1, y1, g, w) a straight line, w pixels thick (default 1); poly([[x, y], ...], g) a filled polygon; at(x, y) reads the grey already there. "
  + "Build every shape from px, rect, line and poly, each one flat grey; every outline, shade and detail is yours to place; never a photo, a painting or noise texture. "
  + "Greys: the glasses tell 0, 17, 34 ... 153 apart and show anything above that as near full; 255 is the brightest. "

  + "More brushes, defined for it too: ellipse(cx, cy, rx, ry, g) a filled ellipse; ring(cx, cy, rx, ry, g, w) its outline, w thick; arc(cx, cy, r, a0, a1, g, w) an arc of a circle from angle a0 to a1 in degrees (0 points right, 90 down), w thick; outline([[x, y], ...], g, w) the closed outline through those points, w thick; shade(x, y, w, h, g0, g1, dir) a rectangle filled in stepped bands from grey g0 to g1 in the glasses' own 17-grey steps, along dir 'x' or 'y', for cylinders, cloth, metal and sky; hatch(x, y, w, h, g, step, dir) parallel lines every step px inside a rectangle, dir '/', '\\\\', '-' or '|', for texture without noise; copy(sx, sy, w, h, dx, dy, flip) stamps what is drawn in one region at another place, mirrored left-right when flip is true, black left see-through, so draw one side of a symmetrical thing and mirror it, or draw a creature once and stamp it. "

  + "The grid draws at 2x: each of its pixels is a 2x2 block on the 576x261 screen, which reads blocky in small things. A detail layer draws single screen pixels over it: fine.px(x, y, g), fine.rect(x, y, w, h, g), fine.line(x0, y0, x1, y1, g, w), fine.poly([[x, y], ...], g), fine.at(x, y) and the brushes as fine.ellipse, fine.ring, fine.arc, fine.outline, fine.shade, fine.hatch and fine.copy, all in screen coordinates (twice the grid's; fine.W and fine.H are 576 and 261); fine black covers the grid too, so it can cut into a shape. "
  + "Keep the big shapes on the grid, and put faces, eyes, lettering, rims, rivets, ticks, thin highlights and the other small detail on the fine layer, so the frame reads crisp up close. "
  + "Craft: a thick dark outline round every main shape, round things drawn round, curved things shaded in two or three steps along the light, texture by hatch and never by noise. ";

const seamRules = (words         , placed = false, menu = false) => "Seams: the view is a hard-edged rectangle; the host blacks it out exactly, with the 2 px round it, and draws the window's own lit edge just inside it, one even line on every side. So build the frame's opening as that rectangle: where art meets the view, draw a rim along it (a bezel, hull edge, door jamb, cabinet lip or window frame, 2 to 6 px) starting 2 px out from the view, on every side it touches, never a rounded, slanted or windshield-shaped opening that the rectangle cuts through, and never a fill or a figure that runs on under the view as if it were not there. "
  + (words ? "Each word box is a hard-edged rectangle too: set it in a plate drawn round it, and set that plate against the view or on the thing in this world that would carry it (a dashboard, a sign, a console, a scroll), never stranded on black away from both. "

    + "The host checks the plate: lit art within 3 px of the box along at least three of its four sides (a side at the screen's edge counts)"
    + (placed ? ", so keep 2 px or more between a word box and the view (the host keeps that dark), and 2 px or more of the plate's lit rim between two word boxes: the plate touches them, the box itself never sits flush against either. " : ". ") : "")
  + (menu ? "The host draws the window's lit edge round the view itself, so where your arrangement leaves black beside the view it still reads as a closed window: there, end the art in its own outline, a few px clear of the black. "
    : `Leave no bare black beside or under the view: every side of the view that is not at the screen's edge has art${words ? " or plates" : ""} along it. `);

function roundCentredView() {
  return "They may run under the view, which covers them (the host blacks the art out there), so a rectangle can lap over a corner or a side of the view and carry on past it. "
    + "The screen holds four 288x131 quarters' worth of tiles and the view takes one, so the rectangles cannot ring the centred view and cover the whole screen: do not try. "
    + "Place them round the view where this picture wants them, each lapping a different corner or side of it. "
    + "Choose where the black falls and shape it with the art's own outlines, so it reads as part of the picture. Outside the rectangles stays black. ";
}

function tileMenuText(menu                   , view          ) {
  return "The art lives in 3 rectangles, and you pick their arrangement from this menu by its name; the host places them exactly, so you never give their corners. "
    + "They may run under the view, which covers them (the host blacks the art out there). Three tiles cannot ring a centred view, so each arrangement leaves some black, at the screen's edges and outside the frame's shape, where it reads as background and never as a hole beside the game. The menu: "
    + menu.map((entry) => tileMenuLine(entry, view)).join(" ") + " "
    + `Pick the one this game wants: a game with a big title or a sign may take the marquee or the title band, a game played in a machine, on a stage or behind a door may stand in the gate${menu.some((m) => m.name === "pillars") ? ", a game with a column of moves or stats beside its board may take the pillars" : ""}; two different games should not share an arrangement. `
    + "Draw only inside your arrangement's rectangles; outside them stays black. Where its art meets black, end every shape a few px inside that line in its own outline (a pipe's lip, a creature's back, a rock's round top, a sign's rounded end), never a fill cut off flat by the line: the host measures art that reaches those lines and sends the frame back. ";
}

function programCardFrameBriefFree(game           , layout             )         {
  const units = frameArtUnits(layout);
  const [, , vw, vh] = layout.view;
  const centred = frameCentredView(layout);
  const menu = frameTileMenu(layout);

  const narrowable = layout.words.some((w) => frameLeastWidth(w) < w.box[2]);
  const words = layout.words.map((w, i) => {
    const name = w.text ? quote(w.text) : "a readout";
    const least = frameLeastWidth(w);
    if (least >= w.box[2]) return `${i + 1}. ${name}, ${w.box[2]}x${w.box[3]}`;
    const longest = w.longest && w.longest !== w.text ? ` (its longest line ${quote(w.longest)})` : "";
    return `${i + 1}. ${name}${longest}, ${w.box[3]} high and ${least} to ${w.box[2]} wide`;
  });
  const boxes = words.length ? `${words.length === 1 ? "one word box" : `${words.length} word boxes`} the game writes its readouts in (${words.join("; ")})` : "";
  const narrow = narrowable ? "Where a word box's width is given as a range, its width is yours too: its least width is what its longest line just fills, so make it as narrow as its place in the frame wants, and the plates hold the words while the art holds the screen; the game centres its text in whatever width you give. " : "";
  const pieces = centred
    ? `The game plays in the middle of the screen: the live view, ${vw}x${vh}, sits at ${centred[0]},${centred[1]} and stays there, and the frame is built round it. `
      + (boxes ? `The game also has ${boxes}, yours to place: put each where this game's frame wants it, clear of the view; the host moves the game's own pieces there${narrowable ? "" : ", at the sizes given"}. ` : "")
      + narrow
      + `Leave pure black the view where it sits${words.length ? " and every word box where you put it" : ""}. `
    : `The game's pieces are yours to place: the live view, ${vw}x${vh}, where the game plays${boxes ? `, and ${boxes}` : ""}. Put each where this game's frame wants it; the host moves the game's own pieces there${narrowable ? "" : ", at the sizes given"}. `
      + narrow
      + `Leave pure black the view${words.length ? " and every word box" : ""} where you put ${words.length ? "them" : "it"}. `;
  const compose = menu
    ? "Compose the whole screen as one picture round that centred view, the way a cabinet's marquee and bezel or a game's title screen is composed: which arrangement from the menu below holds it, whether a title or emblem crowns it, and where each readout lives in this world. "
      + "Before you draw, weigh two or three of the arrangements for this game and pick the strongest. "
    : centred
    ? "Compose the whole screen as one picture round that centred view, the way a cabinet's marquee and bezel or a game's title screen is composed: where the art's rectangles go round the view, whether a title or emblem crowns it, and where each readout lives in this world. "
      + "Before you draw, work out two or three quite different arrangements that could suit this game and pick the strongest; a band over the view with a base under it is one choice among many, not the default. "
    : "Compose the whole screen as one picture, the way a cabinet's marquee and bezel or a game's title screen is composed: decide where the view sits, as near the middle of the screen as its readouts leave room for, whether a title or emblem crowns it, and where each readout lives in this world. "
      + "Before you draw, work out two or three quite different compositions that could suit this game and pick the strongest; a title band over a centred view with a base under it is one choice among many, not the default. ";
  const round = centred ? roundCentredView()
    : "They may run under the view, which covers them (the host blacks the art out there). The screen holds four 288x131 quarters' worth of tiles and the view takes one, so the art reaches at most about three quarters of the screen besides what it hides under the view: choose where the black falls. Outside the rectangles stays black. ";
  return `Design the still frame round a glasses game, as one PNG of the whole 576x261 screen, and lay out the play screen in it. The game: ${gameLine(game)}. `
    + pieces
    + ART_DIRECTION
    + styleLine(game)
    + compose
    + "Choose the arrangement this game wants, as a designer would for this game alone; two different games should not share a layout. "
    + (words.length ? `Set each word box into a plate that belongs to the art${menu ? ", inside your arrangement's rectangles, never on the black" : ""}, with a small drawn label if it helps; the game's text fills the box, about 27 px a line. ` : "")
    + "A title or emblem suits some games, never a must. "
    + (menu && centred ? tileMenuText(menu, centred)
      : `The art lives in at most ${units} rectangles that do not overlap each other, placed anywhere: each up to 288x144, or one up to 576x144 or 288x261 that counts as two. `
        + round
        + wideWordLine(layout, units, true))
    + (centred ? "Set the view inside the art, which meets it along at least two sides and better all four, so it reads as a window in the frame, never a picture on bare black. "
      : "Wherever the view sits, set it inside the art, which meets it along at least two sides, so it reads as a window in the frame, never a picture on bare black at the screen's edge. ")
    + seamRules(words.length > 0, true, !!menu)
    + "The rectangles are hidden limits, not panels: never box one in with a border or a fill from edge to edge; the shapes end on black in their own outlines and break out of any box look. "
    + (units > 1 ? "Where two rectangles meet, carry the shapes across the seam, so the whole frame reads as one connected piece of the world, not separate pictures. " : "")
    + (centred ? (words.length ? "Keep every word box whole inside the 576x261 screen, clear of the view and of each other. " : "")
      : "Keep the view and every word box whole inside the 576x261 screen, and keep them clear of each other. ")
    + SCRIPT_CALLS
    + `End the script with return { ${menu ? 'layout: "name", ' : ""}view: [${centred ? `${centred[0]}, ${centred[1]}` : "x, y"}]${words.length ? `, words: [[x, y${narrowable ? ", w" : ""}], ...]` : ""}${menu ? "" : ", art: [[x, y, w, h], ...]"} } in screen pixels (576x261): ${menu ? "the arrangement's name from the menu, " : ""}the view's top-left corner${centred ? " as given" : ""}${words.length ? `, each word box's top-left corner${narrowable ? " and width" : ""} in the order listed above` : ""}${menu ? "" : ", and one entry per art rectangle"}. `
    + `The host runs it in a sandbox with nothing else in reach, scales the grid 2x with hard pixels and lays the fine layer over it, blacks out the view${words.length ? ", the word boxes" : ""} and all outside the art, checks the boxes and the size, and makes the PNG. `
    + "Reply with only the script, in one ```js block.";
}

function framePlacementOf(out     , layout             )
                                                                                                    {
  const corner = (name        , v     , w        , h        )                    => {
    if (!Array.isArray(v) || v.length < 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) return `${name} must be [x, y], its top-left corner`;
    const x = Math.round(v[0]), y = Math.round(v[1]);
    if (x < 0 || y < 0 || x + w > FRAME_SCREEN_W || y + h > FRAME_SCREEN_H) return `${name} at ${x},${y} (${w}x${h}) is not inside the 576x261 screen`;
    return [x, y, w, h];
  };
  if (!record(out)) return { ok: false, error: "the script must return { view, words, art }" };
  const centred = frameCentredView(layout);
  const named = centred && (out.view === undefined || out.view === null) ? centred : corner("view", out.view, layout.view[2], layout.view[3]);
  if (typeof named === "string") return { ok: false, error: named };
  if (centred && (Math.abs(named[0] - centred[0]) > FRAME_CENTRE_SLACK || Math.abs(named[1] - centred[1]) > FRAME_CENTRE_SLACK)) {
    return { ok: false, error: `the view is at ${named[0]},${named[1]}; it stays in the middle of the screen, at ${centred[0]},${centred[1]} (${centred[2]}x${centred[3]}): draw the frame round it there and return view: [${centred[0]}, ${centred[1]}]` };
  }
  const view = centred ?? named;
  const given = out.words === undefined ? [] : out.words;
  if (!Array.isArray(given) || given.length !== layout.words.length) {
    return { ok: false, error: `words must list ${layout.words.length} [x, y] corners, one per word box in order` };
  }
  const words             = [];
  for (let i = 0; i < given.length; i++) {
    const spec = layout.words[i];

    const least = frameLeastWidth(spec);
    const w = Array.isArray(given[i]) && given[i][2] !== undefined ? Math.round(Number(given[i][2])) : spec.box[2];
    if (!Number.isFinite(w) || w < least || w > spec.box[2]) {
      return { ok: false, error: least < spec.box[2] ? `word box ${i + 1} is ${w} wide; it may be ${least} to ${spec.box[2]}` : `word box ${i + 1} is ${spec.box[2]} wide; its width is not yours to change` };
    }
    const b = corner(`word box ${i + 1}`, given[i], w, spec.box[3]);
    if (typeof b === "string") return { ok: false, error: b };
    const hit = [view, ...words].findIndex((o) => b[0] < o[0] + o[2] && o[0] < b[0] + b[2] && b[1] < o[1] + o[3] && o[1] < b[1] + b[3]);
    if (hit >= 0) return { ok: false, error: `word box ${i + 1} at ${b.join(",")} overlaps ${hit === 0 ? "the view" : `word box ${hit}`}` };
    words.push(b);
  }
  const place             = { viewId: layout.viewId          , dx: view[0] - layout.view[0], dy: view[1] - layout.view[1],
    words: Object.fromEntries(layout.words.map((w, i) => [w.id          ,
      words[i][2] < w.box[2] ? [words[i][0], words[i][1], words[i][2]]                             : [words[i][0], words[i][1]]                    ])) };
  return { ok: true, view, words, place };
}

function frameLeastWidth(word                              ) {
  return Number.isInteger(word.least) && (word.least          ) > 0 && (word.least          ) < word.box[2] ? (word.least          ) : word.box[2];
}

function programCardFrameBrief(game           , layout             )         {
  if (frameLayoutMovable(layout)) return programCardFrameBriefFree(game, layout);
  const units = frameArtUnits(layout);
  const words = layout.words.map((w) => `${w.text ? quote(w.text) : "a readout"} at ${box(w.box)}`);
  const keep = words.length
    ? `Leave pure black the live view (${box(layout.view)}) and the game's word boxes (${words.join("; ")}); they all stay where they are.`
    : `Leave pure black the live view (${box(layout.view)}); it stays where it is.`;
  return `Draw the still frame round a glasses game, as one PNG of the whole 576x261 screen. The game: ${gameLine(game)}. ${keep} `
    + ART_DIRECTION
    + styleLine(game)
    + (words.length ? "Set each word box into a plate in the art, with a small drawn label if it helps. " : "")
    + "A title or emblem suits some games, never a must. "
    + `The art lives in ${rectangles(units)}, placed anywhere; outside them stays black. `
    + (words.length ? "A rectangle may run under a word box (the host blacks the box out), and the art need not reach every side of the view, so a frame always fits these rectangles: never answer without a script. " : "")
    + wideWordLine(layout, units, false)
    + seamRules(words.length > 0)
    + "The rectangles are hidden limits, not panels: never box one in with a border or a fill from edge to edge; the shapes end on black in their own outlines and break out of any box look. "
    + `The view${words.length ? " and the word boxes stay" : " stays"} where ${words.length ? "they are" : "it is"}: choose the layout round ${words.length ? "them" : "it"} that this game wants, not side wings and a plinth every time, but always set the view inside the art, which meets it along at least two sides, balanced round it, with no big empty corner beside it. `
    + (units > 1 ? "Where two rectangles meet, carry the shapes across the seam, so the whole frame reads as one connected piece of the world, not three separate pictures. " : "")
    + SCRIPT_CALLS
    + "End the script with return { art: [[x, y, w, h], ...] } in screen pixels (576x261), one entry per art rectangle. "
    + `The host runs it in a sandbox with nothing else in reach, scales the grid 2x with hard pixels and lays the fine layer over it, blacks out the view${words.length ? ", the word boxes" : ""} and all outside the art, checks the rectangles and the size, and makes the PNG. `
    + "Reply with only the script, in one ```js block.";
}

function programCardFrameDrawAsk(game           , layout             , idea                )         {
  const line = typeof idea === "string" && idea.trim()
    ? `\n\nThe idea for this frame is already chosen: ${quote(idea.trim())}. Draw that idea; every rule above still holds.` : "";
  return programCardFrameBrief(game, layout) + line;
}

function programCardFrameIdeaAsk(game           )         {
  const style = typeof game.style === "string" ? game.style.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return `You are about to draw the still pixel-art frame round a small game on smart glasses. The game: ${gameLine(game)}. `
    + "The frame is a bold, finished picture that belongs to this game and no other: the game's own characters, creatures, vehicles, tools and places, drawn large, holding the play area as its window and running out to the screen's edges. "
    + (style ? `The wearer asked for this frame's look: ${quote(style)}. ` : "")
    + "Before you draw, choose the one idea for this frame: what it shows and how it holds the game. "
    + "Say it in one line of at most 90 characters that starts with \"Drawing\", in plain words the wearer reads while it is drawn, naming this game's own things. "
    + "Reply with only that line.";
}

function frameIdeaOf(text     )                {
  if (typeof text !== "string") return null;
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  let line = first.replace(/^[-*#>\s]+/, "").replace(/^\*+|\*+$/g, "").replace(/^["'“‘`]+|["'”’`]+$/g, "").replace(/\s+/g, " ").trim();
  if (!/^drawing\s+\S/i.test(line)) return null;
  line = "Drawing" + line.slice("drawing".length);
  if (line.length > FRAME_IDEA_MAX) {
    const cut = line.slice(0, FRAME_IDEA_MAX + 1);
    line = cut.slice(0, Math.max(cut.lastIndexOf(" "), "Drawing".length)).trim();
  }
  return line.replace(/[\s,;:.!"'”’`-]+$/, "") || null;
}

const SEAM_EDGE = 8, SEAM_RIM = 8, SEAM_NEAR = 48;

const FRAME_CUT_RUN = 8;
const FRAME_CUT_MAX = 24;

function frameFlatCuts(screen            , view          , art            ) {
  const W = FRAME_SCREEN_W;
  const g = (x        , y        ) => screen[y * W + x];
  let total = 0;
  let worst                                                                                      = null;
  for (const e of frameBlackEdges(art, view)) {
    const [x, y, w, h] = art[e.art];

    const at = (k        )                                       => e.side === "top" ? [[k, y], [k, Math.min(y + 2, y + h - 1)]]
      : e.side === "bottom" ? [[k, y + h - 1], [k, Math.max(y + h - 3, y)]]
        : e.side === "left" ? [[x, k], [Math.min(x + 2, x + w - 1), k]] : [[x + w - 1, k], [Math.max(x + w - 3, x), k]];
    let run = 0, px = 0;
    const end = () => { if (run >= FRAME_CUT_RUN) px += run; run = 0; };
    for (let k = e.from; k < e.to; k++) {
      const [[ex, ey], [ix, iy]] = at(k);
      const v = g(ex, ey);
      if (v > 0 && v === g(ix, iy)) run++; else end();
    }
    end();
    total += px;
    if (px && (!worst || px > worst.px)) worst = { box: art[e.art], side: e.side, px, from: e.from, to: e.to };
  }
  return { total, worst };
}

function frameSeamsOf(screen            , view          , words            , movable         , centred = false, art             = [])             {
  const W = FRAME_SCREEN_W, H = FRAME_SCREEN_H;
  const inWord = (x        , y        ) => words.some((b) => x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3]);
  const g = (x        , y        ) => (x >= 0 && x < W && y >= 0 && y < H ? screen[y * W + x] : -1);
  const filled = (x        , y        ) => { const v = g(x, y); return v === -1 ? -1 : v > 0 || inWord(x, y) ? 1 : 0; };

  const sidesOf = ([bx, by, bw, bh]          , gap = 0)                                                    => ({
    top: { len: bw, at: (i, k) => [bx + i, by - gap - k], edge: by <= SEAM_EDGE },
    right: { len: bh, at: (i, k) => [bx + bw - 1 + gap + k, by + i], edge: bx + bw >= W - SEAM_EDGE },
    bottom: { len: bw, at: (i, k) => [bx + i, by + bh - 1 + gap + k], edge: by + bh >= H - SEAM_EDGE },
    left: { len: bh, at: (i, k) => [bx - gap - k, by + i], edge: bx <= SEAM_EDGE },
  });
  const issues           = [];
  const sides = {}                       ;
  let heldCount = 0;
  for (const [name, s] of Object.entries(sidesOf(view, FRAME_VIEW_GAP))                                            ) {
    let lit = 0, bare = 0;
    const ks           = [];
    for (let i = 0; i < s.len; i++) {
      const g1 = g(...s.at(i, 1));
      if (g1 > 0) { lit++; let k = 2; while (k <= SEAM_RIM && g(...s.at(i, k)) === g1) k++; ks.push(k); }
      let any = false;
      for (let k = 1; k <= SEAM_NEAR; k += 2) { if (filled(...s.at(i, k)) !== 0) { any = true; break; } }
      if (!any) bare++;
    }
    const counts = new Map                ();
    for (const k of ks) counts.set(k, (counts.get(k) ?? 0) + 1);
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? SEAM_RIM + 1;
    const consistent = ks.length ? ks.filter((k) => Math.abs(k - mode) <= 1).length / ks.length : 0;
    const held = lit / s.len >= 0.5;
    if (held) heldCount++;
    sides[name] = { lit: lit / s.len, flat: ks.length ? 1 - consistent : 0, bare: bare / s.len, edge: s.edge, held };
  }
  if (heldCount < 2) {
    issues.push(`the view meets lit art along ${heldCount} of its 4 sides (${Object.entries(sides).map(([n, v]) => `${n} ${Math.round(v.lit * 100)}%`).join(", ")}); set it in the art on at least two sides`);
  }
  for (const [n, v] of Object.entries(sides)) {
    if (v.held && v.flat >= 0.5) issues.push(`along the view's ${n} side the art runs on under it with no rim along the edge (${Math.round(v.flat * 100)}% of its length); draw a rim 2 to 6 px wide along the view's rectangle there`);
  }
  const cuts = frameFlatCuts(screen, view, art);
  if (cuts.total >= FRAME_CUT_MAX && cuts.worst) {
    const { box: b, side, px, from, to } = cuts.worst;
    const line = side === "top" ? `y ${b[1]}` : side === "bottom" ? `y ${b[1] + b[3]}` : side === "left" ? `x ${b[0]}` : `x ${b[0] + b[2]}`;
    const along = side === "top" || side === "bottom" ? `x ${from} to ${to}` : `y ${from} to ${to}`;
    issues.push(`art is cut off flat for ${cuts.total} px where its rectangles meet black, most along the ${side} edge of the art rectangle ${b.join(",")} (${px} px at ${line}, ${along}); past that line the screen is black, so end the shapes a few px inside it in their own outlines`);
  }
  if (movable) {
    for (const [n, v] of Object.entries(sides)) {
      if (!v.edge && v.bare >= 0.6) issues.push(`the strip beside the view's ${n} side is bare black for ${Math.round(v.bare * 100)}% of its length; put art or plates along it${centred ? "" : ", or move the view"}`);
    }
  }
  words.forEach((b, i) => {
    let plated = 0;
    for (const s of Object.values(sidesOf(b))) {
      if (s.edge) { plated++; continue; }
      let lit = 0;
      for (let j = 0; j < s.len; j++) for (let k = 1; k <= 3; k++) if (g(...s.at(j, k)) > 0) { lit++; break; }
      if (lit / s.len >= 0.4) plated++;
    }
    if (plated < 3) issues.push(`word box ${i + 1} floats on black (lit art along ${plated} of its 4 sides); set it in a plate against the view or on something in this world`);
  });
  return { ok: issues.length === 0, issues, sides, cut: cuts.total };
}

function frameScriptOf(text     )                {
  if (typeof text !== "string" || !text.trim()) return null;
  const blocks = [...text.matchAll(/```[ \t]*(?:js|javascript|JavaScript)?[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);

  if (!blocks.length && text.includes("```")) return null;
  const code = (blocks.length ? blocks.sort((a, b) => b.length - a.length)[0] : text).trim();
  return code && /\breturn\b/.test(code) ? code : null;
}

const CUT_OFF = new Set(["length", "max_tokens", "max_output_tokens"]);

function outsideHostWorkScope   (run         )    {
  const store      = (globalThis       )[Symbol.for("openclaw.asyncWorkScope")];
  return store && typeof store.exit === "function" ? store.exit(run) : run();
}

const layoutKeyOf = (view          , words            ) => JSON.stringify([view, words]);

function saveFrameDrawing(screen            , out     , layout             , units = frameArtUnits(layout))                                            {
  let art = record(out) ? out.art : undefined;
  if (frameLayoutMovable(layout)) {
    const placed = framePlacementOf(out, layout);
    if (!placed.ok) return placed;

    const menu = frameTileMenu(layout);
    const name = typeof out.layout === "string" ? out.layout.trim().toLowerCase() : "";
    const picked = menu?.find((entry) => entry.name === name);
    if (menu && !picked) {
      return { ok: false, error: `${name ? `layout "${String(out.layout).slice(0, 40)}" is not on the menu` : "the script must name its layout"}: return layout as one of ${menu.map((entry) => `"${entry.name}"`).join(", ")}` };
    }
    if (picked) art = picked.art;
    const saved = saveProgramCardFrame(screen, { view: placed.view, art, words: placed.words }, { units, wordsFixed: true, underView: true });
    return saved.ok ? { ...saved, place: placed.place, ...(picked ? { tileLayout: picked.name } : {}) } : saved;
  }
  const saved = saveProgramCardFrame(screen, { view: layout.view, art, words: layout.words.map((w) => w.box) }, { units, wordsFixed: true });
  return saved.ok ? { ...saved, place: null } : saved;
}

function createProgramCardFrameLane(deps               ) {
  const lanes = new Map              ();
  const now = () => (typeof deps.now === "function" ? deps.now() : Date.now());
  const debug = (event        , severity        , data     , sessionKey        ) => {
    try { deps.debug?.(event, severity, data, sessionKey); } catch {  }
  };

  async function ask(messages       , signal             ,
    { maxTokens = FRAME_MODEL_MAX_TOKENS, reasoning = FRAME_MODEL_REASONING, timeoutMs = FRAME_MODEL_TIMEOUT_MS } = {}) {
    const res = await (deps.complete       )({ messages, maxTokens, reasoning, purpose: FRAME_LANE_PURPOSE, timeoutMs, signal });
    if (!res || res.error || res.failure || res.stopReason === "error" || res.stopReason === "aborted") {
      throw new Error(`model: ${String(res?.error?.message ?? res?.error ?? res?.failure?.code ?? res?.failure ?? res?.stopReason ?? "no answer").slice(0, 200)}`);
    }
    return res;
  }

  async function shortCall(content        , signal             , limits                                                             )
                                                                                         {
    const at = now();
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal.addEventListener("abort", onAbort);
    let timer      = null;
    const late = new Promise       ((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(new Error("timeout")); }, limits.timeoutMs); });
    try {
      const res      = await Promise.race([ask([{ role: "user", content }], stop.signal, limits), late]);
      return { text: res.text, model: typeof res.model === "string" ? res.model : null, usage: res.usage ?? null, ms: now() - at };
    } catch (err     ) {
      return { text: null, error: String(err?.message ?? err).slice(0, 200), model: null, usage: null, ms: now() - at };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  async function thinkUp(game           , signal             )                   {
    const res = await shortCall(programCardFrameIdeaAsk(game), signal,
      { maxTokens: FRAME_IDEA_MAX_TOKENS, reasoning: FRAME_IDEA_REASONING, timeoutMs: FRAME_IDEA_TIMEOUT_MS });
    if (res.error) return { idea: null, error: res.error, ms: res.ms };
    const idea = frameIdeaOf(res.text);
    return { idea, ...(idea ? {} : { error: "no_line" }), model: res.model, usage: res.usage, ms: res.ms };
  }

  const prepared = new Map                                                                            ();
  const ideaKeyOf = (game           ) => {
    const plan = (game.plan ?? []).map((line) => line.trim()).filter(Boolean);
    return plan.length ? JSON.stringify(["plan", plan, game.style ?? ""]) : JSON.stringify([game.title ?? "", game.request ?? "", game.style ?? ""]);
  };
  function takePrepared(job          )                          {
    const early = prepared.get(job.sessionKey);
    prepared.delete(job.sessionKey);
    if (!early) return null;
    if (early.key === ideaKeyOf(job.game)) return early.thought;
    early.abort.abort();
    return null;
  }

  async function tryScript(job          , code        , units        )                                                {
    if (code.length > FRAME_CODE_MAX || framePayloadLength(code) > FRAME_PAYLOAD_MAX) {
      return { ok: false, error: `the script is ${code.length} characters; keep it under ${FRAME_CODE_MAX} (and short on quotes and line breaks)` };
    }
    const drawn = await deps.draw(job.sessionKey, code);
    if (!drawn.ok) return { ok: false, error: drawn.error };
    const saved = saveFrameDrawing(drawn.screen, drawn.out, job.layout, units);
    if (!saved.ok) return saved;
    const seams = frameSeamsOf(frameScreenOf(drawn.screen, saved.view, saved.art, saved.words), saved.view, saved.words,
      frameLayoutMovable(job.layout), frameLayoutMovable(job.layout) && !!frameCentredView(job.layout), saved.art);
    return { ...saved, seams };
  }

  async function run(job          , lane      )                       {
    const started = now();
    const units = frameArtUnits(job.layout);
    let tries = 0, usage      = null, model                = null, kept               = null;

    let ruleAsked                = null;

    let fresh = false, replyHead                = null;
    const ruleField = () => ({ ...(ruleAsked === null ? {} : { ruleAsked }), ...(fresh ? { fresh } : {}), ...(replyHead === null ? {} : { replyHead }) });

    let ideaMs                = null;
    const ideaField = () => (ideaMs === null ? {} : { ideaMs });
    const fail = (error        ) => {
      lane.reason = error;
      debug("program_card_frame_lane", "warn", { ok: false, error: error.slice(0, 300), tries, model, ms: now() - started, usage, ...ruleField(), ...ideaField() }, job.sessionKey);
      return "failed"         ;
    };

    const wireUp = async (frame       , seamRepair                        ) => {
      lane.frame = frame;
      if (frame.place) lane.placedKey = layoutKeyOf(frame.view, frame.words);
      const wired = await deps.wire(job, frame);
      debug("program_card_frame_lane", wired.ok ? "debug" : "warn", { ok: wired.ok, error: wired.error ?? null, tries, model,
        ms: now() - started, pngBytes: frame.png.length, view: frame.view, art: frame.art, usage,

        tileLayout: frame.tileLayout ?? null, cutPx: frame.seams.cut,
        seams: frame.seams.issues.length ? frame.seams.issues : null, seamRepair,

        ...(kept ? { seamsAsked: kept.seams.issues.slice(0, 2) } : {}), ...ruleField(), ...ideaField() }, job.sessionKey);
      if (!wired.ok) { lane.reason = `wire: ${wired.error ?? "refused"}`; return "failed"         ; }
      return "wired"         ;
    };
    try {

      let idea                = null;
      let wanted = false;
      try { wanted = deps.idea?.(job) === true; } catch { wanted = false; }
      if (wanted) {
        const at = now();

        const early = takePrepared(job);
        const thought = await (early ?? thinkUp(job.game, lane.abort.signal));
        ideaMs = now() - at;
        if (lane.abort.signal.aborted) return "skipped";
        idea = thought.idea;
        debug("program_card_frame_idea", idea ? "debug" : "warn", { ok: !!idea, ms: thought.ms ?? ideaMs, waitMs: ideaMs, early: !!early,
          chars: idea?.length ?? 0, ...(thought.error ? { error: thought.error } : {}), model: thought.model ?? null, usage: thought.usage ?? null }, job.sessionKey);
        if (idea) {
          lane.idea = idea;
          try { deps.onIdea?.(job, idea); } catch {  }
        }
      }
      const brief = programCardFrameDrawAsk(job.game, job.layout, idea);
      let messages        = [{ role: "user", content: brief }];
      for (;;) {
        tries += 1;
        const res = await ask(messages, lane.abort.signal, frameDrawLimits(job.detail));
        usage = res.usage ?? usage;
        model = typeof res.model === "string" ? res.model : model;
        const code = frameScriptOf(res.text);

        const fences = typeof res.text === "string" ? res.text.split("```").length - 1 : 0;
        const cutOff = !code && (CUT_OFF.has(res.stopReason) || fences % 2 === 1);
        const result = code ? await tryScript(job, code, units)
          : { ok: false         , error: cutOff ? "the reply was cut off before the script ended" : "the reply held no ```js script" };

        if (!code) replyHead = typeof res.text === "string" ? res.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
        if (lane.abort.signal.aborted) return "skipped";

        if (!code && !cutOff && !fresh && (ruleAsked !== null || tries === 1)) {
          fresh = true;
          messages = [{ role: "user", content: brief }];
          continue;
        }

        if (code && result.ok && !result.seams.ok && tries < 2) {
          kept = result;
          messages = [{ role: "user", content: frameRepairMessage(brief, code,
            `The host drew it and measured the seams: ${result.seams.issues.slice(0, 2).join("; ")}.`) }];
          continue;
        }
        if (result.ok) {
          const worse = !!kept && result.seams.issues.length > kept.seams.issues.length;
          return wireUp(worse ? kept          : result, kept ? (worse ? "kept" : "took") : null);
        }
        if (kept) return wireUp(kept, "kept");

        if (ruleAsked !== null || !code) return fail(result.error);
        ruleAsked = result.error.slice(0, 200);

        messages = [{ role: "user", content: frameRepairMessage(brief, code, `The host could not use it: ${result.error}.`) }];
      }
    } catch (err     ) {
      if (lane.abort.signal.aborted) return "skipped";
      const reason = String(err?.message ?? err).slice(0, 300);

      if (kept) {
        debug("program_card_frame_lane", "warn", { repair: "seams", ok: false, error: reason, tries, model, ms: now() - started }, job.sessionKey);
        return wireUp(kept, "kept").catch((e     ) => fail(String(e?.message ?? e).slice(0, 300)));
      }
      return fail(reason);
    }
  }

  function skip(job          , reason        ) {
    debug("program_card_frame_lane", "debug", { ok: false, skipped: reason }, job.sessionKey);
    return { status: "skipped"         , reason };
  }

  return {

    start(job          )                                           {
      if (typeof deps.complete !== "function") return skip(job, "no_model_call");
      const layoutKey = layoutKeyOf(job.layout.view, job.layout.words.map((w) => w.box));
      const was = lanes.get(job.sessionKey);
      const same = was && was.cardId === job.cardId ? was : null;
      if (same && (same.layoutKey === layoutKey || same.placedKey === layoutKey || same.status === "failed" || same.starts >= FRAME_STARTS_PER_CARD)) {
        return { status: same.status, ...(same.reason ? { reason: same.reason } : {}) };
      }
      const cannot = frameSkipReason(job.layout, same?.frame?.art.length ?? 0);
      if (cannot) return skip(job, cannot);
      same?.abort.abort();
      const lane       = { cardId: job.cardId, job, layoutKey, status: "drawing", starts: (same?.starts ?? 0) + 1,
        abort: new AbortController(), done: Promise.resolve("drawing") };
      lanes.delete(job.sessionKey);
      lanes.set(job.sessionKey, lane);
      while (lanes.size > MAX_SESSIONS) {
        const oldest = lanes.keys().next().value          ;
        lanes.get(oldest)?.abort.abort();
        lanes.delete(oldest);
      }

      debug("program_card_frame_lane_start", "debug", { cardId: job.cardId, view: job.layout.view, words: job.layout.words.length,
        units: frameArtUnits(job.layout), start: lane.starts, from: job.from ?? "report", detail: frameDetailOf(job.detail) ?? FRAME_DETAIL_DEFAULT,

        centred: frameLayoutMovable(job.layout) ? frameCentredView(job.layout) : null }, job.sessionKey);
      lane.done = outsideHostWorkScope(() => run(job, lane)).then((status) => (lane.status = status));
      return { status: "drawing" };
    },

    prepareIdea(job                                                         )          {
      try {
        if (typeof deps.complete !== "function" || deps.idea?.(job            ) !== true) return false;
      } catch { return false; }
      const key = ideaKeyOf(job.game);
      if (prepared.get(job.sessionKey)?.key === key) return false;
      if (lanes.get(job.sessionKey)?.status === "drawing") return false;
      prepared.get(job.sessionKey)?.abort.abort();
      const abort = new AbortController();
      const thought = outsideHostWorkScope(() => thinkUp(job.game, abort.signal));
      prepared.set(job.sessionKey, { key, thought, abort });
      while (prepared.size > MAX_SESSIONS) {
        const oldest = prepared.keys().next().value          ;
        prepared.get(oldest)?.abort.abort();
        prepared.delete(oldest);
      }
      debug("program_card_frame_idea_start", "debug", { cardId: job.cardId }, job.sessionKey);
      return true;
    },

    status(sessionKey        , cardId                ) {
      const lane = lanes.get(sessionKey);
      if (!lane || (cardId && lane.cardId !== cardId)) return null;
      return { status: lane.status, ...(lane.reason ? { reason: lane.reason } : {}) };
    },

    async settled(sessionKey        )                              {
      let lane = lanes.get(sessionKey);
      while (lane) {
        const status = await lane.done;
        const next = lanes.get(sessionKey);
        if (!next || next === lane || next.cardId !== lane.cardId) return status;
        lane = next;
      }
      return null;
    },

    async wait(sessionKey        , ms        )                              {
      const lane = lanes.get(sessionKey);
      if (!lane) return null;
      if (lane.status !== "drawing") return lane.status;
      let timer     ;
      const late = new Promise             ((resolve) => { timer = setTimeout(() => resolve("drawing"), Math.max(0, ms)); });
      try { return await Promise.race([lane.done, late]); } finally { clearTimeout(timer); }
    },

    frameOf(sessionKey        , cardId        )                    {
      const lane = lanes.get(sessionKey);
      return lane && lane.cardId === cardId && lane.status === "wired" && lane.frame ? lane.frame : null;
    },

    briefOf(sessionKey        , cardId        )                    {
      const lane = lanes.get(sessionKey);
      return lane && lane.cardId === cardId && lane.status === "wired" ? { layout: lane.job.layout, game: lane.job.game } : null;
    },

    adopt(sessionKey        , cardId        , frame                   , brief                   ) {
      const was = lanes.get(sessionKey);
      const same = was && was.cardId === cardId ? was : null;

      const job = brief ? { sessionKey, cardId, game: brief.game, layout: brief.layout } : same?.job;
      was?.abort.abort();
      if (!job) { lanes.delete(sessionKey); return; }
      const lane       = { cardId, job,
        layoutKey: layoutKeyOf(job.layout.view, job.layout.words.map((w) => w.box)), status: "wired",
        ...(frame ? {} : { reason: "removed" }), starts: same?.starts ?? 1, abort: new AbortController(),
        done: Promise.resolve("wired"         ), ...(frame ? { frame } : {}),
        ...(frame?.place ? { placedKey: layoutKeyOf(frame.view, frame.words) } : {}) };
      lanes.delete(sessionKey);
      lanes.set(sessionKey, lane);
      while (lanes.size > MAX_SESSIONS) lanes.delete(lanes.keys().next().value          );
    },

    forget(sessionKey        , { keepIdea = false } = {}) {
      lanes.get(sessionKey)?.abort.abort();
      lanes.delete(sessionKey);
      if (keepIdea) return;
      prepared.get(sessionKey)?.abort.abort();
      prepared.delete(sessionKey);
    },
  };
}

module.exports = { PROGRAM_CARD_FRAME_DRAW_CAPABILITY, FRAME_LANE_PURPOSE, FRAME_MODEL_MAX_TOKENS, FRAME_MODEL_TIMEOUT_MS, FRAME_MODEL_REASONING, FRAME_DETAILS, FRAME_DETAIL_DEFAULT, FRAME_DETAIL_TIMEOUT_MS, frameDetailOf, frameDrawLimits, PROGRAM_CARD_FRAME_IDEA_CAPABILITY, FRAME_IDEA_REASONING, FRAME_IDEA_MAX_TOKENS, FRAME_IDEA_TIMEOUT_MS, FRAME_IDEA_MAX, FRAME_CODE_MAX, FRAME_PAYLOAD_MAX, FRAME_MODEL_MESSAGE_MAX, frameRepairMessage, FRAME_SCENE_TILES, programCardFrameLayout, frameLayoutMovable, FRAME_CENTRE_SLACK, frameCentredView, frameArtUnits, frameTileMenu, frameBlackEdges, frameSkipReason, programCardFrameBriefFree, framePlacementOf, frameLeastWidth, programCardFrameBrief, programCardFrameDrawAsk, programCardFrameIdeaAsk, frameIdeaOf, FRAME_CUT_RUN, FRAME_CUT_MAX, frameFlatCuts, frameSeamsOf, frameScriptOf, outsideHostWorkScope, saveFrameDrawing, createProgramCardFrameLane };
