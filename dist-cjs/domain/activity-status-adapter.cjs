const { classifyRank } = require("./activity-status-arbiter.cjs");
const { DEFAULT_MAX_LABEL_CHARS, SHORT_LABEL_MAX_CHARS, isObject, asString, normalizeLowerToken, pickString, pickStringEntry, collapseWhitespace, sanitizeText, intentFromToolName, mapToolLabel } = require("./activity-status-labels.cjs");
const { shortenActivityProse, shortenBatchProse, shortenToolPurpose, splitBoldHeading } = require("./activity-prose.cjs");

const GLOBAL_RUN_KEY = "__global__";

const PENDING_PROSE_MAX_AGE_MS = 30000;

const INTERNAL_HINT_KEYS = ["purpose", "thinkingProse", "thinkingSummaryLong", "thinkingLive"];

const SHORT_FIT_MAX_CHARS = 40;

const HEADLINE_NOTE_MAX_CHARS = 160;

const HEADLINE_PHRASE_MAX_CHARS = 2000;
const THINKING_SUMMARY_KEYS = ["summary", "thinkingSummary", "reasoningSummary", "intentLabel"];
const THINKING_DETAIL_KEYS = ["thinking", "reasoning", "thinkingText", "analysis"];
const GENERIC_THINKING_LABEL = "Thinking...";
const ACTIVITY_INTENTS = new Set([
  "thinking",
  "thinking_summary",
  "queued",
  "fs.read",
  "fs.write",
  "fs.edit",
  "search.files",
  "search.web",
  "browser.browse",
  "browser.navigate",
  "browser.fill",
  "network.fetch",
  "terminal.exec",
  "terminal.git",
  "agent.subtask",
  "agent.coordinate",
  "message.send",
  "session.manage",
  "canvas.edit",
  "session.title.update",
  "device.check",
  "interface.build",
  "board.create",
  "board.read",
  "board.unblock",
  "board.annotate",
  "board.link",
  "generic",
]);

function normalizeThinkingText(raw) {
  const text = asString(raw);
  if (!text) return null;
  const cleaned = text.replace(/\*\*/g, "").trim();
  return cleaned || null;
}

function extractFirstBoldThinkingSegment(raw) {
  const text = asString(raw);
  if (!text) return null;
  const match = text.match(/\*\*([\s\S]+?)\*\*/);
  if (!match) return null;
  return normalizeThinkingText(match[1]);
}

function normalizeThinkingSummarySource(value) {
  const normalized = normalizeLowerToken(value);
  return (
    normalized === "summary" ||
    normalized === "bold" ||
    normalized === "detail" ||
    normalized === "generic"
  )
    ? normalized
    : null;
}

function normalizeIntent(value) {
  const normalized = normalizeLowerToken(value);
  return ACTIVITY_INTENTS.has(normalized) ? normalized : null;
}

function normalizeToolPhase(value) {
  const normalized = normalizeLowerToken(value);
  return normalized === "start" || normalized === "end" ? normalized : null;
}

