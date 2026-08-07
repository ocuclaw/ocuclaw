function createSseParser() {
  let buffer = "";
  let curId = null;
  let curData = [];

  function reset() {
    curId = null;
    curData = [];
  }

  function push(chunk) {
    buffer += chunk;
    const events = [];
    let nlIndex;
    while ((nlIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIndex).replace(/\r$/, "");
      buffer = buffer.slice(nlIndex + 1);
      if (line === "") {
        if (curData.length > 0 || curId !== null) {
          events.push({ id: curId, data: curData.join("\n") });
        }
        reset();
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") {
        const n = parseInt(value, 10);
        curId = Number.isFinite(n) ? n : null;
      } else if (field === "data") {
        curData.push(value);
      }
    }
    return events;
  }

  return { push };
}

module.exports = { createSseParser };
