# `graphic` — typed slots the client draws

Registry entry: **`graphic@1`** in
[`template-registry.json`](template-registry.json) — `status: "shipped"`,
`lane: "registry_entry_only"`, `renderableToday: true`, riding the existing `text_surface`
kind. Everything below is a reading of that entry plus the live validator; **the entry is the
source of truth**, so when a number here and a number there disagree, the artifact wins and
this file is stale.

## When to reach for it

A Graphic is for **a reading with a shape**: numbers the wearer takes in faster as a picture
than as a sentence. You describe one or two typed **slots**; the glasses draw them on the
image plate with the caption line under it. You never send pixels, paths, coordinates or
sizes, and you never pick a layout: the client owns all of that.

### Pick the slot by the shape of the reading

| the reading is… | slot |
|---|---|
| one number that matters | `metric` — add `delta` for which way it moved, `icon` for a symbol |
| a trend over time | `sparkline` |
| a share of a goal | `progress` or `ring` (either is right; `ring` is more compact) |
| a value against its target | `bullet` |
| a per-hour pattern | `heatstrip` |
| a few facts | `keyvalue` |
| a plain state | `status` with an `icon` |
| a few values where one is the point | `bars`, with `highlight` on that one |
| a value on a known scale | `gauge` |

Two slots sit side by side. The classic pair is a `metric` beside the `sparkline` it came
from: the number now, and how it got there. **One or two slots only** — a third is dropped
(`slots_trimmed`), so do not send one.

### When it stays text

- **It has to keep updating by itself.** A Graphic has no `refresh`
  (`graphic_refresh_unsupported`). A live number that ticks is a `text_surface` with a
  `refresh` recipe. A Graphic moves only when you re-render it.
- **The wearer picks from it.** Nothing on a Graphic is selectable. A set they choose from
  is a `list_surface`, even when every row is a number.
- **The answer is words.** Directions, a line to say, a reason: a plain `text_surface` body.
  A `keyvalue` or `status` slot holding a sentence is text in a costume.
- **The picture is the content.** A photo or a glyph you already hold as a PNG is
  [`image_caption`](image-caption.md).

## The caption is the fallback — numbers first

`body` is **required**. It is the caption line under the plate **and the whole fallback**: a
client without the renderer shows only `body`, as plain text, and a plate that fails to paint
leaves the caption on the page. So write it as the reading in words, **numbers first** —
`"12.5 kt at the slip, up 1.5"`, not `"Wind at the slip"`.

There is **no `title`** (`graphic_title_unsupported`): the caption says what the reading is.

## Worked examples

```js
// One number that matters, and a trend beside it.
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "12.5 kt at the slip, up 1.5",
  graphic: {
    slots: [
      { type: "metric", value: "12.5", unit: "kt", label: "Wind", delta: 1.5 },
      { type: "sparkline", values: [9, 11, 10, 12.5], label: "Last hour" }
    ]
  }
})
```

```js
// A share of a goal: 1,240 of 1,800 photos uploaded.
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "1,240 of 1,800 photos up",
  graphic: { slots: [{ type: "progress", value: 0.69, label: "Upload" }] }
})
```

```js
// A value against its target: £41k against £50k, scale to £60k.
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "£41k of £50k target",
  graphic: { slots: [{ type: "bullet", value: 41, target: 50, max: 60, label: "Sales" }] }
})
```

```js
// A per-hour pattern: chance of rain, as 0..1 per hour.
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "Rain peaks 90% at 2pm",
  graphic: { slots: [{ type: "heatstrip", values: [0.1, 0.2, 0.4, 0.7, 0.9, 0.8, 0.6, 0.3], label: "Rain 10-5" }] }
})
```

```js
// A few facts, and a plain state with an icon.
render_glasses_ui({
  kind: "text_surface",
  template: "graphic",
  body: "Gate B32, boards 17:05",
  graphic: {
    slots: [
      { type: "keyvalue", rows: [["Gate", "B32"], ["Boards", "17:05"], ["Seat", "14C"]] },
      { type: "status", text: "On time", icon: "plane" }
    ]
  }
})
```

## Slot shapes and value types

`value` changes type by slot, so read this before you write one:

- **`metric`** — `value` is **text**: `"12.5"`, not `12.5`. Optional `unit`, `label`,
  `delta` (a number, e.g. `1.5` or `-2`) and `icon`.
- **`progress`, `ring`** — `value` is a **JSON number**, a fraction `0..1`. A number above
  1 and at most 100 is read as a percent and reported (`percent_read_as_fraction`); send the
  fraction and there is nothing to report.
- **`bullet`** — `value`, `target` and `max` are numbers; `max` above 0.
- **`gauge`** — `value` is a number; optional `min` and `max` (defaults in the budgets below),
  `max` above `min`.
- **`sparkline`, `bars`, `heatstrip`** — `values` is an array of numbers, **oldest first**.
  `heatstrip` values are intensities `0..1`. `bars` takes an optional `highlight` index.
