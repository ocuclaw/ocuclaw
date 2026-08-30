# OcuClaw ↔ Node runtime control link (NDJSON over stdio)

Normative envelope for the Hermes bundle's control link (ADR-0003). The
Python parent (`control_link.py`) and the Node child
(`extensions/ocuclaw/src/runtime/hermes-control-link.ts`) each pin these
values in code; both test suites assert them so cross-language drift fails a
gate. Bridge-plane frame semantics (sessions/models/dispatch/liveui lanes)
are governed by the adapter contract map, not this file — this file owns only
the envelope, handshake, RPC skeleton, and process discipline.

## Transport discipline

- Python spawns the Node child (`asyncio.create_subprocess_exec`). Default
  argv: `node <bundle>/dist-cjs/runtime/hermes-runtime-entry.cjs`; override
  via `platforms.ocuclaw.extra.runtimeCommand` (argv list, or string that is
  shlex-split).
- Child stdout is protocol-owned: NDJSON frames only, one JSON object per
  `\n`-terminated UTF-8 line. ALL child logging goes to stderr (the parent
  pumps stderr lines into the gateway log with an `[ocuclaw-runtime]`
  prefix).
- Pipe EOF / process exit is the death signal in both directions. The child
  exits clean on stdin EOF and on SIGTERM; the parent treats stdout EOF as
  child death, fails all pending RPCs, and marks the platform disconnected.
- Bounded teardown: parent sends SIGTERM, waits `terminateGraceS`
  (default 5s), then SIGKILL. This sits inside the gateway's own teardown
  bound (configurable there; ≤0 disables that outer bound, the per-child
  grace still applies).
