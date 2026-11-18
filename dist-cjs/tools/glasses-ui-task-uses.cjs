const { createHash } = require("node:crypto");

const nodeFs = require("node:fs");

const path = require("node:path");

const { atomicWriteLiveuiLibraryRecord, isValidLiveuiLibraryItemId, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { carryUnknownFields, hasUnknownFields } = require("./saved-format.cjs");

const TASK_USES_DIR = "task-uses-v1";
const TASK_USES_ENTRIES_MAX = 64;
const TASK_USES_NEEDS_MAX = 8;
const KEY_MAX = 200;
const PART_MAX = 120;
const DETAIL_MAX = 500;

const TERMINAL_PARSE_MAX = 16_384;
const EXACT_PREFIX = "terminal-exact:";

const EXACT_DIGEST_MARK = " …sha256:";

const TASK_USE_KINDS = Object.freeze(["mcp", "send", "terminal", "tool"]);

const TASK_USES_NOT_ALLOWED = "not-allowed-for-this-task";
const TASK_USES_NOT_OFFERED = "not-offered-to-tasks";
const TASK_USES_NOT_ON_OPEN = "not-in-an-open-run";

const TASK_USES_CHECK_FAILED_REASON =
  `${TASK_USES_NOT_ALLOWED}: OcuClaw could not check this step, so it skipped it. Carry on without it.`;

const TASK_USES_CUT_MARK = "\u0000ocuclaw-cut-sha256:";

function taskUsesCutArg(value        , limit        ) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}${TASK_USES_CUT_MARK}${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const READS                              = {
  openclaw: new Set([
    "web_search", "web_fetch", "read", "image",
    "memory_search", "memory_get",
    "sessions_list", "sessions_history", "session_status",
    "tool_search", "update_plan",

    "webrun",
  ]),
  hermes: new Set([
    "web_search", "web_extract", "read_file", "search_files", "vision_analyze",
    "session_search", "skill_view", "skills_list",
    "ha_get_state", "ha_list_entities", "ha_list_services",
    "browser_navigate", "browser_snapshot", "browser_get_images", "browser_vision", "browser_back", "browser_scroll",
    "todo",

    "tool_search", "tool_describe",
  ]),
};

const NEVER                              = {
  openclaw: new Set(["cron", "sessions_spawn", "sessions_send", "subagents", "gateway"]),
  hermes: new Set(["cronjob", "cronjob_manage", "delegate_task", "memory", "skill_manage", "clarify"]),
};
const NEVER_PREFIX                                = { openclaw: null, hermes: /^kanban_/ };

const DELIVERY_TOOL = "manage_liveui_tasks";
const DELIVERY_OPERATION = "feed_card";

function isDeliveryStep(name        , args     ) {
  return name === DELIVERY_TOOL && isPlainObject(args) && own(args, "operation") === DELIVERY_OPERATION;
}

const TERMINAL                              = { openclaw: new Set(["exec"]), hermes: new Set(["terminal"]) };
const COMMAND_ARGS = ["command", "cmd", "shell"];

const SENDS                              = {
  openclaw: new Set(["message"]),
  hermes: new Set(["send_message", "discord", "yb_send_dm"]),
};
const DESTINATION_ARGS = ["target", "to", "channel", "channelId", "chat_id", "chatId", "recipient", "user", "user_id"];
const MESSAGE_ARGS = ["message", "text", "content", "body"];

function isPlainObject(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteMs(value     )                {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function part(value     , limit = PART_MAX)                {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function firstArg(args     , names          ) {
  if (!isPlainObject(args)) return null;
  for (const name of names) {
    const value = part(own(args, name), DETAIL_MAX);
    if (value) return value;
  }
  return null;
}

function rawFirstArg(args     , names          )                {
  if (!isPlainObject(args)) return null;
  for (const name of names) {
    const value = own(args, name);
    if ((typeof value === "string" || typeof value === "number") && part(value, DETAIL_MAX)) return String(value);
  }
  return null;
}

function own         (table                   , key        )                {
  return table !== null && typeof table === "object" && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

function exactKey(text        ) {
  const room = KEY_MAX - EXACT_PREFIX.length;
  if (text.length <= room && !/[\u0000-\u001f\u007f]/.test(text) && !text.includes(EXACT_DIGEST_MARK)) {
    return `${EXACT_PREFIX}${text}`;
  }
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const shown = text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, room - EXACT_DIGEST_MARK.length - digest.length);
  return `${EXACT_PREFIX}${shown}${EXACT_DIGEST_MARK}${digest}`;
}

function shellCommands(text        )                                                               {
  const commands             = [];
  let words           = [];
  let word                = null;
  let exact = false;

  const patterns           = [];

  let bare = "";
  const endWord = () => {
    if (word !== null) words.push(word);
    if (bare.includes("{") && (bare.includes(",") || bare.includes(".."))) exact = true;

    const whole = word ?? "";
    if (/[*?]/.test(bare) || (bare.includes("[") && whole.indexOf("]", whole.indexOf("[") + 1) > 0)) {
      exact = true;
      if (patterns.length < 3) patterns.push(whole);
    }

    if (bare.includes("<<")) exact = true;
    word = null;
    bare = "";
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if ((ch === "<" || ch === ">") && word !== null && /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(word)) exact = true;
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close < 0 ? text.length : close;
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      let value = "";
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length) value += text[++j];
        else if (text[j] === "`" || (text[j] === "$" && text[j + 1] === "(")) {
          exact = true;
          value += text[j];
        } else value += text[j];
      }
      word = (word ?? "") + value;
      i = j;
    } else if (ch === "\\" && i + 1 < text.length) {
      word = (word ?? "") + text[++i];
    } else if (/\s/.test(ch)) {
      if (ch === "\n") endCommand();
      else endWord();
    } else if (ch === ";" || ch === "|") {
      if (ch === "|" && text[i + 1] === "|") i++;
      endCommand();
    } else if (ch === "&") {
      if (text[i + 1] === "&") {
        i++;
        endCommand();
      } else if (text[i - 1] === ">") {
        word = (word ?? "") + ch;
      } else {
        exact = true;
        endCommand();
      }
    } else if (ch === "`" || (ch === "$" && text[i + 1] === "(") || ((ch === "<" || ch === ">") && text[i + 1] === "(")) {
      exact = true;
      word = (word ?? "") + ch;
    } else if (ch === "(" || ch === ")") {

      exact = true;
      word = (word ?? "") + ch;
    } else if (ch === ">") {
      const redirect = />>?\s*(\S*)/y;
      redirect.lastIndex = i;
      const target = redirect.exec(text)?.[1] || "";
      if (text[i + 1] !== "&" && target !== "/dev/null") exact = true;

      if (text[i + 1] === "&") {
        const dup = />&\s*([^\s;|&<>()]*)/y;
        dup.lastIndex = i;
        if (!/^(\d+-?|-)$/.test(dup.exec(text)?.[1] || "")) exact = true;
      }
      word = (word ?? "") + ch;
    } else {

      if (ch === "#" && word === null) exact = true;
      word = (word ?? "") + ch;
      bare += ch;
    }
  }
  endCommand();
  return { commands, exact, patterns };
}

const SHELL_LEADS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"]);
const SHELL_ENDS = new Set(["fi", "done", "esac", "}"]);

const SHELL_LOOP_HEADS = new Set(["for", "select"]);

const INLINE_CODE_FLAGS                         = {
  sh: /^-[a-z]*c[a-z]*$/, bash: /^-[a-z]*c[a-z]*$/, zsh: /^-[a-z]*c[a-z]*$/, dash: /^-[a-z]*c[a-z]*$/,
  ksh: /^-[a-z]*c[a-z]*$/, ash: /^-[a-z]*c[a-z]*$/, fish: /^(-c|--command(=.*)?)$/,
  python: /^-[A-Za-z]*c$/, pypy: /^-[A-Za-z]*c$/,
  node: /^(-e|-p|--eval(=.*)?|--print(=.*)?)$/, deno: /^eval$/, bun: /^(-e|--eval(=.*)?)$/,
  perl: /^-[A-Za-z]*[eE]$/, ruby: /^-[A-Za-z]*e$/, php: /^(-r|--run(=.*)?)$/, lua: /^-e$/,
  osascript: /^-e$/, pwsh: /^-(c|command|encodedcommand|e)$/i, powershell: /^-(c|command|encodedcommand|e)$/i,
};

const NESTED_VERBS                                       = {
  gh: 2, aws: 2, az: 3, gcloud: 3,
  docker: new Set(["compose", "container", "image", "network", "volume", "system", "builder", "buildx", "context",
    "plugin", "swarm", "node", "service", "stack", "secret", "config", "trust", "manifest"]),
  git: new Set(["stash", "remote", "worktree", "submodule", "notes", "lfs", "bisect", "sparse-checkout", "reflog", "maintenance"]),
  npm: new Set(["run", "run-script", "exec", "x"]), pnpm: new Set(["run", "exec", "dlx"]), yarn: new Set(["run", "dlx"]),
  bun: new Set(["run", "x"]), kubectl: new Set(["config", "rollout", "auth", "set"]), helm: new Set(["repo", "plugin"]),
  terraform: new Set(["state", "workspace"]), go: new Set(["mod"]), brew: new Set(["services"]),
  tailscale: new Set(["serve", "funnel"]),
};
NESTED_VERBS.podman = NESTED_VERBS.docker;
NESTED_VERBS.nerdctl = NESTED_VERBS.docker;
NESTED_VERBS.oc = NESTED_VERBS.kubectl;

const PLAIN_WORD = /^[A-Za-z][A-Za-z0-9_.:-]{0,40}$/;

const RUNS_ANOTHER = new Set(["timeout", "sudo", "doas", "su", "runuser", "nice", "ionice", "nohup", "xargs", "watch",
  "stdbuf", "setsid", "flock", "chroot", "unbuffer", "parallel", "script", "busybox", "exec", "builtin", "awk", "gawk",
  "mawk", "nawk", "ssh",

  "time", "taskset", "chrt", "numactl", "strace", "ltrace", "nsenter", "unshare", "setpriv", "systemd-run",
  "firejail", "torsocks", "proxychains", "proxychains4",

  "coproc",

  "jobs"]);

const TRUSTED_BIN_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"]);

const WRITE_ANYWHERE = /^--(force|force-with-lease|hard|delete)(=.*)?$/;
const shortFlag = (w        , letters        ) => !w.startsWith("--") && /^-[A-Za-z]/.test(w) && letters.test(w.slice(1));

const SED_READ_COMMANDS = new Set(["=", "d", "D", "g", "G", "h", "H", "n", "N", "p", "P", "x", "z", "F"]);
function sedScriptReads(script        ) {
  const n = script.length;
  let i = 0;
  const blanks = () => { while (i < n && (script[i] === " " || script[i] === "\t")) i++; };
  const digits = () => { while (i < n && /[0-9]/.test(script[i])) i++; };

  const delimited = (delim        ) => {
    while (i < n) {
      const ch = script[i++];
      if (ch === "\\") i++;
      else if (ch === delim) return true;
      else if (ch === "\n") return false;
    }
    return false;
  };
  const address = () => {
    const ch = script[i];
    if (ch === "$") i++;
    else if (/[0-9]/.test(ch)) {
      digits();
      if (script[i] === "~") { i++; digits(); }
    } else if (ch === "/" || ch === "\\") {
      const delim = ch === "\\" ? script[i + 1] : "/";
      i += ch === "\\" ? 2 : 1;
      if (!delim || delim === "\n" || delim === "\\" || !delimited(delim)) return false;
      while (i < n && (script[i] === "I" || script[i] === "M")) i++;
    }
    return true;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) return true;
    if (script[i] === "}") { i++; continue; }
    if (script[i] === "#") { while (i < n && script[i] !== "\n") i++; continue; }
    if (!address()) return false;
    blanks();
    if (script[i] === ",") {
      i++;
      blanks();
      if (script[i] === "+" || script[i] === "~") { i++; digits(); } else if (!address()) return false;
    }
    blanks();
    while (script[i] === "!") { i++; blanks(); }
    const cmd = script[i++];
    if (cmd === undefined) return false;
    if (cmd === "{") continue;
    if (cmd === "s" || cmd === "y") {
      const delim = script[i++];
      if (!delim || delim === "\\" || delim === "\n" || !delimited(delim) || !delimited(delim)) return false;

      if (cmd === "s") while (i < n && /[gpiImM0-9]/.test(script[i])) i++;
    } else if (cmd === "a" || cmd === "i" || cmd === "c" || cmd === "r" || cmd === "R") {

      while (i < n && script[i] !== "\n") i += script[i] === "\\" ? 2 : 1;
      continue;
    } else if (cmd === ":" || cmd === "b" || cmd === "t" || cmd === "T") {
      blanks();
      while (i < n && !/[;\n}]/.test(script[i])) i++;
    } else if (cmd === "l" || cmd === "L" || cmd === "q" || cmd === "Q") {
      blanks();
      digits();
    } else if (!SED_READ_COMMANDS.has(cmd)) {
      return false;
    }
    blanks();
    if (i < n && !/[;\n}#]/.test(script[i])) return false;
  }
  return true;
}

