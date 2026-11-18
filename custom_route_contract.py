"""The custom route contract (#5207), in Python: one rule both backends share.

This is a line-for-line mirror of three TypeScript modules in
``extensions/ocuclaw``:

* ``src/domain/custom-route/route-probe.ts`` — the probe nonce check, the
  probe key derivation, the probe MAC and the constant-time answer match;
* ``src/domain/custom-route/custom-route-check.ts`` — the private-range test
  and the ordered ``ready | unverified | wrong`` verdict;
* ``src/domain/pairing/relay-address.ts`` — the frozen Q20 relay address
  grammar the verdict's first check runs.

The two runtimes must agree byte for byte: the canonical address is bound into
the pairing safety phrase, and the probe MAC is computed by the relay on one
side and checked by the host on the other. ``tests/fixtures/custom-route-
vectors.json`` pins both implementations; change neither without the other.

Standard library only. Every function is total: none raises on bad input,
except ``derive_route_probe_key`` on a missing credential, as in TypeScript.
JavaScript string semantics (UTF-16 lengths, ASCII-only regex classes) are
reproduced where they change an answer.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re

# --------------------------------------------------------------------------
# The route probe
# --------------------------------------------------------------------------

ROUTE_PROBE_PATH = "/_ocuclaw/route-probe/v1"
ROUTE_PROBE_NONCE_PARAM = "n"
ROUTE_PROBE_NONCE_MIN_LENGTH = 16
ROUTE_PROBE_NONCE_MAX_LENGTH = 128
ROUTE_PROBE_KEY_LABEL = "ocuclaw route-probe key v1"
ROUTE_PROBE_MAC_LABEL = "ocuclaw route-probe v1\n"

_NONCE_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
_ANSWER_PATTERN = re.compile(r"[0-9a-f]{64}")


def _js_length(value: str) -> int:
    """``String.prototype.length``: UTF-16 code units, not code points."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _js_utf8(value: str) -> bytes:
    """``Buffer.from(value, "utf8")``: a lone surrogate becomes U+FFFD."""
    units = value.encode("utf-16-le", "surrogatepass")
    return units.decode("utf-16-le", "replace").encode("utf-8")


def check_route_probe_nonce(value: object) -> dict:
    """Validate a probe nonce, in the same order as ``checkRouteProbeNonce``."""
    if value is None:
        return {"ok": False, "rejection": "missing"}
    if not isinstance(value, str):
        return {"ok": False, "rejection": "invalid-characters"}
    length = _js_length(value)
    if length == 0:
        return {"ok": False, "rejection": "empty"}
    if length > ROUTE_PROBE_NONCE_MAX_LENGTH:
        return {"ok": False, "rejection": "too-long"}
    if not _NONCE_PATTERN.fullmatch(value):
        return {"ok": False, "rejection": "invalid-characters"}
    if length < ROUTE_PROBE_NONCE_MIN_LENGTH:
        return {"ok": False, "rejection": "too-short"}
    return {"ok": True, "nonce": value}


def derive_route_probe_key(credential: str) -> bytes:
    """The probe key. Never log or return it."""
    if not isinstance(credential, str) or credential == "":
        raise ValueError("route probe needs a Relay Credential")
    return hmac.new(
        _js_utf8(credential), ROUTE_PROBE_KEY_LABEL.encode("utf-8"), hashlib.sha256
    ).digest()


def route_probe_mac(credential: str, nonce: str) -> str:
    """The probe answer for one nonce, as lowercase hex. Validate the nonce first."""
    return hmac.new(
        derive_route_probe_key(credential),
        _js_utf8(ROUTE_PROBE_MAC_LABEL + nonce),
        hashlib.sha256,
    ).hexdigest()


def route_probe_answer_matches(credential: str, nonce: str, answer: object) -> bool:
    """Host side: does an answer prove this relay? Constant time."""
    if not isinstance(answer, str) or not _ANSWER_PATTERN.fullmatch(answer):
        return False
    return hmac.compare_digest(route_probe_mac(credential, nonce), answer)


# --------------------------------------------------------------------------
# The Q20 relay address grammar
# --------------------------------------------------------------------------

MAX_RELAY_ADDRESS_LENGTH = 255

