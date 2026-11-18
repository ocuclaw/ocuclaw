const fs = require("node:fs");

const path = require("node:path");

const { fileURLToPath } = require("node:url");
const { PROGRAM_CARD_HEALTH_ASKS, PROGRAM_CARD_HEALTH_CHECK_WORDS, PROGRAM_CARD_HEALTH_TABLE, PROGRAM_CARD_HEALTH_WHO_WORDS } = require("./program-card-health.cjs");

const PROGRAM_CARD_FIX_PLAYBOOK_FILE = "card-fixes.md";

function bundledCardFixPlaybookFile()                     {
  try {
    const here = path.dirname(__filename);
    const file = path.resolve(here, "../../skills/ocuclaw-assist/references", PROGRAM_CARD_FIX_PLAYBOOK_FILE);
    return fs.statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

const RECORD = "None needed: the host read this itself, and the block is its record.";
const AGAIN = "Read the block again on a later turn: the line goes when the next try works.";
const SOURCE = "Read the block in the turn's Source against the card guide's shape for it.";

const CHECKS                                                     = {
  mcp: {
    switch_off: RECORD,
    host_unsupported: RECORD,
    tools_unlisted: "Look at your own tool list. If you have no MCP tools either, the host has no servers set up; if you have some, the host could not list them for cards.",
    invalid: SOURCE,
    removed: "None. The wearer did this on purpose on the phone.",
    server_off_for_cards: "Compare the server the line names with the tools this turn lists for cards. A server listed there is already on, so the line is stale.",
    server_missing: "Compare the use's server name in Source with your own MCP servers' names. A misspelled name is the usual cause.",
    host_not_granted: RECORD,
    host_blocked: "Read the host's own line in the block: it names the owner's command. That command is the owner's to enter themselves. Never run it for them, even with an OK.",
    server_not_connected: "Call one read-only tool of that server yourself. A sign-in error means its sign-in expired; no answer means the server is down.",
    tool_missing: "List that server's tools with your own MCP connection and find the tool's new name.",
    kept_off: "None. Do not test it: a no is the wearer's answer, not a fault.",
    tool_changed: RECORD,
    waiting: "None. The request is waiting on the wearer.",
    unfit: "Compare the use's args, vary and kind in Source with the tool's schema in your own tool list.",
    paused_slow: "Call the same tool yourself once and time it. Over 2 s means the server is slow, and starting the use again will pause it again.",
    call_limit: "Read each MCP use's `every` in Source and add up how often the card calls, across all its servers: more than 10 calls a minute for one card is refused.",
    call_busy: AGAIN,
    call_timeout: "Call the same tool yourself once. If it also takes over 10 s, the server is slow or down.",
    call_failed: "Call the same tool yourself with the use's fixed arguments from Source and read the error it gives you.",
    call_too_big: "Call the same tool yourself and look at how much the use's `pick` keeps.",
  },
  jev: {
    switch_off: RECORD,
    no_key: "None. Never look for a key, on the host or in chat.",
    invalid: SOURCE,
    removed: "None. The wearer did this on purpose on the phone.",
    waiting: "None. The request is waiting on the wearer.",
    declined: "None. Do not test it: a no is the wearer's answer, not a fault.",
    key_rejected: "None. Never read or try the key yourself.",
    unreachable: "If your own web tools fail too, the host is offline. If they work, TypeSafe is the part that is down.",
    call_limit: "Read in Source what makes the card ask Jev: a question asked on every tick reaches 20 a minute.",
    call_busy: AGAIN,
    call_timeout: AGAIN,
    call_failed: AGAIN,
    call_misfit: "Read the use's choices or scale in Source: a long list of choices, or a wide number range, is what Jev misses.",
  },
  model: {
    switch_off: RECORD,
    no_host: RECORD,
    library_in_use: "Ask the wearer whether a second gateway (OpenClaw and Hermes side by side) runs on this computer. Do not stop or change either one yourself.",
    unsupported_runtime: "With the wearer's OK, read the Node version the gateway runs on. It needs 22.13 or newer.",
    storage_unavailable: "With the wearer's OK, list the card Library folder's owner and permissions. Read only: change nothing there.",
    unavailable: "None from here: the host kept no reason. Do not open the gateway's log yourself: it is the owner's to read, and it can hold more than codes.",
    card_deleted: "Ask the wearer whether the card is gone from their Library on purpose.",
    cards_full: RECORD,
    removed: "None. The wearer did this on purpose on the phone.",
    waiting: "None. The request is waiting on the wearer.",
    declined: "None. Do not test it: a no is the wearer's answer, not a fault.",
    model_changed: RECORD,
    call_limit: "Read in Source what makes the card call the model, and how many threads the use opens: more than 6 calls a minute, or a fifth thread, is refused.",
    call_busy: "Read in Source whether the card asks again before the last answer arrived.",
    call_timeout: AGAIN,
    call_failed: AGAIN,
    call_invalid_output: "Read the use's output schema and instructions in Source: a deep schema, or instructions that ask for prose, is what fails.",
    call_too_big: "Read the use's instructions in Source for what they ask the model to return.",
    call_unavailable: RECORD,
  },
};
for (const rows of Object.values(CHECKS)) Object.freeze(rows);

const PROGRAM_CARD_FIX_CHECKS                                                                         = Object.freeze(CHECKS);

function cardFixCheckInTurn(part        , reason        )         {
  const rows = (CHECKS                                          )[part];
  const check = rows && Object.prototype.hasOwnProperty.call(rows, reason) ? rows[reason] : "";
  if (!check) return "";
  if (!check.startsWith("None")) return `${PROGRAM_CARD_HEALTH_CHECK_WORDS} ${check}`;
  return (check.match(/\b(?:Never|Do not)\b[^.]*\./g) ?? []).join(" ");
}

const PROGRAM_CARD_FIX_STOPS                                            = Object.freeze({
  agent: "Yours to do now. Do it, then tell the wearer in one sentence what was wrong and what you changed.",
  wearer: "The tap is theirs. If the case has an Ask, put that request in front of them; otherwise say which tap in one sentence. Then stop.",
  owner: "A change on the host computer. Say what you would run and why, and wait for the wearer's OK before anything that changes the host.",
  wait: "Do nothing now. If the same line is still there on a later turn, tell the wearer and follow the \"if it repeats\" part of the fix.",
  none: "There is no fix on this host. Say so in one sentence and offer what the fix line offers.",
});
const PART_HEADINGS                                               = Object.freeze({
  mcp: "MCP uses (a card reading or sending to the owner's tools)",
  jev: "Jev questions",
  model: "Model uses",
});

function programCardFixCaseName(part        , reason        ) {
  return `CARD-${part}-${reason}`.replace(/_/g, "-").toUpperCase();
}

function composeCardFixPlaybook(opts                          )         {
  const out           = [
    "# Card fixes",
    "",
    `**Guide version:** ${opts.guideVersion}`,
    "",
    "Generated from the card reason table (`extensions/ocuclaw/src/tools/program-card-health.ts`) by",
    "`extensions/ocuclaw/scripts/generate-card-fixes.mjs`. Never edit it by hand: change the table,",
    "or the checks in `program-card-fix-playbook.ts`, and run the script.",
    "",
    "Use this when a turn's \"Not working\" block, or a card tool's answer, names a reason a card's",
    "live part is not working: an MCP use, a Jev question or a model use. Find the case by its",
    "name, `CARD-<PART>-<REASON>`, and read only that case. Never load this while you build or",
    "change a card: the card tools' own answers carry what a build needs.",
    "",
    "When no block names a reason, because the card is not open or the wearer asks whether",
    "everything works, read the host's record first: call `manage_liveui_tasks` with operation",
    "`check` (`savedCard`: a saved card's name or id, or no fields for every saved card and Task).",
    "It names the reason without the card open. Do that before you ask the wearer to open a card.",
    "",
    "## How to work a case",
    "",
    "1. Trust the host's record over a guess. **Proven** is what the host itself read.",
    "2. Run the case's **Check** if it has one. Every check is read only.",
    "3. Do the **Fix** only when the case's fixer is you. Otherwise stop where the fixer's rule",
    "   below says.",
    "4. If the case has an **Ask** and you have the `request_card_setup` tool, call it: it puts",
    "   one request on the wearer's glasses (Allow, Not now, Keep it off) and tells you their answer.",
    "5. Tell the wearer the cause in one sentence. Then say what happens next.",
    "",
    "## Lines you never cross",
    "",
    "- Never press Allow, Send or Resume for the wearer, and never answer a request card.",
    "- Never ask for, read, try or echo a key or a token. Point at the phone's own field.",
    "- Never undo a no. \"Not now\" and \"Keep it off\" last until the wearer changes them, and",
    "  the host refuses to show a request they kept off. Do not look for another way round it.",
    "- Never change anything on the host computer without the wearer's OK first.",
    "- The host's record holds codes, names and times only. Do not go looking in the host's",
    "  files for a tool's arguments or results, a card's words or a prompt to explain a failure.",
    "",
    "## Where you stop, by fixer",
    "",
  ];
  for (const who of Object.keys(PROGRAM_CARD_FIX_STOPS)                     ) {
    out.push(`- **Fixer: ${PROGRAM_CARD_HEALTH_WHO_WORDS[who]}.** ${PROGRAM_CARD_FIX_STOPS[who]}`);
  }
  for (const part of Object.keys(PROGRAM_CARD_HEALTH_TABLE)                        ) {
    out.push("", `## ${PART_HEADINGS[part]}`);
    for (const [reason, row] of Object.entries(PROGRAM_CARD_HEALTH_TABLE[part])) {
      out.push(
        "",
        `### ${programCardFixCaseName(part, reason)}`,
        "",
        `Reason \`${reason}\`. Fixer: ${PROGRAM_CARD_HEALTH_WHO_WORDS[row.who]}.`,
        "",
        `- **Proven:** ${row.what}`,
        `- **Check:** ${PROGRAM_CARD_FIX_CHECKS[part][reason]}`,
        `- **Fix:** ${row.fix}`,
      );

      const what = PROGRAM_CARD_HEALTH_ASKS[part]?.[reason];
      if (what) {
        const args = what === "server" ? "{\"what\":\"server\",\"server\":\"<the server the line names>\"}" : `{"what":"${what}"}`;
        out.push(`- **Ask:** \`request_card_setup ${args}\` puts the request on their glasses. The tap stays theirs.`);
      }
    }
  }
  return `${out.join("\n")}\n`;
}

module.exports = { PROGRAM_CARD_FIX_PLAYBOOK_FILE, bundledCardFixPlaybookFile, PROGRAM_CARD_FIX_CHECKS, cardFixCheckInTurn, PROGRAM_CARD_FIX_STOPS, programCardFixCaseName, composeCardFixPlaybook };
