import { describe, expect, it } from "vitest";
import {
  OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
  OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION,
  OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION,
  OPERATION_ATTACHMENT_REARM_SCHEMA_VERSION,
  OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
  type OperationEventV1,
  type OperationArtifactReceiptV1,
  type OperationArtifactTransferIntentV1,
  type OperationArtifactTransferReceiptV1,
  type MutationBoundary,
  type OperationPhase,
  type OperationSubmissionWitnessV1,
  type OperationTargetBindingV1
} from "../../src/operations/types.js";
import { assertOperationStateShape, OperationStateError, reduceOperationEvents } from "../../src/operations/state-machine.js";
import { TURN_OWNERSHIP_SCHEMA_VERSION } from "../../src/operations/turn-ownership.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const SEND_ID = "22222222-2222-4222-8222-222222222222";
const HANDOFF_ID = "33333333-3333-4333-8333-333333333333";
const STEER_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_STEER_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const ACTION_DIGEST = `hmac-sha256:${"b".repeat(64)}`;
const EVIDENCE_DIGEST = `hmac-sha256:${"c".repeat(64)}`;
const AT = "2026-08-16T12:00:00.000Z";

const TARGET: OperationTargetBindingV1 = {
  providerId: "codex-chrome",
  browserId: "extension",
  tabId: "tab-1",
  coordinationScope: "process",
  canonicalThreadUrl: "https://chatgpt.com/c/example",
  conversationId: "example",
  evidenceProfile: {
    providerIdentity: "required",
    stableTabId: "required",
    stableConversationId: "required",
    stableUserTurnId: "required",
    authoritativeTabClaim: "unavailable",
    replacementTabRecovery: true
  }
};

const NEW_PENDING_TARGET: OperationTargetBindingV1 = {
  providerId: "codex-chrome",
  browserId: "extension",
  tabId: "tab-new",
  coordinationScope: "process",
  evidenceProfile: {
    providerIdentity: "required",
    stableTabId: "required",
    stableConversationId: "unavailable",
    stableUserTurnId: "unavailable",
    authoritativeTabClaim: "unavailable",
    replacementTabRecovery: false
  },
  targetLifecycle: "new_pending",
  newTargetAnchorDigest: EVIDENCE_DIGEST,
  blankTaskEvidenceDigest: EVIDENCE_DIGEST
};

