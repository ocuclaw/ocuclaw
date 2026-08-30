const { SETTLEMENT_OUTCOME_RESULTS, TERMINAL_OUTCOME_RESULTS, SURFACE_REAP_REASONS } = require("./glasses-ui-surfaces.cjs");

const DELIVERY_RUNGS = Object.freeze({
  AUTHORED: "authored",
  VALIDATED: "validated",
  SEND_ATTEMPTED: "send_attempted",
  CLIENT_RECEIPT: "client_receipt",
  WEARER_INTERACTED: "wearer_interacted",
});

const DELIVERY_RUNG_ORDER = Object.freeze([
  DELIVERY_RUNGS.AUTHORED,
  DELIVERY_RUNGS.VALIDATED,
  DELIVERY_RUNGS.SEND_ATTEMPTED,
  DELIVERY_RUNGS.CLIENT_RECEIPT,
  DELIVERY_RUNGS.WEARER_INTERACTED,
]);

const DELIVERY_EVIDENCE_KEYS = Object.freeze({
  authored: "authoredAtMs",
  validated: "validatedAtMs",
  send_attempted: "sendAttemptedAtMs",
  client_receipt: "clientReceiptAtMs",
  wearer_interacted: "wearerInteractedAtMs",
});

const SEND_ATTEMPT_SIGNALS = Object.freeze([
  "queued",
  "coalesced",
  "shed_backpressure",
  "transport_accepted",
]);

const REVIEW_RUNG_MAP = Object.freeze({
  attempted: DELIVERY_RUNGS.SEND_ATTEMPTED,
  "transport-accepted": DELIVERY_RUNGS.SEND_ATTEMPTED,
  painted: DELIVERY_RUNGS.CLIENT_RECEIPT,
  perceived: null,
});

const DELIVERY_RUNG_PHRASING = Object.freeze({
  authored: "authored, not yet validated",
  validated: "validated, not yet sent",
  send_attempted: "attempted, unconfirmed",
  client_receipt: "painted per client receipt, not confirmed perceived",
  wearer_interacted: "wearer interacted",
});

const FORBIDDEN_CLAIM_TERMS = Object.freeze([
  "perceived",
  "seen",
  "saw",
  "viewed",
  "displayed",
  "noticed",
  "witnessed",
  "observed",
]);

const FORBIDDEN_CLAIM_RATIONALE = Object.freeze({
  perceived:
    "no receipt proves perception; the only evidence a human perceived a surface is a gesture — use \"wearer_interacted\"",
  seen: "\"seen\" claims a mental event; use \"client_receipt\" (mechanically: lastPaintedAt) or \"wearer_interacted\"",
  saw: "\"saw\" claims a mental event; use \"wearer_interacted\" if a gesture proves it, otherwise \"send_attempted\"",
  viewed: "\"viewed\" claims a mental event; use \"client_receipt\" for the receipt fact",
  displayed:
    "\"displayed\" over-claims a receipt — the client reported PAINTING a frame, not that it stayed on the HUD; use \"client_receipt\" / lastPaintedAt",
  noticed: "\"noticed\" claims attention, which nothing in the stack measures; use \"wearer_interacted\"",
  witnessed: "\"witnessed\" claims a mental event; use \"wearer_interacted\"",
  observed: "\"observed\" claims a mental event; use \"client_receipt\" or \"wearer_interacted\"",
});

