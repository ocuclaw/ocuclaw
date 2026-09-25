# OcuClaw installed

Now run one command.

- **Cloudways host:** run `hermes ocuclaw cloudways setup`. Do not restart
  your gateway first: setup saves its settings, then at step 3 asks for one
  gateway restart that loads OcuClaw and applies them together. If that
  restart closes SSH, reconnect and run the same command again; it carries on
  from there.
- **Anywhere else:** open `hermes --tui` and enter `/ocuclaw-setup`. Do not
  restart your gateway first: setup saves its settings, then asks for one
  gateway restart that loads OcuClaw and applies them together.

Hermes prints its own restart hint below this card; ignore it here.

Have your phone and glasses nearby. It pairs them and ends with a reply on your
glasses display.

Full guide and troubleshooting: **https://ocuclaw.com/setup**
Also in the bundled `README.md`, or run `hermes ocuclaw doctor`.
