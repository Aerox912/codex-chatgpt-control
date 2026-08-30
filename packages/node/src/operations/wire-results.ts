import type {
  CollectorResult,
  CollectorBlockerCode
} from "./collector.js";
import type {
  ControlResult,
  ControlBlocker
} from "./control.js";
import type {
  SubmissionResult,
  SubmissionBlockerCode
} from "./submission.js";
import type {
  OperationBlockerCode,
  OperationBlockerV1,
  OperationControlReceiptV1,
  OperationHandleV1,
  OperationResponseFormatV1,
  OperationReceiptV1,
  OperationStateV1
} from "./types.js";
import type { OperationInspectResult, OperationSubmitResult } from "./service.js";
import { assertDurableCapturePolicyShape, assertOperationStateShape } from "./state-machine.js";
import type { BackendCompatibilityReport } from "../backend/protocol.js";
import { validateBackendCompatibilityReport } from "../backend/compatibility.js";

/** Versioned result envelopes used at backend/SDK boundaries. */
export const OPERATION_SUBMIT_RESULT_SCHEMA_VERSION =
  "chatgpt.browser_control.operation_submit_result.v1" as const;
export const OPERATION_COLLECT_RESULT_SCHEMA_VERSION =
  "chatgpt.browser_control.operation_collect_result.v1" as const;
export const OPERATION_INSPECT_RESULT_SCHEMA_VERSION =
  "chatgpt.browser_control.operation_inspect_result.v1" as const;
export const OPERATION_CONTROL_RESULT_SCHEMA_VERSION =
  "chatgpt.browser_control.operation_control_result.v1" as const;
export const OPERATION_LIVE_RESPONSE_SCHEMA_VERSION =
  "chatgpt.browser_control.operation_live_response.v1" as const;

export const MAX_WIRE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_WIRE_RESPONSE_CHARS = 8 * 1024 * 1024;
export const MAX_WIRE_BLOCKER_MESSAGE_LENGTH = 512;
export const MAX_WIRE_ARTIFACTS = 32;

export type OperationWireStatus = "accepted" | "completed" | "pending" | "blocked" | "uncertain";

/**
 * Raw response content is deliberately a separate, explicitly ephemeral
 * value. It is never accepted by a receipt or durable state validator.
 */
export type OperationLiveResponseV1 = Readonly<{
  schemaVersion: typeof OPERATION_LIVE_RESPONSE_SCHEMA_VERSION;
  durability: "ephemeral";
  durable: false;
  content: string;
  responseFormat?: OperationResponseFormatV1;
  bytes: number;
  chars: number;
}>;

type OperationWireBase = Readonly<{
  operationId: string;
  requestDigest: string;
  handle: OperationHandleV1;
}>;

export type OperationSubmitWireResult =
  | (OperationWireBase & Readonly<{
      schemaVersion: typeof OPERATION_SUBMIT_RESULT_SCHEMA_VERSION;
      status: "accepted";
    }>)
  | (OperationWireBase & Readonly<{
      schemaVersion: typeof OPERATION_SUBMIT_RESULT_SCHEMA_VERSION;
      status: "completed";
      receipt: OperationReceiptV1;
    }>)
  | (OperationWireBase & Readonly<{
      schemaVersion: typeof OPERATION_SUBMIT_RESULT_SCHEMA_VERSION;
      status: "blocked" | "uncertain";
      blocker: OperationBlockerV1;
    }>);

export type OperationCollectWireResult =
  | (OperationWireBase & Readonly<{
      schemaVersion: typeof OPERATION_COLLECT_RESULT_SCHEMA_VERSION;
      status: "completed";
      receipt: OperationReceiptV1;
      liveResponse?: OperationLiveResponseV1;
    }>)
  | (OperationWireBase & Readonly<{
      schemaVersion: typeof OPERATION_COLLECT_RESULT_SCHEMA_VERSION;
      status: "pending";
    }>)
  | (OperationWireBase & Readonly<{
      schemaVersion: typeof OPERATION_COLLECT_RESULT_SCHEMA_VERSION;
      status: "blocked" | "uncertain";
      blocker: OperationBlockerV1;
    }>);

export type OperationInspectWireResult = OperationWireBase & Readonly<{
  schemaVersion: typeof OPERATION_INSPECT_RESULT_SCHEMA_VERSION;
  status: "completed" | "pending" | "uncertain";
  state: OperationStateV1;
  /** Additive transport provenance; absent for direct in-process backends. */
  compatibility?: BackendCompatibilityReport;
}>;

export type OperationControlWireResult = OperationWireBase & Readonly<{
  schemaVersion: typeof OPERATION_CONTROL_RESULT_SCHEMA_VERSION;
  status: "completed" | "blocked" | "uncertain";
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  controlActionId: string;
  action: "stop" | "steer";
  expectedAssistantTurnId: string;
  receipt?: OperationControlReceiptV1;
  blocker?: OperationBlockerV1;
}>;

export class OperationWireResultError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OperationWireResultError";
  }
}

/** Convert the internal submission result into a strict, versioned envelope. */
export function toOperationSubmitWireResult(
  result: OperationSubmitResult,
  receipt?: OperationReceiptV1
): OperationSubmitWireResult {
  assertSubmissionIdentity(result.submission, result.handle);
  const base = {
    operationId: result.handle.operationId,
    requestDigest: result.handle.requestDigest,
    handle: result.handle
  } satisfies OperationWireBase;

  switch (result.submission.kind) {
    case "submitted":
    case "already_submitted":
      return validateOperationSubmitWireResult({
        schemaVersion: OPERATION_SUBMIT_RESULT_SCHEMA_VERSION,
        status: "accepted",
        ...base
      });
    case "completed_receipt":
      if (receipt === undefined) {
        throw new OperationWireResultError("completed_receipt_missing", "A completed submit result requires its durable receipt.");
      }
      return validateOperationSubmitWireResult({
        schemaVersion: OPERATION_SUBMIT_RESULT_SCHEMA_VERSION,
        status: "completed",
        ...base,
        receipt
      });
    case "cancelled":
      return validateOperationSubmitWireResult({
        schemaVersion: OPERATION_SUBMIT_RESULT_SCHEMA_VERSION,
        status: result.submission.blocker.mutationBoundary === "none" ? "blocked" : "uncertain",
        ...base,
        blocker: blockerFromInternal(
          result.submission.blocker.code,
          result.handle,
          result.submission.blocker.mutationBoundary,
          result.submission.blocker.observationRequired,
          result.submission.blocker.evidenceDigest
        )
      });
    case "blocked":
    case "uncertain":
      return validateOperationSubmitWireResult({
        schemaVersion: OPERATION_SUBMIT_RESULT_SCHEMA_VERSION,
        status: result.submission.kind,
        ...base,
        blocker: blockerFromInternal(
          result.submission.blocker.code,
          result.handle,
          result.submission.blocker.mutationBoundary,
          result.submission.blocker.observationRequired,
          result.submission.blocker.evidenceDigest
        )
      });
  }
}

