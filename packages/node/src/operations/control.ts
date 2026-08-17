import {
  OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION,
  OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  type MutationBoundary,
  type OperationActionRecordV1,
  type OperationBlockerCode,
  type OperationControlReceiptV1,
  type OperationControlRequestV1,
  type OperationHandleV1,
  type OperationStateV1
} from "./types.js";
import { assertOperationStateShape, assertOwnershipBaselineShape } from "./state-machine.js";
import type { OwnershipBaseline } from "./turn-ownership.js";

/**
 * Adapter-free coordinator for operation-bound Stop and Work steer.
 *
 * The coordinator deliberately has no browser or journal dependency.  A
 * caller supplies a keyed control request digest and ports for reloading the
 * authenticated parent state, recording an action intent/receipt, observing
 * the exact assistant turn, and executing one bounded browser transaction.
 * Stop retains its generic one-shot port. Work steer has a stricter,
 * four-phase port: prepare (read only), atomically persist the child intent
 * with its complete per-action baseline, executePrepared once, then verify or
 * recover observation-only. The steer prompt is request-local and never
 * crosses any port in a durable shape.
 */
export const CONTROL_COORDINATOR_SCHEMA_VERSION =
  "chatgpt.browser_control.operation_control_coordinator.v1" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASELINE_EPOCH = "1970-01-01T00:00:00.000Z";
const MAX_STEER_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 86_400_000;
const MAX_DEADLINE_AT = Date.UTC(2100, 0, 1);
// These values are intentionally not valid UUIDs or digests.  They are only
// used on the fail-closed input-error path, where returning a result-shaped
// blocker still requires the public identity fields.  In particular, never
// turn absent or malformed evidence into a cryptographically valid sentinel.
const INVALID_OPERATION_ID = "invalid-operation";
const INVALID_ACTION_ID = "invalid-control";
const INVALID_DIGEST = "invalid-digest";
const INVALID_TURN_ID = "invalid-turn";
const BOUNDARY_RANK: Record<MutationBoundary, number> = {
  none: 0,
  handoff_may_have_occurred: 1,
  send_may_have_occurred: 2,
  control_may_have_occurred: 3
};

export type ControlParentReadRequest = Readonly<{
  operationId: string;
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  controlActionId: string;
  action: "stop" | "steer";
  expectedAssistantTurnId: string;
  requestDigest: string;
}>;

export type ControlParentSnapshot = Readonly<{
  /** Authenticated, freshly reloaded materialized state. */
  state: OperationStateV1;
  /** The current locator derived by the journal owner, not caller input. */
  handle: OperationHandleV1;
  /** A previously persisted receipt for this exact control action, if any. */
  existingReceipt?: OperationControlReceiptV1;
  /**
   * Complete per-action Work-steer anchor loaded from authenticated durable
   * state. It is required for observation-only replay after an intent crossed
   * the fencing point. The shape deliberately contains no prompt, URL, DOM,
   * labels, or provider exception material.
   */
  existingSteerIntent?: ControlSteerDurableIntent;
}>;

/**
 * Request-local Work-steer preparation. This is a control-layer envelope for
 * the browser primitive's prepared record. Every field is identity/evidence;
 * prompt text is intentionally absent.
 */
export type ControlSteerPrepared = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  parentOperationId: string;
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  controlActionId: string;
  action: "steer";
  /** Digest of the child control request; never substituted for parent identity. */
  requestDigest: string;
  expectedAssistantTurnId: string;
  /** Derived by the observation authority from the exact parent assistant. */
  assistantBranchId: string;
  assistantParentTurnId: string;
  baselineSnapshotDigest: string;
  preparedDigest: string;
  /** Complete, redacted, immutable pre-steer ownership baseline. */
  baseline: OwnershipBaseline;
}>;

/**
 * Versioned, prompt-free material for the keyed prepared-action digest.
 *
 * The journal stores `preparedDigest`, not this material, but a restart must
 * be able to reconstruct exactly what was authenticated from the durable
 * action-prepared event. The browser primitive and its service adapter should
 * pass this material (canonicalized by the adapter's digest authority) to the
 * same keyed `work-steer-prepared` digest domain. Keeping the material here
 * makes that contract explicit without making the coordinator depend on a
 * key, browser, or journal implementation.
 */
export const CONTROL_STEER_PREPARED_MATERIAL_SCHEMA_VERSION =
  // Keep this value aligned with the production primitive's digest material
  // schema. The coordinator owns the adapter-neutral contract; the shared
  // version lets service recovery validate the existing primitive digest
  // without persisting another opaque material record.
  "chatgpt.browser_control.production_work_steer.v1" as const;

export type ControlSteerPreparedDigestMaterial = Readonly<{
  schemaVersion: typeof CONTROL_STEER_PREPARED_MATERIAL_SCHEMA_VERSION;
  operationId: string;
  parentRequestDigest: string;
  targetBindingDigest: string;
  controlActionId: string;
  action: "work_steer";
  expectedAssistantTurnId: string;
  assistantBranchId: string;
  assistantParentTurnId: string;
  baselineSnapshotDigest: string;
  baseline: OwnershipBaseline;
}>;

/**
 * Build the exact redacted digest material from either a prepared result or
 * an atomic persistence request. This clones and freezes caller data so a
 * later mutation/accessor cannot change what a service hashes or journals.
 */
export function controlSteerPreparedDigestMaterial(
  value: Pick<ControlSteerPrepared, "parentOperationId" | "parentRequestDigest" | "parentTargetBindingDigest" | "controlActionId" | "expectedAssistantTurnId" | "assistantBranchId" | "assistantParentTurnId" | "baselineSnapshotDigest" | "baseline">
): ControlSteerPreparedDigestMaterial {
  try {
    const cloned = clonePlainData(value);
    if (!isRecord(cloned)) throw new Error("invalid material");
    assertUuid(cloned.parentOperationId, "prepared material operationId");
    assertDigest(cloned.parentRequestDigest, "prepared material parentRequestDigest");
    assertDigest(cloned.parentTargetBindingDigest, "prepared material targetBindingDigest");
    assertUuid(cloned.controlActionId, "prepared material controlActionId");
    assertIdentifier(cloned.expectedAssistantTurnId, "prepared material expectedAssistantTurnId");
    assertIdentifier(cloned.assistantBranchId, "prepared material assistantBranchId");
    assertIdentifier(cloned.assistantParentTurnId, "prepared material assistantParentTurnId");
    assertDigest(cloned.baselineSnapshotDigest, "prepared material baselineSnapshotDigest");
    const baseline = cloned.baseline as OwnershipBaseline;
    assertOwnershipBaselineShape({
      schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
      operationId: cloned.parentOperationId,
      requestDigest: cloned.parentRequestDigest,
      targetBindingDigest: cloned.parentTargetBindingDigest,
      actionId: cloned.controlActionId,
      baseline,
      observedAt: BASELINE_EPOCH
    });
    if (baseline.snapshotDigest !== cloned.baselineSnapshotDigest) throw new Error("baseline digest mismatch");
    if (baseline.completeness !== "complete"
      || baseline.target.canonicalThreadUrl.status !== "unavailable"
      || baseline.target.canonicalThreadUrl.reason !== "redacted") throw new Error("baseline is not complete and redacted");
    const assistants = baseline.assistantTurns.filter(turn => turn.stableId === cloned.expectedAssistantTurnId);
    if (assistants.length !== 1
      || assistants[0]!.branchStableId !== cloned.assistantBranchId
      || assistants[0]!.parentStableId !== cloned.assistantParentTurnId) throw new Error("assistant identity is not derived from baseline");
    return deepFreeze({
      schemaVersion: CONTROL_STEER_PREPARED_MATERIAL_SCHEMA_VERSION,
      operationId: cloned.parentOperationId,
      parentRequestDigest: cloned.parentRequestDigest,
      targetBindingDigest: cloned.parentTargetBindingDigest,
      controlActionId: cloned.controlActionId,
      action: "work_steer",
      expectedAssistantTurnId: cloned.expectedAssistantTurnId,
      assistantBranchId: cloned.assistantBranchId,
      assistantParentTurnId: cloned.assistantParentTurnId,
      baselineSnapshotDigest: cloned.baselineSnapshotDigest,
      baseline
    }) as ControlSteerPreparedDigestMaterial;
  } catch {
    throw new ControlInputError("operation_state_corrupt", "Prepared steer digest material is invalid.");
  }
}

/**
 * Durable replay material. This is intentionally identity fields plus the
 * complete OwnershipBaseline only. A service may map it to its
 * `action_prepared` journal event; it must not add the request prompt.
 */
export type ControlSteerDurableIntent = ControlSteerPrepared;

export type ControlSteerPrepareRequest = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  parentOperationId: string;
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  controlActionId: string;
  requestDigest: string;
  expectedAssistantTurnId: string;
  signal: AbortSignal;
  deadlineAt: number;
}>;

export type ControlSteerExecutePreparedRequest = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  prepared: ControlSteerPrepared;
  signal: AbortSignal;
  deadlineAt: number;
}>;

export type ControlSteerVerifyRequest = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  prepared: ControlSteerPrepared;
  signal: AbortSignal;
  deadlineAt: number;
}>;

export type ControlSteerRecoverRequest = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  prepared: ControlSteerPrepared;
  /** Caller-supplied authenticated baseline; must equal prepared.baseline. */
  baseline: OwnershipBaseline;
  signal: AbortSignal;
  deadlineAt: number;
}>;

/** The only persistence argument exposed by the steer coordinator. */
export type ControlSteerIntentAndBaselinePersistenceRequest = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  parentOperationId: string;
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  controlActionId: string;
  action: "steer";
  requestDigest: string;
  expectedAssistantTurnId: string;
  assistantBranchId: string;
  assistantParentTurnId: string;
  baselineSnapshotDigest: string;
  preparedDigest: string;
  baseline: OwnershipBaseline;
}>;

/**
 * Atomic persistence reports an explicit disposition.  In particular, a
 * different unresolved action is a typed block, not a false execute flag that
 * could accidentally send the caller down a recovery path for another action.
 */
export type ControlSteerIntentAndBaselinePersistenceResult =
  | Readonly<{
      schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
      disposition: "acquired";
    }>
  | Readonly<{
      schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
      disposition: "same_action_recovery";
    }>
  | Readonly<{
      schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
      disposition: "blocked";
      blockerCode: "provider_concurrency_unsupported";
    }>;

export type ControlSteerVerificationReceipt = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  baselineSnapshotDigest: string;
  preparedDigest: string;
  assistantTurnId: string;
  assistantBranchId: string;
  assistantParentTurnId: string;
  userTurnId: string;
  userTurnEvidenceDigest: string;
  postSendDeltaDigest: string;
  evidenceDigest: string;
}>;

