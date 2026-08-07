# Troubleshooting OcuClaw on Hermes

**Guide version:** 2026-08-06 (1.0.2-hermes)

Return to `SKILL.md` for command, secret, checkpoint, and restart rules. Enter
the narrowest case matching observed evidence. Diagnose read-only before a
mutation. Never widen `wsBind`.

## HERMES-GATE-REFUSED

`hermes --version` must report a version in `>=0.19.0,<0.20.0`. The plugin
refuses registration outside that hard range, so generic phone symptoms can
hide a host-version refusal visible only in the Hermes gateway log. Do not
work around the gate or say "0.19.0 or later". Updating Hermes is outside the
OcuClaw plugin update phase and needs the user's separate decision.

## RELAY-PORT-CLAIMED

Evidence: the platform fails to come up, the gateway log reports an address
already in use / bind error, or the child exits 98.

Find a free port read-only:

- Linux: `ss -ltnH "sport = :<port>"`
- macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN`
- Windows: `netsh int ipv4 show excludedportrange protocol=tcp`, then
  `netstat -ano | findstr :<port>`

Check `47801`, then `43118`, then `38272`. CHECKPOINT one non-secret change:

```bash
hermes config set platforms.ocuclaw.extra.wsPort <port>
```

Restart once, then require the new `[hermes-runtime] relay listening` log
line. Repoint Tailscale Serve `:8446` to the new loopback port. Preserve
`wsBind=127.0.0.1`; there is no Docker widening recipe on Hermes.

## APP-CONNECT-FAIL

First ask the user to confirm the phone's Tailscale app says Connected, then
have them tap Connect once. Read the newest gateway log before guessing.

- recent `relay rejected connection: invalid token` -> have the user re-enter
  the same token or reset it via the required secret command. Never ask them
  to reveal it. Repeat rejects may collapse for 60 seconds.
- recent `[ocuclaw] relay client connected` -> connectivity worked; inspect
  the app's compatibility message and Even Hub version.
- neither -> verify `tailscale serve status`, then have the user read back the
  address exactly. It must be `wss://<node>.<tailnet>.ts.net:8446`.

Never use session listings as phone-connect evidence.

## CLIENT-TOO-OLD

If the app reaches the relay and shows a required-version display, host setup
is correct. Update OcuClaw through Even Hub to the version named by the app and
reopen it; keep the same address and token. If Even Hub does not yet offer it,
say the phone update is pending rather than weakening the host plugin.

## TS-NOT-INSTALLED

Tailscale installation is OS-owned. Use current official Tailscale
instructions. Resume only after `tailscale status` works. Do not expose the
relay through another public tunnel.

## TS-AUTH

Have the user authenticate Tailscale using its normal login surface, then run
the uncapped `tailscale status` and `tailscale ip -4` checks again. Never ask
for their identity-provider password.

## TS-PORT-CLAIMED

`tailscale serve status` shows another service on `:8446`. Explain the
conflict and let the user choose whether to replace that existing route. Do
not overwrite it implicitly and do not move to `:8443`.

## TS-SERVE-UNSUPPORTED

If the installed Tailscale build does not support Serve, update Tailscale
through its official OS lane. Never substitute Funnel or a public reverse
proxy.

## PROFILE-AUTHZ-DROP

Detect this lane read-only:

```bash
hermes config get gateway.multiplex_profiles
hermes profile list
```

Enter when multiplex is true and more than one profile is listed, or when the
gateway log says `gateway.multiplex_profiles is ON with` multiple served
profiles. A wearer sees no reply while rejected turns log `Unauthorized user:`.

The restrictive posture is the exact gateway-process environment assignment
`OCUCLAW_ALLOWED_USERS=ocuclaw-wearer`. The value is a comma-separated list of
user ids; OcuClaw phone/glasses turns use `ocuclaw-wearer`. The broad
alternative, `OCUCLAW_ALLOW_ALL_USERS=true`, is authz-open and must be an
explicit operator decision, never the recommendation or default.

Hermes 0.19's `hermes config set` routes only token/API-key-shaped environment
keys to its environment store, so it cannot persist either authorization key
truthfully. Do not pretend otherwise and do not hand-edit `.env` or yaml. Ask
the gateway operator to add the restrictive assignment to the deployment's
existing environment-management surface, then restart the gateway once.
VERIFY that the boot warning naming both missing variables is absent and send
a phone-origin turn to a secondary profile. A real `Unauthorized user:` line
means the assignment did not reach the gateway process; stop for its operator.
Notification cron jobs remain on the default profile.

## TERM-HELP

Linux: Ctrl+Alt+T or Terminal in the app menu. macOS: Cmd+Space, then Terminal.
Windows: Start, then PowerShell. If the host is remote, connect the way the
user normally does (for example SSH). `command not found` often means the
wrong host or PATH; confirm `hermes --version` there first. Mind quotes around
secret placeholders.

## ESCALATE

Prefer **Send** in the OcuClaw app when available. The support bundle includes
conversation content for diagnosis, while secrets, tokens, and addresses are
scrubbed. If disconnected, offer the offline client-only bundle or Save to my
machine for manual handoff.

For Discord (`https://discord.ocuclaw.com`), assemble this block from evidence
already recorded. Show it to the user and confirm it contains no secrets or
network addresses:

```text
OcuClaw Hermes beta report — guide 2026-08-02 (1.0.0-hermes)
Hermes version:
OcuClaw bundle version (from plugin.yaml/list output):
Backend: hermes
Platform/OS:
Plugin enabled/failed state:
Relay port (number only):
Tailscale status summary (no node/address):
Failing step and exact symptom:
Relevant value-free gateway log lines:
Already tried:
Debug upload ticket (if sent):
```

Do not paste secret configuration, node names, IPs, tokens, or full logs.
