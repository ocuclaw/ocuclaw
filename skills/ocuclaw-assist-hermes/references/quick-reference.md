# OcuClaw on Hermes — quick reference

**Guide version:** 2026-08-06 (1.0.2-hermes)

Use this as a lookup only. `SKILL.md` owns guardrails and checkpoints.

| Need | Command / fact |
|---|---|
| Supported host | `hermes --version` -> `>=0.19.0,<0.20.0` only |
| Install | `hermes plugins install OcuClawhub/ocuclaw-hermes-beta` |
| Enable | `hermes plugins enable ocuclaw` |
| Update | `hermes plugins update ocuclaw` |
| List | `hermes plugins list` |
| Restart | `hermes gateway restart` |
| Relay secret | `hermes config set OCUCLAW_RELAY_TOKEN "YOUR-RELAY-TOKEN"` |
| Soniox secret | `hermes config set OCUCLAW_SONIOX_API_KEY "YOUR-SONIOX-API-KEY"` |
| Even-AI secret | `hermes config set OCUCLAW_EVEN_AI_TOKEN "YOUR-EVEN-AI-TOKEN"` |
| Relay port | `hermes config get platforms.ocuclaw.extra.wsPort` (default 47801) |
| Set relay port | `hermes config set platforms.ocuclaw.extra.wsPort <port>` |
| Enable beta ET route | `hermes config set platforms.ocuclaw.extra.evenTerminalEnabled true` |
| Check beta ET route | `hermes config get platforms.ocuclaw.extra.evenTerminalEnabled` |
| Keep tool activity off the transcript | `hermes config set display.platforms.ocuclaw.tool_progress off` |
| Check OcuClaw tool-progress mode | `hermes config get display.platforms.ocuclaw.tool_progress` -> `false` |
| Safe bind | `hermes config set platforms.ocuclaw.extra.wsBind 127.0.0.1` |
| External relay | `wss://<node>.<tailnet>.ts.net:8446` |

Never call `config get` for a secret key, hand-edit yaml or `.env`, widen
`wsBind`, use Funnel, or substitute an npm/ClawHub/OpenClaw command.
Hermes' optional config-gated `/verbose` command can change the per-platform
tool-progress mode; restore `off` before OcuClaw beta validation.

## Non-secret optional keys

```bash
hermes config set platforms.ocuclaw.extra.evenAiEnabled true
hermes config set platforms.ocuclaw.extra.evenAiSystemPrompt "<VALUE>"
hermes config set platforms.ocuclaw.extra.evenAiRoutingMode active
```

Every change requires `hermes gateway restart` before it is live.

## Evidence phrases

- relay ready: `[hermes-runtime] relay listening on ws://127.0.0.1:47801`
- phone reached relay: `[ocuclaw] relay client connected`
- wrong token: `relay rejected connection: invalid token`
- unauthorized secondary profile: `Unauthorized user:`
- bind conflict: child exit 98 / address already in use

## Shipping facts

LiveUI and Even Terminal ship ON in the Hermes beta. Say that, but never turn
it into a `sim-clean` or `g2-validated` claim without the separate evidence.
Multiplex is off by default. Authz-open `OCUCLAW_ALLOW_ALL_USERS=true` is an
explicit operator posture, not a recommendation. Notification cron jobs use
the default profile.
