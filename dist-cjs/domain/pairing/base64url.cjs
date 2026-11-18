function toBase64Url(bytes            )         {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]          );
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value         , maxEncodedLength        )                    {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > maxEncodedLength) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  if (value.length % 4 === 1) return null;
  let bytes            ;
  try {
    bytes = new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
  return toBase64Url(bytes) === value ? bytes : null;
}

function fromCanonicalBase64Url32(value         )                    {
  if (typeof value !== "string" || value.length !== 43) return null;
  const bytes = fromBase64Url(value, 43);
  return bytes && bytes.length === 32 ? bytes : null;
}

module.exports = { toBase64Url, fromBase64Url, fromCanonicalBase64Url32 };
