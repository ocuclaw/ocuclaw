function healthSummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const token = (value) => typeof value === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(value) ? value : '';
  const input = Array.isArray(source.healthFindings) ? source.healthFindings
    : typeof source.healthFindings === 'string' ? source.healthFindings.slice(0, 4096).split(',') : [];
  const codes = [...new Set(input.slice(0, 64).filter((value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)))].slice(0, 16);
  return {
    healthFindings: codes.join(','),
    runningPluginVersion: token(source.runningPluginVersion),
    installedPluginVersion: token(source.installedPluginVersion),
  };
}

function snapshotHealthSummary(snapshot) {
  const findings = Array.isArray(snapshot?.findings) ? snapshot.findings.slice(0, 64) : [];
  const mismatch = findings.find((f) => f?.code === 'ocuclaw_running_version_mismatch' || f?.code === 'ocuclaw_shadow_plugin_copy');
  return healthSummary({
    healthFindings: findings.map((f) => f?.code),
    runningPluginVersion: snapshot?.producer?.ocuclawVersion,
    installedPluginVersion: mismatch?.repair?.parameters?.installedVersion,
  });
}

module.exports = { healthSummary, snapshotHealthSummary };
