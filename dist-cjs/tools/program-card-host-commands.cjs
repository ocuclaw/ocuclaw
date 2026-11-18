const { createHash } = require("node:crypto");

const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, canonicalSerialize, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { hostCommandWordsFacts } = require("./glasses-ui-task-uses.cjs");
const { runIsolatedHostCommand } = require("./host-process.cjs");

const HOST_COMMANDS_SERVER = "host";
const HOST_COMMANDS_FILENAME = "host-commands-v1.json";

const HOST_COMMAND_LIMITS = Object.freeze({
  maxCommands: 32,
  nameMax: 40,
  titleMax: 40,
  runMax: 32,
  elementMax: 200,
  argsMax: 8,
  oneOfMax: 16,
  oneOfTextMax: 60,
  textMax: 120,
  intAbsMax: 1_000_000_000,
  envMax: 8,
  timeoutMinMs: 1000,
  timeoutMaxMs: 10_000,
  timeoutDefaultMs: 8000,
  outputBytesMax: 256 * 1024,
  linesMax: 200,
  requestWaitMs: 60_000,
  requestGraceMs: 2000,
  maxRequests: 4,
  questionMax: 400,
});

const H = HOST_COMMAND_LIMITS;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const SLOT = /^\{([A-Za-z_][A-Za-z0-9_]{0,39})\}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const OUTPUTS = new Set(["json", "text", "lines"]);
const VIAS = new Set(["glasses", "phone", "host"]);

const SLOT_TEXT = /^[A-Za-z0-9 _.,:@+=#-]*$/;

const NEVER_PROGRAMS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "ash", "busybox", "env",
  "cmd", "cmd.exe", "powershell", "pwsh", "osascript", "eval", "exec", "source", "command", "builtin"]);

const HOST_PROGRAMS                                  = {
  uptime: { flags: ["-p", "--pretty", "-s", "--since"] },
  date: { flags: ["-u", "--utc", "-R", "--rfc-email"], positional: "plus" },
  hostname: { flags: ["-f", "--fqdn", "-s", "--short", "-i", "-I"] },
  whoami: {},
  uname: { flags: ["-a", "-s", "-n", "-r", "-v", "-m", "-p", "-i", "-o"] },
  nproc: { flags: ["--all"] },
  free: { flags: ["-b", "-k", "-m", "-g", "-h", "--human", "-w", "--wide", "-t", "--total", "--si"] },
  df: { flags: ["-h", "-H", "-T", "-i", "-l", "-k", "-P", "--total"], values: { "--output": "fixed" }, positional: "path" },
  du: { flags: ["-s", "-h", "-a", "-c", "-k", "-m", "-x"], values: { "-d": "int", "--max-depth": "int" }, positional: "path" },
  ls: { flags: ["-l", "-a", "-A", "-h", "-1", "-t", "-r", "-S", "-d", "-F", "-p"], positional: "path" },
  cat: { flags: ["-n"], positional: "path" },
  head: { values: { "-n": "int", "--lines": "int", "-c": "int", "--bytes": "int" }, positional: "path" },
  tail: { values: { "-n": "int", "--lines": "int", "-c": "int", "--bytes": "int" }, positional: "path" },
  wc: { flags: ["-l", "-w", "-c", "-m"], positional: "path" },
  stat: { flags: ["-L"], values: { "-c": "fixed", "--format": "fixed" }, positional: "path" },
  gh: {
    subs: [["pr", "list"], ["pr", "view"], ["pr", "status"], ["pr", "checks"], ["issue", "list"], ["issue", "view"],
      ["issue", "status"], ["run", "list"], ["run", "view"], ["repo", "view"], ["release", "list"], ["release", "view"]],
    flags: ["--comments", "--draft", "--log", "--log-failed"],
    values: {
      "--json": "fixed", "--jq": "fixed", "--template": "fixed", "--limit": "int", "-L": "int", "--repo": "text", "-R": "text",
      "--state": "text", "--label": "text", "--author": "text", "--assignee": "text", "--search": "text", "--base": "text",
      "--head": "text", "--branch": "text", "--workflow": "text", "--status": "text", "--job": "int",
    },
    positional: "text",
  },
  docker: {
    subs: [["ps"], ["images"], ["stats"], ["info"], ["version"], ["container", "ls"], ["image", "ls"]],
    flags: ["-a", "--all", "-q", "--quiet", "--no-trunc", "-s", "--size", "--no-stream", "--digests"],
    values: { "--format": "fixed", "--filter": "text", "-n": "int", "--last": "int" },
  },
  systemctl: {
    subs: [["status"], ["is-active"], ["is-enabled"], ["is-failed"], ["list-units"], ["list-timers"]],
    flags: ["--no-pager", "--user", "--failed", "--all", "-a", "--plain", "--no-legend", "--quiet", "-q", "--full", "-l"],
    values: { "--type": "text", "--state": "text", "-n": "int", "--lines": "int" },
    positional: "text",
  },
};

const HOST_SUB_NEEDS                           = { "docker stats": ["--no-stream"] };

