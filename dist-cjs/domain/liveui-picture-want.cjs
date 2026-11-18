const PIC_ID_RE = /^p[0-9]{1,4}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const WANT_LIST_MAX = 64;

function list(value         , re        )           {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item)                 => typeof item === "string" && re.test(item)))].slice(
    0,
    WANT_LIST_MAX,
  );
}

function admitLiveUiPictureWant(
  msg         ,
  surfaceSessionOf                                      ,
  clientSessionKey         ,
  sameSession                                            ,
)                           {
  const raw      = msg && typeof msg === "object" ? msg : {};
  const surfaceId = typeof raw.surfaceId === "string" ? raw.surfaceId : "";
  const ids = list(raw.ids, PIC_ID_RE);
  const surfaceSession = surfaceId ? surfaceSessionOf(surfaceId) : null;
  if (!surfaceSession) return { ok: false, reason: "unknown_surface", surfaceId, ids: ids.length };
  if (!sameSession(surfaceSession, clientSessionKey)) {
    return { ok: false, reason: "other_session", surfaceId, ids: ids.length };
  }
  if (ids.length === 0) return { ok: false, reason: "no_ids", surfaceId, ids: 0 };
  const have = list(raw.have, HASH_RE);
  if (raw.large === true) return { ok: true, sessionKey: surfaceSession, want: { surfaceId, ids: ids.slice(0, 1), have, large: true } };
  return { ok: true, sessionKey: surfaceSession, want: { surfaceId, ids, have } };
}

function admitLiveUiVideoWant(
  msg         ,
  surfaceSessionOf                                      ,
  clientSessionKey         ,
  sameSession                                            ,
)                         {
  const raw      = msg && typeof msg === "object" ? msg : {};
  const surfaceId = typeof raw.surfaceId === "string" ? raw.surfaceId : "";
  const surfaceSession = surfaceId ? surfaceSessionOf(surfaceId) : null;
  if (!surfaceSession) return { ok: false, reason: "unknown_surface", surfaceId };
  if (!sameSession(surfaceSession, clientSessionKey)) return { ok: false, reason: "other_session", surfaceId };
  const id = typeof raw.id === "string" && PIC_ID_RE.test(raw.id) ? raw.id : "";
  if (!id) return { ok: false, reason: "bad_id", surfaceId };
  const n = Number.isInteger(raw.n) && raw.n >= 0 ? raw.n : 0;
  const t = typeof raw.t === "number" && Number.isFinite(raw.t) && raw.t >= 0 ? Math.min(raw.t, 86400) : 0;
  return { ok: true, sessionKey: surfaceSession, want: { surfaceId, id, n, t, ...(raw.seek === true ? { seek: true          } : {}) } };
}

module.exports = { admitLiveUiPictureWant, admitLiveUiVideoWant };
