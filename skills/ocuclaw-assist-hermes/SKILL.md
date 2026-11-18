---
name: ocuclaw-assist-hermes
description: Load before responding to ANY request that mentions OcuClaw setup, installation, configuration, updates, or troubleshooting on Hermes, including the exact request "help me fix ocuclaw". This is the mandatory guided OcuClaw Setup Assistant for installing the Hermes plugin, connecting an Even G2, or fixing a broken OcuClaw setup.
homepage: https://ocuclaw.com
metadata: {"hermes": {"emoji": "glasses"}}
---

# OcuClaw Setup Assistant for Hermes

**Guide version:** 2026-10-28 (1.3.27-hermes)

**Provenance:** deliberately forked from the OcuClaw Setup Assistant guide
1.0.41 at commit `fffbb2154`. That is the source guide version, not an
OcuClaw plugin version.

Work phase by phase. Setup takes about 15 minutes; the user should keep their
phone nearby.

**Language.** Reply in the language the user writes in. Keep commands, paths, flags, config keys and quoted output verbatim, in English, and in code blocks, so they still run when copied.

## Chat setup: relay `next` (the main route on every host)

When `ocuclaw_setup` lists the operation `next`, setup is the plugin's step
machine and your job is to relay it. If the tool is deferred, load it as the
Reference router below says (`tool_describe`, then `tool_call`). The
phone-session entry gate and the profile ownership gate below still run
first. After them this section wins over the rest of this file and its
references for setup itself: the Opening move's calibration question, the
lane card, fresh-install Steps 1–10, the agent-mode choice and the commands in
`{"operation":"cloudways"}` are not the path while `next` answers. Read them
only where this section sends you.

**Start.** Say in one short line that you are setting up OcuClaw with the
OcuClaw Setup Assistant, then call `{"operation":"next"}` in the same turn.
Ask no calibration question: `next` writes the words. A new chat, a dropped
chat, "continue" or "continue OcuClaw setup" all start the same way. `next`
reads the box every time, so it resumes where setup is.

**Say its lines word for word.** Put every `say` line in your final message
for the turn, in order, as written. Do not shorten, merge or explain them
away. For a user who writes in another language, add a short translation
after the lines, never in place of them. Add nothing that contradicts them.

**Then follow `status`:**

| `status` | You |
|---|---|
| `working` | Say the lines and call `next` again at once, in the same turn. |
| `waiting` | Say the lines, collect the one input below, then call what it names. |
| `restarting` | Say the lines and end your turn. Call nothing else. The user's "continue" starts the next `next`. |
| `stuck` | Say the lines, then troubleshoot (below). End by calling `next`. |
| `done` | Say the lines. Core setup is finished. |

**Inputs (`input.kind`):**

