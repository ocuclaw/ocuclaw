function plain(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function knownFields(value     , shape            )      {
  if (!plain(value)) return value;
  const known = new Set(shape.fields);
  const out      = {};
  for (const key of Object.keys(value)) {
    if (!known.has(key)) continue;
    const child = value[key];
    const part = shape.parts?.[key];
    const list = shape.lists?.[key];
    const map = shape.maps?.[key];
    if (part) {
      out[key] = knownFields(child, part);
    } else if (list && Array.isArray(child)) {
      out[key] = child.map((entry     ) => knownFields(entry, list));
    } else if (map && plain(child)) {
      const names = map.keys ? new Set(map.keys) : null;
      out[key] = Object.fromEntries(
        Object.entries(child)
          .filter(([name]) => !names || names.has(name))
          .map(([name, entry]) => [name, knownFields(entry, map)]),
      );
    } else {
      out[key] = child;
    }
  }
  return out;
}

function hasUnknownFields(value     , shape            )          {
  if (!plain(value)) return false;
  const known = new Set(shape.fields);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return true;
    const child = value[key];
    const part = shape.parts?.[key];
    const list = shape.lists?.[key];
    const map = shape.maps?.[key];
    if (part && hasUnknownFields(child, part)) return true;
    if (list && Array.isArray(child) && child.some((entry     ) => hasUnknownFields(entry, list))) return true;
    if (map && plain(child)) {
      const names = map.keys ? new Set(map.keys) : null;
      if (Object.entries(child).some(([name, entry]) => (names && !names.has(name)) || hasUnknownFields(entry, map))) return true;
    }
  }
  return false;
}

function stable(value     )         {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!plain(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function sameEntry(previous       , entry     , by        , next       ) {
  if (!plain(entry) || entry[by] === undefined) return undefined;
  const withKey = (list       ) => list.filter((other     ) => plain(other) && other[by] === entry[by]);

  if (withKey(next).length !== 1) return undefined;
  const found = withKey(previous);
  return found.length === 1 ? found[0] : undefined;
}

function carryUnknownFields(previous     , next     , shape            )      {
  if (!plain(previous) || !plain(next)) return next;
  if (shape.replaced && stable(knownFields(previous, shape)) !== stable(next)) return next;
  const known = new Set(shape.fields);
  const out      = { ...next };
  for (const key of Object.keys(previous)) {
    if (known.has(key) || Object.prototype.hasOwnProperty.call(next, key)) continue;

    Object.defineProperty(out, key, { value: previous[key], enumerable: true, writable: true, configurable: true });
  }
  for (const key of Object.keys(next)) {
    const before = previous[key];
    const child = next[key];
    const part = shape.parts?.[key];
    const list = shape.lists?.[key];
    const map = shape.maps?.[key];
    if (part) {
      out[key] = carryUnknownFields(before, child, part);
    } else if (list && Array.isArray(before) && Array.isArray(child)) {
      out[key] = child.map((entry     , index        ) =>
        carryUnknownFields(list.by ? sameEntry(before, entry, list.by, child) : before[index], entry, list));
    } else if (map && plain(before) && plain(child)) {
      const names = map.keys ? new Set(map.keys) : null;

      const entries = Object.entries(before).filter(([name]) => !names || names.has(name)).map(([, entry]) => entry);
      out[key] = {

        ...(names ? Object.fromEntries(Object.entries(before).filter(([name]) => !names.has(name))) : {}),
        ...Object.fromEntries(Object.entries(child).map(([name, entry]               ) => [
          name,
          carryUnknownFields(map.by ? sameEntry(entries, entry, map.by, Object.values(child)) : before[name], entry, map),
        ])),
      };
    }
  }
  return out;
}

function savedShapeFields(shape            , at = "record")                               {
  const out                               = { [at]: [...shape.fields].sort() };
  for (const [key, part] of Object.entries(shape.parts || {})) Object.assign(out, savedShapeFields(part, `${at}.${key}`));
  for (const [key, list] of Object.entries(shape.lists || {})) Object.assign(out, savedShapeFields(list, `${at}.${key}[]`));
  for (const [key, map] of Object.entries(shape.maps || {})) {
    if (map.keys) out[`${at}.${key}`] = [...map.keys].sort();
    Object.assign(out, savedShapeFields(map, `${at}.${key}.*`));
  }
  return out;
}

module.exports = { knownFields, hasUnknownFields, carryUnknownFields, savedShapeFields };
