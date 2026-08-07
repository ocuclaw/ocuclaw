"""Small shared helpers for Hermes gateway projections."""

from __future__ import annotations

import re
from typing import Optional

# Bounded "You are <name>, ..." heuristic shared with the identity plane.
_SOUL_NAME_RE = re.compile(r"^\s*You are\s+([^,.\n]{1,64})[,.\n]", re.IGNORECASE)


def parse_soul_name(soul_text: str) -> Optional[str]:
    """First-line ``You are <name>, ...`` extraction."""
    if not isinstance(soul_text, str) or not soul_text.strip():
        return None
    match = _SOUL_NAME_RE.match(soul_text.lstrip())
    if not match:
        return None
    name = match.group(1).strip()
    return name or None
