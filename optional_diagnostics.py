"""Two independent OcuClaw permissions, saved through Hermes's config writer."""
from __future__ import annotations

FIELDS = {"access": "externalDebugToolsEnabled", "handoff": "allowDebugUpload"}
CHOICES = {"access": "diagnosticAccess", "handoff": "diagnosticHandoff"}


def configured() -> dict:
    from hermes_cli.config import read_raw_config

    node = read_raw_config()
    for key in ("platforms", "ocuclaw", "extra"):
        if not isinstance(node, dict):
            raise ValueError("configuration_unknown")
        node = node.get(key, {})
    if not isinstance(node, dict):
        raise ValueError("configuration_unknown")
    result = {}
    for permission, field in FIELDS.items():
        value = node.get(field, True)  # Hermes adapter's explicit defaults.
        if type(value) is not bool:
            raise ValueError("configuration_unknown")
        result[permission] = value
    return result


def save(home, permission: str, allowed: bool) -> None:
    from hermes_cli.config import set_config_value
    from . import optional_setup as setup

    if permission not in FIELDS or type(allowed) is not bool:
        raise ValueError("invalid_choice")
    configured()  # Refuse ambiguous input before any mutation.
    choice = CHOICES[permission]
    revision = setup.begin_save(home, choice)
    try:
        set_config_value(f"platforms.ocuclaw.extra.{FIELDS[permission]}",
                         "true" if allowed else "false")
        if configured()[permission] is not allowed:
            raise ValueError("save_unconfirmed")
        setup.finish_save(home, revision, choice, saved=True)
    except Exception:
        setup.finish_save(home, revision, choice, saved=False)
        raise ValueError("save_unconfirmed") from None
