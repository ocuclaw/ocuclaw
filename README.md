> [!IMPORTANT]
> This repository is a generated artifact. Its source of truth lives in the
> private OcuClaw monorepo — nothing here is edited by hand, so pull requests
> and issues opened against this repository are not monitored and will be lost
> on the next publish. Report problems through OcuClaw's built-in **Report a
> bug** feature, which attaches the diagnostics needed to act on them.
>
> Every commit here is produced by `publish-bundle.sh`. History is append-only:
> a rollback is a new commit with a bumped version that restores the prior
> known-good payload — never a force-push and never a revert of history. Hermes
> updates this plugin with `git pull --ff-only`, so rewritten history would
> break every installed copy.

---

# OcuClaw on Hermes

> Running OpenClaw instead of Hermes? You want https://github.com/ocuclaw/ocuclaw-openclaw-plugin — this repository is Hermes-only.

OcuClaw connects an Even G2 and the Even Hub app to a Hermes gateway. This
Hermes platform plugin runs the OcuClaw relay, carries conversations between
Hermes and the glasses, and provides LiveUI surfaces.

This installable repository is generated from the OcuClaw monorepo. Published
copies include the generated-artifact provenance notice and are updated only by
the bundle publisher; do not hand-edit an installed checkout.

The human-facing baseline is Hermes release `v2026.9.14`. Its package version
`0.21.3` and certified commit
`345cd2b057a452236de401d3534b8502a7465e8d` are separate identities. The
current bundle, shared plugin, and client train is 2.0.9; the bundled setup
guide has its own `1.3.22-hermes` version. The bidirectional client/plugin
compatibility floors are `2.0.2`. This beta bundle ships from the GitHub
repository only; it has no npm or ClawHub publication leg.

## Requirements

- Hermes `>=0.21.1,<0.22.0` (Hermes 0.21.1 and later 0.21.x; certified baseline `0.21.3`).
- Tailscale on the Hermes host and the phone for the authenticated external
  relay route.
- The OcuClaw app installed through Even Hub on the phone and Even G2.

## Stock Hermes and Codex OAuth

This beta ships no native patch packages and never rewrites Hermes. Job and
execution history and installed tool/skill inventory use stock Hermes APIs.
Scheduler actions and transactional management edits remain unavailable where
the native contract is absent. A completed execution does not prove delivery.

Hermes owns provider sign-in, credential storage and token refresh. OcuClaw
talks to the gateway and uses its profile multiplexing for agent creation,
selection and conversations. No OcuClaw-specific Codex login or launcher is
required, and OcuClaw does not copy or repair OAuth credentials.

**Known beta limitation:** the certified Hermes release has a Codex OAuth
refresh ownership issue when profiles share a login. Normal expiry should
refresh automatically, but this issue can leave one or more agents unable to
authenticate. Repair the login on the Hermes host; an OcuClaw reconnect alone
does not repair credentials. Shared-login refresh reliability remains an
upstream limitation, not a guarantee of this beta. Other providers retain
their existing behavior.

### Recovering a shared Codex login

Use the native Hermes authentication controls on the gateway machine. For
the main login, run `hermes auth`; for a profile with its own credentials,
run `hermes --profile <name> auth`. Reconnect Codex there, restart the gateway
through its normal service controls, then retry the original conversation
in each affected agent.

If a profile retains stale credentials, use Hermes's auth controls to remove
that profile's stale Codex login before reconnecting the shared login. Native
`auth logout openai-codex` also resets the selected provider: use `hermes model`
in the affected profile to select Codex again. This is an operator recovery
step; OcuClaw never logs users out or changes credentials automatically.
Keep the agents and their conversations; do not copy `auth.json` between
profiles as a repair.

## Install and update

<!-- ocuclaw:install-block:start -->
OcuClaw needs Hermes `>=0.21.1,<0.22.0`; the certified baseline is Hermes
`0.21.3`. Install it once, in the default Hermes profile: that profile owns the
relay the glasses pair to, and a second copy in another profile is never the
answer.

