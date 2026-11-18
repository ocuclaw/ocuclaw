const { OCUCLAW_SETUP_OPERATIONS } = require("./setup-controller.cjs");
const { createFirstUseCommand } = require("./first-use-command.cjs");
const { createOptionalCredentialCommand } = require("./optional-credential-command.cjs");
const { createEvenAiSetupCommand } = require("./even-ai-setup-command.cjs");
const { createOptionalDiagnosticsCommand } = require("./optional-diagnostics-command.cjs");
const { CLOUDWAYS_VERBS, renderCloudwaysOutput, runCloudwaysVerb } = require("./cloudways-command.cjs");
const { runCloudwaysSetup } = require("./cloudways-setup.cjs");
const { capabilityConsentLine } = require("./capability-consent.cjs");
const { doctorExitCode, renderDoctorText } = require("./doctor-text.cjs");
const { withDoctorCards } = require("./overview-tool.cjs");
const process = require("node:process");

async function openSetupLook(options     ) {
  try {
    const { resolveLook } = await import("./speck/model.js");
    const { openLook } = await import("./speck/live.js");
    return await openLook(resolveLook(options.look, process.env), process.stdin, process.stdout, { env: process.env });
  } catch (_) {
    return null;
  }
}

function registerOcuClawSetupCli(api     , controller     , pair      = null, cardSetup      = null) {
  if (!api || typeof api.registerCli !== "function") return;
  if (typeof controller !== "function") {
    throw new Error("registerOcuClawSetupCli requires the setup controller");
  }

  api.registerCli(
    async ({ program }     ) => {
      const ocuclaw = program
        .command("ocuclaw")
        .description("Inspect OcuClaw setup and runtime state");
      ocuclaw.command("credential <capability>")
        .description("Privately save soniox, even-ai or typesafe credentials in this host terminal")
        .option("--replace", "Deliberately replace this capability's existing credential")
        .action(async (capability     , options     ) => {
          const result = await createOptionalCredentialCommand(api)(capability, options);
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          process.exitCode = result.exitCode;
        });
      const evenAi = ocuclaw.command("even-ai <action>")
        .description("Inspect, enable, propose a private route, or verify Even AI: status|enable|route|verify")
        .action(async (action     ) => {
          const result = await createEvenAiSetupCommand(api, controller)(action);
          evenAi.configureOutput().writeOut(`${JSON.stringify(result.report, null, 2)}\n`);
          process.exitCode = result.exitCode;
        });
      const diagnostics = ocuclaw.command("diagnostics [permission] [choice]")
        .description("Inspect diagnostics or change one permission: status|access allow|deny|handoff allow|deny")
        .action(async (permission     , choice     ) => {
          const result = await createOptionalDiagnosticsCommand(api)(permission, choice);
          diagnostics.configureOutput().writeOut(`${JSON.stringify(result, null, 2)}\n`);
          process.exitCode = result.exitCode;
        });
      ocuclaw.command("first-use")
        .description("Resume this installation's first phone reply and confirm it appeared on G2")
        .option("--session <key>", "Bind the initial checkpoint to this phone conversation")
        .option("--retry", "Rearm unfinished first-use for a fresh phone reply; preserve completed setup")

        .option("--first-use-wait <seconds>", "Seconds to wait for the first phone reply (default 600)")
        .option("--test-input", "Label an automated terminal exercise; never record real wearer acceptance")
        .action(async (options     ) => {
          const seconds = Number.parseInt(String(options?.firstUseWait ?? ""), 10);
          const result = await createFirstUseCommand(api)({
            ...options,
            ...(Number.isInteger(seconds) && seconds >= 0 ? { waitMs: seconds * 1000 } : {}),
          });
          process.exitCode = result.exitCode;
        });
      for (const operation of OCUCLAW_SETUP_OPERATIONS) {
        if (operation === "doctor") {

          const doctorCommand = ocuclaw
            .command("doctor")
            .description("Check OcuClaw's setup and say what to fix (--json for the full report)")
            .option("--json", "Print the full redacted report as JSON instead of text");
          doctorCommand.action(async function writeDoctorResult(options     ) {
            const output = doctorCommand.configureOutput();
            const own = await controller("doctor", { surface: "cli" });

            const report = options?.json ? await withDoctorCards(own, cardSetup) : own;
            if (options?.json) {
              output.writeOut(`${JSON.stringify(report, null, 2)}\n`);
              const consentLine = capabilityConsentLine(report);
              if (consentLine) output.writeErr(`${consentLine}\n`);
            } else {
              output.writeOut(renderDoctorText(report));
            }
            process.exitCode = doctorExitCode(report);
          });
          continue;
        }
        const operationCommand = ocuclaw
          .command(operation)
          .description(`Print the redacted OcuClaw ${operation} result as JSON`);
        operationCommand.action(async function writeSetupResult() {
            const output = operationCommand.configureOutput();
            const report = await controller(operation, { surface: "cli" });
            output.writeOut(`${JSON.stringify(report, null, 2)}\n`);

            const consentLine = capabilityConsentLine(report);
            if (consentLine) output.writeErr(`${consentLine}\n`);
          });
      }

      const cloudways = ocuclaw
        .command("cloudways")
        .description("Manage the userspace Tailscale daemon on a Cloudways managed host");
      const CLOUDWAYS_DESCRIPTIONS      = {
        detect: "Report whether this host is a Cloudways Managed AI Agents container",
        install: "Install the pinned userspace Tailscale binaries, state and host receipt",
        enroll: "Run tailscale up once and print the authorization link",
        status: "Report the daemon, receipt, supervisor and any foreign daemon",
        retry: "Observe the same enrollment and recover its authorization link",
        enable: "Resume supervision and start the daemon now",
        disable: "Pause supervision and stop the daemon",
        rollback: "Remove what this install created; keeps the Tailscale identity",
      };
      for (const verb of CLOUDWAYS_VERBS) {
        const verbCommand = cloudways
          .command(verb)
          .description(CLOUDWAYS_DESCRIPTIONS[verb])
          .option("--json", "Print the report as JSON instead of text");
        if (verb === "status") {
          verbCommand.option("--wait <seconds>", "Wait up to this many seconds for a settled daemon state");
        }
        if (verb === "enroll" || verb === "retry") {
          verbCommand.option("--hostname <name>", "Enroll a fresh identity under this tailnet node name");
          verbCommand.option("--wait <seconds>", "Total seconds to wait for the authorization link");
        }
        if (verb === "rollback") {
          verbCommand.option("--yes", "Confirm removal; without it rollback refuses");
          verbCommand.option("--purge-identity", "Also delete the Tailscale identity in ~/.tailscale");
        }
        verbCommand.action(async (options     ) => {
          const result = await runCloudwaysVerb(verb, options || {});
          verbCommand.configureOutput().writeOut(renderCloudwaysOutput(result, options || {}));
          process.exitCode = result.exitCode;
        });
      }

      cloudways
        .command("setup")
        .description("Run the whole Cloudways setup here: Tailscale, the private route, pairing and the first message")
        .option("--yes", "Answer both consent questions with yes; for automation. Never confirms G2")
        .option("--details", "Print the exact settings and commands behind each consent question")
        .option("--wait <seconds>", "Seconds to wait for tailnet authorization (default 600)")
        .option("--first-use-wait <seconds>", "Seconds to wait for the first phone reply (default 600)")
        .option("--no-pair", "Stop after the private route instead of pairing a phone")
        .option("--no-first-use", "Stop after pairing instead of confirming the first message")
        .option("--test-input", "Label an automated terminal exercise; never record real wearer acceptance")
        .option("--light-terminal", "Does nothing; kept so older commands still run")
        .option("--hostname <name>", "Enroll a fresh identity under this tailnet node name")
        .option("--look <name>", "How setup draws itself: speck (the default in the dashboard terminal) or plain")
        .action(async (options     ) => {
          const deps      = { api, controller, pair, firstUse: createFirstUseCommand(api) };

          const look      = await openSetupLook(options || {});
          let result      = null;
          try {
            result = await runCloudwaysSetup(options || {}, deps, look ? { ...look.io, env: process.env } : {});
          } finally {
            if (look) await look.close(result ? result.exitCode : 1);
          }
          process.exitCode = result.exitCode;
        });
      if (typeof pair === "function") {
        ocuclaw.command("pair")
          .description("Pair a phone directly in this terminal by typing the phone code OcuClaw shows, then four safety words")
          .option("--light-terminal", "Does nothing; kept so older commands still run")
          .option("--new-key", "Make a new relay key first: every paired phone is disconnected and must pair again")
          .action(async (options     ) => {
            const result = await pair(options);
            process.exitCode = result.exitCode;
          });
      }
    },
    {
      descriptors: [
        {
          name: "ocuclaw",
          description: "Inspect OcuClaw setup and runtime state",
          hasSubcommands: true,
        },
      ],
    },
  );
}

module.exports = { registerOcuClawSetupCli };
