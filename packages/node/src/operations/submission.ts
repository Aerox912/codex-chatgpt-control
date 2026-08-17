import type {
  MutationBoundary,
  OperationActionRecordV1,
  OperationActionOutcome,
  OperationHandleV1,
  OperationOwnershipBaselineV1,
  OperationPhase,
  OperationSubmissionWitnessV1,
  OperationStateV1,
  OperationSurface
} from "./types.js";
import type { OwnershipBaseline } from "./turn-ownership.js";
import { assertDurableCapturePolicyShape, assertOwnershipBaselineShape } from "./state-machine.js";
import {
  OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION
} from "./types.js";

/**
 * The submission coordinator is deliberately an adapter-free core.  A
 * browser adapter owns all DOM/page primitives and supplies only these
 * bounded, already-redacted observations and transactions.  In particular,
 * prompt text, local paths, display names, and file bytes never cross this
 * interface.
 */

const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}$/;
const FINISH_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ATTACHMENTS = 256;
// Keep the adapter boundary aligned with the shared receipt contract and the
// central state-machine validator.  A looser limit here would let a malformed
// durable receipt bypass the operation service's first validation boundary.
const MAX_RECEIPT_ARTIFACTS = 32;
// Keep the absolute deadline in the representable, unambiguous ISO date
// range while rejecting numeric sentinels such as MAX_SAFE_INTEGER.
const MAX_DEADLINE_AT = Date.UTC(2100, 0, 1);
const POST_HANDOFF_OBSERVATION_ATTEMPTS = 20;
const POST_HANDOFF_OBSERVATION_INTERVAL_MS = 150;
// The fail-closed blocker branch still has to carry the public operation
// identity shape.  These markers are deliberately not UUIDs/digests, so
// malformed or absent evidence cannot masquerade as authenticated identity.
const INVALID_OPERATION_ID = "invalid-operation";
const INVALID_DIGEST = "invalid-digest";
const PHASES = new Set<OperationPhase>([
  "prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed", "uncertain"
]);
const BOUNDARIES = new Set<MutationBoundary>([
  "none", "handoff_may_have_occurred", "send_may_have_occurred", "control_may_have_occurred"
]);
const BOUNDARY_RANK: Readonly<Record<MutationBoundary, number>> = Object.freeze({
  none: 0,
  handoff_may_have_occurred: 1,
  send_may_have_occurred: 2,
  control_may_have_occurred: 3
});

export type SubmissionAttachmentIdentity = Readonly<{
  identityDigest: string;
  ordinal: number;
}>;

export type SubmissionExpectedEnvelope = Readonly<{
  surface: OperationSurface;
  targetBindingDigest: string;
  configurationReceiptDigest: string;
  composerReceiptDigest: string;
  attachmentManifest: Readonly<{
    count: number;
    orderPolicy: "exact";
    identities: readonly SubmissionAttachmentIdentity[];
  }>;
}>;

export type SubmissionActionIds = Readonly<{
  /** Required when the operation has not yet recorded a Send intent. */
  sendActionId: string;
  /** Required when files need a new handoff intent. */
  fileHandoffActionId?: string;
}>;

export type SubmissionOperationSnapshot = Readonly<{
  state: Readonly<OperationStateV1>;
  handle: Readonly<OperationHandleV1>;
  actionIds: SubmissionActionIds;
}>;

export type SubmissionStageRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  targetBindingDigest: string;
  configurationReceiptDigest: string;
  composerReceiptDigest: string;
}>;

export type SubmissionStageObservation = Readonly<
  | { status: "exact"; evidenceDigest: string }
  | { status: "mismatch"; reason: "target" | "configuration" | "composer" | "unknown"; evidenceDigest?: string }
  | { status: "unavailable"; reason: "target" | "configuration" | "composer" | "unknown"; evidenceDigest?: string }
>;

export type SubmissionAttachmentObservation = Readonly<
  | {
      status: "absent";
      evidenceDigest: string;
      count: 0;
      orderPolicy: "exact";
      identityDigests: readonly [];
    }
  | {
      status: "exact";
      evidenceDigest: string;
      count: number;
      orderPolicy: "exact";
      identityDigests: readonly string[];
    }
  | { status: "mismatch" | "delayed" | "ambiguous" | "unavailable"; evidenceDigest?: string }
>;

export type SubmissionAttachmentRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  targetBindingDigest: string;
  manifest: SubmissionExpectedEnvelope["attachmentManifest"];
}>;

export type SubmissionIntentRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  kind: "file_handoff" | "send";
  repeatPolicy: "observe_only_after_intent";
  targetBindingDigest: string;
}>;

export type SubmissionHandoffRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  targetBindingDigest: string;
  manifest: SubmissionExpectedEnvelope["attachmentManifest"];
  /** Request-local cancellation; never serialized or persisted. */
  signal?: AbortSignal;
  /** Absolute request deadline; never serialized or persisted. */
  deadlineAt?: number;
}>;

export type SubmissionHandoffResult = Readonly<
  | { status: "satisfied"; evidenceDigest: string }
  | { status: "not_satisfied"; blockerCode?: SubmissionBlockerCode; evidenceDigest?: string }
  | { status: "uncertain"; evidenceDigest?: string; quarantine: "provider" | "caller" }
>;

export type SubmissionFinalTransactionRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  mode: "mutate_once" | "observe_only";
  /** A sanitized clone; adapters must not receive the original request object. */
  expected: SubmissionExpectedEnvelope;
  /** Durable pre-Send baseline supplied before the sole activation. */
  persistPreSendBaseline?: (baseline: OwnershipBaseline) => Promise<void>;
  /** Existing durable baseline used by observation-only recovery. */
  durableBaseline?: OwnershipBaseline;
  /** Request cancellation/deadline are propagated to the short tab/read probes. */
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

/**
 * Request-local, adapter-owned Send preparation.  `prepared` is an opaque
 * capability owned by the browser adapter; the submission journal never
 * receives it.  Only the complete redacted ownership baseline crosses the
 * atomic persistence boundary below.
 */
export type SubmissionPrepareSendRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

export type SubmissionPreparedSend = Readonly<{
  /** Opaque request-local adapter capability; never serialize or journal. */
  prepared: unknown;
  baseline: OwnershipBaseline;
  evidenceDigest: string;
}>;

export type SubmissionPrepareSendResult = Readonly<
  | { status: "prepared"; prepared: SubmissionPreparedSend }
  | { status: "blocked"; result: Extract<SubmissionFinalTransactionResult, { status: "blocked" }> }
>;

/**
 * The sole durable Send boundary.  `executeAllowed: false` means another
 * caller already committed the same action; the caller must recover and may
 * not invoke the browser mutation.
 */
export type SubmissionPreparedSendPersistenceRequest = Readonly<{
  operationId: string;
  /** Parent operation digest used to address the durable journal. */
  durableRequestDigest: string;
  /** Action request identity; normally equal to durableRequestDigest for Send. */
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  kind: "send";
  repeatPolicy: "observe_only_after_intent";
  targetBindingDigest: string;
  baseline: OwnershipBaseline;
}>;

export type SubmissionPreparedSendPersistenceResult = Readonly<
  | { status: "committed"; executeAllowed: boolean }
  | { status: "not_committed"; blockerCode?: SubmissionBlockerCode; evidenceDigest?: string }
  | { status: "uncertain"; evidenceDigest?: string }
>;

export type SubmissionExecutePreparedSendRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  prepared: SubmissionPreparedSend;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

export type SubmissionExecutePreparedSendResult = Readonly<
  | { status: "activated" | "activation_threw"; activation: "activated" | "activation_threw"; mutationMayHaveOccurred: true }
  | { status: "blocked"; result: Extract<SubmissionFinalTransactionResult, { status: "blocked" }> }
  | { status: "uncertain"; result: Extract<SubmissionFinalTransactionResult, { status: "uncertain" }> }
>;

export type SubmissionVerifyPreparedSendRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  prepared: SubmissionPreparedSend;
  activation: "activated" | "activation_threw";
  mutationMayHaveOccurred: true;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

export type SubmissionRecoverSendRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  durableBaseline: OwnershipBaseline;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

/** Redacted provider identity proof returned by the post-Send observer. */
export type SubmissionTargetEstablishmentObservation = Readonly<{
  targetBindingDigest: string;
  anchorDigest: string;
  causalSendActionId: string;
  conversationId: string;
  canonicalThreadUrl: string;
  userTurnId: string;
  userTurnEvidenceDigest: string;
  postSendDeltaDigest?: string;
  evidenceDigest: string;
  observedAt?: string;
}>;

export type SubmissionTargetEstablishmentRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  targetBindingDigest: string;
  anchorDigest: string;
  causalSendActionId: string;
  conversationId: string;
  canonicalThreadUrl: string;
  userTurnId: string;
  userTurnEvidenceDigest: string;
  postSendDeltaDigest?: string;
  evidenceDigest: string;
  observedAt?: string;
}>;

export type SubmissionFinalTransactionResult = Readonly<
  | {
      status: "submitted" | "already_submitted";
      targetBindingDigest: string;
      evidenceDigest: string;
      userTurnId: string;
      userTurnEvidenceDigest: string;
      /** Exact before/after user-turn delta proof for the original Send. */
      postSendDeltaDigest?: string;
      assistantTurnId?: string;
      targetEstablishment?: SubmissionTargetEstablishmentObservation;
    }
  | {
      status: "blocked";
      blockerCode: SubmissionBlockerCode;
      evidenceDigest?: string;
    }
  | {
      status: "uncertain";
      evidenceDigest?: string;
      quarantine: "provider" | "caller";
    }
>;

export type SubmissionPhaseEvidence = Readonly<{
  kind: "phase";
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  phase: "ready";
  mutationBoundary: MutationBoundary;
  targetBindingDigest: string;
  evidenceDigest: string;
  actionId?: string;
  actionOutcome?: OperationActionOutcome;
}>;

export type SubmissionReceiptEvidence = Readonly<{
  kind: "receipt";
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  phase: "submitted";
  mutationBoundary: "send_may_have_occurred";
  targetBindingDigest: string;
  evidenceDigest: string;
  userTurnId: string;
  userTurnEvidenceDigest: string;
  postSendDeltaDigest: string;
  observedAt?: string;
  assistantTurnId?: string;
}>;

export type SubmissionBlockerEvidence = Readonly<{
  kind: "blocker";
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  phase: OperationPhase;
  mutationBoundary: MutationBoundary;
  /** Absent only for a blocker observed before target binding. */
  targetBindingDigest?: string;
  blocker: SubmissionBlocker;
}>;

export type SubmissionPersistenceRequest = SubmissionPhaseEvidence | SubmissionReceiptEvidence | SubmissionBlockerEvidence;

export type SubmissionPorts = Readonly<{
  /** Observe the exact target/configuration/composer values without mutating. */
  observeStaging(request: SubmissionStageRequest): Promise<SubmissionStageObservation>;
  /** Persist one non-repeatable file-handoff intent before its browser mutation starts. */
  persistActionIntent(request: SubmissionIntentRequest): Promise<void>;
  /** One file handoff attempt.  The adapter must settle or explicitly quarantine before resolving. */
  executeFileHandoffOnce(request: SubmissionHandoffRequest): Promise<SubmissionHandoffResult>;
  /** Bounded observation of exact attachment identity/count/order postconditions. */
  observeAttachments(request: SubmissionAttachmentRequest): Promise<SubmissionAttachmentObservation>;
  /**
   * Read-only Send preparation.  The returned provider capability remains
   * request-local and is never accepted by a journal port.
   */
  prepareSend?: (request: SubmissionPrepareSendRequest) => Promise<SubmissionPrepareSendResult>;
  /** Atomic action-intent plus complete ownership-baseline persistence. */
  persistPreparedSend?: (request: SubmissionPreparedSendPersistenceRequest) => Promise<SubmissionPreparedSendPersistenceResult>;
  /** Execute the one prepared Send activation; this port must not persist. */
  executePreparedSend?: (request: SubmissionExecutePreparedSendRequest) => Promise<SubmissionExecutePreparedSendResult>;
  /** Read-only verification after the prepared activation settles. */
  verifyPreparedSend?: (request: SubmissionVerifyPreparedSendRequest) => Promise<SubmissionFinalTransactionResult>;
  /** Read-only restart recovery anchored to the durable per-action baseline. */
  recoverSend?: (request: SubmissionRecoverSendRequest) => Promise<SubmissionFinalTransactionResult>;
  /**
   * Legacy final transaction surface retained for source compatibility only.
   * runAtomicSubmission never uses it for Send because it cannot prove the
   * atomic intent+baseline boundary.
   */
  executeFinalTabTransaction: (request: SubmissionFinalTransactionRequest) => Promise<SubmissionFinalTransactionResult>;
  /** @deprecated Old split baseline callback; never used by the atomic Send path. */
  persistOwnershipBaseline?: (request: Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    actionId: string;
    baseline: OwnershipBaseline;
  }>) => Promise<void>;
  /** Persist a provider-assigned identity before the submitted phase/receipt. */
  establishTarget?: (request: SubmissionTargetEstablishmentRequest) => Promise<unknown>;
  /** Persist redacted phase/receipt/blocker evidence; never accepts raw request fields. */
  persistReceiptEvidence(request: SubmissionPersistenceRequest): Promise<void>;
}>;

