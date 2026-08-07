const { parentPort } = require("node:worker_threads");
const { createRelayWorkerTransport } = require("./relay-worker-transport.cjs");
const { isKnownBackendKind, setActiveBackendKind, } = require("../gateway/backend-contract.cjs");

if (!parentPort) {
  throw new Error("relay worker entry requires parentPort");
}

function formatLogArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function postWorkerLog(level, args) {
  parentPort.postMessage({ kind: "worker.log", level, message: formatLogArgs(args) });
}

const transport = createRelayWorkerTransport({
  postToMain(message) {
    parentPort.postMessage(message);
  },

  logger: {
    info(...args) { postWorkerLog("info", args); },
    warn(...args) { postWorkerLog("warn", args); },
    error(...args) { postWorkerLog("error", args); },
    debug(...args) { postWorkerLog("debug", args); },
  },
});

parentPort.on("message", async (message) => {
  try {
    if (message && message.kind === "manifest") {

      if (isKnownBackendKind(message.backendKind)) {
        setActiveBackendKind(message.backendKind);
      }
      await transport.start(message);
      return;
    }
    if (message && message.kind === "shutdown") {
      await transport.close();
      parentPort.postMessage({ kind: "worker.closed" });
      return;
    }
    transport.handleMainMessage(message);
  } catch (err) {
    parentPort.postMessage({
      kind: "worker.error",
      message: err && err.message ? err.message : String(err),
    });
  }
});

module.exports = {};
