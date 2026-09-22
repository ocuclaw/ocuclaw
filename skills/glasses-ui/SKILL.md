---
name: glasses-ui
description: Deciding whether a turn belongs on the wearer's Even G2 HUD instead of in chat — and authoring the render_glasses_ui spec once it does. Load when a turn might belong on the glasses, when the situation is not obviously one of the usual ones, or BEFORE building any live/refreshing surface, per-item detail list, or multi-screen flow. Covers the three decisions every render makes (render at all / which wire kind / which move), the moments that earn a surface and the ones that belong in chat, the list vs list_with_details boundary, the capability-tier ladder (system-stats host metrics, http data, llm summaries), the patch/replace/push moves and exit-to-chat policy, recipe recon, and worked exemplars.
user-invocable: false
---

# Authoring glasses surfaces with `render_glasses_ui`

`render_glasses_ui` paints an interactive surface on the user's Even G2 HUD instead of a text reply. Think in two verbs: the render **paints** (the surface lives on glass, ticking, until the user exits or its refresh budget ends) and the call carries **one one-shot listen** (a bounded window in which a tap resolves your call live). The paint outlives the listen by design. This skill covers both halves of the job — **deciding** whether a turn belongs on the glass at all, and **authoring** the spec once it does; the tool description is deliberately lean.

## Unsure? `validateOnly: true`

Send the spec once with `validateOnly: true`. It validates and lints without rendering — nothing is created, nothing is sent — and returns `{result: "validated", ok, errors, warnings, normalizedSpec, template, layout}`, where `layout` gives you the fold position and any truncation points. Fix the errors, read the warnings, then send it for real.

## Before you author: is the tool loaded?

Check the effective tool list for this conversation before diagnosing availability.
Search deferred tools by exact name when the host supports tool search. The plugin
provides `render_glasses_ui`, `get_glasses_ui_state`, `manage_liveui_templates`, and
`manage_liveui_tasks`; reading this skill alone does not prove they are callable.

If a tool is missing, identify the backend before choosing recovery:

- **OpenClaw:** check plugin load status and effective tool policy. If policy is
  excluding a loaded OcuClaw plugin, merge `"ocuclaw"` into `tools.alsoAllow`
  while preserving existing entries. Use the supported setup flow for the
  configuration change and gateway restart; confirm the tool is offered afterward.
- **Hermes:** tools register automatically after the OcuClaw runtime connects.
  Check the plugin/runtime state and the effective `ocuclaw` toolset for this
  platform. Calls require an OcuClaw phone/glasses session; an unrelated Desktop
  or CLI conversation does not establish that context. Use `/ocuclaw-setup` for
  installation or connection recovery and Hermes tool settings for an explicitly
  disabled toolset. OpenClaw configuration commands do not apply.

If a call returns an argument, validation, or approval error, the tool was reached.
Read its structured result and correct the named problem; do not report that the
tools are unavailable or invent scripts/config edits to bypass the failure. A task
is saved only when its operation confirms persistence. A pending Draft still needs
phone approval before it is runnable; an empty runnable-task search does not prove
the Library is down. Report the exact unresolved error when recovery cannot be
verified.

## Before you render: three decisions, in this order

Every render is three decisions. Make them **explicitly, in this order, before you compose a
spec** — an adherence run against the registry corpus found each one silently skipped, and
the skip is what produced the wrong surface every time.

### 1. Should anything go on the display at all?

The HUD is the only display the wearer has and it sits on their face.

**First: did the wearer name where the answer goes?** It cuts both ways — "just tell me in
chat", "no need to render this one", or "put this on the glasses", "on the display, not in
chat". When they have named a destination, that is the answer and the triggers below do not
come into it. Only an unmistakable one counts: a bare "show me" or "put it up" names no
destination, so it goes through the four below like anything else.

**Otherwise, read the turn for these four things. Any one of them present → render:**

1. **A set they pick from** — a choice, a shortlist, rows to triage.
2. **A value or state they will look at more than once** — a number, a status, the next
   step, something they re-read while their hands are busy.
3. **Something that changes on its own while it sits there** — a job advancing, a metric
   ticking.
4. **Something visual** — the ask names a picture, an image, a glyph, a card. Chat cannot
   carry it; that is `image_caption@1`, and a one-line chat reply instead is not a modest
   answer, it is a missing one.

**None of the four → the answer is words, and words go in chat.** Two asks that reliably
carry none of them:

- **conversation** — banter, a definition, an opinion. Nothing to park on glass.
- **long prose they asked for in full** — it will not fit the reader (roughly 1000 chars on a
  body, 64 on a caption; the tool measures pixels against the real glasses font and tells you
  the actual limit) and mutilates it.

The tell that you missed trigger 4 rather than cleared it: the ask was for something to look
at and your whole reply is "Sure — here it is". Brevity is not itself a trigger; a short
answer to a short question is a fine chat reply. But five characters answering *show me the
welcome card* is the picture gone missing, and the display is why they asked.

**The error runs both ways, and only one direction is loud.** Rendering something that
belonged in chat is visible — the wearer dismisses it and says so. Answering in chat when the
glass would have served is silent: they just reach for their phone, and you never hear about
it. Do not read the quiet as agreement.

**These examples are non-exhaustive. There is no approved list of situations. No matching row
is not a refusal — if the glass earns its place, render it.** The wire kinds and the three
moves are the whole vocabulary and that vocabulary is closed; the occasions are open, and the
wearer supplies most of them. Sixteen worked moments, four of which correctly render nothing and
four of which no template covers → [`references/exemplars.md`](references/exemplars.md). One
line per written-down situation → [`references/intent-index.md`](references/intent-index.md).

### 2. Which wire kind?

The discriminator is **what the wearer does with it**, never how much content it holds:

