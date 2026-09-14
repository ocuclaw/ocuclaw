"""Read-only bridges across Hermes's monolithic and decomposed modules.

Resolve native readers without changing engine exports or admitting optional
write APIs. Callers retain their existing profile/secret scope and error policy.
"""
from importlib import import_module


def native_callable(facade, name, owner):
    reader = getattr(facade, name, None)
    if not callable(reader):
        reader = getattr(import_module(owner), name, None)
    if not callable(reader):
        raise ImportError(f"Native reader {owner}.{name} is unavailable")
    return reader


def approval_reader(approval, name):
    return native_callable(approval, name, "tools.approval_context")


def approval_aliases(approval):
    aliases = getattr(approval, "_PATTERN_KEY_ALIASES", None)
    if aliases is None:
        aliases = import_module("tools.approval_detection")._PATTERN_KEY_ALIASES
    if not isinstance(aliases, dict):
        raise ValueError("Native approval aliases are unavailable")
    return aliases


def skill_requirements(skills, metadata):
    # Both versions accept one argument and merge legacy env requirements.
    required = native_callable(skills, "_get_required_environment_variables", "tools.skills_tool_setup")(metadata)
    collector = getattr(skills, "_collect_prerequisite_values", None)
    if callable(collector):
        _, commands = collector(metadata)
    else:
        prerequisites = metadata.get("prerequisites")
        value = prerequisites.get("commands") if isinstance(prerequisites, dict) else None
        # Preserve the old reader's string/list normalization; inspect names,
        # never execute commands or invoke an interactive skill setup helper.
        value = [value] if isinstance(value, str) else value or []
        commands = [str(item) for item in value if str(item).strip()]
    return required, commands


def stt_private_url_reader(transcription):
    return native_callable(transcription, "_is_local_or_private_url", "tools.transcription_cloud")


def command_stt_providers(transcription, config):
    iterator = getattr(transcription, "_iter_command_stt_providers", None)
    if callable(iterator):
        yield from iterator(config)
        return
    providers = config.get("providers") if isinstance(config, dict) else None
    if not isinstance(providers, dict):
        return
    is_command = native_callable(transcription, "_is_command_stt_provider_config", "tools.transcription_command")
    for name, entry in providers.items():
        if isinstance(name, str) and name.lower() not in transcription.BUILTIN_STT_PROVIDERS and is_command(entry):
            yield name, entry
