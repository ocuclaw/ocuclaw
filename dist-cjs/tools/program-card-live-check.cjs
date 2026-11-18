const { cardHealthReasonWords, PROGRAM_CARD_FEED_REWRITE } = require("./program-card-health.cjs");

const OWN_REASONS                                                 = {

  address_failed: { cause: "its address did not answer", fix: "check the address with your own tools and correct the feed's url" },
  http_status: { cause: "its address answered with an error status", fix: "check the address with your own tools and correct the feed's url" },
  timed_out: { cause: "its address did not answer in time", fix: "use an address that answers within 8 s" },
  path_empty: { cause: "its address answered, but the feed's path picked nothing", fix: "correct path to where the value sits in the answer" },
  no_value: { cause: "its address answered with nothing", fix: "use an address that returns the value as JSON" },
  too_big: { cause: "its value is over the size limit", fix: "pick less with path" },
  blocked: { cause: "this host does not allow that address", fix: "use a public https address" },
  redirected: { cause: "its address redirects to another site, which this card may not read", fix: "fetch it with your own tools to find where it redirects, and use that final address" },
  refused: { cause: "this host refused the feed as declared", fix: "correct the feed's url and every" },
  bad_feed: { cause: "its declaration was refused (name, kind, url, path or every)", fix: "declare it as LIVE DATA in write_glasses_card says" },
  site_waiting: { cause: "the wearer has not allowed its site yet", fix: "tell the wearer the card waits for their Allow on the glasses" },
  sites_off: { cause: "sites are off in LiveUI Settings", fix: "tell the wearer; only they can turn sites on" },
  site_off_for_card: { cause: "the wearer switched its site off for this card", fix: "tell the wearer; only they can switch it back on" },
  host_off: { cause: "live data is off on this host", fix: "tell the wearer; only the host's owner can turn it on" },
  host_not_allowed: { cause: "this host's site list does not include its site", fix: "tell the wearer; only the host's owner can add the site" },
  paused: { cause: "LiveUI refresh is paused", fix: "tell the wearer; live data returns when refresh resumes" },
  not_run: { cause: "it had not run by the end of the Test", fix: "tell the wearer its live data was not seen yet" },

  unavailable: { cause: "this host cannot run it now", fix: "tell the wearer it could not be checked" },
  invalid: { cause: "this host refused the block as declared", fix: "correct the block as write_glasses_card describes" },

  not_called: { cause: "the open card made no call to it", fix: "tell the wearer its data was not seen yet" },
  call_refused: { cause: "this host did not run the call", fix: "tell the wearer it could not be checked" },
};
const UNKNOWN_REASON = { cause: "it could not be checked", fix: "tell the wearer it could not be checked" };

function liveReasonWords(kind              , reason        , httpStatus         )         {
  const shared = kind === "feed" ? "" : cardHealthReasonWords(kind, reason);
  if (shared) return `${reason}. ${shared}`;
  if (!Object.hasOwn(OWN_REASONS, reason)) return "";
  const own = OWN_REASONS[reason];
  return `${reason === "http_status" && httpStatus ? `its address answered status ${httpStatus}` : own.cause}; ${own.fix}.`;
}

const STOP = new Set(["card", "cards", "data", "live", "feed", "feeds", "http", "https", "json", "open", "show", "shows", "value", "values",
  "from", "with", "this", "that", "your", "site", "sites", "tool", "tools", "name", "main", "info", "list", "next", "www", "api", "com", "org",
  "net", "app", "the", "and", "for"]);

const stem = (word        ) => word.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(?<=.{4})s$/, "");

const sameWord = (a        , b        ) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.length - short.length <= 3 && long.startsWith(short);
};

