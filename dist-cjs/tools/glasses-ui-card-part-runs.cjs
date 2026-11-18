const { TASK_SLOT_FIRST, bindingSlot } = require("./glasses-ui-task-slots.cjs");

const CARD_PART_RUN_CODES = Object.freeze({
  slotUnknown: "slot_unknown",
  notBound: "card_not_bound",
  owner: "presentation_owner_changed",
  revision: "presentation_revision_changed",
  notReady: "task_not_ready",
  notBrief: "not_brief",
  running: "already_running",
  agentCap: "agent_refresh_cap",
  dropped: "card_closed",

  checkAgain: "check_again_not_allowed",
});

const CARD_PART_RUNS_QUEUE_MAX = 12;

const C = CARD_PART_RUN_CODES;

function cardHasParts(store     , cardId        )          {
  const declared = typeof store?.cardSlots === "function" ? store.cardSlots(cardId) : null;
  return Array.isArray(declared) && declared.length > 1;
}

function createCardPartRuns(opts      = {}) {
  const feed = opts.feed;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const logger = opts.logger || null;
  const canRun = typeof opts.canRun === "function" ? opts.canRun : () => true;
  const taskKind = typeof opts.taskKind === "function" ? opts.taskKind : () => null;
  const running = typeof opts.running === "function" ? opts.running : async () => false;
  const hasJob = typeof opts.hasJob === "function" ? opts.hasJob : () => false;
  const runJobNow = typeof opts.runJobNow === "function" ? opts.runJobNow : null;
  const busy = typeof opts.busy === "function" ? opts.busy : () => false;
  const launchFeed = typeof opts.launchFeed === "function" ? opts.launchFeed : null;
  const agent = opts.agent || null;
  const clientConnected = typeof opts.clientConnected === "function" ? opts.clientConnected : () => true;
  const send = typeof opts.send === "function" ? opts.send : () => {};
  const jobStarted = typeof opts.jobStarted === "function" ? opts.jobStarted : () => {};
  const jobNotStarted = typeof opts.jobNotStarted === "function" ? opts.jobNotStarted : () => {};
  const defer = typeof opts.defer === "function" ? opts.defer : (fn            ) => setTimeout(fn, 0);

  const checkAgainAllowed = typeof opts.checkAgainAllowed === "function" ? opts.checkAgainAllowed : () => true;

  const queue        = [];

  let launched      = null;

  const answer = (binding     , status        , extra      = {}) =>
    ({ slot: bindingSlot(binding), taskId: binding.taskId, status, ...extra });

  async function refusal(clientId        , binding     , by        )                         {
    if (binding.schemaVersion === 2 && !canRun(clientId, binding)) return C.owner;
    const state = feed.bindingState(binding);
    if (state === "card_changed") return C.revision;
    if (state !== "current") return C.notReady;
    let kind      = null;
    try { kind = taskKind(binding.taskId); } catch (_) { kind = null; }
    if (kind === "reminder" || kind === "alert") return C.notBrief;
    let going = false;
    try { going = await running(binding.taskId); } catch (_) { going = false; }
    if (going) return C.running;
    let ok = false;
    try { ok = by !== "wearer" || checkAgainAllowed(binding.taskId) === true; } catch (_) { ok = false; }
    return ok ? null : C.checkAgain;
  }

  function reserve(binding     , by        ) {
    if (by !== "agent" || !agent) return { ok: true, day: null };
    const taken = agent.take(binding);
    return taken && taken.ok ? { ok: true, day: typeof taken.day === "string" ? taken.day : null } : { ok: false, day: null };
  }

  function giveBack(binding     , day     ) {
    if (!day || !agent) return;
    try { agent.giveBack(binding, day); } catch (_) {  }
  }

  function late(entry     , status        , code         ) {
    const part = { slot: entry.slot, taskId: entry.taskId, status, ...(code ? { code } : {}) };
    defer(() => {
      try {
        send(entry.clientId, { cardId: entry.cardId, taskId: entry.taskId, slot: entry.slot, status, ...(code ? { code } : {}), slots: [part] });
      } catch (_) {  }
    });
  }

  function finish(entry     , result     ) {
    try { entry.resolve(result); } catch (_) {  }
  }

  function drop(entry     , code        , answerPhone = true) {
    giveBack(entry.binding, entry.day);
    if (answerPhone) late(entry, "rejected", code);
    finish(entry, { status: "rejected", code, dropped: true });
    logger?.info?.(`[program-card] part run dropped card=${entry.cardId} slot=${entry.slot} task=${entry.taskId} code=${code}`);
  }

  function stillBound(entry     ) {
    const kept = feed.store.read(entry.taskId);
    return kept && kept.cardId === entry.cardId && bindingSlot(kept) === entry.slot && kept.bindingDigest === entry.binding.bindingDigest
      ? kept : null;
  }

  function pump() {
    if (launched || !launchFeed || busy()) return;
    while (queue.length) {
      const entry = queue.shift();
      if (!clientConnected(entry.clientId)) { drop(entry, C.dropped, false); continue; }
      const binding = stillBound(entry);
      if (!binding) { drop(entry, C.notBound); continue; }
      if (feed.bindingState(binding) !== "current") { drop(entry, feed.bindingState(binding) === "card_changed" ? C.revision : C.notReady); continue; }
      launched = entry;

      if (entry.queued) late(entry, "accepted");
      Promise.resolve(launchFeed({ clientId: entry.clientId, cardId: entry.cardId, slot: entry.slot, by: entry.by }))
        .then((result     ) => {
          if (result && result.status === "accepted") { finish(entry, result); return; }
          const code = result && typeof result.code === "string" ? result.code : "launch_failed";
          if (launched === entry) launched = null;

          if (code === "task_run_busy" && queue.length < CARD_PART_RUNS_QUEUE_MAX) {
            entry.queued = true;
            queue.unshift(entry);
            return;
          }
          drop(entry, code);
          defer(pump);
        }, () => {
          if (launched === entry) launched = null;
          drop(entry, "launch_failed");
          defer(pump);
        });
      return;
    }
  }

  function take(match                         ) {
    const taken = queue.filter(match);
    for (const entry of taken) queue.splice(queue.indexOf(entry), 1);
    return taken;
  }

  function enqueue(clientId        , cardId        , binding     , by        , day     ) {
    let resolve      = null;
    const promise = new Promise((done) => { resolve = done; });
    const entry = { clientId, cardId, slot: bindingSlot(binding), taskId: binding.taskId, binding, by, day, resolve,
      queued: false, atMs: now() };
    if (queue.length >= CARD_PART_RUNS_QUEUE_MAX) {
      giveBack(binding, day);
      return { promise: Promise.resolve({ status: "rejected", code: "task_run_busy" }), entry: null, code: "task_run_busy" };
    }

    if (queue.some((other) => other.clientId === clientId && other.cardId === cardId && other.slot === entry.slot) ||
        launched?.clientId === clientId && launched?.cardId === cardId && launched?.slot === entry.slot) {
      giveBack(binding, day);
      return { promise: Promise.resolve({ status: "rejected", code: C.running }), entry: null, code: C.running };
    }
    entry.queued = !!launched || busy() || queue.length > 0;
    queue.push(entry);
    pump();
    return { promise, entry, code: null };
  }

  async function start(clientId        , cardId        , binding     , by        ) {
    const taken = reserve(binding, by);
    if (!taken.ok) return answer(binding, "rejected", { code: C.agentCap });
    const taskId = binding.taskId;
    if (runJobNow && hasJob(taskId)) {
      const atMs = now();
      jobStarted(taskId, atMs, by);
      let result      = null;
      try { result = await runJobNow(taskId); } catch (_) { result = null; }
      if (result && result.status === "accepted" && result.state !== "job_missing") {
        logger?.info?.(`[program-card] part run started card=${cardId} slot=${bindingSlot(binding)} task=${taskId} via=job by=${by}`);
        return answer(binding, "accepted", { via: "job" });
      }
      jobNotStarted(taskId, atMs);

      if (result?.code === "task_schedule_already_running") {
        giveBack(binding, taken.day);
        return answer(binding, "rejected", { code: C.running });
      }

      let going = false;
      try { going = await running(taskId); } catch (_) { going = false; }
      if (going) {
        giveBack(binding, taken.day);
        return answer(binding, "rejected", { code: C.running });
      }
    }
    if (!launchFeed) {
      giveBack(binding, taken.day);
      return answer(binding, "rejected", { code: "executor_unavailable" });
    }
    const queued = enqueue(clientId, cardId, binding, by, taken.day);
    if (queued.code || !queued.entry) return answer(binding, "rejected", { code: queued.code || "task_run_busy" });
    const waits = queued.entry.queued;
    logger?.info?.(`[program-card] part run ${waits ? "queued" : "started"} card=${cardId} ` +
      `slot=${bindingSlot(binding)} task=${taskId} via=feed by=${by}`);
    return answer(binding, "accepted", { via: "feed", ...(waits ? { queued: true } : {}) });
  }

  return {

    async refresh({ clientId, cardId, slot, by = "wearer" }     ) {
      const store = feed.store;
      const declared = (store.cardSlots(cardId) || [{ name: TASK_SLOT_FIRST }]).map((entry     ) => entry.name);
      const bound = store.forCard(cardId).filter((binding     ) => binding.schemaVersion === 2);
      let targets       ;
      if (typeof slot === "string") {
        if (!declared.includes(slot)) return { cardId, slot, status: "rejected", code: C.slotUnknown,
          slots: [{ slot, taskId: null, status: "rejected", code: C.slotUnknown }] };
        const one = bound.find((binding     ) => bindingSlot(binding) === slot);
        if (!one) return { cardId, slot, status: "rejected", code: C.notBound,
          slots: [{ slot, taskId: null, status: "rejected", code: C.notBound }] };
        targets = [one];
      } else targets = bound;
      if (!targets.length) return { cardId, status: "rejected", code: C.notBound, slots: [] };
      const slots        = [];

      for (const binding of targets) {
        const why = await refusal(clientId, binding, by);
        slots.push(why ? answer(binding, "rejected", { code: why }) : await start(clientId, cardId, binding, by));
      }
      const first = slots.find((part) => part.status === "accepted") || slots[0];
      return {
        cardId,
        taskId: first.taskId,
        ...(typeof slot === "string" ? { slot } : {}),
        status: first.status,
        ...(first.status !== "accepted" && first.code ? { code: first.code } : {}),
        slots: slots.map(({ via, queued, ...part }     ) => part),
      };
    },

    launchOpenRun({ clientId, cardId, slot }     ) {
      const binding = feed.store.forCard(cardId).find((entry     ) => entry.schemaVersion === 2 && bindingSlot(entry) === slot);
      if (!binding) return Promise.resolve({ status: "rejected", code: C.notBound });
      return enqueue(clientId, cardId, binding, "open", null).promise;
    },

    onRunEnded(run     ) {
      if (launched && run && run.taskId === launched.taskId) launched = null;
      defer(pump);
    },

    closed({ clientId, cardId }     ) {
      for (const entry of take((entry) => entry.clientId === clientId && (cardId === undefined || entry.cardId === cardId)))
        drop(entry, C.dropped, false);
    },

    dropCard(cardId        ) {
      for (const entry of take((entry) => entry.cardId === cardId)) drop(entry, C.notBound);
    },

    waiting() {
      return queue.map((entry) => ({ clientId: entry.clientId, cardId: entry.cardId, slot: entry.slot, taskId: entry.taskId, by: entry.by }));
    },
  };
}

module.exports = { CARD_PART_RUN_CODES, CARD_PART_RUNS_QUEUE_MAX, cardHasParts, createCardPartRuns };
