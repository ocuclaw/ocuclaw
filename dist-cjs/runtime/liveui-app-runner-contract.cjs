const LIVEUI_APP_V1_PLATFORM_FLOORS = Object.freeze({
  windows: Object.freeze({
    os: "Windows 11 24H2",
    build: "26100",
    arch: "x64",
  }),
  macos: Object.freeze({
    os: "macOS 14.0 Sonoma",
    arch: "arm64",
  }),
  linux: Object.freeze({
    os: "Ubuntu 22.04 LTS",
    libc: "glibc 2.35",
    arch: "x64",
  }),
});

const LIVEUI_APP_RUNTIME_KINDS = Object.freeze({
  node: Object.freeze({
    schema: true,
    candidate: true,
    v1: false,
    selectedIfGatePasses: true,
    managedBy: "host-process.execPath",
  }),
  python: Object.freeze({
    schema: true,
    candidate: false,
    v1: false,
    selectedIfGatePasses: false,
    managedBy: null,
  }),
});

const LIVEUI_APP_CANDIDATE_EXECUTION_PROFILE = Object.freeze({
  label: "Developer Preview — Full computer access",
  confinement: "none",
  globalOptInRequired: true,
  perReleaseApprovalRequired: true,
});

const LIVEUI_APP_DELIVERY_GATE = Object.freeze({
  status: "deferred",
  executableBundlesEnabled: false,
  blockers: Object.freeze(["scanner_critical", "exact_floors_unproven"]),
});

module.exports = { LIVEUI_APP_V1_PLATFORM_FLOORS, LIVEUI_APP_RUNTIME_KINDS, LIVEUI_APP_CANDIDATE_EXECUTION_PROFILE, LIVEUI_APP_DELIVERY_GATE };