type ControlSteerPhaseBase = Readonly<{
  schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
  phase: "prepare" | "execute_prepared" | "verify" | "recovery";
  parentOperationId: string;
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  controlActionId: string;
  action: "steer";
  requestDigest: string;
  expectedAssistantTurnId: string;
  assistantBranchId?: string;
  assistantParentTurnId?: string;
  baselineSnapshotDigest?: string;
  preparedDigest?: string;
}>;

export type ControlSteerPhaseResult =
  | (ControlSteerPhaseBase & Readonly<{
      phase: "prepare";
      status: "prepared";
      observationRequired: false;
      mutationBoundary: "none";
      prepared: ControlSteerPrepared;
    }>)
  | (ControlSteerPhaseBase & Readonly<{
      phase: "execute_prepared";
      status: "executed";
      observationRequired: true;
      mutationBoundary: "control_may_have_occurred";
    }>)
  | (ControlSteerPhaseBase & Readonly<{
      phase: "verify" | "recovery";
      status: "satisfied";
      observationRequired: false;
      mutationBoundary: "control_may_have_occurred";
      receipt: ControlSteerVerificationReceipt;
      assistantBranchId: string;
      assistantParentTurnId: string;
      baselineSnapshotDigest: string;
      preparedDigest: string;
    }>)
  | (ControlSteerPhaseBase & Readonly<{
      status: "blocked";
      blockerCode: OperationBlockerCode;
      observationRequired: boolean;
      mutationBoundary: "none" | "control_may_have_occurred";
      evidenceDigest?: string;
    }>)
  | (ControlSteerPhaseBase & Readonly<{
      status: "uncertain";
      blockerCode: OperationBlockerCode;
      observationRequired: true;
      mutationBoundary: "control_may_have_occurred";
      quarantine: "caller" | "provider";
      evidenceDigest?: string;
    }>);

export type ControlTurnObservation = Readonly<
  | {
      status: "generating";
      assistantTurnId: string;
      evidenceDigest: string;
    }
  | {
      status: "terminal" | "not_found" | "mismatch" | "uncertain";
      assistantTurnId?: string;
      evidenceDigest?: string;
      reason?: "different_turn" | "not_generating" | "target_mismatch" | "unavailable";
    }
>;

export type ControlTurnObservationRequest = Readonly<{
  operationId: string;
  parentRequestDigest: string;
  targetBindingDigest: string;
  expectedAssistantTurnId: string;
  signal: AbortSignal;
  deadlineAt: number;
}>;

export type ControlPostconditionObservation = Readonly<
  | {
      status: "satisfied";
      assistantTurnId: string;
      evidenceDigest: string;
    }
  | {
      status: "not_satisfied";
      assistantTurnId?: string;
      blockerCode: OperationBlockerCode;
      evidenceDigest?: string;
    }
  | {
      status: "uncertain";
      assistantTurnId?: string;
      blockerCode?: OperationBlockerCode;
      evidenceDigest?: string;
    }
>;

export type ControlPostconditionRequest = Readonly<{
  operationId: string;
  parentRequestDigest: string;
  targetBindingDigest: string;
  action: "stop" | "steer";
  controlActionId: string;
  expectedAssistantTurnId: string;
  requestDigest: string;
  signal: AbortSignal;
  deadlineAt: number;
}>;

export type ControlIntentPersistenceRequest = Readonly<{
  operationId: string;
  parentRequestDigest: string;
  targetBindingDigest: string;
  controlActionId: string;
  /** The coordinator uses this compatibility port for Stop only. */
  action: "stop" | "steer";
  requestDigest: string;
}>;

export type ControlExecutionRequest = Readonly<{
  operationId: string;
  parentRequestDigest: string;
  targetBindingDigest: string;
  controlActionId: string;
  action: "stop" | "steer";
  expectedAssistantTurnId: string;
  requestDigest: string;
  /** Work steer never uses this compatibility port; its prompt stays in the browser primitive closure. */
  signal: AbortSignal;
  deadlineAt: number;
}>;

export type ControlExecutionResult = ControlPostconditionObservation;

export type ControlReceiptPersistenceRequest = Readonly<{
  receipt: OperationControlReceiptV1;
  /** Rich per-action ownership evidence for Work-steer integration. */
  steerReceipt?: ControlSteerVerificationReceipt;
}>;

export type ControlPorts = Readonly<{
  readParent(request: ControlParentReadRequest): Promise<ControlParentSnapshot>;
  observeTurn(request: ControlTurnObservationRequest): Promise<ControlTurnObservation>;
  persistActionIntent(request: ControlIntentPersistenceRequest): Promise<void>;
  executeOnce(request: ControlExecutionRequest): Promise<ControlExecutionResult>;
  observePostcondition(request: ControlPostconditionRequest): Promise<ControlPostconditionObservation>;
  persistReceipt(request: ControlReceiptPersistenceRequest): Promise<void>;
  /** Read-only Work-steer preparation. No prompt crosses this boundary. */
  prepareSteer?(request: ControlSteerPrepareRequest): Promise<ControlSteerPhaseResult>;
  /** Atomic child intent + complete per-action baseline persistence. */
  persistSteerIntentAndBaseline?(request: ControlSteerIntentAndBaselinePersistenceRequest): Promise<ControlSteerIntentAndBaselinePersistenceResult>;
  /** One-shot Work-steer mutation. The port must await fill/click settlement. */
  executeSteerPrepared?(request: ControlSteerExecutePreparedRequest): Promise<ControlSteerPhaseResult>;
  /** Read-only postcondition after the same invocation's executePrepared. */
  verifySteer?(request: ControlSteerVerifyRequest): Promise<ControlSteerPhaseResult>;
  /** Read-only restart/quarantine recovery; never compose, fill, or click. */
  recoverSteer?(request: ControlSteerRecoverRequest): Promise<ControlSteerPhaseResult>;
}>;

export type ControlOptions = Readonly<{
  signal?: AbortSignal;
  /** Absolute epoch milliseconds.  The earlier of this and request timeout wins. */
  deadlineAt?: number;
  now?: () => number;
}>;

export type ControlBlocker = Readonly<{
  code: OperationBlockerCode;
  observationRequired: boolean;
  mutationBoundary: MutationBoundary;
  evidenceDigest?: string;
}>;

export type ControlResultBase = Readonly<{
  controlActionId: string;
  parentOperationId: string;
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  requestDigest: string;
  action: "stop" | "steer";
  expectedAssistantTurnId: string;
}>;

export type ControlResult =
  | (ControlResultBase & Readonly<{
      kind: "completed";
      receipt: OperationControlReceiptV1;
      /** Present only after a verified Work-steer exact delta. */
      steerReceipt?: ControlSteerVerificationReceipt;
    }>)
  | (ControlResultBase & Readonly<{
      kind: "blocked";
      blocker: ControlBlocker;
      receipt?: OperationControlReceiptV1;
      steerReceipt?: ControlSteerVerificationReceipt;
    }>)
  | (ControlResultBase & Readonly<{
      kind: "uncertain";
      blocker: ControlBlocker;
      receipt?: OperationControlReceiptV1;
      steerReceipt?: ControlSteerVerificationReceipt;
    }>);

export class ControlInputError extends Error {
  constructor(public readonly code: OperationBlockerCode, message: string) {
    super(message);
    this.name = "ControlInputError";
  }
}

type Normalized = Readonly<{
  request: OperationControlRequestV1;
  requestDigest: string;
  ports: ControlPorts;
  signal: AbortSignal;
  deadlineAt: number;
  now: () => number;
  base: ControlResultBase;
}>;

/**
 * Run one operation-bound control action.  A durable action intent authorizes
 * at most one executeOnce call.  Any later call with the same action ID is
 * observation-only, even when the previous call rejected after the provider
 * may already have acted.
 */
export async function runOperationControl(
  request: OperationControlRequestV1,
  requestDigest: string,
  ports: ControlPorts,
  options: ControlOptions = {}
): Promise<ControlResult> {
  let normalized: Normalized;
  try {
    // Validate the object graph without reading accessor-backed properties.
    // A hostile getter must not run merely because the operation is being
    // converted into a redacted blocker result.
    if (hasAccessorInPlainData(request) || hasAccessorInPlainData(options)) {
      throw new ControlInputError("operation_state_corrupt", "Control input contains accessor-backed identity data.");
    }
    normalized = normalizeInput(request, requestDigest, ports, options);
  } catch (error) {
    const identity = safeBase(request, requestDigest);
    const code = error instanceof ControlInputError ? error.code : "operation_state_corrupt";
    return blockedResult(identity, code, false, "none");
  }

  if (isCancelled(normalized)) {
    return blockedResult(normalized.base, cancellationCode(normalized)!, false, "none");
  }

  let parent: ControlParentSnapshot;
  try {
    parent = await normalized.ports.readParent({
      operationId: normalized.request.parent.operationId,
      parentRequestDigest: normalized.request.parent.requestDigest,
      parentTargetBindingDigest: normalized.request.parent.targetBindingDigest!,
      controlActionId: normalized.request.controlActionId,
      action: normalized.request.action,
      expectedAssistantTurnId: normalized.request.expectedAssistantTurnId,
      requestDigest: normalized.requestDigest
    });
    validateParentSnapshot(normalized.request, normalized.requestDigest, parent);
  } catch (error) {
    const code = parentErrorCode(error);
    return blockedResult(normalized.base, code, false, "none");
  }

  const existing = findExistingAction(parent.state, normalized.request.controlActionId);
  if (existing === "corrupt") {
    return blockedResult(normalized.base, "operation_state_corrupt", false, parent.state.mutationBoundary);
  }
  if (existing !== undefined && !actionMatches(existing, normalized.request, normalized.requestDigest)) {
    return blockedResult(
      normalized.base,
      existing.requestDigest !== normalized.requestDigest ? "operation_request_mismatch" : "target_binding_mismatch",
      false,
      parent.state.mutationBoundary
    );
  }

  if (parent.existingReceipt !== undefined) {
    return resultFromReceipt(normalized.base, parent.existingReceipt);
  }

  // Once an intent exists, even one recovered from a previous process, this
  // path cannot call a browser execution port. Work steer requires the
  // caller-supplied authenticated baseline and uses recovery only; it never
  // falls back to the generic postcondition or mutation path.
  if (existing !== undefined) {
    if (normalized.request.action === "steer") {
      return await reconcileExistingSteer(normalized, parent);
    }
    return await reconcileExisting(normalized, parent.state.mutationBoundary);
  }

  if (normalized.request.action === "steer") {
    return await runSteerPhases(normalized, parent);
  }

  const precondition = await observeTurnSafely(normalized);
  if (precondition.kind !== "exact") {
    return blockedResult(
      normalized.base,
      precondition.code,
      precondition.observationRequired,
      parent.state.mutationBoundary,
      precondition.evidenceDigest
    );
  }

  // The intent is the fencing point.  If this call rejects, no browser call
  // is attempted: the caller must reload state before deciding whether the
  // intent committed.
  try {
    await normalized.ports.persistActionIntent({
      operationId: normalized.base.parentOperationId,
      parentRequestDigest: normalized.base.parentRequestDigest,
      targetBindingDigest: normalized.base.parentTargetBindingDigest,
      controlActionId: normalized.base.controlActionId,
      action: normalized.base.action,
      requestDigest: normalized.base.requestDigest
    });
  } catch {
    return blockedResult(normalized.base, "backend_unavailable", false, parent.state.mutationBoundary);
  }

  // Cancellation/timeout after intent is never a licence to retry later by
  // calling executeOnce again.  We make one read-only reconciliation attempt
  // when possible and otherwise return a durable uncertain receipt.
  if (isCancelled(normalized)) {
    return await settleAfterIntent(
      normalized,
      parent.state.mutationBoundary,
      cancellationCode(normalized)!
    );
  }

  let execution: ControlExecutionResult;
  try {
    execution = await normalized.ports.executeOnce({
      operationId: normalized.base.parentOperationId,
      parentRequestDigest: normalized.base.parentRequestDigest,
      targetBindingDigest: normalized.base.parentTargetBindingDigest,
      controlActionId: normalized.base.controlActionId,
      action: normalized.base.action,
      expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
      requestDigest: normalized.base.requestDigest,
      signal: normalized.signal,
      deadlineAt: normalized.deadlineAt
    });
    validateExecutionResult(execution, normalized.base.expectedAssistantTurnId);
  } catch {
    execution = { status: "uncertain", blockerCode: "send_control_unavailable" };
  }

  if (execution.status === "satisfied") {
    return await persistOutcome(normalized, parent.state.mutationBoundary, {
      outcome: "satisfied",
      evidenceDigest: execution.evidenceDigest
    });
  }
  if (execution.status === "not_satisfied") {
    return await persistOutcome(normalized, parent.state.mutationBoundary, {
      outcome: "not_satisfied",
      blockerCode: execution.blockerCode,
      ...(execution.evidenceDigest === undefined ? {} : { evidenceDigest: execution.evidenceDigest })
    });
  }

  // An uncertain or throwing execution is reconciled exactly once.  This
  // observation has no mutation capability and is safe to repeat on a later
  // caller invocation, while executeOnce remains permanently forbidden.
  return await reconcileAfterIntent(normalized, parent.state.mutationBoundary, execution);
}

