const SESSION_LIST_FIXTURE_MAX_ROWS = 50;
const SESSION_LIST_FIXTURE_MAX_HISTORY = 200;

const ROW_FIELDS = new Set([
  "match",
  "key",
  "title",
  "firstUserMessage",
  "preview",
  "ageMs",
  "updatedAt",
  "unread",
  "agentStatus",
  "activityDescription",
  "pinned",
  "history",
]);
const MATCH_FIELDS = new Set(["key", "firstUserMessage", "title", "current"]);
const AGENT_STATUS_FIELDS = new Set(["working", "needsYou", "failed", "unknown"]);
const HISTORY_FIELDS = new Set(["role", "content", "name"]);

function fail(error) {
  return { ok: false, error };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unknownField(obj, allowed) {
  for (const name of Object.keys(obj)) {
    if (name.startsWith("_")) continue;
    if (!allowed.has(name)) return name;
  }
  return null;
}

function lowerKey(key) {
  return typeof key === "string" ? key.trim().toLowerCase() : "";
}

function normalizeFixtureTitle(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

function displayTitle(row) {
  if (!row) return "";
  if (typeof row.title === "string" && row.title.trim()) return row.title;
  if (typeof row.firstUserMessage === "string" && row.firstUserMessage.trim()) {
    return row.firstUserMessage;
  }
  return typeof row.preview === "string" ? row.preview : "";
}

function normalizeMatch(raw, label) {
  if (raw === undefined || raw === null) return { ok: true, match: null };
  if (raw === "current") {
    return { ok: true, match: { key: "", firstUserMessage: "", title: "", current: true } };
  }
  if (!isPlainObject(raw)) {
    return fail(`${label}: match must be "current" or an object with key, firstUserMessage, title or current`);
  }

  const unknown = unknownField(raw, MATCH_FIELDS);
  if (unknown) return fail(`${label} has an unknown match field "${unknown}"`);
  if (raw.key !== undefined && (typeof raw.key !== "string" || !raw.key.trim())) {
    return fail(`${label}: match.key must be a non-empty string`);
  }
  if (raw.title !== undefined && (typeof raw.title !== "string" || !raw.title.trim())) {
    return fail(`${label}: match.title must be a non-empty string`);
  }
  if (
    raw.firstUserMessage !== undefined &&
    (typeof raw.firstUserMessage !== "string" || !raw.firstUserMessage.trim())
  ) {
    return fail(`${label}: match.firstUserMessage must be a non-empty string`);
  }
  if (raw.current !== undefined && typeof raw.current !== "boolean") {
    return fail(`${label}: match.current must be a boolean`);
  }
  const match = {
    key: typeof raw.key === "string" ? raw.key.trim() : "",
    firstUserMessage: typeof raw.firstUserMessage === "string" ? raw.firstUserMessage.trim() : "",
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    current: raw.current === true,
  };
  if (!match.key && !match.firstUserMessage && !match.title && !match.current) {
    return fail(`${label}: match needs key, firstUserMessage, title or current:true`);
  }
  return { ok: true, match };
}

function normalizeAgentStatus(raw, label) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (!isPlainObject(raw)) return fail(`${label}: agentStatus must be an object or null`);
  const unknown = unknownField(raw, AGENT_STATUS_FIELDS);
  if (unknown) return fail(`${label} has an unknown agentStatus field "${unknown}"`);
  const value = {};
  for (const name of AGENT_STATUS_FIELDS) {
    const flag = raw[name];
    if (flag !== undefined && typeof flag !== "boolean") {
      return fail(`${label}: agentStatus.${name} must be a boolean`);
    }
    value[name] = flag === true;
  }
  return { ok: true, value };
}

function normalizeHistory(raw, label) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return fail(`${label}: history must be an array of messages`);
  if (raw.length > SESSION_LIST_FIXTURE_MAX_HISTORY) {
    return fail(`${label}: history has ${raw.length} messages; the cap is ${SESSION_LIST_FIXTURE_MAX_HISTORY}`);
  }
  const value = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    const where = `${label} history[${i}]`;
    if (!isPlainObject(entry)) return fail(`${where}: must be an object`);
    const unknown = unknownField(entry, HISTORY_FIELDS);
    if (unknown) return fail(`${where} has an unknown field "${unknown}"`);
    if (entry.role !== "user" && entry.role !== "assistant") {
      return fail(`${where}: role must be "user" or "assistant"`);
    }
    if (typeof entry.content !== "string" || !entry.content.trim()) {
      return fail(`${where}: content must be a non-empty string`);
    }
    if (entry.name !== undefined && (typeof entry.name !== "string" || !entry.name.trim())) {
      return fail(`${where}: name must be a non-empty string`);
    }
    value.push({
      role: entry.role,
      content: entry.content,
      ...(typeof entry.name === "string" ? { name: entry.name.trim() } : {}),
    });
  }
  return { ok: true, value };
}

