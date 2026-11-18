const { randomUUID } = require("node:crypto");
const { createModelSitesStore } = require("./model-sites-store.cjs");
const { createSketchfabClient, sketchfabModelId, ModelSiteError, modelSiteRace } = require("./sketchfab-client.cjs");
const { GLASS_MESH_TYPE } = require("../liveui-pictures/picture-model.cjs");

const { MODEL_SITE_PROVIDERS, modelSiteProvider, modelSiteLabel } = require("../liveui-pictures/model-source.cjs");
const { createPrintSiteClient, printSiteModelId } = require("./print-site-client.cjs");
const { createObjaverseMirror } = require("./objaverse-mirror.cjs");

const MODEL_SITE_TRANSACTION_MS = 120_000;
const MAX_PENDING = 64;

const codeOf = (error         ) => error instanceof ModelSiteError ? error.code : "unavailable";
const importCodes                         = {
  invalid_token: "model_needs_reconnect", download_unavailable: "model_download_unavailable",
  rate_limited: "model_rate_limited", provider_unavailable: "model_provider_unavailable",
  network_policy: "picture_host_refused", too_large: "model_too_big", unsupported_format: "model_format_unsupported",
  cancelled: "model_import_cancelled",
};

function createModelSitesService(options                   ) {
  const services = Object.fromEntries(MODEL_SITE_PROVIDERS.map(site => [site, createProviderService(options, site)]))                                                                       ;
  const selected = (site          = "sketchfab") => {
    if (!modelSiteProvider(site)) throw new ModelSiteError("invalid_request");
    return services[site];
  };
  const transaction = (id        ) => selected(MODEL_SITE_PROVIDERS.find(site => id?.startsWith(`${site}-`)) || "sketchfab");
  const mirror = options.objaverse === false ? null : createObjaverseMirror({ ...options, ...(options.objaverse || {}) });
  const publicSketchfab = createSketchfabClient(options);
  return {
    status: (site         ) => selected(site).status(),
    begin: (client        , intent        , revision        , site         ) => selected(site).begin(client, intent, revision),
    save: (client        , id        , token        ) => transaction(id).save(client, id, token),
    remove: (client        , id        ) => transaction(id).remove(client, id),
    cancel: (client        , id        ) => transaction(id).cancel(client, id),
    releaseClient: (client        ) => Object.values(services).forEach(service => service.releaseClient(client)),
    resolve: (async (src, context, consume) => {
      for (const service of Object.values(services)) {
        const result = await service.resolve(src, context, consume);
        if (result) return result.ok || !MIRROR_CODES.has(result.code) ? result : (await fromMirror(src, context, consume)) || result;
      }
      return null;
    })                                ,

    mirror: mirror !== null,
    close: () => {
      Object.values(services).forEach(service => service.close());
      mirror?.close();
      publicSketchfab.close();
    },
  };

  async function fromMirror(...[src, context, consume]                                          )                                       {
    const id = sketchfabModelId(src);
    if (!id || !mirror || context.signal?.aborted) return null;
    let url                = null;
    try { url = await mirror.fileUrl(id, context.reach); } catch { url = null; }
    if (!url || context.signal?.aborted) return null;
    const signal = context.signal || new AbortController().signal;
    let result                      ;
    try { result = await consume(url, signal); } catch { return null; }
    if (!result.ok || result.mime !== GLASS_MESH_TYPE) return null;
    let modelSource                         ;
    try { modelSource = await publicSketchfab.publicSource(id, context.reach, signal); } catch { modelSource = undefined; }
    return { ...result, ...(modelSource ? { modelSource } : {}) };
  }
}

const MIRROR_CODES = new Set(["model_needs_login", "model_scope_refused", "model_needs_reconnect",
  "model_download_unavailable", "model_provider_unavailable", "model_rate_limited"]);

