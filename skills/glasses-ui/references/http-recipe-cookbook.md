# `http` recipe cookbook

Three curated, code-true `refresh.recipe.kind: "http"` recipes: **weather** (no key),
**GitHub CI status** (auth handling documented), and **Home Assistant** (the SSRF-guard
tension, documented honestly).

Load this when you are about to author an `http` refresh. The parent
[SKILL.md](../SKILL.md) already teaches the tier ladder, the four moves, and the
interaction window — this file assumes them and only adds the http-specific detail.

**Companion artifact:** [`http-recipe-field-sets.json`](./http-recipe-field-sets.json)
carries the same three recipes as machine-consumable field sets for the WP6/#544
`template_field_unknown` lint and the S1-1 template registry. **If the JSON and the
tables below ever disagree, the JSON wins** — it is the artifact a linter parses.

---

## What the http tier actually is, at HEAD

Everything in this section was read out of the code, not the plan. Anchors are given so
you can re-check when the code moves.

Timer HTTP is on by default, with two ways for a public host to become reachable:
the operator may preconfigure an exact or suffix-pattern `httpAllowHosts` entry, or the
default `httpHostPolicy: "owner-grants"` may let the wearer approve one exact hostname on
the phone. Render the card normally. An unlisted host returns
`refresh_host_consent_required`; the render waits, and after approval the surface starts
automatically. This is a consent hold, not an error to retry, and the wearer never needs
to ask again. An explicit `httpEnabled: false` remains a hard off. A shared or hosted
install can set `httpHostPolicy: "operator-only"` next to `relayToken`.

Optional operator preconfiguration (required under `operator-only`):

```bash
bash tools/openclawctl.sh config set plugins.entries.ocuclaw.config.glassesUiLive.httpEnabled true
bash tools/openclawctl.sh config set plugins.entries.ocuclaw.config.glassesUiLive.httpAllowHosts \
  '["api.open-meteo.com", "api.github.com"]'
```

Allowlist entries are exact hostnames, or `.suffix` for a domain **plus** its subdomains;
matching is dot-anchored, so `.example.com` never matches `evil-example.com`
(`normalizeHttpAllowHosts` / `isHttpHostAllowed`, `tools/glasses-ui-recipes.ts:256-272`).
The effective host decision — operator patterns plus exact owner grants — is re-read on
**every tick**, and it binds every redirect hop, not just the first URL
(`resolveEffectiveHostCheck` in `glasses-ui-tool.ts`, plus redirect enforcement in
`glasses-ui-recipes.ts`).

**Recipe fields the schema accepts** (`tools/glasses-ui-tool.ts:380-392`), and their real
bounds (`GLASSES_UI_REFRESH_LIMITS`, `glasses-ui-tool.ts:38-66`):

| field | type | bounds / default | notes |
|---|---|---|---|
| `kind` | `"http"` | required | — |
| `url` | string | required, non-empty | must parse, must be `http:`/`https:` |
| `method` | string | **`GET` or `POST` only**, default `GET` | anything else → `refresh_invalid_recipe` |
| `headers` | object | — | passed through **verbatim**; see *Secrets* below |
| `body` | string | — | ignored for `GET`/`HEAD` |
| `jsonPath` | string | — | minimal subset only: `$.a.b`, `$.a[0].b` |
| `timeoutMs` | integer | 1000–30 000, default 10 000 | per-request abort |
| `outputCapBytes` | integer | 1024–1 048 576, default 65 536 | response is truncated, not failed |

There is **no** `intervalMs` on the recipe. Cadence lives one level up on `refresh`.

**Cadence and the paint floor.** `refresh.intervalMs` is clamped to
`Math.max(tierMin, DEFAULT_PAINT_FLOOR_MS)` — for `http` that is `max(1000, 250) = 1000 ms`
(`glasses-ui-tool.ts:74-76`; `DEFAULT_PAINT_FLOOR_MS = 250`,
`tools/glasses-ui-paint-floor.ts:19`). Below it → `refresh_interval_too_low`; above
3 600 000 ms → `refresh_interval_too_high`. The 250 ms paint floor is a *downstream*
coalescer on painting, not a cadence you can reach from `http`: even at the 1000 ms
minimum every tick is one paint, and bursts coalesce leading-edge + trailing without
dropping content. **Never author an http recipe near the 1000 ms floor to "feel live"** —
you are billing someone else's API once a second for a HUD line a human reads every few
minutes. Pick the cadence from the data's own update rate; each recipe below states one
and says why.

