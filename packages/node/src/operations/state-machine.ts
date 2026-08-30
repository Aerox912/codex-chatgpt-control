import {
  OPERATION_ATTACHMENT_REARM_SCHEMA_VERSION,
  OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
  OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION,
  OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
  OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
  type MutationBoundary,
  type OperationActionKind,
  type OperationActionOutcome,
  type OperationActionRecordV1,
  type OperationAttachmentRearmV1,
  type OperationArtifactReceiptV1,
  type OperationArtifactTransferIntentV1,
  type OperationArtifactTransferReceiptV1,
  type OperationArtifactTransferStateV1,
  type OperationCapturePolicyV1,
  type OperationDurableCapturePolicyV1,
  type OperationEventV1,
  type OperationOwnershipBaselineV1,
  type OperationPhase,
  type OperationRepeatPolicy,
  type OperationStateV1,
  type OperationSubmissionWitnessV1
} from "./types.js";
import { canonicalJson } from "./canonical.js";
import type { OwnershipBaseline, OwnershipIdentityEvidence, OwnershipTargetEvidence, OwnershipTurn } from "./turn-ownership.js";

const BOUNDARY_RANK: Record<MutationBoundary, number> = {
  none: 0,
  handoff_may_have_occurred: 1,
  send_may_have_occurred: 2,
  control_may_have_occurred: 3
};

const LEGAL_EDGES: Record<OperationPhase, ReadonlySet<OperationPhase>> = {
  prepared: new Set(["handoff_pending", "ready", "uncertain"]),
  handoff_pending: new Set(["ready", "uncertain"]),
  ready: new Set(["send_pending", "uncertain"]),
  send_pending: new Set(["submitted", "uncertain"]),
  submitted: new Set(["generating", "capturing", "uncertain"]),
  generating: new Set(["capturing", "uncertain"]),
  capturing: new Set(["uncertain"]),
  completed: new Set(),
  uncertain: new Set(["ready", "submitted", "generating", "capturing"])
};

const ACTION_POLICY: Record<OperationActionKind, OperationRepeatPolicy> = {
  status_read: "read_only",
  configuration_set: "reconcile_set_to_value",
  tool_set: "reconcile_set_to_value",
  composer_set: "reconcile_set_to_value",
  power_discovery: "read_only",
  power_select: "reconcile_set_to_value",
  file_handoff: "observe_only_after_intent",
  send: "observe_only_after_intent",
  work_steer: "observe_only_after_intent",
  stop: "observe_only_after_intent",
  download: "reconcile_local_effect",
  local_output_commit: "reconcile_local_effect",
  clipboard_capture_restore: "reconcile_local_effect"
};

/**
 * Copy only the closed capture contract into durable state.  In particular,
 * the request-local outputDirectory is intentionally not read or returned.
 * Missing capture options preserve the historical collect defaults while the
 * response format receives its explicit Markdown default.
 */
export function durableCapturePolicyFromRequest(
  capture: OperationCapturePolicyV1 | undefined
): OperationDurableCapturePolicyV1 {
  return {
    responseContent: capture?.responseContent ?? "include",
    responseFormat: capture?.responseFormat ?? "markdown",
    artifacts: capture?.artifacts ?? "receipt_only"
  };
}

const ACTION_PHASES: Record<OperationActionKind, ReadonlySet<OperationPhase>> = {
  status_read: new Set(["prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed", "uncertain"]),
  configuration_set: new Set(["prepared"]),
  tool_set: new Set(["prepared"]),
  composer_set: new Set(["prepared"]),
  power_discovery: new Set(["prepared"]),
  power_select: new Set(["prepared"]),
  file_handoff: new Set(["prepared"]),
  send: new Set(["ready"]),
  work_steer: new Set(["generating"]),
  stop: new Set(["generating"]),
  download: new Set(["capturing"]),
  local_output_commit: new Set(["capturing"]),
  clipboard_capture_restore: new Set(["capturing"])
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TRANSFER_OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINISH_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}$/;
const MAX_ARTIFACTS = 32;
const MAX_BASELINE_TURNS = 256;
const MAX_BASELINE_ARTIFACTS_PER_TURN = 32;
const MAX_SUBMISSION_WITNESSES = 64;

function isSingleIntentKind(kind: OperationActionKind): boolean {
  return kind === "file_handoff" || kind === "send";
}

export class OperationStateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OperationStateError";
  }
}

export function assertOperationId(value: string, label = "operationId"): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new OperationStateError("invalid_operation_id", `${label} must be a canonical UUID.`);
  }
}

export function reduceOperationEvents(events: readonly OperationEventV1[]): OperationStateV1 {
  let state: OperationStateV1 | undefined;
  for (let index = 0; index < events.length; index += 1) {
    state = applyOperationEvent(state, events[index]!, index + 1);
  }
  if (state === undefined) {
    throw new OperationStateError("empty_operation_log", "Operation log does not contain an operation_created event.");
  }
  return state;
}

export function applyOperationEvent(
  state: OperationStateV1 | undefined,
  event: OperationEventV1,
  revision: number
): OperationStateV1 {
  assertOperationEventShape(event);
  if (event.type === "operation_created") {
    if (state !== undefined || revision !== 1) {
      throw new OperationStateError("duplicate_operation_created", "operation_created must be the first and only creation event.");
    }
    assertOperationId(event.operationId);
    assertDigest(event.requestDigest, "requestDigest");
    assertTimestamp(event.createdAt, "createdAt");
    if (event.surface !== "chat" && event.surface !== "work") {
      throw new OperationStateError("invalid_operation_surface", "Operation surface must be chat or work.");
    }
    return {
      schemaVersion: OPERATION_SCHEMA_VERSION,
      operationId: event.operationId,
      requestDigest: event.requestDigest,
      surface: event.surface,
      phase: "prepared",
      mutationBoundary: "none",
      revision,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      actions: {},
      ownershipBaselines: {},
      artifactTransfers: {},
      ...(event.capturePolicy === undefined ? {} : {
        capturePolicy: event.capturePolicy,
        // Keep the existing responseFormat projection for old collector and
        // inspect consumers while the path-free policy becomes authoritative.
        responseFormat: event.capturePolicy.responseFormat
      })
    };
  }

  if (state === undefined) {
    throw new OperationStateError("missing_operation_created", "Operation event occurred before operation_created.");
  }
  if (revision !== state.revision + 1) {
    throw new OperationStateError("revision_gap", `Expected revision ${state.revision + 1}, received ${revision}.`);
  }

  switch (event.type) {
    case "target_bound":
      assertTimestamp(event.observedAt, "observedAt");
      assertTimestampNotBefore(state.updatedAt, event.observedAt, "observedAt");
      return withRevision({ ...state, target: validatedTarget(state, event.target) }, revision, event.observedAt);
    case "target_established":
      assertTimestamp(event.establishment.observedAt, "target_established.observedAt");
      assertTimestampNotBefore(state.updatedAt, event.establishment.observedAt, "target_established.observedAt");
      return withRevision({ ...state, target: establishTarget(state, event.establishment) }, revision, event.establishment.observedAt);
    case "attachment_rearm_authorized":
      assertTimestamp(event.authorization.authorizedAt, "attachment_rearm_authorized.authorizedAt");
      assertTimestampNotBefore(state.updatedAt, event.authorization.authorizedAt, "attachment_rearm_authorized.authorizedAt");
      return withRevision(
        applyAttachmentRearmAuthorization(state, event, revision),
        revision,
        event.authorization.authorizedAt
      );
    case "attachment_rearm_intent":
      assertTimestamp(event.intentAt, "attachment_rearm_intent.intentAt");
      assertTimestampNotBefore(state.updatedAt, event.intentAt, "attachment_rearm_intent.intentAt");
      return withRevision(applyAttachmentRearmIntent(state, event, revision), revision, event.intentAt);
    case "ownership_baseline":
      assertTimestamp(event.baseline.observedAt, "ownership_baseline.observedAt");
      assertTimestampNotBefore(state.updatedAt, event.baseline.observedAt, "ownership_baseline.observedAt");
      return withRevision(applyOwnershipBaseline(state, event.baseline), revision, event.baseline.observedAt);
    case "submission_witness":
      assertTimestamp(event.witness.observedAt, "submission_witness.observedAt");
      assertTimestampNotBefore(state.updatedAt, event.witness.observedAt, "submission_witness.observedAt");
      return withRevision(applySubmissionWitness(state, event.witness), revision, event.witness.observedAt);
    case "action_intent":
      assertTimestamp(event.intentAt, "intentAt");
      assertTimestampNotBefore(state.updatedAt, event.intentAt, "intentAt");
      return withRevision(applyActionIntent(state, event.action, revision, event.intentAt), revision, event.intentAt);
    case "action_prepared": {
      assertTimestamp(event.intentAt, "intentAt");
      assertTimestamp(event.baseline.observedAt, "action_prepared.baseline.observedAt");
      assertTimestampNotBefore(state.updatedAt, event.intentAt, "intentAt");
      if (event.baseline.observedAt !== event.intentAt) {
        throw new OperationStateError(
          "action_prepared_timestamp_mismatch",
          "Atomic action preparation requires baseline.observedAt to equal intentAt."
        );
      }
      assertPreparedActionBaselineIdentity(event.action, event.baseline, state);
      const withAction = applyActionIntent(state, event.action, revision, event.intentAt);
      const withBaseline = applyOwnershipBaseline(withAction, event.baseline);
      return withRevision(withBaseline, revision, event.intentAt);
    }
    case "artifact_transfer_intent":
      assertTimestamp(event.intent.intentAt, "artifact_transfer_intent.intentAt");
      assertTimestampNotBefore(state.updatedAt, event.intent.intentAt, "artifact_transfer_intent.intentAt");
      return withRevision(applyArtifactTransferIntent(state, event.intent, revision), revision, event.intent.intentAt);
    case "artifact_transfer_receipt":
      assertTimestamp(event.receipt.observedAt, "artifact_transfer_receipt.observedAt");
      assertTimestampNotBefore(state.updatedAt, event.receipt.observedAt, "artifact_transfer_receipt.observedAt");
      return withRevision(applyArtifactTransferReceipt(state, event.receipt, revision), revision, event.receipt.observedAt);
    case "action_receipt":
      assertTimestamp(event.observedAt, "observedAt");
      assertTimestampNotBefore(state.updatedAt, event.observedAt, "observedAt");
      return withRevision(applyActionReceipt(state, event, revision), revision, event.observedAt);
    case "phase_changed":
      assertTimestamp(event.observedAt, "observedAt");
      assertTimestampNotBefore(state.updatedAt, event.observedAt, "observedAt");
      return withRevision(applyPhaseChange(state, event), revision, event.observedAt);
    case "blocker_observed":
      assertTimestamp(event.blocker.observedAt, "blocker.observedAt");
      assertTimestampNotBefore(state.updatedAt, event.blocker.observedAt, "blocker.observedAt");
      assertDigest(event.blocker.messageDigest, "blocker.messageDigest");
      validateBlockerObservation(event.blocker);
      return withRevision({ ...state, lastBlocker: event.blocker }, revision, event.blocker.observedAt);
    case "receipt_completed":
      assertTimestamp(event.observedAt, "observedAt");
      assertTimestampNotBefore(state.updatedAt, event.observedAt, "observedAt");
      return withRevision(applyCompletedReceipt(state, event.receipt, event.observedAt), revision, event.observedAt);
    case "content_availability_changed":
      assertTimestamp(event.observedAt, "observedAt");
      assertTimestampNotBefore(state.updatedAt, event.observedAt, "observedAt");
      if (typeof event.available !== "boolean") {
        throw new OperationStateError("invalid_content_availability", "Content availability must be boolean.");
      }
      if (state.receipt === undefined) {
        throw new OperationStateError("receipt_missing", "Content availability cannot change before a terminal receipt exists.");
      }
      if (state.phase !== "completed") {
        throw new OperationStateError("receipt_phase_invalid", "Content availability can change only on a completed operation.");
      }
      if (event.available || !state.receipt.contentAvailable) {
        throw new OperationStateError(
          "content_availability_not_monotonic",
          "Content availability may only transition once from available to unavailable."
        );
      }
      return withRevision({
        ...state,
        receipt: { ...state.receipt, contentAvailable: event.available }
      }, revision, event.observedAt);
    default: {
      const unknownEvent = event as { type?: unknown };
      throw new OperationStateError("unknown_operation_event", `Unknown operation event type: ${String(unknownEvent.type)}.`);
    }
  }
}

/**
 * Rejects unknown or request-only fields before an event can enter the durable
 * journal. TypeScript's structural types do not protect JavaScript callers at
 * runtime, so the privacy boundary must be closed explicitly.
 */
export function assertOperationEventShape(value: unknown): asserts value is OperationEventV1 {
  assertExactRecord(value, "operation event", ["type"], ["type"], true);
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "operation_created":
      assertExactRecord(event, "operation_created", ["type", "operationId", "requestDigest", "surface", "createdAt", "capturePolicy"], ["type", "operationId", "requestDigest", "surface", "createdAt"]);
      if (event.capturePolicy !== undefined) assertDurableCapturePolicyShape(event.capturePolicy);
      return;
    case "target_bound":
      assertExactRecord(event, "target_bound", ["type", "target", "observedAt"], ["type", "target", "observedAt"]);
      assertTargetShape(event.target);
      return;
    case "target_established":
      assertExactRecord(event, "target_established", ["type", "establishment"], ["type", "establishment"]);
      assertTargetEstablishmentShape(event.establishment);
      return;
    case "attachment_rearm_authorized":
      assertExactRecord(event, "attachment_rearm_authorized", ["type", "authorization", "target"], ["type", "authorization", "target"]);
      assertAttachmentRearmAuthorizationShape(event.authorization);
      assertTargetShape(event.target);
      return;
    case "attachment_rearm_intent":
      assertExactRecord(
        event,
        "attachment_rearm_intent",
        ["type", "authorizationId", "actionId", "preflightEvidenceDigest", "intentAt"],
        ["type", "authorizationId", "actionId", "preflightEvidenceDigest", "intentAt"]
      );
      return;
    case "ownership_baseline":
      assertExactRecord(event, "ownership_baseline", ["type", "baseline"], ["type", "baseline"]);
      assertOwnershipBaselineShape(event.baseline);
      return;
    case "submission_witness":
      assertExactRecord(event, "submission_witness", ["type", "witness"], ["type", "witness"]);
      assertSubmissionWitnessShape(event.witness);
      return;
    case "action_intent":
      assertExactRecord(event, "action_intent", ["type", "action", "intentAt"], ["type", "action", "intentAt"]);
      assertActionIntentShape(event.action);
      return;
    case "action_prepared":
      assertExactRecord(event, "action_prepared", ["type", "action", "intentAt", "baseline"], ["type", "action", "intentAt", "baseline"]);
      assertActionIntentShape(event.action);
      assertOwnershipBaselineShape(event.baseline);
      return;
    case "artifact_transfer_intent":
      assertExactRecord(event, "artifact_transfer_intent", ["type", "intent"], ["type", "intent"]);
      assertArtifactTransferIntentShape(event.intent);
      return;
    case "artifact_transfer_receipt":
      assertExactRecord(event, "artifact_transfer_receipt", ["type", "receipt"], ["type", "receipt"]);
      assertArtifactTransferReceiptShape(event.receipt);
      return;
    case "action_receipt":
      assertExactRecord(event, "action_receipt", ["type", "actionId", "outcome", "evidenceDigest", "blockerCode", "observedAt"], ["type", "actionId", "outcome", "observedAt"]);
      return;
    case "phase_changed":
      assertExactRecord(event, "phase_changed", ["type", "from", "to", "mutationBoundary", "causeActionId", "evidenceDigest", "observedAt"], ["type", "from", "to", "mutationBoundary", "observedAt"]);
      return;
    case "blocker_observed":
      assertExactRecord(event, "blocker_observed", ["type", "blocker"], ["type", "blocker"]);
      assertBlockerObservationShape(event.blocker);
      return;
    case "receipt_completed":
      assertExactRecord(event, "receipt_completed", ["type", "receipt", "observedAt"], ["type", "receipt", "observedAt"]);
      assertReceiptShape(event.receipt);
      return;
    case "content_availability_changed":
      assertExactRecord(event, "content_availability_changed", ["type", "available", "observedAt"], ["type", "available", "observedAt"]);
      return;
    default:
      throw new OperationStateError("unknown_operation_event", `Unknown operation event type: ${String(event.type)}.`);
  }
}

