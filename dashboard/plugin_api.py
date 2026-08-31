"""OcuClaw dashboard snapshot plus direct-human Desktop pairing backend.

Hermes mounts ``router`` at ``/api/plugins/ocuclaw``.  The sole route derives
Snapshot v1 remains passive. The separate pairing routes proxy one active
host-owned setup ceremony to Hermes Desktop without exposing either pairing
secret to the renderer. This module never imports the runtime adapter.
"""

from __future__ import annotations

import importlib
import json
import secrets
import sys
import threading
import types
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple

try:
    from fastapi import APIRouter, Body, HTTPException
except ImportError as error:
    raise RuntimeError("The OcuClaw dashboard requires Hermes's FastAPI dependency") from error


router = APIRouter()

PLUGIN_NAME = "ocuclaw"
PLATFORM_RECEIPT_EMPIRICAL_TTL_S = 300.0
SETUP_GUIDE_VERSION = "2026-08-31 (1.3.18-hermes)"

_LEG_ORDER = (
    ("hermesGateway", "Hermes gateway"),
    ("ocuclawRelay", "OcuClaw relay"),
    ("tailnetRoute", "Private tailnet route"),
    ("phoneApp", "Phone app"),
)
_SETUP_STATES = {"configured", "incomplete", "invalid", "unavailable", "unsupported", "unknown"}
_HEALTH_STATES = {"healthy", "unhealthy", "unknown"}


def _load_bundle_modules() -> Tuple[Any, Any, Any, Any, Any, Any, Any, Any]:
    """Load adapter-free bundle modules under the host package or a test namespace."""
    candidates = []
    for name in tuple(sys.modules):
        if name.endswith(".adapter"):
            continue
        module = sys.modules.get(name)
        paths = getattr(module, "__path__", None)
        if not paths:
            continue
        try:
            if Path(next(iter(paths))).resolve() == Path(__file__).resolve().parents[1]:
                candidates.append(name)
        except (OSError, RuntimeError, StopIteration):
            continue
    candidates.extend(["hermes_plugins.ocuclaw", "ocuclaw_bundle"])
    for package in candidates:
        try:
            return tuple(
                importlib.import_module(f"{package}.{name}")
                for name in (
                    "health",
                    "receipts",
                    "snapshot",
                    "serve",
                    "pairing",
                    "tui_pairing",
                    "desktop_pairing",
                    "pairing_completion",
                )
            )  # type: ignore[return-value]
        except ImportError:
            continue

    # Dashboard-only processes may discover the API before PluginManager has
    # loaded the platform package.  Create a namespace package without running
    # bundle __init__.py (which intentionally imports adapter.py).
    package = "hermes_dashboard_ocuclaw_bundle"
    bundle_dir = Path(__file__).resolve().parents[1]
    namespace = types.ModuleType(package)
    namespace.__path__ = [str(bundle_dir)]  # type: ignore[attr-defined]
    namespace.__package__ = package
    sys.modules[package] = namespace
    return tuple(
        importlib.import_module(f"{package}.{name}")
        for name in (
            "health",
            "receipts",
            "snapshot",
            "serve",
            "pairing",
            "tui_pairing",
            "desktop_pairing",
            "pairing_completion",
        )
    )  # type: ignore[return-value]


(
    health,
    receipts,
    snapshot_module,
    serve,
    pairing,
    tui_pairing,
    desktop_pairing,
    pairing_completion,
) = _load_bundle_modules()


_PAIRING_LOCK = threading.Lock()
_PAIRING_SESSION: Optional[Dict[str, Any]] = None
_PAIRING_OPS = frozenset({"state", "approve", "deny", "cancel"})
_PAIRING_PHASE_ORDER = {"qr": 0, "words": 1, "deciding": 2, "outcome": 3}


def _build_direct_http_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


_DIRECT_HTTP_OPENER = _build_direct_http_opener()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _require_presenter_capability(payload: Any) -> str:
    supplied = (
        payload.get("presenterCapability") if isinstance(payload, Mapping) else None
    )
    expected = desktop_pairing.read_presenter_capability()
    if (
        not isinstance(supplied, str)
        or not expected
        or not secrets.compare_digest(supplied, expected)
    ):
        raise HTTPException(status_code=403, detail="Desktop presenter unavailable")
    return expected


def _direct_urlopen(request: urllib.request.Request, timeout: float):
    """Open one already-validated loopback request without environment proxies."""

    return _DIRECT_HTTP_OPENER.open(request, timeout=timeout)


