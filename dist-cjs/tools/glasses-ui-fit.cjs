const { getTextWidth, measureTextWrap } = require("./glasses-ui-font-measure.cjs");

const GLASSES_UI_FIT_BUDGETS = {

  canvasW: 576,
  canvasH: 288,
  headerH: 49,
  markerX: 548,
  markerW: 22,
  markerGutter: 8,
  titleLaneX: 16,
  cueRightEdge: 560,
  cueExactPad: 16,
  titleChipExtraW: 24,
  cuedChipMaxW: 504,
  cuedTitleCueGap: 8,
  cueOverlaySlack: 6,
  contentPadding: 0,
  frameBorderWidth: 0,

  narrowContentInnerW: 430,
  mediumContentInnerW: 550,
  wideContentInnerW: 550,
  captionPriorityInnerW: 540,
  imageCaptionGap: 8,
  fullReaderMaxVisibleLines: 8,
  centeredListMaxItems: 3,
  focusListMaxItems: 6,
  focusListMaxLines: 2,
  checklistUncheckedMark: "[ ] ",
  checklistCheckedMark: "[x] ",
  childCueSuffix: " ›",
  splitLabelInnerW: 178,
  splitDetailInnerW: 359,
  detailSpotlightMaxItems: 2,
  splitRailMaxItems: 5,
  detailsShortMaxLines: 2,
  detailSpotlightVisibleRows: 2,
  splitRailVisibleRows: 5,
  stackedReaderVisibleRows: 2,
  detailsGap: 12,
  detailSpotlightMinDetailLines: 3,
};

const B = GLASSES_UI_FIT_BUDGETS;

const TITLE_LANE_W = B.markerX - B.markerGutter - B.titleLaneX;
const POST_HEADER_H = B.canvasH - B.headerH;

let cachedLineHeight = 0;
function lineHeight() {
  if (!cachedLineHeight) {
    const measured = measureTextWrap("Ag", B.wideContentInnerW);
    cachedLineHeight = Math.max(1, Math.round(measured.height / Math.max(1, measured.lineCount)));
  }
  return cachedLineHeight;
}

function wrappedLines(text, width) {
  return Math.max(1, measureTextWrap(text || "", width).lineCount);
}

