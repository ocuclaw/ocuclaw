# Cloudways managed Hermes — userspace Tailscale kept alive by OcuClaw

**Guide version:** 2026-10-28 (1.3.27-hermes)

Use this branch in place of fresh-install Steps 6 and 7 when the host is a
Cloudways **Managed AI Agents** container. Everything else in the fresh-install
guide stays as written: rejoin it at Step 8 once C5 below is green. The
setup receipt's `journey` keeps driving; this branch adds one sub-check.

## Chat setup comes first

When `ocuclaw_setup` offers `next`, setup on Cloudways is SKILL.md's **Chat
setup**: call `next` and relay its lines. The user stays in the Cloudways
Hermes web chat. `next` starts Tailscale, gets the approval link, opens the
private route behind an approval card, pairs the phone from a code typed in
chat, and announces the one container restart in its own words. Nobody opens
a terminal or SSH on that path, nothing on this page is run by hand, and the
SSH reconnect steps under **Before any restart** do not apply.

Read the rest of this page only for:

- a `stuck` result, to understand what `next` checked;
- an older plugin with no `next`;
- a user who asks to run setup in their own terminal instead.

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

Cloudways stays Tailscale-only: `hermes ocuclaw cloudways setup` refuses when
`platforms.ocuclaw.extra.phoneAddress` is set. Tell the user to clear it with
`hermes config set platforms.ocuclaw.extra.phoneAddress ''`.

## Terminal fallback: one command

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

**A model comes first, from the Cloudways panel.** Right after the host check,
setup reads whether a model is signed in and selected. It never signs in
itself. With no model it says to sign in to OpenAI in the Cloudways panel
(**LLM & Channels → OAuth → OpenAI → Connect**) and stops, with `--yes` too.
That Connect restarts the container and can take several minutes, so never
start it while setup runs and never tell the user to skip the model. Once the
agent is back, run the same setup command again: it reads the model as signed
in and carries on. Signed in with no model chosen, it names `hermes model` and
stops the same way. A check setup cannot read never stops it.