export type SubmissionBlockerCode =
  | "operation_cancelled"
  | "operation_timeout"
  | "stale_handle"
  | "operation_state_corrupt"
  | "target_binding_mismatch"
  | "target_evidence_unavailable"
  | "configuration_drift"
  | "composer_drift"
  | "attachment_manifest_mismatch"
  | "input_file_changed"
  | "ambiguous_file_handoff"
  | "ambiguous_submit"
  | "concurrent_user_turn"
  | "send_control_unavailable"
  | "tab_ownership_conflict"
  | "runtime_incompatible"
  | "backend_unavailable"
  | "browser_bridge_unavailable"
  | "login_required"
  | "captcha"
  | "rate_limited"
  | "permission_required"
  | "needs_confirmation"
  | "selector_drift"
  | "journal_unavailable"
  | "port_protocol_violation"
  | "already_completed";

export type SubmissionBlocker = Readonly<{
  code: SubmissionBlockerCode;
  evidenceDigest?: string;
  /** Whether a caller may ask for a read-only observation. Never means retry the mutation. */
  observationRequired: boolean;
  mutationBoundary: MutationBoundary;
}>;

type SubmissionResultIdentity = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
}>;

type SubmissionResultBase = SubmissionResultIdentity & Readonly<{
  targetBindingDigest: string;
}>;

type SubmissionBlockerResultBase = SubmissionResultIdentity & Readonly<{
  /** Absent only when target resolution failed before a durable binding existed. */
  targetBindingDigest?: string;
}>;

export type SubmissionResult =
  | (SubmissionResultBase & Readonly<{
      kind: "submitted";
      actionId: string;
      evidenceDigest: string;
      userTurnId: string;
      userTurnEvidenceDigest: string;
      assistantTurnId?: string;
    }>)
  | (SubmissionResultBase & Readonly<{
      kind: "already_submitted";
      actionId?: string;
      evidenceDigest: string;
      userTurnId: string;
      userTurnEvidenceDigest: string;
      assistantTurnId?: string;
    }>)
  | (SubmissionResultBase & Readonly<{
      /** A terminal durable receipt using its dedicated user-turn evidence. */
      kind: "completed_receipt";
      actionId?: string;
      evidenceDigest: string;
      userTurnId: string;
      userTurnEvidenceDigest: string;
      assistantTurnId: string;
    }>)
  | (SubmissionBlockerResultBase & Readonly<{
      kind: "cancelled";
      blocker: SubmissionBlocker & Readonly<{ code: "operation_cancelled" | "operation_timeout" }>;
    }>)
  | (SubmissionBlockerResultBase & Readonly<{
      kind: "blocked";
      blocker: SubmissionBlocker;
    }>)
  | (SubmissionBlockerResultBase & Readonly<{
      kind: "uncertain";
      blocker: SubmissionBlocker;
    }>);

export class SubmissionInputError extends Error {
  constructor(public readonly code: SubmissionBlockerCode, message: string) {
    super(message);
    this.name = "SubmissionInputError";
  }
}

/**
 * Execute one operation-aware submission.  All non-repeatable calls are
 * preceded by a durable intent and all ambiguous outcomes become observation
 * only.  This function intentionally does not generate operation or action
 * IDs; callers must provide the durable action IDs.
 */
export async function runAtomicSubmission(
  operation: SubmissionOperationSnapshot,
  expected: SubmissionExpectedEnvelope,
  ports: SubmissionPorts,
  options: Readonly<{ signal?: AbortSignal; deadlineAt?: number }> = {}
): Promise<SubmissionResult> {
  const identity = safeIdentity(operation);
  let envelope: SubmissionExpectedEnvelope;
  try {
    envelope = validateInput(operation, expected, ports, options);
  } catch (error) {
    const code = error instanceof SubmissionInputError ? error.code : "port_protocol_violation";
    return blockedResult(identity, expected, code, false);
  }

  const base: SubmissionResultBase = {
    operationId: operation.state.operationId,
    requestDigest: operation.state.requestDigest,
    surface: operation.state.surface,
    targetBindingDigest: envelope.targetBindingDigest
  };
  const initialCancellation = cancellationCode(options);
  if (initialCancellation !== undefined) return cancelledResult(base, initialCancellation, operation.state.mutationBoundary);

  const sendAction = findUniqueAction(operation.state, "send");
  const handoffAction = findUniqueAction(operation.state, "file_handoff");
  if (sendAction === "corrupt" || handoffAction === "corrupt") {
    return blockedBase(base, "operation_state_corrupt", false, operation.state.mutationBoundary);
  }
  if (
    sendAction !== undefined && operation.actionIds.sendActionId !== sendAction.actionId
    || handoffAction !== undefined && operation.actionIds.fileHandoffActionId !== handoffAction.actionId
  ) {
    return blockedBase(base, "operation_state_corrupt", false, operation.state.mutationBoundary);
  }
  if (!coherentSubmissionState(operation.state, sendAction, handoffAction, envelope.targetBindingDigest, envelope.attachmentManifest.count)) {
    return blockedBase(base, "operation_state_corrupt", false, operation.state.mutationBoundary);
  }
  if (!targetBindingMatches(operation, envelope)) {
    return blockedBase(base, "target_binding_mismatch", false, operation.state.mutationBoundary);
  }
  const requiresTargetEstablishment = operation.state.target?.targetLifecycle === "new_pending";
  const durableBaseline = sendAction === undefined
    ? operation.state.ownershipBaseline?.baseline
    : (operation.state.ownershipBaselines?.[sendAction.actionId]?.baseline ?? operation.state.ownershipBaseline?.baseline);

  // A durable receipt is already an idempotent observation.  Do not touch the
  // browser, even to "confirm" an operation the journal says is complete.
  if (operation.state.receipt !== undefined) {
    const receipt = operation.state.receipt;
    if (
      operation.state.phase !== "completed" ||
      receipt.operationId !== base.operationId ||
      receipt.requestDigest !== base.requestDigest ||
      receipt.targetBindingDigest !== envelope.targetBindingDigest ||
      !isSafeId(receipt.userTurnId) ||
      !isSafeId(receipt.assistantTurnId) ||
      !isDigest(receipt.ownershipEvidenceDigest) ||
      !isDigest(receipt.userTurnEvidenceDigest)
    ) {
      return blockedBase(base, "operation_state_corrupt", false, operation.state.mutationBoundary);
    }
    return {
      ...base,
      kind: "completed_receipt",
      evidenceDigest: receipt.ownershipEvidenceDigest,
      userTurnId: receipt.userTurnId,
      userTurnEvidenceDigest: receipt.userTurnEvidenceDigest,
      ...(sendAction === undefined ? {} : { actionId: sendAction.actionId }),
      assistantTurnId: receipt.assistantTurnId
    };
  }

  // Once a Send intent is durable, recovery is observation-only.  It must not
  // inspect or refill the composer/configuration/attachments first: those
  // surfaces may legitimately have changed after the provider accepted Send.
  if (sendAction !== undefined) {
    if (durableBaseline === undefined) {
      // Legacy records may still be readable, but they cannot authorize a
      // restart observation because the exact pre-Send ownership anchor is
      // absent. Never let this branch fall back to a current page snapshot.
      return blockedBase(base, "target_evidence_unavailable", true, "send_may_have_occurred");
    }
    return reconcileExistingSend(base, envelope, sendAction, ports, { ...options, durableBaseline }, requiresTargetEstablishment);
  }

  const staging = await observeStaging(base, envelope, ports);
  if (staging.kind !== "ok") return staging.result;

  let readyEvidenceDigest = staging.evidenceDigest;
  let readyBoundary: MutationBoundary = operation.state.mutationBoundary;
  let readyActionId: string | undefined;

  if (envelope.attachmentManifest.count > 0) {
    const attachments = await ensureAttachments(base, envelope, operation, handoffAction, ports, options);
    if (attachments.kind !== "ok") return attachments.result;
    readyEvidenceDigest = attachments.evidenceDigest;
    readyBoundary = attachments.mutationBoundary;
    readyActionId = attachments.actionId;
  } else if (handoffAction !== undefined) {
    return blockedBase(base, "operation_state_corrupt", false, operation.state.mutationBoundary);
  }

  if (
    operation.state.phase !== "prepared"
    && operation.state.phase !== "ready"
    && !(handoffAction !== undefined && (operation.state.phase === "handoff_pending" || operation.state.phase === "uncertain"))
  ) {
    return blockedBase(base, "stale_handle", false, operation.state.mutationBoundary);
  }
  if (operation.state.phase !== "ready") {
    const handoffTransitionEvidence = readyActionId === undefined
      ? {}
      : handoffAction?.outcome === "satisfied"
        ? { actionId: readyActionId }
        : { actionId: readyActionId, actionOutcome: "satisfied" as const };
    try {
      await ports.persistReceiptEvidence({
        kind: "phase",
        operationId: base.operationId,
        requestDigest: base.requestDigest,
        surface: base.surface,
        phase: "ready",
        mutationBoundary: readyBoundary,
        targetBindingDigest: envelope.targetBindingDigest,
        evidenceDigest: readyEvidenceDigest,
        ...handoffTransitionEvidence
      });
    } catch {
      return readyBoundary === "none"
        ? blockedBase(base, "journal_unavailable", false, readyBoundary)
        : uncertainBase(base, "journal_unavailable", readyBoundary);
    }
  }
  const preSendCancellation = cancellationCode(options);
  if (preSendCancellation !== undefined) return cancelledResult(base, preSendCancellation, readyBoundary);

  const sendActionId = operation.actionIds.sendActionId;
  const sendPorts = requirePreparedSendPorts(ports);
  if (sendPorts !== undefined) return blockedBase(base, sendPorts, readyBoundary !== "none", readyBoundary);

  // Phase 1: read-only provider preparation.  The opaque provider capability
  // stays in request-local memory; only its complete redacted baseline may
  // cross the next boundary.
  let preparedResult: SubmissionPrepareSendResult;
  try {
    preparedResult = await ports.prepareSend!({
      operationId: base.operationId,
      requestDigest: base.requestDigest,
      surface: base.surface,
      actionId: sendActionId,
      expected: cloneExpectedEnvelope(envelope),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
    });
    validatePrepareSendResult(preparedResult, base, envelope, sendActionId);
  } catch {
    return blockedBase(base, "port_protocol_violation", readyBoundary !== "none", readyBoundary);
  }
  if (preparedResult.status === "blocked") {
    return blockedBase(base, preparedResult.result.blockerCode, readyBoundary !== "none", readyBoundary, preparedResult.result.evidenceDigest);
  }
  const prepared = preparedResult.prepared;
  const prePersistenceCancellation = cancellationCode(options);
  if (prePersistenceCancellation !== undefined) return cancelledResult(base, prePersistenceCancellation, readyBoundary);

  // Phase 2: one atomic durable event containing both the Send intent and the
  // complete pre-Send baseline.  No browser actor is held by this call.
  let persistence: SubmissionPreparedSendPersistenceResult;
  try {
    persistence = await ports.persistPreparedSend!({
      operationId: base.operationId,
      durableRequestDigest: base.requestDigest,
      requestDigest: base.requestDigest,
      surface: base.surface,
      actionId: sendActionId,
      kind: "send",
      repeatPolicy: "observe_only_after_intent",
      targetBindingDigest: envelope.targetBindingDigest,
      baseline: cloneOwnershipBaseline(prepared.baseline)
    });
    validatePreparedSendPersistenceResult(persistence);
  } catch {
    // A journal port is responsible for converging a commit-then-throw by
    // rereading the action+baseline prefix. If it cannot establish that
    // result, quarantine the durable mutation boundary and never retry here.
    return uncertainBase(base, "journal_unavailable", "send_may_have_occurred");
  }
  if (persistence.status === "not_committed") {
    return blockedBase(
      base,
      persistence.blockerCode ?? "journal_unavailable",
      readyBoundary !== "none",
      readyBoundary,
      persistence.evidenceDigest
    );
  }
  if (persistence.status === "uncertain") {
    return uncertainBase(base, "journal_unavailable", "send_may_have_occurred", persistence.evidenceDigest);
  }
  const cancellationAfterPreparedSend = cancellationCode(options);
  if (cancellationAfterPreparedSend !== undefined) {
    return uncertainBase(base, cancellationAfterPreparedSend, "send_may_have_occurred");
  }

  // A concurrent caller that already committed this action is observation
  // only. It must not invoke executePreparedSend, even if this caller also
  // completed an equivalent read-only prepare.
  if (!persistence.executeAllowed) {
    return await reconcileExistingSend(
      base,
      envelope,
      {
        actionId: sendActionId,
        kind: "send",
        repeatPolicy: "observe_only_after_intent",
        requestDigest: base.requestDigest,
        targetDigest: envelope.targetBindingDigest,
        intentRevision: operation.state.revision + 1,
        intentAt: new Date().toISOString()
      },
      ports,
      { ...options, durableBaseline: prepared.baseline },
      requiresTargetEstablishment
    );
  }

  // Phase 3: execute exactly once. This port owns only the final recheck and
  // activation; it cannot persist and cannot poll while holding a tab actor.
  let execution: SubmissionExecutePreparedSendResult;
  try {
    execution = await ports.executePreparedSend!({
      operationId: base.operationId,
      requestDigest: base.requestDigest,
      surface: base.surface,
      actionId: sendActionId,
      expected: cloneExpectedEnvelope(envelope),
      prepared,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
    });
    validateExecutePreparedSendResult(execution, envelope);
  } catch {
    execution = { status: "uncertain", result: { status: "uncertain", quarantine: "caller" } };
  }

  if (execution.status === "blocked") {
    const evidence = blockerEvidence(base, envelope, execution.result.blockerCode, execution.result.evidenceDigest);
    await persistBlockerBestEffort(ports, evidence);
    return blockedBase(base, execution.result.blockerCode, true, "send_may_have_occurred", execution.result.evidenceDigest);
  }

  // Phase 4: verify/reconcile in a read-only port. This runs for both a
  // successful activation and an acts-then-throws/unknown execution result;
  // it is never allowed to call executePreparedSend again.
  const verification = await verifyPreparedSendSafely(
    base,
    envelope,
    sendActionId,
    prepared,
    execution.status === "uncertain" ? "activation_threw" : execution.activation,
    ports,
    options
  );
  if (verification.status === "submitted" || verification.status === "already_submitted") {
    return await finishObserved(base, envelope, sendActionId, verification, ports, requiresTargetEstablishment);
  }
  const cancellationAfterExecution = cancellationCode(options);
  const verificationCode = cancellationAfterExecution ?? (verification.status === "blocked" ? verification.blockerCode : "ambiguous_submit");
  await persistBlockerBestEffort(ports, blockerEvidence(base, envelope, verificationCode, verification.evidenceDigest));
  return uncertainBase(base, verificationCode, "send_may_have_occurred", verification.evidenceDigest);
}

