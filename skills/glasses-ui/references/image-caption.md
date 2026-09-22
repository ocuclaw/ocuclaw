# `image_caption` — the one template that reaches the wire

Registry entry: **`image_caption@1`** in
[`template-registry.json`](template-registry.json) — `status: "shipped"`,
`lane: "registry_entry_only"`, `renderableToday: true`. It is one of the two values the
`template` field on a render accepts today; the other, `graphic`, draws typed slots instead
of taking an image ([`graphic.md`](graphic.md)).
Everything below is a reading of that entry plus the live validator; **the entry is the
source of truth**, so when a number here and a number there disagree, the artifact wins and
this file is stale.

## When to reach for it

One small greyscale image with a balanced caption under it and an optional plain heading:
a welcome card, a rasterized glyph, a diagram you already have as a PNG, a one-off picture.
The caption wraps within the available native text lines.

It is an **image transfer, not a live surface**. There is no refresh, no cron, no selection.
If the thing you want is data that changes, you want a `text_surface` with a `refresh`
recipe, not this.

Reach for it when **the picture is the content**. If the picture is decoration on top of
text, drop the picture: a 64-character caption is the entire text budget of this template.

## Worked example — the built-in asset variant (runs today)

```js
render_glasses_ui({
  kind: "text_surface",
  template: "image_caption",
  title: "Welcome",             // optional; omit for a titleless card
  body: "Welcome back",          // the caption, and the whole fallback on 2.0.0 clients
  imageAsset: "hermes_welcome"   // the only built-in asset id today
})
```

## Worked example — the inline PNG variant

```js
// One 96x96 PNG, base64 with NO data: URI prefix — raw standard base64 only.
render_glasses_ui({
  kind: "text_surface",
  template: "image_caption",
  body: "Build 412 — green",
  imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAGAAAABg…",   // standard alphabet, no whitespace
  imageWidth: 96,                                      // MUST equal the PNG's IHDR width
  imageHeight: 96                                      // MUST equal the PNG's IHDR height
})
```

**`imageAsset` and the inline trio are exclusive.** Send one or the other — sending both, or
neither, is `image_source_invalid`. And the inline trio is a trio: `imageBase64` without its
two dimensions does not validate.

**The declared dimensions are checked against the file, not trusted.** The validator reads
the PNG's IHDR header and rejects a mismatch with `image_format_invalid`. Measure the image;
do not guess and let the caller find out.

## The budgets

Quoted from `image_caption@1` → `layoutBudgets.budgets`, in the artifact's own spelling:

```
captionMaxChars:       64
imageMinWidthPx:       20
imageMaxWidthPx:       288
imageMinHeightPx:      20
imageMaxHeightPx:      144
imageMaxDecodedBytes:  41472
imageMaxBase64Chars:   73728
imageFormat:           "PNG (IHDR-checked)"
```

**There are minimums, not just maximums.** A 5×5 PNG is rejected with
`image_dimensions_invalid` before its bytes are ever looked at — the dimensions must be
integers inside *both* bounds. Anything smaller than the minimum is not a small picture, it
is an unreadable one.

The decoded-bytes cap is the one that actually bites: 73728 base64 characters decode to more
than 41472 bytes, so a payload can pass the character cap and still be refused for size.
Budget the **decoded** PNG, and prefer few grey levels — the built-in asset is 16-level
greyscale in roughly 4 KB.

## Rejection codes, and what each one means

Every code below comes back on the render call itself, before anything paints. Read the
code, fix the spec, re-render — the same recon loop a failing `refresh` recipe gets.

| code | what tripped it |
|---|---|
| `invalid_template` | `template` was present but not `"image_caption"` |
| `image_template_required` | an image field was sent **without** `template: "image_caption"` |
| `title_too_long` | the optional title exceeds the normal character or measured-width limit; shorten the heading |
| `image_caption_too_long` | `body` was empty, or longer than `captionMaxChars` |
| `image_caption_refresh_unsupported` | you attached a `refresh` block. One-shot only — re-render to change the picture |
| `image_source_invalid` | both `imageAsset` and inline image fields, or neither |
| `image_asset_unknown` | `imageAsset` is not one of the built-in ids |
| `image_dimensions_invalid` | `imageWidth` / `imageHeight` missing, non-integer, or outside the budgets |
| `image_payload_invalid` | `imageBase64` is not a string, exceeds `imageMaxBase64Chars`, is malformed base64, or decodes past `imageMaxDecodedBytes` |
| `image_format_invalid` | the bytes are not a PNG, or its IHDR dimensions disagree with the ones you declared |

`body_too_long` can also fire when the caption exceeds the measured native text area.
Shorten it while preserving the image's declared dimensions.

## Optional heading and normal navigation

The optional `title` uses the shared plain heading and the normal title limits. Titleless
cards remain valid. A retained title in the stack can supply the navigation breadcrumb;
the client accepts that heading for image cards too.

Use `push` under a titled parent when Back should return there. Use `replace` to update
the current surface, at the root or inside a nested flow. The image transfer and caption
remain one-shot in either position.

## What you may claim afterwards

A successful call means the render was accepted and sent — `send_attempted`, whose honest
phrase is **"attempted, unconfirmed"**
([`delivery-ladder-phrases.md`](delivery-ladder-phrases.md)). The image bytes travel as a
**separate raw-data write after the container rebuild**, retried up to three times with a
growing backoff, so the picture landing is a second event you did not get told about.

Say "sent the card — attempted, unconfirmed", or say nothing. Never claim the picture is up.

One more mechanical fact worth knowing: the plugin's content summary carries the template
name, the asset id and the dimensions, and **never** the base64 payload — image bytes are
omitted from every summary surface by construction, not by redaction after the fact.
