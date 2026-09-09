"""Native installed skill and tool roster inspection; never installs anything."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
from contextlib import contextmanager

@contextmanager
def profile_tool_context():
    from hermes_constants import get_hermes_home
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
    token = set_secret_scope(build_profile_secret_scope(get_hermes_home()))
    try:
        yield
    finally:
        reset_secret_scope(token)


def installed_skills(config):
    from agent import skill_utils as u
    from tools import skills_tool as s
    from agent.secret_scope import get_secret
    cwd = (config.get("terminal") or {}).get("cwd")
    root = u.find_project_root(Path(os.path.expanduser(cwd))) if isinstance(cwd, str) and cwd else u.find_project_root()
    project = u._candidate_project_skills_dirs(root) if root and u.is_project_root_trusted(root) and (config.get("skills") or {}).get("project_discovery") is not False else []
    directories = [(p, "project") for p in project] + [(s._skills_dir(), "profile")] + [(p, "external") for p in u.get_external_skills_dirs()]
    candidates = {}
    for directory, origin in directories:
        if not directory.exists():
            continue
        iterator = u.iter_project_skill_files(directory) if origin == "project" else u.iter_skill_index_files(directory, "SKILL.md")
        for path in iterator:
            if any(part in s._EXCLUDED_SKILL_DIRS for part in path.parts):
                continue
            content = path.read_bytes()
            if len(content) > 2_000_000:
                raise ValueError("Installed skill exceeds the supported size.")
            meta, _ = s._parse_frontmatter(content.decode("utf-8-sig", errors="replace")[:4000])
            name = meta.get("name", path.parent.name)
            if not isinstance(name, str) or not name or len(name) > s.MAX_NAME_LENGTH or any(ord(c) < 32 for c in name):
                raise ValueError("Invalid native skill name.")
            reasons = []
            platform_ok = s.skill_matches_platform(meta)
            environment_ok = s.skill_matches_environment(meta)
            if not platform_ok: reasons.append("Unsupported operating system")
            if not environment_ok: reasons.append("Not offered in this runtime environment")
            env, commands = s._collect_prerequisite_values(meta)
            required = s._get_required_environment_variables(meta, env)
            if any(not get_secret(item["name"]) for item in required): reasons.append("Required environment configuration is missing")
            if any(shutil.which(command) is None for command in commands): reasons.append("Required command dependency is missing")
            row = {"name": name, "description": " ".join(str(meta.get("description", "")).split())[:240], "origin": origin,
                   "contentRevision": hashlib.sha256(content).hexdigest(), "available": not reasons,
                   "reason": "; ".join(reasons), "essential": name in u.ESSENTIAL_SKILLS}
            candidates.setdefault(name, []).append((platform_ok and environment_ok, row))
            if sum(map(len, candidates.values())) > 500:
                raise ValueError("Installed catalog exceeds the supported size.")
    result = []
    for name, rows in candidates.items():
        # Native precedence skips OS/environment ineligible entries before
        # first-wins dedup. Missing prerequisites do not change that precedence.
        chosen = next((row for eligible, row in rows if eligible), rows[0][1])
        result.append({**chosen, "overrides": len(rows) - 1})
    return sorted(result, key=lambda row: row["name"])