/** Validates the closed durable-state shape used by authenticated compaction. */
export function assertOperationStateShape(value: unknown): asserts value is OperationStateV1 {
  assertExactRecord(
    value,
    "operation state",
    ["schemaVersion", "operationId", "requestDigest", "surface", "phase", "mutationBoundary", "revision", "createdAt", "updatedAt", "capturePolicy", "responseFormat", "target", "attachmentRearm", "actions", "ownershipBaseline", "ownershipBaselines", "artifactTransfers", "submissionWitnesses", "submissionWitness", "lastBlocker", "receipt"],
    ["schemaVersion", "operationId", "requestDigest", "surface", "phase", "mutationBoundary", "revision", "createdAt", "updatedAt", "actions"]
  );
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== OPERATION_SCHEMA_VERSION) {
    throw new OperationStateError("unsupported_operation_state", "Operation state schemaVersion is unsupported.");
  }
  assertOperationId(state.operationId as string);
  assertDigest(state.requestDigest as string, "state.requestDigest");
  if (state.surface !== "chat" && state.surface !== "work") {
    throw new OperationStateError("invalid_operation_surface", "Operation state surface must be chat or work.");
  }
  if (!(typeof state.phase === "string" && state.phase in LEGAL_EDGES)) {
    throw new OperationStateError("invalid_operation_phase", "Operation state phase is unsupported.");
  }
  if (!(typeof state.mutationBoundary === "string" && state.mutationBoundary in BOUNDARY_RANK)) {
    throw new OperationStateError("invalid_mutation_boundary", "Operation state mutationBoundary is unsupported.");
  }
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 1) {
    throw new OperationStateError("invalid_operation_revision", "Operation state revision must be a positive safe integer.");
  }
  assertTimestamp(state.createdAt as string, "state.createdAt");
  assertTimestamp(state.updatedAt as string, "state.updatedAt");
  assertTimestampNotBefore(state.createdAt as string, state.updatedAt as string, "state.updatedAt");
  if (state.responseFormat !== undefined && state.responseFormat !== "markdown" && state.responseFormat !== "text") {
    throw new OperationStateError("invalid_response_format", "Operation responseFormat must be markdown or text.");
  }
  if (state.capturePolicy !== undefined) {
    assertDurableCapturePolicyShape(state.capturePolicy);
    if (state.responseFormat !== undefined && state.responseFormat !== state.capturePolicy.responseFormat) {
      throw new OperationStateError("capture_policy_format_mismatch", "Operation responseFormat conflicts with its durable capture policy.");
    }
  }
  if (state.target !== undefined) assertTargetShape(state.target);
  if (state.attachmentRearm !== undefined) assertAttachmentRearmShape(state.attachmentRearm);
  if (!isPlainRecord(state.actions)) {
    throw new OperationStateError("invalid_operation_state", "Operation state actions must be an object.");
  }
  for (const [actionId, action] of Object.entries(state.actions)) {
    assertOperationId(actionId, "action map key");
    assertActionRecordShape(action);
    if ((action as Record<string, unknown>).actionId !== actionId) {
      throw new OperationStateError("invalid_operation_state", "Operation action map key must match actionId.");
    }
    assertPersistedActionRecord(action as OperationActionRecordV1, state as unknown as OperationStateV1);
  }
  if (state.target !== undefined) validateTargetValues(state.target as NonNullable<OperationStateV1["target"]>);
  if (state.attachmentRearm !== undefined) {
    validateAttachmentRearmValues(
      state.attachmentRearm as OperationAttachmentRearmV1,
      state as unknown as OperationStateV1
    );
  }
  if (state.ownershipBaseline !== undefined) {
    assertOwnershipBaselineShape(state.ownershipBaseline);
    validateOwnershipBaselineValues(state.ownershipBaseline, state as unknown as OperationStateV1);
  }
  if (state.ownershipBaselines !== undefined) {
    if (!isPlainRecord(state.ownershipBaselines)) {
      throw new OperationStateError("invalid_operation_state", "Operation ownershipBaselines must be an object.");
    }
    for (const actionId of Object.keys(state.ownershipBaselines)) {
      const descriptor = Object.getOwnPropertyDescriptor(state.ownershipBaselines, actionId);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new OperationStateError("invalid_operation_shape", "Operation ownershipBaselines contains an unsafe property (accessor).");
      }
      const baseline = descriptor.value;
      assertOperationId(actionId, "ownershipBaselines map key");
      assertOwnershipBaselineShape(baseline);
      if (baseline.actionId !== actionId) {
        throw new OperationStateError("invalid_operation_state", "Ownership baseline map key must match actionId.");
      }
      validateOwnershipBaselineValues(baseline, state as unknown as OperationStateV1);
    }
  }
  if (state.artifactTransfers !== undefined) {
    assertArtifactTransfersStateShape(state.artifactTransfers);
    for (const [transferActionId, transfer] of Object.entries(state.artifactTransfers)) {
      validateArtifactTransferStateValues(transferActionId, transfer, state as unknown as OperationStateV1);
    }
  }
  validateSubmissionWitnessCollection(state as unknown as OperationStateV1);
  if (state.lastBlocker !== undefined) {
    assertBlockerObservationShape(state.lastBlocker);
    validateBlockerObservation(state.lastBlocker as NonNullable<OperationStateV1["lastBlocker"]>);
  }
  if (state.receipt !== undefined) {
    assertReceiptShape(state.receipt);
    validateReceiptValues(state.receipt as NonNullable<OperationStateV1["receipt"]>, state as unknown as OperationStateV1);
  }
  if (state.phase === "completed" && state.receipt === undefined) {
    throw new OperationStateError("receipt_missing", "Completed operation state requires a terminal receipt.");
  }
  if (state.phase !== "completed" && state.receipt !== undefined) {
    throw new OperationStateError("receipt_phase_invalid", "Only completed operation state may contain a terminal receipt.");
  }
  validateStateCoherence(state as unknown as OperationStateV1);
}

export function requiredRepeatPolicy(kind: OperationActionKind): OperationRepeatPolicy {
  return ACTION_POLICY[kind];
}

export function boundaryForAction(kind: OperationActionKind): MutationBoundary | undefined {
  if (kind === "file_handoff") return "handoff_may_have_occurred";
  if (kind === "send") return "send_may_have_occurred";
  if (kind === "work_steer" || kind === "stop") return "control_may_have_occurred";
  return undefined;
}

function assertPreparedActionBaselineIdentity(
  action: {
    actionId: string;
    kind: OperationActionKind;
    requestDigest: string;
    targetDigest?: string;
  },
  baseline: OperationOwnershipBaselineV1,
  state: OperationStateV1
): void {
  if (action.kind !== "send" && action.kind !== "work_steer") {
    throw new OperationStateError(
      "action_prepared_kind_invalid",
      "Atomic action preparation is supported only for send or work_steer."
    );
  }
  if (baseline.actionId !== action.actionId) {
    throw new OperationStateError(
      "action_prepared_action_mismatch",
      "Atomic action preparation baseline must name the prepared action."
    );
  }
  if (baseline.operationId !== state.operationId || baseline.requestDigest !== state.requestDigest) {
    throw new OperationStateError(
      "ownership_baseline_identity_mismatch",
      "Atomic action preparation baseline must use the parent operation identity."
    );
  }
  if (action.targetDigest === undefined || action.targetDigest !== baseline.targetBindingDigest) {
    throw new OperationStateError(
      "ownership_baseline_target_mismatch",
      "Atomic action preparation baseline must match the exact action target digest."
    );
  }
}

function applyActionIntent(
  state: OperationStateV1,
  action: {
    actionId: string;
    kind: OperationActionKind;
    repeatPolicy: OperationRepeatPolicy;
    requestDigest: string;
    parentActionId?: string;
    targetDigest?: string;
  },
  revision: number,
  intentAt: string
): OperationStateV1 {
  assertOperationId(action.actionId, "actionId");
  assertDigest(action.requestDigest, "action.requestDigest");
  if (action.kind !== "stop" && action.kind !== "work_steer" && action.requestDigest !== state.requestDigest) {
    throw new OperationStateError(
      "action_request_mismatch",
      "Only caller-owned control actions may carry a request digest distinct from the parent operation."
    );
  }
  if (!(action.kind in ACTION_POLICY)) {
    throw new OperationStateError("invalid_action_kind", `Unknown operation action kind: ${String(action.kind)}.`);
  }
  if (state.actions[action.actionId] !== undefined) {
    throw new OperationStateError("duplicate_action_intent", `Action ${action.actionId} already has an intent.`);
  }
  if (action.repeatPolicy !== requiredRepeatPolicy(action.kind)) {
    throw new OperationStateError(
      "invalid_repeat_policy",
      `Action ${action.kind} requires ${requiredRepeatPolicy(action.kind)}, received ${action.repeatPolicy}.`
    );
  }
  if (!ACTION_PHASES[action.kind].has(state.phase) && !isAttachmentRearmStagingAction(state, action)) {
    throw new OperationStateError(
      "action_phase_invalid",
      `Action ${action.kind} cannot begin while the operation is ${state.phase}.`
    );
  }
  if (action.kind !== "status_read" && state.target === undefined) {
    throw new OperationStateError("target_not_bound", `Action ${action.kind} requires a durable target binding.`);
  }
  if (action.parentActionId !== undefined && state.actions[action.parentActionId] === undefined) {
    throw new OperationStateError("unknown_parent_action", `Parent action ${action.parentActionId} is not recorded.`);
  }
  if (action.parentActionId !== undefined) assertOperationId(action.parentActionId, "parentActionId");
  if (action.kind !== "status_read" && action.targetDigest === undefined) {
    throw new OperationStateError("action_target_missing", `Action ${action.kind} requires the exact target binding digest.`);
  }
  if (action.targetDigest !== undefined) assertDigest(action.targetDigest, "action.targetDigest");
  if (
    isSingleIntentKind(action.kind) &&
    Object.values(state.actions).some(existing => existing.kind === action.kind)
  ) {
    throw new OperationStateError(
      "nonrepeatable_action_already_intended",
      `Operation already contains a non-repeatable ${action.kind} intent.`
    );
  }
  const record: OperationActionRecordV1 = {
    ...action,
    intentRevision: revision,
    intentAt
  };
  const actionBoundary = boundaryForAction(action.kind);
  const mutationBoundary = actionBoundary !== undefined && BOUNDARY_RANK[actionBoundary] > BOUNDARY_RANK[state.mutationBoundary]
    ? actionBoundary
    : state.mutationBoundary;
  return { ...state, mutationBoundary, actions: { ...state.actions, [action.actionId]: record } };
}

function isAttachmentRearmStagingAction(
  state: OperationStateV1,
  action: { kind: OperationActionKind; targetDigest?: string }
): boolean {
  if (state.phase !== "uncertain" || state.mutationBoundary !== "handoff_may_have_occurred") return false;
  const rearm = state.attachmentRearm;
  if (rearm === undefined || rearm.attemptIntentRevision !== undefined) return false;
  if (action.targetDigest !== rearm.targetBindingDigest) return false;
  return action.kind === "configuration_set"
    || action.kind === "tool_set"
    || action.kind === "composer_set"
    || action.kind === "power_select";
}

function applyActionReceipt(
  state: OperationStateV1,
  event: Extract<OperationEventV1, { type: "action_receipt" }>,
  revision: number
): OperationStateV1 {
  const action = state.actions[event.actionId];
  if (action === undefined) {
    throw new OperationStateError("action_intent_missing", `Action ${event.actionId} has no durable intent.`);
  }
  if (action.outcome !== undefined) {
    throw new OperationStateError("duplicate_action_receipt", `Action ${event.actionId} already has a receipt.`);
  }
  if (event.outcome !== "satisfied" && event.outcome !== "not_satisfied" && event.outcome !== "uncertain") {
    throw new OperationStateError("invalid_action_outcome", `Unknown action outcome: ${String(event.outcome)}.`);
  }
  assertTimestampNotBefore(action.intentAt, event.observedAt, "action receipt observedAt");
  if (event.outcome === "satisfied" && event.evidenceDigest === undefined) {
    throw new OperationStateError("action_evidence_missing", `Satisfied action ${event.actionId} requires evidenceDigest.`);
  }
  if (event.evidenceDigest !== undefined) assertDigest(event.evidenceDigest, "action.evidenceDigest");
  if (event.blockerCode !== undefined && !CODE_PATTERN.test(event.blockerCode)) {
    throw new OperationStateError("invalid_blocker_code", "Action blockerCode must be a bounded canonical code.");
  }
  const updated: OperationActionRecordV1 = {
    ...action,
    outcome: event.outcome,
    receiptRevision: revision,
    receiptAt: event.observedAt
  };
  if (event.evidenceDigest !== undefined) updated.evidenceDigest = event.evidenceDigest;
  if (event.blockerCode !== undefined) updated.blockerCode = event.blockerCode;
  return { ...state, actions: { ...state.actions, [event.actionId]: updated } };
}

function applySubmissionWitness(
  state: OperationStateV1,
  witness: OperationSubmissionWitnessV1
): OperationStateV1 {
  // A legacy snapshot may contain only the original Send projection.  When a
  // new Work steer witness is appended, materialize that legacy entry into the
  // keyed collection so the collection remains a complete causal ledger.
  const existingWitnesses = state.submissionWitnesses === undefined
    ? state.submissionWitness === undefined
      ? {}
      : { [state.submissionWitness.actionId]: state.submissionWitness }
    : state.submissionWitnesses;
  assertSubmissionWitnessesMapShape(existingWitnesses);
  validateSubmissionWitnessCollection({ ...state, submissionWitnesses: existingWitnesses });

  const existing = existingWitnesses[witness.actionId];
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(witness)) {
      throw new OperationStateError(
        "submission_witness_conflict",
        `Submission witness for action ${witness.actionId} conflicts with the durable record.`
      );
    }
    // Same-action replay is an idempotent confirmation.  The journal revision
    // still advances in the caller, but no semantic projection changes.
    return state.submissionWitnesses === undefined
      ? { ...state, submissionWitnesses: existingWitnesses }
      : state;
  }
  if (Object.keys(existingWitnesses).length >= MAX_SUBMISSION_WITNESSES) {
    throw new OperationStateError(
      "submission_witness_limit",
      `An operation may record at most ${MAX_SUBMISSION_WITNESSES} submission witnesses.`
    );
  }

  const candidateState: OperationStateV1 = {
    ...state,
    submissionWitnesses: { ...existingWitnesses, [witness.actionId]: witness }
  };
  validateSubmissionWitnessValues(witness, candidateState);
  if (witness.actionKind === "send") {
    if (state.submissionWitness !== undefined && canonicalJson(state.submissionWitness) !== canonicalJson(witness)) {
      throw new OperationStateError(
        "submission_witness_projection_mismatch",
        "The original Send submission witness must match its legacy projection exactly."
      );
    }
    return { ...candidateState, submissionWitness: witness };
  }
  return candidateState;
}