async function observeStaging(
  base: SubmissionResultBase,
  expected: SubmissionExpectedEnvelope,
  ports: SubmissionPorts
): Promise<{ kind: "ok"; evidenceDigest: string } | { kind: "result"; result: SubmissionResult }> {
  const request: SubmissionStageRequest = {
    operationId: base.operationId,
    requestDigest: base.requestDigest,
    surface: base.surface,
    targetBindingDigest: expected.targetBindingDigest,
    configurationReceiptDigest: expected.configurationReceiptDigest,
    composerReceiptDigest: expected.composerReceiptDigest
  };
  let observed: SubmissionStageObservation;
  try {
    observed = await ports.observeStaging(request);
    validateStageObservation(observed);
  } catch {
    return { kind: "result", result: blockedBase(base, "port_protocol_violation", false, "none") };
  }
  if (observed.status === "exact") return { kind: "ok", evidenceDigest: observed.evidenceDigest };
  if (observed.status === "unavailable") {
    return {
      kind: "result",
      result: blockedBase(base, observed.reason === "target" ? "target_evidence_unavailable" : "port_protocol_violation", false, "none", observed.evidenceDigest)
    };
  }
  return {
    kind: "result",
    result: blockedBase(base, stageReasonToBlocker(observed.reason), false, "none", observed.evidenceDigest)
  };
}

async function ensureAttachments(
  base: SubmissionResultBase,
  expected: SubmissionExpectedEnvelope,
  operation: SubmissionOperationSnapshot,
  existingHandoff: OperationActionRecordV1 | undefined,
  ports: SubmissionPorts,
  options: Readonly<{ signal?: AbortSignal; deadlineAt?: number }>
): Promise<{ kind: "ok"; evidenceDigest: string; mutationBoundary: MutationBoundary; actionId?: string } | { kind: "result"; result: SubmissionResult }> {
  const request: SubmissionAttachmentRequest = {
    operationId: base.operationId,
    requestDigest: base.requestDigest,
    surface: base.surface,
    targetBindingDigest: expected.targetBindingDigest,
    manifest: cloneManifest(expected.attachmentManifest)
  };
  let observed: SubmissionAttachmentObservation;
  try {
    observed = await ports.observeAttachments(request);
    validateAttachmentObservation(observed, expected.attachmentManifest);
  } catch {
    return { kind: "result", result: blockedBase(base, "port_protocol_violation", false, "none") };
  }
  if (existingHandoff !== undefined && (
    existingHandoff.targetDigest !== expected.targetBindingDigest ||
    existingHandoff.requestDigest !== base.requestDigest ||
    existingHandoff.repeatPolicy !== "observe_only_after_intent"
  )) {
    return { kind: "result", result: blockedBase(base, "operation_state_corrupt", true, "handoff_may_have_occurred") };
  }
  if (observed.status === "exact") {
    return {
      kind: "ok",
      evidenceDigest: observed.evidenceDigest,
      mutationBoundary: existingHandoff === undefined ? "none" : "handoff_may_have_occurred",
      ...(existingHandoff === undefined ? {} : { actionId: existingHandoff.actionId })
    };
  }
  // A delayed, ambiguous, or unavailable postcondition may represent a
  // handoff already in flight by another actor.  Without a durable intent in
  // this operation, do not guess and start a duplicate non-repeatable call.
  // The adapter can retry this read-only observation later.
  if (existingHandoff === undefined && observed.status !== "absent") {
    return {
      kind: "result",
      result: blockedBase(
        base,
        observed.status === "unavailable" ? "target_evidence_unavailable" : "attachment_manifest_mismatch",
        false,
        "none",
        observed.evidenceDigest
      )
    };
  }

  let handoff = existingHandoff;
  if (handoff === undefined) {
    const actionId = operation.actionIds.fileHandoffActionId;
    if (actionId === undefined) {
      return { kind: "result", result: blockedBase(base, "operation_state_corrupt", false, "none") };
    }
    const cancellation = cancellationCode(options);
    if (cancellation !== undefined) return { kind: "result", result: cancelledResult(base, cancellation, "none") };
    try {
      await ports.persistActionIntent({
        operationId: base.operationId,
        requestDigest: base.requestDigest,
        surface: base.surface,
        actionId,
        kind: "file_handoff",
        repeatPolicy: "observe_only_after_intent",
        targetBindingDigest: expected.targetBindingDigest
      });
    } catch {
      return { kind: "result", result: blockedBase(base, "journal_unavailable", false, "none") };
    }
    const cancellationAfterHandoffIntent = cancellationCode(options);
    if (cancellationAfterHandoffIntent !== undefined) {
      return {
        kind: "result",
        result: uncertainBase(base, cancellationAfterHandoffIntent, "handoff_may_have_occurred")
      };
    }
    handoff = {
      actionId,
      kind: "file_handoff",
      repeatPolicy: "observe_only_after_intent",
      requestDigest: base.requestDigest,
      targetDigest: expected.targetBindingDigest,
      intentRevision: operation.state.revision + 1,
      intentAt: new Date().toISOString()
    };
  }
  if (handoff.targetDigest !== expected.targetBindingDigest || handoff.requestDigest !== base.requestDigest || handoff.repeatPolicy !== "observe_only_after_intent") {
    return { kind: "result", result: blockedBase(base, "operation_state_corrupt", true, "handoff_may_have_occurred") };
  }

  // The presence of an intent, including one recovered after a crash, forbids
  // calling executeFileHandoffOnce again.  Existing intents are observation
  // only; a newly persisted intent authorizes exactly this one call.
  let handoffResult: SubmissionHandoffResult | undefined;
  if (existingHandoff === undefined) {
    try {
      handoffResult = await ports.executeFileHandoffOnce({
        operationId: base.operationId,
        requestDigest: base.requestDigest,
        surface: base.surface,
        actionId: handoff.actionId,
        targetBindingDigest: expected.targetBindingDigest,
        manifest: cloneManifest(expected.attachmentManifest),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
      });
      validateHandoffResult(handoffResult);
    } catch {
      // An adapter rejection after the intent is indistinguishable from an
      // acts-then-throws browser call.  Reconcile once and never retry.
      handoffResult = { status: "uncertain", quarantine: "caller" };
    }
    // A success acknowledgment is not proof that the provider rendered the
    // requested manifest; every handoff outcome is reconciled exactly once.
    observed = await observeAttachmentsAfterHandoff(
      ports,
      request,
      expected.attachmentManifest,
      options
    );
  }
  if (observed.status === "exact") {
    return { kind: "ok", evidenceDigest: observed.evidenceDigest, mutationBoundary: "handoff_may_have_occurred", actionId: handoff.actionId };
  }
  if (handoffResult?.status === "not_satisfied" && handoffResult.blockerCode !== undefined) {
    return {
      kind: "result",
      result: blockedBase(
        base,
        handoffResult.blockerCode,
        true,
        "handoff_may_have_occurred",
        observed.evidenceDigest ?? handoffResult.evidenceDigest
      )
    };
  }
  const cancelled = cancellationCode(options);
  if (cancelled !== undefined) {
    return { kind: "result", result: uncertainBase(base, cancelled, "handoff_may_have_occurred", observed.evidenceDigest) };
  }
  return {
    kind: "result",
    result: uncertainBase(base, "ambiguous_file_handoff", "handoff_may_have_occurred", observed.evidenceDigest)
  };
}

async function reconcileExistingSend(
  base: SubmissionResultBase,
  expected: SubmissionExpectedEnvelope,
  sendAction: OperationActionRecordV1,
  ports: SubmissionPorts,
  options: Readonly<{ signal?: AbortSignal; deadlineAt?: number; durableBaseline?: OwnershipBaseline }>,
  requiresTargetEstablishment: boolean
): Promise<SubmissionResult> {
  if (
    sendAction.targetDigest !== expected.targetBindingDigest ||
    sendAction.requestDigest !== base.requestDigest ||
    sendAction.repeatPolicy !== "observe_only_after_intent"
  ) {
    return blockedBase(base, "operation_state_corrupt", true, "send_may_have_occurred");
  }
  if (ports.recoverSend === undefined) {
    return blockedBase(base, "port_protocol_violation", true, "send_may_have_occurred");
  }
  let final: SubmissionFinalTransactionResult;
  try {
    final = await ports.recoverSend({
      operationId: base.operationId,
      requestDigest: base.requestDigest,
      surface: base.surface,
      actionId: sendAction.actionId,
      expected: cloneExpectedEnvelope(expected),
      durableBaseline: cloneOwnershipBaseline(options.durableBaseline!),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
    });
    validateFinalResult(final, expected, "observe_only");
  } catch {
    return uncertainBase(base, "ambiguous_submit", "send_may_have_occurred");
  }
  if (final.status === "submitted" || final.status === "already_submitted") {
    return await finishObserved(base, expected, sendAction.actionId, final, ports, requiresTargetEstablishment);
  }
  const cancelled = cancellationCode(options);
  if (cancelled !== undefined) return uncertainBase(base, cancelled, "send_may_have_occurred", final.evidenceDigest);
  if (final.status === "blocked") return blockedBase(base, final.blockerCode, true, "send_may_have_occurred", final.evidenceDigest);
  return uncertainBase(base, "ambiguous_submit", "send_may_have_occurred", final.evidenceDigest);
}

