# OcuClaw fresh install on Hermes — Steps 1–12 (plus Step 4b)

**Guide version:** 2026-09-21 (1.3.22-hermes)

Keep using the loaded setup skill for guardrails, the lane card, and the
internal completion checklist.

**HOST OWNERSHIP.** Setup stays in this host conversation from the first check
through the welcome dismissal. On every entry or post-restart resume, obey the
setup receipt's `journey.nextCheckpoint` and do not repeat an earlier step.
The phone/G2 conversation is only the proof subject. Do not ask the user to run `/ocuclaw-setup` in the phone app or to continue setup there.

**FINISH CONTRACT.** A successful Step 10 phone-origin reply is not the finish.
Reply evidence arms the one-hour First-Run Proof Attempt — either the phone
app's accepted glasses SDK receipt for that exact reply, or the wearer's own
confirmation; the two are never conflated. Only the exact
Hermes Welcome Round Trip returning `dismissed` or `back` commits durable proof
and permits the completion announcement. One immediate retry is allowed. After
a second failure, offer a fresh verification attempt or continue with the visible
split-truth warning and support path below; never claim completion. Soniox and Even AI remain separate
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
outside `>=0.21.1,<0.22.0` -> `HERMES-GATE-REFUSED`, regardless of the shell
probe. Only when `hermesVersion` is `"unknown"` does the probe decide: Hermes
0.21.1 or a later 0.21.x is PASS, and an earlier version (0.21.0 included) or a
later line -> `HERMES-GATE-REFUSED`.
`command not found` beside a supported `status.hermesVersion` is the
trust-ladder case: Hermes is installed; continue, handing commands to the
user's terminal. Only when the probe fails *and* `hermesVersion` is `"unknown"`
is Hermes itself missing — installing Hermes is outside this skill; point to
the official Hermes installation docs and return when the command works.

Before the gateway restart, follow [Agent choice](agent-mode.md): offer
creation and switching as the recommended option, record the user's choice,
and require `status.mandatoryConfiguration.agentModeChosen: true`. Do not
silently default to single-agent mode or require an authorization bypass.

On Cloudways, prepare Steps 2–4b in a freshly launched TUI before the first
managed-gateway activation. Installation/enabling loads the setup skill and
tools in that fresh process and bootstraps the credential; it does not activate
the old managed gateway. Use Hermes tool discovery if `ocuclaw_setup` is
deferred. If the fresh TUI cannot load the installed setup tool or bootstrap
the credential, record the precise prerequisite and use the necessary activation
restart with the reconnect handoff. Never claim reduction by ignoring a failed
bootstrap. Keep any required migration restart under its existing ownership.

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
OcuClaw needs Hermes `>=0.21.1,<0.22.0`; the certified baseline is Hermes
`0.21.3`. Install it once, in the default Hermes profile: that profile owns the
relay the glasses pair to, and a second copy in another profile is never the
answer.

**Repository access.** `ocuclaw/ocuclaw` is a public repository and needs no
invitation or GitHub sign-in to clone. Git must still be installed and working
on the installing machine (Desktop uses Git too). Verify with
`git ls-remote https://github.com/ocuclaw/ocuclaw.git HEAD` before installing;
never paste an access token into setup chat. Even Hub beta access is a separate
invitation, and the software itself is still beta.

**Terminal first.** This is the supported path and the one every beta build is
tested on:

