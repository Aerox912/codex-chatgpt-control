"""Typed Python facade for transactional browser-operation wire envelopes.

The operation service owns browser selection, journaling, recovery, and DOM
interaction. This module is deliberately only a protocol boundary: request
models are built by :mod:`operation_models`, while every backend result is
decoded as one of the strict, versioned result envelopes defined by the v1
contract.

The result envelopes always carry the current (fresh) handle. A ``run`` is
therefore exactly one submit followed by at most one collect for an accepted
submit result; it never retries Send and it never treats an accepted result as
terminal success. Raw response text, when requested, is represented only by
the explicitly ephemeral ``live_response`` value and is never part of a
durable receipt or operation state.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, NoReturn, TypeVar

from pydantic import Field, StringConstraints, TypeAdapter, ValidationError, model_validator
from typing_extensions import Annotated

from .operation_models import (
    ARTIFACT_SCHEMA,
    ArtifactTransferState,
    BLOCKER_SCHEMA,
    CollectPollInterval,
    COLLECT_SCHEMA,
    CONTROL_RECEIPT_SCHEMA,
    CONTROL_REQUEST_SCHEMA,
    HANDLE_SCHEMA,
    MAX_JSON_DEPTH,
    MAX_JSON_NODES,
    INSPECT_SCHEMA,
    MAX_SUBMISSION_WITNESSES,
    RECEIPT_SCHEMA,
    TURN_SCHEMA,
    BlockerCode,
    Code,
    Digest,
    Instant,
    MutationBoundary,
    OpaqueId,
    OpaqueKey,
    OperationActionRecord,
    OperationBlocker,
    OperationBlockerObservation,
    BackendCompatibilityReport,
    OperationCollectRequest,
    OperationControlReceipt,
    OperationControlRequest,
    OperationDurableCapturePolicy,
    OperationHandle,
    OperationInspectRequest,
    OperationOwnershipBaseline,
    OperationPhase,
    OperationReceipt,
    OperationResponseFormat,
    OperationState,
    OperationSubmissionWitness,
    OperationSubmitRequest,
    OperationSurface,
    OperationTarget,
    OutputKey,
    Sha256,
    StrictWireModel,
    Uuid,
)


SUBMIT_COMMAND = "operations.submit"
COLLECT_COMMAND = "operations.collect"
INSPECT_COMMAND = "operations.inspect"
CONTROL_COMMAND = "operations.control"

SUBMIT_RESULT_SCHEMA = "chatgpt.browser_control.operation_submit_result.v1"
COLLECT_RESULT_SCHEMA = "chatgpt.browser_control.operation_collect_result.v1"
INSPECT_RESULT_SCHEMA = "chatgpt.browser_control.operation_inspect_result.v1"
CONTROL_RESULT_SCHEMA = "chatgpt.browser_control.operation_control_result.v1"
LIVE_RESPONSE_SCHEMA = "chatgpt.browser_control.operation_live_response.v1"

MAX_WIRE_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_WIRE_RESPONSE_CHARS = 8 * 1024 * 1024
MAX_WIRE_BLOCKER_MESSAGE_LENGTH = 512
MAX_WIRE_ARTIFACTS = 32
MAX_SAFE_INTEGER = 9_007_199_254_740_991
_COLLECT_POLL_INTERVAL_ADAPTER = TypeAdapter(CollectPollInterval)
_BOUNDARY_RANK: dict[str, int] = {
    "none": 0,
    "handoff_may_have_occurred": 1,
    "send_may_have_occurred": 2,
    "control_may_have_occurred": 3,
}

_ModelT = TypeVar("_ModelT", bound=StrictWireModel)


_REQUEST_ERROR_MESSAGE = "Transactional operation request is invalid."
_MAX_REQUEST_KEY_BYTES = 256
_MAX_REQUEST_ARRAY_LENGTH = MAX_JSON_NODES
_MAX_REQUEST_OBJECT_KEYS = MAX_JSON_NODES
_MAX_REQUEST_UTF8_BYTES = 16 * 1024 * 1024


class _OperationRequestError(ValueError):
    """Private marker for a fixed, non-sensitive request-boundary error."""


def _invalid_operation_request() -> NoReturn:
    raise _OperationRequestError(_REQUEST_ERROR_MESSAGE)


@dataclass
class _WireBudget:
    nodes: int = 0
    utf8_bytes: int = 0
    active: set[int] = field(default_factory=set)

    def visit(self, depth: int) -> None:
        self.nodes += 1
        if self.nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
            _invalid_operation_request()

    def add_text(self, value: str) -> None:
        try:
            size = len(value.encode("utf-8"))
        except UnicodeEncodeError as exc:
            raise _OperationRequestError(_REQUEST_ERROR_MESSAGE) from exc
        self.utf8_bytes += size
        if self.utf8_bytes > _MAX_REQUEST_UTF8_BYTES:
            _invalid_operation_request()


def _wire_value(value: Any, *, budget: _WireBudget | None = None, depth: int = 0) -> Any:
    """Convert only bounded, JSON-like SDK values into camel-case wire data.

    Request inputs may be supplied as plain dictionaries/lists or as the
    package's own ``StrictWireModel`` instances.  Arbitrary objects are not
    introspected and their ``to_wire`` attributes are never looked up.  Plain
    containers are traversed with a shared budget so cycles and hostile,
    unbounded inputs fail before a backend request is attempted.
    """

    active_budget = budget if budget is not None else _WireBudget()

    if isinstance(value, StrictWireModel):
        # Check exact classes rather than module names: a caller-defined
        # subclass can spoof ``__module__`` and install Pydantic serializers
        # with arbitrary behavior. Only the four request envelopes and the
        # two handle types accepted by this facade cross this shortcut.
        if type(value) not in {
            OperationSubmitRequest,
            OperationCollectRequest,
            OperationInspectRequest,
            OperationControlRequest,
            OperationHandle,
            OperationWireHandle,
        }:
            _invalid_operation_request()
        active_budget.visit(depth)
        identity = id(value)
        if identity in active_budget.active:
            _invalid_operation_request()
        active_budget.active.add(identity)
        try:
            try:
                # Deliberately dispatch the trusted SDK base implementation,
                # never an arbitrary object's or subclass's ``to_wire``.
                model_payload = StrictWireModel.to_wire(value)
            except Exception as exc:
                raise _OperationRequestError(_REQUEST_ERROR_MESSAGE) from exc
            return _wire_value(model_payload, budget=active_budget, depth=depth + 1)
        finally:
            active_budget.active.discard(identity)

    if type(value) is dict:
        active_budget.visit(depth)
        identity = id(value)
        if identity in active_budget.active:
            _invalid_operation_request()
        active_budget.active.add(identity)
        try:
            if len(value) > _MAX_REQUEST_OBJECT_KEYS:
                _invalid_operation_request()
            converted: dict[str, Any] = {}
            for key, child in value.items():
                # Require the exact builtin type.  A str subclass can
                # override methods such as ``encode`` or ``__str__``.
                if type(key) is not str:
                    _invalid_operation_request()
                normalized = _snake_to_camel(key, budget=active_budget)
                if normalized in converted:
                    _invalid_operation_request()
                converted[normalized] = _wire_value(child, budget=active_budget, depth=depth + 1)
            return converted
        except _OperationRequestError:
            raise
        except Exception as exc:
            # Mapping iteration must not expose an implementation exception,
            # private key, or value in a public request-boundary diagnostic.
            raise _OperationRequestError(_REQUEST_ERROR_MESSAGE) from exc
        finally:
            active_budget.active.discard(identity)

    if type(value) in (list, tuple):
        active_budget.visit(depth)
        identity = id(value)
        if identity in active_budget.active:
            _invalid_operation_request()
        active_budget.active.add(identity)
        try:
            if len(value) > _MAX_REQUEST_ARRAY_LENGTH:
                _invalid_operation_request()
            return [_wire_value(child, budget=active_budget, depth=depth + 1) for child in value]
        except _OperationRequestError:
            raise
        except Exception as exc:
            raise _OperationRequestError(_REQUEST_ERROR_MESSAGE) from exc
        finally:
            active_budget.active.discard(identity)

    if value is None or type(value) is bool:
        active_budget.visit(depth)
        return value
    if type(value) is int:
        active_budget.visit(depth)
        if value < -MAX_SAFE_INTEGER or value > MAX_SAFE_INTEGER:
            _invalid_operation_request()
        return value
    if type(value) is float:
        active_budget.visit(depth)
        if not math.isfinite(value):
            _invalid_operation_request()
        return value
    if type(value) is str:
        active_budget.visit(depth)
        active_budget.add_text(value)
        return value

    # Mapping subclasses, arbitrary objects, bytes, enums, and other values
    # are intentionally unsupported.  In particular, do not inspect a
    # user-provided object's attributes or call its ``to_wire`` method.
    _invalid_operation_request()


def _snake_to_camel(key: str, *, budget: _WireBudget | None = None) -> str:
    if type(key) is not str:
        _invalid_operation_request()
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in key):
        _invalid_operation_request()
    if budget is not None:
        try:
            if len(key.encode("utf-8")) > _MAX_REQUEST_KEY_BYTES:
                _invalid_operation_request()
        except UnicodeEncodeError as exc:
            raise _OperationRequestError(_REQUEST_ERROR_MESSAGE) from exc
        budget.add_text(key)
    head, *tail = key.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _model_from_input(
    model: type[_ModelT],
    value: _ModelT | Mapping[str, Any],
    *,
    schema_version: str,
) -> _ModelT:
    if not isinstance(value, model) and type(value) is not dict:
        _invalid_operation_request()
    budget = _WireBudget()
    payload = _wire_value(value, budget=budget)
    if type(payload) is not dict:
        _invalid_operation_request()
    payload.setdefault("schemaVersion", schema_version)
    try:
        return model.from_wire(payload)
    except Exception as exc:
        raise _OperationRequestError(_REQUEST_ERROR_MESSAGE) from exc


def _build_request(
    model: type[_ModelT],
    request: _ModelT | Mapping[str, Any] | None,
    fields: Mapping[str, Any],
    *,
    schema_version: str,
    required: tuple[str, ...],
) -> _ModelT:
    if request is not None and any(value is not None for value in fields.values()):
        _invalid_operation_request()
    if request is not None:
        return _model_from_input(model, request, schema_version=schema_version)
    budget = _WireBudget()
    payload: dict[str, Any] = {
        key: _wire_value(value, budget=budget)
        for key, value in fields.items()
        if value is not None
    }
    payload.setdefault("schemaVersion", schema_version)
    missing = [key for key in required if key not in payload]
    if missing:
        _invalid_operation_request()
    try:
        return model.from_wire(payload)
    except Exception as exc:
        raise _OperationRequestError(_REQUEST_ERROR_MESSAGE) from exc


def _validate_poll_interval_ms(value: Any, *, allow_none: bool = True) -> int | None:
    """Validate the bounded collector cadence using the strict wire type."""

    if value is None and allow_none:
        return None
    try:
        return _COLLECT_POLL_INTERVAL_ADAPTER.validate_python(value, strict=True)
    except (TypeError, ValueError, ValidationError) as exc:
        raise ValueError("poll_interval_ms must be an integer between 0 and 60000.") from exc


def _reject_explicit_nulls(value: Any, fields: tuple[str, ...]) -> Any:
    """Match the TS validators: optional wire properties are omitted, not null."""

    if isinstance(value, Mapping) and any(key in value and value[key] is None for key in fields):
        raise ValueError("optional wire fields must be omitted when absent")
    return value


def _reject_explicit_null_values(value: Any) -> Any:
    """Reject JSON ``null`` anywhere in a durable operation state.

    Durable operation contracts use omission for optional fields.  The nested
    journal models retain Python ``None`` as their in-memory representation,
    so their individual validators cannot distinguish an omitted wire field
    from an explicit JSON null.  The inspect wire boundary can: a materialized
    durable state has no nullable wire values.  Walking this bounded payload
    keeps Python aligned with the TypeScript exact-record validators and the
    ``additionalProperties: false`` JSON schemas.
    """

    if value is None:
        raise ValueError("durable operation state must omit optional fields instead of using null")
    if isinstance(value, Mapping):
        for child in value.values():
            _reject_explicit_null_values(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _reject_explicit_null_values(child)
    return value


class OperationWireHandle(StrictWireModel):
    """The fresh handle carried by every operation result envelope."""

    schema_version: Literal["chatgpt.browser_control.operation_handle.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    surface: OperationSurface
    revision: int = Field(ge=1, le=MAX_SAFE_INTEGER)
    phase: OperationPhase
    mutation_boundary: MutationBoundary = Field(alias="mutationBoundary")
    target_binding_digest: Digest | None = Field(default=None, alias="targetBindingDigest")

    @model_validator(mode="before")
    @classmethod
    def reject_null_target_digest(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("targetBindingDigest",))


class OperationWireArtifact(StrictWireModel):
    """Bounded artifact metadata nested in a durable receipt."""

    schema_version: Literal["chatgpt.browser_control.operation_artifact_receipt.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    artifact_key: OpaqueKey = Field(alias="artifactKey")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    source_identity_digest: Digest = Field(alias="sourceIdentityDigest")
    kind: Literal["file", "image", "other"]
    ordinal: int = Field(ge=0, lt=MAX_WIRE_ARTIFACTS)
    output_key: OutputKey | None = Field(default=None, alias="outputKey")
    mime_type: Annotated[str, StringConstraints(min_length=1, max_length=127, pattern=r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}$")] | None = Field(default=None, alias="mimeType")
    bytes: int | None = Field(default=None, ge=0, le=MAX_WIRE_RESPONSE_BYTES)
    sha256: Sha256 | None = None
    status: Literal["available", "transferred", "partial", "blocked"]
    blocker_code: Code | None = Field(default=None, alias="blockerCode")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("outputKey", "mimeType", "bytes", "sha256", "blockerCode"))

    @model_validator(mode="after")
    def validate_transfer_state(self) -> "OperationWireArtifact":
        if self.status == "transferred" and (self.output_key is None or self.bytes is None or self.sha256 is None):
            raise ValueError("transferred artifact requires outputKey, bytes, and sha256")
        if self.status in {"partial", "blocked"} and self.blocker_code is None:
            raise ValueError("partial or blocked artifact requires blockerCode")
        if self.status in {"available", "transferred"} and self.blocker_code is not None:
            raise ValueError("available or transferred artifact forbids blockerCode")
        return self


class OperationWireReceipt(StrictWireModel):
    """Durable receipt model used inside submit/collect/control envelopes."""

    schema_version: Literal["chatgpt.browser_control.operation_receipt.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    target_binding_digest: Digest = Field(alias="targetBindingDigest")
    user_turn_id: OpaqueId = Field(alias="userTurnId")
    user_turn_evidence_digest: Digest = Field(alias="userTurnEvidenceDigest")
    assistant_turn_id: OpaqueId = Field(alias="assistantTurnId")
    ownership_evidence_digest: Digest = Field(alias="ownershipEvidenceDigest")
    response_digest: Digest | None = Field(default=None, alias="responseDigest")
    response_bytes: int | None = Field(default=None, ge=0, le=MAX_WIRE_RESPONSE_BYTES, alias="responseBytes")
    response_format: OperationResponseFormat | None = Field(default=None, alias="responseFormat")
    finish_reason: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")] = Field(alias="finishReason")
    content_available: bool = Field(alias="contentAvailable")
    artifacts: list[OperationWireArtifact] = Field(max_length=MAX_WIRE_ARTIFACTS)
    completed_at: Instant = Field(alias="completedAt")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("responseDigest", "responseBytes", "responseFormat"))

    @model_validator(mode="after")
    def validate_receipt(self) -> "OperationWireReceipt":
        if (self.response_digest is None) != (self.response_bytes is None):
            raise ValueError("responseDigest and responseBytes must be paired")
        if self.content_available and (self.response_digest is None or self.response_bytes is None):
            raise ValueError("contentAvailable requires responseDigest and responseBytes")
        artifact_keys: set[str] = set()
        artifact_ordinals: set[int] = set()
        for artifact in self.artifacts:
            if artifact.operation_id != self.operation_id or artifact.assistant_turn_id != self.assistant_turn_id:
                raise ValueError("artifact identity must match receipt identity")
            if artifact.artifact_key in artifact_keys or artifact.ordinal in artifact_ordinals:
                raise ValueError("artifact keys and ordinals must be unique")
            artifact_keys.add(artifact.artifact_key)
            artifact_ordinals.add(artifact.ordinal)
        return self


_SAFE_BLOCKER_MESSAGE = r"^[A-Za-z0-9][A-Za-z0-9 .,:;_'()\-]{0,511}$"


class OperationWireBlocker(StrictWireModel):
    """Strict, redacted blocker nested in a result envelope."""

    schema_version: Literal["chatgpt.browser_control.operation_blocker.v1"] = Field(alias="schemaVersion")
    code: BlockerCode
    recoverable: bool
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    phase: OperationPhase
    mutation_boundary: MutationBoundary = Field(alias="mutationBoundary")
    message: Annotated[str, StringConstraints(min_length=1, max_length=MAX_WIRE_BLOCKER_MESSAGE_LENGTH, pattern=_SAFE_BLOCKER_MESSAGE)]


class OperationLiveResponseV1(StrictWireModel):
    """Raw response content that is explicitly ephemeral and non-durable."""

    schema_version: Literal["chatgpt.browser_control.operation_live_response.v1"] = Field(alias="schemaVersion")
    durability: Literal["ephemeral"]
    durable: Literal[False]
    content: Annotated[str, StringConstraints(max_length=MAX_WIRE_RESPONSE_CHARS)]
    response_format: OperationResponseFormat | None = Field(default=None, alias="responseFormat")
    bytes: int = Field(ge=0, le=MAX_WIRE_RESPONSE_BYTES)
    chars: int = Field(ge=0, le=MAX_WIRE_RESPONSE_CHARS)

    @model_validator(mode="before")
    @classmethod
    def reject_null_response_format(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("responseFormat",))

    @model_validator(mode="after")
    def validate_size_metadata(self) -> "OperationLiveResponseV1":
        try:
            encoded_bytes = len(self.content.encode("utf-8"))
        except UnicodeEncodeError as exc:
            raise ValueError("live response content must be valid UTF-8") from exc
        # JavaScript's canonical ``String.length`` counts UTF-16 code units,
        # not Unicode scalar values.  Mirror that wire meaning for astral
        # characters while keeping UTF-8 byte accounting unchanged.
        utf16_code_units = len(self.content.encode("utf-16-le")) // 2
        if encoded_bytes != self.bytes or utf16_code_units != self.chars:
            raise ValueError("live response content size metadata is invalid")
        return self


class OperationSubmitResult(StrictWireModel):
    """Exact ``operation_submit_result.v1`` envelope."""

    schema_version: Literal["chatgpt.browser_control.operation_submit_result.v1"] = Field(alias="schemaVersion")
    status: Literal["accepted", "completed", "blocked", "uncertain"]
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    handle: OperationWireHandle
    receipt: OperationWireReceipt | None = None
    blocker: OperationWireBlocker | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("receipt", "blocker"))

    @model_validator(mode="after")
    def validate_status_and_identity(self) -> "OperationSubmitResult":
        _validate_envelope_handle(self.operation_id, self.request_digest, self.handle)
        if self.status == "completed":
            if self.receipt is None or self.blocker is not None:
                raise ValueError("completed submit result requires receipt and forbids blocker")
            _validate_receipt_identity(self.receipt, self.operation_id, self.request_digest, self.handle.target_binding_digest)
        elif self.status in {"blocked", "uncertain"}:
            if self.blocker is None or self.receipt is not None:
                raise ValueError("blocked or uncertain submit result requires blocker and forbids receipt")
            _validate_blocker_identity(self.blocker, self.operation_id, self.request_digest)
            _validate_blocker_handle_coherence(self.blocker, self.handle)
        elif self.receipt is not None or self.blocker is not None:
            raise ValueError("accepted submit result cannot carry receipt or blocker")
        return self


class OperationCollectResult(StrictWireModel):
    """Exact ``operation_collect_result.v1`` envelope."""

    schema_version: Literal["chatgpt.browser_control.operation_collect_result.v1"] = Field(alias="schemaVersion")
    status: Literal["completed", "pending", "blocked", "uncertain"]
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    handle: OperationWireHandle
    receipt: OperationWireReceipt | None = None
    live_response: OperationLiveResponseV1 | None = Field(default=None, alias="liveResponse")
    blocker: OperationWireBlocker | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("receipt", "liveResponse", "blocker"))

    @model_validator(mode="after")
    def validate_status_and_identity(self) -> "OperationCollectResult":
        _validate_envelope_handle(self.operation_id, self.request_digest, self.handle)
        if self.status == "completed":
            if self.receipt is None or self.blocker is not None:
                raise ValueError("completed collect result requires receipt and forbids blocker")
            _validate_receipt_identity(self.receipt, self.operation_id, self.request_digest, self.handle.target_binding_digest)
            if self.live_response is not None:
                if (
                    not self.receipt.content_available
                    or self.receipt.response_bytes != self.live_response.bytes
                    or self.receipt.response_format != self.live_response.response_format
                ):
                    raise ValueError("liveResponse metadata must match the durable receipt")
        elif self.status == "pending":
            if self.receipt is not None or self.blocker is not None or self.live_response is not None:
                raise ValueError("pending collect result cannot carry receipt, blocker, or liveResponse")
        else:
            if self.blocker is None or self.receipt is not None or self.live_response is not None:
                raise ValueError("blocked or uncertain collect result requires blocker and forbids receipt/liveResponse")
            _validate_blocker_identity(self.blocker, self.operation_id, self.request_digest)
            _validate_blocker_handle_coherence(self.blocker, self.handle)
        return self


class OperationWireState(StrictWireModel):
    """Materialized redacted state accepted by the inspect result contract.

    This is intentionally separate from the durable ``OperationState`` model:
    the latter enforces runtime invariants such as requiring a materialized
    target whenever any target-bound action is present, while the public v1
    inspect fixture may legitimately expose a state before that target has
    been materialized. The wire model still validates every field, identity,
    timestamp, and action policy without accepting raw request content.
    """

    schema_version: Literal["chatgpt.browser_control.operation.v1"] = Field(alias="schemaVersion")
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    surface: OperationSurface
    phase: OperationPhase
    mutation_boundary: MutationBoundary = Field(alias="mutationBoundary")
    revision: int = Field(ge=1, le=MAX_SAFE_INTEGER)
    created_at: Instant = Field(alias="createdAt")
    updated_at: Instant = Field(alias="updatedAt")
    capture_policy: OperationDurableCapturePolicy | None = Field(default=None, alias="capturePolicy")
    response_format: OperationResponseFormat | None = Field(default=None, alias="responseFormat")
    target: OperationTarget | None = None
    actions: dict[Uuid, OperationActionRecord]
    ownership_baseline: OperationOwnershipBaseline | None = Field(default=None, alias="ownershipBaseline")
    ownership_baselines: dict[Uuid, OperationOwnershipBaseline] | None = Field(default=None, alias="ownershipBaselines")
    artifact_transfers: dict[Uuid, ArtifactTransferState] | None = Field(default=None, alias="artifactTransfers")
    submission_witnesses: dict[Uuid, OperationSubmissionWitness] | None = Field(default=None, alias="submissionWitnesses")
    submission_witness: OperationSubmissionWitness | None = Field(default=None, alias="submissionWitness")
    last_blocker: OperationBlockerObservation | None = Field(default=None, alias="lastBlocker")
    receipt: OperationWireReceipt | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        _reject_explicit_null_values(value)
        return _reject_explicit_nulls(value, ("capturePolicy", "responseFormat", "target", "ownershipBaseline", "ownershipBaselines", "artifactTransfers", "submissionWitnesses", "submissionWitness", "lastBlocker", "receipt"))

    @model_validator(mode="after")
    def validate_state(self) -> "OperationWireState":
        if self.updated_at < self.created_at:
            raise ValueError("updatedAt cannot precede createdAt")
        if self.capture_policy is not None and self.response_format is not None and self.capture_policy.response_format != self.response_format:
            raise ValueError("capturePolicy.responseFormat must match responseFormat")
        if (self.phase == "completed") != (self.receipt is not None):
            raise ValueError("only completed state may contain a terminal receipt")
        if self.ownership_baseline is not None:
            if self.ownership_baseline.operation_id != self.operation_id or self.ownership_baseline.request_digest != self.request_digest:
                raise ValueError("ownershipBaseline identity does not match inspect state")
            action = self.actions.get(self.ownership_baseline.action_id)
            if action is None or action.kind not in {"send", "work_steer"}:
                raise ValueError("ownershipBaseline must name its durable causal action")
            if action.target_digest != self.ownership_baseline.target_binding_digest:
                raise ValueError("ownershipBaseline target does not match its causal action")
        if self.ownership_baselines is not None:
            if len(self.ownership_baselines) > MAX_SUBMISSION_WITNESSES:
                raise ValueError(f"ownershipBaselines is capped at {MAX_SUBMISSION_WITNESSES} entries")
            for action_id, baseline in self.ownership_baselines.items():
                if action_id != baseline.action_id:
                    raise ValueError("ownershipBaselines map key must match actionId")
                if baseline.operation_id != self.operation_id or baseline.request_digest != self.request_digest:
                    raise ValueError("ownershipBaseline identity does not match inspect state")
                action = self.actions.get(action_id)
                if action is None or action.kind not in {"send", "work_steer"}:
                    raise ValueError("ownershipBaseline must name its durable causal action")
                if action.target_digest != baseline.target_binding_digest:
                    raise ValueError("ownershipBaseline target does not match its causal action")
                if action.kind == "send" and (
                    self.ownership_baseline is None or self.ownership_baseline != baseline
                ):
                    raise ValueError("Send ownershipBaseline must match the compatibility projection")
            if self.ownership_baseline is not None:
                projected = self.ownership_baselines.get(self.ownership_baseline.action_id)
                if projected is not None and projected != self.ownership_baseline:
                    raise ValueError("ownershipBaseline projection conflicts with ownershipBaselines")

        if self.submission_witnesses is not None:
            if len(self.submission_witnesses) > MAX_SUBMISSION_WITNESSES:
                raise ValueError(f"submissionWitnesses is capped at {MAX_SUBMISSION_WITNESSES} entries")
            send_witnesses: list[OperationSubmissionWitness] = []
            for action_id, witness in self.submission_witnesses.items():
                if action_id != witness.action_id:
                    raise ValueError("submissionWitnesses map key must match actionId")
                if self.ownership_baselines is None or action_id not in self.ownership_baselines:
                    raise ValueError("submissionWitness requires the ownership baseline for its causal action")
                baseline = self.ownership_baselines[action_id]
                if (
                    baseline.target_binding_digest != witness.target_binding_digest
                    or baseline.baseline.snapshot_digest != witness.baseline_snapshot_digest
                ):
                    raise ValueError("submissionWitness does not match ownershipBaseline")
                action = self.actions.get(action_id)
                if action is None or action.kind != witness.action_kind:
                    raise ValueError("submissionWitness must name its durable causal action")
                if action.target_digest != witness.target_binding_digest:
                    raise ValueError("submissionWitness target does not match its causal action")
                if action.outcome in {"not_satisfied", "uncertain"}:
                    raise ValueError("submissionWitness cannot follow an unsatisfied or uncertain action")
                if witness.observed_at < action.intent_at:
                    raise ValueError("submissionWitness cannot precede its causal action")
                if self.target is None:
                    raise ValueError("submissionWitness requires a durable target")
                if (self.target.target_lifecycle or "fixed") == "new_pending":
                    raise ValueError("pending new targets cannot contain submissionWitness")
                if witness.action_kind == "send":
                    send_witnesses.append(witness)
            if len(send_witnesses) > 1:
                raise ValueError("an operation may contain only one original Send submission witness")
            if send_witnesses and (
                self.submission_witness is None or self.submission_witness != send_witnesses[0]
            ):
                raise ValueError("the original Send submission witness must match its keyed projection exactly")

        if self.submission_witness is not None:
            if self.submission_witness.action_kind != "send":
                raise ValueError("the legacy submissionWitness field must project the original Send witness")
            baseline = (
                self.ownership_baselines.get(self.submission_witness.action_id)
                if self.ownership_baselines is not None
                else self.ownership_baseline
            )
            if baseline is None:
                raise ValueError("submissionWitness requires ownershipBaseline")
            if (
                baseline.action_id != self.submission_witness.action_id
                or baseline.target_binding_digest != self.submission_witness.target_binding_digest
                or baseline.baseline.snapshot_digest != self.submission_witness.baseline_snapshot_digest
            ):
                raise ValueError("submissionWitness does not match ownershipBaseline")
            action = self.actions.get(self.submission_witness.action_id)
            if action is None or action.kind != self.submission_witness.action_kind:
                raise ValueError("submissionWitness must name its durable causal action")
            if action.target_digest != self.submission_witness.target_binding_digest:
                raise ValueError("submissionWitness target does not match its causal action")
            if action.outcome in {"not_satisfied", "uncertain"}:
                raise ValueError("submissionWitness cannot follow an unsatisfied or uncertain action")
            if self.submission_witness.observed_at < action.intent_at:
                raise ValueError("submissionWitness cannot precede its causal action")
            if self.target is None:
                raise ValueError("submissionWitness requires a durable target")
            if (self.target.target_lifecycle or "fixed") == "new_pending":
                raise ValueError("pending new targets cannot contain submissionWitness")
            if self.submission_witnesses is not None:
                projected = self.submission_witnesses.get(self.submission_witness.action_id)
                if projected is None or projected != self.submission_witness:
                    raise ValueError("the original Send submission witness must match its keyed projection exactly")
        revisions: set[int] = set()
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
            # Control actions have an action-specific request digest. All
            # other actions remain bound to the parent operation request.
            if action.kind not in {"stop", "work_steer"} and action.request_digest != self.request_digest:
                raise ValueError("action request identity does not match the operation")
        if self.phase in {"submitted", "generating", "capturing", "completed"}:
            send_actions = [action for action in self.actions.values() if action.kind == "send"]
            if len(send_actions) != 1:
                raise ValueError("state phase requires exactly one durable original Send intent")
            send_action = send_actions[0]
            if send_action.outcome != "satisfied":
                raise ValueError("state phase requires a satisfied original Send action")
            baseline = (
                self.ownership_baselines.get(send_action.action_id)
                if self.ownership_baselines is not None
                else None
            )
            if baseline is None:
                raise ValueError("state phase requires the keyed pre-Send ownership baseline")
            witness = (
                self.submission_witnesses.get(send_action.action_id)
                if self.submission_witnesses is not None
                else None
            )
            if witness is None:
                raise ValueError("state phase requires the keyed original Send submission witness")
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
                raise ValueError("state phase original Send ownership proof is inconsistent")
            if self.ownership_baseline != baseline or self.submission_witness != witness:
                raise ValueError("state phase original Send ownership projections are inconsistent")
        if self.receipt is not None:
            _validate_existing_receipt(self.receipt, self.operation_id, self.request_digest)
            if (
                self.capture_policy is not None
                and self.receipt.response_format != self.capture_policy.response_format
            ):
                raise ValueError("receipt responseFormat must match capturePolicy.responseFormat")
        # Reuse the authoritative durable-state validator for the complete
        # state graph (including artifact-transfer/action coupling).  The wire
        # model above adds result-envelope limits and safe blocker text; this
        # final pass prevents its duplicated projection from silently drifting
        # behind newly added durable fields or cross-field invariants.
        OperationState.from_wire(self.to_wire())
        return self


class OperationInspectResult(StrictWireModel):
    """Exact ``operation_inspect_result.v1`` envelope."""

    schema_version: Literal["chatgpt.browser_control.operation_inspect_result.v1"] = Field(alias="schemaVersion")
    status: Literal["completed", "pending", "uncertain"]
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    handle: OperationWireHandle
    state: OperationWireState
    compatibility: BackendCompatibilityReport | None = None

    @model_validator(mode="after")
    def validate_status_and_identity(self) -> "OperationInspectResult":
        _validate_envelope_handle(self.operation_id, self.request_digest, self.handle)
        if self.state.operation_id != self.operation_id or self.state.request_digest != self.request_digest:
            raise ValueError("inspect state identity does not match the result")
        expected_status = "completed" if self.state.phase == "completed" else "uncertain" if self.state.phase == "uncertain" else "pending"
        if self.status != expected_status:
            raise ValueError("inspect status does not match the durable state phase")
        if (
            self.state.surface != self.handle.surface
            or self.state.revision != self.handle.revision
            or self.state.phase != self.handle.phase
            or self.state.mutation_boundary != self.handle.mutation_boundary
            or ((self.state.target is None) != (self.handle.target_binding_digest is None))
        ):
            raise ValueError("inspect state does not match the fresh handle")
        _validate_state_actions(self.state, self.operation_id, self.request_digest)
        return self


class OperationWireControlReceipt(StrictWireModel):
    """Strict control receipt nested in a control result envelope."""

    schema_version: Literal["chatgpt.browser_control.operation_control_receipt.v1"] = Field(alias="schemaVersion")
    control_action_id: Uuid = Field(alias="controlActionId")
    parent_operation_id: Uuid = Field(alias="parentOperationId")
    parent_request_digest: Digest = Field(alias="parentRequestDigest")
    parent_target_binding_digest: Digest = Field(alias="parentTargetBindingDigest")
    expected_assistant_turn_id: OpaqueId = Field(alias="expectedAssistantTurnId")
    request_digest: Digest = Field(alias="requestDigest")
    action: Literal["stop", "steer"]
    outcome: Literal["satisfied", "not_satisfied", "uncertain"]
    evidence_digest: Digest | None = Field(default=None, alias="evidenceDigest")
    blocker_code: Code | None = Field(default=None, alias="blockerCode")
    observed_at: Instant = Field(alias="observedAt")

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("evidenceDigest", "blockerCode"))

    @model_validator(mode="after")
    def validate_outcome(self) -> "OperationWireControlReceipt":
        if self.outcome == "satisfied" and self.evidence_digest is None:
            raise ValueError("satisfied control receipt requires evidenceDigest")
        if self.outcome == "satisfied" and self.blocker_code is not None:
            raise ValueError("satisfied control receipt forbids blockerCode")
        if self.outcome in {"not_satisfied", "uncertain"} and self.blocker_code is None:
            raise ValueError("non-satisfied control receipt requires blockerCode")
        return self


class OperationControlResult(StrictWireModel):
    """Exact ``operation_control_result.v1`` envelope.

    ``handle`` is the freshly reloaded *parent* handle. The root
    ``requestDigest`` belongs to the control action, so it is intentionally
    allowed to differ from ``parentRequestDigest``. The nested blocker uses
    the parent request identity, matching the TypeScript wire contract.
    """

    schema_version: Literal["chatgpt.browser_control.operation_control_result.v1"] = Field(alias="schemaVersion")
    status: Literal["completed", "blocked", "uncertain"]
    operation_id: Uuid = Field(alias="operationId")
    request_digest: Digest = Field(alias="requestDigest")
    handle: OperationWireHandle
    parent_request_digest: Digest = Field(alias="parentRequestDigest")
    parent_target_binding_digest: Digest = Field(alias="parentTargetBindingDigest")
    control_action_id: Uuid = Field(alias="controlActionId")
    action: Literal["stop", "steer"]
    expected_assistant_turn_id: OpaqueId = Field(alias="expectedAssistantTurnId")
    receipt: OperationWireControlReceipt | None = None
    blocker: OperationWireBlocker | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, ("receipt", "blocker"))

    @model_validator(mode="after")
    def validate_status_and_identity(self) -> "OperationControlResult":
        if self.operation_id != self.handle.operation_id:
            raise ValueError("control result operation identity does not match the fresh handle")
        if self.handle.request_digest != self.parent_request_digest:
            raise ValueError("control handle does not match parent request identity")
        if self.handle.target_binding_digest != self.parent_target_binding_digest:
            raise ValueError("control handle does not match parent target identity")
        if self.status == "completed":
            if self.receipt is None or self.blocker is not None:
                raise ValueError("completed control result requires receipt and forbids blocker")
            _validate_control_receipt_identity(self.receipt, self)
            if self.receipt.outcome != "satisfied":
                raise ValueError("completed control result requires a satisfied receipt")
        else:
            if self.blocker is None:
                raise ValueError("blocked or uncertain control result requires blocker")
            _validate_blocker_identity(self.blocker, self.operation_id, self.parent_request_digest)
            _validate_blocker_handle_coherence(self.blocker, self.handle)
            if self.receipt is not None:
                _validate_control_receipt_identity(self.receipt, self)
                expected_outcome = "not_satisfied" if self.status == "blocked" else "uncertain"
                if self.receipt.outcome != expected_outcome:
                    raise ValueError("control receipt outcome does not match result status")
        return self


def _decode_model(model: type[_ModelT], value: Any, *, command: str) -> _ModelT:
    """Decode a result without echoing untrusted/private field names."""

    if isinstance(value, model):
        return value
    if not isinstance(value, dict):
        raise ValueError(f"{command} backend result must be a JSON object.")
    try:
        return model.from_wire(value)
    except (TypeError, ValueError, ValidationError) as exc:
        # Do not include Pydantic's field path or backend-provided values in a
        # public diagnostic. In particular, a malformed response must not
        # echo prompt, file, URL, account, or provider-private field names.
        raise ValueError(f"{command} returned an invalid versioned operation result.") from exc


def decode_submit_result(value: Any) -> OperationSubmitResult:
    return _decode_model(OperationSubmitResult, value, command=SUBMIT_COMMAND)


def decode_collect_result(value: Any) -> OperationCollectResult:
    return _decode_model(OperationCollectResult, value, command=COLLECT_COMMAND)


def decode_inspect_result(value: Any) -> OperationInspectResult:
    return _decode_model(OperationInspectResult, value, command=INSPECT_COMMAND)


def _append_compatibility(result: OperationInspectResult, backend: Any) -> OperationInspectResult:
    """Attach the transport snapshot without changing the backend wire request."""

    getter = getattr(backend, "compatibility_report", None)
    if not callable(getter):
        return result
    report = getter()
    if not isinstance(report, dict):
        return result
    try:
        parsed = BackendCompatibilityReport.from_wire(report)
    except (TypeError, ValueError):
        return result
    wire = result.to_wire()
    wire["compatibility"] = parsed.to_wire()
    return decode_inspect_result(wire)


def decode_control_result(value: Any) -> OperationControlResult:
    return _decode_model(OperationControlResult, value, command=CONTROL_COMMAND)


def _validate_envelope_handle(operation_id: str, request_digest: str, handle: OperationWireHandle) -> None:
    if handle.operation_id != operation_id or handle.request_digest != request_digest:
        raise ValueError("operation result handle identity does not match the envelope")


def _validate_receipt_identity(
    receipt: OperationWireReceipt,
    operation_id: str,
    request_digest: str,
    target_binding_digest: str | None,
) -> None:
    if receipt.operation_id != operation_id or receipt.request_digest != request_digest:
        raise ValueError("operation result receipt identity does not match the envelope")
    if target_binding_digest is None or receipt.target_binding_digest != target_binding_digest:
        raise ValueError("operation result receipt target identity does not match the fresh handle")


def _validate_blocker_identity(blocker: OperationWireBlocker, operation_id: str, request_digest: str) -> None:
    if blocker.operation_id != operation_id or blocker.request_digest != request_digest:
        raise ValueError("operation result blocker identity does not match the envelope")


def _validate_blocker_handle_coherence(blocker: OperationWireBlocker, handle: OperationWireHandle) -> None:
    """A blocker must describe the same fresh phase/boundary as its handle."""

    if blocker.phase != handle.phase or blocker.mutation_boundary != handle.mutation_boundary:
        raise ValueError("operation result blocker does not match the fresh handle")


def _validate_existing_receipt(receipt: OperationWireReceipt | OperationReceipt, operation_id: str, request_digest: str) -> None:
    if receipt.operation_id != operation_id or receipt.request_digest != request_digest:
        raise ValueError("inspect receipt identity does not match the operation")
    if receipt.response_bytes is not None and receipt.response_bytes > MAX_WIRE_RESPONSE_BYTES:
        raise ValueError("inspect receipt response exceeds the bounded wire limit")
    if len(receipt.artifacts) > MAX_WIRE_ARTIFACTS:
        raise ValueError("inspect receipt artifacts exceed the bounded wire limit")
    keys: set[str] = set()
    ordinals: set[int] = set()
    for artifact in receipt.artifacts:
        if artifact.operation_id != operation_id or artifact.assistant_turn_id != receipt.assistant_turn_id:
            raise ValueError("inspect artifact identity does not match the receipt")
        if artifact.ordinal >= MAX_WIRE_ARTIFACTS or artifact.ordinal in ordinals or artifact.artifact_key in keys:
            raise ValueError("inspect artifact identity is invalid")
        if artifact.bytes is not None and artifact.bytes > MAX_WIRE_RESPONSE_BYTES:
            raise ValueError("inspect artifact exceeds the bounded wire limit")
        ordinals.add(artifact.ordinal)
        keys.add(artifact.artifact_key)


def _validate_state_actions(state: OperationWireState, operation_id: str, request_digest: str) -> None:
    """Apply wire-level action identity rules not present in durable models."""

    for action in state.actions.values():
        if action.kind not in {"stop", "work_steer"} and action.request_digest != request_digest:
            raise ValueError("inspect action request identity does not match the operation")
        # Control action request digests are action-specific. They may differ
        # from the parent operation digest, but remain canonical through the
        # OperationActionRecord Digest type.
        if action.kind in {"stop", "work_steer"} and not action.request_digest:
            raise ValueError("inspect control action request identity is missing")
    if state.receipt is not None:
        _validate_existing_receipt(state.receipt, operation_id, request_digest)


def _validate_control_receipt_identity(receipt: OperationWireControlReceipt, result: OperationControlResult) -> None:
    if (
        receipt.control_action_id != result.control_action_id
        or receipt.parent_operation_id != result.operation_id
        or receipt.parent_request_digest != result.parent_request_digest
        or receipt.parent_target_binding_digest != result.parent_target_binding_digest
        or receipt.request_digest != result.request_digest
        or receipt.action != result.action
        or receipt.expected_assistant_turn_id != result.expected_assistant_turn_id
    ):
        raise ValueError("control receipt identity does not match the result")


class OperationsClient:
    """Synchronous transactional-operation facade."""

    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def _request(self, command: str, payload: dict[str, Any]) -> Any:
        request = getattr(self._backend, "request", None)
        if not callable(request):
            raise RuntimeError(f"This ChatGPT backend does not support {command}.")
        return request(command, payload)

    def submit(
        self,
        request: OperationSubmitRequest | Mapping[str, Any] | None = None,
        *,
        operation_id: str | None = None,
        surface: Literal["chat", "work"] | None = None,
        prompt: str | None = None,
        target: Mapping[str, Any] | Any | None = None,
        thread: Mapping[str, Any] | Any | None = None,
        configuration: Mapping[str, Any] | Any | None = None,
        files: list[Mapping[str, Any]] | Any | None = None,
        capture: Mapping[str, Any] | Any | None = None,
        timeout_ms: int | None = None,
    ) -> OperationSubmitResult:
        if target is not None and thread is not None:
            raise TypeError("Pass either target or thread, not both.")
        parsed = _build_request(
            OperationSubmitRequest,
            request,
            {
                "operationId": operation_id,
                "surface": surface,
                "prompt": prompt,
                "target": target if target is not None else thread,
                "configuration": configuration,
                "files": files,
                "capture": capture,
                "timeoutMs": timeout_ms,
            },
            schema_version="chatgpt.browser_control.operation_request.v1",
            required=("operationId", "surface", "prompt", "target"),
        )
        result = decode_submit_result(self._request(SUBMIT_COMMAND, parsed.to_wire()))
        if result.operation_id != parsed.operation_id:
            raise ValueError("operations.submit returned a result for a different operationId.")
        return result

    def collect(
        self,
        request: OperationCollectRequest | Mapping[str, Any] | None = None,
        *,
        handle: OperationHandle | OperationWireHandle | Mapping[str, Any] | None = None,
        wait: bool | None = None,
        timeout_ms: int | None = None,
        response_content: Literal["include", "metadata"] | None = None,
        poll_interval_ms: int | None = None,
    ) -> OperationCollectResult:
        parsed = _build_request(
            OperationCollectRequest,
            request,
            {
                "handle": handle,
                "wait": wait,
                "timeoutMs": timeout_ms,
                "pollIntervalMs": poll_interval_ms,
                "responseContent": response_content,
            },
            schema_version=COLLECT_SCHEMA,
            required=("handle",),
        )
        result = decode_collect_result(self._request(COLLECT_COMMAND, parsed.to_wire()))
        _assert_fresh_handle(result.handle, parsed.handle, command=COLLECT_COMMAND)
        return result

    def inspect(
        self,
        request: OperationInspectRequest | Mapping[str, Any] | None = None,
        *,
        handle: OperationHandle | OperationWireHandle | Mapping[str, Any] | None = None,
    ) -> OperationInspectResult:
        parsed = _build_request(
            OperationInspectRequest,
            request,
            {"handle": handle},
            schema_version=INSPECT_SCHEMA,
            required=("handle",),
        )
        result = _append_compatibility(
            decode_inspect_result(self._request(INSPECT_COMMAND, parsed.to_wire())),
            self._backend,
        )
        _assert_fresh_handle(result.handle, parsed.handle, command=INSPECT_COMMAND)
        return result

    def control(
        self,
        request: OperationControlRequest | Mapping[str, Any] | None = None,
        *,
        control_action_id: str | None = None,
        parent: OperationHandle | OperationWireHandle | Mapping[str, Any] | None = None,
        action: Literal["stop", "steer"] | None = None,
        expected_assistant_turn_id: str | None = None,
        steer_prompt: str | None = None,
        timeout_ms: int | None = None,
    ) -> OperationControlResult:
        parsed = _build_request(
            OperationControlRequest,
            request,
            {
                "controlActionId": control_action_id,
                "parent": parent,
                "action": action,
                "expectedAssistantTurnId": expected_assistant_turn_id,
                "steerPrompt": steer_prompt,
                "timeoutMs": timeout_ms,
            },
            schema_version=CONTROL_REQUEST_SCHEMA,
            required=("controlActionId", "parent", "action", "expectedAssistantTurnId"),
        )
        result = decode_control_result(self._request(CONTROL_COMMAND, parsed.to_wire()))
        _assert_control_identity(result, parsed)
        return result

    def run(
        self,
        request: OperationSubmitRequest | Mapping[str, Any] | None = None,
        *,
        operation_id: str | None = None,
        surface: Literal["chat", "work"] | None = None,
        prompt: str | None = None,
        target: Mapping[str, Any] | Any | None = None,
        thread: Mapping[str, Any] | Any | None = None,
        configuration: Mapping[str, Any] | Any | None = None,
        files: list[Mapping[str, Any]] | Any | None = None,
        capture: Mapping[str, Any] | Any | None = None,
        timeout_ms: int | None = None,
        wait: bool | None = True,
        response_content: Literal["include", "metadata"] | None = None,
        poll_interval_ms: int | None = None,
    ) -> OperationSubmitResult | OperationCollectResult:
        """Submit once and collect once only for an accepted submit envelope."""

        _validate_poll_interval_ms(poll_interval_ms)
        submitted = self.submit(
            request,
            operation_id=operation_id,
            surface=surface,
            prompt=prompt,
            target=target,
            thread=thread,
            configuration=configuration,
            files=files,
            capture=capture,
            timeout_ms=timeout_ms,
        )
        if submitted.status != "accepted":
            return submitted
        return self.collect(
            handle=submitted.handle,
            wait=wait,
            timeout_ms=timeout_ms,
            response_content=response_content,
            poll_interval_ms=poll_interval_ms,
        )


class AsyncOperationsClient:
    """Async counterpart using the existing negotiated async backend path."""

    def __init__(self, backend: Any) -> None:
        self._backend = backend

    async def _request(self, command: str, payload: dict[str, Any]) -> Any:
        from .async_client import async_request_backend

        return await async_request_backend(self._backend, command, payload)

    async def submit(
        self,
        request: OperationSubmitRequest | Mapping[str, Any] | None = None,
        *,
        operation_id: str | None = None,
        surface: Literal["chat", "work"] | None = None,
        prompt: str | None = None,
        target: Mapping[str, Any] | Any | None = None,
        thread: Mapping[str, Any] | Any | None = None,
        configuration: Mapping[str, Any] | Any | None = None,
        files: list[Mapping[str, Any]] | Any | None = None,
        capture: Mapping[str, Any] | Any | None = None,
        timeout_ms: int | None = None,
    ) -> OperationSubmitResult:
        if target is not None and thread is not None:
            raise TypeError("Pass either target or thread, not both.")
        parsed = _build_request(
            OperationSubmitRequest,
            request,
            {
                "operationId": operation_id,
                "surface": surface,
                "prompt": prompt,
                "target": target if target is not None else thread,
                "configuration": configuration,
                "files": files,
                "capture": capture,
                "timeoutMs": timeout_ms,
            },
            schema_version="chatgpt.browser_control.operation_request.v1",
            required=("operationId", "surface", "prompt", "target"),
        )
        result = decode_submit_result(await self._request(SUBMIT_COMMAND, parsed.to_wire()))
        if result.operation_id != parsed.operation_id:
            raise ValueError("operations.submit returned a result for a different operationId.")
        return result

    async def collect(
        self,
        request: OperationCollectRequest | Mapping[str, Any] | None = None,
        *,
        handle: OperationHandle | OperationWireHandle | Mapping[str, Any] | None = None,
        wait: bool | None = None,
        timeout_ms: int | None = None,
        response_content: Literal["include", "metadata"] | None = None,
        poll_interval_ms: int | None = None,
    ) -> OperationCollectResult:
        parsed = _build_request(
            OperationCollectRequest,
            request,
            {
                "handle": handle,
                "wait": wait,
                "timeoutMs": timeout_ms,
                "pollIntervalMs": poll_interval_ms,
                "responseContent": response_content,
            },
            schema_version=COLLECT_SCHEMA,
            required=("handle",),
        )
        result = decode_collect_result(await self._request(COLLECT_COMMAND, parsed.to_wire()))
        _assert_fresh_handle(result.handle, parsed.handle, command=COLLECT_COMMAND)
        return result

    async def inspect(
        self,
        request: OperationInspectRequest | Mapping[str, Any] | None = None,
        *,
        handle: OperationHandle | OperationWireHandle | Mapping[str, Any] | None = None,
    ) -> OperationInspectResult:
        parsed = _build_request(
            OperationInspectRequest,
            request,
            {"handle": handle},
            schema_version=INSPECT_SCHEMA,
            required=("handle",),
        )
        result = _append_compatibility(
            decode_inspect_result(await self._request(INSPECT_COMMAND, parsed.to_wire())),
            self._backend,
        )
        _assert_fresh_handle(result.handle, parsed.handle, command=INSPECT_COMMAND)
        return result

    async def control(
        self,
        request: OperationControlRequest | Mapping[str, Any] | None = None,
        *,
        control_action_id: str | None = None,
        parent: OperationHandle | OperationWireHandle | Mapping[str, Any] | None = None,
        action: Literal["stop", "steer"] | None = None,
        expected_assistant_turn_id: str | None = None,
        steer_prompt: str | None = None,
        timeout_ms: int | None = None,
    ) -> OperationControlResult:
        parsed = _build_request(
            OperationControlRequest,
            request,
            {
                "controlActionId": control_action_id,
                "parent": parent,
                "action": action,
                "expectedAssistantTurnId": expected_assistant_turn_id,
                "steerPrompt": steer_prompt,
                "timeoutMs": timeout_ms,
            },
            schema_version=CONTROL_REQUEST_SCHEMA,
            required=("controlActionId", "parent", "action", "expectedAssistantTurnId"),
        )
        result = decode_control_result(await self._request(CONTROL_COMMAND, parsed.to_wire()))
        _assert_control_identity(result, parsed)
        return result

    async def run(
        self,
        request: OperationSubmitRequest | Mapping[str, Any] | None = None,
        *,
        operation_id: str | None = None,
        surface: Literal["chat", "work"] | None = None,
        prompt: str | None = None,
        target: Mapping[str, Any] | Any | None = None,
        thread: Mapping[str, Any] | Any | None = None,
        configuration: Mapping[str, Any] | Any | None = None,
        files: list[Mapping[str, Any]] | Any | None = None,
        capture: Mapping[str, Any] | Any | None = None,
        timeout_ms: int | None = None,
        wait: bool | None = True,
        response_content: Literal["include", "metadata"] | None = None,
        poll_interval_ms: int | None = None,
    ) -> OperationSubmitResult | OperationCollectResult:
        _validate_poll_interval_ms(poll_interval_ms)
        submitted = await self.submit(
            request,
            operation_id=operation_id,
            surface=surface,
            prompt=prompt,
            target=target,
            thread=thread,
            configuration=configuration,
            files=files,
            capture=capture,
            timeout_ms=timeout_ms,
        )
        if submitted.status != "accepted":
            return submitted
        return await self.collect(
            handle=submitted.handle,
            wait=wait,
            timeout_ms=timeout_ms,
            response_content=response_content,
            poll_interval_ms=poll_interval_ms,
        )


def _assert_fresh_handle(result_handle: OperationWireHandle, expected: OperationHandle, *, command: str) -> None:
    if result_handle.operation_id != expected.operation_id:
        raise ValueError(f"{command} returned a result for a different operationId.")
    if result_handle.request_digest != expected.request_digest:
        raise ValueError(f"{command} returned a result for a different requestDigest.")
    if result_handle.target_binding_digest != expected.target_binding_digest:
        raise ValueError(f"{command} returned a result for a different targetBindingDigest.")
    if result_handle.surface != expected.surface:
        raise ValueError(f"{command} returned a result for a different operation surface.")
    if result_handle.revision < expected.revision:
        raise ValueError(f"{command} returned a stale operation revision.")
    if result_handle.revision == expected.revision and (
        result_handle.phase != expected.phase
        or result_handle.mutation_boundary != expected.mutation_boundary
    ):
        raise ValueError(f"{command} returned conflicting state at the expected operation revision.")
    if _BOUNDARY_RANK[result_handle.mutation_boundary] < _BOUNDARY_RANK[expected.mutation_boundary]:
        raise ValueError(f"{command} returned a regressed mutation boundary.")


def _assert_control_identity(result: OperationControlResult, request: OperationControlRequest) -> None:
    if result.operation_id != request.parent.operation_id:
        raise ValueError("operations.control returned a result for a different parent operationId.")
    if result.parent_request_digest != request.parent.request_digest:
        raise ValueError("operations.control returned a result for a different parent requestDigest.")
    if result.parent_target_binding_digest != request.parent.target_binding_digest:
        raise ValueError("operations.control returned a result for a different parent targetBindingDigest.")
    if result.handle.operation_id != request.parent.operation_id or result.handle.request_digest != request.parent.request_digest:
        raise ValueError("operations.control returned a stale parent handle.")
    if result.handle.target_binding_digest != request.parent.target_binding_digest:
        raise ValueError("operations.control returned a parent handle for a different target.")
    if result.handle.surface != request.parent.surface:
        raise ValueError("operations.control returned a parent handle for a different operation surface.")
    if result.handle.revision < request.parent.revision:
        raise ValueError("operations.control returned a stale parent revision.")
    if result.handle.revision == request.parent.revision and (
        result.handle.phase != request.parent.phase
        or result.handle.mutation_boundary != request.parent.mutation_boundary
    ):
        raise ValueError("operations.control returned conflicting state at the expected parent revision.")
    if _BOUNDARY_RANK[result.handle.mutation_boundary] < _BOUNDARY_RANK[request.parent.mutation_boundary]:
        raise ValueError("operations.control returned a regressed parent mutation boundary.")
    if result.control_action_id != request.control_action_id:
        raise ValueError("operations.control returned a result for a different controlActionId.")
    if result.action != request.action or result.expected_assistant_turn_id != request.expected_assistant_turn_id:
        raise ValueError("operations.control returned a result for a different control request.")


# Compatibility names retained so existing package-level imports continue to
# resolve while callers migrate to the exact envelope classes. These aliases
# intentionally do not reintroduce the former ad-hoc direct result shapes.
OperationActionBlocker = OperationWireBlocker
OperationSubmissionSubmitted = OperationSubmitResult
OperationSubmissionBlocked = OperationSubmitResult
OperationSubmissionResult = OperationSubmitResult
OperationCollectCompleted = OperationCollectResult
OperationCollectPending = OperationCollectResult
OperationCollectorArtifact = OperationWireArtifact
OperationCollectorBlocker = OperationWireBlocker
OperationCollectorResponse = OperationWireReceipt
OperationCollectorTextDigest = OperationWireReceipt
OperationCollectorTurn = OperationWireReceipt
OperationCollectorResult = OperationCollectResult


__all__ = [
    "AsyncOperationsClient",
    "COLLECT_COMMAND",
    "COLLECT_RESULT_SCHEMA",
    "CONTROL_COMMAND",
    "CONTROL_RESULT_SCHEMA",
    "INSPECT_COMMAND",
    "INSPECT_RESULT_SCHEMA",
    "LIVE_RESPONSE_SCHEMA",
    "OperationActionBlocker",
    "OperationCollectCompleted",
    "OperationCollectPending",
    "OperationCollectResult",
    "OperationCollectorArtifact",
    "OperationCollectorBlocker",
    "OperationCollectorResponse",
    "OperationCollectorResult",
    "OperationCollectorTextDigest",
    "OperationCollectorTurn",
    "OperationControlResult",
    "OperationControlReceipt",
    "OperationLiveResponseV1",
    "OperationSubmissionBlocked",
    "OperationSubmissionResult",
    "OperationSubmissionSubmitted",
    "OperationSubmitResult",
    "OperationInspectResult",
    "OperationWireArtifact",
    "OperationWireBlocker",
    "OperationWireControlReceipt",
    "OperationWireHandle",
    "OperationWireReceipt",
    "OperationsClient",
    "SUBMIT_COMMAND",
    "SUBMIT_RESULT_SCHEMA",
    "decode_collect_result",
    "decode_control_result",
    "decode_inspect_result",
    "decode_submit_result",
]