def _valid_control_url(value: Any) -> bool:
    try:
        parsed = urllib.parse.urlsplit(str(value))
        port = parsed.port
    except (ValueError, TypeError):
        return False
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "::1"}
        and parsed.username is None
        and parsed.password is None
        and port is not None
        and parsed.path == pairing.CONTROL_PATH
        and not parsed.query
        and not parsed.fragment
    )


def _valid_callback_url(value: Any, run_id: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(str(value))
        port = parsed.port
    except (ValueError, TypeError):
        return False
    return (
        parsed.scheme == "http"
        and parsed.hostname == tui_pairing.ACTIVATION_HOST
        and parsed.username is None
        and parsed.password is None
        and port == tui_pairing.ACTIVATION_PORT
        and parsed.path == f"{tui_pairing.ACTIVATION_PATH}/result/{run_id}"
        and not parsed.query
        and not parsed.fragment
    )


def _activation_request() -> Optional[Dict[str, Any]]:
    capability = desktop_pairing.read_activation_capability()
    if capability is None or int(capability["expiresAtMs"]) <= _now_ms():
        return None
    request = urllib.request.Request(
        tui_pairing.ACTIVATION_URL,
        headers={
            tui_pairing.ACTIVATION_SURFACE_HEADER: "desktop",
            tui_pairing.ACTIVATION_CAPABILITY_HEADER: str(
                capability["claimCapability"]
            ),
        },
    )
    try:
        with _direct_urlopen(request, timeout=1.0) as response:
            if int(response.status) != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    expected = dict(capability)
    expected.pop("claimCapability")
    if not isinstance(payload, Mapping) or dict(payload) != expected:
        return None
    if not _valid_control_url(payload.get("controlUrl")):
        return None
    if not _valid_callback_url(payload.get("callbackUrl"), str(payload["runId"])):
        return None
    return dict(payload)


def _notify_activation(activation: Mapping[str, Any], state: str, code: str) -> bool:
    body = json.dumps(
        {"v": 1, "runId": activation["runId"], "state": state, "code": code},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        str(activation["callbackUrl"]),
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            tui_pairing.CALLBACK_HEADER: str(activation["callbackToken"]),
        },
    )
    try:
        with _direct_urlopen(request, timeout=1.0) as response:
            return 200 <= int(response.status) < 300
    except (OSError, urllib.error.URLError):
        return False


def _terminal_code(body: Mapping[str, Any]) -> str:
    failure = body.get("failure")
    reason = failure.get("reason") if isinstance(failure, Mapping) else None
    raw = str(reason or ("paired" if body.get("state") == "completed" else "pairing_failed"))
    safe = "".join(character for character in raw.lower() if character.isalnum() or character in "_-")
    return (safe or "pairing_failed")[:80]


def _public_pairing_state(session: Mapping[str, Any], body: Mapping[str, Any]) -> Dict[str, Any]:
    state = str(body.get("state") or "")
    if state in {"completed", "failed", "cancelled", "refused"}:
        failure = body.get("failure")
        failure_message = (
            str(failure.get("message") or "")[:240]
            if isinstance(failure, Mapping)
            else ""
        )
        return {
            "active": True,
            "sessionId": session["id"],
            "phase": "outcome",
            "outcomeState": "completed" if state == "completed" else "failed",
            "message": (
                "The phone connected back and the managed gateway confirmed it."
                if state == "completed"
                else failure_message or "Nothing was approved. You can retry this setup checkpoint."
            ),
        }
    decision_op = str(session.get("decisionOp") or "")
    if decision_op:
        messages = {
            "approve": "Approving and waiting for the phone…",
            "deny": "Refusing this phone…",
            "cancel": "Cancelling pairing…",
        }
        return {
            "active": True,
            "sessionId": session["id"],
            "phase": "deciding",
            "message": messages.get(decision_op, "Finishing pairing…"),
        }
    prompt = body.get("prompt")
    if isinstance(prompt, Mapping) and prompt.get("safetyPhraseText"):
        return {
            "active": True,
            "sessionId": session["id"],
            "phase": "words",
            "phoneLabel": str(prompt.get("phoneLabel") or "unknown device")[:240],
            "phrase": str(prompt.get("safetyPhraseText") or "")[:240],
        }
    return {"active": True, "sessionId": session["id"], "phase": "qr"}


