# Troubleshooting OcuClaw on Hermes

**Guide version:** 2026-08-31 (1.3.18-hermes)

This guidance was loaded through the `ocuclaw_setup` tool. Keep using the
loaded setup skill for command, secret, checkpoint, and restart rules, and use
another named tool operation for any next setup topic. Enter the narrowest case
matching observed evidence. Diagnose read-only before a mutation. Never widen
`wsBind`.

## HERMES-GATE-REFUSED

`hermes --version` must report a version in `>=0.20.0,<0.21.0`. When the host
still exposes the certified platform-registration API, the recovery row remains
registered outside that hard range, but its checks and adapter refuse startup.
Treat that row as best-effort on an unsupported, ABI-drifted host; the version
mismatch or plugin-load error remains visible in the Hermes gateway log.
Do not work around the gate or say "0.20.0 or later". Updating Hermes is outside
the OcuClaw plugin update phase and needs the user's separate decision.

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

- recent `relay rejected connection: invalid token` -> if the host credential
  is present and a paired phone is suspected lost or compromised, load
  `{"operation":"credential_reset"}`. Never ask the user to enter or reveal a
  Relay Credential. Repeat rejects may collapse for 60 seconds.
- recent `[ocuclaw] relay client connected` -> connectivity worked; inspect
  the app's compatibility message and Even Hub version.
- neither -> run `hermes ocuclaw doctor`. Follow its Serve classification and
  exact substituted command, then repeat secure pairing from
  `/ocuclaw-setup`. Never ask the user to assemble or read back an address.

Never use session listings as phone-connect evidence.

## CREDENTIAL-MISSING

Evidence: `relayTokenPresent: false` or the profile cannot read its Relay
Credential. Record only the presence boolean and stable problem code. Initial
plugin bootstrap generates the first credential only when both credential and
generation marker are absent. A marker with no readable credential proves the
profile is established: stop normal setup and load
`{"operation":"credential_reset"}`. The locally confirmed all-device reset may
proceed; it must record prior rejection as `not_applicable`, then still prove
atomic persistence, explicit gateway restart, and replacement acceptance.
Ordinary update, restart, reinstall, and re-pairing preserve a present
credential and marker; none is a replacement path.

## CLIENT-TOO-OLD

If the app reaches the relay and shows a required-version display, host setup
is correct. Update OcuClaw through Even Hub to the version named by the app and
reopen it; keep the same address and token. If Even Hub does not yet offer it,
say the phone update is pending rather than weakening the host plugin.

## TS-NOT-INSTALLED

Keep supported installation inside the current Hermes session. Detect the OS
before selecting exactly one branch below. Every branch uses one `clarify`
checkpoint explaining that the commands download and run Tailscale's official
stable installer, install its client and service, and change no OcuClaw or
tailnet policy. Offer `Install Tailscale` and `Stop setup`, with the install
choice recommended. Never mix commands from different OS branches.

### Linux

Confirm `uname -s` reports Linux and `curl` is available. The checkpoint shows
this exact download block as indented plain text:

```bash
install_dir="$(mktemp -d /tmp/ocuclaw-tailscale.XXXXXX)" &&
chmod 700 "$install_dir" &&
curl -fsSL https://tailscale.com/install.sh -o "$install_dir/install.sh" &&
sh "$install_dir/install.sh"
```

`mktemp` creates an unpredictable user-private directory; never replace it with
a fixed `/tmp` filename. The quoted variable carries the path from creation
through execution, and `&&` prevents execution after a failed preparation or
download. After approval, run the complete block as one agent Terminal command.
If the shell is already privileged, run it directly. Otherwise use Hermes
Desktop or TUI's native approval/elevation surface for that same complete block;
the user may enter an OS password only in that native surface. Handing the block
to a separate user terminal is the last resort after native execution is
unavailable, cancelled, or refused.

Verify `command -v tailscale`, the daemon state, and `tailscale --version`
without asking the user to report success. A failed or unsupported installer
stays in this case with its non-secret error. Success advances immediately to
`TS-AUTH`.

### macOS

Confirm `uname -s` reports Darwin, macOS is 13 or newer, and `curl` is
available. The macOS 13 floor is required because Tailscale's supported
Standalone CLI integration requires Ventura 13.0 or later. Tailscale recommends
its standalone app. The checkpoint shows this exact private download block and
the app-open command as separate indented plain-text blocks:

```bash
install_dir="$(mktemp -d /tmp/ocuclaw-tailscale.XXXXXX)" &&
chmod 700 "$install_dir" &&
curl -fsSL https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg -o "$install_dir/Tailscale.pkg" &&
installer -pkg "$install_dir/Tailscale.pkg" -target /
```

```bash
open -a Tailscale
```

