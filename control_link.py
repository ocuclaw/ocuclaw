"""NDJSON-over-stdio control link, Python parent side (ADR-0003).

The OcuClaw platform adapter spawns the Node runtime as a child process and
speaks newline-delimited JSON over its stdin/stdout. The child's stdout is
protocol-owned; its stderr is pumped into the gateway log. Pipe EOF / process
exit is the death signal. Frames are size-capped single lines — an oversize
frame is replaced by an explicit truncation marker, never split.

This module is stdlib-only (no hermes imports) so the framing and process
tests run outside a hermes environment. The Node mirror of these constants
lives in ``extensions/ocuclaw/src/runtime/hermes-control-link.ts``; the
normative values are pinned in ``PROTOCOL.md`` and asserted by both test
suites.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

LINK_PROTOCOL_VERSION = 1
LINK_MAX_LINE_BYTES = 1_048_576
LINK_TRUNCATION_HEAD_CHARS = 2_048
LINK_HANDSHAKE_TIMEOUT_S = 10.0
LINK_TERMINATE_GRACE_S = 5.0
LINK_DEBUG_CATEGORY = "hermes.link"

FRAME_HELLO = "link.hello"
FRAME_HELLO_ACK = "link.hello.ack"
FRAME_RPC_REQUEST = "link.rpc.request"
FRAME_RPC_RESPONSE = "link.rpc.response"

RPC_METHOD_NOT_FOUND_CODE = -32601

# Child exit codes (mirrors LINK_EXIT_CODES in the Node module).
EXIT_CLEAN = 0
EXIT_FATAL = 1
EXIT_HANDSHAKE_TIMEOUT = 3
EXIT_PROTOCOL_MISMATCH = 4
EXIT_BIND_FAILURE = 98

# Default relay WS port for the Hermes bundle — deliberately distinct from
# the OpenClaw bundle so a dual-install works on one machine (spec
# §Bundles; runtime-config.ts HERMES_BUNDLE_DEFAULT_WS_PORT is the Node-side
# mirror). The Even-AI endpoint rides the relay's shared HTTP server, so one
# bind+port pair covers both listeners.
HERMES_BUNDLE_DEFAULT_WS_PORT = 47801
HERMES_BUNDLE_DEFAULT_WS_BIND = "127.0.0.1"


class LinkError(Exception):
    """Base error for control-link failures."""


class LinkHandshakeError(LinkError):
    """Handshake failed (timeout, version mismatch, or early death)."""


class LinkClosedError(LinkError):
    """Operation attempted on a closed/dead link."""


class LinkRpcError(LinkError):
    """Peer answered an RPC with ok=false."""

    def __init__(self, code: Optional[int], message: str) -> None:
        super().__init__(message)
        self.code = code


def encode_link_frame(frame: Dict[str, Any]) -> Tuple[bytes, bool]:
    """Serialize a frame to one NDJSON line, applying the truncation rule.

    Returns ``(line_bytes, truncated)``. A frame whose serialized form
    exceeds ``LINK_MAX_LINE_BYTES`` is replaced by a marker frame that keeps
    the routing fields (``v``/``type``/``id``/``method``/``ok``), sets
    ``truncated``/``originalBytes``, and carries the head of the original
    serialization — the frame is never split across lines. The flag comes
    from the encoder (never inferred from the serialized bytes: payload data
    may legitimately contain a nested ``"truncated": true``).
    """
    line = json.dumps(frame, separators=(",", ":"), ensure_ascii=False)
    raw = line.encode("utf-8")
    if len(raw) <= LINK_MAX_LINE_BYTES:
        return raw + b"\n", False
    marker: Dict[str, Any] = {"v": frame.get("v"), "type": frame.get("type")}
    if "id" in frame:
        marker["id"] = frame["id"]
    if "method" in frame:
        marker["method"] = frame["method"]
    if "ok" in frame:
        marker["ok"] = frame["ok"]
    marker["truncated"] = True
    marker["originalBytes"] = len(raw)
    marker["payloadHead"] = line[:LINK_TRUNCATION_HEAD_CHARS]
    marker_raw = json.dumps(marker, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )
    return marker_raw + b"\n", True


class NdjsonLineSplitter:
    """Incremental NDJSON splitter with a hard per-line byte cap.

    A line that exceeds the cap before its newline arrives is dropped in full
    (the reader skips to the next newline) — the peer violated the
    sender-side truncation rule, so the frame is unusable anyway.
    """

    def __init__(
        self,
        on_line: Callable[[bytes], None],
        on_oversize: Optional[Callable[[int], None]] = None,
        max_line_bytes: int = LINK_MAX_LINE_BYTES,
    ) -> None:
        self._on_line = on_line
        self._on_oversize = on_oversize or (lambda _bytes: None)
        self._max = max_line_bytes
        self._pending = b""
        self._discarding = 0

    def feed(self, chunk: bytes) -> None:
        self._pending += chunk
        while True:
            nl = self._pending.find(b"\n")
            if nl == -1:
                if self._discarding:
                    self._discarding += len(self._pending)
                    self._pending = b""
                elif len(self._pending) > self._max:
                    self._discarding = len(self._pending)
                    self._pending = b""
                return
            line = self._pending[:nl]
            self._pending = self._pending[nl + 1 :]
            if self._discarding:
                self._on_oversize(self._discarding + len(line))
                self._discarding = 0
                continue
            if len(line) > self._max:
                self._on_oversize(len(line))
                continue
            if not line:
                continue
            self._on_line(line)


def resolve_runtime_argv(
    runtime_command: Any,
    default_argv: List[str],
) -> List[str]:
    """Resolve the child argv: ``runtimeCommand`` override or the default.

    The pinned config key is ``platforms.ocuclaw.extra.runtimeCommand``
    (D11): a list of argv strings, or a single string that is shlex-split.
    """
    if runtime_command is None or runtime_command == "" or runtime_command == []:
        return list(default_argv)
    if isinstance(runtime_command, str):
        return shlex.split(runtime_command)
    if isinstance(runtime_command, (list, tuple)):
        return [str(part) for part in runtime_command]
    raise ValueError(
        "runtimeCommand must be an argv list or a command string, got "
        f"{type(runtime_command).__name__}"
    )


class LinkProcess:
    """Owns one spawned Node runtime child and its control link."""

    def __init__(
        self,
        argv: List[str],
        *,
        hello_ack_payload: Optional[Dict[str, Any]] = None,
        handshake_timeout_s: float = LINK_HANDSHAKE_TIMEOUT_S,
        terminate_grace_s: float = LINK_TERMINATE_GRACE_S,
        env: Optional[Dict[str, str]] = None,
        cwd: Optional[str] = None,
        log: Optional[logging.Logger] = None,
        on_exit: Optional[Callable[[Optional[int]], None]] = None,
    ) -> None:
        self._argv = list(argv)
        self._hello_ack_payload = hello_ack_payload or {}
        self._handshake_timeout_s = handshake_timeout_s
        self._terminate_grace_s = terminate_grace_s
        self._env = env
        self._cwd = cwd
        self._log = log or logger
        self._on_exit = on_exit

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._hello_payload: Optional[Dict[str, Any]] = None
        self._hello_event: Optional[asyncio.Event] = None
        self._handshake_error: Optional[LinkError] = None
        self._ready = False
        self._closed = False
        self._next_request_id = 1
        self._pending: Dict[str, asyncio.Future] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._request_handlers: Dict[str, Callable[[Any], Awaitable[Any]]] = {}
        self.counters = {
            "frames_in": 0,
            "frames_out": 0,
            "truncated_outbound": 0,
            "oversized_inbound": 0,
            "protocol_errors": 0,
        }

    @property
    def ready(self) -> bool:
        return self._ready and not self._closed and self.is_alive()

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def pid(self) -> Optional[int]:
        return self._proc.pid if self._proc else None

    @property
    def returncode(self) -> Optional[int]:
        return self._proc.returncode if self._proc else None

    def register_request_handler(
        self, method: str, handler: Callable[[Any], Awaitable[Any]]
    ) -> None:
        """Handler for child-initiated RPCs (later work items' lanes)."""
        self._request_handlers[method] = handler

    async def start(self) -> Dict[str, Any]:
        """Spawn the child, complete the handshake, return the hello payload."""
        if self._proc is not None:
            raise LinkError("LinkProcess.start() called twice")
        self._hello_event = asyncio.Event()
        self._proc = await asyncio.create_subprocess_exec(
            *self._argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._env,
            cwd=self._cwd,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._pump_stderr())
        try:
            await asyncio.wait_for(
                self._hello_event.wait(), timeout=self._handshake_timeout_s
            )
        except asyncio.TimeoutError:
            await self.terminate()
            raise LinkHandshakeError(
                f"child sent no {FRAME_HELLO} within {self._handshake_timeout_s}s"
            ) from None
        if self._handshake_error is not None:
            err = self._handshake_error
            await self.terminate()
            raise err
        self._send_frame(
            {
                "v": LINK_PROTOCOL_VERSION,
                "type": FRAME_HELLO_ACK,
                "payload": dict(self._hello_ack_payload),
            }
        )
        self._ready = True
        return self._hello_payload or {}

    async def request(
        self, method: str, params: Any = None, *, timeout_s: float = 30.0
    ) -> Any:
        if not self.ready:
            raise LinkClosedError("control link not ready")
        request_id = f"p{self._next_request_id}"
        self._next_request_id += 1
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        frame: Dict[str, Any] = {
            "v": LINK_PROTOCOL_VERSION,
            "type": FRAME_RPC_REQUEST,
            "id": request_id,
            "method": method,
        }
        if params is not None:
            frame["params"] = params
        delivered = self._send_frame(frame)
        if not delivered:
            self._pending.pop(request_id, None)
            raise LinkRpcError(None, "link_frame_truncated")
        try:
            return await asyncio.wait_for(future, timeout=timeout_s)
        finally:
            self._pending.pop(request_id, None)

    async def terminate(self) -> Optional[int]:
        """Bounded teardown: SIGTERM, wait the grace period, then SIGKILL.

        The grace period stays well inside the gateway's own teardown bound
        (configurable there; an operator setting that bound ≤0 disables it —
        this per-child grace still applies).
        """
        proc = self._proc
        if proc is None:
            return None
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=self._terminate_grace_s)
            except asyncio.TimeoutError:
                self._log.warning(
                    "[ocuclaw] runtime child ignored SIGTERM for %.1fs; killing",
                    self._terminate_grace_s,
                )
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
        self._finish(proc.returncode)
        for task in (self._reader_task, self._stderr_task):
            if task is not None:
                task.cancel()
        return proc.returncode

    # -- internals -----------------------------------------------------------

    def _send_frame(self, frame: Dict[str, Any]) -> bool:
        """Write a frame; returns False when the truncation rule replaced it
        with a marker (the peer sees an explicit marker, never a split)."""
        proc = self._proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise LinkClosedError("control link closed")
        raw, truncated = encode_link_frame(frame)
        if truncated:
            self.counters["truncated_outbound"] += 1
            self._log.warning(
                "[ocuclaw] outbound %s frame truncated (cap %d bytes)",
                frame.get("type"),
                LINK_MAX_LINE_BYTES,
            )
        self.counters["frames_out"] += 1
        proc.stdin.write(raw)
        return not truncated

    async def _read_stdout(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        splitter = NdjsonLineSplitter(
            on_line=self._handle_line,
            on_oversize=self._handle_oversize,
        )
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            splitter.feed(chunk)
        # EOF is the death signal (ADR-0003).
        returncode = None
        try:
            returncode = await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            pass
        self._finish(returncode)

    async def _pump_stderr(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stderr is not None
        pending = b""
        while True:
            chunk = await proc.stderr.read(65536)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if line:
                    self._log.info(
                        "[ocuclaw-runtime] %s",
                        line.decode("utf-8", "replace"),
                    )
        if pending:
            self._log.info("[ocuclaw-runtime] %s", pending.decode("utf-8", "replace"))

    def _handle_oversize(self, size: int) -> None:
        self.counters["oversized_inbound"] += 1
        self.counters["protocol_errors"] += 1
        self._log.warning(
            "[ocuclaw] dropped oversized control-link line (%d bytes > %d)",
            size,
            LINK_MAX_LINE_BYTES,
        )

    def _handle_line(self, line: bytes) -> None:
        try:
            frame = json.loads(line)
        except ValueError:
            self.counters["protocol_errors"] += 1
            self._log.warning("[ocuclaw] dropped non-JSON control-link line")
            return
        if not isinstance(frame, dict):
            self.counters["protocol_errors"] += 1
            return
        self.counters["frames_in"] += 1
        version = frame.get("v")
        frame_type = frame.get("type")
        if version != LINK_PROTOCOL_VERSION:
            self.counters["protocol_errors"] += 1
            if not self._ready:
                self._handshake_error = LinkHandshakeError(
                    f"protocol version mismatch: child sent v={version}, "
                    f"expected v={LINK_PROTOCOL_VERSION}"
                )
                if self._hello_event is not None:
                    self._hello_event.set()
            else:
                self._log.warning(
                    "[ocuclaw] dropping frame with protocol version %r", version
                )
            return
        if not self._ready:
            if frame_type == FRAME_HELLO:
                self._hello_payload = frame.get("payload") or {}
                if self._hello_event is not None:
                    self._hello_event.set()
            else:
                self.counters["protocol_errors"] += 1
                self._log.warning(
                    "[ocuclaw] dropping pre-handshake frame %r", frame_type
                )
            return
        if frame_type == FRAME_RPC_RESPONSE:
            self._handle_response(frame)
            return
        if frame_type == FRAME_RPC_REQUEST:
            asyncio.get_running_loop().create_task(self._handle_request(frame))
            return
        self.counters["protocol_errors"] += 1
        self._log.warning("[ocuclaw] unknown control-link frame type %r", frame_type)

    def _handle_response(self, frame: Dict[str, Any]) -> None:
        future = self._pending.pop(str(frame.get("id")), None)
        if future is None or future.done():
            self.counters["protocol_errors"] += 1
            return
        if frame.get("truncated") is True:
            future.set_exception(LinkRpcError(None, "link_frame_truncated"))
            return
        if frame.get("ok") is True:
            future.set_result(frame.get("result"))
            return
        error = frame.get("error") or {}
        future.set_exception(
            LinkRpcError(error.get("code"), error.get("message") or "link rpc failed")
        )

    async def _handle_request(self, frame: Dict[str, Any]) -> None:
        method = frame.get("method")
        handler = self._request_handlers.get(method or "")
        response: Dict[str, Any] = {
            "v": LINK_PROTOCOL_VERSION,
            "type": FRAME_RPC_RESPONSE,
            "id": frame.get("id"),
        }
        if handler is None:
            response["ok"] = False
            response["error"] = {
                "code": RPC_METHOD_NOT_FOUND_CODE,
                "message": f"method not found: {method or '<missing>'}",
            }
        else:
            try:
                result = await handler(frame.get("params"))
                response["ok"] = True
                response["result"] = result
            except Exception as exc:  # noqa: BLE001 — surfaced to the peer
                response["ok"] = False
                response["error"] = {"code": -32000, "message": str(exc)}
        try:
            self._send_frame(response)
        except LinkClosedError:
            pass

    def _finish(self, returncode: Optional[int]) -> None:
        if self._closed:
            return
        self._closed = True
        self._ready = False
        for future in self._pending.values():
            if not future.done():
                future.set_exception(LinkClosedError("control link closed"))
        self._pending.clear()
        if self._hello_event is not None and not self._hello_event.is_set():
            self._handshake_error = LinkHandshakeError(
                f"child exited (code={returncode}) before handshake completed"
            )
            self._hello_event.set()
        if self._on_exit is not None:
            try:
                self._on_exit(returncode)
            except Exception:  # noqa: BLE001 — observer must not break teardown
                self._log.exception("[ocuclaw] link on_exit callback failed")


# ---------------------------------------------------------------------------
# Child environment allowlist (#1331; locked boundary #1270)
# ---------------------------------------------------------------------------
#
# The boundary requires the Node child receive "an explicit cross-platform
# environment allowlist plus typed locally synthesized controls — never the
# relay token, provider/package/Git/SSH credentials, proxy variables, or
# wildcard environment inheritance."
#
# This list is an ALLOWLIST, never a denylist, and that is deliberate: the
# Hermes CLI's own bang-shell sanitizer is a denylist whose `except` path
# returns `os.environ.copy()`, so one failure hands over the whole keyring.
# An allowlist that fails leaks nothing.
#
# Nothing here is a secret, and nothing here needs to be: every credential the
# child uses (relay token, Soniox key, Even-AI token) is delivered deliberately
# over the control link in the `link.hello.ack` config payload — see
# `_child_runtime_config` in adapter.py and the secrets table in PROTOCOL.md.
# The environment is not, and must not become, a credential channel.
#
# The list was derived empirically, not guessed. A full sweep of the child's
# reachable module graph (`hermes-runtime-entry.cjs` plus the 105 repo-local
# modules and the relay worker thread it transitively loads) finds exactly four
# environment variables read by the child's own code: the two `OCUCLAW_LINK_*`
# controls this function synthesizes itself, and the two `OPENCLAW_*` host
# version strings below. The real Node entry completes the handshake with a
# *completely empty* environment, so everything else here is justified by what
# Node and the OS need to run the child correctly rather than by a code read.
#
# Windows note: Python normalizes `os.environ` keys to upper case on `nt`, so
# exact matching against these canonical upper-case names is correct on both
# platform families. Matching case-insensitively on POSIX would let a lower-
# case `path=` in the parent environment be promoted into the child's `PATH`.
CHILD_ENV_ALLOWLIST: Tuple[str, ...] = (
    # Executable resolution. No module in the child graph shells out today, but
    # an environment without PATH is a trap for the first one that does.
    "PATH",
    # Read by `openclaw-host-version` and reported to the glasses client via
    # the plugin version service. Non-secret host version strings, primary then
    # operator-set fallback; both absent reports null ("honest, never faked").
    "OPENCLAW_SERVICE_VERSION",
    "OPENCLAW_VERSION",
    # `os.homedir()` — POSIX reads $HOME, Windows %USERPROFILE%. The child
    # anchors state under it (relay-core debug-bundle dir, even-terminal
    # discovery/history roots), so an unset value silently relocates state.
    "HOME",
    "USERPROFILE",
    # `os.tmpdir()` — TMPDIR on POSIX, TEMP/TMP on Windows. The gateway bridge
    # stages files there.
    "TMPDIR",
    "TEMP",
    "TMP",
    # Locale and timezone: the child renders dates/numbers into glasses text.
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    # Windows platform floor — the Node binary itself will not start without
    # these, and `PATH` alone is not enough to resolve executables there.
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
)

# Deliberately NOT allowlisted, recorded so a future edit has to argue with it:
#   OCUCLAW_RELAY_TOKEN / OCUCLAW_SONIOX_API_KEY / OCUCLAW_EVEN_AI_TOKEN —
#     credentials; they reach the child over `link.hello.ack`, never the env.
#   NODE_OPTIONS / NODE_PATH — arbitrary-code-injection vectors into the child
#     (`--require`, module resolution) from whatever the gateway inherited.
#   NODE_EXTRA_CA_CERTS / NODE_TLS_REJECT_UNAUTHORIZED — parent-controlled TLS
#     trust for the child's outbound calls.
#   HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY — named by the boundary.
#   SSH_AUTH_SOCK / GIT_* / npm_* / provider API keys — named by the boundary.


def _synthesized_child_controls(
    handshake_timeout_s: Optional[float],
    debug_stderr: bool,
    hermes_features: Optional[str] = None,
) -> Dict[str, str]:
    """The typed, locally synthesized controls — the only non-allowlist keys.

    These are derived from adapter settings, never read from the parent
    environment, and are the two variables the child actually reads.
    """
    controls: Dict[str, str] = {}
    if handshake_timeout_s is not None:
        controls["OCUCLAW_LINK_HANDSHAKE_TIMEOUT_MS"] = str(
            int(handshake_timeout_s * 1000)
        )
    if debug_stderr:
        controls["OCUCLAW_LINK_DEBUG_STDERR"] = "1"
    if hermes_features is not None:
        controls["OCUCLAW_HERMES_FEATURES"] = str(hermes_features)
    return controls


def default_child_env(
    base_env: Optional[Dict[str, str]] = None,
    *,
    handshake_timeout_s: Optional[float] = None,
    debug_stderr: bool = False,
    hermes_features: Optional[str] = None,
) -> Dict[str, str]:
    """Build the child environment by allowlist — never by inheritance.

    ``base_env`` (default ``os.environ``) is *filtered*, not copied: a caller
    passing an environment explicitly gets the same boundary as the adapter.
    """
    source = os.environ if base_env is None else base_env
    env: Dict[str, str] = {}
    for name in CHILD_ENV_ALLOWLIST:
        value = source.get(name)
        if value is not None:
            env[name] = value
    env.update(
        _synthesized_child_controls(
            handshake_timeout_s,
            debug_stderr,
            hermes_features,
        )
    )
    return env