function requirePreparedSendPorts(ports: SubmissionPorts): SubmissionBlockerCode | undefined {
  if (
    typeof ports.prepareSend !== "function"
    || typeof ports.persistPreparedSend !== "function"
    || typeof ports.executePreparedSend !== "function"
    || typeof ports.verifyPreparedSend !== "function"
  ) {
    return "port_protocol_violation";
  }
  return undefined;
}

function validatePrepareSendResult(
  value: SubmissionPrepareSendResult,
  base: SubmissionResultBase,
  expected: SubmissionExpectedEnvelope,
  actionId: string
): void {
  if (!isPlainRecord(value) || (value.status !== "prepared" && value.status !== "blocked")) throw new Error("invalid Send prepare result");
  if (value.status === "blocked") {
    assertExactRecord(value, ["status", "result"], ["status", "result"]);
    validateFinalResult(value.result, expected, "mutate_once");
    if (value.result.status !== "blocked") throw new Error("invalid Send prepare blocker");
    return;
  }
  assertExactRecord(value, ["status", "prepared"], ["status", "prepared"]);
  if (!isPlainRecord(value.prepared)) throw new Error("invalid Send prepared value");
  assertExactRecord(value.prepared, ["prepared", "baseline", "evidenceDigest"], ["prepared", "baseline", "evidenceDigest"]);
  if (value.prepared.prepared === null || value.prepared.prepared === undefined) throw new Error("missing opaque Send prepared value");
  if (!isDigest(value.prepared.evidenceDigest)) throw new Error("invalid Send preparation evidence");
  validateOwnershipBaselineForSend(value.prepared.baseline, base, expected, actionId);
}

function validatePreparedSendPersistenceResult(value: SubmissionPreparedSendPersistenceResult): void {
  if (!isPlainRecord(value) || (value.status !== "committed" && value.status !== "not_committed" && value.status !== "uncertain")) throw new Error("invalid Send persistence result");
  if (value.status === "committed") {
    if (typeof value.executeAllowed !== "boolean") throw new Error("invalid Send persistence ownership");
    assertExactRecord(value, ["status", "executeAllowed"], ["status", "executeAllowed"]);
    return;
  }
  assertExactRecord(value, ["status", "blockerCode", "evidenceDigest"], ["status"]);
  if (value.status === "not_committed" && value.blockerCode !== undefined && !isBlockerCode(value.blockerCode)) throw new Error("invalid Send persistence blocker");
  if (value.evidenceDigest !== undefined && !isDigest(value.evidenceDigest)) throw new Error("invalid Send persistence evidence");
}

function validateExecutePreparedSendResult(value: SubmissionExecutePreparedSendResult, expected: SubmissionExpectedEnvelope): void {
  if (!isPlainRecord(value) || (value.status !== "activated" && value.status !== "activation_threw" && value.status !== "blocked" && value.status !== "uncertain")) throw new Error("invalid Send execute result");
  if (value.status === "blocked" || value.status === "uncertain") {
    assertExactRecord(value, ["status", "result"], ["status", "result"]);
    validateFinalResult(value.result, expected, "mutate_once");
    if (value.result.status !== value.status) throw new Error("invalid Send execute result status");
    return;
  }
  assertExactRecord(value, ["status", "activation", "mutationMayHaveOccurred"], ["status", "activation", "mutationMayHaveOccurred"]);
  if (value.activation !== value.status || value.mutationMayHaveOccurred !== true) throw new Error("invalid Send execution boundary");
}

async function verifyPreparedSendSafely(
  base: SubmissionResultBase,
  expected: SubmissionExpectedEnvelope,
  actionId: string,
  prepared: SubmissionPreparedSend,
  activation: "activated" | "activation_threw",
  ports: SubmissionPorts,
  options: Readonly<{ signal?: AbortSignal; deadlineAt?: number }>
): Promise<SubmissionFinalTransactionResult> {
  if (ports.verifyPreparedSend === undefined) return { status: "uncertain", quarantine: "caller" };
  try {
    const result = await ports.verifyPreparedSend({
      operationId: base.operationId,
      requestDigest: base.requestDigest,
      surface: base.surface,
      actionId,
      expected: cloneExpectedEnvelope(expected),
      prepared,
      activation,
      mutationMayHaveOccurred: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
    });
    validateFinalResult(result, expected, "mutate_once");
    return result;
  } catch {
    return { status: "uncertain", quarantine: "caller" };
  }
}

function validateOwnershipBaselineForSend(
  baseline: OwnershipBaseline,
  base: SubmissionResultBase,
  expected: SubmissionExpectedEnvelope,
  actionId: string
): void {
  const wrapper: OperationOwnershipBaselineV1 = {
    schemaVersion: "chatgpt.browser_control.operation_ownership_baseline.v1",
    operationId: base.operationId,
    requestDigest: base.requestDigest,
    targetBindingDigest: expected.targetBindingDigest,
    actionId,
    baseline,
    observedAt: new Date(0).toISOString()
  };
  // Use the shared closed validator for the nested baseline. The timestamp is
  // only a shape-validation placeholder; the service supplies the immutable
  // durable timestamp when it creates the action_prepared event.
  assertOwnershipBaselineShape(wrapper);
}

async function finishObserved(
  base: SubmissionResultBase,
  expected: SubmissionExpectedEnvelope,
  actionId: string,
  final: Extract<SubmissionFinalTransactionResult, { status: "submitted" | "already_submitted" }>,
  ports: SubmissionPorts,
  requiresTargetEstablishment: boolean
): Promise<SubmissionResult> {
  if (requiresTargetEstablishment) {
    const establishment = final.targetEstablishment;
    if (establishment === undefined || ports.establishTarget === undefined) {
      return uncertainBase(base, "ambiguous_submit", "send_may_have_occurred", final.evidenceDigest);
    }
    try {
      validateSubmissionTargetEstablishment(establishment, expected.targetBindingDigest, actionId);
      if (establishment.postSendDeltaDigest === undefined) {
        return uncertainBase(base, "ambiguous_submit", "send_may_have_occurred", final.evidenceDigest);
      }
      if (establishment.userTurnId !== final.userTurnId || establishment.userTurnEvidenceDigest !== final.userTurnEvidenceDigest) {
        return uncertainBase(base, "ambiguous_submit", "send_may_have_occurred", final.evidenceDigest);
      }
    } catch {
      return uncertainBase(base, "ambiguous_submit", "send_may_have_occurred", final.evidenceDigest);
    }
    try {
      const persisted = await ports.establishTarget({
        operationId: base.operationId,
        requestDigest: base.requestDigest,
        targetBindingDigest: establishment.targetBindingDigest,
        anchorDigest: establishment.anchorDigest,
        causalSendActionId: establishment.causalSendActionId,
        conversationId: establishment.conversationId,
        canonicalThreadUrl: establishment.canonicalThreadUrl,
        userTurnId: establishment.userTurnId,
        userTurnEvidenceDigest: establishment.userTurnEvidenceDigest,
        postSendDeltaDigest: establishment.postSendDeltaDigest,
        evidenceDigest: establishment.evidenceDigest,
        ...(establishment.observedAt === undefined ? {} : { observedAt: establishment.observedAt })
      });
      validateDurableTargetEstablishmentResult(persisted, expected.targetBindingDigest, establishment);
    } catch {
      return uncertainBase(base, "journal_unavailable", "send_may_have_occurred", final.evidenceDigest);
    }
  }
  if (final.postSendDeltaDigest === undefined) {
    return uncertainBase(base, "ambiguous_submit", "send_may_have_occurred", final.evidenceDigest);
  }
  const receipt: SubmissionReceiptEvidence = {
    kind: "receipt",
    operationId: base.operationId,
    requestDigest: base.requestDigest,
    surface: base.surface,
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: expected.targetBindingDigest,
    evidenceDigest: final.evidenceDigest,
    userTurnId: final.userTurnId,
    userTurnEvidenceDigest: final.userTurnEvidenceDigest,
    postSendDeltaDigest: final.postSendDeltaDigest,
    ...(final.targetEstablishment?.observedAt === undefined ? {} : { observedAt: final.targetEstablishment.observedAt }),
    ...(final.assistantTurnId === undefined ? {} : { assistantTurnId: final.assistantTurnId })
  };
  try {
    await ports.persistReceiptEvidence(receipt);
  } catch {
    return uncertainBase(base, "journal_unavailable", "send_may_have_occurred", final.evidenceDigest);
  }
  const resultBase = { ...base };
  if (final.status === "already_submitted") {
    return {
      ...resultBase,
      kind: "already_submitted",
      actionId,
      evidenceDigest: final.evidenceDigest,
      userTurnId: final.userTurnId,
      userTurnEvidenceDigest: final.userTurnEvidenceDigest,
      ...(final.assistantTurnId === undefined ? {} : { assistantTurnId: final.assistantTurnId })
    };
  }
  return {
    ...resultBase,
    kind: "submitted",
    actionId,
    evidenceDigest: final.evidenceDigest,
    userTurnId: final.userTurnId,
    userTurnEvidenceDigest: final.userTurnEvidenceDigest,
    ...(final.assistantTurnId === undefined ? {} : { assistantTurnId: final.assistantTurnId })
  };
}

async function observeAttachmentsSafely(
  ports: SubmissionPorts,
  request: SubmissionAttachmentRequest,
  manifest: SubmissionExpectedEnvelope["attachmentManifest"]
): Promise<SubmissionAttachmentObservation> {
  try {
    const result = await ports.observeAttachments({ ...request, manifest: cloneManifest(request.manifest) });
    validateAttachmentObservation(result, manifest);
    return result;
  } catch {
    return { status: "ambiguous" };
  }
}

async function observeAttachmentsAfterHandoff(
  ports: SubmissionPorts,
  request: SubmissionAttachmentRequest,
  manifest: SubmissionExpectedEnvelope["attachmentManifest"],
  options: Readonly<{ signal?: AbortSignal; deadlineAt?: number }>
): Promise<SubmissionAttachmentObservation> {
  let observed: SubmissionAttachmentObservation = { status: "ambiguous" };
  for (let attempt = 0; attempt < POST_HANDOFF_OBSERVATION_ATTEMPTS; attempt += 1) {
    observed = await observeAttachmentsSafely(ports, request, manifest);
    if (observed.status === "exact" || observed.status === "mismatch") return observed;
    if (attempt + 1 >= POST_HANDOFF_OBSERVATION_ATTEMPTS || cancellationCode(options) !== undefined) {
      return observed;
    }
    const budget = options.deadlineAt === undefined
      ? POST_HANDOFF_OBSERVATION_INTERVAL_MS
      : Math.max(0, options.deadlineAt - Date.now());
    if (budget <= 0) return observed;
    await waitForPostHandoffObservation(
      Math.min(POST_HANDOFF_OBSERVATION_INTERVAL_MS, budget),
      options.signal
    );
  }
  return observed;
}