function sedNeedsExact(words          ) {
  const scripts           = [];
  let named = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      if (!named && i + 1 < words.length) scripts.push(words[i + 1]);
      named = true;
      break;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      if (name === "--expression") {
        scripts.push(eq < 0 ? words[++i] ?? "" : w.slice(eq + 1));
        named = true;
      } else if (name === "--line-length") {
        if (eq < 0) i++;
      } else if (!["--quiet", "--silent", "--regexp-extended", "--separate", "--null-data", "--zero-terminated",
        "--unbuffered", "--posix", "--debug", "--sandbox", "--binary", "--help", "--version"].includes(name)) {

        return true;
      }
      continue;
    }
    if (w.length > 1 && w.startsWith("-")) {
      for (let j = 1; j < w.length; j++) {
        const c = w[j];
        if (c === "e") {
          scripts.push(w.slice(j + 1) || (words[++i] ?? ""));
          named = true;
          break;
        }
        if (c === "l") {
          if (!w.slice(j + 1)) i++;
          break;
        }

        if (!"nrEsuzb".includes(c)) return true;
      }
      continue;
    }

    if (!named) {
      scripts.push(w);
      named = true;
    }
  }
  return scripts.some((script) => !sedScriptReads(script));
}

function gitNeedsExact(words          ) {
  for (let i = 1; i < words.length && words[i].startsWith("-"); i++) {
    const w = words[i];
    if (w === "-c" || /^--config-env(=.*)?$/.test(w) || /^--exec-path=/.test(w)) return true;
    if (w === "-C" || w === "--git-dir" || w === "--work-tree" || w === "--namespace") i++;
  }
  return words.some((w) => /^--(output|ext-diff)(=.*)?$/.test(w));
}

const GUESSED_PROTOCOL_HOST = /^(ftp|dict|ldap|imap|smtp|pop3)\./i;
const HTTP_URL = /^https?:\/\//i;

