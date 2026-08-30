# OcuClaw fresh install on Hermes — Steps 1–12 (plus Step 4b)

**Guide version:** 2026-08-30 (1.3.17-hermes)

Keep using the loaded setup skill for guardrails, the lane card, and the
internal completion checklist.

**HOST OWNERSHIP.** Setup stays in this host conversation from the first check
through the welcome dismissal. On every entry or post-restart resume, obey the
setup receipt's `journey.nextCheckpoint` and do not repeat an earlier step.
The phone/G2 conversation is only the proof subject. Do not ask the user to run `/ocuclaw-setup` in the phone app or to continue setup there.

**FINISH CONTRACT.** A successful Step 10 phone-origin reply is not the finish.
Wearer confirmation arms the one-hour First-Run Proof Attempt; only the exact
Hermes Welcome Round Trip returning `dismissed` or `back` commits durable proof
and permits the completion announcement. One immediate retry is allowed. After
a second failure, continue only with the visible split-truth warning and
support path below; never claim completion. Soniox and Even AI remain separate
optional choices after the announcement or warning and never alter the
milestone. After both choices resolve, call `{"operation":"wrap_feedback"}`;
that final wrap owns the single support explanation. The
finish may span turns; never wrap while an optional choice or its restart is
in flight.

## Step 1 · Prerequisites

Ask: "Are your glasses paired in the Even Realities app, and can you open Even
Hub on your phone?"

Then run the read-only host gate:

```bash
hermes --version
```

When `{"operation":"status"}` reports a non-unknown `hermesVersion`, that
receipt decides the gate: PASS when it is inside `supportedRange`; a version
outside `>=0.20.0,<0.21.0` -> `HERMES-GATE-REFUSED`, regardless of the shell
probe. Only when `hermesVersion` is `"unknown"` does the probe decide: Hermes
0.20.x is PASS, and an earlier or later version -> `HERMES-GATE-REFUSED`.
`command not found` beside a supported `status.hermesVersion` is the
trust-ladder case: Hermes is installed; continue, handing commands to the
user's terminal. Only when the probe fails *and* `hermesVersion` is `"unknown"`
is Hermes itself missing — installing Hermes is outside this skill; point to
the official Hermes installation docs and return when the command works.

Inspect the non-secret profile posture now, so multiplex cannot be silently
skipped later:

```bash
hermes config get gateway.multiplex_profiles
hermes profile list
```

Record off, on-single, or on-multiple in the lane card. If on-multiple, enter
`PROFILE-AUTHZ-DROP` before setup can finish. The gateway boot warning in Step
5 is authoritative if a process environment override disagrees with the saved
config reading.

## Step 2 · Install from the public bundle

Skip when `hermes plugins list` already shows an enabled or disabled `ocuclaw`
plugin from the intended GitHub bundle. Do not overwrite an unexplained local
plugin without the user's decision.

This is the one wording every OcuClaw-on-Hermes surface uses for installing and
updating. Quote it when you explain the sequence; do not paraphrase it.

It is reference wording, **not** a script to paste. This file's numbered steps
own the ordering, the `Skip if` checks, and the CHECKPOINTs — the block shows
three commands together that Step 2, Step 4, and Step 5 propose separately, each
only when it is actually needed. Running the block wholesale would issue no-op
commands and skip the checks. The terminal path is the one this skill drives;
mention the Desktop deep link only to a user who asked for it.

<!-- ocuclaw:install-block:start -->
OcuClaw needs Hermes `>=0.20.0,<0.21.0`; the certified baseline is Hermes
`0.20.6`.

