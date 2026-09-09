"""Read-only admission for legacy native contracts.

The stock-Hermes beta carries no native proposal payloads or installer. Missing
contracts remain unsupported; loading this module never changes the engine.
Development fixtures retain exact-byte probes for upstream proposals.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

PACKAGES = Path(__file__).parent / "native-compat"


def _safe(root, name):
    path = root / name
    if Path(name).is_absolute() or ".." in Path(name).parts or path.is_symlink():
        raise ValueError("Invalid compatibility path.")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Invalid compatibility path.")
    return path


def _manifest(package):
    directory = _safe(PACKAGES, package)
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("id") != package:
        raise ValueError("Invalid compatibility manifest.")
    return directory, manifest


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _frontend_sources(root):
    paths = [root / "package-lock.json", root / "web/package.json", root / "web/vite.config.ts"]
    for directory in (root / "web/src", root / "apps/shared/src"):
        paths.extend(path for path in directory.rglob("*") if path.is_file())
    return {str(path.relative_to(root)): _sha(path) for path in sorted(paths)}


def _verify_frontend(root, frontend):
    receipt = json.loads(_safe(root, frontend["attestation"]).read_text())
    if receipt.get("sources") != _frontend_sources(root):
        raise ValueError("Native editor sources differ from the built assets.")
    output = _safe(root, frontend["output"])
    assets = receipt.get("assets", {})
    if not assets or "index.html" not in assets or any(_sha(_safe(output, name)) != value for name, value in assets.items()):
        raise ValueError("Native editor asset attestation is missing or stale.")
    override = os.environ.get("HERMES_WEB_DIST")
    if override and Path(override).resolve() != output.resolve():
        raise ValueError("Native editor serves a different asset directory.")


def probe(engine_root, packages, *, require_frontend=True):
    """Fail closed unless the complete native contract can be attested."""
    root = Path(engine_root).resolve()
    try:
        active = {}
        for candidate in sorted(PACKAGES.iterdir()):
            if not candidate.is_dir() or not (candidate / "manifest.json").is_file():
                continue
            directory, manifest = _manifest(candidate.name)
            modules = manifest.get("modules", [])
            if modules and all(_sha(_safe(root, item["target"])) == _sha(_safe(directory, item["source"]))
                               for item in modules):
                active[candidate.name] = manifest
        if not set(packages) <= set(active):
            raise ValueError("Required native contract is unavailable.")
        checked = set()
        states = {}
        while set(active) - checked:
            ready = [p for p in active if p not in checked and
                     set(active[p].get("dependencies", [])) <= checked]
            if not ready:
                raise ValueError("Missing or cyclic native contract dependency.")
            for package in ready:
                for item in active[package]["files"]:
                    previous = states.get(item["path"])
                    if previous is not None and previous != item["beforeSha256"]:
                        raise ValueError("Native contracts do not compose.")
                    states[item["path"]] = item["afterSha256"]
                checked.add(package)
        if any(_sha(_safe(root, path)) != expected for path, expected in states.items()):
            raise ValueError("Native source differs from the verified contract.")
        if require_frontend:
            for manifest in active.values():
                if manifest.get("frontend"):
                    _verify_frontend(root, manifest["frontend"])
        return {"supported": True, "packages": sorted(checked), "reason": "verified"}
    except (ValueError, OSError, KeyError, TypeError):
        return {"supported": False, "packages": [], "reason": "native_compatibility_required"}
