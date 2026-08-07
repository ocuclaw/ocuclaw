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
| `db.sessions.list` | `{limit?, search?, keyIdentity?}` | `{sessions:[{id, sessionKey, source, lineageRootId, lastActive, title, preview, messageCount}]}` — in multiplex mode merges newest-first across every served profile DB (a missing profile DB is skipped); outside multiplex opens ONLY the default DB and preserves legacy results; deny trio `tool`/`cron`/`subagent` excluded server-side; `search` = title/preview substring; `keyIdentity` = parsed public-key identity for exact-key hydration (the bridge sends it INSTEAD of `search` when the term parses as a `hermes:` key — session-service looks up the current session via `sessions.list({search: sessionKey})`), resolved via the INDEXED identity lookups + exact-id rich-row fetch (never a bounded recency scan); text search scans a wide window; the limit bounds RESULTS |
| `db.sessions.resolveKey` | `{key, ns?}` (raw hermes session id) | `{row: <list-row shape>}`; explicit `ns` resolves only that served profile, while omitted `ns` scans every served profile DB and requires exactly one match; errors `no such session: <key>` or `ambiguous session key across profiles: <key>` |
| `db.sessions.setTitle` | `{identity, title\|null}` | `{ok:true}`; null/empty clears; UNIQUE collision surfaces as the RPC error |
| `db.sessions.delete` | `{identity}` | `{deleted:[ids]}` — deletes the whole compression lineage tip→root |
| `db.chat.history` | `{identity, limit?}` | `{messages:[{role, content}], sessionId}` — conversational rows ONLY (user/assistant with content) across the compression lineage (`get_messages_as_conversation(tip, include_ancestors=True)`), tail-sliced server-side to `limit` so bounded pages never risk the 1 MiB frame cap; content is scalar-or-block-list; the Node bridge re-shapes defensively over the same pinned shape |
| `db.sessions.describe` | `{identity}` | `{model, tokens:{input,output,cacheRead,cacheWrite,reasoning}, lastMessageTokenCount, messageCount}` |
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

## Foreign session lane (sanctioned policy — 2026-07-08)

