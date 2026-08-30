const { substituteTemplate } = require("./glasses-ui-template.cjs");

const ITEMS_FROM_PATH_RE = /^\$(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[\d+\]))*\[\]$/;

function validateItemsFromPath(path) {
  const dangerousSegment =
    typeof path === "string" &&
    path
      .slice(1, -2)
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .some((segment) => ["__proto__", "prototype", "constructor"].includes(segment));
  if (typeof path !== "string" || !ITEMS_FROM_PATH_RE.test(path) || dangerousSegment) {
    return {
      ok: false,
      code: "refresh_items_mapping_invalid",
      message:
        "targets.itemsFromPath must be a bounded path ending in [] (for example $.results[] or $[])",
    };
  }
  return { ok: true };
}

function resolveArray(path, output) {
  const withoutTerminalArray = path.slice(1, -2);
  const normalized = withoutTerminalArray.replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized.split(".").filter(Boolean);
  let cursor = output;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (typeof cursor === "object") {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function wrapForTemplate(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value, output: value };
  }
  return { output: value };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function mapArrayItems(params) {
  const source = resolveArray(params.itemsFromPath, params.output);
  if (!Array.isArray(source)) {
    return {
      ok: false,
      code: "refresh_items_source_not_array",
      message: `targets.itemsFromPath ${params.itemsFromPath} did not resolve to an array`,
    };
  }
  if (source.length === 0) {
    return {
      ok: false,
      code: "refresh_items_source_empty",
      message: `targets.itemsFromPath ${params.itemsFromPath} resolved to an empty array`,
    };
  }

  const diagnostics = [];
  const maxItems = params.limits.maxItems;
  const selected = source.slice(0, maxItems);
  if (source.length > selected.length) {
    diagnostics.push({
      code: "refresh_items_count_clamped",
      sourceCount: source.length,
      emittedCount: selected.length,
      limit: maxItems,
    });
  }

  let clampedFields = 0;
  const previous =
    params.previousOutput !== undefined ? wrapForTemplate(params.previousOutput) : undefined;
  let items = selected.map((value) => {
    const data = wrapForTemplate(value);
    const rawLabel = substituteTemplate(params.itemTemplate.label, data, { previous });
    const label = rawLabel.slice(0, params.limits.itemMax);
    if (label.length !== rawLabel.length) clampedFields += 1;
    if (params.surfaceKind === "list_surface") return label;
    const item = { label };
    if (typeof params.itemTemplate.body === "string") {
      const rawBody = substituteTemplate(params.itemTemplate.body, data, { previous });
      item.body = rawBody.slice(0, params.limits.detailBodyMax);
      if (item.body.length !== rawBody.length) clampedFields += 1;
    }
    return item;
  });

  const emptyLabelIndex = items.findIndex((item) =>
    (typeof item === "string" ? item : item.label).trim().length === 0,
  );
  if (emptyLabelIndex !== -1) {
    return {
      ok: false,
      code: "refresh_items_label_empty",
      message: `itemTemplate produced an empty label at source index ${emptyLabelIndex}`,
    };
  }
  if (clampedFields > 0) {
    diagnostics.push({ code: "refresh_items_field_clamped", count: clampedFields });
  }

  const payloadLimit = params.limits.totalDetailPayloadMax;
  const beforeBytes = utf8Bytes(items);
  while (items.length > 0 && utf8Bytes(items) > payloadLimit) items = items.slice(0, -1);
  if (items.length === 0) {
    return {
      ok: false,
      code: "refresh_items_payload_too_large",
      message: `mapped items could not fit within ${payloadLimit} UTF-8 bytes`,
    };
  }
  const emittedBytes = utf8Bytes(items);
  if (emittedBytes !== beforeBytes) {
    diagnostics.push({
      code: "refresh_items_payload_clamped",
      beforeBytes,
      emittedBytes,
      emittedCount: items.length,
      limitBytes: payloadLimit,
    });
  }
  return { ok: true, items, diagnostics };
}

module.exports = { validateItemsFromPath, mapArrayItems };
