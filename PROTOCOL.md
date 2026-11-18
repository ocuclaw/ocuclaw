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
  than read from the parent. Besides the platform basics, the list carries only
  non-secret OcuClaw switches the child reads: the two tool-schema flags and
  `OCUCLAW_PAIR_URL` (phone-code pairing; unset means `https://pair.ocuclaw.com`,
  `off` turns it off). No secret is on the list and none may be added:
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
failure (`EADDRINUSE` once the relay boots in-child; spec §Bundles). A
listening holder fails at once. A holder with nothing listening (an outbound
connection using the port as its ephemeral port) first gets 5 logged retries
over about 21 s. Either way the failure line names the holder, and Hermes's
reconnect ladder is the outer retry (#3749).

## Frames

Every frame carries `v` (protocol version) and `type`:

- `link.hello` (child → parent, first frame on boot):
  `{v, type, payload: {pid, runtimeName: "ocuclaw-runtime", liveui?, phoneTools?}}`
  where `liveui.tools[]` advertises the LiveUI tool descriptors
  (`get_glasses_ui_state`, `manage_liveui_templates`, `manage_liveui_tasks`,
  `compose_glasses_ui`) single-sourced from the TypeScript tool schemas, and
  `phoneTools[]` is the
  data-driven phone-tool descriptor list (see **Phone tools lane** below). Both
  keys are optional in both directions: a hello without `phoneTools` boots
  exactly as it did before #2800.
- `link.hello.ack` (parent → child, completes the handshake):
  `{v, type, payload: {hermesVersion, platform: "ocuclaw", config: {wsPort,
  wsBind, …}}}` — the config object is the adapter's resolved settings; the
  child ignores unknown keys.
- `link.rpc.request` (either direction): `{v, type, id, method, params?}`
- `link.rpc.response`: `{v, type, id, ok: true, result}` or
  `{v, type, id, ok: false, error: {code, message, errorCode?}}`. `errorCode`
  is additive and optional: the stable string a handler's refusal carries (its
  exception's `error_code`, e.g. `gw.profiles.create`'s), never set on a
  private response; a peer that does not know it ignores it. Unknown methods are
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
mutations borrowing the native shared writer for the explicit resolved
served-profile path). Node side:
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
| `db.chat.history` | `{identity, limit?}` | `{messages:[{id, role, content, timestamp?, platform_message_id?}], sessionId, total}` — conversational rows ONLY (user/assistant with content) across the compression lineage; the public `SessionDB.get_messages_as_conversation(tip, include_ancestors=True)` projection remains authoritative for filtering/content, then a serialized private-connection read enriches rows with stable `messages.id` metadata; unavailable/divergent identity metadata logs a warning and degrades that session to derived ids. Rows are tail-sliced server-side to `limit` AND to a byte budget under the frame cap (`HISTORY_BYTE_BUDGET`, 1 MiB minus 64 KiB for the envelope; newest rows kept, contiguous; a newest row that alone exceeds it yields no rows, never clipped content), so a page of large rows never trips the 1 MiB frame cap (#7327); content is scalar-or-block-list; the Node bridge re-shapes defensively over the same pinned shape. `total` is the **pre-slice** conversational row count, so `total > messages.length` is the only honest signal that the head was cut, whether by `limit` or by the byte budget (the bridge forwards it and the relay renders one `— earlier messages not loaded —` notice). Deliberately no `offset`: no load-earlier affordance exists in composeApp or the plugin, and the slice stays tail-anchored |
| `db.sessions.describe` | `{identity}` | `{model, tokens:{input,output,cacheRead,cacheWrite,reasoning}, lastMessageTokenCount?, messageCount, costUsd, contextWindow?}` — `lastMessageTokenCount` is the public persisted `SessionStore.lookup_by_session_id(...).last_prompt_tokens` current-context count; omitted when that sanctioned read is unavailable (the child marks occupancy unknown and never substitutes cumulative billed totals; a session with `messageCount: 0` and a known window reads as occupancy 0). `contextWindow` is the window Hermes enforces for the session's model when the owning profile's `config.yaml` pins it — `model.context_length`, else a `custom_providers`/`providers` per-model `context_length` for the configured `base_url` (via `hermes_cli.config.get_custom_provider_context_length` when present) — applied only when the session runs on the profile's main model (or has no model yet). Config-only, never a network probe; omitted when unresolved, and the child then falls back to the `models.list` catalog window and its per-model cache. `costUsd = COALESCE(actual_cost_usd, estimated_cost_usd)` (upstream's own reaping filter uses the same coalesce, `hermes_state.py:8171`), `null` when neither column is present or populated. `lastMessageTokenCountEstimated: true` (else omitted) marks a stand-in: a manual `/compress` and gateway hygiene set `last_prompt_tokens` to 0 until the next turn, so while it is 0, the session has messages, and the newest compaction on the chain noted this same `messageCount`, `lastMessageTokenCount` is that compaction's `afterTokens` (Hermes' own estimate) |
| `db.sessions.compactionInfo` | `{identity}` | `{hops, compactions?, exact?, live?, last?}` — `hops` is the compression-chain hop count. Without the `post_compaction` hook (below 0.22.3) the reply is `{hops}` alone, and in-place compactions are invisible: a documented undercount. With it (see "Compaction counts (`sessionCompacted`)"), `compactions = hops +` the in-place full compactions (`summarize`, `provider_native`) the ledger counted on every chain id; `exact` is true only when every chain segment started after the ledger's `trackingSince`, else the figure is a floor; `live: true` says the count rises when the next compaction lands; `last` is the newest event on the chain, `{kind, reason, inPlace, beforeTokens, afterTokens, atMs, messageCount}`, or `null`. The child maps an exact count to metric `compactions` and a floor to `hops` |
| `db.chat.watermark` | `{identity}` | `{sessionId, watermark, dbPath, hermesHome, inflight:{active, platform}}` — Desktop→glasses mirror (#2513). `watermark` is `MAX(messages.id)` over the lane's LIVE transcript (the compression tip), `null` when empty; read on its own `mode=ro` connection (no write lock) — NOT `latest_message_row_id`, which is role/text-filtered and sits still on a tool-call-only tail. `inflight` is the tier-0 verdict for that tip (the adapter wraps the bare session_rpc handler to add it). `db.chat.history` accepts `afterId` (rows with `id > afterId`, applied BEFORE `limit`) and answers `rowIdsUnavailable:true` with no rows when the host's projection carries no row ids. Add-only since #7379: with `afterId`, an optional `order:"oldest"` returns the OLDEST rows past `afterId` (ascending, the first `limit`, then the oldest contiguous rows within `HISTORY_BYTE_BUDGET`) and adds `nextAfterId` while rows remain: the `afterId` for the next page (the last returned row's id, or the id of an oldest row that alone exceeds the budget, which is stepped past). Without `order` (or without `afterId`) the reply is the tail-anchored slice above with no `nextAfterId`; a bundle that predates `order` ignores it, so a caller treats a reply without `nextAfterId` as the last page. Both are read once per debounced WAL event, never on a timer |

**Database ownership and compatibility (#2743).** `session_writer.py` uses
`hermes_state_registry.acquire(path)` / `release(writer)`, verified on Hermes
0.21.2 (`939e45c91d751fadd94dcd1b873ac3cb44846213`). Rename, read state,
hide, predecessor hiding, copy and deletion all use that common accessor.
An operation holds one reference; exceptions release it, shutdown never
closes another holder, and the next borrow follows the registry's current
generation after file replacement. The adapter serializes reader use and
closes its own reader after active RPCs finish, on profile-path replacement
and on disconnect. It never calls the registry's process-wide close sweep.

The supported version floor is now 0.21.1 (#3147). The 0.21.0 engine
(`29112bef099274229cadff79cdff7bf7b99c4b77`, the previous certified pin) has
no safe public registry; it sits below the floor and the adapter refuses to
start there. The `session_writer_unsupported` branch stays as defence in depth
for a host without the registry, while reads remain available. Hermes 0.21.1 (`2237be355906fbe6065ce1815711eee52b2d646e`),
0.21.3 (`345cd2b057a452236de401d3534b8502a7465e8d`), 0.21.5 (`f97608f178d1ffeca59860195ab7da295f7c8e5f`), 0.22.1 (`297552a9d646119871391d202509822cd86330df`), 0.22.4 (`4d04303818b61bf3aa09278af48356315515965b`) 0.22.5 (`bf0203a794a07aac3ff764972ab9087baa4e4f4e`) 0.23.0 (`2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`) 0.23.1 (`3b421578588243f920886e6fe79a6faa87ea026e`) and the certified 0.23.2 engine (`ae2a81ccc00e9b7c06301523e5bb09608397149c`) ship
`hermes_state_registry`, so the same mutations run through the registry there. There is no standalone-writer or ambient `SessionStore._db`
fallback. Missing/unserved stores report `session_store_unavailable` /
`session_profile_unserved`; read probes report `session_schema_unsupported`
without bootstrapping, migration, repair or checkpoint. SQLite contention
reports `session_storage_busy`; uncertain mutation completion reports
`session_mutation_unknown`, with no automatic action replay.

**Session-plane boundaries (#2744).** Key enumeration and watermark queries
borrow public read-only SessionDB methods. Helper-only readers close on exit;
an RPC pins one file generation across nested reads and refuses replacement
with `session_store_changed`. The next independent RPC may reopen the new
generation. Carrier/ID discovery and compression ancestry are bounded; reaching
the bound reports `discovery_truncated`, never a partial selected lineage.

Copy creates its row and all messages in one owner transaction. Its native
branch marker keeps the copy independent when the source later compresses.
Deletion validates the selected rows and compression edges inside the same
transaction as native delegate cascading, branch orphaning, message deletion,
system-prompt cleanup and orphan-key delivery-obligation cleanup. A changed
selection reports `session_selection_changed`; a changed copy source reports
`session_copy_source_changed`. Neither action automatically replays.

The compatibility gaps stay inside `session_writer.py`: public import strips
gateway keys and public bulk delete has no expected-lineage guard. Copy uses
the owner's `_validate_import_payload`, `_import_session_row` and
`_execute_write`; deletion uses the native `_delete_delegate_children`,
`_delete_unreferenced_system_prompts` and `_remove_session_files` helpers.
Missing primitives report `session_writer_unsupported` before mutation. No
second writable connection, nested transaction or replacement native database
implementation is introduced. These private seams are verified against the
0.21.2 source above and remain explicit compatibility obligations.

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

**Copy-only interim (2026-09-13).** The shipping path is **Copy as new glasses
chat**. The new glasses chat starts with the source transcript. Future replies
stay separate.
Every copy has a fresh native ID and glasses key. `_branched_from` records
provenance, but `parent_session_id` is null so native resume cannot follow the
source into its copy. Creating the copy does not end or re-key the source.
It uses the existing shared native writer compatibility adapter; engines
without its required transaction primitives fail closed.

New adoption is not advertised. The registered `foreign.sessions.adopt` door
rejects with `shared_handoff_unavailable`, including requests with `takeOver`.
`ocuclaw.session.driver.takeover` also refuses, preserving the current lock.
The phone sheet and composer offer no Take over, and the Desktop status card
has no editable Open chat action. Device, connection and ownership status
remain available. Existing adopted chats retain their driver observation and
mirror; disabling new handoff must not silently unlock them. The host's
legacy `adoptSupported` grant now controls those protections only, not the
shipping `foreignSessions.adopt` capability.

The adoption and takeover mechanics documented below describe dormant legacy
implementation, not available shipping actions. Re-enabling them requires
native context-refresh and cooperative ownership-release evidence.

**Shared chats (Hermes 0.23+, on by default).** Hermes 0.23 runs
every conversation in one gateway: Desktop, the TUI and `hermes chat` attach
as viewers (`session.create` / `session.resume` / `prompt.submit`), share one
event stream, and take no lease or turn marker. A chat continued on the
glasses is then one conversation with one queue, so nothing needs to release
ownership. Unless `platforms.ocuclaw.extra.sharedChats` turns it off (`false`,
or the string `"false"`), AND with `ocuclaw-wearer` in `allow_admin_from` AND Hermes ≥ 0.23.0
(`health.shared_chats_enabled`, read per call), the registered
`foreign.sessions.adopt` door (`handle_foreign_adopt_gate`) runs the Continue
here mechanics below instead of refusing, with three differences: the
gateway's own LOCAL route rows (`session_key = agent:<ns>:local:dm:<id>`,
source `local` or `desktop|cli|tui`; public key
`hermes:<ns>:x:local:dm:<id>`) are adoptable beside external roots, the
`desktop_busy` hold check is skipped, and `foreign.sessions.driver` answers
`glasses_drive` with `shared: true` without reading Hermes's hold files.
`gw.profiles.list` carries `sharedChats`; the bridge lifts it into
`agentCatalogSnapshot.sharedChats`, and the runtime then advertises
`foreignSessions.adopt=true`, `sharedChats=true` and `driverLock=false`,
`desktopMirror=false` (desk turns reach the lane natively). The app offers
Continue here only when it sees `sharedChats`, so an older plugin's adopt
grant stays copy-only. Telegram/Discord/… rows stay read-only either way.

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
| `foreign.sessions.adopt` | `{identity, publicKey, takeOver?}` | `{status:"accepted", sessionId, session, adoptKey, chatId, adoptedFrom, predecessors:[{id,endReason,messageCount}], hiddenPredecessors, cleanupStatus?, cleanupError?}` or `{status:"rejected", error, verdict, tip?, holdState?, detail?}` — `error` == `verdict` |
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

Take-over is ephemeral and scoped to the exact lane, profile home, lineage,
and native holder generation (`hold.generation`, verified from lease identity
and process birth time). Renewed Desktop work or foreign in-flight execution
revokes it immediately; unchanged verified idle holders may retain it.
Missing generation refuses Take-over. `foreign.sessions.driver` and the
driver event add `uncertain`: failed/missing registry or marker reads preserve
the controller's last admission, cannot grant Take-over, and keep its existing
bounded liveness observer running until fresh evidence recovers. A new
controller with no observation starts locked. Confirmed dead holders still
release even with an old turn marker. Disarm and restart discard all grants.
The driver requires the public registry snapshot's strict liveness mode;
engines without it report uncertain without invoking the lenient reader.
Malformed marker structures also report uncertain, including valid JSON
whose root or entries have the wrong shape.

**Desktop→glasses live mirror (#2513).** Turns typed in Hermes Desktop on an
adopted chat reach the glasses about a second after they land, as finished
rows tagged "Desktop" (no token streaming — that needs upstream #86784).
Node (`session-mirror-watch.ts`) rides the driver lock's arm/disarm lifecycle:
armed only while the current session is an adopted lane, ONE `fs.watch` on
the DIRECTORY holding `state.db` filtered to `state.db-wal` (and `state.db`
itself where WAL is refused — rollback journals write the main file; `-shm`
is ignored because every READ moves it), 150 ms debounce → `db.chat.watermark`
→ if `MAX(id)` moved, `db.chat.history {afterId, order:"oldest"}` (one page
of 50, repeated while the reply names `nextAfterId`, at most 20 pages per
read before a coalesced re-read, #7379) → the rows land through the
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

Before dispatching `/resume`, adoption checks the same routed profile's native
shared writer and public `set_session_hidden` primitive. Missing support rejects
with `error == verdict == "session_writer_unsupported"` before native resume or
any adoption mutation. No fallback writer is opened. Other preflight failures
are bounded to `session_store_unavailable`, `session_storage_busy`, or
`session_mutation_unknown`; the configured engine version floor is unchanged.

Once the DB confirms adoption, predecessor hiding is presentation cleanup.
A late cleanup failure retains `status:"accepted"` and the adopted identity,
with `cleanupStatus:"pending"` and bounded `cleanupError` (`session_writer_unsupported`,
`session_store_unavailable`, `session_storage_busy`, or `session_mutation_unknown`).
`hiddenPredecessors` lists only confirmed successful hide calls; pending cleanup
may already have hidden some rows. Neither the adapter nor callers automatically
retry adoption or cleanup. Continue using the accepted identity; pending cleanup
does not mean native resume failed. These optional cleanup fields are absent
when all predecessor hiding completes successfully.

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
| `gw.models.list` | `{ns?}` | `{models:[{provider, id, name, contextWindow, reasoning}]}` — Hermes `list_authenticated_providers` catalogs (including Nous/Codex), enriched with optional `get_model_info` metadata, then missing enabled explicit configured provider/model pairs from primary, fallback and channel overrides. Older engines fall back to `CANONICAL_PROVIDERS` × `list_provider_models`. One config snapshot supplies references and provider filtering. Deduplication is by provider + ID; real metadata wins, seeded rows use ID as name and omit unknown context/capabilities. Optional metadata imports may be unavailable without losing configured pairs. Discovery uses the configuration/authentication of the profile `ns` names (see "Profile-scoped reads" below) and cache-only/non-blocking catalogs where supported; custom endpoint probes are disabled. The app retains configured choices first and then available account models. |
| `gw.models.configured` | `{ns?}` | `{default:{id, provider?}\|null, fallbacks:[{id, provider?}], channelOverrides:[{id, provider?}]}` — from the `ns` profile's config `model`(`.default`/`.provider`), the `fallback_providers` chain (`get_fallback_chain` — hermes has NO `model.fallbacks` key), and `platforms.ocuclaw.channel_overrides`, excluding explicitly disabled providers using the same config snapshot. The bridge reprojects into `config.agents.defaults.{model,models}`; fallbacks survive a missing/disabled primary. Hermes catalog projection excludes the implicit OpenClaw default when no primary exists; the shared mapper and existing unqualified-reference interpretation remain unchanged. Hermes has no imageModel/alias config so `imageModel` is OMITTED and `models` is `{}`. |
| `gw.usage.status` | `{ns?}` | `{updatedAt, providers:[{provider, displayName, windows:[{label, usedPercent, resetAt?}], unavailableReason?}]}` — `fetch_account_usage` per candidate provider of the `ns` profile (candidates = configured-default ∪ pool-credentialed, ∩ the 3 routable providers anthropic/openai-codex/openrouter, plus the configured-default provider itself, so a provider plugin can report usage and any other provider still gets an honest `unavailableReason` row). Only finite `usedPercent` windows cross the wire; absent percentages become an honest `unavailableReason`, never `0% used`. `resetAt` is unix seconds, omitted when Hermes has none; labels are Hermes-native prose, with one truth-preserving Codex correction: Hermes currently calls `primary_window` "Session" even when its reset is more than five hours away and therefore can only be the weekly allowance, so that proven case crosses as `Weekly`. The BRIDGE aligns labels to the `normalizeWindowKey` patterns (`(Current )session` → `5h`, `(Current )week(ly)` → `week`, others verbatim → slug keys) |
| *Profile-scoped reads* | | `gw.models.list`, `gw.models.configured` and `gw.usage.status` take an optional `ns`: the OcuClaw session namespace of the active session. The bridge derives it from the `sessionKey` the relay passes (only on Hermes); the relay keys its catalog and usage caches by it. A served multiplexed profile's read runs under `set_hermes_home_override(<served home>)`, so config, credential pool and account usage are that profile's. No `ns`, `main`, an unserved namespace, or a Hermes without the override reads the gateway's own home, as before. |
| `gw.auth.status` | `{}` | `{providers:[{provider, profiles:[{type}]}]}` — from the persisted credential pool (`read_credential_pool`); credential-level `auth_type` maps `oauth`→`"oauth"`, `api_key`→`"token"` (pooled api-key entries ARE rotation members — the consumed semantic is pool size, and OcuClaw counts only oauth\|token); providers with zero pool entries are omitted |
| `gw.agent.identity` | `{ns}` | `{agentId, name, emoji?, avatar?, appearance?}` — `agentId` = PROFILE name (`ns` `main` ⇄ profile `default` mapping happens HERE, the single crossing point); `name` parsed from the profile's SOUL.md first line (`You are <name>, …` heuristic, bounded) else the profile name (default lane: "Hermes"). An explicit OcuClaw emoji overrides the native profile raster described below. |
| `gw.profiles.list` | `{}` | `{profiles:[{name, isDefault, displayName?, model?, provider?, description?, emoji?, avatar?, appearance?}], defaultProfile:"default", createSupported, settingsSupported:true}` — `profiles.list_profiles()` verbatim (`name` stays the routing key; optional `displayName` is presentation only; ProfileInfo carries model/provider from the profile's own config.yaml). `emoji` is OcuClaw's own key, read per profile from `platforms.ocuclaw.extra.emoji` in THAT profile's config.yaml (see "Config keys" → `extra.emoji`) and omitted when unset. `createSupported` is true only when this adapter booted with multiplex routing enabled. Existing served profiles remain configurable without multiplex, so `settingsSupported` is independently true. `adoptSupported` (#2509) is true when `platforms.ocuclaw.extra.allow_admin_from` lists `ocuclaw-wearer` — the bridge lifts it into `agentCatalogSnapshot.foreignSessionAdopt`, which since the copy-only interim drives only the legacy driver lock and mirror. `sharedChats` is true when shared chats are on (`extra.sharedChats`, the admin grant and Hermes ≥ 0.23.0); the bridge lifts it into `agentCatalogSnapshot.sharedChats` → `families.sessions.foreignSessions.adopt` and `.sharedChats`. `autoRoute` (#6795) is true when the Auto agent host kill switch `extra.auto_agent` is not set off and the `ocuclaw_agent_router` auxiliary task registered; the bridge lifts it into `agentCatalogSnapshot.autoRoute` → `families.agents.autoRoute`. |
| `gw.agents.route` | `{text, requestId?, fallbackAgentRef?}` | `{status:"ok", agentRef, reason:"named"\|"router"\|"fallback"\|"single", latencyMs, requestId?}`, or `{status:"unavailable", error:"auto_agent_off"}` while the host kill switch is set off — Auto agent (#6795, add-only; older plugins answer method-not-found and the app never sends it without `families.agents.autoRoute`). Candidates are the served, enrolled profiles (`_routable_profiles`). One candidate answers `single` with no model call. A prompt whose first one to three words before a pause name exactly one candidate (id, display name or a `previous_names` entry, case-insensitive) answers `named`. Otherwise one tool-less call on the `ocuclaw_agent_router` auxiliary task (inherits `group_router`, 40 output tokens, 4 s budget; each candidate's id, display name and description cut to 280 characters, the prompt to 1,000) must answer exactly one candidate id; a timeout, an error, `none` or any other answer is `fallback` to `fallbackAgentRef` while it is still a candidate, else `default`. The log keeps the picked id, the reason and the latency, never the prompt. The relay's app message is `ocuclaw.agents.route {requestId, text, fallbackAgentRef?}` → `ocuclaw.agents.route.result {requestId, status:"ok"\|"error", agentRef?, reason?, latencyMs?, errorCode?, errorMessage?}`. |
| `gw.profiles.create` | `{name, requestId?, setup?}` | `{status:"created"|"partial", profile:{id,name}, restartRequired:true, errorMessage?}` — native fresh profile creation, bundled skill seeding, safe alias creation. `profile.id` is the normalized slug; `profile.name` is the name as typed (≤80), kept in the creation receipt as `displayName` and served back as `gw.profiles.list`'s `displayName` when native Hermes has none. Optional setup is described below. The served-profile set stays adapter-construction-frozen until native restart. Multiplex-off rejects plainly; validation/collision failures reject with `error.errorCode`: `invalid_name` (empty, or native validation fails), `reserved_agent_id` (`default`), `agent_already_exists` (the profile exists and this is not a replay of the request that made it; message `A profile named <name> already exists.`). |
| `gw.profiles.emoji.set` | `{profileId, emoji}` | `{status:"updated", profileId, emoji}` — writes only the selected routable profile's `platforms.ocuclaw.extra.emoji` key using Hermes's atomic config writer. `emoji:null` removes the key and restores native-avatar sync, with a first-letter fallback when no raster is available. This is never used for OpenClaw agents. |
| `gw.profiles.settings.get` | `{profileId}` | `{status:"loaded", backend:"hermes", agentId, name, emoji, setup:{instructions,model,provider,workspace,blockedTools}, terminalBackend?}` — reads only the named served profile's SOUL.md and config.yaml. `terminalBackend` is the profile's `terminal.backend` when set (omitted otherwise); the relay refuses LiveUI picture files when it is not `local`, because the agent's paths are then not this host's (LiveUI V2 A6). |
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

Overview may also carry `summary`, an optional object of per-section facts for
the phone's Hermes hub. The hub states each section's live state in one line and
the management lane refuses a second in-flight read, so these facts ride this one
read instead of five of their own. Fields, all optional:

| Field | Meaning | Source |
| --- | --- | --- |
| `approvalsMode` | `smart`, `manual` or `off` | the effective approval mode the Approvals page shows |
| `toolsets` | toolsets that are enabled **and usable** (`allowed_by_setting`) | the Tools & skills read; omitted when that host reported `not_checked`, which says nothing about usable |
| `skills` | installed skills left enabled | the Tools & skills read |
| `mcp` | configured MCP connections | the Connections read |
| `mcpNeedsAuth` | connections waiting to be signed in again | see below |
| `jobs` | scheduled jobs | the Jobs read; omitted when that read returned its 100-job cap, where the count is a floor. The read's own `truncated` flag is deliberately not the test: on the native reader it is the job-list cap, but the stock fallback also raises it when the execution history was capped at 50, which says nothing about how many jobs there are |
| `nextJobAtMs` | epoch ms of the soonest unpaused job's next run | derived from that job's ISO-8601 `nextRunAt`; omitted when it carries no offset, when the job list hit its cap (the soonest run may be off the end), and past runs are dropped before the soonest is chosen |
| `failedJobs7d` | failed job runs in the last seven days | the health snapshot's execution ledger |
| `reviewsOn` | Hermes asks before it writes what it learned | see below |
| `savedEntries` | saved learning entries | the Saved read |
| `diskFreeBytes` | free bytes where this profile lives | the health snapshot |

Every field is gated by the capability of the read that produces it and is
omitted when that read fails or reports nothing: an absent field means that row
has no second line, which is honest, where a zero would be a fact the wearer
acts on. `summary` itself is absent when no field survived. Only numbers, one
boolean and one enum cross; no name, path, command or job text is admitted. The
relay whitelists each field individually the way it whitelists `attentionCount`,
and the phone parses each one again, so a malformed field arrives as absent
rather than as a wrong fact.

The overview is the read the settings tab waits on, so the summary runs under a
wall-clock budget (1.5 s) with its readers ordered cheapest first: the health
snapshot, approvals, learning, jobs, connections, tools, then saved. Once the
budget is spent the remaining readers are not called and their fields are absent,
which is the same thing an unreadable field already means. The budget bounds when
a reader may **start**, not how long it may run: a reader already under way is
never interrupted, so one slow read can carry the summary past 1.5 s. Ordering
therefore decides which facts survive a slow host and is part of this contract.

`reviewsOn` reports the two **write-review gates** (Review memory writes, Review
skill writes): true when either is on, false only when both are off, absent when
the pair could not be read. It is not `auxiliary.background_review.enabled`.
The Learning row reads "Reviews on · N saved" beside the pending-proposals card,
and proposals exist because the write reviews are on; automatic background review
is a separate setting on the same page.

`mcpNeedsAuth` counts configured MCP connections that are set to `auth: oauth`,
that this phone could actually run an OAuth flow for (`oauthSupported`), and that
have no token file on disk — the same three things the adapter already weighs
before it reports `oauth_required` on a connection test. `oauthSupported` alone
is not the test: it is also true of a plain HTTP connection that uses no auth at
all, which is not waiting for anyone. **The count is a floor.** A token that is
present but expired reads as signed in until something tries to refresh it, and
the native token check answers "present" when it cannot tell, deliberately, so
that a doubtful read never blocks a working connection. The field is omitted
when the token check or the config read fails; `mcp` still reports in that case.

Gateway restart uses the same envelope and authenticated connection:

| Operation | Payload | Result |
| --- | --- | --- |
| `restart.preview` | absent or `{}` | `restart:{gatewayId,bootId,scopeRevision,affectedProfiles,activeWork,waitSeconds,drainSeconds,phase,supported}` |
| `restart.request` | `{operationId,gatewayId,bootId,scopeRevision}` | Same snapshot plus a bounded restart receipt; one native admission at most. |
| `restart.status` | `{operationId,gatewayId}` | Read-only receipt reconciliation against the current native process. |

Each operation has its own capability record, at `scope:gateway`, present in every
general `capabilities` and `overview` result. Timing is `read_only` for
`restart.preview` and `restart.status`, `active_now` for `restart.request`. The three
share one `supported` value: a client that cannot request a restart is not offered a
preview of one either. It is false unless the gateway is running and something
brings it back after it exits: a supervisor (systemd, launchd, s6 or an explicit
external supervisor), or, since #3357 (Matty, 2026-09-23), a Cloudways Managed AI
Agents container. On Cloudways the gateway is `hermes gateway run --no-supervise`,
a direct child of PID 1 `/entrypoint.sh`; support there needs the decisive
Cloudways verdict (never `likely`), PID 1 being the entrypoint, and the gateway
being its direct child. A gateway that cannot restart itself, and one still
starting up, both advertise unsupported rather than inviting a call that could only
fail.

The restart itself is the same everywhere: the durable receipt and fence first,
then Hermes's own `request_restart`, which refuses new turns, waits for active work
and stops. Only the exit differs. Under a supervisor it exits 75 so the supervisor
relaunches it. On Cloudways it exits 0 with no detached helper: PID 1 ends with it
and Cloudways restarts the whole container. SSH sessions drop, and the phone
reconnects on its own in 1 to 5 minutes. `supported:true` is an
invitation, never an admission: `restart.request` is still gated natively on the
restart snapshot, so a client that ignores the record gains nothing.

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

##### Asks other agents (#6797)

Three operations, added on Hermes 0.22.5+ where OcuClaw registers its
`ocuclaw-agents` delegation backend (`delegation_handoffs.py`). Their capability
rows report `supported:false` on an older host, which the phone takes as "hide
the setting". `handoffs.restore` only narrows: it is answered even where the
backend is not registered, though its row follows the same flag.

| Operation | Scope | Payload `handoffs` | Result `handoffs` |
|---|---|---|---|
| `handoffs.read` | profile | `{}` | `{available, enabled, backend, replaces, agents:[{id, name, description?, allowed}], applyTiming:"new_chat"}` |
| `handoffs.set` | profile | `{enabled, agents:[id], confirmReplace?}` | the same view after the write |
| `handoffs.restore` | gateway (`profileId:"default"`) | `{profiles:[id]}` | `{restored:[id], applyTiming:"new_chat"}` |

`agents` in a read lists every served, enrolled agent other than the selected one;
`allowed` marks the ones it may ask. `backend` is the selected agent's current
`delegation.backend` (`default` when unset). `replaces` names the backend that
turning the switch on would replace (or did replace), when it is not `default`.

`handoffs.set {enabled:true}` writes, in that agent's own `config.yaml`,
`delegation.backend: ocuclaw-agents`, `delegation.backends.ocuclaw-agents.agents`
(each `{name, description?}`, descriptions copied from `profile.yaml` so the
`delegate_task` schema is the same bytes for the same config) and
`delegation.backends.ocuclaw-agents.previous` (the backend it replaced). Every
listed agent must be served and enrolled now (`agent_not_enrolled` otherwise).
Replacing a backend other than `default` needs `confirmReplace` equal to its name
(`replace_unconfirmed` otherwise). `{enabled:false}` restores `previous` and
removes OcuClaw's block. A managed install refuses with `managed`. Changes apply
from the agent's next new chat, as Hermes pins a session's backend with its tools.

`handoffs.restore` turns the switch off in each named profile that still selects
`ocuclaw-agents`, served or not. It is the phone's fix for the doctor's
`delegation_backend_stranded` fault (`profiles_report.py`).

At route time the backend re-checks the live enrollment set for both the asking
agent and the target, refuses asking oneself, and returns
`{profile, label}`; with no `agent` the task takes the default route.
Uninstall restores the previous backend in every profile.

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
| `gw.starmap.graph` | `{profile}` | `{status:"ok"\|"unsupported"\|"error", nodes:[NODE], links:[{a, b}], errorCode?}` — the Star Map sky for one profile (`""`/`main` = default; same served-AND-enrolled gate and `get_profile_dir` resolution as `gw.profiles.soul`). Python runs upstream `agent.learning_graph.build_learning_graph()` under `set_hermes_home_override(<profile home>)` and owns the projection (`star_map_rpc.py`). NODE = `{id, kind:"skill"\|"memory", group, name, text, description, createdAtMs, uses, by, stale, pinned, importance, source}`, every key present. Skills: `group` = category made display-ready (`-`/`_`→space, first letter upper; `skills`/`""`→`Learned`, ≤40); `description` = SKILL.md frontmatter `description` (best effort, ≤200); `createdAtMs` = `skills/.usage.json` `created_at`, else `first_seen_at`, else `null` (the graph's `timestamp` is last activity, never creation); `uses` = `useCount`; `by` = `agent`\|`learn`\|`user` as upstream says, anything else (`installed`, null) ⇒ `installed`; `stale` = `state=="stale"`; archived skipped. Memories: `group` `Memory` (MEMORY.md) or `About you` (USER.md); `name` = title (≤80); `text` = the entry's whole first line (≤280); `createdAtMs:null`, `by:""`, `uses:0`. `importance:0` and `source:""` always. This one method carries **ms**, not seconds: it is already the phone's shape. Caps: ≤400 nodes (drop oldest last activity, then least used), ≤800 links, links only between returned ids, no self links or duplicate pairs. No `agent.learning_graph` (or no home override) ⇒ `status:"unsupported"`. Never throws: refusals are `status:"error"` with `errorCode` `profile_not_served`\|`profile_not_found`, failures `graph_failed`\|`graph_malformed`\|`starmap_failed`; `nodes`/`links` are `[]` whenever status is not ok |
| `gw.starmap.forget` | `{profile, id, kind:"skill"\|"memory", text}` | `{status:"ok", action:"removed"\|"archived"}` \| `{status:"error", errorCode, message?}` \| `{status:"unsupported"}` — forget one star of `gw.starmap.graph`'s sky (same profile gate). Deterministic, exact text, refuse rather than guess; runs under `set_hermes_home_override(<profile home>)` (`star_map_rpc.forget_star`). Memory (`id` = `memory:<source>:<index>[:<fp>]`): rebuild the graph; the card at that id must still show `text` (its first line, ≤280), and exactly one MEMORY.md/USER.md entry must hold the card body (`entry[:1200]`), else `stale`/`ambiguous`; then `load_on_disk_store().remove(target, entry, matched_entry=entry)` (0.21.1: `remove(target, entry)`; both lock and re-read) ⇒ `removed`. Skill (`id` = name): a non-archived skill node must exist (else `stale`); `agent.learning_mutations.delete_node(id)` archives it (`hermes curator restore <name>` undoes) ⇒ `archived`; its refusal maps to `pinned`, `protected` (built-in, hub-installed, protected, read-only), `not_found`, else `forget_failed`. Bad id (empty, >160, kind/id form disagree)/kind/text ⇒ `bad_request`. No learning graph, memory store or `agent.learning_mutations` ⇒ `unsupported`. Never throws; other codes `profile_not_served`\|`profile_not_found`\|`forget_failed`; `message` is one human line ≤200 |
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
| `stt.capabilities.list` | `{}` | `{streamProtocolVersion?, providers:[{id, displayName, available, unavailableReason, models, defaultModel, supportsLanguage, supportsPrompt, streaming, streamingUnavailableReason}]}` — one row per Hermes STT backend the operator can pick. Sources, in wire order: hermes's own `BUILTIN_STT_PROVIDERS` (ids never enumerated locally), then `stt.providers.<name>: type: command` rows, then `agent.transcription_registry.list_providers()`. `unavailableReason` is `null` whenever `available` is true; `defaultModel` may be `null` (xai takes no model parameter, deepinfra resolves a live catalog) but when non-null is ALWAYS a member of `models`; `models` may be `[]`. Live words: `streamProtocolVersion:1` is present ONLY when this Hermes ships `tools.transcription_streaming` (0.22+); `streaming`/`streamingUnavailableReason` are below |
| `stt.transcribe` | `{provider, model?, language?, prompt?, streamId?, audio:{format:"wav", sampleRateHz:16000, channels:1, path}}` — `provider` required, the id the phone picked from the listing; `model`/`language`/`prompt` nullable and blank-tolerant (both mean "unset"); `audio.path` is the control-link spill file. `streamId` is set only by Node, for a live session it opened itself (never copied from a phone frame). | `{success, transcript, provider, error}` — Hermes's own transcribe envelope, values untouched, with its two optional keys filled: `provider` keeps whatever backend Hermes says actually ran, falling back to the pick; `error` is `null` on success and never empty on failure. NEVER raises: every refusal, provider error and unexpected exception comes back as `success:false` |
| `stt.stream.open` | `{streamId, path, provider, model, language, prompt}` — `path` is the relay's staged upload WAV, still being appended | `{opened:true}` or `{opened:false, reason}`. Never raises. Node timeout 5 s |
| `stt.stream.cancel` | `{streamId}` | `{cancelled: bool}` — best effort and idempotent; an unknown id returns `false` |

Parent → child, registered in the Node child's `linkMethods`:

| Method | Params | Result |
|---|---|---|
| `stt.stream.partial` | `{streamId, text}` — `text` is the FULL partial so far, not a delta | `null`. Node drops it when the id is unknown or the take has committed |

**Live words (Hermes 0.22+).** Live words show partial text on the glasses while the wearer talks. They are
optional and additive: the phone still gets exactly one final result, the
`stt.transcribe` result (relayed as the upload commit result). Partials are
non-final previews that the final replaces. Every failure on the live path
ends in the same batch transcription the lane always ran.

- **Listing.** Each row carries `streaming` and `streamingUnavailableReason`
  (`null` when `streaming` is true). `streaming` is true only when the module
  exists, the row is `available`, and the provider can open a live session
  with the credentials Hermes holds now. Built-ins `openai`, `xai` and
  `elevenlabs` (the module's `STREAMING_PROVIDERS`) are judged by read-only
  probes that mirror Hermes's own live wires: openai needs a direct key (the
  Nous-managed gateway proxies only the REST audio API), xai needs an API key
  (sign-in alone is not enough). Plugins stream when `streaming_capable` is
  true. The listing never calls Hermes's `streaming_available` (it goes
  through `_get_provider`), never connects and never installs. Reasons are
  short and wearer-facing: `Needs Hermes 0.22 or newer`; `Needs your own
  OpenAI key in Hermes. The Nous subscription only transcribes after you
  finish.`; `Needs your own xAI API key in Hermes. xAI sign-in only
  transcribes after you finish.`; `<displayName> transcribes after you
  finish` (any non-streaming provider, command rows included); `Set up this
  provider in Hermes first` (a streaming provider that is unavailable).
- **Open.** The path guard mirrors the spill guard (parent in the temp-dir
  candidate set, never a request-named directory) with the narrower basename
  prefix `ocuclaw-stt-upload-`, and also requires the named path to be a
  regular file and not a symlink. The file is opened read-only
  (`O_NOFOLLOW`) and is never claimed, renamed or deleted by this RPC. Then
  the transcribe lane's own gates run (STT enabled, dispatchable, available)
  plus the listing's live verdict, so a batch-only pick is refused with the
  words the settings screen showed. Hermes gets
  `open_streaming_session(on_partial, stt_config=<overlay>)`, where the
  overlay is the transcribe lane's language/prompt overlay plus
  `provider:<pick>` and `streaming:true`. The batch `model` is NOT forwarded:
  live wires have their own model (`stt.openai.streaming_model`, default
  `gpt-live-transcribe`). A feeder thread tails the file from byte 44, about
  every 50 ms, pushing only whole 16-bit samples.
- **Transcribe with `streamId`.** The session is taken out of the table, the
  spill file is claimed exactly as before, then the feeder drains the file to
  its final size (Node closed it before calling) and the session is
  finalized (at most 10 s). A non-empty success returns
  `{success:true, transcript, provider, error:null}`, and the claimed spill is
  still deleted. Anything else (provider mismatch, drain or finalize failure,
  empty or failed final) cancels the session and runs the unchanged batch
  path on the same claimed file. An unknown or expired `streamId` is plain
  batch; an older Python ignores the param, which is also batch.
- **Partials.** Coalesced per stream: latest text wins, at most one request
  in flight, at least ~100 ms apart, never sent once finalize or cancel has
  begun. Fire-and-forget from the event loop; every error is swallowed.
- **Limits.** At most 4 open sessions; each is cancelled 200 s after open.
  Sessions leave the table on finalize or cancel, and all are cancelled when
  the adapter disconnects or the child exits. A cancel can overtake its own
  open (Node cancels an open that timed out on the link): a cancel for an id
  not in the table leaves a tombstone that refuses a later open of that id,
  and a cancel that lands while Hermes is still opening cancels the session
  as soon as it attaches.

The relay additionally supports progressive **phone-to-relay uploads**. Python
still receives exactly one complete WAV through `stt.transcribe`. When live
words are on, the relay also opens a live session on the staged upload and
forwards partials to the phone; the final transcript is still the one commit
result.
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

## TTS lane (read replies aloud)

Child → parent RPCs behind the phone's "Read replies aloud". Python side:
`tts_rpc.py` (in-process Hermes calls, off the event loop via
`asyncio.to_thread`). Node side: `extensions/ocuclaw/src/runtime/tts-lane.ts`,
which the phone reaches with `ocuclaw.voice.tts.capabilities.get` and
`ocuclaw.voice.tts.speak`. The phone cuts a reply into sentence-sized pieces
and asks for one clip per piece; the relay holds no speech state. Node timeout
is 10 s for the listing and 60 s for a clip.

| Method | Params | Result |
|---|---|---|
| `gw.tts.capabilities` | `{}` | `{active, providers:[{id, label, available, voices:[], voice?, unavailableReason?}]}`. One row: the provider `tts.provider` names in Hermes's config (default `edge`). `available` is Hermes's own passive check (`check_tts_requirements`, which never installs). `voice` is the configured voice when the config names one. Raises when the config or the speech tool cannot be read; Node maps that to the snapshot's `status:"error"`, and no link to `status:"offline"` |
| `gw.tts.speak` | `{text, outputPath, voice?}`. `text` is at most 800 characters after trimming. `outputPath` is a file the relay named: a direct child of a system temp directory whose name starts with `ocuclaw-tts-` | `{success:true, provider, path}` or `{success:false, provider?, error:{code, message}}`. `code` is `invalid_request`, `text_too_long` or `speak_failed`. NEVER raises |

Rules:

- **Hermes's configured provider speaks, always.** Upstream ignores a per-call
  provider on purpose, so the listing names one provider and the phone offers
  no switch on Hermes (`canChoose:false` in the app snapshot). `voice` is
  passed through only for built-in ElevenLabs, the one place Hermes accepts a
  per-call voice.
- **Audio never rides the link as base64.** Hermes writes the clip to
  `outputPath` (or the same stem with another extension, when the provider
  writes a different format); `path` in the result is always on that stem.
  The relay reads the file, sniffs its format, sends the bytes to the phone
  and deletes it. A failed or raising call deletes whatever it left.
- **Nothing else is written.** A path that is not a relay speech file is
  refused before the tool runs. No chat, session or store is touched.

The agent can turn read aloud on or off for the wearer with the settings tools
(`get_ocuclaw_settings`, `set_ocuclaw_setting`; see the phone tools lane):
`read_aloud` takes `off | voice | always` and `read_aloud_paused` takes
`on | off`. The tools cannot pick the service or the voice.

### Settings tools

The settings an agent may change live on the phone, and so does the list of
them. `get_ocuclaw_settings` (`tools.getPhoneSettings`) makes the relay send
the phone `ocuclaw.settings.agent.get` (`requestId`); the phone answers
`ocuclaw.settings.agent.snapshot` (`requestId`, `settings`: rows of `name`,
`value`, `allowed`, `confirm`). `set_ocuclaw_setting`
(`tools.setPhoneSetting`) sends `ocuclaw.settings.agent.set` (`requestId`,
`name`, `value`, both text; a boolean crosses as `on` or `off`) and the phone
answers `ocuclaw.settings.agent.result`: `ok: true` with `name`, `value` and
`previous`, or `ok: false` with a `code` and an optional `message`. A setting
whose row says `confirm` waits for the wearer's tap on the glasses; the phone
gives up after 45 s. A phone that predates the tools ignores the frames and
each tool returns `settings_timeout`.

### Show the Bot Screen tool

`show_bot_screen` (`tools.showBotScreen`, Hermes only, #7571 follow-up) is for
"show your computer on my glasses", "start the bot screen". It is an action,
not a stored setting, so it is its own tool rather than a settings row. The
relay sends the phone `ocuclaw.botscreen.show` (`requestId`); the phone opens
the glasses' Bot Screen page and, when the screen is installed and off, starts
it through its own Start path (`ocuclaw.botscreen.start`, then the parent's
`botScreen.start`: Hermes's own start, never an install and never a lower
memory floor). It answers `ocuclaw.botscreen.show.result` (see the Bot Screen
lane). The tool returns `{state, started, opened}` or a coded error. A status
that says the screen is up is asked again too (`botScreen.start` answers
`already` for a running screen), since a phone's status may predate Hermes's
idle stop. The page never covers a recording, a review, a question or typing
(`opened:false`). This widens what the agent may do: on a gateway host Hermes's
own `computer_use` starts an off screen only with `bot_desktop.auto_start` on
(default off); this tool starts it whatever that says, with no confirm, on the
wearer's ask (Matt, 2026-11-15). The description allows it only when the user
asks and tells the agent not to begin computer use for it. The tool is not tied
to the calling agent's profile: the phone shows and starts the screen of the
profile it has selected.

## Visible command settings lane (sanctioned policy — 2026-07-08)

Silent per-session override RPCs are retired. The settings UI still exposes
model, thinking-effort, and reasoning-display controls, but the Hermes path
implements them as ordinary visible command turns sent through this adapter's
own session via `dispatch.send` (except reasoning display, which is silent;
see below). Hermes owns parsing, validation, warnings,
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
host API returns `unsupported`.

**Fallback on `unsupported` (#2934).** `GatewayRunner.apply_session_options`
ships only in upstream PR #92187; no tagged Hermes release carries it (checked
through 0.23.2 / v0.23.2). When the adapter answers `unsupported`, the
runtime applies the same patch through Hermes's session-scoped slash commands
as visible conversation turns, in this order: `/model <id> [--provider <p>]`,
`/reasoning <effort>` (`reasoning_effort:""` → `/reasoning reset`; effort off
is `/reasoning none`, because `/reasoning off` hides the display), then
`/fast on|off`. An empty `model` (inherit) has no slash form and is rejected
with a reason. The `sessions.patch` result carries `fallback: "slash_commands"`
and `structured: null`. Any other non-accepted status is still an error.

**Reasoning display is silent (2026-10-23).** A presentation-only
`reasoningLevel` change (`on`/`off`; anything else is rejected) no longer sends
a visible `/reasoning show|hide` turn, whose "Reasoning display: ON/OFF" reply
cluttered the chat. The runtime calls `profile.options.apply` with
`{ns, options:{show_reasoning:true|false}}` for the session's profile. The
adapter writes `display.platforms.ocuclaw.show_reasoning`, the same key native
`/reasoning show|hide` saves, and answers with the profile's resolved readback.
The patch is applied only when that readback's `reasoningLevel` matches; an
adapter refusal surfaces its `error`. Hermes re-resolves the key per turn, so
no restart is needed, and a busy session does not block the write. Like the
native command, this is a profile-wide display setting, not a session one.

A deliberate one-turn model action still uses visible `/model ... --once`.
`verboseLevel` and `elevatedLevel` remain no-ops.

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
  `_derive_thinking_headline` picks the LAST CLOSED `**bold**` span in the
  reasoning (`bold`), else a `reasoning_details[]` entry typed
  `reasoning.summary` that is genuinely one short line (`summary`), else
  nothing (`detail`). A headline is one markdown-free line, ≤80 chars.
  When the source is `detail` the frame carries NEITHER `summary` NOR any
  detail-bearing key (`thinking`, `reasoning`, `thinkingText`, `analysis`):
  the client honours an explicit source and would otherwise select the whole
  reasoning blob verbatim and paint truncated prose at summary rank. With no
  key at all it falls through to its generic "Thinking..." label.
- A `detail` frame also carries headline MATERIAL for a runtime that can cut
  its own headline. Add-only: a reader that does not know these keys ignores
  them, and neither is a detail-bearing key from the list above.
  - `thinkingProse`: the last 600 characters of this model call's reasoning,
    whitespace as written, taken before the 8000-char frame cap. Present
    whenever the frame's source is `detail`.
  - `thinkingSummaryLong`: the first `reasoning.summary` entry that was turned
    down only for being multi-line or over 80 chars, its first 400 characters.
    Absent when there is no such entry.

  A `bold` or `summary` frame carries neither key. While plain-prose
  reasoning streams, each sentence the model finishes also goes out on a
  `detail` frame with `thinkingProse` and `thinkingLive: true`. The runtime
  shows a headline cut from it when its `headline` switch is on (the default
  on a Hermes host) and the sentence is about a step, and drops the frame
  otherwise; the `post_api_request`
  frame that follows carries the same material without `thinkingLive`.
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

### Tool start extras (`purpose`, `search_files` `query`)

Both are add-only on the `pre_tool_call` (`toolPhase:"start"`) frame.

- `purpose`: a top-level string, never inside `args`. It is the `purpose` the
  model wrote on a `terminal` call while "Explain commands" is on (see
  "Plain-English approval cards"), read from the approval store by tool call
  id WITHOUT consuming it, so an approval card for the same call still gets
  it. One plain line, URL credentials redacted, at most 120 chars. Absent when
  the setting is off, the call recorded none, or the record went stale.
- `args.query` on a `search_files` frame: Hermes names the search pattern
  `pattern`, which the argument allow list omits. The adapter copies it to
  `query`, redacted and capped at 512 chars (then `...[truncated]`) like every
  other argument string, unless the call already has a `query` or the pattern
  is blank or not a string. `args.pattern` itself still goes out as
  `"[omitted]"`.

### Pre-tool sentence (`origin:"narration"`, from `post_api_request`)

When one model call returns visible `content` together with at least one tool
call, the adapter sends the sentence as an activity frame from
`post_api_request`:

`{state:"thinking", origin:"narration", category:"narration", phase:"update",
summary, runId, sessionKey, turnId?, modelCallSeq?}`

`summary` is the content with whitespace collapsed, cut at 600 chars; the
runtime owns shortening, ranking and whether the wearer sees it. `turnId` is
the hook's `turn_id` when it has one. No frame when the call asked for no
tool, when the content is empty or Hermes' `(empty)` placeholder, or when the
content carries inline reasoning markup (`<think>` and the other names in
Hermes' `agent/think_scrubber.py`). OcuClaw turns only (the shared
turn-context filter on `platform`).

Order: Hermes fires `post_api_request` in response intake and runs the call's
tools afterwards (`agent/turn_response_intake.py`, then
`agent/turn_tool_round.py`; read at 0.23.1), so this frame precedes every
`pre_tool_call` frame of the same model call. Within the handler it follows
that call's thinking frames. `post_api_request` is a timeout-bounded hook: a
callback Hermes abandons at `plugins.hook_callback_timeout` loses that
guarantee.

### Delegation routes (`delegation`, #6794)

A `delegate_task` tool frame names who the work went to when Hermes 0.23's
delegation routes say so (`delegation_routes.py`). Add-only: a frame without
route data carries no `delegation` key, and readers that do not know the key
ignore it (`RelayActivityDelegationProtocolTest.anOldReaderIgnoresDelegation`).

- **Start** (`pre_tool_call`): `{routes:[{label, kind}], tasks}` from the call's
  arguments. `subagent_start` carries no route in 0.23, so the arguments are the
  only source while the call runs. A task's route is its `agent` or `profile`
  parameter (`kind:"profile"`) or its `option` parameter (`kind:"model"`);
  `tasks` counts every task in the call, labelled or not.
- **End** (`post_tool_call`): each result entry's `route` (from `results` and a
  background dispatch's `inline_results`) as `{label, kind, backend, model?,
  provider?, durationMs?, status}`. `kind` is `"profile"` for the
  `profile_routes` and `ocuclaw-agents` backends, else `"model"`; `status` is
  `ok`, `error` or `refused` (a route the backend refused).
- **Background calls**: a call that returns `{status:"dispatched",
  mode:"background"}` has no routes in its result. The adapter ties each child
  to its task by goal (`subagent_start`) and, as each child stops
  (`subagent_stop`), sends its route with status and time: a closing tool frame
  of the dispatching call (`toolPhase:"end"`, its run and `toolCallId`) whose
  `delegation` adds `background: true` and has no `model` (only the result
  entry has it). The results reach the chat as a turn Hermes starts itself
  ("[ASYNC DELEGATION BATCH COMPLETE …]"). The adapter opens a run for it in
  `pre_llm_call` (run id `helper-<hex>`, a lifecycle start and no user row), so
  its reply streams like any turn's; nothing opens while another turn holds the
  chat. The app credits the chat's first reply after the ones it had when the
  route came back, not the dispatching run's own reply: by that reply's run from
  its first streamed row, or by the reply once committed when it has no run
  (an older adapter). The frame arrives after its run ended; readers take it
  before their run guards.

At most 8 routes; a label over 64 characters or a model over 96 is dropped, and
a result over 512 KiB is not read. The relay turns the start into the glasses
header ("Asking planner…", "Sub-agent → fast…", "Asking planner + 1…"); the app
keeps the end as the credit line under that run's reply and the Home card's
Handoff row.

### Model call ordinal (`modelCallSeq`)

Headline and tool activity frames carry `modelCallSeq`: the 1-based ordinal,
within the run, of the model call the frame belongs to. A logical call is one
`api_request_id` (its retries share it), numbered in `pre_api_request` order.
A headline frame (streamed or from `post_api_request`) names the call whose
reasoning produced it; the stream hooks name a call only by `iteration`, the
same turn counter `pre_api_request` carries as `api_call_count`. A tool frame
(start and end, and its plan snapshot) names the call that requested the
tool: the call that started last when the tool started. A pre-tool sentence
frame names the call that wrote it. A frame the adapter
cannot place (no `pre_api_request` seen for its call, the lifecycle start)
carries no `modelCallSeq`. The glasses keep a headline on the bar through the
tools of its own call and let a tool label take the bar only for a newer call.

### Reasoning deltas (`on_stream_*`, 0.20.5+, opt-in)

Registered ONLY when the host has the hooks AND
`plugins.stream_reasoning_deltas: true` is already in the config at startup.
Fresh OcuClaw setup defaults an unset key to true, announces the gateway-wide
scope, and preserves saved values. The setup tool uses
`{operation:"enable_stream_reasoning_deltas", confirm:true, defaultsOnly:true}`;
an existing value returns `reason:"existing_choice"` without a write (true
returns `already_enabled`). Updates still require an explicit yes before
enabling it. Cloudways setup uses the Hermes config CLI and verifies readback
before proceeding to the same pending gateway restart as its other settings.
Registering any `on_stream_*` hook flips hermes's process-wide
`_has_stream_consumers`, which changes the provider call shape for every
surface on that gateway — so an operator who did not opt in sees no transport
change. The key is read ONCE, at registration; upstream's own
`stream_reasoning_deltas_enabled()` re-reads config on every call, which is not
a per-delta budget.

**State and enable from the app (profile-options lane).** Add-only on the
existing link methods; the key is gateway-wide, so every profile on one
gateway reads the same answer and `ns` does not select it.

- `profile.options.get` `{ns?}` readback gains `liveReasoning`:
  `"on"` (key true and this process registered the hooks), `"restart"` (key
  true, but this process booted before it was written), `"off"` (somebody
  saved false), `"unset"` (nobody chose) or `"unavailable"` (this Hermes has no
  reasoning-delta hooks). The field is absent when the gateway config cannot
  be read.
- `profile.options.apply` `{ns?, options:{live_reasoning:true}}` writes
  `plugins.stream_reasoning_deltas: true` through the setup tool's own writer
  (`defaultsOnly` false, so a saved `false` is replaced). The option may ride
  alone or with other options; alone, the profile's config is not rewritten.
  The result is the usual `{status:"accepted", …readback}` plus
  `liveReasoningResult` (`"written"`, `"already_enabled"`,
  `"config_unwritable"`, `"unavailable"` on a host without the hooks, which
  writes nothing, or `"ignored"`) and `restartRequired` (true exactly when the
  readback says `"restart"`). Both are absent when the patch did not carry
  `live_reasoning`. The lane turns the key on only: any value but a real
  `true` writes nothing and answers `"ignored"`. After a successful write the
  next readback says `"restart"` until the gateway restarts.

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

**This hook sends no status-bar frame.** The adapter used to emit
`{state:"thinking", origin:"narration", category:"narration", summary:…}` from
this hook for each sentence. #1619 retired that: with a real model hermes
commits the interim AFTER the tool activity frame, so the narration rung lost
arbitration on every single turn — 12 real-model dumps (pet sim-d,
gpt-5.6-sol) contained zero `origin:"narration"` frames, and the matching
`agentProgressNotes: status` setting value was indistinguishable from `off`
while silently deleting the sentence. The hook's remaining jobs are tagging
the sentence and correcting a commit that beat it. The runtime shows a tagged
note as a live work-panel row and drops its conversation page: a note is
never durable conversation history. The `origin:"narration"` activity frame
is now sent from `post_api_request` instead, where it is ahead of the tools
(see "Pre-tool sentence" above).

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

#### Plugin messages (`post_message`, Hermes 0.22.3+)

A Hermes plugin's `ctx.post_message(text)` reaches `send()`, and its
`handle.edit(text)` reaches `edit_message()`, from `gateway.plugin_messages`.
The send carries the same `_interim_send` marker as commentary and no key of
its own, so the adapter tells it apart by the calling module, checked before
`send()` first awaits. A plugin message never touches the ledger: it is not a
slash command's reply, not the turn's open message and not narration. It is
emitted as an uncorrelated `message` with its own `id` and
`pluginMessage:true`, and the adapter keeps that id (the newest 64) so an edit
finds it. The relay copies `pluginMessage:true` onto the ledger entry, and the
app never takes such an entry for the reply of the turn it lands in: a tool's
status line usually arrives before the turn streams a word. An edit is a
`message` with `{edit:true, pluginMessage:true, id, role:"assistant", content}`
and no `originAtMs`; the consumer
replaces the text of the message with that `id` where it sits, and adds it as
a new message when it no longer holds one (the session was reloaded since).
Any other `edit_message()` id is a StreamConsumer edit, bound by
`DispatchLedger.note_edit` as before.

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
- `viewer_prompt_message_event` — the prompt row of a viewer turn (see the D9
  table); the adapter mints its id.
- `message_edit_event` — names the plugin message whose text it replaces.

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

### Run signals (`runSignal`)

Parent → child event `runSignal` carries the glasses status lens's run spans:
model calls (K9), context compaction (W1), subagents (H4) and retry waits
(K6). The child relay pairs them (`run-signals.ts`) and sends each to the app
as `ocuclaw.run.signal`; older apps drop the unknown type. The bookkeeping is
`run_signals.py`; the hook wiring is in `adapter.py`.

Payload: `{signal, phase, sessionKey, runId?, spanId, atMs, ...}`.

- `signal` is `model_call`, `compaction`, `subagent` or `retry_wait`.
- `phase` is `start` or `end`. Every end follows the start it pairs with.
- `sessionKey` is the dispatch record's public key. For a subagent it is the
  PARENT's session.
- `runId` is the dispatch record's run id. It is left out when the record
  names none.
- `spanId` pairs a start with its end and is unique within the run (rules
  below).
- `atMs` is epoch ms on the host clock, taken when the hook ran.
- `outcome` is on ends only. model_call: `completed` or `error`. compaction:
  `completed` or `failed`. subagent: `ok`, `error`, `timeout`, `killed` or
  `unknown`.
- `provider` and `model` are on a model_call start, when Hermes names them.
- `label` is on a subagent start: the child's role (`child_role`, e.g. `leaf`).
- `reason`, `attempt` and `maxAttempts` are on a retry_wait start.

| Signal | Start | End |
|---|---|---|
| `model_call` | `pre_api_request`, once per physical attempt | `post_api_request` (`error` when the response carries a provider error, else `completed`), or `api_request_error` (`error`, every failed attempt, retried or not) |
| `retry_wait` | `api_request_error`, when the engine will back off (below) | none from the adapter: the relay ends it when the run's next model_call starts, or when the run ends |
| `compaction` | `pre_auxiliary_call` with `aux_task: "compression"` | `post_auxiliary_call` (`failed` when the attempt raised) |
| `subagent` | `subagent_start`, routed by `parent_session_id` and `parent_turn_id` | `subagent_stop`: `child_status` completed → `ok`, failed or error → `error`, timeout → `timeout`, interrupted → `killed`, anything else → `unknown` |

`spanId` rules:

- model_call: Hermes mints `api_request_id` (`<turn_id>:api:<n>`) once per
  logical call, and every retry of the call reuses it. Attempt 1 uses the id;
  attempt n uses `<id>#n`. Without the id the adapter rebuilds the same shape
  from `turn_id` and `api_call_count`.
- retry_wait: `<the failed attempt's spanId>:wait`.
- compaction: the auxiliary call's own `aux-<uuid>`, with `#n` for attempt n
  (`retry_count` is the auxiliary attempt's 0-based index). Without an id:
  `compaction:<turn_id>:<started_at in ms>`.
- subagent: `child_session_id`, the one id both hooks carry. When it is
  missing, `child_subagent_id` opens the span, and the relay ends it with the
  parent run.

Routing. A start routes like tool activity (`_turn_activity_context`): the
platform filter first, then background-review forks, then the SessionDB row,
an OcuClaw session key and an OcuClaw turn in flight (a slash head and a
pre-reset carrier are dropped). A start that does not route opens nothing. A
start that routes counts as turn activity, as a tool hook does: it refreshes
the turn's idle clock, and it can promote a queued dispatch (with its
lifecycle-start frame) at the first model call's start. An end only ends a
span this adapter opened, so a foreign platform, a turn-less call or a second
end sends nothing. An agent makes one main-loop model call at
a time, so a session's new model_call start first ends its still-open attempt
as `error`: some recoveries resend the call without `api_request_error` (an
error recovered before classification, a truncated response).

When a retry_wait opens. All of these must hold:

- `retryable` is `true`.
- `reason` is one whose recovery is a backoff sleep: `rate_limit`,
  `upstream_rate_limit`, `overloaded`, `server_error`, `timeout` and `unknown`
  (`turn_api_error.settle_unrecovered_error` → `compute_error_backoff`), and
  `invalid_response` (`turn_response_check.retry_invalid_response` →
  `jittered_backoff`). Other reasons are repaired and resent at once,
  compressed, or end in a fallback or a terminal error.
- Attempts remain: `retry_count + 1 < max_retries`. `retry_count` is the
  failed attempt's 0-based index (the hook fires before the engine adds one)
  and `max_retries` is the attempt budget (`agent.api_max_retries`, default 3;
  the retry loop runs while `retry_count < max_retries`). So
  `attempt = retry_count + 2`, the attempt the wait leads to, and
  `maxAttempts = max_retries`.

Floor and feature detection. The five hooks are probed against
`hermes_cli.plugins.VALID_HOOKS` and never registered blind, and a start/stop
pair is wired whole or not at all. `pre_api_request`, `subagent_start` and
`subagent_stop` are in the 0.21.1 floor's vocabulary (`v2026.9.7`).
`pre_auxiliary_call` and `post_auxiliary_call` arrived in 0.21.5
(`v2026.9.24`), so a 0.21.1–0.21.4 host shows no compaction. There is no
feature token: the lens draws whatever frames arrive and never branches on
what could arrive. `_setup_status()` reports
`hermesHooks.auxiliaryCallHooksAvailable`, so a missing compaction row is
explainable from one receipt. Model-call ends and retry waits ride
`post_api_request` and `api_request_error`, which are always registered.

Cost. All five are observers, and Hermes ignores what they return. The
model-call and auxiliary hooks run under Hermes's hook timeout; the subagent
pair runs inline to completion. Registering `pre_api_request` makes Hermes
build its hook payload (a sanitized copy of the request) for EVERY main-loop
model call on the gateway, any platform. The handler drops a foreign platform
before any lookup; an OcuClaw call costs one SessionDB row read, as
`post_api_request` already does. The auxiliary pair makes Hermes build a
payload for every auxiliary call (titling, vision, MoA and the rest); the
handler returns on its first line unless `aux_task` is `compression`.

What a Hermes run signal does not say:

- No wait time. Hermes tells plugins neither how long it will sleep nor when
  the next attempt starts, so a Hermes retry_wait never carries `waitMs` or
  `retryAtMs`, and the adapter never estimates one.
- A retry_wait is a forecast. `api_request_error` fires before the engine
  picks its recovery. Credential-pool rotation, an eager fallback to another
  provider or the free-tier cooldown cut (main) can replace the sleep with an
  immediate next call or end the turn. The next model_call start ends the wait
  at once (the relay's outcome `retrying`), and the run's end ends it too.
- The Z.AI coding-overload path raises the attempt budget after the hook
  fires, so a wait past the reported budget opens no retry_wait, and
  `maxAttempts` can be the budget before the raise.
- The auto-recovery ladder that parks a turn after its budget is spent
  (`auto_recover_after_exhaustion`, 0.21.5+) opens no retry_wait: the last
  failed attempt reports no attempts left.
- `subagent_stop` fires on the parent's thread once per child when
  `delegate_task` collects the batch, so a child that finished early shows
  running until its batch is collected.
- compaction is one span per auxiliary provider attempt, and its outcome is
  that attempt's. A compaction outside an OcuClaw turn (no parent turn, so no
  `session_id`) is dropped.

The child relay also reads every `model_call` start for its card build
tracker (`card-build-phases.ts`): a model call inside a program card build
is taken to be writing, fixing or checking the card, and the app gets the
phase as `ocuclaw.card.build`. Nothing new crosses this link for it; the
tracker's other inputs are the card tools' activity frames, the reasoning
headlines the relay already resolves from thinking frames (the frame's `note`),
and the relay's own ask, request and card-response edges.

### Sessions gone (`sessionsGone`)

Where the host's hook vocabulary has `on_session_delete` (0.22.3+; absent
0.22.0-0.22.2), the adapter registers it as an observer. It fires once, after
the delete or archive has committed, in the process that committed it. Each
call sends backend event `sessionsGone`:
`{ns, ids, reason, origin}`.

- `ids`: every native session id that went (`session_id` plus
  `deleted_ids`), sorted. The rows no longer exist, so the child maps them to
  public keys from the rows its own `sessions.list` answers carried (`id` and
  `lineageRootId`). An id it never listed maps to nothing; the frame then
  only refreshes the picker.
- `reason`: Hermes's own (`delete`, `archive`, `empty_sweep`, `prune`,
  `ghost_prune`, `profile_repair`), passed through.
- `origin`: `ocuclaw` while OcuClaw's own phone delete tells plugins
  (session_writer), else `hermes`. The relay already cleaned up its own
  deletes and ignores `ocuclaw` frames.
- `ns`: the namespace of the store's profile. A delete in the gateway's own
  profile maps to the adapter's namespace; another profile maps through
  `namespace_for_profile` and is sent only while this gateway serves or
  drains it. A store outside every profile sends nothing.

Process-local by design (phase 1). Desktop and dashboard single deletes and
archives, a TUI on the shared gateway and the gateway's own prune commit in
the gateway process, so they reach the adapter. `hermes sessions
delete|prune|archive`, the classic CLI's `/exit --delete` and a standalone
dashboard's bulk deletes commit elsewhere: Hermes loads the plugin there too
(lazy discovery), but no adapter is live, so the hook does nothing and the
picker catches up on its next fetch.

The relay coalesces frames for 250 ms, drops its 5 s session cache and
re-broadcasts the list. For each mapped key that a fresh exact-key read no
longer finds, it forgets the chat's per-session state, unless `reason` is
`archive`. An archived chat keeps its row on the exact-key path
(`include_archived`), so an archived open chat stays open. When the open chat
is really gone, the relay opens a new chat and sends `sessionSwitchApplied`
with `previousSessionGone: true`; the glasses say "Session gone" once.

### Compaction counts (`sessionCompacted`)

Hermes compacts in place by default (`compression.in_place: true`), so the
session id, and with it the compression chain, does not change, and a hop
count stays 0. On 0.22.3+ the `post_compaction` hook fires once per committed
compaction on every path (in-turn, `/compress`, gateway hygiene, micro
summaries, tool-result prunes, provider-native), in the process that
compacted and in that session's profile scope. `compaction_ledger.py` counts
each one in `<HERMES_HOME>/state/ocuclaw.compactions.json`: per Hermes
session id, `full` (in-place `summarize` and `provider_native`), `micro`,
`prune`, `rotatedIn` (already a chain hop) and the newest event. The hook
runs inside the commit window with the lease held and under Hermes's hook
timeout, so it only bumps memory; a timer thread merges the deltas into the
file under a lock within about a second, and at exit. `trackingSince` is when
the profile's ledger was armed (plugin load on a host with the hook, or the
first event); a session that started earlier may hold uncounted compactions,
so its total is a floor (`exact: false`). Evicting an old entry (more than
5,000 sessions) moves `trackingSince` past it.

For an OcuClaw chat, the gateway also sends parent → child event
`sessionCompacted`, from a worker thread, for every kind:

`{sessionKey, sessionId, kind, reason, inPlace, counted, beforeTokens, afterTokens}`

- `sessionKey` is the public key (`hermes:<ns>:<chatId>`); a foreign session
  sends nothing.
- `kind` is `summarize`, `micro_summarize`, `prune_tool_results` or
  `provider_native`; `reason` is Hermes's trigger (`manual`, `pre_api`,
  `post_tool`, `overflow`, `gateway_hygiene`, `between_turns`,
  `proactive_prune`, `provider`, `unknown`).
- `counted` is true when the event added to the total.
- tokens are Hermes's figures, `null` when it had none.

The child re-reads the active session's context at once and re-anchors open
Live UI surfaces (K17) on any kind. A CLI process counts into the same file
but has no adapter, so it sends nothing.

## Session-control lane

Hermes 0.20 exposes native platform approval delivery and resolution seams.
The adapter implements `send_exec_approval`, mirrors each request to the
glasses approval HUD, and resolves it through Hermes'
`resolve_gateway_approval`. It does not inspect private approval queues.
`send_exec_approval` carries no entry id, so at mirror time the adapter reads
the public `list_gateway_approvals(session_key)` (Hermes enqueues before it
notifies) and keeps the entry's `request_id` when exactly one unclaimed entry,
or exactly one with the same command, is open (#4983). The resolve then passes
`request_id=` so it lands on that prompt; with no id, or a resolver without the
parameter, it resolves the session's FIFO head, as before.
`post_approval_response` reconciles resolutions made through Hermes' typed
fallback so the mirrored HUD clears exactly once.

The mirrored countdown inherits Hermes' effective `approvals.timeout` value.
Hermes 0.20 defaults that setting to 300 seconds; an operator override wins.
Timeout and disconnect
remain implicit deny (silence is not consent). Smart-denied requests expose
only Once and Deny; ordinary requests expose Session only when Hermes marks
that scope available. Permanent approval remains absent from the glasses
decision set.

Plain-English approval cards (approval_explain.py). Where the host has request
middleware (0.21.5), `llm_request` middleware adds an optional `purpose` string
to the `terminal` tool schema on OcuClaw turns only, and `tool_request`
middleware pops it on every platform before Hermes's hooks, guardrails,
approvals and execution run, so they see exactly the arguments they saw
before. `pre_approval_request` ties the approval to its tool call. The
`approval` backend event then carries `request.purpose` (at most 120 chars,
one plain line) and `ocuclawApprovalContext` `{purpose,userMessage,
assistantText,thinkingText}`; blanks are omitted, and Node never forwards the
context to clients. The shared explainer in Node writes the card's sentence
through child → parent RPC `approval.llm.complete`
`{messages,maxTokens?,temperature?,timeoutMs?}` → `{text}` or `{error}`,
answered with the plugin's `ctx.llm` (no model or provider override). Where
the host has `register_auxiliary_task`, the call passes
`task="ocuclaw_approval_explain"`, the plugin's "OcuClaw approval explainer"
row, which inherits Hermes' `approval` task: by default the smart-approvals
model writes the sentence, and a model pinned under
`auxiliary.ocuclaw_approval_explain` receives the command and its context.
Live view refresh (`liveui.llmRecipe`) passes `task="ocuclaw_liveui_refresh"`
the same way, and a recipe's own `model` still wins. On an older host neither
task exists and no `task=` is sent. `approvals.read` reports
`explainerTaskRegistered`; when it is true the snapshot also has
`fields.explainerModel` (`inherit` or a `provider|model` key, over the four
leaves `auxiliary.ocuclaw_approval_explain.{provider,model,base_url,api_key}`),
`explainerModels` (`inherit` first, then the Learning panel's model list),
`explainerModelsTruncated`, `approvalModel` (`provider|model` or `main`) and
`customExplainerRoute`. An update to a model key needs
`confirmations: ["explainerModel"]` and clears the task's base URL and key;
`inherit` writes provider `auto` and empty model, base URL and key (Hermes'
"Follow Approval") and needs none. A model outside `explainerModels` fails
`model_unavailable`. The child pushes the wearer's "Explain commands" setting through
child → parent RPC `approval.explain.setting` `{enabled}` → `{ok,enabled}`
at relay start and on each change. While it is off, the parent adds no
`purpose` schema field and the event carries no `request.purpose` or
`ocuclawApprovalContext`; the strip middleware stays on. On until pushed; an
older parent answers method-not-found and the child ignores it. None of this
changes an approval decision.

Saved card AI review (card_review.py). The phone's AI review of a saved
programmable card runs in the shared Node reviewer, which writes its staged
calls (glance, outline, five details, and a fix when an Accept needs one)
through child → parent RPC `program_card.review.llm.complete`
`{messages,maxTokens?,temperature?,timeoutMs?,callId?}` → `{text,model?,provider?,imageModel?,usage?,stopReason?}` or
`{error}`. `usage` is `{inputTokens?,outputTokens?,costUsd?}` from the
completion (finite and non-negative); `stopReason` is `length` or `stop` when
the host reports a finish reason. On Hermes only a `length` stop reason marks
an answer cut off: Hermes 0.22.5 sends no `max_tokens` on most routes and its
output tokens include reasoning, so a full budget says nothing (OpenClaw, which
enforces the budget, also treats output that filled `maxTokens` as cut off).
A complete answer is never counted as cut off. A cut-off answer that does not
parse gets one repair at a larger budget (outline 4000, detail and fix 8000)
with a "use fewer, shorter edits" hint, then fails as `model_truncated`. The
call counts in the `ocuclaw_card_review` row of `health.usage` `tasks`. The parent answers with the plugin's `ctx.llm` (at most 4 messages,
262144 characters each, 8000 tokens, a 300 s deadline). Where the host has
`register_auxiliary_task`, the call passes `task="ocuclaw_card_review"`, the
plugin's "OcuClaw card review" row, so a model pinned under
`auxiliary.ocuclaw_card_review` writes the review. An older parent answers
method-not-found, and the review stops with that error.
Message content accepts the existing strings or at most 16 text/`image_url`
parts. Images must be inline `data:image/png;base64,...` URLs: no remote URLs,
other MIME types or content block types. The parent permits at most six PNGs
and 1.5 MiB of decoded PNG data across the call, rejecting bad base64 or an
exceeded bound before `ctx.llm`. When the completion reports its actual
provider and model, `imageModel:{provider,model,input}` describes that exact
route through Hermes' public image routing API. Its identities retain up to
160 characters, separately from the 80-character display fields; a longer or
missing identity is unknown and text-only. These response facts do not
override the auxiliary task's provider, model or trust policy.
The shared reviewer allows at least 45 s for the first look (75 s with asks),
180 s for the outline, 150 s per detail/fix, and 360 s for the whole review
including format repairs. A route whose recent calls ran slower gets 1.5 times
its slowest of the last 8 calls per stage (a timed-out call counts as its
deadline), at most 120 s, 300 s and 240 s, and the whole review gets the same
extra time, at most 600 s. Host waiting updates every 30 s never renew these
deadlines. The Node link allows the requested model deadline plus 2 s for
transport; the outer reviewer
remains authoritative. Phone reconnects read state and do not replay starts.
`program_card.review.llm.cancel` `{callId}` → `{cancelled:boolean}` cancels
only that pending review call (including a call queued in the host). An old
parent without cancellation keeps its already bounded call; no request is
retried. Late results cannot update a stopped or replaced review. Cancellation
is best effort at the provider boundary; a remote server or synchronous SDK
worker may finish after local cancellation.

Task setup proposals use `task.proposal.llm.complete/cancel` with the same
bounded completion and exact-call cancellation transport. They have their own
call registry, purpose `ocuclaw.task.proposal`, and optional auxiliary task
`ocuclaw_task_proposal` ("OcuClaw Task setup"). The relay requests at most 2600
tokens and 120 seconds. Calls are tool-free; they cannot create a Task, grant
access or change a schedule. The phone must preview/apply the returned candidate
to its draft, then separately approve the existing Task Save. See
`docs/liveui/task-result-proposals.md` for the app frames and lifecycle.

A new Task read from the owner's words (#7112, `ocuclaw.task.words.*`) rides the
same `task.proposal.llm.complete/cancel` method, call registry, purpose and
auxiliary task: to the parent it is one more Task setup call, so no parent
change or new method is needed. The relay requests at most 1200 tokens and 30
seconds. The call is tool-free and saves nothing; the phone fills its New Task
sheet from the answer and the owner still approves the existing Task Save.

Agent drafts ("New agent → Describe it") use `agent.draft.llm.complete/cancel`
with the same bounded completion and exact-call cancellation transport, their
own call registry and purpose `ocuclaw.agent.draft`, and no auxiliary task: the
call runs on the host's main model. The relay requests at most 900 tokens and
60 seconds. Calls are tool-free and create nothing; the app shows the returned
name, two alternative names and instructions, and creates the agent only through
the existing agent-create lane.

Program card frame step (card_frame.py). The shared Node runtime asks for a
card's frame art through child → parent RPC `program_card.frame.llm.complete`
`{messages,maxTokens?,temperature?,timeoutMs?,reasoning?,callId?}` →
`{text,model?,provider?,imageModel?,usage?,stopReason?}` or `{error,failure?}`,
the review lane's shapes and transport. The reply is one ```` ```js ```` code
block; the call is tool-free. It has its own call registry, purpose
`ocuclaw.card.frame`, and optional auxiliary task `ocuclaw_card_frame`
("OcuClaw card frame art", defaults `timeout` 300 s, `no_progress_timeout`
300 s and `reasoning_effort` medium, no `inherit_from`), so a model pinned under
`auxiliary.ocuclaw_card_frame` writes the art; with no pick, or on a host without
`register_auxiliary_task`, it runs on the main model. `reasoning` is the call's
effort (`minimal`, `low`, `medium` or `high`; the wearer's frame detail, and
`minimal`/`low` for the idea and paint-world calls). `ctx.llm` takes no effort
per call, so the parent runs `low`/`minimal` on `ocuclaw_card_frame_quick`
("OcuClaw card frame art (Quick)", `reasoning_effort` low) and `high` on
`ocuclaw_card_frame_detailed` ("OcuClaw card frame art (Detailed)",
`reasoning_effort` high, `timeout` and `no_progress_timeout` 420 s); both
`inherit_from` `ocuclaw_card_frame`, so they follow its model pick, and are
registered only on a host that takes `defaults` and `inherit_from`. Any other
effort, or a level whose task is not registered, runs on `ocuclaw_card_frame`.
No model or provider override is sent. The parent
takes at most 4 text-only system/user messages and 40000 characters across them
(no image parts), clamps `maxTokens` to 16000 (the art script is 5-10 KB of JS
after 2-5k reasoning tokens; the review lane keeps 8000) and the deadline to
420 s (a Detailed frame; the review lane keeps 300 s). The Node link waits for
the deadline plus 2 s and sends only those four efforts. A cut-off reply is marked
only by `stopReason: "length"` where the host reports a finish reason; Hermes
0.22.5's `ctx.llm` result reports none, and its OpenAI and Codex routes do not
forward `max_tokens`, so on those routes the provider's own output limit bounds
the reply and the caller should treat a missing closing fence as cut off.
`program_card.frame.llm.cancel` `{callId}` → `{cancelled:boolean}` cancels only
that pending frame call. An older parent answers method-not-found.

Painted game frames (#7160) are gone: game frames are drawn by script only. The
parent no longer answers `program_card.frame.image.ready`, `.paint` or `.read`;
a Node runtime from before the removal that asks hears method-not-found and draws
the frame by script, as it did on a parent from before the methods.

Saved-card icon pick (card_icon.py). For a wearer without Jev, the shared Node
runtime asks the host model which Library icon names a saved card through
child → parent RPC `program_card.icon.llm.complete`
`{messages,maxTokens?,temperature?,timeoutMs?,callId?}` →
`{text,model?,provider?,usage?,stopReason?}` or `{error,failure?}`, the review
lane's shapes and transport. The messages are exactly one system message (the
icon list) and one user message (the card's name and description); the reply is
one icon id or `none`, and the call is tool-free. It has its own call registry,
purpose `ocuclaw.card.icon`, and optional auxiliary task `ocuclaw_card_icon`
("OcuClaw card icon", default `timeout` 20 s, `inherit_from: title_generation`),
so by default it follows the session-title model and an operator can pin
another under `auxiliary.ocuclaw_card_icon`; on a host without
`register_auxiliary_task` it runs on the main model. No model or provider
override is sent. The parent takes at most 12000 characters across the two
messages and clamps `maxTokens` to 1000. `program_card.icon.llm.cancel`
`{callId}` → `{cancelled:boolean}` cancels only that pending call. An older
parent answers method-not-found, and the child keeps the keyword icon.

Review failures may additionally carry `failure={kind,origin,retryable,retryAtMs?}`.
Kinds are `rate_limited`, `overloaded`, `auth_required`, `quota_exhausted`,
`timeout`, `cancelled`, `local_busy`, `lab_budget_exhausted`, and `unknown`.
Origin is `provider`, `native`, `relay`, `lab`, or `unknown`; a bare HTTP 429
does not prove provider attribution. Only allowlisted metadata crosses this
boundary, never exception messages, response bodies or arbitrary headers.
`retryAtMs` is a validated absolute timestamp derived from Retry-After or reset
metadata; missing/invalid reset data gets bounded local backoff in the reviewer.
Old peers retain the existing `error` string fallback. The review and each failed
idea include sanitized `failure`; review replies may include `retryAtMs` plus
`serverNowMs` so the phone can show the remaining delay despite clock offset.

The shared gate covers the host's default review route, across cards and phones,
including Retry, Again and new stage calls, and survives process restart. It never
queues an automatic call. An elapsed cooldown only enables another manual action.
An existing call can finish while the gate is active. Original stage/operation
deadlines and cancellation fences remain authoritative. A terminal review keeps
failed explanation identities after outlining, including an all-failed review;
individual Retry can recover these without regenerating the outline. A first
successful retry changes that failed review to a partial `done` review.

MCP in program cards (card_mcp.py; reads, and writes since #6111). The shared
Node engine owns the gate, the wearer's yes, the write grants and per-send
prompt, the limits and `pick`; the parent only lists and calls, through
Hermes's own MCP client, so no token, URL or second connection is made. Three
child → parent RPCs:

- `program_card.mcp.list` `{}` → `{ok:true, writes:true, servers:[{name,
  connected, granted?, writes?, reason?, fix?, tools:[{name, description,
  inputSchema, annotations}]}]}` or `{ok:false,
  reason}` (`unsupported`, `failed`, `no_servers`). One row per enabled server
  in `mcp_servers` (at most 32, sorted). `connected` is whether Hermes's MCP
  client has a live session for it. `granted` is whether the server is in
  `plugins.entries.ocuclaw.mcp_allowlist` (left out when that is unreadable);
  the engine reads a card switch without the grant as off. `tools` are the
  tools that client knows for
  it (at most 200), after the server's own `tools.include`/`tools.exclude`.
  `annotations` carries `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` as booleans when known; `readOnlyHint` is true only when the
  server marks the tool read-only and Hermes recorded it so at discovery (its
  own trust gate's fact). Descriptions are one line of at most 300 characters;
  a schema over 16 KB as compact JSON (as the engine measures it), or past a
  640 KB listing budget, goes out as `null`.
  Hermes has no public listing API, so this reads its MCP client's state
  (`tools.mcp_tool` ledgers) behind a feature check, not a version pin: any
  missing piece answers `unsupported` and logs one warning. Top-level
  `writes: true` says this parent runs a card's granted write; a parent before
  #6111 leaves it out and the engine answers every write and
  `request_card_mcp_write` with `off`. A server whose `trust` is not `full`
  (Hermes would ask its own approval before a write tool) or that declares
  `tool_costs` or `spend_limit` (Hermes would ask past the budget) lists
  `writes: false, reason: "host_blocked"` and a one-line `fix` for the owner:
  its reads still work, its writes are refused.
- `program_card.mcp.call` `{server, tool, args, timeoutMs, write?,
  ownerWrite?}` → `{ok:true,
  structured?, text?, isError?, truncated?}` or `{ok:false, code}`
  (`not_allowed`, `timeout`, `busy`, `failed`). The documented `ctx.call_mcp`
  runs on the parent's own 4-thread pool with the call's deadline (1–30 s;
  default 10 s), answered at most 1 s after it. Its envelope maps as:
  `structuredContent` → `structured`; `result` text → `text` (a `result` that
  is the structured content itself → `structured`); `{ok:false}` → `isError`,
  except a TimeoutError → `timeout`; a result over 64 KB → `truncated` with no
  payload. A server missing from `plugins.entries.ocuclaw.mcp_allowlist`
  (PermissionError) → `not_allowed`. A call without `write: true` is a read:
  so is a tool the listing would not offer as
  a read (read-only by both facts above, not destructive, inside the server's
  filter), and one the owner marked "Treat as a write" (`ownerWrite: true`).
  `write: true` is a write the engine already checked (grant, gesture, prompt
  or auto-send, caps; the engine sends a 15 s deadline): the parent still
  refuses (`not_allowed`) a tool outside the server's filter or unknown to the
  client, a `destructiveHint` tool, and a `host_blocked` server. A write runs
  once. Hermes's client (checked at v2026.9.21, v0.22.5 and main) never replays
  a call that may have reached the server: a session expiry or a stdio child
  that died mid-call answers "outcome uncertain"; it retries only a 401 or a
  child that was dead before dispatch. A timed-out write reads `timeout`, which
  the engine records as `unknown` ("may have sent"). A malformed request, no `ctx.call_mcp`, or any other failure →
  `failed`; more than 16 calls at once → `busy`. Arguments and results are
  never logged.
- `program_card.mcp.allow` `{server, allow}` → `{ok:true}` or `{ok:false,
  code}` (`invalid`, `busy`, `failed`, `profile_unavailable`,
  `primary_runtime_required`). The owner's per-server switch adds the server to,
  or takes it off, `plugins.entries.ocuclaw.mcp_allowlist` in the Primary
  Runtime's config.yaml, the way `input.prediction.model.allow` writes its
  policy: the raw document under the optional-setup lock, every other key and
  entry kept, saved without default stripping, read back. Idempotent; an
  unchanged list writes nothing. `ctx.call_mcp` reads the list on every call, so
  no restart is needed.

Main profile only: under a profile multiplexer the listing and calls resolve
servers in the gateway's current scope, so another profile's servers are a
known gap. A lazy (`lazy: true`) server that has not started yet reads
`connected:false` with no tools. An older parent answers method-not-found;
the child reads that as `unsupported` and cards read nothing.

Waiting on you (#4979, human_input_waiting.py). Where the host's hook
vocabulary has both `on_human_input_request` and `on_human_input_resolved`
(0.21.6+), the parent registers them as observers and advertises feature token
`human_input_waiting`. They fire for every prompt that blocks an agent on a
person: kind `approval`, `clarify` or `sudo`. OcuClaw chats are skipped (they
keep their own cards). Both hooks run on the blocked agent thread, so they only
copy fields and arm a timer; every Hermes read happens on the timer thread.

- Surface: a messaging chat uses the hook's `platform` (`discord`, ...). A
  local or other non-messaging platform (local turns report `platform="local"`)
  uses the session row's `source`, read by `session_id`: `desktop`, `tui`,
  `cli` (`oneshot` reads as `cli`). The title comes from the same row.
- The wearer's switches apply before the grace timer: a muted surface sends
  nothing. A wait shows after a 15 s grace; one resolved inside it sends
  nothing. A TTL backstop drops a wait whose resolve never came, at the
  prompt's timeout plus 60 s (approvals: `approvals.timeout`, default 300 s;
  clarify: `clarify.timeout` or `agent.clarify_timeout`, default 3600 s,
  unlimited capped at 24 h; sudo: 120 s).
- At grace time the parent reads the pending entry for choices: approvals
  through `tools.approval.list_gateway_approvals(session_key)`, questions
  through `tools.clarify_gateway.get_pending_for_session(session_key,
  include_choice_prompts=True)`. The hook `request_id` is not stored on either
  entry, so the match is by content: the approval whose command matches the
  hook's prompt, else the oldest one no other open wait took; the session's
  oldest pending question (one agent thread asks one question at a time).

Each visible change sends backend event `waiting`:

```json
{"items":[{"requestId":"…","kind":"approval","surface":"desktop",
  "sessionTitle":"…"|null,"preview":"…","startedAtMs":0,"timeoutAtMs":0,
  "answerable":false,"choices":["once","session","deny"],"multiSelect":false}],
 "cleared":{"requestId":"…","outcome":"once"}}
```

`items` is always the full list of shown waits, oldest first (`[]` when none).
`preview` is the hook's redacted prompt on one line, at most 240 chars.
`cleared` rides only the snapshot caused by a shown wait ending; its `outcome`
is the hook's, or `expired` for the TTL backstop. `choices`/`multiSelect` are
omitted when there are none (sudo, or no pending entry found). A clarify raised
in a turn that used the bot's screen carries `botScreen:true` (#5151), else no
`botScreen`. Approval choices
are Hermes' words, filtered by `allow_session`/`allow_permanent`/
`smart_denied`. `answerable` = answer setting on AND the pending entry was
found (answer it with `waiting.answer`, below). A sudo wait's pending entry is
the gateway's open viewer password prompt (`gateway.session_sudo_prompt`, which
only Desktop and TUI turns open): the wait is answerable only while its session
has exactly one open prompt that no other wait took. An item whose
session row was read also carries `session`
`{id,sessionKey:native|null,source,lineageRootId}` (#4981), the same fields as
a session-list row. It is for the relay only: the relay derives the chat's
public key with `deriveHermesPublicKey` (the session list's rule) and sends the
app `sessionKey` (on 0.22.1 a local chat reads `hermes:main:x:local:dm:local-<id>`,
because its row's native key is platform-shaped) instead, never `session`, so
the glasses picker can mark that row. The relay broadcasts it to every client as frame
`ocuclaw.waiting` `{type,items,cleared?}`, keeps the last `items`, and sends a
connecting client one `{type,items}` when that list is non-empty.

Explanations (#4985). While the wearer's "Explain commands" setting is on
(`approval.explain.setting`, the same switch as the OcuClaw approval card), an
approval item also carries a relay-only `explain` block:

```json
{"explain":{"command":"…","description":"…","userMessage":"…"}}
```

`command` is the hook's redacted prompt whole (line breaks kept, unlike
`preview`); a command over 2000 chars is not sent. `description` is Hermes'
description of the matched pending entry (its risk labels joined with "; "),
at most 500 chars, when there is one. `userMessage` is the chat's newest active
user message (one indexed read of the transcript's last 24 rows through
`SessionDB.get_messages(latest=True)`), tail-clipped to 600 chars, for local
chats only (`desktop`, `tui`, `cli`): in a messaging chat the last sender may
not be the wearer, and the explainer trusts this text as the wearer's. The
parent re-sends the list when the setting changes it. The relay never forwards
`explain` to the app. For each approval it has not seen, it runs the shared
explainer once (`approval.llm.complete`, so the parent's "OcuClaw approval
explainer" task) with `command`, `description` as `warningLines`, and
`userMessage`, and sends every client frame
`ocuclaw.waiting.explanation` `{type,requestId,state:"pending"|"done",sentence?}`:
`pending` when the model call starts, `done` with the sentence, or `done`
without one when none came after a `pending`. Nothing is sent while the
setting is off, and nothing for a `requestId` no longer in the latest list (a
late sentence is dropped). A connecting client gets, after the list, each open
approval's `pending` or `done`-with-sentence frame.

Child → parent RPC `waiting.settings` `{show,answer,surfaces:{name:bool}}` →
`{ok,supported,availableSurfaces}` carries the stored `waitingOnYou` setting.
`surfaces` holds explicit choices only (names `^[a-z0-9_-]{1,32}$`, at most
32); a missing surface follows the default: `desktop`, `tui`, `cli` on, every
other surface off. Defaults (`show` on, `answer` off) apply until the first
push. `supported` says both hooks are registered on this host.
`availableSurfaces` lists the messaging platforms whose gateway adapters are
live in this process (`GatewayRunner.adapters`, sorted), without non-messaging
lanes (`api_server`, `webhook`, `local`, ...) or `ocuclaw`. The child pushes it
at relay start and on each change; the parent then re-sends `waiting` when the
visible list changed or is non-empty, so a restarted relay gets the open waits
back. An older parent answers method-not-found and the child reads
`supported:false`.

Child → parent RPC `waiting.answer` (#4983) answers one shown wait from the
glasses:

```json
{"requestId":"…","choice":"once"|"session"|"always"|"deny","reason":"…"}
{"requestId":"…","answer":"<label>"}
```

`requestId` is the item's. Approvals send `choice` (Hermes' words; it must be
one of the item's `choices`); `reason` is optional, kept only with `deny`,
trimmed to 500 chars. Clarify sends `answer`: one choice label, or for
multi-select a JSON-array string of labels (the `clarify.resolve` shape). Sudo
sends `answer`: the password exactly as typed, never trimmed; blank is
`bad_request`. The result is always a dict, never an error, for a refusal:

```json
{"requestId":"…","status":"answered"|"already_answered"|"refused",
 "reason":"answer_off"|"not_answerable"|"choice_not_allowed"|
          "bad_request"|"unsupported"|"unavailable",
 "kind":"approval"|"clarify"|"sudo","choice":"once"}
```

`reason` rides only `refused`; `kind` whenever the wait is known; `choice`
only on an answered approval. Checks, in order: no `requestId` → `bad_request`;
answer setting off → `answer_off`; no open wait with that id (it already
resolved) → `already_answered`; not shown, its surface muted,
or no pending entry found → `not_answerable` (a sudo with no open viewer
prompt included; before this release sudo was always refused as `sudo`); a missing `choice`/`answer` →
`bad_request`; a choice outside `choices` → `choice_not_allowed`. An approval
then re-reads `list_gateway_approvals(session_key)`: its entry gone →
`already_answered`. It resolves with
`resolve_gateway_approval(session_key, choice, reason=…, request_id=<entry id>)`,
never the session's FIFO head: a Hermes whose resolver takes no `request_id`
(probed once with `inspect.signature`) → `unsupported`; a 0 return →
`already_answered`. A question resolves with
`resolve_gateway_clarify(<clarify id>, answer)`; False → `already_answered`.
A sudo re-reads the session's open viewer prompt (gone or changed →
`already_answered`) and settles it with `session_sudo_prompt.resolve({"id":
<prompt id>, "result": {"value": answer}})`; False → `already_answered`, an
exception → `unavailable`. It then publishes `request.cancel` with reason
`resolved` to the session's viewers so Desktop or the TUI withdraws its own
password card. The password is never logged, stored, or sent anywhere else.
Each answer logs one INFO line, `approved from glasses` or `answered from
glasses`, with surface, chat title, kind and choice (never the prompt or the
answer). The list updates from Hermes' own resolved hook. There is no profile
check: Hermes session rows carry no profile and both queues are process-wide,
keyed by session key and entry id; `profile_mismatch` is reserved.

Hermes `clarify` requests use the shared adaptive glasses Question surface.
The parent emits backend event `clarify` with
`{id,sessionKey,question,choices,multiSelect,allowOther,deadlineSec,expiresAtMs,botScreen?}`
(`botScreen:true` only for a screen ask, #5151: see "Bot Screen lane"). Pretext
chooses a compact checklist, packed pages, or a single-item reel once when the
prompt arrives. Single choices resolve as their label; multi-select choices
resolve as a JSON-array string through child → parent RPC `clarify.resolve`.
Open questions and `Other` use request-addressed `clarify.await_text`, which
calls `mark_awaiting_text(id)` so the next voice/text message answers that exact
pending request. Dismissal and expiry send no answer.

OcuClaw-owned rows in `db.sessions.list` additionally carry
`agentStatus:{working,needsYou,failed,observedAtMs,unknown?,facePhase?,facePhaseObservedAtMs?}` and an internal
`attention:{sessionKey,runActive,clarify,approvals}` snapshot. These are read-only
observations: working comes from the adapter's dispatch ledger, pending questions
from the stock public `get_pending_for_session` API, and approvals from the
adapter's existing native approval mirror. A set native response event clears
attention immediately, even before the waiting tool removes its entry. Observer
failures report `unknown:true` without failing the native list or changing a turn.
Foreign transcript rows do not receive an OcuClaw live-status claim.

Optional `facePhase` is `thinking` or `working`, observed from actual reasoning, tool, or reply events for that session’s current ledger turn. Generic lifecycle/queued activity does not establish thinking. `facePhaseObservedAtMs` is the original event time: refreshing the session list never renews it. Phase observations expire after 15 seconds, are withheld while blocked or awaiting approval, and cannot cross runs or sessions. Terminal and superseded runs cannot revive a face through delayed events. Older clients ignore these fields; older hosts retain work/idle fallback.

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
accepted with `aborted:false`. Acceptance means the cooperative native
interrupt was requested; it does not certify that model generation has ended.
The adapter seals delivery for the cancelled processing records before the
interrupt: copied task/executor contexts retain the original record, so late
stream edits and fallback final sends cannot escape as uncorrelated output or
attach to a successor turn. A separate origin/cron delivery without that
processing context remains deliverable.

The downstream `ocuclaw.session.abort.ack` preserves the originating
`requestId` and public `sessionKey`, status, optional `aborted` and
`abortedRunId`, and any error/errorCode. Clients correlate receipts to their
pending request and current session. `accepted` is shown as a stop request,
`aborted` as a completed stop, and `no-active-run`/`aborted:false` as no active
turn. Disconnected stops are not queued for later replay; missing receipts
time out without claiming the turn stopped.

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

Hermes keys its cached agent on `channel_prompt` and renders it into the
system prompt, so the child keeps it byte-stable per session. An Even AI turn
never carries its owner text here: in Active routing it resends the OcuClaw
session's frozen Channel-1 bytes (`promptOwner: even-ai`,
`promptLane: logical-session-frozen`), and a background turn sends none. The
owner text rides `liveui.prompt` as the `even_ai_owner` fragment on the user
message instead.

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
  queue — they cancel-close). The commands hermes answers INLINE on a busy
  session without touching the running turn — `/steer` (`/s`), `/queue`
  (`/q`) and `/btw` (#5150, the Bot Screen's voice) — mark that record
  `inline_reply`: the dispatch's `handle_message` await carries it in the
  delivery context, so their one reply (sent inside that await) closes the
  record where it waits (terminal activity) and goes out as its own
  uncorrelated `message`, never into the running head's open message, and
  the record never promotes into a phantom turn. `/btw`'s later answer, sent
  from a task that copied the context, finds it closed and is uncorrelated
  too. If hermes runs the command as a turn after all (`on_processing_start`
  for it), the mark clears and its sends are that turn's. Steer is never
  assumed for a plain text dispatch: absorption is
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
- **Viewer turns (Hermes 0.22.3+):** a prompt typed in Hermes Desktop or the
  TUI on a glasses chat runs as a bare `MessageEvent` (no dispatch, no channel
  prompt, no `on_processing_*`), marked by Hermes's `viewer_turn` context
  variable. `pre_llm_call` sees the marker and, before asking the relay for
  its context: emits the prompt as a `message` user row
  `{sessionIdentity, role:"user", author:"Desktop", origin:"desktop",
  content, id}` with NO runId (a runId'd commit is a turn boundary on the
  consumer, which renders the row "• Desktop: …"); opens an `active` record
  (`runId: viewer-<hex>`, `viewer_turn`) only when the session has no open
  record; and emits its lifecycle start. The reply's sends then stream and
  commit under that record, and `on_session_end` closes it like any turn. A
  viewer record never feeds the first-run phone-turn candidate.
  `liveui.prompt` gets `viewerTurn:true`: the relay adds a one-line glasses
  notice (fragment kind `viewer_turn`) and takes neither the queued prompt
  ownership ticket nor a pending surface decision, which belong to a glasses
  send. Hosts without the marker (0.22.1) keep the old path: the reply arrives
  uncorrelated and the prompt is not shown.
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
- Streaming is config-gated in hermes per platform
  (`display.platforms.ocuclaw.streaming`, default false; transport `auto` →
  edit path for ocuclaw). Hermes 0.21.5 reads that per-platform key per turn;
  `display.streaming` (no `platforms.<name>` segment) is a DIFFERENT,
  CLI-only key and does not gate this path. With streaming off, replies
  arrive as one `send` and commit at `on_session_end` — both modes are
  handled.

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
`agent_end` consumers subscribe to. All four are wired: liveui finalize in the
LiveUI bridge (`hermes-liveui-bridge.ts`), the session-title distiller where
the relay owns it, and the device-info and location drains in the phone-tools
bridge (`hermes-phone-tools-bridge.ts`, see **Phone tools lane** below).
`ctx.sessionKey` may be an
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
`interim_hook,stream_hooks,session_read_state,human_input_waiting` — in the Node child's
environment. A token means "this adapter build ACTUALLY REGISTERED the
producing hook, OR will serve the advertised lane, on THIS host", not "the
host could support it": a client row that reads active for a hook nobody
registered is a claim the wearer cannot check. `interim_hook`,
`stream_hooks` and `human_input_waiting` (both `on_human_input_*` hooks,
0.21.6+) are the hook kind; `session_read_state` is the lane kind — it
registers nothing and is feature-detected from the running hermes's sessions
schema + `SessionDB` primitives (see "Session read/hidden state"). On a
0.20.0 host the value is empty. `_setup_status()` reports `hermesHooks`
`{interimMessageAvailable, streamHooksAvailable, auxiliaryCallHooksAvailable,
postCompactionHookAvailable, sessionDeleteHookAvailable, streamReasoningDeltas,
streamReasoningDeltasOffer,
registered[]}` plus the
SIBLING key `sessionReadState` (not a hook, so not a member of `hermesHooks`)
so an inactive row is explainable from one receipt.

The run-signal hooks (`pre_api_request`, `subagent_start`/`subagent_stop`,
`pre_auxiliary_call`/`post_auxiliary_call`) are probed the same way, against
`VALID_HOOKS`, and a pair is registered whole or not at all. They add no
token: see "Run signals (`runSignal`)". `post_compaction` (0.22.3+) is probed
the same way and adds no token either; `compactionInfo`'s `live` says it is
wired, and `_setup_status()` reports `hermesHooks.postCompactionHookAvailable`.
See "Compaction counts (`sessionCompacted`)". `on_session_delete` (0.22.3+) is
probed the same way and adds no token either: see "Sessions gone
(`sessionsGone`)".

## Liveui lane (W12 — LiveUI tool glue)

Each LiveUI tool is registered by the Python parent only after the child
advertises its descriptor in `link.hello.payload.liveui.tools[]`. Python never
hand-copies the JSON Schema; it passes the child-provided schema to
`ctx.register_tool`. `compose_glasses_ui` is the only model render tool:
LiveUI V1's `render_glasses_ui` tool is retired, no longer advertised or
registered, and absent from `provides_tools`. Session identity is task-local:
`get_session_env("HERMES_SESSION_KEY")` supplies the session key for render
and prompt glue. The model never supplies a session-key argument. Python sees
the native Hermes key (`agent:<ns>:ocuclaw:dm:<chatId>`); the child converts it
to the public OcuClaw key (`hermes:<ns>:<chatId>`) before storing surfaces,
settling `agent_end`, or dispatching wake turns. `pre_llm_call` prompt glue is
scoped to native OcuClaw sessions only.

Parent → child RPCs:

| Method | Params | Result |
|---|---|---|
| `liveui.render` | `{callId, sessionKey, args, hostOriginated?}` | `{result, content:[{type:"text", text:<JSON result>}]}` — Node owns the per-call listen window and consumes Layer A `createGlassesUiToolHandler` unchanged. No model tool calls it since `render_glasses_ui` retired; its one caller is the gateway's managed first-run welcome, which sends `hostOriginated: true`. A call without that flag that would open a new surface in a session no app client is on is refused with `session_not_viewed` (#3209). |
| `liveui.compose` | `{callId, sessionKey, args}` | `{result, content:[{type:"text", text:<JSON result>}]}` — LiveUI V2 `compose_glasses_ui` (K6, K7). `args` is `{records?, validateOnly?, refresh?, inputs?}`: `refresh` (V1's recipe, interval, limits and `onError`, with `targets` mapping each input key to a JSON Pointer into the recipe output) and `inputs` (the typed `data` keys it fills) come together and attach a refresh to the painted surface, or with no `records` to the composed surface on top (slice 12, T7, T9); inputs nested inside `refresh` are moved up and reported as an `inputs_moved` repair. It is the only model render tool. Hermes registers one schema per tool name for the whole process, so it is registered once for every session, and every session is V2. Only a call that reaches the child with no session key gets `{status:"refused", code:"not_a_v2_session"}`. A session's records go through the relay's own fold, compile and repair, as inline records do, and paint when the call lands; the result is `{status:"painted"|"valid"|"not_painted"|"attached", mode, frame, placed, repairs, drops, surfaceId?, reason?, refresh?:{status:"started"|"held"|"refused"|"valid", code?, host?}, inputs?}`. No listen window: Python waits the 10 s non-render link budget and sends no `liveui.abort`. Switched off by the owner, the child throws `liveui_disabled`, as `liveui.render` does. |
| `liveui.abort` | `{callId?, sessionKey?, reason?}` | `{status:"accepted", aborted}` — aborts matching active render calls; Python sends this when the Hermes tool worker sees the cooperative interrupt flag or the render link deadline fires. |
| `liveui.prompt` | `{sessionKey}` | `{context|null, fragments:[...], fragmentsConcatenated, ephemeralOnly:true, voicemailAckToken|null, feedbackAckToken|null, promptOwner:"ocuclaw"|"even-ai"|null, neuralSessionNamesEnabled:boolean}` — Node composes Channel-2 state and previews owed voicemail and render-refusal feedback into a plugin-generated JSON fence for Hermes `pre_llm_call`, which injects only into the current user message. A `reply_language` fragment (#4823) carries the app language of the OcuClaw send that queued this turn (`clientDisplaySignals.replyLanguage`, kept on that turn's ownership ticket); English adds it only once, when a chat comes back to it, and a turn without one (an older phone, a slash command, Even AI) gets none. `promptOwner` names the turn's prompt owner (dispatch rider or queued ownership ticket); Python marks an `"even-ai"` turn so `pre_tool_call` can veto `clarify` on it (#7). `neuralSessionNamesEnabled` is the phone's session-name toggle recorded at send (default `true`); when `false`, Python writes Hermes's instant first-message title at `llm` provenance so Hermes makes no title model call for that chat (see `session_title_hold.py`). |
| `liveui.promptAck` | `{sessionKey, ackToken?, feedbackAckToken?}` | `{status:"accepted", consumed:boolean, feedbackConsumed:boolean}` — Python sends each token returned by `liveui.prompt` (`voicemailAckToken` as `ackToken`, `feedbackAckToken` as itself) only after receiving a prompt context whose `fragments` lists that fragment (`voicemail`, `feedback`), so transport timeouts do not consume owed entries silently and ack cannot consume entries outside that preview. No owed fragment, no ack call. |

Child → parent RPCs:

| Method | Params | Result |
|---|---|---|
| `liveui.llmRecipe` | `{recipe, ctx}` | `{output}` or `{error}` — LLM refresh recipes execute through Hermes `ctx.llm`, so Node never receives raw provider credentials. |
| `liveui.llmAuth` | `{model}` | Compatibility-only `{status:"unavailable", provider:"hermes", model, apiKey:"", resolvedFromBackend:false}`; the accepted path is `liveui.llmRecipe`. |

## Phone tools lane (#2797 / #2800 — descriptors by data)

Where the liveui lane binds four hard-coded names to hard-coded link methods,
the phone-tool lane is registered from DATA. The child advertises a plain list
at `link.hello.payload.phoneTools[]`; each entry is

```
{ name, toolset: "ocuclaw", description,
  schema: { name, description, parameters },
  method: "tools.<x>", linkTimeoutMs?: number }
```

Singular `method` (a string), unlike liveui's `methods` map, because the Python
parent binds ONE generic forwarder per descriptor. It registers every
descriptor whose `name` is on its allow-list (`PHONE_TOOL_NAMES` in
`adapter.py`) and whose `schema` and `method` are usable; anything else is
skipped with one warning each and never breaks a sibling. Calling a registered
tool issues one request to the declared method with
`{sessionKey, params}` — `sessionKey` from `get_session_env("HERMES_SESSION_KEY")`,
`params` the model's arguments verbatim — and the child's JSON comes back as
the tool text. A child `{error, code}` dict is returned verbatim, never raised.
Without a parseable OcuClaw session key the tool fails closed and the link is
never touched. `linkTimeoutMs` is the CHILD's budget (ADR-0006: the child owns
the wait); the parent waits that plus a margin, and 15 s when it is absent.

### The descriptors

The list carries eleven entries, built by
`PHONE_TOOL_DESCRIPTOR_BUILDERS` in `hermes-phone-tools-bridge.ts` and
serialised by `buildHermesPhoneToolsHelloPayload()`. Hello order is
registration order, and it is APPEND only: the adapter keys registered tools by
method name, so reordering or renaming one is a wire break.

| Tool name | Link method | `linkTimeoutMs` |
|---|---|---|
| `get_current_location` | `tools.getCurrentLocation` | 10 000 |
| `get_evenrealities_device_info` | `tools.getDeviceInfo` | 10 000 |
| `set_session_title` | `tools.setSessionTitle` | absent |
| `write_glasses_card` | `tools.writeGlassesCard` | 15 000 |
| `save_glasses_card` | `tools.saveGlassesCard` | 10 000 |
| `ask_glasses_card` | `tools.askGlassesCard` | 60 000 |
| `glasses_card_command` | `tools.glassesCardCommand` | 15 000 |
| `edit_glasses_card` | `tools.editGlassesCard` | 15 000 |
| `look_glasses_card` | `tools.lookGlassesCard` | 25 000 |
| `glasses_card_draft` | `tools.glassesCardDraft` | 209 000 |
| `request_card_mcp_write` | `tools.requestCardMcpWrite` | 72 000 |
| `request_host_command` | `tools.requestHostCommand` | 67 000 |
| `request_card_setup` | `tools.requestCardSetup` | 225 000 |
| `get_ocuclaw_settings` | `tools.getPhoneSettings` | 5 000 |
| `set_ocuclaw_setting` | `tools.setPhoneSetting` | 65 000 |
| `show_bot_screen` | `tools.showBotScreen` | 50 000 |

Location and device info declare 10 000 ms; the adapter then waits
that plus its margin, 15 s in practice. The split is deliberate: the child's
own deadline always fires first, so on silence the agent reads the handler's
`location_timeout` or `device_info_timeout` rather than a bare link timeout
that says nothing about which leg was slow. `set_session_title` declares no
`linkTimeoutMs` because it makes no phone round trip. It is a short in-process
RPC into the relay, so the adapter's 15 s default is the only deadline it needs.

Name, description and JSON Schema for each descriptor are single-sourced from
the same constants the OpenClaw registration hands `api.registerTool`. The
agent therefore reads one tool on both hosts, and the Python parent never
hand-copies a schema.

Card studio speech (#6881) is add-only on this list. `ask_glasses_card` takes an optional `say`
(2 to 3 sentences on how the agent will build the card, each starting with its action since
2026-11-13), and the ask shape in the
turn's program-card prompt (`PROGRAM_CARD_ASK_SHAPE_FOR_HERMES`) shows it in its example
arguments. `write_glasses_card`, `edit_glasses_card` and `look_glasses_card` take an optional
first `speck` string (about 50 characters) that the handler takes before it validates the call
and hands to the build's speech (`noteSpeck`); the phone's card never sees it. An older adapter
forwards both as ordinary arguments, and an older plugin's schema simply lacks them.

Changing a saved card (#6888) is add-only on this list too. `ask_glasses_card` takes an optional
`savedCard` (the saved card's name or id), named apart from the answer's `change` (the wearer's
change words). A clear name asks to change that card, and the yes opens it as a draft whose
hand-off rides the answer as `cardChange`; an unclear name answers `which_card` (or
`no_saved_card`) with `matches` and shows nothing. The ask shape in the turn's program-card prompt
says how to name the card. An older adapter forwards `savedCard` as an ordinary argument, and an
older plugin's schema simply lacks it. The `cardChange` hand-off may carry `firstSaved`, the
1-based number of its first saved ask in `lines`, and `edit_glasses_card` takes an optional
`replaces` (those line numbers the change replaces) that the handler takes before it validates.
At Done the relay sends the phones `ocuclaw.program_card.change.saved` (`appId`, `draftId`,
`revision`, `name`, `sourceHash`); an older phone ignores the type.

"Ask my agent" (#7187) is add-only as well. A phone send may carry `cardCheck: {appId}`, naming
the saved card the wearer asked about and nothing about the fault. The relay gives it to the turn
that send starts: the send's ownership ticket carries the ask, and the `liveui.prompt` that takes
that ticket reads it, once (never a viewer turn, and never an Even AI turn). A refused send, a
chat reset or the chat's next send drops it, and it lapses after a minute with no turn. A build
that takes the ask's ticket without being its turn (a turn the host started between the send and
its own build) reads the ask in its place, as it would that send's reply language. That one
`liveui.prompt` adds a `program_card_check_ask` fragment: the host's own Card check for that card,
codes, names and times only. A relay that does not read `cardCheck` takes a plain send,
and an older adapter passes the fragment through as it does any other.

### Session-key discipline

The adapter forwards the NATIVE Hermes key it read from
`get_session_env("HERMES_SESSION_KEY")`, which has the shape
`agent:<ns>:ocuclaw:dm:<chatId>`. `resolvePhoneToolSessionKey` in the bridge
normalises that to the MINTED public OcuClaw key `hermes:<ns>:<chatId>` and
only then calls the handler. Everything else is refused with
`requires_hermes_session_key` before the link is touched: an empty or
whitespace key, a colon-free opaque key such as `main` (the LiveUI normaliser
would happily mint one, which is exactly why this gate rejects it first), a
foreign public key from a Desktop, Telegram or CLI-routed turn, and any key
that normalises to something other than a minted OcuClaw key. The gate fails
CLOSED by design. No location request is ever sent for a session the glasses
do not own.

### Errors are returned, never thrown

A link method that throws reaches the Python side as a bare `{error: message}`
and loses the machine-readable code, which is the part the agent must see
verbatim. So every phone-tool handler RETURNS `{error, code}` instead. The
codes are whatever the host-free handler in `src/tools/` produces, unchanged,
which is what makes "same answer as OpenClaw" true rather than aspirational.

| Tool | Codes (every tool also returns `requires_hermes_session_key` from the gate above) |
|---|---|
| `get_current_location` | `location_access_disabled`, `app_not_connected`, `location_timeout`, `location_unavailable`, `location_aborted` |
| `get_evenrealities_device_info` | `glasses_not_connected`, `device_info_timeout`, `device_unavailable`, `device_info_aborted` |
| `set_session_title` | `missing_field`, `invalid_type`, `title_empty`, `title_too_long`, `no_user_message_yet`, `no_active_session`, `session_not_renamable`, `session_title_unavailable` |
| `get_ocuclaw_settings` | `invalid_input`, `phone_not_connected`, `settings_timeout`, `settings_aborted` |
| `set_ocuclaw_setting` | `invalid_input`, `unknown_setting`, `invalid_value`, `declined`, `confirm_unavailable`, `confirm_timeout`, `not_available`, `phone_not_connected`, `settings_timeout`, `settings_aborted` |
| `show_bot_screen` | `invalid_input`, `memory`, `not_installed`, `no_screen`, `start_failed`, `start_unavailable`, `status_unknown`, `phone_not_connected`, `show_timeout`, `show_aborted` |

The first two differ on their not-connected code (`app_not_connected` against
`glasses_not_connected`) because their OpenClaw handlers do. The title guard
matrix is OpenClaw parity too: the same four validation codes, the same
`no_user_message_yet` refusal when nothing proves the wearer has spoken in the
session yet, and the same structural `no_active_session` and
`session_not_renamable` guards. A missing relay reader answers conservatively
rather than guessing, so an absent `hasRecordedUserMessage` yields
`no_user_message_yet` and not a title written into a silent session.

### The `agent_end` drain

Location and device info each hold pending in-flight requests, so both
subscribe to the host hook bus. On `agent_end` the bridge drains them with
`{ok: false, code: "location_aborted"}` and
`{ok: false, code: "device_info_aborted"}`, matching the OpenClaw plugin's own
abort codes. `set_session_title` keeps no pending state and therefore has no
drain and no `agent_end` subscription of its own.

### Parent → child RPCs

| Method | Params | Result |
|---|---|---|
| `tools.getCurrentLocation` | `{sessionKey, params}` | The location handler's JSON, or `{error, code}` returned verbatim. Handler budget 10 s. |
| `tools.getDeviceInfo` | `{sessionKey, params}` | The device-info handler's JSON, or `{error, code}` returned verbatim. Handler budget 10 s. |
| `tools.setSessionTitle` | `{sessionKey, params}` | `{status:"accepted"}`, the same body OpenClaw's `execute` returns, or `{error, code}`. The relay mirrors the title into the Hermes SessionDB and rebroadcasts the session list; this glue writes neither again. |
| `tools.glassesCardCommand` | `{sessionKey, params}` | OpenClaw's `glasses_card_command` body: `{ok, ...card}` after the press, or `{ok:false, error}` (`no_client`, `card_not_open`, `timeout`, `requires_hermes_session_key`, `even_ai_session`). A success carries no `error` key. Handler budget 15 s. |
| `tools.editGlassesCard` | `{sessionKey, params}` | OpenClaw's `edit_glasses_card` body, the same shape and codes as the command. The open card reaches the model through `liveui.prompt` as a `program_card_open` fragment. Handler budget 15 s. |
| `tools.lookGlassesCard` | `{sessionKey, params, modelInput?, model?}` | A headless test of the open card on a phone copy, bounded to 12 steps and six pictures. The child owns 25 s; the phone owns 10 s. `modelInput` and `model` come from observed host model context, never the model's tool arguments. Missing image capability fails closed to text with `pictures not delivered`. The shared runner/report/narration/receipt contract is in `../ocuclaw/PROTOCOL.md`. |
| `tools.requestCardMcpWrite` | `{sessionKey, params}` | OpenClaw's `request_card_mcp_write` body: `{answer, uses?, error?, reason?, fix?, next}` (`allowed`, `declined`, `no_answer`, `off`, `invalid`). The shared engine checks the uses against a fresh tool list and asks the wearer on the glasses; it answers `off` until the phone has `programCardsMcpWritesV1` and the parent lists `writes: true`. A foreign or missing session key answers `off` and shows nothing. |
| `tools.requestHostCommand` | `{sessionKey, params}` | OpenClaw's `request_host_command` body: `{answer, tool?, error?, next}` (`added`, `declined`, `no_answer`, `off`, `invalid`). The shared engine checks the command and asks the owner on the glasses or the phone. A foreign or missing session key answers `off` and shows nothing. |
| `tools.requestCardSetup` | `{sessionKey, params}` | OpenClaw's `request_card_setup` body (#7186): `{answer, server?, needs?, parts?, error?, next}` (`on`, `allowed`, `not_now`, `kept_off`, `no_answer`, `no_glasses`, `busy`, `needs_switch`, `nothing_waiting`, `no_card`, `declined`, `failed`, `invalid`). The shared engine shows one request on the glasses (Allow, Not now, Keep it off) for a card switch, a server's Use in cards, or the open card's waiting uses; nothing changes without the wearer's Allow, and a switch is then saved through `optional.setup` (`diagnostics.preview` then `diagnostics.apply`), the phone switch's own path. A foreign, missing or Even AI session key answers `no_answer` and shows nothing. |

For Look, the adapter observes the public `pre_api_request` provider/model and
fences it to the current session run. A missing route, a later run or a route
that Hermes does not send images to stays text-only. The child returns text
and PNG image blocks; the adapter preserves them in Hermes' native
`{_multimodal:true,content:[text,image_url...],text_summary}` envelope.
`text_summary` retains the measurements and problems and explicitly says
`pictures not delivered`, including when the engine selects that fallback.
Other phone tools retain their existing JSON text results. The Look bridge
checks the encoded result with 16 KiB of space reserved below the 1 MiB link
line cap, returning `look_payload_too_large` before history is echoed to the
phone or transport can truncate it. A refused result records undelivered
pictures in that history too.

Saved-card review uses the same optional Look report fields described in
`../ocuclaw/PROTOCOL.md`, including the optional original-write identity used to
bind stored asks to the actual reporting card and client. It adds no control-link
or saved-data field. The auxiliary model request preserves bounded text
and validated PNG image blocks as native message content. Review pictures
also require an exact provider/model/carrier pixel-canary certificate; tool
result delivery alone does not qualify this separate auxiliary carrier.
Without that certificate, or when Hermes selects its text route, the review
keeps its measured text report and records `visualReview: false` with the
reason pictures were not delivered.

The optional `programCardsLiveCaptureV1` capability enables SDK-accepted live
pictures and command captures through these same native multimodal envelopes.
They retain requested/current card, sequence and frame identities and explicit
partial/superseded/card_changed results. They do not count as a headless Look or
replace its test history. `pressing` detail names the declared command; older
phones continue to receive `checking`. The full capture contract is in
`../ocuclaw/PROTOCOL.md`.

The SessionDB half of that mirror depends on the host's session writer. Hermes
2026.9.7 (Hermes Agent 0.21.1, the certified pin) and newer accept the write
with user rank. Hermes 2026.8.31 (Hermes Agent 0.21.0, the previous certified
pin) has no `hermes_state_registry`, so it keeps
its own auto-title and only the phone's session picker shows the new name. That
limit predates this lane and applies to hand renames on that host too.

### Registration inventory

The adapter records per-name registration state in `_PHONE_TOOL_REGISTERED`,
and `provided_tool_inventory()` folds it together with the four LiveUI flags
and the setup tool's flag into the eight-name inventory that `/ocuclaw-setup`
reports under `status.tools` and `hermes ocuclaw status|doctor` prints as
**Provided Tools**. A hello with no `phoneTools` key at all leaves the three
names in `missing`, so version skew is visible as three named absences rather
than as a silently short tool list (#2804).

The inventory also carries `observed`. Registration state lives in the module
globals of the process that registered, which is the gateway. `hermes ocuclaw
status|doctor` runs in its own process, where plugin discovery imports the
adapter and binds the setup tool but no platform ever connects, so an
unguarded count there reads seven absences on a healthy host. `observed` is
true only when an adapter has connected in this process or a
runtime-advertised tool has actually registered in it. When it is false both
readers print the eight names and withhold the verdict instead of reporting
failures they did not witness, and `missing_phone_tool_warnings` returns
nothing. `/ocuclaw-setup`, which runs inside a gateway turn, is the surface
that carries the real count.

Wake remains a normal `dispatch.send` turn. The Node wake controller first
uses the relay-side busy mirror (`isAgentTurnBusy`). No Python private
session-store busy probe is part of the sanctioned policy; if the relay mirror
is stale, Hermes handles the visible command/turn through its own public
session semantics.

## Plugin-owned full uninstall

Hermes 0.20's generic plugin removal deletes only the installed checkout, so
full product removal runs through `hermes ocuclaw uninstall` while that code is
still available. A retained disabled install must first be enabled so Hermes
registers the plugin-owned CLI. The command requires OcuClaw not to be
running, removes only the exact OcuClaw config and secret keys, runtime files, pairing and first-run
receipts, setup bundle, and plugin checkout, then prints an uninstall receipt.
The shared Hermes session database and unrecognised files remain outside its
mutation set.

"Not running" replaced "gateway stopped" in #3765, because on Cloudways
`hermes gateway stop` restarts the container and the gateway is never
observed stopped. `uninstall_gate` proves it from the relay port (closed),
the process table (no `hermes-runtime-entry.cjs` under this profile's
plugin directory; `/proc` on Linux, psutil elsewhere), the platform entry
(not built by the live gateway) and the gateway itself (stopped, or started
after the uninstall-pending marker). When OcuClaw runs, the first call
writes `state/ocuclaw.uninstall-pending.json` and exits 3
(`restart_required`) with `hermes gateway restart` and
`hermes ocuclaw uninstall` as next steps. `adapter.register` checks that
marker first and registers only the CLI while it exists. The second call
passes the gate, runs the Cloudways rollback (watchdog job, daemon,
script, binaries, receipts, identity) while the daemon is still reachable,
then the removal below, and deletes the marker last. A stopped gateway
still finishes in one call. `hermes ocuclaw uninstall --cancel` deletes the
marker; one restart brings OcuClaw back.

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
| `taskOutput.snapshot` | `{jobIds: string[]}` (at most 8) | `ocuclaw.task-output-snapshot` v1 document (below) |

The Python parent runs the same collect → `derive_snapshot` seam as
`hermes ocuclaw status --json`. It never enters doctor, probes a route, mutates
host state, or changes admission. A failed derivation returns the versioned static
error document; the child never fabricates health. OpenClaw has no parent
method and attaches no `connection-health.json`.

`producer.hermesSource` has exactly three advisory states. `certified-source`
means package `0.23.2` and a complete clean checkout at the certified
`v0.23.2` commit; `drifted` means a complete inspectable checkout differs;
`unknown` covers shallow/non-Git installs, missing objects or package metadata,
timeouts, and any inspection ambiguity, including partial/promisor clones. The
observed/certified short commits, shallow result, and cache timestamp use the
existing additive `evidence[]` seam. No snapshot
or doctor exit code depends on provenance.

### Task output document (#6892, spec #6875 ruling #6596 r12)

The same report asks for the Task output of the Tasks the wearer used inside
its History window (up to 3), by their Hermes job ids:
`taskOutput.snapshot {jobIds}` answers

```json
{"contract": "ocuclaw.task-output-snapshot", "contractVersion": 1,
 "jobs": [{"jobId": "j1",
           "result": {"status": "failed", "headline": "…", "body": "…", "card": {…},
                      "createdAtMs": 1790000000000, "truncated": false},
           "cronLog": {"text": "…", "atMs": 1790000000000}}]}
```

One entry per safe, distinct job id asked (at most 8). `result` is the job's
newest kept Task Result (`task_results.py`), its body cut to its first 4,096
characters, or null. `cronLog` is the last 8 KB of the job's newest cron run
output file (`cron/output/<jobId>/`, never the page watch's
`monitor_last_output.txt`), only when that newest result is a failed run; else
null. Read-only (`task_output.py`): it acks nothing. Node redacts the body and
the log (the host-text redactor, then the report's code-safe secret pass) and
keeps 4 KB of the body before anything goes into the report. The OpenClaw lane
answers the same method in-process from its own Task Results, with no cron log.
An older parent answers method-not-found; Node then sends the report without
Task output (the run facts and Run Records still ride).

SECURITY-RULED (#6596): a Debug Report may hold, for the cards and Tasks the
wearer used inside the report's History window, … Task Run Records and Task
output (latest Task Result body up to 4 KB, redacted; Hermes cron log only for
a failed run, last 8 KB), only in a report the wearer chooses to send, only
after the code-safe secret pass, and only to the existing debug upload and
triage services. Nothing new listens or is reachable.

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
| `presence.snapshot` | none | `{relayListening, authenticatedAppCount, clientVersions[], lastTransitionAt, device:{connected,batteryPercent,charging,inCase,observedAt}, programCards}` — the narrow public-safe projection, built by the relay supervisor. Device facts come from the freshest authenticated app readiness snapshot; `charging` is explicit SDK truth or null. Wear, Ring1, client identity, and raw readiness never cross this seam. Debug clients never count. `programCards` is true while any connected app advertises `programCardsV1` (LiveUI > Settings > Staging), false when none does, and null when the relay cannot be asked. The parent keeps it out of the receipt and uses it only to show the five program card tools (`write_glasses_card`, `save_glasses_card`, `ask_glasses_card`, `glasses_card_command`, `edit_glasses_card`) to the model; null hides them. |

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

## Board moment lane (#3051 — watched-card moments to the phone)

The contract (envelope, attention classes, identities, store) is
`docs/hermes-board/contract.md` → "Moments (#3051)". This lane only carries
it. The parent tails the board read-only every 5 s, stores pending deliveries
with the cursor in one transaction, and pushes what is due. The phone acks
each delivery once its Board delivery state holds it.

Parent → child RPC:

| Method | Params | Result |
|---|---|---|
| `board.moment.push` | `{moments:[envelope, …]}` (≤20) | `{ok:true, sent:<frames sent to app clients>, refused:<envelopes Node's validator refused>}`, or `{ok:false, error:"invalid_params"}`. Each valid envelope goes to every connected app as `ocuclaw.board.moment`. A push is a doorbell: `sent:0` or a failed call leaves the delivery pending, and the parent pushes it again after 15 s. |

Child → parent RPC:

| Method | Params | Result |
|---|---|---|
| `board.moment.ack` | `{deliveryId, state:"durable"\|"volatile"}` (exact keys) | `{ok:true, known:<bool>}`; only a pending delivery settles, so a repeated or late ack changes nothing. `{ok:false, error:"invalid_params"\|"store_unavailable"}` otherwise. Node retries a failed forward (not `invalid_params`) in order, at most 256 queued. |

`board.moment.ack` is registered on the parent before `link.start()`, like
`presence.dirty`. The pump starts after the handshake and stops on
disconnect. It is idle while `passive_moments` is off.

#3052: a new pump (restart or reconnect) pushes every pending delivery on its
first tick. A push answered `sent:0` is due again on the next tick, not after
15 s. The pump serves under the link's relay credential (kept only as a
one-way digest); when that changes, deliveries the old pairing acked are
pending again. Unwatching cancels that watch's pending deliveries.
Contract: "Moments (#3051)" → "Robustness (#3052)".

## Bot Screen lane (#5146 — Hermes's Bot Screen, watch-only)

Hermes runs a Bot Screen per profile: Xvnc on
`<HERMES_HOME>/bot-desktop/rfb.sock` (mode 0600, no VNC password, shared).
The child reads that socket itself, as one more shared viewer
(`extensions/ocuclaw/src/tools/bot-screen/`). It never sends input, clipboard
or a size change: the RFB writer refuses every client message but
SetPixelFormat (0), SetEncodings (2) and FramebufferUpdateRequest (3). Control
is `lease.json` in the same folder, read by the child every 250 ms while a view
is open; Hermes's `on_change` is in-process only, so the file is the shared
truth. While a view is open on a running screen the child touches
`bot-desktop/activity` at most once a minute (Hermes's own bridge does the
same), and never after the last view closes.

`bot_screen.py` probes the bot-desktop internals (`tools.bot_desktop.lease`,
`.runtime`, `.thumbnail`). A missing or changed one turns that fact off: no
socket means "unsupported", no lease module means "control unknown". Nothing
starts, stops, installs or drives the screen.

Hello keys (`link.hello.ack` config, both absent on a Hermes without a Bot
Screen):

| Key | Value |
|---|---|
| `botScreenSocket` | The served profile's socket path, named even while the screen is off. |
| `botScreenProbe` | `{lease, status, snapshot, start}` booleans: which internals passed the probe. `start` (add-only, #7571 follow-up): Hermes has `runtime.start` and this parent answers `botScreen.start`; an older child ignores it, an older parent sends none. |

Child → parent RPC:

| Method | Params | Result |
|---|---|---|
| `botScreen.status` | `{}` | `{v:1, state, screen:{w,h}\|null, placement, running}`; `state` is `running`, `off`, `missing` (not installed, or placed in a terminal sandbox whose image lacks the desktop packages, #6019), `sandboxed` (placed in the terminal backend, no socket on this host), `unsupported` or `unknown` (`code:"status_failed"`). Optional `need` says why the gateway host can have no screen: `memory` (off, and Hermes's status carries a start `blocker`, its free-memory floor `bot_desktop.min_free_memory_mb`) or `host` (missing, and Hermes's `runtime.installable()` is false: unprivileged, no sudo); `host:"cloudways"` rides beside a `need` on a Cloudways host. Optional `rootless` (#7571) rides beside `need:"host"` only: `ready` (OcuClaw's no-admin install, `hermes ocuclaw bot-screen install`, can run on this Cloudways host) or `memory` (it could, but Hermes's own memory check would refuse to start the screen); `need` stays `host` so an older phone keeps its card. Only the word crosses, never Hermes's blocker sentence. Never the display, socket, pid, install command or browser path. |
| `botScreen.snapshot` | `{maxW, maxH, color?, profileId?}` (clamped to 16…720 × 16…450; with `color:true`, 16…512 × 16…320) | `{v:1, w, h, gray:<base64 8-bit grey>}`, plus `rgb:<base64 w×h×3 bytes, red, green, blue>` when `color:true` was asked (sent only while an open view's latest want asked for colour; Node treats a missing or wrong-length `rgb` as a grey-only picture), or `{v:1, gray:null, reason:"off"\|"grab_failed"\|"decode_failed"\|"unsupported"}`. Only for a `sandboxed` screen, on demand with a 100 ms start-to-start floor, one capture in flight, and a 1 s retry after failure. No capture queue. |
| `botScreen.start` | `{profileId?}` | #7571 follow-up: the wearer's Start button and `show_bot_screen`. Starts an installed gateway screen that is `off` with Hermes's own `tools.bot_desktop.runtime.start(wait_seconds=15)`, on a worker inside the admitted profile's runtime scope. `{v:1, ok:true, state:"running", already?:true}`, or `{v:1, ok:false, code, state}` with `code` one of `memory` (Hermes's free-memory floor; never lowered, and Hermes is not even asked when its status already names the blocker), `missing`, `unsupported`, `sandboxed` (a terminal-sandbox screen is never started here: its start may build a container), `unknown`, `start_failed` (Hermes tried; only the word crosses, never its sentence or launcher log), or `profile_unavailable`. Never installs, stops or drives the screen. Hermes's own `start.lock` keeps two starts to one launcher. |

Selected-profile routing (#5284): a new parent advertises `config.botScreenProfileRouting:true`
and registers `botScreen.route {profileId}`. It resolves the **admitted**, served profile
and returns `{v:1, profileId, socket, probe}` to the Node child only. Paths never reach
the phone. An unavailable, unenrolled or invalid profile returns
`{v:1, state:"unknown", gray:null, code:"profile_unavailable"}`; a missing runtime scope
returns `profile_scope_unavailable`. No fallback to default. `status` and `snapshot`
also accept `profileId` and execute in that profile's Hermes runtime/terminal scope;
admission is rechecked after capture. Omitting `profileId` preserves the old parent RPC.

The Node child resolves each phone's profile from **that client's selected session**,
never another client's active chat or a profile supplied in a screen message. It creates
an isolated source for that client, anchors all its RPCs to the profile and checks
`botScreen.route` again before each outbound batch. The default profile still owns
pairing, credentials and the relay. New screen replies carry `profileId` (`default`
for namespace `main`). A profile change sends `ocuclaw.botscreen.reset {v:1,profileId}`
before the new source's replies, disposes the old source and drops late async replies.
The app clears pixels, lease, targets, steps and pending point/voice review, and rejects
replies belonging to another profile. Unscoped legacy replies are accepted only for
default. Existing control is not released or transferred by changing the viewed agent.

The four backend hint events below also carry `profileId` from the tool's ambient
Hermes runtime. They go only to phones selecting that profile; an unscoped legacy
event belongs to default. This includes Peek even with no viewer open.

Parent → child events (`backend.event`, #5147, #5148, #5151):

| Name | Payload | Meaning |
|---|---|---|
| `botScreenTarget` | `{v:1, rect:[x,y,w,h], kind:"element"\|"point", at:<ms>}` | Where the bot's next `computer_use` pointer action (`click`, `double_click`, `right_click`, `middle_click`, `drag`, `scroll`, `set_value`) lands, in screen pixels, sent from `pre_tool_call` for any platform's turn. `element` is that element's bounds from the session's last capture; `point` is its `coordinate` as `[x,y,1,1]`; a drag names its destination. `post_tool_call` keeps a capture (JSON text, or the multimodal summary) only when it is the whole running screen at its own size with no `bounds_scale`; any other capture is forgotten. Cut to the screen; nothing is sent when the target does not resolve. Never a label, role or app name. |
| `botScreenStep` | `{v:1, tool:"computer_use", action, label?, app?, keys?, chars?, direction?:"up"\|"down"\|"left"\|"right", at:<ms>}` | What each `computer_use` call is about to do (#5148), for the Bot Screen view's caption, sent from `pre_tool_call` for any platform's turn, next to any target. `action` is one of the schema's 14 actions; any other call sends nothing. `label` is the element's label from the session's last kept capture: the element it names (a drag: `to_element`), or for a coordinate (a drag: `to_coordinate`) the smallest element whose bounds hold the point; one line, at most 60 characters, left out when unknown or empty. `app` is the call's own `app` (not `screen` or `desktop`), else that element's, else the capture's; at most 40 characters. `keys` (a `key` step) only for a named key (`return`, `escape`, `tab`, arrows, `f1`–`f24`, …) or a shortcut with a modifier other than shift, in `[A-Za-z0-9+_-]{1,32}`; a printable key, bare or with shift, is typing and sends `chars:1` instead. `chars` (a `type` step) counts the code points of `text`, never the text; a `set_value` step names its element, never the value. The kept capture now also holds each element's label and app and the capture's app (from the JSON's `app`/elements, or the summary's `app=` header and each element line's label repr and `[app]`), in memory only, never a role or window title; they reach only the phone's Bot Screen view. The `activity` lane's `args` for `computer_use` always carry `text` and `value` as `"[omitted]"`. |
| `botScreenElements` | `{v:1, elements:[{rect:[x,y,w,h], label?}], at:<wall ms>}` | The bot's last capture, for the glasses' head pointer to snap to (#5155), sent from `post_tool_call` right after the capture is kept or forgotten, for any platform's turn. Only for a `computer_use` call that captured (`action:"capture"` or `capture_after`); any other call sends nothing. When the capture is kept: every element with bounds, in element-index order, each cut to the screen (one wholly off it is dropped), with its `label` when it has one (one line, at most 60 characters); at most 100 elements (`ELEMENTS_MAX`). When the capture is forgotten (a window capture, `bounds_scale`, unreadable, the screen not running or another size) `elements` is `[]`, so the glasses drop stale targets. Never a role, app, window title or pixel. |
| `botScreenRun` | `{v:1, at:<ms>}` | A turn started using the screen (#5151): sent from `pre_tool_call` on the first `computer_use` call of a turn, for any platform's turn, once a turn. A turn is the hook's `turn_id`; on a host whose tool hooks name none, each `pre_llm_call` starts one. A background review fork's calls are not a turn. Ids and times only, in the parent's memory (`bot_screen.ScreenTurns`). |

App wire (phone ↔ relay, phone clients only; a backend without a Bot Screen
answers `open` and `status.get` with `state:"unsupported"`):

| Type | Direction | Body |
|---|---|---|
| `ocuclaw.botscreen.open` / `.close` | phone → relay | `{viewer:"glasses"\|"phone"}`. The first open starts the stream; the last close (or the client going) ends it. |
| `ocuclaw.botscreen.status.get` | phone → relay | `{}`; answered once, without opening a view. |
| `ocuclaw.botscreen.want` | phone → relay | `{viewer, n, w, h, view?, color?}` (w ≤ 960, h ≤ 600): send frame `n` at this size. `view:[x,y,w,h]` in screen pixels picks the part of the screen to show (Follow, Read); absent means the whole screen. `color:true` asks for a full-colour frame (`fmt:"png"`) when the picture has colour; anything else gets grey levels. Answered when the picture or the view changed since the last frame; a newer want replaces an unanswered one, and (#5148) one that waits while the picture is current hears `still`. A malformed view is ignored. |
| `ocuclaw.botscreen.status` | relay → phone | `{v:1, state, screen, placement, need, host, rootless, control:"lease"\|"unknown", at}`; `state` adds `connecting` and `ended` (the screen went away while watched). `need` (`memory`\|`host`\|null) and `host` (`cloudways`\|null) are add-only: a phone that ignores them shows the plain `off`/`missing` card. `rootless` (`ready`\|`memory`\|null, beside `need:"host"` only, #7571) is add-only too: a phone that ignores it shows the `host` card. `startable` (boolean, add-only, #7571 follow-up) is true when the parent's probe found `start` and the relay can ask it: the phone then offers Start on an `off` screen. A phone that ignores it shows the plain `off` card; a relay or parent that predates it sends none, and the phone offers no Start. |
| `ocuclaw.botscreen.start` | phone → relay | `{v:1, id}` (#7571 follow-up): start the selected profile's screen. The relay checks `botScreen.route` (the profile is admitted, and its probe says `start`; else `start_unavailable` without asking), then calls `botScreen.start {profileId}` with a 30 s wait. One start per client's profile at a time: a second ask joins the first. Any `profileId` in the message is ignored. |
| `ocuclaw.botscreen.start.result` | relay → phone | `{v:1, profileId, id, ok, state?, already?, code?}`: the parent's answer, each field checked again (`code` one of the parent's words above, or `start_unavailable`, `start_unknown`, `invalid_request`; any other word reads `start_failed`). A fresh `status` follows to the client's views and status asks. |
| `ocuclaw.botscreen.show` | relay → phone | `{requestId}` (#7571 follow-up): the agent's `show_bot_screen` (see the phone tools lane). The phone opens the glasses' Bot Screen page (not over a recording, a review, a question or typing) and, while the status is `startable` and `off`, `ended`, `running` or `connecting`, sends its own `ocuclaw.botscreen.start`. Broadcast to phone clients; an older phone ignores it and the tool returns `show_timeout` after 45 s. |
| `ocuclaw.botscreen.show.result` | phone → relay | `{requestId, ok, state, started?, opened, code?}`: `ok` when the screen is up (`running` or `sandboxed`); `started` is false when Hermes found it running (`already`); `opened` is false when the glasses could not show the page now. `code` on a refusal: `memory`, `not_installed`, `no_screen`, `start_failed`, `start_unavailable`, `status_unknown`. Phone clients only. |
| `ocuclaw.botscreen.lease` | relay → phone | `{v:1, known, holder:"agent"\|"human", mine, reason, epoch, since}`; sent on open and on every change. `mine` is true only when the lease names this runtime's viewer id, which never leaves the relay. A corrupt file reads as `human`, epoch -1, as Hermes reads it. |
| `ocuclaw.botscreen.frame` | relay → phone | `{v:1, viewer, n, seq, w, h, data, screen, view:[x,y,w,h], dirty:[[x,y,w,h]…], at, source:"rfb"\|"snapshot", fmt?}`; without `fmt`, `data` is 16 grey levels on one fixed curve, packed two pixels a byte (left pixel in the high nibble): `view` (cut to the screen) letterboxed into `w`×`h`. With `fmt:"png"` (a `color:true` want, and the picture has colour), `data` is a base64 PNG, exactly `w`×`h`, 8-bit RGB (colour type 2, no alpha), each channel the box average over the same boxes, letterbox bars black; every other field is the same. A grey-only picture (an older Hermes helper with no `rgb`) answers a colour want without `fmt`. A sandboxed screen's grey snapshot fetched before colour was asked does not answer a colour want; the next fetch asks for colour. `view` and `dirty` are in screen pixels; a moved view, a new size and every snapshot carry the whole screen as dirty. |
| `ocuclaw.botscreen.target` | relay → phone | `{v:1, rect:[x,y,w,h], kind:"element"\|"point", at}` (#5147): `botScreenTarget` cut to the screen, once to each phone with a view open, so Follow can cut there before the action lands. Nothing while no view is open; a malformed or off-screen target is dropped. |
| `ocuclaw.botscreen.step` | relay → phone | `{v:1, tool:"computer_use", action, label?, app?, keys?, chars?, direction?, at}` (#5148): `botScreenStep`, each field checked again (`label` and `app` cut to one line of 60 and 40 characters; `keys` only on a `key` step and only when nameable; `chars` any count on a `type` step, exactly 1 on a `key` step without `keys`; `direction` only on a `scroll`), once to each phone with a view open. Other fields are dropped; a field that fails its check, or an action outside the schema, drops the step. Nothing while no view is open. |
| `ocuclaw.botscreen.elements` | relay → phone | `{v:1, elements:[{rect:[x,y,w,h], label?}], at}` (#5155): `botScreenElements`, each field checked again (`elements` must be an array, else the message is dropped; each `rect` four integers with a positive width and height, cut to the screen, a malformed or wholly off-screen box dropped and the rest kept; `label` cut to one line of 60 characters, left out when empty; at most 100; `at` a finite number, else the message is dropped), once to each phone with a view open. Other fields are dropped. The last checked message is kept and sent to a phone when its view opens, so a wearer who opens the Bot Screen mid-run gets the last capture's elements; it is forgotten when the stream ends, the screen is no longer running, or the last view closes. Labels reach only the phone's Bot Screen view; traces count elements, never words. |
| `ocuclaw.botscreen.still` | relay → phone | `{v:1, viewer, n}` (#5148): nothing changed since that view's last frame, so its picture is current; `n` is the waiting want's. Sent once a want has waited 1 s and again every 1 s while it waits; it never answers the want (the next change does). On the socket, "current" means a FramebufferUpdate came within 3 s: while a want waits, the relay probes once a second with a non-incremental 1×1 FramebufferUpdateRequest at (0,0), and a probe answer that changes no pixel sends no frame. A `sandboxed` screen hears it after an unchanged snapshot, paced to at most once a second; a failed fetch sends nothing. No `still` in any other state. |
| `ocuclaw.botscreen.run` | relay → phone | `{v:1, at}` (#5151): `botScreenRun`, to every phone client, open view or not: the glasses' Peek ("The bot is using its screen") is how a view opens. Live only: never kept for a client that connects later, and one whose `at` is more than 30 s old is dropped. The phone shows Peek at most once every 30 s, only per its "Open on glasses when the bot uses it" setting (Off, Peek or Open). |

Screen asks (#5151). While the screen runs, an OcuClaw chat's `pre_llm_call`
context ends with `bot_screen.PROMPT_NOTE`, an `<ocuclaw_bot_screen_v1>` note
asking the bot to call Hermes's `clarify` for a login, a 2FA or one-time code,
a CAPTCHA or a payment, and to wait for the answer instead of ending its turn
with a reply. Not on another platform, a background fork or an Even AI turn
(clarify is vetoed there). The note needs no liveui context, and "running" is
read at most once each 10 s. A `clarify` raised in a turn that used
`computer_use` is a screen ask: the `clarify` event and its retained
`attention.clarify` carry `botScreen:true`, the relay's `demand` frame carries
`botScreen:true`, and the app shows it as the glasses' "Hermes · Needs you"
card with a still of the screen as its picture, answered through the same
`demand_response` as any clarify. A screen ask on another surface (Desktop,
Discord) carries `botScreen:true` on its `waiting` item. A clarify with no
screen use carries none and shows the usual question.

Pixels stay in memory in the child, the relay and the phone: never the model,
a transcript, a file or a trace. `glasses.lifecycle` traces (`bot_screen_*`)
carry state, sizes, byte counts, dirty-box counts and a 12-hex hash, never a
pixel, viewer id or lease reason. `bot_screen_target` says a target went and
its kind, never where. `bot_screen_step` names the action and which fields went
(`fields:"label,app"`), never a label, app, key or count; `bot_screen_still`
carries counts only; `bot_screen_run` says a run went and to how many
clients, or why it was dropped. Labels and app names live in the parent's
memory and reach only the phone's Bot Screen view. A card's picture (Peek,
Needs you) is a frame like any other, held by the glasses in memory only.

**Approve with a view (#5152).** Hermes gates `computer_use` actions behind an
approval (scope `cua:<action>:<mode>`), worded `Allow computer_use to perform
\`<action>\`?` with the command `computer_use: <summary>`. A `type` summary
quotes the text it types, and a `key` summary the keys. For such an approval
the `approval` backend event's `request` changes:

- `command` is `computer_use: <action>`, plus a nameable key or shortcut on a
  `key` action and ` [foreground]` for a foreground delivery; never the summary.
  Any command starting `computer_use:` is treated so, whatever the description.
- `botScreen` is added: `{v:1, tool:"computer_use", mode:"background"|"foreground",
  action?, label?, app?, rect?:[x,y,w,h], kind?:"element"|"point", field?:true,
  keys?, direction?}`. The label, app and box are the gated call's own, from its
  `pre_tool_call` step and target (a capture before it is needed). A `type` or
  `key` call has no target: its box and label are its field's, the element the
  bot last pointed at in that chat within 5 minutes (`field:true`), cleared by a
  `focus_app`. No text, value or count.
- `warningLines` is left out, and so are `purpose` and `ocuclawApprovalContext`:
  the card gets no plain-English sentence.

The native approval entry keeps Hermes's own command, so the decision resolves
Hermes's pending approval as for any other. The session list's
`attention.approvals` carry the same `command` and `botScreen`, and the Waiting
on you `preview` of a `computer_use` approval on another surface is its command
line without the summary. The relay passes `botScreen` to the app on
`ocuclaw.approval.request` after checking each field (unknown fields dropped)
and asks the explainer for no sentence. The glasses card opens the `glasses`
viewer for a picture of the target; that picture stays in memory.

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
by a newer candidate refuses the arm. Each arm also states which evidence it
claims (`replyEvidence`, below). The operation then consumes the bound
fingerprints into the existing private Attempt receipt. The gateway later enumerates its own
OcuClaw sessions and selects the one whose fingerprint matches the armed
Attempt, so the exact welcome surface renders to the phone/G2 conversation
without moving setup into it. A missing, expired, unreadable, or malformed
candidate refuses arming and asks for a fresh phone test message. The candidate
and the reply-delivery record below are OcuClaw-owned profile state; the
supported uninstall removes them and the profile move carries them across.

**Armed is not "the reply is over" (#3231).** The Attempt is armed on the
phone's SDK receipt for a SLICE of the reply, so the gateway's 1 s welcome
watcher must not render on `armed` alone: it would paint the welcome over a
reply the wearer is still reading. Each cycle the watcher skips while an
OcuClaw phone-origin run is still processing or still holds a deferred stream
tail, and then for the same `STREAM_FINALIZE_GRACE_SECONDS` the stream tail
already uses. The deferral is bounded: a run whose terminal boundary never
arrives stops holding the welcome back after
`FIRST_RUN_WELCOME_REPLY_WAIT_SECONDS`. Nothing is consumed by a skipped
cycle; the Attempt stays armed and the watcher retries.

## Reply-delivery lane (#3030 — machine evidence for the phone-origin reply)

Setup used to ask the wearer "did the reply appear on your Even G2?" on every
install. The originating phone already knows whether its own SDK accepted a
conversation frame carrying the exact committed assistant reply, so this lane
carries that one fact to the gateway and lets setup skip the question when it
holds. It is trusted-client telemetry about an SDK write, **not** pixel
attestation and **not** wearer confirmation; the two never merge.

Two additive control-link methods, both internal Node↔Python only. Neither adds
a phone protocol field, QR field, snapshot field, dashboard field, doctor field
or support-attachment field.

| Direction | Method | Params | Result |
|---|---|---|---|
| Python → Node | `replyDelivery.observe` | `{candidateId, sessionKey, runId}` | `{ok:true,status:"pending"\|"sdk_accepted"\|"unconfirmed"\|"unsupported",reason:<str\|null>}` or `{ok:false,error:<str>}` |
| Node → Python | `replyDelivery.report` | `{candidateId, status, reason, evidence}` | `{ok:true}`, or `{ok:false,error:"invalid_params"\|"candidate_unknown"\|"receipt_unavailable"\|…}` |

`candidateId` is the same 64-character lowercase-hex opaque binding
`wait_phone_origin` returns. `status` on a report is one of `sdk_accepted`,
`unconfirmed`, `unsupported` — never `pending`, which is an observation state.
`evidence` is `{"kind":"client_sdk_receipt","lane":"device"|"simulator",
"coveredChars":<positive int>}` **iff** `status` is `sdk_accepted`, and `null`
otherwise. Python validates the report as a closed shape: an extra key, a wrong
type, an out-of-range status or lane, a non-positive `coveredChars`, or an
evidence block that disagrees with the status all answer
`{ok:false,error:"invalid_params"}` and settle nothing. Node retries anything
that is not `{ok:true}`; a repeat of the same observation for the same
candidate answers `{ok:true}` so the bounded retry terminates.

The gateway sends `replyDelivery.observe` where it records a phone-turn
candidate — fire and forget, bounded, on its own task. It never blocks, delays
or fails the turn. A child without the method answers the link's
`-32601 method not found`; the adapter then records `unsupported` with reason
`runtime_lacks_contract` itself, so an older runtime degrades immediately to
the wearer question instead of waiting out the host's bound.

Python persists one secret-free record per profile at
`<HERMES_HOME>/state/ocuclaw.first-run-reply-delivery.json`, written under the
same `ocuclaw.first-run-proof.lock` as the Attempt, so joining and arming are
one ordered state transition:

```json
{
  "schemaVersion": 1,
  "profileFingerprint": "<sha256>",
  "candidateId": "<opaque 64-hex binding>",
  "credentialGenerationId": "<or null>",
  "pairingCompletionId": "<or null>",
  "status": "sdk_accepted",
  "reason": null,
  "evidence": "client_sdk_receipt",
  "lane": "device",
  "coveredChars": 128,
  "receivedAt": "<iso8601>"
}
```

Reply text, credentials, phone metadata, and raw session/run identifiers never
enter it, and never appear in setup output. The record binds the CURRENT
candidate only: an unknown or already-replaced candidate is refused and nothing
is written. A later `sdk_accepted` upgrades a stored `unconfirmed`/
`unsupported` for the same candidate; nothing downgrades a stored
`sdk_accepted`. Arrival order does not matter — the report may land before or
after the host starts waiting. A changed credential generation, pairing
completion or profile makes the record ineligible (`binding_changed`).

`reason` is a closed vocabulary, never prose: `attribution_unavailable`,
`binding_changed`, `client_disconnected`, `client_lacks_contract`,
`observation_expired`, `record_unavailable`, `reply_run_errored`,
`reply_run_rate_limited`, `runtime_lacks_contract`,
`runtime_unavailable` (the child was not ready or refused the observation),
`sdk_write_failed`, `sdk_write_timeout`, `simulator_lane_not_eligible`,
`unspecified`, `unsupported_reply_shape`, `wait_timeout`. Anything else a peer
sends is stored as `unspecified`.

**Errored runs are never evidence (#3232).** A run that errored still paints
its error text to the glasses, so the SDK accepts it and a receipt is
produced. The two `reply_run_*` reasons say the RUN errored, whatever status
rides with them: `reply_run_errored` in general, `reply_run_rate_limited` when
the peer knows the model is rate-limiting the account. `hermes ocuclaw
first-use` refuses both before it looks at the status, names the model as the
thing to fix, records no Core Setup Completion and arms no welcome.

**Simulator isolation.** `lane: "simulator"` evidence must never arm a real
installation. It qualifies only where the environment variable
`OCUCLAW_HERMES_ALLOW_SIMULATOR_REPLY_EVIDENCE=1` marks an explicit test
installation; this is a test-lane marker and must not be set on a user's
machine. Without it the projection reports `unconfirmed` with reason
`simulator_lane_not_eligible`.

**Host interface.** `{"operation":"wait_reply_delivery","phoneCandidateId":…}`
polls the record for about 40 s — Node's own deadline is 30 s — and returns
`replyDelivery: {status, reason, evidence, lane}`. A timeout is
`unconfirmed`/`wait_timeout`. It never mutates anything and never requires a
new `wait_phone_origin`: the same candidate still arms through the wearer path
afterwards.

**Two arming paths, discriminated.** The Attempt and the durable proof carry
`replyEvidence: "wearer_confirmed" | "client_sdk_receipt"`. `arm_first_run_proof`
and `welcome_round_trip` take the same field; `client_sdk_receipt` is refused
with `reply_evidence_unavailable` unless this exact candidate already has an
eligible `sdk_accepted` record. Records written before this field existed read
as `wearer_confirmed` and are never rewritten. The snapshot derives
`firstRunProof.method` from the discriminator:
`phone-origin-g2-wearer-confirmed` or `phone-origin-g2-sdk-receipt`. A receipt
alone never commits proof and never completes setup — only the live Hermes
Welcome Round Trip dismissal does.

## Readiness synthesis (W06 — census-gap `connect` row)

The link handshake IS the hermes connect. After `link.hello.ack` AND a
successful in-child relay boot, the child synthesizes
`helloOk {protocol: LINK_PROTOCOL_VERSION, policy: {tickIntervalMs:
HERMES_SYNTH_TICK_INTERVAL_MS = 15000}}` and only then emits `connected
{protocol, tickIntervalMs}` + `status "connected"` (readiness gate order is
census-row-pinned). Handshake/boot failure → `connectFailed {reason}`; link
EOF → `disconnected {reason}` + `status "disconnected"` before exit (pending
run-waiters reject). Relay bind failure exits `98` (`EADDRINUSE`, D7; a
holder with nothing listening gets the bounded retries above first, #3749). An ack config WITHOUT `relayToken` runs the child link-only (no relay
boot, no port bind, readiness never announced) — the lane the bundle pytest
drivers and echo probes use; production configs always carry the token
(`validate_config` requires it).

## Bot Screen native takeover and private input (#5156 / #5157)

`botScreen.control` is an authenticated, enrollment-checked RPC into the selected
profile's native Hermes Bot Desktop lease. Default still owns pairing and the relay.
It does not enable host display capture (#5285). It requires a compatible Linux
private Bot Desktop and fails closed for unsupported runtimes or unenrolled profiles.

The app sends `ocuclaw.botscreen.control`, `v:1`, `id`, and `op` (`status`,
`acquire`, `input`, `release`). Acquire requires the status `source` generation;
input/release additionally require the human `epoch` and memory-only `resumeToken`.
Input carries a strictly increasing `n`, one allowlisted `action` (`click`,
`double_click`, `right_click`, `scroll_up`, `scroll_down`, `enter`, `tab`, `type`),
full source-pixel `x`/`y` for pointer actions, and for `type` only printable ASCII
`text` (1–1024 characters) and an explicit `enter` boolean. No clipboard, resize,
raw RFB or arbitrary key action is accepted. RFB characters are X keysyms, including
uppercase and punctuation; they are not unshifted physical US key codes.

The relay supplies the trusted selected `profileId`, runtime/client `connectionId`,
pairing identity, and acquisition `sessionKey`/optional current `clarifyId`.
App authority overrides are ignored. Only a capability-bound release may explicitly
name a retained old enrolled profile. Internal `cancel` invalidates an in-flight
batch on drop/source change/timeout, and never releases human control.

`ocuclaw.botscreen.control.result` returns public availability, source and lease
`{known,holder,mine,epoch,reason,since}`, operation outcome, and owner-only opaque
recovery capability/`nextN`. Native viewer IDs never leave the broker. Input outcomes
may include ephemeral dispatched progress and uncertainty, without claiming that
the destination application accepted the input. No automatic replay follows an
unknown outcome. The broker reserves sequences/receipts before sending bytes and
checks native ownership, source, enrollment and cancellation before each atomic key
or pointer unit under the same cross-process lease lock used by Hermes Desktop.
Native Desktop takeover immediately revokes this owner. Disconnect keeps the lease.

Hand back grants the bot ordinary screen access again; there is no additional field
clearing confirmation. Optional Continue sends only a generic completion to the
acquisition chat/clarify context. The relay durably claims a release ID before that
continuation, preventing duplicate dispatch after retry/restart. Continuation
metadata is stripped before replies to the app. Draft text is never a continuation.

Control requests/results and desktop capture/image frames are never diagnostic
content, including protocol subscriptions and unredacted debug export. Control and
`botScreen.snapshot` oversize markers contain only routing identifiers plus
`truncated:true`: no `originalBytes`, `payloadHead`, image, input lengths or draft
hashes. Private responses repeat their fixed method classification so late replies
remain private after bounded request-ID history expires. Receivers refuse truncated
requests before executing handlers. Invalid or
unparsed frames log fixed reasons only. Private keyboard/review and retained human
control suppress app renderer/SDK/console/automation content diagnostics while
keeping both phone and glasses previews live. Native ownership metadata and
at-most-once receipts contain no typed payload, text hash or character count.

### Jev mode aim (app ↔ relay only)

Jev mode (Matt, 2026-10-20) aims the wearer's pointer from spoken words while that
wearer holds the screen. It is relay-local: no link method, and the parent sees
nothing new. Its only host input is `platforms.ocuclaw.extra.botScreenJev`
(`enabled`, `budgetMs`), projected by `_resolve_bot_screen_jev` as
`{enabled, apiKey, budgetMs}`: only a literal `enabled: true` (or `"true"`) arms
it, and a saved key alone never does. The key is the saved TypeSafe key, else the
deployment-time `TYPESAFE_API_KEY`, and only an armed group carries it; `budgetMs`
is forwarded only when finite, and the relay owns its clamp and default.

The app sends `ocuclaw.botscreen.aim`, `v:1`, `id`, and `op`: `arm`, `disarm`,
`aim` (`words`, optional `zoom`), `correct` (`aimId`, `words`, optional `zoom`) or
`clear`. Every op except `disarm` and `clear` requires a fresh `botScreen.control`
answer, for the selected profile, saying this client holds the human lease. `arm`
starts a memory-only full-colour copy of the RFB screen; `disarm`, losing the
lease, a profile switch or disconnect drops it and any aim. `aim` copies the newest
colour frame, asks TypeSafe Jev (`jev-1.14.0`, image header on) for a box and a
presence score, takes one 2x zoomed second look below 0.3 confidence, and checks
the lease again before answering. `correct` resends the same frame with rejected
guesses outlined (last magenta, earlier cyan) and the words so far. Aiming never
sends input; the wearer's action word goes through `ocuclaw.botscreen.control`.

`ocuclaw.botscreen.aim.result` carries the request `id`, the selected `profileId`,
`ok`, and on success `aimId`, the point `x`/`y` and `box` in screen pixels, the
frame `width`/`height`, `confidence`, `present`, `zoomed`, `turns` and `ms`;
otherwise a fixed `code` (`not_in_control`, `jev_off`, `not_armed`, `no_frame`,
`aim_expired`, `too_many_corrections`, `not_found`, `superseded`, `frame_size`,
`invalid_request`, `failed`, `jev_<reason>`). No words or pixels come back. Both
types are private in protocol subscriptions and every debug export mode.

### Jev in program cards (app ↔ relay only)

A programmable card may ask TypeSafe Jev the questions it declares. Like Jev mode
it is relay-local: no link method, and the parent sees nothing new. Its only host
input is `platforms.ocuclaw.extra.programCardsJev` (`enabled`), projected with the
saved TypeSafe key like `botScreenJev`, except that it is on while unset: a
missing block or `enabled` reads on, an explicit value wins (only `true` or
`"true"` is on), and a disabled group carries no key. Without a key it cannot
call. The phone's Jev in cards switch (permission `program_cards_jev`) writes the
flag, and each card still needs the wearer's yes for its own Jev block.

### MCP in program cards (host switch)

A programmable card may read the owner's MCP tools (reads only). The host input
is `platforms.ocuclaw.extra.programCardsMcp` (`enabled`), projected by
`_resolve_program_cards_mcp` as `{enabled}`: a missing block or `enabled` reads
on, an explicit value wins (only `true` or `"true"` is on), and there is no key
or budget. `programCardsModel` (Models in cards) uses the same projection. The relay reads it once at child start. The phone's MCP in cards
switch (permission `program_cards_mcp`) writes the flag. Each server still needs
the owner's per-server switch (`program_card.mcp.allow`, above) and each card the
wearer's yes for its own MCP block.

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

Two NON-secret platform settings may also come from that env file, so an
unattended installer never has to type them (#3098): `allow_admin_from` via
`OCUCLAW_ALLOW_ADMIN_FROM` and `evenAiEnabled` via `OCUCLAW_EVEN_AI_ENABLED`.
**Env wins.** Hermes commits the plugin's `env_enablement_fn` seed with
`platform_config.extra.update(seed)` (`gateway/config_env.py`
`_enable_plugin_platform`), so for every key the env file names, the env value
replaces the `config.yaml` value outright — exactly the precedence the three
secrets already have. An env name that is absent or blank changes nothing, so
a hand-edited `config.yaml` keeps working. A value that cannot be parsed is
refused with one plain, value-free warning line (once per process per name and
reason) and then treated as absent: gateway start never fails over an env typo,
and the rest of the seed (the Relay Credential included) still lands. Because
the effective value can come from `.env`, the passive status reads layer the env
seed over the parsed `config.yaml` block before they judge
`continueHereConfigured` / `mandatoryConfiguration.adoptConfigured` and
`evenAiEnabled`.

**The seed only commits past Hermes' own gate**, so those reads apply the env
layer only where the gateway would. `_enable_plugin_platform` reaches
`extra.update(seed)` only after three refusals: an explicit `enabled: false`
returns at once; a platform not already enabled must pass `is_connected`, which
for OcuClaw means a supported host **and an existing Relay Credential**; and
`check_fn` (supported host plus node) must pass, since OcuClaw registers no
`ensure_deps_fn`. A fresh install that has written `OCUCLAW_ALLOW_ADMIN_FROM`
into `.env` but has no Relay Credential yet therefore has no effective value —
the seed starts counting once bootstrap has generated the credential.

`wsBind` deliberately has no env name. It is the relay bind address, and an
env name for it would be a remote way to widen the listener past loopback.

| Key | Declared | Stored | Required | Precedence | Default / meaning |
|---|---|---|---|---|---|
| `wsPort` | `adapter.py` | `config.yaml` `extra.wsPort` | Optional, code-defaulted | yaml > code default | `47801`; relay WS listener. Fresh Hermes setup falls back to `43118`, then `38272`, only after a bind conflict. Even-AI shares this HTTP server. |
| `wsBind` | `adapter.py` | `config.yaml` `extra.wsBind` | Optional, code-defaulted | yaml > code default | `127.0.0.1`; relay bind address. No env name on purpose (see above). |
| `allow_admin_from` | Hermes `gateway/slash_access.py`; OcuClaw bridges the env name `OCUCLAW_ALLOW_ADMIN_FROM` | `.env` via `OCUCLAW_ALLOW_ADMIN_FROM`, or `config.yaml` `extra.allow_admin_from` | Optional; **required for "Continue here"** (`/resume <tip> --all`) | env > yaml > unset | The wearer admin allow-list. Written as JSON (`["ocuclaw-wearer"]`) or a comma list (`ocuclaw-wearer`); either shape reaches Hermes' own `_coerce_id_list`. A non-empty list turns slash-command gating ON for the whole platform, which is safe only because `ocuclaw-wearer` is the only user id the adapter ever stamps. An empty list, a JSON object, or unparseable JSON is refused. |
| `relayToken` | Host-generated Relay Credential; `adapter.py` bridge as `OCUCLAW_RELAY_TOKEN`; no `requires_env`, prompt, reveal, or return surface | `.env` via `OCUCLAW_RELAY_TOKEN` (the only supported source; no status, doctor, or setup surface reads a yaml secret) | **Required**; initial plugin bootstrap generates it on a provably fresh profile and validation refuses boot without it | env > unset | Downstream client auth token, constant-time checked and forwarded in `link.hello.ack`; reinstall/update/restart/re-pair preserve it, and only the locally confirmed all-device reset replaces it. |
| `sonioxApiKey` | `adapter.py` bridge as `OCUCLAW_SONIOX_API_KEY`; deliberately absent from `requires_env` | `.env` via `OCUCLAW_SONIOX_API_KEY` (the only supported source) | Optional; required for Soniox STT only | env > unset | Credential for temporary-key mint; unset returns `soniox_temp_key_not_configured`. |
| `typesafeApiKey` | `adapter.py` bridge as `OCUCLAW_TYPESAFE_API_KEY`; deliberately absent from `requires_env` | `.env` via `OCUCLAW_TYPESAFE_API_KEY` (the only supported source), saved by `hermes ocuclaw optional-setup save typesafe` or the phone's Add key page | Optional; required for the LiveUI Jev decider, Jev in program cards and the Bot Screen's Jev mode | env > unset | The one saved TypeSafe credential, shared by the LiveUI Jev decider, Jev in program cards and the Bot Screen's Jev mode. Silent input no longer uses Jev (Matt, 2026-10-31): it never ranks words with this key, and a stale `silentInputJev` block in `config.yaml` is ignored, never an error. Saving the key arms nothing: `liveuiJev.enabled` (the phone's LiveUI switch, permission `liveui_jev`), `programCardsJev.enabled` (the phone's Jev in cards switch, permission `program_cards_jev`) and `botScreenJev.enabled` (the app's Jev mode) are those consents. For each it outranks the deployment-time `TYPESAFE_API_KEY`, which never arms anything by itself and is the fallback once the saved key is removed. The phone can remove it (`credential.remove`). |
| `stateDir` | `adapter.py` | `config.yaml` `extra.stateDir` | Optional, code-defaulted | yaml > code default | `$HERMES_HOME/ocuclaw`; Node runtime state directory. |
| `phoneAddress` | `custom_route.py`, `adapter.py` | `config.yaml` `extra.phoneAddress` | Optional | yaml only | Custom network mode (#5208); unset means Tailscale. The adapter hands the value it loaded to the Node child, so the pairing control surface answers `custom_route` to a phone-code request by itself (#5219). Not a secret. |
| `glassesUiLive` | `adapter.py` | `config.yaml` `extra.glassesUiLive` | Optional, code-defaulted | yaml > code default | `{}` merges with `httpEnabled:true`, `llmEnabled:true`, `httpHostPolicy:"owner-grants"`, and `tickModel:""` (Hermes `ctx.llm` selects the model). Shared/hosted operators set `httpHostPolicy:"operator-only"` to revoke phone host grants. |
| `liveuiV2` | `adapter.py` | `config.yaml` `extra.liveuiV2` | Optional, code-defaulted | yaml > code default | `{}` resolves to `pictureFolders` unset (the agent workspace and the system temp folder). Title icons are not here: they are the wearer's LiveUI switch on the phone, and a leftover `titleIcons` key is ignored. Small loops are always on (a GIF or WebP picture's `liveui_picture` ready frames carry `loop: true`; `docs/design/liveui-research/v2/agent-pictures.md` A22), and a leftover `pictureLoops` key is ignored. A 3D model link's `liveui_picture` ready frames carry `model: true` (the bytes are a glass mesh v1, not a picture; `docs/design/liveui-research/v2/agent-pictures.md` A23), also with no flag. LiveUI V2's one block, the same shape as OpenClaw's (`docs/design/liveui-research/v2/SPEC.md` D3). `composed` and `presets` are retired and ignored: every chat is V2 and every Preset goes as its V2 form. They are still accepted so an existing setting loads. |
| `renderGlassesUiTimeoutMs` | `adapter.py` | `config.yaml` `extra.renderGlassesUiTimeoutMs` | Optional | yaml > unset | Positive render-tool timeout override; unset/non-positive delegates to the child default. |
| `externalDebugToolsEnabled` | `adapter.py` | `config.yaml` `extra.externalDebugToolsEnabled` | Optional, code-defaulted | yaml > code default | `true`; admit relay-token-authenticated debug clients and permit Debug Report assembly/local save. This is the access gate, not the app-side live-capture switch. |
| `debugAutoArm` | `adapter.py` | `config.yaml` `extra.debugAutoArm` | Optional, code-defaulted | yaml > code default | `false`; normal phone capture stays local and folds on Submit. Developer hosts may set `true` to auto-arm the full app + relay preset; live tools can lease specific categories either way. |
| `allowDebugUpload` | `adapter.py` | `config.yaml` `extra.allowDebugUpload` | Optional, code-defaulted | yaml > code default | `true`; allow user-initiated support-bundle handoff. |
| `debugUploadMaxZipBytes` | `adapter.py` | `config.yaml` `extra.debugUploadMaxZipBytes` | Optional, code-defaulted | yaml > code default | `4000000`; clamped to 100000–4300000 bytes. |
| `debugUploadCapturePreset` | `adapter.py` | `config.yaml` `extra.debugUploadCapturePreset` | Optional | yaml > unset | Category-list override for the support capture preset. |
| `debugBundleSaveDir` | `adapter.py` | `config.yaml` `extra.debugBundleSaveDir` | Optional | yaml > unset | Host directory override for locally saved support bundles. |
| `evenAiEnabled` | `adapter.py`; OcuClaw bridges the env name `OCUCLAW_EVEN_AI_ENABLED` | `.env` via `OCUCLAW_EVEN_AI_ENABLED`, or `config.yaml` `extra.evenAiEnabled` | Optional, code-defaulted | env > yaml > code default | `false`; enables the OpenAI-compatible Even-AI route. The env value accepts `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` in any case; anything else is refused. |
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
| `sharedChats` | `health.py` `shared_chats_enabled` | `config.yaml` `extra.sharedChats` | Optional, on by default | yaml > unset | Shared chats on Hermes ≥ 0.23.0: Continue here adopts a Desktop/CLI/TUI chat as one gateway conversation the glasses and the desk both drive, without the single-driver lock or the mirror. Needs `ocuclaw-wearer` in `allow_admin_from` too. Only `false` or `"false"` turns it off; read per call, so no restart beyond the config reload. |
| `auto_agent` | `agent_router.py` `auto_agent_requested` | `config.yaml` `extra.auto_agent` (default profile) | Optional kill switch, on by default | yaml > unset | Auto agent (#6795): `gw.agents.route` picks which enrolled agent takes a new chat the wearer started on Auto, and `families.agents.autoRoute` is advertised once the `ocuclaw_agent_router` auxiliary task registered. Whether a wearer sees Auto is their own app switch (OcuClaw settings `autoAgent`, off by default). `false`, `0`, or `"false"`/`"off"`/`"no"`/`"0"` withdraws Auto for every wearer; the phone cannot set it. Read per call. |
| `emoji` | `models_rpc.py` | `config.yaml` `extra.emoji`, in **that profile's own** home | Optional | Explicit OcuClaw glyph > native avatar | The OcuClaw-owned agent glyph for this profile, forwarded as `gw.profiles.list[].emoji` and `gw.agent.identity.emoji`. A configured glyph suppresses the native avatar in both replies. Unset/blank/non-string → key absent; clearing the glyph restores native-avatar sync. |
| `avatar` | `models_rpc.py` | `assets/avatar.png`, `.jpg`, or `.webp`, in **that profile's own** home | Optional | Explicit OcuClaw glyph > native raster > letter fallback | Hermes Desktop's `profiles.get_asset` source, including its default coloured bot faces backfilled to PNG and user-picked images. Read-only sync on identity/catalog refresh, bounded to 128 KiB per file and 512 KiB total base64 per roster. Magic checks and profile-home confinement apply. Forwarded through `agents.list[].identity.avatar` to optional `avatarDataUri` in the app catalog, and through existing identity hash/blob transport for the active agent. Missing/unreadable/oversized assets retain the existing glyph fallback; a Desktop-only appearance not yet backfilled to a raster can use the separate structured `appearance` field. |
| `appearance` | `models_rpc.py` | `profile.yaml` `ui_meta["hermes-bots"]`, in the routable profile’s own home | Optional | Explicit glyph/photo/pet > native animated face > static fallback | Bounded allowlisted `{shape, color, name}` descriptor, where `name` is the native profile identifier used for deterministic face seeds (not the relay namespace or display title). Classic shape/color defaults match Hermes. Shape-backed 160×160 raster backfills retain the descriptor; actual photos/pets and explicit OcuClaw glyphs suppress it. No arbitrary UI metadata is forwarded. The relay catalog carries `appearance` beside `avatarDataUri`; older clients ignore it and keep the raster/glyph fallback. Clients derive idle/thinking/working moods from fresh activity for that agent, rather than shipping animation frames through the gateway. |

#### Phone diagnostics permissions

The private optional-setup RPC supports `diagnostics.preview` with exactly one
`permission` (`access`, `handoff`, `liveui_jev`, `program_cards_jev`,
`program_cards_mcp` or `program_cards_model`) and a
boolean `allowed`, followed by an explicitly confirmed `diagnostics.apply`
carrying its `operationId`. The preview is single-use, expires after 180
seconds, and is bound to the authenticated phone connection, Primary Runtime
home and configuration revision. Disconnect clears it. Each save uses Hermes's
supported config writer and changes only the selected
`externalDebugToolsEnabled` or `allowDebugUpload` key, or, for `liveui_jev`
(the LiveUI Jev switch), `program_cards_jev` (the Jev in cards switch),
`program_cards_mcp` (the MCP in cards switch) and `program_cards_model` (the
Models in cards switch), the nested
`platforms.ocuclaw.extra.liveuiJev.enabled`,
`platforms.ocuclaw.extra.programCardsJev.enabled`,
`platforms.ocuclaw.extra.programCardsMcp.enabled` or
`platforms.ocuclaw.extra.programCardsModel.enabled` flag; Hermes creates a missing
map and keeps its siblings such as `budgetMs`. `access`/`handoff` default on
and refuse a non-boolean value; the LiveUI Jev switch reads
true only for a literal `true` or `"true"` (the adapter's rule) and reads a
missing or malformed block as off. Silent input no longer uses Jev (Matt,
2026-10-31): there is no `silent_input_jev` permission, so an older phone that
previews it gets the same `rejected`/`invalid_request` answer as any unknown
permission, and nothing is written. The card switches (`program_cards_jev`,
`program_cards_mcp`, `program_cards_model`) read on while unset (a missing
block or `enabled`), and an explicit value wins: only `true` or `"true"` is on. Ambiguous config, stale previews and unconfirmed writes fail
closed; an uncertain write is never replayed.

Saving neither restarts Hermes nor captures or sends a report. Card capability
permissions (`program_cards_jev`, `program_cards_mcp`, `program_cards_model`) apply
live: after config write/readback, the parent requests `program_cards.switches.apply`
with `{jev: boolean, mcp: boolean, model: boolean}` (2 s timeout). The child changes
the running engines and acknowledges those booleans. Only acknowledged flags enter
active diagnostics; a missing ack or failed observation is `outcome_unknown` and an
uncertain write never replays. These three permissions do not join restart review.
Chat setup's "Tools for cards" (#7189) reads, and never writes: the parent requests
`program_cards.tools.facts` with `{servers: boolean}` (2 s timeout, 7 s with `servers`).
The child answers `{cards: boolean, mcp: boolean}`: whether a connected phone has cards
on, and the MCP-in-cards switch. With `servers` it adds `{known: boolean, reason: string,
servers: [{name, connected, cards}]}`, from one tool listing bounded at 5 s: each MCP
server's name, whether it is connected and whether it is on for cards, and nothing else
(no tool names, arguments, results, keys or tokens). A listing that did not come back is
`known: false`. An older child's `-32601`, no answer or no link reads as unread: setup
does not offer the extra, and says it could not read the servers.
Each server the user then names is asked for on the glasses with `tools.requestCardSetup`
from the host's own setup chat, which is no glasses session: the parent sends
`{setup: true, params: {what: "mcp" | "server", server?, during: "setup"}}` and no
`sessionKey`, only from a chat its setup tool accepts. The child asks for nothing else
on that path, and an older child answers that no request was shown. Nothing turns on
without the wearer's Allow.
The Smart interfaces switch (`liveui_jev`) also applies live: after the save, the
parent requests `liveui.jev.apply` with `{enabled: boolean}` (2 s timeout). No key
crosses the link: the child turns the running decider on or off and, when it turns
on with no key in its LiveUI group, uses the saved `typesafeApiKey` it already
holds. It acknowledges `{enabled: boolean, keyed: boolean}`. Only an ack whose
`enabled` matches the saved switch, and that is `keyed` when on, enters active
diagnostics, and the parent then resolves its own `liveuiJev` group as a child
start would. Any other answer (an older child's `-32601`, no answer, on with no
usable key such as a key only in `TYPESAFE_API_KEY`) leaves the save `saved` and
not active, so the snapshot's `activation.required` offers the restart as before.
Other permissions retain their activation behavior. Their changes join
pending Voice/Even AI saves in the existing **Review saved changes** flow, whose
separate confirmation warns that restarting affects every profile. Snapshot
diagnostics distinguish configured `access`/`handoff`/`liveuiJev`/`programCardsJev`/`programCardsMcp`
from `activeAccess`/`activeHandoff`/`activeLiveuiJev`/`activeProgramCardsJev`/`activeProgramCardsMcp`
(LiveUI Jev uses the `liveui.jev.apply` ack, or the child start when that fails; card capabilities use
the live acknowledgement). `programCardsModel` / `activeProgramCardsModel` use
the same saved/active pair. Active values
require a recent loaded-relay observation tied to the live gateway process;
missing or stale evidence is null. `liveuiJevKeyAvailable` is true when LiveUI
Jev would find a TypeSafe key (the saved one, else `TYPESAFE_API_KEY`), so the
phone never says "no key" while one is still used; a boolean, never the key.

#### Jev key check (`jev.check`, #6938)

The phone asks "does TypeSafe accept this key?" with `operation: "jev.check"`
and no other field. The Node relay answers it on both runtimes, before the
request reaches this parent: it is the process that loaded the key (the saved
`typesafeApiKey` this parent projects, or a lane's resolved key). It sends one
fixed question (no wearer text) to `api.typesafe.ai/v1/systemone` through the
same Jev client and pool as the surface decision, with a 10 s budget, and
replies `status: "ok"` with `jevCheck.result` = `working`, `key_rejected`
(401/403), `unreachable` (network, timeout, 5xx, 429 or an unparsable answer),
`no_key`, or `not_loaded` (a key is saved that the relay has not loaded: the
check never tests a stale key in its place). To tell the last two apart the
relay asks this parent for an ordinary `status` snapshot, which rides the
reply. One check per phone connection and four in all may run at once; another
answers `rejected`/`busy`. Neither the reply, the `glasses.lifecycle`
`jev_key_check` debug row nor any log carries the key or the server's text.
The relay keeps the last answer in `jev-check.json` in its state directory
(`{"v":1,"result":…,"checkedAtMs":…}`) and deletes it when it starts, so a
missing file means "not checked since the last load". The capability snapshot
advertises `families.setup.jevCheck: true`. Old readers: an older relay's
parser answers `rejected`/`invalid_request` (with `operation: "status"`), and
the phone falls back to the loaded switch without a check.

`credential.begin` also accepts `intent: "remove"`, for capability `typesafe`
only and only while the key is on disk (absent answers `configuration_changed`).
The follow-up is `credential.remove` with exactly `{requestId, operation,
transactionId}`: single use, bound to the connection and configuration identity
like a save, it removes `OCUCLAW_TYPESAFE_API_KEY` through Hermes's
`remove_env_value` under the same receipt fence, reads `.env` back and answers
`{status: "removed", code: "removed", snapshot}`. `credential.save` on a remove
transaction, or `credential.remove` on a create/replace one, answers
`transaction_invalid`; `credential.cancel` works for any intent. The running
relay keeps the removed key until a restart: while a fresh observation says it is
still loaded, the snapshot reports the capability `present: false, state:
"not_configured"` with `activation.required: true`, and the existing restart
drops it. The loaded-relay observation records which removable keys the relay
holds as booleans only.
The shared capability snapshot also advertises version-1 permission readback
for Hermes only when both loaded flags are known booleans.

The same loaded-relay observation drives the credential states. A Soniox key, or
an Even AI token whose `platforms.ocuclaw.extra.evenAiEnabled` is true, present on
disk while the fresh observation says the live relay loaded a different value is
`saved` (`activation.required: true`, `mode: "restart"` where the native restart
is supported) even without a save receipt, so the terminal wizard's masked
prompts and a hand-edited `.env` get the phone's restart offer like the phone,
CLI and Desktop saves do (#3357). A `status` request re-observes first when the
observation is older than 60 s or predates the current `.env`/`config.yaml`;
stale or gateway-mismatched evidence stays `unknown`. An `unknown` capability
may carry `reason`: `even_ai_not_enabled` (token on disk, flag off: a restart
would not activate it, with or without a save receipt) or
`loaded_value_differs_after_restart` (an activation was attempted for this exact
`.env` revision, the gateway restarted since, and the relay still loaded a
different value, so a process env, systemd unit or managed override wins; no
further restart is offered until `.env` changes; `config.yaml` rewrites at gateway
start do not disarm it). The phone ignores `reason` today; the CLI prints a
plain-language line for it on stderr, keeping stdout one JSON object. An
activation admission (`activationRequested`) lifts when the next gateway process
observes the relay, and expires after 600 s if no gateway comes back (twice the
top of the measured 1 to 5 minute Cloudways container restart), so a stopped
gateway never fences later saves. An Even AI save whose token is written but
whose `evenAiEnabled` enable does not stick (a managed `config.yaml`) records the
token as `saved`, reports `even_ai_not_enabled`, answers the phone with
`saved`, and a retry with the same token tries the enable again. A phone
`credential.save` refused before any write (`busy`, `activation_pending_reconnect`,
`invalid_value`) answers `rejected` with that code, never `outcome_unknown`. An admission written by a pre-#3357
bundle carries no `requestedAt`; it keeps the old rule (it fences saves until a
different gateway is live) and the new gateway's observation lifts it.
The snapshot also carries `hostContext.cloudways` (boolean, optional, absent
means false): true only on a decisive Cloudways Managed AI Agents verdict (the
same `hermes ocuclaw cloudways detect` check, run once per gateway process as a
background task after the adapter registers its handlers, false before it
finishes and on `likely` or any error), so the activation confirm card can say
the whole container restarts and the phone reconnects on its own in 1 to 5
minutes. On such a host the snapshot reports `activation.supported: true` and
`mode: "restart"` once detection has run (#3357): the Home card offers Restart
Hermes, and the restart bounces the container. `hermes ocuclaw optional-setup
activate` does the same from SSH after a warning that the whole container
restarts and SSH disconnects. Unlike the phone path, the CLI path runs
`hermes gateway restart`, which on a host with no service manager stops the
gateway and force-kills it after 5 s, so it does not wait for active runs; its
warning says so: "Active replies are stopped, not finished." When the restart
bound cannot be read, it writes no activation fence and prints the manual
dashboard instruction instead. It is named `hostContext`, not `runtimeContext`: the latter is the
observed relay/gateway identity in `hermes ocuclaw optional-setup status`.

These host permissions are independent of the phone's **Enable Debug** capture
switch. Full report handoff requires both host permissions. Upload remains a
separate user-reviewed Send action. Existing defaults remain unchanged.

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

### Connected model sites

LiveUI's private model-site connection plane (#5299) is separate from optional
setup. Both OpenClaw and Hermes terminate it in the shared Node service; it does
not introduce a Python RPC, environment variable, agent tool or control-link
credential delivery. In particular, optional setup's restart-delayed credential
removal above does **not** apply: model-site saves and removals take effect in
the running resolver immediately.

The capability snapshot advertises `families.modelSites`:

```json
{
  "commandsVersion": 1,
  "generation": "opaque-runtime-generation",
  "providers": ["sketchfab", "thingiverse", "myminifactory"],
  "sourceMetadataVersion": 1
}
```

Absent/zero command support means the phone must explain that connections are
unsupported by this host; viewer controls remain phone-local and usable. The
generation is opaque and contains no credential-derived data. Reconnect,
generation change or selected-executor change retires pending phone state.

On the paired private phone connection, requests are
`{type:"ocuclaw.model_sites.request", requestId, operation, ...fields}`. No
extra fields are accepted. `requestId`, transaction IDs and revisions are
1–128 characters from `[A-Za-z0-9_-]`.

| Operation | Additional fields | Behavior |
| --- | --- | --- |
| `status` | optional `provider` (defaults to `sketchfab`) | Return that provider's sanitized connection snapshot. |
| `credential.begin` | `provider:"sketchfab"\|"thingiverse"\|"myminifactory"`, `intent:"create"\|"replace"\|"remove"`, `revision` | Check that provider's revision and issue a phone/executor-bound, one-use transaction expiring after 120 seconds. |
| `credential.save` | `transactionId`, `credential` | Consume a create/replace transaction, verify the account through its provider, then atomically save and activate the new credential. A failed replacement preserves the old connection. |
| `credential.remove` | `transactionId` | Consume a remove transaction and immediately remove the credential, invalidate its generation and cancel pending old-account work. |
| `credential.cancel` | `transactionId` | Retire the transaction and cancel associated verification; a late verification cannot save. |

Credential entry accepts bounded non-space printable ASCII (at most 4,096
characters), stays masked and is cleared after completion/cancellation. The
host never returns a saved credential. These operations are explicitly
transactional: neither reconnect nor an uncertain result replays a credential
write. A new attempt requires a fresh status and transaction. Disconnect also
retires this phone's unfinished transactions and verification.

Results have `type:"ocuclaw.model_sites.result"`, the matching `requestId` and
`operation`, and `status: ok|saved|removed|cancelled|rejected|unsupported|outcome_unknown`.
Only allowlisted codes and these optional objects cross the boundary:

- `snapshot: {provider, state, revision, code?, account?}`. State is
  `not_connected|checking|connected|needs_reconnect|temporarily_unavailable`.
  Account is `{id, name, url?}` with a bounded ID/name and an optional canonical
  HTTPS Sketchfab profile URL. No raw provider response is retained in results.
- `transaction: {id, expiresAtMs, provider, intent}`. Provider is one of the three advertised IDs.

The phone accepts only replies matching its outstanding request and operation.
Service errors become fixed codes rather than exception messages. Codes
distinguish stale/invalid transactions, reconnect, unavailable downloads, rate
limits, provider outages, network refusal, unsupported formats, size/conversion
failures, cancellation and unattended execution. Raw provider bodies, tokens,
authorization headers and signed URLs never enter logs, bundles or agent
results; private frame diagnostics contain only the family and a private mark.

The executor stores the credential in
`<stateDir>/model-sites/credentials-v1.json`, with directory mode `0700` and
file mode `0600`, using an atomic revision-checked write. It is not ordinary
plugin config, phone preferences or Hermes's inherited environment. Successful
replacement invalidates old-account imports and signed URLs; failed
replacement leaves the previous generation usable. Disconnect prevents late
verification/download/conversion from installing credentials or a new mesh.
Already-imported meshes remain governed by the normal cache lifecycle. Removing
this local credential does not revoke it at the provider.

Thingiverse and MyMiniFactory use separate `thingiverse-credentials-v1.json` and
`myminifactory-credentials-v1.json` files in that same protected directory. They
have independent revisions, pending transactions, health and import cancellation.
The original Sketchfab file remains compatible. The phone checks the advertised
`providers` list before offering connections; old hosts keep Sketchfab working.

The two printing sites accept a provider-issued **OAuth access token**, obtained
through the user's registered developer application. This iteration does not
register an OAuth application, handle browser callbacks, or refresh expired tokens;
expired access requires reconnecting. Passwords, client secrets and MyMiniFactory
API keys are not supported credentials. Account verification uses
`https://api.thingiverse.com/users/me` or
`https://www.myminifactory.com/api/v2/user` with a Bearer header.

Printing-site imports use exact `/things/<id>` and `/things/<id>/files` routes on
the Thingiverse API, or `/api/v2/objects/<id>` and `/api/v2/objects/<id>/files` on
MyMiniFactory. The first downloadable STL, OBJ, GLB, glTF, 3MF or PLY part within the size
budget is displayed in provider order; multipart designs are not assembled.
Thingiverse's exact `/files/<fileId>/download` may return one redirect: only that
fixed API request receives auth, and its validated destination is fetched
anonymously through the normal model guard. No scraping or purchased-content
bypass is attempted. File permission failures remain download failures.

Provider contracts: [Thingiverse's official SDK](https://github.com/makerbot/thingiverse-js),
[Thingiverse's official endpoint wrapper](https://github.com/makerbot/thingiverse-php),
[MyMiniFactory OpenAPI](https://github.com/MyMiniFactory/api-documentation/blob/master/myminifactory-api.yaml),
and [MyMiniFactory OAuth instructions](https://github.com/MyMiniFactory/api-documentation/blob/master/oauth2-instructions.md).

Three-site acceptance check: connect each account in LiveUI → Settings → 3D models
on the same executor, then ask the agent to display one permitted model-page link
from each site. Confirm the provider/creator/licence beside each rendered model.
Disconnect one site and verify the other two still import; reconnect it and repeat.
Run on OpenClaw and Hermes. Deterministic adapter/conversion tests do not substitute
for real account entitlement, token expiry, provider availability or a phone/G2 ride.

A canonical Sketchfab page in existing inline image `src` may resolve only during a
wearer-initiated run on that executor. Ticks, cron, subagents and unplaceable
runs cannot use the saved credential. Compose-tool calls currently lack a trusted
originating run identity and are also refused; a concurrent wearer turn in the
same session supplies no authority. The adapter reads only exact HTTPS
`api.sketchfab.com/v3/me`, `/v3/models/<id>` and `/v3/models/<id>/download`
endpoints. API responses are capped at 1 MiB and 8 seconds per request; API
redirects are refused. Existing HTTP-disable, operator destination policy and
socket-time SSRF checks still apply. The token is never sent to a CDN,
redirect or external resource. The guarded model lane downloads an eligible
GLB, else glTF ZIP, within the existing model/archive/conversion budgets.

Ready model picture frames may carry additive `modelSource` metadata:

| Field | Bound/meaning |
| --- | --- |
| `provider` | `"sketchfab"`, `"thingiverse"` or `"myminifactory"` |
| `modelId` | 32 hexadecimal characters for Sketchfab; 1–16 decimal digits, without leading zero, for printing sites |
| `title` | At most 200 characters |
| `url` | Canonical `https://sketchfab.com/3d-models/<modelId>`, `https://www.thingiverse.com/thing:<modelId>` or `https://www.myminifactory.com/object/3d-print-<modelId>` |
| `creator` | At most 160 characters |
| `creatorUrl?` | At most 512 characters; ordinary HTTPS Sketchfab link |
| `license` | At most 160 characters; unknown remains unknown |
| `licenseUrl?` | At most 512 characters; ordinary HTTPS Sketchfab or Creative Commons link |
| `attribution` | At most 1,000 characters |

These values are sanitized text and canonical links, never markup or a signed
download URL. Older clients ignore the extra field. The phone shows attribution
with the model and full Source & licence details. Viewer preferences, pose,
zoom and head samples stay on the phone and do not use this private plane.
See `docs/design/liveui-research/v2/agent-pictures.md` A24 and ADR-0029 ruling 4a
for the lifecycle, persistence and compatibility contract.

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

### Desktop setup activation

`state/ocuclaw.serving.json` may include `setupConfigurationFingerprint`, a
SHA-256 of the restart-sensitive, non-secret setup keys captured when the
gateway constructs its adapter. Reconnects and plugin reloads retain that
snapshot. It excludes credentials and unrelated Hermes metadata; file mtimes
are never activation evidence. Readers require the profile, PID and available
process-start identity to match the live gateway.

`GET /setup-card` and setup-tool status expose `restartToFinish` with
`reason: "configuration"` when that snapshot differs from the saved setup
settings, including when installed and serving plugin versions are identical.
Older receipts without the fingerprint remain unknown. The setup journey
returns to `restart-and-relay-verification` until activation, while completed
First-Run Proof remains completed. `status.setupSurface` identifies the live
conversation surface for the Desktop restart handoff.

The Desktop card offers its supported SDK restart action ahead of a waiting
setup-chat label. An accepted action is not readiness: the card waits for the
replacement gateway and cleared pending hint. Cancellation preserves the
pending work, and completion retains the original setup conversation.

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
Where the host has `post_auxiliary_call` (0.22+), `usage` also carries
`tasks: [{task,calls,attempts,failedAttempts,fallbacks,input,output,typicalMs,route}]`
for OcuClaw's own background calls (`ocuclaw_approval_explain`,
`ocuclaw_liveui_refresh`, `silent_input_prediction`, `ocuclaw_card_review`;
the observer also counts `ocuclaw_card_model`, `ocuclaw_card_frame` and
`ocuclaw_card_icon`, which
the child does not yet forward), busiest first. Hermes
records aux usage only inside an agent turn, so these are counted by the
plugin's own observer into `state/ocuclaw.aux-usage.json` (per UTC day, 90 days) and
are not part of `totals`. `calls` counts distinct `api_request_id`s;
`fallbacks` counts requests answered on a different provider or model from
their first attempt; `typicalMs` is the median successful attempt (null when
none); `route` is the last answering `provider · model`, or `auto`. The
observer reads no prompt or reply field. `tasks` is absent on an older host.
Each attempt is also sent to the child as `aux.call`
`{phase,task,requestId,attempt,provider,model[,ms,input,output,failed]}` for
the relay-only `token.aux` debug category.

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

## Plugin copy findings (Snapshot v1)

`ocuclaw_shadow_plugin_copy` (error, one per discoverable noncanonical copy) and
`ocuclaw_running_version_mismatch` (error, only when both versions are known) lead
`findings[]`, before `phone_app_absent`. They explain version rejection without
changing the four-leg health aggregate or phone absence behavior. Dashboard,
phone and support consumers accept finding codes as strings; unknown repair codes
remain readable through the static summary. The dashboard headlines findings[0].

Repair parameters contain only sanitized `folder`, `version`, `installedVersion`,
`runningVersion` and `loadedFromInstalled` (`yes`, `no`, `unknown`) tokens. No path
enters the snapshot or support attachment. Full paths and quoted move-as-backup
commands appear only in local human doctor output. Resolve stray copies, restart
the gateway normally, then tap Try again; re-pairing cannot repair stale code.
The running version is captured at module import so a disk upgrade cannot disguise
an old live gateway. A CLI invocation observes its own loaded package.

The shared health collector serves adapter/CLI/dashboard/support/setup/Cloudways/
uninstall calls. Desktop's periodic POST /fleet/snapshot only publishes the
presenter's fleet inventory; it never calls the connection-health collector.

## Programmable card model calls (sessionless)

The Node engine holds an exclusive built-in SQLite transaction for each Library's
model storage. Only one gateway may enable model writes at a time for that root.
Turning Models off fences pending continuations and releases the lock; the next
owner reloads grants, usage, rate windows and threads. A process crash releases the
OS lock. Node without built-in SQLite fails only Models closed. State includes
`available` and `reason` (`library_in_use`, `unsupported_runtime`, or
`storage_unavailable`). App deletion borrows the local lease or obtains a temporary
one; a foreign owner causes a conflict before any app/grant/thread removal. Deleted
app markers stop a stale open subscription from restoring its model grant.
Each dispatched attempt reserves an `incompleteRequests` usage entry before
native work. A missing receipt after crash/cancel/handoff remains incomplete;
missing native cost sets `costUncertain`. Either blocks daily-cost-capped calls
until the daily usage reset, while request caps retain all reserved attempts.
Libraries that never enabled Models use a synchronous deletion guard without
creating a SQLite database. A crash during this legacy deletion path leaves a
fail-closed guard; it does not have SQLite's automatic crash recovery. A Library
that has used Models requires SQLite support for guarded app deletion thereafter.

Child → parent `program_card.model.complete` accepts `{callId, profileId, provider, model,
messages, maxTokens, timeoutMs}`. `messages` includes the fixed host system framing,
card instructions, bounded card-thread history and the new input: 2 to 44
messages with at most 128 KiB of UTF-8 text in all, else `too_big`. The parent calls
`ctx.llm.acomplete` with explicit provider/model, task `ocuclaw_card_model`, purpose
`ocuclaw program card model` and the remaining timeout. It creates no agent/session.
The task has `defaults={timeout:60}`, no inherited task, and belongs to
`OCUCLAW_TASKS` for usage accounting. Replies contain text, actual provider/model,
responseModel and inputTokens/outputTokens/costUsd. A different provider/model
returns `model_changed` with usage and no answer; the Node engine pauses that use.
A dated variant of the same approved model on the same provider is accepted.

`profileId` comes from the authenticated connection's selected session (or the
authoring tool's trusted session), never from a phone-supplied profile. The parent
rejects unserved profiles, enters that home's native config/credential scope off
the event loop, and carries its context into the owned completion task. A changed
owner profile discards an in-flight result and writes no card memory.

`program_card.model.cancel {callId, profileId}` cancels the same profile's owned await and acknowledges
`{cancelled}`. A provider behind a thread may still bill; results are discarded.
`program_card.model.models {profileId}` returns that profile's catalog with canonical
refs and isMain. `program_card.model.allow {ref, profileId}` checks that catalog and appends
native provider and bare-model overrides to this plugin's own trust allowlists,
preserving unrelated entries and unrestricted policies. The engine independently
locks the approved provider/model pair. Reasoning is read-only Hermes default.

Phone `program_card_model` operations are open/prompt/cancel/close, decide/settings/
resume/remove/reset/state/threads/models/check. Results/status and private models,
check and transcript replies use the requesting connection's unicast only; public
state excludes prompts, answers, instructions, schemas and transcript content.
Memory belongs only to the LiveUI Library's program-card-model-threads-v1 tree.