def _remember_public_pairing_state(
    session: Dict[str, Any], public: Mapping[str, Any]
) -> Dict[str, Any]:
    """Cache the most advanced direct-human phase and never render backwards."""

    candidate = dict(public)
    if candidate.get("phase") == "qr":
        candidate["bootstrapBlock"] = str(session.get("bootstrapBlock") or "")
    previous = session.get("public")
    if isinstance(previous, Mapping):
        previous_phase = str(previous.get("phase") or "")
        candidate_phase = str(candidate.get("phase") or "")
        if _PAIRING_PHASE_ORDER.get(candidate_phase, -1) < _PAIRING_PHASE_ORDER.get(
            previous_phase, -1
        ):
            return dict(previous)
    if candidate.get("phase") == "words":
        session["phraseShown"] = True
    session["public"] = candidate
    return dict(candidate)


def _refresh_live_pairing(session: Dict[str, Any]) -> Dict[str, Any]:
    """Resume a remounted presenter from relay truth, with cached monotonic fallback."""

    cached = session.get("public")
    fallback = (
        dict(cached)
        if isinstance(cached, Mapping)
        else _remember_public_pairing_state(
            session,
            {"active": True, "sessionId": session["id"], "phase": "qr"},
        )
    )
    credential = pairing._read_relay_credential()
    control_secret = str(session.get("controlSecret") or "")
    if not credential or not control_secret:
        return fallback
    try:
        status, body = pairing._post(
            str(session["activation"]["controlUrl"]),
            {"v": 1, "op": "state"},
            credential=credential,
            control_secret=control_secret,
        )
    except pairing.ControlError:
        return fallback
    if status != 200 or not isinstance(body, Mapping):
        return fallback
    state = str(body.get("state") or "")
    if state in {"completed", "failed", "cancelled", "refused"}:
        return _finish_pairing(session, body)
    return _remember_public_pairing_state(
        session, _public_pairing_state(session, body)
    )


def _finish_pairing(session: Dict[str, Any], body: Mapping[str, Any]) -> Dict[str, Any]:
    public = _remember_public_pairing_state(
        session, _public_pairing_state(session, body)
    )
    session["terminal"] = public
    session["controlSecret"] = ""
    session["callbackState"] = (
        "completed" if body.get("state") == "completed" else "failed"
    )
    session["callbackCode"] = _terminal_code(body)
    session["callbackDelivered"] = False
    _deliver_terminal_callback(session)
    return public


def _deliver_terminal_callback(session: Dict[str, Any]) -> bool:
    if session.get("callbackDelivered") is True:
        return True
    delivered = _notify_activation(
        session["activation"],
        str(session.get("callbackState") or "failed"),
        str(session.get("callbackCode") or "pairing_failed"),
    )
    session["callbackDelivered"] = delivered
    terminal = session.get("terminal")
    if isinstance(terminal, dict):
        terminal["callbackDelivered"] = delivered
    return delivered


def _expire_pairing(session: Dict[str, Any]) -> Dict[str, Any]:
    credential = pairing._read_relay_credential()
    control_secret = str(session.get("controlSecret") or "")
    if credential and control_secret:
        try:
            pairing._post(
                str(session["activation"]["controlUrl"]),
                {"v": 1, "op": "cancel"},
                credential=credential,
                control_secret=control_secret,
            )
        except pairing.ControlError:
            pass
    session["controlSecret"] = ""
    public = _remember_public_pairing_state(
        session,
        {
            "active": True,
            "sessionId": session["id"],
            "phase": "outcome",
            "outcomeState": "failed",
            "message": "The pairing request expired. Nothing was approved.",
        },
    )
    session["terminal"] = public
    session["callbackState"] = "failed"
    session["callbackCode"] = "expired"
    session["callbackDelivered"] = False
    _deliver_terminal_callback(session)
    return public


def _timestamp(value: Any) -> Optional[datetime]:
    return snapshot_module.parse_timestamp(value)