`refresh.maxDurationMs` bounds the surface's life: 10 000–7 200 000 ms, **default
1 800 000 (30 min)**. At expiry the cron resolves `{ result: "timeout" }` and the surface
tears down. If your interval is long, raise `maxDurationMs` or the surface dies after a
handful of ticks.

**Templating against the response.** `executeHttpRecipe` parses JSON when the
`content-type` says JSON (else it sniffs a leading `{`/`[`), applies `jsonPath`, and hands
the result to the cron as `output` (`glasses-ui-recipes.ts:460-469`). The cron then wraps
it (`wrapForTemplate`, `tools/glasses-ui-cron.ts:109-114`):

- **object output** → its fields are addressable at the top level, **and** the whole
  object is also available as `{{output}}` / `{{output.field}}`.
- **anything else** (string, number, array) → **only** `{{output}}` (and `{{output.0}}`
  for arrays).

Template paths are **dot-separated, with numeric segments for array indices** —
`{{workflow_runs.0.status}}`. This is *not* the `jsonPath` syntax: `jsonPath` takes
`$.workflow_runs[0]`, templates take `.0`. Mixing them is the single most common authoring
error here. `{{previous.<path>}}` reads the prior tick's output, which is what makes
`| minus:previous.temperature_2m` work.

**Failure semantics you must design for** (`glasses-ui-cron.ts:173-253`):

- The **first tick is a smoke test that runs before the surface commits**. If it fails you
  get `result: "recipe_failed"` with a `failureReason`, no surface is painted, and this is
  terminal *regardless of `onError`*. Read the reason, fix, retry — that is the recon loop.
- After commit: `onError: "keep_last"` (default) holds the last good value; `"show_error"`
  patches the body to `⚠ Update failed: …`; `"stop"` ends the surface. Independently,
  `maxConsecutiveFailures` (1–100, **default 5**) ends it with `recipe_failed`.
- Consecutive failures back off `base * 2^failures`, capped at 60 000 ms.
- Any non-2xx becomes the error string `http recipe got status <n>`.

**Two real gaps at HEAD — write recipes around them, do not patch code from this file:**

1. **HTTP 3xx is always treated as a redirect.** A `304 Not Modified` falls in the
   300–399 branch, finds no `Location` header, and fails with
   `http recipe got 304 with no Location header` (`glasses-ui-recipes.ts:385-389`). So
   **conditional requests do not work** — do not send `If-None-Match`/`If-Modified-Since`
   hoping for a cheap poll. This matters most for GitHub, whose 304s are free of rate
   limit.
2. **`Retry-After` is never honored for http.** The cron consumes `result.retryAfterMs`
   (`glasses-ui-cron.ts:200-201`), but no http code path ever sets it — grep confirms the
   only producer is the unrelated gateway client. A 429 is just another failure that
   burns a `maxConsecutiveFailures` slot under exponential backoff. **Budget your cadence
   so you never hit the limit**, because nothing will rescue you if you do.

**Secrets: there is no secret-reference mechanism.** `headers` is copied through verbatim
(`glasses-ui-recipes.ts:337`); there is no `${env.X}`, no `secretRef`, no `process.env`
read anywhere in the cron or tool path. Repo convention is that `.env` is the sole home
for secrets and that config is set via the CLI, never by hand-editing files — and the
recipe path honors neither, because it cannot reach either one. **Consequence: putting a
token in a recipe means writing the literal token into a tool call**, where it lands in
the conversation transcript and in whatever the host records of it. Every recipe below is
therefore authored **unauthenticated by default**; the authenticated variants are marked
and gated.

