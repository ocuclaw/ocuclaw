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
Hermes and the glasses, and provides the LiveUI and Even Terminal HUD surfaces.

This installable repository is generated from the OcuClaw monorepo. Published
copies include the generated-artifact provenance notice and are updated only by
the bundle publisher; do not hand-edit an installed checkout.

The human-facing baseline is Hermes release `v2026.8.27`. Its package version
`0.20.6` and certified commit
`5fc308a70719a83cccdbba4c0e39c23f5a8239d5` are separate identities. The
current bundle, shared plugin, and client train is 2.0.3; the bundled setup
guide has its own `1.3.18-hermes` version. The bidirectional client/plugin
compatibility floors are `2.0.2`. This beta bundle ships from the GitHub
repository only; it has no npm or ClawHub publication leg.

## Requirements

- Hermes `>=0.20.0,<0.21.0` (the complete Hermes 0.20.x line only).
- Tailscale on the Hermes host and the phone for the authenticated external
  relay route.
- The OcuClaw app installed through Even Hub on the phone and Even G2.

## Install and update

<!-- ocuclaw:install-block:start -->
OcuClaw needs Hermes `>=0.20.0,<0.21.0`; the certified baseline is Hermes
`0.20.6`.

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
Desktop picks up the OcuClaw presenter immediately, but the agent half still
only enters the gateway on the gateway's next start — so a Desktop install
leaves two follow-ups, and the OcuClaw setup card in the Hermes Desktop title
bar walks you through both:

1. The card explains the pending restart and offers **Restart gateway**. Click
   it, or run `hermes gateway restart` in a terminal — either works. The card
   reads the gateway's own reported platforms rather than its own web route, so
   it advances only once the gateway has genuinely loaded OcuClaw.
2. The card then reads **Pair your glasses**. Run `/ocuclaw-setup` and finish
   pairing. The card retires on the durable pairing receipt and stays gone,
   including across a Desktop relaunch.

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
and its secret-free generation marker. Hermes masked input remains only for
optional Soniox and Even AI credentials.

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
- `render_glasses_ui` LiveUI and Even Terminal integration, shipping enabled.
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

On Hermes 0.20.5 and newer the reasoning can also stream to the glasses live,
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
("Checking the logs first."). On Hermes 0.20.5 and newer those sentences get
their own line in the status bar and are tagged so the app can keep them out of
the conversation history. Hermes 0.20.0 has no hook for them, so they behave
exactly as they do today and the glasses row reads inactive.

To silence them at the source, in the Hermes config:

```yaml
display:
  platforms:
    ocuclaw:
      interim_assistant_messages: off
```

## Live reasoning

By default the agent's reasoning arrives in one piece when each model call
finishes. On Hermes 0.20.5 and newer you can have it arrive as it is written
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
your yes — the key stays an opt-in, it is just a guided one now. On Hermes
0.20.0 it tells you the key would sit inert instead of offering it.

Restart the gateway afterwards; Hermes reads the key when it builds its plugin
hook set, so nothing changes until it does. This is deliberately a Hermes
config key and not a glasses setting: turning it on changes how Hermes calls
the model for every surface on that gateway, not just OcuClaw. With it off —
or on Hermes 0.20.0, which has no such hook — reasoning still arrives, just in
whole pieces rather than as it is written.

Hooks newer than the Hermes 0.20.0 floor are feature-detected at
startup and only registered when the running Hermes actually has them, so an
older host stays log-clean and never advertises a feature it cannot produce.
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

## Profiles and multiplex

OcuClaw is a port-binding platform and belongs on the default Hermes profile.
When `gateway.multiplex_profiles` is enabled, keep the plugin on the default
profile. Secondary-profile glasses turns need an explicit gateway-operator
authorization posture such as
`OCUCLAW_ALLOWED_USERS=ocuclaw-wearer`.

`OCUCLAW_ALLOW_ALL_USERS=true` is an explicit authz-open operator choice, not
the recommended default. Do not enable it merely because multiplex is active.

## Help and escalation

Start with `/ocuclaw-setup`. If setup remains blocked,
use passive `hermes ocuclaw status`, then bounded-active
`hermes ocuclaw doctor`. The read-only OcuClaw dashboard tab at `/ocuclaw` is
optional detail, never a fallback dependency. Open the built-in **Report a
bug** feature in the OcuClaw app when support evidence is needed. For tester discussion and
follow-up, use the OcuClaw Discord community linked from
[ocuclaw.com](https://ocuclaw.com).
