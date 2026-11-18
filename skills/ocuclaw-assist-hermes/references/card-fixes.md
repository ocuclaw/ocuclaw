# Card fixes

**Guide version:** 2026-10-28 (1.3.27-hermes)

Generated from the card reason table (`extensions/ocuclaw/src/tools/program-card-health.ts`) by
`extensions/ocuclaw/scripts/generate-card-fixes.mjs`. Never edit it by hand: change the table,
or the checks in `program-card-fix-playbook.ts`, and run the script.

Use this when a turn's "Not working" block, or a card tool's answer, names a reason a card's
live part is not working: an MCP use, a Jev question or a model use. Find the case by its
name, `CARD-<PART>-<REASON>`, and read only that case. Never load this while you build or
change a card: the card tools' own answers carry what a build needs.

When no block names a reason, because the card is not open or the wearer asks whether
everything works, read the host's record first: call `manage_liveui_tasks` with operation
`check` (`savedCard`: a saved card's name or id, or no fields for every saved card and Task).
It names the reason without the card open. Do that before you ask the wearer to open a card.

## How to work a case

1. Trust the host's record over a guess. **Proven** is what the host itself read.
2. Run the case's **Check** if it has one. Every check is read only.
3. Do the **Fix** only when the case's fixer is you. Otherwise stop where the fixer's rule
   below says.
4. If the case has an **Ask** and you have the `request_card_setup` tool, call it: it puts
   one request on the wearer's glasses (Allow, Not now, Keep it off) and tells you their answer.
5. Tell the wearer the cause in one sentence. Then say what happens next.

## Lines you never cross

- Never press Allow, Send or Resume for the wearer, and never answer a request card.
- Never ask for, read, try or echo a key or a token. Point at the phone's own field.
- Never undo a no. "Not now" and "Keep it off" last until the wearer changes them, and
  the host refuses to show a request they kept off. Do not look for another way round it.
- Never change anything on the host computer without the wearer's OK first.
- The host's record holds codes, names and times only. Do not go looking in the host's
  files for a tool's arguments or results, a card's words or a prompt to explain a failure.

## Where you stop, by fixer

- **Fixer: you, now.** Yours to do now. Do it, then tell the wearer in one sentence what was wrong and what you changed.
- **Fixer: the wearer, with a tap.** The tap is theirs. If the case has an Ask, put that request in front of them; otherwise say which tap in one sentence. Then stop.
- **Fixer: the host's owner, on the host computer.** A change on the host computer. Say what you would run and why, and wait for the wearer's OK before anything that changes the host.
- **Fixer: nobody, it passes.** Do nothing now. If the same line is still there on a later turn, tell the wearer and follow the "if it repeats" part of the fix.
- **Fixer: nobody.** There is no fix on this host. Say so in one sentence and offer what the fix line offers.

## MCP uses (a card reading or sending to the owner's tools)

### CARD-MCP-SWITCH-OFF

Reason `switch_off`. Fixer: the wearer, with a tap.

- **Proven:** MCP in cards is switched off on this host.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They turn on MCP in cards (Tool & service access on the phone's LiveUI page).
- **Ask:** `request_card_setup {"what":"mcp"}` puts the request on their glasses. The tap stays theirs.

### CARD-MCP-HOST-UNSUPPORTED

Reason `host_unsupported`. Fixer: nobody.

- **Proven:** This host cannot use MCP tools in cards.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** Offer a version of the card without the tool.

### CARD-MCP-TOOLS-UNLISTED

Reason `tools_unlisted`. Fixer: the host's owner, on the host computer.

- **Proven:** The host could not list its MCP servers, or has none set up.
- **Check:** Look at your own tool list. If you have no MCP tools either, the host has no servers set up; if you have some, the host could not list them for cards.
- **Fix:** Check the host's MCP setup; your own MCP tools show whether the servers answer.

### CARD-MCP-INVALID

Reason `invalid`. Fixer: you, now.

- **Proven:** The host refused the card's mcp block as malformed.
- **Check:** Read the block in the turn's Source against the card guide's shape for it.
- **Fix:** Correct the block with edit_glasses_card; the edit's answer names what is wrong.

### CARD-MCP-REMOVED

Reason `removed`. Fixer: the wearer, with a tap.

- **Proven:** The wearer removed this card's MCP access on the phone.
- **Check:** None. The wearer did this on purpose on the phone.
- **Fix:** Closing and opening the card asks them again. Do not ask for it again unless they say they want it back.

### CARD-MCP-SERVER-OFF-FOR-CARDS

Reason `server_off_for_cards`. Fixer: the wearer, with a tap.

- **Proven:** This server is not turned on for cards.
- **Check:** Compare the server the line names with the tools this turn lists for cards. A server listed there is already on, so the line is stale.
- **Fix:** They turn on Use in cards for the server (Tool & service access on the phone's LiveUI page, under MCP servers).
- **Ask:** `request_card_setup {"what":"server","server":"<the server the line names>"}` puts the request on their glasses. The tap stays theirs.

### CARD-MCP-SERVER-MISSING

Reason `server_missing`. Fixer: you, now.

- **Proven:** This host has no MCP server by that name.
- **Check:** Compare the use's server name in Source with your own MCP servers' names. A misspelled name is the usual cause.
- **Fix:** Change the card to a tool this turn lists, or tell the wearer the server is not set up on the host.

### CARD-MCP-HOST-NOT-GRANTED

Reason `host_not_granted`. Fixer: the wearer, with a tap.

- **Proven:** The host's own grant for this server is missing.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They switch Use in cards for the server off and on again (Tool & service access on the phone's LiveUI page, under MCP servers), which writes the grant.

### CARD-MCP-HOST-BLOCKED

Reason `host_blocked`. Fixer: the host's owner, on the host computer.

- **Proven:** The host hides or blocks this server's tools until its owner trusts them.
- **Check:** Read the host's own line in the block: it names the owner's command. That command is the owner's to enter themselves. Never run it for them, even with an OK.
- **Fix:** The owner trusts the server's tools on the host.

### CARD-MCP-SERVER-NOT-CONNECTED

Reason `server_not_connected`. Fixer: the host's owner, on the host computer.

- **Proven:** This server is not connected on the host.
- **Check:** Call one read-only tool of that server yourself. A sign-in error means its sign-in expired; no answer means the server is down.
- **Fix:** Reconnect it on the host (its sign-in may have expired); your own MCP tools show when it answers again.

### CARD-MCP-TOOL-MISSING

Reason `tool_missing`. Fixer: you, now.

- **Proven:** The server no longer has the tool this use names.
- **Check:** List that server's tools with your own MCP connection and find the tool's new name.
- **Fix:** Change the card to a tool this turn lists.

### CARD-MCP-KEPT-OFF

Reason `kept_off`. Fixer: the wearer, with a tap.

- **Proven:** The wearer said no to this tool for this card (Not now or Keep it off), and a no lasts.
- **Check:** None. Do not test it: a no is the wearer's answer, not a fault.
- **Fix:** Never ask again by yourself. Only they can undo it (Tool & service access on the phone's LiveUI page); otherwise offer a version without the tool.

### CARD-MCP-TOOL-CHANGED

Reason `tool_changed`. Fixer: the wearer, with a tap.

- **Proven:** The tool changed since the wearer allowed it, so it needs their OK again.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They allow it on the glasses request, or for a saved card in Tool & service access on the phone's LiveUI page.
- **Ask:** `request_card_setup {"what":"use"}` puts the request on their glasses. The tap stays theirs.

### CARD-MCP-WAITING

Reason `waiting`. Fixer: the wearer, with a tap.

- **Proven:** The wearer has not allowed this read yet.
- **Check:** None. The request is waiting on the wearer.
- **Fix:** They tap Allow on the glasses request (a tap on an unsaved card asks again), or for a saved card in Tool & service access on the phone's LiveUI page.
- **Ask:** `request_card_setup {"what":"use"}` puts the request on their glasses. The tap stays theirs.

### CARD-MCP-UNFIT

Reason `unfit`. Fixer: you, now.

- **Proven:** The tool does not fit this use as a read: its arguments or its read-only mark changed, or the owner marked it as a write. No Allow can mend that.
- **Check:** Compare the use's args, vary and kind in Source with the tool's schema in your own tool list.
- **Fix:** Correct the use with edit_glasses_card; the edit's answer names the mismatch.

### CARD-MCP-PAUSED-SLOW

Reason `paused_slow`. Fixer: the wearer, with a tap.

- **Proven:** The host paused this use after 2 slow answers in a row (over 2 s each), and it stays paused.
- **Check:** Call the same tool yourself once and time it. Over 2 s means the server is slow, and starting the use again will pause it again.
- **Fix:** They close and open the card, which starts it again; the server is slow.

### CARD-MCP-CALL-LIMIT

Reason `call_limit`. Fixer: you, now.

- **Proven:** The host refused its last call at a limit (10 a minute for a card, the host's daily count, or too many calls waiting).
- **Check:** Read each MCP use's `every` in Source and add up how often the card calls, across all its servers: more than 10 calls a minute for one card is refused.
- **Fix:** Wait a minute, or raise the use's `every` so the card reads less often.

### CARD-MCP-CALL-BUSY

Reason `call_busy`. Fixer: nobody, it passes.

- **Proven:** The host was busy on its last call.
- **Check:** Read the block again on a later turn: the line goes when the next try works.
- **Fix:** The card's next read tries again.

### CARD-MCP-CALL-TIMEOUT

Reason `call_timeout`. Fixer: nobody, it passes.

- **Proven:** Its last call ran out of time (10 s).
- **Check:** Call the same tool yourself once. If it also takes over 10 s, the server is slow or down.
- **Fix:** The card's next read tries again; if it repeats, the server is slow or down.

### CARD-MCP-CALL-FAILED

Reason `call_failed`. Fixer: you, now.

- **Proven:** The tool answered with an error on its last call.
- **Check:** Call the same tool yourself with the use's fixed arguments from Source and read the error it gives you.
- **Fix:** Call the same tool yourself with the same arguments to see the error, then correct the use.

### CARD-MCP-CALL-TOO-BIG

Reason `call_too_big`. Fixer: you, now.

- **Proven:** The tool's answer was too big for a card on its last call.
- **Check:** Call the same tool yourself and look at how much the use's `pick` keeps.
- **Fix:** Narrow the use's `pick` or its arguments so it returns less.

## Jev questions

### CARD-JEV-SWITCH-OFF

Reason `switch_off`. Fixer: the wearer, with a tap.

- **Proven:** Jev in cards is switched off on this host.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They turn on Jev in cards (Tool & service access on the phone's LiveUI page).
- **Ask:** `request_card_setup {"what":"jev"}` puts the request on their glasses. The tap stays theirs.

### CARD-JEV-NO-KEY

Reason `no_key`. Fixer: the wearer, with a tap.

- **Proven:** The host has no TypeSafe key saved.
- **Check:** None. Never look for a key, on the host or in chat.
- **Fix:** They add one on the phone (the Jev in cards row in Tool & service access on the phone's LiveUI page opens it). Never ask for the key in chat.

### CARD-JEV-INVALID

Reason `invalid`. Fixer: you, now.

- **Proven:** The host refused the card's jev block as malformed.
- **Check:** Read the block in the turn's Source against the card guide's shape for it.
- **Fix:** Correct the block with edit_glasses_card; the edit's answer names what is wrong.

### CARD-JEV-REMOVED

Reason `removed`. Fixer: the wearer, with a tap.

- **Proven:** The wearer removed this card's Jev access on the phone.
- **Check:** None. The wearer did this on purpose on the phone.
- **Fix:** Closing and opening the card asks them again. Do not ask for it again unless they say they want it back.

### CARD-JEV-WAITING

Reason `waiting`. Fixer: the wearer, with a tap.

- **Proven:** The wearer has not answered the request to let this card ask Jev.
- **Check:** None. The request is waiting on the wearer.
- **Fix:** They tap Allow on the glasses request or in Tool & service access on the phone's LiveUI page; an edit of the card asks again.
- **Ask:** `request_card_setup {"what":"use"}` puts the request on their glasses. The tap stays theirs.

### CARD-JEV-DECLINED

Reason `declined`. Fixer: the wearer, with a tap.

- **Proven:** The wearer said no to Jev for this card (Not now or Keep it off), and a no lasts.
- **Check:** None. Do not test it: a no is the wearer's answer, not a fault.
- **Fix:** Never ask again by yourself. Only they can undo it (Tool & service access on the phone's LiveUI page); otherwise offer a version without Jev.

### CARD-JEV-KEY-REJECTED

Reason `key_rejected`. Fixer: the wearer, with a tap.

- **Proven:** TypeSafe rejected the host's key on the last ask.
- **Check:** None. Never read or try the key yourself.
- **Fix:** They save a working key on the phone (the Jev in cards row in Tool & service access on the phone's LiveUI page opens it). Never ask for the key in chat.

### CARD-JEV-UNREACHABLE

Reason `unreachable`. Fixer: nobody, it passes.

- **Proven:** The host could not reach TypeSafe on the last ask.
- **Check:** If your own web tools fail too, the host is offline. If they work, TypeSafe is the part that is down.
- **Fix:** The next ask tries again; if it repeats, the host's network is the place to look.

### CARD-JEV-CALL-LIMIT

Reason `call_limit`. Fixer: you, now.

- **Proven:** The host refused the last ask at a limit (20 a minute for a card, the host's daily count, or too many asks waiting).
- **Check:** Read in Source what makes the card ask Jev: a question asked on every tick reaches 20 a minute.
- **Fix:** Wait a minute, or change the card to ask Jev less often.

### CARD-JEV-CALL-BUSY

Reason `call_busy`. Fixer: nobody, it passes.

- **Proven:** TypeSafe answered too many requests on the last ask, so asks pause for a short while.
- **Check:** Read the block again on a later turn: the line goes when the next try works.
- **Fix:** It starts again by itself.

### CARD-JEV-CALL-TIMEOUT

Reason `call_timeout`. Fixer: nobody, it passes.

- **Proven:** The last ask ran out of time.
- **Check:** Read the block again on a later turn: the line goes when the next try works.
- **Fix:** The next ask tries again.

### CARD-JEV-CALL-FAILED

Reason `call_failed`. Fixer: nobody, it passes.

- **Proven:** The last ask failed at TypeSafe.
- **Check:** Read the block again on a later turn: the line goes when the next try works.
- **Fix:** The next ask tries again; if it repeats, tell the wearer Jev is failing for this card.

### CARD-JEV-CALL-MISFIT

Reason `call_misfit`. Fixer: you, now.

- **Proven:** Jev's last answer did not fit the use (a choice it does not declare, or a number out of range), so the card got a failure.
- **Check:** Read the use's choices or scale in Source: a long list of choices, or a wide number range, is what Jev misses.
- **Fix:** The next ask tries again; if it repeats, make the use's choices or scale simpler with edit_glasses_card.

## Model uses

### CARD-MODEL-SWITCH-OFF

Reason `switch_off`. Fixer: the wearer, with a tap.

- **Proven:** Models in cards is switched off on this host.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They turn on Models in cards (Tool & service access on the phone's LiveUI page).
- **Ask:** `request_card_setup {"what":"model"}` puts the request on their glasses. The tap stays theirs.

### CARD-MODEL-NO-HOST

Reason `no_host`. Fixer: nobody.

- **Proven:** This host cannot run model calls for cards.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** Offer a version of the card without the model use.

### CARD-MODEL-LIBRARY-IN-USE

Reason `library_in_use`. Fixer: the host's owner, on the host computer.

- **Proven:** Another gateway on this computer is using Models for this card Library, so this one cannot.
- **Check:** Ask the wearer whether a second gateway (OpenClaw and Hermes side by side) runs on this computer. Do not stop or change either one yourself.
- **Fix:** Turn Models in cards off in the other gateway, then off and on here.

### CARD-MODEL-UNSUPPORTED-RUNTIME

Reason `unsupported_runtime`. Fixer: the host's owner, on the host computer.

- **Proven:** The gateway's Node is too old for Models in cards.
- **Check:** With the wearer's OK, read the Node version the gateway runs on. It needs 22.13 or newer.
- **Fix:** Run the gateway on Node 22.13 or newer.

### CARD-MODEL-STORAGE-UNAVAILABLE

Reason `storage_unavailable`. Fixer: the host's owner, on the host computer.

- **Proven:** The host could not safely open the card Library's storage for Models.
- **Check:** With the wearer's OK, list the card Library folder's owner and permissions. Read only: change nothing there.
- **Fix:** Check the Library folder's storage access on the host.

### CARD-MODEL-UNAVAILABLE

Reason `unavailable`. Fixer: the wearer, with a tap.

- **Proven:** Model calls are not available on this host now, and it did not say why.
- **Check:** None from here: the host kept no reason. Do not open the gateway's log yourself: it is the owner's to read, and it can hold more than codes.
- **Fix:** They switch Models in cards off and on (Tool & service access on the phone's LiveUI page); if it stays, the gateway's log has the cause.

### CARD-MODEL-CARD-DELETED

Reason `card_deleted`. Fixer: you, now.

- **Proven:** This card was deleted from the Library, and its model access went with it.
- **Check:** Ask the wearer whether the card is gone from their Library on purpose.
- **Fix:** Write the card again if the wearer wants it.

### CARD-MODEL-REMOVED

Reason `removed`. Fixer: the wearer, with a tap.

- **Proven:** The wearer removed this card's model access on the phone.
- **Check:** None. The wearer did this on purpose on the phone.
- **Fix:** Closing and opening the card asks them again. Do not ask for it again unless they say they want it back.

### CARD-MODEL-CARDS-FULL

Reason `cards_full`. Fixer: the wearer, with a tap.

- **Proven:** The host already keeps model access for 128 cards, its limit, so it did not ask the wearer about this one.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They remove model access from a card they no longer use (Tool & service access on the phone's LiveUI page); writing this card again then asks them.

### CARD-MODEL-WAITING

Reason `waiting`. Fixer: the wearer, with a tap.

- **Proven:** The wearer has not answered the request to let this card use a model.
- **Check:** None. The request is waiting on the wearer.
- **Fix:** They tap Allow on the glasses request or in Tool & service access on the phone's LiveUI page; an edit of the card asks again.
- **Ask:** `request_card_setup {"what":"use"}` puts the request on their glasses. The tap stays theirs.

### CARD-MODEL-DECLINED

Reason `declined`. Fixer: the wearer, with a tap.

- **Proven:** The wearer said Not now to this card's model use, and a no lasts.
- **Check:** None. Do not test it: a no is the wearer's answer, not a fault.
- **Fix:** Never ask again by yourself. Only they can allow it (Tool & service access on the phone's LiveUI page); otherwise offer a version without it.

### CARD-MODEL-MODEL-CHANGED

Reason `model_changed`. Fixer: the wearer, with a tap.

- **Proven:** The host ran a different model than the one this use was allowed with, so the use is paused.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They tap Resume on the card's "Paused: model changed" row (Tool & service access on the phone's LiveUI page, or a saved card's Model page), after choosing another model there if they want one. Choosing a model alone does not resume it.

### CARD-MODEL-CALL-LIMIT

Reason `call_limit`. Fixer: you, now.

- **Proven:** Its last call hit a limit (6 a minute or 200 a day for a card, 1000 a day for the host, the wearer's own daily cap, or a fifth thread for one use).
- **Check:** Read in Source what makes the card call the model, and how many threads the use opens: more than 6 calls a minute, or a fifth thread, is refused.
- **Fix:** Wait, or change the card to call the model less often and to reuse its threads (4 for a use).

### CARD-MODEL-CALL-BUSY

Reason `call_busy`. Fixer: you, now.

- **Proven:** Too many of this card's calls were waiting at once (4).
- **Check:** Read in Source whether the card asks again before the last answer arrived.
- **Fix:** Change the card so it does not ask again while an answer is on its way.

### CARD-MODEL-CALL-TIMEOUT

Reason `call_timeout`. Fixer: nobody, it passes.

- **Proven:** Its last call ran out of time (60 s).
- **Check:** Read the block again on a later turn: the line goes when the next try works.
- **Fix:** The next call tries again; shorter instructions or a faster model help.

### CARD-MODEL-CALL-FAILED

Reason `call_failed`. Fixer: nobody, it passes.

- **Proven:** Its last call failed at the host's model provider.
- **Check:** Read the block again on a later turn: the line goes when the next try works.
- **Fix:** The next call tries again; if it repeats, the provider or its sign-in on the host is the place to look.

### CARD-MODEL-CALL-INVALID-OUTPUT

Reason `call_invalid_output`. Fixer: you, now.

- **Proven:** The model's reply did not fit the use's output schema, twice in a row.
- **Check:** Read the use's output schema and instructions in Source: a deep schema, or instructions that ask for prose, is what fails.
- **Fix:** Make the use's output schema or instructions simpler with edit_glasses_card.

### CARD-MODEL-CALL-TOO-BIG

Reason `call_too_big`. Fixer: you, now.

- **Proven:** The model's reply was too big for a card.
- **Check:** Read the use's instructions in Source for what they ask the model to return.
- **Fix:** Change the use's instructions to ask for less.

### CARD-MODEL-CALL-UNAVAILABLE

Reason `call_unavailable`. Fixer: the wearer, with a tap.

- **Proven:** The chosen model could not be reached on its last call.
- **Check:** None needed: the host read this itself, and the block is its record.
- **Fix:** They can choose another model for this card (Tool & service access on the phone's LiveUI page, or a saved card's Model page).