- **The child environment is an allowlist, never inheritance** (#1331; locked
  boundary #1270). `default_child_env()` filters its source through
  `CHILD_ENV_ALLOWLIST` in `control_link.py` and adds the two typed
  `OCUCLAW_LINK_*` controls, which are synthesized from adapter settings rather
  than read from the parent. No secret is on the list and none may be added:
  every credential the child uses is delivered over `link.hello.ack` (see
  [Config keys](#config-keys-pinned-d7d11)), so the environment is not a
  credential channel. Filtering applies to an explicitly supplied `base_env`
  too — there is no route around it.

## Constants (cross-language contract)

| Constant | Value |
|---|---|
| `LINK_PROTOCOL_VERSION` | `1` |
| `LINK_MAX_LINE_BYTES` | `1_048_576` |
| `LINK_TRUNCATION_HEAD_CHARS` | `2_048` |
| handshake timeout (default) | `10s` |
| terminate grace (default) | `5s` |
| debug-store category | `hermes.link` |
| RPC method-not-found code | `-32601` |

Child exit codes: `0` clean (stdin EOF / SIGTERM), `1` fatal, `3` handshake
timeout, `4` protocol version mismatch, `98` reserved for listener bind
failure (`EADDRINUSE` fail-fast once the relay boots in-child; spec
§Bundles).

## Frames

Every frame carries `v` (protocol version) and `type`:

- `link.hello` (child → parent, first frame on boot):
  `{v, type, payload: {pid, runtimeName: "ocuclaw-runtime", liveui?}}`
  where `liveui.tools[]` advertises the `render_glasses_ui` descriptor
  single-sourced from the TypeScript tool schema.
- `link.hello.ack` (parent → child, completes the handshake):
  `{v, type, payload: {hermesVersion, platform: "ocuclaw", config: {wsPort,
  wsBind, …}}}` — the config object is the adapter's resolved settings; the
  child ignores unknown keys.
- `link.rpc.request` (either direction): `{v, type, id, method, params?}`
- `link.rpc.response`: `{v, type, id, ok: true, result}` or
  `{v, type, id, ok: false, error: {code, message}}`. Unknown methods are
  rejected with code `-32601`, message `method not found: <m>` (the JSON-RPC
  shape bridge callers already detect on the openclaw path).

Handshake: child emits `link.hello` immediately, accepts nothing but
`link.hello.ack` until acked (other frames are dropped and counted), and
exits `3`/`4` on timeout/version mismatch. The parent aborts and reaps the
child on the mirror-image failures. W01 registers exactly one method on the
child (`link.echo`, params echoed back); the parent issues an echo probe
after every handshake as the connect receipt. W06 adds the child→parent
`runtime.ready` RPC (sent once the in-child relay is BOUND): whenever a
relay boot is expected (`relayToken` set), `connect()` additionally gates
on it (`runtimeReadyTimeoutS`, default 30s) so a bind failure surfaces as
a FAILED connect — never a transiently-connected platform. Link-only lanes
skip both the boot and the gate.

## Bridge db lane (W05 — sessions plane)

Child → parent RPCs serving the bridge's sessions plane. Python side:
`session_rpc.py` (SessionDB glue; reads on a read-only `mode=ro` SessionDB,
title/delete writes on a writable instance, with one lazy cached handle per
served profile namespace). Node side:
`hermes-gateway-bridge.ts` (all OcuClaw-shaping: public keys, seconds→ms,
conversational shaping, describe/compaction synthesis). Timestamps on this
lane are **unix seconds** (hermes-native); the Node bridge owns the ×1000.

| Method | Params | Result |
|---|---|---|
| `db.sessions.list` | `{limit?, search?, keyIdentity?}` | `{sessions:[{id, sessionKey, source, lineageRootId, lastActive, title, preview, messageCount, model?, modelProvider?, unread?, hidden?}]}` — `model` and `modelProvider` (`sessions.billing_provider`) preserve active-provider attribution across reconnects; in multiplex mode merges newest-first across every served profile DB (a missing profile DB is skipped); outside multiplex opens ONLY the default DB and preserves legacy results; deny trio `tool`/`cron`/`subagent` excluded server-side; `search` = title/preview substring; `keyIdentity` = parsed public-key identity for exact-key hydration (the bridge sends it INSTEAD of `search` when the term parses as a `hermes:` key — session-service looks up the current session via `sessions.list({search: sessionKey})`), resolved via the INDEXED identity lookups + exact-id rich-row fetch (never a bounded recency scan); text search scans a wide window; the limit bounds RESULTS. Rows additionally carry `unread: boolean` and `hidden: boolean` only when the host row carries those keys (the per-row `in row` gate `lastActivityDescription` already uses); on a host whose sessions schema predates them the keys are absent and the wire remains byte-identical apart from independently available model attribution |
| `db.sessions.search` | `{query, limit?}` | `{available, matches:[{session:<list-row>, role, snippet}], truncated, reason?, unavailableProfiles?, failedProfiles?}` — one read-only SessionDB FTS search per served profile, merged newest-first; projects compression ancestors to their visible tips, excludes reset-shadowed carriers and the deny trio, dedupes with the list identity, includes foreign rows, and bounds returned results globally. Full and partial capability failures use distinct reasons (`fts_unavailable`, `fts_probe_unavailable`, `search_failed`, `partial_search_unavailable`) instead of masquerading as zero matches. |
| `db.sessions.resolveKey` | `{key, ns?}` (raw hermes session id) | `{row: <list-row shape>}`; explicit `ns` resolves only that served profile, while omitted `ns` scans every served profile DB and requires exactly one match; errors `no such session: <key>` or `ambiguous session key across profiles: <key>` |
| `db.sessions.setTitle` | `{identity, title\|null}` | `{ok:true}`; null/empty clears; UNIQUE collision surfaces as the RPC error |
| `db.sessions.setRead` | `{identity, read?}` (default `true`) | `{ok:true}`; stamps the `last_read_at` watermark on the whole compression lineage (`set_session_read`); `read:false` writes `0` = EXPLICITLY unread. Refused with `session read state unsupported on this hermes` when the lane is unsupported |
| `db.sessions.setHidden` | `{identity, hidden}` | `{ok:true}`; `set_session_hidden` per carrier. Same unsupported-host refusal |
| `db.sessions.delete` | `{identity}` | `{deleted:[ids]}` — deletes the whole compression lineage tip→root |
| `db.chat.history` | `{identity, limit?}` | `{messages:[{id, role, content, timestamp?, platform_message_id?}], sessionId, total}` — conversational rows ONLY (user/assistant with content) across the compression lineage; the public `SessionDB.get_messages_as_conversation(tip, include_ancestors=True)` projection remains authoritative for filtering/content, then a serialized private-connection read enriches rows with stable `messages.id` metadata; unavailable/divergent identity metadata logs a warning and degrades that session to derived ids. Rows are tail-sliced server-side to `limit` so bounded pages never risk the 1 MiB frame cap; content is scalar-or-block-list; the Node bridge re-shapes defensively over the same pinned shape. `total` is the **pre-slice** conversational row count, so `total > messages.length` is the only honest signal that the head was cut (the bridge forwards it and the relay renders one `— earlier messages not loaded —` notice). Deliberately no `offset`: no load-earlier affordance exists in composeApp or the plugin, and the slice stays tail-anchored |
| `db.sessions.describe` | `{identity}` | `{model, tokens:{input,output,cacheRead,cacheWrite,reasoning}, lastMessageTokenCount?, messageCount, costUsd}` — `lastMessageTokenCount` is the public persisted `SessionStore.lookup_by_session_id(...).last_prompt_tokens` current-context count; omitted when that sanctioned read is unavailable (the child marks occupancy unknown and never substitutes cumulative billed totals). `costUsd = COALESCE(actual_cost_usd, estimated_cost_usd)` (upstream's own reaping filter uses the same coalesce, `hermes_state.py:8171`), `null` when neither column is present or populated |
| `db.sessions.compactionInfo` | `{identity}` | `{hops}` — compression-chain hop count (in-place compactions invisible: documented undercount) |

**Identity** (Node parses public keys; Python never sees `hermes:` keys):
`{ns, chatId}` for minted keys, `{ns, remainder}` for foreign/external keys.
Explicit identities select that namespace's isolated
`get_profile_dir(profile)/state.db`; hook lookups that carry only a native
session id resolve `get_hermes_home()` at call time while the gateway's
profile runtime scope is active.
Minted keys resolve ONLY via the exact DM-shaped native key
`agent:<ns>:ocuclaw:dm:<chatId>` (any other ocuclaw arity derives as a
foreign key — parse/derive symmetry). Resolution order for `remainder`:
(1) native session_key reconstruction `agent:<ns>:<remainder>` (exact
indexed lookup), (2) `<source>:<rootId>` external-root interpretation (root
row must match the source; **default-lane `main` namespace ONLY** — the
grammar never derives external-root keys under any other namespace, so no
other ns may cross into default-lane rows). session_key is a NON-unique index — duplicate
carriers (reset/re-created chats) resolve newest-first (`started_at DESC`,
matching hermes's own recovery lookups). The resolved row is walked to the
live transcript id via `resolve_resume_session_id` per request — no lookup
table (ADR-0004).

**Public-key grammar** (single owner: `hermes-session-keys.ts`; profile
segment = the hermes session-key NAMESPACE segment — literally `main` for
the default lane, per `_session_key_namespace`). Non-main namespaces are
routable when gateway multiplexing is enabled and the mapped profile is in
the gateway's served-profile set:

- minted `hermes:<ns>:<chatId>` (ocuclaw-platform rows,
  `agent:<ns>:ocuclaw:dm:<chatId>`; chatId is a single colon-free segment;
  the bare marker `x` is reserved)
- foreign `hermes:<ns>:x:<remainder>` (remainder = session_key minus
  `agent:<ns>:`, variable arity kept whole)
- external root `hermes:main:x:<source>:<lineageRootId>` (rows without a
  platform-shaped session_key: CLI/TUI/api/…; rootId = compression-lineage
  ROOT id, stable while the transcript id rotates)

### Session read/hidden state (`session_read_state`)

Two view-state flags upstream added after the 0.20.0 floor:
`sessions.last_read_at` (a read WATERMARK) and `sessions.hidden`, with the
`SessionDB` primitives `set_session_read` / `set_session_hidden` /
`session_unread` (`hermes_state.py:8340`/`:8394`/`:8455` @ `v2026.8.19`; all
four absent at `v2026.8.3`). `list_sessions_rich` derives `row["unread"]` per
surfaced conversation and drops hidden rows unless `include_hidden=True`.

**Detection** — `session_rpc.session_read_state_supported()`, once per
process, never a version string: the running hermes's own `SCHEMA_SQL`
`sessions` columns (read with `SessionSchemaMixin._parse_schema_columns`, the
same parser the read probes use) must contain `hidden` and `last_read_at`,
AND `SessionDB` must expose all three primitives. Any exception → False, and
the whole lane goes inert. It touches no DB, so it is valid at `register()`
time. `_setup_status()` reports it as the sibling key `sessionReadState`.

**Read stamps are owned by the Node runtime, not by Python.** The adapter
stamps nothing — no `on_session_end` write, no list-time write. The runtime
issues `setRead` on exactly two triggers: a successful session OPEN (switch),
and the turn-end boundary of the CURRENT session. A reply landing in a
session the wearer has switched away from stays unread on purpose. The
phone's "Preview" is NOT an open and stamps nothing.

**Watermark semantics.** NULL = never tracked = READ, so shipping the column
never badges a whole history at once: a row can only show as unread AFTER
something (OcuClaw, or the desktop) stamped it once. `0` = explicitly unread.

**Hide is a PHONE action.** The only OcuClaw surface that issues
`setHidden` is the phone sessions-tab action sheet (glasses: glyph only — G2
list scroll events are boundary-only, so the app can never know which row the
firmware highlights and a row cannot be targeted from the tap-hold menu).

**`hidden` is GLOBAL**, not an OcuClaw-local view flag: upstream's own
wording is "don't show in the global Sessions sidebar", so hiding from the
phone hides from the desktop too, and there is no unhide on glasses or
phone — unhide is desktop sidebar / gateway `PATCH /api/sessions/{id}`.
Hiding a MINTED identity flips every row sharing its native session_key, not
just the resolved tip: a `/new` reset mints a fresh carrier on the same
deterministic key, so hiding the tip alone would resurface a stale pre-reset
carrier on the next list. Foreign identities flip the resolved tip's lineage
only. A fresh `/new` carrier minted AFTER a hide is visible (native
semantics). The `keyIdentity` hydration path passes `include_hidden=True`
(only when supported — the kwarg does not exist at 0.20.0) so the glasses'
active session still hydrates, reporting `hidden: true`, instead of silently
vanishing when it is hidden from the desktop.

## Foreign session lane (sanctioned policy — 2026-07-08)

All-platform session list/history survives. Foreign-session mutation is
copy-only, plus the two view-state flags `read` and `hidden` — public
`SessionDB` primitives upstream's REST applies to any session; they flip list
presentation only, never transcript, turn, title, or lineage. `hidden` is
global (the desktop sidebar too) and unhide is desktop-only.
Adoption ("Continue here"), send-via-origin/injection,
`deliverReply`, and foreign-turn busy aliases are retired until Hermes exposes
public primitives for them. The runtime advertises
`foreignSessions.copy=true` and `adopt=false`/`inject=false`; callers must
treat the retired methods as unsupported.

Child → parent RPCs:

| Method | Params | Result |
|---|---|---|
| `foreign.sessions.copy` | `{identity, publicKey, target:{ns,chatId}, targetPublicKey}` | `{status:"accepted", sessionId, session}` or `{status:"rejected", error}` |

Copy-to-glasses is public composition only. Node parses the source public key
and Python resolves the live source tip through the public session DB facade.
Both source and target namespaces must be served, and they must be identical;
cross-profile copy is rejected.
Python then creates a fresh OcuClaw DM row using Hermes' writer API and a
plugin-generated unique key (`copy-<uuid>` / `ocuclaw_copy_<uuid>` shape), and
appends each conversational user/assistant row through the same writer API.
The requested target chat id is never reused as the created session key, so
the non-unique native session-key index cannot collide with an existing row.

Copy rows keep ordinary `parent_session_id` lineage to the source tip so the
session browser can show them, but the plugin writes no Hermes DB marker or
provenance bookkeeping. There is no sidecar database today because no
surviving feature needs private bookkeeping after adoption and injection were
removed. The accepted loss is that the copied row receives a fresh
`started_at` timestamp rather than the source row's exact timestamp.

## Gateway read lane (W07 — models/status/config plane)

Child → parent RPCs serving the bridge's models-status-config plane. Python
side: `models_rpc.py` (in-process hermes reads; every handler runs off the
event loop via `asyncio.to_thread`). Node side: `hermes-gateway-bridge.ts`
owns ALL OcuClaw-shaping (agents.defaults reprojection, seconds→ms ×1000,
usage window-label alignment, `eligible:true` synthesis). Timestamps on this
lane are **unix seconds** (hermes-native), same as the db lane.

| Method | Params | Result |
|---|---|---|
| `gw.models.list` | `{}` | `{models:[{provider, id, name, contextWindow, reasoning}]}` — enumerated through hermes's own provider lens (`CANONICAL_PROVIDERS` × `list_provider_models` × `get_model_info`), so `provider` is always a hermes provider slug that round-trips into `/model --provider`; catalog-hidden/noise models are filtered by hermes's own policy; `contextWindow`/`reasoning` omitted when models.dev has no data; empty catalog (cold cache, offline) ⇒ `{models: []}` |
| `gw.models.configured` | `{}` | `{default:{id, provider?}\|null, fallbacks:[{id, provider?}], channelOverrides:[{id, provider?}]}` — from config `model`(`.default`/`.provider`), the `fallback_providers` chain (`get_fallback_chain` — hermes has NO `model.fallbacks` key), and `platforms.ocuclaw.channel_overrides`. The bridge reprojects into the `config.agents.defaults.{model,models}` shape `resolveConfiguredModelRefs` reads; hermes has no imageModel/alias config so `imageModel` is OMITTED (callers tolerate absence) and `models` is `{}` |
| `gw.usage.status` | `{}` | `{updatedAt, providers:[{provider, displayName, windows:[{label, usedPercent, resetAt?}], unavailableReason?}]}` — `fetch_account_usage` per candidate provider (candidates = configured-default ∪ pool-credentialed, ∩ the 3 routable providers anthropic/openai-codex/openrouter). Only finite `usedPercent` windows cross the wire; absent percentages become an honest `unavailableReason`, never `0% used`. `resetAt` is unix seconds, omitted when Hermes has none; labels are Hermes-native prose, with one truth-preserving Codex correction: Hermes currently calls `primary_window` "Session" even when its reset is more than five hours away and therefore can only be the weekly allowance, so that proven case crosses as `Weekly`. The BRIDGE aligns labels to the `normalizeWindowKey` patterns (`(Current )session` → `5h`, `(Current )week(ly)` → `week`, others verbatim → slug keys) |
| `gw.auth.status` | `{}` | `{providers:[{provider, profiles:[{type}]}]}` — from the persisted credential pool (`read_credential_pool`); credential-level `auth_type` maps `oauth`→`"oauth"`, `api_key`→`"token"` (pooled api-key entries ARE rotation members — the consumed semantic is pool size, and OcuClaw counts only oauth\|token); providers with zero pool entries are omitted |
| `gw.agent.identity` | `{ns}` | `{agentId, name}` — `agentId` = PROFILE name (`ns` `main` ⇄ profile `default` mapping happens HERE, the single crossing point); `name` parsed from the profile's SOUL.md first line (`You are <name>, …` heuristic, bounded) else the profile name (default lane: "Hermes"). No emoji/avatar — hermes has no brand-asset source (consumers tolerate absence; the IDENTITY.md fallback probe then hits `gw.profiles.soul`) |
| `gw.profiles.list` | `{}` | `{profiles:[{name, isDefault, displayName?, model?, provider?, description?}], defaultProfile:"default"}` — `profiles.list_profiles()` verbatim (`name` stays the routing key; optional `displayName` is presentation only; ProfileInfo carries model/provider from the profile's own config.yaml) |
| `gw.profiles.soul` | `{profile}` | `{content}` — `get_profile_dir(name)/SOUL.md` (the same source as `GET /api/profiles/{name}/soul`); unknown profile ⇒ plain error (NOT `-32601` — a bad agentId must not latch `workspaceIdentityFilesUnsupported` for the whole connection) |
| `gw.skills.status` | `{}` | `{skills:[{name, description}]}` — `get_skill_commands()` rows; additionally filtered by `skills.platform_disabled.ocuclaw` (the scan's implicit platform scope is unset on this lane, so the per-platform filter is applied explicitly); the bridge synthesizes `eligible:true` (hermes filters disabled at scan) |
| `gw.commands.list` | `{}` | `{commands:[{name, description, category, source, instantSend, noTrailingSpace, busyPolicy, argsHint?, aliases?, subcommands?}]}` — COMMAND_REGISTRY rows filtered by `_is_gateway_available(cmd, _resolve_config_gates())` (every non-`cli_only` command, plus `cli_only` commands whose `gateway_config_gate` dotpath is truthy — the INVERSE of the TUI's `commands.catalog` filter, which drops `gateway_only` because it serves the CLI); two lane-local suppressions (`start`, `topic` — platform plumbing, not addressable from the composer); `_iter_plugin_command_entries()` appended as `source:"plugin"` rows (name-deduped). `name` is PRE-SLUGIFIED (lstrip `/`, `_`→`-`, lowercased) and IS the literal wire token, so `translateHermesSkillSlash` never has to rewrite a palette selection. `busyPolicy` is registry-native and is display state, not a filter. Skills are NOT included — they ride `gw.skills.status`. Absent/older hermes or a config-read failure ⇒ `{commands: []}` / gates closed. The bridge shapes these into the OpenClaw `commands.list` CommandEntry vocabulary (`/`-prefixed `textAliases`, `scope:"text"`, `acceptsArgs = !!argsHint`, category mapping `Session`→`session` / `Configuration`→`options` / `Info`→`status` / `Tools & Skills`→`tools`, `subcommands`→a single optional `args[0].choices`) |

## Visible command settings lane (sanctioned policy — 2026-07-08)

Silent per-session override RPCs are retired. The settings UI still exposes
model, thinking-effort, and reasoning-display controls, but the Hermes path
implements them as ordinary visible command turns sent through this adapter's
own session via `dispatch.send`. Hermes owns parsing, validation, warnings,
confirmation text, transcript visibility, and persistence semantics.

The phone/WebUI still sends `setSessionModelConfig` to the runtime. The
runtime's `sessions.patch` payload-A translator calls
`sessions.options.apply`, which invokes Hermes's public
`GatewayRunner.apply_session_options` boundary on the existing messaging
session. Initial defaults are silent and do not create a transcript turn.

| Input field | Structured option |
|---|---|
| `modelProvider`/`model` | `provider` / `model` |
| empty `model` | `model:""` (inherit) |
| `thinkingLevel` | `reasoning_effort` (`off` maps to `none`) |
| empty `thinkingLevel` | `reasoning_effort:""` (inherit) |
| `fastMode` | `fast` |

Hermes validates the whole patch before changing state, stores non-secret
session options in its own session store, and clears them on `/new`. OcuClaw
does not write global Hermes config or keep a second override file. A missing
host API returns `unsupported`; it never falls back to hidden or visible
command injection.

Presentation-only `reasoningLevel` changes still use visible `/reasoning
show|hide|clamp|full` commands. A deliberate one-turn model action still uses
visible `/model ... --once`. `verboseLevel` and `elevatedLevel` remain no-ops.

`dispatch.send` may still carry per-turn riders such as `thinking` for
Even-AI turns; those are turn metadata, not silent session override storage.
Sessions have permanent single-profile affinity: `agentId`, when supplied,
must match the target profile (`main` and `default` are equivalent for the
default lane; a named namespace matches that same named profile).

Secondary dispatch routing uses the default adapter instance and stamps
`SessionSource.profile`; the gateway enters its profile runtime scope for the
turn. Acceptance is:

| Gateway/profile state | Target namespace | Result |
|---|---|---|
| multiplex off or unavailable | non-`main` | reject: multiplex routing disabled |
| multiplex on | profile not in `profiles_to_serve(multiplex=True)` | reject: profile not served |
| multiplex on | served profile | accept; `agent:<ns>:ocuclaw:dm:<chatId>` ledger lane + `SessionSource.profile=<profile>` |
| either mode | `main` | legacy accept; no profile stamp and byte-identical `agent:main:...` key |

## Backend event lane (delivery pinned in W05; triggers live since W06)

Parent → child RPC `backend.event` `{name, payload}` → the child routes into
the bridge's event dispatcher (`bridge.on(name)` subscribers). Responds
`ok:true, result:null`. Unknown event names deliver to nobody (plain
broadcast bus; no EventEmitter zero-listener `error` special case).

Payload session identity: a frame may carry an explicit `payload.sessionKey`
(an opaque public-key echo the parent stored at dispatch — Python never
parses `hermes:` keys) OR `payload.sessionIdentity` `{ns, chatId}`; the
child's dispatcher derives the minted public key from `sessionIdentity` and
stamps `sessionKey` before fan-out (grammar stays single-owner in
`hermes-session-keys.ts`). An explicit `sessionKey` always wins.

Parent → child event `thinking` (W11 tier-2 reasoning frames) is additive and
safe for current clients to ignore. Update payload:
`{phase:"update", runId, sessionKey, text, delta?, seq?,
thinkingSummarySource, thinkingSignatureId?, source?}`. `text` is cumulative
per run, capped to the latest 8000 chars; `delta` is the most recent chunk when
available. `seq` is a per-run monotonic ordering stamp for THIS lane only —
never mirrored onto `activity`, whose own `seq` is an activityId-scoped
staleness guard downstream. Finalize payload:
`{phase:"finalize", runId, sessionKey, reason?, seq?}`. The child rebroadcasts
these as APP_PROTOCOL frames `ocuclaw.thinking.update` and
`ocuclaw.thinking.finalize`. Hermes-native updates are synthesized from
`post_api_request` (no `<think>` fallback), reading `assistant_message`
`reasoning`, `reasoning_content` AND the `reasoning_details[]` array — on
streamed chat_completions turns `.reasoning` alone is empty and reading it
alone means no frame at all.

### Thinking headline split (status bar vs body)

One `post_api_request` produces TWO frames with deliberately different jobs.

- `activity` is the STATUS-BAR frame. It carries a derived headline or nothing:
  `{state:"thinking", origin:"thinking", category:"thinking", phase:"update",
  runId, sessionKey, thinkingSummarySource, summary?}`.
  `_derive_thinking_headline` picks the first CLOSED `**bold**` span in the
  reasoning (`bold`), else a `reasoning_details[]` entry typed
  `reasoning.summary` that is genuinely one short line (`summary`), else
  nothing (`detail`). A headline is one markdown-free line, ≤80 chars.
  When the source is `detail` the frame carries NEITHER `summary` NOR any
  detail-bearing key (`thinking`, `reasoning`, `thinkingText`, `analysis`):
  the client honours an explicit source and would otherwise select the whole
  reasoning blob verbatim and paint truncated prose at summary rank. With no
  key at all it falls through to its generic "Thinking..." label.
- `thinking` is the BODY frame and carries the cumulative reasoning text. It
  never carries `summary`.
- Provider/model are NOT used to assert that a provider emits summaries;
  upstream's own discrimination is heuristic, so the derivation degrades to
  `detail` rather than manufacturing a headline out of prose.

### Tool liveness edge (`toolPhase`)

Tool activity frames carry `toolPhase:"start"` (from `pre_tool_call`) and
`toolPhase:"end"` (from `post_tool_call`). It is a SEPARATE field from
`phase`, which keeps its existing `start`/`update`/`error` meaning — flipping
`phase` to `"end"` would move terminal-activity-boundary semantics downstream.
`toolPhase` is the signal a client needs to know a running tool finished, so a
reasoning headline can be held back while a tool label is still true.

### Reasoning deltas (`on_stream_*`, 0.20.5+, opt-in)

Registered ONLY when the host has the hooks AND
`plugins.stream_reasoning_deltas: true` is already in the config at startup.
Registering any `on_stream_*` hook flips hermes's process-wide
`_has_stream_consumers`, which changes the provider call shape for every
surface on that gateway — so an operator who did not opt in sees no transport
change. The key is read ONCE, at registration; upstream's own
`stream_reasoning_deltas_enabled()` re-reads config on every call, which is not
a per-delta budget.

- `kind == "reasoning"` only. `kind == "text"` is rejected on the handler's
  first line: the streaming transport already renders content deltas, and
  forwarding them here would double-render the reply.
- `surface`, not `platform` (same reason as narration).
- Identity is resolved ONCE per stream, on `on_stream_start`, and cached by
  `(session_id, turn_id)`; a SessionDB read per delta is not a budget.
- **Coalescer**: accumulate, flush on the first of ≥250 ms since the last
  flush, ≥200 accumulated chars, or a paragraph break; `on_stream_end` always
  flushes the tail. The hook worker has NO timer — it runs only when an item
  is dequeued — so the elapsed rule can fire no earlier than the NEXT delta,
  and the tail waits for the next delta or `on_stream_end`. A
  `post_api_request` also flushes any pending buffer for its run, so a dropped
  `on_stream_end` (the queue drops OLDEST under load) cannot strand a tail.
- Deltas are RAW fragments and concatenate without a separator inside one
  model call; two calls in one turn are separated by a newline.
- Update frame: `{phase:"update", runId, sessionKey, text, delta, seq,
  source:"hermes.on_stream_delta"}`.
- **Reconcile**: `post_api_request` is authoritative for its model call and
  runs INLINE on the agent thread, so it can beat deltas still sitting in the
  queue. It bumps a per-run epoch (deltas from a superseded stream are then
  dropped) and REPLACES exactly the text the deltas appended with its own
  snapshot — never appends a second copy of the same reasoning, never erases
  an earlier iteration of the same turn. A new `iteration` re-arms the stream
  context, so a lost `on_stream_end` cannot fence out the rest of the turn.
- **Finalize**: `{phase:"finalize", runId, sessionKey, reason, seq}`, emitted
  exactly once per model call by whichever of `on_stream_end` /
  `post_api_request` gets there first, and only when a pane was actually
  opened. `reason` is `"response_started"`, NOT `"stream_end"`: the client
  hard-finalizes a run on any other reason and then drops every later update
  for it, which would black-hole the reasoning of every model call after the
  first in a multi-tool turn. `"response_started"` is the soft finalize the
  pane reopens from — and it is the truth here, since what follows a completed
  model call is the answer. The run's hard finalize already happens downstream
  at assistant-message commit.
- Cron and non-interactive turns bypass streaming upstream, so
  `post_api_request` remains the floor there: the pane goes chunked, never
  dark.

### Progress notes (`on_interim_message`, 0.20.5+)

The agent's own mid-turn sentences ("Checking the logs first.") are a separate
kind of message from its answer. On a host whose hook vocabulary has
`on_interim_message`, the adapter registers it, tags the commit that carries
the sentence, and stamps that commit with the sentence's ORIGIN time.

**There is no status-bar rung.** The adapter used to emit
`{state:"thinking", origin:"narration", category:"narration", summary:…}` for
each sentence. #1619 retired it: with a real model hermes commits the interim
AFTER the tool activity frame, so the narration rung lost arbitration on every
single turn — 12 real-model dumps (pet sim-d, gpt-5.6-sol) contained zero
`origin:"narration"` frames, and the matching `agentProgressNotes: status`
setting value was indistinguishable from `off` while silently deleting the
sentence. A note now goes to the conversation, at its origin position, or
nowhere. `origin:"narration"` is a retired activity origin; no producer emits
it.

The hook filters on `surface`, NOT `platform` — stream hooks spell it that
way, and the shared turn-context filter (which reads `platform`) is vacuous
here, so an unfiltered pass would route another surface's narration onto the
glasses.

**Tagging is content-based, and both orderings are real.** The hook runs on a
plugin worker thread; the commit is produced by the stream consumer's asyncio
queue. The adapter keeps a per-run set of normalized narration texts and a
bounded per-run list of recently committed texts, both under `_thinking_lock`:

- hook first → the commit that later carries that text is stamped
  `messageKind:"narration"`;
- commit first → the adapter emits a RETAG on the existing `message` event:
  `{retag:true, runId, sessionKey, messageKind:"narration", text, originAtMs}`,
  with NO `content` (the commit it corrects already delivered that). It rides
  `message` rather than a new event name because the child's `BRIDGE_EVENTS`
  list is frozen, and because a retag is a correction to a message, not a new
  lane. A consumer distinguishes the two by `retag`.
  A retag also carries `id` — the message id of the commit it corrects (see
  "Message identity on commits" below) — and a consumer resolves by that id
  first. Whitespace-normalized `text` stays on the wire as the FALLBACK: a
  pre-#1691 host emits no id, and the prefix upgrade below is a text operation
  by nature. The commit may hold a PREFIX of the
  sentence rather than the sentence: hermes reveals a message to the platform
  at reading speed, and a flush lands whatever was revealed at that instant
  (`I'm about t`). A retag is therefore emitted when the sentence's own text OR
  a strict prefix of it was committed, and it carries the FINISHED sentence —
  the consumer matches a committed prefix inside the current turn and UPGRADES
  the message to the retag's text. The adapter closes the same gap on its own
  side wherever it can: a flush whose text is a strict prefix of a sentence the
  interim hook already reported is committed AS that sentence.

At 0.20.5 the same sentence may also arrive as an ordinary `send()` carrying
`metadata["_interim_send"] = True`. That is a SECOND signal into the same
normalized-text set, so whichever arrives first wins and the other is a no-op —
one rung, one tag. It is inert unless the narration hook was actually
registered: the tag makes the runtime drop the conversation page, and dropping
it with no capability advertised would delete the sentence with no row to
explain where it went.

`messageKind` is ROUTING ONLY. It never decides turn lifecycle — that is
`turnActive`'s job — so a 0.20.0 host with no hook emits the same commits
untagged and those turns still behave.

Tool-progress bubbles use the same routing field with
`messageKind:"tool_progress"`. This tag is lifecycle-based, not text-based:
`pre_tool_call` arms the next platform send for the run, and the adapter binds
the minted message id to that arm. The Node runtime treats the eventual commit
as ephemeral and never adds it to settled conversation history. This matters
because Hermes can flush the editable progress bubble after the final reply.

#### `originAtMs` — when the model wrote it (#1619)

A narration `message` commit (and its retag) carries
`originAtMs: <wall-clock ms>`: the instant the MODEL produced the sentence.

EVERY correlated commit carries `originAtMs` too — the wall-clock instant that
message's own first `send()` arrived (for a commit a fresh send FLUSHED, the
flushed message's stamp, not the flushing one's). An uncorrelated delivery
(no ledger record) is stamped NOW. Hermes commits lazily — on the next
`send()`, or on a run-end tail — so commit order is not authorship order, and
the tool-progress line otherwise lands after the tool OUTPUT it introduces. A
stamp equal to a message's own commit position moves nothing; it exists so a
later lazy commit has something to sort against. It is absent on any lane that
is not hermes, so every consumer must tolerate that.

It exists because commit order is not authorship order. Hermes flushes an
assistant message LAZILY, on the next `send()`; on a tool turn that next send
is the tool-progress line, so the note that says "I'm about to run `uname -a`"
commits after the command AND its output, and the page reads
command → output → "I'm about to run it" (measured, clip `03b` frame @16 s).
The consumer places the note at `originAtMs` instead of at the end.

Where the stamp comes from, in order of preference:

1. the first `on_stream_delta` with `kind:"text"` of the model call that wrote
   the message — literally when the model started writing it. One stamp per
   (stream, iteration); a new iteration re-arms it, and the stamps are claimed
   FIFO by the sentences of that run, because interim messages are produced in
   the same order as the calls that wrote them.
2. failing that (a host with no stream hooks, or a call that produced no
   content delta), the moment the adapter FIRST LEARNED of the sentence —
   through the hook or the `_interim_send` carrier, whichever came first. That
   is also the moment the sentence was painted as streaming text, so it is
   still authorship time, never the lazy commit.

Both carriers of one sentence report the SAME stamp: the origin is claimed
once, by whichever signal noted the text first, and stored per normalized
text under `_thinking_lock`.

The clock is `time.time()` — WALL clock, not monotonic — because the consumer
compares it against its own `Date.now()` arrival stamps. Adapter and Node
runtime share a host (and a container, on a pet), so it is the same clock.

### Message identity on commits (`id`, #1691)

Every assistant `message` frame the adapter emits carries `id` — the platform
message id it minted for that message, `ocuclaw-<process-nonce>-<n>`. It is the
SAME token hermes was handed back as `SendResult.message_id` and the same token
`DispatchLedger.note_edit` binds edits to, so one message answers to one id on
every lane it touches. It rides:

- `message_commit_event` — the commit itself. A commit the ledger FLUSHED
  because a fresh send opened carries the FLUSHED message's id
  (`previous_message_id`), exactly as it carries `previous_origin_ms`. A slash
  reply and the `ended_run_commit` grace path never pass through `note_send`,
  so both carry the id of the send that produced them.
- `message_retag_event` — names the commit being corrected.
- `uncorrelated_message_event` — no ledger record, so the caller passes the id
  it minted for that send (or mints one).

**Why it matters.** The Node consumer reads `data.id` and gives the display
entry `idSource:"server"`. Without it a hermes commit is `derived`, and ONE
derived entry drops the entire session off `ledgerV1` to the legacy flattened
Pages fallback — which is what put the newest message on the last page in
#1685. The process nonce is not decoration: a bare counter restarts at 1 with
the adapter, and after a gateway restart the new ids of a still-open session
would collide with ids its earlier messages already claimed in the consumer's
sequence-alias map.

**It is NOT the hermes SessionDB row id, deliberately.** The row id is minted
by hermes' own persistence lane after `send()` returns, so it is unknowable at
commit time; `platform_message_id` is an INBOUND column and hermes never
writes an outbound `SendResult.message_id` into it. So a message is
`srv:ocuclaw-<nonce>-<n>` while the session is live and `srv:<row id>` after
`db.chat.history` re-hydrates it. That change is safe and already the shipped
behaviour for user rows on the OpenClaw lane (live `srv:send:<clientSendId>` →
hydrated `srv:<server id>`): both sides publish a COMPLETE snapshot and the
client replaces its list wholesale, ordering by `seq`, never by matching old
ids against new. The cost of the change is confined to a hydrate boundary —
the sequence-alias map rebases, and reveal/page position resets — where the
stream is already gone and the page is already being rebuilt.

### `turnActive` on mid-turn commits

`message` commit payloads carry `turnActive:true` when the commit lands while
the run is still open: the `uncommitted_previous` flush inside `send()`, and a
`finalize=True` edit with no stashed tail closure (a segment/oversize break).
The run's CLOSING commit — the finalize that pops the closure, the deferred
tail fallback, the `ended_run_commit` grace path, and slash replies — never
carries it. Without the flag a consumer treats every runId-carrying commit as
turn end and tears the turn down mid-flight on any agent that writes more than
one message per turn.

## Session-control lane

Hermes 0.20 exposes native platform approval delivery and resolution seams.
The adapter implements `send_exec_approval`, mirrors each request to the
glasses approval HUD, and resolves its FIFO head through Hermes'
`resolve_gateway_approval`. It does not inspect private approval queues.
`post_approval_response` reconciles resolutions made through Hermes' typed
fallback so the mirrored HUD clears exactly once.

The mirrored countdown inherits Hermes' effective `approvals.timeout` value.
Hermes 0.20 defaults that setting to 300 seconds; an operator override wins.
Timeout and disconnect
remain implicit deny (silence is not consent). Smart-denied requests expose
only Once and Deny; ordinary requests expose Session only when Hermes marks
that scope available. Permanent approval remains absent from the glasses
decision set.

Hermes `clarify` requests use the shared adaptive glasses Question surface.
The parent emits backend event `clarify` with
`{id,sessionKey,question,choices,multiSelect,allowOther,deadlineSec}`. Pretext
chooses a compact checklist, packed pages, or a single-item reel once when the
prompt arrives. Single choices resolve as their label; multi-select choices
resolve as a JSON-array string through child → parent RPC `clarify.resolve`.
Open questions and `Other` use request-addressed `clarify.await_text`, which
calls `mark_awaiting_text(id)` so the next voice/text message answers that exact
pending request. Dismissal and expiry send no answer.

Child → parent RPC `sessions.abort` carries `{sessionKey, target:{ns,chatId}}`
and returns `{status:"accepted", aborted:boolean}`. The parent maps the target
to the native `agent:<ns>:ocuclaw:dm:<chatId>` key, interrupts any running
agent for that session, clears adapter activity state, and closes local
dispatch ledger records with `code:"cancelled"`. Idle aborts still resolve
accepted.

Child → parent RPC `sessions.steer` carries `{runId, sessionKey,
target:{ns,chatId}, message, idempotencyKey?, attachments?}`. It enters the
same native dispatch path as `dispatch.send`; the parent may return a `runId`
when it can correlate the injected turn, or omit it when Hermes native steer
absorbed the text without a fresh run id. The child preserves that partial
correlation gap.

## Dispatch lane (W06 — turn dispatch + runId correlation, plan D9)

Child → parent RPC `dispatch.send` — the ONE turn-dispatch lever for this
adapter's own session (main send, `/new` reset, `/compress`, wake, and visible
settings commands ride it).

Params (child mints and owns `runId` — hermes has no idempotencyKey→runId
echo; the mint is returned synchronously in the bridge ack and stamped on
every synthesized event of that turn):

| Field | Meaning |
|---|---|
| `runId` | child-minted correlation id (REQUIRED, non-empty) |
| `sessionKey` | opaque public-key echo for event stamping (parent stores, never parses) |
| `target` | `{ns, chatId}` minted-lane identity (foreign/external targets are W08) |
| `message` | verbatim text (slash included; see /new split below) |
| `idempotencyKey?` | dedup handle scoped by the native profile-qualified session key: a hit in that lane returns the ORIGINAL `{runId, status}` without re-dispatch; the same value in another profile is independent |
| `channelPrompt?` | → `MessageEvent.channel_prompt` (per-turn ephemeral system layer) |
| `attachments?` | `[{type, mimeType, fileName, content?|path?, source?, sizeBytes?, widthPx?, heightPx?}]` — `content` is inline base64 up to `LINK_ATTACHMENT_INLINE_MAX_CHARS = 262144` serialized chars; larger payloads are spilled by the child to a temp file and cross as `path`. The parent ingests bytes via hermes `cache_media_bytes` → `MessageEvent.media_urls` (LOCAL PATHS, parallel `media_types`) and unlinks the spill file after ingestion; the child unlinks on RPC failure. |

Result (in-band): `{status: "accepted"}` or `{status: "rejected", error}`,
plus optional `sessionState: "resume_pending"|"suspended"` read from the
persisted hermes session entry (spec §Error Handling: the two flags surface
DISTINCTLY — `suspended` wins and forces a fresh session; `resume_pending`
auto-continues). Two failure surfaces, deliberately distinct: a TRANSPORT
failure (link RPC error) rejects the bridge promise (census `/new` row —
"never swallowed"); a dispatch REFUSAL resolves with `status:"rejected"` +
`error` so strict-ack consumers (even-ai) report the real dispatch error.
The bridge ack is always `{runId, …status/error/sessionState}` — `runId` is
attached even on refusal so the even-ai strict check reaches the real error
instead of "missing a runId".

### D9 runId correlation table (DispatchLedger, parent-side, in-memory)

Record: `{run_id, idempotency_key?, session_key (native), public_key (echo),
kind: turn|slash, state: active|pending|rider, epoch, created_at,
last_activity_at, committed, riders[]}` — keyed `session_key → FIFO`, plus
a TTL'd `idempotency_key → record` dedup index.

- **Dispatch:** Head of an idle session → `active` (lifecycle
  `activity {state:thinking, origin:lifecycle, phase:start}` emitted BEFORE
  the handle_message dispatch — a fast slash turn can complete inside that
  await, and a post-await start would land after its terminal). Busy
  bookkeeping mirrors hermes's gateway `_queue_or_replace_pending_event`
  (#28503): TEXT follow-ups ride a FIFO — each gets its OWN turn in
  arrival order, so each keeps its OWN `pending` record and full
  correlation. Only the PHOTO/media-burst semantics merge into the head
  pending slot: a media-carrying dispatch always merges when a first
  pending TURN carrier exists (upgrading it to media-carrying), and a text
  dispatch merges only into a media-carrying carrier — merged dispatches
  attach as `rider`s, the one merged turn runs on the carrier's runId, and
  riders resolve with terminal activity only (never a duplicate commit).
  Slash-while-busy keeps its own pending record (bypass commands never
  queue — they cancel-close). Steer is never assumed: absorption is
  unobservable and hermes falls back to queue semantics in several paths —
  under actual steer a pending record becomes a janitor-closed phantom
  (accepted residual; waiter consumers carry their own timeouts).
  (`interrupt`, the hermes default, aborts the current turn — native
  semantics, not the adapter's.) A FAILED dispatch closes its records with
  `code:"dispatch_failed"` AND purges the attempt's idempotency entry so a
  retried requestId re-dispatches instead of replaying as accepted.
- **Stamping:** every synthesized `streaming`/`message`/`activity` event for
  a session carries the HEAD record's runId.
- **Turn completion (kind=turn):** `on_session_end` (fires at the end of
  every `run_conversation`, incl. errored turns; sync hook; payload has
  `session_id` NOT session_key → resolved via the indexed SessionDB
  `session_key` column). When the current stream message is still open,
  pop it synchronously, promote the next pending record immediately, and
  stash its tail closure outside the ledger: Hermes 0.20's StreamConsumer
  drains on its own task, so its trailing cumulative `finalize=True` edit can
  race this hook cross-thread. The trailing finalize and a 1.5-second fallback
  atomically claim that stash; the winner performs the single commit before
  terminal activity + `agent_end`. The finalize commits its authoritative
  full text, while the provider-abort fallback commits only uncommitted
  last-seen text. Already-finalized/no-message heads complete synchronously
  as before. A true orphan finalize with no claimable stash or owned ledger
  message NEVER emits and returns `success=False`; returning success for a
  drop would make Hermes suppress its normal final send. NO per-turn `history`
  push: a post-turn history REPLACEMENT duplicates the assistant message
  downstream (caught live in the W06 dispatch receipt). The message-commit
  lane IS the per-turn transcript mechanism; the `history` event lane stays
  delivery-ready for
  activation/compaction triggers (W07/W08).
- **Slash completion (kind=slash):** hermes slash turns (`/new`, `/reset`,
  `/compress`, …) run outside `run_conversation` and fire NO
  `on_session_end`; their reply is a single `adapter.send`. The first send
  while a slash record heads the session commits it (`message` event +
  terminal idle activity + pop/promote).
- **Platform completion:** every dispatched `MessageEvent` carries its private
  D9 run/session identity. Hermes calls `on_processing_complete` after final
  delivery and before it drains a queued successor, including failures that
  return before `run_conversation` and therefore emit no LLM/API/session-end
  hook. The callback atomically completes only its matching active head,
  commits any open final message, emits the processing outcome's correlated
  terminal activity, then promotes and starts the pending successor. If normal
  `on_session_end` or slash completion already closed that run, the callback is
  a no-op and cannot consume the successor.
- **Janitor:** records with no send/edit/hook activity for
  `staleTurnSeconds` (default 1800 — tool calls can legitimately run >10 min)
  are closed with a terminal error activity (`code:"stale"`) and popped;
  sweep cadence 60s. Any adapter send/edit for the session refreshes
  `last_activity_at`.
- **Restart:** the ledger is process-memory and the child dies with the
  parent — both sides reset together; in-flight runs are lost (hermes
  semantics, spec §Error Handling). The child emits `disconnected` on link
  EOF so run-waiters reject instead of hanging.
- **Retired foreign turns:** adoption and send-via-origin no longer use this
  ledger; copy-to-glasses creates a new OcuClaw session and future turns run
  as ordinary minted-lane turns.

### Session-reset normalization rule (/new and /reset)

Hermes `_handle_reset_command` DISCARDS trailing text (`/new some text`
ignores the remainder — run.py slash dispatch; `/reset` routes to the SAME
handler). OcuClaw's shared call sites append a welcome greeting for OpenClaw,
but the Hermes parent normalizes `/new <text>` and `/reset <text>` to the bare
command before creating its single slash record. It intentionally does not
synthesize a follow-up greeting turn: Hermes' destructive-command confirmation
may still be pending, and a separately dispatched remainder could otherwise run
in the conversation the wearer was asked whether to clear. Hermes' native reset
result is the complete response on this lane. Other commands remain verbatim.

## Streaming transport mapping (W06)

The hermes StreamConsumer drives the adapter with CUMULATIVE text (never
deltas): `send(chat_id, content, …)` opens a message (returns a minted
`message_id` in `SendResult`), `edit_message(chat_id, message_id, content,
finalize=)` updates it, `finalize=True` seals it (turn end AND segment/
oversize breaks). Mapping (per active ledger record):

- `send` → new current message → `streaming {runId, sessionKey, text}`; an
  uncommitted previous message commits first (defensive).
- `edit_message(finalize=False)` → `streaming` with the cursor suffix
  (default `" ▉"`) stripped.
- `edit_message(finalize=True)` → `message` commit
  `{sessionKey, runId, role:"assistant", content:[{type:"text", text}]}` —
  one commit per finalized message (multi-segment turns commit per segment,
  matching multi-message assistant turns). If `on_session_end` wins the
  cross-thread race, it pops the head, promotes the next run, and stashes the
  old tail closure for 1.5 seconds so this cumulative finalize can atomically
  claim the single authoritative full-text commit before terminal events.
- `send_or_update_status(chat_id, status_key, content)` (gateway
  status_callback route: compression / rate-limit / lifecycle notices) →
  `activity {origin:"status", state:<event-kind>, phase:"progress", detail,
  statusKey}` — never a chat commit, and `origin:"status"` keeps it off the
  terminal-boundary classifier.
- Adapter declares `MAX_MESSAGE_LENGTH = 60000` (avoid oversize splits;
  glasses paging owns long text) and `authorization_is_upstream = True`
  (the relayToken-gated Node relay IS the trusted authenticated upstream —
  non-internal MessageEvents pass the gateway sender-auth gate without the
  pairing flow).
- Streaming is config-gated in hermes (`display.streaming.enabled`, default
  false; transport `auto` → edit path for ocuclaw). With streaming off,
  replies arrive as one `send` and commit at `on_session_end` — both modes
  are handled.

### Tool-progress ownership for the Hermes beta

Hermes' conversational tool-progress renderer and OcuClaw's structured tool
activity are separate producers. OcuClaw owns the glasses activity surface
through the registered `pre_tool_call` and `post_tool_call` hooks; that path
does not depend on conversational progress bubbles. The beta therefore
requires this explicit per-platform host setting:

```bash
hermes config set display.platforms.ocuclaw.tool_progress off
hermes config get display.platforms.ocuclaw.tool_progress
```

Hermes 0.20 resolves the per-platform value ahead of the global setting and
normalizes the YAML boolean written for `off` back to the effective mode
`"off"`; the CLI readback is `false`. Its gateway then suppresses ordinary
tool-progress messages for OcuClaw while leaving tool execution, approvals,
the structured tool hooks, and other platforms unchanged. This is host
configuration, not a bundle default: installation and `hermes plugins update`
do not apply it automatically. The config-gated Hermes `/verbose` command can
change the same per-platform key and must not be used to re-enable progress
during beta validation.

The reason is ordering, not secrecy: with Hermes streaming disabled, a
pre-final tool-progress `send` can be the adapter's open stream head when
`on_session_end` runs. The 1.5-second deferred-tail fallback can then commit
that progress after the real final response, producing a late conversation row
and misleading `Running` state after an approval decision. Suppressing the
systematic tool-progress producer removes that beta trigger. Other independent
pre-final assistant/status sends can still reach the existing cosmetic
deferred-tail seam; hardening that seam and restoring richer progress belongs
to a post-beta structured activity surface, not this cut.

## Host hook lane (W06)

Parent → child RPC `backend.hook` `{name, event?, ctx?}` → the child's host
hook bus (`hermes-host-hooks.ts`) normalizes and fans out `(event, ctx)` to
`on(name)` subscribers — the OpenClaw-plugin-host hook surface the ×4
`agent_end` consumers (liveui finalize, title distiller, device-info,
location) subscribe to (they wire up in W12+). `ctx.sessionKey` may be an
explicit echo or derived from `ctx.sessionIdentity` (same rule as
`backend.event`). `agent_end` frames carry `ctx.sessionKey`,
`ctx.agentId?` (hermes profile namespace), `ctx.runId?` (the id of the
just-ended run, read off the dispatch ledger record — #1525) and
`event.messages?` (final conversational transcript read from SessionDB —
`on_session_end` itself carries no messages). `ctx.runId` is OPTIONAL: a
child that receives a frame without it falls back to the relay-side run
tracker (`runIdSource: "relay_tracker"`, honestly marked ambiguous under
overlapping runs), while a frame carrying it yields the exact
`runIdSource: "host_hook"`.

## Optional hook surface + feature advertisement

Hooks newer than the 0.20.0 floor (`on_interim_message`,
`on_stream_start`/`on_stream_delta`/`on_stream_end`) are FEATURE-DETECTED at
registration, never registered blind: `register_hook` on an unknown name warns
and stores it rather than raising, so a blind registration is log spam plus a
capability that can never fire. The probe is
`importlib.util.find_spec("agent.plugin_stream_hooks")` (find_spec, never
`import` — the module carries process-wide state) plus membership in
`hermes_cli.plugins.VALID_HOOKS`. None of the four names exist at
`v2026.8.3` (0.20.0); all four exist at `v2026.8.19` (0.20.5).

The adapter passes `OCUCLAW_HERMES_FEATURES` — a comma-separated subset of
`interim_hook,stream_hooks,session_read_state` — in the Node child's
environment. A token means "this adapter build ACTUALLY REGISTERED the
producing hook, OR will serve the advertised lane, on THIS host", not "the
host could support it": a client row that reads active for a hook nobody
registered is a claim the wearer cannot check. `interim_hook` and
`stream_hooks` are the hook kind; `session_read_state` is the lane kind — it
registers nothing and is feature-detected from the running hermes's sessions
schema + `SessionDB` primitives (see "Session read/hidden state"). On a
0.20.0 host the value is empty. `_setup_status()` reports `hermesHooks`
`{interimMessageAvailable, streamHooksAvailable, streamReasoningDeltas,
registered[]}` plus the SIBLING key `sessionReadState` (not a hook, so not a
member of `hermesHooks`) so an inactive row is explainable from one receipt.

## Liveui lane (W12 — render_glasses_ui glue)

The `render_glasses_ui` tool is registered by the Python parent only after
the child advertises its descriptor in `link.hello.payload.liveui.tools[]`.
Python never hand-copies the JSON Schema; it passes the child-provided schema
to `ctx.register_tool`. Session identity is task-local:
`get_session_env("HERMES_SESSION_KEY")` supplies the session key for render
and prompt glue. The model never supplies a session-key argument. Python sees
the native Hermes key (`agent:<ns>:ocuclaw:dm:<chatId>`); the child converts it
to the public OcuClaw key (`hermes:<ns>:<chatId>`) before storing surfaces,
settling `agent_end`, or dispatching wake turns. `pre_llm_call` prompt glue is
scoped to native OcuClaw sessions only.

Parent → child RPCs:

| Method | Params | Result |
|---|---|---|
| `liveui.render` | `{callId, sessionKey, args}` | `{result, content:[{type:"text", text:<JSON result>}]}` — Node owns the per-call listen window and consumes Layer A `createGlassesUiToolHandler` unchanged. |
| `liveui.abort` | `{callId?, sessionKey?, reason?}` | `{status:"accepted", aborted}` — aborts matching active render calls; Python sends this when the Hermes tool worker sees the cooperative interrupt flag or the render link deadline fires. |
| `liveui.prompt` | `{sessionKey}` | `{context|null, fragments:[...], fragmentsConcatenated, ephemeralOnly:true}` — Node composes Channel-2 state and previews owed voicemail into a plugin-generated JSON fence for Hermes `pre_llm_call`, which injects only into the current user message. |
| `liveui.promptAck` | `{sessionKey, ackToken}` | `{status:"accepted", consumed:boolean}` — Python sends the token returned by `liveui.prompt` only after receiving a prompt context that contains voicemail, so transport timeouts do not consume owed voicemail silently and ack cannot consume entries outside that preview. |

Child → parent RPCs:

| Method | Params | Result |
|---|---|---|
| `liveui.llmRecipe` | `{recipe, ctx}` | `{output}` or `{error}` — LLM refresh recipes execute through Hermes `ctx.llm`, so Node never receives raw provider credentials. |
| `liveui.llmAuth` | `{model}` | Compatibility-only `{status:"unavailable", provider:"hermes", model, apiKey:"", resolvedFromBackend:false}`; the accepted path is `liveui.llmRecipe`. |

Wake remains a normal `dispatch.send` turn. The Node wake controller first
uses the relay-side busy mirror (`isAgentTurnBusy`). No Python private
session-store busy probe is part of the sanctioned policy; if the relay mirror
is stale, Hermes handles the visible command/turn through its own public
session semantics.

## Plugin-owned full uninstall

Hermes 0.20's generic plugin removal deletes only the installed checkout, so
full product removal runs through `hermes ocuclaw uninstall` while that code is
still available. A retained disabled install must first be enabled so Hermes
registers the plugin-owned CLI. The command requires the gateway to be stopped,
removes only the exact OcuClaw config and secret keys, runtime files, pairing and first-run
receipts, setup bundle, and plugin checkout, then prints an uninstall receipt.
The shared Hermes session database and unrecognised files remain outside its
mutation set.

Final checkout removal preserves Hermes's own install-provenance transaction:
OcuClaw atomically parks the real checkout, invokes the documented
`hermes plugins remove ocuclaw` command against an empty proxy at the original
path, verifies that Hermes no longer records `ocuclaw` in its documented
`plugins/.install-metadata.json` sidecar, and only then removes the parked
checkout. This lets Hermes own its metadata without exposing OcuClaw secrets or
state to generic plugin removal. A failed host handoff restores the checkout
and command registration for retry; a failed parked-tree deletion prints the
interpreter-level recovery command.

A live route with current ownership proof stops the operation and returns the
single narrow `:8446` teardown command. Foreign, changed, and ambiguous routes
are preserved. The installed-checkout path guard must pass before any mutation,
and a required cleanup failure keeps the plugin checkout for a retry.

## Passive support snapshot lane (#1323 — provenance and bug attachment)

The existing authenticated app-role Send Bug Report flow may ask the child for
one host document while assembling its already-gated diagnostic bundle:

| Method | Params | Result |
|---|---|---|
| `connectionHealth.snapshot` | `{}` | exact passive `ocuclaw.connection-health-snapshot` v1 document, or `ocuclaw.connection-health-error` v1 |

The Python parent runs the same collect → `derive_snapshot` seam as
`hermes ocuclaw status --json`. It never enters doctor, probes a route, mutates
host state, or changes admission. A failed derivation returns the versioned static
error document; the child never fabricates health. OpenClaw has no parent
method and attaches no `connection-health.json`.

`producer.hermesSource` has exactly three advisory states. `certified-source`
means package `0.20.6` and a complete clean checkout at the certified
`v2026.8.27` commit; `drifted` means a complete inspectable checkout differs;
`unknown` covers shallow/non-Git installs, missing objects or package metadata,
timeouts, and any inspection ambiguity, including partial/promisor clones. The
observed/certified short commits, shallow result, and cache timestamp use the
existing additive `evidence[]` seam. No snapshot
or doctor exit code depends on provenance.

## Presence lane (#1317 — phone connect/disconnect, contract #1273 §9)

Before this lane existed, Hermes only learned that a phone had connected by
asking on its own schedule, so for up to thirty seconds after pairing a
diagnosis could report `no-client` while the phone was connected. The lane
splits latency from truth:

- **Node pushes latency.** Every authenticated `app`-client connect and
  disconnect edge fires child → parent `presence.dirty`. The frame carries a
  monotonic `rev` and nothing else — no client names, ids, capabilities,
  session keys, addresses, or tokens cross this seam. It is a doorbell, so a
  lost push costs latency only.
- **Python pulls truth.** The parent acknowledges the push immediately, then
  performs at most one bounded (2 s) `presence.snapshot` pull at a time;
  pushes arriving during a pull coalesce into a single follow-up. A revision
  that is not strictly greater than the last one is answered
  `{ok, stale:true}` and does no work.
- **Pull is also the fallback.** The parent pulls every 30 s regardless, so a
  dropped, refused, or unsupported push degrades to the pre-hop latency
  rather than to silence.

Child → parent RPC:

| Method | Params | Result |
|---|---|---|
| `presence.dirty` | `{rev:<monotonic int>}` | `{ok:true}` immediately, or `{ok:true, stale:true}` for a replayed/out-of-order revision. Acknowledged before any pull or disk write, so a burst of connects cannot back up the link. |

Parent → child RPC:

| Method | Params | Result |
|---|---|---|
| `presence.snapshot` | none | `{relayListening, authenticatedAppCount, clientVersions[], lastTransitionAt}` — the narrow public-safe projection (#1273 §6), built by the relay supervisor rather than picked out of a readiness snapshot by the caller. Debug clients never count. |

When the child cannot observe its own relay (no relay object, a throwing
accessor, a malformed answer) **every fact is null**, including
`relayListening`. `relayListening:false` states an outage, and a failure to
observe is not one — reporting it as `false` would let the parent derive
`relay_not_listening` from nothing. `clientVersions` is capped on both sides
(≤8 entries, ≤32 chars, `[A-Za-z0-9._+-]`): the values are self-reported by
authenticated clients and every connected client contributes one, so an
unbounded list would let a client inflate each push into a large control
frame and a larger synchronous receipt write.

The parent writes the result to `<HERMES_HOME>/state/ocuclaw.app-presence.json`
(atomic, platform-hardened, exact-profile). On pull failure it writes a fresh receipt
with **null** app facts and an allowlisted `observationErrorCode`
(`pull_timeout | pull_failed | pull_unsupported | link_down | shutdown`); it
never refreshes old client truth, because the snapshot's freshness rules would
then read a stale count as a current fact. Clean shutdown writes
`relayListening:false, authenticatedAppCount:0, observationErrorCode:"shutdown"`.

`presence.dirty` is registered on the parent side **before** `link.start()`:
a phone already connected while the relay boots pushes during the handshake
window, and a `-32601` there would cost exactly the delay this lane removes.

## Pairing-completion lane (#1322 — private Attempt binding)

The relay's existing authenticated-hello path hands the phone's sealed
completion confirmation to the pairing state machine. Only after the state
machine authenticates the confirmation, marks credential delivery proven,
atomically consumes the pending completion record, and destroys exchange key
material does the Hermes child emit this internal event:

| Method | Params | Result |
|---|---|---|
| `pairing.completed` | `{completionId}` | `{ok:true}` after Python atomically records `<HERMES_HOME>/state/ocuclaw.pairing-completion.json`; `{ok:false,error:"invalid_params"\|"receipt_unavailable"}` otherwise. |

At authenticated consumption, Node generates `completionId` from 32 CSPRNG
bytes and encodes it as canonical unpadded base64url (43 characters). It is the
request's only field and is secret-free: no nonce, exchange id, phone label,
client metadata, session key, address, or credential crosses the link. Python
stores that same ID in the exact private receipt
`{v:1,completionId,completedAt}`. Redelivery of the current ID is an idempotent
no-op.

Delivery is at least once within the Node process. The child keeps completion
IDs in a FIFO in-memory queue and retries each request until the adapter
acknowledges `{ok:true}`; there is no durable outbox. Receipt acknowledgement
never gates the already-authenticated phone pairing result and never causes
credential redelivery. The accepted residual is that Node process death after
authenticated consumption but before acknowledgement can leave the prior
receipt in place, so an armed Attempt remains bound to that prior ID until a
later completion is recorded. This is the explicit
[#1322 ruling](https://github.com/OcuClawhub/ev%65nclaw/issues/1322#issuecomment-5312651664).

This is an internal Node-to-Python control-link method only: it adds no phone
protocol-v3, QR, pairing plaintext, public snapshot, dashboard, status, doctor,
or support attachment field.

## Host-owned First-Run Proof handoff

Setup remains in the host Hermes conversation. The managed gateway process
observes successful delivery of a phone-origin turn, but the host `hermes` CLI
that runs `/ocuclaw-setup` is a separate process. The gateway therefore writes
`<HERMES_HOME>/state/ocuclaw.first-run-phone-candidate.json` atomically after
the exact run has both a committed assistant reply and a successful platform
completion callback. Hermes may deliver those callbacks in either order, so a
bounded, run-scoped in-memory gate joins the two signals and publishes exactly
once. A failed/cancelled outcome remains terminal and cannot be reopened by a
late message commit. The one-hour receipt carries
only the profile fingerprint, completion/expiry timestamps, and SHA-256
fingerprints of the opaque session and turn identifiers. Raw identifiers,
message text, phone metadata, and credentials never enter it.

`wait_phone_origin` returns a secret-free opaque candidate binding derived from
those fingerprints. Every host-only fresh arm, including the compatibility
`arm_first_run_proof` operation, must present that exact binding; replacement
by a newer candidate refuses the arm. The operation then consumes the bound
fingerprints into the existing private Attempt receipt. The gateway later enumerates its own
OcuClaw sessions and selects the one whose fingerprint matches the armed
Attempt, so the exact welcome surface renders to the phone/G2 conversation
without moving setup into it. A missing, expired, unreadable, or malformed
candidate refuses arming and asks for a fresh phone test message. The candidate
is OcuClaw-owned profile state and the supported uninstall removes it.

## Readiness synthesis (W06 — census-gap `connect` row)

The link handshake IS the hermes connect. After `link.hello.ack` AND a
successful in-child relay boot, the child synthesizes
`helloOk {protocol: LINK_PROTOCOL_VERSION, policy: {tickIntervalMs:
HERMES_SYNTH_TICK_INTERVAL_MS = 15000}}` and only then emits `connected
{protocol, tickIntervalMs}` + `status "connected"` (readiness gate order is
census-row-pinned). Handshake/boot failure → `connectFailed {reason}`; link
EOF → `disconnected {reason}` + `status "disconnected"` before exit (pending
run-waiters reject). Relay bind failure exits `98` (`EADDRINUSE` fail-fast,
D7). An ack config WITHOUT `relayToken` runs the child link-only (no relay
boot, no port bind, readiness never announced) — the lane the bundle pytest
drivers and echo probes use; production configs always carry the token
(`validate_config` requires it).

## Size cap and truncation (never split)

Senders serialize each frame; a line exceeding `LINK_MAX_LINE_BYTES` is NOT
sent and NEVER split. It is replaced by a marker frame preserving the routing
fields (`v`, `type`, `id`, `method`, `ok`) plus `truncated: true`,
`originalBytes`, and `payloadHead` (first `LINK_TRUNCATION_HEAD_CHARS` chars
of the original serialization). Receivers treat a truncated RPC response as a
failed RPC (`link_frame_truncated`); a requester whose own request truncates
fails that RPC locally with the same error. Readers enforce the cap
defensively: an inbound line exceeding it is dropped in full (skip to next
newline) and counted — the peer violated the truncation rule, so the frame is
unusable regardless.

## Debug mirroring

Both directions mirror frame SUMMARIES (`type`, `id`, `method`, `ok`,
byte size — never payload bodies) into the debug store category
`hermes.link` via the Node side's `emitDebug` seam. Until the relay (and its
debug store) boots inside the child in later work items, the entry exposes
the seam and can tee summaries to stderr via `OCUCLAW_LINK_DEBUG_STDERR=1`.

## Config keys (pinned, D7/D11)

Non-secret adapter config is declared by `adapter.py` and stored under
`platforms.ocuclaw.extra.*` in Hermes `config.yaml`. Set it with
`hermes config set platforms.ocuclaw.extra.<key> <value>`; automation must not
edit the file directly. The Relay Credential is generated by initial plugin
bootstrap and stored through Hermes's atomic `.env` writer. The optional
Soniox and Even AI secrets are stored in that same Hermes-managed env file —
`$HERMES_HOME/.env`, the served profile's own home (default `~/.hermes`) —
through masked Hermes setup. Writes go through Hermes's `save_env_value`;
reads use the process environment and Hermes's `get_env_value` accessor. The
one direct open of that file in the plugin is the uninstall receipt's
key-presence check (`uninstall.py`), which tests whether a key name is
present and never extracts a value.
Legacy yaml secret keys remain readable for backward compatibility, but a
non-empty environment value wins and the adapter logs a value-free shadow
warning.

| Key | Declared | Stored | Required | Precedence | Default / meaning |
|---|---|---|---|---|---|
| `wsPort` | `adapter.py` | `config.yaml` `extra.wsPort` | Optional, code-defaulted | yaml > code default | `47801`; relay WS listener. Fresh Hermes setup falls back to `43118`, then `38272`, only after a bind conflict. Even-AI shares this HTTP server. |
| `wsBind` | `adapter.py` | `config.yaml` `extra.wsBind` | Optional, code-defaulted | yaml > code default | `127.0.0.1`; relay bind address. |
| `relayToken` | Host-generated Relay Credential; `adapter.py` bridge as `OCUCLAW_RELAY_TOKEN`; no `requires_env`, prompt, reveal, or return surface | `.env` via `OCUCLAW_RELAY_TOKEN` (the only supported source; no status, doctor, or setup surface reads a yaml secret) | **Required**; initial plugin bootstrap generates it on a provably fresh profile and validation refuses boot without it | env > unset | Downstream client auth token, constant-time checked and forwarded in `link.hello.ack`; reinstall/update/restart/re-pair preserve it, and only the locally confirmed all-device reset replaces it. |
| `sonioxApiKey` | `adapter.py` bridge as `OCUCLAW_SONIOX_API_KEY`; deliberately absent from `requires_env` | `.env` via `OCUCLAW_SONIOX_API_KEY` (the only supported source) | Optional; required for Soniox STT only | env > unset | Credential for temporary-key mint; unset returns `soniox_temp_key_not_configured`. |
| `stateDir` | `adapter.py` | `config.yaml` `extra.stateDir` | Optional, code-defaulted | yaml > code default | `$HERMES_HOME/ocuclaw`; Node runtime state directory. |
| `glassesUiLive` | `adapter.py` | `config.yaml` `extra.glassesUiLive` | Optional, code-defaulted | yaml > code default | `{}`; LiveUI policy descriptor forwarded to the child runtime. |
| `renderGlassesUiTimeoutMs` | `adapter.py` | `config.yaml` `extra.renderGlassesUiTimeoutMs` | Optional | yaml > unset | Positive render-tool timeout override; unset/non-positive delegates to the child default. |
| `externalDebugToolsEnabled` | `adapter.py` | `config.yaml` `extra.externalDebugToolsEnabled` | Optional, code-defaulted | yaml > code default | `true`; admit relay-token-authenticated debug clients and arm support capture. |
| `allowDebugUpload` | `adapter.py` | `config.yaml` `extra.allowDebugUpload` | Optional, code-defaulted | yaml > code default | `true`; allow user-initiated support-bundle handoff. |
| `debugUploadMaxZipBytes` | `adapter.py` | `config.yaml` `extra.debugUploadMaxZipBytes` | Optional, code-defaulted | yaml > code default | `4000000`; clamped to 100000–4300000 bytes. |
| `debugUploadCapturePreset` | `adapter.py` | `config.yaml` `extra.debugUploadCapturePreset` | Optional | yaml > unset | Category-list override for the support capture preset. |
| `debugBundleSaveDir` | `adapter.py` | `config.yaml` `extra.debugBundleSaveDir` | Optional | yaml > unset | Host directory override for locally saved support bundles. |
| `evenTerminalEnabled` | `adapter.py` | `config.yaml` `extra.evenTerminalEnabled` | Optional, code-defaulted | yaml > code default | `false`; enables the Even Terminal bridge on Hermes. The beta cut and setup guide set this flat Hermes extra to `true`; OpenClaw's separate nested key is `evenTerminal.enabled`. |
| `evenAiEnabled` | `adapter.py` | `config.yaml` `extra.evenAiEnabled` | Optional, code-defaulted | yaml > code default | `false`; enables the OpenAI-compatible Even-AI route. |
| `evenAiToken` | `adapter.py` bridge as `OCUCLAW_EVEN_AI_TOKEN`; deliberately absent from `requires_env` | `.env` via `OCUCLAW_EVEN_AI_TOKEN` (the only supported source) | **Conditional**; required when `evenAiEnabled=true` | env > unset | Bearer token for Even-AI only; the relay token is not reused. |
| `evenAiSystemPrompt` | `adapter.py` | `config.yaml` `extra.evenAiSystemPrompt` | Optional | yaml > unset | Default system prompt for Even-AI turns. |
| `evenAiRequestTimeoutMs` | `adapter.py` | `config.yaml` `extra.evenAiRequestTimeoutMs` | Optional, code-defaulted | yaml > code default | `60000`; Even-AI request timeout. |
| `evenAiMaxBodyBytes` | `adapter.py` | `config.yaml` `extra.evenAiMaxBodyBytes` | Optional, code-defaulted | yaml > code default | `65536`; maximum accepted request body. |
| `evenAiDedupWindowMs` | `adapter.py` | `config.yaml` `extra.evenAiDedupWindowMs` | Optional, code-defaulted | yaml > code default | `500`; duplicate-request suppression window. |
| `evenAiRoutingMode` | `adapter.py` | `config.yaml` `extra.evenAiRoutingMode` | Optional, code-defaulted | yaml > code default | `active`; accepts exactly `active`, `background`, or `background_new`. Hermes ingress is total: any other explicit value (including the retired `dedicated`/`new`/`dedicated_shadow`/`new_shadow` aliases the shared client parser still normalizes) is REJECTED here and refuses config validation rather than falling through to shared normalization. |
| `evenAiDedicatedSessionKey` | `adapter.py` | `config.yaml` `extra.evenAiDedicatedSessionKey` | Optional | yaml > derived default | Hermes-minted dedicated key; otherwise derives `hermes:main:even-ai`. |
| `staleTurnSeconds` | `adapter.py` | `config.yaml` `extra.staleTurnSeconds` | Optional, code-defaulted | yaml > code default | `1800`; closes inactive dispatch records with terminal `stale`. |
| `runtimeReadyTimeoutS` | `adapter.py` | `config.yaml` `extra.runtimeReadyTimeoutS` | Optional, code-defaulted | yaml > code default | `30`; waits for the child `runtime.ready` receipt when relay boot is expected. |
| `runtimeCommand` | `adapter.py` | `config.yaml` `extra.runtimeCommand` | Optional | yaml > bundled command | Child argv override for worktree/development runtimes. |
| `handshakeTimeoutS` | `adapter.py` | `config.yaml` `extra.handshakeTimeoutS` | Optional, code-defaulted | yaml > code default | `10`; parent-side hello wait, exported as `OCUCLAW_LINK_HANDSHAKE_TIMEOUT_MS`. |
| `terminateGraceS` | `adapter.py` | `config.yaml` `extra.terminateGraceS` | Optional, code-defaulted | yaml > code default | `5`; SIGTERM-to-SIGKILL grace. |
| `linkDebugStderr` | `adapter.py` | `config.yaml` `extra.linkDebugStderr` | Optional, code-defaulted | yaml > code default | `false`; when true, all child console/logger output reaches the durable gateway log. |

### Relay Credential generation marker

Initial plugin bootstrap defines a provably fresh profile as having neither a
readable `OCUCLAW_RELAY_TOKEN` nor
`<HERMES_HOME>/state/ocuclaw.relay-credential.json`. Under one profile-scoped
process lock it generates 32 CSPRNG bytes as the canonical 43-character
unpadded base64url credential, persists and reads it back through
`hermes_cli.config.save_env_value`, then exclusively claims the marker. The
marker has exactly `{"v":1,"generationId":"<independent 43-character
base64url id>","createdAt":"<UTC ISO-8601>","profileFingerprint":"<same
SHA-256 format as First-Run Proof>"}`. It never contains the credential or a
hash of it.

A readable credential without a marker is already established; existing
profiles adopt a marker on first bootstrap after upgrade without touching the
credential. This also closes the safe crash state between the two ordered
writes. Any existing marker, including one that is unreadable or malformed,
also fails closed as established. Reinstall, update, restart, and re-pair
preserve both.

Managed/NixOS Hermes profiles are outside the beta platform scope under the
[managed-mode ruling clarification](https://github.com/OcuClawhub/even&#99;law/issues/1321#issuecomment-5312718733):
OcuClaw never generates, prompts for, or bypass-writes a secret there. A
deployment-provided readable `OCUCLAW_RELAY_TOKEN` is established and operates
normally; marker adoption is attempted only when the state directory is
writable, and a skipped marker does not weaken that credential-readable
establishment proof. Without a readable credential, bootstrap and setup fail
closed with the explicit managed-profile provisioning explanation.

The all-device reset atomically replaces the credential and rewrites the marker
with a fresh independent `generationId` before the explicit gateway restart.
When an established profile has no readable prior credential, the reset result
records `previous_auth: not_applicable`; replacement acceptance is still
mandatory.
Managed profiles refuse the all-device reset because the beta has no authorized
secret persistence path for them.

Node-side runtime fallback constants: `HERMES_BUNDLE_DEFAULT_WS_PORT = 47801`
and `OPENCLAW_BUNDLE_DEFAULT_WS_PORT = 9000` in
`extensions/ocuclaw/src/config/runtime-config.ts`. OpenClaw's separate
fresh-install selector normally persists `47800`; an explicit configured port
always wins in either backend.

### Secret posture on rendered surfaces

Every surface this extension renders — the setup/doctor receipt, the tool
activity mirrored to the glasses, logs, and any future snapshot, CLI,
dashboard, or support attachment — is secret-free by construction. Two rules
carry that, and they are contracts, not conventions. **First: secrets are
reported only as presence booleans.** A surface may say that a secret is
configured or is not configured; it may never render the value, a mask, a
prefix or suffix, a length, or a hash of it, and it may never render which
store the value came from in a form that narrows the value. The secret
inventory — the required host-generated Relay Credential plus the optional
user-supplied Soniox and Even AI credentials, each looked for in Hermes's `.env` contract (the
Hermes-managed secret env file, falling back to the process environment) — is
computed once by `_secret_presence_inventory()` in `adapter.py`, which
collapses the store to one boolean per secret before the value can reach a
caller. The legacy yaml `extra.*` keys are not a secret source: a yaml key
never counts as a configured secret on any status, doctor, or setup surface.
Problem messages derived from it stay value-free (`relay_token_missing`,
`even_ai_token_missing`). Initial plugin bootstrap generates the Relay
Credential without rendering or returning it. A present Relay Credential has
no reveal, export, import, or masked-replacement surface. The secret-free
`state/ocuclaw.relay-credential.json` marker is likewise absent from status,
doctor, dashboard, and support attachments. Optional user-supplied Soniox and
Even AI credentials retain their masked entry prompts. Entry is not rendering.
**Second: URLs are redacted.** Any text bound for a rendered surface passes
through `redact_urls_in_text()` in `adapter.py` — the single shared redactor,
with no second copy anywhere in the extension. It replaces URL userinfo,
secret-named query and fragment parameters, and credential-shaped path
segments (opaque webhook and token segments) with `[redacted]`, while
preserving URL structure and every non-URL character so the reader keeps the
context needed to diagnose. New rendered surfaces inherit both rules by
calling these two functions rather than reimplementing either; a surface that
needs a redaction case they do not cover extends the shared function.

### Multiplex operational rules

- OcuClaw is a port-binding platform. Configure it only on the default
  profile: that single adapter owns the Node child and `:47801`, then serves
  all accepted profile lanes. If Hermes constructs it under a secondary
  profile home override, the adapter raises before spawning the child; the
  gateway logs and skips that secondary adapter.
