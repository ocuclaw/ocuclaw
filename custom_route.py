"""The custom private route lane (#5209): the user's own network, checked.

Tailscale Serve is OcuClaw's default front door. Some users already run their
own private network (plain WireGuard, UniFi Teleport, ZeroTier, NetBird, a home
LAN) with their own TLS front door to the loopback relay. They set one value,
``platforms.ocuclaw.extra.phoneAddress``, to the ``wss://name:port`` address
their phone dials, and this module is the check that replaces :mod:`serve` for
that host.

The rule itself is not here. :mod:`custom_route_contract` (#5207) holds the
address grammar, the private ranges, the probe MAC and the ordered
``ready | unverified | wrong`` verdict, pinned with the TypeScript side by one
shared vectors file. This module only *observes*: it gathers what the host can
see (Cloudways, loopback, DNS, TCP, TLS, the route probe) into the contract's
observation shape and asks the contract for the answer.

The boundary is the same one :mod:`serve` draws:

* **It reads and checks.** One bounded pass, run only by doctor's active lane.
* **It never mutates.** OcuClaw never edits the user's VPN, proxy, DNS or
  certificates. There is no apply or teardown here.
* **The Relay Credential never travels.** The route probe proves identity with
  a MAC keyed by a value *derived* from the credential; the credential itself
  never leaves this host, and credentialed relay checks run on loopback only
  (:mod:`doctor`).

``unverified`` means this host could not reach its own address, which happens
when a VPN does not route back to itself or split DNS answers only on the
phone. Pairing then goes ahead, because the address is bound into the safety
phrase and a wrong address fails safely. ``unverified`` is never worded as
working. Public addresses are refused (Matt, 2026-10-17).
"""

from __future__ import annotations

import ipaddress
import json
import queue
import socket
import ssl
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, NamedTuple, Optional, Sequence, Tuple

from . import custom_route_contract as contract

#: The config leaf, beside ``wsPort`` and ``wsBind`` under
#: ``platforms.ocuclaw.extra``. There is deliberately no environment variable
#: for it, matching the ``wsBind`` rule in :mod:`health`: the phone address
#: decides where pairing points a phone, so only the person who owns this
#: profile's config sets it.
CONFIG_KEY = "phoneAddress"

#: The exact commands the setup assistant and doctor show.
SET_COMMAND = "hermes config set platforms.ocuclaw.extra.phoneAddress wss://<name>:<port>"
CLEAR_COMMAND = "hermes config set platforms.ocuclaw.extra.phoneAddress ''"

LOOPBACK = "127.0.0.1"
_SCHEME = "wss://"

VERDICT_READY = "ready"
VERDICT_UNVERIFIED = "unverified"
VERDICT_WRONG = "wrong"
VERDICT_UNKNOWN = "unknown"

# -- stable reason codes ------------------------------------------------------
#
# One per failing row of the contract's check table, plus ``ok``. These name
# snapshot findings and doctor outcomes; a presenter renders them and never
# invents wording for one it does not know.

REASON_OK = "ok"
REASON_ADDRESS_INVALID = "address_invalid"
REASON_CLOUDWAYS_HOST = "cloudways_host"
REASON_RELAY_NOT_LISTENING = "relay_not_listening"
REASON_NAME_UNRESOLVED = "name_unresolved"
REASON_ADDRESS_NOT_PRIVATE = "address_not_private"
REASON_TCP_UNREACHABLE = "tcp_unreachable"
REASON_TLS_FAILED = "tls_failed"
REASON_PROBE_MISMATCH = "probe_mismatch"
REASON_PROBE_NO_ANSWER = "probe_no_answer"
#: The bounded pass ran out of time or failed for a local reason. Not a row of
#: the table: it is the absence of an answer, and it reads as ``unknown``.
REASON_NOT_CHECKED = "not_checked"

