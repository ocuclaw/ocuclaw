"""The Tailscale Serve lane (#1319): read, classify, and print — never mutate.

OcuClaw reaches the phone over one Tailscale Serve route: a TLS-terminated TCP
forwarder on the tailnet, pointed at the loopback relay. This module is the
whole of OcuClaw's relationship with that route, and the boundary it draws is
the point of it:

* **It reads.** ``tailscale serve status --json`` and ``tailscale status
  --json`` are run as bounded, non-mutating subprocesses that fail soft to
  ``unknown``.
* **It classifies.** ``ready | absent | wrong | unknown`` over the real JSON
  contract, on the terms #1275 established empirically.
* **It prints.** The exact command the *user* runs to apply the route, and the
  narrow command to take it away again.
* **It never mutates.** There is no apply function, no teardown function, no
  ``serve reset`` — anywhere. P15 rungs 2 and 3 were rejected, not deferred
  (#1272), and the printed command is the whole substitute. A future
  contributor looking for the mutation seam should find this paragraph
  instead.

Configuration-authoritative, health-advisory (#1275)
---------------------------------------------------

The decisive empirical result behind this module is that **configured is not
working**. A probe of eight already-configured Serve routes found seven that
accepted a connection, one TLS-terminated TCP route that reset it, and one
HTTPS route that answered the front door and returned ``502``. So a present,
correctly-shaped, correctly-targeted JSON entry still proves only that the
route is *configured*.

This module therefore classifies configuration shape and stops. Route health
is the bounded probe's to establish, in :mod:`doctor`, and until that probe
succeeds the route's health stays advisory.

What "recognised" means, and why the failures all point one way
--------------------------------------------------------------

Two real Tailscale CLI minors (``1.98.9`` and ``1.102.2``) reported the same
contract, and the classifier is written to exactly it:

* top-level ``TCP`` and ``Web`` objects;
* **string** ``TCP`` port keys — never integers;
* ``AllowFunnel`` *absent*, so it is optional and its absence is not a defect;
* TLS-terminated TCP entries carry string ``TCPForward`` and string
  ``TerminateTLS`` and **no** ``HTTPS`` field;
* HTTPS entries carry boolean ``HTTPS`` and **no** ``TCPForward``;
* ``Web`` keys are ``dns-name:port``, matching ``status --json``
  ``Self.DNSName`` once its trailing dot is stripped.

Anything outside that — an unknown key on the entry being classified, a wrong
type, a missing DNS identity, a CLI that failed — resolves to ``unknown``.
Never to ``ready``. That asymmetry is deliberate: ``unknown`` costs a user a
diagnostic line, while a false ``ready`` sends them to debug a phone that was
never going to connect. It does mean a future Tailscale release that adds a
field to our entry will read ``unknown`` until this vocabulary is widened,
which is the failure this lane wants.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from typing import Any, Callable, Dict, Mapping, NamedTuple, Optional, Sequence, Tuple

# -- the serve port accessor (#1272) ------------------------------------------

#: The tailnet port OcuClaw's Serve route listens on. Fixed for the beta: the
#: config key was rejected, because a key nobody sets is a key that can drift
#: from the printed command, the classifier, and the address the phone was
#: given — four places that must agree or the route silently stops being
#: OcuClaw's. If a real cohort collision ever appears, widening
#: :func:`serve_port` to read one is a one-line change, and every consumer
#: already goes through it.
SERVE_PORT_FALLBACK = 8446

_MIN_PORT = 1
_MAX_PORT = 65535


def serve_port(configured: Any = None) -> int:
    """The one accessor the formatter, classifier, and printer all share.

    ``configured`` exists so the single future caller that might supply a
    value has somewhere to supply it; nothing in this build passes one. An
    unusable value falls back rather than raising — a malformed port is not a
    reason for the whole diagnostic to become unavailable.
    """
    if configured is None:
        return SERVE_PORT_FALLBACK
    try:
        port = int(configured)
    except (TypeError, ValueError):
        return SERVE_PORT_FALLBACK
    if _MIN_PORT <= port <= _MAX_PORT:
        return port
    return SERVE_PORT_FALLBACK


# -- classification vocabulary ------------------------------------------------

CLASSIFY_READY = "ready"
CLASSIFY_ABSENT = "absent"
CLASSIFY_WRONG = "wrong"
CLASSIFY_UNKNOWN = "unknown"

#: Mirrors :data:`snapshot.SERVE_CLASSIFICATIONS`; a test pins the two equal
#: so this module stays importable without dragging the deriver in.
CLASSIFICATIONS = (CLASSIFY_READY, CLASSIFY_ABSENT, CLASSIFY_WRONG, CLASSIFY_UNKNOWN)

TRISTATE_YES = "yes"
TRISTATE_NO = "no"
TRISTATE_UNKNOWN = "unknown"

# -- reason codes -------------------------------------------------------------
#
# Every classification carries the reason it reached that verdict. These are
# stable, allowlisted tokens: a presenter renders them, support quotes them,
# and none of them is derived from a fact value, so none can carry a secret.

REASON_MATCHES = "route_matches"
REASON_NO_ROUTE_AT_PORT = "no_route_at_port"
REASON_HTTPS_NOT_TCP = "https_route_not_tls_terminated_tcp"
REASON_HTTP_NOT_TCP = "http_route_not_tls_terminated_tcp"
REASON_RAW_TCP_NOT_TLS = "raw_tcp_route_without_tls_termination"
REASON_PROXY_PROTOCOL = "route_uses_proxy_protocol"
REASON_FOREIGN_TARGET = "forwards_to_a_different_target"
REASON_FOREIGN_TLS_IDENTITY = "terminates_tls_for_another_node"
REASON_WEB_HANDLER_AT_PORT = "web_handler_occupies_the_port"
REASON_FUNNEL_ENABLED = "route_is_exposed_by_funnel"
REASON_FOREGROUND_SESSION = "foreground_serve_session_active"
REASON_UNRECOGNISED_DOCUMENT = "unrecognised_serve_document"
REASON_UNRECOGNISED_ENTRY = "unrecognised_route_entry"
REASON_NO_DNS_IDENTITY = "node_dns_identity_unknown"
REASON_NO_RELAY_PORT = "relay_port_unknown"
REASON_NOT_READ = "serve_status_not_read"

REASON_CODES = (
    REASON_MATCHES,
    REASON_NO_ROUTE_AT_PORT,
    REASON_HTTPS_NOT_TCP,
    REASON_HTTP_NOT_TCP,
    REASON_RAW_TCP_NOT_TLS,
    REASON_PROXY_PROTOCOL,
    REASON_FOREIGN_TARGET,
    REASON_FOREIGN_TLS_IDENTITY,
    REASON_WEB_HANDLER_AT_PORT,
    REASON_FUNNEL_ENABLED,
    REASON_FOREGROUND_SESSION,
    REASON_UNRECOGNISED_DOCUMENT,
    REASON_UNRECOGNISED_ENTRY,
    REASON_NO_DNS_IDENTITY,
    REASON_NO_RELAY_PORT,
    REASON_NOT_READ,
)

# -- reader result codes ------------------------------------------------------

#: Verdicts where the port is held by a *web* route. Tailscale refuses to put
#: a TCP forwarder on a port already serving web — the shipping CLI answers
#: "cannot serve TCP; already serving web on <port>" — so the apply command
#: cannot succeed until that handler is gone. OcuClaw does not print the
#: removal, because it is not OcuClaw's route to remove; the presenter says
#: what is there and leaves the decision with whoever owns it.
WEB_OCCUPIED_REASONS = frozenset(
    {REASON_HTTPS_NOT_TCP, REASON_HTTP_NOT_TCP, REASON_WEB_HANDLER_AT_PORT}
)

READ_OK = "serve_read_ok"
READ_CLI_ABSENT = "serve_cli_absent"
READ_TIMEOUT = "serve_read_timeout"
READ_FAILED = "serve_read_failed"
READ_UNPARSABLE = "serve_read_unparsable"

READ_CODES = (
    READ_OK,
    READ_CLI_ABSENT,
    READ_TIMEOUT,
    READ_FAILED,
    READ_UNPARSABLE,
)

#: Each read is bounded on its own. Collection is a passive, local-socket
#: read, not the doctor probe lane, so it carries its own budget rather than
#: borrowing the five-second active-check one.
READ_TIMEOUT_S = 2.0

#: The loopback address the route must forward to. The relay is reached over
#: the tailnet route and never by binding it to a public interface, so a
#: forwarder aimed anywhere else is not OcuClaw's route (#1273 §7).
LOOPBACK = "127.0.0.1"

# The TCP entry field vocabulary. `HTTPS`, `TCPForward`, and `TerminateTLS`
# came from the two captured minors; `HTTP` and `ProxyProtocol` are the fields
# behind `serve --http` and `serve --proxy-protocol`, which the shipping
# 1.102.2 binary documents and which can therefore legitimately appear on our
# port. Still closed: a field outside this set makes the entry unreadable.
_KNOWN_TCP_FIELDS = frozenset(
    {"HTTPS", "HTTP", "TCPForward", "TerminateTLS", "ProxyProtocol"}
)

#: Top-level keys this build knows how to reason about. `TCP` and `Web` were
#: in both captures; `AllowFunnel` is handled explicitly; `ETag` is a version
#: tag carrying no routing semantics.
#:
#: Everything else — including `Foreground` — makes the document unreadable to
#: this build, and the reason is specific rather than pedantic: a foreground
#: `tailscale serve` session carries its own handler set, and its entries take
#: precedence over the background ones this classifier reads. A background
#: route that matches OcuClaw's shape can therefore be shadowed by a
#: foreground entry on the same port, so the *effective* route is not the one
#: in `TCP` at all. Reading only the background table and reporting `ready`
#: would hand back a verdict about a route that is not in force.
#: `Services` is validated and then ignored rather than rejected. Tailscale's
#: own `serve --service` help says a service is served "with distinct virtual
#: IP instead on node itself" — so a service route cannot occupy the node's
#: own port, and cannot shadow OcuClaw's. Rejecting the document because the
#: host uses a supported feature would withhold a working phone address from
#: a route that is genuinely fine.
_KNOWN_TOP_LEVEL_KEYS = frozenset(
    {"TCP", "Web", "AllowFunnel", "ETag", "Services"}
)
_FOREGROUND_KEY = "Foreground"

# A tailnet DNS name, once its trailing dot is stripped. Bounded charset, so a
# name that reaches a presenter cannot carry anything but a hostname.
_DNS_NAME_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$")


class ServeObservation(NamedTuple):
    """One classification of this host's Serve configuration.

    ``dns_name`` is the node's own tailnet identity. It is the private route
    authority, and it is carried here — not rendered — so that the two
    surfaces sanctioned to show it can, and every other consumer structurally
    cannot (see :mod:`snapshot`, whose frozen document key set has no address
    field at all).
    """

    classification: str
    configured: str
    reason: str
    port: int
    dns_name: Optional[str]
    relay_port: Optional[int]
    read_code: str


def normalize_dns_name(value: Any) -> Optional[str]:
    """A tailnet DNS name with its trailing dot stripped, or ``None``.

    ``status --json`` reports ``Self.DNSName`` fully qualified, with the root
    dot; ``serve status --json`` keys ``Web`` entries without it. Comparing
    the two raw is the trailing-dot trap that makes a correct route look
    foreign, so every comparison in this module goes through here first.
    """
    if not isinstance(value, str):
        return None
    name = value.strip().rstrip(".")
    if not name or not _DNS_NAME_RE.match(name):
        return None
    return name


# -- the reader ---------------------------------------------------------------


def _run_json(
    args: Sequence[str],
    *,
    timeout_s: float,
    runner: Optional[Callable[..., Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Run one bounded, read-only CLI call and parse its JSON.

    Fail-soft in every direction: a missing binary, a timeout, a non-zero
    exit, and unparsable output all return ``(None, code)``. Nothing here
    raises into the collector, because a diagnostic that dies on a missing
    optional dependency is worse than the condition it was diagnosing.
    """
    if runner is None:
        if shutil.which(args[0]) is None:
            return None, READ_CLI_ABSENT
        runner = subprocess.run
    try:
        completed = runner(
            list(args),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, READ_TIMEOUT
    except (OSError, ValueError):
        return None, READ_FAILED
    except Exception:  # noqa: BLE001 - a substituted runner may raise anything
        return None, READ_FAILED

    if getattr(completed, "returncode", 1) != 0:
        return None, READ_FAILED
    raw = getattr(completed, "stdout", None)
    if not isinstance(raw, str) or not raw.strip():
        return None, READ_UNPARSABLE
    try:
        document = json.loads(raw)
    except ValueError:
        return None, READ_UNPARSABLE
    if not isinstance(document, dict):
        return None, READ_UNPARSABLE
    return document, READ_OK


def read_serve_status(
    *,
    timeout_s: float = READ_TIMEOUT_S,
    runner: Optional[Callable[..., Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], str]:
    """`tailscale serve status --json`, bounded and read-only.

    ``status`` is the only Serve subcommand this codebase invokes. There is
    deliberately no code path here that can reach ``serve``'s mutating forms.
    """
    return _run_json(
        ("tailscale", "serve", "status", "--json"),
        timeout_s=timeout_s,
        runner=runner,
    )


def read_node_dns_name(
    *,
    timeout_s: float = READ_TIMEOUT_S,
    runner: Optional[Callable[..., Any]] = None,
) -> Tuple[Optional[str], str]:
    """This node's own tailnet DNS identity, normalised.

    Route classification needs it (a ``TerminateTLS`` naming another node is
    not this host's route) and the phone address is built from it. Without it
    the classifier reports ``unknown``, never ``ready`` (#1275).
    """
    document, code = _run_json(
        ("tailscale", "status", "--json"), timeout_s=timeout_s, runner=runner
    )
    if document is None:
        return None, code
    self_node = document.get("Self")
    if not isinstance(self_node, Mapping):
        return None, READ_UNPARSABLE
    name = normalize_dns_name(self_node.get("DNSName"))
    if name is None:
        return None, READ_UNPARSABLE
    return name, READ_OK


# -- the classifier -----------------------------------------------------------


def _tcp_table(document: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The ``TCP`` table, if the document has the recognised top-level shape.

    An absent ``TCP`` key is a recognised document with no TCP routes — a
    host that has never configured Serve reports exactly that — so it maps to
    an empty table, not to an unrecognised one.
    """
    # A *missing* key is the verified never-configured shape. A key that is
    # present holding something other than an object is not: `"TCP": null` is
    # a type this build has not seen, and reading it as "no routes" would have
    # the CLI print a replacement command on the strength of input it does not
    # understand.
    if "TCP" not in document:
        return {}
    tcp = document["TCP"]
    if not isinstance(tcp, Mapping):
        return None
    for key in tcp:
        # The string port key is a load-bearing observation, preserved by both
        # captured minors. An int key means we are not reading the contract we
        # verified, so nothing here may be trusted.
        if not isinstance(key, str):
            return None
    return dict(tcp)


def _funnel_exposed(
    document: Mapping[str, Any], host_port: str, dns_name: Optional[str]
) -> bool:
    """Whether ``AllowFunnel`` exposes our port to the public internet.

    ``AllowFunnel`` was absent on both captured minors, so its absence is
    normal and never a defect. Its *presence*, naming our port true, is a
    different matter: Funnel publishes the route beyond the tailnet, which is
    not the route OcuClaw proposed and not one it will call ready.

    Tailscale keys this map the way it keys ``Web`` — ``host:port``. Because
    neither capture contained the field, the bare-port form is accepted too:
    the cost of reading a key form we have not seen is one over-cautious
    ``wrong``, and the cost of missing it is calling a publicly-exposed route
    ready.
    """
    funnel = document.get("AllowFunnel")
    if not isinstance(funnel, Mapping):
        # Only reachable for an absent field; a present-but-unreadable one is
        # rejected as a document shape before classification gets this far.
        return False
    if bool(funnel.get(host_port)):
        return True
    if dns_name is not None and bool(funnel.get(f"{dns_name}:{host_port}")):
        return True
    # Any entry that ends at our port, whatever host it names, still publishes
    # this port beyond the tailnet.
    return any(
        isinstance(key, str) and key.rsplit(":", 1)[-1] == host_port and bool(value)
        for key, value in funnel.items()
    )


def _web_handler_on_port(document: Mapping[str, Any], host_port: str) -> bool:
    """Whether any web handler occupies our port, under any hostname.

    Matched on the port rather than on ``dns-name:port`` so a handler under
    another node's name — or one seen while the identity read failed — still
    counts. The port is host-wide; who claimed it does not change that it is
    claimed.
    """
    web = document.get("Web")
    if not isinstance(web, Mapping):
        return False
    return any(
        isinstance(key, str) and key.rsplit(":", 1)[-1] == host_port for key in web
    )


#: Distinguishes an absent ``Foreground`` field from one explicitly present
#: holding null. The first is the verified shape; the second is not.
_ABSENT = object()


def _foreground_verdict(foreground: Any, host_port: str) -> Optional[str]:
    """Why a foreground session blocks a verdict, or ``None`` if it does not.

    Returns a reason code when the foreground configuration either occupies
    our port — in which case the background entry is not the effective route —
    or cannot be read, in which case we cannot tell whether it does.
    """
    if foreground is _ABSENT:
        return None
    if not isinstance(foreground, Mapping):
        # Includes an explicit null: present but unverified, so it cannot be
        # waved through as "no foreground session".
        return REASON_UNRECOGNISED_DOCUMENT
    for session in foreground.values():
        if not isinstance(session, Mapping):
            return REASON_UNRECOGNISED_DOCUMENT
        tcp = session.get("TCP")
        if tcp is not None:
            if not isinstance(tcp, Mapping):
                return REASON_UNRECOGNISED_DOCUMENT
            if host_port in tcp:
                return REASON_FOREGROUND_SESSION
        web = session.get("Web")
        if web is not None:
            if not isinstance(web, Mapping):
                return REASON_UNRECOGNISED_DOCUMENT
            for key in web:
                if isinstance(key, str) and key.rsplit(":", 1)[-1] == host_port:
                    return REASON_FOREGROUND_SESSION
        # Funnel permission is per-config, not only top-level: a foreground
        # config may carry its own `AllowFunnel`, and Tailscale consults those
        # maps when deciding whether a target accepts public ingress. A
        # foreground config granting Funnel on our port therefore exposes the
        # relay to the internet while the background entry still looks like a
        # private route — the same fail-open as an unreadable top-level
        # `AllowFunnel`, reached by a different path.
        funnel = session.get("AllowFunnel")
        if funnel is not None:
            if not isinstance(funnel, Mapping):
                return REASON_UNRECOGNISED_DOCUMENT
            for key, value in funnel.items():
                if (
                    isinstance(key, str)
                    and key.rsplit(":", 1)[-1] == host_port
                    and bool(value)
                ):
                    return REASON_FUNNEL_ENABLED
    return None


def classify(
    document: Optional[Mapping[str, Any]],
    *,
    dns_name: Optional[str],
    relay_port: Optional[int],
    port: Optional[int] = None,
    read_code: str = READ_OK,
) -> ServeObservation:
    """Classify this host's Serve configuration. Shape only — never health.

    The verdicts, and the single rule that orders them: a route is ``ready``
    only when every part of it was positively verified. Absence of evidence
    about any part yields ``unknown``.
    """
    resolved_port = serve_port(port)
    host_port = str(resolved_port)

    def observed(classification: str, configured: str, reason: str) -> ServeObservation:
        return ServeObservation(
            classification=classification,
            configured=configured,
            reason=reason,
            port=resolved_port,
            dns_name=dns_name,
            relay_port=relay_port,
            read_code=read_code,
        )

    if document is None:
        # The CLI did not answer. Nothing was observed, so nothing is claimed
        # — in particular not that the route is absent.
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_NOT_READ)

    if set(document) - _KNOWN_TOP_LEVEL_KEYS - {_FOREGROUND_KEY}:
        return observed(
            CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_DOCUMENT
        )

    # Validated, then ignored: services live on their own virtual IPs, so
    # their routes never occupy this node's port. An unreadable value still
    # fails closed, because then we cannot know that is what it holds.
    if "Services" in document and not isinstance(document["Services"], Mapping):
        return observed(
            CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_DOCUMENT
        )

    # A present `AllowFunnel` of an unreadable type must not be treated as an
    # absent one. Absent means "no Funnel"; unreadable means "this build
    # cannot tell", and reporting `ready` on that difference is the one
    # mistake here that could present a publicly exposed route as private.
    if "AllowFunnel" in document and not isinstance(
        document["AllowFunnel"], Mapping
    ):
        return observed(
            CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_DOCUMENT
        )

    # A foreground session shadows the background table only where the two
    # collide. A session on some unrelated port leaves our route in force, so
    # rejecting every foreground session would withhold a working phone
    # address from a host that simply has another `tailscale serve` running.
    # A foreground entry we cannot read at all still fails closed.
    foreground = _foreground_verdict(
        document.get(_FOREGROUND_KEY, _ABSENT), host_port
    )
    if foreground == REASON_FUNNEL_ENABLED:
        # Public exposure is a definite finding about a configured route, not
        # an inability to read one.
        return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_FUNNEL_ENABLED)
    if foreground is not None:
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, foreground)

    tcp = _tcp_table(document)
    if tcp is None or not isinstance(document.get("Web", {}), Mapping):
        return observed(
            CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_DOCUMENT
        )

    # Anything on our port in the web table, under any hostname. Checked
    # before the verdicts rather than only in the absent branch: a handler
    # under another node's name, or one seen while the identity read failed,
    # still occupies a host-wide port, and telling the user to apply a route
    # over it would have them fight for a port something else already holds.
    web_on_port = _web_handler_on_port(document, host_port)

    # Membership, not `.get`: a port key present holding null is an entry
    # shape this build has not verified, and reading it as "no entry" would
    # have the CLI print an apply command over state it cannot describe.
    if host_port in tcp and not isinstance(tcp[host_port], Mapping):
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_ENTRY)

    entry = tcp.get(host_port)
    if entry is None:
        if web_on_port:
            # A Web handler on our port with no TCP entry is a shape neither
            # captured minor produced. Refuse to read it as "absent" —
            # something is on the port.
            return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_WEB_HANDLER_AT_PORT)
        # The document was read and understood, and our port is not in it.
        # This is the one negative claim configuration evidence can support
        # on its own.
        return observed(CLASSIFY_ABSENT, TRISTATE_NO, REASON_NO_ROUTE_AT_PORT)

    if not isinstance(entry, Mapping):
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_ENTRY)

    # Something is configured on our port from here on: `configured` is yes
    # for every remaining verdict except the unknowns, which withdraw the
    # claim entirely rather than half-making it.
    #
    # Exactly two entry shapes were observed across both captured minors, and
    # only those two are accepted. An HTTPS entry carries `HTTPS` and nothing
    # else; a TLS-terminated TCP entry carries the two string fields and no
    # `HTTPS` key at all. A hybrid — `HTTPS: false` beside a forward, say — is
    # not a shape this build has verified, so it does not get a verdict.
    fields = set(entry)
    if fields - _KNOWN_TCP_FIELDS:
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_ENTRY)

    # `tailscale serve` has four modes that can occupy a port — `--https`,
    # `--http`, `--tcp`, `--tls-terminated-tcp` — and only the last is
    # OcuClaw's. The other three are perfectly valid configurations that
    # happen to be on our port, so each is named as `wrong` rather than
    # shrugged at as `unknown`: `wrong` is the verdict that prints the
    # replacement command, and a user whose port is held by a supported mode
    # needs that command more than anyone.
    # A port is in exactly one mode, so the web fields and the forwarder
    # fields never legitimately appear together. A hybrid is a shape we have
    # not verified, whatever its values — including `HTTPS: false` beside a
    # forward, which is not the zero value Go would have omitted.
    web_fields = fields & {"HTTPS", "HTTP"}
    forward_fields = fields & {"TCPForward", "TerminateTLS", "ProxyProtocol"}
    if web_fields and forward_fields:
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_ENTRY)
    if web_fields:
        if fields == {"HTTPS"} and entry["HTTPS"] is True:
            return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_HTTPS_NOT_TCP)
        if fields == {"HTTP"} and entry["HTTP"] is True:
            return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_HTTP_NOT_TCP)
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_ENTRY)

    forward = entry.get("TCPForward")
    terminate = entry.get("TerminateTLS")
    if not isinstance(forward, str) or not forward:
        # Not a forwarder, and not one of the two web modes either — so this
        # is a combination of known field names in a shape we have not seen.
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_ENTRY)
    if terminate is None:
        # `--tcp`: a raw forwarder with no TLS termination. The phone speaks
        # `wss://`, so this port would answer and then fail the handshake.
        return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_RAW_TCP_NOT_TLS)
    if not isinstance(terminate, str) or not terminate:
        return observed(CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_ENTRY)
    if entry.get("ProxyProtocol"):
        # `--proxy-protocol` prefixes every connection with a PROXY header the
        # relay does not parse, so the route is configured but unusable.
        return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_PROXY_PROTOCOL)

    if web_on_port:
        # In the verified contract a TLS-terminated TCP port carries no web
        # handler — web entries accompany HTTPS ports. Both at once is a
        # contradiction this build cannot resolve into an effective route.
        return observed(
            CLASSIFY_UNKNOWN, TRISTATE_UNKNOWN, REASON_UNRECOGNISED_DOCUMENT
        )

    if _funnel_exposed(document, host_port, dns_name):
        return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_FUNNEL_ENABLED)

    # Identity and target are verified positively, and each has its own
    # "could not check" outcome, because "we could not tell" and "it is
    # wrong" send a user to entirely different places.
    if dns_name is None:
        return observed(CLASSIFY_UNKNOWN, TRISTATE_YES, REASON_NO_DNS_IDENTITY)
    if normalize_dns_name(terminate) != dns_name:
        return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_FOREIGN_TLS_IDENTITY)

    if relay_port is None:
        return observed(CLASSIFY_UNKNOWN, TRISTATE_YES, REASON_NO_RELAY_PORT)
    if forward != f"{LOOPBACK}:{relay_port}":
        return observed(CLASSIFY_WRONG, TRISTATE_YES, REASON_FOREIGN_TARGET)

    return observed(CLASSIFY_READY, TRISTATE_YES, REASON_MATCHES)


def observe(
    *,
    relay_port: Optional[int],
    port: Optional[int] = None,
    timeout_s: float = READ_TIMEOUT_S,
    serve_runner: Optional[Callable[..., Any]] = None,
    status_runner: Optional[Callable[..., Any]] = None,
) -> ServeObservation:
    """Read both CLI surfaces and classify, in one bounded call.

    The collector's entrypoint. Two reads rather than one because the two
    facts come from different subcommands: the route table from ``serve
    status``, the node's own identity from ``status``.
    """
    document, read_code = read_serve_status(timeout_s=timeout_s, runner=serve_runner)
    dns_name, dns_code = read_node_dns_name(timeout_s=timeout_s, runner=status_runner)
    result = classify(
        document,
        dns_name=dns_name,
        relay_port=relay_port,
        port=port,
        read_code=read_code,
    )
    if read_code == READ_OK and dns_code != READ_OK:
        # The identity read failed. That only *blocks* a verdict when the
        # verdict actually needed an identity — an absent port, or an HTTPS
        # route on it, is conclusive without one. Overwriting the read code
        # regardless would leave a conclusive classification unstamped, so
        # the deriver would read "nobody looked" while the human section
        # printed a verdict. Report the failure only when it is the reason
        # there is no verdict.
        if result.reason == REASON_NO_DNS_IDENTITY:
            return result._replace(read_code=dns_code)
    return result


# -- the printed commands (P15 rung 1) ----------------------------------------
#
# These are strings a user runs. They are built here, once, from the same
# accessor the classifier used, so the command printed to fix a route and the
# route the classifier will then look for cannot disagree.
#
# Neither command carries a secret. The apply command names a tailnet port and
# a loopback port; the TLS identity is supplied by Tailscale from the node's
# own certificate, so the private DNS name never has to be interpolated into
# printed shell text at all.


def apply_command(*, relay_port: int, port: Optional[int] = None) -> str:
    """The exact command the user runs to apply OcuClaw's Serve route.

    Substituted, not a template: a user copies this line and it works. The
    ``--bg`` form is required — without it the route lives only as long as the
    foreground command, and the phone loses its front door when the terminal
    closes.
    """
    return (
        f"tailscale serve --bg --tls-terminated-tcp={serve_port(port)} "
        f"tcp://{LOOPBACK}:{int(relay_port)}"
    )


def teardown_command(*, port: Optional[int] = None) -> str:
    """The narrow teardown: this one route, off.

    Deliberately **not** ``tailscale serve reset``. Reset removes every Serve
    route on the host — on the development host that captured this lane's
    fixtures, eight routes belonging to other things — so shipping it as
    OcuClaw's uninstall step would have OcuClaw destroy configuration it never
    owned. The port-scoped ``off`` form is Tailscale's own documented
    disable-one-proxy instruction, and it is the only removal command this
    codebase prints.
    """
    return f"tailscale serve --tls-terminated-tcp={serve_port(port)} off"


def phone_address(*, dns_name: Optional[str], port: Optional[int] = None) -> Optional[str]:
    """The address the phone app connects to, or ``None`` if it cannot be known.

    This is the one string in this module that carries the private route
    authority, and it is returned rather than rendered. Its gating — route
    ``ready`` **and** gateway running — and the surfaces allowed to display it
    live with the presenters; see :mod:`cli`.
    """
    name = normalize_dns_name(dns_name)
    if name is None:
        return None
    return f"wss://{name}:{serve_port(port)}"


__all__ = [
    "CLASSIFICATIONS",
    "CLASSIFY_ABSENT",
    "CLASSIFY_READY",
    "CLASSIFY_UNKNOWN",
    "CLASSIFY_WRONG",
    "LOOPBACK",
    "READ_CODES",
    "READ_CLI_ABSENT",
    "READ_FAILED",
    "READ_OK",
    "READ_TIMEOUT",
    "READ_TIMEOUT_S",
    "READ_UNPARSABLE",
    "REASON_CODES",
    "SERVE_PORT_FALLBACK",
    "ServeObservation",
    "apply_command",
    "classify",
    "normalize_dns_name",
    "observe",
    "phone_address",
    "read_node_dns_name",
    "read_serve_status",
    "serve_port",
    "teardown_command",
]
