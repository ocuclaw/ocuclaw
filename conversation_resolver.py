"""Read-only native-key lineage discovery shared by navigation and actions.

Accepts an already owned public reader; it never opens or heals a database.
"""
import inspect
import json
import math


class ConversationUnavailable(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def compression_ancestors(reader, session_id, *, limit=100):
    """Bounded tip-to-root public reads, preserving native fork boundaries.

    Native get_compression_lineage has an unbounded ancestor/child walk.
    This action already resolved the tip and only needs its ancestors.
    """
    result, seen = [], set()
    row = reader.get_session(session_id)
    if row is None:
        raise ConversationUnavailable("conversation_missing")
    while row:
        current = str(row["id"])
        if current in seen:
            raise ConversationUnavailable("identity_conflict")
        if len(result) >= limit:
            raise ConversationUnavailable("discovery_truncated")
        seen.add(current)
        result.append(current)
        parent_id = row.get("parent_session_id")
        if not parent_id or row.get("source") == "tool":
            break
        config = row.get("model_config")
        if isinstance(config, str):
            try:
                config = json.loads(config)
            except (ValueError, TypeError):
                raise ConversationUnavailable("identity_conflict") from None
        if isinstance(config, dict) and parent_id in (
            config.get("_branched_from"), config.get("_delegate_from")
        ):
            break
        parent = reader.get_session(parent_id)
        if parent is None or parent.get("end_reason") != "compression":
            break
        row = parent
    return result


def compression_tip(reader, session_id):
    """Follow only native compression edges, never generic copy ancestry.

    resolve_resume_session_id additionally walks ordinary parent links to
    the deepest child with messages. A copied conversation also has that
    link, so it is not a safe identity resolver. The public compression
    chain requires its parent to have ended for compression.
    """
    chain_reader = getattr(reader, "get_compression_chain", None)
    if not callable(chain_reader):
        # 0.21.0 exposes the same compression-only traversal as a tip, not
        # a chain. Verify its ancestry through public rows so an exhausted
        # native walk cannot masquerade as a final target. Do not fall back
        # to the generic resume API or the differently ordered lineage API.
        tip_reader = getattr(reader, "get_compression_tip", None)
        if not callable(tip_reader):
            raise ConversationUnavailable("storage_unsupported")
        tip = tip_reader(session_id)
        current, seen = tip, set()
        while current != session_id:
            if not current or current in seen:
                raise ConversationUnavailable("identity_conflict")
            seen.add(current)
            if len(seen) >= 100:
                raise ConversationUnavailable("discovery_truncated")
            row = reader.get_session(current)
            parent_id = row.get("parent_session_id") if row else None
            parent = reader.get_session(parent_id) if parent_id else None
            if parent is None:
                raise ConversationUnavailable("conversation_missing")
            if parent.get("end_reason") != "compression":
                raise ConversationUnavailable("identity_conflict")
            current = parent_id
        return tip
    chain = chain_reader(session_id)
    # Native's 100-step defensive bound returns up to 101 IDs. Do not
    # mistake an exhausted walk for a verified final conversation.
    if len(chain) >= 101:
        raise ConversationUnavailable("discovery_truncated")
    if not chain or chain[0] != session_id:
        raise ConversationUnavailable("conversation_missing")
    return chain[-1]


def carriers_for_key(reader, key, *, limit=10000):
    kwargs = dict(limit=limit, include_children=True, include_archived=True,
                  order_by_last_active=False, project_compression_tips=False)
    parameters = inspect.signature(reader.list_sessions_rich).parameters
    if "include_hidden" in parameters:
        kwargs["include_hidden"] = True
    if "session_key" in parameters:
        kwargs["session_key"] = key
    rows = reader.list_sessions_rich(**kwargs)
    if len(rows) >= limit:
        raise ConversationUnavailable("discovery_truncated")
    carriers = [dict(row) for row in rows if row.get("session_key") == key]
    carriers.sort(key=lambda row: (row.get("ended_at") is None, _started_at(row)), reverse=True)
    return carriers


def _started_at(row):
    value = row.get("started_at")
    try:
        timestamp = float(value) if value is not None and not isinstance(value, bool) else 0.0
    except (TypeError, ValueError, OverflowError):
        raise ConversationUnavailable("session_timestamp_invalid") from None
    if not math.isfinite(timestamp) or isinstance(value, bool):
        raise ConversationUnavailable("session_timestamp_invalid")
    return timestamp


def resolve_conversation(reader, key, *, allow_ended=False, latest_ended=False, include_history=False):
    """One validated target, never a recency guess.

    Historical metadata/read/copy/delete actions may explicitly accept one
    ended lineage. Execution/navigation callers require a live target.
    Ambiguity is rejected in both modes, before a writer can be borrowed.

    `latest_ended` is for callers that change nothing about the source (reads,
    copy). A key's lineages are sequential: a reset ends one and a shutdown
    ends the next with no successor until the next message, so several ended
    lineages and no live one is an ordinary chat, not a conflict (#3169). Those
    callers take the strictly newest; a tie is still refused.
    """
    def discover():
        rows = carriers_for_key(reader, key)
        if not rows:
            raise ConversationUnavailable("conversation_missing")
        targets = {}
        ended_targets = {}
        for row in rows:
            if not row.get("id"):
                raise ConversationUnavailable("conversation_missing")
            tip = compression_tip(reader, row["id"])
            current = reader.get_session(tip) if tip else None
            if current is None:
                raise ConversationUnavailable("conversation_missing")
            if current:
                # A compression continuation may carry no key, but must be
                # reached by the public resolver from this exact lineage.
                if current.get("session_key") not in (None, "", key):
                    raise ConversationUnavailable("identity_conflict")
                target_set = targets if current.get("ended_at") is None else ended_targets
                target_set[str(current["id"])] = dict(current)
        if not targets:
            if allow_ended:
                targets = ended_targets
            if not targets:
                raise ConversationUnavailable("conversation_ended")
            if latest_ended and len(targets) > 1:
                newest, runner_up = sorted(targets.values(), key=_started_at, reverse=True)[:2]
                if _started_at(newest) > _started_at(runner_up):
                    return newest
        if len(targets) != 1:
            raise ConversationUnavailable("identity_conflict")
        return next(iter(targets.values()))

    for _ in range(2):
        first = discover()
        second = discover()
        if first["id"] == second["id"]:
            if include_history:
                second["hasHistory"] = bool(reader.get_messages(second["id"], limit=1))
            return second
    raise ConversationUnavailable("conversation_changed")


def resolve_live_conversation(reader, key):
    return resolve_conversation(reader, key, include_history=True)
