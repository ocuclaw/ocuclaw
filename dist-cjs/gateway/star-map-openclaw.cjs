const fs = require("node:fs");
const { STAR_MAP_LIMITS, clipStarMapText, createStarMapForgetError, createStarMapUnsupportedError, isStarMapMethodNotFound, normalizeStarMapGraph, parseStarMapForgetParams, starMapStableHash: stableHash } = require("../domain/star-map.cjs");

const { readOpenClawWiki, wikiFactKey } = require("./star-map-wiki.cjs");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const DREAMING_HEADING_RE =
  /^(?:promoted from short-term memory|consolidated memory)\b\s*(?:\((\d{4})-(\d{2})-(\d{2})\))?/i;
const PROJECT_HEADING_RE = /^project:\s*(.+)$/i;
const GLOBAL_HEADING_RE = /^global$/i;
const FENCE_RE = /^\s*(```|~~~)/;
const PROMOTION_MARKER_RE = /^<!--\s*openclaw-memory-promotion:\s*([^\n]*?)\s*-->$/i;
const BULLET_RE = /^(?:[-*+]|\d{1,3}[.)])\s+(.*\S)\s*$/;
const META_BRACKET_RE = /\s*\[((?:score|signals|recalls|avg|source)=[^\]]*)\]/i;
const SOURCE_REF_RE = /\s*\bSource:\s+(\S+?)#L(\d+)(?:-L(\d+))?\b/i;
const TRIGGER_RE = /<!--\s*trigger:\s*([\s\S]*?)\s*-->/i;
const IMPORTANCE_RE = /<!--\s*importance:\s*(\d+)\s*-->/i;
const PROJECT_COMMENT_RE = /<!--\s*project:\s*([\s\S]*?)\s*-->/i;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const CHECKBOX_RE = /^\[[ xX]\]\s+/;
const DATED_NOTE_RE = /^(\d{4})-(\d{2})-(\d{2})\b[^/\\]*\.md$/i;
const NO_SNIPPET = "(no snippet captured)";

const STOPWORDS = new Set(
  (
    "about above after again against also always among another anyone anything around away back " +
    "because been before being below between both came cannot come could does doing done down " +
    "during each either else even ever every find first from gets give goes going good have having " +
    "help here into just keep kind know last less like little long look made make many maybe more " +
    "most much must need never next none only other ought over same says should show since some " +
    "still such sure take than that their them then there these they thing things this those though " +
    "through time to too under until upon used user uses using very want ways well went were what " +
    "when where whether which while will with within without would your yours yourself " +
    "agent memory memories note notes skill skills source score recall recalls signals trigger importance"
  ).split(/\s+/),
);

function clean(value         )         {
  return typeof value === "string" ? value.trim() : "";
}

function localMidnightMs(year        , month        , day        )                {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const at = new Date(y, m - 1, d).getTime();
  return Number.isFinite(at) ? at : null;
}

function clipWords(text        , max        )         {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, "")}…`;
}

function memoryTitle(text        )         {
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(text);
  const first = sentence && sentence[1].length >= 12 ? sentence[1] : text;
  return clipWords(first.replace(/[.!?]+$/, ""), STAR_MAP_LIMITS.nameChars);
}

function memoryId(key        , text        )         {
  const k = clean(key);
  if (k) {
    const id = k.startsWith("memory:") ? k : `memory:${k}`;
    if (Array.from(id).length <= STAR_MAP_LIMITS.idChars) return id;
    return `memory:k:${stableHash(k)}`;
  }
  return `memory:h:${stableHash(text.toLowerCase())}`;
}

function noteRefFromMeta(meta        )                 {
  const match = /\bsource=(\S+?):(\d+)(?:-(\d+))?(?=\s|$)/i.exec(meta);
  if (!match) return null;
  const start = Number(match[2]);
  return { path: match[1], start, end: match[3] ? Number(match[3]) : start };
}

function noteDateMs(ref                )                {
  if (!ref) return null;
  const base = ref.path.split(/[\\/]/).pop() || "";
  const dated = DATED_NOTE_RE.exec(base);
  return dated ? localMidnightMs(dated[1], dated[2], dated[3]) : null;
}