def platform_receipt_gate(
    record: Optional[Mapping[str, Any]],
    status: str,
    *,
    observed_at: str,
) -> Dict[str, Any]:
    """The dashboard's only empirical gate: a five-minute platform receipt age."""
    now = _timestamp(observed_at)
    if status != "ok" or not isinstance(record, Mapping):
        reason = "missing" if status == "missing" else "rejected"
        return {"eligible": False, "status": reason, "ageSeconds": None}
    platforms = record.get("platforms")
    platform = platforms.get(PLUGIN_NAME) if isinstance(platforms, Mapping) else None
    if not isinstance(platform, Mapping):
        return {"eligible": False, "status": "missing-platform", "ageSeconds": None}
    stamp = _timestamp(platform.get("updated_at"))
    if now is None or stamp is None:
        return {"eligible": False, "status": "rejected", "ageSeconds": None}
    age = (now - stamp).total_seconds()
    if age < 0:
        return {"eligible": False, "status": "rejected", "ageSeconds": None}
    bounded = round(age, 3)
    if age > PLATFORM_RECEIPT_EMPIRICAL_TTL_S:
        return {"eligible": False, "status": "stale", "ageSeconds": bounded}
    return {"eligible": True, "status": "fresh", "ageSeconds": bounded}


def _causal_legs(
    snapshot: Mapping[str, Any], platform_gate: Mapping[str, Any]
) -> list[Dict[str, Any]]:
    raw_legs = ((snapshot.get("currentHealth") or {}).get("legs") or {})
    receipt_blocked = platform_gate.get("eligible") is not True
    blocked_by: Optional[str] = None
    result = []
    for key, label in _LEG_ORDER:
        raw = raw_legs.get(key) if isinstance(raw_legs, Mapping) else None
        raw = raw if isinstance(raw, Mapping) else {}
        source_state = raw.get("state") if raw.get("state") in _HEALTH_STATES else "unknown"
        if receipt_blocked:
            state = "unknown"
            unknown_because = None if key == "hermesGateway" else "hermesGateway"
        else:
            state = "unknown" if blocked_by else source_state
            unknown_because = blocked_by
        result.append(
            {
                "key": key,
                "label": label,
                "state": state,
                "sourceState": source_state,
                "unknownBecause": unknown_because,
                "evidenceIds": [
                    str(item)
                    for item in (raw.get("evidenceIds") or [])
                    if isinstance(item, str)
                ],
            }
        )
        if not receipt_blocked and blocked_by is None and source_state in {"unhealthy", "unknown"}:
            blocked_by = key
    return result


def _gated_current_health(
    canonical: Mapping[str, Any], platform_gate: Mapping[str, Any]
) -> Mapping[str, Any]:
    current = canonical.get("currentHealth")
    if platform_gate.get("eligible") is True or not isinstance(current, Mapping):
        return current if isinstance(current, Mapping) else {"state": "unknown", "legs": {}}
    gated = dict(current)
    raw_legs = current.get("legs")
    gated["state"] = "unknown"
    gated["legs"] = {
        key: {**dict(leg), "state": "unknown"}
        for key, leg in (raw_legs.items() if isinstance(raw_legs, Mapping) else ())
        if isinstance(leg, Mapping)
    }
    return gated


def _platform_gate_primary(platform_gate: Mapping[str, Any]) -> Dict[str, Any]:
    status = str(platform_gate.get("status") or "rejected")
    if status == "stale":
        summary = "Current connection health cannot be verified because the OcuClaw platform receipt is older than five minutes."
        freshness = "historical"
    elif status in {"missing", "missing-platform"}:
        summary = "Current connection health cannot be verified because no OcuClaw platform receipt is available."
        freshness = "unknown"
    else:
        summary = "Current connection health cannot be verified because the OcuClaw platform receipt was rejected."
        freshness = "rejected"
    return {
        "code": f"platform_receipt_{status}",
        "summary": summary,
        "consequence": "Current-health claims, the private phone address, and repair guidance are withheld until a fresh receipt is observed.",
        "evidenceAgeSeconds": platform_gate.get("ageSeconds"),
        "evidenceFreshness": freshness,
        "repair": None,
    }


def _evidence_index(snapshot: Mapping[str, Any]) -> Dict[str, Mapping[str, Any]]:
    return {
        str(item.get("id")): item
        for item in (snapshot.get("evidence") or [])
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }


def _age_seconds(value: Any, generated_at: Any) -> Optional[int]:
    observed = _timestamp(value)
    generated = _timestamp(generated_at)
    if observed is None or generated is None:
        return None
    age = int((generated - observed).total_seconds())
    return age if age >= 0 else None


