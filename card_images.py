"""Bounded card PNGs and image capability facts from Hermes' actual model route."""

from __future__ import annotations

import base64
import binascii
from collections import OrderedDict
import json
import threading
from typing import Any, Dict, Mapping, Optional, Tuple

from .native_readers import native_image_input

CARD_IMAGE_MAX_DECODED_BYTES = 1_572_864
CARD_IMAGE_MAX_PARTS = 6
CARD_CONTENT_MAX_PARTS = 16
PNG_DATA_URL_PREFIX = "data:image/png;base64,"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# write_glasses_card carries the new card's first Look and its pictures (#5805). So does an
# edit_glasses_card that fixes a refused write, which is that card's write (#7217), and one whose
# held Done carries the frame picture (#6415); any other edit answers in its ordinary shape.
CARD_IMAGE_TOOLS = frozenset({"look_glasses_card", "glasses_card_command", "write_glasses_card", "edit_glasses_card"})


class CardImageError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def png_bytes(encoded: Any, remaining: int = CARD_IMAGE_MAX_DECODED_BYTES) -> int:
    """Validate before decode; byte budgets count pixels' encoded PNG, not base64 chars."""
    if not isinstance(encoded, str):
        raise CardImageError("look_image_invalid", "PNG data must be base64 text")
    if len(encoded) > ((remaining + 2) // 3) * 4:
        raise CardImageError("look_image_too_large", "decoded card PNGs exceed 1.5 MiB")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CardImageError("look_image_invalid", "PNG data is not valid base64") from exc
    if len(data) > remaining:
        raise CardImageError("look_image_too_large", "decoded card PNGs exceed 1.5 MiB")
    if not data.startswith(PNG_SIGNATURE):
        raise CardImageError("look_image_invalid", "card pictures must be PNGs")
    return len(data)


def image_url_part(part: Any, remaining: int) -> Tuple[Dict[str, Any], int]:
    if (not isinstance(part, Mapping) or set(part) != {"type", "image_url"}
            or part.get("type") != "image_url"):
        raise CardImageError("look_image_invalid", "only text and PNG image_url parts are supported")
    image = part.get("image_url")
    if not isinstance(image, Mapping) or set(image) != {"url"}:
        raise CardImageError("look_image_invalid", "image_url needs only a PNG data URL")
    url = image.get("url")
    if not isinstance(url, str) or not url.startswith(PNG_DATA_URL_PREFIX):
        raise CardImageError("look_image_invalid", "only inline PNG data URLs are supported")
    size = png_bytes(url[len(PNG_DATA_URL_PREFIX):], remaining)
    return {"type": "image_url", "image_url": {"url": url}}, size


def hermes_image_model(provider: Any, model: Any) -> Dict[str, Any]:
    """Use an observed/completed route, never infer a chat or auxiliary route from defaults."""
    provider = provider.strip() if isinstance(provider, str) else ""
    model = model.strip() if isinstance(model, str) else ""
    facts = {"provider": "", "model": "", "input": ["text"]}
    if not provider or not model or len(provider) > 160 or len(model) > 160:
        return facts
    facts.update(provider=provider, model=model)
    try:
        if native_image_input(provider, model):
            facts["input"] = ["text", "image"]
    except Exception:  # Older engines and unknown capability remain text-only.
        pass
    return facts


def _remember(table: "OrderedDict[str, Tuple[Any, ...]]", key: str, value: Optional[Tuple[Any, ...]]) -> None:
    table.pop(key, None)
    if key and value is not None:
        table[key] = value
    while len(table) > 128:
        table.popitem(last=False)


class CardImageModels:
    """The public pre_api_request hook's last route, fenced to its current turn.

    A wearer's turn is fenced by its OcuClaw run. A turn Hermes starts itself
    (a delegate_task completion, a watch or process notice) has no run, so it
    is fenced by Hermes's own turn id instead: the route counts only for a card
    call whose pre_tool_call came from that same turn.
    """

    def __init__(self):
        self._routes: OrderedDict[str, Tuple[str, Any, Any]] = OrderedDict()
        self._turn_routes: OrderedDict[str, Tuple[str, Any, Any]] = OrderedDict()
        self._tool_turns: OrderedDict[str, Tuple[str]] = OrderedDict()
        self._lock = threading.Lock()

    def observe(self, session: str, run_id: str, provider: Any, model: Any) -> None:
        with self._lock:
            _remember(self._routes, session, (run_id, provider, model) if run_id else None)

    def observe_turn(self, session: str, turn_id: str, provider: Any, model: Any) -> None:
        """A model call in a turn with no OcuClaw run."""
        with self._lock:
            _remember(self._turn_routes, session, (turn_id, provider, model) if turn_id else None)

    def note_tool_turn(self, session: str, turn_id: str) -> None:
        """A tool call in a turn with no OcuClaw run."""
        with self._lock:
            _remember(self._tool_turns, session, (turn_id,) if turn_id else None)

    def forget_turn(self, session: str) -> None:
        """A new turn starts: no earlier run-less turn's route or tool call counts."""
        with self._lock:
            self._turn_routes.pop(session, None)
            self._tool_turns.pop(session, None)

    def facts(self, session: str, run_id: Optional[str]) -> Dict[str, Any]:
        with self._lock:
            route = self._routes.get(session)
            turn_route = self._turn_routes.get(session)
            tool_turn = self._tool_turns.get(session)
        if run_id:
            if route is None or route[0] != run_id:
                return hermes_image_model(None, None)
            return hermes_image_model(route[1], route[2])
        if turn_route is None or tool_turn is None or turn_route[0] != tool_turn[0]:
            return hermes_image_model(None, None)
        return hermes_image_model(turn_route[1], turn_route[2])


def _text_summary(text: str, reason: str) -> str:
    """Fallback must not retain a JSON claim that the pictures were delivered."""
    try:
        body = json.loads(text)
        if isinstance(body, dict):
            body["picturesDelivered"] = False
            body["picturesReason"] = reason
            text = json.dumps(body, ensure_ascii=False)
    except (TypeError, ValueError):
        pass
    return text + "\n\n" + reason


def card_tool_result(result: Any, *, allow_images: bool) -> Any:
    """Convert OpenClaw-shaped card content; leave all legacy result shapes untouched."""
    if not isinstance(result, Mapping) or "content" not in result:
        return None
    raw = result["content"]
    if not isinstance(raw, list) or not raw or len(raw) > CARD_CONTENT_MAX_PARTS:
        raise CardImageError("look_image_invalid", "card content must be a bounded list")
    parts, words, images, decoded = [], [], 0, 0
    for part in raw:
        if not isinstance(part, Mapping):
            raise CardImageError("look_image_invalid", "invalid card content part")
        if (part.get("type") == "text" and set(part) == {"type", "text"}
                and isinstance(part["text"], str)):
            words.append(part["text"])
            parts.append({"type": "text", "text": part["text"]})
        elif (part.get("type") == "image" and set(part) == {"type", "data", "mimeType"}
                and part.get("mimeType") == "image/png"):
            decoded += png_bytes(part.get("data"), CARD_IMAGE_MAX_DECODED_BYTES - decoded)
            images += 1
            if images > CARD_IMAGE_MAX_PARTS:
                raise CardImageError("look_image_invalid", "at most six card pictures are supported")
            parts.append({"type": "image_url", "image_url": {"url": PNG_DATA_URL_PREFIX + part["data"]}})
        else:
            raise CardImageError("look_image_invalid", "only text and PNG image parts are supported")
    text = "\n".join(words)
    if not allow_images:
        return _text_summary(text, "pictures not delivered: the active Hermes model has no confirmed image input")
    if not images:
        return text
    return {
        "_multimodal": True,
        "content": parts,
        "text_summary": _text_summary(text, "pictures not delivered: Hermes used the text fallback instead of image content"),
    }
