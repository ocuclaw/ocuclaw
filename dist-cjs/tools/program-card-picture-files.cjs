const { readPictureFile } = require("./liveui-pictures/picture-file.cjs");

const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");

const PROGRAM_CARD_PICTURE_DATA_MAX = GLASSES_UI_LIMITS.imagePayloadBase64Max;

const PROGRAM_CARD_PICTURE_FILES_MAX = 8;

const PATH_LITERAL = /(["'`])((?:~\/|\/|file:\/\/)[^"'`\n\\$]{1,1024}?\.(?:png|jpe?g|gif|webp|bmp))\1/gi;

function programCardPictureFilePaths(text        )           {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set        ();
  for (const match of text.matchAll(PATH_LITERAL)) seen.add(match[2]);
  return [...seen];
}

const PROGRAM_CARD_PICTURE_FILES_KNOWN = 16;

async function embedProgramCardPictureFiles(
  texts          ,
  scope                                                                                        ,
  read                                                                                                    = readPictureFile,
  options               = {},
)                                                                                                                                                      {
  const paths = [...new Set(texts.flatMap(programCardPictureFilePaths))];
  if (paths.length === 0) return { ok: true, texts, files: [] };
  if (paths.length > PROGRAM_CARD_PICTURE_FILES_MAX) {
    return { ok: false, error: `The code names ${paths.length} picture files; one write reads at most ${PROGRAM_CARD_PICTURE_FILES_MAX}` };
  }
  const known = options.known;
  const urls = new Map                ();
  if (options.recall && known) for (const path of paths) if (known.has(path)) urls.set(path, known.get(path)          );
  const toRead = paths.filter(path => !urls.has(path));
  let found                                     = null;
  if (toRead.length) {
    try { found = await scope(); } catch { found = null; }
    if (!found || found.filesAllowed !== true) {
      return { ok: false, error: `Picture files cannot be read here (${toRead[0]}): this agent's tools run in a sandbox or on another machine. Put the picture's bytes in the card as a data:image/png;base64 source instead` };
    }
  }
  const files                                                                        = [];
  for (const path of toRead) {
    let picture                      ;
    try {
      picture = await read(path, { roots: (found                               ).roots, filesAllowed: true });
    } catch {
      picture = { ok: false, code: "picture_unreadable", detail: "unreadable" };
    }
    if (!picture.ok || picture.model) {
      const roots = (found                               ).roots.slice(0, 3);
      const where = roots.length ? `under ${roots.join(" or ")}` : "in your workspace or the temp folder";
      return { ok: false, error: `The picture file ${path} could not be read: save it as a PNG ${where} and name its full path` };
    }
    const url = `data:${picture.mime};base64,${picture.bytes.toString("base64")}`;
    if (url.length > PROGRAM_CARD_PICTURE_DATA_MAX) {
      const kb = Math.round(picture.bytes.length / 1024);
      return { ok: false, error: `The picture file ${path} is ${kb} KB; a card picture is at most ${Math.floor(PROGRAM_CARD_PICTURE_DATA_MAX * 3 / 4 / 1024)} KB. Save it with 16 greys (a palette PNG) or smaller` };
    }
    urls.set(path, url);
    files.push({ path, bytes: picture.bytes.length, width: picture.width, height: picture.height });
  }
  if (known) {
    for (const [path, url] of urls) { known.delete(path); known.set(path, url); }
    while (known.size > PROGRAM_CARD_PICTURE_FILES_KNOWN) known.delete(known.keys().next().value          );
  }
  const out = texts.map(text => typeof text === "string"
    ? text.replace(PATH_LITERAL, (whole, quote, path) => urls.has(path) ? `${quote}${urls.get(path)}${quote}` : whole)
    : text);
  return { ok: true, texts: out, files };
}

module.exports = { PROGRAM_CARD_PICTURE_DATA_MAX, PROGRAM_CARD_PICTURE_FILES_MAX, programCardPictureFilePaths, PROGRAM_CARD_PICTURE_FILES_KNOWN, embedProgramCardPictureFiles };
