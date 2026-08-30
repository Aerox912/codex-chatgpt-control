export const OPERATION_SCHEMA_VERSION = "chatgpt.browser_control.operation.v1" as const;
export const OPERATION_EVENT_SCHEMA_VERSION = "chatgpt.browser_control.operation_event.v1" as const;
export const OPERATION_RECEIPT_SCHEMA_VERSION = "chatgpt.browser_control.operation_receipt.v1" as const;
export const OPERATION_REQUEST_SCHEMA_VERSION = "chatgpt.browser_control.operation_request.v1" as const;
export const OPERATION_HANDLE_SCHEMA_VERSION = "chatgpt.browser_control.operation_handle.v1" as const;
export const OPERATION_COLLECT_REQUEST_SCHEMA_VERSION = "chatgpt.browser_control.operation_collect_request.v1" as const;
export const OPERATION_INSPECT_REQUEST_SCHEMA_VERSION = "chatgpt.browser_control.operation_inspect_request.v1" as const;
export const OPERATION_CONTROL_REQUEST_SCHEMA_VERSION = "chatgpt.browser_control.operation_control_request.v1" as const;
export const OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION = "chatgpt.browser_control.operation_control_receipt.v1" as const;
export const OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION = "chatgpt.browser_control.operation_artifact_receipt.v1" as const;
export const OPERATION_BLOCKER_SCHEMA_VERSION = "chatgpt.browser_control.operation_blocker.v1" as const;
export const OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION = "chatgpt.browser_control.operation_recovery_observation.v1" as const;
export const OPERATION_RECOVERY_DECISION_SCHEMA_VERSION = "chatgpt.browser_control.operation_recovery_decision.v1" as const;
/** Redacted exact post-Send ownership proof retained in the authenticated journal. */
export const OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION = "chatgpt.browser_control.operation_submission_witness.v1" as const;
/** Redacted complete pre-Send ownership baseline retained before activation. */
export const OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION = "chatgpt.browser_control.operation_ownership_baseline.v1" as const;
/** Durable transfer records reuse the provider-agnostic artifact-transfer protocol exactly. */
export const OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION = "chatgpt.browser_control.artifact_transfer_intent.v1" as const;
export const OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION = "chatgpt.browser_control.artifact_transfer_receipt.v1" as const;

import type {
  ArtifactTransferDurableState,
  ArtifactTransferIntentV1,
  ArtifactTransferReceiptV1
} from "./artifact-transfer.js";
import type { OwnershipBaseline } from "./turn-ownership.js";
import type { ChatGPTProjectColor, ChatGPTProjectIcon } from "../types.js";

export type OperationSurface = "chat" | "work";

export type OperationJsonValue =
  | null
  | boolean
  | number
  | string
  | OperationJsonValue[]
  | { [key: string]: OperationJsonValue };

export type OperationTargetRequestV1 =
  | { type: "new" }
  /** Start a new conversation inside one exact existing ChatGPT Project. */
  | {
      type: "project";
      name: string;
      icon?: ChatGPTProjectIcon;
      color?: ChatGPTProjectColor;
      /** Explicit account-mutation authority; omitted means existing-only. */
      confirmCreation?: true;
    }
  | { type: "selected_tab" }
  | { type: "tab_id"; tabId: string }
  | { type: "conversation_id"; conversationId: string }
  | { type: "url"; url: string };

export type OperationConfigurationRequestV1 = {
  experience?: "chat" | "work";
  model?: string;
  modelVersion?: string;
  reasoning?: string;
  mode?: string;
  tools?: string[];
  additional?: { [key: string]: OperationJsonValue };
};

export type OperationInputFileV1 = {
  /** Request-only local input. It must never be copied into durable state. */
  path: string;
  displayName?: string;
};

/**
 * Transactional capture formats are deliberately narrower than the general
 * response formatter.  A request may ask for semantic DOM Markdown or the
 * formatter's normalized visible text; the choice is part of request
 * identity and is never inferred from a later collect call.
 */
export type OperationResponseFormatV1 = "markdown" | "text";

