# Chat hygiene after an outcome — worked closes

One move per outcome, worked through with good/bad pairs. The parent
[SKILL.md](../SKILL.md) carries the rules (§ *After an outcome: one move per outcome*);
this file is the copy deck.

The failure this exists to kill: after an outcome the agent does **two** things — moves the
surface *and* writes a paragraph describing the move — so the user reads on glass what they
are about to read again in chat, and the surface they were using gets talked over.

---

## The rule in one line

**One outcome → one move.** A surface move, or a one-line chat close, or silence.
Never a surface move plus prose about the surface move.

---

## `selected` — act, don't recap

The user picked something. That pick is the input to your next step; it is not news to report
back to them. Either continue on glass, or close in one line.

**Good — continue on glass, say nothing:**

```js
// User picked "Memory" from the live stats list.
render_glasses_ui({ kind: "text_surface", title: "Memory", body: "…", update: "push" })
// …and end the turn. No chat reply. The child surface IS the answer.
```

**Good — the surface answered the need, close in one line:**

```
Booked the 14:30. 
```

**Bad — the move plus the narration:**

```
I've pushed a detail screen for Memory onto your glasses. It shows used vs total in MB
along with the percentage, and underneath that you'll find the CPU and load figures from
the list you were just on. Let me know if you'd like me to go back.
```

Everything in that paragraph is already on glass or is a restatement of a move the user
watched happen. The `push` was the whole reply.

---

## `back` — re-render, don't apologise

`back` means *revise*, not *error*. Re-render the previous step and stop.

**Good:** nothing, or one `patch` carrying the parent's spec when you need a fresh listen on
it. No chat reply either way.

**Bad:** `"No problem — taking you back to the list of options so you can choose again."`
The user performed the gesture; they know where they are going.

> **The parent is already back up.** A `back` outcome only arrives from inside a stack
> (depth ≥ 2) — at the root the client converts the gesture to `dismissed` — and by the time
> you read it the client has restored the parent and resumed its cron. The one thing the
> parent lacks is an open listen window. Re-render it with `update: "patch"` if you need one;
> `replace` would kill the cron Back just resumed. Details:
> [`authoring-patterns.md`](authoring-patterns.md) § 3.

---

## `dismissed` — silence, or one owed line

**Good:** nothing at all, when the surface was the whole interaction.

**Good:** one line, when you still owe an answer the surface never carried —
`"Left it as-is; the 14:30 is still unconfirmed."`

**Bad:** re-surfacing. `dismissed` at root is a deliberate exit; bouncing a fresh
surface up is the single most annoying thing this skill can teach. You keep the
capability to surface later in the conversation — just not reflexively, and not now.

---

## `window_expired` — nothing is owed

Non-terminal. The listen ended; the paint is still up and still ticking. It is **not** a
paint event, **not** an error, and **not** something the user did.

**Good:** end your turn. Parked taps wake you or ride your next turn.

**Good:** exactly one collect re-render (`update: "patch"`) if you are actively waiting —
then stop. Chaining listens indefinitely is a busy-wait with the user's attention.

**Bad:** `"I didn't hear back from you within the listening window, so the prompt has
expired — would you like me to show it again?"` Nothing expired from the user's side. The
surface they can act on right now is still there, and the message invites them to fix a
non-problem.

---

## `timeout` / `recipe_failed` / `glasses_disconnected` — one line, mechanism named

These are the only outcomes that *earn* a chat line by default, because the surface is gone
or wrong and the user cannot tell why from glass.

**Good:**

```
Stats surface stopped — recipe_failed: getaddrinfo ENOTFOUND api.example.com.
```

`failureReason` verbatim: it is the one fact the user cannot recover themselves.

**Bad:** retrying the render inside the same turn. On `glasses_disconnected` especially —
say it in chat and re-render on the next turn's evidence of reconnect, don't hammer a
disconnected client.

---

## Honest closes: stay at the rung you earned

Every close sits on a rung of the
[delivery ladder](delivery-ladder-phrases.md) (shipped beside this file):

```
authored → validated → send_attempted → client_receipt → wearer_interacted
```

There is no rung above `client_receipt` a machine can earn. A receipt proves the client
reported painting a frame; it proves nothing about a human. The only evidence a person took
a surface in is that the person *did something* — `wearer_interacted` — and that arrives
only when it arrives.

| rung you are on | honest close | the over-claim to avoid |
|---|---|---|
| `send_attempted` | "Sent to your glasses — attempted, unconfirmed." | "It's up on your glasses now." |
| `client_receipt` | "Painted per client receipt." | "You're looking at the list now." / "As you can see…" |
| `wearer_interacted` | "You picked Milk — adding it." | anything upgrading a tap into having read the rest |

The perception verbs are refused **by name** in code: `FORBIDDEN_CLAIM_TERMS` in
`extensions/ocuclaw/src/tools/glasses-ui-delivery-ladder.ts`, each with the honest
substitute attached to the throw. That module is the single list — don't keep a copy in
your head or in copy. If a sentence needs one of those verbs to work, the sentence is
claiming something no evidence supports; delete it.

Two habits that make this automatic:

1. **Write about the mechanism, never the meaning you wish it had.** `lastPaintedAt`, not
   `lastSeenAt`. "attempted, unconfirmed", not "delivered".
2. **When in doubt, write nothing.** Silence over-claims nothing at all, and the surface is
   right there doing the work.

---

## The two product pins, applied to copy

Locked product decisions. They are not style; they change what flows are even possible.

### One voice send per agent turn

A turn commits **at most one** voice send. A trailing endpoint commit inside the **10 s
lockout** is suppressed by design, and the send renders as a bare `•AgentName` with no
"held" label — a suppressed trailing commit is invisible, correct, and not a dropped
message.

- **Don't** author "say that again to confirm" after a `selected`. That needs a second voice
  send in the same turn; it will not arrive.
- **Don't** treat a missing second transcript as a failure or narrate it
  (`"I only caught part of that"`). Suppression is the design.
- **Do** put the second question on a surface (a tap is unlimited), or let it be the *next*
  turn.

### Listening dot on initial entry only

The dot animates on the **first** entry into listening, never on return after a reply
(~500 ms `drain_finalize` suppressed).

- **Don't** write copy that treats the dot as a per-utterance "I'm listening now" indicator.
- **Don't** ask the user whether the dot came back, or offer to "restart listening" because
  it did not animate. Its absence on re-entry is the designed behaviour, not a fault.

---

## Pre-send checklist for any chat reply after an outcome

1. Did I already make a surface move this turn? → then this reply is probably a second move.
   Cut it.
2. Is any sentence restating content that is on glass? → cut it.
3. Does any sentence claim the wearer took the surface in? → rewrite to the rung, or cut it.
4. Is it longer than one line, without carrying a fact the surface cannot hold? → cut it.
5. Am I about to re-surface after `dismissed`, or announce a `window_expired`? → don't.
