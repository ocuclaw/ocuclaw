const { marked } = require("marked");
const { classifyPictureSource } = require("../tools/liveui-pictures/picture-source.cjs");

const PICTURE_FALLBACK_MAX = 8;
const ALT_MAX_CHARS = 64;
const TITLE_MAX_CHARS = 40;
const WORDS_MAX_CHARS = 600;

function oneLine(value         )         {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value        , max        )         {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function attr(value        )         {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bodyText(value        )         {
  return value.replace(/</g, "‹").replace(/>/g, "›");
}

function cell(value        )         {
  return bodyText(value).replace(/\|/g, "/");
}

function fetchable(src        )          {
  const kind = classifyPictureSource(src).kind;
  return kind === "url" || kind === "file";
}

const MEDIA_LINE_RE = /^[ \t]*MEDIA:[ \t]*`?([^`\n]*?)`?[ \t]*$/;
const LABEL_MAX_CHARS = 40;

function mediaLines(text        )                                      {
  if (!text.includes("MEDIA:")) return { sources: [], rest: text };
  const sources           = [];
  let fenced = false;
  const kept = text.split("\n").filter((line) => {
    if (/^[ \t]*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return true;
    const m = MEDIA_LINE_RE.exec(line);
    if (!m) return true;
    const src = oneLine(m[1]).replace(/^["']|["']$/g, "");
    if (src) sources.push(src);
    return false;
  });
  return { sources, rest: kept.join("\n") };
}

function itemLabel(item     )         {
  const strong = (item?.tokens || []).flatMap((t     ) => (t.tokens || []).filter((s     ) => s.type === "strong"))[0];
  const text = oneLine(strong ? strong.text : item?.text).replace(/\*\*|__|`/g, "");
  const lead = strong ? text : text.split(/\s[—–-]\s|:\s/)[0];
  return clip(oneLine(lead), LABEL_MAX_CHARS);
}

function listOf(tokens       , count        )               {
  for (const token of tokens || []) {
    if (token?.type === "list" && Array.isArray(token.items) && token.items.length === count) return token.items;
  }
  return null;
}

function collect(tokens       , out                , words          )       {
  for (const token of tokens || []) {
    if (!token || typeof token !== "object") continue;
    if (token.type === "code" || token.type === "codespan" || token.type === "html") {
      if (token.type !== "html" && typeof token.text === "string") words.push(token.text);
      continue;
    }
    if (token.type === "image") {
      const src = oneLine(token.href);
      if (src && fetchable(src)) out.push({ src, alt: clip(oneLine(token.text || token.title), ALT_MAX_CHARS) });
      continue;
    }
    if (token.type === "list" && Array.isArray(token.items)) {
      token.items.forEach((item     , index        ) => {
        const before = words.length;
        collect(item.tokens || [], out, words);
        const text = words.splice(before).join("").replace(/\s*\n\s*/g, " ").trim();
        if (text) words.push(`${token.ordered ? `${index + 1}.` : "-"} ${text}\n`);
      });
      continue;
    }
    if (Array.isArray(token.tokens) && token.tokens.length > 0) {
      collect(token.tokens, out, words);
    } else if (token.type === "text" || token.type === "escape") {
      words.push(token.text || "");
    } else if (token.type === "br") {
      words.push("\n");
    }
    if (token.type === "paragraph" || token.type === "heading") words.push("\n");
  }
}

function replyPictures(text        )                                              {
  if (typeof text !== "string") return { pictures: [], words: "" };
  const media = mediaLines(text);
  const mediaSources = media.sources.filter(fetchable);
  if (!text.includes("![") && mediaSources.length === 0) return { pictures: [], words: "" };
  let tokens       ;
  try {
    tokens = marked.lexer(media.rest);
  } catch {
    return { pictures: [], words: "" };
  }
  const pictures                 = [];
  const words           = [];
  collect(tokens, pictures, words);
  if (mediaSources.length > 0) {
    const items = mediaSources.length > 1 ? listOf(tokens, mediaSources.length) : null;
    for (const [i, src] of mediaSources.entries()) pictures.push({ src, alt: items ? itemLabel(items[i]) : "" });
  }
  const lines = words
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  return { pictures, words: lines.join("\n") };
}

function plateRecords(pic              , caption        )         {
  const alt = pic.alt || "Picture";
  const out = [
    `<ui frame="plate" title="${attr(clip(alt, TITLE_MAX_CHARS))}"/>`,
    `<ui id="pic" c="image" in="plate" src="${attr(pic.src)}" alt="${attr(alt)}"/>`,
  ];
  if (caption) out.push(`<ui id="words" c="text" in="caption">${bodyText(caption)}</ui>`);
  return out.join("\n");
}

function railRecords(pictures                , caption        )         {
  const rows = pictures.map((p, i) => `${cell(p.alt || `Picture ${i + 1}`)}||${p.src}`);
  const out = [
    `<ui frame="rail-plate" title="Pictures"/>`,
    `<ui id="pics" c="list" in="rail" cols="name,note,pic">\n${rows.join("\n")}\n</ui>`,
    `<ui id="pic" c="image" in="plate" src="=sel.pic" alt="=sel.name"/>`,
  ];
  if (caption) out.push(`<ui id="words" c="text" in="foot">${bodyText(caption)}</ui>`);
  return out.join("\n");
}

function replyPictureFallbackRecords(text        )                {
  const { pictures: all, words } = replyPictures(text);
  const seen = new Set        ();
  const pictures = all.filter((p) => (seen.has(p.src) ? false : (seen.add(p.src), true))).slice(0, PICTURE_FALLBACK_MAX);
  const caption = clip(words, WORDS_MAX_CHARS);
  if (pictures.length === 1) return plateRecords(pictures[0], caption);

  const rowPictures = pictures.filter((p) => !p.src.includes("|"));
  if (rowPictures.length >= 2) return railRecords(rowPictures, caption);
  return pictures.length > 0 ? plateRecords(rowPictures[0] ?? pictures[0], caption) : null;
}

module.exports = { PICTURE_FALLBACK_MAX, MEDIA_LINE_RE, replyPictures, replyPictureFallbackRecords };