/** Convert the collector result using the freshly reloaded handle and receipt. */
export function toOperationCollectWireResult(
  /** The handle freshly reloaded after the collector attempt (including pending). */
  handle: OperationHandleV1,
  result: CollectorResult,
  receipt?: OperationReceiptV1
): OperationCollectWireResult {
  assertCollectorIdentity(result, handle);
  const base = {
    operationId: handle.operationId,
    requestDigest: handle.requestDigest,
    handle
  } satisfies OperationWireBase;
  switch (result.kind) {
    case "completed": {
      if (receipt === undefined) {
        throw new OperationWireResultError("completed_receipt_missing", "A completed collect result requires its durable receipt.");
      }
      const liveResponse = result.response.rawText === undefined
        ? undefined
        : liveResponseFromText(result.response.rawText, result.response.responseFormat);
      return validateOperationCollectWireResult({
        schemaVersion: OPERATION_COLLECT_RESULT_SCHEMA_VERSION,
        status: "completed",
        ...base,
        receipt,
        ...(liveResponse === undefined ? {} : { liveResponse })
      });
    }
    case "pending":
      return validateOperationCollectWireResult({
        schemaVersion: OPERATION_COLLECT_RESULT_SCHEMA_VERSION,
        status: "pending",
        ...base
      });
    case "blocked":
      return validateOperationCollectWireResult({
        schemaVersion: OPERATION_COLLECT_RESULT_SCHEMA_VERSION,
        status: "blocked",
        ...base,
        blocker: blockerFromCollector(result.blocker, handle)
      });
  }
}

/** Inspect is a durable read, so its status is derived from the fresh state. */
export function toOperationInspectWireResult(result: OperationInspectResult): OperationInspectWireResult {
  const status: OperationInspectWireResult["status"] = result.state.phase === "completed"
    ? "completed"
    : result.state.phase === "uncertain"
      ? "uncertain"
      : "pending";
  return validateOperationInspectWireResult({
    schemaVersion: OPERATION_INSPECT_RESULT_SCHEMA_VERSION,
    status,
    operationId: result.handle.operationId,
    requestDigest: result.handle.requestDigest,
    handle: result.handle,
    state: result.state
  });
}

/** Convert a control result with the current parent handle reloaded by the service. */
export function toOperationControlWireResult(
  result: ControlResult,
  handle: OperationHandleV1
): OperationControlWireResult {
  const wire: OperationControlWireResult = {
    schemaVersion: OPERATION_CONTROL_RESULT_SCHEMA_VERSION,
    status: result.kind,
    operationId: result.parentOperationId,
    requestDigest: result.requestDigest,
    handle,
    parentRequestDigest: result.parentRequestDigest,
    parentTargetBindingDigest: result.parentTargetBindingDigest,
    controlActionId: result.controlActionId,
    action: result.action,
    expectedAssistantTurnId: result.expectedAssistantTurnId,
    ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    ...(result.kind === "completed" ? {} : {
      blocker: blockerFromInternal(
        result.blocker.code,
        handle,
        result.blocker.mutationBoundary,
        result.blocker.observationRequired,
        result.blocker.evidenceDigest,
        result.parentRequestDigest
      )
    })
  };
  return validateOperationControlWireResult(wire);
}

export function liveResponseFromText(content: string, responseFormat?: OperationResponseFormatV1): OperationLiveResponseV1 {
  if (typeof content !== "string") {
    throw new OperationWireResultError("invalid_live_response", "Live response content must be a string.");
  }
  assertUnicodeScalarString(content);
  const response = {
    schemaVersion: OPERATION_LIVE_RESPONSE_SCHEMA_VERSION,
    durability: "ephemeral" as const,
    durable: false as const,
    content,
    ...(responseFormat === undefined ? {} : { responseFormat }),
    bytes: Buffer.byteLength(content, "utf8"),
    chars: content.length
  } satisfies OperationLiveResponseV1;
  return validateLiveResponse(response);
}

export function validateOperationSubmitWireResult(value: unknown): OperationSubmitWireResult {
  const result = validateEnvelope(value, OPERATION_SUBMIT_RESULT_SCHEMA_VERSION);
  const status = result.status;
  if (!SUBMIT_STATUSES.has(status)) {
    throw new OperationWireResultError("invalid_submit_status", "Submit results must be accepted, completed, blocked, or uncertain.");
  }
  if (status === "completed") {
    assertExactKeys(result, ["schemaVersion", "status", "operationId", "requestDigest", "handle", "receipt"]);
    validateReceipt(result.receipt, result.operationId, result.requestDigest);
    if (result.receipt.targetBindingDigest !== result.handle.targetBindingDigest) throw new OperationWireResultError("receipt_target_mismatch", "Submit receipt target does not match the fresh handle.");
  } else if (status === "blocked" || status === "uncertain") {
    assertExactKeys(result, ["schemaVersion", "status", "operationId", "requestDigest", "handle", "blocker"]);
    validateBlocker(result.blocker, result.operationId, result.requestDigest);
    validateBlockerHandleCoherence(result.blocker, result.handle);
  } else {
    assertExactKeys(result, ["schemaVersion", "status", "operationId", "requestDigest", "handle"]);
  }
  return result as OperationSubmitWireResult;
}

export function validateOperationCollectWireResult(value: unknown): OperationCollectWireResult {
  const result = validateEnvelope(value, OPERATION_COLLECT_RESULT_SCHEMA_VERSION);
  const status = result.status;
  if (!COLLECT_STATUSES.has(status)) {
    throw new OperationWireResultError("invalid_collect_status", "Collect results must be completed, pending, blocked, or uncertain.");
  }
  if (status === "completed") {
    assertExactKeys(result, ["schemaVersion", "status", "operationId", "requestDigest", "handle", "receipt", "liveResponse"]);
    validateReceipt(result.receipt, result.operationId, result.requestDigest);
    if (result.receipt.targetBindingDigest !== result.handle.targetBindingDigest) throw new OperationWireResultError("receipt_target_mismatch", "Collect receipt target does not match the fresh handle.");
    if (result.liveResponse !== undefined) {
      validateLiveResponse(result.liveResponse);
      validateLiveResponseReceiptCoherence(result.liveResponse, result.receipt);
    }
  } else if (status === "blocked" || status === "uncertain") {
    assertExactKeys(result, ["schemaVersion", "status", "operationId", "requestDigest", "handle", "blocker"]);
    validateBlocker(result.blocker, result.operationId, result.requestDigest);
    validateBlockerHandleCoherence(result.blocker, result.handle);
  } else {
    assertExactKeys(result, ["schemaVersion", "status", "operationId", "requestDigest", "handle"]);
  }
  return result as OperationCollectWireResult;
}

