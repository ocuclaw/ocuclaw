const SESSIONS_GONE_COALESCE_MS = 250;

function createSessionsGoneHandler(opts     ) {
  const coalesceMs = Number.isFinite(opts.coalesceMs)
    ? opts.coalesceMs
    : SESSIONS_GONE_COALESCE_MS;
  const setTimer = typeof opts.setTimer === "function" ? opts.setTimer : setTimeout;
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const logger = opts.logger || console;
  let pending = emptyBatch();
  let timer      = null;

  let flushing                = Promise.resolve();

  function emptyBatch() {
    return { deleted: new Set(), archived: new Set(), unmappedDelete: false, frames: 0 };
  }

  function observe(frame     ) {
    if (!frame || typeof frame !== "object") return false;

    if (frame.origin === "ocuclaw") return false;
    const archive = frame.reason === "archive";
    const keys = Array.isArray(frame.sessionKeys)
      ? frame.sessionKeys.filter((key     ) => typeof key === "string" && key)
      : [];
    for (const key of keys) (archive ? pending.archived : pending.deleted).add(key);
    if (!archive && Number(frame.unmappedIds) > 0) pending.unmappedDelete = true;
    pending.frames += 1;
    if (timer === null) {
      timer = setTimer(() => {
        timer = null;
        flushing = flushing.then(safeFlush);
      }, coalesceMs);
    }
    return true;
  }

  async function safeFlush() {
    try {
      await flush();
    } catch (err     ) {
      logger.warn(
        `[relay] sessionsGone refresh failed: ${err && err.message ? err.message : err}`,
      );
    }
  }

  async function flush() {
    const batch = pending;
    pending = emptyBatch();
    if (batch.frames === 0) return;
    opts.invalidateSessionsCache();
    const current = opts.getCurrentSessionKey();
    const candidates = new Set(batch.deleted);

    if (batch.unmappedDelete && current && !opts.isDraftSession(current)) {
      candidates.add(current);
    }
    const gone = [];
    for (const key of candidates) {

      if ((await opts.sessionStillExists(key)) === false) gone.push(key);
    }
    if (gone.length > 0) opts.forgetSessions(gone);
    emitDebug("sessions_gone", "info", {
      frames: batch.frames,
      deleted: batch.deleted.size,
      archived: batch.archived.size,
      unmapped: batch.unmappedDelete,
      gone: gone.length,
    });

    if (current && gone.includes(current) && opts.getCurrentSessionKey() === current) {
      try {
        await opts.replaceCurrentSession(current);
      } catch (err     ) {
        logger.warn(
          `[relay] new chat after the open chat was deleted failed: ${err && err.message ? err.message : err}`,
        );
      }
    }
    await opts.broadcastSessions([...batch.deleted, ...batch.archived]);
  }

  function whenIdle() {
    return flushing;
  }

  return { observe, whenIdle };
}

module.exports = { SESSIONS_GONE_COALESCE_MS, createSessionsGoneHandler };
