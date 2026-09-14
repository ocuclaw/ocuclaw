function projectSessionDriverFields(s = {}) {
  return {
    sessionKey: typeof s.sessionKey === "string" ? s.sessionKey : null,
    state: typeof s.state === "string" ? s.state : "glasses_drive",
    locked: s.locked === true,
    armed: s.armed !== false,
    takeOver: s.takeOver === true,
    uncertain: s.uncertain === true,
    takeOverAllowed: s.takeOverAllowed === true,
    holdGeneration: typeof s.holdGeneration === "string" ? s.holdGeneration : null,
    holdState: typeof s.holdState === "string" ? s.holdState : null,
    holdSurface: typeof s.holdSurface === "string" ? s.holdSurface : null,
    inflight: s.inflight === true,
    inflightPlatform: typeof s.inflightPlatform === "string" ? s.inflightPlatform : null,
  };
}

module.exports = { projectSessionDriverFields };
