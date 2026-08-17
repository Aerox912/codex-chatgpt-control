import { sendButton } from "../dom/selectors.js";
import type { LocatorLike, PageLike } from "../types.js";
import type { OperationSurface } from "./types.js";
import {
  type SubmissionExpectedEnvelope,
  type SubmissionFinalTransactionResult,
  validateSubmissionTargetEstablishment
} from "./submission.js";
import { TURN_OWNERSHIP_SCHEMA_VERSION, type OwnershipBaseline } from "./turn-ownership.js";

/**
 * The operation Send primitive deliberately knows nothing about RuntimeEnv.
 * A caller binds one immutable PageLike. The optional transaction wraps only
 * the short precondition/read + activation section; postcondition probes are
 * deliberately performed after it settles. Polling is bounded and every
 * delay is awaited outside the caller-owned tab actor.
 */

const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
const MAX_ATTACHMENTS = 256;
const MAX_CALLBACK_ARRAY_ITEMS = 256;
const MAX_CALLBACK_STRING = 1024;
const DEFAULT_POSTCONDITION_ATTEMPTS = 8;
const MAX_POSTCONDITION_ATTEMPTS = 32;
const DEFAULT_POSTCONDITION_INTERVAL_MS = 50;
const MAX_POSTCONDITION_INTERVAL_MS = 5_000;
const DEFAULT_POSTCONDITION_TIMEOUT_MS = 3_000;
const MAX_POSTCONDITION_TIMEOUT_MS = 30_000;

const SUBMISSION_BLOCKER_CODES = new Set<string>([
  "operation_cancelled",
  "operation_timeout",
  "stale_handle",
  "operation_state_corrupt",
  "target_binding_mismatch",
  "target_evidence_unavailable",
  "configuration_drift",
  "composer_drift",
  "attachment_manifest_mismatch",
  "ambiguous_file_handoff",
  "ambiguous_submit",
  "concurrent_user_turn",
  "send_control_unavailable",
  "journal_unavailable",
  "port_protocol_violation",
  "already_completed"
]);

const CONTROL_BLOCKER_CODES = new Set<SendOncePreconditionCode>([
  "target_binding_mismatch",
  "target_evidence_unavailable",
  "configuration_drift",
  "composer_drift",
  "attachment_manifest_mismatch",
  "concurrent_user_turn",
  "send_control_unavailable",
  "ambiguous_submit",
  "port_protocol_violation"
]);

type PlainRecord = Record<string, unknown>;

class PreconditionValidationError extends Error {
  constructor(readonly code: SendOncePreconditionCode) {
    super("invalid precondition observation");
    this.name = "PreconditionValidationError";
  }
}

export type SendOnceMode = "mutate_once" | "observe_only";

export type SendOnceTurnBaseline = Readonly<{
  /** Absent means the operation had no operation-owned rendered user turn yet. */
  userTurnId?: string;
  /** HMAC evidence for the complete pre-activation user-turn baseline. */
  userTurnEvidenceDigest: string;
  /** Complete normalized snapshot retained for durable restart recovery. */
  ownershipBaseline?: OwnershipBaseline;
}>;

export type SendOnceAttachmentObservation = Readonly<{
  count: number;
  orderPolicy: "exact";
  identityDigests: readonly string[];
}>;

export type SendOncePreconditionCode =
  | "target_binding_mismatch"
  | "target_evidence_unavailable"
  | "configuration_drift"
  | "composer_drift"
  | "attachment_manifest_mismatch"
  | "concurrent_user_turn"
  | "send_control_unavailable"
  | "ambiguous_submit"
  | "journal_unavailable"
  | "port_protocol_violation";

/**
 * A precondition observer returns only HMAC-backed identities and exact
 * multiplicity.  It must never return prompt text, DOM, paths, names, or
 * provider error strings.
 */
export type SendOncePreconditionObservation = Readonly<
  | {
      status: "exact";
      targetBindingDigest: string;
      configurationReceiptDigest: string;
      composerReceiptDigest: string;
      attachments: SendOnceAttachmentObservation;
      baseline: SendOnceTurnBaseline;
      evidenceDigest: string;
    }
  | {
      status: "mismatch" | "unavailable" | "not_ready";
      code: SendOncePreconditionCode;
      evidenceDigest?: string;
    }
>;

export type SendOnceActivationState = "not_attempted" | "activated" | "activation_threw";

