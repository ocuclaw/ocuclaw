# OcuClaw Hermes wrap-up and feedback

**Guide version:** 2026-09-10 (1.3.20-hermes)

Use this `ocuclaw_setup` response only at a genuine finish: fresh install,
update, or standalone fix completed. Never after an unresolved failure or
ESCALATE.

A genuine finish delivers, in order:

1. one brief success sentence specific to the completed lane;
2. at most three user-relevant proof facts: the private route, phone pairing,
   and the bidirectional G2 proof;
3. an optional security-review offer;
4. the WRAP note, ending with its donation line.

If interrupted, answer the question and resume at the first undelivered item.
The donation line is the last line of the wrap message; nothing follows it in
that message. Do not ask the user to rate the setup assistant or send setup
feedback; completion should not add another question.

Do not render an address template or ask the user to reconstruct one. If they
need the current private address, return to `hermes ocuclaw doctor` and use
only its verified output. Never include the Relay Credential.

## Internal self-audit

Evaluate the loaded setup skill's checklist before responding, but never render
it or its checkbox notation. Every applicable item must be satisfied; on update
and standalone-fix lanes, treat fresh-install-only items as not applicable and
never imply those facts were re-proved. If an applicable item remains open,
return to it instead of closing. The ordered wrap becomes complete when this
finish response is delivered.

For a completed fresh install, keep the user-facing result close to this shape:

> OcuClaw is set up and verified. Your phone paired over the private Tailscale
> route, a Hermes reply appeared on your Even G2, and its welcome double-tap
> returned successfully.

Do not mention internal checklist rows, configuration keys, credential storage,
installation provenance, port numbers, or profile posture in this success
summary unless an unresolved warning makes one relevant.

Offer a read-only security review of the Hermes/OcuClaw network posture. State
that the relay remains loopback-bound and only Tailscale Serve fronts it.

## WRAP

- Community and support: `https://discord.ocuclaw.com`.
- Future problems: open OcuClaw's built-in **Report a bug** feature and send
  the diagnostic report. It includes relevant conversation details while
  scrubbing secrets, tokens, and addresses. If disconnected, create the
  offline client-only report or save it to the phone for manual sharing.
- End the wrap message with this exact final line:

> Finally, OcuClaw is a one man project. Donations are optional but appreciated and directly funds the project: https://buymeacoffee.com/ocuclaw
