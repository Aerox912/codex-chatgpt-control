from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .agent import Agent
from .commands import nested_wire_key, to_wire_value
from .models import ChatGPTResponse, ChatGPTRunResult
from .runner import _UNSAFE_FIELD_MARKER, _is_one_of, run_transactional_sync
from .untrusted_output import render_untrusted_output_return_envelope


UNSUPPORTED_ALTERNATIVES = {
    "model": "Use experience plus configuration for visible ChatGPT UI preferences. Legacy mode remains supported. These do not select an API model.",
    "temperature": "No browser-control equivalent. ChatGPT web does not expose API temperature.",
    "top_p": "No browser-control equivalent. ChatGPT web does not expose API nucleus sampling.",
    "seed": "No browser-control equivalent. Visible ChatGPT web does not expose deterministic API seeds.",
    "logprobs": "No browser-control equivalent. Visible ChatGPT web does not expose token log probabilities.",
    "top_logprobs": "No browser-control equivalent. Visible ChatGPT web does not expose token log probabilities.",
    "previous_response_id": "Use thread: { type: \"conversationId\", conversationId } or a ChatGPT thread URL.",
    "store": "No browser-control equivalent. Use visible ChatGPT settings or temporary chat controls when implemented.",
    "service_tier": "No browser-control equivalent. Visible ChatGPT web does not expose API service tiers.",
    "max_output_tokens": "Use response.maxChars/read maxChars for capture limits. This does not control model generation.",
    "parallel_tool_calls": "No browser-control equivalent. Visible ChatGPT browser control selects visible tools sequentially.",
    "truncation": "No browser-control equivalent. Use prompt design and response capture limits instead.",
}

ACCEPTED_TOP_LEVEL_FIELDS = {
    "input",
    "thread",
    "existingTab",
    "preferExistingTab",
    "experience",
    "configuration",
    "attachments",
    "mode",
    "tools",
    "text",
    "stream",
    "report",
    "instructions",
    "instructionsMode",
    "operationId",
}

RESPONSE_FORMATS = {
    "markdown",
    "text",
    "normalized_text",
    "visible_text",
    "html",
    "blocks",
    "all",
}

TRANSACTIONAL_OPERATION_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

_CREATE_ARG_ALIASES = {
    "instructions_mode": "instructionsMode",
    "existing_tab": "existingTab",
    "prefer_existing_tab": "preferExistingTab",
    "operation_id": "operationId",
}
_SAFE_CREATE_FIELDS = ACCEPTED_TOP_LEVEL_FIELDS | set(_CREATE_ARG_ALIASES)
_UNSAFE_VALUE = object()
_MAX_VISIBLE_INPUT_ITEMS = 256
_MAX_VISIBLE_INPUT_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class ResponsesValidationResult:
    ok: bool
    unsupported: list[dict[str, str]]


class ResponsesClient:
    def __init__(self, backend: Any, *, now: Callable[[], datetime] | None = None) -> None:
        self._backend = backend
        self._now = now or (lambda: datetime.now(timezone.utc))

    def create(self, args: Mapping[Any, Any] | None = None, **kwargs: Any) -> ChatGPTResponse:
        payload = normalize_create_args(_merge_create_args(args, kwargs))
        validation = validate_responses_create_args(payload)
        if not validation.ok:
            return unsupported_response(validation.unsupported, self._now(), payload.get("operationId"))

        operation_id = payload.get("operationId")
        if operation_id is not None:
            instructions = payload.get("instructions") if isinstance(payload.get("instructions"), str) else None
            agent = Agent(
                name="responses-adapter",
                instructions=instructions,
                instructions_mode="visible_prefix",
            )
            result = run_transactional_sync(
                self._backend,
                agent,
                responses_create_args_to_run_input(payload),
                operation_id=operation_id,
            )
            return response_from_run_result(result, self._now())

        result = self._request_backend("responses.create", payload)
        if isinstance(result, dict) and result.get("schemaVersion") == "chatgpt.browser_control.backend_response.v1":
            if result.get("ok") is not True:
                error = result.get("error")
                message = error.get("message") if isinstance(error, dict) else "Backend response failed."
                raise RuntimeError(str(message))
            result = result.get("result")
        if not isinstance(result, dict):
            raise RuntimeError("responses.create backend result must be a JSON object.")
        return ChatGPTResponse.from_wire(result)

    def _request_backend(self, command: str, payload: dict[str, Any]) -> Any:
        request = getattr(self._backend, "request", None)
        if callable(request):
            return request(command, payload)
        responses_create = getattr(self._backend, "responses_create", None)
        if callable(responses_create):
            return responses_create(payload)
        raise RuntimeError("This ChatGPT backend does not support responses.create.")