/** Run the four-phase Work-steer coordinator after the parent is reloaded. */
async function runSteerPhases(normalized: Normalized, parent: ControlParentSnapshot): Promise<ControlResult> {
  const preparePort = normalized.ports.prepareSteer;
  const persistPort = normalized.ports.persistSteerIntentAndBaseline;
  const executePort = normalized.ports.executeSteerPrepared;
  const verifyPort = normalized.ports.verifySteer;
  const recoverPort = normalized.ports.recoverSteer;
  // normalizeInput enforces this branch. Keep the guard here as a second
  // fail-closed seam in case a mutable port object changes after validation.
  if (preparePort === undefined || persistPort === undefined || executePort === undefined || verifyPort === undefined || recoverPort === undefined) {
    return blockedResult(normalized.base, "backend_unavailable", true, parent.state.mutationBoundary);
  }

  let preparedResult: ControlSteerPhaseResult;
  try {
    preparedResult = validateSteerPhaseResult(
      await preparePort({
        schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
        parentOperationId: normalized.base.parentOperationId,
        parentRequestDigest: normalized.base.parentRequestDigest,
        parentTargetBindingDigest: normalized.base.parentTargetBindingDigest,
        controlActionId: normalized.base.controlActionId,
        requestDigest: normalized.base.requestDigest,
        expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
        signal: normalized.signal,
        deadlineAt: normalized.deadlineAt
      }),
      "prepare",
      normalized
    );
  } catch (error) {
    return blockedResult(normalized.base, cancellationCode(normalized) ?? (error instanceof ControlInputError ? error.code : "target_evidence_unavailable"), true, parent.state.mutationBoundary);
  }
  if (preparedResult.status !== "prepared") {
    return steerPhaseResultToControl(normalized, preparedResult, parent.state.mutationBoundary);
  }
  const prepared = preparedResult.prepared;
  try {
    validateSteerPreparedTarget(prepared, parent.state);
  } catch (error) {
    return blockedResult(normalized.base, error instanceof ControlInputError ? error.code : "target_binding_mismatch", true, parent.state.mutationBoundary);
  }
  if (isCancelled(normalized)) {
    return blockedResult(normalized.base, cancellationCode(normalized) ?? "operation_timeout", false, parent.state.mutationBoundary);
  }

  const persistenceRequest: ControlSteerIntentAndBaselinePersistenceRequest = {
    schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
    parentOperationId: normalized.base.parentOperationId,
    parentRequestDigest: normalized.base.parentRequestDigest,
    parentTargetBindingDigest: normalized.base.parentTargetBindingDigest,
    controlActionId: normalized.base.controlActionId,
    action: "steer",
    requestDigest: normalized.base.requestDigest,
    expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
    assistantBranchId: prepared.assistantBranchId,
    assistantParentTurnId: prepared.assistantParentTurnId,
    baselineSnapshotDigest: prepared.baselineSnapshotDigest,
    preparedDigest: prepared.preparedDigest,
    baseline: prepared.baseline
  };

  let persistenceResult: ControlSteerIntentAndBaselinePersistenceResult;
  try {
    persistenceResult = validateSteerPersistenceResult(await persistPort(persistenceRequest));
  } catch (error) {
    // A durable identity/baseline conflict is a state or request error, not
    // an ambiguous append acknowledgement. Surface it directly and never
    // turn corruption into a recovery attempt for a different action.
    const durableErrorCode = steerPersistenceFailureCode(error);
    if (durableErrorCode !== undefined) {
      return blockedResult(normalized.base, durableErrorCode, true, parent.state.mutationBoundary);
    }
    // A journal append can commit and throw. Reload once and converge to the
    // durable prefix; never execute merely because the write raised.
    const converged = await reloadSteerAfterPersistenceFailure(normalized);
    if (converged !== undefined) return await reconcileExistingSteer(normalized, converged);
    // The write may have committed even though the reload failed. Quarantine
    // the action until a later caller can reload the authenticated baseline;
    // never advertise this ambiguous prefix as a clean pre-intent block.
    return steerFailureResult(normalized, "uncertain", "backend_unavailable", true);
  }

  // A same-action replay/commit-then-throw may have supplied an already-durable
  // action and baseline. It is never allowed to execute its request-local
  // prepared record: reload the authenticated durable prefix and recover
  // observation only. A different unresolved action is an explicit typed
  // block; there is no current action for this invocation to recover.
  if (persistenceResult.disposition === "blocked") {
    return blockedResult(
      normalized.base,
      persistenceResult.blockerCode,
      true,
      parent.state.mutationBoundary
    );
  }
  if (persistenceResult.disposition === "same_action_recovery") {
    const converged = await reloadSteerAfterPersistenceFailure(normalized);
    if (converged !== undefined) return await reconcileExistingSteer(normalized, converged);
    return steerFailureResult(normalized, "uncertain", "backend_unavailable", true);
  }

  if (isCancelled(normalized)) {
    // The fence was acquired, but this invocation has not called the browser
    // mutation port. Record a clean rejection so a retry returns the same
    // durable outcome without attempting executePrepared.
    return await persistOutcome(normalized, parent.state.mutationBoundary, {
      outcome: "not_satisfied",
      blockerCode: cancellationCode(normalized)!
    });
  }

  let executionResult: ControlSteerPhaseResult;
  try {
    executionResult = validateSteerPhaseResult(
      await executePort({ schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION, prepared, signal: normalized.signal, deadlineAt: normalized.deadlineAt }),
      "execute_prepared",
      normalized,
      prepared
    );
  } catch {
    executionResult = uncertainSteerPhase(normalized, "execute_prepared", prepared, cancellationCode(normalized) ?? "send_control_unavailable");
  }

  // A failed final recheck is a durable, non-mutating rejection. Persist its
  // bounded blocker rather than invoking another browser phase. The complete
  // baseline remains useful evidence that no mutation crossed this fence.
  if (executionResult.status === "blocked" && executionResult.mutationBoundary === "none" && !executionResult.observationRequired) {
    return await persistOutcome(normalized, parent.state.mutationBoundary, {
      outcome: "not_satisfied",
      blockerCode: executionResult.blockerCode,
      ...(executionResult.evidenceDigest === undefined ? {} : { evidenceDigest: executionResult.evidenceDigest })
    });
  }

  if (executionResult.status === "blocked" && executionResult.mutationBoundary === "none" && executionResult.observationRequired) {
    return await verifySteerAfterIntent(normalized, prepared, verifyPort, "target_evidence_unavailable");
  }

  // Executed, uncertain, and any provider-ambiguous result all converge via
  // exactly one read-only verify. executePrepared is never retried here.
  return await verifySteerAfterIntent(
    normalized,
    prepared,
    verifyPort,
    executionResult.status === "uncertain" ? executionResult.blockerCode : "send_control_unavailable"
  );
}