export type SendOncePreconditionRequest = Readonly<{
  page: PageLike;
  expected: SubmissionExpectedEnvelope;
  mode: SendOnceMode;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

export type SendOncePostconditionRequest = Readonly<{
  page: PageLike;
  /** Durable Send action identity, needed for new-target establishment. */
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  mode: SendOnceMode;
  baseline: SendOnceTurnBaseline;
  activation: SendOnceActivationState;
  /** Probe ordinal, starting at one. It is diagnostic only and opaque to DOM code. */
  attempt: number;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

export type SendOncePostconditionProbe = Readonly<{
  result: SubmissionFinalTransactionResult;
  /** A transient read miss may be retried; mutation is never retried. */
  retryable: boolean;
}>;

export type SendOnceObservers = Readonly<{
  /** Exact target/configuration/composer/attachment and turn-baseline read. */
  observePrecondition: (request: SendOncePreconditionRequest) => Promise<SendOncePreconditionObservation>;
  /** One bounded exact user-turn ownership read; it must not poll or sleep. */
  observePostcondition: (request: SendOncePostconditionRequest) => Promise<SubmissionFinalTransactionResult | SendOncePostconditionProbe>;
  /** Optional external wait hook. It is invoked only after a read transaction settles. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Internal bounds for postcondition reconciliation. */
  maxPostconditionAttempts?: number;
  postconditionIntervalMs?: number;
  postconditionTimeoutMs?: number;
}>;

/**
 * Optional caller-owned actor wrapper for the short precondition/activation
 * section. In production this is normally a ProcessTabCoordinator tab
 * transaction. The wrapper must not invoke the callback more than once; this
 * module memoizes the callback result defensively, but postcondition probes
 * are always invoked after this promise settles.
 */
export type SendOnceTransaction = <T>(callback: () => Promise<T>) => Promise<T>;

/**
 * The first phase of an operation-aware Send.  This request is deliberately
 * read-only: it contains no persistence hook and cannot activate a provider
 * control.  A caller may wrap the bounded read in its own read transaction;
 * the returned prepared value never retains that actor, page, or observers.
 */
export type SendOncePrepareRequest = Readonly<{
  page: PageLike;
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  observers: SendOnceObservers;
  signal?: AbortSignal;
  deadlineAt?: number;
  transaction?: SendOnceTransaction;
}>;

/**
 * Immutable, path-free identity captured before the durable Send intent.  It
 * contains only HMAC-backed identities and exact multiplicity; no prompt,
 * response, local path, or DOM value crosses the phase boundary.
 */
export type SendOncePrepared = Readonly<{
  schemaVersion: "chatgpt.browser_control.send_once_prepared.v1";
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  observation: Extract<SendOncePreconditionObservation, { status: "exact" }>;
  baseline: SendOnceTurnBaseline;
}>;

export type SendOncePrepareResult = Readonly<
  | { status: "prepared"; prepared: SendOncePrepared }
  | { status: "blocked"; result: Extract<SubmissionFinalTransactionResult, { status: "blocked" }> }
>;

/**
 * Execute the sole provider activation using a previously prepared value.
 * There is intentionally no persistence callback here.  The caller must
 * persist its action intent and baseline before invoking this phase.
 */
export type SendOnceExecutePreparedRequest = Readonly<{
  page: PageLike;
  prepared: SendOncePrepared;
  observers: SendOnceObservers;
  signal?: AbortSignal;
  deadlineAt?: number;
  transaction?: SendOnceTransaction;
}>;

export type SendOnceExecutionResult = Readonly<
  | {
      status: "activated" | "activation_threw";
      prepared: SendOncePrepared;
      baseline: SendOnceTurnBaseline;
      activation: "activated" | "activation_threw";
      mutationMayHaveOccurred: true;
    }
  | {
      status: "blocked";
      result: Extract<SubmissionFinalTransactionResult, { status: "blocked" }>;
    }
  | {
      status: "uncertain";
      result: Extract<SubmissionFinalTransactionResult, { status: "uncertain" }>;
    }
>;

/** Read-only reconciliation after an executePrepared result. */
export type SendOnceVerifyRequest = Readonly<{
  page: PageLike;
  prepared: SendOncePrepared;
  observers: SendOnceObservers;
  activation: SendOnceActivationState;
  mutationMayHaveOccurred: boolean;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

/** Read-only restart reconciliation anchored to a durable baseline. */
export type SendOnceRecoverRequest = Readonly<{
  page: PageLike;
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  expected: SubmissionExpectedEnvelope;
  durableBaseline: OwnershipBaseline;
  observers: SendOnceObservers;
  signal?: AbortSignal;
  deadlineAt?: number;
}>;

export type SendOnceRequest = Readonly<{
  page: PageLike;
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  actionId: string;
  mode: SendOnceMode;
  expected: SubmissionExpectedEnvelope;
  observers: SendOnceObservers;
  /** Persist the complete pre-Send baseline before activation. */
  persistPreSendBaseline?: (baseline: OwnershipBaseline) => Promise<void>;
  /** Authenticated baseline projected by the service for observe-only recovery. */
  durableBaseline?: OwnershipBaseline;
  signal?: AbortSignal;
  /** An absolute epoch-millisecond deadline; no timer is created here. */
  deadlineAt?: number;
  transaction?: SendOnceTransaction;
}>;

type ControlResolution = Readonly<
  | { status: "ready"; locator: LocatorLike }
  | { status: "unavailable" }
  | { status: "ambiguous" }
  | { status: "not_ready" }
  | { status: "protocol_error" }
>;

type ValidPostcondition = Extract<SubmissionFinalTransactionResult, { status: "submitted" | "already_submitted" | "blocked" | "uncertain" }>;
type SendOnceShortResult =
  | Readonly<{ kind: "result"; result: SubmissionFinalTransactionResult }>
  | Readonly<{
      kind: "observe";
      baseline: SendOnceTurnBaseline;
      activation: SendOnceActivationState;
      mutationMayHaveOccurred: boolean;
    }>;

/**
 * Capture the complete pre-Send identity using reads only.  The returned
 * value is detached from provider objects and deeply frozen, so a caller can
 * safely persist its redacted baseline after this function has returned.
 */
export async function prepareSendOnce(request: SendOncePrepareRequest): Promise<SendOncePrepareResult> {
  let expected: SubmissionExpectedEnvelope;
  let base: SendOnceRequest;
  try {
    validatePrepareRequest(request);
    expected = cloneExpected(request.expected);
    base = toSendOnceRequest(request, expected, "mutate_once");
  } catch {
    return { status: "blocked", result: blocked("port_protocol_violation") };
  }
  const initialCancellation = cancellationCode(base);
  if (initialCancellation !== undefined) return { status: "blocked", result: blocked(initialCancellation) };

  let readPromise: Promise<SendOncePreconditionObservation> | undefined;
  const readOnce = (): Promise<SendOncePreconditionObservation> => {
    readPromise ??= observePrecondition(base, expected);
    return readPromise;
  };
  let first: SendOncePreconditionObservation;
  try {
    first = request.transaction === undefined ? await readOnce() : await request.transaction(readOnce);
  } catch {
    return { status: "blocked", result: blocked(cancellationCode(base) ?? "port_protocol_violation") };
  }
  if (first.status !== "exact") return { status: "blocked", result: blocked(first.code, first.evidenceDigest) };
  const afterReadCancellation = cancellationCode(base);
  if (afterReadCancellation !== undefined) return { status: "blocked", result: blocked(afterReadCancellation) };

  return {
    status: "prepared",
    prepared: freezePrepared({
      schemaVersion: "chatgpt.browser_control.send_once_prepared.v1",
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      surface: request.surface,
      actionId: request.actionId,
      expected,
      observation: cloneExactPrecondition(first),
      baseline: cloneBaseline(first.baseline)
    })
  };
}

/**
 * Execute a prepared Send.  This phase performs no journal/persistence work;
 * its caller is responsible for atomically persisting the intent and the
 * prepared ownership baseline before invoking it.  Only the final exact read
 * and one control activation occur while an optional tab actor is held.
 */
export async function executePreparedSendOnce(request: SendOnceExecutePreparedRequest): Promise<SendOnceExecutionResult> {
  let prepared: SendOncePrepared;
  let base: SendOnceRequest;
  try {
    validateExecutePreparedRequest(request);
    prepared = clonePrepared(request.prepared);
    base = toSendOnceRequest({
      page: request.page,
      operationId: prepared.operationId,
      requestDigest: prepared.requestDigest,
      surface: prepared.surface,
      actionId: prepared.actionId,
      expected: prepared.expected,
      observers: request.observers,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
    }, prepared.expected, "mutate_once");
  } catch {
    return { status: "blocked", result: blocked("port_protocol_violation") };
  }

  const initialCancellation = cancellationCode(base);
  if (initialCancellation !== undefined) return { status: "blocked", result: blocked(initialCancellation) };

  let executionSettled = false;
  let executionPromise: Promise<SendOnceExecutionResult> | undefined;
  const executeOnce = (): Promise<SendOnceExecutionResult> => {
    executionPromise ??= executePreparedShort(base, prepared).finally(() => {
      executionSettled = true;
    });
    return executionPromise;
  };

  if (request.transaction === undefined) return await executeOnce();

  let wrapperFailed = false;
  try {
    // The wrapper's return value is deliberately ignored. The only valid
    // result is the memoized callback promise owned by this module.
    await request.transaction(executeOnce);
  } catch {
    wrapperFailed = true;
  }
  if (executionPromise === undefined) {
    return { status: "blocked", result: blocked(cancellationCode(base) ?? "port_protocol_violation") };
  }
  const wrapperSettledEarly = !executionSettled;
  let settled: SendOnceExecutionResult;
  try {
    // A broken actor wrapper must never make us release effect authority while
    // its callback is still reading or clicking. Await the callback itself to
    // settlement even after the wrapper resolves or rejects early.
    settled = await executionPromise;
  } catch {
    return { status: "uncertain", result: uncertain(undefined, "provider") };
  }
  if (!wrapperFailed && !wrapperSettledEarly) return settled;
  if (settled.status === "blocked") return settled;
  return { status: "uncertain", result: uncertain(undefined, "provider") };
}

/** Read-only post-activation reconciliation. */
export async function verifyPreparedSendOnce(request: SendOnceVerifyRequest): Promise<SubmissionFinalTransactionResult> {
  let prepared: SendOncePrepared;
  let base: SendOnceRequest;
  try {
    validateVerifyRequest(request);
    prepared = clonePrepared(request.prepared);
    base = toSendOnceRequest({
      page: request.page,
      operationId: prepared.operationId,
      requestDigest: prepared.requestDigest,
      surface: prepared.surface,
      actionId: prepared.actionId,
      expected: prepared.expected,
      observers: request.observers,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
    }, prepared.expected, "mutate_once");
  } catch {
    return request.mutationMayHaveOccurred ? uncertain(undefined, "caller") : blocked("port_protocol_violation");
  }
  const cancellation = cancellationCode(base);
  // A post-activation cancellation/deadline cannot suppress the first
  // observation: that bounded read is the only chance to reconcile an
  // already-started mutation.  Pre-activation verification remains a plain
  // blocker.
  if (cancellation !== undefined && !request.mutationMayHaveOccurred) return blocked(cancellation);
  return await observeExistingTurn(
    base,
    prepared.expected,
    cloneBaseline(prepared.baseline),
    request.activation,
    request.mutationMayHaveOccurred
  );
}

/** Read-only recovery for a durable Send intent after a restart/quarantine. */
export async function recoverSendOnce(request: SendOnceRecoverRequest): Promise<SubmissionFinalTransactionResult> {
  let base: SendOnceRequest;
  let expected: SubmissionExpectedEnvelope;
  let durableBaseline: OwnershipBaseline;
  try {
    validateRecoverRequest(request);
    expected = cloneExpected(request.expected);
    durableBaseline = cloneOwnershipBaseline(request.durableBaseline);
    base = toSendOnceRequest(request, expected, "observe_only");
  } catch {
    return { status: "uncertain", quarantine: "caller" };
  }
  const baseline = turnBaselineFromOwnership(durableBaseline);
  const cancellation = cancellationCode(base);
  if (cancellation !== undefined) return uncertain(undefined, "caller");
  return await observeExistingTurn(base, expected, baseline, "not_attempted", true);
}

/**
 * Compatibility composition wrapper.  New orchestration should call the four
 * explicit phases above.  Crucially, the legacy persistence hook is invoked
 * after prepare has returned and before execute acquires its optional actor;
 * it is never called from inside a browser transaction.
 */
export async function runSendOnce(request: SendOnceRequest): Promise<SubmissionFinalTransactionResult> {
  let expected: SubmissionExpectedEnvelope;
  try {
    validateRequest(request);
    expected = cloneExpected(request.expected);
  } catch {
    return blocked("port_protocol_violation");
  }
  const initialCancellation = cancellationCode(request);
  if (initialCancellation !== undefined) return blocked(initialCancellation);

  if (request.mode === "observe_only" && request.durableBaseline !== undefined) {
    return await recoverSendOnce({
      page: request.page,
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      surface: request.surface,
      actionId: request.actionId,
      expected,
      durableBaseline: request.durableBaseline,
      observers: request.observers,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
    });
  }

  // Do not pass request.transaction to prepare here.  This compatibility
  // wrapper intentionally keeps the durable write boundary visible: prepare
  // returns before the caller's optional mutation actor is acquired.
  const preparedResult = await prepareSendOnce({
    page: request.page,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    surface: request.surface,
    actionId: request.actionId,
    expected,
    observers: request.observers,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
  });
  if (preparedResult.status === "blocked") return preparedResult.result;
  const prepared = preparedResult.prepared;

  if (request.mode === "observe_only") {
    return await verifyPreparedSendOnce({
      page: request.page,
      prepared,
      observers: request.observers,
      activation: "not_attempted",
      mutationMayHaveOccurred: false,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
    });
  }

  if (request.persistPreSendBaseline !== undefined) {
    const ownershipBaseline = prepared.baseline.ownershipBaseline;
    if (ownershipBaseline === undefined) return blocked("target_evidence_unavailable");
    try {
      await request.persistPreSendBaseline(cloneOwnershipBaseline(ownershipBaseline));
    } catch {
      return blocked("journal_unavailable");
    }
    const afterPersistenceCancellation = cancellationCode(request);
    if (afterPersistenceCancellation !== undefined) return uncertain(undefined, "caller");
  }

  const execution = await executePreparedSendOnce({
    page: request.page,
    prepared,
    observers: request.observers,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
    ...(request.transaction === undefined ? {} : { transaction: request.transaction })
  });
  if (execution.status === "blocked" || execution.status === "uncertain") return execution.result;
  return await verifyPreparedSendOnce({
    page: request.page,
    prepared: execution.prepared,
    observers: request.observers,
    activation: execution.activation,
    mutationMayHaveOccurred: execution.mutationMayHaveOccurred,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
  });
}

/** Alias kept explicit for callers that name the operation after its action. */
export const executeSendOnce = runSendOnce;

async function executePreparedShort(
  request: SendOnceRequest,
  prepared: SendOncePrepared
): Promise<SendOnceExecutionResult> {
  const initialCancellation = cancellationCode(request);
  if (initialCancellation !== undefined) return { status: "blocked", result: blocked(initialCancellation) };

  // This is the only final precondition read. It occurs after prepare has
  // returned and after any caller-owned persistence, while still inside the
  // short actor transaction supplied to executePreparedSendOnce.
  const finalPrecondition = await observePrecondition(request, prepared.expected);
  if (finalPrecondition.status !== "exact") {
    return { status: "blocked", result: blocked(finalPrecondition.code, finalPrecondition.evidenceDigest) };
  }
  if (!samePreparedObservation(prepared, finalPrecondition)) {
    return { status: "blocked", result: blocked("concurrent_user_turn") };
  }

  const control = await resolveSendControl(request.page);
  if (control.status === "ambiguous") return { status: "blocked", result: blocked("ambiguous_submit") };
  if (control.status === "unavailable" || control.status === "not_ready") return { status: "blocked", result: blocked("send_control_unavailable") };
  if (control.status === "protocol_error") return { status: "blocked", result: blocked("port_protocol_violation") };
  const beforeActivationCancellation = cancellationCode(request);
  if (beforeActivationCancellation !== undefined) return { status: "blocked", result: blocked(beforeActivationCancellation) };
  if (typeof control.locator.click !== "function") return { status: "blocked", result: blocked("port_protocol_violation") };

  // No timeout race and no cancellation race is permitted once this point is
  // reached. Await the provider activation's settlement, then reconcile in a
  // separate read-only phase. A bridge may have accepted the click even when
  // it rejects its promise, hence activation_threw is still mutation-possible.
  try {
    await control.locator.click();
    return {
      status: "activated",
      prepared,
      baseline: cloneBaseline(prepared.baseline),
      activation: "activated",
      mutationMayHaveOccurred: true
    };
  } catch {
    return {
      status: "activation_threw",
      prepared,
      baseline: cloneBaseline(prepared.baseline),
      activation: "activation_threw",
      mutationMayHaveOccurred: true
    };
  }
}

function toSendOnceRequest(
  request: Readonly<{
    page: PageLike;
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    observers: SendOnceObservers;
    mode?: SendOnceMode;
    signal?: AbortSignal;
    deadlineAt?: number;
  }>,
  expected: SubmissionExpectedEnvelope,
  mode: SendOnceMode
): SendOnceRequest {
  return {
    page: request.page,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    surface: request.surface,
    actionId: request.actionId,
    mode: request.mode ?? mode,
    expected,
    observers: request.observers,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
  };
}

function turnBaselineFromOwnership(value: OwnershipBaseline): SendOnceTurnBaseline {
  const lastUserTurn = value.userTurns.at(-1);
  return {
    ...(lastUserTurn?.stableId === undefined ? {} : { userTurnId: lastUserTurn.stableId }),
    userTurnEvidenceDigest: lastUserTurn?.evidenceDigest ?? value.snapshotDigest,
    ownershipBaseline: cloneOwnershipBaseline(value)
  };
}

function samePreparedObservation(
  prepared: SendOncePrepared,
  current: Extract<SendOncePreconditionObservation, { status: "exact" }>
): boolean {
  return current.targetBindingDigest === prepared.observation.targetBindingDigest
    && current.configurationReceiptDigest === prepared.observation.configurationReceiptDigest
    && current.composerReceiptDigest === prepared.observation.composerReceiptDigest
    && current.attachments.count === prepared.observation.attachments.count
    && current.attachments.orderPolicy === prepared.observation.attachments.orderPolicy
    && current.attachments.identityDigests.length === prepared.observation.attachments.identityDigests.length
    && current.attachments.identityDigests.every((digest, index) => digest === prepared.observation.attachments.identityDigests[index])
    && sameBaseline(prepared.baseline, current.baseline);
}

function cloneExactPrecondition(
  value: Extract<SendOncePreconditionObservation, { status: "exact" }>
): Extract<SendOncePreconditionObservation, { status: "exact" }> {
  return {
    status: "exact",
    targetBindingDigest: value.targetBindingDigest,
    configurationReceiptDigest: value.configurationReceiptDigest,
    composerReceiptDigest: value.composerReceiptDigest,
    attachments: {
      count: value.attachments.count,
      orderPolicy: "exact",
      identityDigests: [...value.attachments.identityDigests]
    },
    baseline: cloneBaseline(value.baseline),
    evidenceDigest: value.evidenceDigest
  };
}

function freezePrepared(value: SendOncePrepared): SendOncePrepared {
  return deepFreeze(value);
}

function clonePrepared(value: SendOncePrepared): SendOncePrepared {
  validatePrepared(value);
  return freezePrepared({
    schemaVersion: value.schemaVersion,
    operationId: value.operationId,
    requestDigest: value.requestDigest,
    surface: value.surface,
    actionId: value.actionId,
    expected: cloneExpected(value.expected),
    observation: cloneExactPrecondition(value.observation),
    baseline: cloneBaseline(value.baseline)
  });
}

async function observePrecondition(
  request: SendOnceRequest,
  expected: SubmissionExpectedEnvelope
): Promise<Extract<SendOncePreconditionObservation, { status: "exact" }> | Extract<SendOncePreconditionObservation, { status: "mismatch" | "unavailable" | "not_ready" }>> {
  try {
    const observation = await request.observers.observePrecondition({
      page: request.page,
      expected: cloneExpected(expected),
      mode: request.mode,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
    });
    validatePreconditionObservation(observation, expected);
    return observation;
  } catch (error) {
    if (error instanceof PreconditionValidationError) {
      return { status: "mismatch", code: error.code };
    }
    return { status: "unavailable", code: "port_protocol_violation" };
  }
}

async function observeExistingTurn(
  request: SendOnceRequest,
  expected: SubmissionExpectedEnvelope,
  baseline: SendOnceTurnBaseline,
  activation: SendOnceActivationState,
  mutationMayHaveOccurred = false
): Promise<SubmissionFinalTransactionResult> {
  const bounds = postconditionBounds(request.observers);
  const startedAt = Date.now();
  let lastResult: SubmissionFinalTransactionResult | undefined;

  for (let attempt = 1; attempt <= bounds.maxAttempts; attempt += 1) {
    // Once an activation has happened, cancellation never authorizes a retry.
    // A proof observed before cancellation remains a valid receipt, but a
    // cancelled read cannot be used to claim a negative result.
    if (attempt > 1 && cancellationCode(request) !== undefined) {
      return mutationMayHaveOccurred ? uncertain(evidenceOf(lastResult)) : blocked(cancellationCode(request)!);
    }
    if (Date.now() - startedAt >= bounds.timeoutMs) {
      return mutationMayHaveOccurred ? uncertain(evidenceOf(lastResult)) : blocked("operation_timeout");
    }

    let observed: SubmissionFinalTransactionResult | SendOncePostconditionProbe;
    try {
      observed = await request.observers.observePostcondition({
        page: request.page,
        actionId: request.actionId,
        expected: cloneExpected(expected),
        mode: request.mode,
        baseline: cloneBaseline(baseline),
        activation,
        attempt,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
      });
      const probe = normalizePostconditionProbe(observed);
      validatePostcondition(probe.result, expected, request.mode, baseline);
      lastResult = probe.result;

      if (probe.result.status === "submitted" || probe.result.status === "already_submitted") {
        return probe.result;
      }
      if (!probe.retryable || attempt === bounds.maxAttempts) {
        return mutationMayHaveOccurred
          ? uncertain(probe.result.evidenceDigest)
          : probe.result;
      }
    } catch {
      return mutationMayHaveOccurred ? uncertain(evidenceOf(lastResult)) : blocked("port_protocol_violation");
    }

    const remaining = bounds.timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      return mutationMayHaveOccurred ? uncertain(evidenceOf(lastResult)) : blocked("operation_timeout");
    }
    const delay = Math.min(bounds.intervalMs, remaining);
    try {
      await sleepOutsideActor(request.observers, delay, request.signal ?? new AbortController().signal);
    } catch {
      return mutationMayHaveOccurred ? uncertain(evidenceOf(lastResult)) : blocked("operation_cancelled");
    }
  }

  return mutationMayHaveOccurred ? uncertain(evidenceOf(lastResult)) : blocked("operation_timeout");
}

function normalizePostconditionProbe(
  value: SubmissionFinalTransactionResult | SendOncePostconditionProbe
): SendOncePostconditionProbe {
  if (isPlainRecord(value) && hasOwnDataProperty(value, "result") && hasOwnDataProperty(value, "retryable")) {
    const record = value as PlainRecord;
    assertExactKeys(record, ["result", "retryable"]);
    const result = record.result;
    const retryable = record.retryable;
    if (typeof retryable !== "boolean") throw new Error("invalid postcondition retry flag");
    if (!isPlainRecord(result)) throw new Error("invalid postcondition result");
    return { result: result as SubmissionFinalTransactionResult, retryable };
  }
  return { result: value as SubmissionFinalTransactionResult, retryable: false };
}

function postconditionBounds(observers: SendOnceObservers): Readonly<{
  maxAttempts: number;
  intervalMs: number;
  timeoutMs: number;
}> {
  const maxAttempts = observers.maxPostconditionAttempts ?? DEFAULT_POSTCONDITION_ATTEMPTS;
  const intervalMs = observers.postconditionIntervalMs ?? DEFAULT_POSTCONDITION_INTERVAL_MS;
  const timeoutMs = observers.postconditionTimeoutMs ?? DEFAULT_POSTCONDITION_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_POSTCONDITION_ATTEMPTS) throw new Error("invalid postcondition attempts");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > MAX_POSTCONDITION_INTERVAL_MS) throw new Error("invalid postcondition interval");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_POSTCONDITION_TIMEOUT_MS) throw new Error("invalid postcondition timeout");
  return { maxAttempts, intervalMs, timeoutMs };
}

