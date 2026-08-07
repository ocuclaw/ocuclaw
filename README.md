> [!IMPORTANT]
> This repository is a generated artifact. Its source of truth lives in the
> private OcuClaw monorepo — nothing here is edited by hand, so pull requests
> and issues opened against this repository are not monitored and will be lost
> on the next publish. Report problems through **Send** in the OcuClaw app,
> which attaches the diagnostics needed to act on them.
>
> Every commit here is produced by `publish-bundle.sh`. History is append-only:
> a rollback is a new commit with a bumped version that restores the prior
> known-good payload — never a force-push and never a revert of history. Hermes
> updates this plugin with `git pull --ff-only`, so rewritten history would
> break every installed copy.

---

# OcuClaw on Hermes

OcuClaw connects an Even G2 and the Even Hub app to a Hermes gateway. This
Hermes platform plugin runs the OcuClaw relay, carries conversations between
Hermes and the glasses, and provides the LiveUI and Even Terminal HUD surfaces.

This installable repository is generated from the OcuClaw monorepo. Published
copies include the generated-artifact provenance notice and are updated only by
the bundle publisher; do not hand-edit an installed checkout.

## Requirements

- Hermes `>=0.19.0,<0.20.0` (the complete Hermes 0.19.x line only).
- Tailscale on the Hermes host and the phone for the authenticated external
  relay route.
- The OcuClaw app installed through Even Hub on the phone and Even G2.

## Install

Install the public beta bundle directly from its GitHub repository:

```bash
hermes plugins install OcuClawhub/ocuclaw-hermes-beta
```

Then follow [`after-install.md`](after-install.md) to enable the plugin, store
the three supported secrets through the Hermes CLI, restart Hermes, and expose
the bundled `ocuclaw-assist-hermes` skill. Once linked, ask Hermes
`help me set up OcuClaw` or `help me fix OcuClaw` for the guided setup flow.

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

## Update

```bash
hermes plugins update ocuclaw
hermes config set display.platforms.ocuclaw.tool_progress off
hermes config get display.platforms.ocuclaw.tool_progress
hermes gateway restart
```

The readback must be `false`. Plugin updates refresh bundle files but do not
apply this host setting automatically; the explicit command keeps Hermes tool
progress on OcuClaw's structured activity HUD instead of adding progress
bubbles to the conversation.

Run the linking step in [`after-install.md`](after-install.md) again if the
local assist-skill link was removed. The plugin update refreshes the bundled
skill source in place.

## Profiles, multiplex, and cron

OcuClaw is a port-binding platform and belongs on the default Hermes profile.
When `gateway.multiplex_profiles` is enabled, keep the plugin and its
notification cron jobs on the default profile. Secondary-profile glasses turns
need an explicit gateway-operator authorization posture such as
`OCUCLAW_ALLOWED_USERS=ocuclaw-wearer`.

`OCUCLAW_ALLOW_ALL_USERS=true` is an explicit authz-open operator choice, not
the recommended default. Do not enable it merely because multiplex is active.

## Help and escalation

Start with the bundled `ocuclaw-assist-hermes` skill. If setup remains blocked,
use **Send** in the OcuClaw app so the report includes the relevant diagnostics.
For tester discussion and follow-up, use the OcuClaw Discord community linked
from [ocuclaw.com](https://ocuclaw.com).
