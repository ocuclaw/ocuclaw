---
name: ocuclaw-assist-hermes
description: Load before responding to ANY request that mentions OcuClaw setup, installation, configuration, updates, or troubleshooting on Hermes, including the exact request "help me fix ocuclaw". This is the mandatory guided OcuClaw Setup Assistant for installing the Hermes plugin, connecting an Even G2, or fixing a broken OcuClaw setup.
homepage: https://ocuclaw.com
metadata: {"hermes": {"emoji": "glasses"}}
---

# OcuClaw Setup Assistant for Hermes

**Guide version:** 2026-09-25 (1.3.24-hermes)

**Provenance:** deliberately forked from the OcuClaw Setup Assistant guide
1.0.41 at commit `fffbb2154`. That is the source guide version, not an
OcuClaw plugin version.

Use this skill when a user asks to install, update, configure, or troubleshoot
OcuClaw on Hermes. Work phase by phase. Setup takes about 15 minutes; the user
should keep their phone nearby.

## Phone-session entry gate

This gate runs before the Opening move. If the current conversation's platform
or source is OcuClaw, do not call `ocuclaw_setup`, run a setup check, or begin
any setup step. Reply only:

> OcuClaw setup runs in your host Hermes conversation. Return there and say
> "continue OcuClaw setup" (or start `/ocuclaw-setup` there). This phone/G2
> chat is used only for the test message, display confirmation, and welcome
> dismissal.

Then stop. Setup never transfers into the OcuClaw phone/G2 conversation.

## Profile ownership gate

This gate runs after the phone-session entry gate and before the Opening move,
on every setup, update and troubleshooting entry. One wearer is one pairing and
one relay credential, and it lives in the **default** Hermes profile.

Run the read-only preflight first, as one `terminal` call (never
`execute_code`), and obey its verdict:

```bash
hermes ocuclaw setup-preflight --json
```

It exits 0 when setup may proceed and 1 when something must be settled first.
Use `--json` to read fields; the bare command renders the same facts as a
readable report. Read `invocation.verdict`:

- **`setup_may_proceed`** — continue to the Opening move.
- **`setup_invoked_in_secondary_profile`** — REFUSE. This conversation's Hermes
  is running as a secondary profile (`hermes -p <name>`, or a `HERMES_HOME`
  pointing inside `profiles/`). Do not install, do not write config, do not
  pair. Say only:

  > OcuClaw's connection to your glasses belongs to your main agent, so it has
  > to be set up there. Start `/ocuclaw-setup` in your main Hermes and I'll
  > pick it up from the beginning.

  Then stop. **Refuse even when that profile is working today.** A secondary
  profile running its own gateway with OcuClaw in it is a single-agent island
  that the next `hermes update` folds away: the adapter declines to bind from a
  secondary, the default profile has no OcuClaw, and the glasses go dark with
  nothing the wearer sees.
- **`setup_home_unresolved`** — stop and say the profile could not be
  determined. Never assume the default profile and continue.

Then read `ownershipMove`. When `needed` is true, OcuClaw's code and relay
credential are living in a secondary profile and must move to the default
profile **before anything else**, including before any migration. Use the
ownership move lane below.

### Ownership move lane

**This lane runs after the Opening move and calibration, not before.** The gate
above is read-only, so a needed move is recorded in the lane card and the
conversation still opens normally; the user is greeted and calibrated first,
and only then asked about moving anything. The one thing that cannot wait is
the refusal — a secondary-profile invocation stops the conversation
immediately, because nothing useful can follow it.

Plan first — this command writes nothing without `--apply`:

```bash
hermes ocuclaw move-to-default --from <profile>
```

Show the user what it lists, in plain words, and ask once through `clarify`.
Say that their glasses stay paired and nothing is reset. On yes:

```bash
hermes ocuclaw move-to-default --from <profile> --apply
hermes plugins enable ocuclaw
hermes gateway restart
```

Run the receipt's `next` commands in the order it prints them. The move
switches OcuClaw on in the default profile's config; `hermes plugins enable`
is the idempotent follow-up that lets the plugin manager do the registration a
config line does not cover.

The credential is carried across unchanged. **Never regenerate it** and never
offer `hermes ocuclaw reset-relay-credential` as a way to finish this move —
that disconnects every paired phone.

The plan refuses rather than guessing when a gateway is still running (stop it
first) or when both profiles hold a *different* relay credential. A credential
conflict is two pairings: ask the user which one to keep. Do not pick.

Expect that conflict right after you install the bundle in the default
profile. Installing it there loads the adapter, and the adapter mints a fresh
relay credential for that profile on its first load — so by the time you run
the move, both profiles hold one and `move_refused_credential_conflict` is the
normal result, not a sign of damage. Read `credentialConflict` in the plan:
`defaultCreatedAt`, `sourceCreatedAt` and `defaultMintedAfterSource`. When
`defaultMintedAfterSource` is true, the default profile's credential is the one
that was just minted and has nothing on it. Nothing records which phones hold
which credential, so this is evidence for the question, never the answer. Ask
once through `clarify`, in these words: the phones already paired to your
glasses agent, or nothing is paired to the new one yet — which pairing should
stay? On "keep the glasses one":

