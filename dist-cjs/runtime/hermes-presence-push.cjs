const LINK_PRESENCE_DIRTY_METHOD = "presence.dirty";
const LINK_PRESENCE_SNAPSHOT_METHOD = "presence.snapshot";

const UNOBSERVABLE_PROJECTION = {
  relayListening: null,
  authenticatedAppCount: null,
  clientVersions: [],
  lastTransitionAt: null,
};

const CLIENT_VERSION_MAX_CHARS = 32;
const CLIENT_VERSION_MAX_COUNT = 8;
const CLIENT_VERSION_CHARSET = /^[A-Za-z0-9._+-]+$/;

function boundClientVersions(value) {
  if (!Array.isArray(value)) return [];
  const bounded = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > CLIENT_VERSION_MAX_CHARS) continue;
    if (!CLIENT_VERSION_CHARSET.test(trimmed)) continue;
    if (bounded.includes(trimmed)) continue;
    bounded.push(trimmed);
    if (bounded.length >= CLIENT_VERSION_MAX_COUNT) break;
  }
  return bounded;
}

function createHermesPresencePush({ relay, link, logger }) {
  let revision = 0;
  let disposed = false;

  function warn(err) {
    if (!logger || typeof logger.warn !== "function") return;
    logger.warn(
      `[hermes-presence] push failed: ${err && err.message ? err.message : err}`,
    );
  }

  function push() {
    if (disposed) return null;
    revision += 1;
    const rev = revision;
    try {
      const pending = link.request(LINK_PRESENCE_DIRTY_METHOD, { rev });
      if (pending && typeof pending.catch === "function") pending.catch(warn);
      return rev;
    } catch (err) {

      warn(err);
      return rev;
    }
  }

  function projection() {
    if (!relay || typeof relay.getAppPresenceProjection !== "function") {
      return { ...UNOBSERVABLE_PROJECTION };
    }
    let value = null;
    try {
      value = relay.getAppPresenceProjection();
    } catch (err) {
      warn(err);
      return { ...UNOBSERVABLE_PROJECTION };
    }
    if (!value || typeof value !== "object") return { ...UNOBSERVABLE_PROJECTION };

    if (
      !(value.relayListening === null || typeof value.relayListening === "boolean") ||
      !(
        value.authenticatedAppCount === null ||
        Number.isInteger(value.authenticatedAppCount)
      ) ||
      !Array.isArray(value.clientVersions) ||
      !(
        value.lastTransitionAt === null ||
        typeof value.lastTransitionAt === "string"
      )
    ) {
      return { ...UNOBSERVABLE_PROJECTION };
    }
    return {
      relayListening: value.relayListening,
      authenticatedAppCount: value.authenticatedAppCount,
      clientVersions: boundClientVersions(value.clientVersions),
      lastTransitionAt: value.lastTransitionAt || null,
    };
  }

  const unsubscribe =
    relay && typeof relay.onAppPresenceChanged === "function"
      ? relay.onAppPresenceChanged(() => {
          push();
        })
      : () => {};

  const methods = {};
  methods[LINK_PRESENCE_SNAPSHOT_METHOD] = () => projection();

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch (err) {
      warn(err);
    }
  }

  return {
    methods,
    push,
    projection,
    dispose,
    getRevision: () => revision,
  };
}

module.exports = { createHermesPresencePush, LINK_PRESENCE_DIRTY_METHOD, LINK_PRESENCE_SNAPSHOT_METHOD };
