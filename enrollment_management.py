"""The phone's Agents lane: read the enrollment set, enrol, remove (#2940).

Three operations on the shared management link, all at ``gateway`` scope
because the enrollment set is one host-wide answer rather than a property of
any one profile:

``agents.list``
    Every served profile with its state — the only surface in the bundle that
    deliberately sees past admission, because a profile the wearer has not
    enrolled yet must still be offerable. It is safe for exactly one reason:
    it returns names and states. No transcript, no session, no settings, no
    dispatch. Enrolling is how a name becomes reachable; nothing here reaches
    it.
``agents.retry``
    Finish a profile whose creation receipt never completed. The row is the
    only place that retry still exists once the create popup is dismissed, so
    without it a half-built agent is a permanent dead end. The caller names the
    profile; the host replays that profile's OWN receipt (#2940 follow-up), so
    nothing off the wire can talk over a creation that is still running.
``agents.enrol`` / ``agents.remove``
    Mutate :mod:`.profile_enrollment`'s set, mirror it onto the retired
    gateway key when the running engine still reads one, and invalidate the
    route resolver so the change is visible on the very next resolution rather
    than up to a TTL later.

**Addressed to the default profile.** ``profileId`` is the transport owner,
which is always admitted, and the *target* rides in the payload. That is what
lets the request pass :func:`~.management_rpc.read_management`'s served-profile
gate without that gate having to know about a set whose whole job is to be
narrower than it.

A removal never cancels work. The adapter's drain
(``adapter._note_route_departures``) keeps a departed namespace's home for its
in-flight TTL, so a turn already running in a removed agent finishes and its
outcome is delivered; what removal stops is the *next* turn. Nothing here
redirects anything to the default profile.
"""
from __future__ import annotations

from typing import Any, Dict

#: Wire operations. Named for the wearer's word ("agents"), not the config
#: key's ("profile_allowlist").
OPERATIONS = ("agents.list", "agents.enrol", "agents.remove", "agents.retry")

#: The one profile these requests may be addressed to.
DEFAULT_PROFILE = "default"


def compatible() -> bool:
    """Can this bundle answer the Agents lane at all?

    Enrollment is plugin-side and needs no native compatibility package, so the
    only real question is whether the modules import — which is a genuine
    question on a host whose Hermes is too old for the route resolver.
    """
    try:
        from . import profile_enrollment, profile_routes  # noqa: F401

        return True
    except Exception:  # noqa: BLE001 - an unimportable lane is unsupported
        return False


def capabilities():
    supported = compatible()
    return [
        {
            "operation": operation,
            "scope": "gateway",
            "supported": supported,
            # Enrolling changes what the NEXT turn may reach; work already
            # running is drained, never cut off.
            "applyTiming": "read_only" if operation == "agents.list" else "future_chat",
        }
        for operation in OPERATIONS
    ]


def _retry_setup(rpc: Any, result: Dict[str, Any], fail: Any, target: str) -> Dict[str, Any]:
    """Finish the half-built agent named by *target*, or say why not.

    Which of the two "not incomplete" cases this is — setup already finished,
    or a profile OcuClaw never created — is the host's call, not this lane's:
    it is the one that reads the receipt, and guessing here would tell a wearer
    their hand-made Hermes profile had "already finished" a setup it never had.
    """
    from . import profile_enrollment, profile_routes

    snapshot = profile_routes.RESOLVER.snapshot()
    served = dict(getattr(snapshot, "served", {}) or {})
    if target not in served:
        return fail(
            "profile_not_served",
            "This agent is not served by the connected gateway. Refresh the agent list.",
        )

    retry = getattr(rpc, "retry_incomplete_setup", None)
    if not callable(retry):
        return fail(
            "unsupported",
            "This Hermes installation cannot finish agent setup. Update its OcuClaw integration.",
            "unsupported",
        )
    try:
        from .models_rpc import IncompleteRetryRefused
    except Exception:  # noqa: BLE001 - an empty tuple simply never matches below
        IncompleteRetryRefused = ()  # type: ignore[assignment]
    try:
        # The served home goes with the name: this lane read `incomplete` out of
        # that exact directory, so the host stamps the receipt in the same one.
        # (Same bundle, so no signature skew to guard against here.)
        retry(target, home=served[target])
    except IncompleteRetryRefused as error:  # type: ignore[misc]
        return fail(error.code, error.message)
    except Exception:  # noqa: BLE001 - never forward a native exception
        return fail(
            "setup_failed",
            "Setup could not finish. Check that Hermes is running, then try again.",
        )

    # Setup completed, so this profile is now both complete and enrolled. The
    # resolver caches routes for a TTL and the wearer is watching the row.
    profile_routes.RESOLVER.invalidate()
    # No `restartRequired` on this lane, deliberately. The profile is already in
    # the gateway's served set — that is how its row exists to be retried — so
    # what the retry changes is the incomplete flag and the enrollment set, both
    # of which this bundle reads live. The row turning "enrolled" in the view
    # below IS the outcome, and a restart notice here would be a lie on every
    # supported engine.
    try:
        view = profile_enrollment.agents_view()
    except Exception:  # noqa: BLE001
        # The setup landed but the re-read did not. Reporting an error here
        # would have the wearer retry work already done, so report success with
        # a degraded roster — `multiplex` included, because the phone boundary
        # drops a payload missing a required field (#2940).
        current = profile_enrollment.current_enrollment()
        view = {
            "agents": [],
            "enrollment": {
                "state": current.state,
                "source": current.source,
                "requiresReselection": current.requires_reselection,
            },
            "multiplex": True,
        }
    return {**result, "status": "ok", "agents": view}


