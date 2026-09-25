# Agent choice — fresh installs AND existing ones

**Guide version:** 2026-09-25 (1.3.24-hermes)

Read during fresh setup before the gateway restart, and on ANY existing
install whose `ocuclaw_setup` status reports
`mandatoryConfiguration.agentModeChosen: false` (an install that predates this
question, or an interrupted write). Multiple agents is the recommended OcuClaw
beta experience. Keep this a product choice; do not ask the user to understand
multiplexing or environment flags.

**Every command in this file runs in the DEFAULT Hermes profile.** The default
profile owns the wearer's pairing and the one relay credential; secondary
profiles are agents only, with no relay token, no OcuClaw install and no second
pairing. The profile ownership gate in SKILL.md runs first and refuses a setup
invoked anywhere else. Neither branch below is ever applied with `hermes -p
<name>`.

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

   **Except when single agent is unavailable (#3618).** If status reports
   `mandatoryConfiguration.singleAgentAvailable: false` (the preflight's
   `singleAgent.available: false` says the same), do not ask and **say nothing
   about it**: no line about single agent, the Hermes version or why. Apply
   the **Multiple agents** branch below as if the person had chosen it. This
   happens on every Hermes 0.21.4 and later, whatever the profile count:
   there "single" would only grey out the phone's "+", and most people want
   to create agents. On 0.21.1 to 0.21.3 `singleAgentAvailable` is true and
   the question is asked as normal. An install that recorded `single` before
   and now runs on 0.21.4 or later lands here too (`agentModeChosen` is
   false), and is moved to multiple the same silent way.
2. Ask once: **"Would you like to create and switch between agents
   (recommended), or use a single agent?"** Explain that multiple agents use
   the host's model access and approval rules, each with their own chats and
   memory. Creating an agent requires a gateway restart, which waits for runs
   to finish. The supported Hermes version uses the host's starting folder;
   per-agent folders are read-only.
3. Apply the selected branch in the default Hermes profile. The answer
   authorizes these configuration changes; do not ask for each command.

   **Multiple agents:** run the preflight and let it choose the branch. Never
   pick by reading a Hermes version number — the preflight probes the engine
   for the `hermes gateway migrate` command itself, because a version label
   can be wrong about a fork, a dev checkout or a half-applied update, and
   this decision ends in a write to a live gateway.

   ```bash
   hermes ocuclaw setup-preflight --json
   ```

   Use `--json` whenever you need a field. The bare command renders the same
   facts as a readable report, which is what you quote to the user.

   Read `migration.gate` and run exactly that branch:

   | `migration.gate` | what to do |
   |---|---|
   | `migration_already_multiplex` | record the choice only (step 3d) |
   | `migration_not_needed` | this host has one profile — step 3b |
   | `migration_via_flag_flip` | other profiles exist, none owns a gateway — step 3b |
   | `migration_via_gateway_migrate` | step 3c, the guided migration |
   | `migration_blocked_by_secondary_gateway` | step 3a, REFUSE first |

   If `migration.blockedBy` is `ownership_move_must_run_first`, stop here and
   do the ownership move lane in SKILL.md first. Folding the profiles together
   while OcuClaw still lives in a secondary one is refused by Hermes itself.

   **3a · Blocked (no migrate command, and a secondary owns a gateway).**
   Refuse the switch and say which agent is in the way, in plain words: it runs
   its own background service, and this version of Hermes cannot bring it in
   safely. An *installed but stopped* service counts — that is exactly what a
   later `hermes update` acts on. Run the exact commands the preflight printed
   under `blockers` — a `gateway stop` **and** a `gateway uninstall` for each —
   then re-run the preflight. Do not flip any flag while a blocker stands.

   **3b · Flag flip.** Bound the enrollment set FIRST, then flip the switch, in
   this order:

   ```bash
   hermes config set --force platforms.ocuclaw.extra.profile_allowlist '[]'
   hermes config set --force gateway.multiplex_profiles true
   hermes config set --force platforms.ocuclaw.extra.agent_mode multiple
   ```

   `platforms.ocuclaw.extra.profile_allowlist` is **OcuClaw's enrollment set**
   (#2940): which of the profiles this gateway serves the wearer's glasses may
   actually reach. It lists secondary agents only — the default agent carries
   the pairing and is always enrolled, so it is never listed. An empty list is
   a real answer ("just the default agent for now"), and the wearer adds agents
   from the phone's Agents list afterwards.

   Write the empty list even though it looks like a no-op. An **absent** key is
   not the same thing: OcuClaw reads absence as "the wearer has not chosen
   yet" and asks them to reselect on the phone. It never reads absence as
   "every profile" — that is the whole point of the set.

   **The recipe is the same on every supported engine.** In particular, do
   **not** set `gateway.multiplex_profile_allowlist` here, on any version.

   On Hermes 0.21.0 to 0.21.2 that key bounds the *served* set: absent, the
   multiplexer serves every live profile; present, it serves only the ones
   listed. Setting it would therefore stop Hermes running the cron jobs and
   channels of every profile the wearer has not enrolled — and enrollment is
   about what the *glasses* may reach, never about what Hermes runs. OcuClaw
   enforces the set itself, on this engine and on 0.21.3 alike, so bounding
   the served set buys nothing and costs the wearer their automations.

   If the host **already has** that key, the operator has deliberately bounded
   the served set, and a newly enrolled agent missing from it would be
   enrolled in OcuClaw yet never served. So OcuClaw keeps an existing key in
   step with the enrollment set on every create, add and remove. It only ever
   updates one; it never creates one. Hermes 0.21.3 deletes the key in config
   migration 42 to 43, so there is nothing to keep in step there. OcuClaw
   decides by probing the running engine, never by a version string.

   This branch is reached only when the preflight found no secondary gateway
   and no installed service; never run it past a blocker.

   **3c · Guided migration (`hermes gateway migrate` is present).** Preview,
   explain, confirm, apply. Write
   `platforms.ocuclaw.extra.profile_allowlist '[]'` before the migration so the
   folded-in profiles are served but not silently reachable; do not write
   `gateway.multiplex_profile_allowlist` on this engine — it is deleted
   there — and do not flip `gateway.multiplex_profiles` by hand; the migration
   owns it.

   Say this out loud to the user: the migration makes Hermes **serve** every
   profile on the host — their cron jobs and channels start running under the
   one gateway. Enrollment does not change that; it only decides which of them
   the glasses can talk to.

   ```bash
   hermes gateway migrate --multiplex --dry-run
   ```

   **Read the dry run's TEXT, never its exit code.** It exits 0 whether or not
   it found blockers. Look for a `✗ Blockers` heading: if it is there, nothing
   can be migrated until those are fixed — relay the blocker lines to the user
   and stop. `Steps:` is what would change; `Notices:` are consequences.

   The one case where the dry run exits non-zero is a host Hermes will not
   migrate at all — an s6 container or Windows. It prints `✗ <reason>` and no
   plan. That is "not supported here", not "blocked": there is nothing for the
   user to fix, so say multiple agents are unavailable on this host and stop.

   Translate the plan into plain words before asking. The user needs to know
   the one consequence that is not obvious: their other agents' **scheduled
   jobs and message connections start running in one process**, including for
   agents they never selected for the glasses. Say that it can be undone only
   when the plan's `migration.rollback` is set; when it is `null` this Hermes
   has no rollback, so never promise one. Ask once through `clarify`. On yes:

   ```bash
   hermes gateway migrate --multiplex --yes
   hermes config set --force platforms.ocuclaw.extra.agent_mode multiple
   ```

   `--yes` is required: without it the command waits at a terminal prompt this
   conversation does not have. The user's consent is the `clarify` answer.
   If they ask to undo it later, give `migration.rollback` exactly, and only
   when it is set (it is `hermes gateway migrate --standalone` on engines that
   still have that flag). Hermes 0.21.4 and later removed it: say there is no
   undo command.

   An OcuClaw enrollment set decides which agents reach the glasses. It does
   **not** limit whose cron jobs the wider gateway runs; do not imply it does.

   **3d · Record the choice.** Every branch above already ends with this line;
   3d exists so a branch that was interrupted before it can be resumed. It is
   idempotent — run it once, and only again if step 4's re-read shows the
   choice was never recorded.

   ```bash
   hermes config set --force platforms.ocuclaw.extra.agent_mode multiple
   ```

   **Restarts.** Step 5 below adds the restart this choice needs. Step 3c is
   the exception: `hermes gateway migrate` restarts the gateway itself, so do
   not restart again after it — verify instead.

   The enrollment-set note, the "why the bound comes first" note and the
   version note below belong to **step 3b**, the flag-flip branch on Hermes
   0.21.0 to 0.21.2. None of them applies to step 3c, where the migration owns
   the switch and the allowlist key no longer exists. The `--force` note
   applies to every branch, because every branch writes
   `platforms.ocuclaw.extra.agent_mode`.

   For the fresh default-only case the enrollment set is exactly `[default]`.
   If other Hermes profiles already exist, let the user choose which to make
   available; preserve existing entries and include the selected names. Do not
   automatically enroll unrelated profiles. New agents created through OcuClaw
   enroll themselves before activation.

   *Why the bound comes first:* with `gateway.multiplex_profiles` on and
   nothing bounding the served set, the gateway serves EVERY profile on the
   host, and "served" also means that profile's cron jobs tick inside this
   gateway. A profile that already runs its own gateway (a `watcher`, say)
   would then be served twice — a relay-token clash plus double cron. Writing
   the bound before the switch means there is never a restart window where
   "all" is in force.

   *Why `--force`, and what to expect:* without it, the
   `gateway.multiplex_profiles` line prints `⚠ 'gateway.multiplex_profiles'
   is not a recognized config key — it was saved anyway, but Hermes may not
   read it.` plus `Did you mean: gateway.multiplex_profile_allowlist`. The
   value IS saved and the gateway DOES read it (Hermes 0.21
   `gateway/config.py` honors `gateway.multiplex_profiles` written exactly
   this way); the notice is the CLI's key registry lagging the gateway.
   `--force` only skips that notice (the mirrored set and `agent_mode` keys
   are recognized and print nothing; `--force` on them is harmless). If the
   user ran the command without `--force` and saw the warning, tell them it is
   expected and nothing needs redoing — do NOT "fix" it by switching to the
   suggested key.

   *Version note — but never select on it.* Step 3b's **OcuClaw** line is
   correct on every supported engine; only its mirror line is version-shaped.
   Hermes 0.21.3 retires `gateway.multiplex_profile_allowlist` (config
   migration 42 to 43 deletes it) and its multiplexer serves every live profile
   on the host — which is exactly why OcuClaw now keeps its own enrollment set
   rather than borrowing the gateway's. **Do not compare version strings to
   decide** — `hermes ocuclaw setup-preflight` probes the engine for the
   migrate command itself and hands you the branch in `migration.gate`. Read
   `migration.capability.evidence` if you want to know which probe answered.
   On a 0.21.3 host the wider gateway still runs cron and other channels for
   profiles nobody selected. An OcuClaw enrollment set decides which agents
   reach the glasses; it is not a served-profile list and not a cron filter.

   **Single agent** (only where `singleAgentAvailable` is true): set
   `gateway.multiplex_profiles` to `false` and
   `platforms.ocuclaw.extra.agent_mode` to `single` (same `--force` note).
   Explain that creation and switching are unavailable in this mode, and that
   the phone's "+" stays grey by choice. Retain any saved enrollment set.

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
- **A malformed bound fails safe (0.21.0 to 0.21.2):** a
  `gateway.multiplex_profile_allowlist` that is not a list serves the DEFAULT
  profile only (with a warning); individual entries that are not valid profile
  names are skipped. `default` is always served and never needs listing. An
  ABSENT value is the dangerous shape — it means "serve every profile", which
  is also what Hermes 0.21.3 does unconditionally.
- **OcuClaw's enrollment set inverts that rule.**
  `platforms.ocuclaw.extra.profile_allowlist` is OcuClaw's own, and an absent
  or malformed value NEVER means "every agent": it means the wearer has not
  chosen, so only the default agent is reachable and the phone asks them to
  pick. An empty list is a real, deliberate answer. The set bounds what the
  glasses may reach — every agent menu, transcript, session, setting and turn —
  and bounds nothing else: which profiles' cron jobs and channels the
  multiplexer runs is Hermes's business, not this key's.
- **A secondary profile that enables a port-binding platform is not served.**
  The default profile owns the one shared listener; a secondary profile whose
  config enables OcuClaw (or any port-binding platform) is SKIPPED at gateway
  start with a warning naming the profile, and the rest of the gateway comes
  up. OcuClaw therefore stays configured on the default profile only. (The
  startup failure that IS fatal is a secondary profile with an `open`
  dm/group policy and no allow-all flag.)

OcuClaw's authenticated shared transport is supported by Hermes 0.21. A routed
secondary turn is authorized by the transport it arrived on, so there is no
per-profile allow line to write, on any engine, in any branch above.

**Setup never writes an authorization key.** Do not set
`OCUCLAW_ALLOWED_USERS` or `OCUCLAW_ALLOW_ALL_USERS`, do not suggest them, and
do not introduce any other user-authorization bypass to enable multiple agents.
Transport authentication IS the grant. If a secondary turn is rejected, that is
a broken install or a lost transport reference, and an allow line would hide it
rather than fix it: use the troubleshooting branch to verify the bundle
version, source provenance and served profile. `hermes ocuclaw doctor` names
the fault as `transport_provenance_missing`. The enrollment set selects agents;
it is not a sender-auth list.
