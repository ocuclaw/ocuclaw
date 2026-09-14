"""Explicit-path, operation-scoped ownership of Hermes's native writer.

No fallback constructor: engines without the public registry report unsupported.
The registry owns replacement generations and physical close; this adapter owns
only the reference borrowed for one call, including exceptional completion.
"""
from pathlib import Path
from contextlib import contextmanager
import sqlite3
import json


class SharedSessionWriter:
    def __init__(self, path):
        self.path = Path(path).resolve()

    @staticmethod
    def _storage_reason(exc, fallback):
        # Native patience exhaustion wraps the SQLite exception; its bounded
        # cause still carries the machine-readable code (never parse paths).
        for _ in range(3):
            code = (getattr(exc, "sqlite_errorcode", 0) or 0) & 0xff
            if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                return "session_storage_busy"
            exc = getattr(exc, "__cause__", None)
            if exc is None:
                break
        return fallback

    @contextmanager
    def borrow(self):
        try:
            from hermes_state_registry import acquire, release
        except ImportError:
            raise RuntimeError("session_writer_unsupported") from None
        if not callable(acquire) or not callable(release):
            raise RuntimeError("session_writer_unsupported")
        if not self.path.is_file():
            raise RuntimeError("session_store_unavailable")
        try:
            writer = acquire(self.path)
        except Exception as exc:
            raise RuntimeError(self._storage_reason(exc, "session_store_unavailable")) from None
        failed = False
        try:
            yield writer
        except sqlite3.Error as exc:
            failed = True
            raise RuntimeError(self._storage_reason(exc, "session_mutation_unknown")) from None
        except OSError:
            failed = True
            raise RuntimeError("session_mutation_unknown") from None
        except ValueError as exc:
            failed = True
            reason = "session title already in use" if "already in use" in str(exc) else "session_mutation_rejected"
            raise ValueError(reason) from None
        except RuntimeError as exc:
            failed = True
            if str(exc) in ("session_writer_unsupported", "session_store_changed", "session_copy_source_changed", "session_selection_changed"):
                raise
            raise RuntimeError("session_mutation_unknown") from None
        except Exception:
            failed = True
            raise RuntimeError("session_mutation_unknown") from None
        except BaseException:
            failed = True
            raise
        finally:
            try:
                release(writer)
            except Exception:
                if not failed:
                    raise RuntimeError("session_mutation_unknown") from None

    def __getattr__(self, name):
        if name.startswith("_") or name == "close":
            raise AttributeError(name)

        def call(*args, **kwargs):
            with self.borrow() as writer:
                method = getattr(writer, name, None)
                if not callable(method):
                    raise RuntimeError("session_writer_unsupported")
                return method(*args, **kwargs)

        return call

    def copy_conversation(self, *, session_id, session_key, chat_id, source,
                          messages, profile, expected_identity):
        """One owner transaction creates a complete, explicitly separate copy.

        Native import_sessions is atomic but deliberately strips gateway keys.
        This compatibility adapter reuses its validator and row/message writer
        inside the owner's transaction, adding only the new OcuClaw route and
        provenance metadata. A copy has no native parent link: stock Desktop's
        resume resolver may follow ordinary children into a different chat.
        No new connection, nested commit, or replay is introduced.
        Engines missing those exact primitives refuse before creating a row.
        """
        with self.borrow() as writer:
            validate = getattr(writer, "_validate_import_payload", None)
            insert = getattr(writer, "_import_session_row", None)
            execute = getattr(writer, "_execute_write", None)
            if not all(callable(method) for method in (validate, insert, execute)):
                raise RuntimeError("session_writer_unsupported")
            source_id = source.get("id")
            if not source_id:
                raise RuntimeError("session_copy_source_changed")
            normalized, errors = validate([{
                "id": session_id, "source": "ocuclaw",
                "model_config": {"_branched_from": source_id},
                "messages": [{"role": message["role"], "content": message.get("content")}
                             for message in messages],
            }])
            if errors or len(normalized) != 1:
                raise ValueError("copy payload rejected")
            item = normalized[0]

            def copy(conn):
                stat = self.path.stat()
                if (stat.st_dev, stat.st_ino) != expected_identity:
                    raise RuntimeError("session_store_changed")
                current = conn.execute("SELECT * FROM sessions WHERE id = ?", (source_id,)).fetchone()
                if current is None or any(current[field] != source.get(field)
                                          for field in ("source", "session_key", "end_reason")):
                    raise RuntimeError("session_copy_source_changed")
                if conn.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,)).fetchone():
                    raise ValueError("copy identity conflict")
                insert(conn, item["session"], item["messages"], session_id)
                conn.execute("""UPDATE sessions SET session_key = ?, chat_id = ?, chat_type = 'dm',
                    parent_session_id = NULL, profile_name = ?, cwd = ?, git_repo_root = ?, git_branch = ?
                    WHERE id = ?""", (session_key, chat_id, profile,
                                      current["cwd"], current["git_repo_root"], current["git_branch"], session_id))
                return dict(conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone())

            return execute(copy)

    def delete_conversation(self, rows, *, expected_identity):
        """Guard selection and preserve native bulk-delete effects in one txn.

        Public delete_sessions cannot condition on the selected lineage. The
        compatibility adapter uses its exact cascade and cleanup helpers; an
        engine without them refuses before mutation.
        """
        with self.borrow() as writer:
            try:
                from hermes_state_sessions import _delete_delegate_children
            except ImportError:
                raise RuntimeError("session_writer_unsupported") from None
            execute = getattr(writer, "_execute_write", None)
            cleanup = getattr(writer, "_delete_unreferenced_system_prompts", None)
            remove_files = getattr(writer, "_remove_session_files", None)
            if not all(callable(method) for method in (execute, cleanup, remove_files,
                                                       _delete_delegate_children)):
                raise RuntimeError("session_writer_unsupported")
            if not rows or len(rows) > 100:
                raise RuntimeError("session_selection_changed")
            ids = [row["id"] for row in rows]
            placeholders = ",".join("?" for _ in ids)
            fields = ("source", "session_key", "parent_session_id", "end_reason", "ended_at")

            def delete(conn):
                stat = self.path.stat()
                if (stat.st_dev, stat.st_ino) != expected_identity:
                    raise RuntimeError("session_store_changed")
                for row in rows:
                    current = conn.execute("SELECT * FROM sessions WHERE id = ?", (row["id"],)).fetchone()
                    if current is None or any(current[field] != row.get(field) for field in fields):
                        raise RuntimeError("session_selection_changed")
                    if current["end_reason"] != "compression":
                        continue
                    children = conn.execute("SELECT * FROM sessions WHERE parent_session_id = ? LIMIT 101",
                                            (row["id"],)).fetchall()
                    if len(children) > 100:
                        raise RuntimeError("session_selection_changed")
                    for child in children:
                        if child["id"] in ids or child["source"] == "tool":
                            continue
                        config = child["model_config"]
                        try:
                            config = json.loads(config) if isinstance(config, str) else config
                        except (ValueError, TypeError):
                            raise RuntimeError("session_selection_changed") from None
                        if isinstance(config, dict) and row["id"] in (
                            config.get("_branched_from"), config.get("_delegate_from")
                        ):
                            continue
                        raise RuntimeError("session_selection_changed")
                removed = _delete_delegate_children(conn, ids)
                conn.execute(f"UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id IN ({placeholders})", ids)
                conn.execute(f"DELETE FROM messages WHERE session_id IN ({placeholders})", ids)
                conn.execute(f"DELETE FROM sessions WHERE id IN ({placeholders})", ids)
                cleanup(conn)
                if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_obligations'").fetchone():
                    for key in {row.get("session_key") for row in rows if row.get("session_key")}:
                        conn.execute("DELETE FROM delivery_obligations WHERE session_key = ? AND NOT EXISTS "
                                     "(SELECT 1 FROM sessions WHERE session_key = ?)", (key, key))
                return [*removed, *ids]

            removed = execute(delete)
            for session_id in removed:
                remove_files(None, session_id)
            return ids
