const CARD_STUDIO_TOOLS = new Set([
  "ask_glasses_card",
  "write_glasses_card",
  "glasses_card_command",
  "edit_glasses_card",
  "look_glasses_card",
  "glasses_card_draft",
  "save_glasses_card",
  "request_card_mcp_write",
  "request_host_command",
  "request_card_setup",
]);

function note(service     , call     ) {
  try {
    if (typeof service?.noteCardStudioToolCall === "function") service.noteCardStudioToolCall(call);
  } catch {

  }
}

function recordCardStudioCall(service     , tool        , sessionKey               , run           ) {
  if (!sessionKey || !CARD_STUDIO_TOOLS.has(tool)) return run();
  return (async () => {
    const startedAtMs = Date.now();
    let result     ;
    let threw = false;
    try {
      result = await run();
      return result;
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      note(service, { sessionKey, tool, args: (run       ).args, startedAtMs, endedAtMs: Date.now(), result, threw });
    }
  })();
}

function wrapTool(service     , tool     , sessionKey               ) {
  if (!tool || typeof tool !== "object" || typeof tool.execute !== "function" || !CARD_STUDIO_TOOLS.has(tool.name)) return tool;
  const execute = tool.execute;
  return {
    ...tool,
    execute(toolCallId     , params     , ...rest       ) {
      const run      = () => execute.call(tool, toolCallId, params, ...rest);
      run.args = params;
      return recordCardStudioCall(service, tool.name, sessionKey, run);
    },
  };
}

function cardStudioRecordingApi(api     , service     , sessionKeyOf                             ) {
  const registerTool = (factory     , opts      ) => api.registerTool(
    typeof factory === "function"
      ? (ctx     , ...rest       ) => {
        const tool = factory(ctx, ...rest);
        if (!tool || typeof tool !== "object" || !CARD_STUDIO_TOOLS.has(tool.name)) return tool;
        let sessionKey                = null;
        try { sessionKey = sessionKeyOf(ctx); } catch { sessionKey = null; }
        return wrapTool(service, tool, typeof sessionKey === "string" && sessionKey ? sessionKey : null);
      }
      : factory,
    opts,
  );
  return new Proxy(api, {
    get(target     , prop     ) {
      if (prop === "registerTool") return registerTool;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function cardStudioRecordingMethod(service     , tool        , method                       ,
  sessionKeyOf                                 ) {
  return (request     ) => {
    let sessionKey                = null;
    try { sessionKey = sessionKeyOf(request); } catch { sessionKey = null; }
    const run      = () => method(request);
    run.args = request && typeof request === "object" ? request.params : undefined;
    return recordCardStudioCall(service, tool, sessionKey, run);
  };
}

module.exports = { CARD_STUDIO_TOOLS, recordCardStudioCall, cardStudioRecordingApi, cardStudioRecordingMethod };
