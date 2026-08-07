# OcuClaw fresh install on Hermes — Steps 1–11

**Guide version:** 2026-08-06 (1.0.2-hermes)

Return to `SKILL.md` for guardrails, the lane card, and the silent checklist.

**FINISH CONTRACT.** A successful Step 10 hello is not the finish. In the same
message as its verification, explain the current shipping posture (LiveUI and
Even Terminal are ON, without claiming unearned simulator or hardware proof)
and continue to Step 11. Wait for the user's yes/skip; configure and verify
Soniox when accepted. Then offer Even AI and wait again. After both choices
resolve, explain the support lane, and only then load `wrap-feedback.md`. The
finish may span turns; never wrap while an optional choice or its restart is
in flight.

## Step 1 · Prerequisites

Ask: "Are your glasses paired in the Even Realities app, and can you open Even
Hub on your phone?"

Then run the read-only host gate:

```bash
hermes --version
```

PASS only when the output is Hermes 0.19.x, exactly within
`>=0.19.0,<0.20.0`. Earlier or later -> `HERMES-GATE-REFUSED`.
`command not found` -> installing Hermes itself is outside this skill; use the
official Hermes installation docs and return when the command works.

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

CHECKPOINT:

```bash
hermes plugins install OcuClawhub/ocuclaw-hermes-beta
```

This clones the public OcuClaw Hermes beta bundle. There is no npm or ClawHub
leg. The installer prompts for the relay token and masks it; the user enters
it locally. An empty prompt does not configure a usable token.

VERIFY:

```bash
hermes plugins list
```

The list names `ocuclaw`. Install failure -> `ESCALATE`.

## Step 3 · Relay token [required; user runs]

If the installer already accepted a real relay token, ask the user to confirm
that without repeating it. Otherwise use the sanctioned command below.

🔑 USER ACTION REQUIRED — replace only `YOUR-RELAY-TOKEN`; I never see it:

```bash
hermes config set OCUCLAW_RELAY_TOKEN "YOUR-RELAY-TOKEN"
```

The command routes the secret to Hermes' secret store. Never call
`hermes config get` for this key: do not display or probe a secret value.
Behavioral verification occurs when the platform starts in Step 5.

## Step 4 · Enable the beta posture and plugin

Skip plugin enablement if `hermes plugins list` already shows it enabled. Do
not skip the non-secret Even Terminal check: the Hermes runtime default is off,
while this beta's ratified posture is ON.

CHECKPOINT:

```bash
hermes config set platforms.ocuclaw.extra.evenTerminalEnabled true
hermes config set display.platforms.ocuclaw.tool_progress off
hermes plugins enable ocuclaw
```

This enables the product ET route and the installed platform plugin. It also
keeps Hermes' conversational tool-progress bubbles out of the OcuClaw
transcript; OcuClaw receives structured tool activity for its glasses HUD
separately. Configuration changes and plugin enablement require a gateway
restart.

VERIFY the non-secret gate without reading any secret:

```bash
hermes config get platforms.ocuclaw.extra.evenTerminalEnabled
hermes config get display.platforms.ocuclaw.tool_progress
```

Continue only when the ET setting reports `true` and the tool-progress setting
reports `false`. Hermes 0.19 stores the CLI value `off` as a boolean, so
`false` is the correct readback. If the optional config-gated Hermes `/verbose`
command changes OcuClaw's per-platform mode, restore `off` before continuing.

## Step 5 · Restart and verify the loopback relay

Warn about the brief restart, then CHECKPOINT:

```bash
hermes gateway restart
```

VERIFY with read-only status and logs available on this host. Find the newest
line shaped like:

```text
[hermes-runtime] relay listening on ws://127.0.0.1:47801
```

Accept a different port only if the user deliberately configured it through:

```bash
hermes config get platforms.ocuclaw.extra.wsPort
```

Do not read secret keys. A missing relay-token validation error returns to Step
3. A bind failure / child exit 98 -> `RELAY-PORT-CLAIMED`. Never widen
`wsBind`; preserve or restore loopback with:

```bash
hermes config set platforms.ocuclaw.extra.wsBind 127.0.0.1
```

## Step 6 · Tailscale on the host

Read-only checks need no OK:

```bash
tailscale status
```

Read the full uncapped result. If unavailable -> `TS-NOT-INSTALLED`. If logged
out -> `TS-AUTH`. Record the current host and phone rows; do not infer an
offline phone is usable.

```bash
tailscale ip -4
```