const SCHEMELESS_URL = /^([A-Za-z0-9._~-]+)(:[0-9]{1,5})?([/?#].*)?$/;
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function httpFetchUrl(url        ) {
  if (HTTP_URL.test(url)) return true;
  const plain = SCHEMELESS_URL.exec(url);
  return !!plain && !GUESSED_PROTOCOL_HOST.test(plain[1]);
}

const HEADER_LINE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+[:;]/;

function curlLeavesHttp(words          ) {
  if (words.some((w) => CONTROL_CHAR.test(w))) return true;
  const read = readFlags(READ_FLAGS.curl, words.slice(1));

  if (!read) return false;
  const valuesOf = (...names          ) => read.flags.filter((f) => names.includes(f.name)).map((f) => f.value ?? "");
  if (![...read.ops, ...valuesOf("url"), ...valuesOf("x", "proxy")].every(httpFetchUrl)) return true;
  return !valuesOf("H", "header").every((header) => HEADER_LINE.test(header));
}

function wgetLeavesHttp(words          ) {
  if (words.some((w) => CONTROL_CHAR.test(w))) return true;
  const read = readFlags(READ_FLAGS.wget, words.slice(1));
  return !!read && !read.ops.every((url) => HTTP_URL.test(url) ||
    (httpFetchUrl(url) && /^[^:/?#]+(:[0-9]{1,5})?(\/[^:]*)?$/.test(url)));
}

function dnsQueryLeavesDns(words          ) {
  const program = path.posix.basename(words[0] || "");
  const args = words.slice(1);
  if (args.some((w) => CONTROL_CHAR.test(w))) return true;
  if (program === "nslookup") {
    if (args.some((w) => /^-(p|po|por|port)(=|$)/i.test(w))) return true;

    const names = args.filter((w) => w === "-" || !w.startsWith("-"));
    return names.length === 0 || names[0] === "-";
  }

  return args.some((w) => /^-[^-]*[pf]/.test(w) || /^\+(tls|https|http-plain)/i.test(w));
}

function uniqWritesFile(words          ) {
  let operands = 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-f" || w === "-s" || w === "-w") i++;
    else if (!w.startsWith("-") || w === "-") operands++;
  }
  return operands >= 2;
}

function wgetOutputIsStdout(words          ) {
  const read = readFlags(READ_FLAGS.wget, words.slice(1));
  if (!read) return false;
  const outputs = read.flags.filter((flag) => flag.name === "O" || flag.name === "output-document");
  return outputs.length > 0 && outputs.every((flag) => flag.value === "-");
}

const WRITE_FLAGS                                               = {

  curl: (words) => words.some((w) => /^--(request|data|data-[a-z]+|form|form-string|upload-file|json|output|output-dir|remote-name|remote-name-all|dump-header|cookie-jar|config|trace|trace-ascii|libcurl|stderr|hsts|alt-svc|etag-save)(=.*)?$/.test(w) ||
    shortFlag(w, /[XdFTOocDK]/)) || curlLeavesHttp(words),

  wget: (words) => words.some((w) => /^--(post-data|post-file|method|body-data|body-file|delete-after|output-file|append-output|execute|config|save-cookies|warc-file|rejected-log)(=.*)?$/.test(w) ||
    shortFlag(w, /[oae]/)) || !wgetOutputIsStdout(words) || wgetLeavesHttp(words),
  dig: dnsQueryLeavesDns,
  host: dnsQueryLeavesDns,
  nslookup: dnsQueryLeavesDns,
  gh: (words) => words[1] === "api" && words.some((w) => /^(--method|--field|--raw-field|--input)(=.*)?$/.test(w) || /^-[XfF]/.test(w)),
  sed: sedNeedsExact,
  git: gitNeedsExact,
  sort: (words) => words.some((w) => /^(-o|--output(=.*)?)$/.test(w) || /^-o./.test(w) || /^--compress-program(=.*)?$/.test(w)),
  find: (words) => words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w)),

  rg: (words) => words.some((w) => /^--pre(=.*)?$/.test(w)),
  journalctl: (words) => words.some((w) =>
    /^--(vacuum-size|vacuum-time|vacuum-files|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)(=.*)?$/.test(w)),
  date: (words) => words.some((w) => /^--set(=.*)?$/.test(w) || /^-[uR]*s/.test(w)),
  hostname: (words) => words.slice(1).some((w) => !w.startsWith("-") || /^(-F|--file(=.*)?|-b|--boot)$/.test(w)),
  uniq: uniqWritesFile,
  file: (words) => words.some((w) => w === "--compile" || shortFlag(w, /C/)),
  sensors: (words) => words.some((w) => w === "--set" || shortFlag(w, /s/)),

  printf: (words) => words.slice(1).some((w) => /%[^%a-zA-Z]*[hlLqjzt]*n/.test(w.replace(/%%/g, ""))),
};

const ANY_FLAGS           = { any: true };

function parseShort(spec        ) {
  const out = new Map                ();
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === " " || c === ":") continue;
    let kind = 0;
    if (spec[i + 1] === ":") kind = spec[i + 2] === ":" ? 2 : 1;
    out.set(c, kind);
  }
  return out;
}

function parseLong(spec        ) {
  const out = new Map                ();
  for (const word of spec.split(/\s+/)) {
    if (!word) continue;
    const last = word[word.length - 1];
    if (last === "=" || last === "?") out.set(word.slice(0, -1), last);
    else out.set(word, "");
  }
  return out;
}

const parsedSpecs = new WeakMap                                                                     ();

function readFlags(spec          , args          )                                                                                 {
  let parsed = parsedSpecs.get(spec);
  if (!parsed) {
    parsed = { short: parseShort(spec.short || ""), long: parseLong(spec.long || "") };
    parsedSpecs.set(spec, parsed);
  }
  const ops           = [];
  const flags                                                = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--") {
      ops.push(...args.slice(i + 1));
      break;
    }
    if (w === "-" || !w.startsWith("-")) {
      ops.push(w);
      continue;
    }
    if (/^-[0-9]+$/.test(w)) continue;
    if (spec.single || w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = w.slice(spec.single && !w.startsWith("--") ? 1 : 2, eq < 0 ? undefined : eq);
      const kind = parsed.long.get(name);
      if (kind === undefined) return null;
      if (eq >= 0 && kind === "") return null;
      if (eq >= 0) flags.push({ name, value: w.slice(eq + 1) });
      else if (kind === "=") flags.push({ name, value: i + 1 < args.length ? args[++i] : null });
      else flags.push({ name, value: null });
      continue;
    }
    for (let j = 1; j < w.length; j++) {
      const kind = parsed.short.get(w[j]);
      if (kind === undefined) return null;
      if (kind === 1) {
        if (j === w.length - 1) flags.push({ name: w[j], value: i + 1 < args.length ? args[++i] : null });
        else flags.push({ name: w[j], value: w.slice(j + 1) });
        break;
      }
      if (kind === 2) {
        flags.push({ name: w[j], value: j === w.length - 1 ? null : w.slice(j + 1) });
        break;
      }
      flags.push({ name: w[j], value: null });
    }
  }
  return { ops, flags };
}

function flagsOnlyRead(spec          , args          ) {
  if (spec.any) return true;
  const read = readFlags(spec, args);
  if (!read) return false;
  return spec.operands ? spec.operands(read.ops) : true;
}

const GREP_FLAGS           = {
  short: "EFGPiywxvcLlonhHbqsrRzZaITU e:f:m:A:B:C:d:D:",
  long: "extended-regexp fixed-strings basic-regexp perl-regexp regexp= file= ignore-case no-ignore-case word-regexp " +
    "line-regexp invert-match count files-with-matches files-without-match only-matching line-number with-filename " +
    "no-filename byte-offset quiet silent recursive dereference-recursive null null-data text binary-files= include= " +
    "exclude= exclude-dir= exclude-from= color colour color? colour? max-count= after-context= before-context= context= " +
    "context? label= initial-tab no-messages devices= directories= line-buffered",
};