**Terminal first.** This is the supported path and the one every beta build is
tested on:

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes config set display.interface tui   # the pairing panel lives in the TUI
hermes gateway restart
```

Then, in bare `hermes` or in Hermes Desktop:

```text
/ocuclaw-setup
```

`hermes plugins install` prints that restart instruction and stops there — it
never restarts the gateway for you. Until the gateway restarts, OcuClaw is
installed but not loaded, and nothing about the glasses works yet.

**Never install with `--ref`.** A ref-pinned install is recorded as
`pinned: true`, and `hermes plugins update ocuclaw` then refuses to move it
forward at all; the only way out is another explicit
`--force --ref <40-character SHA>` install. Take the published tip —
`hermes plugins install ocuclaw/ocuclaw --enable`, nothing more.

**Hermes Desktop second.** Opening

```text
hermes://plugin/install?repo=ocuclaw/ocuclaw
```

installs the same bundle through the Desktop install modal, enabled by default.
Desktop picks up the OcuClaw presenter immediately, but the agent half still
only enters the gateway on the gateway's next start — so a Desktop install
leaves two follow-ups, and the OcuClaw setup card in the Hermes Desktop title
bar walks you through both:

1. The card explains the pending restart and offers **Restart gateway**. Click
   it, or run `hermes gateway restart` in a terminal — either works. The card
   reads the gateway's own reported platforms rather than its own web route, so
   it advances only once the gateway has genuinely loaded OcuClaw.
2. The card then reads **Pair your glasses**. Run `/ocuclaw-setup` and finish
   pairing. The card retires on the durable pairing receipt and stays gone,
   including across a Desktop relaunch.

**Update.** In `hermes plugins update ocuclaw`, `ocuclaw` is the **plugin id** —
the `name:` field in `plugin.yaml` — and not the `ocuclaw/ocuclaw` repository
name. Update resolves the directory of that name under `~/.hermes/plugins`; it
never looks at the repository the plugin came from:

```bash
hermes plugins update ocuclaw
hermes gateway restart
```

Unlike install, `hermes plugins update` does **not** print the restart
instruction, and it does not restart the gateway. The new code loads on the next
gateway start and not a moment sooner, so restart it yourself — then run
`/ocuclaw-setup` and let it re-verify health.
<!-- ocuclaw:install-block:end -->

CHECKPOINT:

```bash
hermes plugins install ocuclaw/ocuclaw --enable
```

This clones the public OcuClaw Hermes beta bundle. There is no npm or ClawHub
leg. Never add `--ref`, for the reason the block states.

VERIFY:

```bash
hermes plugins list
```

The list names `ocuclaw`. Install failure -> `ESCALATE`.

## Step 3 · Relay Credential [required, host-managed]

Verify only the `relayTokenPresent` boolean from `{"operation":"status"}`.
When true, continue without reading or handling the value. A present credential
is host-managed: never offer entry or replacement; `/ocuclaw-setup` owns its
locally confirmed all-device reset.

There is nothing for the user to enter. Initial plugin bootstrap generates the
credential once on a provably fresh profile, atomically persists it through
Hermes, then writes the secret-free generation marker. Reinstall, update,
restart, and re-pair preserve both.

When false, stop at `CREDENTIAL-MISSING`. The marker means the profile is
established even though its credential is unexpectedly missing or unreadable;
normal setup must never silently create a replacement and disconnect paired
phones. Load `{"operation":"credential_reset"}` for the warning and locally
confirmed all-device reset. If neither credential nor marker can be read,
bootstrap did not complete; use guided recovery and do not invent a manual
credential-entry path.

## Step 4 · Configure the beta posture

Include the plugin-enable command only if `hermes plugins list` shows OcuClaw
disabled. Inspect the three non-secret settings first and include only lines
whose desired value is not already present; do not create no-op user commands.
Do not skip the Even Terminal check: the Hermes runtime default is off, while
this beta's ratified posture is ON.

CHECKPOINT:

```bash
hermes config set platforms.ocuclaw.extra.evenTerminalEnabled true
hermes config set display.platforms.ocuclaw.tool_progress off
hermes config set display.interface tui
hermes plugins enable ocuclaw
```

The native install normally enables the plugin; the conditional command also
recovers an older disabled install. The non-secret commands enable the product
ET route and keep Hermes' conversational tool-progress bubbles out of the
OcuClaw transcript. Hermes TUI and Desktop are the guided beta pairing
surfaces: each presents the secure QR and four-word decision directly without
routing either through the model. `display.interface=tui` keeps the supported
terminal default; it does not replace or disable Desktop. Classic `hermes
--cli` hands the pairing checkpoint to one of those two surfaces. Configuration
changes require a gateway restart.

VERIFY the non-secret gate without reading any secret:

```bash
hermes config get platforms.ocuclaw.extra.evenTerminalEnabled
hermes config get display.platforms.ocuclaw.tool_progress
hermes config get display.interface
```

Continue only when the ET setting reports `true`, the tool-progress setting
reports `false`, and the interface reports `tui`. Hermes 0.20 stores the CLI
value `off` as a boolean, so
`false` is the correct readback. If the optional config-gated Hermes `/verbose`
command changes OcuClaw's per-platform mode, restore `off` before continuing.

## Step 4b · Live reasoning [OPTIONAL — offer, never assume]

Read `status.hermesHooks.streamReasoningDeltasOffer` from the receipt you
already have. It says exactly one of four things, and each has one response:

- `already_enabled` -> say so in one line and go to Step 5. Change nothing.
- `inert` -> tell the user plainly that this Hermes has no reasoning-delta
  hooks (they arrive in 0.20.5), so the key would do nothing here. Do not
  offer it, do not set it, and do not present this as a defect.
- `unknown` -> the configuration was unreadable; this belongs to the
  `config_unreadable` problem, not to this step. Skip and go to Step 5.
- `offer` -> make the offer below.

CHECKPOINT. Tell the user what it does and what it costs, in their own words:
reasoning reaches the glasses as it is written rather than in whole pieces,
and the key is Hermes' own and gateway-wide — it changes how Hermes calls the
model for every surface on this gateway, not only OcuClaw. Then ask for a
yes or a no. A no is a legitimate finished answer; record it and move on.

On an explicit yes, call the setup tool once:

```json
{"operation":"enable_stream_reasoning_deltas","confirm":true}
```

This is the ONLY writing operation the setup tool has, and `confirm: true` is
what makes it write — never send it before the user has said yes, and never
send it to "check" what would happen. The tool writes the key atomically
through Hermes' own configuration writer; do not hand-edit `config.yaml` and
do not run `hermes config set` for this key yourself when the tool is
available. VERIFY from the returned receipt that
`streamReasoningDeltas.applied` is `true` and that the fresh status shows
`hermesHooks.streamReasoningDeltas: true`.

The key is saved but not live: Hermes reads it when it builds its plugin hook
set. Step 5's restart is that restart — do not add one here.

If the tool returns `stream_hooks_unavailable`, the host cannot use the key;
report that and continue. If it returns `config_unwritable`, report the
receipt and continue to Step 5 without retrying.

## Step 5 · Restart and verify the loopback relay

Warn about the brief restart, then CHECKPOINT:

Call `{"operation":"quick_reference"}` and follow `Restarting the gateway`,
including its supervisor-specific command and wizard rule.

VERIFY with read-only status and logs available on this host. Find the newest
line shaped like:

```text
[hermes-runtime] relay listening on ws://127.0.0.1:47801
```

Accept a different port only if the user deliberately configured it through:

```bash
hermes config get platforms.ocuclaw.extra.wsPort
```

Do not read secret keys. A missing Relay Credential returns to
`CREDENTIAL-MISSING`. A bind failure / child exit 98 -> `RELAY-PORT-CLAIMED`. Never widen
`wsBind`; preserve or restore loopback with:

```bash
hermes config set platforms.ocuclaw.extra.wsBind 127.0.0.1
```

If setup began in the classic interface, the saved TUI default cannot replace
that already-running host. After the restart and relay verify, give one
handoff: exit the classic process and run bare `hermes` (without `--cli`), or
open Hermes Desktop. Then invoke `/ocuclaw-setup`; the durable
`journey.nextCheckpoint` resumes after this step instead of starting over. Do
not request another relaunch when the live window is already TUI or Desktop.

## Step 6 · Tailscale on the host

Read-only checks need no OK:

```bash
tailscale status
```

Read the full uncapped result. If unavailable, call
`{"operation":"troubleshooting"}` and enter `TS-NOT-INSTALLED` immediately;
continue in this setup turn and execute that guided branch through the agent's
Terminal tool. If logged out, call `{"operation":"troubleshooting"}` and enter
`TS-AUTH`. Record the current host and phone rows; do not infer an offline phone
is usable.

```bash
tailscale ip -4
```

This compact check confirms the host has a tailnet address.

## Step 7 · Serve the relay at :8446

Run this CLI command through the agent's Terminal tool as the bounded host
diagnostic whenever `Hermes CLI on agent PATH` is `yes`:

```bash
hermes ocuclaw doctor
```

Never hand this diagnostic to the user while the agent terminal can run it.
The structured `ocuclaw_setup` receipt locates the checkpoint, but CLI stdout is the sole source of the exact apply command.
If the CLI is genuinely absent
from the agent PATH, use the trust-ladder user-terminal handoff from the main
skill and continue from the pasted, unmodified stdout.

Record its `ready | absent | wrong | unknown` classification. For `absent` or
safely replaceable `wrong`, `doctor` prints the exact fully substituted apply
command for this host. CHECKPOINT that exact line unchanged; never construct a
Serve command from a hostname, port, or example. After OK, pass that exact
doctor-provided command to `terminal` first.

If that attempt alone reports a Tailscale permission refusal, explain that one
retry will add only the host's standard privilege-elevation prefix to the
otherwise unchanged command, then CHECKPOINT the prefixed command. In Hermes
Desktop this invokes Hermes Desktop's native approval or elevation prompt; the
user enters their password only into that masked native surface, never into
chat or tool input.
Only after `terminal` reports that native elevation is unavailable, the account
is not permitted to use it, the user cancels it, or the retry fails may you hand
the original doctor-provided command to the user for a separate administrator
terminal. Then run `doctor` again.

Continue only when the route is `ready` and the bounded reachability and relay
checks succeed. Configuration shape alone is advisory. An `unknown` result is
not a negative claim; follow the printed reason. Never use Funnel, a public
proxy, a host-wide Serve reset, or a command that changes another service's
route. One host has one OcuClaw-managed route, shared by the owning gateway's
Hermes profiles.

## Step 8 · Phone Tailscale

Refresh the tailnet immediately before asking about the phone:

```bash
tailscale status --json
```

This is a read-only agent Terminal check. From `Peer`, select only entries with
`Online: true` whose `OS`, case-insensitively, is `android` or `ios`. Use each
candidate's current `HostName`; a remembered device name is not evidence.

- One candidate: use `clarify` to ask whether that named phone is the one being
  paired, with Yes and No choices.
- Two or three candidates: use one `clarify` device-choice question naming each.
- More than three candidates: walk the current names with one `clarify` yes/no
  question at a time until the user confirms one.
- No candidates, or the user rejects every candidate: ask them to open Tailscale
  on the intended phone. Use `clarify` for Connected / Not yet, then rerun the
  JSON check. Continue only after the chosen phone appears online.

Record the confirmed current hostname in the lane card. The completion criterion
is one user-confirmed phone candidate that the fresh JSON reports online.

## Step 9 · Securely pair the phone

Continue only from a current successful `doctor` receipt whose
`journey.nextCheckpoint` is `secure-phone-pairing`. The Step 8 confirmation
that Tailscale is Connected means the phone is ready, so announce that the
secure in-window pairing panel is opening and immediately call:

```json
{"operation":"pair_phone"}
```

Do not run a shell command, ask for another OK, or reproduce the QR in chat.
The supported Hermes TUI widget or Desktop runtime presenter obtains the
verified private address itself, renders the relay's canonical QR directly,
and advances automatically when the phone connects. TUI uses `m`; Desktop uses
**Enter manually** to show the address/code for the same exchange. The user
compares the four-word safety phrase on both devices. TUI defaults to **No**;
Desktop has separate explicit refuse/approve buttons and Enter alone never
approves. The tool returns only after the relay reaches a terminal state.

If the phone camera cannot read the QR, use Manual in the phone app with the
private address and short-lived code visible in that same panel. The QR
contains only the private address, one-time exchange ID, and host ephemeral
public key. Neither initiation reveals or asks the user to enter the Relay
Credential.

`tui_required` is the compatibility code for classic CLI or another unsupported
host surface. Use the one-time TUI/Desktop handoff from Step 5 and resume here;
do not repeat completed checks. `tui_relaunch_required`
means the owned widget was repaired after this TUI started: relaunch Hermes
once and continue this checkpoint. For `tui_widget_unavailable` or
`tui_activation_port_unavailable`, retry once after confirming the relaunched
window is TUI and no other local setup owns the pairing panel. For
`desktop_plugin_unavailable`, keep Desktop open, reload Desktop plugins once,
and retry the checkpoint. Only if the supported presenter still cannot load may troubleshooting fall
back to the exact verified
`hermes ocuclaw pair --address <phoneAddress>` command in a separate direct
terminal. Never run that interactive fallback through an agent tool, pipe its
output, or relay its QR through the model.

## Step 10 · Phone-origin hello

Tell the wearer:

> Send a short message from the OcuClaw phone app, such as “hello from my
> glasses.” I’ll detect it automatically. I’ll still ask whether its reply
> appeared on your Even G2, because only the wearer can confirm the display.

Immediately call:

```json
{"operation":"wait_phone_origin"}
```

Do not ask the user to report that they sent the message. The tool returns only
after the managed gateway completes a new phone-origin turn, or after its
bounded wait expires. Do not replace this with a host-originated CLI message.
Retain `phoneOriginAction.candidateId` for the next private tool call. It is an
opaque, secret-free race binding; never print or explain it to the user.
After `phoneOriginAction.received: true`, use `clarify` once: “Did the reply
appear on your Even G2?” Offer exactly “Yes, the reply appeared” and “No, nothing
appeared,” with neither answer recommended. The selected answer is the wearer
evidence; advance immediately on Yes and diagnose on No. This physical display
confirmation remains mandatory. Check the newest gateway log only when diagnosis
is needed:

- `[ocuclaw] relay client connected` proves the app reached the relay.
- `relay rejected connection: invalid token` -> `APP-CONNECT-FAIL` token lane.
- neither line after a fresh tap -> `APP-CONNECT-FAIL` route/address lane.

Only after the wearer confirms the reply on G2, say:

> Got the phone message. A Hermes welcome surface will appear on your G2.
> Double-tap it once; I’m waiting for the confirmation now.

Then immediately call:

```json
{"operation":"welcome_round_trip","phoneCandidateId":"<candidateId returned by wait_phone_origin>"}
```

Do not ask the wearer to report the double-tap. The call blocks while the
managed gateway renders the welcome surface and waits for its direct result.
The response must say `firstRunProofAction.armed: true` and
`firstRunProofAction.welcomeDelivery.committed: true` (or report an already
`committed` proof). An Attempt alone is never proof or completion. If arming or
the wait fails, stop the completion ceremony and use the returned support
reason. The host tool rejects the action if a newer phone-origin candidate has
replaced the one the wearer confirmed; restart at the phone-origin hello rather
than binding a different phone. Never move the setup conversation onto the
phone to obtain that binding.

The managed gateway watches the private Attempt and renders exactly this locked
object to the bound phone/G2 session—no extra key or changed value:

```json
{
  "kind": "text_surface",
  "template": "image_caption",
  "imageAsset": "hermes_welcome",
  "body": "Welcome to OcuClaw on Hermes",
  "timeoutMs": 60000
}
```

Do not call `render_glasses_ui` from either the host or phone conversation; its
live control link belongs to the managed gateway process. If the welcome screen
appears a second time, the wearer double-taps it once more: the one automatic retry
is already covered by the blocking tool call. The deterministic
gateway handler, not assistant prose, consumes the live result. Only
`firstRunProofAction.welcomeDelivery.committed: true`, confirmed by
`firstRunProofAttempt.committed: true` and snapshot `firstRunProof.state:
proven`, permits this announcement:

> Got it! OcuClaw on Hermes is set up. I saw your message reach the glasses and felt
> your double-tap come back—the connection works in both directions.

Record `First-Run Proof: committed`, make the announcement once, and then
continue to Step 11. Do not announce merely because the image rendered, the
Attempt exists, or the wearer says they tapped.

On an outer `timeout`, `window_expired`, `recipe_failed`,
`glasses_disconnected`, a link error, or any missing dismissal, inspect
`firstRunProofAttempt` in the next status receipt. The gateway owns its one
automatic retry inside the blocking call; do not ask for a typed progress
report or call the surface yourself. If the retry commits, announce normally.
When the status receipt says `warningRequired: true`, do not arm or render
again, do not persist or claim proof, and say:

> Your phone-to-G2 reply was confirmed, but the G2-to-agent double-tap is still
> unconfirmed, so OcuClaw on Hermes is not fully proven complete. You can
> continue with optional additions, but keep this warning visible. If you want
> help, open OcuClaw's built-in Report a bug feature and send the diagnostic
> report.

Record `First-Run Proof: warning`. Continue to Step 11 only after the warning
and support path are visible. A resumed `armed` Attempt continues here within
one hour; an `expired` or `failed` Attempt restarts with a fresh phone-origin
turn and G2 confirmation. A later outage changes Current Connection Health but
never erases a previously committed First-Run Proof or reopens completion.

## Step 11 · Voice input via Soniox [OPTIONAL — recommended]

Offer this step and wait for a yes/skip before doing anything else:

> Would you like to set up voice input? You will be able to speak to the agent
> from the glasses. It needs a Soniox account and API key. Say yes to continue
> or skip to move on.

If accepted, check only `sonioxApiKeyPresent` through
`{"operation":"status"}`. When it is absent, mark this wizard as USER ACTION
REQUIRED; the assistant must not execute it:

```bash
hermes gateway setup
```

Have them select OcuClaw and use its masked optional prompt. Never solicit or
display the value in the guided conversation. Continue only when a fresh
status receipt reports the presence boolean as true.

Warn about the brief interruption, restart Hermes once, then verify the user
can tap the microphone/listen control on the glasses, speak a short phrase,
and see the transcription appear as their message:

```bash
hermes gateway restart
```

Failure to activate voice or transcribe -> `ESCALATE`, recording Step 11 as
the failing lane. A skip is an intentional optional-step outcome, not a block.

After Step 11 resolves, offer Even AI and wait for a separate yes/skip. If
accepted, first check only `evenAiTokenPresent` through
`{"operation":"status"}`. When it is absent, use the same USER ACTION REQUIRED
`hermes gateway setup` wizard; the assistant must not execute it. Have them
select OcuClaw and use its masked optional prompt. Never solicit or display the
value. Continue only when a fresh status receipt reports the presence boolean
as true.

When the secret-presence boolean is already true, enable the non-secret route:

```bash
hermes config set platforms.ocuclaw.extra.evenAiEnabled true
```

Optional non-secret Even-AI settings use their dotted keys:

```bash
hermes config set platforms.ocuclaw.extra.evenAiSystemPrompt "<VALUE>"
hermes config set platforms.ocuclaw.extra.evenAiRoutingMode active
# active | background | background_new only; any other value is rejected
```

Run one `hermes gateway restart` phase and verify the accepted Even-AI behavior.
After both choices have resolved, do not explain the support path separately
here. The final `wrap_feedback` response owns the single support explanation,
including connected and offline fallbacks. Load troubleshooting `ESCALATE`
only for an actual failure, not as part of a successful finish.

If the lane card says on-multiple, the `PROFILE-AUTHZ-DROP` lane must already
have established an intentional restrictive or authz-open posture. Reconfirm
that unauthorized secondary turns are silent for the wearer and log
`Unauthorized user:` server-side.

## Step 12 · OcuClaw look for Hermes Desktop [OPTIONAL — offer, never assume]

Skip this step entirely when the user is not using Hermes Desktop (the TUI has
no theme to apply). Otherwise read `status.desktopTheme.offer` from the
receipt you already have. It says exactly one of four things:

- `already_enabled` -> say so in one line and go to the wrap. Change nothing.
- `unavailable` -> the OcuClaw Desktop plugin file is not on this profile; the
  gateway installs it on start, so this belongs to Step 5's restart, not to
  this step. Skip and go to the wrap.
- `unknown` -> the configuration was unreadable; that is the
  `config_unreadable` problem. Skip and go to the wrap.
- `offer` -> make the offer below.

CHECKPOINT. Ask, in plain words:

> Would you like Hermes Desktop to use the OcuClaw look? It is a dark theme —
> observation-deck black with the Even G2 lens green — and it stays dark in
> both Light and Dark modes. The built-in themes stay one click away in
> Settings > Appearance, and disabling or uninstalling OcuClaw returns Desktop
> to its default skin. Yes or no?

A no is a legitimate finished answer; record it and move on. The theme is
still listed in Settings > Appearance > Theme for later.

On an explicit yes, call the setup tool once:

```json
{"operation":"enable_desktop_theme","confirm":true}
```

`confirm: true` is what makes it write — never send it before the user has
said yes. The tool records the answer through Hermes' own configuration writer
and re-renders the OcuClaw Desktop plugin; Hermes Desktop reloads that plugin
on its own and switches. VERIFY from the receipt that
`desktopTheme.applied` is `true`. Then read `desktopTheme.autoSelect`:

- `true` -> tell the user Desktop switches by itself within a few seconds; no
  restart.
- `false` -> this Hermes Desktop cannot be switched from a plugin (that arrives
  in 0.20.6). Tell the user to open Settings > Appearance > Theme and pick
  **OcuClaw**; the receipt's `desktopTheme.message` has the exact sentence.

If the tool returns `desktop_plugin_unavailable` or `config_unwritable`,
report the receipt and continue to the wrap without retrying.

Only after every choice has resolved, call
`{"operation":"wrap_feedback"}`.
