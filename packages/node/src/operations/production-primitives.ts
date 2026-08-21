import type { LocatorLike, PageLike } from "../types.js";
import { composerTextbox, stopGenerationButton } from "../dom/selectors.js";
import {
  observeBrowserPage,
  type BrowserObservationDigest,
  type BrowserObservationResult
} from "./browser-observation.js";
import type {
  OperationBrowserCollectorPrimitive,
  OperationBrowserControlPrimitive,
  OperationBrowserStagingPrimitive,
  OperationBrowserSubmissionPrimitive
} from "./browser-adapter.js";
import type { OperationRuntimeBrowserPrimitives } from "./runtime-adapter.js";
import type {
  ControlExecutionRequest,
  ControlPostconditionObservation,
  ControlPostconditionRequest,
  ControlTurnObservation,
  ControlTurnObservationRequest
} from "./control.js";
import type {
  OperationCollectorContext,
  OperationCollectorContextRequest
} from "./service.js";
import {
  COLLECTOR_SCHEMA_VERSION,
  type CollectorObservation,
  type CollectorObservationRequest
} from "./collector.js";
import {
  classifyTurnOwnership,
  TURN_OWNERSHIP_SCHEMA_VERSION,
  type OwnershipBaseline,
  type OwnershipBinding,
  type OwnershipIdentityEvidence,
  type OwnershipSnapshot,
  type OwnershipTargetEvidence,
} from "./turn-ownership.js";
import type { OperationTargetBindingV1 } from "./types.js";
import type {
  OperationStagingCallbackRequest,
  OperationStagingMutationResult,
  OperationStagingObservation
} from "./staging.js";
import type {
  SubmissionAttachmentObservation,
  SubmissionAttachmentRequest,
  SubmissionExpectedEnvelope,
  SubmissionFinalTransactionResult,
  SubmissionHandoffResult,
  SubmissionStageObservation,
  SubmissionStageRequest
} from "./submission.js";
import type {
  SendOnceAttachmentObservation,
  SendOnceObservers,
  SendOncePostconditionRequest,
  SendOncePreconditionObservation,
  SendOncePreconditionRequest
} from "./send-once.js";

/**
 * A small, provider-facing primitive layer for the transactional adapter.
 *
 * This module intentionally does not call a legacy command.  Each callback
 * performs a bounded locator/evaluation operation, or one browser activation,
 * and returns only keyed evidence.  Attachment handoff, configuration,
 * The base factory deliberately leaves configuration, attachments, and Work
 * steer to their dedicated provider modules. `chatgpt-runtime.ts` composes
 * those modules into the default ChatGPT operation runtime; the inventory
 * below describes this base factory, not the completed composite runtime.
 */

const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
const OPAQUE_THREAD_URL_PATTERN = /^https:\/\/opaque\.invalid\/thread\/[0-9a-f]{64}$/u;
const MAX_LOCATOR_CANDIDATES = 128;
const MAX_COMPOSER_CHARS = 8 * 1024 * 1024;

export type ProductionPrimitiveAttachmentObserver = (
  request: SubmissionAttachmentRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1
) => Promise<SubmissionAttachmentObservation>;

export type ProductionOperationPrimitiveOptions = Readonly<{
  /** Journal-keyed HMAC evidence. Bare hashes are not accepted. */
  evidenceDigest: BrowserObservationDigest;
  /** Request identity is required for the Send evidence domain. */
  operationId?: string;
  requestDigest?: string;
  /** Raw composer text is retained only in this request-scoped closure. */
  desiredComposerText?: string;
  /** Alias for callers that name the same private value `composerText`. */
  composerText?: string;
  /** Provider claim token, retained in the closure and never returned. */
  authoritativeTabClaim?: string;
  /** Optional target captured by a provider integration before Send. */
  target?: OperationTargetBindingV1;
  /** Optional provider-owned attachment identity observer. */
  observeAttachments?: ProductionPrimitiveAttachmentObserver;
}>;

export type ProductionPrimitiveCapability =
  | "composer_set"
  | "empty_attachment_observation"
  | "send_activation"
  | "collector_snapshot"
  | "durable_baseline_projection"
  | "submission_witness_recovery"
  | "stop_control";

export type ProductionPrimitiveUnwiredCapability =
  | "configuration_set"
  | "tool_selection"
  | "power_select"
  | "file_chooser_handoff"
  | "attachment_identity_for_nonempty_manifest"
  | "work_steer_activation";

export const PRODUCTION_PRIMITIVE_CAPABILITIES: readonly ProductionPrimitiveCapability[] = Object.freeze([
  "composer_set",
  "empty_attachment_observation",
  "send_activation",
  "collector_snapshot",
  "durable_baseline_projection",
  "submission_witness_recovery",
  "stop_control"
]);

/**
 * These are not soft feature flags.  They are an inventory of deliberately
 * missing proof, so a caller cannot mistake an unavailable primitive for a
 * best-effort browser fallback.
 */
export const UNWIRED_PRODUCTION_PRIMITIVES: readonly ProductionPrimitiveUnwiredCapability[] = Object.freeze([
  "configuration_set",
  "tool_selection",
  "power_select",
  "file_chooser_handoff",
  "attachment_identity_for_nonempty_manifest",
  "work_steer_activation"
]);

export const PRODUCTION_OPERATION_PRIMITIVE_INVENTORY = Object.freeze({
  scope: "base_primitive_factory" as const,
  wired: PRODUCTION_PRIMITIVE_CAPABILITIES,
  unwired: UNWIRED_PRODUCTION_PRIMITIVES
});

export class ProductionPrimitiveError extends Error {
  constructor(public readonly code: string) {
    super("The provider-specific operation primitive could not prove the requested action safely.");
    this.name = "ProductionPrimitiveError";
  }
}

type PrimitiveState = {
  operationId?: string;
  requestDigest?: string;
  desiredComposerText?: string;
  authoritativeTabClaim?: string;
  target?: OperationTargetBindingV1;
};

/**
 * Create one request-scoped set of production operation primitives.
 *
 * `operationId`, `requestDigest`, and the composer value should normally be
 * supplied by the lazy runtime capture after the journal has created the
 * operation.  If either identity is absent, Send fails closed rather than
 * fabricating an evidence domain.
 */
