const ACTIVITY_LABEL_FITS_CAPABILITY = "activityLabelFitsV1";

function activityFrameForAppWithoutLabelFits(frame        )         {
  if (typeof frame !== "string" || !frame.includes("\"labelSource\"")) return frame;
  let parsed     ;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return frame;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.labelSource) return frame;
  const shortLabel = typeof parsed.shortLabel === "string" ? parsed.shortLabel.trim() : "";
  if (!shortLabel || shortLabel === parsed.label) return frame;
  return JSON.stringify({ ...parsed, label: shortLabel });
}

module.exports = { ACTIVITY_LABEL_FITS_CAPABILITY, activityFrameForAppWithoutLabelFits };