function steerPersistenceFailureCode(error: unknown): "operation_state_corrupt" | "operation_request_mismatch" | "target_binding_mismatch" | undefined {
  if (error instanceof ControlInputError) return error.code === "operation_state_corrupt" || error.code === "operation_request_mismatch" || error.code === "target_binding_mismatch"
    ? error.code
    : undefined;
  if (error instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    return code === "operation_state_corrupt" || code === "operation_request_mismatch" || code === "target_binding_mismatch"
      ? code
      : undefined;
  }
  if (!isRecord(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  const code = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  return code === "operation_state_corrupt" || code === "operation_request_mismatch" || code === "target_binding_mismatch"
    ? code
    : undefined;
}

async function reconcileExistingSteer(normalized: Normalized, parent: ControlParentSnapshot): Promise<ControlResult> {
  if (parent.existingReceipt !== undefined) return resultFromReceipt(normalized.base, parent.existingReceipt);
  const recoverPort = normalized.ports.recoverSteer;
  const durable = parent.existingSteerIntent;
  if (recoverPort === undefined || durable === undefined) {
    return blockedResult(normalized.base, "operation_state_corrupt", true, "control_may_have_occurred");
  }
  let prepared: ControlSteerPrepared;
  try {
    prepared = validateSteerPrepared(durable, normalized, true);
    validateSteerPreparedTarget(prepared, parent.state);
  } catch (error) {
    return blockedResult(normalized.base, error instanceof ControlInputError ? error.code : "operation_state_corrupt", true, "control_may_have_occurred");
  }
  let recovery: ControlSteerPhaseResult;
  try {
    recovery = validateSteerPhaseResult(
      await recoverPort({
        schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
        prepared,
        baseline: prepared.baseline,
        signal: normalized.signal,
        deadlineAt: normalized.deadlineAt
      }),
      "recovery",
      normalized,
      prepared
    );
  } catch {
    recovery = uncertainSteerPhase(normalized, "recovery", prepared, cancellationCode(normalized) ?? "send_control_unavailable");
  }
  return await settleSteerObservation(normalized, recovery, "send_control_unavailable");
}

async function reloadSteerAfterPersistenceFailure(normalized: Normalized): Promise<ControlParentSnapshot | undefined> {
  try {
    const reloaded = await normalized.ports.readParent({
      operationId: normalized.base.parentOperationId,
      parentRequestDigest: normalized.base.parentRequestDigest,
      parentTargetBindingDigest: normalized.base.parentTargetBindingDigest,
      controlActionId: normalized.base.controlActionId,
      action: "steer",
      expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
      requestDigest: normalized.base.requestDigest
    });
    validateParentSnapshot(normalized.request, normalized.requestDigest, reloaded);
    if (reloaded.existingReceipt !== undefined || reloaded.existingSteerIntent !== undefined) return reloaded;
  } catch {
    // The original persistence result remains ambiguous; do not expose a
    // provider/journal error or make a second mutation decision.
  }
  return undefined;
}

async function verifySteerAfterIntent(
  normalized: Normalized,
  prepared: ControlSteerPrepared,
  verifyPort: NonNullable<ControlPorts["verifySteer"]>,
  fallback: OperationBlockerCode
): Promise<ControlResult> {
  if (!canAttemptObservation(normalized)) {
    return steerFailureResult(normalized, "uncertain", cancellationCode(normalized) ?? fallback, true);
  }
  try {
    const verification = validateSteerPhaseResult(
      await verifyPort({ schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION, prepared, signal: normalized.signal, deadlineAt: normalized.deadlineAt }),
      "verify",
      normalized,
      prepared
    );
    return await settleSteerObservation(normalized, verification, fallback);
  } catch {
    return steerFailureResult(normalized, "uncertain", cancellationCode(normalized) ?? fallback, true);
  }
}

async function settleSteerObservation(
  normalized: Normalized,
  observation: ControlSteerPhaseResult,
  fallback: OperationBlockerCode
): Promise<ControlResult> {
  if (observation.status === "satisfied") {
    return await persistOutcome(normalized, "control_may_have_occurred", {
      outcome: "satisfied",
      evidenceDigest: observation.receipt.evidenceDigest,
      steerReceipt: observation.receipt
    });
  }
  if (observation.status === "blocked") {
    return steerFailureResult(normalized, "blocked", observation.blockerCode, observation.observationRequired, observation.evidenceDigest);
  }
  if (observation.status === "uncertain") {
    return steerFailureResult(normalized, "uncertain", observation.blockerCode ?? cancellationCode(normalized) ?? fallback, true, observation.evidenceDigest);
  }
  return steerFailureResult(normalized, "uncertain", "operation_state_corrupt", true);
}

function steerFailureResult(
  normalized: Normalized,
  kind: "blocked" | "uncertain",
  code: OperationBlockerCode,
  observationRequired: boolean,
  evidenceDigest?: string
): ControlResult {
  if (kind === "blocked") return blockedResult(normalized.base, code, observationRequired, "control_may_have_occurred", evidenceDigest);
  return {
    ...normalized.base,
    kind: "uncertain",
    blocker: blocker(code, true, "control_may_have_occurred", evidenceDigest)
  };
}

function steerPhaseResultToControl(
  normalized: Normalized,
  result: ControlSteerPhaseResult,
  boundary: MutationBoundary
): ControlResult {
  if (result.status === "blocked") {
    return blockedResult(
      normalized.base,
      result.blockerCode,
      result.observationRequired,
      maxBoundary(boundary, result.mutationBoundary),
      result.evidenceDigest
    );
  }
  if (result.status === "uncertain") {
    if (result.phase === "prepare") {
      return blockedResult(normalized.base, result.blockerCode, result.observationRequired, boundary, result.evidenceDigest);
    }
    return {
      ...normalized.base,
      kind: "uncertain",
      blocker: blocker(result.blockerCode, true, "control_may_have_occurred", result.evidenceDigest)
    };
  }
  return {
    ...normalized.base,
    kind: "blocked",
    blocker: blocker("operation_state_corrupt", true, boundary)
  };
}

function maxBoundary(left: MutationBoundary, right: MutationBoundary): MutationBoundary {
  return BOUNDARY_RANK[left] >= BOUNDARY_RANK[right] ? left : right;
}

function uncertainSteerPhase(
  normalized: Normalized,
  phase: "execute_prepared" | "recovery",
  prepared: ControlSteerPrepared,
  blockerCode: OperationBlockerCode
): ControlSteerPhaseResult {
  return {
    ...steerPhaseBase(normalized, phase, prepared),
    status: "uncertain",
    blockerCode,
    observationRequired: true,
    mutationBoundary: "control_may_have_occurred",
    quarantine: "caller"
  };
}

function steerPhaseBase(
  normalized: Normalized,
  phase: "prepare" | "execute_prepared" | "verify" | "recovery",
  prepared?: ControlSteerPrepared
): ControlSteerPhaseBase {
  return {
    schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
    phase,
    parentOperationId: normalized.base.parentOperationId,
    parentRequestDigest: normalized.base.parentRequestDigest,
    parentTargetBindingDigest: normalized.base.parentTargetBindingDigest,
    controlActionId: normalized.base.controlActionId,
    action: "steer",
    requestDigest: normalized.base.requestDigest,
    expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
    ...(prepared === undefined ? {} : {
      assistantBranchId: prepared.assistantBranchId,
      assistantParentTurnId: prepared.assistantParentTurnId,
      baselineSnapshotDigest: prepared.baselineSnapshotDigest,
      preparedDigest: prepared.preparedDigest
    })
  };
}

function validateSteerPersistenceResult(value: unknown): ControlSteerIntentAndBaselinePersistenceResult {
  const cloned = clonePlainData(value);
  if (!isRecord(cloned)) throw new ControlInputError("operation_state_corrupt", "Steer persistence result is invalid.");
  if (cloned.schemaVersion !== CONTROL_COORDINATOR_SCHEMA_VERSION || typeof cloned.disposition !== "string") {
    throw new ControlInputError("operation_state_corrupt", "Steer persistence result schema is invalid.");
  }
  if (cloned.disposition === "acquired" || cloned.disposition === "same_action_recovery") {
    assertExactRecord(cloned, ["schemaVersion", "disposition"], ["schemaVersion", "disposition"]);
    return deepFreeze(cloned as unknown as ControlSteerIntentAndBaselinePersistenceResult);
  }
  if (cloned.disposition === "blocked") {
    assertExactRecord(cloned, ["schemaVersion", "disposition", "blockerCode"], ["schemaVersion", "disposition", "blockerCode"]);
    if (cloned.blockerCode !== "provider_concurrency_unsupported") {
      throw new ControlInputError("operation_state_corrupt", "Steer persistence blocker is invalid.");
    }
    return deepFreeze(cloned as unknown as ControlSteerIntentAndBaselinePersistenceResult);
  }
  throw new ControlInputError("operation_state_corrupt", "Steer persistence disposition is invalid.");
}

function validateSteerPhaseResult(
  value: unknown,
  phase: "prepare" | "execute_prepared" | "verify" | "recovery",
  normalized: Normalized,
  prepared?: ControlSteerPrepared
): ControlSteerPhaseResult {
  const cloned = clonePlainData(value);
  if (!isRecord(cloned)) throw new ControlInputError("operation_state_corrupt", "Steer phase result is invalid.");
  assertExactRecord(
    cloned,
    [
      "schemaVersion", "phase", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "controlActionId",
      "action", "requestDigest", "expectedAssistantTurnId", "assistantBranchId", "assistantParentTurnId",
      "baselineSnapshotDigest", "preparedDigest", "status", "observationRequired", "mutationBoundary",
      "prepared", "receipt", "blockerCode", "quarantine", "evidenceDigest"
    ],
    ["schemaVersion", "phase", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "controlActionId", "action", "requestDigest", "expectedAssistantTurnId", "status", "observationRequired", "mutationBoundary"]
  );
  if (cloned.schemaVersion !== CONTROL_COORDINATOR_SCHEMA_VERSION
    || cloned.phase !== phase
    || cloned.parentOperationId !== normalized.base.parentOperationId
    || cloned.parentRequestDigest !== normalized.base.parentRequestDigest
    || cloned.parentTargetBindingDigest !== normalized.base.parentTargetBindingDigest
    || cloned.controlActionId !== normalized.base.controlActionId
    || cloned.action !== "steer"
    || cloned.requestDigest !== normalized.base.requestDigest
    || cloned.expectedAssistantTurnId !== normalized.base.expectedAssistantTurnId) {
    throw new ControlInputError("operation_request_mismatch", "Steer phase identity does not match the control request.");
  }
  if (typeof cloned.observationRequired !== "boolean") throw new ControlInputError("operation_state_corrupt", "Steer phase observation flag is invalid.");
  if (cloned.mutationBoundary !== "none" && cloned.mutationBoundary !== "control_may_have_occurred") throw new ControlInputError("operation_state_corrupt", "Steer phase mutation boundary is invalid.");
  if (phase === "prepare" && cloned.mutationBoundary !== "none") throw new ControlInputError("operation_state_corrupt", "Read-only steer preparation crossed a mutation boundary.");
  if (cloned.assistantBranchId !== undefined) assertIdentifier(cloned.assistantBranchId, "steer.assistantBranchId");
  if (cloned.assistantParentTurnId !== undefined) assertIdentifier(cloned.assistantParentTurnId, "steer.assistantParentTurnId");
  if (cloned.baselineSnapshotDigest !== undefined) assertDigest(cloned.baselineSnapshotDigest, "steer.baselineSnapshotDigest");
  if (cloned.preparedDigest !== undefined) assertDigest(cloned.preparedDigest, "steer.preparedDigest");
  if (cloned.evidenceDigest !== undefined) assertDigest(cloned.evidenceDigest, "steer.evidenceDigest");
  if (cloned.status === "prepared") {
    if (phase !== "prepare" || cloned.observationRequired !== false || cloned.mutationBoundary !== "none" || cloned.prepared === undefined) throw new ControlInputError("operation_state_corrupt", "Steer preparation result branch is invalid.");
    const checked = validateSteerPrepared(cloned.prepared, normalized, false);
    if (checked.parentOperationId !== normalized.base.parentOperationId || checked.requestDigest !== normalized.base.requestDigest) throw new ControlInputError("operation_request_mismatch", "Prepared steer identity does not match the request.");
    const result = { ...cloned, prepared: checked } as ControlSteerPhaseResult;
    return deepFreeze(result);
  }
  if (cloned.status === "executed") {
    if (phase !== "execute_prepared" || cloned.observationRequired !== true || cloned.mutationBoundary !== "control_may_have_occurred" || cloned.prepared !== undefined || cloned.receipt !== undefined) throw new ControlInputError("operation_state_corrupt", "Steer execution result branch is invalid.");
    if (prepared === undefined) throw new ControlInputError("operation_state_corrupt", "Steer execution result lacks its prepared identity.");
    return deepFreeze(cloned as unknown as ControlSteerPhaseResult);
  }
  if (cloned.status === "satisfied") {
    if ((phase !== "verify" && phase !== "recovery") || cloned.observationRequired !== false || cloned.mutationBoundary !== "control_may_have_occurred" || cloned.receipt === undefined) throw new ControlInputError("operation_state_corrupt", "Steer verification result branch is invalid.");
    if (prepared === undefined) throw new ControlInputError("operation_state_corrupt", "Steer verification result lacks its prepared identity.");
    const receipt = validateSteerReceipt(cloned.receipt, prepared);
    if (cloned.assistantBranchId !== prepared.assistantBranchId || cloned.assistantParentTurnId !== prepared.assistantParentTurnId || cloned.baselineSnapshotDigest !== prepared.baselineSnapshotDigest || cloned.preparedDigest !== prepared.preparedDigest) throw new ControlInputError("operation_request_mismatch", "Steer verification identity does not match the prepared action.");
    return deepFreeze({ ...cloned, receipt } as ControlSteerPhaseResult);
  }
  if (cloned.status === "blocked") {
    if (cloned.blockerCode === undefined) throw new ControlInputError("operation_state_corrupt", "Steer blocker is missing a code.");
    assertBlockerCode(cloned.blockerCode);
    if (cloned.quarantine !== undefined) throw new ControlInputError("operation_state_corrupt", "Blocked steer result cannot carry a quarantine.");
    return deepFreeze(cloned as unknown as ControlSteerPhaseResult);
  }
  if (cloned.status === "uncertain") {
    if (cloned.blockerCode === undefined || cloned.observationRequired !== true || cloned.mutationBoundary !== "control_may_have_occurred" || (cloned.quarantine !== "caller" && cloned.quarantine !== "provider")) throw new ControlInputError("operation_state_corrupt", "Steer uncertainty branch is invalid.");
    assertBlockerCode(cloned.blockerCode);
    return deepFreeze(cloned as unknown as ControlSteerPhaseResult);
  }
  throw new ControlInputError("operation_state_corrupt", "Steer phase result status is invalid.");
}

function validateSteerPrepared(value: unknown, normalized: Normalized, durable: boolean): ControlSteerPrepared {
  const cloned = clonePlainData(value);
  if (!isRecord(cloned)) throw new ControlInputError("operation_state_corrupt", "Prepared steer value is invalid.");
  assertExactRecord(
    cloned,
    ["schemaVersion", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "controlActionId", "action", "requestDigest", "expectedAssistantTurnId", "assistantBranchId", "assistantParentTurnId", "baselineSnapshotDigest", "preparedDigest", "baseline"],
    ["schemaVersion", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "controlActionId", "action", "requestDigest", "expectedAssistantTurnId", "assistantBranchId", "assistantParentTurnId", "baselineSnapshotDigest", "preparedDigest", "baseline"]
  );
  if (cloned.schemaVersion !== CONTROL_COORDINATOR_SCHEMA_VERSION || cloned.action !== "steer") throw new ControlInputError("operation_state_corrupt", "Prepared steer schema is invalid.");
  if (cloned.parentOperationId !== normalized.base.parentOperationId || cloned.parentRequestDigest !== normalized.base.parentRequestDigest || cloned.parentTargetBindingDigest !== normalized.base.parentTargetBindingDigest || cloned.controlActionId !== normalized.base.controlActionId || cloned.requestDigest !== normalized.base.requestDigest || cloned.expectedAssistantTurnId !== normalized.base.expectedAssistantTurnId) throw new ControlInputError("operation_request_mismatch", "Prepared steer identity does not match the request.");
  assertUuid(cloned.parentOperationId, "prepared.parentOperationId");
  assertDigest(cloned.parentRequestDigest, "prepared.parentRequestDigest");
  assertDigest(cloned.parentTargetBindingDigest, "prepared.parentTargetBindingDigest");
  assertUuid(cloned.controlActionId, "prepared.controlActionId");
  assertDigest(cloned.requestDigest, "prepared.requestDigest");
  if (cloned.requestDigest === cloned.parentRequestDigest) throw new ControlInputError("operation_request_mismatch", "Steer child request digest must remain distinct from its parent digest.");
  assertIdentifier(cloned.expectedAssistantTurnId, "prepared.expectedAssistantTurnId");
  assertIdentifier(cloned.assistantBranchId, "prepared.assistantBranchId");
  assertIdentifier(cloned.assistantParentTurnId, "prepared.assistantParentTurnId");
  assertDigest(cloned.baselineSnapshotDigest, "prepared.baselineSnapshotDigest");
  assertDigest(cloned.preparedDigest, "prepared.preparedDigest");
  try {
    assertOwnershipBaselineShape({
      schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
      operationId: cloned.parentOperationId,
      requestDigest: cloned.parentRequestDigest,
      targetBindingDigest: cloned.parentTargetBindingDigest,
      actionId: cloned.controlActionId,
      baseline: cloned.baseline,
      observedAt: BASELINE_EPOCH
    });
  } catch {
    throw new ControlInputError("operation_state_corrupt", "Prepared steer baseline is invalid.");
  }
  const baseline = cloned.baseline as OwnershipBaseline;
  if (baseline.snapshotDigest !== cloned.baselineSnapshotDigest) throw new ControlInputError("operation_state_corrupt", "Prepared steer baseline digest is inconsistent.");
  if (baseline.target.canonicalThreadUrl.status !== "unavailable" || baseline.target.canonicalThreadUrl.reason !== "redacted") throw new ControlInputError("operation_state_corrupt", "Prepared steer baseline is not redacted.");
  const assistants = baseline.assistantTurns.filter(turn => turn.stableId === cloned.expectedAssistantTurnId);
  if (assistants.length !== 1 || assistants[0]!.branchStableId !== cloned.assistantBranchId || assistants[0]!.parentStableId !== cloned.assistantParentTurnId) throw new ControlInputError("target_binding_mismatch", "Prepared steer parent identity is not derived from the baseline.");
  if (durable && baseline.completeness !== "complete") throw new ControlInputError("operation_state_corrupt", "Durable steer baseline is incomplete.");
  return deepFreeze({ ...cloned, baseline } as unknown as ControlSteerPrepared);
}

function validateSteerReceipt(value: unknown, prepared: ControlSteerPrepared): ControlSteerVerificationReceipt {
  const receipt = clonePlainData(value);
  if (!isRecord(receipt)) throw new ControlInputError("operation_state_corrupt", "Steer verification receipt is invalid.");
  assertExactRecord(receipt, ["schemaVersion", "baselineSnapshotDigest", "preparedDigest", "assistantTurnId", "assistantBranchId", "assistantParentTurnId", "userTurnId", "userTurnEvidenceDigest", "postSendDeltaDigest", "evidenceDigest"], ["schemaVersion", "baselineSnapshotDigest", "preparedDigest", "assistantTurnId", "assistantBranchId", "assistantParentTurnId", "userTurnId", "userTurnEvidenceDigest", "postSendDeltaDigest", "evidenceDigest"]);
  if (receipt.schemaVersion !== CONTROL_COORDINATOR_SCHEMA_VERSION) throw new ControlInputError("operation_state_corrupt", "Steer verification receipt schema is invalid.");
  assertDigest(receipt.baselineSnapshotDigest, "steer.receipt.baselineSnapshotDigest");
  assertDigest(receipt.preparedDigest, "steer.receipt.preparedDigest");
  assertIdentifier(receipt.assistantTurnId, "steer.receipt.assistantTurnId");
  assertIdentifier(receipt.assistantBranchId, "steer.receipt.assistantBranchId");
  assertIdentifier(receipt.assistantParentTurnId, "steer.receipt.assistantParentTurnId");
  assertIdentifier(receipt.userTurnId, "steer.receipt.userTurnId");
  assertDigest(receipt.userTurnEvidenceDigest, "steer.receipt.userTurnEvidenceDigest");
  assertDigest(receipt.postSendDeltaDigest, "steer.receipt.postSendDeltaDigest");
  assertDigest(receipt.evidenceDigest, "steer.receipt.evidenceDigest");
  if (receipt.baselineSnapshotDigest !== prepared.baselineSnapshotDigest || receipt.preparedDigest !== prepared.preparedDigest || receipt.assistantTurnId !== prepared.expectedAssistantTurnId || receipt.assistantBranchId !== prepared.assistantBranchId || receipt.assistantParentTurnId !== prepared.assistantParentTurnId) throw new ControlInputError("target_binding_mismatch", "Steer receipt is not bound to the prepared parent.");
  return deepFreeze(receipt as unknown as ControlSteerVerificationReceipt);
}

function validateSteerPreparedTarget(prepared: ControlSteerPrepared, state: OperationStateV1): void {
  const target = state.target;
  if (target === undefined) throw new ControlInputError("target_binding_mismatch", "Prepared steer has no durable target binding.");
  const available = (value: { status: string; value?: string }): string | undefined => value.status === "available" ? value.value : undefined;
  const baselineTarget = prepared.baseline.target;
  if (available(baselineTarget.provider) !== target.providerId
    || available(baselineTarget.browser) !== target.browserId
    || available(baselineTarget.tab) !== target.tabId
    || baselineTarget.coordinationScope !== target.coordinationScope) {
    throw new ControlInputError("target_binding_mismatch", "Prepared steer baseline target changed.");
  }
  if (target.conversationId !== undefined && available(baselineTarget.conversation) !== target.conversationId) {
    throw new ControlInputError("target_binding_mismatch", "Prepared steer conversation target changed.");
  }
}

async function reconcileExisting(normalized: Normalized, boundary: MutationBoundary): Promise<ControlResult> {
  const observation = await observePostconditionSafely(normalized);
  return await settleObservation(normalized, boundary, observation, "send_control_unavailable");
}

async function settleAfterIntent(
  normalized: Normalized,
  boundary: MutationBoundary,
  cancellation: "operation_cancelled" | "operation_timeout"
): Promise<ControlResult> {
  if (canAttemptObservation(normalized)) {
    const observation = await observePostconditionSafely(normalized);
    return await settleObservation(normalized, boundary, observation, cancellation);
  }
  return await persistOutcome(normalized, boundary, {
    outcome: "uncertain",
    blockerCode: cancellation
  });
}

async function reconcileAfterIntent(
  normalized: Normalized,
  boundary: MutationBoundary,
  execution: Extract<ControlExecutionResult, { status: "uncertain" }>
): Promise<ControlResult> {
  if (canAttemptObservation(normalized)) {
    const observation = await observePostconditionSafely(normalized);
    return await settleObservation(
      normalized,
      boundary,
      observation,
      cancellationCode(normalized) ?? execution.blockerCode ?? "send_control_unavailable"
    );
  }
  return await persistOutcome(normalized, boundary, {
    outcome: "uncertain",
    blockerCode: cancellationCode(normalized) ?? execution.blockerCode ?? "send_control_unavailable",
    ...(execution.evidenceDigest === undefined ? {} : { evidenceDigest: execution.evidenceDigest })
  });
}

async function settleObservation(
  normalized: Normalized,
  boundary: MutationBoundary,
  observation: ControlPostconditionObservation,
  fallback: OperationBlockerCode
): Promise<ControlResult> {
  try {
    validatePostconditionObservation(observation, normalized.base.expectedAssistantTurnId);
  } catch {
    return await persistOutcome(normalized, boundary, {
      outcome: "uncertain",
      blockerCode: cancellationCode(normalized) ?? "operation_state_corrupt"
    });
  }
  if (observation.status === "satisfied") {
    return await persistOutcome(normalized, boundary, {
      outcome: "satisfied",
      evidenceDigest: observation.evidenceDigest
    });
  }
  if (observation.status === "not_satisfied") {
    return await persistOutcome(normalized, boundary, {
      outcome: "not_satisfied",
      blockerCode: observation.blockerCode,
      ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest })
    });
  }
  return await persistOutcome(normalized, boundary, {
    outcome: "uncertain",
    blockerCode: observation.blockerCode ?? cancellationCode(normalized) ?? fallback,
    ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest })
  });
}