function applyOwnershipBaseline(
  state: OperationStateV1,
  baseline: OperationOwnershipBaselineV1
): OperationStateV1 {
  validateOwnershipBaselineValues(baseline, state);
  const existing = state.ownershipBaselines?.[baseline.actionId];
  if (existing !== undefined) {
    throw new OperationStateError(
      "ownership_baseline_duplicate",
      `An operation may record only one immutable ownership baseline for action ${baseline.actionId}.`
    );
  }
  const action = state.actions[baseline.actionId];
  if (action?.kind === "send" && state.ownershipBaseline !== undefined) {
    throw new OperationStateError(
      "ownership_baseline_duplicate",
      "An operation may record only one immutable pre-Send ownership baseline."
    );
  }
  const ownershipBaselines = {
    ...(state.ownershipBaselines ?? {}),
    [baseline.actionId]: baseline
  };
  return {
    ...state,
    ownershipBaselines,
    ...(action?.kind === "send" && state.ownershipBaseline === undefined
      ? { ownershipBaseline: baseline }
      : {})
  };
}

function applyArtifactTransferIntent(
  state: OperationStateV1,
  intent: OperationArtifactTransferIntentV1,
  revision: number
): OperationStateV1 {
  if (state.capturePolicy?.artifacts !== "transfer") {
    throw new OperationStateError(
      "artifact_transfer_policy_mismatch",
      "Artifact transfer intent requires the immutable transfer capture policy."
    );
  }
  if (state.phase !== "capturing") {
    throw new OperationStateError("artifact_transfer_phase_invalid", "Artifact transfer intent requires a capturing operation.");
  }
  validateArtifactTransferIntentValues(intent, state);
  const transfers = state.artifactTransfers ?? {};
  assertArtifactTransfersStateShape(transfers);
  if (transfers[intent.transferActionId] !== undefined) {
    throw new OperationStateError("artifact_transfer_intent_duplicate", "Artifact transfer intent is already durable.");
  }
  const tuple = artifactTransferTuple(intent);
  for (const transfer of Object.values(transfers)) {
    if (transfer.intent !== undefined && artifactTransferTuple(transfer.intent) === tuple) {
      throw new OperationStateError("artifact_transfer_duplicate_tuple", "An artifact transfer tuple may only be transferred once.");
    }
  }
  const action: OperationActionRecordV1 = {
    actionId: intent.transferActionId,
    kind: "local_output_commit",
    repeatPolicy: "reconcile_local_effect",
    requestDigest: intent.requestDigest,
    targetDigest: intent.targetBindingDigest,
    intentRevision: revision,
    intentAt: intent.intentAt
  };
  const withAction = applyActionIntent(state, action, revision, intent.intentAt);
  return {
    ...withAction,
    artifactTransfers: {
      ...transfers,
      [intent.transferActionId]: { intent }
    }
  };
}

function applyArtifactTransferReceipt(
  state: OperationStateV1,
  receipt: OperationArtifactTransferReceiptV1,
  revision: number
): OperationStateV1 {
  if (state.phase !== "capturing") {
    throw new OperationStateError("artifact_transfer_phase_invalid", "Artifact transfer receipt requires a capturing operation.");
  }
  const transfers = state.artifactTransfers ?? {};
  assertArtifactTransfersStateShape(transfers);
  const transfer = transfers[receipt.transferActionId];
  if (transfer?.intent === undefined) {
    throw new OperationStateError("artifact_transfer_intent_missing", "Artifact transfer receipt requires its durable intent.");
  }
  if (transfer.receipt !== undefined) {
    throw new OperationStateError("artifact_transfer_receipt_duplicate", "Artifact transfer receipt is already durable.");
  }
  validateArtifactTransferReceiptValues(receipt, transfer.intent, state);
  if (receipt.observedAt < transfer.intent.intentAt) {
    throw new OperationStateError("artifact_transfer_timestamp_regression", "Artifact transfer receipt cannot precede its intent.");
  }
  const outcome: OperationActionOutcome = receipt.status === "transferred"
    ? "satisfied"
    : receipt.status === "blocked" && receipt.blockerCode === "output_collision"
      ? "not_satisfied"
      : "uncertain";
  const actionEvent: Extract<OperationEventV1, { type: "action_receipt" }> = {
    type: "action_receipt",
    actionId: receipt.transferActionId,
    outcome,
    observedAt: receipt.observedAt,
    ...(receipt.status === "transferred" ? { evidenceDigest: receipt.destinationIdentityDigest } : {}),
    ...(receipt.blockerCode === undefined ? {} : { blockerCode: receipt.blockerCode })
  };
  const withAction = applyActionReceipt(state, actionEvent, revision);
  return {
    ...withAction,
    artifactTransfers: {
      ...transfers,
      [receipt.transferActionId]: { intent: transfer.intent, receipt }
    }
  };
}

function validateArtifactTransferIdentityValues(
  value: Pick<OperationArtifactTransferIntentV1, "operationId" | "requestDigest" | "targetBindingDigest" | "assistantTurnId" | "sourceIdentityDigest" | "kind" | "ordinal" | "transferActionId" | "destinationIdentityDigest">,
  state: OperationStateV1
): void {
  if (value.operationId !== state.operationId || value.requestDigest !== state.requestDigest) {
    throw new OperationStateError("artifact_transfer_identity_mismatch", "Artifact transfer operation identity does not match state.");
  }
  if (state.target === undefined) {
    throw new OperationStateError("target_not_bound", "Artifact transfer requires a durable target binding.");
  }
  const originalSend = Object.values(state.actions).find(action => action.kind === "send");
  if (originalSend?.targetDigest !== value.targetBindingDigest) {
    throw new OperationStateError(
      "artifact_transfer_target_mismatch",
      "Artifact transfer targetBindingDigest must match the durable original Send target."
    );
  }
  assertDigest(value.targetBindingDigest, "artifactTransfer.targetBindingDigest");
  assertStableIdentifier(value.assistantTurnId, "artifactTransfer.assistantTurnId");
  assertDigest(value.sourceIdentityDigest, "artifactTransfer.sourceIdentityDigest");
  if (value.kind !== "file" && value.kind !== "image" && value.kind !== "other") {
    throw new OperationStateError("artifact_transfer_kind_invalid", "Artifact transfer kind is unsupported.");
  }
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0) {
    throw new OperationStateError("artifact_transfer_ordinal_invalid", "Artifact transfer ordinal must be a non-negative safe integer.");
  }
  assertOperationId(value.transferActionId, "artifactTransfer.transferActionId");
  assertDigest(value.destinationIdentityDigest, "artifactTransfer.destinationIdentityDigest");
}

function validateArtifactTransferIntentValues(
  intent: OperationArtifactTransferIntentV1,
  state: OperationStateV1
): void {
  if (intent.schemaVersion !== OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION) {
    throw new OperationStateError("artifact_transfer_intent_schema_invalid", "Artifact transfer intent schemaVersion is unsupported.");
  }
  if (intent.actionKind !== "local_output_commit" || intent.repeatPolicy !== "reconcile_local_effect") {
    throw new OperationStateError("artifact_transfer_action_policy_invalid", "Artifact transfer intent action policy is unsupported.");
  }
  assertTimestamp(intent.intentAt, "artifactTransfer.intentAt");
  validateArtifactTransferIdentityValues(intent, state);
}

function validateArtifactTransferReceiptValues(
  receipt: OperationArtifactTransferReceiptV1,
  intent: OperationArtifactTransferIntentV1,
  state: OperationStateV1
): void {
  if (receipt.schemaVersion !== OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION) {
    throw new OperationStateError("artifact_transfer_receipt_schema_invalid", "Artifact transfer receipt schemaVersion is unsupported.");
  }
  validateArtifactTransferIdentityValues(receipt, state);
  if (
    receipt.operationId !== intent.operationId
    || receipt.requestDigest !== intent.requestDigest
    || receipt.targetBindingDigest !== intent.targetBindingDigest
    || receipt.assistantTurnId !== intent.assistantTurnId
    || receipt.sourceIdentityDigest !== intent.sourceIdentityDigest
    || receipt.kind !== intent.kind
    || receipt.ordinal !== intent.ordinal
    || receipt.transferActionId !== intent.transferActionId
    || receipt.destinationIdentityDigest !== intent.destinationIdentityDigest
  ) {
    throw new OperationStateError("artifact_transfer_identity_mismatch", "Artifact transfer receipt identity does not match its intent.");
  }
  if (receipt.outputKey !== undefined && (typeof receipt.outputKey !== "string" || !TRANSFER_OUTPUT_KEY_PATTERN.test(receipt.outputKey))) {
    throw new OperationStateError("artifact_transfer_output_key_invalid", "Artifact transfer outputKey is unsupported.");
  }
  if (receipt.bytes !== undefined && (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0)) {
    throw new OperationStateError("artifact_transfer_bytes_invalid", "Artifact transfer bytes must be a non-negative safe integer.");
  }
  if (receipt.sha256 !== undefined && (typeof receipt.sha256 !== "string" || !SHA256_PATTERN.test(receipt.sha256))) {
    throw new OperationStateError("artifact_transfer_sha256_invalid", "Artifact transfer sha256 must be lowercase hexadecimal.");
  }
  if (receipt.blockerCode !== undefined && (typeof receipt.blockerCode !== "string" || !CODE_PATTERN.test(receipt.blockerCode))) {
    throw new OperationStateError("artifact_transfer_blocker_invalid", "Artifact transfer blockerCode is unsupported.");
  }
  if (receipt.status !== "transferred" && receipt.status !== "partial" && receipt.status !== "blocked") {
    throw new OperationStateError("artifact_transfer_status_invalid", "Artifact transfer status is unsupported.");
  }
  if (receipt.status === "transferred" && (
    receipt.outputKey === undefined || receipt.bytes === undefined || receipt.sha256 === undefined || receipt.blockerCode !== undefined
  )) {
    throw new OperationStateError("artifact_transfer_receipt_incomplete", "Transferred artifact receipts require outputKey, bytes, and sha256 without a blocker.");
  }
  if (receipt.status !== "transferred" && receipt.blockerCode === undefined) {
    throw new OperationStateError("artifact_transfer_blocker_missing", "Partial or blocked artifact receipts require blockerCode.");
  }
}

function artifactTransferTuple(intent: OperationArtifactTransferIntentV1): string {
  return canonicalJson({
    operationId: intent.operationId,
    requestDigest: intent.requestDigest,
    targetBindingDigest: intent.targetBindingDigest,
    assistantTurnId: intent.assistantTurnId,
    sourceIdentityDigest: intent.sourceIdentityDigest,
    kind: intent.kind,
    ordinal: intent.ordinal,
    destinationIdentityDigest: intent.destinationIdentityDigest
  });
}

function assertArtifactTransferIntentShape(value: unknown): asserts value is OperationArtifactTransferIntentV1 {
  assertExactRecord(
    value,
    "artifact transfer intent",
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "transferActionId", "destinationIdentityDigest", "actionKind", "repeatPolicy", "intentAt"],
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "transferActionId", "destinationIdentityDigest", "actionKind", "repeatPolicy", "intentAt"]
  );
  if (value.schemaVersion !== OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION) throw new OperationStateError("artifact_transfer_intent_schema_invalid", "Artifact transfer intent schemaVersion is unsupported.");
  assertOperationId(value.operationId as string, "artifactTransfer.operationId");
  assertDigest(value.requestDigest as string, "artifactTransfer.requestDigest");
  assertDigest(value.targetBindingDigest as string, "artifactTransfer.targetBindingDigest");
  assertStableIdentifier(value.assistantTurnId, "artifactTransfer.assistantTurnId");
  assertDigest(value.sourceIdentityDigest as string, "artifactTransfer.sourceIdentityDigest");
  if (value.kind !== "file" && value.kind !== "image" && value.kind !== "other") throw new OperationStateError("artifact_transfer_kind_invalid", "Artifact transfer kind is unsupported.");
  if (!Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0) throw new OperationStateError("artifact_transfer_ordinal_invalid", "Artifact transfer ordinal must be non-negative.");
  assertOperationId(value.transferActionId as string, "artifactTransfer.transferActionId");
  assertDigest(value.destinationIdentityDigest as string, "artifactTransfer.destinationIdentityDigest");
  if (value.actionKind !== "local_output_commit" || value.repeatPolicy !== "reconcile_local_effect") throw new OperationStateError("artifact_transfer_action_policy_invalid", "Artifact transfer intent action policy is unsupported.");
  assertTimestamp(value.intentAt as string, "artifactTransfer.intentAt");
}

function assertArtifactTransferReceiptShape(value: unknown): asserts value is OperationArtifactTransferReceiptV1 {
  assertExactRecord(
    value,
    "artifact transfer receipt",
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "transferActionId", "destinationIdentityDigest", "outputKey", "bytes", "sha256", "status", "blockerCode", "observedAt"],
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "transferActionId", "destinationIdentityDigest", "status", "observedAt"]
  );
  if (value.schemaVersion !== OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION) throw new OperationStateError("artifact_transfer_receipt_schema_invalid", "Artifact transfer receipt schemaVersion is unsupported.");
  assertOperationId(value.operationId as string, "artifactTransfer.operationId");
  assertDigest(value.requestDigest as string, "artifactTransfer.requestDigest");
  assertDigest(value.targetBindingDigest as string, "artifactTransfer.targetBindingDigest");
  assertStableIdentifier(value.assistantTurnId, "artifactTransfer.assistantTurnId");
  assertDigest(value.sourceIdentityDigest as string, "artifactTransfer.sourceIdentityDigest");
  if (value.kind !== "file" && value.kind !== "image" && value.kind !== "other") throw new OperationStateError("artifact_transfer_kind_invalid", "Artifact transfer kind is unsupported.");
  if (!Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0) throw new OperationStateError("artifact_transfer_ordinal_invalid", "Artifact transfer ordinal must be non-negative.");
  assertOperationId(value.transferActionId as string, "artifactTransfer.transferActionId");
  assertDigest(value.destinationIdentityDigest as string, "artifactTransfer.destinationIdentityDigest");
  if (value.outputKey !== undefined && (typeof value.outputKey !== "string" || !TRANSFER_OUTPUT_KEY_PATTERN.test(value.outputKey))) throw new OperationStateError("artifact_transfer_output_key_invalid", "Artifact transfer outputKey is unsupported.");
  if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0)) throw new OperationStateError("artifact_transfer_bytes_invalid", "Artifact transfer bytes must be non-negative.");
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256))) throw new OperationStateError("artifact_transfer_sha256_invalid", "Artifact transfer sha256 is unsupported.");
  if (value.status !== "transferred" && value.status !== "partial" && value.status !== "blocked") throw new OperationStateError("artifact_transfer_status_invalid", "Artifact transfer status is unsupported.");
  if (value.blockerCode !== undefined && (typeof value.blockerCode !== "string" || !CODE_PATTERN.test(value.blockerCode))) throw new OperationStateError("artifact_transfer_blocker_invalid", "Artifact transfer blockerCode is unsupported.");
  assertTimestamp(value.observedAt as string, "artifactTransfer.observedAt");
  if (value.status === "transferred" && (value.outputKey === undefined || value.bytes === undefined || value.sha256 === undefined || value.blockerCode !== undefined)) throw new OperationStateError("artifact_transfer_receipt_incomplete", "Transferred artifact receipts require outputKey, bytes, and sha256 without a blocker.");
  if (value.status !== "transferred" && value.blockerCode === undefined) throw new OperationStateError("artifact_transfer_blocker_missing", "Partial or blocked artifact receipts require blockerCode.");
}

