# Exemplars — sixteen moments, and what was actually sent

Worked cases, not a catalogue. Each one is a situation in the wearer's own
words, the call that answered it, and the one sentence that names why. Where a
near-miss is instructive there is a `NOT` line naming the wrong shape and what
it costs.

**Four of these do not render.** A library that only shows renders builds a
render reflex, and the reflex is the failure mode this file exists to prevent.
It cuts the other way too: when the glass would have served and you answered in
chat, nothing breaks and nobody complains — they just reach for their phone,
and you never hear about it.

**Four are labelled `off-menu`.** No registry row covers them. They were
rendered because the glass earned its place, and they are here so that
"no row matches" reads as what it is: not a refusal.

Budgets (rough guides — the tool measures pixels against the real glasses font and rejects
with the real limit if it doesn't fit): `text_surface` body ≤ 1000 · `list_surface` ≤ 20 × 64 ·
`list_with_details_surface` label ≤ 64, **body ≤ 200**, all bodies ≤ 6144.

---

## Render

### `pick-one-walking` · `list_surface` · `replace`

> "Three of us outside the market, all starving. Pie shop on the corner, ramen
> two streets up, or Nando's. Settle it."

```json
{"kind":"list_surface","title":"Pick one","items":["Pie shop — corner","Ramen — 2 streets up","Nando's"],"timeoutMs":300000,"update":"replace"}
```

**why** Trigger 1, they pick. The labels alone decide it → no details.
**NOT** a `text_surface` naming the winner. A question they answer by picking is
never a text body: do not resolve the choice yourself and paint the answer.
Numbering lines in a body does not make rows, and a body has no answer path back.

### `pick-one-with-criteria` · `list_with_details_surface` · `replace`

> "Yoga at 18:30, climbing at 19:00, or the 20:00 run club? I did legs
> yesterday and I want to be home by half nine."

```json
{"kind":"list_with_details_surface","title":"Tonight","items":[
 {"label":"18:30 · Hot yoga","body":"Kind to yesterday's legs. Home 20:15."},
 {"label":"19:00 · Climbing","body":"Arms only, legs rest. Home 21:00."},
 {"label":"20:00 · Run club","body":"Legs again, and home 21:45 — past your cutoff."}],
 "timeoutMs":300000,"update":"replace"}
```

**why** Their criteria — legs, half nine — discriminate between the rows.
**NOT** `list_surface`: the labels here are a time and a name, and the reason to
pick is in neither. And not a details body that merely describes the row — each
body says why *that* row, in the wearer's own terms. A description of the row is
not a detail body.

### `one-glanceable-atom` · `text_surface` · `replace`

> "Box in both arms halfway up the stairs — lasagne at 180 fan or 200?"

```json
{"kind":"text_surface","title":"Lasagne","body":"180°C fan\n(200°C conventional)","update":"replace"}
```

**why** Trigger 5: one atom, hands committed. Small is the point, not a flaw.
**NOT** a list — two lines are not two rows; rows exist to land a highlight on.

### `progress-ticking` · `text_surface` · `patch`

> "Kick the deploy off and tell me when it's through — I'm walking to the car."

```json
{"kind":"text_surface","title":"Deploy","body":"2/5 · tests","update":"replace"}
{"kind":"text_surface","title":"Deploy","body":"5/5 · done, 2 lint warnings","update":"patch"}
```

**why** Trigger 3: it changes while it sits there. `patch` owes a second render.
**NOT** one render and stop — that is the first frame of the template, not the
template. And not a fresh `replace` per step: `replace` swaps the surface and
stops its cron, so one outcome arrives as five separate surfaces.

### `drilldown` · `list_surface` · `push`

> "What's on this afternoon? … right, open the three o'clock."

```json
{"kind":"list_surface","title":"Afternoon","items":["14:00 · Standup","15:00 · Design review","16:30 · 1:1 with Sam"],"update":"replace"}
{"kind":"text_surface","title":"Design review","body":"Room 2 · Ana, Tom\nBring the two mocks","update":"push"}
```

**why** A child they must be able to back out of → `push`.
**NOT** `replace` on the child. Never replace at depth ≥ 2 — it destroys the back
stack. After `back`, the re-render is always `patch`.

### `show-me-the-thing` · `text_surface` + `template: "image_caption"`

> "Show me the welcome card."

```json
{"kind":"text_surface","template":"image_caption","imageAsset":"hermes_welcome","body":"Welcome to Hermes"}
```

**why** Trigger 4: they asked to SEE a thing. Chat cannot carry it.
**NOT** "Sure — here it is" in chat. A five-character reply to *show me* is the
picture gone missing, and the display is why they asked.

### `deadline-safe-default` · `text_surface` · `replace`

> "Cancel the six o'clock table if Priya hasn't texted by five."

```json
{"kind":"text_surface","title":"6pm table","body":"Holding until 17:00.\nNo word by then → I'll ask you before I cancel.","timeoutMs":600000,"update":"replace"}
```

**why** Trigger 2: a state they re-read. Expiry parks; it never acts.
**NOT** a card that promises to cancel when the window closes. Silence is never
consent, and a closed window may only fall back to something reversible.

### `triage-consequence-differs` · `list_with_details_surface` · `replace`

> "Anything in the inbox that actually needs me before I get on the train?"

```json
{"kind":"list_with_details_surface","title":"Before the train","items":[
 {"label":"Landlord — inspection","body":"Wants a slot today; skip it and it slides a week."},
 {"label":"Ana — invoice","body":"Three days over; the late fee starts Friday."},
 {"label":"Newsletter","body":"Nothing owed."}],
 "timeoutMs":300000,"update":"replace"}
```

**why** They asked what it costs to skip; that cost differs per row.
**NOT** `list_surface` — "Landlord — inspection" does not carry what leaving it
costs, and the cost is the whole question they asked.

---

## Chat won

### CHAT · `needs-a-question-back`

> "Landlord wants to put the rent up 12% — can he do that?"

**No render.** The honest reply asks which country they are in and what the lease
says, then carries caveats a 1000-char body would mutilate.
**why** Both chat exits at once: the answer is a question back, and it needs
caveats to survive. A confident card here is a confident wrong answer.

### CHAT · `a-better-screen-is-already-open`

> "I'm at my desk with the PR open — what's wrong with this diff?"

**No render.** They are in front of a 27-inch monitor with the thing on it.
**why** No trigger fires, and the better surface is already in front of them.
**NOT** a list of findings on the HUD. The smallest screen in the room does not
win a comparison it was never in.

### CHAT · `banter`

> "Do you reckon the ref was bought?"

**No render.** Nothing to park on glass, nothing to pick.
**why** Conversation. Rendering here is how a wearer learns to take them off.

### CHAT · `the-prose-they-asked-for-whole`

> "Give me the whole write-up on the migration — I want to read it properly."

**No render.** They asked for prose in full; the body cap mutilates it.
**why** They named the shape of the answer, and it is not a surface.

---

## Off-menu — no row covers these

### `name-recall` · `list_surface` · `replace` · **off-menu**

> "There are nine people here and I've met three of them once. Keep me straight."

```json
{"kind":"list_surface","title":"Who's who","items":["Priya — Ana's sister, vet","Tom — bought the boat","Meli — Berlin, flies Sunday"],"timeoutMs":600000,"update":"replace"}
```

**why** Trigger 2: re-read all evening, while both hands hold a drink.
**off-menu** No template covers this — it was rendered because the glass earned
its place. The wearer supplied the occasion; our taxonomy never could.

### `phrase-card` · `text_surface` · `replace` · **off-menu**

> "I have to ask the pharmacist for this in Portuguese and I'm going to blank."

```json
{"kind":"text_surface","title":"Farmácia","body":"Preciso de receita para isto?\n(Do I need a prescription for this?)","timeoutMs":600000,"update":"replace"}
```

**why** One atom, re-read at the counter, phone hand busy.
**off-menu** No template covers this — it was rendered because the glass earned
its place.
**NOT** a chat paragraph they cannot open with a pharmacist in front of them.

### `next-decision-only` · `text_surface` · `patch` · **off-menu**

> "Get me to the ferry, but I don't want the whole route in my face."

```json
{"kind":"text_surface","title":"Ferry","body":"Left at the lights\n900 m","update":"replace"}
{"kind":"text_surface","title":"Ferry","body":"Cross the bridge\n2.1 km","update":"patch"}
```

**why** One decision at a time; the rest is noise while they walk.
**off-menu** No template covers this — it was rendered because the glass earned
its place.
**NOT** the whole route as a list. Twelve rows is a map, and they asked for the
opposite of a map.

### `ambient-plugin-state` · `text_surface` · `patch` · **off-menu**

> "Put the door sensor up while I'm in the workshop — most of the time it'll
> have nothing to say."

```json
{"kind":"text_surface","title":"Front door","body":"Closed · 14:02","timeoutMs":600000,"update":"replace"}
{"kind":"text_surface","title":"Front door","body":"OPEN · 14:31","update":"patch"}
```

**why** Trigger 3: it changes on its own, and boring is the normal state.
**off-menu** No template covers this — it was rendered because the glass earned
its place. Expiring here is the designed outcome, not a failure.
**NOT** a chat line per state change. Ambient state that speaks every time is a
notification, and they asked for a surface.

---

These sixteen are non-exhaustive. There is no approved list of situations. If the
glass earns its place and none of these fits, build the moment out of the four
layouts and three moves — that is what the vocabulary is for.