describe("operation state machine", () => {
  it("persists a closed path-free capture policy across event and state round-trips", () => {
    const defaultState = reduceOperationEvents([created()]);
    expect(defaultState.capturePolicy).toEqual({
      responseContent: "include",
      responseFormat: "markdown",
      artifacts: "receipt_only"
    });
    expect(defaultState.responseFormat).toBe("markdown");

    const transferEvent = created();
    transferEvent.capturePolicy = {
      responseContent: "metadata",
      responseFormat: "text",
      artifacts: "transfer"
    };
    const transferState = reduceOperationEvents([transferEvent]);
    expect(transferState.capturePolicy).toEqual(transferEvent.capturePolicy);
    expect(JSON.stringify(transferState)).not.toContain("outputDirectory");
    expect(JSON.stringify(transferState)).not.toContain("/private/");

    const restarted = reduceOperationEvents(JSON.parse(JSON.stringify([transferEvent])) as OperationEventV1[]);
    expect(restarted.capturePolicy).toEqual(transferState.capturePolicy);
  });

  it("rejects unknown, null, and accessor-backed durable policy fields", () => {
    const unknown = created();
    (unknown.capturePolicy as Record<string, unknown>).outputDirectory = "/private/secret";
    expect(() => reduceOperationEvents([unknown])).toThrow(/unsupported field/);

    const explicitNull = created();
    (explicitNull.capturePolicy as Record<string, unknown>).responseFormat = null;
    expect(() => reduceOperationEvents([explicitNull])).toThrow(/responseFormat is invalid/);

    const accessor = created();
    Object.defineProperty(accessor.capturePolicy, "responseFormat", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("must not execute"); }
    });
    expect(() => reduceOperationEvents([accessor])).toThrow(/unsafe property/);
  });

  it("accepts a causally proven no-file submit through durable completion", () => {
    const state = reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      ownershipBaseline(),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST),
      submissionWitness(),
      phase("send_pending", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST),
      phase("submitted", "generating", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST),
      phase("generating", "capturing", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST),
      {
        type: "receipt_completed",
        observedAt: AT,
        receipt: {
          schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
          operationId: OPERATION_ID,
          requestDigest: REQUEST_DIGEST,
          targetBindingDigest: EVIDENCE_DIGEST,
          userTurnId: "user-turn-1",
          userTurnEvidenceDigest: EVIDENCE_DIGEST,
          assistantTurnId: "assistant-turn-1",
          ownershipEvidenceDigest: EVIDENCE_DIGEST,
          responseDigest: EVIDENCE_DIGEST,
          responseBytes: 12,
          responseFormat: "markdown",
          finishReason: "stop",
          contentAvailable: true,
          artifacts: [],
          completedAt: AT
        }
      }
    ]);

    expect(state.phase).toBe("completed");
    expect(state.mutationBoundary).toBe("send_may_have_occurred");
    expect(state.actions[SEND_ID]).toMatchObject({ outcome: "satisfied", receiptRevision: 7 });
    expect(state.receipt?.assistantTurnId).toBe("assistant-turn-1");
    expect(state.revision).toBe(12);
  });

  it("fails closed when a satisfied Send receipt lacks its keyed ownership proof", () => {
    const receiptOnly = [
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST)
    ] satisfies OperationEventV1[];

    expect(() => reduceOperationEvents([
      ...receiptOnly,
      phase("send_pending", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST)
    ])).toThrow(/keyed pre-Send ownership baseline/);

    const baselineOnly = [...receiptOnly.slice(0, 4), ownershipBaseline(), ...receiptOnly.slice(4)];
    expect(() => reduceOperationEvents([
      ...baselineOnly,
      phase("send_pending", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST)
    ])).toThrow(/keyed original Send submission witness/);

    const proven = reduceOperationEvents(terminalPrefix());
    const legacyProjectionOnly = structuredClone(proven);
    delete legacyProjectionOnly.ownershipBaselines;
    delete legacyProjectionOnly.submissionWitnesses;
    expect(() => assertOperationStateShape(legacyProjectionOnly)).toThrow(/keyed pre-Send ownership baseline/);
  });

  it("requires one file handoff intent and satisfied receipt before ready", () => {
    const valid = [
      created(),
      targetBound(),
      actionIntent(HANDOFF_ID, "file_handoff", "observe_only_after_intent"),
      phase("prepared", "handoff_pending", "handoff_may_have_occurred", HANDOFF_ID),
      actionReceipt(HANDOFF_ID, "satisfied", EVIDENCE_DIGEST),
      phase("handoff_pending", "ready", "handoff_may_have_occurred", HANDOFF_ID, EVIDENCE_DIGEST)
    ] satisfies OperationEventV1[];

    expect(reduceOperationEvents(valid).phase).toBe("ready");
    expect(() => reduceOperationEvents(valid.slice(0, 4).concat([
      phase("handoff_pending", "ready", "handoff_may_have_occurred", HANDOFF_ID, EVIDENCE_DIGEST)
    ]))).toThrowError(OperationStateError);
  });

  it("rejects repeat-policy lies and duplicate non-repeatable intent", () => {
    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      actionIntent(SEND_ID, "send", "reconcile_set_to_value")
    ])).toThrow(/requires observe_only_after_intent/);

    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      actionIntent(SEND_ID, "send", "observe_only_after_intent")
    ])).toThrow(/already has an intent/);
  });

  it("never permits mutation-boundary or phase regression", () => {
    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      phase("send_pending", "uncertain", "none", SEND_ID)
    ])).toThrow(/preserve the durable mutation boundary/);

    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      phase("ready", "prepared", "none")
    ])).toThrow(/Illegal operation transition/);
  });

  it("requires action-causal evidence to recover from uncertain", () => {
    const prefix = [
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      ownershipBaseline(),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      phase("send_pending", "uncertain", "send_may_have_occurred", SEND_ID)
    ] satisfies OperationEventV1[];

    expect(() => reduceOperationEvents(prefix.concat([
      phase("uncertain", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST)
    ]))).toThrow(/satisfied causal action/);

    const recovered = reduceOperationEvents(prefix.concat([
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST),
      submissionWitness(),
      phase("uncertain", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST)
    ]));
    expect(recovered.phase).toBe("submitted");
  });

  it("authorizes one supervised attachment rearm while accepting a delayed original receipt", () => {
    const replacement: OperationTargetBindingV1 = {
      ...NEW_PENDING_TARGET,
      tabId: "tab-replacement",
      newTargetAnchorDigest: ACTION_DIGEST,
      blankTaskEvidenceDigest: ACTION_DIGEST
    };
    const prefix = [
      created(),
      { type: "target_bound", target: NEW_PENDING_TARGET, observedAt: AT },
      actionIntent(HANDOFF_ID, "file_handoff", "observe_only_after_intent"),
      phase("prepared", "handoff_pending", "handoff_may_have_occurred", HANDOFF_ID),
      phase("handoff_pending", "uncertain", "handoff_may_have_occurred", HANDOFF_ID),
      {
        type: "blocker_observed",
        blocker: {
          code: "ambiguous_file_handoff",
          messageDigest: EVIDENCE_DIGEST,
          recoverable: false,
          observedAt: AT
        }
      },
      {
        type: "attachment_rearm_authorized",
        authorization: {
          schemaVersion: OPERATION_ATTACHMENT_REARM_SCHEMA_VERSION,
          authorizationId: STEER_ID,
          actionId: HANDOFF_ID,
          previousTargetBindingDigest: EVIDENCE_DIGEST,
          targetBindingDigest: ACTION_DIGEST,
          authorizationEvidenceDigest: EVIDENCE_DIGEST,
          authorizedAt: AT
        },
        target: replacement
      }
    ] satisfies OperationEventV1[];

    const authorized = reduceOperationEvents(prefix);
    expect(authorized.target?.tabId).toBe("tab-replacement");
    expect(authorized.attachmentRearm).toMatchObject({
      authorizationId: STEER_ID,
      actionId: HANDOFF_ID,
      authorizedRevision: 7
    });

    const delayedOriginal = reduceOperationEvents([
      ...prefix,
      actionReceipt(HANDOFF_ID, "satisfied", EVIDENCE_DIGEST),
      phase("uncertain", "ready", "handoff_may_have_occurred", HANDOFF_ID, EVIDENCE_DIGEST)
    ]);
    expect(delayedOriginal.phase).toBe("ready");
    expect(delayedOriginal.attachmentRearm?.attemptIntentRevision).toBeUndefined();

    expect(() => reduceOperationEvents([...prefix, prefix.at(-1)!])).toThrow(/only once/);
    expect(() => reduceOperationEvents([
      ...prefix,
      {
        type: "attachment_rearm_intent",
        authorizationId: STEER_ID,
        actionId: HANDOFF_ID,
        preflightEvidenceDigest: EVIDENCE_DIGEST,
        intentAt: AT
      },
      {
        type: "attachment_rearm_intent",
        authorizationId: STEER_ID,
        actionId: HANDOFF_ID,
        preflightEvidenceDigest: EVIDENCE_DIGEST,
        intentAt: AT
      }
    ])).toThrow(/one unused authorization/);
  });

  it("raises the mutation boundary as soon as a non-repeatable intent is durable", () => {
    const afterIntent = reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent")
    ]);

    expect(afterIntent.phase).toBe("ready");
    expect(afterIntent.mutationBoundary).toBe("send_may_have_occurred");
  });

  it("persists one exact submission witness, accepts identical replay, and rejects drift or missing delta proof", () => {
    const prefix = [
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent")
    ] satisfies OperationEventV1[];
    const witnessPrefix = [...prefix, ownershipBaseline()];
    const state = reduceOperationEvents([...witnessPrefix, submissionWitness()]);
    expect(state.submissionWitness).toMatchObject({
      actionId: SEND_ID,
      actionKind: "send",
      targetBindingDigest: EVIDENCE_DIGEST,
      postSendDeltaDigest: ACTION_DIGEST,
      operationUserEvidenceDigest: EVIDENCE_DIGEST,
      userTurnId: "user-turn-1"
    });
    const replayed = reduceOperationEvents([...witnessPrefix, submissionWitness(), submissionWitness()]);
    expect(replayed.submissionWitnesses?.[SEND_ID]).toEqual(replayed.submissionWitness);

    const conflictingReplay = submissionWitness({ postSendDeltaDigest: EVIDENCE_DIGEST });
    expect(() => reduceOperationEvents([...witnessPrefix, submissionWitness(), conflictingReplay])).toThrow(/conflicts/);

    const wrongTarget = structuredClone(submissionWitness());
    wrongTarget.witness.targetBindingDigest = ACTION_DIGEST;
    expect(() => reduceOperationEvents([...witnessPrefix, wrongTarget])).toThrow(/target does not match/);

    const missingDelta = structuredClone(submissionWitness());
    delete (missingDelta.witness as Partial<OperationSubmissionWitnessV1>).postSendDeltaDigest;
    expect(() => reduceOperationEvents([...witnessPrefix, missingDelta])).toThrow(/required field/);

    expect(() => reduceOperationEvents([
      ...witnessPrefix,
      actionReceipt(SEND_ID, "uncertain", EVIDENCE_DIGEST),
      submissionWitness()
    ])).toThrow(/unsatisfied or uncertain action/);
  });

  it("retains the Send projection while accepting an independently owned Work steer witness", () => {
    const prefix = terminalPrefix().slice(0, -1);
    const steerBaseline = ownershipBaseline();
    steerBaseline.baseline.actionId = STEER_ID;
    steerBaseline.baseline.targetBindingDigest = EVIDENCE_DIGEST;
    steerBaseline.baseline.observedAt = AT;
    const steerWitness = submissionWitness({
      actionId: STEER_ID,
      actionKind: "work_steer",
      postSendDeltaDigest: EVIDENCE_DIGEST,
      operationUserEvidenceDigest: ACTION_DIGEST,
      userTurnId: "user-turn-steer"
    });
    steerWitness.witness.actionKind = "work_steer";

    const state = reduceOperationEvents([
      ...prefix,
      actionIntent(STEER_ID, "work_steer", "observe_only_after_intent", SEND_ID),
      steerBaseline,
      steerWitness
    ]);

    expect(Object.keys(state.submissionWitnesses ?? {})).toEqual([SEND_ID, STEER_ID]);
    expect(state.submissionWitness).toEqual(state.submissionWitnesses?.[SEND_ID]);
    expect(state.submissionWitnesses?.[STEER_ID]).toMatchObject({
      actionId: STEER_ID,
      actionKind: "work_steer",
      userTurnId: "user-turn-steer"
    });
  });

  it("rejects keyed witness conflicts, mismatches, and steer-only terminal causality", () => {
    const prefix = terminalPrefix().slice(0, -1);
    const steerBaseline = ownershipBaseline();
    steerBaseline.baseline.actionId = STEER_ID;
    const steerWitness = submissionWitness({
      actionId: STEER_ID,
      actionKind: "work_steer",
      postSendDeltaDigest: EVIDENCE_DIGEST,
      operationUserEvidenceDigest: ACTION_DIGEST,
      userTurnId: "user-turn-steer"
    });
    steerWitness.witness.actionKind = "work_steer";

    const valid = reduceOperationEvents([
      ...prefix,
      actionIntent(STEER_ID, "work_steer", "observe_only_after_intent", SEND_ID),
      steerBaseline,
      steerWitness
    ]);
    const mismatchedKey = structuredClone(valid) as typeof valid & { submissionWitnesses: Record<string, OperationSubmissionWitnessV1> };
    mismatchedKey.submissionWitnesses[SECOND_STEER_ID] = mismatchedKey.submissionWitnesses[STEER_ID]!;
    delete mismatchedKey.submissionWitnesses[STEER_ID];
    expect(() => assertOperationStateShape(mismatchedKey)).toThrow(/map key must match/);

    const projectionMismatch = structuredClone(valid);
    projectionMismatch.submissionWitness = {
      ...projectionMismatch.submissionWitness!,
      postSendDeltaDigest: EVIDENCE_DIGEST
    };
    expect(() => assertOperationStateShape(projectionMismatch)).toThrow(/projection/);

    const steerOnly = structuredClone(valid);
    const actions = { ...steerOnly.actions };
    delete actions[SEND_ID];
    steerOnly.actions = actions;
    delete steerOnly.submissionWitness;
    steerOnly.submissionWitnesses = { [STEER_ID]: steerOnly.submissionWitnesses![STEER_ID]! };
    expect(() => assertOperationStateShape(steerOnly)).toThrow(/original Send intent|parent is not present/);
  });

  it("accepts only the narrowly redacted Work URL while retaining strict target identity checks", () => {
    const workPrefix = terminalPrefix().slice(0, -1);
    const redactedWorkBaseline = ownershipBaseline();
    redactedWorkBaseline.baseline.actionId = STEER_ID;
    redactedWorkBaseline.baseline.baseline = {
      ...redactedWorkBaseline.baseline.baseline,
      target: {
        ...redactedWorkBaseline.baseline.baseline.target,
        canonicalThreadUrl: { status: "unavailable", reason: "redacted" }
      }
    };

    const accepted = reduceOperationEvents([
      ...workPrefix,
      actionIntent(STEER_ID, "work_steer", "observe_only_after_intent", SEND_ID),
      redactedWorkBaseline
    ]);
    expect(accepted.ownershipBaselines?.[STEER_ID]?.baseline.target.canonicalThreadUrl).toEqual({
      status: "unavailable",
      reason: "redacted"
    });

    const redactedSendBaseline = ownershipBaseline();
    redactedSendBaseline.baseline.baseline = {
      ...redactedSendBaseline.baseline.baseline,
      target: {
        ...redactedSendBaseline.baseline.baseline.target,
        canonicalThreadUrl: { status: "unavailable", reason: "redacted" }
      }
    };
    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      redactedSendBaseline
    ])).toThrow(/target evidence disagrees/);

    const mismatchedWorkBaseline = (
      target: Partial<typeof redactedWorkBaseline.baseline.baseline.target>
    ) => {
      const event = structuredClone(redactedWorkBaseline);
      event.baseline.baseline = {
        ...event.baseline.baseline,
        target: {
          ...event.baseline.baseline.target,
          ...target
        }
      };
      return event;
    };
    for (const mismatch of [
      { provider: { status: "available" as const, value: "provider-other" } },
      { browser: { status: "available" as const, value: "browser-other" } },
      { tab: { status: "available" as const, value: "tab-other" } },
      { conversation: { status: "available" as const, value: "conversation-other" } },
      { coordinationScope: "provider" as const, authoritativeTabClaim: { status: "available" as const, value: "claim-1" } },
      { canonicalThreadUrl: { status: "unavailable" as const, reason: "not_observed" as const } },
      { canonicalThreadUrl: { status: "available" as const, value: "https://chatgpt.com/c/other" } }
    ]) {
      expect(() => reduceOperationEvents([
        ...workPrefix,
        actionIntent(STEER_ID, "work_steer", "observe_only_after_intent", SEND_ID),
        mismatchedWorkBaseline(mismatch)
      ])).toThrow(/target evidence disagrees/);
    }
  });

  it("allows a redacted Work baseline to settle as not_satisfied, but never permits uncertain Work or rejected Send baselines", () => {
    const workPrefix = terminalPrefix().slice(0, -1);
    const workBaseline = ownershipBaseline();
    workBaseline.baseline.actionId = STEER_ID;
    workBaseline.baseline.baseline = {
      ...workBaseline.baseline.baseline,
      target: {
        ...workBaseline.baseline.baseline.target,
        canonicalThreadUrl: { status: "unavailable", reason: "redacted" }
      }
    };
    const workPrepared: Extract<OperationEventV1, { type: "action_prepared" }> = {
      type: "action_prepared",
      action: {
        actionId: STEER_ID,
        kind: "work_steer",
        repeatPolicy: "observe_only_after_intent",
        requestDigest: ACTION_DIGEST,
        targetDigest: EVIDENCE_DIGEST,
        parentActionId: SEND_ID
      },
      intentAt: AT,
      baseline: workBaseline.baseline
    };

    const rejected = reduceOperationEvents([
      ...workPrefix,
      workPrepared,
      actionReceipt(STEER_ID, "not_satisfied")
    ]);
    expect(rejected.actions[STEER_ID]).toMatchObject({ kind: "work_steer", outcome: "not_satisfied" });
    expect(rejected.ownershipBaselines?.[STEER_ID]).toBeDefined();

    const uncertainWork = reduceOperationEvents([
      ...workPrefix,
      workPrepared,
      actionReceipt(STEER_ID, "uncertain")
    ]);
    expect(() => assertOperationStateShape(uncertainWork)).toThrow(/uncertain or rejected/);

    const sendBaseline = ownershipBaseline();
    const sendPrepared: Extract<OperationEventV1, { type: "action_prepared" }> = {
      type: "action_prepared",
      action: {
        actionId: SEND_ID,
        kind: "send",
        repeatPolicy: "observe_only_after_intent",
        requestDigest: REQUEST_DIGEST,
        targetDigest: EVIDENCE_DIGEST
      },
      intentAt: AT,
      baseline: sendBaseline.baseline
    };
    const rejectedSend = reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      sendPrepared,
      actionReceipt(SEND_ID, "not_satisfied")
    ]);
    expect(() => assertOperationStateShape(rejectedSend)).toThrow(/uncertain or rejected/);
  });

  it("rejects actions outside their legal phase and a second non-repeatable action ID", () => {
    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      actionIntent(SEND_ID, "send", "observe_only_after_intent")
    ])).toThrow(/cannot begin while the operation is prepared/);

    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      actionIntent("55555555-5555-4555-8555-555555555555", "send", "observe_only_after_intent")
    ])).toThrow(/already contains a non-repeatable send intent/);
  });

  it("allows distinct caller-owned controls while preserving one original Send", () => {
    const generating = terminalPrefix().slice(0, -1);
    const state = reduceOperationEvents([
      ...generating,
      actionIntent(STEER_ID, "work_steer", "observe_only_after_intent", SEND_ID),
      actionReceipt(STEER_ID, "satisfied", EVIDENCE_DIGEST),
      actionIntent(SECOND_STEER_ID, "work_steer", "observe_only_after_intent", SEND_ID)
    ]);

    expect(state.actions[STEER_ID]).toMatchObject({ kind: "work_steer", outcome: "satisfied" });
    expect(state.actions[SECOND_STEER_ID]).toMatchObject({ kind: "work_steer", parentActionId: SEND_ID });
    expect(state.phase).toBe("generating");
    expect(state.mutationBoundary).toBe("control_may_have_occurred");
  });

  it("never accepts a control action as proof of the original submission", () => {
    const withControl = reduceOperationEvents([
      ...terminalPrefix().slice(0, -1),
      actionIntent(STEER_ID, "work_steer", "observe_only_after_intent", SEND_ID)
    ]);
    const actions = { ...withControl.actions };
    delete actions[SEND_ID];
    const controlWithoutParent = { ...actions[STEER_ID]! };
    delete controlWithoutParent.parentActionId;
    actions[STEER_ID] = controlWithoutParent;

    const ownershipBaselines = { ...withControl.ownershipBaselines };
    const submissionWitnesses = { ...withControl.submissionWitnesses };
    delete ownershipBaselines[SEND_ID];
    delete submissionWitnesses[SEND_ID];
    expect(() => assertOperationStateShape({
      ...withControl,
      actions,
      ownershipBaselines,
      submissionWitnesses,
      ownershipBaseline: undefined,
      submissionWitness: undefined
    })).toThrow(/original Send intent/);

    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(STEER_ID, "work_steer", "observe_only_after_intent"),
      phase("ready", "send_pending", "control_may_have_occurred", STEER_ID)
    ])).toThrow(/cannot begin while the operation is ready|requires a send/);
  });

  it("permits terminal recovery from uncertain only after the original Send is durably satisfied", () => {
    const prefix = [
      created(),
      targetBound(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      ownershipBaseline(),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      phase("send_pending", "uncertain", "send_may_have_occurred", SEND_ID)
    ] satisfies OperationEventV1[];
    const terminal: OperationEventV1 = {
      type: "receipt_completed",
      observedAt: AT,
      receipt: {
        schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        targetBindingDigest: EVIDENCE_DIGEST,
        userTurnId: "user-recovered",
        userTurnEvidenceDigest: EVIDENCE_DIGEST,
        assistantTurnId: "assistant-recovered",
        ownershipEvidenceDigest: EVIDENCE_DIGEST,
        finishReason: "unknown",
        responseFormat: "markdown",
        contentAvailable: false,
        artifacts: [],
        completedAt: AT
      }
    };
    expect(() => reduceOperationEvents([...prefix, terminal])).toThrow(/satisfied original Send/);
    expect(reduceOperationEvents([
      ...prefix,
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST),
      submissionWitness(),
      terminal
    ]).phase).toBe("completed");

    const missingEvidence = structuredClone(terminal) as Extract<OperationEventV1, { type: "receipt_completed" }>;
    delete (missingEvidence.receipt as Partial<typeof missingEvidence.receipt>).ownershipEvidenceDigest;
    expect(() => reduceOperationEvents([
      ...prefix,
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST),
      submissionWitness(),
      missingEvidence
    ])).toThrow(/ownershipEvidenceDigest/);
  });

  it("does not let an unrelated satisfied action authorize post-Send recovery", () => {
    // Exercise the transition reducer with a structurally plausible satisfied
    // non-Send action as the cited cause. The exact action kind, not merely a
    // satisfied outcome elsewhere in the ledger, must authorize recovery.
    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      actionIntent(HANDOFF_ID, "file_handoff", "observe_only_after_intent"),
      phase("prepared", "handoff_pending", "handoff_may_have_occurred", HANDOFF_ID),
      actionReceipt(HANDOFF_ID, "satisfied", EVIDENCE_DIGEST),
      phase("handoff_pending", "ready", "handoff_may_have_occurred", HANDOFF_ID, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      phase("send_pending", "uncertain", "send_may_have_occurred", SEND_ID),
      phase("uncertain", "capturing", "send_may_have_occurred", HANDOFF_ID, EVIDENCE_DIGEST)
    ])).toThrow(/requires send with satisfied receipt/);
  });

  it("does not advance browser phases before binding an exact target", () => {
    expect(() => reduceOperationEvents([
      created(),
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST)
    ])).toThrow(/target binding/);
  });

  it("keeps target binding immutable", () => {
    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      { type: "target_bound", target: { ...TARGET, tabId: "tab-2" }, observedAt: AT }
    ])).toThrow(/target binding is immutable/);
  });

  it("establishes a new target exactly once after the durable Send intent while preserving the pending lifecycle", () => {
    const prefix = [
      created(),
      { type: "target_bound", target: NEW_PENDING_TARGET, observedAt: AT } satisfies OperationEventV1,
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      newTargetOwnershipBaseline(),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST)
    ] satisfies OperationEventV1[];

    const pending = reduceOperationEvents(prefix);
    expect(pending.target?.targetLifecycle).toBe("new_pending");
    expect(() => reduceOperationEvents([...prefix, phase("send_pending", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST)]))
      .toThrow(/pending new target/);

    const established = reduceOperationEvents([
      ...prefix,
      targetEstablished(),
      newTargetSubmissionWitness(),
      phase("send_pending", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST)
    ]);
    expect(established.target?.targetLifecycle).toBe("new_established");
    expect(established.target?.conversationId).toBe("conversation-new");
    expect(established.target?.targetEstablishment?.userTurnId).toBe("user-new");
    expect(established.phase).toBe("submitted");
    expect(() => reduceOperationEvents([...prefix, targetEstablished(), targetEstablished()])).toThrow(/only once/);
  });

  it("rejects new-target establishment before Send, on fixed targets, and for conflicting identity evidence", () => {
    expect(() => reduceOperationEvents([
      created(),
      { type: "target_bound", target: NEW_PENDING_TARGET, observedAt: AT } satisfies OperationEventV1,
      targetEstablished()
    ])).toThrow(/causal original Send intent/);

    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      targetEstablished()
    ])).toThrow(/fixed target/);

    const prefix = [
      created(),
      { type: "target_bound", target: NEW_PENDING_TARGET, observedAt: AT } satisfies OperationEventV1,
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST),
      targetEstablished()
    ] satisfies OperationEventV1[];
    const conflict = structuredClone(targetEstablished());
    conflict.establishment.conversationId = "conversation-other";
    expect(() => reduceOperationEvents([...prefix, conflict])).toThrow(/only once/);
  });

  it("validates new-target anchor, URL, user-turn, evidence, action, and timestamp fields", () => {
    const malformed = structuredClone(NEW_PENDING_TARGET);
    delete malformed.blankTaskEvidenceDigest;
    expect(() => reduceOperationEvents([
      created(),
      { type: "target_bound", target: malformed, observedAt: AT } satisfies OperationEventV1
    ])).toThrow(/blank-task evidence/);

    const prefix = [
      created(),
      { type: "target_bound", target: NEW_PENDING_TARGET, observedAt: AT } satisfies OperationEventV1,
      phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
      actionIntent(SEND_ID, "send", "observe_only_after_intent"),
      phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
      actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST)
    ] satisfies OperationEventV1[];
    const invalidUrl = structuredClone(targetEstablished());
    invalidUrl.establishment.canonicalThreadUrl = "http://chatgpt.com/c/conversation-new";
    expect(() => reduceOperationEvents([...prefix, invalidUrl])).toThrow(/canonical HTTPS/);
    const invalidEvidence = structuredClone(targetEstablished());
    invalidEvidence.establishment.evidenceDigest = "not-a-digest";
    expect(() => reduceOperationEvents([...prefix, invalidEvidence])).toThrow(/canonical lowercase/);
    const invalidAction = structuredClone(targetEstablished());
    invalidAction.establishment.causalSendActionId = STEER_ID;
    expect(() => reduceOperationEvents([...prefix, invalidAction])).toThrow(/causal original Send/);
    const beforeSend = structuredClone(targetEstablished());
    beforeSend.establishment.observedAt = "2026-08-16T11:59:59.000Z";
    expect(() => reduceOperationEvents([...prefix, beforeSend])).toThrow(/cannot precede/);
  });

  it("requires canonical UUID operation and action identifiers", () => {
    expect(() => reduceOperationEvents([{ ...created(), operationId: "descriptive-name" }])).toThrow(/canonical UUID/);
    expect(() => reduceOperationEvents([
      created(),
      targetBound(),
      actionIntent("not-an-id", "send", "observe_only_after_intent")
    ])).toThrow(/canonical UUID/);
  });

  it("rejects non-canonical digests and impossible canonical-looking timestamps", () => {
    expect(() => reduceOperationEvents([{ ...created(), requestDigest: `hmac-sha256:${"A".repeat(64)}` }])).toThrow(/canonical lowercase/);
    expect(() => reduceOperationEvents([{ ...created(), createdAt: "2026-02-31T12:00:00.000Z" }])).toThrow(/canonical UTC/);
  });

  it("requires paired terminal response metadata whenever content is available", () => {
    const missingBytes = terminalReceipt();
    delete (missingBytes.receipt as Partial<typeof missingBytes.receipt>).responseBytes;
    expect(() => reduceOperationEvents([...terminalPrefix(), missingBytes])).toThrow(/digest and byte count must be paired/);

    const unavailable = terminalReceipt();
    unavailable.receipt.contentAvailable = false;
    delete (unavailable.receipt as Partial<typeof unavailable.receipt>).responseDigest;
    delete (unavailable.receipt as Partial<typeof unavailable.receipt>).responseBytes;
    expect(reduceOperationEvents([...terminalPrefix(), unavailable]).phase).toBe("completed");
  });

  it("validates bounded, operation-owned artifact receipts and status branches", () => {
    const transferIntent = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const transferReceipt = artifactTransferReceipt(transferIntent.intent);
    const event = terminalReceipt();
    event.receipt.artifacts = [{
      schemaVersion: OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      artifactKey: "artifact-0",
      assistantTurnId: "assistant-turn-1",
      sourceIdentityDigest: transferIntent.intent.sourceIdentityDigest,
      kind: "file",
      ordinal: 0,
      outputKey: transferReceipt.receipt.outputKey!,
      bytes: transferReceipt.receipt.bytes!,
      sha256: transferReceipt.receipt.sha256!,
      status: "transferred"
    }];
    expect(reduceOperationEvents([...transferPolicyPrefix(), transferIntent, transferReceipt, event]).receipt?.artifacts).toHaveLength(1);

    const uppercaseHash = structuredClone(event);
    uppercaseHash.receipt.artifacts[0]!.sha256 = "D".repeat(64);
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), transferIntent, transferReceipt, uppercaseHash])).toThrow(/lowercase hexadecimal/);

    const blockerOnSuccess = structuredClone(event);
    blockerOnSuccess.receipt.artifacts[0]!.blockerCode = "artifact_unavailable";
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), transferIntent, transferReceipt, blockerOnSuccess])).toThrow(/cannot contain a blockerCode/);
  });

  it("atomically records path-free transfer intent and receipt in the generic action ledger", () => {
    const intent = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const receipt = artifactTransferReceipt(intent.intent);
    const events = [...transferPolicyPrefix(), intent, receipt] satisfies OperationEventV1[];
    const state = reduceOperationEvents(events);

    expect(state.artifactTransfers?.[intent.intent.transferActionId]).toEqual({
      intent: intent.intent,
      receipt: receipt.receipt
    });
    expect(state.actions[intent.intent.transferActionId]).toMatchObject({
      kind: "local_output_commit",
      repeatPolicy: "reconcile_local_effect",
      intentRevision: 12,
      receiptRevision: 13,
      outcome: "satisfied",
      evidenceDigest: intent.intent.destinationIdentityDigest
    });
    expect(JSON.stringify(state)).not.toContain("outputDirectory");
    expect(JSON.stringify(state)).not.toContain("/private/");

    const restarted = reduceOperationEvents(JSON.parse(JSON.stringify(events)) as OperationEventV1[]);
    expect(restarted).toEqual(state);
  });

  it("maps collision and uncertain transfer receipts without weakening generic action semantics", () => {
    const collisionIntent = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const collisionReceipt = artifactTransferReceipt(collisionIntent.intent, {
      status: "blocked",
      blockerCode: "output_collision"
    });
    const collision = reduceOperationEvents([...transferPolicyPrefix(), collisionIntent, collisionReceipt]);
    expect(collision.actions[collisionIntent.intent.transferActionId]).toMatchObject({
      outcome: "not_satisfied",
      blockerCode: "output_collision"
    });

    const uncertainIntent = artifactTransferIntent("77777777-7777-4777-8777-777777777777", {
      ordinal: 1,
      kind: "image",
      sourceIdentityDigest: `hmac-sha256:${"d".repeat(64)}`,
      destinationIdentityDigest: `hmac-sha256:${"e".repeat(64)}`
    });
    const uncertainReceipt = artifactTransferReceipt(uncertainIntent.intent, {
      status: "partial",
      blockerCode: "artifact_transfer_partial"
    });
    const uncertain = reduceOperationEvents([
      ...transferPolicyPrefix(),
      collisionIntent,
      collisionReceipt,
      uncertainIntent,
      uncertainReceipt
    ]);
    expect(uncertain.actions[uncertainIntent.intent.transferActionId]).toMatchObject({
      outcome: "uncertain",
      blockerCode: "artifact_transfer_partial"
    });
  });

  it("allows distinct artifacts, rejects duplicate artifact destinations, and requires intent before receipt", () => {
    const first = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const distinct = artifactTransferIntent("77777777-7777-4777-8777-777777777777", {
      ordinal: 1,
      kind: "image",
      sourceIdentityDigest: `hmac-sha256:${"d".repeat(64)}`
    });
    expect(reduceOperationEvents([...transferPolicyPrefix(), first, distinct]).artifactTransfers).toHaveProperty("77777777-7777-4777-8777-777777777777");

    const duplicateTuple = structuredClone(first);
    duplicateTuple.intent = {
      ...duplicateTuple.intent,
      transferActionId: "88888888-8888-4888-8888-888888888888"
    };
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), first, duplicateTuple])).toThrow(/tuple/);

    const receiptWithoutIntent = artifactTransferReceipt(first.intent);
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), receiptWithoutIntent])).toThrow(/requires its durable intent/);
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), first, artifactTransferReceipt(first.intent), artifactTransferReceipt(first.intent)])).toThrow(/already durable/);
  });

  it("fails closed on transfer identity drift, private fields, accessors, and generic action mismatch", () => {
    const valid = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const wrongTarget = structuredClone(valid);
    wrongTarget.intent = { ...wrongTarget.intent, targetBindingDigest: ACTION_DIGEST };
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), wrongTarget])).toThrow(/targetBindingDigest|target.*mismatch/);

    const wrongReceipt = artifactTransferReceipt(valid.intent);
    wrongReceipt.receipt = { ...wrongReceipt.receipt, requestDigest: ACTION_DIGEST };
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), valid, wrongReceipt])).toThrow(/identity/);

    const wrongOutputKey = artifactTransferReceipt(valid.intent);
    wrongOutputKey.receipt = { ...wrongOutputKey.receipt, outputKey: 12 as unknown as string };
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), valid, wrongOutputKey])).toThrow(/outputKey/);

    const privateField = structuredClone(valid);
    (privateField.intent as unknown as Record<string, unknown>).outputDirectory = "/private/secret";
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), privateField])).toThrow(/unsupported field/);

    const accessor = structuredClone(valid);
    Object.defineProperty(accessor.intent, "destinationIdentityDigest", {
      enumerable: true,
      configurable: true,
      get: () => { throw new Error("must not execute"); }
    });
    expect(() => reduceOperationEvents([...transferPolicyPrefix(), accessor])).toThrow(/unsafe property/);

    const state = reduceOperationEvents([...transferPolicyPrefix(), valid]);
    const actions = { ...state.actions, [valid.intent.transferActionId]: {
      ...state.actions[valid.intent.transferActionId]!,
      kind: "download" as const
    } };
    expect(() => assertOperationStateShape({ ...state, actions })).toThrow(/generic local-output action/);
  });

  it("requires a one-to-one settled transfer witness before transfer-policy completion", () => {
    const transferredIntent = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const transferredReceipt = artifactTransferReceipt(transferredIntent.intent);
    const transferredArtifact = terminalArtifactForTransfer(transferredIntent.intent, transferredReceipt.receipt);

    expect(reduceOperationEvents([
      ...transferPolicyPrefix(),
      transferredIntent,
      transferredReceipt,
      terminalReceiptWithArtifacts([transferredArtifact])
    ]).phase).toBe("completed");

    expect(reduceOperationEvents([
      ...transferPolicyPrefix(),
      terminalReceiptWithArtifacts([])
    ]).phase).toBe("completed");

    const partialIntent = artifactTransferIntent("77777777-7777-4777-8777-777777777777", {
      ordinal: 1,
      kind: "image",
      sourceIdentityDigest: `hmac-sha256:${"d".repeat(64)}`,
      destinationIdentityDigest: `hmac-sha256:${"e".repeat(64)}`
    });
    const partialReceipt = artifactTransferReceipt(partialIntent.intent, {
      status: "partial",
      blockerCode: "artifact_transfer_partial"
    });
    expect(reduceOperationEvents([
      ...transferPolicyPrefix(),
      partialIntent,
      partialReceipt,
      terminalReceiptWithArtifacts([terminalArtifactForTransfer(partialIntent.intent, partialReceipt.receipt)])
    ]).phase).toBe("completed");

    const blockedIntent = artifactTransferIntent("88888888-8888-4888-8888-888888888888", {
      ordinal: 2,
      sourceIdentityDigest: `hmac-sha256:${"f".repeat(64)}`,
      destinationIdentityDigest: `hmac-sha256:${"0".repeat(64)}`
    });
    const blockedReceipt = artifactTransferReceipt(blockedIntent.intent, {
      status: "blocked",
      blockerCode: "output_collision"
    });
    expect(reduceOperationEvents([
      ...transferPolicyPrefix(),
      blockedIntent,
      blockedReceipt,
      terminalReceiptWithArtifacts([terminalArtifactForTransfer(blockedIntent.intent, blockedReceipt.receipt)])
    ]).phase).toBe("completed");
  });

  it("rejects missing, unsettled, extra, duplicate, and altered transfer obligations", () => {
    const intent = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const receipt = artifactTransferReceipt(intent.intent);
    const artifact = terminalArtifactForTransfer(intent.intent, receipt.receipt);

    expect(() => reduceOperationEvents([
      ...transferPolicyPrefix(),
      terminalReceiptWithArtifacts([artifact])
    ])).toThrow(/matching durable transfer receipt/);
    expect(() => reduceOperationEvents([
      ...transferPolicyPrefix(),
      intent,
      terminalReceiptWithArtifacts([artifact])
    ])).toThrow(/no durable receipt/);
    expect(() => reduceOperationEvents([
      ...transferPolicyPrefix(),
      intent,
      receipt,
      terminalReceiptWithArtifacts([])
    ])).toThrow(/matching terminal artifact/);

    const duplicateDestination = artifactTransferIntent("77777777-7777-4777-8777-777777777777", {
      destinationIdentityDigest: `hmac-sha256:${"0".repeat(64)}`
    });
    const duplicateDestinationReceipt = artifactTransferReceipt(duplicateDestination.intent);
    expect(() => reduceOperationEvents([
      ...transferPolicyPrefix(),
      intent,
      receipt,
      duplicateDestination,
      duplicateDestinationReceipt,
      terminalReceiptWithArtifacts([artifact])
    ])).toThrow(/one.*settled transfer per exact artifact identity/);

    const altered = terminalArtifactForTransfer(intent.intent, receipt.receipt);
    altered.outputKey = "different-output-key";
    expect(() => reduceOperationEvents([
      ...transferPolicyPrefix(),
      intent,
      receipt,
      terminalReceiptWithArtifacts([altered])
    ])).toThrow(/facts must match exactly/);

    const available = { ...artifact, status: "available" as const };
    expect(() => reduceOperationEvents([
      ...transferPolicyPrefix(),
      intent,
      receipt,
      terminalReceiptWithArtifacts([available])
    ])).toThrow(/remains available/);
  });

  it("does not let receipt-only completion carry transfer state or enriched artifacts", () => {
    const intent = artifactTransferIntent("66666666-6666-4666-8666-666666666666");
    const receipt = artifactTransferReceipt(intent.intent);
    const transferState = reduceOperationEvents([...transferPolicyPrefix(), intent, receipt]);
    expect(() => assertOperationStateShape({
      ...transferState,
      capturePolicy: { ...transferState.capturePolicy!, artifacts: "receipt_only" }
    })).toThrow(/transfer capture policy/);

    const transferArtifact = terminalArtifactForTransfer(intent.intent, receipt.receipt);
    expect(() => reduceOperationEvents([
      ...terminalPrefix(),
      terminalReceiptWithArtifacts([transferArtifact])
    ])).toThrow(/transfer-enriched artifacts/);
  });

  it("rejects semantically inconsistent authenticated state snapshots", () => {
    const state = reduceOperationEvents([...terminalPrefix(), terminalReceipt()]);
    expect(() => assertOperationStateShape({ ...state, mutationBoundary: "none" })).toThrow(/does not match the durable action ledger/);
    expect(() => assertOperationStateShape({ ...state, phase: "invented" })).toThrow(/phase is unsupported/);
    expect(() => assertOperationStateShape({ ...state, privatePrompt: "must-not-persist" })).toThrow(/unsupported field/);
  });

  it("allows content availability to expire once but never reappear", () => {
    const completed = [...terminalPrefix(), terminalReceipt()] satisfies OperationEventV1[];
    const expired = reduceOperationEvents([...completed, {
      type: "content_availability_changed",
      available: false,
      observedAt: AT
    }]);
    expect(expired.receipt?.contentAvailable).toBe(false);
    expect(() => reduceOperationEvents([...completed,
      { type: "content_availability_changed", available: false, observedAt: AT },
      { type: "content_availability_changed", available: true, observedAt: AT }
    ])).toThrow(/only transition once/);
  });
});

