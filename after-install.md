# Finish setting up OcuClaw

These commands use the official Hermes 0.19 CLI. Do not edit Hermes
configuration files or secret files by hand.

## 1. Enable the plugin

```bash
hermes plugins enable ocuclaw
```

## 2. Store the relay token

Replace the placeholder with the same token entered in the OcuClaw app relay
server token field. Do not paste the real value into chat or diagnostics.

```bash
hermes config set OCUCLAW_RELAY_TOKEN "YOUR-RELAY-TOKEN"
```

The relay token is required. Hermes stores environment-key settings through
its secret-aware configuration lane, and the environment value takes precedence
over any legacy dotted token setting.

## 3. Add optional service secrets

Only run the command for a service you intend to use. Never use an empty value.

Soniox speech-to-text:

```bash
hermes config set OCUCLAW_SONIOX_API_KEY "YOUR-SONIOX-API-KEY"
```

Even AI:

```bash
hermes config set OCUCLAW_EVEN_AI_TOKEN "YOUR-EVEN-AI-TOKEN"
```

These exact environment-key names override legacy dotted secret settings. The
plugin manifest intentionally prompts only for `OCUCLAW_RELAY_TOKEN`; the two
optional secrets do not gate plugin loading.

## 4. Set non-secret options

The relay defaults are sufficient for most testers. The Hermes beta ships
Even Terminal ON through an explicit non-secret setting because the runtime
default remains off. Use dotted keys only for non-secret platform settings:

```bash
hermes config set platforms.ocuclaw.enabled true
hermes config set platforms.ocuclaw.extra.wsPort 47801
hermes config set platforms.ocuclaw.extra.evenTerminalEnabled true
hermes config set display.platforms.ocuclaw.tool_progress off
```

The last setting keeps Hermes' conversational tool-progress bubbles out of the
OcuClaw transcript. OcuClaw receives tool lifecycle activity through its
structured glasses HUD instead. On Hermes 0.19, `off` is stored as a boolean,
so the official readback below reports `false`; that is the expected value.

If Even AI is enabled, choose its non-secret behavior separately:

```bash
hermes config set platforms.ocuclaw.extra.evenAiEnabled true
hermes config set platforms.ocuclaw.extra.evenAiSystemPrompt "Answer briefly for the Even G2 HUD"
hermes config set platforms.ocuclaw.extra.evenAiRoutingMode active
```

Inspect non-secret settings without reading secrets back:

```bash
hermes config get platforms.ocuclaw.enabled
hermes config get platforms.ocuclaw.extra.wsPort
hermes config get platforms.ocuclaw.extra.evenTerminalEnabled
hermes config get display.platforms.ocuclaw.tool_progress
hermes config get platforms.ocuclaw.extra.evenAiEnabled
hermes config get platforms.ocuclaw.extra.evenAiRoutingMode
```

Continue only when the tool-progress readback is `false`. If an operator has
enabled Hermes' config-gated `/verbose` command, using `/verbose` on OcuClaw
can change this per-platform setting; reapply the `off` command before beta
validation.

Do not set `platforms.ocuclaw.extra.wsBind`. The relay must stay on loopback;
use Tailscale Serve for the authenticated phone route at `:8446`.

## 5. Restart Hermes

```bash
hermes gateway restart
```

## 6. Link the bundled setup assistant

On macOS or Linux, run this exact idempotent command:

```bash
ln -sfn ~/.hermes/plugins/ocuclaw/skills/ocuclaw-assist-hermes ~/.hermes/skills/ocuclaw-assist-hermes
```

Confirm Hermes indexes it:

```bash
hermes skills list --source local --enabled-only
```

On Windows, use a normal PowerShell copy; it does not require administrator
mode or Developer Mode:

```powershell
$source = Join-Path $HOME ".hermes\plugins\ocuclaw\skills\ocuclaw-assist-hermes"
$target = Join-Path $HOME ".hermes\skills\ocuclaw-assist-hermes"
Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $source $target -Recurse -Force
```

After an update, repeat the Windows copy commands so the local copy receives
the refreshed guide.

## Remove the assistant or uninstall OcuClaw

Removing the POSIX link does not delete the bundled source:

```bash
unlink ~/.hermes/skills/ocuclaw-assist-hermes
```

On Windows, remove only the copied skill directory:

```powershell
Remove-Item (Join-Path $HOME ".hermes\skills\ocuclaw-assist-hermes") -Recurse -Force
```

To disable OcuClaw without uninstalling it:

```bash
hermes plugins disable ocuclaw
hermes gateway restart
```

For a full uninstall, first run the POSIX or Windows assistant-removal command
above for this host. Then list all default-profile cron jobs, remove every
OcuClaw job by the ID Hermes prints, disable the plugin, remove its checkout,
and restart the gateway:

```bash
hermes cron list --all
hermes cron remove <OCUCLAW-JOB-ID>
hermes plugins disable ocuclaw
hermes plugins remove ocuclaw
hermes gateway restart
```

Repeat `hermes cron remove` for each OcuClaw job. If the settings are no longer
needed, remove them through the CLI rather than editing configuration files,
then restart once more to apply that cleanup:

```bash
hermes config unset OCUCLAW_RELAY_TOKEN
hermes config unset OCUCLAW_SONIOX_API_KEY
hermes config unset OCUCLAW_EVEN_AI_TOKEN
hermes config unset platforms.ocuclaw
hermes config unset display.platforms.ocuclaw
hermes gateway restart
```

For guided setup or recovery, ask Hermes `help me set up OcuClaw` or
`help me fix OcuClaw`. If the assistant cannot resolve the problem, use
**Send** in the OcuClaw app or ask in the OcuClaw Discord community.
