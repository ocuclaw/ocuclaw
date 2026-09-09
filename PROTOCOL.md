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
| outbound queued + stream bytes (each direction) | `4_194_304` (4 MiB) |
| outbound queued frames | `128` |
| pending locally initiated RPCs | `128` |
| active incoming RPC handlers | `128` |

## Write flow control and overload

Each endpoint owns one FIFO of complete encoded lines. Node stops issuing
writes on `write() === false` and resumes on `drain`; Python has one writer
task which awaits `StreamWriter.drain()` after each write. There is no task,
promise, or drain listener per queued frame. Admission checks both the frame
count and encoded queue bytes plus the stream's current write-buffer bytes.
The newline counts towards this aggregate budget; the existing individual
JSON-line cap and truncation marker remain unchanged. These are transport
retention limits, not a process RSS ceiling: OS pipe buffers, transient JSON
serialization and payloads held by the bounded active RPCs are additional.

Local request overload rejects immediately with `code = "link_overloaded"`
and `delivery = "not_sent"` (Python: `LinkOverloadedError`). It does not wait
for an admission slot. A required response or handshake frame which cannot
fit closes the link, as does incoming-handler admission overflow. Pending
calls fail; responses are never silently dropped. The peer learns terminal
failure through the existing EOF/child-exit contract. This deliberately
favours a visible connection failure over executing more work whose results
cannot be retained. No automatic command retry is added.

Receiving and response dispatch continue while the writer is blocked.
There is no write lock held across a handler or RPC response wait. Per-method
deadlines are unchanged, including explicitly unbounded model operations.
Node additionally accepts `request(..., {signal})`; Python uses normal task
cancellation. Expiry or cancellation removes a still-queued request before
any later pump can issue it. The local error carries `delivery = "not_sent"`
when no bytes were issued and `delivery = "uncertain"` after the stream was
given the frame. Link-close rejections carry the same distinction. An issued
request cannot be retracted from a pipe and may still execute: neither drain
nor a local timeout establishes remote delivery or non-execution. Callers
must not automatically retry an uncertain command. This is local transport
metadata; it does not change the wire envelope or imply remote cancellation.

EOF, write failure, stop, and child exit reject pending callers, discard
queued frames, and retire writer/drain and request timer/cancellation state.
Python cancels its bounded handler tasks and drains/discards remaining child
stdout during teardown so `Process.wait()` cannot deadlock on a full pipe;
`terminate()` awaits task cleanup. Node cannot forcibly cancel arbitrary
handler promises, but admits at most 128, starts no more after closure and
suppresses their late responses. Existing handshake timeout/mismatch exit
codes retain precedence over the runtime's clean-EOF exit handler.

`getCounters()` (Node) and `writer_state()` (Python) report current queue
bytes/frames, stream bytes, pending calls, active handlers and the limits.
`framesOut` / `frames_out` count admitted frames, including truncation markers,
not proof of remote receipt.

