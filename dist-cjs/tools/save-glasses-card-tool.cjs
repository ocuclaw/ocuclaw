const { randomUUID } = require("node:crypto");
const { PROGRAM_CARD_SAVE_REQUEST_TIMEOUT_MS, awaitProgramCardSaveResult, resolveProgramCardSaveRequest } = require("./program-card-saves.cjs");
const { PROGRAM_CARD_DESCRIPTION_MAX, PROGRAM_CARD_NAME_MAX } = require("./glasses-ui-library.cjs");

const SAVE_GLASSES_CARD_TOOL_NAME = "save_glasses_card";

const SAVE_GLASSES_CARD_TOOL_DESCRIPTION = [
  "Save the card that is open on the wearer's glasses to the LiveUI Library, with its current state, so it reopens from the Library later where the wearer left it.",
  "Use it when the wearer asks to keep or save the card. It does not write a new card.",
  "Optional name: the Library row's name (the card's own name when omitted).",
  "Optional mode, for a card the Library already holds: revision (keep the old version as a revision), replace (overwrite the current revision) or new (save a separate card).",
  "Optional description: one line on what the card does, shown in the Library and used to pick its icon (the one it was written with when omitted).",
].join("\n");

const saveGlassesCardParametersSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      maxLength: PROGRAM_CARD_NAME_MAX,
      description: "Name for the saved card in the Library.",
    },
    mode: {
      type: "string",
      description: "revision, replace or new. Only matters when the card is already saved.",
    },
    description: {
      type: "string",
      maxLength: PROGRAM_CARD_DESCRIPTION_MAX,
      description: "One line on what the card does, such as: Keeps darts scores for two players.",
    },
  },
  additionalProperties: false,
};

function textResult(text        ) {
  return { content: [{ type: "text", text }] };
}

function normalizeSaveMode(value     ) {
  if (typeof value !== "string") return undefined;
  const mode = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (mode === "revision" || mode === "new_revision") return "revision";
  if (mode === "replace" || mode === "overwrite") return "replace";
  if (mode === "new" || mode === "new_card" || mode === "copy") return "new";
  return undefined;
}

function createSaveGlassesCardHandler(deps      = {}) {
  const newRequestId = typeof deps.newRequestId === "function"
    ? deps.newRequestId
    : () => `pcs-${randomUUID().slice(0, 8)}`;

  async function saveGlassesCard(params      = {}) {
    const name = params && typeof params.name === "string" && params.name.trim()
      ? params.name.trim().slice(0, PROGRAM_CARD_NAME_MAX)
      : undefined;
    const mode = normalizeSaveMode(params && params.mode);
    if (typeof deps.isAppConnected === "function" && !deps.isAppConnected()) {
      return textResult("The glasses app is not connected, so the card was not saved.");
    }
    const requestId = newRequestId();
    const waiting = awaitProgramCardSaveResult(requestId, {
      timeoutMs: Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : PROGRAM_CARD_SAVE_REQUEST_TIMEOUT_MS,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
      scope: deps.scope,

      description: params && params.description,
    });
    try {
      deps.broadcastSaveRequest({ requestId, ...(name ? { name } : {}), ...(mode ? { mode } : {}) });
    } catch (err     ) {
      resolveProgramCardSaveRequest(requestId, { status: "unavailable" }, deps.scope);
      await waiting;
      return textResult(
        `The card was not saved: the OcuClaw relay is not running (${err && err.message ? err.message : err}).`,
      );
    }
    const result      = await waiting;
    if (result && result.status === "saved") {
      const revision = Number.isSafeInteger(result.revision) && result.revision > 1
        ? ` as revision ${result.revision}`
        : "";
      return textResult(`Saved "${result.name}" to the Library${revision}.`);
    }
    if (result && result.status === "timeout") {
      return textResult("The glasses did not answer, so the card was not saved.");
    }
    const code = result && typeof result.code === "string" ? result.code : "save_failed";
    if (code === "no_card_open") {
      return textResult("No card is open on the glasses, so nothing was saved (no_card_open).");
    }
    return textResult(`The card was not saved (${code}).`);
  }

  return { saveGlassesCard };
}

function registerSaveGlassesCardTool(api     , service     ) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerSaveGlassesCardTool requires api.registerTool");
  }
  if (!service) {
    throw new Error("registerSaveGlassesCardTool requires the OcuClaw relay service");
  }
  const handler = createSaveGlassesCardHandler({
    broadcastSaveRequest: (params     ) => service.broadcastProgramCardSaveRequest(params),
    isAppConnected: () =>
      typeof service.hasConnectedAppClient === "function" ? service.hasConnectedAppClient() : true,
  });
  api.registerTool(
    () => ({
      name: SAVE_GLASSES_CARD_TOOL_NAME,
      description: SAVE_GLASSES_CARD_TOOL_DESCRIPTION,
      parameters: saveGlassesCardParametersSchema,
      async execute(_toolCallId     , params     ) {
        return handler.saveGlassesCard(params);
      },
    }),
    { name: SAVE_GLASSES_CARD_TOOL_NAME },
  );
}

module.exports = { SAVE_GLASSES_CARD_TOOL_NAME, SAVE_GLASSES_CARD_TOOL_DESCRIPTION, saveGlassesCardParametersSchema, createSaveGlassesCardHandler, registerSaveGlassesCardTool };