The one credential protection that *does* exist: on a redirect that crosses `URL.origin`,
`Authorization`, `Cookie`, `X-Api-Key` and friends are stripped and the body is dropped
(`stripCrossOriginHeaders`, `glasses-ui-recipes.ts:279-300`).

**Silence is never consent.** None of these recipes may be wired to an
expiry-actuated consequence. A refresh surface times out at `maxDurationMs` and a listen
ends at `timeoutMs`; both are *absence of input*. Read-only display on expiry is fine.
Anything that changes state waits for an explicit tap, and a tap parked past
`staleAfterMs` arrives `stale: true` and must be re-confirmed, never executed. Each field
set below carries a `consent` block asserting this mechanically.

---

## Recipe 1 — Open-Meteo current weather (no API key)

Free, keyless, no auth header, no rate-limit ceremony for personal use. This is the
recipe to reach for first.

**Allowlist entry:** `api.open-meteo.com`

```js
render_glasses_ui({
  kind: "text_surface",
  title: "Weather",
  body: "—",
  refresh: {
    recipe: {
      kind: "http",
      url: "https://api.open-meteo.com/v1/forecast?latitude=51.5072&longitude=-0.1276" +
           "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
      jsonPath: "$.current",
      timeoutMs: 8000
    },
    intervalMs: 900000,
    maxDurationMs: 7200000,
    onError: "keep_last",
    targets: {
      body: "{{temperature_2m | round:0}}°C  ·  {{relative_humidity_2m | round:0}}% RH  ·  " +
            "wind {{wind_speed_10m | round:0}} km/h"
    }
  }
})
```

**Why 15 min.** The API's own `current` block reports `interval: 900` — its data does not
change faster than that, so a shorter cadence buys nothing and costs the vendor. With
`maxDurationMs: 7200000` (the 2 h ceiling) the surface gets ~8 ticks before it times out;
leaving the 30 min default would give it two.

**Known fields** (after `jsonPath: "$.current"`). The set is **open, and determined by
your own `current=` query list** — request a field, get a field. Units for each come back
in a sibling `current_units` object, which `$.current` deliberately drops; hard-code the
unit in your template as above.

| template path | type | example | note |
|---|---|---|---|
| `time` | string | `"2026-08-19T00:45"` | local ISO, no zone suffix |
| `interval` | number | `900` | seconds; the vendor's own refresh rate |
| `temperature_2m` | number | `19.0` | °C by default |
| `relative_humidity_2m` | number | `73` | % |
| `wind_speed_10m` | number | `10.8` | km/h by default |
| `weather_code` | number | `3` | WMO code — needs a lookup table, don't paint it raw |
| `output` | object | — | the whole `current` object |
| `previous.<path>` | — | — | prior tick, for `| minus:previous.temperature_2m` |

**Verified live 2026-08-19** against `api.open-meteo.com/v1/forecast` — the shape above is
a real response, not a guess.

---

## Recipe 2 — GitHub Actions CI status

Latest workflow run for a branch. **Public repos, unauthenticated, by default.**

**Allowlist entry:** `api.github.com`

```js
render_glasses_ui({
  kind: "text_surface",
  title: "CI",
  body: "—",
  refresh: {
    recipe: {
      kind: "http",
      url: "https://api.github.com/repos/OWNER/REPO/actions/runs?branch=main&per_page=1",
      headers: { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      jsonPath: "$.workflow_runs[0]",
      timeoutMs: 10000
    },
    intervalMs: 120000,
    maxDurationMs: 3600000,
    onError: "keep_last",
    maxConsecutiveFailures: 3,
    targets: {
      body: "{{name | truncate:24}}  {{status}} · {{conclusion | default:\"running\"}}  #{{run_number}} {{head_branch}}"
    }
  }
})
```

**Why 2 min.** Unauthenticated `api.github.com` is **60 requests/hour per IP**, shared with
everything else on that host. 120 000 ms = 30 requests/hour, leaving half the budget. Do
not go to 60 000 ms "because it's still under the limit" — it is exactly the limit, and
per gap 2 above nothing honors `Retry-After` when you cross it.

