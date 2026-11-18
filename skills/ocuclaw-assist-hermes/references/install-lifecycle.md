# OcuClaw installation and lifecycle reference

**Guide version:** 2026-10-28 (1.3.27-hermes)

This reference is for OcuClaw train `2.2.0` and Setup Assistant guide
`1.3.27-hermes`. The backend plugins need the OcuClaw `2.2.0` client or newer (the
phone app ships as `2.2.1`), and that client needs the `2.2.0` plugins; both
compatibility floors are `2.2.0`. These identities are independent
of the Hermes package version
(certified baseline `0.23.2`, tested `>=0.21.4,<0.24.0`) and certified source
commit.

The Relay Credential is host-managed: initial plugin bootstrap generates it
once on a provably fresh profile, stores it through Hermes's atomic `.env`
contract, and never reveals, returns, exports, imports, or asks for it. Optional
Soniox and Even AI credentials use a private Desktop form, or Hermes' masked
prompts for terminal users. Values bypass the setup chat and are stored in the
active profile's `.env`; this is not an OS keychain or a sandbox against an
agent with filesystem access.

## Install and update

<!-- ocuclaw:install-block:start -->
OcuClaw needs Hermes 0.21.4 or newer. It is tested on `>=0.21.4,<0.24.0`, and
the certified baseline is Hermes `0.23.2`; a newer Hermes runs with a warning.
Install it once, in the default Hermes profile: that profile owns the
relay the glasses pair to, and a second copy in another profile is never the
answer.

**Repository access.** `ocuclaw/ocuclaw` is a public repository and needs no
invitation or GitHub sign-in to clone. Git must still be installed and working
on the installing machine (Desktop uses Git too). Verify with
`git ls-remote https://github.com/ocuclaw/ocuclaw.git HEAD` before installing;
no GitHub token is needed, so never paste one into setup chat. Even Hub beta
access is a separate invitation.

**Setup runs in your agent's chat.** Once OcuClaw is installed, the main way to
finish setup on every host is to ask your agent in its own chat (on Cloudways,
the web UI behind **Open Agent**): "Install OcuClaw and set it up for my Even G2
glasses." The agent relays OcuClaw's own nine setup steps word for word. You
approve the private route on a card in the chat, open the Tailscale link it
gives you, type the phone code from OcuClaw's **Pair this phone** sheet into the
chat, and allow the four-words card only if the words match your phone or
glasses. The TUI pairs the same way. Hermes Desktop shows its own pairing
panel for the code and the words instead. Hermes loads OcuClaw only when it
restarts, so right after the agent installs it, the agent runs
`hermes ocuclaw setup-start`: it turns on OcuClaw's settings and restarts Hermes
once. On Cloudways that restarts the whole container: open the chat again and
type `continue`. If the agent cannot install OcuClaw itself, run the install
line below yourself, then `hermes ocuclaw setup-start`, then ask again.
The terminal commands below are the fallback.

**Terminal first.** Of the two ways to install, this is the supported one and
the one every release is tested on:

**Cloudways managed Hermes: install, then one command. Do not restart yet.**

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes ocuclaw cloudways setup
```

`hermes ocuclaw cloudways setup` takes the host from an installed plugin to a
paired phone and an evidenced first reply, in numbered steps `[1/8]` to `[8/8]`
in your own terminal. It reads live state before every step and skips what is
already done. It asks twice, showing exactly what changes and defaulting to no.
There is no retry flag: run the same command again and it continues where it
stopped.

**One restart, asked for at step 3.** Ignore the restart line
`hermes plugins install` prints. Setup saves its settings at step 2, then step 3
checks whether your agent has loaded OcuClaw. On a fresh install it has not, so
step 3 stops and asks for the one gateway restart that loads OcuClaw and applies
those settings together: type `hermes gateway restart`. On Cloudways that
restarts the whole container and closes SSH, Hermes and tmux, so reconnect with
the Cloudways SSH command and run `hermes ocuclaw cloudways setup` again: it
skips what is done and carries on from there. A host whose service manager owns
the gateway asks first at step 3, restarts it for you, and carries on in the
same run. If anything else interrupts the run, run the same command again.

**The command looks for your phone before it pairs it.** Step 5 asks you to
install Tailscale on the phone and approve the link there. Step 7 then checks
whether a phone is on your private network. If one is, it says so and carries
on. If none is, it explains what Tailscale is, gives you three short steps, and
waits, checking again every few seconds; it carries on by itself the moment
your phone turns up, and pressing Enter carries on anyway. The wait stops after
ten minutes, having changed nothing, and running the same command again picks
up right there. Leave Tailscale switched on afterwards: the phone needs it to
reach this server.

**The pairing code waits for you.** It lasts five minutes, so step 7 asks you to
have the phone in your hand with the Even app open, and waits for you to press
Enter before it makes the code. If a code does run out before anyone uses it,
the command does not give up: press Enter for a new one, or type `stop` to
finish there.

**Check your agent's model before you start.** Step 8 sends a real message
through your agent and waits for its reply on the glasses. Run `hermes -z hello`
first. If your model answers, step 8 will too. If it returns an error, such as a
rate limit, step 8 says so, records nothing, and asks you to fix the model and
run the same command again.

The guided assistant remains the fallback: open a fresh `hermes --tui`, enter
`/ocuclaw-setup`, and it walks the same path with you. It loads the setup skill
and tools in that fresh process, saves your agent choice and required settings,
gives you the SSH reconnect command and the exact saved-session resume command,
and requests one planned activation restart. Resume that setup session by its
ID; do not blindly reopen the latest chat. Saved configuration is not gateway
activation: the assistant must verify the new gateway and relay.

For other hosts in a terminal, install, then go straight to setup:

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes config set display.interface tui   # the pairing panel lives in the TUI
```