| the wearer… | kind |
|---|---|
| reads it; nothing is selectable | `text_surface` |
| moves a highlight through rows, and the label is the whole content | `list_surface` |
| moves a highlight through rows, and each row carries a body they read on landing | `list_with_details_surface` |
| turns through a bounded document one page at a time | `paged_text_surface` |
| marks several local rows before deliberately closing | `checklist_surface` |

Two reflexes to fight, both of which the adherence board caught in the wild:

- **A number that ticks is still one thing.** Refresh does not make a list, and neither do
  multiple lines — put `\n` in the body. `live_metric_card@1`, `ambient_status@1` and
  `progress_monitor@1` all pin `text_surface` in the registry, and all three change while
  they sit there. Rows exist to land a highlight on, not to group lines.
- **A question they answer by picking is never a text body.** Options written into a body
  cannot be tapped — there is no answer path back to you, so the surface asks a question it
  cannot hear the answer to. Numbering the lines does not create rows. **And do not resolve
  the choice yourself and paint the answer**: picking one option and rendering it as prose is
  the same failure wearing a decision. This is the one *growing* error class — the last
  adherence board measured `list → text` rising while every other kind error fell or held
  flat — so treat the reflex as live, not historical. `choose_one@1`, `quick_check@1` and `drilldown_parent_child@1` all
  default to `list_surface`.

#### The list vs `list_with_details` boundary — the one kind error worth a rule

**Default `list_surface`.** Reach for `list_with_details_surface` only when one of these
holds:

1. **The wearer supplied criteria that discriminate *between the rows*** — a constraint, a
   deadline, a preference that makes some rows better than others. "Whatever looks good" is
   the absence of a criterion, not a quiet one. A criterion every row satisfies equally
   discriminates nothing and buys no details.
2. **The consequence of picking differs materially per row**, and that difference is what
   they asked about.

**Judge both from the wearer's ask, never from the call you are about to emit.** Inventing
richer rows and then pointing at them as evidence the rows needed bodies is circular — the
override is licensed by the question, not by the answer.

**The detail body must carry the reason to pick *that* row, in the wearer's own terms.** A
description of the row is not a detail body: "Renaissance galleries, 40 rooms" describes;
"fits the 90 minutes you have, and it is the wing you missed" decides. If the bodies do not
mention the thing the wearer said they cared about, you picked the wrong kind.

**Whenever the details kind is chosen, `detailBodyMaxChars` is 200 and it is mandatory** — a
rough guide; the tool measures pixels against the real glasses font and rejects with the real limit.
Labels must fit one line (roughly ≤64), bodies must fit the 4-line detail reader (roughly
≤200), all bodies ≤ 6144 in one call. A details surface whose bodies have no stated budget is
a details surface that will fail the fit gate.

Worked pair: `pick-one-walking` (no criteria → `list_surface`) and `pick-one-with-criteria`
(legs yesterday, home by half nine → `list_with_details_surface`) in
[`references/exemplars.md`](references/exemplars.md).

Authoring a named template? Its registry entry carries a **default** kind in `wireKind.name`
and it is worth citing — but the wearer's ask outranks it. A row is a written-down situation
with the shape that worked, not a fence: if this turn is genuinely a different situation
wearing the same name, make the three decisions from the turn and render what fits.

### 3. Which move?

**`update` is a decision on every render, not a default you inherit.** Omitting it means
`replace`, which swaps your surface in place *and stops its cron*. A turn in which every
render omits `update` is a turn that replaced its own surface every time — the single most
common adherence failure this skill has measured. Ask, in order:

1. **A live surface you rendered, with no terminal outcome yet?** No → first render;
   `replace` (the default) is correct and nothing more is owed.
2. **Is it about the same thing you are about to show?** → `patch`.
3. **Opening a child of it they must be able to back out of?** → `push`.
4. **A genuinely different topic, same place, no going back?** → `replace`.
5. **The live surface is done, and what is left belongs in words?** → no further render;
   close in chat.

**A move expectation is part of the template.** `lifecycle.move` on a registry entry names
the template's *characteristic* render, not merely its first one:

- **`patch` means you owe a second render.** The two renderable entries that pin it:
  `progress_monitor@1` patches between your own tool steps and ends with a final patch;
  `error_repair@1` reads `failureReason`, fixes the spec and patches the one retry.
  `checklist_routine@1` pins `patch` only for a collect after its listen closes; local
  row toggles repaint themselves. One render and stop is not the template when a collect
  is actually owed.
- **Agent `push` means the flow is two renders.** `drilldown_parent_child@1` is a parent list *and*
  the child pushed from it; a drilldown that never pushes is just a list. Its entry carries
  the hard rule: **never `replace` at depth ≥ 2** — that destroys the back stack.
  For known reading details, `drilldown_parent_child@2` carries children in one parent
  render; tap pushes locally. See pattern 3 below before choosing the round trip.
- One case with no judgement in it: the collect re-render after `window_expired`, and the
  re-render after `back`, are **always `patch`**. Omitting `update` there replaces a live
  surface and stops the cron you were collecting from.

> **Worked good/bad pairs for all three decisions** — the four render triggers and the asks
> that carry none of them, the ticking metric shredded into rows, the pick rendered as prose,
> the progress card that
> went stale after one frame →
> [`references/choosing-the-surface.md`](references/choosing-the-surface.md).

## Surface kinds