const READ_FLAGS                           = {
  ls: { short: "aAdlhtrRSFG1icsunmpQqxXvLHgoNTUZ I:w:T:",
    long: "all almost-all long human-readable reverse recursive sort= time= color color? classify classify? full-time " +
      "group-directories-first inode size directory dereference dereference-command-line ignore= hide= format= " +
      "time-style= width= literal quoting-style= tabsize= indicator-style= si numeric-uid-gid no-group author " +
      "file-type escape hide-control-chars show-control-chars ignore-backups context zero" },
  cat: { short: "AbeEnstTuv", long: "show-all number number-nonblank squeeze-blank show-ends show-tabs show-nonprinting" },
  head: { short: "qvz n:c:", long: "lines= bytes= quiet silent verbose zero-terminated" },
  tail: { short: "qvzfF n:c:s:",
    long: "lines= bytes= quiet silent verbose zero-terminated follow follow? retry pid= sleep-interval= max-unchanged-stats=" },
  wc: { short: "lwcmL", long: "lines words bytes chars max-line-length total= files0-from=" },
  grep: GREP_FLAGS, egrep: GREP_FLAGS, fgrep: GREP_FLAGS,
  rg: { short: "iSsFwxvclnNHoqLuUz.aIpb0 e:f:g:t:T:m:A:B:C:j:M:E:d:r:",
    long: "ignore-case smart-case case-sensitive fixed-strings word-regexp line-regexp invert-match count count-matches " +
      "files files-with-matches files-without-match line-number no-line-number with-filename no-filename only-matching " +
      "quiet hidden no-hidden no-ignore no-ignore-vcs no-ignore-parent no-ignore-dot no-ignore-global follow glob= iglob= " +
      "type= type-not= max-count= after-context= before-context= context= json vimgrep heading no-heading color= colors= " +
      "pretty sort= sortr= max-depth= max-filesize= multiline multiline-dotall trim column no-column no-messages stats " +
      "null text unrestricted regexp= file= encoding= threads= passthru replace= max-columns= max-columns-preview " +
      "type-list debug byte-offset no-filename-separator? path-separator= null-data one-file-system search-zip " +
      "crlf invert-match ignore-file= no-config files-without-match" },
  df: { short: "ahHiklPTx t:B:", long: "all human-readable si inodes local portability print-type total type= " +
    "exclude-type= output output? block-size=" },
  du: { short: "abcDhHkLlmPsSx0 d:B:t:X:", long: "all apparent-size bytes total dereference-args dereference human-readable " +
    "si inodes count-links max-depth= no-dereference null separate-dirs summarize threshold= time time? time-style= " +
    "exclude= exclude-from= one-file-system block-size=" },
  free: { short: "bkmghlLtwv s:c:", long: "bytes kibi mebi gibi tebi pebi kilo mega giga tera peta human si lohi " +
    "line total wide committed seconds= count=" },
  uptime: { short: "psh", long: "pretty since" },

  date: { short: "uR d:f:r:I::", long: "utc universal rfc-email rfc-3339= iso-8601 iso-8601? date= file= reference= debug",
    operands: (ops) => ops.every((op) => op.startsWith("+")) },
  whoami: { long: "help version" },

  hostname: { short: "AadfiIsy", long: "alias all-fqdns all-ip-addresses domain fqdn long ip-address short yp nis",
    operands: (ops) => ops.length === 0 },
  uname: { short: "asnrvmpio", long: "all kernel-name nodename kernel-release kernel-version machine processor " +
    "hardware-platform operating-system" },
  ps: ANY_FLAGS, pwd: { short: "LP" }, echo: { short: "neE" },

  printf: {},
  test: ANY_FLAGS,
  stat: { short: "LfQt c:", long: "dereference file-system format= printf= terse cached=" },
  file: { short: "bcdEhiklLNnprsSvzZ0 e:F:f:m:P:", long: "brief mime mime-type mime-encoding keep-going list " +
    "dereference no-dereference no-pad print0 raw special-files uncompress uncompress-noreport separator= files-from= " +
    "magic-file= exclude= exclude-quiet= extension apple parameter=" },
  which: { short: "as" },
  true: {}, false: {},
  nproc: { long: "all ignore=" },
  id: { short: "gGnruzZa" },
  groups: {},
  lsblk: ANY_FLAGS, lscpu: ANY_FLAGS,
  sensors: { short: "Aujfv c:", long: "no-adapter config-file= fahrenheit bus-list" },
  vmstat: ANY_FLAGS, iostat: ANY_FLAGS, jq: ANY_FLAGS, column: ANY_FLAGS, seq: ANY_FLAGS,
  cut: { short: "nsz b:c:d:f:", long: "bytes= characters= delimiter= fields= complement only-delimited " +
    "output-delimiter= zero-terminated" },
  tr: { short: "cCdst", long: "complement delete squeeze-repeats truncate-set1" },

  uniq: { short: "cdDiuz f:s:w:", long: "count repeated all-repeated all-repeated? ignore-case unique zero-terminated " +
    "skip-fields= skip-chars= check-chars= group group?", operands: (ops) => ops.length <= 1 },

  sort: { short: "bdfgiMhnRrsuVcCmz k:t:S:", long: "ignore-leading-blanks dictionary-order ignore-case " +
    "general-numeric-sort ignore-nonprinting month-sort human-numeric-sort numeric-sort random-sort reverse stable " +
    "unique version-sort check check? merge zero-terminated key= field-separator= buffer-size= parallel= sort= debug " +
    "random-source=" },
  basename: { short: "az s:", long: "multiple suffix= zero" },
  dirname: { short: "z", long: "zero" },
  realpath: ANY_FLAGS, readlink: ANY_FLAGS,
  journalctl: { short: "abefklmqrx n:u:S:U:o:p:t:D:M:g:",
    long: "unit= user-unit= lines lines? follow since= until= boot boot? output= priority= identifier= grep= reverse " +
      "no-pager quiet catalog all utc dmesg list-boots no-hostname case-sensitive? directory= machine= user system " +
      "disk-usage field= fields output-fields= cursor= after-cursor= show-cursor merge pager-end no-tail file=" },

  curl: { short: "sSfLIkvi46#NgqZGlj H:A:e:m:u:x:r:b:y:Y:C:E:U:z:",
    long: "silent show-error fail fail-with-body location location-trusted head insecure verbose include ipv4 ipv6 " +
      "compressed http1.1 http2 http3 header= user-agent= referer= max-time= connect-timeout= retry= retry-delay= " +
      "retry-max-time= retry-all-errors user= proxy= range= cookie= cacert= cert= key= get globoff no-buffer " +
      "progress-bar no-progress-meter max-redirs= url= raw tcp-nodelay resolve= noproxy= oauth2-bearer= netrc " +
      "netrc-optional basic digest ntlm anyauth negotiate limit-rate= max-filesize= keepalive-time= " +
      "dns-servers= interface= tlsv1.2 tlsv1.3 ssl-no-revoke url-query= no-keepalive" },

  wget: { short: "qvSncdH46 O:T:t:w:U:",
    long: "quiet verbose no-verbose server-response output-document= timeout= tries= wait= user-agent= header= " +
      "no-check-certificate content-on-error inet4-only inet6-only max-redirect= no-cache no-cookies https-only " +
      "compression= user= password= referer= load-cookies= ca-certificate= retry-connrefused waitretry= " +
      "read-timeout= connect-timeout= dns-timeout= limit-rate= secure-protocol= no-proxy progress= show-progress " +
      "no-dns-cache" },

  find: { single: true, short: "",
    long: "name= iname= type= xtype= path= ipath= wholename= iwholename= regex= iregex= regextype= maxdepth= mindepth= " +
      "mtime= mmin= atime= amin= ctime= cmin= newer= anewer= cnewer= size= empty user= group= uid= gid= perm= links= " +
      "inum= samefile= readable writable executable lname= ilname= print print0 printf= ls prune quit not a o and or " +
      "true false depth follow xdev mount noleaf daystart nouser nogroup used= fstype= L H P" },
  dig: ANY_FLAGS, host: ANY_FLAGS, nslookup: ANY_FLAGS, ping: ANY_FLAGS,
};

const READ_VERB_FLAGS                           = {

  git: { short: "pscuzMCBRwbatrmlqvdoeiINEFPWh1 n:S:G:L:U:x:X:O:",
    long: "stat stat? shortstat numstat name-only name-status oneline pretty pretty? format= graph decorate decorate? " +
      "all branches branches? tags tags? remotes remotes? since= until= after= before= author= committer= grep= " +
      "all-match invert-grep regexp-ignore-case extended-regexp fixed-strings perl-regexp max-count= skip= reverse " +
      "first-parent merges no-merges follow patch no-patch unified= raw patch-with-stat cached staged color color? " +
      "no-color word-diff word-diff? ignore-all-space ignore-space-change ignore-blank-lines minimal patience " +
      "histogram diff-algorithm= abbrev abbrev? abbrev-commit no-abbrev-commit relative relative? relative-date date= " +
      "find-renames find-renames? find-copies find-copies? diff-filter= check summary dirstat dirstat? exit-code quiet " +
      "short short? long branch porcelain porcelain? untracked-files untracked-files? ignored ignored? " +
      "ignore-submodules ignore-submodules? ahead-behind no-ahead-behind show-stash verbose source full-history " +
      "simplify-by-decoration show-signature no-renames binary full-index src-prefix= dst-prefix= no-prefix " +
      "line-prefix= merge-base abbrev-ref abbrev-ref? verify symbolic symbolic-full-name show-toplevel show-prefix " +
      "git-dir git-common-dir is-inside-work-tree is-bare-repository absolute-git-dir others modified deleted stage " +
      "exclude-standard error-unmatch full-name recurse-submodules exclude= exclude-from= killed directory " +
      "no-empty-directory show-email show-name show-number line-porcelain incremental root encoding= dirty dirty? " +
      "always exact-match match= candidates= no-walk no-walk? cherry-pick left-right boundary topo-order date-order " +
      "author-date-order mailmap no-mailmap use-mailmap log-size no-decorate notes no-notes expand-tabs no-expand-tabs " +
      "ignore-cr-at-eol ignore-space-at-eol function-context inter-hunk-context= text name-rev no-color-moved " +
      "color-moved color-moved? column column? no-column z null" },
  gh: { short: "wicdp R:L:s:a:A:l:B:H:S:q:t:b:",
    long: "repo= limit= state= assignee= author= label= base= head= search= web json json? jq= template= comments " +
      "draft app= mention= milestone= branch= workflow= status= event= user= commit= log log-failed exit-status " +
      "interval= job= attempt= verbose include header= preview= paginate slurp cache= silent hostname= created= " +
      "order= sort= language= owner= visibility= archived watch required fail-fast name-only patch color= " +
      "exclude-drafts exclude-pre-releases show-token active" },
  docker: { short: "aqstl f:n:", long: "all quiet size filter= format= no-trunc last= latest tail= since= until= " +
    "timestamps follow details type= no-stream digests services status=" },
  podman: { short: "aqstl f:n:", long: "all quiet size filter= format= no-trunc last= latest tail= since= until= " +
    "timestamps follow details type= no-stream digests" },
  kubectl: { short: "Awfp n:o:l:c:L:", long: "namespace= all-namespaces output= selector= field-selector= watch " +
    "watch-only show-labels sort-by= label-columns= context= cluster= tail= follow previous since= since-time= " +
    "timestamps container= all-containers chunk-size= no-headers show-kind ignore-not-found containers client short" },
  systemctl: { short: "alq t:n:o:", long: "user system no-pager full all type= state= lines= output= plain no-legend " +
    "quiet value" },
  npm: { short: "agpl", long: "depth= json all global long parseable prod production dev omit= include= " +
    "workspace= workspaces link unicode" },
  tailscale: { short: "146", long: "json peers self active" },
  brew: { short: "1lrtv", long: "versions cask casks formula formulae json json? installed multiple pinned full-name " +
    "verbose quiet greedy greedy-latest greedy-auto-updates" },
  pip: { short: "oulvef", long: "outdated uptodate local user format= not-required verbose files editable " +
    "exclude-editable include-editable pre exclude=" },
  openclaw: { short: "v", long: "json verbose all" },
  hermes: { short: "v", long: "json verbose all" },
  gcalcli: { short: "w:", long: "nocolor calendar= details= tsv military nodeclined nostarted width= monday " +
    "noweekend nolineart lineart= refresh nocache locale= conky" },
};

