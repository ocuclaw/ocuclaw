const { createHash } = require("node:crypto");

const fs = require("node:fs");

const path = require("node:path");
const { resolveLiveuiLibraryRoot } = require("../tools/glasses-ui-library.cjs");

const PROGRAM_CARD_VISION_DIRECTORY = "program-card-vision-v1";
const CARRIERS      = { openclaw: "openclaw.runtime.llm.complete", hermes: "hermes.ctx.llm" };
const HASH = /^[a-f0-9]{64}$/;

function programCardReviewImageIdentity(host     , value     )      {
  if (!Object.prototype.hasOwnProperty.call(CARRIERS, host) || !value || typeof value !== "object") return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  let model = typeof value.model === "string" ? value.model.trim() : "";
  if (!provider || provider.length > 160 || !model || model.length > 160 || /\s/.test(provider + model)) return null;
  if (model.startsWith(`${provider}/`)) model = model.slice(provider.length + 1);
  if (!model) return null;
  return { host, provider, model, carrier: CARRIERS[host], input: Array.isArray(value.modelInput) ? value.modelInput : Array.isArray(value.input) ? value.input : [] };
}

function sameIdentity(a     , b     ) {
  return a && b && a.host === b.host && a.provider === b.provider && a.model === b.model && a.carrier === b.carrier;
}

function certified(receipt     , identity     ) {
  const actual = programCardReviewImageIdentity(receipt?.host, receipt);
  const hostCanary = receipt?.evidence === "HOST_CANARY";
  return sameIdentity(actual, identity) && receipt.carrier === identity.carrier &&
    receipt.version === 1 &&
    (receipt.evidence === "REAL_MODEL" || hostCanary) && receipt.scripted === false && receipt.visualReviewEligible === true &&
    Array.isArray(receipt.modelInput) && receipt.modelInput.includes("image") &&
    typeof receipt.positive === "string" && /^\d{4}$/.test(receipt.positive) && receipt.positive === receipt.oracle &&
    typeof receipt.negative === "string" && receipt.negative.length <= 300 && !receipt.negative.includes(receipt.oracle) &&
    ["imageSha256", "positiveRequestSha256", "negativeRequestSha256", "transportReceiptSha256"].every(key => HASH.test(receipt[key])) &&
    (hostCanary ? receipt.candidateSha === undefined && receipt.pet === undefined
      : /^[a-f0-9]{40}$/.test(receipt.candidateSha) && typeof receipt.pet === "string" && receipt.pet.length > 0 && receipt.pet.length <= 80) &&
    typeof receipt.probeId === "string" && receipt.probeId.length > 0 && receipt.probeId.length <= 160 &&
    (receipt.hostVersion === undefined || (typeof receipt.hostVersion === "string" && receipt.hostVersion.length <= 200)) &&
    (receipt.probe === undefined || (typeof receipt.probe === "string" && receipt.probe.length <= 40)) &&
    typeof receipt.verifiedAt === "string" && receipt.verifiedAt.length <= 40 && Number.isFinite(Date.parse(receipt.verifiedAt));
}

function createProgramCardVisualReviewRegistry(options      = {}) {
  const root = path.join(resolveLiveuiLibraryRoot(options.libraryDir), PROGRAM_CARD_VISION_DIRECTORY);
  const file = (identity     ) => path.join(root, `${createHash("sha256").update(JSON.stringify([identity.host, identity.provider, identity.model, identity.carrier])).digest("hex")}.json`);
  return {
    qualify(host        , model     ) {
      const identity = programCardReviewImageIdentity(host, model);
      if (!identity) return { qualified: false, reason: "review model identity is unknown" };
      if (!identity.input.includes("image")) return { qualified: false, reason: `${identity.provider}/${identity.model} input does not include image` };
      try {
        const bytes = fs.readFileSync(file(identity), "utf8");
        if (bytes.length > 16_384) return { qualified: false, reason: "visual certificate is invalid" };
        const receipt = JSON.parse(bytes);
        if (certified(receipt, identity)) return { qualified: true, identity, receipt };
      } catch {  }
      return { qualified: false, reason: `no passing ${identity.carrier} canary for ${identity.provider}/${identity.model}` };
    },
    record(receipt     ) {
      const identity = programCardReviewImageIdentity(receipt?.host, receipt);
      if (!identity || !certified(receipt, identity)) return { ok: false, error: "visual_certificate_invalid" };
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const target = file(identity), temporary = `${target}.${Date.now()}.tmp`;
      const kept      = {};
      for (const key of ["version", "evidence", "scripted", "host", "provider", "model", "carrier", "candidateSha", "pet", "probeId", "probe", "modelInput", "imageSha256", "positiveRequestSha256", "negativeRequestSha256", "transportReceiptSha256", "positive", "negative", "oracle", "visualReviewEligible", "hostVersion", "verifiedAt"]) kept[key] = receipt[key];
      fs.writeFileSync(temporary, JSON.stringify(kept) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
      return { ok: true, host: identity.host, provider: identity.provider, model: identity.model, carrier: identity.carrier };
    },
    revoke(host        , model     ) {
      const identity = programCardReviewImageIdentity(host, model);
      if (!identity) return { ok: false, error: "visual_identity_invalid" };
      try { fs.unlinkSync(file(identity)); } catch (error     ) { if (error?.code !== "ENOENT") throw error; }
      return { ok: true, revoked: true };
    },
  };
}

function sameProgramCardReviewImageIdentity(host        , before     , after     ) {
  return sameIdentity(programCardReviewImageIdentity(host, before), programCardReviewImageIdentity(host, after));
}

module.exports = { PROGRAM_CARD_VISION_DIRECTORY, programCardReviewImageIdentity, createProgramCardVisualReviewRegistry, sameProgramCardReviewImageIdentity };
