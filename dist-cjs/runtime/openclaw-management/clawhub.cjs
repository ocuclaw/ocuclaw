const { OpenClawManagementError } = require("./shared.cjs");

const clawhubTiming = { settleMs: 75_000, stepMs: 3_000 };

const RESULT_LIMIT = 20;
const SEARCH_LIMIT = 25;
const NAME_LIMIT = 160;
const SUMMARY_LIMIT = 240;

const OPERATIONS      = {
  "clawhub.plugins.search": { kind: "plugin", read: true, methods: ["plugins.search"] },
  "clawhub.skills.search": { kind: "skill", read: true, methods: ["skills.search"] },
  "clawhub.plugins.detail": { kind: "plugin", read: true, detail: true, methods: ["plugins.catalog.get"] },
  "clawhub.skills.detail": { kind: "skill", read: true, detail: true, methods: ["skills.detail"] },
  "clawhub.plugins.install": { kind: "plugin", read: false, methods: ["plugins.search", "plugins.install"] },
  "clawhub.skills.install": { kind: "skill", read: false, methods: ["skills.search", "skills.install", "skills.status"] },
};

function record(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value     ) {
  return Array.isArray(value) ? value.filter(record) : [];
}

function clean(value     , limit     ) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function safeRef(value     ) {
  return typeof value === "string" && /^[A-Za-z0-9@._:/+=-]{1,200}$/.test(value) ? value : "";
}

function safeVersion(value     ) {
  return typeof value === "string" && /^[A-Za-z0-9._+-]{1,64}$/.test(value) ? value : "";
}

function skillSlug(ref     ) {
  const parts = String(ref).split(/[/:]/);
  return parts[parts.length - 1] || "";
}

function pluginTrust(pkg     ) {
  return pkg.isOfficial === true || pkg.channel === "official" ? "official" : "community";
}

function skillInstallable(hit     ) {
  const trust = record(hit.trust) ? hit.trust : {};
  const verdict = typeof trust.clawHubVerdict === "string" ? trust.clawHubVerdict : "";
  return hit.native?.skill?.isSuspicious !== true && !/suspicious|malicious|block/i.test(verdict) &&
    (trust.installability === undefined || trust.installability === "installable");
}

function skillTrust(hit     ) {
  if (hit.official === true || hit.publisher?.official === true) return "official";
  return hit.trustState === "not-scanned-by-clawhub" ? "not_scanned" : "community";
}

async function installedPlugins(ctx     ) {
  if (!ctx.advertises("plugins.list")) return { keys: new Set(), mutable: true };
  const answer      = await ctx.call("plugins.list", {});
  const keys = new Set();
  for (const plugin of list(answer?.plugins)) {
    if (plugin.installed !== true) continue;
    for (const key of [plugin.id, plugin.packageName, plugin.clawhubPackage]) if (typeof key === "string" && key) keys.add(key);
  }
  return { keys, mutable: answer?.mutationAllowed !== false };
}

async function installedSkills(ctx     , agentId     ) {
  const status      = await ctx.call("skills.status", { agentId });
  const keys = new Set();
  for (const row of list(status?.skills)) {
    if (record(row.clawhub) && typeof row.clawhub.slug === "string" && row.clawhub.slug) keys.add(row.clawhub.slug);
    const folder = row.source === "openclaw-workspace" && typeof row.baseDir === "string" ? row.baseDir.split("/").pop() : "";
    if (folder) keys.add(folder);
  }
  return keys;
}

async function pluginResults(ctx     , query     ) {
  const answer      = await ctx.call("plugins.search", { query, limit: SEARCH_LIMIT });
  const installed = await installedPlugins(ctx);
  const rows      = [];
  for (const hit of list(Array.isArray(answer) ? answer : answer?.results)) {
    const pkg = record(hit.package) ? hit.package : null;
    const ref = safeRef(pkg?.name);
    if (!ref || rows.some((row     ) => row.ref === ref) || rows.length >= RESULT_LIMIT) continue;
    const runtimeId = safeRef(pkg.runtimeId);
    rows.push({
      ref,
      name: clean(pkg.displayName, NAME_LIMIT) || ref,
      summary: clean(pkg.summary, SUMMARY_LIMIT),
      version: safeVersion(pkg.latestVersion),
      trust: pluginTrust(pkg),
      installed: installed.keys.has(ref) || Boolean(runtimeId && installed.keys.has(runtimeId)),
      installable: installed.mutable && pkg.channel !== "private" &&
        (pkg.family === undefined || ["code-plugin", "bundle-plugin"].includes(pkg.family)),
      runtimeId,
    });
  }
  return rows;
}

