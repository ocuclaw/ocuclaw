"""Manual Even AI route observations. No credential, config or Serve writes."""
from __future__ import annotations

import argparse
import json
from typing import Any

from . import even_ai_route, optional_setup


def observe(*, action: str = "route", status_reader=None, planner=None) -> dict[str, Any]:
    status_reader = status_reader or optional_setup.status
    planner = planner or even_ai_route.plan_live

    def refused(reason: str, next_action: str) -> dict[str, Any]:
        return {"ok": False, "runtime": "hermes", "capability": "even-ai",
                "status": "unavailable", "reason": reason,
                "requestVerification": "not-verified", "action": next_action}

    if action not in {"route", "verify"}:
        return refused("unsupported_action", "Use hermes ocuclaw even-ai route or verify.")
    try:
        before = status_reader()
        context = before.get("runtimeContext")
        port = context.get("relayPort") if isinstance(context, dict) else None
        if (before.get("state") != "ready" or not isinstance(port, int)
                or isinstance(port, bool) or not 1 <= port <= 65535):
            return refused("live_runtime_context_unavailable",
                           "Run hermes ocuclaw optional-setup status. Finish your chosen saves, activate once if requested, then reconnect and retry. The running relay's current port must be observed; no default port was guessed.")
        decision = planner(relay_port=port, selected_runtime="hermes",
                           known_runtime_ports={"hermes": port})
        after = status_reader()
        if (after.get("state") != "ready" or after.get("runtimeContext") != context
                or after.get("capabilities") != before.get("capabilities")):
            return refused("runtime_context_changed", "The selected runtime changed during observation. Reconnect and re-run route before applying any command.")
        capability_state = before.get("capabilities", {}).get("evenAi")
        activated = capability_state == "available_to_test"
        inactive_status = {"not_configured": "not-configured", "saved_not_activated": "saved",
                           "save_failed": "save-failed"}.get(capability_state, "unknown")
        route_ready = decision.state == "verified_noop"
        if decision.state == "approval_required":
            next_action = ("Optional, tailnet only: re-run route immediately before applying its exact command yourself. "
                           "Cancel by not running it; the phone route is kept. After the human pause run hermes ocuclaw even-ai verify.")
        elif route_ready and activated:
            next_action = ("Route shape and activation are ready to test. Use agent_url and your existing private token in Even app Agent Configuration, "
                           "select that agent, then make a real Even AI glasses request. This observation does not verify that request.")
        elif route_ready:
            next_action = "The route matches, but Even AI activation is not observed. Finish optional-setup save even-ai and the grouped activation, then re-read status."
        else:
            next_action = decision.explanation + " Preserve the phone route. Do not replace another service or enable Funnel."
        return {"ok": decision.state != "refused" and (action != "verify" or route_ready),
                "runtime": "hermes", "capability": "even-ai",
                "status": "available-to-test" if route_ready and activated else "active" if activated else inactive_status,
                "activation": "active" if activated else "pending", "requestVerification": "not-verified",
                "route": decision._asdict(), "agentUrl": decision.agent_url, "action": next_action}
    except Exception:
        return refused("observation_unavailable", "Host observations could not be read safely. Run hermes ocuclaw optional-setup status and retry on the selected Primary Runtime. Existing settings and routes were kept.")


def register_cli(subs) -> None:
    parser = subs.add_parser("even-ai", help="Observe and print the optional private Even AI route")
    commands = parser.add_subparsers(dest="even_ai_action", required=True)
    commands.add_parser("route", help="Print an exact user-run proposal; never changes Serve")
    commands.add_parser("verify", help="Re-observe route shape after a human pause; not a glasses request test")


def dispatch(args: argparse.Namespace) -> int:
    report = observe(action=args.even_ai_action)
    print(json.dumps(report, sort_keys=True))
    return 0 if report["ok"] else 1