async function waitForPostHandoffObservation(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function validateInput(
  operation: SubmissionOperationSnapshot,
  expected: SubmissionExpectedEnvelope,
  ports: SubmissionPorts,
  options: Readonly<{ signal?: AbortSignal; deadlineAt?: number }>
): SubmissionExpectedEnvelope {
  // Reject accessor-backed plain data before any validation property access.
  // This matters both for privacy (no hostile getter can expose a secret) and
  // for fail-closed semantics (a getter must not influence the blocker
  // identity that is returned to the caller).
  if (hasAccessorInPlainData(operation)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation snapshot contains accessor-backed identity data.");
  }
  if (hasAccessorInPlainData(expected) || hasAccessorInPlainData(options)) {
    throw new SubmissionInputError("port_protocol_violation", "Submission input contains accessor-backed boundary data.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new SubmissionInputError("port_protocol_violation", "Submission options are invalid.");
  }
  assertExactRecord(options, ["signal", "deadlineAt"], []);
  if (!operation || typeof operation !== "object" || !operation.state || !operation.handle || !operation.actionIds) {
    throw new SubmissionInputError("port_protocol_violation", "Submission operation snapshot is invalid.");
  }
  assertExactRecord(operation, ["state", "handle", "actionIds"], ["state", "handle", "actionIds"]);
  const envelope = sanitizeExpectedEnvelope(expected);
  const state = operation.state;
  const handle = operation.handle;
  assertExactRecord(
    state,
    ["schemaVersion", "operationId", "requestDigest", "surface", "phase", "mutationBoundary", "revision", "createdAt", "updatedAt", "capturePolicy", "responseFormat", "target", "actions", "ownershipBaseline", "ownershipBaselines", "artifactTransfers", "submissionWitnesses", "lastBlocker", "receipt", "submissionWitness"],
    ["schemaVersion", "operationId", "requestDigest", "surface", "phase", "mutationBoundary", "revision", "createdAt", "updatedAt", "actions"]
  );
  assertExactRecord(
    handle,
    ["schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary", "targetBindingDigest"],
    ["schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary"]
  );
  assertExactRecord(operation.actionIds, ["sendActionId", "fileHandoffActionId"], ["sendActionId"]);
  if (state.schemaVersion !== OPERATION_SCHEMA_VERSION || handle.schemaVersion !== OPERATION_HANDLE_SCHEMA_VERSION) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation schema versions are invalid.");
  }
  if (!isUuid(state.operationId) || !isUuid(handle.operationId) || state.operationId !== handle.operationId) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation identity is invalid.");
  }
  if (!isDigest(state.requestDigest) || state.requestDigest !== handle.requestDigest) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation request identity is invalid.");
  }
  if (state.surface !== "chat" && state.surface !== "work") throw new SubmissionInputError("operation_state_corrupt", "Operation surface is invalid.");
  if (state.responseFormat !== undefined && state.responseFormat !== "markdown" && state.responseFormat !== "text") throw new SubmissionInputError("operation_state_corrupt", "Operation response format is invalid.");
  if (state.capturePolicy !== undefined) {
    try {
      assertDurableCapturePolicyShape(state.capturePolicy);
    } catch {
      throw new SubmissionInputError("operation_state_corrupt", "Operation durable capture policy is invalid.");
    }
    if (state.responseFormat !== undefined && state.responseFormat !== state.capturePolicy.responseFormat) {
      throw new SubmissionInputError("operation_state_corrupt", "Operation capture policy format is inconsistent.");
    }
  }
  if (!PHASES.has(state.phase) || !BOUNDARIES.has(state.mutationBoundary) || !Number.isSafeInteger(state.revision) || state.revision < 1) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation progress fields are invalid.");
  }
  if (handle.surface !== state.surface || handle.revision !== state.revision || handle.phase !== state.phase || handle.mutationBoundary !== state.mutationBoundary) {
    throw new SubmissionInputError("stale_handle", "Operation handle is stale.");
  }
  if (envelope.surface !== state.surface || handle.targetBindingDigest !== envelope.targetBindingDigest) {
    throw new SubmissionInputError("target_binding_mismatch", "Expected target binding does not match the operation.");
  }
  if (!isUuid(operation.actionIds.sendActionId)) throw new SubmissionInputError("operation_state_corrupt", "Send action identity is invalid.");
  if (operation.actionIds.fileHandoffActionId !== undefined && !isUuid(operation.actionIds.fileHandoffActionId)) {
    throw new SubmissionInputError("operation_state_corrupt", "File handoff action identity is invalid.");
  }
  if (operation.actionIds.fileHandoffActionId === operation.actionIds.sendActionId) {
    throw new SubmissionInputError("operation_state_corrupt", "Non-repeatable action identities must be distinct.");
  }
  if (state.target === undefined || typeof state.target !== "object" || Array.isArray(state.target)) {
    throw new SubmissionInputError("target_binding_mismatch", "Operation target binding is unavailable.");
  }
  validateTargetBinding(state.target);
  if (state.ownershipBaseline !== undefined) {
    try {
      assertOwnershipBaselineShape(state.ownershipBaseline);
    } catch {
      throw new SubmissionInputError("operation_state_corrupt", "Durable ownership baseline is invalid.");
    }
    if (
      state.ownershipBaseline.operationId !== state.operationId
      || state.ownershipBaseline.requestDigest !== state.requestDigest
      || state.ownershipBaseline.targetBindingDigest !== envelope.targetBindingDigest
    ) {
      throw new SubmissionInputError("operation_state_corrupt", "Durable ownership baseline identity is invalid.");
    }
  }
  if (state.ownershipBaselines !== undefined) {
    if (!state.ownershipBaselines || typeof state.ownershipBaselines !== "object" || Array.isArray(state.ownershipBaselines)) {
      throw new SubmissionInputError("operation_state_corrupt", "Durable ownership baseline map is invalid.");
    }
    for (const [actionId, baseline] of Object.entries(state.ownershipBaselines)) {
      if (!isUuid(actionId)) throw new SubmissionInputError("operation_state_corrupt", "Durable ownership baseline map key is invalid.");
      try {
        assertOwnershipBaselineShape(baseline);
      } catch {
        throw new SubmissionInputError("operation_state_corrupt", "Durable ownership baseline map entry is invalid.");
      }
      if (
        baseline.operationId !== state.operationId
        || baseline.requestDigest !== state.requestDigest
        || baseline.actionId !== actionId
        || baseline.targetBindingDigest !== envelope.targetBindingDigest
      ) {
        throw new SubmissionInputError("operation_state_corrupt", "Durable ownership baseline map identity is invalid.");
      }
    }
  }
  if (!state.actions || typeof state.actions !== "object" || Array.isArray(state.actions)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation actions are invalid.");
  }
  for (const [actionId, action] of Object.entries(state.actions)) {
    if (!isUuid(actionId) || !action || typeof action !== "object" || Array.isArray(action)) {
      throw new SubmissionInputError("operation_state_corrupt", "Operation action identity is invalid.");
    }
    assertExactRecord(action, ["actionId", "kind", "repeatPolicy", "requestDigest", "parentActionId", "targetDigest", "intentRevision", "intentAt", "outcome", "receiptRevision", "receiptAt", "evidenceDigest", "blockerCode"], ["actionId", "kind", "repeatPolicy", "requestDigest", "intentRevision", "intentAt"]);
    if (action.actionId !== actionId || !isUuid(action.actionId) || !isDigest(action.requestDigest)) {
      throw new SubmissionInputError("operation_state_corrupt", "Operation action identity is invalid.");
    }
    validateActionRecord(action);
  }
  const recordedSend = findUniqueAction(state, "send");
  const recordedHandoff = findUniqueAction(state, "file_handoff");
  if (recordedSend === "corrupt" || recordedHandoff === "corrupt") {
    throw new SubmissionInputError("operation_state_corrupt", "Operation contains duplicate non-repeatable actions.");
  }
  if (recordedSend !== undefined && operation.actionIds.sendActionId !== recordedSend.actionId) {
    throw new SubmissionInputError("operation_state_corrupt", "Provided Send action identity does not match durable state.");
  }
  if (recordedHandoff !== undefined && operation.actionIds.fileHandoffActionId !== recordedHandoff.actionId) {
    throw new SubmissionInputError("operation_state_corrupt", "Provided file handoff action identity does not match durable state.");
  }
  if (recordedHandoff === undefined && operation.actionIds.fileHandoffActionId !== undefined && envelope.attachmentManifest.count === 0) {
    throw new SubmissionInputError("operation_state_corrupt", "Unused file handoff action identity is not allowed for an empty manifest.");
  }
  if (envelope.attachmentManifest.count > 0 && operation.actionIds.fileHandoffActionId === undefined) {
    throw new SubmissionInputError("operation_state_corrupt", "File handoff action identity is required for an attachment manifest.");
  }
  const sendBaseline = state.ownershipBaselines?.[recordedSend?.actionId ?? ""] ?? state.ownershipBaseline;
  if (state.ownershipBaseline !== undefined && (
    recordedSend === undefined
    || state.ownershipBaseline.actionId !== recordedSend.actionId
      || state.ownershipBaseline.targetBindingDigest !== recordedSend.targetDigest
  )) {
    throw new SubmissionInputError("operation_state_corrupt", "Durable ownership baseline does not name the original Send action.");
  }
  if (state.submissionWitness !== undefined) {
    validateDurableSubmissionWitness(state.submissionWitness);
    if (
      recordedSend === undefined
      || state.submissionWitness.actionId !== recordedSend.actionId
      || state.submissionWitness.actionKind !== recordedSend.kind
      || state.submissionWitness.targetBindingDigest !== recordedSend.targetDigest
      || sendBaseline === undefined
      || state.submissionWitness.baselineSnapshotDigest !== sendBaseline.baseline.snapshotDigest
    ) {
      throw new SubmissionInputError("operation_state_corrupt", "Durable submission witness is not bound to the original Send action and pre-Send baseline.");
    }
  }
  if (state.receipt !== undefined) validateDurableReceipt(state.receipt);
  if (options.signal !== undefined && !isAbortSignalLike(options.signal)) {
    throw new SubmissionInputError("port_protocol_violation", "Cancellation signal is invalid.");
  }
  if (
    options.deadlineAt !== undefined &&
    (!Number.isFinite(options.deadlineAt) || !Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0 || options.deadlineAt > MAX_DEADLINE_AT)
  ) {
    throw new SubmissionInputError("port_protocol_violation", "Deadline is invalid.");
  }
  if (!ports || typeof ports !== "object" || Array.isArray(ports) || typeof ports.observeStaging !== "function" || typeof ports.persistActionIntent !== "function" || typeof ports.executeFileHandoffOnce !== "function" || typeof ports.observeAttachments !== "function" || typeof ports.persistReceiptEvidence !== "function") {
    throw new SubmissionInputError("port_protocol_violation", "Submission ports are incomplete.");
  }
  return envelope;
}

function validateActionRecord(action: OperationActionRecordV1): void {
  const policies: Record<string, string> = {
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
  if (typeof action.kind !== "string" || policies[action.kind] === undefined || action.repeatPolicy !== policies[action.kind]) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action kind or repeat policy is invalid.");
  }
  if (!Number.isSafeInteger(action.intentRevision) || action.intentRevision < 1 || !isIsoInstant(action.intentAt)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action intent evidence is invalid.");
  }
  if (action.parentActionId !== undefined && !isUuid(action.parentActionId)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation parent action identity is invalid.");
  }
  if (action.targetDigest !== undefined && !isDigest(action.targetDigest)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action target evidence is invalid.");
  }
  if ((action.kind === "file_handoff" || action.kind === "send") && action.targetDigest === undefined) {
    throw new SubmissionInputError("operation_state_corrupt", "Non-repeatable action target evidence is missing.");
  }
  if (action.outcome !== undefined && action.outcome !== "satisfied" && action.outcome !== "not_satisfied" && action.outcome !== "uncertain") {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action outcome is invalid.");
  }
  if (action.receiptRevision !== undefined && (!Number.isSafeInteger(action.receiptRevision) || action.receiptRevision < 1)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action receipt revision is invalid.");
  }
  if (action.receiptAt !== undefined && !isIsoInstant(action.receiptAt)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action receipt time is invalid.");
  }
  if (action.receiptAt !== undefined && Date.parse(action.receiptAt) < Date.parse(action.intentAt)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action receipt precedes its intent.");
  }
  if (action.evidenceDigest !== undefined && !isDigest(action.evidenceDigest)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action evidence is invalid.");
  }
  if (action.blockerCode !== undefined && (typeof action.blockerCode !== "string" || !CODE_PATTERN.test(action.blockerCode))) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation action blocker is invalid.");
  }
  const hasReceiptEvidence = action.receiptRevision !== undefined || action.receiptAt !== undefined || action.evidenceDigest !== undefined || action.blockerCode !== undefined;
  if (action.outcome === undefined && hasReceiptEvidence) {
    throw new SubmissionInputError("operation_state_corrupt", "Unreceipted operation action contains receipt evidence.");
  }
  if (action.outcome !== undefined && (action.receiptRevision === undefined || action.receiptAt === undefined)) {
    throw new SubmissionInputError("operation_state_corrupt", "Receipted operation action is missing receipt evidence.");
  }
  if (action.outcome === "satisfied" && action.evidenceDigest === undefined) {
    throw new SubmissionInputError("operation_state_corrupt", "Satisfied operation action is missing evidence.");
  }
}

