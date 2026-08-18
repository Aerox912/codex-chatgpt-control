import { describe, expect, it } from "vitest";
import {
  liveResponseFromText,
  toOperationCollectWireResult,
  toOperationControlWireResult,
  toOperationInspectWireResult,
  toOperationSubmitWireResult,
  validateOperationCollectWireResult,
  validateOperationControlWireResult,
  validateOperationInspectWireResult,
  validateOperationSubmitWireResult,
  type OperationCollectWireResult,
  type OperationControlWireResult,
  type OperationInspectWireResult,
  type OperationSubmitWireResult
} from "../../src/operations/wire-results.js";
import type { CollectorResult } from "../../src/operations/collector.js";
import type { ControlResult } from "../../src/operations/control.js";
import type { OperationInspectResult, OperationSubmitResult } from "../../src/operations/service.js";
import type { OperationControlReceiptV1, OperationHandleV1, OperationReceiptV1, OperationStateV1 } from "../../src/operations/types.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CONTROL_ID = "22222222-2222-4222-8222-222222222222";
const ACTION_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_DIGEST = "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_DIGEST = "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVIDENCE_DIGEST = "hmac-sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const RECEIPT_DIGEST = "hmac-sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INSTANT = "2026-08-16T00:00:03.000Z";

describe("versioned operation wire results", () => {
  it("returns an accepted submit envelope with the fresh handle", () => {
    const result = toOperationSubmitWireResult({ handle: handle(), submission: submitted() });
    expect(result).toMatchObject({ status: "accepted", operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST });
    expect(result.handle).toEqual(handle());
    expect(result).not.toHaveProperty("kind");
    expect(validateOperationSubmitWireResult(result)).toBe(result);
  });

  it("requires a durable receipt before exposing a completed submit result", () => {
    const completed: OperationSubmitResult = { handle: handle({ phase: "completed", revision: 10 }), submission: { ...submitted(), kind: "completed_receipt", assistantTurnId: "assistant-turn-1" } };
    expect(() => toOperationSubmitWireResult(completed)).toThrowError(/durable receipt/);
    const result = toOperationSubmitWireResult(completed, receipt());
    expect(result.status).toBe("completed");
    expect(result.status === "completed" ? result.receipt : undefined).toEqual(receipt());
  });

  it("maps post-intent submission uncertainty to a redacted blocker", () => {
    const result = toOperationSubmitWireResult({
      handle: handle({ phase: "send_pending", mutationBoundary: "send_may_have_occurred" }),
      submission: {
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        targetBindingDigest: TARGET_DIGEST,
        kind: "uncertain",
        blocker: { code: "ambiguous_submit", observationRequired: true, mutationBoundary: "send_may_have_occurred", evidenceDigest: EVIDENCE_DIGEST }
      }
    });
    expect(result.status).toBe("uncertain");
    const blocker = result.status === "uncertain" ? result.blocker : undefined;
    expect(blocker).toMatchObject({ code: "ambiguous_submit", recoverable: true, requestDigest: REQUEST_DIGEST });
    expect(blocker?.message).not.toMatch(/prompt|path|private|secret/i);
  });

  it("preserves a structured blocker and handle before target binding", () => {
    const { targetBindingDigest: _target, ...unboundHandle } = handle({
      revision: 2,
      phase: "prepared",
      mutationBoundary: "none"
    });
    const result = toOperationSubmitWireResult({
      handle: unboundHandle,
      submission: {
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        kind: "blocked",
        blocker: {
          code: "browser_bridge_unavailable",
          observationRequired: true,
          mutationBoundary: "none"
        }
      }
    });

    expect(result).toMatchObject({
      status: "blocked",
      operationId: OPERATION_ID,
      handle: { phase: "prepared", mutationBoundary: "none" },
      blocker: { code: "browser_bridge_unavailable", recoverable: true }
    });
    expect(result.handle).not.toHaveProperty("targetBindingDigest");
    expect(validateOperationSubmitWireResult(result)).toBe(result);
  });

  it("keeps collector raw content in an explicitly ephemeral field only", () => {
    const result = toOperationCollectWireResult(handle({ phase: "completed", revision: 10 }), collectorCompleted(), receipt());
    expect(result.status).toBe("completed");
    const completed = result.status === "completed" ? result : undefined;
    expect(completed?.liveResponse).toMatchObject({ durability: "ephemeral", durable: false, content: "private answer" });
    expect(completed?.receipt).not.toHaveProperty("rawText");
    expect(validateOperationCollectWireResult(result)).toBe(result);
  });

  it("never emits a live response for pending collection", () => {
    const result = toOperationCollectWireResult(handle({ phase: "generating" }), {
      kind: "pending", operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST, targetBindingDigest: TARGET_DIGEST, phase: "generating", mutationBoundary: "send_may_have_occurred", attempts: 1
    });
    expect(result).toEqual({ schemaVersion: "chatgpt.browser_control.operation_collect_result.v1", status: "pending", operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST, handle: handle({ phase: "generating" }) });
  });

  it("derives inspect status from the freshly loaded state and rejects private state fields", () => {
    const state = operationState({ phase: "uncertain" });
    const result = toOperationInspectWireResult({ state, handle: handle({ phase: "uncertain" }) });
    expect(result.status).toBe("uncertain");
    expect(validateOperationInspectWireResult(result)).toBe(result);
    const unsafe = structuredClone(result) as unknown as Record<string, unknown>;
    (unsafe.state as Record<string, unknown>).rawPrompt = "must not cross wire";
    expect(() => validateOperationInspectWireResult(unsafe)).toThrowError(/Unexpected wire field|private/);
  });

  it("accepts a read-compatible established target without a post-Send delta", () => {
    // `targetEstablishmentRead` deliberately keeps the delta optional for
    // older authenticated state.  The submit adapter requires that evidence
    // before a new target is established, but an inspect result must remain
    // able to read a legacy established projection.
    const baseTarget = operationState().target!;
    const establishedState = operationState({
      // `ready` is a real crash boundary: Send may already have a durable
      // intent/receipt and target establishment before the next phase event is
      // appended. `prepared` would be impossible once a Send intent exists.
      phase: "ready",
      mutationBoundary: "send_may_have_occurred",
      target: {
        ...baseTarget,
        targetLifecycle: "new_established",
        newTargetAnchorDigest: EVIDENCE_DIGEST,
        blankTaskEvidenceDigest: RECEIPT_DIGEST,
        evidenceProfile: {
          ...baseTarget.evidenceProfile,
          stableUserTurnId: "required"
        },
        targetEstablishment: {
          targetBindingDigest: TARGET_DIGEST,
          anchorDigest: EVIDENCE_DIGEST,
          causalSendActionId: ACTION_ID,
          conversationId: "conversation-1",
          canonicalThreadUrl: baseTarget.canonicalThreadUrl!,
          userTurnId: "user-turn-1",
          userTurnEvidenceDigest: EVIDENCE_DIGEST,
          evidenceDigest: EVIDENCE_DIGEST,
          observedAt: INSTANT
        }
      }
    });
    const {
      submissionWitness: _submissionWitness,
      submissionWitnesses: _submissionWitnesses,
      ownershipBaseline: _ownershipBaseline,
      ownershipBaselines: _ownershipBaselines,
      ...state
    } = establishedState;
    const result = toOperationInspectWireResult({ state, handle: handle({ phase: "ready", mutationBoundary: "send_may_have_occurred" }) });
    expect(result.state.target?.targetEstablishment).not.toHaveProperty("postSendDeltaDigest");
    expect(validateOperationInspectWireResult(result)).toBe(result);
  });

  it("preserves keyed ownership and submission evidence in inspect results", () => {
    const baseline = {
      schemaVersion: "chatgpt.browser_control.operation_ownership_baseline.v1" as const,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      actionId: ACTION_ID,
      baseline: {
        schemaVersion: "chatgpt.browser_control.turn_ownership.v1" as const,
        snapshotDigest: "hmac-sha256:1212121212121212121212121212121212121212121212121212121212121212",
        target: {
          provider: { status: "available" as const, value: "provider-1" },
          browser: { status: "available" as const, value: "browser-1" },
          tab: { status: "available" as const, value: "tab-1" },
          thread: { status: "available" as const, value: "conversation-1" },
          conversation: { status: "available" as const, value: "conversation-1" },
          canonicalThreadUrl: {
            status: "available" as const,
            value: "https://opaque.invalid/thread/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          authoritativeTabClaim: { status: "unavailable" as const, reason: "not_exposed" as const },
          coordinationScope: "process" as const
        },
        userTurns: [],
        assistantTurns: [],
        completeness: "complete" as const
      },
      observedAt: "2026-08-16T00:00:01.000Z"
    };
    const witness = {
      schemaVersion: "chatgpt.browser_control.operation_submission_witness.v1" as const,
      actionId: ACTION_ID,
      actionKind: "send" as const,
      targetBindingDigest: TARGET_DIGEST,
      baselineSnapshotDigest: "hmac-sha256:1212121212121212121212121212121212121212121212121212121212121212",
      postSendDeltaDigest: EVIDENCE_DIGEST,
      operationUserEvidenceDigest: EVIDENCE_DIGEST,
      userTurnId: "user-turn-1",
      observedAt: "2026-08-16T00:00:02.000Z"
    };
    const state = operationState({
      ownershipBaseline: baseline,
      ownershipBaselines: { [ACTION_ID]: baseline },
      submissionWitnesses: { [ACTION_ID]: witness },
      submissionWitness: witness
    });
    const result = toOperationInspectWireResult({ state, handle: handle() });
    expect(result.state.ownershipBaselines?.[ACTION_ID]).toEqual(baseline);
    expect(result.state.submissionWitnesses?.[ACTION_ID]).toEqual(witness);
    expect(validateOperationInspectWireResult(result)).toBe(result);
  });

  it("carries a fresh parent handle for control and never accepts steer text", () => {
    const result = toOperationControlWireResult({
      kind: "completed",
      controlActionId: CONTROL_ID,
      parentOperationId: OPERATION_ID,
      parentRequestDigest: REQUEST_DIGEST,
      parentTargetBindingDigest: TARGET_DIGEST,
      requestDigest: RECEIPT_DIGEST,
      action: "stop",
      expectedAssistantTurnId: "assistant-turn-1",
      receipt: controlReceipt()
    }, handle({ phase: "generating", mutationBoundary: "control_may_have_occurred" }));
    expect(result.status).toBe("completed");
    expect(result.handle.revision).toBe(4);
    expect(result).not.toHaveProperty("steerPrompt");
    expect(validateOperationControlWireResult(result)).toBe(result);

    const unsafe = structuredClone(result) as unknown as Record<string, unknown>;
    unsafe.steerPrompt = "private steer text";
    expect(() => validateOperationControlWireResult(unsafe)).toThrowError(/Unexpected wire field/);

    const successWithBlocker = structuredClone(result) as unknown as Record<string, any>;
    successWithBlocker.receipt.blockerCode = "operation_timeout";
    expect(() => validateOperationControlWireResult(successWithBlocker)).toThrowError(/must not carry a blocker/);

    const blockedWithoutReceiptBlocker = structuredClone(result) as unknown as Record<string, any>;
    blockedWithoutReceiptBlocker.status = "blocked";
    blockedWithoutReceiptBlocker.blocker = {
      schemaVersion: "chatgpt.browser_control.operation_blocker.v1",
      code: "operation_timeout",
      recoverable: true,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      phase: "generating",
      mutationBoundary: "control_may_have_occurred",
      message: "Operation blocked: timeout."
    };
    blockedWithoutReceiptBlocker.receipt.outcome = "not_satisfied";
    delete blockedWithoutReceiptBlocker.receipt.evidenceDigest;
    expect(() => validateOperationControlWireResult(blockedWithoutReceiptBlocker)).toThrowError(/requires a blocker code/);

    blockedWithoutReceiptBlocker.receipt.blockerCode = "operation_timeout";
    blockedWithoutReceiptBlocker.status = "uncertain";
    expect(() => validateOperationControlWireResult(blockedWithoutReceiptBlocker)).toThrowError(/does not match result status/);
  });

  it("rejects identity, size, non-finite, and schema-shape violations", () => {
    const accepted = toOperationSubmitWireResult({ handle: handle(), submission: submitted() });
    const mismatched = structuredClone(accepted) as unknown as Record<string, unknown>;
    (mismatched.handle as Record<string, unknown>).requestDigest = TARGET_DIGEST;
    expect(() => validateOperationSubmitWireResult(mismatched)).toThrowError(/identity/);

    const tooLarge = liveResponseFromText("ok") as unknown as Record<string, unknown>;
    tooLarge.bytes = Number.POSITIVE_INFINITY;
    expect(() => validateOperationCollectWireResult({
      schemaVersion: "chatgpt.browser_control.operation_collect_result.v1",
      status: "completed",
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      handle: handle({ phase: "completed", revision: 10 }),
      receipt: receipt(),
      liveResponse: tooLarge
    })).toThrowError(/non-finite|size metadata/);
  });

  it("rejects statuses that belong to a different operation command", () => {
    const base = {
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      handle: handle()
    };
    expect(() => validateOperationSubmitWireResult({
      schemaVersion: "chatgpt.browser_control.operation_submit_result.v1",
      status: "pending",
      ...base
    })).toThrowError(/Submit results/);
    expect(() => validateOperationCollectWireResult({
      schemaVersion: "chatgpt.browser_control.operation_collect_result.v1",
      status: "accepted",
      ...base
    })).toThrowError(/Collect results/);
    expect(() => validateOperationControlWireResult({
      schemaVersion: "chatgpt.browser_control.operation_control_result.v1",
      status: "pending",
      ...base,
      requestDigest: RECEIPT_DIGEST,
      parentRequestDigest: REQUEST_DIGEST,
      parentTargetBindingDigest: TARGET_DIGEST,
      controlActionId: CONTROL_ID,
      action: "stop",
      expectedAssistantTurnId: "assistant-turn-1"
    })).toThrowError(/Control results/);
  });

  it("requires blockers and inspect handles to match the fresh durable snapshot", () => {
    const blocked = toOperationSubmitWireResult({
      handle: handle({ phase: "ready", mutationBoundary: "none" }),
      submission: {
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        targetBindingDigest: TARGET_DIGEST,
        kind: "blocked",
        blocker: { code: "configuration_drift", observationRequired: false, mutationBoundary: "none" }
      }
    });
    const staleBlocker = structuredClone(blocked) as unknown as Record<string, unknown>;
    (staleBlocker.blocker as Record<string, unknown>).phase = "prepared";
    expect(() => validateOperationSubmitWireResult(staleBlocker)).toThrowError(/fresh handle/);

    const state = operationState();
    const inspect = toOperationInspectWireResult({ state, handle: handle() });
    const staleHandle = structuredClone(inspect) as unknown as Record<string, unknown>;
    (staleHandle.handle as Record<string, unknown>).revision = 3;
    expect(() => validateOperationInspectWireResult(staleHandle)).toThrowError(/durable state/);

    const wrongStatus = structuredClone(inspect) as unknown as Record<string, unknown>;
    wrongStatus.status = "completed";
    expect(() => validateOperationInspectWireResult(wrongStatus)).toThrowError(/status.*phase/i);

    const missingTargetBinding = structuredClone(inspect) as unknown as Record<string, unknown>;
    delete (missingTargetBinding.handle as Record<string, unknown>).targetBindingDigest;
    expect(() => validateOperationInspectWireResult(missingTargetBinding)).toThrowError(/durable state/);
  });

  it("enforces durable state invariants and permits child control digests", () => {
    const state = operationState({
      phase: "generating",
      mutationBoundary: "control_may_have_occurred",
      revision: 6,
      actions: {
        ...operationState().actions,
        [CONTROL_ID]: {
          actionId: CONTROL_ID,
          kind: "stop",
          repeatPolicy: "observe_only_after_intent",
          requestDigest: RECEIPT_DIGEST,
          targetDigest: TARGET_DIGEST,
          intentRevision: 5,
          intentAt: INSTANT
        }
      }
    });
    const result = toOperationInspectWireResult({
      state,
      handle: handle({ phase: "generating", mutationBoundary: "control_may_have_occurred", revision: 6 })
    });
    expect(validateOperationInspectWireResult(result)).toBe(result);

    const incoherent = structuredClone(result) as unknown as Record<string, unknown>;
    const actions = (incoherent.state as Record<string, any>).actions as Record<string, any>;
    actions[ACTION_ID].intentRevision = 7;
    expect(() => validateOperationInspectWireResult(incoherent)).toThrowError(/durable invariant/);

    const blockerOnSuccess = structuredClone(result) as unknown as Record<string, unknown>;
    const blockerAction = (blockerOnSuccess.state as Record<string, any>).actions as Record<string, any>;
    blockerAction[ACTION_ID].blockerCode = "operation_timeout";
    expect(() => validateOperationInspectWireResult(blockerOnSuccess)).toThrowError(/durable invariant|non-satisfied/);
  });

  it("rejects unpaired receipt metadata, impossible instants, and invalid Unicode", () => {
    const invalidReceipt = receipt() as unknown as Record<string, unknown>;
    delete invalidReceipt.responseBytes;
    expect(() => validateOperationCollectWireResult({
      schemaVersion: "chatgpt.browser_control.operation_collect_result.v1",
      status: "completed",
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      handle: handle({ phase: "completed", revision: 10 }),
      receipt: invalidReceipt
    })).toThrowError(/paired/);

    const impossible = structuredClone(toOperationInspectWireResult({ state: operationState(), handle: handle() })) as unknown as Record<string, any>;
    impossible.state.updatedAt = "2026-02-31T00:00:03.000Z";
    expect(() => validateOperationInspectWireResult(impossible)).toThrowError(/real canonical/);
    expect(() => liveResponseFromText("\ud800")).toThrowError(/invalid Unicode/);
  });

  it("counts live-response chars using JavaScript UTF-16 code units", () => {
    const response = liveResponseFromText("😀");
    const astralReceipt = receipt() as OperationReceiptV1;
    astralReceipt.responseBytes = 4;
    expect(response.bytes).toBe(4);
    expect(response.chars).toBe(2);
    expect(validateOperationCollectWireResult({
      schemaVersion: "chatgpt.browser_control.operation_collect_result.v1",
      status: "completed",
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      handle: handle({ phase: "completed", revision: 10 }),
      receipt: astralReceipt,
      liveResponse: response
    })).toMatchObject({ status: "completed" });
  });

  it("requires ephemeral response metadata to agree with its durable receipt", () => {
    const durableReceipt = receipt();
    durableReceipt.responseFormat = "markdown";
    const valid = {
      schemaVersion: "chatgpt.browser_control.operation_collect_result.v1",
      status: "completed",
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      handle: handle({ phase: "completed", revision: 10 }),
      receipt: durableReceipt,
      liveResponse: liveResponseFromText("private answer", "markdown")
    };
    expect(validateOperationCollectWireResult(valid)).toBe(valid);

    const unavailable = structuredClone(valid);
    unavailable.receipt.contentAvailable = false;
    expect(() => validateOperationCollectWireResult(unavailable)).toThrowError(/does not match/);

    const wrongBytes = structuredClone(valid);
    wrongBytes.receipt.responseBytes = 13;
    expect(() => validateOperationCollectWireResult(wrongBytes)).toThrowError(/does not match/);

    const wrongFormat = {
      ...structuredClone(valid),
      liveResponse: {
        ...valid.liveResponse,
        responseFormat: "text" as const
      }
    };
    expect(() => validateOperationCollectWireResult(wrongFormat)).toThrowError(/does not match/);
  });

  it("does not reflect an unexpected private field name in diagnostics", () => {
    const unsafe = toOperationSubmitWireResult({ handle: handle(), submission: submitted() }) as unknown as Record<string, unknown>;
    unsafe["private-secret-field"] = "sensitive";
    try {
      validateOperationSubmitWireResult(unsafe);
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("private-secret-field");
      expect(String(error)).not.toContain("sensitive");
    }
  });
});

function handle(overrides: Partial<OperationHandleV1> = {}): OperationHandleV1 {
  return {
    schemaVersion: "chatgpt.browser_control.operation_handle.v1",
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    revision: 4,
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: TARGET_DIGEST,
    ...overrides
  };
}

function submitted(): Extract<OperationSubmitResult["submission"], { kind: "submitted" }> {
  return {
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    targetBindingDigest: TARGET_DIGEST,
    kind: "submitted",
    actionId: ACTION_ID,
    evidenceDigest: EVIDENCE_DIGEST,
    userTurnId: "user-turn-1",
    userTurnEvidenceDigest: EVIDENCE_DIGEST,
    assistantTurnId: "assistant-turn-1"
  };
}

function receipt(): OperationReceiptV1 {
  return {
    schemaVersion: "chatgpt.browser_control.operation_receipt.v1",
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    userTurnId: "user-turn-1",
    userTurnEvidenceDigest: EVIDENCE_DIGEST,
    assistantTurnId: "assistant-turn-1",
    ownershipEvidenceDigest: RECEIPT_DIGEST,
    responseDigest: EVIDENCE_DIGEST,
    responseBytes: 14,
    finishReason: "stop",
    contentAvailable: true,
    artifacts: [],
    completedAt: INSTANT
  };
}

function collectorCompleted(): Extract<CollectorResult, { kind: "completed" }> {
  return {
    kind: "completed",
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    attempts: 1,
    turn: {
      userTurnId: "user-turn-1",
      assistantTurnId: "assistant-turn-1",
      userTurnEvidenceDigest: EVIDENCE_DIGEST,
      ownershipEvidenceDigest: RECEIPT_DIGEST
    },
    response: {
      contentAvailable: true,
      rawContentAvailable: true,
      rawText: "private answer",
      text: { digest: EVIDENCE_DIGEST, bytes: 14, chars: 14 },
      artifacts: [],
      finishReason: "stop"
    }
  };
}

function operationState(overrides: Partial<OperationStateV1> = {}): OperationStateV1 {
  const ownershipBaseline = {
    schemaVersion: "chatgpt.browser_control.operation_ownership_baseline.v1" as const,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    actionId: ACTION_ID,
    baseline: {
      schemaVersion: "chatgpt.browser_control.turn_ownership.v1" as const,
      snapshotDigest: "hmac-sha256:1212121212121212121212121212121212121212121212121212121212121212",
      target: {
        provider: { status: "available" as const, value: "provider-1" },
        browser: { status: "available" as const, value: "browser-1" },
        tab: { status: "available" as const, value: "tab-1" },
        thread: { status: "available" as const, value: "conversation-1" },
        conversation: { status: "available" as const, value: "conversation-1" },
        canonicalThreadUrl: {
          status: "available" as const,
          value: "https://opaque.invalid/thread/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        authoritativeTabClaim: { status: "unavailable" as const, reason: "not_exposed" as const },
        coordinationScope: "process" as const
      },
      userTurns: [],
      assistantTurns: [],
      completeness: "complete" as const
    },
    observedAt: "2026-08-16T00:00:01.000Z"
  };
  const submissionWitness = {
    schemaVersion: "chatgpt.browser_control.operation_submission_witness.v1" as const,
    actionId: ACTION_ID,
    actionKind: "send" as const,
    targetBindingDigest: TARGET_DIGEST,
    baselineSnapshotDigest: ownershipBaseline.baseline.snapshotDigest,
    postSendDeltaDigest: EVIDENCE_DIGEST,
    operationUserEvidenceDigest: EVIDENCE_DIGEST,
    userTurnId: "user-turn-1",
    observedAt: "2026-08-16T00:00:02.000Z"
  };
  return {
    schemaVersion: "chatgpt.browser_control.operation.v1",
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    revision: 4,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: INSTANT,
    target: {
      providerId: "provider-1",
      browserId: "browser-1",
      tabId: "tab-1",
      coordinationScope: "process",
      canonicalThreadUrl: "https://opaque.invalid/thread/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      conversationId: "conversation-1",
      evidenceProfile: {
        providerIdentity: "required",
        stableTabId: "required",
        stableConversationId: "required",
        stableUserTurnId: "unavailable",
        authoritativeTabClaim: "unavailable",
        replacementTabRecovery: false
      }
    },
    actions: {
      [ACTION_ID]: {
        actionId: ACTION_ID,
        kind: "send",
        repeatPolicy: "observe_only_after_intent",
        requestDigest: REQUEST_DIGEST,
        targetDigest: TARGET_DIGEST,
        intentRevision: 2,
        intentAt: "2026-08-16T00:00:01.000Z",
        outcome: "satisfied",
        receiptRevision: 3,
        receiptAt: "2026-08-16T00:00:02.000Z",
        evidenceDigest: EVIDENCE_DIGEST
      }
    },
    ownershipBaseline,
    ownershipBaselines: { [ACTION_ID]: ownershipBaseline },
    submissionWitness,
    submissionWitnesses: { [ACTION_ID]: submissionWitness },
    ...overrides
  };
}

function controlReceipt(): OperationControlReceiptV1 {
  return {
    schemaVersion: "chatgpt.browser_control.operation_control_receipt.v1",
    controlActionId: CONTROL_ID,
    parentOperationId: OPERATION_ID,
    parentRequestDigest: REQUEST_DIGEST,
    parentTargetBindingDigest: TARGET_DIGEST,
    expectedAssistantTurnId: "assistant-turn-1",
    requestDigest: RECEIPT_DIGEST,
    action: "stop",
    outcome: "satisfied",
    evidenceDigest: EVIDENCE_DIGEST,
    observedAt: INSTANT
  };
}