function terminalPrefix(): OperationEventV1[] {
  return [
    created(),
    targetBound(),
    phase("prepared", "ready", "none", undefined, EVIDENCE_DIGEST),
    actionIntent(SEND_ID, "send", "observe_only_after_intent"),
    ownershipBaseline(),
    phase("ready", "send_pending", "send_may_have_occurred", SEND_ID),
    actionReceipt(SEND_ID, "satisfied", EVIDENCE_DIGEST),
    submissionWitness(),
    phase("send_pending", "submitted", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST),
    phase("submitted", "generating", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST),
    phase("generating", "capturing", "send_may_have_occurred", SEND_ID, EVIDENCE_DIGEST)
  ];
}

function transferPolicyPrefix(): OperationEventV1[] {
  const events = terminalPrefix();
  const creation = events[0] as Extract<OperationEventV1, { type: "operation_created" }>;
  creation.capturePolicy = {
    responseContent: "include",
    responseFormat: "markdown",
    artifacts: "transfer"
  };
  return events;
}

function terminalReceipt(): Extract<OperationEventV1, { type: "receipt_completed" }> {
  return {
    type: "receipt_completed",
    observedAt: AT,
    receipt: {
      schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: EVIDENCE_DIGEST,
      userTurnId: "user-turn-1",
      userTurnEvidenceDigest: EVIDENCE_DIGEST,
      assistantTurnId: "assistant-turn-1",
      ownershipEvidenceDigest: EVIDENCE_DIGEST,
      responseDigest: EVIDENCE_DIGEST,
      responseBytes: 12,
      responseFormat: "markdown",
      finishReason: "stop",
      contentAvailable: true,
      artifacts: [],
      completedAt: AT
    }
  };
}

