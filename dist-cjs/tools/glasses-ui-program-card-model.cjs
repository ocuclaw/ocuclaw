const { createHash } = require("node:crypto");

const fs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, canonicalSerialize, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { normalizeModel, normalizePrompts, modelValueErrors } = require("./glasses-ui-program-card-model-data.cjs");
const { createProgramCardModelLease, programCardModelDeleted } = require("./glasses-ui-program-card-model-lease.cjs");

const PROGRAM_CARD_MODEL_CAPABILITY = 'programCardsModelV1';
const PROGRAM_CARD_MODEL_FILENAME = 'program-card-model-v1.json';
const PROGRAM_CARD_MODEL_THREADS = 'program-card-model-threads-v1';

const PROGRAM_CARD_MODEL_TURN_SAVED_SHAPE             = Object.freeze({
  fields: ['role', 'content', 'at', 'ran'],
  parts: { ran: { fields: ['provider', 'model', 'reasoning'] } },
});
const PROGRAM_CARD_MODEL_LIMITS = Object.freeze({ leaseMs: 150000, ownershipRetryMs: 15000, deadlineMs: 60000, consentMs: 60000, perMinute: 6, perDay: 200, hostPerDay: 1000, queue: 4 });

const PROGRAM_CARD_MODEL_HEALTH_REASONS = Object.freeze([
  'switch_off', 'no_host', 'library_in_use', 'unsupported_runtime', 'storage_unavailable', 'unavailable', 'card_deleted',
  'removed', 'cards_full', 'waiting', 'declined', 'model_changed', 'call_limit', 'call_busy', 'call_timeout', 'call_failed',
  'call_invalid_output', 'call_too_big', 'call_unavailable',
]);

