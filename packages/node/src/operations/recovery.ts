import type {
  OperationActionRecordV1,
  OperationReceiptV1,
  OperationStateV1
} from "./types.js";
import {
  OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
  OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION
} from "./types.js";

export type OperationTargetObservation =
  | { status: "matches" }
  | { status: "mismatch"; evidenceDigest?: string }
  | { status: "unavailable"; evidenceDigest?: string };

export type OperationTurnObservation =
  | { status: "not_observed" }
  | { status: "owned_user_turn"; userTurnId: string; evidenceDigest: string }
  | { status: "owned_assistant_generating"; userTurnId: string; assistantTurnId: string; evidenceDigest: string }
  | { status: "owned_assistant_terminal"; userTurnId: string; assistantTurnId: string; evidenceDigest: string }
  | { status: "ambiguous"; evidenceDigest?: string };

export type OperationRecoveryObservationV1 = {
  schemaVersion: typeof OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION;
  target: OperationTargetObservation;
  turn: OperationTurnObservation;
};

export type OperationRecoveryDecisionV1 =
  | {
      kind: "return_completed_receipt";
      schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
      receipt: OperationReceiptV1;
    }
  | {
      kind: "continue_preparation";
      schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
      phase: "prepared" | "ready";
      nonRepeatableActionMayStart: true;
    }
  | {
      kind: "observe_action_postcondition";
      schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
      actionId: string;
      actionKind: OperationActionRecordV1["kind"];
      mayRepeatAction: false;
    }
  | {
      kind: "continue_owned_turn_observation";
      schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
      phase: "submitted" | "generating";
      userTurnId?: string;
      assistantTurnId?: string;
      evidenceDigest?: string;
    }
  | {
      kind: "capture_owned_turn";
      schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
      assistantTurnId: string;
      evidenceDigest: string;
    }
  | {
      kind: "enter_uncertain";
      schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
      code: "target_evidence_unavailable" | "turn_ownership_ambiguous" | "capture_ownership_lost";
      mayRepeatAction: false;
    }
  | {
      kind: "block";
      schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
      code: "target_binding_mismatch" | "target_evidence_unavailable" | "operation_state_inconsistent";
      mayRepeatAction: false;
    };

/**
 * Decide what a restarted caller may do from durable state and a fresh,
 * operation-bound observation. This function never authorizes replay of an
 * action whose intent is already durable.
 */
export function decideOperationRecovery(
  state: OperationStateV1,
  observation: OperationRecoveryObservationV1
): OperationRecoveryDecisionV1 {
  if (state.phase === "completed") {
    if (state.receipt === undefined) {
      return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "block", code: "operation_state_inconsistent", mayRepeatAction: false };
    }
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "return_completed_receipt", receipt: state.receipt };
  }

  if (observation.target.status === "mismatch") {
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "block", code: "target_binding_mismatch", mayRepeatAction: false };
  }
  if (observation.target.status === "unavailable") {
    if (state.mutationBoundary === "none") {
      return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "block", code: "target_evidence_unavailable", mayRepeatAction: false };
    }
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "enter_uncertain", code: "target_evidence_unavailable", mayRepeatAction: false };
  }

  // The process can stop after fsyncing an intent (or its receipt) but before
  // appending the corresponding phase event. Phase alone therefore never
  // authorizes a second non-repeatable browser action.
  const pendingIntent = pendingNonRepeatableAction(state);
  if (pendingIntent !== undefined) {
    return decisionForPendingAction(state, pendingIntent, observation.turn);
  }

  if (state.phase === "prepared" || state.phase === "ready") {
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "continue_preparation", phase: state.phase, nonRepeatableActionMayStart: true };
  }

  if (state.phase === "handoff_pending" || state.phase === "send_pending") {
    const expectedKind = state.phase === "handoff_pending" ? "file_handoff" : "send";
    const action = latestAction(state, candidate => candidate.kind === expectedKind);
    if (action === undefined) {
      return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "block", code: "operation_state_inconsistent", mayRepeatAction: false };
    }
    return {
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "observe_action_postcondition",
      actionId: action.actionId,
      actionKind: action.kind,
      mayRepeatAction: false
    };
  }

  if (state.phase === "capturing") {
    if (observation.turn.status === "owned_assistant_terminal") {
      return {
        schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
        kind: "capture_owned_turn",
        assistantTurnId: observation.turn.assistantTurnId,
        evidenceDigest: observation.turn.evidenceDigest
      };
    }
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "enter_uncertain", code: "capture_ownership_lost", mayRepeatAction: false };
  }

  if (state.phase === "submitted" || state.phase === "generating") {
    return ownedTurnDecision(state.phase, observation.turn);
  }

  // An uncertain operation can only observe the most advanced durable
  // boundary. It cannot return to a mutation path merely because the page
  // looks plausible.
  if (state.phase === "uncertain") {
    if (state.mutationBoundary === "handoff_may_have_occurred") {
      const action = latestAction(state, candidate => candidate.kind === "file_handoff");
      if (action === undefined) {
        return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "block", code: "operation_state_inconsistent", mayRepeatAction: false };
      }
      return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "observe_action_postcondition", actionId: action.actionId, actionKind: action.kind, mayRepeatAction: false };
    }
    if (state.mutationBoundary === "send_may_have_occurred" || state.mutationBoundary === "control_may_have_occurred") {
      if (observation.turn.status === "not_observed") {
        const action = latestAction(state, candidate =>
          candidate.kind === "send" || candidate.kind === "work_steer" || candidate.kind === "stop"
        );
        if (action !== undefined) {
          return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "observe_action_postcondition", actionId: action.actionId, actionKind: action.kind, mayRepeatAction: false };
        }
      }
      const turnDecision = ownedTurnDecision("generating", observation.turn);
      if (turnDecision.kind === "enter_uncertain") {
        const action = latestAction(state, candidate =>
          candidate.kind === "send" || candidate.kind === "work_steer" || candidate.kind === "stop"
        );
        if (action !== undefined) {
          return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "observe_action_postcondition", actionId: action.actionId, actionKind: action.kind, mayRepeatAction: false };
        }
      }
      return turnDecision;
    }
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "block", code: "operation_state_inconsistent", mayRepeatAction: false };
  }

  return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "block", code: "operation_state_inconsistent", mayRepeatAction: false };
}