function terminalReceiptWithArtifacts(artifacts: OperationArtifactReceiptV1[]): Extract<OperationEventV1, { type: "receipt_completed" }> {
  const event = terminalReceipt();
  event.receipt.artifacts = artifacts;
  return event;
}

function terminalArtifactForTransfer(
  intent: OperationArtifactTransferIntentV1,
  transfer: OperationArtifactTransferReceiptV1
): OperationArtifactReceiptV1 {
  return {
    schemaVersion: OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
    operationId: intent.operationId,
    artifactKey: `artifact-${intent.ordinal}`,
    assistantTurnId: intent.assistantTurnId,
    sourceIdentityDigest: intent.sourceIdentityDigest,
    kind: intent.kind,
    ordinal: intent.ordinal,
    ...(transfer.outputKey === undefined ? {} : { outputKey: transfer.outputKey }),
    ...(transfer.bytes === undefined ? {} : { bytes: transfer.bytes }),
    ...(transfer.sha256 === undefined ? {} : { sha256: transfer.sha256 }),
    status: transfer.status,
    ...(transfer.blockerCode === undefined ? {} : { blockerCode: transfer.blockerCode })
  };
}

function created(): Extract<OperationEventV1, { type: "operation_created" }> {
  return {
    type: "operation_created",
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    createdAt: AT,
    capturePolicy: {
      responseContent: "include",
      responseFormat: "markdown",
      artifacts: "receipt_only"
    }
  };
}