function readCommandHasOtherFlags(program        , words          ) {
  if (program === "sed") return false;
  if (READ_PROGRAMS.has(program)) return !flagsOnlyRead(own(READ_FLAGS, program) || {}, words.slice(1));
  const sub = verbWords(program, words);
  if (!sub || !terminalProgramReads({ program, sub })) return false;
  return !flagsOnlyRead(own(READ_VERB_FLAGS, program) || {}, words.slice(1 + sub.split(" ").length));
}

function needsExactWords(words          ) {
  const program = path.posix.basename(words[0] || "");
  if (RUNS_ANOTHER.has(program) || (program === "command" && words[1] !== "-v" && words[1] !== "-V")) return true;
  if (words.slice(1).some((word) => WRITE_ANYWHERE.test(word))) return true;

  if (program === "curl" && words.some((w) => /^--write-out(=.*)?$/.test(w) || shortFlag(w, /w/))) return true;
  const flags = own(WRITE_FLAGS, program);
  if (typeof flags === "function" && flags(words)) return true;
  if (verbHiddenByOption(program, words)) return true;
  return readCommandHasOtherFlags(program, words);
}

function verbHiddenByOption(program        , words          ) {
  const nested = own(NESTED_VERBS, program);
  if (nested === undefined) return false;
  const depth = typeof nested === "number" ? nested : nested.has(words[1]) ? 2 : 1;
  const sub = verbWords(program, words);
  const taken = sub ? sub.split(" ").length : 0;
  if (taken >= depth) return false;
  const next = words[1 + taken];
  return typeof next === "string" && next.startsWith("-") && words.slice(2 + taken).some((w) => PLAIN_WORD.test(w));
}

function verbWords(program        , words          ) {
  const out           = [];
  const nested = own(NESTED_VERBS, program);
  const depth = typeof nested === "number" ? nested : nested && nested.has(words[1]) ? 2 : 1;
  for (let i = 1; i <= depth && i < words.length && PLAIN_WORD.test(words[i]); i++) out.push(words[i]);
  return out.length ? out.join(" ") : null;
}

function inlineCodeProgram(word        ) {
  const base = path.posix.basename(word).toLowerCase().replace(/\.exe$/, "");
  return base.replace(/^(python|pypy)[0-9.]*$/, "$1");
}

function runsInlineCode(words          ) {
  for (let i = 0; i < words.length; i++) {
    const program = inlineCodeProgram(words[i]);
    if (program === "eval") return true;
    const flags = own(INLINE_CODE_FLAGS, program);
    if (flags instanceof RegExp && words.slice(i + 1).some((word) => flags.test(word))) return true;
  }
  return false;
}

