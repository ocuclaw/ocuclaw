function normalizeAgentAppearance(raw     )                                                         {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const shape = raw.shape;
  const color = raw.color;
  if (typeof shape !== "string" || shape.length > 96 || typeof color !== "string" || color.length > 64) return null;
  const classic = /^(circle|squircle|pill|triangle|hexagon|cloud|drop|blob|tetrahedron|cube|octahedron|dodecahedron|icosahedron|pebble|teardrop|wedge|hex|sigil-[0-9]{1,4})$/;
  const blob = /^blobatar(?::[a-zA-Z0-9_-]{0,64}(?::(?:round|organic|boxy|capsule|nub|cloud|droplet|hexagon|sun|triangle))?)?$/;
  if (!classic.test(shape) && !blob.test(shape)) return null;
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color) &&
      !/^hsl\([0-9]{1,3}(?:\.[0-9]+)? [0-9]{1,3}(?:\.[0-9]+)?% [0-9]{1,3}(?:\.[0-9]+)?%\)$/.test(color)) return null;
  const name = typeof raw.name === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.name) ? raw.name : null;
  return { shape, color, ...(name ? { name } : {}) };
}

module.exports = { normalizeAgentAppearance };