function createProviderService(options                   , site                   ) {
  const failed = (code        )                       => ({ ok: false, code, detail: modelSiteLabel(site) });
  const store = createModelSitesStore(options.stateDir, site);
  const provider = site === "sketchfab" ? createSketchfabClient(options) : createPrintSiteClient(options, site);
  const now = options.now || Date.now;
  const pending = new Map                     ();
  const verifying = new Map                                                                   ();
  const imports = new Set                 ();
  let closed = false;
  let health                                                           = null;
  function read() {
    if (closed) throw new ModelSiteError("unavailable");
    return store.read();
  }
  function status() {
    try {
      const state = read();
      const h = health?.revision === state.revision ? health : null;
      return { provider: site, revision: state.revision,
        state: [...verifying.values()].some(row => !row.controller.signal.aborted) ? "checking" : !state.credential ? "not_connected" : h?.state || "connected",
        ...(state.credential ? { account: state.credential.account } : {}), ...(h ? { code: h.code } : {}),
      };
    } catch { return { provider: site, revision: "unavailable", state: "temporarily_unavailable", code: "unavailable" }; }
  }
  const answer = (code         , extra                          = {}) => ({ status: code ? "error" : "ok", ...(code ? { code } : {}), snapshot: status(), ...extra });
  function prune() {
    for (const [id, row] of pending) if (row.expiresAtMs <= now()) pending.delete(id);
    for (const row of verifying.values()) if (row.transaction.expiresAtMs <= now()) row.controller.abort();
  }
  function releaseClient(clientId        ) {
    for (const [id, row] of pending) if (row.clientId === clientId) pending.delete(id);
    for (const row of verifying.values()) if (row.transaction.clientId === clientId) row.controller.abort();
  }
  function invalidate() {
    for (const controller of imports) controller.abort();
    for (const row of verifying.values()) row.controller.abort();
    pending.clear();
    health = null;
  }
  function take(clientId        , id        , allowed          )              {
    const row = pending.get(id);
    if (!row || row.clientId !== clientId || !allowed.includes(row.intent)) throw new ModelSiteError("transaction_invalid");
    pending.delete(id);
    if (row.expiresAtMs <= now()) throw new ModelSiteError("transaction_expired");
    if (read().revision !== row.revision) throw new ModelSiteError("configuration_changed");
    return row;
  }
  function begin(clientId        , intent        , revision        ) {
    try {
      prune();
      if (!clientId || !["create", "replace", "remove"].includes(intent)) return answer("invalid_request");
      const state = read();
      if (revision !== state.revision) return answer("configuration_changed");
      if (state.credential && intent === "create") return answer("replacement_required");
      if (!state.credential && intent !== "create") return answer("not_connected");
      if (pending.size + verifying.size >= MAX_PENDING) return answer("busy");
      releaseClient(clientId);
      const row              = { id: `${site}-${randomUUID()}`, clientId, intent, revision, expiresAtMs: now() + MODEL_SITE_TRANSACTION_MS };
      pending.set(row.id, row);
      return answer(undefined, { transaction: { id: row.id, provider: site, intent, expiresAtMs: row.expiresAtMs } });
    } catch (error) { return answer(codeOf(error)); }
  }
  async function save(clientId        , transactionId        , token        ) {
    let controller                             ;
    try {
      const transaction = take(clientId, transactionId, ["create", "replace"]);
      if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token)) return answer("invalid_token");
      controller = new AbortController();
      verifying.set(transactionId, { transaction, controller });
      const account = await provider.account(token, options.networkReach?.() || "hosts", controller.signal);
      if (controller.signal.aborted || closed) { verifying.delete(transactionId); return answer("cancelled"); }
      if (transaction.expiresAtMs <= now()) { verifying.delete(transactionId); return answer("transaction_expired"); }

      store.write(transaction.revision, { token, account });
      invalidate();
      return answer();
    } catch (error) {
      const committed = error instanceof ModelSiteError && error.committed;
      const code = committed ? "outcome_unknown" : controller?.signal.aborted ? "cancelled" : codeOf(error);
      if (committed) invalidate();
      verifying.delete(transactionId);
      return answer(code);
    }
    finally { verifying.delete(transactionId); token = ""; }
  }
  function cancel(clientId        , transactionId        ) {

    const active = verifying.get(transactionId);
    if (active?.transaction.clientId === clientId) { active.controller.abort(); return answer(); }
    const row = pending.get(transactionId);
    if (!row || row.clientId !== clientId) return answer("transaction_invalid");
    pending.delete(transactionId);
    return answer();
  }
  function remove(clientId        , transactionId        ) {
    try {
      const transaction = take(clientId, transactionId, ["remove"]);
      store.write(transaction.revision, null);
      invalidate();
      return answer();
    } catch (error) {
      if (error instanceof ModelSiteError && error.committed) invalidate();
      return answer(codeOf(error));
    }
  }
  const resolve                               = async (src, context, consume) => {
    const id = site === "sketchfab" ? sketchfabModelId(src) : printSiteModelId(src, site);
    if (!id) return null;
    if (context.allowed !== true) return failed("model_scope_refused");
    let state                ;
    try { state = read(); } catch { return failed("model_provider_unavailable"); }
    if (!state.credential) return failed("model_needs_login");
    const controller = new AbortController();
    imports.add(controller);
    const abort = () => controller.abort();
    if (context.signal?.aborted) controller.abort();
    else context.signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(abort, 70_000);
    const current = () => {
      try { return !closed && !controller.signal.aborted && read().revision === state.revision; } catch { return false; }
    };
    try {
      const file = await provider.download(id, state.credential.token, context.reach, controller.signal);
      if (!current()) return failed("model_import_cancelled");
      const result = await modelSiteRace(Promise.resolve(consume(file.url, controller.signal)), controller.signal);
      if (!current()) return failed("model_import_cancelled");
      if (!result.ok) {

        if (result.code === "picture_fetch_failed" && /^http (401|403|404)$/.test(result.detail)) return failed("model_provider_unavailable");
        return result;
      }
      if (result.mime !== GLASS_MESH_TYPE) return failed("model_unreadable");
      health = null;
      return { ...result, modelSource: file.modelSource,

        modelImportValid: current };
    } catch (error) {
      const code = codeOf(error);
      if (current() && (code === "invalid_token" || code === "provider_unavailable" || code === "rate_limited")) {
        health = { revision: state.revision, state: code === "invalid_token" ? "needs_reconnect" : "temporarily_unavailable", code: code === "invalid_token" ? "needs_reconnect" : code };
      }
      return failed(importCodes[code] || "model_provider_unavailable");
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      imports.delete(controller);
    }
  };
  return { status, begin, save, cancel, remove, releaseClient, resolve,
    close() { closed = true; invalidate(); provider.close(); },
  };
}

module.exports = { MODEL_SITE_TRANSACTION_MS, createModelSitesService };