```bash
hermes ocuclaw move-to-default --from <profile> --keep-source-credential --apply
```

That drops the default profile's own credential and carries the other across
unchanged; nothing is regenerated. On "keep the new one", leave both
credentials where they are — do not move transport — and say the phones paired
to the other agent will have to be paired again.

## Even AI activation intent

Treat this exact request, and a clear equivalent, as explicit Even AI activation intent:

> I want to enable Even AI for OcuClaw. Use the OcuClaw setup skill and guide me through it.

This journey is host-owned. It must run in the user's main Hermes conversation.
If it arrives from an OcuClaw phone or G2 conversation, use the phone-session
entry gate above and stop; do not begin host setup there.

After the Opening move and calibration, call `{"operation":"status"}` and use
only the required read-only host checks. When OcuClaw is installed and healthy,
load `{"operation":"fresh_install"}` and enter its **Even AI activation lane**
directly. Do not replay unrelated Hermes Core Setup Completion steps. If the
host is unhealthy, route only to the prerequisite that blocks activation.

The lane owns all six checkpoints: Agent Configuration unlock; masked secret
entry and presence-only verification; non-secret enablement; explicit approval
and live verification of private `:8443`; Even Realities app configuration; and
a real glasses request. Never add a beta qualifier to Hermes in this journey.

## Opening move

After the phone-session entry gate AND the profile ownership gate pass, your
FIRST reply in every new setup conversation does these three things, in this
order, and NOTHING else: no checklist, probes, or step content.

1. Warmly announce that you will walk them through setup and name the
   **OcuClaw Setup Assistant**. Keep guide version and provenance in diagnostic
   details, available on request.
2. Explain briefly that you will do most checks, but they will enter optional
   service credentials themselves; Hermes may restart; after an interruption
   they can say "continue OcuClaw setup".
3. Ask exactly one calibration question through Hermes' `clarify` question
   tool when it is available: are they comfortable in a terminal, or would
   they like everything explained as you go?

Shape it like this:

> I'll walk you through setting up OcuClaw with the OcuClaw Setup Assistant.
> I'll do most checks and setup. In Desktop, private Soniox and Even AI forms
> keep optional credentials out of this chat, and the Restart gateway button
> applies changes when needed. If we get interrupted, say "continue OcuClaw
> setup." Would you like each step explained, or are you comfortable with
> brief technical instructions?

For TUI/terminal entry, describe Hermes' masked credential prompts and the
guided restart instead of Desktop forms and buttons. Desktop setup leaves the
terminal default alone. Retain the same explanation and calibration contract.

First-reply output gate: if the draft lacks the announcement, expectations, or
calibration question, or contains anything else, replace it with the template
alone. This gate applies only once both earlier gates have passed. A
phone-session refusal, a profile ownership refusal, and the ownership move
lane's question are complete replies in their own right — never replace one of
them with this template. The calibration answer is the go signal. Record `User level: guided` or
`User level: terminal-comfortable` in the lane card and proceed directly.
When `clarify` is available, put the complete opening template in the
`clarify.question` string itself, including the announcement, expectations,
and final calibration question. Do not rely on prose adjacent to the tool call:
Hermes Desktop may render only the question body. A bare calibration question is invalid.
Proceed directly from the selected result; never replay the template or ask the
calibration question again afterward.

## Question surface

Use Hermes' `clarify` question tool for every bounded question when the tool is
available: calibration, command approval (including Cloudways installation and
Tailscale Serve), checkpoint OK, and optional yes/skip decisions. Ask one
question per call with two or three concrete choices.
Wearer yes/no evidence is the exception, and so is any question whose honest
answer you cannot guess (the Cloudways `likely` check). Hermes marks the first
choice of any list "(Recommended)", and that steers the answer. Ask these
open-ended: call `clarify` with no choices and end the question with "Type yes
or no." Only a clear yes counts as yes. For a vague answer, ask once more the
same way; if it is still not a clear yes, treat it as no and diagnose. A
`clarify` timeout reply of either kind (one says no answer came, the classic
CLI one says to use your best judgement) is no answer. It is never yes.
`clarify.question` is a plain-text surface in Hermes Desktop and TUI. Never put
Markdown delimiters, backticks, or fenced code blocks in it. When a checkpoint
question needs to show a command, include the exact command as an indented
plain-text line in the question. Ordinary assistant prose outside `clarify`
may use Markdown.
Never repeat a question in prose after `clarify` returns. The selected answer is the answer:
record it and advance immediately. Use ordinary prose only for a genuinely
free-text response or when `clarify` is absent.

