# Nine authoring patterns, worked

The parent [SKILL.md](../SKILL.md) carries each rule in a line or two (§ *Nine patterns worth
getting right*); this file is the worked version. Every pattern here is one the audit found
agents getting wrong in practice, not a hypothetical.

Template facts come from [`template-registry.json`](template-registry.json) — entries are
cited as `name@version` and the artifact carries the numbers.

For `paged_text_surface`, one extra choreography rule applies: build the complete bounded
page array first, let the matching normal answer drain, then attach it. Page flips are local
full-content writes; only a deliberate tap returns the visible page to the agent. Never use
partial text offsets or render an incomplete document and patch pages in later.

---

## 1. `patch` sends a whole spec, not a diff

The most expensive misreading in this skill. `patch` does **not** mean "send only what
changed". Every render — `patch`, `replace`, `push` alike — ships the **complete validated
spec** on the wire. What `patch` changes is which *surface* the spec lands on.

The spec is validated **before** the move is even read, so an incomplete patch fails the
same way an incomplete first render does — a list surface without `items` is `missing_field`,
not "the items you had before".

What the two moves actually do to the surface underneath:

| | `patch` | `replace` |
|---|---|---|
| surface id | reused | reused |
| running refresh cron | **kept ticking** | **stopped**, then restarted if this render carries a `refresh` |
| parked-tap queue + `queueMode` | kept | kept (`queueMode` is sticky either way) |
| stack position | unchanged, no new back-target | unchanged, no new back-target |

**`staleAfterMs` is the exception to "sticky".** It is read fresh from every render and resets
to absent when you leave it out — so a collect render that forgets it loses the staleness
guard on the very taps it is collecting. Re-declare it every time.

**Good — a full spec every time:**

```js
// progress_monitor@1: the agent patches its own progress between tool steps.
const phases = ["Cloned OK", "Built OK", "Tests 12/40..."];
render_glasses_ui({
  kind: "text_surface",
  title: "Deploy",                 // resend it — omitting it does not "keep" it
  body: phases.join("\n"),
  update: "patch"
})
```

**Bad — treating it as a field diff:**

```js
render_glasses_ui({ kind: "text_surface", body: "Tests 12/40...", update: "patch" })
// The title is gone from the spec. Do the same on a list surface — drop `items` — and the
// render is rejected outright with `missing_field`, because the spec is validated on its own.
```

**The silent failure worth knowing.** A `patch` sent when the session has no live surface
does **not** error — the store mints a **new root** instead, and your "update" becomes a
brand-new surface at depth 1. The tell is a `surface_attach` lifecycle event carrying
`requestedUpdate: "patch"` with `mode: "root"`. So: patch a surface you can justify believing
is alive (you rendered it, and no terminal outcome came back), and keep its spec so you can
re-render honestly if it is not.

---

## 2. Two pushes, then stop — the breadcrumb budget

There is no stack-depth cap in the engine. There is a **title budget**, and it is what makes
deep stacks useless.

The plugin composes the title from **every titled surface in the live stack**, joined with
`" › "`, and **overwrites** whatever title your spec carried. The joined string is clipped to
the client's title band — roughly 27 characters — by dropping the **oldest ancestor first**
and always keeping the rightmost (current) segment; a single segment that still overflows is
hard-truncated.

So at three levels deep the root segment is already being dropped, and the wearer loses the
trail that was the reason to `push` in the first place.

**Budget it like this:**

- Root + **two** pushes. Past that, `replace` and carry the context in the body.
- Root titles short — `choose_one@1` states the design budget as
  `recommendedTitleMaxChars: 20` for exactly this reason.
- **Never encode state in a title.** `"Step 2 of 4"` will be overwritten by the breadcrumb
  and is invisible by design. State goes in the body.

**Good — a two-push wizard:**

```js
// depth 1 — root
render_glasses_ui({ kind: "list_surface", title: "Trip", items: ["Trains", "Hotels"] })
// depth 2 — push. Breadcrumb becomes "Trip › Hotels"
render_glasses_ui({ kind: "list_with_details_surface", title: "Hotels",
                    items: [/* … */], update: "push" })
// depth 3 — push. Breadcrumb clips to "Hotels › Harbour House"; "Trip" is dropped.
render_glasses_ui({ kind: "text_surface", title: "Harbour House",
                    body: "Quiet. 4 min from the station.", update: "push" })
// STOP. A fourth level shows the wearer nothing about where they are.
```