function humanSource(ref                )         {
  if (!ref) return "";
  const base = ref.path.split(/[\\/]/).pop() || ref.path;
  const dated = DATED_NOTE_RE.exec(base);
  let label = dated
    ? `${Number(dated[3])} ${MONTHS[Number(dated[2]) - 1] || dated[2]} notes`
    : `${base.replace(/\.md$/i, "")} notes`;
  if (Number.isFinite(ref.start) && ref.start > 0) {
    label +=
      Number.isFinite(ref.end) && ref.end > ref.start
        ? `, lines ${ref.start}–${ref.end}`
        : `, line ${ref.start}`;
  }
  return clipStarMapText(label, STAR_MAP_LIMITS.sourceChars);
}

function memoryNode(fields

 )                      {
  return {
    id: fields.id,
    kind: "memory",
    group: clipStarMapText(fields.group, STAR_MAP_LIMITS.groupChars) || "Memory",
    name: memoryTitle(fields.text),
    text: clipStarMapText(fields.text, STAR_MAP_LIMITS.textChars),
    description: "",
    createdAtMs: fields.createdAtMs,
    uses: fields.uses,
    by: fields.by,
    stale: false,
    pinned: false,
    importance: fields.importance,
    source: fields.source,
    tags: fields.tags,
  };
}

function parseOpenClawMemoryMd(content         )                        {
  return parseOpenClawMemoryMdLines(content).map((located) => located.entry);
}

function parseOpenClawMemoryMdLines(content         )                               {
  if (typeof content !== "string" || !content.trim()) return [];
  const out                               = [];
  let heading = "";
  let dreaming                                   = null;
  let projectKey = "";
  let pendingKey = "";
  let pendingMarkerLine = -1;
  let inFence = false;
  const lines = content.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      pendingKey = "";
      pendingMarkerLine = -1;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch && line.startsWith("#")) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].replace(/<!--[\s\S]*?-->/g, "").trim();
      pendingKey = "";
      pendingMarkerLine = -1;
      const dreamingHeading = DREAMING_HEADING_RE.exec(text);
      if (dreamingHeading) {
        dreaming = {
          dateMs: dreamingHeading[1]
            ? localMidnightMs(dreamingHeading[1], dreamingHeading[2], dreamingHeading[3])
            : null,
        };
        projectKey = "";
        continue;
      }
      if (dreaming && level >= 3) {
        const project = PROJECT_HEADING_RE.exec(text);
        if (project) projectKey = project[1].trim();
        else if (GLOBAL_HEADING_RE.test(text)) projectKey = "";
        continue;
      }
      dreaming = null;
      projectKey = "";
      heading = text;
      continue;
    }

    const marker = PROMOTION_MARKER_RE.exec(trimmed);
    if (marker) {
      pendingKey = marker[1];
      pendingMarkerLine = lineIndex;
      continue;
    }
    if (trimmed.startsWith("<!--")) continue;

    const bullet = BULLET_RE.exec(line);
    if (!bullet) continue;
    const body = bullet[1];
    const key = pendingKey;
    const markerLine = pendingMarkerLine;
    pendingKey = "";
    pendingMarkerLine = -1;

    const meta = META_BRACKET_RE.exec(body);
    const sourceRef = SOURCE_REF_RE.exec(body);
    const trigger = TRIGGER_RE.exec(body);
    const importanceTag = IMPORTANCE_RE.exec(body);
    const isDreaming = Boolean(dreaming || key || meta || sourceRef || trigger || importanceTag);

    if (!isDreaming) {
      const text = body
        .replace(HTML_COMMENT_RE, " ")
        .replace(CHECKBOX_RE, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text === NO_SNIPPET) continue;
      out.push({
        line: lineIndex,
        markerLine,
        entry: memoryNode({
          id: memoryId("", text),
          group: heading || "Memory",
          text,
          createdAtMs: null,
          uses: 0,
          by: "",
          importance: 0,
          source: "",
          tags: [],
        }),
      });
      continue;
    }

    const text = body
      .replace(HTML_COMMENT_RE, " ")
      .replace(META_BRACKET_RE, " ")
      .replace(SOURCE_REF_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === NO_SNIPPET) continue;

    const metaText = meta ? meta[1] : "";
    const ref                 = sourceRef
      ? {
          path: sourceRef[1],
          start: Number(sourceRef[2]),
          end: sourceRef[3] ? Number(sourceRef[3]) : Number(sourceRef[2]),
        }
      : noteRefFromMeta(metaText);
    const scoreMatch = /\bscore=([0-9]*\.?[0-9]+)/i.exec(metaText);
    const recallsMatch = /\brecalls=(\d+)/i.exec(metaText);
    const score = scoreMatch ? Number(scoreMatch[1]) : NaN;
    const importance = importanceTag
      ? Math.min(10, Math.max(0, Number(importanceTag[1])))
      : Number.isFinite(score)
        ? Math.min(10, Math.max(3, Math.round(score * 10)))
        : 0;
    const tags = trigger
      ? trigger[1]
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
    const projectComment = PROJECT_COMMENT_RE.exec(body);
    const project =
      projectKey ||
      (projectComment ? projectComment[1].split(";")[0].trim() : "");
    const group = tags.length ? `#${tags[0]}` : project || "Memory";

    out.push({
      line: lineIndex,
      markerLine,
      entry: memoryNode({
        id: memoryId(key, text),
        group,
        text,
        createdAtMs: (dreaming && dreaming.dateMs) || noteDateMs(ref),
        uses: recallsMatch ? Number(recallsMatch[1]) : 0,
        by: "dreaming",
        importance,
        source: humanSource(ref),
        tags,
      }),
    });
  }
  return out;
}