export type OperationCapturePolicyV1 = {
  responseContent: "include" | "metadata";
  /** Immutable requested format for the terminal assistant response. */
  responseFormat?: OperationResponseFormatV1;
  artifacts: "receipt_only" | "transfer";
  /** Request-only destination. It must never be copied into durable state. */
  outputDirectory?: string;
};

/**
 * The request's capture policy after crossing into durable state.
 *
 * This is intentionally a separate type from `OperationCapturePolicyV1`:
 * `outputDirectory` is request-local authority and must never be copied into
 * an event, snapshot, receipt, or any other authenticated durable record.
 */
export type OperationDurableCapturePolicyV1 = {
  responseContent: "include" | "metadata";
  responseFormat: OperationResponseFormatV1;
  artifacts: "receipt_only" | "transfer";
};

/** Compatibility alias for consumers that describe the field as state policy. */
export type OperationCapturePolicyStateV1 = OperationDurableCapturePolicyV1;

export type OperationSubmitRequestV1 = {
  schemaVersion: typeof OPERATION_REQUEST_SCHEMA_VERSION;
  operationId: string;
  surface: OperationSurface;
  prompt: string;
  target: OperationTargetRequestV1;
  configuration?: OperationConfigurationRequestV1;
  files?: OperationInputFileV1[];
  capture?: OperationCapturePolicyV1;
  timeoutMs?: number;
};

export type OperationHandleV1 = {
  schemaVersion: typeof OPERATION_HANDLE_SCHEMA_VERSION;
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  revision: number;
  phase: OperationPhase;
  mutationBoundary: MutationBoundary;
  targetBindingDigest?: string;
};

export type OperationCollectRequestV1 = {
  schemaVersion: typeof OPERATION_COLLECT_REQUEST_SCHEMA_VERSION;
  handle: OperationHandleV1;
  wait?: boolean;
  timeoutMs?: number;
  /** Bounded delay between ownership observations while waiting. */
  pollIntervalMs?: number;
  responseContent?: "include" | "metadata";
};

export type OperationInspectRequestV1 = {
  schemaVersion: typeof OPERATION_INSPECT_REQUEST_SCHEMA_VERSION;
  handle: OperationHandleV1;
};

export type OperationControlRequestV1 = {
  schemaVersion: typeof OPERATION_CONTROL_REQUEST_SCHEMA_VERSION;
  controlActionId: string;
  parent: OperationHandleV1;
  action: "stop" | "steer";
  expectedAssistantTurnId: string;
  steerPrompt?: string;
  timeoutMs?: number;
};

export type OperationControlReceiptV1 = {
  schemaVersion: typeof OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION;
  controlActionId: string;
  parentOperationId: string;
  parentRequestDigest: string;
  parentTargetBindingDigest: string;
  expectedAssistantTurnId: string;
  requestDigest: string;
  action: "stop" | "steer";
  outcome: OperationActionOutcome;
  evidenceDigest?: string;
  blockerCode?: OperationBlockerCode;
  observedAt: string;
};

export type OperationBlockerCode =
  | "operation_not_found"
  | "operation_request_mismatch"
  | "operation_state_corrupt"
  | "operation_receipt_expired"
  | "operation_quota_exceeded"
  | "operation_cancelled"
  | "operation_timeout"
  | "ambiguous_file_handoff"
  | "ambiguous_submit"
  | "attachment_manifest_mismatch"
  | "input_file_changed"
  | "target_binding_mismatch"
  | "target_evidence_unavailable"
  | "turn_ownership_ambiguous"
  | "concurrent_user_turn"
  | "configuration_drift"
  | "tab_ownership_conflict"
  | "provider_concurrency_unsupported"
  | "runtime_incompatible"
  | "backend_unavailable"
  | "browser_bridge_unavailable"
  | "login_required"
  | "captcha"
  | "rate_limited"
  | "permission_required"
  | "needs_confirmation"
  | "project_creation_indeterminate"
  | "selector_drift"
  | "send_control_unavailable"
  | "capture_ownership_lost"
  | "artifact_unavailable"
  | "artifact_transfer_partial"
  | "output_collision"
  | "output_commit_indeterminate"
  | "clipboard_restore_failed";