def handle_agents(rpc: Any, identity: Dict[str, Any], arguments: Any) -> Dict[str, Any]:
    """Serve one Agents-lane request."""
    result = {**identity, "capabilities": capabilities()}

    def fail(code: str, message: str, status: str = "error") -> Dict[str, Any]:
        return {**result, "status": status, "errorCode": code, "errorMessage": message}

    if not compatible():
        return fail(
            "unsupported",
            "This Hermes installation cannot manage agents. Update its OcuClaw integration.",
            "unsupported",
        )
    if identity.get("scope") != "gateway":
        return fail("invalid_scope", "Agents are shared across this gateway.")
    if identity.get("profileId") != DEFAULT_PROFILE:
        # Not a formality: addressing the lane to a secondary profile would be
        # a way to ask an un-enrolled agent about the set that excludes it.
        return fail("invalid_request", "Agents are managed from the default agent.")

    operation = identity.get("operation")
    payload = arguments if isinstance(arguments, dict) else {}
    required = {
        "agents.list": set(),
        "agents.enrol": {"profile"},
        "agents.remove": {"profile"},
        # Deliberately just the name. A request id or a setup body off the wire
        # is what would let a caller talk over the creation that owns this
        # receipt; the host reads both back from the receipt itself.
        "agents.retry": {"profile"},
    }
    if operation not in required:
        return fail("unsupported", "This operation is not supported.", "unsupported")
    if set(payload) != required[operation]:
        return fail("invalid_request", "Name exactly one agent to change.")

    from . import profile_enrollment, profile_routes
    from .profile_routes import sanitize_profile_name

    if operation == "agents.list":
        try:
            view = profile_enrollment.agents_view()
        except Exception:  # noqa: BLE001 - never forward a native exception
            return fail(
                "native_read_failed",
                "Hermes could not read its agents. Check the native gateway.",
            )
        return {**result, "status": "ok", "agents": view}

    target = sanitize_profile_name(payload.get("profile"))
    if target is None:
        return fail("invalid_request", "That is not a valid agent name.")

    if operation == "agents.retry":
        return _retry_setup(rpc, result, fail, target)

    if operation == "agents.enrol":
        # Enrolment is a choice among what this gateway actually serves. A name
        # that is not served is not a thing the wearer can be given, and
        # accepting it would let the set grow past anything observable.
        snapshot = profile_routes.RESOLVER.snapshot()
        served = dict(getattr(snapshot, "served", {}) or {})
        if target not in served:
            return fail(
                "profile_not_served",
                "This agent is not served by the connected gateway. Refresh the agent list.",
            )
        if target in (getattr(snapshot, "incomplete", frozenset()) or frozenset()):
            return fail(
                "setup_incomplete",
                "This agent is still being set up. Retry its setup, then add it.",
            )

    try:
        if operation == "agents.enrol":
            enrollment = profile_enrollment.STORE.enrol(target)
        else:
            enrollment = profile_enrollment.STORE.remove(target)
    except profile_enrollment.EnrollmentConfigUnreadable as error:
        # Not a bad request: the wearer's tap was fine and retrying it will not
        # help, so do not send them round the "refresh and try again" loop.
        return fail("native_read_failed", str(error))
    except ValueError as error:
        return fail("invalid_request", str(error))
    except Exception:  # noqa: BLE001 - config paths never reach the wearer
        return fail(
            "write_failed",
            "Hermes could not record this change. Check the native gateway.",
        )

    # The resolver caches routes for a TTL; a selection the wearer just made
    # must not wait for it to lapse.
    profile_routes.RESOLVER.invalidate()

    try:
        view = profile_enrollment.agents_view(enrollment=enrollment)
    except Exception:  # noqa: BLE001
        # The write landed but the re-read did not. Report the set that is now
        # in force with an empty roster, rather than an error that would have
        # the wearer retry a change already made.
        #
        # `multiplex` is NOT optional here. The phone boundary validates this
        # payload as a whole and drops it if a required field is missing, so an
        # omitted key would turn a successful enrol into a silently empty
        # result — a worse outcome than the degraded view it was meant to be.
        view = {
            "agents": [],
            "enrollment": {
                "state": enrollment.state,
                "source": enrollment.source,
                "requiresReselection": enrollment.requires_reselection,
            },
            "multiplex": bool(
                getattr(profile_routes.RESOLVER.snapshot(), "multiplex", True)
            ),
        }
    return {**result, "status": "ok", "agents": view}