- `link`: show `input.url` on its own line, bare (never a Markdown link; the
  TUI hides a link's address), then end your turn. When the user says done,
  call `next`. With `url: null` the lines name the panel path to follow.
- `code`: the user reads a code off the phone's Pair screen and types it here.
  Pass exactly what they typed as `code` to `input.operation`
  (`pair_with_phone_code`), then call `next`. Never guess, reuse or make up a
  code. A result of `use_pair_phone` means this surface has its own pairing
  window: call `next` and follow it.
- `approval` with `surface: "card"`: call `input.operation` with `binding`
  exactly as given. Hermes then shows its own approval card with the exact
  command or the four words, and the user answers it. Never answer it, never
  ask the user to let you approve it, and never suggest "Always allow" or
  "Skip all this session". A card answered in under about a second comes back
  `unconfirmed`; `next` then asks again in chat. After the receipt, call `next`.
- `approval` with `surface: "popup"` (Hermes Desktop): call
  `{"operation":"pair_phone"}`. Its window takes the code and shows the four
  words itself. Never repeat or answer the window in prose. On `paired` call
  `next`; for any other returned `code`, follow its row in **Direct pairing
  and first-use actions** in `{"operation":"quick_reference"}`, then call
  `next`.
- `approval` with `surface: "chat_yes"` (approvals are off here): end your
  turn with the lines. The user's own next message is the answer. Pass
  `answer: "yes"` only when that message is a clear yes to those exact lines,
  `"no"` for a clear no, and ask once more for anything else. Never use
  `clarify` for this one, and never answer for them.
- `choice` with `chooser: "user"`: ask through `clarify` with no choices, the
  lines and the option labels in the question, and pass the `id` the user
  picked as `choice` to `next`. Never pick for them. "Did my reply appear on
  your glasses?" is the wearer's own answer: pass only what they said, never
  what machine health suggests.
- `choice` with `chooser: "agent"`: pick from `input.facts` yourself, pass the
  `id` as `choice`, and say in one line which route you picked and why.
- `glasses` (step 9): write the lines first. `then: "end_turn"`: end your
  turn; "[ocuclaw setup wake]" brings you back to `next` (leave its process
  alone). `call_next`: call `next` in that message, again while it answers
  `glasses`.

**Stuck.** `stuck` carries `code`, `checked` and `tried`. You may read logs,
call `status` and `doctor`, load `{"operation":"troubleshooting"}`, try one
fix, or ask the user, all inside the hard lines below. A mutating fix needs
the user's OK first. A fix counts only once `next` re-checks the box and moves
on, so always end by calling `next`. Send the user to a terminal or SSH only
when the stuck line says so or the fix needs their own admin rights.

**No extras.** Setup ends on `done`; `next` offers no extras. Never offer
voice typing, Even AI, Jev or easy bug reports during setup. If the user asks
for one, use `{"operation":"fresh_install"}` Step 11. A `done` with `jev`
says each step; `jev.state` is its progress.

**Hard lines (every host, every status):**

- Never press, answer or bypass a consent: approval cards, the pairing
  window, the private route, the four words. Pass `answer` only from the
  user's own fresh reply.
- Never type, ask for or echo a password, token or other secret. The phone
  code is the only code typed in chat.
- Never mention the Relay Credential during chat setup. The plugin makes it
  itself and pairing delivers it to the phone. Never call
  `provision_relay_credential` from setup.
- Never delete, reset or restart anything the user did not ask for. The only
  restart is the one `next` announces with `restarting`, in the words it
  gives (or `setup-start`'s, below). Never tell the user to press Ctrl+C in a gateway terminal or to run
  `hermes gateway run`, and never send them to SSH for it. On Cloudways the
  restart is the container's: the web chat drops while it restarts, then the
  user says "continue" in the same chat.
- On the healthy path never run setup steps by hand
  (`hermes ocuclaw cloudways setup`, `tailscale up`, `tailscale serve`,
  `hermes gateway restart`), and never send the user to SSH or a terminal.
- Step 2 asks nothing: `next` sets agent mode and Continue here itself. Do not
  ask about single or multiple agents.

**Edge cases you may handle on rails:**

- **OcuClaw is not installed yet** (this assistant came from a skills
  catalogue). Installing from GitHub is an unreviewed source, so ask once
  first, naming it: `hermes plugins install ocuclaw/ocuclaw --enable`. Run it
  only after a clear yes. Hermes loads it only on a restart: tell the user
  Hermes restarts once now (about a minute, the chat reconnects), then run
  `hermes ocuclaw setup-start`. On "continue", call `next`.
- **OcuClaw is already installed**, for example by a Cloudways Agent Template,
  from any source and at any version. It counts as present: never reinstall
  over it, and go straight to `next`. If the installed version is older than
  the latest, or the user asks, offer one update through
  `{"operation":"update"}`.
- **Cloudways' own Tailscale is already running.** `next` uses it and says so
  once. That is expected; never stop it or start a second one.
- **Two Tailscale identities.** A stuck `tailscale_start_failed` whose details
  begin "two tailnet identities" means Cloudways' own Tailscale runs while
  OcuClaw also has its own identity in `~/.tailscale`. Do not pick. Ask the
  user which one to keep. Keeping Cloudways' one changes the server's
  Tailscale name and certificate, so the phone pairs again; it removes
  OcuClaw's own with `hermes ocuclaw cloudways rollback --yes --purge-identity`.
  Keeping OcuClaw's own, the user stops Cloudways' Tailscale as they started
  it. Run the rollback only once the user picks it, then call `next`.
- **`next` is not there** (an older plugin): load
  `{"operation":"install_lifecycle"}` and follow its **Guided lane without
  `next`**, then the steps in `{"operation":"fresh_install"}`, with the gates,
  guardrails and router in this file.

## Phone-session entry gate

This gate runs before the Opening move. If the current conversation's platform
or source is OcuClaw and the request is OcuClaw setup,
do not call `ocuclaw_setup`, run a setup check, or begin any setup step. Reply only:

> OcuClaw setup runs in your host Hermes conversation. Return there and say
> "continue OcuClaw setup" (or start `/ocuclaw-setup` there). This phone/G2
> chat is used only for the test message, display confirmation, and welcome
> dismissal.

Then stop. Setup never moves into this chat. A phone request to add one
feature, such as the Bot Screen, is not setup: do it here.

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
profile **before anything else**, including before any migration. After the
Opening move and calibration, use the **Ownership move lane** in
`{"operation":"install_lifecycle"}`: plan first, never regenerate the
credential, and ask the user about a credential conflict. Do not pick.

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

Then request exactly one guidance branch:

- any setup while `ocuclaw_setup` offers `next` -> `{"operation":"next"}`
  and **Chat setup** above; load a reference only where it sends you
- first install or incomplete setup -> `{"operation":"fresh_install"}`, then
  begin at its earliest unproved step
- Cloudways Managed AI Agents host (`hermes ocuclaw cloudways detect` says
  `cloudways`) at the Tailscale steps -> `{"operation":"cloudways"}`
- compromised/lost phone or Relay Credential reset ->
  `{"operation":"credential_reset"}`; complete that branch before pairing
- installed and healthy, user asks to update -> `{"operation":"update"}`
- installed and healthy, `status.mandatoryConfiguration.agentModeChosen` is
  false (the phone's "+" is grey, or the user quotes its "Run /ocuclaw-setup"
  line) -> `{"operation":"agent_mode"}`; it needs one gateway restart and
  nothing else
- a failure -> `{"operation":"troubleshooting"}` and the exact named case
- a command lookup -> `{"operation":"quick_reference"}`
- a genuine finish -> `{"operation":"wrap_feedback"}`

For installation access, uninstall, or route teardown details, load
`{"operation":"install_lifecycle"}`. This retained reference replaces the
long terminal launch output; its recovery and consent rules still apply.

Setup is host-owned for the whole journey. Treat `journey.nextCheckpoint` in
every status/fresh-install receipt as the resume authority and never repeat an
earlier checkpoint merely because Hermes restarted or this is a fresh agent
turn. The OcuClaw phone/G2 conversation supplies only the test message, the
fallback display confirmation, and the welcome dismissal. Keep setup here: do not
send the user to that conversation to invoke `/ocuclaw-setup`, load this skill,
or continue setup there.

`{"operation":"pair_phone"}` is the direct local pairing action, at
`journey.nextCheckpoint: secure-phone-pairing` or when the person asks to
re-pair their phone after setup (the same phone; setup stays done). Its result
codes (`paired`, `expired`, `phone_already_connected` and the rest), the
first-use actions after it, the receipt vocabulary and the shipping posture are
in `{"operation":"quick_reference"}`. Never advertise these private actions as
slash commands.

If the tool returns a structured guidance error or its Guide version differs,
the bundled plugin is broken. Report that receipt; do not improvise from an
older OpenClaw guide.

Only when that exact-name lookup fails (`tool_describe` lists `ocuclaw_setup`
under `not_found`, or neither tool exists) is `ocuclaw_setup` unavailable. Then
stop and report that the supported Hermes plugin contract is broken; ask the
user to check that `hermes plugins list` shows ocuclaw enabled and that the
gateway has been restarted once since the install. Do not guess a relative reference path or
continue with remembered setup commands.

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
   For TS-NOT-INSTALLED and the Step 7 route retry, use
   **Command shapes (rule 2)** in `{"operation":"install_lifecycle"}`:
   run that whole block as one Terminal command, exactly as printed.
   **Trust ladder — the receipt outranks the shell.** If a probe disagrees,
   believe the receipt.
3. **Keep credential roles separate.** When a Relay Credential is present,
   say exactly: "Secure relay access is ready; nothing for you to enter."
   Do not expose its storage or lifecycle details in routine setup prose.
   Never ask for, reveal, export, import, or re-enter it. The
   plugin generates it once during initial bootstrap on a provably fresh
   profile; there is no user-entry lane. If an established profile is missing
   it, stop normal setup and load the credential-reset branch.
   Optional phone setup and private Soniox and Even AI entry follow
   **Optional phone setup and private entry (rule 3)** in
   `{"operation":"install_lifecycle"}`. Secrets never pass through chat, and the
   assistant never supplies or reads a secret input.
4. **Checkpoint a mutating phase, never a read-only check.** Before a change,
   say what it does and why, show every command with a one-line explanation,
   and ask for OK. The full rule, with the native-form and `pair_phone`
   exceptions, is **Checkpoints (rule 4)** in `{"operation":"install_lifecycle"}`.
5. **One restart per phase.** On the `next` lane the restart and its words
   come from `next` only; everything below is for setup without it.
   Warn: "Hermes may go quiet briefly while its
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
   "continue"), then re-check status. When status reports
   `gatewayRestartHost: cloudways` there is no gateway terminal: use that
   section's Cloudways words instead (`hermes gateway restart` in an SSH
   terminal or the Cloudways dashboard, reconnect, then "continue"). This
   covers every restart in this skill, including the ownership move lane. **Never start the gateway
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
   goes through Hermes' own atomic configuration writer. Fresh setup and
   updates use `defaultsOnly:true`; changing a saved choice needs an explicit yes.
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

Track the checklist and lane card in `{"operation":"install_lifecycle"}`
internally. Never render the checklist, checkbox notation, or lane card to the
user. The final response summarizes only the outcome and the three
user-relevant connection proofs. Supported Hermes is 0.21.4 or newer; tested
range `>=0.21.4,<0.24.0`, certified baseline `0.23.2`.
