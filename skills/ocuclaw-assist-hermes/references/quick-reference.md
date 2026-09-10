# OcuClaw on Hermes — quick reference

**Guide version:** 2026-09-10 (1.3.20-hermes)

Use this as a lookup only. The loaded setup skill owns guardrails and
checkpoints.

The install and update rows below are the short form. The canonical install
block — terminal path, the Desktop deep link and its two follow-ups, and the
reasons behind each step — is quoted in full in `{"operation":"fresh_install"}`
and `{"operation":"update"}`, and is authored once in
`docs/hermes/install-block.md`. Never restate it from memory.

| Need | Command / fact |
|---|---|
| Supported host | non-unknown `status.hermesVersion` decides; only when it is `unknown` does `hermes --version` decide; require `>=0.21.0,<0.22.0` (certified baseline `0.21.0`) |
| Install | `hermes plugins install ocuclaw/ocuclaw --enable`, then follow `Restarting the gateway` below, then `/ocuclaw-setup`. Never add `--ref` — a ref-pinned install records `pinned: true` and `hermes plugins update` then refuses to move it |
| Install from Hermes Desktop | `hermes://plugin/install?repo=ocuclaw/ocuclaw` (enabled by default); the title-bar setup card then offers **Restart gateway** and afterwards **Pair your glasses** |
| Re-enable | `hermes plugins enable ocuclaw`, then follow `Restarting the gateway` below |
| Update | `hermes plugins update ocuclaw`, then follow `Restarting the gateway` below; full sequence in `{"operation":"update"}`. `ocuclaw` is the plugin id (`plugin.yaml` `name:`, resolved as a directory under `~/.hermes/plugins`), not the repository name. Unlike install, update prints no restart instruction at all |
| List | `hermes plugins list` |
| Guided setup/recovery | `/ocuclaw-setup` |
| Guided interactive interface | Hermes Desktop or bare `hermes` TUI hosts secure pairing; `hermes config set display.interface tui` selects the terminal default. Classic `hermes --cli` hands off the resumable checkpoint |
| Passive health | `hermes ocuclaw status` (always exits 0 for a valid snapshot) |
| Bounded active health | `hermes ocuclaw doctor` (non-zero on problems or bad state) |
| Optional dashboard detail | read-only OcuClaw tab at `/ocuclaw`; never a fallback dependency |
| Relay Credential | initial plugin bootstrap generates it once on a provably fresh profile; nothing to enter; for suspected compromise/loss or established-missing recovery load `{"operation":"credential_reset"}` for the locally confirmed all-device reset |
| All-device reset | `hermes ocuclaw reset-relay-credential` (interactive host terminal only; every phone disconnects and must re-pair) |
| Full uninstall | run `hermes plugins enable ocuclaw --no-allow-tool-override` first so the CLI is registered, run any narrow teardown printed by `hermes ocuclaw doctor`, then `hermes gateway stop`, `hermes ocuclaw uninstall`, and `hermes gateway start`; shared Hermes sessions are preserved |
| Optional secrets | private Desktop form via `request_credentials`; terminal users use masked Soniox and Even-AI prompts |
| Secret status | call `{"operation":"status"}` and use presence booleans only |
| Relay port | `hermes config get platforms.ocuclaw.extra.wsPort` (default 47801) |
| Set relay port | `hermes config set platforms.ocuclaw.extra.wsPort <port>` |
| Keep tool activity off the transcript | `hermes config set display.platforms.ocuclaw.tool_progress off` |
| Check OcuClaw tool-progress mode | `hermes config get display.platforms.ocuclaw.tool_progress` -> `false` |
| Turn on "Continue here" (glasses pick up a Desktop/CLI/TUI chat) | `hermes config set platforms.ocuclaw.extra.allow_admin_from '["ocuclaw-wearer"]'` |
| Check "Continue here" | `hermes config get platforms.ocuclaw.extra.allow_admin_from` -> lists `ocuclaw-wearer`; status `mandatoryConfiguration.adoptConfigured: true` |
| Safe bind | `hermes config set platforms.ocuclaw.extra.wsBind 127.0.0.1` |
| Managed Serve Route | run `hermes ocuclaw doctor`; use only its exact fully substituted apply or permitted narrow teardown command |
| Secure pairing | in guided setup call `{"operation":"pair_phone"}` only at the verified secure-pairing checkpoint; its direct TUI/Desktop panel advances QR -> four words -> local Yes/No. The separate-terminal `hermes ocuclaw pair --address <verified-phoneAddress>` command is troubleshooting fallback only |

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

Who supervises the gateway decides the command:

- Hermes-managed service (installed by `hermes gateway install`, launchd,
  Windows, or the official s6 container image): `hermes gateway restart`.
- Any other supervisor (your own systemd unit, Docker restart policy,
  supervisord, runit, a custom loop): restart through that supervisor.
  `hermes gateway restart` here stops the supervised gateway and starts a
  foreground one in its place.

Ask about each integration separately. Desktop opens a single-field private form
via `{"operation":"request_credentials","integrations":["soniox"]}` or
`{"operation":"request_credentials","integrations":["evenAi"]}` at its own step.
Pass exactly one name, never values. Status returns presence booleans.
The separate command palette entries **Set up OcuClaw voice with Soniox** and
**Set up OcuClaw Even AI** reopen their respective forms.
Saving keeps blank configured fields and does not restart Hermes.

For terminal users, `hermes gateway setup` offers only optional Soniox and Even AI credentials for
OcuClaw. It is never a Relay Credential entry or replacement path. The wizard
ends by offering its own restart ("Restart the gateway
to pick up changes?", default yes) and performs it when a Hermes-managed
service is running; run `hermes gateway restart` only if the wizard did not
bring the gateway back.

What each plugin command tells the user, verbatim, matters — one of them tells
them nothing:

- `hermes plugins install` prints "Restart the gateway for the plugin to take
  effect:" followed by `hermes gateway restart`, and never restarts for you.
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
Multiplex is off by default. Authz-open `OCUCLAW_ALLOW_ALL_USERS=true` is an
explicit operator posture, not a recommendation.
