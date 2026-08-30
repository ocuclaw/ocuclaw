const { canonicalizeRelayAddressV1 } = require("./relay-address.cjs");

const PAIRING_ENDPOINT_PATH = "/_ocuclaw/pair/v1";

const PAIRING_ENDPOINT_CONTENT_TYPE = "application/json";

const PAIRING_MAX_REQUEST_BODY_BYTES = 4096;

const PAIRING_CONTROL_MAX_REQUEST_BODY_BYTES = 4096;

function pairingEndpointUrlForRelayAddress(canonicalAddress        )                {
  const prefix = "wss://";
  if (typeof canonicalAddress !== "string" || !canonicalAddress.startsWith(prefix)) {
    return null;
  }

  const checked = canonicalizeRelayAddressV1(canonicalAddress);
  if (!checked.ok) return null;

  if (checked.address !== canonicalAddress) return null;
  const authority = checked.address.slice(prefix.length);
  return `https://${authority}${PAIRING_ENDPOINT_PATH}`;
}

function isPairingEndpointPath(pathname        )          {
  return pathname === PAIRING_ENDPOINT_PATH;
}

const PAIRING_CONTROL_PATH = "/_ocuclaw/pair/control/v1";

function isPairingControlPath(pathname        )          {
  return pathname === PAIRING_CONTROL_PATH;
}

module.exports = { PAIRING_ENDPOINT_PATH, PAIRING_ENDPOINT_CONTENT_TYPE, PAIRING_MAX_REQUEST_BODY_BYTES, PAIRING_CONTROL_PATH, PAIRING_CONTROL_MAX_REQUEST_BODY_BYTES, pairingEndpointUrlForRelayAddress, isPairingEndpointPath, isPairingControlPath };