function assertArtifactTransfersStateShape(value: unknown): asserts value is Record<string, OperationArtifactTransferStateV1> {
  if (!isPlainRecord(value)) throw new OperationStateError("invalid_operation_state", "Operation artifactTransfers must be an object.");
  for (const transferActionId of Object.keys(value)) {
    assertOperationId(transferActionId, "artifactTransfers map key");
    const descriptor = Object.getOwnPropertyDescriptor(value, transferActionId);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.get !== undefined || descriptor.set !== undefined) throw new OperationStateError("invalid_operation_shape", "Operation artifactTransfers contains an unsafe property (accessor).");
    const transfer = descriptor.value;
    assertExactRecord(transfer, "artifact transfer state", ["intent", "receipt"], ["intent"]);
    assertArtifactTransferIntentShape(transfer.intent);
    if (transfer.receipt !== undefined) assertArtifactTransferReceiptShape(transfer.receipt);
  }
}

function validateArtifactTransferStateValues(
  transferActionId: string,
  transfer: OperationArtifactTransferStateV1,
  state: OperationStateV1
): void {
  if (transfer.intent === undefined || transfer.intent.transferActionId !== transferActionId) {
    throw new OperationStateError("artifact_transfer_map_mismatch", "Artifact transfer map key must match its intent transferActionId.");
  }
  validateArtifactTransferIntentValues(transfer.intent, state);
  const action = state.actions[transferActionId];
  if (
    action === undefined
    || action.kind !== "local_output_commit"
    || action.repeatPolicy !== "reconcile_local_effect"
    || action.requestDigest !== transfer.intent.requestDigest
    || action.targetDigest !== transfer.intent.targetBindingDigest
    || action.intentAt !== transfer.intent.intentAt
  ) {
    throw new OperationStateError("artifact_transfer_action_mismatch", "Artifact transfer intent must match its generic local-output action.");
  }
  if (transfer.receipt === undefined) {
    if (action.outcome !== undefined) throw new OperationStateError("artifact_transfer_action_mismatch", "Unreceipted artifact transfer cannot have a settled generic action.");
    return;
  }
  validateArtifactTransferReceiptValues(transfer.receipt, transfer.intent, state);
  if (transfer.receipt.observedAt < transfer.intent.intentAt) throw new OperationStateError("artifact_transfer_timestamp_regression", "Artifact transfer receipt cannot precede its intent.");
  const expectedOutcome: OperationActionOutcome = transfer.receipt.status === "transferred"
    ? "satisfied"
    : transfer.receipt.status === "blocked" && transfer.receipt.blockerCode === "output_collision"
      ? "not_satisfied"
      : "uncertain";
  if (action.outcome !== expectedOutcome || action.receiptAt !== transfer.receipt.observedAt) throw new OperationStateError("artifact_transfer_action_mismatch", "Artifact transfer receipt must match its generic action receipt.");
  if (expectedOutcome === "satisfied" && action.evidenceDigest !== transfer.receipt.destinationIdentityDigest) throw new OperationStateError("artifact_transfer_action_mismatch", "Transferred artifact receipt evidence must match destination identity.");
  if (expectedOutcome !== "satisfied" && action.blockerCode !== transfer.receipt.blockerCode) throw new OperationStateError("artifact_transfer_action_mismatch", "Artifact transfer blocker must match its generic action receipt.");
}

function applyPhaseChange(
  state: OperationStateV1,
  event: Extract<OperationEventV1, { type: "phase_changed" }>
): OperationStateV1 {
  if (!(event.from in LEGAL_EDGES) || !(event.to in LEGAL_EDGES)) {
    throw new OperationStateError("invalid_operation_phase", "Phase transition contains an unknown phase.");
  }
  if (!(event.mutationBoundary in BOUNDARY_RANK)) {
    throw new OperationStateError("invalid_mutation_boundary", "Phase transition contains an unknown mutation boundary.");
  }
  if (event.evidenceDigest !== undefined) assertDigest(event.evidenceDigest, "phase.evidenceDigest");
  if (state.target === undefined && event.to !== "uncertain") {
    throw new OperationStateError("target_not_bound", `Transition to ${event.to} requires a durable target binding.`);
  }
  if (
    state.target?.targetLifecycle === "new_pending"
    && (event.to === "submitted" || event.to === "generating" || event.to === "capturing" || event.to === "completed")
  ) {
    throw new OperationStateError(
      "new_target_not_established",
      "A pending new target must be established from post-Send evidence before submission can be reported."
    );
  }
  if (event.from !== state.phase) {
    throw new OperationStateError("phase_mismatch", `Phase event expected ${event.from}, current phase is ${state.phase}.`);
  }
  if (!LEGAL_EDGES[state.phase].has(event.to)) {
    throw new OperationStateError("illegal_phase_transition", `Illegal operation transition ${state.phase} -> ${event.to}.`);
  }
  if (event.mutationBoundary !== state.mutationBoundary) {
    throw new OperationStateError(
      "mutation_boundary_mismatch",
      `Phase transition must preserve the durable mutation boundary ${state.mutationBoundary}.`
    );
  }

  const cause = event.causeActionId === undefined ? undefined : state.actions[event.causeActionId];
  if (event.causeActionId !== undefined && cause === undefined) {
    throw new OperationStateError("transition_cause_missing", `Transition cause ${event.causeActionId} is not recorded.`);
  }
  assertCausalTransition(state, event.to, event.mutationBoundary, cause, event.evidenceDigest);
  return { ...state, phase: event.to, mutationBoundary: event.mutationBoundary };
}

function assertCausalTransition(
  state: OperationStateV1,
  to: OperationPhase,
  boundary: MutationBoundary,
  cause: OperationActionRecordV1 | undefined,
  evidenceDigest: string | undefined
): void {
  if (state.phase === "uncertain") {
    if (cause === undefined || cause.outcome !== "satisfied") {
      throw new OperationStateError("uncertain_recovery_unproven", "Recovery from uncertain requires a satisfied causal action receipt.");
    }
    if (to === "ready") requireCause(cause, "file_handoff", "satisfied");
    if (to === "generating" || to === "capturing") requireCause(cause, "send", "satisfied");
    requireEvidence(evidenceDigest ?? cause.evidenceDigest);
  }
  if (to === "handoff_pending") {
    requireUnreceiptedCause(cause, "file_handoff");
    requireBoundary(boundary, "handoff_may_have_occurred");
    return;
  }
  if (to === "send_pending") {
    requireUnreceiptedCause(cause, "send");
    requireBoundary(boundary, "send_may_have_occurred");
    return;
  }
  if (to === "submitted") {
    if (cause?.kind !== "send") {
      throw new OperationStateError("invalid_transition_cause", "submitted requires the causal original Send action.");
    }
    requireSatisfiedCause(cause, evidenceDigest);
    requireDurableOriginalSendOwnership(state);
    return;
  }
  if (to === "ready" && state.phase === "prepared") {
    requireEvidence(evidenceDigest);
    return;
  }
  if (to === "ready" && state.phase === "handoff_pending") {
    requireCause(cause, "file_handoff", "satisfied");
    requireEvidence(evidenceDigest);
    return;
  }
  if (to === "generating" || to === "capturing" || to === "completed") {
    requireEvidence(evidenceDigest);
    requireDurableOriginalSendOwnership(state);
  }
}

function applyCompletedReceipt(
  state: OperationStateV1,
  receipt: OperationStateV1["receipt"] & {},
  observedAt: string
): OperationStateV1 {
  if (state.phase !== "capturing" && state.phase !== "uncertain") {
    throw new OperationStateError("receipt_phase_invalid", "Terminal receipt can only be persisted while capturing or after ownership recovery.");
  }
  if (receipt.operationId !== state.operationId || receipt.requestDigest !== state.requestDigest) {
    throw new OperationStateError("receipt_identity_mismatch", "Terminal receipt does not match the operation identity.");
  }
  if (state.receipt !== undefined) {
    throw new OperationStateError("duplicate_terminal_receipt", "Operation already has a terminal receipt.");
  }
  if (state.target === undefined) {
    throw new OperationStateError("target_not_bound", "Terminal receipt requires a durable target binding.");
  }
  if (state.target.targetLifecycle === "new_pending") {
    throw new OperationStateError("new_target_not_established", "Terminal receipt requires an established new-target identity.");
  }
  requireDurableOriginalSendOwnership(state);
  validateReceiptValues(receipt, state);
  assertTimestampNotBefore(receipt.completedAt, observedAt, "receipt observedAt");
  return { ...state, phase: "completed", receipt };
}

function assertPersistedActionRecord(action: OperationActionRecordV1, state: OperationStateV1): void {
  assertOperationId(action.actionId, "actionId");
  if (!(action.kind in ACTION_POLICY) || action.repeatPolicy !== requiredRepeatPolicy(action.kind)) {
    throw new OperationStateError("invalid_repeat_policy", "Persisted action kind and repeat policy are inconsistent.");
  }
  assertDigest(action.requestDigest, "action.requestDigest");
  if (action.kind !== "stop" && action.kind !== "work_steer" && action.requestDigest !== state.requestDigest) {
    throw new OperationStateError(
      "action_request_mismatch",
      "Only caller-owned control actions may carry a request digest distinct from the parent operation."
    );
  }
  if (action.parentActionId !== undefined) {
    assertOperationId(action.parentActionId, "action.parentActionId");
    if (state.actions[action.parentActionId] === undefined) {
      throw new OperationStateError("unknown_parent_action", "Persisted action parent is not present in the operation ledger.");
    }
  }
  if (action.targetDigest !== undefined) assertDigest(action.targetDigest, "action.targetDigest");
  if (action.kind !== "status_read" && (state.target === undefined || action.targetDigest === undefined)) {
    throw new OperationStateError("action_target_missing", "Persisted mutating or target-bound action requires a durable target digest.");
  }
  if (!Number.isSafeInteger(action.intentRevision) || action.intentRevision < 1 || action.intentRevision > state.revision) {
    throw new OperationStateError("invalid_action_revision", "Action intent revision is outside the durable state revision.");
  }
  assertTimestamp(action.intentAt, "action.intentAt");
  assertTimestampNotBefore(action.intentAt, state.updatedAt, "state.updatedAt");

  if (action.outcome === undefined) {
    if (action.receiptRevision !== undefined || action.receiptAt !== undefined || action.evidenceDigest !== undefined || action.blockerCode !== undefined) {
      throw new OperationStateError("action_receipt_incomplete", "Unsettled action cannot contain receipt-only fields.");
    }
    return;
  }
  if (action.outcome !== "satisfied" && action.outcome !== "not_satisfied" && action.outcome !== "uncertain") {
    throw new OperationStateError("invalid_action_outcome", "Persisted action outcome is unsupported.");
  }
  if (
    !Number.isSafeInteger(action.receiptRevision)
    || action.receiptRevision! <= action.intentRevision
    || action.receiptRevision! > state.revision
    || action.receiptAt === undefined
  ) {
    throw new OperationStateError("action_receipt_incomplete", "Settled action requires a later bounded receipt revision and timestamp.");
  }
  assertTimestamp(action.receiptAt, "action.receiptAt");
  assertTimestampNotBefore(action.intentAt, action.receiptAt, "action.receiptAt");
  assertTimestampNotBefore(action.receiptAt, state.updatedAt, "state.updatedAt");
  if (action.evidenceDigest !== undefined) assertDigest(action.evidenceDigest, "action.evidenceDigest");
  if (action.outcome === "satisfied" && action.evidenceDigest === undefined) {
    throw new OperationStateError("action_evidence_missing", "Satisfied action requires durable evidence.");
  }
  if (action.blockerCode !== undefined && !CODE_PATTERN.test(action.blockerCode)) {
    throw new OperationStateError("invalid_blocker_code", "Action blockerCode must be a bounded canonical code.");
  }
}

function validateBlockerObservation(blocker: NonNullable<OperationStateV1["lastBlocker"]>): void {
  if (!CODE_PATTERN.test(blocker.code)) {
    throw new OperationStateError("invalid_blocker_code", "Blocker code must be a bounded canonical code.");
  }
  assertDigest(blocker.messageDigest, "blocker.messageDigest");
  if (typeof blocker.recoverable !== "boolean") {
    throw new OperationStateError("invalid_blocker_recoverability", "Blocker recoverable must be boolean.");
  }
  assertTimestamp(blocker.observedAt, "blocker.observedAt");
}

function validateReceiptValues(receipt: NonNullable<OperationStateV1["receipt"]>, state: OperationStateV1): void {
  if (receipt.schemaVersion !== OPERATION_RECEIPT_SCHEMA_VERSION) {
    throw new OperationStateError("unsupported_operation_receipt", "Terminal receipt schemaVersion is unsupported.");
  }
  if (
    state.capturePolicy !== undefined
    && receipt.responseFormat !== state.capturePolicy.responseFormat
  ) {
    throw new OperationStateError("receipt_capture_policy_mismatch", "Terminal receipt format does not match the immutable capture policy.");
  }
  assertOperationId(receipt.operationId);
  if (receipt.operationId !== state.operationId || receipt.requestDigest !== state.requestDigest) {
    throw new OperationStateError("receipt_identity_mismatch", "Terminal receipt does not match the operation identity.");
  }
  assertDigest(receipt.requestDigest, "receipt.requestDigest");
  assertDigest(receipt.targetBindingDigest, "receipt.targetBindingDigest");
  assertDigest(receipt.userTurnEvidenceDigest, "receipt.userTurnEvidenceDigest");
  assertDigest(receipt.ownershipEvidenceDigest, "receipt.ownershipEvidenceDigest");
  assertStableIdentifier(receipt.userTurnId, "receipt.userTurnId");
  assertStableIdentifier(receipt.assistantTurnId, "receipt.assistantTurnId");
  if (!FINISH_REASON_PATTERN.test(receipt.finishReason)) {
    throw new OperationStateError("receipt_finish_reason_invalid", "Terminal receipt finishReason must be a bounded canonical value.");
  }
  if (typeof receipt.contentAvailable !== "boolean") {
    throw new OperationStateError("receipt_content_availability_invalid", "Terminal receipt contentAvailable must be boolean.");
  }
  const hasResponseDigest = receipt.responseDigest !== undefined;
  const hasResponseBytes = receipt.responseBytes !== undefined;
  if (hasResponseDigest !== hasResponseBytes || (receipt.contentAvailable && !hasResponseDigest)) {
    throw new OperationStateError("receipt_response_metadata_incomplete", "Response digest and byte count must be paired and present when content is available.");
  }
  if (receipt.responseDigest !== undefined) assertDigest(receipt.responseDigest, "receipt.responseDigest");
  if (receipt.responseBytes !== undefined && (!Number.isSafeInteger(receipt.responseBytes) || receipt.responseBytes < 0)) {
    throw new OperationStateError("receipt_response_bytes_invalid", "Terminal receipt responseBytes must be a non-negative safe integer.");
  }
  assertTimestamp(receipt.completedAt, "receipt.completedAt");
  assertTimestampNotBefore(state.createdAt, receipt.completedAt, "receipt.completedAt");
  if (state.phase === "completed") assertTimestampNotBefore(receipt.completedAt, state.updatedAt, "state.updatedAt");

  const submitAction = Object.values(state.actions).find(action => action.kind === "send");
  if (submitAction?.targetDigest === undefined || submitAction.targetDigest !== receipt.targetBindingDigest) {
    throw new OperationStateError("receipt_target_mismatch", "Terminal receipt does not match the submitted target binding.");
  }
  if (submitAction.outcome !== "satisfied") {
    throw new OperationStateError("receipt_submission_unproven", "Terminal receipt requires a satisfied original Send action.");
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > MAX_ARTIFACTS) {
    throw new OperationStateError("receipt_artifacts_invalid", `Terminal receipt may contain at most ${MAX_ARTIFACTS} artifacts.`);
  }
  const artifactKeys = new Set<string>();
  const artifactOrdinals = new Set<number>();
  for (const artifact of receipt.artifacts) {
    if (artifact.schemaVersion !== OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION) {
      throw new OperationStateError("unsupported_artifact_receipt", "Artifact receipt schemaVersion is unsupported.");
    }
    if (artifact.operationId !== receipt.operationId) {
      throw new OperationStateError("artifact_operation_mismatch", "Artifact receipt must belong to the terminal operation.");
    }
    if (artifact.assistantTurnId !== receipt.assistantTurnId) {
      throw new OperationStateError("artifact_turn_mismatch", "Artifact receipt must belong to the terminal assistant turn.");
    }
    if (!ARTIFACT_KEY_PATTERN.test(artifact.artifactKey) || artifactKeys.has(artifact.artifactKey)) {
      throw new OperationStateError("artifact_key_invalid", "Artifact receipt keys must be bounded canonical values and unique.");
    }
    artifactKeys.add(artifact.artifactKey);
    assertDigest(artifact.sourceIdentityDigest, "artifact.sourceIdentityDigest");
    if (artifact.kind !== "file" && artifact.kind !== "image" && artifact.kind !== "other") {
      throw new OperationStateError("artifact_kind_invalid", "Artifact receipt kind is unsupported.");
    }
    if (artifact.status !== "available" && artifact.status !== "transferred" && artifact.status !== "partial" && artifact.status !== "blocked") {
      throw new OperationStateError("artifact_status_invalid", "Artifact receipt status is unsupported.");
    }
    if (
      !Number.isSafeInteger(artifact.ordinal)
      || artifact.ordinal < 0
      || artifact.ordinal >= MAX_ARTIFACTS
      || artifactOrdinals.has(artifact.ordinal)
    ) {
      throw new OperationStateError(
        "artifact_ordinal_invalid",
        `Artifact receipt ordinals must be unique safe integers from 0 through ${MAX_ARTIFACTS - 1}.`
      );
    }
    artifactOrdinals.add(artifact.ordinal);
    if (artifact.outputKey !== undefined && !isSafeRelativeOutputKey(artifact.outputKey)) {
      throw new OperationStateError("artifact_output_key_invalid", "Artifact outputKey must be a safe relative opaque key.");
    }
    if (artifact.mimeType !== undefined && !MIME_PATTERN.test(artifact.mimeType)) {
      throw new OperationStateError("artifact_mime_type_invalid", "Artifact MIME type must be a bounded canonical value.");
    }
    if (artifact.bytes !== undefined && (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)) {
      throw new OperationStateError("artifact_bytes_invalid", "Artifact receipt bytes must be a non-negative safe integer.");
    }
    if (artifact.sha256 !== undefined && !SHA256_PATTERN.test(artifact.sha256)) {
      throw new OperationStateError("artifact_digest_invalid", "Artifact receipt sha256 must be lowercase hexadecimal.");
    }
    if (artifact.blockerCode !== undefined && !CODE_PATTERN.test(artifact.blockerCode)) {
      throw new OperationStateError("artifact_blocker_invalid", "Artifact blockerCode must be a bounded canonical code.");
    }
    if (artifact.status === "transferred" && (
      artifact.outputKey === undefined || artifact.bytes === undefined || artifact.sha256 === undefined
    )) {
      throw new OperationStateError("artifact_transfer_receipt_incomplete", "Transferred artifacts require outputKey, bytes, and sha256.");
    }
    if ((artifact.status === "partial" || artifact.status === "blocked") && artifact.blockerCode === undefined) {
      throw new OperationStateError("artifact_blocker_missing", "Partial or blocked artifacts require blockerCode.");
    }
    if ((artifact.status === "available" || artifact.status === "transferred") && artifact.blockerCode !== undefined) {
      throw new OperationStateError("artifact_blocker_unexpected", "Available or transferred artifacts cannot contain a blockerCode.");
    }
  }
  validateTerminalArtifactCapturePolicy(receipt, state);
}