const NEVER_ENV = /^(LD_|DYLD_)|PRELOAD|OPTIONS?$|OPT$|^(BASH_ENV|ENV|IFS|PS4|PROMPT_COMMAND|PAGER|EDITOR|VISUAL|SHELL|PATH|HOME|LANG|LC_ALL|TERM|NO_COLOR|TMPDIR)$|^GIT_(SSH|EXTERNAL|PAGER|EDITOR|CONFIG|EXEC|ASKPASS|DIR|WORK_TREE)|ASKPASS|^(PYTHON|PERL|RUBY|NODE_|NPM_CONFIG)|^(OPENCLAW|OCUCLAW|HERMES)_|^(GH_PAGER|GH_BROWSER|BROWSER|DOCKER_HOST|DOCKER_CONFIG|DOCKER_CONTEXT|SYSTEMD_PAGER|SYSTEMD_EDITOR)$/;

const PLAIN_ENV = /^(PATH|HOME|USER|LOGNAME|PWD|OLDPWD|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|TERM_PROGRAM|COLORTERM|TMPDIR|HOSTNAME|HOSTTYPE|OSTYPE|MACHTYPE|SHLVL|_|MAIL|TZ|XDG_[A-Z_]+|DISPLAY|EDITOR|VISUAL|PAGER|NODE_ENV|NVM_DIR|NVM_BIN|MANPATH|INFOPATH)$/;

const PRINTABLE = /^[\x20-\x7e]*$/;

const TOKEN_SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b([Bb]earer|[Tt]oken)\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const REDACTED = "[redacted]";

const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (object     , key        ) => Object.prototype.hasOwnProperty.call(object, key);
const chars = (text        ) => Array.from(text).length;

function singleLine(raw     , max        )                {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || CONTROL.test(text) || chars(text) > max) return null;
  return text;
}

function parseBound(name        , raw     )                                                          {
  if (!isPlainObject(raw)) return { ok: false, error: `args.${name} must be an object` };
  const keys = Object.keys(raw).filter((k) => k !== "default");
  let bound     ;
  if (keys.length === 2 && hasOwn(raw, "min") && hasOwn(raw, "max")) {
    const { min, max } = raw;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > max || max > H.intAbsMax) {
      return { ok: false, error: `args.${name}: min and max must be whole numbers from 0, min at most max` };
    }
    bound = { min, max };
  } else if (keys.length === 1 && hasOwn(raw, "oneOf")) {
    const values = raw.oneOf;
    if (!Array.isArray(values) || !values.length || values.length > H.oneOfMax) {
      return { ok: false, error: `args.${name}.oneOf must list 1 to ${H.oneOfMax} values` };
    }
    for (const value of values) {
      const fine = (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= H.intAbsMax) ||
        (typeof value === "string" && value !== "" && chars(value) <= H.oneOfTextMax && PRINTABLE.test(value) && !value.startsWith("-"));
      if (!fine) return { ok: false, error: `args.${name}.oneOf: each value is a whole number from 0 or plain text up to ${H.oneOfTextMax} characters that does not start with -` };
    }
    if (new Set(values.map((v     ) => JSON.stringify(v))).size !== values.length) return { ok: false, error: `args.${name}.oneOf repeats a value` };
    bound = { oneOf: [...values] };
  } else if (keys.length === 1 && hasOwn(raw, "text")) {
    if (!Number.isInteger(raw.text) || raw.text < 1 || raw.text > H.textMax) return { ok: false, error: `args.${name}.text must be 1 to ${H.textMax}` };
    bound = { text: raw.text };
  } else {
    return { ok: false, error: `args.${name} must be { min, max }, { oneOf: [...] } or { text: N }` };
  }
  if (hasOwn(raw, "default")) {
    if (!slotValueFits(bound, raw.default)) return { ok: false, error: `args.${name}.default does not fit its bound` };
    bound.default = raw.default;
  }
  return { ok: true, bound };
}

function slotValueFits(bound     , value     )          {
  if (hasOwn(bound, "min")) return Number.isInteger(value) && value >= bound.min && value <= bound.max;
  if (hasOwn(bound, "oneOf")) return bound.oneOf.some((v     ) => v === value);
  if (hasOwn(bound, "text")) {
    return typeof value === "string" && value.trim() !== "" && chars(value) <= bound.text && SLOT_TEXT.test(value) &&
      !value.startsWith("-") && !value.startsWith(".") && !value.includes("..");
  }
  return false;
}

function slotSchema(bound     ) {
  if (hasOwn(bound, "min")) return { type: "integer", minimum: bound.min, maximum: bound.max };
  if (hasOwn(bound, "oneOf")) {
    const types = [...new Set(bound.oneOf.map((v     ) => (typeof v === "number" ? "integer" : "string")))];
    return { type: types.length === 1 ? types[0] : types, enum: [...bound.oneOf] };
  }
  return { type: "string", maxLength: bound.text };
}

function boundWords(name        , bound     ) {
  if (hasOwn(bound, "min")) return `${name}: ${bound.min} to ${bound.max}`;
  if (hasOwn(bound, "oneOf")) return `${name}: one of ${bound.oneOf.join(", ")}`;
  return `${name}: words up to ${bound.text} letters`;
}

