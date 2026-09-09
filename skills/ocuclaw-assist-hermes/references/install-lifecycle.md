# OcuClaw installation and lifecycle reference

This reference is for OcuClaw train `2.0.4` and Setup Assistant guide
`1.3.19-hermes`. Those identities are independent of the Hermes package version
(`0.21.0`) and certified source commit.

The Relay Credential is host-managed: initial plugin bootstrap generates it
once on a provably fresh profile, stores it through Hermes's atomic `.env`
contract, and never reveals, returns, exports, imports, or asks for it. Optional
Soniox and Even AI credentials use a private Desktop form, or Hermes' masked
prompts for terminal users. Values bypass the setup chat and are stored in the
active profile's `.env`; this is not an OS keychain or a sandbox against an
agent with filesystem access.

## Install and update

<!-- ocuclaw:install-block:start -->
OcuClaw needs Hermes `>=0.21.0,<0.22.0`; the certified baseline is Hermes
`0.21.0`.

**Private beta access.** `ocuclaw/ocuclaw` requires an invited GitHub account
and Git HTTPS authentication on the installing machine (Desktop uses Git too).
Verify access with `git ls-remote https://github.com/ocuclaw/ocuclaw.git HEAD`
before installing. “Repository not found” or “could not read Username” means
confirm your invitation with the beta contact and configure Git authentication
locally; never paste an access token into setup chat. Repository visibility is
not changed by this release. Even Hub beta access is a separate invitation.

**Terminal first.** This is the supported path and the one every beta build is
tested on:

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes config set display.interface tui   # the pairing panel lives in the TUI
hermes gateway restart
```

Then, in bare `hermes` or in Hermes Desktop:

```text
/ocuclaw-setup
```

`hermes plugins install` prints that restart instruction and stops there — it
never restarts the gateway for you. Until the gateway restarts, OcuClaw is
installed but not loaded, and nothing about the glasses works yet.

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
order is: install, then restart the gateway, and the OcuClaw UI appears in the
Hermes Desktop title bar on the next Desktop launch or reload.

1. Restart the gateway — use the native **Restart gateway** button when the
   OcuClaw card is visible, otherwise `hermes gateway restart` in a terminal. Until it
   restarts, OcuClaw is installed but not loaded, and there is no OcuClaw
   Desktop UI yet.
2. The OcuClaw setup card then appears in the title bar reading
   **Pair your glasses**. Run `/ocuclaw-setup` and finish pairing. The card
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
<!-- ocuclaw:install-block:end -->

The TUI setting keeps the supported terminal pairing panel available. Local
Hermes Desktop has the same direct-human pairing ceremony through its OcuClaw
runtime presenter in that Hermes home. The classic `hermes --cli` interface remains useful for general chat
and recovery, but hands pairing to TUI or Desktop.

The setup assistant checks the non-secret state and guides installation,
recovery, secure phone pairing, and the Hermes Welcome Round Trip. The plugin
owns both the bundle and its skill, so an install needs no skill symlink or
copied skill folder.

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
Desktop window. It advances automatically from the canonical QR to
the four-word comparison and defaults the local decision to **No**. Approve
only when all four words match. **Manual** uses the private address plus a
short-lived pairing code shown in the same panel. Neither initiation asks for
a reusable credential in the phone app. If setup reaches pairing in
`hermes --cli`, it immediately gives a one-time TUI/Desktop handoff; reopening
`/ocuclaw-setup` there resumes the saved checkpoint.

Pairing alone is not Hermes Core Setup Completion. The assistant first warns
about the welcome screen and double-tap, then the user sends a message from the
phone app and confirms its reply on the G2. That arms a resumable one-hour
First-Run Proof Attempt. The assistant pushes `hermes_welcome` for 60 seconds;
only a returned double-tap dismissal commits durable proof and triggers the
completion announcement.

One failed dismissal gets one retry. After a second failure, setup reports the
split truth—phone-to-G2 worked, G2-to-agent remains unconfirmed—keeps a warning,
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

`/ocuclaw-setup` offers this step and waits for your yes; it is also this pair
of commands:

```bash
hermes config set plugins.stream_reasoning_deltas true
hermes gateway restart
```

The agent's reasoning then reaches the glasses as it is written instead of in
whole pieces. The key is Hermes' own and gateway-wide — it changes how Hermes
calls the model for every surface on this gateway, not just OcuClaw.

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

The plugin-owned `/ocuclaw-setup` bundle cannot run while OcuClaw is disabled.
Re-enable that retained install with `hermes plugins enable ocuclaw`, run
`hermes gateway restart`, and then invoke `/ocuclaw-setup` again.

For a full uninstall, first re-enable a retained disabled install with
`hermes plugins enable ocuclaw --no-allow-tool-override`; the plugin-owned
command cannot register while disabled. Obtain and run any permitted Managed
Serve Route teardown as described below. Then stop the gateway so its live
child cannot recreate state during removal, run the plugin-owned uninstall,
and start Hermes again:

```bash
hermes gateway stop
hermes ocuclaw uninstall
hermes gateway start
hermes gateway status
```

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
  `config.yaml`;
- the OcuClaw secret keys OcuClaw itself wrote into the profile `.env`;
- the generated Hermes Desktop runtime at
  `$HERMES_HOME/desktop-plugins/ocuclaw/plugin.js`, its own render
  temporaries, and that folder once it is empty;
- OcuClaw's private profile state under `$HERMES_HOME/state/` — the Desktop
  presenter capability and pairing activation receipts, the TUI pairing
  capability, the pairing-completion, first-run and relay-credential
  receipts, and their lock sidecars;
- OcuClaw's runtime state under `$HERMES_HOME/ocuclaw/`;
- the `/ocuclaw-setup` bundle and the `ocuclaw-pair` TUI widget;
- the host-scoped Managed Serve Route receipt and its lock sidecar, but only
  while OcuClaw can still prove it owns them and no live route remains.

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
