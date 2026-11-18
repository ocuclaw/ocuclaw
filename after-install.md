# OcuClaw installed

Hermes loads OcuClaw when it restarts.

**Installed by your agent in a chat?** The agent runs this next. It turns on
OcuClaw's settings and restarts Hermes once, for about a minute:

    hermes ocuclaw setup-start

The agent tells you about the restart first. The chat reconnects by itself.
Then say `continue`, and the agent sets OcuClaw up with you through its
`ocuclaw_setup` tool.

**Typing commands yourself?** Run setup instead:

- **On Cloudways:** `hermes ocuclaw cloudways setup`
- **Anywhere else:** open `hermes --tui` and type `/ocuclaw-setup`

That setup tells you when a restart is needed, just once.
If SSH drops, reconnect and run the same command again.

If Hermes shows its own restart note below, you can skip it.

Have your phone and glasses nearby. Setup pairs them and ends with a reply on
your glasses display.

Full guide and troubleshooting: **https://ocuclaw.com/setup**
Stuck? Run `hermes ocuclaw doctor`.
