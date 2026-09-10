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

The human-facing baseline is Hermes release `v2026.8.31`. Its package version
`0.21.0` and certified commit
`29112bef099274229cadff79cdff7bf7b99c4b77` are separate identities. The
current bundle, shared plugin, and client train is 2.0.5; the bundled setup
guide has its own `1.3.20-hermes` version. The bidirectional client/plugin
compatibility floors are `2.0.2`. This beta bundle ships from the GitHub
repository only; it has no npm or ClawHub publication leg.

## Requirements

- Hermes `>=0.21.0,<0.22.0` (the complete Hermes 0.21.x line).
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
OcuClaw needs Hermes `>=0.21.0,<0.22.0`; the certified baseline is Hermes
`0.21.0`.

**Repository access.** `ocuclaw/ocuclaw` is a public repository and needs no
invitation or GitHub sign-in to clone. Git must still be installed and working
on the installing machine (Desktop uses Git too). Verify with
`git ls-remote https://github.com/ocuclaw/ocuclaw.git HEAD` before installing;
never paste an access token into setup chat. Even Hub beta access is a separate
invitation, and the software itself is still beta.

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
- `render_glasses_ui` LiveUI integration, shipping enabled.
- Optional Soniox speech-to-text and Even AI routing.

These are shipping capabilities, not simulator or real-hardware validation
claims for any particular release candidate.

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
When `gateway.multiplex_profiles` is enabled, keep the plugin on the default
profile. Setup offers multiple agents as the recommended choice, with
single-agent mode available — on a fresh install and, since #2515, on an
existing install that never recorded the choice (`hermes ocuclaw status` shows
`multiple agents  off · agent mode not chosen yet`; the phone's grey "+" says
"Multiple agents is off on your Hermes host. Run /ocuclaw-setup"). The
served-profile allowlist contains selected agents; phone-created agents enroll
before the required restart. Hermes 0.21 uses the shared relay-authenticated
adapter's provenance for secondary turns and approvals. No
`OCUCLAW_ALLOW_ALL_USERS` bypass is required.

**Set the allowlist BEFORE flipping the switch.** With
`gateway.multiplex_profiles` on and no `gateway.multiplex_profile_allowlist`,
the gateway serves EVERY profile on the host, and "served" also gates cron
ticking — each served profile's cron jobs run inside this gateway. A profile
that already runs its own gateway (a `watcher`, for instance) would then be
served twice: a relay-token clash plus double cron. Write the allowlist first,
then the switch, and there is never a restart window where "all" is in force:

```bash
hermes config set --force gateway.multiplex_profile_allowlist '[default]'
hermes config set --force gateway.multiplex_profiles true
```

`--force` only skips the CLI's `⚠ 'gateway.multiplex_profiles' is not a
recognized config key — it was saved anyway` notice (with a misleading
`Did you mean: gateway.multiplex_profile_allowlist`) that the second line
prints without it; the gateway reads the key as written, and the allowlist key
is recognized outright. Hermes facts
these rules rest on (verified on Hermes 0.21.0 / v2026.8.31):

- **Precedence:** the `GATEWAY_MULTIPLEX_PROFILES` environment variable
  (`1/true/yes/on`, `0/false/no/off`) beats `gateway.multiplex_profiles` in
  config.yaml, which beats the default of **off**. A blank or unrecognized env
  value falls through to config instead of forcing the switch off.
- **A malformed allowlist fails safe:** a value that is not a list serves the
  default profile only (with a warning); invalid entries are skipped;
  `default` is always served. An ABSENT allowlist is the "serve everything"
  shape — that is the one to avoid.
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
