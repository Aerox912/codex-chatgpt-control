import { describe, expect, it } from "vitest";
import { decideOperationRecovery } from "../../src/operations/recovery.js";
import {
  OPERATION_RECEIPT_SCHEMA_VERSION,
  OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
  OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  type OperationReceiptV1,
  type OperationStateV1
} from "../../src/operations/types.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const AT = "2026-08-16T12:00:00.000Z";

describe("operation recovery decisions", () => {
  it("returns a durable terminal receipt without touching the browser", () => {
    const receipt = {
      schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: DIGEST,
      targetBindingDigest: DIGEST,
      userTurnId: "user-1",
      userTurnEvidenceDigest: DIGEST,
      assistantTurnId: "assistant-1",
      ownershipEvidenceDigest: DIGEST,
      contentAvailable: false,
      finishReason: "stop",
      artifacts: [],
      completedAt: AT
    } satisfies OperationReceiptV1;
    expect(decideOperationRecovery({ ...baseState(), phase: "completed", receipt }, noTurn())).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "return_completed_receipt",
      receipt
    });
  });

  it("never authorizes a second handoff or send after durable intent", () => {
    const handoff = decideOperationRecovery(
      pendingState("handoff_pending", "handoff_may_have_occurred", "file_handoff"),
      noTurn()
    );
    const send = decideOperationRecovery(
      pendingState("send_pending", "send_may_have_occurred", "send"),
      noTurn()
    );
    expect(handoff).toMatchObject({ kind: "observe_action_postcondition", actionKind: "file_handoff", mayRepeatAction: false });
    expect(send).toMatchObject({ kind: "observe_action_postcondition", actionKind: "send", mayRepeatAction: false });
  });

  it("reconciles a pending Send intent from exact owned-turn evidence", () => {
    const state = pendingState("send_pending", "send_may_have_occurred", "send");
    expect(decideOperationRecovery(state, ownedUserTurn())).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "continue_owned_turn_observation",
      phase: "submitted",
      userTurnId: "user-1",
      evidenceDigest: DIGEST
    });
    expect(decideOperationRecovery(state, ownedGeneratingTurn())).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "continue_owned_turn_observation",
      phase: "generating",
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
      evidenceDigest: DIGEST
    });
    expect(decideOperationRecovery(state, ownedTerminalTurn())).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "capture_owned_turn",
      assistantTurnId: "assistant-1",
      evidenceDigest: DIGEST
    });
  });

  it("enters uncertainty instead of polling forever when pending Send ownership is ambiguous", () => {
    const state = pendingState("send_pending", "send_may_have_occurred", "send");
    expect(decideOperationRecovery(state, {
      schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
      target: { status: "matches" },
      turn: { status: "ambiguous", evidenceDigest: DIGEST }
    })).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "enter_uncertain",
      code: "turn_ownership_ambiguous",
      mayRepeatAction: false
    });
  });

  it("does not let turn evidence bypass a pending file-handoff postcondition", () => {
    const state = pendingState("handoff_pending", "handoff_may_have_occurred", "file_handoff");
    expect(decideOperationRecovery(state, ownedTerminalTurn())).toMatchObject({
      kind: "observe_action_postcondition",
      actionKind: "file_handoff",
      mayRepeatAction: false
    });
  });

  it("reconciles a pending operation-bound Stop without repeating it", () => {
    const state = pendingState("generating", "control_may_have_occurred", "stop");
    expect(decideOperationRecovery(state, ownedTerminalTurn())).toMatchObject({
      kind: "capture_owned_turn",
      assistantTurnId: "assistant-1"
    });
    expect(decideOperationRecovery(state, noTurn())).toMatchObject({
      kind: "observe_action_postcondition",
      actionKind: "stop",
      mayRepeatAction: false
    });
  });

  it("captures only an explicitly owned terminal assistant turn", () => {
    const state = { ...baseState(), phase: "generating" as const, mutationBoundary: "send_may_have_occurred" as const };
    expect(decideOperationRecovery(state, {
      schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
      target: { status: "matches" },
      turn: {
        status: "owned_assistant_terminal",
        userTurnId: "user-1",
        assistantTurnId: "assistant-1",
        evidenceDigest: DIGEST
      }
    })).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "capture_owned_turn",
      assistantTurnId: "assistant-1",
      evidenceDigest: DIGEST
    });
    expect(decideOperationRecovery(state, {
      schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
      target: { status: "matches" },
      turn: { status: "ambiguous" }
    })).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "enter_uncertain",
      code: "turn_ownership_ambiguous",
      mayRepeatAction: false
    });
  });

  it("fails closed when target ownership changes or cannot be proven after mutation", () => {
    const generating = { ...baseState(), phase: "generating" as const, mutationBoundary: "send_may_have_occurred" as const };
    expect(decideOperationRecovery(generating, {
      schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
      target: { status: "mismatch" },
      turn: { status: "not_observed" }
    })).toMatchObject({ kind: "block", code: "target_binding_mismatch", mayRepeatAction: false });
    expect(decideOperationRecovery(generating, {
      schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
      target: { status: "unavailable" },
      turn: { status: "not_observed" }
    })).toMatchObject({ kind: "enter_uncertain", code: "target_evidence_unavailable", mayRepeatAction: false });
  });

  it("allows a new non-repeatable intent only before one has been recorded", () => {
    expect(decideOperationRecovery(baseState(), noTurn())).toEqual({
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "continue_preparation",
      phase: "prepared",
      nonRepeatableActionMayStart: true
    });
  });

  it("never repeats across the crash gaps before pending phase persistence", () => {
    const readyWithSendIntent = pendingState("ready", "send_may_have_occurred", "send");
    const preparedWithHandoffReceipt = pendingState("prepared", "handoff_may_have_occurred", "file_handoff");
    preparedWithHandoffReceipt.actions[ACTION_ID]!.outcome = "satisfied";
    preparedWithHandoffReceipt.actions[ACTION_ID]!.receiptRevision = 3;
    preparedWithHandoffReceipt.actions[ACTION_ID]!.receiptAt = AT;
    preparedWithHandoffReceipt.actions[ACTION_ID]!.evidenceDigest = DIGEST;

    expect(decideOperationRecovery(readyWithSendIntent, noTurn())).toMatchObject({
      kind: "observe_action_postcondition",
      actionKind: "send",
      mayRepeatAction: false
    });
    expect(decideOperationRecovery(preparedWithHandoffReceipt, noTurn())).toMatchObject({
      kind: "observe_action_postcondition",
      actionKind: "file_handoff",
      mayRepeatAction: false
    });
  });

  it("keeps uncertain send operations observation-only", () => {
    const state = pendingState("uncertain", "send_may_have_occurred", "send");
    const decision = decideOperationRecovery(state, noTurn());
    expect(decision).toMatchObject({ kind: "observe_action_postcondition", actionKind: "send", mayRepeatAction: false });
  });
});