**Cloudways managed Hermes: install, restart once, then one command.**

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes gateway restart
hermes ocuclaw cloudways setup
```

`hermes ocuclaw cloudways setup` takes the host from an installed plugin to a
paired phone and an evidenced first reply, in numbered steps `[1/8]` to `[8/8]`
in your own terminal. It reads live state before every step and skips what is
already done. It asks twice, showing exactly what changes and defaulting to no.
There is no retry flag: run the same command again and it continues where it
stopped.

**One restart, one run.** The restart above is the only one this install needs.
If anything interrupts the run, including a restart that closes SSH, Hermes and
tmux, reconnect with the Cloudways SSH command and run the same command again:
it skips what is done and carries on from there.

**The command looks for your phone before it pairs it.** Step 5 asks you to
install Tailscale on the phone and approve the link there. Step 7 then checks
whether a phone is on your private network. If one is, it says so and carries
on. If none is, it explains what Tailscale is, gives you three short steps, and
waits, checking again every few seconds; it carries on by itself the moment
your phone turns up, and pressing Enter carries on anyway. The wait stops after
ten minutes, having changed nothing, and running the same command again picks
up right there. Leave Tailscale switched on afterwards: the phone needs it to
reach this server.

**The pairing code waits for you.** It lasts two minutes, so step 7 asks you to
have the phone in your hand with the Even app open, and waits for you to press
Enter before it makes the code. If a code does run out before anyone uses it,
the command does not give up: press Enter for a new one, or type `stop` to
finish there.

**Check your agent's model before you start.** Step 8 sends a real message
through your agent and waits for its reply on the glasses. Run `hermes -z hello`
first. If your model answers, step 8 will too. If it returns an error, such as a
rate limit, step 8 says so, records nothing, and asks you to fix the model and
run the same command again.

The guided assistant remains the fallback: open a fresh `hermes --tui`, enter
`/ocuclaw-setup`, and it walks the same path with you. It loads the setup skill
and tools in that fresh process, saves your agent choice and required settings,
gives you the SSH reconnect command and the exact saved-session resume command,
and requests one planned activation restart. Resume that setup session by its
ID; do not blindly reopen the latest chat. Saved configuration is not gateway
activation: the assistant must verify the new gateway and relay.

For other hosts, the direct install/restart sequence is:

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
installed but not loaded by that managed gateway, and nothing about the glasses
works through it yet. A fresh TUI can prepare setup before that activation.

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

**Cloudways Managed AI Agents.** The same install block applies. That host has
no root and no system Tailscale, so OcuClaw carries its own path for it, and
`hermes ocuclaw cloudways setup` runs the whole of it: a user-owned userspace
Tailscale under `~/bin` and `~/.tailscale`, a Hermes cron watchdog that starts
it again after every `hermes gateway restart` (a container restart there), the
private tailnet route, the pairing ceremony and the first message. Cloudways has
approved those pieces. Your only manual steps are opening the Tailscale
authorization link it prints and the phone.

The same work is still available one verb at a time (`hermes ocuclaw cloudways
detect`, `install`, `enroll`, `status`, `retry`, `enable`, `disable`,
`rollback`), and `/ocuclaw-setup` still guides the whole path when you would
rather be walked through it.
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

On Cloudways, all required settings and agent choice must already be saved.
Use the exact reconnect/session handoff in `quick_reference` before activation.
Record one basic restart only when requested; after interruption, recover the
saved session and verify the resulting gateway rather than requesting another.
An already-configured resume whose activation was verified skips this step.

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

First, one read-only host check:

```bash
hermes ocuclaw cloudways detect
```

If it reports `cloudways`, or `likely` and the user confirms a Cloudways
Managed AI Agents host, call `{"operation":"cloudways"}`. The system
`tailscale` does not exist there, and `TS-NOT-INSTALLED` must not be entered.
Otherwise continue with the rest of this step.

On a Cloudways host, offer the one command:

```bash
hermes ocuclaw cloudways setup
```

It runs Steps 6, 7, 9 and 10 in the user's own terminal as its own numbered
steps `[1/8]` to `[8/8]`: Tailscale, the private route, the pairing ceremony
and the first message, ending at the evidenced reply and the welcome hand-off.
It asks the user twice, each time showing exactly what changes and defaulting
to no. Read `{"operation":"cloudways"}` → **Fast path: one command** before you
offer it, and say what it does in plain words first.

**Step 8 · Phone Tailscale is no longer yours to finish first.** The ladder's
step 5 asks the user to install Tailscale on the phone and approve the link
there, and its step 7 looks for a phone on the tailnet before it pairs: it says
one line if a phone is there, and otherwise explains Tailscale, walks the user
through installing it and waits up to ten minutes, carrying on by itself when
the phone appears. Doing Step 8 first is still welcome and makes that check a
single line. Read `{"operation":"cloudways"}` → **The step 7 phone check** for
every ending before you describe it.

**One activation restart.** After install, restart the agent to load OcuClaw,
then run setup. Step 3 checks OcuClaw is loaded. Settings awaiting an agent
restart do not block Core Setup Completion on Cloudways: Continue here activates
at the next agent restart. If setup stops or SSH drops, rerun the same command
to resume; there is no `--retry`.

When the user takes it, let their terminal own those steps. Do not run the
same verbs alongside it. When it returns, obtain fresh setup and status
receipts and follow `journey.nextCheckpoint`; do not repeat a step the ladder
already finished. Its exit codes are 0 done or cleanly handed off, 1 a problem,
2 stopped before or after something the user or the host has to do.

When the user would rather be walked through it, or the one command stops part
way, follow C1–C5 in `{"operation":"cloudways"}` in place of Steps 6 and 7 and
rejoin at Step 8.

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
command for this host. CHECKPOINT through Hermes' `clarify` tool: explain in
`clarify.question` that this creates only OcuClaw's private Tailscale Serve
route from :8446 to the loopback relay at 127.0.0.1:47801, without Funnel or
public exposure. Include the exact doctor-provided command unchanged as an
indented plain-text line, then ask “Apply this route now?” Offer **Apply route**
and **Not now**. Never construct a Serve command from a hostname, port, or
example. After **Apply route**, pass that exact command to `terminal` first;
on **Not now**, leave the checkpoint pending. Ask in prose only if `clarify`
is unavailable; a selection requires no typed approval afterward.

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
> glasses.” I’ll detect it automatically.

Immediately call:

```json
{"operation":"wait_phone_origin"}
```

Do not ask the user to report that they sent the message. The tool returns only
after the managed gateway completes a new phone-origin turn, or after its
bounded wait expires. Do not replace this with a host-originated CLI message.
Retain `phoneOriginAction.candidateId` for the next private tool calls. It is an
opaque, secret-free race binding; never print or explain it to the user.

After `phoneOriginAction.received: true`, call the delivery check for that same
candidate:

```json
{"operation":"wait_reply_delivery","phoneCandidateId":"<candidateId returned by wait_phone_origin>"}
```

This is one bounded check, about 40 seconds. It never asks for a new phone
message and never restarts `wait_phone_origin`. Read `replyDelivery.status`:

- `sdk_accepted`: the phone app reported that the glasses SDK accepted the
  reply. Say plainly what that is:

  > Your phone app confirms the glasses accepted that reply, so I won't ask you
  > about the display.

  Never say the wearer saw it, never say it was displayed, and never claim the
  wearer confirmed anything. Continue straight to the welcome double-tap below
  with `"replyEvidence":"client_sdk_receipt"`.
- `unconfirmed`, `unsupported` or `pending`: the app could not attribute or
  confirm the write. If `replyDelivery.reason` is `client_disconnected`, or the
  phone leg is unhealthy in the same receipt, give reconnect guidance first:
  ask the wearer to reopen the OcuClaw phone app and wait for it to reconnect,
  then repeat the delivery check once. Otherwise use `clarify` once: “Did the
  reply appear on your Even G2?” Offer exactly “Yes, the reply appeared” and
  “No, nothing appeared,” with neither answer recommended. The selected answer
  is the wearer evidence; advance on Yes with
  `"replyEvidence":"wearer_confirmed"` and diagnose on No. Never arm after a
  “No”, and never treat a missing answer as approval.

Check the newest gateway log only when diagnosis is needed:

- `[ocuclaw] relay client connected` proves the app reached the relay.
- `relay rejected connection: invalid token` -> `APP-CONNECT-FAIL` token lane.
- neither line after a fresh tap -> `APP-CONNECT-FAIL` route/address lane.

Only with one of those two kinds of reply evidence in hand, say:

> Got the phone message. A Hermes welcome surface will appear on your G2.
> Double-tap it once; I’m waiting for the confirmation now.

Then immediately call, with the evidence you actually hold:

```json
{"operation":"welcome_round_trip","phoneCandidateId":"<candidateId returned by wait_phone_origin>","replyEvidence":"client_sdk_receipt"}
```

Send `"replyEvidence":"wearer_confirmed"` instead when the wearer answered the
display question. Claiming `client_sdk_receipt` without a matching accepted
record is refused with `reply_evidence_unavailable`; fall back to the `clarify`
question and retry with the wearer answer.

Do not ask the wearer to report the double-tap. The call blocks while the
managed gateway renders the welcome surface and waits for its direct result.
The response must say `firstRunProofAction.armed: true` and
`firstRunProofAction.welcomeDelivery.committed: true` (or report an already
`committed` proof). An Attempt alone is never proof or completion. If arming or
the wait fails, stop the completion ceremony and use the returned support
reason. The host tool rejects the action if a newer phone-origin candidate has
replaced the one the evidence belongs to; restart at the phone-origin hello rather
than binding a different phone. Never move the setup conversation onto the
phone to obtain that binding.

The managed gateway watches the private Attempt and renders exactly this locked
object to the bound phone/G2 session—no extra key or changed value:

```json
{
  "kind": "text_surface",
  "template": "image_caption",
  "title": "Double-tap to continue",
  "imageBase64": "<the gateway's built-in 288x144 lockup picture>",
  "imageWidth": 288,
  "imageHeight": 144,
  "body": "Welcome to OcuClaw on Hermes",
  "timeoutMs": 60000
}
```

The picture is a collab lockup the gateway carries itself: Hermes × OcuClaw, or
Hermes × OcuClaw × Cloudways on a Cloudways managed host. You never supply it.

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

Say only what the evidence supports. With SDK-only reply evidence, the reply
leg is “your phone app confirmed the glasses accepted the reply”, never “you
confirmed seeing the reply”. The double-tap proves the welcome surface, not
that the earlier reply was read.

Record `First-Run Proof: committed`, make the announcement once, and then
continue to Step 11. Do not announce merely because the image rendered, the
Attempt exists, or the wearer says they tapped.

On an outer `timeout`, `window_expired`, `recipe_failed`,
`glasses_disconnected`, a link error, or any missing dismissal, inspect
`firstRunProofAttempt` in the next status receipt. The gateway owns its one
automatic retry inside the blocking call; do not ask for a typed progress
report or call the surface yourself. If the retry commits, announce normally.
When the status receipt says `warningRequired: true`, do not reuse that failed
Attempt, persist or claim proof. Say:

> The reply to your phone message checked out, but the G2-to-agent double-tap is
> still unconfirmed, so OcuClaw on Hermes is not fully proven complete. You can
> continue with optional additions, but keep this warning visible. If you want
> help, open OcuClaw's built-in Report a bug feature and send the diagnostic
> report.

Record `First-Run Proof: warning`. Before Step 11, ask through `clarify`:
“Retry verification” or “Continue with the warning”. On retry, keep the healthy
paired connection and return to the Step 10 phone-message instruction and
`wait_phone_origin`; obtain a fresh candidate, run `wait_reply_delivery` again
and take whichever reply evidence that check or the wearer answer yields,
then narrate the double-tap before the new eligible welcome call. Do not reinstall,
reset the relay credential, or pair again unless current health identifies a
separate connection fault. A late dismissal of the old image never counts.
On continue, keep the warning and support path visible during optional setup.
A resumed `armed` Attempt continues here within
one hour; an `expired` or `failed` Attempt restarts with a fresh phone-origin
turn and fresh reply evidence. A later outage changes Current Connection Health but
never erases a previously committed First-Run Proof or reopens completion.

## Step 11 · Optional voice and Even AI setup

After recorded core completion, give one short handoff: **on your phone, open
the Optional setup card above your agents > Choose what to add**. Settings >
Optional setup always provides re-entry. Dismissing Home's invitation is separate
from skipping Voice or Even AI. They can stop, skip each choice or return
later. This is not a ninth Cloudways stage. Keep a pending welcome warning visible
if they chose to continue without that proof; optional work never clears it.

For a new optional continuation, ask about voice and Even AI separately. For an
existing user's specific request, enter only that capability after a narrow
read-only check; keep core receipts, pairing and other integrations intact.
Keep the questions and popups separate. Never infer consent to one from the other.
On a matching installed bundle advertising the private phone interface, use its
dedicated Choose/Save/Try or Unlock/Connect/Try pages. Enter secrets only in the
masked private form, confirm existing-secret replacement separately, and choose
**Save privately**. Gather saves independently, then **Review activation** and
confirm the supported host action. Unsupported lifecycle support stays pending
with the existing host handoff; never substitute an unadvertised restart.
Candidate source does not establish availability in a published bundle.
Desktop and terminal alternatives use the **Activation barrier** below.
Saved, available-to-test and verified behavior are separate states. Resume from
fresh status after an interruption; do not repeat a resolved question or save.

Check that this installed bundle advertises `optional-setup` and the relevant
`even-ai` commands before recommending them. An older bundle uses its supported
private setup entry or remains unavailable; never invent commands or pass secrets
through arguments, chat, screenshots or logs.

### Choose the speech path

In phone Voice settings, **Soniox** shows words live and requires a Soniox project
and key. **Hermes** transcribes after speech ends using an explicitly selected
available provider. Model/chat sign-in does not prove speech support. Refresh the
reported providers, preserve the current choice if one is unavailable, then start
the spoken test for the selected provider/model. Local speech requires an already
installed model: OcuClaw refuses missing files instead of downloading them. Any
model preparation is a separate explicit choice on the Hermes computer. Opening
settings or declining voice never installs a model or changes the provider.

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

Once the Soniox key is ready, the supported phone path is **Optional setup >
Voice > Soniox > Save**. Enter it privately, confirm a replacement if needed,
and choose **Save privately**. Fresh readback must confirm the save. Activation
and the selected spoken test remain separate checkpoints.
After activation, use the Try step for the selected provider/model and speak a
short phrase. Only its matching final transcription is speech proof; typed chat,
old transcripts and key presence are not. A changed configuration or connection
needs a fresh test, while pairing and completed core setup remain intact.

<details><summary>Advanced: Desktop or private terminal entry</summary>

For users choosing Desktop, **Desktop users stay in Desktop**.
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
hermes ocuclaw optional-setup save soniox
```

