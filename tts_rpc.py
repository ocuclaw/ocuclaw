"""Read replies aloud: the Hermes half of the speech lane.

The Node relay asks what this Hermes speaks with, then sends one sentence-sized
piece of text at a time and gets one audio file back. Wire shape in
PROTOCOL.md "TTS lane"; the Node half is
``extensions/ocuclaw/src/runtime/tts-lane.ts``.

Rules this module holds:

- **Hermes's configured provider speaks, always.** ``tts.provider`` in
  config.yaml is the authority upstream (``_apply_call_overrides`` ignores a
  per-call provider on purpose, so speech is never rerouted to another vendor
  behind the operator's back). The listing therefore names that one provider
  and the phone offers no switch. A per-call voice is passed only where Hermes
  accepts one (built-in ElevenLabs).
- **Public surface only.** ``hermes_cli.config.load_config`` for the config and
  ``tools.registry`` (in Hermes's published plugin API) for everything else:
  ``registry.is_toolset_available("tts")`` for availability (it runs the speech
  tool's own passive check, which never installs) and
  ``registry.dispatch("text_to_speech", ...)`` to speak, the same call the agent's
  own tool use makes. No ``tools.tts_tool`` import. The tool cleans markdown,
  emoji and code out of the text itself.
- **The clip is a temp file the relay named.** Audio never rides the link line
  as base64. The path must be a direct child of a system temp directory and
  carry the ``ocuclaw-tts-`` prefix, or nothing is written. The relay reads
  and deletes the file; a failed call deletes whatever it left behind. A clip
  that finishes after the relay stopped waiting is swept once it is ten
  minutes old (``_sweep_stale_clips``).
- **No session is touched.** Nothing is sent to a chat, cached into a session
  or stored: the audio reaches the phone once, as this RPC's result.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .stt_rpc import _spill_dir_candidates

logger = logging.getLogger(__name__)

TTS_METHOD_CAPABILITIES = "gw.tts.capabilities"
TTS_METHOD_SPEAK = "gw.tts.speak"

TTS_TOOL_NAME = "text_to_speech"
TTS_TOOLSET = "tts"
TTS_SPILL_FILE_PREFIX = "ocuclaw-tts-"
# The relay's own ceiling (tts-lane.ts TTS_MAX_TEXT_CHARS), checked again here.
TTS_MAX_TEXT_CHARS = 800
DEFAULT_PROVIDER = "edge"
# The relay's clip ceiling is about a minute, so a ten minute old file is nobody's.
TTS_STALE_CLIP_AGE_S = 600.0
TTS_SWEEP_INTERVAL_S = 300.0
_last_sweep_at = 0.0

PROVIDER_LABELS: Dict[str, str] = {
    "edge": "Edge",
    "elevenlabs": "ElevenLabs",
    "openai": "OpenAI",
    "minimax": "MiniMax",
    "mistral": "Mistral",
    "gemini": "Google Gemini",
    "xai": "xAI",
    "deepinfra": "DeepInfra",
    "neutts": "NeuTTS",
    "kittentts": "KittenTTS",
    "piper": "Piper",
    "nous": "Nous Subscription",
}
# Where each built-in keeps its voice in the `tts.<provider>` config section.
_VOICE_KEYS = ("voice", "voice_id")
_DEFAULT_VOICES: Dict[str, str] = {"edge": "en-US-AriaNeural", "openai": "alloy"}


def _clean(value: Any, limit: int = 128) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _load_tts_config() -> Dict[str, Any]:
    from hermes_cli.config import load_config

    section = (load_config() or {}).get("tts") or {}
    return section if isinstance(section, dict) else {}


def _configured_provider(tts_config: Dict[str, Any]) -> str:
    return (_clean(tts_config.get("provider")) or DEFAULT_PROVIDER).lower()


def _configured_voice(tts_config: Dict[str, Any], provider: str) -> str:
    section = tts_config.get(provider)
    if isinstance(section, dict):
        for key in _VOICE_KEYS:
            voice = _clean(section.get(key))
            if voice:
                return voice
    return _DEFAULT_VOICES.get(provider, "")


def _error(code: str, message: str, provider: Optional[str] = None) -> Dict[str, Any]:
    return {
        "success": False,
        "provider": provider,
        "error": {"code": code, "message": message[:300]},
    }


def _safe_output_path(raw: Any) -> Optional[Path]:
    """The relay's path, or None unless it is `<temp dir>/ocuclaw-tts-<name>`."""
    text = _clean(raw, 1024)
    if not text or "\x00" in text:
        return None
    path = Path(text)
    if not path.is_absolute() or not path.name.startswith(TTS_SPILL_FILE_PREFIX):
        return None
    # A bare prefix would make every other clip in flight share this stem.
    if len(path.stem) <= len(TTS_SPILL_FILE_PREFIX):
        return None
    try:
        parent = path.parent.resolve(strict=False)
    except OSError:
        return None
    return path if parent in _spill_dir_candidates() else None


