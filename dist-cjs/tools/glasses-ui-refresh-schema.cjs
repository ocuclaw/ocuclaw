const LIVEUI_REFRESH_ITEM_TEMPLATE_SCHEMA = {
  type: "object",
  required: ["label"],
  properties: {
    label: { type: "string" },
    body: { type: "string" },
  },
  additionalProperties: false,
};

const httpRecipeSchema = {
  type: "object",
  required: ["kind", "url"],
  properties: {
    kind: { const: "http" },
    url: { type: "string" },
    method: { type: "string", enum: ["GET", "POST"] },

    headers: { type: "object" },
    body: { type: "string" },
    jsonPath: { type: "string" },
    timeoutMs: { type: "integer" },
    outputCapBytes: { type: "integer" },
  },
  additionalProperties: false,
};

const llmRecipeSchema = {
  type: "object",
  required: ["kind", "prompt"],
  properties: {
    kind: { const: "llm" },

    prompt: { type: "string", maxLength: 4096 },
    systemPrompt: { type: "string", maxLength: 4096 },
    model: { type: "string" },
    maxOutputTokens: { type: "integer" },
  },
  additionalProperties: false,
};

const systemStatsRecipeSchema = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { const: "system-stats" },
    sampleWindowMs: { type: "integer", minimum: 50, maximum: 1000 },
  },
  additionalProperties: false,
};

const refreshSchemaForToolParams = {
  type: "object",
  description: "Optional periodic refresh policy; turns this surface into a live-updating one.",
  required: ["recipe", "intervalMs"],
  properties: {
    intervalMs: { type: "integer", minimum: 1000, maximum: 3_600_000 },
    maxDurationMs: { type: "integer", minimum: 10_000, maximum: 7_200_000 },
    maxConsecutiveFailures: { type: "integer", minimum: 1, maximum: 100 },
    onError: { type: "string", enum: ["keep_last", "show_error", "stop"] },
    targets: {
      type: "object",
      properties: {
        body: { type: "string" },
        items: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              LIVEUI_REFRESH_ITEM_TEMPLATE_SCHEMA,
            ],
          },
        },
        itemsFromPath: {
          type: "string",
          description: "Bounded array path ending in []; use with itemTemplate on an existing list kind.",
        },
        itemTemplate: LIVEUI_REFRESH_ITEM_TEMPLATE_SCHEMA,
        slot: {
          type: "string",
          pattern: "^[a-z][a-z0-9_]{0,31}$",
          description: "Declared Template slot to fill from this recipe tick.",
        },
        path: {
          type: "string",
          description: "Template-expression path read from the recipe output for targets.slot.",
        },
      },
      additionalProperties: false,
    },
    recipe: {
      oneOf: [httpRecipeSchema, llmRecipeSchema, systemStatsRecipeSchema],
    },
  },
  additionalProperties: false,
};

module.exports = { LIVEUI_REFRESH_ITEM_TEMPLATE_SCHEMA, refreshSchemaForToolParams };