Have them enter the Soniox key in the hidden prompt. Blank input preserves an
existing value or skips a missing one; cancellation preserves prior settings.
This command leaves Even AI unchanged and does not restart the gateway.
Never solicit or display either value in the guided conversation. Never use
`clarify` or a chat text box for secrets. Continue only when a fresh status
receipt reports a confirmed save. Presence alone does not establish activation.
Keep the save pending while another chosen optional capability is being prepared;
then use the activation barrier. Return to **Settings > Optional setup > Voice**,
start the selected spoken test and speak a short phrase. Only its matching final
transcription establishes speech proof; typed chat and old transcripts do not.
A stale configuration, reconnect, unavailable provider or failed test needs a
fresh check, preserving text chat and the other optional choice. A skip is a
finished optional choice, not a core blocker.

</details>

Do not offer either integration again after its choice has resolved. A direct
minimal activation request from an installed and healthy host enters the same
lane after the required read-only status check; it does not replay Steps 1–10.

### Even AI activation lane

After Soniox is configured or skipped, ask this separate CHECKPOINT question:

> Would you like to connect the Even Realities app's own Even AI feature to
> your Hermes agent? This uses Agent Configuration in that app and a private token.

If they decline, record the skip, activate and verify any pending Soniox change
using only the **Activation barrier** below; skip all
Even AI checkpoints and settings, then continue to Step 12. If they accept, follow
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
On the advertised phone interface, use **Optional setup > Even AI > Connect**.
Enter the user-chosen secret in the masked field and choose **Save privately**;
confirm replacement before entering a new value over an existing one.
Keep the same secret for the Even app. Refresh readback before activation.