All-platform session list/history survives. Foreign-session mutation is
copy-only. Adoption ("Continue here"), send-via-origin/injection,
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
| `gw.usage.status` | `{}` | `{updatedAt, providers:[{provider, displayName, windows:[{label, usedPercent, resetAt?}]}]}` — `fetch_account_usage` per candidate provider (candidates = configured-default ∪ pool-credentialed, ∩ the 3 routable providers anthropic/openai-codex/openrouter; unavailable snapshots dropped); `resetAt` unix seconds, omitted when hermes has none; labels are hermes-native prose — the BRIDGE aligns them to the `normalizeWindowKey` patterns (`(Current )session` → `5h`, `(Current )week(ly)` → `week`, others verbatim → slug keys) |
| `gw.auth.status` | `{}` | `{providers:[{provider, profiles:[{type}]}]}` — from the persisted credential pool (`read_credential_pool`); credential-level `auth_type` maps `oauth`→`"oauth"`, `api_key`→`"token"` (pooled api-key entries ARE rotation members — the consumed semantic is pool size, and OcuClaw counts only oauth\|token); providers with zero pool entries are omitted |
| `gw.agent.identity` | `{ns}` | `{agentId, name}` — `agentId` = PROFILE name (`ns` `main` ⇄ profile `default` mapping happens HERE, the single crossing point); `name` parsed from the profile's SOUL.md first line (`You are <name>, …` heuristic, bounded) else the profile name (default lane: "Hermes"). No emoji/avatar — hermes has no brand-asset source (consumers tolerate absence; the IDENTITY.md fallback probe then hits `gw.profiles.soul`) |
| `gw.profiles.list` | `{}` | `{profiles:[{name, isDefault, model?, provider?, description?}], defaultProfile:"default"}` — `profiles.list_profiles()` verbatim (ProfileInfo carries model/provider from the profile's own config.yaml) |
| `gw.profiles.soul` | `{profile}` | `{content}` — `get_profile_dir(name)/SOUL.md` (the same source as `GET /api/profiles/{name}/soul`); unknown profile ⇒ plain error (NOT `-32601` — a bad agentId must not latch `workspaceIdentityFilesUnsupported` for the whole connection) |
| `gw.skills.status` | `{}` | `{skills:[{name, description}]}` — `get_skill_commands()` rows; additionally filtered by `skills.platform_disabled.ocuclaw` (the scan's implicit platform scope is unset on this lane, so the per-platform filter is applied explicitly); the bridge synthesizes `eligible:true` (hermes filters disabled at scan) |

## Visible command settings lane (sanctioned policy — 2026-07-08)

Silent per-session override RPCs are retired. The settings UI still exposes
model, thinking-effort, and reasoning-display controls, but the Hermes path
implements them as ordinary visible command turns sent through this adapter's
own session via `dispatch.send`. Hermes owns parsing, validation, warnings,
confirmation text, transcript visibility, and persistence semantics.

The phone/WebUI still sends `setSessionModelConfig` to the runtime. The
runtime's `sessions.patch` payload-A translator composes visible commands:

| Input field | Command turn |
|---|---|
| `modelProvider`/`model` | `/model <id> [--provider <provider>] --session` |
| empty `model` | `/model reset --session` |
| `thinkingLevel` | `/reasoning <none|minimal|low|medium|high|xhigh>` (`off` maps to `none`) |
| empty `thinkingLevel` | `/reasoning reset` |
| `reasoningLevel:"on"` or `"stream"` | `/reasoning show` |
| `reasoningLevel:"off"` | `/reasoning hide` |

`verboseLevel`, `fastMode`, and `elevatedLevel` have no Hermes per-session
public primitive in this stage. They remain capability-gated/no-op for Hermes
unless a future public command or API is added. The plugin stores no durable
override file and writes no Hermes DB marker for these controls.

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
`{phase:"update", runId, sessionKey, text, delta?, summary?,
thinkingSummarySource, thinkingSignatureId?, source?}`. `text` is cumulative
per run, capped to the latest 8000 chars; `delta` is the most recent chunk when
available. Finalize payload:
`{phase:"finalize", runId, sessionKey, reason?}`. The child rebroadcasts these
as APP_PROTOCOL frames `ocuclaw.thinking.update` and
`ocuclaw.thinking.finalize`. Hermes-native updates are synthesized from
`post_api_request` `assistant_message.reasoning` only (no `<think>` fallback)
and stamp `thinkingSummarySource:"detail"` unconditionally.

## Session-control lane

Hermes 0.19 exposes native platform approval delivery and resolution seams.
The adapter implements `send_exec_approval`, mirrors each request to the
glasses approval HUD, and resolves its FIFO head through Hermes'
`resolve_gateway_approval`. It does not inspect private approval queues.
`post_approval_response` reconciles resolutions made through Hermes' typed
fallback so the mirrored HUD clears exactly once.

The mirrored countdown inherits Hermes' effective `approvals.timeout` value.
Hermes 0.19.0 defaults that setting to 60 seconds and 0.19.1 defaults it to
300 seconds; an operator override wins on either host. Timeout and disconnect
remain implicit deny (silence is not consent). Smart-denied requests expose
only Once and Deny; ordinary requests expose Session only when Hermes marks
that scope available. Permanent approval remains absent from the glasses
decision set.

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
  stash its tail closure outside the ledger: Hermes 0.19's StreamConsumer
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

Hermes 0.19 resolves the per-platform value ahead of the global setting and
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
`ctx.agentId?` (hermes profile namespace) and `event.messages?` (final
conversational transcript read from SessionDB — `on_session_end` itself
carries no messages).

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
edit the file directly. The three secrets are declared as environment bridges
and stored in `~/.hermes/.env` by `hermes config set OCUCLAW_* <value>`.
Legacy yaml secret keys remain readable for backward compatibility, but a
non-empty environment value wins and the adapter logs a value-free shadow
warning.

| Key | Declared | Stored | Required | Precedence | Default / meaning |
|---|---|---|---|---|---|
| `wsPort` | `adapter.py` | `config.yaml` `extra.wsPort` | Optional, code-defaulted | yaml > code default | `47801`; relay WS listener. Fresh Hermes setup falls back to `43118`, then `38272`, only after a bind conflict. Even-AI shares this HTTP server. |
| `wsBind` | `adapter.py` | `config.yaml` `extra.wsBind` | Optional, code-defaulted | yaml > code default | `127.0.0.1`; relay bind address. |
| `relayToken` | `plugin.yaml` `requires_env` as `OCUCLAW_RELAY_TOKEN`; `adapter.py` bridge | `.env` via `OCUCLAW_RELAY_TOKEN`; legacy `extra.relayToken` is read-only compatibility | **Required**; validation refuses boot without it | env > legacy yaml > unset | Downstream client auth token, constant-time checked and forwarded in `link.hello.ack`. |
| `sonioxApiKey` | `adapter.py` bridge as `OCUCLAW_SONIOX_API_KEY`; deliberately absent from `requires_env` | `.env` via `OCUCLAW_SONIOX_API_KEY`; legacy `extra.sonioxApiKey` is read-only compatibility | Optional; required for Soniox STT only | env > legacy yaml > unset | Credential for temporary-key mint; unset returns `soniox_temp_key_not_configured`. |
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
| `evenAiToken` | `adapter.py` bridge as `OCUCLAW_EVEN_AI_TOKEN`; deliberately absent from `requires_env` | `.env` via `OCUCLAW_EVEN_AI_TOKEN`; legacy `extra.evenAiToken` is read-only compatibility | **Conditional**; required when `evenAiEnabled=true` | env > legacy yaml > unset | Bearer token for Even-AI only; the relay token is not reused. |
| `evenAiSystemPrompt` | `adapter.py` | `config.yaml` `extra.evenAiSystemPrompt` | Optional | yaml > unset | Default system prompt for Even-AI turns. |
| `evenAiRequestTimeoutMs` | `adapter.py` | `config.yaml` `extra.evenAiRequestTimeoutMs` | Optional, code-defaulted | yaml > code default | `60000`; Even-AI request timeout. |
| `evenAiMaxBodyBytes` | `adapter.py` | `config.yaml` `extra.evenAiMaxBodyBytes` | Optional, code-defaulted | yaml > code default | `65536`; maximum accepted request body. |
| `evenAiDedupWindowMs` | `adapter.py` | `config.yaml` `extra.evenAiDedupWindowMs` | Optional, code-defaulted | yaml > code default | `500`; duplicate-request suppression window. |
| `evenAiRoutingMode` | `adapter.py` | `config.yaml` `extra.evenAiRoutingMode` | Optional, code-defaulted | yaml > code default | `active`; also accepts `background` or `background_new` after alias normalization. |
| `evenAiDedicatedSessionKey` | `adapter.py` | `config.yaml` `extra.evenAiDedicatedSessionKey` | Optional | yaml > derived default | Hermes-minted dedicated key; otherwise derives `hermes:main:even-ai`. |
| `staleTurnSeconds` | `adapter.py` | `config.yaml` `extra.staleTurnSeconds` | Optional, code-defaulted | yaml > code default | `1800`; closes inactive dispatch records with terminal `stale`. |
| `runtimeReadyTimeoutS` | `adapter.py` | `config.yaml` `extra.runtimeReadyTimeoutS` | Optional, code-defaulted | yaml > code default | `30`; waits for the child `runtime.ready` receipt when relay boot is expected. |
| `runtimeCommand` | `adapter.py` | `config.yaml` `extra.runtimeCommand` | Optional | yaml > bundled command | Child argv override for worktree/development runtimes. |
| `handshakeTimeoutS` | `adapter.py` | `config.yaml` `extra.handshakeTimeoutS` | Optional, code-defaulted | yaml > code default | `10`; parent-side hello wait, exported as `OCUCLAW_LINK_HANDSHAKE_TIMEOUT_MS`. |
| `terminateGraceS` | `adapter.py` | `config.yaml` `extra.terminateGraceS` | Optional, code-defaulted | yaml > code default | `5`; SIGTERM-to-SIGKILL grace. |
| `linkDebugStderr` | `adapter.py` | `config.yaml` `extra.linkDebugStderr` | Optional, code-defaulted | yaml > code default | `false`; when true, all child console/logger output reaches the durable gateway log. |

Node-side runtime fallback constants: `HERMES_BUNDLE_DEFAULT_WS_PORT = 47801`
and `OPENCLAW_BUNDLE_DEFAULT_WS_PORT = 9000` in
`extensions/ocuclaw/src/config/runtime-config.ts`. OpenClaw's separate
fresh-install selector normally persists `47800`; an explicit configured port
always wins in either backend.

### Multiplex operational rules

- OcuClaw is a port-binding platform. Configure it only on the default
  profile: that single adapter owns the Node child and `:47801`, then serves
  all accepted profile lanes. If Hermes constructs it under a secondary
  profile home override, the adapter raises before spawning the child; the
  gateway logs and skips that secondary adapter.
- Notification cron jobs schedule on the **default profile**. Hermes 0.19 has
  one process ticker and does not provide a per-profile notification-cron
  scheduler; this is an operational placement rule, not adapter routing code.
