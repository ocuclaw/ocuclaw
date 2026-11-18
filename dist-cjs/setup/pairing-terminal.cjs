const http = require("node:http");
const { stdin, stdout, stderr, env } = require("node:process");
const process = require("node:process");
const { PAIRING_CONTROL_PATH } = require("../domain/pairing/pairing-endpoint-address.cjs");
const { PAIRING_CONTROL_AUTH_HEADER, PAIRING_CONTROL_SECRET_HEADER } = require("../domain/pairing/pairing-control-service.cjs");
const { terminalText } = require("./terminal-text.cjs");
const { manualPairingBlock } = require("../domain/pairing/pairing-bootstrap-presenter.cjs");

const PHONE_CODE_COMPUTER = "In OcuClaw tap Pair with your agent, then type the phone code it shows:\n";
const PHONE_CODE_DASHBOARD = "In OcuClaw tap Pair with your agent.\nIt shows a phone code.\nPaste or type the phone code here:\n";
const PHONE_CODE_MANUAL = "For manual pairing, type m.\n";
const PHONE_CODE_SENT = "Sent to your phone.\nCheck the four words on your glasses\nor in OcuClaw. They should match the\nwords that appear here.\n";
const PHONE_CODE_OUTAGE = "Phone codes aren't working right now, so here's manual pairing.\n";
const PHONE_CODE_MISSING = "No phone is waiting with that code. Check the code in OcuClaw. If it ran out, tap Get a new code there.\n";
const PHONE_CODE_PAIRING_TYPED = "That's the pairing code, which goes into the phone. Here, type the 6-digit phone code that OcuClaw shows.\n";

function replyValue(value         )                {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  return value.trim() || null;
}

function firstValue(lines                   , label        )                {
  const prefix = `${label}:`;
  for (const line of lines) {
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (plain.startsWith(prefix)) {
      const value = plain.slice(prefix.length).trim();
      if (value) return value;
    }
  }
  return null;
}

function manualPairingText(created                     )         {
  const lines = String(created.bootstrapBlock ?? "").split(/\r?\n/);
  const address = replyValue(created.address) ?? firstValue(lines, "Address");
  const pairingCode = replyValue(created.pairingCode) ?? firstValue(lines, "Pairing code");
  if (address && pairingCode) return manualPairingBlock(address, pairingCode, created.expiresInSeconds);
  const kept = lines.filter((line) => !/[▀▄█]/.test(line) &&
    !(line.includes("\u001b[") && !line.replace(/\u001b\[[0-9;]*m/g, "").trim()));
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

class PairingControlError extends Error {
           reason                                           ;
  constructor(reason                                           ) {
    super("Pairing control unavailable.");
    this.reason = reason;
  }
}

function pairingControlRequest(connection                           , body                         , secret = "", timeoutMs = 3000)                               {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Pairing control unavailable."));
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) return fail();
    const payload = JSON.stringify({ v: 1, ...body });
    const request = http.request({
      hostname: "127.0.0.1", port: connection.port, path: PAIRING_CONTROL_PATH,
      method: "POST", agent: false,
      headers: { "content-type": "application/json", [PAIRING_CONTROL_AUTH_HEADER]: connection.relayCredential,
        ...(secret ? { [PAIRING_CONTROL_SECRET_HEADER]: secret } : {}) },
    }, (response     ) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk        ) => {
        data += chunk;
        if (data.length > 65536) request.destroy(new Error("Pairing control unavailable."));
      });
      response.on("error", fail);
      response.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (response.statusCode === 409) return reject(new PairingControlError("busy"));
          if (response.statusCode === 401) return reject(new PairingControlError("authentication"));
          if (response.statusCode !== 200 || parsed?.v !== 1 || Array.isArray(parsed)) return fail();
          resolve(parsed);
        } catch { fail(); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("Pairing control unavailable.")), timeoutMs);
    request.on("error", () => { clearTimeout(timer); fail(); });
    request.on("close", () => { clearTimeout(timer); });
    request.end(payload);
  }).catch((error) => { throw error instanceof PairingControlError ? error : new PairingControlError("unavailable"); })                                ;
}

function localeAllowsUnicode(locale         )          {
  const value = String(locale ?? "").trim();
  const dot = value.indexOf(".");
  if (dot < 0) return true;
  const codeset = value.slice(dot + 1).split("@")[0].replace(/[-_]/g, "").toLowerCase();
  return codeset === "" || codeset === "utf8";
}

const PROBE_CHAR = "é";

const PROBE_TIMEOUT_MS = 300;

