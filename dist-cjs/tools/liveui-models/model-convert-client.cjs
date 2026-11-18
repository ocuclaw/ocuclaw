const { Worker } = require("node:worker_threads");
const { MODEL_CODES, MODEL_CONVERT_TIMEOUT_MS } = require("./model-limits.cjs");

const WORKER_MARKER = "ocuclawModelConvertWorker";

const WORKER_HEAP_MB = 1024;

function defaultWorkerFactory() {
  return new Worker(new URL("./model-convert-worker.cjs", `file://${__filename}`), {
    workerData: { [WORKER_MARKER]: true },
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });
}

let queue                   = Promise.resolve();

function runOne(request                     , options                     )               {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? MODEL_CONVERT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let worker     ;
    let settled = false;
    let timer                                       = null;
    const signal = options.signal;
    const onAbort = () => fail(MODEL_CODES.unreadable, "cancelled");
    const finish = (result     ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (worker) worker.terminate().catch(() => {});
      const ms = Date.now() - started;
      const out = { ...result, ms: result.ms ?? ms };
      if (options.trace) {
        try {
          options.trace("liveui_v2_model_convert", {
            modelFormat: out.format ?? null,
            trianglesIn: out.ok ? out.trianglesIn : null,
            trianglesOut: out.ok ? out.trianglesOut : null,
            parts: out.ok ? out.parts : null,
            bytes: out.ok ? out.mesh.length : null,
            ms,
            code: out.ok ? null : out.code,
            ...(out.ok || out.detail !== "cancelled" ? {} : { cancelled: true }),
          });
        } catch {

        }
      }
      resolve(out);
    };
    const fail = (code        , detail        ) => finish({ ok: false, code, detail, ms: Date.now() - started });
    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      worker = (options.workerFactory || defaultWorkerFactory)();
    } catch (err     ) {
      fail(MODEL_CODES.unreadable, `converter unavailable: ${String(err?.message || err).slice(0, 120)}`);
      return;
    }
    timer = setTimeout(() => fail(MODEL_CODES.tooBig, "conversion took too long"), timeoutMs);
    worker.once("message", (message     ) => finish(message));
    worker.once("error", (err     ) => {
      const oom = err?.code === "ERR_WORKER_OUT_OF_MEMORY";
      fail(oom ? MODEL_CODES.tooBig : MODEL_CODES.unreadable, oom ? "conversion ran out of memory" : String(err?.message || err).slice(0, 160));
    });
    worker.once("exit", (code        ) => fail(MODEL_CODES.unreadable, `converter stopped (${code})`));
    try {
      worker.postMessage({ input: { bytes: request.bytes, resources: request.resources || {} }, limits: options.limits || {} });
    } catch (err     ) {
      fail(MODEL_CODES.unreadable, String(err?.message || err).slice(0, 160));
    }
  });
}

function convertModelOffThread(request                     , options                      = {})               {
  const run = () => runOne(request, options);
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

module.exports = { convertModelOffThread };