export function createProductionOperationPrimitives(
  options: ProductionOperationPrimitiveOptions
): OperationRuntimeBrowserPrimitives {
  validateOptions(options);
  const state: PrimitiveState = {
    ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    ...(options.requestDigest === undefined ? {} : { requestDigest: options.requestDigest }),
    ...(options.desiredComposerText !== undefined
      ? { desiredComposerText: options.desiredComposerText }
      : options.composerText === undefined ? {} : { desiredComposerText: options.composerText }),
    ...(options.authoritativeTabClaim === undefined ? {} : { authoritativeTabClaim: options.authoritativeTabClaim }),
    ...(options.target === undefined ? {} : { target: options.target })
  };
  const staging: OperationBrowserStagingPrimitive = Object.freeze({
    readCurrent: request => readStaging(request, options.evidenceDigest, state),
    mutateOnce: request => mutateStagingOnce(request, options.evidenceDigest, state),
    observe: request => readStaging(request, options.evidenceDigest, state)
  });

  const sendObservers: SendOnceObservers = Object.freeze({
    observePrecondition: request => observeSendPrecondition(request, options.evidenceDigest, state, options.observeAttachments),
    observePostcondition: async request => {
      const result = await observeSendPostcondition(request, options.evidenceDigest, state);
      return result.status === "blocked"
        && (result.blockerCode === "ambiguous_submit" || result.blockerCode === "target_evidence_unavailable")
        ? { result, retryable: true }
        : result;
    },
    // Every retry is an observation-only transaction. The delay remains
    // outside the tab actor and can never repeat the Send activation.
    sleep: sleepOutsideBrowser,
    // ChatGPT can establish the canonical conversation URL before it exposes
    // stable user/assistant DOM identities. Keep that provider settling window
    // bounded without collapsing a successful one-shot Send into uncertainty.
    maxPostconditionAttempts: 32,
    postconditionIntervalMs: 250,
    postconditionTimeoutMs: 15_000
  });

  const submission: OperationBrowserSubmissionPrimitive = Object.freeze({
    observeStaging: (request, page, target) => observeSubmissionStaging(request, page, target, options.evidenceDigest, state),
    // The file identity layer revalidates paths outside the actor.  There is
    // still no identity-grade provider chooser primitive here, so never begin
    // a chooser mutation under an invented selector or wait loop.
    handoffFiles: async () => ({
      status: "not_satisfied",
      blockerCode: "attachment_manifest_mismatch"
    } satisfies SubmissionHandoffResult),
    observeAttachments: (request, page, target) => observeSubmissionAttachments(request, page, target, options.evidenceDigest, state, options.observeAttachments),
    sendObservers
  });

  const collector: OperationBrowserCollectorPrimitive = Object.freeze({
    readContext: (request, page, target) => readCollectorContext(request, page, target, options.evidenceDigest, state),
    observe: (request, page, target, context) => observeCollector(request, page, target, context, options.evidenceDigest, state),
    // This timer is intentionally outside any tab transaction.  The browser
    // adapter invokes it after its short observation transaction has settled.
    sleep: sleepOutsideBrowser
  });

  const control: OperationBrowserControlPrimitive = Object.freeze({
    observeTurn: (request, page, target) => observeControlTurn(request, page, target, options.evidenceDigest, state),
    executeOnce: (request, page, target) => executeControlOnce(request, page, target, options.evidenceDigest, state),
    observePostcondition: (request, page, target) => observeControlPostcondition(request, page, target, options.evidenceDigest, state)
  });

  return Object.freeze({
    staging,
    submission,
    collector,
    control
  });
}

/** Descriptive aliases for integrations that name the layer after the adapter. */
export const createOperationProductionPrimitives = createProductionOperationPrimitives;
export const createProductionPrimitives = createProductionOperationPrimitives;