#: Reason code -> the verdict it carries.
REASONS: Dict[str, str] = {
    REASON_OK: VERDICT_READY,
    REASON_ADDRESS_INVALID: VERDICT_WRONG,
    REASON_CLOUDWAYS_HOST: VERDICT_WRONG,
    REASON_RELAY_NOT_LISTENING: VERDICT_WRONG,
    REASON_NAME_UNRESOLVED: VERDICT_UNVERIFIED,
    REASON_ADDRESS_NOT_PRIVATE: VERDICT_WRONG,
    REASON_TCP_UNREACHABLE: VERDICT_UNVERIFIED,
    REASON_TLS_FAILED: VERDICT_WRONG,
    REASON_PROBE_MISMATCH: VERDICT_WRONG,
    REASON_PROBE_NO_ANSWER: VERDICT_UNVERIFIED,
    REASON_NOT_CHECKED: VERDICT_UNKNOWN,
}

#: The two checks that need no network. Passive collection runs them.
STATIC_REASONS = frozenset({REASON_ADDRESS_INVALID, REASON_CLOUDWAYS_HOST})

#: The contract's failing ``check`` -> this lane's reason code. The probe row
#: fails two ways, so its verdict picks the code.
_CHECK_REASONS = {
    "address": REASON_ADDRESS_INVALID,
    "cloudways": REASON_CLOUDWAYS_HOST,
    "loopback": REASON_RELAY_NOT_LISTENING,
    "dns": REASON_NAME_UNRESOLVED,
    "private": REASON_ADDRESS_NOT_PRIVATE,
    "tcp": REASON_TCP_UNREACHABLE,
    "tls": REASON_TLS_FAILED,
}


def verdict_for(reason: Any) -> str:
    """The answer a reason code carries; ``unknown`` for anything unrecognised."""
    return REASONS.get(str(reason or ""), VERDICT_UNKNOWN)


def reason_for(result: Mapping[str, Any]) -> str:
    """Map one :func:`contract.evaluate_custom_route` result to a reason code."""
    verdict = result.get("verdict")
    if verdict == VERDICT_READY:
        return REASON_OK
    check = result.get("check")
    if check == "probe":
        return REASON_PROBE_NO_ANSWER if verdict == VERDICT_UNVERIFIED else REASON_PROBE_MISMATCH
    return _CHECK_REASONS.get(str(check), REASON_NOT_CHECKED)


# -- the configured value -----------------------------------------------------


def configured_phone_address(extra: Any) -> Optional[str]:
    """The raw configured phone address, or ``None`` when custom mode is off.

    Setting the value switches a host to custom mode; clearing it (absent, or
    an empty string) switches the host back to Tailscale. A value that is set
    but is not a string still means custom mode: it is then an invalid
    address, which is a finding to show, not a reason to fall back silently.
    """
    if not isinstance(extra, Mapping) or CONFIG_KEY not in extra:
        return None
    value = extra.get(CONFIG_KEY)
    if value is None:
        return None
    text = (value if isinstance(value, str) else str(value)).strip()
    return text or None


def canonical_address(raw_address: Any) -> Optional[str]:
    """The contract's canonical form of ``raw_address``, or ``None``."""
    result = contract.canonicalize_relay_address_v1(raw_address)
    return result["address"] if result.get("ok") else None


def split_address(address: str) -> Tuple[str, int]:
    """Host and port of a canonical address. Callers canonicalize first."""
    host, _, port = address[len(_SCHEME):].rpartition(":")
    return host, int(port)


# -- the check ----------------------------------------------------------------


class CustomRouteResult(NamedTuple):
    """One pass of the check. Only codes survive; nothing is logged."""

    verdict: str
    reason: str
    #: The canonical address, or ``None`` when the configured value is invalid.
    address: Optional[str]


def _from_contract(result: Mapping[str, Any]) -> CustomRouteResult:
    reason = reason_for(result)
    return CustomRouteResult(verdict_for(reason), reason, result.get("address"))


def static_result(raw_address: Any, *, is_cloudways: bool) -> Optional[CustomRouteResult]:
    """The checks that need no network: the address grammar and Cloudways.

    Returns the ``wrong`` result when one fails, else ``None``. The contract
    runs them first and in this order, so passive collection can name a bad
    value without probing anything.
    """
    address = canonical_address(raw_address)
    if address is None or is_cloudways:
        return _from_contract(
            contract.evaluate_custom_route(
                {"address": raw_address, "cloudways": bool(is_cloudways)}
            )
        )
    return None


Resolver = Callable[[str, int], Sequence[str]]


def _is_ipv4_literal(host: str) -> bool:
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        return False
    return True