export type OperationBlockerV1 = {
  schemaVersion: typeof OPERATION_BLOCKER_SCHEMA_VERSION;
  code: OperationBlockerCode;
  recoverable: boolean;
  operationId: string;
  requestDigest: string;
  phase: OperationPhase;
  mutationBoundary: MutationBoundary;
  message: string;
};

export type OperationPhase =
  | "prepared"
  | "handoff_pending"
  | "ready"
  | "send_pending"
  | "submitted"
  | "generating"
  | "capturing"
  | "completed"
  | "uncertain";

export type MutationBoundary =
  | "none"
  | "handoff_may_have_occurred"
  | "send_may_have_occurred"
  | "control_may_have_occurred";

export type OperationRepeatPolicy =
  | "read_only"
  | "reconcile_set_to_value"
  | "reconcile_local_effect"
  | "observe_only_after_intent";

export type OperationActionKind =
  | "status_read"
  | "configuration_set"
  | "tool_set"
  | "composer_set"
  | "power_discovery"
  | "power_select"
  | "file_handoff"
  | "send"
  | "work_steer"
  | "stop"
  | "download"
  | "local_output_commit"
  | "clipboard_capture_restore";

export type OperationEvidenceProfileV1 = {
  providerIdentity: "required" | "unavailable";
  stableTabId: "required" | "unavailable";
  stableConversationId: "required" | "unavailable";
  stableUserTurnId: "required" | "unavailable";
  authoritativeTabClaim: "required" | "unavailable";
  replacementTabRecovery: boolean;
};

/**
 * A target can be fixed before mutation, or can represent a genuinely new
 * provider conversation whose identity is allocated by the first Send.
 * `fixed` is the backwards-compatible default for older durable records.
 */
export type OperationTargetLifecycle = "fixed" | "new_pending" | "new_established";

/**
 * Provider identity obtained after the sole durable Send intent.  The
 * targetBindingDigest is the pre-Send immutable anchor digest, not a digest
 * of this mutable establishment record.
 */
export type OperationTargetEstablishmentV1 = {
  targetBindingDigest: string;
  anchorDigest: string;
  causalSendActionId: string;
  conversationId: string;
  canonicalThreadUrl: string;
  userTurnId: string;
  userTurnEvidenceDigest: string;
  /** Exact before/after user-turn delta that established this new target. */
  postSendDeltaDigest?: string;
  evidenceDigest: string;
  observedAt: string;
};

/**
 * The only durable authority used to identify the operation's submitted user
 * turn after a process restart.  This record contains no prompt, response,
 * DOM, URL, or local path material.
 */
export type OperationSubmissionWitnessV1 = {
  schemaVersion: typeof OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION;
  actionId: string;
  actionKind: "send" | "work_steer";
  targetBindingDigest: string;
  /** Digest of the complete authenticated pre-Send ownership snapshot. */
  baselineSnapshotDigest: string;
  postSendDeltaDigest: string;
  operationUserEvidenceDigest: string;
  userTurnId?: string;
  observedAt: string;
};

/**
 * The authenticated pre-Send ownership anchor. The nested baseline contains
 * only normalized identities/evidence; this wrapper binds it to the
 * immutable operation/request/target/action identity.
 */
export type OperationOwnershipBaselineV1 = {
  schemaVersion: typeof OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION;
  operationId: string;
  requestDigest: string;
  targetBindingDigest: string;
  actionId: string;
  baseline: OwnershipBaseline;
  observedAt: string;
};

/** Exact aliases prevent the journal from growing a second transfer protocol. */
export type OperationArtifactTransferIntentV1 = ArtifactTransferIntentV1;
export type OperationArtifactTransferReceiptV1 = ArtifactTransferReceiptV1;
/** A materialized operation map entry always has its causal intent. */
export type OperationArtifactTransferStateV1 = ArtifactTransferDurableState & {
  readonly intent: ArtifactTransferIntentV1;
};

