# Updating OcuClaw on Hermes

**Guide version:** 2026-08-06 (1.0.2-hermes)

Use this only for an already-installed OcuClaw Hermes plugin. There is one
public GitHub channel; there is no npm/ClawHub beta selector or rollback
channel.

## U1 · Update

Read-only preflight:

```bash
hermes --version
hermes plugins list
```

Hermes must remain within `>=0.19.0,<0.20.0`, and `ocuclaw` must be an
installed plugin. Preserve any local/unexplained source instead of replacing
it without a user decision.

CHECKPOINT, with the restart warning:

```bash
hermes plugins update ocuclaw
```

This performs the plugin's Git update. It is intentionally not `hermes
update`, which updates Hermes itself. A plugin update does not apply host
configuration from `after-install.md`, so reassert the beta tool-progress
posture in the same checkpoint:

```bash
hermes config set display.platforms.ocuclaw.tool_progress off
```

VERIFY the non-secret setting:

```bash
hermes config get display.platforms.ocuclaw.tool_progress
```

Continue only when it reports `false`. Hermes 0.19 stores the CLI value `off`
as a boolean. If the optional config-gated Hermes `/verbose` command changed
the OcuClaw platform mode, this command deliberately restores it.

Then CHECKPOINT the required runtime application:

```bash
hermes gateway restart
```

VERIFY:

```bash
hermes plugins list
```

Read the newest gateway log and require the loopback relay listening line.
Run a phone-origin Step 10 hello from `fresh-install.md`; a host CLI query is
not a substitute. On success load `wrap-feedback.md`. On failure route to the
matching named troubleshooting case.

The plugin update refreshes the bundled skill source, but Hermes skill
discovery uses `~/.hermes/skills/ocuclaw-assist-hermes`. If the link was
removed, recreate it using the exact after-install command shipped with the
plugin; do not create a different path layout.
