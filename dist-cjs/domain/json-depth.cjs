const RELAY_FRAME_MAX_JSON_DEPTH = 512;

function exceedsJsonDepth(value         , maxDepth        )          {
  if (value === null || typeof value !== "object") return false;
  const nodes           = [value          ];
  const depths           = [1];
  while (nodes.length > 0) {
    const node = nodes.pop()          ;
    const depth = depths.pop()          ;
    if (depth > maxDepth) return true;
    const children            = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        nodes.push(child          );
        depths.push(depth + 1);
      }
    }
  }
  return false;
}

function mayExceedJsonDepth(raw        , maxDepth        )          {
  return raw.length > 2 * maxDepth;
}

module.exports = { RELAY_FRAME_MAX_JSON_DEPTH, exceedsJsonDepth, mayExceedJsonDepth };
