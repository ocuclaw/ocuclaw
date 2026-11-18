const AUX_TASKS = ["ocuclaw_approval_explain", "ocuclaw_liveui_refresh", "silent_input_prediction", "ocuclaw_card_review"];
const count = (v     ) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const route = (v     ) => typeof v === "string" && /^[A-Za-z0-9_.:/@+ ·-]{1,330}$/.test(v);
const name = (v     ) => typeof v === "string" && /^[A-Za-z0-9_.:/@+-]{1,160}$/.test(v);

function hermesAuxCallDebugData(params     ) {
  const data      = {};
  if (AUX_TASKS.includes(params?.task)) data.task = params.task;
  if (typeof params?.requestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(params.requestId)) data.requestId = params.requestId;
  for (const key of ["provider", "model"]) if (name(params?.[key])) data[key] = params[key];
  for (const key of ["attempt", "ms", "input", "output"]) if (count(params?.[key])) data[key] = params[key];
  if (typeof params?.failed === "boolean") data.failed = params.failed;
  return data;
}

function hermesAuxUsageTasks(raw     )                    {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("Invalid usage tasks");
  const rows        = [];
  for (const r of raw.slice(0, 16)) {
    if (!r || typeof r !== "object" || !AUX_TASKS.includes(r.task) || rows.some(row => row.task === r.task)) continue;
    const keys = ["calls", "attempts", "failedAttempts", "fallbacks", "input", "output"];
    if (!keys.every(key => count(r[key]))) continue;
    if (r.failedAttempts > r.attempts || r.fallbacks > r.calls || r.calls > r.attempts) continue;
    if (r.typicalMs !== null && !count(r.typicalMs)) continue;
    const row      = { task: r.task };
    for (const key of keys) row[key] = r[key];
    row.typicalMs = r.typicalMs;
    row.route = route(r.route) ? r.route : "auto";
    rows.push(row);
  }
  return rows;
}

module.exports = { AUX_TASKS, hermesAuxCallDebugData, hermesAuxUsageTasks };
