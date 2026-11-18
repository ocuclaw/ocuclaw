const { execFile, spawn } = require("node:child_process");

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

const OPENCLAW_RUNNER = Symbol.for("ocuclaw.host-process.openclawRunCommand");

function useOpenClawRunCommand(api     )       {
  if (!api) return;
  (globalThis       )[OPENCLAW_RUNNER] = () => {
    try {
      const run = api.runtime && api.runtime.system ? api.runtime.system.runCommandWithTimeout : null;
      return typeof run === "function" ? run : null;
    } catch {
      return null;
    }
  };
}

function openClawRunCommand()                                                          {
  const read = (globalThis       )[OPENCLAW_RUNNER];
  return typeof read === "function" ? read() : null;
}

async function runHostCommand(argv          , options                    )                             {
  const run = openClawRunCommand();
  return run ? runThroughOpenClaw(run, argv, options) : runOnNode(argv, options);
}

async function runThroughOpenClaw(
  run                                                ,
  argv          ,
  options                    ,
)                             {
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  try {
    const r = await run(argv, {
      timeoutMs: options.timeoutMs,
      maxOutputBytes,
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    return {
      code: typeof r.code === "number" && r.termination === "exit" ? r.code : null,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
      missing: false,
      timedOut: r.termination === "timeout" || r.termination === "no-output-timeout",
      truncated: (r.stdoutTruncatedBytes || 0) > 0 || (r.stderrTruncatedBytes || 0) > 0,
      via: "openclaw",
    };
  } catch (err     ) {
    return failed(err, "openclaw");
  }
}

function runOnNode(argv          , options                    )                             {
  const maxBuffer = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    try {
      execFile(
        argv[0],
        argv.slice(1),
        {
          encoding: "utf8",
          timeout: options.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer,
          ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
        },
        (error     , stdout     , stderr     ) => {
          const out = typeof stdout === "string" ? stdout : "";
          const errText = typeof stderr === "string" ? stderr : "";
          if (!error) {
            resolve({ code: 0, stdout: out, stderr: errText, missing: false, timedOut: false, truncated: false, via: "node" });
            return;
          }
          if (error.code === "ENOENT" || error.code === "EACCES") {
            resolve({ ...failed(error, "node"), stdout: out, stderr: errText || String(error.message || "") });
            return;
          }
          resolve({
            code: typeof error.code === "number" ? error.code : null,
            stdout: out,
            stderr: errText || String(error.message || ""),
            missing: false,
            timedOut: error.killed === true && !error.code,
            truncated: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            via: "node",
          });
        },
      );
    } catch (err     ) {
      resolve(failed(err, "node"));
    }
  });
}

const ISOLATED_KILL_GRACE_MS = 1000;

function runIsolatedHostCommand(argv          , options                        )                             {
  const g = globalThis       ;
  const posix = g.process && g.process.platform !== "win32";
  return new Promise((resolve) => {
    let child     ;
    try {
      child = spawn(argv[0], argv.slice(1), {
        env: options.env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: posix,
      });
    } catch (err     ) {
      resolve(failed(err, "node"));
      return;
    }
    const out        = [];
    const errOut        = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;
    let backstop      = null;
    const kill = () => {
      try {
        if (posix && child.pid) g.process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {  }
      }

      if (!backstop) {
        backstop = setTimeout(() => {
          try { if (child.stdout) child.stdout.destroy(); } catch {  }
          try { if (child.stderr) child.stderr.destroy(); } catch {  }
          finish({ code: null, stdout: text(out), stderr: text(errOut), missing: false, timedOut, truncated, via: "node" });
        }, ISOLATED_KILL_GRACE_MS);
        if (backstop && typeof backstop.unref === "function") backstop.unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1, options.timeoutMs));
    const take = (chunks       ) => (chunk     ) => {
      if (truncated) return;
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) {
        truncated = true;
        kill();
        return;
      }
      chunks.push(chunk);
    };
    const text = (chunks       ) => (chunks.length ? g.Buffer.concat(chunks).toString("utf8") : "");
    const finish = (result                   ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (backstop) clearTimeout(backstop);
      resolve(result);
    };
    if (child.stdout) child.stdout.on("data", take(out));
    if (child.stderr) child.stderr.on("data", take(errOut));
    child.on("error", (err     ) => finish({ ...failed(err, "node"), timedOut }));
    child.on("close", (code     ) => {
      finish({
        code: typeof code === "number" && !timedOut && !truncated ? code : null,
        stdout: text(out),
        stderr: text(errOut),
        missing: false,
        timedOut,
        truncated,
        via: "node",
      });
    });
  });
}

function failed(err     , via                          )                    {
  const code = err && err.code;
  return {
    code: null,
    stdout: "",
    stderr: String((err && err.message) || err || "failed to start"),
    missing: code === "ENOENT" || code === "EACCES",
    timedOut: false,
    truncated: false,
    via,
  };
}

function outputText(value     )         {
  if (value === undefined || value === null) return "";

  return typeof value === "string" ? value : String(value);
}

function runKeepingPartialOutput(
  argv          ,
  options                                                                 ,
)                               {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      {
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",

        ...(options.env ? { env: options.env } : {}),
      },
      (error     , stdout     , stderr     ) => {
        if (error) {
          const killed = Boolean(error.killed) || error.signal === "SIGTERM" || error.code === "ETIMEDOUT";
          resolve({
            code: killed || typeof error.code !== "number" ? null : error.code,
            stdout: outputText(stdout),
            stderr: outputText(stderr) || (killed ? "timeout" : String(error.message || "spawn failed")),
            spawnFailed: typeof error.code === "string",
          });
          return;
        }
        resolve({ code: 0, stdout: outputText(stdout), stderr: outputText(stderr), spawnFailed: false });
      },
    );
  });
}

function startHostProcess(
  command        ,
  args          ,
  options                                                                                              ,
)      {
  return spawn(command, args, options);
}

module.exports = { useOpenClawRunCommand, runHostCommand, runIsolatedHostCommand, runKeepingPartialOutput, startHostProcess };