const SHELL_EXPANSION = /\$[({'"[]|`|[<>]\(/;

const ARITH_TEST_OPS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

const SHELL_STATE = new Set(["export", "alias", "unalias", "source", ".", "declare", "typeset", "local", "readonly",
  "unset", "set", "shopt", "trap", "hash", "enable", "function", "read", "mapfile", "readarray", "let", "ulimit", "umask", "getopts",

  "wait", "fc", "history", "compgen", "complete", "bind"]);

const SHELL_DIRECTORY = new Set(["cd", "pushd", "popd"]);

function shellLeadWords(words          ) {
  const out = [...words];
  while (out.length && SHELL_LEADS.has(out[0])) out.shift();
  if (out.length && SHELL_ENDS.has(out[0])) out.shift();
  return out;
}

function shellProgramWords(words          ) {
  const out = shellLeadWords(words);
  if (out.length && SHELL_LOOP_HEADS.has(out[0])) return [];
  return programWords(out);
}

function programWords(words          ) {
  const out = [...words];
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  while (out.length && assignment.test(out[0])) out.shift();
  if (out[0] === "env") {
    out.shift();
    while (out.length && assignment.test(out[0])) out.shift();
  }
  return out;
}

function terminalUseKeys(command     )                                                                                                                    {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) return { keys: [], exact: false, programs: [] };

  if (text.length > TERMINAL_PARSE_MAX || text.includes("\u0000")) return { keys: [exactKey(text)], exact: true, programs: [] };
  const split = shellCommands(text);
  const { commands } = split;

  let exact = split.exact || SHELL_EXPANSION.test(text) || commands.some((words) => words.some((w) => SHELL_EXPANSION.test(w)));

  if (/[$\\]/.test(text)) exact = true;
  const programs                                                 = [];
  let changedDirectory = false;
  for (const raw of commands) {
    if (runsInlineCode(raw) || raw[0] === "case") exact = true;

    const lead = shellLeadWords(raw);
    if (lead.length && (SHELL_ASSIGNMENT.test(lead[0]) || path.posix.basename(lead[0]) === "env" || SHELL_STATE.has(lead[0]))) {
      exact = true;
    }

    if (changedDirectory) exact = true;
    if (lead.length && SHELL_DIRECTORY.has(lead[0])) changedDirectory = true;

    if ((lead[0] === "for" || lead[0] === "select") && lead.slice(1).some((w) => /[*?[]/.test(w))) exact = true;

    if ((lead[0] === "for" || lead[0] === "select") && !/^[a-z][a-z0-9]*$/.test(lead[1] || "")) exact = true;
    if (raw.includes("[[") && raw.some((w) => ARITH_TEST_OPS.has(w))) exact = true;
    if ((lead[0] === "test" || lead[0] === "[" || lead[0] === "[[") && raw.some((w) => w === "-v" || w === "-R")) exact = true;

    if (lead.length && /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?[<>]|^&>/.test(lead[0])) exact = true;
    const words = shellProgramWords(raw);
    if (!words.length) continue;

    if (words[0].startsWith("-")) exact = true;

    if (words[0] === "[" || words[0] === "[[") {
      programs.push({ program: "test", sub: null });
      continue;
    }
    const program = part(path.posix.basename(words[0]), 64);
    if (!program) continue;

    if (/[*?[\]]/.test(words[0]) || (words[0].includes("/") && !TRUSTED_BIN_DIRS.has(path.posix.dirname(words[0])))) exact = true;
    if (needsExactWords(words)) exact = true;
    programs.push({ program, sub: verbWords(program, words) });
  }
  if (exact) {

    return { keys: [exactKey(text)], exact: true, programs, ...(split.patterns.length ? { patterns: split.patterns } : {}) };
  }
  const keys = [...new Set(programs.map(({ program, sub }) => `terminal:${sub ? `${program} ${sub}` : program}`))];
  return { keys, exact: false, programs };
}

function classifyTaskStep({ host, toolName, args, mcp, glassesTools }     )      {
  const name = typeof toolName === "string" ? toolName.trim() : "";
  const side = host === "hermes" ? "hermes" : "openclaw";
  if (!name) return { class: "never" };
  const mcpServer = own(mcp, "server");
  const mcpTool = own(mcp, "tool");
  if (isPlainObject(mcp) && typeof mcpServer === "string" && typeof mcpTool === "string") {
    const server = part(mcpServer, 64) || "mcp";
    const tool = part(mcpTool, 64) || name;

    const given = own(mcp, "annotations");
    const hints = isPlainObject(given) ? given : {};
    const readOnlyHint = own(hints, "readOnlyHint");
    const destructiveHint = own(hints, "destructiveHint");
    const ownerWrite = own(mcp, "ownerWrite") === true;
    if (readOnlyHint === true && destructiveHint !== true && !ownerWrite) return { class: "read" };

    const change = destructiveHint === true || readOnlyHint === false || ownerWrite;
    return {
      class: "step", kind: "mcp", keys: [`mcp:${server}:${tool}`], server, tool, change,
      detail: detailOf(args),
    };
  }
  if (isDeliveryStep(name, args)) return { class: "read", delivery: true };
  if (glassesTools instanceof Set && glassesTools.has(name)) return { class: "never", tool: name };
  if (NEVER[side].has(name) || NEVER_PREFIX[side]?.test(name)) return { class: "never", tool: name };
  if (READS[side].has(name)) return { class: "read" };
  if (TERMINAL[side].has(name)) {

    const command = firstArg(args, COMMAND_ARGS);
    const { keys, programs, exact, patterns } = terminalUseKeys(rawFirstArg(args, COMMAND_ARGS));
    if (!keys.length) return { class: "step", kind: "tool", keys: [`tool:${name}`], tool: name, change: true, detail: command };
    const first = programs[0] || { program: "", sub: null };

    return {
      class: "step", kind: "terminal", keys, tool: name, program: first.program, sub: exact ? null : first.sub,
      exact, change: exact || !programs.every(terminalProgramReads), detail: command,

      ...(patterns ? { pattern: true, patternWords: patterns } : {}),
    };
  }
  if (SENDS[side].has(name)) {

    const ownAction = own(args, "action");
    const action = typeof ownAction === "string" ? ownAction : "send";
    if (action === "list") return { class: "read" };
    const destination = firstArg(args, DESTINATION_ARGS) || "default";
    return {
      class: "step", kind: "send", keys: [`send:${name}:${destination.slice(0, PART_MAX)}`], tool: name, destination,
      change: true, detail: firstArg(args, MESSAGE_ARGS),
    };
  }
  return { class: "step", kind: "tool", keys: [`tool:${name}`], tool: name, change: true, detail: detailOf(args) };
}

const READ_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "df", "du", "free",
  "uptime", "date", "whoami", "hostname", "uname", "ps", "pwd", "echo", "printf", "test", "stat", "file", "which",
  "true", "false", "nproc", "id", "groups", "lsblk", "lscpu", "sensors", "vmstat", "iostat", "jq", "cut", "tr", "uniq",
  "sort", "column", "basename", "dirname", "realpath", "readlink", "seq", "journalctl", "curl", "wget", "find",
  "dig", "host", "nslookup", "ping", "sed"]);
const READ_VERBS = new Set([
  "gh pr list", "gh pr view", "gh pr status", "gh pr checks", "gh pr diff", "gh issue list", "gh issue view",
  "gh issue status", "gh run list", "gh run view", "gh run watch", "gh repo view", "gh repo list", "gh release list",
  "gh release view", "gh auth status", "gh api", "gh search repos", "gh search issues", "gh search prs", "gh search code",
  "git status", "git log", "git diff", "git show", "git rev-parse", "git ls-files", "git blame", "git describe",
  "docker ps", "docker logs", "docker images", "docker inspect", "docker stats", "docker version", "docker info",
  "docker compose ps", "docker compose logs", "docker container ls", "docker container logs", "docker container inspect",
  "docker image ls", "podman ps", "podman logs", "podman images", "kubectl get", "kubectl describe", "kubectl logs",
  "kubectl top", "kubectl version", "systemctl status", "systemctl is-active", "systemctl is-enabled",
  "systemctl list-units", "systemctl list-timers", "npm ls", "npm view", "npm outdated", "tailscale status", "tailscale ip",
  "brew list", "brew info", "brew outdated", "pip list", "pip show", "openclaw status", "hermes status", "gcalcli agenda",
  "gcalcli calw", "gcalcli calm", "gcalcli search", "gcalcli list",
]);

function terminalProgramReads({ program, sub }                                         ) {
  if (READ_PROGRAMS.has(program)) return true;
  if (!sub) return false;
  const words = sub.split(" ");
  for (let n = words.length; n > 0; n--) if (READ_VERBS.has(`${program} ${words.slice(0, n).join(" ")}`)) return true;
  return false;
}

function hostCommandWordsFacts(words          ) {
  const program = path.posix.basename(words[0] || "");
  const inline = runsInlineCode(words);
  const exact = needsExactWords(words);
  const sub = verbWords(program, words);
  return { program, sub, inline, exact, reads: !inline && !exact && terminalProgramReads({ program, sub }) };
}

function terminalKeyReads(key        ) {
  if (!key.startsWith("terminal:")) return false;
  const [program, ...rest] = key.slice("terminal:".length).split(" ");
  return terminalProgramReads({ program, sub: rest.length ? rest.join(" ") : null });
}

function detailOf(args     ) {
  if (!isPlainObject(args)) return null;

  const text = firstArg(args, [...COMMAND_ARGS, "path", "file_path", "url", "query", ...MESSAGE_ARGS]);
  if (text) return text;
  try {
    return JSON.stringify(args).slice(0, DETAIL_MAX);
  } catch (_) {
    return null;
  }
}

function taskStepMcpFacts(host        , mcp     , marks      = null) {
  const server = own(mcp, "server");
  const tool = own(mcp, "tool");
  if (!isPlainObject(mcp) || typeof server !== "string" || typeof tool !== "string") return null;

  const ownAnnotations = own(mcp, "annotations");
  const given = isPlainObject(ownAnnotations) ? ownAnnotations : {};
  const readMarked = marks?.readMarked === true && marks?.listed === true && marks?.destructive !== true &&
    marks?.writeMarked !== true;
  const annotations = host === "openclaw"
    ? readMarked
      ? { readOnlyHint: true }
      : !(marks?.listed === true && marks?.cardsOn === true) && own(mcp, "listed") === true
        ? given
        : {
          ...(marks?.destructive === true ? { destructiveHint: true } : {}),
          ...(marks?.writeMarked === true || marks?.listed !== true ? { readOnlyHint: false } : {}),
        }
    : given;
  return { server, tool, annotations, ownerWrite: own(mcp, "ownerWrite") === true || marks?.ownerWrite === true };
}

function decideTaskStep({ record, mode, step }     )                                                    {
  if (!step || step.class === "read") return { allow: true };

  if (step.class === "never") return { allow: false, why: "never", needs: false };
  const entries = Array.isArray(record?.entries) ? record.entries : [];
  const listed = new Set(entries.map((entry     ) => entry.key));
  const onList = Array.isArray(step.keys) && step.keys.length > 0 && step.keys.every((key        ) => listed.has(key));

  const change = step.kind === "terminal" && onList
    ? step.keys.some((key        ) => entries.find((entry     ) => entry.key === key)?.change !== false)
    : step.change;
  if (mode === "open" && change) return { allow: false, why: "open_run_no_change", needs: false };
  if (onList) return { allow: true };

  const keptOff = new Set(record?.keptOff || []);
  if (Array.isArray(step.keys) && keptOff.has(step.keys.join("+"))) return { allow: false, why: "kept_off", needs: false };
  if (mode === "test" && step.kind === "send") return { allow: false, why: "held_send", needs: true };
  return { allow: false, why: "not_on_list", needs: true };
}

function taskStepRefusal(why        , step     ) {
  const text = stepRefusalText(why, step);
  return why === "not_on_list" || why === "open_run_no_change" ? `${text}${patternHint(step)}` : text;
}

function patternHint(step     ) {
  const words = step && step.kind === "terminal" && step.pattern === true && Array.isArray(step.patternWords)
    ? step.patternWords.filter((word     ) => typeof word === "string" && word && !word.includes("'") && word.length <= 120)
    : [];
  if (!words.length) return "";
  const word = words[0];

  return ` Its word ${word} has a ?, * or [ outside quotes, so the shell may turn it into file names. If it should ` +
    `reach the program as written (a URL with ?, say), run the command again with that word in single quotes: '${word}'`;
}

function stepRefusalText(why        , step     ) {
  const what = stepWords(step);
  if (why === "never") {
    return `${TASK_USES_NOT_OFFERED}: a Task run may not ${what}. Skip this step and carry on without it.`;
  }
  if (why === "open_run_no_change") {
    return `${TASK_USES_NOT_ON_OPEN}: this run started when the wearer opened the card, and it never sends or changes ` +
      `anything, so it skipped ${what}. Carry on without it; the Task's schedule does it.`;
  }
  if (why === "held_send") {
    return `${TASK_USES_NOT_ALLOWED}: this is a test run, so OcuClaw saved this message for the owner to check and ` +
      "did not send it. Finish, and don't send it another way.";
  }
  if (why === "kept_off") {
    return `${TASK_USES_NOT_ALLOWED}: this Task's owner chose to keep it from ${what}, so it was left out. Carry on, ` +
      "and say in one short line what is missing.";
  }
  return `${TASK_USES_NOT_ALLOWED}: this Task's owner hasn't allowed it to ${what} yet, so it was left out. Carry on, ` +

    "and say in one short line what is missing. The owner is asked to allow it on their glasses or phone.";
}

function stepWords(step     ) {
  if (!step) return "take this step";
  if (step.kind === "mcp") return `use ${step.server} · ${step.tool}`;
  if (step.kind === "send") return `send with ${step.tool} to ${step.destination}`;
  if (step.kind === "terminal") return step.exact ? `run "${step.detail}"` : `run ${step.keys.map((key        ) => key.replace(/^terminal:/, "")).join(", ")}`;

  return typeof step.tool === "string" && step.tool ? `use ${step.tool}` : "take this step";
}

function cleanKey(value     ) {
  return typeof value === "string" && value.length > 0 && value.length <= KEY_MAX && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function curateUse(raw     , withDetail         ) {
  if (!isPlainObject(raw) || !TASK_USE_KINDS.includes(raw.kind)) return null;
  const keys = Array.isArray(raw.keys) ? raw.keys.map(cleanKey).filter(Boolean).slice(0, 8) : [];
  const key = cleanKey(raw.key) || keys.join("+");
  if (!cleanKey(key) || !keys.length) return null;

  const marked = raw.marked === true && !withDetail;
  const change = raw.change === true || (raw.kind === "terminal" && !marked && !keys.every(terminalKeyReads));
  const out      = { key, keys, kind: raw.kind, change, atMs: finiteMs(raw.atMs) ?? 0 };
  for (const name of ["server", "tool", "destination", "program", "sub"]) {
    const value = part(raw[name]);
    if (value) out[name] = value;
  }
  if (raw.exact === true) out.exact = true;
  if (marked) out.marked = true;
  if (withDetail) {
    const detail = part(raw.detail, DETAIL_MAX);
    if (detail) out.detail = detail;
    out.count = Number.isSafeInteger(raw.count) && raw.count > 0 ? Math.min(raw.count, 999) : 1;
  } else {
    out.via = raw.via === "test" ? "test" : "ok";
  }
  return out;
}

function taskUseOfStep(step     , atMs        , extra      = {}) {
  if (!step || step.class !== "step") return null;
  return curateUse({ ...step, key: step.keys.join("+"), atMs, ...extra }, extra.detail !== undefined || extra.count !== undefined);
}

function defaultRecord(taskId        ) {
  return { schemaVersion: 1, taskId, held: true, entries: []         , needs: []         , keptOff: []          };
}

function validRecord(raw     , taskId        ) {
  const record = defaultRecord(taskId);
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || raw.taskId !== taskId) return record;
  const seen = new Set        ();
  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {

    if (isPlainObject(entry) && Object.keys(entry).some((field) => !USE_FIELDS.includes(field))) continue;
    const use = curateUse(entry, false);
    if (!use || seen.has(use.key)) continue;
    seen.add(use.key);

    record.entries.push(use);
  }
  record.entries = record.entries.slice(0, TASK_USES_ENTRIES_MAX);
  for (const need of Array.isArray(raw.needs) ? raw.needs : []) {
    const use = curateUse(need, true);
    if (use && !record.needs.some((other     ) => other.key === use.key)) record.needs.push(use);
  }
  record.needs = record.needs.slice(-TASK_USES_NEEDS_MAX);
  for (const off of Array.isArray(raw.keptOff) ? raw.keptOff : []) {
    const use = curateUse(off, false);
    if (use && !record.keptOff.some((other     ) => other.key === use.key)) record.keptOff.push(use);
  }
  record.keptOff = record.keptOff.slice(-TASK_USES_ENTRIES_MAX);
  return record;
}

const USE_FIELDS = ["key", "keys", "kind", "change", "atMs", "server", "tool", "destination", "program", "sub", "exact", "marked", "via"];

const TASK_USES_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "taskId", "held", "entries", "needs", "keptOff"],
  lists: {
    entries: { by: "key", fields: USE_FIELDS },
    needs: { by: "key", fields: [...USE_FIELDS.filter((field) => field !== "marked" && field !== "via"), "detail", "count"] },
    keptOff: { by: "key", fields: USE_FIELDS },
  },
});

