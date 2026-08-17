from __future__ import annotations

import inspect
import re
from datetime import datetime, timezone
from typing import Any

from .commands import request_backend, wire_kwargs
from .models import CommandResult


_TRANSACTIONAL_OPERATION_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_SAFE_BACKEND_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _transactional_command_error_result(
    payload: dict[str, Any],
    error: Exception,
) -> CommandResult | None:
    """Map an indeterminate high-level transport failure without losing intent.

    Only a canonical operation ID opts into this mapping. Legacy calls retain
    their existing exception behavior, and arbitrary caller strings are never
    reflected into an error envelope. The same operation ID can be retried
    safely against the durable Node journal; generating a replacement ID cannot.
    """

    operation_id = payload.get("operationId")
    if (
        type(operation_id) is not str
        or _TRANSACTIONAL_OPERATION_ID_PATTERN.fullmatch(operation_id) is None
    ):
        return None
    try:
        static_code = inspect.getattr_static(error, "code", None)
    except Exception:
        static_code = None
    cause_code = (
        static_code
        if type(static_code) is str and _SAFE_BACKEND_CODE_PATTERN.fullmatch(static_code)
        else "operation_transport_error"
    )
    message = "Transactional operation transport outcome is uncertain; reuse the same operation ID."
    return CommandResult.from_wire({
        "ok": False,
        "status": "partial",
        "data": {
            "operationId": operation_id,
            "submissionState": "submitted_unconfirmed",
            "completionState": "unknown",
            "complete": False,
        },
        "warnings": [],
        "context": {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        },
        "blocker": {
            "kind": "unknown",
            "code": "operation_transport_uncertain",
            "causeCode": cause_code,
            "message": message,
            "resumable": True,
        },
        "error": {
            "name": "OperationTransportError",
            "message": message,
            "recoverable": True,
        },
    })


def command_result(backend: Any, command: str, payload: dict[str, Any] | None = None) -> CommandResult:
    request_payload = payload or {}
    try:
        result = request_backend(backend, command, request_payload)
        if not isinstance(result, dict):
            raise RuntimeError(f"{command} backend result must be a CommandResult object.")
        return CommandResult.from_wire(result)
    except Exception as error:
        transactional = _transactional_command_error_result(request_payload, error)
        if transactional is not None:
            return transactional
        raise


class SessionClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def bootstrap(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "session.bootstrap", wire_kwargs(**kwargs))


class ExperienceClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def detect(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "experience.detect", wire_kwargs(**kwargs))

    def open(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "experience.open", wire_kwargs(**kwargs))


class ConfigurationClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def inspect(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "configuration.inspect", wire_kwargs(**kwargs))

    def apply(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "configuration.apply", wire_kwargs(**kwargs))


class ThreadsClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def new(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "threads.new", wire_kwargs(**kwargs))

    def search(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "threads.search", wire_kwargs(**kwargs))

    def open(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "threads.open", wire_kwargs(**kwargs))


class MessagesClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def compose(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.compose", wire_kwargs(**kwargs))

    def submit(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.submit", wire_kwargs(**kwargs))

    def ask(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.ask", wire_kwargs(**kwargs))

    def wait(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.wait", wire_kwargs(**kwargs))

    def read_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.readLatest", wire_kwargs(**kwargs))

    def status(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.status", wire_kwargs(**kwargs))

    def stop(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.stop", wire_kwargs(**kwargs))

    def wait_and_read(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "messages.waitAndRead", wire_kwargs(**kwargs))


class FilesClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def preflight(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "files.preflight", wire_kwargs(**kwargs))

    def attach(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "files.attach", wire_kwargs(**kwargs))

    def download_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "files.downloadLatest", wire_kwargs(**kwargs))


class ProjectSourcesClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def list(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "projects.sources.list", wire_kwargs(**kwargs))

    def plan_add(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "projects.sources.planAdd", wire_kwargs(**kwargs))

    def add(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "projects.sources.add", wire_kwargs(**kwargs))


class ProjectsClient:
    def __init__(self, backend: Any) -> None:
        self.sources = ProjectSourcesClient(backend)


class ArtifactsClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def list_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "artifacts.listLatest", wire_kwargs(**kwargs))

    def wait(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "artifacts.wait", wire_kwargs(**kwargs))

    def download_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "artifacts.downloadLatest", wire_kwargs(**kwargs))


class WorkClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend
        self.artifacts = ArtifactsClient(backend)

    def start(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "work.start", wire_kwargs(**kwargs))

    def status(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "work.status", wire_kwargs(**kwargs))

    def wait(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "work.wait", wire_kwargs(**kwargs))

    def steer(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "work.steer", wire_kwargs(**kwargs))

    def read_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "work.readLatest", wire_kwargs(**kwargs))


class ModesClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def set(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "modes.set", wire_kwargs(**kwargs))

    def get(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "modes.get", wire_kwargs(**kwargs))


class ToolsClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def select(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "tools.select", wire_kwargs(**kwargs))


class ResponseClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def copy(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "response.copy", wire_kwargs(**kwargs))
