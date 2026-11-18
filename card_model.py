"""Direct card completions. Own cancellation; never create a Hermes session.

Cancellation ends our await. A provider running behind asyncio.to_thread may
still finish and bill; no claim of provider-side abortion is made.
"""
from __future__ import annotations

import asyncio
import math
import re
import copy
import contextvars
import hashlib
from collections.abc import Mapping


_KINDS = ("provider", "model")


def _split_ref(ref):
    """(provider, model) for a native card model ref, or None when it may not be granted."""
    if not isinstance(ref, str) or "/" not in ref or len(ref) > 256:
        return None
    provider, model = ref.split("/", 1)
    if not re.fullmatch(r"[A-Za-z0-9._-]+", provider) or not model or "*" in ref or any(c.isspace() for c in model):
        return None
    return provider, model


def _policy_home(profile_home):
    """The Hermes home whose policy a card call may touch, or None when it is not this one."""
    from pathlib import Path
    from . import optional_setup as setup
    if profile_home is None:
        return setup._home()
    from hermes_constants import get_hermes_home
    home = Path(profile_home)
    return home if home.resolve() == Path(get_hermes_home()).resolve() else None


def _kind_permitted(node, kind, value):
    existing = node.get(f"allowed_{kind}s")
    if node.get(f"allow_{kind}_override") is not True:
        return False
    if existing is None:
        return True  # switch on with no list: unrestricted
    if not isinstance(existing, list):
        return False  # a malformed value is never read as unrestricted
    return "*" in existing or value.lower() in {str(x).lower() for x in existing}


def permits_card_model(ref, *, profile_home=None):
    """Read only: whether this plugin's PluginLlm policy already lets a card call [ref]."""
    from hermes_cli.config import read_raw_config
    from . import optional_setup as setup

    split = _split_ref(ref)
    if split is None or _policy_home(profile_home) is None:
        return {"permitted": False}
    node = read_raw_config()
    for key in setup.LLM_POLICY_PATH:
        node = node.get(key) if isinstance(node, dict) else None
    if not isinstance(node, dict):
        return {"permitted": False}
    return {"permitted": all(_kind_permitted(node, kind, value) for kind, value in zip(_KINDS, split))}


def allow_card_model(ref, *, profile_home=None):
    """Append native provider/bare-model grants, preserving unrestricted policy.

    PluginLlm gates the two overrides independently. The Node engine separately
    locks each call to the exact provider/model pair the wearer approved.
    A write hands back `undo`: per kind, the entry it appended (or None), and the
    switch and list as they were, for revoke_card_model. Nothing added: no `undo`.
    """
    from hermes_cli.config import read_raw_config, save_config
    from . import optional_setup as setup, receipts

    split = _split_ref(ref)
    if split is None:
        return {"status": "policy-denied"}
    provider, model = split
    home = _policy_home(profile_home)
    if home is None:
        return {"status": "policy-denied"}
    changes = {}
    with receipts.receipt_state_lock(receipts.state_dir(home), setup.LOCK) as locked:
        if not locked:
            return {"status": "error"}
        doc = copy.deepcopy(read_raw_config())
        if not isinstance(doc, dict):
            return {"status": "error"}
        node = doc
        for key in setup.LLM_POLICY_PATH:
            node = node.setdefault(key, {})
            if not isinstance(node, dict):
                return {"status": "error"}
        for kind, value in (("provider", provider), ("model", model)):
            flag, field = f"allow_{kind}_override", f"allowed_{kind}s"
            existing = node.get(field)
            if node.get(flag) is True and (not isinstance(existing, list) or "*" in existing):
                continue  # Already unrestricted: never narrow a policy for other callers.
            if existing is not None and (not isinstance(existing, list) or any(not isinstance(x, str) for x in existing)):
                return {"status": "error"}
            values = list(existing or [])
            appended = value.lower() not in {x.lower() for x in values}
            if appended:
                values.append(value)
            if appended or node.get(flag) is not True:
                changes[kind] = {"appended": value if appended else None,
                                 "flagWas": node[flag] if flag in node else "absent",
                                 "listWas": list(existing) if isinstance(existing, list) else None}
            node[flag], node[field] = True, values
        save_config(doc, strip_defaults=False)
        back = read_raw_config()
        for key in setup.LLM_POLICY_PATH:
            back = back.get(key) if isinstance(back, dict) else None
        if not isinstance(back, dict):
            return {"status": "error"}
        for kind, value in (("provider", provider), ("model", model)):
            values = back.get(f"allowed_{kind}s")
            if back.get(f"allow_{kind}_override") is not True or (isinstance(values, list) and "*" not in values and value.lower() not in {str(x).lower() for x in values}):
                return {"status": "error"}
    out = {"status": "saved", "activation": {"required": False, "mode": "none"}}
    if changes:
        out["undo"] = {"ref": ref, "changes": changes}
    return out


