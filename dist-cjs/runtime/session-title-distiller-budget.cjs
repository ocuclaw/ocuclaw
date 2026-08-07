function createDistillerBudget(opts = {}) {
  const maxErr = Number.isFinite(opts.maxConsecutiveErrors) ? opts.maxConsecutiveErrors : 3;
  const ceiling = Number.isFinite(opts.untitledTurnCeiling) ? opts.untitledTurnCeiling : 25;

  const byKey = new Map();

  function get(k) {
    let s = byKey.get(k);
    if (!s) { s = { consecErr: 0, turns: 0, done: false }; byKey.set(k, s); }
    return s;
  }

  return {
    recordTurn(sessionKey) { get(sessionKey).turns += 1; },
    canRun(sessionKey) {
      const s = get(sessionKey);
      if (s.done) return false;
      if (s.consecErr >= maxErr) return false;
      if (s.turns >= ceiling) return false;
      return true;
    },
    recordOutcome(sessionKey, outcome) {
      const s = get(sessionKey);
      if (outcome === "error") { s.consecErr += 1; return; }
      s.consecErr = 0;
      if (outcome === "applied") s.done = true;
    },
    clear(sessionKey) { byKey.delete(sessionKey); },
  };
}

module.exports = { createDistillerBudget };
