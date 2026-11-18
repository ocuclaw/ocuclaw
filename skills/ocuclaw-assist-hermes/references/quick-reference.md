# OcuClaw on Hermes — quick reference

**Guide version:** 2026-10-28 (1.3.27-hermes)

Use this as a lookup only. The loaded setup skill owns guardrails and
checkpoints.

The install and update rows below are the short form. The canonical install
block — terminal path, the Desktop deep link and its two follow-ups, and the
reasons behind each step — is quoted in full in `{"operation":"fresh_install"}`
and `{"operation":"update"}`, and is authored once in
`docs/hermes/install-block.md`. Never restate it from memory.

| Need | Command / fact |
|---|---|
| Supported host | non-unknown `status.hermesVersion` decides; only when it is `unknown` does `hermes --version` decide; require 0.21.4 or newer (tested range `>=0.21.4,<0.24.0`, certified baseline `0.23.2`; a newer Hermes passes with a warning) |
| Install | `hermes plugins install ocuclaw/ocuclaw --enable`. On Cloudways: install, `hermes gateway restart`, then the one command `hermes ocuclaw cloudways setup`; a fresh `hermes --tui` with `/ocuclaw-setup` stays the fallback. Other hosts go straight to a fresh `hermes --tui` and `/ocuclaw-setup` with no restart first: its Step 5 restart (see `Restarting the gateway` below) loads OcuClaw and applies the saved settings together, so a local setup restarts once. Never add `--ref` — a ref-pinned install records `pinned: true` and `hermes plugins update` then refuses to move it |
| Install from Hermes Desktop | `hermes://plugin/install?repo=ocuclaw/ocuclaw` (enabled by default); the title-bar setup card then offers **Restart gateway** (that one click also restarts Desktop's backend so the pairing panel loads, and the window stays open), and afterwards reads **OcuClaw ready** and offers **Pair your glasses**. If the card instead reads **Quit and reopen Hermes Desktop to finish setup**, do that |
| Re-enable | `hermes plugins enable ocuclaw`, then follow `Restarting the gateway` below |
| Update | `hermes plugins update ocuclaw`, then follow `Restarting the gateway` below; full sequence in `{"operation":"update"}`. `ocuclaw` is the plugin id (`plugin.yaml` `name:`, resolved as a directory under `~/.hermes/plugins`), not the repository name. Unlike install, update prints no restart instruction at all |
| List | `hermes plugins list` |
| Guided setup/recovery | `/ocuclaw-setup` |
| Guided interactive interface | Hermes Desktop or bare `hermes` TUI hosts secure pairing; `hermes config set display.interface tui` selects the terminal default. Classic `hermes --cli` hands off the resumable checkpoint |
| Passive health | `hermes ocuclaw status` (always exits 0 for a valid snapshot) |
| Bounded active health | `hermes ocuclaw doctor` (non-zero on problems or bad state) |
| Setup preflight | `hermes ocuclaw setup-preflight` — read-only; may setup run on this profile, what multiple agents costs on this engine, and whether transport must move first. Exits 1 when something must be settled |
| Which profile owns transport | the **default** profile, always. Setup refuses under `hermes -p <name>` even when that profile works today |
| Move transport out of a secondary | `hermes ocuclaw move-to-default --from <profile>` (plan only), then `--apply`, then `hermes gateway restart`. Carries the relay credential across unchanged; the pairing survives |
| Which multiple-agent branch this engine takes | read `migration.gate` from the preflight; it probes for `hermes gateway migrate`. Never decide from a version string |
| Guided migration (engines that have it) | `hermes gateway migrate --multiplex --dry-run`, read its TEXT for a `✗ Blockers` heading (it exits 0 even when blocked), then `hermes gateway migrate --multiplex --yes`. Undo: `migration.rollback` when set (`hermes gateway migrate --standalone`); `null` on Hermes 0.21.4+, which has no undo |
| Optional dashboard detail | read-only OcuClaw tab at `/ocuclaw`; never a fallback dependency |
| Relay Credential | initial plugin bootstrap generates it once on a provably fresh profile; nothing to enter; for suspected compromise/loss or established-missing recovery load `{"operation":"credential_reset"}` for the locally confirmed all-device reset |
| All-device reset | `hermes ocuclaw reset-relay-credential` (interactive host terminal only; every phone disconnects and must re-pair) |
| Full uninstall | run `hermes plugins enable ocuclaw --no-allow-tool-override` first so the CLI is registered, run any narrow teardown printed by `hermes ocuclaw doctor`, then `hermes ocuclaw uninstall`; if it reports `restart_required`, `hermes gateway restart` then `hermes ocuclaw uninstall` again (Cloudways included); shared Hermes sessions are preserved; `hermes ocuclaw uninstall --cancel` then a restart keeps OcuClaw |
| Optional continuation | Matching advertised bundle: Home's **Optional setup** card, buttons **Set up voice**, **Set up Even AI** and **Set up Jev**; later re-entry is **Settings > Voice**, **Settings > Even AI** and Help > Optional setup > **Jev**. The card has no other buttons, and Settings has no separate optional-setup row. Jev progress: `hermes ocuclaw optional-setup status` (`jevCheck`; presence and outcome only). Diagnostics live at **Settings > Display > debug section > Diagnostics**. Dismissing Home and skipping each capability are separate. |
| Optional secrets | Primary: masked phone field, explicit replacement confirmation, **Save & continue** (Even AI: **Save & restart Hermes** where supported). Advanced: Desktop `request_credentials` or advertised `hermes ocuclaw optional-setup save soniox` / `save even-ai` / `save typesafe` hidden prompts. |
| Optional activation | Finish saves, then **Review restart** (voice popup) or **Restart Hermes** (Home voice card) and explicitly confirm **Restart Hermes?**; an Even AI **Save & restart Hermes** is the same restart. Reconnect and refresh loaded state; never replay an uncertain apply. Unsupported lifecycle uses the existing host handoff. Save is not activation or test proof. |
| Secret status | call `{"operation":"status"}` and use presence booleans only |
| Relay port | `hermes config get platforms.ocuclaw.extra.wsPort` (default 47801) |
| Set relay port | `hermes config set platforms.ocuclaw.extra.wsPort <port>` |
| Keep tool activity off the transcript | `hermes config set display.platforms.ocuclaw.tool_progress off` |
| Check OcuClaw tool-progress mode | `hermes config get display.platforms.ocuclaw.tool_progress` -> `false` |
| Turn on reply streaming for the glasses | `hermes config set display.platforms.ocuclaw.streaming true` |
| Check OcuClaw streaming mode | `hermes config get display.platforms.ocuclaw.streaming` -> `true`; without it the glasses show only "typing" for the whole reply, then the whole reply at once |
| Turn on "Continue here" (glasses pick up a Desktop/CLI/TUI chat) | `hermes config set platforms.ocuclaw.extra.allow_admin_from '["ocuclaw-wearer"]'` |
| Check "Continue here" | `hermes config get platforms.ocuclaw.extra.allow_admin_from` -> lists `ocuclaw-wearer`; status `mandatoryConfiguration.adoptConfigured: true` |
| Safe bind | `hermes config set platforms.ocuclaw.extra.wsBind 127.0.0.1` |
| Custom private route (own network and TLS front door, not Tailscale) | `hermes config set platforms.ocuclaw.extra.phoneAddress wss://<name>:<port>`; no environment variable. Back to Tailscale: `hermes config set platforms.ocuclaw.extra.phoneAddress ''`. `hermes ocuclaw doctor` checks it (ready / unverified / wrong); see `CUSTOM-ROUTE` in `{"operation":"troubleshooting"}`. Refused on Cloudways |
| Managed Serve Route | run `hermes ocuclaw doctor`; use only its exact fully substituted apply or permitted narrow teardown command |
| Cloudways host? | `hermes ocuclaw cloudways detect` -> `cloudways` / `likely` (ask open-ended, "Type yes or no"; only a clear yes counts) / `no`; on `cloudways` load `{"operation":"cloudways"}` instead of the Tailscale steps |
| Cloudways, one command | `hermes ocuclaw cloudways setup`: the host side of the path in the user's own terminal, steps `[1/8]` to `[8/8]`, resumable by re-running it (there is no `--retry`). **A fresh run is this command twice:** step 3 has no bounded restart plan here, so it prints the manual restart instruction (Cloudways dashboard first) and exits 2; the user restarts and reruns, and the second run reaches `[8/8]`. Does NOT do fresh-install Step 8, the phone's tailnet: do that yourself first. Asks at most twice, default no: whether to turn on Continue here (only while it is off; a no skips just that, and setup carries on) and the tailnet route. The other glasses settings are applied as part of the command the user ran. Flags `--yes` `--wait` `--first-use-wait` `--no-pair` `--no-first-use` `--hostname` `--light-terminal` `--json`. Exit 0 done, 1 problem, 2 stopped. Refuses on any host that is not decisively Cloudways. Offer it first; the C1-C5 ladder in `{"operation":"cloudways"}` stays the fallback |
| First message on its own | `hermes ocuclaw first-use`: the same step 8, for resuming after `--no-first-use` or a timed-out welcome wait, and for self-hosted users who paired with `hermes ocuclaw pair`. Needs a running gateway; no `--json`, no `--retry`. If the reply came back as a provider error, the verdict is "the chain works, the model is unreachable" and the outcome is refused; its next line names the failure (sign-in rejected: `hermes model`, or `claude auth login` on a Claude plan; out of quota; rate limited; provider busy or model error: `hermes -z hello`). Apply that fix, then run first-use again. |
| Cloudways Tailscale | `hermes ocuclaw cloudways install` (idempotent: the server's `/usr/bin` Tailscale, receipt, OcuClaw supervision, one daemon start; a server without it is told to restart from the Cloudways panel), `status --wait 45`, `enroll` (prints the authorization URL), `retry` (fresh URL), `enable` / `disable`, `rollback --yes` (`--purge-identity` also drops the node identity) |
| Cloudways daemon state | `hermes ocuclaw status` / `doctor` section `Tailscale daemon (userspace, kept alive by OcuClaw)`; setup receipt `journey.tailnetDaemon.state` with `subCheck: "tailnet-daemon"` when not `running` |
| Re-pair your phone | after setup, when the person asks: call `{"operation":"pair_phone"}` (TUI or Desktop panel) for the same phone, never a second one; setup and its proof stay done. `phone_already_connected` -> the person closes OcuClaw on the phone or disconnects it there first, then `pair_phone` again. Each other refusal code carries its own message; use it |
| Secure pairing | in guided setup call `{"operation":"pair_phone"}` at the verified secure-pairing checkpoint, or after setup to re-pair (row above); its direct TUI/Desktop panel advances phone code (or the address/code view for manual pairing) -> four words -> local Yes/No. The separate-terminal `hermes ocuclaw pair --address <verified-phoneAddress>` command is troubleshooting fallback only |
| Pairing failed | act on the returned `code` (SKILL.md pairing table): `tui_window_too_small` -> ask the person to make the Hermes window bigger (the message names both sizes), then `pair_phone` again; a deterministic failure -> the person runs `hermes ocuclaw pair --address <verified-phoneAddress>` in their own terminal, never through an agent tool (the pairing code must not reach the model). Never suggest relaunching the TUI while the gateway may be its child |

Never call `config get` for a secret key, hand-edit yaml or `.env`, widen
`wsBind`, use Funnel, or substitute an npm/ClawHub/OpenClaw command.
Never use the platform `/update` command from a session; it is refused. Use the
host-side in-place update row above.
Hermes' optional config-gated `/verbose` command can change the per-platform
tool-progress mode; restore `off` before OcuClaw validation.

## Non-secret optional keys

```bash
hermes config set platforms.ocuclaw.extra.evenAiEnabled true
hermes config set platforms.ocuclaw.extra.evenAiSystemPrompt "<VALUE>"
hermes config set platforms.ocuclaw.extra.evenAiRoutingMode active
# active | background | background_new only; any other value is rejected
```

### Live reasoning (`plugins.stream_reasoning_deltas`)

Hermes' own key and gateway-wide. Prefer the setup tool, which asks first and
writes atomically:

```json
{"operation":"enable_stream_reasoning_deltas","confirm":true}
```

Fresh setup and updates instead use `defaultsOnly:true` with that operation and
confirmation: they announce the default, enable an unset key, and preserve every
saved value. Changes to saved choices still ask first.

### OcuClaw look for Hermes Desktop

Black/green theme with the same dark appearance in Light and Dark modes, always listed under
Settings > Appearance > Theme; applied only on a plain yes at fresh-install
Step 12:

```json
{"operation":"enable_desktop_theme","confirm":true}
```

The equivalent the user can run themselves, when the tool is unavailable:

```bash
hermes config set plugins.stream_reasoning_deltas true
```

Either way it is live only after a gateway restart. Outside the fresh-setup
default, send `confirm: true` only after an explicit yes.

### Restarting the gateway

For `status.setupSurface: desktop`, keep the same setup chat and ask the
person to use Desktop's **Restart gateway** action. Use the OcuClaw card's
button when present. If it says **Waiting for setup** or has no restart button,
open the command palette (Ctrl+K on Linux/Windows, Cmd+K on macOS), search
**Restart gateway**, and select that action. Never tell the person to click a
control that is absent. After reconnection, read status again; a configured
value is not proof of activation. `status.restartToFinish` with
`reason: configuration` means the running gateway predates the saved setup
settings. Do not send a gateway lifecycle command through an agent tool in
Desktop, and do not start a second setup conversation after the interruption.

Hermes intentionally blocks lifecycle commands from tools inside its supervised
gateway: SIGTERM would kill the command before it could finish. A service
manager does not make that caller safe. Honor a refusal; hand off to Desktop
or a separate human shell. Never retry via `systemctl`, detached/background
commands, signals, or `force` to evade the guard.

Who supervises the gateway decides the command: read
`status.gatewaySupervision` from a fresh `{"operation":"status"}` first,
`service`, `unsupervised` or `unknown`. `status.gatewaySupervisor` names the
kind (`s6`, `systemd`, `launchd`, `windows`, `external`) when one is known.

Read `status.gatewayRestartHost` from the same status. It decides the words
before the ladder below does:

- `gatewayRestartHost: cloudways`: the Cloudways container runs the gateway,
  so there is no gateway terminal to Ctrl+C and `gatewaySupervision` reads
  `unsupervised`. Stopping the gateway restarts the whole container. **Never**
  run `hermes gateway restart` or `hermes gateway run` from a tool here either.
  First follow [Cloudways reconnect and resume](cloudways.md#before-any-restart--reconnect-and-resume):
  give the reconnect command and exact saved-session ID before the disconnect.
  Then say exactly:

  > Please restart your Hermes agent: in an SSH terminal on this server, run
  > `hermes gateway restart`, or restart the agent from your Cloudways
  > dashboard. This restarts the whole container, so SSH disconnects; reconnect
  > in about a minute. When it is running again, say "continue".

  Do not use the Ctrl+C words below on this host. On "continue", re-read
  status and verify the restart before moving on.

Otherwise (`gatewayRestartHost` is `null` or absent), the supervision decides:

- `gatewaySupervision: service` (a Hermes-installed systemd unit, launchd
  agent or Windows task for this profile, or the official s6 container image):
  run `hermes gateway restart` only when the tool is outside the gateway
  process. If the caller is inside it or uncertain, ask the person to run
  that command in a separate shell instead.
- `unsupervised`, or `unknown`, or the field is absent: **never** run
  `hermes gateway restart` or `hermes gateway run` from a tool. With no
  service manager, `restart` stops the gateway and then runs a new one in
  the foreground inside your tool: the tool hangs, and the new gateway dies
  when the person closes this chat. Hand the restart to the person. Say
  exactly:

  > Please restart your Hermes gateway in the terminal where it is running:
  > press Ctrl+C there to stop it, then run `hermes gateway run` again in that
  > same terminal. When it is running again, say "continue".

  If the person says no gateway is running at all (a first local install may
  have none), say instead: open a new terminal, run
  `hermes gateway run` there and leave it open, then say "continue".

  When `gatewaySupervisor` is `external` (their own systemd unit, Docker
  restart policy, supervisord, runit or a custom loop), say instead: restart
  it through that supervisor, then say "continue". On "continue", re-read
  status and verify the restart before moving on. Never restart it for them.

**Never start the gateway or `tailscaled` as a tool or background child** —
not with `&`, `nohup`, `setsid`, a terminal tool's background mode or any
other trick. A process started that way belongs to this chat: it dies when
the person closes it, and its exit notices flood the conversation. If either
one is not running, ask the person to start it in their own terminal (or
through their service manager), then say "continue". Asking a service manager
(`systemctl`, `launchctl`, s6) to start it, and OcuClaw's Cloudways supervision, are
fine: those own the process, not this chat.

Ask about each integration separately. Desktop opens a single-field private form
via `{"operation":"request_credentials","integrations":["soniox"]}` or
`{"operation":"request_credentials","integrations":["evenAi"]}` at its own step.
Pass exactly one name, never values. Status returns presence booleans.
The separate command palette entries **Set up OcuClaw voice with Soniox** and
**Set up OcuClaw Even AI** reopen their respective forms.
Saving keeps blank configured fields and does not restart Hermes.
The private save receipt's `changed` boolean distinguishes an unchanged value
from a newly saved credential; never read values to make that decision.

For optional terminal entry, use `hermes ocuclaw optional-setup save soniox`,
`save even-ai` or `save typesafe` (the TypeSafe key for the Jev features) only when
the installed bundle advertises it. These commands
never replace the Relay Credential. Blank/cancel preserves current values.
Finish the chosen saves, then use `hermes ocuclaw optional-setup status` and
`hermes ocuclaw optional-setup activate` as the fresh-install activation barrier.
It admits one required restart, warns about every affected gateway profile and
asks for `ACTIVATE`; on Cloudways that restart is the container bounce, and only
a host with no automatic lifecycle at all uses its explicit dashboard handoff. Prepare the reconnect/session commands above first. The generic
installation restart instructions above are not a second optional restart.
After reconnecting, read status again; `available_to_test` permits a fresh test,
while saved, failed and unknown remain distinct. An uncertain restart is not
permission to repeat it. Even AI route checks use `hermes ocuclaw even-ai route`
and `verify`; neither proves a real glasses request.

**The activation restart is required, not optional.** A saved Soniox key or
Even AI token reaches the relay only on the next gateway start; until then the
glasses show "Voice isn't set up." on every listen. Status detects a saved but
unloaded key for every save path (phone, Desktop form, `optional-setup save`,
the `hermes gateway setup` masked prompts, a hand-edited `.env`) by comparing
the disk value with what the live relay loaded, and the phone then offers
**Restart Hermes** on its Home screen; an Even AI token only counts once
`platforms.ocuclaw.extra.evenAiEnabled` is true, otherwise it stays `unknown`
with reason `even_ai_not_enabled`. On Cloudways still decline the wizard's
own restart offer (it closes SSH and Hermes mid-setup), then activate from the
phone or `hermes ocuclaw optional-setup activate`. On Cloudways both restart the
whole container (Matty, 2026-09-23, #3357): the phone's **Restart Hermes** is
offered there, and the CLI warns first (`This restarts the whole container, so SSH
will drop. Reconnect in about a minute. Your phone reconnects in 1–5
minutes. Active replies are stopped, not finished.`), asks for `ACTIVATE`, then restarts. SSH drops; the phone reconnects
on its own in 1 to 5 minutes. `status` prints a plain-language line for
each `reasons` entry: `even_ai_not_enabled` above, and
`loaded_value_differs_after_restart` when the gateway restarted for this exact
`.env` and the relay still loaded a different value (a process env, systemd
unit or managed override wins over `.env`); another restart is not offered
until the file changes.

What each plugin command tells the user, verbatim, matters — one of them tells
them nothing:

- `hermes plugins install` prints "Restart the gateway for the plugin to take
  effect:" followed by `hermes gateway restart`, and never restarts for you.
  From Hermes 0.22.5 it prints that only when a gateway runs or is installed
  for the profile, so a first install often shows no restart note at all.
  On a local setup the person skips that restart: `/ocuclaw-setup` asks for
  it once, at Step 5, after its settings are saved.
- `hermes plugins update` prints **no restart guidance at all** — its last line
  is the success line. State the restart yourself every time; a user who follows
  only the command output is left on the old code with no error anywhere.
- `hermes plugins enable` prints "Takes effect on next session" up to Hermes
  0.22.2, and the same restart note as install from 0.22.3;
  `hermes plugins remove` prints no restart guidance.

None of these commands restarts the gateway.

A config change is live only after a successful restart — verify with the
`[hermes-runtime] relay listening` line.

## Evidence phrases

- relay ready: `[hermes-runtime] relay listening on ws://127.0.0.1:47801`
- phone reached relay: `[ocuclaw] relay client connected`
- wrong token: `relay rejected connection: invalid token`
- unauthorized secondary profile: `Unauthorized user:`
- bind conflict: child exit 98 / address already in use

## Shipping facts

LiveUI ships ON for Hermes. Say that, but never turn it into a
`sim-clean` or `g2-validated` claim without the separate evidence.
Multiplex is off by default and `/ocuclaw-setup` is what turns it on. A routed
secondary turn is authorized by the transport it arrives on, so no
authorization variable is ever part of setup. Never set
`OCUCLAW_ALLOW_ALL_USERS`.

## Setup tool receipts

These sections came from the setup skill.

Both receipts carry a `status.tools` block: `expected` is the eight tools this
bundle provides (`compose_glasses_ui`, `get_glasses_ui_state`, `manage_liveui_templates`, `manage_liveui_tasks`,
`get_current_location`, `get_evenrealities_device_info`, `set_session_title`,
`ocuclaw_setup`),
`registered` is what actually bound, and `missing` names the rest. A non-empty
`missing` is a real defect even when every other block is healthy: the user
will see the agent say it has no such tool. Report the missing names and route
to `{"operation":"troubleshooting"}`. When `verdict` is `unobservable`
(`observed: false`), the process answering you is not the gateway that binds
the tools, `missing` is empty by design, and the block is not evidence either
way: continue setup. The bare `hermes` TUI on Hermes 0.21 always answers from
its own gateway child, so it always reads this way; `hermes ocuclaw doctor`
reports the same inventory as `unknown from this process`.

The status receipt has six states: `missing` means the required Relay
Credential is absent and no connected gateway receipt was observed;
`configured` means the supported plugin and runtime are ready but no connected
gateway receipt was observed; `connected` means the gateway-process adapter
holds a live link to the OcuClaw runtime; `invalid` means configuration needs correction;
`unavailable` means Node.js or the packaged runtime cannot run; and
`unsupported` means Hermes is below `supportedRange` or its version is unknown.

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

## Direct pairing and first-use actions

`{"operation":"pair_phone"}` is the direct local pairing action. During setup,
use it at `journey.nextCheckpoint: secure-phone-pairing`, after `doctor` has
verified the current private route and the user has confirmed the phone is
ready. After setup (any later checkpoint, including core completion), use it
when the person asks to re-pair their phone after setup: the same phone, never
a second one. Say plainly that setup and its proof stay done; re-pairing never
reopens the journey, and `paired` there ends the request instead of
continuing to `wait_phone_origin`. It
opens a model-bypassing panel on the live Hermes TUI or Desktop surface, waits
while that panel advances from the phone code to four words to the explicit human decision,
and returns only after the controller reaches a terminal result. Never repeat,
summarize, re-render, or answer the panel through prose or another tool. In
classic CLI the action returns `tui_required` immediately. Give its one-time
TUI/Desktop handoff and resume the same saved checkpoint there; do not call the
pairing action again in classic CLI.
The panel takes the phone code OcuClaw shows on the phone. For manual pairing
it shows the address and pairing code instead; both are the same exchange. Act on the
returned `code`, never on a guess:

| `code` | Action |
|---|---|
| `paired` | Continue with `wait_phone_origin`. |
| `tui_window_too_small` | The Hermes window is too small even for the manual view. Nothing was paired and the phone is not at fault. Use the returned message: it names the window's size and the size needed. Ask the person to make this Hermes window bigger (drag its edge or maximise it; do not quit Hermes), then call `pair_phone` again. |
| `desktop_pairing_timeout`, `tui_pairing_timeout` | The phone did not connect in time; use the returned timeout message verbatim: "Pairing timed out. Ensure OcuClaw is running on your Even G2, then retry pairing." Do not replace it with Even Hub or generic phone-ready wording. |
| `expired` | The five-minute code ran out before pairing finished. Nothing is wrong with the phone, the route or the words. Use the returned message; it matches the phone ("Pairing took longer than the five-minute window"). Ask whether to get a fresh code; on yes call `pair_phone` again, which reopens the same surface: the Desktop pairing window for a Desktop user, the TUI panel for a terminal user. The Desktop window's "Get a new code" button replies "Yes, get a new code" for the person; that is the yes, even if it arrives before you ask. Never answer this code with the terminal fallback below and never count it toward "the same failure twice". |
| `cancelled`, `refused` | The person cancelled or refused in the panel. Ask whether to retry; call `pair_phone` again only on yes. |
| `tui_required` | The classic-CLI handoff above. |
| `tui_relaunch_required` | The widget was repaired after this TUI started. Relaunch Hermes once only when a service manager runs the gateway; otherwise use the fallback below. |
| `desktop_plugin_unavailable` | Keep Desktop open, reload Desktop plugins once, and retry. |
| `desktop_relaunch_required` | OcuClaw was installed while this Hermes Desktop was open, so its pairing panel is not loaded yet. Nothing was opened, and the glasses and phone are not at fault. Use the returned message: the person uses **Restart gateway** on the OcuClaw card when present, otherwise Desktop's command palette, and waits for **OcuClaw ready** (or, if the card asks for it, quits and reopens Hermes Desktop), then returns to this same chat; call `pair_phone` again. Never claim a missing button is present. Setup state is kept. Never answer it with the terminal fallback below and never count it toward "the same failure twice". |
| `phone_already_connected` | The phone is connected now, so nothing was opened. Use the returned message: to re-pair, the person closes OcuClaw on the phone or disconnects it there first, then says so; call `pair_phone` again. Never offer this as a way to add a second phone. |
| `profile_unresolved`, `setup_not_configured`, `gateway_not_healthy`, `relay_not_healthy`, `tailnet_route_not_verified`, `tailnet_route_not_owned`, `tailnet_identity_unavailable`, `address_unavailable`, `verification_failed` | A pre-pairing check failed and nothing was opened. Each code has its own returned message naming the cause and next step; use it, fix that one cause, then call `pair_phone` again. Only `tailnet_route_not_verified` means the private route is unverified. |
| `custom_route_wrong`, `custom_route_not_verified` | Custom private route only (`phoneAddress` set). Nothing was opened. `custom_route_wrong`: the address failed a check, run `hermes ocuclaw doctor`, fix the named finding, then call `pair_phone` again. `custom_route_not_verified`: the host could not check the address, run `doctor` and use its answer; never call an unverified route "working". Load `{"operation":"troubleshooting"}` and enter `CUSTOM-ROUTE`. The `.ts.net` and Serve ownership refusals do not apply in this mode. |
| any other code, or the same failure twice | Deterministic: the panel will fail the same way again. Hand off the fallback below. |

Fallback for a deterministic pairing failure (never for `expired`, which is
answered by a fresh code in the same panel): ask the person to run
`hermes ocuclaw pair --address <verified-phoneAddress>` in their own terminal,
a separate window they open themselves. Never run it through your Terminal or
any other tool, pipe it, or ask for its output: its pairing code and the
phone code the person types must never reach you. Wait for them to say the phone paired, then continue with
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

There is no beta-channel reference: OcuClaw for Hermes has one GitHub bundle
channel. The repository is public; the host needs working Git, but no repository
access or GitHub sign-in. Never introduce npm or ClawHub instructions.

Every guidance operation in the setup skill's router is read-only. The tool has exactly TWO writing
operations, and both write only with `confirm: true`:
`{"operation":"enable_stream_reasoning_deltas","confirm":true}` turns on live
reasoning. Fresh install Step 4b and update U4 apply it by default with
`defaultsOnly:true` to preserve every saved value.
`{"operation":"enable_desktop_theme","confirm":true}` applies the OcuClaw look
to Hermes Desktop after an explicit yes (fresh install Step 12 owns when to
offer it; skip it for TUI-only users).

## Shipping posture that must remain truthful

- Supported Hermes is 0.21.4 or newer. The tested range is exactly
  `>=0.21.4,<0.24.0` (Hermes 0.21.4 through 0.23.x) and the certified baseline
  is `0.23.2`; a newer Hermes runs with a warning, an older one is refused.
- Install and update use the public GitHub bundle `ocuclaw/ocuclaw`.
  The host needs working Git, but no repository access or GitHub sign-in.
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
  `hermes ocuclaw uninstall`. If it reports `restart_required` (exit 3),
  run `hermes gateway restart` and `hermes ocuclaw uninstall` again; never
  `hermes gateway stop` first (on Cloudways it restarts the container). The
  command removes the Cloudways Tailscale pieces too, prints its ownership
  receipt and preserves shared Hermes sessions. `--cancel` clears a pending
  uninstall; restart once afterwards.
- Multiple agents use the relay's authenticated transport provenance on
  Hermes 0.21; never enable `OCUCLAW_ALLOW_ALL_USERS` as setup. The OcuClaw
  enrollment set (#2940) selects agents and is distinct from sender
  authorization. Hermes 0.21.0 to 0.21.2 mirror that set onto the gateway as
  `gateway.multiplex_profile_allowlist`; Hermes 0.21.3 deletes that key and
  serves every live profile.
- `plugins.stream_reasoning_deltas` is Hermes' own gateway-wide key, not a
  glasses setting. Fresh setup and updates announce and enable it when unset;
  saved values, including false, survive reruns. Live only after a gateway
  restart.
- Hermes conversational tool progress is explicitly off for OcuClaw through
  `display.platforms.ocuclaw.tool_progress`; the expected CLI readback is
  `false`. OcuClaw's structured tool activity remains active. If the optional
  Hermes `/verbose` gateway command changes the setting, restore it before
  continuing validation.
- Reply streaming is explicitly turned on for OcuClaw through
  `display.platforms.ocuclaw.streaming` (Hermes 0.21.5 reads it per turn); the
  expected CLI readback is `true`. `display.streaming` (no `platforms.ocuclaw`
  segment) is a different, CLI-only key, and top-level `streaming.enabled`
  must never be written. Without the platform key the glasses show only
  "typing" for the whole reply, then the whole reply at once.
- LiveUI ships ON. Do not claim its still-owed simulator or real-Even-G2 proof
  has already happened.