async function persistOutcome(
  normalized: Normalized,
  boundary: MutationBoundary,
  outcome: Readonly<{
    outcome: "satisfied" | "not_satisfied" | "uncertain";
    evidenceDigest?: string;
    blockerCode?: OperationBlockerCode;
    steerReceipt?: ControlSteerVerificationReceipt;
  }>
): Promise<ControlResult> {
  const receipt = makeReceipt(normalized, outcome);
  try {
    validateReceipt(receipt, normalized.base);
    await normalized.ports.persistReceipt({
      receipt,
      ...(outcome.steerReceipt === undefined ? {} : { steerReceipt: outcome.steerReceipt })
    });
  } catch {
    return {
      ...normalized.base,
      kind: "uncertain",
      blocker: blocker("backend_unavailable", true, "control_may_have_occurred", outcome.evidenceDigest),
      ...(outcome.steerReceipt === undefined ? {} : { steerReceipt: outcome.steerReceipt })
    };
  }
  // The intent has crossed the control fencing point before this helper is
  // reached. Report the stronger boundary even if the reloaded snapshot still
  // reflected the pre-intent Send boundary.
  return resultFromReceipt(normalized.base, receipt, "control_may_have_occurred", outcome.steerReceipt);
}

function makeReceipt(
  normalized: Normalized,
  outcome: Readonly<{
    outcome: "satisfied" | "not_satisfied" | "uncertain";
    evidenceDigest?: string;
    blockerCode?: OperationBlockerCode;
  }>
): OperationControlReceiptV1 {
  const receipt: OperationControlReceiptV1 = {
    schemaVersion: OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION,
    controlActionId: normalized.base.controlActionId,
    parentOperationId: normalized.base.parentOperationId,
    parentRequestDigest: normalized.base.parentRequestDigest,
    parentTargetBindingDigest: normalized.base.parentTargetBindingDigest,
    expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
    requestDigest: normalized.base.requestDigest,
    action: normalized.base.action,
    outcome: outcome.outcome,
    ...(outcome.evidenceDigest === undefined ? {} : { evidenceDigest: outcome.evidenceDigest }),
    ...(outcome.blockerCode === undefined ? {} : { blockerCode: outcome.blockerCode }),
    observedAt: new Date(normalized.now()).toISOString()
  };
  return receipt;
}