function targetBound(): Extract<OperationEventV1, { type: "target_bound" }> {
  return { type: "target_bound", target: TARGET, observedAt: AT };
}

function targetEstablished(): Extract<OperationEventV1, { type: "target_established" }> {
  return {
    type: "target_established",
    establishment: {
      targetBindingDigest: EVIDENCE_DIGEST,
      anchorDigest: EVIDENCE_DIGEST,
      causalSendActionId: SEND_ID,
      conversationId: "conversation-new",
      canonicalThreadUrl: "https://chatgpt.com/c/conversation-new",
      userTurnId: "user-new",
      userTurnEvidenceDigest: EVIDENCE_DIGEST,
      postSendDeltaDigest: ACTION_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: AT
    }
  };
}

function actionIntent(
  actionId: string,
  kind: "send" | "file_handoff" | "work_steer",
  repeatPolicy: "observe_only_after_intent" | "reconcile_set_to_value",
  parentActionId?: string
): OperationEventV1 {
  return {
    type: "action_intent",
    action: {
      actionId,
      kind,
      repeatPolicy,
      requestDigest: kind === "work_steer" ? ACTION_DIGEST : REQUEST_DIGEST,
      targetDigest: EVIDENCE_DIGEST,
      ...(parentActionId === undefined ? {} : { parentActionId })
    },
    intentAt: AT
  };
}

