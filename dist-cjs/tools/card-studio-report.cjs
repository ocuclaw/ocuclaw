const { buildCardStudioSnapshot, createCodeSecretPass } = require("../domain/card-studio-snapshot.cjs");
const { redactHostText } = require("../domain/task-run-facts.cjs");

const LINK_TASK_OUTPUT_SNAPSHOT_METHOD = "taskOutput.snapshot";
const TASK_OUTPUT_CONTRACT = "ocuclaw.task-output-snapshot";
const TASK_OUTPUT_CONTRACT_VERSION = 1;

const TASK_OUTPUT_WAIT_MS = 3000;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function attempt   (fn         , fallback   )    {
  try { return fn(); } catch { return fallback; }
}

function readTaskOutputDocument(doc     ) {
  const out = new Map             ();
  if (!isRecord(doc) || doc.contract !== TASK_OUTPUT_CONTRACT || doc.contractVersion !== TASK_OUTPUT_CONTRACT_VERSION || !Array.isArray(doc.jobs)) {
    return out;
  }
  for (const job of doc.jobs.slice(0, 16)) {
    if (!isRecord(job) || typeof job.jobId !== "string" || !JOB_ID.test(job.jobId)) continue;
    const raw = isRecord(job.result) ? job.result : null;
    const result = raw && (raw.status === "ok" || raw.status === "failed") ? {
      status: raw.status,
      headline: typeof raw.headline === "string" ? raw.headline : null,

      body: typeof raw.body === "string" ? redactHostText(raw.body) : null,
      values: raw.card === undefined ? null : raw.card,
      createdAtMs: Number.isSafeInteger(raw.createdAtMs) ? raw.createdAtMs : null,
      truncated: raw.truncated === true,
    } : null;
    const cron = isRecord(job.cronLog) && typeof job.cronLog.text === "string" && result && result.status === "failed"
      ? { text: redactHostText(job.cronLog.text), atMs: Number.isSafeInteger(job.cronLog.atMs) ? job.cronLog.atMs : null }
      : null;
    out.set(job.jobId, { result, cronLog: cron });
  }
  return out;
}

function withTimeout   (promise            , ms        , fallback   )             {
  let timer      = null;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise   ((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function createCardStudioReport(deps      = {}) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const waitMs = Number.isFinite(deps.waitMs) && deps.waitMs > 0 ? deps.waitMs : TASK_OUTPUT_WAIT_MS;

  function cardOf(touched     , onScreen     ) {
    const card      = { cardKey: touched.id, name: touched.name, why: touched.why, atMs: touched.atMs,
      onScreen: !!onScreen && onScreen.id === touched.id, revisions: [], codes: [], currentRevision: null };
    const appId = touched.id.startsWith("app:") ? touched.id.slice(4) : null;
    let currentSource                = null;
    if (appId) {
      const saved = attempt(() => (typeof deps.readCard === "function" ? deps.readCard(appId) : null), null);
      const list = attempt(() => (typeof deps.revisions === "function" ? deps.revisions(appId) : []), []) || [];
      card.revisions = list.map((r     ) => ({ number: r.number, by: r.by, note: r.note, savedAtMs: r.savedAtMs, digest: r.digest }));
      if (saved) {
        card.name = card.name || saved.name || null;
        card.currentRevision = Number.isSafeInteger(saved.revision) ? saved.revision : null;
        currentSource = typeof saved.source === "string" ? saved.source : null;
        if (currentSource) card.codes.push({ which: "current", revision: card.currentRevision, code: currentSource });
        card.state = saved.state;
        const previous = list.filter((r     ) => Number.isSafeInteger(r.number) && r.number < (card.currentRevision ?? Infinity))
          .sort((a     , b     ) => b.number - a.number)[0];
        const previousSource = previous && previous.card && typeof previous.card.source === "string" ? previous.card.source : null;
        if (previousSource) card.codes.push({ which: "previous", revision: previous.number, code: previousSource });
      }
      card.review = attempt(() => (typeof deps.readReview === "function" ? deps.readReview(appId) : null), null);
    }
    if (card.onScreen) {

      if (onScreen.state !== null && onScreen.state !== undefined) card.state = onScreen.state;
      card.lastError = onScreen.lastError || null;
      card.unsaved = onScreen.unsaved || 0;
      const draft = typeof onScreen.source === "string" && onScreen.source && onScreen.source !== currentSource ? onScreen.source : null;
      if (draft) card.codes.push({ which: currentSource ? "draft" : "current", revision: currentSource ? null : onScreen.savedRevision, code: draft });
    }
    return card;
  }

  async function tasksOf(touchedTasks       ) {
    if (!touchedTasks.length) return [];
    const rows        = await withTimeout(Promise.resolve(typeof deps.taskRows === "function" ? deps.taskRows() : []), waitMs, []);
    const byTask = new Map             ();
    for (const row of Array.isArray(rows) ? rows : []) if (isRecord(row) && typeof row.taskId === "string") byTask.set(row.taskId, row);
    const jobIds = touchedTasks.map((t) => byTask.get(t.id)?.jobId).filter((id) => typeof id === "string" && JOB_ID.test(id));
    let output = new Map             ();
    if (jobIds.length && typeof deps.taskOutput === "function") {
      const doc = await withTimeout(Promise.resolve(deps.taskOutput({ jobIds })), waitMs, null);
      output = readTaskOutputDocument(doc);
    }
    return touchedTasks.map((touched) => {
      const row = byTask.get(touched.id) || null;
      const jobId = row && typeof row.jobId === "string" ? row.jobId : null;
      const doc = jobId ? output.get(jobId) : null;
      return {
        taskId: touched.id,
        name: touched.name || (row && row.jobName) || null,
        jobId,
        row,
        runRecords: attempt(() => (typeof deps.runRecords === "function" ? deps.runRecords(touched.id) : []), []) || [],
        result: doc ? doc.result : null,
        cronLog: doc ? doc.cronLog : null,
      };
    });
  }

  async function build({ windowMs = null }      = {}) {
    const store = deps.store;

    const touched      = attempt(() => store.touched({ windowMs }), null) || { cards: [], tasks: [] };
    const streamRows = attempt(() => store.reportRows({ windowMs }), []);
    const onScreen = attempt(() => (typeof store.onScreenCard === "function" ? store.onScreenCard() : null), null);
    const cards = touched.cards.map((t     ) => attempt(() => cardOf(t, onScreen), { cardKey: t.id, name: t.name, why: t.why, atMs: t.atMs }));
    let tasks        = [];
    try { tasks = await tasksOf(touched.tasks); } catch { tasks = touched.tasks.map((t     ) => ({ taskId: t.id, name: t.name })); }
    const secretPass = createCodeSecretPass();
    const snapshot = buildCardStudioSnapshot({ nowMs: now(), cards, tasks, streamRows, secretPass });

    const nameOf = (entry     ) => (typeof entry.name === "string" && entry.name.trim() ? secretPass.text(entry.name.trim().slice(0, 80)) : null);
    return {
      streamRows: snapshot.streamRows,
      cardRows: snapshot.cardRows,
      taskRows: snapshot.taskRows,
      summary: snapshot.summary,
      names: { cards: cards.map(nameOf).filter(Boolean), tasks: tasks.map(nameOf).filter(Boolean) },
    };
  }

  return { build };
}

module.exports = { LINK_TASK_OUTPUT_SNAPSHOT_METHOD, TASK_OUTPUT_CONTRACT, TASK_OUTPUT_CONTRACT_VERSION, TASK_OUTPUT_WAIT_MS, readTaskOutputDocument, createCardStudioReport };
