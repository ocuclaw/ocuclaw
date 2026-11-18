const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/;

const STEP = /^\[(\d+)\/(\d+)\]\s+(.*)$/;

const STEP_START = /\[(\d+)\/(\d+)\]\s/;

const URL = /https?:\/\/\S+/;

const WORDS_ROW = /^[│|]\s+(\S.*?)\s+[│|]$/;

const NUMBERED = /^(\d\.?) /;

const WEB_ADDRESS = /((?:[\p{L}\p{N}_-]+\.)+(?:com|net|org|io|gg)(?:\/\S*)?)/u;

const EXPIRY_CLOCK = /^Expires in (\d+):(\d\d)\.?$/;
const EXPIRY_NOTE = /expires? in \d+ (minute|second)s?\.?$/;
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const ANSI_ALL = new RegExp(ANSI.source, "g");

function flagsWithout(re        , drop        )         {
  return re.flags
    .split("")
    .filter((f) => !drop.includes(f))
    .join("");
}

const STICKY = new WeakMap                ();
const PLAIN = new WeakMap                ();
const WHOLE = new WeakMap                ();

function pyMatch(re        , text        )                         {
  let sticky = STICKY.get(re);
  if (!sticky) {
    sticky = new RegExp(re.source, flagsWithout(re, "gy") + "y");
    STICKY.set(re, sticky);
  }
  sticky.lastIndex = 0;
  return sticky.exec(text);
}

function pySearch(re        , text        )                         {
  let plain = PLAIN.get(re);
  if (!plain) {
    plain = new RegExp(re.source, flagsWithout(re, "gy"));
    PLAIN.set(re, plain);
  }
  return plain.exec(text);
}

function pyFullmatch(re        , text        )                         {
  let whole = WHOLE.get(re);
  if (!whole) {
    whole = new RegExp(`^(?:${re.source})$`, flagsWithout(re, "gym"));
    WHOLE.set(re, whole);
  }
  return whole.exec(text);
}

const PY_SPACE =
  "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0" +
  String.fromCharCode(0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000);

function isIn(ch        , chars                           )          {
  return (chars ?? PY_SPACE).includes(ch);
}

function pyLstrip(text        , chars                )         {
  let i = 0;
  while (i < text.length && isIn(text[i], chars)) i++;
  return text.slice(i);
}

function pyRstrip(text        , chars                )         {
  let end = text.length;
  while (end > 0 && isIn(text[end - 1], chars)) end--;
  return text.slice(0, end);
}

function pyStrip(text        , chars                )         {
  return pyLstrip(pyRstrip(text, chars), chars);
}

function pySplit(text        )           {
  const out           = [];
  let word = "";
  for (const ch of text) {
    if (PY_SPACE.includes(ch)) {
      if (word) out.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word) out.push(word);
  return out;
}

function cpLen(text        )         {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function cpSlice(text        , start        , end         )         {
  return Array.from(text).slice(start, end).join("");
}

function pyRound(x        )         {
  const r = Math.round(x);

  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) || 0;
}

function pyMod(a        , b        )         {
  return ((a % b) + b) % b;
}

function stripAnsi(text        )         {
  return text.replace(ANSI_ALL, "");
}

function wrap(text        , width        )           {
  width = Math.max(4, width);
  const out           = [];
  let line = "";
  let lineLen = 0;
  for (const whole of pySplit(text)) {
    let word = Array.from(whole);
    while (word.length > width) {
      if (line) {
        out.push(line);
        line = "";
        lineLen = 0;
      }
      out.push(word.slice(0, width).join(""));
      word = word.slice(width);
    }
    const piece = word.join("");
    if (!line) {
      line = piece;
      lineLen = word.length;
    } else if (lineLen + 1 + word.length <= width) {
      line += " " + piece;
      lineLen += 1 + word.length;
    } else {
      out.push(line);
      line = piece;
      lineLen = word.length;
    }
  }
  if (line) out.push(line);
  return out;
}

function clipAnsi(text        , width        )         {
  const out           = [];
  let seen = 0;
  let at = 0;
  for (const match of text.matchAll(ANSI_ALL)) {
    const start = match.index ?? 0;
    const plain = Array.from(text.slice(at, start));
    if (seen + plain.length > width) {
      out.push(plain.slice(0, width - seen).join(""));
      return out.join("") + "\x1b[0m";
    }
    out.push(plain.join(""));
    seen += plain.length;
    out.push(match[0]);
    at = start + match[0].length;
  }
  const plain = Array.from(text.slice(at));
  if (seen + plain.length > width) {
    return out.join("") + plain.slice(0, width - seen).join("") + "\x1b[0m";
  }
  return out.join("") + plain.join("");
}

function trunc(text        , width        )         {
  const chars = Array.from(text);
  return chars.length <= width ? text : chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

function mmss(seconds        )         {
  const s = Math.max(0, Math.trunc(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ease(x        )         {
  x = Math.max(0.0, Math.min(1.0, x));
  return 1 - (1 - x) ** 3;
}

module.exports = { ANSI, STEP, STEP_START, URL, WORDS_ROW, NUMBERED, WEB_ADDRESS, EXPIRY_CLOCK, EXPIRY_NOTE, SPIN, pyMatch, pySearch, pyFullmatch, PY_SPACE, pyLstrip, pyRstrip, pyStrip, pySplit, cpLen, cpSlice, pyRound, pyMod, stripAnsi, wrap, clipAnsi, trunc, mmss, ease };
