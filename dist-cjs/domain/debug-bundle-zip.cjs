const { zipSync, strToU8 } = require("fflate");
const { createHash } = require("node:crypto");

function zipFiles(files) {
  const entries = {};
  for (const [name, content] of files) {
    entries[name] = typeof content === "string" ? strToU8(content) : content;
  }

  return zipSync(entries, { mtime: new Date(1980, 0, 1) });
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

module.exports = { zipFiles, sha256Hex };