def _valid_undo(undo):
    """Only a receipt allow_card_model could have written: each change names a write that
    really happened (an entry appended, or a switch turned on), its entry is the receipt's own
    provider or model and was not already listed, and a list it records creating had an entry
    appended to it."""
    split = _split_ref(undo.get("ref")) if isinstance(undo, Mapping) else None
    if split is None:
        return False
    changes = undo.get("changes")
    if not isinstance(changes, Mapping) or not changes or any(kind not in _KINDS for kind in changes):
        return False
    own = dict(zip(_KINDS, split))
    for kind, change in changes.items():
        if not isinstance(change, Mapping) or set(change) != {"appended", "flagWas", "listWas"}:
            return False
        appended, flag_was, was = change["appended"], change["flagWas"], change["listWas"]
        if flag_was != "absent" and not isinstance(flag_was, bool):
            return False
        if was is not None and (not isinstance(was, list) or any(not isinstance(x, str) for x in was)):
            return False
        if appended is None:
            # A switch flip alone: the switch was off, and the entry was already in a list.
            if flag_was is True or was is None:
                return False
        elif appended != own[kind] or appended.lower() in {x.lower() for x in (was or [])}:
            return False
    return True


def revoke_card_model(undo, *, profile_home=None, keep=()):
    """Take back one allow_card_model write (its `undo`): the entry it appended, and the
    switch and list shape only when nothing else changed that list since. An entry or a
    switch that was there before the write is never removed. A provider entry stays while
    another model may rely on it: a model was listed since, or a `keep` ref (one another
    card in this engine relies on) names the same provider."""
    from hermes_cli.config import read_raw_config, save_config
    from . import optional_setup as setup, receipts

    home = _policy_home(profile_home)
    if not _valid_undo(undo) or home is None:
        return {"status": "policy-denied"}
    kept = [_split_ref(ref) for ref in (keep if isinstance(keep, (list, tuple)) else ())]
    kept = [k for k in kept if k is not None]
    own = dict(zip(_KINDS, _split_ref(undo["ref"])))
    with receipts.receipt_state_lock(receipts.state_dir(home), setup.LOCK) as locked:
        if not locked:
            return {"status": "error"}
        doc = copy.deepcopy(read_raw_config())
        node = doc
        for key in setup.LLM_POLICY_PATH:
            node = node.get(key) if isinstance(node, dict) else None
        if not isinstance(node, dict):
            return {"status": "revoked"}  # nothing of ours is left to take back
        # The model change first: a model listed since this write may need its provider.
        models_since = False
        for kind in ("model", "provider"):
            change = undo["changes"].get(kind)
            if change is None:
                continue
            if any(k[0 if kind == "provider" else 1].lower() == own[kind].lower() for k in kept):
                continue  # another card relies on this entry
            if kind == "provider" and models_since:
                continue
            flag, field = f"allow_{kind}_override", f"allowed_{kind}s"
            current = node.get(field)
            if not isinstance(current, list):
                continue
            appended = change["appended"]
            prior = change["listWas"] or []
            values = [x for x in current if x != appended] if appended is not None else list(current)
            if values != prior:
                if kind == "model":
                    models_since = True
                if appended is not None:
                    node[field] = values
                continue
            if change["listWas"] is None:
                node.pop(field, None)  # _valid_undo: this write created the list
            else:
                node[field] = values
            if change["flagWas"] == "absent":
                node.pop(flag, None)
            elif change["flagWas"] is False:
                node[flag] = False
        save_config(doc, strip_defaults=False)
    return {"status": "revoked"}