_SCHEME = "wss://"
_DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_DIGITS = re.compile(r"[0-9]+")
_DIGITS_AND_DOTS = re.compile(r"[0-9.]+")
_IPV4_OCTET = re.compile(r"0|[1-9][0-9]{0,2}")
_NUMERIC_LABEL = re.compile(r"[0-9]+|0[xX][0-9a-fA-F]*")
_RESERVED_LABEL = re.compile(r"..--")
_LEADING_PORT_ZEROES = re.compile(r"^0+(?=[0-9])")

_MESSAGES = {
    "empty": "The relay address is empty.",
    "too-long": f"The relay address must be at most {MAX_RELAY_ADDRESS_LENGTH} characters.",
    "non-ascii": (
        "The relay address contains characters that are not plain text. "
        "Retype it rather than pasting it."
    ),
    "not-wss": "The relay address must start with wss://.",
    "contains-userinfo": (
        "The relay address must not contain a username or password before the host."
    ),
    "contains-query": (
        "The relay address must not contain a ? query — pairing never carries a token in a URL."
    ),
    "contains-fragment": "The relay address must not contain a # fragment.",
    "contains-percent-escape": (
        "The relay address must not contain % escapes. Type the address literally."
    ),
    "empty-host": "The relay address has no host name.",
    "trailing-dot-host": (
        "The relay address host ends with a dot. Remove the trailing dot — "
        "it prevents a secure connection."
    ),
    "invalid-host": "The relay address host contains characters that are not allowed.",
    "ipv6-not-supported": (
        "This version of pairing does not support IPv6 literal addresses. "
        "Use a host name or an IPv4 address."
    ),
    "port-required": (
        "The relay address must include an explicit port, for example wss://host:8443."
    ),
    "invalid-port": "The relay address port must be a number between 1 and 65535.",
    "invalid-path": "The relay address must not contain a path.",
    "not-canonical": "The relay address could not be reduced to a stable canonical form.",
}


def _reject(rejection: str) -> dict:
    return {"ok": False, "rejection": rejection, "message": _MESSAGES[rejection]}


def _canonical_ipv4(host: str) -> str | None:
    octets = host.split(".")
    if len(octets) != 4:
        return None
    for octet in octets:
        if not _IPV4_OCTET.fullmatch(octet) or int(octet) > 255:
            return None
    return ".".join(octets)


def _is_valid_dns_host(host: str) -> bool:
    if len(host) > 253:
        return False
    if _DIGITS_AND_DOTS.fullmatch(host):
        return False
    labels = host.split(".")
    if _NUMERIC_LABEL.fullmatch(labels[-1]):
        return False
    if any(_RESERVED_LABEL.match(label) for label in labels):
        return False
    return all(_DNS_LABEL.fullmatch(label) for label in labels)


def _parse(value: object) -> dict:
    if not isinstance(value, str) or value == "":
        return _reject("empty")
    if _js_length(value) > MAX_RELAY_ADDRESS_LENGTH:
        return _reject("too-long")
    if any(not 0x21 <= ord(char) <= 0x7E for char in value):
        return _reject("non-ascii")
    if not value.startswith(_SCHEME):
        return _reject("not-wss")

    rest = value[len(_SCHEME):]
    if "#" in rest:
        return _reject("contains-fragment")
    if "?" in rest:
        return _reject("contains-query")
    if "@" in rest:
        return _reject("contains-userinfo")
    if "%" in rest:
        return _reject("contains-percent-escape")

    slash_at = rest.find("/")
    authority = rest if slash_at == -1 else rest[:slash_at]
    path = "" if slash_at == -1 else rest[slash_at:]
    if authority == "":
        return _reject("empty-host")
    if path not in ("", "/"):
        return _reject("invalid-path")

    if authority.startswith("[") or "]" in authority:
        return _reject("ipv6-not-supported")

    colon = authority.rfind(":")
    if colon == -1:
        return _reject("port-required")
    raw_host = authority[:colon]
    raw_port = authority[colon + 1:]
    if raw_host == "":
        return _reject("empty-host")
    if raw_port == "":
        return _reject("port-required")

    if raw_host.endswith("."):
        return _reject("trailing-dot-host")

    if not _DIGITS.fullmatch(raw_port):
        return _reject("invalid-port")
    normalized_port = _LEADING_PORT_ZEROES.sub("", raw_port)
    if len(normalized_port) > 5:
        return _reject("invalid-port")
    port = int(normalized_port)
    if port < 1 or port > 65535:
        return _reject("invalid-port")

    ipv4 = _canonical_ipv4(raw_host)
    if ipv4 is not None:
        host = ipv4
    elif _DIGITS_AND_DOTS.fullmatch(raw_host):
        return _reject("invalid-host")
    else:
        host = raw_host.lower()
        if not _is_valid_dns_host(host):
            return _reject("invalid-host")

    return {"ok": True, "address": f"{_SCHEME}{host}:{port}"}


