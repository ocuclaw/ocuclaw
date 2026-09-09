"""STT lane RPC handlers: Hermes capability listing (#1938) + batch transcribe
(#1939).

Wire shape pinned in PROTOCOL.md "STT lane". The Node bridge asks this lane
what the connected Hermes can transcribe with; the phone renders the answer in
voice settings, picks one provider/model per utterance, and sends the committed
utterance back down the same lane for a single batch transcription.

Two rules the listing half exists to hold:

- **Annotated, never filtered.** A provider the wearer has configured but that
  cannot run right now crosses with ``available:false`` and a human-readable
  ``unavailableReason``. Hiding it turns "you have no key" into "OcuClaw is
  broken".
- **Never installs anything.** Hermes's own resolver
  (``tools.transcription_tools._get_provider``) lazy-installs faster-whisper
  when ``stt.provider: local`` is configured and the package is missing
  (transcription_tools.py:1059 and :1157, via ``_try_lazy_install_stt``). A
  settings screen opening MUST NOT trigger a multi-hundred-megabyte pip
  install, so the listing never calls that resolver, never calls
  ``transcribe_audio``, and probes availability only through reads: cached
  import-time flags, ``importlib.find_spec``, PATH lookups, and config/env/
  credential-pool reads.

**Where the no-install boundary runs.** ``stt.transcribe`` is the other side of
that line and is deliberately exempt: transcribing with the ``local`` backend
IS the moment Hermes installs faster-whisper (``_transcribe_local`` →
``_try_lazy_install_stt``, transcription_tools.py:1942), and the wearer asked
for a transcription. So the guarantee is scoped to the lane, not the module:
*opening the settings screen installs nothing; committing an utterance may
install exactly what Hermes itself would have installed for the same
transcription.* The two lanes share no helper that crosses the line — the
listing lane calls only the read-only probes pinned by
``test_no_probe_the_lane_calls_can_reach_a_lazy_install``, and the transcribe
lane's single Hermes entry point is ``_dispatch_stt_provider``, which that same
test lists as an installing entry point the listing lane may never reach.

Three more rules the transcribe half holds:

- **The picked provider wins over config.** ``transcribe_audio`` has no
  provider parameter — it resolves ``stt.provider`` through ``_get_provider``.
  This lane calls Hermes's own explicit-provider seam,
  ``_dispatch_stt_provider(file_path, provider, stt_config, model, source)``
  (transcription_tools.py:3017, the function ``_transcribe_prepared_audio``
  hands its resolved provider to at :3013), passing the phone's pick
  positionally. That is also the seam that carries Hermes's whole dispatch
  precedence — built-in > ``type: command`` > plugin-registered — so all three
  lanes the listing offers are transcribable through one call.
- **No echo, ever.** The handler touches the transcription surface and nothing
  else. It never builds a ``MessageEvent``, never calls ``handle_message``,
  never caches media into a session, never writes a session store: the
  transcript reaches the phone exactly once, as this RPC's result. The phone
  owns the commit.
- **The spill file is claimed, then deleted.** Audio always crosses as a
  temp-file descriptor (never inline base64 on the link line). Node unlinks
  that descriptor best-effort when the RPC settles OR when its 60 s timeout
  fires, so this handler renames the bytes to a name of its own the instant it
  accepts them (contract §5c) and works only on that; every outcome — success,
  provider error, validation reject, unexpected exception — then unlinks it.
  A path that is not a control-link spill file is refused AND left alone. The
  guard is exactly ``ocuclaw-stt-`` and never the already-claimed
  ``ocuclaw-stt-owned-`` (§5f ruling 19): the dispatch lane's
  ``ocuclaw-attach-`` files and another request's in-flight audio are both
  files this lane would otherwise rename away and delete. The parent must be a
  system temp directory, matched against the candidate SET rather than one
  answer, because Node's and Python's env fallbacks disagree in ORDER
  (``_spill_dir_candidates``). And because a process that dies mid-transcribe
  orphans its claimed file forever — nothing else will ever touch that name —
  the first handler call of each process sweeps claimed files older than an
  hour (``_sweep_orphaned_spills``).
- **An unavailable pick is refused, not installed** (#1941, §5f ruling 18).
  Before dispatching, the same read-only probes the listing uses are asked
  about the PICKED provider, and one that cannot run right now comes back as
  the listing's own reason. Otherwise `local` without faster-whisper enters a
  multi-minute install inside a 60 s ceiling, in an uncancellable worker
  thread, and the wearer only ever sees a timeout.
- **The wearer's tweaks reach every lane, and only this call** (#1940). Model
  crosses as the dispatcher's own argument and prompt as ``stt.prompt`` on the
  overlay, which together cover all three lanes — but LANGUAGE reaches only the
  command and plugin lanes that way, because each built-in re-resolves it from
  a fresh ``_load_stt_config()`` (see ``_dispatch_overlay``). The one seam that
  can set language before a built-in runs is Hermes's documented
  ``pre_transcription`` plugin hook, so this module owns one
  (``pre_transcription_hook``), the adapter registers it, and it answers ONLY
  while ``_CALL_TWEAKS`` is set — i.e. only inside this handler's own dispatch.
  Every other transcription on the gateway (an iMessage voice note, CLI voice
  mode, another platform's audio) fires the same hook with the context unset
  and gets ``None`` back, untouched. That isolation is the load-bearing part.
- **The listing's support flags never gate the wire** (#1940, cross-leg). The
  client sends a set language/prompt on EVERY transcribe call, whatever the
  picked row's ``supportsLanguage``/``supportsPrompt`` said — a turn can happen
  before any listing was fetched, so the wire cannot depend on one. This lane
  reads neither flag on the transcribe path (asserted structurally by
  ``test_the_transcribe_lane_reads_no_listing_support_flag``): it forwards the
  picks and lets Hermes's backend decide, which for ``local_command``, ``xai``
  and ``elevenlabs`` means logging "does not support transcription prompts" and
  dropping it. Never an error envelope — a leftover prompt must not cost the
  wearer an utterance on a provider that would simply have ignored it.
  ``_BUILTIN_SUPPORTS_PROMPT`` annotates the PICKER and nothing else.

Hermes imports stay deferred so the bundle remains importable outside a Hermes
environment; both handler bodies run off the event loop via
``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import re
import stat
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from .models_rpc import _clean_str

STT_METHOD_CAPABILITIES_LIST = "stt.capabilities.list"
STT_METHOD_TRANSCRIBE = "stt.transcribe"

logger = logging.getLogger(__name__)

# Display labels for Hermes's built-in STT backends. Hermes exposes no
# machine-readable label for a built-in (``hermes tools`` hard-codes its own
# picker rows), so the bundle owns the prose. The IDS are never owned here —
# they are read from ``BUILTIN_STT_PROVIDERS`` — so a Hermes release that adds
# a ninth built-in still reaches the wearer (see ``_UNKNOWN_BUILTIN_REASON``).
_BUILTIN_DISPLAY_NAMES: Dict[str, str] = {
    "local": "Local (faster-whisper)",
    "local_command": "Local command (whisper CLI)",
    "groq": "Groq",
    "openai": "OpenAI",
    "mistral": "Mistral (Voxtral)",
    "xai": "xAI Grok",
    "elevenlabs": "ElevenLabs Scribe",
    "deepinfra": "DeepInfra",
}

# Which tweaks the BATCH lane actually honors per built-in, read off
# ``_dispatch_stt_provider`` and each ``_transcribe_*`` body in Hermes 0.20.6
# (tools/transcription_tools.py:3021+). Not inferred from config keys:
# every backend takes a ``prompt=`` argument, and three of them log
# "does not support transcription prompts" and drop it.
#
#   language  every built-in resolves and sends a language hint
#             (``_resolve_stt_language`` + per-provider send), so all True.
#   prompt    local             initial_prompt          :1987
#             local_command     DROPPED with a warning  :2091
#             groq              create_kwargs["prompt"] :2220
#             openai            create_kwargs["prompt"] :2323
#             mistral           complete_kwargs         :2413
#             xai               DROPPED with a warning  :2453
#             elevenlabs        DROPPED with a warning  :2616
#             deepinfra         forwarded to the shared
#                               OpenAI-compatible path  :2761
_DEFAULT_VOCABULARY_BACKENDS = frozenset({"local", "groq", "openai", "mistral", "deepinfra"})

_BUILTIN_SUPPORTS_PROMPT: Dict[str, bool] = {
    "local": True,
    "local_command": False,
    "groq": True,
    "openai": True,
    "mistral": True,
    "xai": False,
    "elevenlabs": False,
    "deepinfra": True,
}

# ElevenLabs historically stores its model under ``model_id``
# (transcription_tools.py:2609 reads ``stt.elevenlabs.model_id``).
_MODEL_CONFIG_KEY: Dict[str, str] = {"elevenlabs": "model_id"}

# ``local_command`` has no config section of its own: Hermes reads its model
# out of ``stt.local`` and normalizes it through the same faster-whisper size
# list (transcription_tools.py:2100 via ``_normalize_local_command_model``).
_CONFIG_ALIAS: Dict[str, str] = {"local_command": "local"}

# Per-provider default-model constants in ``tools.transcription_tools``. Read
# by name at call time: each is env-overridable at Hermes import
# (``STT_GROQ_MODEL`` and friends), so the value is the operator's, not ours.
_DEFAULT_MODEL_CONSTANTS: Dict[str, str] = {
    "local": "DEFAULT_LOCAL_MODEL",
    "local_command": "DEFAULT_LOCAL_MODEL",
    "groq": "DEFAULT_GROQ_STT_MODEL",
    "openai": "DEFAULT_STT_MODEL",
    "mistral": "DEFAULT_MISTRAL_STT_MODEL",
    "elevenlabs": "DEFAULT_ELEVENLABS_STT_MODEL",
}

# Fallback mirror of Hermes's own picker catalog
# (hermes_cli/tools_config.py STT_MODEL_CATALOG, 0.20.6). The live symbol is
# preferred; this exists so an unimportable ``tools_config`` degrades to a
# stale catalog instead of an empty model list. ``xai`` (single model, no
# model parameter) and ``deepinfra`` (live catalog) are absent upstream too.
_FALLBACK_MODEL_CATALOG: Dict[str, List[str]] = {
    "local": ["base", "tiny", "small", "medium", "large-v3"],
    "groq": [
        "whisper-large-v3-turbo",
        "whisper-large-v3",
        "distil-whisper-large-v3-en",
    ],
    "openai": [
        "whisper-1",
        "gpt-4o-mini-transcribe",
        "gpt-4o-transcribe",
        "gpt-transcribe",
    ],
    "elevenlabs": ["scribe_v2", "scribe_v1"],
}

_UNKNOWN_BUILTIN_REASON = (
    "This OcuClaw build cannot check availability for the Hermes built-in "
    "'{pid}'. It was added after the certified Hermes 0.20.6 baseline — "
    "transcribe with it from Hermes directly until OcuClaw is recertified."
)

_UNREACHABLE_COMMAND_KEY_REASON = (
    "Hermes cannot dispatch this command provider: it looks `stt.providers` up "
    "by the lowercased name, so the key must be written in lowercase. Rename "
    "`stt.providers.{name}` to `stt.providers.{lowered}` in the Hermes config."
)

_LAZY_INSTALL_NOTE = (
    "Hermes installs it on the first transcription; opening this list never "
    "triggers that install."
)

# Shared by the listing's `unavailableReason` and the transcribe lane's
# availability refusal (§5f ruling 18) so the wearer reads the SAME sentence in
# the settings row and in the failed turn. Two wordings for one fact is how a
# refusal stops being recognisable as the thing they were already told.
_PROBE_FAILED_REASON = (
    "OcuClaw could not check this provider's availability on the Hermes host."
)
_PLUGIN_PROBE_RAISED_REASON = (
    "This Hermes plugin provider failed its own availability check on the "
    "Hermes host."
)
_PLUGIN_UNAVAILABLE_REASON = (
    "This Hermes plugin provider reports itself unavailable (usually a missing "
    "API key or SDK on the Hermes host)."
)
_BUILTIN_UNAVAILABLE_REASON = (
    "This Hermes built-in reports itself unavailable on the Hermes host."
)


def _section(stt_config: Any, name: str) -> Dict[str, Any]:
    """``stt.<name>`` when it is a dict, else ``{}`` (mirrors _get_stt_section)."""
    if not isinstance(stt_config, dict):
        return {}
    value = stt_config.get(name)
    return value if isinstance(value, dict) else {}


def _raw_stt_section() -> Dict[str, Any]:
    """The operator's OWN ``stt:`` block, with DEFAULT_CONFIG not merged.

    Hermes seeds ``stt.local``, ``stt.groq``, ``stt.openai``, ``stt.mistral``,
    ``stt.xai``, ``stt.elevenlabs`` and ``stt.deepinfra`` into the merged view
    of EVERY install, so presence there means "the schema has a default", not
    "the operator configured this" — the same trap ``_get_provider`` sidesteps
    with ``read_selection`` (transcription_tools.py:1043-1050). Only the
    "did they configure it?" question reads raw; every VALUE still comes from
    the merged config, because a merged default is a value Hermes will really
    use.
    """
    try:
        from hermes_cli.config import read_raw_config

        raw = read_raw_config() or {}
    except Exception:  # noqa: BLE001 — unreadable raw config configures nothing
        return {}
    section = raw.get("stt") if isinstance(raw, dict) else None
    return section if isinstance(section, dict) else {}


def _selected_provider(raw_stt: Dict[str, Any]) -> Optional[str]:
    """The provider the operator actually picked, or None.

    ``read_selection`` is Hermes's single runtime read of the persisted pick
    (tool_backend_helpers.py:316) and already maps the legacy managed row onto
    ``"nous"``; the raw ``stt.provider`` key is the fallback.
    """
    name: Optional[str] = None
    try:
        from tools.tool_backend_helpers import read_selection

        name = _clean_str(read_selection("stt"))
    except Exception:  # noqa: BLE001
        name = None
    if name is None:
        name = _clean_str(raw_stt.get("provider"))
    if name is None:
        return None
    lowered = name.lower()
    # ``stt.provider: nous`` is the managed selection serviced by the OpenAI
    # implementation (transcription_tools.py:1029).
    return "openai" if lowered == "nous" else lowered


def _has_module(tt: Any, dotted: str, flag_name: str) -> bool:
    """Is *dotted* importable, per Hermes's own cached flag then its probe.

    The cached flag is what ``_get_provider`` branches on, so honoring it first
    keeps this listing's verdict identical to the one a transcribe call would
    reach. ``_safe_find_spec`` is a bare ``importlib.util.find_spec`` — it
    catches up with an install that landed after Hermes imported, and it
    executes nothing.
    """
    if bool(getattr(tt, flag_name, False)):
        return True
    probe = getattr(tt, "_safe_find_spec", None)
    if not callable(probe):
        return False
    try:
        return bool(probe(dotted))
    except Exception:  # noqa: BLE001 — a probe failure is "not available"
        return False


def _resolve_key(tt: Any, env_var: str, provider_id: str) -> str:
    """Provider secret via Hermes's single owner (config > env/.env > pool)."""
    resolver = getattr(tt, "_resolve_provider_key", None)
    if not callable(resolver):
        return ""
    try:
        return str(resolver(env_var, provider_id) or "").strip()
    except Exception:  # noqa: BLE001 — never raises upstream; hold that here
        return ""