Run the complete private-directory/download/install block as one command using
Hermes Desktop's native approval/elevation surface. The quoted variable carries
the path through installation, and `&&` prevents install after a failed
download. After it succeeds, run the separate `open` command without elevation.
Never replace the private directory with a fixed `/tmp` filename.
Use one `clarify` question asking the user to approve macOS's Tailscale system
extension/VPN prompts, sign in from the app, and enable its CLI integration at
Settings -> CLI integration -> Show me how -> Install Now. Offer `Ready` and
`Cancel setup`. Those Apple consent surfaces are human-owned; never attempt to
bypass them. After `Ready`, verify `tailscale status` and `tailscale ip -4`
automatically and continue to the Serve checkpoint.

### Windows

Confirm native Windows 10 or newer. Hermes Terminal uses Git Bash on Windows,
so the checkpoint must show this complete explicit PowerShell invocation as
indented plain text; do not send bare PowerShell syntax to Terminal:

```bash
powershell.exe -NoProfile -NonInteractive -Command '& {
  $ErrorActionPreference = "Stop"
  $installDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ocuclaw-tailscale-" + [guid]::NewGuid())
  [System.IO.Directory]::CreateDirectory($installDir) | Out-Null
  $installerPath = Join-Path $installDir "tailscale-setup.exe"
  Invoke-WebRequest -Uri https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe -OutFile $installerPath
  $process = Start-Process -FilePath $installerPath -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) { exit $process.ExitCode }
}'
```

The GUID-named directory is unpredictable inside the current user's temporary
directory; never replace it with a fixed installer filename. PowerShell's Stop
error preference prevents elevation after a failed download, and the final
check propagates a failed installer exit. The user approves only the native
Windows elevation dialog. The installer normally opens Tailscale; otherwise
open it from the Start menu. Use one `clarify`
question asking the user to choose Log in from the Tailscale tray app, finish
browser sign-in, and select `Ready`; also offer `Cancel setup`. Then verify
`tailscale status` and `tailscale ip -4` automatically. If this already-running
Hermes process cannot see the newly installed CLI but Windows can locate it,
explain that the install succeeded, restart Hermes once to refresh PATH, and
resume at this saved checkpoint. Do not reinstall Tailscale.

For WSL, use the Linux branch only when the user explicitly intends a separate
WSL tailnet node; otherwise install on the Windows host. For an unsupported OS
or a supported installer that rejects the host, explain the non-secret error
and use the current official Tailscale instructions.

Every successful branch proceeds automatically. Never ask the user to say
"continue OcuClaw setup" unless Hermes itself had to restart, and never expose
the relay through another public tunnel.

## TS-AUTH

On Linux, or any host where the Tailscale CLI is installed but not signed in,
start the login from the current Hermes session with:

```bash
tailscale up --timeout=10s
```

Use the agent's Terminal tool. If that exact attempt reports a permission
refusal, use the native approval/elevation surface for one retry with only the
host's standard elevation prefix added. A timeout that prints an authentication
URL is the expected handoff, not an installation failure.

Put the returned URL in one plain-text `clarify` question and ask the user to
open it in their browser, finish Tailscale sign-in, then select `I've signed
in`; also offer `Cancel setup`. Never ask for their identity-provider password.
After the selection, run the uncapped `tailscale status` and `tailscale ip -4`
checks automatically. If the host still needs login, run the bounded command
once more to obtain a current URL and repeat the same question. When both checks
succeed, continue directly to the Serve checkpoint without asking the user to
say "continue" or run a command.

## TS-PORT-CLAIMED

`hermes ocuclaw doctor` classifies the route as `wrong`. Explain the printed
reason. Do not overwrite another service implicitly, move to `:8443`, or
invent a teardown. Only the exact command printed by `doctor` is eligible for
a checkpoint.

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

Hermes 0.20's `hermes config set` routes only token/API-key-shaped environment
keys to its environment store, so it cannot persist either authorization key
truthfully. Do not pretend otherwise and do not hand-edit `.env` or yaml. Ask
the gateway operator to add the restrictive assignment to the deployment's
existing environment-management surface, then restart the gateway once.
VERIFY that the boot warning naming both missing variables is absent and send
a phone-origin turn to a secondary profile. A real `Unauthorized user:` line
means the assignment did not reach the gateway process; stop for its operator.

## TERM-HELP

Linux: Ctrl+Alt+T or Terminal in the app menu. macOS: Cmd+Space, then Terminal.
Windows: Start, then PowerShell. If the host is remote, connect the way the
user normally does (for example SSH). `command not found` often means the
wrong host or PATH; confirm `hermes --version` there first. Mind quotes around
secret placeholders.

## ESCALATE

Open OcuClaw's built-in **Report a bug** feature and send the diagnostic
report. It includes relevant conversation details while scrubbing secrets,
tokens, and addresses. If disconnected, create the offline client-only report
or save it to the phone for manual sharing.

For Discord (`https://discord.ocuclaw.com`), assemble this block from evidence
already recorded. Show it to the user and confirm it contains no secrets or
network addresses:

```text
OcuClaw Hermes beta report — guide 2026-08-31 (1.3.18-hermes)
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