COMPLETE = "program_card.model.complete"
CANCEL = "program_card.model.cancel"
# The UTF-8 bytes of one call's message text. The engine
# (glasses-ui-program-card-model.ts run) builds a call from the model block
# (MODEL_LIMITS.blockBytes, 16 KB: system framing plus instructions and output
# schema), the thread memory (32 KB), the new input (MODEL_LIMITS.inputBytes,
# 8 KB) and, on a repair, the model's own answer (32 KB) plus the error list:
# about 90 KB at most, with room to spare.
CARD_MODEL_MESSAGES_MAX_BYTES = 128 * 1024


def model_matches(provider, model, actual_provider, actual_model):
    if provider != actual_provider or not isinstance(actual_model, str):
        return False
    return model.lower() == actual_model.lower() or bool(re.fullmatch(
        re.escape(model) + r"-\d{4}(?:-?\d{2}){2}", actual_model, re.IGNORECASE))


class CardModelCalls:
    def __init__(self):
        self.pending = {}

    async def cancel(self, params):
        operation = self.pending.get(params.get("callId")) if isinstance(params, Mapping) else None
        if operation is not None:
            operation.cancel()
        return {"cancelled": operation is not None}

    async def complete(self, llm, params, *, task=None, context_factory=None):
        if not isinstance(params, Mapping):
            return {"ok": False, "code": "failed"}
        call_id = params.get("callId")
        if not isinstance(call_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", call_id) or call_id in self.pending:
            return {"ok": False, "code": "busy"}
        operation = asyncio.create_task(self._scoped_complete(llm, params, task, context_factory))
        self.pending[call_id] = operation
        try:
            return await operation
        except asyncio.CancelledError:
            return {"ok": False, "code": "paused"}
        finally:
            self.pending.pop(call_id, None)

    async def _scoped_complete(self, llm, params, task, context_factory):
        if context_factory is None:
            return await self._complete(llm, params, task=task)
        try:
            scoped = await context_factory()
        except Exception:
            return {"ok": False, "code": "unavailable"}
        # Capture happens off-loop; the owned task is registered before it,
        # so cancellation also covers credential/config preparation.
        return await scoped.run(asyncio.create_task, self._complete(llm, params, task=task))

    async def _complete(self, llm, p, *, task):
        provider, model, messages = p.get("provider"), p.get("model"), p.get("messages")
        if not all(isinstance(x, str) and x and len(x) <= 200 for x in (provider, model)):
            return {"ok": False, "code": "unavailable"}
        if not isinstance(messages, list) or not 2 <= len(messages) <= 44:
            return {"ok": False, "code": "too_big"}
        if any(not isinstance(m, Mapping) or m.get("role") not in {"system", "user", "assistant"}
               or not isinstance(m.get("content"), str) for m in messages):
            return {"ok": False, "code": "failed"}
        # UTF-8 bytes of the text, as the engine counts (a lone surrogate as 3).
        if sum(len(m["content"].encode("utf-8", "surrogatepass")) for m in messages) > CARD_MODEL_MESSAGES_MAX_BYTES:
            return {"ok": False, "code": "too_big"}
        max_tokens, timeout_ms = p.get("maxTokens"), p.get("timeoutMs")
        if type(max_tokens) is not int or not 1 <= max_tokens <= 2000:
            return {"ok": False, "code": "failed"}
        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or not math.isfinite(timeout_ms) or timeout_ms <= 0:
            return {"ok": False, "code": "timeout"}
        timeout = min(timeout_ms / 1000, 60)
        if not callable(getattr(llm, "acomplete", None)):
            return {"ok": False, "code": "unavailable"}
        kwargs = {"provider": provider, "model": model, "max_tokens": max_tokens,
                  "timeout": timeout, "purpose": "ocuclaw program card model"}
        if task:
            kwargs["task"] = task
        try:
            result = await asyncio.wait_for(llm.acomplete(messages, **kwargs), timeout=timeout)
        except asyncio.TimeoutError:
            return {"ok": False, "code": "timeout"}
        except asyncio.CancelledError:
            raise
        except Exception:
            return {"ok": False, "code": "failed"}
        actual_provider, actual_model = getattr(result, "provider", None), getattr(result, "model", None)
        u = getattr(result, "usage", None)
        usage = {}
        for public, field in (("inputTokens", "input_tokens"), ("outputTokens", "output_tokens"), ("costUsd", "cost_usd")):
            value = getattr(u, field, None)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                usage[public] = value
        # Return mismatch identity but no answer. Node records the spend and pauses.
        match = model_matches(provider, model, actual_provider, actual_model)
        return {"ok": match, **({"text": getattr(result, "text", "")} if match else {"code": "model_changed"}),
                "provider": actual_provider, "model": model if match else actual_model,
                "responseModel": actual_model, "usage": usage}


class ScopedCardModels:
    """A trusted relay-selected profile owns catalog, policy and inference."""

    def __init__(self, *, resolve_profile, profile_scope, models_rpc, llm, task):
        self.resolve_profile, self.profile_scope = resolve_profile, profile_scope
        self.models_rpc, self.llm, self.task = models_rpc, llm, task
        self.calls = CardModelCalls()

    def _route(self, params):
        name = params.get("profileId") if isinstance(params, Mapping) else None
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            return None
        ns, home, error = self.resolve_profile(name)
        return (ns, home) if ns and home is not None and not error else None

    def _owned_params(self, params, route):
        value = dict(params)
        call_id = value.get("callId")
        if not isinstance(call_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", call_id):
            return None
        value["callId"] = hashlib.sha256(f"{route[0]}\n{call_id}".encode()).hexdigest()
        return value

    async def _context(self, route):
        def read():
            with self.profile_scope(*route):
                return contextvars.copy_context()
        return await asyncio.to_thread(read)

    async def models(self, params):
        route = self._route(params)
        if route is None:
            return []
        async def read():
            return (await self.models_rpc.list_models({"ns": route[0]}),
                    await self.models_rpc.configured({"ns": route[0]}))
        scoped = await self._context(route)
        listing, configured = await scoped.run(asyncio.create_task, read())
        main = configured.get("default") or {}
        return [{"ref": f"{r['provider']}/{r['id']}", "provider": r["provider"], "model": r["id"],
                 "label": r.get("name") or r["id"],
                 "isMain": r["provider"] == main.get("provider") and r["id"] == main.get("id", main.get("model"))}
                for r in listing.get("models", []) if isinstance(r.get("provider"), str) and isinstance(r.get("id"), str)]

    async def allow(self, params):
        route = self._route(params)
        ref = params.get("ref") if isinstance(params, Mapping) else None
        if route is None or not any(m["ref"] == ref for m in await self.models(params)):
            return {"status": "policy-denied"}
        def write():
            with self.profile_scope(*route):
                return allow_card_model(ref, profile_home=route[1])
        return await asyncio.to_thread(write)

    async def permits(self, params):
        """Read only: whether the profile's policy already permits a listed model."""
        route = self._route(params)
        ref = params.get("ref") if isinstance(params, Mapping) else None
        if route is None or not any(m["ref"] == ref for m in await self.models(params)):
            return {"permitted": False}
        def read():
            with self.profile_scope(*route):
                return permits_card_model(ref, profile_home=route[1])
        return await asyncio.to_thread(read)

    async def revoke(self, params):
        """Take back one allow's write, by the `undo` that allow handed back. `keep`: refs
        other cards in the engine rely on, whose provider entry must stay."""
        route = self._route(params)
        undo = params.get("undo") if isinstance(params, Mapping) else None
        keep = params.get("keep") if isinstance(params, Mapping) else None
        if route is None:
            return {"status": "policy-denied"}
        keep = [ref for ref in keep if isinstance(ref, str)][:64] if isinstance(keep, list) else []
        def write():
            with self.profile_scope(*route):
                return revoke_card_model(undo, profile_home=route[1], keep=keep)
        return await asyncio.to_thread(write)

    async def complete(self, params):
        route = self._route(params)
        owned = self._owned_params(params, route) if route else None
        if owned is None:
            return {"ok": False, "code": "unavailable"}
        return await self.calls.complete(self.llm(), owned, task=self.task(), context_factory=lambda: self._context(route))

    async def cancel(self, params):
        route = self._route(params)
        owned = self._owned_params(params, route) if route else None
        return await self.calls.cancel(owned) if owned else {"cancelled": False}