export type OperationTargetBindingV1 = {
  providerId: string;
  browserId: string;
  tabId: string;
  coordinationScope: "process" | "provider";
  tabClaimEvidenceDigest?: string;
  canonicalThreadUrl?: string;
  conversationId?: string;
  userTurnBaselineDigest?: string;
  assistantTurnBaselineDigest?: string;
  configurationReceiptDigest?: string;
  evidenceProfile: OperationEvidenceProfileV1;
  /** Omitted means fixed for compatibility with pre-establishment records. */
  targetLifecycle?: OperationTargetLifecycle;
  /** Keyed digest of the immutable new-task anchor; stable across establishment. */
  newTargetAnchorDigest?: string;
  /** Keyed evidence for the verified blank/new-task surface before Send. */
  blankTaskEvidenceDigest?: string;
  /** Present only after one durable target_established event. */
  targetEstablishment?: OperationTargetEstablishmentV1;
};

export type OperationActionIntentV1 = {
  actionId: string;
  kind: OperationActionKind;
  repeatPolicy: OperationRepeatPolicy;
  requestDigest: string;
  parentActionId?: string;
  targetDigest?: string;
};

export type OperationActionOutcome = "satisfied" | "not_satisfied" | "uncertain";

export type OperationActionRecordV1 = OperationActionIntentV1 & {
  intentRevision: number;
  intentAt: string;
  outcome?: OperationActionOutcome;
  receiptRevision?: number;
  receiptAt?: string;
  evidenceDigest?: string;
  blockerCode?: string;
};

export type OperationArtifactReceiptV1 = {
  schemaVersion: typeof OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION;
  operationId: string;
  artifactKey: string;
  assistantTurnId: string;
  sourceIdentityDigest: string;
  kind: "file" | "image" | "other";
  ordinal: number;
  outputKey?: string;
  mimeType?: string;
  bytes?: number;
  sha256?: string;
  status: "available" | "transferred" | "partial" | "blocked";
  blockerCode?: string;
};

export type OperationReceiptV1 = {
  schemaVersion: typeof OPERATION_RECEIPT_SCHEMA_VERSION;
  operationId: string;
  requestDigest: string;
  targetBindingDigest: string;
  userTurnId: string;
  /** Evidence for the exact submitted user turn, distinct from assistant ownership. */
  userTurnEvidenceDigest: string;
  assistantTurnId: string;
  /** Evidence for the exact terminal assistant turn / complete ownership snapshot. */
  ownershipEvidenceDigest: string;
  responseDigest?: string;
  responseBytes?: number;
  /** Format used to produce the exact owned-turn response metadata/content. */
  responseFormat?: OperationResponseFormatV1;
  finishReason: string;
  contentAvailable: boolean;
  artifacts: OperationArtifactReceiptV1[];
  completedAt: string;
};

export type OperationBlockerObservationV1 = {
  code: string;
  messageDigest: string;
  recoverable: boolean;
  observedAt: string;
};

export type OperationStateV1 = {
  schemaVersion: typeof OPERATION_SCHEMA_VERSION;
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  phase: OperationPhase;
  mutationBoundary: MutationBoundary;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Immutable, path-free capture policy copied from the canonical submit request. */
  capturePolicy?: OperationDurableCapturePolicyV1;
  /** Legacy projection retained for reads of pre-policy state. */
  responseFormat?: OperationResponseFormatV1;
  target?: OperationTargetBindingV1;
  actions: Record<string, OperationActionRecordV1>;
  /** Present only after the complete pre-Send baseline was durably appended. */
  ownershipBaseline?: OperationOwnershipBaselineV1;
  /**
   * Complete pre-action ownership anchors keyed by their causal action.  The
   * original Send anchor is also projected through ownershipBaseline for
   * compatibility with older readers; steer anchors remain per-action.
   */
  ownershipBaselines?: Record<string, OperationOwnershipBaselineV1>;
  /** Crash-replayable transfer records keyed by transferActionId. */
  artifactTransfers?: Record<string, OperationArtifactTransferStateV1>;
  /**
   * Exact post-action ownership proofs keyed by their causal action.  The
   * original Send entry is projected through submissionWitness for older
   * readers; Work steer entries remain independently addressable so a later
   * steer can own its own user-turn/output delta.
   */
  submissionWitnesses?: Record<string, OperationSubmissionWitnessV1>;
  /** Present after an exact post-Send proof has been durably recorded. */
  submissionWitness?: OperationSubmissionWitnessV1;
  lastBlocker?: OperationBlockerObservationV1;
  receipt?: OperationReceiptV1;
};