function optionalString(raw, name, label, { allowEmpty = true, allowNull = false } = {}) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null && allowNull) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return fail(`${label}: ${name} must be a string${allowNull ? " or null" : ""}`);
  }
  if (!allowEmpty && !raw.trim()) return fail(`${label}: ${name} must not be empty`);
  return { ok: true, value: raw };
}

function optionalBoolean(raw, name, label) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "boolean") return fail(`${label}: ${name} must be a boolean`);
  return { ok: true, value: raw };
}

function normalizeRow(raw, index) {
  const label = `row ${index + 1}`;
  if (!isPlainObject(raw)) return fail(`${label}: must be an object`);
  const unknown = unknownField(raw, ROW_FIELDS);
  if (unknown) return fail(`${label} has an unknown field "${unknown}"`);

  const matchResult = normalizeMatch(raw.match, label);
  if (!matchResult.ok) return matchResult;
  const match = matchResult.match;
  const fake = match === null;

  const keyResult = optionalString(raw.key, "key", label, { allowEmpty: false });
  if (!keyResult.ok) return keyResult;
  if (!fake && keyResult.value !== undefined) {
    return fail(`${label}: "key" names a FAKE row's own key; an overlay row matches with match.key`);
  }

  const titleResult = optionalString(raw.title, "title", label, { allowEmpty: false });
  if (!titleResult.ok) return titleResult;
  if (fake && titleResult.value === undefined) {
    return fail(`${label}: a fake row (no match) needs a title`);
  }
  const firstResult = optionalString(raw.firstUserMessage, "firstUserMessage", label);
  if (!firstResult.ok) return firstResult;
  const previewResult = optionalString(raw.preview, "preview", label);
  if (!previewResult.ok) return previewResult;
  const activityResult = optionalString(
    raw.activityDescription,
    "activityDescription",
    label,
    { allowNull: true },
  );
  if (!activityResult.ok) return activityResult;

  if (raw.ageMs !== undefined && raw.updatedAt !== undefined) {
    return fail(`${label}: give ageMs (relative) or updatedAt (absolute), not both`);
  }
  if (raw.ageMs !== undefined && (!Number.isFinite(raw.ageMs) || raw.ageMs < 0)) {
    return fail(`${label}: ageMs must be a number >= 0`);
  }
  if (raw.updatedAt !== undefined && (!Number.isFinite(raw.updatedAt) || raw.updatedAt <= 0)) {
    return fail(`${label}: updatedAt must be an epoch-ms number > 0`);
  }
  if (fake && raw.ageMs === undefined && raw.updatedAt === undefined) {
    return fail(`${label}: a fake row needs ageMs or updatedAt so its place in the list is fixed`);
  }

  const unreadResult = optionalBoolean(raw.unread, "unread", label);
  if (!unreadResult.ok) return unreadResult;
  const pinnedResult = optionalBoolean(raw.pinned, "pinned", label);
  if (!pinnedResult.ok) return pinnedResult;
  const statusResult = normalizeAgentStatus(raw.agentStatus, label);
  if (!statusResult.ok) return statusResult;
  const historyResult = normalizeHistory(raw.history, label);
  if (!historyResult.ok) return historyResult;
  if (fake && historyResult.value) {
    return fail(
      `${label}: history is only honoured on a row that matches a real session; a fake row cannot be opened`,
    );
  }

  return {
    ok: true,
    row: {
      index,
      match,
      key: keyResult.value === undefined ? "" : keyResult.value.trim(),
      title: titleResult.value === undefined ? undefined : titleResult.value.trim(),
      firstUserMessage: firstResult.value,
      preview: previewResult.value,
      activityDescription: activityResult.value,
      ageMs: raw.ageMs === undefined ? undefined : Math.floor(raw.ageMs),
      updatedAt: raw.updatedAt === undefined ? undefined : Math.floor(raw.updatedAt),
      unread: unreadResult.value,
      pinned: pinnedResult.value,
      agentStatus: statusResult.value,
      history: historyResult.value,
    },
  };
}