This compact check confirms the host has a tailnet address.

## Step 7 · Serve the relay at :8446

Read current state first:

```bash
tailscale serve status
```

If `:8444` still targets the recorded Hermes loopback relay port, classify it
as a legacy Hermes route. Confirm that no OpenClaw backend uses it, then include
this cleanup in the checkpoint. Never clear an OpenClaw-owned `:8444` route:

```bash
tailscale serve --tls-terminated-tcp=8444 off
```

Skip if the direct TLS-terminated TCP `:8446` route already targets the
recorded loopback relay port. Otherwise CHECKPOINT, substituting only the
recorded non-secret port:

```bash
tailscale serve --bg --tls-terminated-tcp=8446 tcp://127.0.0.1:<port>
```

VERIFY:

```bash
tailscale serve status
```

The route must be tailnet-only. Never use `tailscale funnel`. Failure ->
`TS-SERVE-UNSUPPORTED` or `TS-PORT-CLAIMED` as matched.

## Step 8 · Phone Tailscale

From the uncapped Step 6 status, identify phone candidates that are online
first. Ask the user to open Tailscale on the phone and confirm Connected. If
multiple online phones remain, ask which is theirs; never guess from a stale
device name.

## Step 9 · Enter the phone connection

Ask the user to open OcuClaw from Even Hub and enter:

```text
Address: wss://<node>.<tailnet>.ts.net:8446
Token:   the same relay token they created locally
```

The address must use `wss://`, the Tailscale DNS name, and port 8446. Never use
`ws://` for the phone, never use the loopback relay port externally, and never
ask the user to paste the token into chat. Have them tap Connect.

## Step 10 · Phone-origin hello

The user sends a short message from OcuClaw, for example "hello from my
glasses", and confirms a reply appears on the Even G2 display. Do not replace
this with a host-originated CLI message. Check the newest gateway log:

- `[ocuclaw] relay client connected` proves the app reached the relay.
- `relay rejected connection: invalid token` -> `APP-CONNECT-FAIL` token lane.
- neither line after a fresh tap -> `APP-CONNECT-FAIL` route/address lane.

On success, explain without inflating evidence: LiveUI and Even Terminal ship
enabled in this beta; this setup pass itself does not prove their simulator or
real-Even-G2 evidence rungs.

## Step 11 · Voice input via Soniox [OPTIONAL — recommended]

Offer this step and wait for a yes/skip before doing anything else:

> Would you like to set up voice input? You will be able to speak to the agent
> from the glasses. It needs a Soniox account and API key. Say yes to continue
> or skip to move on.

If accepted, the user creates a Soniox API key and runs the secret command
locally:

```bash
hermes config set OCUCLAW_SONIOX_API_KEY "YOUR-SONIOX-API-KEY"
```

Warn about the brief interruption, restart Hermes once, then verify the user
can tap the microphone/listen control on the glasses, speak a short phrase,
and see the transcription appear as their message:

```bash
hermes gateway restart
```

Failure to activate voice or transcribe -> `ESCALATE`, recording Step 11 as
the failing lane. A skip is an intentional optional-step outcome, not a block.

After Step 11 resolves, offer Even AI and wait for a separate yes/skip. If
accepted, the user runs these secret and non-secret commands:

```bash
hermes config set platforms.ocuclaw.extra.evenAiEnabled true
hermes config set OCUCLAW_EVEN_AI_TOKEN "YOUR-EVEN-AI-TOKEN"
```

Optional non-secret Even-AI settings use their dotted keys:

```bash
hermes config set platforms.ocuclaw.extra.evenAiSystemPrompt "<VALUE>"
hermes config set platforms.ocuclaw.extra.evenAiRoutingMode active
```

Run one `hermes gateway restart` phase and verify the accepted Even-AI behavior.
After both choices have resolved, explain that in-app **Send** is available on
Hermes and is the primary support path. Its debug bundle contains conversation
content but scrubs secrets, tokens, and addresses. Offline client-only or
Save-to-machine handoff are fallbacks. For Discord escalation, load
troubleshooting `ESCALATE`.

If the lane card says on-multiple, the `PROFILE-AUTHZ-DROP` lane must already
have established an intentional restrictive or authz-open posture. Reconfirm
that unauthorized secondary turns are silent for the wearer and log
`Unauthorized user:` server-side. Put Hermes 0.19 notification cron jobs on
the default profile.

Only after every choice and support explanation has resolved, load
`wrap-feedback.md`.
