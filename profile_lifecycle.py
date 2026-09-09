"""Small gateway-side profile lifecycle seam for the supported Hermes release.

Use native profile creation and config writers. Desktop's profiles.create RPC
is not a gateway API. Match its shared-auth semantics without copying channel
tokens or calling save_env_value (0.21 mutates process-wide os.environ).
Upstream adoption checks: docs/hermes/multiplex-beta-contract.md.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import tempfile
import threading

PROFILE_MUTATION_LOCK = threading.Lock()
WORKSPACE_UNSUPPORTED = "Per-agent folders need a newer supported Hermes release. Keep the existing starting folder."
INFERENCE_CONFIG_KEYS = ("model", "providers", "custom_providers", "bedrock", "vertex")
# Native SDK/OAuth providers intentionally have empty api_key_env_vars in
# Hermes's registry. Preserve their explicit .env access and routing too;
# credential files remain shared references, never copied refresh state.
NATIVE_PROVIDER_ENV_KEYS = {
    "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION",
    "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS", "VERTEX_CREDENTIALS_PATH",
    "VERTEX_PROJECT_ID", "VERTEX_REGION",
}


def write_private(path: Path, content: str) -> None:
    """Replace a profile-owned file atomically, owner-readable only."""
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def bootstrap_profile(source: Path, target: Path) -> None:
    """Initialize only our receipt-owned fresh profile; never fork OAuth state.

    Hermes resolves inherited OAuth when the child has no auth.json. Its
    shared-grant refresh ownership has known limitations on the certified
    beta baseline; this bootstrap does not repair or duplicate that state.
    Inference .env keys are copied as snapshots; platform tokens and ambient
    process environment are excluded.
    """
    from agent.secret_scope import load_env_file
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.config import atomic_config_write, read_user_config_raw

    source_cfg = read_user_config_raw(source / "config.yaml")
    target_cfg = read_user_config_raw(target / "config.yaml")
    for key in (*INFERENCE_CONFIG_KEYS, "approvals"):
        if key in source_cfg:
            target_cfg[key] = copy.deepcopy(source_cfg[key])
    # Explicit policy inheritance avoids a model-only profile silently using
    # smart approvals when the default profile requires manual approval.
    target_cfg.setdefault("approvals", {"mode": "smart"})
    agent = source_cfg.get("agent")
    if isinstance(agent, dict) and "disabled_toolsets" in agent:
        target_cfg.setdefault("agent", {})["disabled_toolsets"] = copy.deepcopy(agent["disabled_toolsets"])
    platform_tools = source_cfg.get("platform_toolsets")
    if isinstance(platform_tools, dict) and "ocuclaw" in platform_tools:
        target_cfg.setdefault("platform_toolsets", {})["ocuclaw"] = copy.deepcopy(platform_tools["ocuclaw"])

    allowed = {"OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", *NATIVE_PROVIDER_ENV_KEYS}
    for provider in PROVIDER_REGISTRY.values():
        allowed.update(provider.api_key_env_vars)
        if provider.base_url_env_var:
            allowed.add(provider.base_url_env_var)
    # Custom providers may name a key variable or interpolate it into headers.
    inference = {key: source_cfg[key] for key in INFERENCE_CONFIG_KEYS if key in source_cfg}
    def collect(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in ("key_env", "api_key_env") and isinstance(item, str):
                    allowed.add(item)
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, str):
            allowed.update(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", value))
    collect(inference)
    env = load_env_file(source / ".env")
    # json string quoting is compatible with dotenv, including newline escapes.
    content = "# Inference access inherited from the default Hermes profile.\n"
    content += "".join(f"{key}={json.dumps(env[key], ensure_ascii=False)}\n" for key in sorted(allowed) if key in env)
    write_private(target / ".env", content)
    # No auth.json copy: single-use OAuth refresh state must retain one owner.
    atomic_config_write(target / "config.yaml", target_cfg, sort_keys=False)


def admit_profile(source: Path, name: str) -> None:
    """Admit the just-created profile without broadening unrelated routes."""
    from hermes_cli.config import atomic_config_write, read_user_config_raw

    path = source / "config.yaml"
    config = read_user_config_raw(path)
    gateway = config.setdefault("gateway", {})
    if not isinstance(gateway, dict):
        raise ValueError("Gateway configuration is invalid")
    allowed = gateway.get("multiplex_profile_allowlist")
    if allowed is None:
        return  # Already serves all profiles; do not narrow an operator's policy.
    if not isinstance(allowed, list) or any(not isinstance(item, str) for item in allowed):
        raise ValueError("Served-agent list is invalid. Repair it before activating this agent.")
    if name not in allowed:
        gateway["multiplex_profile_allowlist"] = [*allowed, name]
        atomic_config_write(path, config, sort_keys=False)