export function validateOperationInspectWireResult(value: unknown): OperationInspectWireResult {
  const result = validateEnvelope(value, OPERATION_INSPECT_RESULT_SCHEMA_VERSION);
  if (result.status !== "completed" && result.status !== "pending" && result.status !== "uncertain") {
    throw new OperationWireResultError("invalid_inspect_status", "Inspect results must be completed, pending, or uncertain.");
  }
  assertExactKeys(result, ["schemaVersion", "status", "operationId", "requestDigest", "handle", "state", "compatibility"]);
  validateState(result.state, result.operationId, result.requestDigest);
  if (result.compatibility !== undefined) validateCompatibility(result.compatibility);
  const expectedStatus = result.state.phase === "completed"
    ? "completed"
    : result.state.phase === "uncertain"
      ? "uncertain"
      : "pending";
  if (result.status !== expectedStatus) {
    throw new OperationWireResultError("inspect_status_mismatch", "Inspect status does not match the durable state phase.");
  }
  if (
    result.handle.surface !== result.state.surface
    || result.handle.revision !== result.state.revision
    || result.handle.phase !== result.state.phase
    || result.handle.mutationBoundary !== result.state.mutationBoundary
    || (result.handle.targetBindingDigest === undefined) !== (result.state.target === undefined)
  ) {
    throw new OperationWireResultError("inspect_handle_mismatch", "Inspect handle does not match the durable state snapshot.");
  }
  return result as OperationInspectWireResult;
}

function validateCompatibility(value: unknown): asserts value is BackendCompatibilityReport {
  try {
    validateBackendCompatibilityReport(value);
  } catch {
    throw new OperationWireResultError("invalid_compatibility", "Inspect compatibility diagnostics are malformed.");
  }
}

export function validateOperationControlWireResult(value: unknown): OperationControlWireResult {
  const expectedParentDigest = isRecord(value) && typeof value.parentRequestDigest === "string"
    ? value.parentRequestDigest
    : undefined;
  const result = validateEnvelope(value, OPERATION_CONTROL_RESULT_SCHEMA_VERSION, expectedParentDigest);
  if (!CONTROL_STATUSES.has(result.status)) {
    throw new OperationWireResultError("invalid_control_status", "Control results must be completed, blocked, or uncertain.");
  }
  if (typeof result.parentRequestDigest !== "string" || !DIGEST_PATTERN.test(result.parentRequestDigest)) {
    throw new OperationWireResultError("invalid_parent_request_digest", "Control parentRequestDigest must be canonical.");
  }
  if (typeof result.parentTargetBindingDigest !== "string" || !DIGEST_PATTERN.test(result.parentTargetBindingDigest)) {
    throw new OperationWireResultError("invalid_parent_target_digest", "Control parentTargetBindingDigest must be canonical.");
  }
  if (typeof result.controlActionId !== "string" || !UUID_PATTERN.test(result.controlActionId)) {
    throw new OperationWireResultError("invalid_control_action_id", "Control action ID must be a UUID.");
  }
  if (result.action !== "stop" && result.action !== "steer") {
    throw new OperationWireResultError("invalid_control_action", "Control action must be stop or steer.");
  }
  assertOpaqueId(result.expectedAssistantTurnId, "expectedAssistantTurnId");
  const keys = [
    "schemaVersion", "status", "operationId", "requestDigest", "handle", "parentRequestDigest",
    "parentTargetBindingDigest", "controlActionId", "action", "expectedAssistantTurnId", "receipt", "blocker"
  ];
  assertExactKeys(result, keys);
  if (result.handle.requestDigest !== result.parentRequestDigest) {
    throw new OperationWireResultError("control_parent_mismatch", "Control handle does not match parent request identity.");
  }
  if (result.handle.targetBindingDigest !== result.parentTargetBindingDigest) {
    throw new OperationWireResultError("control_parent_mismatch", "Control handle does not match parent target identity.");
  }
  if (result.status === "completed") {
    if (result.receipt === undefined || result.blocker !== undefined) {
      throw new OperationWireResultError("invalid_control_result", "A completed control result requires a receipt and no blocker.");
    }
    validateControlReceipt(result.receipt, result as unknown as OperationControlWireResult);
    if (result.receipt.outcome !== "satisfied") {
      throw new OperationWireResultError("invalid_control_result", "A completed control result requires a satisfied receipt.");
    }
  } else {
    if (result.blocker === undefined) {
      throw new OperationWireResultError("invalid_control_result", "A blocked or uncertain control result requires a blocker.");
    }
    validateBlocker(result.blocker, result.operationId, result.parentRequestDigest);
    validateBlockerHandleCoherence(result.blocker, result.handle);
    if (result.receipt !== undefined) {
      validateControlReceipt(result.receipt, result as unknown as OperationControlWireResult);
      const expectedOutcome = result.status === "blocked" ? "not_satisfied" : "uncertain";
      if (result.receipt.outcome !== expectedOutcome) {
        throw new OperationWireResultError("invalid_control_result", "Control receipt outcome does not match result status.");
      }
    }
  }
  return result as OperationControlWireResult;
}

function validateEnvelope(value: unknown, schemaVersion: string, expectedHandleRequestDigest?: string): Record<string, any> {
  assertJsonSafe(value);
  if (!isRecord(value)) throw new OperationWireResultError("invalid_wire_result", "Operation result must be an object.");
  if (value.schemaVersion !== schemaVersion) throw new OperationWireResultError("unsupported_wire_result", "Operation result schemaVersion is unsupported.");
  const status = value.status;
  if (!WIRE_STATUSES.has(status)) throw new OperationWireResultError("invalid_wire_status", "Operation result status is invalid.");
  if (typeof value.operationId !== "string" || !UUID_PATTERN.test(value.operationId)) {
    throw new OperationWireResultError("invalid_operation_id", "Operation result operationId must be a UUID.");
  }
  if (typeof value.requestDigest !== "string" || !DIGEST_PATTERN.test(value.requestDigest)) {
    throw new OperationWireResultError("invalid_request_digest", "Operation result requestDigest must be canonical.");
  }
  validateHandle(value.handle, value.operationId, expectedHandleRequestDigest ?? value.requestDigest);
  return value;
}

function validateHandle(value: unknown, operationId: string, requestDigest: string): asserts value is OperationHandleV1 {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_handle", "Operation result must carry a handle.");
  assertExactKeys(value, ["schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary", "targetBindingDigest"]);
  if (value.schemaVersion !== "chatgpt.browser_control.operation_handle.v1") throw new OperationWireResultError("unsupported_handle", "Operation result handle schemaVersion is unsupported.");
  if (value.operationId !== operationId || value.requestDigest !== requestDigest) throw new OperationWireResultError("operation_identity_mismatch", "Operation result handle identity does not match the envelope.");
  if (value.surface !== "chat" && value.surface !== "work") throw new OperationWireResultError("invalid_handle", "Operation result handle surface is invalid.");
  if (!isSafeInteger(value.revision) || value.revision < 1) throw new OperationWireResultError("invalid_handle", "Operation result handle revision is invalid.");
  if (!PHASES.has(value.phase)) throw new OperationWireResultError("invalid_handle", "Operation result handle phase is invalid.");
  if (!BOUNDARIES.has(value.mutationBoundary)) throw new OperationWireResultError("invalid_handle", "Operation result handle mutation boundary is invalid.");
  if (value.targetBindingDigest !== undefined && !isDigest(value.targetBindingDigest)) throw new OperationWireResultError("invalid_handle", "Operation result target binding digest is invalid.");
}