async function sleepOutsideActor(observers: SendOnceObservers, milliseconds: number, signal: AbortSignal): Promise<void> {
  if (observers.sleep !== undefined) {
    await observers.sleep(milliseconds, signal);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("operation cancelled"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
  });
}

function evidenceOf(result: SubmissionFinalTransactionResult | undefined): string | undefined {
  return result === undefined ? undefined : result.evidenceDigest;
}

async function resolveSendControl(page: PageLike): Promise<ControlResolution> {
  // Operation mode requires the locale registry's semantic role lookup.  The
  // legacy CSS fallback is intentionally not accepted for an exact-once
  // mutation because its English substring selector is not identity-grade.
  if (typeof page.getByRole !== "function") return { status: "protocol_error" };
  let locator: LocatorLike;
  try {
    locator = sendButton(page);
  } catch {
    return { status: "protocol_error" };
  }
  if (typeof locator.count !== "function") return { status: "protocol_error" };
  let count: number;
  try {
    count = await locator.count();
  } catch {
    return { status: "unavailable" };
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CALLBACK_ARRAY_ITEMS) return { status: "protocol_error" };
  if (count === 0) return { status: "unavailable" };

  const visible: LocatorLike[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = count === 1 ? locator : locator.nth?.(index);
    if (candidate === undefined || typeof candidate.isVisible !== "function") return { status: "protocol_error" };
    let isVisible: boolean;
    try {
      isVisible = await candidate.isVisible();
    } catch {
      return { status: "unavailable" };
    }
    if (typeof isVisible !== "boolean") return { status: "protocol_error" };
    if (isVisible) visible.push(candidate);
  }
  if (visible.length > 1) return { status: "ambiguous" };
  if (visible.length === 0) return { status: "unavailable" };

  const candidate = visible[0];
  if (candidate === undefined || typeof candidate.evaluate !== "function") return { status: "protocol_error" };
  let enabled: boolean;
  try {
    enabled = await candidate.evaluate(element => {
      const node = element as Element & {
        disabled?: boolean;
      };
      const ariaDisabled = node.getAttribute("aria-disabled");
      const disabledAttribute = node.hasAttribute("disabled");
      const inert = node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true";
      return node.disabled !== true && !disabledAttribute && ariaDisabled !== "true" && !inert;
    });
  } catch {
    return { status: "not_ready" };
  }
  if (typeof enabled !== "boolean") return { status: "protocol_error" };
  return enabled ? { status: "ready", locator: candidate } : { status: "not_ready" };
}