- **`keyvalue`** — `rows` is an array of `[key, value]` text pairs.
- **`status`** — `text` is the state in words; optional `icon`.
- **`label`** — optional on every slot but `status`.

**Icons** come from a closed list: [`graphic-icons.md`](graphic-icons.md). An unknown name is
**dropped, never guessed** (`icon_dropped`) — the slot draws without a symbol rather than with
a wrong one. Pick from the list; do not invent a name.

## The budgets

Quoted from `graphic@1` → `layoutBudgets.budgets`, in the artifact's own spelling:

```
captionMaxChars:        64
slotsMax:               2
metricValueMaxChars:    8
metricUnitMaxChars:     6
metricLabelMaxChars:    18
seriesMinValues:        2
sparklineMaxValues:     60
barsMaxValues:          14
heatstripMaxValues:     24
gaugeMinDefault:        0
gaugeMaxDefault:        100
keyvalueRowsMax:        3
keyvalueKeyMaxChars:    14
keyvalueValueMaxChars:  10
statusTextMaxChars:     28
iconNames:              140
plateWidthPx:           288
plateHeightPx:          144
inkBudgetPercent:       18
minContrastDelta:       4
```

The plate size, ink budget and contrast floor are the client's, listed so you know why the
slots are small. None of them is a field you send.

## Repairs — the render succeeds and says what it changed

A slightly-wrong spec is **repaired, not refused**, so one mistake does not cost a retry. A
repair keeps your meaning: it never changes a slot's type and never invents data. Every
repair comes back in a `repairs` array on the ok result as `{ code, path, message }`.

| code | what it changed |
|---|---|
| `text_truncated` | an overlong label, value, unit, key, row value or status text was cut with an ellipsis |
| `series_downsampled` | a `sparkline` over its max was downsampled; the last point is always kept |
| `series_trimmed_to_recent` | `bars` or a `heatstrip` over its max kept the most recent values |
| `percent_read_as_fraction` | a `progress` or `ring` value above 1 and at most 100 was divided by 100 |
| `value_clamped` | a value outside its range was clamped into it |
| `slots_trimmed` | more than two slots: the first two were kept |
| `rows_trimmed` | more `keyvalue` rows than allowed: the first ones were kept |
| `icon_dropped` | an unknown icon name was removed, never guessed |

**Read `repairs` and send a cleaner spec next time.** A repaired render is a success, but the
same repair on every render means you are sending the wrong shape: fix the shape. Do not
re-render just to clear a repair — the wearer already has the result.

## Rejections — the render did not happen

Anything that cannot be repaired without guessing is one `{ ok: false, code, message }`.
The message names the allowed values or the corrected shape, so one corrected call is enough.

| code | what tripped it |
|---|---|
| `graphic_slots_missing` | no `graphic`, or `graphic.slots` missing or empty |
| `graphic_slot_type_unknown` | a slot `type` is not a Graphic slot type; the message lists the allowed types and the nearest name |
| `graphic_slot_data_invalid` | a slot's data cannot be read: a short or non-numeric series, a non-numeric goal number, a `bullet` max not above 0, a `gauge` max not above min, a row that is not a `[key, value]` pair, a blank text, or a field that slot does not take |
| `graphic_body_required` | `body` is empty or longer than `captionMaxChars` |
| `graphic_title_unsupported` | you sent a `title`; put what the reading is in the caption |
| `graphic_refresh_unsupported` | you attached a `refresh`; re-render with `update: "patch"` instead |
| `image_template_required` | you sent image fields (`imageAsset`, `imageBase64`, …); those belong to `image_caption` |

## Updating a Graphic

- **`update: "patch"` repaints the whole plate.** There is no per-slot patch: send the whole
  Graphic again with the new values. `replace` works too, for a different reading.
- **An identical re-render is `unchanged: true`.** If a patch or replace normalises to the
  Graphic already on the surface, nothing is sent: the result is `result: "unchanged"`,
  `unchanged: true`, with the surface's existing delivery state. Repeating yourself did
  nothing, so do not loop on it.
- **After a wearer dismiss, stop.** Once the wearer dismisses, every later render in the same
  agent run is discarded — no frame — and returns the stored `dismissed` outcome (with that
  render's own `repairs`) until the run ends. Treat `dismissed` as the answer, not as a paint
  that failed.
- **`validateOnly: true`** dry-runs a Graphic: nothing is sent, and the result reports the same
  repairs the real render would make.

## What you may claim afterwards

A successful call means the render was accepted and sent — `send_attempted`, whose honest
phrase is **"attempted, unconfirmed"**
([`delivery-ladder-phrases.md`](delivery-ladder-phrases.md)). The plate is drawn on the
client and written as a separate image write after the text; if that write fails the client
reports `paint_failed` and the caption stays on the page. Say "sent the reading — attempted,
unconfirmed", or say nothing. Never claim the plate is up.

The plugin's content summary carries the template and the slot types, **never** the values.