**A pushed stack does not survive your turn.** The run-call ordinal resets when the agent turn
ends, so the first render of your *next* turn arrives as depth 1 — and a session still holding
pushed children at that moment is reaped as orphan residue (outcome `preempted`, lifecycle
`stale_stack_reaped`). Build a wizard **inside one turn**, or rebuild it from the root when
the next turn starts. Never assume yesterday's depth 3 is still under you.

An `image_caption` render accepts the same breadcrumb under a titled parent. Its optional
heading uses the normal title limits; see [`image-caption.md`](image-caption.md).

---

## 3. `back`: the parent is already up — patch it, don't rebuild it

Two facts settle every `back`, and the second one surprises people.

1. **A `back` outcome only reaches you from *inside* a stack (depth ≥ 2).** At the root there
   is no parent to pop, and the client converts the gesture to `dismissed` before it is ever
   sent. So `back` in your hands always means: a child was popped.
2. **The client has already restored the parent.** It pops, repaints the parent from its own
   cached spec, and resumes the parent's paused cron. You do not re-render to bring it back,
   and re-rendering to "restore" it fights the client.

What the parent does **not** have is an **open listen window** — its pending call was settled
when you pushed the child. If you want a tap on it, that is the one thing you owe.

**The one move:**

```js
// on a `back` outcome — the parent is already on glass.
// If you need a fresh listen (or updated content), re-render it with patch:
render_glasses_ui({ ...parentSpec, update: "patch" });
// If you don't, end the turn. No chat line, no apology, no "taking you back".
```

**Use `patch`, not `replace`, here.** `replace` stops the cron that Back just resumed, so a
live parent goes dead the moment you "restore" it.

Keep the parent's spec around when you push — you need it to re-open that listen:

```js
const specByDepth = new Map();
function renderTracked(spec, depth) { specByDepth.set(depth, spec); return render_glasses_ui(spec); }
```

`back` means *revise*, not *error*: no apology, no narration, and never invent rows the
wearer had in front of them.

---

## 4. A stale tap re-asks — it never executes (`quick_check@1`)

Declare `staleAfterMs` on the render (bounds 1000 – 86400000; outside them the render is
rejected with `stale_after_ms_out_of_bounds`). A parked tap whose `parkedForMs` exceeds it
arrives annotated `stale: true` — per event, not per surface, so one collect can carry a
fresh tap and a stale one side by side.

**The engine annotates; it does not block.** Nothing in the stack refuses a stale tap. The
re-confirm is entirely yours, and skipping it is how a tap from ten minutes ago answers a
question the wearer is not being asked any more.

**It is absent unless you send it, every render.** Omit `staleAfterMs` and the surface has no
staleness guard at all — no `stale` field appears on any delivery. It does not carry over
from the render that created the surface.

The worked template is **`quick_check@1`** — T5 as the owner re-scoped it. Its whole point is
in one line of its registry entry: *a tap is an ANSWER, never an authorization*.

```js
render_glasses_ui({
  kind: "list_surface",
  title: "Rename the playlist to 'Focus Mix'?",
  items: ["Yes", "No", "Tell me more"],
  staleAfterMs: 120000
})
```

**Handling the outcome:**

```js
if (outcome.result === "selected" && outcome.stale) {
  // Do NOT act. Ask the same question again, fresh.
  render_glasses_ui({ kind: "list_surface",
                      title: "Still rename the playlist to 'Focus Mix'?",
                      items: ["Yes", "No"], staleAfterMs: 120000 });
} else if (outcome.result === "selected") {
  // A fresh tap is the wearer's answer — act on it, one move, no narration.
}
```

Three things this template may never carry, per its consent block and the standing B5 lock:

- anything **destructive, chargeable, irreversible, or security-sensitive**;
- the agent host's permission prompts — those never route through a generic
  glasses surface, at any staleness;
- an **expiry** that resolves the question. Expiry parks it, unanswered. Silence is never
  consent, and neither is a window closing.

If the answer you need would authorize something, the surface is the wrong instrument. Ask
in chat, where the authorization path already lives.

---

## 5. The parked-collection loop, and when to stop looping

`window_expired` is non-terminal: the listen ended, the paint is still up, and taps from here
**park**. The loop has exactly three steps and a hard stop.

```
render  →  window_expired  →  ONE collect re-render (update:"patch")  →  end the turn
```

```js
// Checklist: every tap is its own answer, so declare log mode on the creating render.
render_glasses_ui({
  kind: "list_surface", title: "Shopping list",
  items: ["Eggs", "Milk", "Bread", "Coffee"],
  queueMode: "log", timeoutMs: 300000
})

// → { result: "window_expired", surface_still_live: true }
// One collect, then stop:
const collected = render_glasses_ui({ kind: "list_surface", title: "Shopping list",
                                      items: ["Eggs", "Milk", "Bread", "Coffee"],
                                      update: "patch" });

if (collected.mode === "log") {
  for (const event of collected.events) { /* oldest first */ }
} else {
  /* "latest" — a flat outcome, no `mode` key */
}
```

