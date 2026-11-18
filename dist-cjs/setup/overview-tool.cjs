const { OCUCLAW_SETUP_OPERATIONS } = require("./setup-controller.cjs");
const { FIRST_USE_TOOL_OPERATIONS, FIRST_USE_WAIT_MAX_MS, validateFirstUseParams } = require("./first-use.cjs");
const { MAX_RELAY_PORT, MIN_RELAY_PORT, SET_RELAY_PORT_OPERATION, validateRelayPortMutationParams } = require("./relay-port-mutation.cjs");
const { PROVISION_RELAY_CREDENTIAL_OPERATION, validateProvisionRelayCredentialParams } = require("./relay-credential-provision.cjs");
const { SETUP_CHAT_OPERATIONS } = require("./setup-approval-store.cjs");
const { validateSetupChatParams } = require("./setup-chat-approvals.cjs");
const { SETUP_NEXT_OPERATION, SETUP_NEXT_CHOICE_MAX, validateSetupNextParams } = require("./setup-next.cjs");

const OCUCLAW_SETUP_TOOL_OPERATIONS = Object.freeze([
  SETUP_NEXT_OPERATION,
  ...OCUCLAW_SETUP_OPERATIONS,
  ...FIRST_USE_TOOL_OPERATIONS,
  SET_RELAY_PORT_OPERATION,
  PROVISION_RELAY_CREDENTIAL_OPERATION,
  ...SETUP_CHAT_OPERATIONS,
]);

const ocuClawSetupParametersSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: [...OCUCLAW_SETUP_TOOL_OPERATIONS] },
    binding: { type: "string", pattern: "^[a-f0-9]{64}$" },
    answer: { type: "string", enum: ["yes", "no"] },

    code: { type: "string", minLength: 1, maxLength: 64 },

    choice: { type: "string", minLength: 1, maxLength: SETUP_NEXT_CHOICE_MAX },
    timeoutMs: { type: "integer", minimum: 0, maximum: FIRST_USE_WAIT_MAX_MS },
    expectedCurrentPort: {
      type: "integer",
      minimum: MIN_RELAY_PORT,
      maximum: MAX_RELAY_PORT,
    },
    newPort: {
      type: "integer",
      minimum: MIN_RELAY_PORT,
      maximum: MAX_RELAY_PORT,
    },
  },
  required: ["operation"],
  additionalProperties: false,
};

const OPERATIONS = new Set(OCUCLAW_SETUP_OPERATIONS);

async function withDoctorCards(report     , cardSetup     ) {
  if (typeof cardSetup !== "function" || !report || typeof report !== "object" || Array.isArray(report)) return report;
  try {
    const cards = await cardSetup();
    return cards && typeof cards === "object" ? { ...report, cards } : report;
  } catch (_) {
    return report;
  }
}

function registerOcuClawSetupTool(
  api     ,
  controller     ,
  setRelayPort     ,
  provisionRelayCredential     ,
  firstUse      = null,
  onContext      = null,
  chatApprovals      = null,
  setupNext      = null,

  cardSetup      = null,
) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerOcuClawSetupTool requires api.registerTool");
  }
  if (typeof controller !== "function") {
    throw new Error("registerOcuClawSetupTool requires the setup controller");
  }

  api.registerTool(
    (ctx     ) => ({
      name: "ocuclaw_setup",
      description:
        "Set up OcuClaw from chat with operation next: say its say lines word for word, collect the one input it asks for (pass a choice id as choice, a phone code to pair_with_phone_code), and follow its then. Also: inspect OcuClaw setup; request approved host configuration or tool-driven first use. first_use_begin arms a relay-run test and returns lines to say: say them as your final message and end your turn; the relay wakes this chat with the result. first_use_confirm records only the wearer's explicit answer about the bound reply; never infer it from machine health or a setup notification.",
      parameters: ocuClawSetupParametersSchema,
      async execute(_toolCallId     , params     , signal      = null) {
        if (typeof onContext === "function") {
          try { onContext(ctx ?? null, params?.operation ?? null); } catch (_) {  }
        }
        if (FIRST_USE_TOOL_OPERATIONS.includes(params?.operation)) {
          validateFirstUseParams(params);
          const result = typeof firstUse === "function" ? await firstUse(params, signal, ctx ?? null)
            : { status: "unavailable", reason: "unsupported-host" };
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        if (params?.operation === SETUP_NEXT_OPERATION) {
          validateSetupNextParams(params);
          if (typeof setupNext !== "function") {
            const err      = new Error("unsupported_host: chat setup is unavailable");
            err.code = "unsupported_host";
            throw err;
          }
          const result = await setupNext(params, signal, ctx ?? null);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        if ((SETUP_CHAT_OPERATIONS                     ).includes(params?.operation)) {
          validateSetupChatParams(params);
          if (typeof chatApprovals !== "function") {
            const err      = new Error("unsupported_host: chat setup approvals are unavailable");
            err.code = "unsupported_host";
            throw err;
          }
          const receipt = await chatApprovals(params, signal);
          return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
        }
        if (params?.operation === PROVISION_RELAY_CREDENTIAL_OPERATION) {
          validateProvisionRelayCredentialParams(params);
          if (typeof provisionRelayCredential !== "function") {
            const err      = new Error(
              "unsupported_host: relay-credential provisioning is unavailable",
            );
            err.code = "unsupported_host";
            throw err;
          }
          const receipt = await provisionRelayCredential(params);
          return {
            content: [{ type: "text", text: JSON.stringify(receipt) }],
          };
        }
        if (params?.operation === SET_RELAY_PORT_OPERATION) {
          validateRelayPortMutationParams(params);
          if (typeof setRelayPort !== "function") {
            const err      = new Error("unsupported_host: relay-port mutation is unavailable");
            err.code = "unsupported_host";
            throw err;
          }
          const receipt = await setRelayPort(params);
          return {
            content: [{ type: "text", text: JSON.stringify(receipt) }],
          };
        }
        if (
          !params ||
          typeof params !== "object" ||
          Array.isArray(params) ||
          !OPERATIONS.has(params.operation) ||
          Object.keys(params).some((key) => key !== "operation")
        ) {
          const err      = new Error(
            `invalid_input: operation must be one of ${OCUCLAW_SETUP_TOOL_OPERATIONS.join(", ")}`,
          );
          err.code = "invalid_input";
          throw err;
        }
        const result = await controller(params.operation, { surface: "tool" });
        const told = params.operation === "doctor" ? await withDoctorCards(result, cardSetup) : result;
        return { content: [{ type: "text", text: JSON.stringify(told) }] };
      },
    }),

    { name: "ocuclaw_setup" },
  );
}

module.exports = { OCUCLAW_SETUP_TOOL_OPERATIONS, ocuClawSetupParametersSchema, withDoctorCards, registerOcuClawSetupTool };
