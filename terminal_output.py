"""Append-only Guided terminal styling; receipts and JSON stay plain."""
from .pairing import terminal_supports_color


def styled(text, stream, env=None, role=None):
    if not terminal_supports_color(stream, env):
        return text
    if role is None:
        role = "heading" if text.startswith("[") and "/8] " in text else None
        if text.lstrip().startswith("Exact settings:"):
            role = "detail"
    color = {"heading": "32", "prompt": "33", "detail": "2"}.get(role)
    return f"\x1b[{color}m{text}\x1b[0m" if color else text