function decisionForPendingAction(
  state: OperationStateV1,
  action: OperationActionRecordV1,
  turn: OperationTurnObservation
): OperationRecoveryDecisionV1 {
  // Attachment ownership is established by the exact manifest
  // postcondition, not by turn state.  A durable handoff intent therefore
  // always remains observation-only until that postcondition is reconciled.
  if (action.kind === "file_handoff") return observeAction(action);

  // Send/steer/stop can be reconciled directly when an operation-owned turn
  // is already proven.  This matters for the crash gap after the browser
  // acted but before the action receipt or phase event was appended.  Merely
  // having a durable intent still never authorizes a second mutation.
  if (turn.status === "not_observed") return observeAction(action);
  if (turn.status === "ambiguous") {
    return {
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "enter_uncertain",
      code: "turn_ownership_ambiguous",
      mayRepeatAction: false
    };
  }

  const phase = action.kind === "stop"
    ? "generating"
    : state.phase === "generating"
      ? "generating"
      : "submitted";
  return ownedTurnDecision(phase, turn);
}

function observeAction(action: OperationActionRecordV1): OperationRecoveryDecisionV1 {
  return {
    schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
    kind: "observe_action_postcondition",
    actionId: action.actionId,
    actionKind: action.kind,
    mayRepeatAction: false
  };
}

function ownedTurnDecision(
  phase: "submitted" | "generating",
  turn: OperationTurnObservation
): OperationRecoveryDecisionV1 {
  if (turn.status === "ambiguous") {
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "enter_uncertain", code: "turn_ownership_ambiguous", mayRepeatAction: false };
  }
  if (turn.status === "owned_assistant_terminal") {
    return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "capture_owned_turn", assistantTurnId: turn.assistantTurnId, evidenceDigest: turn.evidenceDigest };
  }
  if (turn.status === "owned_assistant_generating") {
    return {
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "continue_owned_turn_observation",
      phase: "generating",
      userTurnId: turn.userTurnId,
      assistantTurnId: turn.assistantTurnId,
      evidenceDigest: turn.evidenceDigest
    };
  }
  if (turn.status === "owned_user_turn") {
    return {
      schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION,
      kind: "continue_owned_turn_observation",
      phase,
      userTurnId: turn.userTurnId,
      evidenceDigest: turn.evidenceDigest
    };
  }
  return { schemaVersion: OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, kind: "continue_owned_turn_observation", phase };
}

function latestAction(
  state: OperationStateV1,
  predicate: (action: OperationActionRecordV1) => boolean
): OperationActionRecordV1 | undefined {
  return Object.values(state.actions)
    .filter(predicate)
    .sort((left, right) => right.intentRevision - left.intentRevision)[0];
}

function pendingNonRepeatableAction(state: OperationStateV1): OperationActionRecordV1 | undefined {
  return latestAction(state, action => {
    if (action.kind === "file_handoff") {
      return state.phase === "prepared" || state.phase === "handoff_pending" || state.phase === "uncertain";
    }
    if (action.kind === "send") {
      return state.phase === "ready" || state.phase === "send_pending" || state.phase === "uncertain";
    }
    if (action.kind === "work_steer" || action.kind === "stop") {
      return state.phase === "generating" || state.phase === "uncertain";
    }
    return false;
  });
}