function validateManifest(manifest: SubmissionExpectedEnvelope["attachmentManifest"]): void {
  if (!manifest || manifest.orderPolicy !== "exact" || !Number.isSafeInteger(manifest.count) || manifest.count < 0 || manifest.count > MAX_ATTACHMENTS || !Array.isArray(manifest.identities) || manifest.identities.length !== manifest.count) {
    throw new SubmissionInputError("attachment_manifest_mismatch", "Attachment manifest is invalid.");
  }
  manifest.identities.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SubmissionInputError("attachment_manifest_mismatch", "Attachment manifest identity is invalid.");
    }
    assertExactRecord(entry, ["identityDigest", "ordinal"], ["identityDigest", "ordinal"]);
    if (entry.ordinal !== index || !isDigest(entry.identityDigest)) {
      throw new SubmissionInputError("attachment_manifest_mismatch", "Attachment manifest order is invalid.");
    }
  });
  const seen = new Set<string>();
  for (const entry of manifest.identities) {
    if (seen.has(entry.identityDigest)) {
      throw new SubmissionInputError("attachment_manifest_mismatch", "Attachment manifest contains duplicate identities.");
    }
    seen.add(entry.identityDigest);
  }
}

function sanitizeExpectedEnvelope(value: SubmissionExpectedEnvelope): SubmissionExpectedEnvelope {
  assertExactRecord(value, ["surface", "targetBindingDigest", "configurationReceiptDigest", "composerReceiptDigest", "attachmentManifest"], ["surface", "targetBindingDigest", "configurationReceiptDigest", "composerReceiptDigest", "attachmentManifest"]);
  if (value.surface !== "chat" && value.surface !== "work") {
    throw new SubmissionInputError("port_protocol_violation", "Expected surface is invalid.");
  }
  if (!isDigest(value.targetBindingDigest) || !isDigest(value.configurationReceiptDigest) || !isDigest(value.composerReceiptDigest)) {
    throw new SubmissionInputError("port_protocol_violation", "Expected receipt digests are invalid.");
  }
  const manifest = value.attachmentManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new SubmissionInputError("attachment_manifest_mismatch", "Attachment manifest is invalid.");
  }
  assertExactRecord(manifest, ["count", "orderPolicy", "identities"], ["count", "orderPolicy", "identities"]);
  validateManifest(manifest);
  return {
    surface: value.surface,
    targetBindingDigest: value.targetBindingDigest,
    configurationReceiptDigest: value.configurationReceiptDigest,
    composerReceiptDigest: value.composerReceiptDigest,
    attachmentManifest: {
      count: manifest.count,
      orderPolicy: "exact",
      identities: manifest.identities.map(entry => ({ identityDigest: entry.identityDigest, ordinal: entry.ordinal }))
    }
  };
}

function validateTargetBinding(value: NonNullable<OperationStateV1["target"]>): void {
  assertExactRecord(value, ["providerId", "browserId", "tabId", "coordinationScope", "tabClaimEvidenceDigest", "canonicalThreadUrl", "conversationId", "userTurnBaselineDigest", "assistantTurnBaselineDigest", "configurationReceiptDigest", "evidenceProfile", "targetLifecycle", "newTargetAnchorDigest", "blankTaskEvidenceDigest", "targetEstablishment"], ["providerId", "browserId", "tabId", "coordinationScope", "evidenceProfile"]);
  if (!isSafeId(value.providerId) || !isSafeId(value.browserId) || !isSafeId(value.tabId) || (value.coordinationScope !== "process" && value.coordinationScope !== "provider")) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation target binding identity is invalid.");
  }
  if (value.conversationId !== undefined && !isSafeId(value.conversationId)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation conversation identity is invalid.");
  }
  if (value.canonicalThreadUrl !== undefined && !isCanonicalThreadUrl(value.canonicalThreadUrl)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation canonical thread URL is invalid.");
  }
  for (const digest of [value.tabClaimEvidenceDigest, value.userTurnBaselineDigest, value.assistantTurnBaselineDigest, value.configurationReceiptDigest]) {
    if (digest !== undefined && !isDigest(digest)) throw new SubmissionInputError("operation_state_corrupt", "Operation target evidence digest is invalid.");
  }
  const profile = value.evidenceProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new SubmissionInputError("operation_state_corrupt", "Operation target evidence profile is invalid.");
  assertExactRecord(profile, ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim", "replacementTabRecovery"], ["providerIdentity", "stableTabId", "stableConversationId", "stableUserTurnId", "authoritativeTabClaim", "replacementTabRecovery"]);
  if (typeof profile.replacementTabRecovery !== "boolean") throw new SubmissionInputError("operation_state_corrupt", "Operation target recovery profile is invalid.");
  for (const value of [profile.providerIdentity, profile.stableTabId, profile.stableConversationId, profile.stableUserTurnId, profile.authoritativeTabClaim]) {
    if (value !== "required" && value !== "unavailable") throw new SubmissionInputError("operation_state_corrupt", "Operation target evidence profile is invalid.");
  }
  if (profile.stableConversationId === "required" && value.conversationId === undefined) {
    throw new SubmissionInputError("operation_state_corrupt", "Required stable conversation evidence is absent.");
  }
  if (
    value.coordinationScope === "provider" &&
    (profile.authoritativeTabClaim !== "required" || value.tabClaimEvidenceDigest === undefined)
  ) {
    throw new SubmissionInputError("operation_state_corrupt", "Provider-scoped coordination requires authoritative tab-claim evidence.");
  }
  const lifecycle = value.targetLifecycle ?? "fixed";
  if (lifecycle !== "fixed" && lifecycle !== "new_pending" && lifecycle !== "new_established") {
    throw new SubmissionInputError("operation_state_corrupt", "Operation target lifecycle is invalid.");
  }
  if (value.newTargetAnchorDigest !== undefined && !isDigest(value.newTargetAnchorDigest)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation new-target anchor digest is invalid.");
  }
  if (value.blankTaskEvidenceDigest !== undefined && !isDigest(value.blankTaskEvidenceDigest)) {
    throw new SubmissionInputError("operation_state_corrupt", "Operation blank-task evidence digest is invalid.");
  }
  if (lifecycle === "fixed" && (value.newTargetAnchorDigest !== undefined || value.blankTaskEvidenceDigest !== undefined || value.targetEstablishment !== undefined)) {
    throw new SubmissionInputError("operation_state_corrupt", "Fixed target contains new-target identity fields.");
  }
  if (lifecycle === "new_pending" && (
    value.newTargetAnchorDigest === undefined
    || value.blankTaskEvidenceDigest === undefined
    || value.conversationId !== undefined
    || value.canonicalThreadUrl !== undefined
    || value.targetEstablishment !== undefined
    || profile.stableConversationId !== "unavailable"
    || profile.stableUserTurnId !== "unavailable"
  )) {
    throw new SubmissionInputError("operation_state_corrupt", "Pending new target identity is invalid.");
  }
  if (value.targetEstablishment !== undefined) {
    try {
      validateSubmissionTargetEstablishment(value.targetEstablishment, value.targetEstablishment.targetBindingDigest);
    } catch {
      throw new SubmissionInputError("operation_state_corrupt", "Target establishment evidence is invalid.");
    }
  }
}

function cloneOwnershipBaseline(value: OwnershipBaseline): OwnershipBaseline {
  return {
    schemaVersion: value.schemaVersion,
    snapshotDigest: value.snapshotDigest,
    target: {
      provider: cloneOwnershipIdentity(value.target.provider),
      browser: cloneOwnershipIdentity(value.target.browser),
      tab: cloneOwnershipIdentity(value.target.tab),
      thread: cloneOwnershipIdentity(value.target.thread),
      conversation: cloneOwnershipIdentity(value.target.conversation),
      canonicalThreadUrl: cloneOwnershipIdentity(value.target.canonicalThreadUrl),
      authoritativeTabClaim: cloneOwnershipIdentity(value.target.authoritativeTabClaim),
      coordinationScope: value.target.coordinationScope
    },
    userTurns: value.userTurns.map(cloneOwnershipTurn),
    assistantTurns: value.assistantTurns.map(cloneOwnershipTurn),
    completeness: "complete"
  };
}

function cloneOwnershipIdentity(value: OwnershipBaseline["target"][keyof OwnershipBaseline["target"]]): any {
  if (typeof value !== "object" || value === null || !("status" in value)) return value;
  return value.status === "available"
    ? { status: "available", value: value.value }
    : { status: "unavailable", reason: value.reason };
}

function cloneOwnershipTurn(value: OwnershipBaseline["userTurns"][number]): OwnershipBaseline["userTurns"][number] {
  return {
    ...(value.stableId === undefined ? {} : { stableId: value.stableId }),
    evidenceDigest: value.evidenceDigest,
    structureDigest: value.structureDigest,
    ordinal: value.ordinal,
    ...(value.parentStableId === undefined ? {} : { parentStableId: value.parentStableId }),
    ...(value.branchStableId === undefined ? {} : { branchStableId: value.branchStableId }),
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.artifactEvidenceDigests === undefined ? {} : { artifactEvidenceDigests: [...value.artifactEvidenceDigests] })
  };
}

function validateDurableSubmissionWitness(value: OperationSubmissionWitnessV1): void {
  assertExactRecord(
    value,
    ["schemaVersion", "actionId", "actionKind", "targetBindingDigest", "baselineSnapshotDigest", "postSendDeltaDigest", "operationUserEvidenceDigest", "userTurnId", "observedAt"],
    ["schemaVersion", "actionId", "actionKind", "targetBindingDigest", "baselineSnapshotDigest", "postSendDeltaDigest", "operationUserEvidenceDigest", "observedAt"]
  );
  if (
    value.schemaVersion !== OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION
    || !isUuid(value.actionId)
    || (value.actionKind !== "send" && value.actionKind !== "work_steer")
    || !isDigest(value.targetBindingDigest)
    || !isDigest(value.baselineSnapshotDigest)
    || !isDigest(value.postSendDeltaDigest)
    || !isDigest(value.operationUserEvidenceDigest)
    || (value.userTurnId !== undefined && !isSafeId(value.userTurnId))
    || !isIsoInstant(value.observedAt)
  ) {
    throw new SubmissionInputError("operation_state_corrupt", "Durable submission witness is invalid.");
  }
}

