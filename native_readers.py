"""Read-only bridges across Hermes's monolithic and decomposed modules.

Resolve native readers without changing engine exports or admitting optional
write APIs. Callers retain their existing profile/secret scope and error policy.
"""
from importlib import import_module


def auxiliary_cancel_scope():
    """Read the host's optional per-attempt cancellation scope.

    Hermes 0.22.5 has no public plugin helper for cancelling the native sync
    provider worker after its asyncio waiter stops. Only resolve this scope;
    callers still use the trusted ctx.llm gate and retain compatibility when
    the host lacks it or its cancel_event parameter.
    """
    try:
        from agent.auxiliary_client import aux_interrupt_protection
    except ImportError:
        return None
    return aux_interrupt_protection


def native_callable(facade, name, owner):
    reader = getattr(facade, name, None)
    if not callable(reader):
        reader = getattr(import_module(owner), name, None)
    if not callable(reader):
        raise ImportError(f"Native reader {owner}.{name} is unavailable")
    return reader


def approval_reader(approval, name):
    return native_callable(approval, name, "tools.approval_context")


def native_image_input(provider, model):
    """Read Hermes's image policy for an already observed provider/model.

    Keep explicit text-only and auxiliary-vision routing decisions with the
    native owner. If its reader is absent, the caller retains its text fallback.
    """
    from agent.image_routing import decide_image_input_mode
    from hermes_cli.config import load_config_readonly

    return decide_image_input_mode(provider, model, load_config_readonly()) == "native"


def pending_clarify_entry(clarify, clarify_id):
    """The unanswered clarify entry for ``clarify_id``, or None.

    ``get_pending`` is public from Hermes 0.22.3; older engines only expose
    the module's private table.
    """
    get_pending = getattr(clarify, "get_pending", None)
    if callable(get_pending):
        return get_pending(clarify_id)
    with clarify._lock:
        return clarify._entries.get(clarify_id)


def viewer_turn_running():
    """True while the executing turn came from a session viewer (Desktop, TUI).

    Hermes 0.22.3+ marks a ``session.submit`` turn with the ``viewer_turn``
    context variable. Older hosts have no marker, so this answers False there.
    """
    try:
        from gateway.session_ingress import viewer_turn
        return viewer_turn.get() is not None
    except Exception:  # noqa: BLE001
        return False


def hidden_display_turn():
    """True while the executing turn's text is hidden from every client.

    Desktop sends goal control, inline-preview decisions and first-run
    kickoffs with ``display_kind="hidden"`` (Hermes 0.22.3+): text for the
    model that no client may show as a user message. Older hosts never hide.
    """
    try:
        from gateway.session_display import worker_display_kwargs
        return worker_display_kwargs().get("persist_user_display_kind") == "hidden"
    except Exception:  # noqa: BLE001
        return False


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


def running_cron_jobs():
    """The cron jobs Hermes is running now, in this gateway process (#6420).

    Hermes 0.22.5 keeps them in memory only, in ``cron.scheduler``'s in-flight
    set, and has no public plugin helper for them; the job record never says
    ``running``. Each entry is ``{"job_id", "elapsed_s", ...}``. Raises
    ImportError when the host lacks the reader; callers treat any error as
    nothing running.
    """
    from cron.scheduler import get_running_job_details
    return get_running_job_details()


def current_cron_execution():
    """The cron fire bound to this context, as Hermes's owner-execution tuple (#6422).

    Newer Hermes runs a cron fire as an owner execution in a ``local-<hex>``
    session and keeps the binding only in ``gateway.session_cron``'s context;
    no public plugin helper names it. Returns ``(authority, session_id,
    job_id, execution_id)`` or None. Raises ImportError when the host lacks the
    reader; callers treat any error as no bound fire.
    """
    from gateway.session_cron import current_execution
    return current_execution()


def cron_platform_toolsets(config):
    """The toolsets Hermes gives a cron job that names none, MCP servers left to the run (#6422).

    Hermes 0.22.5 resolves them in ``hermes_cli.tools_config._get_platform_tools``
    and has no public plugin helper for them. A Task's job freezes this list,
    less the toolsets OcuClaw never offers, as its own ``enabled_toolsets``; the
    run still adds every enabled MCP server. Raises ImportError when the host
    lacks the reader; callers then leave the job's toolsets unset.
    """
    from hermes_cli.tools_config import _get_platform_tools
    try:
        return set(_get_platform_tools(config or {}, "cron", include_default_mcp_servers=False))
    except TypeError:  # an engine before the MCP switch
        return set(_get_platform_tools(config or {}, "cron"))


def autonomous_silence_reader():
    """Hermes's own test for a cron answer that stays silent (#6673).

    Hermes 0.22.5 decides it in ``gateway.response_filters`` (``[SILENT]`` and
    its forms opening the answer or alone on its first or last line, as
    ``cron/scheduler.py`` reads it) and has no public plugin helper for it. An
    Alert run's verdict must read silence exactly as the cron delivery does, so
    a run Hermes keeps quiet never counts as an alert shown. Raises ImportError
    when the host lacks the reader; callers then use their own close match.
    """
    from gateway.response_filters import is_autonomous_silence_response
    return is_autonomous_silence_response
