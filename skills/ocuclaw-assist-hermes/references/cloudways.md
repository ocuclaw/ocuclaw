# Cloudways managed Hermes — userspace Tailscale kept alive by Hermes cron

**Guide version:** 2026-09-21 (1.3.22-hermes)

Use this branch in place of fresh-install Steps 6 and 7 when the host is a
Cloudways **Managed AI Agents** container. Everything else in the fresh-install
guide stays as written: rejoin it at Step 8 once C5 below is green. The
setup receipt's `journey` keeps driving; this branch adds one sub-check.

## Already paired on this computer

Before installing the Cloudways Desktop companion on a computer that already
runs OcuClaw locally, update that computer's Runtime Bundle through its existing
update flow to 2.0.9 or a newer companion-compatible release. Complete that flow's
local gateway restart so it reconciles the Desktop presenter, then fully quit
and reopen Hermes Desktop with the local connection selected. Confirm local OcuClaw still
works before continuing the Cloudways helper. Updated backend files alone do
not prove the old presenter was replaced or the running Desktop reloaded it.
Updating Cloudways does not update the local
Runtime Bundle. A 2.0.6 local backend must be updated first; if the helper returns
`local_backend_update_required`, retain its files and pairing and complete that
local update before retrying. Never remove the existing pairing to install the
companion. A remote-only computer with no local Runtime Bundle needs no local
bundle installation.

Selecting Cloudways in Hermes Desktop changes which server Desktop displays.
It does not switch the phone or glasses pairing. Remote OcuClaw status is
read-only; pairing and private credential entry stay with their local owner.
Switching Desktop back to the local connection restores its local actions.
Check phone/glasses pairing separately before claiming they moved to Cloudways.

## Fast path: one command

```bash
hermes ocuclaw cloudways setup
```

On a Cloudways managed host this runs the host side of the path below in the
user's own terminal and ends at a first message whose reply is evidenced: host
check, settings, the loaded-plugin check, Tailscale install and daemon, tailnet
enrollment, the private route, the pairing ceremony, then the first message.
Eight steps, `[1/8]` to `[8/8]`, one progress line each. It reads live state
before every step and skips what is already done, so re-running after a dropped
SSH session resumes instead of redoing. There is no `--retry` flag: running the
same command again is how you resume.

**It now looks for the phone itself.** Step 5 asks the user to install
Tailscale on the phone and approve the enrollment link there, so the phone
lands on the same tailnet account by construction; any device already signed in
still works, and the step says so. Step 7 then opens with a read-only
`tailscale status --json` look for a phone on the tailnet before the pairing
ceremony runs. See **The step 7 phone check** below for every ending. Fresh
install Step 8 is no longer something you have to finish before you offer this
command; doing it first simply means step 7 finds the phone and says one line.

**A fresh run is one restart and one command.** The restart in the install
block is the only one this install needs, and the run walks `[1/8]` to `[8/8]`
in one go. Step 3 no longer stops a Cloudways host over the settings step 2
wrote: nothing in steps 4 to 8 reads them, and the one setting that does need a
gateway start is "Continue here", which the completion output names and which
switches on at the next restart by itself. Step 3 still stops when OcuClaw is
not loaded at all, because then no Relay Credential exists. Any interruption,
including a restart that closes SSH, Hermes and tmux, resumes by running the
same command again.

It asks twice on this host, each time printing exactly what changes and
defaulting to no: the settings write, and the tailnet route. On a host that
has a bounded restart plan, step 3 adds a third question before it restarts
the gateway; a Cloudways container has no such plan, so it never appears here.
`--yes` answers all of them (use it only
for automation), `--no-pair` stops at step 7 with exit 0 and a line naming the
command that resumes, `--no-first-use` stops at step 8 the same way,
`--wait <seconds>` sets how long it waits for the node to be approved
(default 600), `--first-use-wait <seconds>` sets how long it waits for the
first phone reply (default 600), `--hostname <name>` names a fresh tailnet
node, `--light-terminal` renders the pairing QR for a light background,
`--details` spells out the exact settings keys and the full route explanation
in the two questions, and `--json` prints the final summary. Exit 0 is done or
cleanly handed off, 1 a problem, 2 refused or stopped by the user.

Six facts to state plainly when you offer it:

- **The route.** On a decisive Cloudways host, and only after the user answers
  yes to the exact command the step prints, the ladder runs the Tailscale Serve
  apply itself. The relay becomes reachable inside the user's tailnet only,
  never Funnel and never the public internet. Everywhere else the plugin still
  only prints the command for the user to run (ADR-0026).