function wordTokens(value) {
  if (typeof value !== "string") return [];
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isDeliveryRung(value) {
  return DELIVERY_RUNG_ORDER.indexOf(value) !== -1;
}

function rungIndex(value) {
  return DELIVERY_RUNG_ORDER.indexOf(value);
}

function findForbiddenClaimTerm(value) {
  const tokens = wordTokens(value);
  for (const token of tokens) {
    if (FORBIDDEN_CLAIM_TERMS.indexOf(token) !== -1) return token;
  }
  return null;
}

function assertDeliveryRung(value, context) {
  const where = context ? ` (${context})` : "";
  const forbidden = findForbiddenClaimTerm(value);
  if (forbidden) {
    throw new Error(
      `LiveUI delivery ladder: "${value}" is not a representable claim${where} — ` +
        `${FORBIDDEN_CLAIM_RATIONALE[forbidden]}. Rungs: ${DELIVERY_RUNG_ORDER.join(" -> ")}.`,
    );
  }
  if (!isDeliveryRung(value)) {
    throw new Error(

      `LiveUI delivery ladder — unknown rung ${JSON.stringify(value)}${where}. ` +
        `Rungs: ${DELIVERY_RUNG_ORDER.join(" -> ")}.`,
    );
  }
  return value;
}

function assertHonestFieldName(name, context) {
  const forbidden = findForbiddenClaimTerm(name);
  if (forbidden) {
    const where = context ? ` (${context})` : "";
    throw new Error(
      `LiveUI delivery ladder: field name ${JSON.stringify(name)} claims perception${where} — ` +
        `${FORBIDDEN_CLAIM_RATIONALE[forbidden]}. Name receipt-derived fields after the ` +
        `mechanism (lastPaintedAt-style), never after the meaning.`,
    );
  }
  return name;
}

function compareRungs(a, b) {
  const ia = rungIndex(assertDeliveryRung(a, "compareRungs"));
  const ib = rungIndex(assertDeliveryRung(b, "compareRungs"));
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function resolveReviewRung(name) {
  if (!Object.prototype.hasOwnProperty.call(REVIEW_RUNG_MAP, name)) {
    throw new Error(
      `LiveUI delivery ladder: ${JSON.stringify(name)} is not a swift-bengio review rung. ` +
        `Known: ${Object.keys(REVIEW_RUNG_MAP).join(", ")}.`,
    );
  }
  const mapped = REVIEW_RUNG_MAP[name];
  if (mapped === null) return assertDeliveryRung(name, "resolveReviewRung");
  return mapped;
}

const VALIDATION_TERMINATION_CAUSE = "render_rejected";

const TERMINATION_CAUSES = Object.freeze([
  ...SETTLEMENT_OUTCOME_RESULTS,
  ...TERMINAL_OUTCOME_RESULTS,
  ...SURFACE_REAP_REASONS,
  VALIDATION_TERMINATION_CAUSE,
]);

const TERMINATION_CAUSE_SOURCES = Object.freeze({
  ...Object.fromEntries(SETTLEMENT_OUTCOME_RESULTS.map((cause) => [cause, "settlement_outcome"])),
  ...TERMINAL_OUTCOME_RESULTS.reduce((acc, cause) => {
    acc[cause] = "terminal_outcome";
    return acc;
  }, {}),
  ...SURFACE_REAP_REASONS.reduce((acc, cause) => {
    acc[cause] = "surface_reap";
    return acc;
  }, {}),
  [VALIDATION_TERMINATION_CAUSE]: "render_rejected",
});

function isTerminationCause(value) {
  return TERMINATION_CAUSES.indexOf(value) !== -1;
}

function assertTerminationCause(value, context) {
  if (!isTerminationCause(value)) {
    const where = context ? ` (${context})` : "";
    throw new Error(

      `LiveUI delivery ladder — unknown terminationCause ${JSON.stringify(value)}${where}. ` +
        `Known causes: ${TERMINATION_CAUSES.join(", ")}. Do not coin a new one — ` +
        `extend SETTLEMENT_OUTCOME_RESULTS, TERMINAL_OUTCOME_RESULTS, or SURFACE_REAP_REASONS in glasses-ui-surfaces.ts.`,
    );
  }
  return value;
}

function terminationCauseForOutcome(outcome) {
  if (!outcome || typeof outcome !== "object") return null;
  const result = outcome.result;
  return SETTLEMENT_OUTCOME_RESULTS.indexOf(result) !== -1 || TERMINAL_OUTCOME_RESULTS.indexOf(result) !== -1
    ? result
    : null;
}

function terminationCauseForReapReason(reason) {
  return SURFACE_REAP_REASONS.indexOf(reason) !== -1 ? reason : null;
}

function earnsWearerInteracted(event) {
  if (!event || typeof event !== "object") return false;
  const origin = typeof event.origin === "string" ? event.origin : "gesture";
  const actor = typeof event.actor === "string" ? event.actor : "wearer";
  return origin === "gesture" && actor === "wearer";
}

function hasEvidence(evidence, rung) {
  const value = evidence[DELIVERY_EVIDENCE_KEYS[rung]];
  if (value === true) return true;
  return typeof value === "number" && Number.isFinite(value);
}

function deliveryLadderState(evidence) {
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const earned = [];
  const missing = [];
  const skipped = [];
  let broken = false;
  for (const rung of DELIVERY_RUNG_ORDER) {
    const present = hasEvidence(ev, rung);
    if (broken) {
      if (present) skipped.push(rung);
      missing.push(rung);
      continue;
    }
    if (present) {
      earned.push(rung);
    } else {
      broken = true;
      missing.push(rung);
    }
  }
  const rung = earned.length ? earned[earned.length - 1] : null;
  return Object.freeze({
    rung,
    index: rung ? rungIndex(rung) : -1,
    earned: Object.freeze(earned),
    missing: Object.freeze(missing),
    skipped: Object.freeze(skipped),
    phrase: rung ? DELIVERY_RUNG_PHRASING[rung] : "nothing authored",
  });
}

function highestHonestRung(evidence) {
  return deliveryLadderState(evidence).rung;
}

function assertLadderConsistent(evidence, context) {
  const state = deliveryLadderState(evidence);
  if (state.skipped.length) {
    const where = context ? ` (${context})` : "";
    throw new Error(
      `LiveUI delivery ladder: evidence skips rungs${where} — ` +
        `${state.skipped.join(", ")} present but ${state.missing[0]} is not earned. ` +
        `A rung is earned only when every rung beneath it is.`,
    );
  }
  return state;
}

function describeDelivery(params) {
  const p = params && typeof params === "object" ? params : {};
  const state = deliveryLadderState(p.evidence);
  const cause = p.terminationCause == null ? null : assertTerminationCause(p.terminationCause, "describeDelivery");
  return Object.freeze({
    rung: state.rung,
    phrase: state.phrase,
    earned: state.earned,
    missing: state.missing,
    skipped: state.skipped,
    terminated: cause !== null,
    terminationCause: cause,
    terminationSource: cause ? TERMINATION_CAUSE_SOURCES[cause] : null,
  });
}

module.exports = { DELIVERY_RUNGS, DELIVERY_RUNG_ORDER, DELIVERY_EVIDENCE_KEYS, DELIVERY_RUNG_PHRASING, SEND_ATTEMPT_SIGNALS, REVIEW_RUNG_MAP, FORBIDDEN_CLAIM_TERMS, FORBIDDEN_CLAIM_RATIONALE, SETTLEMENT_OUTCOME_RESULTS, TERMINAL_OUTCOME_RESULTS, SURFACE_REAP_REASONS, VALIDATION_TERMINATION_CAUSE, TERMINATION_CAUSES, TERMINATION_CAUSE_SOURCES, isDeliveryRung, rungIndex, compareRungs, findForbiddenClaimTerm, assertDeliveryRung, assertHonestFieldName, resolveReviewRung, isTerminationCause, assertTerminationCause, terminationCauseForOutcome, terminationCauseForReapReason, earnsWearerInteracted, deliveryLadderState, highestHonestRung, assertLadderConsistent, describeDelivery };
