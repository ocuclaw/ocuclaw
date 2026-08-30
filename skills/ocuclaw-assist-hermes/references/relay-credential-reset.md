# Reset relay credential — all devices

**Guide version:** 2026-08-30 (1.3.17-hermes)

Use this branch only when the user explicitly asks to reset the Relay
Credential or suspects a paired phone is lost or compromised. This is an
all-device reset; per-device revocation is future work.

## R1 · Read-only gate

Call `{"operation":"status"}`. Continue when `relayTokenPresent` is true. When
false, enter troubleshooting `CREDENTIAL-MISSING`: normal setup must stop, but
the locally confirmed reset may proceed because the secret-free generation
marker proves the profile is established. Existing pre-marker profiles adopt a
marker on first bootstrap after upgrade without changing their credential.

## R2 · Warn and checkpoint

Before asking for confirmation, say exactly:

> Reset immediately invalidates ALL existing app pairings, disconnects every
> paired phone, requires secure QR or Manual re-pairing, and cannot restore the
> prior credential.

Explain that the next command is the only mutation: it requires confirmation
in an interactive terminal on the Hermes host, generates and atomically stores
the replacement without revealing it, explicitly restarts the Hermes gateway,
and proves both replacement acceptance and prior-credential rejection. A chat
reply is not confirmation. CHECKPOINT this exact command with no added flags,
pipe, redirection, wrapper, or automation:

```bash
hermes ocuclaw reset-relay-credential
```

The user runs it directly. The command repeats the warning and accepts only the
word `reset` at its local prompt. There is no `--yes`, `--json`, dashboard,
presenter, or non-interactive path. Before persistence it also requires a
bounded Hermes service restart lifecycle. An unmanaged foreground gateway is a
secret-free refusal: install and start the Hermes gateway service, then retry.

Managed/NixOS Hermes profiles are outside the beta platform scope under the
[managed-mode ruling clarification](https://github.com/OcuClawhub/even&#99;law/issues/1321#issuecomment-5312718733).
OcuClaw does not generate, prompt for, or bypass-write a secret there. A
deployment-provided readable `OCUCLAW_RELAY_TOKEN` remains established and may
adopt a marker when the state directory is writable, but the all-device reset
always refuses because there is no authorized managed secret persistence path.
When the credential is absent, setup and reset say: `managed Hermes profile: OcuClaw does not write secrets in managed mode; provision OCUCLAW_RELAY_TOKEN through your deployment, then restart`.

## R3 · Classify the receipt

Success requires these secret-free facts in the terminal receipt:

- replacement atomically persisted and read back;
- Hermes gateway restart succeeded;
- replacement authentication was accepted after a bounded readiness poll;
- prior credential authentication was rejected, or is exactly
  `not_applicable` when the established profile had no readable prior
  credential.

Any other result is incomplete. Do not call it success and do not repeat the
reset blindly: return to guided recovery, call `{"operation":"doctor"}`, and
record only stable outcome names and presence booleans. Never request or expose
either credential.

## R4 · Securely re-pair

On success every phone is disconnected. Run `hermes ocuclaw doctor` and
continue only when the route is currently verified. With the phone ready, call
`{"operation":"pair_phone"}` so the supported Hermes TUI/Desktop panel obtains the
verified address and advances from QR to the four-word local decision without
passing either through the model.

QR and Manual are credential-free initiations of the same encrypted exchange.
Completion criterion: the intended phone completes an authenticated app hello;
no other phone is described as paired. Then resume the Setup Assistant at the
phone-origin/G2 completion journey. The separate-terminal
`hermes ocuclaw pair --address <verified-phoneAddress>` command is only the
documented fallback if the supported direct presenter fails after one retry.
