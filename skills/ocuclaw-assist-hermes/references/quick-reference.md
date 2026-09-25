# OcuClaw on Hermes — quick reference

**Guide version:** 2026-09-25 (1.3.24-hermes)

Use this as a lookup only. The loaded setup skill owns guardrails and
checkpoints.

The install and update rows below are the short form. The canonical install
block — terminal path, the Desktop deep link and its two follow-ups, and the
reasons behind each step — is quoted in full in `{"operation":"fresh_install"}`
and `{"operation":"update"}`, and is authored once in
`docs/hermes/install-block.md`. Never restate it from memory.

| Need | Command / fact |
|---|---|
| Supported host | non-unknown `status.hermesVersion` decides; only when it is `unknown` does `hermes --version` decide; require `>=0.21.1,<0.22.0` (certified baseline `0.21.5`) |
| Install | `hermes plugins install ocuclaw/ocuclaw --enable`. On Cloudways: install, `hermes gateway restart`, then the one command `hermes ocuclaw cloudways setup`; a fresh `hermes --tui` with `/ocuclaw-setup` stays the fallback. Other hosts go straight to a fresh `hermes --tui` and `/ocuclaw-setup` with no restart first: its Step 5 restart (see `Restarting the gateway` below) loads OcuClaw and applies the saved settings together, so a local setup restarts once. Never add `--ref` — a ref-pinned install records `pinned: true` and `hermes plugins update` then refuses to move it |
| Install from Hermes Desktop | `hermes://plugin/install?repo=ocuclaw/ocuclaw` (enabled by default); the title-bar setup card then offers **Restart gateway** and afterwards **Pair your glasses** |
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
| Full uninstall | run `hermes plugins enable ocuclaw --no-allow-tool-override` first so the CLI is registered, run any narrow teardown printed by `hermes ocuclaw doctor`, then `hermes gateway stop`, `hermes ocuclaw uninstall`, and `hermes gateway start`; shared Hermes sessions are preserved |
| Optional continuation | Matching advertised bundle: Home's **Optional setup** card, buttons **Set up voice** and **Set up Even AI**; later re-entry is **Settings > Voice** and **Settings > Defaults > Even AI**. The card has no other buttons, and Settings has no separate optional-setup row. Diagnostics live at **Settings > Display > debug section > Diagnostics**. Dismissing Home and skipping each capability are separate. |
| Optional secrets | Primary: masked phone field, explicit replacement confirmation, **Save privately**. Advanced: Desktop `request_credentials` or advertised `hermes ocuclaw optional-setup save soniox` / `save even-ai` / `save typesafe` hidden prompts. |
| Optional activation | Finish saves, then **Review activation** and explicitly confirm supported lifecycle. Reconnect and refresh loaded state; never replay an uncertain apply. Unsupported lifecycle uses the existing host handoff. Save is not activation or test proof. |
| Secret status | call `{"operation":"status"}` and use presence booleans only |
| Relay port | `hermes config get platforms.ocuclaw.extra.wsPort` (default 47801) |
| Set relay port | `hermes config set platforms.ocuclaw.extra.wsPort <port>` |
| Keep tool activity off the transcript | `hermes config set display.platforms.ocuclaw.tool_progress off` |
| Check OcuClaw tool-progress mode | `hermes config get display.platforms.ocuclaw.tool_progress` -> `false` |
| Turn on "Continue here" (glasses pick up a Desktop/CLI/TUI chat) | `hermes config set platforms.ocuclaw.extra.allow_admin_from '["ocuclaw-wearer"]'` |
| Check "Continue here" | `hermes config get platforms.ocuclaw.extra.allow_admin_from` -> lists `ocuclaw-wearer`; status `mandatoryConfiguration.adoptConfigured: true` |
| Safe bind | `hermes config set platforms.ocuclaw.extra.wsBind 127.0.0.1` |
| Managed Serve Route | run `hermes ocuclaw doctor`; use only its exact fully substituted apply or permitted narrow teardown command |
| Cloudways host? | `hermes ocuclaw cloudways detect` -> `cloudways` / `likely` (ask open-ended, "Type yes or no"; only a clear yes counts) / `no`; on `cloudways` load `{"operation":"cloudways"}` instead of the Tailscale steps |
| Cloudways, one command | `hermes ocuclaw cloudways setup`: the host side of the path in the user's own terminal, steps `[1/8]` to `[8/8]`, resumable by re-running it (there is no `--retry`). **A fresh run is this command twice:** step 3 has no bounded restart plan here, so it prints the manual restart instruction (Cloudways dashboard first) and exits 2; the user restarts and reruns, and the second run reaches `[8/8]`. Does NOT do fresh-install Step 8, the phone's tailnet: do that yourself first. Asks twice, default no: the settings write and the tailnet route. Flags `--yes` `--wait` `--first-use-wait` `--no-pair` `--no-first-use` `--hostname` `--light-terminal` `--json`. Exit 0 done, 1 problem, 2 stopped. Refuses on any host that is not decisively Cloudways. Offer it first; the C1-C5 ladder in `{"operation":"cloudways"}` stays the fallback |
| First message on its own | `hermes ocuclaw first-use`: the same step 8, for resuming after `--no-first-use` or a timed-out welcome wait, and for self-hosted users who paired with `hermes ocuclaw pair`. Needs a running gateway; no `--json`, no `--retry`. If the reply came back as a provider error, the verdict is "the chain works, the model is unreachable" and the outcome is refused; its next line names the failure (sign-in rejected: `hermes model`; out of quota; rate limited; provider busy or model error: `hermes -z hello`). Apply that fix, then run first-use again. |
| Cloudways Tailscale | `hermes ocuclaw cloudways install` (idempotent: pinned binaries, receipt, watchdog script, every-minute `--no-agent` cron job), `status --wait 45`, `enroll` (prints the authorization URL), `retry` (fresh URL), `enable` / `disable`, `rollback --yes` (`--purge-identity` also drops the node identity) |
| Cloudways daemon state | `hermes ocuclaw status` / `doctor` section `Tailscale daemon (userspace, cron-kept)`; setup receipt `journey.tailnetDaemon.state` with `subCheck: "tailnet-daemon"` when not `running` |
| Re-pair your phone | after setup, when the person asks: call `{"operation":"pair_phone"}` (TUI or Desktop panel) for the same phone, never a second one; setup and its proof stay done. `phone_already_connected` -> the person closes OcuClaw on the phone or disconnects it there first, then `pair_phone` again. Each other refusal code carries its own message; use it |
| Secure pairing | in guided setup call `{"operation":"pair_phone"}` at the verified secure-pairing checkpoint, or after setup to re-pair (row above); its direct TUI/Desktop panel advances QR (or the address/code view when the QR does not fit the window) -> four words -> local Yes/No. The separate-terminal `hermes ocuclaw pair --address <verified-phoneAddress>` command is troubleshooting fallback only |
| Pairing failed | act on the returned `code` (SKILL.md pairing table): `tui_window_too_small` -> ask the person to make the Hermes window bigger (the message names both sizes), then `pair_phone` again; a deterministic failure -> the person runs `hermes ocuclaw pair --address <verified-phoneAddress>` in their own terminal, never through an agent tool (the pairing code must not reach the model). Never suggest relaunching the TUI while the gateway may be its child |

