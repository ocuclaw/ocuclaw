const KNOWN_FILTERS = new Set([
  "trim",
  "lower",
  "upper",
  "int",
  "round",
  "percent",
  "truncate",
  "default",
  "prefix",
  "minus",
  "plus",
]);

const NUMERIC_ARG_FILTERS = new Set(["round", "truncate"]);

const STRING_ARG_FILTERS = new Set(["default", "prefix"]);

const PATH_ARG_FILTERS = new Set(["minus", "plus"]);

function resolvePath(path, data, previous) {
  if (typeof path !== "string" || path === "") return undefined;
  const segments = path.split(".");
  let cursor;
  if (segments[0] === "previous") {
    cursor = previous;
    segments.shift();
  } else {
    cursor = data;
  }
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return undefined;
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function parseFilter(filterSrc) {

  const colonIdx = filterSrc.indexOf(":");
  const name = (colonIdx === -1 ? filterSrc : filterSrc.slice(0, colonIdx)).trim();
  const rawArg = colonIdx === -1 ? "" : filterSrc.slice(colonIdx + 1).trim();
  if (!KNOWN_FILTERS.has(name)) {
    return { ok: false, code: "refresh_template_invalid", message: `unknown filter: ${name}` };
  }
  if (NUMERIC_ARG_FILTERS.has(name)) {
    const n = Number(rawArg);
    if (rawArg === "" || !Number.isFinite(n)) {
      return { ok: false, code: "refresh_template_invalid", message: `filter ${name} requires numeric arg, got: ${JSON.stringify(rawArg)}` };
    }
    return { ok: true, name, arg: n };
  }
  if (STRING_ARG_FILTERS.has(name)) {
    const m = rawArg.match(/^"([^"]*)"$/);
    if (!m) {
      return { ok: false, code: "refresh_template_invalid", message: `filter ${name} requires quoted-string arg, got: ${JSON.stringify(rawArg)}` };
    }
    return { ok: true, name, arg: m[1] };
  }
  if (PATH_ARG_FILTERS.has(name)) {
    if (!rawArg) {
      return { ok: false, code: "refresh_template_invalid", message: `filter ${name} requires a path arg` };
    }
    return { ok: true, name, arg: rawArg };
  }

  return { ok: true, name, arg: null };
}

function applyFilter(value, filter, data, previous) {
  switch (filter.name) {
    case "trim":
      return typeof value === "string" ? value.trim() : value;
    case "lower":
      return typeof value === "string" ? value.toLowerCase() : value;
    case "upper":
      return typeof value === "string" ? value.toUpperCase() : value;
    case "int": {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : value;
    }
    case "round": {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      const m = Math.pow(10, filter.arg);
      return Math.round(n * m) / m;
    }
    case "percent": {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      return `${Math.round(n * 1000) / 10}%`;
    }
    case "truncate":
      return typeof value === "string" ? value.slice(0, filter.arg) : value;
    case "default":
      return value === undefined || value === null || value === "" ? filter.arg : value;
    case "prefix": {

      if (value === undefined || value === null || value === "") return value;
      if (typeof value === "number" && value === 0) return value;
      return `${filter.arg}${value}`;
    }
    case "minus":
    case "plus": {
      const a = Number(value);
      const b = Number(resolvePath(filter.arg, data, previous));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return value;
      return filter.name === "minus" ? a - b : a + b;
    }
    default:
      return value;
  }
}

function stringify(value, opts) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && opts && typeof opts.arraySeparator === "string") {
    return value.map((entry) => stringify(entry, opts)).join(opts.arraySeparator);
  }
  return String(value);
}

function evaluateExpression(exprSrc, data, previous) {
  const parts = exprSrc.split("|").map((s) => s.trim());
  const path = parts[0];
  let value = resolvePath(path, data, previous);
  for (let i = 1; i < parts.length; i += 1) {
    const f = parseFilter(parts[i]);
    if (!f.ok) return value;
    value = applyFilter(value, f, data, previous);
  }
  return value;
}

function substituteTemplate(template, data, opts) {
  if (typeof template !== "string") return "";
  const previous = opts && opts.previous ? opts.previous : null;
  const whole = template.match(/^\{\{([^}]+)\}\}$/);
  if (whole && opts && opts.preserveWholeValue === true) {
    return evaluateExpression(whole[1], data, previous);
  }
  return template.replace(/\{\{([^}]+)\}\}/g, (match, exprSrc) => {
    return stringify(evaluateExpression(exprSrc, data, previous), opts);
  });
}

function validateTemplate(template) {
  if (typeof template !== "string") {
    return { ok: false, code: "refresh_template_invalid", message: "template must be a string" };
  }

  const openCount = (template.match(/\{\{/g) || []).length;
  const closeCount = (template.match(/\}\}/g) || []).length;
  if (openCount !== closeCount) {
    return { ok: false, code: "refresh_template_invalid", message: "unmatched {{ or }} in template" };
  }
  const re = /\{\{([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    const parts = m[1].split("|").map((s) => s.trim());
    for (let i = 1; i < parts.length; i += 1) {
      const f = parseFilter(parts[i]);
      if (!f.ok) return f;
    }
  }
  return { ok: true };
}

module.exports = { substituteTemplate, validateTemplate };
