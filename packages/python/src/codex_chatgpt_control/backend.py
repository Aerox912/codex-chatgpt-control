from __future__ import annotations

import asyncio
import json
import math
import queue
import secrets
import subprocess
import threading
import time
import warnings
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


BACKEND_REQUEST_SCHEMA_VERSION = "chatgpt.browser_control.backend_request.v1"
BACKEND_RESPONSE_SCHEMA_VERSION = "chatgpt.browser_control.backend_response.v1"
BACKEND_EVENT_SCHEMA_VERSION = "chatgpt.browser_control.backend_event.v1"
BACKEND_HELLO_COMMAND = "backend.hello"
BACKEND_NDJSON_FRAME_LIMIT_BYTES = 16 * 1024 * 1024
BACKEND_REQUEST_ID_MAX_LENGTH = 4096
BACKEND_CONTROL_REQUEST_ID_PREFIX = "__backend_control__"
MAX_BACKEND_BUFFER_LIMIT = 1_000_000
MAX_BACKEND_STREAM_QUEUE_BYTES = 64 * 1024 * 1024
DEFAULT_BACKEND_STREAM_QUEUE_BYTES = 16 * 1024 * 1024
DEFAULT_BACKEND_STREAM_QUEUE_SIZE = 256
DEFAULT_BACKEND_WRITE_QUEUE_LIMIT = 256
MAX_BACKEND_WRITE_QUEUE_BYTES = 64 * 1024 * 1024
DEFAULT_BACKEND_WRITE_QUEUE_BYTES = 16 * 1024 * 1024
# One virtual slot remains available during hello/legacy negotiation gaps until
# the next transport-owned control route is actually charged.
DEFAULT_BACKEND_MAX_IN_FLIGHT = 256
MIN_BACKEND_MAX_IN_FLIGHT = 2
DEFAULT_BACKEND_LATE_OUTPUT_GRACE_SECONDS = 5.0
DEFAULT_BACKEND_TOMBSTONE_LIMIT = 256
MAX_BACKEND_TIMER_SECONDS = 2_147_483.647
MAX_BACKEND_IDENTITY_FIELD_LENGTH = 512
BACKEND_COMPATIBILITY_SCHEMA_VERSION = "chatgpt.browser_control.backend_compatibility.v1"
_COMPATIBILITY_WARNING_CODES = {
    "package_name_mismatch",
    "package_version_mismatch",
    "runtime_mismatch",
    "runtime_version_mismatch",
    "build_digest_mismatch",
    "provenance_unknown",
    "legacy_backend",
    "negotiation_rejected",
}
DEFAULT_BACKEND_HANDSHAKE_TIMEOUT_SECONDS = 10.0
_REQUIRED_NEGOTIATION_COMMANDS = (
    "backend.hello",
    "backend.version",
    "backend.capabilities",
    "backend.health",
    "runner.run",
    "runner.stream",
)


class BackendProtocolError(RuntimeError):
    def __init__(self, code: str, message: str, *, recoverable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


class BackendTransportError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        returncode: int | None = None,
        stderr: str = "",
        fatal: bool = False,
        unresolved: bool = False,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.returncode = returncode
        # stderr is deliberately a safe metadata summary, never raw backend output.
        self.stderr = stderr
        self.fatal = fatal
        self.unresolved = unresolved
        self.code = code


@dataclass(frozen=True)
class BackendRequest:
    command: str
    payload: dict[str, Any] = field(default_factory=dict)
    request_id: str | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "schemaVersion": BACKEND_REQUEST_SCHEMA_VERSION,
            "command": self.command,
            "payload": self.payload,
        }
        if self.request_id is not None:
            wire["requestId"] = self.request_id
        return wire


BackendResponse = dict[str, Any]
BackendEvent = dict[str, Any]


class BackendTransport(Protocol):
    def request(self, request: dict[str, Any]) -> BackendResponse:
        ...

    def stream(self, request: dict[str, Any]) -> Iterator[BackendEvent]:
        ...

    def close(self) -> None:
        ...


_RouteKind = Literal["unary", "stream"]
_ReservationKind = Literal["unary", "stream", "control"]


@dataclass(frozen=True)
class _Tombstone:
    request_id: str
    kind: _RouteKind
    expires_at: float
    reason: str


@dataclass(eq=False)
class _WriteAdmission:
    request_id: str
    byte_count: int
    started: bool = False
    released: bool = False


def _validate_positive_finite(name: str, value: float) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
        or value > MAX_BACKEND_TIMER_SECONDS
    ):
        raise ValueError(f"{name} must be a positive finite number within the supported timer range")


def _validate_max_in_flight(value: object) -> None:
    """Validate the aggregate route-admission bound shared by transports."""

    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < MIN_BACKEND_MAX_IN_FLIGHT
        or value > MAX_BACKEND_BUFFER_LIMIT
    ):
        raise ValueError(
            f"max_in_flight must be a bounded integer at least {MIN_BACKEND_MAX_IN_FLIGHT}"
        )


def _is_bounded_identity_field(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and len(value) <= MAX_BACKEND_IDENTITY_FIELD_LENGTH
        and value == value.strip()
        and not any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    )


def is_valid_backend_request_id(value: object) -> bool:
    """Match the Node transport's bounded, control-character-free rule."""

    return (
        isinstance(value, str)
        and bool(value)
        and len(value) <= BACKEND_REQUEST_ID_MAX_LENGTH
        and value == value.strip()
        and not any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    )


def _ensure_allowed_keys(value: dict[str, Any], allowed: set[str], *, label: str) -> None:
    if any(key not in allowed for key in value):
        raise BackendTransportError(
            f"Backend {label} contains unsupported fields.",
            fatal=True,
            code="invalid_backend_message",
        )


def _require_message_request_id(value: dict[str, Any], *, label: str) -> str:
    request_id = value.get("requestId")
    if not is_valid_backend_request_id(request_id):
        raise BackendTransportError(
            f"Backend {label} requires a bounded requestId.",
            fatal=True,
            code="missing_backend_request_id",
        )
    assert isinstance(request_id, str)
    return request_id


def _wire_value_bytes(value: dict[str, Any]) -> int:
    try:
        return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        return 0


@dataclass
class _Route:
    request_id: str
    kind: _RouteKind
    max_queue_size: int
    max_queue_bytes: int
    items: queue.Queue[dict[str, Any]] = field(init=False)
    done: threading.Event = field(init=False, default_factory=threading.Event)
    _lock: threading.Lock = field(init=False, default_factory=threading.Lock)
    _error: BackendTransportError | None = field(init=False, default=None)
    _legacy_release: Callable[[], None] | None = field(init=False, default=None)
    _queued_bytes: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self.items = queue.Queue(maxsize=max(1, self.max_queue_size))

    @property
    def error(self) -> BackendTransportError | None:
        with self._lock:
            return self._error

    def offer(self, value: dict[str, Any], *, terminal: bool = False) -> bool:
        """Queue without blocking the lifecycle reader or unrelated routes."""

        value_bytes = _wire_value_bytes(value)
        if value_bytes <= 0:
            value_bytes = self.max_queue_bytes + 1
        with self._lock:
            if self.done.is_set():
                return False
            if value_bytes > self.max_queue_bytes or self._queued_bytes + value_bytes > self.max_queue_bytes:
                self._error = BackendTransportError(
                    f"Backend stream queue exceeded {self.max_queue_size} events or {self.max_queue_bytes} bytes.",
                    fatal=False,
                    unresolved=True,
                    code="backend_stream_overflow",
                )
                self.done.set()
                return False
            try:
                self.items.put_nowait(value)
            except queue.Full:
                self._error = BackendTransportError(
                    f"Backend stream queue exceeded {self.max_queue_size} events or {self.max_queue_bytes} bytes.",
                    fatal=False,
                    unresolved=True,
                    code="backend_stream_overflow",
                )
                self.done.set()
                return False
            self._queued_bytes += value_bytes
            if self.kind == "unary" or terminal:
                self.done.set()
            return True

    def take(self, *, timeout: float | None = None) -> dict[str, Any]:
        value = self.items.get(timeout=timeout) if timeout is not None else self.items.get()
        with self._lock:
            self._queued_bytes = max(0, self._queued_bytes - _wire_value_bytes(value))
        return value

    def take_nowait(self) -> dict[str, Any]:
        value = self.items.get_nowait()
        with self._lock:
            self._queued_bytes = max(0, self._queued_bytes - _wire_value_bytes(value))
        return value

    def fail(self, error: BackendTransportError) -> None:
        with self._lock:
            if not self.done.is_set():
                self._error = error
                self.done.set()

    def cancel(self) -> None:
        with self._lock:
            self.done.set()

    def set_legacy_release(self, release: Callable[[], None] | None) -> None:
        with self._lock:
            self._legacy_release = release

    def take_legacy_release(self) -> Callable[[], None] | None:
        with self._lock:
            release = self._legacy_release
            self._legacy_release = None
            return release


