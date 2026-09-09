const MAX_COUNT = 2_147_483_647;
const COUNT_KEYS = ["maxEntries", "maxEstimatedBytes", "hotMaxBytes", "relayMaxBytes", "otherMaxBytes", "foldMaxBytes", "foldMaxLines", "ramHandedToTransport", "skippedShipped", "healthThrottled", "partOmitted", "partMaxBytes"];
const RANGE_KEYS = ["ramGroup", "ramGlobal", "foldOmitted"];
const count = (v     ) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_COUNT;

function parseClientRetention(json     )      {
  if (typeof json !== "string" || json.length > 4096 || new TextEncoder().encode(json).length > 4096) return null;
  let raw;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || raw.version !== 1 || raw.scope !== "ring_lifetime" ||
      typeof raw.epoch !== "string" || !/^-?[a-f0-9]{1,16}$/.test(raw.epoch)) return null;
  const out      = { version: 1, scope: "ring_lifetime", epoch: raw.epoch, countsSaturateAt: MAX_COUNT, detailPolicy: "whole_rows" };
  if (["whole_rows", "bounded_timeline", "lite_redacted"].includes(raw.detailPolicy)) out.detailPolicy = raw.detailPolicy;
  if (count(raw.timelineMaxBytes)) out.timelineMaxBytes = raw.timelineMaxBytes;
  if (typeof raw.captureEnabled === "boolean") out.captureEnabled = raw.captureEnabled;
  for (const key of COUNT_KEYS) {
    if (!count(raw[key])) return null;
    out[key] = raw[key];
  }
  for (const key of RANGE_KEYS) {
    const r = raw[key];
    if (!r || !count(r.count) || !count(r.unknownTime) || r.unknownTime > r.count) return null;
    const hasTime = r.fromMs !== null || r.toMs !== null;
    if (hasTime && (!Number.isFinite(r.fromMs) || !Number.isFinite(r.toMs) || r.fromMs < 0 || r.toMs < r.fromMs)) return null;
    if (!hasTime && r.unknownTime !== r.count) return null;
    out[key] = { count: r.count, fromMs: r.fromMs, toMs: r.toMs, unknownTime: r.unknownTime };
  }
  return out;
}

function retentionForWindow(retention     , correctionMs        , fromMs        , toMs        )      {
  if (!retention) return null;
  const ranges = [retention.ramGroup, retention.ramGlobal];
  let ramWindow = "none";
  for (const range of ranges) {
    if (!range.count) continue;
    const first = range.fromMs === null ? null : range.fromMs + correctionMs;
    const last = range.toMs === null ? null : range.toMs + correctionMs;
    const inside = (v     ) => v !== null && v >= fromMs && v <= toMs;
    const status = inside(first) || inside(last) ? "within"
      : range.unknownTime || first === null || last === null || (first < fromMs && last > toMs) ? "unknown"
      : "outside";
    if (status === "within" || (ramWindow !== "within" && (status === "unknown" || ramWindow === "none"))) ramWindow = status;
  }
  return { ...retention, ramWindow, windowFromMs: fromMs, windowToMs: toMs,
    timeBasis: "phone_clock_corrected", foldLossScope: "capture_snapshot", deliveryMeaning: "handed_to_transport_not_acknowledged" };
}

function countLanes(events       )      {
  const counts = { phone: 0, relay: 0 };
  for (const event of events) counts[event.source === "phone" ? "phone" : "relay"] += 1;
  return counts;
}

module.exports = { parseClientRetention, retentionForWindow, countLanes };
