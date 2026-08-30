"""Bounded Relay Credential verification at Q12's registered verifier site.

The reusable credential and the authenticated WebSocket request target exist
only inside :func:`_verify_blocking`, immediately around the connection they
authenticate.  Neither is returned, logged, persisted, or included in an
exception.  Public outcomes use a closed, secret-free vocabulary.

This deliberately implements only the RFC 6455 opening handshake and the
server close frame needed to observe the relay's authentication decision.  It
never sends a protocol hello, so the relay keeps the connection's client kind
``unknown`` and it never enters the authenticated-app count.
"""

from __future__ import annotations

import base64
import errno
import hashlib
import os
import queue
import socket
import ssl
import struct
import threading
import time
from dataclasses import dataclass
from urllib.parse import quote, urlencode, urlsplit

_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MAX_RESPONSE_HEADERS = 16 * 1024
_MAX_FRAME_PAYLOAD = 1024 * 1024
_AUTH_REJECTION_OBSERVATION_S = 0.25
_NETWORK_UNREACHABLE_ERRNOS = frozenset(
    code
    for code in (
        getattr(errno, name, None)
        for name in (
            "ECONNREFUSED",
            "ECONNRESET",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "EHOSTDOWN",
            "ENETDOWN",
            "ECONNABORTED",
        )
    )
    if code is not None
)

_DETAILS = {
    "accepted": "authenticated WebSocket upgrade accepted",
    "rejected": "credential rejected by the application behind the route",
    "unreachable": "application behind the route could not be reached",
    "timeout": "authenticated relay verification timed out",
    "protocol_error": "route did not complete the expected OcuClaw relay handshake",
    "unknown": "authenticated relay verification could not determine an outcome",
}


@dataclass(frozen=True)
class RelayVerifyOutcome:
    outcome: str
    detail: str
    elapsed_ms: int


def _outcome(name: str, started: float) -> RelayVerifyOutcome:
    elapsed_ms = max(0, round((time.monotonic() - started) * 1000))
    return RelayVerifyOutcome(name, _DETAILS[name], elapsed_ms)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError()
    return remaining


def _recv_more(sock: ssl.SSLSocket, deadline: float, size: int = 4096) -> bytes:
    sock.settimeout(_remaining(deadline))
    chunk = sock.recv(size)
    if not chunk:
        raise EOFError("connection closed")
    return chunk


def _read_response_headers(sock: ssl.SSLSocket, deadline: float) -> tuple[bytes, bytes]:
    response = bytearray()
    marker = b"\r\n\r\n"
    while marker not in response:
        response.extend(_recv_more(sock, deadline))
        if len(response) > _MAX_RESPONSE_HEADERS:
            raise ValueError("response headers too large")
    head, remainder = bytes(response).split(marker, 1)
    return head, remainder


