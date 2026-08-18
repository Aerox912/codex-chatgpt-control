from __future__ import annotations

from typing import Any

from .commands import wire_kwargs
from .models import CommandResult
from .operation_models import BackendCompatibilityReport
from .primitives import command_result


class WorkflowClient:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def ask(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "ask", wire_kwargs(**kwargs))

    def ask_in_thread(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "askInThread", wire_kwargs(**kwargs))

    def ask_with_files(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "askWithFiles", wire_kwargs(**kwargs))

    def ask_and_download(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "askAndDownload", wire_kwargs(**kwargs))

    def run_messages(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "runMessages", wire_kwargs(**kwargs))

    def open_thread(self, thread: dict[str, Any]) -> CommandResult:
        return command_result(self._backend, "openThread", thread)

    def read_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "readLatest", wire_kwargs(**kwargs))

    def copy_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "copyLatest", wire_kwargs(**kwargs))

    def download_latest(self, **kwargs: Any) -> CommandResult:
        return command_result(self._backend, "downloadLatest", wire_kwargs(**kwargs))

    def run_plan(self, plan: dict[str, Any]) -> CommandResult:
        return command_result(self._backend, "runPlan", plan)

    def doctor(self, **kwargs: Any) -> CommandResult:
        result = command_result(self._backend, "doctor", wire_kwargs(**kwargs))
        return _attach_doctor_compatibility(result, self._backend, kwargs)

    def create_report(self, result: dict[str, Any], **kwargs: Any) -> CommandResult:
        payload: dict[str, Any] = {"result": result}
        args = wire_kwargs(**kwargs)
        if args:
            payload["args"] = args
        return command_result(self._backend, "createReport", payload)


def _attach_doctor_compatibility(result: CommandResult, backend: Any, kwargs: dict[str, Any]) -> CommandResult:
    getter = getattr(backend, "compatibility_report", None)
    if not callable(getter):
        return result
    requested = kwargs.get("check")
    if isinstance(requested, list) and "compatibility" not in requested:
        return result
    report = getter()
    if not isinstance(report, dict):
        return result
    try:
        parsed = BackendCompatibilityReport.from_wire(report)
    except (TypeError, ValueError):
        return result
    if not isinstance(result.data, dict):
        return result
    checks = result.data.get("checks")
    if not isinstance(checks, dict):
        checks = {}
    warning = parsed.warnings[0] if parsed.warnings else None
    status = "blocked" if parsed.status == "blocked" else "unknown" if parsed.status in {"warning", "unknown"} else "ok"
    compatibility = {
        "status": status,
        "message": warning.message if warning is not None else "Backend protocol and advertised capabilities are compatible.",
        "details": parsed.to_wire(),
    }
    if warning is not None:
        compatibility["code"] = warning.code
    data = dict(result.data)
    data["checks"] = {**checks, "compatibility": compatibility}
    return result.model_copy(update={"data": data})