function submissionWitness(
  overrides: Partial<OperationSubmissionWitnessV1> = {}
): Extract<OperationEventV1, { type: "submission_witness" }> {
  return {
    type: "submission_witness",
    witness: {
      schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
      actionId: SEND_ID,
      actionKind: "send",
      targetBindingDigest: EVIDENCE_DIGEST,
      baselineSnapshotDigest: EVIDENCE_DIGEST,
      postSendDeltaDigest: ACTION_DIGEST,
      operationUserEvidenceDigest: EVIDENCE_DIGEST,
      userTurnId: "user-turn-1",
      observedAt: AT,
      ...overrides
    }
  };
}

function artifactTransferIntent(
  transferActionId: string,
  overrides: Partial<OperationArtifactTransferIntentV1> = {}
): Extract<OperationEventV1, { type: "artifact_transfer_intent" }> {
  return {
    type: "artifact_transfer_intent",
    intent: {
      schemaVersion: OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: EVIDENCE_DIGEST,
      assistantTurnId: "assistant-turn-1",
      sourceIdentityDigest: ACTION_DIGEST,
      kind: "file",
      ordinal: 0,
      transferActionId,
      destinationIdentityDigest: `hmac-sha256:${"e".repeat(64)}`,
      actionKind: "local_output_commit",
      repeatPolicy: "reconcile_local_effect",
      intentAt: AT,
      ...overrides
    }
  };
}

