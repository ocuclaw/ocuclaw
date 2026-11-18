const { LIVEUI_BUDGETS } = require("../liveui-registry/operators.cjs");

const BUDGET = LIVEUI_BUDGETS;
const ACCEPT                    = { ok: true };

const utf8Bytes = (text        )         => new TextEncoder().encode(text).length;

function createLiveUiFormulaSet()                   {

  const steps = new Map                ();

  const reads = new Map                           ();
  const stateKeys = new Set        ();
  const timers = new Set        ();

  const totalSteps = ()         => {
    let total = 0;
    for (const n of steps.values()) total += n;
    return total;
  };

  function stepsFit(key        , formula                       )                    {
    const total = totalSteps() - (steps.get(key) ?? 0) + formula.steps;
    if (total > BUDGET.totalSteps) {
      return { ok: false, code: "too_many_nodes", detail: `${total} steps on the surface, budget ${BUDGET.totalSteps}` };
    }
    return ACCEPT;
  }

  function pathTo(target        , from        , seen             )                  {
    if (from === target) return [from];
    if (seen.has(from)) return null;
    seen.add(from);
    for (const next of reads.get(from) ?? []) {
      const rest = pathTo(target, next, seen);
      if (rest) return [from, ...rest];
    }
    return null;
  }

  return {
    admitLet(name, formula) {
      if (!reads.has(name) && reads.size >= BUDGET.derivedNames) {
        return { ok: false, code: "over_cap", detail: `more than ${BUDGET.derivedNames} derived names` };
      }
      const key = `let:${name}`;
      const fit = stepsFit(key, formula);
      if (!fit.ok) return fit;
      const seen = new Set        ();
      for (const next of formula.lets) {
        const loop = pathTo(name, next, seen);
        if (loop) {
          const cycle = [name, ...loop];
          return { ok: false, code: "cycle", detail: `cycle ${cycle.join(" -> ")}`, cycle };
        }
      }
      reads.set(name, [...formula.lets]);
      steps.set(key, formula.steps);
      return ACCEPT;
    },

    admitFormula(key, formula) {
      const slot = `field:${key}`;
      const fit = stepsFit(slot, formula);
      if (!fit.ok) return fit;
      steps.set(slot, formula.steps);
      return ACCEPT;
    },

    admitStateKey(key, initial) {
      if (typeof initial === "string" && utf8Bytes(initial) > BUDGET.stateTextBytes) {
        return { ok: false, code: "over_cap", detail: `state ${key} holds more than ${BUDGET.stateTextBytes} bytes` };
      }
      if (initial !== undefined && initial !== null && typeof initial === "object") {
        return { ok: false, code: "over_cap", detail: `state ${key} must hold a scalar` };
      }
      if (!stateKeys.has(key) && stateKeys.size >= BUDGET.stateKeys) {
        return { ok: false, code: "over_cap", detail: `more than ${BUDGET.stateKeys} state keys` };
      }
      stateKeys.add(key);
      return ACCEPT;
    },

    admitTimer(id) {
      if (!timers.has(id) && timers.size >= BUDGET.timers) {
        return { ok: false, code: "over_cap", detail: `more than ${BUDGET.timers} timers` };
      }
      timers.add(id);
      return ACCEPT;
    },

    totals() {
      return { derivedNames: reads.size, steps: totalSteps(), stateKeys: stateKeys.size, timers: timers.size };
    },
  };
}

module.exports = { createLiveUiFormulaSet };