function parseOpenClawWorkspaceLines(content        , name = "MEMORY.md")                               {
  const profile = name === "USER.md";
  const lines = content.split(/\r?\n/);
  const masked = [...lines];
  const directiveTemplate = profile && /^# USER\.md - User Model\s*$/m.test(content) && /^## Directives\s*$/m.test(content);
  let inDirectives = !directiveTemplate;
  let superseded = false;
  let observedLine = -1;
  let observedAt                = null;
  let inFence = false;
  const metadata = new Map                                             ();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (FENCE_RE.test(line)) { inFence = !inFence; masked[i] = ""; continue; }
    if (inFence) { masked[i] = ""; continue; }
    if (profile && /^#{1,6}\s/.test(line)) {
      if (directiveTemplate && /^##\s/.test(line)) inDirectives = !/^## Related\s*$/i.test(line);
      if (/^## Related\s*$/i.test(line)) inDirectives = false;
      superseded = false;
      observedLine = -1;
    }
    const observed = /^<!--\s*observed:\s*([^|]+)\|\s*status:\s*(active|superseded)\s*-->$/i.exec(line);
    if (profile && observed) {
      superseded = observed[2].toLowerCase() === "superseded";
      observedLine = i;
      const parsed = Date.parse(observed[1].trim());
      observedAt = Number.isFinite(parsed) ? parsed : null;
    }
    if (profile && (!inDirectives || superseded || /^Replace the example below\b/.test(line) || /^- Prefer\s*\.{3}\s*$/.test(line) || /^[-*]\s+\*\*[^*]+:\*\*\s*$/.test(line))) {
      masked[i] = "";
    }
    if (profile && observedLine >= 0) metadata.set(i, { line: observedLine, at: observedAt });
  }
  const maskedContent = masked.join("\n");
  const entries = parseOpenClawMemoryMdLines(maskedContent);
  let heading = profile ? "About you" : "Memory";
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i];
    const title = HEADING_RE.exec(line);
    if (title) { heading = title[2]; continue; }
    if (!line.trim() || /^\s/.test(line) || BULLET_RE.test(line) || line.startsWith("<!--") || /^[-*_]{3,}\s*$/.test(line)) continue;
    const start = i;
    const paragraph = [line];
    while (i + 1 < masked.length && masked[i + 1].trim() && !/^(?:\s|#|<!--)/.test(masked[i + 1]) && !BULLET_RE.test(masked[i + 1])) paragraph.push(masked[++i]);
    const text = paragraph.join(" ").replace(HTML_COMMENT_RE, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    entries.push({ line: start, endLine: i, markerLine: -1, entry: memoryNode({ id: memoryId("", text), group: heading, text, createdAtMs: null, uses: 0, by: "", importance: 0, source: "", tags: [] }) });
  }
  return entries.sort((a, b) => a.line - b.line).map((located) => {
    if (!profile) return located;
    const meta = metadata.get(located.line);
    return { ...located, markerLine: meta?.line ?? -1, entry: {
      ...located.entry, id: `profile:${stableHash(located.entry.id)}`,
      group: "About you", by: "user", source: "USER.md", origin: "profile"         ,
      sourcePath: "USER.md", details: "", canForget: true, createdAtMs: meta?.at ?? null,
    } };
  });
}

function removeOpenClawMemoryEntry(content        , id        , text        , name = "MEMORY.md")         {
  const entries = parseOpenClawWorkspaceLines(content, name);
  const matches = entries.filter((located) => located.entry.id === id);
  if (matches.length === 0) throw createStarMapForgetError("stale");
  if (matches.length > 1) throw createStarMapForgetError("ambiguous");
  const match = matches[0];
  if (match.entry.text !== text) throw createStarMapForgetError("stale");
  const sharedMarker = entries.filter((located) => located.markerLine === match.markerLine).length > 1;
  const drop = new Set([match.line, sharedMarker ? -1 : match.markerLine].filter((line) => line >= 0));
  for (let i = match.line; i <= (match.endLine ?? match.line); i++) drop.add(i);

  const lines = content.split(/\r?\n/);

  for (let next = (match.endLine ?? match.line) + 1; next < lines.length; next += 1) {
    const line = lines[next];
    if (!/^[ \t]+\S/.test(line) || line.trim().startsWith("<!--")) break;
    drop.add(next);
  }

  let out = "";
  let start = 0;
  let line = 0;
  const eol = /\r?\n/g;
  for (let found = eol.exec(content); found; found = eol.exec(content)) {
    const end = found.index + found[0].length;
    if (!drop.has(line)) out += content.slice(start, end);
    start = end;
    line += 1;
  }
  if (!drop.has(line)) out += content.slice(start);
  return out;
}

const SHIPPED_SKILL_SOURCES = new Set([
  "openclaw-bundled",
  "openclaw-custodian",
  "openclaw-extra",
]);

function isShippedSkill(row     )          {
  if (row.bundled === true) return true;
  const source = clean(row.source).toLowerCase();
  return SHIPPED_SKILL_SOURCES.has(source) || source.includes("plugin");
}

function shownSkillId(row     )         {
  if (!row || typeof row !== "object" || isShippedSkill(row)) return "";
  if (row.disabled === true || row.blockedByAgentFilter === true) return "";
  const name = clean(row.name);
  if (!name) return "";
  return `skill:${clean(row.skillKey) || name}`;
}

function skillBy(row     )         {
  const source = clean(row.source).toLowerCase();
  if (source === "openclaw-workshop") return "agent";
  if (row.clawhub || source === "openclaw-managed") return "installed";
  if (source === "openclaw-workspace" || source.startsWith("agents-skills-")) return "user";
  return "";
}

function contentWords(text        )              {
  const words = new Set        ();
  for (const raw of text.toLowerCase().match(/\p{L}+/gu) || []) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    const word = raw.length >= 5 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (!STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

function capMemories(memories                       , budget        )                        {
  if (memories.length <= budget) return memories;
  const index = new Map                             (
    memories.map((m, i)                                => [m, i]),
  );
  const kept = new Set(
    memories
      .slice()
      .sort(
        (a, b) =>
          b.uses - a.uses ||
          b.importance - a.importance ||
          (b.createdAtMs ?? -1) - (a.createdAtMs ?? -1) ||
          (index.get(a) ?? 0) - (index.get(b) ?? 0),
      )
      .slice(0, Math.max(0, budget)),
  );
  return memories.filter((m) => kept.has(m));
}

function composeOpenClawStarMap(input

 ) {
  const rows        = Array.isArray(input.skills) ? input.skills : [];
  const workshop        = Array.isArray(input.workshopSkills) ? input.workshopSkills : [];
  const createdAt = input.createdAtMsByFile || {};
  const useCounts = new Map                ();
  for (const entry of workshop) {
    const name = clean(entry && entry.name).toLowerCase();
    const uses = entry && entry.useCount;
    if (name && typeof uses === "number" && Number.isFinite(uses) && uses >= 0) {
      useCounts.set(name, Math.floor(uses));
    }
  }

  const skills                   = [];
  const seenSkills = new Set        ();
  for (const row of rows) {
    const id = shownSkillId(row);
    if (!id) continue;
    const name = clean(row.name);
    if (seenSkills.has(id.toLowerCase())) continue;
    seenSkills.add(id.toLowerCase());
    const filePath = clean(row.filePath);
    const created = filePath ? createdAt[filePath] : null;
    const description = clean(row.description);
    skills.push({
      node: {
        id,
        kind: "skill",
        group: "Skills",
        name: clipStarMapText(name, STAR_MAP_LIMITS.nameChars),
        text: "",
        description: clipStarMapText(description, STAR_MAP_LIMITS.descriptionChars),
        createdAtMs: typeof created === "number" && created > 0 ? Math.floor(created) : null,
        uses: useCounts.get(name.toLowerCase()) ?? 0,
        by: skillBy(row),
        stale: false,
        pinned: false,
        importance: 0,
        source: "",
      },
      words: contentWords(`${name.replace(/[-_]+/g, " ")} ${description}`),
    });
    if (skills.length >= STAR_MAP_LIMITS.maxNodes) break;
  }

  const memories = capMemories(
    Array.isArray(input.memories) ? input.memories : [],
    STAR_MAP_LIMITS.maxNodes - skills.length,
  );

  const links                = [];
  const groupVotes = new Map                                     ();
  for (const memory of memories) {
    if (!skills.length) break;
    const words = contentWords(`${memory.text} ${memory.tags.join(" ")}`);
    if (!words.size) continue;
    const scored                                                                 = [];
    skills.forEach((skill, order) => {
      let score = 0;
      for (const word of skill.words) if (words.has(word)) score += 1;
      if (score > 0) scored.push({ skill, score, order });
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    for (const { skill } of scored.slice(0, 2)) {
      links.push({ a: memory.id, b: skill.node.id });
      const votes = groupVotes.get(skill) || new Map                ();
      votes.set(memory.group, (votes.get(memory.group) || 0) + 1);
      groupVotes.set(skill, votes);
    }
  }
  for (const [skill, votes] of groupVotes) {
    let best = "";
    let bestCount = 0;
    for (const [group, count] of votes) {
      if (count > bestCount) {
        best = group;
        bestCount = count;
      }
    }
    if (best) skill.node.group = best;
  }

  const graph = normalizeStarMapGraph({
    nodes: [...skills.map((skill) => skill.node), ...memories],
    links,
  });
  return { backend: "openclaw"         , nodes: graph.nodes, links: graph.links };
}

async function skillFileCreatedAtMs(filePath        )                         {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.birthtimeMs > 0) return Math.floor(stat.birthtimeMs);
    if (stat.mtimeMs > 0) return Math.floor(stat.mtimeMs);
    return null;
  } catch {
    return null;
  }
}

function isRefusal(err     )          {
  if (isStarMapMethodNotFound(err)) return true;
  const text = err && typeof err.message === "string" ? err.message.toLowerCase() : "";
  return /forbidden|missing scope|not allowed|unauthori[sz]ed|permission denied/.test(text);
}

function createOpenclawStarMapReader(deps

 ) {
  const request = (method        , params        ) =>
    Promise.resolve().then(() => deps.request(method, params));

  async function readSkillsStatus(agentId        , scoped         ) {
    if (!scoped) return request("skills.status", {});
    try {
      return await request("skills.status", { agentId });
    } catch (err) {

      if (isStarMapMethodNotFound(err)) throw err;
      return request("skills.status", {});
    }
  }

  async function graph(params     ) {
    const requested = clean(params && params.agentId);
    const agentId = requested || "main";
    const scoped = agentId.toLowerCase() !== "main";
    const [skillsRead, memoryRead, workshopRead, profileRead, wikiRead] = await Promise.allSettled([
      readSkillsStatus(agentId, scoped),
      request("agents.files.get", { agentId, name: "MEMORY.md" }),
      request("skills.workshop.list", scoped ? { agentId } : {}),
      request("agents.files.get", { agentId, name: "USER.md" }),
      readOpenClawWiki(request, agentId),
    ]);
    if (skillsRead.status === "rejected" && memoryRead.status === "rejected" && profileRead.status === "rejected" && wikiRead.status === "rejected") {
      for (const read of [skillsRead, memoryRead, profileRead, wikiRead]) {
        if (!isRefusal(read.reason)) throw read.reason;
      }
      throw createStarMapUnsupportedError("openclaw gateway refused Journey source reads");
    }
    const skillRows        =
      skillsRead.status === "fulfilled" && skillsRead.value && Array.isArray(skillsRead.value.skills)
        ? skillsRead.value.skills
        : [];
    const file      =
      memoryRead.status === "fulfilled" && memoryRead.value ? memoryRead.value.file : null;
    const memoryText = file && file.missing !== true && typeof file.content === "string" ? file.content : "";
    const profileFile = profileRead.status === "fulfilled" ? profileRead.value?.file : null;
    const profileText = profileFile && profileFile.missing !== true && typeof profileFile.content === "string" ? profileFile.content : "";
    const wiki = wikiRead.status === "fulfilled" ? wikiRead.value : null;
    const seenFacts = new Set(wiki?.facts || []);
    const memories = [...parseOpenClawWorkspaceLines(profileText, "USER.md"), ...parseOpenClawWorkspaceLines(memoryText)]
      .map((located) => located.entry).filter((entry) => {
        const key = wikiFactKey(entry.text);
        if (seenFacts.has(key)) return false;
        seenFacts.add(key);
        return true;
      });
    const workshopSkills =
      workshopRead.status === "fulfilled" && workshopRead.value && Array.isArray(workshopRead.value.skills)
        ? workshopRead.value.skills
        : [];

    const createdAtMsByFile                                = {};
    const files = new Set        ();
    for (const row of skillRows) {
      if (!row || typeof row !== "object" || isShippedSkill(row)) continue;
      const filePath = clean(row.filePath);
      if (filePath && files.size < STAR_MAP_LIMITS.maxNodes) files.add(filePath);
    }
    await Promise.all(
      [...files].map(async (filePath) => {
        createdAtMsByFile[filePath] = await skillFileCreatedAtMs(filePath);
      }),
    );

    const fallback = composeOpenClawStarMap({
      skills: skillRows,
      workshopSkills,
      memories,
      createdAtMsByFile,
    });
    if (!fallback.nodes.length && !wiki?.nodes.length) {
      for (const read of [memoryRead, profileRead, wikiRead, skillsRead]) {
        if (read.status === "rejected" && !isRefusal(read.reason)) throw read.reason;
      }
    }

    const wikiNodes = wiki?.nodes || [];
    return { backend: "openclaw"         , ...normalizeStarMapGraph({
      nodes: [...wikiNodes, ...fallback.nodes.slice(0, STAR_MAP_LIMITS.maxNodes - wikiNodes.length)],
      links: wikiNodes.length ? wiki .links : fallback.links,
    }) };
  }

  async function forgetCall(method        , params        ) {
    try {
      return await request(method, params);
    } catch (err) {
      if (isRefusal(err)) throw createStarMapUnsupportedError(`openclaw gateway refused ${method}`);
      throw err;
    }
  }

  async function readMemoryMd(agentId        , name        )                         {
    const read      = await forgetCall("agents.files.get", { agentId, name });
    const file = read && read.file;
    if (!file || file.missing === true || typeof file.content !== "string") return null;
    return file.content;
  }

  async function forgetSkill(agentId        , id        ) {
    const scoped = agentId.toLowerCase() !== "main";
    let status     ;
    try {
      status = await readSkillsStatus(agentId, scoped);
    } catch (err) {
      if (isRefusal(err)) throw createStarMapUnsupportedError("openclaw gateway refused skills.status");
      throw err;
    }
    const rows        = status && Array.isArray(status.skills) ? status.skills : [];
    const seen = new Set        ();
    let match      = null;
    for (const row of rows) {
      const rowId = shownSkillId(row);
      if (!rowId || seen.has(rowId.toLowerCase())) continue;
      seen.add(rowId.toLowerCase());
      if (rowId === id) {
        match = row;
        break;
      }
    }
    if (!match) throw createStarMapForgetError("stale");
    const skillKey = clean(match.skillKey) || clean(match.name);
    await forgetCall("skills.update", { skillKey, enabled: false });
    return { action: "turned_off"          };
  }

  async function forgetMemory(agentId        , id        , text        ) {
    if (id.startsWith("wiki:")) throw createStarMapForgetError("protected", "Compiled wiki pages must be managed in Memory Wiki.");
    const name = id.startsWith("profile:") ? "USER.md" : "MEMORY.md";
    let content = await readMemoryMd(agentId, name);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (content === null) throw createStarMapForgetError("stale");
      const next = removeOpenClawMemoryEntry(content, id, text, name);
      const again = await readMemoryMd(agentId, name);
      if (again === content) {
        await forgetCall("agents.files.set", { agentId, name, content: next });
        return { action: "removed"          };
      }
      content = again;
    }
    throw createStarMapForgetError("busy", "Memory kept changing. Try again.");
  }

  async function forget(params     ) {
    const parsed = parseStarMapForgetParams(params);
    if (!parsed) throw createStarMapForgetError("bad_request");
    const agentId = parsed.agentId || "main";
    return parsed.kind === "skill"
      ? forgetSkill(agentId, parsed.id)
      : forgetMemory(agentId, parsed.id, parsed.text);
  }

  return { graph, forget };
}

module.exports = { parseOpenClawMemoryMd, parseOpenClawMemoryMdLines, parseOpenClawWorkspaceLines, removeOpenClawMemoryEntry, composeOpenClawStarMap, createOpenclawStarMapReader };