function artifactTransferReceipt(
  intent: OperationArtifactTransferIntentV1,
  overrides: Partial<OperationArtifactTransferReceiptV1> = {}
): Extract<OperationEventV1, { type: "artifact_transfer_receipt" }> {
  const status = overrides.status ?? "transferred";
  const receipt: OperationArtifactTransferReceiptV1 = {
    schemaVersion: OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION,
    operationId: intent.operationId,
    requestDigest: intent.requestDigest,
    targetBindingDigest: intent.targetBindingDigest,
    assistantTurnId: intent.assistantTurnId,
    sourceIdentityDigest: intent.sourceIdentityDigest,
    kind: intent.kind,
    ordinal: intent.ordinal,
    transferActionId: intent.transferActionId,
    destinationIdentityDigest: intent.destinationIdentityDigest,
    status,
    observedAt: AT,
    ...(status === "transferred" ? {
      outputKey: "artifact-transfer-1",
      bytes: 12,
      sha256: "f".repeat(64)
    } : {
      blockerCode: overrides.blockerCode ?? "artifact_transfer_partial"
    }),
    ...overrides
  };
  return { type: "artifact_transfer_receipt", receipt };
}

function ownershipBaseline(): Extract<OperationEventV1, { type: "ownership_baseline" }> {
  return {
    type: "ownership_baseline",
    baseline: {
      schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: EVIDENCE_DIGEST,
      actionId: SEND_ID,
      baseline: {
        schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
        snapshotDigest: EVIDENCE_DIGEST,
        target: {
          provider: { status: "available", value: TARGET.providerId },
          browser: { status: "available", value: TARGET.browserId },
          tab: { status: "available", value: TARGET.tabId },
          thread: { status: "available", value: TARGET.conversationId! },
          conversation: { status: "available", value: TARGET.conversationId! },
          canonicalThreadUrl: { status: "available", value: TARGET.canonicalThreadUrl! },
          authoritativeTabClaim: { status: "unavailable", reason: "not_exposed" },
          coordinationScope: TARGET.coordinationScope
        },
        userTurns: [],
        assistantTurns: [],
        completeness: "complete"
      },
      observedAt: AT
    }
  };
}