/**
 * Enforce the durable artifact obligation at the only point where an
 * operation may become terminal.  Transfer state is deliberately keyed by a
 * transfer action (which also includes a destination identity), while the
 * terminal receipt is keyed by the exact provider artifact identity.  The
 * latter therefore needs a separate one-to-one reconciliation here.
 *
 * A missing capture policy is a legacy state shape.  It retains the historic
 * receipt-only validation and is intentionally not upgraded or downgraded by
 * this function.  New transfer records, however, are never legal without an
 * explicit durable transfer policy (enforced when their intent is applied and
 * in validateStateCoherence above).
 */
function validateTerminalArtifactCapturePolicy(
  receipt: NonNullable<OperationStateV1["receipt"]>,
  state: OperationStateV1
): void {
  const policy = state.capturePolicy?.artifacts;
  if (policy === undefined) return;

  const transfers = state.artifactTransfers ?? {};
  const transferEntries = Object.entries(transfers);

  if (policy === "receipt_only") {
    if (transferEntries.length > 0) {
      throw new OperationStateError(
        "artifact_transfer_policy_mismatch",
        "Receipt-only completion cannot contain durable artifact transfers."
      );
    }
    for (const artifact of receipt.artifacts) {
      if (artifact.status !== "available" || artifact.outputKey !== undefined) {
        throw new OperationStateError(
          "artifact_transfer_policy_mismatch",
          "Receipt-only completion cannot contain transfer-enriched artifacts."
        );
      }
    }
    return;
  }

  if (policy !== "transfer") {
    // The durable policy shape validator should make this unreachable, but
    // keep the terminal gate fail-closed if it is ever called directly.
    throw new OperationStateError("invalid_capture_policy", "Terminal artifact policy is unsupported.");
  }

  const transferByArtifact = new Map<string, OperationArtifactTransferStateV1>();
  for (const [transferActionId, transfer] of transferEntries) {
    if (transfer.receipt === undefined) {
      throw new OperationStateError(
        "artifact_transfer_unsettled",
        `Transfer ${transferActionId} has no durable receipt before terminal completion.`
      );
    }
    const identity = artifactTransferArtifactIdentity(transfer.intent);
    if (transferByArtifact.has(identity)) {
      throw new OperationStateError(
        "artifact_transfer_duplicate_artifact",
        "Terminal completion requires at most one settled transfer per exact artifact identity."
      );
    }
    transferByArtifact.set(identity, transfer);
  }

  const receiptIdentities = new Set<string>();
  for (const artifact of receipt.artifacts) {
    if (artifact.status === "available") {
      throw new OperationStateError(
        "artifact_transfer_unsettled",
        "Transfer-policy completion cannot contain an artifact that remains available."
      );
    }
    const identity = artifactReceiptIdentity(artifact);
    if (receiptIdentities.has(identity)) {
      throw new OperationStateError(
        "artifact_transfer_duplicate_artifact",
        "Terminal receipt contains duplicate exact artifact identities."
      );
    }
    receiptIdentities.add(identity);
    const transfer = transferByArtifact.get(identity);
    if (transfer === undefined || transfer.receipt === undefined) {
      throw new OperationStateError(
        "artifact_transfer_intent_missing",
        "Every terminal transfer-policy artifact requires one matching durable transfer receipt."
      );
    }
    assertTerminalArtifactMatchesTransfer(artifact, transfer.receipt);
  }

  if (transferByArtifact.size !== receiptIdentities.size) {
    throw new OperationStateError(
      "artifact_transfer_extra",
      "Every durable transfer must have one matching terminal artifact receipt."
    );
  }
}

function artifactReceiptIdentity(artifact: OperationArtifactReceiptV1): string {
  return canonicalJson({
    operationId: artifact.operationId,
    assistantTurnId: artifact.assistantTurnId,
    sourceIdentityDigest: artifact.sourceIdentityDigest,
    kind: artifact.kind,
    ordinal: artifact.ordinal
  });
}

function artifactTransferArtifactIdentity(intent: OperationArtifactTransferIntentV1): string {
  return canonicalJson({
    operationId: intent.operationId,
    assistantTurnId: intent.assistantTurnId,
    sourceIdentityDigest: intent.sourceIdentityDigest,
    kind: intent.kind,
    ordinal: intent.ordinal
  });
}

function assertTerminalArtifactMatchesTransfer(
  artifact: OperationArtifactReceiptV1,
  transfer: OperationArtifactTransferReceiptV1
): void {
  if (
    artifact.status !== transfer.status
    || artifact.outputKey !== transfer.outputKey
    || artifact.bytes !== transfer.bytes
    || artifact.sha256 !== transfer.sha256
    || artifact.blockerCode !== transfer.blockerCode
  ) {
    throw new OperationStateError(
      "artifact_transfer_receipt_mismatch",
      "Terminal artifact status and transfer receipt facts must match exactly."
    );
  }
}

function validateStateCoherence(state: OperationStateV1): void {
  if (
    state.target?.targetLifecycle === "new_pending"
    && (state.phase === "submitted" || state.phase === "generating" || state.phase === "capturing" || state.phase === "completed")
  ) {
    throw new OperationStateError(
      "new_target_not_established",
      "A pending new target cannot have a submitted, generating, capturing, or completed state."
    );
  }
  const revisions = new Set<number>();
  const singleIntentKinds = new Set<OperationActionKind>();
  let expectedBoundary: MutationBoundary = "none";
  for (const action of Object.values(state.actions)) {
    if (revisions.has(action.intentRevision) || (action.receiptRevision !== undefined && revisions.has(action.receiptRevision))) {
      throw new OperationStateError("duplicate_action_revision", "Action ledger revisions must be unique.");
    }
    revisions.add(action.intentRevision);
    if (action.receiptRevision !== undefined) revisions.add(action.receiptRevision);
    if (isSingleIntentKind(action.kind)) {
      if (singleIntentKinds.has(action.kind)) {
        throw new OperationStateError("nonrepeatable_action_already_intended", "Persisted operation contains duplicate operation-singleton action kinds.");
      }
      singleIntentKinds.add(action.kind);
    }
    const boundary = boundaryForAction(action.kind);
    if (boundary !== undefined && BOUNDARY_RANK[boundary] > BOUNDARY_RANK[expectedBoundary]) expectedBoundary = boundary;
  }
  if (state.mutationBoundary !== expectedBoundary) {
    throw new OperationStateError("mutation_boundary_inconsistent", "Persisted mutation boundary does not match the durable action ledger.");
  }
  const actions = Object.values(state.actions);
  const hasHandoff = actions.some(action => action.kind === "file_handoff");
  const submitActions = actions.filter(action => action.kind === "send");
  const hasSubmit = submitActions.length > 0;
  if (state.attachmentRearm !== undefined) {
    validateAttachmentRearmValues(state.attachmentRearm, state);
    const rearmedAction = state.actions[state.attachmentRearm.actionId];
    if (state.target === undefined || !hasHandoff) {
      throw new OperationStateError("attachment_rearm_target_invalid", "Attachment rearm requires its replacement target and original handoff.");
    }
    if (hasSubmit && rearmedAction?.outcome !== "satisfied") {
      throw new OperationStateError("attachment_rearm_send_invalid", "Send cannot follow an unproven attachment recovery.");
    }
    if (
      (state.phase === "ready" || state.phase === "send_pending" || state.phase === "submitted"
        || state.phase === "generating" || state.phase === "capturing" || state.phase === "completed")
      && rearmedAction?.outcome !== "satisfied"
    ) {
      throw new OperationStateError("attachment_rearm_phase_invalid", "Recovered attachment state requires a satisfied handoff receipt.");
    }
  }
  validateSubmissionWitnessCollection(state);
  const ownershipBaselines = state.ownershipBaselines ?? {};
  for (const [actionId, baseline] of Object.entries(ownershipBaselines)) {
    const action = state.actions[actionId];
    if (action === undefined || (action.kind !== "send" && action.kind !== "work_steer")) {
      throw new OperationStateError("ownership_baseline_action_missing", "Per-action ownership baselines require a durable Send or steer action.");
    }
    if (baseline.actionId !== actionId) {
      throw new OperationStateError("ownership_baseline_map_mismatch", "Per-action ownership baseline key must match its actionId.");
    }
    if (action.kind === "send") {
      if (state.ownershipBaseline === undefined || canonicalJson(state.ownershipBaseline) !== canonicalJson(baseline)) {
        throw new OperationStateError("ownership_baseline_projection_mismatch", "The Send ownership baseline must match the compatibility projection.");
      }
    }
  }
  if (state.ownershipBaseline !== undefined) {
    const projected = ownershipBaselines[state.ownershipBaseline.actionId];
    if (projected !== undefined && canonicalJson(projected) !== canonicalJson(state.ownershipBaseline)) {
      throw new OperationStateError("ownership_baseline_projection_mismatch", "The ownership baseline compatibility projection conflicts with its per-action record.");
    }
  }
  if (state.artifactTransfers !== undefined) {
    assertArtifactTransfersStateShape(state.artifactTransfers);
    if (
      Object.keys(state.artifactTransfers).length > 0
      && state.capturePolicy?.artifacts !== "transfer"
    ) {
      throw new OperationStateError(
        "artifact_transfer_policy_mismatch",
        "Durable artifact transfers require the immutable transfer capture policy."
      );
    }
    const seenTuples = new Set<string>();
    for (const [transferActionId, transfer] of Object.entries(state.artifactTransfers)) {
      validateArtifactTransferStateValues(transferActionId, transfer, state);
      const intent = transfer.intent!;
      const tuple = artifactTransferTuple(intent);
      if (seenTuples.has(tuple)) {
        throw new OperationStateError("artifact_transfer_duplicate_tuple", "An artifact transfer tuple may only be transferred once.");
      }
      seenTuples.add(tuple);
    }
  }
  if (state.target?.targetLifecycle === "new_established") {
    const establishment = state.target.targetEstablishment;
    const submit = submitActions.length === 1 ? submitActions[0] : undefined;
    if (establishment === undefined || submit === undefined) {
      throw new OperationStateError("new_target_establishment_send_missing", "An established new target requires exactly one durable Send intent.");
    }
    if (
      establishment.causalSendActionId !== submit.actionId
      || establishment.targetBindingDigest !== submit.targetDigest
    ) {
      throw new OperationStateError("new_target_establishment_target_mismatch", "Established target identity does not match the durable Send action.");
    }
  }
  if (state.phase === "handoff_pending" && !hasHandoff) {
    throw new OperationStateError("operation_state_inconsistent", "handoff_pending requires a durable file-handoff intent.");
  }
  if (state.phase === "send_pending" && !hasSubmit) {
    throw new OperationStateError("operation_state_inconsistent", "send_pending requires the durable original Send intent.");
  }
  if (["submitted", "generating", "capturing", "completed"].includes(state.phase)) {
    requireDurableOriginalSendOwnership(state);
  }
}

/**
 * Terminal ownership is never reconstructed from a generic Send receipt.  The
 * original Send must have its complete pre-action baseline and immutable
 * post-action witness in the keyed ledgers before an owned phase can be
 * entered.  Compatibility projections are checked as mirrors only; snapshots
 * that predate the keyed proof fail closed because no migration can recreate
 * evidence that was never durably observed.
 */
function requireDurableOriginalSendOwnership(state: OperationStateV1): void {
  const sendActions = Object.values(state.actions).filter(action => action.kind === "send");
  if (sendActions.length !== 1) {
    throw new OperationStateError(
      "operation_state_inconsistent",
      "Owned submission state requires exactly one durable original Send intent."
    );
  }
  const send = sendActions[0]!;
  if (send.outcome !== "satisfied") {
    throw new OperationStateError(
      "operation_state_inconsistent",
      "Owned submission state requires a satisfied original Send action."
    );
  }

  const baseline = state.ownershipBaselines?.[send.actionId];
  if (baseline === undefined) {
    throw new OperationStateError(
      "ownership_baseline_missing",
      "Owned submission state requires the keyed pre-Send ownership baseline."
    );
  }
  const witness = state.submissionWitnesses?.[send.actionId];
  if (witness === undefined) {
    throw new OperationStateError(
      "submission_witness_missing",
      "Owned submission state requires the keyed original Send submission witness."
    );
  }
  if (
    baseline.actionId !== send.actionId
    || baseline.operationId !== state.operationId
    || baseline.requestDigest !== state.requestDigest
    || baseline.targetBindingDigest !== send.targetDigest
    || witness.actionId !== send.actionId
    || witness.actionKind !== "send"
    || witness.targetBindingDigest !== send.targetDigest
    || witness.baselineSnapshotDigest !== baseline.baseline.snapshotDigest
  ) {
    throw new OperationStateError(
      "submission_ownership_mismatch",
      "Original Send ownership baseline and witness do not match the durable action identity."
    );
  }
  if (
    state.ownershipBaseline === undefined
    || canonicalJson(state.ownershipBaseline) !== canonicalJson(baseline)
    || state.submissionWitness === undefined
    || canonicalJson(state.submissionWitness) !== canonicalJson(witness)
  ) {
    throw new OperationStateError(
      "submission_ownership_projection_mismatch",
      "Original Send ownership compatibility projections must mirror the keyed durable proof."
    );
  }
}

