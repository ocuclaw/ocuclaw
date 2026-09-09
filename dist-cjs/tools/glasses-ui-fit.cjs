const { getTextWidth, measureTextWrap } = require("./glasses-ui-font-measure.cjs");

const GLASSES_UI_FIT_BUDGETS = {

  canvasW: 576,
  canvasH: 288,
  headerH: 49,
  markerX: 548,
  markerGutter: 8,
  titleLaneX: 0,
  titleChipExtraW: 24,
  cuedChipMaxW: 504,
  cuedTitleCueGap: 8,
  contentPadding: 6,
  frameBorderWidth: 1,

  narrowContentInnerW: 430,
  mediumContentInnerW: 550,
  wideContentInnerW: 550,
  captionPriorityInnerW: 540,
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
  detailsGap: -1,
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
  const maxChipWidth = Math.max(0, 2 * (rightLimit - B.canvasW / 2));
  return Math.max(0, maxChipWidth - B.titleChipExtraW);
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
    const budget = B.cuedChipMaxW - B.titleChipExtraW - B.cuedTitleCueGap - cueWidth;
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

function rowSuffixesFor(spec) {
  const children = Array.isArray(spec && spec.children) ? spec.children : [];
  return (i) => (children[i] ? B.childCueSuffix : "");
}

function checkMeasuredList(labels, rowVariants, field, suffixAt = () => "") {
  const variants = labels.map((label, i) => rowVariants(label, i));
  const centeredFits =
    labels.length <= B.centeredListMaxItems &&
    variants.every((rows) => worstRowLines(rows, B.narrowContentInnerW) <= 1);
  if (centeredFits) return null;
  const focusFits =
    labels.length <= B.focusListMaxItems &&
    variants.every((rows) => worstRowLines(rows, B.mediumContentInnerW) <= B.focusListMaxLines);
  if (focusFits) {

    for (let i = 0; i < labels.length; i += 1) {
      if (!suffixAt(i)) continue;
      if (worstRowLines(variants[i], B.mediumContentInnerW) <= 1) continue;
      return linesError(
        "item_too_long",
        field(i),
        variants[i][0],
        B.mediumContentInnerW,
        1,
        "shorten it (a row that opens a child stays on one line)",
      );
    }
    return null;
  }
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

function detailsLayout(items, suffixAt = () => "") {
  const bodyOf = (item) => (typeof item.body === "string" ? item.body : "");
  const spotlightDetailLines = items.map((item) => wrappedLines(bodyOf(item), B.wideContentInnerW));
  const splitLabelLines = items.map((item, i) => wrappedLines(item.label + suffixAt(i), B.splitLabelInnerW));
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
      ? B.wideContentInnerW
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
  const labelVisibleLines = mode === "DETAIL_SPOTLIGHT" ? 2 * visibleRows - 1 : visibleRows;
  const labelOuterHeight = labelVisibleLines * lh + EDGE_PIXELS;

  const spotlightDetailHeight =
    Math.max(...spotlightDetailLines, B.detailSpotlightMinDetailLines) * lh + EDGE_PIXELS;
  const detailHeight =
    mode === "DETAIL_SPOTLIGHT"
      ? spotlightDetailHeight
      : mode === "SPLIT_RAIL"
        ? 5 * lh + EDGE_PIXELS
        : B.fullReaderMaxVisibleLines * lh - labelOuterHeight - B.detailsGap;
  const detailCapacity = Math.max(1, Math.floor((detailHeight - EDGE_PIXELS) / lh));
  return { mode, labelInnerWidth, detailInnerWidth, detailCapacity, bodyOf };
}

function checkListWithDetails(items, suffixAt = () => "") {
  const layout = detailsLayout(items, suffixAt);
  for (let i = 0; i < items.length; i += 1) {

    const labelErr = linesError(
      "item_too_long",
      `items[${i}].label`,
      items[i].label + suffixAt(i),
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

      if (spec.template === "image_caption") return null;
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
        (label) => [B.checklistUncheckedMark + label, B.checklistCheckedMark + label],
        (i) => `items[${i}].label`,
      );
    case "list_with_details_surface":
      return checkListWithDetails(spec.items, rowSuffixesFor(spec));
    default:
      return null;
  }
}

module.exports = { GLASSES_UI_FIT_BUDGETS, titleBudgetPx, checkGlassesUiFit };