function validateRequest(request: SendOnceRequest): void {
  if (!isPlainRecord(request)) throw new Error("invalid request");
  if (!isPageLike(request.page)) throw new Error("invalid page");
  if (!isSafeId(request.operationId) || !isDigest(request.requestDigest) || !isSafeId(request.actionId)) throw new Error("invalid identity");
  if (request.surface !== "chat" && request.surface !== "work") throw new Error("invalid surface");
  if (request.mode !== "mutate_once" && request.mode !== "observe_only") throw new Error("invalid mode");
  validateExpected(request.expected);
  if (request.expected.surface !== request.surface) throw new Error("surface mismatch");
  if (!isPlainRecord(request.observers) || typeof request.observers.observePrecondition !== "function" || typeof request.observers.observePostcondition !== "function") throw new Error("invalid observers");
  if (request.observers.sleep !== undefined && typeof request.observers.sleep !== "function") throw new Error("invalid observer sleep");
  if (request.observers.maxPostconditionAttempts !== undefined && (!Number.isSafeInteger(request.observers.maxPostconditionAttempts) || request.observers.maxPostconditionAttempts < 1 || request.observers.maxPostconditionAttempts > MAX_POSTCONDITION_ATTEMPTS)) throw new Error("invalid postcondition attempts");
  if (request.observers.postconditionIntervalMs !== undefined && (!Number.isSafeInteger(request.observers.postconditionIntervalMs) || request.observers.postconditionIntervalMs < 0 || request.observers.postconditionIntervalMs > MAX_POSTCONDITION_INTERVAL_MS)) throw new Error("invalid postcondition interval");
  if (request.observers.postconditionTimeoutMs !== undefined && (!Number.isSafeInteger(request.observers.postconditionTimeoutMs) || request.observers.postconditionTimeoutMs < 1 || request.observers.postconditionTimeoutMs > MAX_POSTCONDITION_TIMEOUT_MS)) throw new Error("invalid postcondition timeout");
  if (request.signal !== undefined && !isAbortSignalLike(request.signal)) throw new Error("invalid signal");
  if (request.deadlineAt !== undefined && (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt < 0)) throw new Error("invalid deadline");
  if (request.transaction !== undefined && typeof request.transaction !== "function") throw new Error("invalid transaction");
  if (request.persistPreSendBaseline !== undefined && typeof request.persistPreSendBaseline !== "function") throw new Error("invalid baseline persistence hook");
  if (request.durableBaseline !== undefined) {
    validateOwnershipBaseline(request.durableBaseline);
  }
}

