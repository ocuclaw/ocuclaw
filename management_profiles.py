"""Resolve management authority from the gateway's boot-frozen routes."""
from pathlib import Path


def management_profile_home(rpc, profile_id: str) -> Path | None:
    from .models_rpc import namespace_for_profile
    enabled, homes = rpc._routing_snapshot()
    if enabled:
        home = homes.get(namespace_for_profile(profile_id))
    elif profile_id == "default":
        home = getattr(rpc, "_management_default_home", None)
    else:
        home = None
    return Path(home) if home is not None else None