async function readStaging(
  request: OperationStagingCallbackRequest & { page: Readonly<PageLike>; target: OperationTargetBindingV1 },
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<OperationStagingObservation> {
  if (request.kind !== "composer_set") {
    return unavailableStaging(request, stagingUnwiredCode(request.kind));
  }
  if (state.desiredComposerText === undefined) {
    return unavailableStaging(request, "composer_primitive_unwired");
  }
  if (!matchesExpectedStagingDigest(request, evidenceDigest)) {
    return unavailableStaging(request, "composer_request_mismatch");
  }

  const current = await readComposerState(request.page, request.target, request.operationId, evidenceDigest);
  if (current === undefined) return unavailableStaging(request, "composer_control_unavailable");
  const satisfied = current.text === state.desiredComposerText;
  const evidence = digest(evidenceDigest, "composer-observation", {
    operationId: request.operationId,
    targetBindingDigest: request.targetBindingDigest,
    currentStateDigest: current.currentStateDigest,
    status: satisfied ? "satisfied" : "not_satisfied"
  });
  if (evidence === undefined) return unavailableStaging(request, "evidence_digest_failed");
  return {
    status: satisfied ? "satisfied" : "not_satisfied",
    desiredStateDigest: request.desiredStateDigest,
    currentStateDigest: current.currentStateDigest,
    evidenceDigest: evidence
  };
}

async function mutateStagingOnce(
  request: OperationStagingCallbackRequest & { page: Readonly<PageLike>; target: OperationTargetBindingV1 },
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<OperationStagingMutationResult> {
  if (request.kind !== "composer_set" || state.desiredComposerText === undefined) {
    throw new ProductionPrimitiveError(request.kind === "composer_set" ? "composer_primitive_unwired" : stagingUnwiredCode(request.kind));
  }
  if (!isDigest(request.desiredStateDigest) || !isDigest(request.requestDigest)) {
    throw new ProductionPrimitiveError("composer_request_mismatch");
  }
  const expected = safeDigestWith(evidenceDigest, "staging-desired", { requestDigest: request.requestDigest, kind: request.kind });
  if (expected === undefined || expected !== request.desiredStateDigest) {
    throw new ProductionPrimitiveError("composer_request_mismatch");
  }
  const locator = await uniqueVisibleLocator(request.page, composerTextbox);
  if (locator === undefined || typeof locator.fill !== "function") {
    throw new ProductionPrimitiveError("composer_control_unavailable");
  }
  // The sole reversible composer mutation.  There is no readiness wait and no
  // fallback press/click path if this call rejects.
  await locator.fill(state.desiredComposerText);
  return { status: "started" };
}

function stagingUnwiredCode(kind: OperationStagingCallbackRequest["kind"]): string {
  switch (kind) {
    case "configuration_set": return "configuration_primitive_unwired";
    case "tool_set": return "tool_primitive_unwired";
    case "power_select": return "power_primitive_unwired";
    case "composer_set": return "composer_primitive_unwired";
  }
}

function unavailableStaging(
  request: Pick<OperationStagingCallbackRequest, "desiredStateDigest">,
  blockerCode: string
): OperationStagingObservation {
  return {
    status: "unavailable",
    desiredStateDigest: request.desiredStateDigest,
    blockerCode
  };
}

function matchesExpectedStagingDigest(
  request: Pick<OperationStagingCallbackRequest, "desiredStateDigest" | "requestDigest" | "kind">,
  evidenceDigest: BrowserObservationDigest
): boolean {
  return safeDigestWith(evidenceDigest, "staging-desired", {
    requestDigest: request.requestDigest,
    kind: request.kind
  }) === request.desiredStateDigest;
}

async function observeSubmissionStaging(
  request: SubmissionStageRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<SubmissionStageObservation> {
  state.target = target;
  if (!isDigest(request.configurationReceiptDigest) || !isDigest(request.composerReceiptDigest)) {
    return { status: "unavailable", reason: "unknown" };
  }
  const expectedConfiguration = state.requestDigest === undefined
    ? undefined
    : safeDigestWith(evidenceDigest, "configuration-request", state.requestDigest);
  const expectedComposer = state.requestDigest === undefined
    ? undefined
    : safeDigestWith(evidenceDigest, "composer-request", state.requestDigest);
  if (expectedConfiguration === undefined || expectedComposer === undefined) {
    return { status: "unavailable", reason: "target" };
  }
  if (request.configurationReceiptDigest !== expectedConfiguration) {
    const evidence = safeDigestWith(evidenceDigest, "submission-stage", { operationId: request.operationId, reason: "configuration" });
    return evidence === undefined
      ? { status: "mismatch", reason: "configuration" }
      : { status: "mismatch", reason: "configuration", evidenceDigest: evidence };
  }
  if (request.composerReceiptDigest !== expectedComposer || state.desiredComposerText === undefined) {
    return { status: "unavailable", reason: "composer" };
  }
  const current = await readComposerState(page, target, request.operationId, evidenceDigest);
  if (current === undefined) return { status: "unavailable", reason: "composer" };
  if (current.text !== state.desiredComposerText) {
    return { status: "mismatch", reason: "composer", evidenceDigest: current.evidenceDigest };
  }
  return {
    status: "exact",
    evidenceDigest: current.evidenceDigest
  };
}

async function observeSendPrecondition(
  request: SendOncePreconditionRequest,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState,
  attachmentObserver: ProductionPrimitiveAttachmentObserver | undefined
): Promise<SendOncePreconditionObservation> {
  const identity = sendIdentity(state, request.expected);
  if (identity === undefined) return { status: "unavailable", code: "target_evidence_unavailable" };
  const target = targetForObservation(request.expected, state);
  if (target === undefined) return { status: "unavailable", code: "target_evidence_unavailable" };
  // Recovery after a durable Send intent is observation-only. A pending new
  // target necessarily no longer renders the blank surface, so re-running the
  // normal precondition would reject the very post-Send state we must inspect.
  // The durable blank-task snapshot is the bounded baseline authority here;
  // the subsequent postcondition still has to prove exactly one new user turn
  // and complete provider conversation identity before establishment.
  if (request.mode === "observe_only" && state.target?.targetLifecycle === "new_pending") {
    const recoveryBaseline = recoverPendingBlankBaseline(state);
    if (recoveryBaseline === undefined) return { status: "unavailable", code: "target_evidence_unavailable" };
    return {
      status: "exact",
      targetBindingDigest: request.expected.targetBindingDigest,
      configurationReceiptDigest: request.expected.configurationReceiptDigest,
      composerReceiptDigest: request.expected.composerReceiptDigest,
      attachments: {
        count: request.expected.attachmentManifest.count,
        orderPolicy: "exact",
        identityDigests: request.expected.attachmentManifest.identities.map(entry => entry.identityDigest)
      },
      baseline: {
        ownershipBaseline: recoveryBaseline,
        userTurnEvidenceDigest: safeDigestWith(evidenceDigest, "send-baseline", {
          snapshotDigest: recoveryBaseline.snapshotDigest,
          userTurns: []
        }) ?? recoveryBaseline.snapshotDigest
      },
      evidenceDigest: recoveryBaseline.snapshotDigest
    };
  }
  if (state.desiredComposerText === undefined) return { status: "unavailable", code: "composer_drift" };
  const expectedComposer = safeDigestWith(evidenceDigest, "composer-request", state.requestDigest);
  const expectedConfiguration = safeDigestWith(evidenceDigest, "configuration-request", state.requestDigest);
  if (expectedComposer === undefined || expectedConfiguration === undefined) {
    return { status: "unavailable", code: "target_evidence_unavailable" };
  }
  if (request.expected.composerReceiptDigest !== expectedComposer) {
    return { status: "mismatch", code: "composer_drift" };
  }
  if (request.expected.configurationReceiptDigest !== expectedConfiguration) {
    return { status: "mismatch", code: "configuration_drift" };
  }

  let observation: BrowserObservationResult;
  try {
    observation = await observeBrowserPage(request.page, {
      operationId: identity,
      target,
      evidenceDigest,
      responseContent: "metadata"
    });
  } catch {
    return { status: "unavailable", code: "target_evidence_unavailable" };
  }
  const snapshot = observation.snapshot;
  if (state.target?.targetLifecycle === "new_pending") {
    const anchor = observation.newTargetAnchor;
    if (
      anchor === undefined
      || anchor.anchorDigest !== state.target.newTargetAnchorDigest
      || anchor.blankTaskEvidenceDigest !== state.target.blankTaskEvidenceDigest
      || snapshot.target.thread.status !== "unavailable"
      || snapshot.target.conversation.status !== "unavailable"
      || snapshot.target.canonicalThreadUrl.status !== "unavailable"
      || snapshot.userTurns.length !== 0
      || snapshot.assistantTurns.length !== 0
    ) {
      return { status: "unavailable", code: "target_evidence_unavailable", evidenceDigest: snapshot.snapshotDigest };
    }
  }
  if (!stableBaseline(snapshot)) {
    return { status: "unavailable", code: "target_evidence_unavailable", evidenceDigest: snapshot.snapshotDigest };
  }
  const composerTarget = state.target;
  if (composerTarget === undefined) return { status: "unavailable", code: "target_evidence_unavailable" };
  const composer = await readComposerState(request.page, composerTarget, identity, evidenceDigest);
  if (composer === undefined) return { status: "unavailable", code: "composer_drift", evidenceDigest: snapshot.snapshotDigest };
  if (composer.text !== state.desiredComposerText) {
    return { status: "mismatch", code: "composer_drift", evidenceDigest: composer.evidenceDigest };
  }

  const attachments = await observeAttachmentEnvelope(
    {
      operationId: identity,
      requestDigest: state.requestDigest!,
      surface: request.expected.surface,
      targetBindingDigest: request.expected.targetBindingDigest,
      manifest: request.expected.attachmentManifest
    },
    request.page,
    composerTarget,
    evidenceDigest,
    state,
    attachmentObserver
  );
  if (attachments.status !== "absent" && attachments.status !== "exact") {
    return { status: "unavailable", code: "attachment_manifest_mismatch", evidenceDigest: snapshot.snapshotDigest };
  }

  const baseline = baselineForSnapshot(snapshot, evidenceDigest, identity, request.expected.targetBindingDigest);
  if (baseline === undefined) return { status: "unavailable", code: "target_evidence_unavailable", evidenceDigest: snapshot.snapshotDigest };
  const sendAttachments: SendOnceAttachmentObservation = {
    count: attachments.count,
    orderPolicy: "exact",
    identityDigests: [...attachments.identityDigests]
  };
  return {
    status: "exact",
    targetBindingDigest: request.expected.targetBindingDigest,
    configurationReceiptDigest: request.expected.configurationReceiptDigest,
    composerReceiptDigest: request.expected.composerReceiptDigest,
    attachments: sendAttachments,
    baseline: {
      ...(baseline.userTurns.at(-1)?.stableId === undefined ? {} : { userTurnId: baseline.userTurns.at(-1)!.stableId }),
      ownershipBaseline: baseline,
      userTurnEvidenceDigest: safeDigestWith(evidenceDigest, "send-baseline", {
        snapshotDigest: baseline.snapshotDigest,
        userTurns: baseline.userTurns.map(turn => turn.evidenceDigest)
      }) ?? baseline.snapshotDigest
    },
    evidenceDigest: snapshot.snapshotDigest
  };
}

async function observeSendPostcondition(
  request: SendOncePostconditionRequest,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<SubmissionFinalTransactionResult> {
  const identity = sendIdentity(state, request.expected);
  if (identity === undefined) return { status: "blocked", blockerCode: "target_evidence_unavailable" };
  // The SendOnce coordinator carries the complete baseline that was either
  // durably appended before activation or projected by the service after a
  // restart. Never fall back to the request-scoped map/current page here.
  const baseline = request.baseline.ownershipBaseline;
  if (baseline === undefined) return { status: "blocked", blockerCode: "target_evidence_unavailable" };
  // A process restart loses the in-memory baseline map. The durable pending
  // target's blank-task evidence is the only safe recovery prefix: it proves
  // that the operation owned zero turns before its one durable Send intent.
  const target = targetForObservation(request.expected, state);
  if (target === undefined) return { status: "blocked", blockerCode: "target_evidence_unavailable" };
  let observation: BrowserObservationResult;
  try {
    observation = await observeBrowserPage(request.page, {
      operationId: identity,
      target,
      evidenceDigest,
      responseContent: "metadata",
      baseline
    });
  } catch {
    return { status: "blocked", blockerCode: "target_evidence_unavailable" };
  }
  const delta = observation.snapshot.postSendDelta;
  if (delta === undefined || delta.baselineSnapshotDigest !== baseline.snapshotDigest) {
    return { status: "blocked", blockerCode: "ambiguous_submit", evidenceDigest: observation.snapshot.snapshotDigest };
  }
  const added = observation.snapshot.userTurns.filter(turn => delta.addedUserEvidenceDigests.includes(turn.evidenceDigest));
  if (added.length !== 1) {
    return {
      status: "blocked",
      blockerCode: added.length > 1 ? "concurrent_user_turn" : "ambiguous_submit",
      evidenceDigest: observation.snapshot.snapshotDigest
    };
  }
  const user = added[0];
  if (user?.stableId === undefined) {
    return { status: "blocked", blockerCode: "target_evidence_unavailable", evidenceDigest: observation.snapshot.snapshotDigest };
  }
  const assistant = observation.snapshot.assistantTurns.find(turn => turn.parentStableId === user.stableId);
  const status = request.mode === "observe_only" ? "already_submitted" : "submitted";
  const established = state.target?.targetLifecycle === "new_pending"
    ? (() => {
        const conversation = observation.snapshot.target.conversation;
        const canonicalThreadUrl = observation.snapshot.target.canonicalThreadUrl;
        if (
          conversation.status !== "available"
          || canonicalThreadUrl.status !== "available"
          || state.target.newTargetAnchorDigest === undefined
        ) return undefined;
        return {
          targetBindingDigest: request.expected.targetBindingDigest,
          anchorDigest: state.target.newTargetAnchorDigest,
          causalSendActionId: request.actionId,
          conversationId: conversation.value,
          canonicalThreadUrl: canonicalThreadUrl.value,
          userTurnId: user.stableId,
          userTurnEvidenceDigest: user.evidenceDigest,
          postSendDeltaDigest: delta.deltaDigest,
          evidenceDigest: observation.snapshot.snapshotDigest
        };
      })()
    : undefined;
  if (state.target?.targetLifecycle === "new_pending" && established === undefined) {
    return { status: "blocked", blockerCode: "target_evidence_unavailable", evidenceDigest: observation.snapshot.snapshotDigest };
  }
  return {
    status,
    targetBindingDigest: request.expected.targetBindingDigest,
    evidenceDigest: observation.snapshot.snapshotDigest,
    userTurnId: user.stableId,
    userTurnEvidenceDigest: user.evidenceDigest,
    postSendDeltaDigest: delta.deltaDigest,
    ...(assistant?.stableId === undefined ? {} : { assistantTurnId: assistant.stableId }),
    ...(established === undefined ? {} : { targetEstablishment: established })
  };
}

async function observeSubmissionAttachments(
  request: SubmissionAttachmentRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState,
  attachmentObserver: ProductionPrimitiveAttachmentObserver | undefined
): Promise<SubmissionAttachmentObservation> {
  state.target = target;
  return await observeAttachmentEnvelope(request, page, target, evidenceDigest, state, attachmentObserver);
}

async function observeAttachmentEnvelope(
  request: SubmissionAttachmentRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState,
  attachmentObserver: ProductionPrimitiveAttachmentObserver | undefined
): Promise<SubmissionAttachmentObservation> {
  if (attachmentObserver !== undefined && request.manifest.count > 0) {
    try {
      return await attachmentObserver(request, page, target);
    } catch {
      return { status: "unavailable" };
    }
  }
  if (request.manifest.count > 0) return { status: "unavailable" };
  const result = await readEmptyAttachmentState(page);
  if (result === undefined || !result.supported) return { status: "unavailable" };
  if (result.count !== 0 || result.visibleAttachmentCount !== 0) return { status: "mismatch" };
  const evidence = safeDigestWith(evidenceDigest, "composer-attachments", {
    operationId: request.operationId,
    targetBindingDigest: request.targetBindingDigest,
    count: 0
  });
  if (evidence === undefined) return { status: "unavailable" };
  return {
    status: "absent",
    evidenceDigest: evidence,
    count: 0,
    orderPolicy: "exact",
    identityDigests: []
  };
}

async function readEmptyAttachmentState(page: Readonly<PageLike>): Promise<{
  supported: boolean;
  count: number;
  visibleAttachmentCount: number;
} | undefined> {
  if (typeof page.evaluate !== "function") return undefined;
  try {
    const result = await page.evaluate(() => {
      const visible = (element: HTMLElement): boolean => {
        let ancestor: Node | null = element;
        for (let depth = 0; ancestor !== null && depth < 4096; depth += 1) {
          if (ancestor.nodeType === 1) {
            const candidate = ancestor as Element;
            if (candidate.hasAttribute("hidden") || candidate.hasAttribute("inert") || candidate.getAttribute("aria-hidden") === "true") return false;
          }
          ancestor = ancestor.parentNode;
        }
        if (ancestor !== null) throw new Error("node limit exceeded");
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : undefined;
        return rect === undefined || rect.width > 0 || rect.height > 0;
      };
      const boundedQuery = <T extends Element>(
        root: Node,
        selector: string,
        maxMatched = 4096,
        maxVisited = 4096
      ): T[] => {
        const simpleMatch = (element: Element, token: string): boolean => {
          let offset = 0;
          const tag = /^[A-Za-z][A-Za-z0-9-]*/u.exec(token);
          if (tag !== null) {
            if (element.tagName.toLocaleLowerCase() !== tag[0].toLocaleLowerCase()) return false;
            offset = tag[0].length;
          }
          while (offset < token.length) {
            if (token[offset] !== "[") return false;
            const close = token.indexOf("]", offset + 1);
            if (close < 0) return false;
            const expression = token.slice(offset + 1, close).trim();
            const attribute = /^([A-Za-z0-9_:-]+)(?:(\*=|=)'([^']*)'(?:\s+(i))?)?$/u.exec(expression);
            if (attribute === null) return false;
            const actual = element.getAttribute(attribute[1]!);
            if (attribute[2] === undefined) {
              if (actual === null) return false;
            } else {
              if (actual === null) return false;
              const insensitive = attribute[4] === "i";
              const left = insensitive ? actual.toLocaleLowerCase() : actual;
              const rightValue = attribute[3] ?? "";
              const right = insensitive ? rightValue.toLocaleLowerCase() : rightValue;
              if (attribute[2] === "=" ? left !== right : !left.includes(right)) return false;
            }
            offset = close + 1;
          }
          return true;
        };
        const tokensFor = (branch: string): string[] => {
          const tokens: string[] = [];
          let depth = 0;
          let start = 0;
          for (let index = 0; index <= branch.length; index += 1) {
            const character = branch[index];
            if (character === "[") depth += 1;
            if (character === "]") depth -= 1;
            if ((character === undefined || /\s/u.test(character)) && depth === 0) {
              const token = branch.slice(start, index).trim();
              if (token.length > 0) tokens.push(token);
              start = index + 1;
            }
          }
          return tokens;
        };
        const selectorMatch = (element: Element): boolean => {
          for (const rawBranch of selector.split(",")) {
            const tokens = tokensFor(rawBranch.trim());
            if (tokens.length === 0 || !simpleMatch(element, tokens[tokens.length - 1]!)) continue;
            let ancestor: Node | null = element.parentNode;
            let tokenIndex = tokens.length - 2;
            while (tokenIndex >= 0) {
              while (ancestor !== null
                && (ancestor.nodeType !== 1 || !simpleMatch(ancestor as Element, tokens[tokenIndex]!))) {
                ancestor = ancestor.parentNode;
              }
              if (ancestor === null) break;
              tokenIndex -= 1;
              ancestor = ancestor.parentNode;
            }
            if (tokenIndex < 0) return true;
          }
          return false;
        };
        let visited = 0;
        const matches: T[] = [];
        let current: Node | null = root.firstChild;
        while (current !== null) {
          visited += 1;
          if (visited > maxVisited) throw new Error("node limit exceeded");
          if (current.nodeType === 1 && selectorMatch(current as Element)) {
            matches.push(current as T);
            if (matches.length > maxMatched) throw new Error("node limit exceeded");
          }
          if (current.firstChild !== null) {
            current = current.firstChild;
            continue;
          }
          while (current !== null && current !== root && current.nextSibling === null) current = current.parentNode;
          current = current === null || current === root ? null : current.nextSibling;
        }
        return matches;
      };
      const composerAncestor = (anchor: Element): HTMLElement | null => {
        let fallback: HTMLElement | null = null;
        let current: Node | null = anchor;
        for (let depth = 0; current !== null && depth < 4096; depth += 1) {
          if (current.nodeType === 1) {
            const element = current as HTMLElement;
            if (element.tagName === "FORM") return element;
            const testId = (element.getAttribute("data-testid") ?? "").toLocaleLowerCase();
            const classTokens = (element.getAttribute("class") ?? "").toLocaleLowerCase().split(/\s+/u);
            if (fallback === null && (testId.includes("composer")
              || classTokens.includes("composer-parent")
              || classTokens.includes("group/composer"))) fallback = element;
          }
          current = current.parentNode;
        }
        if (current !== null) throw new Error("node limit exceeded");
        return fallback;
      };
      const allInputs = boundedQuery<HTMLInputElement>(document, "input[type='file']")
        .filter(input => !input.disabled && input.getAttribute("aria-disabled") !== "true");
      const preferred = allInputs.filter(input => input.getAttribute("id") === "upload-files");
      const prompts = boundedQuery<HTMLElement>(document,
        "#prompt-textarea, [data-testid='prompt-textarea']").filter(visible);
      const anchors: Element[] = preferred.length === 1 ? preferred : prompts;
      const composers = [...new Set(anchors.map(anchor =>
        composerAncestor(anchor)
      ).filter((value): value is HTMLElement => value !== null))];
      if (composers.length !== 1) return { supported: false, count: 0, visibleAttachmentCount: 0 };
      const scopedInputs = preferred.length === 1 ? preferred : boundedQuery<HTMLInputElement>(composers[0]!, "input[type='file']")
        .filter(input => !input.disabled && input.getAttribute("aria-disabled") !== "true");
      const scopedPreferred = scopedInputs.filter(input => input.getAttribute("id") === "upload-files");
      const nonImage = scopedInputs.filter(input => input.getAttribute("accept") !== "image/*");
      const inputs = scopedPreferred.length === 1
        ? scopedPreferred
        : scopedInputs.length === 1
          ? scopedInputs
          : nonImage.length === 1
            ? nonImage
            : [];
      if (inputs.length !== 1) return { supported: false, count: 0, visibleAttachmentCount: 0 };
      const selectors = [
        "[data-testid*='attachment' i]",
        "[data-testid*='file' i]",
        "[aria-label*='attachment' i]",
        "[aria-label*='upload' i]",
        "[aria-label*='file' i]",
        "[class*='attachment' i]",
        "[class*='upload' i]",
        "[class*='file' i]",
        "[role='progressbar']"
      ].join(", ");
      const visibleAttachmentCount = boundedQuery<HTMLElement>(composers[0]!, selectors).filter(visible).length;
      return {
        supported: true,
        count: inputs[0]!.files?.length ?? 0,
        visibleAttachmentCount
      };
    });
    if (result === null || typeof result !== "object") return undefined;
    if (typeof result.supported !== "boolean" || !Number.isSafeInteger(result.count) || !Number.isSafeInteger(result.visibleAttachmentCount)) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

async function readComposerState(
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  operationId: string,
  evidenceDigest: BrowserObservationDigest
): Promise<{ text: string; currentStateDigest: string; evidenceDigest: string } | undefined> {
  void target;
  const locator = await uniqueVisibleLocator(page, composerTextbox);
  if (locator === undefined) return undefined;
  const text = await readLocatorText(locator);
  if (text === undefined || text.length > MAX_COMPOSER_CHARS || text.includes("\u0000")) return undefined;
  const currentStateDigest = safeDigestWith(evidenceDigest, "composer-state", {
    operationId,
    text
  });
  if (currentStateDigest === undefined) return undefined;
  const observationDigest = safeDigestWith(evidenceDigest, "composer-observation", {
    operationId,
    currentStateDigest
  });
  if (observationDigest === undefined) return undefined;
  return { text, currentStateDigest, evidenceDigest: observationDigest };
}

async function readLocatorText(locator: LocatorLike): Promise<string | undefined> {
  try {
    // The locator textContent/innerText fallbacks expose no provider-side
    // maximum and would materialize an unbounded string before this adapter
    // could inspect it.  The transactional path therefore requires evaluate
    // so the cap is enforced inside the browser realm.
    if (typeof locator.evaluate !== "function") return undefined;
    const value = await locator.evaluate(element => {
      const candidate = element as HTMLElement & { value?: unknown };
      const candidateValue = candidate.value;
      const tag = typeof candidate.tagName === "string" ? candidate.tagName.toLowerCase() : "";
      // The Chrome bridge presents a synthetic empty `value` on ChatGPT's
      // contenteditable DIV. Only native value controls use that property;
      // contenteditable composers must be read from their bounded text tree.
      if ((tag === "input" || tag === "textarea" || tag === "select") && typeof candidateValue === "string") {
        // Enforce the cap in the browser realm before the bridge serializes
        // the value.  A post-return check would already have crossed the
        // unbounded provider boundary.
        return candidateValue.length <= 8 * 1024 * 1024 ? candidateValue : undefined;
      }
      const chunks: string[] = [];
      const ancestors: Node[] = [];
      let visited = 0;
      let total = 0;
      let current: Node | null = candidate;
      while (current !== null) {
        visited += 1;
        if (visited > 4096) return undefined;
        let skipChildren = false;
        if (current.nodeType === 1) {
          const element = current as HTMLElement;
          const attribute = (name: string): string | null => typeof element.getAttribute === "function"
            ? element.getAttribute(name)
            : null;
          if (attribute("data-inline-selection-pill-cursor-target") !== null) {
            skipChildren = true;
          } else if (attribute("data-inline-selection-pill") !== null
            && attribute("data-reference-type") === "url") {
            const sourceUrl = attribute("data-id");
            if (sourceUrl !== null && sourceUrl.trim().length > 0) {
              total += sourceUrl.length;
              if (total > 8 * 1024 * 1024) return undefined;
              chunks.push(sourceUrl);
              skipChildren = true;
            }
          } else if (element.tagName === "BR") {
            const className = attribute("class") ?? "";
            if (!className.split(/\s+/u).includes("ProseMirror-trailingBreak")) {
              total += 1;
              if (total > 8 * 1024 * 1024) return undefined;
              chunks.push("\n");
            }
            skipChildren = true;
          } else if (element.tagName === "IMG") {
            skipChildren = true;
          }
        }
        if (current.nodeType === 3) {
          const text = current.nodeValue ?? "";
          total += text.length;
          if (total > 8 * 1024 * 1024) return undefined;
          if (text.length > 0) chunks.push(text);
        }
        const child: Node | null = skipChildren ? null : current.firstChild;
        if (child !== null) {
          if (ancestors.length >= 4096) return undefined;
          ancestors.push(current);
          current = child;
          continue;
        }
        while (current !== null && current !== candidate && current.nextSibling === null) {
          current = ancestors.pop() ?? null;
        }
        if (current === candidate) break;
        if (current !== null) current = current.nextSibling;
      }
      return chunks.join("");
    });
    return typeof value === "string" && value.length <= MAX_COMPOSER_CHARS ? value : undefined;
  } catch {
    return undefined;
  }
  return undefined;
}

async function uniqueVisibleLocator(
  page: Readonly<PageLike>,
  factory: (page: PageLike) => LocatorLike
): Promise<LocatorLike | undefined> {
  if (typeof page.getByRole !== "function") return undefined;
  let locator: LocatorLike;
  try {
    locator = factory(page as PageLike);
  } catch {
    return undefined;
  }
  if (typeof locator.count !== "function") return undefined;
  let count: number;
  try {
    count = await locator.count();
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_LOCATOR_CANDIDATES) return undefined;
  const visible: LocatorLike[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = count === 1 ? locator : locator.nth?.(index);
    if (candidate === undefined || typeof candidate.isVisible !== "function") return undefined;
    try {
      if (await candidate.isVisible()) visible.push(candidate);
    } catch {
      return undefined;
    }
  }
  return visible.length === 1 ? visible[0] : undefined;
}

function targetForObservation(
  expected: SubmissionExpectedEnvelope,
  state: PrimitiveState
): {
  providerId: string;
  browserId: string;
  tabId: string;
  coordinationScope: "process" | "provider";
  authoritativeTabClaim?: string;
  expectedConversationId?: string;
} | undefined {
  void expected;
  return state.target === undefined ? undefined : buildObservationTarget(state.target, state.authoritativeTabClaim);
}

function sendIdentity(state: PrimitiveState, expected: SubmissionExpectedEnvelope): string | undefined {
  if (state.operationId === undefined || !isId(state.operationId) || state.requestDigest === undefined || !isDigest(state.requestDigest)) return undefined;
  if (!isDigest(expected.targetBindingDigest)) return undefined;
  return state.operationId;
}

function stableBaseline(snapshot: OwnershipSnapshot): boolean {
  return snapshot.completeness === "complete"
    && snapshot.userTurns.every(turn => turn.stableId !== undefined);
}

function baselineForSnapshot(
  snapshot: OwnershipSnapshot,
  evidenceDigest: BrowserObservationDigest,
  operationId: string,
  targetBindingDigest: string
): OwnershipBaseline | undefined {
  if (snapshot.completeness !== "complete" || !stableBaseline(snapshot)) return undefined;
  const snapshotDigest = safeDigestWith(evidenceDigest, "send-baseline-snapshot", {
    operationId,
    targetBindingDigest,
    snapshotDigest: snapshot.snapshotDigest
  }) ?? snapshot.snapshotDigest;
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest,
    target: snapshot.target,
    userTurns: snapshot.userTurns,
    assistantTurns: snapshot.assistantTurns,
    completeness: "complete"
  };
}

function recoverPendingBlankBaseline(
  state: PrimitiveState
): OwnershipBaseline | undefined {
  const target = state.target;
  if (
    target === undefined
    || target.targetLifecycle !== "new_pending"
    || target.blankTaskEvidenceDigest === undefined
    || !isDigest(target.blankTaskEvidenceDigest)
  ) return undefined;
  const observationTarget = buildObservationTarget(target, state.authoritativeTabClaim);
  if (observationTarget === undefined) return undefined;
  const available = (value: string): OwnershipIdentityEvidence => ({ status: "available", value });
  const unavailable = (): OwnershipIdentityEvidence => ({ status: "unavailable", reason: "not_observed" });
  const targetEvidence: OwnershipTargetEvidence = {
    provider: available(observationTarget.providerId),
    browser: available(observationTarget.browserId),
    tab: available(observationTarget.tabId),
    thread: unavailable(),
    conversation: unavailable(),
    canonicalThreadUrl: unavailable(),
    authoritativeTabClaim: observationTarget.authoritativeTabClaim === undefined
      ? { status: "unavailable", reason: "not_exposed" }
      : available(observationTarget.authoritativeTabClaim),
    coordinationScope: observationTarget.coordinationScope
  };
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest: target.blankTaskEvidenceDigest,
    target: targetEvidence,
    userTurns: [],
    assistantTurns: [],
    completeness: "complete"
  };
}

function buildObservationTarget(
  target: OperationTargetBindingV1,
  authoritativeTabClaim: string | undefined
): {
  providerId: string;
  browserId: string;
  tabId: string;
  coordinationScope: "process" | "provider";
  authoritativeTabClaim?: string;
  expectedConversationId?: string;
  targetLifecycle: "fixed" | "new_pending" | "new_established";
} | undefined {
  if (
    !isId(target.providerId)
    || !isId(target.browserId)
    || !isId(target.tabId)
  ) {
    return undefined;
  }
  const lifecycle = target.targetLifecycle ?? "fixed";
  if (lifecycle !== "new_pending" && (
    target.conversationId === undefined
    || !isId(target.conversationId)
    || target.canonicalThreadUrl === undefined
    || !OPAQUE_THREAD_URL_PATTERN.test(target.canonicalThreadUrl)
  )) return undefined;
  if (lifecycle === "new_pending" && (
    target.newTargetAnchorDigest === undefined
    || target.blankTaskEvidenceDigest === undefined
    || !isDigest(target.newTargetAnchorDigest)
    || !isDigest(target.blankTaskEvidenceDigest)
  )) return undefined;
  if (target.coordinationScope === "provider" && (authoritativeTabClaim === undefined || !isId(authoritativeTabClaim))) return undefined;
  return {
    providerId: target.providerId,
    browserId: target.browserId,
    tabId: target.tabId,
    coordinationScope: target.coordinationScope,
    targetLifecycle: lifecycle,
    ...(authoritativeTabClaim === undefined ? {} : { authoritativeTabClaim }),
    ...(target.conversationId === undefined ? {} : { expectedConversationId: target.conversationId })
  };
}

function makeObservationTarget(
  target: OperationTargetBindingV1,
  state: PrimitiveState
): ReturnType<typeof buildObservationTarget> {
  return buildObservationTarget(target, state.authoritativeTabClaim);
}

async function readCollectorContext(
  request: OperationCollectorContextRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<OperationCollectorContext> {
  if (request.submissionActionId === undefined || !isId(request.submissionActionId)) throw new ProductionPrimitiveError("submission_witness_unwired");
  // The service projects the authenticated causal baseline into every
  // collect attempt. Use it for this context read as well, so a later
  // observation can request terminal metadata for the exact assistant turn
  // even when a previous wait:false call returned to the caller.
  const baseline = request.baseline;
  if (baseline === undefined) throw new ProductionPrimitiveError("target_evidence_unavailable");
  const observationTarget = makeObservationTarget(target, state);
  if (observationTarget === undefined) throw new ProductionPrimitiveError("target_evidence_unavailable");
  const observation = await observeBrowserPage(page, {
    operationId: request.operationId,
    target: observationTarget,
    evidenceDigest,
    responseContent: "metadata",
    baseline
  });
  const binding: OwnershipBinding = {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    operationId: request.operationId,
    targetBindingDigest: request.targetBindingDigest,
    target: observation.snapshot.target,
    evidenceProfile: {
      stableConversationId: "required",
      stableUserTurnId: "required",
      stableAssistantTurnId: "required",
      stableBranchId: "required",
      authoritativeTabClaim: target.coordinationScope === "provider" ? "required" : "unavailable"
    },
    replacementTabRecovery: false,
    actionId: request.submissionActionId,
    actionKind: request.submissionActionKind ?? "send"
  };
  // This cursor is only a candidate from the immediately preceding read. The
  // service keeps the journal baseline/witness authoritative, and the
  // collector reclassifies the next snapshot against both before using it.
  // Never fabricate a cursor when the authenticated witness is absent or the
  // exact delta cannot be classified.
  let prior: OperationCollectorContext["prior"];
  if (request.submissionWitness !== undefined) {
    try {
      prior = classifyTurnOwnership({
        binding,
        baseline,
        snapshot: observation.snapshot,
        submissionWitness: request.submissionWitness
      }).cursor;
    } catch {
      prior = undefined;
    }
  }
  return {
    binding,
    baseline,
    ...(prior === undefined ? {} : { prior })
  };
}

async function observeCollector(
  request: CollectorObservationRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  context: OperationCollectorContext,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<CollectorObservation> {
  const observationTarget = makeObservationTarget(target, state);
  if (observationTarget === undefined) throw new ProductionPrimitiveError("target_evidence_unavailable");
  const result = await observeBrowserPage(page, {
    operationId: request.operationId,
    target: observationTarget,
    evidenceDigest,
    responseContent: request.responseContent,
    ...(context.baseline === undefined ? {} : { baseline: context.baseline }),
    ...(context.prior?.assistantTurnId === undefined ? {} : {
      terminalAssistantTurnId: context.prior.assistantTurnId,
      ...(request.responseContent === "include" ? { rawAssistantTurnId: context.prior.assistantTurnId } : {})
    })
  });
  return {
    schemaVersion: COLLECTOR_SCHEMA_VERSION,
    snapshot: result.snapshot,
    ...(result.terminal === undefined ? {} : { terminal: result.terminal })
  };
}

async function sleepOutsideBrowser(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 60_000) throw new ProductionPrimitiveError("invalid_sleep");
  if (signal.aborted) throw new ProductionPrimitiveError("operation_cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new ProductionPrimitiveError("operation_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function observeControlTurn(
  request: ControlTurnObservationRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<ControlTurnObservation> {
  const observation = await observeControlSnapshot(request.operationId, page, target, evidenceDigest, state);
  if (observation === undefined) return { status: "uncertain", reason: "unavailable" };
  const assistant = observation.snapshot.assistantTurns.find(turn => turn.stableId === request.expectedAssistantTurnId);
  if (assistant === undefined) return { status: "mismatch", reason: "different_turn", evidenceDigest: observation.snapshot.snapshotDigest };
  if (assistant.state === "generating") {
    return { status: "generating", assistantTurnId: request.expectedAssistantTurnId, evidenceDigest: assistant.evidenceDigest };
  }
  return { status: "terminal", assistantTurnId: request.expectedAssistantTurnId, reason: "not_generating", evidenceDigest: assistant.evidenceDigest };
}

async function executeControlOnce(
  request: ControlExecutionRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<ControlPostconditionObservation> {
  if (request.action !== "stop") return { status: "uncertain", blockerCode: "send_control_unavailable" };
  const locator = await uniqueVisibleLocator(page, stopGenerationButton);
  if (locator === undefined || typeof locator.click !== "function") return { status: "uncertain", blockerCode: "send_control_unavailable" };
  try {
    // Sole Stop activation. A rejection is not retried and is reconciled by
    // the control coordinator's observation-only path.
    await locator.click();
  } catch {
    return { status: "uncertain", blockerCode: "send_control_unavailable" };
  }
  // Release the mutation actor before reading the postcondition. Returning an
  // uncertain result instructs the control coordinator to reacquire the tab
  // through its observation-only port; it must never make this primitive hold
  // the actor across both activation and reconciliation.
  return { status: "uncertain" };
}

async function observeControlPostcondition(
  request: ControlPostconditionRequest,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<ControlPostconditionObservation> {
  if (request.action !== "stop") return { status: "uncertain", blockerCode: "send_control_unavailable" };
  const observation = await observeControlSnapshot(request.operationId, page, target, evidenceDigest, state);
  if (observation === undefined) return { status: "uncertain", blockerCode: "target_evidence_unavailable" };
  const assistant = observation.snapshot.assistantTurns.find(turn => turn.stableId === request.expectedAssistantTurnId);
  if (assistant === undefined) return { status: "not_satisfied", blockerCode: "target_binding_mismatch", evidenceDigest: observation.snapshot.snapshotDigest };
  if (assistant.state === "generating") return { status: "not_satisfied", blockerCode: "send_control_unavailable", evidenceDigest: observation.snapshot.snapshotDigest };
  return { status: "satisfied", assistantTurnId: request.expectedAssistantTurnId, evidenceDigest: assistant.evidenceDigest };
}

async function observeControlSnapshot(
  operationId: string,
  page: Readonly<PageLike>,
  target: OperationTargetBindingV1,
  evidenceDigest: BrowserObservationDigest,
  state: PrimitiveState
): Promise<BrowserObservationResult | undefined> {
  const observationTarget = makeObservationTarget(target, state);
  if (observationTarget === undefined) return undefined;
  try {
    return await observeBrowserPage(page, {
      operationId,
      target: observationTarget,
      evidenceDigest,
      responseContent: "metadata"
    });
  } catch {
    return undefined;
  }
}

function safeDigestWith(
  evidenceDigest: BrowserObservationDigest,
  domain: string,
  material: unknown
): string | undefined {
  try {
    const value = evidenceDigest(domain, material);
    return isDigest(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function digest(
  evidenceDigest: BrowserObservationDigest,
  domain: string,
  material: unknown
): string | undefined {
  return safeDigestWith(evidenceDigest, domain, material);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validateOptions(options: ProductionOperationPrimitiveOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options) || typeof options.evidenceDigest !== "function") {
    throw new ProductionPrimitiveError("invalid_options");
  }
  if (options.operationId !== undefined && !isId(options.operationId)) throw new ProductionPrimitiveError("invalid_options");
  if (options.requestDigest !== undefined && !isDigest(options.requestDigest)) throw new ProductionPrimitiveError("invalid_options");
  if (options.authoritativeTabClaim !== undefined && !isId(options.authoritativeTabClaim)) throw new ProductionPrimitiveError("invalid_options");
  if (options.desiredComposerText !== undefined && typeof options.desiredComposerText !== "string") throw new ProductionPrimitiveError("invalid_options");
  if (options.composerText !== undefined && typeof options.composerText !== "string") throw new ProductionPrimitiveError("invalid_options");
  if (options.observeAttachments !== undefined && typeof options.observeAttachments !== "function") throw new ProductionPrimitiveError("invalid_options");
  if (options.target !== undefined && (options.target === null || typeof options.target !== "object" || Array.isArray(options.target))) throw new ProductionPrimitiveError("invalid_options");
}