def _missing_key_reason(env_var: str, label: str) -> str:
    return (
        f"No {label} credential found. Set {env_var} in the Hermes "
        f"environment or add it with `hermes auth add`."
    )


def _probe_local(tt: Any, stt_config: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    if _has_module(tt, "faster_whisper", "_HAS_FASTER_WHISPER"):
        return True, None
    return False, "faster-whisper is not installed. " + _LAZY_INSTALL_NOTE


def _probe_local_command(
    tt: Any, stt_config: Dict[str, Any]
) -> Tuple[bool, Optional[str]]:
    probe = getattr(tt, "_has_local_command", None)
    if callable(probe):
        try:
            if probe():
                return True, None
        except Exception:  # noqa: BLE001
            pass
    return False, (
        "No local transcription command found. Set HERMES_LOCAL_STT_COMMAND "
        "or install a `whisper` CLI on the Hermes host's PATH."
    )


def _probe_groq(tt: Any, stt_config: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    if not _has_module(tt, "openai", "_HAS_OPENAI"):
        return False, "The `openai` package is not installed on the Hermes host."
    if _resolve_key(tt, "GROQ_API_KEY", "groq"):
        return True, None
    return False, _missing_key_reason("GROQ_API_KEY", "Groq")


def _probe_openai(tt: Any, stt_config: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """Credential ladder of ``_resolve_openai_audio_client_config``, read-only.

    Hermes's own boolean probe (``_has_openai_audio_backend``) resolves through
    ``resolve_managed_tool_gateway`` with the refresh-aware token reader, which
    can perform a synchronous OAuth refresh. Upstream ships
    ``is_managed_tool_gateway_ready`` for exactly this case — "read-only
    availability scans avoid synchronous OAuth refresh"
    (tools/managed_tool_gateway.py:204-210) — so use that instead.
    """
    if not _has_module(tt, "openai", "_HAS_OPENAI"):
        return False, "The `openai` package is not installed on the Hermes host."
    section = _section(stt_config, "openai")
    if _clean_str(section.get("api_key")):
        return True, None
    base_url = _clean_str(section.get("base_url"))
    if base_url:
        is_local = getattr(tt, "_is_local_or_private_url", None)
        if callable(is_local):
            try:
                if is_local(base_url):
                    return True, None
            except Exception:  # noqa: BLE001
                pass
    try:
        from tools.tool_backend_helpers import resolve_openai_audio_api_key

        if str(resolve_openai_audio_api_key() or "").strip():
            return True, None
    except Exception:  # noqa: BLE001
        pass
    try:
        from tools.managed_tool_gateway import is_managed_tool_gateway_ready

        if is_managed_tool_gateway_ready("openai-audio"):
            return True, None
    except Exception:  # noqa: BLE001
        pass
    return False, _missing_key_reason(
        "OPENAI_API_KEY", "OpenAI (or VOICE_TOOLS_OPENAI_KEY / Nous managed)"
    )


def _probe_mistral(tt: Any, stt_config: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    if not _has_module(tt, "mistralai", "_HAS_MISTRAL"):
        return False, (
            "The `mistralai` package is not installed on the Hermes host. "
            + _LAZY_INSTALL_NOTE
        )
    if _resolve_key(tt, "MISTRAL_API_KEY", "mistral"):
        return True, None
    return False, _missing_key_reason("MISTRAL_API_KEY", "Mistral")


def _probe_xai(tt: Any, stt_config: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """Explicit key, then the PERSISTED OAuth pool. Never the live resolver.

    ``tools.xai_http.resolve_xai_http_credentials`` — the call
    ``_get_provider`` makes — reaches ``CredentialPool.select()``, which hands
    deferred single-use-token entries (``xai-oauth`` is named among them) to
    ``_refresh_pending_entries``. That refreshes each one under the
    cross-process auth-store lock, a path upstream itself documents as able to
    "block for 20+ seconds", and persists the result
    (agent/credential_pool.py:1849-1884). A settings listing must not write to
    the auth store, and 20 s overruns this lane's 10 s Node-side timeout — the
    same reason ``_probe_openai`` takes the refresh-free managed probe.

    ``read_credential_pool`` is the plain persisted read: entries present means
    the operator authenticated xAI, with no refresh and no write.
    """
    if _resolve_key(tt, "XAI_API_KEY", "xai"):
        return True, None
    try:
        from hermes_cli.auth import read_credential_pool

        if read_credential_pool("xai-oauth"):
            return True, None
    except Exception:  # noqa: BLE001 — an unreadable pool authenticates nobody
        pass
    return False, _missing_key_reason("XAI_API_KEY", "xAI (or xAI OAuth)")


def _probe_elevenlabs(
    tt: Any, stt_config: Dict[str, Any]
) -> Tuple[bool, Optional[str]]:
    if _resolve_key(tt, "ELEVENLABS_API_KEY", "elevenlabs"):
        return True, None
    return False, _missing_key_reason("ELEVENLABS_API_KEY", "ElevenLabs")


def _probe_deepinfra(
    tt: Any, stt_config: Dict[str, Any]
) -> Tuple[bool, Optional[str]]:
    if not _has_module(tt, "openai", "_HAS_OPENAI"):
        return False, "The `openai` package is not installed on the Hermes host."
    if _resolve_key(tt, "DEEPINFRA_API_KEY", "deepinfra"):
        return True, None
    return False, _missing_key_reason("DEEPINFRA_API_KEY", "DeepInfra")


_BUILTIN_PROBES: Dict[
    str, Callable[[Any, Dict[str, Any]], Tuple[bool, Optional[str]]]
] = {
    "local": _probe_local,
    "local_command": _probe_local_command,
    "groq": _probe_groq,
    "openai": _probe_openai,
    "mistral": _probe_mistral,
    "xai": _probe_xai,
    "elevenlabs": _probe_elevenlabs,
    "deepinfra": _probe_deepinfra,
}


def _model_catalog() -> Dict[str, List[str]]:
    """Hermes's own picker catalog, falling back to the pinned mirror."""
    try:
        from hermes_cli.tools_config import STT_MODEL_CATALOG

        if isinstance(STT_MODEL_CATALOG, dict) and STT_MODEL_CATALOG:
            return {
                str(key): [str(item) for item in value if _clean_str(item)]
                for key, value in STT_MODEL_CATALOG.items()
                if isinstance(value, (list, tuple))
            }
    except Exception:  # noqa: BLE001 — the mirror is the whole point
        logger.debug("hermes STT model catalog unavailable; using the mirror")
    return {key: list(value) for key, value in _FALLBACK_MODEL_CATALOG.items()}


def _builtin_models(
    tt: Any,
    pid: str,
    section: Dict[str, Any],
    catalog: Dict[str, List[str]],
) -> Tuple[List[str], Optional[str]]:
    """(models, defaultModel) for one built-in.

    A configured model that is not in the catalog leads the list rather than
    being dropped: the operator's own ``stt.<provider>.model`` is the one id
    guaranteed to work on their install.
    """
    models = list(catalog.get(_CONFIG_ALIAS.get(pid, pid)) or ())
    constant_name = _DEFAULT_MODEL_CONSTANTS.get(pid)
    constant = _clean_str(getattr(tt, constant_name, None)) if constant_name else None
    if not models and constant:
        models = [constant]
    configured = _clean_str(section.get(_MODEL_CONFIG_KEY.get(pid, "model")))
    default = configured or constant or (models[0] if models else None)
    # The resolved default MUST be selectable. Both the operator's own
    # ``stt.<provider>.model`` and an env-overridden constant (``STT_GROQ_MODEL``
    # and friends are read from the environment at Hermes import) can name an
    # id the picker catalog does not carry; crossing as `defaultModel` ∉
    # `models` makes the client drop it and silently substitute the catalog
    # head — a model the wearer never chose.
    if default and default not in models:
        models.insert(0, default)
    return models, default


def _plugin_models(provider: Any) -> Tuple[List[str], Optional[str]]:
    """(models, defaultModel) for one plugin-registered provider.

    Same closing invariant as ``_builtin_models``: the resolved default MUST be
    selectable. ``list_models()`` and ``default_model()`` are two independent
    methods on the ABC and nothing makes a plugin keep them consistent — a
    catalog that raised, or one that simply omits the default, would otherwise
    cross as ``defaultModel`` ∉ ``models``, which the client drops before
    silently substituting the head of the list: a model the wearer never chose.
    """
    models: List[str] = []
    try:
        for entry in provider.list_models() or ():
            if isinstance(entry, dict):
                model_id = _clean_str(entry.get("id"))
            else:
                model_id = _clean_str(entry)
            if model_id and model_id not in models:
                models.append(model_id)
    except Exception:  # noqa: BLE001 — a provider's catalog must not sink the list
        logger.warning(
            "STT provider %r raised from list_models(); listing it with no models",
            getattr(provider, "name", provider),
            exc_info=True,
        )
    default: Optional[str] = None
    try:
        default = _clean_str(provider.default_model())
    except Exception:  # noqa: BLE001
        default = None
    if default is None and models:
        default = models[0]
    elif default is not None and default not in models:
        models.insert(0, default)
    return models, default


def _entry(
    *,
    pid: str,
    display_name: str,
    available: bool,
    unavailable_reason: Optional[str],
    models: List[str],
    default_model: Optional[str],
    supports_language: bool,
    supports_prompt: bool,
) -> Dict[str, Any]:
    return {
        "id": pid,
        "displayName": display_name,
        "available": bool(available),
        "unavailableReason": unavailable_reason if not available else None,
        "models": models,
        "defaultModel": default_model,
        "supportsLanguage": bool(supports_language),
        "supportsPrompt": bool(supports_prompt),
    }


def _dedupe_by_id(
    lanes: Tuple[Tuple[str, List[Dict[str, Any]]], ...],
) -> List[Dict[str, Any]]:
    """One row per id, keeping the lane that would service a transcribe call.

    `id` is the wire key the client renders and dedupes on, so two rows sharing
    one id means one of them silently vanishes on the phone. Decide it here,
    loudly, on Hermes's own precedence rather than leaving it to whichever row
    the client happens to keep.

    Most collisions cannot happen: the registry rejects a plugin whose name
    shadows a built-in, case-insensitively (it lowercases before testing
    `_BUILTIN_NAMES`, transcription_registry.py:78-89) and stores its key
    lowercased, and `_iter_command_stt_providers` skips built-in names. What
    remains reachable is a command-type provider and a plugin provider
    answering to the same non-built-in name — and there Hermes is explicit that
    the command wins (`_dispatch_to_plugin_provider` invariant 2). The row that
    survives here is therefore the row that would actually transcribe.

    Collision is judged case-INSENSITIVELY while each surviving row keeps its
    EXACT id. Only command ids can carry case at all (YAML keys), and the
    lookups on the other side of the collision fold it — the registry
    lowercases, `_resolve_command_stt_provider_config` lowercases — so
    `OpenRouter` and `openrouter` are one provider to Hermes even though they
    are two strings on the wire.
    """
    kept: List[Dict[str, Any]] = []
    claimed: Dict[str, Tuple[str, Dict[str, Any], int]] = {}
    for lane, rows in lanes:
        for row in rows:
            claim_key = row["id"].lower()
            previous = claimed.get(claim_key)
            if previous is None:
                claimed[claim_key] = (lane, row, len(kept))
                kept.append(row)
                continue
            owner_lane, owner_row, owner_slot = previous
            # Lane order is Hermes's precedence, but an UNAVAILABLE incumbent
            # is not the row that would transcribe — the reachable case is a
            # command key Hermes cannot look up at all (see
            # `_command_key_is_reachable`) sitting in front of a plugin that
            # answers to the same name. Precedence over a backend that cannot
            # run is not precedence, it is a silent lie.
            takes_over = owner_row["available"] is False and row["available"] is True
            winner = row if takes_over else owner_row
            winner_lane, loser_lane = (
                (lane, owner_lane) if takes_over else (owner_lane, lane)
            )
            logger.warning(
                "STT provider id %r is claimed by both the %s lane (%s, id "
                "%r) and the %s lane (%s, id %r); the %s provider is the one "
                "that would service a transcribe call, so only that row is "
                "listed and the %s row is dropped",
                claim_key, owner_lane, owner_row["displayName"], owner_row["id"],
                lane, row["displayName"], row["id"], winner_lane, loser_lane,
            )
            if takes_over:
                kept[owner_slot] = winner
                claimed[claim_key] = (winner_lane, winner, owner_slot)
    return kept


# ---------------------------------------------------------------------------
# transcribe (#1939)
# ---------------------------------------------------------------------------

# The Node child force-spills transcribe audio to a temp file rather than
# putting base64 on the link line: `path.join(os.tmpdir(),
# "<prefix><ts>-<rand>")`, written 0600 with O_EXCL
# (extensions/ocuclaw/src/runtime/link-attachment-spill.ts:44-56). Both halves
# resolve the same directory — Node's `os.tmpdir()` and Python's
# `tempfile.gettempdir()` read `TMPDIR` — so the parent can state exactly what
# a legitimate spill path looks like and refuse everything else.
#
# ONE prefix, this lane's own (contract §5f ruling 19): `ocuclaw-stt-`
# (hermes-stt-lane.ts:35), which the Node side deliberately mints for the STT
# lane "so a stray temp file names the lane that leaked it". The shared
# attachment-transport default `ocuclaw-attach-` (link-attachment-spill.ts:31)
# is deliberately NOT accepted: those are the DISPATCH lane's files — a camera
# photo on its way into a session — and a malformed `stt.transcribe` naming one
# would claim (rename) and then delete another lane's in-flight attachment.
# Narrow costs nothing here because the Node STT lane mints only this prefix;
# widening it was the one way this guard could destroy a file it was never
# handed.
_SPILL_BASENAME_PREFIX = "ocuclaw-stt-"

# The name this handler renames a spill file to the instant it takes it
# (contract §5c). Node unlinks the spill best-effort when the RPC settles OR
# when its own 60 s timeout fires — a deliberate race, and the loser would be a
# provider reading a file that vanished mid-transcription. `os.rename` inside
# one directory is atomic, so after it either this handler owns the bytes under
# a name Node has never heard of, or the rename failed and Node still owns
# them; there is no third state and no window.
#
# It shares `_SPILL_BASENAME_PREFIX` so the file this handler creates is one it
# is allowed to delete — which is also why it must be EXCLUDED on the way in
# (§5f ruling 19). A claimed name belongs to a request that is already
# mid-dispatch; a second request naming it would rename it out from under a
# running provider and delete it. The names are random, and this lane no longer
# echoes them to the wearer, but "unguessable" is not a guard.
_OWNED_SPILL_PREFIX = f"{_SPILL_BASENAME_PREFIX}owned-"

# How stale a claimed spill file has to be before the orphan sweep will delete
# it. The Node-side ceiling on a transcribe is 60 s, so an hour is two orders
# of magnitude past anything a live request can still own — the margin exists
# so the sweep can never race a transcription running on a wedged host.
_ORPHAN_SWEEP_MAX_AGE_S = 3600.0

# Once per process, and the flag is guarded because both handlers run on
# `asyncio.to_thread` workers and two RPCs can land together.
_sweep_lock = threading.Lock()
_orphans_swept = False

# The one audio shape the phone packages and this lane accepts: the committed
# PCM with a client-built 16 kHz mono s16le WAV header (spec #1936 / §5).
# Asserted rather than converted — a mismatch means the client leg drifted, and
# silently transcoding it would hide that.
_AUDIO_FORMAT = "wav"
_AUDIO_SAMPLE_RATE_HZ = 16000
_AUDIO_CHANNELS = 1

# `source` is Hermes's caller-surface label, forwarded to the
# `pre_transcription` plugin hook for observability and explicitly "not used
# for dispatch" (transcription_tools.py:2951).
_TRANSCRIBE_SOURCE = "ocuclaw"


def _failed(provider: str, error: str) -> Dict[str, Any]:
    """The lane's own failure envelope, in Hermes's own shape."""
    return {
        "success": False,
        "transcript": "",
        "provider": provider,
        "error": error,
    }


def _envelope_error(raw_error: Any, provider: str) -> Optional[str]:
    """A provider's ``error`` value as wire text, or None when there is none.

    The wire field is a string, but nothing makes a backend hand one over: a
    provider (or a plugin wrapping an HTTP client) can put a dict, a list or an
    exception object there. Running those through ``_clean_str`` returns None,
    which then collapses into the generic "reported failure without saying why"
    — the one message that throws away the only diagnosis the wearer had. So a
    non-text value is stringified faithfully instead, with ``repr`` so a dict
    stays legible as a dict.

    ``None`` and ``False`` are the two ways an envelope says "no error" (Hermes
    omits the key on success, and a plugin may zero it), so neither becomes
    text.
    """
    if raw_error is None or raw_error is False:
        return None
    if isinstance(raw_error, str):
        return _clean_str(raw_error)
    return (
        f"The Hermes STT provider {provider!r} reported a non-text error: "
        f"{raw_error!r}"
    )


def _normalize_envelope(raw: Any, provider: str) -> Dict[str, Any]:
    """Hermes's transcribe result → the four wire fields, values untouched.

    Hermes's own envelope is ``{success, transcript, error?, provider?}`` with
    the last two optional (``_transcribe_prepared_audio`` docstring,
    transcription_tools.py:2955-2960). The wire shape is total, so the missing
    keys are filled — never overwritten. ``provider`` in particular keeps
    Hermes's answer when it gives one: a backend that internally fell back to
    another says so, and the phone should show what actually ran.
    """
    if not isinstance(raw, dict):
        return _failed(
            provider,
            f"The Hermes STT provider {provider!r} returned "
            f"{type(raw).__name__}, not a transcription result.",
        )
    success = bool(raw.get("success"))
    transcript = raw.get("transcript")
    error = _envelope_error(raw.get("error"), provider)
    if not success and error is None:
        error = (
            f"The Hermes STT provider {provider!r} reported failure without "
            "saying why."
        )
    return {
        "success": success,
        "transcript": transcript if isinstance(transcript, str) else "",
        "provider": _clean_str(raw.get("provider")) or provider,
        "error": error,
    }


def _audio_shape_error(audio: Dict[str, Any]) -> Optional[str]:
    """None when the descriptor declares the one shape this lane accepts.

    The client builds the WAV header itself over already-buffered PCM, so these
    three fields are a statement about bytes it produced, not a request. A
    mismatch is a leg-drift bug; saying so beats handing an unknown container
    to a provider and reporting whatever it makes of it.
    """
    declared_format = (_clean_str(audio.get("format")) or "").lower()
    if declared_format != _AUDIO_FORMAT:
        return (
            f"stt.transcribe audio must be {_AUDIO_FORMAT!r}; the request "
            f"declared {audio.get('format')!r}."
        )
    for field, expected in (
        ("sampleRateHz", _AUDIO_SAMPLE_RATE_HZ),
        ("channels", _AUDIO_CHANNELS),
    ):
        value = audio.get(field)
        # `bool` is an `int`; a JSON `true` here is drift, not a sample rate.
        if isinstance(value, bool) or not isinstance(value, int) or value != expected:
            return (
                f"stt.transcribe audio must be {_AUDIO_SAMPLE_RATE_HZ} Hz mono; "
                f"the request declared {field}={value!r}."
            )
    return None


def _spill_dir_candidates() -> Tuple[Path, ...]:
    """Every directory a legitimate control-link spill can sit DIRECTLY in.

    Node's ``os.tmpdir()`` and Python's ``tempfile.gettempdir()`` both read the
    environment, but not in the same order: Node checks ``TMPDIR``, ``TMP``,
    ``TEMP`` (libuv ``uv_os_tmpdir``), Python checks ``TMPDIR``, ``TEMP``,
    ``TMP`` (``tempfile._candidate_tempdir_list``). A host that sets ``TMP``
    and ``TEMP`` to different directories therefore has the two halves of this
    lane disagreeing about where a spill lives — and a guard that compared the
    parent against ONE answer would refuse every transcribe on that host, with
    the wearer's audio sitting in a directory our own child process chose.

    So the parent is matched against the candidate SET: Python's own answer,
    the three env values either runtime would consult, and ``/tmp`` on POSIX.
    Never a directory the REQUEST names — bounding where an unlink can land is
    the entire point of the guard, and a client-declared parent would erase it.
    A candidate that does not resolve to a directory is dropped, so a stray
    env var pointing at a plain file cannot widen where an unlink may land.
    """
    raws: List[str] = [tempfile.gettempdir()]
    for var in ("TMPDIR", "TMP", "TEMP"):
        value = os.environ.get(var)
        if value and value.strip():
            raws.append(value)
    if os.name == "posix":
        raws.append("/tmp")

    candidates: List[Path] = []
    for raw in raws:
        try:
            resolved = Path(raw).resolve(strict=False)
            if not resolved.is_dir():
                continue
        except (OSError, ValueError, RuntimeError):  # noqa: BLE001
            continue
        if resolved not in candidates:
            candidates.append(resolved)
    return tuple(candidates)


def _sweep_orphaned_spills(max_age_s: float = _ORPHAN_SWEEP_MAX_AGE_S) -> List[Path]:
    """Delete claimed spill files no live request could still own.

    A claimed file (``ocuclaw-stt-owned-*``) is deleted by the request that
    made it, on every outcome — but only if that request finishes. Kill the
    adapter mid-transcription and the file is orphaned forever: Node only ever
    unlinks the name IT minted, and this lane's own guard refuses the owned
    prefix by design (§5f ruling 19), so nothing else will ever touch it. Each
    one is up to ~4 MB of the wearer's voice living in a world-readable temp
    directory until the host reboots.

    Age is the safety margin, and it is deliberately far past any real request:
    the Node ceiling is 60 s, so nothing legitimate is an hour old. Only that
    exact prefix, only regular files (a planted symlink is skipped, never
    followed), only inside the candidate temp dirs, and every failure is
    swallowed — a sweep must never be the reason a transcribe does not happen.
    """
    cutoff = time.time() - max_age_s
    swept: List[Path] = []
    for directory in _spill_dir_candidates():
        try:
            found = list(directory.glob(f"{_OWNED_SPILL_PREFIX}*"))
        except OSError:  # noqa: BLE001 — an unreadable tmpdir sweeps nothing
            continue
        for path in found:
            if not path.name.startswith(_OWNED_SPILL_PREFIX):
                continue
            try:
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode):
                    continue
                if info.st_mtime > cutoff:
                    continue
                path.unlink()
            except OSError:  # noqa: BLE001 — best effort, always
                continue
            swept.append(path)
    if swept:
        logger.warning(
            "swept %d orphaned STT spill file(s) left by an interrupted "
            "transcribe: %s",
            len(swept), ", ".join(str(path) for path in swept),
        )
    return swept


def _maybe_sweep_orphaned_spills() -> None:
    """Run the orphan sweep once per process, from the first handler body.

    Both handler bodies are already on a worker thread, so a directory scan
    here cannot stall the control link — which is why this hangs off the first
    CALL rather than off ``SttRpc.__init__``, where it would run on the event
    loop and where a per-request construction would rescan the temp directory
    every turn. Once is enough: orphans are made by a process that died, so the
    next process start is exactly when they become collectable.
    """
    global _orphans_swept
    with _sweep_lock:
        if _orphans_swept:
            return
        _orphans_swept = True
    _sweep_orphaned_spills()


def _resolve_spill_path(raw: str) -> Tuple[Optional[Path], Optional[str]]:
    """(spill file, None) when *raw* is a control-link spill file, else (None, why).

    A malformed or hostile request names a path; this handler deletes what it
    is given. So the only paths it will ever delete are the ones the Node
    child could actually have created: this lane's spill basename sitting
    DIRECTLY in one of the system temp directories the two runtimes can
    disagree about (`_spill_dir_candidates`). `resolve()` is what makes that a
    real guard rather than a string test — a symlink planted under a permitted
    basename resolves to its target, whose parent is then not a temp dir.

    A path that fails this is rejected AND left on disk: refusing to transcribe
    someone else's file must not turn into deleting it. That covers the two
    names this lane must never take (§5f ruling 19) — a dispatch-lane
    `ocuclaw-attach-` spill, and an `ocuclaw-stt-owned-` file another transcribe
    is mid-dispatch on — both of which are refused WITHOUT being unlinked.
    """
    try:
        resolved = Path(raw).resolve(strict=False)
    except (OSError, ValueError, RuntimeError) as exc:  # noqa: BLE001
        return None, f"The audio path {raw!r} could not be resolved: {exc}"
    candidates = _spill_dir_candidates()
    name = resolved.name
    if (
        resolved.parent not in candidates
        or not name.startswith(_SPILL_BASENAME_PREFIX)
        or name.startswith(_OWNED_SPILL_PREFIX)
    ):
        where = " or ".join(str(directory) for directory in candidates) or "(none)"
        return None, (
            f"The audio path {raw!r} is not a control-link spill file this "
            f"lane may claim ({_SPILL_BASENAME_PREFIX}* directly inside "
            f"{where}, and never an already-claimed "
            f"{_OWNED_SPILL_PREFIX}* name). It was refused and left untouched."
        )
    return resolved, None


def _claim_spill(path: Path) -> Tuple[Optional[Path], Optional[str]]:
    """Take ownership of the spill bytes by renaming them out from under Node.

    Called BEFORE any validation beyond the path guard and before any slow
    work, because everything after it — a stat, a config read, a
    minutes-long provider call — is time in which Node's timeout can fire and
    unlink the name it knows.

    `FileNotFoundError` means Node reclaimed it first (its RPC already timed
    out, or the frame was replayed): the audio is gone, so this is a clean
    expired-request refusal, not a failure to report. Any other `OSError`
    leaves the original where it was, still Node's to reclaim — this handler
    only ever deletes a file it successfully renamed.
    """
    # Hermes's OpenAI-compatible providers pass the opened file object to the
    # SDK, which derives the multipart filename from this path. Keep the
    # declared container suffix so a valid WAV is not rejected as an unknown
    # format after the ownership rename.
    owned = path.parent / (
        f"{_OWNED_SPILL_PREFIX}{uuid.uuid4().hex}.{_AUDIO_FORMAT}"
    )
    try:
        os.rename(path, owned)
    except FileNotFoundError:
        return None, (
            f"The audio spill file {path} was already reclaimed by the relay "
            "(the request expired or was replayed); nothing was transcribed."
        )
    except OSError as exc:  # noqa: BLE001
        return None, (
            f"OcuClaw could not take ownership of the audio spill file "
            f"{path}: {exc}"
        )
    return owned, None


def _discard_spill(path: Optional[Path]) -> None:
    """Unlink a spill file, best effort. Called on EVERY transcribe outcome."""
    if path is None:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:  # noqa: BLE001 — a leaked temp file must not fail a turn
        logger.warning("could not delete the STT spill file %s: %s", path, exc)


def _command_provider_ids(tt: Any, stt_config: Dict[str, Any]) -> set:
    """Declared ``type: command`` ids, EXACTLY as the operator keyed them.

    Never lowercased. ``stt.providers`` is a YAML mapping, so its keys are
    case-preserving, and both the enumerator the listing reads
    (``_iter_command_stt_providers``, transcription_tools.py:500) and the
    lookup dispatch performs (``_get_named_stt_provider_config`` →
    ``providers.get(name)``, :442) work on the literal key. Folding case here
    would publish an id the operator never wrote.
    """
    try:
        return {
            name
            for name, config in tt._iter_command_stt_providers(stt_config)
            if isinstance(name, str) and isinstance(config, dict)
        }
    except Exception:  # noqa: BLE001 — unenumerable means "declares nobody"
        logger.warning(
            "could not enumerate command-type STT providers", exc_info=True
        )
        return set()


def _command_key_is_reachable(name: str) -> bool:
    """Can Hermes 0.20.6 look this command provider up at all?

    Verified against the pinned tree, not inferred: dispatch enters at
    ``_resolve_command_stt_provider_config``, which lowercases the picked name
    (transcription_tools.py:478) and hands it to
    ``_get_named_stt_provider_config``, which does an EXACT
    ``providers.get(name)`` (:442). So a key that is not already lowercase can
    never be found — probing the real 0.20.6, a `stt.providers.MyASR`
    declaration MISSES under both `"MyASR"` and `"myasr"`, while a
    `stt.providers.myasr` declaration is FOUND under either.

    That makes the mismatch an operator-config defect, not a casing choice on
    this side: no id we could send would dispatch it. The listing says so with
    `available:false` instead of publishing a row that always fails, and
    transcribe refuses the pick by name.
    """
    return name == name.lower()


def _builtin_ids(tt: Any) -> set:
    try:
        return {str(name) for name in tt.BUILTIN_STT_PROVIDERS}
    except Exception:  # noqa: BLE001
        return set()


def _registry_provider(key: str) -> Any:
    """The plugin-registered provider answering to *key*, or None."""
    try:
        from agent.transcription_registry import get_provider

        # The registry owns its own case rule — it lowercases on both register
        # and lookup (transcription_registry.py:80, :123) — and the listing
        # publishes plugin ids already lowercased to match.
        return get_provider(key)
    except Exception:  # noqa: BLE001 — no registry, no plugin providers
        logger.debug("hermes transcription registry unavailable")
        return None


def _with_default_vocabulary(
    tt: Any, stt_config: Dict[str, Any], provider: str, prompt: Optional[str],
) -> Optional[str]:
    """Augment only prompt-capable dispatch paths, without consulting the UI listing.

    User prompts still reach unsupported providers unchanged. No config is mutated,
    and this helper runs only for an OcuClaw transcription, never other gateway audio.
    """
    if provider in _builtin_ids(tt):
        supported = provider in _DEFAULT_VOCABULARY_BACKENDS
    elif provider in _command_provider_ids(tt, stt_config):
        supported = False
    else:
        supported = _registry_provider(provider) is not None
    if not supported:
        return prompt
    effective = prompt if prompt is not None else _clean_str(stt_config.get("prompt"))
    if effective and re.search(r"(?<!\w)ocuclaw(?!\w)", effective, re.IGNORECASE):
        return effective
    return f"{effective}\nOcuClaw" if effective else "OcuClaw"


def _dispatch_refusal(
    tt: Any, stt_config: Dict[str, Any], key: str
) -> Optional[str]:
    """None when Hermes would route *key* to a backend, else why it would not.

    Order mirrors ``_dispatch_stt_provider`` itself: built-in, then a
    ``stt.providers.<name>: type: command`` declaration, then the plugin
    registry's public ``get_provider``. Asked BEFORE dispatching so an id the
    phone should never have sent comes back as a named error rather than as
    Hermes's generic "No STT provider available. Install faster-whisper..."
    setup hint, which reads like the wearer's Hermes is broken.

    Two refusals, not one, because they have different fixes: an id Hermes has
    never heard of is a stale pick the wearer clears by re-opening settings,
    while a mixed-case ``stt.providers`` key is an operator config defect no id
    could route (§5e ruling 13) — and the listing already tells them the exact
    rename. Sending "no provider named 'MyASR'" for a key they can plainly see
    in their own config is the least useful true thing this lane could say.
    """
    # Exact, like every step around it: the ids are lowercase at the source,
    # the listing publishes them verbatim, and `_dispatch_stt_provider`
    # compares them with `==` (transcription_tools.py:3040+). Folding case here
    # would admit a `"GROQ"` this lane never offered and that seam never routes.
    if key in _builtin_ids(tt):
        return None
    if key in _command_provider_ids(tt, stt_config):
        if _command_key_is_reachable(key):
            return None
        return _UNREACHABLE_COMMAND_KEY_REASON.format(
            name=key, lowered=key.lower()
        )
    if _registry_provider(key) is not None:
        return None
    return (
        f"Hermes has no STT provider named {key!r}. Re-open voice settings to "
        "refresh the provider list."
    )


def _unavailable_reason(
    tt: Any, stt_config: Dict[str, Any], key: str
) -> Optional[str]:
    """None when *key* can run right now, else the listing's own reason.

    Contract §5f ruling 18. Picking `local` on a host without faster-whisper
    used to enter Hermes's lazy install (`_transcribe_local` →
    `_try_lazy_install_stt`) — hundreds of megabytes, minutes long, inside a
    60 s Node-side ceiling, in an `asyncio.to_thread` worker nobody can cancel.
    The relay abandons the request every time and the wearer sees a timeout;
    the install may or may not finish behind it. So the same read-only probes
    the LISTING uses are asked first, and a provider they call unavailable is
    refused with the wording the settings screen already showed — which is the
    actionable half ("set GROQ_API_KEY", "install faster-whisper").

    Strictly a read: `_BUILTIN_PROBES` are cached import flags, `find_spec`,
    PATH lookups and config/env/credential-pool reads, and the plugin lane asks
    the provider's own `is_available()`. Nothing here installs, refreshes or
    writes — the property `test_listing_never_triggers_a_lazy_model_install`
    pins for the listing lane holds identically here.

    Two deliberate passes:

    - A built-in this build has no probe for (added after the certified 0.20.6
      baseline) is UNKNOWABLE, not unavailable. Refusing it would make a new
      Hermes built-in permanently untranscribable through OcuClaw; letting it
      through means Hermes answers for itself, which is the honest fallback.
    - A `type: command` provider's command is a shell template this process
      must not run to check, so declaring one is the only availability signal
      there is — the same stance the listing takes.
    """
    if key in _builtin_ids(tt):
        probe = _BUILTIN_PROBES.get(key)
        if probe is None:
            return None
        try:
            available, reason = probe(tt, stt_config)
        except Exception:  # noqa: BLE001 — one broken probe, one clean refusal
            logger.warning(
                "availability probe for STT provider %r failed", key,
                exc_info=True,
            )
            return _PROBE_FAILED_REASON
        if available:
            return None
        return reason or _BUILTIN_UNAVAILABLE_REASON
    if key in _command_provider_ids(tt, stt_config):
        return None
    provider = _registry_provider(key)
    if provider is None:
        return None
    try:
        if provider.is_available():
            return None
    except Exception:  # noqa: BLE001 — documented never to raise; hold it here
        logger.warning(
            "STT provider %r raised from is_available()", key, exc_info=True
        )
        return _PLUGIN_PROBE_RAISED_REASON
    return _PLUGIN_UNAVAILABLE_REASON


@dataclass(frozen=True)
class _SttCallTweaks:
    """The one call's picks — the single source both tweak channels read.

    The wearer's model/language/prompt reach Hermes through two different
    channels (the config overlay handed to ``_dispatch_stt_provider``, and the
    ``pre_transcription`` hook that fires inside it), and two channels that
    each re-derive their own values is exactly how they end up disagreeing.
    So the handler builds this ONCE per call; ``_dispatch_overlay`` and
    ``pre_transcription_hook`` both read it and neither owns a value of its
    own. ``provider`` is carried for the hook's re-entrancy guard, not for the
    overlay's benefit alone.
    """

    provider: str
    model: Optional[str] = None
    language: Optional[str] = None
    prompt: Optional[str] = None

    def hook_overrides(self) -> Dict[str, str]:
        """The picks as ``pre_transcription`` mutable fields.

        Absent picks stay ABSENT rather than crossing as ``None``: the hook
        contract is "return a dict mutating any of prompt/language/model", and
        a field this call did not pick must leave Hermes's own resolution
        exactly as it was. (``_apply_pre_transcription_hook`` drops non-string
        values anyway — transcription_tools.py:1477 — but relying on a
        peer's leniency to express "no opinion" is not a contract.)
        """
        return {
            name: value
            for name, value in (
                ("model", self.model),
                ("language", self.language),
                ("prompt", self.prompt),
            )
            if value is not None
        }


#: Set ONLY for the duration of one ``stt.transcribe`` dispatch (see
#: ``_scoped_call_tweaks``). Unset everywhere else on the gateway, which is
#: what makes ``pre_transcription_hook`` a no-op for every transcription this
#: lane did not start.
_CALL_TWEAKS: "contextvars.ContextVar[Optional[_SttCallTweaks]]" = (
    contextvars.ContextVar("ocuclaw_stt_call_tweaks", default=None)
)

#: The Hermes hook this lane registers (``hermes_cli.plugins.VALID_HOOKS``,
#: 0.20.6+). Named here rather than in ``adapter.py`` because the callback and
#: its context live here; the adapter only wires it.
PRE_TRANSCRIPTION_HOOK_NAME = "pre_transcription"


@contextmanager
def _scoped_call_tweaks(tweaks: _SttCallTweaks) -> Iterator[None]:
    """Publish *tweaks* to ``pre_transcription_hook`` for one dispatch.

    **Where this runs, and why the window is safe.** ``transcribe()`` sends the
    whole synchronous body to ``asyncio.to_thread``, which copies the caller's
    context (``contextvars.copy_context()``) and runs the function under
    ``ctx.run(...)`` in a worker thread — so the set below happens inside that
    per-call copy. Two consequences, both wanted:

    * the hook fires deeper in the SAME call stack, in the same thread, under
      that same context, so it sees the value (proved by
      ``test_call_tweaks_survive_the_to_thread_hop``);
    * the copy is per-``to_thread``-call, so this set can never leak back out
      to the event loop's context or sideways into a concurrent task — a
      second transcription, or any other gateway transcription, runs under its
      own context and sees ``None``.

    The ``reset`` in the ``finally`` is belt-and-braces on top of that: it
    keeps the window to the dispatch call itself even if the copy semantics
    ever change under us.
    """
    token = _CALL_TWEAKS.set(tweaks)
    try:
        yield
    finally:
        _CALL_TWEAKS.reset(token)


def pre_transcription_hook(**kwargs: Any) -> Optional[Dict[str, str]]:
    """Hermes ``pre_transcription`` callback — the built-ins' language seam.

    Fired by ``_dispatch_stt_provider`` after provider resolution and before
    ANY backend runs (transcription_tools.py:3043 →
    ``_apply_pre_transcription_hook`` at :1409), with kwargs ``file_path``,
    ``provider``, ``model``, ``language``, ``prompt``, ``source``. A dict
    result mutates ``model``/``language``/``prompt``; ``file_path`` is
    read-only; anything else is ignored upstream.

    This callback is registered gateway-wide — it fires for EVERY transcription
    on the host, including ones OcuClaw has nothing to do with. So it answers
    on exactly one condition: ``_CALL_TWEAKS`` is set, which happens only
    inside ``_scoped_call_tweaks`` around this lane's own dispatch. Unset (an
    iMessage voice note, ``hermes voice``, another platform's audio) → ``None``
    → Hermes's merge loop skips it entirely and the dispatch is byte-identical
    to a host with no plugin loaded.

    The ``provider`` cross-check is the re-entrancy guard: our context is only
    ever live around one dispatch of one provider, so a hook firing under it
    for a DIFFERENT provider means something re-entered the dispatcher, and
    injecting this call's tweaks into that one would be the exact
    cross-contamination this scoping exists to prevent. ``source`` is not
    checked — ``provider`` is load-bearing to dispatch and so cannot be
    normalized out from under us, whereas ``source`` is a logging string.

    Fail-open, twice over: any raise here is swallowed (``None``), and
    ``_apply_pre_transcription_hook`` is itself wrapped in a bare ``except``
    (:1490) — a broken hook must never cost the wearer a transcription.
    """
    try:
        tweaks = _CALL_TWEAKS.get()
        if tweaks is None:
            return None
        provider = kwargs.get("provider")
        if provider != tweaks.provider:
            logger.debug(
                "pre_transcription fired for provider %r inside the "
                "%r call scope — passing through untouched",
                provider, tweaks.provider,
            )
            return None
        return tweaks.hook_overrides() or None
    except Exception:  # noqa: BLE001 — a hook raise must never break STT
        logger.warning("[ocuclaw] pre_transcription glue failed", exc_info=True)
        return None


def _dispatch_overlay(
    stt_config: Dict[str, Any],
    tweaks: _SttCallTweaks,
) -> Dict[str, Any]:
    """A copy of the stt config carrying the phone's language/prompt picks.

    ``_dispatch_stt_provider`` takes model as an argument (it overrides config
    in every branch) and reads ``prompt`` off ``stt.prompt`` of the config it
    is handed (transcription_tools.py:3021), passing it straight to every
    backend — so the PROMPT pick reaches all three lanes through Hermes's own
    resolution rather than a second one written here.

    ``language`` is written under the section Hermes reads for this backend,
    which is the ALIASED one: ``local_command`` has no config section of its
    own and resolves its language from ``stt.local``
    (``_transcribe_local_command`` → ``_resolve_stt_language("local")``,
    :2110), the same aliasing ``_CONFIG_ALIAS`` already applies to its model.
    The unaliased key is written too when it differs, because
    ``_dispatch_stt_provider`` itself reads the RAW provider name at :3043.

    **Reach, stated honestly** (verified against the pinned 0.20.6): the
    language pick lands for the command lane (``_transcribe_command_stt`` →
    ``_resolve_stt_language(provider_name, stt_config)``, :930) and the plugin
    lane (:3150) — both thread this config object through. It does NOT reach
    the eight BUILT-INS by this route: :3043 feeds the config language into
    ``_apply_pre_transcription_hook``, which returns ``None`` for language
    unless a ``pre_transcription`` plugin hook explicitly sets one (:1440,
    :1492), and each built-in then re-resolves from a FRESH
    ``_load_stt_config()`` — ``_resolve_stt_language("groq")`` at :2208 and
    friends take no config argument. No value this lane can put in an
    in-memory overlay is visible there.

    That last gap is what ``pre_transcription_hook`` closes (#1940, contract
    ruling 14): the same ``tweaks`` object feeds both channels, so the overlay
    and the hook state the same language by construction and the built-in gets
    it as an explicit ``language=`` argument. This function stays as it is —
    the hook complements it, it does not replace it. The command and plugin
    lanes keep reaching their language through Hermes's own config resolution
    (one less thing depending on a hook being registered), and prompt keeps
    riding ``stt.prompt`` here for all three.

    Absent picks are left absent, so a wearer who set nothing gets exactly what
    a Hermes-side transcription would have used.
    """
    overlay = dict(stt_config)
    if tweaks.prompt is not None:
        overlay["prompt"] = tweaks.prompt
    if tweaks.language is not None:
        provider = tweaks.provider
        for key in {_CONFIG_ALIAS.get(provider, provider), provider}:
            section = dict(_section(overlay, key))
            section["language"] = tweaks.language
            overlay[key] = section
    return overlay


class SttRpc:
    """``stt.*`` control-link handlers (child → parent).

    Stateless: every call re-reads Hermes config and the live registry, because
    the phone refreshes this listing precisely when the operator has just
    changed something Hermes-side.
    """

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        """method → async handler, for LinkProcess.register_request_handler."""
        return {
            STT_METHOD_CAPABILITIES_LIST: self.capabilities_list,
            STT_METHOD_TRANSCRIBE: self.transcribe,
        }

    async def capabilities_list(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_capabilities_list, params)

    async def transcribe(self, params: Any) -> Dict[str, Any]:
        """One batch transcription of one committed utterance.

        A batch STT call is seconds of blocking work — an HTTP round trip, or a
        faster-whisper decode, or a pip install on the first local run. Running
        it on the event loop would stall the whole control link (every session
        RPC, every stream delta) for its duration, so the body goes to a worker
        thread and this coroutine is only ever waiting.
        """
        return await asyncio.to_thread(self._sync_transcribe, params)

    # -- listing -----------------------------------------------------------

    def _sync_capabilities_list(self, _params: Any) -> Dict[str, Any]:
        _maybe_sweep_orphaned_spills()
        try:
            from tools import transcription_tools as tt
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"Hermes transcription surface is unavailable: {exc}"
            ) from exc

        try:
            stt_config = tt._load_stt_config() or {}
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Could not read the Hermes stt config: {exc}") from exc
        if not isinstance(stt_config, dict):
            stt_config = {}

        # ``stt.enabled: false`` is the operator switching the whole surface
        # off. Nothing here is pickable, and annotating eight providers with
        # the same reason would bury that one fact — so this is the honest
        # empty listing the phone renders as "no STT configured in Hermes".
        try:
            if not tt.is_stt_enabled(stt_config):
                return {"providers": []}
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"Could not read the Hermes stt config: {exc}"
            ) from exc

        # Wire order IS Hermes's dispatch precedence: built-in > command-type
        # > plugin (transcription_tools.py:379-410, and
        # `_dispatch_to_plugin_provider` invariants 1-2 re-verify it).
        lanes = (
            ("built-in", self._builtin_entries(tt, stt_config)),
            ("command-type", self._command_entries(tt, stt_config)),
            ("plugin", self._plugin_entries()),
        )
        return {"providers": _dedupe_by_id(lanes)}

    def _builtin_entries(
        self, tt: Any, stt_config: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Hermes's built-in backends, listed when usable OR configured.

        The ids come from ``BUILTIN_STT_PROVIDERS`` — never a local list.

        "Configured" is what keeps the honest empty state reachable: an install
        with no ``stt:`` block of its own has picked nothing, and eight rows of
        "set an API key" is not a settings screen, it is a catalog. Once the
        operator names a provider or writes its config section, the row appears
        — and stays visible with its reason when the credential or package is
        missing, which is the case the wearer needs to see. That question is
        asked of the RAW config, for the reason ``_raw_stt_section`` documents.
        """
        try:
            builtin_ids = sorted(str(name) for name in tt.BUILTIN_STT_PROVIDERS)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"Could not enumerate the Hermes built-in STT providers: {exc}"
            ) from exc

        raw_stt = _raw_stt_section()
        selected = _selected_provider(raw_stt)
        catalog = _model_catalog()

        entries: List[Dict[str, Any]] = []
        for pid in builtin_ids:
            # Values read the aliased MERGED section; "has the operator
            # configured this?" is the presence of the provider's OWN key in
            # the RAW block — writing `stt.openai:` at all is a configuration
            # act even when it is empty, and an `stt.local` block must not
            # conjure a `local_command` row nobody picked.
            configured = pid in raw_stt
            section = _section(stt_config, _CONFIG_ALIAS.get(pid, pid))
            probe = _BUILTIN_PROBES.get(pid)
            if probe is None:
                # A built-in this build has never seen. Availability is
                # unknowable, so it can only earn a row by being configured —
                # and then it says why it is not offered rather than vanishing.
                if not (configured or selected == pid):
                    continue
                logger.warning(
                    "Hermes built-in STT provider %r is unknown to this "
                    "OcuClaw build; listing it as unavailable",
                    pid,
                )
                entries.append(
                    _entry(
                        pid=pid,
                        display_name=pid,
                        available=False,
                        unavailable_reason=_UNKNOWN_BUILTIN_REASON.format(pid=pid),
                        models=[],
                        default_model=None,
                        supports_language=False,
                        supports_prompt=False,
                    )
                )
                continue
            try:
                available, reason = probe(tt, stt_config)
            except Exception:  # noqa: BLE001 — one broken probe, one bad row
                logger.warning(
                    "availability probe for STT provider %r failed", pid,
                    exc_info=True,
                )
                available, reason = False, _PROBE_FAILED_REASON
            if not (available or configured or selected == pid):
                continue
            models, default_model = _builtin_models(tt, pid, section, catalog)
            entries.append(
                _entry(
                    pid=pid,
                    display_name=_BUILTIN_DISPLAY_NAMES.get(pid, pid),
                    available=available,
                    unavailable_reason=reason,
                    models=models,
                    default_model=default_model,
                    supports_language=True,
                    supports_prompt=_BUILTIN_SUPPORTS_PROMPT.get(pid, False),
                )
            )
        return entries

    def _command_entries(
        self, tt: Any, stt_config: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """``stt.providers.<name>: type: command`` shell backends.

        Declaring one IS configuring it, and its command is a shell template
        this process must not run to check — so a declared command provider is
        listed as available, UNLESS its key is one Hermes cannot look up (see
        `_command_key_is_reachable`), which is a config defect the wearer needs
        told rather than a row that fails on every use.

        ``{language}`` and ``{model}`` are placeholders in
        the grammar; there is no ``{prompt}``, and
        ``_transcribe_command_stt`` logs and drops one
        (tools/transcription_tools.py:900-905).
        """
        rows: List[Tuple[str, Dict[str, Any]]] = []
        try:
            for name, config in tt._iter_command_stt_providers(stt_config):
                if isinstance(name, str) and isinstance(config, dict):
                    rows.append((name, config))
        except Exception:  # noqa: BLE001
            logger.warning(
                "could not enumerate command-type STT providers", exc_info=True
            )
            return []

        entries: List[Dict[str, Any]] = []
        for name, config in sorted(rows, key=lambda row: row[0]):
            configured = _clean_str(config.get("model"))
            reachable = _command_key_is_reachable(name)
            entries.append(
                _entry(
                    pid=name,
                    display_name=_clean_str(config.get("display_name"))
                    or name.replace("_", " ").title(),
                    available=reachable,
                    unavailable_reason=None
                    if reachable
                    else _UNREACHABLE_COMMAND_KEY_REASON.format(
                        name=name, lowered=name.lower()
                    ),
                    models=[configured] if configured else [],
                    default_model=configured,
                    supports_language=True,
                    supports_prompt=False,
                )
            )
        return entries

    def _plugin_entries(self) -> List[Dict[str, Any]]:
        """Plugin-registered ``TranscriptionProvider`` instances.

        Registered is configured, so every one is listed.
        ``TranscriptionProvider.transcribe`` takes ``language`` as a formal
        keyword and the dispatcher forwards ``prompt`` through ``**extra``
        (agent/transcription_provider.py:145-198), so both tweaks reach the
        provider. Whether it acts on them is the provider's business — the ABC
        carries no capability metadata to read, and the dispatcher offers both
        to every provider.
        """
        try:
            from agent.transcription_registry import list_providers
        except Exception:  # noqa: BLE001 — no registry, no plugin providers
            logger.debug("hermes transcription registry unavailable")
            return []
        try:
            registered = list(list_providers() or ())
        except Exception:  # noqa: BLE001 — one lane must not sink the listing
            # Every OTHER failure in this module degrades: a probe that raises
            # is one bad row, a plugin whose catalog explodes is one empty
            # model list, an unenumerable command block "declares nobody". A
            # registry that throws — which any third-party plugin's import-time
            # side effect can cause — used to be the one exception, and it took
            # the whole listing down with it: eight healthy built-ins replaced
            # by a JSON-RPC error the phone renders as "Hermes STT is broken".
            # The honest degradation is the lane going quiet, exactly like a
            # host with no registry at all.
            logger.warning(
                "could not list the Hermes transcription registry; listing "
                "without the plugin lane",
                exc_info=True,
            )
            return []

        entries: List[Dict[str, Any]] = []
        for provider in registered:
            pid = _clean_str(getattr(provider, "name", None))
            if pid is None:
                continue
            try:
                display_name = _clean_str(provider.display_name) or pid
            except Exception:  # noqa: BLE001
                display_name = pid
            reason: Optional[str] = None
            try:
                # Documented never to raise; a plugin that does anyway must
                # not take the whole listing down with it.
                available = bool(provider.is_available())
            except Exception:  # noqa: BLE001
                logger.warning(
                    "STT provider %r raised from is_available()", pid, exc_info=True
                )
                available = False
                reason = _PLUGIN_PROBE_RAISED_REASON
            if not available and reason is None:
                reason = _PLUGIN_UNAVAILABLE_REASON
            models, default_model = _plugin_models(provider)
            entries.append(
                _entry(
                    pid=pid.lower(),
                    display_name=display_name,
                    available=available,
                    unavailable_reason=reason,
                    models=models,
                    default_model=default_model,
                    supports_language=True,
                    supports_prompt=True,
                )
            )
        return entries

    # -- transcribe --------------------------------------------------------

    def _sync_transcribe(self, params: Any) -> Dict[str, Any]:
        """Spill-file lifecycle owner. Delegates the decision to `_transcribed`.

        Split exactly here because the spill file has two states and only two:
        either the request named a real control-link spill file — in which case
        it is deleted no matter what happens next, including an exception this
        handler did not anticipate — or it did not, in which case nothing on
        disk is touched at all.
        """
        _maybe_sweep_orphaned_spills()
        provider = _clean_str(
            params.get("provider") if isinstance(params, dict) else None
        )
        if provider is None:
            return _failed(
                "",
                "stt.transcribe needs a provider; the phone must send the id "
                "it picked from stt.capabilities.list.",
            )
        # NOT lowercased: the id is carried through pick → dispatchability
        # check → dispatch exactly as the listing published it. Built-in ids
        # are lowercase at the source, plugin ids are lowercased by the
        # registry that owns them, and command ids are case-preserving YAML
        # keys Hermes looks up literally — folding case here would rewrite the
        # one of the three that cannot survive it.

        audio = params.get("audio") if isinstance(params, dict) else None
        if not isinstance(audio, dict):
            return _failed(
                provider, "stt.transcribe needs an `audio` object; none was sent."
            )

        spill: Optional[Path] = None
        raw_path = audio.get("path")
        if isinstance(raw_path, str) and raw_path.strip():
            candidate, guard_error = _resolve_spill_path(raw_path.strip())
            if guard_error is not None:
                # Refused before anything is unlinked: see `_resolve_spill_path`.
                return _failed(provider, guard_error)
            assert candidate is not None
            # Ownership FIRST, then everything else (§5c) — see `_claim_spill`.
            spill, claim_error = _claim_spill(candidate)
            if claim_error is not None:
                return _failed(provider, claim_error)

        try:
            return self._transcribed(provider, params, audio, spill)
        except Exception as exc:  # noqa: BLE001 — a raise would strand the phone
            logger.warning(
                "stt.transcribe failed unexpectedly on provider %r",
                provider, exc_info=True,
            )
            return _failed(
                provider,
                f"OcuClaw could not transcribe with the Hermes provider "
                f"{provider!r}: {type(exc).__name__}: {exc}",
            )
        finally:
            _discard_spill(spill)

    def _transcribed(
        self,
        provider: str,
        params: Dict[str, Any],
        audio: Dict[str, Any],
        spill: Optional[Path],
    ) -> Dict[str, Any]:
        """Validate, then hand the picked provider to Hermes's own dispatcher."""
        # Inline base64 is refused rather than decoded. The link line is a
        # single JSON frame shared with every other RPC; minutes of WAV on it
        # is what the force-spill exists to prevent, and accepting it here
        # would make the spill path optional in practice (§2.2).
        if _clean_str(audio.get("content")) is not None:
            return _failed(
                provider,
                "stt.transcribe audio must cross as a spilled temp file; "
                "inline `content` is not accepted on the control link.",
            )
        if spill is None:
            return _failed(
                provider,
                "stt.transcribe audio carried no spill-file `path`.",
            )
        # The CLAIMED name stays out of every wearer-reachable string from here
        # down (§5f ruling 19). It is the one name that, echoed back, tells a
        # caller which file a transcribe currently owns; the operator gets it
        # from the log, where the request that minted it is the only reader.
        if not spill.is_file():
            logger.warning("the claimed STT spill file %s does not exist", spill)
            return _failed(
                provider, "The claimed audio spill file does not exist."
            )
        try:
            if spill.stat().st_size == 0:
                logger.warning("the claimed STT spill file %s is empty", spill)
                return _failed(
                    provider, "The claimed audio spill file is empty."
                )
        except OSError as exc:  # noqa: BLE001
            logger.warning(
                "the claimed STT spill file %s is unreadable: %s", spill, exc
            )
            # `str(OSError)` carries the filename; `strerror` does not.
            return _failed(
                provider,
                "The claimed audio spill file is unreadable: "
                f"{exc.strerror or type(exc).__name__}.",
            )

        shape_error = _audio_shape_error(audio)
        if shape_error is not None:
            return _failed(provider, shape_error)

        model = _clean_str(params.get("model"))
        language = _clean_str(params.get("language"))
        prompt = _clean_str(params.get("prompt"))

        try:
            from tools import transcription_tools as tt
        except Exception as exc:  # noqa: BLE001
            return _failed(
                provider, f"Hermes transcription surface is unavailable: {exc}"
            )

        try:
            stt_config = tt._load_stt_config() or {}
        except Exception as exc:  # noqa: BLE001
            return _failed(provider, f"Could not read the Hermes stt config: {exc}")
        if not isinstance(stt_config, dict):
            stt_config = {}

        # The listing returns `{providers: []}` when the operator switched the
        # surface off, so the phone cannot offer a pick — but a stale pick can
        # still arrive from a settings screen opened before the flip. Hermes's
        # own wording, from `_transcribe_prepared_audio` (:2980).
        try:
            enabled = tt.is_stt_enabled(stt_config)
        except Exception as exc:  # noqa: BLE001
            return _failed(provider, f"Could not read the Hermes stt config: {exc}")
        if not enabled:
            return _failed(
                provider,
                "STT is disabled in the Hermes config (stt.enabled: false).",
            )

        refusal = _dispatch_refusal(tt, stt_config, provider)
        if refusal is not None:
            return _failed(provider, refusal)

        dispatch = getattr(tt, "_dispatch_stt_provider", None)
        if not callable(dispatch):
            return _failed(
                provider,
                "This Hermes build has no explicit-provider STT dispatch entry "
                "point (tools.transcription_tools._dispatch_stt_provider), so "
                "OcuClaw cannot honour the picked provider on it.",
            )

        # LAST gate before the dispatch, and the one that keeps a pick the
        # wearer's own settings screen showed as unavailable from turning into
        # a multi-minute install inside a 60 s window (§5f ruling 18).
        unavailable = _unavailable_reason(tt, stt_config, provider)
        if unavailable is not None:
            return _failed(
                provider,
                f"The Hermes STT provider {provider!r} is not available right "
                f"now: {unavailable}",
            )

        # One object, both tweak channels: the overlay Hermes resolves the
        # command/plugin lanes from, and the `pre_transcription` hook that
        # fires inside the dispatch for the built-ins. See `_SttCallTweaks`.
        tweaks = _SttCallTweaks(
            provider=provider, model=model, language=language,
            prompt=_with_default_vocabulary(tt, stt_config, provider, prompt),
        )

        # The pick crosses positionally, which is the whole point: this is the
        # argument `_transcribe_prepared_audio` fills from `_get_provider(
        # stt_config)`. Passing the phone's id instead means `stt.provider`
        # never decides — and `_get_provider`, the lazy-install seam, is never
        # called at all.
        #
        # The scope is deliberately the dispatch CALL and nothing wider: the
        # hook can only answer while Hermes is inside this one transcription.
        with _scoped_call_tweaks(tweaks):
            raw = dispatch(
                str(spill),
                provider,
                _dispatch_overlay(stt_config, tweaks),
                model,
                _TRANSCRIBE_SOURCE,
            )
        return _normalize_envelope(raw, provider)