def _default_resolve(host: str, port: int) -> List[str]:
    seen: List[str] = []
    for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        ip = str(info[4][0])
        if ip not in seen:
            seen.append(ip)
    return seen


def _loopback_listening(port: int, deadline: float) -> bool:
    try:
        with socket.create_connection(
            (LOOPBACK, int(port)), timeout=max(deadline - time.monotonic(), 0.01)
        ):
            return True
    except OSError:
        return False


#: A probe answer is one small JSON object; anything bigger is not the relay.
_MAX_PROBE_RESPONSE = 4096
#: 22 base64url-ish characters is 132 bits, inside the contract's 16-128 bound.
_NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def new_nonce() -> str:
    import secrets

    return "".join(secrets.choice(_NONCE_ALPHABET) for _ in range(32))


def probe_observation(raw: bytes, credential: str, nonce: str) -> str:
    """Classify one probe response as the contract's probe observation.

    ``match`` and ``mismatch`` need the relay's own answer shape, ``200`` with
    ``{"v": 1, "mac": <64 hex>}``; ``429`` is ``rate_limited``; no response at
    all is ``no_answer``; anything else answered and is ``not_relay``.
    """
    if not raw:
        return "no_answer"
    head, sep, body = raw.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n", 1)[0]
    parts = status_line.split(b" ", 2)
    if len(parts) < 2 or not parts[0].startswith(b"HTTP/1."):
        return "not_relay"
    if parts[1] == b"429":
        return "rate_limited"
    if parts[1] != b"200" or not sep:
        return "not_relay"
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return "not_relay"
    if not isinstance(document, dict) or document.get("v") != 1:
        return "not_relay"
    mac = document.get("mac")
    if not isinstance(mac, str) or len(mac) != 64:
        return "not_relay"
    return "match" if contract.route_probe_answer_matches(credential, nonce, mac) else "mismatch"


def _observe_route(
    host: str,
    ips: Sequence[str],
    port: int,
    credential: str,
    deadline: float,
    *,
    context_factory: Callable[[], ssl.SSLContext] = ssl.create_default_context,
) -> Dict[str, str]:
    """TCP, then TLS with default verification, then the route probe.

    Dials an address that passed the private check, never the name a second
    time, and verifies the certificate against the name the phone will use.
    Returns the contract's ``tcp``, ``tls`` and ``probe`` observations.
    """
    raw = None
    for ip in ips:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            raw = socket.create_connection((ip, port), timeout=remaining)
            break
        except OSError:
            continue
    if raw is None:
        return {"tcp": "fail", "tls": "fail", "probe": "no_answer"}
    with raw:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"tcp": "ok", "tls": "fail", "probe": "no_answer"}
        raw.settimeout(remaining)
        try:
            tls = context_factory().wrap_socket(raw, server_hostname=host)
        except ssl.SSLCertVerificationError:
            return {"tcp": "ok", "tls": "cert_rejected", "probe": "no_answer"}
        except (ssl.SSLError, ssl.CertificateError):
            return {"tcp": "ok", "tls": "cert_rejected", "probe": "no_answer"}
        except OSError:
            # The handshake never completed: nothing answered at the TLS layer.
            return {"tcp": "fail", "tls": "fail", "probe": "no_answer"}
        with tls:
            nonce = new_nonce()
            request = (
                f"GET {contract.ROUTE_PROBE_PATH}?{contract.ROUTE_PROBE_NONCE_PARAM}={nonce} HTTP/1.1\r\n"
                f"Host: {host}:{port}\r\n"
                "Connection: close\r\n"
                "User-Agent: ocuclaw-hermes-doctor\r\n\r\n"
            ).encode("ascii")
            chunks = bytearray()
            try:
                tls.sendall(request)
                while len(chunks) < _MAX_PROBE_RESPONSE:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    tls.settimeout(remaining)
                    chunk = tls.recv(_MAX_PROBE_RESPONSE - len(chunks))
                    if not chunk:
                        break
                    chunks.extend(chunk)
            except (OSError, ssl.SSLError):
                pass
            return {
                "tcp": "ok",
                "tls": "ok",
                "probe": probe_observation(bytes(chunks), credential, nonce),
            }