Then, in a fresh `hermes --tui`:

```text
/ocuclaw-setup
```

`hermes plugins install` prints that restart instruction and stops there — it
never restarts the gateway for you. Until the gateway restarts, OcuClaw is
installed but not loaded by that managed gateway, and nothing about the glasses
works through it yet. A fresh TUI can prepare setup before that activation, so
do not restart yet: `/ocuclaw-setup` saves its settings first and then asks for
one gateway restart, which loads OcuClaw and applies those settings together.

**Run `hermes` in a real terminal.** The TUI boots only when stdin *and*
stdout are a TTY, so a piped or captured run — `hermes | tee log`, a CI
capture, a headless spawner — silently falls back to the classic CLI: same
prompt, no pairing panel, and `/ocuclaw-setup` with nowhere to pair. Forcing
it with `--tui` there does not render either; it bails out instead.

**Never install with `--ref`.** A ref-pinned install is recorded as
`pinned: true`, and `hermes plugins update ocuclaw` then refuses to move it
forward at all; the only way out is another explicit
`--force --ref <40-character SHA>` install. Take the published tip —
`hermes plugins install ocuclaw/ocuclaw --enable`, nothing more.

**Hermes Desktop second.** Opening

```text
hermes://plugin/install?repo=ocuclaw/ocuclaw
```

installs the same bundle through the Desktop install modal, enabled by default.
OcuClaw ships **one** Desktop UI, and the enabled plugin generates it, so the
order is: install, restart the gateway, then pair. The window stays open the
whole time.

1. Restart the gateway — use the native **Restart gateway** button when the
   OcuClaw card is visible, otherwise `hermes gateway restart` in a terminal. Until it
   restarts, OcuClaw is installed but not loaded, and there is no OcuClaw
   Desktop UI yet. On the card, that one click also restarts Desktop's backend
   so the pairing panel loads. The card reads **Finishing setup…** meanwhile.
2. The OcuClaw setup card then appears in the title bar. Wait until it turns
   green, reads **OcuClaw ready** and offers **Pair your glasses**. If the card
   instead reads **Quit and reopen Hermes Desktop to finish setup**, do that.
   Run `/ocuclaw-setup` and finish pairing. The card
   retires on the durable pairing receipt and stays gone, including across a
   Desktop relaunch.

Desktop leaves `display.interface` alone; the terminal-default command above
applies only to terminal setup. Optional Soniox and Even AI credentials use
private Desktop forms, with masked terminal prompts available in the TUI.

**Update.** In `hermes plugins update ocuclaw`, `ocuclaw` is the **plugin id** —
the `name:` field in `plugin.yaml` — and not the `ocuclaw/ocuclaw` repository
name. Update resolves the directory of that name under `~/.hermes/plugins`; it
never looks at the repository the plugin came from:

```bash
hermes plugins update ocuclaw
hermes gateway restart
```

Unlike install, `hermes plugins update` does **not** print the restart
instruction, and it does not restart the gateway. The new code loads on the next
gateway start and not a moment sooner, so restart it yourself — then run
`/ocuclaw-setup` and let it re-verify health.

**Cloudways Managed AI Agents.** The same install block applies. That host has
no root, so OcuClaw carries its own path for it. Setup in the agent's chat, or
`hermes ocuclaw cloudways setup` in the terminal, runs the whole of it: a
user-owned userspace Tailscale (the server's own `/usr/bin` copy; a server
without it is told to restart from the Cloudways panel) with state in
`~/.tailscale`, kept alive by OcuClaw, which starts it again after every
`hermes gateway restart` (a container restart there). When Cloudways' own
Tailscale is already running and signed in, OcuClaw uses that one instead. Then
the private tailnet route, the pairing ceremony and the first message. Cloudways
has approved those pieces. Sign your model in from the Cloudways panel
(**LLM & Channels**, then **OAuth**); setup does not sign it in for you. Your
only manual steps are opening the Tailscale authorization link and the phone.

The same work is still available one verb at a time (`hermes ocuclaw cloudways
detect`, `install`, `enroll`, `status`, `retry`, `enable`, `disable`,
`rollback`), and `/ocuclaw-setup` still guides the whole path when you would
rather be walked through it.
<!-- ocuclaw:install-block:end -->

The TUI setting keeps the supported terminal pairing panel available. Local
Hermes Desktop has the same direct-human pairing ceremony through its OcuClaw
runtime presenter in that Hermes home. The classic `hermes --cli` interface remains useful for general chat
and recovery, but hands pairing to TUI or Desktop.

The setup assistant checks the non-secret state and guides installation,
recovery, secure phone pairing, and the Hermes Welcome Round Trip. The plugin
owns both the `/ocuclaw-setup` command skill and this skill, so an install
needs no skill symlink or copied skill folder.

If an established profile reports that its Relay Credential is missing or
unreadable, setup stops instead of silently replacing it and disconnecting
phones. Follow `/ocuclaw-setup` guided recovery; do not use the fresh-install
path as a replacement or edit the profile files. The locally confirmed
all-device reset can proceed from this established-missing state; its receipt
records prior-credential rejection as `not_applicable`, while replacement
acceptance and the explicit Hermes gateway restart remain mandatory.

For a suspected lost or compromised phone, `/ocuclaw-setup` owns the locally
confirmed **Reset relay credential** action. It is an all-device reset;
per-device revocation is future work. The assistant warns that every phone
disconnects, then checkpoints this interactive-only host command:

```bash
hermes ocuclaw reset-relay-credential
```

## The Managed Serve Route

The relay listens on loopback only. Your phone reaches it over one Tailscale
Serve route, which you apply yourself — OcuClaw never changes your Tailscale
configuration. Classify the current state and get the exact command for this
host with:

```bash
hermes ocuclaw doctor
```

Run the fully substituted command `doctor` prints. Do not reconstruct it from
a hostname, port, or example. Tailscale — not OcuClaw — decides who may change
Serve configuration: where the Tailscale daemon runs as a system service
(Linux, and macOS installs that do the same) its control socket is root-owned,
so an unprivileged shell is refused. If refused, rerun the exact printed
command, unchanged, with your platform's usual administrator elevation — or
set Tailscale's `--operator` to your own account once, after which Serve
changes need no elevation. OcuClaw itself never elevates: the command it
prints carries no elevation prefix; you supply whatever privilege Tailscale
requires on this host.

If `doctor` reports the route as `wrong`, something else already occupies that
port. Check what it belongs to before replacing it — in particular, `:8444` is
the OpenClaw app relay, not OcuClaw's, and the two lanes must never be mixed.

There is one OcuClaw-managed `:8446` route per host, shared by that gateway's
Hermes profiles. A sibling gateway reports the conflict and never replaces the
route.

## Pair and finish

Stay in `/ocuclaw-setup`. Once `doctor` has verified the route, the assistant
opens a direct, model-bypassing pairing panel in the current Hermes TUI or
Desktop window. It takes the phone code OcuClaw shows, then advances
automatically to the four-word comparison and defaults the local decision to
**No**. Approve only when all four words match. **Pair manually** uses the
private address plus a short-lived pairing code shown in the same panel.
Neither route asks for a reusable credential in the phone app. If setup reaches pairing in
`hermes --cli`, it immediately gives a one-time TUI/Desktop handoff; reopening
`/ocuclaw-setup` there resumes the saved checkpoint.

Pairing alone is not Hermes Core Setup Completion. The assistant first warns
about the welcome screen and double-tap, then the user sends a message from the
phone app. The assistant then checks the reply on the G2: either the phone app
reports that the glasses SDK accepted that exact reply, or the wearer answers
the display question. Either arms a resumable one-hour
First-Run Proof Attempt. The gateway pushes its welcome lockup picture for 60 seconds;
only a returned double-tap dismissal commits durable proof and triggers the
completion announcement.

One failed dismissal gets one retry. After a second failure, setup reports the
split truth—the reply leg checked out, G2-to-agent remains unconfirmed—keeps a warning,
and points to the built-in **Report a bug** feature without claiming completion. Soniox and Even
AI are offered only afterward and never alter completion. Later outages never
erase durable proof.

## Check connection health from the terminal

Two commands render the same Connection Health Snapshot the setup assistant
reads, without needing a chat session:

```bash
hermes ocuclaw status     # passive: local facts only, always exits 0
hermes ocuclaw doctor     # bounded active checks, exits non-zero on problems
```

Both accept `--json` and print the versioned snapshot document on stdout for
scripting. Neither ever prints a secret — configuration secrets appear as
presence booleans only.

The report keeps three independent truths separate, and they do not imply each
other:

- **Hermes Setup State** — durable installation and configuration.
- **Current Connection Health** — right now, across four legs: the Hermes
  gateway, the OcuClaw relay, the tailnet route, and the phone app.
- **Hermes First-Run Proof** — whether a phone-origin turn was ever confirmed
  on G2. Outages never erase it.

`unknown` on a leg means nothing observed it, not that it is broken — a
gateway that has never run makes every connection leg unknown while setup
state stays fully readable. `doctor` exits `0` only when setup is
`configured` and all four legs are `healthy`, `1` for any other valid
snapshot, and `2` when the profile cannot be resolved safely or no snapshot
could be generated at all. `status` always exits `0` when it produced a
snapshot: it reports, it does not judge.

`doctor` reports only what it verified on this run: it never reuses an earlier
run's route evidence. Serve state is `ready`, `absent`, `wrong`, or `unknown`;
configuration shape alone remains advisory until the bounded reachability and
relay checks succeed.

For optional read-only detail, open the **OcuClaw** tab at `/ocuclaw` in the
Hermes dashboard. It is optional detail, never a fallback dependency: start
guided recovery with `/ocuclaw-setup` even when the dashboard is unavailable.

### Live reasoning on the glasses

Fresh `/ocuclaw-setup` enables live reasoning when the setting is unset and
preserves a saved choice. Updates still offer it and wait for your yes. To
change it yourself, use:

```bash
hermes config set plugins.stream_reasoning_deltas true
hermes gateway restart
```

The agent's reasoning then reaches the glasses as it is written instead of in
whole pieces. The key is Hermes' own and gateway-wide — it changes how Hermes
calls the model for every surface on this gateway, not just OcuClaw.

### Progress notes

Some models write short sentences while they work, before their answer
("Checking the logs first."). On supported Hermes 0.21.x those get their own
line in the glasses status bar and stay out of the conversation history. To
silence them at the source, in the Hermes config:

```yaml
display:
  platforms:
    ocuclaw:
      interim_assistant_messages: off
```

### OcuClaw look for Hermes Desktop

`/ocuclaw-setup` offers this at the end and waits for your yes. Hermes Desktop
then lists **OcuClaw** under Settings > Appearance > Theme — OcuClaw
black/green, with the same dark appearance in Light and Dark modes — and switches to it on its
own. Say no and the theme is still listed for later. Disabling or
uninstalling OcuClaw returns Desktop to its default skin.

