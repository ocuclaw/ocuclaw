#!/usr/bin/env python3
"""Build/install the local Desktop half; Python 3.9+, standard library only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

MARKER = "// OCUCLAW-OWNED-DESKTOP-PAIRING-PLUGIN v1"
IDENTITY = "ocuclaw/ocuclaw"
SLOTS = {"PRESENTER_CAPABILITY": "__OCUCLAW_DESKTOP_PRESENTER_CAPABILITY__",
         "THEME_REQUEST": "__OCUCLAW_DESKTOP_THEME_REQUEST__"}


class CompanionError(ValueError):
    """A fixed, safe-to-display error (never includes installed source)."""

    def __init__(self, message, code="artifact_invalid"):
        super().__init__(message)
        self.code = code


def digest(source):
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def atomic_write(path, content):
    """The loader sees either the complete previous file or complete new file."""
    fd, temporary = tempfile.mkstemp(prefix=".ocuclaw-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def safe_path(path):
    # Check all ancestors, including broken links; Windows junctions resolve
    # differently too. Never follow a link into somebody else's installation.
    if not path.is_absolute() or ".." in path.parts:
        raise CompanionError("Use an absolute home without parent traversal", "unsafe_path")
    for part in [*reversed(path.parents), path]:
        if part.is_symlink() or (part.exists() and part.resolve() != part):
            raise CompanionError("Linked installation paths are not supported", "unsafe_path")


def build(output):
    repo = Path(__file__).resolve().parents[2]
    bundle = repo / "extensions" / "ocuclaw-hermes"
    source = (bundle / "desktop-template" / "plugin.js").read_text(encoding="utf-8")
    if not source.startswith(MARKER + "\n"):
        raise CompanionError("Template ownership is missing")
    for key, placeholder in SLOTS.items():
        declaration = f"const {key} = '{placeholder}'"
        if source.count(placeholder) != 1 or declaration not in source:
            raise CompanionError("Template slots are invalid")
        source = source.replace(declaration, f"const {key} = ''")
    version = re.search(r"^version: (\d+\.\d+\.\d+)$",
                        (bundle / "plugin.yaml").read_text(encoding="utf-8"), re.M)
    if not version:
        raise CompanionError("Runtime Bundle version is invalid")
    source = source.replace(MARKER + "\n", MARKER + "\n" +
                            f"// OCUCLAW-DESKTOP-COMPANION version={version[1]}\n", 1)
    artifact = {"format": 2, "identity": IDENTITY, "version": version[1],
                "sha256": digest(source), "sourceLines": source.splitlines(keepends=True)}
    output = Path(output).absolute()
    safe_path(output)
    # Keep every source line independently visible to reviewers and the bundle
    # scanner. A single escaped string falsely combines unrelated operations.
    atomic_write(output, json.dumps(artifact, ensure_ascii=True, indent=2) + "\n")
    return {"status": "built", "version": version[1], "sha256": artifact["sha256"]}


def load_artifact(path):
    artifact = json.loads(Path(path).read_text(encoding="utf-8"))
    lines = artifact.get("sourceLines")
    if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
        raise CompanionError("Companion source lines are invalid")
    source = "".join(lines)
    if (artifact.get("format") != 2 or artifact.get("identity") != IDENTITY
            or not re.fullmatch(r"\d+\.\d+\.\d+", artifact.get("version", ""))
            or not isinstance(source, str) or not source.startswith(MARKER + "\n")
            or artifact.get("sha256") != digest(source)):
        raise CompanionError("Companion artifact identity/integrity is invalid")
    if source.count(f"// OCUCLAW-DESKTOP-COMPANION version={artifact['version']}\n") != 1:
        raise CompanionError("Companion version does not match its payload")
    for key, placeholder in SLOTS.items():
        if placeholder in source or source.count(f"const {key} = ''") != 1:
            raise CompanionError("Companion artifact must not carry presenter authority")
    if len(source.encode("utf-8")) > 512 * 1024:
        raise CompanionError("Companion exceeds Desktop's loader limit")
    return {**artifact, "source": source}


def check_duplicates(home, target):
    # Earlier Desktop versions loaded per-profile roots and packaged halves.
    # New Desktop migrates these automatically. Refuse instead of deleting
    # another profile's presenter or trusting which copy wins a migration.
    homes = [home]
    profiles = home / "profiles"
    safe_path(profiles)
    if profiles.exists():
        homes.extend(profiles.iterdir())
    for local in homes:
        safe_path(local)
        for root, entry in ((local / "desktop-plugins", "plugin.js"),
                            (local / "plugins", "desktop/plugin.js")):
            safe_path(root)
            if not root.exists():
                continue
            for directory in root.iterdir():
                safe_path(directory)
                candidate = directory / entry
                safe_path(candidate)
                if candidate == target or not candidate.is_file():
                    continue
                if directory.name == "ocuclaw" or candidate.read_text(
                        encoding="utf-8").startswith(MARKER + "\n"):
                    raise CompanionError("Another OcuClaw desktop runtime exists; resolve it in Desktop first", "duplicate_runtime")


def installed_source(target):
    if not target.exists():
        return None
    current = target.read_text(encoding="utf-8")
    if not current.startswith(MARKER + "\n"):
        raise CompanionError("Unrecognized plugin.js preserved", "foreign_plugin")
    return current


def install(home, artifact_path):
    artifact = load_artifact(artifact_path)
    target = home / "desktop-plugins" / "ocuclaw" / "plugin.js"
    safe_path(target)
    check_duplicates(home, target)
    homes = [home]
    profiles = home / "profiles"
    if profiles.is_dir():
        homes.extend(path for path in profiles.iterdir() if path.is_dir())
    for local in homes:
        backend = local / "plugins" / "ocuclaw" / "desktop_pairing.py"
        safe_path(backend)
        if backend.exists() and not re.search(r"^COMPANION_VERSION_MARKER\s*=",
                                             backend.read_text(encoding="utf-8"), re.M):
            raise CompanionError(
                "Update the local OcuClaw Runtime Bundle before installing the companion; its backend would overwrite this plugin",
                "local_backend_update_required")
    # A package migration marker makes Hermes overwrite from another source.
    if (target.parent / ".hermes-package.json").exists():
        raise CompanionError("Desktop manages this plugin from an agent package; update that package instead", "package_managed")
    current = installed_source(target)
    source = artifact["source"]
    if current:
        version = re.search(r"^// OCUCLAW-DESKTOP-COMPANION version=(\d+\.\d+\.\d+)$", current, re.M)
        if version and tuple(map(int, version[1].split("."))) > tuple(map(int, artifact["version"].split("."))):
            raise CompanionError("Downgrades are not supported; use the current Runtime Bundle", "downgrade_refused")
        for key in SLOTS:
            matches = re.findall(rf"^const {key} = '([^']*)'$", current, re.M)
            allowed = r"[A-Za-z0-9_-]{43,128}" if key == "PRESENTER_CAPABILITY" else r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,15}Z"
            if len(matches) != 1 or not (matches[0] == "" or matches[0] == SLOTS[key]
                                        or re.fullmatch(allowed, matches[0])):
                raise CompanionError("Existing local presenter slot is unrecognized; preserved", "presenter_invalid")
            value = "" if matches[0] == SLOTS[key] else matches[0]
            source = source.replace(f"const {key} = ''", f"const {key} = '{value}'")
    if current == source:
        status = "unchanged"
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(target, source)
        status = "updated" if current else "installed"
    return {"status": status, "version": artifact["version"], "sha256": artifact["sha256"],
            "next": "Reopen Hermes Desktop; enable OcuClaw in Desktop Plugins if desired"}


def remove(home):
    target = home / "desktop-plugins" / "ocuclaw" / "plugin.js"
    safe_path(target)
    if (target.parent / ".hermes-package.json").exists():
        raise CompanionError("Desktop manages this plugin from an agent package; remove it in Desktop instead", "package_managed")
    current = installed_source(target)
    if current:
        target.unlink()
        try:
            target.parent.rmdir()
        except OSError:
            pass  # Only the owned plugin file belongs to this operation.
    return {"status": "removed" if current else "absent"}


def status(home):
    target = home / "desktop-plugins" / "ocuclaw" / "plugin.js"
    safe_path(target)
    current = installed_source(target)
    if current is None:
        return {"status": "absent"}
    check_duplicates(home, target)
    version = re.search(r"^// OCUCLAW-DESKTOP-COMPANION version=(\d+\.\d+\.\d+)$", current, re.M)
    return {"status": "installed", "version": version[1] if version else None,
            "sha256": digest(current), "identity": IDENTITY}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("build").add_argument("--output", required=True)
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--artifact", required=True)
    for command in (install_parser, commands.add_parser("remove"), commands.add_parser("status")):
        command.add_argument("--home", required=True,
                             help="Absolute LOCAL app-level Hermes home (usually ~/.hermes)")
    args = parser.parse_args()
    try:
        if args.command != "build" and Path(args.home).parent.name == "profiles":
            raise CompanionError("Use the app-level Hermes home, not a profile home", "unsafe_path")
        result = (build(args.output) if args.command == "build" else
                  install(Path(args.home), args.artifact) if args.command == "install" else
                  remove(Path(args.home)) if args.command == "remove" else status(Path(args.home)))
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        # No source, presenter values, OS exception paths or credentials in output.
        message = str(error) if isinstance(error, CompanionError) else "Companion operation failed; check artifact and filesystem permissions"
        code = error.code if isinstance(error, CompanionError) else "operation_failed"
        print(json.dumps({"status": "error", "code": code, "message": message}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
