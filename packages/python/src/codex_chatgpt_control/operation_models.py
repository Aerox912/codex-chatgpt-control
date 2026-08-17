"""Strict Python wire models for transactional browser operations.

The operation schemas intentionally have a stricter policy than the legacy
``models.WireModel`` surface: unknown keys are rejected, wire names remain
camelCase, and durable models contain only opaque identifiers, digests,
counts, state, blockers, and receipts.  ``OperationSubmitRequest`` is the
exception because prompt/file/output-directory values are explicitly
request-only in the contract and must never be copied into durable models.

Pydantic validates the local shape and cross-field invariants that are safe to
enforce at the model boundary.  Journal hash chains, state-transition legality,
target ownership, action postconditions, and filesystem/path policy remain
runtime/integration responsibilities.
"""

from __future__ import annotations

import math
import re
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, TypeVar, Union
from urllib.parse import urlsplit, urlunsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationInfo,
    field_validator,
    model_validator,
)
from typing_extensions import TypeAliasType


TURN_SCHEMA = "chatgpt.browser_control.operation.v1"
EVENT_SCHEMA = "chatgpt.browser_control.operation_event.v1"
RECEIPT_SCHEMA = "chatgpt.browser_control.operation_receipt.v1"
REQUEST_SCHEMA = "chatgpt.browser_control.operation_request.v1"
HANDLE_SCHEMA = "chatgpt.browser_control.operation_handle.v1"
COLLECT_SCHEMA = "chatgpt.browser_control.operation_collect_request.v1"
INSPECT_SCHEMA = "chatgpt.browser_control.operation_inspect_request.v1"
CONTROL_REQUEST_SCHEMA = "chatgpt.browser_control.operation_control_request.v1"
CONTROL_RECEIPT_SCHEMA = "chatgpt.browser_control.operation_control_receipt.v1"
ARTIFACT_SCHEMA = "chatgpt.browser_control.operation_artifact_receipt.v1"
BLOCKER_SCHEMA = "chatgpt.browser_control.operation_blocker.v1"
RECOVERY_OBSERVATION_SCHEMA = "chatgpt.browser_control.operation_recovery_observation.v1"
RECOVERY_DECISION_SCHEMA = "chatgpt.browser_control.operation_recovery_decision.v1"
SUBMISSION_WITNESS_SCHEMA = "chatgpt.browser_control.operation_submission_witness.v1"
OWNERSHIP_SCHEMA = "chatgpt.browser_control.turn_ownership.v1"
OWNERSHIP_BASELINE_SCHEMA = "chatgpt.browser_control.operation_ownership_baseline.v1"
ARTIFACT_TRANSFER_INTENT_SCHEMA = "chatgpt.browser_control.artifact_transfer_intent.v1"
ARTIFACT_TRANSFER_RECEIPT_SCHEMA = "chatgpt.browser_control.artifact_transfer_receipt.v1"

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_INPUT_FILES = 256
MAX_ARTIFACTS = 32
MAX_SUBMISSION_WITNESSES = 64
MAX_OWNERSHIP_BASELINES = 64
MAX_PROMPT_BYTES = 8 * 1024 * 1024
MAX_JSON_DEPTH = 16
MAX_JSON_NODES = 10_000
MAX_JSON_UTF8_BYTES = 1024 * 1024
MAX_COLLECT_POLL_INTERVAL_MS = 60_000
MAX_WIRE_OBJECT_FIELDS = 256
MAX_WIRE_FIELD_NAME_BYTES = 512
MAX_WIRE_FIELD_NAMES_BYTES = 16 * 1024

_WIRE_VALIDATION_CONTEXT = "transactional_wire_boundary"
_INVALID_WIRE_PAYLOAD_MESSAGE = "Invalid transactional operation wire payload."
_WIRE_MODE: ContextVar[bool] = ContextVar("transactional_wire_mode", default=False)


def _bounded_utf8(value: str, *, max_bytes: int, field_name: str) -> str:
    try:
        byte_length = len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError(f"{field_name} must contain valid UTF-8 text") from exc
    if byte_length > max_bytes:
        raise ValueError(f"{field_name} exceeds the {max_bytes}-byte limit")
    return value


def _reject_explicit_nulls(value: Any, fields: tuple[str, ...]) -> Any:
    """Keep optional wire properties omission-only, matching the TS validators."""

    # The public Python constructor may intentionally use ``None`` for an
    # omitted optional value.  Only the explicit wire decoder is an authority
    # boundary where JSON ``null`` must be rejected.
    if not _WIRE_MODE.get():
        return value
    if isinstance(value, dict) and any(field in value and value[field] is None for field in fields):
        raise ValueError("optional wire fields must be omitted when absent")
    return value


def _reject_ambiguous_aliases(value: Any, aliases: tuple[tuple[str, str], ...]) -> Any:
    """Reject snake/camel duplicates before Pydantic silently chooses one."""

    if isinstance(value, dict) and any(left in value and right in value for left, right in aliases):
        raise ValueError("wire field aliases must not be supplied more than once")
    return value


def _bounded_text_256(value: str) -> str:
    return _bounded_utf8(value, max_bytes=256, field_name="text")


def _bounded_text_512(value: str) -> str:
    return _bounded_utf8(value, max_bytes=512, field_name="text")


def _compatibility_text(value: str) -> str:
    _bounded_utf8(value, max_bytes=512, field_name="compatibility text")
    if value != value.strip() or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise ValueError("compatibility text must be visible and trimmed")
    return value


def _bounded_text_4096(value: str) -> str:
    return _bounded_utf8(value, max_bytes=4096, field_name="text")


def _opaque_id(value: str) -> str:
    _bounded_utf8(value, max_bytes=512, field_name="opaque identifier")
    if not value.strip() or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise ValueError("opaque identifiers must contain visible non-control characters")
    return value


def _mime_type(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}", value):
        raise ValueError("mimeType is not a valid bounded media type")
    return value


def _bounded_prompt(value: str, field_name: str) -> str:
    return _bounded_utf8(value, max_bytes=MAX_PROMPT_BYTES, field_name=field_name)


def _https_thread_url(value: str) -> str:
    _bounded_utf8(value, max_bytes=4096, field_name="canonicalThreadUrl")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValueError("canonicalThreadUrl must be a canonical HTTPS URL") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or urlunsplit(parsed) != value
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
    ):
        raise ValueError("canonicalThreadUrl must be canonical HTTPS without credentials, query, or fragment")
    return value


def _instant(value: str) -> str:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError("instant must be a real canonical UTC timestamp") from exc
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if canonical != value:
        raise ValueError("instant must be a real canonical UTC timestamp")
    return value


def _validate_json_value(value: JsonValue, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [MAX_JSON_NODES, MAX_JSON_UTF8_BYTES]
    budget[0] -= 1
    if budget[0] < 0:
        raise ValueError(f"JSON value exceeds the {MAX_JSON_NODES}-node limit")
    if depth > MAX_JSON_DEPTH:
        raise ValueError(f"JSON value exceeds the maximum depth of {MAX_JSON_DEPTH}")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("JSON numbers must be finite")
    if isinstance(value, str):
        budget[1] -= len(_bounded_utf8(value, max_bytes=MAX_JSON_UTF8_BYTES, field_name="JSON string").encode("utf-8"))
        if budget[1] < 0:
            raise ValueError(f"JSON strings exceed the {MAX_JSON_UTF8_BYTES}-byte aggregate limit")
    if isinstance(value, list):
        for entry in value:
            _validate_json_value(entry, depth=depth + 1, budget=budget)
    elif isinstance(value, dict):
        for key, entry in value.items():
            key_bytes = len(_bounded_utf8(key, max_bytes=256, field_name="JSON object key").encode("utf-8"))
            if any(ord(char) < 0x20 or ord(char) == 0x7F for char in key):
                raise ValueError("JSON object keys must be bounded and contain no control characters")
            budget[1] -= key_bytes
            if budget[1] < 0:
                raise ValueError(f"JSON strings exceed the {MAX_JSON_UTF8_BYTES}-byte aggregate limit")
            _validate_json_value(entry, depth=depth + 1, budget=budget)


OpaqueId = Annotated[
    str,
    StringConstraints(min_length=1, max_length=512),
    AfterValidator(_opaque_id),
]
BoundedText256 = Annotated[
    str,
    StringConstraints(min_length=1, max_length=256),
    AfterValidator(_bounded_text_256),
]
BoundedText512 = Annotated[
    str,
    StringConstraints(min_length=1, max_length=512),
    AfterValidator(_bounded_text_512),
]
BoundedCompatibilityText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=512),
    AfterValidator(_compatibility_text),
]
BoundedText4096 = Annotated[
    str,
    StringConstraints(min_length=1, max_length=4096),
    AfterValidator(_bounded_text_4096),
]
Digest = Annotated[
    str,
    StringConstraints(pattern=r"^hmac-sha256:[0-9a-f]{64}$"),
]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Uuid = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
]
Instant = Annotated[
    str,
    StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"),
    AfterValidator(_instant),
]
Revision = Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER)]
NonNegativeInteger = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
CollectPollInterval = Annotated[int, Field(ge=0, le=MAX_COLLECT_POLL_INTERVAL_MS)]
Code = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
OpaqueKey = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")]
OutputKey = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")]
MimeType = Annotated[str, StringConstraints(min_length=1, max_length=127), AfterValidator(_mime_type)]
CanonicalThreadUrl = Annotated[str, StringConstraints(min_length=1, max_length=4096), AfterValidator(_https_thread_url)]


JsonValue = TypeAliasType(
    "JsonValue",
    Union[None, bool, int, float, str, list["JsonValue"], dict[str, "JsonValue"]],  # pyright: ignore[reportInvalidTypeForm]
)


TModel = TypeVar("TModel", bound="StrictWireModel")