**Repository access.** `ocuclaw/ocuclaw` is a public repository and needs no
invitation or GitHub sign-in to clone. Git must still be installed and working
on the installing machine (Desktop uses Git too). Verify with
`git ls-remote https://github.com/ocuclaw/ocuclaw.git HEAD` before installing;
never paste an access token into setup chat. Even Hub beta access is a separate
invitation, and the software itself is still beta.

**Terminal first.** This is the supported path and the one every beta build is
tested on:

**Cloudways managed Hermes: install, restart once, then one command.**

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes gateway restart
hermes ocuclaw cloudways setup
```

`hermes ocuclaw cloudways setup` takes the host from an installed plugin to a
paired phone and an evidenced first reply, in numbered steps `[1/8]` to `[8/8]`
in your own terminal. It reads live state before every step and skips what is
already done. It asks twice, showing exactly what changes and defaulting to no.
There is no retry flag: run the same command again and it continues where it
stopped.

**One restart, one run.** The restart above is the only one this install needs.
If anything interrupts the run, including a restart that closes SSH, Hermes and
tmux, reconnect with the Cloudways SSH command and run the same command again:
it skips what is done and carries on from there.

**The command looks for your phone before it pairs it.** Step 5 asks you to
install Tailscale on the phone and approve the link there. Step 7 then checks
whether a phone is on your private network. If one is, it says so and carries
on. If none is, it explains what Tailscale is, gives you three short steps, and
waits, checking again every few seconds; it carries on by itself the moment
your phone turns up, and pressing Enter carries on anyway. The wait stops after
ten minutes, having changed nothing, and running the same command again picks
up right there. Leave Tailscale switched on afterwards: the phone needs it to
reach this server.

**The pairing code waits for you.** It lasts two minutes, so step 7 asks you to
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

For other hosts, the direct install/restart sequence is:

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
installed but not loaded by that managed gateway, and nothing about the glasses
works through it yet. A fresh TUI can prepare setup before that activation.

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

**Cloudways Managed AI Agents.** The same install block applies. That host has
no root and no system Tailscale, so OcuClaw carries its own path for it, and
`hermes ocuclaw cloudways setup` runs the whole of it: a user-owned userspace
Tailscale under `~/bin` and `~/.tailscale`, a Hermes cron watchdog that starts
it again after every `hermes gateway restart` (a container restart there), the
private tailnet route, the pairing ceremony and the first message. Cloudways has
approved those pieces. Your only manual steps are opening the Tailscale
authorization link it prints and the phone.

The same work is still available one verb at a time (`hermes ocuclaw cloudways
detect`, `install`, `enroll`, `status`, `retry`, `enable`, `disable`,
`rollback`), and `/ocuclaw-setup` still guides the whole path when you would
rather be walked through it.
<!-- ocuclaw:install-block:end -->

**Cloudways SSH: optional local status.** After saving and testing the Cloudways
connection in Desktop, choose **Show OcuClaw in Hermes Desktop** if you want its
glasses icon, battery and activity on your computer. Chat works without this step,
and existing phone/glasses pairing remains on Cloudways. Run the local installer
from the matching bundle's `desktop-companion` directory on the computer hosting
Desktop, not in the SSH session. It requires Python 3.9+ but no local Hermes CLI,
gateway or second Runtime Bundle. Read that directory's README for install,
update and removal commands. Never copy Cloudways' generated desktop plugin:
that file carries the remote backend's presenter authority.

Remote mode uses Desktop's saved connection and shows its selected connection
and profile. It is read-only: pairing, Soniox/Even AI forms, gateway controls and
fleet publication remain local-only. A stopped, unconfirmed or unreachable
gateway is shown as unavailable; successful chat does not override health facts.
The shipped desktop status contracts must match; unsupported contracts produce
a compatibility message. Native Mac/Windows and Cloudways SSH acceptance remain
separate from container tests. Final website copy and download publication retain
their review checkpoint; this source change does not publish them.

Initial plugin bootstrap generates the Relay Credential once on a provably
fresh profile and atomically stores it through Hermes without displaying or
returning it. Reinstall, update, restart, and re-pair preserve the credential
and its secret-free generation marker. Optional Soniox and Even AI credentials
use a private Desktop form, or Hermes masked input for terminal users. The form
writes directly to the active profile's `.env`, returning only presence status
to the setup assistant. It keeps values out of chat, not out of reach of an
agent that has filesystem access.

After the restart, bare `hermes` opens the supported TUI; local Hermes Desktop
loads the OcuClaw runtime presenter from the same Hermes home. `hermes --cli` can run
guided checks but hands the resumable pairing checkpoint to either direct-human
surface. In `/ocuclaw-setup` the plugin registers the setup bundle, skill,
and setup tool natively. Its TUI/Desktop panel owns secure QR or Manual Pairing
Initiation, the phone-origin/G2 check, and the Hermes Welcome Round Trip. See
[`after-install.md`](after-install.md) for the short launch card.

If a paired phone is lost or suspected compromised, `/ocuclaw-setup` guides the
interactive host-terminal all-device reset. It disconnects every phone and
proves the replacement is accepted; when a prior credential is readable it
also proves rejection, otherwise the receipt records that proof as
`not_applicable`. It then requires the secure QR or Manual pairing exchange.
Per-device revocation is future work.

## What ships

- Token-authenticated glasses and phone relay on loopback port 47801 by default.
- Hermes conversations, session history, search, titles, model controls, usage,
  skills, native approval mirroring, and copy-to-glasses support where the
  Hermes public API permits them. Approval countdowns inherit the host's
  effective `approvals.timeout`; timeout is an implicit deny.
- Eight registered tools, listed in `plugin.yaml` `provides_tools`: the four
  LiveUI tools (`render_glasses_ui`, `get_glasses_ui_state`,
  `manage_liveui_templates`, `manage_liveui_tasks`, shipping enabled), the three
  phone tools carried over the control link (`get_current_location`,
  `get_evenrealities_device_info`, `set_session_title`), and `ocuclaw_setup`.
  `/ocuclaw-setup` and `hermes ocuclaw status|doctor` both report which of the
  eight actually registered and name any that did not.
- A read-only **Profiles** section on `hermes ocuclaw status|doctor` and in the
  `ocuclaw_setup` status block (#2944). It reports the effective gateway mode
  (from the live gateway record), the configured mode
  (`gateway.multiplex_profiles` plus the `GATEWAY_MULTIPLEX_PROFILES`
  override), OcuClaw's saved `agent_mode`, the transport owner, the live
  per-profile gateway/service topology, the served and enrolled sets, and the
  0.21.3 migration receipt when one is present. It names six faults with an
  exact repair each — including OcuClaw installed outside the default profile,
  and a secondary standalone gateway that the next `hermes update` would fold.
  It reports credential PRESENCE only, never a value, and changes nothing.
  One wearer is one pairing, one relay credential, and the default profile
  owns transport.
- Two bundled skills, both registered through Hermes's plugin-skill registry and
  neither copied into `~/.hermes/skills/`. `ocuclaw:ocuclaw-assist-hermes` is the
  Setup Assistant that `/ocuclaw-setup` loads. `ocuclaw:glasses-ui` is the
  authoring skill for the LiveUI tools: when a turn belongs on the wearer's
  display instead of in chat, which wire kind to send, and how to write the
  spec. Load either by its qualified name, for example
  `skill_view("ocuclaw:glasses-ui")`. A bare `glasses-ui` does not resolve,
  because a plugin skill is not in the flat skills tree, and neither skill
  appears in the prompt's `<available_skills>` list. The glasses-ui copy at
  `skills/glasses-ui/` mirrors `extensions/ocuclaw/skills/glasses-ui/` in the
  monorepo and is kept byte-identical by
  `node tools/sync-glasses-ui-skill.js`.
- Optional Soniox speech-to-text and Even AI routing.

These are shipping capabilities, not simulator or real-hardware validation
claims for any particular release candidate.

### The Cloudways setup ladder

`hermes ocuclaw cloudways setup` walks one Cloudways Managed AI Agents host
through setup in numbered steps `[1/8]` to `[8/8]`, in one terminal. Every step
reads live state first and skips what is already done, so re-running after a
timeout or a dropped SSH session continues where it stopped. Steps 1 (this
host), 4 (Tailscale binaries and daemon) and 5 (tailnet enrollment) are
automated; the other five print the manual command that still covers them.

It refuses, changing nothing, on any host whose detection is not the decisive
Cloudways verdict — "likely" is a refusal — on a package-manager-managed Hermes
install, and without an interactive terminal unless `--yes` is passed. Each
refusal names `hermes ocuclaw pair` and the OcuClaw Setup Assistant.
`--hostname` is the tailnet node name, exactly as on the OpenClaw side; it is
never a detection override. `--wait` and `--first-use-wait` refuse a value of
zero or less rather than quietly substituting the default.

`--no-pair` ends the ladder before the first message, since that step needs a
paired phone; `--no-first-use` ends it at the first message. Both exit 0 and
print the line that says how to pick up where you left off. `--yes` answers the
consent questions and nothing else: pairing approval, the reply confirmation and
anything else the wearer owns go through a separate prompt that ignores `--yes`
and refuses without a real terminal.

`OCUCLAW_HERMES_ASSUME_CLOUDWAYS_HOST=1` is a **test-lane marker** that makes
step one treat host detection as the decisive Cloudways verdict, so a pet or CI
lane can exercise the ladder without weakening the guard. **Never set it on a
user's machine.** It is deliberately an environment marker and not a flag, and
the step says out loud that the override is in force whenever it changes the
answer.

After a run that got past step one, a secret-free diagnostic journal of that run
is written to `<HERMES_HOME>/state/ocuclaw.cloudways-setup.json`. It is for
support only: it records a closed vocabulary of step outcomes, never a link, an
address or a credential, and nothing ever reads it back as truth. Deleting it
changes nothing.

### Read-only session ownership data

The Hermes companion writer emits `ocuclaw/companion-snapshot@2`
(`schemaVersion: 2`), retaining the v1 fields and adding exactly one
`ownership` field. The 32 KiB cap, atomic overwrite, `authority: read_only`
and nested LiveUI schema v7 are unchanged. Generic writers without ownership
still emit v1; readers accept both. Missing or legacy ownership is unavailable.

An ownership value is either `null` or the version 1
`ocuclaw.session-driver-projection` contract. It enumerates the existing phone
driver fields (`state`, `locked`, `armed`, `takeOver`, `uncertain`,
`takeOverAllowed`, `holdGeneration`, `holdState`, `holdSurface`, `inflight`,
`inflightPlatform`, `sessionKey`) with the native `sessionId`, canonical
receiver-home SHA-256 `receiverFingerprint`, `observationGeneration`, and
`observedAtMs`. PIDs, paths, credentials and transcripts are excluded. This is
the existing adopted-session watcher's projection, not another ownership
controller or permission to send.

The observation generation combines a watcher epoch, arm generation and its
accepted-read sequence. The epoch and observation timestamp do not change
when the companion heartbeat samples an unchanged controller. Receipt age
provides transport freshness: the existing 15-second heartbeat samples the
live getter, and a receipt older than 30 seconds is stale. A healthy idle
controller therefore remains current without extra native polling. A failed
read preserves uncertainty and the previous observation timestamp; disarm,
missing watch handles or a different connected-app session returns `null`.

The authenticated `/glasses/state` response retains its version 1 contract and
adds `ownership` (`ocuclaw.ownership`, version 1, `readOnly: true`). Its status
is `present`, `uncertain`, `stale` or `unavailable`; `projection` contains the
validated observation or `null`. Native observation age and receipt sampling
time are separate. ETags change when ownership changes or its receipt expires.
The receiver verifies exact public key, namespace/profile, canonical home
fingerprint and resolved native session ID. Ownership accepts only the
receiver's canonical `ocuclaw/companion-snapshot.json`; configured shared paths
and redirected companion paths remain unavailable for ownership, while their
existing LiveUI view remains compatible. No fallback profile or alternate
store is searched.

For existing shared conversations, the Desktop Pulse Card shows the bounded native title
(`sessionTitle`, resolved with `storedSessionId` in the same read), native
profile and machine label. The four approved labels follow the phone's lock
projection: an idle holder with a current takeover is **Glasses driving**;
renewed Desktop work takes precedence. Missing or expired ownership is
**Checking session…**, never an unlocked default. The existing 30-second
receipt deadline also expires the displayed label without a push event.
Connection/profile changes clear identity immediately and fence late results.
A transient read failure retains only the last shared identity, not LiveUI
content. Independent copies omit this ownership block because they have no
shared driver watch.

### Independent glasses chat copies

The shipping interim offers **Copy as new glasses chat** in the phone Sessions
sheet. The new chat starts with the source transcript; future replies stay
separate. Each copy receives a fresh native ID and glasses key. Provenance is
stored as `_branched_from` metadata without a native parent link, so Desktop
resume cannot follow the original into the copy. The source remains unchanged.

Continue here, Take over and the Pulse Card's Open chat action are unavailable.
The app ignores older adoption advertisements, and the installed runtime refuses
stale adoption/takeover requests. The session pill is passive. Existing shared
chats retain ownership observation and mirroring; older copies are not migrated.

Shared editing remains unavailable until native context refresh and cooperative
ownership release are supported. Stock Desktop may retain cached model context
after external writes even when its displayed transcript has refreshed. The
copy flow uses the existing guarded native writer compatibility adapter and
refuses engines lacking its required transaction primitives; no engine patch is
included. Retained navigation helpers are not exposed by the shipping card.

## Reasoning on the status line

While the agent thinks, the glasses status line shows a one-line headline
derived from the model's own reasoning — the first bold section header it
writes, or a provider-authored one-line summary. When the reasoning is plain
prose with no headline in it, the line reads "Thinking..." rather than a
truncated slab of the reasoning text; that is deliberate, not a missing
feature. The full reasoning text still rides its own frame.

On supported Hermes 0.21.x the reasoning can also stream to the glasses live,
word by word, instead of arriving in chunks at the end of each model call. That
is off until the Hermes config turns it on — `/ocuclaw-setup` offers the step
after an install or update, and it is also one command (see
[Live reasoning](#live-reasoning) below).

The key is Hermes' own, gateway-wide: it enables the reasoning-delta hooks for
every plugin on that gateway, and OcuClaw only registers for them when it is
already true. Leave it off and everything still works — reasoning simply
arrives chunked.

## Progress notes

Some models write short sentences to you while they work, before their answer
("Checking the logs first."). On supported Hermes 0.21.x those sentences get
their own line in the status bar and are tagged so the app can keep them out of
the conversation history.

To silence them at the source, in the Hermes config:

```yaml
display:
  platforms:
    ocuclaw:
      interim_assistant_messages: off