export type OperationCreatedEventV1 = {
  type: "operation_created";
  operationId: string;
  requestDigest: string;
  surface: OperationSurface;
  createdAt: string;
  /** New creation events always persist this path-free policy. */
  capturePolicy?: OperationDurableCapturePolicyV1;
};

export type OperationTargetBoundEventV1 = {
  type: "target_bound";
  target: OperationTargetBindingV1;
  observedAt: string;
};

export type OperationTargetEstablishedEventV1 = {
  type: "target_established";
  establishment: OperationTargetEstablishmentV1;
};

export type OperationOwnershipBaselineEventV1 = {
  type: "ownership_baseline";
  baseline: OperationOwnershipBaselineV1;
};

export type OperationSubmissionWitnessEventV1 = {
  type: "submission_witness";
  witness: OperationSubmissionWitnessV1;
};

export type OperationActionIntentEventV1 = {
  type: "action_intent";
  action: OperationActionIntentV1;
  intentAt: string;
};

/**
 * Atomic non-repeatable action preparation.  Unlike the legacy pair of
 * action_intent + ownership_baseline events, this event cannot leave a
 * durable action intent without its complete ownership anchor.
 */
export type OperationActionPreparedEventV1 = {
  type: "action_prepared";
  action: OperationActionIntentV1;
  intentAt: string;
  baseline: OperationOwnershipBaselineV1;
};

export type OperationArtifactTransferIntentEventV1 = {
  type: "artifact_transfer_intent";
  intent: OperationArtifactTransferIntentV1;
};

export type OperationArtifactTransferReceiptEventV1 = {
  type: "artifact_transfer_receipt";
  receipt: OperationArtifactTransferReceiptV1;
};

export type OperationActionReceiptEventV1 = {
  type: "action_receipt";
  actionId: string;
  outcome: OperationActionOutcome;
  evidenceDigest?: string;
  blockerCode?: string;
  observedAt: string;
};

export type OperationPhaseChangedEventV1 = {
  type: "phase_changed";
  from: OperationPhase;
  to: OperationPhase;
  mutationBoundary: MutationBoundary;
  causeActionId?: string;
  evidenceDigest?: string;
  observedAt: string;
};

export type OperationBlockerObservedEventV1 = {
  type: "blocker_observed";
  blocker: OperationBlockerObservationV1;
};

export type OperationReceiptCompletedEventV1 = {
  type: "receipt_completed";
  receipt: OperationReceiptV1;
  observedAt: string;
};

export type OperationContentAvailabilityEventV1 = {
  type: "content_availability_changed";
  available: boolean;
  observedAt: string;
};

export type OperationEventV1 =
  | OperationCreatedEventV1
  | OperationTargetBoundEventV1
  | OperationTargetEstablishedEventV1
  | OperationOwnershipBaselineEventV1
  | OperationSubmissionWitnessEventV1
  | OperationActionIntentEventV1
  | OperationActionPreparedEventV1
  | OperationArtifactTransferIntentEventV1
  | OperationArtifactTransferReceiptEventV1
  | OperationActionReceiptEventV1
  | OperationPhaseChangedEventV1
  | OperationBlockerObservedEventV1
  | OperationReceiptCompletedEventV1
  | OperationContentAvailabilityEventV1;

export type OperationEventEnvelopeV1 = {
  schemaVersion: typeof OPERATION_EVENT_SCHEMA_VERSION;
  revision: number;
  previousEventDigest: string;
  eventDigest: string;
  event: OperationEventV1;
};

export type OperationJournalSnapshotV1 = {
  schemaVersion: typeof OPERATION_SCHEMA_VERSION;
  lastEventDigest: string;
  state: OperationStateV1;
};

export type OperationRequestIdentityInput = {
  operationId: string;
  surface: OperationSurface;
  target: unknown;
  prompt: string;
  configuration?: unknown;
  tools?: unknown;
  files?: Array<{
    displayName: string;
    bytes: number;
    contentSha256: string;
  }>;
  capturePolicy?: unknown;
  behavior?: unknown;
};
