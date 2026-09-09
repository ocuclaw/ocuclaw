# Agent choice — fresh installs AND existing ones

Read during fresh setup before the gateway restart, and on ANY existing
install whose `ocuclaw_setup` status reports
`mandatoryConfiguration.agentModeChosen: false` (an install that predates this
question, or an interrupted write). Multiple agents is the recommended OcuClaw
beta experience. Keep this a product choice; do not ask the user to understand
multiplexing or environment flags.

**Why existing installs matter (#2515):** on such a host the phone's new-agent
"+" is grey and, when tapped, says *"Multiple agents is off on your Hermes
host. Run /ocuclaw-setup"* — the wearer was sent here by that line.
`hermes ocuclaw status` shows the same fact as
`multiple agents  off · agent mode not chosen yet`, and `hermes ocuclaw doctor`
adds `→ run /ocuclaw-setup in a Hermes chat to choose`.

1. Read `ocuclaw_setup` status. If `mandatoryConfiguration.agentModeChosen`
   is true, retain its `agentMode` and continue without repeating the question.
   If it is false — fresh install, existing install, or the router's
   `agent_mode` branch — ask. Never skip the question on an existing install
   because "setup already ran": the choice was never recorded there.
2. Ask once: **"Would you like to create and switch between agents
   (recommended), or use a single agent?"** Explain that multiple agents use
   the host's model access and approval rules, each with their own chats and
   memory. Creating an agent requires a gateway restart, which waits for runs
   to finish. The supported Hermes version uses the host's starting folder;
   per-agent folders are read-only.
3. Apply the selected branch in the default Hermes profile. The answer
   authorizes these configuration changes; do not ask for each command.

   **Multiple agents:** inspect `hermes profile list` and
   `hermes config get gateway.multiplex_profile_allowlist`. Set the allowlist
   FIRST, then flip the switch, in this order:

   ```bash
   hermes config set --force gateway.multiplex_profile_allowlist '[default]'
   hermes config set --force gateway.multiplex_profiles true
   hermes config set --force platforms.ocuclaw.extra.agent_mode multiple
   ```

   For the fresh default-only case the allowlist is exactly `[default]`. If
   other Hermes profiles already exist, let the user choose which to make
   available; preserve existing list entries and include the selected names.
   Do not automatically enroll unrelated profiles. New agents created through
   OcuClaw enroll themselves in this list before activation.

   *Why the allowlist comes first:* with `gateway.multiplex_profiles` on and
   NO allowlist, the gateway serves EVERY profile on the host, and "served"
   also means that profile's cron jobs tick inside this gateway. A profile
   that already runs its own gateway (a `watcher`, say) would then be served
   twice — a relay-token clash plus double cron. Writing the allowlist before
   the switch means there is never a restart window where "all" is in force.

   *Why `--force`, and what to expect:* without it, the
   `gateway.multiplex_profiles` line prints `⚠ 'gateway.multiplex_profiles'
   is not a recognized config key — it was saved anyway, but Hermes may not
   read it.` plus `Did you mean: gateway.multiplex_profile_allowlist`. The
   value IS saved and the gateway DOES read it (Hermes 0.21
   `gateway/config.py` honors `gateway.multiplex_profiles` written exactly
   this way); the notice is the CLI's key registry lagging the gateway.
   `--force` only skips that notice (the allowlist and `agent_mode` keys are
   recognized and print nothing; `--force` on them is harmless). If the user
   ran the command without `--force` and saw the warning, tell them it is
   expected and nothing needs redoing — do NOT "fix" it by switching to the
   suggested allowlist key.

   **Single agent:** set `gateway.multiplex_profiles` to `false` and
   `platforms.ocuclaw.extra.agent_mode` to `single` (same `--force` note).
   Explain that creation and switching are unavailable in this mode, and that
   the phone's "+" stays grey by choice. Retain any saved allowlist.

4. Re-read `ocuclaw_setup` status: require `agentModeChosen: true` and the
   selected `agentMode`. If commands were interrupted, resume the same branch;
   do not reinterpret an incomplete write as a different user choice
   (`hermes ocuclaw status` names that state as
   `the choice and the switch disagree`).
5. Use the existing setup restart step, then verify the served agent list
   and creation capability match the selected mode. On an existing install
   this restart is the ONLY one the choice needs; the phone's "+" turns from
   grey to live once the app reconnects. A process environment
   override that disagrees with the saved choice is a setup failure to resolve,
   not permission to claim the choice is active.

## Hermes facts this choice rests on (verified on Hermes 0.21.0 / v2026.8.31)

- **Precedence:** the environment variable `GATEWAY_MULTIPLEX_PROFILES`
  (`1/true/yes/on` or `0/false/no/off`) beats `gateway.multiplex_profiles`
  in config.yaml, which beats the default of **off**. A blank or unrecognized
  env value falls through to config rather than forcing the switch off. A
  host that sets that variable will disagree with the saved choice — that is
  the "environment override" failure in step 5.
- **Malformed allowlist fails safe:** a `gateway.multiplex_profile_allowlist`
  that is not a list serves the DEFAULT profile only (with a warning);
  individual entries that are not valid profile names are skipped.
  `default` is always served and never needs listing. An ABSENT allowlist is
  the dangerous shape — it means "serve every profile".
- **A secondary profile that enables a port-binding platform is not served.**
  The default profile owns the one shared listener; a secondary profile whose
  config enables OcuClaw (or any port-binding platform) is SKIPPED at gateway
  start with a warning naming the profile, and the rest of the gateway comes
  up. OcuClaw therefore stays configured on the default profile only. (The
  startup failure that IS fatal is a secondary profile with an `open`
  dm/group policy and no allow-all flag.)

OcuClaw's authenticated shared transport is supported by Hermes 0.21. Do not
set `OCUCLAW_ALLOW_ALL_USERS` or introduce a user-authorization bypass to enable
multiple agents. If a secondary turn is rejected, use the troubleshooting
branch to verify the bundle version, source provenance and served profile.
The served-profile allowlist selects agents; it is not a sender-auth allowlist.