def _primary(snapshot: Mapping[str, Any], legs: list[Mapping[str, Any]]) -> Dict[str, Any]:
    findings = [item for item in (snapshot.get("findings") or []) if isinstance(item, Mapping)]
    evidence = _evidence_index(snapshot)
    finding = findings[0] if findings else None
    if finding is not None:
        evidence_ids = [item for item in (finding.get("evidenceIds") or []) if isinstance(item, str)]
        supporting_evidence = [evidence[item] for item in evidence_ids if item in evidence]
        freshness_values = [
            item.get("freshness")
            for item in supporting_evidence
            if item.get("freshness") in {"fresh", "historical", "rejected"}
        ]
        if not supporting_evidence or len(supporting_evidence) != len(evidence_ids):
            freshness = "unknown"
        elif "rejected" in freshness_values:
            freshness = "rejected"
        elif "historical" in freshness_values:
            freshness = "historical"
        elif freshness_values and len(freshness_values) == len(supporting_evidence):
            freshness = "fresh"
        else:
            freshness = "unknown"
        ages = [
            age
            for item in supporting_evidence
            for age in [_age_seconds(item.get("observedAt"), snapshot.get("generatedAt"))]
            if age is not None
        ]
        age = max(ages) if ages else None
        if freshness == "rejected":
            explanation = "The available evidence was rejected, so this page will not guess at a repair."
        elif freshness == "historical":
            explanation = "The evidence is historical; it explains what was seen but cannot prove current health."
        else:
            explanation = "This is the first authoritative finding in the canonical snapshot."
        return {
            "code": str(finding.get("code") or "unknown_finding"),
            "summary": str(finding.get("summary") or "OcuClaw found a condition that needs attention."),
            "consequence": explanation,
            "evidenceAgeSeconds": age,
            "evidenceFreshness": freshness,
            "repair": finding.get("repair") if isinstance(finding.get("repair"), Mapping) else None,
        }
    first_nonhealthy = next((leg for leg in legs if leg.get("state") != "healthy"), None)
    if first_nonhealthy is not None:
        return {
            "code": "evidence_incomplete",
            "summary": f"{first_nonhealthy.get('label')} cannot be verified from current evidence.",
            "consequence": "No authoritative repair is offered until the missing or stale evidence is refreshed explicitly.",
            "evidenceAgeSeconds": None,
            "evidenceFreshness": "unknown",
            "repair": None,
        }
    return {
        "code": "none",
        "summary": "All four connection legs are healthy.",
        "consequence": "No recovery action is needed.",
        "evidenceAgeSeconds": 0,
        "evidenceFreshness": "fresh",
        "repair": None,
    }


def _safe_action(
    snapshot: Mapping[str, Any], facts: Mapping[str, Any], primary: Mapping[str, Any]
) -> Optional[Dict[str, Any]]:
    setup_state = (snapshot.get("setup") or {}).get("state")
    freshness = primary.get("evidenceFreshness")
    if setup_state in {"incomplete", "invalid", "unavailable", "unsupported"}:
        return {
            "label": "Copy guided setup command",
            "command": "/ocuclaw-setup",
            "teardown": None,
            "note": "Copy only. This page does not run setup or start pairing.",
        }
    if setup_state == "unknown" or freshness in {"unknown", "rejected", "historical"}:
        return None
    repair = primary.get("repair")
    code = repair.get("code") if isinstance(repair, Mapping) else None
    if code == "apply_serve_route":
        relay_port = facts.get("serveRelayPort")
        if isinstance(relay_port, bool) or not isinstance(relay_port, int):
            return None
        return {
            "label": "Copy exact route repair",
            "command": serve.apply_command(relay_port=relay_port),
            "teardown": serve.teardown_command(),
            "note": "Copy only. The paired teardown removes only OcuClaw's :8446 route.",
        }
    if code in {"pair_phone_app", "start_hermes_gateway", "restart_hermes_gateway"}:
        return {
            "label": "Copy guided recovery command",
            "command": "/ocuclaw-setup",
            "teardown": None,
            "note": "Copy only. The Setup Assistant owns recovery and pairing initiation.",
        }
    return None