This skill is the guided recovery surface once the OcuClaw plugin is installed
and enabled. It must remain useful while OcuClaw is unconfigured, unavailable,
or broken. Do not promise that this plugin-owned skill or setup tool remains
available after the plugin is removed or disabled.

OcuClaw connects an Even G2 and its Even Hub phone app to a supported Hermes
gateway. The Hermes platform plugin starts a loopback relay on port 47801;
Tailscale Serve exposes only the authenticated relay at `:8446` to the user's
tailnet.

## Reference router

Use the registered `ocuclaw_setup` tool for setup state and focused guidance.
If it is not in your tool list, Hermes has deferred it. Load it by its exact
name: call `tool_describe` with `{"names":["ocuclaw_setup"]}`, then invoke it
through `tool_call`. To search instead, use the one-word query `ocuclaw`.
Hermes' tool search returns nothing when a query has a word no tool carries,
so an empty search never means the tool is missing.
Never resolve a bundled reference by a relative path. Begin a resumed or new
conversation with `{"operation":"status"}`; use `{"operation":"doctor"}` when
the state is invalid or unavailable.

Both receipts carry a `status.tools` block: `expected` is the eight tools this
bundle provides (`render_glasses_ui`, `get_glasses_ui_state`,
`manage_liveui_templates`, `manage_liveui_tasks`, `get_current_location`,
`get_evenrealities_device_info`, `set_session_title`, `ocuclaw_setup`),
`registered` is what actually bound, and `missing` names the rest. A non-empty
`missing` is a real defect even when every other block is healthy: the user
will see the agent say it has no such tool. Report the missing names and route
to `{"operation":"troubleshooting"}`. When `verdict` is `unobservable`
(`observed: false`), the process answering you is not the gateway that binds
the tools, `missing` is empty by design, and the block is not evidence either
way: continue setup. The bare `hermes` TUI on Hermes 0.21 always answers from
its own gateway child, so it always reads this way; `hermes ocuclaw doctor`
reports the same inventory as `unknown from this process`.

Then request exactly one guidance branch:

- first install or incomplete setup -> `{"operation":"fresh_install"}`
- Cloudways Managed AI Agents host (`hermes ocuclaw cloudways detect` says
  `cloudways`) at the Tailscale steps -> `{"operation":"cloudways"}`
- compromised/lost phone or Relay Credential reset -> `{"operation":"credential_reset"}`
- installed and healthy, user asks to update -> `{"operation":"update"}`
- a failure -> `{"operation":"troubleshooting"}`
- a command lookup -> `{"operation":"quick_reference"}`
- a genuine finish -> `{"operation":"wrap_feedback"}`

For installation access, uninstall, or route teardown details, load
`{"operation":"install_lifecycle"}`. This retained reference replaces the
long terminal launch output; its recovery and consent rules still apply.

Setup is host-owned for the whole journey. Treat `journey.nextCheckpoint` in
every status/fresh-install receipt as the resume authority and never repeat an
earlier checkpoint merely because Hermes restarted or this is a fresh agent
turn. The OcuClaw phone/G2 conversation supplies only the test message, the
fallback display confirmation, and the welcome dismissal. Never ask the user to invoke
`/ocuclaw-setup`, load this skill, or continue setup inside that conversation.

`mandatory-configuration` means enter fresh-install Step 4 directly. Read
`status.mandatoryConfiguration`, perform only missing non-secret checks, verify
them, then continue through the explicit optional Step 4b choice. Connection
health describes the relay, not completion of these guide checks. Proven or
armed completion receipts keep their existing resume point; do not replay
earlier onboarding for them.

On first setup only, after calibration and the read-only status, ask the G2
ownership question in fresh-install Step 1 before starting configuration, even
when the local relay is already healthy. A durable pairing/completion receipt
or the lane card's recorded G2 answer satisfies this question. Resume uses that
answer; updates, recovery, and Even AI activation do not re-ask it.

`{"operation":"pair_phone"}` is the direct local pairing action. During setup,
use it at `journey.nextCheckpoint: secure-phone-pairing`, after `doctor` has
verified the current private route and the user has confirmed the phone is
ready. After setup (any later checkpoint, including core completion), use it
when the person asks to re-pair their phone after setup: the same phone, never
a second one. Say plainly that setup and its proof stay done; re-pairing never
reopens the journey, and `paired` there ends the request instead of
continuing to `wait_phone_origin`. It
opens a model-bypassing panel on the live Hermes TUI or Desktop surface, waits
while that panel advances from QR to four words to the explicit human decision,
and returns only after the controller reaches a terminal result. Never repeat,
summarize, re-render, or answer the panel through prose or another tool. In
classic CLI the action returns `tui_required` immediately. Give its one-time
TUI/Desktop handoff and resume the same saved checkpoint there; do not call the
pairing action again in classic CLI.
The TUI panel shows the QR when it fits the window and the address and pairing
code (manual entry) when it does not; both are the same exchange. Act on the
returned `code`, never on a guess:

| `code` | Action |
|---|---|
| `paired` | Continue with `wait_phone_origin`. |
| `tui_window_too_small` | The Hermes window is too small even for the manual view. Nothing was paired and the phone is not at fault. Use the returned message: it names the window's size and the size needed. Ask the person to make this Hermes window bigger (drag its edge or maximise it; do not quit Hermes), then call `pair_phone` again. |
| `desktop_pairing_timeout`, `tui_pairing_timeout` | The phone did not connect in time; use the returned timeout message verbatim: "Pairing timed out. Ensure OcuClaw is running on your Even G2, then retry pairing." Do not replace it with Even Hub or generic phone-ready wording. |
| `cancelled`, `refused` | The person cancelled or refused in the panel. Ask whether to retry; call `pair_phone` again only on yes. |
| `tui_required` | The classic-CLI handoff above. |
| `tui_relaunch_required` | The widget was repaired after this TUI started. Relaunch Hermes once only when a service manager runs the gateway; otherwise use the fallback below. |
| `desktop_plugin_unavailable` | Keep Desktop open, reload Desktop plugins once, and retry. |
| `phone_already_connected` | The phone is connected now, so nothing was opened. Use the returned message: to re-pair, the person closes OcuClaw on the phone or disconnects it there first, then says so; call `pair_phone` again. Never offer this as a way to add a second phone. |
| `profile_unresolved`, `setup_not_configured`, `gateway_not_healthy`, `relay_not_healthy`, `tailnet_route_not_verified`, `tailnet_route_not_owned`, `tailnet_identity_unavailable`, `address_unavailable`, `verification_failed` | A pre-pairing check failed and nothing was opened. Each code has its own returned message naming the cause and next step; use it, fix that one cause, then call `pair_phone` again. Only `tailnet_route_not_verified` means the private route is unverified. |
| any other code, or the same failure twice | Deterministic: the panel will fail the same way again. Hand off the fallback below. |

Fallback for a deterministic pairing failure: ask the person to run
`hermes ocuclaw pair --address <verified-phoneAddress>` in their own terminal,
a separate window they open themselves. Never run it through your Terminal or
any other tool, pipe it, or ask for its output: its QR and pairing code must
never reach you. Wait for them to say the phone paired, then continue with
`wait_phone_origin`. Never suggest quitting, closing or relaunching the Hermes
TUI to retry pairing while the gateway may be this TUI's child (it was started
from here, or no service manager runs it): quitting the TUI stops the gateway.

`{"operation":"wait_phone_origin"}` is the direct observation after pairing.
Announce the phone message request and call it immediately; it blocks for a
newly completed phone-origin turn and returns without raw session or turn IDs.
The user never has to report that they sent the message.
Keep the returned opaque `phoneOriginAction.candidateId` inside the tool flow;
never print or explain it to the user.

`{"operation":"wait_reply_delivery","phoneCandidateId":"<candidateId>"}` is the
bounded reply check for that same turn. It is read-only, never restarts
`wait_phone_origin`, and never asks for another phone message. On
`replyDelivery.status: sdk_accepted` the phone app reported that the glasses
SDK accepted that exact reply: say that plainly, never that the wearer saw it
or that it was displayed, and continue. On `unconfirmed`, `unsupported` or
`pending`, give reconnect guidance first when a disconnect is known, then ask
one `clarify` yes/no question confirming whether the reply appeared on the
physical Even G2, with neither answer recommended. A “No” is diagnosed, never
armed. Check for a model error before any of that: when either result carries
`replyWasProviderError: true`, `runErrorCode`, or the reason
`reply_run_errored`, the chain works and the model is unreachable. Give the
result's `action` line (the class fix) and stop; never ask whether the reply
appeared, and never arm. The arm refuses that turn with `reply_run_errored`.

`{"operation":"welcome_round_trip"}` is the other mutating private-tool action.
Use it only once you hold reply evidence. Tell the wearer to double-tap the
welcome surface when it appears, then call it immediately with the exact
`phoneCandidateId` returned by `wait_phone_origin` and the `replyEvidence` you
actually hold: `client_sdk_receipt` after an `sdk_accepted` check for that same
candidate, or `wearer_confirmed` after the wearer's yes. Claiming
`client_sdk_receipt` without a matching record is refused with
`reply_evidence_unavailable`. It arms the one-hour
resumable Attempt, blocks while the managed gateway renders and retries the
locked welcome surface, and returns on committed proof or a terminal warning.
The user never has to report the double-tap. `arm_first_run_proof` remains a
compatibility/recovery primitive, not the normal guided path, and it requires
the same exact observed `phoneCandidateId` for every fresh arm. On resume,
`status` and `fresh_install` return `firstRunProofAttempt`: `armed` resumes at
the welcome wait, `expired` or `failed` restarts at the phone-origin turn, and
`committed` means the durable milestone already exists. Never advertise these
private actions as slash commands.