function validatePrepareRequest(request: SendOncePrepareRequest): void {
  if (!isPlainRecord(request)) throw new Error("invalid prepare request");
  validateRequest({
    page: request.page,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    surface: request.surface,
    actionId: request.actionId,
    mode: "mutate_once",
    expected: request.expected,
    observers: request.observers,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
    ...(request.transaction === undefined ? {} : { transaction: request.transaction })
  });
}

function validateExecutePreparedRequest(request: SendOnceExecutePreparedRequest): void {
  if (!isPlainRecord(request) || !isPageLike(request.page)) throw new Error("invalid execute request");
  validatePrepared(request.prepared);
  if (!isPlainRecord(request.observers) || typeof request.observers.observePrecondition !== "function" || typeof request.observers.observePostcondition !== "function") throw new Error("invalid observers");
  if (request.signal !== undefined && !isAbortSignalLike(request.signal)) throw new Error("invalid signal");
  if (request.deadlineAt !== undefined && (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt < 0)) throw new Error("invalid deadline");
  if (request.transaction !== undefined && typeof request.transaction !== "function") throw new Error("invalid transaction");
}

function validateVerifyRequest(request: SendOnceVerifyRequest): void {
  if (!isPlainRecord(request) || !isPageLike(request.page)) throw new Error("invalid verify request");
  validatePrepared(request.prepared);
  if (!isPlainRecord(request.observers) || typeof request.observers.observePrecondition !== "function" || typeof request.observers.observePostcondition !== "function") throw new Error("invalid observers");
  if (request.activation !== "not_attempted" && request.activation !== "activated" && request.activation !== "activation_threw") throw new Error("invalid activation");
  if (typeof request.mutationMayHaveOccurred !== "boolean") throw new Error("invalid mutation boundary");
  if (!request.mutationMayHaveOccurred && request.activation !== "not_attempted") throw new Error("invalid non-mutating activation");
  if (request.signal !== undefined && !isAbortSignalLike(request.signal)) throw new Error("invalid signal");
  if (request.deadlineAt !== undefined && (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt < 0)) throw new Error("invalid deadline");
}

