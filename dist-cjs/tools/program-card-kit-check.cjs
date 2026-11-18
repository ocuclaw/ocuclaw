const PROGRAM_CARD_KIT_LEVELS                                                                                                          = Object.freeze({

  1: Object.freeze({ names: Object.freeze([
    "ICONS", "action", "arc", "ask", "bar", "bars", "box", "button", "chart", "check", "choice", "circle", "clock", "cols",
    "component", "custom", "digits", "digitsWidth", "entry", "field", "fill", "frame", "group", "hline", "icon", "image",
    "fit", "item", "kv", "label", "line", "menu", "minsec", "more", "native", "nextSecond", "note", "number", "pad", "pad2", "padExact",
    "page", "panel", "phases", "picture", "poly", "polyline", "progress", "prose", "read", "rect", "render3d", "ring", "row", "rows",
    "scope", "set", "shortDate", "show", "shown", "slider", "space", "sparkline", "sprite", "stat", "stepper", "table", "tabs", "taskLine", "taskState", "text",
    "textWidth", "thousands", "toggle", "unchecked", "vline", "width",
  ]) }),
});

const PROGRAM_CARD_KIT_LEVEL         = Math.max(...Object.keys(PROGRAM_CARD_KIT_LEVELS).map(Number));

const PROGRAM_CARD_KIT_CAPABILITY_PREFIX = "programCardKit:";

const PROGRAM_CARD_KIT_TOO_NEW = "kit_too_new";

function programCardKitLevelValue(value     )                {
  return Number.isSafeInteger(value) && value >= 1 && value <= 999999 ? value : null;
}

function programCardKitLevelOf(capabilities     )                {
  if (!Array.isArray(capabilities)) return null;
  let level                = null;
  for (const entry of capabilities) {
    if (typeof entry !== "string" || !entry.startsWith(PROGRAM_CARD_KIT_CAPABILITY_PREFIX)) continue;
    const text = entry.slice(PROGRAM_CARD_KIT_CAPABILITY_PREFIX.length);
    if (!/^[0-9]{1,6}$/.test(text)) continue;
    const n = programCardKitLevelValue(Number(text));
    if (n !== null && (level === null || n > level)) level = n;
  }
  return level;
}

function programCardKitTeachLevel(level     )         {
  const first = Math.min(...Object.keys(PROGRAM_CARD_KIT_LEVELS).map(Number));
  const stated = programCardKitLevelValue(level);
  if (stated === null) return first;
  let teach = first;
  for (const known of Object.keys(PROGRAM_CARD_KIT_LEVELS).map(Number)) if (known <= stated && known > teach) teach = known;
  return teach;
}

function programCardKitNames(level      )                    {
  return PROGRAM_CARD_KIT_LEVELS[programCardKitTeachLevel(level)].names;
}

function programCardKitKnows(level     , name        )          {
  const stated = programCardKitLevelValue(level);
  if (stated === null) return false;
  return Object.keys(PROGRAM_CARD_KIT_LEVELS).map(Number)
    .some((known) => known <= stated && !!PROGRAM_CARD_KIT_LEVELS[known].abilities?.includes(name));
}

function programCardKitTooNew(stamp     , level     )          {
  const written = programCardKitLevelValue(stamp), runs = programCardKitLevelValue(level);
  return written !== null && runs !== null && written > runs;
}

function programCardLibraryWithKits(items     , kitOf                                          )      {
  if (!Array.isArray(items)) return items;
  return items.map((item     ) => {
    if (!item || item.itemType !== "app" || typeof item.itemId !== "string" || !Number.isSafeInteger(item.revision)) return item;
    let level                = null;
    try { level = programCardKitLevelValue(kitOf(item.itemId, item.revision)?.level); } catch { level = null; }
    return level === null ? item : { ...item, kit: { level } };
  });
}

const PROGRAM_CARD_UI_NAMES                    = PROGRAM_CARD_KIT_LEVELS[PROGRAM_CARD_KIT_LEVEL].names;

