function saveBundleToDisk(opts) {
  const { saveDir, bundleId, savedMs, zip, metadataJson, fs, path } = opts;
  const safeId = String(bundleId).replace(/[^A-Za-z0-9-]/g, "");
  const stamp = new Date(savedMs).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
  const base = stamp + "-" + safeId;

  fs.mkdirSync(saveDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(saveDir, 0o700);
  } catch {

  }
  const zipPath = path.join(saveDir, base + ".zip");
  fs.writeFileSync(zipPath, zip, { mode: 0o600 });
  fs.writeFileSync(path.join(saveDir, base + ".metadata.json"), metadataJson, { mode: 0o600 });
  return { savedPath: zipPath, fileSize: zip.length };
}

module.exports = { saveBundleToDisk };
