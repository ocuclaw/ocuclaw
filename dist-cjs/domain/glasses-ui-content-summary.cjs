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
  const rawPages = Array.isArray(o.pages) ? o.pages : null;
  const out = {};

  const hasDetail =
    !!rawItems &&
    rawItems.some((i) => i && typeof i === "object" && typeof i.body === "string");
  if (rawPages && Reflect.get(o, "kind") === "paged_text_surface") Object.assign(out, { kind: "paged_text" });
  else if (rawItems && o.kind === "checklist_surface") out.kind = "checklist";
  else if (rawItems) out.kind = hasDetail ? "list_with_details" : "list";
  else if (typeof o.body === "string") out.kind = "text";
  else out.kind = "unknown";

  if (typeof o.title === "string") out.title = truncate(o.title, TITLE_MAX);

  if (Reflect.get(o, "template") === "image_caption") {
    Object.assign(out, { template: "image_caption" });
    const imageAsset = Reflect.get(o, "imageAsset");
    const imageWidth = Reflect.get(o, "imageWidth");
    const imageHeight = Reflect.get(o, "imageHeight");
    if (typeof imageAsset === "string") Object.assign(out, { imageAsset: truncate(imageAsset, LABEL_MAX) });
    if (Number.isInteger(imageWidth)) Object.assign(out, { imageWidth });
    if (Number.isInteger(imageHeight)) Object.assign(out, { imageHeight });
  }

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
  if (rawPages) {
    Object.assign(out, { pageCount: rawPages.length });
    if (typeof rawPages[0] === "string") Object.assign(out, { page: truncate(rawPages[0], BODY_MAX) });
  }

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
