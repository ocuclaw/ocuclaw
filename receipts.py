"""OcuClaw receipts — the collect side's durable half (#1317).

Four profile-scoped records (#1273 §8 / #1268 / #1321), plus one host-scoped:

    <HERMES_HOME>/state/ocuclaw.app-presence.json     high-churn, 120s TTL
    <HERMES_HOME>/state/ocuclaw.first-run-proof-attempt.json  private, 1h TTL
    <HERMES_HOME>/state/ocuclaw.first-run-proof.json   durable, never expires
    <HERMES_HOME>/state/ocuclaw.relay-credential.json  durable discriminator
    ~/.evenclaw/state/ocuclaw.managed-serve-route.json  host-wide, durable

Scope follows what each record describes. The first four describe one profile's
state and are exact-profile. The fifth describes the machine's one Tailscale
Serve route, which every gateway install on the host shares, so it is
host-scoped by owner ruling (#1373) — a receipt about a host-wide route that
lived in one profile's home could never be found by the install that needed
it.

All receipt writes are atomic and fail closed when platform hardening fails.
On POSIX they are owner-only; on Windows they stay inside Hermes's per-user
profile boundary while inherited and broad-principal access is removed. The
first two are additionally exact-profile. The high-churn presence writer never
read-modify-writes the durable proof — they are separate files precisely so a
30-second heartbeat can never corrupt a once-in-a-lifetime record. The public Connection Health Snapshot is derived on demand from these
plus live facts; it is deliberately **not** persisted as a third competing
truth.

**Where truth lives.** ``resolve_receipt_home`` resolves the same home the
platform's own ``gateway_state.json`` resolves to, by the same rules (#1277
rule 1): Hermes's ``get_process_hermes_home()``, which is exactly what
``gateway.status._get_pid_path()`` uses. Two resolvers that disagree about
where truth lives is the failure this criterion exists to prevent, so this
module deliberately has no path of its own to fall back to — it fails closed
and reports ``unavailable`` rather than guessing ``~/.hermes``.

**Platform-hardened, atomic, fail-closed.** The write sequence is
create-private → write → fsync → harden → verify → ``os.replace``. Hardening
happens on the temporary file *before* it is published, so the receipt is
never briefly published before its access policy is applied. On POSIX that is
``chmod 0600`` plus a verifying ``stat``. On Windows, where Hermes uses the
native per-user profile boundary rather than a Unix-mode equivalent,
``icacls`` removes inheritance and broad well-known principals and grants the
current user full control. A non-zero result removes the temporary file and
publishes nothing — fail-closed, not "best effort". This does not claim every
surviving Windows ACE was enumerated or that the DACL is literally owner-only.

**Atomic against corruption is not atomic against a second writer.** Rename
publication cannot decide which of two racing processes wins, and the
host-scoped receipt has genuinely concurrent writers: every gateway install on
the machine. Its *first claim* therefore goes through
:func:`claim_json_receipt` and ``O_CREAT | O_EXCL``, where the kernel picks the
winner; the loser re-reads and finds an owner. Later updates by that owner are
ordinary replaces, because by then the only question the file answers has
already been settled.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, Mapping, Optional, Tuple

APP_PRESENCE_FILENAME = "ocuclaw.app-presence.json"
FIRST_RUN_PROOF_FILENAME = "ocuclaw.first-run-proof.json"
GATEWAY_STATE_FILENAME = "gateway_state.json"
STATE_DIRNAME = "state"

APP_PRESENCE_SCHEMA_VERSION = 2
FIRST_RUN_PROOF_SCHEMA_VERSION = 1

RECEIPT_FILE_MODE = 0o600
RECEIPT_DIR_MODE = 0o700
_HARDEN_TIMEOUT_S = 5.0

# Broad Windows principals that would move a receipt outside Hermes's native
# per-user profile boundary. Named by SID because display names are localized.
#   S-1-1-0       Everyone
#   S-1-5-32-545  BUILTIN\Users
#   S-1-5-11      Authenticated Users
#   S-1-5-32-546  BUILTIN\Guests
_BROAD_WINDOWS_ACCESS_SIDS = (
    "S-1-1-0",
    "S-1-5-32-545",
    "S-1-5-11",
    "S-1-5-32-546",
)

IS_WINDOWS = os.name == "nt"

#: Allowlisted `observationErrorCode` values. The receipt never carries a
#: message, a path, or an exception — only one of these stable codes, so a
#: failing pull can be diagnosed without a leak surface.
PULL_ERROR_CODES = (
    "pull_timeout",
    "pull_failed",
    "pull_unsupported",
    "link_down",
    "shutdown",
)


class ReceiptUnavailableError(RuntimeError):
    """The receipt location could not be resolved or written."""


class ReceiptAlreadyClaimedError(ReceiptUnavailableError):
    """Another process created the receipt first.

    Raised only by an exclusive first claim. It is not an error condition so
    much as the answer to a question: somebody else won the race, so the
    caller must re-read and treat them as the owner.
    """


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fingerprint_home(home: Any) -> Optional[str]:
    """SHA-256 fingerprint of a canonical Hermes home (#1273 §1).

    The public snapshot names the profile by fingerprint, never by path: a
    raw path is a filesystem layout disclosure, while a fingerprint still
    answers the only question a diagnosis needs — "is this the same profile
    the receipt was written for?".
    """
    if home is None:
        return None
    try:
        canonical = os.path.realpath(str(Path(home)))
    except (OSError, ValueError):
        return None
    if not canonical:
        return None
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()


def resolve_receipt_home() -> Optional[Path]:
    """The exact profile home the platform's own state receipt resolves to.

    Mirrors ``gateway.status._get_pid_path()``, which uses the **process**
    home rather than the context-local override: the gateway writes
    ``gateway_state.json`` next to ``gateway.pid`` in that home, and the
    OcuClaw receipt must land in the same profile or the two records describe
    different machines. Returns ``None`` when Hermes is not importable or the
    home cannot be resolved — never a default-profile guess.
    """
    try:
        from hermes_constants import get_process_hermes_home

        home = get_process_hermes_home()
    except Exception:  # noqa: BLE001 — absent/older Hermes must fail closed
        return None
    try:
        resolved = Path(home)
    except (TypeError, ValueError):
        return None
    return resolved if str(resolved).strip() else None


def state_dir(home: Optional[Path] = None) -> Optional[Path]:
    resolved = home if home is not None else resolve_receipt_home()
    return None if resolved is None else resolved / STATE_DIRNAME


def app_presence_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return None if directory is None else directory / APP_PRESENCE_FILENAME


def first_run_proof_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return None if directory is None else directory / FIRST_RUN_PROOF_FILENAME


def gateway_state_path(home: Optional[Path] = None) -> Optional[Path]:
    """Hermes's platform receipt beside ``gateway.pid`` for this profile."""
    resolved = home if home is not None else resolve_receipt_home()
    return None if resolved is None else resolved / GATEWAY_STATE_FILENAME


# -- process identity ---------------------------------------------------------


def process_start_time(pid: int) -> Optional[int]:
    """The PID-reuse guard's other half, where the platform exposes one.

    Linux publishes a process's start time in ``/proc/<pid>/stat`` field 22
    (clock ticks since boot); a PID plus that value identifies a process
    across recycling. Where it is unavailable the guard degrades to a bare
    PID check — the same degradation Hermes's own reader documents, not a
    silently different rule.
    """
    try:
        with open(f"/proc/{int(pid)}/stat", "rb") as handle:
            data = handle.read()
    except (OSError, ValueError, TypeError):
        return None
    try:
        # comm may contain spaces and parentheses; fields are counted after
        # the final ')'.
        tail = data[data.rindex(b")") + 2 :].split()
        return int(tail[19])
    except (ValueError, IndexError):
        return None


#: No OS allocates PIDs above this; a receipt claiming one is malformed.
_MAX_PLAUSIBLE_PID = 2**31 - 1


def _pid_is_live(pid: Any) -> Optional[bool]:
    # The receipt is JSON from another process, so `pid` is whatever that
    # file says. `true` would convert to PID 1 and `1e999` decodes to
    # infinity, whose int() raises OverflowError — which would escape this
    # fail-soft reader and take the whole diagnostic down with it. Accept
    # only a plainly plausible integer.
    if isinstance(pid, bool) or not isinstance(pid, int):
        return None
    pid_int = pid
    if pid_int <= 0 or pid_int > _MAX_PLAUSIBLE_PID:
        return None
    if IS_WINDOWS:
        # No no-kill probe without pywin32; report unknown rather than a
        # guess, so a Windows reader falls back to the TTL alone.
        return None
    try:
        os.kill(pid_int, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, OverflowError, ValueError):
        return None
    return True


def writer_is_live(record: Mapping[str, Any]) -> Optional[bool]:
    """Validate a receipt's writer identity (PID + start time), tri-state."""
    if not isinstance(record, Mapping):
        return None
    alive = _pid_is_live(record.get("pid"))
    if alive is not True:
        return alive
    recorded = record.get("start_time")
    if isinstance(recorded, bool) or not isinstance(recorded, int):
        return True
    current = process_start_time(record["pid"])
    if current is None:
        return True
    return current == recorded


# -- platform access hardening -----------------------------------------------


def _harden_receipt_path(path: Path, *, is_dir: bool = False) -> None:
    """Enforce the platform's receipt boundary, or raise. Never best effort."""
    if IS_WINDOWS:  # pragma: no cover - exercised by the injected-failure test
        user = os.environ.get("USERNAME") or os.environ.get("USER")
        if not user:
            raise ReceiptUnavailableError("cannot resolve the owning Windows user")
        argv = ["icacls", str(path), "/inheritance:r"]
        # `/inheritance:r` drops INHERITED entries and `/grant:r` replaces the
        # grant for the named user only — neither touches an explicit ACE
        # belonging to somebody else. The profile `state` directory can
        # pre-exist, so an explicit Everyone/Users/Authenticated-Users grant
        # would otherwise survive and leave the receipt broadly readable or
        # replaceable. Remove those well-known principals by SID
        # (locale-independent; removing an absent one is a no-op that still
        # exits 0) before granting the current user.
        for sid in _BROAD_WINDOWS_ACCESS_SIDS:
            argv += ["/remove:g", f"*{sid}", "/remove:d", f"*{sid}"]
        argv += ["/grant:r", f"{user}:F"]
        # This matches Hermes's native per-user profile boundary rather than
        # promising a literal owner-only DACL. An explicit ACE for a non-broad
        # named principal can survive; fully enumerating and rewriting the ACL
        # is optional defense-in-depth tracked by #1367, not a beta invariant.
        try:
            completed = subprocess.run(
                argv,
                capture_output=True,
                timeout=_HARDEN_TIMEOUT_S,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ReceiptUnavailableError("icacls hardening failed") from exc
        if completed.returncode != 0:
            raise ReceiptUnavailableError(
                f"icacls hardening returned {completed.returncode}"
            )
        return
    try:
        os.chmod(path, RECEIPT_DIR_MODE if is_dir else RECEIPT_FILE_MODE)
        mode = os.stat(path).st_mode & 0o777
    except OSError as exc:
        raise ReceiptUnavailableError("receipt path could not be hardened") from exc
    if mode & 0o077:
        what = "directory" if is_dir else "receipt"
        raise ReceiptUnavailableError(
            f"{what} is group/world accessible (0o{mode:o})"
        )


def write_json_receipt(
    path: Path, body: Mapping[str, Any], *, durable: bool = False
) -> Path:
    """Atomic, platform-hardened, fail-closed JSON write.

    The temporary file is created in the destination directory (so
    ``os.replace`` stays a same-volume rename, which is atomic on POSIX and
    on Windows) and is hardened before publication, never after.
    """
    directory = path.parent
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ReceiptUnavailableError("receipt directory is unavailable") from exc
    # The directory is part of the integrity boundary, not just the file: a
    # principal who can create or delete entries in it can replace a
    # published receipt whatever DACL that receipt carries, and forge
    # connection-health evidence. Harden it on every platform.
    _harden_receipt_path(directory, is_dir=True)

    payload = json.dumps(dict(body), sort_keys=True, separators=(",", ":"))
    handle = None
    tmp_path: Optional[Path] = None
    try:
        fd, tmp_name = tempfile.mkstemp(
            prefix=path.name + ".", suffix=".tmp", dir=str(directory)
        )
        tmp_path = Path(tmp_name)
        handle = os.fdopen(fd, "w", encoding="utf-8")
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        handle = None
        _harden_receipt_path(tmp_path)
        os.replace(tmp_path, path)
        tmp_path = None
        if durable:
            _fsync_dir(directory)
    except ReceiptUnavailableError:
        raise
    except OSError as exc:
        raise ReceiptUnavailableError("receipt could not be written") from exc
    finally:
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass
        if tmp_path is not None:
            # Fail closed: a receipt that could not be hardened or published
            # leaves nothing behind.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return path


MANAGED_SERVE_ROUTE_LOCK_FILENAME = "ocuclaw.managed-serve-route.lock"
#: Serializes the First-Run Proof Attempt/proof transaction with every
#: receipt whose identity the Attempt binds.  Writers must take this sidecar
#: lock before replacing a bound receipt so validation and proof publication
#: are one ordered state transition rather than a check-then-write race.
FIRST_RUN_BINDING_LOCK_FILENAME = "ocuclaw.first-run-proof.lock"

#: How long a writer waits for the receipt lock before giving up. The critical
#: section is a small read, merge, and rename, so anything approaching this is
#: a wedged peer rather than contention.
_ROUTE_LOCK_TIMEOUT_S = 5.0


@contextlib.contextmanager
def receipt_state_lock(directory: Optional[Path], filename: str) -> Iterator[bool]:
    """Serialize a receipt state machine with an OS-lifetime sidecar lock."""

    if directory is None or not filename:
        yield False
        return
    try:
        directory.mkdir(parents=True, exist_ok=True)
        _harden_receipt_path(directory, is_dir=True)
        fd = os.open(
            directory / filename,
            os.O_CREAT | os.O_RDWR,
            RECEIPT_FILE_MODE,
        )
    except (OSError, ReceiptUnavailableError):
        yield False
        return

    acquired = False
    try:
        acquired = _acquire_exclusive(fd)
        yield acquired
    finally:
        if acquired:
            _release_exclusive(fd)
        try:
            os.close(fd)
        except OSError:
            pass


@contextlib.contextmanager
def route_receipt_lock(state_dir: Optional[Path] = None) -> Iterator[bool]:
    """Serialize the whole read-merge-write of the host ownership receipt.

    Merging alone narrows the window but cannot close it: two writers can
    still read the same receipt, each merge their own half, and each replace
    the other — losing `proposedAt`, and with it the teardown offer for a
    route the user really applied. Atomic *publication* cannot fix that,
    because the lost update happens before publication.

    An advisory kernel lock is used rather than a lock *file* protocol,
    precisely because it has no staleness problem: the kernel drops it when
    the holder exits, however it exits, so a crashed doctor run cannot wedge
    every later one. The lock lives on a sidecar rather than on the receipt
    itself, so it survives the receipt being replaced by rename.

    Yields whether the lock was actually acquired. **Callers must check it and
    abort**: continuing unserialized is the lost-update problem this exists to
    prevent, and a delayed holder resuming after an unprotected writer would
    replace that writer's update with stale state. Failing to record is
    recoverable — the next run tries again; silently losing the proposal is
    not.
    """
    directory = host_state_dir() if state_dir is None else state_dir
    if directory is None:
        yield False
        return
    try:
        directory.mkdir(parents=True, exist_ok=True)
        _harden_receipt_path(directory, is_dir=True)
        fd = os.open(
            directory / MANAGED_SERVE_ROUTE_LOCK_FILENAME,
            os.O_CREAT | os.O_RDWR,
            RECEIPT_FILE_MODE,
        )
    except (OSError, ReceiptUnavailableError):
        yield False
        return

    acquired = False
    try:
        acquired = _acquire_exclusive(fd)
        yield acquired
    finally:
        if acquired:
            _release_exclusive(fd)
        try:
            os.close(fd)
        except OSError:
            pass


def _acquire_exclusive(fd: int) -> bool:
    deadline = time.monotonic() + _ROUTE_LOCK_TIMEOUT_S
    if IS_WINDOWS:
        try:
            import msvcrt
        except ImportError:  # pragma: no cover - Windows only
            return False
        while time.monotonic() < deadline:
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                return True
            except OSError:
                time.sleep(0.02)
        return False
    try:
        import fcntl
    except ImportError:  # pragma: no cover - POSIX only
        return False
    while time.monotonic() < deadline:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            time.sleep(0.02)
    return False


def _release_exclusive(fd: int) -> None:
    try:
        if IS_WINDOWS:  # pragma: no cover - Windows only
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_UN)
    except (OSError, ImportError):
        pass


def _fsync_dir(directory: Path) -> None:
    """Make a publication survive a crash, not just reach the page cache.

    ``fsync`` on the file persists its contents; the *directory entry* that
    makes it findable is separate metadata. Without this, a receipt can be
    reported written and then be missing after power loss — and losing this
    particular file loses the proposal evidence that permits teardown, which
    is the one thing here that cannot be re-derived by looking at the host.
    """
    if IS_WINDOWS:
        # No directory handle to fsync; NTFS metadata ordering covers it.
        return
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


#: Fields that only ever become known. Once the host has recorded one, a later
#: write must not erase it — see :func:`merge_managed_serve_route`.
_MONOTONIC_ROUTE_FIELDS = ("proposedAt", "firstObservedAt")


def _describes_one_route(
    previous: Mapping[str, Any], incoming: Mapping[str, Any]
) -> bool:
    """Whether two receipt bodies are about the same route on the same node.

    A previous body with no observed target is still the same route: that is
    the ordinary proposal-then-observation transition, where the observation
    is what fills the target in.
    """
    for field in ("servePort", "nodeIdentityFingerprint", "owningGatewayFingerprint"):
        if previous.get(field) != incoming.get(field):
            return False
    previous_target = previous.get("observedTarget")
    if previous_target is not None and previous_target != incoming.get("observedTarget"):
        return False
    # A proposal carries no observed target, so the command it proposed is
    # what identifies which route it was about: a proposal for one relay port
    # must not be inherited by an observation of a different one.
    previous_command = previous.get("proposedCommand")
    if previous_command is not None and previous_command != incoming.get(
        "proposedCommand"
    ):
        return False
    return True


def merge_managed_serve_route(
    previous: Optional[Mapping[str, Any]], incoming: Mapping[str, Any]
) -> Dict[str, Any]:
    """Fold an update into what is already on disk, losing nothing established.

    Updates after the first claim are read-modify-write, and two doctor runs
    of the same install can interleave: one recording a proposal, the other
    recording an observation. Whichever wrote last would otherwise drop the
    other's field — and if the observation won, the proposal evidence would be
    gone for good and the teardown offer could never appear for a route the
    user really did apply.

    So the fields that only ever become known are merged rather than
    overwritten, and the ownership basis is recomputed from the merged result
    instead of being carried from either side.

    Merging is confined to one route. Evidence is about a specific command on
    a specific node, and preserving it across a changed relay port, node
    identity, or owner would resurrect exactly the transfer the recording path
    refuses — a route nobody proposed inheriting a proposal, and with it the
    teardown offer.
    """
    merged = dict(incoming)
    if isinstance(previous, Mapping) and _describes_one_route(previous, incoming):
        for field in _MONOTONIC_ROUTE_FIELDS:
            if not merged.get(field) and previous.get(field):
                merged[field] = previous[field]
        # The profile set is a union for the same reason: two profiles behind
        # one route may each be recorded by a different run.
        names = set()
        for source in (previous.get("configuredProfiles"), merged.get("configuredProfiles")):
            if isinstance(source, list):
                names.update(str(name) for name in source if name)
        merged["configuredProfiles"] = sorted(names)
    merged["ownershipBasis"] = (
        OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED
        if merged.get("proposedAt")
        else OWNERSHIP_BASIS_OBSERVED_SHAPE_MATCH
    )
    return merged


def claim_json_receipt(path: Path, body: Mapping[str, Any]) -> Path:
    """Create a receipt that must not already exist, atomically.

    The ordinary write is create-temp → publish by rename, which is atomic
    against corruption but **not** against a second writer: two processes can
    each find no receipt, each build one, and each replace the other's. For a
    file whose whole purpose is to record which install got there first, that
    is the one race that matters — the loser would overwrite the winner's
    claim and later be offered the winner's teardown command.

    So a first claim is written to a private temporary file, fsynced and
    hardened, and only then published by a link (or, on Windows, a rename)
    that fails rather than replacing an existing receipt. The kernel decides
    the winner, and what appears at the real path is always complete: a crash
    mid-claim can never leave a stub that every later install would read as an
    undisplaceable claim.
    """
    directory = path.parent
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ReceiptUnavailableError("receipt directory is unavailable") from exc
    _harden_receipt_path(directory, is_dir=True)

    payload = json.dumps(dict(body), sort_keys=True, separators=(",", ":"))
    handle = None
    tmp_path: Optional[Path] = None
    try:
        fd, tmp_name = tempfile.mkstemp(
            prefix=path.name + ".claim.", suffix=".tmp", dir=str(directory)
        )
        tmp_path = Path(tmp_name)
        handle = os.fdopen(fd, "w", encoding="utf-8")
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        handle = None
        _harden_receipt_path(tmp_path)

        # Publish exclusively. The content is already complete and durable, so
        # a crash can never leave a half-written receipt at the real path —
        # which matters more here than anywhere else in this module, because
        # every later install would read that stub as a claim it must not
        # displace and would be blocked until somebody deleted the file by
        # hand.
        #
        # `link` fails with EEXIST rather than replacing, which is the
        # exclusivity `os.replace` cannot give. Windows has no dependable
        # hardlink, but its `rename` already refuses an existing destination,
        # so the same guarantee is reached by the platform's own rule.
        try:
            if IS_WINDOWS:
                os.rename(tmp_path, path)
            else:
                os.link(tmp_path, path)
        except FileExistsError as exc:
            raise ReceiptAlreadyClaimedError("receipt already exists") from exc
        if not IS_WINDOWS:
            os.unlink(tmp_path)
        tmp_path = None
        _fsync_dir(directory)
    except (ReceiptAlreadyClaimedError, ReceiptUnavailableError):
        raise
    except OSError as exc:
        raise ReceiptUnavailableError("receipt could not be claimed") from exc
    finally:
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass
        if tmp_path is not None:
            # Fail closed: a claim that could not be published leaves nothing
            # behind for another process to inherit.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return path


def _read_json(path: Optional[Path]) -> Tuple[Optional[Dict[str, Any]], str]:
    if path is None:
        return None, "missing"
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, "missing"
    except (OSError, UnicodeError):
        # UnicodeDecodeError is a ValueError, not an OSError: a corrupted or
        # mis-encoded receipt would otherwise escape this reader and take
        # the whole diagnostic down with it — turning "one bad file" into
        # "diagnosis is unavailable", which is the worst moment for it.
        return None, "unreadable"
    try:
        record = json.loads(raw)
    except ValueError:
        return None, "unreadable"
    if not isinstance(record, dict):
        return None, "unreadable"
    return record, "ok"


def read_gateway_state(
    *, home: Optional[Path] = None
) -> Tuple[Optional[Dict[str, Any]], str, Optional[bool]]:
    """Read Hermes's own profile receipt and qualify its writer identity.

    This is the shared, receipt-only gateway reader for the snapshot collector
    and dashboard backend.  It deliberately applies no timestamp TTL: Snapshot
    v1 says an adapter transition does not expire while the same gateway
    process remains independently live.  A presenter-specific empirical age
    check may inspect ``updated_at`` without changing that canonical truth.
    """
    record, status = _read_json(gateway_state_path(home))
    if status != "ok" or record is None:
        return None, status, None
    try:
        from gateway.status import runtime_status_pid_is_live

        live: Optional[bool] = bool(runtime_status_pid_is_live(record))
    except Exception:  # noqa: BLE001 - cross-process evidence is fail-soft
        live = None
    return record, "ok", live


def _qualify(
    record: Optional[Dict[str, Any]],
    status: str,
    expected_fingerprint: Optional[str],
    expected_schema: int,
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Exact-profile and schema qualification, shared by both readers.

    Foreign-profile or unsupported-schema evidence is *rejected*, never
    silently substituted for this profile's truth (#1273 §4).
    """
    if status != "ok" or record is None:
        return None, status
    version = record.get("schemaVersion")
    if version != expected_schema:
        return None, "unsupported_schema"
    fingerprint = record.get("profileFingerprint")
    if expected_fingerprint is None or not isinstance(fingerprint, str):
        return None, "wrong_profile"
    if fingerprint != expected_fingerprint:
        return None, "wrong_profile"
    return record, "ok"


# -- app-presence receipt -----------------------------------------------------


def build_app_presence_body(
    *,
    profile_fingerprint: Optional[str],
    epoch: Optional[int],
    relay_listening: Optional[bool],
    authenticated_app_count: Optional[int],
    client_versions: Any,
    last_transition_at: Optional[str],
    observation_error_code: Optional[str],
    device: Any = None,
    pid: Optional[int] = None,
    start_time: Optional[int] = None,
    updated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """The exact v2 body: app presence plus bounded G2 device truth.

    There is deliberately no ``appConnected`` field: ``authenticatedAppCount
    > 0`` already derives phone health, and a second field for the same fact
    is a second way for the two to disagree.
    """
    resolved_pid = os.getpid() if pid is None else int(pid)
    versions = []
    if isinstance(client_versions, (list, tuple)):
        versions = [str(item) for item in client_versions if isinstance(item, str)]
    device_body = {
        "connected": None,
        "batteryPercent": None,
        "charging": None,
        "inCase": None,
        "observedAt": None,
    }
    if isinstance(device, Mapping):
        for key in device_body:
            device_body[key] = device.get(key)
    return {
        "schemaVersion": APP_PRESENCE_SCHEMA_VERSION,
        "profileFingerprint": profile_fingerprint,
        "pid": resolved_pid,
        "start_time": (
            process_start_time(resolved_pid) if start_time is None else start_time
        ),
        "epoch": epoch,
        "updated_at": updated_at or now_iso(),
        "relayListening": relay_listening,
        "authenticatedAppCount": authenticated_app_count,
        "clientVersions": versions,
        "lastTransitionAt": last_transition_at,
        "device": device_body,
        "observationErrorCode": observation_error_code,
    }


def write_app_presence(
    body: Mapping[str, Any], *, home: Optional[Path] = None
) -> Path:
    path = app_presence_path(home)
    if path is None:
        raise ReceiptUnavailableError("no profile-scoped Hermes home resolved")
    return write_json_receipt(path, body)


def read_app_presence(
    expected_fingerprint: Optional[str], *, home: Optional[Path] = None
) -> Tuple[Optional[Dict[str, Any]], str, Optional[bool]]:
    """Read + qualify the presence receipt. Returns (record, status, writerLive)."""
    record, status = _read_json(app_presence_path(home))
    record, status = _qualify(
        record, status, expected_fingerprint, APP_PRESENCE_SCHEMA_VERSION
    )
    return record, status, (writer_is_live(record) if record is not None else None)


# -- first-run proof receipt --------------------------------------------------


def read_first_run_proof(
    expected_fingerprint: Optional[str], *, home: Optional[Path] = None
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Read + qualify the durable proof record.

    v1 only reads it. The write mechanism — wearer confirmation arming the
    proof and the welcome-surface dismissal committing it — belongs to the
    completion journey (#1322 / #1268); this module must not add a generic
    proof-write API, and nothing here may infer proof from connection state.
    """
    record, status = _read_json(first_run_proof_path(home))
    return _qualify(
        record, status, expected_fingerprint, FIRST_RUN_PROOF_SCHEMA_VERSION
    )


# -- Managed Serve Route receipt (#1319, ruling #1269) ------------------------
#
# The ownership receipt for the one Tailscale Serve route OcuClaw proposed and
# then observed the user apply. Three properties define it, and each one is a
# rule rather than a preference:
#
# **One receipt per machine, because it describes one machine's route.**
# Tailscale Serve is host-global, so the receipt lives in host-scoped shared
# state rather than inside any one gateway's profile home (owner ruling
# 2026-08-17, #1373). #1269's "alongside the gateway receipt" is read as
# equally *discoverable*, not same-directory — a receipt that described a
# host-wide route but sat in one profile's state could never be found by the
# install that needed it.
#
# **No 'one route implies one profile' anywhere** (owner ruling 2, #1373).
# Inbuilt Hermes profiles multiplex INSIDE one gateway behind this single
# route, so several profiles sharing it is the normal case, not a conflict.
# `configuredProfiles` is therefore a multi-valued record kept for diagnosis
# and never a gate: nothing may refuse an action because the list has more
# than one entry. The "exact-profile" language elsewhere in this module refers
# to HERMES_HOME resolution of the *owning gateway*, which is unchanged.
#
# What can genuinely collide is a second **gateway install** on the same host.
# The route can front only one of them, so the receipt records which gateway
# owns it (`owningGatewayFingerprint`), and a sibling install gets honest
# diagnosis and no replacement command.
#
# **Evidence of ownership, never authority to mutate.** It records what
# OcuClaw proposed and what doctor then actually saw live. It does not
# authorise anything by itself; teardown guidance is permitted only while the
# receipt and the live route still agree on port, protocol, and target, and a
# foreign, changed, or ambiguous route fails closed (CONTEXT.md glossary).
#
# **Secret-free, including of node identity.** The route's TLS identity is
# this host's tailnet DNS name, and tailnet/node names are excluded from every
# rendered and stored surface alongside secrets (#1273 §1; threat statement
# rule 2). So the receipt stores a *fingerprint* of that identity, not the
# name: it can still prove "the live route terminates TLS for the same node it
# did when we observed it" without the file ever carrying the name itself.

MANAGED_SERVE_ROUTE_FILENAME = "ocuclaw.managed-serve-route.json"
MANAGED_SERVE_ROUTE_SCHEMA_VERSION = 1

#: The protocol OcuClaw's route speaks. Recorded so a future route class
#: cannot silently inherit an older receipt's ownership claim.
SERVE_PROTOCOL_TLS_TERMINATED_TCP = "tls-terminated-tcp"

#: OcuClaw printed the apply command for this host, and then observed a
#: matching route. This is the basis the glossary's "proposed and then
#: observed" describes, and the only one that may authorise teardown.
OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED = "proposed-then-observed"

#: A matching route was observed, but this host has no record of OcuClaw ever
#: having proposed one — the route may predate OcuClaw entirely. Enough to
#: report the route as ready; never enough to offer to remove it.
OWNERSHIP_BASIS_OBSERVED_SHAPE_MATCH = "observed-shape-match"


#: The host-wide OcuClaw state root, matching the convention the repo's
#: host-wide locks already use (`~/.evenclaw/`, with `locks/` as its ephemeral
#: sibling — see `tools/lib/runtime-lock.js`).
#:
#: **Scope, stated precisely: one receipt per machine _per OS account._** This
#: resolves under the user's home, exactly as the repo's host-wide locks do
#: (`$XDG_RUNTIME_DIR` is itself per-user and mode 0700). Two gateway installs
#: running as different OS users therefore hold separate receipts and cannot
#: see each other's claim.
#:
#: That boundary is deliberate rather than overlooked. Genuinely machine-wide
#: storage would need a system location, elevated privileges to create it, and
#: an access-control protocol deciding which accounts may read and displace
#: another account's claim — a new privilege chain, and one the lock lane
#: beside it does not have either. The supported configuration is therefore a
#: single OS account per host, which is what the beta ships; cross-account
#: coordination is out of scope for this receipt and must not be inferred
#: from the word "host".
#:
#: Deliberately **not** `$XDG_RUNTIME_DIR`, which the lock lane prefers. That
#: directory is cleared on logout and reboot, and the locks want exactly that.
#: This receipt is durable evidence: losing it loses the proposal that permits
#: teardown, so a user who reboots would silently stop being offered the
#: removal step for a route OcuClaw genuinely owns.
EVENCLAW_HOST_DIRNAME = ".evenclaw"
HOST_STATE_DIRNAME = "state"


def host_state_dir() -> Optional[Path]:
    """The host-scoped directory shared by every gateway install on this box.

    Returns ``None`` only when no home can be resolved at all, which the
    callers treat as "no receipt" rather than guessing a location.
    """
    if IS_WINDOWS:
        base = os.environ.get("LOCALAPPDATA")
        if base and base.strip():
            try:
                return Path(base) / "evenclaw" / HOST_STATE_DIRNAME
            except (TypeError, ValueError):  # pragma: no cover - defensive
                return None
    try:
        home = Path.home()
    except (OSError, RuntimeError):  # pragma: no cover - no resolvable home
        return None
    return home / EVENCLAW_HOST_DIRNAME / HOST_STATE_DIRNAME


def managed_serve_route_path(state_dir: Optional[Path] = None) -> Optional[Path]:
    """Where this machine's one Managed Serve Route receipt lives.

    ``state_dir`` overrides the host location; production passes nothing.
    """
    directory = host_state_dir() if state_dir is None else state_dir
    return None if directory is None else directory / MANAGED_SERVE_ROUTE_FILENAME


def fingerprint_node_identity(dns_name: Any) -> Optional[str]:
    """A stable, non-reversing fingerprint of a tailnet node name.

    Same construction as :func:`fingerprint_home`, for the same reason: the
    receipt needs to compare identities across runs without storing one.
    """
    if not isinstance(dns_name, str) or not dns_name.strip():
        return None
    return hashlib.sha256(dns_name.strip().rstrip(".").encode("utf-8")).hexdigest()


def build_managed_serve_route_body(
    *,
    servePort: int,
    relay_port: Optional[int],
    node_identity_fingerprint: Optional[str],
    configured_profiles: Any,
    owning_gateway_fingerprint: Optional[str] = None,
    proposed_command: Optional[str],
    teardown_command: str,
    observed_at: Optional[str] = None,
    first_observed_at: Optional[str] = None,
    proposed_at: Optional[str] = None,
) -> Dict[str, Any]:
    """The v1 body: the route proposed, and the route then observed.

    ``proposedCommand`` is the exact command OcuClaw printed; ``observed*``
    is what doctor actually saw live afterwards. Keeping both is the whole
    point of the receipt — ownership is the claim that these two agree, and a
    receipt that recorded only one of them could not support it.

    ``firstObservedAt`` is carried forward across re-observations, so a
    re-confirmed route keeps the moment ownership was established rather than
    looking newly adopted on every doctor run.
    """
    profiles = []
    if isinstance(configured_profiles, (list, tuple, set)):
        profiles = sorted({str(name) for name in configured_profiles if name})
    # The receipt is written only when doctor has just observed the route, so
    # `updated_at` IS the observation time. A second field carrying the same
    # instant would be a second thing to keep in step for no gain.
    stamp = observed_at or now_iso()
    # A proposal-only record has observed no route, so it has no first
    # observation. Stamping one anyway would let a receipt that describes a
    # route nobody has seen claim to have seen it, and that false timestamp
    # would then be preserved through the real observation that follows.
    observed_a_route = relay_port is not None
    if observed_a_route:
        first_observed = first_observed_at or stamp
    else:
        first_observed = None
    return {
        "schemaVersion": MANAGED_SERVE_ROUTE_SCHEMA_VERSION,
        "updated_at": stamp,
        "firstObservedAt": first_observed,
        "servePort": int(servePort),
        "protocol": SERVE_PROTOCOL_TLS_TERMINATED_TCP,
        "observedTarget": (
            None if relay_port is None else f"127.0.0.1:{int(relay_port)}"
        ),
        "nodeIdentityFingerprint": node_identity_fingerprint,
        # Which gateway install owns the route. The route can front only one
        # of them, so a sibling install compares this against its own home
        # fingerprint to learn that the port is already spoken for.
        "owningGatewayFingerprint": owning_gateway_fingerprint,
        # Multi-valued by design and never a gate (owner ruling 2, #1373):
        # Hermes profiles multiplex inside the owning gateway behind this one
        # route, so more than one entry here is ordinary, not a conflict.
        "configuredProfiles": profiles,
        "proposedCommand": proposed_command,
        "teardownCommand": teardown_command,
        # When OcuClaw actually printed the apply command on this host, and
        # therefore whether the route it later observed can be said to be one
        # it proposed. `None` means no proposal was ever recorded here: the
        # matching route may predate OcuClaw entirely.
        "proposedAt": proposed_at,
        # What this receipt's ownership claim rests on, stated rather than
        # implied. Recognising a route by shape cannot distinguish "the user
        # ran our command" from "the user already had an identical route", so
        # only a receipt carrying proposal evidence claims the stronger basis
        # — and only that basis may authorise teardown.
        "ownershipBasis": (
            OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED
            if proposed_at
            else OWNERSHIP_BASIS_OBSERVED_SHAPE_MATCH
        ),
    }


def write_managed_serve_route(
    body: Mapping[str, Any],
    *,
    state_dir: Optional[Path] = None,
    claim: bool = False,
) -> Path:
    """Write the host receipt.

    ``claim=True`` takes it as a first claim: the write fails with
    :class:`ReceiptAlreadyClaimedError` if another install got there first,
    instead of replacing their receipt.
    """
    path = managed_serve_route_path(state_dir)
    if path is None:
        raise ReceiptUnavailableError("no host state directory resolved")
    if claim:
        return claim_json_receipt(path, body)
    # Durable: this receipt carries evidence that cannot be re-derived by
    # looking at the host, unlike the profile receipts beside it.
    return write_json_receipt(path, body, durable=True)


def read_managed_serve_route(
    *, state_dir: Optional[Path] = None
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Read this machine's ownership receipt.

    Deliberately **not** profile-qualified: the route is host-global, so a
    receipt written by another profile — or by another gateway install — is
    still this host's route receipt, and reading it is how a sibling install
    discovers that the route is already owned. Schema qualification still
    applies: an unsupported schema is rejected rather than partly interpreted.
    """
    record, status = _read_json(managed_serve_route_path(state_dir))
    if status != "ok" or record is None:
        return None, status
    if record.get("schemaVersion") != MANAGED_SERVE_ROUTE_SCHEMA_VERSION:
        return None, "unsupported_schema"
    return record, "ok"


def route_receipt_agrees(
    record: Optional[Mapping[str, Any]],
    *,
    servePort: int,
    relay_port: Optional[int],
    node_identity_fingerprint: Optional[str],
) -> bool:
    """Whether the receipt and the live route still describe the same route.

    The gate on printing teardown guidance. Fails closed on every ambiguity:
    no receipt, an unreadable one, a different port, protocol, target, or node
    identity, or a live route we could not fully identify. OcuClaw offers to
    remove only a route it can still prove it owns.
    """
    if not isinstance(record, Mapping):
        return False
    if relay_port is None or node_identity_fingerprint is None:
        return False
    if record.get("protocol") != SERVE_PROTOCOL_TLS_TERMINATED_TCP:
        return False
    if record.get("servePort") != int(servePort):
        return False
    if record.get("observedTarget") != f"127.0.0.1:{int(relay_port)}":
        return False
    if record.get("nodeIdentityFingerprint") != node_identity_fingerprint:
        return False
    return True


__all__ = [
    "APP_PRESENCE_FILENAME",
    "MANAGED_SERVE_ROUTE_FILENAME",
    "MANAGED_SERVE_ROUTE_SCHEMA_VERSION",
    "SERVE_PROTOCOL_TLS_TERMINATED_TCP",
    "build_managed_serve_route_body",
    "fingerprint_node_identity",
    "host_state_dir",
    "OWNERSHIP_BASIS_OBSERVED_SHAPE_MATCH",
    "OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED",
    "managed_serve_route_path",
    "route_receipt_lock",
    "FIRST_RUN_BINDING_LOCK_FILENAME",
    "merge_managed_serve_route",
    "read_managed_serve_route",
    "route_receipt_agrees",
    "write_managed_serve_route",
    "APP_PRESENCE_SCHEMA_VERSION",
    "FIRST_RUN_PROOF_FILENAME",
    "FIRST_RUN_PROOF_SCHEMA_VERSION",
    "GATEWAY_STATE_FILENAME",
    "PULL_ERROR_CODES",
    "ReceiptAlreadyClaimedError",
    "ReceiptUnavailableError",
    "claim_json_receipt",
    "app_presence_path",
    "build_app_presence_body",
    "fingerprint_home",
    "first_run_proof_path",
    "gateway_state_path",
    "process_start_time",
    "read_app_presence",
    "read_first_run_proof",
    "read_gateway_state",
    "resolve_receipt_home",
    "state_dir",
    "write_app_presence",
    "write_json_receipt",
    "writer_is_live",
]