Never call `config get` for a secret key, hand-edit yaml or `.env`, widen
`wsBind`, use Funnel, or substitute an npm/ClawHub/OpenClaw command.
Never use the platform `/update` command from a session; it is refused. Use the
host-side in-place update row above.
Hermes' optional config-gated `/verbose` command can change the per-platform
tool-progress mode; restore `off` before OcuClaw beta validation.

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

Either way it is live only after a gateway restart. Never send `confirm: true`
before an explicit yes.

### Restarting the gateway

Who supervises the gateway decides the command: read
`status.gatewaySupervision` from a fresh `{"operation":"status"}` first,
`service`, `unsupervised` or `unknown`. `status.gatewaySupervisor` names the
kind (`s6`, `systemd`, `launchd`, `windows`, `external`) when one is known.

On Cloudways, first follow [Cloudways reconnect and resume](cloudways.md#before-any-restart--reconnect-and-resume).
Give the reconnect command and exact saved-session ID before the disconnect.
Use Cloudways' existing `hermes gateway restart` path; it restarts the container.

- `gatewaySupervision: service` (a Hermes-installed systemd unit, launchd
  agent or Windows task for this profile, or the official s6 container image):
  run `hermes gateway restart`.
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
(`systemctl`, `launchctl`, s6) to start it, and the Cloudways watchdog, are
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
`save even-ai` or `save typesafe` (silent input's smart word order) only when
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
glasses show `Soniox key missing` on every listen. Status detects a saved but
unloaded key for every save path (phone, Desktop form, `optional-setup save`,
the `hermes gateway setup` masked prompts, a hand-edited `.env`) by comparing
the disk value with what the live relay loaded, and the phone then offers
**Restart Hermes** on its Home screen; an Even AI token only counts once
`platforms.ocuclaw.extra.evenAiEnabled` is true, otherwise it stays `unknown`
with reason `even_ai_not_enabled`. On Cloudways still decline the wizard's
own restart offer (it closes SSH and Hermes mid-setup), then activate from the
phone or `hermes ocuclaw optional-setup activate`. On Cloudways both restart the
whole container (Matty, 2026-09-23, #3357): the phone's **Restart Hermes** is
offered there, and the CLI warns first (`This restarts the whole container. SSH
will disconnect; reconnect in about a minute. Your phone reconnects in 1–5
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
  On a local setup the person skips that restart: `/ocuclaw-setup` asks for
  it once, at Step 5, after its settings are saved.
- `hermes plugins update` prints **no restart guidance at all** — its last line
  is the success line. State the restart yourself every time; a user who follows
  only the command output is left on the old code with no error anywhere.
- `hermes plugins enable` prints "Takes effect on next session";
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

LiveUI ships ON in the Hermes beta. Say that, but never turn it into a
`sim-clean` or `g2-validated` claim without the separate evidence.
Multiplex is off by default and `/ocuclaw-setup` is what turns it on. A routed
secondary turn is authorized by the transport it arrives on, so no
authorization variable is ever part of setup. Never set
`OCUCLAW_ALLOW_ALL_USERS`.
