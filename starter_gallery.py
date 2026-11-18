"""Every starter Hermes knows, for the phone's Start from gallery (#5034).

Hermes 0.22 lists its Automation Blueprints with ``list_blueprints()``:
the built-ins, then the blueprints the active profile's plugins registered
(OcuClaw's own, ``starters.py``, and any other plugin's). A new Hermes version
adds starters with no app update, so this module forwards what Hermes lists
and decides nothing about it. The relay child adds the kind, the default Look,
the needs and the run-rate estimate (``hermes-starter-kinds.ts``), and the
phone groups, orders and hides.

Each row also carries ``prefill``: the job Hermes would make from the
starter's defaults (``fill_blueprint`` with no values), so the phone can open
today's automation sheet filled in. A starter whose defaults do not fill (a
required text blank with no default) has ``prefill: None``.

Hermes 0.21.x has no ``list_blueprints``; the capability then reads
unsupported and the phone hides Start from. Nothing here writes.
"""
from __future__ import annotations

MAX_STARTERS = 100
_MAX_SLOTS = 20


def _text(value, limit=500):
    return "".join(c for c in str(value if value is not None else "") if c.isprintable() or c == "\n")[:limit]


def _api():
    """The stock blueprint listing, or NotImplementedError when this Hermes has none."""
    try:
        from cron.blueprint_catalog import fill_blueprint, list_blueprints
    except (ImportError, AttributeError) as exc:
        raise NotImplementedError() from exc
    if not callable(list_blueprints) or not callable(fill_blueprint):
        raise NotImplementedError()
    return list_blueprints, fill_blueprint


def supported():
    try:
        _api()
        return True
    except NotImplementedError:
        return False


def _slot(slot):
    default = getattr(slot, "default", None)
    return {
        "name": _text(slot.name, 64),
        "type": _text(slot.type, 32),
        "label": _text(slot.label, 160),
        "default": "" if default is None else _text(default, 4000),
        "options": [_text(option, 160) for option in tuple(getattr(slot, "options", ()) or ())[:100]],
        "optional": bool(getattr(slot, "optional", False)),
        "strict": bool(getattr(slot, "strict", True)),
        "help": _text(getattr(slot, "help", ""), 500),
    }


def _prefill(blueprint, fill_blueprint):
    try:
        spec = fill_blueprint(blueprint, {})
    except Exception:  # noqa: BLE001 - a starter with blanks to fill has no prefill
        return None
    return {
        "name": _text(spec.get("name"), 500),
        "prompt": _text(spec.get("prompt"), 16000),
        "schedule": _text(spec.get("schedule"), 500),
        "deliver": _text(spec.get("deliver"), 500),
    }


def _row(blueprint, fill_blueprint):
    return {
        "key": _text(blueprint.key, 128),
        "title": _text(blueprint.title, 120),
        "description": _text(blueprint.description, 4000),
        "category": _text(blueprint.category, 64),
        # Optional future/plugin metadata; today's Hermes built-ins do not supply it.
        "iconId": _text(getattr(blueprint, "icon_id", ""), 64),
        # Empty for a Hermes built-in; the registering plugin otherwise.
        "plugin": _text(getattr(blueprint, "plugin", ""), 64),
        "tags": [_text(tag, 64) for tag in tuple(blueprint.tags or ())[:20]],
        "skills": [_text(skill, 160) for skill in tuple(blueprint.skills or ())[:20]],
        "scheduleTemplate": _text(blueprint.schedule_template, 500),
        # #6272: the phone's "See full instructions" fills this with the sheet's own field values.
        "promptTemplate": _text(getattr(blueprint, "prompt_template", ""), 16000),
        "deliverDefault": _text(blueprint.deliver_default, 64),
        "slots": [_slot(slot) for slot in list(blueprint.slots or ())[:_MAX_SLOTS]],
        "prefill": _prefill(blueprint, fill_blueprint),
    }


def list_starters():
    """Every starter Hermes lists, in Hermes' own order. One bad starter is skipped, never fatal."""
    list_blueprints, fill_blueprint = _api()
    rows = []
    for blueprint in list(list_blueprints())[:MAX_STARTERS]:
        try:
            rows.append(_row(blueprint, fill_blueprint))
        except Exception:  # noqa: BLE001 - a malformed plugin starter never hides the rest
            continue
    return rows