function validateRecoverRequest(request: SendOnceRecoverRequest): void {
  if (!isPlainRecord(request)) throw new Error("invalid recover request");
  validateRequest({
    page: request.page,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    surface: request.surface,
    actionId: request.actionId,
    mode: "observe_only",
    expected: request.expected,
    observers: request.observers,
    durableBaseline: request.durableBaseline,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
  });
}

function validatePrepared(value: SendOncePrepared): void {
  if (!isPlainRecord(value)) throw new Error("invalid prepared value");
  assertExactKeys(value, ["schemaVersion", "operationId", "requestDigest", "surface", "actionId", "expected", "observation", "baseline"]);
  if (value.schemaVersion !== "chatgpt.browser_control.send_once_prepared.v1") throw new Error("invalid prepared schema");
  if (!isSafeId(value.operationId) || !isDigest(value.requestDigest) || !isSafeId(value.actionId)) throw new Error("invalid prepared identity");
  if (value.surface !== "chat" && value.surface !== "work") throw new Error("invalid prepared surface");
  validateExpected(value.expected);
  if (value.expected.surface !== value.surface) throw new Error("prepared surface mismatch");
  validatePreconditionObservation(value.observation, value.expected);
  if (value.observation.status !== "exact") throw new Error("prepared observation is not exact");
  validateBaseline(value.baseline);
  if (!sameBaseline(value.baseline, value.observation.baseline)) throw new Error("prepared baseline mismatch");
}

function validateExpected(value: SubmissionExpectedEnvelope): void {
  if (!isPlainRecord(value)) throw new Error("invalid expected envelope");
  assertExactKeys(value, ["surface", "targetBindingDigest", "configurationReceiptDigest", "composerReceiptDigest", "attachmentManifest"]);
  if (value.surface !== "chat" && value.surface !== "work") throw new Error("invalid expected surface");
  for (const digest of [value.targetBindingDigest, value.configurationReceiptDigest, value.composerReceiptDigest]) {
    if (!isDigest(digest)) throw new Error("invalid expected digest");
  }
  if (!isPlainRecord(value.attachmentManifest)) throw new Error("invalid attachment manifest");
  assertExactKeys(value.attachmentManifest, ["count", "orderPolicy", "identities"]);
  const manifest = value.attachmentManifest;
  if (!Number.isSafeInteger(manifest.count) || manifest.count < 0 || manifest.count > MAX_ATTACHMENTS || manifest.orderPolicy !== "exact" || !Array.isArray(manifest.identities) || manifest.identities.length !== manifest.count) throw new Error("invalid attachment manifest");
  const seen = new Set<string>();
  manifest.identities.forEach((entry, index) => {
    if (!isPlainRecord(entry)) throw new Error("invalid attachment identity");
    assertExactKeys(entry, ["identityDigest", "ordinal"]);
    if (entry.ordinal !== index || !isDigest(entry.identityDigest) || seen.has(entry.identityDigest)) throw new Error("invalid attachment identity");
    seen.add(entry.identityDigest);
  });
}

