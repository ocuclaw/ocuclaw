"""Is a phone on this host's private network? (#3178)

The one question the Cloudways ladder asks before it starts pairing a phone.
A phone that never joined the tailnet cannot claim a pairing, and until this
check existed the ladder found that out the slow way: the ceremony ran, the
phone never arrived, and the person was told the pairing expired without ever
being told why.

Three properties hold everything here in place:

* **It reads.** ``tailscale status --json``, through the same bounded,
  fail-soft reader :mod:`serve` already uses for this host's own identity.
  There is no code path in this module that can reach a mutating Tailscale
  subcommand, and the argv it reads through is built in :mod:`serve`, not here.
* **It never decides anything.** The answer is advisory: the caller shows a
  line, or an explanation and a bounded wait, and pairing happens either way.
  This is why a document that cannot be read or cannot be understood answers
  ``None`` rather than ``False`` — "no phone" sends the person off to install
  an app, and a read that failed is not evidence that they need to.
* **A phone is a guess, honestly made.** A peer reporting ``iOS`` or
  ``android`` and ``Online`` is a phone for this purpose. A tablet reports the
  same, which is harmless: the pairing ceremony is what actually proves the
  phone can reach this host, and it is unchanged.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

#: The two operating systems a phone on a tailnet reports, compared casefolded
#: because Tailscale spells one of them ``iOS`` and the other ``android``.
PHONE_OS_NAMES = frozenset({"ios", "android"})


def phone_in_status(document: Any) -> Optional[bool]:
    """``True`` an online phone peer, ``False`` none, ``None`` not readable.

    The tri-state is the whole point. The document is read exactly as far as
    its verified shape goes: a *missing* ``Peer`` key is a tailnet with no
    peers, which is a perfectly understood document and a plain "no phone". A
    ``Peer`` key holding something other than a table of tables is a shape this
    build has not seen, and answering "no phone" from input it does not
    understand would send a person to install an app they may already have.
    """
    if not isinstance(document, Mapping):
        return None
    if not isinstance(document.get("BackendState"), str):
        # Every `tailscale status --json` carries it. A document without one is
        # not the contract this was written against, whatever else it holds.
        return None
    peers = document.get("Peer")
    if peers is None and "Peer" not in document:
        # Verified never-seen-a-peer shape, not an unreadable one.
        return False
    if not isinstance(peers, Mapping):
        return None
    for peer in peers.values():
        if not isinstance(peer, Mapping):
            # Half a document understood is not a document understood.
            return None
        os_name = peer.get("OS")
        if not isinstance(os_name, str):
            continue
        if os_name.strip().lower() not in PHONE_OS_NAMES:
            continue
        if peer.get("Online") is True:
            return True
    return False


def read_phone_presence(
    *,
    runner: Optional[Callable[..., Any]] = None,
    timeout_s: Optional[float] = None,
) -> Optional[bool]:
    """Ask this host's tailnet, once, bounded. Same tri-state, same reasons.

    Every failure the read can have — no Tailscale binary, a daemon that is not
    answering, a timeout, a non-zero exit, output that is not JSON — arrives
    here as ``None``, because :func:`serve._run_json` is fail-soft in every
    direction. The caller treats all of them alike: say nothing, carry on.
    """
    from . import serve as serve_mod

    timeout = serve_mod.READ_TIMEOUT_S if timeout_s is None else timeout_s
    try:
        document, _code = serve_mod.read_status_document(
            timeout_s=timeout, runner=runner
        )
    except Exception:  # noqa: BLE001 - an injected runner may raise anything
        return None
    return phone_in_status(document)


__all__ = [
    "PHONE_OS_NAMES",
    "phone_in_status",
    "read_phone_presence",
]
