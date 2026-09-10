# OcuClaw fresh install on Hermes — Steps 1–12 (plus Step 4b)

**Guide version:** 2026-09-10 (1.3.20-hermes)

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

On first setup, when no durable pairing/completion receipt or recorded G2
answer exists, ask through `clarify`: "Do you already have Even Realities G2
glasses?" Offer "Yes, I have G2 glasses" and "Not yet". Record the answer in
the lane card; an interruption does not reset it.

If not yet, explain that glasses are needed for pairing and the welcome proof,
then offer: "Would you like me to open the Even website to check them out?"
Use "Open the website" and "Not now". Declining is final: open nothing and
leave setup incomplete, ready to resume when they have glasses. Do not turn
this into a purchase requirement or claim hardware proof.

After an explicit yes, open exactly `https://evenrealities.sjv.io/Even` once.
On a confirmed local graphical host, use the available host Python interpreter
with `-m webbrowser -n https://evenrealities.sjv.io/Even` through the terminal
tool. This requests a new system-browser window outside Hermes. Verify the
opener's result; an accepted request does not prove the page loaded, and the
OS/browser may reuse a window. Do not install a browser, create a new profile,
or change the default browser. If the backend is remote/headless, its location
is uncertain, or opening fails, provide
[View G2 glasses](https://evenrealities.sjv.io/Even) and say to Ctrl-click
(Command-click on macOS) or middle-click in Hermes Desktop to open it in the
system browser; an ordinary click opens Hermes' embedded browser on 0.21.0.
Record opened, declined, or handoff without repeating the offer on resume.
Pause pairing until the user has glasses; local configuration can continue
only if they explicitly ask to prepare it in advance.

For someone who has G2 glasses, continue with the existing readiness question:

Ask: "Are your glasses paired in the Even Realities app, and can you open Even
Hub on your phone?"

Then run the read-only host gate:

```bash
hermes --version
```

When `{"operation":"status"}` reports a non-unknown `hermesVersion`, that
receipt decides the gate: PASS when it is inside `supportedRange`; a version
outside `>=0.21.0,<0.22.0` -> `HERMES-GATE-REFUSED`, regardless of the shell
probe. Only when `hermesVersion` is `"unknown"` does the probe decide: Hermes
0.21.x is PASS, and an earlier or later version -> `HERMES-GATE-REFUSED`.
`command not found` beside a supported `status.hermesVersion` is the
trust-ladder case: Hermes is installed; continue, handing commands to the
user's terminal. Only when the probe fails *and* `hermesVersion` is `"unknown"`
is Hermes itself missing — installing Hermes is outside this skill; point to
the official Hermes installation docs and return when the command works.

Before the gateway restart, follow [Agent choice](agent-mode.md): offer
creation and switching as the recommended option, record the user's choice,
and require `status.mandatoryConfiguration.agentModeChosen: true`. Do not
silently default to single-agent mode or require an authorization bypass.

## Step 2 · Install from the beta bundle

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

For someone already installing through Desktop, skip this terminal reference
block. Continue with the applicable checks; do not change the terminal default
or present it as an outstanding requirement in Desktop.

<!-- ocuclaw:install-block:start -->
OcuClaw needs Hermes `>=0.21.0,<0.22.0`; the certified baseline is Hermes
`0.21.0`.

**Repository access.** `ocuclaw/ocuclaw` is a public repository and needs no
invitation or GitHub sign-in to clone. Git must still be installed and working
on the installing machine (Desktop uses Git too). Verify with
`git ls-remote https://github.com/ocuclaw/ocuclaw.git HEAD` before installing;
never paste an access token into setup chat. Even Hub beta access is a separate
invitation, and the software itself is still beta.

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

**Run `hermes` in a real terminal.** The TUI boots only when stdin *and*
stdout are a TTY, so a piped or captured run — `hermes | tee log`, a CI
capture, a headless spawner — silently falls back to the classic CLI: same
prompt, no pairing panel, and `/ocuclaw-setup` with nowhere to pair. Forcing
it with `--tui` there does not render either; it bails out instead.

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
OcuClaw ships **one** Desktop UI, and the enabled plugin generates it, so the
order is: install, then restart the gateway, and the OcuClaw UI appears in the
Hermes Desktop title bar on the next Desktop launch or reload.

1. Restart the gateway — use the native **Restart gateway** button when the
   OcuClaw card is visible, otherwise `hermes gateway restart` in a terminal. Until it
   restarts, OcuClaw is installed but not loaded, and there is no OcuClaw
   Desktop UI yet.
2. The OcuClaw setup card then appears in the title bar reading
   **Pair your glasses**. Run `/ocuclaw-setup` and finish pairing. The card
   retires on the durable pairing receipt and stays gone, including across a
   Desktop relaunch.

Desktop leaves `display.interface` alone; the terminal-default command above
applies only to terminal setup. Optional Soniox and Even AI credentials use
private Desktop forms, with masked terminal prompts available in the TUI.

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

This clones the access-controlled OcuClaw Hermes beta bundle. There is no npm or ClawHub
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

Enter here directly for `journey.nextCheckpoint: mandatory-configuration`.
The read-only `status.mandatoryConfiguration.toolProgressOff` must be true
before network setup. A healthy gateway does not prove this setting. On resume,
re-read status and skip satisfied settings; preserve all earlier receipts.

Also require `status.mandatoryConfiguration.agentModeChosen: true`. If missing,
call `{"operation":"agent_mode"}` and complete that choice before proceeding.

Also require `status.mandatoryConfiguration.adoptConfigured: true` — "Continue
here": the glasses can pick up a chat started in Hermes Desktop, the CLI or the
TUI and carry it on. It needs `platforms.ocuclaw.extra.allow_admin_from` to list
the one user id the plugin sends, `ocuclaw-wearer`. Write it on fresh AND
existing installs; never ask the user to understand slash-command gating.

Include the plugin-enable command only if `hermes plugins list` shows OcuClaw
disabled. Inspect the applicable non-secret settings first and include only lines
whose desired value is not already present; do not create no-op user commands.

CHECKPOINT:

```bash
hermes config set display.platforms.ocuclaw.tool_progress off
hermes config set platforms.ocuclaw.extra.allow_admin_from '["ocuclaw-wearer"]'
hermes plugins enable ocuclaw
```

The `allow_admin_from` line turns Hermes's slash-command gating ON for the
OcuClaw platform as a whole; that is safe because `ocuclaw-wearer` is the only
user id the plugin ever stamps, so the wearer is the sole admin and nothing else
can reach the gate. If the key already lists other ids, preserve them and append
`ocuclaw-wearer`.

The native install normally enables the plugin; the conditional command also
recovers an older disabled install. The non-secret commands keep Hermes'
conversational tool-progress bubbles out of the OcuClaw transcript. Hermes TUI
and Desktop are the guided beta pairing
surfaces: each presents the secure QR and four-word decision directly without
routing either through the model. For a terminal install only, inspect
`hermes config get display.interface` and, if needed, run
`hermes config set display.interface tui` to select the secure terminal pairing
surface. For Desktop installs, leave the terminal default alone: it is not a
completion requirement and must not appear as an unresolved setup check.
Classic `hermes --cli` hands the pairing checkpoint to TUI or Desktop. Configuration
changes require a gateway restart.

VERIFY the non-secret gate without reading any secret:

```bash
hermes config get display.platforms.ocuclaw.tool_progress
hermes config get platforms.ocuclaw.extra.allow_admin_from
```

The second read must list `ocuclaw-wearer`; re-read `ocuclaw_setup` status and
require `mandatoryConfiguration.adoptConfigured: true`.

Continue only when the tool-progress setting reports `false` (and, for a
terminal install only, the interface reports `tui`). Hermes 0.21 stores the CLI
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
reasoning streams as it is written to the glasses rather than arriving in whole pieces,
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

`--tls-terminated-tcp` requires HTTPS Certificates enabled for this tailnet in
the Tailscale admin console, under DNS, alongside MagicDNS. Without them
Tailscale accepts the route and every connection through it then fails: the
symptom is `probe_failed` plus `relay_verifier_protocol_error` on a route
classified `ready`. `doctor` prechecks this and withholds the apply command
when the certificate is unavailable, printing the admin-console fix instead.

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

## Step 11 · Optional voice and Even AI setup

Ask about Soniox first, then resolve its setup or skip before asking about Even
AI. Keep the questions and popups separate, even when the user wants both.
Never offer a combined credential form or infer consent to one from the other.

### Soniox voice setup

CHECKPOINT. Ask:

> Would you like to set up voice inside OcuClaw? Soniox lets you speak to your
> agent using the glasses mic. It needs a Soniox account and API key.

If they decline, record the skip and continue to the separate Even AI question.
If they accept, check only `sonioxApiKeyPresent` through
`{"operation":"status"}`. Keep an existing key; gather only a missing one.

For a missing Soniox key, first guide the user to https://console.soniox.com/:
sign up or sign in, open their project (new accounts start with **My First
Project**), then **API Keys** and create a key. Have them keep it private and
ready to paste into the masked prompt below, never into chat. If account or
billing setup blocks key creation, stay at that step or let them skip Soniox;
do not mark it configured. The API console is distinct from the Soniox
transcription app. These steps follow https://soniox.com/docs/stt/get-started.

Once the Soniox key is ready, **Desktop users stay in Desktop**.
Call `{"operation":"request_credentials","integrations":["soniox"]}`.
The **Private Soniox API key** popup opens automatically with just its key field.
Have them paste there and choose **Save privately**.
Blank configured fields preserve existing values. Cancellation is a valid skip;
check `desktopCredentials.state` through status and never reopen after a cancel
unless they ask. Only presence booleans return to the assistant, never values.
They can reopen later from the command palette: **Set up OcuClaw voice with Soniox**.
If the dialog is unavailable, explain that before offering the terminal fallback.

For **terminal users**, mark this wizard USER ACTION REQUIRED and show one command:

```bash
hermes gateway setup
```

Have them select OcuClaw, enter
the Soniox key in its masked optional prompt, and leave Even AI unchanged.
Existing credentials should be kept, not replaced.
Never solicit or display either value in the guided conversation. Never use
`clarify` or a chat text box for secrets. Continue only when a fresh status
receipt reports `sonioxApiKeyPresent: true`.

Warn about the brief interruption and restart Hermes only if the key changed.
Then verify the user
can tap the microphone/listen control on the glasses, speak a short phrase,
and see the transcription appear as their message:

```bash
hermes gateway restart
```

Failure to activate voice or transcribe -> `ESCALATE`, recording Soniox as
the failing lane. A skip is an intentional optional-step outcome, not a block.

Do not offer either integration again after its choice has resolved. A direct
minimal activation request from an installed and healthy host enters the same
lane after the required read-only status check; it does not replay Steps 1–10.

### Even AI activation lane

After Soniox is configured or skipped, ask this separate CHECKPOINT question:

> Would you like to connect the Even Realities app's own Even AI feature to
> your Hermes agent? This uses Agent Configuration in that app and a private token.

If they decline, record the skip and continue to Step 12. If they accept, follow
the checkpoints below. Do not reopen Soniox's popup during this journey.

This is one ordered six-checkpoint journey. Keep it in the main Hermes
conversation. A phone or G2 conversation redirects there and stops.

#### Checkpoint 1 · Unlock Agent Configuration

Have the user open https://hub.evenrealities.com/hub in a browser and log in
with the SAME email address they use in the Even Realities phone app. This
enables the beta **Agent Configuration** option in the app's **Even AI**
settings. Then return to the Even Realities app, outside the OcuClaw app,
open **Even AI**, tap the settings/sliders icon at the top right, and scroll
down to **Agent configuration** (below Reading speed).

Ask: "Can you see the Agent Configuration area in the Even AI settings of
the Even Realities app?" Agent Configuration is an area, not a URL. The Hub
website is only the login prerequisite, not the agent endpoint to paste later.
If the user already enabled this option, skip the Hub login and confirm the
area is visible; do not make them repeat activation. If absent, confirm the
same-email login and reopen the Even Realities app before continuing.

#### Checkpoint 2 · Store the private Even AI secret

First check only `evenAiTokenPresent` through `{"operation":"status"}`. If it is
false, explain that this Token is a shared private secret chosen by the user,
not a key issued by the Hub website. Have them create a strong random secret in
their password manager and keep it for Hermes and the phone's Token field.
Never generate it in an assistant response or ask them to paste it into chat.
In Desktop, call `{"operation":"request_credentials","integrations":["evenAi"]}`.
The **Private Even AI token** popup contains only its token field. Have them
choose **Save privately**. A cancel is a valid skip; do not reopen without a
new request. The command palette entry **Set up OcuClaw Even AI** reopens it later.
For terminal users, use the user-run masked wizard described above, enter only
the Even AI token, and keep Soniox unchanged. The
assistant must not execute the wizard. Never ask for, echo, display, log, or
return the secret. Continue only after a fresh status receipt reports
`evenAiTokenPresent: true`; that presence boolean is the entire receipt.

#### Checkpoint 3 · Enable Even AI on Hermes

Only after secret presence is verified, explain and request approval for the
non-secret setting:

```bash
hermes config set platforms.ocuclaw.extra.evenAiEnabled true
```

Warn once: Hermes may go quiet briefly while its gateway restarts; if it does
not return, say "continue OcuClaw setup". Apply the saved setting with exactly
one lifecycle command:

```bash
hermes gateway restart
```

Afterward obtain a fresh status receipt. Do not repeat the restart without a
new finding. Optional settings use only official dotted Hermes keys.

#### Checkpoint 4 · Approve and verify the private :8443 route

Call the assistant-visible read-only classifier. It resolves this selected
Primary Runtime's local port, this host's tailnet DNS name, and the current
Serve document from the supported live evidence surfaces:

```json
{"operation":"even_ai_route"}
```

Use only the returned `agent_url` and fully substituted `command`; never build
either from remembered or model-supplied values. The optional **Even AI agent
URL** is `https://<tailnet-dns-name>:8443/v1/chat/completions`. It is not the
**OcuClaw app relay address**, which uses the existing :8446 Managed Serve
Route.

Classify the live `:8443` state before proposing any change. An absent route
may produce this one fully substituted, tailnet-only proposal:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:<relay-port>
```

Show the exact substituted command, explain that it exposes only this
loopback relay to the user's tailnet, and wait for explicit approval before it
runs. After an approved apply, call `{"operation":"even_ai_route"}` again and
require its fresh live Serve result to be `verified_noop` / `route_matches`.
Configuration shape or command exit alone is not verification.

An already-correct route is a verified no-op. Refuse mutation when `:8443`
targets another Primary Runtime, a foreign service, an ambiguous target, or a
non-proxy web handler, or when Funnel is enabled. Never use Funnel, widen the
relay bind, publish a public address, or run a host-wide Serve reset. Do not
change or remove the :8446 Managed Serve Route, its ownership receipt, or its
teardown contract. This optional :8443 mapping is not automatically removed
during uninstall.

#### Checkpoint 5 · Configure the Even Realities app

In **Agent configuration**, choose **Add agent** (or **Edit agent** for the
existing entry). Give it a recognizable **Name**, put the **Even AI agent URL**
from Checkpoint 4 in **URL**, and enter the same private secret in **Token**.
Tap **Save**, then select that agent in **Select agent**. These labels are in
the Even Realities app, outside OcuClaw. Keep the **OcuClaw app relay address** labelled separately; it connects
the phone app and is not valid in the Even AI agent URL field.

#### Checkpoint 6 · Exercise a real glasses request

Have the wearer make a real request from the glasses through Even AI and
confirm that their Hermes agent answers. An enabled flag, host configuration,
route shape, endpoint response, or WebUI state alone is not end-to-end success.
Do not claim `g2-validated` without wearer-confirmed real G2 evidence.

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

> Would you like Hermes Desktop to use the OcuClaw look? OcuClaw black/green.
> It keeps the same dark black-and-green appearance in both Light and Dark modes. The
> built-in themes stay one click away in Settings > Appearance, and disabling
> or uninstalling OcuClaw returns Desktop to its default skin. Yes or no?

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