function validateReceipt(value: unknown, operationId: string, requestDigest: string): asserts value is OperationReceiptV1 {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_receipt", "Operation result receipt must be an object.");
  assertExactKeys(value, [
    "schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "userTurnId", "userTurnEvidenceDigest",
    "assistantTurnId", "ownershipEvidenceDigest", "responseDigest", "responseBytes", "responseFormat", "finishReason", "contentAvailable", "artifacts", "completedAt"
  ]);
  if (value.schemaVersion !== "chatgpt.browser_control.operation_receipt.v1") throw new OperationWireResultError("unsupported_receipt", "Operation result receipt schemaVersion is unsupported.");
  if (value.operationId !== operationId || value.requestDigest !== requestDigest) throw new OperationWireResultError("receipt_identity_mismatch", "Receipt identity does not match the result.");
  assertDigest(value.targetBindingDigest, "targetBindingDigest");
  assertOpaqueId(value.userTurnId, "userTurnId");
  assertDigest(value.userTurnEvidenceDigest, "userTurnEvidenceDigest");
  assertOpaqueId(value.assistantTurnId, "assistantTurnId");
  assertDigest(value.ownershipEvidenceDigest, "ownershipEvidenceDigest");
  if (value.responseFormat !== undefined && value.responseFormat !== "markdown" && value.responseFormat !== "text") throw new OperationWireResultError("invalid_receipt", "Receipt responseFormat is invalid.");
  if (value.responseDigest !== undefined) assertDigest(value.responseDigest, "responseDigest");
  if (value.responseBytes !== undefined && (!isSafeInteger(value.responseBytes) || value.responseBytes < 0 || value.responseBytes > MAX_WIRE_RESPONSE_BYTES)) throw new OperationWireResultError("invalid_receipt", "Receipt responseBytes exceeds the bounded wire limit.");
  if ((value.responseDigest === undefined) !== (value.responseBytes === undefined)) throw new OperationWireResultError("invalid_receipt", "Receipt response digest and byte count must be paired.");
  if (value.contentAvailable !== true && value.contentAvailable !== false) throw new OperationWireResultError("invalid_receipt", "Receipt contentAvailable must be boolean.");
  if (value.contentAvailable && (value.responseDigest === undefined || value.responseBytes === undefined)) throw new OperationWireResultError("invalid_receipt", "Available receipt content requires a digest and byte count.");
  if (typeof value.finishReason !== "string" || !FINISH_REASON_PATTERN.test(value.finishReason)) throw new OperationWireResultError("invalid_receipt", "Receipt finishReason is invalid.");
  if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_WIRE_ARTIFACTS) throw new OperationWireResultError("invalid_receipt", "Receipt artifacts exceed the bounded wire limit.");
  const artifactKeys = new Set<string>();
  const artifactOrdinals = new Set<number>();
  for (const artifact of value.artifacts) {
    validateArtifact(artifact, operationId, value.assistantTurnId);
    if (artifactKeys.has(artifact.artifactKey) || artifactOrdinals.has(artifact.ordinal)) throw new OperationWireResultError("invalid_receipt", "Receipt artifact keys and ordinals must be unique.");
    artifactKeys.add(artifact.artifactKey);
    artifactOrdinals.add(artifact.ordinal);
  }
  assertInstant(value.completedAt, "completedAt");
}

function validateArtifact(value: unknown, operationId: string, assistantTurnId: string): void {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_artifact", "Receipt artifact must be an object.");
  assertExactKeys(value, ["schemaVersion", "operationId", "artifactKey", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "outputKey", "mimeType", "bytes", "sha256", "status", "blockerCode"]);
  if (value.schemaVersion !== "chatgpt.browser_control.operation_artifact_receipt.v1" || value.operationId !== operationId || value.assistantTurnId !== assistantTurnId) throw new OperationWireResultError("artifact_identity_mismatch", "Artifact receipt identity does not match the terminal receipt.");
  assertOpaqueKey(value.artifactKey, "artifactKey");
  assertDigest(value.sourceIdentityDigest, "sourceIdentityDigest");
  if (value.kind !== "file" && value.kind !== "image" && value.kind !== "other") throw new OperationWireResultError("invalid_artifact", "Artifact kind is invalid.");
  if (!isSafeInteger(value.ordinal) || value.ordinal < 0 || value.ordinal >= MAX_WIRE_ARTIFACTS) throw new OperationWireResultError("invalid_artifact", "Artifact ordinal is invalid.");
  if (value.outputKey !== undefined) assertOutputKey(value.outputKey);
  if (value.mimeType !== undefined && (typeof value.mimeType !== "string" || !MIME_PATTERN.test(value.mimeType))) throw new OperationWireResultError("invalid_artifact", "Artifact MIME type is invalid.");
  if (value.bytes !== undefined && (!isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_WIRE_RESPONSE_BYTES)) throw new OperationWireResultError("invalid_artifact", "Artifact size exceeds the bounded wire limit.");
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256))) throw new OperationWireResultError("invalid_artifact", "Artifact SHA-256 is invalid.");
  if (value.status !== "available" && value.status !== "transferred" && value.status !== "partial" && value.status !== "blocked") throw new OperationWireResultError("invalid_artifact", "Artifact status is invalid.");
  if (value.status === "transferred" && (value.outputKey === undefined || value.bytes === undefined || value.sha256 === undefined)) throw new OperationWireResultError("invalid_artifact", "Transferred artifact requires output identity, size, and SHA-256.");
  if ((value.status === "partial" || value.status === "blocked") && (typeof value.blockerCode !== "string" || !CODE_PATTERN.test(value.blockerCode))) throw new OperationWireResultError("invalid_artifact", "Blocked artifact requires a blocker code.");
  if ((value.status === "available" || value.status === "transferred") && value.blockerCode !== undefined) throw new OperationWireResultError("invalid_artifact", "Available artifact must not carry a blocker code.");
}

function validateBlocker(value: unknown, operationId: string, requestDigest: string): asserts value is OperationBlockerV1 {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_blocker", "Operation result blocker must be an object.");
  assertExactKeys(value, ["schemaVersion", "code", "recoverable", "operationId", "requestDigest", "phase", "mutationBoundary", "message"]);
  if (value.schemaVersion !== "chatgpt.browser_control.operation_blocker.v1") throw new OperationWireResultError("unsupported_blocker", "Operation result blocker schemaVersion is unsupported.");
  if (value.operationId !== operationId || value.requestDigest !== requestDigest) throw new OperationWireResultError("blocker_identity_mismatch", "Blocker identity does not match the result.");
  if (typeof value.code !== "string" || !WIRE_BLOCKER_CODES.has(value.code as OperationBlockerCode)) throw new OperationWireResultError("invalid_blocker", "Blocker code is not in the versioned taxonomy.");
  if (typeof value.recoverable !== "boolean") throw new OperationWireResultError("invalid_blocker", "Blocker recoverable must be boolean.");
  if (!PHASES.has(value.phase) || !BOUNDARIES.has(value.mutationBoundary)) throw new OperationWireResultError("invalid_blocker", "Blocker phase or mutation boundary is invalid.");
  if (typeof value.message !== "string" || !SAFE_MESSAGE_PATTERN.test(value.message) || value.message.length > MAX_WIRE_BLOCKER_MESSAGE_LENGTH) throw new OperationWireResultError("invalid_blocker", "Blocker message is not a safe bounded diagnostic.");
}

