"""One TCP dialer for every tailnet-facing probe, SOCKS5-aware (#2980).

Why this exists. A userspace-networking ``tailscaled`` (the only kind a
non-root Cloudways container can run) owns no TUN device, so processes on the
host have **no route** to any tailnet address, including this node's own
Serve route. The daemon can expose a loopback SOCKS5 proxy instead, and
connections made through it reach the tailnet exactly as a kernel route would.
The Tailscale CLI receipt (``receipts.read_tailscale_cli``) records that proxy
when the host was set up that way; probes that ignored it reported
``probe_failed`` on a route the phone could reach fine.

Contract:

* ``dial(host, port, deadline)`` returns a connected, blocking-with-timeout
  socket or raises one of the ``OSError`` family the callers already map:
  ``socket.timeout``, ``ConnectionRefusedError``, ``socket.gaierror``.
* With ``socks5`` the **proxy** resolves ``host`` (SOCKS5 ATYP=DOMAINNAME),
  so tailnet MagicDNS names work even though the host resolver knows nothing
  about them. Without it, behaviour is ``socket.create_connection`` exactly.
* Nothing here sends application bytes; the callers keep that promise.
"""
from __future__ import annotations

import socket
import struct
import time
from typing import Optional, Tuple

Socks5 = Tuple[str, int]

_SOCKS_VERSION = 0x05
_SOCKS_NO_AUTH = 0x00
_SOCKS_CMD_CONNECT = 0x01
_SOCKS_ATYP_IPV4 = 0x01
_SOCKS_ATYP_DOMAIN = 0x03
_SOCKS_ATYP_IPV6 = 0x04
_SOCKS_REPLY_SUCCEEDED = 0x00
#: SOCKS5 reply codes that mean the far side said "no" to *this* target.
_SOCKS_REFUSAL_REPLIES = {0x03, 0x04, 0x05}  # network/host unreachable, refused


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise socket.timeout("tailnet dial deadline passed")
    return remaining


def _recv_exact(sock: socket.socket, count: int, deadline: float) -> bytes:
    buffer = bytearray()
    while len(buffer) < count:
        sock.settimeout(_remaining(deadline))
        chunk = sock.recv(count - len(buffer))
        if not chunk:
            raise ConnectionResetError("SOCKS5 proxy closed during handshake")
        buffer.extend(chunk)
    return bytes(buffer)


def _socks5_connect(proxy: Socks5, host: str, port: int, deadline: float) -> socket.socket:
    encoded_host = host.encode("idna")
    if not encoded_host or len(encoded_host) > 255:
        raise socket.gaierror("SOCKS5 domain name is empty or too long")
    if not 0 < int(port) < 65536:
        raise OSError("SOCKS5 port out of range")

    proxy_host, proxy_port = proxy
    sock = socket.create_connection((proxy_host, int(proxy_port)), timeout=_remaining(deadline))
    try:
        sock.settimeout(_remaining(deadline))
        sock.sendall(bytes((_SOCKS_VERSION, 1, _SOCKS_NO_AUTH)))
        version, method = _recv_exact(sock, 2, deadline)
        if version != _SOCKS_VERSION or method != _SOCKS_NO_AUTH:
            raise ConnectionResetError("SOCKS5 proxy refused the no-auth method")
        request = (
            bytes((_SOCKS_VERSION, _SOCKS_CMD_CONNECT, 0x00, _SOCKS_ATYP_DOMAIN, len(encoded_host)))
            + encoded_host
            + struct.pack("!H", int(port))
        )
        sock.settimeout(_remaining(deadline))
        sock.sendall(request)
        version, reply, _reserved, atyp = _recv_exact(sock, 4, deadline)
        if version != _SOCKS_VERSION:
            raise ConnectionResetError("SOCKS5 proxy answered with a foreign version")
        # Drain the bound-address field so the caller's TLS bytes start clean.
        if atyp == _SOCKS_ATYP_IPV4:
            _recv_exact(sock, 4 + 2, deadline)
        elif atyp == _SOCKS_ATYP_IPV6:
            _recv_exact(sock, 16 + 2, deadline)
        elif atyp == _SOCKS_ATYP_DOMAIN:
            (length,) = _recv_exact(sock, 1, deadline)
            _recv_exact(sock, length + 2, deadline)
        else:
            raise ConnectionResetError("SOCKS5 proxy answered with an unknown address type")
        if reply == _SOCKS_REPLY_SUCCEEDED:
            sock.settimeout(_remaining(deadline))
            return sock
        if reply in _SOCKS_REFUSAL_REPLIES:
            raise ConnectionRefusedError(f"SOCKS5 CONNECT refused (reply {reply})")
        raise OSError(f"SOCKS5 CONNECT failed (reply {reply})")
    except BaseException:
        sock.close()
        raise


def dial(
    host: str,
    port: int,
    deadline: float,
    *,
    socks5: Optional[Socks5] = None,
) -> socket.socket:
    """Connect to ``host:port`` before ``deadline`` (a ``time.monotonic`` value)."""
    if socks5 is None:
        return socket.create_connection((host, int(port)), timeout=_remaining(deadline))
    return _socks5_connect(socks5, host, int(port), deadline)


__all__ = ["Socks5", "dial"]