```

## Live reasoning

By default the agent's reasoning arrives in one piece when each model call
finishes. On supported Hermes 0.21.x you can have it arrive as it is written
instead, by opting in on the Hermes side:

```bash
hermes config set plugins.stream_reasoning_deltas true
hermes gateway restart
```

which is the same as writing it in the config by hand:

```yaml
plugins:
  stream_reasoning_deltas: true
```

This is a step of the after-install flow, not a paragraph to find later:
`/ocuclaw-setup` reports the key in its status receipt
(`hermesHooks.streamReasoningDeltasOffer`) and, on a host whose hooks are
actually there, offers to set it for you. It asks first and writes only on
your yes — the key stays an opt-in, it is just a guided one now.

Restart the gateway afterwards; Hermes reads the key when it builds its plugin
hook set, so nothing changes until it does. This is deliberately a Hermes
config key and not a glasses setting: turning it on changes how Hermes calls
the model for every surface on that gateway, not just OcuClaw. With it off,
reasoning still arrives in whole pieces rather than as it is written.

Optional hooks are feature-detected at startup and only registered when the
running supported host actually has them, so OcuClaw never advertises a feature
it cannot produce.
`/ocuclaw-setup status` reports what this host offers (`hermesHooks`), so a
capability that reads inactive on the glasses can be explained from the
receipt instead of guessed at.

## Update policy

The commands are in [Install and update](#install-and-update) above; this is
what they are permitted to do. The one sanctioned transition is an in-place
update to a strictly higher published version. There is no remove/reinstall
route, no downgrade, and no state rollback.

Hermes retains the profile configuration, sessions, and secret environment file
across the update. A failed update is repaired forward at a corrected, strictly
higher version through the same sequence — never by removing the plugin and
installing it again.

## Full uninstall

First run `hermes plugins enable ocuclaw --no-allow-tool-override` so the
plugin-owned command is registered even when the retained install was disabled.
Run `hermes ocuclaw doctor` and apply its narrow route teardown only when it
prints one. Then stop the gateway, run `hermes ocuclaw uninstall`, and start
Hermes again. The command removes the exact OcuClaw-owned code, setup,
configuration, secrets, pairing state, and first-run state; preserves shared
Hermes sessions and unrecognised files; and prints the uninstall receipt.
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

The removal contract is exact. `hermes ocuclaw uninstall` removes the Agent
plugin checkout and its configuration, the OcuClaw secret keys OcuClaw wrote
into the profile `.env`, the generated Hermes Desktop runtime at
`$HERMES_HOME/desktop-plugins/ocuclaw/plugin.js` with its own render
temporaries and emptied folder, OcuClaw's private profile state under
`$HERMES_HOME/state/` including its lock sidecars, OcuClaw's runtime state
under `$HERMES_HOME/ocuclaw/`, the `/ocuclaw-setup` bundle, the `ocuclaw-pair`
TUI widget, and — only while ownership is still provable and no live route
remains — the host-scoped Managed Serve Route receipt and its lock sidecar.
Nothing else is touched: the shared Hermes session database, other plugins'
storage and `desktop-plugins/` folders, unrelated profile configuration, and
any file at an OcuClaw path whose ownership cannot be proved are all
preserved, and the receipt reports each preservation.

Generic Hermes plugin removal (`hermes plugins remove`) is **not** complete
removal. It
removes the Agent package only, while the generated Desktop runtime under
`$HERMES_HOME/desktop-plugins/ocuclaw/` belongs to no Hermes package and keeps
loading in Hermes Desktop. `hermes ocuclaw doctor` warns about this while
OcuClaw is still installed, and the final uninstall receipt's
`ownedDesktopRuntimeAbsent` check proves no OcuClaw-owned entry remains at
either Hermes Desktop loader door. If generic removal already left an orphan,
the `hermes ocuclaw` commands are gone with the package: the copy-pasteable,
Python-only recovery command is in
[after-install.md](after-install.md#recover-from-a-generic-removal-that-left-an-orphan).

## Profiles and multiplex

OcuClaw is a port-binding platform and belongs on the default Hermes profile.
It is installed once, there. That profile owns the relay the glasses pair to,
so a second OcuClaw install or a second relay credential in a secondary profile
is never the answer. When `gateway.multiplex_profiles` is enabled, keep the
plugin on the default profile. Setup offers multiple agents as the recommended
choice, with
single-agent mode available — on a fresh install and, since #2515, on an
existing install that never recorded the choice (`hermes ocuclaw status` shows
`multiple agents  off · agent mode not chosen yet`; the phone's grey "+" says
"Multiple agents is off on your Hermes host. Run /ocuclaw-setup"). The OcuClaw
enrollment set (#2940) holds the agents the wearer selected; phone-created
agents enroll before the required restart. A gateway-served list is not an
enrollment list. Hermes 0.21 uses the shared relay-authenticated adapter's
provenance for secondary turns and approvals. No `OCUCLAW_ALLOW_ALL_USERS`
bypass is required.

**Bound the served set BEFORE flipping the switch.** With
`gateway.multiplex_profiles` on and nothing bounding the served set, the
gateway serves EVERY profile on the host, and "served" also gates cron
ticking — each served profile's cron jobs run inside this gateway. A profile
that already runs its own gateway (a `watcher`, for instance) would then be
served twice: a relay-token clash plus double cron. Bound it first, then flip
the switch, and there is never a restart window where "all" is in force.

**The enrollment set is OcuClaw's own key**, on every supported engine:

```bash
hermes config set --force platforms.ocuclaw.extra.profile_allowlist '[]'
hermes config set --force gateway.multiplex_profiles true
```

`platforms.ocuclaw.extra.profile_allowlist` lists the secondary agents the
glasses may reach. The default agent carries the pairing, is always enrolled,
and is never listed. An empty list is a real answer — "just the default agent"
— and the wearer adds agents from the phone's Agents list.

An **absent** key is a different answer: OcuClaw reads it as "the wearer has
not chosen yet" and asks them to reselect on the phone. Absence never means
"every agent", in any state, on any engine. A malformed value fails the same
closed way.

`--force` only skips the CLI's `⚠ 'gateway.multiplex_profiles' is not a
recognized config key — it was saved anyway` notice (with a misleading
`Did you mean: gateway.multiplex_profile_allowlist`) that the second line
prints without it; the gateway reads the key as written.

**Version note, Hermes 0.21.0 to 0.21.2.** Those engines bound the *served* set
by `gateway.multiplex_profile_allowlist`, so OcuClaw mirrors the enrollment set
onto that key on every create, add and remove — without the mirror a newly
enrolled agent would never be served there. Add the mirror line to the setup
above on such a host:

```bash
hermes config set --force gateway.multiplex_profile_allowlist '[]'
```

**Version note, Hermes 0.21.3.** Config migration 42 to 43 deletes that key and
the multiplexer serves every live profile on the host, so no mirror is written
and enforcement is entirely OcuClaw's. The enrollment set still decides which
agents reach the glasses. It does not decide which profiles the multiplexer
runs, so cron and other channels on unenrolled profiles tick there too.

Which case a host is in is decided by **probing the running engine** (does
`profiles_to_serve` still take `profile_allowlist`?), never by a version
string.

Hermes facts these rules rest on (verified on Hermes 0.21.0 / v2026.8.31):

- **Precedence:** the `GATEWAY_MULTIPLEX_PROFILES` environment variable
  (`1/true/yes/on`, `0/false/no/off`) beats `gateway.multiplex_profiles` in
  config.yaml, which beats the default of **off**. A blank or unrecognized env
  value falls through to config instead of forcing the switch off.
- **A malformed bound fails safe (0.21.0 to 0.21.2):** a value that is not a
  list serves the default profile only (with a warning); invalid entries are
  skipped; `default` is always served. An ABSENT value is the "serve
  everything" shape — that is the one to avoid. Hermes 0.21.3 has no such key
  and always serves everything.
- **A secondary profile that enables a port-binding platform is not served.**
  The default profile owns the single shared listener; a secondary profile
  whose config enables OcuClaw (or any port-binding platform) is skipped at
  gateway start with a warning naming it, while the rest of the gateway comes
  up. OcuClaw stays on the default profile. (The fatal startup case is a
  secondary profile with an `open` dm/group policy and no allow-all flag.)

New agents inherit inference access and approval rules, with their own chats
and memory. OAuth state keeps its original owner. Personality changes apply
to new chats. Per-agent starting folders are read-only on the supported 0.21
baseline pending upstream terminal-scope adoption and verification.

## Help and escalation

Start with `/ocuclaw-setup`. If setup remains blocked,
use passive `hermes ocuclaw status`, then bounded-active
`hermes ocuclaw doctor`. The read-only OcuClaw dashboard tab at `/ocuclaw` is
optional detail, never a fallback dependency. Open the built-in **Report a
bug** feature in the OcuClaw app when support evidence is needed. For tester discussion and
follow-up, use the OcuClaw Discord community linked from
[ocuclaw.com](https://ocuclaw.com).