function resultFromReceipt(
  base: ControlResultBase,
  receipt: OperationControlReceiptV1,
  boundary: MutationBoundary = "control_may_have_occurred",
  steerReceipt?: ControlSteerVerificationReceipt
): ControlResult {
  if (receipt.outcome === "satisfied") {
    return { ...base, kind: "completed", receipt, ...(steerReceipt === undefined ? {} : { steerReceipt }) };
  }
  if (receipt.outcome === "not_satisfied") {
    return {
      ...base,
      kind: "blocked",
      blocker: blocker(receipt.blockerCode ?? "send_control_unavailable", false, boundary, receipt.evidenceDigest),
      receipt,
      ...(steerReceipt === undefined ? {} : { steerReceipt })
    };
  }
  return {
    ...base,
    kind: "uncertain",
    blocker: blocker(receipt.blockerCode ?? "send_control_unavailable", true, "control_may_have_occurred", receipt.evidenceDigest),
    receipt,
    ...(steerReceipt === undefined ? {} : { steerReceipt })
  };
}

async function observeTurnSafely(
  normalized: Normalized
): Promise<
  | { kind: "exact"; evidenceDigest: string }
  | { kind: "blocked"; code: OperationBlockerCode; observationRequired: boolean; evidenceDigest?: string }
> {
  if (isCancelled(normalized)) {
    return { kind: "blocked", code: cancellationCode(normalized)!, observationRequired: false };
  }
  try {
    const observation = await normalized.ports.observeTurn({
      operationId: normalized.base.parentOperationId,
      parentRequestDigest: normalized.base.parentRequestDigest,
      targetBindingDigest: normalized.base.parentTargetBindingDigest,
      expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
      signal: normalized.signal,
      deadlineAt: normalized.deadlineAt
    });
    validateTurnObservation(observation);
    if (observation.status === "generating" && observation.assistantTurnId === normalized.base.expectedAssistantTurnId) {
      return { kind: "exact", evidenceDigest: observation.evidenceDigest };
    }
    if (observation.status === "mismatch" || observation.assistantTurnId !== undefined && observation.assistantTurnId !== normalized.base.expectedAssistantTurnId) {
      return { kind: "blocked", code: "target_binding_mismatch", observationRequired: false, ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest }) };
    }
    if (observation.status === "terminal" || observation.status === "not_found") {
      return { kind: "blocked", code: "send_control_unavailable", observationRequired: false, ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest }) };
    }
    return { kind: "blocked", code: "turn_ownership_ambiguous", observationRequired: true, ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest }) };
  } catch {
    return {
      kind: "blocked",
      code: cancellationCode(normalized) ?? "operation_state_corrupt",
      observationRequired: true
    };
  }
}

async function observePostconditionSafely(normalized: Normalized): Promise<ControlPostconditionObservation> {
  try {
    const observation = await normalized.ports.observePostcondition({
      operationId: normalized.base.parentOperationId,
      parentRequestDigest: normalized.base.parentRequestDigest,
      targetBindingDigest: normalized.base.parentTargetBindingDigest,
      action: normalized.base.action,
      controlActionId: normalized.base.controlActionId,
      expectedAssistantTurnId: normalized.base.expectedAssistantTurnId,
      requestDigest: normalized.base.requestDigest,
      signal: normalized.signal,
      deadlineAt: normalized.deadlineAt
    });
    validatePostconditionObservation(observation, normalized.base.expectedAssistantTurnId);
    return observation;
  } catch (error) {
    return {
      status: "uncertain",
      blockerCode: cancellationCode(normalized)
        ?? (error instanceof ControlInputError ? error.code : "operation_state_corrupt")
    };
  }
}

function normalizeInput(
  request: OperationControlRequestV1,
  requestDigest: string,
  ports: ControlPorts,
  options: ControlOptions
): Normalized {
  validateRequest(request);
  assertDigest(requestDigest, "requestDigest");
  if (hasAccessorInPlainData(ports) || !isRecord(ports) || typeof ports.readParent !== "function" || typeof ports.persistReceipt !== "function") {
    throw new ControlInputError("operation_state_corrupt", "Control ports are incomplete.");
  }
  if (request.action === "stop" && (typeof ports.observeTurn !== "function" || typeof ports.persistActionIntent !== "function" || typeof ports.executeOnce !== "function" || typeof ports.observePostcondition !== "function")) {
    throw new ControlInputError("operation_state_corrupt", "Stop control ports are incomplete.");
  }
  if (request.action === "steer" && (typeof ports.prepareSteer !== "function" || typeof ports.persistSteerIntentAndBaseline !== "function" || typeof ports.executeSteerPrepared !== "function" || typeof ports.verifySteer !== "function" || typeof ports.recoverSteer !== "function")) {
    throw new ControlInputError("operation_state_corrupt", "Work-steer phase ports are incomplete.");
  }
  if (!isRecord(options)) throw new ControlInputError("operation_state_corrupt", "Control options are invalid.");
  assertExactRecord(options, ["signal", "deadlineAt", "now"], []);
  if (options.signal !== undefined && !isAbortSignalLike(options.signal)) {
    throw new ControlInputError("operation_state_corrupt", "Cancellation signal is invalid.");
  }
  if (options.deadlineAt !== undefined && (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0 || options.deadlineAt > MAX_DEADLINE_AT)) {
    throw new ControlInputError("operation_state_corrupt", "Absolute deadline is invalid.");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new ControlInputError("operation_state_corrupt", "Clock is invalid.");
  }
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? Date.now;
  const initialNow = checkedNow(now);
  const requestTimeout = request.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 0 || requestTimeout > MAX_TIMEOUT_MS) {
    throw new ControlInputError("operation_timeout", "Control timeout is invalid.");
  }
  const requestDeadline = initialNow + requestTimeout;
  const deadlineAt = options.deadlineAt === undefined ? requestDeadline : Math.min(options.deadlineAt, requestDeadline);
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || deadlineAt > MAX_DEADLINE_AT) {
    throw new ControlInputError("operation_timeout", "Control deadline is invalid.");
  }
  const base: ControlResultBase = {
    controlActionId: request.controlActionId,
    parentOperationId: request.parent.operationId,
    parentRequestDigest: request.parent.requestDigest,
    parentTargetBindingDigest: request.parent.targetBindingDigest!,
    requestDigest,
    action: request.action,
    expectedAssistantTurnId: request.expectedAssistantTurnId
  };
  let lastNow = initialNow;
  const monotonicNow = (): number => {
    const value = checkedNow(now);
    if (value < lastNow) throw new ControlInputError("operation_state_corrupt", "Clock moved backwards.");
    lastNow = value;
    return value;
  };
  return { request, requestDigest, signal, deadlineAt, now: monotonicNow, base, ports };
}

