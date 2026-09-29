"""Read-only plugin discovery observations; paths stay in local doctor output."""

from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path
from typing import Any, Optional

import yaml

from .profiles_report import bundle_version


def shadow_copies(home: Optional[Path]) -> list[dict[str, Any]]:
    """Match Hermes 0.21.4 plugins_discovery.scan_directory (depth cap 1).

    No Hermes imports or plugin code execution. Manifest presence stops recursion,
    even when the manifest is invalid. Each unreadable child is independent.
    """
    if home is None:
        return []
    root = home / "plugins"
    copies: list[dict[str, Any]] = []

    def walk(directory: Path, depth: int = 0, outer: Optional[str] = None) -> None:
        try:
            children = sorted(directory.iterdir())
        except OSError:
            return
        for child in children:
            if child.name.startswith("__") and child.name.endswith("__"):
                continue
            try:
                if not child.is_dir():
                    continue
                manifest = next((child / name for name in
                                 ("plugin.yaml", "plugin.yml", "plugin.json")
                                 if (child / name).exists()), None)
                if manifest is None:
                    if depth == 0:
                        walk(child, 1, child.name)
                    continue
                with manifest.open(encoding="utf-8") as stream:
                    text = stream.read(65537)
                if len(text) > 65536:
                    continue
                data = json.loads(text) if manifest.suffix == ".json" else yaml.safe_load(text)
                if isinstance(data, dict) and data.get("name") == "ocuclaw" and child != root / "ocuclaw":
                    copies.append({"path": child, "folder": outer or child.name,
                                   "version": data.get("version")})
            except (OSError, UnicodeError, ValueError, yaml.YAMLError):
                continue

    walk(root)
    return copies


def collect_copy_facts(home: Optional[Path], loaded_root: Path) -> dict[str, Any]:
    installed = home / "plugins" / "ocuclaw" if home is not None else None
    loaded_from_installed = None
    if installed is not None:
        try:
            loaded_from_installed = loaded_root.resolve() == installed.resolve()
        except OSError:
            pass
    return {
        "ocuclawShadowCopies": [{"folder": copy["folder"], "version": copy["version"]}
                                for copy in shadow_copies(home)],
        "ocuclawInstalledVersion": bundle_version(installed) if installed is not None else None,
        "ocuclawLoadedFromInstalled": loaded_from_installed,
    }


def render_local_repairs(copies: list[dict[str, Any]], *, windows: Optional[bool] = None) -> list[str]:
    if not copies:
        return []
    windows = os.name == "nt" if windows is None else windows
    lines = ["", "Plugin copies — local backup commands (doctor changed nothing)"]
    for copy in copies:
        path = str(copy["path"])
        folder = str(copy["folder"])
        # Never render terminal controls or a shell-interpolated backup name.
        if any(ord(char) < 32 or ord(char) == 127 for char in path):
            continue
        backup = "ocuclaw-" + re.sub(r"[^A-Za-z0-9._-]", "_", folder)[:80] + "-backup"
        lines.append(f"  {path}")
        if windows:
            quoted = "'" + path.replace("'", "''") + "'"
            lines.append(f'  Move-Item -LiteralPath {quoted} -Destination "$env:USERPROFILE\\{backup}" -ErrorAction Stop')
        else:
            lines.append(f'  mv -n -- {shlex.quote(path)} "$HOME/{backup}"')
    lines.append("  Move, never delete. Restart the gateway the usual way, then tap Try again on the phone. No re-pair.")
    return lines