function validateControlReceipt(value: unknown, result: OperationControlWireResult): asserts value is OperationControlReceiptV1 {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_control_receipt", "Control result receipt must be an object.");
  assertExactKeys(value, ["schemaVersion", "controlActionId", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "expectedAssistantTurnId", "requestDigest", "action", "outcome", "evidenceDigest", "blockerCode", "observedAt"]);
  if (value.schemaVersion !== "chatgpt.browser_control.operation_control_receipt.v1") throw new OperationWireResultError("unsupported_control_receipt", "Control receipt schemaVersion is unsupported.");
  if (value.controlActionId !== result.controlActionId || value.parentOperationId !== result.operationId || value.parentRequestDigest !== result.parentRequestDigest || value.parentTargetBindingDigest !== result.parentTargetBindingDigest || value.requestDigest !== result.requestDigest || value.action !== result.action || value.expectedAssistantTurnId !== result.expectedAssistantTurnId) throw new OperationWireResultError("control_receipt_identity_mismatch", "Control receipt identity does not match the result.");
  if (value.outcome !== "satisfied" && value.outcome !== "not_satisfied" && value.outcome !== "uncertain") throw new OperationWireResultError("invalid_control_receipt", "Control receipt outcome is invalid.");
  if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest, "evidenceDigest");
  if (value.outcome === "satisfied" && value.evidenceDigest === undefined) throw new OperationWireResultError("invalid_control_receipt", "Satisfied control receipt requires evidence.");
  if (value.blockerCode !== undefined && (typeof value.blockerCode !== "string" || !CODE_PATTERN.test(value.blockerCode))) throw new OperationWireResultError("invalid_control_receipt", "Control receipt blocker code is invalid.");
  if (value.outcome === "satisfied" && value.blockerCode !== undefined) throw new OperationWireResultError("invalid_control_receipt", "Satisfied control receipt must not carry a blocker code.");
  if ((value.outcome === "not_satisfied" || value.outcome === "uncertain") && value.blockerCode === undefined) throw new OperationWireResultError("invalid_control_receipt", "Non-satisfied control receipt requires a blocker code.");
  assertInstant(value.observedAt, "observedAt");
}

function validateLiveResponse(value: unknown): OperationLiveResponseV1 {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_live_response", "Live response must be an object.");
  assertExactKeys(value, ["schemaVersion", "durability", "durable", "content", "responseFormat", "bytes", "chars"]);
  if (value.schemaVersion !== OPERATION_LIVE_RESPONSE_SCHEMA_VERSION || value.durability !== "ephemeral" || value.durable !== false) throw new OperationWireResultError("invalid_live_response", "Live response must be explicitly ephemeral and non-durable.");
  if (value.responseFormat !== undefined && value.responseFormat !== "markdown" && value.responseFormat !== "text") throw new OperationWireResultError("invalid_live_response", "Live response responseFormat is invalid.");
  if (typeof value.content !== "string") throw new OperationWireResultError("invalid_live_response", "Live response content must be a string.");
  assertUnicodeScalarString(value.content);
  if (Buffer.byteLength(value.content, "utf8") !== value.bytes || value.content.length !== value.chars || !isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_WIRE_RESPONSE_BYTES || !isSafeInteger(value.chars) || value.chars < 0 || value.chars > MAX_WIRE_RESPONSE_CHARS) throw new OperationWireResultError("invalid_live_response", "Live response content size metadata is invalid.");
  return value as OperationLiveResponseV1;
}

function validateLiveResponseReceiptCoherence(
  liveResponse: OperationLiveResponseV1,
  receipt: OperationReceiptV1
): void {
  if (
    receipt.contentAvailable !== true
    || receipt.responseBytes !== liveResponse.bytes
    || receipt.responseFormat !== liveResponse.responseFormat
  ) {
    throw new OperationWireResultError(
      "live_response_receipt_mismatch",
      "Live response metadata does not match the durable receipt."
    );
  }
}

function validateState(value: unknown, operationId: string, requestDigest: string): asserts value is OperationStateV1 {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_state", "Inspect result state must be an object.");
  assertExactKeys(value, ["schemaVersion", "operationId", "requestDigest", "surface", "phase", "mutationBoundary", "revision", "createdAt", "updatedAt", "capturePolicy", "responseFormat", "target", "attachmentRearm", "actions", "ownershipBaseline", "ownershipBaselines", "artifactTransfers", "submissionWitnesses", "submissionWitness", "lastBlocker", "receipt"]);
  if (value.schemaVersion !== "chatgpt.browser_control.operation.v1") throw new OperationWireResultError("unsupported_state", "Inspect state schemaVersion is unsupported.");
  if (value.operationId !== operationId || value.requestDigest !== requestDigest) throw new OperationWireResultError("state_identity_mismatch", "Inspect state identity does not match the result.");
  assertDigest(value.requestDigest, "state.requestDigest");
  if (value.surface !== "chat" && value.surface !== "work") throw new OperationWireResultError("invalid_state", "Inspect state surface is invalid.");
  if (!PHASES.has(value.phase) || !BOUNDARIES.has(value.mutationBoundary)) throw new OperationWireResultError("invalid_state", "Inspect state phase or mutation boundary is invalid.");
  if (!isSafeInteger(value.revision) || value.revision < 1) throw new OperationWireResultError("invalid_state", "Inspect state revision is invalid.");
  assertInstant(value.createdAt, "state.createdAt");
  assertInstant(value.updatedAt, "state.updatedAt");
  if (value.responseFormat !== undefined && value.responseFormat !== "markdown" && value.responseFormat !== "text") throw new OperationWireResultError("invalid_state", "Inspect state responseFormat is invalid.");
  if (value.capturePolicy !== undefined) {
    try {
      assertDurableCapturePolicyShape(value.capturePolicy);
    } catch {
      throw new OperationWireResultError("invalid_state", "Inspect state capture policy is invalid.");
    }
    if (value.responseFormat !== undefined && value.responseFormat !== (value.capturePolicy as { responseFormat: unknown }).responseFormat) {
      throw new OperationWireResultError("invalid_state", "Inspect state capture policy format is inconsistent.");
    }
  }
  if (!isRecord(value.actions)) throw new OperationWireResultError("invalid_state", "Inspect state actions must be an object.");
  for (const [actionId, action] of Object.entries(value.actions)) validateStateAction(actionId, action, operationId, requestDigest);
  if (value.target !== undefined) validateStateTarget(value.target);
  if (value.attachmentRearm !== undefined) validateStateAttachmentRearm(value.attachmentRearm, value.revision);
  if (value.lastBlocker !== undefined) validateStateBlocker(value.lastBlocker);
  if (value.receipt !== undefined) validateReceipt(value.receipt, operationId, requestDigest);
  if (value.phase === "completed" && value.receipt === undefined) throw new OperationWireResultError("invalid_state", "Completed inspect state requires a receipt.");
  if (value.phase !== "completed" && value.receipt !== undefined) throw new OperationWireResultError("invalid_state", "Only completed inspect state may contain a receipt.");
  try {
    assertOperationStateShape(value);
  } catch {
    // The durable validator may mention persisted identifiers while explaining
    // a failed invariant. Keep wire diagnostics fixed and privacy-safe.
    throw new OperationWireResultError("invalid_state", "Inspect state failed durable invariant validation.");
  }
}

