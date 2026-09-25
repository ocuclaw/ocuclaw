"""Silent input — Hermes-side direct prediction handlers (#2829).

The Node child forwards the five bridge methods ``input.prediction.*`` over
the bounded control link (ADR-0003) under identical names; this module
answers them from the plugin's ``ctx.llm`` — ONE direct completion per
request, never a Hermes agent turn, never a tool call, never a session.

Preference order (spec #2828 "Direct Hermes implementation"):
  1. ``ctx.llm.acomplete_structured`` with ``json_mode=True`` (provider-native
     JSON where the host supports it) — reported as ``structuredOutput: true``;
  2. ``ctx.llm.acomplete`` + local validation.
A host without an async API → ``unavailable`` with zero completions. The sync
``complete`` path was removed (#2836 review r2 S1): its worker thread cannot see
a cancel, so after the deadline Hermes's sync ``call_llm`` would keep retrying
and walk the fallback chain, paid providers included. Every supported Hermes
(the adapter's 0.21 gate) has ``acomplete``. Trust-gate refusals
(``PluginLlmTrustError`` is a ``PermissionError``) → ``policy-denied``. A host
that will not call the chosen model at all (no key or no provider for it, an
unknown model) → ``unavailable`` with the fixed reason ``model-unreachable``
(#3359): a retry never helps, picking another model does.

Cancellation is its own RPC, and it only suppresses the result. Hermes cannot
prove the provider stopped: PluginLlm runs several providers (Codex,
Anthropic, Bedrock) on a worker thread behind ``asyncio.to_thread``, so a
cancelled await returns at once while the HTTP call keeps running and billing.
``abort`` is therefore always ``False`` (#2836 review B1). A deadline, a client
cancel or a closing link answers at once and cancels the local await as a best
effort. On the async path that stops Hermes's retry and fallback chain: every
retry/fallback branch catches ``Exception``, and ``CancelledError`` is a
``BaseException``. The concurrency slot stays taken while the call may still be
running: until the task ends, and for a cancelled task until
``2 × timeout + INPUT_PREDICTION_PROVIDER_TIMEOUT_GRACE_S`` after the call
started. ``timeout`` is what was left of the request deadline; Hermes gives each
retry or fallback attempt that full value again, so an attempt started just
before the cancel can run one more timeout past the deadline (review r2 S2).
``max_concurrent`` therefore bounds live provider calls, not open handlers.
httpx timeouts are per phase (connect, read), not a total, so
``INPUT_PREDICTION_LINGER_CEILING_S`` is the only hard bound: it frees any slot
whose call has not ended by then.

Cost: the plugin cannot ask Hermes for free-only fallbacks. PluginLlm has no
fallback or provider-policy kwarg, and ``auxiliary.free_only`` is a top-level
Hermes setting in the profile's config. What bounds a surprise fallback call is
(a) the local cancel above, and (b) the phone refusing any result whose route
it never tested, which turns predictions off, so the cost is limited to the
requests already in flight.

Per-profile (#2836): every call resolves the request's ``profileId`` to a
namespace this gateway serves, reads THAT profile's trust policy and route,
and runs the completion inside the profile's runtime scope. ``profileId`` is
never forwarded to ``ctx.llm`` (``profile=`` there is an auth-profile override).

Nothing here logs draft text. Handlers return typed statuses; they never raise
into the link.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import importlib
import inspect
import json
import logging
import math
import re
import time
import unicodedata
import uuid
import zlib
from typing import Any, Callable, ContextManager, Dict, List, Optional, Tuple

INPUT_PREDICTION_PROTOCOL_VERSION = 1
INPUT_PREDICTION_PURPOSE = "silent-input-prediction"
INPUT_PREDICTION_AUXILIARY_TASK = "silent_input_prediction"

INPUT_PREDICTION_CAPABILITIES_METHOD = "input.prediction.capabilities"
INPUT_PREDICTION_REQUEST_METHOD = "input.prediction.request"
INPUT_PREDICTION_CANCEL_METHOD = "input.prediction.cancel"
INPUT_PREDICTION_TEST_METHOD = "input.prediction.test"
# The one call at editor open (#3125) — whole replies + reply words for the
# message being answered. Same lane, same backend, same cancel plumbing as a
# per-word request; a different prompt, a bigger budget and a strict object
# parser (Node twin: silent-input-open-reply.ts).
INPUT_PREDICTION_OPEN_METHOD = "input.prediction.open"
# #3359 round 3: add ONE model this profile already routes to onto the
# plugin's own PluginLlm override allowlist (``plugins.entries.ocuclaw.llm``).
# Accepted only for an id ``models`` lists with ``allowed: False``.
INPUT_PREDICTION_MODEL_ALLOW_METHOD = "input.prediction.model.allow"
# The most entries a ``models`` list carries, the connection default
# included. Node twin: INPUT_PREDICTION_MODEL_LIST_CAP.
INPUT_PREDICTION_MODEL_LIST_CAP = 20
_LOGGER = logging.getLogger(__name__)
_MODEL_ALLOW_STATUSES = ("saved", "policy-denied", "error")
_MODEL_ALLOW_MODES = ("none", "hot_reload", "restart", "manual")

# Why a per-word request is refused (#3126). This host does not write next
# words any more: a phone only sends per-word requests to a host that RANKS
# with TypeSafe, and the ranking happens on the phone. The method stays
# registered so an older phone gets a typed answer instead of
# method-not-found, and this is the whole answer — no prompt, no completion,
# no concurrency slot.
#
# Mirrors the Node side's INPUT_PREDICTION_PER_WORD_RETIRED_REASON
# (`extensions/ocuclaw/src/runtime/input-prediction-shared.ts`, aliased as
# PER_WORD_RETIRED_REASON in the service) byte for byte. An older phone may
# show this string; the two must not drift.
INPUT_PREDICTION_PER_WORD_RETIRED_REASON = (
    "this host does not write next words; suggestions come from the phone"
)

INPUT_PREDICTION_LIMITS: Dict[str, int] = {
    "maxContextChars": 512,
    "maxPatternLength": 31,
    "maxCandidates": 20,
    "maxVisible": 8,
    "debounceMs": 250,
    "minIntervalMs": 1000,
    "timeoutMs": 5000,
}

# Bumped whenever the open-call prompt text below changes. The cache it keys
# is the Node service's (Hermes itself caches nothing), so on this side the
# constant is the parity anchor: the cross-language test reads
# SILENT_INPUT_OPEN_PROMPT_VERSION out of silent-input-open-reply.ts and
# refuses a prompt change on either side that does not bump BOTH.
SILENT_INPUT_OPEN_PROMPT_VERSION = "sio-3"

# Byte-for-byte the Node adapter's SILENT_INPUT_OPEN_LIMITS. A divergence in
# any of these would make the two hosts answer differently.
SILENT_INPUT_OPEN_LIMITS: Dict[str, int] = {
    # Whole replies asked for and carried on the wire. The glasses row shows
    # THREE; the extra two are spares, so that when the phone's hidden-word
    # filter throws one away the next valid reply is promoted instead of the
    # wearer being offered two picks (#3125 review round 2, S-3: the promotion
    # was dead while every producer also capped at three).
    "maxReplies": 5,
    # A whole reply longer than this is not a glance, it is a paragraph.
    "maxReplyChars": 60,
    # Reply words bought no time-to-word improvement. Spend the budget on replies.
    "promptWords": 0,
    # Words asked for; a couple more than 40 survive the cap.
    "maxWords": 48,
    # The message being answered. Same bound as the Jev context (#3124).
    "maxReplyingToChars": 512,
    # Six-second host budget; the smaller ask replaces the old eight-second one.
    "timeoutMs": 6000,
    # Configurable ceiling, identical to silent-input-open-reply.ts.
    "maxTimeoutMs": 10000,
    # Five short replies (two filtering spares), with reasoning headroom.
    "maxTokens": 256,
}

# How much the readiness Test asks for (#3190). SAME route, SAME provider,
# SAME model resolution and SAME prompt family as the real editor-open call —
# only the SIZE of the ask is smaller.
#
# After #3126 the Test ran the whole editor-open job: five replies, forty words,
# 512 tokens. The real open call is the same size, but nothing waits on it; the
# Test has a wearer watching a spinner, and predictions cannot be armed until one
# passes. In the #3126 sim re-check it timed out 5 times in 10 at its 8500 ms
# deadline. Latency is dominated by output tokens, so the Test asks for two
# replies, no words and about a fifth of the budget.
#
# Byte-for-byte the Node adapter's SILENT_INPUT_OPEN_TEST_LIMITS.
SILENT_INPUT_OPEN_TEST_LIMITS: Dict[str, int] = {
    # Two is enough to show what this model writes; five is the real call's
    # spare count, and the spares exist for the phone's hidden-word filter.
    "maxReplies": 2,
    # No reply words at all: the Test never opens an editor.
    "promptWords": 0,
    # Two short replies are about 20 visible tokens; 96 leaves a reasoning model
    # room to think and still refuses an essay.
    "maxTokens": 96,
}

INPUT_PREDICTION_STATUSES = (
    "ready",
    "unavailable",
    "busy",
    "timeout",
    "invalid-output",
    "policy-denied",
    "cancelled",
    "error",
)

# Same fixed, NON-personal example as the Node adapter (never the draft).
INPUT_PREDICTION_TEST_EXAMPLE: Dict[str, Any] = {
    "contextSuffix": "Let's meet at the",
    "pattern": "1",
    "spellingMode": "predictive",
    "ways": 2,
    "locale": "en",
    "maxCandidates": 8,
}

# #3126: the fixed, NON-personal message the readiness Test answers now that the
# per-word model calls are retired. A Test has to exercise the route the feature
# really uses, and the only call this backend still answers is the whole replies
# written when the editor opens. Byte-for-byte the Node adapter's
# SILENT_INPUT_OPEN_TEST_EXAMPLE; a divergence would make the two lanes prove
# different things under the same button.
SILENT_INPUT_OPEN_TEST_EXAMPLE: Dict[str, Any] = {
    "replyingTo": "Are you free for lunch tomorrow?",
    "locale": "en",
}

# Bridge-level forbidden fields (mirror of input-prediction-shared.ts).
# #2836: the routing-authority keys PluginLlm understands (`profile` = auth
# profile override, `task` = auxiliary slot, `agent_id`, `auxiliary`) are
# refused too, so a request can never steer host routing.
INPUT_PREDICTION_FORBIDDEN_KEYS = frozenset(
    {
        "url", "baseurl", "apibase", "endpoint", "apikey", "api_key", "token",
        "authorization", "credentials", "headers", "prompt", "systemprompt",
        "system", "messages", "instructions", "provider", "model",
        "temperature", "maxtokens", "profile", "task", "auxiliary", "agent_id",
    }
)

# #2836 review S1: a provider call that has not ended this long after it was
# admitted gives its concurrency slot back (a host that drops ``timeout=``
# must not wedge the lane). Well past the longest deadline (Test: 8 s).
INPUT_PREDICTION_LINGER_CEILING_S = 30.0
# After a call is cancelled locally, a provider thread may still run until the
# ``timeout=`` it was given; its slot stays taken this long past that timeout.
INPUT_PREDICTION_PROVIDER_TIMEOUT_GRACE_S = 1.0

# Kwargs an older PluginLlm may not declare; dropped from its signature up
# front, never by retrying on error text.
_OPTIONAL_LLM_KWARGS = ("task", "timeout", "temperature")

_LETTER_RE = re.compile(r"^[A-Za-z]{1,31}$")
# #3162: ASCII plus the documented historical simulator's precomposed Latin-1 letters. The split ranges
# exclude multiplication/division signs; U+00B5 is outside them and is a known
# missing firmware glyph. Kept in lockstep with the Node and phone twins.
_WHOLE_REPLY_RE = re.compile(r"[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF0-9 ,.'!?:-]+")
_ANY_REPLY_LETTER_RE = re.compile(r"[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]")
_ASCII_SPACE_RUN_RE = re.compile(r" +")
_MODEL_CHOICE_RE = re.compile(r"^[A-Za-z0-9._:@/-]{1,128}$")
# Same grammar as the Node service's REQUEST_ID_RE.
_REQUEST_ID_RE = _MODEL_CHOICE_RE
# BCP-47-ish, exactly the Node normalizers' /^[a-z]{2}(-[A-Za-z]{2})?$/. Always
# applied with `fullmatch`: `$` also matches before a trailing newline.
_LOCALE_RE = re.compile(r"[a-z]{2}(-[A-Za-z]{2})?")


# ---------------------------------------------------------------------------
# Shared vocabulary (kept byte-for-byte aligned with the Node module)
# ---------------------------------------------------------------------------


def letter_group(ch: str, ways: int) -> int:
    if not ch:
        return -1
    code = ord(ch[0].lower())
    if not (97 <= code <= 122):
        return -1
    index = code - 97
    if ways == 3:
        if index <= 8:
            return 0
        if index <= 17:
            return 1
        return 2
    return 0 if index <= 12 else 1


def normalize_ways(raw: Any) -> int:
    try:
        return 3 if int(raw) == 3 else 2
    except (TypeError, ValueError):
        return 2


def is_pattern_digits(pattern: str, ways: int) -> bool:
    max_digit = "2" if ways == 3 else "1"
    return all("0" <= ch <= max_digit for ch in pattern)


def pattern_compatible(word: str, pattern: str, ways: int) -> bool:
    if len(pattern) > len(word):
        return False
    for i, digit in enumerate(pattern):
        if letter_group(word[i], ways) != int(digit):
            return False
    return True


# #3279: candidate-text schemas, mirroring INPUT_PREDICTION_CANDIDATE_SCHEMAS in
# input-prediction-shared.ts. ``alpha-v1`` is today's letters-only contract and what a
# request naming no schema is held to; ``local-apostrophe-v1`` also admits an ASCII
# apostrophe between two letters (``we'll``), matched on its letters alone.
CANDIDATE_SCHEMA_ALPHA = "alpha-v1"
CANDIDATE_SCHEMA_APOSTROPHE = "local-apostrophe-v1"
CANDIDATE_SCHEMAS = (CANDIDATE_SCHEMA_ALPHA, CANDIDATE_SCHEMA_APOSTROPHE)
_APOSTROPHE_CANDIDATE_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*")


def normalize_candidate_schema(params: Any) -> Tuple[bool, str, bool]:
    """``(ok, schema, named)``: absent is ``alpha-v1`` and not named; anything else must be known."""
    if not isinstance(params, dict) or params.get("candidateSchema") is None:
        return True, CANDIDATE_SCHEMA_ALPHA, False
    raw = params.get("candidateSchema")
    if not isinstance(raw, str) or raw not in CANDIDATE_SCHEMAS:
        return False, "", True
    return True, raw, True


def is_candidate_under_schema(text: Any, schema: str) -> bool:
    if not isinstance(text, str) or not (1 <= len(text) <= 31):
        return False
    if schema == CANDIDATE_SCHEMA_ALPHA:
        return _LETTER_RE.fullmatch(text) is not None
    if schema == CANDIDATE_SCHEMA_APOSTROPHE:
        return _APOSTROPHE_CANDIDATE_RE.fullmatch(text) is not None
    return False


def candidate_match_key(text: str) -> str:
    return text.lower().replace("'", "")


def normalize_candidate_word(raw: Any, schema: str = CANDIDATE_SCHEMA_ALPHA) -> Optional[Tuple[str, str]]:
    if not isinstance(raw, str):
        return None
    display = raw.strip()
    if not is_candidate_under_schema(display, schema):
        return None
    return display, display.lower()


def validate_candidates(
    items: Any,
    *,
    pattern: str,
    ways: int,
    max_candidates: int,
    hidden_keys: Optional[List[str]] = None,
    candidate_schema: str = CANDIDATE_SCHEMA_ALPHA,
) -> Dict[str, Any]:
    hidden = {str(k).lower() for k in (hidden_keys or [])}
    seen: set = set()
    out: List[str] = []
    rejected = 0
    source = items if isinstance(items, list) else []
    for raw in source:
        word = normalize_candidate_word(raw, candidate_schema)
        if word is None:
            rejected += 1
            continue
        display, key = word
        if key in seen or key in hidden or not pattern_compatible(candidate_match_key(display), pattern, ways):
            rejected += 1
            continue
        seen.add(key)
        out.append(display)
        if len(out) >= max_candidates:
            break
    return {"candidates": out, "rejected": rejected, "received": len(source)}


def _clamp_int(raw: Any, lo: int, hi: int, fallback: int) -> int:
    try:
        n = int(float(raw))
    except (TypeError, ValueError):
        return fallback
    return max(lo, min(hi, n))


def find_forbidden_key(params: Any) -> Optional[str]:
    if not isinstance(params, dict):
        return None
    for key in params.keys():
        if str(key).lower() in INPUT_PREDICTION_FORBIDDEN_KEYS:
            return str(key)
    return None


def prediction_result(status: str, **extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "status": status if status in INPUT_PREDICTION_STATUSES else "error",
        "candidates": [],
        "provider": "",
        "model": "",
        "elapsedMs": 0,
        "usage": None,
    }
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


# ---------------------------------------------------------------------------
# The one call at editor open (#3125) — whole replies + reply words
# ---------------------------------------------------------------------------
#
# Every other prediction here is per word and races the wearer's thumb. This
# one does not: it fires once, when the silent editor opens on a message being
# answered, and asks the SAME completion backend for three short whole replies
# and about forty likely reply words in one answer.
#
# THREE RULES (identical to the Node twin):
#   * the parse is strict and bounded — prose, a hundred words, emoji or an
#     essay per reply is junk that gets dropped, not junk that reaches the glass;
#   * nothing here logs the message being answered, the replies or the words;
#   * the wearer's personal dictionary and hidden words are NOT in this shape.
#     Hidden words are filtered on the phone, where the hidden set lives.


# The three pieces of the prompt that depend on how big the ask is (#3190):
# the key count, the words clause and the example answer. Byte-for-byte the
# Node twin's OPEN_ASK_* / SMALL_ASK_* constants.
OPEN_ASK_KEYS = "exactly two keys"
SMALL_ASK_KEYS = "exactly one key"
OPEN_ASK_WORDS_CLAUSE = (
    '"words": at most {n} distinct lower-case {english}words, letters only, that are likely to '
    "appear in their reply, most likely first. Single words, never phrases.\n"
)
OPEN_ASK_EXAMPLE = (
    '{"replies":["On my way","Give me ten minutes","Sorry, not today"],'
    '"words":["yes","sure","sorry","later","tomorrow","meeting"]}'
)
SMALL_ASK_EXAMPLE = '{"replies":["On my way","Give me ten minutes"]}'


def _ask_shape(ask: Any) -> Tuple[int, int]:
    """(maxReplies, promptWords) out of whichever limit object was passed."""
    a = ask if isinstance(ask, dict) else SILENT_INPUT_OPEN_LIMITS
    max_replies = a.get("maxReplies")
    prompt_words = a.get("promptWords")
    if not isinstance(max_replies, int) or isinstance(max_replies, bool):
        max_replies = SILENT_INPUT_OPEN_LIMITS["maxReplies"]
    if not isinstance(prompt_words, int) or isinstance(prompt_words, bool):
        prompt_words = SILENT_INPUT_OPEN_LIMITS["promptWords"]
    return max_replies, prompt_words


def build_open_reply_messages(req: Dict[str, Any], ask: Any = None) -> Tuple[str, str]:
    """Returns (system, user) — byte-for-byte Node's buildOpenReplyMessages.

    Both adapters send exactly this text: a divergence would make the two
    hosts answer differently and nothing else would catch it. ``ensure_ascii``
    is off because ``JSON.stringify`` does not escape non-ASCII either.

    ``ask`` is SILENT_INPUT_OPEN_LIMITS for the real editor-open call and
    SILENT_INPUT_OPEN_TEST_LIMITS for the readiness Test (#3190). ONE builder,
    one prompt family, two sizes. The full ask's text is byte-for-byte what it
    was before #3190, so the prompt version does not move.
    """
    locale_raw = req.get("locale") if isinstance(req, dict) else None
    locale = locale_raw if isinstance(locale_raw, str) and locale_raw else "en"
    english = "English " if locale == "en" else ""
    max_replies, prompt_words = _ask_shape(ask if ask is not None else SILENT_INPUT_OPEN_LIMITS)
    keys = OPEN_ASK_KEYS if prompt_words > 0 else SMALL_ASK_KEYS
    words_clause = (
        OPEN_ASK_WORDS_CLAUSE.replace("{n}", str(prompt_words)).replace("{english}", english)
        if prompt_words > 0
        else ""
    )
    example = OPEN_ASK_EXAMPLE if prompt_words > 0 else SMALL_ASK_EXAMPLE
    system = (
        "Someone wearing smart glasses is about to answer a short chat message. Typing is slow "
        "for them: every word costs several gestures. Reply with ONLY a JSON object with "
        f"{keys}.\n"
        f'"replies": at most {max_replies} different short whole {english}replies they might send, '
        "most likely first. Each is one plain sentence of at most eight words, no emoji, no "
        "markdown, no names they have not been given.\n"
        f"{words_clause}"
        "No explanation, no other keys. Example answer: "
        f"{example}"
    )
    replying_to_raw = req.get("replyingTo") if isinstance(req, dict) else None
    replying_to = replying_to_raw if isinstance(replying_to_raw, str) else ""
    user = (
        f"The message they are answering: {json.dumps(replying_to, ensure_ascii=False)}\n"
        "JSON object:"
    )
    return system, user


def parse_object_text(text: Any) -> Optional[Dict[str, Any]]:
    """The JSON object out of model output, tolerating fences and prose."""
    if not isinstance(text, str):
        return None
    trimmed = text.strip()
    if not trimmed:
        return None
    attempts = [trimmed]
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", trimmed, re.IGNORECASE)
    if fenced and fenced.group(1):
        attempts.append(fenced.group(1).strip())
    first = trimmed.find("{")
    last = trimmed.rfind("}")
    if first != -1 and last > first:
        attempts.append(trimmed[first : last + 1])
    for attempt in attempts:
        try:
            parsed = json.loads(attempt)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def normalize_whole_reply(raw: Any) -> Optional[str]:
    """One whole reply, or None.

    Refuses raw controls/format characters before NFC, collapses ASCII spaces,
    bounds the length, and accepts only the documented Latin-1 reply alphabet.
    """
    if not isinstance(raw, str):
        return None
    if any(unicodedata.category(ch) in ("Cc", "Cf") for ch in raw):
        return None
    collapsed = _ASCII_SPACE_RUN_RE.sub(" ", unicodedata.normalize("NFC", raw)).strip(" ")
    if not collapsed or len(collapsed) > SILENT_INPUT_OPEN_LIMITS["maxReplyChars"]:
        return None
    if not _WHOLE_REPLY_RE.fullmatch(collapsed):
        return None
    if not _ANY_REPLY_LETTER_RE.search(collapsed):
        return None
    return collapsed


def parse_open_reply_object(parsed: Any, ask: Any = None) -> Optional[Dict[str, Any]]:
    """``{replies, words, rejected*, received*}`` from an already-decoded
    object, or None when it is not object-shaped at all (the caller reports
    ``invalid-output``, never retries).

    Everything is capped here. A model that returns 500 words returns 48 of
    them; one that returns a valid reply and four essays returns the one.
    Duplicates go by lower-case key, so "Yes" and "yes" are offered once.

    ``ask`` caps the REPLIES at whatever this call asked for (#3190), so a Test
    that asked for two and was sent four still reports two. Words keep the full
    cap either way.
    """
    if not isinstance(parsed, dict):
        return None
    max_replies, _prompt_words = _ask_shape(ask if ask is not None else SILENT_INPUT_OPEN_LIMITS)
    replies: List[str] = []
    seen_replies: set = set()
    rejected_replies = 0
    raw_replies = parsed.get("replies") if isinstance(parsed.get("replies"), list) else []
    for raw in raw_replies:
        reply = normalize_whole_reply(raw)
        if reply is None:
            rejected_replies += 1
            continue
        key = reply.lower()
        if key in seen_replies:
            rejected_replies += 1
            continue
        seen_replies.add(key)
        replies.append(reply)
        if len(replies) >= max_replies:
            break
    words: List[str] = []
    seen_words: set = set()
    rejected_words = 0
    raw_words = parsed.get("words") if isinstance(parsed.get("words"), list) else []
    for raw in raw_words:
        word = normalize_candidate_word(raw)
        if word is None:
            rejected_words += 1
            continue
        display, key = word
        if key in seen_words:
            rejected_words += 1
            continue
        seen_words.add(key)
        words.append(display)
        if len(words) >= SILENT_INPUT_OPEN_LIMITS["maxWords"]:
            break
    return {
        "replies": replies,
        "words": words,
        "rejectedReplies": rejected_replies,
        "rejectedWords": rejected_words,
        "receivedReplies": len(raw_replies),
        "receivedWords": len(raw_words),
    }


def parse_open_reply_text(text: Any, ask: Any = None) -> Optional[Dict[str, Any]]:
    """Model output text → the parsed open answer, or None."""
    return parse_open_reply_object(parse_object_text(text), ask)


def _coerce_open_parsed(parsed: Any, ask: Any = None) -> Optional[Dict[str, Any]]:
    """A structured-output host hands back a decoded object; a plain one hands
    back text. Both land in the same strict parser.

    An object that yields NOTHING is None, not an
    empty answer. ``parse_open_reply_object`` accepts any dict, so returning it
    unconditionally short-circuited the ``result.text`` fallback — a host that
    fills ``parsed`` with its own envelope and the real JSON in ``text`` lost
    the answer. One wrapper level is unwrapped too."""
    if isinstance(parsed, dict):
        direct = parse_open_reply_object(parsed, ask)
        if direct and (direct["replies"] or direct["words"]):
            return direct
        for value in parsed.values():
            if not isinstance(value, dict):
                continue
            inner = parse_open_reply_object(value, ask)
            if inner and (inner["replies"] or inner["words"]):
                return inner
        return None
    if isinstance(parsed, str):
        return parse_open_reply_text(parsed, ask)
    return None


def normalize_open_request(params: Any) -> Dict[str, Any]:
    """{ok:True, value} or {ok:False, status, reason} — mirrors Node's
    normalizeOpenRequest.

    The open request has no pattern, no ways and no draft. It retains its own
    shape after removal of the retired per-word normalizer.

    ``replyingTo`` is the only content field, and it is NOT the wearer's words:
    it is the message the OTHER party sent, the one being answered. That is why
    the phone sends it only after the host advertised ``openReply``, and why it
    never carries a draft.
    """
    if not isinstance(params, dict):
        return {"ok": False, "status": "error", "reason": "invalid-request: params must be an object"}
    forbidden = find_forbidden_key(params)
    if forbidden:
        return {"ok": False, "status": "policy-denied", "reason": f"forbidden field: {forbidden}"}
    replying_to = params.get("replyingTo") if isinstance(params.get("replyingTo"), str) else ""
    if len(replying_to) > SILENT_INPUT_OPEN_LIMITS["maxReplyingToChars"]:
        return {
            "ok": False,
            "status": "error",
            "reason": f"invalid-request: replyingTo exceeds {SILENT_INPUT_OPEN_LIMITS['maxReplyingToChars']}",
        }
    if not replying_to.strip():
        # Nothing to answer is not an error the wearer should ever see, but it
        # is also not a call worth spending: the phone does not make it, and a
        # host that is asked anyway says so.
        return {"ok": False, "status": "error", "reason": "invalid-request: replyingTo is empty"}
    locale_raw = params.get("locale")
    locale = locale_raw if isinstance(locale_raw, str) and _LOCALE_RE.fullmatch(locale_raw) else "en"
    model_choice_raw = params.get("modelChoice")
    model_choice = model_choice_raw.strip() if isinstance(model_choice_raw, str) and model_choice_raw.strip() else "default"
    if not _MODEL_CHOICE_RE.match(model_choice):
        return {"ok": False, "status": "policy-denied", "reason": "modelChoice is not a known choice id"}
    return {
        "ok": True,
        "value": {
            "requestId": _echo_request_id(params),
            "clientId": params.get("clientId") if isinstance(params.get("clientId"), str) else "",
            "connectionId": params.get("connectionId") if isinstance(params.get("connectionId"), str) else "",
            "agentId": params.get("agentId").strip() if isinstance(params.get("agentId"), str) else "",
            "profileId": params.get("profileId").strip() if isinstance(params.get("profileId"), str) else "",
            "purpose": INPUT_PREDICTION_PURPOSE,
            "replyingTo": replying_to,
            "locale": locale,
            "modelChoice": model_choice,
            "timeoutMs": _clamp_int(
                params.get("timeoutMs"),
                200,
                SILENT_INPUT_OPEN_LIMITS["maxTimeoutMs"],
                SILENT_INPUT_OPEN_LIMITS["timeoutMs"],
            ),
        },
    }


def open_reply_result(status: str, **extra: Any) -> Dict[str, Any]:
    """Uniform open-result shape — every open path returns this."""
    out: Dict[str, Any] = {
        "status": status if status in INPUT_PREDICTION_STATUSES else "error",
        "replies": [],
        "words": [],
        "provider": "",
        "model": "",
        "elapsedMs": 0,
        "usage": None,
    }
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


# There is no open-call telemetry projection here on purpose. Hermes emits no
# prediction debug events: this lane answers an RPC and the Node service
# (`openReplyTelemetry` in silent-input-open-reply.ts) projects the result it
# gets back. A second copy on this side was never called by anything.


def normalize_usage(raw: Any) -> Optional[Dict[str, Optional[int]]]:
    """PluginLlmUsage defaults every field to 0 — an all-zero object is
    indistinguishable from "provider returned nothing", so it reads unknown."""
    if raw is None:
        return None
    src = raw if isinstance(raw, dict) else getattr(raw, "__dict__", None) or {}
    def pick(*names: str) -> Optional[int]:
        for n in names:
            v = src.get(n) if isinstance(src, dict) else getattr(raw, n, None)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return int(v)
        return None
    inp = pick("input_tokens", "inputTokens", "prompt_tokens")
    out = pick("output_tokens", "outputTokens", "completion_tokens")
    if (inp or 0) == 0 and (out or 0) == 0:
        return None
    return {"inputTokens": inp, "outputTokens": out}


def policy_revision_of(policy: Dict[str, Any]) -> str:
    text = json.dumps(policy or {}, sort_keys=True)
    return "p%08x" % (zlib.crc32(text.encode("utf-8")) & 0xFFFFFFFF)


def _route_field(raw: Any) -> str:
    """A configured provider/model value; ``auto`` is Hermes's inherit
    sentinel (auxiliary_client._resolve_task_provider_model), not a value."""
    if not isinstance(raw, str):
        return ""
    text = raw.strip()
    return "" if text.lower() == "auto" else text


def effective_prediction_route(config: Any, *, task_registered: bool = True) -> Dict[str, str]:
    """The route a prediction completion takes, from one profile's raw config.

    ``auxiliary.silent_input_prediction.{provider,model}`` wins when either is
    set (and not ``auto``) AND the host accepted the plugin task (otherwise no
    ``task=`` is sent and the slot never applies); an unset half inherits the
    main route the way Hermes does (provider ``auto`` → main provider; a pinned
    provider without a model → that provider's default, reported empty).
    Otherwise ``model.provider`` + ``model.default``/``model.model``;
    ``model`` may also be a bare model string.
    """
    cfg = config if isinstance(config, dict) else {}
    model_cfg = cfg.get("model")
    if isinstance(model_cfg, str):
        main_provider, main_model = "", _route_field(model_cfg)
    elif isinstance(model_cfg, dict):
        main_provider = _route_field(model_cfg.get("provider"))
        main_model = _route_field(model_cfg.get("default")) or _route_field(model_cfg.get("model"))
    else:
        main_provider, main_model = "", ""
    if task_registered:
        aux = cfg.get("auxiliary")
        task_cfg = aux.get(INPUT_PREDICTION_AUXILIARY_TASK) if isinstance(aux, dict) else None
        if isinstance(task_cfg, dict):
            aux_provider = _route_field(task_cfg.get("provider"))
            aux_model = _route_field(task_cfg.get("model"))
            if aux_provider or aux_model:
                return {
                    "provider": aux_provider or main_provider,
                    "model": aux_model or ("" if aux_provider else main_model),
                    "source": "auxiliary",
                }
    return {"provider": main_provider, "model": main_model, "source": "main"}


def prediction_policy_revision(
    policy: Dict[str, Any], route: Dict[str, str], *, task_registered: bool, profile_ns: str
) -> str:
    """Changes whenever the trust policy, the effective route, the task slot
    or the profile changes — a client caching capabilities re-reads."""
    return policy_revision_of(
        {
            "policy": policy or {},
            "effectiveRoute": dict(route or {}),
            "taskRegistered": bool(task_registered),
            "profile": profile_ns or "",
        }
    )


def _route_entries(raw: Any) -> List[Dict[str, Any]]:
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list):
        return [entry for entry in raw if isinstance(entry, dict)]
    return []


def configured_reply_models(config: Any) -> List[Dict[str, str]]:
    """#3359 round 3: the models this profile's config ALREADY routes to that
    a plugin model override can reach, read from config.yaml and nothing else
    (no ``models_dev`` catalog, no network call, no paid probe).

    PluginLlm applies ``model=`` to the MAIN provider (a provider switch is a
    separate trust flag this plugin never uses), so only models on the main
    provider count: the main model, the fallback chain
    (``fallback_providers`` then legacy ``fallback_model``) and the auxiliary
    task slots, each kept when its provider is the main one, unset or
    ``auto``. Returns ``[{"id", "provider"}]`` in that order, deduplicated
    case-insensitively (PluginLlm compares its allowlist lowercased)."""
    cfg = config if isinstance(config, dict) else {}
    route = effective_prediction_route(cfg, task_registered=False)
    main_provider = route.get("provider", "")
    out: List[Dict[str, str]] = []
    seen: set = set()

    def add(provider: Any, model: Any) -> None:
        mid = _route_field(model)
        prov = _route_field(provider)
        if not mid or not _MODEL_CHOICE_RE.fullmatch(mid):
            return
        if prov and main_provider and prov.lower() != main_provider.lower():
            return
        if mid.lower() in seen:
            return
        seen.add(mid.lower())
        out.append({"id": mid, "provider": main_provider or prov})

    add(main_provider, route.get("model"))
    for key in ("fallback_providers", "fallback_model"):
        for entry in _route_entries(cfg.get(key)):
            add(entry.get("provider"), entry.get("model") or entry.get("default"))
    aux = cfg.get("auxiliary")
    if isinstance(aux, dict):
        for slot in aux.values():
            if isinstance(slot, dict):
                add(slot.get("provider"), slot.get("model"))
    return out


# #3411: the Fast badge rule, mirrored from extensions/ocuclaw/src/runtime/input-prediction-shared.ts
# (``REPLY_MODEL_FAST_OUTPUT_COST_MAX`` / ``replyModelSpeedFacts``). A priced model is Fast at or
# under this output price (USD per 1M tokens). The catalogs' ``reasoning`` flag is not used: nearly
# every current model is marked reasoning-capable, so it cannot tell small from large.
REPLY_MODEL_FAST_OUTPUT_COST_MAX = 6.0
# ``-fast`` in an OpenAI or Anthropic id is a PRICIER priority tier (``claude-opus-5-fast``).
_PRIORITY_TIER_RE = re.compile(r"-fast(?=$|[-_.:@/])", re.IGNORECASE)
_TOKEN_PRICE_RE = re.compile(r"^\$?\s*([0-9]+(?:\.[0-9]+)?)")


def reply_model_speed_facts(model_id: Any, cost_out: Any = None, recommended: bool = False) -> Dict[str, Any]:
    """The optional ``fast`` / ``costOutPerM`` keys for one ``models`` entry. ``fast`` is present
    only when the host can say: False for a ``-fast`` priority id, True when a recommendation names
    the model, else from a known non-zero price. No price and no recommendation: no key at all, and
    the phone falls back to its name hint. A price of 0 (local or free) says nothing about speed."""
    out: Dict[str, Any] = {}
    mid = model_id if isinstance(model_id, str) else ""
    cost: Optional[float] = None
    if isinstance(cost_out, (int, float)) and not isinstance(cost_out, bool) and math.isfinite(cost_out) and cost_out >= 0:
        cost = float(cost_out)
        out["costOutPerM"] = round(cost, 3)
    if _PRIORITY_TIER_RE.search(mid):
        out["fast"] = False
    elif recommended:
        out["fast"] = True
    elif cost is not None and cost > 0:
        out["fast"] = cost <= REPLY_MODEL_FAST_OUTPUT_COST_MAX
    return out


def _parse_token_price(raw: Any) -> Optional[float]:
    """Nous Portal ``tokenPrice`` ("$0.40/1M") → 0.4; None when absent or unreadable."""
    if not isinstance(raw, str):
        return None
    match = _TOKEN_PRICE_RE.match(raw.strip())
    return float(match.group(1)) if match else None


def _nous_recommendation_facts() -> Tuple[Dict[str, float], set, Optional[bool]]:
    """(prices by lowercased id, recommended ids, free tier) from the Nous Portal recommendations
    Hermes already cached on disk, never a network call: ``hermes_cli.models`` reads the cache the
    model picker writes. The recommended pick is the tier's compaction (small auxiliary) model:
    free tier → the free pick only; paid → the paid pick, else the free one (Hermes's own rule in
    ``get_nous_recommended_aux_model``). Free tier comes from Hermes's in-process cache only."""
    prices: Dict[str, float] = {}
    recommended: set = set()
    free_tier: Optional[bool] = None
    try:
        hermes_models = importlib.import_module("hermes_cli.models")
    except Exception:  # noqa: BLE001 - an older or absent Hermes: no Nous facts
        return prices, recommended, free_tier
    try:
        free_tier = hermes_models.get_cached_nous_free_tier()
    except Exception:  # noqa: BLE001
        free_tier = None
    payload: Dict[str, Any] = {}
    try:
        base = hermes_models._resolve_nous_portal_url()
        disk = hermes_models._read_nous_recommended_disk(base)
        # Hermes 0.21.x returns the payload dict; newer trees return (payload, age).
        if isinstance(disk, dict):
            payload = disk
        elif isinstance(disk, tuple) and disk and isinstance(disk[0], dict):
            payload = disk[0]
    except Exception:  # noqa: BLE001
        payload = {}

    def note(entry: Any) -> Optional[str]:
        name = entry.get("modelName") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not name.strip():
            return None
        price = _parse_token_price(entry.get("tokenPrice"))
        if price is not None:
            prices.setdefault(name.strip().lower(), price)
        return name.strip()

    for key in ("freeRecommendedModels", "paidRecommendedModels"):
        entries = payload.get(key)
        if isinstance(entries, list):
            for entry in entries:
                note(entry)
    for tier in (("free",) if free_tier else ("paid", "free")):
        pick = note(payload.get(f"{tier}RecommendedCompactionModel"))
        if pick:
            recommended.add(pick.lower())
            break
    return prices, recommended, free_tier


def hermes_reply_model_facts(provider: str, model_ids: List[str]) -> Dict[str, Any]:
    """#3411: what this Hermes knows about the listed models, WITHOUT a paid call or a catalog fetch.
    Runs inside the profile scope (credentials are per profile).

    ``usable``: ``hermes_cli.models_detect.provider_has_credentials`` (the model switcher's own
    check: env/.env key, auth-store login, credential pool). None when this Hermes lacks it.
    ``unavailable``: on a KNOWN free-tier Nous account, ids the recommendations price above zero.
    ``speed``: lowercased id → ``reply_model_speed_facts`` from Nous ``tokenPrice``, else the
    models.dev catalog Hermes ships (``get_model_info(allow_network=False)``, output cost per 1M)."""
    prov = (provider or "").strip()
    facts: Dict[str, Any] = {"usable": None, "unavailable": set(), "speed": {}}
    if prov:
        try:
            detect = importlib.import_module("hermes_cli.models_detect")
            facts["usable"] = bool(detect.provider_has_credentials(prov))
        except Exception:  # noqa: BLE001 - unknown keeps the list unfiltered
            facts["usable"] = None
    nous_prices: Dict[str, float] = {}
    nous_recommended: set = set()
    if prov.lower() == "nous":
        nous_prices, nous_recommended, free_tier = _nous_recommendation_facts()
        if free_tier is True:
            facts["unavailable"] = {mid.lower() for mid in model_ids if (nous_prices.get(mid.lower()) or 0) > 0}
    try:
        get_model_info = importlib.import_module("agent.models_dev").get_model_info
    except Exception:  # noqa: BLE001
        get_model_info = None
    for mid in model_ids:
        key = mid.lower()
        if not mid or key in facts["speed"]:
            continue
        cost = nous_prices.get(key)
        if cost is None and get_model_info is not None and prov:
            try:
                info = get_model_info(prov, mid, allow_network=False)
                out_cost = float(getattr(info, "cost_output", 0) or 0) if info is not None else 0.0
                cost = out_cost if out_cost > 0 else None
            except Exception:  # noqa: BLE001
                cost = None
        facts["speed"][key] = reply_model_speed_facts(mid, cost, key in nous_recommended)
    return facts


def build_reply_models(
    policy: Dict[str, Any], config: Any, route: Dict[str, str], *, list_choices: bool = True,
    facts: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """The ``models`` list (#3359 round 3). The connection default stays first,
    labelled with the route it really answers as; then the allowlist, then
    every other configured model, each with ``allowed`` (PluginLlm would take
    it now) and ``current`` (only the connection default). The chat model is
    not listed twice unless the allowlist names it. Capped at
    INPUT_PREDICTION_MODEL_LIST_CAP."""
    provider, model = route.get("provider", ""), route.get("model", "")
    chat_label = f"{provider}/{model}" if provider and model else (model or "Chat model")
    f = facts if isinstance(facts, dict) else {}
    speed = f.get("speed") if isinstance(f.get("speed"), dict) else {}
    unavailable = f.get("unavailable") if isinstance(f.get("unavailable"), (set, frozenset, list)) else ()
    models: List[Dict[str, Any]] = [{
        "id": "default", "label": chat_label, "provider": "", "model": "",
        "isDefault": True, "allowed": True, "current": True,
        # #3411: the chat model is priced too (the phone sorts Fast first); it always stays listed.
        **(speed.get(model.lower(), {}) if model else {}),
    }]
    if not list_choices:
        return models
    # #3411: the main provider has no usable credentials → no choice can run; only the chat
    # model entry stays (its Check says why). None (unknown) keeps the list.
    if f.get("usable") is False:
        return models
    configured = configured_reply_models(config)
    configured_ids = {entry["id"].lower() for entry in configured}
    providers = {entry["id"].lower(): entry["provider"] for entry in configured}
    allow_list = [m.lower() for m in policy.get("allowedModels", [])]
    seen = {"default"}

    def allowed(ref: str) -> bool:
        if not policy.get("allowModelOverride"):
            return False
        if ref.lower() in allow_list:
            return True
        return bool(policy.get("anyModel")) and ref.lower() in configured_ids

    def push(ref: str, by_policy: bool) -> None:
        if len(models) >= INPUT_PREDICTION_MODEL_LIST_CAP:
            return
        if not ref or ref == "*" or ref.lower() in seen or not _MODEL_CHOICE_RE.fullmatch(ref):
            return
        if model and ref.lower() == model.lower() and not by_policy:
            return
        if ref.lower() in unavailable:
            return
        seen.add(ref.lower())
        prov = providers.get(ref.lower())
        if prov is None:
            prov, _, mid = ref.partition("/") if "/" in ref else ("", "", ref)
        else:
            mid = ref
        models.append({"id": ref, "label": ref, "provider": prov, "model": mid,
                       "isDefault": False, "allowed": allowed(ref), "current": False,
                       **speed.get(ref.lower(), {})})

    if policy.get("allowModelOverride"):
        for ref in policy.get("allowedModels", []):
            push(ref, True)
    for entry in configured:
        push(entry["id"], False)
    return models


def model_allow_result(request_id: Any, status: Any, activation: Any = None) -> Dict[str, Any]:
    """The one reply shape for ``input.prediction.model.allow`` (Node twin:
    ``modelAllowResult``)."""
    s = status if status in _MODEL_ALLOW_STATUSES else "error"
    a = activation if isinstance(activation, dict) else {}
    mode = a.get("mode") if a.get("mode") in _MODEL_ALLOW_MODES else ("manual" if s == "saved" else "none")
    return {
        "requestId": request_id if isinstance(request_id, str) and _REQUEST_ID_RE.fullmatch(request_id) else "",
        "status": s,
        "activation": {
            "required": (a.get("required") is not False) if s == "saved" else False,
            "mode": mode if s == "saved" else "none",
        },
    }


def _echo_request_id(params: Any) -> str:
    """The requestId a request may carry back: well-formed ids only.

    Every path uses this one gate. The success path used to keep any string of
    up to 128 characters while the rejection path dropped it, so a control
    character or markup the phone would never send was refused on an error and
    echoed on a ready answer."""
    raw = params.get("requestId") if isinstance(params, dict) else None
    return raw if isinstance(raw, str) and _REQUEST_ID_RE.fullmatch(raw) else ""


def _supported_kwargs(fn: Any, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Drop the optional kwargs ``fn`` does not declare. A host whose
    signature cannot be read, or that takes ``**kwargs``, gets them all."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return dict(kwargs)
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(kwargs)
    return {k: v for k, v in kwargs.items() if k in params or k not in _OPTIONAL_LLM_KWARGS}


# Only the provider refusing the structured-output request itself (the
# openai-codex proxy: "404 unsupported endpoint" to ``response_format``).
# "model not supported" and other errors never turn structured output off.
_STRUCTURED_REJECTION = re.compile(r"response_format|unsupported endpoint", re.I)


def _is_structured_rejection(exc: BaseException) -> bool:
    return bool(_STRUCTURED_REJECTION.search(str(exc) or ""))


# #3359: the fixed reason for "the host cannot call this model for replies"
# (Node: ``OPEN_REPLY_MODEL_UNREACHABLE_REASON``).
OPEN_REPLY_MODEL_UNREACHABLE_REASON = "model-unreachable"

# Each class is a refusal that a retry never fixes. Hermes's own wording comes
# from ``agent/auxiliary_client.py`` (``async_call_llm``, which PluginLlm's
# ``acomplete``/``acomplete_structured`` call): "Provider 'x' is set in
# config.yaml but no API key was found" and "No LLM provider configured for
# task=... provider=...", both raised before any request is sent, and
# "Malformed custom endpoint URL" from its base-URL check. The model-name
# phrases are the ones Hermes's own ``_is_model_not_found_error`` treats as
# "this model does not exist on this route". "Plugin LLM completion failed:"
# and "agent runtime" are OpenClaw's, kept so the two classifiers stay twins.
_UNREACHABLE_CLASSES: Tuple[Tuple[str, "re.Pattern[str]"], ...] = (
    ("runtime-only", re.compile(r"agent runtime", re.I)),
    ("unknown-model", re.compile(
        r"\bunknown model\b|no such model|model[ _]not[ _]found|is not a valid model"
        r"|model does not exist|the model `[^`]{0,120}` does not exist",
        re.I,
    )),
    ("no-model", re.compile(r"\bno model\b", re.I)),
    ("auth", re.compile(r"\b(?:no|missing) api key\b|no credentials", re.I)),
    ("provider", re.compile(r"no llm provider configured|not configured|malformed custom endpoint url", re.I)),
    ("host-refused", re.compile(r"^\s*Plugin LLM completion failed:", re.I)),
)
_MODEL_UNREACHABLE = re.compile("|".join(f"(?:{p.pattern})" for _, p in _UNREACHABLE_CLASSES), re.I)


def open_reply_failure_class(exc: BaseException) -> str:
    """A short class for a host log line, never a word of the error's own text
    (Node: ``openReplyFailureClass``). What went wrong, not what was asked."""
    message = str(exc) or exc.__class__.__name__
    if isinstance(exc, asyncio.CancelledError):
        return "aborted"
    if isinstance(exc, PermissionError):
        return "policy"
    for name, pattern in _UNREACHABLE_CLASSES:
        if pattern.search(message):
            return name
    if re.search(r"denied|not allowed|not permitted|override|permission|allowed_?models|trust", message, re.IGNORECASE):
        return "policy"
    if re.search(r"timed out|timeout", message, re.IGNORECASE):
        return "timeout"
    return "other"


def _log_completion_failure(request_id: str, status: str, exc: BaseException) -> None:
    """One host-side line per failed completion: the request id, the status
    and a fixed failure class. Never the error's text, which can echo the
    message being answered."""
    _LOGGER.info(
        "[ocuclaw] input prediction %s failed: %s (%s)",
        request_id, status, open_reply_failure_class(exc),
    )


def classify_open_reply_error(exc: BaseException) -> Tuple[str, str]:
    """The open call's own classifier: a status and a FIXED reason code, never
    a word of the provider's own text (Node: ``classifyOpenReplyError``).

    Providers routinely echo the request body back in an error, and this
    request body holds the whole message being answered, so an upstream 400
    could carry that message into a result the phone stores and into a debug
    event that claims to hold counts only. The reason code below is all the
    phone ever needs: every failure is silent to the wearer anyway (#3125)."""
    message = str(exc) or exc.__class__.__name__
    if isinstance(exc, asyncio.CancelledError):
        # The twin of Node's AbortError/ABORT_ERR branch, and the same code.
        # On this lane a cancel normally arrives as an OUTCOME instead
        # (`_complete_once` returns "cancelled"), and a ``CancelledError``
        # raised into the handler itself is a ``BaseException`` that walks
        # straight past ``_run``'s ``except Exception``. This branch is what
        # keeps the two lanes on ONE reason vocabulary anyway: any caller that
        # does hand this classifier a cancellation gets "cancelled"/"aborted"
        # rather than a cancel reported to the phone as "upstream-error".
        return "cancelled", "aborted"
    if isinstance(exc, PermissionError):
        return "policy-denied", "policy-denied"
    # #3359: the host will not call this model for replies at all. A retry
    # never helps; picking another model does. Checked before the policy words
    # because the host's own hint text is free prose.
    if _MODEL_UNREACHABLE.search(message):
        return "unavailable", OPEN_REPLY_MODEL_UNREACHABLE_REASON
    # ``allowed_?models`` covers BOTH spellings: Hermes's own config key is
    # snake_case (`allowed_models`), while the Node twin's message text and
    # regex are camelCase (`allowedModels`). Matching one only would let a
    # trust refusal from the other host's wording fall through to "error".
    if re.search(r"denied|not allowed|not permitted|override|permission|allowed_?models|trust", message, re.IGNORECASE):
        return "policy-denied", "policy-denied"
    if re.search(r"unavailable|not configured|no model|missing api key|no api key|not found", message, re.IGNORECASE):
        return "unavailable", "unavailable"
    if re.search(r"timed out|timeout", message, re.IGNORECASE):
        return "timeout", "timeout"
    return "error", "upstream-error"


# ---------------------------------------------------------------------------
# RPC handlers
# ---------------------------------------------------------------------------


def _default_resolve_profile(profile_id: str) -> Tuple[str, Any, Optional[str]]:
    return (profile_id or "", None, None)


def _default_profile_scope(_ns: str, _home: Any) -> ContextManager[Any]:
    return contextlib.nullcontext()


class InputPredictionRpc:
    """Child-initiated ``input.prediction.*`` RPC lane."""

    def __init__(
        self,
        get_llm: Callable[[], Any],
        *,
        hermes_version: Callable[[], str] | str = "",
        task_registered: Callable[[], bool] = lambda: False,
        get_policy: Callable[[], Dict[str, Any]] = lambda: {},
        get_route_config: Optional[Callable[[], Dict[str, Any]]] = None,
        resolve_profile: Callable[[str], Tuple[str, Any, Optional[str]]] = _default_resolve_profile,
        profile_scope: Callable[[str, Any], ContextManager[Any]] = _default_profile_scope,
        allow_model: Optional[Callable[[str, str, Any], Dict[str, Any]]] = None,
        model_facts: Optional[Callable[[str, List[str]], Dict[str, Any]]] = None,
        model_facts_timeout_s: float = 3.0,
        max_concurrent: int = 4,
        clock: Callable[[], float] = time.monotonic,
        linger_ceiling_s: float = INPUT_PREDICTION_LINGER_CEILING_S,
        provider_timeout_grace_s: float = INPUT_PREDICTION_PROVIDER_TIMEOUT_GRACE_S,
    ) -> None:
        self._get_llm = get_llm
        self._hermes_version = hermes_version
        self._task_registered = task_registered
        # Both config readers are called INSIDE the profile scope on a worker
        # thread, so a home-override-aware reader answers for that profile.
        self._get_policy = get_policy
        self._get_route_config = get_route_config
        # profileId (Hermes profile name) → (namespace, home, route error).
        self._resolve_profile = resolve_profile
        # (namespace, home) → context manager scoping config + credentials.
        self._profile_scope = profile_scope
        # #3359 round 3: (modelId, namespace, home) → {status, activation}. The
        # config writer is the adapter's (it owns the Hermes home); absent means
        # this host cannot allow a model and every allow answers ``error``.
        self._allow_model = allow_model
        # #3411: (main provider, model ids) → {usable, unavailable, speed}, run inside the
        # profile scope on a worker thread. None = no facts (the list stays as configured).
        self._model_facts = model_facts
        self._model_facts_timeout_s = max(0.0, float(model_facts_timeout_s))
        self._max_concurrent = max(1, int(max_concurrent))
        self._clock = clock
        self._linger_ceiling_s = max(0.0, float(linger_ceiling_s))
        self._provider_grace_s = max(0.0, float(provider_timeout_grace_s))
        # (clientId, requestId) → entry; two clients may reuse a request id.
        self._active: Dict[Tuple[str, str], Dict[str, Any]] = {}
        # Entries holding a concurrency slot. A slot is freed when its call
        # ENDS, not when the handler answers (see ``_inflight``).
        self._slots: list = []
        # namespace → {provider, model} of that profile's last completion.
        self._last_resolved: Dict[str, Dict[str, str]] = {}
        # namespace → why structured output is off for THAT profile. Set once
        # its provider rejects ``response_format`` (the openai-codex proxy
        # answers "404 unsupported endpoint"); that profile then uses
        # ``acomplete`` + local parsing and reports ``structuredOutput: false``.
        # Other profiles keep structured output (#2836 review S3).
        self._structured_disabled: Dict[str, str] = {}

    # -- registration -------------------------------------------------------

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        return {
            INPUT_PREDICTION_CAPABILITIES_METHOD: self.handle_capabilities,
            INPUT_PREDICTION_REQUEST_METHOD: self.handle_request,
            INPUT_PREDICTION_OPEN_METHOD: self.handle_open,
            INPUT_PREDICTION_CANCEL_METHOD: self.handle_cancel,
            INPUT_PREDICTION_TEST_METHOD: self.handle_test,
            INPUT_PREDICTION_MODEL_ALLOW_METHOD: self.handle_model_allow,
        }

    # -- helpers ------------------------------------------------------------

    def _llm_api(self, llm: Any, ns: str = "") -> str:
        if llm is None:
            return ""
        if callable(getattr(llm, "acomplete_structured", None)) and not (
            self._structured_disabled.get(ns) and callable(getattr(llm, "acomplete", None))
        ):
            return "acomplete_structured"
        if callable(getattr(llm, "acomplete", None)):
            return "acomplete"
        # A sync-only ``complete`` host is not supported (module docstring).
        return ""

    @staticmethod
    def _no_api_reason(llm: Any) -> str:
        if llm is None:
            return "Hermes plugin LLM unavailable (ctx.llm missing)"
        return (
            "Hermes plugin LLM has no async completion API (acomplete); a sync-only host is not supported "
            "because its worker thread cannot be cancelled"
        )

    def _policy(self) -> Dict[str, Any]:
        try:
            raw = self._get_policy() or {}
        except Exception:  # noqa: BLE001
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        allowed = raw.get("allowed_models") if isinstance(raw.get("allowed_models"), list) else []
        override = bool(raw.get("allow_model_override", False))
        models = [m.strip() for m in allowed if isinstance(m, str) and m.strip()]
        return {
            "allowModelOverride": override,
            "allowedModels": models,
            # #3359 round 3: PluginLlm's own reading — no list (or "*") with
            # the override on means ANY model. Honoured only for models this
            # profile already routes to (``build_reply_models``/``_authorize``).
            "anyModel": override and (not isinstance(raw.get("allowed_models"), list) or "*" in models),
        }

    def _route_config(self) -> Dict[str, Any]:
        if self._get_route_config is None:
            return {}
        try:
            raw = self._get_route_config() or {}
        except Exception:  # noqa: BLE001
            raw = {}
        return raw if isinstance(raw, dict) else {}

    def _task_flag(self) -> bool:
        try:
            return bool(self._task_registered())
        except Exception:  # noqa: BLE001
            return False

    def _version(self) -> str:
        try:
            return self._hermes_version() if callable(self._hermes_version) else str(self._hermes_version or "")
        except Exception:  # noqa: BLE001
            return ""

    def _resolve(self, profile_id: Any) -> Tuple[str, Any, Optional[str]]:
        name = profile_id.strip() if isinstance(profile_id, str) else ""
        try:
            ns, home, error = self._resolve_profile(name)
        except Exception as exc:  # noqa: BLE001 - a routing failure is unavailable, never a crash
            return name, None, f"Hermes profile {name!r} could not be resolved: {str(exc)[:160]}"
        return str(ns or ""), home, (str(error) if error else None)

    async def _read_profile_state(
        self, ns: str, home: Any, *, want_route: bool
    ) -> Tuple[Dict[str, Any], Dict[str, Any], contextvars.Context]:
        """Enter the profile scope on a worker thread (the real scope hydrates
        secret sources — file/network I/O that must stay off the loop), read
        that profile's policy (+ route config), and snapshot the scoped
        context so the completion runs under it too."""

        def _read() -> Tuple[Dict[str, Any], Dict[str, Any], contextvars.Context]:
            with self._profile_scope(ns, home):
                policy = self._policy()
                route_cfg = self._route_config() if want_route else {}
                scoped = contextvars.copy_context()
            return policy, route_cfg, scoped

        return await asyncio.to_thread(_read)

    async def _read_model_facts(
        self, ns: str, home: Any, policy: Dict[str, Any], route_cfg: Dict[str, Any], route: Dict[str, str]
    ) -> Optional[Dict[str, Any]]:
        """#3411: credential + price facts for this profile's list, inside its scope on a worker
        thread (the credential check reads that profile's secrets). Bounded: a slow or failing
        check reads as no facts, which keeps the list as configured."""
        if self._model_facts is None:
            return None
        main_provider = effective_prediction_route(route_cfg, task_registered=False).get("provider", "")
        ids: List[str] = []
        for mid in [route.get("model", "")] + [e["id"] for e in configured_reply_models(route_cfg)] + list(
                policy.get("allowedModels", []) if policy.get("allowModelOverride") else []):
            if isinstance(mid, str) and mid and mid != "*" and mid not in ids:
                ids.append(mid)

        def _read() -> Any:
            with self._profile_scope(ns, home):
                return self._model_facts(main_provider, ids)

        try:
            out = await asyncio.wait_for(asyncio.to_thread(_read), timeout=self._model_facts_timeout_s)
        except Exception:  # noqa: BLE001 - includes the timeout
            return None
        return out if isinstance(out, dict) else None

    def _authorize(
        self, model_choice: str, policy: Dict[str, Any], route_cfg: Any = None
    ) -> Tuple[bool, Optional[str], str]:
        if not model_choice or model_choice == "default":
            return True, None, ""
        # Same test as the list's ``allowed`` (PluginLlm compares lowercased).
        listed = policy.get("allowModelOverride") and (
            model_choice.lower() in [m.lower() for m in policy.get("allowedModels", [])]
            or (policy.get("anyModel") and model_choice.lower() in {
                entry["id"].lower() for entry in configured_reply_models(route_cfg or {})}))
        if not listed:
            return False, None, f"model choice not authorized by host policy: {model_choice}"
        return True, model_choice, ""

    # -- abort + concurrency slots -----------------------------------------

    @staticmethod
    def _abort_verdict(api: str) -> Tuple[bool, str]:
        """Hermes never proves an upstream abort (#2836 review B1): a fast
        cancelled await is not evidence, because thread-backed providers keep
        running. ``abortProbe`` names what a cancel does here: ``result-only``
        (the result is suppressed and the local await cancelled; a provider
        thread may still run to its own timeout). Only async APIs are used."""
        return False, "result-only"

    @property
    def _inflight(self) -> int:
        """Slots held by calls that may still be running. Evaluated lazily
        from the task state and the clock, so no timer can leak a slot."""
        now = self._clock()
        self._slots = [entry for entry in self._slots if self._slot_live(entry, now)]
        return len(self._slots)

    def _slot_live(self, entry: Dict[str, Any], now: float) -> bool:
        if not entry.get("answered"):
            return True  # the handler is still running
        task = entry.get("task")
        if task is None:
            return False  # answered before any provider call started
        if self._linger_ceiling_s > 0 and now - entry.get("admittedAt", now) >= self._linger_ceiling_s:
            if not task.done():
                try:
                    task.cancel()  # best effort; the slot is freed regardless
                except RuntimeError:
                    pass  # its loop is gone
            return False
        if not task.done():
            return True
        if task.cancelled():
            # Cancelled locally: a thread-backed provider call may still be
            # running until the provider timeout it was given.
            return now < entry.get("callEndsBy", 0.0)
        return False  # the call finished (value or error): it has ended

    # -- capabilities -------------------------------------------------------

    async def handle_capabilities(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        llm = self._get_llm()
        ns, home, route_error = self._resolve(p.get("profileId"))
        api = self._llm_api(llm, ns)
        task_registered = self._task_flag()
        policy: Dict[str, Any] = {"allowModelOverride": False, "allowedModels": []}
        route_cfg: Dict[str, Any] = {}
        if not route_error:
            try:
                policy, route_cfg, _scoped = await self._read_profile_state(ns, home, want_route=True)
            except Exception as exc:  # noqa: BLE001
                route_error = f"Hermes profile runtime scope unavailable: {str(exc)[:160]}"
        route = effective_prediction_route(route_cfg, task_registered=task_registered)
        supported = bool(api) and not route_error
        # #3359 round 3: default (labelled with its real route) + the allowlist
        # + every model this profile already routes to, each with allowed/current.
        facts = await self._read_model_facts(ns, home, policy, route_cfg, route) if supported else None
        models = build_reply_models(policy, route_cfg, route, list_choices=supported, facts=facts)
        abort, probe = self._abort_verdict(api)
        last = self._last_resolved.get(ns)
        # The open call rides the same ctx.llm, the same profile scope and the
        # same auxiliary task slot as a per-word prediction, so its route IS
        # the effective route.
        #
        # COMPLETE or null, never a half. Both consumers of this field
        # (`normalizeOpenReplyRoute` in the Hermes bridge, `normalizeRoute` in
        # the service) return null unless provider AND model are non-empty, and
        # a null route makes the phone drop every open answer in silence. A
        # profile that pins only a model — which `effectiveRoute` reports as a
        # provider-less half, quite legitimately — would have turned the whole
        # feature off with nothing anywhere to say why. So a half route falls
        # through to the last completion this profile actually resolved, which
        # names both or nothing. Halves are never mixed between the two.
        open_reply_route: Optional[Dict[str, str]] = None
        if supported:
            for source in (route, last):
                if not source:
                    continue
                provider, model = source.get("provider", ""), source.get("model", "")
                if provider and model:
                    open_reply_route = {"provider": provider, "model": model}
                    break
        out: Dict[str, Any] = {
            "protocolVersion": INPUT_PREDICTION_PROTOCOL_VERSION,
            "supported": supported,
            # The editor-open call (#3125) rides the same ctx.llm as every
            # other prediction here, so it is available exactly when
            # predictions are. A host that cannot complete says false and the
            # phone never sends the message being answered.
            "openReply": supported,
            # The completion route that open call will answer as, so
            # the phone can admit an open result without disturbing the route
            # it tested per word. Null when this host cannot name one (no
            # completion API, an unserved profile, or a connection default
            # nothing has resolved yet) — the field is advisory, never a gate.
            "openReplyRoute": open_reply_route,
            "structuredOutput": supported and api == "acomplete_structured",
            "structuredOutputNote": self._structured_disabled.get(ns, ""),
            # Always false on Hermes: nothing proves the provider call stopped.
            "abort": abort,
            "abortProbe": probe,
            "policyRevision": prediction_policy_revision(policy, route, task_registered=task_registered, profile_ns=ns),
            "limits": dict(INPUT_PREDICTION_LIMITS),
            "models": models,
            "connectionDefault": dict(last) if last else None,
            "effectiveRoute": route,
            "hermesVersion": self._version(),
            "llmApi": api,
            "auxiliaryTask": INPUT_PREDICTION_AUXILIARY_TASK if task_registered else "",
        }
        if not api:
            out["unsupportedReason"] = self._no_api_reason(llm)
        elif route_error:
            out["unsupportedReason"] = f"unavailable: {route_error}"
        return out

    # -- request (retired per-word route, #3126) -----------------------------

    async def handle_request(self, params: Any) -> Dict[str, Any]:
        """Retired: this host no longer writes next words.

        The method stays REGISTERED on purpose. An older phone that still asks
        must get a typed ``unavailable`` it can act on, not a
        method-not-found it would report as a broken link.

        The answer is fixed and free. Nothing is normalized, no prompt is
        built, no completion is issued and no concurrency slot is taken, so a
        phone that keeps asking per word costs this host nothing and never
        takes a lane from the editor-open call that shares the pool.
        """
        return prediction_result(
            "unavailable",
            requestId=_echo_request_id(params),
            reason=INPUT_PREDICTION_PER_WORD_RETIRED_REASON,
        )

    # -- open (editor-open call, #3125) -------------------------------------

    async def handle_open(self, params: Any) -> Dict[str, Any]:
        """The one call at editor open. Same backend, same cancel, same
        concurrency slots as a per-word request; a different prompt, a bigger
        budget and a strict object parser.

        A parse that yields nothing usable is ``invalid-output``, never a retry
        and never a partial guess: the phone shows no error row for any of it,
        so a wrong answer would be invisible rather than harmless."""
        normalized = normalize_open_request(params)
        if not normalized["ok"]:
            return open_reply_result(normalized["status"], requestId=_echo_request_id(params), reason=normalized["reason"])
        return await self._run(normalized["value"], self._open_spec())

    # -- whole replies and their smaller readiness Test ---------------------

    def _open_spec(self, ask: Any = None) -> Dict[str, Any]:
        # #3190: ``ask`` is the SIZE of the ask and nothing else — same prompt
        # family, same route, same provider and model resolution. The readiness
        # Test passes SILENT_INPUT_OPEN_TEST_LIMITS; everything else gets the
        # real call's own limits.
        ask = ask if ask is not None else SILENT_INPUT_OPEN_LIMITS
        return {
            "prompt": lambda req: build_open_reply_messages(req, ask),
            "maxTokens": ask["maxTokens"],
            "result": open_reply_result,
            "schemaName": "silent_input_open_reply",
            "read": lambda result, base, req: self._read_open_output(result, base, req, ask),
            # Never the provider's text: it can hold the message answered.
            "classify": classify_open_reply_error,
        }

    async def _run(self, req: Dict[str, Any], spec: Dict[str, Any]) -> Dict[str, Any]:
        make = spec["result"]
        classify = spec["classify"]
        request_id = req["requestId"] or f"hp-{uuid.uuid4().hex[:12]}"
        llm = self._get_llm()
        ns, home, route_error = self._resolve(req.get("profileId"))
        api = self._llm_api(llm, ns)
        if not api:
            return make("unavailable", requestId=request_id, reason=self._no_api_reason(llm))
        if route_error:
            return make("unavailable", requestId=request_id, reason=route_error)
        if self._inflight >= self._max_concurrent:
            return make("busy", requestId=request_id, reason="hermes prediction concurrency exhausted")

        key = (req["clientId"], request_id)
        entry: Dict[str, Any] = {
            "clientId": req["clientId"],
            "cancelled": False,
            "task": None,
            "api": api,
            "cancelEvent": asyncio.Event(),
            "answered": False,
            "admittedAt": self._clock(),
        }
        self._active[key] = entry
        self._slots.append(entry)
        started = self._clock()
        timeout_s = req["timeoutMs"] / 1000.0
        try:
            try:
                policy, route_cfg, scoped = await self._read_profile_state(ns, home, want_route=True)
            except Exception as exc:  # noqa: BLE001
                return make("unavailable", requestId=request_id, reason=f"Hermes profile runtime scope unavailable: {str(exc)[:160]}")
            if entry["cancelled"]:
                return make("cancelled", requestId=request_id, elapsedMs=self._elapsed(started), reason="cancelled by client")
            ok, model, why = self._authorize(req["modelChoice"], policy, route_cfg)
            if not ok:
                return make("policy-denied", requestId=request_id, reason=why)

            system, user = spec["prompt"](req)
            # Never provider/agent_id/profile: host routing stays host-owned.
            kwargs: Dict[str, Any] = {
                "purpose": INPUT_PREDICTION_PURPOSE,
                "max_tokens": spec["maxTokens"],
                "temperature": 0,
                "timeout": timeout_s,
            }
            if model:
                kwargs["model"] = model
            if self._task_flag():
                kwargs["task"] = INPUT_PREDICTION_AUXILIARY_TASK

            remaining = max(0.05, timeout_s - (self._clock() - started))
            try:
                outcome, result = await self._complete_once(entry, scoped, llm, api, system, user, kwargs, remaining, spec["schemaName"])
            except Exception as exc:  # noqa: BLE001
                status, reason = classify(exc)
                if not (
                    api == "acomplete_structured"
                    and status not in ("policy-denied", "cancelled", "timeout")
                    and _is_structured_rejection(exc)
                    and callable(getattr(llm, "acomplete", None))
                ):
                    _log_completion_failure(request_id, status, exc)
                    return make(status, requestId=request_id, elapsedMs=self._elapsed(started), reason=reason)
                # Provider rejected response_format before any inference ran
                # (no model call was billed). Downgrade THIS profile for good,
                # and finish this request on the plain path within the deadline.
                self._structured_disabled[ns] = f"provider rejected structured output: {reason[:160]}"
                remaining = max(0.05, timeout_s - (self._clock() - started))
                try:
                    outcome, result = await self._complete_once(entry, scoped, llm, "acomplete", system, user, kwargs, remaining, spec["schemaName"])
                except Exception as exc2:  # noqa: BLE001
                    status2, reason2 = classify(exc2)
                    _log_completion_failure(request_id, status2, exc2)
                    return make(status2, requestId=request_id, elapsedMs=self._elapsed(started), reason=reason2)
            elapsed = self._elapsed(started)
            if outcome == "timeout":
                return make("timeout", requestId=request_id, elapsedMs=elapsed, reason=f"no completion within {req['timeoutMs']} ms")
            if outcome == "cancelled" or entry["cancelled"]:
                reason = "cancelled by client" if outcome == "cancelled" else "cancelled before result"
                return make("cancelled", requestId=request_id, elapsedMs=elapsed, reason=reason)
            provider = str(getattr(result, "provider", "") or "")
            model_used = str(getattr(result, "model", "") or "")
            if provider or model_used:
                self._last_resolved[ns] = {"provider": provider, "model": model_used}
            base: Dict[str, Any] = {
                "requestId": request_id,
                "provider": provider,
                "model": model_used,
                "elapsedMs": elapsed,
                "usage": normalize_usage(getattr(result, "usage", None)),
            }
            return spec["read"](result, base, req)
        finally:
            if self._active.get(key) is entry:
                self._active.pop(key, None)
            # Answering the client never frees the slot while the call may
            # still run; ``_inflight`` decides that from the task and clock.
            entry["answered"] = True

    # -- reading one completion's output ------------------------------------

    def _read_open_output(self, result: Any, base: Dict[str, Any], _req: Dict[str, Any], ask: Any = None) -> Dict[str, Any]:
        """Editor-open path: a JSON object of whole replies + reply words.

        Nothing usable after filtering is ``invalid-output``, never a partial
        guess; the counts in the reason are counts only, never the content."""
        decoded = getattr(result, "parsed", None)
        parsed = _coerce_open_parsed(decoded, ask)
        if parsed is None:
            parsed = parse_open_reply_text(getattr(result, "text", ""), ask)
        if parsed is None and isinstance(decoded, dict):
            # A decoded object that survived neither filter: the text fallback
            # had nothing either, so report the object's own counts rather than
            # claim the host answered with something that was not an object.
            parsed = parse_open_reply_object(decoded, ask)
        if parsed is None:
            return open_reply_result("invalid-output", reason="output is not a JSON object", **base)
        if not parsed["replies"] and not parsed["words"]:
            return open_reply_result(
                "invalid-output",
                reason=(
                    f"nothing usable (replies {parsed['receivedReplies']}/{parsed['rejectedReplies']} rejected, "
                    f"words {parsed['receivedWords']}/{parsed['rejectedWords']} rejected)"
                ),
                **base,
            )
        return open_reply_result(
            "ready",
            replies=parsed["replies"],
            words=parsed["words"],
            rejectedReplies=parsed["rejectedReplies"],
            rejectedWords=parsed["rejectedWords"],
            **base,
        )

    async def _complete_once(
        self,
        entry: Dict[str, Any],
        scoped: contextvars.Context,
        llm: Any,
        api: str,
        system: str,
        user: str,
        kwargs: Dict[str, Any],
        timeout_s: float,
        schema_name: str = "silent_input_words",
    ) -> Tuple[str, Any]:
        """Run ONE completion task under the profile's scoped context.

        Returns ``("done", result)``, ``("timeout", None)`` or
        ``("cancelled", None)``; a completion error propagates. The deadline,
        a client cancel and a closing link all answer at once and cancel the
        local await as a best effort: that stops Hermes's async retry/fallback
        chain, but not a thread-backed provider call, which runs until the
        ``timeout=`` it was given — so the slot is held until then (``_inflight``)."""
        call_kwargs = dict(kwargs)
        if "timeout" in call_kwargs:
            # The provider's own timeout never outlives this attempt's deadline.
            call_kwargs["timeout"] = timeout_s
        # Task() copies the CURRENT context, so creating it inside
        # scoped.run() gives the completion the profile's home/secret scope.
        task = scoped.run(asyncio.ensure_future, self._call(llm, api, system, user, call_kwargs, schema_name))
        task.add_done_callback(_consume_task_result)
        entry["task"] = task
        entry["api"] = api
        # Hermes gives each retry/fallback attempt the full timeout again, so an
        # attempt started just before the cancel may run one more timeout past
        # the deadline (review r2 S2). The linger ceiling still caps this.
        entry["callEndsBy"] = self._clock() + 2 * timeout_s + self._provider_grace_s
        waiter = asyncio.ensure_future(entry["cancelEvent"].wait())
        try:
            done, _pending = await asyncio.wait({task, waiter}, timeout=timeout_s, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            task.cancel()  # the link is closing this handler
            raise
        finally:
            if not waiter.done():
                waiter.cancel()
        if entry["cancelled"]:
            task.cancel()
            return "cancelled", None
        if task in done:
            if task.cancelled():
                return "cancelled", None
            return "done", task.result()
        task.cancel()
        return "timeout", None

    async def _call(
        self, llm: Any, api: str, system: str, user: str, kwargs: Dict[str, Any], schema_name: str = "silent_input_words"
    ) -> Any:
        """One direct completion, issued exactly once. Optional kwargs an
        older PluginLlm does not declare are dropped up front from its
        signature — never by retrying on a TypeError's text, which could
        re-issue a completion after a provider-side TypeError."""
        if api == "acomplete_structured":
            fn = llm.acomplete_structured
            return await fn(
                instructions=system,
                input=[{"type": "text", "text": user}],
                json_mode=True,
                schema_name=schema_name,
                **_supported_kwargs(fn, kwargs),
            )
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        if api == "acomplete":
            fn = llm.acomplete
            return await fn(messages, **_supported_kwargs(fn, kwargs))
        raise RuntimeError(f"unsupported plugin LLM api: {api!r}")

    def _elapsed(self, started: float) -> int:
        return max(0, int(round((self._clock() - started) * 1000)))

    # -- cancel -------------------------------------------------------------

    async def handle_model_allow(self, params: Any) -> Dict[str, Any]:
        """#3359 round 3: ``input.prediction.model.allow``.

        Accepts ONLY an id this profile's own ``models`` list shows with
        ``allowed: False`` — a model the profile already routes to that the
        plugin may not yet override to. Everything else is ``policy-denied``,
        before any write. The write itself is the adapter's (``allow_model``).
        Only the id is logged."""
        p = params if isinstance(params, dict) else {}
        request_id = _echo_request_id(p)
        raw_choice = p.get("modelChoice")
        choice = raw_choice.strip() if isinstance(raw_choice, str) else ""
        if not choice or choice == "default" or not _MODEL_CHOICE_RE.fullmatch(choice):
            return model_allow_result(request_id, "policy-denied")
        caps = await self.handle_capabilities({"profileId": p.get("profileId")})
        listed = next((m for m in caps.get("models", []) if m.get("id") == choice), None)
        if listed is None or listed.get("allowed") is not False:
            return model_allow_result(request_id, "policy-denied")
        if self._allow_model is None:
            _LOGGER.info("[ocuclaw] input prediction model allow %s: no config writer", choice)
            return model_allow_result(request_id, "error")
        ns, home, _error = self._resolve(p.get("profileId"))
        try:
            out = await asyncio.to_thread(self._allow_model, choice, ns, home)
        except Exception:  # noqa: BLE001 - never echo a writer's text
            out = {"status": "error"}
        r = out if isinstance(out, dict) else {}
        result = model_allow_result(request_id, r.get("status"), r.get("activation"))
        _LOGGER.info("[ocuclaw] input prediction model allow %s: %s", choice, result["status"])
        return result

    async def handle_cancel(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        request_id = p.get("requestId") if isinstance(p.get("requestId"), str) else ""
        client_id = p.get("clientId") if isinstance(p.get("clientId"), str) else ""
        # Only the owning client may cancel: the key is (clientId, requestId),
        # with no fallback for an entry registered without a client.
        entry = self._active.get((client_id, request_id)) if request_id else None
        if entry is None:
            if request_id and any(rid == request_id for (_cid, rid) in self._active):
                return {"accepted": False, "abort": False, "reason": "not the requesting client"}
            return {"accepted": False, "abort": False, "reason": "no active request"}
        abort, probe = self._abort_verdict(str(entry.get("api") or ""))
        entry["cancelled"] = True
        entry["cancelEvent"].set()
        reason = "result suppressed and the local call cancelled; Hermes cannot prove the provider call stopped (thread-backed providers keep running until their timeout), so it may still complete and bill"
        return {"accepted": True, "abort": abort, "abortProbe": probe, "reason": reason}

    # -- test ---------------------------------------------------------------

    async def handle_test(self, params: Any) -> Dict[str, Any]:
        """The readiness Test, on the route the feature really uses (#3126).

        It used to ask this backend for next WORDS. That route is retired: a
        phone only sends per-word requests to a host that RANKS with TypeSafe,
        and a ranking host runs its Test through the ranker without ever
        reaching here. So what is left for this backend to prove is the ONE
        call it still answers, the whole replies written when the editor opens.
        Same route, same prompt family and same deadline as the real call, on a
        fixed non-personal sentence, under the caller's own deadline.

        #3190: a SMALLER ask. Two replies, no words, 96 tokens instead of five,
        forty and 512. The wearer waits on this one, and the full-size ask timed
        out half the time. The route, the provider, the model resolution and the
        prompt family are unchanged, so the provider/model this reports is still
        the one an open answer is admitted against. Kept identical to the Node
        adapter."""
        p = params if isinstance(params, dict) else {}
        request_id = _echo_request_id(p) or f"test-{uuid.uuid4().hex[:8]}"
        # The budget the CALLER is testing, when it sends one. The plugin waits
        # on its own deadline, and a Test that gave up a second before the
        # caller does would tell the wearer the wrong thing about a route that
        # was about to answer. Anything that is not a finite number falls back
        # to the real call's own budget. No clamp here:
        # ``normalize_open_request`` already bounds it to
        # [200, maxTimeoutMs], so the shared pool is guarded either way.
        raw_timeout = p.get("timeoutMs")
        caller_timeout = (
            raw_timeout
            if isinstance(raw_timeout, (int, float))
            and not isinstance(raw_timeout, bool)
            and math.isfinite(raw_timeout)
            else SILENT_INPUT_OPEN_LIMITS["timeoutMs"]
        )
        req = dict(SILENT_INPUT_OPEN_TEST_EXAMPLE)
        req.update(
            {
                "requestId": request_id,
                "clientId": p.get("clientId") if isinstance(p.get("clientId"), str) else "",
                "profileId": p.get("profileId") if isinstance(p.get("profileId"), str) else "",
                "modelChoice": p.get("modelChoice") if isinstance(p.get("modelChoice"), str) and p.get("modelChoice").strip() else "default",
                "timeoutMs": caller_timeout,
            }
        )
        normalized = normalize_open_request(req)
        if not normalized["ok"]:
            return {"requestId": request_id, "status": normalized["status"], "provider": "", "model": "", "elapsedMs": 0, "candidates": [], "usage": None, "reason": normalized["reason"]}
        result = await self._run(normalized["value"], self._open_spec(SILENT_INPUT_OPEN_TEST_LIMITS))
        replies = result.get("replies") or []
        # Reply WORDS alone are a ready open answer but not a ready Test: what
        # the wearer is shown, and consenting to, is whole replies.
        status = "invalid-output" if result["status"] == "ready" and not replies else result["status"]
        reason = "no whole replies" if status != result["status"] else result.get("reason")
        return {
            "requestId": request_id,
            "status": status,
            "provider": result.get("provider", ""),
            "model": result.get("model", ""),
            "elapsedMs": result.get("elapsedMs", 0),
            "candidates": list(replies),
            "usage": result.get("usage"),
            "reason": reason,
        }


def _consume_task_result(task: "asyncio.Future[Any]") -> None:
    """Mark an abandoned completion's exception retrieved (no loop warning)."""
    if not task.cancelled():
        task.exception()