**`conclusion` is `null` while a run is in progress** — that is why the template pipes it
through `| default:"running"`. The `default` filter fires on `undefined`, `null`, and `""`
(`glasses-ui-template.ts:113-114`).

**If the branch has no runs**, `$.workflow_runs[0]` resolves to `undefined`; the tick is
still counted as a success and every field renders empty. Guard user-visible fields with
`| default:"—"` rather than assuming a failure will tell you.

**Known fields** (after `jsonPath: "$.workflow_runs[0]"`). Closed and stable — these are
the fields worth painting; the full run object carries more.

| template path | type | example | note |
|---|---|---|---|
| `name` | string | `"CI"` | workflow name; truncate for the HUD |
| `display_title` | string | `"fix: …"` | commit/PR title |
| `status` | string | `"completed"` | `queued` · `in_progress` · `completed` |
| `conclusion` | string \| null | `"success"` | **null until completed** — always `default:` it |
| `run_number` | number | `130` | — |
| `head_branch` | string | `"main"` | — |
| `head_sha` | string | `"95d3a1d…"` | 40 chars; `truncate:7` for a short sha |
| `event` | string | `"push"` | — |
| `html_url` | string | `"https://github.com/…"` | too long for a HUD line; don't paint it |
| `output` | object | — | the whole run object |

**Verified live 2026-08-19** against `api.github.com/repos/cli/cli/actions/runs`.

### Variable workflow-run list (B6)

The same endpoint can replace an existing list from its returned array. Do not add a
new surface kind and do not invent pagination: `itemsFromPath` preserves source order,
then clamps the replacement to 20 rows and 6,144 UTF-8 bytes. Any dropped tail is
reported with named diagnostics.

```js
render_glasses_ui({
  kind: "list_with_details_surface",
  title: "Recent CI",
  items: [{ label: "Loading", body: "Waiting for the first refresh" }],
  refresh: {
    recipe: {
      kind: "http",
      url: "https://api.github.com/repos/cli/cli/actions/runs?per_page=10",
      headers: { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
    },
    intervalMs: 120000,
    maxDurationMs: 3600000,
    onError: "keep_last",
    targets: {
      itemsFromPath: "$.workflow_runs[]",
      itemTemplate: {
        label: "#{{run_number}} {{name | truncate:40}}",
        body: "{{status}} · {{conclusion | default:\"running\"}} · {{head_branch}}"
      }
    }
  }
})
```

For `list_surface`, use the same two target fields with a label-only
`itemTemplate`. `itemTemplate.body` is only legal on `list_with_details_surface`.
An empty or non-array source keeps the last good list and returns a named failure.

### Auth handling — where the token lives, and why not here

The repo convention is unambiguous: **`.env` is the sole home for secrets, and
configuration is set through the CLI, never by editing files.** The http recipe path can
reach neither. There is no `${env.GITHUB_TOKEN}` expansion, no secret reference, no
`process.env` read — `headers` is a verbatim pass-through. So the *only* way to
authenticate a recipe today is to type the literal token into the tool call, which puts a
credential in the transcript.

Therefore:

- **Public repo → use the unauthenticated recipe above.** It is the supported path and it
  covers the common case (is `main` green?).
- **Private repo, or you need the 5000/hr authenticated budget → stop and tell the
  operator.** Do not paste a PAT into a recipe to make it work. The supported fix is a
  secret-reference mechanism in the recipe path that does not exist yet; proposing one is
  a change to the plugin, and it goes through the operator, not through a recipe.

If the operator has *already decided*, with full knowledge, to accept a literal token in a
tool call, the mechanics are: `headers: { "Authorization": "Bearer ghp_…" }`, same-origin
only — the header is stripped automatically if a redirect leaves `api.github.com`. That is
a description of how the code behaves, **not** a recommendation, and an agent must never
take that step on its own initiative.

---

## Recipe 3 — Home Assistant

### The SSRF-guard tension, stated honestly