async function skillResults(ctx     , query     , agentId     ) {
  const answer      = await ctx.call("skills.search", { query, limit: SEARCH_LIMIT });
  const installed = ctx.advertises("skills.status") ? await installedSkills(ctx, agentId) : new Set();
  const rows      = [];
  for (const hit of list(Array.isArray(answer) ? answer : answer?.results)) {
    const ref = safeRef(hit.installRef);
    const slug = typeof hit.slug === "string" && hit.slug ? hit.slug : skillSlug(ref);
    if (!ref || rows.some((row     ) => row.ref === ref) || rows.length >= RESULT_LIMIT) continue;
    rows.push({
      ref,
      name: clean(hit.displayName, NAME_LIMIT) || clean(slug, NAME_LIMIT) || ref,
      summary: clean(hit.summary, SUMMARY_LIMIT),
      version: safeVersion(hit.version),
      trust: skillTrust(hit),
      installed: installed.has(slug),
      installable: skillInstallable(hit),
      slug,
    });
  }
  return rows;
}

const shown = (row     ) => {
  const { runtimeId: _runtimeId, slug: _slug, ...rest } = row;
  return rest;
};

async function agentServed(env     , agentId     ) {
  if (!(await env.agents()).some((row     ) => row.id === agentId)) throw new OpenClawManagementError("profile_not_served");
}

async function search(env     , request     , kind     ) {
  const { ctx } = env;
  const query = request.clawhub.query;
  if (kind === "skill") await agentServed(env, request.profileId);
  let rows     ;
  try {
    rows = kind === "plugin" ? await pluginResults(ctx, query) : await skillResults(ctx, query, request.profileId);
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && ["unsupported", "rate_limited"].includes(error.code)) throw error;

    throw new OpenClawManagementError("native_read_failed");
  }
  return { status: "ok", clawhub: { search: { query, results: rows.map(shown) } } };
}

async function detail(env     , request     , kind     ) {
  const { ref, version } = request.clawhub;
  if (kind === "skill") await agentServed(env, request.profileId);
  try {
    let description     , publisher     , stats     , updatedAt     ;
    if (kind === "plugin") {

      const answer      = await env.ctx.call("plugins.catalog.get", {
        id: `ch_${btoa(ref).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`, ...(version ? { version } : {}),
      });
      if (answer?.detail?.origin !== "clawhub" || answer?.detail?.packageName !== ref || answer?.plugin?.catalog?.packageName !== ref)
        throw new OpenClawManagementError("native_read_failed");
      const catalog = answer.plugin.catalog;
      description = catalog.summary;
      publisher = answer.detail.author?.handle || answer.detail.author?.displayName || catalog.author;
      stats = { downloads: catalog.downloads, installs: catalog.installs };
      updatedAt = answer.detail.updatedAt;
    } else {

      if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(ref)) throw new OpenClawManagementError("unsupported");
      const answer      = await env.ctx.call("skills.detail", { slug: ref });
      const owner = ref.startsWith("@") ? ref.slice(1).split("/")[0] : "";
      if (answer?.skill?.slug !== skillSlug(ref) || (owner && answer?.owner?.handle !== owner))
        throw new OpenClawManagementError("native_read_failed");
      description = answer.skill.summary;
      publisher = answer.owner?.handle || answer.owner?.displayName;
      stats = answer.skill.stats;
      updatedAt = answer.skill.updatedAt;
    }
    const full = typeof description === "string" ? description.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
    const value      = { ref, version, description: full.slice(0, 16_000), descriptionTruncated: full.length > 16_000,
      publisher: clean(publisher, NAME_LIMIT) };
    for (const [key, raw] of Object.entries({ downloads: stats?.downloads, bookmarks: stats?.stars, installs: stats?.installs, updatedAt })) {
      if (Number.isSafeInteger(raw) && Number(raw) >= 0 && (key !== "updatedAt" || Number(raw) <= 8_640_000_000_000_000)) value[key] = raw;
    }
    return { status: "ok", clawhub: { detail: value } };
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && ["unsupported", "rate_limited"].includes(error.code)) throw error;
    throw new OpenClawManagementError("native_read_failed");
  }
}

