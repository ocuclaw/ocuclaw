const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { getTextWidth, measureTextWrap } = require("./glasses-ui-font-measure.cjs");
const { GLASSES_UI_FIT_BUDGETS, titleBudgetPx } = require("./glasses-ui-fit.cjs");

const ELLIPSIS = "…";

const PAGE_BUDGET = Object.freeze({
  width: GLASSES_UI_FIT_BUDGETS.wideContentInnerW,
  maxLines: GLASSES_UI_FIT_BUDGETS.fullReaderMaxVisibleLines,
});

const GLASSES_UI_REPAIR_MAX_PASSES = 128;

function pastCombiningMarks(cps     , index     ) {
  let i = index;
  while (i < cps.length && /\p{M}/u.test(cps[i])) i += 1;
  return i;
}

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value     ) {
  return typeof value === "string" && value.trim().length > 0;
}

function wrappedLines(text     , width     ) {
  return Math.max(1, measureTextWrap(text || "", width).lineCount);
}

function fitsBudget(text     , budget     , maxChars     ) {
  if (typeof maxChars === "number" && text.length > maxChars) return false;
  if (!budget) return true;
  return wrappedLines(text, budget.width) <= budget.maxLines;
}

function longestPrefix(cps     , fits     ) {
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(cps.slice(0, mid).join(""))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function wordBoundaryBefore(cps     , at     ) {
  for (let i = Math.min(at, cps.length - 1); i >= 0; i -= 1) {
    if (/\s/.test(cps[i])) return i;
  }
  return -1;
}

function cutToFit(text     , fits     ) {
  const whole = String(text);
  if (fits(whole)) return whole;
  const cps = Array.from(whole);
  const n = longestPrefix(cps, (prefix     ) => fits(prefix.trimEnd() + ELLIPSIS));
  const boundary = wordBoundaryBefore(cps, n);
  let cut = boundary >= Math.ceil(n / 2) ? boundary : n;

  while (cut > 0 && cut < cps.length && /\p{M}/u.test(cps[cut])) cut -= 1;
  return cps.slice(0, cut).join("").trimEnd() + ELLIPSIS;
}

function packPages(text     , opts     ) {
  const width = opts && opts.width ? opts.width : PAGE_BUDGET.width;
  const maxLines = opts && opts.maxLines ? opts.maxLines : PAGE_BUDGET.maxLines;
  const maxChars = opts && opts.maxChars ? opts.maxChars : GLASSES_UI_LIMITS.pageMax;
  const pages      = [];
  let rest = Array.from(String(text).trim());
  while (rest.length > 0) {
    const joined = rest.join("");
    const measured = measureTextWrap(joined, width);
    if (measured.lineCount <= maxLines && joined.length <= maxChars) {
      pages.push(joined);
      break;
    }
    let cut = measured.lineCount > maxLines ? measured.lineStartOffsets[maxLines] : rest.length;

    while (cut > 1 && rest.slice(0, cut).join("").length > maxChars) {
      const boundary = wordBoundaryBefore(rest, cut - 2);
      cut = boundary > 0 ? boundary : cut - 1;
    }
    const half = Math.ceil(cut / 2);
    for (let i = cut - 1; i >= half; i -= 1) {
      if (rest[i] === "\n") {
        cut = i + 1;
        break;
      }
    }

    while (cut > 1 && wrappedLines(rest.slice(0, cut).join("").trim(), width) > maxLines) cut -= 1;
    cut = pastCombiningMarks(rest, cut);
    if (cut <= 0) cut = 1;
    const page = rest.slice(0, cut).join("").trim();
    if (page.length > 0) pages.push(page);
    rest = rest.slice(cut);
    while (rest.length > 0 && /\s/.test(rest[0])) rest.shift();
  }
  return pages;
}

function capPages(pages     , maxPages     , budget     , maxChars     ) {
  if (pages.length <= maxPages) return { pages, folded: 0 };
  const kept = pages.slice(0, maxPages - 1);
  const tail = pages.slice(maxPages - 1).join("\n");
  kept.push(cutToFit(tail, (candidate     ) => fitsBudget(candidate, budget, maxChars)));
  return { pages: kept, folded: pages.length - maxPages };
}

function slotCaption(slot     ) {
  if (!isRecord(slot)) return "";
  if (slot.type === "keyvalue" && Array.isArray(slot.rows) && Array.isArray(slot.rows[0])) {
    return slot.rows[0].filter(isText).join(" ");
  }
  const reading = [slot.value, slot.unit]
    .filter((part     ) => typeof part === "number" || isText(part))
    .map(String)
    .join(" ");
  return [slot.label, slot.text, reading].filter(isText).join(" ").trim();
}

function captionFromSlots(graphic     ) {
  const slots = isRecord(graphic) && Array.isArray(graphic.slots) ? graphic.slots : [];
  const parts = slots.map((slot     ) => slotCaption(slot)).filter(isText);
  if (parts.length === 0) return "";
  const joined = parts.join(" · ");
  return cutToFit(joined, (candidate     ) => candidate.length <= GLASSES_UI_LIMITS.graphicCaptionMax);
}

function withoutField(obj     , field     ) {
  const next = { ...obj };
  delete next[field];
  return next;
}

function pathIndex(path     , head     ) {
  const match = new RegExp(`^${head}\\[(\\d+)\\]`).exec(path);
  return match ? Number(match[1]) : -1;
}

function repairOne(obj     , code     , path     , refusal     , opts     )      {
  const childOf = Boolean(opts && opts.childOf);
  const budget = refusal && isRecord(refusal.budget) && refusal.budget.maxLines ? refusal.budget : null;
  switch (code) {
    case "body_too_long": {
      if (obj.kind !== "text_surface" || typeof obj.body !== "string") return null;
      if (obj.template === "graphic" || obj.template === "image_caption") {
        const max = obj.template === "graphic" ? GLASSES_UI_LIMITS.graphicCaptionMax : GLASSES_UI_LIMITS.imageCaptionMax;
        const body = cutToFit(obj.body, (candidate     ) => fitsBudget(candidate, budget, max));
        if (body === obj.body) return null;
        return {
          spec: { ...obj, body },
          repair: {
            code: "caption_trimmed",
            path: "body",
            message: `body was ${obj.body.length} chars and wrapped past the caption's lines; cut to ${body.length} with an ellipsis`,
          },
        };
      }

      if (obj.refresh !== undefined) return null;
      const maxPages = childOf ? GLASSES_UI_LIMITS.maxChildPages : GLASSES_UI_LIMITS.maxPages;
      const packed = packPages(obj.body, { ...PAGE_BUDGET, maxChars: GLASSES_UI_LIMITS.pageMax });
      const lines = wrappedLines(obj.body, PAGE_BUDGET.width);

      if (packed.length === 1 && packed[0] !== obj.body) {
        return {
          spec: { ...obj, body: packed[0] },
          repair: {
            code: "body_trimmed",
            path: "body",
            message: `body wrapped to ${lines} lines at ${PAGE_BUDGET.width} px; max ${PAGE_BUDGET.maxLines}. Blank lines around it were removed and it fits`,
          },
        };
      }
      if (packed.length < 2) return null;
      const capped = capPages(packed, maxPages, PAGE_BUDGET, GLASSES_UI_LIMITS.pageMax);
      const spec = withoutField(obj, "body");
      spec.kind = "paged_text_surface";
      spec.pages = capped.pages;

      const title = fitTitleForPages(spec.title, capped.pages.length);
      if (title !== undefined) spec.title = title.text;
      return {
        spec,
        repair: {
          code: "body_paged",
          path: "body",
          message:
            `body wrapped to ${lines} lines at ${PAGE_BUDGET.width} px; max ${PAGE_BUDGET.maxLines}. ` +
            `Split into ${capped.pages.length} pages as paged_text_surface` +
            (title !== undefined && title.cut ? " (title cut with an ellipsis to fit beside the page cue)" : " (title kept)") +
            (capped.folded > 0 ? `; ${capped.folded} more pages were folded into the last one with an ellipsis` : ""),
        },
      };
    }
    case "title_too_long": {
      if (typeof obj.title !== "string") return null;
      const maxPx = refusal && isRecord(refusal.budget) && typeof refusal.budget.maxPx === "number" ? refusal.budget.maxPx : null;
      const title = cutToFit(obj.title, (candidate     ) =>
        candidate.length <= GLASSES_UI_LIMITS.titleMax && (maxPx === null || getTextWidth(candidate) <= maxPx));
      if (title === obj.title) return null;
      return {
        spec: { ...obj, title },
        repair: {
          code: "title_trimmed",
          path: "title",
          message: `title was ${obj.title.length} chars and overflowed the title lane; cut to ${title.length} with an ellipsis`,
        },
      };
    }
    case "page_too_long": {
      const index = pathIndex(path, "pages");
      if (index < 0 || !Array.isArray(obj.pages) || typeof obj.pages[index] !== "string") return null;
      const split = packPages(obj.pages[index], { ...PAGE_BUDGET, maxChars: GLASSES_UI_LIMITS.pageMax });
      if (split.length < 2) return null;
      const maxPages = childOf ? GLASSES_UI_LIMITS.maxChildPages : GLASSES_UI_LIMITS.maxPages;
      const pages = [...obj.pages.slice(0, index), ...split, ...obj.pages.slice(index + 1)];
      const capped = capPages(pages, maxPages, PAGE_BUDGET, GLASSES_UI_LIMITS.pageMax);
      return {
        spec: { ...obj, pages: capped.pages },
        repair: {
          code: "page_split",
          path,
          message:
            `${path} wrapped past ${PAGE_BUDGET.maxLines} lines at ${PAGE_BUDGET.width} px; split into ${split.length} pages` +
            (capped.folded > 0 ? `; ${capped.folded} pages past ${maxPages} were folded into the last one with an ellipsis` : ""),
        },
      };
    }
    case "detail_body_too_long": {
      const index = pathIndex(path, "items");
      if (index < 0) return null;
      const fits = (candidate     ) => fitsBudget(candidate, budget, GLASSES_UI_LIMITS.detailBodyMax);
      const item = Array.isArray(obj.items) ? obj.items[index] : undefined;
      if (isRecord(item) && typeof item.body === "string") {
        const body = cutToFit(item.body, fits);
        if (body === item.body) return null;
        const items = obj.items.slice();
        items[index] = { ...item, body };
        return { spec: { ...obj, items }, repair: detailTrimmed(path, item.body, body) };
      }

      if (Array.isArray(obj.details) && typeof obj.details[index] === "string") {
        const body = cutToFit(obj.details[index], fits);
        if (body === obj.details[index]) return null;
        const details = obj.details.slice();
        details[index] = body;
        return { spec: { ...obj, details }, repair: detailTrimmed(path, obj.details[index], body) };
      }
      return null;
    }
    case "missing_field": {

      if (obj.template !== "graphic" || obj.body !== undefined || path !== "body") return null;
      const blank = { ...obj, body: "" };
      return isText(obj.title)
        ? repairOne(blank, "graphic_title_unsupported", "title", refusal, opts)
        : repairOne(blank, "graphic_body_required", "body", refusal, opts);
    }
    case "graphic_body_required": {
      if (obj.template !== "graphic") return null;
      const body = typeof obj.body === "string" ? obj.body : "";
      if (body.trim().length === 0) {
        const caption = captionFromSlots(obj.graphic);
        if (!caption) return null;
        return {
          spec: { ...obj, body: caption },
          repair: {
            code: "graphic_caption_synthesized",
            path: "body",
            message: `body was blank; the caption was built from the slots' own text: ${JSON.stringify(caption)}`,
          },
        };
      }
      const cut = cutToFit(body, (candidate     ) => candidate.length <= GLASSES_UI_LIMITS.graphicCaptionMax);
      if (cut === body) return null;
      return {
        spec: { ...obj, body: cut },
        repair: {
          code: "caption_trimmed",
          path: "body",
          message: `body was ${body.length} chars; cut to ${cut.length} with an ellipsis (max ${GLASSES_UI_LIMITS.graphicCaptionMax})`,
        },
      };
    }
    case "image_caption_too_long": {
      if (obj.template !== "image_caption" || !isText(obj.body)) return null;
      const cut = cutToFit(obj.body, (candidate     ) => candidate.length <= GLASSES_UI_LIMITS.imageCaptionMax);
      if (cut === obj.body) return null;
      return {
        spec: { ...obj, body: cut },
        repair: {
          code: "caption_trimmed",
          path: "body",
          message: `body was ${obj.body.length} chars; cut to ${cut.length} with an ellipsis (max ${GLASSES_UI_LIMITS.imageCaptionMax})`,
        },
      };
    }
    case "graphic_title_unsupported": {
      if (obj.template !== "graphic" || typeof obj.title !== "string") return null;
      const spec = withoutField(obj, "title");
      if (!isText(obj.body) && isText(obj.title)) {
        spec.body = obj.title;
        return {
          spec,
          repair: {
            code: "graphic_title_folded",
            path: "title",
            message: "graphic has no title; the title became the caption because body was blank",
          },
        };
      }
      return {
        spec,
        repair: {
          code: "graphic_title_dropped",
          path: "title",
          message: "graphic has no title; it was removed and the caption kept",
        },
      };
    }
    default:
      return null;
  }
}

function pagedTitleBudgetPx(pageCount     ) {
  const B = GLASSES_UI_FIT_BUDGETS;
  const cueWidth = Math.max(
    ...Array.from({ length: pageCount }, (_unused     , index     ) => getTextWidth(`${index + 1}/${pageCount}`)),
  );
  const markerX = B.cueRightEdge - cueWidth - B.cueExactPad - B.markerGutter - B.markerW;
  return titleBudgetPx(markerX - B.markerGutter);
}

function fitTitleForPages(title     , pageCount     ) {
  if (typeof title !== "string" || title.length === 0) return undefined;
  const budget = pagedTitleBudgetPx(pageCount);
  const text = cutToFit(title, (candidate     ) => getTextWidth(candidate) <= budget);
  return { text, cut: text !== title };
}

function detailTrimmed(path     , before     , after     ) {
  return {
    code: "detail_body_trimmed",
    path,
    message: `${path} was ${before.length} chars and overflowed the detail frame; cut to ${after.length} with an ellipsis`,
  };
}

function repairGlassesUiRefusal(input     , refusal     ) {
  if (!isRecord(input) || !isRecord(refusal) || refusal.ok !== false) return null;
  const code = String(refusal.code || "").replace(/^child_/, "");
  const path = typeof refusal.path === "string" ? refusal.path : "";
  const child = /^children\[(\d+)\]\.(.+)$/.exec(path);
  if (child) {
    const index = Number(child[1]);
    const children = Array.isArray(input.children) ? input.children : null;
    if (!children || !isRecord(children[index])) return null;
    const inner = repairOne(children[index], code, child[2], refusal, { childOf: true });
    if (!inner) return null;
    const next = children.slice();
    next[index] = inner.spec;
    return { spec: { ...input, children: next }, repair: { ...inner.repair, path } };
  }
  return repairOne(input, code, path, refusal, { childOf: false });
}

module.exports = { GLASSES_UI_REPAIR_MAX_PASSES, cutToFit, packPages, repairGlassesUiRefusal };