class StrictWireModel(BaseModel):
    """Strict camelCase wire model with idiomatic snake_case attributes."""

    model_config = ConfigDict(
        alias_generator=None,
        populate_by_name=True,
        extra="forbid",
        strict=True,
    )

    @model_validator(mode="before")
    @classmethod
    def _validate_wire_boundary(cls, value: Any, info: ValidationInfo) -> Any:
        """Apply the language-neutral wire policy at every nested model.

        Python callers intentionally get Pydantic's ergonomic ``populate_by_name``
        behavior when constructing models.  ``from_wire`` supplies a private
        context marker, which makes the same model graph a strict authority
        boundary: only canonical wire aliases are accepted and omission-only
        optional fields cannot be represented as JSON ``null``.  Because this is
        an inherited ``before`` validator, Pydantic applies the table derived
        from each nested model as it descends through unions and containers.
        """

        context = info.context
        if not isinstance(context, dict) or context.get(_WIRE_VALIDATION_CONTEXT) is not True:
            return value
        if type(value) is not dict:
            raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)

        # Do not let Pydantic render arbitrary key objects in an "extra field"
        # diagnostic.  The public ``from_wire`` exception is fixed as well, but
        # rejecting before model parsing avoids invoking hostile key methods.
        if any(type(key) is not str for key in value):
            raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)

        if len(value) > MAX_WIRE_OBJECT_FIELDS:
            raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)

        canonical_wire_fields = {
            field.alias or field_name
            for field_name, field in cls.model_fields.items()
        }
        field_name_bytes = 0
        for key in value:
            try:
                encoded_key = key.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE) from exc
            if len(encoded_key) > MAX_WIRE_FIELD_NAME_BYTES:
                raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)
            field_name_bytes += len(encoded_key)
            if field_name_bytes > MAX_WIRE_FIELD_NAMES_BYTES:
                raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)
            if key not in canonical_wire_fields:
                raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)

        optional_wire_fields: set[str] = set()
        python_aliases: set[str] = set()
        for field_name, field in cls.model_fields.items():
            wire_name = field.alias or field_name
            if wire_name != field_name:
                python_aliases.add(field_name)
            if not field.is_required() and field.default is None:
                optional_wire_fields.add(wire_name)

        if any(alias in value for alias in python_aliases):
            raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)
        if any(field in value and value[field] is None for field in optional_wire_fields):
            raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)
        return value

    @classmethod
    def from_wire(cls: type[TModel], payload: dict[str, Any]) -> TModel:
        # A wire decoder is an authority boundary, not a general Mapping
        # adapter.  Reject subclasses and custom mappings before they can run
        # caller-controlled accessors, and never expose Pydantic's input-value
        # rendering in the public exception.
        if type(payload) is not dict:
            raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)
        token = _WIRE_MODE.set(True)
        try:
            return cls.model_validate(payload, context={_WIRE_VALIDATION_CONTEXT: True})
        except Exception:
            # Leave the handler before raising so even ``__context__`` cannot
            # retain a Pydantic diagnostic containing an untrusted value.
            pass
        finally:
            _WIRE_MODE.reset(token)
        raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE) from None

    def to_wire(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class BackendCompatibilityWarning(StrictWireModel):
    """One bounded, redacted compatibility comparison diagnostic."""

    code: Literal[
        "package_name_mismatch",
        "package_version_mismatch",
        "runtime_mismatch",
        "runtime_version_mismatch",
        "build_digest_mismatch",
        "provenance_unknown",
        "legacy_backend",
        "negotiation_rejected",
    ]
    field: Literal["packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest"] | None = None
    expected: BoundedCompatibilityText | None = None
    received: BoundedCompatibilityText | None = None
    message: BoundedCompatibilityText


class BackendCompatibilityReport(StrictWireModel):
    """Frozen transport negotiation state; never contains command lists or secrets."""

    schema_version: Literal["chatgpt.browser_control.backend_compatibility.v1"] = Field(alias="schemaVersion")
    status: Literal["compatible", "warning", "unknown", "blocked"]
    mode: Literal["multiplexed", "single-flight", "legacy", "unknown"]
    protocol_version: BoundedCompatibilityText | None = Field(default=None, alias="protocolVersion")
    backend_session_id: BoundedCompatibilityText | None = Field(default=None, alias="backendSessionId")
    package_name: BoundedCompatibilityText | None = Field(default=None, alias="packageName")
    package_version: BoundedCompatibilityText | None = Field(default=None, alias="packageVersion")
    runtime: BoundedCompatibilityText | None = None
    runtime_version: BoundedCompatibilityText | None = Field(default=None, alias="runtimeVersion")
    build_digest: BoundedCompatibilityText | None = Field(default=None, alias="buildDigest")
    warnings: list[BackendCompatibilityWarning] = Field(default_factory=list, max_length=16)


OperationSurface = Literal["chat", "work"]
OperationResponseFormat = Literal["markdown", "text"]
ArtifactTransferKind = Literal["file", "image", "other"]
ArtifactTransferStatus = Literal["transferred", "partial", "blocked"]
OperationPhase = Literal[
    "prepared",
    "handoff_pending",
    "ready",
    "send_pending",
    "submitted",
    "generating",
    "capturing",
    "completed",
    "uncertain",
]
MutationBoundary = Literal[
    "none",
    "handoff_may_have_occurred",
    "send_may_have_occurred",
    "control_may_have_occurred",
]
OperationActionKind = Literal[
    "status_read",
    "configuration_set",
    "tool_set",
    "composer_set",
    "power_discovery",
    "power_select",
    "file_handoff",
    "send",
    "work_steer",
    "stop",
    "download",
    "local_output_commit",
    "clipboard_capture_restore",
]
RepeatPolicy = Literal[
    "read_only",
    "reconcile_set_to_value",
    "reconcile_local_effect",
    "observe_only_after_intent",
]
ActionOutcome = Literal["satisfied", "not_satisfied", "uncertain"]
BlockerCode = Literal[
    "operation_not_found",
    "operation_request_mismatch",
    "operation_state_corrupt",
    "operation_receipt_expired",
    "operation_quota_exceeded",
    "operation_cancelled",
    "operation_timeout",
    "ambiguous_file_handoff",
    "ambiguous_submit",
    "attachment_manifest_mismatch",
    "input_file_changed",
    "target_binding_mismatch",
    "target_evidence_unavailable",
    "turn_ownership_ambiguous",
    "concurrent_user_turn",
    "configuration_drift",
    "tab_ownership_conflict",
    "provider_concurrency_unsupported",
    "runtime_incompatible",
    "backend_unavailable",
    "browser_bridge_unavailable",
    "login_required",
    "captcha",
    "rate_limited",
    "permission_required",
    "needs_confirmation",
    "selector_drift",
    "send_control_unavailable",
    "capture_ownership_lost",
    "artifact_unavailable",
    "artifact_transfer_partial",
    "output_collision",
    "output_commit_indeterminate",
    "clipboard_restore_failed",
]


class NewTarget(StrictWireModel):
    type: Literal["new"]


class SelectedTabTarget(StrictWireModel):
    type: Literal["selected_tab"]


class TabIdTarget(StrictWireModel):
    type: Literal["tab_id"]
    tab_id: OpaqueId = Field(alias="tabId")

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(value, (("tabId", "tab_id"),))


class ConversationIdTarget(StrictWireModel):
    type: Literal["conversation_id"]
    conversation_id: OpaqueId = Field(alias="conversationId")

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(value, (("conversationId", "conversation_id"),))


class UrlTarget(StrictWireModel):
    type: Literal["url"]
    url: BoundedText4096

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        _bounded_utf8(value, max_bytes=4096, field_name="target URL")
        try:
            parsed = urlsplit(value)
        except ValueError as exc:
            raise ValueError("target URL must be a bounded HTTP(S) URL") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
        ):
            raise ValueError("target URL must be an HTTP(S) URL without control characters")
        return value


OperationTargetRequest = Annotated[
    Union[NewTarget, SelectedTabTarget, TabIdTarget, ConversationIdTarget, UrlTarget],
    Field(discriminator="type"),
]


class OperationConfiguration(StrictWireModel):
    experience: OperationSurface | None = None
    model: BoundedText256 | None = None
    model_version: BoundedText256 | None = Field(default=None, alias="modelVersion")
    reasoning: BoundedText256 | None = None
    mode: BoundedText256 | None = None
    tools: list[BoundedText256] | None = None
    additional: dict[str, JsonValue] | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(
            value,
            ("experience", "model", "modelVersion", "model_version", "reasoning", "mode", "tools", "additional"),
        )

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(value, (("modelVersion", "model_version"),))

    @field_validator("tools")
    @classmethod
    def cap_tools(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len(value) > 256:
            raise ValueError("configuration.tools is capped at 256 items")
        return value

    @field_validator("additional")
    @classmethod
    def validate_additional_json(cls, value: dict[str, JsonValue] | None) -> dict[str, JsonValue] | None:
        if value is not None:
            _validate_json_value(value)
        return value


class OperationInputFile(StrictWireModel):
    path: BoundedText4096
    display_name: BoundedText512 | None = Field(default=None, alias="displayName")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("displayName", "display_name"))

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(value, (("displayName", "display_name"),))


class OperationCapturePolicy(StrictWireModel):
    response_content: Literal["include", "metadata"] = Field(alias="responseContent")
    response_format: OperationResponseFormat = Field(default="markdown", alias="responseFormat")
    artifacts: Literal["receipt_only", "transfer"]
    output_directory: BoundedText4096 | None = Field(default=None, alias="outputDirectory")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("responseFormat", "response_format", "outputDirectory", "output_directory"))

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(value, (("responseFormat", "response_format"), ("outputDirectory", "output_directory")))

    @model_validator(mode="after")
    def validate_transfer_destination(self) -> "OperationCapturePolicy":
        if self.artifacts == "transfer" and self.output_directory is None:
            raise ValueError("capture.outputDirectory is required for transfer")
        if self.artifacts == "receipt_only" and self.output_directory is not None:
            raise ValueError("capture.outputDirectory is forbidden for receipt_only")
        return self


class OperationDurableCapturePolicy(StrictWireModel):
    """Closed, path-free capture policy retained by created/state records."""

    response_content: Literal["include", "metadata"] = Field(alias="responseContent")
    # Durable records have already crossed the defaulting boundary. Keep this
    # required so Python rejects the same malformed journal/state shape as the
    # TypeScript reducer and the shared JSON schemas.
    response_format: OperationResponseFormat = Field(alias="responseFormat")
    artifacts: Literal["receipt_only", "transfer"]