function nameWords(text         )           {
  const out = new Set        ();

  const spaced = String(text ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  for (const raw of spaced.split(/[^A-Za-z0-9]+/)) {
    const word = raw.toLowerCase();
    if (word.length < 4 || STOP.has(word) || /^\d+$/.test(word)) continue;
    out.add(stem(word));
  }
  return [...out];
}

const FEED_STATUSES = new Set(["ok", "waiting", "failed", "unchecked"]);

function liveFeedParts(rows         )             {
  if (!Array.isArray(rows)) return [];
  const parts             = [];
  for (const row of rows) {
    if (!row || typeof row.name !== "string" || (row.kind !== "http" && row.reason !== "bad_feed")) continue;
    const status                 = FEED_STATUSES.has(row.status) ? row.status : "unchecked";

    const labels = typeof row.host === "string" ? row.host.split(".").slice(0, -1) : [];
    parts.push({ kind: "feed", name: row.name.slice(0, 24), status, reason: typeof row.reason === "string" ? row.reason : "not_run",
      words: [...new Set([...nameWords(row.name), ...labels.flatMap(nameWords)])],
      ...(Number.isInteger(row.httpStatus) ? { httpStatus: row.httpStatus } : {}) });
  }
  return parts;
}

const ANSWER_STATE                                                             = {
  allowed: { status: "ok", reason: "allowed" },
  no_answer: { status: "waiting", reason: "waiting" },
  waiting: { status: "waiting", reason: "waiting" },
  declined: { status: "unchecked", reason: "declined" },
  off: { status: "unchecked", reason: "switch_off" },
  unavailable: { status: "unchecked", reason: "unavailable" },
  invalid: { status: "failed", reason: "invalid" },
};

function liveUseParts(kind                         , uses         , answer         )             {
  if (!Array.isArray(uses)) return [];
  const answered = ANSWER_STATE[typeof answer === "string" ? answer : ""] ?? { status: "unchecked"                  , reason: "unavailable" };

  const state = kind === "mcp" && answered.reason === "declined" ? { ...answered, reason: "kept_off" } : answered;
  const parts             = [];
  for (const use of uses.slice(0, 8)) {
    if (!use || typeof use !== "object" || typeof use.name !== "string" || !use.name || use.kind === "write") continue;
    parts.push({ kind, name: use.name.slice(0, 40), ...state,
      words: [...new Set([...nameWords(use.name), ...nameWords(use.title), ...(kind === "mcp" ? [...nameWords(use.server), ...nameWords(use.tool)] : [])])] });
  }
  return parts;
}

const MCP_CALL_STATE                                                             = {
  ok: { status: "ok", reason: "answered" },
  failed: { status: "failed", reason: "call_failed" },
  too_big: { status: "failed", reason: "call_too_big" },
  timeout: { status: "unchecked", reason: "call_timeout" },
};

function liveMcpCalled(parts            , calls         , sinceMs = 0)             {
  const rows = Array.isArray(calls) ? calls : [];
  return parts.map((part) => {
    if (part.kind !== "mcp" || part.status !== "ok") return part;
    const call = rows.find((row     ) => row && row.mcp === part.name && Number.isFinite(row.atMs) && row.atMs >= sinceMs);
    if (!call) return { ...part, status: "unchecked", reason: "not_called" };
    return { ...part, ...(MCP_CALL_STATE[String(call.outcome)] ?? { status: "unchecked"                  , reason: "call_refused" }) };
  });
}

const VAGUE_REASONS = new Set(["switch_off", "unavailable", "not_called", "call_refused"]);

const CARD_FAULTS = new Set(["invalid", "server_missing", "tool_missing", "unfit"]);

function liveHealthRefined(parts            , health         )             {
  const rows = Array.isArray(health) ? health.filter((row     ) => row && typeof row.reason === "string" && !row.reason.startsWith("call_")) : [];
  if (!rows.length) return parts;
  return parts.map((part) => {
    if (part.kind === "feed" || part.status !== "unchecked" || !VAGUE_REASONS.has(part.reason)) return part;
    const row = rows.find((r     ) => r.part === part.kind && r.use === part.name) ?? rows.find((r     ) => r.part === part.kind && r.use === "");
    if (!row || !cardHealthReasonWords(part.kind, row.reason)) return part;
    return { ...part, reason: row.reason, ...(CARD_FAULTS.has(row.reason) ? { status: "failed"                   } : {}) };
  });
}

const KIND_WORDS                               = {
  feed: /\b(?:feeds?|live|urls?|apis?|json|fetch\w*|real[- ]?time|internet|(?:keeps?|stays?|kept) (?:it |them )?fresh|auto\w*[- ]?(?:refresh|updat)\w*)\b/i,
  mcp: /\bmcp\b/i,
  jev: /\b(?:jev|classif\w*)\b/i,
  model: /\b(?:ai|llm)\b|\b(?:the|an?|by|from|with|using|ask\w*) models?\b(?! (?:of|number|name|year|from)\b)/i,
};

function liveLineParts(line        , parts            )             {
  const text = String(line || "");
  const words = nameWords(text);
  const named = parts.filter((part) => part.words.some((word) => words.some((own) => sameWord(word, own))));
  const kinds = new Set(named.map((part) => part.kind));
  const general = parts.filter((part) => !kinds.has(part.kind) && KIND_WORDS[part.kind].test(text));
  return [...named, ...general];
}

const WORST                   = ["failed", "waiting", "unchecked"];

function liveHolds(lines          , parts            )             {
  const holds             = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const bad = liveLineParts(line, parts).filter((part) => part.status !== "ok");
    if (!bad.length) continue;
    const status = WORST.find((s) => bad.some((part) => part.status === s))                      ;
    holds.push({ line, status, parts: bad.filter((part) => part.status === status) });
  }
  return holds;
}

