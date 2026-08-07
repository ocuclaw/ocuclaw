const LABEL_MAX = 32;
const TITLE_MAX = 64;
const ITEMS_SHOWN = 8;
const BODY_MAX = 120;
const SUMMARY_MAX = 400;

function truncate(value, max) {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function summarizeGlassesUiContent(specOrPatch) {
  const o = specOrPatch && typeof specOrPatch === "object" ? specOrPatch : {};
  const rawItems = Array.isArray(o.items) ? o.items : null;
  const out = {};

  const hasDetail =
    !!rawItems &&
    rawItems.some((i) => i && typeof i === "object" && typeof i.body === "string");
  if (rawItems) out.kind = hasDetail ? "list_with_details" : "list";
  else if (typeof o.body === "string") out.kind = "text";
  else out.kind = "unknown";

  if (typeof o.title === "string") out.title = truncate(o.title, TITLE_MAX);

  if (rawItems) {
    const labels = rawItems
      .map((i) =>
        typeof i === "string"
          ? i
          : i && typeof i === "object" && typeof i.label === "string"
            ? i.label
            : "",
      )
      .filter((l) => l.length > 0)
      .map((l) => truncate(l, LABEL_MAX));
    out.items = labels.slice(0, ITEMS_SHOWN);
    if (labels.length > ITEMS_SHOWN) out.itemsMore = labels.length - ITEMS_SHOWN;
  }

  if (typeof o.body === "string") out.body = truncate(o.body, BODY_MAX);

  while (
    Array.isArray(out.items) &&
    out.items.length > 1 &&
    JSON.stringify(out).length > SUMMARY_MAX
  ) {
    out.items.pop();
    out.itemsMore = (out.itemsMore || 0) + 1;
  }

  return out;
}

module.exports = { summarizeGlassesUiContent };