function newTargetOwnershipBaseline(): Extract<OperationEventV1, { type: "ownership_baseline" }> {
  const event = ownershipBaseline();
  event.baseline.baseline = {
    ...event.baseline.baseline,
    target: {
      ...event.baseline.baseline.target,
      tab: { status: "available", value: NEW_PENDING_TARGET.tabId },
      thread: { status: "unavailable", reason: "not_observed" },
      conversation: { status: "unavailable", reason: "not_observed" },
      canonicalThreadUrl: { status: "unavailable", reason: "not_observed" }
    }
  };
  return event;
}

function newTargetSubmissionWitness(): Extract<OperationEventV1, { type: "submission_witness" }> {
  return submissionWitness({
    postSendDeltaDigest: ACTION_DIGEST,
    operationUserEvidenceDigest: EVIDENCE_DIGEST,
    userTurnId: "user-new"
  });
}

function actionReceipt(
  actionId: string,
  outcome: "satisfied" | "not_satisfied" | "uncertain",
  evidenceDigest?: string
): OperationEventV1 {
  const event: OperationEventV1 = { type: "action_receipt", actionId, outcome, observedAt: AT };
  if (event.type === "action_receipt" && evidenceDigest !== undefined) event.evidenceDigest = evidenceDigest;
  return event;
}

function phase(
  from: OperationPhase,
  to: OperationPhase,
  mutationBoundary: MutationBoundary,
  causeActionId?: string,
  evidenceDigest?: string
): OperationEventV1 {
  const event: OperationEventV1 = { type: "phase_changed", from, to, mutationBoundary, observedAt: AT };
  if (event.type === "phase_changed" && causeActionId !== undefined) event.causeActionId = causeActionId;
  if (event.type === "phase_changed" && evidenceDigest !== undefined) event.evidenceDigest = evidenceDigest;
  return event;
}
