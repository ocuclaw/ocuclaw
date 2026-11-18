const { TASK_FAILURE_REASONS, TASK_RUN_STATES, TASK_SERVICE_NAMES, TASK_SKIP_WHYS, TASK_SYNC_ERRORS } = require("../domain/task-run-facts.cjs");
const { LIVEUI_TASK_RUN_END_REASONS } = require("./glasses-ui-task-run.cjs");
const { LIVEUI_TASK_RUN_RECORD_BY } = require("./glasses-ui-task-run-records.cjs");

const ACCESS = "Tool & service access on the phone's LiveUI page";
const NO_ASK = "Do not ask for it again unless they say they want it back.";

const TABLE                                                               = {
  mcp: {
    switch_off: { what: "MCP in cards is switched off on this host.", who: "wearer", fix: `They turn on MCP in cards (${ACCESS}).` },
    host_unsupported: { what: "This host cannot use MCP tools in cards.", who: "none", fix: "Offer a version of the card without the tool." },
    tools_unlisted: { what: "The host could not list its MCP servers, or has none set up.", who: "owner", fix: "Check the host's MCP setup; your own MCP tools show whether the servers answer." },
    invalid: { what: "The host refused the card's mcp block as malformed.", who: "agent", fix: "Correct the block with edit_glasses_card; the edit's answer names what is wrong." },
    removed: { what: "The wearer removed this card's MCP access on the phone.", who: "wearer", fix: `Closing and opening the card asks them again. ${NO_ASK}` },
    server_off_for_cards: { what: "This server is not turned on for cards.", who: "wearer", fix: `They turn on Use in cards for the server (${ACCESS}, under MCP servers).` },
    server_missing: { what: "This host has no MCP server by that name.", who: "agent", fix: "Change the card to a tool this turn lists, or tell the wearer the server is not set up on the host." },
    host_not_granted: { what: "The host's own grant for this server is missing.", who: "wearer", fix: `They switch Use in cards for the server off and on again (${ACCESS}, under MCP servers), which writes the grant.` },
    host_blocked: { what: "The host hides or blocks this server's tools until its owner trusts them.", who: "owner", fix: "The owner trusts the server's tools on the host." },
    server_not_connected: { what: "This server is not connected on the host.", who: "owner", fix: "Reconnect it on the host (its sign-in may have expired); your own MCP tools show when it answers again." },
    tool_missing: { what: "The server no longer has the tool this use names.", who: "agent", fix: "Change the card to a tool this turn lists." },
    kept_off: { what: "The wearer said no to this tool for this card (Not now or Keep it off), and a no lasts.", who: "wearer", fix: `Never ask again by yourself. Only they can undo it (${ACCESS}); otherwise offer a version without the tool.` },
    tool_changed: { what: "The tool changed since the wearer allowed it, so it needs their OK again.", who: "wearer", fix: `They allow it on the glasses request, or for a saved card in ${ACCESS}.` },
    waiting: { what: "The wearer has not allowed this read yet.", who: "wearer", fix: `They tap Allow on the glasses request (a tap on an unsaved card asks again), or for a saved card in ${ACCESS}.` },
    unfit: { what: "The tool does not fit this use as a read: its arguments or its read-only mark changed, or the owner marked it as a write. No Allow can mend that.", who: "agent", fix: "Correct the use with edit_glasses_card; the edit's answer names the mismatch." },
    paused_slow: { what: "The host paused this use after 2 slow answers in a row (over 2 s each), and it stays paused.", who: "wearer", fix: "They close and open the card, which starts it again; the server is slow." },
    call_limit: { what: "The host refused its last call at a limit (10 a minute for a card, the host's daily count, or too many calls waiting).", who: "agent", fix: "Wait a minute, or raise the use's `every` so the card reads less often." },
    call_busy: { what: "The host was busy on its last call.", who: "wait", fix: "The card's next read tries again." },
    call_timeout: { what: "Its last call ran out of time (10 s).", who: "wait", fix: "The card's next read tries again; if it repeats, the server is slow or down." },
    call_failed: { what: "The tool answered with an error on its last call.", who: "agent", fix: "Call the same tool yourself with the same arguments to see the error, then correct the use." },
    call_too_big: { what: "The tool's answer was too big for a card on its last call.", who: "agent", fix: "Narrow the use's `pick` or its arguments so it returns less." },
  },
  jev: {
    switch_off: { what: "Jev in cards is switched off on this host.", who: "wearer", fix: `They turn on Jev in cards (${ACCESS}).` },
    no_key: { what: "The host has no TypeSafe key saved.", who: "wearer", fix: `They add one on the phone (the Jev in cards row in ${ACCESS} opens it). Never ask for the key in chat.` },
    invalid: { what: "The host refused the card's jev block as malformed.", who: "agent", fix: "Correct the block with edit_glasses_card; the edit's answer names what is wrong." },
    removed: { what: "The wearer removed this card's Jev access on the phone.", who: "wearer", fix: `Closing and opening the card asks them again. ${NO_ASK}` },
    waiting: { what: "The wearer has not answered the request to let this card ask Jev.", who: "wearer", fix: `They tap Allow on the glasses request or in ${ACCESS}; an edit of the card asks again.` },
    declined: { what: "The wearer said no to Jev for this card (Not now or Keep it off), and a no lasts.", who: "wearer", fix: `Never ask again by yourself. Only they can undo it (${ACCESS}); otherwise offer a version without Jev.` },
    key_rejected: { what: "TypeSafe rejected the host's key on the last ask.", who: "wearer", fix: `They save a working key on the phone (the Jev in cards row in ${ACCESS} opens it). Never ask for the key in chat.` },
    unreachable: { what: "The host could not reach TypeSafe on the last ask.", who: "wait", fix: "The next ask tries again; if it repeats, the host's network is the place to look." },
    call_limit: { what: "The host refused the last ask at a limit (20 a minute for a card, the host's daily count, or too many asks waiting).", who: "agent", fix: "Wait a minute, or change the card to ask Jev less often." },
    call_busy: { what: "TypeSafe answered too many requests on the last ask, so asks pause for a short while.", who: "wait", fix: "It starts again by itself." },
    call_timeout: { what: "The last ask ran out of time.", who: "wait", fix: "The next ask tries again." },
    call_failed: { what: "The last ask failed at TypeSafe.", who: "wait", fix: "The next ask tries again; if it repeats, tell the wearer Jev is failing for this card." },
    call_misfit: { what: "Jev's last answer did not fit the use (a choice it does not declare, or a number out of range), so the card got a failure.", who: "agent", fix: "The next ask tries again; if it repeats, make the use's choices or scale simpler with edit_glasses_card." },
  },
  model: {
    switch_off: { what: "Models in cards is switched off on this host.", who: "wearer", fix: `They turn on Models in cards (${ACCESS}).` },
    no_host: { what: "This host cannot run model calls for cards.", who: "none", fix: "Offer a version of the card without the model use." },
    library_in_use: { what: "Another gateway on this computer is using Models for this card Library, so this one cannot.", who: "owner", fix: "Turn Models in cards off in the other gateway, then off and on here." },
    unsupported_runtime: { what: "The gateway's Node is too old for Models in cards.", who: "owner", fix: "Run the gateway on Node 22.13 or newer." },
    storage_unavailable: { what: "The host could not safely open the card Library's storage for Models.", who: "owner", fix: "Check the Library folder's storage access on the host." },
    unavailable: { what: "Model calls are not available on this host now, and it did not say why.", who: "wearer", fix: `They switch Models in cards off and on (${ACCESS}); if it stays, the gateway's log has the cause.` },
    card_deleted: { what: "This card was deleted from the Library, and its model access went with it.", who: "agent", fix: "Write the card again if the wearer wants it." },
    removed: { what: "The wearer removed this card's model access on the phone.", who: "wearer", fix: `Closing and opening the card asks them again. ${NO_ASK}` },
    cards_full: { what: "The host already keeps model access for 128 cards, its limit, so it did not ask the wearer about this one.", who: "wearer", fix: `They remove model access from a card they no longer use (${ACCESS}); writing this card again then asks them.` },
    waiting: { what: "The wearer has not answered the request to let this card use a model.", who: "wearer", fix: `They tap Allow on the glasses request or in ${ACCESS}; an edit of the card asks again.` },
    declined: { what: "The wearer said Not now to this card's model use, and a no lasts.", who: "wearer", fix: `Never ask again by yourself. Only they can allow it (${ACCESS}); otherwise offer a version without it.` },
    model_changed: { what: "The host ran a different model than the one this use was allowed with, so the use is paused.", who: "wearer", fix: `They tap Resume on the card's "Paused: model changed" row (${ACCESS}, or a saved card's Model page), after choosing another model there if they want one. Choosing a model alone does not resume it.` },
    call_limit: { what: "Its last call hit a limit (6 a minute or 200 a day for a card, 1000 a day for the host, the wearer's own daily cap, or a fifth thread for one use).", who: "agent", fix: "Wait, or change the card to call the model less often and to reuse its threads (4 for a use)." },
    call_busy: { what: "Too many of this card's calls were waiting at once (4).", who: "agent", fix: "Change the card so it does not ask again while an answer is on its way." },
    call_timeout: { what: "Its last call ran out of time (60 s).", who: "wait", fix: "The next call tries again; shorter instructions or a faster model help." },
    call_failed: { what: "Its last call failed at the host's model provider.", who: "wait", fix: "The next call tries again; if it repeats, the provider or its sign-in on the host is the place to look." },
    call_invalid_output: { what: "The model's reply did not fit the use's output schema, twice in a row.", who: "agent", fix: "Make the use's output schema or instructions simpler with edit_glasses_card." },
    call_too_big: { what: "The model's reply was too big for a card.", who: "agent", fix: "Change the use's instructions to ask for less." },
    call_unavailable: { what: "The chosen model could not be reached on its last call.", who: "wearer", fix: `They can choose another model for this card (${ACCESS}, or a saved card's Model page).` },
  },
};
for (const rows of Object.values(TABLE)) {
  for (const row of Object.values(rows)) Object.freeze(row);
  Object.freeze(rows);
}

