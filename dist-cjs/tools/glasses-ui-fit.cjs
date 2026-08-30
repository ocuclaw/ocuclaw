const { getTextWidth, measureTextWrap } = require("./glasses-ui-font-measure.cjs");

const GLASSES_UI_FIT_BUDGETS = {

  canvasW: 576,
  canvasH: 288,
  headerH: 49,
  markerX: 548,
  markerGutter: 8,
  titleLaneX: 0,
  titleOutlineExtraW: 24,
  contentPadding: 5,
  frameBorderWidth: 1,

  narrowContentInnerW: 430,
  mediumContentInnerW: 520,
  wideContentInnerW: 552,
  fullReaderMaxVisibleLines: 8,
  pagedCountGap: 8,
  centeredListMaxItems: 3,
  focusListMaxItems: 6,
  focusListMaxLines: 2,
  checklistUncheckedMark: "[ ] ",
  checklistCheckedMark: "[x] ",
  splitLabelInnerW: 178,
  splitDetailInnerW: 362,
  detailSpotlightMaxItems: 2,
  splitRailMaxItems: 5,
  detailsShortMaxLines: 2,
  detailSpotlightVisibleRows: 2,
  splitRailVisibleRows: 5,
  stackedReaderVisibleRows: 2,
  detailsGap: 4,
  detailSpotlightMinDetailLines: 3,
};

const B = GLASSES_UI_FIT_BUDGETS;

const TITLE_LANE_W = B.markerX - B.markerGutter;
const POST_HEADER_H = B.canvasH - B.headerH;
const CONTENT_EDGE_W = B.contentPadding + B.frameBorderWidth;
const EDGE_PIXELS = 2 * CONTENT_EDGE_W;

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
  const maxOutlineWidth = Math.max(0, 2 * (rightLimit - B.canvasW / 2));
  return Math.max(0, maxOutlineWidth - B.titleOutlineExtraW);
}

function checkTitle(spec) {
  const title = spec.title;
  if (typeof title !== "string" || title.length === 0) return null;
  let rightLimit = B.titleLaneX + TITLE_LANE_W;
  if (spec.kind === "paged_text_surface" && Array.isArray(spec.pages)) {

    const countWidth = Math.max(
      ...spec.pages.map((_page, index) => getTextWidth(`${index + 1}/${spec.pages.length}`)),
    );
    rightLimit = B.titleLaneX + TITLE_LANE_W - countWidth - B.pagedCountGap;
  }
  return widthError("title_too_long", "title", title, titleBudgetPx(rightLimit), "shorten it");
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

function checkMeasuredList(labels, rowVariants, field) {
  const variants = labels.map(rowVariants);
  const centeredFits =
    labels.length <= B.centeredListMaxItems &&
    variants.every((rows) => worstRowLines(rows, B.narrowContentInnerW) <= 1);
  if (centeredFits) return null;
  const focusFits =
    labels.length <= B.focusListMaxItems &&
    variants.every((rows) => worstRowLines(rows, B.mediumContentInnerW) <= B.focusListMaxLines);
  if (focusFits) return null;
  for (let i = 0; i < labels.length; i += 1) {
    const measured = worstRowLines(variants[i], B.wideContentInnerW);
    if (measured <= 1) continue;

    const widest = variants[i].reduce((a, b) => (getTextWidth(a) >= getTextWidth(b) ? a : b));
    return linesError(
      "item_too_long",
      field(i),
      widest,
      B.wideContentInnerW,
      1,
      "shorten it",
    );
  }
  return null;
}

function detailsLayout(items) {
  const bodyOf = (item) => (typeof item.body === "string" ? item.body : "");
  const spotlightDetailLines = items.map((item) => wrappedLines(bodyOf(item), B.wideContentInnerW));
  const splitLabelLines = items.map((item) => wrappedLines(item.label, B.splitLabelInnerW));
  const splitDetailLines = items.map((item) => wrappedLines(bodyOf(item), B.splitDetailInnerW));
  let mode = "STACKED_READER";
  if (
    items.length <= B.detailSpotlightMaxItems &&
    spotlightDetailLines.every((lines) => lines <= B.detailsShortMaxLines)
  ) {
    mode = "DETAIL_SPOTLIGHT";
  } else if (
    items.length <= B.splitRailMaxItems &&
    splitLabelLines.every((lines) => lines <= 1) &&
    splitDetailLines.every((lines) => lines <= B.detailsShortMaxLines)
  ) {
    mode = "SPLIT_RAIL";
  }
  const labelInnerWidth =
    mode === "DETAIL_SPOTLIGHT"
      ? B.narrowContentInnerW
      : mode === "SPLIT_RAIL"
        ? B.splitLabelInnerW
        : B.wideContentInnerW;
  const detailInnerWidth = mode === "SPLIT_RAIL" ? B.splitDetailInnerW : B.wideContentInnerW;
  const visibleRows =
    mode === "DETAIL_SPOTLIGHT"
      ? B.detailSpotlightVisibleRows
      : mode === "SPLIT_RAIL"
        ? B.splitRailVisibleRows
        : B.stackedReaderVisibleRows;
  const lh = lineHeight();
  const labelOuterHeight = (visibleRows + 1) * lh + EDGE_PIXELS;

  const spotlightDetailHeight =
    Math.max(...spotlightDetailLines, B.detailSpotlightMinDetailLines) * lh + EDGE_PIXELS;
  const detailHeight =
    mode === "DETAIL_SPOTLIGHT"
      ? spotlightDetailHeight
      : mode === "SPLIT_RAIL"
        ? 4 * lh + EDGE_PIXELS
        : POST_HEADER_H - labelOuterHeight - B.detailsGap;
  const detailCapacity = Math.max(1, Math.floor((detailHeight - EDGE_PIXELS) / lh));
  return { mode, labelInnerWidth, detailInnerWidth, detailCapacity, bodyOf };
}

function checkListWithDetails(items) {
  const layout = detailsLayout(items);
  for (let i = 0; i < items.length; i += 1) {

    const labelErr = linesError(
      "item_too_long",
      `items[${i}].label`,
      items[i].label,
      layout.labelInnerWidth,
      1,
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
  switch (spec.kind) {
    case "text_surface":

      if (spec.template === "image_caption") return null;
      return checkTextBody(spec);
    case "paged_text_surface":
      return checkPages(spec);
    case "list_surface":
      return checkMeasuredList(spec.items, (label) => [label], (i) => `items[${i}]`);
    case "checklist_surface":
      return checkMeasuredList(
        spec.items.map((item) => item.label),
        (label) => [B.checklistUncheckedMark + label, B.checklistCheckedMark + label],
        (i) => `items[${i}].label`,
      );
    case "list_with_details_surface":
      return checkListWithDetails(spec.items);
    default:
      return null;
  }
}

module.exports = { GLASSES_UI_FIT_BUDGETS, titleBudgetPx, checkGlassesUiFit };