function normalizeSessionListFixture(input) {
  const rows = Array.isArray(input)
    ? input
    : isPlainObject(input) && Array.isArray(input.rows)
      ? input.rows
      : null;
  if (!rows) return fail("fixture must be an array of rows or {rows: [...]}");
  if (rows.length === 0) return fail("fixture needs at least one row (send rows: null to clear)");
  if (rows.length > SESSION_LIST_FIXTURE_MAX_ROWS) {
    return fail(`fixture has ${rows.length} rows; the cap is ${SESSION_LIST_FIXTURE_MAX_ROWS}`);
  }
  const out = [];
  const matchKeys = new Set();
  const fakeKeys = new Set();
  let currentRows = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const result = normalizeRow(rows[index], index);
    if (!result.ok) return result;
    const row = result.row;
    if (row.match) {
      if (row.match.key) {
        const lk = lowerKey(row.match.key);
        if (matchKeys.has(lk)) return fail(`row ${index + 1}: match.key "${row.match.key}" is already matched by another row`);
        matchKeys.add(lk);
      }
      if (row.match.current) currentRows += 1;
    } else if (row.key) {
      const lk = lowerKey(row.key);
      if (fakeKeys.has(lk)) return fail(`row ${index + 1}: fake key "${row.key}" is used twice`);
      fakeKeys.add(lk);
    }
    out.push(row);
  }
  if (currentRows > 1) return fail("only one row may match the current session");
  for (const lk of fakeKeys) {
    if (matchKeys.has(lk)) return fail(`fake key "${lk}" is also a match.key; a key is either real or fake`);
  }
  return { ok: true, rows: out };
}

function fixtureKeySlug(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "row";
}

function synthesizedBase(key, anchorMs) {
  return {
    key,
    updatedAt: anchorMs,
    preview: "",
    firstUserMessage: "",
    title: null,
    pinned: false,
    pinnedAtMs: null,
  };
}

function applyOverrides(base, row, anchorMs) {
  const out = { ...base };
  if (row.updatedAt !== undefined) out.updatedAt = row.updatedAt;
  else if (row.ageMs !== undefined) out.updatedAt = Math.max(1, anchorMs - row.ageMs);
  if (row.title !== undefined) out.title = row.title;
  if (row.firstUserMessage !== undefined) {
    out.firstUserMessage = row.firstUserMessage;
    out.preview = row.firstUserMessage.slice(0, 80);
  }
  if (row.preview !== undefined) out.preview = row.preview;
  if (row.unread !== undefined) out.unread = row.unread;
  if (row.pinned !== undefined) {
    out.pinned = row.pinned;
    out.pinnedAtMs = row.pinned ? anchorMs : null;
  }
  if (row.activityDescription !== undefined) out.activityDescription = row.activityDescription;
  if (row.agentStatus === null) {
    delete out.agentStatus;
  } else if (row.agentStatus !== undefined) {
    out.agentStatus = {
      working: row.agentStatus.working,
      needsYou: row.agentStatus.needsYou,
      failed: row.agentStatus.failed,
      observedAtMs: anchorMs,
      unknown: row.agentStatus.unknown,
    };
  }
  return out;
}