function baseState(): OperationStateV1 {
  return {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: DIGEST,
    surface: "chat",
    phase: "prepared",
    mutationBoundary: "none",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    actions: {}
  };
}

function pendingState(
  phase: OperationStateV1["phase"],
  mutationBoundary: OperationStateV1["mutationBoundary"],
  kind: "file_handoff" | "send" | "work_steer" | "stop"
): OperationStateV1 {
  return {
    ...baseState(),
    phase,
    mutationBoundary,
    actions: {
      [ACTION_ID]: {
        actionId: ACTION_ID,
        kind,
        repeatPolicy: "observe_only_after_intent",
        requestDigest: DIGEST,
        intentRevision: 2,
        intentAt: AT
      }
    }
  };
}

function ownedUserTurn() {
  return {
    schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
    target: { status: "matches" as const },
    turn: { status: "owned_user_turn" as const, userTurnId: "user-1", evidenceDigest: DIGEST }
  };
}

function ownedGeneratingTurn() {
  return {
    schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
    target: { status: "matches" as const },
    turn: {
      status: "owned_assistant_generating" as const,
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
      evidenceDigest: DIGEST
    }
  };
}

function ownedTerminalTurn() {
  return {
    schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
    target: { status: "matches" as const },
    turn: {
      status: "owned_assistant_terminal" as const,
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
      evidenceDigest: DIGEST
    }
  };
}

function noTurn() {
  return {
    schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
    target: { status: "matches" as const },
    turn: { status: "not_observed" as const }
  };
}
