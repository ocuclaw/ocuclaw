const path = require("node:path");

const DEFAULT_MAX_LABEL_CHARS = 120;

const REDACT_QUERY_KEYS = "(token|access_token|api_key|key|password|secret)";

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" ? value : null;
}

function isNullishToken(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "(null)" ||
    normalized === "(undefined)" ||
    normalized === "none"
  );
}

function normalizeLowerToken(value) {
  const text = asString(value);
  return text ? text.trim().toLowerCase() : "";
}

function pickString(obj, keys) {
  const entry = pickStringEntry(obj, keys);
  return entry ? entry.value : null;
}

function pickStringEntry(obj, keys) {
  if (!isObject(obj)) return null;
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value && value.trim()) return { key, value };
  }
  return null;
}

function shortText(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(maxChars, 0));
  return `${text.slice(0, maxChars - 3)}...`;
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function redactSecrets(rawText) {
  if (!rawText) return "";
  let text = String(rawText);

  text = text.replace(
    new RegExp(`([?&]${REDACT_QUERY_KEYS}=)[^&#\\s]+`, "gi"),
    "$1[redacted]",
  );
  text = text.replace(
    /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^,\s"'`]+)/gi,
    "$1[redacted]",
  );
  text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s"'`]+/gi, "$1[redacted]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/g, "Bearer [redacted]");
  text = text.replace(/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted]");

  return text;
}

function sanitizeText(rawText, maxChars) {
  const redacted = redactSecrets(rawText);
  const collapsed = collapseWhitespace(redacted);
  return shortText(collapsed, maxChars);
}

function hostFromUrl(urlString) {
  if (!urlString) return null;
  try {
    const parsed = new URL(urlString);
    return parsed.host || null;
  } catch {
    return null;
  }
}

function extractFirstUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s"'`]+/i);
  return match ? match[0] : null;
}

function extractBrowserQueryFromCommand(command) {
  const match = command.match(/[?&]q=([^&"'`\s]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, " "));
  } catch {
    return match[1].replace(/\+/g, " ");
  }
}

function stripQuotes(value) {
  if (!value) return value;
  return String(value).replace(/^['"]+|['"]+$/g, "");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function filenameFromPath(pathValue) {
  if (!pathValue || typeof pathValue !== "string") return null;
  const cleaned = stripQuotes(pathValue.trim());
  if (!cleaned) return null;
  const normalized = cleaned.replace(/[;,)]+$/g, "");
  if (!normalized) return null;
  if (isNullishToken(normalized)) return null;

  if (/\$[({]?[A-Za-z_][A-Za-z0-9_]*[)}]?/.test(normalized) || /\$\(.+\)/.test(normalized)) {
    return null;
  }
  if (/^(?:\/dev\/(?:null|stdout|stderr)|nul)$/i.test(normalized)) return null;
  return path.basename(normalized);
}

function pickMktempTemplatePath(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "string") return null;
  const tokens = rawArgs
    .match(/"[^"]*"|'[^']*'|[^\s]+/g)
    ?.map((token) => stripQuotes(token).trim())
    ?.filter(Boolean);
  if (!tokens || tokens.length === 0) return null;

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token || token === "mktemp" || token.startsWith("-")) continue;
    if (isNullishToken(token)) continue;
    return token;
  }
  return null;
}

function extractMktempBindings(command) {
  if (!command || typeof command !== "string") return [];
  const out = [];
  const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$\(\s*mktemp\b([^)]*)\)/g;
  let match;
  while ((match = regex.exec(command)) !== null) {
    const varName = match[1];
    const templatePath = pickMktempTemplatePath(match[2]);
    const fileName = filenameFromPath(templatePath);
    if (!fileName) continue;
    out.push({ varName, fileName });
  }
  return out;
}

function commandRefsVarWithRedirect(command, varName, operator) {
  if (!command || !varName) return false;
  const varRef = `\\$\\{?${escapeRegex(varName)}\\}?`;
  const op = escapeRegex(operator);
  const regex = new RegExp(`(?:^|\\s)${op}\\s*(?:["']?${varRef}["']?)`);
  return regex.test(command);
}

function commandReadsVarWithCat(command, varName) {
  if (!command || !varName) return false;
  const varRef = `\\$\\{?${escapeRegex(varName)}\\}?`;
  const regex = new RegExp(`(?:^|\\s)cat\\s+(?:["']?${varRef}["']?)`);
  return regex.test(command);
}

function categoryFromToolName(lowName) {
  if (lowName.startsWith("browser") || lowName === "web" || lowName === "web.search" || lowName === "web_search") return "browser";
  if (lowName === "read" || lowName === "write" || lowName === "edit" || lowName.startsWith("fs.")) return "filesystem";
  if (lowName === "search" || lowName.startsWith("vector") || lowName === "grep" || lowName === "find") return "search";
  if (lowName === "exec" || lowName === "bash" || lowName.startsWith("shell")) return "terminal";
  return "generic";
}

function intentFromToolName(lowName, args) {
  const query = pickString(args, ["query", "q", "term", "search"]);

  switch (lowName) {
    case "read":
    case "fs.read":
      return "fs.read";
    case "write":
    case "apply_patch":
    case "fs.write":
      return "fs.write";
    case "edit":
    case "fs.edit":
      return "fs.edit";
    case "search":
    case "grep":
    case "find":
      return "search.files";
    case "browser.search":
    case "web.search":
      return "search.web";
    case "browser.click":
    case "browser.navigate":
      return "browser.navigate";
    case "browser.fill":
      return "browser.fill";
    case "browser":
    case "web":
      return query ? "search.web" : "browser.browse";
    case "exec":
    case "bash":
      return "terminal.exec";
    case "git":
      return "terminal.git";
    case "llm_task":
      return "agent.subtask";
    case "agent_send":
      return "agent.coordinate";
    case "message":
      return "message.send";
    case "sessions_list":
    case "sessions_read":
    case "session_status":
      return "session.manage";
    case "canvas":
      return "canvas.edit";
    case "fetch":
      return "network.fetch";
    default:
      break;
  }

  if (lowName.startsWith("browser")) {
    if (lowName.includes("fill")) return "browser.fill";
    if (lowName.includes("click") || lowName.includes("navigate")) return "browser.navigate";
    if (lowName.includes("search")) return "search.web";
    return "browser.browse";
  }
  if (lowName.startsWith("web")) {
    return lowName.includes("search") ? "search.web" : "browser.browse";
  }
  if (lowName.includes("search")) {
    return lowName.includes("web") || lowName.includes("browser")
      ? "search.web"
      : "search.files";
  }
  if (lowName.startsWith("fs.")) {
    if (lowName.includes("read")) return "fs.read";
    if (lowName.includes("edit")) return "fs.edit";
    return "fs.write";
  }
  if (lowName.startsWith("session")) return "session.manage";
  if (lowName.startsWith("http")) return "network.fetch";
  if (lowName.startsWith("git")) return "terminal.git";
  if (lowName.startsWith("shell")) return "terminal.exec";
  return "generic";
}