Authoritative stream contracts: [Node Writable buffering and drain](https://nodejs.org/api/stream.html),
[Node process I/O](https://nodejs.org/api/process.html#a-note-on-process-io),
[Python StreamWriter](https://docs.python.org/3/library/asyncio-stream.html#asyncio.StreamWriter),
and [Python subprocess wait](https://docs.python.org/3/library/asyncio-subprocess.html#asyncio.subprocess.Process.wait).
Real subprocess regressions cover POSIX pipes. Node stdout pipe writes are
synchronous on Windows; that platform's event-loop behaviour is not established
by the POSIX stall tests.

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
| `db.chat.watermark` | `{identity}` | `{sessionId, watermark, dbPath, hermesHome, inflight:{active, platform}}` — Desktop→glasses mirror (#2513). `watermark` is `MAX(messages.id)` over the lane's LIVE transcript (the compression tip), `null` when empty; read on its own `mode=ro` connection (no write lock) — NOT `latest_message_row_id`, which is role/text-filtered and sits still on a tool-call-only tail. `inflight` is the tier-0 verdict for that tip (the adapter wraps the bare session_rpc handler to add it). `db.chat.history` accepts `afterId` (rows with `id > afterId`, applied BEFORE `limit`) and answers `rowIdsUnavailable:true` with no rows when the host's projection carries no row ids. Both are read once per debounced WAL event, never on a timer |

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
issues `setRead` on a successful session OPEN (switch), immediately before
leaving the current session, and the turn-end boundary of the CURRENT session.
The departure stamp initializes a first-turn session's watermark after it has
materialized. A reply landing in a
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
| `foreign.sessions.adopt` | `{identity, publicKey, takeOver?}` | `{status:"accepted", sessionId, session, adoptKey, chatId, adoptedFrom, predecessors:[{id,endReason,messageCount}], hiddenPredecessors}` or `{status:"rejected", error, verdict, tip?, holdState?, detail?}` — `error` == `verdict` |
| `foreign.sessions.driver` | `{identity, publicKey}` (a minted lane, normally `hermes:<ns>:adopt-<uuid>`) | `{status:"ok", publicKey, sessionId, lineage:[tip, …root, …predecessors], state:"glasses_drive"\|"desktop_hold"\|"desktop_working", holdState:"hold"\|"working"\|null, hold:{state,surface,pid?,sessionId,since}\|null, inflight:{active,platform}, hermesHome, watch:{markerDir,markerFile,leaseDir,leaseFile}}` — an unknown lane answers `glasses_drive` with `lineage:[]` (unknowable never locks) |

**Single-driver lock (#2510).** One driver at a time on an adopted chat.
`state` comes from Hermes's own files, never from `session_turn_leases`
(RULED): `desktop_working` when `<home>/desktop/interrupted_turns.json` names
a lineage id (tui_gateway/turn_marker.py — written at turn start, cleared at
turn end, keyed by the Desktop session id); `desktop_hold` when a
Desktop/TUI entry in `<home>/runtime/active_sessions.json` names a lineage id
AND its pid is alive (Hermes's public `active_session_registry_snapshot`
prunes dead pids; the adapter re-checks with its own `kill(pid, 0)` — the
Mac's dead pid 34644 must never lock the wearer); `glasses_drive` otherwise.
`inflight` is tier 0: the adapter's in-memory `{session_id → {at, platform}}`
fed by `pre_llm_call` (marked BEFORE the ocuclaw platform filter, so any
platform's turn on the lineage counts), refreshed by the tool hooks, cleared
by `on_session_end`, and expired by `INFLIGHT_TTL_S` (600 s) as the fail-safe
for interrupted early returns that skip `on_session_end`. A lineage with a
live tier-0 mark refuses `foreign.sessions.adopt` with `own_lane_busy`
(`detail` = the platform). Node calls `foreign.sessions.driver` when it arms
its two DIRECTORY `fs.watch`es (`hermesHome/<markerDir>`,
`hermesHome/<leaseDir>` — the files are unlinked/replaced) and once per
debounced file event; idle profile = 2 watches, 0 timers, 0 SQL. The app sees
`ocuclaw.session.driver` `{sessionKey, state, locked, takeOver, holdState,
holdSurface, holdPid, inflight, inflightPlatform, updatedAtMs[, error]}` and
sends `ocuclaw.session.driver.takeover` `{sessionKey}` (accepted only in
`desktop_hold`; `desktop_working` refuses). LOCK in both Desktop states;
unlock on lease clear or Take-over. Typed phone sends on a locked lane are
held and auto-sent exactly once on unlock; voice sends are never held.

**Desktop→glasses live mirror (#2513).** Turns typed in Hermes Desktop on an
adopted chat reach the glasses about a second after they land, as finished
rows tagged "Desktop" (no token streaming — that needs upstream #86784).
Node (`session-mirror-watch.ts`) rides the driver lock's arm/disarm lifecycle:
armed only while the current session is an adopted lane, ONE `fs.watch` on
the DIRECTORY holding `state.db` filtered to `state.db-wal` (and `state.db`
itself where WAL is refused — rollback journals write the main file; `-shm`
is ignored because every READ moves it), 150 ms debounce → `db.chat.watermark`
→ if `MAX(id)` moved, `db.chat.history {afterId}` → the rows land through the
gateway-commit path (`conversationState.addMessage`, user row `name="Desktop"`,
`origin="desktop"`, ledger id `srv:<row id>`) → one Pages/entries broadcast.
Idle profile = 1 watch, 0 timers, 0 SQL (`getSessionDriverDiagnostics().mirror`,
debug trail `session_mirror` on app.timeline). Dedupe of the wearer's OWN rows
(already on the glasses via `message` events): the watermark advances SILENTLY
when the watermark answer's tier-0 `inflight` names this platform, inside a
1.5 s quiet window opened by any run activity/commit on the lane, or when the
driver snapshot's `inflight` says so; `agent_end` (on_session_end, after the
flush) advances it once more. A moved `sessionId` (compression fork) is a
full rehydrate, never a tail. **Precondition: same host.** The gateway and
Desktop must share one `HERMES_HOME` — the mirror watches the gateway's own
`state.db`; a Desktop on another machine writes a DB the gateway never sees
(the old "gateway HERMES_HOME ≠ Desktop's" check was unimplementable and is
dropped). macOS two-process FSEvents latency is UNVERIFIED (pet Linux inotify
measured; see #2513).

The durable-lease wait notice (`⏳ Another Hermes process is using this
session…`, run_agent.py `_emit_status`) is re-emitted by
`send_or_update_status` as `activity origin=status state=lifecycle
statusKey=desktop_lease_wait label="Waiting for Desktop"
candidateRank=narration` so the wait is visible on the header and the phone
(T0 step 8 found the bare notice dropped as `clear_non_visible_activity`).

**Continue here (#2509)** adopts a Desktop/CLI/TUI transcript onto the glasses
through Hermes's PUBLIC slash command, never a private store mutation: Python
mints `chat_id = adopt-<uuid>`, builds the wearer's normal `MessageEvent`
(`_build_message_event`, user id `ocuclaw-wearer`) with text
`/resume <tip> --all`, and runs it through `handle_message`. Hermes's
`switch_session` then ends the fresh stub it minted for the adopt key
(`end_reason='session_switch'`, 0 messages) and re-keys the transcript's
lineage onto `agent:main:ocuclaw:dm:adopt-<uuid>` (source/user_id/chat_id
rewritten — the row stays in Desktop's Recents, unbadged). **The verdict is
read from the DB** (`adopt_outcome`: the tip is the LIVE carrier of the adopt
key), polled at 100 ms for up to 10 s; the slash reply is intercepted in
`send()` and only classifies refusals by rendering Hermes's own i18n keys
(`gateway.resume.blocked_not_owner` / `not_found` / `already_on` /
`switch_failed`). The ended stub is hidden with the public `hidden` flag.
Preconditions, in order: minted identities and non-default namespaces are
refused before the DB is touched; `admin_not_configured` when
`platforms.ocuclaw.extra.allow_admin_from` does not list `ocuclaw-wearer`
(`gateway.slash_access.policy_from_extra`, DM scope — the key turns slash
gating ON for the whole ocuclaw platform, safe because that single id is the
only one the adapter ever stamps); the row must be an external root
(`session_key` NULL, source in `desktop|cli|tui` — platform-origin rows own a
gateway peer `/resume` would rewrite); `own_lane_busy` while the same tip is
already being adopted; `desktop_busy` (`holdState: working|hold`) while
Hermes's own files show Desktop/TUI on the lineage — a turn marker in
`desktop/interrupted_turns.json` or a pid-alive lease in
`runtime/active_sessions.json` (public `active_session_registry_snapshot`;
dead pids never lock the wearer out; `session_turn_leases` is never read) —
unless `takeOver:true`. `adopt_timeout` when nothing changed within the
budget. The resolver (`_carriers_for_key`) reads carriers through
`list_sessions_rich(session_key=K, include_children, include_hidden)` and
prefers the LIVE row: `list_gateway_sessions` picks `MAX(started_at)` before
`ended_at IS NULL` and would resolve the adopt key to the empty stub.

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
| `gw.models.list` | `{}` | `{models:[{provider, id, name, contextWindow, reasoning}]}` — metadata from `CANONICAL_PROVIDERS` × `list_provider_models` × `get_model_info`, then missing enabled explicit configured provider/model pairs from primary, fallback and channel overrides. One config snapshot supplies references and provider filtering. Deduplication is by provider + ID; real metadata wins, seeded rows use ID as name and omit unknown context/capabilities. Optional metadata imports may be unavailable without losing configured pairs. No provider inference or live discovery. |
| `gw.models.configured` | `{}` | `{default:{id, provider?}\|null, fallbacks:[{id, provider?}], channelOverrides:[{id, provider?}]}` — from config `model`(`.default`/`.provider`), the `fallback_providers` chain (`get_fallback_chain` — hermes has NO `model.fallbacks` key), and `platforms.ocuclaw.channel_overrides`, excluding explicitly disabled providers using the same config snapshot. The bridge reprojects into `config.agents.defaults.{model,models}`; fallbacks survive a missing/disabled primary. Hermes catalog projection excludes the implicit OpenClaw default when no primary exists; the shared mapper and existing unqualified-reference interpretation remain unchanged. Hermes has no imageModel/alias config so `imageModel` is OMITTED and `models` is `{}`. |
| `gw.usage.status` | `{}` | `{updatedAt, providers:[{provider, displayName, windows:[{label, usedPercent, resetAt?}], unavailableReason?}]}` — `fetch_account_usage` per candidate provider (candidates = configured-default ∪ pool-credentialed, ∩ the 3 routable providers anthropic/openai-codex/openrouter). Only finite `usedPercent` windows cross the wire; absent percentages become an honest `unavailableReason`, never `0% used`. `resetAt` is unix seconds, omitted when Hermes has none; labels are Hermes-native prose, with one truth-preserving Codex correction: Hermes currently calls `primary_window` "Session" even when its reset is more than five hours away and therefore can only be the weekly allowance, so that proven case crosses as `Weekly`. The BRIDGE aligns labels to the `normalizeWindowKey` patterns (`(Current )session` → `5h`, `(Current )week(ly)` → `week`, others verbatim → slug keys) |
| `gw.auth.status` | `{}` | `{providers:[{provider, profiles:[{type}]}]}` — from the persisted credential pool (`read_credential_pool`); credential-level `auth_type` maps `oauth`→`"oauth"`, `api_key`→`"token"` (pooled api-key entries ARE rotation members — the consumed semantic is pool size, and OcuClaw counts only oauth\|token); providers with zero pool entries are omitted |
| `gw.agent.identity` | `{ns}` | `{agentId, name}` — `agentId` = PROFILE name (`ns` `main` ⇄ profile `default` mapping happens HERE, the single crossing point); `name` parsed from the profile's SOUL.md first line (`You are <name>, …` heuristic, bounded) else the profile name (default lane: "Hermes"). No emoji/avatar — hermes has no brand-asset source (consumers tolerate absence; the IDENTITY.md fallback probe then hits `gw.profiles.soul`) |
| `gw.profiles.list` | `{}` | `{profiles:[{name, isDefault, displayName?, model?, provider?, description?, emoji?}], defaultProfile:"default", createSupported, settingsSupported:true}` — `profiles.list_profiles()` verbatim (`name` stays the routing key; optional `displayName` is presentation only; ProfileInfo carries model/provider from the profile's own config.yaml). `emoji` is OcuClaw's own key, read per profile from `platforms.ocuclaw.extra.emoji` in THAT profile's config.yaml (see "Config keys" → `extra.emoji`) and omitted when unset. `createSupported` is true only when this adapter booted with multiplex routing enabled. Existing served profiles remain configurable without multiplex, so `settingsSupported` is independently true. `adoptSupported` (#2509) is true when `platforms.ocuclaw.extra.allow_admin_from` lists `ocuclaw-wearer` — the bridge lifts it into `agentCatalogSnapshot.foreignSessionAdopt` → `families.sessions.foreignSessions.adopt`. |
| `gw.profiles.create` | `{name, requestId?, setup?}` | `{status:"created"|"partial", profile:{id,name}, restartRequired:true, errorMessage?}` — native fresh profile creation, bundled skill seeding, safe alias creation. Optional setup is described below. The served-profile set stays adapter-construction-frozen until native restart. Multiplex-off and validation/collision failures reject. |
| `gw.profiles.emoji.set` | `{profileId, emoji}` | `{status:"updated", profileId, emoji}` — writes only the selected routable profile's `platforms.ocuclaw.extra.emoji` key using Hermes's atomic config writer. `emoji:null` removes the key and restores the phone's first-letter fallback. This is never used for OpenClaw agents. |
| `gw.profiles.settings.get` | `{profileId}` | `{status:"loaded", backend:"hermes", agentId, name, emoji, setup:{instructions,model,provider,workspace,blockedTools}}` — reads only the named served profile's SOUL.md and config.yaml. |
| `gw.profiles.settings.set` | `{profileId, emoji, setup, producedAtMs, expiresAtMs}` | the same snapshot with `status:"updated"` and `restartRequired:false` — replaces OcuClaw-owned SOUL, model/provider, starting folder, managed tool-group blocks, and icon while preserving unrelated config keys and unrelated disabled toolsets. Transaction-capable hosts require the `setup.blockedToolsRevision` from GET; a stale revision rejects the entire save before SOUL/config writes. Managed effective blocks are read only. The profile id/name is immutable. |

### Hermes phone management

`families.agents.hermesManagement` advertises support for the authenticated
`ocuclaw.hermes.management` envelope; absent means unsupported, while an absent
capability snapshot remains unknown. This uses the existing paired connection,
not the dashboard or a second listener. Node invokes `gw.hermes.management`.

Both request and result carry `{requestId, operation, scope, profileId}`. The
selected served profile is required even for gateway-scoped capability discovery.
Base operations are `overview` (profile scope) and `capabilities` (profile
or gateway scope); approval operations are described below. Unserved identities, unknown scopes and extra fields are
rejected. Native results retain the identity and `status: ok|unsupported|error`;
the relay allowlists fields and the phone requires all four identity fields to
match its outstanding request. Disconnect, profile switching and timeout retire
the request. Opening settings writes no host state.

Capabilities are individual `{operation, scope, supported, applyTiming}` records.
These reads have `applyTiming: read_only`. Overview returns only a bounded
profile name, configured model/provider, responding gateway state and number of
served profiles read from native `list_profiles()` filtered through the running
adapter's boot-frozen routing table. Configured model/provider are persisted
facts, not effective active-chat claims. When native sources are available,
`activeWork` carries the runner's total with `activeWorkScope: gateway` (chat,
cron and API work across the shared gateway). `attentionCount` with
`attentionKind: learning_proposals` counts selected-profile pending memory and
skill proposals under one shared decision transaction; it is not a count of
tool-call approvals or every possible health issue. Unavailable or failed
sources omit the count rather than invent zero. Other sections remain
unsupported unless their individual native capabilities are present. Native
exceptions are not sent to the phone.

Gateway restart uses the same envelope and authenticated connection:

| Operation | Payload | Result |
| --- | --- | --- |
| `restart.preview` | absent or `{}` | `restart:{gatewayId,bootId,scopeRevision,affectedProfiles,activeWork,waitSeconds,drainSeconds,phase,supported}` |
| `restart.request` | `{operationId,gatewayId,bootId,scopeRevision}` | Same snapshot plus a bounded restart receipt; one native admission at most. |
| `restart.status` | `{operationId,gatewayId}` | Read-only receipt reconciliation against the current native process. |

All three require `scope:gateway` and a selected served `profileId`. The gateway
identifier hashes the native host and canonical process-home filesystem identity.
No hostname or path crosses the link. The boot identifier hashes
native PID and process start-time fingerprint; a plugin/adapter reload cannot
invent a new boot. Affected profiles combine the adapter's captured routing map
and native secondary adapter ownership. A fresh profile-directory scan cannot
silently change confirmation scope. A supported supervisor and a running native
runner are required for admission; an already-down gateway has no start fallback.

The native `request_restart(detached=False,via_service=True)` path immediately
refuses new turns, waits for active chat/cron/API work, then applies the native
bounded drain. Both budgets appear in confirmation because unfinished work may
be interrupted. The adapter writes a durable `dispatching` receipt before calling
the native method. A duplicate operation returns the receipt; a conflicting
payload is rejected. A crash or acknowledgement loss is uncertain and never
permission to dispatch again. The private store admits at most 128 receipts and
262144 serialized bytes; it refuses new admission rather than evicting a duplicate
fence. Atomic receipt write failures before dispatch prevent native admission.

The phone drops restart mutations from its reconnect outbox. Its phone-lifetime
controller preserves operation identity across navigation, profile selection and
disconnect, issuing only status reads on reconnect. Accepted, draining,
disconnected, reconnecting, recovered, rejected and unconfirmed are distinct.
Recovery requires a new process boot, the same gateway and served scope, native
running state, and a response over the fresh authenticated OcuClaw connection.
An accepted receipt, child exit or successful write alone is not recovery.
After three minutes without recovery the phone reports unconfirmed and leaves
a manual read-only status action available.

Restart automation uses `settings/hermes/restart/preview|confirm|cancel|status`.
It invokes the same controller as the popup and verifies lifecycle phase and
operation identity instead of interpreting the action as a profile selection.
#### Approval policy

Profile administration includes remembered rules and approval mode settings.

##### Existing MCP connections and channel health

Tools → Connected tools uses the profile-scoped `connections` payload and eleven
negotiated operations: `connections.read`, `connections.receipt`, `mcp.enabled`,
`mcp.test`, `mcp.testStatus`, `mcp.oauthStart`, `mcp.oauthStatus`, `mcp.oauthCancel`,
`channels.enabled`, `channels.pauseReconnect`, and `channels.resumeReconnect`.
They require the exact [`connections-management-v1` native package](native-compat/connections-management-v1/README.md),
its loaded API markers, and its fully attested dependencies. Callback receiver
availability affects individual OAuth rows, not ordinary management capability.

Reads return bounded, safe existing MCP/channel rows: opaque name, revision,
saved enablement, separately observed effective state, supported controls,
shared-home scope and apply timing. They omit endpoint URLs, headers, raw config,
credentials and provider diagnostics. Missing native attribution stays unknown.
Actual OcuClaw management paths are protected by native adapter identity across
profile aliases, including direct forged requests. A connected channel cannot be
paused as if it were a failed retry queue.

Mutations carry `{mutationId, name, revision, confirmed:true, producedAtMs,
expiresAtMs}`, plus boolean `value` only for enablement. Confirmation lifetime is
at most 30 seconds and is rechecked after locks and before writes/task admission.
MCP and saved channel enablement preserve every unrelated field; their timing is
respectively `new_session_or_restart` and `restart_required`. Reconnect actions
use the native runtime revision and report paused/retrying/connected truthfully.

Receipts carry the original mutation ID and operation, with outcomes `running`,
`authorization_required`, `committed`, `failed`, `cancelled`, `expired`, `unknown`
or `not_found`. Only the four read operations are replay-safe. Tests and OAuth
admit once and run off the request path. Status/receipt reads use `{mutationId}`.
Cancellation uses the original OAuth-start ID plus fresh confirmation times;
it does not allocate a second mutation identity. Cancellation is terminal after
the worker discards staged credentials, and late cancellation cannot undo a
committed authorization.

Only OAuth start/status responses may include a transient safe authorization
URL. The phone opens that URL in the browser; tokens and callback exchange stay
on the native host. The native worker preserves profile secret scope, stages
new credentials, and fences cancellation plus config/credential races before
commit. The real existing native callback route supports a separate gateway
process through private, one-use state. No dashboard token is reused as phone
authority and no callback listener is created by a phone request.

The phone stores only original mutation ID/operation/time, scoped to its actual
connection and profile. Per-operation capability withdrawal retires pending
requests and rejects late replies while preserving uncertain identity. It
clears transient URLs on leaving the section, switching profile or connection,
and on capability withdrawal. Unknown/missing outcomes lead to read-only receipt
checks and explicit review, never automatic mutation resend. Phone automation
uses the same controller through `webui hermes-connections`.

##### Profile tool blocks and installed skills

`tools.read`, `tools.block`, `tools.skillToggle`, `tools.receipt`, and
`tools.recover` are profile-scoped operations in the authenticated management
envelope, with a `tools` payload. Stock Hermes supports `tools.read` through an
OcuClaw-owned inspector; every returned control is read only. Its revision
hashes identify snapshots, not native compare-and-swap tokens. Mutation and
receipt operations still require the legacy attested native transaction
contract and return unsupported on stock Hermes. Proposal payloads and the
development installer are excluded from the shipped bundle.

Stock snapshots return `availableTools:null` and `state:not_checked` because
native eligibility probes can resolve auxiliary OAuth credentials. Reading
saved settings and installed-skill metadata never runs those probes.

The read snapshot identifies the actual OcuClaw platform, the three existing
web/file/terminal blocks, native available-tool counts, and installed skills.
`blocked`, `unavailable`, and `allowed_by_setting` are distinct; the last does
not promise a command will pass chat overrides or native guards. Skills retain
OS/environment/dependency reasons, native project/profile/external precedence,
content identity, global restrictions, essential status, and writability.
Only a selected profile's `skills.platform_disabled.<actual-platform>` list is
changed; global disables and essential skills cannot be overridden here.

Native eligibility runs outside the configuration transaction; configuration
and leaf revisions are captured coherently and rechecked before admission.
Receipt/recovery snapshots skip tool eligibility: `state:"not_checked"` and
`availableTools:null` preserve the original receipt outcome without waiting on
native provider caches. The UI asks for Refresh to inspect availability;
unchecked availability is never represented as zero available tools.

Block and skill mutations carry `{mutationId, name, value, revision,
confirmed:true, producedAtMs, expiresAtMs}`. `value` means blocked for
`tools.block`, enabled for `tools.skillToggle`. The block revision is the same
leaf revision used by existing profile settings. The skill revision includes
native catalog/content and inherited-policy identity. Both writers compare
under the native profile lock, preserving other entries and configuration.
Skill content is never changed and enabling never installs dependencies.

Receipt reads carry `{mutationId}`. Explicit recovery carries `{mutationId,
kind:"blocks"|"skills", confirmed:true, producedAtMs, expiresAtMs}` and closes
the original identity without replay. Committed, unknown, cancelled, and
reconciled-unknown receipts retain their native distinctions. The phone keeps
only pending identity/kind/recovery metadata through reload and reconciles
before another edit. Mutations and revisioned existing-profile saves are not
queued across disconnects.

Native admission validates integer intent times after acquiring the config
lock and again before the first write: positive lifetime at most 30 seconds,
nonnegative production time no more than 5 seconds ahead of the native clock,
and an unexpired deadline. Expired requests create no receipt/config/SOUL
write. Existing profile setting writes use the same bounded intent fields.

Timing is `new_chat`: an existing agent may retain its tool roster. After a
skill toggle, run native `/reload-skills` in the selected profile, then start
a new chat; already-loaded skill text may remain in older conversations.
The native compatibility patch also makes the slash-command scanner resolve
the live profile skill directory when profiles change.

##### Remembered permissions and deny rules

The profile-scoped operations `permissions.read`, `permissions.revoke`,
`deny.add`, `deny.edit`, `deny.remove`, `permissions.preview`,
`permissions.receipt`, and `permissions.recover` use a typed `permissions`
payload on the existing authenticated management envelope. Served profile
authority is the same boot-frozen routing table used for approval settings.
No operation issues an always-allow grant from OcuClaw.

Reads return `remembered` and `deny` lists, each with a source revision,
`source`, `writable`, and indexed entries containing actual `pattern`, native
`semantics`, and `effect: eligible|ignored_empty`. Lists are limited to 200
string entries of at most 512 characters; malformed or larger native lists
are reported as unreadable on this administration surface. The snapshot
distinguishes `cacheEffect: fresh_profile_each_guard|unverified_cached_policy`
from `sessionGrantEffect: unchanged`. Stock hosts can report saved rules but
remain read only. Mutations and preview require the separately installed
[`permissions-v1` package](native-compat/permissions-v1/README.md), its config
dependency/frontend attestation, and fresh loaded native markers.

Every mutation sends `{mutationId, revision, confirmed: true}`. Revoke,
deny-edit and deny-remove also send the selected `index`; deny-add and
deny-edit send `pattern`. The revision covers the selected source list, so
concurrent edits conflict while unrelated native configuration is retained.
Native matching semantics are unchanged. The phone explicitly confirms
revocation, changing a deny pattern, and removing its protection.

Preview sends only `{command}` and returns that same command with the native
local-environment guard verdict. It does not execute the command, and runs in
a clean profile context rather than borrowing the calling chat's YOLO or room
policy. It does not predict other tool restrictions or isolated-container
guard bypasses. A native allowed preview is not a sandbox guarantee.

Receipt reads send `{mutationId}`. Explicit recovery sends `{mutationId, kind}`
where `kind` is `remembered|deny`. Receipts use the config transaction journal
and expose `changedFields` using those same list names. The phone persists
only the pending identity/list/recovery intent, scoped to actual
endpoint/credential and profile; it never persists or replays the old rule
payload. Only a matching terminal receipt with current native readback clears
the pending journal. Cancelled and reconciled-unknown outcomes require an
explicit confirmed recovery, and unknown remains unknown.

##### Approval mode and timeout

`approvals.read`, `approvals.update`, `approvals.receipt`, and `approvals.recover` use profile scope
and the existing management envelope. Profile authority comes from the
gateway's boot-frozen served routing table, including the frozen default home;
request payloads never supply a filesystem path. Each operation has its own
capability record. Read/receipt timing is `read_only`; update timing is
`subsequent_guard_checks`, including the fact that existing approval prompts
retain their original deadlines.

The optional `approvals` request object is empty for read. Update requires:

```json
{
  "mutationId": "approval-example-001",
  "changes": {"mode": "smart", "timeoutSeconds": 60},
  "expected": {"mode": "<64 lowercase hex revision>", "timeoutSeconds": "<64 lowercase hex revision>"},
  "confirmations": []
}
```

The only writable fields are `mode` (`manual|smart|off`), `timeoutSeconds`
(positive JSON integer within the reported native limit), and `cronMode`,
`oneShotMode`, `unattendedMode` (`deny|approve`). Only dirty fields and their
original revisions are sent. `confirmations` must exactly name every changed
Off/Approve field; the phone obtains each through an explicit confirmation
dialog. Unknown fields, extra keys, numeric strings, booleans, invalid values,
duplicate confirmations, and requests for unserved profiles are rejected before
mutation admission.

Results contain a curated `approvals.fields` map with per-field `savedPresent`,
`savedState: absent|recognized|unrecognized`, finite `savedValue` when recognized,
`effectiveValue`, `revision`, `source: managed|user|default`, and `writable`.
Arbitrary saved configuration values are never echoed. The snapshot also reports
`maxTimeoutSeconds`, `processYolo`, and `sessionOverrides`/`roomOverrides` as
`not_evaluated`: profile defaults do not claim the current chat's effective
override state. Managed controls remain disabled, and absent native APIs remain
unsupported. Malformed native policy reads are errors, not healthy defaults.

Updates require the separately installed
[`config-transactions-v1` native package](native-compat/README.md), its rebuilt
dashboard attestation, and fresh loaded writer markers. Stock native Hermes
remains read-only on this surface. Native full-document and CLI writers
participate in the same transaction lock; same-field changes conflict while
unrelated leaf changes are retained.

Receipt requests contain only `{mutationId}`. Mutation results and receipt reads
carry `receipt: {mutationId, outcome: committed|unknown|cancelled|reconciled_unknown, changedFields}`. The
relay verifies the receipt matches the pending mutation. Updates are never
buffered/replayed across disconnect; profile switching retains the original
pending identity. Timeout or uncertain transport delivery leads to receipt
reconciliation, never automatic mutation retry. A conflict preserves the draft
and requires an explicit refresh/review before another save. `committed` plus
native readback clears the pending mutation; unknown remains explicitly
unconfirmed.

Before update admission the phone durably stores only mutation identity and
affected field names, keyed by a digest of the actual endpoint/credential scope
and profile. A reload restores receipt reconciliation without replaying changes;
storage failure disables new saves. Every actual connection generation retires
old requests even when Compose coalesces disconnect/reconnect observations.

Explicit, confirmed recovery sends only `{mutationId, fields}`. Under the same
native transaction lock it returns an existing committed receipt, closes an
unknown journal as `reconciled_unknown`, or writes a durable `cancelled`
tombstone before a delayed original request can be admitted. Recovery never
reapplies the old values. Only an exact identity/field-set terminal receipt plus
current native readback clears the pending journal; non-committed terminal
receipts additionally require persisted explicit recovery intent. The phone
describes an unknown outcome as unknown and asks the user to review current
values before a new change. Recovery requests also use the no-replay outbox.

Phone automation uses the same controller as the UI through
`settings/hermes/<section>/<profileId>` deep links (last two segments optional).
Selecting a profile refreshes its read, and `phone.hermesSettings` exposes the
bounded state, selected profile, section and request correlation for runtime proof.

Learning → Pending adds profile-scoped `memory.pending`, `memory.review`,
`memory.decide`, and `memory.receipt`. These capabilities require the exact installed
`memory-decisions-v1` native compatibility package and dependencies. Unsupported is
distinct from an empty list. Requests carry an operation-specific `memory` object:
review takes `proposalId`; receipt takes `operationId`; decide takes both plus
`decision: approve|reject`, `proposalRevision` and `targetRevision` SHA256 values.
Pending takes an empty object. Reviews retain complete operations and literal
before/after text; payloads above 512 KiB are refused rather than shortened.

Decision operation IDs are saved before phone admission, and `memory.decide` is
non-replayable. After a lost reply or reconnect the phone queries the original
receipt. Terminal failures and successful decisions are durable; an uncertain
native intent blocks cooperating native writers until explicit native recovery.
For `not_found`, `/memory recover OPERATION_ID` durably cancels admission under
the same native lock and returns `not_applied`. A delayed decision with that ID
is refused; the untouched proposal requires a fresh review and new operation ID.
The phone refreshes pending counts after a terminal receipt and keeps counts
unknown after failed reads. Native CLI, gateway memory commands and Desktop reset
participate in the native transaction lock. See
`native-compat/memory-decisions-v1/README.md` for exact compatibility and recovery.

Visible full-review proof uses `simctl action app --lane webui --operation
settings-scroll --direction start|end|up|down`. It moves the mounted settings body's
actual scroll container, clamps to its bounds, and refuses unavailable panels.
`phone.settingsScroll` exposes actual `value`, `maxValue`, and `viewportSize`;
successful dispatch alone does not prove scrolling landed.

Guided creation is advertised by `gw.profiles.list.setupSupported`. The optional
`setup` object accepts `instructions` (SOUL.md, max 8000 characters), `model`
and `provider` (both or neither), `workspace` (starting folder; absolute or ~/),
and `blockedTools` (a subset of web, files, terminal). These become additive
`agent.disabled_toolsets` entries web, file, terminal. They are tool-group blocks,
not filesystem or network isolation; skills and other tools are unchanged.
Missing or empty text fields keep native defaults. No old conversations are copied.

Rich requests require a stable `requestId`. A receipt inside the newly created
profile stores that id and a hash of the setup, never credentials. A matching retry
resumes that profile; a different request cannot configure an existing profile.
`partial` means the profile exists but some settings are not saved: retry setup
before offering restart. Profile creation is distinct from activation.
| `gw.profiles.soul` | `{profile}` | `{content}` — `get_profile_dir(name)/SOUL.md` (the same source as `GET /api/profiles/{name}/soul`); unknown profile ⇒ plain error (NOT `-32601` — a bad agentId must not latch `workspaceIdentityFilesUnsupported` for the whole connection) |
| `gw.skills.status` | `{}` | `{skills:[{name, description}]}` — `get_skill_commands()` rows; additionally filtered by `skills.platform_disabled.ocuclaw` (the scan's implicit platform scope is unset on this lane, so the per-platform filter is applied explicitly); the bridge synthesizes `eligible:true` (hermes filters disabled at scan) |
| `gw.commands.list` | `{}` | `{commands:[{name, description, category, source, instantSend, noTrailingSpace, busyPolicy, argsHint?, aliases?, subcommands?}]}` — COMMAND_REGISTRY rows filtered by `_is_gateway_available(cmd, _resolve_config_gates())` (every non-`cli_only` command, plus `cli_only` commands whose `gateway_config_gate` dotpath is truthy — the INVERSE of the TUI's `commands.catalog` filter, which drops `gateway_only` because it serves the CLI); two lane-local suppressions (`start`, `topic` — platform plumbing, not addressable from the composer); `_iter_plugin_command_entries()` appended as `source:"plugin"` rows (name-deduped). `name` is PRE-SLUGIFIED (lstrip `/`, `_`→`-`, lowercased) and IS the literal wire token, so `translateHermesSkillSlash` never has to rewrite a palette selection. `busyPolicy` is registry-native and is display state, not a filter. Skills are NOT included — they ride `gw.skills.status`. Absent/older hermes or a config-read failure ⇒ `{commands: []}` / gates closed. The bridge shapes these into the OpenClaw `commands.list` CommandEntry vocabulary (`/`-prefixed `textAliases`, `scope:"text"`, `acceptsArgs = !!argsHint`, category mapping `Session`→`session` / `Configuration`→`options` / `Info`→`status` / `Tools & Skills`→`tools`, `subcommands`→a single optional `args[0].choices`) |

## STT lane (#1938 capabilities · #1939 transcribe)

Child → parent RPCs serving the phone's Hermes-STT voice settings and its batch
voice turns. Python side: `stt_rpc.py` (in-process hermes calls, off the event
loop via `asyncio.to_thread`). The listing half does no network I/O; the
transcribe half is a batch STT call and does. Node side maps a JSON-RPC error
onto the snapshot's `status:"error"` and no-link onto `status:"offline"`; node
timeout is 10 s for the listing and 60 s for a transcription.

| Method | Params | Result |
|---|---|---|
| `stt.capabilities.list` | `{}` | `{providers:[{id, displayName, available, unavailableReason, models, defaultModel, supportsLanguage, supportsPrompt}]}` — one row per Hermes STT backend the operator can pick. Sources, in wire order: hermes's own `BUILTIN_STT_PROVIDERS` (ids never enumerated locally), then `stt.providers.<name>: type: command` rows, then `agent.transcription_registry.list_providers()`. `unavailableReason` is `null` whenever `available` is true; `defaultModel` may be `null` (xai takes no model parameter, deepinfra resolves a live catalog) but when non-null is ALWAYS a member of `models`; `models` may be `[]` |
| `stt.transcribe` | `{provider, model?, language?, prompt?, audio:{format:"wav", sampleRateHz:16000, channels:1, path}}` — `provider` required, the id the phone picked from the listing; `model`/`language`/`prompt` nullable and blank-tolerant (both mean "unset"); `audio.path` is the control-link spill file. | `{success, transcript, provider, error}` — Hermes's own transcribe envelope, values untouched, with its two optional keys filled: `provider` keeps whatever backend Hermes says actually ran, falling back to the pick; `error` is `null` on success and never empty on failure. NEVER raises: every refusal, provider error and unexpected exception comes back as `success:false` |

The relay additionally supports progressive **phone-to-relay uploads**. This is
independent of provider streaming: Python still receives exactly one complete WAV
through `stt.transcribe`, and the phone still reveals one whole final transcript.
The relay advertises `uploadProtocolVersion:1` in its successful
`ocuclaw.voice.hermes.stt.capabilities.snapshot` only when its upload lane is installed.
An absent or unknown version selects the legacy batch frame before capture starts.

Frames under `ocuclaw.voice.hermes.stt.upload.*`:

| Suffix | Required fields | Effect |
|---|---|---|
| `begin` | `uploadId`, `voiceSessionId`, `format:"pcm_s16le"`, `sampleRateHz:16000`, `channels:1` | Create a private 0600 staged WAV, owned by authenticated transport client + upload id. |
| `chunk` | `uploadId`, zero-based `sequence`, base64 `content` | Append aligned PCM in exact sequence; each decoded chunk is at most 16,384 bytes. |
| `commit` | `uploadId`, `requestId`, `expectedChunks`, `expectedPcmBytes`, `provider`, optional `model/language/prompt` | Freeze, finish queued writes, check totals, patch the WAV header, then call the existing RPC once. Returns the existing transcribe result with `requestId`. |
| `cancel` | `uploadId` | Discard uncommitted audio; abandon an issued result without replaying inference. |

Non-commit frames return `upload.status` with `uploadId`, `success` and optional
`error`. The phone aborts on a correlated failure. Every upload frame is no-replay;
there is no automatic batch fallback after upload begins or after an uncertain commit.
The microphone stops before tail PCM is flushed and the commit is enqueued.

Staging reserves budgets synchronously and serializes filesystem writes per upload.
Limits are four active uploads, one per client, 3,999,956 PCM bytes per utterance,
262,144 queued bytes globally, 30 s idle and 180 s absolute capture lifetime.
At most 256 upload identities are retained, including terminal tombstones. Duplicate
commits with the same request reuse their result; reused begin identities are refused.
Cancellation, disconnect, worker exit and shutdown clean staging; startup reclaims
only upload files naming a provably dead process. Python-owned files remain under
the existing adapter cleanup contract.

Four invariants the transcribe half holds:

- **The pick beats the config.** `transcribe_audio` has no provider parameter —
  it resolves `stt.provider` through `_get_provider`, the lazy-install seam. The
  lane calls Hermes's explicit-provider seam instead,
  `_dispatch_stt_provider(file_path, provider, stt_config, model, source)`
  (`transcription_tools.py:3017`, the call `_transcribe_prepared_audio` makes at
  `:3013` with its resolved provider), passing the phone's id positionally, so
  `stt.provider` never decides and `_get_provider` is never called. That seam
  also carries Hermes's whole dispatch precedence — built-in > `type: command`
  > plugin-registered — so all three lanes the listing offers are transcribable
  through one call. `model` rides as the argument (it overrides config in every
  branch); `prompt` rides on a COPY of the stt config at `stt.prompt`, the key
  that seam reads (`:3021`) before passing it to every backend, so the prompt
  pick reaches all three lanes through Hermes's own resolution.
  `language` is written on that copy under the ALIASED section
  (`_CONFIG_ALIAS`: `local_command` → `stt.local`, the section
  `_transcribe_local_command` resolves from at `:2110`) and under the raw name
  too, which is what `_dispatch_stt_provider` reads at `:3043`.
  **Language reach:** the overlay's language lands for the command lane
  (`:930`) and the plugin lane (`:3150`) — both thread this config object. It
  does NOT reach the eight built-ins: `:3043` feeds the config language into
  `_apply_pre_transcription_hook`, which returns `None` for language unless a
  `pre_transcription` plugin hook sets one (`:1440`, `:1492`), and each
  built-in then re-resolves from a FRESH `_load_stt_config()`
  (`_resolve_stt_language("groq")` at `:2208` and friends take no config
  argument). No in-memory overlay is visible there. **#1940 (contract ruling
  14) closes that with the hook**, below.
  Ids are carried EXACTLY as published, never case-folded: built-in ids are
  lowercase at the source and compared with `==` (`:3040+`), plugin ids are
  lowercased by the registry that owns them, and command ids are
  case-preserving YAML keys. Absent picks are left absent — a wearer who
  set nothing gets exactly what a Hermes-side transcription would have used.
  An id in none of the three lanes is refused by name (`is_stt_enabled:false`
  likewise) rather than falling into Hermes's generic "install faster-whisper"
  setup hint, which reads like a broken Hermes.
- **The built-ins' language rides a scoped `pre_transcription` hook** (#1940,
  contract ruling 14). The bundle registers Hermes's documented
  `pre_transcription` hook — `ctx.register_hook("pre_transcription", …)` in
  `adapter.py`'s `register()`, gated on the name being in the host's
  `hermes_cli.plugins.VALID_HOOKS` (0.20.6+; `register_hook` WARNS and stores
  an unknown name rather than refusing it, `plugins.py:3259`, so blind
  registration would log on every older host and wire a callback that can never
  fire). `plugin.yaml`'s `provides_hooks` entry is descriptive only — Hermes
  0.20 never reads it — so the runtime call IS the mechanism. The hook fires at
  `_dispatch_stt_provider:3043` → `_apply_pre_transcription_hook:1409`, after
  provider resolution and before ANY backend, and may mutate
  `model`/`language`/`prompt` (`file_path` is read-only).
  **Scope is one call, and that is the load-bearing part.** The callback
  (`stt_rpc.pre_transcription_hook`) answers only while `_CALL_TWEAKS` — a
  contextvar the `stt.transcribe` handler sets around its own
  `_dispatch_stt_provider` call — is set. `asyncio.to_thread` copies the
  caller's context and runs under `ctx.run(...)`, so the value is visible to
  the hook deeper in the same worker-thread call stack and cannot leak back to
  the event loop or sideways into another task. Every other transcription on
  the gateway — an iMessage voice note, `hermes voice`, another platform's
  audio, a concurrent OcuClaw call — finds the context unset (or naming a
  different provider, the re-entrancy guard) and gets `None`, leaving that
  dispatch byte-identical to a host with no plugin loaded. Registration is
  gateway-wide but costs a non-OcuClaw transcription one `has_hook` probe and
  one no-op call; unlike the `on_stream_*` family it flips no process-wide
  provider call shape, so it needs no operator opt-in.
  **One source of truth.** The handler builds a single `_SttCallTweaks` per
  call; `_dispatch_overlay` and the hook both read it and neither derives a
  value of its own, so the two channels cannot state different picks. The hook
  returns only the fields this call actually picked — an absent pick stays
  absent, because `""` would clear a configured `stt.prompt` (`:1483`) and
  blank a configured language. It advertises no feature token: the wire shape
  is identical with or without it (`adapter.PRE_TRANSCRIPTION_HOOK_AVAILABLE`
  is diagnosis, not protocol). Fail-open twice — the callback swallows its own
  faults, and `_apply_pre_transcription_hook` wraps every callback in a bare
  `except` (`:1490`).
- **The listing's support flags never gate the wire** (#1940, cross-leg). The
  client sends a set `language`/`prompt` on EVERY transcribe call regardless of
  the picked row's `supportsLanguage`/`supportsPrompt` — a turn can happen
  before any listing was fetched, so the wire cannot depend on one. The
  transcribe lane therefore reads neither flag: it forwards the picks and lets
  Hermes's own backend decide, which for `local_command`, `xai` and
  `elevenlabs` means logging "does not support transcription prompts" and
  dropping it (`:2091`, `:2453`, `:2616`). Never an error envelope — a leftover
  prompt must not cost the wearer an utterance on a provider that would have
  ignored it. `supportsPrompt` annotates the PICKER, nothing else.
- **Audio never rides the link line.** `audio.content` (inline base64) is
  refused, not decoded: the link is one JSON frame shared with every other RPC.
  The Node child force-spills into the shared tmpdir at 0600 + `O_EXCL`
  (`link-attachment-spill.ts:44-56`) under `ocuclaw-stt-*` for this lane
  (`hermes-stt-lane.ts:35`), which is the ONLY prefix this end accepts (§5f
  ruling 19). The transport's shared `ocuclaw-attach-*` default
  (`link-attachment-spill.ts:31`) is the DISPATCH lane's — refused here, because
  claiming one would rename and delete another lane's in-flight attachment. The
  declared wav/16000/1 shape is asserted, not converted — a mismatch is leg
  drift.
- **The spill file is claimed, then dies with the request.** Node unlinks the
  descriptor best-effort when the RPC settles OR when its 60 s timeout fires
  (contract §5c) — a deliberate race whose loser would be a provider reading a
  file that vanished mid-transcription. So the adapter `os.rename()`s the bytes
  to `ocuclaw-stt-owned-<uuid>.wav` in the same directory (atomic, so there is
  no window) BEFORE any validation past the path guard and before any slow
  work. The suffix is load-bearing: Hermes's OpenAI-compatible providers use
  the path basename as the multipart filename. The adapter runs the provider
  against the claimed name, then unlinks it on every outcome. `ENOENT` on the
  rename means Node already reclaimed it: a clean
  expired-request refusal, nothing transcribed. Any other rename failure leaves
  the bytes as Node's to reclaim — this end deletes only what it renamed, and
  `ENOENT` on its own unlink is harmless.
  The path guard runs first and admits ONLY a resolved path whose parent is one
  of the system temp directories (`gettempdir()`, the `TMPDIR`/`TMP`/`TEMP` env
  values, `/tmp` — a SET, because Node reads those three in the order
  TMPDIR,TMP,TEMP and Python in TMPDIR,TEMP,TMP, so a host that sets TMP and
  TEMP apart has the two halves naming different directories; never a directory
  the request itself declares) and whose basename starts with `ocuclaw-stt-`
  and NOT with
  `ocuclaw-stt-owned-` — an already-claimed name belongs to a request that is
  mid-dispatch, and a second request naming it would pull the file out from
  under a running provider. A path failing that is refused AND left untouched:
  refusing to transcribe someone else's file must never turn into deleting it,
  and `resolve()` is what makes a planted symlink fail the parent test. The
  claimed name never appears in a wearer-reachable error string; it goes to the
  log.
  **Orphan sweep.** A claimed file whose process died mid-transcription is
  unreachable forever — Node only unlinks the name IT minted, and the guard
  refuses the owned prefix by design — so up to ~4 MB of the wearer's voice
  would sit in a world-readable temp dir until reboot. The first handler call
  of each process therefore sweeps `ocuclaw-stt-owned-*` regular files older
  than an hour (60× the Node ceiling) across the same candidate dirs, best
  effort, symlinks skipped. It runs on the `to_thread` worker, once per
  process: orphans are made by a process that died, so the next start is
  exactly when they become collectable.
- **An unavailable pick is refused, never installed** (#1941, §5f ruling 18).
  After the dispatchability check and before the dispatch, the transcribe lane
  asks the SAME read-only probes the listing uses about the picked provider, and
  a provider they call unavailable comes back as `success:false` carrying the
  listing's own `unavailableReason` wording (`GROQ_API_KEY` is unset, install
  faster-whisper, …). Without it, picking `local` on a host without
  faster-whisper enters `_try_lazy_install_stt` — hundreds of megabytes, minutes
  long, inside the 60 s Node ceiling, in an `asyncio.to_thread` worker nobody
  can cancel — so the relay abandons every such request and the wearer only ever
  sees a timeout. Two deliberate pass-throughs: a built-in this build has no
  probe for is unknowable rather than unavailable (refusing it would make a
  post-0.20.6 Hermes built-in permanently untranscribable), and a `type: command`
  provider's command is a shell template this process must not run to check.
- **Every failure class is its own sentence.** Unknown provider, unreachable
  (mixed-case) command key, unavailable provider, disabled STT, missing dispatch
  seam, spill-guard refusal, expired/unclaimable spill, bad audio shape, inline
  content, provider error envelope and provider exception each return a distinct,
  stable, human-readable `error` naming the provider where one is known — these
  are the #1941 scripted-failure-run fixtures.
- **No echo.** The handler touches the transcription surface and nothing else —
  no `MessageEvent`, no `handle_message`, no media cache, no session write. The
  transcript reaches the wearer exactly once, as this RPC's result; the phone
  owns the commit. Held by tripwires on every message/session entry point in
  the pytest stubs plus a source pin over `stt_rpc.py`.

**Where the no-install boundary runs.** The listing's "never installs anything"
guarantee is scoped to the LISTING lane. `stt.transcribe` is deliberately
exempt: `_dispatch_stt_provider` → `_transcribe_local` →
`_try_lazy_install_stt` (`:1942`) is exactly where Hermes installs
faster-whisper on the first local transcription, and the wearer who committed
an utterance asked for it. The wearer who opened a settings screen did not. The
two lanes share no helper that crosses the line, and
`test_the_transcribe_lane_uses_the_seam_the_listing_lane_may_never_reach` pins
both sides.

Four invariants the listing half holds:

- **One lane never sinks the listing.** A registry whose `list_providers()`
  throws — any third-party plugin's import-time side effect can cause it —
  degrades to the plugin lane going quiet, exactly like a host with no registry.
  It is NOT a JSON-RPC error: eight healthy built-ins replaced by "Hermes STT is
  broken" is the failure mode this whole module is written against.
- **Annotated, never filtered.** An unavailable provider crosses with
  `available:false` plus human-readable `unavailableReason` (missing key,
  missing package, missing CLI). Hiding it reads as an OcuClaw defect.
- **Listed = usable or configured.** A built-in appears when it probes
  available, OR the operator's own `stt:` block carries `stt.<id>`, OR
  `read_selection("stt")`/raw `stt.provider` names it (`nous` ⇒ `openai`).
  "Configured" is read from the RAW config, never the defaults-merged view:
  Hermes seeds `stt.local`, `.groq`, `.openai`, `.mistral`, `.xai`,
  `.elevenlabs` and `.deepinfra` into the merged config of EVERY install, so
  merged presence means "the schema has a default". Values still come from the
  merged config. Command and plugin providers are always listed — declaring or
  registering one IS configuring it. `stt.enabled:false` ⇒ `{providers: []}`,
  the honest empty state the phone renders as "no STT configured in Hermes".
- **No install and no credential write, ever.** Hermes's own resolver
  `_get_provider` lazy-installs faster-whisper (`transcription_tools.py:1059`,
  `:1157`), and two of the credential resolvers it reaches refresh OAuth tokens
  under the cross-process auth-store lock ("can block for 20+ seconds",
  `credential_pool.py:1869-1884`) — past this lane's 10 s timeout, and writing
  to disk. This lane never calls `_get_provider` or `transcribe_audio`, and
  takes the read-only variant at both refresh seams:
  `is_managed_tool_gateway_ready` rather than `resolve_managed_tool_gateway`
  for `openai`, and `read_credential_pool("xai-oauth")` rather than
  `resolve_xai_http_credentials()` for `xai`. Everything else is a plain read
  (cached import flags, `find_spec`, PATH, config/env/credential-pool).
- **One row per `id`, compared case-insensitively.** `id` is the key the
  client renders and dedupes on, so a duplicate would make one row vanish
  silently. Collisions are resolved here on Hermes's own precedence (built-in >
  command-type > plugin) with a `logger.warning` naming both claimants, and the
  surviving row keeps its EXACT id. Comparison folds case because both lookups
  on the far side do (`transcription_registry` lowercases on register and
  lookup, `:80`/`:123`; `_resolve_command_stt_provider_config` lowercases the
  pick, `:478`) — `OpenRouter` and `openrouter` are one provider to Hermes and
  two strings on the wire. Precedence yields when the incumbent is
  `available:false` and the challenger is not: a command key Hermes cannot
  resolve does not get to shadow a plugin that can (below).
- **A command key Hermes cannot look up is listed `available:false`.**
  `_resolve_command_stt_provider_config` lowercases the picked name (`:478`)
  and `_get_named_stt_provider_config` then does an exact `providers.get(name)`
  (`:442`), so a `stt.providers.MyASR` declaration is unreachable under EVERY
  pick — probed against the pinned 0.20.6: `MyASR` MISSES, `myasr` MISSES,
  while `stt.providers.myasr` is FOUND under either. The row is annotated with
  the rename that fixes it rather than published as available and failing on
  every use; `stt.transcribe` refuses such a pick by name.

`supportsLanguage`/`supportsPrompt` are read off the 0.20.6 batch bodies, not
inferred from config keys: every backend accepts a `prompt=` argument and
`local_command`, `xai` and `elevenlabs` log "does not support transcription
prompts" and drop it. Language is honored by all built-ins. Plugin providers
get both `true` — `language` is a formal keyword of
`TranscriptionProvider.transcribe` and the dispatcher forwards `prompt` through
`**extra`; the ABC carries no capability metadata to read.

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
`{id,sessionKey,question,choices,multiSelect,allowOther,deadlineSec,expiresAtMs}`. Pretext
chooses a compact checklist, packed pages, or a single-item reel once when the
prompt arrives. Single choices resolve as their label; multi-select choices
resolve as a JSON-array string through child → parent RPC `clarify.resolve`.
Open questions and `Other` use request-addressed `clarify.await_text`, which
calls `mark_awaiting_text(id)` so the next voice/text message answers that exact
pending request. Dismissal and expiry send no answer.

OcuClaw-owned rows in `db.sessions.list` additionally carry
`agentStatus:{working,needsYou,failed,observedAtMs,unknown?}` and an internal
`attention:{sessionKey,runActive,clarify,approvals}` snapshot. These are read-only
observations: working comes from the adapter's dispatch ledger, pending questions
from the stock public `get_pending_for_session` API, and approvals from the
adapter's existing native approval mirror. A set native response event clears
attention immediately, even before the waiting tool removes its entry. Observer
failures report `unknown:true` without failing the native list or changing a turn.
Foreign transcript rows do not receive an OcuClaw live-status claim.

The bridge preserves status through session-list diffs; both sides fingerprint
the status fields and observation timestamp. Home refreshes while visible even
when the selected agent is idle. Snapshots older than 15 seconds or a disconnected
gateway show Unknown. Unread retains Hermes' native watermark semantics.
Pinned agents in the glasses contextual menu use the same aggregate status and
priority: `(?)` Needs you, `(…)` Working, `(•)` Unread, `(!)` Failed, `(–)` Unknown.
Idle pins retain their normal agent marker. A runtime-owned two-second refresh
keeps these names current independently of the phone panel; only changed menu
labels trigger a serialized page-container rebuild. Pin IDs, order, and selection
actions remain stable, and the prefix counts toward the SDK's UTF-8 label limit.
The selected session's composer uses its own run state; a background run must
not mark a newly selected idle session busy. Late context replies for an old
selection are discarded.
Failed records the last observed non-cancellation turn failure and clears on the
next turn or after 24 hours; this observer state is disposable on restart.

Attention is displayed only for the selected session. Switching or reconnecting
requests a fresh exact-key source snapshot through `sessions.attention`; it never
replays a cached question. A replay retains the original absolute expiration,
and an answer elsewhere retires only the local mirror. No status read registers,
answers, cancels, or extends a Hermes question. A gateway restart cannot fabricate
a fresh presentation deadline. Status coverage follows the served profiles and
the existing bounded session-list window.

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
| `channelPrompt?` | → `MessageEvent.channel_prompt` (per-turn ephemeral system layer); legacy and owned prompt callers produce the same model-visible content bytes |
| `promptOwner?` | owned-prompt product metadata: exactly `ocuclaw` or `even-ai`; must appear with `promptLane` and a non-empty `channelPrompt` |
| `promptLane?` | owned-prompt lifecycle metadata: exactly `logical-session-frozen` or `turn-scoped`; must appear with `promptOwner` and a non-empty `channelPrompt` |
| `attachments?` | `[{type, mimeType, fileName, content?|path?, source?, sizeBytes?, widthPx?, heightPx?}]` — `content` is inline base64 up to `LINK_ATTACHMENT_INLINE_MAX_CHARS = 262144` serialized chars; larger payloads are spilled by the child to a temp file and cross as `path`. The parent ingests bytes via hermes `cache_media_bytes` → `MessageEvent.media_urls` (LOCAL PATHS, parallel `media_types`) and unlinks the spill file after ingestion; the child unlinks on RPC failure. |

`promptOwner` and `promptLane` are bounded enum metadata on this existing
size-capped NDJSON frame; they introduce no second transport or network
surface. The parent validates both before dispatch and retains them as
internal `MessageEvent` metadata. Hermes model input continues to read only
`channel_prompt`, so adding ownership metadata changes no model-visible bytes.

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

### The Desktop half of the removal contract

Since #2084 the only runnable OcuClaw Desktop plugin is the generated
`<HERMES_HOME>/desktop-plugins/ocuclaw/plugin.js`. It belongs to no Hermes
package: Hermes Desktop's `diskRoots()` scans that directory itself, and the
door is default-ON. Generic `hermes plugins remove ocuclaw` therefore removes
the Agent package and leaves that runtime loading — which is exactly why it is
not documented as complete OcuClaw removal.

`hermes ocuclaw uninstall` removes it under the same ownership rule the
reconciler writes it with: the first line must be the OcuClaw ownership
marker, or the file is preserved and the receipt reports
`preserved.desktopPairingPlugin = "preserved_foreign"`. Removal also sweeps
the reconciler's own `.plugin.js.<pid>.<token>.tmp` render temporaries and
removes the generated folder only once it is empty, so an unrecognised sibling
keeps it. The receipt's final `ownedDesktopRuntimeAbsent` check is asked of
the loader's two doors — `<home>/desktop-plugins/<folder>/plugin.js` and
`<home>/plugins/<folder>/desktop/plugin.js` — rather than of the paths the run
happened to touch, and a preserved foreign file at either door does not fail
it.

`PROFILE_STATE_FILES` is the exhaustive list of OcuClaw's own
`<HERMES_HOME>/state` files, hidden lock sidecars included. Every OcuClaw
writer that can land in that directory must appear there or be a documented
retention; the private Desktop presenter capability and the pairing activation
receipt are in it, so no capability outlives the runtime it authorizes.

Recovery after a generic removal cannot be an OcuClaw verb, because generic
removal deletes the command surface. `uninstall.ORPHAN_RECOVERY_SOURCE` is a
self-contained interpreter-level program — the same precedent as the tombstone
recovery command above — surfaced by
`uninstall.desktop_orphan_recovery_command()` and documented verbatim in
`after-install.md`. It refuses while `<home>/plugins/ocuclaw` still exists,
proves the ownership marker, refuses symlinked or redirected paths, removes
only the generated runtime and the private presenter capability that
authorizes it, preserves anything foreign, and is idempotent. `doctor` carries
the reachable half of the detection: while OcuClaw is installed it warns that
generic removal would orphan the named runtime.

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
means package `0.21.0` and a complete clean checkout at the certified
`v2026.8.31` commit; `drifted` means a complete inspectable checkout differs;
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
| `presence.snapshot` | none | `{relayListening, authenticatedAppCount, clientVersions[], lastTransitionAt, device:{connected,batteryPercent,charging,inCase,observedAt}}` — the narrow public-safe projection, built by the relay supervisor. Device facts come from the freshest authenticated app readiness snapshot; `charging` is explicit SDK truth or null. Wear, Ring1, client identity, and raw readiness never cross this seam. Debug clients never count. |

The app republishes readiness after every authoritative 20-second device read,
even when the values are unchanged, so `device.observedAt` remains real
freshness evidence at 100% battery or another steady state. The relay updates
that observation timestamp but sends `presence.dirty` only when connected,
battery, or positive in-case truth changes. The parent's existing 30-second
fallback pull therefore advances the receipt without adding a push/write storm.

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
(schema v2, atomic, platform-hardened, exact-profile). On pull failure it writes a fresh receipt
with **null** app facts and an allowlisted `observationErrorCode`
(`pull_timeout | pull_failed | pull_unsupported | link_down | shutdown`); it
never refreshes old client truth, because the snapshot's freshness rules would
then read a stale count as a current fact. Clean shutdown writes
`relayListening:false, authenticatedAppCount:0`, clears every device fact, and
sets `observationErrorCode:"shutdown"`.

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
| `glassesUiLive` | `adapter.py` | `config.yaml` `extra.glassesUiLive` | Optional, code-defaulted | yaml > code default | `{}` merges with `httpEnabled:true`, `llmEnabled:true`, `httpHostPolicy:"owner-grants"`, and `tickModel:""` (Hermes `ctx.llm` selects the model). Shared/hosted operators set `httpHostPolicy:"operator-only"` to revoke phone host grants. |
| `renderGlassesUiTimeoutMs` | `adapter.py` | `config.yaml` `extra.renderGlassesUiTimeoutMs` | Optional | yaml > unset | Positive render-tool timeout override; unset/non-positive delegates to the child default. |
| `externalDebugToolsEnabled` | `adapter.py` | `config.yaml` `extra.externalDebugToolsEnabled` | Optional, code-defaulted | yaml > code default | `true`; admit relay-token-authenticated debug clients and permit Debug Report assembly/local save. This is the access gate, not the app-side live-capture switch. |
| `debugAutoArm` | `adapter.py` | `config.yaml` `extra.debugAutoArm` | Optional, code-defaulted | yaml > code default | `false`; normal phone capture stays local and folds on Submit. Developer hosts may set `true` to auto-arm the full app + relay preset; live tools can lease specific categories either way. |
| `allowDebugUpload` | `adapter.py` | `config.yaml` `extra.allowDebugUpload` | Optional, code-defaulted | yaml > code default | `true`; allow user-initiated support-bundle handoff. |
| `debugUploadMaxZipBytes` | `adapter.py` | `config.yaml` `extra.debugUploadMaxZipBytes` | Optional, code-defaulted | yaml > code default | `4000000`; clamped to 100000–4300000 bytes. |
| `debugUploadCapturePreset` | `adapter.py` | `config.yaml` `extra.debugUploadCapturePreset` | Optional | yaml > unset | Category-list override for the support capture preset. |
| `debugBundleSaveDir` | `adapter.py` | `config.yaml` `extra.debugBundleSaveDir` | Optional | yaml > unset | Host directory override for locally saved support bundles. |
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
| `emoji` | `models_rpc.py` | `config.yaml` `extra.emoji`, in **that profile's own** home | Optional | yaml > unset | The agent avatar glyph for this profile, forwarded as `gw.profiles.list[].emoji` and on to the phone's agent entry. Hermes has no emoji or avatar field; OcuClaw owns the value. Unset/blank/non-string → key absent, and the phone falls back to the first letter of the agent name (same fallback an emoji-less OpenClaw agent gets). |

#### `extra.emoji` is read per served profile

Every other key in the table is a gateway-process setting read once from the
owning home. `emoji` is not: in multiplex one gateway serves several profiles,
and each row of `gw.profiles.list` takes its emoji from **its own**
`config.yaml`. `load_config()` resolves the ACTIVE profile's home, so the
read goes through `read_user_config_raw(<that profile>/config.yaml)` — the
same multi-profile probe hermes uses for its own model/provider display read.
A named profile therefore never inherits the default profile's emoji.

Set it under the profile you mean:

```bash
hermes config set platforms.ocuclaw.extra.emoji "🜂"            # default profile
hermes -p coder config set platforms.ocuclaw.extra.emoji "🦊"   # the coder profile
```

The value reaches the phone on the next catalog refresh (reconnect). The
bridge carries it as the agent row's `identity.emoji`, which is where the
catalog normalizer reads an OpenClaw agent's emoji from, so both backends
land in one `RelayAgentEntry.emoji` and one avatar code path.

### LiveUI host grants

The authenticated phone uses the same downstream relay protocol on both hosts:

| Type | Direction | Fields |
|---|---|---|
| `ocuclaw.liveui.grants.get` | phone → runtime | `type` |
| `ocuclaw.liveui.grants.snapshot` | runtime → phone | `type`, `httpHostPolicy`, `digest`, optional `grantsInvalid`, `pending[{host,method,hasHeaders,hasBody,punycode,unicodeHost,requestedAt}]`, `granted[{host,grantedAt}]`, `denied[{host,deniedAt}]` |
| `ocuclaw.liveui.grants.set` | phone → runtime | `type`, `action` (`allow` / `deny` / `remove`), `host`, `baseDigest` |
| `ocuclaw.liveui.grants.ack` | runtime → phone | `type`, `status`, `action`, `host`, optional rejected `code`, optional accepted `clearedSessionKeys` |

An accepted set is followed by a fresh snapshot. Deny and remove also clear
every affected glasses session named by `clearedSessionKeys`. Under
`operator-only`, get returns an empty operator-only snapshot and every set is
rejected with `grants_policy_operator_only`.

The existing `ocuclaw.liveui.status` snapshot also carries
`httpHostPolicy`, `ownerGrants`, `tickAuth` (`ok`, `missing_key`, or
`no_backend`), and optional `grantsInvalid`.

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

### Learned-skill proposal decisions

`skills.pending`, `skills.review`, `skills.decide`, and `skills.receipt` use the
authenticated `hermes.management` connection with explicit `profile` scope.
The `skills` request object uses the same proposal/operation IDs and proposal/
target revision fields as memory decisions. Pending, review and receipt are
safe reads; decide must never enter a reconnect outbox.

The capability requires the exact installed `skill-decisions-v1` package and its
config/memory dependencies. Review includes complete operations and current
files, labelled `previewKind: complete_operations`; it makes no exact-diff claim.
All text is literal and binary content is complete base64. Oversized evidence
is refused as `review_too_large`, never silently shortened.

A decision receipt separates per-operation execution from final file state and
includes per-skill rollback outcomes. `partial` consumes the original proposal
without replaying applied work. `uncertain` preserves the original operation ID
and blocks supported native writers, including other profiles sharing a root.
Native `/skills recover` reconciles or explicitly acknowledges current files;
the phone only looks up the original receipt. Current native cache/context
refresh behavior is preserved.

### Profile health, usage and diagnostics

All five operations use profile scope and the existing authenticated management
envelope with a `health` payload. Authority is the boot-frozen profile home.
Native capability requires exact reviewed `hermes_state.py`, `doctor.py` and
`security_audit.py` bytes from the pinned engine source. Probe is read-only;
loading the adapter installs nothing and starts no diagnostic.

| Operation | Payload | Apply timing |
|---|---|---|
| `health.snapshot` | `{}` | read_only |
| `health.usage` | `{periodDays:7|30|90}` | read_only |
| `diagnostics.status` | `{operationId}` | read_only |
| `diagnostics.start` | `{operationId,kind:doctor|security,producedAt,expiresAt}` | active_now |
| `diagnostics.cancel` | `{operationId,producedAt,expiresAt}` | active_now |

Mutations have a maximum 15-second admission window and best-effort delivery.
The browser stores the selected gateway/profile operation identity before send.
Disconnect, timeout, reload and capability loss never replay a start. Status
queries are read-only. An absent receipt can be explicitly cancelled to create
a durable tombstone before another deliberate diagnostic. An earlier gateway's
unfinished diagnostic remains Unknown; cancellation cannot claim that an
unowned process was stopped. The phone can explicitly acknowledge uncertainty.

`health.snapshot` records source and observation time. Executing this handler
proves gateway response only. Disk free space is a measured profile-filesystem
fact; job failures come from the existing native execution ledger for seven
days. Missing ledgers, provider probes and provider error counts are Unknown.
No new usage/error store is maintained.

`health.usage` uses native read-only SessionDB accounting in one read
transaction. The native dashboard window is session start time, not API-event
time or a billing period. Totals include session counters plus only nonempty
auxiliary task rows, avoiding duplicated primary ledger counters. The response
includes per-model totals and record coverage; `estimated` and `actual` are
separate nullable amounts. Unknown auxiliary schema/read coverage is explicit.
The model list caps at 100 while aggregate totals include every model.

Diagnostics execute the real native doctor or security audit in a separate
process group with a 90-second parent and independent child-watchdog deadline.
The child watchdog survives gateway exit and kills remaining descendants.
Admission reserves a single gateway slot before the worker starts. The private
receipt directory holds at most 256 records, prunes records older than seven
days on admission, and is not a retry queue. Results cap at 64 curated findings;
native stdout, environment, paths, exception details and advisory summaries are
never forwarded. `doctor` uses `fix=False, ack=None`; native connectivity and
rolled-back SQLite probes are disclosed, with no repairs, updates or services.
Security uses native discovery and OSV queries, rejects malformed/short batch
results, and retains unknown severity when advisory detail retrieval fails.
Its coverage is discovered pinned dependencies only: unreadable metadata and
unpinned dependencies can be excluded, so zero findings is never security
clearance. Terminal states distinguish complete native reports, partial audit
coverage, native failure, permission denial, timeout, cancellation and Unknown.

### Saved learning corrections

`saved.list`, `saved.read`, `saved.preview`, and `saved.receipt` are explicit
profile-scoped reads on the existing authenticated management connection.
`saved.mutate` and `saved.recover` expire immediately in the reconnect outbox
and require a current phone confirmation. The original operation ID is stored
before admission and retained across connection/profile changes.
Both mutation requests carry numeric `producedAtMs` and `expiresAtMs` (phone:
20 seconds; native maximum: 30 seconds). Native code rechecks expiry after all
shared admission locks and immediately before the first receipt write. Delayed
expired requests leave target and receipt files unchanged. Read-only receipt
lookup has no intent timestamp; explicit native CLI recovery remains local
operator work.

The `saved-native-v1` capability requires the exact installed config, memory,
and skill compatibility chain, current loaded saved barriers, exact memory
selection, scoped native skill resolution, and locked archive/restore functions.
Memory identities include the profile, complete raw target/config revision,
native canonical index and exact entry text. Skill identities include the
canonical root/path and complete tree/config revision. Native scanners, capacity,
pin/origin, containment, synchronization and removal rules remain authoritative.

Lists carry labelled `contentPreview` and actual `contentLength`; no entry-count
cap silently drops records. Selected reads and previews include complete content
and supporting files, including base64 for binary files. The 512 KiB wire limit
returns `review_too_large` explicitly. Native duplicate memory normalization is
shown in the complete before/after target. Native foreground skill removal is
permanent and the phone confirms it as such.

Receipt reads never cancel or finalize an operation. Explicit confirmed recovery
can durably cancel an original ID before admission or reconcile a completed or
unchanged outcome, without replay. An unknown changed outcome remains blocked
for native review. Native operators can inspect and reconcile it in the selected
profile with `python -m tools.saved_learning receipt OPERATION_ID` and
`python -m tools.saved_learning recover OPERATION_ID`. After inspecting the
returned complete current state, `recover --acknowledge-revision REVISION`
preserves those exact bytes and resolves the original operation without retry.

Saved receipts use their own durable namespace and shared-root markers.
Uncertain saved changes also block supported native memory, pending-decision,
skill, archive and restore writers. New marker identities include the namespace,
so an ID reused by another operation family cannot clear its uncertainty barrier.
Corrections are guaranteed for new native chats; existing conversations retain
their prompt context. Configured external memory-provider stores are explicitly
unsupported by these built-in-memory controls.

### Learning behaviour

`learning.read`, `learning.update`, `learning.receipt`, and `learning.recover`
operate on the explicitly selected profile. The capability requires the native
config transaction package, supported native background-review implementation,
and verified native editor assets. Updates preserve unrelated leaves and use
per-field revisions. Review model is one atomic provider/model/endpoint/credential
group; choosing a catalog model or inheritance explicitly clears review-only
endpoint and credential overrides after confirmation.

Updates and recovery require `confirmed: true`, an operation ID, and integer
`producedAtMs`/`expiresAtMs` bounds (positive lifetime at most 30 seconds, at most
five seconds future skew, nonnegative production time). The native transaction rechecks expiration after
lock acquisition and before receipt or journal writes. Receipt reads never
replay a mutation. Explicit recovery reconciles admitted work or durably cancels
an unadmitted operation. The phone persists only the operation ID and field names;
matching terminal receipts are required before clearing uncertainty.

Memory/skill gates are independent and leave pending proposals untouched. Review
enablement/model and notification changes describe future agent/review instances;
the RPC does not observe or claim to change current work. Notification detail does
not disable learning. Model availability uses the native cached catalog and
runtime resolver, with unavailable/fallback state exposed explicitly.

Native configuration and managed policy are captured under a short transaction;
provider resolution runs outside that lock with both selected-profile home and
secret contexts retained. A full configuration/policy fingerprint is rechecked
after resolution. A read that encounters drift returns fresh field values with
`futureRoute: {state: "unknown", model: null}`. An update rejects drift before
admission and rechecks its deadline after reacquiring the lock.

Mutation readback, receipt reads, and recovery never resolve provider eligibility;
they report the same explicit unknown route while retaining current saved values
and durable receipt outcomes. Refresh can check the future route separately.
A failure after mutation admission returns `outcome_unknown`, preserving the
phone's original pending operation identity for receipt reconciliation.

### Multiplex operational rules

- OcuClaw is a port-binding platform. Configure it only on the default
  profile: that single adapter owns the Node child and `:47801`, then serves
  all accepted profile lanes. If Hermes constructs it under a secondary
  profile home override, the adapter raises before spawning the child; the
  gateway logs and skips that secondary adapter.
