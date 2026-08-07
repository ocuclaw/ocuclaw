function normalizeWindowKey(label, index) {
  const normalized = typeof label === "string" ? label.trim().toLowerCase() : "";

  if (normalized === "week" || normalized === "weekly") {
    return { key: "week", sortOrder: 20 };
  }

  if (/^5\s*(h|hr|hrs|hour|hours)?$/.test(normalized)) {
    return { key: "5h", sortOrder: 10 };
  }

  const key = normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return {
    key: key || `window_${index}`,
    sortOrder: 100 + index,
  };
}

function toFiniteNumber(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeWindow(window, index) {
  const normalizedKey = normalizeWindowKey(window && window.label, index);
  const label =
    typeof window?.label === "string" && window.label.trim()
      ? window.label.trim()
      : normalizedKey.key;

  return {
    key: normalizedKey.key,
    label,
    usedPercent: toFiniteNumber(window && window.usedPercent, 0),
    resetAtMs: toFiniteNumber(window && window.resetAt, null),
    sortOrder: normalizedKey.sortOrder,
  };
}

function isStrongerWindow(candidate, current) {
  if (candidate.usedPercent !== current.usedPercent) {
    return candidate.usedPercent > current.usedPercent;
  }
  return candidate.sortOrder > current.sortOrder;
}

function selectLimitingWindow(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return null;
  }

  return windows.slice().sort((left, right) => {
    const leftExhausted = left.usedPercent >= 100;
    const rightExhausted = right.usedPercent >= 100;

    if (leftExhausted !== rightExhausted) {
      return leftExhausted ? -1 : 1;
    }

    if (left.usedPercent !== right.usedPercent) {
      return right.usedPercent - left.usedPercent;
    }

    return right.sortOrder - left.sortOrder;
  })[0];
}

function selectProviderUsageSnapshot(summary, opts = {}) {
  const providers = Array.isArray(summary && summary.providers) ? summary.providers : [];
  const activeProvider =
    typeof opts.provider === "string" ? opts.provider.trim().toLowerCase() : "";

  if (!activeProvider) {
    return null;
  }

  const namedEntries = providers.filter(
    (entry) => typeof entry?.provider === "string",
  );

  let match = namedEntries.find(
    (entry) => entry.provider.trim().toLowerCase() === activeProvider,
  );

  if (!match) {
    const familyMatches = namedEntries.filter((entry) =>
      entry.provider.trim().toLowerCase().startsWith(`${activeProvider}-`),
    );
    if (familyMatches.length === 1) {
      match = familyMatches[0];
    }
  }

  if (!match) {
    return null;
  }

  const windows = (Array.isArray(match.windows) ? match.windows : []).map(normalizeWindow);
  const limitingWindow = selectLimitingWindow(windows);
  const dedupedWindows = [];
  const keyToIndex = new Map();

  for (const window of windows) {
    if (!keyToIndex.has(window.key)) {
      keyToIndex.set(window.key, dedupedWindows.length);
      dedupedWindows.push(window);
      continue;
    }

    const existingIndex = keyToIndex.get(window.key);
    const existingWindow = dedupedWindows[existingIndex];
    if (isStrongerWindow(window, existingWindow)) {
      dedupedWindows[existingIndex] = window;
    }
  }

  const provider = typeof match.provider === "string" ? match.provider.trim() : match.provider;

  return {
    sessionKey: typeof opts.sessionKey === "string" ? opts.sessionKey : null,
    provider,
    displayName:
      typeof match.displayName === "string" && match.displayName.trim()
        ? match.displayName.trim()
        : provider,
    fetchedAtMs: toFiniteNumber(summary && summary.updatedAt, null),
    stale: opts.stale === true,
    limitingWindowKey: limitingWindow ? limitingWindow.key : null,
    windows: dedupedWindows,
  };
}

function buildRateLimitInfoFromSnapshot(snapshot) {
  if (!snapshot || snapshot.stale === true || !snapshot.limitingWindowKey) {
    return null;
  }
  if (snapshot.poolStatus === "ready") {
    return null;
  }

  const limitingWindow = Array.isArray(snapshot.windows)
    ? snapshot.windows.find((window) => window.key === snapshot.limitingWindowKey) || null
    : null;

  if (!limitingWindow) {
    return null;
  }

  return {
    sessionKey: snapshot.sessionKey || null,
    provider: snapshot.provider || null,
    windowKey: limitingWindow.key,
    windowLabel: limitingWindow.label,
    usedPercent: limitingWindow.usedPercent,
    resetAtMs: limitingWindow.resetAtMs,
    fetchedAtMs: snapshot.fetchedAtMs,
    stale: false,
  };
}

module.exports = { selectProviderUsageSnapshot, buildRateLimitInfoFromSnapshot };