def _sweep_stale_clips(now: Optional[float] = None) -> List[Path]:
    """Delete speech files no live request could still own.

    The relay gives up on a clip after about a minute and deletes only the name
    it asked for. A provider that finishes later still writes its file, and
    nothing else would ever remove it. Only our prefix, only regular files (a
    planted symlink is skipped), only in the temp directories, at most once
    every few minutes, and never a reason for a clip to fail.
    """
    global _last_sweep_at
    now = time.time() if now is None else now
    if now - _last_sweep_at < TTS_SWEEP_INTERVAL_S:
        return []
    _last_sweep_at = now
    cutoff = now - TTS_STALE_CLIP_AGE_S
    swept: List[Path] = []
    for directory in _spill_dir_candidates():
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.name.startswith(TTS_SPILL_FILE_PREFIX):
                continue
            try:
                info = entry.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_mtime > cutoff:
                    continue
                entry.unlink()
            except OSError:
                continue
            swept.append(entry)
    if swept:
        logger.warning("ocuclaw tts swept %d stale speech file(s)", len(swept))
    return swept


class TtsRpc:
    """`gw.tts.*` request handlers for the control link."""

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        return {
            TTS_METHOD_CAPABILITIES: self.capabilities,
            TTS_METHOD_SPEAK: self.speak,
        }

    async def capabilities(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_capabilities, params)

    async def speak(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_speak, params)

    # -- listing -----------------------------------------------------------

    def _sync_capabilities(self, _params: Any) -> Dict[str, Any]:
        try:
            tts_config = _load_tts_config()
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Could not read the Hermes tts config: {exc}") from exc
        provider = _configured_provider(tts_config)
        try:
            from tools.registry import registry

            available = bool(registry.is_toolset_available(TTS_TOOLSET))
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Hermes speech is unavailable: {exc}") from exc
        row: Dict[str, Any] = {
            "id": provider,
            "label": PROVIDER_LABELS.get(provider, provider),
            "available": available,
            "voices": [],
        }
        voice = _configured_voice(tts_config, provider)
        if voice:
            row["voice"] = voice
        if not available:
            row["unavailableReason"] = (
                "Not set up on Hermes yet. Run `hermes tools` and choose Voice & TTS."
            )
        return {"active": provider, "providers": [row]}

    # -- speaking ----------------------------------------------------------

    def _sync_speak(self, params: Any) -> Dict[str, Any]:
        params = params if isinstance(params, dict) else {}
        try:
            _sweep_stale_clips()
        except Exception:  # noqa: BLE001
            pass
        output = _safe_output_path(params.get("outputPath"))
        if output is None:
            return _error("invalid_request", "outputPath is not a relay speech file")
        text = _clean(params.get("text"), TTS_MAX_TEXT_CHARS + 1)
        if not text:
            return _error("invalid_request", "Nothing to speak")
        if len(text) > TTS_MAX_TEXT_CHARS:
            return _error("text_too_long", f"Text is over {TTS_MAX_TEXT_CHARS} characters")

        provider: Optional[str] = None
        try:
            provider = _configured_provider(_load_tts_config())
        except Exception:  # noqa: BLE001
            provider = None
        try:
            from tools.registry import registry
        except Exception as exc:  # noqa: BLE001
            return _error("speak_failed", f"Hermes speech is unavailable: {exc}", provider)

        args: Dict[str, Any] = {"text": text, "output_path": str(output)}
        voice = _clean(params.get("voice"))
        if voice and provider == "elevenlabs":
            args["voice_id"] = voice

        keep: Optional[Path] = None
        try:
            # dispatch() never raises: a missing tool or a raising provider comes
            # back as `{"error": ...}`, which reads as a failed clip below.
            raw = registry.dispatch(TTS_TOOL_NAME, args)
            result = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(result, dict) or result.get("success") is not True:
                message = ""
                if isinstance(result, dict):
                    message = _clean(result.get("error"), 300)
                return _error("speak_failed", message or "Hermes could not speak this", provider)
            written = self._written_file(result, output)
            if written is None:
                return _error("speak_failed", "Hermes wrote no audio file", provider)
            keep = written
            return {
                "success": True,
                "provider": _clean(result.get("provider")) or provider,
                "path": str(written),
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("ocuclaw tts speak failed: %s", exc)
            return _error("speak_failed", str(exc) or "Hermes could not speak this", provider)
        finally:
            self._cleanup(output, keep)

    @staticmethod
    def _written_file(result: Dict[str, Any], output: Path) -> Optional[Path]:
        """The one file to hand back: ours by directory and stem, and non-empty.

        Hermes may change the extension (a local engine writes WAV) and returns
        the real name in ``file_path``.
        """
        names: List[Any] = [result.get("file_path")]
        paths = result.get("file_paths")
        if isinstance(paths, list):
            names.extend(paths)
        names.append(str(output))
        for name in names:
            if not isinstance(name, str) or not name:
                continue
            candidate = Path(name)
            if candidate.parent != output.parent or not candidate.name.startswith(output.stem):
                continue
            try:
                if candidate.is_file() and os.path.getsize(candidate) > 0:
                    return candidate
            except OSError:
                continue
        return None

    @staticmethod
    def _cleanup(output: Path, keep: Optional[Path]) -> None:
        stem = output.stem
        try:
            entries = list(output.parent.iterdir())
        except OSError:
            return
        for entry in entries:
            if not entry.name.startswith(stem) or entry == keep:
                continue
            try:
                if entry.is_file():
                    entry.unlink()
            except OSError:
                pass