- **The settings.** Platform settings are seeded into the Hermes env file and
  carried into `platforms.ocuclaw.extra` by the plugin at gateway start. The
  ladder never writes `config.yaml`. Hermes' own display keys are set by
  running the user's own `hermes config set` line and confirming it with
  `hermes config get`; an ignored write is reported, never assumed.
- **The first message.** It is step 8 of the same command, in the same
  terminal. Nobody types a second command for it. Step 8 sends a real message
  through the user's agent, so check that the agent's model answers first with
  `hermes -z hello`; if the model returns an error, step 8 says so, records
  nothing and asks for a rerun once the model is fixed. When the phone reports that
  the glasses SDK accepted that exact reply, the step says so and asks nothing;
  otherwise it asks the wearer, on a real terminal, exactly as this skill asks
  today. `--yes` never answers that and never approves a pairing. The wearer's
  double-tap on the Hermes welcome surface still ends setup.
- **Step 3 checks OcuClaw is loaded, and no longer blocks.** It is named
  `[3/8] Checking OcuClaw is loaded` and says `OcuClaw is loaded and ready.`
  The words "Relay Credential" never reach the terminal, here or anywhere else
  in the ladder; the credential is still what the check reads, and its value is
  never read, printed or changed. The endings a user meets:
  - OcuClaw is not loaded at all: `OcuClaw is installed but your agent has not
    loaded it yet.` and `Restart the agent, then run this command again.` It
    names the Cloudways dashboard restart first, as this host's own restart
    control and the safe one, and says second what `hermes gateway restart`
    from that terminal actually does here: it stops the gateway, stopping it
    restarts the whole container, and SSH drops for a few seconds and comes
    back. Exit 2, and a rerun picks up here with the settings intact.
  - Loaded, with the step 2 settings waiting for a gateway start, on a host
    with no bounded restart plan (every real Cloudways container): nothing
    extra is said and the ladder carries on to step 4. The only setting that
    needs the restart is "Continue here", and the run's last line names it.
  - Loaded, and a bounded restart plan exists: it asks first, default no, and
    `--yes` answers it. The consent says the gateway stops and starts through
    this host's own service manager, OcuClaw is offline meanwhile, the phone
    reconnects by itself, and the command then waits up to 180 seconds for the
    gateway and the relay to report healthy. Declining exits 2 with the resume
    line and changes nothing.
  - Restarted and OcuClaw still is not running: `Your agent restarted but
    OcuClaw still is not running.` then a second line naming
    `hermes ocuclaw doctor` as the way to see why. Exit 1, because another
    restart is already known not to fix it.
  - A restart that ran but did not complete, or that came back without both
    the gateway and the relay healthy inside 180 seconds: exit 1, asking for a
    rerun once `hermes ocuclaw doctor` is clean.
- **The two questions are short by default.** Step 2 names the two settings in
  plain words and step 6 says what the route is and is not, then shows the
  exact command it will run. `--details` prints the full technical block for
  both. It changes what the questions say, never what is done or what is asked.
- **Continue here is a follow-up.** While its setting awaits a gateway start,
  the last line is `Continue here activates at the next agent restart.` No
  immediate second restart is needed to finish Core Setup Completion.

Offer this when the user would rather type one command than have you drive the
steps. C1-C5 below stay the agent-led path and the manual fallback, and they
are what you follow when the one command stops part way.

## The step 7 phone check

Step 7 runs its host-side preflight first (the gateway, the route, the derived
phone address), then looks for a phone before the pairing ceremony. The look is
read-only: `tailscale status --json`, the same read `doctor` already uses. A
peer counts as a phone when it reports an `iOS` or `android` OS, compared
case-insensitively, and says it is online. A tablet reports the same, which is
harmless: the pairing itself is what proves the link.

The endings, and the line the user sees:

| Ending | What the terminal says | What happens |
|---|---|---|
| A phone is there | `Found a phone on your private network.` | carries straight on to the ceremony |
| None, on a real terminal | the walkthrough below, then it waits | carries on by itself when a phone appears (`A phone appeared on your private network.`) |
| None, user presses Enter | `Carrying on without a phone on your private network.` | carries on to the ceremony |
| None, ten minutes passed | `No phone appeared on your private network. Switch on Tailscale on your phone, then run the same command again; it picks up here.` | stops, exit 2, nothing changed, a rerun resumes here |
| None, no terminal | `No phone is on your private network yet. Carrying on, because this is not an interactive terminal.` | carries on at once, no wait |
| The status cannot be read | nothing at all | carries on to the ceremony |