function normalizeModelCallSeq(value         )                {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isNarrationActivity(activity) {
  return (
    normalizeLowerToken(activity && activity.origin) === "narration" ||
    normalizeLowerToken(activity && activity.category) === "narration"
  );
}

function parseArgs(raw) {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeArgs(activity) {
  const candidates = [
    activity && activity.args,
    activity && activity.arguments,
    activity && activity.toolArgs,
    activity && activity.input,
  ];
  for (const candidate of candidates) {
    const parsed = parseArgs(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function claudeCodeShellPurpose(activity     , args     )                {
  if (!activity || activity.tool !== "Bash" || !args) return null;
  return asString(args.description) || null;
}

function pickThinkingSummary(activity) {
  return normalizeThinkingText(pickString(activity, THINKING_SUMMARY_KEYS));
}

function pickThinkingDetail(activity) {
  return normalizeThinkingText(pickString(activity, THINKING_DETAIL_KEYS));
}

function resolveThinkingContent(activity, existingLabel, existingDetail, includeThinking) {
  const summaryEntry = pickStringEntry(activity, THINKING_SUMMARY_KEYS);
  const detailEntry = pickStringEntry(activity, THINKING_DETAIL_KEYS);
  const summaryText = normalizeThinkingText(summaryEntry && summaryEntry.value);
  const detailText = normalizeThinkingText(detailEntry && detailEntry.value);
  const boldLabelCandidate = extractFirstBoldThinkingSegment(detailEntry && detailEntry.value);
  const explicitSource = normalizeThinkingSummarySource(
    activity && activity.thinkingSummarySource
  );
  const existingLabelText = normalizeThinkingText(existingLabel);
  const existingDetailText = normalizeThinkingText(existingDetail);

  const candidates = [
    { source: "summary", label: summaryText },
    { source: "bold", label: boldLabelCandidate },
    { source: "detail", label: detailText },
  ];

  let selected = null;
  if (explicitSource === "generic") {

    selected = {
      source: "generic",
      label: summaryText || existingLabelText || GENERIC_THINKING_LABEL,
    };
  } else if (explicitSource) {
    const explicitLabel = (
      candidates.find((candidate) => (
        candidate.source === explicitSource &&
        candidate.label
      ))?.label ||
      existingLabelText ||
      summaryText ||
      boldLabelCandidate ||
      detailText
    );
    if (explicitLabel) {
      selected = { source: explicitSource, label: explicitLabel };
    }
  }
  if (!selected) {
    selected = candidates.find((candidate) => candidate.label) || null;
  }
  if (!selected && existingLabelText) {
    const normalizedExistingLabel = normalizeLowerToken(existingLabelText);
    const inferredSource =
      normalizedExistingLabel === "thinking" || normalizedExistingLabel === "thinking..."
        ? "generic"
        : "detail";
    selected = { source: inferredSource, label: existingLabelText };
  }
  if (!selected && includeThinking) {
    selected = { source: "generic", label: GENERIC_THINKING_LABEL };
  }

  return {
    label: selected ? selected.label : null,
    detail: detailText || existingDetailText || (
      selected && selected.source !== "generic" ? selected.label : null
    ),
    thinkingSummarySource: selected ? selected.source : null,
  };
}

function isThinkingActivity(activity, category) {
  const state = normalizeLowerToken(activity && activity.state);
  if (state !== "thinking" && state !== "queued") return false;
  if (activity && activity.tool) return false;

  if (normalizeLowerToken(category) === "thinking") return true;
  if (normalizeLowerToken(activity && activity.category) === "thinking") return true;
  if (normalizeLowerToken(activity && activity.origin) === "thinking") return true;
  if (pickThinkingSummary(activity)) return true;
  if (pickThinkingDetail(activity)) return true;
  return !(activity && activity.tool);
}

function lowercaseLeadingWord(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) return rawText;
  const match = rawText.match(/[A-Za-z][A-Za-z0-9_-]*/);
  if (!match || match.index == null) return rawText;
  const start = match.index;
  const token = match[0];
  const end = start + token.length;
  return `${rawText.slice(0, start)}${token.toLowerCase()}${rawText.slice(end)}`;
}

function isExplanatoryThinkingLabel(label) {
  const normalizedLabel = normalizeThinkingText(label);
  if (!normalizedLabel) return false;
  const normalizedToken = collapseWhitespace(normalizedLabel)
    .toLowerCase()
    .replace(/\u2026/g, "...");
  return normalizedToken !== "thinking" && normalizedToken !== "thinking...";
}

function normalizePhase(phase, state) {
  const p = typeof phase === "string" ? phase.toLowerCase() : "";
  if (p === "start" || p === "update" || p === "end") return p;
  if (
    p === "error" ||
    p === "complete" ||
    p === "completed" ||
    p === "done" ||
    p === "result" ||
    p === "failed" ||
    p === "finish" ||
    p === "finished"
  ) {
    return "end";
  }

  const s = typeof state === "string" ? state.toLowerCase() : "";
  if (s === "idle" || s === "error" || s === "done" || s === "cancelled" || s === "canceled") return "end";
  if (s === "thinking" || s === "queued") return "update";
  return "update";
}

function normalizeRunKey(runId) {
  if (typeof runId === "string" && runId.trim()) return runId.trim();
  return GLOBAL_RUN_KEY;
}

function sanitizeIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function clampFreshnessWindow(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : 5000;
  if (n < 3000) return 3000;
  if (n > 8000) return 8000;
  return n;
}

function createActivityStatusAdapter(opts) {
  const options = opts || {};
  const enabled = options.enabled !== false;
  const includeThinking = options.includeThinking !== false;
  const maxLabelChars =
    Number.isFinite(options.maxLabelChars) && options.maxLabelChars > 0
      ? Math.floor(options.maxLabelChars)
      : DEFAULT_MAX_LABEL_CHARS;
  const freshnessWindowMs = clampFreshnessWindow(options.freshnessWindowMs);
  const now =
    typeof options.now === "function" ? options.now : () => Date.now();

  const labOn = (token        , frame      ) => {
    if (typeof options.labs !== "function") return false;
    const labs = options.labs(frame);
    return Array.isArray(labs) && labs.includes(token);
  };

  const runStates = new Map();

  function getRunState(runKey) {
    let state = runStates.get(runKey);
    if (!state) {
      state = {
        seq: 0,
        toolStartCount: 0,
        currentActivityId: null,
        toolContextByActivityId: new Map(),
        pendingProse: null,

        chapter: null,
        capabilities: {
          sawSummary: false,
          sawToolCall: false,
          sawThinkingBlock: false,
          hasToolCallId: false,
          hasSignature: false,
          hasTurnId: false,
        },
      };
      runStates.set(runKey, state);
    }
    return state;
  }

  function reset() {
    runStates.clear();
  }

  function noteProse(rawActivity     ) {
    if (!isObject(rawActivity)) return null;

    const { heading, text } = splitBoldHeading(pickString(rawActivity, THINKING_SUMMARY_KEYS));
    if (labOn("chapters") && heading) getRunState(normalizeRunKey(rawActivity.runId)).chapter = heading;
    if (!labOn("prose")) return null;

    const prose = (rawActivity.prosePick === "last" ? null : shortenBatchProse(text)) ||
      shortenActivityProse(text, {
        pick: rawActivity.prosePick === "last" ? "last" : "first",
        oneStep: true,
      });
    if (!prose) return null;
    const runState = getRunState(normalizeRunKey(rawActivity.runId));
    const previous = runState.pendingProse;

    if (previous && previous.sentence === prose.sentence) return previous;
    runState.pendingProse = {
      label: prose.label,
      fits: prose.fits,
      sentence: prose.sentence,
      modelCallSeq: normalizeModelCallSeq(rawActivity.modelCallSeq),
      atMs: now(),
      claimedBy: null,
    };
    return runState.pendingProse;
  }

  function pickShortFit(label     , fits     ) {
    if (!label || label.length <= SHORT_FIT_MAX_CHARS || !Array.isArray(fits)) return null;
    return fits.find((fit        ) => fit.length <= SHORT_FIT_MAX_CHARS) || fits[fits.length - 1] || null;
  }

  function proseHeadline(activity     , detailText     , maxChars         ) {
    const longSummary = asString(activity.thinkingSummaryLong);
    if (longSummary) {
      const fromSummary =
        shortenActivityProse(longSummary, { pick: "first", maxChars }) ||
        shortenToolPurpose(longSummary, { maxChars });
      if (fromSummary) return fromSummary;
    }
    const latest = shortenActivityProse(asString(activity.thinkingProse) || detailText, { pick: "last", maxChars });

    if (!latest || !batchSaysMore(latest.sentence)) return latest;
    return shortenBatchProse(latest.sentence, { maxChars }) || latest;
  }

  function batchSaysMore(sentence        ) {
    const batch = shortenBatchProse(sentence);
    if (!batch) return false;
    const oneStep = shortenActivityProse(sentence, { pick: "last" });
    const bare = (label        ) => label.replace(/\.{3}$|…$/, "").trim().length;
    return !oneStep || bare(batch.label) > bare(oneStep.label);
  }

  const headlineNotes = new WeakMap                ();

  function headlineNote(augmented     )                {
    return isObject(augmented) ? headlineNotes.get(augmented) ?? null : null;
  }

  function liveProseHeadlines(rawActivity     ) {
    if (!isObject(rawActivity) || !labOn("headline", rawActivity)) return false;
    return proseHeadline(rawActivity, null) !== null;
  }

  function authoredToolLabel(activity     , runState     , activityId     , args     ) {
    const pending = runState.pendingProse;
    if (pending && labOn("prose") && !pending.claimedBy && now() - pending.atMs <= PENDING_PROSE_MAX_AGE_MS) {
      const modelCallSeq = normalizeModelCallSeq(activity.modelCallSeq);
      const otherCall =
        pending.modelCallSeq !== null &&
        modelCallSeq !== null &&
        pending.modelCallSeq !== modelCallSeq;
      if (!otherCall) {
        pending.claimedBy = activityId || "tool";
        return { label: pending.label, fits: pending.fits, source: "prose" };
      }
    }
    if (labOn("purpose")) {

      const purpose = shortenToolPurpose(
        asString(activity.purpose) || asString(args && args.title) || claudeCodeShellPurpose(activity, args),
      );
      if (purpose) return { label: purpose.label, fits: purpose.fits, source: "purpose" };
    }
    return null;
  }

  function augmentActivity(rawActivity) {
    if (!isObject(rawActivity)) return rawActivity;

    const activity = { ...rawActivity };
    const runKey = normalizeRunKey(activity.runId);
    const runState = getRunState(runKey);
    const phase = normalizePhase(activity.phase, activity.state);
    const toolPhase = normalizeToolPhase(activity.toolPhase);
    const rawPhase = asString(activity.phase) && activity.phase.trim()
      ? activity.phase.trim()
      : null;
    const preserveErrorPhase = rawPhase && rawPhase.toLowerCase() === "error";

    runState.seq += 1;
    const seq = Number.isFinite(activity.seq) ? Math.floor(activity.seq) : runState.seq;

    let activityId = asString(activity.activityId) && activity.activityId.trim()
      ? activity.activityId.trim()
      : null;

    if (!activityId) {
      if (phase === "start") {
        if (activity.origin === "tool" || activity.tool) {
          runState.toolStartCount += 1;
          const toolName = sanitizeIdPart(activity.tool || "tool");
          activityId = `${runKey}:tool:${toolName || "tool"}:${runState.toolStartCount}`;
        } else if (activity.origin === "lifecycle") {
          activityId = `${runKey}:lifecycle`;
        } else {
          activityId = `${runKey}:activity:${runState.seq}`;
        }
      } else {
        activityId = runState.currentActivityId || `${runKey}:activity`;
      }
    }

    if (phase === "start" || phase === "update") {
      runState.currentActivityId = activityId;
    }

    if (phase === "end" || toolPhase === "end") {
      runState.currentActivityId = null;
    }

    let label = asString(activity.label);
    let shortLabel = null;
    let detail = asString(activity.detail);
    let category = asString(activity.category);
    let thinkingSummarySource = null;
    let suppressThinkingContent = false;

    let labelSource = null;
    let labelFits = null;
    let toolLabel = null;

    let relayHeadlineNote                = null;
    const args = normalizeArgs(activity) || {};
    const previousToolContext = activity.tool && activityId
      ? runState.toolContextByActivityId.get(activityId)
      : null;
    const hasCurrentToolContext =
      (activity.tool === "render_glasses_ui" && normalizeArgs(activity) !== null) ||
      !!asString(activity.path) ||
      !!pickString(args, [
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
        "query",
        "q",
        "term",
        "search",
        "url",
        "href",
        "uri",
        "command",
        "cmd",
        "shell",
      ]);
    const mappedTool = activity.tool
      ? mapToolLabel(activity.tool, activity.path, args, {
        maxLabelChars,
        stabilityKey: activityId,

        meta: asString(activity.meta),

        delegation: activity.delegation,
      })
      : null;
    const isNarration = isNarrationActivity(activity);
    const isThinking = !isNarration && isThinkingActivity(activity, category);

    if (isNarration) {
      if (!category) category = "narration";
      if (!label) label = pickThinkingSummary(activity);

      if (label && label.length > SHORT_LABEL_MAX_CHARS) {
        shortLabel = label;
      }
    } else if (isThinking) {
      if (!category) category = "thinking";
      const resolvedThinking = resolveThinkingContent(
        activity,
        label,
        detail,
        includeThinking,
      );
      thinkingSummarySource = resolvedThinking.thinkingSummarySource;
      if (!label) {
        label = resolvedThinking.label;
      }
      if (!detail) {
        detail = resolvedThinking.detail;
      }

      if (
        includeThinking &&
        labOn("headline", activity) &&
        (thinkingSummarySource === "detail" || thinkingSummarySource === "generic")
      ) {
        const headline = proseHeadline(activity, resolvedThinking.detail);
        if (headline) {
          label = headline.label;
          thinkingSummarySource = "summary";
          labelSource = "prose";
          labelFits = headline.fits.length > 0 ? headline.fits : null;
          shortLabel = pickShortFit(headline.label, headline.fits);
          const whole = proseHeadline(activity, resolvedThinking.detail, HEADLINE_NOTE_MAX_CHARS);
          const phrase = (whole || headline).label.replace(/\.{3}$|…$/, "").trim();

          const uncut = whole ? proseHeadline(activity, resolvedThinking.detail, HEADLINE_PHRASE_MAX_CHARS) : null;
          const wasCut = !whole || (!!uncut && uncut.label !== whole.label);
          relayHeadlineNote = phrase ? (wasCut ? `${phrase}…` : phrase) : null;
        }
      }

      if (label && isExplanatoryThinkingLabel(label) && label.length > SHORT_LABEL_MAX_CHARS) {
        shortLabel = label;
      }

      if (!includeThinking) {
        suppressThinkingContent = true;
        label = null;
        detail = null;
        shortLabel = null;
        thinkingSummarySource = null;
      }
    } else if (!label && activity.tool) {

      const authoredContext =
        previousToolContext && previousToolContext.labelSource ? previousToolContext : null;
      if (previousToolContext && (authoredContext || !hasCurrentToolContext)) {
        label = previousToolContext.label;
        shortLabel = previousToolContext.shortLabel || null;
        if (!detail) detail = previousToolContext.detail;
        if (!category) category = previousToolContext.category;
        labelSource = previousToolContext.labelSource || null;
        labelFits = previousToolContext.labelFits || null;
        toolLabel = previousToolContext.toolLabel || null;
      }
      if (!label) {
        const mapped      = mappedTool;
        const authored = !previousToolContext && toolPhase !== "end"
          ? authoredToolLabel(activity, runState, activityId, args)
          : null;
        if (authored) {
          label = authored.label;
          labelSource = authored.source;
          labelFits = authored.fits.length > 0 ? authored.fits : null;
          shortLabel = pickShortFit(authored.label, authored.fits);

          toolLabel = mapped.label || null;
          if (!detail) detail = mapped.detail || mapped.label;
        } else {
          label = mapped.label;
          shortLabel = mapped.shortLabel || null;
          if (!detail) detail = mapped.detail;
        }
        if (!category) category = mapped.category;
      }
    }

    let intent = normalizeIntent(activity.intent);
    if (normalizeLowerToken(activity && activity.state) === "queued") {
      intent = "queued";
    } else if (activity.tool) {
      intent = (
        (!hasCurrentToolContext && previousToolContext && previousToolContext.intent) ||
        (mappedTool && mappedTool.intent) ||
        intentFromToolName(normalizeLowerToken(activity.tool), args)
      );
    } else if (isThinking) {
      intent = thinkingSummarySource !== "generic" && isExplanatoryThinkingLabel(label)
        ? "thinking_summary"
        : "thinking";
    }

    if (activity.tool && activityId && label) {
      runState.toolContextByActivityId.set(activityId, {
        label,
        shortLabel: shortLabel || null,
        detail: detail || null,
        category: category || null,
        intent: intent || null,
        labelSource,
        labelFits,
        toolLabel,
        chapter: previousToolContext ? previousToolContext.chapter || null : runState.chapter,
      });
    }
    const chapter = activity.tool && activityId && labOn("chapters")
      ? (runState.toolContextByActivityId.get(activityId) || {}).chapter || null
      : null;

    const result = {
      ...activity,
      activityId,
      seq,
      phase: preserveErrorPhase ? "error" : phase,
    };
    for (const key of INTERNAL_HINT_KEYS) delete result[key];
    delete result.labelSource;
    delete result.labelFits;
    delete result.toolLabel;
    delete result.chapter;

    delete result.buildKind;
    const buildKind = intent === "interface.build"
      ? ((!hasCurrentToolContext && previousToolContext && previousToolContext.buildKind) ||
        (mappedTool && mappedTool.buildKind)) : null;
    if (buildKind) result.buildKind = buildKind;
    if (activity.tool && activityId && label) {
      const context = runState.toolContextByActivityId.get(activityId);
      if (context && buildKind) context.buildKind = buildKind;
    }

    if (suppressThinkingContent) {
      delete result.label;
      delete result.detail;
      delete result.shortLabel;
    }

    if (runKey !== GLOBAL_RUN_KEY && !result.runId) {
      result.runId = runKey;
    }

    if (typeof activity.isError === "boolean") {
      result.isError = activity.isError;
    }
    if (typeof activity.code === "string" && activity.code.trim()) {
      result.code = activity.code.trim();
    }
    if (Number.isFinite(activity.exitCode)) {
      result.exitCode = Math.trunc(activity.exitCode);
    }
    if (Number.isFinite(activity.durationMs) && activity.durationMs >= 0) {
      result.durationMs = Math.trunc(activity.durationMs);
    }

    if (isObject(activity.rateLimitInfo)) {
      result.rateLimitInfo = activity.rateLimitInfo;
    }
    if (activity.failoverPending === true) {
      result.failoverPending = true;
    }

    const candidateRank = classifyRank({
      isError: activity.isError === true,
      phaseIsError: preserveErrorPhase === true,
      hasRateLimitInfo: isObject(activity.rateLimitInfo),
      failoverPending: activity.failoverPending === true,
      hasTool: !!activity.tool,
      origin: activity.origin,
      isThinking,
      includeThinking,
      thinkingSummarySource,
      label,
    });
    result.candidateRank = candidateRank;
    result.sourceType = candidateRank;

    const caps = runState.capabilities;
    if (candidateRank === "generated_summary") caps.sawSummary = true;
    if (activity.tool) caps.sawToolCall = true;
    if (isThinking) caps.sawThinkingBlock = true;
    if (typeof activity.toolCallId === "string" && activity.toolCallId.trim()) {
      caps.hasToolCallId = true;
    }
    if (
      typeof activity.thinkingSignatureId === "string" &&
      activity.thinkingSignatureId.trim()
    ) {
      caps.hasSignature = true;
    }
    if (typeof activity.turnId === "string" && activity.turnId.trim()) {
      caps.hasTurnId = true;
    }
    result.capabilityFlags = { ...caps };

    result.candidateAtMs = now();
    result.freshnessWindowMs = freshnessWindowMs;

    if (typeof activity.toolCallId === "string" && activity.toolCallId.trim()) {
      result.toolCallId = activity.toolCallId.trim();
    } else {
      delete result.toolCallId;
    }
    if (typeof activity.turnId === "string" && activity.turnId.trim()) {
      result.turnId = activity.turnId.trim();
    } else {
      delete result.turnId;
    }
    if (typeof activity.thinkingSignatureId === "string" && activity.thinkingSignatureId.trim()) {
      result.thinkingSignatureId = activity.thinkingSignatureId.trim();
    } else {
      delete result.thinkingSignatureId;
    }

    if (toolPhase) {
      result.toolPhase = toolPhase;
    } else {
      delete result.toolPhase;
    }

    const modelCallSeq = normalizeModelCallSeq(activity.modelCallSeq);
    if (modelCallSeq !== null) {
      result.modelCallSeq = modelCallSeq;
    } else {
      delete result.modelCallSeq;
    }

    delete result.shortLabel;
    if (enabled) {
      if (label) {
        const preserveErrorLabelCase =
          activity.isError === true || preserveErrorPhase || intent === "interface.build";
        result.label = sanitizeText(
          preserveErrorLabelCase ? label : lowercaseLeadingWord(label),
          maxLabelChars,
        );
      }
      if (label && shortLabel) {
        const preserveShortLabelCase =
          activity.isError === true || preserveErrorPhase;
        const sanitizedShort = sanitizeText(
          preserveShortLabelCase ? shortLabel : lowercaseLeadingWord(shortLabel),
          SHORT_LABEL_MAX_CHARS,
        );
        if (sanitizedShort && sanitizedShort !== result.label) {
          result.shortLabel = sanitizedShort;
        }
      }
      if (detail) result.detail = sanitizeText(detail, Math.max(maxLabelChars, 200));
      if (category) result.category = sanitizeIdPart(category.toLowerCase()) || "generic";
      if (thinkingSummarySource) result.thinkingSummarySource = thinkingSummarySource;
      if (label && labelSource) {
        result.labelSource = labelSource;
        if (labelFits) {
          result.labelFits = labelFits.map((fit        ) =>
            sanitizeText(lowercaseLeadingWord(fit), maxLabelChars));
        }
        if (toolLabel) {
          result.toolLabel = sanitizeText(lowercaseLeadingWord(toolLabel), maxLabelChars);
        }
      }

      if (chapter) {
        result.chapter = sanitizeText(chapter, maxLabelChars);
        result.toolLabel = sanitizeText(lowercaseLeadingWord(toolLabel || label), maxLabelChars);
      }
      const resultSummary = asString(activity.resultSummary);
      if (resultSummary) {
        result.resultSummary = sanitizeText(resultSummary, Math.max(maxLabelChars, 200));
      }
    }
    if (intent) {
      result.intent = intent;
    } else {
      delete result.intent;
    }

    if (relayHeadlineNote && result.labelSource === "prose" && result.label) {
      headlineNotes.set(result, sanitizeText(relayHeadlineNote, HEADLINE_NOTE_MAX_CHARS));
    }

    return result;
  }

  return {
    augmentActivity,
    headlineNote,
    liveProseHeadlines,
    noteProse,
    reset,
  };
}

module.exports = { createActivityStatusAdapter };