<details><summary>Advanced: Desktop or private terminal entry</summary>

In Desktop, call `{"operation":"request_credentials","integrations":["evenAi"]}`.
The **Private Even AI token** popup contains only its token field. Have them
choose **Save privately**. A cancel is a valid skip; do not reopen without a
new request. The command palette entry **Set up OcuClaw Even AI** reopens it later.
For terminal users, hand off `hermes ocuclaw optional-setup save even-ai` for
hidden entry on their own terminal. It saves this token and enables Even AI
without changing Soniox. The assistant must not supply or read the secret.
Never echo, display, log or return it. Continue only after a fresh confirmed
save; token presence (`evenAiTokenPresent: true`) alone is not activation or real-request proof.

#### Checkpoint 3 · Enable Even AI on Hermes

The private `optional-setup save even-ai` command also checks the enabled
setting through Hermes's supported writer. Desktop private entry saves the
token; use that same terminal command with a blank value to preserve the token
and finish enabling if needed. A failed enable remains failed even if the token
was saved. Preserve the other optional change and keep the failure visible.

</details>

**Activation barrier (Cloudways and local).** Finish or skip each chosen save.
On the supported phone interface, choose **Review activation**, read its restart
and affected-profile disclosure, then explicitly confirm. Save alone does not
restart Hermes. Preserve reconnect details first. After reconnecting, refresh
the current loaded state; never replay an uncertain apply operation automatically.
If activation is unavailable, use the host's supported handoff and retain pending
state. An applied operation receipt is for status checks only.