function validateStateAttachmentRearm(value: unknown, stateRevision: number): void {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_state", "Inspect attachment rearm must be an object.");
  assertExactKeys(value, [
    "schemaVersion", "authorizationId", "actionId", "previousTargetBindingDigest",
    "targetBindingDigest", "authorizationEvidenceDigest", "authorizedRevision", "authorizedAt",
    "attemptIntentRevision", "attemptIntentAt", "preflightEvidenceDigest"
  ]);
  if (value.schemaVersion !== "chatgpt.browser_control.operation_attachment_rearm.v1") {
    throw new OperationWireResultError("invalid_state", "Inspect attachment rearm schemaVersion is unsupported.");
  }
  if (typeof value.authorizationId !== "string" || !UUID_PATTERN.test(value.authorizationId)) {
    throw new OperationWireResultError("invalid_state", "Inspect attachment rearm authorization ID is invalid.");
  }
  if (typeof value.actionId !== "string" || !UUID_PATTERN.test(value.actionId)) {
    throw new OperationWireResultError("invalid_state", "Inspect attachment rearm action ID is invalid.");
  }
  assertDigest(value.previousTargetBindingDigest, "attachmentRearm.previousTargetBindingDigest");
  assertDigest(value.targetBindingDigest, "attachmentRearm.targetBindingDigest");
  assertDigest(value.authorizationEvidenceDigest, "attachmentRearm.authorizationEvidenceDigest");
  if (!isSafeInteger(value.authorizedRevision) || value.authorizedRevision < 1 || value.authorizedRevision > stateRevision) {
    throw new OperationWireResultError("invalid_state", "Inspect attachment rearm authorization revision is invalid.");
  }
  assertInstant(value.authorizedAt, "attachmentRearm.authorizedAt");
  const intentFields = [value.attemptIntentRevision, value.attemptIntentAt, value.preflightEvidenceDigest];
  const intentCount = intentFields.filter(candidate => candidate !== undefined).length;
  if (intentCount !== 0 && intentCount !== 3) {
    throw new OperationWireResultError("invalid_state", "Inspect attachment rearm intent is incomplete.");
  }
  if (value.attemptIntentRevision !== undefined) {
    if (
      !isSafeInteger(value.attemptIntentRevision)
      || value.attemptIntentRevision <= value.authorizedRevision
      || value.attemptIntentRevision > stateRevision
    ) {
      throw new OperationWireResultError("invalid_state", "Inspect attachment rearm intent revision is invalid.");
    }
    assertInstant(value.attemptIntentAt, "attachmentRearm.attemptIntentAt");
    if (value.attemptIntentAt < value.authorizedAt) {
      throw new OperationWireResultError("invalid_state", "Inspect attachment rearm intent precedes authorization.");
    }
    assertDigest(value.preflightEvidenceDigest, "attachmentRearm.preflightEvidenceDigest");
  }
}

