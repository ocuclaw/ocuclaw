# The delivery ladder, self-contained

Every claim you make about a render sits on a rung. This file ships **with the skill**, so
the rungs and their honest phrases are readable wherever the skill is installed — you never
need a repo checkout to know what you are allowed to say.

```
authored → validated → send_attempted → client_receipt → wearer_interacted
```

| rung | what earns it | honest phrase | the over-claim it replaces |
|---|---|---|---|
| `authored` | you produced a surface spec | "authored, not yet validated" | "I've set up your surface" |
| `validated` | the spec passed validation — no `render_rejected` | "validated, not yet sent" | "it's ready on your glasses" |
| `send_attempted` | the render went out past the paint floor | **"attempted, unconfirmed"** | "it's on your glasses now" |
| `client_receipt` | the client reported painting a frame | **"painted per client receipt"** | "you're looking at it" / "as you can see" |
| `wearer_interacted` | a **gesture** came back (`origin: "gesture"`, `actor: "wearer"`) | "you picked Milk" | anything upgrading a tap into having read the rest |

Two rules follow from the table and they are the whole point of it:

1. **Rungs cannot be skipped.** The honest rung is the longest unbroken run from the left.
   A receipt with no send record is a bug to log, not a rung to claim.
2. **There is no rung above `client_receipt` a machine can earn.** A receipt proves the
   client *reported painting a frame*. It proves nothing about a human. The only evidence a
   person took a surface in is that the person *did something* — `wearer_interacted` — and
   that arrives only when it arrives, or never.

`transport_accepted` (the relay/BLE backpressure latch clearing) is **not** a rung. It is an
annotation on `send_attempted`. The transport taking a frame says nothing about the client.

## The words that are refused by name

The perception verbs are rejected **in code**, each with its honest substitute attached to
the throw. The single list is `FORBIDDEN_CLAIM_TERMS` in
`extensions/ocuclaw/src/tools/glasses-ui-delivery-ladder.ts` — read it there rather than
keeping a copy in your head. A claim you cannot spell is a claim you cannot ship.

The same rule governs **field and variable names**: name a fact after the mechanism that
produced it, never after the meaning you wish it had. Write `lastPaintedAt`,
`clientReceiptAtMs`, `sendAttemptedAtMs`. `assertHonestFieldName()` enforces it across
camelCase, snake_case and kebab-case, on whole word tokens — so `unseenCount` is fine.

## `terminationCause` is a different question

A surface can end at **any** rung. The rung says *how far it got*; `terminationCause` says
*why it ended*. Never collapse them: a `dismissed` surface reached `wearer_interacted`; a
`glasses_disconnected` one may have died at `send_attempted`. Both are terminated.

## Where the full contract lives

The binding contract — all 26 pinned invariants, the review-rung reconciliation table, the
`terminationCause` vocabulary and its sources — is
`docs/design/liveui-research/contract/delivery-ladder.md` **in the OcuClaw repo**. That path
is a repo path, not a path inside this published bundle: use it when you have the repo, and
use this file when you do not. Everything a close needs is in the table above.