The walkthrough, printed exactly as written:

```
Phone not found on your tailnet.
Open Tailscale, sign in with the same account, and switch it on.
Waiting for your phone to appear. Press Enter to carry on anyway.
```

It re-reads the tailnet every 3 seconds and gives up after 600. Nothing
shortens that wait but Enter: `--yes` does not, and `--no-pair` skips step 7
and the check with it. A poll that cannot be read mid-wait is transient and
does not end the wait; only an unreadable opening read skips the check. Input
already sitting in the terminal when the wait arms is drained, so a stray
newline typed during step 5's long wait cannot skip the walkthrough.

Pairing expiry names the exchange phase: no phone joined, waiting for approval,
or waiting for the approved phone to connect. Unknown phase says only that
pairing did not finish. Tailnet presence never proves code entry.
A refused or cancelled approval is a decision, not a missing phone.
Whenever no message arrives from the phone in step 8, it
says `Tailscale on your phone has to stay switched on for the phone to reach this server.`

## The pairing code and its two minutes

The code lasts two minutes, and it used to appear before the user had the
phone in hand. On a real terminal, step 7 now waits before it mints the code:

```
Open Even on your phone. The pairing code lasts 2 minutes.
Press Enter when ready.
```

The ready gate is bounded by the existing input timeout. It is skipped when there is no interactive
terminal and when `--yes` is set, and input already sitting in the terminal is
drained first, the same as the phone wait above.

If a code does run out with nothing claiming it, the command no longer ends.
It says

```
Press Enter for a new code, or type stop:
```

Enter mints a fresh code in the same step; `stop` finishes there. Without an
interactive terminal it still exits 1, as before.

The scan state keeps Address and Pairing code above the QR. Small terminals
use Manual pairing rather than clipping the QR. Four-word instructions appear
only after the phone joins. Compare the boxed words in order, then type
`approve`, `refuse`, or `cancel`. Letter case is ignored; punctuation and typos
never approve. Invalid answers re-prompt within the existing retry bound.
Approval remains pending until the phone authenticates back.

## What is different on this host