function codeOnly(source        )         {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      out += " ";
    } else if (ch === "\"" || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += `${ch}${ch}`;
      i = j;
    } else {
      out += ch;
    }
  }
  return out;
}

const IDENT = "[A-Za-z_$][\\w$]*";

function programCardUiCalls(source        )           {
  if (typeof source !== "string" || !source) return [];
  const code = codeOnly(source);
  const names = new Set        ();
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])ui\\s*\\??\\.\\s*(${IDENT})\\s*\\(`, "g"))) names.add(m[1]);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*ui(?![\w$])/g)) {
    for (const entry of m[1].split(",")) {

      if (!entry.trim() || entry.includes("=") || entry.trim().startsWith("...")) continue;
      const [key, local = key] = entry.split(":").map(part => part.trim());
      if (!new RegExp(`^${IDENT}$`).test(key) || !new RegExp(`^${IDENT}$`).test(local)) continue;
      if (new RegExp(`(?<![\\w$.])${local.replace(/\$/g, "\\$")}\\s*\\(`).test(code)) names.add(key);
    }
  }
  return [...names];
}

function programCardKitRefusal(source        , level      )                {
  const known = new Set(programCardKitNames(level));
  const missing = programCardUiCalls(source).filter(name => !known.has(name));
  if (!missing.length) return null;
  const names = missing.slice(0, 4).join(", ");
  return `ui_name_missing: ui has no ${names}; use only the UI HELPERS and kit names. Nothing was sent to the phone.`;
}

function programCardApplyEdits(source        , edits     )                                         {
  if (!Array.isArray(edits) || !edits.length) return { error: "invalid_request: edit needs edits [{ find, replace }] or source" };
  let out = source;
  for (const [i, edit] of edits.entries()) {
    if (!edit || typeof edit.find !== "string" || !edit.find || typeof edit.replace !== "string") {
      return { error: `invalid_request: edits[${i}] needs a non-empty find and a replace string` };
    }
    const at = out.indexOf(edit.find);
    const quote = JSON.stringify(edit.find.length > 80 ? `${edit.find.slice(0, 80)}...` : edit.find);
    if (at < 0) return { error: `edits[${i}]: find ${quote} is not in the refused card's code (copy it exactly from the code you sent)` };
    if (out.indexOf(edit.find, at + 1) >= 0) return { error: `edits[${i}]: find ${quote} appears more than once; include more of the line around it` };
    out = out.slice(0, at) + edit.replace + out.slice(at + edit.find.length);
  }
  return { source: out };
}

const PROGRAM_CARD_KEPT_REFUSAL_MS = 30 * 60_000;

const PROGRAM_CARD_REFUSED_KEPT_NEXT =
  "The host kept this refused card. Fix the named spot with edit_glasses_card: small find/replace edits to the code you just sent, not a new write_glasses_card. The host writes the fixed card on the same yes.";

const PROGRAM_CARD_REFUSED_FIXED_NEXT =
  "Your edit fixed the refused card and the host wrote it: this is that write's answer.";

const PROGRAM_CARD_REFUSED_KEPT_EDIT_NOTE =
  "A refused card is also kept: edits whose finds match its code fix it and write it.";

module.exports = { PROGRAM_CARD_KIT_LEVELS, PROGRAM_CARD_KIT_LEVEL, PROGRAM_CARD_KIT_CAPABILITY_PREFIX, PROGRAM_CARD_KIT_TOO_NEW, programCardKitLevelValue, programCardKitLevelOf, programCardKitTeachLevel, programCardKitNames, programCardKitKnows, programCardKitTooNew, programCardLibraryWithKits, PROGRAM_CARD_UI_NAMES, programCardUiCalls, programCardKitRefusal, programCardApplyEdits, PROGRAM_CARD_KEPT_REFUSAL_MS, PROGRAM_CARD_REFUSED_KEPT_NEXT, PROGRAM_CARD_REFUSED_FIXED_NEXT, PROGRAM_CARD_REFUSED_KEPT_EDIT_NOTE };