function liveGate(lines          , verdicts               , parts            , failedBefore              = new Set(),
  firstStep                = null, passedBefore                      = new Set())                                                 {
  if (!parts.length) return { verdicts, holds: [] };
  const holds = liveHolds(lines, parts);
  const held = new Map(holds.map((hold) => [hold.line, hold]));
  const out                = [];
  const judged = new Set        ();
  for (const verdict of verdicts) {
    const hold = held.get(verdict.requirement);
    judged.add(verdict.requirement);
    if (!hold) out.push(verdict);
    else if (hold.status === "failed") out.push({ ...verdict, outcome: "failed" });
    else if (hold.status === "waiting" && verdict.outcome !== "failed") out.push({ ...verdict, outcome: "wearer_check" });
    else if (verdict.outcome === "failed") out.push(verdict);

  }

  for (const hold of holds) {
    if (judged.has(hold.line)) continue;
    if (hold.status === "waiting") out.push({ requirement: hold.line, step: -1, outcome: "wearer_check" });
    else if (hold.status === "failed" && passedBefore.has(hold.line)) out.push({ requirement: hold.line, step: -1, outcome: "failed" });
  }
  if (firstStep !== null) {
    for (const line of failedBefore) {
      if (held.has(line) || judged.has(line) || !lines.includes(line) || !liveLineParts(line, parts).length) continue;
      out.push({ requirement: line, step: firstStep, outcome: "passed" });
    }
  }
  return { verdicts: out, holds };
}

function liveOnlyFailed(before             , stepVerdicts               , gate                                                ,
  passedBefore                      = new Set())              {
  const stepFailed = new Set(stepVerdicts.filter((v) => v.outcome === "failed").map((v) => v.requirement));
  const stepPassed = new Set(stepVerdicts.filter((v) => v.outcome === "passed").map((v) => v.requirement));
  const passedNow = new Set(gate.verdicts.filter((v) => v.outcome === "passed").map((v) => v.requirement));
  const out = new Set        ();
  for (const line of before) if (!stepFailed.has(line) && !passedNow.has(line)) out.add(line);

  for (const hold of gate.holds) {
    if (hold.status === "failed" && (stepPassed.has(hold.line) || passedBefore.has(hold.line)) && !stepFailed.has(hold.line)) out.add(hold.line);
  }
  return out;
}

const KIND_NAME                               = { feed: "feed", mcp: "MCP use", jev: "Jev question", model: "model use" };

function partLine(part          ) {
  const words = liveReasonWords(part.kind, part.reason, part.httpStatus) || `${UNKNOWN_REASON.cause}; ${UNKNOWN_REASON.fix}.`;
  return `${KIND_NAME[part.kind]} ${JSON.stringify(part.name)}: ${words}`;
}

