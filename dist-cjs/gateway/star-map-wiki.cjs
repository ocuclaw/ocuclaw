const { STAR_MAP_LIMITS, clipStarMapText, normalizeStarMapGraph, starMapStableHash } = require("../domain/star-map.cjs");

const MAX_PAGES = 48;
const KINDS                         = { entity: "Entities", concept: "Concepts", synthesis: "Knowledge" };

const pageId = (pagePath        ) => `wiki:${starMapStableHash(pagePath)}`;

async function boundedRead(request         , method        , params        , milliseconds        )               {
  let timer                                           ;
  try {
    return await Promise.race([request(method, params), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Memory Wiki read timed out"), { code: "wiki_timeout" })), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function safePath(raw         )         {
  if (typeof raw !== "string" || raw.length > STAR_MAP_LIMITS.sourcePathChars) return "";
  const value = raw.replace(/\\/g, "/");
  if (value.startsWith("/") || /^[a-z]+:/i.test(value)) return "";
  const parts           = [];
  for (const part of value.split("/")) {
    if (part === "..") { if (!parts.length) return ""; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function plain(raw         )         {
  return typeof raw === "string" ? raw.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, title) => title || target)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(^|\n)\s*#{1,6}\s*/g, "$1").replace(/[*`]/g, "").trim() : "";
}

function wikiFactKey(text        )         {
  return plain(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function targets(body        )           {
  const found           = [];
  const markdown = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "").replace(/`[^`\n]*`/g, "");
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]|(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(re)) {
    try { found.push(decodeURIComponent((match[1] || match[2]).split("#")[0])); } catch {  }
  }
  return found;
}

async function readOpenClawWiki(request         , agentId        )                                                 {
  const overview = await boundedRead(request, "wiki.overview", { agentId }, 3000);
  if (!overview || !Array.isArray(overview.clusters)) throw new Error("Invalid Memory Wiki overview");
  const items        = [];
  const seen = new Set        ();
  for (const cluster of Array.isArray(overview?.clusters) ? overview.clusters : []) {
    for (const item of Array.isArray(cluster?.items) ? cluster.items : []) {
      const pagePath = safePath(item?.pagePath);
      if (!pagePath || typeof KINDS[item?.kind] !== "string" || typeof item.title !== "string" || !item.title.trim() || seen.has(pagePath)) continue;
      seen.add(pagePath);
      items.push({ ...item, pagePath });
      if (items.length === MAX_PAGES) break;
    }
    if (items.length === MAX_PAGES) break;
  }
  const bodies = new Map             ();
  const deadline = Date.now() + 3000;
  let cursor = 0;
  const lookups = items.map((item) => item.pagePath);
  if (items.length) lookups.push("reports/relationship-graph.md");

  await Promise.all(Array.from({ length: Math.min(6, lookups.length) }, async () => {
    while (cursor < lookups.length && Date.now() < deadline) {
      const lookup = lookups[cursor++];
      try {
        const page = await boundedRead(request, "wiki.get", { agentId, lookup, corpus: "wiki", backend: "local", fromLine: 1, lineCount: 100 }, Math.max(1, deadline - Date.now()));
        if (page?.corpus === "wiki" && safePath(page.path) === lookup && typeof page.content === "string") bodies.set(lookup, page);
      } catch {  }
    }
  }));
  const facts = new Set        ();
  const nodes                = items.map((item) => {
    const page = bodies.get(item.pagePath);
    const claims = (Array.isArray(item.claims) ? item.claims : []).filter((claim         ) => typeof claim === "string");
    for (const claim of claims) facts.add(wikiFactKey(claim));
    const summary = plain(claims.join(" ") || item.snippet || item.title);
    facts.add(wikiFactKey(summary));
    const body = page?.content?.slice(0, 24000) || "";
    const evidence = body.split(/\r?\n/).filter((line        ) => /sources\/|memory\/[^\s]+\.md|#L\d/.test(line)).slice(0, 4).join(" ");
    const details = [page?.provenanceLabel, page?.sourcePath, plain(evidence), ...claims, plain(body)].filter(Boolean).join(" · ");
    const updated = Date.parse(item.updatedAt || "");
    return {
      id: pageId(item.pagePath), kind: "memory", group: KINDS[item.kind],
      name: clipStarMapText(item.title, STAR_MAP_LIMITS.nameChars),
      text: clipStarMapText(summary, STAR_MAP_LIMITS.textChars), description: "",
      createdAtMs: Number.isFinite(updated) ? updated : null, uses: 0, by: "", stale: false,
      pinned: false, importance: 0, source: "Memory Wiki", origin: "wiki", sourcePath: item.pagePath,
      details: clipStarMapText(details || summary, STAR_MAP_LIMITS.detailsChars), canForget: false,
    };
  });
  const ids = new Map(items.map((item) => [item.pagePath.replace(/\.md$/i, ""), pageId(item.pagePath)]));
  const resolve = (target        , from        )                     => {
    if (!target || target.startsWith("/") || /^[a-z]+:/i.test(target)) return undefined;
    const direct = safePath(target).replace(/\.md$/i, "");
    const relative = safePath(`${from.slice(0, from.lastIndexOf("/") + 1)}${target}`).replace(/\.md$/i, "");
    return ids.get(relative) || ids.get(direct);
  };
  const links                        = [];
  for (const item of items) {
    const body = bodies.get(item.pagePath)?.content?.slice(0, 24000) || "";
    for (const target of targets(body)) {
      const b = resolve(target, item.pagePath);
      if (b) links.push({ a: pageId(item.pagePath), b });
    }
  }
  const reportPath = "reports/relationship-graph.md";
  for (const line of (bodies.get(reportPath)?.content?.slice(0, 24000) || "").split(/\r?\n/)) {
    const arrow = line.indexOf(" -> ");
    if (arrow < 0) continue;
    const a = resolve(targets(line.slice(0, arrow))[0] || "", reportPath);
    const b = resolve(targets(line.slice(arrow + 4))[0] || "", reportPath);
    if (a && b) links.push({ a, b });
  }
  return { ...normalizeStarMapGraph({ nodes, links }), facts };
}

module.exports = { wikiFactKey, readOpenClawWiki };