const SHELL_WRAPPER_RE = /^(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+((?:-\w+\s+)+)([\s\S]*)$/;

function unwrapShellCommand(raw) {
  let cmd = raw ? String(raw).trim() : "";
  for (let depth = 0; depth < 2; depth += 1) {
    const match = cmd.match(SHELL_WRAPPER_RE);
    if (!match || !/c/.test(match[1])) break;
    let payload = match[2].trim();
    const quote = payload.charAt(0);
    if (quote === '"' || quote === "'") {
      if (payload.length < 2 || !payload.endsWith(quote)) break;
      payload = payload.slice(1, -1);
      if (quote === '"') payload = payload.replace(/\\(["\\$`])/g, "$1");
    }
    if (!payload.trim()) break;
    cmd = payload.trim();
  }

  const cdMatch = cmd.match(/^cd\s+[^;&|]+&&\s*([\s\S]+)$/);
  if (cdMatch) cmd = cdMatch[1].trim();
  return cmd;
}

const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "do", "done",
  "while", "for", "until", "case", "esac", "{", "}", "(", ")", "!", "time",
]);

function commandSegments(command) {
  const out = [];
  for (const rawSeg of String(command || "").split(/&&|\|\||[;|\n]/)) {
    let tokens = rawSeg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    for (;;) {
      const head = tokens.length ? stripQuotes(tokens[0]) : null;
      if (head === null) break;
      if (SHELL_KEYWORDS.has(head)) { tokens = tokens.slice(1); continue; }
      if (head === "[") {
        const close = tokens.indexOf("]");
        tokens = close >= 0 ? tokens.slice(close + 1) : [];
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) { tokens = tokens.slice(1); continue; }
      break;
    }
    if (tokens.length) out.push(tokens.map((t) => stripQuotes(t)));
  }
  return out;
}

function execResult(label, category, intent, subject = null, subjectKind = null) {
  return { label, category, intent, subject: subject || null, subjectKind: subjectKind || null };
}

const TEST_RUNNER_BINS = new Set(["pytest", "jest", "vitest", "mocha"]);
const PKG_MANAGER_BINS = new Set(["npm", "pnpm", "yarn"]);

const PASSTHROUGH_PREFIX_VALUE_FLAGS = new Map([
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["nohup", new Set()],
  ["nice", new Set(["-n", "--adjustment"])],
  ["sudo", new Set(["-u", "-g", "--user", "--group"])],
  ["env", new Set(["-u", "--unset", "-C", "--chdir"])],
  ["exec", new Set(["-a"])],
  ["command", new Set()],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["npx", new Set(["-p", "--package"])],
  ["bunx", new Set(["-p", "--package"])],
  ["pnpx", new Set()],
]);
const RUN_SUBCOMMAND_BINS = new Set(["uv", "poetry", "pipenv", "pdm", "pipx", "hatch", "rye"]);

function stripCommandPrefixes(tokens          ) {
  let current = tokens;
  for (let depth = 0; depth < 4 && current.length > 1; depth += 1) {
    const bin = path.basename(current[0]);
    const valueFlags = PASSTHROUGH_PREFIX_VALUE_FLAGS.get(bin);
    let index = 1;

    if (bin === "command" && (current[1] === "-v" || current[1] === "-V")) break;
    if (valueFlags) {
      while (index < current.length) {
        const token = current[index];
        if (valueFlags.has(token)) { index += 2; continue; }
        if (token.startsWith("-")) { index += 1; continue; }
        if (bin === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
        break;
      }

      if ((bin === "timeout" || bin === "nice") && /^\d+(?:\.\d+)?[smhd]?$/.test(current[index] || "")) index += 1;
    } else if (RUN_SUBCOMMAND_BINS.has(bin) && current[1] === "run") {
      index = 2;
      while (index < current.length && current[index].startsWith("-")) index += 1;
    } else {
      break;
    }
    if (index >= current.length) break;
    current = current.slice(index);
  }
  return current;
}

const SCRIPT_FILE_RE = /\.(?:py|pyw|js|mjs|cjs|ts|mts|cts|tsx|jsx|sh|bash|zsh|rb|pl|php|lua|r)$/i;
const SCRIPT_INTERPRETER_RE = /^(?:python(?:\d+(?:\.\d+)?)?|node|nodejs|bash|sh|zsh|dash|ruby|deno|bun|tsx|ts-node|perl|php|lua|Rscript)$/;

const INTERPRETER_VALUE_FLAGS = new Set([
  "-W", "-X", "-r", "--require", "--import", "--loader", "--experimental-loader",
  "--env-file", "--conditions", "-C", "--config", "-I", "-o",
]);

const INTERPRETER_INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-"]);

function scriptFileOfInterpreter(bin        , rest          ) {
  let index = 0;

  if ((bin === "deno" || bin === "bun") && rest[0] === "run") index = 1;
  for (; index < rest.length; index += 1) {
    const token = rest[index];
    if (INTERPRETER_INLINE_FLAGS.has(token)) return null;
    if (token.startsWith("<")) return null;
    if (INTERPRETER_VALUE_FLAGS.has(token)) { index += 1; continue; }
    if (token.startsWith("-")) continue;
    return SCRIPT_FILE_RE.test(token) && !token.includes("=") ? filenameFromPath(token) : null;
  }
  return null;
}

function pythonModule(rest          ) {
  const at = rest.indexOf("-m");
  return at >= 0 && at + 1 < rest.length ? rest[at + 1] : null;
}

function isPipZipappInstall(rest          ) {
  const at = rest.findIndex((token) => !token.startsWith("-"));
  if (at < 0 || !/(?:^|[/\-_.])pip\.pyz$/.test(rest[at])) return false;
  return isPackageInstall("pip", rest.slice(at + 1));
}

function isPackageInstall(bin        , rest          ) {
  const sub = rest.find((token) => !token.startsWith("-")) || null;
  if (/^pip(?:\d+(?:\.\d+)?)?$/.test(bin)) return sub === "install";
  if (bin === "npm") return sub === "install" || sub === "i" || sub === "ci" || sub === "add";
  if (bin === "pnpm" || bin === "yarn" || bin === "bun") return sub === "add" || sub === "install" || sub === "i";
  if (bin === "apt-get" || bin === "apt" || bin === "brew" || bin === "dnf" || bin === "yum" || bin === "apk") {
    return sub === "install" || sub === "add";
  }
  if (bin === "cargo" || bin === "poetry") return sub === "add" || (bin === "cargo" && sub === "install");
  if (bin === "uv") return sub === "add" || (sub === "pip" && rest.includes("install"));
  if (bin === "gem" || bin === "go") return sub === "install";
  return false;
}

function versionProbeSubject(bin        ) {
  if (bin === "node" || bin === "nodejs") return "Node.js";
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(bin)) return "Python";
  return bin.length > 24 ? "the" : bin;
}

function classifyExecSegment(rawTokens) {
  const tokens = stripCommandPrefixes(rawTokens);
  const head = tokens[0];
  const bin = path.basename(head);
  const rest = tokens.slice(1);
  const joined = tokens.join(" ");
  const firstFileArg = (extra      = null) => {
    for (const tok of rest) {
      if (tok.startsWith("-")) continue;
      if (extra && extra(tok)) continue;
      return tok;
    }
    return null;
  };

  if (rest.length > 0 && isVersionProbe(bin, rest.slice(0, 1))) {
    return execResult(`Checking ${versionProbeSubject(bin)} version...`, "terminal", "terminal.exec");
  }
  if (bin === "cat") {
    const fileName = filenameFromPath(firstFileArg());
    if (fileName) return execResult(`Reading ${fileName}...`, "filesystem", "fs.read", fileName, "file");
  }
  if (bin === "sed") {

    const inPlace = rest.some(
      (t) => t === "-i" || t.startsWith("-i.") || t === "--in-place" || t.startsWith("--in-place="),
    );
    if (inPlace) {
      const editTargets = rest.filter((t) => !t.startsWith("-"));
      const editFileName = filenameFromPath(editTargets.length ? editTargets[editTargets.length - 1] : null);
      if (editFileName) {
        return execResult(`Editing ${editFileName}...`, "filesystem", "fs.edit", editFileName, "file");
      }
    }
    const range = joined.match(/-n\s*['"]?(\d+),(\d+)p/);
    const candidates = rest.filter((t) => !t.startsWith("-") && !/^\d+,\d+p$/.test(t));
    const fileName = filenameFromPath(candidates.length ? candidates[candidates.length - 1] : null);
    if (fileName) {
      const suffix = range ? ` (lines ${range[1]}-${range[2]})` : "";
      return execResult(`Reading ${fileName}${suffix}...`, "filesystem", "fs.read", fileName, "file");
    }
  }
  if (bin === "head" || bin === "tail") {
    const fileName = filenameFromPath(firstFileArg((tok) => /^\d+$/.test(tok)));
    if (fileName) return execResult(`Reading ${fileName}...`, "filesystem", "fs.read", fileName, "file");
  }
  if (bin === "ls" || bin === "tree") return execResult("Listing files...", "search", "search.files");
  if (bin === "wc") {

    const flags = rest.filter((t) => /^-[a-zA-Z]+$/.test(t)).join("");
    const unit = /w/.test(flags) ? "words" : /[cm]/.test(flags) ? "characters" : /l/.test(flags) ? "lines" : null;

    const fileName = filenameFromPath(firstFileArg((tok        ) => /^[<>|&]+$/.test(tok)));
    if (unit && fileName) {
      return execResult(`Counting ${unit} in ${fileName}...`, "search", "search.files", fileName, "file");
    }
    if (unit && unit !== "lines") return execResult(`Counting ${unit}...`, "search", "search.files");
    return execResult("Counting matches...", "search", "search.files");
  }
  if (bin === "grep" || bin === "rg" || bin === "find" || bin === "fd" || bin === "ag") {
    return execResult("Searching files...", "search", "search.files", null, "phrase");
  }
  if (bin === "git") {

    let sub = null;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "-C" || token === "-c") { index += 1; continue; }
      if (token.startsWith("-")) continue;
      sub = token;
      break;
    }
    return execResult(sub ? `Running git ${sub}...` : "Running git...", "terminal", "terminal.git");
  }
  const isPython = /^python(?:\d+(?:\.\d+)?)?$/.test(bin);
  const module = isPython ? pythonModule(rest) : null;
  if (
    isPackageInstall(bin, rest) ||
    (module && /^pip\d*$/.test(module) && isPackageInstall("pip", rest.slice(rest.indexOf("-m") + 2))) ||
    (isPython && isPipZipappInstall(rest))
  ) {
    return execResult("Installing packages...", "terminal", "terminal.exec");
  }
  if (
    (PKG_MANAGER_BINS.has(bin) && /\btest\b/.test(joined)) ||
    TEST_RUNNER_BINS.has(bin) ||
    (module === "pytest" || module === "unittest") ||
    (bin === "node" && /(^|\s)--test\b/.test(joined)) ||
    ((bin === "cargo" || bin === "go" || bin === "bun" || bin === "deno") && rest[0] === "test") ||
    (/^gradlew?$/.test(bin) && /\btest\b/.test(joined))
  ) {
    return execResult("Running tests...", "terminal", "terminal.exec");
  }
  if (bin === "tsc" || bin === "mypy" || (PKG_MANAGER_BINS.has(bin) && /\b(typecheck|tsc)\b/.test(joined))) {
    return execResult("Checking types...", "terminal", "terminal.exec");
  }
  if (
    (PKG_MANAGER_BINS.has(bin) && /\bbuild\b/.test(joined)) ||
    bin === "make" ||
    (/^gradlew?$/.test(bin) && /\b(build|assemble)\b/.test(joined)) ||
    ((bin === "cargo" || bin === "go") && rest[0] === "build")
  ) {
    return execResult("Building project...", "terminal", "terminal.exec");
  }
  if (bin === "openclaw") return execResult("Running openclaw...", "terminal", "terminal.exec");
  if (bin === "test") return execResult("Checking files...", "search", "search.files");

  const ranByRunner = tokens !== rawTokens;
  const scriptFile = SCRIPT_INTERPRETER_RE.test(bin)
    ? scriptFileOfInterpreter(bin, rest)
    : (head.includes("/") || ranByRunner) && SCRIPT_FILE_RE.test(head) ? filenameFromPath(head) : null;
  if (scriptFile) {
    return execResult(`Running ${scriptFile}...`, "terminal", "terminal.exec");
  }
  if (isPython || bin === "node") {
    return execResult("Running a script...", "terminal", "terminal.exec");
  }
  return null;
}

const PROBE_BINS = new Set([
  "which", "whereis", "type", "hash", "cd", "pushd", "popd", "pwd", "echo", "printf",
  "export", "unset", "true", "false", ":", "set", "mkdir", "test", "sleep", "source", ".",
]);
const DASH_V_VERSION_BINS = new Set(["node", "nodejs", "npm", "npx", "pnpm", "yarn", "bun", "deno"]);

function isVersionProbe(bin        , rest          ) {
  if (rest.includes("--version")) return true;
  if (rest.length !== 1) return false;
  return rest[0] === "-V" || rest[0] === "version" || rest[0] === "-version" ||
    (rest[0] === "-v" && DASH_V_VERSION_BINS.has(bin));
}

function execProbeKind(rawTokens          ) {
  const tokens = stripCommandPrefixes(rawTokens);
  const bin = path.basename(tokens[0]);
  const rest = tokens.slice(1);
  if (bin === "command" && (rest[0] === "-v" || rest[0] === "-V")) return "probe";
  if (PROBE_BINS.has(bin)) return "probe";
  if (isVersionProbe(bin, rest)) return "version";
  if (rest.includes("--help")) return "probe";
  return null;
}

function execHitRank(hit) {
  const { label, intent } = hit;
  if (label === "Installing packages...") return 7;
  if (label === "Running tests...") return 6;
  if (label === "Checking types..." || label === "Building project...") return 5;
  if (label === "Running a script...") return 1;
  if (intent === "terminal.git" || label === "Running openclaw...") return 3;
  if (intent === "fs.edit") return 4;
  if (intent === "terminal.exec") return 4;
  return 2;
}

function stripHeredocBodies(command        ) {
  const out = [];
  let delimiter = null;
  for (const line of command.split("\n")) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (match) delimiter = match[2];
  }
  return out.join("\n");
}

function labelFromExecChain(raw        ) {
  const segments = commandSegments(stripHeredocBodies(raw));
  if (segments.length < 2) return undefined;
  let best = null;
  let bestRank = 0;
  let sawVersion = false;
  let sawWork = false;
  for (const tokens of segments) {
    const probe = execProbeKind(tokens);
    if (probe) {
      if (probe === "version") sawVersion = true;
      continue;
    }
    sawWork = true;
    const hit = classifyExecSegment(tokens);
    if (!hit) continue;
    const rank = execHitRank(hit);
    if (rank > bestRank) { best = hit; bestRank = rank; }
  }
  if (best) return best;
  if (sawWork) return null;

  return sawVersion ? execResult("Checking versions...", "terminal", "terminal.exec") : undefined;
}

function labelFromExecCommand(command) {
  const original = command ? String(command).trim() : "";
  if (!original) {
    return execResult("Running a command...", "terminal", "terminal.exec");
  }
  const raw = unwrapShellCommand(original);

  if (raw.includes("agent-browser")) {
    const query = extractBrowserQueryFromCommand(raw);
    if (query) {
      return execResult(
        `Searching "${sanitizeText(query, DEFAULT_MAX_LABEL_CHARS)}"...`,
        "browser", "search.web", query, "query",
      );
    }
    const browserUrl = extractFirstUrl(raw);
    if (browserUrl) {
      const host = hostFromUrl(browserUrl);
      return execResult(host ? `Browsing ${host}...` : "Using browser...", "browser", "browser.browse", host, "host");
    }
    return execResult("Using browser...", "browser", "browser.browse");
  }

  const segments = commandSegments(raw);

  if (segments.length > 0) {
    const leadBin = path.basename(segments[0][0]);
    if (leadBin === "curl" || leadBin === "wget") {
      const url = extractFirstUrl(raw);
      const host = hostFromUrl(url);
      return host
        ? execResult(`Fetching from ${host}...`, "network", "network.fetch", host, "host")
        : execResult("Fetching data...", "network", "network.fetch");
    }
  }

  if (segments.length > 0) {
    const fromCli = labelFromFirecrawlCli(segments[0]);
    if (fromCli) return fromCli;
  }

  const appendMatch = raw.match(/(?:^|\s)>>\s*([^\s]+)/);
  if (appendMatch) {
    const fileName = filenameFromPath(appendMatch[1]);
    if (fileName) return execResult(`Appending to ${fileName}...`, "filesystem", "fs.write", fileName, "file");
  }
  const writeMatch = raw.match(/(?:^|\s)>\s*([^\s]+)/);
  if (writeMatch) {
    const fileName = filenameFromPath(writeMatch[1]);
    if (fileName) return execResult(`Writing ${fileName}...`, "filesystem", "fs.write", fileName, "file");
  }
  const mktempBindings = extractMktempBindings(raw);
  for (const binding of mktempBindings) {
    if (commandRefsVarWithRedirect(raw, binding.varName, ">>")) {
      return execResult(`Appending to ${binding.fileName}...`, "filesystem", "fs.write", binding.fileName, "file");
    }
  }
  for (const binding of mktempBindings) {
    if (commandRefsVarWithRedirect(raw, binding.varName, ">")) {
      return execResult(`Writing ${binding.fileName}...`, "filesystem", "fs.write", binding.fileName, "file");
    }
  }
  for (const binding of mktempBindings) {
    if (commandReadsVarWithCat(raw, binding.varName)) {
      return execResult(`Reading ${binding.fileName}...`, "filesystem", "fs.read", binding.fileName, "file");
    }
  }

  if (
    segments.length >= 2 &&
    ["find", "grep", "rg"].includes(path.basename(segments[0][0])) &&
    segments.some((tokens) => path.basename(tokens[0]) === "wc")
  ) {
    return execResult("Counting matches...", "search", "search.files");
  }

  const chainHit = segments.length >= 2 ? labelFromExecChain(raw) : undefined;
  if (chainHit) return chainHit;
  if (chainHit === undefined) {
    for (const tokens of segments) {
      const hit = classifyExecSegment(tokens);
      if (hit) return hit;
    }
  }

  if (/https?:\/\//i.test(raw)) {
    const url = extractFirstUrl(raw);
    const host = hostFromUrl(url);
    if (host) return execResult(`Fetching from ${host}...`, "network", "network.fetch", host, "host");
    return execResult("Fetching data...", "network", "network.fetch");
  }

  return execResult(`Running: ${sanitizeText(raw, DEFAULT_MAX_LABEL_CHARS)}`, "terminal", "terminal.exec");
}

const KANBAN_BOARD_SUBJECT_MAX_CHARS = 24;
const KANBAN_BOARD_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const KANBAN_TOOL_LABELS = new Map([
  ["kanban_create", ["Filing a card", "board.create"]],
  ["kanban_show", ["Checking the board", "board.read"]],
  ["kanban_list", ["Checking the board", "board.read"]],
  ["kanban_unblock", ["Unblocking a card", "board.unblock"]],
  ["kanban_comment", ["Adding to a card", "board.annotate"]],
  ["kanban_attach", ["Adding to a card", "board.annotate"]],
  ["kanban_attach_url", ["Adding to a card", "board.annotate"]],
  ["kanban_attachments", ["Checking the board", "board.read"]],
  ["kanban_link", ["Linking cards", "board.link"]],
]);

function kanbanToolLabel(lowName = "", args = {}) {
  const [phrase, intent] = KANBAN_TOOL_LABELS.get(lowName) || ["Using the board", "generic"];
  const rawBoard = pickString(args, ["board"]);
  const board = rawBoard && KANBAN_BOARD_SLUG.test(rawBoard)
    ? sanitizeText(rawBoard, KANBAN_BOARD_SUBJECT_MAX_CHARS)
    : null;
  return {
    label: board ? `${phrase} on ${board}...` : `${phrase}...`,
    detail: null,
    category: "generic",
    intent,
  };
}

function firecrawlToolVerb(lowName = "") {
  const at = lowName.lastIndexOf("firecrawl_");
  if (at < 0) return null;
  if (at > 0 && !/[_.:]/.test(lowName[at - 1])) return null;
  const verb = lowName.slice(at + "firecrawl_".length);
  return /^[a-z][a-z0-9_]*$/.test(verb) ? verb : null;
}

function firstUrlArg(args      = {}) {
  const single = pickString(args, ["url", "href", "uri"]);
  if (single) return single;
  const many = isObject(args) && Array.isArray(args.urls) ? args.urls : [];
  return many.find((item     ) => typeof item === "string" && /^https?:\/\//i.test(item.trim())) || null;
}

function urlArgCount(args      = {}) {
  if (!isObject(args) || !Array.isArray(args.urls)) return 0;
  return args.urls.filter((item     ) => typeof item === "string" && /^https?:\/\//i.test(item.trim())).length;
}

function webResult(label        , category        , intent        , subject      = null, subjectKind      = null) {
  return { label, category, intent, subject: subject || null, subjectKind: subjectKind || null };
}

function firecrawlVerbLabel(verb = "", subject      = null, pages = 0) {
  if (verb === "search") {
    return subject
      ? webResult(`Searching the web for "${sanitizeText(subject, DEFAULT_MAX_LABEL_CHARS)}"...`, "browser", "search.web", subject, "query")
      : webResult("Searching the web...", "browser", "search.web");
  }
  const host = hostFromUrl(subject);
  if (verb === "scrape" || verb === "extract" || verb === "batch_scrape" || verb === "parse") {
    if (pages > 1) return webResult(`Reading ${pages} pages...`, "network", "network.fetch");
    return host
      ? webResult(`Reading ${host}...`, "network", "network.fetch", host, "host")
      : webResult("Reading a page...", "network", "network.fetch");
  }
  if (verb === "map") {
    return host
      ? webResult(`Mapping ${host}...`, "network", "network.fetch", host, "host")
      : webResult("Mapping a site...", "network", "network.fetch");
  }
  if (verb === "crawl") {
    return host
      ? webResult(`Crawling ${host}...`, "network", "network.fetch", host, "host")
      : webResult("Crawling a site...", "network", "network.fetch");
  }
  if (verb.startsWith("check_") || verb.endsWith("_status") || verb === "status") {
    return webResult("Checking a web job...", "network", "agent.subtask");
  }
  if (verb === "agent" || verb === "deep_research" || verb === "research") {
    return webResult("Researching the web...", "browser", "search.web");
  }
  if (verb === "interact" || verb.startsWith("browser")) {
    return host
      ? webResult(`Browsing ${host}...`, "browser", "browser.browse", host, "host")
      : webResult("Browsing the web...", "browser", "browser.browse");
  }
  if (verb.startsWith("monitor")) {
    return webResult("Checking a page watch...", "network", "network.fetch");
  }
  return webResult("Using Firecrawl...", "network", "network.fetch");
}

function firecrawlToolLabel(verb        , args     , stabilityKey     )

  {
  const query = pickString(args, ["query", "q", "term", "search"]);
  const subject = verb === "search" ? query : firstUrlArg(args);
  const hit = firecrawlVerbLabel(verb, subject, urlArgCount(args));
  return {
    label: hit.label,
    shortLabel: buildShortLabel({ intent: hit.intent, subject: hit.subject, subjectKind: hit.subjectKind, stabilityKey }),
    detail: subject || null,
    category: hit.category,
    intent: hit.intent,
  };
}

const FIRECRAWL_CLI_BINS = new Set(["firecrawl", "firecrawl-cli"]);

function labelFromFirecrawlCli(tokens        = []) {
  let rest = tokens.slice();
  if (rest.length && path.basename(String(rest[0])) === "npx") {
    rest = rest.slice(1);
    while (rest.length && String(rest[0]).startsWith("-")) rest = rest.slice(1);
  }
  if (!rest.length) return null;
  const bin = path.basename(String(rest[0])).replace(/@[^@]*$/, "");
  if (!FIRECRAWL_CLI_BINS.has(bin)) return null;
  const verb = String(rest[1] || "").toLowerCase().replace(/-/g, "_");
  if (!/^[a-z][a-z0-9_]*$/.test(verb)) return firecrawlVerbLabel("");
  const args = rest.slice(2).map(String);
  const subject = verb === "search"
    ? args.find((arg) => !arg.startsWith("-")) || null
    : args.find((arg) => /^https?:\/\//i.test(arg)) || null;
  return firecrawlVerbLabel(verb, subject);
}

const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;
function pickPatchPath(args     ) {
  if (!isObject(args)) return null;
  if (Array.isArray(args.changes)) {
    for (const change of args.changes) {
      const value = isObject(change) ? asString(change.path) : null;
      if (value && value.trim() && !isNullishToken(value)) return value.trim();
    }
  }
  for (const key of ["input", "patch"]) {
    const text = asString(args[key]);
    const match = text ? PATCH_FILE_LINE.exec(text) : null;
    if (match && match[1].trim()) return match[1].trim();
  }
  return null;
}

function labelFromToolPurpose(raw     , maxLabelChars     , stripSourceTag = false) {
  const text = asString(raw);
  if (!text) return null;
  let cleaned = collapseWhitespace(text);
  if (stripSourceTag) cleaned = cleaned.replace(/\s*\([a-z]+\)$/i, "").trim();
  if (!cleaned || isNullishToken(cleaned)) return null;
  const budget = Number.isFinite(maxLabelChars) ? maxLabelChars : DEFAULT_MAX_LABEL_CHARS;
  const clipped = sanitizeText(cleaned, Math.max(budget - 3, 8));
  if (!clipped) return null;
  return /[.…!?:]$/.test(clipped) ? clipped : `${clipped}...`;
}

const DELEGATION_LABEL_MAX_CHARS = 64;

function delegationActivityLabel(delegation         )                {
  if (!isObject(delegation)) return null;
  const routes = Array.isArray((delegation       ).routes) ? (delegation       ).routes : [];
  const first = routes.find((route     ) => isObject(route) && asString(route.label) && route.label.trim());
  if (!first) return null;
  const label = sanitizeText(first.label, DELEGATION_LABEL_MAX_CHARS);
  if (!label) return null;
  const counted = Number.isInteger((delegation       ).tasks) ? (delegation       ).tasks : 0;
  const others = Math.max(routes.length, counted) - 1;
  const head = first.kind === "profile" ? `Asking ${label}` : `Sub-agent → ${label}`;
  return others > 0 ? `${head} + ${others}...` : `${head}...`;
}

function mapToolLabel(toolName, activityPath, args, options) {
  const maxLabelChars = options.maxLabelChars;
  const stabilityKey = (options && options.stabilityKey) || null;
  const lowName = String(toolName || "").toLowerCase();
  const firecrawlVerb = firecrawlToolVerb(lowName);
  if (firecrawlVerb) return firecrawlToolLabel(firecrawlVerb, args, stabilityKey);
  const rawPathValue = asString(activityPath) || pickString(args, [
    "path",
    "filePath",
    "file_path",
    "filepath",
    "file",
    "target",
    "outputPath",
    "output_path",
    "output",
    "destination",
    "dest",
  ]) || pickPatchPath(args);
  const pathValue = rawPathValue && !isNullishToken(rawPathValue) ? rawPathValue : null;
  const fileName = filenameFromPath(pathValue);
  const query = pickString(args, ["query", "q", "term", "search"]);
  const url = pickString(args, ["url", "href", "uri"]);
  const command = pickString(args, ["command", "cmd", "shell"]);

  switch (lowName) {
    case "write":
    case "apply_patch":
    case "fs.write":
      return {
        label: `Writing ${fileName || "file"}...`,
        shortLabel: buildShortLabel({ intent: "fs.write", subject: fileName, subjectKind: "file", stabilityKey }),
        detail: pathValue || command || null,
        category: "filesystem",
        intent: "fs.write",
      };
    case "read":
    case "fs.read":
      return {
        label: `Reading ${fileName || "file"}...`,
        shortLabel: buildShortLabel({ intent: "fs.read", subject: fileName, subjectKind: "file", stabilityKey }),
        detail: pathValue || command || null,
        category: "filesystem",
        intent: "fs.read",
      };
    case "edit":
    case "fs.edit":
      return {
        label: `Editing ${fileName || "file"}...`,
        shortLabel: buildShortLabel({ intent: "fs.edit", subject: fileName, subjectKind: "file", stabilityKey }),
        detail: pathValue || command || null,
        category: "filesystem",
        intent: "fs.edit",
      };

    case "ls":
    case "list_dir":
      return {
        label: "Listing files...",
        detail: pathValue || null,
        category: "search",
        intent: "search.files",
      };
    case "search":
      if (query) {
        const queryPreview = sanitizeText(query, DEFAULT_MAX_LABEL_CHARS);
        return {
          label: `Searching for "${queryPreview}"...`,
          shortLabel: buildShortLabel({ intent: "search.files", subject: null, subjectKind: "phrase", stabilityKey }),
          detail: query,
          category: "search",
          intent: "search.files",
        };
      }
      return {
        label: "Searching files...",
        detail: pathValue || null,
        category: "search",
        intent: "search.files",
      };
    case "bash":
    case "exec": {
      const fromCommand = labelFromExecCommand(command);

      const purpose =
        labelFromToolPurpose(pickString(args, ["title"]), maxLabelChars) ||
        (fromCommand.label === "Running a command..."
          ? labelFromToolPurpose(options && options.meta, maxLabelChars, true)
          : null);
      if (purpose) {
        return {
          label: purpose,
          shortLabel: purpose.length > SHORT_LABEL_MAX_CHARS ? purpose : null,
          detail: command || pathValue || null,
          category: fromCommand.category,
          intent: fromCommand.intent,
        };
      }
      return {
        label: fromCommand.label,
        shortLabel: buildShortLabel({
          intent: fromCommand.intent,
          subject: fromCommand.subject,
          subjectKind: fromCommand.subjectKind,
          stabilityKey,
        }),
        detail: command || pathValue || null,
        category: fromCommand.category,
        intent: fromCommand.intent,
      };
    }
    case "web_search":
    case "browser.search":
    case "web.search":
      if (query) {
        const queryPreview = sanitizeText(query, DEFAULT_MAX_LABEL_CHARS);
        return {
          label: `Searching the web for "${queryPreview}"...`,
          shortLabel: buildShortLabel({ intent: "search.web", subject: query, subjectKind: "query", stabilityKey }),
          detail: query,
          category: "browser",
          intent: "search.web",
        };
      }
      if (url) {
        return {
          label: "Searching the web...",
          detail: url,
          category: "browser",
          intent: "search.web",
        };
      }
      return {
        label: "Searching the web...",
        detail: null,
        category: "browser",
        intent: "search.web",
      };
    case "browser":
    case "web":
      if (query) {
        const queryPreview = sanitizeText(query, DEFAULT_MAX_LABEL_CHARS);
        return {
          label: `Searching the web for "${queryPreview}"...`,
          shortLabel: buildShortLabel({ intent: "search.web", subject: query, subjectKind: "query", stabilityKey }),
          detail: query,
          category: "browser",
          intent: "search.web",
        };
      }
      if (url) {
        return {
          label: "Browsing the web...",
          detail: url,
          category: "browser",
          intent: "browser.browse",
        };
      }
      return {
        label: "Browsing the web...",
        detail: null,
        category: "browser",
        intent: "browser.browse",
      };
    case "browser.click":
      return {
        label: "Navigating a webpage...",
        detail: url || null,
        category: "browser",
        intent: "browser.navigate",
      };
    case "browser.fill":
      return {
        label: "Filling out a form...",
        detail: url || null,
        category: "browser",
        intent: "browser.fill",
      };
    case "browser.navigate":
      return {
        label: "Opening a webpage...",
        detail: url || null,
        category: "browser",
        intent: "browser.navigate",
      };
    case "llm_task":
      return {
        label: "Running a sub-task...",
        detail: null,
        category: "generic",
        intent: "agent.subtask",
      };
    case "agent_send":
      return {
        label: "Coordinating with another agent...",
        detail: null,
        category: "generic",
        intent: "agent.coordinate",
      };
    case "message":
      return {
        label: "Sending a message...",
        detail: null,
        category: "generic",
        intent: "message.send",
      };
    case "sessions_list":
    case "sessions_read":
    case "session_status":
      return {
        label: "Checking sessions...",
        detail: null,
        category: "generic",
        intent: "session.manage",
      };
    case "canvas":
      return {
        label: "Working on canvas...",
        detail: null,
        category: "generic",
        intent: "canvas.edit",
      };
    case "set_session_title":
      return {
        label: "Updating session title...",
        detail: pickString(args, ["title"]) || null,
        category: "generic",
        intent: "session.title.update",
      };
    case "get_evenrealities_device_info":
      return {
        label: "Checking Even Realities hardware...",
        detail: null,
        category: "generic",
        intent: "device.check",
      };
    case "get_ocuclaw_settings":
      return {
        label: "Checking settings...",
        detail: null,
        category: "generic",
        intent: "device.check",
      };
    case "set_ocuclaw_setting": {

      const settingName = pickString(args, ["name"]);
      const settingValue = args && typeof args === "object" && args.value !== undefined && args.value !== null
        ? String(args.value).slice(0, 40)
        : "";
      return {
        label: "Changing a setting...",
        detail: settingName ? `${settingName.replace(/_/g, " ")}${settingValue ? `: ${settingValue}` : ""}` : null,
        category: "generic",
        intent: "device.check",
      };
    }
    case "show_bot_screen":

      return {
        label: "Opening the Bot Screen...",
        detail: null,
        category: "generic",
        intent: "device.check",
      };
    case "get_current_location":
      return {
        label: "Checking location...",
        detail: null,
        category: "generic",
        intent: "device.check",
      };
    case "save_glasses_card":
      return {
        label: "Saving the card...",
        detail: pickString(args, ["name"]) || null,
        category: "generic",
        intent: "device.check",
      };
    case "write_glasses_card":
      return {
        label: "Writing a glasses card...",
        detail: null,
        category: "generic",
        intent: "interface.build",
      };
    case "ask_glasses_card":
      return {
        label: "Asking about a card...",
        detail: null,
        category: "generic",
        intent: "interface.build",
      };
    case "edit_glasses_card":
      return {
        label: "Changing the card...",
        detail: null,
        category: "generic",
        intent: "interface.build",
      };
    case "glasses_card_command":
      return {
        label: "Pressing a card button...",
        detail: null,
        category: "generic",
        intent: "device.check",
      };
    case "render_glasses_ui":

      if (["text_surface", "list_surface", "list_with_details_surface", "checklist_surface", "paged_text_surface"].includes(args.kind) &&
          (args.validateOnly === undefined || args.validateOnly === false) &&
          (args.update === undefined || args.update === "replace" || args.update === "push")) {
        return {
          label: "Building interface",
          detail: null,
          category: "generic",
          intent: "interface.build",
          buildKind: args.kind,
        };
      }
      return {
        label: "Showing interface...",
        detail: null,
        category: "generic",
        intent: "device.check",
      };
    case "memory_search":
      return {
        label: "Searching memory...",
        detail: query || null,
        category: "search",
        intent: "search.files",
      };
    case "process":
      return {
        label: "Checking a background task...",
        detail: null,
        category: "generic",
        intent: "agent.subtask",
      };
    case "web_fetch": {

      const fetchUrl = url || firstUrlArg(args);
      const fetchHost = hostFromUrl(fetchUrl);
      return {
        label: fetchHost ? `Fetching from ${fetchHost}...` : "Fetching data...",
        detail: fetchUrl || null,
        category: "network",
        intent: "network.fetch",
      };
    }
    case "tool_search":
      return {
        label: "Loading tools...",
        detail: query || null,
        category: "generic",
        intent: "generic",
      };
    case "cron":
      return {
        label: normalizeLowerToken(pickString(args, ["action"])) === "add"
          ? "Scheduling a task..."
          : "Checking schedules...",
        detail: null,
        category: "generic",
        intent: "session.manage",
      };
    case "gateway":
      return {
        label: "Managing the gateway...",
        detail: null,
        category: "generic",
        intent: "session.manage",
      };
    case "sessions_spawn":
    case "spawn_agent":
    case "subagents":
      return {

        label: delegationActivityLabel(options && options.delegation) || "Starting a sub-agent...",
        detail: null,
        category: "generic",
        intent: "agent.subtask",
      };
    case "sessions_send":
      return {
        label: "Coordinating with another agent...",
        detail: null,
        category: "generic",
        intent: "agent.coordinate",
      };
    case "sessions_history":
      return {
        label: "Checking sessions...",
        detail: null,
        category: "generic",
        intent: "session.manage",
      };

    case "todo_list":
    case "todo":
      return {
        label: "Updating tasks...",
        detail: null,
        category: "generic",
        intent: "generic",
      };

    case "progress_card":
    case "update_plan":
      return {
        label: "Updating the plan...",
        detail: null,
        category: "generic",
        intent: "generic",
      };

    case "kanban_create":
    case "kanban_show":
    case "kanban_list":
    case "kanban_unblock":
    case "kanban_comment":
    case "kanban_attach":
    case "kanban_attach_url":
    case "kanban_attachments":
    case "kanban_link":
      return kanbanToolLabel(lowName, args);
    default:
      if (fileName) {
        return {
          label: `${toolName} ${fileName}...`,
          detail: pathValue || null,
          category: categoryFromToolName(lowName),
          intent: intentFromToolName(lowName, args),
        };
      }
      return {
        label: `Using ${toolName}...`,
        detail: query || url || command || null,
        category: categoryFromToolName(lowName),
        intent: intentFromToolName(lowName, args),
      };
  }
}

const SHORT_LABEL_MAX_CHARS = 64;
const SHORT_LABEL_TARGET_CHARS = 42;

const VERB_PALETTES = {
  "search.web": ["researching", "looking up", "searching for"],
  "fs.read": ["reading", "checking", "opening"],
  "fs.write": ["writing", "updating", "editing", "patching"],
  "fs.edit": ["writing", "updating", "editing", "patching"],
};
const PHRASE_PALETTES = {
  "search.files": ["searching files", "scanning code"],
};

const QUERY_STOPWORDS = new Set([
  "best", "top", "the", "a", "an", "of", "for", "in", "on",
  "how", "to", "what", "which", "is", "are", "and", "or", "vs", "about",
]);

function trimQueryForShortLabel(query         ) {
  const words = String(query || "").split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !QUERY_STOPWORDS.has(word.toLowerCase()));
  return (kept.length ? kept : words).slice(0, 4).join(" ");
}

function fnv1aHash(text         ) {
  let hash = 0x811c9dc5;
  const input = String(text || "");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function buildShortLabel(input         ) {
  const obj = isObject(input) ? input : null;
  const intent = obj ? asString(obj.intent) : null;
  const stabilityKey = (obj ? asString(obj.stabilityKey) : null) || "";
  const subjectKind = obj ? asString(obj.subjectKind) : null;
  if (!intent) return null;
  const phrases = subjectKind === "phrase" ? PHRASE_PALETTES[intent] : undefined;
  if (phrases) {
    return `${phrases[fnv1aHash(stabilityKey) % phrases.length]}...`;
  }
  const verbs = VERB_PALETTES[intent];
  if (!verbs) return null;
  let subject = obj && obj.subject ? String(obj.subject).trim() : "";
  if (!subject || subjectKind === "fixed") return null;

  subject = redactSecrets(subject).trim();
  if (!subject) return null;
  if (subjectKind === "query") subject = trimQueryForShortLabel(subject);
  const verb = verbs[fnv1aHash(stabilityKey) % verbs.length];

  const budgetForSubject = SHORT_LABEL_TARGET_CHARS - verb.length - 4;
  if (subject.length > budgetForSubject) {
    subject = subject.slice(0, Math.max(budgetForSubject, 8)).trimEnd();
  }
  return `${verb} ${subject}...`;
}

module.exports = { DEFAULT_MAX_LABEL_CHARS, SHORT_LABEL_MAX_CHARS, isObject, asString, normalizeLowerToken, pickString, pickStringEntry, collapseWhitespace, sanitizeText, categoryFromToolName, intentFromToolName, unwrapShellCommand, commandSegments, labelFromExecCommand, labelFromToolPurpose, pickPatchPath, mapToolLabel, delegationActivityLabel, buildShortLabel };
