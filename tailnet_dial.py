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
* With ``nc_argv`` (an adopted daemon with no SOCKS listener, #6482) the
  bytes go through ``<nc_argv> nc host port`` on a socketpair; the daemon
  resolves the name the same way. The child ends when the socket closes, and
  a reaper kills it shortly past the deadline whatever the caller does.
* Nothing here sends application bytes; the callers keep that promise.
"""
from __future__ import annotations

import socket
import struct
import subprocess
import threading
import time
from typing import Any, Dict, Optional, Sequence, Tuple

Socks5 = Tuple[str, int]

#: Mirrors ``receipts.DIAL_TAILSCALE_NC``; kept literal so this module stays
#: import-free of the receipt layer.
DIAL_TAILSCALE_NC = "tailscale-nc"

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


#: How long a `tailscale nc` child may outlive the caller's deadline before the
#: reaper kills it. The callers are bounded probes; nothing should still be
#: talking through the pipe by then.
NC_REAP_GRACE_S = 2.0


class _NcSocket(socket.socket):
    """One end of a socketpair whose other end is a `tailscale nc` child.

    Closing it also ends the child. `ssl.wrap_socket` detaches the fd into an
    SSLSocket, so the caller's own ``with raw:`` still lands here and still
    ends the child; the reaper thread covers a caller that never closes.
    """

    _nc_child: Optional[subprocess.Popen] = None

    def close(self) -> None:  # noqa: D401 - socket API
        try:
            super().close()
        finally:
            _end_child(self._nc_child)


def _end_child(child: Optional[subprocess.Popen]) -> None:
    if child is None or child.poll() is not None:
        return
    try:
        child.terminate()
        child.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        try:
            child.kill()
            child.wait(timeout=1.0)
        except (OSError, subprocess.TimeoutExpired):
            pass
    except OSError:
        pass


def _reap_after(child: subprocess.Popen, deadline: float) -> None:
    """Wait for the child, killing it a little past the deadline. Never raises."""
    try:
        child.wait(timeout=max(0.0, deadline - time.monotonic()) + NC_REAP_GRACE_S)
    except subprocess.TimeoutExpired:
        _end_child(child)
    except Exception:  # noqa: BLE001 - a reaper thread must never die loud
        _end_child(child)


def _nc_connect(nc_argv: Sequence[str], host: str, port: int, deadline: float) -> socket.socket:
    """`<tailscale --socket=…> nc host port` with its stdio on a socketpair.

    The daemon resolves and reaches the tailnet name, like a SOCKS5 proxy
    would, so MagicDNS names work. TLS still runs in this process on top.
    """
    if not 0 < int(port) < 65536:
        raise OSError("tailscale nc port out of range")
    remaining = _remaining(deadline)
    parent, child_end = socket.socketpair()
    try:
        child = subprocess.Popen(  # noqa: S603 - argv from the host receipt
            [*nc_argv, "nc", str(host), str(int(port))],
            stdin=child_end,
            stdout=child_end,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
    except (OSError, ValueError) as exc:
        parent.close()
        child_end.close()
        raise ConnectionRefusedError(f"tailscale nc could not start: {exc}") from exc
    child_end.close()
    try:
        sock = _NcSocket(parent.family, parent.type, parent.proto, fileno=parent.detach())
    except BaseException:
        _end_child(child)
        raise
    sock._nc_child = child
    threading.Thread(
        target=_reap_after, args=(child, deadline), name="ocuclaw-tailscale-nc-reaper", daemon=True
    ).start()
    sock.settimeout(remaining)
    return sock


def dial(
    host: str,
    port: int,
    deadline: float,
    *,
    socks5: Optional[Socks5] = None,
    nc_argv: Optional[Sequence[str]] = None,
) -> socket.socket:
    """Connect to ``host:port`` before ``deadline`` (a ``time.monotonic`` value).

    ``socks5`` wins over ``nc_argv``; with neither this is a direct dial.
    """
    if socks5 is not None:
        return _socks5_connect(socks5, host, int(port), deadline)
    if nc_argv:
        return _nc_connect(tuple(nc_argv), host, int(port), deadline)
    return socket.create_connection((host, int(port)), timeout=_remaining(deadline))


def receipt_dial_kwargs(receipt: Any) -> Dict[str, Any]:
    """The ``dial`` keywords a host receipt asks for: socks5, nc_argv, or none.

    Only the keyword that applies is returned, so test doubles and verifiers
    written before a mode existed keep their exact call shape.
    """
    if receipt is None:
        return {}
    if receipt.socks5 is not None:
        return {"socks5": receipt.socks5}
    if getattr(receipt, "dial", None) == DIAL_TAILSCALE_NC:
        return {"nc_argv": tuple(receipt.argv)}
    return {}


__all__ = ["DIAL_TAILSCALE_NC", "NC_REAP_GRACE_S", "Socks5", "dial", "receipt_dial_kwargs"]
