const { BlockList, isIP } = require("node:net");
const { canonicalizeRelayAddressV1 } = require("../pairing/relay-address.cjs");

const CUSTOM_ROUTE_CHECKS = Object.freeze([
  "address",
  "cloudways",
  "loopback",
  "dns",
  "private",
  "tcp",
  "tls",
  "probe",
]         );

const CUSTOM_ROUTE_PRIVATE_RANGES = Object.freeze([
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
]);

let privateBlockList                   = null;

function privateRanges()            {
  if (privateBlockList) return privateBlockList;
  const list = new BlockList();
  for (const range of CUSTOM_ROUTE_PRIVATE_RANGES) {
    const [network, prefix] = range.split("/");
    list.addSubnet(network          , Number(prefix), (network          ).includes(":") ? "ipv6" : "ipv4");
  }
  privateBlockList = list;
  return list;
}

function isCustomRoutePrivateIp(ip         )          {
  if (typeof ip !== "string" || ip.includes("%")) return false;
  const family = isIP(ip);
  if (family === 0) return false;

  return privateRanges().check(ip.toLowerCase(), family === 6 ? "ipv6" : "ipv4");
}

function result(
  verdict                    ,
  check                           ,
  reason               ,
  address               ,
)                    {
  return { verdict, check, reason, address };
}

function evaluateCustomRoute(observations                         )                    {
  const canonical = canonicalizeRelayAddressV1(observations.address);
  if (!canonical.ok) return result("wrong", "address", canonical.rejection, null);
  const address = canonical.address;

  if (observations.cloudways === true) return result("wrong", "cloudways", "cloudways-host", address);

  if (observations.loopbackRelay !== "ok") return result("wrong", "loopback", "relay-not-answering", address);

  const host = address.slice("wss://".length, address.lastIndexOf(":"));
  let resolved                   ;
  if (isIP(host) === 4) {
    resolved = [host];
  } else if (
    observations.resolve &&
    observations.resolve.ok === true &&
    Array.isArray(observations.resolve.addresses) &&
    observations.resolve.addresses.length > 0
  ) {
    resolved = observations.resolve.addresses;
  } else {
    return result("unverified", "dns", "name-not-resolved", address);
  }

  if (!resolved.every(isCustomRoutePrivateIp)) return result("wrong", "private", "not-private", address);

  if (observations.tcp !== "ok") return result("unverified", "tcp", "connect-failed", address);

  if (observations.tls !== "ok") return result("wrong", "tls", "certificate-rejected", address);

  switch (observations.probe) {
    case "match":
      return result("ready", null, null, address);
    case "mismatch":
      return result("wrong", "probe", "other-relay", address);
    case "rate_limited":
      return result("unverified", "probe", "probe-rate-limited", address);
    case "no_answer":
      return result("unverified", "probe", "probe-no-answer", address);
    default:
      return result("wrong", "probe", "not-relay", address);
  }
}

module.exports = { CUSTOM_ROUTE_CHECKS, CUSTOM_ROUTE_PRIVATE_RANGES, isCustomRoutePrivateIp, evaluateCustomRoute };
