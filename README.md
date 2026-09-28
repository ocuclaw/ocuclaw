> [!NOTE]
> This repository is a generated artifact, published from our own source each
> release. Pull requests here are not read. To report a problem, open Info ›
> **Report a bug** in the OcuClaw app, or ask on [Discord](https://discord.ocuclaw.com).

---

<p align="center">
  <img src="https://raw.githubusercontent.com/ocuclaw/ocuclaw-openclaw-plugin/main/assets/og-card.png" alt="OcuClaw: your agent lives on your glasses. The phone stays in your pocket." width="760">
</p>

# OcuClaw for Hermes Agent

Your Hermes agent on your Even Realities G2 smart glasses. See what it can do at
[ocuclaw.com](https://ocuclaw.com).

[Website](https://ocuclaw.com) · [Setup guide](https://ocuclaw.com/setup) · [Discord](https://discord.ocuclaw.com)

> Running OpenClaw instead of Hermes? Use
> [ocuclaw/ocuclaw-openclaw-plugin](https://github.com/ocuclaw/ocuclaw-openclaw-plugin).
> This repository is Hermes-only.

## Requirements

- Hermes `>=0.21.1,<0.22.0` (Hermes 0.21.1 and later 0.21.x), and Git on the
  Hermes host.
- Even Realities G2 smart glasses and the OcuClaw app from Even Hub.
- Tailscale on your phone, and on the Hermes host (Cloudways setup installs
  the host one for you).

## Install

Install once, in the default Hermes profile. Pick how you run Hermes.

### Cloudways

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes ocuclaw cloudways setup
```

Do not restart the gateway yet. Setup asks for one restart when it needs it.

### Hermes TUI

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes config set display.interface tui
```

Do not restart the gateway yet. Open `hermes --tui` and run `/ocuclaw-setup`.
It pairs your glasses, then asks for one restart.

### Hermes Desktop

Paste `hermes://plugin/install?repo=ocuclaw/ocuclaw` into your browser's
address bar and accept the install. Restart the gateway, then run
`/ocuclaw-setup`.

## Update

```bash
hermes plugins update ocuclaw
hermes gateway restart
```

## Uninstall

1. If you turned OcuClaw off, turn it back on:
   `hermes plugins enable ocuclaw --no-allow-tool-override`.
2. Run `hermes ocuclaw uninstall`. If it asks for a restart, run
   `hermes gateway restart`, then `hermes ocuclaw uninstall` again. If it
   prints a `tailscale serve ... off` command, run that first.

This works on Cloudways too, and removes the Tailscale pieces OcuClaw set up.

Do not use `hermes plugins remove` on its own: it leaves the Hermes Desktop part
behind.

## Help

Stuck? Run `hermes ocuclaw doctor`, use **Report a bug** in the OcuClaw app,
or ask on [Discord](https://discord.ocuclaw.com).