const HEALTH_CALL_CODES = ['limit', 'busy', 'timeout', 'failed', 'invalid_output', 'too_big', 'unavailable'];
const LEASE_REASONS = ['library_in_use', 'unsupported_runtime', 'storage_unavailable'];
const KEY = /^(?:app:[a-z0-9][a-z0-9._-]{0,63}|run:[A-Za-z0-9][A-Za-z0-9._:#-]{0,95})$/;
const THREAD = /^[a-z][A-Za-z0-9_-]{0,23}$/;
const bytes = (v     ) => new TextEncoder().encode(typeof v === 'string' ? v : canonicalSerialize(v)).length;
const clone = (v     ) => JSON.parse(JSON.stringify(v));
const safeKey = (v     ) => typeof v === 'string' && KEY.test(v);
const publicUses = (uses       ) => uses.map(({ name, title, description, sends, output, memory, request, maxTokens }     ) => ({ name, title, description, sends, output: output === 'text' ? 'text' : 'schema', memory, request, maxTokens }));
function parseProgramCardModelUses(raw     ) {
  try {
    if (!Array.isArray(raw) || !raw.length || raw.length > 4) throw new Error('Expected 1 to 4 model uses');
    const block      = Object.create(null);
    for (const { name, ...spec } of raw) { if (Object.hasOwn(block, name)) throw new Error('Duplicate model use'); block[name] = spec; }
    return { ok: true         , uses: normalizeModel(block) };
  } catch (_) { return { ok: false         , error: 'Invalid model declaration or limits' }; }
}
function programCardModelDigest(uses       ) {
  const fields = uses.map((u     ) => ({ name: u.name, title: u.title, description: u.description, sends: u.sends, output: u.output === 'text' ? 'text' : 'schema', memory: u.memory, maxTokens: u.maxTokens })).sort((a     , b     ) => a.name.localeCompare(b.name));
  return createHash('sha256').update(canonicalSerialize(fields)).digest('hex');
}

function createProgramCardModelStore(options      = {}) {
  const root = resolveLiveuiLibraryRoot(options.libraryDir);
  const lease = createProgramCardModelLease(root);
  const assertOwner = () => { if (!lease.held()) throw new Error('library_in_use'); };
  const write = (file        , value     ) => { assertOwner(); return atomicWriteLiveuiLibraryRecord({ libraryDir: root, targetPath: file, record: value }); };
  const readJson = (file        , fallback     ) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
  const threadDir = (key        , use         ) => {
    if (!safeKey(key) || !key.startsWith('app:') || (use && !/^[a-z][A-Za-z0-9_]{0,23}$/.test(use))) throw new Error('invalid_key');
    return path.join(root, PROGRAM_CARD_MODEL_THREADS, key.slice(4), ...(use ? [use] : []));
  };
  return {
    acquire: lease.acquire, release: lease.release, owns: lease.held, reason: lease.reason,
    deleted: (key        ) => typeof key === 'string' && key.startsWith('app:') && programCardModelDeleted(root, key.slice(4)),
    read: () => readJson(path.join(root, PROGRAM_CARD_MODEL_FILENAME), { cards: [], hostUsage: null }),
    write: (value     ) => write(path.join(root, PROGRAM_CARD_MODEL_FILENAME), value),
    readThread(key        , use        , thread        ) {
      if (!THREAD.test(thread)) throw new Error('invalid_thread');
      return readJson(path.join(threadDir(key, use), `${thread}.json`), []);
    },
    writeThread(key        , use        , thread        , turns       ) {
      if (!THREAD.test(thread)) throw new Error('invalid_thread');
      write(path.join(threadDir(key, use), `${thread}.json`), turns);
    },
    threads(key        , use        ) {
      try { return fs.readdirSync(threadDir(key, use)).filter((n        ) => n.endsWith('.json') && THREAD.test(n.slice(0, -5))).map((n        ) => n.slice(0, -5)); } catch (_) { return []; }
    },
    clear(key        , use         , thread         ) {
      assertOwner();
      if (thread && !THREAD.test(thread)) throw new Error('invalid_thread');
      fs.rmSync(thread ? path.join(threadDir(key, use), `${thread}.json`) : threadDir(key, use), { recursive: !thread, force: true });
    },
    move(from        , to        ) {
      assertOwner();
      if (!from.startsWith('app:')) return;
      const dest = threadDir(to);
      if (fs.existsSync(threadDir(from)) && !fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.renameSync(threadDir(from), dest); }
    },
  };
}

function createProgramCardModel(deps      = {}) {
  const now = deps.now || Date.now, later = deps.setTimeoutFn || setTimeout, clear = deps.clearTimeoutFn || clearTimeout;
  const limits = { ...PROGRAM_CARD_MODEL_LIMITS, ...deps.limits };
  let enabled = deps.config?.enabled === true, away = false, stopped = false, pumping = false;
  const port = deps.host, store = deps.store;
  const records = new Map             (), subs = new Map             (), queue        = [], active = new Set     (), pending = new Map             (), memory = new Map               (), windows = new Map                  ();
  const runs = new Map             ();

  const listed = new Map             ();
  const inFlight = new Map                ();
  const recordScopes = new Map                ();

  const awaitingLive = new Map             ();
  const scopeKey = (scope     ) => canonicalSerialize(scope ?? {});
  const lastCalls = new Map             ();
  let epoch = 0, transientWriters = 0;
  const owns = () => !stopped && (!store || store.owns());
  const current = (generation        ) => owns() && generation === epoch;
  let hostUsage      = { day: '', requests: 0 };
  function reload() { try {
    for (const key of records.keys()) if (key.startsWith('app:')) records.delete(key);
    for (const key of memory.keys()) if (key.startsWith('app:')) memory.delete(key);
    for (const e of new Set([...subs.values(), ...runs.values()])) for (const job of e.jobs.values()) if (job.done) job.result = { ok: false, code: 'paused' };
    const saved = store?.read();
    hostUsage = { day: '', requests: 0 };
    if (saved?.schemaVersion === 1 && saved?.hostUsage) hostUsage = saved.hostUsage;
    windows.clear();
    for (const [key, times] of Object.entries(saved?.windows || {})) if (safeKey(key) && Array.isArray(times)) windows.set(key, times.filter(t => typeof t === 'number' && Number.isFinite(t) && now() - t < 60000));
    for (const r of (saved?.schemaVersion === 1 ? saved.cards || [] : []).slice(0, 64)) {
      const parsed = parseProgramCardModelUses(r?.uses);
      if (safeKey(r?.key) && r.key.startsWith('app:') && parsed.ok && r.digest === programCardModelDigest(parsed.uses) && ['allowed', 'denied', 'waiting'].includes(r.status)) records.set(r.key, { ...r, uses: parsed.uses, settings: Object.assign(Object.create(null), r.settings), paused: Object.assign(Object.create(null), r.paused) });
    }
  } catch (_) {  } }
  function acquire() {
    if (stopped) return false;
    if (owns()) return true;
    if (!store?.acquire()) return false;
    epoch++; reload(); return true;
  }
  function retainMutation() {
    if (!acquire()) return null;
    transientWriters++; return epoch;
  }
  function releaseMutation(generation               ) {
    if (generation == null || !current(generation)) return;
    transientWriters--;
    if (!enabled && transientWriters === 0) { epoch++; store?.release(); }
  }
  const timer = (fn     , ms        ) => { const t = later(fn, ms); t?.unref?.(); return t; };

  let ownershipRetry      = null;
  function claimWhenFree() {
    if (!enabled || stopped || owns() || store?.reason() === 'unsupported_runtime') return false;
    if (!acquire()) return false;
    refresh(); return true;
  }
  function armOwnershipRetry() {
    if (ownershipRetry || !enabled || stopped || owns() || !store) return;
    ownershipRetry = timer(() => { ownershipRetry = null; claimWhenFree(); armOwnershipRetry(); }, limits.ownershipRetryMs);
  }
  if (enabled) { if (owns()) reload(); else acquire(); } else reload();
  armOwnershipRetry();
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const usage = (r     ) => { if (r.usage?.day !== day()) r.usage = { day: day(), requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null }; return r.usage; };
  function persist() {
    if (!owns()) return;
    store?.write({ schemaVersion: 1, cards: [...records.values()].filter(r => r.key.startsWith('app:') && !store?.deleted(r.key)).sort((a, b) => b.atMs - a.atMs).slice(0, 64), hostUsage, windows: Object.fromEntries([...windows].map(([key, times]) => [key, times.filter(t => now() - t < 60000)])) });
  }
  function state() {
    return { type: 'program_card_model_state', enabled, available: owns(), reason: owns() ? null : store?.reason() || 'unavailable', host: port?.kind === 'hermes' ? 'hermes' : 'openclaw', cards: [...records.values()].map(r => ({ key: r.key, appId: r.key.startsWith('app:') ? r.key.slice(4) : null, name: r.name, status: r.status, digest: r.digest, uses: publicUses(r.uses), settings: r.settings, paused: r.paused, usage: usage(r) })) };
  }
  const publish = () => deps.broadcast?.(state());
  const privateSend = (owner        , frame     ) => deps.send?.(owner, frame) === true;
  const scopeFor = (source     ) => typeof deps.resolveContext === 'function' ? deps.resolveContext(source) : {};
  const sameScope = (a     , b     ) => a != null && b != null && canonicalSerialize(a) === canonicalSerialize(b);
  const canAccess = (owner        , key        ) => deps.canAccessCard?.(owner, key) !== false;
  function live(e     ) { return !stopped && subs.get(e.sub) === e && e.expires > now() && canAccess(e.owner, e.key) && sameScope(e.scope, scopeFor({ owner: e.owner })); }
  function refusal(job     )                {
    if (!enabled) return 'off';
    if (!owns()) return 'unavailable';
    if (store?.deleted(job.e.key)) return 'not_allowed';
    if (job.e.removed) return 'not_allowed';
    const r = records.get(job.e.key);
    if (!r || r.digest !== job.e.digest || r.status !== 'allowed') return 'not_allowed';
    if (!live(job.e) || away || r.paused?.[job.p.model]) return 'paused';
    if (job.cancelled) return job.cancelled;
    return null;
  }
  function status(e     ) {
    const r = records.get(e.key);
    return !enabled || !port || !owns() || store?.deleted(e.key) || e.removed || r?.status === 'denied' ? 'off' : r?.digest === e.digest && r?.status === 'allowed' ? 'on' : 'waiting';
  }
  function refresh() {
    for (const e of subs.values()) privateSend(e.owner, { type: 'program_card_model_data', sub: e.sub, kind: 'status', status: status(e) });
    publish(); pump();
  }
  function finish(job     , result     ) {
    if (job.done) return false;
    job.done = true;
    if (job.timer) clear(job.timer);
    job.controller?.abort();
    active.delete(job);
    const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1);
    const delivered = live(job.e) && privateSend(job.e.owner, { type: 'program_card_model_data', sub: job.e.sub, kind: 'result', id: job.p.id, model: job.p.model, ...result });
    job.result = result.ok && !delivered ? { ok: false, code: 'paused' } : result;
    noteCall(job.e.key, job.p.model, result);
    deps.emitLifecycle?.('program_card_model_call', 'debug', { card: createHash('sha256').update(job.e.key).digest('hex').slice(0, 12), use: job.p.model, outcome: result.ok ? 'ok' : result.code, ms: Math.max(0, now() - job.startedAt), delivered, inputTokens: job.usage?.inputTokens ?? 0, outputTokens: job.usage?.outputTokens ?? 0, costUsd: job.usage?.costUsd ?? null });
    return delivered;
  }

  function noteCall(key        , use        , result     ) {
    const id = `${key}\n${use}`;
    if (result.ok) { lastCalls.delete(id); return; }
    if (!HEALTH_CALL_CODES.includes(result.code)) return;
    lastCalls.delete(id); lastCalls.set(id, { code: result.code, atMs: now() });
    while (lastCalls.size > 256) lastCalls.delete(lastCalls.keys().next().value );
  }

  function health(key     , declared      = null) {
    if (stopped || !safeKey(key)) return [];
    const e = [...subs.values()].find(x => x.key === key && x.expires > now());
    const r = records.get(key);

    const named = !e && !r && declared ? parseProgramCardModelUses(declared) : null;
    const uses        = e?.uses || r?.uses || (named?.ok ? named.uses : []);
    const all = (reason        ) => uses.map((u     ) => ({ part: 'model', use: u.name, reason }));
    if (!enabled) return all('switch_off');
    if (!port) return all('no_host');
    if (!owns()) { const why = store?.reason(); return all(LEASE_REASONS.includes(why) ? why : 'unavailable'); }
    if (store?.deleted(key)) return all('card_deleted');
    if (e?.removed) return all('removed');

    if (!r && records.size >= 128) return all('cards_full');
    if (!r || (e && r.digest !== e.digest) || r.status === 'waiting') return all('waiting');
    if (r.status === 'denied') return all('declined');
    const out        = [];
    for (const u of uses) {
      const last = lastCalls.get(`${key}\n${u.name}`);
      if (r.paused?.[u.name]) out.push({ part: 'model', use: u.name, reason: 'model_changed' });
      else if (last) out.push({ part: 'model', use: u.name, reason: `call_${last.code}`, atMs: last.atMs });
    }
    return out;
  }

  function healthJudges(key     ) {
    if (!safeKey(key)) return 'no_record';
    if (stopped) return 'not_ready';
    const e = [...subs.values()].find(x => x.key === key && x.expires > now());
    return (e?.uses || records.get(key)?.uses || []).length ? 'yes' : 'no_record';
  }

  function hostHealth() {
    return stopped ? '' : !enabled ? 'switch_off' : !port ? 'no_host' : '';
  }

  function hostHealthKnown() { return !stopped; }
  function cancelJob(job     , code        ) { job.cancelled = code; finish(job, { ok: false, code }); }
  function drop(e     ) {
    for (const job of [...queue, ...active]) if (job.e === e) cancelJob(job, 'paused');
    if (e.lease) clear(e.lease);
    subs.delete(e.sub);
  }
  function threadKey(key        , use        , thread        ) { return `${key}\n${use}\n${thread}`; }
  function turns(key        , use        , thread        ) {
    const k = threadKey(key, use, thread);
    if (!memory.has(k)) {
      const saved = key.startsWith('app:') ? store?.readThread(key, use, thread) : [];
      memory.set(k, Array.isArray(saved) && bytes(saved) <= 32768 ? saved : []);
    }
    return memory.get(k) ;
  }
  function threadNames(key        , use        ) {
    return new Set([...(key.startsWith('app:') ? store?.threads(key, use) || [] : []), ...[...memory.keys()].filter(k => k.startsWith(`${key}\n${use}\n`)).map(k => k.split('\n')[2]),
      ...[...queue, ...active].filter(j => j.e.key === key && j.p.model === use && j.p.thread).map(j => j.p.thread)]);
  }
  function reset(key        , use        , thread        ) {
    for (const job of [...queue, ...active]) if (job.e.key === key && job.p.model === use && job.p.thread === thread) cancelJob(job, 'paused');
    memory.delete(threadKey(key, use, thread));
    if (key.startsWith('app:')) store?.clear(key, use, thread);
  }
  function budget(job     ) {
    const r = records.get(job.e.key);
    return budgetFor(r, r.settings[job.p.model]);
  }

  function budgetFor(r     , settings     ) {
    const u = usage(r);
    if (hostUsage.day !== day()) hostUsage = { day: day(), requests: 0 };
    const times = (windows.get(r.key) || []).filter(t => now() - t < 60000);
    windows.set(r.key, times);
    if (times.length >= limits.perMinute || u.requests >= limits.perDay || hostUsage.requests >= limits.hostPerDay || (settings.dailyRequestCap && u.requests >= settings.dailyRequestCap) || (settings.dailyCostCapUsd && (u.incompleteRequests > 0 || u.costUncertain === true || u.costUsd >= settings.dailyCostCapUsd))) return false;

    times.push(now()); u.requests++; u.incompleteRequests = (u.incompleteRequests || 0) + 1; hostUsage.requests++; persist(); return true;
  }
  function tally(r     , out     ) {
    const u = usage(r);
    u.incompleteRequests = Math.max(0, (u.incompleteRequests || 0) - 1);
    if (typeof out?.usage?.costUsd !== 'number' || !Number.isFinite(out.usage.costUsd) || out.usage.costUsd < 0) u.costUncertain = true;
    for (const k of ['inputTokens', 'outputTokens', 'costUsd']) if (typeof out?.usage?.[k] === 'number' && Number.isFinite(out.usage[k]) && out.usage[k] >= 0) u[k] += out.usage[k];
    persist();
  }
  async function run(job     ) {
    const generation = epoch;
    const r = records.get(job.e.key), use = job.use, settings = clone(r.settings[use.name]);
    const previous = job.p.thread ? turns(r.key, use.name, job.p.thread) : [];
    const system = `Your reply is data for a small glasses card. ${use.output === 'text' ? 'Reply in plain text, under 2000 characters.' : `Reply with JSON matching this schema, and nothing else: ${canonicalSerialize(use.output)}`}\n\n${use.instructions}`;
    let messages = [...previous.map(({ role, content }     ) => ({ role, content })), { role: 'user', content: job.p.input }];
    try {

      const waitKey = `${r.key}\n${use.name}`, wait = awaitingLive.get(waitKey);
      if (wait && wait.ref === `${settings.provider}/${settings.model}`) {
        const live = typeof port.permits === 'function' && await port.permits(wait.ref, wait.scope) === true;
        if (!current(generation)) return;
        if (!live) { finish(job, { ok: false, code: 'unavailable' }); return; }
        awaitingLive.delete(waitKey);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const denied = refusal(job); if (denied) { finish(job, { ok: false, code: denied }); return; }
        if (!budget(job)) { finish(job, { ok: false, code: 'limit' }); return; }
        const out = await port.complete({ ...settings, scope: job.e.scope, system, messages, signal: job.controller.signal, deadlineMs: job.deadlineAt });
        if (!current(generation)) return;
        job.usage ||= { inputTokens: 0, outputTokens: 0, costUsd: null };
        for (const k of ['inputTokens', 'outputTokens', 'costUsd']) if (typeof out?.usage?.[k] === 'number' && Number.isFinite(out.usage[k]) && out.usage[k] >= 0) job.usage[k] += out.usage[k];
        tally(r, out);
        if (job.done) return;
        const code = refusal(job); if (code) { finish(job, { ok: false, code }); return; }
        if (out?.ok === false) {
          if (out.code === 'model_changed') { r.paused[use.name] = 'model_changed'; persist(); refresh(); }
          finish(job, { ok: false, code: ['unavailable', 'timeout', 'model_changed'].includes(out.code) ? out.code : 'failed' }); return;
        }
        if (out?.provider !== settings.provider || out?.model !== settings.model) {
          r.paused[use.name] = 'model_changed'; persist(); refresh(); finish(job, { ok: false, code: 'model_changed' }); return;
        }
        const ran = { provider: out.provider, model: out.model, reasoning: settings.reasoning === 'adaptive' ? 'medium' : settings.reasoning === 'ultra' ? 'max' : settings.reasoning };
        let content = typeof out.text === 'string' ? out.text.trim() : '', result     ;
        if (use.output === 'text') { content = Array.from(content).slice(0, 2000).join(''); result = { ok: true, text: content, ran }; }
        else {
          let value     , errors           = [];
          if (bytes(content) > 32768) { finish(job, { ok: false, code: 'too_big' }); return; }
          try { value = JSON.parse(content.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')); errors = modelValueErrors(value, use.output); } catch (_) { errors = ['Expected valid JSON']; }
          if (!errors.length && bytes(value) > 8192) { finish(job, { ok: false, code: 'too_big' }); return; }
          if (errors.length) {
            if (attempt) { finish(job, { ok: false, code: 'invalid_output' }); return; }
            messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `Repair the JSON output: ${errors.join('; ')}. Return only valid JSON.` }]; continue;
          }
          content = canonicalSerialize(value); result = { ok: true, value, ran };
        }

        if (finish(job, result) && job.p.thread) {
          const next = [...previous, { role: 'user', content: job.p.input, at: now() }, { role: 'assistant', content, at: now(), ran }];
          while (next.length > 40 || bytes(next) > 32768) next.splice(0, 2);
          memory.set(threadKey(r.key, use.name, job.p.thread), next);
          if (r.key.startsWith('app:')) store?.writeThread(r.key, use.name, job.p.thread, next);
        }
        publish(); return;
      }
    } catch (_) { if (!job.done) finish(job, { ok: false, code: 'failed' }); }
    finally { pump(); }
  }
  function pump() {
    if (pumping || stopped) return; pumping = true;
    try {
      for (const job of [...queue]) {
        const code = refusal(job);
        if (code) { cancelJob(job, code); continue; }
        if (now() >= job.deadlineAt) { cancelJob(job, 'timeout'); continue; }
        if (active.size >= 2 || [...active].some(j => j.e.key === job.e.key)) continue;
        queue.splice(queue.indexOf(job), 1); active.add(job);
        job.controller = new AbortController();
        void run(job);
      }
    } finally { pumping = false; }
  }

  async function pick(use     , requested     , scope     , checkOwner            , named                ) {
    const { model, settings } = await select(use, requested, scope, checkOwner);
    if (!requested && named !== undefined && model.ref !== named) throw new Error('unavailable');
    return { use, model, settings };
  }

  async function select(use     , requested     , scope     , checkOwner            ) {
    checkOwner();
    if (scope == null) throw new Error('unavailable');
    const models = await port.listModels(scope);
    checkOwner();
    const ref = requested?.model ? `${requested.provider ? `${requested.provider}/` : ''}${requested.model}` : use.request?.model;
    let model = models.find((m     ) => m.ref === ref);
    if (!model && requested) throw new Error('unavailable');
    if (!model) model = models.find((m     ) => m.isMain);
    if (!model) throw new Error('unavailable');
    const policy = await port.reasoningLevels(model.provider, model.model, scope);
    checkOwner();
    const want = requested ? requested.reasoning : use.request?.reasoning;
    const reasoning = policy.enforceable ? policy.levels.includes(want) ? want : policy.defaultLevel : null;
    const maxTokens = requested?.maxTokens ?? use.maxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > (requested ? 2000 : 800)) throw new Error('invalid_settings');
    const settings      = { provider: model.provider, model: model.model, reasoning, maxTokens,
      reasoningReset: policy.enforceable && want != null && !policy.levels.includes(want) };
    for (const k of ['dailyRequestCap', 'dailyCostCapUsd']) if (requested?.[k] != null) {
      if (typeof requested[k] !== 'number' || !Number.isFinite(requested[k]) || requested[k] <= 0 || (k === 'dailyRequestCap' && !Number.isInteger(requested[k]))) throw new Error('invalid_settings');
      settings[k] = requested[k];
    }
    return { model, settings };
  }

  async function authorize(picks       , scope     , checkOwner            , record     , write         ) {
    const sk = scopeKey(scope);
    const keys = picks.map((p     ) => `${sk}\n${p.model.ref}`);
    const owned           = [], notLive        = [];
    hold(keys, 1);
    try {
      for (const p of picks) {
        const key = `${sk}\n${p.model.ref}`;
        checkOwner();
        if (write) {
          const allowed = await port.allowModel(p.model.ref, scope);

          if (allowed?.undo && !listed.has(key)) { listed.set(key, { receipt: allowed.undo, scope, sk, ref: p.model.ref }); owned.push(key); }
          checkOwner();
          if (!['saved', 'allowed', 'already_allowed', 'ok'].includes(allowed?.status)) throw new Error('unavailable');
          if (allowed?.activation?.required === true) { notLive.push(p); continue; }
        } else {
          if (typeof port.permits !== 'function' || await port.permits(p.model.ref, scope) !== true) throw new Error('unavailable');
          checkOwner();
        }

        if (!budgetFor(record, record.settings?.[p.use.name] || p.settings)) throw new Error('limit');
        const checked = await port.check(p.settings, scope);
        tally(record, checked);
        checkOwner();
        if (!checked?.ok) throw new Error('unavailable');
      }
    } catch (err) { hold(keys, -1); await sweep(); throw err; }
    hold(keys, -1);
    return { owned, notLive };
  }
  function hold(keys          , by        ) {
    for (const key of keys) { const n = (inFlight.get(key) || 0) + by; if (n > 0) inFlight.set(key, n); else inFlight.delete(key); }
  }

  function keep(owned          ) { for (const key of owned) listed.delete(key); }

  function usedRefs(sk        ) {
    const refs = new Set        ();
    for (const r of records.values()) {
      if (r.status !== 'allowed' || (recordScopes.has(r.key) && recordScopes.get(r.key) !== sk)) continue;
      for (const s of Object.values(r.settings || {})         ) if (s) refs.add(`${s.provider}/${s.model}`);
    }
    for (const key of inFlight.keys()) if (key.startsWith(`${sk}\n`)) refs.add(key.slice(sk.length + 1));
    return refs;
  }

  async function sweep() {
    for (const [key, entry] of [...listed].reverse()) {
      if (entry.busy) continue;
      const used = usedRefs(entry.sk);
      if (used.has(entry.ref)) continue;
      entry.busy = true;
      try {
        const out = typeof port.revokeModel === 'function' ? await port.revokeModel(entry.receipt, entry.scope, [...used]) : null;
        if (out?.status !== 'revoked') throw new Error(out?.status || 'no_revoke');
        if (listed.get(key) === entry) listed.delete(key);
      } catch (err     ) {
        deps.emitLifecycle?.('program_card_model_revoke_failed', 'warn', { ref: entry.ref, stillListed: true, code: String(err?.message || 'error').slice(0, 32) });
      } finally { entry.busy = false; }
    }
  }

  function awaitLive(r     , notLive       , scope     ) {
    for (const p of notLive) {
      awaitingLive.set(`${r.key}\n${p.use.name}`, { ref: p.model.ref, scope });
      deps.emitLifecycle?.('program_card_model_activation_required', 'info', { card: createHash('sha256').update(r.key).digest('hex').slice(0, 12), use: p.use.name });
    }
  }

  async function decide(key        , digest        , allow         , settings      , scope      = {}, generation = epoch, authorized = () => true, named      ) {
    if (!current(generation) || !authorized() || store?.deleted(key)) return false;
    const r = records.get(key);
    if (!r || r.digest !== digest) return false;
    if (allow) {
      const still = () => current(generation) && authorized() && records.get(key) === r && r.digest === digest && enabled && !stopped && !store?.deleted(key);
      const checkOwner = () => { if (!still()) throw new Error('unavailable'); };
      const picks        = [];
      for (const use of r.uses) if (!Object.hasOwn(r.settings, use.name) || settings && Object.hasOwn(settings, use.name)) {
        const requested = settings && Object.hasOwn(settings, use.name) ? settings[use.name] : undefined;
        picks.push(await pick(use, requested, scope, checkOwner, named && Object.hasOwn(named, use.name) ? named[use.name] : undefined));
      }

      const { owned, notLive } = await authorize(picks, scope, checkOwner, r, true);
      if (!still()) { await sweep(); return false; }
      const next = { ...r.settings };
      for (const p of picks) next[p.use.name] = p.settings;
      r.settings = next;
      recordScopes.set(key, scopeKey(scope));
      keep(owned);
      for (const p of picks) awaitingLive.delete(`${key}\n${p.use.name}`);
      awaitLive(r, notLive, scope);
    }
    r.status = allow ? 'allowed' : 'denied'; r.atMs = now(); persist();
    pending.get(`${key}\n${digest}`)?.settle(allow ? 'allowed' : 'declined'); refresh(); return true;
  }
  async function consider(input     ) {
    if (!enabled || !port) return { answer: 'off' };
    if (!acquire() || store?.deleted(input.key)) return { answer: 'unavailable' };
    const generation = epoch;
    const scope = input.scope ?? scopeFor({ sessionKey: input.sessionKey, owner: input.owner });
    if (scope == null) return { answer: 'unavailable' };
    const parsed = parseProgramCardModelUses(input.uses);
    if (!safeKey(input.key) || !parsed.ok) return { answer: 'invalid', error: parsed.error };
    const digest = programCardModelDigest(parsed.uses), old = records.get(input.key);
    if (old?.digest === digest) { old.uses = parsed.uses; persist(); if (old.status !== 'waiting') return { answer: old.status === 'allowed' ? 'allowed' : 'declined' }; }
    else {

      if (!old && records.size >= 128) return { answer: 'off' };
      records.set(input.key, { key: input.key, name: String(input.name || 'Card').slice(0, 60), digest, uses: parsed.uses, status: 'waiting', settings: old?.settings || Object.create(null), paused: Object.create(null), atMs: now() });
    }
    publish();
    const id = `${input.key}\n${digest}`;
    if (pending.has(id)) return pending.get(id).promise;
    let resolve     ;
    const promise = new Promise(r => { resolve = r; });
    const entry      = { promise, settle(answer        ) { if (pending.get(id) !== entry) return; clear(entry.timer); pending.delete(id); resolve({ answer }); } };
    pending.set(id, entry);
    const models = await port.listModels(scope).catch(() => []);
    if (!current(generation)) { entry.settle('off'); return promise; }
    const r = records.get(input.key);
    if (!r || r.digest !== digest || stopped || !enabled) { entry.settle('no_answer'); return promise; }
    if (pending.get(id) !== entry) return promise;
    if (!current(generation) || records.get(input.key) !== r || !enabled || stopped) { entry.settle('off'); return promise; }
    persist(); publish();

    const named      = Object.create(null);
    for (const u of r.uses) if (!r.settings[u.name]) named[u.name] = (models.find((m     ) => m.ref === u.request?.model) || models.find((m     ) => m.isMain))?.ref ?? null;

    if (r.uses.some((u     ) => !r.settings[u.name] && !named[u.name])) { entry.settle('unavailable'); return promise; }
    const names = r.uses.map((u     ) => r.settings[u.name] ? `${r.settings[u.name].provider}/${r.settings[u.name].model}` : named[u.name]);
    const question = [...r.uses.map((u     ) => `• ${u.title}: sends ${u.sends}`), `Model: ${[...new Set(names)].join(', ')}`, ...(port.kind === 'hermes' ? ["If it's busy, Hermes may answer once with your main model. That answer is thrown away and the card pauses."] : [])].join('\n');
    entry.timer = timer(() => entry.settle('no_answer'), limits.consentMs);
    const accepted = deps.presentDecision?.({ surface: { surfaceId: `card-model:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`, sessionKey: input.sessionKey || deps.sessionKey?.(), kind: 'permission', title: 'Let this card use a model?', question, options: [{ key: 'allow', label: 'Allow' }, { key: 'deny', label: 'Not now' }], deadlineSec: 60 }, expiresAtMs: now() + limits.consentMs, onDecision: (d     ) => {
      if (!['allow', 'deny'].includes(d?.choice || d?.key || d?.optionKey)) { entry.settle('no_answer'); return; }
      const allow = d?.choice === 'allow' || d?.key === 'allow' || d?.optionKey === 'allow';
      void decide(input.key, digest, allow, undefined, scope, generation, undefined, named).catch(() => entry.settle('no_answer'));
    } });
    if (accepted !== true && accepted?.presented !== true) entry.settle('no_answer');
    return promise;
  }
  function remove(key        , clearMemory         ) {
    const generation = retainMutation();
    if (generation == null) return;
    try {
    records.delete(key);
    for (const e of subs.values()) if (e.key === key) e.removed = true;
    for (const job of [...queue, ...active]) if (job.e.key === key) cancelJob(job, 'not_allowed');
    for (const [id, p] of pending) if (id.startsWith(`${key}\n`)) p.settle('declined');
    if (clearMemory) {
      for (const k of memory.keys()) if (k.startsWith(`${key}\n`)) memory.delete(k);
      if (key.startsWith('app:')) store?.clear(key);
    }
    persist(); refresh();
    } finally { releaseMutation(generation); }

    void sweep();
  }
  async function handle(msg     , owner        ) {
    let mutation                = null;
    try {
      if (!owner || !msg || stopped) return;
      const requestedKey = msg.op === 'open' ? msg.card?.key : msg.key || subs.get(msg.sub)?.key;
      if (typeof requestedKey === 'string' && !canAccess(owner, requestedKey)) return;
      const scope = scopeFor({ owner });
      if (scope == null) return;
      if (msg.op === 'state') { if (!claimWhenFree()) publish(); return; }
      if (msg.op === 'models') {
        const models = await port?.listModels(scope) || [];
        const policies      = {};
        for (const m of models) policies[m.ref] = await port.reasoningLevels(m.provider, m.model, scope);
        if (!sameScope(scope, scopeFor({ owner }))) return;
        privateSend(owner, { type: 'program_card_model_models', models, policies }); return;
      }
      if (msg.op === 'open') {
        const owned = enabled && acquire();
        const parsed = parseProgramCardModelUses(msg.uses);
        if (!parsed.ok || !safeKey(msg.card?.key) || typeof msg.sub !== 'string' || !msg.sub || msg.sub.length > 160) return;
        const existing = subs.get(msg.sub);
        if (existing && existing.owner !== owner) return;
        for (const e of [...subs.values()]) if (e.owner === owner && e.sub !== msg.sub) drop(e);
        const key = msg.card.key, digest = programCardModelDigest(parsed.uses);
        if (owned && !store?.deleted(key) && safeKey(msg.from) && msg.from.startsWith('run:') && key.startsWith('app:') && !records.has(key)) {
          const old = records.get(msg.from);
          if (old?.digest === digest) {
            records.delete(msg.from); old.key = key; records.set(key, old);
            for (const [k, v] of [...memory]) if (k.startsWith(`${msg.from}\n`)) { const next = k.replace(msg.from, key); memory.set(next, v); const [, use, thread] = next.split('\n'); store?.writeThread(key, use, thread, v); memory.delete(k); }
            persist();
          }
        }
        if (existing && (existing.key !== key || existing.digest !== digest)) drop(existing);
        for (const [runKey, run] of runs) if (run.expires <= now()) runs.delete(runKey);
        const runKey = `${key}\n${msg.sub}\n${digest}\n${canonicalSerialize(scope)}`;
        const cached = runs.get(runKey);
        if (subs.has(msg.sub) && !sameScope(subs.get(msg.sub).scope, scope)) drop(subs.get(msg.sub));
        const e = subs.get(msg.sub) || { owner, sub: msg.sub, key, digest, scope, jobs: cached?.jobs || new Map() };
        e.uses = parsed.uses; e.name = String(msg.card.name || 'Card').slice(0, 60); e.expires = now() + limits.leaseMs;
        if (e.lease) clear(e.lease);
        e.lease = timer(() => { drop(e); pump(); }, limits.leaseMs);
        subs.set(e.sub, e);
        runs.delete(runKey); runs.set(runKey, e);
        while (runs.size > 16) runs.delete(runs.keys().next().value );
        if (!e.removed) void consider({ key, name: e.name, uses: parsed.uses, cause: 'open', scope }).catch(() => {});
        refresh(); return;
      }
      const e = typeof msg.sub === 'string' ? subs.get(msg.sub) : null;
      if (['prompt', 'cancel', 'close'].includes(msg.op)) {
        if (!e || e.owner !== owner) return;
        if (msg.op === 'close') { drop(e); pump(); return; }
        if (msg.op === 'cancel') { if (Array.isArray(msg.ids)) for (const id of msg.ids.slice(0, 32)) { const j = e.jobs.get(id); if (j && !j.done) cancelJob(j, 'paused'); } pump(); return; }
        let prompts       ;
        try { prompts = normalizePrompts(msg.prompts, e.uses); } catch (_) { return; }
        for (const p of prompts) {
          if (e.jobs.has(p.id)) {
            const previous = e.jobs.get(p.id);
            if (previous.done) {
              const code = refusal({ e, p });
              const result = code ? { ok: false, code } : canonicalSerialize(previous.p) === canonicalSerialize(p) ? previous.result : { ok: false, code: 'failed' };
              privateSend(e.owner, { type: 'program_card_model_data', sub: e.sub, kind: 'result', id: p.id, model: p.model, ...result });
            }
            continue;
          }
          if (e.jobs.size >= 512) break;
          const job      = { e, p, use: e.uses.find((u     ) => u.name === p.model), startedAt: now(), done: false };
          job.deadlineAt = job.startedAt + limits.deadlineMs;
          e.jobs.set(p.id, job);
          const code = refusal(job);
          if (code) { finish(job, { ok: false, code }); continue; }
          if (p.reset) { reset(e.key, p.model, p.reset); finish(job, { ok: true, reset: p.reset }); continue; }
          if (p.thread && !threadNames(e.key, p.model).has(p.thread) && threadNames(e.key, p.model).size >= 4) { finish(job, { ok: false, code: 'limit' }); continue; }
          if (queue.filter(j => j.e.key === e.key).length >= limits.queue) { finish(job, { ok: false, code: 'busy' }); continue; }
          job.timer = timer(() => { cancelJob(job, 'timeout'); pump(); }, limits.deadlineMs);
          queue.push(job); pump();
        }
        return;
      }
      if (!safeKey(msg.key)) return;
      mutation = retainMutation();
      if (mutation == null) { publish(); return; }
      const generation = mutation;
      const r = records.get(msg.key);
      if (msg.op === 'remove') { remove(msg.key, msg.clearMemory === true); return; }
      if (!r) return;
      const authorized = () => canAccess(owner, msg.key) && sameScope(scope, scopeFor({ owner }));
      if (msg.op === 'decide' && typeof msg.allow === 'boolean') { await decide(msg.key, msg.digest, msg.allow, msg.settings, scope, generation, authorized); return; }
      const use = r.uses.find((u     ) => u.name === msg.use);
      if (!use) return;
      if (msg.op === 'settings' || msg.op === 'check') {
        let ok = false;
        try {
          if (!msg.settings || typeof msg.settings !== 'object' || Array.isArray(msg.settings) || typeof msg.settings.provider !== 'string' || typeof msg.settings.model !== 'string') throw new Error('invalid_settings');

          const checkOwner = () => { if (!current(generation) || !authorized() || records.get(msg.key) !== r) throw new Error('unavailable'); };
          const p = await pick(use, msg.settings, scope, checkOwner);
          const { owned, notLive } = await authorize([p], scope, checkOwner, r, r.status === 'allowed');
          const stands = current(generation) && !stopped && records.get(msg.key) === r && canAccess(owner, msg.key) && sameScope(scope, scopeFor({ owner }));
          if (msg.op === 'check' || !stands) await sweep();
          if (!stands) return;
          if (msg.op === 'settings') {
            r.settings[use.name] = p.settings;

            keep(owned);
            if (r.status === 'allowed') recordScopes.set(msg.key, scopeKey(scope));
            awaitingLive.delete(`${msg.key}\n${use.name}`);
            awaitLive(r, notLive, scope);
            persist(); publish();
          }

          ok = notLive.length === 0;
        } catch (_) {  }
        privateSend(owner, { type: 'program_card_model_check', key: msg.key, use: use.name, ok, ...(ok ? {} : { code: 'unavailable' }) }); return;
      }
      if (msg.op === 'resume') { delete r.paused[use.name]; persist(); refresh(); return; }
      if (msg.op === 'reset' && THREAD.test(msg.thread)) { reset(msg.key, use.name, msg.thread); }
      if (msg.op === 'threads' || msg.op === 'reset') {
        const threads = [...threadNames(msg.key, use.name)].map(name => { const t = turns(msg.key, use.name, name); return { name, turns: t.length, bytes: bytes(t), at: t.at(-1)?.at || null, messages: t }; });
        privateSend(owner, { type: 'program_card_model_threads', key: msg.key, use: use.name, instructions: use.instructions, output: use.output, threads });
      }
    } catch (_) {  }
    finally { releaseMutation(mutation); }
  }
  return {
    handle, consider, state, remove, health, healthJudges, hostHealth, hostHealthKnown,

    askAgainFor(key     , sessionKey     )                         {
      const r = safeKey(key) ? records.get(key) : null;
      if (!r || r.status !== 'waiting' || !enabled || !port) return Promise.resolve(null);
      return consider({ key, name: r.name, uses: r.uses, sessionKey }).then((out     ) => String(out?.answer || 'no_answer'), () => 'no_answer');
    },
    armed: () => enabled && !!port && owns(),
    setEnabled(value         ) {
      enabled = value === true;
      if (!enabled) {
        for (const job of [...queue, ...active]) cancelJob(job, 'off');
        for (const p of pending.values()) p.settle('off');
        epoch++; transientWriters = 0; store?.release();
      } else { acquire(); armOwnershipRetry(); }
      if (enabled) for (const e of subs.values()) if (!e.removed && live(e) && status(e) === 'waiting') void consider({ key: e.key, name: e.name, uses: e.uses, cause: 'open', scope: e.scope }).catch(() => {});
      refresh(); return { enabled };
    },
    setPresence(value        ) { away = value === 'absent' || value === 'in_case'; if (away) for (const job of [...queue, ...active]) cancelJob(job, 'paused'); pump(); },
    disconnect(owner        ) { for (const e of [...subs.values()]) if (e.owner === owner) drop(e); pump(); },
    stopAll() { stopped = true; if (ownershipRetry) clear(ownershipRetry); ownershipRetry = null; epoch++; for (const e of [...subs.values()]) drop(e); for (const p of pending.values()) p.settle('no_answer'); runs.clear(); store?.release(); },
  };
}

module.exports = { PROGRAM_CARD_MODEL_CAPABILITY, PROGRAM_CARD_MODEL_FILENAME, PROGRAM_CARD_MODEL_THREADS, PROGRAM_CARD_MODEL_TURN_SAVED_SHAPE, PROGRAM_CARD_MODEL_LIMITS, PROGRAM_CARD_MODEL_HEALTH_REASONS, parseProgramCardModelUses, programCardModelDigest, createProgramCardModelStore, createProgramCardModel };
