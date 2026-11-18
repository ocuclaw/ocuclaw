const { isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");

function attributes(text        )                      {
  const out = new Map                ();
  while (text) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\r\n]+))(?:,|$)/.exec(text);
    if (!match || out.has(match[1])) throw new Error("Invalid HLS attributes");
    out.set(match[1], match[2] ?? match[3]); text = text.slice(match[0].length);
  }
  return out;
}
const integer = (v        ) => /^\d{1,15}$/.test(v) && Number.isSafeInteger(Number(v));
const decimal = (v        ) => /^-?\d{1,15}(?:\.\d{1,9})?$/.test(v) && Number.isFinite(Number(v));
const byteRange = (v        ) => /^\d{1,15}(?:@\d{1,15})?$/.test(v) && Number(v.split("@")[0]) > 0;
const textValue = (v        ) => v.length > 0 && v.length <= 200 && !/["\x00-\x1f\x7f]/.test(v);

function rewriteMediaHls(text        , base        , local                                            )         {
  if (text.length > 1024 * 1024 || !/^#EXTM3U(?:\r?\n|$)/.test(text)) throw new Error("Invalid HLS playlist");
  const lines = ["#EXTM3U"]; let variant = false;
  function uri(raw        , playlist = false)         {
    const target = new URL(raw, base);
    if (target.username || target.password || !["http:", "https:"].includes(target.protocol) || isForbiddenHttpDestination(target.href)) throw new Error("HLS destination is not public HTTP");
    return local(target.href, playlist);
  }
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    if (/[\x00-\x1f\x7f]/.test(line)) throw new Error("Invalid HLS line");
    if (!line.startsWith("#")) { lines.push(uri(line, variant)); variant = false; continue; }
    const colon = line.indexOf(":"), tag = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? "" : line.slice(colon + 1);
    if (["#EXT-X-ENDLIST", "#EXT-X-DISCONTINUITY", "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-I-FRAMES-ONLY", "#EXT-X-GAP"].includes(tag)) {
      if (value) throw new Error("Invalid HLS flag"); lines.push(tag);
    } else if (["#EXT-X-VERSION", "#EXT-X-TARGETDURATION", "#EXT-X-MEDIA-SEQUENCE", "#EXT-X-DISCONTINUITY-SEQUENCE"].includes(tag)) {
      if (!integer(value) || (tag === "#EXT-X-TARGETDURATION" && Number(value) === 0)) throw new Error("Invalid HLS number");
      lines.push(`${tag}:${Number(value)}`);
    } else if (tag === "#EXT-X-PLAYLIST-TYPE") {
      if (!["VOD", "EVENT"].includes(value)) throw new Error("Invalid HLS playlist type"); lines.push(`${tag}:${value}`);
    } else if (tag === "#EXTINF") {
      const duration = value.split(",")[0]; if (!decimal(duration) || Number(duration) < 0) throw new Error("Invalid HLS duration");
      lines.push(`#EXTINF:${Number(duration)},`);
    } else if (tag === "#EXT-X-BYTERANGE") {
      if (!byteRange(value)) throw new Error("Invalid HLS byte range"); lines.push(`${tag}:${value}`);
    } else if (tag === "#EXT-X-PROGRAM-DATE-TIME") {
      const date = Date.parse(value); if (!Number.isFinite(date)) throw new Error("Invalid HLS date"); lines.push(`${tag}:${new Date(date).toISOString()}`);
    } else if (tag === "#EXT-X-START") {
      const a = attributes(value), offset = a.get("TIME-OFFSET") || "";
      if (!decimal(offset)) throw new Error("Invalid HLS start");
      const fields = [`TIME-OFFSET=${Number(offset)}`];
      if (a.has("PRECISE")) { if (!["YES", "NO"].includes(a.get("PRECISE") || "")) throw new Error("Invalid HLS start precision"); fields.push(`PRECISE=${a.get("PRECISE")}`); }
      lines.push(`${tag}:${fields.join(",")}`);
    } else if (tag === "#EXT-X-KEY" || tag === "#EXT-X-SESSION-KEY") {
      const a = attributes(value), method = a.get("METHOD"), keyUri = a.get("URI");
      if (method === "NONE" && tag === "#EXT-X-KEY") { lines.push(`${tag}:METHOD=NONE`); continue; }
      if (!["AES-128", "SAMPLE-AES"].includes(method || "") || (a.has("KEYFORMAT") && a.get("KEYFORMAT") !== "identity") || !keyUri) throw new Error("Unsupported HLS key");
      const fields = [`METHOD=${method}`, `URI="${uri(keyUri)}"`], iv = a.get("IV");
      if (iv !== undefined) { if (!/^0[xX][0-9A-Fa-f]{32}$/.test(iv)) throw new Error("Invalid HLS IV"); fields.push(`IV=${iv}`); }
      lines.push(`${tag}:${fields.join(",")}`);
    } else if (tag === "#EXT-X-MAP") {
      const a = attributes(value), mapUri = a.get("URI"), range = a.get("BYTERANGE"); if (!mapUri) throw new Error("Missing HLS map");
      const fields = [`URI="${uri(mapUri)}"`];
      if (range !== undefined) { if (!byteRange(range)) throw new Error("Invalid HLS map range"); fields.push(`BYTERANGE="${range}"`); }
      lines.push(`${tag}:${fields.join(",")}`);
    } else if (tag === "#EXT-X-STREAM-INF" || tag === "#EXT-X-I-FRAME-STREAM-INF") {
      const a = attributes(value), bandwidth = a.get("BANDWIDTH") || "", fields = [];
      if (!integer(bandwidth)) throw new Error("Missing HLS bandwidth"); fields.push(`BANDWIDTH=${bandwidth}`);
      for (const name of ["AVERAGE-BANDWIDTH", "RESOLUTION", "FRAME-RATE", "CODECS", "AUDIO", "VIDEO", "SUBTITLES", "CLOSED-CAPTIONS"]) {
        const v = a.get(name); if (v === undefined) continue;
        const valid = name === "AVERAGE-BANDWIDTH" ? integer(v) : name === "RESOLUTION" ? /^\d{1,5}x\d{1,5}$/.test(v)
          : name === "FRAME-RATE" ? decimal(v) : name === "CODECS" ? /^[A-Za-z0-9.,_-]{1,200}$/.test(v) : textValue(v);
        if (!valid) throw new Error("Invalid HLS stream attribute");
        const quoted = ["CODECS", "AUDIO", "VIDEO", "SUBTITLES"].includes(name) || (name === "CLOSED-CAPTIONS" && v !== "NONE");
        fields.push(`${name}=${quoted ? `"${v}"` : v}`);
      }
      if (tag === "#EXT-X-I-FRAME-STREAM-INF") { const iframe = a.get("URI"); if (!iframe) throw new Error("Missing HLS iframe"); fields.push(`URI="${uri(iframe, true)}"`); }
      else variant = true;
      lines.push(`${tag}:${fields.join(",")}`);
    } else if (tag === "#EXT-X-MEDIA") {
      const a = attributes(value), type = a.get("TYPE") || "";
      if (!["AUDIO", "VIDEO", "SUBTITLES"].includes(type)) continue;
      const fields = [`TYPE=${type}`];
      for (const name of ["GROUP-ID", "NAME", "LANGUAGE"]) {
        const v = a.get(name); if (v === undefined && name === "LANGUAGE") continue;
        if (v === undefined || !textValue(v)) throw new Error("Invalid HLS rendition"); fields.push(`${name}="${v}"`);
      }
      for (const name of ["DEFAULT", "AUTOSELECT", "FORCED"]) {
        const v = a.get(name); if (v === undefined) continue;
        if (!["YES", "NO"].includes(v)) throw new Error("Invalid HLS rendition flag"); fields.push(`${name}=${v}`);
      }
      const rendition = a.get("URI"); if (rendition !== undefined) fields.push(`URI="${uri(rendition, true)}"`);
      lines.push(`${tag}:${fields.join(",")}`);
    }

  }
  if (variant) throw new Error("Missing HLS variant URI");
  return lines.join("\n") + "\n";
}

module.exports = { rewriteMediaHls };
