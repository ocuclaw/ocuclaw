> [!NOTE]
> This repository is a generated artifact, published from our source monorepo
> each release. Pull requests are welcome and we read them. A change we take is
> applied in the monorepo and lands here with the next release, so the pull
> request itself is closed, not merged. To report a problem, open Info ›
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

- Hermes 0.21.4 or newer, and Git on the Hermes host. OcuClaw is tested on
  `>=0.21.4,<0.24.0` (Hermes 0.21.4 through 0.23.x); a newer Hermes runs with
  a warning.
- Even Realities G2 smart glasses and the OcuClaw app from Even Hub.
- Tailscale on your phone, and on the Hermes host (Cloudways ships the host
  one, and setup starts it for you).

## Install

Install once, in the default Hermes profile. Pick how you run Hermes.

### Cloudways

```bash
hermes plugins install ocuclaw/ocuclaw --enable
hermes ocuclaw cloudways setup
```

Do not restart the gateway yet. Setup asks for one restart when it needs it.

Or skip the terminal: in the agent's own chat (**Open Agent**), ask "Install
OcuClaw and set it up for my Even G2 glasses." The agent runs the same setup
in the chat.

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

This works on Cloudways too, and removes the Tailscale pieces OcuClaw set up,
and the no-admin computer-use desktop if you added one.

Do not use `hermes plugins remove` on its own: it leaves the Hermes Desktop part
behind.

## What OcuClaw does on your Hermes host

- **Background process.** It runs the bundled OcuClaw runtime as a child of the
  Hermes gateway. That runtime holds the link to your paired phone.
- **Network.** It opens one relay port that your phone connects to. With your
  approval, it uses Tailscale Serve so your phone can reach it away from home.
  On Cloudways it uses the platform's own Tailscale.
- **Outbound calls.**
  - `pair.ocuclaw.com`, to exchange the pairing code.
  - The links you ask the glasses to show (pictures, video, 3D models), behind a
    guard that blocks private addresses.
  - Sketchfab, for 3D model search.
  - Soniox (voice transcription) and TypeSafe (Jev), only when you save your
    own key for that service.
  - Your server's own Debian package mirror (`deb.debian.org` on Cloudways),
    only when you ask for computer use on Cloudways (below).
- **Commands it runs.** The Tailscale CLI, to read and set up Serve; `yt-dlp`
  and `ffmpeg` for video; and the Hermes CLI for setup checks.
- **Computer use on Cloudways.** Hermes has no admin rights there, so it cannot
  install the desktop its computer use runs in. When you ask for it from the
  OcuClaw app, your agent runs an OcuClaw command that runs `apt-get` as your
  own user to download the desktop packages (about 40 MB) from the server's own
  Debian sources. apt checks each package against those sources' signed index,
  which is what pins them. `dpkg -x` unpacks them, with `proot`, under
  `~/.local/share/bot-desktop-rootless`. It writes launcher scripts there and
  links them into a folder in your home that is already on Hermes's PATH
  (`~/pipx/bin` on Cloudways), then starts Hermes's own desktop. Nothing is
  bundled, nothing runs as root, no system folder changes, and Hermes's own
  memory limit is never lowered. It runs only on Cloudways, and only when you
  ask. `hermes ocuclaw uninstall` takes it all away.
- **Saved keys.** The relay credential, and any optional keys you save (Soniox,
  Even AI, TypeSafe). All are read and written through Hermes, in the profile's
  `.env`.
- **New agents.** When you create an agent from the OcuClaw app, Hermes copies
  your main agent's model API keys into the new agent. Nothing else is copied:
  no memories, personality or other keys.
- **Continue here.** Setup makes the glasses wearer the slash-command admin for
  the OcuClaw channel only. The wearer is the only user OcuClaw ever sends.
  This lets Continue here resume your Desktop, CLI and TUI chats on the
  glasses. It does not change tool approvals. To turn it off, remove
  `ocuclaw-wearer` from `platforms.ocuclaw.extra.allow_admin_from`.
  On Hermes 0.23 or newer, a continued chat is a **shared chat**: one
  conversation that the glasses and Desktop, the TUI or the CLI all drive,
  and turns typed at the desk show on the glasses. Setup also sets
  `display.busy_input_mode: queue` when you have not chosen a mode, so a
  message sent while a reply is still coming waits its turn instead of
  cutting that reply off. That key applies to all of this Hermes, and
  `hermes ocuclaw doctor` warns while it is unset. To keep Continue here
  copy-only, set `platforms.ocuclaw.extra.sharedChats: false`.
- **Auto agent** (off by default). Turn it on in the app under
  **Settings → New chats → Auto agent**. A host can withdraw it for every
  wearer with `platforms.ocuclaw.extra.auto_agent: false` in the default
  profile's config. A new chat started on **Auto** goes to the agent whose name you say
  first, or else to the one a cheap model picks from each agent's
  description. The prompt goes to the model Hermes uses for auto Group Chats
  (`auxiliary.group_router`); pick another under **OcuClaw Auto agent** in
  Hermes's model picker. Only the picked agent and why are logged.
  Edit each agent's description in the app under **Settings → New chats**.
  **Write missing ones for me** asks Hermes to draft the empty ones with its
  profile describer model (`auxiliary.profile_describer`), and never
  replaces one you wrote.
- **Telemetry.** None. A debug bundle is sent only when you choose
  **Report a bug** in the OcuClaw app.

## Help

Stuck? Run `hermes ocuclaw doctor`, use **Report a bug** in the OcuClaw app,
or ask on [Discord](https://discord.ocuclaw.com).