| kind | use it for | caps |
|---|---|---|
| `text_surface` | one formatted read-only block | body must fit the 8-line reader (roughly ≤1000 chars); optional `title` must fit one line (roughly ≤64) — tool measures pixels, reports the real limit |
| `list_surface` | a short pickable list, label-only | ≤ 20 items, each must fit one line (roughly ≤64 chars) — tool measures pixels, reports the real limit |
| `list_with_details_surface` | a pickable list where each item carries a detail body shown as the user scrolls | label must fit one line (roughly ≤64), body must fit the 4-line detail reader (roughly ≤200); total of all bodies ≤ 6144 — tool measures pixels, reports the real limit |
| `checklist_surface` | client-local marks; tap toggles, double-tap closes with full state | 1–20 items; label must fit one line (roughly ≤64 chars) — tool measures pixels, reports the real limit; `checked` boolean; `queueMode: "log"` required |
| `paged_text_surface` | a short document read page by page; boundary scrolls flip locally, tap returns the current page | 1–10 pages, each must fit the 8-line reader (roughly ≤600 chars); optional `title` must fit one line (roughly ≤64) — tool measures pixels, reports the real limit |

`list_with_details` items are `{ label, body }` objects (`label` required, `body` optional). A bare string is treated as a label-only item. Use it when each option needs a 1–2 sentence compare-before-choosing detail — all bodies ship in one call, so the user browses with zero round-trips.

## Name the pattern if one fits — the template registry

[`references/template-registry.json`](references/template-registry.json) is a table of
**citable defaults and the scoring rubric** — never a list of permitted occasions. One entry
per `name@version`, each carrying its intent, closed field set, measured layout budgets,
lifecycle, consent posture, and a synthetic worked example. Two jobs, and only two:

1. **Citable defaults.** When a row matches the turn, cite it and start from its shape — the
   kind that worked, the move it owes, the rule that bites. It saves you re-deriving a
   decision someone already made carefully.
2. **The scoring rubric.** The adherence harness grades what you sent against these rows.
   Nothing in the runtime checks them: no `templateId` reaches the wire, and no render is
   rejected for being off-registry. Enforcement is measurement after the fact, by design.

**What it is not: the set of situations allowed on the glass.** The rows are the ones someone
happened to write down. If the turn in front of you is not one of them and the glass earns
its place, render it out of the same vocabulary — that is the whole point of having a closed
vocabulary and an open occasion list.

The one-line-per-row map is [`references/intent-index.md`](references/intent-index.md)
(generated; ~1.2k tokens for all 31, so "is this a written-down situation?" is a cheap
question). Budgets and field sets stay in the JSON — this skill points at entry **names** and
deliberately does not restate their numbers, because a second copy of a number is a number
that drifts.

Two flags decide whether an entry is something you can actually render:

- `renderableToday: false` — the entry exists so the intent is written down and reviewable.
  It is not a thing you can send. `lane: "kinds_licensed"` means it needs a wire kind that
  does not exist yet (hard-gated behind Gate F3).
- `renderableToday: true` — it rides a shipping kind. Author it now.

