"""Safe plan for the optional private Even-AI ``:8443`` Serve route.

This route is intentionally separate from :mod:`serve`, which owns the
``:8446`` Managed Serve Route used by the phone.  Planning is read-only.  The
setup assistant may run the returned command only after explicit approval and
must classify a fresh live Serve document afterward.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Mapping, NamedTuple, Optional, Tuple

from . import serve as serve_contract
from .serve import normalize_dns_name


EVEN_AI_SERVE_PORT = 8443
LOOPBACK = "127.0.0.1"
_TARGET_RE = re.compile(r"^http://(127\.0\.0\.1|localhost):([0-9]{1,5})$")
_KNOWN_TOP_LEVEL_KEYS = frozenset(
    {"TCP", "Web", "AllowFunnel", "ETag", "Services", "Foreground"}
)


class EvenAiRouteDecision(NamedTuple):
    state: str
    reason: str
    command: Optional[str]
    agent_url: Optional[str]
    requires_approval: bool
    may_mutate: bool
    explanation: str


def _apply_command(relay_port: int) -> str:
    return (
        f"tailscale serve --bg --https={EVEN_AI_SERVE_PORT} "
        f"http://{LOOPBACK}:{int(relay_port)}"
    )


def _agent_url(dns_name: Optional[str]) -> Optional[str]:
    normalized = normalize_dns_name(dns_name)
    if normalized is None:
        return None
    return (
        f"https://{normalized}:{EVEN_AI_SERVE_PORT}/v1/chat/completions"
    )


def _decision(
    *,
    state: str,
    reason: str,
    dns_name: Optional[str],
    explanation: str,
    command: Optional[str] = None,
    requires_approval: bool = False,
    may_mutate: bool = False,
) -> EvenAiRouteDecision:
    return EvenAiRouteDecision(
        state=state,
        reason=reason,
        command=command,
        agent_url=_agent_url(dns_name),
        requires_approval=requires_approval,
        may_mutate=may_mutate,
        explanation=explanation,
    )


def _funnel_exposes_8443(document: Mapping[str, Any]) -> Optional[bool]:
    if "AllowFunnel" not in document:
        return False
    funnel = document["AllowFunnel"]
    if not isinstance(funnel, Mapping):
        return None
    return any(
        isinstance(key, str)
        and key.rsplit(":", 1)[-1] == str(EVEN_AI_SERVE_PORT)
        and bool(value)
        for key, value in funnel.items()
    )


def _foreground_route_at_8443(document: Mapping[str, Any]) -> Optional[str]:
    if "Foreground" not in document:
        return None
    foreground = document.get("Foreground")
    if not isinstance(foreground, Mapping):
        return "ambiguous_target"
    port = str(EVEN_AI_SERVE_PORT)
    for session in foreground.values():
        if not isinstance(session, Mapping):
            return "ambiguous_target"
        if set(session) - {"TCP", "Web", "AllowFunnel"}:
            return "ambiguous_target"
        tcp = session.get("TCP", {})
        if not isinstance(tcp, Mapping) or any(not isinstance(key, str) for key in tcp):
            return "ambiguous_target"
        if port in tcp:
            return "foreground_route"
        web = session.get("Web", {})
        if not isinstance(web, Mapping) or any(not isinstance(key, str) for key in web):
            return "ambiguous_target"
        if any(key.rsplit(":", 1)[-1] == port for key in web):
            return "foreground_route"
        funnel = session.get("AllowFunnel", {})
        if not isinstance(funnel, Mapping):
            return "ambiguous_target"
        if any(
            isinstance(key, str)
            and key.rsplit(":", 1)[-1] == port
            and bool(value)
            for key, value in funnel.items()
        ):
            return "funnel_exposed"
    return None


def _web_route_at_8443(document: Mapping[str, Any]) -> tuple[str, Any, Optional[str]]:
    if "Web" not in document:
        return "absent", None, None
    web = document.get("Web")
    if not isinstance(web, Mapping):
        return "ambiguous", None, None
    if any(not isinstance(key, str) for key in web):
        return "ambiguous", None, None
    entries = [
        (key, value)
        for key, value in web.items()
        if isinstance(key, str)
        and key.rsplit(":", 1)[-1] == str(EVEN_AI_SERVE_PORT)
    ]
    if not entries:
        return "absent", None, None
    if len(entries) != 1 or not isinstance(entries[0][1], Mapping):
        return "ambiguous", None, None
    route_key, route = entries[0]
    route_host = normalize_dns_name(route_key.rsplit(":", 1)[0])
    if route_host is None:
        return "ambiguous", None, None
    handlers = route.get("Handlers")
    if not isinstance(handlers, Mapping) or set(handlers) != {"/"}:
        return "ambiguous", None, None
    root = handlers.get("/")
    if isinstance(root, Mapping) and "Proxy" not in root:
        return "web_handler", None, route_host
    if not isinstance(root, Mapping) or set(root) != {"Proxy"}:
        return "ambiguous", None, route_host
    return "target", root.get("Proxy"), route_host


def plan(
    document: Mapping[str, Any],
    *,
    dns_name: Optional[str],
    relay_port: int,
    selected_runtime: str = "hermes",
    known_runtime_ports: Optional[Mapping[str, int]] = None,
) -> EvenAiRouteDecision:
    """Plan the private route from already-read live Tailscale evidence."""
    normalized_dns = normalize_dns_name(dns_name)
    if normalized_dns is None:
        return _decision(
            state="refused",
            reason="tailnet_identity_unknown",
            dns_name=dns_name,
            explanation="This host's tailnet DNS name is unknown; no route will be changed.",
        )
    if not isinstance(relay_port, int) or isinstance(relay_port, bool) or not 1 <= relay_port <= 65535:
        return _decision(
            state="refused",
            reason="relay_port_unknown",
            dns_name=dns_name,
            explanation="The selected Primary Runtime's local relay port is unknown; no route will be changed.",
        )
    known_runtime_ports = known_runtime_ports or {selected_runtime: relay_port}
    if (
        not isinstance(selected_runtime, str)
        or not selected_runtime.strip()
        or not isinstance(known_runtime_ports, Mapping)
        or any(
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(value, int)
            or isinstance(value, bool)
            or not 1 <= value <= 65535
            for name, value in known_runtime_ports.items()
        )
    ):
        return _decision(
            state="refused",
            reason="runtime_inventory_unknown",
            dns_name=dns_name,
            explanation="The live Primary Runtime inventory is unreadable; no route will be changed.",
        )
    if not isinstance(document, Mapping):
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="The live Serve document is unreadable; no route will be changed.",
        )
    if set(document) - _KNOWN_TOP_LEVEL_KEYS:
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="The live Serve document has unknown routing fields; no route will be changed.",
        )
    if "Services" in document and not isinstance(document["Services"], Mapping):
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="The live Serve services table is unreadable; no route will be changed.",
        )
    foreground_reason = _foreground_route_at_8443(document)
    if foreground_reason is not None:
        return _decision(
            state="refused",
            reason=foreground_reason,
            dns_name=dns_name,
            explanation=(
                "A foreground Serve session controls or may expose :8443; "
                "the background route will not be changed."
            ),
        )

    funnel = _funnel_exposes_8443(document)
    if funnel is None:
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="The Funnel state for :8443 is unreadable; no route will be changed.",
        )
    if funnel:
        return _decision(
            state="refused",
            reason="funnel_exposed",
            dns_name=dns_name,
            explanation="Port :8443 is exposed through Funnel; OcuClaw will not mutate a public route.",
        )

    tcp_value = document.get("TCP", {})
    if not isinstance(tcp_value, Mapping):
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="The live :8443 TCP state is unreadable; no route will be changed.",
        )
    tcp = tcp_value
    if any(not isinstance(key, str) for key in tcp):
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="The live :8443 TCP table has an unknown key shape; no route will be changed.",
        )
    port = str(EVEN_AI_SERVE_PORT)
    web_state, target, route_host = _web_route_at_8443(document)
    if port not in tcp and web_state == "absent":
        return _decision(
            state="approval_required",
            reason="route_absent",
            dns_name=dns_name,
            command=_apply_command(relay_port),
            requires_approval=True,
            may_mutate=True,
            explanation=(
                "Creates a tailnet only HTTPS route on :8443 to this "
                "Runtime Bundle's loopback relay. It does not use Funnel "
                "or change the :8446 phone route."
            ),
        )

    if web_state == "web_handler":
        return _decision(
            state="refused",
            reason="web_handler",
            dns_name=dns_name,
            explanation="Port :8443 already has a non-proxy web handler; no route will be changed.",
        )
    if route_host is not None and route_host != normalized_dns:
        return _decision(
            state="refused",
            reason="foreign_service",
            dns_name=dns_name,
            explanation="Port :8443 belongs to a different tailnet identity; no route will be changed.",
        )
    entry = tcp.get(port)
    if entry != {"HTTPS": True} or web_state != "target":
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="Port :8443 has an ambiguous route shape; no route will be changed.",
        )
    if not isinstance(target, str):
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="Port :8443 has an unreadable target; no route will be changed.",
        )
    match = _TARGET_RE.match(target)
    if match is None:
        return _decision(
            state="refused",
            reason="foreign_service",
            dns_name=dns_name,
            explanation="Port :8443 belongs to a foreign web service; no route will be changed.",
        )
    target_port = int(match.group(2))
    if not 1 <= target_port <= 65535:
        return _decision(
            state="refused",
            reason="ambiguous_target",
            dns_name=dns_name,
            explanation="Port :8443 has an invalid local target; no route will be changed.",
        )
    if target_port == int(relay_port):
        return _decision(
            state="verified_noop",
            reason="route_matches",
            dns_name=dns_name,
            explanation="The tailnet-only :8443 route already targets the selected Primary Runtime.",
        )
    other_runtime = next(
        (
            name
            for name, port_value in known_runtime_ports.items()
            if name != selected_runtime and port_value == target_port
        ),
        None,
    )
    if other_runtime is not None:
        return _decision(
            state="refused",
            reason="different_primary_runtime",
            dns_name=dns_name,
            explanation=(
                f"Port :8443 already targets the {other_runtime} Runtime Bundle; "
                "the Primary Runtime will not be changed silently."
            ),
        )
    return _decision(
        state="refused",
        reason="foreign_service",
        dns_name=dns_name,
        explanation="Port :8443 belongs to a foreign local service; no route will be changed.",
    )


def plan_live(
    *,
    relay_port: int,
    selected_runtime: str = "hermes",
    known_runtime_ports: Optional[Mapping[str, int]] = None,
    serve_reader: Callable[..., Tuple[Optional[Mapping[str, Any]], str]] = serve_contract.read_serve_status,
    dns_reader: Callable[..., Tuple[Optional[str], str]] = serve_contract.read_node_dns_name,
) -> EvenAiRouteDecision:
    """Read the two supported Tailscale surfaces and return one safe plan."""
    document, serve_code = serve_reader()
    dns_name, dns_code = dns_reader()
    if document is None:
        return _decision(
            state="refused",
            reason="serve_state_unavailable",
            dns_name=dns_name,
            explanation=f"The live Serve document is unavailable ({serve_code}); no route will be changed.",
        )
    if dns_name is None:
        return _decision(
            state="refused",
            reason="tailnet_identity_unknown",
            dns_name=None,
            explanation=f"This host's live tailnet identity is unavailable ({dns_code}); no route will be changed.",
        )
    return plan(
        document,
        dns_name=dns_name,
        relay_port=relay_port,
        selected_runtime=selected_runtime,
        known_runtime_ports=known_runtime_ports,
    )


def verify_after_apply(
    proposed: EvenAiRouteDecision,
    document: Mapping[str, Any],
    *,
    dns_name: Optional[str],
    relay_port: int,
    selected_runtime: str = "hermes",
    known_runtime_ports: Optional[Mapping[str, int]] = None,
) -> EvenAiRouteDecision:
    """Verify a fresh live Serve document after an approved external apply."""
    if proposed.state != "approval_required" or not proposed.requires_approval:
        return _decision(
            state="refused",
            reason="apply_not_approved",
            dns_name=dns_name,
            explanation="No approved route proposal exists to verify.",
        )
    observed = plan(
        document,
        dns_name=dns_name,
        relay_port=relay_port,
        selected_runtime=selected_runtime,
        known_runtime_ports=known_runtime_ports,
    )
    if observed.state == "verified_noop":
        return observed._replace(state="verified")
    return _decision(
        state="refused",
        reason="apply_not_observed",
        dns_name=dns_name,
        explanation=(
            "The approved command ran, but a fresh live Serve read did not "
            f"show the requested route ({observed.reason})."
        ),
    )


__all__ = [
    "EVEN_AI_SERVE_PORT",
    "EvenAiRouteDecision",
    "plan",
    "plan_live",
    "verify_after_apply",
]