function validatedTarget(state: OperationStateV1, target: NonNullable<OperationStateV1["target"]>): NonNullable<OperationStateV1["target"]> {
  validateTargetValues(target);
  if (state.target === undefined && target.targetLifecycle === "new_established") {
    throw new OperationStateError(
      "new_target_establishment_order",
      "A new target must be bound as pending before its target_established event."
    );
  }
  if (state.target !== undefined && canonicalJson(state.target) !== canonicalJson(target)) {
    throw new OperationStateError("target_binding_mismatch", "Operation target binding is immutable.");
  }
  return target;
}

function applyAttachmentRearmAuthorization(
  state: OperationStateV1,
  event: Extract<OperationEventV1, { type: "attachment_rearm_authorized" }>,
  revision: number
): OperationStateV1 {
  const authorization = event.authorization;
  assertAttachmentRearmAuthorizationShape(authorization);
  validateTargetValues(event.target);
  if (authorization.schemaVersion !== OPERATION_ATTACHMENT_REARM_SCHEMA_VERSION) {
    throw new OperationStateError("attachment_rearm_schema_invalid", "Attachment rearm schemaVersion is unsupported.");
  }
  assertOperationId(authorization.authorizationId, "attachmentRearm.authorizationId");
  assertOperationId(authorization.actionId, "attachmentRearm.actionId");
  assertDigest(authorization.previousTargetBindingDigest, "attachmentRearm.previousTargetBindingDigest");
  assertDigest(authorization.targetBindingDigest, "attachmentRearm.targetBindingDigest");
  assertDigest(authorization.authorizationEvidenceDigest, "attachmentRearm.authorizationEvidenceDigest");
  if (state.attachmentRearm !== undefined) {
    throw new OperationStateError("attachment_rearm_already_authorized", "Attachment recovery may be authorized only once.");
  }
  if (
    state.phase !== "uncertain"
    || state.mutationBoundary !== "handoff_may_have_occurred"
  ) {
    throw new OperationStateError("attachment_rearm_phase_invalid", "Attachment recovery requires an indeterminate handoff state.");
  }
  const target = state.target;
  if (target === undefined || target.targetLifecycle !== "new_pending") {
    throw new OperationStateError("attachment_rearm_target_invalid", "Attachment recovery requires a pending new target.");
  }
  if (Object.values(state.actions).some(action => action.kind === "send")) {
    throw new OperationStateError("attachment_rearm_after_send", "Attachment recovery cannot be authorized after Send intent.");
  }
  const handoffs = Object.values(state.actions).filter(action => action.kind === "file_handoff");
  const handoff = handoffs.length === 1 ? handoffs[0] : undefined;
  if (
    handoff === undefined
    || handoff.actionId !== authorization.actionId
    || handoff.outcome !== undefined
    || handoff.targetDigest !== authorization.previousTargetBindingDigest
    || handoff.requestDigest !== state.requestDigest
  ) {
    throw new OperationStateError("attachment_rearm_action_invalid", "Attachment recovery does not match the unresolved handoff intent.");
  }
  assertAttachmentRearmTargetCompatible(target, event.target);
  const rearm: OperationAttachmentRearmV1 = {
    ...authorization,
    authorizedRevision: revision
  };
  return { ...state, target: event.target, attachmentRearm: rearm };
}

function applyAttachmentRearmIntent(
  state: OperationStateV1,
  event: Extract<OperationEventV1, { type: "attachment_rearm_intent" }>,
  revision: number
): OperationStateV1 {
  assertOperationId(event.authorizationId, "attachmentRearm.authorizationId");
  assertOperationId(event.actionId, "attachmentRearm.actionId");
  assertDigest(event.preflightEvidenceDigest, "attachmentRearm.preflightEvidenceDigest");
  const rearm = state.attachmentRearm;
  if (
    rearm === undefined
    || rearm.authorizationId !== event.authorizationId
    || rearm.actionId !== event.actionId
    || rearm.attemptIntentRevision !== undefined
  ) {
    throw new OperationStateError("attachment_rearm_intent_invalid", "Attachment recovery intent does not match one unused authorization.");
  }
  if (state.phase !== "uncertain" || state.mutationBoundary !== "handoff_may_have_occurred") {
    throw new OperationStateError("attachment_rearm_phase_invalid", "Attachment recovery intent requires an indeterminate handoff state.");
  }
  const action = state.actions[event.actionId];
  if (action?.kind !== "file_handoff" || action.outcome !== undefined) {
    throw new OperationStateError("attachment_rearm_action_invalid", "Attachment recovery intent requires the unresolved original handoff.");
  }
  if (Object.values(state.actions).some(candidate => candidate.kind === "send")) {
    throw new OperationStateError("attachment_rearm_after_send", "Attachment recovery intent cannot follow Send intent.");
  }
  return {
    ...state,
    attachmentRearm: {
      ...rearm,
      attemptIntentRevision: revision,
      attemptIntentAt: event.intentAt,
      preflightEvidenceDigest: event.preflightEvidenceDigest
    }
  };
}

function assertAttachmentRearmTargetCompatible(
  previous: NonNullable<OperationStateV1["target"]>,
  replacement: NonNullable<OperationStateV1["target"]>
): void {
  if (
    replacement.targetLifecycle !== "new_pending"
    || replacement.targetEstablishment !== undefined
    || replacement.conversationId !== undefined
    || replacement.canonicalThreadUrl !== undefined
    || replacement.newTargetAnchorDigest === undefined
    || replacement.blankTaskEvidenceDigest === undefined
    || replacement.providerId !== previous.providerId
    || replacement.browserId !== previous.browserId
    || replacement.coordinationScope !== previous.coordinationScope
    || replacement.configurationReceiptDigest !== previous.configurationReceiptDigest
    || canonicalJson(replacement.evidenceProfile) !== canonicalJson(previous.evidenceProfile)
  ) {
    throw new OperationStateError("attachment_rearm_target_invalid", "Attachment recovery target does not preserve the pending target contract.");
  }
}

function validateAttachmentRearmValues(rearm: OperationAttachmentRearmV1, state: OperationStateV1): void {
  assertAttachmentRearmShape(rearm);
  if (rearm.schemaVersion !== OPERATION_ATTACHMENT_REARM_SCHEMA_VERSION) {
    throw new OperationStateError("attachment_rearm_schema_invalid", "Attachment rearm schemaVersion is unsupported.");
  }
  assertOperationId(rearm.authorizationId, "attachmentRearm.authorizationId");
  assertOperationId(rearm.actionId, "attachmentRearm.actionId");
  assertDigest(rearm.previousTargetBindingDigest, "attachmentRearm.previousTargetBindingDigest");
  assertDigest(rearm.targetBindingDigest, "attachmentRearm.targetBindingDigest");
  assertDigest(rearm.authorizationEvidenceDigest, "attachmentRearm.authorizationEvidenceDigest");
  assertTimestamp(rearm.authorizedAt, "attachmentRearm.authorizedAt");
  if (!Number.isSafeInteger(rearm.authorizedRevision) || rearm.authorizedRevision < 1 || rearm.authorizedRevision > state.revision) {
    throw new OperationStateError("attachment_rearm_revision_invalid", "Attachment rearm authorization revision is invalid.");
  }
  const action = state.actions[rearm.actionId];
  if (
    action?.kind !== "file_handoff"
    || action.requestDigest !== state.requestDigest
    || action.targetDigest !== rearm.previousTargetBindingDigest
  ) {
    throw new OperationStateError("attachment_rearm_action_invalid", "Attachment rearm does not match the durable handoff action.");
  }
  const intentFields = [rearm.attemptIntentRevision, rearm.attemptIntentAt, rearm.preflightEvidenceDigest];
  const intentCount = intentFields.filter(value => value !== undefined).length;
  if (intentCount !== 0 && intentCount !== intentFields.length) {
    throw new OperationStateError("attachment_rearm_intent_incomplete", "Attachment rearm intent fields must be all present or all absent.");
  }
  if (rearm.attemptIntentRevision !== undefined) {
    if (
      !Number.isSafeInteger(rearm.attemptIntentRevision)
      || rearm.attemptIntentRevision <= rearm.authorizedRevision
      || rearm.attemptIntentRevision > state.revision
    ) {
      throw new OperationStateError("attachment_rearm_revision_invalid", "Attachment rearm intent revision is invalid.");
    }
    assertTimestamp(rearm.attemptIntentAt!, "attachmentRearm.attemptIntentAt");
    assertTimestampNotBefore(rearm.authorizedAt, rearm.attemptIntentAt!, "attachmentRearm.attemptIntentAt");
    assertDigest(rearm.preflightEvidenceDigest!, "attachmentRearm.preflightEvidenceDigest");
  }
}

function establishTarget(
  state: OperationStateV1,
  establishment: NonNullable<Extract<OperationEventV1, { type: "target_established" }>['establishment']>
): NonNullable<OperationStateV1["target"]> {
  const target = state.target;
  if (target === undefined) {
    throw new OperationStateError("target_not_bound", "Target establishment requires a durable target anchor.");
  }
  const lifecycle = target.targetLifecycle ?? "fixed";
  if (lifecycle === "fixed") {
    throw new OperationStateError("fixed_target_establishment", "A fixed target cannot be established as a new conversation.");
  }
  if (lifecycle === "new_established") {
    throw new OperationStateError("target_already_established", "A new target can be established only once.");
  }
  validateTargetEstablishmentValues(
    {
      ...establishment,
      // The nested record is checked again below against the send intent and
      // current target. Keeping the full record here makes the event/state
      // shapes closed and lets authenticated snapshots replay without context.
    },
    {
      ...target,
      targetLifecycle: "new_established",
      conversationId: establishment.conversationId,
      canonicalThreadUrl: establishment.canonicalThreadUrl,
      targetEstablishment: establishment,
      evidenceProfile: {
        ...target.evidenceProfile,
        stableConversationId: "required",
        stableUserTurnId: "required"
      }
    }
  );
  assertOperationId(establishment.causalSendActionId, "target_established.causalSendActionId");
  const send = state.actions[establishment.causalSendActionId];
  if (send === undefined || send.kind !== "send") {
    throw new OperationStateError("target_establishment_send_missing", "Target establishment requires the causal original Send intent.");
  }
  if (send.outcome === "not_satisfied") {
    throw new OperationStateError("target_establishment_send_rejected", "Target establishment cannot follow a rejected Send intent.");
  }
  if (send.targetDigest !== establishment.targetBindingDigest) {
    throw new OperationStateError("target_establishment_target_mismatch", "Target establishment target digest does not match the causal Send intent.");
  }
  if (establishment.observedAt < send.intentAt) {
    throw new OperationStateError("target_establishment_before_send", "Target establishment cannot precede the durable Send intent.");
  }
  if (state.phase === "prepared" || state.phase === "handoff_pending" || state.phase === "completed") {
    throw new OperationStateError("target_establishment_phase_invalid", "Target establishment requires a durable Send lifecycle phase.");
  }
  const establishedTarget: NonNullable<OperationStateV1["target"]> = {
    ...target,
    targetLifecycle: "new_established",
    conversationId: establishment.conversationId,
    canonicalThreadUrl: establishment.canonicalThreadUrl,
    evidenceProfile: {
      ...target.evidenceProfile,
      stableConversationId: "required",
      stableUserTurnId: "required"
    },
    targetEstablishment: establishment
  };
  validateTargetValues(establishedTarget);
  return establishedTarget;
}

function validateTargetValues(target: NonNullable<OperationStateV1["target"]>): void {
  for (const [label, value] of [["providerId", target.providerId], ["browserId", target.browserId], ["tabId", target.tabId]] as const) {
    assertStableIdentifier(value, label);
  }
  if (target.conversationId !== undefined) assertStableIdentifier(target.conversationId, "conversationId");
  for (const [label, digest] of [
    ["userTurnBaselineDigest", target.userTurnBaselineDigest],
    ["assistantTurnBaselineDigest", target.assistantTurnBaselineDigest],
    ["configurationReceiptDigest", target.configurationReceiptDigest]
  ] as const) {
    if (digest !== undefined) assertDigest(digest, `target.${label}`);
  }
  const profile = target.evidenceProfile;
  if (
    !profile ||
    (profile.providerIdentity !== "required" && profile.providerIdentity !== "unavailable") ||
    (profile.stableTabId !== "required" && profile.stableTabId !== "unavailable") ||
    (profile.stableConversationId !== "required" && profile.stableConversationId !== "unavailable") ||
    (profile.stableUserTurnId !== "required" && profile.stableUserTurnId !== "unavailable") ||
    (profile.authoritativeTabClaim !== "required" && profile.authoritativeTabClaim !== "unavailable") ||
    typeof profile.replacementTabRecovery !== "boolean"
  ) {
    throw new OperationStateError("invalid_target_evidence_profile", "Target evidence profile is invalid.");
  }
  if (profile.stableConversationId === "required" && target.conversationId === undefined) {
    throw new OperationStateError("target_conversation_missing", "Required stable conversation identity is absent.");
  }
  if (target.coordinationScope !== "process" && target.coordinationScope !== "provider") {
    throw new OperationStateError("invalid_coordination_scope", "Target coordinationScope must be process or provider.");
  }
  if (target.tabClaimEvidenceDigest !== undefined) {
    assertDigest(target.tabClaimEvidenceDigest, "target.tabClaimEvidenceDigest");
  }
  if (
    target.coordinationScope === "provider" &&
    (profile.authoritativeTabClaim !== "required" || target.tabClaimEvidenceDigest === undefined)
  ) {
    throw new OperationStateError(
      "target_claim_evidence_missing",
      "Provider-scoped coordination requires authoritative tab-claim evidence."
    );
  }
  if (target.canonicalThreadUrl !== undefined) assertCanonicalThreadUrl(target.canonicalThreadUrl);

  const lifecycle = target.targetLifecycle ?? "fixed";
  if (lifecycle !== "fixed" && lifecycle !== "new_pending" && lifecycle !== "new_established") {
    throw new OperationStateError("invalid_target_lifecycle", "Target lifecycle must be fixed, new_pending, or new_established.");
  }
  if (target.newTargetAnchorDigest !== undefined) assertDigest(target.newTargetAnchorDigest, "target.newTargetAnchorDigest");
  if (target.blankTaskEvidenceDigest !== undefined) assertDigest(target.blankTaskEvidenceDigest, "target.blankTaskEvidenceDigest");

  if (lifecycle === "fixed") {
    if (target.newTargetAnchorDigest !== undefined || target.blankTaskEvidenceDigest !== undefined || target.targetEstablishment !== undefined) {
      throw new OperationStateError("fixed_target_new_identity", "Fixed targets cannot contain new-conversation identity fields.");
    }
    return;
  }

  if (target.newTargetAnchorDigest === undefined || target.blankTaskEvidenceDigest === undefined) {
    throw new OperationStateError("new_target_anchor_missing", "New targets require an immutable anchor and blank-task evidence digest.");
  }
  if (target.canonicalThreadUrl !== undefined || target.conversationId !== undefined) {
    if (lifecycle === "new_pending") {
      throw new OperationStateError("new_target_identity_early", "A pending new target cannot contain provider conversation identity before establishment.");
    }
  }
  if (lifecycle === "new_pending") {
    if (target.targetEstablishment !== undefined) {
      throw new OperationStateError("new_target_establishment_early", "A pending new target cannot contain an establishment record.");
    }
    if (target.evidenceProfile.stableConversationId !== "unavailable") {
      throw new OperationStateError("new_target_conversation_profile", "A pending new target must mark stable conversation identity unavailable.");
    }
    if (target.evidenceProfile.stableUserTurnId !== "unavailable") {
      throw new OperationStateError("new_target_user_profile", "A pending new target must mark stable user-turn identity unavailable.");
    }
    return;
  }

  const establishment = target.targetEstablishment;
  if (establishment === undefined) {
    throw new OperationStateError("new_target_establishment_missing", "An established new target requires its durable establishment record.");
  }
  validateTargetEstablishmentValues(establishment, target);
  if (target.evidenceProfile.stableConversationId !== "required" || target.evidenceProfile.stableUserTurnId !== "required") {
    throw new OperationStateError("new_target_established_profile", "An established new target must require stable conversation and user-turn identity.");
  }
}

