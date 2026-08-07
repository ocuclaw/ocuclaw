function buildBundlePreview(files, opts) {
  const maxEvents = (opts && typeof opts.maxEvents === "number" && opts.maxEvents > 0) ? opts.maxEvents : 15;
  const maxCharsPerEvent = (opts && typeof opts.maxCharsPerEvent === "number" && opts.maxCharsPerEvent > 0) ? opts.maxCharsPerEvent : 80;

  const SKIP = new Set(["README.md", "metadata.json", "correlation-liveui.jsonl"]);

  const catParsed = [];

  const catNames = [];

  if (files && typeof files.forEach === "function") {
    files.forEach((content, filename) => {
      if (SKIP.has(filename)) return;
      if (!filename.endsWith(".jsonl")) return;

      const cat = filename.slice(0, -(".jsonl".length));
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      const parsed = [];
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {

          continue;
        }
        parsed.push(obj);
      }
      if (parsed.length > 0) {
        catParsed.push(parsed);
        catNames.push(cat);
      }
    });
  }

  const events = [];

  let totalParsed = 0;
  for (const parsed of catParsed) {
    totalParsed += parsed.length;
  }

  if (catParsed.length > 0) {
    const indices = new Array(catParsed.length).fill(0);
    let added = 0;
    let anyProgress = true;
    while (added < maxEvents && anyProgress) {
      anyProgress = false;
      for (let ci = 0; ci < catParsed.length && added < maxEvents; ci++) {
        const idx = indices[ci];
        if (idx >= catParsed[ci].length) continue;
        indices[ci] = idx + 1;
        anyProgress = true;
        const parsed = catParsed[ci][idx];
        const ts = (parsed && typeof parsed.ts === "number") ? parsed.ts : 0;
        const cat = (parsed && typeof parsed.cat === "string" && parsed.cat) ? parsed.cat : catNames[ci];
        const text = extractText(parsed, maxCharsPerEvent);
        events.push({ ts, cat, text });
        added++;
      }
    }
  }

  const truncated = totalParsed > events.length;

  return { events, truncated };
}

function extractText(parsed, maxChars) {
  if (!parsed) return truncate("", maxChars);

  const data = parsed.data;
  const eventName = (typeof parsed.event === "string" && parsed.event) ? parsed.event : "";

  let text = "";

  if (data && typeof data === "object" && !Array.isArray(data)) {

    const TEXT_LIKE_KEYS = ["message", "text", "label", "note", "description", "reason", "state", "error"];
    for (const key of TEXT_LIKE_KEYS) {
      if (typeof data[key] === "string" && data[key]) {
        text = data[key];
        break;
      }
    }
    if (!text) {

      for (const v of Object.values(data)) {
        if (typeof v === "string" && v) {
          text = v;
          break;
        }
      }
    }
    if (!text) {

      const preview = {};
      let count = 0;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "number" || typeof v === "boolean") {
          preview[k] = v;
          if (++count >= 3) break;
        }
      }
      if (count > 0) {
        text = JSON.stringify(preview);
      }
    }
  }

  if (!text && eventName) {
    text = eventName;
  }

  return truncate(text, maxChars);
}

function truncate(s, maxChars) {
  if (typeof s !== "string") return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "…";
}

module.exports = { buildBundlePreview };