function validatePreconditionObservation(value: SendOncePreconditionObservation, expected: SubmissionExpectedEnvelope): void {
  if (!isPlainRecord(value) || typeof value.status !== "string") throw new Error("invalid precondition");
  if (value.status === "exact") {
    assertExactKeys(value, ["status", "targetBindingDigest", "configurationReceiptDigest", "composerReceiptDigest", "attachments", "baseline", "evidenceDigest"]);
    if (value.targetBindingDigest !== expected.targetBindingDigest) throw new PreconditionValidationError("target_binding_mismatch");
    if (value.configurationReceiptDigest !== expected.configurationReceiptDigest) throw new PreconditionValidationError("configuration_drift");
    if (value.composerReceiptDigest !== expected.composerReceiptDigest) throw new PreconditionValidationError("composer_drift");
    if (!isDigest(value.targetBindingDigest) || !isDigest(value.configurationReceiptDigest) || !isDigest(value.composerReceiptDigest) || !isDigest(value.evidenceDigest)) throw new Error("invalid precondition digest");
    try {
      validateAttachmentObservation(value.attachments, expected);
    } catch {
      throw new PreconditionValidationError("attachment_manifest_mismatch");
    }
    validateBaseline(value.baseline);
    return;
  }
  if (value.status !== "mismatch" && value.status !== "unavailable" && value.status !== "not_ready") throw new Error("invalid precondition status");
  assertExactKeys(value, ["status", "code", "evidenceDigest"]);
  if (!CONTROL_BLOCKER_CODES.has(value.code)) throw new Error("invalid precondition code");
  if (value.evidenceDigest !== undefined && !isDigest(value.evidenceDigest)) throw new Error("invalid precondition evidence");
}

function validateAttachmentObservation(value: SendOnceAttachmentObservation, expected: SubmissionExpectedEnvelope): void {
  if (!isPlainRecord(value)) throw new Error("invalid attachment observation");
  assertExactKeys(value, ["count", "orderPolicy", "identityDigests"]);
  if (!Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_ATTACHMENTS || value.orderPolicy !== "exact" || !Array.isArray(value.identityDigests) || value.identityDigests.length !== value.count || value.count !== expected.attachmentManifest.count) throw new Error("attachment mismatch");
  value.identityDigests.forEach((digest, index) => {
    if (!isDigest(digest) || digest !== expected.attachmentManifest.identities[index]?.identityDigest) throw new Error("attachment mismatch");
  });
}

function validateBaseline(value: SendOnceTurnBaseline): void {
  if (!isPlainRecord(value)) throw new Error("invalid baseline");
  assertExactKeys(value, ["userTurnId", "userTurnEvidenceDigest", "ownershipBaseline"]);
  if (!isDigest(value.userTurnEvidenceDigest)) throw new Error("invalid baseline evidence");
  if (value.userTurnId !== undefined && !isSafeId(value.userTurnId)) throw new Error("invalid baseline id");
  if (value.ownershipBaseline !== undefined) validateOwnershipBaseline(value.ownershipBaseline);
}

function validatePostcondition(value: SubmissionFinalTransactionResult, expected: SubmissionExpectedEnvelope, mode: SendOnceMode, baseline: SendOnceTurnBaseline): asserts value is ValidPostcondition {
  if (!isPlainRecord(value) || typeof value.status !== "string") throw new Error("invalid postcondition");
  if (value.status === "submitted" || value.status === "already_submitted") {
    assertExactKeys(value, ["status", "targetBindingDigest", "evidenceDigest", "userTurnId", "userTurnEvidenceDigest", "postSendDeltaDigest", "assistantTurnId", "targetEstablishment"]);
    if (mode === "observe_only" && value.status === "submitted") throw new Error("observation claimed activation");
    if (value.targetBindingDigest !== expected.targetBindingDigest || !isDigest(value.targetBindingDigest) || !isDigest(value.evidenceDigest) || !isDigest(value.userTurnEvidenceDigest) || !isDigest(value.postSendDeltaDigest) || !isSafeId(value.userTurnId)) throw new Error("invalid postcondition evidence");
    if (baseline.userTurnId !== undefined && baseline.userTurnId === value.userTurnId) throw new Error("postcondition turn did not advance");
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
    return;
  }
  if (value.status === "blocked") {
    assertExactKeys(value, ["status", "blockerCode", "evidenceDigest"]);
    if (!isSubmissionBlockerCode(value.blockerCode)) throw new Error("invalid blocker");
    if (value.evidenceDigest !== undefined && !isDigest(value.evidenceDigest)) throw new Error("invalid blocker evidence");
    return;
  }
  if (value.status === "uncertain") {
    assertExactKeys(value, ["status", "evidenceDigest", "quarantine"]);
    if (value.evidenceDigest !== undefined && !isDigest(value.evidenceDigest)) throw new Error("invalid uncertain evidence");
    if (value.quarantine !== "provider" && value.quarantine !== "caller") throw new Error("invalid quarantine");
    return;
  }
  throw new Error("invalid postcondition status");
}

function blocked(code: SubmissionFinalTransactionResult extends infer _T ? SendOncePreconditionCode | "operation_cancelled" | "operation_timeout" : never, evidenceDigest?: string): Extract<SubmissionFinalTransactionResult, { status: "blocked" }> {
  return {
    status: "blocked",
    blockerCode: code,
    ...(evidenceDigest === undefined ? {} : { evidenceDigest })
  };
}

function uncertain(
  evidenceDigest?: string,
  quarantine: "provider" | "caller" = "caller"
): Extract<SubmissionFinalTransactionResult, { status: "uncertain" }> {
  return {
    status: "uncertain",
    quarantine,
    ...(evidenceDigest === undefined ? {} : { evidenceDigest })
  };
}

function cancellationCode(request: SendOnceRequest): "operation_cancelled" | "operation_timeout" | undefined {
  if (request.signal?.aborted) return "operation_cancelled";
  if (request.deadlineAt !== undefined && Date.now() >= request.deadlineAt) return "operation_timeout";
  return undefined;
}

function sameBaseline(a: SendOnceTurnBaseline, b: SendOnceTurnBaseline): boolean {
  return a.userTurnId === b.userTurnId
    && a.userTurnEvidenceDigest === b.userTurnEvidenceDigest
    && canonicalBaseline(a.ownershipBaseline) === canonicalBaseline(b.ownershipBaseline);
}

function canonicalBaseline(value: OwnershipBaseline | undefined): string {
  if (value === undefined) return "undefined";
  // Ownership baselines are validated, cloned, and limited to primitive
  // redacted identities before this comparison. JSON serialization therefore
  // gives a deterministic structural comparison without retaining provider
  // objects or accepting an attacker-controlled toJSON hook.
  return JSON.stringify(value);
}

function cloneBaseline(value: SendOnceTurnBaseline): SendOnceTurnBaseline {
  return {
    ...(value.userTurnId === undefined ? {} : { userTurnId: value.userTurnId }),
    userTurnEvidenceDigest: value.userTurnEvidenceDigest,
    ...(value.ownershipBaseline === undefined ? {} : { ownershipBaseline: cloneOwnershipBaseline(value.ownershipBaseline) })
  };
}