function validateTargetEstablishmentValues(
  establishment: NonNullable<NonNullable<OperationStateV1["target"]>["targetEstablishment"]>,
  target: NonNullable<OperationStateV1["target"]>
): void {
  assertDigest(establishment.targetBindingDigest, "targetEstablishment.targetBindingDigest");
  assertDigest(establishment.anchorDigest, "targetEstablishment.anchorDigest");
  assertOperationId(establishment.causalSendActionId, "targetEstablishment.causalSendActionId");
  assertStableIdentifier(establishment.conversationId, "targetEstablishment.conversationId");
  assertCanonicalThreadUrl(establishment.canonicalThreadUrl);
  assertStableIdentifier(establishment.userTurnId, "targetEstablishment.userTurnId");
  assertDigest(establishment.userTurnEvidenceDigest, "targetEstablishment.userTurnEvidenceDigest");
  if (establishment.postSendDeltaDigest !== undefined) {
    assertDigest(establishment.postSendDeltaDigest, "targetEstablishment.postSendDeltaDigest");
  }
  assertDigest(establishment.evidenceDigest, "targetEstablishment.evidenceDigest");
  assertTimestamp(establishment.observedAt, "targetEstablishment.observedAt");
  if (establishment.anchorDigest !== target.newTargetAnchorDigest) {
    throw new OperationStateError("new_target_anchor_mismatch", "Target establishment does not match the immutable new-target anchor.");
  }
  if (target.conversationId !== establishment.conversationId || target.canonicalThreadUrl !== establishment.canonicalThreadUrl) {
    throw new OperationStateError("new_target_identity_mismatch", "Target establishment identity disagrees with the durable target binding.");
  }
}

function assertSubmissionWitnessesMapShape(
  value: unknown
): asserts value is Record<string, OperationSubmissionWitnessV1> {
  if (!isPlainRecord(value)) {
    throw new OperationStateError("invalid_operation_state", "Operation submissionWitnesses must be an object.");
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_SUBMISSION_WITNESSES) {
    throw new OperationStateError(
      "submission_witness_limit",
      `An operation may record at most ${MAX_SUBMISSION_WITNESSES} submission witnesses.`
    );
  }
  for (const actionId of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, actionId);
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw new OperationStateError(
        "invalid_operation_shape",
        "Operation submissionWitnesses contains an unsafe property (accessor)."
      );
    }
    assertOperationId(actionId, "submissionWitnesses map key");
    assertSubmissionWitnessShape(descriptor.value);
  }
}

function validateSubmissionWitnessCollection(state: OperationStateV1): void {
  if (state.submissionWitnesses !== undefined) {
    assertSubmissionWitnessesMapShape(state.submissionWitnesses);
    for (const [actionId, witness] of Object.entries(state.submissionWitnesses)) {
      if (witness.actionId !== actionId) {
        throw new OperationStateError(
          "submission_witness_map_mismatch",
          "Submission witness map key must match its actionId."
        );
      }
      validateSubmissionWitnessValues(witness, state);
    }
  }

  if (state.submissionWitness !== undefined) {
    assertSubmissionWitnessShape(state.submissionWitness);
    if (state.submissionWitness.actionKind !== "send") {
      throw new OperationStateError(
        "submission_witness_projection_mismatch",
        "The legacy submissionWitness field must project the original Send witness."
      );
    }
    validateSubmissionWitnessValues(state.submissionWitness, state);
    if (state.submissionWitnesses !== undefined) {
      const projected = state.submissionWitnesses[state.submissionWitness.actionId];
      if (projected === undefined || canonicalJson(projected) !== canonicalJson(state.submissionWitness)) {
        throw new OperationStateError(
          "submission_witness_projection_mismatch",
          "The original Send submission witness must match its keyed projection exactly."
        );
      }
    }
  }

  if (state.submissionWitnesses !== undefined) {
    const sendWitnesses = Object.values(state.submissionWitnesses).filter(witness => witness.actionKind === "send");
    if (sendWitnesses.length > 1) {
      throw new OperationStateError(
        "submission_witness_duplicate_send",
        "An operation may record only one original Send submission witness."
      );
    }
    if (sendWitnesses.length === 1 && (
      state.submissionWitness === undefined
      || canonicalJson(state.submissionWitness) !== canonicalJson(sendWitnesses[0])
    )) {
      throw new OperationStateError(
        "submission_witness_projection_mismatch",
        "The original Send submission witness must be retained through the legacy projection."
      );
    }
  }
}

function assertSubmissionWitnessShape(value: unknown): asserts value is OperationSubmissionWitnessV1 {
  assertExactRecord(
    value,
    "operation submission witness",
    [
      "schemaVersion",
      "actionId",
      "actionKind",
      "targetBindingDigest",
      "baselineSnapshotDigest",
      "postSendDeltaDigest",
      "operationUserEvidenceDigest",
      "userTurnId",
      "observedAt"
    ],
    [
      "schemaVersion",
      "actionId",
      "actionKind",
      "targetBindingDigest",
      "baselineSnapshotDigest",
      "postSendDeltaDigest",
      "operationUserEvidenceDigest",
      "observedAt"
    ]
  );
}

function validateSubmissionWitnessValues(
  witness: OperationSubmissionWitnessV1,
  state: OperationStateV1
): void {
  if (witness.schemaVersion !== OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION) {
    throw new OperationStateError("unsupported_submission_witness", "Submission witness schemaVersion is unsupported.");
  }
  assertOperationId(witness.actionId, "submissionWitness.actionId");
  if (witness.actionKind !== "send" && witness.actionKind !== "work_steer") {
    throw new OperationStateError("invalid_submission_witness", "Submission witness actionKind is unsupported.");
  }
  assertDigest(witness.targetBindingDigest, "submissionWitness.targetBindingDigest");
  assertDigest(witness.baselineSnapshotDigest, "submissionWitness.baselineSnapshotDigest");
  assertDigest(witness.postSendDeltaDigest, "submissionWitness.postSendDeltaDigest");
  assertDigest(witness.operationUserEvidenceDigest, "submissionWitness.operationUserEvidenceDigest");
  if (witness.userTurnId !== undefined) assertStableIdentifier(witness.userTurnId, "submissionWitness.userTurnId");
  assertTimestamp(witness.observedAt, "submissionWitness.observedAt");

  const action = state.actions[witness.actionId];
  if (action === undefined || action.kind !== witness.actionKind) {
    throw new OperationStateError("submission_witness_action_missing", "Submission witness must name its durable causal action.");
  }
  if (action.targetDigest !== witness.targetBindingDigest) {
    throw new OperationStateError("submission_witness_target_mismatch", "Submission witness target does not match its causal action.");
  }
  if (action.outcome === "not_satisfied" || action.outcome === "uncertain") {
    throw new OperationStateError("submission_witness_action_unproven", "Submission witness cannot follow an unsatisfied or uncertain action.");
  }
  if (witness.observedAt < action.intentAt) {
    throw new OperationStateError("submission_witness_before_action", "Submission witness cannot precede its causal action intent.");
  }
  if (state.target === undefined) {
    throw new OperationStateError("target_not_bound", "Submission witness requires a durable target binding.");
  }
  // New states must carry a per-action baseline entry.  A legacy state that
  // predates the map may still use the original Send compatibility wrapper;
  // do not let that fallback hide a missing steer baseline in a mapped state.
  const witnessBaseline = state.ownershipBaselines === undefined
    ? (state.ownershipBaseline?.actionId === witness.actionId ? state.ownershipBaseline : undefined)
    : state.ownershipBaselines[witness.actionId];
  if (witnessBaseline === undefined) {
    throw new OperationStateError("ownership_baseline_missing", "Submission witness requires the durable ownership baseline for its causal action.");
  }
  if (
    witnessBaseline.operationId !== state.operationId
    || witnessBaseline.requestDigest !== state.requestDigest
    || witnessBaseline.targetBindingDigest !== witness.targetBindingDigest
    || witnessBaseline.actionId !== witness.actionId
    || witnessBaseline.baseline.snapshotDigest !== witness.baselineSnapshotDigest
  ) {
    throw new OperationStateError("ownership_baseline_mismatch", "Submission witness does not match the durable ownership baseline.");
  }
  if (state.target.targetLifecycle === "new_pending") {
    throw new OperationStateError(
      "new_target_establishment_required",
      "A pending new target must be established before its submission witness is durable."
    );
  }

  const establishment = state.target.targetEstablishment;
  if (establishment !== undefined && establishment.causalSendActionId === witness.actionId) {
    if (
      establishment.targetBindingDigest !== witness.targetBindingDigest
      || establishment.userTurnEvidenceDigest !== witness.operationUserEvidenceDigest
      || establishment.postSendDeltaDigest === undefined
      || establishment.postSendDeltaDigest !== witness.postSendDeltaDigest
      || (witness.userTurnId !== undefined && establishment.userTurnId !== witness.userTurnId)
    ) {
      throw new OperationStateError("submission_witness_establishment_mismatch", "Submission witness conflicts with durable target establishment.");
    }
  }
}

function requireUnreceiptedCause(
  cause: OperationActionRecordV1 | undefined,
  kind: OperationActionKind
): void {
  requireCause(cause, kind, undefined);
  if (cause!.outcome !== undefined) {
    throw new OperationStateError("transition_cause_already_settled", `Transition requires an unreceipted ${kind} intent.`);
  }
}

function withRevision(state: OperationStateV1, revision: number, updatedAt: string): OperationStateV1 {
  return { ...state, revision, updatedAt };
}

function requireCause(
  cause: OperationActionRecordV1 | undefined,
  kind: OperationActionKind,
  outcome: OperationActionRecordV1["outcome"] | undefined
): void {
  if (cause?.kind !== kind || (outcome !== undefined && cause.outcome !== outcome)) {
    throw new OperationStateError("invalid_transition_cause", `Transition requires ${kind}${outcome === undefined ? "" : ` with ${outcome} receipt`}.`);
  }
}

function requireSatisfiedCause(cause: OperationActionRecordV1, evidenceDigest: string | undefined): void {
  if (cause.outcome !== "satisfied") {
    throw new OperationStateError("transition_cause_unproven", `Action ${cause.actionId} has not been satisfied.`);
  }
  requireEvidence(evidenceDigest ?? cause.evidenceDigest);
}

function requireBoundary(actual: MutationBoundary, required: MutationBoundary): void {
  if (BOUNDARY_RANK[actual] < BOUNDARY_RANK[required]) {
    throw new OperationStateError("mutation_boundary_missing", `Transition requires boundary ${required}.`);
  }
}

function requireEvidence(value: string | undefined): void {
  if (value === undefined || value.length === 0) {
    throw new OperationStateError("transition_evidence_missing", "Transition requires causal evidenceDigest.");
  }
}

function assertDigest(value: string, label: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new OperationStateError("invalid_digest", `${label} must be a canonical lowercase hmac-sha256 digest.`);
  }
}

function assertTimestamp(value: string, label: string): void {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    throw new OperationStateError("invalid_timestamp", `${label} must be a canonical UTC ISO-8601 timestamp.`);
  }
}

function assertTimestampNotBefore(earlier: string, later: string, label: string): void {
  if (later < earlier) {
    throw new OperationStateError("timestamp_regression", `${label} cannot precede the prior durable event.`);
  }
}

function assertStableIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OperationStateError("invalid_target_binding", `${label} must be a bounded stable identifier.`);
  }
}

function assertCanonicalThreadUrl(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 4096) {
    throw new OperationStateError("invalid_target_url", "canonicalThreadUrl must be a bounded absolute HTTP(S) URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OperationStateError("invalid_target_url", "canonicalThreadUrl must be a bounded absolute HTTP(S) URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.toString() !== value
  ) {
    throw new OperationStateError("invalid_target_url", "canonicalThreadUrl must be a canonical HTTPS URL without credentials, query, or fragment.");
  }
}

function isSafeRelativeOutputKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function assertTargetShape(value: unknown): void {
  assertExactRecord(
    value,
    "operation target",
    [
      "providerId",
      "browserId",
      "tabId",
      "coordinationScope",
      "tabClaimEvidenceDigest",
      "canonicalThreadUrl",
      "conversationId",
      "userTurnBaselineDigest",
      "assistantTurnBaselineDigest",
      "configurationReceiptDigest",
      "evidenceProfile",
      "targetLifecycle",
      "newTargetAnchorDigest",
      "blankTaskEvidenceDigest",
      "targetEstablishment"
    ],
    ["providerId", "browserId", "tabId", "coordinationScope", "evidenceProfile"]
  );
  const target = value as Record<string, unknown>;
  assertExactRecord(
    target.evidenceProfile,
    "operation target evidence profile",
    ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim", "replacementTabRecovery"],
    ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim", "replacementTabRecovery"]
  );
  if (target.targetEstablishment !== undefined) assertTargetEstablishmentShape(target.targetEstablishment);
}

function assertTargetEstablishmentShape(value: unknown): void {
  assertExactRecord(
    value,
    "operation target establishment",
    [
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
    ],
    [
      "targetBindingDigest",
      "anchorDigest",
      "causalSendActionId",
      "conversationId",
      "canonicalThreadUrl",
      "userTurnId",
      "userTurnEvidenceDigest",
      "evidenceDigest",
      "observedAt"
    ]
  );
}

/** Closed-shape validation for the redacted pre-Send baseline. */
export function assertOwnershipBaselineShape(value: unknown): asserts value is OperationOwnershipBaselineV1 {
  assertExactRecord(
    value,
    "operation ownership baseline",
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "actionId", "baseline", "observedAt"],
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "actionId", "baseline", "observedAt"]
  );
  if (value.schemaVersion !== OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION) {
    throw new OperationStateError("unsupported_ownership_baseline", "Ownership baseline schemaVersion is unsupported.");
  }
  assertOperationId(value.operationId as string, "ownershipBaseline.operationId");
  assertDigest(value.requestDigest as string, "ownershipBaseline.requestDigest");
  assertDigest(value.targetBindingDigest as string, "ownershipBaseline.targetBindingDigest");
  assertOperationId(value.actionId as string, "ownershipBaseline.actionId");
  assertTimestamp(value.observedAt as string, "ownershipBaseline.observedAt");
  assertOwnershipBaselineSnapshotShape(value.baseline);
}