def _parse_response_headers(head: bytes) -> tuple[int, dict[str, str]]:
    lines = head.decode("iso-8859-1").split("\r\n")
    status = lines[0].split(" ", 2)
    if len(status) < 2 or status[0] != "HTTP/1.1":
        raise ValueError("invalid HTTP status line")
    code = int(status[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" not in line:
            raise ValueError("invalid HTTP header")
        name, value = line.split(":", 1)
        key = name.strip().lower()
        headers[key] = (
            f"{headers[key]}, {value.strip()}" if key in headers else value.strip()
        )
    return code, headers


def _take_bytes(
    sock: ssl.SSLSocket,
    buffer: bytearray,
    count: int,
    deadline: float,
) -> bytes:
    while len(buffer) < count:
        buffer.extend(_recv_more(sock, deadline, max(4096, count - len(buffer))))
    result = bytes(buffer[:count])
    del buffer[:count]
    return result


def _read_frame(
    sock: ssl.SSLSocket, buffer: bytearray, deadline: float
) -> tuple[int, bytes]:
    """Read one complete unmasked server frame."""

    first, second = _take_bytes(sock, buffer, 2, deadline)
    final = bool(first & 0x80)
    reserved = first & 0x70
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if reserved or masked:
        raise ValueError("unexpected WebSocket frame")
    if opcode not in (0x00, 0x01, 0x02, 0x08, 0x09, 0x0A):
        raise ValueError("unknown WebSocket opcode")
    if length == 126:
        length = struct.unpack("!H", _take_bytes(sock, buffer, 2, deadline))[0]
    elif length == 127:
        length = struct.unpack("!Q", _take_bytes(sock, buffer, 8, deadline))[0]
    if length > _MAX_FRAME_PAYLOAD:
        raise ValueError("WebSocket frame too large")
    if opcode >= 0x08 and (not final or length > 125):
        raise ValueError("invalid WebSocket control frame")
    return opcode, _take_bytes(sock, buffer, length, deadline)


def _read_close(
    sock: ssl.SSLSocket, initial: bytes, deadline: float
) -> tuple[int | None, str]:
    """Ignore permissible frames until the server closes or time expires."""

    buffer = bytearray(initial)
    while True:
        opcode, payload = _read_frame(sock, buffer, deadline)
        if opcode != 0x08:
            continue
        if len(payload) == 1:
            raise ValueError("invalid WebSocket close payload")
        if not payload:
            return None, ""
        return struct.unpack("!H", payload[:2])[0], payload[2:].decode("utf-8")


def _resolve_endpoint(
    hostname: str, port: int, deadline: float
) -> list[tuple[int, int, int, str, tuple]]:
    """Resolve without ever giving the potentially abandoned worker a credential."""

    answer: queue.Queue[tuple[bool, object]] = queue.Queue(maxsize=1)

    def resolver() -> None:
        try:
            resolved = socket.getaddrinfo(
                hostname,
                port,
                type=socket.SOCK_STREAM,
            )
            answer.put((True, resolved))
        except BaseException:  # noqa: BLE001 - caller exposes a fixed safe outcome
            answer.put((False, None))

    threading.Thread(
        target=resolver,
        name="ocuclaw-relay-resolver",
        daemon=True,
    ).start()
    try:
        ok, value = answer.get(timeout=_remaining(deadline))
    except queue.Empty as error:
        raise TimeoutError() from error
    if not ok or not isinstance(value, list) or not value:
        raise socket.gaierror()
    return value


def _connect_resolved(
    endpoints: list[tuple[int, int, int, str, tuple]], deadline: float
) -> socket.socket:
    last_error: OSError | None = None
    total = len(endpoints)
    for index, (family, socktype, proto, _canonical_name, sockaddr) in enumerate(
        endpoints
    ):
        raw = socket.socket(family, socktype, proto)
        try:
            # Share the connect window among unresolved candidates instead of
            # letting a black-holed first address starve a reachable later one.
            # Keep the locked rejection-observation window for the successful
            # socket; TLS and response parsing consume whatever remains beyond it.
            connect_window = _remaining(deadline) - _AUTH_REJECTION_OBSERVATION_S
            if connect_window <= 0:
                raise TimeoutError()
            attempts_left = total - index
            raw.settimeout(connect_window / attempts_left)
            raw.connect(sockaddr)
            return raw
        except OSError as error:
            last_error = error
            raw.close()
    if last_error is not None:
        raise last_error
    raise ConnectionError("no resolved relay endpoint")


def _verify_blocking(
    *,
    address: str,
    credential: str,
    endpoints: list[tuple[int, int, int, str, tuple]],
    started: float,
    deadline: float,
) -> RelayVerifyOutcome:
    upgraded = False
    try:
        parsed = urlsplit(address)
        if (
            parsed.scheme != "wss"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
        ):
            return _outcome("protocol_error", started)
        if not isinstance(credential, str) or not credential:
            return _outcome("unknown", started)
        try:
            port = parsed.port or 443
        except ValueError:
            return _outcome("protocol_error", started)

        context = ssl.create_default_context()
        with _connect_resolved(endpoints, deadline) as raw:
            raw.settimeout(_remaining(deadline))
            with context.wrap_socket(
                raw,
                server_hostname=parsed.hostname,
            ) as secured:
                secured.settimeout(_remaining(deadline))
                websocket_key = base64.b64encode(os.urandom(16)).decode("ascii")
                host_header = parsed.hostname
                if ":" in host_header and not host_header.startswith("["):
                    host_header = f"[{host_header}]"
                if port != 443:
                    host_header = f"{host_header}:{port}"

                # Q12's exact exception: this authenticated request target is
                # transient and local to the common relay verifier. Callers
                # supply the credential-free address and credential separately
                # and can receive only a redacted outcome.
                request_target = "/?" + urlencode(
                    {"token": credential}, quote_via=quote
                )
                request = (
                    f"GET {request_target} HTTP/1.1\r\n"
                    f"Host: {host_header}\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {websocket_key}\r\n"
                    "Sec-WebSocket-Version: 13\r\n"
                    "\r\n"
                ).encode("ascii")
                # The absolute public deadline applies even if connect or TLS
                # consumed the allowance. Never transmit after the caller's cap.
                secured.settimeout(_remaining(deadline))
                secured.sendall(request)

                head, remainder = _read_response_headers(secured, deadline)
                status, headers = _parse_response_headers(head)
                expected_accept = base64.b64encode(
                    hashlib.sha1(
                        (websocket_key + _WEBSOCKET_GUID).encode("ascii"),
                        usedforsecurity=False,
                    ).digest()
                ).decode("ascii")
                if (
                    status != 101
                    or headers.get("upgrade", "").lower() != "websocket"
                    or "upgrade"
                    not in {
                        token.strip().lower()
                        for token in headers.get("connection", "").split(",")
                    }
                    or headers.get("sec-websocket-accept") != expected_accept
                    or "sec-websocket-extensions" in headers
                    or "sec-websocket-protocol" in headers
                ):
                    return _outcome("protocol_error", started)
                upgraded = True

                # Invalid credentials are accepted at the HTTP upgrade and
                # rejected immediately afterwards with close code 4001. A
                # valid, hello-less connection stays open. Require a complete
                # short observation window before calling that acceptance.
                if _remaining(deadline) < _AUTH_REJECTION_OBSERVATION_S:
                    return _outcome("timeout", started)
                observe_deadline = min(
                    deadline,
                    time.monotonic() + _AUTH_REJECTION_OBSERVATION_S,
                )
                try:
                    close_code, close_reason = _read_close(
                        secured, remainder, observe_deadline
                    )
                except TimeoutError:
                    return _outcome("accepted", started)
                if close_code == 4001 and close_reason == "invalid_token":
                    return _outcome("rejected", started)
                return _outcome("protocol_error", started)
    except TimeoutError:
        return _outcome("timeout", started)
    except (ConnectionError, socket.gaierror):
        return _outcome("protocol_error" if upgraded else "unreachable", started)
    except ssl.SSLError:
        return _outcome("protocol_error", started)
    except (EOFError, UnicodeError, ValueError):
        return _outcome("protocol_error", started)
    except OSError as error:
        if upgraded:
            return _outcome("protocol_error", started)
        if error.errno in _NETWORK_UNREACHABLE_ERRNOS:
            return _outcome("unreachable", started)
        return _outcome("unknown", started)


def verify_relay_credential(
    *, address: str, credential: str, timeout_s: float = 2.0
) -> RelayVerifyOutcome:
    """Verify one credential once, with a wall-clock cap over DNS and I/O."""
    started = time.monotonic()
    try:
        allowance = float(timeout_s)
    except (TypeError, ValueError):
        allowance = 0.0
    if allowance <= 0:
        return _outcome("timeout", started)

    parsed = urlsplit(address)
    if (
        parsed.scheme != "wss"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        return _outcome("protocol_error", started)
    if not isinstance(credential, str) or not credential:
        return _outcome("unknown", started)
    try:
        port = parsed.port or 443
    except ValueError:
        return _outcome("protocol_error", started)
    deadline = started + allowance
    try:
        endpoints = _resolve_endpoint(parsed.hostname, port, deadline)
    except TimeoutError:
        return _outcome("timeout", started)
    except socket.gaierror:
        return _outcome("unreachable", started)

    return _verify_blocking(
        address=address,
        credential=credential,
        endpoints=endpoints,
        started=started,
        deadline=deadline,
    )


__all__ = ["RelayVerifyOutcome", "verify_relay_credential"]