There is no beta-channel reference: this Hermes beta has one GitHub bundle
channel. The repository is private; testers need repository access and working
Git HTTPS authentication on the Hermes host. Never introduce npm or ClawHub instructions.

Every operation above is read-only. The tool has exactly TWO writing
operations, and both write only with `confirm: true`, which is only ever sent
after the user has said yes in plain words:
`{"operation":"enable_stream_reasoning_deltas","confirm":true}` turns on live
reasoning (fresh install Step 4b and update U4 own when to offer it), and
`{"operation":"enable_desktop_theme","confirm":true}` applies the OcuClaw look
to Hermes Desktop (fresh install Step 12 owns when to offer it; skip it for
TUI-only users).

If the tool returns a structured guidance error or its Guide version differs,
the bundled plugin is broken. Report that receipt; do not improvise from an
older OpenClaw guide.

Only when that exact-name lookup fails (`tool_describe` lists `ocuclaw_setup`
under `not_found`, or neither tool exists) is `ocuclaw_setup` unavailable. Then
stop and report that the supported Hermes plugin contract is broken; ask the
user to check that `hermes plugins list` shows ocuclaw enabled and that the
gateway has been restarted once since the install. Do not guess a relative reference path or
continue with remembered setup commands.

### Status-state vocabulary

The status receipt has six states: `missing` means the required Relay
Credential is absent and no connected gateway receipt was observed;
`configured` means the supported plugin and runtime are ready but no connected
gateway receipt was observed; `connected` means the gateway-process adapter
holds a live link to the OcuClaw runtime; `invalid` means configuration needs correction;
`unavailable` means Node.js or the packaged runtime cannot run; and
`unsupported` means Hermes is outside `supportedRange`.

`connected` means the gateway-process adapter holds a live link to the
OcuClaw runtime — it is not proof a phone is paired (that proof is the relay
client hello). A CLI agent turn observes the gateway only through
`gatewayPlatformState`; without it, `configured` is the expected ceiling in
a CLI turn, not a failure.

A cross-process receipt may report `connected` with
`relayTokenPresent: false`. That is the designed split: `connected` describes
the live gateway process, while `relayTokenPresent` describes secret visibility
to the process serving the setup tool. Report the `relay_token_missing` problem
as a configuration-durability warning without downgrading the guarded gateway
receipt.

## How you must work

1. **Finish the whole required lane.** A blocked box is `[blocked: reason]`,
   never silently skipped. A successful phone hello is not the finish; the
   ordered wrap is.
2. **Run commands exactly as printed.** Substitute only marked placeholders.
   Never wrap a command in `read`, a loop, a pipe, or extra flags. If a command
   is unsafe or incompatible, stop that phase and diagnose read-only.
   Run shell only through the `terminal` tool, one printed command per call.
   Never use `execute_code` for setup work, not even a read-only check: a
   script that calls `terminal` makes Hermes stop for a "script can spawn
   subprocesses" approval the user should never see. For setup state, call
   `ocuclaw_setup` with `{"operation":"status"}` or `{"operation":"doctor"}`
   instead of composing a shell check; both are typed and read-only.
   For TS-NOT-INSTALLED, each OS branch prints one complete private staged
   download/install block; run that whole block as one Terminal command so its
   quoted temporary-path variable remains in scope. Its `&&` chain or
   PowerShell Stop policy gates execution on a successful download. Keep that
   staged-file shape exactly as printed. For the Step 7 route only, after the
   unchanged doctor-provided command gets
   a permission refusal, explain and checkpoint one retry with the host's
   standard privilege-elevation prefix and no other change. In Hermes Desktop,
   pass that exact doctor-provided command to `terminal` first, then use Hermes
   Desktop's native approval or elevation prompt for the retry; never ask for or
   carry the password in chat. Only after `terminal` reports that native elevation is unavailable,
   cancelled, or refused may you hand the original command to the user for a
   separate administrator terminal.
