# Updating OcuClaw on Hermes

**Guide version:** 2026-09-10 (1.3.20-hermes)

Use this for an installed, healthy OcuClaw on Hermes moving to a strictly
higher published bundle version. It is version-neutral: it never names a
source version and never removes or reinstalls the plugin. There is one
access-controlled GitHub channel; there is no npm or ClawHub selector. Preserve
unexplained local plugin source instead of replacing it without the user's
decision.

The platform `/update` command is refused from sessions. This host-side
sequence is the accepted upgrade contract.

There is no downgrade, no old-version reinstall, and no state rollback. A
failed update is repaired forward through this same sequence at a corrected,
strictly higher version.

## The canonical install and update block

This is the one wording every OcuClaw-on-Hermes surface uses. Quote it; do not
paraphrase it, and do not reorder its steps.

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

## U1 · Read-only preflight

```bash
hermes --version
hermes plugins list
```

Hermes must remain within `>=0.21.0,<0.22.0`, and `ocuclaw` must be installed.
Call `{"operation":"status"}` first. If the state is not `configured` or
`connected`, this is not an update — call `{"operation":"troubleshooting"}` or
`{"operation":"fresh_install"}` instead.

While you have that receipt, read `status.mandatoryConfiguration.agentModeChosen`.
An install that predates the agent question reports `false` there, and its
phone shows a grey new-agent "+" (#2515). Do not let the update finish without
offering the choice: after U4, call `{"operation":"agent_mode"}` and follow
it. It adds no second restart — U3 is the restart it needs, so make the
choice BEFORE U3 when you can.

## U2 · In-place update

Warn that Hermes will need a restart, then CHECKPOINT:

```bash
hermes plugins update ocuclaw
```

This updates in place. It preserves the profile `.env`, `config.yaml`, Hermes
sessions, and OcuClaw state.

`hermes plugins update` neither restarts the gateway nor prints an instruction
to. Unlike `hermes plugins install`, its last line is the success line — a user
who follows only what the command told them is left running the old code with no
error anywhere. Say the restart out loud; U3 is not optional.

## U3 · Explicit restart

Call `{"operation":"quick_reference"}` and follow `Restarting the gateway`
once. A config or bundle change is live only after a successful restart.

If the read-only OcuClaw dashboard tab is open, reload `/ocuclaw` after the
restart. The dashboard is optional detail, never a fallback dependency.

## U4 · Re-verify health

VERIFY:

```bash
hermes plugins list
hermes config get display.platforms.ocuclaw.tool_progress
hermes config get platforms.ocuclaw.extra.allow_admin_from
```

Require the plugin to be enabled, tool progress to report `false`, and
`allow_admin_from` to list `ocuclaw-wearer`. If a non-secret posture value
drifted or is missing, CHECKPOINT the matching correction:

```bash
hermes config set display.platforms.ocuclaw.tool_progress off
hermes config set platforms.ocuclaw.extra.allow_admin_from '["ocuclaw-wearer"]'
```

The `allow_admin_from` key is NEW for existing installs: it enables "Continue
here" (the glasses pick up a chat started in Hermes Desktop, the CLI or the
TUI). Every install before it reports `mandatoryConfiguration.adoptConfigured:
false` and `hermes ocuclaw doctor` prints the `continue_here_not_configured`
warning until the key is written — write it as part of the update, do not wait
for the user to hit "Continue here isn't set up on this Hermes". Say plainly
what it does: it turns Hermes's slash-command gating ON for the OcuClaw
platform as a whole, which is safe because `ocuclaw-wearer` is the only user id
the plugin ever sends (the wearer becomes the sole admin; nothing else can reach
the gate). Preserve any ids already listed and append `ocuclaw-wearer`.

Then follow `Restarting the gateway` once more.

An update never turns a key on by itself. Read
`status.hermesHooks.streamReasoningDeltasOffer` from the receipt you already
have and follow the same four-way rule as fresh install Step 4b:
`already_enabled` -> one line and move on; `inert` -> say the key would do
nothing on this Hermes and do not offer it; `unknown` -> skip; `offer` ->
CHECKPOINT the gateway-wide cost, wait for an explicit yes, then call
`{"operation":"enable_stream_reasoning_deltas","confirm":true}` once and
follow `Restarting the gateway` a final time. A no is a finished answer.

Call `{"operation":"doctor"}` for the setup-bundle reconciliation receipt,
then run the bounded host command `hermes ocuclaw doctor`. Require a configured
setup and healthy four-leg result. If its Setup section shows
`multiple agents  off · agent mode not chosen yet` with the
`→ run /ocuclaw-setup in a Hermes chat to choose` line, the agent choice from
U1 is still owed: call `{"operation":"agent_mode"}` now and follow it. If the Relay Credential is missing, stop and
enter troubleshooting `CREDENTIAL-MISSING`. An update never creates, imports,
or prompts for a replacement.

Then read `status.desktopTheme.offer` from the same receipt. When it says
`offer` and the user runs Hermes Desktop, make the fresh-install Step 12 offer
(the OcuClaw look) and, only on a plain yes, call
`{"operation":"enable_desktop_theme","confirm":true}` once. `already_enabled`,
`unavailable`, `unknown` and TUI-only users all mean: say nothing and move on.

## U5 · Prove the round trip

An ordinary update preserves the historical Hermes First-Run Proof and does
not re-run the first-run ceremony. Confirm the platform is serving turns: run
a phone-origin hello and require a reply on the Even G2 when guided diagnosis
makes it relevant. A host CLI query is not a substitute for a G2 check when
one is called for.

On success call `{"operation":"wrap_feedback"}`. On failure call
`{"operation":"troubleshooting"}` and enter the matching case.
