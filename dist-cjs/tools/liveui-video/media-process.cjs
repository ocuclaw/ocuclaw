const process = require("node:process");
const { createMediaBroker } = require("./media-broker.cjs");
const { runHostCommand, startHostProcess } = require("../host-process.cjs");

function mediaEnv(env                                     = {})                         {
  const out                         = { ...process.env, ...env };
  for (const key of Object.keys(out)) if (/^(http|https|all|no)_proxy$/i.test(key)) out[key] = "";
  for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]) out[key] = "";
  out.OCUCLAW_VIDEO_PROXY = "";
  return out;
}

async function runVideoCommand(argv          , options                     )                             {
  const { proxy, run = runHostCommand, ...commandOptions } = options;
  if (argv.length === 2 && argv[1] === "-U") return run(argv, commandOptions);
  let broker;
  try {
    broker = await createMediaBroker({ proxy });
    return await run([argv[0], "--ignore-config", "--proxy", broker.url, ...argv.slice(1)], {
      ...commandOptions, env: mediaEnv(commandOptions.env),
    });
  } catch {
    return { code: null, stdout: "", stderr: "Guarded media egress is unavailable", missing: false, timedOut: false, truncated: false, via: "node" };
  } finally { await broker?.close(); }
}

async function startVideoDownload(command        , args          , options                      )               {
  const broker = await createMediaBroker({ proxy: options.proxy, signal: options.signal });
  try {
    options.signal?.throwIfAborted();
    const child = (options.spawn || startHostProcess)(command, ["--proxy", broker.url, ...args], {
      stdio: options.stdio, cwd: options.cwd, env: mediaEnv(),
    });
    const kill = child.kill.bind(child);
    child.kill = (...args       ) => { void broker.close(); return kill(...args); };
    const abort = () => { child.kill("SIGKILL"); };
    const close = () => { options.signal?.removeEventListener("abort", abort); void broker.close(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("close", close); child.once("error", close);
    if (options.signal?.aborted) abort();
    return child;
  } catch (error) { await broker.close(); throw error; }
}

module.exports = { mediaEnv, runVideoCommand, startVideoDownload };
