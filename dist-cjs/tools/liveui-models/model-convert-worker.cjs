const { parentPort, workerData } = require("node:worker_threads");
const { convertModel } = require("./model-convert.cjs");

const WORKER_MARKER = "ocuclawModelConvertWorker";

if (parentPort && workerData && workerData[WORKER_MARKER]) {
  const port = parentPort;
  port.once("message", async (message     ) => {
    const result = await convertModel(message.input, message.limits || {});
    port.postMessage(result, result.ok ? [result.mesh.buffer               ] : []);
  });
}

module.exports = {  };