const PROGRAM_CARD_FEED_REWRITE = "write the card again with write_glasses_card";

const FEED_REWRITE = "an edit keeps a card's feeds, so offer the wearer a new card with it corrected (write_glasses_card, after their yes)";
const FEED                                   = {
  bad_feed: { what: "The host refused the feed as declared: its name, kind, url, path or every.", who: "agent", fix: `Correct the feed: ${FEED_REWRITE}; LIVE DATA in write_glasses_card's description gives the shape.` },
  refused: { what: "The host refused the feed's address as declared.", who: "agent", fix: `Correct the feed's url to a whole address that starts with https://: ${FEED_REWRITE}.` },
  blocked: { what: "This host does not allow the feed's address.", who: "agent", fix: `Use a public address that does not redirect to another site: ${FEED_REWRITE}.` },
  redirected: { what: "The feed's address redirects to another site, which this card is not allowed to read.", who: "agent", fix: `Fetch the address with your own tools to find where it redirects, and use that final address: ${FEED_REWRITE}. Its site gets its own ask.` },
  address_failed: { what: "The feed's address did not answer.", who: "agent", fix: `Fetch the address with your own tools. If it is wrong, correct the feed's url: ${FEED_REWRITE}. If it answers for you, the feed's next fetch tries again.` },
  http_status: { what: "The feed's address answered with an error status.", who: "agent", fix: `Fetch the address with your own tools to see why, then correct the feed's url: ${FEED_REWRITE}. A 429 means the site is asked too often: raising the feed's \`every\` may help.` },
  timed_out: { what: "The feed's address did not answer within 8 s.", who: "agent", fix: `The feed's next fetch tries again; if it repeats, use an address that answers faster: ${FEED_REWRITE}.` },
  path_empty: { what: "The feed's address answered, but the feed's path picked nothing from the answer.", who: "agent", fix: `Fetch the address with your own tools and correct the feed's \`path\` to where the value sits: ${FEED_REWRITE}.` },
  no_value: { what: "The feed's address answered with nothing a card can read.", who: "agent", fix: `Use an address that returns the value as JSON: ${FEED_REWRITE}.` },
  too_big: { what: "The feed's value is over the size limit for a card.", who: "agent", fix: `Pick less with the feed's \`path\`: ${FEED_REWRITE}.` },
  site_waiting: { what: "The wearer has not allowed the feed's site yet.", who: "wearer", fix: "They tap Allow on the glasses request for the site; if none is showing, closing and opening the card asks again." },
  sites_off: { what: "Sites are off in LiveUI Settings on the phone, so no card fetches a site.", who: "wearer", fix: "Only they can turn sites on there." },
  site_off_for_card: { what: "The wearer switched the feed's site off for this card.", who: "wearer", fix: "Never ask again by yourself. Only they can switch it back on, on the phone; otherwise offer a version without that site." },
  host_off: { what: "Live data is off on this host.", who: "owner", fix: "The owner turns LiveUI's live data on in the host's settings." },
  host_not_allowed: { what: "The feed's site is denied, or is not among the sites this host may fetch.", who: "owner", fix: "If the wearer denied the site in LiveUI Settings on the phone, only they can allow it there. Otherwise the owner adds the site to the host's own list, or use a site that is allowed." },
  paused: { what: "LiveUI is off or its refresh is paused, so no feed runs.", who: "wearer", fix: "They resume it on the phone's LiveUI page; the feed starts again by itself." },
};
for (const row of Object.values(FEED)) Object.freeze(row);

const PROGRAM_CARD_FEED_HEALTH_TABLE                                             = Object.freeze(FEED);

const SEND                                   = {
  no_prompt: { what: "No connected phone can show the send prompt (OcuClaw is not open on it, or its app is older than card sends), so every send of a card answers off.", who: "wearer",
    fix: "They open OcuClaw on the phone and leave it open; if it is open, they update the app." },
  host_cannot_send: { what: "This host cannot run a card's send.", who: "none", fix: "Offer a version of the card without the send." },
  not_granted: { what: "The wearer has not allowed this card to send with this use, or the use changed since they did.", who: "agent",
    fix: "Call request_card_mcp_write with this exact use (the saved card's id, or \"new\"): the wearer answers on the glasses. Never press Allow for them." },
  waiting: { what: "The wearer was asked to let this card send with this use and has not answered.", who: "wearer",
    fix: `They tap Allow on the glasses request, or on the card's send in ${ACCESS}. Do not ask again while it waits.` },
  kept_off: { what: "The wearer said no to sends with this tool for this card, and a no lasts.", who: "wearer",
    fix: `Never ask again by yourself. Only they can undo it (${ACCESS}); otherwise offer a version without the send.` },
  tool_changed: { what: "The tool changed since the wearer allowed this send, so it is paused until they allow it again.", who: "wearer",
    fix: `They allow it again on the card's send in ${ACCESS}.` },
  send_limit: { what: "The card has used up its sends for now (4 a minute and 30 an hour for a card, 100 a day for the host).", who: "wait",
    fix: "The card can send again once the minute, the hour or the day has passed. Never send for the card yourself." },
};
for (const row of Object.values(SEND)) Object.freeze(row);

const PROGRAM_CARD_SEND_HEALTH_TABLE                                             = Object.freeze(SEND);

const LOCATION                                   = {
  location_off: { what: "Location is switched off for cards on the phone, so no card gets it.", who: "wearer",
    fix: "They turn on Location in LiveUI Settings on the phone; the card asks them once when it next opens." },
  not_allowed: { what: "The wearer said no to sharing their location with this card, or switched it off on the card's page.", who: "wearer",
    fix: "Never ask again by yourself. Only they can switch it back on, on the saved card's page on the phone; otherwise offer a version without the location." },
  waiting: { what: "The wearer has not answered the glasses' ask to share their location with this card.", who: "wearer",
    fix: "They tap Allow on the glasses ask; if none is showing, closing and opening the card asks again." },
  no_fix: { what: "The phone could not read a location just now (no fix, or the app may not use the phone's location).", who: "wearer",
    fix: "They check that the Even app may use the phone's location; the card tries again at its next read." },
};
for (const row of Object.values(LOCATION)) Object.freeze(row);

const PROGRAM_CARD_LOCATION_HEALTH_TABLE                                             = Object.freeze(LOCATION);

const OWN_TABLE_PARTS                       = new Set(["feed", "send", "location"]);

function reasonRow(part         , reason         )                               {
  if (typeof reason !== "string") return undefined;
  if (part === "feed") return Object.hasOwn(FEED, reason) ? FEED[reason] : undefined;
  if (part === "send") return Object.hasOwn(SEND, reason) ? SEND[reason] : undefined;
  if (part === "location") return Object.hasOwn(LOCATION, reason) ? LOCATION[reason] : undefined;
  const rows = (TABLE                                                    )[part          ];
  return rows && Object.hasOwn(TABLE, part          ) && Object.hasOwn(rows, reason) ? rows[reason] : undefined;
}