3. **Keep credential roles separate.** When a Relay Credential is present,
   say exactly: "Secure relay access is ready; nothing for you to enter."
   Do not expose its storage or lifecycle details in routine setup prose.
   Never ask for, reveal, export, import, or re-enter it. The
   plugin generates it once during initial bootstrap on a provably fresh
   profile; there is no user-entry lane. If an established profile is missing
   it, stop normal setup and load the credential-reset branch.
   On a matching bundle advertising private phone setup, lead with Home's
   Optional setup card, whose two buttons are **Set up voice** and
   **Set up Even AI**; later re-entry is **Settings > Voice** and
   **Settings > Defaults > Even AI**. The card has no other buttons, and
   Settings has no separate optional-setup row.
   The dedicated page's masked field
   and explicit replacement confirmation own private entry. Save privately does
   not restart Hermes; Review activation and its separate confirmation handle
   the supported host lifecycle. Unsupported activation stays pending. Refresh
   loaded state after reconnecting; never replay an uncertain apply operation.
   Candidate source is not a public bundle availability claim.
   Advanced Desktop entry uses the private Desktop dialog via
   `request_credentials`, with exactly one integration name as the tool
   argument. Ask about Soniox and Even AI separately and open each popup at its
   own checkpoint. Terminal users use the advertised `hermes ocuclaw optional-setup
   save soniox` or `save even-ai` hidden prompt. Never ask the
   user to paste a secret into chat or echo, inspect, or read back any secret.
   Private entry is interactive and always marked USER ACTION REQUIRED;
   the assistant must never supply or read its secret input. If this bundle
   lacks the command, explain the limit and use its supported private setup
   entry or leave the capability pending. Follow fresh-install's grouped
   activation barrier after the chosen saves; never add a generic restart.
4. **Checkpoint a mutating phase, never a read-only check.** The advertised
   native optional-setup form owns consent through its explicit replacement,
   save and activation controls; it needs no shell-command checkpoint. Private
   route review remains print-only and requires separate approval before Serve
   changes. For advanced Desktop/CLI host actions, before a change,
   say what it does and why, show every command with a one-line explanation,
   and ask for OK. In ordinary assistant prose, use a fenced block. In a
   `clarify.question`, use an indented plain-text command line with no Markdown
   delimiters. The direct-panel `pair_phone` exception has no
   shell command: Step 8's fresh online-phone check authorizes opening
   its local modal, and the modal itself owns the explicit Yes/No gate. The pause message opens with the
   previous phase's result. If a pause message has no exact command line,
   discard and rewrite it. Resolve `Skip if` checks before proposing a mutation.