function entryKeys(record     ) {
  return record.entries.flatMap((entry     ) => entry.keys.map((key        ) => ({ key, change: entry.change === true })));
}

function createTaskUsesStore(opts      = {}) {
  const memory                          = opts.memory instanceof Map ? opts.memory : null;
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = memory ? "" : resolveLiveuiLibraryRoot(opts.libraryDir);
  const dir = memory ? "" : path.join(libraryDir, TASK_USES_DIR);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const fileFor = (taskId        ) => path.join(dir, `${taskId}.json`);

  function read(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return null;
    let raw      = null;
    try {
      raw = memory ? JSON.parse(memory.get(taskId) ?? "null") : JSON.parse(fs.readFileSync(fileFor(taskId), "utf8"));
    } catch (_) {
      raw = null;
    }
    return validRecord(raw, taskId);
  }

  function write(record     ) {
    if (memory) {
      memory.set(record.taskId, JSON.stringify(record));
      return true;
    }

    let before      = null;
    try {
      before = JSON.parse(fs.readFileSync(fileFor(record.taskId), "utf8"));
    } catch (_) {
      before = null;
    }

    const from = isPlainObject(before) && before.schemaVersion === 1 && before.taskId === record.taskId
      ? { ...before, entries: [] }
      : null;
    const kept = from && hasUnknownFields(from, TASK_USES_SAVED_SHAPE)
      ? carryUnknownFields(from, record, TASK_USES_SAVED_SHAPE)
      : record;
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: fileFor(record.taskId), record: kept }).status === "written";
  }

  function update(taskId     , change                                 ) {
    const record = read(taskId);
    if (!record) return null;
    if (change(record) === false) return record;
    return write(record) ? record : null;
  }

  function policy(taskId     ) {
    const record = read(taskId);
    return record ? { held: record.held, entries: entryKeys(record), keptOff: record.keptOff.map((off     ) => off.key) } : null;
  }

  return {
    dir,
    read,
    policy,

    allow(taskId     , step     , via                = "ok") {
      const use = taskUseOfStep(step, now(), { via });
      if (!use) return null;
      return update(taskId, (record) => {
        record.held = true;
        record.needs = record.needs.filter((need     ) => need.key !== use.key);
        if (record.entries.some((entry     ) => entry.key === use.key)) return;
        if (record.entries.length >= TASK_USES_ENTRIES_MAX) return false;
        record.entries.push(use);
      });
    },

    remove(taskId     , key     ) {
      const clean = cleanKey(key);
      if (!clean) return null;
      const before = read(taskId);
      if (!before || !before.entries.some((entry     ) => entry.key === clean)) return { status: "missing", record: before };
      const saved = update(taskId, (record) => {
        record.entries = record.entries.filter((entry     ) => entry.key !== clean);
      });
      return saved ? { status: "removed", record: saved } : null;
    },

    markEntry(taskId     , key     , change     ) {
      const clean = cleanKey(key);
      if (!clean || typeof change !== "boolean") return null;
      const before = read(taskId);
      const entry = before?.entries.find((item     ) => item.key === clean);
      if (!entry || entry.kind !== "terminal") return { status: "missing", record: before };
      const saved = update(taskId, (record) => {
        const target = record.entries.find((item     ) => item.key === clean);
        if (!target || target.change === change) return false;
        target.change = change;
        target.marked = true;
      });
      return saved ? { status: "marked", record: saved } : { status: "marked", record: before };
    },

    noteNeeds(taskId     , step     , atMs         = now()) {
      if (!step || step.class !== "step") return null;
      const key = step.keys.join("+");
      return update(taskId, (record) => {
        const prior = record.needs.find((need     ) => need.key === key);
        const use = taskUseOfStep(step, atMs, { detail: step.detail ?? "", count: (prior?.count || 0) + 1 });
        if (!use) return false;
        record.needs = [...record.needs.filter((need     ) => need.key !== key), use].slice(-TASK_USES_NEEDS_MAX);
      });
    },

    allowNeeds(taskId     , key     ) {
      const clean = cleanKey(key);
      const before = clean ? read(taskId) : null;
      const need = before?.needs.find((entry     ) => entry.key === clean) ||
        before?.keptOff.find((entry     ) => entry.key === clean);
      if (!need) return { status: "missing", record: before };
      const saved = update(taskId, (record) => {
        record.held = true;
        record.needs = record.needs.filter((entry     ) => entry.key !== clean);
        record.keptOff = record.keptOff.filter((entry     ) => entry.key !== clean);
        if (!record.entries.some((entry     ) => entry.key === clean) && record.entries.length < TASK_USES_ENTRIES_MAX) {
          const { detail: _detail, count: _count, ...rest } = need;
          record.entries.push({ ...rest, atMs: now(), via: "ok" });
        }
      });
      return saved ? { status: "allowed", record: saved } : null;
    },

    keepOffNeeds(taskId     , key     ) {
      const clean = cleanKey(key);
      const before = clean ? read(taskId) : null;
      const need = before?.needs.find((entry     ) => entry.key === clean);
      if (!need) return { status: "missing", record: before };
      const saved = update(taskId, (record) => {
        record.held = true;
        record.needs = record.needs.filter((entry     ) => entry.key !== clean);
        const { detail: _detail, count: _count, ...rest } = need;
        record.keptOff = [...record.keptOff.filter((entry     ) => entry.key !== clean), { ...rest, atMs: now() }]
          .slice(-TASK_USES_ENTRIES_MAX);
      });
      return saved ? { status: "kept_off", record: saved } : null;
    },

    reopen(taskId     , key     , asked     ) {
      const clean = cleanKey(key);
      const need = clean && asked && asked.key === clean ? curateUse(asked, true) : null;
      if (!need) return null;
      const saved = update(taskId, (record) => {
        record.entries = record.entries.filter((entry     ) => entry.key !== clean);
        record.keptOff = record.keptOff.filter((entry     ) => entry.key !== clean);
        record.needs = [...record.needs.filter((entry     ) => entry.key !== clean), need].slice(-TASK_USES_NEEDS_MAX);
      });
      return saved ? { status: "asked", record: saved } : null;
    },

    seed(taskId     , from     ) {
      if (!isValidLiveuiLibraryItemId(taskId) || !isPlainObject(from)) return null;
      const record = validRecord({ ...from, schemaVersion: 1, taskId, held: true }, taskId);
      return write(record) ? record : null;
    },
    clear(taskId     ) {
      if (!isValidLiveuiLibraryItemId(taskId)) return false;
      if (memory) return memory.delete(taskId);
      try {
        fs.unlinkSync(fileFor(taskId));
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}

function taskUsesForPhone(record     ) {
  if (!record) return { held: false, entries: [], needs: [], keptOff: [] };
  const facts = (use     , withDetail         ) => {
    const out      = { key: use.key, kind: use.kind, change: use.change === true, atMs: use.atMs };
    for (const name of ["server", "tool", "destination", "program", "sub"]) if (use[name]) out[name] = use[name];
    if (use.exact) out.exact = true;
    if (withDetail) {
      if (use.detail) out.detail = use.detail;
      out.count = use.count || 1;
    }
    return out;
  };
  return {
    held: record.held === true,
    entries: record.entries.map((entry     ) => facts(entry, false)),
    needs: record.needs.map((need     ) => facts(need, true)),
    keptOff: (record.keptOff || []).map((off     ) => facts(off, false)),
  };
}

const TASK_JOB_MEMORY_KEEP_MS = 24 * 60 * 60 * 1000;
const TASK_JOB_MEMORY_MAX = 1024;

function createTaskJobMemory(opts      = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const keepMs = Number.isFinite(opts.keepMs) ? opts.keepMs : TASK_JOB_MEMORY_KEEP_MS;
  const max = Number.isSafeInteger(opts.max) && opts.max > 0 ? opts.max : TASK_JOB_MEMORY_MAX;
  const jobs = new Map                                          ();
  return {
    note(jobId     , taskId     ) {
      if (typeof jobId !== "string" || !jobId || typeof taskId !== "string" || !taskId) return;
      jobs.delete(jobId);
      jobs.set(jobId, { taskId, atMs: now() });
      const cutoff = now() - keepMs;
      for (const [id, seen] of jobs) {
        if (jobs.size > max || seen.atMs < cutoff) jobs.delete(id);
        else break;
      }
    },
    taskOf(jobId     )                {
      const seen = typeof jobId === "string" ? jobs.get(jobId) : undefined;
      if (!seen) return null;
      if (seen.atMs < now() - keepMs) {
        jobs.delete(jobId);
        return null;
      }
      return seen.taskId;
    },

    forget(jobId     ) {
      if (typeof jobId === "string") jobs.delete(jobId);
    },
  };
}

function createTaskHeldPolicy(opts      = {}) {
  const logger = opts.logger || null;
  const glassesTools = opts.glassesTools instanceof Set ? opts.glassesTools : new Set        ();
  const why = typeof opts.why === "string" ? opts.why : "held";
  const reason = typeof opts.reason === "string" ? opts.reason : `${TASK_USES_NOT_ALLOWED}: OcuClaw skipped this step. Finish now without it.`;
  const label = typeof opts.label === "string" ? opts.label : "held run";
  const tag = typeof opts.tag === "string" ? opts.tag : "[task-uses]";
  return {
    check({ host, taskId, toolName, args, mcp }     ) {
      let step      = null;
      try {
        step = classifyTaskStep({ host, toolName, args, mcp, glassesTools });
      } catch (_) {
        step = null;
      }
      if (step && step.class === "read") return { allow: true, step };
      logger?.info?.(`${tag} skipped ${toolName} in a ${label} of ${taskId}`);
      return { allow: false, step, why, reason };
    },
  };
}

function createTaskUsesPolicy(opts      = {}) {
  const store = opts.store;
  const logger = opts.logger || null;
  const onNeeds = typeof opts.onNeeds === "function" ? opts.onNeeds : () => {};
  const glassesTools = opts.glassesTools instanceof Set ? opts.glassesTools : new Set        ();

  function check({ host, taskId, mode, toolName, args, mcp }     ) {

    let step      = null;
    try {
      step = classifyTaskStep({ host, toolName, args, mcp, glassesTools });
    } catch (err     ) {
      logger?.warn?.(`[task-uses] could not judge ${toolName} for ${taskId}: ${err?.message || err}`);
      return { allow: false, step: null, why: "check_failed", reason: `${TASK_USES_NOT_ALLOWED}: OcuClaw could not tell what this step does, so it skipped it. Carry on without it.` };
    }
    if (step.class === "read") return { allow: true, step };
    let record      = null;
    try {
      record = store.policy(taskId);
    } catch (err     ) {
      logger?.warn?.(`[task-uses] list read failed for ${taskId}: ${err?.message || err}`);
      record = null;
    }
    if (!record) {
      return { allow: false, step, why: "list_unreadable", reason: `${TASK_USES_NOT_ALLOWED}: OcuClaw could not read what this Task may use, so it skipped this step. Carry on without it.` };
    }
    const decision = decideTaskStep({ record, mode, step });
    if (decision.allow) return { allow: true, step };
    if (decision.needs) {
      try {
        if (store.noteNeeds(taskId, step)) onNeeds(taskId, step);
      } catch (err     ) {
        logger?.warn?.(`[task-uses] could not note a step for ${taskId}: ${err?.message || err}`);
      }
    }
    logger?.info?.(`[task-uses] skipped ${toolName} in ${mode} run of ${taskId} (${decision.why})`);
    return { allow: false, step, why: decision.why, reason: taskStepRefusal(decision.why || "not_on_list", step) };
  }

  return { check };
}

module.exports = { TASK_USES_DIR, TASK_USES_ENTRIES_MAX, TASK_USES_NEEDS_MAX, TASK_USE_KINDS, TASK_USES_NOT_ALLOWED, TASK_USES_NOT_OFFERED, TASK_USES_NOT_ON_OPEN, TASK_USES_CHECK_FAILED_REASON, TASK_USES_CUT_MARK, taskUsesCutArg, terminalUseKeys, classifyTaskStep, hostCommandWordsFacts, taskStepMcpFacts, decideTaskStep, taskStepRefusal, taskUseOfStep, TASK_USES_SAVED_SHAPE, createTaskUsesStore, taskUsesForPhone, TASK_JOB_MEMORY_KEEP_MS, TASK_JOB_MEMORY_MAX, createTaskJobMemory, createTaskHeldPolicy, createTaskUsesPolicy };