const PROGRAM_CARD_HEALTH_TABLE                                                                                   = Object.freeze(TABLE);

const PROGRAM_CARD_HEALTH_ASKS                                                                                                             = Object.freeze({
  mcp: Object.freeze({ switch_off: "mcp", server_off_for_cards: "server", waiting: "use", tool_changed: "use" }),
  jev: Object.freeze({ switch_off: "jev", waiting: "use" }),
  model: Object.freeze({ switch_off: "model", waiting: "use" }),
});

const ASK_SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function cardHealthAsk(part                    , reason        , server         )         {
  const asks = PROGRAM_CARD_HEALTH_ASKS[part];
  const what = asks && Object.hasOwn(asks, reason) ? asks[reason] : null;
  if (!what) return "";
  if (what !== "server") return `request_card_setup {"what":"${what}"}`;

  return typeof server === "string" && ASK_SERVER.test(server) ? `request_card_setup {"what":"server","server":"${server}"}` : "";
}

const PART_WORDS                                                                              = Object.freeze({ mcp: "MCP use", jev: "Jev question", model: "model use", feed: "Feed", send: "MCP send", location: "Location" });

const PROGRAM_CARD_HEALTH_WHO_WORDS                                            = Object.freeze({
  agent: "you, now",
  wearer: "the wearer, with a tap",
  owner: "the host's owner, on the host computer",
  wait: "nobody, it passes",
  none: "nobody",
});

function cardHealthReasonWords(part                    , reason        )         {
  const rows = PROGRAM_CARD_HEALTH_TABLE[part];
  if (!rows || !Object.hasOwn(rows, reason)) return "";
  const row = rows[reason];
  return `${row.what} Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS[row.who]}): ${row.fix}`;
}

const PROGRAM_CARD_HEALTH_HEAD = "Not working (the host's own record, read now; trust it over a guess). Tell the wearer the cause in one sentence, and do only the fix that is yours. Never press an Allow for them, never ask for a key, and change nothing on the host computer without their OK.";

const PROGRAM_CARD_HEALTH_PLAYBOOK                                       = Object.freeze({
  openclaw: "If a fix line is not enough, the ocuclaw-assist skill's references/card-fixes.md has a case for each reason (CARD-<PART>-<REASON>) with what you may check yourself. Never read it while you build or change a card.",
});

const PLAYBOOK_FILE = /^(?:\/|[A-Za-z]:[\\/])[^\u0000-\u001f\u007f-\u009f\u2028\u2029"`]{1,400}[\\/]references[\\/]card-fixes\.md$/;

function cardHealthPlaybookLine(host         , file          )         {
  if (host !== "openclaw") return "";
  if (typeof file !== "string" || !PLAYBOOK_FILE.test(file)) return PROGRAM_CARD_HEALTH_PLAYBOOK.openclaw;

  return PROGRAM_CARD_HEALTH_PLAYBOOK.openclaw.replace("the ocuclaw-assist skill's references/card-fixes.md has",
    () => `read ${file} (the ocuclaw-assist skill's references/card-fixes.md): it has`);
}

const PROGRAM_CARD_HEALTH_CHECK_WORDS = "You may check, read only:";

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safeName = (raw         , shape = NAME) => (typeof raw === "string" && shape.test(raw) ? raw : "");

const oneLine = (raw        ) => raw.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 200);
const PARTS                                = ["mcp", "jev", "model"];

const PROGRAM_CARD_HEALTH_MAX_LINES = 12;

function parseCardHealthParts(raw         )                   {
  if (!Array.isArray(raw)) return [];
  const out                   = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const part = (row       ).part;
    const reason = (row       ).reason;
    if (!reasonRow(part, reason)) continue;
    const atMs = (row       ).atMs;
    const fix = (row       ).fix;
    const status = (row       ).status;
    out.push({
      part,
      use: safeName((row       ).use),
      reason,
      ...(safeName((row       ).server, SERVER) ? { server: safeName((row       ).server, SERVER) } : {}),
      ...(Number.isFinite(atMs) && atMs > 0 ? { atMs } : {}),

      ...(part === "mcp" && reason === "host_blocked" && typeof fix === "string" && oneLine(fix) ? { fix: oneLine(fix) } : {}),

      ...(part === "feed" && reason === "http_status" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    });
  }
  return out;
}