class _StreamIterator:
    """A closeable synchronous stream backed by one broker route."""

    def __init__(
        self,
        transport: "StdioBackendTransport",
        request: dict[str, Any],
        request_id: str,
        *,
        timeout_seconds: float | None,
    ) -> None:
        self._transport = transport
        self._request = request
        self._request_id = request_id
        self._route: _Route | None = None
        self._timeout_seconds = timeout_seconds
        self._deadline: float | None = None
        self._closed = False
        self._state_lock = threading.Lock()

    def __iter__(self) -> "_StreamIterator":
        return self

    def __next__(self) -> BackendEvent:
        with self._state_lock:
            if self._closed:
                raise StopIteration
            if self._route is None:
                self._route = self._transport._open_stream(self._request, self._request_id)
                if self._timeout_seconds is not None:
                    self._deadline = time.monotonic() + self._timeout_seconds
            route = self._route

        try:
            if self._timeout_seconds is None:
                value = self._wait_without_timeout(route)
            else:
                value = self._wait_with_timeout(route, self._timeout_seconds)
        except BackendTransportError:
            self.close()
            raise

        if value is None:
            self.close()
            raise StopIteration
        event_type = value.get("type")
        if event_type == "error":
            self._transport._raise_protocol_error(value, stream=True)
        if event_type in {"completed", "error"}:
            self._transport._retire(self._request_id, route)
        return value

    def close(self) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            route = self._route
        if route is None:
            # The reservation was never written to the sidecar.  There is no
            # concurrent opener once the iterator state lock has marked this
            # instance closed, so release it outright rather than retaining a
            # cancelled-reservation sentinel forever.  Sentinels are needed
            # only for request_async's real reserve/write cancellation race.
            self._transport._release_reservation(self._request_id)
            return
        self._transport._cancel(
            self._request_id,
            route,
            reason="stream_cancelled",
            kind="stream",
        )

    def _wait_without_timeout(self, route: _Route) -> BackendEvent | None:
        while True:
            try:
                return route.take(timeout=0.1)
            except queue.Empty:
                if route.done.is_set():
                    error = route.error
                    if error is not None:
                        raise error
                    return None

    def _wait_with_timeout(self, route: _Route, timeout_seconds: float) -> BackendEvent | None:
        deadline = self._deadline
        if deadline is None:
            deadline = time.monotonic() + timeout_seconds
            self._deadline = deadline
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if route.done.is_set():
                    error = route.error
                    if error is not None:
                        raise error
                    return None
                error = BackendTransportError(
                    f"Backend stream timed out after {timeout_seconds} seconds.",
                    fatal=False,
                    unresolved=True,
                    code="backend_timeout",
                )
                route.fail(error)
                raise error
            try:
                return route.take(timeout=min(remaining, 0.1))
            except queue.Empty:
                if route.done.is_set():
                    error = route.error
                    if error is not None:
                        raise error
                    return None