function validateRequest(request: OperationControlRequestV1): void {
  assertExactRecord(request, ["schemaVersion", "controlActionId", "parent", "action", "expectedAssistantTurnId", "steerPrompt", "timeoutMs"], ["schemaVersion", "controlActionId", "parent", "action", "expectedAssistantTurnId"]);
  if (request.schemaVersion !== OPERATION_CONTROL_REQUEST_SCHEMA_VERSION) throw new ControlInputError("operation_state_corrupt", "Unsupported control request schema.");
  assertUuid(request.controlActionId, "controlActionId");
  validateHandle(request.parent);
  if (request.parent.phase !== "generating" || request.parent.targetBindingDigest === undefined) throw new ControlInputError("target_binding_mismatch", "Control requires an exact generating parent target.");
  if (request.action !== "stop" && request.action !== "steer") throw new ControlInputError("operation_state_corrupt", "Control action is invalid.");
  if (request.action === "steer" && (typeof request.steerPrompt !== "string" || request.steerPrompt.length === 0)) throw new ControlInputError("operation_state_corrupt", "Steer requires an in-memory prompt.");
  if (request.action === "stop" && request.steerPrompt !== undefined) throw new ControlInputError("operation_state_corrupt", "Stop must not carry steer text.");
  if (request.steerPrompt !== undefined && Buffer.byteLength(request.steerPrompt, "utf8") > MAX_STEER_PROMPT_BYTES) throw new ControlInputError("operation_state_corrupt", "Steer prompt exceeds the bounded limit.");
  if (request.expectedAssistantTurnId.length > 512 || !ID_PATTERN.test(request.expectedAssistantTurnId)) throw new ControlInputError("target_binding_mismatch", "Assistant turn identity is invalid.");
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0 || request.timeoutMs > MAX_TIMEOUT_MS)) throw new ControlInputError("operation_timeout", "Control timeout is invalid.");
}

function validateParentSnapshot(request: OperationControlRequestV1, requestDigest: string, snapshot: ControlParentSnapshot): void {
  if (!isRecord(snapshot)) throw new ControlInputError("operation_state_corrupt", "Parent snapshot is not an object.");
  assertExactRecord(snapshot, ["state", "handle", "existingReceipt", "existingSteerIntent"], ["state", "handle"]);
  assertOperationStateShape(snapshot.state);
  validateHandle(snapshot.handle);
  const state = snapshot.state;
  const parent = request.parent;
  if (state.schemaVersion !== OPERATION_SCHEMA_VERSION || state.operationId !== parent.operationId || state.requestDigest !== parent.requestDigest || state.surface !== parent.surface) throw new ControlInputError("operation_request_mismatch", "Parent durable identity does not match the request.");
  if (snapshot.handle.operationId !== state.operationId || snapshot.handle.requestDigest !== state.requestDigest || snapshot.handle.surface !== state.surface || snapshot.handle.revision !== state.revision || snapshot.handle.phase !== state.phase || snapshot.handle.mutationBoundary !== state.mutationBoundary) throw new ControlInputError("operation_state_corrupt", "Parent handle is not derived from durable state.");
  if (state.revision < parent.revision) throw new ControlInputError("operation_state_corrupt", "Durable parent is older than the supplied handle.");
  if (snapshot.handle.targetBindingDigest !== parent.targetBindingDigest || snapshot.handle.targetBindingDigest === undefined) throw new ControlInputError("target_binding_mismatch", "Parent target binding changed.");
  const existingAction = state.actions[request.controlActionId];
  const isPersistedSteer = request.action === "steer" && existingAction?.kind === "work_steer";
  // A parent can legitimately become terminal after a steer. Only that exact
  // already-fenced steer action may use the terminal snapshot for recovery;
  // a fresh action still requires a generating parent.
  if (state.phase !== "generating" && !isPersistedSteer) throw new ControlInputError("send_control_unavailable", "Control requires a durably generating parent operation.");
  if (request.action === "steer" && state.surface !== "work") throw new ControlInputError("operation_request_mismatch", "Steer is available only on Work operations.");
  if (state.mutationBoundary !== "send_may_have_occurred" && state.mutationBoundary !== "control_may_have_occurred") throw new ControlInputError("operation_state_corrupt", "Control parent lacks a submitted mutation boundary.");
  const controls = Object.values(state.actions).filter(action => action.kind === "stop" || action.kind === "work_steer");
  const controlIds = new Set(controls.map(action => action.actionId));
  if (controlIds.size !== controls.length) throw new ControlInputError("operation_state_corrupt", "Parent contains duplicate control action identities.");
  if (state.mutationBoundary === "control_may_have_occurred" && controls.length === 0) throw new ControlInputError("operation_state_corrupt", "Control boundary has no causal action.");
  if (snapshot.existingReceipt !== undefined && hasAccessorInPlainData(snapshot.existingReceipt)) throw new ControlInputError("operation_state_corrupt", "Control receipt contains unsafe data.");
  if (snapshot.existingReceipt !== undefined) validateReceipt(snapshot.existingReceipt, {
    controlActionId: request.controlActionId,
    parentOperationId: request.parent.operationId,
    parentRequestDigest: request.parent.requestDigest,
    parentTargetBindingDigest: request.parent.targetBindingDigest!,
    requestDigest,
    action: request.action,
    expectedAssistantTurnId: request.expectedAssistantTurnId
  });
  if (snapshot.existingReceipt !== undefined && !controls.some(action => action.actionId === request.controlActionId)) throw new ControlInputError("operation_state_corrupt", "Control receipt has no matching durable intent.");
  if (snapshot.existingSteerIntent !== undefined) {
    if (request.action !== "steer" || existingAction?.kind !== "work_steer") throw new ControlInputError("operation_state_corrupt", "Steer baseline is attached to a non-steer action.");
    // The full identity/baseline is checked again before recover. This early
    // graph check prevents accessors/proxies from reaching an adapter port.
    if (hasAccessorInPlainData(snapshot.existingSteerIntent)) throw new ControlInputError("operation_state_corrupt", "Steer baseline contains unsafe data.");
  }
}

function validateHandle(handle: OperationHandleV1): void {
  assertExactRecord(handle, ["schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary", "targetBindingDigest"], ["schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary"]);
  if (handle.schemaVersion !== OPERATION_HANDLE_SCHEMA_VERSION) throw new ControlInputError("operation_state_corrupt", "Unsupported operation handle schema.");
  assertUuid(handle.operationId, "handle.operationId");
  assertDigest(handle.requestDigest, "handle.requestDigest");
  if (handle.surface !== "chat" && handle.surface !== "work") throw new ControlInputError("operation_state_corrupt", "Handle surface is invalid.");
  if (!Number.isSafeInteger(handle.revision) || handle.revision < 1) throw new ControlInputError("operation_state_corrupt", "Handle revision is invalid.");
  if (!(handle.phase in { prepared: 1, handoff_pending: 1, ready: 1, send_pending: 1, submitted: 1, generating: 1, capturing: 1, completed: 1, uncertain: 1 })) throw new ControlInputError("operation_state_corrupt", "Handle phase is invalid.");
  if (!(handle.mutationBoundary in BOUNDARY_RANK)) throw new ControlInputError("operation_state_corrupt", "Handle mutation boundary is invalid.");
  if (handle.targetBindingDigest !== undefined) assertDigest(handle.targetBindingDigest, "handle.targetBindingDigest");
}

function validateTurnObservation(value: ControlTurnObservation): void {
  if (!isRecord(value) || typeof value.status !== "string") throw new ControlInputError("operation_state_corrupt", "Turn observation is invalid.");
  if (value.status === "generating") {
    assertExactRecord(value, ["status", "assistantTurnId", "evidenceDigest"], ["status", "assistantTurnId", "evidenceDigest"]);
    assertIdentifier(value.assistantTurnId, "assistantTurnId");
    assertDigest(value.evidenceDigest, "turn.evidenceDigest");
    return;
  }
  if (value.status !== "terminal" && value.status !== "not_found" && value.status !== "mismatch" && value.status !== "uncertain") throw new ControlInputError("operation_state_corrupt", "Turn observation status is invalid.");
  assertExactRecord(value, ["status", "assistantTurnId", "evidenceDigest", "reason"], ["status"]);
  if (value.assistantTurnId !== undefined) assertIdentifier(value.assistantTurnId, "assistantTurnId");
  if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest, "turn.evidenceDigest");
  if (value.reason !== undefined && !["different_turn", "not_generating", "target_mismatch", "unavailable"].includes(value.reason)) throw new ControlInputError("operation_state_corrupt", "Turn observation reason is invalid.");
}

function validateExecutionResult(value: ControlExecutionResult, expectedAssistantTurnId: string): void {
  validatePostconditionObservation(value, expectedAssistantTurnId);
}

function validatePostconditionObservation(value: ControlPostconditionObservation, expectedAssistantTurnId: string): void {
  if (!isRecord(value) || typeof value.status !== "string") throw new ControlInputError("operation_state_corrupt", "Control observation is invalid.");
  if (value.status === "satisfied") {
    assertExactRecord(value, ["status", "assistantTurnId", "evidenceDigest"], ["status", "assistantTurnId", "evidenceDigest"]);
    assertIdentifier(value.assistantTurnId, "assistantTurnId");
    if (value.assistantTurnId !== expectedAssistantTurnId) throw new ControlInputError("target_binding_mismatch", "Control evidence belongs to another assistant turn.");
    assertDigest(value.evidenceDigest, "control.evidenceDigest");
    return;
  }
  if (value.status === "not_satisfied") {
    assertExactRecord(value, ["status", "assistantTurnId", "blockerCode", "evidenceDigest"], ["status", "blockerCode"]);
    assertBlockerCode(value.blockerCode);
    if (value.assistantTurnId !== undefined) {
      assertIdentifier(value.assistantTurnId, "assistantTurnId");
      if (value.assistantTurnId !== expectedAssistantTurnId) throw new ControlInputError("target_binding_mismatch", "Control blocker belongs to another assistant turn.");
    }
    if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest, "control.evidenceDigest");
    return;
  }
  if (value.status !== "uncertain") throw new ControlInputError("operation_state_corrupt", "Control result status is invalid.");
  assertExactRecord(value, ["status", "assistantTurnId", "blockerCode", "evidenceDigest"], ["status"]);
  if (value.assistantTurnId !== undefined) {
    assertIdentifier(value.assistantTurnId, "assistantTurnId");
    if (value.assistantTurnId !== expectedAssistantTurnId) throw new ControlInputError("target_binding_mismatch", "Control uncertainty belongs to another assistant turn.");
  }
  if (value.blockerCode !== undefined) assertBlockerCode(value.blockerCode);
  if (value.evidenceDigest !== undefined) assertDigest(value.evidenceDigest, "control.evidenceDigest");
}