def _merge_create_args(args: Any, kwargs: Mapping[str, Any]) -> dict[Any, Any]:
    """Merge caller mappings without letting hostile keys escape the boundary."""

    merged: dict[Any, Any] = {}
    if args is not None:
        try:
            for key, value in args.items():
                merged[key] = value
        except Exception:
            return {_UNSAFE_FIELD_MARKER: _UNSAFE_VALUE}
    try:
        for key, value in kwargs.items():
            merged[key] = value
    except Exception:
        return {_UNSAFE_FIELD_MARKER: _UNSAFE_VALUE}
    return merged


def _normalize_text_value(value: Any) -> Any:
    """Normalize only the supported text key without rendering arbitrary keys."""

    if not isinstance(value, Mapping):
        try:
            return to_wire_value(value)
        except Exception:
            return _UNSAFE_VALUE

    normalized: dict[str, Any] = {}
    try:
        for key, child in value.items():
            if type(key) is not str:
                normalized[_UNSAFE_FIELD_MARKER] = _UNSAFE_VALUE
                continue
            if child is None:
                continue
            wire_key = nested_wire_key(key)
            # ``format`` is the only supported nested field. Other string
            # keys remain diagnosable, but their values are never rendered.
            if wire_key == "format":
                try:
                    normalized[wire_key] = to_wire_value(child)
                except Exception:
                    normalized[wire_key] = _UNSAFE_VALUE
            else:
                normalized[wire_key] = _UNSAFE_VALUE
    except Exception:
        return _UNSAFE_VALUE
    return normalized


def _normalize_input_value(value: Any) -> Any:
    """Accept only the documented visible-input JSON surface."""

    if type(value) is str:
        try:
            return value if len(value.encode("utf-8")) <= _MAX_VISIBLE_INPUT_BYTES else _UNSAFE_VALUE
        except UnicodeError:
            return _UNSAFE_VALUE
    if type(value) is not list or len(value) > _MAX_VISIBLE_INPUT_ITEMS:
        return _UNSAFE_VALUE

    normalized_items: list[dict[str, Any]] = []
    total_bytes = 0
    for item in value:
        if not isinstance(item, Mapping):
            return _UNSAFE_VALUE
        normalized_item: dict[str, Any] = {}
        try:
            for key, child in item.items():
                if type(key) is not str:
                    return _UNSAFE_VALUE
                normalized_item[key] = child
        except Exception:
            return _UNSAFE_VALUE

        item_type = normalized_item.get("type")
        if type(item_type) is not str:
            return _UNSAFE_VALUE
        if item_type == "input_text":
            if not set(normalized_item).issubset({"type", "text", "role"}):
                return _UNSAFE_VALUE
            text = normalized_item.get("text")
            role = normalized_item.get("role")
            if type(text) is not str or (
                "role" in normalized_item
                and (type(role) is not str or role != "user")
            ):
                return _UNSAFE_VALUE
        elif item_type == "visible_instruction":
            if set(normalized_item) != {"type", "text"}:
                return _UNSAFE_VALUE
            text = normalized_item.get("text")
            if type(text) is not str:
                return _UNSAFE_VALUE
        elif item_type == "input_file":
            if not set(normalized_item).issubset({"type", "path", "description"}):
                return _UNSAFE_VALUE
            path = normalized_item.get("path")
            description = normalized_item.get("description")
            if type(path) is not str or not path:
                return _UNSAFE_VALUE
            if "description" in normalized_item and type(description) is not str:
                return _UNSAFE_VALUE
        else:
            return _UNSAFE_VALUE

        try:
            total_bytes += sum(
                len(child.encode("utf-8"))
                for child in normalized_item.values()
                if type(child) is str
            )
        except UnicodeError:
            return _UNSAFE_VALUE
        if total_bytes > _MAX_VISIBLE_INPUT_BYTES:
            return _UNSAFE_VALUE
        normalized_items.append(normalized_item)
    return normalized_items


def _normalize_create_value(key: str, value: Any) -> Any:
    if key == "input":
        return _normalize_input_value(value)
    if key == "text":
        return _normalize_text_value(value)
    try:
        return to_wire_value(value)
    except Exception:
        return _UNSAFE_VALUE