**The guard is not a bug, and this recipe does not route around it.** Home Assistant
almost always lives on a private address — `http://homeassistant.local:8123`,
`http://192.168.1.x:8123`, `http://127.0.0.1:8123`. Every one of those is blocked, by
design, at two layers: the URL-form check rejects RFC1918 / loopback / link-local literals
before any DNS at all (`isForbiddenHttpDestination`, `glasses-ui-recipes.ts:150-223`), and
`safeLookup` rejects any *hostname* — `homeassistant.local` included — whose DNS answer
contains even one private address (`makeSafeLookup`, `glasses-ui-recipes.ts:99-124`). The
guard exists because an http recipe is agent-authored and therefore prompt-injectable:
without it, one poisoned page turns the wearer's HUD into a probe of the operator's LAN
and of `169.254.169.254`. **Do not weaken it.** There is no recipe-level opt-out to go
looking for — `allowPrivateNetworks` is a test-only seam that the production cron never
threads (`glasses-ui-tool.ts:706-712`) and that the recipe schema deliberately omits
(`glasses-ui-recipes.ts:313-323`). Do not propose disabling the guard, adding a
private-range exception, exposing Home Assistant to the public internet, or standing up a
relay, as a step inside a recipe. Those are all **network-exposure changes**, and the
standing rule is that they need Matty's explicit CONFIRM before anyone builds them — not a
note in a doc, not an inferred go-ahead, not "the user asked for HA on the HUD so
obviously they meant this." What follows is split accordingly: what works today entirely
within the guard, and where the confirm-gated path begins.

### What works today, inside the guard

If Home Assistant is **already** reachable on a public hostname that resolves to a public
IP, nothing is being weakened and the recipe is ordinary. The two common shapes:

- **Nabu Casa Cloud** — `https://<instance-id>.ui.nabu.casa`, HA's own remote-access
  product. Public DNS, public IP, TLS terminated by the vendor.
- **An existing public reverse proxy** the operator already runs and already trusts.

Either way, allow the public hostname. An owner grant is the exact instance or proxy host.
An operator may instead configure `.ui.nabu.casa` for the first shape (the dot-anchored
suffix pattern covers instance subdomains), or the exact proxy hostname for the second.

```js
// Requires: HA already publicly reachable (Nabu Casa or an existing operator-run proxy),
// the exact host allowed by the phone owner or operator, and a long-lived access token
// the operator chose to accept in a tool call (see the auth note in Recipe 2 — the same
// no-secret-reference gap applies, unchanged).
render_glasses_ui({
  kind: "text_surface",
  title: "Study",
  body: "—",
  refresh: {
    recipe: {
      kind: "http",
      url: "https://INSTANCE.ui.nabu.casa/api/states/sensor.study_temperature",
      headers: { "Authorization": "Bearer <long-lived-token>", "Content-Type": "application/json" },
      jsonPath: "$",
      timeoutMs: 10000
    },
    intervalMs: 60000,
    maxDurationMs: 3600000,
    onError: "keep_last",
    targets: {
      body: "{{attributes.friendly_name | default:\"Sensor\"}}  {{state}} {{attributes.unit_of_measurement | default:\"\"}}"
    }
  }
})
```

`GET /api/states/<entity_id>` returns one state object:
`{ entity_id, state, attributes: {…}, last_changed, last_updated, context }`. `state` is
**always a string** — `"21.4"`, `"on"`, `"unavailable"` — so `| round:1` is a no-op on it
(`round` returns the value unchanged when it isn't finite, and a numeric string coerces,
so `{{state | round:1}}` does work for numeric sensors; `"on"` passes through untouched).

**Known fields** (after `jsonPath: "$"`, i.e. the whole state object). The top level is
closed; `attributes.*` is **open — it varies per entity and per integration**, so the lint
must not treat an unrecognized `attributes.*` path as an error.

| template path | type | example | note |
|---|---|---|---|
| `entity_id` | string | `"sensor.study_temperature"` | — |
| `state` | string | `"21.4"` | always a string, even for numbers |
| `last_changed` | string | ISO 8601 | — |
| `last_updated` | string | ISO 8601 | — |
| `attributes.friendly_name` | string | `"Study Temperature"` | present on most entities, not guaranteed |
| `attributes.unit_of_measurement` | string | `"°C"` | sensors only |
| `attributes.device_class` | string | `"temperature"` | sensors only |
| `attributes.*` | any | — | **open set** — integration-defined |
| `output` | object | — | the whole state object |

