function createLiveuiRenderErrorAuthority({ now = Date.now, maxEntries = 512, ttlMs = 600000 } = {}) {
  const sends = new Map();
  const keyOf = (frame) => frame && typeof frame.surfaceId === "string" &&
    frame.surfaceId.length > 0 && frame.surfaceId.length <= 256 &&
    Number.isSafeInteger(frame.seq) && frame.seq > 0
    ? JSON.stringify([frame.surfaceId, frame.seq]) : null;

  function record(frame, appClientIds) {
    const key = keyOf(frame);
    if (!key) return;

    if (frame.type === "glasses_ui_render") {
      for (const [oldKey, entry] of sends) {
        if (entry.surfaceId === frame.surfaceId) sends.delete(oldKey);
      }
    }
    sends.delete(key);
    sends.set(key, {
      surfaceId: frame.surfaceId,
      clientId: appClientIds.length === 1 ? appClientIds[0] : null,
      at: now(),
    });
    while (sends.size > maxEntries) sends.delete(sends.keys().next().value);
  }

  function check(clientId, frame, appClientIds) {
    const key = keyOf(frame);
    const entry = key && sends.get(key);
    const deny = (reason) => ({ eligible: false, reason });
    if (!entry || now() - entry.at > ttlMs) return deny("unbound_send");
    if (frame.clientId !== clientId) return deny("client_id_mismatch");
    if (!entry.clientId) return deny("multiple_send_recipients");
    if (entry.clientId !== clientId) return deny("recipient_mismatch");
    if (appClientIds.length !== 1 || appClientIds[0] !== clientId) return deny("not_sole_app");
    return { eligible: true, reason: null };
  }

  function forgetClient(clientId) {
    for (const [key, entry] of sends) {
      if (entry.clientId === clientId) sends.delete(key);
    }
  }

  return { record, check, forgetClient };
}

module.exports = { createLiveuiRenderErrorAuthority };
