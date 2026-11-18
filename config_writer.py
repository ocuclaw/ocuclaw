"""Write back a whole Hermes config.yaml whose dropped keys are meant to go.

Hermes 0.21.6 split its config writer. ``atomic_config_write`` now refuses a
write that leaves out any key the file already holds, so a partial payload can
never erase settings. ``atomic_config_replace`` is the explicit door for a
complete desired state, where every omitted key is a deliberate deletion.
Through 0.21.5 ``atomic_config_write`` was that door, and it deleted omitted
keys itself.

Use :func:`replace_config` when the caller read the raw config, edited it,
and removed keys on purpose (clearing a setting, retiring a block). Writes
that only add or change values keep calling ``atomic_config_write``, so the
engine still guards them.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict


def replace_config(config_path: Path, data: Dict[str, Any]) -> None:
    """Persist ``data`` as the complete config, deleting keys it omits."""
    try:
        from hermes_cli.config import atomic_config_replace
    except ImportError:  # Hermes 0.21.5 and older: the one writer replaces
        from hermes_cli.config import atomic_config_write

        atomic_config_write(config_path, data)
        return
    atomic_config_replace(config_path, data)


__all__ = ["replace_config"]