def normalize_create_args(args: Mapping[Any, Any] | None) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    if args is None:
        return normalized
    try:
        for key, value in args.items():
            if type(key) is not str:
                normalized[_UNSAFE_FIELD_MARKER] = _UNSAFE_VALUE
                continue
            if value is None:
                continue
            # Unknown fields only need a stable diagnostic path. Skipping
            # their values prevents to_wire_value from rendering arbitrary
            # nested mappings before validation rejects the request.
            normalized[key] = (
                _normalize_create_value(key, value)
                if key in _SAFE_CREATE_FIELDS
                else _UNSAFE_VALUE
            )
    except Exception:
        normalized[_UNSAFE_FIELD_MARKER] = _UNSAFE_VALUE

    for alias, wire_key in _CREATE_ARG_ALIASES.items():
        if alias in normalized and wire_key not in normalized:
            normalized[wire_key] = normalized.pop(alias)
    return normalized


def validate_responses_create_args(args: Mapping[Any, Any] | None) -> ResponsesValidationResult:
    payload = normalize_create_args(args)
    unsupported: list[dict[str, str]] = []

    unsafe_accepted_fields: set[str] = set()
    for path, value in payload.items():
        if value is _UNSAFE_VALUE and path in ACCEPTED_TOP_LEVEL_FIELDS:
            unsafe_accepted_fields.add(path)
            unsupported.append({
                "path": path,
                "reason": "This field could not be normalized safely, so the request was not sent.",
                "alternative": "Provide a plain JSON-compatible value for this field.",
            })

    for path, alternative in UNSUPPORTED_ALTERNATIVES.items():
        if payload.get(path) is not None:
            unsupported.append(api_only_field(path, alternative))

    operation_id = payload.get("operationId")
    if "operationId" not in unsafe_accepted_fields and operation_id is not None and (
        not isinstance(operation_id, str) or TRANSACTIONAL_OPERATION_ID_PATTERN.fullmatch(operation_id) is None
    ):
        unsupported.append({
            "path": "operationId",
            "reason": "operation_id must be a canonical UUID when provided.",
            "alternative": "Provide a caller-owned UUID, or omit operation_id to retain the legacy Responses path.",
        })

    for path in payload:
        if path not in ACCEPTED_TOP_LEVEL_FIELDS and path not in UNSUPPORTED_ALTERNATIVES:
            unsupported.append({
                "path": path,
                "reason": "This field is not part of the narrow ChatGPT browser-control Responses adapter.",
                "alternative": "Use chatgpt.runner.run(...) for lower-level browser-control options.",
            })

    if "input" not in unsafe_accepted_fields and payload.get("input") is None:
        unsupported.append({
            "path": "input",
            "reason": "Responses adapter calls must include visible input text or input items.",
            "alternative": "Provide input: \"your visible prompt\".",
        })

    if "stream" in payload and "stream" not in unsafe_accepted_fields and payload.get("stream") is not False:
        unsupported.append({
            "path": "stream",
            "reason": "This adapter stage supports only non-streaming calls.",
            "alternative": "Set stream: false, or use the runner milestone stream when enabled.",
        })

    if (
        "instructions" not in unsafe_accepted_fields
        and payload.get("instructions") is not None
        and payload.get("instructionsMode") != "visible_prefix"
    ):
        unsupported.append({
            "path": "instructions",
            "reason": "Responses API instructions are hidden context, but ChatGPT browser control can only submit visible text.",
            "alternative": "Set instructionsMode: \"visible_prefix\" to send instructions visibly.",
        })

    if (
        "instructionsMode" in payload
        and "instructionsMode" not in unsafe_accepted_fields
        and payload.get("instructionsMode") != "visible_prefix"
    ):
        unsupported.append({
            "path": "instructionsMode",
            "reason": "Only explicit visible-prefix instructions are supported by this adapter.",
            "alternative": "Use instructionsMode: \"visible_prefix\" or omit instructionsMode.",
        })

    text = payload.get("text")
    if "text" in unsafe_accepted_fields:
        text = None
    elif text is not None and not isinstance(text, Mapping):
        unsupported.append({
            "path": "text",
            "reason": "text must be an object containing an optional format.",
            "alternative": "Use text: {format: \"markdown\"} or omit text.",
        })
    elif isinstance(text, Mapping):
        text_format = text.get("format")
        if text_format is not None and (not isinstance(text_format, str) or not _is_one_of(text_format, *RESPONSE_FORMATS)):
            unsupported.append({
                "path": "text.format",
                "reason": "The requested response text format is not supported by ChatGPT browser-control capture.",
                "alternative": "Use markdown, visible_text, normalized_text, html, blocks, or all.",
            })
        elif operation_id is not None and not _is_one_of(text_format, None, "markdown", "text"):
            unsupported.append({
                "path": "text.format",
                "reason": "Transactional operation capture currently preserves only markdown or plain-text result formats.",
                "alternative": "Use text.format markdown or text, or omit operation_id to retain the legacy Responses path.",
            })
        for path in text:
            safe_path = path if type(path) is str else _UNSAFE_FIELD_MARKER
            if safe_path != "format":
                unsupported.append({
                    "path": f"text.{safe_path}",
                    "reason": "Only text.format is supported by the narrow Responses adapter.",
                    "alternative": "Use chatgpt.runner.run(...) for lower-level browser-control options.",
                })

    return ResponsesValidationResult(ok=len(unsupported) == 0, unsupported=unsupported)