# Descriptive alias used by callers that refer to the state projection.
OperationCapturePolicyState = OperationDurableCapturePolicy


class OperationSubmitRequest(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_request.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    surface: OperationSurface
    prompt: str
    target: OperationTargetRequest
    configuration: OperationConfiguration | None = None
    files: list[OperationInputFile] | None = None
    capture: OperationCapturePolicy | None = None
    timeout_ms: NonNegativeInteger | None = Field(default=None, alias="timeoutMs")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(
            value,
            ("configuration", "files", "capture", "timeoutMs", "timeout_ms"),
        )

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(
            value,
            (
                ("schemaVersion", "schema_version"),
                ("operationId", "operation_id"),
                ("timeoutMs", "timeout_ms"),
            ),
        )

    @field_validator("prompt")
    @classmethod
    def cap_prompt_bytes(cls, value: str) -> str:
        return _bounded_prompt(value, "prompt")

    @field_validator("files")
    @classmethod
    def cap_files(cls, value: list[OperationInputFile] | None) -> list[OperationInputFile] | None:
        if value is not None and len(value) > MAX_INPUT_FILES:
            raise ValueError(f"files is capped at {MAX_INPUT_FILES} items")
        return value


class OperationHandle(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_handle.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    surface: OperationSurface
    revision: Revision
    phase: OperationPhase
    mutation_boundary: MutationBoundary = Field(alias="mutationBoundary")
    target_binding_digest: Digest | None = Field(default=None, alias="targetBindingDigest")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("targetBindingDigest", "target_binding_digest"))

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(
            value,
            (
                ("schemaVersion", "schema_version"),
                ("operationId", "operation_id"),
                ("requestDigest", "request_digest"),
                ("mutationBoundary", "mutation_boundary"),
                ("targetBindingDigest", "target_binding_digest"),
            ),
        )


class OperationCollectRequest(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_collect_request.v1"] = Field(alias="schemaVersion")
    handle: OperationHandle
    wait: bool | None = None
    timeout_ms: NonNegativeInteger | None = Field(default=None, alias="timeoutMs")
    poll_interval_ms: CollectPollInterval | None = Field(default=None, alias="pollIntervalMs")
    response_content: Literal["include", "metadata"] | None = Field(default=None, alias="responseContent")

    @model_validator(mode="before")
    @classmethod
    def reject_null_poll_interval(cls, value: Any) -> Any:
        value = _reject_explicit_nulls(
            value,
            (
                "wait",
                "timeoutMs",
                "timeout_ms",
                "pollIntervalMs",
                "poll_interval_ms",
                "responseContent",
                "response_content",
            ),
        )
        return _reject_ambiguous_aliases(
            value,
            (
                ("schemaVersion", "schema_version"),
                ("timeoutMs", "timeout_ms"),
                ("pollIntervalMs", "poll_interval_ms"),
                ("responseContent", "response_content"),
            ),
        )


class OperationInspectRequest(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_inspect_request.v1"] = Field(alias="schemaVersion")
    handle: OperationHandle

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(value, (("schemaVersion", "schema_version"),))


class OperationControlRequest(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_control_request.v1"] = Field(alias="schemaVersion")
    control_action_id: Uuid = Field(alias="controlActionId")
    parent: OperationHandle
    action: Literal["stop", "steer"]
    expected_assistant_turn_id: OpaqueId = Field(alias="expectedAssistantTurnId")
    steer_prompt: str | None = Field(default=None, alias="steerPrompt")
    timeout_ms: NonNegativeInteger | None = Field(default=None, alias="timeoutMs")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("steerPrompt", "steer_prompt", "timeoutMs", "timeout_ms"))

    @model_validator(mode="before")
    @classmethod
    def reject_duplicate_aliases(cls, value: Any) -> Any:
        return _reject_ambiguous_aliases(
            value,
            (
                ("schemaVersion", "schema_version"),
                ("controlActionId", "control_action_id"),
                ("expectedAssistantTurnId", "expected_assistant_turn_id"),
                ("steerPrompt", "steer_prompt"),
                ("timeoutMs", "timeout_ms"),
            ),
        )

    @field_validator("steer_prompt")
    @classmethod
    def cap_steer_prompt_bytes(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _bounded_prompt(value, "steerPrompt")

    @model_validator(mode="after")
    def validate_control_shape(self) -> "OperationControlRequest":
        if self.action == "steer" and not self.steer_prompt:
            raise ValueError("steer requires a non-empty steerPrompt")
        if self.action == "stop" and self.steer_prompt is not None:
            raise ValueError("stop forbids steerPrompt")
        if self.parent.phase != "generating" or self.parent.target_binding_digest is None:
            raise ValueError("control parent must be a generating handle with targetBindingDigest")
        return self


class OperationEvidenceProfile(StrictWireModel):
    provider_identity: Literal["required", "unavailable"] = Field(alias="providerIdentity")
    stable_tab_id: Literal["required", "unavailable"] = Field(alias="stableTabId")
    stable_conversation_id: Literal["required", "unavailable"] = Field(alias="stableConversationId")
    stable_user_turn_id: Literal["required", "unavailable"] = Field(alias="stableUserTurnId")
    authoritative_tab_claim: Literal["required", "unavailable"] = Field(alias="authoritativeTabClaim")
    replacement_tab_recovery: bool = Field(alias="replacementTabRecovery")


class OwnershipIdentityAvailable(StrictWireModel):
    status: Literal["available"]
    value: OpaqueId


class OwnershipIdentityUnavailable(StrictWireModel):
    status: Literal["unavailable"]
    reason: Literal["not_exposed", "not_observed", "redacted"]


OwnershipIdentityEvidence = Annotated[
    Union[OwnershipIdentityAvailable, OwnershipIdentityUnavailable],
    Field(discriminator="status"),
]


class OwnershipUrlIdentityAvailable(StrictWireModel):
    status: Literal["available"]
    value: CanonicalThreadUrl


OwnershipUrlIdentityEvidence = Annotated[
    Union[OwnershipUrlIdentityAvailable, OwnershipIdentityUnavailable],
    Field(discriminator="status"),
]


class OwnershipTargetEvidence(StrictWireModel):
    provider: OwnershipIdentityEvidence
    browser: OwnershipIdentityEvidence
    tab: OwnershipIdentityEvidence
    thread: OwnershipIdentityEvidence
    conversation: OwnershipIdentityEvidence
    canonical_thread_url: OwnershipUrlIdentityEvidence = Field(alias="canonicalThreadUrl")
    authoritative_tab_claim: OwnershipIdentityEvidence = Field(alias="authoritativeTabClaim")
    coordination_scope: Literal["process", "provider"] = Field(alias="coordinationScope")


class OwnershipTurn(StrictWireModel):
    stable_id: OpaqueId | None = Field(default=None, alias="stableId")
    evidence_digest: Digest = Field(alias="evidenceDigest")
    structure_digest: Digest = Field(alias="structureDigest")
    ordinal: NonNegativeInteger
    parent_stable_id: OpaqueId | None = Field(default=None, alias="parentStableId")
    branch_stable_id: OpaqueId | None = Field(default=None, alias="branchStableId")
    state: Literal["generating", "terminal"] | None = None
    artifact_evidence_digests: list[Digest] | None = Field(default=None, alias="artifactEvidenceDigests")

    @field_validator("artifact_evidence_digests")
    @classmethod
    def cap_artifact_evidence(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len(value) > 32:
            raise ValueError("artifactEvidenceDigests is capped at 32 items")
        return value


class OwnershipBaseline(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.turn_ownership.v1"] = Field(alias="schemaVersion")
    snapshot_digest: Digest = Field(alias="snapshotDigest")
    target: OwnershipTargetEvidence
    user_turns: list[OwnershipTurn] = Field(alias="userTurns")
    assistant_turns: list[OwnershipTurn] = Field(alias="assistantTurns")
    completeness: Literal["complete"]

    @field_validator("user_turns", "assistant_turns")
    @classmethod
    def cap_turns(cls, value: list[OwnershipTurn]) -> list[OwnershipTurn]:
        if len(value) > 256:
            raise ValueError("ownership turns are capped at 256 items")
        return value

    @model_validator(mode="after")
    def validate_turn_order_and_lineage(self) -> "OwnershipBaseline":
        for kind, turns in (("user", self.user_turns), ("assistant", self.assistant_turns)):
            stable_ids: set[str] = set()
            idless_evidence: set[str] = set()
            for index, turn in enumerate(turns):
                if turn.ordinal != index:
                    raise ValueError(f"{kind} turn ordinals must be contiguous")
                if turn.stable_id is not None:
                    if turn.stable_id in stable_ids:
                        raise ValueError(f"{kind} turns contain duplicate stable IDs")
                    stable_ids.add(turn.stable_id)
                elif turn.evidence_digest in idless_evidence:
                    raise ValueError(f"{kind} turns contain duplicate id-less evidence")
                else:
                    idless_evidence.add(turn.evidence_digest)
                if kind == "user" and (turn.state is not None or turn.parent_stable_id is not None or turn.branch_stable_id is not None):
                    raise ValueError("user baseline turns cannot carry assistant lineage")
                if kind == "assistant" and turn.state not in {"generating", "terminal"}:
                    raise ValueError("assistant baseline turns require a bounded state")
                if turn.artifact_evidence_digests is not None and len(set(turn.artifact_evidence_digests)) != len(turn.artifact_evidence_digests):
                    raise ValueError("turn artifact evidence must be unique")
        return self


class OperationOwnershipBaseline(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_ownership_baseline.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    target_binding_digest: Digest = Field(alias="targetBindingDigest")
    action_id: Uuid = Field(alias="actionId")
    baseline: OwnershipBaseline
    observed_at: Instant = Field(alias="observedAt")


class ArtifactTransferIntent(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.artifact_transfer_intent.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    target_binding_digest: Digest = Field(alias="targetBindingDigest")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    source_identity_digest: Digest = Field(alias="sourceIdentityDigest")
    kind: ArtifactTransferKind
    ordinal: NonNegativeInteger
    transfer_action_id: Uuid = Field(alias="transferActionId")
    destination_identity_digest: Digest = Field(alias="destinationIdentityDigest")
    action_kind: Literal["local_output_commit"] = Field(alias="actionKind")
    repeat_policy: Literal["reconcile_local_effect"] = Field(alias="repeatPolicy")
    intent_at: Instant = Field(alias="intentAt")


class ArtifactTransferReceipt(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.artifact_transfer_receipt.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    target_binding_digest: Digest = Field(alias="targetBindingDigest")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    source_identity_digest: Digest = Field(alias="sourceIdentityDigest")
    kind: ArtifactTransferKind
    ordinal: NonNegativeInteger
    transfer_action_id: Uuid = Field(alias="transferActionId")
    destination_identity_digest: Digest = Field(alias="destinationIdentityDigest")
    output_key: OutputKey | None = Field(default=None, alias="outputKey")
    bytes: NonNegativeInteger | None = None
    sha256: Sha256 | None = None
    status: ArtifactTransferStatus
    blocker_code: Code | None = Field(default=None, alias="blockerCode")
    observed_at: Instant = Field(alias="observedAt")

    @model_validator(mode="before")
    @classmethod
    def reject_explicit_nulls(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("outputKey", "bytes", "sha256", "blockerCode"))

    @model_validator(mode="after")
    def validate_transfer_receipt(self) -> "ArtifactTransferReceipt":
        if self.status == "transferred":
            if self.output_key is None or self.bytes is None or self.sha256 is None or self.blocker_code is not None:
                raise ValueError("transferred artifact receipt requires outputKey, bytes, and sha256 without blockerCode")
        elif self.blocker_code is None:
            raise ValueError("partial or blocked artifact receipt requires blockerCode")
        return self


class ArtifactTransferState(StrictWireModel):
    intent: ArtifactTransferIntent
    receipt: ArtifactTransferReceipt | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_receipt(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("intent", "receipt"))


class _OperationTargetEstablishmentBase(StrictWireModel):
    target_binding_digest: Digest = Field(alias="targetBindingDigest")
    anchor_digest: Digest = Field(alias="anchorDigest")
    causal_send_action_id: Uuid = Field(alias="causalSendActionId")
    conversation_id: OpaqueId = Field(alias="conversationId")
    canonical_thread_url: CanonicalThreadUrl = Field(alias="canonicalThreadUrl")
    user_turn_id: OpaqueId = Field(alias="userTurnId")
    user_turn_evidence_digest: Digest = Field(alias="userTurnEvidenceDigest")
    evidence_digest: Digest = Field(alias="evidenceDigest")
    observed_at: Instant = Field(alias="observedAt")


class OperationTargetEstablishmentRead(_OperationTargetEstablishmentBase):
    """Target identity evidence accepted when reading older durable records.

    The post-Send delta is optional only on this read-compatible projection.
    New ``target_established`` events use :class:`OperationTargetEstablishment`
    below, where the delta is mandatory.
    """

    post_send_delta_digest: Digest | None = Field(default=None, alias="postSendDeltaDigest")


class OperationTargetEstablishment(_OperationTargetEstablishmentBase):
    """Strict new target-establishment wire payload."""

    post_send_delta_digest: Digest = Field(alias="postSendDeltaDigest")


class OperationSubmissionWitness(StrictWireModel):
    """Immutable, redacted proof binding Send to its exact user-turn delta."""

    schema_version: Literal["chatgpt.browser_control.operation_submission_witness.v1"] = Field(alias="schemaVersion")
    action_id: Uuid = Field(alias="actionId")
    action_kind: Literal["send", "work_steer"] = Field(alias="actionKind")
    target_binding_digest: Digest = Field(alias="targetBindingDigest")
    baseline_snapshot_digest: Digest = Field(alias="baselineSnapshotDigest")
    post_send_delta_digest: Digest = Field(alias="postSendDeltaDigest")
    operation_user_evidence_digest: Digest = Field(alias="operationUserEvidenceDigest")
    user_turn_id: OpaqueId | None = Field(default=None, alias="userTurnId")
    observed_at: Instant = Field(alias="observedAt")


class OperationTarget(StrictWireModel):
    provider_id: OpaqueId = Field(alias="providerId")
    browser_id: OpaqueId = Field(alias="browserId")
    tab_id: OpaqueId = Field(alias="tabId")
    coordination_scope: Literal["process", "provider"] = Field(alias="coordinationScope")
    tab_claim_evidence_digest: Digest | None = Field(default=None, alias="tabClaimEvidenceDigest")
    canonical_thread_url: CanonicalThreadUrl | None = Field(default=None, alias="canonicalThreadUrl")
    conversation_id: OpaqueId | None = Field(default=None, alias="conversationId")
    user_turn_baseline_digest: Digest | None = Field(default=None, alias="userTurnBaselineDigest")
    assistant_turn_baseline_digest: Digest | None = Field(default=None, alias="assistantTurnBaselineDigest")
    configuration_receipt_digest: Digest | None = Field(default=None, alias="configurationReceiptDigest")
    evidence_profile: OperationEvidenceProfile = Field(alias="evidenceProfile")
    # These fields are absent from fixed-target records produced before the
    # new-target lifecycle was added.  Keep them optional for authenticated
    # runtime reads; the target-established event and the dedicated witness
    # wire shape use the stricter post-Send contract below.
    target_lifecycle: Literal["fixed", "new_pending", "new_established"] | None = Field(default=None, alias="targetLifecycle")
    new_target_anchor_digest: Digest | None = Field(default=None, alias="newTargetAnchorDigest")
    blank_task_evidence_digest: Digest | None = Field(default=None, alias="blankTaskEvidenceDigest")
    target_establishment: OperationTargetEstablishmentRead | None = Field(default=None, alias="targetEstablishment")

    @model_validator(mode="after")
    def validate_coordination_binding(self) -> "OperationTarget":
        if self.coordination_scope == "provider":
            if self.tab_claim_evidence_digest is None:
                raise ValueError("provider coordination requires tabClaimEvidenceDigest")
            if self.evidence_profile.authoritative_tab_claim != "required":
                raise ValueError("provider coordination requires authoritativeTabClaim")
        lifecycle = self.target_lifecycle or "fixed"
        if lifecycle == "fixed":
            if self.new_target_anchor_digest is not None or self.blank_task_evidence_digest is not None or self.target_establishment is not None:
                raise ValueError("fixed targets cannot contain new-target establishment fields")
        else:
            if self.new_target_anchor_digest is None or self.blank_task_evidence_digest is None:
                raise ValueError("new targets require newTargetAnchorDigest and blankTaskEvidenceDigest")
            if lifecycle == "new_pending":
                if self.canonical_thread_url is not None or self.conversation_id is not None or self.target_establishment is not None:
                    raise ValueError("pending new targets cannot contain provider conversation identity")
                if self.evidence_profile.stable_conversation_id != "unavailable" or self.evidence_profile.stable_user_turn_id != "unavailable":
                    raise ValueError("pending new targets must mark conversation and user-turn identity unavailable")
            elif lifecycle == "new_established":
                if self.target_establishment is None:
                    raise ValueError("established new targets require targetEstablishment")
                if self.canonical_thread_url is None or self.conversation_id is None:
                    raise ValueError("established new targets require conversation identity")
                if self.evidence_profile.stable_conversation_id != "required" or self.evidence_profile.stable_user_turn_id != "required":
                    raise ValueError("established new targets must require conversation and user-turn identity")
        return self


class OperationActionIntent(StrictWireModel):
    action_id: Uuid = Field(alias="actionId")
    kind: OperationActionKind
    repeat_policy: RepeatPolicy = Field(alias="repeatPolicy")
    request_digest: Digest = Field(alias="requestDigest")
    parent_action_id: Uuid | None = Field(default=None, alias="parentActionId")
    target_digest: Digest | None = Field(default=None, alias="targetDigest")

    @model_validator(mode="after")
    def validate_action_policy(self) -> "OperationActionIntent":
        if self.kind != "status_read" and self.target_digest is None:
            raise ValueError("non-status actions require targetDigest")
        expected: dict[str, RepeatPolicy] = {
            "status_read": "read_only",
            "power_discovery": "read_only",
            "configuration_set": "reconcile_set_to_value",
            "tool_set": "reconcile_set_to_value",
            "composer_set": "reconcile_set_to_value",
            "power_select": "reconcile_set_to_value",
            "file_handoff": "observe_only_after_intent",
            "send": "observe_only_after_intent",
            "work_steer": "observe_only_after_intent",
            "stop": "observe_only_after_intent",
            "download": "reconcile_local_effect",
            "local_output_commit": "reconcile_local_effect",
            "clipboard_capture_restore": "reconcile_local_effect",
        }
        if self.repeat_policy != expected[self.kind]:
            raise ValueError(f"{self.kind} requires repeatPolicy={expected[self.kind]}")
        return self


class OperationActionRecord(OperationActionIntent):
    intent_revision: Revision = Field(alias="intentRevision")
    intent_at: Instant = Field(alias="intentAt")
    outcome: ActionOutcome | None = None
    receipt_revision: Revision | None = Field(default=None, alias="receiptRevision")
    receipt_at: Instant | None = Field(default=None, alias="receiptAt")
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")
    blocker_code: Code | None = Field(default=None, alias="blockerCode")

    @model_validator(mode="after")
    def validate_action_receipt(self) -> "OperationActionRecord":
        if self.outcome is not None and (self.receipt_revision is None or self.receipt_at is None):
            raise ValueError("outcome requires receiptRevision and receiptAt")
        if self.receipt_revision is not None and (self.outcome is None or self.receipt_at is None):
            raise ValueError("receiptRevision requires outcome and receiptAt")
        if self.receipt_at is not None and (self.outcome is None or self.receipt_revision is None):
            raise ValueError("receiptAt requires outcome and receiptRevision")
        if self.evidence_digest is not None and self.outcome is None:
            raise ValueError("evidenceDigest requires outcome")
        if self.blocker_code is not None and self.outcome not in {"not_satisfied", "uncertain"}:
            raise ValueError("blockerCode requires a non-satisfied or uncertain outcome")
        if self.outcome == "satisfied" and self.evidence_digest is None:
            raise ValueError("satisfied action requires evidenceDigest")
        if self.receipt_revision is not None and self.receipt_revision <= self.intent_revision:
            raise ValueError("receiptRevision must be later than intentRevision")
        if self.receipt_at is not None and self.receipt_at < self.intent_at:
            raise ValueError("receiptAt cannot precede intentAt")
        return self


class OperationArtifactReceipt(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_artifact_receipt.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    artifact_key: OpaqueKey = Field(alias="artifactKey")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    source_identity_digest: Digest = Field(alias="sourceIdentityDigest")
    kind: Literal["file", "image", "other"]
    ordinal: NonNegativeInteger
    output_key: OutputKey | None = Field(default=None, alias="outputKey")
    mime_type: MimeType | None = Field(default=None, alias="mimeType")
    bytes: NonNegativeInteger | None = None
    sha256: Sha256 | None = None
    status: Literal["available", "transferred", "partial", "blocked"]
    blocker_code: Code | None = Field(default=None, alias="blockerCode")

    @model_validator(mode="after")
    def validate_transfer_state(self) -> "OperationArtifactReceipt":
        if self.status == "transferred" and (self.output_key is None or self.bytes is None or self.sha256 is None):
            raise ValueError("transferred artifact requires outputKey, bytes, and sha256")
        if self.status in {"partial", "blocked"} and self.blocker_code is None:
            raise ValueError("partial or blocked artifact requires blockerCode")
        if self.status in {"available", "transferred"} and self.blocker_code is not None:
            raise ValueError("available or transferred artifact forbids blockerCode")
        return self


class OperationReceipt(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_receipt.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    target_binding_digest: Digest = Field(alias="targetBindingDigest")
    user_turn_id: OpaqueId = Field(alias="userTurnId")
    user_turn_evidence_digest: Digest = Field(alias="userTurnEvidenceDigest")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    ownership_evidence_digest: Digest = Field(alias="ownershipEvidenceDigest")
    response_digest: Digest | None = Field(default=None, alias="responseDigest")
    response_bytes: NonNegativeInteger | None = Field(default=None, alias="responseBytes")
    response_format: OperationResponseFormat | None = Field(default=None, alias="responseFormat")
    finish_reason: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")] = Field(alias="finishReason")
    content_available: bool = Field(alias="contentAvailable")
    artifacts: list[OperationArtifactReceipt]
    completed_at: Instant = Field(alias="completedAt")

    @model_validator(mode="before")
    @classmethod
    def reject_null_response_format(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("responseFormat",))

    @model_validator(mode="after")
    def validate_receipt(self) -> "OperationReceipt":
        if len(self.artifacts) > MAX_ARTIFACTS:
            raise ValueError(f"artifacts is capped at {MAX_ARTIFACTS} items")
        if (self.response_digest is None) != (self.response_bytes is None):
            raise ValueError("responseDigest and responseBytes must be paired")
        if self.content_available and self.response_digest is None:
            raise ValueError("contentAvailable requires responseDigest and responseBytes")
        keys: set[str] = set()
        ordinals: set[int] = set()
        for artifact in self.artifacts:
            if artifact.operation_id != self.operation_id:
                raise ValueError("artifact operationId must match receipt operationId")
            if artifact.assistant_turn_id != self.assistant_turn_id:
                raise ValueError("artifact assistantTurnId must match receipt assistantTurnId")
            if artifact.artifact_key in keys:
                raise ValueError("artifactKey values must be unique")
            if artifact.ordinal in ordinals:
                raise ValueError("artifact ordinal values must be unique")
            keys.add(artifact.artifact_key)
            ordinals.add(artifact.ordinal)
        return self


class OperationBlocker(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_blocker.v1"] = Field(alias="schemaVersion")
    code: BlockerCode
    recoverable: bool
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    phase: OperationPhase
    mutation_boundary: MutationBoundary = Field(alias="mutationBoundary")
    message: Annotated[str, StringConstraints(min_length=1, max_length=4096)]


class OperationControlReceipt(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_control_receipt.v1"] = Field(alias="schemaVersion")
    control_action_id: Uuid = Field(alias="controlActionId")
    parent_operation_id: Uuid = Field(alias="parentOperationId")
    parent_request_digest: Digest = Field(alias="parentRequestDigest")
    parent_target_binding_digest: Digest = Field(alias="parentTargetBindingDigest")
    expected_assistant_turn_id: OpaqueId = Field(alias="expectedAssistantTurnId")
    request_digest: Digest = Field(alias="requestDigest")
    action: Literal["stop", "steer"]
    outcome: ActionOutcome
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")
    blocker_code: BlockerCode | None = Field(default=None, alias="blockerCode")
    observed_at: Instant = Field(alias="observedAt")

    @model_validator(mode="after")
    def validate_control_outcome(self) -> "OperationControlReceipt":
        if self.outcome == "satisfied" and self.evidence_digest is None:
            raise ValueError("satisfied control receipt requires evidenceDigest")
        if self.outcome == "satisfied" and self.blocker_code is not None:
            raise ValueError("satisfied control receipt forbids blockerCode")
        if self.outcome in {"not_satisfied", "uncertain"} and self.blocker_code is None:
            raise ValueError("non-satisfied control receipt requires blockerCode")
        return self


class OperationBlockerObservation(StrictWireModel):
    code: Code
    message_digest: Digest = Field(alias="messageDigest")
    recoverable: bool
    observed_at: Instant = Field(alias="observedAt")


class OperationCreatedEvent(StrictWireModel):
    type: Literal["operation_created"]
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    surface: OperationSurface
    created_at: Instant = Field(alias="createdAt")
    capture_policy: OperationDurableCapturePolicy | None = Field(default=None, alias="capturePolicy")

    @model_validator(mode="before")
    @classmethod
    def reject_null_capture_policy(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("capturePolicy",))


class OperationTargetBoundEvent(StrictWireModel):
    type: Literal["target_bound"]
    target: OperationTarget
    observed_at: Instant = Field(alias="observedAt")


class OperationTargetEstablishedEvent(StrictWireModel):
    type: Literal["target_established"]
    establishment: OperationTargetEstablishment


class OperationOwnershipBaselineEvent(StrictWireModel):
    type: Literal["ownership_baseline"]
    baseline: OperationOwnershipBaseline


class OperationSubmissionWitnessEvent(StrictWireModel):
    type: Literal["submission_witness"]
    witness: OperationSubmissionWitness


class OperationActionIntentEvent(StrictWireModel):
    type: Literal["action_intent"]
    action: OperationActionIntent
    intent_at: Instant = Field(alias="intentAt")


class OperationActionPreparedEvent(StrictWireModel):
    """Atomic non-repeatable action intent plus its ownership baseline."""

    type: Literal["action_prepared"]
    action: OperationActionIntent
    intent_at: Instant = Field(alias="intentAt")
    baseline: OperationOwnershipBaseline

    @model_validator(mode="after")
    def validate_atomic_baseline(self) -> "OperationActionPreparedEvent":
        if self.action.kind not in {"send", "work_steer"}:
            raise ValueError("action_prepared supports only send and work_steer")
        if self.baseline.action_id != self.action.action_id:
            raise ValueError("action_prepared baseline must name the prepared action")
        if self.action.target_digest != self.baseline.target_binding_digest:
            raise ValueError("action_prepared baseline target must match the prepared action")
        if self.baseline.observed_at != self.intent_at:
            raise ValueError("action_prepared baseline observedAt must equal intentAt")
        return self


class ArtifactTransferIntentEvent(StrictWireModel):
    type: Literal["artifact_transfer_intent"]
    intent: ArtifactTransferIntent


class ArtifactTransferReceiptEvent(StrictWireModel):
    type: Literal["artifact_transfer_receipt"]
    receipt: ArtifactTransferReceipt


class OperationActionReceiptEvent(StrictWireModel):
    type: Literal["action_receipt"]
    action_id: Uuid = Field(alias="actionId")
    outcome: ActionOutcome
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")
    blocker_code: Code | None = Field(default=None, alias="blockerCode")
    observed_at: Instant = Field(alias="observedAt")

    @model_validator(mode="after")
    def validate_receipt_evidence(self) -> "OperationActionReceiptEvent":
        if self.outcome == "satisfied" and self.evidence_digest is None:
            raise ValueError("satisfied action receipt requires evidenceDigest")
        if self.blocker_code is not None and self.outcome not in {"not_satisfied", "uncertain"}:
            raise ValueError("blockerCode requires a non-satisfied or uncertain outcome")
        return self


class OperationPhaseChangedEvent(StrictWireModel):
    type: Literal["phase_changed"]
    from_: OperationPhase = Field(alias="from")
    to: OperationPhase
    mutation_boundary: MutationBoundary = Field(alias="mutationBoundary")
    cause_action_id: Uuid | None = Field(default=None, alias="causeActionId")
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")
    observed_at: Instant = Field(alias="observedAt")


class OperationBlockerObservedEvent(StrictWireModel):
    type: Literal["blocker_observed"]
    blocker: OperationBlockerObservation


class OperationReceiptCompletedEvent(StrictWireModel):
    type: Literal["receipt_completed"]
    receipt: OperationReceipt
    observed_at: Instant = Field(alias="observedAt")


class OperationContentAvailabilityChangedEvent(StrictWireModel):
    type: Literal["content_availability_changed"]
    available: bool
    observed_at: Instant = Field(alias="observedAt")


OperationEvent = Annotated[
    Union[
        OperationCreatedEvent,
        OperationTargetBoundEvent,
        OperationTargetEstablishedEvent,
        OperationOwnershipBaselineEvent,
        OperationSubmissionWitnessEvent,
        OperationActionIntentEvent,
        OperationActionPreparedEvent,
        ArtifactTransferIntentEvent,
        ArtifactTransferReceiptEvent,
        OperationActionReceiptEvent,
        OperationPhaseChangedEvent,
        OperationBlockerObservedEvent,
        OperationReceiptCompletedEvent,
        OperationContentAvailabilityChangedEvent,
    ],
    Field(discriminator="type"),
]


class OperationEventEnvelope(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_event.v1"] = Field(alias="schemaVersion")
    revision: Revision
    previous_event_digest: Digest = Field(alias="previousEventDigest")
    event_digest: Digest = Field(alias="eventDigest")
    event: OperationEvent


class OperationState(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    surface: OperationSurface
    phase: OperationPhase
    mutation_boundary: MutationBoundary = Field(alias="mutationBoundary")
    revision: Revision
    created_at: Instant = Field(alias="createdAt")
    updated_at: Instant = Field(alias="updatedAt")
    capture_policy: OperationDurableCapturePolicy | None = Field(default=None, alias="capturePolicy")
    response_format: OperationResponseFormat | None = Field(default=None, alias="responseFormat")
    target: OperationTarget | None = None
    actions: dict[Uuid, OperationActionRecord]
    ownership_baseline: OperationOwnershipBaseline | None = Field(default=None, alias="ownershipBaseline")
    ownership_baselines: dict[Uuid, OperationOwnershipBaseline] | None = Field(
        default=None,
        alias="ownershipBaselines",
        max_length=MAX_OWNERSHIP_BASELINES,
    )
    artifact_transfers: dict[Uuid, ArtifactTransferState] | None = Field(default=None, alias="artifactTransfers")
    submission_witnesses: dict[Uuid, OperationSubmissionWitness] | None = Field(default=None, alias="submissionWitnesses")
    submission_witness: OperationSubmissionWitness | None = Field(default=None, alias="submissionWitness")
    last_blocker: OperationBlockerObservation | None = Field(default=None, alias="lastBlocker")
    receipt: OperationReceipt | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_response_format(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("capturePolicy", "responseFormat", "ownershipBaselines", "artifactTransfers", "submissionWitnesses"))

    @model_validator(mode="after")
    def validate_state_coherence(self) -> "OperationState":
        if self.updated_at < self.created_at:
            raise ValueError("updatedAt cannot precede createdAt")
        if self.capture_policy is not None and self.response_format is not None and self.capture_policy.response_format != self.response_format:
            raise ValueError("capturePolicy.responseFormat must match responseFormat")
        if (self.phase == "completed") != (self.receipt is not None):
            raise ValueError("only completed state may contain a terminal receipt")
        if self.ownership_baseline is not None:
            _validate_ownership_baseline_state(self, self.ownership_baseline)
        baselines = self.ownership_baselines or {}
        if len(baselines) > MAX_OWNERSHIP_BASELINES:
            raise ValueError(f"ownershipBaselines is capped at {MAX_OWNERSHIP_BASELINES} entries")
        for action_id, baseline in baselines.items():
            if action_id != baseline.action_id:
                raise ValueError("ownershipBaselines map key must match actionId")
            action = _validate_ownership_baseline_state(self, baseline)
            if action.kind == "send" and (
                self.ownership_baseline is None or self.ownership_baseline != baseline
            ):
                raise ValueError("Send ownershipBaseline must match the compatibility projection")
        if self.ownership_baseline is not None:
            projected = baselines.get(self.ownership_baseline.action_id)
            if projected is not None and projected != self.ownership_baseline:
                raise ValueError("ownershipBaseline projection conflicts with ownershipBaselines")
        transfer_states = self.artifact_transfers or {}
        transfer_tuples: set[tuple[Any, ...]] = set()
        for transfer_action_id, transfer in transfer_states.items():
            if transfer_action_id != transfer.intent.transfer_action_id:
                raise ValueError("artifactTransfers map key must match transferActionId")
            intent = transfer.intent
            if intent.operation_id != self.operation_id or intent.request_digest != self.request_digest:
                raise ValueError("artifact transfer operation identity does not match state")
            if self.target is None:
                raise ValueError("artifact transfer requires a durable target")
            original_send = next((candidate for candidate in self.actions.values() if candidate.kind == "send"), None)
            if original_send is None or original_send.target_digest != intent.target_binding_digest:
                raise ValueError("artifact transfer targetBindingDigest must match the durable original Send target")
            action = self.actions.get(transfer_action_id)
            if (
                action is None
                or action.kind != "local_output_commit"
                or action.repeat_policy != "reconcile_local_effect"
                or action.request_digest != intent.request_digest
                or action.target_digest != intent.target_binding_digest
                or action.intent_at != intent.intent_at
            ):
                raise ValueError("artifact transfer intent must match its generic local-output action")
            tuple_key = (
                intent.operation_id,
                intent.request_digest,
                intent.target_binding_digest,
                intent.assistant_turn_id,
                intent.source_identity_digest,
                intent.kind,
                intent.ordinal,
                intent.destination_identity_digest,
            )
            if tuple_key in transfer_tuples:
                raise ValueError("an artifact transfer tuple may only be transferred once")
            transfer_tuples.add(tuple_key)
            if transfer.receipt is None:
                if action.outcome is not None:
                    raise ValueError("unreceipted artifact transfer cannot have a settled generic action")
                continue
            receipt = transfer.receipt
            if (
                receipt.operation_id != intent.operation_id
                or receipt.request_digest != intent.request_digest
                or receipt.target_binding_digest != intent.target_binding_digest
                or receipt.assistant_turn_id != intent.assistant_turn_id
                or receipt.source_identity_digest != intent.source_identity_digest
                or receipt.kind != intent.kind
                or receipt.ordinal != intent.ordinal
                or receipt.transfer_action_id != intent.transfer_action_id
                or receipt.destination_identity_digest != intent.destination_identity_digest
            ):
                raise ValueError("artifact transfer receipt identity does not match its intent")
            if receipt.observed_at < intent.intent_at:
                raise ValueError("artifact transfer receipt cannot precede its intent")
            expected_outcome: ActionOutcome = (
                "satisfied"
                if receipt.status == "transferred"
                else "not_satisfied"
                if receipt.status == "blocked" and receipt.blocker_code == "output_collision"
                else "uncertain"
            )
            if action.outcome != expected_outcome or action.receipt_at != receipt.observed_at:
                raise ValueError("artifact transfer receipt must match its generic action receipt")
            if expected_outcome == "satisfied" and action.evidence_digest != receipt.destination_identity_digest:
                raise ValueError("transferred artifact receipt evidence must match destination identity")
            if expected_outcome != "satisfied" and action.blocker_code != receipt.blocker_code:
                raise ValueError("artifact transfer blocker must match its generic action receipt")
        if transfer_states and (
            self.capture_policy is None
            or self.capture_policy.artifacts != "transfer"
        ):
            raise ValueError("durable artifact transfers require the immutable transfer capture policy")
        if self.receipt is not None and self.capture_policy is not None:
            if self.capture_policy.artifacts == "receipt_only":
                if transfer_states:
                    raise ValueError("receipt-only completion cannot contain durable artifact transfers")
                for artifact in self.receipt.artifacts:
                    if artifact.status != "available" or artifact.output_key is not None:
                        raise ValueError("receipt-only completion cannot contain transfer-enriched artifacts")
            elif self.capture_policy.artifacts == "transfer":
                transfer_by_artifact: dict[tuple[Any, ...], ArtifactTransferState] = {}
                for transfer_action_id, transfer in transfer_states.items():
                    if transfer.receipt is None:
                        raise ValueError(
                            f"transfer {transfer_action_id} has no durable receipt before terminal completion"
                        )
                    intent = transfer.intent
                    identity = (
                        intent.operation_id,
                        intent.assistant_turn_id,
                        intent.source_identity_digest,
                        intent.kind,
                        intent.ordinal,
                    )
                    if identity in transfer_by_artifact:
                        raise ValueError("terminal completion allows at most one settled transfer per exact artifact identity")
                    transfer_by_artifact[identity] = transfer

                receipt_identities: set[tuple[Any, ...]] = set()
                for artifact in self.receipt.artifacts:
                    if artifact.status == "available":
                        raise ValueError("transfer-policy completion cannot contain an artifact that remains available")
                    identity = (
                        artifact.operation_id,
                        artifact.assistant_turn_id,
                        artifact.source_identity_digest,
                        artifact.kind,
                        artifact.ordinal,
                    )
                    if identity in receipt_identities:
                        raise ValueError("terminal receipt contains duplicate exact artifact identities")
                    receipt_identities.add(identity)
                    transfer = transfer_by_artifact.get(identity)
                    if transfer is None or transfer.receipt is None:
                        raise ValueError("every terminal transfer-policy artifact requires one matching durable transfer receipt")
                    rich = transfer.receipt
                    if (
                        artifact.status != rich.status
                        or artifact.output_key != rich.output_key
                        or artifact.bytes != rich.bytes
                        or artifact.sha256 != rich.sha256
                        or artifact.blocker_code != rich.blocker_code
                    ):
                        raise ValueError("terminal artifact status and transfer receipt facts must match exactly")
                if len(transfer_by_artifact) != len(receipt_identities):
                    raise ValueError("every durable transfer must have one matching terminal artifact receipt")
        if self.submission_witnesses is not None:
            if len(self.submission_witnesses) > MAX_SUBMISSION_WITNESSES:
                raise ValueError(
                    f"submissionWitnesses is capped at {MAX_SUBMISSION_WITNESSES} entries"
                )
            for action_id, witness in self.submission_witnesses.items():
                if action_id != witness.action_id:
                    raise ValueError("submissionWitnesses map key must match actionId")
                _validate_submission_witness_state(self, witness, allow_legacy_baseline=False)
            send_witnesses = [
                witness
                for witness in self.submission_witnesses.values()
                if witness.action_kind == "send"
            ]
            if len(send_witnesses) > 1:
                raise ValueError("an operation may contain only one original Send submission witness")
            if send_witnesses and (
                self.submission_witness is None
                or self.submission_witness != send_witnesses[0]
            ):
                raise ValueError(
                    "the original Send submission witness must be retained through the legacy projection"
                )
        if self.submission_witness is not None:
            if self.submission_witness.action_kind != "send":
                raise ValueError(
                    "the legacy submissionWitness field must project the original Send witness"
                )
            _validate_submission_witness_state(
                self,
                self.submission_witness,
                allow_legacy_baseline=self.submission_witnesses is None,
            )
            if self.submission_witnesses is not None:
                projected = self.submission_witnesses.get(self.submission_witness.action_id)
                if projected is None or projected != self.submission_witness:
                    raise ValueError(
                        "the original Send submission witness must match its keyed projection exactly"
                    )
        expected_boundary: MutationBoundary = "none"
        rank = {
            "none": 0,
            "handoff_may_have_occurred": 1,
            "send_may_have_occurred": 2,
            "control_may_have_occurred": 3,
        }
        revisions: set[int] = set()
        non_repeatable: set[str] = set()
        has_handoff = False
        has_submit = False
        for key, action in self.actions.items():
            if key != action.action_id:
                raise ValueError("action map key must match actionId")
            if action.intent_revision > self.revision or action.intent_revision in revisions:
                raise ValueError("action intent revision is inconsistent with state")
            revisions.add(action.intent_revision)
            if action.receipt_revision is not None:
                if action.receipt_revision > self.revision or action.receipt_revision in revisions:
                    raise ValueError("action receipt revision is inconsistent with state")
                revisions.add(action.receipt_revision)
            if action.intent_at > self.updated_at or (action.receipt_at is not None and action.receipt_at > self.updated_at):
                raise ValueError("action timestamp cannot follow state updatedAt")
            if action.kind != "status_read" and self.target is None:
                raise ValueError("target-bound action requires state target")
            if action.kind in {"file_handoff", "send"}:
                if action.kind in non_repeatable:
                    raise ValueError("non-repeatable action kind cannot appear twice")
                non_repeatable.add(action.kind)
            if action.kind == "file_handoff":
                has_handoff = True
                if rank[expected_boundary] < 1:
                    expected_boundary = "handoff_may_have_occurred"
            elif action.kind == "send":
                has_submit = True
                if rank[expected_boundary] < 2:
                    expected_boundary = "send_may_have_occurred"
            elif action.kind == "work_steer":
                expected_boundary = "control_may_have_occurred"
            elif action.kind == "stop":
                expected_boundary = "control_may_have_occurred"
        if self.mutation_boundary != expected_boundary:
            raise ValueError("mutationBoundary does not match the action ledger")
        if self.phase == "handoff_pending" and not has_handoff:
            raise ValueError("handoff_pending requires file_handoff intent")
        if self.phase == "send_pending" and not has_submit:
            raise ValueError("send_pending requires the durable original Send intent")
        if self.phase in {"submitted", "generating", "capturing", "completed"}:
            send_actions = [action for action in self.actions.values() if action.kind == "send"]
            if len(send_actions) != 1:
                raise ValueError(f"{self.phase} requires exactly one durable original Send intent")
            send_action = send_actions[0]
            if send_action.outcome != "satisfied":
                raise ValueError(f"{self.phase} requires a satisfied original Send action")
            baseline = (
                self.ownership_baselines.get(send_action.action_id)
                if self.ownership_baselines is not None
                else None
            )
            if baseline is None:
                raise ValueError(f"{self.phase} requires the keyed pre-Send ownership baseline")
            witness = (
                self.submission_witnesses.get(send_action.action_id)
                if self.submission_witnesses is not None
                else None
            )
            if witness is None:
                raise ValueError(f"{self.phase} requires the keyed original Send submission witness")
            if (
                baseline.action_id != send_action.action_id
                or baseline.operation_id != self.operation_id
                or baseline.request_digest != self.request_digest
                or baseline.target_binding_digest != send_action.target_digest
                or witness.action_id != send_action.action_id
                or witness.action_kind != "send"
                or witness.target_binding_digest != send_action.target_digest
                or witness.baseline_snapshot_digest != baseline.baseline.snapshot_digest
            ):
                raise ValueError(f"{self.phase} original Send ownership proof is inconsistent")
            if self.ownership_baseline != baseline or self.submission_witness != witness:
                raise ValueError(f"{self.phase} original Send ownership projections are inconsistent")
        if self.receipt is not None:
            if self.receipt.operation_id != self.operation_id or self.receipt.request_digest != self.request_digest:
                raise ValueError("receipt identity must match state identity")
            if self.receipt.completed_at > self.updated_at:
                raise ValueError("receipt completedAt cannot follow state updatedAt")
            send_action = next(action for action in self.actions.values() if action.kind == "send")
            if send_action.target_digest != self.receipt.target_binding_digest:
                raise ValueError("receipt targetBindingDigest must match submitted target")
            if (
                self.capture_policy is not None
                and self.receipt.response_format != self.capture_policy.response_format
            ):
                raise ValueError("receipt responseFormat must match capturePolicy.responseFormat")
        return self


def _validate_ownership_baseline_state(
    state: OperationState,
    baseline: OperationOwnershipBaseline,
) -> OperationActionRecord:
    """Validate one immutable pre-action ownership anchor against state.

    Work steer preparation intentionally redacts the canonical thread URL even
    when the durable fixed target retains it.  That is the only unavailable
    target identity accepted for a fixed-target baseline.  Every other
    durable identity remains an exact comparison, and a Send baseline still
    requires an available URL whenever the durable target carries one.

    A Work steer that was durably rejected (``not_satisfied``) retains its
    baseline as settled evidence of the attempted action, but an uncertain
    action never does.  Submission witnesses are validated separately and
    still require a satisfied causal action.
    """

    if baseline.operation_id != state.operation_id or baseline.request_digest != state.request_digest:
        raise ValueError("ownershipBaseline operation identity does not match state")
    action = state.actions.get(baseline.action_id)
    if action is None or action.kind not in {"send", "work_steer"}:
        raise ValueError("ownershipBaseline must name its durable causal action")
    if action.target_digest != baseline.target_binding_digest:
        raise ValueError("ownershipBaseline target does not match its causal action")

    # A Work steer baseline remains useful after a clean, durably rejected
    # attempt.  An uncertain action is different: it may have crossed the
    # mutation boundary and therefore cannot leave a reusable anchor behind.
    rejected_work_steer = action.kind == "work_steer" and action.outcome == "not_satisfied"
    if action.outcome is not None and action.outcome != "satisfied" and not rejected_work_steer:
        raise ValueError("ownershipBaseline cannot follow an uncertain or rejected action")
    if baseline.observed_at < action.intent_at:
        raise ValueError("ownershipBaseline cannot precede its causal action")
    if state.target is None:
        raise ValueError("ownershipBaseline requires a durable target")

    target = state.target
    evidence = baseline.baseline.target
    target_is_fixed = (target.target_lifecycle or "fixed") == "fixed"

    def available_value(value: OwnershipIdentityEvidence | OwnershipUrlIdentityEvidence) -> str | None:
        return value.value if value.status == "available" else None

    # Provider/browser/tab and coordination identities are always required to
    # match.  Conversation identity is compared for fixed targets when the
    # durable target exposes it; new-target baselines intentionally predate
    # provider conversation allocation.
    if (
        available_value(evidence.provider) != target.provider_id
        or available_value(evidence.browser) != target.browser_id
        or available_value(evidence.tab) != target.tab_id
        or evidence.coordination_scope != target.coordination_scope
        or (
            target_is_fixed
            and target.conversation_id is not None
            and available_value(evidence.conversation) != target.conversation_id
        )
    ):
        raise ValueError("ownershipBaseline target evidence does not match durable target")

    baseline_url = evidence.canonical_thread_url
    redacted_work_steer_url = (
        action.kind == "work_steer"
        and baseline_url.status == "unavailable"
        and baseline_url.reason == "redacted"
    )
    if target_is_fixed:
        if redacted_work_steer_url:
            # This is deliberately the sole URL exception.  The comparisons
            # above still reject any provider/browser/tab/conversation drift.
            pass
        elif target.canonical_thread_url is not None:
            if (
                baseline_url.status != "available"
                or baseline_url.value != target.canonical_thread_url
            ):
                raise ValueError("ownershipBaseline target evidence does not match durable target")
        elif action.kind == "work_steer":
            # Fixed-target Work anchors must use the mandated redaction when a
            # durable URL is not available to the operation.
            raise ValueError("ownershipBaseline target evidence does not match durable target")

    return action


def _validate_submission_witness_state(
    state: OperationState,
    witness: OperationSubmissionWitness,
    *,
    allow_legacy_baseline: bool,
) -> None:
    """Validate one keyed witness against its exact action and baseline.

    The legacy ``ownershipBaseline`` wrapper is accepted only when the state
    has no keyed baseline map at all.  Once a state has adopted per-action
    baselines, a witness (including a Work steer witness) must name its own
    durable map entry.
    """

    baselines = state.ownership_baselines
    baseline = baselines.get(witness.action_id) if baselines is not None else None
    if baseline is None and allow_legacy_baseline and baselines is None:
        if (
            state.ownership_baseline is not None
            and state.ownership_baseline.action_id == witness.action_id
        ):
            baseline = state.ownership_baseline
    if baseline is None:
        raise ValueError("submissionWitness requires the ownership baseline for its causal action")
    if (
        baseline.operation_id != state.operation_id
        or baseline.request_digest != state.request_digest
        or baseline.target_binding_digest != witness.target_binding_digest
        or baseline.action_id != witness.action_id
        or baseline.baseline.snapshot_digest != witness.baseline_snapshot_digest
    ):
        raise ValueError("submissionWitness does not match ownershipBaseline")
    action = state.actions.get(witness.action_id)
    if action is None or action.kind != witness.action_kind:
        raise ValueError("submissionWitness must name its durable causal action")
    if action.target_digest != witness.target_binding_digest:
        raise ValueError("submissionWitness target does not match its causal action")
    if action.outcome in {"not_satisfied", "uncertain"}:
        raise ValueError("submissionWitness cannot follow an unsatisfied or uncertain action")
    if witness.observed_at < action.intent_at:
        raise ValueError("submissionWitness cannot precede its causal action")
    if state.target is None:
        raise ValueError("submissionWitness requires a durable target")
    if (state.target.target_lifecycle or "fixed") == "new_pending":
        raise ValueError("pending new targets cannot contain submissionWitness")
    establishment = state.target.target_establishment
    if establishment is not None and establishment.causal_send_action_id == witness.action_id:
        if (
            establishment.target_binding_digest != witness.target_binding_digest
            or establishment.user_turn_evidence_digest != witness.operation_user_evidence_digest
            or establishment.post_send_delta_digest != witness.post_send_delta_digest
            or (
                witness.user_turn_id is not None
                and establishment.user_turn_id != witness.user_turn_id
            )
        ):
            raise ValueError("submissionWitness conflicts with target establishment")


class OperationJournalSnapshot(StrictWireModel):
    """Checksummed materialized cache shape from the TypeScript wire types."""

    schema_version: Literal["chatgpt.browser_control.operation.v1"] = Field(alias="schemaVersion")
    last_event_digest: Digest = Field(alias="lastEventDigest")
    state: OperationState


class OperationTargetObservationMatches(StrictWireModel):
    status: Literal["matches"]


class OperationTargetObservationMismatch(StrictWireModel):
    status: Literal["mismatch"]
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")


class OperationTargetObservationUnavailable(StrictWireModel):
    status: Literal["unavailable"]
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")


OperationTargetObservation = Annotated[
    Union[
        OperationTargetObservationMatches,
        OperationTargetObservationMismatch,
        OperationTargetObservationUnavailable,
    ],
    Field(discriminator="status"),
]


class OperationTurnObservationNotObserved(StrictWireModel):
    status: Literal["not_observed"]


class OperationTurnObservationOwnedUser(StrictWireModel):
    status: Literal["owned_user_turn"]
    user_turn_id: OpaqueId = Field(alias="userTurnId")
    evidence_digest: Digest = Field(alias="evidenceDigest")


class OperationTurnObservationOwnedAssistantGenerating(StrictWireModel):
    status: Literal["owned_assistant_generating"]
    user_turn_id: OpaqueId = Field(alias="userTurnId")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    evidence_digest: Digest = Field(alias="evidenceDigest")


class OperationTurnObservationOwnedAssistantTerminal(StrictWireModel):
    status: Literal["owned_assistant_terminal"]
    user_turn_id: OpaqueId = Field(alias="userTurnId")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    evidence_digest: Digest = Field(alias="evidenceDigest")


class OperationTurnObservationAmbiguous(StrictWireModel):
    status: Literal["ambiguous"]
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")


OperationTurnObservation = Annotated[
    Union[
        OperationTurnObservationNotObserved,
        OperationTurnObservationOwnedUser,
        OperationTurnObservationOwnedAssistantGenerating,
        OperationTurnObservationOwnedAssistantTerminal,
        OperationTurnObservationAmbiguous,
    ],
    Field(discriminator="status"),
]


class OperationRecoveryObservation(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_observation.v1"] = Field(alias="schemaVersion")
    target: OperationTargetObservation
    turn: OperationTurnObservation


class RecoveryReturnCompletedReceipt(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_decision.v1"] = Field(alias="schemaVersion")
    kind: Literal["return_completed_receipt"]
    receipt: OperationReceipt


class RecoveryContinuePreparation(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_decision.v1"] = Field(alias="schemaVersion")
    kind: Literal["continue_preparation"]
    phase: Literal["prepared", "ready"]
    non_repeatable_action_may_start: Literal[True] = Field(alias="nonRepeatableActionMayStart")


class RecoveryObserveActionPostcondition(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_decision.v1"] = Field(alias="schemaVersion")
    kind: Literal["observe_action_postcondition"]
    action_id: Uuid = Field(alias="actionId")
    action_kind: OperationActionKind = Field(alias="actionKind")
    may_repeat_action: Literal[False] = Field(alias="mayRepeatAction")


class RecoveryContinueOwnedTurnObservation(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_decision.v1"] = Field(alias="schemaVersion")
    kind: Literal["continue_owned_turn_observation"]
    phase: Literal["submitted", "generating"]
    user_turn_id: OpaqueId | None = Field(default=None, alias="userTurnId")
    assistant_turn_id: OpaqueId | None = Field(default=None, alias="assistantTurnId")
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")


class RecoveryCaptureOwnedTurn(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_decision.v1"] = Field(alias="schemaVersion")
    kind: Literal["capture_owned_turn"]
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    evidence_digest: Digest = Field(alias="evidenceDigest")


class RecoveryEnterUncertain(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_decision.v1"] = Field(alias="schemaVersion")
    kind: Literal["enter_uncertain"]
    code: Literal["target_evidence_unavailable", "turn_ownership_ambiguous", "capture_ownership_lost"]
    may_repeat_action: Literal[False] = Field(alias="mayRepeatAction")


class RecoveryBlock(StrictWireModel):
    schema_version: Literal["chatgpt.browser_control.operation_recovery_decision.v1"] = Field(alias="schemaVersion")
    kind: Literal["block"]
    code: Literal["target_binding_mismatch", "target_evidence_unavailable", "operation_state_inconsistent"]
    may_repeat_action: Literal[False] = Field(alias="mayRepeatAction")


OperationRecoveryDecision = Annotated[
    Union[
        RecoveryReturnCompletedReceipt,
        RecoveryContinuePreparation,
        RecoveryObserveActionPostcondition,
        RecoveryContinueOwnedTurnObservation,
        RecoveryCaptureOwnedTurn,
        RecoveryEnterUncertain,
        RecoveryBlock,
    ],
    Field(discriminator="kind"),
]


def validate_recovery_payload(payload: dict[str, Any]) -> OperationRecoveryObservation | OperationRecoveryDecision:
    """Parse either recovery observation or decision using its discriminators."""

    if type(payload) is not dict or any(type(key) is not str for key in payload):
        raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)
    if payload.get("schemaVersion") == RECOVERY_OBSERVATION_SCHEMA:
        return OperationRecoveryObservation.from_wire(payload)
    if payload.get("schemaVersion") == RECOVERY_DECISION_SCHEMA:
        try:
            return TypeAdapter(OperationRecoveryDecision).validate_python(
                payload,
                context={_WIRE_VALIDATION_CONTEXT: True},
            )
        except Exception:
            pass
        raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE) from None
    raise ValueError(_INVALID_WIRE_PAYLOAD_MESSAGE)


__all__ = [
    "ARTIFACT_SCHEMA",
    "ARTIFACT_TRANSFER_INTENT_SCHEMA",
    "ARTIFACT_TRANSFER_RECEIPT_SCHEMA",
    "BLOCKER_SCHEMA",
    "COLLECT_SCHEMA",
    "CONTROL_RECEIPT_SCHEMA",
    "CONTROL_REQUEST_SCHEMA",
    "EVENT_SCHEMA",
    "HANDLE_SCHEMA",
    "INSPECT_SCHEMA",
    "MAX_SUBMISSION_WITNESSES",
    "MAX_OWNERSHIP_BASELINES",
    "RECOVERY_DECISION_SCHEMA",
    "RECOVERY_OBSERVATION_SCHEMA",
    "RECEIPT_SCHEMA",
    "REQUEST_SCHEMA",
    "OWNERSHIP_BASELINE_SCHEMA",
    "OWNERSHIP_SCHEMA",
    "SUBMISSION_WITNESS_SCHEMA",
    "TURN_SCHEMA",
    "OperationActionIntent",
    "OperationActionIntentEvent",
    "OperationActionPreparedEvent",
    "ArtifactTransferKind",
    "ArtifactTransferStatus",
    "ArtifactTransferIntent",
    "ArtifactTransferReceipt",
    "ArtifactTransferState",
    "ArtifactTransferIntentEvent",
    "ArtifactTransferReceiptEvent",
    "OperationActionReceiptEvent",
    "OperationActionRecord",
    "OperationArtifactReceipt",
    "OperationBlocker",
    "OperationBlockerObservedEvent",
    "OperationBlockerObservation",
    "OperationCollectRequest",
    "OperationCapturePolicy",
    "OperationDurableCapturePolicy",
    "OperationCapturePolicyState",
    "OperationResponseFormat",
    "OperationConfiguration",
    "OperationContentAvailabilityChangedEvent",
    "OperationControlReceipt",
    "OperationControlRequest",
    "OperationCreatedEvent",
    "OperationEventEnvelope",
    "OperationHandle",
    "OperationInputFile",
    "OperationInspectRequest",
    "OperationJournalSnapshot",
    "OperationPhaseChangedEvent",
    "OperationReceipt",
    "OperationReceiptCompletedEvent",
    "OperationOwnershipBaseline",
    "OperationOwnershipBaselineEvent",
    "OperationRecoveryObservation",
    "OperationState",
    "OperationSubmissionWitness",
    "OperationSubmissionWitnessEvent",
    "OperationSubmitRequest",
    "OperationTarget",
    "OperationTargetEstablishment",
    "OperationTargetEstablishmentRead",
    "OperationTargetEstablishedEvent",
    "OperationTargetRequest",
    "OperationTargetBoundEvent",
    "OperationTargetObservation",
    "OperationTurnObservation",
    "OperationEvidenceProfile",
    "OperationEvent",
    "OperationRecoveryDecision",
    "OperationTurnObservationAmbiguous",
    "OperationTurnObservationOwnedAssistantGenerating",
    "OperationTurnObservationOwnedAssistantTerminal",
    "OperationTurnObservationOwnedUser",
    "OperationTurnObservationNotObserved",
    "OwnershipBaseline",
    "OwnershipIdentityAvailable",
    "OwnershipIdentityEvidence",
    "OwnershipIdentityUnavailable",
    "OwnershipTargetEvidence",
    "OwnershipTurn",
    "OwnershipUrlIdentityAvailable",
    "OwnershipUrlIdentityEvidence",
    "RecoveryBlock",
    "RecoveryCaptureOwnedTurn",
    "RecoveryContinueOwnedTurnObservation",
    "RecoveryContinuePreparation",
    "RecoveryEnterUncertain",
    "RecoveryObserveActionPostcondition",
    "RecoveryReturnCompletedReceipt",
    "StrictWireModel",
    "validate_recovery_payload",
]
