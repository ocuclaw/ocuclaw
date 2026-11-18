const process = require("node:process");
const { planOptionalSetupActivation } = require("./optional-activation-policy.cjs");
const { saveOptionalCredential } = require("./optional-credential-store.cjs");

const FIELDS      = { soniox: "sonioxApiKey", "even-ai": "evenAiToken", typesafe: "typesafeApiKey" };

const GUIDANCE      = {
  soniox: "Soniox live transcription: open https://console.soniox.com, choose your project, then API keys. Enable real-time speech-to-text, temporary API keys and model listing. Model sign-in does not provide Soniox access.\n",
  "even-ai": "Enter the private Even AI token for this runtime. This is separate from the phone Relay Credential.\n",

  typesafe: "LiveUI Jev, the Bot Screen's Jev mode and Jev in program cards use TypeSafe: open https://typesafe.ai, sign in and create an API key. Saving the key is not a consent: each feature keeps its own switch on the phone.\n",
};

function readPrivateCredential(input      = process.stdin, output      = process.stderr)      {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return Promise.resolve({ state: "terminal_required" });
  }
  return new Promise((resolve) => {
    let value = "";
    let finished = false;
    const wasRaw = input.isRaw === true;

    const wasFlowing = input.readableFlowing === true;
    const finish = (result     ) => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onEnd);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      value = "";
      output.write("\n");
      resolve(result);
    };
    const onEnd = () => finish({ state: "cancelled" });
    const onData = (chunk     ) => {
      for (const character of String(chunk)) {
        if (character === "\u0003" || character === "\u0004" || character === "\u001b") {
          finish({ state: "cancelled" });
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value ? { state: "entered", value } : { state: "cancelled" });
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (/^[\x21-\x7e]$/.test(character) && value.length < 4096) {
          value += character;
        } else {
          finish({ state: "invalid_input" });
          return;
        }
      }
    };
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    output.write("Private credential (hidden; Enter empty or Ctrl-C cancels): ");
    input.resume();
  });
}

function pluginConfig(document     , create      = false)      {
  let node = document;
  for (const key of ["plugins", "entries", "ocuclaw", "config"]) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("ambiguous_config");
    if (node[key] === undefined && create) node[key] = {};
    if (node[key] === undefined) return {};
    node = node[key];
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("ambiguous_config");
  return node;
}

function createOptionalCredentialCommand(api     , dependencies      = {}) {
  const write = dependencies.write || ((text     ) => process.stderr.write(text));
  const read = dependencies.readPrivate || (() => readPrivateCredential());
  return async (capability     , options      = {}) => {
    const field = FIELDS[capability];
    if (!Object.prototype.hasOwnProperty.call(FIELDS, capability)) {
      return { exitCode: 2, status: "invalid_capability" };
    }
    const config = api?.runtime?.config;
    if (typeof config?.current !== "function" || typeof config?.mutateConfigFile !== "function") {
      return { exitCode: 1, status: "unsupported_host", instruction: "Use a supported OpenClaw host with private configuration input. Never paste credentials into chat." };
    }
    let previous     ;
    let activationPlan     ;
    try {
      const observed = config.current();
      previous = pluginConfig(observed)[field];
      activationPlan = planOptionalSetupActivation(observed, api?.runtime?.version);
      if (previous !== undefined && typeof previous !== "string") throw new Error("ambiguous_config");
    } catch (_) {
      return { exitCode: 1, status: "configuration_unknown" };
    }
    if (previous && options.replace !== true) {
      return { exitCode: 0, status: "preserved", present: true,
        instruction: `Existing credential preserved. To deliberately replace it, run openclaw ocuclaw credential ${capability} --replace.` };
    }
    write(GUIDANCE[capability]);
    let entered     ;
    try { entered = await read(); } catch (_) { return { exitCode: 1, status: "input_unavailable" }; }
    if (entered?.state !== "entered") {
      const status = ["cancelled", "terminal_required", "invalid_input"].includes(entered?.state) ? entered.state : "input_unavailable";
      return { exitCode: status === "cancelled" ? 0 : 1, status, present: Boolean(previous) };
    }
    let secret = entered.value;
    entered.value = "";
    if (typeof secret !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(secret)) {
      return { exitCode: 1, status: "invalid_input", present: Boolean(previous) };
    }
    try {
      const saved = await saveOptionalCredential(api, field, secret, { previous, activationPlan });
      if (!saved) {
        return { exitCode: 1, status: "save_unconfirmed", instruction: "Read current setup state before retrying. Activation and speech/request verification are not confirmed." };
      }
      return { exitCode: 0, status: "saved", present: true, activation: "unknown", verification: "not_tested",
        activationPolicy: activationPlan.reason,
        instruction: `Saved privately. ${activationPlan.action} Return to this capability in phone Settings and test it. Saving is not a successful test.` };
    } catch (_) {

      return { exitCode: 1, status: "save_unconfirmed", instruction: "The host did not confirm the save. Read current setup state before retrying; existing pairing and core setup were not requested to change." };
    } finally {
      secret = "";
    }
  };
}

module.exports = { readPrivateCredential, createOptionalCredentialCommand };