const CURSOR_REPORT = /\u001b\[[0-9]+;([0-9]+)R/;

function probeTerminalUnicode(input     , output     , timeoutMs = PROBE_TIMEOUT_MS)                          {
  return new Promise((resolve) => {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return resolve(null);
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    let reply = "";
    let done = false;

    let drawn = false;
    const finish = (answer                ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("error", onFailure);
      input.off("end", onFailure);
      try { input.setRawMode(Boolean(wasRaw)); } catch {  }
      if (wasPaused) input.pause();

      try { output.write("\r\u001b[2K"); } catch {  }
      resolve(answer);
    };
    const onFailure = () => finish(null);
    const onData = (chunk         ) => {
      reply += String(chunk);

      if (reply.includes("\u0003")) {
        finish(null);
        try { process.kill(process.pid, "SIGINT"); } catch {  }
        return;
      }
      const match = CURSOR_REPORT.exec(reply);
      if (match && !drawn) {

        drawn = true;
        reply = reply.slice(match.index + match[0].length);
        clearTimeout(timer);
        timer = setTimeout(onFailure, timeoutMs);
        try { output.write(PROBE_CHAR + "\u001b[6n"); } catch { finish(null); }
        return;
      }
      if (match) {
        const advance = Number(match[1]) - 1;
        finish(advance === 1 ? true : advance === 2 ? false : null);
        return;
      }
      if (reply.length > 64) finish(null);
    };
    let timer = setTimeout(onFailure, timeoutMs);
    input.on("data", onData);
    input.on("error", onFailure);
    input.on("end", onFailure);
    try {
      input.setRawMode(true);
      input.resume();
      output.write("\r\u001b[2K\u001b[6n");
    } catch { finish(null); }
  });
}

const PAIRING_WATCH_MS = 315_000;

const PAIRING_READY_WAIT_MS = 600_000;
const PAIRING_ANSWER_PROMPT = "Type approve, refuse, or cancel: ";
const APPROVE_ANSWERS = ["yes", "approve", "approved"];
const DENY_ANSWERS = ["no", "refuse", "refused", "deny"];
const CANCEL_ANSWERS = ["cancel"];

function editDistance(a        , b        )         {
  const row = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

function classifyPairingAnswer(raw        )                                                                     {
  const answer = raw.trim().toLowerCase();
  if (APPROVE_ANSWERS.includes(answer)) return { kind: "approve" };
  if (DENY_ANSWERS.includes(answer)) return { kind: "deny" };
  if (CANCEL_ANSWERS.includes(answer)) return { kind: "cancel" };
  let near                    ;
  let nearDistance = 99;
  if (answer.length >= 2) {
    for (const word of [...APPROVE_ANSWERS, ...DENY_ANSWERS, ...CANCEL_ANSWERS]) {
      const distance = editDistance(answer, word);
      if (distance <= (word.length <= 3 ? 1 : 2) && distance < nearDistance) { near = word; nearDistance = distance; }
    }
  }
  return { kind: "unclear", near };
}

function readConfirmationLine(input     , options                                                                                     = {})                         {
  return new Promise((resolve) => {
    let buffer = "";
    let pending = "";
    let done = false;
    let escapeTimer                                           ;
    const finish = (value               ) => {
      if (done) return;
      done = true;
      clearTimeout(escapeTimer);
      input.off?.("data", onData);
      input.off?.("end", onEnd);
      input.off?.("close", onCancel);
      input.off?.("error", onCancel);
      options.signal?.removeEventListener("abort", onCancel);
      input.pause?.();
      resolve(value);
    };
    const onCancel = () => finish(null);
    const onEnd = () => finish(options.raw ? null : buffer);
    const onData = (chunk         ) => {
      pending += String(chunk);
      clearTimeout(escapeTimer);
      while (pending) {
        if (options.raw) {
          const report = /^\u001b\[[0-9]+;[0-9]+R/.exec(pending);
          if (report) { pending = pending.slice(report[0].length); continue; }
          if (/^\u001b\[[0-9;]*$/.test(pending)) {
            escapeTimer = setTimeout(onCancel, 30);
            return;
          }
        }

        const markers = ["\u001b[200~", "\u001b[201~"];
        const marker = markers.find((value) => pending.startsWith(value));
        if (marker) { pending = pending.slice(marker.length); continue; }
        if (markers.some((value) => value.startsWith(pending))) {
          escapeTimer = setTimeout(onCancel, 30);
          return;
        }
        const char = pending[0];
        pending = pending.slice(1);
        if (options.raw && /[\u0003\u0004\u001b]/.test(char)) return onCancel();
        if (char === "\n" || (options.raw && char === "\r")) return finish(buffer);
        if (options.raw && (char === "\u007f" || char === "\b")) {
          if (buffer.length) { buffer = buffer.slice(0, -1); options.output?.write("\b \b"); }
        }
        else if (!options.raw || char >= " ") {
          if (buffer.length >= 256) return finish("");
          buffer += char;
          if (options.raw) options.output?.write(char);
        }
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onCancel);
    input.once("error", onCancel);
    options.signal?.addEventListener("abort", onCancel, { once: true });
    if (options.signal?.aborted) return onCancel();
    input.resume?.();
  });
}

function pairingWordsBox(line        , unicode         )         {
  const [tl, tr, bl, br, h, v] = unicode ? "\u250c\u2510\u2514\u2518\u2500\u2502" : "++++-|";
  const inner = `   ${line}   `;
  return `  ${tl}${h.repeat(inner.length)}${tr}\n  ${v}${inner}${v}\n  ${bl}${h.repeat(inner.length)}${br}`;
}

async function runPairingTerminal(connection                           , io                    = {})                                 {
  const input = io.input ?? stdin;
  const output = io.output ?? stdout;
  const error = io.error ?? stderr;

  const dashboard = connection.dashboardTerminal === true || env.OPENCLAW_TERMINAL === "1";
  const result                        = { exitCode: 1, outcome: "failed", credentialDelivery: "not-observed", phoneConnection: "not-observed" };
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    error.write("Run pairing directly in an interactive terminal.\nPiped or redirected input/output cannot approve pairing.\n");
    return { ...result, exitCode: 2, outcome: "terminal-required" };
  }
  const request = io.request ?? pairingControlRequest;
  const pollMs = io.pollMs ?? 1000;
  let deadline = Date.now() + Math.min(io.deadlineMs ?? PAIRING_WATCH_MS, PAIRING_WATCH_MS);
  let secret = "";
  let exchangeId = "";
  let finished = false;
  let cancelled = false;
  let armed = false;
  let answer = "";
  let decision                = null;
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  const inputAbort = new AbortController();
  let codePhase = false;
  const stop = () => { cancelled = true; inputAbort.abort(); };

  let held = "";
  const withoutCursorReports = (chunk        ) => {

    if (armed) { held = ""; return chunk.replace(/\u001b\[[0-9]+;[0-9]+R/g, ""); }
    const text = held + chunk;
    held = "";
    const stripped = text.replace(/\u001b\[[0-9]+;[0-9]+R/g, "");
    const partial = /\u001b\[[0-9;]*$/.exec(stripped);
    if (!partial) return stripped;
    held = partial[0];
    return stripped.slice(0, partial.index);
  };

  const onData = (chunk         ) => {
    if (codePhase) return;

    const text = withoutCursorReports(String(chunk));

    if (text.length > 1 && text.startsWith("\u001b")) return;
    for (const char of text) {
      if (char === "\u0003" || char === "\u0004" || char === "\u001b") { stop(); return; }
      if (!armed || decision !== null) continue;
      if (char === "\r" || char === "\n") { decision = answer; armed = false; answer = ""; }
      else if (char === "\u007f" || char === "\b") {
        if (answer.length) { answer = answer.slice(0, -1); output.write("\b \b"); }
      }
      else if (char >= " " && answer.length < 256) { answer += char; output.write(char); }

    }
  };

  const pause = async () => {
    for (let left = pollMs; left > 0 && !cancelled; left -= 500) {
      await new Promise      ((resolve) => setTimeout(resolve, Math.min(left, 500)));
    }
  };
  const call = (op        , extra                          = {}) =>
    request(connection, { op, ...extra }, secret, op === "create" ? 12000 : op === "phone-code-status" ? 4000 : 3000);

  const probed = await probeTerminalUnicode(input, output, io.probeTimeoutMs);
  const unicode = probed === null
    ? localeAllowsUnicode(env.LC_ALL || env.LC_CTYPE || env.LANG || "")
    : probed;
  input.on("data", onData);
  input.on("end", stop);
  input.on("close", stop);
  input.on("error", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    input.setRawMode(true);
    input.resume();

    const create = (phoneCode         ) => call("create", { address: connection.phoneAddress,
      ...(connection.customRoute ? { customRoute: true } : {}),
      ...(phoneCode === undefined ? {} : { phoneCode }) });
    let created                                 ;
    let askedCode = false;

    {
      let status                     ;
      try { status = await call("phone-code-status", { address: connection.phoneAddress, customRoute: connection.customRoute === true }); }
      catch { status = { available: false, reason: "off" }; }
      if (status.available === true && !cancelled) {
        askedCode = true;
        codePhase = true;
        output.write(terminalText("\nPair your phone\n", "heading", output));
        output.write(dashboard ? PHONE_CODE_DASHBOARD : PHONE_CODE_COMPUTER);
        output.write(PHONE_CODE_MANUAL);
        let tries = 3;
        while (!cancelled && tries > 0) {
          codePhase = true;
          const line = readConfirmationLine(input, { raw: true, signal: inputAbort.signal, output });
          output.write("> ");
          const code = await line;
          codePhase = false;
          input.resume();
          output.write("\n");
          if (code === null) { stop(); break; }
          if (!code.trim()) continue;
          if (code.trim().toLowerCase() === "m") break;
          const reply = await create(code);
          if (reply.reason === "pairing_code_typed") { output.write(PHONE_CODE_PAIRING_TYPED); continue; }
          if (["malformed", "no_code", "spent"].includes(reply.reason)) {
            output.write(PHONE_CODE_MISSING);
            tries--;
            if (tries) output.write(`${tries} ${tries === 1 ? "try" : "tries"} left.\n`);
            continue;
          }
          created = reply;
          break;
        }
        codePhase = false;
        input.resume();
      } else if (!cancelled && status.reason === "unavailable") output.write(PHONE_CODE_OUTAGE);
    }

    const readyLines = io.readyLines ?? [];
    if (!askedCode && !cancelled && readyLines.length) {
      for (const line of readyLines) output.write(`${terminalText(line, "action", output)}\n`);
      const gate = new AbortController();
      const endGate = () => gate.abort();
      let waitedOut = false;
      inputAbort.signal.addEventListener("abort", endGate, { once: true });
      const timer = setTimeout(() => { waitedOut = true; endGate(); }, io.readyWaitMs ?? PAIRING_READY_WAIT_MS);
      codePhase = true;
      const ready = await readConfirmationLine(input, { raw: true, signal: gate.signal });
      codePhase = false;
      clearTimeout(timer);
      inputAbort.signal.removeEventListener("abort", endGate);
      input.resume();

      if (ready === null && !waitedOut) stop();
    }
    if (cancelled && !created) {
      result.outcome = "cancelled";
      output.write("\nPairing cancelled. Start pairing again to retry.\n");
      return result;
    }
    created ??= await create();
    deadline = Date.now() + Math.min(io.deadlineMs ?? PAIRING_WATCH_MS, PAIRING_WATCH_MS);
    if (typeof created.controlSecret !== "string" || !created.controlSecret || typeof created.exchangeId !== "string") throw new Error("Invalid control response");
    secret = created.controlSecret;
    exchangeId = created.exchangeId;
    if (cancelled) {
      result.outcome = "cancelled";
      output.write("\nPairing cancelled. Start pairing again to retry.\n");
      return result;
    }
    if (created.delivery === "sent") output.write(PHONE_CODE_SENT);
    else {
      if (typeof created.bootstrapBlock !== "string") throw new Error("Invalid bootstrap");
      if (created.delivery === "unavailable") output.write(PHONE_CODE_OUTAGE);
      if (!askedCode) output.write(terminalText("\nPair your phone\n", "heading", output));
      output.write(terminalText("Keep the pairing code and words private. Do not paste them into chats or logs.\n", "detail", output));
      output.write(manualPairingText(created));
    }
    output.write("Waiting for the phone. Ctrl-C cancels.\n");
    result.phase = "waiting-for-phone";
    let prompted = false;
    while (!cancelled && Date.now() < deadline) {
      const state = await call("state");
      if (cancelled || Date.now() >= deadline) break;
      if (state.exchangeId !== exchangeId) throw new Error("Exchange changed");
      if (state.state === "awaiting-approval" || state.prompt) result.phase = "awaiting-approval";
      if (state.state === "awaiting-phone-completion") result.phase = "awaiting-phone-connection";
      if (state.state === "failed") {
        finished = true;
        result.outcome = state.failure?.reason === "expired" ? "expired" : "failed";
        if (result.outcome === "expired") result.failureReason = "expired";
        if (state.failure?.reason === "phone_key_mismatch") result.failureReason = "phone_key_mismatch";
        break;
      }
      if (state.state === "completed") {
        finished = true;

        if (state.credentialExposure === "delivered") {
          result.outcome = "connection-observed";
          result.credentialDelivery = "delivered";
          result.phoneConnection = "new-authenticated-connection-observed";
        }
        break;
      }
      if (state.prompt && !prompted) {
        const words = state.prompt.safetyPhrase;
        if (state.prompt.exchangeId !== exchangeId || !Array.isArray(words) || words.length !== 4 || !words.every((word         ) => typeof word === "string" && /^[a-z]+$/.test(word))) throw new Error("Invalid comparison");

        const phoneLabel = typeof state.prompt.phoneLabel === "string" && state.prompt.phoneLabel.trim()
          ? state.prompt.phoneLabel.trim()
          : "Unknown device";

        output.write(`\nPhone: ${phoneLabel}\nCheck these words match your phone, in this order:\n${pairingWordsBox(words.join("   "), unicode)}\nIf they differ, refuse.\n`);
        output.write(terminalText(PAIRING_ANSWER_PROMPT, "action", output));

        await new Promise      ((resolve) => setTimeout(resolve, 0));
        if (cancelled || Date.now() >= deadline) break;
        answer = "";
        armed = true;
        prompted = true;
      }
      if (decision !== null) {
        if (cancelled || Date.now() >= deadline) break;
        const choice = classifyPairingAnswer(decision);
        if (choice.kind === "unclear") {

          output.write("\nNot approved. ");
          output.write(terminalText(PAIRING_ANSWER_PROMPT, "action", output));
          decision = null;
          answer = "";
          armed = true;
          await pause();
          continue;
        }
        const approve = choice.kind === "approve";
        const op = approve ? "approve" : choice.kind === "cancel" ? "cancel" : "deny";

        if (approve) { result.credentialDelivery = "uncertain"; result.phase = "awaiting-phone-connection"; }
        const response = await call(op);
        if (!approve) { finished = true; result.outcome = op === "cancel" ? "cancelled" : "refused"; break; }
        if (response.credentialExposure === "delivered") result.credentialDelivery = "delivered";

        if (!response.ok && response.state === "failed" && response.failure?.reason === "expired") {
          finished = true;
          result.outcome = "expired";
          result.failureReason = "expired";
          if (response.credentialExposure === "none") {
            result.credentialDelivery = "not-observed";
            result.phase = "awaiting-approval";
          }
          break;
        }
        if (!response.ok) throw new Error("Decision refused");
        if (response.state === "completed" && response.credentialExposure === "delivered") {
          finished = true;
          result.outcome = "connection-observed";
          result.phoneConnection = "new-authenticated-connection-observed";
          break;
        }
        output.write("\nApproved. Waiting for your phone to connect.\n");
        decision = null;
      }
      await pause();
    }
    if (!finished) result.outcome = cancelled ? "cancelled" : "expired";
  } catch (error) {

    result.outcome = "failed";
    if (error instanceof PairingControlError && error.reason === "busy") output.write("\nAnother pairing request may be active.\nLet its owner finish or cancel it, then try pairing again.\n");
    else if (error instanceof PairingControlError && error.reason === "authentication") output.write("\nPairing authentication was refused.\nRun the setup checks, then try pairing again.\n");
  } finally {
    armed = false;
    if (secret && !finished) { try { await call("cancel"); } catch {  } }
    secret = "";
    input.off("data", onData);
    input.off("end", stop);
    input.off("close", stop);
    input.off("error", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try { input.setRawMode(Boolean(wasRaw)); } catch {  }
    if (wasPaused) input.pause();
  }
  if (result.credentialDelivery === "delivered") {
    result.exitCode = 0;
    output.write(result.phoneConnection === "new-authenticated-connection-observed"
      ? "\nPaired. Your phone is connected.\n"
      : "\nEncrypted credential delivery completed. This phone's authenticated connection has not been observed; check the phone before retrying.\n");
  } else if (io.driven === true && result.outcome === "expired") {
    output.write("\n");
  } else {

    const ending = result.outcome === "expired"
      ? "Pairing took longer than the five-minute window."
      : result.failureReason === "phone_key_mismatch" ? "Pairing stopped."
      : `Pairing ${result.outcome}.`;
    output.write(`\n${ending} ${result.credentialDelivery === "uncertain" ? "Credential delivery is uncertain; check the phone before retrying." : "No credential delivery was observed. Start pairing again to retry."}\n`);
  }
  return result;
}

module.exports = { PHONE_CODE_COMPUTER, PHONE_CODE_DASHBOARD, PHONE_CODE_MANUAL, PHONE_CODE_SENT, PHONE_CODE_OUTAGE, PHONE_CODE_MISSING, PHONE_CODE_PAIRING_TYPED, manualPairingText, pairingControlRequest, localeAllowsUnicode, classifyPairingAnswer, readConfirmationLine, runPairingTerminal };
