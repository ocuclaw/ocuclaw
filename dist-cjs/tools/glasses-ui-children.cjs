const TITLE_BUDGET_PX = 540;

const BREADCRUMB_SEPARATOR = " › ";

function clipBreadcrumb(s, reserveText = "") {
  if (typeof s !== "string" || s.length === 0) return s;
  const charBudget = Math.floor((TITLE_BUDGET_PX - reserveText.length * 20) / 20);
  if (charBudget <= 0) return "";
  if (s.length <= charBudget) return s;
  const segments = s.split(BREADCRUMB_SEPARATOR);

  while (segments.length > 1 && segments.join(BREADCRUMB_SEPARATOR).length > charBudget) {
    segments.shift();
  }
  const joined = segments.join(BREADCRUMB_SEPARATOR);
  if (joined.length <= charBudget) return joined;

  const clipped = joined.slice(0, charBudget);

  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

function preloadedChildSurfaceId(parentSurfaceId, index, gen) {
  return `${parentSurfaceId}:c${index}-${gen}`;
}

function preloadedChildrenAreMinted(children) {
  if (!Array.isArray(children)) return false;
  return children.every((child) => !child || (typeof child.surfaceId === "string" && child.surfaceId.length > 0));
}

function mintPreloadedChildren(parentSurfaceId, parentTitle, children, gen) {
  if (!Array.isArray(children)) return children;
  return children.map((child, i) => {
    if (!child) return null;
    const wired = { ...child, surfaceId: preloadedChildSurfaceId(parentSurfaceId, i, gen) };
    if (typeof child.title === "string" && typeof parentTitle === "string") {
      wired.title = clipBreadcrumb(`${parentTitle}${BREADCRUMB_SEPARATOR}${child.title}`);
    }
    return wired;
  });
}

module.exports = { TITLE_BUDGET_PX, BREADCRUMB_SEPARATOR, clipBreadcrumb, preloadedChildSurfaceId, preloadedChildrenAreMinted, mintPreloadedChildren };