Tell the user once when entering this branch: OcuClaw is partnered with
Cloudways. Cloudways staff are available in the Cloudways channel in the
[OcuClaw Discord](https://discord.ocuclaw.com/).

Hermes runs as a non-root user inside a container: no privilege elevation of
any kind, no systemd, no cron binary, no TUN device, and the system
`tailscale` command does not exist. `hermes gateway restart` restarts the **whole container**. Files under
the home directory survive that; background processes do not.

Cloudways has approved exactly two things for OcuClaw here: a user-owned
**userspace-networking tailscaled** (binaries in `~/bin`, state in
`~/.tailscale`) and **Hermes cron** as the supervisor that starts it again
after a restart. `hermes ocuclaw cloudways ...` implements that path as
idempotent verbs the agent runs from its Terminal tool. The only manual work
is Tailscale authorization (a link the user opens) and the phone.

Never, on this host: any elevation or root prefix, the `TS-NOT-INSTALLED`
installers, Tailscale Funnel, ACL or tailnet policy edits,
`tailscale serve reset`, starting `tailscaled` by hand, or editing the
generated watchdog script.

## Before any restart · reconnect and resume

Cloudways is already the selected host. Keep setup on that server; do not send
the user through another VPS installer or install Hermes on their computer.
Ask which computer they use: Windows Terminal/PowerShell on Windows, Terminal
on macOS, or their terminal app on Linux. Use the SSH command from Cloudways'
Access Details. Its SSH password is separate from the web-interface password.
If SSH reports too many authentication failures, preserve the supplied user,
host and port and add `-o PreferredAuthentications=password -o PubkeyAuthentication=no`.
Passwords belong in SSH's private prompt, never this conversation.

Before invoking the supervisor-aware restart, record the current setup session
ID in the existing lane card. Read `HERMES_SESSION_ID` from the current terminal
tool context when available; otherwise use `hermes sessions list` and match this
setup conversation explicitly. If ambiguous, have the user select it. Never
choose the latest chat: it may be the phone proof conversation.

Show the complete recovery instructions while this TUI is still available:

1. This restart disconnects SSH and closes Hermes and tmux. That is expected.
2. Reconnect with the exact Cloudways SSH command, including the password-auth
   options when needed. Keep this command on the user's computer.
3. Run `hermes --resume <exact-setup-session-id>` in that terminal, then say
   “continue OcuClaw setup”. Substitute the confirmed ID before presenting it.

Record saved choices, pending activation, resolved optional choices and restart
count in that same conversation before requesting restart. On return, obtain
fresh setup/preflight/status receipts and follow `journey.nextCheckpoint`.
Retain choices whose durable settings still agree; diagnose disagreement.
Check effective gateway configuration and relay health before clearing pending
activation. A saved setting or an old healthy gateway is not activation proof.
If SSH returns but the gateway/relay does not, mark `restart recovery required`,
inspect gateway status and the existing restart receipt, and report the specific
failure. Do not issue another restart just because the previous tool disconnected.
The watchdog recovery window is described under Restart survival below.

## C1 · Detect

```bash
hermes ocuclaw cloudways detect
```

- `cloudways`: continue with C2.
- `likely`: ask the user one `clarify` yes/no question, "Is this Hermes running
  on Cloudways Managed AI Agents?" Continue only on yes.
- `no`: leave this branch; use fresh-install Steps 6 and 7 with the system
  Tailscale.

## C2 · Install (idempotent)

Before running the command, use Hermes' `clarify` tool. Put the explanation
and command in `clarify.question` as plain text:

> This Cloudways host needs its approved user-owned Tailscale daemon and watchdog before the private route can be created. This installs verified Tailscale binaries in your home directory, creates protected local state, and registers a Hermes cron watchdog so it returns after gateway restarts. Re-running it is safe.
>
>     hermes ocuclaw cloudways install
>
> Run it now?

Offer exactly **Install now** and **Not now**. Run only after **Install now**;
on **Not now**, leave this checkpoint pending. Use a prose question only when
`clarify` is unavailable; never ask the user to type approval after a selection.

```bash
hermes ocuclaw cloudways install
```

One run does all of: download the pinned Tailscale `1.102.4` tarball and verify
its SHA-256 against both the pinned value and the publisher's `.sha256` file
(existing binaries are adopted when they already print that version), create
`~/.tailscale` (mode 700), write the host receipt that points `doctor` and
`status` at `~/bin/tailscale --socket=...`, write the watchdog script to
`~/.hermes/scripts/`, create the every-minute Hermes cron job
`ocuclaw-tailscale-watchdog` (`--no-agent`, no LLM) or keep the existing one,
and fire it once. Re-running reports `adopted` / `kept` and changes nothing.

Exit 2 with `never run two supervisors` means another `tailscaled` or a legacy
supervisor is already running. Do not kill it. Report the printed process
lines to the user and stop this branch. The 2026-09-15 disabled startup hook
under `~/.hermes/disabled-hooks/` and the old supervisor under
`~/.local/share/tailscale/` are reported by `status` and left alone.

## C3 · Wait for the daemon

```bash
hermes ocuclaw cloudways status --wait 45
```

The watchdog starts `tailscaled` on the next cron tick (up to about a minute).
Read the first line:

- `daemon running`: an existing identity was adopted. Skip to C5.
- `daemon needs-authorization`: a fresh identity. Continue with C4.
- `daemon stopped` after the wait: run the same command once more with
  `--wait 90`. If still stopped, run `hermes cron list --all` and report the
  job line and `~/.tailscale/log/tailscaled.log` tail to the user.

## C4 · Enroll (the one manual step)

```bash
hermes ocuclaw cloudways enroll
```

Before the call, tell the user registration can take up to 90 seconds and that
you are waiting for its authorization link. The helper starts `tailscale up`
once, then observes the existing daemon enrollment within that total budget.
Progress appears on stderr; `--json` stdout remains one result. A pending result
is not a failed registration. `retry` observes the same enrollment, including a
link that arrives after the original command's 25-second deadline. Cancellation
stops observation and preserves enrollment for retry; it does not log out.
If the daemon fails, diagnose `status` before retrying. Never loop indefinitely:
after one bounded retry still has no link, explain the pending state and offer
to retry later or cancel setup. Do not print daemon logs or secrets to the wearer.

Put the returned URL in one plain-text `clarify` question: ask the user to open it
on any device signed in to their tailnet, approve the node, then select
`I've authorized it`; also offer `Cancel setup`. Never ask for their
identity-provider password. Then run `hermes ocuclaw cloudways status --wait 45`
until it reports `daemon running`. To recover a delayed link or resume observation:

```bash
hermes ocuclaw cloudways retry
```

`status` prints the node's key expiry. Tell the user once: disable key expiry
for this node in the Tailscale admin console, or the node will need this
authorization again when the key expires.

## C5 · Serve the relay at :8446

Run fresh-install Step 7 exactly as written: `hermes ocuclaw doctor` prints the
fully substituted apply command. On this host it begins with
`/home/<user>/bin/tailscale --socket=/home/<user>/.tailscale/run/tailscaled.sock`
because the receipt tells `doctor` which binary owns the route. Run that exact
line only after Step 7's `clarify` approval, then `doctor` again. The bounded reachability and relay checks must
report `reachable_yes` and `relay_credential_accepted`; on this host they dial
through the daemon's loopback proxy, because a userspace node cannot otherwise
reach its own tailnet name. Configuration shape alone is not success.

On a brand-new node the first `doctor` after applying the route usually
reports both checks as timeouts: the first connection makes Tailscale issue
the node's TLS certificate, which takes longer than the 5 s probe budget. Wait
30 s and run `doctor` once more before suspecting MagicDNS or HTTPS
Certificates; only a repeat timeout points at the admin-console settings.

Then continue at fresh-install **Step 8**. Wherever a later step runs a bare
`tailscale` command (Step 8's `tailscale status --json`), run
`~/bin/tailscale --socket="$HOME/.tailscale/run/tailscaled.sock"` followed by
the same arguments.

## Journey and health surfaces

- The setup receipt's `journey` gains `tailnetDaemon.state` at the
  `tailnet-route` checkpoint (`running`, `needs-authorization`, `stopped`,
  `starting`, `absent`) and `subCheck: "tailnet-daemon"` when it is not
  `running`. Fix the daemon (C3/C4) before the route.
- `hermes ocuclaw status` and `doctor` print a `Tailscale daemon (userspace,
  cron-kept)` section with the same state and the one command that fixes it.
  The section is absent on hosts without the receipt.
- The bare `hermes` TUI on Hermes 0.21 starts its own gateway child next to
  the managed gateway. OcuClaw's platform loads there too, but the managed
  gateway owns the relay port, so no runtime hello ever reaches the TUI's
  child and the phone tools never register in that process. The setup tool's
  `toolInventory` therefore reports `observed: false` in the TUI. That is
  expected and is not a broken bundle: continue with pairing. Only an
  `observed: true` inventory with missing tools means the install is broken.

## Restart survival

`hermes gateway restart` restarts the container. The gateway's cron scheduler
starts about 30 s later and its first tick about a minute after that; the
watchdog then starts `tailscaled`. Measured on the test host: node `running`
again 18–100 s after the container came back. After any restart, run
`hermes ocuclaw cloudways status --wait 120` before probing the route.

One slower case, seen once: the container bounced a second time while the
watchdog's first tick was running. Hermes cron then holds that tick's fire
claim for 300 s, every tick in that window logs `Fire claim lost; execution
was not started`, and the daemon returns on the first tick after the claim
expires (5 min 16 s after the final boot on the test host). If `status
--wait 120` still says `stopped`, run it once more with `--wait 300` before
reporting anything. `hermes cron list --all` shows the same job line and
`Last run` throughout; nothing needs repair.

## Disable, enable, rollback

- `hermes ocuclaw cloudways disable`: pause the cron job and stop the daemon.
  The node goes offline; nothing is removed.
- `hermes ocuclaw cloudways enable`: resume the job and fire it now.
- `hermes ocuclaw cloudways rollback --yes`: remove the job, daemon, script,
  OcuClaw's Serve route, and the binaries and receipt this plugin provisioned.
  The Tailscale identity in `~/.tailscale` is kept unless `--purge-identity` is
  added, so a later `install` comes back `running` without a new authorization.
  Without `--yes` it refuses (exit 2). Rollback is a `clarify` checkpoint;
  never run it unasked.
  - The tailscale-CLI receipt is host-scoped and shared with the OpenClaw
    bundle. When somebody else provisioned it, rollback keeps it, the binaries
    it names and the identity in `~/.tailscale` — `--purge-identity` included,
    because that identity is the other install's node key. It prints one line
    per kept thing and reports `receiptKept` (the provisioner), `binariesKept`
    and `identityKept` in `--json`. That box still needs its own
    `openclaw ocuclaw cloudways rollback` to finish cleaning up.