@dataclass
class StdioBackendTransport:
    """Lifecycle-owned NDJSON sidecar broker with strict bounded routing."""

    command: list[str]
    timeout_seconds: float = 600.0
    handshake_timeout_seconds: float = DEFAULT_BACKEND_HANDSHAKE_TIMEOUT_SECONDS
    frame_limit_bytes: int = BACKEND_NDJSON_FRAME_LIMIT_BYTES
    env: dict[str, str] | None = None
    max_stream_queue_size: int = DEFAULT_BACKEND_STREAM_QUEUE_SIZE
    tombstone_ttl_seconds: float | None = None  # compatibility option; terminal IDs are reusable like Node
    tombstone_grace_seconds: float | None = None
    quarantine_grace_seconds: float | None = None
    max_tombstones: int = DEFAULT_BACKEND_TOMBSTONE_LIMIT
    expected_package_name: str | None = None
    expected_package_version: str | None = None
    expected_build_digest: str | None = None
    expected_runtime: str | None = None
    expected_runtime_version: str | None = None
    max_stream_queue_bytes: int = DEFAULT_BACKEND_STREAM_QUEUE_BYTES
    _process: subprocess.Popen[Any] | None = field(init=False, default=None)
    _stderr_bytes: int = field(init=False, default=0)
    _stderr_truncated: bool = field(init=False, default=False)
    _stderr_lock: threading.Lock = field(init=False, default_factory=threading.Lock)
    _stderr_thread: threading.Thread | None = field(init=False, default=None)
    _reader_thread: threading.Thread | None = field(init=False, default=None)
    _state_lock: threading.RLock = field(init=False, default_factory=threading.RLock)
    _write_lock: threading.Lock = field(init=False, default_factory=threading.Lock)
    _legacy_lock: threading.Lock = field(init=False, default_factory=threading.Lock)
    _routes: dict[str, _Route] = field(init=False, default_factory=dict)
    _reservations: dict[str, _ReservationKind] = field(init=False, default_factory=dict)
    _control_reservations: int = field(init=False, default=0)
    _pre_reserved_ids: set[str] = field(init=False, default_factory=set)
    _cancelled_reservations: set[str] = field(init=False, default_factory=set)
    _written_request_ids: set[str] = field(init=False, default_factory=set)
    _unresolved_tombstones: dict[str, _Tombstone] = field(init=False, default_factory=dict)
    _tombstone_timer: threading.Timer | None = field(init=False, default=None)
    _tombstone_timer_deadline: float | None = field(init=False, default=None)
    _quarantine_timer: threading.Timer | None = field(init=False, default=None)
    _quarantine_deadline: float | None = field(init=False, default=None)
    _quarantine_error: BackendTransportError | None = field(init=False, default=None)
    _request_id_prefix: str = field(init=False, default_factory=lambda: f"py_transport_{secrets.token_hex(16)}")
    _next_request_id: int = field(init=False, default=0)
    _closed: bool = field(init=False, default=False)
    _fatal_error: BackendTransportError | None = field(init=False, default=None)
    _fatal_cleanup_started: bool = field(init=False, default=False)
    _handshake_condition: threading.Condition = field(init=False)
    _handshake_state: Literal["unknown", "ready", "single-flight", "legacy", "blocked"] = field(init=False, default="unknown")
    _handshake_in_progress: bool = field(init=False, default=False)
    _handshake_error: BackendTransportError | None = field(init=False, default=None)
    _compatibility_report: dict[str, Any] | None = field(init=False, default=None)
    _handshake_generation: int = field(init=False, default=0)
    write_queue_limit: int = DEFAULT_BACKEND_WRITE_QUEUE_LIMIT
    write_queue_bytes_limit: int = DEFAULT_BACKEND_WRITE_QUEUE_BYTES
    max_in_flight: int = DEFAULT_BACKEND_MAX_IN_FLIGHT
    _active_writes: set[_WriteAdmission] = field(init=False, default_factory=set)
    _write_queue_bytes: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        if (
            not isinstance(self.command, list)
            or not self.command
            or any(not isinstance(part, str) for part in self.command)
            or not self.command[0].strip()
        ):
            raise ValueError("command must contain a non-empty executable")
        if (
            not isinstance(self.max_stream_queue_size, int)
            or isinstance(self.max_stream_queue_size, bool)
            or self.max_stream_queue_size <= 0
            or self.max_stream_queue_size > MAX_BACKEND_BUFFER_LIMIT
        ):
            raise ValueError("max_stream_queue_size must be a bounded positive integer")
        if (
            not isinstance(self.max_stream_queue_bytes, int)
            or isinstance(self.max_stream_queue_bytes, bool)
            or self.max_stream_queue_bytes <= 0
            or self.max_stream_queue_bytes > MAX_BACKEND_STREAM_QUEUE_BYTES
        ):
            raise ValueError("max_stream_queue_bytes must be a bounded positive integer")
        if (
            not isinstance(self.write_queue_limit, int)
            or isinstance(self.write_queue_limit, bool)
            or self.write_queue_limit <= 0
            or self.write_queue_limit > MAX_BACKEND_BUFFER_LIMIT
        ):
            raise ValueError("write_queue_limit must be a bounded positive integer")
        if (
            not isinstance(self.write_queue_bytes_limit, int)
            or isinstance(self.write_queue_bytes_limit, bool)
            or self.write_queue_bytes_limit <= 0
            or self.write_queue_bytes_limit > MAX_BACKEND_WRITE_QUEUE_BYTES
        ):
            raise ValueError("write_queue_bytes_limit must be a bounded positive integer")
        _validate_max_in_flight(self.max_in_flight)
        _validate_positive_finite("timeout_seconds", self.timeout_seconds)
        _validate_positive_finite("handshake_timeout_seconds", self.handshake_timeout_seconds)
        if (
            not isinstance(self.frame_limit_bytes, int)
            or isinstance(self.frame_limit_bytes, bool)
            or self.frame_limit_bytes <= 0
            or self.frame_limit_bytes > BACKEND_NDJSON_FRAME_LIMIT_BYTES
        ):
            raise ValueError("frame_limit_bytes must be within the protocol frame bound")
        for name, value in (
            ("tombstone_ttl_seconds", self.tombstone_ttl_seconds),
            ("tombstone_grace_seconds", self.tombstone_grace_seconds),
            ("quarantine_grace_seconds", self.quarantine_grace_seconds),
        ):
            if value is not None:
                _validate_positive_finite(name, value)
        if (
            not isinstance(self.max_tombstones, int)
            or isinstance(self.max_tombstones, bool)
            or self.max_tombstones <= 0
            or self.max_tombstones > MAX_BACKEND_BUFFER_LIMIT
        ):
            raise ValueError("max_tombstones must be a bounded positive integer")
        for name, value in (
            ("expected_package_name", self.expected_package_name),
            ("expected_package_version", self.expected_package_version),
            ("expected_build_digest", self.expected_build_digest),
            ("expected_runtime", self.expected_runtime),
            ("expected_runtime_version", self.expected_runtime_version),
        ):
            if value is not None and not _is_bounded_identity_field(value):
                raise ValueError(f"{name} must be a bounded identity string when provided")
        self._handshake_condition = threading.Condition(self._state_lock)

    def request(self, request: dict[str, Any]) -> BackendResponse:
        wire, request_id = self._prepare_request(request)
        with self._state_lock:
            pre_reserved = request_id in self._pre_reserved_ids
            if pre_reserved:
                self._pre_reserved_ids.discard(request_id)
            cancelled = request_id in self._cancelled_reservations
            self._cancelled_reservations.discard(request_id)
        if cancelled:
            self._resolve_tombstone(request_id)
            raise BackendTransportError("Backend request was cancelled before it was written.", code="backend_request_cancelled")
        if not pre_reserved:
            self._reserve_request_id(request_id, "unary")
        route: _Route | None = None
        try:
            self._ensure_handshake()
            release = self._acquire_single_flight()
            try:
                route = self._register(request_id, "unary", release)
                self._write_json_line(wire, perform_handshake=False)
            except BaseException:
                if route is None:
                    if release is not None:
                        release()
                raise
            response = self._await_unary(route)
            if response.get("ok") is False:
                self._raise_protocol_error(response)
            return response
        except BackendTransportError as exc:
            if route is not None:
                route.fail(exc)
            raise
        finally:
            if route is not None:
                route_error = route.error
                self._retire(
                    request_id,
                    route,
                    unresolved=route_error.unresolved if route_error is not None else False,
                    reason="request_timeout" if route_error is not None else "terminal",
                )
            else:
                self._release_reservation(request_id)

    def stream(self, request: dict[str, Any]) -> Iterator[BackendEvent]:
        wire, request_id = self._prepare_request(request)
        self._reserve_request_id(request_id, "stream")
        return _StreamIterator(self, wire, request_id, timeout_seconds=self.timeout_seconds)

    def cancel(self, request_id: str) -> bool:
        if not is_valid_backend_request_id(request_id):
            return False
        return self._cancel(request_id, None, reason="request_cancelled")

    def reserve_request_id(self, request_id: str, kind: _RouteKind = "unary") -> None:
        self._reserve_request_id(request_id, kind)
        with self._state_lock:
            # Cancellation/fatal teardown may race the second half of this
            # public pre-reservation call.  Never leave a pre-reserved marker
            # without its owning reservation.
            if request_id in self._reservations:
                self._pre_reserved_ids.add(request_id)

    def allocate_request_id(self) -> str:
        with self._state_lock:
            self._next_request_id += 1
            request_id = f"{self._request_id_prefix}_{self._next_request_id}"
            if not is_valid_backend_request_id(request_id):
                raise BackendTransportError("Transport-generated requestId was invalid.", fatal=True, code="invalid_request_id")
            return request_id

    def close(self) -> None:
        with self._write_lock:
            with self._state_lock:
                if self._closed and self._process is None:
                    return
                self._closed = True
                self._handshake_state = "blocked"
                self._handshake_error = BackendTransportError("Backend transport was closed.", fatal=True, code="backend_closed")
                for timer in (self._tombstone_timer, self._quarantine_timer):
                    if timer is not None:
                        timer.cancel()
                self._tombstone_timer = None
                self._quarantine_timer = None
                self._tombstone_timer_deadline = None
                self._quarantine_deadline = None
                process = self._process
                routes = list(self._routes.values())
                self._routes.clear()
                self._reservations.clear()
                self._control_reservations = 0
                self._pre_reserved_ids.clear()
                self._cancelled_reservations.clear()
                self._written_request_ids.clear()
                self._fatal_cleanup_started = False
            error = BackendTransportError(
                "Backend transport was closed.",
                returncode=process.poll() if process is not None else None,
                stderr=self._read_stderr(process),
                fatal=True,
                code="backend_closed",
            )
            for route in routes:
                route.fail(error)
                self._release_legacy(route)
            self._terminate_process(process)
            with self._state_lock:
                if self._process is process:
                    self._process = None
                    self._reader_thread = None
                    self._stderr_thread = None

    def _prepare_request(self, request: dict[str, Any]) -> tuple[dict[str, Any], str]:
        if not isinstance(request, dict):
            raise BackendTransportError("Backend request must be a JSON object.", code="invalid_backend_request")
        wire = dict(request)
        request_id = wire.get("requestId")
        if request_id is None:
            request_id = self.allocate_request_id()
            wire["requestId"] = request_id
        if not is_valid_backend_request_id(request_id):
            raise BackendTransportError(
                "Backend requestId must be a bounded, non-empty string without control characters.",
                code="invalid_request_id",
            )
        if request_id.startswith(BACKEND_CONTROL_REQUEST_ID_PREFIX):
            raise BackendTransportError("Backend requestId uses a transport-reserved control namespace.", code="reserved_request_id")
        return wire, request_id

    def _reserve_request_id(self, request_id: str, kind: _RouteKind | Literal["control"], *, control: bool = False) -> None:
        if not is_valid_backend_request_id(request_id):
            raise BackendTransportError(
                "Backend requestId must be a bounded, non-empty string without control characters.",
                code="invalid_request_id",
            )
        if not control and request_id.startswith(BACKEND_CONTROL_REQUEST_ID_PREFIX):
            raise BackendTransportError("Backend requestId uses a transport-reserved control namespace.", code="reserved_request_id")
        with self._state_lock:
            self._prune_tombstones_locked()
            if self._closed:
                raise self._handshake_error or BackendTransportError("Backend transport is closed.", fatal=True, code="backend_closed")
            if self._fatal_cleanup_started:
                raise self._fatal_recycling_error_locked()
            if self._quarantine_error is not None:
                raise self._quarantine_error
            if request_id in self._cancelled_reservations:
                raise BackendTransportError(
                    f"Backend requestId {request_id!r} is still reserved by a cancelled worker.",
                    code="request_id_reused",
                )
            if request_id in self._reservations or request_id in self._routes:
                raise BackendTransportError(f"Backend requestId {request_id!r} is already active.", code="duplicate_request_id")
            if request_id in self._unresolved_tombstones:
                raise BackendTransportError(
                    f"Backend requestId {request_id!r} is still draining after cancellation or timeout.",
                    code="request_id_reused",
                )
            admission_limit = self.max_in_flight
            if (
                kind != "control"
                and (self._handshake_state == "unknown" or self._handshake_in_progress)
                and self._control_reservations == 0
            ):
                # A caller reserves its route before it asks this transport to
                # negotiate. Keep one virtual slot free so a pre-empted caller
                # can still admit the transport-owned hello/control route. As
                # soon as that control route is charged, it counts normally
                # and the full configured aggregate bound is available.
                admission_limit -= 1
            if self._admitted_request_count_locked() >= admission_limit:
                raise BackendTransportError(
                    "Backend transport reached its bounded in-flight route limit.",
                    code="backend_in_flight_limit",
                )
            self._reservations[request_id] = kind
            if kind == "control":
                self._control_reservations += 1

    def _admitted_request_count_locked(self) -> int:
        """Return the unique aggregate route count without allocating.

        A live route is represented in both ``_routes`` and ``_reservations``;
        pre-reserved IDs are a subset of reservations, while a cancellation
        marker stands in for a reservation until its worker consumes it.  Set
        membership therefore counts each live ID exactly once as a reservation
        or cancellation marker.  Tombstones are deliberately excluded: they
        are bounded late-output guards, not live caller routes.
        """

        return len(self._reservations) + len(self._cancelled_reservations)

    def _assert_admission_invariants_locked(self) -> None:
        """Assert the representation invariant used by admission counting.

        This diagnostic helper is intentionally separate from the hot admission
        path.  Tests and debugging checks can validate the relationship without
        making every caller allocate or scan the route maps.
        """

        assert all(request_id in self._reservations for request_id in self._routes)
        assert all(request_id in self._reservations for request_id in self._pre_reserved_ids)
        assert all(
            request_id not in self._reservations and request_id not in self._routes
            for request_id in self._cancelled_reservations
        )
        assert self._control_reservations >= 0
        assert self._control_reservations == sum(
            kind == "control" for kind in self._reservations.values()
        )

    def _pop_reservation_locked(self, request_id: str) -> _ReservationKind | None:
        """Pop one reservation and keep control-route accounting in sync.

        Callers must hold ``_state_lock``.  Keeping this mutation in one helper
        prevents a terminal, cancellation, close, or fatal-recycle path from
        accidentally leaving virtual handshake headroom disabled.
        """

        reservation = self._reservations.pop(request_id, None)
        if reservation == "control":
            assert self._control_reservations > 0
            self._control_reservations -= 1
        return reservation

    def _release_reservation(self, request_id: str, *, unresolved_kind: _RouteKind | None = None, reason: str = "terminal") -> None:
        with self._state_lock:
            reservation = self._pop_reservation_locked(request_id)
            self._pre_reserved_ids.discard(request_id)
            if reservation == "control" or unresolved_kind is None:
                return
            self._record_unresolved_locked(request_id, unresolved_kind, reason=reason)

    def _register(self, request_id: str, kind: _RouteKind, legacy_release: Callable[[], None] | None = None) -> _Route:
        with self._state_lock:
            self._prune_tombstones_locked()
            if self._fatal_cleanup_started:
                raise self._fatal_recycling_error_locked()
            if request_id in self._cancelled_reservations:
                self._cancelled_reservations.discard(request_id)
                self._unresolved_tombstones.pop(request_id, None)
                self._schedule_tombstone_expiry_locked()
                raise BackendTransportError(
                    f"Backend requestId {request_id!r} was cancelled before it was written.",
                    code="backend_request_cancelled",
                )
            reservation = self._reservations.get(request_id)
            if reservation != kind and not (kind == "unary" and reservation == "control"):
                raise BackendTransportError(f"Backend requestId {request_id!r} has no matching reservation.", code="missing_request_reservation")
            if request_id in self._routes:
                raise BackendTransportError(f"Backend requestId {request_id!r} is already active.", code="duplicate_request_id")
            route = _Route(
                request_id=request_id,
                kind=kind,
                max_queue_size=1 if kind == "unary" else self.max_stream_queue_size,
                max_queue_bytes=self.frame_limit_bytes if kind == "unary" else self.max_stream_queue_bytes,
            )
            route.set_legacy_release(legacy_release)
            self._routes[request_id] = route
            return route

    def _acquire_single_flight(self) -> Callable[[], None] | None:
        with self._state_lock:
            single_flight = self._handshake_state in {"single-flight", "legacy"}
        if not single_flight:
            return None
        self._legacy_lock.acquire()
        released = False
        release_lock = threading.Lock()

        def release() -> None:
            nonlocal released
            with release_lock:
                if released:
                    return
                released = True
                self._legacy_lock.release()

        return release

    def _ensure_handshake(self) -> None:
        with self._handshake_condition:
            while self._handshake_in_progress:
                self._handshake_condition.wait()
            if self._closed:
                raise self._handshake_error or BackendTransportError("Backend transport is closed.", fatal=True, code="backend_closed")
            if self._fatal_cleanup_started:
                raise self._fatal_recycling_error_locked()
            if self._handshake_state in {"ready", "single-flight", "legacy"}:
                return
            if self._handshake_state == "blocked":
                raise self._handshake_error or BackendTransportError("Backend hello negotiation blocked this transport.", fatal=True, code="backend_hello_rejected")
            self._handshake_in_progress = True
        try:
            self._start()
            self._perform_handshake()
        except BackendTransportError as exc:
            with self._handshake_condition:
                if exc.code == "backend_hello_rejected":
                    self._handshake_error = exc
                    self._handshake_state = "blocked"
                else:
                    self._handshake_state = "unknown"
            if exc.code == "backend_hello_rejected":
                self._recycle_process(self._process)
            raise
        finally:
            with self._handshake_condition:
                self._handshake_in_progress = False
                self._handshake_condition.notify_all()

    def _perform_handshake(self) -> None:
        self._handshake_generation += 1
        hello_id = f"{BACKEND_CONTROL_REQUEST_ID_PREFIX}{self._request_id_prefix}_hello_{self._handshake_generation}"
        response = self._issue_control(hello_id, BACKEND_HELLO_COMMAND, self._hello_payload())
        if not response.get("ok"):
            error = response.get("error")
            if isinstance(error, dict) and error.get("code") == "unknown_command":
                self._negotiate_legacy()
                return
            self._compatibility_report = _blocked_compatibility_report()
            raise self._hello_rejected("Backend hello returned an error response.")
        result = response.get("result")
        if not self._is_valid_hello_result(result):
            self._compatibility_report = _blocked_compatibility_report()
            raise self._hello_rejected("Backend hello negotiation was malformed or incompatible.")
        assert isinstance(result, dict)
        capabilities = result["capabilities"]
        assert isinstance(capabilities, dict)
        multiplexing = capabilities["multiplexing"]
        assert isinstance(multiplexing, dict)
        self._warn_identity_drift(result)
        mode = "multiplexed" if multiplexing.get("unary") is True and multiplexing.get("streams") is True else "single-flight"
        self._compatibility_report = _compatibility_report(result, expected=self._expected_identity(), mode=mode)
        self._handshake_state = "ready" if mode == "multiplexed" else "single-flight"

    @staticmethod
    def _hello_payload() -> dict[str, Any]:
        return {
            "protocolVersion": BACKEND_REQUEST_SCHEMA_VERSION,
            "capabilities": {
                "commands": list(_REQUIRED_NEGOTIATION_COMMANDS),
                "transports": ["stdio"],
                "streaming": {"modes": ["ndjson"], "tokenDeltas": False},
                "supportedProtocolVersions": [BACKEND_REQUEST_SCHEMA_VERSION],
                "requestIds": {"required": True, "scope": "connection"},
                "multiplexing": {"unary": True, "streams": True},
                "cancellation": {"supported": False, "requests": False, "streams": False},
                "tabs": {
                    "stableProviderIdentity": False,
                    "stableBrowserIdentity": False,
                    "stableTabIdentity": False,
                    "coordinationScope": "none",
                    "authoritativeClaim": False,
                    "fencing": False,
                    "concurrentTabs": False,
                    "stableIdentity": False,
                    "coordination": False,
                    "concurrent": False,
                },
            },
        }

    def _negotiate_legacy(self) -> None:
        version_result: dict[str, Any] | None = None
        for command in ("backend.version", "backend.capabilities"):
            self._handshake_generation += 1
            request_id = f"{BACKEND_CONTROL_REQUEST_ID_PREFIX}{self._request_id_prefix}_legacy_{self._handshake_generation}"
            response = self._issue_control(request_id, command, {})
            if not response.get("ok") or not isinstance(response.get("result"), dict):
                raise self._hello_rejected(f"Legacy backend {command} probe failed.")
            if command == "backend.version":
                version = response["result"]
                if isinstance(version, dict):
                    version_result = version
                if (
                    version.get("protocolVersion") != BACKEND_REQUEST_SCHEMA_VERSION
                    or not isinstance(version.get("name"), str)
                    or not version["name"]
                    or not isinstance(version.get("runtime"), str)
                    or not version["runtime"]
                ):
                    self._compatibility_report = _blocked_compatibility_report()
                    raise self._hello_rejected("Legacy backend version probe was incompatible.")
            else:
                capabilities = response["result"]
                commands = capabilities.get("commands")
                streaming = capabilities.get("streaming")
                if (
                    capabilities.get("protocolVersion") != BACKEND_REQUEST_SCHEMA_VERSION
                    or not isinstance(commands, list)
                    or any(command not in commands for command in _REQUIRED_NEGOTIATION_COMMANDS[1:])
                    or not isinstance(capabilities.get("transports"), list)
                    or "stdio" not in capabilities["transports"]
                    or not isinstance(streaming, dict)
                    or not isinstance(streaming.get("modes"), list)
                    or "ndjson" not in streaming["modes"]
                    or streaming.get("tokenDeltas") is not False
                ):
                    self._compatibility_report = _blocked_compatibility_report()
                    raise self._hello_rejected("Legacy backend capabilities were incompatible.")
        self._compatibility_report = _compatibility_report(
            version_result or {},
            expected=self._expected_identity(),
            mode="legacy",
            legacy=True,
        )
        self._handshake_state = "legacy"

    def _issue_control(self, request_id: str, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._reserve_request_id(request_id, "control", control=True)
        route: _Route | None = None
        try:
            route = self._register(request_id, "unary")
            self._write_json_line(BackendRequest(command, payload, request_id).to_wire(), perform_handshake=False)
            return self._await_unary(route, timeout_seconds=self.handshake_timeout_seconds)
        finally:
            if route is not None:
                self._retire(request_id, route)
            else:
                self._release_reservation(request_id)

    def _hello_rejected(self, message: str) -> BackendTransportError:
        return BackendTransportError(message, fatal=True, code="backend_hello_rejected")

    def _is_valid_hello_result(self, result: object) -> bool:
        if not isinstance(result, dict) or result.get("accepted") is not True:
            return False
        identity = ("backendSessionId", "packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest", "protocolVersion")
        if any(not _is_bounded_identity_field(result.get(field)) for field in identity):
            return False
        capabilities = result.get("capabilities")
        if not isinstance(capabilities, dict) or any(capabilities.get(field) != result.get(field) for field in identity):
            return False
        if capabilities.get("protocolVersion") != BACKEND_REQUEST_SCHEMA_VERSION:
            return False
        supported = capabilities.get("supportedProtocolVersions")
        commands = capabilities.get("commands")
        transports = capabilities.get("transports")
        streaming = capabilities.get("streaming")
        request_ids = capabilities.get("requestIds")
        multiplexing = capabilities.get("multiplexing")
        cancellation = capabilities.get("cancellation")
        tabs = capabilities.get("tabs")
        return (
            isinstance(supported, list)
            and BACKEND_REQUEST_SCHEMA_VERSION in supported
            and all(isinstance(value, str) for value in supported)
            and isinstance(commands, list)
            and bool(commands)
            and all(isinstance(value, str) for value in commands)
            and all(command in commands for command in _REQUIRED_NEGOTIATION_COMMANDS)
            and isinstance(transports, list)
            and "stdio" in transports
            and all(value in {"stdio", "http"} for value in transports)
            and isinstance(streaming, dict)
            and isinstance(streaming.get("modes"), list)
            and "ndjson" in streaming["modes"]
            and all(value in {"ndjson", "sse"} for value in streaming["modes"])
            and streaming.get("tokenDeltas") is False
            and isinstance(request_ids, dict)
            and request_ids.get("required") is True
            and request_ids.get("scope") in {"connection", "process"}
            and isinstance(multiplexing, dict)
            and isinstance(multiplexing.get("unary"), bool)
            and isinstance(multiplexing.get("streams"), bool)
            and isinstance(cancellation, dict)
            and all(isinstance(cancellation.get(key), bool) for key in ("supported", "requests", "streams"))
            and self._valid_tabs(tabs)
        )

    @staticmethod
    def _valid_tabs(tabs: object) -> bool:
        if not isinstance(tabs, dict):
            return False
        required = ("stableProviderIdentity", "stableBrowserIdentity", "stableTabIdentity", "authoritativeClaim", "fencing", "concurrentTabs")
        if any(not isinstance(tabs.get(key), bool) for key in required) or tabs.get("coordinationScope") not in {"none", "process", "provider"}:
            return False
        expected = {
            "stableIdentity": tabs["stableProviderIdentity"] and tabs["stableBrowserIdentity"] and tabs["stableTabIdentity"],
            "coordination": tabs["coordinationScope"] != "none",
            "concurrent": tabs["concurrentTabs"],
        }
        return all(key not in tabs or tabs[key] == value for key, value in expected.items())

    def _warn_identity_drift(self, result: dict[str, Any]) -> None:
        for label, expected, actual in (
            ("package name", self.expected_package_name, result.get("packageName")),
            ("package version", self.expected_package_version, result.get("packageVersion")),
            ("build digest", self.expected_build_digest, result.get("buildDigest")),
            ("runtime", self.expected_runtime, result.get("runtime")),
            ("runtime version", self.expected_runtime_version, result.get("runtimeVersion")),
        ):
            if expected is not None and actual != expected:
                warnings.warn(f"Backend {label} drift: expected {expected!r}, received {actual!r}.", RuntimeWarning, stacklevel=3)

    def _expected_identity(self) -> dict[str, str | None]:
        return {
            "packageName": self.expected_package_name,
            "packageVersion": self.expected_package_version,
            "buildDigest": self.expected_build_digest,
            "runtime": self.expected_runtime,
            "runtimeVersion": self.expected_runtime_version,
        }

    def compatibility_report(self) -> dict[str, Any] | None:
        report = self._compatibility_report
        if report is None:
            return None
        return {
            **report,
            "warnings": [dict(warning) for warning in report.get("warnings", [])],
        }

    def _start(self) -> subprocess.Popen[Any]:
        with self._state_lock:
            if self._closed:
                raise self._handshake_error or BackendTransportError("Backend transport is closed.", fatal=True, code="backend_closed")
            if self._fatal_cleanup_started:
                raise self._fatal_recycling_error_locked()
            if self._process is not None:
                return self._process
            self._fatal_error = None
            self._fatal_cleanup_started = False
            self._compatibility_report = None
            with self._stderr_lock:
                self._stderr_bytes = 0
                self._stderr_truncated = False
            try:
                process = subprocess.Popen(
                    self.command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=False,
                    bufsize=0,
                    env=self.env,
                )
            except OSError as exc:
                error = BackendTransportError("Backend process could not be started.", stderr="backend_start_failed=true", fatal=True, code="backend_start_failed")
                self._fatal_error = error
                raise error from exc
            self._process = process
            self._start_stderr_reader(process)
            reader = threading.Thread(target=self._read_stdout_forever, args=(process,), daemon=True, name="chatgpt-backend-stdout")
            self._reader_thread = reader
            reader.start()
            return process

    def _write_json_line(self, request: dict[str, Any], *, perform_handshake: bool = True) -> None:
        if perform_handshake:
            self._ensure_handshake()
        try:
            encoded = json.dumps(
                request,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8") + b"\n"
        except (TypeError, ValueError, UnicodeEncodeError, RecursionError) as exc:
            # Never include repr(value): operation payloads can contain raw
            # prompts and local paths.  Reject non-finite, cyclic,
            # unserializable, or invalid-Unicode payloads before any bytes are
            # written and keep the negotiated sidecar reusable.
            raise BackendTransportError(
                "Backend request is not finite valid UTF-8 JSON.",
                code="invalid_backend_request",
            ) from exc
        if len(encoded) - 1 > self.frame_limit_bytes:
            raise BackendTransportError(f"Backend request frame exceeds the {self.frame_limit_bytes} byte limit.", code="backend_frame_too_large")
        raw_request_id = request.get("requestId")
        request_id = raw_request_id if isinstance(raw_request_id, str) else ""
        admission = self._admit_write(request_id if is_valid_backend_request_id(request_id) else "", len(encoded))
        try:
            # Admission is charged before waiting for the single pipe writer.
            # The lock protects one frame's write/flush only; it is not held
            # across handshake, response, or stream consumption.
            with self._write_lock:
                with self._state_lock:
                    process = self._start()
                    if is_valid_backend_request_id(request_id):
                        if request_id in self._cancelled_reservations:
                            raise BackendTransportError(
                                f"Backend requestId {request_id!r} was cancelled before it was written.",
                                code="backend_request_cancelled",
                            )
                        if request_id in self._unresolved_tombstones:
                            tombstone = self._unresolved_tombstones[request_id]
                            raise BackendTransportError(
                                f"Backend requestId {request_id!r} is no longer writable ({tombstone.reason}).",
                                unresolved=True,
                                code="backend_request_cancelled" if "cancel" in tombstone.reason else "request_id_reused",
                            )
                        if request_id not in self._routes:
                            raise BackendTransportError(
                                f"Backend requestId {request_id!r} has no active route.",
                                code="backend_request_cancelled",
                            )
                    stdin = process.stdin
                    if stdin is None:
                        error = BackendTransportError("Backend process stdin is unavailable.", fatal=True, unresolved=True, code="backend_closed")
                        self._fail_all(error)
                        raise error
                    admission.started = True
                    if is_valid_backend_request_id(request_id):
                        self._written_request_ids.add(request_id)
                try:
                    stdin.write(encoded)
                    stdin.flush()
                except (BrokenPipeError, OSError) as exc:
                    error = self._process_error("Backend process exited before accepting a request.")
                    error.unresolved = True
                    self._fail_all(error)
                    raise error from exc
        finally:
            self._release_write(admission)

    def _admit_write(self, request_id: str, byte_count: int) -> _WriteAdmission:
        if byte_count <= 0:
            raise BackendTransportError("Backend request frame is empty.", code="invalid_backend_request")
        with self._state_lock:
            if len(self._active_writes) >= self.write_queue_limit or (
                self._write_queue_bytes > self.write_queue_bytes_limit - byte_count
            ):
                raise BackendTransportError(
                    "Backend outbound request buffering exceeded its bounded limit.",
                    unresolved=False,
                    code="backend_write_queue_overflow",
                )
            admission = _WriteAdmission(request_id=request_id, byte_count=byte_count)
            self._active_writes.add(admission)
            self._write_queue_bytes += byte_count
            return admission

    def _release_write(self, admission: _WriteAdmission) -> None:
        with self._state_lock:
            if admission.released:
                return
            admission.released = True
            if admission not in self._active_writes:
                return
            self._active_writes.remove(admission)
            self._write_queue_bytes = max(0, self._write_queue_bytes - admission.byte_count)

    def _has_started_write(self, request_id: str) -> bool:
        with self._state_lock:
            return any(
                admission.request_id == request_id and admission.started and not admission.released
                for admission in self._active_writes
            )

    def _read_stdout_forever(self, process: subprocess.Popen[Any]) -> None:
        stdout = process.stdout
        if stdout is None:
            self._fail_all(BackendTransportError("Backend process stdout is unavailable.", fatal=True, code="backend_closed"))
            return
        buffered = bytearray()
        frame_start = 0
        try:
            while True:
                chunk = stdout.read(65536)
                if chunk in (b"", ""):
                    break
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8")
                buffered.extend(chunk)
                if len(buffered) - frame_start > self.frame_limit_bytes and buffered.find(b"\n", frame_start) < 0:
                    raise BackendTransportError(f"Backend frame exceeds the {self.frame_limit_bytes} byte limit.", fatal=True, code="backend_frame_too_large")
                while True:
                    try:
                        newline = buffered.index(0x0A, frame_start)
                    except ValueError:
                        break
                    frame = bytes(buffered[frame_start:newline])
                    frame_start = newline + 1
                    if len(frame) > self.frame_limit_bytes:
                        raise BackendTransportError(f"Backend frame exceeds the {self.frame_limit_bytes} byte limit.", fatal=True, code="backend_frame_too_large")
                    if frame.endswith(b"\r"):
                        frame = frame[:-1]
                    try:
                        line = frame.decode("utf-8")
                    except UnicodeDecodeError as exc:
                        raise BackendTransportError("Backend stdout contained invalid UTF-8.", fatal=True, code="invalid_backend_framing") from exc
                    self._route_stdout_line(line)
                    with self._state_lock:
                        if self._closed or self._process is not process:
                            return
                    if frame_start == len(buffered):
                        buffered.clear()
                        frame_start = 0
                    elif frame_start >= 64 * 1024 and frame_start >= len(buffered) // 2:
                        del buffered[:frame_start]
                        frame_start = 0
            if len(buffered) - frame_start > 0:
                raise BackendTransportError("Backend stdout ended with an unterminated NDJSON frame.", fatal=True, code="backend_unterminated_frame")
        except BackendTransportError as exc:
            self._fail_all(exc)
            return
        except (ValueError, OSError):
            self._fail_all(self._process_error("Backend process stdout read failed."))
            return
        with self._state_lock:
            closed = self._closed or self._process is not process
        if not closed:
            self._fail_all(self._process_error("Backend process ended without producing a response."))

    def _route_stdout_line(self, line: str) -> None:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            self._fail_all(BackendTransportError("Backend returned invalid JSON.", fatal=True, code="invalid_backend_json"))
            return
        if not isinstance(value, dict):
            self._fail_all(BackendTransportError("Backend stdout record must be a JSON object.", fatal=True, code="invalid_backend_message"))
            return
        try:
            schema = value.get("schemaVersion")
            if schema == BACKEND_RESPONSE_SCHEMA_VERSION:
                request_id = _require_message_request_id(value, label="response")
                self._validate_response_shape(value, request_id)
                kind: _RouteKind = "unary"
            elif schema == BACKEND_EVENT_SCHEMA_VERSION:
                request_id = _require_message_request_id(value, label="event")
                self._validate_event_shape(value, request_id)
                kind = "stream"
            else:
                raise BackendTransportError("Backend emitted an unsupported protocol schema.", fatal=True, code="unsupported_backend_schema")
        except BackendTransportError as exc:
            self._fail_all(exc)
            return
        with self._state_lock:
            self._prune_tombstones_locked()
            route = self._routes.get(request_id)
            tombstone = self._unresolved_tombstones.get(request_id)
            if route is None and tombstone is None:
                self._begin_quarantine_locked(f"Backend emitted an unknown requestId {request_id!r}.")
                return
            if route is not None and route.kind != kind:
                self._fail_all(BackendTransportError(f"Backend emitted a {kind} record for {route.kind} requestId {request_id!r}.", fatal=True, code="unexpected_backend_message"))
                return
            if route is None and tombstone is not None and tombstone.kind != kind:
                self._fail_all(BackendTransportError(f"Backend emitted a {kind} record for tombstoned {tombstone.kind} requestId {request_id!r}.", fatal=True, code="unexpected_backend_message"))
                return
        if route is None:
            assert tombstone is not None
            if tombstone.expires_at > time.monotonic() and (kind == "unary" or value.get("type") in {"completed", "error"}):
                self._resolve_tombstone(request_id)
            return
        terminal = kind == "stream" and value.get("type") in {"completed", "error"}
        delivered = route.offer(value, terminal=terminal)
        if kind == "unary" or terminal or not delivered:
            error = route.error
            self._retire(request_id, route, unresolved=error.unresolved if error is not None else not delivered, reason="stream_overflow" if not delivered else "terminal")

    def _validate_response_shape(self, value: dict[str, Any], request_id: str) -> None:
        _ensure_allowed_keys(value, {"schemaVersion", "requestId", "ok", "result", "error"}, label="response")
        ok = value.get("ok")
        if not isinstance(ok, bool):
            raise BackendTransportError(f"Backend response for requestId {request_id} is missing boolean ok.", fatal=True, code="invalid_backend_response")
        if ok:
            if "result" not in value or "error" in value:
                raise BackendTransportError(f"Backend response for requestId {request_id} has an invalid result branch.", fatal=True, code="invalid_backend_response")
            return
        error = value.get("error")
        if "result" in value or not isinstance(error, dict):
            raise BackendTransportError(f"Backend error response for requestId {request_id} is malformed.", fatal=True, code="invalid_backend_response")
        _ensure_allowed_keys(error, {"code", "message", "recoverable"}, label="error response")
        if not isinstance(error.get("code"), str) or not error["code"] or not isinstance(error.get("message"), str) or not error["message"] or not isinstance(error.get("recoverable"), bool):
            raise BackendTransportError(f"Backend error response for requestId {request_id} is malformed.", fatal=True, code="invalid_backend_response")

    def _validate_event_shape(self, value: dict[str, Any], request_id: str) -> None:
        event_type = value.get("type")
        if not isinstance(event_type, str):
            raise BackendTransportError(f"Backend event for requestId {request_id} is missing type.", fatal=True, code="invalid_backend_event")
        if event_type == "run_item_stream_event":
            _ensure_allowed_keys(value, {"schemaVersion", "requestId", "type", "name", "item"}, label="event")
            if not isinstance(value.get("name"), str) or not value["name"] or not isinstance(value.get("item"), dict):
                raise BackendTransportError(f"Backend run-item event for requestId {request_id} is malformed.", fatal=True, code="invalid_backend_event")
        elif event_type == "agent_updated_stream_event":
            _ensure_allowed_keys(value, {"schemaVersion", "requestId", "type", "agent"}, label="event")
            if not isinstance(value.get("agent"), dict):
                raise BackendTransportError(f"Backend agent-update event for requestId {request_id} is malformed.", fatal=True, code="invalid_backend_event")
        elif event_type == "completed":
            _ensure_allowed_keys(value, {"schemaVersion", "requestId", "type", "result"}, label="event")
            if "result" not in value:
                raise BackendTransportError(f"Backend completed event for requestId {request_id} is missing result.", fatal=True, code="invalid_backend_event")
        elif event_type == "error":
            _ensure_allowed_keys(value, {"schemaVersion", "requestId", "type", "error"}, label="event")
            error = value.get("error")
            if not isinstance(error, dict):
                raise BackendTransportError(f"Backend error event for requestId {request_id} is malformed.", fatal=True, code="invalid_backend_event")
            _ensure_allowed_keys(error, {"code", "message", "recoverable"}, label="error event")
            if not isinstance(error.get("code"), str) or not error["code"] or not isinstance(error.get("message"), str) or not error["message"] or not isinstance(error.get("recoverable"), bool):
                raise BackendTransportError(f"Backend error event for requestId {request_id} is malformed.", fatal=True, code="invalid_backend_event")
        else:
            raise BackendTransportError(f"Backend event for requestId {request_id} has unsupported type {event_type!r}.", fatal=True, code="invalid_backend_event")

    def _raise_protocol_error(self, value: dict[str, Any], *, stream: bool = False) -> None:
        error = value.get("error")
        label = "stream" if stream else "response"
        if not isinstance(error, dict):
            raise BackendTransportError(f"Backend {label} error is missing error details.", code="invalid_backend_response")
        raise BackendProtocolError(str(error["code"]), str(error["message"]), recoverable=bool(error["recoverable"]))

    def _await_unary(self, route: _Route, *, timeout_seconds: float | None = None) -> BackendResponse:
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        if not route.done.wait(timeout=timeout):
            error = BackendTransportError(f"Backend timed out after {timeout} seconds.", fatal=False, unresolved=True, code="backend_timeout")
            route.fail(error)
            raise error
        error = route.error
        if error is not None:
            raise error
        try:
            return route.take_nowait()
        except queue.Empty as exc:
            raise BackendTransportError("Backend completed a unary request without a response.", code="invalid_backend_response") from exc

    def _open_stream(self, request: dict[str, Any], request_id: str) -> _Route:
        self._ensure_handshake()
        release = self._acquire_single_flight()
        route: _Route | None = None
        try:
            route = self._register(request_id, "stream", release)
            self._write_json_line(request, perform_handshake=False)
            return route
        except BaseException as exc:
            if route is None:
                if release is not None:
                    release()
                self._release_reservation(request_id)
            else:
                error = exc if isinstance(exc, BackendTransportError) else BackendTransportError(str(exc), unresolved=True)
                route.fail(error)
                self._retire(
                    request_id,
                    route,
                    unresolved=error.unresolved or self._has_started_write(request_id),
                    reason="stream_write_failed",
                )
            raise

    def _cancel(self, request_id: str, route: _Route | None, *, reason: str, kind: _RouteKind | None = None) -> bool:
        selected: _Route | None = None
        release: Callable[[], None] | None = None
        with self._state_lock:
            active = self._routes.get(request_id)
            if route is not None and active is not route:
                # A late close/cancel from an older route must never cancel a
                # newer route that reused the same request ID.
                return False
            if active is not None:
                self._routes.pop(request_id, None)
            if active is not None:
                selected = route or active
                release = active.take_legacy_release()
                self._pop_reservation_locked(request_id)
                self._pre_reserved_ids.discard(request_id)
                if self._has_started_write(request_id) or request_id in self._written_request_ids:
                    self._record_unresolved_locked(request_id, active.kind, reason=reason)
            elif request_id in self._reservations:
                self._pop_reservation_locked(request_id)
                self._pre_reserved_ids.discard(request_id)
                self._cancelled_reservations.add(request_id)
                # Keep a cancellation marker until the worker consumes it.
                # BackendClient.request_async can instead call
                # ``release_request_id`` when its owned executor proves that
                # the queued provider call never started.
                self._record_unresolved_locked(request_id, kind or "unary", reason="reservation_cancelled")
                return True
            elif request_id in self._unresolved_tombstones:
                return False
            else:
                return False
        if selected is not None:
            selected.fail(
                BackendTransportError(
                    f"Backend request {request_id} was cancelled locally.",
                    fatal=False,
                    unresolved=True,
                    code="backend_request_cancelled",
                )
            )
        if release is not None:
            release()
        return True

    def release_request_id(self, request_id: str) -> bool:
        """Release a reservation known never to have reached the provider.

        This is intentionally separate from ``cancel``.  A cancellation of a
        running async worker must retain a late-output guard, while executor
        admission failure or queued-never-started cancellation has no possible
        backend output and should not leave a tombstone or cancellation marker
        behind.
        """

        with self._state_lock:
            if request_id in self._routes or self._has_started_write(request_id) or request_id in self._written_request_ids:
                return False
            existed = (
                request_id in self._reservations
                or request_id in self._pre_reserved_ids
                or request_id in self._cancelled_reservations
                or request_id in self._unresolved_tombstones
            )
            self._pop_reservation_locked(request_id)
            self._pre_reserved_ids.discard(request_id)
            self._cancelled_reservations.discard(request_id)
            self._unresolved_tombstones.pop(request_id, None)
            self._written_request_ids.discard(request_id)
            self._schedule_tombstone_expiry_locked()
            return existed

    def _retire(self, request_id: str, route: _Route | None = None, *, unresolved: bool = False, reason: str = "terminal") -> None:
        release: Callable[[], None] | None = None
        with self._state_lock:
            active = self._routes.get(request_id)
            if route is not None and active is not route:
                # The route was already retired (or its ID was subsequently
                # reused); do not remove the newer reservation or create a
                # tombstone for the stale route.
                return
            if route is None or active is route:
                self._routes.pop(request_id, None)
                if route is not None:
                    release = route.take_legacy_release()
            actual_kind = route.kind if route is not None else active.kind if active is not None else None
            if route is None or active is route:
                self._pop_reservation_locked(request_id)
                self._pre_reserved_ids.discard(request_id)
                self._cancelled_reservations.discard(request_id)
                if not unresolved:
                    self._written_request_ids.discard(request_id)
            if unresolved and actual_kind is not None:
                self._record_unresolved_locked(request_id, actual_kind, reason=reason)
        if release is not None:
            release()

    def _release_legacy(self, route: _Route) -> None:
        release = route.take_legacy_release()
        if release is not None:
            release()

    def _record_unresolved_locked(self, request_id: str, kind: _RouteKind, *, reason: str) -> None:
        self._prune_tombstones_locked()
        if request_id in self._unresolved_tombstones:
            return
        if len(self._unresolved_tombstones) >= self.max_tombstones:
            self._begin_quarantine_locked(f"Backend tombstone limit {self.max_tombstones} was reached; sidecar reuse is unsafe.")
            return
        grace = self.tombstone_grace_seconds
        if grace is None:
            grace = self.tombstone_ttl_seconds
        if grace is None:
            grace = DEFAULT_BACKEND_LATE_OUTPUT_GRACE_SECONDS
        self._unresolved_tombstones[request_id] = _Tombstone(request_id, kind, time.monotonic() + grace, reason)
        self._schedule_tombstone_expiry_locked()

    def _prune_tombstones_locked(self) -> None:
        if any(tombstone.expires_at <= time.monotonic() for tombstone in self._unresolved_tombstones.values()):
            self._begin_quarantine_locked("A cancelled or timed-out backend route did not produce terminal output within its bounded drain grace.")

    def _schedule_tombstone_expiry_locked(self) -> None:
        if not self._unresolved_tombstones or self._quarantine_error is not None:
            timer = self._tombstone_timer
            self._tombstone_timer = None
            self._tombstone_timer_deadline = None
            if timer is not None:
                timer.cancel()
            return
        deadline = min(tombstone.expires_at for tombstone in self._unresolved_tombstones.values())
        if (
            self._tombstone_timer is not None
            and self._tombstone_timer.is_alive()
            and self._tombstone_timer_deadline is not None
            and self._tombstone_timer_deadline <= deadline
        ):
            return
        timer = self._tombstone_timer
        if timer is not None:
            timer.cancel()
        self._tombstone_timer_deadline = deadline
        timer = threading.Timer(max(0.01, deadline - time.monotonic()), self._expire_tombstones)
        timer.daemon = True
        self._tombstone_timer = timer
        timer.start()

    def _expire_tombstones(self) -> None:
        with self._state_lock:
            self._tombstone_timer = None
            self._tombstone_timer_deadline = None
            self._prune_tombstones_locked()
            self._schedule_tombstone_expiry_locked()

    def _resolve_tombstone(self, request_id: str) -> None:
        with self._state_lock:
            self._unresolved_tombstones.pop(request_id, None)
            self._written_request_ids.discard(request_id)
            self._schedule_tombstone_expiry_locked()

    def _begin_quarantine_locked(self, reason: str) -> None:
        if self._quarantine_error is not None:
            return
        if self._quarantine_timer is not None:
            self._quarantine_timer.cancel()
        error = BackendTransportError(reason, fatal=False, code="backend_protocol_quarantined")
        self._quarantine_error = error
        grace = self.quarantine_grace_seconds
        if grace is None:
            grace = max(0.5, min(self.timeout_seconds, 5.0))
        self._quarantine_deadline = time.monotonic() + grace
        timer = threading.Timer(grace, self._expire_quarantine)
        timer.daemon = True
        self._quarantine_timer = timer
        timer.start()

    def _expire_quarantine(self) -> None:
        with self._state_lock:
            self._quarantine_timer = None
            error = self._quarantine_error
            deadline = self._quarantine_deadline
            if error is None:
                return
            if deadline is not None and deadline > time.monotonic():
                timer = threading.Timer(deadline - time.monotonic(), self._expire_quarantine)
                timer.daemon = True
                self._quarantine_timer = timer
                timer.start()
                return
        error.fatal = True
        self._fail_all(error)

    def _fail_all(self, error: BackendTransportError) -> None:
        with self._state_lock:
            fatal_error = self._fatal_error
            if fatal_error is None:
                fatal_error = error
                self._fatal_error = fatal_error
            routes = list(self._routes.values())
            self._routes.clear()
            self._reservations.clear()
            self._control_reservations = 0
            self._pre_reserved_ids.clear()
            self._cancelled_reservations.clear()
            self._written_request_ids.clear()
            process = self._process
            should_cleanup = process is not None and not self._fatal_cleanup_started
            if should_cleanup:
                self._fatal_cleanup_started = True
        for route in routes:
            route.fail(fatal_error)
            self._release_legacy(route)
        if should_cleanup:
            threading.Thread(target=self._recycle_process, args=(process,), daemon=True, name="chatgpt-backend-recycle").start()

    def _recycle_process(self, process: subprocess.Popen[Any] | None) -> None:
        if process is None:
            return
        self._terminate_process(process)
        with self._state_lock:
            if self._process is process:
                self._process = None
                self._reader_thread = None
                self._stderr_thread = None
                self._unresolved_tombstones.clear()
                if self._tombstone_timer is not None:
                    self._tombstone_timer.cancel()
                self._tombstone_timer = None
                self._tombstone_timer_deadline = None
                if self._quarantine_timer is not None:
                    self._quarantine_timer.cancel()
                self._quarantine_error = None
                self._quarantine_timer = None
                self._quarantine_deadline = None
                self._fatal_cleanup_started = False
                self._control_reservations = 0
                if not self._closed and self._handshake_state != "blocked":
                    self._handshake_state = "unknown"
                    self._handshake_error = None

    def _terminate_process(self, process: subprocess.Popen[Any] | None) -> None:
        if process is None:
            return
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1)
        except (OSError, ValueError):
            pass
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    if stream is not None and not stream.closed:
                        stream.close()
                except (OSError, ValueError):
                    pass
            reader = self._reader_thread
            if reader is not None and reader is not threading.current_thread() and reader.is_alive():
                reader.join(timeout=0.5)
            stderr_reader = self._stderr_thread
            if stderr_reader is not None and stderr_reader is not threading.current_thread() and stderr_reader.is_alive():
                stderr_reader.join(timeout=0.2)

    def _process_error(self, message: str, *, wait_timeout: float = 1.0, stderr_timeout: float = 0.5) -> BackendTransportError:
        process = self._process
        returncode = process.poll() if process is not None else None
        if process is not None and returncode is None:
            try:
                returncode = process.wait(timeout=wait_timeout)
            except subprocess.TimeoutExpired:
                returncode = None
        stderr_reader = self._stderr_thread
        if stderr_reader is not None and stderr_reader is not threading.current_thread() and stderr_reader.is_alive():
            stderr_reader.join(timeout=stderr_timeout)
        rendered_message = message if returncode is None else f"{message} Backend process exited with {returncode}."
        return BackendTransportError(
            rendered_message,
            returncode=returncode,
            stderr=self._read_stderr(process),
            fatal=True,
            code="backend_exited" if returncode is not None else "backend_transport_error",
        )

    def _fatal_recycling_error_locked(self) -> BackendTransportError:
        error = self._fatal_error
        if error is not None:
            return error
        return BackendTransportError(
            "Backend transport is recycling a failed sidecar.",
            fatal=True,
            unresolved=True,
            code="backend_recycling",
        )

    def _start_stderr_reader(self, process: subprocess.Popen[Any]) -> None:
        stderr = process.stderr
        if stderr is None:
            return

        def drain() -> None:
            try:
                while True:
                    chunk = stderr.read(65536)
                    if chunk in (b"", ""):
                        return
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8", errors="replace")
                    self._append_stderr(len(chunk))
            except (ValueError, OSError):
                return

        self._stderr_thread = threading.Thread(target=drain, daemon=True, name="chatgpt-backend-stderr")
        self._stderr_thread.start()

    def _append_stderr(self, byte_count: int | str) -> None:
        count = byte_count if isinstance(byte_count, int) else len(byte_count.encode("utf-8", errors="replace"))
        with self._stderr_lock:
            self._stderr_bytes = min(MAX_BACKEND_BUFFER_LIMIT, self._stderr_bytes + max(0, count))
            self._stderr_truncated = self._stderr_truncated or self._stderr_bytes >= MAX_BACKEND_BUFFER_LIMIT

    def _read_stderr(self, process: subprocess.Popen[Any] | None) -> str:
        if process is None:
            return ""
        with self._stderr_lock:
            if self._stderr_bytes <= 0:
                return ""
            suffix = f"stderr_present=true stderr_bytes={self._stderr_bytes}"
            return f"{suffix} stderr_truncated=true" if self._stderr_truncated else suffix


def _blocked_compatibility_report() -> dict[str, Any]:
    return {
        "schemaVersion": BACKEND_COMPATIBILITY_SCHEMA_VERSION,
        "status": "blocked",
        "mode": "unknown",
        "warnings": [{
            "code": "negotiation_rejected",
            "message": "Backend compatibility negotiation was rejected.",
        }],
    }


def _compatibility_report(
    identity: dict[str, Any],
    *,
    expected: dict[str, str | None],
    mode: Literal["multiplexed", "single-flight", "legacy"],
    legacy: bool = False,
) -> dict[str, Any]:
    warnings_list: list[dict[str, Any]] = []
    fields: tuple[tuple[str, str, str], ...] = (
        ("backendSessionId", "backend session identity", "provenance_unknown"),
        ("packageName", "package name", "package_name_mismatch"),
        ("packageVersion", "package version", "package_version_mismatch"),
        ("runtime", "runtime", "runtime_mismatch"),
        ("runtimeVersion", "runtime version", "runtime_version_mismatch"),
        ("buildDigest", "build digest", "build_digest_mismatch"),
    )
    for field, label, mismatch_code in fields:
        actual = identity.get(field)
        received = actual if _is_bounded_identity_field(actual) else None
        if received is None or received == "unknown":
            warning: dict[str, Any] = {
                "code": "provenance_unknown",
                "message": f"Backend {label} provenance is unknown.",
            }
            if field != "backendSessionId":
                warning["field"] = field
            if received is not None:
                warning["received"] = received
            warnings_list.append(warning)
            continue
        wanted = expected.get(field)
        if _is_bounded_identity_field(wanted) and wanted != "unknown" and wanted != received:
            warning = {
                "code": mismatch_code,
                "field": field,
                "expected": wanted,
                "received": received,
                "message": f"Backend {label} differs from the expected runtime ({wanted} versus {received}).",
            }
            warnings_list.append(warning)
    if legacy:
        warnings_list.insert(0, {
            "code": "legacy_backend",
            "message": "Backend negotiated legacy single-flight compatibility; multiplexing was not advertised.",
        })
    warnings_list = warnings_list[:16]
    status = "warning" if any(item["code"] != "provenance_unknown" for item in warnings_list) else "unknown" if warnings_list else "compatible"
    report: dict[str, Any] = {
        "schemaVersion": BACKEND_COMPATIBILITY_SCHEMA_VERSION,
        "status": status,
        "mode": mode,
        "warnings": warnings_list,
    }
    for field in ("protocolVersion", "backendSessionId", "packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest"):
        value = identity.get(field)
        if _is_bounded_identity_field(value):
            report[field] = value
    return report


class BackendClient:
    def __init__(self, transport: BackendTransport) -> None:
        self._transport = transport
        self._request_id_lock = threading.Lock()
        self._next_request_id = 0
        self._request_id_prefix = f"py_client_{secrets.token_hex(16)}"

    def compatibility_report(self) -> dict[str, Any] | None:
        report = getattr(self._transport, "compatibility_report", None)
        if not callable(report):
            return None
        value = report()
        return value if isinstance(value, dict) else None

    def request(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        response = self._transport.request(self._envelope(command, payload or {}))
        return self._unwrap_response(response)

    async def request_async(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        envelope = self._envelope(command, payload or {})
        request_id = str(envelope["requestId"])
        reserve = getattr(self._transport, "reserve_request_id", None)
        if callable(reserve):
            reserve(request_id, "unary")
        try:
            # Route blocking sidecar I/O through the async client's owned,
            # bounded executor. Falling back to its module-owned lifecycle
            # keeps direct BackendClient.request_async callers off the event
            # loop's process-wide default executor as well.
            from .async_client import _run_in_execution

            response = await _run_in_execution(self._transport.request, envelope)
        except asyncio.CancelledError as error:
            # The owned executor annotates cancellation when the queued
            # provider call never started.  Such a reservation has no possible
            # late output and can be released outright; a started worker keeps
            # the transport's tombstone/cancellation guard.
            if not bool(getattr(error, "started", True)):
                release = getattr(self._transport, "release_request_id", None)
                if callable(release) and release(request_id):
                    raise
            cancel = getattr(self._transport, "cancel", None)
            if callable(cancel):
                cancel(request_id)
            raise
        except BaseException:
            # Executor admission/submission failures happen before the
            # provider call and otherwise strand the pre-reservation forever.
            # A transport with a live route declines this release, preserving
            # its normal late-output lifecycle.
            release = getattr(self._transport, "release_request_id", None)
            if callable(release):
                release(request_id)
            raise
        return self._unwrap_response(response)

    def stream(self, command: str, payload: dict[str, Any] | None = None) -> Iterator[BackendEvent]:
        return self._transport.stream(self._envelope(command, payload or {}))

    def cancel_request(self, request_id: str) -> None:
        cancel = getattr(self._transport, "cancel", None)
        if callable(cancel):
            cancel(request_id)

    def runner_run(self, agent: dict[str, Any], input: Any) -> dict[str, Any]:
        result = self.request("runner.run", {"agent": agent, "input": input})
        if not isinstance(result, dict):
            raise BackendTransportError("runner.run result must be a JSON object.")
        return result

    def runner_plan(self, agent: dict[str, Any], input: Any) -> dict[str, Any]:
        result = self.request("runner.plan", {"agent": agent, "input": input})
        if not isinstance(result, dict):
            raise BackendTransportError("runner.plan result must be a JSON object.")
        return result

    def runner_stream(self, agent: dict[str, Any], input: Any) -> Iterator[BackendEvent]:
        return self.stream("runner.stream", {"agent": agent, "input": input})

    def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        agent = payload.get("agent")
        if not isinstance(agent, dict):
            raise BackendTransportError("Legacy run payload must include agent as an object.")
        return self.runner_run(agent, payload.get("input"))

    def capabilities(self) -> dict[str, Any]:
        result = self.request("backend.capabilities")
        if not isinstance(result, dict):
            raise BackendTransportError("backend.capabilities result must be a JSON object.")
        return result

    def health(self) -> dict[str, Any]:
        result = self.request("backend.health")
        if not isinstance(result, dict):
            raise BackendTransportError("backend.health result must be a JSON object.")
        return result

    def close(self) -> None:
        self._transport.close()

    def _envelope(self, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        allocate = getattr(self._transport, "allocate_request_id", None)
        if callable(allocate):
            request_id = str(allocate())
        else:
            with self._request_id_lock:
                self._next_request_id += 1
                request_id = f"{self._request_id_prefix}_{self._next_request_id}"
        return BackendRequest(command, payload, request_id).to_wire()

    def _unwrap_response(self, response: BackendResponse) -> Any:
        if response.get("ok") is False:
            error = response.get("error")
            if isinstance(error, dict):
                raise BackendProtocolError(
                    str(error.get("code", "backend_error")),
                    str(error.get("message", "Backend protocol error.")),
                    recoverable=bool(error.get("recoverable", False)),
                )
            raise BackendProtocolError("backend_error", "Backend protocol error.", recoverable=False)
        return response.get("result")