def observe(
    raw_address: Any,
    *,
    relay_port: Optional[int],
    credential: str,
    timeout_s: float,
    is_cloudways: bool = False,
    resolve: Optional[Resolver] = None,
    loopback_listening: Optional[Callable[[int, float], bool]] = None,
    route: Optional[Callable[..., Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Gather the contract's observations, in its order, inside ``timeout_s``.

    Stops at the first check whose answer already decides the verdict, so a
    bad address never touches the network and a public answer is never dialled.
    """
    deadline = time.monotonic() + max(float(timeout_s), 0.0)
    observations: Dict[str, Any] = {"address": raw_address, "cloudways": bool(is_cloudways)}
    address = canonical_address(raw_address)
    if address is None or is_cloudways:
        return observations
    listening = _loopback_listening if loopback_listening is None else loopback_listening
    relay_up = relay_port is not None and listening(int(relay_port), deadline)
    observations["loopbackRelay"] = "ok" if relay_up else "fail"
    if not relay_up:
        return observations
    host, port = split_address(address)
    if _is_ipv4_literal(host):
        # The contract needs no lookup for a literal; neither does the dial.
        ips: List[str] = [host]
    else:
        resolver = _default_resolve if resolve is None else resolve
        try:
            ips = list(resolver(host, port))
        except (OSError, UnicodeError):
            ips = []
        observations["resolve"] = {"ok": bool(ips), "addresses": ips} if ips else {"ok": False}
        if not ips:
            return observations
    if not all(contract.is_custom_route_private_ip(ip) for ip in ips):
        return observations
    dial = _observe_route if route is None else route
    observations.update(dial(host, ips, port, credential, deadline))
    return observations


def check(raw_address: Any, *, credential: str, timeout_s: float, **kwargs: Any) -> CustomRouteResult:
    """Observe, then let the contract decide. Blocking; see :func:`bounded_check`."""
    observations = observe(raw_address, credential=credential, timeout_s=timeout_s, **kwargs)
    return _from_contract(contract.evaluate_custom_route(observations))


def bounded_check(
    timeout_s: float,
    *,
    credential_fn: Callable[[], str],
    **kwargs: Any,
) -> CustomRouteResult:
    """:func:`check` on a daemon worker, abandoned at the deadline.

    Same reasoning as :func:`doctor.tailnet_front_door_check`: ``getaddrinfo``
    honours no socket timeout, and a managed credential store may not honour
    one either, so only a worker the caller can walk away from keeps doctor
    inside its five-second budget. The credential is read inside the worker
    and never leaves it. Without a credential the identity row cannot be
    checked, so the pass answers ``not_checked`` rather than a verdict.
    """
    answer: "queue.Queue[CustomRouteResult]" = queue.Queue(maxsize=1)
    raw_address = kwargs.get("raw_address")

    def not_checked() -> CustomRouteResult:
        return CustomRouteResult(VERDICT_UNKNOWN, REASON_NOT_CHECKED, canonical_address(raw_address))

    def worker() -> None:
        try:
            credential = credential_fn()
            if not isinstance(credential, str) or not credential:
                static = static_result(raw_address, is_cloudways=bool(kwargs.get("is_cloudways")))
                answer.put(static if static is not None else not_checked())
                return
            answer.put(check(timeout_s=timeout_s, credential=credential, **kwargs))
        except BaseException:  # noqa: BLE001 - the caller has already moved on
            answer.put(not_checked())

    threading.Thread(target=worker, name="ocuclaw-custom-route-check", daemon=True).start()
    try:
        return answer.get(timeout=max(float(timeout_s), 0.0) + 0.05)
    except queue.Empty:
        return not_checked()


__all__ = [
    "CLEAR_COMMAND",
    "CONFIG_KEY",
    "CustomRouteResult",
    "REASONS",
    "SET_COMMAND",
    "STATIC_REASONS",
    "VERDICT_READY",
    "VERDICT_UNKNOWN",
    "VERDICT_UNVERIFIED",
    "VERDICT_WRONG",
    "bounded_check",
    "canonical_address",
    "check",
    "configured_phone_address",
    "observe",
    "probe_observation",
    "reason_for",
    "split_address",
    "static_result",
    "verdict_for",
]