function validateDurableReceipt(value: NonNullable<OperationStateV1["receipt"]>): void {
  assertExactRecord(
    value,
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "userTurnId", "assistantTurnId", "ownershipEvidenceDigest", "userTurnEvidenceDigest", "responseDigest", "responseBytes", "responseFormat", "finishReason", "contentAvailable", "artifacts", "completedAt"],
    ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "userTurnId", "assistantTurnId", "ownershipEvidenceDigest", "userTurnEvidenceDigest", "contentAvailable", "finishReason", "artifacts", "completedAt"]
  );
  if (
    value.schemaVersion !== OPERATION_RECEIPT_SCHEMA_VERSION ||
    !isUuid(value.operationId) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.targetBindingDigest) ||
    !isSafeId(value.userTurnId) ||
    !isSafeId(value.assistantTurnId) ||
    !isDigest(value.ownershipEvidenceDigest) ||
    !isDigest(value.userTurnEvidenceDigest) ||
    (value.responseFormat !== undefined && value.responseFormat !== "markdown" && value.responseFormat !== "text") ||
    typeof value.contentAvailable !== "boolean" ||
    typeof value.finishReason !== "string" ||
    !FINISH_REASON_PATTERN.test(value.finishReason) ||
    !isIsoInstant(value.completedAt) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > MAX_RECEIPT_ARTIFACTS
  ) {
    throw new SubmissionInputError("operation_state_corrupt", "Durable operation receipt is invalid.");
  }
  const hasResponseDigest = value.responseDigest !== undefined;
  const hasResponseBytes = value.responseBytes !== undefined;
  const responseBytes = value.responseBytes;
  if (hasResponseDigest !== hasResponseBytes || value.contentAvailable !== hasResponseDigest) {
    throw new SubmissionInputError("operation_state_corrupt", "Durable response metadata must match content availability.");
  }
  if (hasResponseDigest && !isDigest(value.responseDigest)) throw new SubmissionInputError("operation_state_corrupt", "Durable response digest is invalid.");
  if (hasResponseBytes && (typeof responseBytes !== "number" || !Number.isSafeInteger(responseBytes) || responseBytes < 0)) throw new SubmissionInputError("operation_state_corrupt", "Durable response size is invalid.");
  const artifactKeys = new Set<string>();
  const artifactOrdinals = new Set<number>();
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new SubmissionInputError("operation_state_corrupt", "Durable artifact receipt is invalid.");
    assertExactRecord(artifact, ["schemaVersion", "operationId", "artifactKey", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "outputKey", "mimeType", "bytes", "sha256", "status", "blockerCode"], ["schemaVersion", "operationId", "artifactKey", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "status"]);
    if (
      artifact.schemaVersion !== OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION ||
      !isUuid(artifact.operationId) ||
      artifact.operationId !== value.operationId ||
      !isOpaqueKey(artifact.artifactKey) ||
      artifactKeys.has(artifact.artifactKey) ||
      !isSafeId(artifact.assistantTurnId) ||
      artifact.assistantTurnId !== value.assistantTurnId ||
      !isDigest(artifact.sourceIdentityDigest) ||
      !Number.isSafeInteger(artifact.ordinal) ||
      artifact.ordinal < 0 ||
      artifactOrdinals.has(artifact.ordinal) ||
      (artifact.kind !== "file" && artifact.kind !== "image" && artifact.kind !== "other") ||
      (artifact.status !== "available" && artifact.status !== "transferred" && artifact.status !== "partial" && artifact.status !== "blocked")
    ) {
      throw new SubmissionInputError("operation_state_corrupt", "Durable artifact receipt is invalid.");
    }
    artifactKeys.add(artifact.artifactKey);
    artifactOrdinals.add(artifact.ordinal);
    if (artifact.outputKey !== undefined && (typeof artifact.outputKey !== "string" || !OUTPUT_KEY_PATTERN.test(artifact.outputKey))) throw new SubmissionInputError("operation_state_corrupt", "Durable artifact output key is invalid.");
    if (artifact.mimeType !== undefined && (typeof artifact.mimeType !== "string" || !MIME_PATTERN.test(artifact.mimeType))) throw new SubmissionInputError("operation_state_corrupt", "Durable artifact MIME type is invalid.");
    if (artifact.bytes !== undefined && (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)) throw new SubmissionInputError("operation_state_corrupt", "Durable artifact size is invalid.");
    if (artifact.sha256 !== undefined && (typeof artifact.sha256 !== "string" || !SHA256_PATTERN.test(artifact.sha256))) throw new SubmissionInputError("operation_state_corrupt", "Durable artifact digest is invalid.");
    if (artifact.blockerCode !== undefined && (typeof artifact.blockerCode !== "string" || !CODE_PATTERN.test(artifact.blockerCode))) throw new SubmissionInputError("operation_state_corrupt", "Durable artifact blocker is invalid.");
    if (artifact.status === "transferred" && (artifact.outputKey === undefined || artifact.bytes === undefined || artifact.sha256 === undefined || artifact.blockerCode !== undefined)) {
      throw new SubmissionInputError("operation_state_corrupt", "Transferred artifact receipt is incomplete or contradictory.");
    }
    if ((artifact.status === "partial" || artifact.status === "blocked") && artifact.blockerCode === undefined) {
      throw new SubmissionInputError("operation_state_corrupt", "Partial or blocked artifact receipt requires a blocker.");
    }
    if (artifact.status === "available" && artifact.blockerCode !== undefined) {
      throw new SubmissionInputError("operation_state_corrupt", "Available artifact receipt cannot carry a blocker.");
    }
  }
}

function cloneExpectedEnvelope(value: SubmissionExpectedEnvelope): SubmissionExpectedEnvelope {
  return {
    surface: value.surface,
    targetBindingDigest: value.targetBindingDigest,
    configurationReceiptDigest: value.configurationReceiptDigest,
    composerReceiptDigest: value.composerReceiptDigest,
    attachmentManifest: cloneManifest(value.attachmentManifest)
  };
}

function cloneManifest(value: SubmissionExpectedEnvelope["attachmentManifest"]): SubmissionExpectedEnvelope["attachmentManifest"] {
  return {
    count: value.count,
    orderPolicy: "exact",
    identities: value.identities.map(entry => ({ identityDigest: entry.identityDigest, ordinal: entry.ordinal }))
  };
}

function assertExactRecord(value: unknown, allowed: readonly string[], required: readonly string[]): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new SubmissionInputError("port_protocol_violation", "Boundary value must be a record.");
  const record = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const requiredSet = new Set(required);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) throw new SubmissionInputError("port_protocol_violation", "Boundary value contains an unsupported field.");
  }
  for (const key of requiredSet) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new SubmissionInputError("port_protocol_violation", "Boundary value is missing a required field.");
  }
}

function validateStageObservation(value: SubmissionStageObservation): void {
  if (!value || typeof value !== "object" || typeof value.status !== "string") throw new Error("invalid stage observation");
  if (value.status === "exact") {
    assertExactRecord(value, ["status", "evidenceDigest"], ["status", "evidenceDigest"]);
    assertDigest(value.evidenceDigest);
  } else if (value.status === "mismatch" || value.status === "unavailable") {
    assertExactRecord(value, ["status", "reason", "evidenceDigest"], ["status", "reason"]);
    if (!["target", "configuration", "composer", "unknown"].includes(value.reason)) throw new Error("invalid stage reason");
    if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest);
  } else {
    throw new Error("invalid stage status");
  }
}

function validateAttachmentObservation(value: SubmissionAttachmentObservation, manifest: SubmissionExpectedEnvelope["attachmentManifest"]): void {
  if (!value || typeof value !== "object" || typeof value.status !== "string") throw new Error("invalid attachment observation");
  if (value.status === "absent") {
    assertExactRecord(value, ["status", "evidenceDigest", "count", "orderPolicy", "identityDigests"], ["status", "evidenceDigest", "count", "orderPolicy", "identityDigests"]);
    assertDigest(value.evidenceDigest);
    if (manifest.count === 0 || value.count !== 0 || value.orderPolicy !== "exact" || !Array.isArray(value.identityDigests) || value.identityDigests.length !== 0) throw new Error("invalid absent attachment postcondition");
  } else if (value.status === "exact") {
    assertExactRecord(value, ["status", "evidenceDigest", "count", "orderPolicy", "identityDigests"], ["status", "evidenceDigest", "count", "orderPolicy", "identityDigests"]);
    assertDigest(value.evidenceDigest);
    if (value.count !== manifest.count || value.orderPolicy !== "exact" || !Array.isArray(value.identityDigests) || value.identityDigests.length !== manifest.count) throw new Error("attachment postcondition mismatch");
    value.identityDigests.forEach((identity, index) => {
      if (!isDigest(identity) || identity !== manifest.identities[index]?.identityDigest) throw new Error("attachment identity mismatch");
    });
  } else if (!["mismatch", "delayed", "ambiguous", "unavailable"].includes(value.status)) {
    throw new Error("invalid attachment status");
  } else if (value.evidenceDigest !== undefined) {
    assertExactRecord(value, ["status", "evidenceDigest"], ["status"]);
    assertDigest(value.evidenceDigest);
  } else {
    assertExactRecord(value, ["status", "evidenceDigest"], ["status"]);
  }
}

function validateHandoffResult(value: SubmissionHandoffResult): void {
  if (!value || typeof value !== "object" || typeof value.status !== "string") throw new Error("invalid handoff result");
  if (value.status === "satisfied") {
    assertExactRecord(value, ["status", "evidenceDigest"], ["status", "evidenceDigest"]);
    assertDigest(value.evidenceDigest);
  }
  else if (value.status === "not_satisfied") {
    assertExactRecord(value, ["status", "blockerCode", "evidenceDigest"], ["status"]);
    if (value.blockerCode !== undefined && !isBlockerCode(value.blockerCode)) throw new Error("invalid handoff blocker");
    if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest);
  } else if (value.status === "uncertain") {
    assertExactRecord(value, ["status", "evidenceDigest", "quarantine"], ["status", "quarantine"]);
    if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest);
    if (value.quarantine !== "provider" && value.quarantine !== "caller") throw new Error("invalid handoff quarantine");
  } else throw new Error("invalid handoff status");
}

function validateFinalResult(value: SubmissionFinalTransactionResult, expected: SubmissionExpectedEnvelope, mode: SubmissionFinalTransactionRequest["mode"]): void {
  if (!value || typeof value !== "object" || typeof value.status !== "string") throw new Error("invalid final result");
  if (value.status === "submitted" || value.status === "already_submitted") {
    assertExactRecord(value, ["status", "targetBindingDigest", "evidenceDigest", "userTurnId", "userTurnEvidenceDigest", "postSendDeltaDigest", "assistantTurnId", "targetEstablishment"], ["status", "targetBindingDigest", "evidenceDigest", "userTurnId", "userTurnEvidenceDigest", "postSendDeltaDigest"]);
    if (value.targetBindingDigest !== expected.targetBindingDigest || !isDigest(value.targetBindingDigest) || !isDigest(value.evidenceDigest) || !isDigest(value.userTurnEvidenceDigest) || !isDigest(value.postSendDeltaDigest) || !isSafeId(value.userTurnId)) throw new Error("invalid submission evidence");
    if (value.assistantTurnId !== undefined && !isSafeId(value.assistantTurnId)) throw new Error("invalid assistant identity");
    if (value.targetEstablishment !== undefined) {
      validateSubmissionTargetEstablishment(value.targetEstablishment, expected.targetBindingDigest);
      if (value.targetEstablishment.userTurnId !== value.userTurnId || value.targetEstablishment.userTurnEvidenceDigest !== value.userTurnEvidenceDigest) {
        throw new Error("target establishment turn mismatch");
      }
      if (value.targetEstablishment.postSendDeltaDigest !== value.postSendDeltaDigest) {
        throw new Error("target establishment delta mismatch");
      }
    }
    if (mode === "observe_only" && value.status === "submitted") throw new Error("observation cannot claim a new submission");
  } else if (value.status === "blocked") {
    assertExactRecord(value, ["status", "blockerCode", "evidenceDigest"], ["status", "blockerCode"]);
    if (!isBlockerCode(value.blockerCode)) throw new Error("invalid final blocker");
    if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest);
  } else if (value.status === "uncertain") {
    assertExactRecord(value, ["status", "evidenceDigest", "quarantine"], ["status", "quarantine"]);
    if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest);
    if (value.quarantine !== "provider" && value.quarantine !== "caller") throw new Error("invalid final quarantine");
  } else throw new Error("invalid final status");
}

/** Validate a redacted provider identity proof at an adapter boundary. */
export function validateSubmissionTargetEstablishment(
  value: unknown,
  expectedTargetBindingDigest: string,
  expectedActionId?: string
): asserts value is SubmissionTargetEstablishmentObservation {
  assertExactRecord(
    value,
    ["targetBindingDigest", "anchorDigest", "causalSendActionId", "conversationId", "canonicalThreadUrl", "userTurnId", "userTurnEvidenceDigest", "postSendDeltaDigest", "evidenceDigest", "observedAt"],
    ["targetBindingDigest", "anchorDigest", "causalSendActionId", "conversationId", "canonicalThreadUrl", "userTurnId", "userTurnEvidenceDigest", "postSendDeltaDigest", "evidenceDigest"]
  );
  if (
    value.targetBindingDigest !== expectedTargetBindingDigest
    || !isDigest(value.targetBindingDigest)
    || !isDigest(value.anchorDigest)
    || !isUuid(value.causalSendActionId)
    || (expectedActionId !== undefined && value.causalSendActionId !== expectedActionId)
    || !isSafeId(value.conversationId)
    || !isCanonicalThreadUrl(value.canonicalThreadUrl)
    || !isSafeId(value.userTurnId)
    || !isDigest(value.userTurnEvidenceDigest)
    || !isDigest(value.postSendDeltaDigest)
    || !isDigest(value.evidenceDigest)
    || (value.observedAt !== undefined && !isIsoInstant(value.observedAt))
  ) {
    throw new Error("invalid target establishment evidence");
  }
}

