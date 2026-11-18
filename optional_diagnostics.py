"""Independent OcuClaw permissions, saved through Hermes's config writer.

`access` and `handoff` are flat `platforms.ocuclaw.extra` booleans that default
on. `liveui_jev` and `program_cards_jev` are the phone's Jev switches: the
NESTED `platforms.ocuclaw.extra.liveuiJev.enabled` and
`platforms.ocuclaw.extra.programCardsJev.enabled` flags, exactly the adapter's
`_resolve_liveui_jev` and `_resolve_program_cards_jev` rule. `liveui_jev` is off
unless a literal true (or "true"); the saved TypeSafe key never arms it.

Silent input no longer uses Jev (Matt, 2026-10-31), so there is no
`silent_input_jev` permission: an older phone that asks for it gets the same
`invalid_request` as any unknown permission, and a stale `silentInputJev` block
in config is never read.

`program_cards_mcp` and `program_cards_model` are the phone's MCP and Models in
cards switches, the nested `programCardsMcp.enabled` and
`programCardsModel.enabled` flags. The three card switches read on while unset
and an explicit value wins (the adapter's `_program_card_switch_enabled`): each
card still needs the wearer's yes, which is the consent.
"""
from __future__ import annotations

FIELDS = {"access": "externalDebugToolsEnabled", "handoff": "allowDebugUpload",
          "liveui_jev": "liveuiJev.enabled",
          "program_cards_jev": "programCardsJev.enabled",
          "program_cards_mcp": "programCardsMcp.enabled", "program_cards_model": "programCardsModel.enabled"}
CHOICES = {"access": "diagnosticAccess", "handoff": "diagnosticHandoff",
           "liveui_jev": "liveuiJev",
           "program_cards_jev": "programCardsJev", "program_cards_mcp": "programCardsMcp", "program_cards_model": "programCardsModel"}
#: Permissions read with the adapter's literal-true rule: absent, malformed or
#: loose values read False and never raise.
LITERAL_TRUE = frozenset({"liveui_jev", "program_cards_jev", "program_cards_mcp", "program_cards_model"})
#: The card switches among them read on while unset (Matt 2026-10-27), exactly the
#: adapter's `_program_card_switch_enabled`: an explicit value still wins.
DEFAULT_ON = frozenset({"program_cards_jev", "program_cards_mcp", "program_cards_model"})

_MISSING = object()


def _at(node, field: str):
    """The value at dotted `field` under `node`, or `_MISSING` when any step is absent."""
    for part in field.split("."):
        if not isinstance(node, dict) or part not in node:
            return _MISSING
        node = node[part]
    return node


def loaded(settings, permission: str):
    """The loaded value in the adapter's resolved settings: a bool, or None when unknown.

    `liveui_jev` reads `settings["liveuiJev"]["enabled"]`, `program_cards_jev`
    `settings["programCardsJev"]["enabled"]` and `program_cards_mcp`
    `settings["programCardsMcp"]["enabled"]`; the others their flat key.
    """
    value = _at(settings, FIELDS[permission])
    return value if type(value) is bool else None


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
        if permission in LITERAL_TRUE:
            flag = _at(node, field)
            block = node.get(field.split(".")[0], None)
            # Unset: no block, or a map with no `enabled`. A scalar block reads off.
            unset = block is None or (isinstance(block, dict) and (flag is _MISSING or flag is None or flag == ""))
            result[permission] = (permission in DEFAULT_ON) if unset else (flag is True or flag == "true")
            continue
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
        # Hermes's `_set_nested` creates a missing `liveuiJev`/`programCardsJev`/
        # `programCardsMcp` map (or replaces a scalar one) and leaves sibling keys such as
        # `budgetMs` untouched.
        set_config_value(f"platforms.ocuclaw.extra.{FIELDS[permission]}",
                         "true" if allowed else "false")
        if configured()[permission] is not allowed:
            raise ValueError("save_unconfirmed")
        setup.finish_save(home, revision, choice, saved=True)
    except Exception:
        setup.finish_save(home, revision, choice, saved=False)
        raise ValueError("save_unconfirmed") from None
