const { createHash, randomBytes } = require("node:crypto");
const { cardStarterSource } = require("./card-starters.cjs");
const { taskCaseVerdict, taskHardCases } = require("./program-card-task-cases.cjs");
const { validateLookReport } = require("./program-card-look.cjs");

const CHECK_ID_RE = /^[a-f0-9]{16}$/;

const record = (value     ) => value !== null && typeof value === "object" && !Array.isArray(value);

function starterCheckDigest(source        ) {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 32);
}

function starterCheckStart(starter             , card     , locale         , newId               = () => randomBytes(8).toString("hex")) {
  const keys = starter.inputs.map((input) => input.key);
  const values = record(card?.values) ? card.values : {};
  const left = new Set        ([...(Array.isArray(card?.missing) ? card.missing : []), ...(Array.isArray(card?.unfit) ? card.unfit : [])]);

  const missing = keys.filter((key) => left.has(key) || values[key] === undefined);
  const resultAtMs = Number.isFinite(card?.atMs) ? card.atMs : null;
  if (missing.length) return { pending: null, forPhone: { status: "no_fit", reason: "values", missing, ...(resultAtMs ? { resultAtMs } : {}) } };
  const cases = taskHardCases({ inputs: starter.inputs, values, atMs: resultAtMs ?? Date.now() }) || [];
  const source = cardStarterSource(starter, locale);
  const checkId = newId();
  const seed = { feeds: values, cases };
  return {
    pending: { checkId, starterId: starter.starterId, version: starter.version, digest: starterCheckDigest(source), cases, resultAtMs },
    forPhone: { status: "checking", checkId, source, seed },
  };
}

function starterCheckVerdict(pending     , checkId         , report     ) {
  if (!pending || typeof checkId !== "string" || !CHECK_ID_RE.test(checkId) || checkId !== pending.checkId) return null;
  const checked      = validateLookReport(report, { partial: report?.ok === false });
  if (!checked.ok || checked.report.digest !== pending.digest) return null;
  const verdict      = taskCaseVerdict(pending.cases, checked.report,
    { looks: 1, ...(pending.resultAtMs ? { resultAtMs: pending.resultAtMs } : {}), sourceHash: pending.digest });
  const results = Array.isArray(checked.report.cases) ? checked.report.cases : [];
  const skipped = results.filter((item     ) => item?.skipped !== undefined).map((item     ) => String(item.name ?? "case")).slice(0, 32);
  const fits = verdict.verdict === "fits";
  const fit = {
    status: fits ? "fits" : "no_fit",
    ...(fits ? {} : { reason: verdict.verdict === "blocked" ? "breaks" : verdict.real ? "cases" : "result" }),

    cases: verdict.check.cases, failed: verdict.check.failed, real: verdict.check.real,
    ...(verdict.check.case ? { case: verdict.check.case } : {}),
    skipped,
    ...(pending.resultAtMs ? { resultAtMs: pending.resultAtMs } : {}),
  };
  return { fit, held: { ...fit, starterId: pending.starterId, version: pending.version, digest: pending.digest, line: verdict.line } };
}

module.exports = { starterCheckDigest, starterCheckStart, starterCheckVerdict };