function longestPrefix(text, fits) {
  const chars = Array.from(text || "");
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(chars.slice(0, mid).join(""))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function approxCharsForWidth(text, maxPx) {
  return longestPrefix(text, (prefix) => getTextWidth(prefix) <= maxPx);
}

function approxCharsForLines(text, width, maxLines) {
  return longestPrefix(text, (prefix) => wrappedLines(prefix, width) <= maxLines);
}

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function widthError(code, field, text, maxPx, advice) {
  const measured = getTextWidth(text);
  if (measured <= maxPx) return null;
  return {
    ok: false,
    code,
    message:
      `${field} is ${measured} px wide; max ${maxPx} px ` +
      `(about ${approxCharsForWidth(text, maxPx)} chars at this size) — ${advice}`,
  };
}

function linesError(code, field, text, width, maxLines, advice) {
  const measured = wrappedLines(text, width);
  if (measured <= maxLines) return null;
  return {
    ok: false,
    code,
    message:
      `${field} wraps to ${plural(measured, "line")} at ${width} px; ` +
      `max ${plural(maxLines, "line")} ` +
      `(about ${approxCharsForLines(text, width, maxLines)} chars at this size) — ${advice}`,
  };
}

function titleBudgetPx(rightLimit) {
  return Math.max(0, rightLimit - B.titleLaneX - B.cueOverlaySlack);
}

function checkTitle(spec) {
  const title = spec.title;
  if (typeof title !== "string" || title.length === 0) return null;
  const cuedCount =
    spec.kind === "paged_text_surface" ? spec.pages?.length :
      spec.kind === "list_surface" || spec.kind === "checklist_surface" || spec.kind === "list_with_details_surface"
        ? spec.items?.length : null;
  if (Number.isInteger(cuedCount) && cuedCount > 0) {
    const cueWidth = Math.max(
      ...Array.from({ length: cuedCount }, (_unused, index) => getTextWidth(`${index + 1}/${cuedCount}`)),
    );
    const markerX = B.cueRightEdge - cueWidth - B.cueExactPad - B.markerGutter - B.markerW;
    const budget = titleBudgetPx(markerX - B.markerGutter);
    return widthError("title_too_long", "title", title, budget, "shorten it");
  }
  return widthError("title_too_long", "title", title, titleBudgetPx(B.titleLaneX + TITLE_LANE_W), "shorten it");
}

function checkTextBody(spec) {
  return linesError(
    "body_too_long",
    "body",
    spec.body,
    B.wideContentInnerW,
    B.fullReaderMaxVisibleLines,
    'trim it or use paged_text_surface',
  );
}

function checkImageCaption(spec) {

  const imageHeight = spec.imageHeight ?? 144;
  const maxLines = Math.max(1, Math.floor((POST_HEADER_H - imageHeight - B.imageCaptionGap) / lineHeight()));
  return linesError("body_too_long", "body", spec.body, B.wideContentInnerW, maxLines, "shorten the caption");
}

function checkPages(spec) {

  for (let i = 0; i < spec.pages.length; i += 1) {
    const err = linesError(
      "page_too_long",
      `pages[${i}]`,
      spec.pages[i],
      B.wideContentInnerW,
      B.fullReaderMaxVisibleLines,
      "split it across more pages",
    );
    if (err) return err;
  }
  return null;
}

function worstRowLines(variants, width) {
  return Math.max(...variants.map((row) => wrappedLines(row, width)));
}

function pretextPadAtLeast(target) {
  for (let width = target; ; width += 1) {
    for (let graves = 0; graves <= Math.floor(width / 4); graves += 1) {
      const remaining = width - graves * 4;
      if (remaining % 5 === 0) return " ".repeat(remaining / 5) + "̀".repeat(graves);
    }
  }
}

let checklistMarks = null;
function checklistRow(label, checked) {
  if (!checklistMarks) {
    const candidates = ["[", "[̀x"].map((prefix) => {
      const widths = new Map();
      for (let width = 4; width <= 52; width += 1) {
        const value = prefix + pretextPadAtLeast(width - 4) + "̀";
        widths.set(getTextWidth(value), value);
      }
      return widths;
    });
    const common = [...candidates[0].keys()].filter((width) => candidates[1].has(width));
    if (common.length === 0) throw new Error("Native checkbox interiors must share a measurable width");
    const target = Math.min(...common);
    checklistMarks = candidates.map((widths) => widths.get(target) + "] " + pretextPadAtLeast(12));
  }
  return checklistMarks[checked ? 1 : 0] + label;
}

function rowSuffixesFor(spec) {
  const children = Array.isArray(spec && spec.children) ? spec.children : [];
  return (i) => (children[i] ? B.childCueSuffix : "");
}

function checkMeasuredList(labels, rowVariants, field, suffixAt = () => "") {
  const variants = labels.map((label, i) => rowVariants(label, i));
  const width = Math.min(B.wideContentInnerW - getTextWidth("> "),
    Math.max(1, ...variants.flat().map(getTextWidth)) + B.cueOverlaySlack);
  const maxLines = labels.length <= B.focusListMaxItems ? B.focusListMaxLines : 1;
  for (let i = 0; i < labels.length; i += 1) {
    const rowLines = suffixAt(i) ? 1 : maxLines;
    const measured = worstRowLines(variants[i], width);
    if (measured <= rowLines) continue;

    const widest = variants[i].reduce((a, b) => (getTextWidth(a) >= getTextWidth(b) ? a : b));
    return linesError(
      "item_too_long",
      field(i),
      widest,
      width,
      rowLines,
      suffixAt(i) ? "shorten it (a row that opens a child stays on one line)" : "shorten it",
    );
  }
  return null;
}

function detailsLayout(items, suffixAt = () => "") {
  const bodyOf = (item) => (typeof item.body === "string" ? item.body : "");
  const labelInnerWidth = Math.min(B.wideContentInnerW - getTextWidth("> "),
    Math.max(1, ...items.map((item, i) => getTextWidth(item.label + suffixAt(i)))) + B.cueOverlaySlack);
  const labelLines = Math.min(2, Math.max(1, ...items.map((item, i) =>
    suffixAt(i) ? 1 : wrappedLines(item.label, labelInnerWidth))));

  const detailInnerWidth = B.wideContentInnerW;
  const maximumDetailLines = Math.min(4, B.fullReaderMaxVisibleLines - Math.min(items.length, 2) * labelLines - 1);
  const detailCapacity = Math.min(maximumDetailLines,
    Math.max(1, ...items.map((item) => wrappedLines(bodyOf(item), detailInnerWidth))));
  return { labelInnerWidth, labelLines, detailInnerWidth, detailCapacity, bodyOf };
}

function checkListWithDetails(items, suffixAt = () => "") {
  const layout = detailsLayout(items, suffixAt);
  for (let i = 0; i < items.length; i += 1) {

    const labelErr = linesError(
      "item_too_long",
      `items[${i}].label`,
      items[i].label + suffixAt(i),
      layout.labelInnerWidth,
      suffixAt(i) ? 1 : layout.labelLines,
      "shorten it",
    );
    if (labelErr) return labelErr;
    const bodyErr = linesError(
      "detail_body_too_long",
      `items[${i}].body`,
      layout.bodyOf(items[i]),
      layout.detailInnerWidth,
      layout.detailCapacity,
      "trim it",
    );
    if (bodyErr) return bodyErr;
  }
  return null;
}

function checkGlassesUiFit(spec) {
  if (!spec || typeof spec !== "object") return null;
  const titleErr = checkTitle(spec);
  if (titleErr) return titleErr;
  const parentErr = checkOwnFit(spec);
  if (parentErr) return parentErr;

  if (Array.isArray(spec.children)) {
    for (let i = 0; i < spec.children.length; i += 1) {
      const child = spec.children[i];
      if (!child) continue;
      const childErr = checkGlassesUiFit(child);
      if (childErr) {
        return { ...childErr, message: `children[${i}]: ${childErr.message}` };
      }
    }
  }
  return null;
}

function checkOwnFit(spec) {
  switch (spec.kind) {
    case "text_surface":
      if (spec.template === "image_caption") return checkImageCaption(spec);
      return checkTextBody(spec);
    case "paged_text_surface":
      return checkPages(spec);
    case "list_surface": {
      const suffixAt = rowSuffixesFor(spec);
      return checkMeasuredList(spec.items, (label, i) => [label + suffixAt(i)], (i) => `items[${i}]`, suffixAt);
    }
    case "checklist_surface":
      return checkMeasuredList(
        spec.items.map((item) => item.label),
        (label) => [checklistRow(label, false), checklistRow(label, true)],
        (i) => `items[${i}].label`,
      );
    case "list_with_details_surface":
      return checkListWithDetails(spec.items, rowSuffixesFor(spec));
    default:
      return null;
  }
}

module.exports = { GLASSES_UI_FIT_BUDGETS, titleBudgetPx, checkGlassesUiFit };