function validateStateTarget(value: unknown): void {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_state_target", "Inspect target binding must be an object.");
  assertExactKeys(value, ["providerId", "browserId", "tabId", "coordinationScope", "tabClaimEvidenceDigest", "canonicalThreadUrl", "conversationId", "userTurnBaselineDigest", "assistantTurnBaselineDigest", "configurationReceiptDigest", "evidenceProfile", "targetLifecycle", "newTargetAnchorDigest", "blankTaskEvidenceDigest", "targetEstablishment"]);
  for (const key of ["providerId", "browserId", "tabId"] as const) assertOpaqueId(value[key], `target.${key}`);
  if (value.coordinationScope !== "process" && value.coordinationScope !== "provider") throw new OperationWireResultError("invalid_state_target", "Target coordination scope is invalid.");
  if (value.coordinationScope === "provider" && value.tabClaimEvidenceDigest === undefined) throw new OperationWireResultError("invalid_state_target", "Provider-coordinated target requires a tab claim digest.");
  for (const key of ["tabClaimEvidenceDigest", "userTurnBaselineDigest", "assistantTurnBaselineDigest", "configurationReceiptDigest"] as const) if (value[key] !== undefined) assertDigest(value[key], `target.${key}`);
  if (value.canonicalThreadUrl !== undefined && (typeof value.canonicalThreadUrl !== "string" || !/^https:\/\/[^?#]+$/u.test(value.canonicalThreadUrl))) throw new OperationWireResultError("invalid_state_target", "Target URL is not a sanitized HTTPS URL.");
  if (value.conversationId !== undefined) assertOpaqueId(value.conversationId, "target.conversationId");
  if (!isRecord(value.evidenceProfile)) throw new OperationWireResultError("invalid_state_target", "Target evidence profile is invalid.");
  assertExactKeys(value.evidenceProfile, ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim", "replacementTabRecovery"]);
  for (const key of ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim"] as const) if (value.evidenceProfile[key] !== "required" && value.evidenceProfile[key] !== "unavailable") throw new OperationWireResultError("invalid_state_target", "Target evidence profile value is invalid.");
  if (typeof value.evidenceProfile.replacementTabRecovery !== "boolean") throw new OperationWireResultError("invalid_state_target", "Target evidence recovery flag is invalid.");
  const lifecycle = value.targetLifecycle ?? "fixed";
  if (lifecycle !== "fixed" && lifecycle !== "new_pending" && lifecycle !== "new_established") throw new OperationWireResultError("invalid_state_target", "Target lifecycle is invalid.");
  for (const key of ["newTargetAnchorDigest", "blankTaskEvidenceDigest"] as const) if (value[key] !== undefined) assertDigest(value[key], `target.${key}`);
  if (lifecycle === "fixed" && (value.newTargetAnchorDigest !== undefined || value.blankTaskEvidenceDigest !== undefined || value.targetEstablishment !== undefined)) {
    throw new OperationWireResultError("invalid_state_target", "Fixed target contains new-target identity fields.");
  }
  if (lifecycle === "new_pending" && (
    value.newTargetAnchorDigest === undefined
    || value.blankTaskEvidenceDigest === undefined
    || value.conversationId !== undefined
    || value.canonicalThreadUrl !== undefined
    || value.targetEstablishment !== undefined
    || value.evidenceProfile.stableConversationId !== "unavailable"
    || value.evidenceProfile.stableUserTurnId !== "unavailable"
  )) throw new OperationWireResultError("invalid_state_target", "Pending new target identity is invalid.");
  if (value.targetEstablishment !== undefined) {
    try {
      // The submission adapter's establishment observation is stricter than
      // the read-compatible target projection: old authenticated state may
      // legitimately predate post-Send delta capture.  Keep the state wire
      // contract aligned with `targetEstablishmentRead` in the JSON schema and
      // the Python `OperationTargetEstablishmentRead` model while still
      // validating every identity/evidence field that is present.
      validateStateTargetEstablishment(value.targetEstablishment);
    } catch {
      throw new OperationWireResultError("invalid_state_target", "Target establishment evidence is invalid.");
    }
  }
}

function validateStateTargetEstablishment(value: unknown): void {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_state_target", "Target establishment evidence must be an object.");
  assertExactKeys(value, [
    "targetBindingDigest",
    "anchorDigest",
    "causalSendActionId",
    "conversationId",
    "canonicalThreadUrl",
    "userTurnId",
    "userTurnEvidenceDigest",
    "postSendDeltaDigest",
    "evidenceDigest",
    "observedAt"
  ]);
  assertDigest(value.targetBindingDigest, "targetEstablishment.targetBindingDigest");
  assertDigest(value.anchorDigest, "targetEstablishment.anchorDigest");
  if (typeof value.causalSendActionId !== "string" || !UUID_PATTERN.test(value.causalSendActionId)) {
    throw new OperationWireResultError("invalid_state_target", "Target establishment causal Send action is invalid.");
  }
  assertOpaqueId(value.conversationId, "targetEstablishment.conversationId");
  if (typeof value.canonicalThreadUrl !== "string" || !/^https:\/\/[^?#]+$/u.test(value.canonicalThreadUrl)) {
    throw new OperationWireResultError("invalid_state_target", "Target establishment URL is invalid.");
  }
  assertOpaqueId(value.userTurnId, "targetEstablishment.userTurnId");
  assertDigest(value.userTurnEvidenceDigest, "targetEstablishment.userTurnEvidenceDigest");
  if (value.postSendDeltaDigest !== undefined) assertDigest(value.postSendDeltaDigest, "targetEstablishment.postSendDeltaDigest");
  assertDigest(value.evidenceDigest, "targetEstablishment.evidenceDigest");
  assertInstant(value.observedAt, "targetEstablishment.observedAt");
}

function validateStateAction(actionId: string, value: unknown, operationId: string, requestDigest: string): void {
  if (!UUID_PATTERN.test(actionId) || !isRecord(value)) throw new OperationWireResultError("invalid_state_action", "Inspect state action identity is invalid.");
  assertExactKeys(value, ["actionId", "kind", "repeatPolicy", "requestDigest", "parentActionId", "targetDigest", "intentRevision", "intentAt", "outcome", "receiptRevision", "receiptAt", "evidenceDigest", "blockerCode"]);
  if (value.actionId !== actionId) throw new OperationWireResultError("invalid_state_action", "Inspect action map key does not match actionId.");
  if (typeof value.kind !== "string" || !ACTION_KINDS.has(value.kind)) throw new OperationWireResultError("invalid_state_action", "Inspect action kind is invalid.");
  if (typeof value.repeatPolicy !== "string" || !ACTION_POLICIES.has(value.repeatPolicy) || value.repeatPolicy !== requiredActionPolicy(value.kind)) throw new OperationWireResultError("invalid_state_action", "Inspect action repeat policy is invalid.");
  assertDigest(value.requestDigest, "action.requestDigest");
  if (value.parentActionId !== undefined && !UUID_PATTERN.test(String(value.parentActionId))) throw new OperationWireResultError("invalid_state_action", "Inspect action parent ID is invalid.");
  if (value.targetDigest !== undefined) assertDigest(value.targetDigest, "action.targetDigest");
  if (!isSafeInteger(value.intentRevision) || value.intentRevision < 1) throw new OperationWireResultError("invalid_state_action", "Inspect action intent revision is invalid.");
  assertInstant(value.intentAt, "action.intentAt");
  if (value.outcome !== undefined && value.outcome !== "satisfied" && value.outcome !== "not_satisfied" && value.outcome !== "uncertain") throw new OperationWireResultError("invalid_state_action", "Inspect action outcome is invalid.");
  if (value.outcome === undefined && (value.receiptRevision !== undefined || value.receiptAt !== undefined || value.evidenceDigest !== undefined || value.blockerCode !== undefined)) throw new OperationWireResultError("invalid_state_action", "Unsettled inspect action contains receipt fields.");
  if (value.outcome !== undefined && (value.receiptRevision === undefined || value.receiptAt === undefined)) throw new OperationWireResultError("invalid_state_action", "Settled inspect action requires a receipt revision and time.");
  if (value.receiptRevision !== undefined && (!isSafeInteger(value.receiptRevision) || value.receiptRevision < 1)) throw new OperationWireResultError("invalid_state_action", "Inspect action receipt revision is invalid.");
  if (value.receiptAt !== undefined) assertInstant(value.receiptAt, "action.receiptAt");
  if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest, "action.evidenceDigest");
  if (value.blockerCode !== undefined && (typeof value.blockerCode !== "string" || !CODE_PATTERN.test(value.blockerCode))) throw new OperationWireResultError("invalid_state_action", "Inspect action blocker code is invalid.");
  if (value.blockerCode !== undefined && value.outcome !== "not_satisfied" && value.outcome !== "uncertain") {
    throw new OperationWireResultError("invalid_state_action", "Inspect action blocker code requires a non-satisfied or uncertain outcome.");
  }
  if (value.kind !== "stop" && value.kind !== "work_steer" && value.requestDigest !== requestDigest) {
    throw new OperationWireResultError("state_identity_mismatch", "Inspect action request identity does not match the operation.");
  }
}

function validateBlockerHandleCoherence(blocker: OperationBlockerV1, handle: OperationHandleV1): void {
  if (blocker.phase !== handle.phase || blocker.mutationBoundary !== handle.mutationBoundary) {
    throw new OperationWireResultError("blocker_handle_mismatch", "Operation blocker does not match the fresh handle.");
  }
}

function validateStateBlocker(value: unknown): void {
  if (!isRecord(value)) throw new OperationWireResultError("invalid_state_blocker", "Inspect state blocker must be an object.");
  assertExactKeys(value, ["code", "messageDigest", "recoverable", "observedAt"]);
  if (typeof value.code !== "string" || !CODE_PATTERN.test(value.code)) throw new OperationWireResultError("invalid_state_blocker", "Inspect state blocker code is invalid.");
  assertDigest(value.messageDigest, "lastBlocker.messageDigest");
  if (typeof value.recoverable !== "boolean") throw new OperationWireResultError("invalid_state_blocker", "Inspect state blocker recoverable must be boolean.");
  assertInstant(value.observedAt, "lastBlocker.observedAt");
}

function blockerFromCollector(blocker: { code: CollectorBlockerCode; mutationBoundary: OperationHandleV1["mutationBoundary"]; operationId: string; requestDigest: string; phase: OperationHandleV1["phase"]; attempts: number; message: string; evidenceDigest?: string }, handle: OperationHandleV1): OperationBlockerV1 {
  return blockerFromInternal(blocker.code, handle, blocker.mutationBoundary, false, blocker.evidenceDigest);
}

function assertSubmissionIdentity(result: SubmissionResult, handle: OperationHandleV1): void {
  if (result.operationId !== handle.operationId || result.requestDigest !== handle.requestDigest) {
    throw new OperationWireResultError("operation_identity_mismatch", "Submission identity does not match the fresh handle.");
  }
  if (result.targetBindingDigest !== handle.targetBindingDigest) {
    throw new OperationWireResultError("target_binding_mismatch", "Submission target identity does not match the fresh handle.");
  }
}

function assertCollectorIdentity(result: CollectorResult, handle: OperationHandleV1): void {
  if (result.operationId !== handle.operationId || result.requestDigest !== handle.requestDigest) {
    throw new OperationWireResultError("operation_identity_mismatch", "Collector identity does not match the fresh handle.");
  }
  if (result.targetBindingDigest !== undefined && result.targetBindingDigest !== handle.targetBindingDigest) {
    throw new OperationWireResultError("target_binding_mismatch", "Collector target identity does not match the fresh handle.");
  }
}

function blockerFromInternal(
  code: SubmissionBlockerCode | CollectorBlockerCode | OperationBlockerCode,
  handle: OperationHandleV1,
  mutationBoundary: OperationHandleV1["mutationBoundary"],
  recoverable: boolean,
  evidenceDigest?: string,
  requestDigest = handle.requestDigest
): OperationBlockerV1 {
  const normalized = normalizeBlockerCode(code);
  return {
    schemaVersion: "chatgpt.browser_control.operation_blocker.v1",
    code: normalized,
    recoverable,
    operationId: handle.operationId,
    requestDigest,
    phase: handle.phase,
    mutationBoundary,
    message: blockerMessage(normalized, evidenceDigest)
  };
}

function normalizeBlockerCode(code: string): OperationBlockerCode {
  if (WIRE_BLOCKER_CODES.has(code as OperationBlockerCode)) return code as OperationBlockerCode;
  if (code === "operation_not_collectable" || code === "operation_receipt_expired") return "operation_state_corrupt";
  if (code === "operation_receipt_persistence_failed" || code === "operation_receipt_indeterminate" || code === "operation_progress_persistence_failed" || code === "journal_unavailable" || code === "port_protocol_violation") return "backend_unavailable";
  if (code === "composer_drift") return "configuration_drift";
  if (code === "already_completed") return "operation_state_corrupt";
  return "backend_unavailable";
}

function blockerMessage(code: OperationBlockerCode, evidenceDigest?: string): string {
  // Deliberately fixed text: adapter/error messages may contain prompt, path,
  // URL, account, or provider-private content and never cross this boundary.
  return evidenceDigest === undefined ? `Operation blocked: ${code.replaceAll("_", " ")}.` : `Operation blocked: ${code.replaceAll("_", " ")} (evidence recorded).`;
}

function assertJsonSafe(value: unknown, depth = 0, nodes = { value: 0 }): void {
  if (++nodes.value > 10_000 || depth > 16) throw new OperationWireResultError("wire_result_too_large", "Operation result exceeds the bounded JSON envelope.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OperationWireResultError("invalid_json_value", "Operation result contains a non-finite number.");
    return;
  }
  if (typeof value !== "object") throw new OperationWireResultError("invalid_json_value", "Operation result contains a non-JSON value.");
  if (Array.isArray(value)) {
    for (const child of value) assertJsonSafe(child, depth + 1, nodes);
    return;
  }
  if (!isRecord(value)) throw new OperationWireResultError("invalid_json_value", "Operation result must contain plain objects only.");
  for (const child of Object.values(value)) assertJsonSafe(child, depth + 1, nodes);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new OperationWireResultError("unexpected_wire_field", "Unexpected wire field.");
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new OperationWireResultError("invalid_digest", `${label} must be a canonical digest.`);
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value) || value.trim().length === 0) throw new OperationWireResultError("invalid_id", `${label} must be a bounded opaque identifier.`);
}

function assertOpaqueKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_KEY_PATTERN.test(value)) throw new OperationWireResultError("invalid_key", `${label} must be a bounded opaque key.`);
}

function assertOutputKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OUTPUT_KEY_PATTERN.test(value)) throw new OperationWireResultError("invalid_output_key", "Artifact outputKey is invalid.");
}

function assertInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) throw new OperationWireResultError("invalid_instant", `${label} must be a canonical UTC instant.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new OperationWireResultError("invalid_instant", `${label} must be a real canonical UTC instant.`);
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new OperationWireResultError("invalid_live_response", "Live response content contains invalid Unicode.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new OperationWireResultError("invalid_live_response", "Live response content contains invalid Unicode.");
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^(?=.*\S)[^\u0000-\u001f\u007f]{1,512}$/u;
const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINISH_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_MESSAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,:;_'()\-]{0,511}$/;
const PHASES = new Set(["prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed", "uncertain"]);
const BOUNDARIES = new Set(["none", "handoff_may_have_occurred", "send_may_have_occurred", "control_may_have_occurred"]);
const WIRE_STATUSES = new Set<OperationWireStatus>(["accepted", "completed", "pending", "blocked", "uncertain"]);
const SUBMIT_STATUSES = new Set(["accepted", "completed", "blocked", "uncertain"]);
const COLLECT_STATUSES = new Set(["completed", "pending", "blocked", "uncertain"]);
const CONTROL_STATUSES = new Set(["completed", "blocked", "uncertain"]);
const WIRE_BLOCKER_CODES = new Set<OperationBlockerCode>([
  "operation_not_found", "operation_request_mismatch", "operation_state_corrupt", "operation_receipt_expired", "operation_quota_exceeded", "operation_cancelled", "operation_timeout", "ambiguous_file_handoff", "ambiguous_submit", "attachment_manifest_mismatch", "input_file_changed", "target_binding_mismatch", "target_evidence_unavailable", "turn_ownership_ambiguous", "concurrent_user_turn", "configuration_drift", "tab_ownership_conflict", "provider_concurrency_unsupported", "runtime_incompatible", "backend_unavailable", "browser_bridge_unavailable", "login_required", "captcha", "rate_limited", "permission_required", "needs_confirmation", "selector_drift", "send_control_unavailable", "capture_ownership_lost", "artifact_unavailable", "artifact_transfer_partial", "output_collision", "output_commit_indeterminate", "clipboard_restore_failed"
]);
const ACTION_KINDS = new Set(["status_read", "configuration_set", "tool_set", "composer_set", "power_discovery", "power_select", "file_handoff", "send", "work_steer", "stop", "download", "local_output_commit", "clipboard_capture_restore"]);
const ACTION_POLICIES = new Set(["read_only", "reconcile_set_to_value", "reconcile_local_effect", "observe_only_after_intent"]);

function requiredActionPolicy(kind: string): string {
  if (kind === "status_read" || kind === "power_discovery") return "read_only";
  if (kind === "configuration_set" || kind === "tool_set" || kind === "composer_set" || kind === "power_select") return "reconcile_set_to_value";
  if (kind === "file_handoff" || kind === "send" || kind === "work_steer" || kind === "stop") return "observe_only_after_intent";
  return "reconcile_local_effect";
}