function assertOwnershipBaselineSnapshotShape(value: unknown): asserts value is OwnershipBaseline {
  assertExactRecord(
    value,
    "ownership baseline snapshot",
    ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness"],
    ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness"]
  );
  if (value.schemaVersion !== "chatgpt.browser_control.turn_ownership.v1" || value.completeness !== "complete") {
    throw new OperationStateError("invalid_ownership_baseline", "Ownership baseline must be a complete normalized snapshot.");
  }
  assertDigest(value.snapshotDigest as string, "ownershipBaseline.baseline.snapshotDigest");
  assertOwnershipTargetEvidenceShape(value.target, "ownershipBaseline.baseline.target");
  assertOwnershipTurnsShape(value.userTurns, "user", "ownershipBaseline.baseline.userTurns");
  assertOwnershipTurnsShape(value.assistantTurns, "assistant", "ownershipBaseline.baseline.assistantTurns");
}

function assertOwnershipTargetEvidenceShape(value: unknown, label: string): asserts value is OwnershipTargetEvidence {
  assertExactRecord(
    value,
    label,
    ["provider", "browser", "tab", "thread", "conversation", "canonicalThreadUrl", "authoritativeTabClaim", "coordinationScope"],
    ["provider", "browser", "tab", "thread", "conversation", "canonicalThreadUrl", "authoritativeTabClaim", "coordinationScope"]
  );
  for (const key of ["provider", "browser", "tab", "thread", "conversation", "authoritativeTabClaim"] as const) {
    assertOwnershipIdentityEvidenceShape(value[key], `${label}.${key}`);
  }
  assertOwnershipIdentityEvidenceShape(value.canonicalThreadUrl, `${label}.canonicalThreadUrl`, true);
  if (value.coordinationScope !== "process" && value.coordinationScope !== "provider") {
    throw new OperationStateError("invalid_ownership_baseline", `${label}.coordinationScope is invalid.`);
  }
  if (value.coordinationScope === "provider" && (value.authoritativeTabClaim as { status?: unknown }).status !== "available") {
    throw new OperationStateError("invalid_ownership_baseline", `${label} requires provider claim evidence.`);
  }
}

function assertOwnershipIdentityEvidenceShape(value: unknown, label: string, allowUrl = false): void {
  if (!isPlainRecord(value) || (value.status !== "available" && value.status !== "unavailable")) {
    throw new OperationStateError("invalid_ownership_baseline", `${label} availability is invalid.`);
  }
  if (value.status === "available") {
    assertExactRecord(value, label, ["status", "value"], ["status", "value"]);
    if (typeof value.value !== "string" || value.value.length < 1 || value.value.length > (allowUrl ? 4096 : 512) || /[\u0000-\u001f\u007f]/u.test(value.value)) {
      throw new OperationStateError("invalid_ownership_baseline", `${label}.value is not bounded evidence.`);
    }
    if (allowUrl) {
      let parsed: URL;
      try { parsed = new URL(value.value); } catch { throw new OperationStateError("invalid_ownership_baseline", `${label}.value is not a URL.`); }
      if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
        throw new OperationStateError("invalid_ownership_baseline", `${label}.value is not a canonical HTTPS URL.`);
      }
    }
  } else {
    assertExactRecord(value, label, ["status", "reason"], ["status", "reason"]);
    if (value.reason !== "not_exposed" && value.reason !== "not_observed" && value.reason !== "redacted") {
      throw new OperationStateError("invalid_ownership_baseline", `${label}.reason is invalid.`);
    }
  }
}

function assertOwnershipTurnsShape(value: unknown, kind: "user" | "assistant", label: string): asserts value is readonly OwnershipTurn[] {
  if (!Array.isArray(value) || value.length > MAX_BASELINE_TURNS) {
    throw new OperationStateError("invalid_ownership_baseline", `${label} exceeds the bounded turn limit.`);
  }
  const stableIds = new Set<string>();
  const evidence = new Set<string>();
  value.forEach((turnValue, index) => {
    assertExactRecord(
      turnValue,
      `${label}[${index}]`,
      ["stableId", "evidenceDigest", "structureDigest", "ordinal", "parentStableId", "branchStableId", "state", "artifactEvidenceDigests"],
      ["evidenceDigest", "structureDigest", "ordinal"]
    );
    if (turnValue.ordinal !== index) throw new OperationStateError("invalid_ownership_baseline", `${label} ordinals must be contiguous.`);
    assertDigest(turnValue.evidenceDigest as string, `${label}[${index}].evidenceDigest`);
    assertDigest(turnValue.structureDigest as string, `${label}[${index}].structureDigest`);
    if (turnValue.stableId !== undefined) {
      assertStableIdentifier(turnValue.stableId, `${label}[${index}].stableId`);
      if (stableIds.has(turnValue.stableId)) throw new OperationStateError("invalid_ownership_baseline", `${label} contains duplicate stable IDs.`);
      stableIds.add(turnValue.stableId);
    }
    if (kind === "user" && (turnValue.state !== undefined || turnValue.parentStableId !== undefined || turnValue.branchStableId !== undefined)) {
      throw new OperationStateError("invalid_ownership_baseline", "User baseline turns cannot carry assistant lineage.");
    }
    if (kind === "assistant" && turnValue.state !== "generating" && turnValue.state !== "terminal") {
      throw new OperationStateError("invalid_ownership_baseline", "Assistant baseline turns require a bounded state.");
    }
    if (turnValue.parentStableId !== undefined) assertStableIdentifier(turnValue.parentStableId, `${label}[${index}].parentStableId`);
    if (turnValue.branchStableId !== undefined) assertStableIdentifier(turnValue.branchStableId, `${label}[${index}].branchStableId`);
    const artifacts = turnValue.artifactEvidenceDigests ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > MAX_BASELINE_ARTIFACTS_PER_TURN) {
      throw new OperationStateError("invalid_ownership_baseline", `${label}[${index}] artifacts exceed the bounded limit.`);
    }
    const artifactSet = new Set<string>();
    for (const artifact of artifacts) {
      assertDigest(artifact, `${label}[${index}].artifactEvidenceDigests[]`);
      if (artifactSet.has(artifact)) throw new OperationStateError("invalid_ownership_baseline", `${label}[${index}] has duplicate artifact evidence.`);
      artifactSet.add(artifact);
    }
    if (turnValue.stableId === undefined) {
      const turnEvidenceDigest = turnValue.evidenceDigest as string;
      if (evidence.has(turnEvidenceDigest)) throw new OperationStateError("invalid_ownership_baseline", `${label} has duplicate id-less evidence.`);
      evidence.add(turnEvidenceDigest);
    }
  });
}

function validateOwnershipBaselineValues(
  baseline: OperationOwnershipBaselineV1,
  state: OperationStateV1
): void {
  if (
    baseline.operationId !== state.operationId
    || baseline.requestDigest !== state.requestDigest
  ) throw new OperationStateError("ownership_baseline_identity_mismatch", "Ownership baseline operation identity does not match state.");
  const action = state.actions[baseline.actionId];
  if (action === undefined || (action.kind !== "send" && action.kind !== "work_steer")) {
    throw new OperationStateError("ownership_baseline_action_missing", "Ownership baseline requires a durable Send or steer action intent.");
  }
  if (action.targetDigest !== baseline.targetBindingDigest) {
    throw new OperationStateError("ownership_baseline_target_mismatch", "Ownership baseline target does not match its causal action.");
  }
  const target = state.target;
  if (target === undefined) throw new OperationStateError("target_not_bound", "Ownership baseline requires a durable target binding.");
  const identity = (value: OwnershipIdentityEvidence): string | undefined => value.status === "available" ? value.value : undefined;
  // A new-target baseline is intentionally captured before the provider
  // allocates conversation identity. Once establishment is durable, the
  // mutable target may contain a conversation ID/URL that the immutable
  // baseline could not have observed. Provider/browser/tab and coordination
  // identities remain stable and are still checked below.
  const fixedTarget = (target.targetLifecycle ?? "fixed") === "fixed";
  const baselineCanonicalThreadUrl = baseline.baseline.target.canonicalThreadUrl;
  // Work-steer preparation deliberately redacts the URL even when the
  // durable fixed target retains it. This is the one narrowly scoped
  // unavailable identity that may still prove ownership: all other URL
  // unavailability (and every other identity mismatch) remains a failure.
  const redactedWorkSteerUrl =
    action.kind === "work_steer"
    && baselineCanonicalThreadUrl.status === "unavailable"
    && baselineCanonicalThreadUrl.reason === "redacted";
  const canonicalThreadUrlMatches = !fixedTarget
    ? true
    : redactedWorkSteerUrl
      ? true
      : target.canonicalThreadUrl !== undefined
        ? baselineCanonicalThreadUrl.status === "available"
          && baselineCanonicalThreadUrl.value === target.canonicalThreadUrl
        // Preserve the historical optional URL behavior for Send, while a
        // fixed-target Work steer must still carry the mandated redaction.
        : action.kind !== "work_steer";
  if (
    identity(baseline.baseline.target.provider) !== target.providerId
    || identity(baseline.baseline.target.browser) !== target.browserId
    || identity(baseline.baseline.target.tab) !== target.tabId
    || baseline.baseline.target.coordinationScope !== target.coordinationScope
    || (fixedTarget && target.conversationId !== undefined && identity(baseline.baseline.target.conversation) !== target.conversationId)
    || !canonicalThreadUrlMatches
  ) {
    throw new OperationStateError("ownership_baseline_target_mismatch", "Ownership baseline target evidence disagrees with the durable target binding.");
  }
  const rejectedWorkSteer = action.kind === "work_steer" && action.outcome === "not_satisfied";
  if (action.outcome !== undefined && action.outcome !== "satisfied" && !rejectedWorkSteer) {
    throw new OperationStateError("ownership_baseline_action_unproven", "Ownership baseline cannot follow an uncertain or rejected action.");
  }
  if (baseline.observedAt < action.intentAt) {
    throw new OperationStateError("ownership_baseline_before_action", "Ownership baseline cannot precede its causal action intent.");
  }
}

function assertActionIntentShape(value: unknown): void {
  assertExactRecord(
    value,
    "operation action intent",
    ["actionId", "kind", "repeatPolicy", "requestDigest", "parentActionId", "targetDigest"],
    ["actionId", "kind", "repeatPolicy", "requestDigest"]
  );
}

function assertAttachmentRearmAuthorizationShape(value: unknown): void {
  assertExactRecord(
    value,
    "attachment rearm authorization",
    [
      "schemaVersion",
      "authorizationId",
      "actionId",
      "previousTargetBindingDigest",
      "targetBindingDigest",
      "authorizationEvidenceDigest",
      "authorizedAt"
    ],
    [
      "schemaVersion",
      "authorizationId",
      "actionId",
      "previousTargetBindingDigest",
      "targetBindingDigest",
      "authorizationEvidenceDigest",
      "authorizedAt"
    ]
  );
}

function assertAttachmentRearmShape(value: unknown): void {
  assertExactRecord(
    value,
    "attachment rearm",
    [
      "schemaVersion",
      "authorizationId",
      "actionId",
      "previousTargetBindingDigest",
      "targetBindingDigest",
      "authorizationEvidenceDigest",
      "authorizedRevision",
      "authorizedAt",
      "attemptIntentRevision",
      "attemptIntentAt",
      "preflightEvidenceDigest"
    ],
    [
      "schemaVersion",
      "authorizationId",
      "actionId",
      "previousTargetBindingDigest",
      "targetBindingDigest",
      "authorizationEvidenceDigest",
      "authorizedRevision",
      "authorizedAt"
    ]
  );
}

function assertActionRecordShape(value: unknown): void {
  assertExactRecord(
    value,
    "operation action record",
    [
      "actionId",
      "kind",
      "repeatPolicy",
      "requestDigest",
      "parentActionId",
      "targetDigest",
      "intentRevision",
      "intentAt",
      "outcome",
      "receiptRevision",
      "receiptAt",
      "evidenceDigest",
      "blockerCode"
    ],
    ["actionId", "kind", "repeatPolicy", "requestDigest", "intentRevision", "intentAt"]
  );
}

function assertBlockerObservationShape(value: unknown): void {
  assertExactRecord(
    value,
    "operation blocker observation",
    ["code", "messageDigest", "recoverable", "observedAt"],
    ["code", "messageDigest", "recoverable", "observedAt"]
  );
}

function assertReceiptShape(value: unknown): void {
  assertExactRecord(
    value,
    "operation receipt",
    [
      "schemaVersion",
      "operationId",
      "requestDigest",
      "targetBindingDigest",
      "userTurnId",
      "userTurnEvidenceDigest",
      "assistantTurnId",
      "ownershipEvidenceDigest",
      "responseDigest",
      "responseBytes",
      "responseFormat",
      "finishReason",
      "contentAvailable",
      "artifacts",
      "completedAt"
    ],
    [
      "schemaVersion",
      "operationId",
      "requestDigest",
      "targetBindingDigest",
      "userTurnId",
      "userTurnEvidenceDigest",
      "assistantTurnId",
      "ownershipEvidenceDigest",
      "finishReason",
      "contentAvailable",
      "artifacts",
      "completedAt"
    ]
  );
  const receipt = value as Record<string, unknown>;
  if (receipt.responseFormat !== undefined && receipt.responseFormat !== "markdown" && receipt.responseFormat !== "text") {
    throw new OperationStateError("invalid_response_format", "Operation receipt responseFormat must be markdown or text.");
  }
  if (!Array.isArray(receipt.artifacts)) {
    throw new OperationStateError("invalid_operation_receipt", "Operation receipt artifacts must be an array.");
  }
  for (const artifact of receipt.artifacts) assertArtifactShape(artifact);
}

function assertArtifactShape(value: unknown): void {
  assertExactRecord(
    value,
    "operation artifact receipt",
    [
      "schemaVersion",
      "operationId",
      "artifactKey",
      "assistantTurnId",
      "sourceIdentityDigest",
      "kind",
      "ordinal",
      "outputKey",
      "mimeType",
      "bytes",
      "sha256",
      "status",
      "blockerCode"
    ],
    ["schemaVersion", "operationId", "artifactKey", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "status"]
  );
}

/** Validate the closed, path-free policy carried by creation/state records. */
export function assertDurableCapturePolicyShape(value: unknown): asserts value is OperationDurableCapturePolicyV1 {
  assertExactRecord(
    value,
    "operation durable capture policy",
    ["responseContent", "responseFormat", "artifacts"],
    ["responseContent", "responseFormat", "artifacts"]
  );
  const policy = value as Record<string, unknown>;
  // Do not invoke hostile accessors while validating a durable boundary.
  for (const key of ["responseContent", "responseFormat", "artifacts"] as const) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(policy, key);
    } catch {
      throw new OperationStateError("invalid_operation_shape", "Operation durable capture policy could not be read safely.");
    }
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new OperationStateError("invalid_operation_shape", "Operation durable capture policy contains an unsafe property.");
    }
  }
  if (policy.responseContent !== "include" && policy.responseContent !== "metadata") {
    throw new OperationStateError("invalid_capture_policy", "Operation durable capture responseContent is invalid.");
  }
  if (policy.responseFormat !== "markdown" && policy.responseFormat !== "text") {
    throw new OperationStateError("invalid_capture_policy", "Operation durable capture responseFormat is invalid.");
  }
  if (policy.artifacts !== "receipt_only" && policy.artifacts !== "transfer") {
    throw new OperationStateError("invalid_capture_policy", "Operation durable capture artifacts policy is invalid.");
  }
}

function assertExactRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
  allowUnknownUntilTypeDispatch = false
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new OperationStateError("invalid_operation_shape", `${label} must be a plain object.`);
  }
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new OperationStateError("invalid_operation_shape", `${label} contains an unreadable property.`);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new OperationStateError("invalid_operation_shape", `${label} contains an unsafe property (accessor).`);
    }
  }
  if (!allowUnknownUntilTypeDispatch) {
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        throw new OperationStateError("unknown_operation_field", `${label} contains unsupported field ${key}.`);
      }
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new OperationStateError("missing_operation_field", `${label} is missing required field ${key}.`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
