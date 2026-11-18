"""Compare setup's restart-sensitive keys with the gateway's boot snapshot.

Never use config mtimes: Hermes also writes unrelated onboarding metadata.
Only the gateway captures the baseline; the Desktop backend reads its receipt.
"""

import hashlib
import json


SETUP_PATHS = (
    ("display", "platforms", "ocuclaw", "tool_progress"),
    ("display", "platforms", "ocuclaw", "streaming"),
    ("platforms", "ocuclaw", "extra", "allow_admin_from"),
    ("platforms", "ocuclaw", "extra", "agent_mode"),
    ("gateway", "multiplex_profiles"),
    ("plugins", "stream_reasoning_deltas"),
    ("display", "busy_input_mode"),
)


def fingerprint(config, readable=True):
    if not readable or not isinstance(config, dict):
        return None
    values = []
    for path in SETUP_PATHS:
        value = config
        for key in path:
            value = value.get(key) if isinstance(value, dict) else None
        values.append(value)
    try:
        return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    except (TypeError, ValueError):
        return None


def current_fingerprint():
    from .health import setup_raw_config

    return fingerprint(*setup_raw_config())
