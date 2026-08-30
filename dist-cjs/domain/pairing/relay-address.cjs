const MAX_RELAY_ADDRESS_LENGTH = 255;

const SCHEME = "wss://";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const MESSAGES                                        = {
  empty: "The relay address is empty.",
  "too-long": `The relay address must be at most ${MAX_RELAY_ADDRESS_LENGTH} characters.`,
  "non-ascii":
    "The relay address contains characters that are not plain text. Retype it rather than pasting it.",
  "not-wss": "The relay address must start with wss://.",
  "contains-userinfo":
    "The relay address must not contain a username or password before the host.",
  "contains-query":
    "The relay address must not contain a ? query — pairing never carries a token in a URL.",
  "contains-fragment": "The relay address must not contain a # fragment.",
  "contains-percent-escape":
    "The relay address must not contain % escapes. Type the address literally.",
  "empty-host": "The relay address has no host name.",
  "trailing-dot-host":
    "The relay address host ends with a dot. Remove the trailing dot — it prevents a secure connection.",
  "invalid-host": "The relay address host contains characters that are not allowed.",
  "ipv6-not-supported":
    "This version of pairing does not support IPv6 literal addresses. Use a host name or an IPv4 address.",
  "port-required": "The relay address must include an explicit port, for example wss://host:8443.",
  "invalid-port": "The relay address port must be a number between 1 and 65535.",
  "invalid-path": "The relay address must not contain a path.",
  "not-canonical": "The relay address could not be reduced to a stable canonical form.",
};

function reject(rejection                       )                    {
  return { ok: false, rejection, message: MESSAGES[rejection] };
}

function canonicalIPv4(host        )                {
  const octets = host.split(".");
  if (octets.length !== 4) return null;
  for (const octet of octets) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(octet)) return null;
    if (Number(octet) > 255) return null;
  }
  return octets.join(".");
}

function isValidDnsHost(host        )          {
  if (host.length > 253) return false;
  if (/^[0-9.]+$/.test(host)) return false;
  const labels = host.split(".");

  const finalLabel = labels[labels.length - 1] ?? "";
  if (/^([0-9]+|0[xX][0-9a-fA-F]*)$/.test(finalLabel)) return false;

  if (labels.some((label) => /^..--/.test(label))) return false;
  return labels.every((label) => DNS_LABEL.test(label));
}

function parse(value        )                    {
  if (typeof value !== "string" || value.length === 0) return reject("empty");
  if (value.length > MAX_RELAY_ADDRESS_LENGTH) return reject("too-long");

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return reject("non-ascii");
  }

  if (!value.startsWith(SCHEME)) return reject("not-wss");

  const rest = value.slice(SCHEME.length);
  if (rest.includes("#")) return reject("contains-fragment");
  if (rest.includes("?")) return reject("contains-query");
  if (rest.includes("@")) return reject("contains-userinfo");
  if (rest.includes("%")) return reject("contains-percent-escape");

  const slashAt = rest.indexOf("/");
  const authority = slashAt === -1 ? rest : rest.slice(0, slashAt);
  const path = slashAt === -1 ? "" : rest.slice(slashAt);
  if (authority.length === 0) return reject("empty-host");

  if (path !== "" && path !== "/") return reject("invalid-path");

  if (authority.startsWith("[") || authority.includes("]")) {
    return reject("ipv6-not-supported");
  }

  const colon = authority.lastIndexOf(":");
  if (colon === -1) return reject("port-required");
  const rawHost = authority.slice(0, colon);
  const rawPort = authority.slice(colon + 1);
  if (rawHost.length === 0) return reject("empty-host");

  if (rawPort.length === 0) return reject("port-required");

  if (rawHost.endsWith(".")) return reject("trailing-dot-host");

  if (!/^[0-9]+$/.test(rawPort)) return reject("invalid-port");
  const normalizedPort = rawPort.replace(/^0+(?=[0-9])/, "");
  if (normalizedPort.length > 5) return reject("invalid-port");
  const port = Number(normalizedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return reject("invalid-port");

  let host        ;
  const ipv4 = canonicalIPv4(rawHost);
  if (ipv4 !== null) {
    host = ipv4;
  } else if (/^[0-9.]+$/.test(rawHost)) {

    return reject("invalid-host");
  } else {

    host = rawHost.toLowerCase();
    if (!isValidDnsHost(host)) return reject("invalid-host");
  }

  return { ok: true, address: `${SCHEME}${host}:${port}` };
}

function canonicalizeRelayAddressV1(value         )                    {
  const first = parse(value          );
  if (!first.ok) return first;

  const second = parse(first.address);
  if (!second.ok || second.address !== first.address) return reject("not-canonical");
  return first;
}

module.exports = { MAX_RELAY_ADDRESS_LENGTH, canonicalizeRelayAddressV1 };