function validateReceipt(receipt: OperationControlReceiptV1, base: ControlResultBase): void {
  assertExactRecord(receipt, ["schemaVersion", "controlActionId", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "expectedAssistantTurnId", "requestDigest", "action", "outcome", "evidenceDigest", "blockerCode", "observedAt"], ["schemaVersion", "controlActionId", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "expectedAssistantTurnId", "requestDigest", "action", "outcome", "observedAt"]);
  if (receipt.schemaVersion !== OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION || receipt.controlActionId !== base.controlActionId || receipt.parentOperationId !== base.parentOperationId || receipt.parentRequestDigest !== base.parentRequestDigest || receipt.parentTargetBindingDigest !== base.parentTargetBindingDigest || receipt.expectedAssistantTurnId !== base.expectedAssistantTurnId || receipt.requestDigest !== base.requestDigest || receipt.action !== base.action) throw new ControlInputError("operation_request_mismatch", "Control receipt identity does not match the request.");
  assertUuid(receipt.controlActionId, "receipt.controlActionId");
  assertUuid(receipt.parentOperationId, "receipt.parentOperationId");
  assertDigest(receipt.parentRequestDigest, "receipt.parentRequestDigest");
  assertDigest(receipt.parentTargetBindingDigest, "receipt.parentTargetBindingDigest");
  assertDigest(receipt.requestDigest, "receipt.requestDigest");
  assertIdentifier(receipt.expectedAssistantTurnId, "receipt.expectedAssistantTurnId");
  if (receipt.action !== "stop" && receipt.action !== "steer") throw new ControlInputError("operation_state_corrupt", "Receipt action is invalid.");
  if (receipt.outcome !== "satisfied" && receipt.outcome !== "not_satisfied" && receipt.outcome !== "uncertain") throw new ControlInputError("operation_state_corrupt", "Receipt outcome is invalid.");
  if (!INSTANT_PATTERN.test(receipt.observedAt) || new Date(receipt.observedAt).toISOString() !== receipt.observedAt) throw new ControlInputError("operation_state_corrupt", "Receipt timestamp is invalid.");
  if (receipt.evidenceDigest !== undefined) assertDigest(receipt.evidenceDigest, "receipt.evidenceDigest");
  if (receipt.blockerCode !== undefined) assertBlockerCode(receipt.blockerCode);
  if (receipt.outcome === "satisfied" && (receipt.evidenceDigest === undefined || receipt.blockerCode !== undefined)) throw new ControlInputError("operation_state_corrupt", "Satisfied receipt evidence branch is invalid.");
  if (receipt.outcome === "not_satisfied" && receipt.blockerCode === undefined) throw new ControlInputError("operation_state_corrupt", "Blocked receipt requires blockerCode.");
  if (receipt.outcome === "uncertain" && receipt.blockerCode === undefined) throw new ControlInputError("operation_state_corrupt", "Uncertain receipt requires blockerCode.");
}

function findExistingAction(state: OperationStateV1, actionId: string): OperationActionRecordV1 | "corrupt" | undefined {
  const actions = Object.values(state.actions).filter(action => action.kind === "stop" || action.kind === "work_steer");
  if (actions.some((left, index) => actions.some((right, rightIndex) => index !== rightIndex && left.actionId === right.actionId))) return "corrupt";
  const found = actions.find(action => action.actionId === actionId);
  return found;
}

function actionMatches(action: OperationActionRecordV1, request: OperationControlRequestV1, requestDigest: string): boolean {
  return action.actionId === request.controlActionId
    && action.kind === controlActionKind(request.action)
    && action.repeatPolicy === "observe_only_after_intent"
    && action.requestDigest === requestDigest
    && action.targetDigest === request.parent.targetBindingDigest;
}

function controlActionKind(action: "stop" | "steer"): "stop" | "work_steer" {
  return action === "steer" ? "work_steer" : "stop";
}

function parentErrorCode(error: unknown): OperationBlockerCode {
  if (error instanceof ControlInputError) return error.code;
  if (isRecord(error) && typeof error.code === "string" && isBlockerCode(error.code)) return error.code;
  return "operation_state_corrupt";
}

function cancellationCode(normalized: Normalized): "operation_cancelled" | "operation_timeout" | undefined {
  if (normalized.signal.aborted) return "operation_cancelled";
  try {
    if (normalized.now() >= normalized.deadlineAt) return "operation_timeout";
  } catch {
    return "operation_timeout";
  }
  return undefined;
}

function isCancelled(normalized: Normalized): boolean {
  return normalized.signal.aborted || cancellationCode(normalized) === "operation_timeout";
}

function canAttemptObservation(normalized: Normalized): boolean {
  // A read-only reconciliation may proceed after caller cancellation, but not
  // after a hard deadline: returning a durable uncertain receipt is bounded.
  try {
    return normalized.now() < normalized.deadlineAt;
  } catch {
    return false;
  }
}

function safeBase(request: unknown, requestDigest: unknown): ControlResultBase {
  const value = safeDataRecord(request);
  const parent = safeDataRecord(readOwnData(value, "parent"));
  const validDigest = isDigest(requestDigest) ? requestDigest : INVALID_DIGEST;
  const operationId = readOwnData(parent, "operationId");
  const parentRequestDigest = readOwnData(parent, "requestDigest");
  const parentTargetBindingDigest = readOwnData(parent, "targetBindingDigest");
  const controlActionId = readOwnData(value, "controlActionId");
  const action = readOwnData(value, "action");
  const expectedAssistantTurnId = readOwnData(value, "expectedAssistantTurnId");
  return {
    controlActionId: isUuid(controlActionId) ? controlActionId : INVALID_ACTION_ID,
    parentOperationId: isUuid(operationId) ? operationId : INVALID_OPERATION_ID,
    parentRequestDigest: isDigest(parentRequestDigest) ? parentRequestDigest : INVALID_DIGEST,
    parentTargetBindingDigest: isDigest(parentTargetBindingDigest) ? parentTargetBindingDigest : INVALID_DIGEST,
    requestDigest: validDigest,
    action: action === "steer" ? "steer" : "stop",
    expectedAssistantTurnId: isSafeIdentifier(expectedAssistantTurnId) ? expectedAssistantTurnId : INVALID_TURN_ID
  };
}

function blockedResult(base: ControlResultBase, code: OperationBlockerCode, observationRequired: boolean, boundary: MutationBoundary, evidenceDigest?: string): ControlResult {
  return {
    ...base,
    kind: "blocked",
    blocker: blocker(code, observationRequired, boundary, evidenceDigest)
  };
}

function blocker(code: OperationBlockerCode, observationRequired: boolean, mutationBoundary: MutationBoundary, evidenceDigest?: string): ControlBlocker {
  return {
    code,
    observationRequired,
    mutationBoundary,
    ...(evidenceDigest === undefined ? {} : { evidenceDigest })
  };
}

/**
 * Copy a bounded redacted result graph without invoking accessors or keeping
 * aliases into a caller-owned object. Boundary values are intentionally
 * restricted to JSON-like plain data; cycles, proxies with unstable traps,
 * functions, symbols, and non-enumerable fields fail closed.
 */
function clonePlainData(value: unknown, active = new Set<object>(), depth = 0, nodes = { count: 0 }): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || depth > 40 || nodes.count++ > 16_384) throw new ControlInputError("operation_state_corrupt", "Boundary data graph is invalid.");
  if (active.has(value)) throw new ControlInputError("operation_state_corrupt", "Boundary data graph is cyclic.");
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new ControlInputError("operation_state_corrupt", "Boundary data graph is inaccessible.");
  }
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new ControlInputError("operation_state_corrupt", "Boundary data graph is not plain.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 16_384) throw new ControlInputError("operation_state_corrupt", "Boundary array length is invalid.");
      const output: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new ControlInputError("operation_state_corrupt", "Boundary array contains an unsafe item.");
        output.push(clonePlainData(descriptor.value, active, depth + 1, nodes));
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= lengthDescriptor.value) {
          throw new ControlInputError("operation_state_corrupt", "Boundary array contains an unsupported field.");
        }
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new ControlInputError("operation_state_corrupt", "Boundary data contains a symbol key.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new ControlInputError("operation_state_corrupt", "Boundary data contains an unsafe property.");
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: clonePlainData(descriptor.value, active, depth + 1, nodes)
      });
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function assertExactRecord(value: unknown, allowed: readonly string[], required: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new ControlInputError("operation_state_corrupt", "Boundary value must be a plain object.");
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new ControlInputError("operation_state_corrupt", "Boundary value contains an unsupported field.");
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new ControlInputError("operation_state_corrupt", "Boundary value is missing a required field.");
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new ControlInputError("operation_state_corrupt", `${label} is not a canonical UUID.`);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new ControlInputError("operation_state_corrupt", `${label} is not a canonical digest.`);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && ID_PATTERN.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.trim().length > 0;
}

function readOwnData(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeDataRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
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

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || /[\u0000-\u001f\u007f]/u.test(value) || value.trim().length === 0) throw new ControlInputError("operation_state_corrupt", `${label} is not a bounded opaque identity.`);
}

function assertBlockerCode(value: unknown): asserts value is OperationBlockerCode {
  if (typeof value !== "string" || !CODE_PATTERN.test(value) || !isBlockerCode(value)) throw new ControlInputError("operation_state_corrupt", "Control blocker code is invalid.");
}

function isBlockerCode(value: string): value is OperationBlockerCode {
  return [
    "operation_not_found", "operation_request_mismatch", "operation_state_corrupt", "operation_receipt_expired", "operation_quota_exceeded", "operation_cancelled", "operation_timeout", "ambiguous_file_handoff", "ambiguous_submit", "attachment_manifest_mismatch", "input_file_changed", "target_binding_mismatch", "target_evidence_unavailable", "turn_ownership_ambiguous", "concurrent_user_turn", "configuration_drift", "tab_ownership_conflict", "provider_concurrency_unsupported", "runtime_incompatible", "backend_unavailable", "browser_bridge_unavailable", "login_required", "captcha", "rate_limited", "permission_required", "needs_confirmation", "selector_drift", "send_control_unavailable", "capture_ownership_lost", "artifact_unavailable", "artifact_transfer_partial", "output_collision", "output_commit_indeterminate", "clipboard_restore_failed"
  ].includes(value);
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0 || value > MAX_DEADLINE_AT) throw new ControlInputError("operation_state_corrupt", "Clock returned an invalid time.");
  return value;
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== "object") return false;
  try {
    if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) return true;
    if (Object.prototype.toString.call(value) !== "[object AbortSignal]") return false;
    let prototype: object | null = Object.getPrototypeOf(value);
    let abortedAccessor = false;
    let addMethod = false;
    let removeMethod = false;
    const seen = new Set<object>();
    while (prototype !== null && !seen.has(prototype)) {
      seen.add(prototype);
      const aborted = Object.getOwnPropertyDescriptor(prototype, "aborted");
      if (aborted !== undefined && "get" in aborted) abortedAccessor = true;
      const add = Object.getOwnPropertyDescriptor(prototype, "addEventListener");
      if (add !== undefined && "value" in add && typeof add.value === "function") addMethod = true;
      const remove = Object.getOwnPropertyDescriptor(prototype, "removeEventListener");
      if (remove !== undefined && "value" in remove && typeof remove.value === "function") removeMethod = true;
      prototype = Object.getPrototypeOf(prototype);
    }
    return abortedAccessor && addMethod && removeMethod;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
