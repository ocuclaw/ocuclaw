const { orderLiveuiLibraryItems } = require("./glasses-ui-library.cjs");
const { isLiveuiLibraryItemVisible } = require("./glasses-ui-library-organization.cjs");

const LIVEUI_TASK_INDEX_HEADER =
  "Task index (approved; call find_tasks before acting):";
const LIVEUI_TASK_INDEX_MAX_ROWS = 20;
const LIVEUI_TASK_INDEX_MAX_CHARS = 1_800;

function collapseWhitespace(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function truncateWithEllipsis(value, maxUnits) {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxUnits) return normalized;
  let prefix = normalized.slice(0, Math.max(0, maxUnits - 1));

  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function approvedTask(item) {
  if (!item || item.itemType !== "task" || item.status === "invalid") return false;
  if (typeof item.approvedVersionId === "string" && item.approvedVersionId) return true;
  if (
    item.approved &&
    typeof item.approved === "object" &&
    typeof item.approved.versionId === "string" &&
    item.approved.versionId
  ) return true;
  const persisted = item.versions && item.versions.approved;
  return !!(
    persisted &&
    typeof persisted === "object" &&
    typeof persisted.versionId === "string" &&
    persisted.versionId
  );
}

function projectLiveuiTaskIndexRows(listedItems, organization) {
  if (!Array.isArray(listedItems)) return [];
  const normalized = listedItems.map((item) => {
    const taskId = item && typeof item.taskId === "string" ? item.taskId : item && item.itemId;
    return {
      ...item,
      itemType: item && typeof item.itemType === "string" ? item.itemType : "task",
      itemId: taskId,
      approvedAtMs: Number.isSafeInteger(item && item.approvedAtMs)
        ? item.approvedAtMs
        : item && item.approved && Number.isSafeInteger(item.approved.approvedAtMs)
          ? item.approved.approvedAtMs
          : undefined,
    };
  });
  return orderLiveuiLibraryItems(normalized, organization)
    .filter((item) =>
      approvedTask(item) &&
      typeof item.itemId === "string" &&
      isLiveuiLibraryItemVisible(organization, "task", item.itemId),
    )
    .slice(0, LIVEUI_TASK_INDEX_MAX_ROWS)
    .map((item) => {
      const approved = item.approved && typeof item.approved === "object"
        ? item.approved
        : item.versions && item.versions.approved;
      return {
        name: collapseWhitespace(
          approved && typeof approved.name === "string"
            ? approved.name
            : item.name,
        ),
        description: collapseWhitespace(
          approved && typeof approved.description === "string"
            ? approved.description
            : typeof item.description === "string"
              ? item.description
              : item.cosmetic && item.cosmetic.description,
        ),
      };
    })
    .filter((row) => row.name);
}

function formatLiveuiTaskIndex(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const lines = rows
    .slice(0, LIVEUI_TASK_INDEX_MAX_ROWS)
    .map((row) => {
      const description = collapseWhitespace(row && row.description);
      const name = truncateWithEllipsis(
        row && row.name,
        description ? 52 : 78,
      );
      if (!name) return "";
      return description
        ? `- ${name} — ${truncateWithEllipsis(description, 23)}`
        : `- ${name}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return "";
  const block = [LIVEUI_TASK_INDEX_HEADER, ...lines].join("\n");
  return block.length <= LIVEUI_TASK_INDEX_MAX_CHARS ? block : "";
}

module.exports = { LIVEUI_TASK_INDEX_HEADER, LIVEUI_TASK_INDEX_MAX_ROWS, LIVEUI_TASK_INDEX_MAX_CHARS, projectLiveuiTaskIndexRows, formatLiveuiTaskIndex };