function resolveSessionListFixtureView(input) {
  const rows = Array.isArray(input && input.rows) ? input.rows : [];
  const anchorMs = Number.isFinite(input && input.anchorMs) ? input.anchorMs : Date.now();
  const realRows = Array.isArray(input && input.realRows) ? input.realRows : [];
  const currentKey = typeof (input && input.currentKey) === "string" ? input.currentKey.trim() : "";
  let currentBinding =
    typeof (input && input.currentBinding) === "string" && input.currentBinding
      ? input.currentBinding
      : null;

  const realByKey = new Map();
  for (const real of realRows) {
    const lk = lowerKey(real && real.key);
    if (lk && !realByKey.has(lk)) realByKey.set(lk, real);
  }
  const claimed = new Set();
  const assigned = new Array(rows.length).fill(null);

  rows.forEach((row, i) => {
    if (!row.match || !row.match.key) return;
    const lk = lowerKey(row.match.key);
    const real = realByKey.get(lk);
    if (real && !claimed.has(lk)) {
      claimed.add(lk);
      assigned[i] = { via: "key", real, key: real.key };
    }
  });

  rows.forEach((row, i) => {
    if (assigned[i] || !row.match || !row.match.firstUserMessage) return;

    const want = normalizeFixtureTitle(row.match.firstUserMessage);
    let best = null;
    for (const real of realRows) {
      const lk = lowerKey(real && real.key);
      if (!lk || claimed.has(lk)) continue;
      const have = normalizeFixtureTitle(real && real.firstUserMessage);
      const kept = have.replace(/(…|\.\.\.)$/, "").trim();
      const truncatedMatch = kept !== have && kept.length >= 24 && want.startsWith(kept);
      if (!have || (have !== want && !truncatedMatch)) continue;
      if (!best || (Number(real.updatedAt) || 0) > (Number(best.updatedAt) || 0)) best = real;
    }
    if (best) {
      claimed.add(lowerKey(best.key));
      assigned[i] = { via: "firstUserMessage", real: best, key: best.key };
    }
  });

  rows.forEach((row, i) => {
    if (assigned[i] || !row.match || !row.match.title) return;
    const want = normalizeFixtureTitle(row.match.title);
    let best = null;
    for (const real of realRows) {
      const lk = lowerKey(real && real.key);
      if (!lk || claimed.has(lk)) continue;
      if (normalizeFixtureTitle(displayTitle(real)) !== want) continue;
      if (!best || (Number(real.updatedAt) || 0) > (Number(best.updatedAt) || 0)) best = real;
    }
    if (best) {
      claimed.add(lowerKey(best.key));
      assigned[i] = { via: "title", real: best, key: best.key };
    }
  });

  rows.forEach((row, i) => {
    if (assigned[i] || !row.match || !row.match.current) return;
    let target = "";
    if (currentKey && !claimed.has(lowerKey(currentKey))) target = currentKey;
    else if (currentBinding && !claimed.has(lowerKey(currentBinding))) target = currentBinding;
    if (!target) return;
    const lk = lowerKey(target);
    claimed.add(lk);
    currentBinding = target;
    const real = realByKey.get(lk) || null;
    assigned[i] = { via: real ? "current" : "current-synthesized", real, key: real ? real.key : target };
  });

  const resolved = [];
  const unmatched = [];
  const keyToIndex = new Map();
  rows.forEach((row, i) => {
    let base;
    let via;
    if (!row.match) {
      base = synthesizedBase(row.fakeKey, anchorMs);
      via = "fake";
    } else if (assigned[i]) {
      const hit = assigned[i];
      base = hit.real ? { ...hit.real } : synthesizedBase(hit.key, anchorMs);
      via = hit.via;
    } else {
      unmatched.push({ index: row.index, match: row.match });
      return;
    }
    const served = applyOverrides(base, row, anchorMs);
    keyToIndex.set(lowerKey(served.key), i);
    resolved.push({ served, order: i, via });
  });
  resolved.sort(
    (a, b) => (Number(b.served.updatedAt) || 0) - (Number(a.served.updatedAt) || 0) || a.order - b.order,
  );
  return {
    rows: resolved.map((entry) => entry.served),
    currentBinding,
    keyToIndex,
    report: {
      rows: resolved.map((entry) => ({
        index: rows[entry.order].index,
        via: entry.via,
        key: entry.served.key,
        title: displayTitle(entry.served),
      })),
      unmatched,
    },
  };
}

module.exports = { SESSION_LIST_FIXTURE_MAX_ROWS, SESSION_LIST_FIXTURE_MAX_HISTORY, normalizeFixtureTitle, normalizeSessionListFixture, fixtureKeySlug, resolveSessionListFixtureView };