function ago(now        , atMs        ) {
  const s = Math.max(0, Math.round((now - atMs) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function oneCheck(checkOf                               , part                    , reason        )         {
  if (typeof checkOf !== "function") return "";
  try {
    const check = checkOf(part, reason);
    return typeof check === "string" && check.length <= 400 && !/[\r\n\u0085\u2028\u2029]/.test(check) ? check.trim() : "";
  } catch {
    return "";
  }
}

function healthLines(parts                  , now        , checkOf                    , asks = true)                                      {

  const groups = new Map                                                                 ();
  for (const part of parts) {
    const id = `${part.part}\n${part.reason}\n${part.server ?? ""}\n${part.status ?? ""}`;
    const group = groups.get(id) ?? { first: part, uses: [], atMs: 0 };
    if (part.use && !group.uses.includes(part.use)) group.uses.push(part.use);
    group.atMs = Math.max(group.atMs, part.atMs ?? 0);
    groups.set(id, group);
  }
  const lines = [...groups.values()].slice(0, PROGRAM_CARD_HEALTH_MAX_LINES).map(({ first, uses, atMs }) => {
    const row = reasonRow(first.part, first.reason) ;
    const names = uses.length ? ` ${uses.map((use) => `"${use}"`).join(", ")}` : "";
    const server = first.server ? ` (server ${first.server})` : "";
    const when = atMs ? `, ${ago(now, atMs)}` : "";

    const own = OWN_TABLE_PARTS.has(first.part);
    const ask = asks && !own ? cardHealthAsk(first.part                      , first.reason, first.server) : "";
    const fix = first.fix ? `${row.fix} The host's own line: ${first.fix}` : row.fix;
    const more = [ask ? `You can put that in front of them: ${ask}.` : "", !own ? oneCheck(checkOf, first.part                      , first.reason) : ""].filter(Boolean).join(" ");

    const ended = more && !/[.!?]$/.test(fix) ? `${fix}.` : fix;
    return `${PART_WORDS[first.part]}${names}${server}: ${first.reason}${first.status ? ` ${first.status}` : ""}${when}. ${row.what} Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS[row.who]}): ${ended}${more ? ` ${more}` : ""}`;
  });
  return { lines, unsaid: groups.size - lines.length };
}

function composeCardHealthBlock(raw         , now = Date.now(), opts                                                                                     = {})         {
  const parts = parseCardHealthParts(raw);
  if (!parts.length) return "";
  const { lines, unsaid } = healthLines(parts, now, opts.check);

  const playbook = parts.some((part) => !OWN_TABLE_PARTS.has(part.part)) ? cardHealthPlaybookLine(opts.host, opts.playbookFile) : "";
  return [PROGRAM_CARD_HEALTH_HEAD, ...lines.map((line) => `- ${line}`), ...(unsaid > 0 ? [`- and ${unsaid} more.`] : []),
    ...(playbook ? [playbook] : [])].join("\n");
}

const PROGRAM_CARD_CHECK_ASK_HEAD = "[Ask my agent]";

const CARD_NAME_NOT_WORDS = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0"`\u00ab\u00bb\u201c-\u201f\u2033\u300c-\u300f\uff02\uff62\uff63]+|\udb40[\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const cardNameWords = (raw         ) => (typeof raw === "string"
  ? Array.from(raw.replace(CARD_NAME_NOT_WORDS, " ").replace(/\s+/g, " ").trim()).slice(0, 80).join("").trim() : "");

function composeCardCheckAsk(card                                       , raw         , now = Date.now(),
  opts                                                                                                           = {})         {
  if (!card) return "";
  const name = cardNameWords(card.name);
  const lead = `The wearer tapped "Ask my agent" on their saved card${name ? ` "${name}"` : ""} on the phone, where a part of it shows as not working. Their message is that tap, not a description of the fault.`;
  const block = composeCardHealthBlock(raw, now, opts);
  if (!block) {
    return `${PROGRAM_CARD_CHECK_ASK_HEAD}\n${lead} The host's own record, read now, shows nothing not working for this card. Say so in one sentence and ask what they saw. Do not guess a cause.`;
  }
  const how = "Work from the host's record, not from a guess: do the fix that is yours now, and for a fix that is theirs say which tap in one sentence. Reply in one or two short sentences.";
  return opts.blockBelow === true
    ? `${PROGRAM_CARD_CHECK_ASK_HEAD}\n${lead} The card is open on the glasses: its "Not working" block in this turn is the host's record. ${how}`
    : `${PROGRAM_CARD_CHECK_ASK_HEAD}\n${lead} ${how}\n${block}`;
}

const PROGRAM_CARD_HEALTH_NEXT_HEAD = "Why, from the host's own record:";

function composeCardHealthNext(raw         , part                    , now = Date.now(), fits                              = () => true)         {
  const parts = parseCardHealthParts(raw).filter((row) => row.part === part && fits(row.reason));
  if (!parts.length) return "";
  const { lines } = healthLines(parts, now);
  return [PROGRAM_CARD_HEALTH_NEXT_HEAD, ...lines].join(" ");
}

const PROGRAM_CARD_HOST_HEALTH_REASONS                                                     = Object.freeze({
  mcp: Object.freeze(["switch_off", "host_unsupported", "tools_unlisted"]),
  jev: Object.freeze(["switch_off", "no_key"]),
});

const PROGRAM_CARD_CHECK_HOST_REASONS                                                          = Object.freeze({
  ...PROGRAM_CARD_HOST_HEALTH_REASONS,
  model: Object.freeze(["switch_off", "no_host"]),
});

function parseCardHostHealth(raw         )                   {
  return parseCardHealthParts(raw)
    .filter((row) => (PROGRAM_CARD_HOST_HEALTH_REASONS                                     )[row.part]?.includes(row.reason))
    .map(({ part, reason }) => ({ part, use: "", reason }));
}

function composeCardHostHealthNext(raw         , now = Date.now())         {
  const parts = parseCardHostHealth(raw);
  if (!parts.length) return "";
  return [PROGRAM_CARD_HEALTH_NEXT_HEAD, ...healthLines(parts, now, undefined, false).lines].join(" ");
}

const PROGRAM_CARD_ACCESS_WHERE = ACCESS;

const CARDS_SWITCH = "Programmable cards, under CARDS & DRAWING on the phone's LiveUI page";

const LATER = "Do not make card calls again in this turn: tell the wearer the fix in one short line, and try again when they next ask.";
const PHONE                                                = {
  phone_away: { what: "No phone running OcuClaw is connected to this host right now.", who: "wearer",
    fix: `They open OcuClaw on the phone and leave it open until it connects. ${LATER}` },
  cards_not_offered: { what: "A phone is connected, but it does not offer cards to this host: its Programmable cards switch is off, or its app is older than cards.", who: "wearer",
    fix: `They turn on ${CARDS_SWITCH}; if the switch is not there, they update the app. ${LATER}` },
  phone_elsewhere: { what: "The phone has another conversation open, and this call runs only on the conversation the phone is showing.", who: "wearer",
    fix: "They open this conversation on the phone. Then make this call again." },
  phone_old: { what: "The phone's app shows cards but is older than this call, so it cannot do it.", who: "wearer",
    fix: "They update OcuClaw on the phone. Until then, do the work without this call and say what you could not check." },

  phone_changed: { what: "The phone's link changed while this was running (it reconnected, opened another conversation, or another phone took over), so its answer was dropped.", who: "agent",
    fix: "Make the call again, once. If it answers the same, ask the wearer to open this conversation on the phone." },
};
for (const row of Object.values(PHONE)) Object.freeze(row);

const PROGRAM_CARD_PHONE_TABLE                                                          = Object.freeze(PHONE);

const PHONE_CODES                       = new Set(["no_client", "unsupported", "client_changed"]);

function cardPhoneReason(error         , facts                )                           {
  if (!PHONE_CODES.has(error)) return "";
  if (facts.connected === false) return "phone_away";
  if (!facts.cards) return facts.connected === true ? "cards_not_offered" : "";
  if (facts.lacksCall === true) return "phone_old";
  if (facts.here === false) return "phone_elsewhere";
  return error === "client_changed" ? "phone_changed" : "";
}

function composeCardPhoneNext(error         , facts                )         {
  const reason = cardPhoneReason(error, facts);
  if (!reason) return "";
  const row = PHONE[reason];
  return `${PROGRAM_CARD_HEALTH_NEXT_HEAD} phone: ${reason}. ${row.what} Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS[row.who]}): ${row.fix}`;
}

function withCardPhoneWhy   (result   , facts                      )    {
  const answer      = result;
  if (!answer || typeof answer !== "object" || answer.ok === true || (typeof answer.next === "string" && answer.next)) return result;
  if (!PHONE_CODES.has(answer.error)) return result;
  let next = "";
  try { next = composeCardPhoneNext(answer.error, facts()); } catch {  }
  return next ? { ...answer, next } : result;
}

const PROGRAM_CARD_SETUP_PARTS = Object.freeze(["phone", "mcp", "jev", "model", "tasks"]         );

const PROGRAM_CARD_SETUP_TASKS_FIX = "manage_liveui_tasks check names each of them with its cause and its fix.";
const PROGRAM_CARD_SETUP_NO_TASK_RUNS = "This host keeps no run record for Tasks, so no Task was judged.";
const PROGRAM_CARD_SETUP_NEXT = "`not_working`: for phone, mcp, jev and model, what stops every card on this host from using that part, with who fixes it and how; tell the wearer the fix in one short line and press nothing for them. `nothing_marked`: the host knows of nothing that stops every card from using it; that is not a test of any one card. `not_read`: the host could not tell, so do not call it fine. Not judged here: one card's or one Task's own trouble (manage_liveui_tasks check reads those), and a card's feeds and location. `tasks` counts the Tasks whose newest run is not fine among those the host keeps a run record of (`read`).";
const PROGRAM_CARD_SETUP_UNAVAILABLE = "Cards could not be checked from here: OcuClaw's relay is not running in this process. From a terminal that is expected, so run ocuclaw_setup doctor from the agent's chat. In the agent's chat, the doctor's own findings say why the relay is not running.";

function composeCardSetupCheck(facts                                   , now = Date.now())                                                                                                        {
  if (!facts || typeof facts !== "object" || !facts.phone || typeof facts.phone !== "object")
    return { status: "unavailable", next: PROGRAM_CARD_SETUP_UNAVAILABLE };

  const said = (part                   , reason        , row                  )                =>
    ({ part, state: "not_working", reason, what: row.what, who: row.who, fix: row.fix.replace(` ${LATER}`, "") });
  const parts                  = [];
  const { connected, cards } = facts.phone;
  if (connected === false) parts.push(said("phone", "phone_away", PHONE.phone_away));
  else if (connected !== true) parts.push({ part: "phone", state: "not_read" });
  else if (cards !== true) parts.push(said("phone", "cards_not_offered", PHONE.cards_not_offered));
  else parts.push({ part: "phone", state: "nothing_marked" });
  const notRead = Array.isArray(facts.notRead) ? facts.notRead : [];
  const rows = parseCardHealthParts(facts.host);
  for (const part of ["mcp", "jev", "model"]         ) {
    const row = rows.find((entry) => entry.part === part && PROGRAM_CARD_CHECK_HOST_REASONS[part].includes(entry.reason));
    const words = row ? reasonRow(part, row.reason) : undefined;
    if (notRead.includes(part)) parts.push({ part, state: "not_read" });
    else if (row && words) parts.push(said(part, row.reason, words));
    else parts.push({ part, state: "nothing_marked" });
  }

  const tasks = isRecord(facts.tasks) ? facts.tasks : null;
  if (tasks && tasks.rows === null) parts.push({ part: "tasks", state: "not_read", what: PROGRAM_CARD_SETUP_NO_TASK_RUNS });
  else if (tasks && Array.isArray(tasks.rows)) {
    const judged = new Set        ();
    const failing = new Set        ();
    for (const row of tasks.rows) {
      const taskId = isRecord(row) ? checkId(row.taskId) : "";
      if (!taskId) continue;
      judged.add(taskId);
      const health = composeTaskRunHealth({ row }, now);
      if (health && typeof health.next === "string") failing.add(taskId);
    }
    if (failing.size) parts.push({ part: "tasks", state: "not_working", reason: "runs_not_fine",
      what: `The newest run of ${plural(failing.size, "Task")} is not fine.`, who: "agent", fix: PROGRAM_CARD_SETUP_TASKS_FIX, read: judged.size, notWorking: failing.size });
    else parts.push({ part: "tasks", state: "nothing_marked", read: judged.size });
  } else parts.push({ part: "tasks", state: "not_read" });
  return { status: "checked", parts, next: PROGRAM_CARD_SETUP_NEXT };
}

const ASK_AGAIN = "Build nothing now. When they ask for this again, ask once more and the card opens on the yes.";
const OPEN_FIX                                      = {
  phone_away: `They open OcuClaw on the phone and leave it open until it connects. ${ASK_AGAIN}`,
  cards_not_offered: `They turn on ${CARDS_SWITCH}; if the switch is not there, they update the app. ${ASK_AGAIN}`,
  phone_elsewhere: `They open this conversation on the phone. ${ASK_AGAIN}`,
  phone_old: `They update OcuClaw on the phone. ${ASK_AGAIN}`,
  phone_changed: `They keep this conversation open on the phone. ${ASK_AGAIN}`,
};

const PROGRAM_CARD_NO_DRAFT_SERVICE = "no_draft_service";
const OPEN_CODES                                               = Object.freeze({
  [PROGRAM_CARD_NO_DRAFT_SERVICE]: "drafts_off",
  not_found: "card_missing",
  presentation_owner_changed: "card_missing",
  kit_too_new: "card_too_new",
  timeout: "phone_slow",
  unavailable: "drafts_unavailable",
  save_failed: "drafts_unavailable",
  busy: "drafts_unavailable",
  invalid_owner: "drafts_unavailable",
  snapshot_unavailable: "drafts_unavailable",
  draft_unavailable: "drafts_unavailable",
});
const OPEN                                               = {
  card_missing: { what: "The host could not find that saved card's code in the Library: it was deleted, or this conversation may not open it.", who: "agent",
    fix: "Build nothing now. Ask the wearer whether the card is still in their Library; offer to build it new." },
  card_too_new: { what: "The card's code was written for a newer OcuClaw app than this phone runs, so the phone cannot open it.", who: "wearer",
    fix: "They update OcuClaw on the phone. Build nothing now, and do not rewrite the card for the older app." },
  phone_slow: { what: "The phone did not answer the host's request to open the card in time (15 s).", who: "wait",
    fix: `If it repeats, they close OcuClaw on the phone and open it again. ${ASK_AGAIN}` },
  drafts_unavailable: { what: "The host could not keep a draft of the card now: its draft storage was busy or could not be read or written.", who: "wait",
    fix: `${ASK_AGAIN} If it repeats, the host's owner checks that the OcuClaw state folder on the host can be written.` },

  drafts_off: { what: "This host keeps no card drafts: OcuClaw started on it without a state folder, so no saved card can be opened here to be changed.", who: "owner",
    fix: "Build nothing now, and do not build a new card in its place. The host's owner restarts OcuClaw with a state folder it can write; then they ask for the change again." },
};
for (const row of Object.values(OPEN)) Object.freeze(row);

const PROGRAM_CARD_OPEN_TABLE                                                         = Object.freeze(OPEN);

const PROGRAM_CARD_OPEN_CODES                                               = OPEN_CODES;

function cardOpenReason(error         , facts                )                                         {
  if (typeof error !== "string" || !Object.hasOwn(OPEN_CODES, error)) return "";
  const reason = OPEN_CODES[error];
  return reason === "phone_slow" && facts.connected === false ? "phone_away" : reason;
}

function composeCardOpenWhy(error         , facts                )         {
  const reason = cardPhoneReason(error, facts);

  if (reason) return `${PROGRAM_CARD_HEALTH_NEXT_HEAD} phone: ${reason}. ${PHONE[reason].what} Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS.wearer}): ${OPEN_FIX[reason]}`;
  const open = cardOpenReason(error, facts);
  if (open === "phone_away") return `${PROGRAM_CARD_HEALTH_NEXT_HEAD} phone: phone_away. ${PHONE.phone_away.what} Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS.wearer}): ${OPEN_FIX.phone_away}`;
  if (!open) return "";
  const row = OPEN[open];
  return `${PROGRAM_CARD_HEALTH_NEXT_HEAD} open: ${open}. ${row.what} Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS[row.who]}): ${row.fix}`;
}

function composeCardNotOpenedNext(why         )         {
  return typeof why === "string" && why
    ? `The card could not be opened as a draft. ${why} Tell the wearer the fix in one short line, and build nothing.`
    : "The card could not be opened as a draft. Tell the wearer in one line, and build nothing.";
}

const TASK_PAGE = "the Task's page on the phone";
const TASK_PAGE_CAP = "The Task's page on the phone";
const RUN_NOW = `the wearer taps Run now on ${TASK_PAGE}`;

const TASK_RUN                                   = {

  sign_in_expired: { what: "The run's sign-in to a tool, a connector or the model had expired or was refused.", who: "wearer",
    fix: `They sign in to that service again on the host; ${TASK_PAGE} offers Sign in again for it. Never ask them for a password or a key.` },
  ai_busy: { what: "The model's provider was busy or rate limited during the run.", who: "wait",
    fix: `A repeating Task tries again at its next time (nextRunAtMs). For a run sooner, ${RUN_NOW}.` },
  timed_out: { what: "The run ran out of time before it finished.", who: "agent",
    fix: `Offer a smaller request for the Task (update_draft; they approve the Draft on the phone). To try the same request once more, ${RUN_NOW}.` },
  result_lost: { what: "The run finished, but its result did not reach OcuClaw.", who: "wearer",
    fix: `${TASK_PAGE_CAP} offers Show the result while the result is still kept, and Run now otherwise. If it happens again, the host's owner checks that OcuClaw's plugin is running on the host.` },
  setup_blocked: { what: "A check on the host refused the run before it started.", who: "owner",
    fix: `What blocks it is in the host's own words, which this read does not carry: ${TASK_PAGE} shows them (Details) when the host said any, and offers Open the Task for its setup. They mend that on the host.` },
  host_stopped: { what: "The host stopped or restarted during the run.", who: "wait",
    fix: `A repeating Task runs again at its next time (nextRunAtMs). For a run sooner, ${RUN_NOW}.` },
  agent_gave_up: { what: "The run's agent said it could not do the job.", who: "agent",
    fix: `Read the Task's request (read) and say what in it this host cannot do, then offer a request it can do (update_draft; they approve the Draft on the phone). When the run left an answer, ${TASK_PAGE} opens it (Open the result).` },
  host_refused: { what: "The host's own agent policy refused something the run needed.", who: "owner",
    fix: "They allow it in the host's own settings, or the Task's request changes so a run does not need it (update_draft; they approve the Draft on the phone)." },
  other: { what: "The run failed, and OcuClaw could not sort the cause into one it knows.", who: "none",
    fix: `Do not guess a cause. ${TASK_PAGE_CAP} shows what the host said, when it said anything; to try once more, ${RUN_NOW}.` },

  skipped_overlap: { what: "The host did not start this run: the run before it was still going.", who: "wait",
    fix: "Nothing to mend. If it keeps happening, offer runs further apart (move_schedule) or a smaller request (update_draft)." },
  skipped_preflight: { what: "The host did not start this run: its own check before the run failed.", who: "owner",
    fix: "The host's reason is in its own words, which this read does not carry: the Task's row in the phone's Tasks list shows them when the host said any. They mend that on the host." },
  skipped_other: { what: "The host chose not to start this run, and gave no cause OcuClaw can sort.", who: "none",
    fix: "Do not guess a cause. The next run is tried as planned." },

  missed: { what: "A run fell due and nothing ran: the host was off, or OcuClaw's plugin was not running on it.", who: "owner",
    fix: "The host has to be running at the Task's time. A repeating Task runs again at its next time (nextRunAtMs)." },
  missed_reminder: { what: "A reminder went unanswered: it popped up and nobody acted on it in time, or it fell due while the host was off.", who: "none",
    fix: "Tell them which reminder was missed and when. A repeating reminder comes again at its next time." },

  sync_trying: { what: "The Task has a When but is not on the host's schedule yet, and OcuClaw is still trying.", who: "wait",
    fix: "It tries again by itself. The Task has not run and does not until it is on the schedule: do not say it is running." },
  sync_not_connected: { what: "The Task is not on the host's schedule: the host's link is down, or the host keeps no schedules now.", who: "owner",
    fix: `They check that the host is running and connected. Then the wearer taps Try again on ${TASK_PAGE}.` },
  sync_no_answer: { what: "The Task may not be on the host's schedule: the host did not answer when it was sent.", who: "wearer",
    fix: `They tap Try again on ${TASK_PAGE}.` },
  sync_refused: { what: "The Task is not on the host's schedule: the host turned its plan down.", who: "agent",
    fix: "Say the host refused the plan. If its When may be why, offer a plainer one (move_schedule). Do not send the same plan again." },
  sync_job_missing: { what: "The Task's job was deleted on the host, outside OcuClaw, so it no longer runs.", who: "wearer",
    fix: `They tap Try again on ${TASK_PAGE}, which puts the Task on the host's schedule again.` },
  sync_other: { what: "The Task is not on the host's schedule, and the host gave no cause OcuClaw can sort.", who: "wearer",
    fix: `Do not guess a cause. They tap Try again on ${TASK_PAGE}.` },
};
for (const row of Object.values(TASK_RUN)) Object.freeze(row);

const PROGRAM_CARD_TASK_RUN_TABLE                                             = Object.freeze(TASK_RUN);

const RUN_STATES                       = new Set(TASK_RUN_STATES);
const RUN_FAILURES                       = new Set(TASK_FAILURE_REASONS);
const RUN_SKIPS                       = new Set(TASK_SKIP_WHYS);
const RUN_SYNCS                       = new Set(TASK_SYNC_ERRORS);
const isRecord = (raw         )                             => raw !== null && typeof raw === "object" && !Array.isArray(raw);
const stampOf = (raw         )                => (Number.isSafeInteger(raw) && (raw          ) >= 0 ? raw           : null);

const RECORD_OUTCOMES                       = new Set(LIVEUI_TASK_RUN_END_REASONS);
const RECORD_BYS                       = new Set(LIVEUI_TASK_RUN_RECORD_BY);

function taskRunReasonCode(run         , kind          = null)         {
  if (!isRecord(run) || !RUN_STATES.has(run.state)) return "";
  if (run.state === "failed") return RUN_FAILURES.has(run.reason) ? run.reason : "other";
  if (run.state === "skipped") return `skipped_${RUN_SKIPS.has(run.skippedWhy) ? run.skippedWhy : "other"}`;
  if (run.state === "missed") return kind === "reminder" ? "missed_reminder" : "missed";
  if (run.state === "not_synced") {
    if (run.syncError === null || run.syncError === undefined) return "sync_trying";
    return `sync_${RUN_SYNCS.has(run.syncError) ? run.syncError : "other"}`;
  }
  return "";
}

const PROGRAM_CARD_TASK_RUNS_MAX = 10;

function composeTaskRunHealth(input                                      , now = Date.now())                             {
  const row = isRecord(input.row) ? input.row : null;
  const facts = row && isRecord(row.run) && RUN_STATES.has(row.run.state) ? row.run : null;
  const out                      = {};
  if (row && facts) {
    const reason = taskRunReasonCode(facts, row.kind);
    const service = reason === "sign_in_expired" && typeof facts.note === "string" && TASK_SERVICE_NAMES.has(facts.note) ? facts.note : "";
    const startedAtMs = stampOf(facts.startedAtMs);
    const endedAtMs = stampOf(facts.endedAtMs);
    const retryAtMs = stampOf(facts.retryAtMs);
    out.run = {
      state: facts.state,
      ...(reason ? { reason } : {}),
      ...(service ? { service } : {}),
      ...(startedAtMs !== null ? { startedAtMs } : {}),
      ...(endedAtMs !== null ? { endedAtMs } : {}),
      ...(retryAtMs !== null ? { retryAtMs } : {}),
      ...(facts.state === "not_synced" && Number.isSafeInteger(facts.syncTries) ? { syncTries: facts.syncTries } : {}),
    };
    const nextRunAtMs = stampOf(row.nextRunAtMs);
    if (nextRunAtMs !== null) out.nextRunAtMs = nextRunAtMs;
    if (Number.isSafeInteger(row.missedCount) && row.missedCount > 0) out.missedCount = row.missedCount;
    if (row.paused === true) out.paused = true;
    if (row.ask === true) out.onlyWhenAsked = true;
    if (Number.isSafeInteger(row.leftOut) && row.leftOut > 0) out.stepsWaitingForOk = row.leftOut;
    if (reason) {
      const cause = TASK_RUN[reason];
      const at = endedAtMs ?? startedAtMs;
      const when = at !== null && at <= now ? `, ${ago(now, at)}` : "";
      const head = `${PROGRAM_CARD_HEALTH_NEXT_HEAD} Task run: ${reason}${service ? ` (${service})` : ""}${when}. ${cause.what}`;
      const fix = `(${PROGRAM_CARD_HEALTH_WHO_WORDS[cause.who]}): ${cause.fix}`;
      if (row.paused === true && facts.state === "failed") {

        out.next = `${head} The Task is paused: nothing runs, and its page shows no failure and no fix buttons until the wearer resumes it there. Once it is resumed, the fix ${fix}`;
      } else if (facts.state === "failed" && retryAtMs !== null && retryAtMs > now) {

        const wait = cause.who === "wait" || cause.who === "none"
          ? `Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS.wait}): Nothing to do until then; read the Task again after it.`
          : `Fix ${fix}`;
        out.next = `${head} The host tries this run again by itself (retryAtMs), and ${TASK_PAGE} offers no button until that try ends. ${wait}`;
      } else {
        out.next = `${head} Fix ${fix}`;
      }
    }
  }
  const runs        = [];
  for (const record of Array.isArray(input.records) ? input.records : []) {
    if (runs.length >= PROGRAM_CARD_TASK_RUNS_MAX) break;
    if (!isRecord(record)) continue;
    const startedAtMs = stampOf(record.startedAt);
    const endedAtMs = stampOf(record.endedAt);
    if (startedAtMs === null && endedAtMs === null) continue;
    runs.push({
      ...(startedAtMs !== null ? { startedAtMs } : {}),
      ...(endedAtMs !== null ? { endedAtMs } : {}),
      ...(RECORD_OUTCOMES.has(record.outcome) ? { outcome: record.outcome } : {}),
      ...(RECORD_BYS.has(record.by) ? { by: record.by } : {}),
    });
  }
  if (runs.length) out.runs = runs;
  return Object.keys(out).length ? out : null;
}

const PROGRAM_CARD_TASK_ROW_WAIT_MS = 3000;

const ROW_UNREAD = Symbol("row unread");

const PROGRAM_CARD_TASK_RUN_UNREAD = `${PROGRAM_CARD_HEALTH_NEXT_HEAD} Task run: not_read. The host did not answer where this Task's newest run stands. Fix (${PROGRAM_CARD_HEALTH_WHO_WORDS.agent}): Read the Task again. Until that answers, do not say the Task ran or failed: health.runs lists only runs started from the glasses or a card, never the host's scheduled runs.`;

async function withTaskRunHealth   (result   , read                                                  , now = Date.now(),
  waitMs = PROGRAM_CARD_TASK_ROW_WAIT_MS)             {
  const answer      = result;
  if (!answer || typeof answer !== "object" || answer.status !== "accepted" || !isRecord(answer.task)) return result;
  let row          = null;
  let records          = null;
  let unread = false;
  if (typeof read.row === "function") {
    row = await readBounded(read.row, waitMs);
    if (row === ROW_UNREAD) { unread = true; row = null; }
  }
  try { records = typeof read.records === "function" ? await read.records() : null; } catch { records = null; }
  const health = composeTaskRunHealth({ row, records }, now);

  if (unread) return { ...answer, health: { ...(health || {}), notRead: ["run"], next: PROGRAM_CARD_TASK_RUN_UNREAD } };
  return health ? { ...answer, health } : result;
}

const PROGRAM_CARD_CHECK_NAMED_MAX = 8;

const PROGRAM_CARD_CHECK_LINES_MAX = 3;

const PROGRAM_CARD_CHECK_CARDS_MAX = 200;

const PROGRAM_CARD_CHECK_QUERY_MAX = 120;

const PROGRAM_CARD_CHECK_NOT_JUDGED = "Not judged by this read: a card's own script, its feeds, its location beyond the phone's last word since the host started, what an MCP send did, and any use the host keeps no record of. If a card still looks wrong, have the wearer open it: the open card's context in your turn says more.";
const PROGRAM_CARD_CHECK_CARD_FINE = "The host's own record marks no MCP read, Jev question or model use of this saved card as not working.";

const PROGRAM_CARD_CHECK_NO_RECORD_WHY = "the host learns a card's uses when the phone opens it with that part switched on and set up, and it keeps none for this card now";
const PROGRAM_CARD_CHECK_IF_USED = "ifUsed is what stops every card's use of such a part on this host now. The host only guesses from the card's code that it has one: if it does, that is the cause. Say it as possible, not certain, with its fix.";
const PROGRAM_CARD_CHECK_NO_RECORD_NEXT = "To judge them, have the wearer open the card once, then check again.";
const PROGRAM_CARD_CHECK_NO_RECORD_NEXT_AFTER_FIX = "To judge them, the fix in ifUsed comes first; then have the wearer open the card once, and check again.";

const PROGRAM_CARD_CHECK_NOTHING_KEPT = "The host keeps no MCP, Jev or model use of this saved card, so it judged nothing: the card may have none.";

const PROGRAM_CARD_CHECK_CLOSED_CHECKS = "A check on a line that names the card's Source or the block in your turn needs the card open: skip it while the card is closed.";
const PROGRAM_CARD_CHECK_UNCLEAR = "The name fits more than one saved card, or none exactly: ask the user which card they mean, naming the cards in matches, then check again with savedCard set to that card's id.";
const PROGRAM_CARD_CHECK_NOT_FOUND = "No saved card this agent may read has that name or id. Ask the user for the card's name as the Library shows it. A card that was never saved has no record to check: when it is open, its context in your turn already says what is not working.";
const PROGRAM_CARD_CHECK_UNAVAILABLE = "The host could not read its saved cards now. Check again; until that answers, do not say a card is fine.";

function programCardNamedParts(source         )                       {
  const text = typeof source === "string" ? source : "";
  return PARTS.filter((part) => new RegExp(`(^|[^\\w$.])(["']?)${part}\\2\\s*:\\s*\\{`).test(text));
}

const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const checkId = (raw         ) => (typeof raw === "string" && CHECK_ID.test(raw) ? raw : "");

const checkName = (raw         ) => (typeof raw === "string"
  ? oneLine(raw.replace(/[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")).slice(0, 80) : "");
const checkCount = (raw         ) => (Number.isSafeInteger(raw) && (raw          ) > 0 ? raw           : 0);
const plural = (n        , one        , many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function cardRef(raw         )                                      {
  const id = isRecord(raw) ? checkId(raw.appId) : "";
  return id ? { id, name: checkName((raw                       ).name) } : null;
}

const unreadParts = (raw         )                       => PARTS.filter((part) => Array.isArray(raw) && raw.includes(part));
const PART_USES                                               = Object.freeze({ mcp: "MCP uses", jev: "Jev questions", model: "model uses" });
const PART_ONE                                               = Object.freeze({ mcp: "MCP read", jev: "Jev question", model: "model use" });
const orList = (words          ) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : words.join(""));
const andList = (words          ) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words.join(""));

function cardUnjudged(raw                     , now        )                                                                                      {
  const notRead = unreadParts(raw.notRead);
  const noRecord = unreadParts(raw.noRecord).filter((part) => !notRead.includes(part));
  const rows = parseCardHealthParts(raw.hostWide)
    .filter((row) => !OWN_TABLE_PARTS.has(row.part) && noRecord.includes(row.part                      ) && PROGRAM_CARD_CHECK_HOST_REASONS[row.part                      ].includes(row.reason))
    .map(({ part, reason }) => ({ part, use: "", reason }));
  return { notRead, noRecord, ifUsed: rows.length ? healthLines(rows, now, undefined, false).lines : [] };
}

function notWorkingLines(parts         , now        , check                               , max = PROGRAM_CARD_HEALTH_MAX_LINES)           {
  const rows = parseCardHealthParts(parts);
  if (!rows.length) return [];
  const { lines, unsaid } = healthLines(rows, now, check);
  const left = unsaid + Math.max(0, lines.length - max);
  return left > 0 ? [...lines.slice(0, max), `and ${left} more.`] : lines;
}

function troubleNext(opts               , cards         )         {
  const playbook = cards ? cardHealthPlaybookLine(opts.host, opts.playbookFile) : "";
  return playbook ? `${PROGRAM_CARD_HEALTH_HEAD} ${playbook}` : PROGRAM_CARD_HEALTH_HEAD;
}

function composeSavedCardCheck(found         , now = Date.now(), opts                = {})                      {
  const answer                      = isRecord(found) ? found : {};
  const card = answer.status === "found" ? cardRef(answer.card) : null;
  if (card) {
    const lines = notWorkingLines(answer.parts, now, opts.check);
    const { notRead, noRecord, ifUsed } = cardUnjudged(answer, now);

    const judged = unreadParts(answer.judged).filter((part) => !notRead.includes(part) && !noRecord.includes(part));
    const said           = [];
    if (notRead.length) said.push(`The host could not judge this card's ${andList(notRead.map((part) => PART_USES[part]))} now. Check again; until that answers, do not say they are fine.`);
    if (lines.length) {
      said.push(troubleNext(opts, true));
      if (opts.check) said.push(PROGRAM_CARD_CHECK_CLOSED_CHECKS);
    } else if (judged.length === PARTS.length) said.push(PROGRAM_CARD_CHECK_CARD_FINE);
    else if (judged.length) said.push(`The host's own record marks no ${orList(judged.map((part) => PART_ONE[part]))} of this saved card as not working.`);
    else if (!notRead.length && !noRecord.length) said.push(PROGRAM_CARD_CHECK_NOTHING_KEPT);
    if (noRecord.length) {
      said.push(`The host keeps no record of this card's ${andList(noRecord.map((part) => PART_USES[part]))}, so it did not judge them: ${PROGRAM_CARD_CHECK_NO_RECORD_WHY}. Do not say they are fine.`);
      if (ifUsed.length) said.push(PROGRAM_CARD_CHECK_IF_USED);
      said.push(ifUsed.length ? PROGRAM_CARD_CHECK_NO_RECORD_NEXT_AFTER_FIX : PROGRAM_CARD_CHECK_NO_RECORD_NEXT);
    }
    said.push(PROGRAM_CARD_CHECK_NOT_JUDGED);
    return {
      status: "accepted",
      check: {
        card: {
          ...card, ...(lines.length ? { notWorking: lines } : {}), ...(notRead.length ? { notRead } : {}),
          ...(noRecord.length ? { noRecord } : {}), ...(ifUsed.length ? { ifUsed } : {}),
        },
        next: said.join(" "),
      },
    };
  }
  if (answer.status === "unclear" || answer.status === "none") {
    const matches = (Array.isArray(answer.matches) ? answer.matches : []).map(cardRef).filter((match) => match !== null).slice(0, 5);
    return matches.length ? { status: "rejected", code: "card_unclear", matches, message: PROGRAM_CARD_CHECK_UNCLEAR }
      : { status: "rejected", code: "card_not_found", message: PROGRAM_CARD_CHECK_NOT_FOUND };
  }
  return { status: "rejected", code: "check_unavailable", message: PROGRAM_CARD_CHECK_UNAVAILABLE };
}

async function readBounded(read               , waitMs        )                   {
  let timer      = null;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((resolve) => { timer = setTimeout(() => resolve(ROW_UNREAD), waitMs); }),
    ]);
  } catch { return ROW_UNREAD; } finally { clearTimeout(timer); }
}

async function readCardSetupTaskRows(read               , waitMs = PROGRAM_CARD_TASK_ROW_WAIT_MS)                                             {
  const rows = await readBounded(read, waitMs);
  return rows === null || Array.isArray(rows) ? { rows } : null;
}

async function composeEverythingCheck(read               , now = Date.now(), opts                = {},
  waitMs = PROGRAM_CARD_TASK_ROW_WAIT_MS)                               {
  const notRead           = [];
  const said           = [];

  const cards                      = { read: 0 };
  let listed          = null;
  try { listed = typeof read.cards === "function" ? await read.cards(null) : null; } catch { listed = null; }
  if (isRecord(listed) && listed.status === "all") {
    cards.read = checkCount(listed.read);
    const found        = [];
    const unjudged        = [];
    for (const raw of Array.isArray(listed.cards) ? listed.cards : []) {
      const card = cardRef(raw);
      if (!card) continue;
      const lines = notWorkingLines(raw.parts, now, undefined, PROGRAM_CARD_CHECK_LINES_MAX);
      if (lines.length) found.push({ ...card, notWorking: lines });
      const { notRead: unread, noRecord, ifUsed } = cardUnjudged(raw, now);
      if (unread.length || noRecord.length) {
        unjudged.push({ ...card, ...(unread.length ? { notRead: unread } : {}), ...(noRecord.length ? { noRecord } : {}),
          ...(ifUsed.length ? { ifUsed: ifUsed.slice(0, PROGRAM_CARD_CHECK_LINES_MAX) } : {}) });
      }
    }
    if (found.length) cards.notWorking = found.slice(0, PROGRAM_CARD_CHECK_NAMED_MAX);
    if (found.length > PROGRAM_CARD_CHECK_NAMED_MAX) cards.more = found.length - PROGRAM_CARD_CHECK_NAMED_MAX;
    if (unjudged.length) cards.unjudged = unjudged.slice(0, PROGRAM_CARD_CHECK_NAMED_MAX);
    if (unjudged.length > PROGRAM_CARD_CHECK_NAMED_MAX) cards.unjudgedMore = unjudged.length - PROGRAM_CARD_CHECK_NAMED_MAX;

    if (checkCount(listed.left)) cards.left = checkCount(listed.left);
  } else {
    notRead.push("cards");
  }

  const tasks                      = { read: 0 };
  const rows = typeof read.rows === "function" ? await readBounded(read.rows, waitMs) : null;
  const names = new Map                ();
  const listedTasks = new Set        ();
  try {
    const list      = typeof read.tasks === "function" ? await read.tasks() : null;
    for (const task of Array.isArray(list?.tasks) ? list.tasks : []) {
      const id = isRecord(task) ? checkId(task.itemId ?? task.taskId) : "";
      if (!id) continue;
      listedTasks.add(id);
      if (checkName(task.name)) names.set(id, checkName(task.name));
    }
  } catch {  }
  if (rows === null) {

    tasks.hostKeepsRuns = false;
  } else if (!Array.isArray(rows)) {
    notRead.push("tasks");
  } else {
    const found        = [];
    const judged = new Set        ();
    for (const row of rows) {
      const taskId = isRecord(row) ? checkId(row.taskId) : "";
      if (!taskId) continue;
      judged.add(taskId);
      const health = composeTaskRunHealth({ row }, now);
      if (!health || typeof health.next !== "string") continue;

      const { run, runs: _runs, next, ...facts } = health;
      found.push({ taskId, ...(names.has(taskId) ? { name: names.get(taskId) } : {}), ...run, ...facts, next });
    }
    tasks.read = judged.size;
    if (found.length) tasks.notWorking = found.slice(0, PROGRAM_CARD_CHECK_NAMED_MAX);
    if (found.length > PROGRAM_CARD_CHECK_NAMED_MAX) tasks.more = found.length - PROGRAM_CARD_CHECK_NAMED_MAX;
    const noRecord = [...listedTasks].filter((id) => !judged.has(id)).length;
    if (noRecord) tasks.noRecord = noRecord;
  }

  if (notRead.length) said.push(`The host did not answer for: ${notRead.join(", ")}. Check again; until that answers, do not say ${notRead.length > 1 ? "they are" : `the ${notRead[0]} are`} fine.`);
  if (cards.unjudged) {
    const count = cards.unjudged.length + (cards.unjudgedMore ?? 0);
    said.push(`For ${plural(count, "saved card")} the host could not judge every use (cards.unjudged): do not say ${count === 1 ? "it is" : "they are"} fine. notRead names a part to check again. noRecord names a part the card's code seems to name but the host keeps no use of: ${PROGRAM_CARD_CHECK_NO_RECORD_WHY}.`);
    if (cards.unjudged.some((card     ) => card.ifUsed)) said.push(PROGRAM_CARD_CHECK_IF_USED);
  }
  if (cards.notWorking || tasks.notWorking) {
    said.push(troubleNext(opts, !!cards.notWorking));
    if (cards.more || tasks.more) said.push("more counts what is not named here: the Library list names every saved card and list every Task; check one card with savedCard, or read one Task with read.");
  } else {

    const counted = [
      ...(notRead.includes("cards") ? [] : [plural(cards.read, "saved card")]),
      ...(notRead.includes("tasks") || tasks.hostKeepsRuns === false ? [] : [plural(tasks.read, "Task")]),
    ];
    if (counted.length) said.push(`Of what the host keeps a record of, nothing is marked not working: ${counted.join(" and ")} read.`);
  }
  if (tasks.hostKeepsRuns === false) said.push("This host keeps no run record for Tasks, so no Task was judged.");
  if (tasks.noRecord) said.push(`${plural(tasks.noRecord, "Task")} ${tasks.noRecord === 1 ? "has" : "have"} no run record on the host (no When, or not on its schedule) and ${tasks.noRecord === 1 ? "was" : "were"} not judged.`);
  if (cards.left) said.push(`${plural(cards.left, "saved card")} ${cards.left === 1 ? "was" : "were"} not read (left): check one with savedCard.`);
  said.push(PROGRAM_CARD_CHECK_NOT_JUDGED);
  return { status: "accepted", check: { cards, tasks, ...(notRead.length ? { notRead } : {}), next: said.join(" ") } };
}

async function runCardCheck(input                                            , read               , now = Date.now(),
  opts                = {}, waitMs = PROGRAM_CARD_TASK_ROW_WAIT_MS)                               {
  const raw = input ? input.savedCard : undefined;
  if (raw === undefined || raw === null) return composeEverythingCheck(read, now, opts, waitMs);
  const query = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!query || query.length > PROGRAM_CARD_CHECK_QUERY_MAX) {
    return { status: "rejected", code: "check_invalid", message: `savedCard must be a saved card's name or id, at most ${PROGRAM_CARD_CHECK_QUERY_MAX} characters` };
  }
  let found          = null;
  try { found = typeof read.cards === "function" ? await read.cards(query) : null; } catch { found = null; }
  return composeSavedCardCheck(found, now, opts);
}

module.exports = { PROGRAM_CARD_FEED_REWRITE, PROGRAM_CARD_FEED_HEALTH_TABLE, PROGRAM_CARD_SEND_HEALTH_TABLE, PROGRAM_CARD_LOCATION_HEALTH_TABLE, PROGRAM_CARD_HEALTH_TABLE, PROGRAM_CARD_HEALTH_ASKS, cardHealthAsk, PROGRAM_CARD_HEALTH_WHO_WORDS, cardHealthReasonWords, PROGRAM_CARD_HEALTH_HEAD, PROGRAM_CARD_HEALTH_PLAYBOOK, cardHealthPlaybookLine, PROGRAM_CARD_HEALTH_CHECK_WORDS, PROGRAM_CARD_HEALTH_MAX_LINES, parseCardHealthParts, composeCardHealthBlock, PROGRAM_CARD_CHECK_ASK_HEAD, composeCardCheckAsk, PROGRAM_CARD_HEALTH_NEXT_HEAD, composeCardHealthNext, PROGRAM_CARD_HOST_HEALTH_REASONS, PROGRAM_CARD_CHECK_HOST_REASONS, parseCardHostHealth, composeCardHostHealthNext, PROGRAM_CARD_ACCESS_WHERE, PROGRAM_CARD_PHONE_TABLE, cardPhoneReason, composeCardPhoneNext, withCardPhoneWhy, PROGRAM_CARD_SETUP_PARTS, PROGRAM_CARD_SETUP_TASKS_FIX, PROGRAM_CARD_SETUP_NO_TASK_RUNS, PROGRAM_CARD_SETUP_NEXT, PROGRAM_CARD_SETUP_UNAVAILABLE, composeCardSetupCheck, PROGRAM_CARD_NO_DRAFT_SERVICE, PROGRAM_CARD_OPEN_TABLE, PROGRAM_CARD_OPEN_CODES, cardOpenReason, composeCardOpenWhy, composeCardNotOpenedNext, PROGRAM_CARD_TASK_RUN_TABLE, taskRunReasonCode, PROGRAM_CARD_TASK_RUNS_MAX, composeTaskRunHealth, PROGRAM_CARD_TASK_ROW_WAIT_MS, PROGRAM_CARD_TASK_RUN_UNREAD, withTaskRunHealth, PROGRAM_CARD_CHECK_NAMED_MAX, PROGRAM_CARD_CHECK_LINES_MAX, PROGRAM_CARD_CHECK_CARDS_MAX, PROGRAM_CARD_CHECK_QUERY_MAX, PROGRAM_CARD_CHECK_NOT_JUDGED, PROGRAM_CARD_CHECK_CARD_FINE, PROGRAM_CARD_CHECK_NO_RECORD_WHY, PROGRAM_CARD_CHECK_IF_USED, PROGRAM_CARD_CHECK_NO_RECORD_NEXT, PROGRAM_CARD_CHECK_NO_RECORD_NEXT_AFTER_FIX, PROGRAM_CARD_CHECK_NOTHING_KEPT, PROGRAM_CARD_CHECK_CLOSED_CHECKS, PROGRAM_CARD_CHECK_UNCLEAR, PROGRAM_CARD_CHECK_NOT_FOUND, PROGRAM_CARD_CHECK_UNAVAILABLE, programCardNamedParts, composeSavedCardCheck, readCardSetupTaskRows, composeEverythingCheck, runCardCheck };