**Not verified live** — no Home Assistant instance was reachable from this session. The
field names above are HA's documented REST state shape; re-check against the operator's
instance with one manual request before trusting a template.

**Why 60 s.** A HUD sensor card is an ambient glance, and HA state is push-updated
internally — polling faster only loads the operator's own box. Never use HA as a reason to
approach the 1000 ms floor.

### Where the confirm-gated path begins

Everything below this line is **blocked pending Matty's explicit CONFIRM**, and no agent
may take any of it as a step:

- Adding any private-range or loopback exception to the SSRF guard.
- Adding a private hostname or `.local` name through `httpAllowHosts` or a phone grant
  (neither works — host approval is an *additional* gate, not an override of the SSRF
  guard, which still rejects at DNS).
- Exposing an existing LAN-only Home Assistant to the internet — port forward, tunnel,
  new reverse proxy, new Nabu Casa subscription.
- Any local-relay or side-channel scheme whose purpose is to get private-network data past
  the guard.

The correct move when a wearer wants a LAN-only sensor on the HUD: say plainly that the
http tier reaches public hosts only, by design; name Nabu Casa / an existing public proxy
as the in-guard option; and stop. **Never** actuate any of the above and report it
afterwards.

**Actuating Home Assistant is out of scope entirely.** `POST /api/services/...` is
schema-legal (`POST` is an allowed method), but a refresh recipe fires on a *timer*, and a
timer firing is not consent. Do not put a service call in a refresh recipe. Toggling a
light belongs to an explicit tap outcome, with `staleAfterMs` set, handled in your turn —
never on a tick, never on expiry.

---

## Pre-flight checklist

1. Is `glassesUiLive.httpEnabled` explicitly false? If so, `refresh_disabled` is a hard off.
   Otherwise render: an unlisted host under `owner-grants` waits for phone approval and
   starts automatically; do not retry or ask the wearer to ask again.
2. Is the host public? Private/loopback/link-local is blocked by design — see Recipe 3.
3. Is `method` `GET` or `POST`? Nothing else validates.
4. Does the cadence match the data's real update rate and the vendor's rate limit —
   not the 1000 ms floor?
5. Does `maxDurationMs` leave room for a useful number of ticks at that cadence?
6. Do template paths use `.0` indices (not `[0]` — that is `jsonPath` syntax), and does
   every nullable field have a `| default:`?
7. Is there any credential in `headers`? If yes, stop and re-read the auth section.
8. Does anything happen on expiry other than the surface disappearing? If yes, redesign —
   silence is never consent.

## Rejection codes you will actually see

| code | cause |
|---|---|
| `refresh_disabled` | `glassesUiLive.enabled` or `httpEnabled` is false |
| `refresh_host_consent_required` | default owner-grants flow: the phone owner may approve this exact host; the held surface starts automatically, so do not retry |
| `refresh_host_not_allowed` | unlisted host under `operator-only`, or a host the owner denied or removed |
| `refresh_invalid_recipe` | missing/blank URL or hostname, non-HTTP(S) scheme, method other than `GET`/`POST`, or bounds failure |
| `refresh_interval_too_low` | `intervalMs` < 1000 for http |
| `refresh_interval_too_high` | `intervalMs` > 3 600 000 |
| `refresh_duration_too_high` | `maxDurationMs` outside 10 000–7 200 000 |
| `refresh_template_invalid` | template over 4096 chars, unknown filter, malformed filter arg |
| `recipe_failed` (+ `failureReason`) | smoke tick failed, breaker fired, or `onError:"stop"` |

Runtime `failureReason` strings worth recognizing: `http recipe destination blocked: …`
(SSRF guard, URL form), `http recipe error: … SSRF guard: <host> resolves to <ip> …`
(SSRF guard, DNS layer), `http recipe destination not in allowlist: …`,
`http recipe got status <n>`, `http recipe timeout after <n>ms`,
`http recipe got <3xx> with no Location header`.