/**
 * The establishment callback is a durability boundary, not a fire-and-forget
 * notification. Before a submitted receipt is allowed, its return value must
 * prove that the journal now exposes the same one-way identity refinement.
 * This intentionally reads only bounded own data properties and does not
 * retain or stringify the callback's state object.
 */
function validateDurableTargetEstablishmentResult(
  value: unknown,
  expectedTargetBindingDigest: string,
  expected: SubmissionTargetEstablishmentObservation
): void {
  if (!isPlainRecord(value)) throw new Error("invalid durable target establishment result");
  assertExactRecord(value, ["state", "handle"], ["state", "handle"]);
  const state = value.state;
  const handle = value.handle;
  if (!isPlainRecord(state) || !isPlainRecord(handle)) throw new Error("invalid durable target establishment result");
  const handleTargetDigest = readOwnData(handle, "targetBindingDigest");
  const target = readOwnData(state, "target");
  if (handleTargetDigest !== expectedTargetBindingDigest || !isPlainRecord(target)) {
    throw new Error("durable target establishment is not authenticated");
  }
  if (
    readOwnData(target, "targetLifecycle") !== "new_established"
    || readOwnData(target, "conversationId") !== expected.conversationId
    || readOwnData(target, "canonicalThreadUrl") !== expected.canonicalThreadUrl
  ) {
    throw new Error("durable target establishment identity does not match");
  }
  const durable = readOwnData(target, "targetEstablishment");
  if (!isPlainRecord(durable)) throw new Error("durable target establishment evidence is missing");
  for (const key of [
    "targetBindingDigest",
    "anchorDigest",
    "causalSendActionId",
    "conversationId",
    "canonicalThreadUrl",
    "userTurnId",
    "userTurnEvidenceDigest",
    "evidenceDigest"
  ] as const) {
    if (readOwnData(durable, key) !== expected[key]) throw new Error("durable target establishment evidence does not match");
  }
}

function findUniqueAction(state: OperationStateV1, kind: "send" | "file_handoff"): OperationActionRecordV1 | "corrupt" | undefined {
  const actions = Object.values(state.actions).filter(action => action.kind === kind);
  if (actions.length > 1) return "corrupt";
  return actions[0];
}

function coherentSubmissionState(
  state: OperationStateV1,
  sendAction: OperationActionRecordV1 | "corrupt" | undefined,
  handoffAction: OperationActionRecordV1 | "corrupt" | undefined,
  targetBindingDigest: string,
  manifestCount: number
): boolean {
  if (sendAction === "corrupt" || handoffAction === "corrupt") return false;
  if (sendAction !== undefined && (
    sendAction.kind !== "send" ||
    sendAction.targetDigest !== targetBindingDigest ||
    sendAction.requestDigest !== state.requestDigest ||
    sendAction.repeatPolicy !== "observe_only_after_intent" ||
    !isUuid(sendAction.actionId)
  )) return false;
  if (handoffAction !== undefined && (
    handoffAction.kind !== "file_handoff" ||
    handoffAction.targetDigest !== targetBindingDigest ||
    handoffAction.requestDigest !== state.requestDigest ||
    handoffAction.repeatPolicy !== "observe_only_after_intent" ||
    !isUuid(handoffAction.actionId)
  )) return false;
  if (handoffAction !== undefined && state.mutationBoundary === "none") return false;
  if (sendAction !== undefined && BOUNDARY_RANK[state.mutationBoundary] < BOUNDARY_RANK.send_may_have_occurred) return false;
  if (manifestCount === 0 && handoffAction !== undefined) return false;
  if (manifestCount > 0 && state.phase !== "prepared" && handoffAction === undefined) return false;

  // These are the only legal durable snapshots at each non-repeatable
  // boundary.  A record in an earlier phase is not a harmless hint: it can
  // authorize a mutation that the journal never causally admitted.
  if (state.phase === "prepared") {
    if (sendAction !== undefined) return false;
    // A process can stop after fsyncing a handoff intent (or its satisfied
    // receipt) and before appending handoff_pending/ready.  That committed
    // prefix is valid and must resume through observation only; rejecting it
    // here would strand the exact crash boundary the journal is designed to
    // recover.
    if (handoffAction === undefined) {
      if (state.mutationBoundary !== "none") return false;
    } else if (
      manifestCount === 0
      || state.mutationBoundary !== "handoff_may_have_occurred"
      || (handoffAction.outcome !== undefined && handoffAction.outcome !== "satisfied")
    ) {
      return false;
    }
  } else if (state.phase === "handoff_pending") {
    if (sendAction !== undefined || handoffAction === undefined || handoffAction.outcome !== undefined || state.mutationBoundary !== "handoff_may_have_occurred") return false;
  } else if (state.phase === "ready") {
    if (sendAction !== undefined && sendAction.outcome !== undefined) return false;
    if (manifestCount > 0 && (handoffAction === undefined || handoffAction.outcome !== "satisfied")) return false;
    if (sendAction === undefined && BOUNDARY_RANK[state.mutationBoundary] >= BOUNDARY_RANK.send_may_have_occurred) return false;
    if (sendAction !== undefined && state.mutationBoundary !== "send_may_have_occurred") return false;
  } else if (state.phase === "send_pending") {
    if (sendAction === undefined || sendAction.outcome !== undefined || state.mutationBoundary !== "send_may_have_occurred") return false;
  } else if (state.phase === "submitted" || state.phase === "generating" || state.phase === "capturing") {
    if (sendAction === undefined || sendAction.outcome !== "satisfied" || BOUNDARY_RANK[state.mutationBoundary] < BOUNDARY_RANK.send_may_have_occurred) return false;
  } else if (state.phase === "completed") {
    if (sendAction === undefined || sendAction.outcome !== "satisfied" || BOUNDARY_RANK[state.mutationBoundary] < BOUNDARY_RANK.send_may_have_occurred) return false;
  } else if (state.phase === "uncertain") {
    if (state.mutationBoundary === "handoff_may_have_occurred" && (handoffAction === undefined || (handoffAction.outcome !== undefined && handoffAction.outcome !== "satisfied"))) return false;
    if (BOUNDARY_RANK[state.mutationBoundary] >= BOUNDARY_RANK.send_may_have_occurred && sendAction === undefined) return false;
    if (state.mutationBoundary === "none") return false;
  }

  if (state.receipt !== undefined) {
    if (state.phase !== "completed" || sendAction === undefined || sendAction.outcome !== "satisfied") return false;
  }
  if (state.phase === "completed" && state.receipt === undefined) return false;
  if (state.mutationBoundary === "handoff_may_have_occurred" && handoffAction === undefined) return false;
  if (BOUNDARY_RANK[state.mutationBoundary] >= BOUNDARY_RANK.send_may_have_occurred && sendAction === undefined) return false;
  return true;
}

function targetBindingMatches(operation: SubmissionOperationSnapshot, expected: SubmissionExpectedEnvelope): boolean {
  return operation.handle.targetBindingDigest === expected.targetBindingDigest && operation.state.target !== undefined;
}

function stageReasonToBlocker(reason: SubmissionStageObservation extends infer T ? T extends { reason: infer R } ? R : never : never): SubmissionBlockerCode {
  if (reason === "target") return "target_binding_mismatch";
  if (reason === "configuration") return "configuration_drift";
  if (reason === "composer") return "composer_drift";
  return "port_protocol_violation";
}

function cancellationCode(options: Readonly<{ signal?: AbortSignal; deadlineAt?: number }>): "operation_cancelled" | "operation_timeout" | undefined {
  if (options.signal?.aborted) return "operation_cancelled";
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) return "operation_timeout";
  return undefined;
}

function safeIdentity(operation: unknown): SubmissionBlockerResultBase {
  const operationRecord = safeDataRecord(operation);
  const state = safeDataRecord(readOwnData(operationRecord, "state"));
  const handle = safeDataRecord(readOwnData(operationRecord, "handle"));
  const operationId = readOwnData(state, "operationId");
  const requestDigest = readOwnData(state, "requestDigest");
  const surface = readOwnData(state, "surface");
  const targetBindingDigest = state === undefined ? undefined : readOwnData(handle, "targetBindingDigest");
  return {
    operationId: isUuid(operationId) ? operationId : INVALID_OPERATION_ID,
    requestDigest: isDigest(requestDigest) ? requestDigest : INVALID_DIGEST,
    surface: surface === "work" ? "work" : "chat",
    ...(isDigest(targetBindingDigest) ? { targetBindingDigest } : {})
  };
}

function blockedResult(identity: SubmissionBlockerResultBase, expected: unknown, code: SubmissionBlockerCode, observationRequired: boolean): SubmissionResult {
  // Only the durable operation snapshot can authenticate a target identity.
  // `expected` is caller input and must never replace that identity on an
  // invalid-input path, even when it happens to be digest-shaped.
  void expected;
  return blockedBase(identity, code, observationRequired, "none");
}

function blockedBase(base: SubmissionResultBase | SubmissionBlockerResultBase, code: SubmissionBlockerCode, observationRequired: boolean, boundary: MutationBoundary, evidenceDigest?: string): SubmissionResult {
  return { ...base, kind: "blocked", blocker: blocker(code, observationRequired, boundary, evidenceDigest) };
}

function uncertainBase(base: SubmissionResultBase, code: SubmissionBlockerCode, boundary: MutationBoundary, evidenceDigest?: string): SubmissionResult {
  return { ...base, kind: "uncertain", blocker: blocker(code, true, boundary, evidenceDigest) };
}

function cancelledResult(base: SubmissionResultBase, code: "operation_cancelled" | "operation_timeout", boundary: MutationBoundary): SubmissionResult {
  return {
    ...base,
    kind: "cancelled",
    blocker: {
      code,
      observationRequired: boundary !== "none",
      mutationBoundary: boundary
    }
  };
}

function blocker(code: SubmissionBlockerCode, observationRequired: boolean, mutationBoundary: MutationBoundary, evidenceDigest?: string): SubmissionBlocker {
  return {
    code,
    observationRequired,
    mutationBoundary,
    ...(evidenceDigest === undefined ? {} : { evidenceDigest })
  };
}

function blockerEvidence(base: SubmissionResultBase, expected: SubmissionExpectedEnvelope, code: SubmissionBlockerCode, evidenceDigest?: string): SubmissionBlockerEvidence {
  return {
    kind: "blocker",
    operationId: base.operationId,
    requestDigest: base.requestDigest,
    surface: base.surface,
    phase: "uncertain",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: expected.targetBindingDigest,
    blocker: blocker(code, true, "send_may_have_occurred", evidenceDigest)
  };
}

async function persistBlockerBestEffort(ports: SubmissionPorts, evidence: SubmissionBlockerEvidence): Promise<void> {
  try {
    await ports.persistReceiptEvidence(evidence);
  } catch {
    // The caller receives the original redacted blocker.  No mutation retry is
    // ever authorized by a failed persistence call.
  }
}

function assertDigest(value: string): void {
  if (!isDigest(value)) throw new Error("invalid digest");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCanonicalThreadUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("?") || value.includes("#")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.aborted === "boolean"
    && typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readOwnData(value: unknown, key: string): unknown {
  if (!isPlainRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeDataRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function hasAccessorInPlainData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value !== "object") return false;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return true;
  }
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  if (depth > 32) return true;
  seen.add(value);
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return true;
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) return true;
    if (hasAccessorInPlainData(descriptor.value, seen, depth + 1)) return true;
  }
  return false;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function isOpaqueKey(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_KEY_PATTERN.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isBlockerCode(value: unknown): value is SubmissionBlockerCode {
  return typeof value === "string" && [
    "operation_cancelled", "operation_timeout", "stale_handle", "operation_state_corrupt", "target_binding_mismatch", "target_evidence_unavailable", "configuration_drift", "composer_drift", "attachment_manifest_mismatch", "input_file_changed", "ambiguous_file_handoff", "ambiguous_submit", "concurrent_user_turn", "send_control_unavailable", "tab_ownership_conflict", "runtime_incompatible", "backend_unavailable", "browser_bridge_unavailable", "login_required", "captcha", "rate_limited", "permission_required", "needs_confirmation", "selector_drift", "journal_unavailable", "port_protocol_violation", "already_completed"
  ].includes(value);
}