**Four near-duplicate names were reconciled (#542). Use the right-hand name:**

| you may have in mind | author this | why |
|---|---|---|
| `safe_deadline@1` | `deadline_with_safe_default@1` | same template — the research corpus's shorter spelling. Nothing distinguishes them but the name |
| `compare_and_choose@1` | `compare_options@1` | same template — the experience prototype's name for it. A **label-only shortlist** with no detail bodies is a different template: `choose_one@1` |
| `walking_brief@1` | `paged_briefing@1` | same template, told through a use case. Neither renders until Gate F3 licenses `paged_text_surface` |
| `progress_watch@2` | `progress_monitor@1` | same template — ruled 2026-08-19 (#1415): a progress template may never start a turn without a wearer gesture, so nothing distinguishes them but the corpus spelling. The display may keep updating; completion parks until a tap |

## Capability tiers — pick the lowest tier that answers the need

The refresh recipe runs at a capability tier. **Always pick the lowest tier that answers the need.**

- **L0 — `http` (data APIs).** In-process, SSRF-guarded fetch → template → surface. Timer HTTP is on by default. Under the default `httpHostPolicy: "owner-grants"`, render the card normally: an unlisted public host returns `refresh_host_consent_required`, the render waits, the wearer may approve that exact site on the phone, and the surface starts automatically. This code is a consent hold, not an error to retry; never tell the wearer to ask again. `refresh_host_not_allowed` means the install is `operator-only` with an unlisted host, or the owner denied or removed that host. A non-HTTP(S) scheme or empty host is `refresh_invalid_recipe`. Operator `httpAllowHosts` entries still allow exact hosts or `.suffix` domain patterns; an explicit `httpEnabled: false` remains a hard off.
- **L0′ — `system-stats` (host metrics).** Built-in, in-process `node:os` reader (RAM/CPU/load). Governed only by the master `glassesUiLive.enabled` (on by default). Reach for it for anything host-metric.
- **Model — `llm` (one-line summaries).** Timer model calls are on when the host has a supported model provider; use them only when deterministic data is not enough. `prompt` and `systemPrompt` are each capped at 4096 characters. An agent-authored `systemPrompt` augments rather than replaces the Engine's display framing: the Engine always appends its “single short line, maximum N characters” clause. The tick sees only the agent prompt, the agent-authored seed body, and its own previous output; it cannot chain an `http` or `system-stats` result into the model call. The hard shape is a 30000 ms interval floor, a 7200000 ms (2 h) duration cap, a 200-output-token host ceiling by default, and at most 4 concurrent surfaces per host. An explicit `llmEnabled: false` or a host with no supported model backend keeps this tier off.
- **Reasoning / judgment tier (`agent`, L1/L2) — designed, not yet available.** A future tier where a sandboxed subagent interprets a page or local files on a timer. It is design-gated (credential-isolation + containment spike) and **not built** — there is no `agent` recipe kind. For a surface that needs interpretation *right now*, render it **once from your own turn** (compose the content yourself, render a static `text_surface`/list). A *self-refreshing* reasoning surface needs an agent in the loop, which isn't wired yet; a live reasoning tier is coming.

> **Authoring an `http` refresh? Read
> [`references/http-recipe-cookbook.md`](references/http-recipe-cookbook.md) first.**
> Three code-true worked recipes — Open-Meteo weather (no key), GitHub Actions CI status
> (with the auth handling spelled out), Home Assistant (with the SSRF-guard tension
> stated honestly) — plus the real field/cadence bounds, the failure semantics, two known
> gaps, and a pre-flight checklist. Its companion
> [`references/http-recipe-field-sets.json`](references/http-recipe-field-sets.json)
> carries the per-recipe known-field sets in machine-consumable form.

### `system-stats` output fields (the `{{path}}` sources)

`memTotalMb`, `memUsedMb`, `memFreeMb`, `memUsedPct`, `cpuPct`, `loadAvg1`. Optional recipe param `sampleWindowMs` (50–1000, default 200) sizes the CPU-sample window.

## The four moves

`render_glasses_ui` takes an optional `update` telling it how this render relates to the current surface. **Default is `replace`.**

| move | what it does | when |
|---|---|---|
| `patch` | edit *some fields* of the current screen; the refresh cron **keeps ticking** | a partial in-place edit |
| `replace` *(default)* | swap the *whole content* of the current screen in place; **no back-target** | new content, no going back |
| `push` | stack a *new child screen*; the parent is retained and **its cron pauses** (resumes on Back) | new content, the user can go back |
| exit to chat | *not a param* — just end your turn with a short text reply; the chat screen takes over and the surface disappears | you're done; respond in chat |

**One-line rule:** partial edit → `patch`; new content, no going back → `replace`; new content, can go back → `push`; done → exit to chat.

The table above is the **mechanics**; the ordered questions that pick between them are decision
3 in § *Before you render: three decisions, in this order*. `update` is chosen on every render
— a whole turn of `update`-less renders is a whole turn of replacing your own surface.

**Exit-to-chat policy:** on a *deliberate* exit (the user backs past the root, or you're finished), the default is to **respond in chat and not reflexively re-surface**. You retain the capability to surface again later in the conversation — just don't bounce a new surface up reflexively. On an *in-stack* Back (depth ≥ 2), the client transparently restores the parent and its cron resumes; you don't need to re-render it.

> **Don't preempt yourself.** Omitting `update` means `replace` — it swaps your current surface in place. To drill into a detail *without losing the list*, use `push`. (Back restores the parent **surface**, its scroll position and highlighted row, and resumes its cron — but not its listen window. See § *Nine patterns worth getting right* → back.)

## Live refresh: recipe recon (validate-then-commit)

Add a `refresh` block to make a surface self-update: `{ recipe, intervalMs, targets, onError?, maxDurationMs?, maxConsecutiveFailures? }`. `intervalMs` ≥ 1000.

When you submit a render carrying `refresh`, the plugin runs an **initial smoke-test tick before the surface commits**. If that tick fails, the call resolves with `result: "recipe_failed"` and a `failureReason` string — **read it, fix the recipe, and retry**; the surface and cron only start on success. This is your recon loop: don't guess twice, read the failure.

`targets` maps recipe output → display:
- `targets.body` — a string template for `text_surface`.
- `targets.items` — an array of templates for list surfaces; each entry is either a string (label-only) or `{ label, body }`. The **whole array** is emitted each tick. **Labels are templated too**, so keep static labels as plain literals (no `{{…}}`) — only put `{{…}}` in the parts that should change.
- `targets.itemsFromPath` + `targets.itemTemplate` — map one recipe-output array onto an existing `list_surface` or `list_with_details_surface`. The path must end in `[]` (for example `$.results[]`). Source order is preserved; output is deterministically clamped to 20 rows and 6,144 UTF-8 bytes. This is replacement only: there is no implicit pagination or load-more turn.

### Template filters

`{{path}}` reads a value (`{{output}}` for the raw recipe output). Chain filters left-to-right:

`trim` · `upper` · `lower` · `int` · `round:N` · `percent` (×100, append %) · `truncate:N` · `default:"--"` · `prefix:"+"` · `minus:previous.value` · `plus:previous.value`. Use `previous.*` paths for deltas vs the prior tick.

## Worked examples

### 1. Live host stats — `system-stats` text_surface (runs today)

```js
render_glasses_ui({
  kind: "text_surface",
  title: "Host",
  body: "RAM —  CPU —",
  refresh: {
    recipe: { kind: "system-stats" },
    intervalMs: 2000,
    targets: { body: "RAM {{memUsedPct | round:0}}%  CPU {{cpuPct | round:0}}%  Load {{loadAvg1 | round:2}}" }
  }
})
```

### 2. Live host stats — `system-stats` list_with_details (the canonical interactive example, runs today)

```js
render_glasses_ui({
  kind: "list_with_details_surface",
  items: [
    { label: "Memory", body: "—" },
    { label: "CPU",    body: "—" },
    { label: "Load",   body: "—" }
  ],
  refresh: {
    recipe: { kind: "system-stats" },
    intervalMs: 2000,
    targets: {
      items: [
        { label: "Memory", body: "{{memUsedMb}} / {{memTotalMb}} MB ({{memUsedPct | round:0}}%)" },
        { label: "CPU",    body: "{{cpuPct | round:1}}% busy" },
        { label: "Load",   body: "{{loadAvg1 | round:2}} (1-min avg)" }
      ]
    }
  }
})
// Labels are static literals (don't re-render); bodies tick every 2s.
```

### 3. Reading drill-down: preload or agent `push`

**Preload known reading details** with `drilldown_parent_child@2`: release notes or
other full text the wearer wants to open from a short list (≤8 rows, ≤3 pages per
child). Send `children` parallel to `items`, using `text_surface` or
`paged_text_surface`, and `null` for rows without ready details. Keep the total child
payload within 8192 characters and each page within the fit gate. Leave label space
for the automatic ` ›` cue. Tap opens locally; Back repaints the parent without an
agent turn. Do not send a second render just to open a preloaded child.

**Keep selection questions selectable.** “Which one should I pick?” and questions
the wearer answers by picking use rows without children: opening a reading page is
not an answer. Use inline comparison bodies when the choice needs short criteria.

**Fetch on demand** with `drilldown_parent_child@1` when detail needs a tool call or
fresh data at selection time; then render the fetched child with `update: "push"`.
Refreshing lists cannot carry children. For large lists (such as 20 rows), preload
at most eight useful top rows within the shared budget, with `null` elsewhere, or
omit children and fetch details on demand. Never pack every long page into a render
and rely on a cap rejection to trim it.

```js
render_glasses_ui({
  kind: "list_surface", title: "Release notes",
  items: ["Instant details", "Back navigation"],
  children: [
    { kind: "text_surface", body: "Ready details open immediately when tapped." },
    { kind: "paged_text_surface", pages: ["Back restores the list.", "Keep browsing from the previous row."] }
  ]
})
```

Agent round trip for fresh detail:

```js
// User highlights "Memory" and asks for detail → stack a child, keep the live list underneath.
render_glasses_ui({
  kind: "text_surface",
  title: "Memory detail",
  body: "Used … of … MB …",   // compose from what you know, or give the child its own system-stats refresh
  update: "push"
})
// The parent list's cron pauses while the child is up; on Back it staleness-resumes.
```

### 4. `http` data (phone host consent)

```js
// L0 http — DATA APIs. On an unlisted public host, the render waits while the
// wearer approves the exact site on the phone, then starts automatically.
render_glasses_ui({
  kind: "text_surface",
  title: "AAPL",
  body: "—",
  refresh: {
    recipe: { kind: "http", url: "https://api.example.com/quote/AAPL", jsonPath: "$.data" },
    intervalMs: 30000,
    targets: { body: "AAPL {{price}} ({{change | round:1 | prefix:\"+\"}})" }
  }
})
```

### 5. `llm` one-line summary

```js
render_glasses_ui({
  kind: "text_surface",
  title: "Build pulse",
  body: "Waiting for the first summary",
  refresh: {
    recipe: {
      kind: "llm",
      prompt: "Summarize the current build state in one plain line."
    },
    intervalMs: 60000,
    maxDurationMs: 1800000,
    targets: { body: "{{output}}" }
  }
})
// The first tick sees the prompt plus the seed body; later ticks also see their own
// previous output. The Engine always appends the short display-line instruction.
```

## `image_caption` — the one template that reaches the wire

`template: "image_caption"` on a `text_surface` paints one small greyscale image with a
balanced caption under it, with an optional plain heading. It is one of the two values the `template` field accepts
today (the other is `graphic`, next section) — registry entry `image_caption@1`, `status: "shipped"`,
`renderableToday: true`.

```js
render_glasses_ui({
  kind: "text_surface",
  template: "image_caption",
  body: "Welcome back",           // the caption — and the whole fallback on 2.0.0 clients
  imageAsset: "hermes_welcome"
})
```

- **One-shot, not live.** No `refresh` (`image_caption_refresh_unsupported`) or items.
  Re-render to change the picture. An optional `title` uses the shared heading and its
  normal character and measured-width limits; omit it for a titleless card.
- **One image source.** `imageAsset` **or** the inline trio `imageBase64` + `imageWidth` +
  `imageHeight`; both or neither is `image_source_invalid`. Raw standard base64, **no
  `data:` prefix**, and the declared dimensions must equal the PNG's own IHDR dimensions
  (`image_format_invalid` otherwise).
- **The budgets live in the registry entry**, not here: `image_caption@1` →
  `layoutBudgets.budgets` gives `captionMaxChars`, `imageMinWidthPx`/`imageMaxWidthPx`,
  `imageMinHeightPx`/`imageMaxHeightPx`, `imageMaxDecodedBytes`, `imageMaxBase64Chars`.
  Dimensions have **minimums as well as maximums** — undersized is `image_dimensions_invalid`.
- **Normal navigation applies.** Image cards accept the navigation breadcrumb under a
  titled parent. Use `push` to keep that parent available for Back, or `replace` to update
  the current surface.

> Both variants worked through, the full rejection-code table, and the decoded-vs-base64
> size trap → [`references/image-caption.md`](references/image-caption.md).

## `graphic` — a reading with a shape, drawn from typed slots

`template: "graphic"` on a `text_surface` draws one or two typed **slots** on the image plate
with the caption line under it — registry entry `graphic@1`, `status: "shipped"`,
`renderableToday: true`. You describe what the reading is; the client draws it. You never
send pixels, paths, coordinates or sizes.

```js
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "12.5 kt at the slip, up 1.5",   // the caption — and the whole fallback, numbers first
  graphic: {
    slots: [
      { type: "metric", value: "12.5", unit: "kt", label: "Wind", delta: 1.5 },
      { type: "sparkline", values: [9, 11, 10, 12.5], label: "Last hour" }
    ]
  }
})
```

**Pick the slot by the shape of the reading:**

| the reading is… | slot |
|---|---|
| one number that matters | `metric` (`value` is text, e.g. `"12.5"`) |
| a trend over time | `sparkline` |
| a share of a goal | `progress` or `ring` (`value` a number, fraction `0..1`) |
| a value against its target | `bullet` |
| a per-hour pattern | `heatstrip` |
| a few facts | `keyvalue` |
| a plain state | `status` with an `icon` |

- **One or two slots, no `title`** (`graphic_title_unsupported`), **no `refresh`**
  (`graphic_refresh_unsupported`).
- **`body` is required and is the fallback.** A client without the renderer shows only the
  caption, so it carries the reading in words, numbers first.
- **Stays text when:** it must keep updating by itself (use a `refresh` recipe), the wearer
  picks from it (a list), or the answer is words.
- **Repairs, not rejects.** Slightly-wrong slots are repaired and the ok result lists each in
  `repairs` (`text_truncated`, `percent_read_as_fraction`, `icon_dropped`, …). Send a cleaner
  spec next time. An unknown slot type is `graphic_slot_type_unknown` with the nearest name.
- **Icons** come from the closed list in
  [`references/graphic-icons.md`](references/graphic-icons.md); an unknown name is dropped,
  never guessed.
- **`update: "patch"` repaints the whole plate.** An identical re-render returns
  `unchanged: true` and sends nothing. After a wearer dismiss, later renders in the same run
  are discarded until the run ends.
- **The budgets live in the registry entry**, not here: `graphic@1` → `layoutBudgets.budgets`
  gives `captionMaxChars`, `slotsMax`, `sparklineMaxValues`, `iconNames` and the rest.

> Slot shapes and value types, worked examples for each slot, every repair and rejection code,
> and when a Graphic stays text → [`references/graphic.md`](references/graphic.md).

## The interaction window (the listen)

Every call carries **one one-shot listen**: the host waits **90 seconds by default** for the user to act, **up to 600000 ms (10 min) via the optional `timeoutMs` param**. Pass `timeoutMs: 300000–600000` when you expect the user to read or decide; omit it for fire-and-forget paints; never go below 60000 for anything interactive. The listen is **never renewed automatically** — re-rendering opens a fresh one.

When the listen ends without a tap you get a **non-terminal** `{ result: "window_expired", surface_still_live: true }`. **This is not an error and not a paint event** — the surface stays on glass and keeps ticking. From there:

- Taps now **park** (the user sees their tap acknowledged; nothing is lost). Re-render the same surface (`update: "patch"`) to collect parked taps in this run — chain a couple of these listens if you are actively waiting, then stop.
- Or simply **end your turn** — parked taps **wake you** (one agent turn per real parked gesture, delivered as a refs-only plugin notification; re-render to collect) or ride your next turn. Ending your turn with a surface parked is a normal, cheap state, not an abandonment.
- **Deadline with a safe default**: the window can double as a default-action deadline **only for reversible, non-actuating defaults**. Put the deadline in the body copy ("Auto-collapsing this list in 5 min"), give it a matching `timeoutMs`, and apply the default on expiry. `window_expired` is absence of input, never affirmative consent — for consequential, state-changing, destructive, or security-sensitive actions, expiry means cancel/no-op or re-render for explicit tap, voice, or chat approval.

Parked deliveries arrive annotated: `surfaceUuid`, `eventId`, `origin`, `actor`, `queuedAtMs`, `parkedForMs`. For taps that **actuate** something (sell/approve/unlock), declare `staleAfterMs` per render — a tap parked longer arrives with `stale: true`: treat it as a re-confirm prompt, **never** execute it as-is.

### Checklist surfaces: taps stay local; collect one full-state close

On `checklist_surface`, a tap changes only the `[ ]` / `[x]` mark on the client. It
sends nothing, costs no tokens, and does not claim the physical job happened. Swipe moves
the cursor without losing those marks. A double-tap deliberately closes the checklist and
sends the whole item state once. Voice requests such as “add batteries” or “which cable?”
are normal wearer turns through the voice path, not checklist taps.

`queueMode: "log"` is required so that one close outcome survives when the listen has
already ended:

```
render_glasses_ui({
  kind: "checklist_surface",
  title: "Demo kit",
  items: [
    { label: "G2 + case", checked: true },
    { label: "USB-C cable", checked: false },
    { label: "backup phone", checked: false }
  ],
  queueMode: "log",
  timeoutMs: 300000
})
// after local toggles, double-tap closes:
// { result: "dismissed", items: [
//   { label: "G2 + case", checked: true },
//   { label: "USB-C cable", checked: true },
//   { label: "backup phone", checked: false }
// ], ... }
// If the listen had ended, collect once with update:"patch"; log mode returns
// that same full-state close inside events:[...].
```

- **Shape**: while the listen is open, close returns a flat `back`/`dismissed` outcome plus
  `items`. After expiry, collect returns `{mode:"log", events:[...]}` with that close.
- **Sticky**: declare `log` on creation. A later collect patch keeps it.
- **No tap log**: row toggles never enter the event queue. Do not wait for one outcome per row.
- **Still not consent**: marks are memory aids only. Never say “completed”, actuate a task,
  or treat expiry/absence as a decision.

(The `await`/listen-without-repaint verb namespace is reserved for a future version — don't repurpose those words in surface copy or tooling.)

### Paged text: answer first, then one complete document

Use `paged_text_surface` when the wearer needs more than one HUD-sized block but is reading
one document, not choosing rows. Send the full `pages` array in the first render. The normal
answer must finish on the glasses before that complete surface attaches; never stream a
half-built page array. Scrolls move one page locally with zero agent turns. A boundary scroll
does nothing. A deliberate tap returns the visible page as `selected_index` and
`selected_text`.

```js
render_glasses_ui({
  kind: "paged_text_surface",
  title: "Research brief",
  pages: ["Finding one…", "Finding two…", "What this changes…"]
})
```

## Outcomes (the `result` you get back)

| result | meaning |
|---|---|
| `selected` | user picked a list item; `selected_index` + `selected_text` returned |
| `back` | user double-tapped above the root; they want to revise — re-render the previous step or pivot |
| `dismissed` | dismissed at root, or no selection made |
| `window_expired` | **non-terminal** — the listen ended, the surface is still live; taps park (see the interaction-window section) |
| `timeout` | terminal hygiene cap (rare); a refresh surface ends at `maxDurationMs` |
| `recipe_failed` | refresh only — initial smoke tick failed, the consecutive-failure breaker fired, or `onError:stop`; `failureReason` carries the last error |
| `glasses_disconnected` | refresh only — the glasses client dropped mid-cron |

For `checklist_surface`, `back` and `dismissed` also carry the complete `items` array.
For `paged_text_surface`, `selected` carries the page index and full page text. Page flips
themselves never produce an outcome.

Every delivery carries the surface's durable `surfaceUuid` plus `origin` (`gesture` for wearer actions, `system` for plugin-initiated outcomes) and an `actor` slot. Refresh results also carry: `ticks: { count, succeeded, failed, lastSuccessAt, lastFailureAt? }`, `lastBody`, `lastItems`, and `failureReason` (on `recipe_failed`).

## After an outcome: one move per outcome

An outcome came back. The reflex to fight is doing **two** things with it — patching the
surface *and* writing a paragraph in chat, or re-pushing a fresh surface the user never
asked for. **Every outcome gets exactly one move.** A surface move, or a chat close, or
silence. Never a surface move plus prose about the surface move.

| outcome | the one move |
|---|---|
| `selected` | act on the pick: **either** the next surface move (`patch` / `push` / `replace`) **or** a one-line chat close — not both |
| `back` | one re-render of the previous step. No apology, no "taking you back" narration |
| `dismissed` | silence, or one line in chat if you still owe an answer. Never reflexively re-surface |
| `window_expired` | **nothing is owed** — it is non-terminal. Chain at most one collect re-render, or end your turn. Never announce the expiry in chat |
| `timeout` / `recipe_failed` / `glasses_disconnected` | one line in chat naming the mechanism (`failureReason` verbatim on `recipe_failed`). Do not retry the render in the same turn |

**One-line chat close.** If the surface already answered the need, the whole reply is one
line — an acknowledgement, or the single fact the surface could not hold. Anything longer
is you re-doing the surface's job in text.

**Never narrate what the surface shows.** The content is already on glass. Re-listing the
items, restating the number the body just rendered, or describing the layout is pure
duplication. Say what the surface *cannot*: what you did with the pick, or what comes next.

**Silence lets it linger.** Ending your turn with no reply at all is a first-class move —
not an abandonment. The paint stays up, the cron keeps ticking, and parked taps wake you
(see the interaction-window section). Reach for silence whenever a live surface is doing
the talking.

### Honest phrasing in the close

**No close may claim the wearer took the surface in.** Nothing in the stack measures that: a
receipt proves the client reported painting a frame, and only a gesture proves a human acted.
Use the [delivery-ladder phrases](references/delivery-ladder-phrases.md) — the ladder ships
**inside this skill**, so the rungs travel with the published bundle — and stay at the rung
you actually earned:

| you know | write | never write |
|---|---|---|
| the send went out, nothing came back | "attempted, unconfirmed" | "it's on your glasses now" |
| the client reported painting a frame | "painted per client receipt" | "you're looking at it" / "as you can see" |
| a gesture came back (`origin: "gesture"`) | "you picked Milk" — the tap **is** the evidence | anything upgrading a tap into "you read it" |

The perception verbs are refused by name in code — `FORBIDDEN_CLAIM_TERMS` in
`extensions/ocuclaw/src/tools/glasses-ui-delivery-ladder.ts` is the single list, and it throws
with the honest substitute attached. Read it there rather than memorising a copy; a claim you
cannot spell is a claim you cannot ship. When you feel the pull to write "you should see…",
write nothing — the surface is right there.

### Two product pins that constrain the close

Locked product decisions, not preferences. Author around them.

- **One voice send per agent turn.** A turn commits **at most one** voice send; a trailing
  endpoint commit inside the 10 s lockout is **suppressed by design**, and the send shows as a
  bare `•AgentName` with no "held" label. Never author a flow that needs a second voice send in
  the same turn — no "say that again to confirm", no voice re-prompt after a `selected`. If you
  need a second answer, that is the *next* turn, or a tap on a surface.
- **Listening dot on initial entry only.** The dot animates on the **first** entry into
  listening, never on return after a reply (~500 ms `drain_finalize` suppressed). Do not write
  copy that treats it as a per-utterance indicator, and never ask the user whether the dot came
  back — its absence is the designed behaviour, not a fault.

> **Worked closes, outcome by outcome** — the good/bad pairs live in
> [`references/chat-hygiene.md`](references/chat-hygiene.md): one honest close per outcome,
> the narration anti-patterns spelled out, and the voice/listening pins applied to real copy.

## Nine patterns worth getting right

Nine places the audit found agents going wrong. One line each here; every one is worked
through with good/bad code in
[`references/authoring-patterns.md`](references/authoring-patterns.md).

1. **`patch` sends a whole spec, not a diff.** The spec is validated before the move is read,
   so omitted fields are *missing*, not preserved. What `patch` keeps is the surface: its id,
   its parked-tap queue, and its **running cron** (`replace` stops the cron). `staleAfterMs`
   is the exception — it resets to absent on every render that omits it. A `patch` with no
   live surface silently mints a **new root** instead of erroring.
2. **Two pushes, then stop.** The plugin overwrites your title with a breadcrumb of the whole
   stack (`"Trip › Hotels"`), clipped to the title band by dropping the **oldest** segment
   first — so past root + two pushes the wearer loses the trail. Never encode state in a
   title. And a pushed stack does not outlive your turn: the next turn's first render is
   depth 1 and reaps orphaned children.
3. **`back`: patch the parent, don't rebuild it.** A `back` outcome only reaches you from
   depth ≥ 2 (at root the client converts it to `dismissed`), and by then the client has
   already restored the parent and resumed its cron. The only thing missing is a listen
   window — re-render with `update: "patch"` if you need one, never `replace`.
4. **A stale tap re-asks; it never executes.** Declare `staleAfterMs`; a tap parked longer
   arrives with `stale: true`. The engine annotates, it does not block — the re-confirm is
   yours. `quick_check@1` is the worked template: **a tap is an answer, never an
   authorization**, and nothing destructive, chargeable, irreversible, or security-sensitive
   may hang on one.
5. **The parked-collection loop has a hard stop.** render → `window_expired` → **one**
   collect re-render (`update: "patch"`) → end the turn. `queueMode: "log"` for checklists
   (one full-state close), default `"latest"` for pick-one. Collecting drains the
   queue — a tap is never delivered twice.
6. **Pick your refresh guard-rails; don't inherit them.** `maxDurationMs` defaults to 30
   minutes — usually far longer than the surface is wanted. `maxConsecutiveFailures`
   defaults to 5; `onError` to `keep_last`, which makes a frozen value look live. Choose
   `show_error` when a stale number would mislead.
7. **On `glasses_disconnected`, say it once and re-render next turn.** The drain deletes the
   surfaces and stops the crons, and **nothing restores itself** on reconnect. Retrying in
   the same turn just hammers a client that is not there.
8. **The ≤6-row rule applies to fake-list kinds.** `list_with_details_surface` and
   `checklist_surface` fold at `visibleRowsBeforeFold: 6`. A `list_surface` is the native SDK list —
   `maxItems: 20`, no 6-row fold.
9. **The 30-char label budget stays detail-list-only.** `list_with_details` labels truncate with `…`
   past `recommendedLabelMaxChars: 30` even though `labelMaxChars: 64` validates. Front-load
   the meaning; push the rest into the body. Checklist labels use the 64-character engine cap.

## Quick reference

- **Three decisions before every render**, in order: (1) should anything go on the display at
  all — if the wearer named a destination outright, use it; otherwise render if the turn
  carries a pick, a
  value they re-read, something that changes on its own, or something visual, and chat if it
  carries none of the four; (2) which wire kind —
  one block → `text_surface` (a ticking number is still one thing), a bounded document →
  `paged_text_surface`, rows to land on → `list_surface`, rows needing a sentence each →
  `list_with_details_surface`, local marks → `checklist_surface`; (3) which
  move — `update` is chosen on every render, never inherited. → `references/choosing-the-surface.md`.
- **List vs `list_with_details`**: default `list_surface`; details only when the wearer's ask
  supplied criteria that discriminate between the rows, or the consequence differs materially
  per row — judged from the ask, never from the call you are emitting. Detail bodies carry the
  reason to pick *that* row in the wearer's terms (a description of the row is not a detail
  body), and `detailBodyMaxChars` is a mandatory 200 — a rough guide; the tool measures pixels
  against the real glasses font and rejects (with the real limit) whatever doesn't fit the
  4-line detail reader.
- **`lifecycle.move` on the registry entry is the template's characteristic render**, not just
  its first: `patch` entries owe a second render (`progress_monitor@1`, `error_repair@1`),
  `push` entries are a two-render flow (`drilldown_parent_child@1`).
- Pick the **lowest tier**: host metrics → `system-stats`; pure data API → `http`; one-line interpretation → `llm`; broader judgment → render once from your turn.
- `update` default is `replace` (in-place). Use `push` to drill in without losing the parent; `patch` to edit fields while the cron keeps ticking.
- The listen is one-shot: default 90 s, `timeoutMs` up to 600000 (use 300000–600000 for read-or-decide). `window_expired` ≠ error — re-render to collect parked taps, or end your turn (they wake you / ride the next turn).
- `checklist_surface` requires `queueMode: "log"`: taps stay local; double-tap sends the full state once. A post-expiry collect returns that close in `events:[…]`.
- `paged_text_surface` takes 1–10 complete pages, each fitting the 8-line reader (≤600 chars is a rough guide — the tool measures pixels and tells you the real limit if a page doesn't fit). Scrolls are local; tap returns the visible page. The normal answer drains before the complete page array attaches.
- `intervalMs` ≥ 1000. Read `failureReason` on `recipe_failed` and fix the recipe.
- `http` recipe? → `references/http-recipe-cookbook.md` (worked recipes, real bounds, auth
  handling, the SSRF-guard posture, pre-flight checklist).
- Template **budgets and field sets** come from `references/template-registry.json`
  (`name@version`), never from memory; the rows are citable defaults and the scoring rubric,
  not the list of situations allowed on the glass. One line per row →
  `references/intent-index.md`. Canonical names: `deadline_with_safe_default@1`,
  `compare_options@1`, `paged_briefing@1`, `progress_monitor@1`.
- **No matching row is not a refusal.** Sixteen worked moments — eight renders, four that
  correctly render nothing, four that no template covers → `references/exemplars.md`.
- One image + one caption → `template: "image_caption"` on a `text_surface`; optional
  title, one-shot image transfer. → `references/image-caption.md`.
- Nine patterns worth getting right (patch payload · 2-push breadcrumb · back · stale tap ·
  collection loop · refresh guard-rails · disconnect · ≤6 rows · 30-char labels) →
  `references/authoring-patterns.md`.
- After a surface resolves, a short text reply exits to chat; another render replaces; silence lets it linger.
- **One move per outcome** — a surface move OR a one-line chat close OR silence, never a move
  plus prose about it. Never narrate what the surface already shows. Closes stay at the rung
  you earned ("attempted, unconfirmed" / "painted per client receipt") and never claim the
  wearer took it in. One voice send per agent turn; the listening dot fires on initial entry
  only. → `references/chat-hygiene.md`.