<details><summary>Advanced: terminal activation or unsupported phone lifecycle</summary>

For the advertised terminal activation flow, run:

```bash
hermes ocuclaw optional-setup status
hermes ocuclaw optional-setup activate
```

The activation command admits one required restart only after completed saves.
It warns that every profile on the gateway is interrupted and asks for the full
word `ACTIVATE`. Preserve the exact reconnect and saved-session commands from
`quick_reference` first. On an unsupported automatic lifecycle, follow its
Cloudways dashboard handoff; restarting there closes SSH and Hermes. Do not add
an independent generic restart or retry a restart whose result is uncertain.
Cancellation leaves the saves pending. A skipped Even AI choice is never enabled
by Soniox-only activation.

After reconnecting, run `optional-setup status` again. It compares fresh loaded
runtime settings with the saved choices. `available_to_test` permits a test;
`saved_not_activated`, `save_failed` and `unknown` remain explicit gaps. A healthy
gateway alone is not activation evidence. Verify voice and Even AI separately,
and keep all optional outcomes separate from Hermes Core Setup Completion.

</details>

#### Checkpoint 4 · Approve and verify the private :8443 route

The phone's **Review private route** opens guidance and current review only.
It does not apply Serve. Keep route approval separate from private secret entry,
save and activation; the host procedure below retains its explicit gate.

Use the installed read-only classifier. It resolves this selected
Primary Runtime's local port, this host's tailnet DNS name, and the current
Serve document from the supported live evidence surfaces:

```bash
hermes ocuclaw even-ai route
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
runs. After an approved apply, run `hermes ocuclaw even-ai verify` and
require its fresh live Serve result to match the active runtime. The assistant
tool's read-only `{"operation":"even_ai_route"}` remains a supported classifier;
its `verified_noop` / `route_matches` result is route evidence only.
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

The verify command reports only route/activation availability, never a verified
real request. Have the wearer make a real request from the glasses through Even AI and
confirm that their Hermes agent answers. An enabled flag, host configuration,
route shape, endpoint response, or WebUI state alone is not end-to-end success.
Do not claim `g2-validated` without wearer-confirmed real G2 evidence.

### Optional diagnostics

Return to **Settings > Optional setup > Diagnostics** only if the current backend
advertises support. Unsupported controls stay unavailable; do not borrow OpenClaw
commands for Hermes. Diagnostic access and full-bundle phone handoff are distinct
permissions. Handoff permits review on the phone, while **Send** is a separate
user action for each upload. Skipping or later revoking either permission leaves
core completion, pairing and working integrations intact.

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