function cloneOwnershipBaseline(value: OwnershipBaseline): OwnershipBaseline {
  const cloneIdentity = (identity: OwnershipBaseline["target"][keyof OwnershipBaseline["target"]]): any => {
    if (typeof identity !== "object" || identity === null || !("status" in identity)) return identity;
    return identity.status === "available"
      ? { status: "available", value: identity.value }
      : { status: "unavailable", reason: identity.reason };
  };
  const cloneTurn = (turn: OwnershipBaseline["userTurns"][number]): OwnershipBaseline["userTurns"][number] => ({
    ...(turn.stableId === undefined ? {} : { stableId: turn.stableId }),
    evidenceDigest: turn.evidenceDigest,
    structureDigest: turn.structureDigest,
    ordinal: turn.ordinal,
    ...(turn.parentStableId === undefined ? {} : { parentStableId: turn.parentStableId }),
    ...(turn.branchStableId === undefined ? {} : { branchStableId: turn.branchStableId }),
    ...(turn.state === undefined ? {} : { state: turn.state }),
    ...(turn.artifactEvidenceDigests === undefined ? {} : { artifactEvidenceDigests: [...turn.artifactEvidenceDigests] })
  });
  return {
    schemaVersion: value.schemaVersion,
    snapshotDigest: value.snapshotDigest,
    target: {
      provider: cloneIdentity(value.target.provider),
      browser: cloneIdentity(value.target.browser),
      tab: cloneIdentity(value.target.tab),
      thread: cloneIdentity(value.target.thread),
      conversation: cloneIdentity(value.target.conversation),
      canonicalThreadUrl: cloneIdentity(value.target.canonicalThreadUrl),
      authoritativeTabClaim: cloneIdentity(value.target.authoritativeTabClaim),
      coordinationScope: value.target.coordinationScope
    },
    userTurns: value.userTurns.map(cloneTurn),
    assistantTurns: value.assistantTurns.map(cloneTurn),
    completeness: "complete"
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const seen = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) return;
    const object = current as object;
    if (seen.has(object)) return;
    seen.add(object);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
      if ("value" in descriptor) visit(descriptor.value);
    }
    Object.freeze(object);
  };
  visit(value);
  return value;
}

function validateOwnershipBaseline(value: OwnershipBaseline): void {
  if (!isPlainRecord(value) || value.schemaVersion !== TURN_OWNERSHIP_SCHEMA_VERSION || value.completeness !== "complete") {
    throw new Error("invalid ownership baseline");
  }
  assertExactKeys(value, ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness"]);
  if (!isDigest(value.snapshotDigest)) throw new Error("invalid ownership baseline digest");
  if (!isPlainRecord(value.target)) throw new Error("invalid ownership baseline target");
  assertExactKeys(value.target, ["provider", "browser", "tab", "thread", "conversation", "canonicalThreadUrl", "authoritativeTabClaim", "coordinationScope"]);
  if (value.target.coordinationScope !== "process" && value.target.coordinationScope !== "provider") throw new Error("invalid ownership baseline scope");
  for (const key of ["provider", "browser", "tab", "thread", "conversation", "canonicalThreadUrl", "authoritativeTabClaim"] as const) {
    const identity = value.target[key];
    if (!isPlainRecord(identity) || (identity.status !== "available" && identity.status !== "unavailable")) throw new Error("invalid ownership identity");
    if (identity.status === "available") {
      assertExactKeys(identity, ["status", "value"]);
      if (!isSafeId(identity.value) && key !== "canonicalThreadUrl") throw new Error("invalid ownership identity value");
      if (key === "canonicalThreadUrl" && (typeof identity.value !== "string" || identity.value.length > 4096)) throw new Error("invalid ownership URL");
    } else {
      assertExactKeys(identity, ["status", "reason"]);
      if (identity.reason !== "not_exposed" && identity.reason !== "not_observed" && identity.reason !== "redacted") throw new Error("invalid ownership identity reason");
    }
  }
  for (const [turns, kind] of [[value.userTurns, "user"], [value.assistantTurns, "assistant"]] as const) {
    if (!Array.isArray(turns) || turns.length > 256) throw new Error("invalid ownership turn bound");
    turns.forEach((turn, index) => {
      if (!isPlainRecord(turn)) throw new Error("invalid ownership turn");
      assertExactKeys(turn, ["stableId", "evidenceDigest", "structureDigest", "ordinal", "parentStableId", "branchStableId", "state", "artifactEvidenceDigests"]);
      if (turn.ordinal !== index || !isDigest(turn.evidenceDigest) || !isDigest(turn.structureDigest)) throw new Error("invalid ownership turn");
      if (turn.stableId !== undefined && !isSafeId(turn.stableId)) throw new Error("invalid ownership turn id");
      if (kind === "user" && (turn.state !== undefined || turn.parentStableId !== undefined || turn.branchStableId !== undefined)) throw new Error("invalid user baseline turn");
      if (kind === "assistant" && turn.state !== "generating" && turn.state !== "terminal") throw new Error("invalid assistant baseline turn");
      const artifactEvidence = turn.artifactEvidenceDigests ?? [];
      if (!Array.isArray(artifactEvidence) || artifactEvidence.length > 32 || !artifactEvidence.every(value => typeof value === "string" && isDigest(value))) throw new Error("invalid ownership artifact evidence");
    });
  }
}

function cloneExpected(value: SubmissionExpectedEnvelope): SubmissionExpectedEnvelope {
  return {
    surface: value.surface,
    targetBindingDigest: value.targetBindingDigest,
    configurationReceiptDigest: value.configurationReceiptDigest,
    composerReceiptDigest: value.composerReceiptDigest,
    attachmentManifest: {
      count: value.attachmentManifest.count,
      orderPolicy: "exact",
      identities: value.attachmentManifest.identities.map(identity => ({
        identityDigest: identity.identityDigest,
        ordinal: identity.ordinal
      }))
    }
  };
}

function isPageLike(value: unknown): value is PageLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { aborted?: unknown }).aborted === "boolean"
    && typeof (value as { addEventListener?: unknown }).addEventListener === "function"
    && typeof (value as { removeEventListener?: unknown }).removeEventListener === "function";
}

function isPlainRecord(value: unknown): value is PlainRecord {
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

function hasOwnDataProperty(value: PlainRecord, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor;
}

function assertExactKeys(value: PlainRecord, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error("unsupported field");
  }
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_CALLBACK_STRING && SAFE_ID_PATTERN.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isSubmissionBlockerCode(value: unknown): value is SendOncePreconditionCode | "operation_cancelled" | "operation_timeout" {
  return typeof value === "string" && SUBMISSION_BLOCKER_CODES.has(value);
}