function liveCheckNext(parts            , holds            , done         , unshown                      = new Set(),
  change = false)         {
  const of = (status                ) => parts.filter((part) => part.status === status);
  const held = (status                    ) => holds.filter((hold) => hold.status === status);
  const quoted = (list            ) => list.map((hold) => JSON.stringify(hold.line)).join(", ");
  const lines = (status                    ) => quoted(held(status));
  const many = (status                    ) => held(status).length > 1;
  const out           = [];
  const failed = of("failed");
  if (failed.length) {

    const fails = held("failed").filter((hold) => !unshown.has(hold.line));
    const toShow = held("failed").filter((hold) => unshown.has(hold.line));

    const feed = failed.some((part) => part.kind === "feed");
    const feedFix = !feed ? "Fix it in the same edit as any other problem; the build is not done until it arrives."
      : change ? "An edit keeps the card's feeds, so this change cannot correct a feed's address, and it stays unsaved while one fails: fix any other problem in the same edit. If the feed's next fetch does not mend it, say so in your reply and offer the wearer a new card with a working feed."
      : `An edit keeps the card's feeds, so to correct a feed's address ${PROGRAM_CARD_FEED_REWRITE}, with every other fix in that one write. That write needs the wearer's yes again: first call ask_glasses_card with one line on what the fix changes, listing any new site in its sites. The build is not done until the feed arrives.`;
    out.push(`Live check, on the open card and not the Test's copy: ${failed.map(partLine).join(" ")}${fails.length ? ` That fails ${quoted(fails)}.` : ""} ${feedFix}${toShow.length && !(feed && change) ? ` No step has shown ${quoted(toShow)} yet: in the Test after your fix, give ${toShow.length > 1 ? "each" : "it"} a step with proves, instead of a Test with no steps.` : ""}`);
  }
  const waiting = of("waiting");
  if (waiting.length) {
    out.push(`Live check: waiting on the wearer's OK: ${waiting.map(partLine).join(" ")}${lines("waiting") ? ` ${lines("waiting")} ${many("waiting") ? "show" : "shows"} as theirs to check.` : ""} Do not Test for it, and do not edit the card only to ask them again${done ? "; say in your reply what waits on their tap" : ""}.`);
  }
  const unchecked = of("unchecked");
  if (unchecked.length) {
    out.push(`Live check: could not check: ${unchecked.map(partLine).join(" ")}${lines("unchecked") ? ` ${lines("unchecked")} ${many("unchecked") ? "stay" : "stays"} not tested: no Test can show ${many("unchecked") ? "them" : "it"}, so do not Test for ${many("unchecked") ? "them" : "it"}.` : ""}${done ? " Say so in your reply." : ""}`);
  }
  return out.join(" ");
}

function liveCheckForAgent(parts            , holds            ) {
  return {
    parts: parts.map((part) => ({ kind: part.kind, name: part.name, status: part.status, reason: part.reason,
      ...(part.httpStatus ? { httpStatus: part.httpStatus } : {}) })),
    ...(holds.length ? { lines: holds.map((hold) => ({ line: hold.line, status: hold.status })) } : {}),
  };
}

function liveCheckDebug(parts            , holds            ) {
  const count = (status                ) => parts.filter((part) => part.status === status).length;
  const kinds                         = {};
  for (const part of parts) kinds[part.kind] = (kinds[part.kind] ?? 0) + 1;
  return { parts: parts.length, kinds, ok: count("ok"), waiting: count("waiting"), failed: count("failed"), unchecked: count("unchecked"),
    reasons: [...new Set(parts.filter((part) => part.status !== "ok").map((part) => part.reason))].slice(0, 8),
    held: { failed: holds.filter((h) => h.status === "failed").length, waiting: holds.filter((h) => h.status === "waiting").length,
      unchecked: holds.filter((h) => h.status === "unchecked").length } };
}

module.exports = { liveReasonWords, liveFeedParts, liveUseParts, liveMcpCalled, liveHealthRefined, liveLineParts, liveHolds, liveGate, liveOnlyFailed, liveCheckNext, liveCheckForAgent, liveCheckDebug };
