# OcuClaw installed

Restart the gateway to load OcuClaw, then pair your glasses.

**Hermes Desktop (recommended)**
Open Hermes Desktop with `hermes desktop`.
On the OcuClaw card at the top right of the status bar, click
**Restart gateway**, then **Pair your glasses**.
If the card is missing, run `hermes gateway restart` in a terminal and reopen Desktop.

**Terminal**
Run `hermes gateway restart`, then open `hermes --tui`
and enter `/ocuclaw-setup`.

Have your phone and glasses nearby. Setup walks you through pairing.

To resume an interrupted setup, say “continue OcuClaw setup”
in the same conversation.

For troubleshooting, run `hermes ocuclaw doctor --json`,
see the bundled `README.md`, or just ask your agent for help.