## Update policy

The two update commands are in [Install and update](#install-and-update) at the
top of this card. What they are permitted to do: take a newer published version
in place through the accepted host-side upgrade contract. The platform `/update`
command is refused from Hermes sessions. There is no remove-and-reinstall step
and no downgrade.

Existing Hermes configuration, sessions, and environment values remain in the
profile; the setup assistant reports their presence without displaying their
values.

An update never turns a key on for you. If `plugins.stream_reasoning_deltas`
is still unset — `/ocuclaw-setup` says so and offers it — this is the same
pair of commands as on a fresh install:

```bash
hermes config set plugins.stream_reasoning_deltas true
hermes gateway restart
```

Same honesty as above: the key is Hermes' own and gateway-wide.

## Disable or fully uninstall

To disable OcuClaw while retaining the installed plugin:

```bash
hermes plugins disable ocuclaw
hermes gateway restart
```

The plugin-owned `/ocuclaw-setup` skill cannot load this assistant while
OcuClaw is disabled; it says so and names these steps. Re-enable that retained
install with `hermes plugins enable ocuclaw`, run `hermes gateway restart`,
and then invoke `/ocuclaw-setup` again.

For a full uninstall, first re-enable a retained disabled install with
`hermes plugins enable ocuclaw --no-allow-tool-override`; the plugin-owned
command cannot register while disabled. Obtain and run any permitted Managed
Serve Route teardown as described below. Then run the plugin-owned uninstall.
The same sequence works everywhere, Cloudways included:

```bash
hermes ocuclaw uninstall
# If it says restart_required (exit code 3):
hermes gateway restart
hermes ocuclaw uninstall
```

Removal needs OcuClaw not to be running, so its live runtime cannot recreate
state. When OcuClaw is running, the first run asks for confirmation, marks
the uninstall pending (`$HERMES_HOME/state/ocuclaw.uninstall-pending.json`),
and changes nothing else. While that mark exists, a restarted gateway loads
only the `hermes ocuclaw` command: no relay, runtime or platform. The second
run checks that the gateway started after the mark, the relay port is closed,
no OcuClaw runtime process exists and the platform is not connected, then
removes everything. It does not ask a second time, because the user already
confirmed on the first run. A host whose gateway is already
stopped finishes in one run. On Cloudways, `hermes gateway stop` restarts the
whole container, so use `hermes gateway restart` there as shown.
`hermes ocuclaw status` and `doctor` show "Uninstall pending" while the mark
exists. To keep OcuClaw instead, run `hermes ocuclaw uninstall --cancel` and
then `hermes gateway restart`.

The uninstall command asks for confirmation and prints a receipt covering each
removal, deliberate preservation, the route decision, and final absence checks.
Use `hermes ocuclaw uninstall --yes --json` for a machine-readable, already
confirmed run. It preserves the shared Hermes session database. The
plugin-owned CLI, setup tool, and skill are unavailable after it succeeds.
The final receipt also verifies that Hermes removed its own plugin-install
provenance entry; OcuClaw never edits that host-owned sidecar directly.
If only final checkout deletion is incomplete, fix the reported filesystem
problem and run the receipt's exact interpreter-level recovery command. That
command targets only the atomically renamed OcuClaw tombstone and does not
depend on Hermes registration or plugin metadata.
For safety, the command refuses without mutation when `extra.stateDir` points
outside the dedicated default `$HERMES_HOME/ocuclaw` directory; configuration
alone is not ownership proof for recursively removing an arbitrary path.
The receipt's secret check covers the profile `.env` entries OcuClaw owns.
Shell-, service-, or administrator-supplied environment values are not mutated;
their key names are reported separately for cleanup at their owning source.

### What full uninstall removes, and what it never touches

This is the removal contract. `hermes ocuclaw uninstall` removes exactly:

- the OcuClaw Agent plugin checkout, through Hermes's own generic
  `hermes plugins remove` handoff, and OcuClaw's entries in
  `config.yaml`. These include `platforms.ocuclaw.home_channel`, the home
  chat for jobs set to deliver to OcuClaw. Pairing sets it to the main
  glasses chat when no home is set, and `/sethome` on the glasses sets it
  too. It lives inside OcuClaw's own platform block, so it goes with that
  block; other platforms' home channels stay. Pairing never writes the
  `OCUCLAW_HOME_CHANNEL` env mirror; a value that `/sethome` or you put in
  `.env` is left for you to remove. They also include Hermes's saved tool
  choices for the ocuclaw platform (`platform_toolsets.ocuclaw`,
  `known_plugin_toolsets.ocuclaw`, `known_builtin_toolsets.ocuclaw`);
- the OcuClaw secret keys OcuClaw itself wrote into the profile `.env`, and
  `OCUCLAW_ALLOW_ADMIN_FROM`, the "Continue here" setting setup writes there;
- the generated Hermes Desktop runtime at
  `$HERMES_HOME/desktop-plugins/ocuclaw/plugin.js`, its own render
  temporaries, and that folder once it is empty;
- OcuClaw's private profile state under `$HERMES_HOME/state/` — the Desktop
  presenter capability and pairing activation receipts, the TUI pairing
  capability, the pairing-completion, first-run and relay-credential
  receipts, the optional-setup receipt, the Board store
  (`ocuclaw-board.db`), the scheduled Task Result store
  (`task_results.sqlite3`), their lock sidecars, and last the
  uninstall-pending mark;
- `$HERMES_HOME/ocuclaw-restart-receipts.json`;
- Hermes' pairing store files for the ocuclaw platform
  (`platforms/pairing/ocuclaw-approved.json` and `ocuclaw-pending.json`, or
  the same names under the legacy `pairing/`), which hold the glasses'
  sender approval that pairing recorded;
- OcuClaw's runtime state under `$HERMES_HOME/ocuclaw/`, saved prompts
  included;
- the `/ocuclaw-setup` skill (and the `/ocuclaw-setup` bundle older builds
  wrote) and the `ocuclaw-pair` TUI widget;
- the host-scoped Managed Serve Route receipt and its lock sidecar, but only
  while OcuClaw can still prove it owns them and the route is provably off
  (no route on the port, or the Cloudways rollback turned it off). A receipt
  for a route that could not be read stays, and the receipt says
  `route_not_proven_off`;
- on Cloudways, what `hermes ocuclaw cloudways install` set up: the Tailscale
  supervision state (and any old watchdog cron job), the userspace `tailscaled`, the `~/bin`
  binaries (never `/usr/bin`), the install receipts and the `~/.tailscale` identity (the same
  as `hermes ocuclaw cloudways rollback --yes --purge-identity`), plus
  `~/.local/share/tailscale`, an empty `~/bin` and the empty host receipt
  folder when nothing else is inside.

It keeps `~/.ocuclaw/liveui-library/`: that is your own LiveUI content and the
OpenClaw plugin may share it. The receipt names it; delete it yourself if you
no longer want it.

It never touches anything else: the shared Hermes session database, other
plugins' storage, unrelated profile configuration, other plugins' files under
`desktop-plugins/`, and any file at an OcuClaw path whose OcuClaw ownership
cannot be proved. Environment values supplied by your shell, a service unit,
or an administrator are not mutated; the receipt names those keys so you can
clean them up where they are actually set.

### Generic plugin removal is not complete removal

Generic Hermes plugin removal (`hermes plugins remove`) removes the Agent
package only. The generated
Hermes Desktop runtime at `$HERMES_HOME/desktop-plugins/ocuclaw/plugin.js`
belongs to no Hermes package — Hermes Desktop loads that directory on its own
— so generic removal leaves it in place and Hermes Desktop keeps loading it.
`hermes ocuclaw doctor` warns about this while OcuClaw is still installed.

Use `hermes ocuclaw uninstall` instead. It is the only supported complete
removal path.

### Recover from a generic removal that left an orphan

If you already removed the Agent package generically, the `hermes ocuclaw`
commands are gone with the package, so recovery cannot be an OcuClaw command.
Paste this instead. It needs only Python, refuses to act while the Agent
plugin is still installed, checks OcuClaw's first-line ownership marker before
touching anything, refuses symlinked or redirected paths, preserves anything
foreign, and is safe to run twice:

```bash
python3 -c 'import json, os, pathlib, sys

MARKER = "// OCUCLAW-OWNED-DESKTOP-PAIRING-PLUGIN v1"
home = pathlib.Path(os.environ.get("HERMES_HOME") or (pathlib.Path.home() / ".hermes"))
home = home.expanduser().absolute()
runtime = home / "desktop-plugins" / "ocuclaw" / "plugin.js"
capability = home / "state" / "ocuclaw.desktop-presenter-capability.json"
checkout = home / "plugins" / "ocuclaw"
removed = []
kept = []

def direct(path, chain):
    try:
        if any(item.is_symlink() for item in chain):
            return False
        return path.absolute() == path.resolve(strict=False)
    except OSError:
        return False

def runtime_state():
    if not direct(runtime, (home, runtime.parent.parent, runtime.parent, runtime)):
        return "unsafe path"
    if not runtime.is_file():
        return "absent"
    try:
        with runtime.open("r", encoding="utf-8") as stream:
            first = stream.readline().rstrip("\n")
    except (OSError, UnicodeError):
        return "unreadable"
    return "owned" if first == MARKER else "not OcuClaw-owned"

def capability_state():
    if not direct(capability, (home, capability.parent, capability)):
        return "unsafe path"
    if not capability.is_file():
        return "absent"
    try:
        payload = json.loads(capability.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return "unreadable"
    if not isinstance(payload, dict) or set(payload) != {"v", "capability"}:
        return "not OcuClaw-owned"
    if payload.get("v") != 1 or not isinstance(payload.get("capability"), str):
        return "not OcuClaw-owned"
    return "owned"

if checkout.exists():
    sys.stdout.write("refused: the OcuClaw Agent plugin is still installed at " + str(checkout) + "\n")
    sys.stdout.write("Run `hermes ocuclaw uninstall` instead. This command only removes an orphan left behind by generic Hermes plugin removal.\n")
    raise SystemExit(2)

state = runtime_state()
if state == "owned":
    runtime.unlink()
    removed.append(str(runtime))
    for leftover in sorted(runtime.parent.glob(".plugin.js.*.tmp")):
        if leftover.is_file() and not leftover.is_symlink():
            leftover.unlink()
            removed.append(str(leftover))
    try:
        runtime.parent.rmdir()
        removed.append(str(runtime.parent))
    except OSError:
        pass
elif state != "absent":
    kept.append(str(runtime) + " (" + state + ")")

if state in ("owned", "absent"):
    state = capability_state()
    if state == "owned":
        capability.unlink()
        removed.append(str(capability))
    elif state != "absent":
        kept.append(str(capability) + " (" + state + ")")

for item in removed:
    sys.stdout.write("removed: " + item + "\n")
for item in kept:
    sys.stdout.write("preserved: " + item + "\n")
if not removed and not kept:
    sys.stdout.write("no OcuClaw-owned Hermes Desktop orphan found under " + str(home) + "\n")
sys.stdout.write("This command removes only the generated Desktop runtime and its private presenter capability. Any other OcuClaw state under " + str(home / "state") + " is removed only by `hermes ocuclaw uninstall`.\n")
raise SystemExit(1 if kept else 0)
'```

It removes only the generated Desktop runtime and the private presenter
capability that exists to authorize it. Any other OcuClaw state left under
`$HERMES_HOME/state/` and `$HERMES_HOME/ocuclaw/` is removed only by the
supported `hermes ocuclaw uninstall`, so prefer running the supported
uninstall before the package is gone.

### Remove the Tailscale Serve route

The uninstall command does not edit Tailscale configuration. Before removing
the plugin, run `hermes ocuclaw doctor`. Only while the host-scoped Managed Serve
Route receipt and live route still agree does it print this narrow teardown:

```bash
tailscale serve --tls-terminated-tcp=8446 off
```

Run the teardown only when `doctor` prints it. It removes only OcuClaw's
`:8446` route; never use a host-wide Serve reset or remove unrelated routes
such as the OpenClaw app relay on `:8444`.

The route is host-wide. One OcuClaw-managed route serves this machine, and
your Hermes profiles share it — removing it disconnects all of them, so remove
it only when you are finished with OcuClaw on this machine.

If a second Hermes gateway is installed on the same host, the first one to
apply the route owns it. The other reports what it found and never prints a
command that would replace it.

If `doctor` does not print a teardown, it could no longer prove the route on
that port is the one it recorded. Inspect `tailscale serve status` and decide
for yourself; OcuClaw will not offer to remove a route it cannot identify.

## Guided lane without `next`

These sections came from the setup skill. They hold the opening move, the
journey checkpoints, the optional private-entry rules, the internal completion
checklist and the lane card for setup when `ocuclaw_setup` does not offer
`next`; the steps themselves are in `{"operation":"fresh_install"}`. The
setup skill keeps the gates, the question surface, the guardrails and the
router; they apply here unchanged.

### Opening move

Skip this move when `next` answers: the setup skill's **Chat setup** has its own one-line
start.

After the phone-session entry gate AND the profile ownership gate pass, your
FIRST reply in every new setup conversation does these three things, in this
order, and NOTHING else: no checklist, probes, or step content.

1. Warmly announce that you will walk them through setup and name the
   **OcuClaw Setup Assistant**. Keep guide version and provenance in diagnostic
   details, available on request.
2. Explain briefly that you will do most checks, but they will enter optional
   service credentials themselves; Hermes may restart; after an interruption
   they can say "continue OcuClaw setup".
3. Ask exactly one calibration question through Hermes' `clarify` question
   tool when it is available: are they comfortable in a terminal, or would
   they like everything explained as you go?

Shape it like this:

> I'll walk you through setting up OcuClaw with the OcuClaw Setup Assistant.
> I'll do most checks and setup. In Desktop, private Soniox and Even AI forms
> keep optional credentials out of this chat, and the Restart gateway button
> applies changes when needed. If we get interrupted, say "continue OcuClaw
> setup." Would you like each step explained, or are you comfortable with
> brief technical instructions?

For TUI/terminal entry, describe Hermes' masked credential prompts and the
guided restart instead of Desktop forms and buttons. Desktop setup leaves the
terminal default alone. Retain the same explanation and calibration contract.

First-reply output gate: if the draft lacks the announcement, expectations, or
calibration question, or contains anything else, replace it with the template
alone. This gate applies only once both earlier gates have passed. A
phone-session refusal, a profile ownership refusal, and the ownership move
lane's question are complete replies in their own right — never replace one of
them with this template. The calibration answer is the go signal. Record `User level: guided` or
`User level: terminal-comfortable` in the lane card and proceed directly.
When `clarify` is available, put the complete opening template in the
`clarify.question` string itself, including the announcement, expectations,
and final calibration question. Do not rely on prose adjacent to the tool call:
Hermes Desktop may render only the question body. A bare calibration question is invalid.
Proceed directly from the selected result; never replay the template or ask the
calibration question again afterward.

### Journey checkpoints

With a custom private route (`phoneAddress` set), the `tailnet-route`
checkpoint is skipped. A `custom-route` checkpoint appears only when the
address is invalid or the host is Cloudways; the journey carries
`customRoute: {setCommand, clearCommand}`. Show those commands and enter
`CUSTOM-ROUTE` in `{"operation":"troubleshooting"}`. Otherwise the journey goes
straight to `secure-phone-pairing`. Tailscale stays the default.

`mandatory-configuration` means enter fresh-install Step 4 directly. Read
`status.mandatoryConfiguration`, perform only missing non-secret checks, verify
them, then continue through the explicit optional Step 4b choice. Connection
health describes the relay, not completion of these guide checks. Proven or
armed completion receipts keep their existing resume point; do not replay
earlier onboarding for them.

On first setup only, after calibration and the read-only status, ask the G2
ownership question in fresh-install Step 1 before starting configuration, even
when the local relay is already healthy. A durable pairing/completion receipt
or the lane card's recorded G2 answer satisfies this question. Resume uses that
answer; updates, recovery, and Even AI activation do not re-ask it.

### Optional phone setup and private entry (rule 3)

On a matching bundle advertising private phone setup, lead with Home's
Optional setup card, whose three buttons are **Set up voice**,
**Set up Even AI** and **Set up Jev**; later re-entry is **Settings > Voice**,
**Settings > Even AI** and Help > Optional setup > **Jev**. The card
has no other buttons, and Settings has no separate optional-setup row.
The dedicated page's masked field
and explicit replacement confirmation own private entry. A Soniox
**Save & continue** does not restart Hermes; **Review restart** and its
**Restart Hermes?** confirmation (or Even AI's **Save & restart Hermes**) handle
the supported host lifecycle. Unsupported activation stays pending. Refresh
loaded state after reconnecting; never replay an uncertain apply operation.
Candidate source is not a public bundle availability claim.
Advanced Desktop entry uses the private Desktop dialog via
`request_credentials`, with exactly one integration name as the tool
argument. Ask about Soniox and Even AI separately and open each popup at its
own checkpoint. Terminal users use the advertised `hermes ocuclaw optional-setup
save soniox` or `save even-ai` hidden prompt. Secrets never pass through
chat: do not have the user paste, echo, inspect or read back any secret.
Private entry is interactive and always marked USER ACTION REQUIRED;
the assistant must never supply or read its secret input. If this bundle
lacks the command, explain the limit and use its supported private setup
entry or leave the capability pending. Follow fresh-install's grouped
activation barrier after the chosen saves; never add a generic restart.

### Command shapes (rule 2)

For TS-NOT-INSTALLED, each OS branch prints one complete private staged
download/install block; run that whole block as one Terminal command so its
quoted temporary-path variable remains in scope. Its `&&` chain or
PowerShell Stop policy gates execution on a successful download. Keep that
staged-file shape exactly as printed. For the Step 7 route only, after the
unchanged doctor-provided command gets
a permission refusal, explain and checkpoint one retry with the host's
standard privilege-elevation prefix and no other change. In Hermes Desktop,
pass that exact doctor-provided command to `terminal` first, then use Hermes
Desktop's native approval or elevation prompt for the retry; never ask for or
carry the password in chat. Only after `terminal` reports that native elevation is unavailable,
cancelled, or refused may you hand the original command to the user for a
separate administrator terminal.

### Checkpoints (rule 4)

**Checkpoint a mutating phase, never a read-only check.** The advertised
native optional-setup form owns consent through its explicit replacement,
save and activation controls; it needs no shell-command checkpoint. Private
route review remains print-only and requires separate approval before Serve
changes. For advanced Desktop/CLI host actions, before a change,
say what it does and why, show every command with a one-line explanation,
and ask for OK. In ordinary assistant prose, use a fenced block. In a
`clarify.question`, use an indented plain-text command line with no Markdown
delimiters. The direct-panel `pair_phone` exception has no
shell command: Step 8's fresh online-phone check authorizes opening
its local modal, and the modal itself owns the explicit Yes/No gate. The pause message opens with the
previous phase's result. If a pause message has no exact command line,
discard and rewrite it. Resolve `Skip if` checks before proposing a mutation.

### Internal completion checklist

Track this internally. Never render the checklist, checkbox notation, or lane
card to the user. The final response summarizes only the outcome and the three
user-relevant connection proofs.

- [ ] User level recorded
- [ ] Even G2 / Even Hub readiness confirmed
- [ ] Hermes version is 0.21.4 or newer (tested `>=0.21.4,<0.24.0`)
- [ ] Installation source recorded accurately
- [ ] Secure relay access ready
- [ ] OcuClaw conversational tool progress is off (`config get` reports `false`)
- [ ] Live reasoning default applied on fresh setup, or saved choice/decline/inert host recorded; updates require a yes
- [ ] Plugin installed, enabled, and gateway restart verified
- [ ] Relay listening on loopback port 47801 (or recorded override)
- [ ] Tailscale connected on host and phone
- [ ] Tailscale Serve `:8446` relay route verified
- [ ] Direct pairing presenter is live in Hermes TUI or Desktop (require `display.interface=tui` only for terminal installs; Desktop does not require changing or mentioning the terminal default)
- [ ] Phone-origin reply confirmed on the Even G2
- [ ] First-Run Proof committed by welcome dismissal, or split-truth warning recorded
- [ ] Profile/multiplex posture explained when applicable
- [ ] Optional integrations resolved
- [ ] Ordered wrap delivered, including the single support-path explanation

Use the GitHub distribution bundle in the supported production lane. An explicitly
identified local test candidate is valid only for a test lane and must be
recorded as such; never describe it as a published GitHub installation.

### Lane card

Maintain this compact card internally. Never include secret values.

```text
User level: guided | terminal-comfortable
G2 glasses: unknown | has-glasses | not-yet (website opened | declined | handoff)
Host OS: linux | macOS | Windows | unknown
Hermes version: <version | unknown>
Hermes CLI on agent PATH: yes | no | unknown
Plugin state: absent | disabled | enabled | failed | unknown
Relay wsPort: 47801 | <override> | unknown
Relay bind: 127.0.0.1 | unsafe | unknown
Tailscale host: online | offline | absent | unknown
Tailscale phone: online | offline | unknown
Serve :8446: ready | absent | wrong | unknown
Phone: connected | rejected | unreachable | unknown
First-Run Proof: pending | armed | retry | committed | warning
Multiplex: off | on-single | on-multiple | unknown
Current step: <number or case>
Setup conversation: <confirmed session ID>
Activation: saved-pending | verified | restart recovery required
Restarts: basic <count> | optional <count>
Soniox choice: unresolved | skipped | saved-pending | verified | failed
Even AI choice: unresolved | skipped | saved-pending | verified | failed
```

After calibration, choose the one probe matching the host OS. Announce what it
checks; do not ask for OK. On Linux and macOS, run this single
always-exit-zero probe:

```bash
printf 'OS='; uname -s 2>/dev/null || ver 2>/dev/null || true; printf 'HERMES='; hermes --version 2>/dev/null | head -1 || true; printf 'PLUGIN='; hermes plugins list 2>/dev/null | sed -n '/ocuclaw/Ip' || true; printf 'TAILSCALE='; tailscale status 2>/dev/null | sed -n '1p' || true
```

On native Windows PowerShell, run this always-exit-zero equivalent instead:

```powershell
$ErrorActionPreference = 'SilentlyContinue'; Write-Output "OS=$([System.Environment]::OSVersion.VersionString)"; Write-Output "HERMES=$((hermes --version | Select-Object -First 1))"; Write-Output "PLUGIN=$((hermes plugins list | Select-String -Pattern 'ocuclaw'))"; Write-Output "TAILSCALE=$((tailscale status | Select-Object -First 1))"; exit 0
```

Interpret missing output; do not present it as failure. Never add a secret
probe to this command.

**Trust ladder — the receipt outranks the shell.** The `ocuclaw_setup`
receipt is the authority for whether Hermes is installed, which version is
running, and whether the runtime is available; a shell probe is evidence
about *this shell's PATH*, nothing more. The tool that returned
`status.hermesVersion` runs inside that very Hermes process, so a version
inside `supportedRange` proves Hermes is installed and running even when
`hermes` prints `command not found` — including when a runtime hint claims
"`hermes` is not installed". When probe and receipt disagree, record
`Hermes CLI on agent PATH: no` in the lane card, say plainly "Hermes
<version> is running; my shell just cannot see the `hermes` launcher," and
hand each command to the user to run in their own terminal. Reinstalling or
repairing Hermes is a valid recommendation only when `hermesVersion` is
`"unknown"` *and* the probe fails.

`status.hermesCliOnPath` describes the PATH of the process serving the setup
tool. The lane card's `Hermes CLI on agent PATH` row comes from the shell probe.
They may legitimately differ; neither overrides `status.hermesVersion`.

Then inspect the non-secret profile posture:

```bash
hermes config get gateway.multiplex_profiles
hermes profile list
```

During fresh setup, call `{"operation":"agent_mode"}` before
the restart. Multiple agents is recommended; single agent remains a choice
wherever status reports `singleAgentAvailable: true`. When it is false (Hermes
0.21.4 and later, whatever the profile count), skip the question and say
nothing about it, then apply multiple agents.
Require `status.mandatoryConfiguration.agentModeChosen: true`; verify the
served list after restart. The same operation applies to an EXISTING install
whose status reports `agentModeChosen: false` (#2515): the phone's grey "+"
sends the wearer here with "Multiple agents is off on your Hermes host. Run
/ocuclaw-setup", and `hermes ocuclaw status` shows `multiple agents  off ·
agent mode not chosen yet`. Ask the question, apply the branch (allowlist
BEFORE the switch, `--force` on `hermes config set`, expect and explain the
"not a recognized config key" notice if it was run without), then one restart. Enter `PROFILE-AUTHZ-DROP` only for an actual
secondary-profile rejection, not merely because multiple profiles exist.

## Ownership move lane

This lane came from the setup skill's **Profile ownership gate**. The gate
runs first and is read-only; when its `ownershipMove.needed` is true, this
lane moves OcuClaw to the default profile.

**This lane runs after the Opening move and calibration, not before.** The gate
in the setup skill is read-only, so a needed move is recorded in the lane card and the
conversation still opens normally; the user is greeted and calibrated first,
and only then asked about moving anything. The one thing that cannot wait is
the refusal — a secondary-profile invocation stops the conversation
immediately, because nothing useful can follow it.

Plan first — this command writes nothing without `--apply`:

```bash
hermes ocuclaw move-to-default --from <profile>
```

Show the user what it lists, in plain words, and ask once through `clarify`.
Say that their glasses stay paired and nothing is reset. On yes:

```bash
hermes ocuclaw move-to-default --from <profile> --apply
hermes plugins enable ocuclaw
hermes gateway restart
```

Run the receipt's `next` commands in the order it prints them. The move
switches OcuClaw on in the default profile's config; `hermes plugins enable`
is the idempotent follow-up that lets the plugin manager do the registration a
config line does not cover.

The credential is carried across unchanged. **Never regenerate it** and never
offer `hermes ocuclaw reset-relay-credential` as a way to finish this move —
that disconnects every paired phone.

The plan refuses rather than guessing when a gateway is still running (stop it
first) or when both profiles hold a *different* relay credential. A credential
conflict is two pairings: ask the user which one to keep. Do not pick.

Expect that conflict right after you install the bundle in the default
profile. Installing it there loads the adapter, and the adapter mints a fresh
relay credential for that profile on its first load — so by the time you run
the move, both profiles hold one and `move_refused_credential_conflict` is the
normal result, not a sign of damage. Read `credentialConflict` in the plan:
`defaultCreatedAt`, `sourceCreatedAt` and `defaultMintedAfterSource`. When
`defaultMintedAfterSource` is true, the default profile's credential is the one
that was just minted and has nothing on it. Nothing records which phones hold
which credential, so this is evidence for the question, never the answer. Ask
once through `clarify`, in these words: the phones already paired to your
glasses agent, or nothing is paired to the new one yet — which pairing should
stay? On "keep the glasses one":

```bash
hermes ocuclaw move-to-default --from <profile> --keep-source-credential --apply
```

That drops the default profile's own credential and carries the other across
unchanged; nothing is regenerated. On "keep the new one", leave both
credentials where they are — do not move transport — and say the phones paired
to the other agent will have to be paired again.