def canonicalize_relay_address_v1(value: object) -> dict:
    """Canonicalize a relay address to the frozen v1 form, or say why not."""
    first = _parse(value)
    if not first["ok"]:
        return first
    second = _parse(first["address"])
    if not second["ok"] or second["address"] != first["address"]:
        return _reject("not-canonical")
    return first


# --------------------------------------------------------------------------
# The custom route verdict
# --------------------------------------------------------------------------

CUSTOM_ROUTE_CHECKS = (
    "address",
    "cloudways",
    "loopback",
    "dns",
    "private",
    "tcp",
    "tls",
    "probe",
)

CUSTOM_ROUTE_PRIVATE_RANGES = (
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "fc00::/7",
)

_PRIVATE_NETWORKS = tuple(ipaddress.ip_network(r) for r in CUSTOM_ROUTE_PRIVATE_RANGES)


def is_custom_route_private_ip(ip: object) -> bool:
    """Is one resolved address inside the private ranges?

    An IPv4-mapped IPv6 address is judged by its IPv4 part. A zone ID, leading
    zeroes or a name is never private.
    """
    if not isinstance(ip, str) or "%" in ip:
        return False
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        parsed = parsed.ipv4_mapped
    return any(parsed in network for network in _PRIVATE_NETWORKS)


def _is_ipv4_literal(host: str) -> bool:
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        return False
    return True


def _result(verdict: str, check: str | None, reason: str | None, address: str | None) -> dict:
    return {"verdict": verdict, "check": check, "reason": reason, "address": address}


_PROBE_RESULTS = {
    "match": ("ready", None, None),
    "mismatch": ("wrong", "probe", "other-relay"),
    "rate_limited": ("unverified", "probe", "probe-rate-limited"),
    "no_answer": ("unverified", "probe", "probe-no-answer"),
}


def evaluate_custom_route(observations: dict) -> dict:
    """Run the checks in order over what the host observed; the first failure decides."""
    canonical = canonicalize_relay_address_v1(observations.get("address"))
    if not canonical["ok"]:
        return _result("wrong", "address", canonical["rejection"], None)
    address = canonical["address"]

    if observations.get("cloudways") is True:
        return _result("wrong", "cloudways", "cloudways-host", address)

    if observations.get("loopbackRelay") != "ok":
        return _result("wrong", "loopback", "relay-not-answering", address)

    host = address[len(_SCHEME):address.rindex(":")]
    resolve = observations.get("resolve")
    if _is_ipv4_literal(host):
        resolved = [host]
    elif (
        isinstance(resolve, dict)
        and resolve.get("ok") is True
        and isinstance(resolve.get("addresses"), (list, tuple))
        and len(resolve["addresses"]) > 0
    ):
        resolved = resolve["addresses"]
    else:
        return _result("unverified", "dns", "name-not-resolved", address)

    if not all(is_custom_route_private_ip(ip) for ip in resolved):
        return _result("wrong", "private", "not-private", address)

    if observations.get("tcp") != "ok":
        return _result("unverified", "tcp", "connect-failed", address)

    if observations.get("tls") != "ok":
        return _result("wrong", "tls", "certificate-rejected", address)

    probe = observations.get("probe")
    if not isinstance(probe, str):
        probe = ""
    verdict, check, reason = _PROBE_RESULTS.get(probe, ("wrong", "probe", "not-relay"))
    return _result(verdict, check, reason, address)