**ChatGPT needs device code sign-in turned on first.** That Connect signs in to
ChatGPT with a link and a one-time code, and ChatGPT refuses it until the
account's **Enable device code sign-in for Codex, Excel, PowerPoint, and Word**
switch is on (ChatGPT **Settings → Security and login → App security**,
https://chatgpt.com/settings/security). While it is off, the sign-in can loop
through account picking and security checks before ChatGPT says why. If the
user says the OpenAI sign-in is refused or keeps looping, tell them to turn that
switch on and click Connect again. On a ChatGPT Business, Enterprise or Edu
workspace, an admin may have to allow it.

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

It asks at most twice on this host, each time defaulting to no. Step 2 applies
the glasses settings (tool progress kept out of the chat, reply streaming, and
live reasoning when unset) as part of the setup command the user ran, and asks one question only while
"Continue here" is off:
`Continue your Desktop and terminal chats on your glasses? Type yes or no: `.
A yes turns it on; a no skips that one setting, says
`Not turned on. To turn it on later, run the same setup command again.`, and
setup carries on. Live reasoning is gateway-wide: setup announces the default,
preserves saved values, and uses the same pending restart as the other settings.
The other question is the tailnet route. On a host that
has a bounded restart plan, step 3 adds a restart question before it restarts
the gateway; a Cloudways container has no such plan, so it never appears here.
`--yes` answers all of them (use it only
for automation), `--no-pair` stops at step 7 with exit 0 and a line naming the
command that resumes, `--no-first-use` stops at step 8 the same way,
`--wait <seconds>` sets how long it waits for the node to be approved
(default 600), `--first-use-wait <seconds>` sets how long it waits for the
first phone reply (default 600), `--hostname <name>` names a fresh tailnet
node, `--light-terminal` is kept so older commands still run and does nothing,
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
  `hermes -z hello`; if the model returns an error, step 8 prints the verdict
  plainly -- the chain works, the model is unreachable: the message reached the
  agent and its reply reached the glasses, but the model answered with an error
  instead of an answer. The next line names the failure and its one fix: a
  rejected sign-in (sign in again with `hermes model`), out of quota or
  billing (check the plan), rate limited (wait for the limit or choose another
  model), or a busy or failing provider (try again in a minute, or check with
  `hermes -z hello`). The outcome is refused, nothing is recorded, and the
  step asks for a rerun once the model is fixed. It never asks the wearer
  whether the reply appeared. When the phone reports that
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
  - Loaded, but the gateway still runs older OcuClaw code than the files on
    disk (an upgrade such as `hermes plugins install ocuclaw/ocuclaw --force`
    or `hermes plugins update ocuclaw` with no restart since): `Your agent is
    still running OcuClaw <old>. OcuClaw <new> is installed.`, or `Your agent
    is still running an older OcuClaw than the one installed.` when the two
    versions cannot both be named. It never says "loaded and ready" then. The
    same restart follows as for "not loaded": typed by hand over SSH (exit 2),
    asked and run by setup in the WebUI terminal, asked first on a host with a
    bounded restart plan. The check compares the version the running gateway
    reports with `plugin.yaml`, and when the installed files landed with when
    the gateway started; when neither can be read it asks for no restart.
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
- **The questions are short by default.** Step 2 lists no settings: it asks
  only about Continue here, then says `Glasses settings applied.` Step 6 says
  what the route is and is not, then shows the exact command it will run.
  `--details` prints the full technical block for both. It changes what the
  steps say, never what is done or what is asked.
- **Continue here is a follow-up.** While its setting awaits a gateway start,
  the last line is `Continue here activates at the next agent restart.` No
  immediate second restart is needed to finish Core Setup Completion. A run in
  which the user said no to it never prints that line. To turn it on later,
  run the same setup command again once the agent has restarted: it asks again
  while Continue here is off. The run that carries on after the step 3 restart
  does not ask again.

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

## The pairing code and its five minutes

The code lasts five minutes, and it used to appear before the user had the
phone in hand. On a real terminal, step 7 now waits before it mints the code:

```
Open Even on your phone. The pairing code lasts 5 minutes.
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

The pair prompt asks for the phone code OcuClaw shows. For manual pairing the
user types `m` at the pair prompt, then in OcuClaw taps **Pair with your agent >
Pair manually** and types the address and pairing code the terminal shows.
Four-word instructions appear only after the phone joins. Compare the boxed words in order, then type
`approve`, `refuse`, or `cancel`. Letter case is ignored; punctuation and typos
never approve. Invalid answers re-prompt within the existing retry bound.
Approval remains pending until the phone authenticates back.

## What is different on this host

Tell the user once when entering this branch: OcuClaw is partnered with
Cloudways. Cloudways staff are available in the Cloudways channel in the
OcuClaw Discord: https://discord.ocuclaw.com/ (write the URL bare, never as a
Markdown link; the Hermes TUI hides a link's address).

Hermes runs as a non-root user inside a container: no privilege elevation of
any kind, no systemd, no cron binary, no TUN device, and the system
`tailscale` command exists only on current images. `hermes gateway restart` restarts the **whole container**. Files under
the home directory survive that; background processes do not.

Cloudways has approved a user-owned **userspace-networking tailscaled** for
OcuClaw here, with state in `~/.tailscale`. The server's own `/usr/bin`
Tailscale runs it; OcuClaw downloads none of its own. OcuClaw
keeps it alive: it starts the daemon on every gateway start and checks it
every minute. `hermes ocuclaw cloudways ...` implements that path as
idempotent verbs the agent runs from its Terminal tool. The only manual work
is Tailscale authorization (a link the user opens) and the phone.

Never, on this host: any elevation or root prefix, the `TS-NOT-INSTALLED`
installers, Tailscale Funnel, ACL or tailnet policy edits,
`tailscale serve reset`, starting `tailscaled` by hand, or a cron job that
starts it (OcuClaw already does; two supervisors on one daemon is refused).

## Before any restart · reconnect and resume

Cloudways is already the selected host. Keep setup on that server; do not send
the user through another VPS installer or install Hermes on their computer.
Ask which computer they use: Windows Terminal/PowerShell on Windows, Terminal
on macOS, or their terminal app on Linux. Use the SSH command from Cloudways'
Access Details. Its SSH password is separate from the web-interface password.
If SSH reports too many authentication failures, preserve the supplied user,
host and port and add `-o PreferredAuthentications=password -o PubkeyAuthentication=no`
to that one command. It only stops SSH offering saved keys on that login, so the server asks for the password.
Passwords belong in SSH's private prompt, never this conversation.

Before handing over the restart (`quick_reference` → `Restarting the gateway`,
whose Cloudways words apply when status reports `gatewayRestartHost:
cloudways`; never the Ctrl+C words here), record the current setup session
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
The Tailscale recovery window is described under Restart survival below.

## C1 · Detect

```bash
hermes ocuclaw cloudways detect
```

- `cloudways`: continue with C2.
- `likely`: ask the user one open-ended `clarify` question with no choices,
  "Is this Hermes running on Cloudways Managed AI Agents? Type yes or no."
  Continue only on a clear yes. `likely` is not decisive, and a choice list
  would get "(Recommended)" on its first option. A timeout reply is no answer.
- `no`: leave this branch; use fresh-install Steps 6 and 7 with the system
  Tailscale.

## C2 · Install (idempotent)

Before running the command, use Hermes' `clarify` tool. Put the explanation
and command in `clarify.question` as plain text:

> This Cloudways host needs its approved user-owned Tailscale daemon before the private route can be created. This uses the Tailscale the server ships, creates protected local state, starts the daemon, and lets OcuClaw start it again after gateway restarts. Re-running it is safe.
>
>     hermes ocuclaw cloudways install
>
> Run it now?

Offer exactly **Install now** and **Not now**. Run only after **Install now**;
on **Not now**, leave this checkpoint pending. Use a prose question only when
`clarify` is unavailable. The selection is the approval; do not also have the user type one.

```bash
hermes ocuclaw cloudways install
```

One run does all of: use the server's `/usr/bin/tailscale` and
`/usr/bin/tailscaled` (`binaries platform`); create `~/.tailscale` (mode 700);
write the host receipt that points `doctor` and `status` at
`/usr/bin/tailscale --socket=...`; hand the daemon to OcuClaw
(`~/.evenclaw/state/ocuclaw.cloudways.hermes.json`); and start `tailscaled`
once. On a box an earlier OcuClaw version set up, it also removes the old
`ocuclaw-tailscale-watchdog` cron job and, when the image now ships Tailscale,
restarts the daemon from `/usr/bin` with the same `~/.tailscale` state (same
node, no new approval) and removes the `~/bin` copy. Re-running changes
nothing.

`Tailscale is missing on this server.` means the image has no
`/usr/bin/tailscaled`; nothing was written. Tell the user to restart their
agent from the Cloudways panel (that brings the current server image), then
run setup again. Never install Tailscale another way here.

Exit 2 with `never run two supervisors` means another `tailscaled` or a legacy
supervisor is already running. Do not kill it. Report the printed process
lines to the user and stop this branch. The 2026-09-15 disabled startup hook
under `~/.hermes/disabled-hooks/` and the old supervisor under
`~/.local/share/tailscale/` are reported by `status` and left alone.

## C3 · Wait for the daemon

```bash
hermes ocuclaw cloudways status --wait 45
```

`install` already started `tailscaled`; this waits for it to settle. Read the
first line:

- `daemon running`: an existing identity was adopted. Skip to C5.
- `daemon needs-authorization`: a fresh identity. Continue with C4.
- `daemon stopped` after the wait: run `hermes ocuclaw cloudways enable`, then
  `status --wait 90`. If still stopped, report the
  `~/.tailscale/log/tailscaled.log` tail to the user.

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
If the daemon fails, diagnose `status` before retrying. Retry at most once:
if that one bounded retry still has no link, explain the pending state and offer
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
`/usr/bin/tailscale --socket=/home/<user>/.tailscale/run/tailscaled.sock`
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
`/usr/bin/tailscale --socket="$HOME/.tailscale/run/tailscaled.sock"` (the
binary `status` reports in its receipt line) followed by the same arguments.

## Journey and health surfaces

- The setup receipt's `journey` gains `tailnetDaemon.state` at the
  `tailnet-route` checkpoint (`running`, `needs-authorization`, `stopped`,
  `starting`, `absent`) and `subCheck: "tailnet-daemon"` when it is not
  `running`. Fix the daemon (C3/C4) before the route.
- `hermes ocuclaw status` and `doctor` print a `Tailscale daemon (userspace,
  kept alive by OcuClaw)` section with the same state and the one command that fixes it.
  The section is absent on hosts without the receipt.
- The bare `hermes` TUI on Hermes 0.21 starts its own gateway child next to
  the managed gateway. OcuClaw's platform loads there too, but the managed
  gateway owns the relay port, so no runtime hello ever reaches the TUI's
  child and the phone tools never register in that process. The setup tool's
  `toolInventory` therefore reports `observed: false` in the TUI. That is
  expected and is not a broken bundle: continue with pairing. Only an
  `observed: true` inventory with missing tools means the install is broken.

## Restart survival

`hermes gateway restart` restarts the container. OcuClaw starts with the
gateway and starts `tailscaled` then, with the same `~/.tailscale` state, and
checks it again every minute. After any restart, run
`hermes ocuclaw cloudways status --wait 120` before probing the route.

**Activating saved optional choices restarts the container too** (Matty,
2026-09-23, #3357). When a saved Soniox key or Even AI token waits for a restart,
the phone's Home card offers **Restart Hermes** on Cloudways, and
`hermes ocuclaw optional-setup activate` works here. In both, the gateway exits
and Cloudways restarts the whole container. The phone path first waits for
active work; the CLI path does not. The CLI warns first: `This restarts the
whole container, so SSH will drop. Reconnect in about a minute. Your phone
reconnects in 1–5 minutes. Active replies are stopped, not finished.` It still asks for
`ACTIVATE`. Follow the reconnect and resume steps above before either. The
`cloudways setup` ladder does not restart by itself; it still names the
dashboard restart when OcuClaw is not loaded.

A box an earlier OcuClaw version set up kept the daemon alive with a Hermes cron
job, `ocuclaw-tailscale-watchdog`. After a plugin upgrade, the first gateway
start removes that job and OcuClaw takes over; a paused job stays disabled.
`status` reporting an old cron watchdog means run `install` once.

## Disable, enable, rollback

- `hermes ocuclaw cloudways disable`: stop keeping the daemon alive and stop it.
  The node goes offline; nothing is removed.
- `hermes ocuclaw cloudways enable`: keep it alive again and start it now.
- `hermes ocuclaw cloudways rollback --yes`: remove the supervision state, daemon,
  OcuClaw's Serve route, and the binaries and receipt this plugin provisioned
  (never `/usr/bin`).
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