function refusalCode(error     ) {
  const details = record(error.hostDetails) ? error.hostDetails : {};
  const message = typeof error.hostMessage === "string" ? error.hostMessage : "";
  const installCode = typeof details.pluginInstallCode === "string" ? details.pluginInstallCode : "";
  if (details.capabilityConsentCode || details.installPolicyCode) return "needs_review";
  if (details.clawhubTrustCode === "clawhub_download_blocked" || installCode === "security_scan_blocked" ||
    /security[_ ]scan[_ ]blocked|download blocked/i.test(message)) return "blocked";
  if (["package_not_found", "version_not_found", "no_installable_version"].includes(installCode)) return "not_found";
  if (/^(incompatible_|invalid_gateway_version|unknown_gateway_version)/.test(installCode)) return "incompatible";
  if (installCode === "config_mutation_blocked") return "managed_setting";
  if (/already exists|already installed/i.test(message)) return "already_installed";
  return "install_failed";
}

async function install(env     , request     , kind     ) {
  const { ctx } = env;
  const { ref, version } = request.clawhub;
  if (kind === "skill") await agentServed(env, request.profileId);

  const query = kind === "plugin" ? ref : skillSlug(ref);
  let rows     ;
  try {
    rows = kind === "plugin" ? await pluginResults(ctx, query) : await skillResults(ctx, query, request.profileId);
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && ["unsupported", "rate_limited"].includes(error.code)) throw error;
    throw new OpenClawManagementError("native_read_failed");
  }
  const row = rows.find((entry     ) => entry.ref === ref);
  if (!row) throw new OpenClawManagementError("not_found");
  if (row.installed) throw new OpenClawManagementError("already_installed");
  if (!row.installable) throw new OpenClawManagementError(kind === "skill" ? "blocked" : "managed_setting");

  const params = kind === "plugin"
    ? { source: "clawhub", packageName: ref, ...(version ? { version } : {}) }
    : { source: "clawhub", slug: ref, ...(version ? { version } : {}), agentId: request.profileId };
  let answer      = null;
  let refusal      = null;
  let answered = true;
  try {
    answer = await ctx.call(kind === "plugin" ? "plugins.install" : "skills.install", params);
  } catch (error     ) {
    if (!(error instanceof OpenClawManagementError) || ["unsupported", "rate_limited"].includes(error.code)) throw error;

    answered = Boolean(error.hostCode);
    refusal = answered ? refusalCode(error) : null;
  }
  const installedNow = async () => {
    if (kind === "plugin") {
      const { keys } = await installedPlugins(ctx);
      const pluginId = typeof answer?.plugin?.id === "string" ? answer.plugin.id : row.runtimeId;
      return keys.has(ref) || Boolean(pluginId && keys.has(pluginId));
    }
    return (await installedSkills(ctx, request.profileId)).has(row.slug);
  };
  let installed      = false;
  if (answered) {
    try {
      installed = await installedNow();
    } catch {
      throw new OpenClawManagementError("outcome_unknown");
    }
  } else {
    const until = Date.now() + clawhubTiming.settleMs;
    for (;;) {
      try {
        installed = await installedNow();
      } catch {
        installed = false;
      }
      if (installed || Date.now() >= until) break;
      await new Promise((resolve) => setTimeout(resolve, clawhubTiming.stepMs));
    }
  }
  if (!installed) {
    if (!answered) throw new OpenClawManagementError("outcome_unknown");
    if (refusal) throw new OpenClawManagementError(refusal);
  }
  const warnings = kind === "plugin"
    ? Array.isArray(answer?.warnings) && answer.warnings.some((entry     ) => typeof entry === "string" && entry.trim())
    : typeof answer?.warning === "string" && answer.warning.trim() !== "";
  return {
    status: "ok",
    clawhub: {
      done: {
        ref,
        outcome: installed ? "committed" : "not_applied",
        restartRequired: answer?.restartRequired === true,
        warned: Boolean(warnings),
      },
    },
  };
}

const clawhubSection = {
  id: "clawhub",
  operations: Object.keys(OPERATIONS).map((operation) => ({ operation, scope: "profile" })),
  supports(ctx     , operation     ) {
    const entry = OPERATIONS[operation];
    return Boolean(entry) && entry.methods.every((method     ) => ctx.advertises(method));
  },

  applyTiming: () => "active_now",
  async handle(env     , request     ) {
    const entry = OPERATIONS[request.operation];
    if (!entry || !record(request.clawhub)) throw new OpenClawManagementError("invalid_request");
    return entry.detail ? detail(env, request, entry.kind) : entry.read ? search(env, request, entry.kind) : install(env, request, entry.kind);
  },
};

module.exports = { clawhubTiming, clawhubSection };