- **Branch on `mode`.** `"log"` gives `{ mode, surfaceUuid, events[] }` oldest-first; the
  default `"latest"` gives a flat outcome with no `mode` key at all.
- **`queueMode` is sticky** — declare it once on the render that creates the surface. A
  `replace` rebuild does not reset it.
- **The log holds 32 taps per surface**, FIFO eviction past that. If a wearer could plausibly
  tap more than that before you collect, collect sooner; do not lean on the cap.
- **Collecting drains.** A delivered tap is cleared from the queue and never arrives twice.
  Act on what you collected in the same turn, or you have lost it.
- **Then end your turn.** Parked taps wake you — one agent turn per real parked gesture,
  refs only, subject to a short cooldown and coalescing — or ride your next turn. Chaining
  listens is a busy-wait paid for with the wearer's attention.
- **A wake is not the wearer speaking.** The wake message is a plugin-generated notification
  carrying `surfaceUuid` + `eventId` refs and nothing else. Its instruction is exactly the
  loop above: re-render that surface with `update: "patch"` to collect.
- **If the surface died before you collected**, the taps are not lost either — they come back
  once as a voicemail line on your next turn's context, marked with how they were reaped and
  whether the surface is still live. Re-confirm before acting on one of those.
- **An empty log is not an answer.** Absence, expiry, and a short log are all silence.

---

## 6. Refresh guard-rails: pick them, don't inherit them

A `refresh` block runs an initial smoke tick **before the surface commits**. If that tick
fails the call resolves `recipe_failed` with a `failureReason` — read it, fix the recipe,
retry once. The surface and its cron only start on a green tick, and **a smoke-tick failure
is terminal whatever `onError` says**: the error policy governs later ticks, never tick one.

The four knobs, code-true:

| knob | default | bounds | what it is for |
|---|---|---|---|
| `intervalMs` | — (required) | 1000 – 3600000 for `http` / `system-stats`; the `llm` tier floors at 30000 | tick cadence |
| `maxDurationMs` | 1800000 (30 min) | 10000 – 7200000 | when the whole surface gives up |
| `maxConsecutiveFailures` | 5 | 1 – 100 | the breaker: N failures in a row ends it |
| `onError` | `keep_last` | `keep_last` \| `show_error` \| `stop` | what a failed tick shows |

Failing ticks also **back off** on their own — the delay doubles per consecutive failure up
to a one-minute cap — so a flapping endpoint slows down before the breaker reaches it. The
backoff does not spend breaker attempts any faster.

**Choose `maxDurationMs` for the wearer, not for the ceiling.** A stats card the wearer
glanced at during a build should die when the build does, not two hours later. A surface that
outlives its usefulness is litter on the only display the wearer has.

**Choose `onError` for what a wrong number would cost:**

- `keep_last` — the default, right for ambient facts. Risk: a frozen value looks live.
- `show_error` — right when a stale number would mislead (prices, capacity, safety).
- `stop` — right when there is nothing useful to show without fresh data. Ends with
  `recipe_failed`.

Codes you may get back, and what each is telling you:

| code | fix |
|---|---|
| `recipe_failed` | the smoke tick, the breaker, or `onError: "stop"`. Read `failureReason` |
| `refresh_interval_too_low` / `refresh_interval_too_high` | `intervalMs` outside its tier's bounds |
| `refresh_duration_too_high` | `maxDurationMs` out of bounds — **the name lies**, it fires for too-small as well as too-large |
| `refresh_invalid_recipe` | malformed recipe, missing `intervalMs`, unknown recipe kind, or a bad `onError` value |
| `refresh_template_invalid` | a `targets` template: unknown filter, bad filter argument, unmatched `{{` / `}}` |
| `refresh_host_consent_required` | the render is held while the wearer may approve the exact site on the phone; the surface starts automatically, so do not retry or tell the wearer to ask again |
| `refresh_host_not_allowed` | the install is `operator-only` with an unlisted host, or the owner denied or removed the host; no retry fixes it |
| `refresh_disabled` | the master or tier switch is explicitly off; no retry fixes it |

---

## 7. Disconnect recovery: say it once, re-render next turn

`glasses_disconnected` is a **drain**: the session's surfaces are resolved with that outcome,
crons stop, and the stack goes to depth 0. Nothing is queued for later delivery, and
**nothing restores itself when the client comes back**.