5. **One restart per phase.** Warn: "Hermes may go quiet briefly while its
   gateway restarts. If I do not return, say 'continue OcuClaw setup'." After
   any config change, state that it is saved but not applied until the
   gateway restarts. Never repeat a restart without a new finding.
   **A local fresh install restarts once (#3541):** the person arrives from
   the after-install card without restarting, so the gateway may not have
   loaded OcuClaw yet. That is expected; this TUI already holds the plugin and
   its Relay Credential. Do Steps 1-4b first, then fresh-install Step 5's one
   restart loads OcuClaw and applies them together. Never ask for an earlier
   restart.
   **Who restarts it:** run `hermes gateway restart` yourself only when fresh
   status reports `gatewaySupervision: service`. For `unsupervised`,
   `unknown` or an absent field, never run `hermes gateway restart` or
   `hermes gateway run` from a tool: hand the restart to the person with the
   exact words in `quick_reference` → `Restarting the gateway` (Ctrl+C in
   their gateway terminal, `hermes gateway run` again there, then
   "continue"), then re-check status. This covers every restart in this
   skill, including the ownership move lane above. **Never start the gateway
   or `tailscaled` as a tool or background child.** Optional Soniox/Even AI saves use fresh-install's grouped
   `optional-setup activate` barrier and fresh loaded-runtime status instead
   of a second generic restart; an uncertain activation remains pending.
6. **Official Hermes CLI only.** Use `hermes config set|get|unset` and
   `hermes plugins install|enable|update` — never with `--ref`, which records a
   pin that `hermes plugins update` then refuses to move. Install and update
   have one canonical wording, quoted in `{"operation":"fresh_install"}` and
   `{"operation":"update"}`; use it rather than composing your own. Never edit
   `config.yaml`, `.env`, or
   any example config file by hand. The one exception is the setup tool's
   `enable_stream_reasoning_deltas` operation, which is not a hand edit: it
   goes through Hermes' own atomic configuration writer, and it still needs
   the user's explicit yes first.
7. **Keep the relay loopback-only.** Never set `wsBind` away from `127.0.0.1`.
   Use Tailscale Serve, never Funnel, for remote access.
8. **Stay in bounds.** Read-only diagnostics are open. An unlisted mutation
   needs a failed listed path, a plain-language proposal, user OK, one attempt,
   and verification.
9. **Use honest proof language.** Static checks or this walkthrough are not
   `sim-clean` or `g2-validated`. LiveUI's remaining simulator/hardware
   evidence belongs to separate gates. This guided ceremony does not earn a
   named evidence rung by itself.

### Placeholders

- `<VALUE>` and `<port>` are non-secret values the agent may substitute.
- `YOUR-SONIOX-API-KEY` and `YOUR-EVEN-AI-TOKEN` are
  secret placeholders. The user replaces the whole uppercase text locally.
- Never reuse example values as real values.

## Internal completion checklist

Track this internally. Never render the checklist, checkbox notation, or lane
card to the user. The final response summarizes only the outcome and the three
user-relevant connection proofs.

- [ ] User level recorded
- [ ] Even G2 / Even Hub readiness confirmed
- [ ] Hermes version is within `>=0.21.1,<0.22.0`
- [ ] Installation source recorded accurately
- [ ] Secure relay access ready
- [ ] OcuClaw conversational tool progress is off (`config get` reports `false`)
- [ ] Live reasoning offered and answered (set, declined, or inert on this host)
- [ ] Plugin installed, enabled, and gateway restart verified
- [ ] Relay listening on loopback port 47801 (or recorded override)
- [ ] Tailscale connected on host and phone
- [ ] Tailscale Serve `:8446` relay route verified
- [ ] Direct pairing presenter is live in Hermes TUI or Desktop (require `display.interface=tui` only for terminal installs; Desktop does not require changing or mentioning the terminal default)
- [ ] Phone-origin reply confirmed on the Even G2
- [ ] First-Run Proof committed by welcome dismissal, or split-truth warning recorded
- [ ] Profile/multiplex posture explained when applicable
- [ ] Optional integrations resolved
- [ ] Ordered wrap delivered, including the single support-path explanation

Use the GitHub distribution bundle in the supported production lane. An explicitly
identified local test candidate is valid only for a test lane and must be
recorded as such; never describe it as a published GitHub installation.

## Lane card

Maintain this compact card internally. Never include secret values.

```text
User level: guided | terminal-comfortable
G2 glasses: unknown | has-glasses | not-yet (website opened | declined | handoff)
Host OS: linux | macOS | Windows | unknown
Hermes version: <version | unknown>
Hermes CLI on agent PATH: yes | no | unknown
Plugin state: absent | disabled | enabled | failed | unknown
Relay wsPort: 47801 | <override> | unknown
Relay bind: 127.0.0.1 | unsafe | unknown
Tailscale host: online | offline | absent | unknown
Tailscale phone: online | offline | unknown
Serve :8446: ready | absent | wrong | unknown
Phone: connected | rejected | unreachable | unknown
First-Run Proof: pending | armed | retry | committed | warning
Multiplex: off | on-single | on-multiple | unknown
Current step: <number or case>
Setup conversation: <confirmed session ID>
Activation: saved-pending | verified | restart recovery required
Restarts: basic <count> | optional <count>
Soniox choice: unresolved | skipped | saved-pending | verified | failed
Even AI choice: unresolved | skipped | saved-pending | verified | failed
```

After calibration, choose the one probe matching the host OS. Announce what it
checks; do not ask for OK. On Linux and macOS, run this single
always-exit-zero probe:

```bash
printf 'OS='; uname -s 2>/dev/null || ver 2>/dev/null || true; printf 'HERMES='; hermes --version 2>/dev/null | head -1 || true; printf 'PLUGIN='; hermes plugins list 2>/dev/null | sed -n '/ocuclaw/Ip' || true; printf 'TAILSCALE='; tailscale status 2>/dev/null | sed -n '1p' || true
```

On native Windows PowerShell, run this always-exit-zero equivalent instead:

```powershell
$ErrorActionPreference = 'SilentlyContinue'; Write-Output "OS=$([System.Environment]::OSVersion.VersionString)"; Write-Output "HERMES=$((hermes --version | Select-Object -First 1))"; Write-Output "PLUGIN=$((hermes plugins list | Select-String -Pattern 'ocuclaw'))"; Write-Output "TAILSCALE=$((tailscale status | Select-Object -First 1))"; exit 0
```

Interpret missing output; do not present it as failure. Never add a secret
probe to this command.

**Trust ladder — the receipt outranks the shell.** The `ocuclaw_setup`
receipt is the authority for whether Hermes is installed, which version is
running, and whether the runtime is available; a shell probe is evidence
about *this shell's PATH*, nothing more. The tool that returned
`status.hermesVersion` runs inside that very Hermes process, so a version
inside `supportedRange` proves Hermes is installed and running even when
`hermes` prints `command not found` — including when a runtime hint claims
"`hermes` is not installed". When probe and receipt disagree, record
`Hermes CLI on agent PATH: no` in the lane card, say plainly "Hermes
<version> is running; my shell just cannot see the `hermes` launcher," and
hand each command to the user to run in their own terminal. Reinstalling or
repairing Hermes is a valid recommendation only when `hermesVersion` is
`"unknown"` *and* the probe fails.

`status.hermesCliOnPath` describes the PATH of the process serving the setup
tool. The lane card's `Hermes CLI on agent PATH` row comes from the shell probe.
They may legitimately differ; neither overrides `status.hermesVersion`.

Then inspect the non-secret profile posture:

```bash
hermes config get gateway.multiplex_profiles
hermes profile list
```

During fresh setup, call `{"operation":"agent_mode"}` before
the restart. Multiple agents is recommended; single agent remains a choice
wherever status reports `singleAgentAvailable: true`. When it is false (Hermes
0.21.4 and later, whatever the profile count), skip the question and say
nothing about it, then apply multiple agents.
Require `status.mandatoryConfiguration.agentModeChosen: true`; verify the
served list after restart. The same operation applies to an EXISTING install
whose status reports `agentModeChosen: false` (#2515): the phone's grey "+"
sends the wearer here with "Multiple agents is off on your Hermes host. Run
/ocuclaw-setup", and `hermes ocuclaw status` shows `multiple agents  off ·
agent mode not chosen yet`. Ask the question, apply the branch (allowlist
BEFORE the switch, `--force` on `hermes config set`, expect and explain the
"not a recognized config key" notice if it was run without), then one restart. Enter `PROFILE-AUTHZ-DROP` only for an actual
secondary-profile rejection, not merely because multiple profiles exist.

## Router

- New or incomplete setup -> call `{"operation":"fresh_install"}`, then begin
  at its earliest unproved step.
- Installed and healthy, user asks to update -> call
  `{"operation":"update"}`.
- Installed and healthy, `status.mandatoryConfiguration.agentModeChosen` is
  false (the phone's "+" is grey, or the user quotes its "Run /ocuclaw-setup"
  line) -> call `{"operation":"agent_mode"}` and complete that choice; it
  needs one gateway restart and nothing else.
- Lost/compromised phone or explicit reset request -> call
  `{"operation":"credential_reset"}` and complete that branch before pairing.
- Failure text or failed verify -> call `{"operation":"troubleshooting"}` and
  enter the exact named case.
- Completed install/update/fix -> call `{"operation":"wrap_feedback"}`.

## Shipping posture that must remain truthful

- Supported Hermes is exactly `>=0.21.1,<0.22.0` (Hermes 0.21.1 and later 0.21.x);
  the certified baseline is `0.21.5`.
- Install and update use the private GitHub bundle `ocuclaw/ocuclaw`.
  Beta testers need repository access and Git HTTPS authentication on this host.
- The relay defaults to `wsBind` `127.0.0.1` and `wsPort` `47801`, loopback
  only; the host has one OcuClaw-managed Tailscale Serve route on `:8446`.
- A gateway that has to be POKED — a config key flipped, a stand-in model, a
  platform restarted — never gets poked at 47801. `bash
  tools/hermes-throwaway-gateway.sh --version 0.21.1|0.20.0 --boot-check` brings
  up a gateway on 47802/47803 against a fresh `HERMES_HOME` under `/tmp`, with
  this repo's bundle symlinked in and a token generated per boot, and prints the
  `--relay-url`/`--token` pair to drive it with. The 0.20.0 case is a legacy
  refusal-proof lane, not a supported host. It touches nothing in the operator's
  `~/.hermes` beyond reading the certified venv as an interpreter.
- Environment values beat legacy yaml secrets. Initial plugin bootstrap
  generates `OCUCLAW_RELAY_TOKEN` once on a provably fresh profile and writes
  a separate secret-free generation marker after the credential. It is absent
  from `requires_env`; only the locally confirmed all-device reset may replace
  it. Soniox and Even-AI secrets are optional: use the private Desktop dialog
  or, for terminal users, masked platform setup.
- `/ocuclaw-setup` is the guided front door. `hermes ocuclaw status` is
  passive and exit-0; `hermes ocuclaw doctor` is bounded-active and non-zero
  on problems. The dashboard's read-only `/ocuclaw` tab is optional detail,
  never a fallback dependency.
- Full uninstall first runs
  `hermes plugins enable ocuclaw --no-allow-tool-override` so the plugin-owned
  CLI is registered even for a disabled retained install, then
  `hermes gateway stop`, `hermes ocuclaw uninstall`, and
  `hermes gateway start`. The command prints its ownership receipt and
  preserves shared Hermes sessions.
- Multiple agents use the relay's authenticated transport provenance on
  Hermes 0.21; never enable `OCUCLAW_ALLOW_ALL_USERS` as setup. The OcuClaw
  enrollment set (#2940) selects agents and is distinct from sender
  authorization. Hermes 0.21.0 to 0.21.2 mirror that set onto the gateway as
  `gateway.multiplex_profile_allowlist`; Hermes 0.21.3 deletes that key and
  serves every live profile.
- `plugins.stream_reasoning_deltas` is Hermes' own gateway-wide key, not a
  glasses setting. It is offered during setup and set only on the user's yes;
  it is never on by default and never set silently. Live only after a gateway
  restart.
- Hermes conversational tool progress is explicitly off for OcuClaw through
  `display.platforms.ocuclaw.tool_progress`; the expected CLI readback is
  `false`. OcuClaw's structured tool activity remains active. If the optional
  Hermes `/verbose` gateway command changes the setting, restore it before
  continuing beta validation.
- LiveUI ships ON. Do not claim its still-owed simulator or real-Even-G2 proof
  has already happened.