def _verified_phone_address(snapshot: Mapping[str, Any], facts: Mapping[str, Any]) -> Optional[str]:
    current_health = snapshot.get("currentHealth") or {}
    if not isinstance(current_health, Mapping) or current_health.get("state") != "healthy":
        return None
    legs = ((snapshot.get("currentHealth") or {}).get("legs") or {})
    gateway = legs.get("hermesGateway") if isinstance(legs, Mapping) else None
    route = legs.get("tailnetRoute") if isinstance(legs, Mapping) else None
    if not isinstance(gateway, Mapping) or gateway.get("state") != "healthy":
        return None
    if not isinstance(route, Mapping):
        return None
    if not all(route.get(key) == "yes" for key in ("configured", "reachable", "applicationReady")):
        return None
    dns_name = serve.normalize_dns_name(facts.get("serveNodeDnsName"))
    # The source is Tailscale's own node identity; accepting an arbitrary
    # hostname-shaped string here would create a free-text route into output.
    if dns_name is None or not dns_name.endswith(".ts.net"):
        return None
    return serve.phone_address(dns_name=dns_name)


def build_dashboard_payload(
    facts: Mapping[str, Any],
    platform_receipt: Optional[Mapping[str, Any]],
    platform_status: str,
    *,
    platform_observed_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Pure presenter seam: frozen facts in, secret-free dashboard document out."""
    canonical = snapshot_module.derive_snapshot(facts)
    snapshot_module.validate_snapshot_key_set(canonical)
    platform_gate = platform_receipt_gate(
        platform_receipt,
        platform_status,
        observed_at=platform_observed_at or str(canonical.get("generatedAt") or ""),
    )
    setup = canonical.get("setup") or {}
    setup_state = setup.get("state") if setup.get("state") in _SETUP_STATES else "unknown"
    health_state = (canonical.get("currentHealth") or {}).get("state")
    health_state = health_state if health_state in _HEALTH_STATES else "unknown"
    if platform_gate.get("eligible") is not True:
        health_state = "unknown"
    proof_state = (canonical.get("firstRunProof") or {}).get("state") or "unknown"
    legs = _causal_legs(canonical, platform_gate)
    primary = (
        _primary(canonical, legs)
        if platform_gate.get("eligible") is True
        else _platform_gate_primary(platform_gate)
    )
    action = _safe_action(canonical, facts, primary)
    address = (
        _verified_phone_address(canonical, facts)
        if platform_gate.get("eligible") is True
        else None
    )
    current_health = _gated_current_health(canonical, platform_gate)

    if setup_state != "configured":
        outcome = "Hermes setup needs attention before connection recovery can continue."
    elif health_state == "healthy":
        outcome = "OcuClaw is healthy across the gateway, relay, private route, and phone app."
    elif health_state == "unhealthy":
        outcome = "OcuClaw is configured, but the current connection path has an authoritative failure."
    else:
        outcome = "OcuClaw is configured, but current connection health cannot be fully verified."
    if proof_state == "proven" and health_state != "healthy":
        outcome += " It worked on G2 before; that history does not make today's connection healthy."

    producer = canonical.get("producer") or {}
    profile = canonical.get("profile") or {}
    if health_state == "healthy" and proof_state == "proven":
        next_checkpoint = "No recovery checkpoint is needed; the prior G2 proof remains durable."
    elif health_state == "healthy":
        next_checkpoint = "Continue in /ocuclaw-setup for phone connection and G2 confirmation."
    else:
        next_checkpoint = "Run doctor explicitly when bounded active verification is needed."
    payload = {
        "contract": "ocuclaw.guided-recovery-dashboard",
        "contractVersion": 1,
        "readOnly": True,
        "header": {
            "purpose": "Guided recovery for OcuClaw on Hermes",
            "profileName": profile.get("name"),
            "profileFingerprint": profile.get("hermesHomeFingerprint"),
            "observedAt": canonical.get("generatedAt"),
            "evidenceMode": canonical.get("observationMode"),
        },
        "outcome": outcome,
        "causalPath": legs,
        "primary": primary,
        "safeAction": action,
        "truths": {
            "setup": setup,
            "currentHealth": current_health,
            "firstRunProof": canonical.get("firstRunProof"),
        },
        "verifiedPhoneAddress": address,
        "pairing": {
            "command": "/ocuclaw-setup",
            "qr": "QR pairing uses the private address and an approved encrypted exchange.",
            "manual": "Manual pairing uses the private address plus a short-lived pairing code.",
        },
        "provenance": {
            "hermesRelease": producer.get("hermesRelease"),
            "hermesPackageVersion": producer.get("hermesPackageVersion"),
            "certifiedSource": health.CERTIFIED_HERMES_COMMIT,
            "hermesSource": producer.get("hermesSource"),
            "ocuclawVersion": producer.get("ocuclawVersion"),
            "setupGuideVersion": SETUP_GUIDE_VERSION,
            "snapshotContractVersion": canonical.get("contractVersion"),
            "profileFingerprint": profile.get("hermesHomeFingerprint"),
        },
        "checkpoints": {
            "doctorCommand": "hermes ocuclaw doctor",
            "note": "Run explicitly for bounded active checks. This page never initiates the probe.",
            "next": next_checkpoint,
        },
        "support": {
            "first": "/ocuclaw-setup",
            "connected": (
                "Open OcuClaw's built-in Report a bug feature and send the "
                "scrubbed diagnostic report."
            ),
            "offline": "Use Save in the phone app when disconnected.",
            "sharing": "Share only the scrubbed report reference in the OcuClaw Discord community.",
        },
        "platformReceiptGate": platform_gate,
        "snapshot": canonical,
    }
    rendered = json.dumps(payload, sort_keys=True)
    if any(forbidden in rendered for forbidden in ("tokenValue", "rawProfilePath")):
        raise ValueError("dashboard payload crossed a forbidden secret boundary")
    return payload


@router.get("/snapshot")
def get_snapshot() -> Dict[str, Any]:
    record, status, live = receipts.read_gateway_state()
    platform_observed_at = snapshot_module.now_iso()
    # Snapshot v1 freezes adapterLinkReady as a boolean. False means that this
    # process has no positive in-process link evidence; the canonical deriver
    # then falls through to this independently qualified gateway receipt. It
    # is not rendered as an observed link failure.
    facts = health.collect_health_facts(
        adapters=(),
        gateway_facts_fn=lambda: health.gateway_facts_from_receipt(
            record, status, live
        ),
    )
    return build_dashboard_payload(
        facts,
        record,
        status,
        platform_observed_at=platform_observed_at,
    )


@router.get("/setup-card")
def get_setup_card() -> Dict[str, Any]:
    """Answer the Desktop post-install card. Reaching this route IS the proof.

    This route answers exactly ONE question: has pairing completed? ``paired``
    reads the durable completion receipt the phone's authenticated callback
    writes (``_handle_pairing_completed``), not a renderer-side memory, so the
    card stays retired across Desktop reinstalls and fresh renderer storage.
    Booleans only: no address, token, or capability crosses this boundary, so
    the route needs no presenter capability the way the ceremony routes do.

    It deliberately does NOT report whether the gateway loaded OcuClaw, even
    though an earlier draft did and it looks like the natural place for it.
    Hermes mounts a dashboard plugin's router in the WEB SERVER
    (``hermes_cli.web_server._mount_plugin_api_routes``, prefix
    ``/api/plugins/<name>/``) at the web server's OWN startup, gated
    per-request only by the ``plugins.enabled`` allow-list. That is not a fact
    about the gateway process. Proved live on 0.20.6: with the gateway stopped,
    this route answered 200 while the same host reported
    ``gateway_running: false, gateway_state: "stopped"`` -- so a
    ``pluginLoaded: True`` here would have been a straight lie, and the card
    would have announced "OcuClaw ready" with no gateway running. The card now
    reads the gateway's own ``gateway_platforms`` for that, and asks this route
    only once the gateway says OcuClaw is loaded.
    """

    return {
        "contract": "ocuclaw.desktop-setup-card",
        "contractVersion": 1,
        "paired": pairing_completion.read_pairing_completion() is not None,
    }


@router.post("/pairing/claim")
def claim_desktop_pairing(payload: Any = Body(...)) -> Dict[str, Any]:
    """Claim one Desktop activation and start its relay exchange server-side."""

    global _PAIRING_SESSION
    presenter_capability = _require_presenter_capability(payload)
    with _PAIRING_LOCK:
        if _PAIRING_SESSION is not None:
            if _PAIRING_SESSION.get("terminal") is not None:
                terminal_expired = (
                    int(_PAIRING_SESSION["activation"]["expiresAtMs"]) <= _now_ms()
                )
                if not terminal_expired:
                    _deliver_terminal_callback(_PAIRING_SESSION)
                if (
                    not terminal_expired
                    and _PAIRING_SESSION.get("callbackDelivered") is not True
                ):
                    return dict(_PAIRING_SESSION["terminal"])
                _PAIRING_SESSION = None
            elif int(_PAIRING_SESSION["activation"]["expiresAtMs"]) > _now_ms():
                return _refresh_live_pairing(_PAIRING_SESSION)
            else:
                _expire_pairing(_PAIRING_SESSION)
                _PAIRING_SESSION = None

        activation = _activation_request()
        if activation is None:
            return {"active": False}
        session = {
            "id": secrets.token_urlsafe(24),
            "activation": activation,
            "controlSecret": "",
            "bootstrapBlock": "",
            "phraseShown": False,
            "public": None,
            "terminal": None,
            "presenterCapability": presenter_capability,
        }
        credential = pairing._read_relay_credential()
        if not credential:
            failure = {"state": "failed", "failure": {"reason": "relay_credential_missing"}}
            _PAIRING_SESSION = session
            return _finish_pairing(session, failure)
        try:
            status, created = pairing._post(
                str(activation["controlUrl"]),
                {
                    "v": 1,
                    "op": "create",
                    "address": activation["address"],
                    "lightTerminal": True,
                },
                credential=credential,
            )
        except pairing.ControlError:
            status, created = 503, {}
        control_secret = str(created.get("controlSecret") or "")
        bootstrap = str(created.get("bootstrapBlock") or "")
        if status != 200 or not control_secret or not bootstrap:
            failure = {
                "state": "failed",
                "failure": {
                    "reason": str(created.get("reason") or "create_refused"),
                    "message": str(created.get("message") or "The relay refused pairing."),
                },
            }
            _PAIRING_SESSION = session
            return _finish_pairing(session, failure)
        session["controlSecret"] = control_secret
        session["bootstrapBlock"] = bootstrap
        _PAIRING_SESSION = session
        return _remember_public_pairing_state(
            session,
            {"active": True, "sessionId": session["id"], "phase": "qr"},
        )


@router.post("/pairing/{session_id}")
def drive_desktop_pairing(
    session_id: str, payload: Any = Body(...)
) -> Dict[str, Any]:
    """Drive one claimed ceremony; approval is accepted only after words served."""

    op = payload.get("op") if isinstance(payload, Mapping) else None
    presenter_capability = _require_presenter_capability(payload)
    if (
        op not in _PAIRING_OPS
        or not isinstance(payload, Mapping)
        or set(payload) != {"op", "presenterCapability"}
    ):
        raise HTTPException(status_code=400, detail="invalid pairing command")
    global _PAIRING_SESSION
    with _PAIRING_LOCK:
        session = _PAIRING_SESSION
        if session is None or not secrets.compare_digest(str(session["id"]), session_id):
            raise HTTPException(status_code=404, detail="pairing ceremony unavailable")
        if not secrets.compare_digest(
            str(session.get("presenterCapability") or ""), presenter_capability
        ):
            raise HTTPException(status_code=403, detail="Desktop presenter unavailable")
        if session.get("terminal") is not None:
            if int(session["activation"]["expiresAtMs"]) <= _now_ms():
                public = dict(session["terminal"])
                _PAIRING_SESSION = None
                return public
            _deliver_terminal_callback(session)
            return dict(session["terminal"])
        if int(session["activation"]["expiresAtMs"]) <= _now_ms():
            public = _expire_pairing(session)
            _PAIRING_SESSION = None
            return public
        if op == "approve" and session.get("phraseShown") is not True:
            raise HTTPException(status_code=409, detail="safety phrase not presented")
        credential = pairing._read_relay_credential()
        if not credential or not session.get("controlSecret"):
            raise HTTPException(status_code=409, detail="pairing ceremony unavailable")
        try:
            status, body = pairing._post(
                str(session["activation"]["controlUrl"]),
                {"v": 1, "op": op},
                credential=credential,
                control_secret=str(session["controlSecret"]),
            )
        except pairing.ControlError as error:
            raise HTTPException(status_code=503, detail="local relay unavailable") from error
        if status != 200:
            raise HTTPException(status_code=409, detail="pairing command refused")
        state = str(body.get("state") or "")
        if state in {"completed", "failed", "cancelled", "refused"}:
            return _finish_pairing(session, body)
        if op in {"approve", "deny", "cancel"}:
            session["decisionOp"] = op
        return _remember_public_pairing_state(
            session, _public_pairing_state(session, body)
        )


__all__ = [
    "PLATFORM_RECEIPT_EMPIRICAL_TTL_S",
    "build_dashboard_payload",
    "claim_desktop_pairing",
    "drive_desktop_pairing",
    "get_snapshot",
    "platform_receipt_gate",
    "router",
]
