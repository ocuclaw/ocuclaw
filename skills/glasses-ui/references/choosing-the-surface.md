# Choosing the surface — render/don't, which kind, which move

The parent [SKILL.md](../SKILL.md) carries the three decisions in a screen
(§ *Before you render: three decisions, in this order*); this file is the worked version,
good/bad pair by good/bad pair.

Every failure below is one an adherence run actually produced against the registry corpus
(#548 / #1482), not a hypothetical. Template facts are cited as `name@version` and come from
[`template-registry.json`](template-registry.json) — read the entry's `wireKind.name` and
`lifecycle.move` rather than trusting a memory of them.

---

## Decision 1 — should anything go on the display at all?

Read the wearer's own channel choice first: when they name a destination outright — "just
tell me in chat", or "put this on the glasses" — that settles it and nothing below applies.
A bare "show me" names no destination and goes through the checks like anything else.

Otherwise read the turn for four things — **a set they pick from, a value or state they will
look at more than once, something that changes on its own while it sits there, something
visual.** Any one of them present and you render. None of the four and the answer is words,
which go in chat. The sections below work each side of that line.

### 1a. The wearer named chat as the channel

"Just tell me in chat", "no need to put anything on the display", "in chat, not a summary
card" — the wearer chose where the answer goes, so a chat answer is the whole answer.

**Wearer:** "Just tell me in chat: should I pick the 9am or the 11am train?"

**Good:**

```
The 9am. It gets you there with 40 minutes spare; the 11am leaves you 5.
```

The options belong in the sentence, not on glass — the wearer already said where they were
reading the answer.

### 1b. Conversation has nothing to park on glass

Banter, a definition, an opinion, a "what do you think". There is no fact to keep in front of
the wearer and nothing to pick, so a card is litter on the only display they have.

**Bad:** a `text_surface` reading `"Mutex: one holder. Semaphore: N holders."` while the
wearer is walking.
**Good:** answer it in chat, in as many sentences as it takes.

### 1c. Long prose the wearer asked for in chat stays in chat

`text_surface` bodies must fit the 8-line reader (roughly 1000 characters is a rough guide —
the tool measures pixels against the real glasses font and rejects with the real limit) and an
`image_caption` caption must fit one line (roughly 64). An explanation the wearer asked for *in
full* does not survive either. Rendering a summary card and calling it done answers a smaller
question than the one asked.

### 1d. The under-render — the failure that hides as modesty

The opposite miss is quieter and just as wrong: answering in a handful of characters of chat
when the thing asked for was visual.

**Bad:**

```
Sure — here it is.
```

**Good:**

```js
// "Show me the welcome card." — the picture IS the content.
render_glasses_ui({
  kind: "text_surface",
  template: "image_caption",
  body: "Welcome back",
  imageAsset: "hermes_welcome"
})
```

`image_caption@1` exists because chat cannot carry a picture. If the ask names something to
look at — an image, a glyph, a card, a diagram you already hold as a PNG — a text reply is
not a modest answer, it is a missing one. The tell is the pairing, not the length on its own:
a visual ask answered in five characters. A short reply to a short question is fine — this is
the picture going missing, and the display is why they asked.

---

## Decision 2 — which wire kind?

Five kinds reach the wire. The discriminator is **what the wearer does with it**, never how
much content it holds:

| the wearer… | kind |
|---|---|
| reads it; nothing is selectable | `text_surface` |
| moves a highlight through rows, and the label is the whole content | `list_surface` |
| moves a highlight through rows, and each row carries a body they read on landing | `list_with_details_surface` |
| turns through one bounded document page by page | `paged_text_surface` |
| marks several local rows before deliberately closing | `checklist_surface` |

### 2a. A number that ticks is still one thing

The most common kind error in both directions is treating *change* or *multiple lines* as
evidence of a list. Rows exist to land a highlight on, not to group lines of text.

**Bad — a live metric shredded into rows:**

```js
render_glasses_ui({
  kind: "list_surface",
  title: "Host",
  items: ["CPU 47%", "RAM 61%", "Load 1.2"]
})
// Nothing here is selectable. The wearer now has a highlight to move and nothing to move it
// FOR, and every tap is a question you have no answer to.
```

**Good — one body, several lines, ticking:**

```js
render_glasses_ui({
  kind: "text_surface",
  title: "Host",
  body: "CPU —\nRAM —\nLoad —",
  refresh: {
    recipe: { kind: "system-stats" },
    intervalMs: 2000,
    targets: { body: "CPU {{cpuPct | round:0}}%\nRAM {{memUsedPct | round:0}}%\nLoad {{loadAvg1 | round:2}}" }
  }
})
```

`live_metric_card@1`, `ambient_status@1` and `progress_monitor@1` all pin `text_surface` in
the registry, and all three are things that change while they sit there. Refresh is a
property of the body, not a reason to pick a different kind.

### 2b. A question the wearer answers by picking is never a text body

The mirror error. Options written into a body cannot be tapped: there is no answer path back
to you, so the surface asks a question it has no way to hear the answer to.

**Bad:**

```js
render_glasses_ui({
  kind: "text_surface",
  title: "Lunch",
  body: "1. Ramen\n2. Salad bar\n3. The pie place"
})
// The wearer's only moves are back and dismiss. Numbering the lines does not create rows.
```

**Good:**

```js
render_glasses_ui({
  kind: "list_surface",
  title: "Lunch",
  items: ["Ramen", "Salad bar", "The pie place"]
})
```

`choose_one@1`, `quick_check@1` and `drilldown_parent_child@1` all pin `list_surface`.

### 2c. Bare rows or rows with bodies

Once it is a list, one question separates the two list kinds: **can the wearer decide from the
label alone?**

- Yes → `list_surface`. `choose_one@1` is the canonical one, and its entry states that the
  6-row fold and the 30-char label budget do **not** apply to it.
- No, each row needs a sentence → `list_with_details_surface`. `compare_options@1`,
  `message_triage@1`, `morning_agenda@1` and `watchlist_status@1` all pin it. That kind
  really is capped at six visible rows and 30-char labels
  ([`authoring-patterns.md`](authoring-patterns.md) §8, §9).

Detail bodies are for deciding, not for padding: if the label already settles it, the body is
noise the wearer has to scroll past.

### 2d. One long read is pages, not rows

Use `paged_text_surface` for a brief, procedure, or short document whose parts are read in
order. It is not a list: page scrolls stay local and a deliberate tap sends the currently
visible page. Author the complete 1–10 page array up front, each page fitting the 8-line
reader (roughly 600 characters is a rough guide — the tool measures pixels and rejects with
the real limit if a page doesn't fit). The normal answer finishes before the complete surface
attaches; a partial page array must never appear.

### 2e. A reading with a shape is a Graphic — pick the slot by the shape

When the thing to read is numbers the wearer takes in faster as a picture than as a sentence,
use `template: "graphic"` on a `text_surface` (`graphic@1`). You describe one or two typed
slots; the glasses draw them above the caption. The slot follows the **shape of the reading**,
never how impressive it would look:

| the reading is… | slot |
|---|---|
| one number that matters | `metric` |
| a trend over time | `sparkline` |
| a share of a goal | `progress` or `ring` |
| a value against its target | `bullet` |
| a per-hour pattern | `heatstrip` |
| a few facts | `keyvalue` |
| a plain state | `status` with an `icon` |

**Bad — a dial for one number:**

```js
// "How hard is it blowing at the slip? Just the knots."
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "Wind",
  graphic: { slots: [{ type: "gauge", value: 12.5, max: 40, label: "Wind" }] }
})
// A gauge asks the wearer to read a needle against a scale they never asked about, and the
// caption says nothing on a client that cannot draw the plate.
```

**Good — the number, big, with the way it moved; the caption leads with the numbers:**

```js
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "12.5 kt at the slip, up 1.5",
  graphic: { slots: [{ type: "metric", value: "12.5", unit: "kt", label: "Wind", delta: 1.5 }] }
})
```

**The caption is the fallback.** A client without the renderer shows only `body`, as plain
text, so it must carry the reading on its own — numbers first. There is no `title`.

**When it stays text.** A Graphic cannot `refresh`, so a number that must keep updating by
itself is a `text_surface` with a `refresh` recipe (§2a). A set they pick from is a list even
when every row is a number (§2b). An answer that is words — directions, a line to say, a
reason — is a plain `text_surface` body, not a `keyvalue` or `status` slot holding a sentence.
Slot shapes, every repair and rejection code, and the icon names:
[`graphic.md`](graphic.md).

---

## Decision 3 — which move?

`update` is a decision on **every** render, not a default you inherit. Omitting it means
`replace`, which swaps your surface in place **and stops its cron**. A turn in which every
render omits `update` is a turn that replaced its own surface every time — the single most
common adherence failure this skill has measured.

Ask, in order:

1. **Is there a live surface you rendered and have no terminal outcome for?**
   No → this is your first render. `replace` (the default) is correct; nothing more is owed.
2. **Is it about the same thing you are about to show?** → `patch`. Same surface id, the
   parked-tap queue survives, the refresh cron keeps ticking.
3. **Are you opening a child of it the wearer must be able to back out of?** → `push`.
4. **A genuinely different topic, same place, no going back?** → `replace`.
5. **The live surface is done, and what is left belongs in words?** → no further render; end
   the turn with a short text reply.

### 3a. `lifecycle.move: "patch"` means you owe a second render

Every registry entry carries `lifecycle.move`, and it names the template's **characteristic**
render — not merely its first one. **Two** renderable entries pin `patch`, and each one is a
flow, not a frame. `checklist_routine@1` uses a patch only when collecting a close after
its listen ended; local row toggles repaint themselves:

| entry | what the patch is |
|---|---|
| `progress_monitor@1` | the agent patches its own progress **between its own tool steps**, and ends with a final patch plus a one-line close in chat |
| `error_repair@1` | read `failureReason`, correct the spec, patch, retry exactly **once** — the wearer never gets the raw error |
| `checklist_routine@1` | tap only changes the local mark; if the deliberate full-state close parked after expiry, collect it once with `update: "patch"` |

**Bad — the whole template rendered as one frame:**

```js
render_glasses_ui({ kind: "text_surface", title: "Deploy", body: "Starting…" })
// …then the agent does four tool steps in silence and closes in chat.
// The wearer got a card that says "Starting…" and then went stale on their face.
```

**Good — the flow:**

```js
render_glasses_ui({ kind: "text_surface", title: "Deploy", body: "Cloning…" });
// tool step
render_glasses_ui({ kind: "text_surface", title: "Deploy", body: "Cloned OK\nBuilding…", update: "patch" });
// tool step
render_glasses_ui({ kind: "text_surface", title: "Deploy", body: "Cloned OK\nBuilt OK\nTests 12/40…", update: "patch" });
// final
render_glasses_ui({ kind: "text_surface", title: "Deploy", body: "Cloned OK\nBuilt OK\nTests 40/40", update: "patch" });
```

Every one of those carries the **whole** spec — `patch` is not a field diff
([`authoring-patterns.md`](authoring-patterns.md) §1).

### 3b. `lifecycle.move: "push"` means the flow is two renders

`drilldown_parent_child@1` pins `push`, and its intent is *a list whose rows open a deeper
surface the wearer can back out of*. A drilldown that renders one surface and stops is just a
list.

**Bad:**

```js
render_glasses_ui({ kind: "text_surface", title: "Repos", body: "api, web, infra — which one?" })
```

Wrong on both decisions at once: a pick rendered as prose (§2b), and no child to open.

**Good:**

```js
render_glasses_ui({ kind: "list_surface", title: "Repos", items: ["api", "web", "infra"] });
// → { result: "selected", selected_index: 1, selected_text: "web" }
render_glasses_ui({
  kind: "text_surface",
  title: "web",
  body: "Last deploy 14:02. 3 open PRs. CI green.",
  update: "push"
});
// Back restores the parent and resumes its cron. And the entry's own hard rule:
// NEVER replace at depth >= 2 — that destroys the back stack the wearer is relying on.
```

### 3c. The collect re-render is always `patch`

One mechanical case with no judgement in it. After `window_expired` the surface is still
live; the single collect re-render carries `update: "patch"`. Omitting it replaces the live
surface and stops the very cron you were collecting from
([`authoring-patterns.md`](authoring-patterns.md) §5).

```js
// → { result: "window_expired", surface_still_live: true }
render_glasses_ui({ ...sameSpec, update: "patch" });   // then end the turn
```

`back` is the same shape for the same reason: the client has already restored the parent, so
a fresh listen on it is `patch`, never `replace` ([`authoring-patterns.md`](authoring-patterns.md) §3).

---

## The three decisions, in one block

```
1. Display at all?   wearer named a dest.    -> that one; the four don't apply
                     pick / re-read value /  -> render
                     changes on its own /
                     visual                     (any ONE of the four)
                     none of the four        -> chat (banter, long prose)
2. Which kind?       nothing selectable      -> text_surface       (ticking is still text)
                     rows, label is enough   -> list_surface
                     rows needing a sentence -> list_with_details_surface
3. Which move?       no live surface         -> replace (the default)
                     same thing, still live  -> patch  (cron keeps ticking)
                     child, backable         -> push
                     new topic, same place   -> replace
                     live surface done, rest -> no further render; close in chat
                       is words
```

Whatever the surface does, the close stays at the rung the evidence earned —
"attempted, unconfirmed" until a receipt, and only a gesture is a wearer acting
([`delivery-ladder-phrases.md`](delivery-ladder-phrases.md)). Choosing the right surface
never upgrades what you may claim about it.
