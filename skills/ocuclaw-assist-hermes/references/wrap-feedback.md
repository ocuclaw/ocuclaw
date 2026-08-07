# OcuClaw Hermes wrap-up and feedback

**Guide version:** 2026-08-06 (1.0.2-hermes)

Load this only at a genuine finish: fresh install, update, or standalone fix
completed. Never after an unresolved failure or ESCALATE.

A genuine finish delivers, in order:

1. a brief summary of what was installed or fixed;
2. the saved relay address;
3. the silent checklist's first and only visible render;
4. an optional security-review offer;
5. the WRAP note, including the FEEDBACK question before its donation line.

If interrupted, answer the question and resume at the first undelivered item.
The donation line is the last line of the wrap message; nothing follows it in
that message. The optional feedback block is a later reply after the user
answers, so it does not violate the wrap message's final-line rule.

The saved address is:

```text
wss://<node>.<tailnet>.ts.net:8446
```

Never include the relay token. If the relay port was overridden, that remains
an internal loopback detail; the phone address still ends in `:8446`.

## Self-audit

Render the exact checklist from `SKILL.md` with final states. Every required
box except the wrap box must be ticked, skipped with an explicit reason, or
blocked. On update and standalone-fix lanes, mark fresh-install-only rows
`[skipped: not applicable to this update/fix lane]`; never imply those facts
were re-proved. The exact wrap box is `Ordered wrap (including feedback
request) delivered`. Render only that box unchecked with
`(ticks when this finish completes)`. If another applicable required box is
open, return to it instead of closing.

Offer a read-only security review of the Hermes/OcuClaw network posture. State
that the relay remains loopback-bound and only Tailscale Serve fronts it.

## WRAP

- Community and support: `https://discord.ocuclaw.com`.
- Future problems: use **Send** in the OcuClaw app when available; it carries
  diagnostic conversation content but scrubs secrets, tokens, and addresses.
  Offline client-only and Save-to-machine are fallbacks.
- Before the donation line, ask how the setup assistant flow felt and point to
  `https://ocuclaw.com/setup`. This question completes the named wrap box; the
  user's later answer and block are optional.
- End the wrap message with this exact final line:

> Finally, OcuClaw is a one man project. Donations are optional but appreciated and directly funds the project: https://buymeacoffee.com/ocuclaw

## FEEDBACK

Ask first: was the assistant flow smooth, bumpy, or rough, and what was
confusing or surprising? After the user answers, render this block exactly
once. Use only evidence already recorded; never run new probes at wrap.

```text
OcuClaw setup assistant feedback — guide 2026-08-02 (1.0.0-hermes)
Platform: <OS only>
Hermes version: <version or unknown>
OcuClaw bundle version: <version or unknown>
OcuClaw app version: <version or unknown>
Outcome: <fully set up / set up with help / fixed / updated>
Steps done: <install / update / Tailscale / app connect / optional integrations>
How it felt (user's words): <answer>
Where it snagged (assistant notes): <notes>
Suggestions: <answer>
```

Confirm it contains no secrets, tokens, network details, node names, or
addresses, then invite the user to paste it at `https://ocuclaw.com/setup`.