function commandLine(run          , cwd                ) {
  const line = run.map((word) => (/[\s"']/.test(word) || word === "" ? JSON.stringify(word) : word)).join(" ");
  return cwd ? `${line} (in ${cwd})` : line;
}

function defaultProgramProblem(fs     , file        , uid               ) {
  let real        ;
  let stat     ;
  try {
    real = fs.realpathSync(file);
    stat = fs.statSync(real);
  } catch (_) {
    return "is not installed there";
  }
  if (path.basename(real) !== path.basename(file)) return `is really ${real}`;
  if (!stat.isFile() || (stat.mode & 0o111) === 0) return "is not a program";
  void uid;
  const foreign = (s     ) => (s.mode & 0o022) !== 0 || s.uid !== 0;
  if (foreign(stat)) return "is not a program the system installed (it must belong to root, and only root may change it)";
  let dir = path.dirname(real);
  for (let depth = 0; depth < 64; depth++) {
    try {
      const s = fs.statSync(dir);

      if (foreign(s)) return "sits in a folder that is not the system's (every folder above it must belong to root, and only root may change it)";
    } catch (_) {
      return "is not installed there";
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function realpathOf(fs     , file        ) {
  try {
    return fs.realpathSync(file);
  } catch (_) {
    return null;
  }
}

function findOnPath(fs     , name        , pathValue        ) {
  for (const dir of String(pathValue || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch (_) {

    }
  }
  return null;
}

function hostProgramWordsProblem(words          , kinds                                )                {
  const program = words[0];
  const rule = HOST_PROGRAMS[program];
  if (!rule) return `${program} is not one of the programs host commands may run yet (${Object.keys(HOST_PROGRAMS).join(", ")})`;
  const rest = words.slice(1);
  let at = 0;
  let sub = "";
  if (rule.subs) {
    const chain = rule.subs.find((c) => c.every((word, i) => rest[i] === word));
    if (!chain) return `${program} ${rest.slice(0, 2).join(" ")} is not a ${program} command host commands may run yet`;
    at = chain.length;
    sub = chain.join(" ");
  }
  const slotKind = (word        ) => {
    const slot = SLOT.exec(word);
    return slot ? kinds[slot[1]] || "text" : null;
  };
  const valueFits = (want           , word                    ) => {
    if (word === undefined) return false;
    const kind = slotKind(word);
    if (kind) return want === "text" || (want === "int" && kind === "int");
    return want === "int" ? /^\d+$/.test(word) : !word.startsWith("-") || want === "fixed";
  };
  const flags = new Set(rule.flags || []);
  const values = rule.values || {};
  const seen = new Set        ();
  for (let i = at; i < rest.length; i++) {
    const word = rest[i];
    const kind = slotKind(word);
    if (!kind && word.startsWith("-")) {
      if (word === "-" || word === "--") return `${program} ${word} is not a flag host commands may use`;
      const eq = word.startsWith("--") ? word.indexOf("=") : -1;
      if (eq > 0) {
        const flag = word.slice(0, eq);
        if (!hasOwn(values, flag) || !valueFits(values[flag], word.slice(eq + 1))) return `${program} ${flag} is not a flag host commands may use that way`;
        seen.add(flag);
        continue;
      }
      if (flags.has(word)) {
        seen.add(word);
        continue;
      }
      if (hasOwn(values, word)) {
        if (!valueFits(values[word], rest[i + 1])) return `${program} ${word} needs a ${values[word] === "int" ? "whole number" : "value"} after it`;
        seen.add(word);
        i += 1;
        continue;
      }

      if (/^-[A-Za-z0-9]{2,}$/.test(word) && [...word.slice(1)].every((c) => flags.has(`-${c}`))) continue;
      return `${program} ${word} is not a flag host commands may use`;
    }
    const allowed = rule.positional || null;
    if (!allowed) return `${program}${sub ? ` ${sub}` : ""} takes no ${kind ? "slot" : `word ${word}`} there`;
    if (kind) {
      if (allowed !== "text") return `${program} cannot take a slot there: a file or format it reads stays fixed`;
      continue;
    }
    if (allowed === "plus" && !word.startsWith("+")) return `${program} takes only a +FORMAT word`;
  }
  for (const need of HOST_SUB_NEEDS[`${program} ${sub}`.trim()] || []) {
    if (!seen.has(need)) return `${program} ${sub} needs ${need}, or it never ends`;
  }
  return null;
}

function parseHostCommand(raw     , opts      = {})                                                            {
  if (!isPlainObject(raw)) return { ok: false, error: "a command must be an object" };
  const name = typeof raw.name === "string" && NAME.test(raw.name) ? raw.name : null;
  if (!name) return { ok: false, error: "name must be lowercase letters, digits and _ (up to 40), starting with a letter" };
  const title = singleLine(raw.title, H.titleMax);
  if (!title || !PRINTABLE.test(title)) return { ok: false, error: `title must be one line of up to ${H.titleMax} plain characters` };
  if (!Array.isArray(raw.run) || raw.run.length < 1 || raw.run.length > H.runMax) return { ok: false, error: `run must list the program and up to ${H.runMax - 1} arguments` };
  for (const word of raw.run) {
    if (typeof word !== "string" || !PRINTABLE.test(word) || chars(word) > H.elementMax) {
      return { ok: false, error: `each run element is up to ${H.elementMax} plain characters (letters, digits and punctuation, no tabs or look-alikes)` };
    }
  }
  const program0 = raw.run[0];
  if (!program0 || SLOT.test(program0)) return { ok: false, error: "run[0] must name the program, never a slot" };
  const base = path.basename(program0);
  if (NEVER_PROGRAMS.has(base.toLowerCase())) return { ok: false, error: `${base} runs other commands, so it cannot be a host command; name the program itself` };
  let program = program0;
  if (!path.isAbsolute(program0)) {
    if (program0.includes("/") || program0.includes("\\")) return { ok: false, error: "run[0] must be a full path or a bare program name" };
    if (opts.stored === true) return { ok: false, error: "a saved command must name its program's full path" };
    const found = typeof opts.resolve === "function" ? opts.resolve(program0) : null;
    if (!found) return { ok: false, error: `${program0} is not installed on this host` };
    program = found;
  }

  const real = typeof opts.realpath === "function" ? opts.realpath(program) : program;
  if (!real) return { ok: false, error: `${program} is not installed there` };
  const realBase = path.basename(real);
  if (NEVER_PROGRAMS.has(realBase.toLowerCase()) || (realBase !== base && realBase !== path.basename(program))) {
    return { ok: false, error: `${program} is really ${real}, so it cannot be a host command under that name` };
  }
  const run = [program, ...raw.run.slice(1)];
  const slots = new Set        ();
  for (const word of run.slice(1)) {
    const slot = SLOT.exec(word);
    if (!slot) continue;
    if (slots.has(slot[1])) return { ok: false, error: `slot {${slot[1]}} appears twice` };
    slots.add(slot[1]);
  }
  const rawArgs = raw.args === undefined ? {} : raw.args;
  if (!isPlainObject(rawArgs) || Object.keys(rawArgs).length > H.argsMax) return { ok: false, error: `args must be an object of up to ${H.argsMax} slot bounds` };
  const args      = {};
  for (const slot of slots) {
    if (!hasOwn(rawArgs, slot)) return { ok: false, error: `slot {${slot}} has no bound in args` };
    const parsed = parseBound(slot, rawArgs[slot]);
    if (!parsed.ok) return parsed;
    args[slot] = parsed.bound;
  }
  for (const key of Object.keys(rawArgs)) if (!slots.has(key)) return { ok: false, error: `args.${key} is not a slot in run` };
  const rawEnv = raw.env === undefined ? [] : raw.env;
  if (!Array.isArray(rawEnv) || rawEnv.length > H.envMax) return { ok: false, error: `env must list up to ${H.envMax} names` };
  const env           = [];
  for (const envName of rawEnv) {
    if (typeof envName !== "string" || !ENV_NAME.test(envName)) return { ok: false, error: "env names are upper case letters, digits and _" };
    if (NEVER_ENV.test(envName)) return { ok: false, error: `env ${envName} changes how programs start or holds this host's own keys, so a command cannot take it` };
    if (!env.includes(envName)) env.push(envName);
  }
  const output = raw.output === undefined ? "text" : raw.output;
  if (!OUTPUTS.has(output)) return { ok: false, error: "output must be json, text or lines" };
  const timeoutMs = raw.timeoutMs === undefined ? H.timeoutDefaultMs : raw.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < H.timeoutMinMs || timeoutMs > H.timeoutMaxMs) {
    return { ok: false, error: `timeoutMs must be ${H.timeoutMinMs} to ${H.timeoutMaxMs}` };
  }

  let cwd                = null;
  if (raw.cwd !== undefined && raw.cwd !== null) {
    if (opts.stored !== true) return { ok: false, error: "cwd cannot be asked for; a command runs in the owner's home folder (use a flag like --repo)" };
    if (typeof raw.cwd !== "string" || !path.isAbsolute(raw.cwd) || !PRINTABLE.test(raw.cwd) || chars(raw.cwd) > H.elementMax) {
      return { ok: false, error: "cwd must be a full path" };
    }
    cwd = path.normalize(raw.cwd);
  }

  const kinds                                 = {};
  for (const slot of slots) if (!hasOwn(args[slot], "oneOf")) kinds[slot] = hasOwn(args[slot], "min") ? "int" : "text";
  const choices = [...slots].filter((slot) => hasOwn(args[slot], "oneOf"));
  const fill = (pick                     ) => [base, ...run.slice(1).map((word) => {
    const slot = SLOT.exec(word);
    return slot && hasOwn(pick, slot[1]) ? String(pick[slot[1]]) : word;
  })];
  const first = Object.fromEntries(choices.map((slot) => [slot, args[slot].oneOf[0]]));
  const variants             = [fill(first)];
  for (const slot of choices) for (const value of args[slot].oneOf.slice(1)) variants.push(fill({ ...first, [slot]: value }));
  for (const words of variants) {
    const listed = hostProgramWordsProblem(words, kinds);
    if (listed) return { ok: false, error: `${listed}; host commands only read for now` };
    const facts = hostCommandWordsFacts(words.map((word) => (SLOT.test(word) ? "{slot}" : word)));
    if (facts.inline) return { ok: false, error: `${commandLine(words)} runs code it is handed, so it cannot be a host command` };
    if (facts.exact) return { ok: false, error: `${commandLine(words)} can change things or run another command; host commands only read for now` };
    if (!facts.reads) {
      const what = facts.sub ? `${facts.program} ${facts.sub}` : facts.program;
      return { ok: false, error: `${what} is not a command known to only read; host commands only read for now` };
    }
  }
  const problem = typeof opts.programProblem === "function" ? opts.programProblem(program) : null;
  if (problem) return { ok: false, error: `${program} ${problem}` };
  const added = isPlainObject(raw.added) && VIAS.has(raw.added.via) && Number.isSafeInteger(raw.added.atMs)
    ? { via: raw.added.via, atMs: raw.added.atMs }
    : { via: "host", atMs: 0 };
  return { ok: true, command: { name, title, run, args, env, output, timeoutMs, cwd, added } };
}

function hostCommandDigest(command     ) {
  const { name, run, args, env, output, cwd } = command;
  return createHash("sha256").update(canonicalSerialize({ name, run, args, env, output, cwd })).digest("hex");
}

function hostCommandTool(command     ) {
  const properties      = {};
  const required           = [];
  for (const [slot, bound] of Object.entries(command.args)                        ) {
    properties[slot] = slotSchema(bound);
    if (!hasOwn(bound, "default")) required.push(slot);
  }
  return {
    name: command.name,
    description: `${command.title} (runs ${commandLine(command.run)})`,
    inputSchema: {
      type: "object", additionalProperties: false, properties,
      ...(required.length ? { required } : {}),

      "x-ocuclaw-command": hostCommandDigest(command),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

function hostCommandArgv(command     , args     )                                                              {
  const given = isPlainObject(args) ? args : {};
  for (const key of Object.keys(given)) if (!hasOwn(command.args, key)) return { ok: false, error: `no slot ${key}` };
  const argv = [command.run[0]];
  for (const word of command.run.slice(1)) {
    const slot = SLOT.exec(word);
    if (!slot) {
      argv.push(word);
      continue;
    }
    const bound = command.args[slot[1]];
    const value = hasOwn(given, slot[1]) ? given[slot[1]] : bound.default;
    if (value === undefined || !slotValueFits(bound, value)) return { ok: false, error: `slot ${slot[1]} is missing or out of bounds` };
    argv.push(String(value));
  }
  return { ok: true, argv };
}

function cleanHostOutput(text        , secrets          ) {
  let out = String(text || "").replace(ANSI, "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const forms = new Set        ();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 6) continue;
    forms.add(secret);

    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.add(escaped);
  }
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join(REDACTED);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

function cleanJsonLeaves(value     , secrets          , depth = 0)      {
  if (typeof value === "string") return cleanHostOutput(value, secrets);
  if (depth > 64 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cleanJsonLeaves(item, secrets, depth + 1));
  const out      = {};
  for (const [key, item] of Object.entries(value)) out[cleanHostOutput(key, secrets)] = cleanJsonLeaves(item, secrets, depth + 1);
  return out;
}

function hostCommandEnv(command     , gatewayEnv     ) {
  const from = isPlainObject(gatewayEnv) ? gatewayEnv : {};
  const env                         = { TERM: "dumb", NO_COLOR: "1", LANG: "C.UTF-8" };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME"]) if (typeof from[key] === "string" && from[key]) env[key] = from[key];
  const secrets           = [];
  for (const key of command.env) {
    if (typeof from[key] === "string" && from[key]) {
      env[key] = from[key];
      secrets.push(from[key]);
    }
  }
  for (const [key, value] of Object.entries(from)) {
    if (typeof value === "string" && value.length >= 8 && !PLAIN_ENV.test(key) && !command.env.includes(key)) secrets.push(value);
  }
  return { env, secrets };
}

function hostCommandAnswer(command     , result     , secrets          ) {
  if (result.missing) return { ok: false, code: "failed" };
  if (result.timedOut) return { ok: false, code: "timeout" };
  if (result.truncated) return { ok: true, truncated: true };
  if (result.code !== 0) return { ok: true, isError: true };
  const text = cleanHostOutput(result.stdout, secrets);
  if (command.output === "json") {
    try {
      return { ok: true, structured: cleanJsonLeaves(JSON.parse(text), secrets) };
    } catch (_) {
      return { ok: true, isError: true };
    }
  }
  if (command.output === "lines") {
    return { ok: true, structured: text.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "").slice(0, H.linesMax) };
  }
  return { ok: true, structured: text.trim() };
}

function createHostCommandsStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, HOST_COMMANDS_FILENAME);
  let kept                      = {};

  function read(check                   ) {
    let doc     ;
    kept = {};
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err     ) {
      return { commands: [], problems: err && err.code === "ENOENT" ? [] : [{ name: null, error: "the list could not be read" }], unreadable: !(err && err.code === "ENOENT") };
    }
    if (!isPlainObject(doc) || doc.schemaVersion !== 1 || !isPlainObject(doc.commands)) {
      return { commands: [], problems: [{ name: null, error: "the list is not a schemaVersion 1 document" }], unreadable: true };
    }
    const commands        = [];
    const problems        = [];
    const names = Object.keys(doc.commands).sort();
    names.forEach((name, index) => {
      const parsed = index < H.maxCommands
        ? check({ ...(isPlainObject(doc.commands[name]) ? doc.commands[name] : {}), name })
        : { ok: false, error: `the list holds more than ${H.maxCommands} commands` };
      if (parsed.ok) {
        commands.push(parsed.command);
        return;
      }
      kept[name] = doc.commands[name];
      problems.push({ name: NAME.test(name) ? name : null, error: String(parsed.error).slice(0, 200) });
    });
    return { commands, problems, unreadable: false };
  }

  function write(commands       , drop           = []) {
    const out      = {};
    for (const [name, raw] of Object.entries(kept)) if (!drop.includes(name)) out[name] = raw;
    for (const c of commands) {
      out[c.name] = {
        title: c.title, run: c.run, ...(Object.keys(c.args).length ? { args: c.args } : {}), ...(c.env.length ? { env: c.env } : {}),
        output: c.output, timeoutMs: c.timeoutMs, ...(c.cwd ? { cwd: c.cwd } : {}), added: c.added,
      };
    }
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: { schemaVersion: 1, commands: out } });
  }

  return { file, read, write };
}

const NEXT                         = {
  added: "The owner added it. Declare it in a card's mcp block as server \"host\" with this tool name, fixed args and vary inside the slot bounds; each card still needs the wearer's yes to read it.",
  declined: "The owner said not now. Do not ask again for this command in this chat.",
  no_answer: "The owner did not answer. You may ask again later.",
  off: "Host commands are off on this host. Build the card another way.",
  invalid: "The host refused this command; fix what error says, or build the card another way.",
};

const REQUEST_HOST_COMMAND_TOOL_NAME = "request_host_command";

const REQUEST_HOST_COMMAND_TOOL_DESCRIPTION =
  "Ask the owner to add one command to this host's list of commands cards may run with no model in between (pilot: reads only, from gh pr/issue/run/repo/release list|view|status, docker ps|images|stats --no-stream, systemctl status|is-active|list-units, uptime, date, df, du, free, uname, ls, cat, head, tail, wc; only their read flags). " +
  "The command fetches the data with no model in between. If the card should also judge or word that data while open (which PR needs the owner, is this disk use worrying), keep the command for the data and add the card's own model or Jev use for the judgment. Use a Task instead only for work on a schedule or with the agent's own tools while the card is closed. If host already lists a tool that prints what you need, use it rather than asking again. " +
  "run is the program and its arguments, never a shell line: an element that is exactly {name} is a slot a card fills, bounded in args by { min, max }, { oneOf: [...] } or { text: N } (plain words, no paths; a file a reader opens stays fixed). It runs in the owner's home folder, so name the repo with --repo. " +
  "The owner sees the full command and says Add on the glasses or the phone. Returns answer: added (with tool, then declare it in the card's mcp block as server \"host\"), declined, no_answer, off, or invalid with error.";

const requestHostCommandParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "title", "run", "why"],
  properties: {
    name: { type: "string", description: "Tool name: lowercase letters, digits and _, like pr_list." },
    title: { type: "string", maxLength: 40, description: "What it shows, for the owner, like 'Open pull requests'." },
    run: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" }, description: "Program then arguments, like [\"gh\",\"pr\",\"list\",\"--limit\",\"{limit}\"]." },
    args: { type: "object", properties: {}, additionalProperties: true, description: "{ slot: { min, max } | { oneOf: [...] } | { text: N } }, each with an optional default." },
    env: { type: "array", maxItems: 8, items: { type: "string" }, description: "Environment names the program needs, like GH_TOKEN. Their values never reach a card." },
    output: { type: "string", enum: ["json", "text", "lines"], description: "How to read what it prints; default text." },
    why: { type: "string", maxLength: 140, description: "One line on why the card needs it. Not shown to the owner." },
  },
};

function createRequestHostCommandHandler(deps     ) {
  return async function requestHostCommand(sessionKey        , params     ) {
    let verdict      = null;
    try {
      verdict = typeof deps.considerHostCommand === "function"
        ? await deps.considerHostCommand({ sessionKey, spec: params })
        : { answer: "off" };
    } catch (_) {
      verdict = null;
    }
    const answer = verdict && typeof verdict.answer === "string" && NEXT[verdict.answer] ? verdict.answer : "no_answer";
    const out      = { answer };
    if (answer === "added" && verdict.tool) out.tool = verdict.tool;
    if (answer === "invalid") out.error = String(verdict.error || "invalid").slice(0, 300);
    out.next = NEXT[answer];
    return out;
  };
}

function createProgramCardHostCommands(deps      = {}) {
  const enabled = deps.enabled === true;
  const fs = deps.fs && typeof deps.fs === "object" ? deps.fs : nodeFs;
  const store = createHostCommandsStore({ fs, libraryDir: deps.libraryDir });
  const gatewayEnv = () => (typeof deps.env === "function" ? deps.env() : deps.env) || {};
  const run = typeof deps.run === "function" ? deps.run : runIsolatedHostCommand;
  const uid = Number.isInteger(deps.uid) ? deps.uid : null;
  const programProblem = typeof deps.programProblem === "function" ? deps.programProblem : (file        ) => defaultProgramProblem(fs, file, uid);
  const presentDecision = typeof deps.presentDecision === "function" ? deps.presentDecision : () => false;
  const cancelDecision = typeof deps.cancelDecision === "function" ? deps.cancelDecision : () => false;
  let onChange = typeof deps.onChange === "function" ? deps.onChange : () => {};
  let onAdded = typeof deps.onAdded === "function" ? deps.onAdded : () => {};
  const emitLifecycle = typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const requests = new Map             ();
  let seq = 0;
  let loaded      = { commands: [], problems: [] };

  const emit = (event        , level        , data     ) => {
    try { emitLifecycle(event, level, data); } catch (_) {  }
  };
  const check = (raw     , stored         ) => parseHostCommand(raw, {
    stored,
    resolve: (name        ) => findOnPath(fs, name, gatewayEnv().PATH),
    realpath: (file        ) => realpathOf(fs, file),
    programProblem,
  });
  const reload = () => {
    loaded = enabled ? store.read((raw     ) => check(raw, true)) : { commands: [], problems: [] };
    return loaded;
  };
  reload();
  const find = (name        ) => loaded.commands.find((c     ) => c.name === name) || null;
  const changed = () => {
    try { onChange(); } catch (_) {  }
  };

  function listRow() {
    if (!enabled) return null;
    reload();
    return { name: HOST_COMMANDS_SERVER, connected: true, writes: false, hostCommands: true, tools: loaded.commands.map(hostCommandTool) };
  }

  async function call({ tool, args, timeoutMs, write }     ) {
    if (!enabled || write === true) return { ok: false, code: "off" };
    const command = find(tool);
    if (!command) return { ok: false, code: "off" };
    const built = hostCommandArgv(command, args);
    if (!built.ok) return { ok: false, code: "failed" };

    const real = realpathOf(fs, command.run[0]);
    const realBase = real ? path.basename(real) : "";
    const problem = !real || realBase !== path.basename(command.run[0]) || NEVER_PROGRAMS.has(realBase.toLowerCase())
      ? "is not the program it was"
      : programProblem(real);
    if (problem) {
      emit("program_card_host_command_refused", "warn", { command: command.name, reason: "program" });
      return { ok: false, code: "failed" };
    }
    built.argv[0] = real;
    const { env, secrets } = hostCommandEnv(command, gatewayEnv());
    const startedAt = now();
    const limit = Math.min(command.timeoutMs, Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : command.timeoutMs);
    const result = await run(built.argv, { timeoutMs: limit, maxOutputBytes: H.outputBytesMax, env, cwd: command.cwd || env.HOME || undefined });
    const answer = hostCommandAnswer(command, result, secrets);
    emit("program_card_host_command_ran", "debug", {
      command: command.name,
      outcome: answer.ok === false ? answer.code : (answer       ).truncated ? "too_big" : (answer       ).isError ? "failed" : "ok",
      ms: Math.max(0, Math.round(now() - startedAt)),
    });
    return answer;
  }

  function question(command     , replaces     )                {
    const lines = [
      `"${command.title}" runs on this computer:`,
      commandLine(command.run, command.cwd),
      [...Object.entries(command.args).map(([slot, bound]) => boundWords(slot, bound)),
        ...(command.env.length ? [`Uses ${command.env.join(", ")}`] : []), "Reads only"].join(" · "),
    ];
    if (replaces) lines.push(`Replaces: ${commandLine(replaces.run, replaces.cwd)}`);
    const text = lines.join("\n");
    return Array.from(text).length > H.questionMax ? null : text;
  }

  function settle(entry     , answer        , via               ) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeoutFn(entry.timer);
    requests.delete(entry.id);
    if (answer === "added" && loaded.unreadable) {
      emit("program_card_host_command_store_failed", "warn", { command: entry.command.name });
      entry.resolve({ answer: "no_answer" });
    } else if (answer === "added") {
      const commands = loaded.commands.filter((c     ) => c.name !== entry.command.name);
      const command = { ...entry.command, added: { via: via || "glasses", atMs: now() } };
      commands.push(command);
      commands.sort((a     , b     ) => (a.name < b.name ? -1 : 1));
      try {
        store.write(commands, [command.name]);
        reload();
      } catch (_) {
        emit("program_card_host_command_store_failed", "warn", { command: entry.command.name });
        entry.resolve({ answer: "no_answer" });
        changed();
        return;
      }
      emit("program_card_host_command_added", "info", { command: command.name, via: command.added.via });
      try { onAdded(command.name); } catch (_) {  }
      entry.resolve({ answer: "added", tool: command.name });
    } else {
      emit("program_card_host_command_ask", "info", { command: entry.command.name, outcome: answer });
      entry.resolve({ answer });
    }

    if (via !== "glasses" && entry.surfaceId) {
      try { cancelDecision(entry.surfaceId); } catch (_) {  }
    }
    changed();
  }

  async function consider({ sessionKey, spec }     )               {
    if (!enabled) return { answer: "off" };
    const parsed = check({ ...(isPlainObject(spec) ? spec : {}), added: undefined }, false);
    if (!parsed.ok) return { answer: "invalid", error: parsed.error };
    reload();
    const command = parsed.command;
    const existing = find(command.name);
    if (existing && hostCommandDigest(existing) === hostCommandDigest(command)) return { answer: "added", tool: command.name };
    if (!existing && loaded.commands.length >= H.maxCommands) return { answer: "invalid", error: `the list already holds ${H.maxCommands} commands` };
    if (loaded.unreadable) return { answer: "invalid", error: "the host's command list cannot be read, so nothing can be added until the owner fixes it" };
    const ask = question(command, existing);
    if (!ask) return { answer: "invalid", error: `the command is too long to show the owner whole ( characters with its bounds); make it shorter` };
    if (requests.size >= H.maxRequests) return { answer: "no_answer" };
    const id = `hc${(++seq).toString(36)}${now().toString(36)}`;
    let resolve     ;
    const promise = new Promise     ((r) => { resolve = r; });
    const entry      = { id, command, replaces: existing, sessionKey, expiresAtMs: now() + H.requestWaitMs, resolve, settled: false, timer: null, surfaceId: null };
    requests.set(id, entry);
    emit("program_card_host_command_request", "info", { command: command.name, replaces: !!existing });
    changed();
    let accepted = false;
    try {
      const result = presentDecision({
        surface: {
          surfaceId: (entry.surfaceId = `host-command:${id}`),
          sessionKey: typeof sessionKey === "string" ? sessionKey : null,
          kind: "permission",
          title: existing ? "Change this command for your cards?" : "Add this command for your cards?",
          question: ask,
          options: [
            { key: "allow", label: existing ? "Change" : "Add" },
            { key: "deny", label: "Not now" },
          ],
          deadlineSec: Math.ceil(H.requestWaitMs / 1000),
        },
        expiresAtMs: entry.expiresAtMs,
        onDecision: (decision     ) => {
          const choice = decision && decision.choice;
          if (choice === "allow") settle(entry, "added", "glasses");
          else if (choice === "deny") settle(entry, "declined", "glasses");
          else settle(entry, "no_answer", null);
        },
      });
      accepted = result === true || (!!result && typeof result === "object" && result.presented === true);
    } catch (_) {
      accepted = false;
    }

    const handle = setTimeoutFn(() => settle(entry, "no_answer", null), H.requestWaitMs + (accepted ? H.requestGraceMs : 0));
    if (handle && typeof handle.unref === "function") handle.unref();
    entry.timer = handle;
    return promise;
  }

  function handle(msg     ) {
    if (!enabled || !isPlainObject(msg)) return false;
    if (msg.action === "decide" && typeof msg.request === "string" && typeof msg.allow === "boolean") {
      const entry = requests.get(msg.request);
      if (!entry) return false;
      settle(entry, msg.allow ? "added" : "declined", "phone");
      return true;
    }
    if (msg.action === "remove" && typeof msg.name === "string" && NAME.test(msg.name)) {
      reload();

      if (loaded.unreadable || (!find(msg.name) && !loaded.problems.some((p     ) => p.name === msg.name))) return false;
      try {
        store.write(loaded.commands.filter((c     ) => c.name !== msg.name), [msg.name]);
      } catch (_) {
        emit("program_card_host_command_store_failed", "warn", { command: msg.name });
        return false;
      }
      reload();
      emit("program_card_host_command_removed", "info", { command: msg.name });
      changed();
      return true;
    }
    return false;
  }

  function state() {
    if (!enabled) return null;
    const show = (c     ) => ({
      name: c.name, title: c.title, command: commandLine(c.run, c.cwd),
      bounds: Object.entries(c.args).map(([slot, bound]) => boundWords(slot, bound)), env: [...c.env], reads: true,
    });
    return {
      commands: loaded.commands.map((c     ) => ({ ...show(c), via: c.added.via, atMs: c.added.atMs })),
      problems: loaded.problems.map((p     ) => ({ ...p })),
      requests: [...requests.values()].filter((r     ) => !r.settled).map((r     ) => ({
        id: r.id, ...show(r.command), replaces: r.replaces ? commandLine(r.replaces.run, r.replaces.cwd) : null, expiresAtMs: r.expiresAtMs,
      })),
    };
  }

  function stopAll() {
    for (const entry of [...requests.values()]) settle(entry, "no_answer", null);
  }

  function bind(hooks      = {}) {
    if (typeof hooks.onChange === "function") onChange = hooks.onChange;
    if (typeof hooks.onAdded === "function") onAdded = hooks.onAdded;
  }

  const api      = { enabled, listRow, call, consider, handle, state, stopAll, reload, bind, file: store.file };

  api.wrap = (base     ) => withHostCommands(base, api);
  return api;
}

function withHostCommands(base     , commands     ) {
  const isHost = (server     ) => server === HOST_COMMANDS_SERVER;
  return {
    kind: base && typeof base.kind === "string" ? base.kind : "openclaw",
    async list(params      = {}) {
      const asked = Array.isArray(params.servers) ? params.servers.filter((name     ) => !isHost(name)) : [];
      const out = base ? await base.list({ ...params, servers: asked }) : null;
      const row = commands.listRow();
      if (!row) return out || { ok: false, reason: "unsupported" };

      if (!out || out.ok !== true) return { ok: true, writes: false, servers: [row] };
      const servers = (Array.isArray(out.servers) ? out.servers : []).filter((server     ) => !(server && isHost(server.name)));
      return { ...out, servers: [...servers, row] };
    },
    async call(params     ) {
      if (params && isHost(params.server)) return commands.call(params);
      return base ? base.call(params) : { ok: false, code: "off" };
    },
    allow(server        , allow         ) {
      if (isHost(server)) return { ok: true };
      return base && typeof base.allow === "function" ? base.allow(server, allow) : null;
    },
    dispose() {
      return base && typeof base.dispose === "function" ? base.dispose() : undefined;
    },
  };
}

module.exports = { HOST_COMMANDS_SERVER, HOST_COMMANDS_FILENAME, HOST_COMMAND_LIMITS, slotValueFits, boundWords, commandLine, hostProgramWordsProblem, parseHostCommand, hostCommandDigest, hostCommandTool, hostCommandArgv, cleanHostOutput, hostCommandEnv, hostCommandAnswer, createHostCommandsStore, REQUEST_HOST_COMMAND_TOOL_NAME, REQUEST_HOST_COMMAND_TOOL_DESCRIPTION, requestHostCommandParametersSchema, createRequestHostCommandHandler, createProgramCardHostCommands, withHostCommands };
