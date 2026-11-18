const { isLiveUiPresetFrame, LIVEUI_SURFACE_TYPE } = require("../domain/liveui-v2-client-forms.cjs");

function createLiveuiRenderErrorAuthority({ now = Date.now, maxEntries = 512, ttlMs = 600000 } = {}) {
  const sends = new Map();
  const keyOf = (frame     ) => frame && typeof frame.surfaceId === "string" &&
    frame.surfaceId.length > 0 && frame.surfaceId.length <= 256 &&
    Number.isSafeInteger(frame.seq) && frame.seq > 0
    ? JSON.stringify([frame.surfaceId, frame.seq]) : null;

  function record(frame     , appClientIds     ) {
    const key = keyOf(frame);
    if (!key) return;

    if (frame.type === "glasses_ui_render" || isLiveUiPresetFrame(frame)) {
      for (const [oldKey, entry] of sends) {
        if (entry.surfaceId === frame.surfaceId) sends.delete(oldKey);
      }
    }
    sends.delete(key);
    sends.set(key, {
      surfaceId: frame.surfaceId,
      type: typeof frame.type === "string" ? frame.type : null,
      clientId: appClientIds.length === 1 ? appClientIds[0] : null,
      at: now(),
    });
    while (sends.size > maxEntries) sends.delete(sends.keys().next().value);
  }

  function checkSurface(clientId     , surfaceId     , appClientIds     ) {
    const deny = (reason     ) => ({ eligible: false, reason });
    if (typeof surfaceId !== "string" || !surfaceId || surfaceId.length > 256) return deny("unbound_send");
    let newest      = null;
    for (const entry of sends.values()) {
      if (entry.surfaceId === surfaceId && entry.type === LIVEUI_SURFACE_TYPE) newest = entry;
    }
    if (!newest) return deny("unbound_send");
    if (!newest.clientId) return deny("multiple_send_recipients");
    if (newest.clientId !== clientId) return deny("recipient_mismatch");
    if (appClientIds.length !== 1 || appClientIds[0] !== clientId) return deny("not_sole_app");
    return { eligible: true, reason: null };
  }

  function check(clientId     , frame     , appClientIds     ) {
    const key = keyOf(frame);
    const entry = key && sends.get(key);
    const deny = (reason     ) => ({ eligible: false, reason });
    if (!entry || now() - entry.at > ttlMs) return deny("unbound_send");
    if (frame.clientId !== clientId) return deny("client_id_mismatch");
    if (!entry.clientId) return deny("multiple_send_recipients");
    if (entry.clientId !== clientId) return deny("recipient_mismatch");
    if (appClientIds.length !== 1 || appClientIds[0] !== clientId) return deny("not_sole_app");
    return { eligible: true, reason: null };
  }

  function forgetClient(clientId     ) {
    for (const [key, entry] of sends) {
      if (entry.clientId === clientId) sends.delete(key);
    }
  }

  return { record, check, checkSurface, forgetClient };
}

module.exports = { createLiveuiRenderErrorAuthority };