def unsupported_response(
    unsupported: list[dict[str, str]],
    now: datetime,
    operation_id: Any = None,
) -> ChatGPTResponse:
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    created_at = int(now.timestamp())
    return ChatGPTResponse.from_wire({
        "id": f"chatgpt-browser-{base36(int(now.timestamp() * 1000))}",
        "object": "chatgpt.browser.response",
        "created_at": created_at,
        "status": "unsupported",
        "output_text": "",
        "output": [],
        "browser_control": {
            "visibleUi": True,
            "resultStatus": "unsupported",
            **({"operationId": operation_id} if isinstance(operation_id, str) else {}),
            "unsupported": unsupported,
        },
    })


def responses_create_args_to_run_input(args: dict[str, Any]) -> dict[str, Any]:
    text = args.get("text")
    text_format = text.get("format") if isinstance(text, dict) else None
    run_input: dict[str, Any] = {
        "input": args["input"],
        "response": {"format": text_format or "markdown"},
    }
    if args.get("operationId") is not None:
        run_input["operationId"] = args["operationId"]
    for key in (
        "thread",
        "existingTab",
        "preferExistingTab",
        "experience",
        "configuration",
        "attachments",
        "mode",
        "tools",
        "report",
    ):
        if key in args:
            run_input[key] = args[key]
    return run_input


def response_from_run_result(result: ChatGPTRunResult, now: datetime) -> ChatGPTResponse:
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    created_at = int(now.timestamp())
    browser_control: dict[str, Any] = {
        "visibleUi": True,
        "resultStatus": result.status,
    }
    data = getattr(result, "data", None)
    if isinstance(data, dict):
        if isinstance(data.get("thread"), dict):
            browser_control["thread"] = data["thread"]
        if isinstance(data.get("reportPath"), str):
            browser_control["reportPath"] = data["reportPath"]
        for key in ("submissionState", "completionState", "generationActive"):
            if key in data:
                browser_control[key] = data[key]
        for key in ("operationId", "handle"):
            if key in data:
                browser_control[key] = data[key]
    state = getattr(result, "state", None)
    if state is not None:
        state_wire = state.to_wire() if hasattr(state, "to_wire") else {}
        for key in ("submissionState", "completionState"):
            if key in state_wire:
                browser_control[key] = state_wire[key]
    if result.report_path is not None:
        browser_control["reportPath"] = result.report_path
    response_id = f"chatgpt-browser-{base36(int(now.timestamp() * 1000))}"
    if result.output_text:
        browser_control["untrustedOutput"] = render_untrusted_output_return_envelope(
            output_text=result.output_text,
            source="chatgpt",
            captured_at=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            output_path=result.report_path,
            metadata={
                "response_id": response_id,
                "result_status": result.status,
                "report_path": result.report_path,
            },
        )

    return ChatGPTResponse.from_wire({
        "id": response_id,
        "object": "chatgpt.browser.response",
        "created_at": created_at,
        "status": result.status,
        "output_text": result.output_text,
        "output": result.output,
        "browser_control": browser_control,
    })


def api_only_field(path: str, alternative: str) -> dict[str, str]:
    return {
        "path": path,
        "reason": "This is an OpenAI API field that visible ChatGPT browser control cannot honestly support.",
        "alternative": alternative,
    }


def base36(value: int) -> str:
    if value == 0:
        return "0"
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    digits = []
    current = value
    while current:
        current, remainder = divmod(current, 36)
        digits.append(alphabet[remainder])
    return "".join(reversed(digits))
