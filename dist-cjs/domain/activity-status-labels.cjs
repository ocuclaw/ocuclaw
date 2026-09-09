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

function classifyExecSegment(tokens) {
  const head = tokens[0];
  const bin = path.basename(head);
  const rest = tokens.slice(1);
  const joined = tokens.join(" ");
  const firstFileArg = (extra = null) => {
    for (const tok of rest) {
      if (tok.startsWith("-")) continue;
      if (extra && extra(tok)) continue;
      return tok;
    }
    return null;
  };

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
  if (bin === "ls") return execResult("Listing files...", "search", "search.files");
  if (bin === "wc") return execResult("Counting matches...", "search", "search.files");
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
  if (
    (PKG_MANAGER_BINS.has(bin) && /\btest\b/.test(joined)) ||
    TEST_RUNNER_BINS.has(bin) ||
    (bin === "node" && /(^|\s)--test\b/.test(joined)) ||
    ((bin === "cargo" || bin === "go") && rest[0] === "test") ||
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
  if (bin === "python" || bin === "python3" || bin === "node") {
    return execResult("Running a script...", "terminal", "terminal.exec");
  }
  return null;
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

  for (const tokens of segments) {
    const hit = classifyExecSegment(tokens);
    if (hit) return hit;
  }

  if (/https?:\/\//i.test(raw)) {
    const url = extractFirstUrl(raw);
    const host = hostFromUrl(url);
    if (host) return execResult(`Fetching from ${host}...`, "network", "network.fetch", host, "host");
    return execResult("Fetching data...", "network", "network.fetch");
  }

  return execResult(`Running: ${sanitizeText(raw, DEFAULT_MAX_LABEL_CHARS)}`, "terminal", "terminal.exec");
}

function mapToolLabel(toolName, activityPath, args, options) {
  const maxLabelChars = options.maxLabelChars;
  const stabilityKey = (options && options.stabilityKey) || null;
  const lowName = String(toolName || "").toLowerCase();
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
  ]);
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
    case "get_current_location":
      return {
        label: "Checking location...",
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
      const fetchHost = hostFromUrl(url);
      return {
        label: fetchHost ? `Fetching from ${fetchHost}...` : "Fetching data...",
        detail: url || null,
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
        label: "Starting a sub-agent...",
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

function trimQueryForShortLabel(query) {
  const words = String(query || "").split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !QUERY_STOPWORDS.has(word.toLowerCase()));
  return (kept.length ? kept : words).slice(0, 4).join(" ");
}

function fnv1aHash(text) {
  let hash = 0x811c9dc5;
  const input = String(text || "");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function buildShortLabel(input) {
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

module.exports = { DEFAULT_MAX_LABEL_CHARS, SHORT_LABEL_MAX_CHARS, isObject, asString, normalizeLowerToken, pickString, pickStringEntry, collapseWhitespace, sanitizeText, categoryFromToolName, intentFromToolName, unwrapShellCommand, commandSegments, labelFromExecCommand, mapToolLabel, buildShortLabel };
