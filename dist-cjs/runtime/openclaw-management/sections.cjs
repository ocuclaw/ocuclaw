const { overviewSection } = require("./overview.cjs");
const { healthSection } = require("./health.cjs");
const { jobsSection } = require("./jobs.cjs");
const { approvalsSection } = require("./approvals.cjs");
const { skillsSection } = require("./skills.cjs");
const { connectionsSection } = require("./connections.cjs");
const { pluginsSection } = require("./plugins.cjs");
const { clawhubSection } = require("./clawhub.cjs");
const { memorySection } = require("./memory.cjs");
const { skillProposalsSection } = require("./skill-proposals.cjs");
const { dreamingSection } = require("./dreaming.cjs");
const { modelsSection } = require("./models.cjs");
const { heartbeatSection } = require("./heartbeat.cjs");
const { maintenanceSection } = require("./maintenance.cjs");

const OPENCLAW_MANAGEMENT_SECTIONS = [
  overviewSection,
  healthSection,
  jobsSection,
  approvalsSection,
  skillsSection,
  connectionsSection,
  pluginsSection,
  clawhubSection,
  memorySection,
  skillProposalsSection,
  dreamingSection,
  modelsSection,
  heartbeatSection,
  maintenanceSection,
];

module.exports = { OPENCLAW_MANAGEMENT_SECTIONS };