What to do, in order:

1. **One line in chat, mechanism named.** `"Stats surface stopped — glasses_disconnected."`
   This is one of the few outcomes that earns a chat line, because the wearer cannot tell
   what happened from a HUD that is not there.
2. **Do not retry in the same turn.** Hammering a disconnected client produces nothing but
   noise in the log.
3. **Re-render on the next turn**, once you have real evidence of a live client — an inbound
   event, a fresh request from the wearer — not on a hunch. Rendering into a disconnected
   session fails fast with `glasses_not_connected`, which is a cheap way to find out and a
   noisy way to guess.
4. **Rebuild from scratch when you do.** Whatever `update` you send lands as a new root on an
   empty stack, so re-declare everything the old surface carried: `refresh`, `staleAfterMs`,
   `queueMode`, `title`.

A close cousin is `session_not_viewed`: the client is connected, but the wearer has moved
to another chat since they asked. A new surface for this chat would paint nothing, so the
render is refused before it takes a slot. **Answer in text.** The reply waits in this chat
for when the wearer comes back. Do not retry the render in the same turn. A surface that
is already up is never refused this way, so `patch` and `push` collects keep working.

The same words can also arrive *after* a render went out, as the terminal outcome
`preempted` with `reason: "session_not_viewed"`. That is the phone reporting that it threw
the frame away because it is showing another chat — the refusal above could not see it
coming, because the host's view of which chat the phone is on was a moment behind. Read it
exactly like the refusal: nothing painted, nothing can be dismissed, **answer in text**.

Taps that were parked when the client dropped are not destroyed — they return once as a
voicemail line on a later turn, flagged with the fact that the surface is no longer live.
Treat one of those as a parked answer to a surface that is gone: re-confirm before acting.

Honest phrasing: a disconnect ends the surface, it does not un-earn a rung — termination
and rung are orthogonal. A frame that already earned a receipt stays *"painted per client
receipt"*; a send with no receipt stays *"attempted, unconfirmed"*. What changes is
liveness: the surface is gone either way, and nothing painted before the drop says anything
about what the wearer took in
([`delivery-ladder-phrases.md`](delivery-ladder-phrases.md)).

---

## 8. The ≤6-row rule applies to fake-list kinds

Only fake-list kinds carry this fold. Applying it globally costs you fourteen perfectly good rows.

| kind | renderer | rows |
|---|---|---|
| `list_with_details_surface` | the client's **fake-list** renderer | `visibleRowsBeforeFold: 6` — row 7 exists but is below the fold until the window scrolls |
| `checklist_surface` | the client's **fake-list** renderer | `visibleRowsBeforeFold: 6`; labels must fit one line (roughly ≤64 chars) — tool measures pixels, reports the real limit |
| `list_surface` | the **native SDK list** | `maxItems: 20`, **no 6-row fold** |

So:

- **`compare_options@1`** (rows with detail bodies) — design for six rows. Rank them, and
  put the seventh option somewhere else, because the wearer must scroll to learn it exists.
- **`choose_one@1`** (label-only shortlist) — six is not a rule. Its registry entry says so
  in as many words: *do NOT cap at 6 rows or 30 chars; that is list_with_details only*.

If you find yourself with more than six things that each need a detail body, that is usually
a sign the surface is doing the agent's job: narrow the list before rendering it.

---

## 9. The 30-character label budget

This is specific to `list_with_details_surface`, and it is a **design** budget rather than a rejection:

- `labelMaxChars: 64` — a cheap pre-check. The deciding limit is measured: the tool renders
  the label with the real glasses font and rejects (with the real limit) whatever doesn't fit
  one line.
- `recommendedLabelMaxChars: 30` — the fake-list renderer truncates past this with a
  trailing `…`. The label validates, ships, and arrives unreadable.

**Write the meaning into the first 30 characters and push the rest into the body**, which
gets `detailBodyMaxChars: 200` (again a rough guide — the tool measures pixels and rejects
with the real limit).

**Bad:**

```js
{ label: "09:05 departure with one change at Midford (9 minutes)", body: "41 GBP" }
// → "09:05 departure with one chan…" — the price and the change are both lost
```

**Good:**

```js
{ label: "09:05 · 1 change · 41 GBP",
  body: "Change at Midford, 9 min. Arrives 10:52." }
```

Front-load the thing the wearer is comparing on. Labels are scanned in a row, not read.
`list_surface` items are **not** subject to this. `checklist_surface` labels are **not**
subject to it either — both use the field limit.
