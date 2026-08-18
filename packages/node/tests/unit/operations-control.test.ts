import { describe, expect, it } from "vitest";
import {
  controlSteerPreparedDigestMaterial,
  runOperationControl,
  type ControlExecutionResult,
  type ControlIntentPersistenceRequest,
  type ControlParentSnapshot,
  type ControlPorts,
  type ControlPostconditionObservation,
  type ControlReceiptPersistenceRequest,
  type ControlResult,
  type ControlSteerDurableIntent,
  type ControlSteerExecutePreparedRequest,
  type ControlSteerIntentAndBaselinePersistenceRequest,
  type ControlSteerIntentAndBaselinePersistenceResult,
  type ControlSteerPhaseResult,
  type ControlSteerPrepareRequest,
  type ControlSteerPrepared,
  type ControlSteerRecoverRequest,
  type ControlSteerVerifyRequest,
  type ControlTurnObservation
} from "../../src/operations/control.js";
import {
  OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION,
  OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  type OperationActionRecordV1,
  type OperationControlRequestV1,
  type OperationHandleV1,
  type OperationStateV1
} from "../../src/operations/types.js";
import { TURN_OWNERSHIP_SCHEMA_VERSION, type OwnershipBaseline } from "../../src/operations/turn-ownership.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const SEND_ID = "33333333-3333-4333-8333-333333333333";
const CONTROL_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CONTROL_ID = "44444444-4444-4444-8444-444444444444";
const PARENT_DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `hmac-sha256:${"b".repeat(64)}`;
const CONTROL_DIGEST = `hmac-sha256:${"c".repeat(64)}`;
const EVIDENCE_DIGEST = `hmac-sha256:${"d".repeat(64)}`;
const BASELINE_DIGEST = `hmac-sha256:${"e".repeat(64)}`;
const PREPARED_DIGEST = `hmac-sha256:${"f".repeat(64)}`;
const DELTA_DIGEST = `hmac-sha256:${"0".repeat(64)}`;
const AT = "2026-08-16T12:00:00.000Z";
const AT_2 = "2026-08-16T12:00:01.000Z";
const AT_3 = "2026-08-16T12:00:02.000Z";
const ASSISTANT_ID = "assistant-turn-1";
const USER_ID = "user-turn-0";
const BRANCH_ID = "branch-1";

type Fake = ControlPorts & {
  parent: ControlParentSnapshot;
  turn: ControlTurnObservation;
  post: ControlPostconditionObservation;
  execution: ControlExecutionResult;
  calls: string[];
  executeCount: number;
  persistedIntents: unknown[];
  persistedReceipts: ControlReceiptPersistenceRequest[];
  persistedSteerIntents: ControlSteerIntentAndBaselinePersistenceRequest[];
  prepared: ControlSteerPrepared;
  steerExecution: ControlSteerPhaseResult;
  steerVerification: ControlSteerPhaseResult;
  steerRecovery: ControlSteerPhaseResult;
  preparedResult: () => ControlSteerPhaseResult;
  commitSteerIntent: (request: ControlSteerIntentAndBaselinePersistenceRequest) => void;
  steerExecuteCount: number;
  throwOnSteerExecute: boolean;
  throwOnSteerPersist: boolean;
  throwOnExecute: boolean;
  throwOnReceipt: boolean;
  steerPersistenceDecisionQueue: ControlSteerIntentAndBaselinePersistenceResult["disposition"][];
  abortOnIntent?: AbortController;
};

function fakePorts(overrides: Partial<Pick<Fake, "turn" | "post" | "execution" | "steerExecution" | "steerVerification" | "steerRecovery" | "throwOnSteerExecute" | "throwOnSteerPersist" | "throwOnExecute" | "throwOnReceipt" | "steerPersistenceDecisionQueue" | "abortOnIntent">> = {}, initialState?: OperationStateV1): Fake {
  const fake: Fake = {
    parent: parentSnapshot(initialState),
    turn: overrides.turn ?? { status: "generating", assistantTurnId: ASSISTANT_ID, evidenceDigest: EVIDENCE_DIGEST },
    post: overrides.post ?? { status: "satisfied", assistantTurnId: ASSISTANT_ID, evidenceDigest: EVIDENCE_DIGEST },
    execution: overrides.execution ?? { status: "satisfied", assistantTurnId: ASSISTANT_ID, evidenceDigest: EVIDENCE_DIGEST },
    prepared: preparedSteer(),
    steerExecution: overrides.steerExecution ?? steerExecuted(),
    steerVerification: overrides.steerVerification ?? steerVerified(),
    steerRecovery: overrides.steerRecovery ?? steerRecovered(),
    steerExecuteCount: 0,
    throwOnSteerExecute: overrides.throwOnSteerExecute ?? false,
    throwOnSteerPersist: overrides.throwOnSteerPersist ?? false,
    calls: [],
    executeCount: 0,
    persistedIntents: [],
    persistedReceipts: [],
    persistedSteerIntents: [],
    throwOnExecute: overrides.throwOnExecute ?? false,
    throwOnReceipt: overrides.throwOnReceipt ?? false,
    steerPersistenceDecisionQueue: [...(overrides.steerPersistenceDecisionQueue ?? [])],
    ...(overrides.abortOnIntent === undefined ? {} : { abortOnIntent: overrides.abortOnIntent }),
    async readParent() {
      fake.calls.push("readParent");
      return fake.parent;
    },
    async observeTurn() {
      fake.calls.push("observeTurn");
      return fake.turn;
    },
    async persistActionIntent(request: ControlIntentPersistenceRequest) {
      fake.calls.push("persistIntent");
      fake.persistedIntents.push(request);
      const value = request as {
        controlActionId: string;
        action: "stop" | "steer";
        requestDigest: string;
        targetBindingDigest: string;
      };
      const current = fake.parent.state;
      const nextRevision = current.revision + 1;
      const nextAction: OperationActionRecordV1 = {
        actionId: value.controlActionId,
        kind: value.action === "steer" ? "work_steer" : "stop",
        repeatPolicy: "observe_only_after_intent",
        requestDigest: value.requestDigest,
        targetDigest: value.targetBindingDigest,
        intentRevision: nextRevision,
        intentAt: AT_2
      };
      const nextState: OperationStateV1 = {
        ...current,
        revision: nextRevision,
        updatedAt: AT_2,
        mutationBoundary: "control_may_have_occurred",
        actions: { ...current.actions, [value.controlActionId]: nextAction }
      };
      fake.parent = {
        state: nextState,
        handle: handleFor(nextState)
      };
      fake.abortOnIntent?.abort();
    },
    async prepareSteer(request: ControlSteerPrepareRequest) {
      fake.calls.push("prepareSteer");
      expect(request).not.toHaveProperty("steerPrompt");
      return fake.preparedResult();
    },
    async persistSteerIntentAndBaseline(request: ControlSteerIntentAndBaselinePersistenceRequest) {
      fake.calls.push("persistSteerIntentAndBaseline");
      fake.persistedSteerIntents.push(request);
      const disposition = fake.steerPersistenceDecisionQueue.shift() ?? "acquired";
      if (disposition === "acquired") fake.commitSteerIntent(request);
      fake.abortOnIntent?.abort();
      if (fake.throwOnSteerPersist) throw new Error("commit then throw");
      const result: ControlSteerIntentAndBaselinePersistenceResult = disposition === "blocked"
        ? {
            schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1",
            disposition,
            blockerCode: "provider_concurrency_unsupported"
          }
        : {
            schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1",
            disposition
          };
      return result;
    },
    async executeSteerPrepared(request: ControlSteerExecutePreparedRequest) {
      fake.calls.push("executeSteerPrepared");
      expect(request).not.toHaveProperty("steerPrompt");
      fake.steerExecuteCount += 1;
      if (fake.throwOnSteerExecute) throw new Error("acts then throws");
      return fake.steerExecution;
    },
    async verifySteer(request: ControlSteerVerifyRequest) {
      fake.calls.push("verifySteer");
      expect(request).not.toHaveProperty("steerPrompt");
      return fake.steerVerification;
    },
    async recoverSteer(request: ControlSteerRecoverRequest) {
      fake.calls.push("recoverSteer");
      expect(request).not.toHaveProperty("steerPrompt");
      return fake.steerRecovery;
    },
    async executeOnce() {
      fake.calls.push("executeOnce");
      fake.executeCount += 1;
      if (fake.throwOnExecute) throw new Error("acts then throws");
      return fake.execution;
    },
    async observePostcondition() {
      fake.calls.push("observePostcondition");
      return fake.post;
    },
    async persistReceipt(request: ControlReceiptPersistenceRequest) {
      fake.calls.push("persistReceipt");
      if (fake.throwOnReceipt) throw new Error("journal unavailable");
      fake.persistedReceipts.push(request);
    },
    preparedResult: () => ({
      ...steerPhaseBase(fake.prepared, "prepare"),
      status: "prepared",
      observationRequired: false,
      mutationBoundary: "none",
      prepared: fake.prepared
    }),
    commitSteerIntent: (request: ControlSteerIntentAndBaselinePersistenceRequest) => {
      const current = fake.parent.state;
      const nextRevision = current.revision + 1;
      const nextAction: OperationActionRecordV1 = {
        actionId: request.controlActionId,
        kind: "work_steer",
        repeatPolicy: "observe_only_after_intent",
        requestDigest: request.requestDigest,
        targetDigest: request.parentTargetBindingDigest,
        intentRevision: nextRevision,
        intentAt: AT_2
      };
      const durableIntent: ControlSteerDurableIntent = {
        ...fake.prepared,
        ...request,
        schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1",
        action: "steer"
      };
      const nextState: OperationStateV1 = {
        ...current,
        revision: nextRevision,
        updatedAt: AT_2,
        mutationBoundary: "control_may_have_occurred",
        actions: { ...current.actions, [request.controlActionId]: nextAction },
        ownershipBaselines: {
          ...(current.ownershipBaselines ?? {}),
          [request.controlActionId]: {
            schemaVersion: "chatgpt.browser_control.operation_ownership_baseline.v1",
            operationId: OPERATION_ID,
            requestDigest: PARENT_DIGEST,
            targetBindingDigest: TARGET_DIGEST,
            actionId: request.controlActionId,
            baseline: request.baseline,
            observedAt: AT_2
          }
        }
      };
      fake.parent = { state: nextState, handle: handleFor(nextState), existingSteerIntent: durableIntent };
    }
    };
  return fake;
}

describe("operation-bound Stop and Work steer", () => {
  it("persists an intent before one exact control mutation and never persists steer text", async () => {
    const fake = fakePorts();
    const result = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);

    expect(result.kind).toBe("completed");
    expect(fake.calls).toEqual(["readParent", "prepareSteer", "persistSteerIntentAndBaseline", "executeSteerPrepared", "verifySteer", "persistReceipt"]);
    expect(fake.steerExecuteCount).toBe(1);
    expect(JSON.stringify(fake.persistedSteerIntents)).not.toContain("private steer text");
    expect(JSON.stringify(fake.persistedReceipts)).not.toContain("private steer text");
    expect(fake.persistedSteerIntents[0]).toMatchObject({
      parentOperationId: OPERATION_ID,
      parentRequestDigest: PARENT_DIGEST,
      parentTargetBindingDigest: TARGET_DIGEST,
      requestDigest: CONTROL_DIGEST,
      controlActionId: CONTROL_ID,
      action: "steer",
      baselineSnapshotDigest: fake.prepared.baselineSnapshotDigest,
      preparedDigest: fake.prepared.preparedDigest
    });
    expect(Object.keys(fake.persistedSteerIntents[0]!)).toEqual([
      "schemaVersion", "parentOperationId", "parentRequestDigest", "parentTargetBindingDigest", "controlActionId", "action",
      "requestDigest", "expectedAssistantTurnId", "assistantBranchId", "assistantParentTurnId",
      "baselineSnapshotDigest", "preparedDigest", "baseline"
    ]);
    expect((result as Extract<ControlResult, { kind: "completed" }>).receipt).toMatchObject({
      action: "steer",
      outcome: "satisfied",
      expectedAssistantTurnId: ASSISTANT_ID,
      requestDigest: CONTROL_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST
    });
    expect((result as Extract<ControlResult, { kind: "completed" }>).steerReceipt).toMatchObject({
      baselineSnapshotDigest: BASELINE_DIGEST,
      preparedDigest: PREPARED_DIGEST,
      assistantTurnId: ASSISTANT_ID,
      assistantBranchId: BRANCH_ID,
      assistantParentTurnId: USER_ID,
      postSendDeltaDigest: DELTA_DIGEST
    });
    expect(fake.persistedReceipts[0]?.steerReceipt).toMatchObject({ postSendDeltaDigest: DELTA_DIGEST });
  });

  it("exposes immutable prompt-free material for prepared-digest reconstruction", () => {
    const fake = fakePorts();
    const material = controlSteerPreparedDigestMaterial(fake.prepared);
    expect(material).toMatchObject({
      action: "work_steer",
      operationId: OPERATION_ID,
      parentRequestDigest: PARENT_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      controlActionId: CONTROL_ID,
      expectedAssistantTurnId: ASSISTANT_ID,
      assistantBranchId: BRANCH_ID,
      assistantParentTurnId: USER_ID,
      baselineSnapshotDigest: BASELINE_DIGEST
    });
    expect(Object.isFrozen(material)).toBe(true);
    expect(Object.isFrozen(material.baseline)).toBe(true);
    expect(JSON.stringify(material)).not.toContain("private steer text");
  });

  it("converges a commit-then-throw persistence prefix through recovery without executing", async () => {
    const fake = fakePorts({ throwOnSteerPersist: true });
    const first = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    expect(first).toMatchObject({ kind: "completed" });
    expect(fake.steerExecuteCount).toBe(0);
    expect(fake.calls).toEqual(["readParent", "prepareSteer", "persistSteerIntentAndBaseline", "readParent", "recoverSteer", "persistReceipt"]);
    expect(fake.persistedSteerIntents).toHaveLength(1);
  });

  it("replays a durable steer intent observation-only after a crash prefix", async () => {
    const fake = fakePorts({ throwOnReceipt: true });
    const first = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    expect(first).toMatchObject({ kind: "uncertain", blocker: { code: "backend_unavailable" } });
    expect(fake.steerExecuteCount).toBe(1);

    fake.throwOnReceipt = false;
    fake.steerRecovery = steerRecovered();
    const callCountBeforeReplay = fake.calls.length;
    const replay = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    expect(replay).toMatchObject({ kind: "completed", receipt: { outcome: "satisfied" } });
    expect(fake.steerExecuteCount).toBe(1);
    expect(fake.calls.slice(callCountBeforeReplay)).toEqual(["readParent", "recoverSteer", "persistReceipt"]);
  });

  it("allows only the sole atomic writer to execute when concurrent writers converge", async () => {
    const fake = fakePorts({ steerPersistenceDecisionQueue: ["acquired", "same_action_recovery"] });
    const initialReadParent = fake.readParent.bind(fake);
    let readCount = 0;
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    (fake as unknown as { readParent: ControlPorts["readParent"] }).readParent = async requestValue => {
      const snapshot = await initialReadParent(requestValue);
      readCount += 1;
      if (readCount === 2) release();
      await bothRead;
      return snapshot;
    };

    const first = runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    const second = runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    const results = await Promise.all([first, second]);

    expect(results.every(result => result.kind === "completed")).toBe(true);
    expect(fake.steerExecuteCount).toBe(1);
    expect(fake.persistedSteerIntents).toHaveLength(2);
    expect(fake.calls.filter(call => call === "executeSteerPrepared")).toHaveLength(1);
    expect(fake.calls.filter(call => call === "recoverSteer")).toHaveLength(1);
  });

  it("returns a typed block for a different unresolved Work action without recovery or execution", async () => {
    const fake = fakePorts({ steerPersistenceDecisionQueue: ["blocked"] });
    const result = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);

    expect(result).toMatchObject({
      kind: "blocked",
      blocker: { code: "provider_concurrency_unsupported", observationRequired: true }
    });
    expect("receipt" in result).toBe(false);
    expect(fake.calls).toEqual(["readParent", "prepareSteer", "persistSteerIntentAndBaseline"]);
    expect(fake.steerExecuteCount).toBe(0);
    expect(fake.calls).not.toContain("recoverSteer");
  });

  it("allows the exact persisted steer parent to become terminal during recovery", async () => {
    const fake = fakePorts({ throwOnReceipt: true });
    await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    fake.throwOnReceipt = false;
    fake.parent = {
      ...fake.parent,
      state: { ...fake.parent.state, phase: "uncertain", updatedAt: AT_3 },
      handle: { ...fake.parent.handle, phase: "uncertain", mutationBoundary: "control_may_have_occurred", revision: fake.parent.state.revision }
    };
    const replay = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    expect(replay.kind).toBe("completed");
    expect(fake.steerExecuteCount).toBe(1);
    expect(fake.calls.at(-2)).toBe("recoverSteer");
  });

  it("rejects child/parent digest confusion before persisting or mutating", async () => {
    const fake = fakePorts();
    fake.prepared = { ...fake.prepared, requestDigest: PARENT_DIGEST };
    const result = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_request_mismatch" } });
    expect(fake.persistedSteerIntents).toHaveLength(0);
    expect(fake.steerExecuteCount).toBe(0);
  });

  it("rejects prepared branch drift and malformed phase records without browser mutation", async () => {
    const wrongBranch = fakePorts();
    wrongBranch.prepared = { ...wrongBranch.prepared, assistantBranchId: "branch-other" };
    const branchResult = await runOperationControl(request("steer"), CONTROL_DIGEST, wrongBranch);
    expect(branchResult).toMatchObject({ kind: "blocked", blocker: { code: "target_binding_mismatch" } });
    expect(wrongBranch.steerExecuteCount).toBe(0);

    const malformed = fakePorts();
    malformed.steerExecution = {
      ...steerExecuted(),
      privatePrompt: "must not cross boundary"
    } as unknown as ControlSteerPhaseResult;
    const malformedResult = await runOperationControl(request("steer"), CONTROL_DIGEST, malformed);
    expect(malformedResult).toMatchObject({ kind: "completed" });
    expect(malformed.steerExecuteCount).toBe(1);
  });

  it("treats a fill/click acts-then-throws result as one-shot and verifies once", async () => {
    const fake = fakePorts({ throwOnSteerExecute: true });
    const result = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    expect(result).toMatchObject({ kind: "completed", receipt: { outcome: "satisfied" } });
    expect(fake.steerExecuteCount).toBe(1);
    expect(fake.calls).toEqual(["readParent", "prepareSteer", "persistSteerIntentAndBaseline", "executeSteerPrepared", "verifySteer", "persistReceipt"]);
  });

  it("does not execute after cancellation at the durable baseline boundary", async () => {
    const controller = new AbortController();
    const fake = fakePorts({ abortOnIntent: controller, steerRecovery: {
      ...steerRecovered(),
      status: "uncertain",
      blockerCode: "operation_cancelled",
      observationRequired: true,
      mutationBoundary: "control_may_have_occurred",
      quarantine: "caller",
      receipt: undefined
    } as unknown as ControlSteerPhaseResult });
    const result = await runOperationControl(request("steer"), CONTROL_DIGEST, fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_cancelled" }, receipt: { outcome: "not_satisfied" } });
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "not_satisfied", blockerCode: "operation_cancelled" });
    expect(fake.steerExecuteCount).toBe(0);
    expect(fake.calls).not.toContain("executeSteerPrepared");
  });

  it("persists a clean final-recheck blocker as not_satisfied without poisoning later collection", async () => {
    const fake = fakePorts();
    fake.steerExecution = {
      ...steerPhaseBase(fake.prepared, "execute_prepared"),
      status: "blocked",
      blockerCode: "target_binding_mismatch",
      observationRequired: false,
      mutationBoundary: "none"
    } as ControlSteerPhaseResult;

    const result = await runOperationControl(request("steer"), CONTROL_DIGEST, fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "target_binding_mismatch" }, receipt: { outcome: "not_satisfied" } });
    expect(fake.calls).toEqual(["readParent", "prepareSteer", "persistSteerIntentAndBaseline", "executeSteerPrepared", "persistReceipt"]);
    expect(fake.steerExecuteCount).toBe(1);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "not_satisfied", blockerCode: "target_binding_mismatch" });
  });

  it("fails closed on a backwards clock before the atomic steer boundary", async () => {
    const fake = fakePorts();
    let clock = Date.parse(AT);
    const result = await runOperationControl(request("steer"), CONTROL_DIGEST, fake, {
      now: () => {
        const value = clock;
        clock -= 1;
        return value;
      }
    });
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_timeout" } });
    expect(fake.persistedSteerIntents).toHaveLength(0);
    expect(fake.steerExecuteCount).toBe(0);
  });

  it("uses Stop without a prompt and rejects prompt-bearing Stop before browser access", async () => {
    const fake = fakePorts();
    const result = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, fake);
    expect(result.kind).toBe("completed");
    expect(fake.executeCount).toBe(1);

    const malformed = { ...request("stop", undefined), steerPrompt: "not allowed" } as OperationControlRequestV1;
    const rejected = await runOperationControl(malformed, CONTROL_DIGEST, fakePorts());
    expect(rejected).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
  });

  it("fails closed when the precondition belongs to a different or terminal assistant turn", async () => {
    const different = fakePorts({ turn: { status: "mismatch", assistantTurnId: "assistant-turn-later", reason: "different_turn", evidenceDigest: EVIDENCE_DIGEST } });
    const differentResult = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, different);
    expect(differentResult).toMatchObject({ kind: "blocked", blocker: { code: "target_binding_mismatch" } });
    expect(different.executeCount).toBe(0);
    expect(different.persistedIntents).toHaveLength(0);

    const terminal = fakePorts({ turn: { status: "terminal", assistantTurnId: ASSISTANT_ID, reason: "not_generating", evidenceDigest: EVIDENCE_DIGEST } });
    const terminalResult = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, terminal);
    expect(terminalResult).toMatchObject({ kind: "blocked", blocker: { code: "send_control_unavailable" } });
    expect(terminal.executeCount).toBe(0);
  });

  it("rejects a completed parent before observing or mutating the browser", async () => {
    const completed = completedState();
    const fake = fakePorts({}, completed);
    const result = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "send_control_unavailable" } });
    expect(fake.calls).toEqual(["readParent"]);
    expect(fake.executeCount).toBe(0);
  });

  it("rejects a reloaded parent request/target mismatch before browser access", async () => {
    const mismatchedRequestDigest = `hmac-sha256:${"e".repeat(64)}`;
    const requestMismatch = fakePorts({}, generatingState({
      requestDigest: mismatchedRequestDigest,
      actions: {
        [SEND_ID]: { ...sendAction(), requestDigest: mismatchedRequestDigest }
      }
    }));
    const mismatchResult = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, requestMismatch);
    expect(mismatchResult).toMatchObject({ kind: "blocked", blocker: { code: "operation_request_mismatch" } });

    const targetMismatch = fakePorts();
    targetMismatch.parent = {
      state: targetMismatch.parent.state,
      handle: { ...targetMismatch.parent.handle, targetBindingDigest: `hmac-sha256:${"f".repeat(64)}` }
    };
    const targetResult = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, targetMismatch);
    expect(targetResult).toMatchObject({ kind: "blocked", blocker: { code: "target_binding_mismatch" } });
    expect(targetMismatch.executeCount).toBe(0);
  });

  it("reconciles an execution that acts then throws without repeating it", async () => {
    const fake = fakePorts({ throwOnExecute: true });
    const result = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, fake);
    expect(result.kind).toBe("completed");
    expect(fake.executeCount).toBe(1);
    expect(fake.calls).toEqual(["readParent", "observeTurn", "persistIntent", "executeOnce", "observePostcondition", "persistReceipt"]);
  });

  it("polls a transient generating Stop postcondition without repeating the control mutation", async () => {
    const fake = fakePorts({ execution: { status: "uncertain" } });
    const observations: ControlPostconditionObservation[] = [
      { status: "not_satisfied", blockerCode: "send_control_unavailable", evidenceDigest: EVIDENCE_DIGEST },
      { status: "uncertain", blockerCode: "target_evidence_unavailable", evidenceDigest: EVIDENCE_DIGEST },
      { status: "satisfied", assistantTurnId: ASSISTANT_ID, evidenceDigest: EVIDENCE_DIGEST }
    ];
    Object.assign(fake, {
      postconditionRetry: { maxAttempts: observations.length, intervalMs: 0 },
      observePostcondition: async () => {
        fake.calls.push("observePostcondition");
        return observations.shift()!;
      }
    });

    const result = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, fake);

    expect(result).toMatchObject({ kind: "completed", receipt: { outcome: "satisfied" } });
    expect(fake.executeCount).toBe(1);
    expect(fake.calls.filter(call => call === "observePostcondition")).toHaveLength(3);
    expect(fake.calls.at(-1)).toBe("persistReceipt");
  });

  it("rejects an unbounded postcondition retry policy before browser access", async () => {
    const fake = fakePorts({ execution: { status: "uncertain" } });
    Object.assign(fake, { postconditionRetry: { maxAttempts: 1_000, intervalMs: 1_000 } });

    const result = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, fake);

    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
    expect(fake.calls).toEqual([]);
    expect(fake.executeCount).toBe(0);
  });

  it("recovers a persisted intent observation-only after receipt persistence failed", async () => {
    const fake = fakePorts({ throwOnExecute: true, post: { status: "uncertain", blockerCode: "send_control_unavailable" }, throwOnReceipt: true });
    const first = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, fake);
    expect(first).toMatchObject({ kind: "uncertain", blocker: { code: "backend_unavailable" } });
    expect("receipt" in first).toBe(false);
    expect(fake.executeCount).toBe(1);

    fake.throwOnReceipt = false;
    fake.post = { status: "satisfied", assistantTurnId: ASSISTANT_ID, evidenceDigest: EVIDENCE_DIGEST };
    const second = await runOperationControl(request("stop", undefined), CONTROL_DIGEST, fake);
    expect(second.kind).toBe("completed");
    expect(fake.executeCount).toBe(1);
    expect(fake.calls.filter(call => call === "executeOnce")).toHaveLength(1);
  });

  it("turns cancellation after the durable intent into an uncertain receipt and never executes", async () => {
    const controller = new AbortController();
    const fake = fakePorts({ abortOnIntent: controller, post: { status: "uncertain", blockerCode: "operation_cancelled" } });
    const result = await runOperationControl(request("stop"), CONTROL_DIGEST, fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "operation_cancelled" }, receipt: { outcome: "uncertain" } });
    expect(fake.executeCount).toBe(0);
    expect(fake.calls).not.toContain("executeOnce");
  });

  it("turns cancellation during execution into a one-time uncertain reconciliation", async () => {
    const controller = new AbortController();
    const fake = fakePorts({ throwOnExecute: true, post: { status: "uncertain", blockerCode: "operation_cancelled" } });
    const original = fake.executeOnce;
    (fake as unknown as { executeOnce: ControlPorts["executeOnce"] }).executeOnce = async requestValue => {
      controller.abort();
      return await original(requestValue);
    };
    const result = await runOperationControl(request("stop"), CONTROL_DIGEST, fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "operation_cancelled" } });
    expect(fake.executeCount).toBe(1);
  });

  it("rejects malformed turn, execution, and postcondition outputs", async () => {
    const malformedTurn = fakePorts({ turn: { status: "generating", assistantTurnId: ASSISTANT_ID, evidenceDigest: EVIDENCE_DIGEST, privateText: "no" } as unknown as ControlTurnObservation });
    const turnResult = await runOperationControl(request("stop"), CONTROL_DIGEST, malformedTurn);
    expect(turnResult).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
    expect(malformedTurn.executeCount).toBe(0);

    const malformedExecution = fakePorts({ execution: { status: "satisfied", assistantTurnId: ASSISTANT_ID, evidenceDigest: EVIDENCE_DIGEST, privateText: "no" } as unknown as ControlExecutionResult, post: { status: "uncertain", blockerCode: "send_control_unavailable" } });
    const executionResult = await runOperationControl(request("stop"), CONTROL_DIGEST, malformedExecution);
    expect(executionResult).toMatchObject({ kind: "uncertain" });
    expect(malformedExecution.executeCount).toBe(1);

    const malformedPost = fakePorts({ throwOnExecute: true, post: { status: "satisfied", assistantTurnId: "later-turn", evidenceDigest: EVIDENCE_DIGEST } as unknown as ControlPostconditionObservation });
    const postResult = await runOperationControl(request("stop"), CONTROL_DIGEST, malformedPost);
    expect(postResult).toMatchObject({ kind: "uncertain", blocker: { code: "target_binding_mismatch" } });
  });

  it("allows a distinct caller-owned control action after an earlier action of the same kind", async () => {
    const current = generatingState({
      actions: {
        [SEND_ID]: sendAction(),
        [OTHER_CONTROL_ID]: {
          actionId: OTHER_CONTROL_ID,
          kind: "stop",
          repeatPolicy: "observe_only_after_intent",
          requestDigest: `hmac-sha256:${"e".repeat(64)}`,
          targetDigest: TARGET_DIGEST,
          intentRevision: 4,
          intentAt: AT_2
        }
      },
      revision: 4,
      updatedAt: AT_2,
      mutationBoundary: "control_may_have_occurred"
    });
    const fake = fakePorts({}, current);
    const result = await runOperationControl(request("stop"), CONTROL_DIGEST, fake);
    expect(result).toMatchObject({ kind: "completed", receipt: { controlActionId: CONTROL_ID } });
    expect(fake.executeCount).toBe(1);
    expect(fake.calls).toEqual(["readParent", "observeTurn", "persistIntent", "executeOnce", "persistReceipt"]);
  });

  it("returns an existing durable control receipt without observing or repeating the browser action", async () => {
    const receipt = {
      schemaVersion: OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION,
      controlActionId: CONTROL_ID,
      parentOperationId: OPERATION_ID,
      parentRequestDigest: PARENT_DIGEST,
      parentTargetBindingDigest: TARGET_DIGEST,
      expectedAssistantTurnId: ASSISTANT_ID,
      requestDigest: CONTROL_DIGEST,
      action: "stop" as const,
      outcome: "satisfied" as const,
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: AT_3
    };
    const fake = fakePorts({}, generatingState({
      actions: { [SEND_ID]: sendAction(), [CONTROL_ID]: controlAction() },
      revision: 4,
      updatedAt: AT_2,
      mutationBoundary: "control_may_have_occurred"
    }));
    fake.parent = { ...fake.parent, existingReceipt: receipt };
    const result = await runOperationControl(request("stop"), CONTROL_DIGEST, fake);
    expect(result).toMatchObject({ kind: "completed", receipt });
    expect(fake.calls).toEqual(["readParent"]);
    expect(fake.executeCount).toBe(0);
  });

  it("honors a deadline before the parent read", async () => {
    const fake = fakePorts();
    const result = await runOperationControl(request("stop"), CONTROL_DIGEST, fake, {
      now: () => Date.parse(AT),
      deadlineAt: Date.parse(AT) - 1
    });
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_timeout" } });
    expect(fake.calls).toEqual([]);
  });

  it("fails closed without invoking accessor-backed identity or inventing digest evidence", async () => {
    let parentReads = 0;
    const hostile = { ...request("stop", undefined) } as OperationControlRequestV1;
    Object.defineProperty(hostile, "parent", {
      enumerable: true,
      get() {
        parentReads += 1;
        throw new Error("hostile parent getter");
      }
    });

    const result = await runOperationControl(hostile, CONTROL_DIGEST, fakePorts());

    expect(parentReads).toBe(0);
    expect(result).toMatchObject({
      kind: "blocked",
      blocker: { code: "operation_state_corrupt" },
      controlActionId: CONTROL_ID,
      requestDigest: CONTROL_DIGEST,
      parentOperationId: "invalid-operation",
      parentRequestDigest: "invalid-digest",
      parentTargetBindingDigest: "invalid-digest"
    });
    expect(result.requestDigest).not.toMatch(/^hmac-sha256:0+$/u);
    expect(result.parentRequestDigest).not.toMatch(/^hmac-sha256:0+$/u);
    expect(result.parentTargetBindingDigest).not.toMatch(/^hmac-sha256:0+$/u);

    const missing = await runOperationControl({} as OperationControlRequestV1, "not-a-digest", fakePorts());
    expect(missing).toMatchObject({
      kind: "blocked",
      controlActionId: "invalid-control",
      parentOperationId: "invalid-operation",
      parentRequestDigest: "invalid-digest",
      parentTargetBindingDigest: "invalid-digest",
      requestDigest: "invalid-digest"
    });
    expect(JSON.stringify(missing)).not.toContain("hmac-sha256:000000");
  });
});

function request(action: "stop" | "steer", steerPrompt = action === "steer" ? "private steer text" : undefined): OperationControlRequestV1 {
  const parent = handleFor(generatingState());
  return {
    schemaVersion: OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
    controlActionId: CONTROL_ID,
    parent,
    action,
    expectedAssistantTurnId: ASSISTANT_ID,
    ...(steerPrompt === undefined ? {} : { steerPrompt }),
    timeoutMs: 30_000
  };
}

function preparedSteer(): ControlSteerPrepared {
  return {
    schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1",
    parentOperationId: OPERATION_ID,
    parentRequestDigest: PARENT_DIGEST,
    parentTargetBindingDigest: TARGET_DIGEST,
    controlActionId: CONTROL_ID,
    action: "steer",
    requestDigest: CONTROL_DIGEST,
    expectedAssistantTurnId: ASSISTANT_ID,
    assistantBranchId: BRANCH_ID,
    assistantParentTurnId: USER_ID,
    baselineSnapshotDigest: BASELINE_DIGEST,
    preparedDigest: PREPARED_DIGEST,
    baseline: baselineSteer()
  };
}

function baselineSteer(): OwnershipBaseline {
  const identity = (value: string) => ({ status: "available" as const, value });
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest: BASELINE_DIGEST,
    target: {
      provider: identity("provider-1"),
      browser: identity("browser-1"),
      tab: identity("tab-1"),
      thread: identity("thread-1"),
      conversation: identity("conversation-1"),
      canonicalThreadUrl: { status: "unavailable", reason: "redacted" },
      authoritativeTabClaim: { status: "unavailable", reason: "not_exposed" },
      coordinationScope: "process"
    },
    userTurns: [{
      stableId: USER_ID,
      evidenceDigest: EVIDENCE_DIGEST,
      structureDigest: EVIDENCE_DIGEST,
      ordinal: 0
    }],
    assistantTurns: [{
      stableId: ASSISTANT_ID,
      evidenceDigest: EVIDENCE_DIGEST,
      structureDigest: EVIDENCE_DIGEST,
      ordinal: 0,
      parentStableId: USER_ID,
      branchStableId: BRANCH_ID,
      state: "generating"
    }],
    completeness: "complete"
  };
}

function steerPhaseBase<P extends "prepare" | "execute_prepared" | "verify" | "recovery">(prepared: ControlSteerPrepared, phase: P) {
  return {
    schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1" as const,
    phase,
    parentOperationId: prepared.parentOperationId,
    parentRequestDigest: prepared.parentRequestDigest,
    parentTargetBindingDigest: prepared.parentTargetBindingDigest,
    controlActionId: prepared.controlActionId,
    action: "steer" as const,
    requestDigest: prepared.requestDigest,
    expectedAssistantTurnId: prepared.expectedAssistantTurnId,
    assistantBranchId: prepared.assistantBranchId,
    assistantParentTurnId: prepared.assistantParentTurnId,
    baselineSnapshotDigest: prepared.baselineSnapshotDigest,
    preparedDigest: prepared.preparedDigest
  };
}

function steerExecuted(): ControlSteerPhaseResult {
  return {
    ...steerPhaseBase(preparedSteer(), "execute_prepared"),
    status: "executed",
    observationRequired: true,
    mutationBoundary: "control_may_have_occurred"
  };
}

function steerVerified(): ControlSteerPhaseResult {
  const prepared = preparedSteer();
  return {
    ...steerPhaseBase(prepared, "verify"),
    status: "satisfied",
    observationRequired: false,
    mutationBoundary: "control_may_have_occurred",
    receipt: {
      schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1" as const,
      baselineSnapshotDigest: BASELINE_DIGEST,
      preparedDigest: PREPARED_DIGEST,
      assistantTurnId: ASSISTANT_ID,
      assistantBranchId: BRANCH_ID,
      assistantParentTurnId: USER_ID,
      userTurnId: "user-turn-1",
      userTurnEvidenceDigest: EVIDENCE_DIGEST,
      postSendDeltaDigest: DELTA_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST
    }
  };
}

function steerRecovered(): ControlSteerPhaseResult {
  const prepared = preparedSteer();
  return {
    ...steerPhaseBase(prepared, "recovery"),
    status: "satisfied",
    observationRequired: false,
    mutationBoundary: "control_may_have_occurred",
    receipt: {
      schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1" as const,
      baselineSnapshotDigest: BASELINE_DIGEST,
      preparedDigest: PREPARED_DIGEST,
      assistantTurnId: ASSISTANT_ID,
      assistantBranchId: BRANCH_ID,
      assistantParentTurnId: USER_ID,
      userTurnId: "user-turn-1",
      userTurnEvidenceDigest: EVIDENCE_DIGEST,
      postSendDeltaDigest: DELTA_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST
    }
  };
}

function parentSnapshot(state = generatingState()): ControlParentSnapshot {
  return { state, handle: handleFor(state) };
}

function generatingState(overrides: Partial<OperationStateV1> = {}): OperationStateV1 {
  const base: OperationStateV1 = {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: PARENT_DIGEST,
    surface: "work",
    phase: "generating",
    mutationBoundary: "send_may_have_occurred",
    revision: 3,
    createdAt: AT,
    updatedAt: AT_2,
    target: {
      providerId: "provider-1",
      browserId: "browser-1",
      tabId: "tab-1",
      coordinationScope: "process",
      conversationId: "conversation-1",
      evidenceProfile: {
        providerIdentity: "required",
        stableTabId: "required",
        stableConversationId: "required",
        stableUserTurnId: "required",
        authoritativeTabClaim: "unavailable",
        replacementTabRecovery: true
      }
    },
    actions: { [SEND_ID]: sendAction() },
    ...overrides
  };
  const send = base.actions[SEND_ID] ?? sendAction();
  const targetDigest = send.targetDigest ?? TARGET_DIGEST;
  const sendBaseline = {
    schemaVersion: "chatgpt.browser_control.operation_ownership_baseline.v1" as const,
    operationId: base.operationId,
    requestDigest: base.requestDigest,
    targetBindingDigest: targetDigest,
    actionId: send.actionId,
    baseline: baselineSteer(),
    observedAt: send.intentAt
  };
  const sendWitness = {
    schemaVersion: "chatgpt.browser_control.operation_submission_witness.v1" as const,
    actionId: send.actionId,
    actionKind: "send" as const,
    targetBindingDigest: targetDigest,
    baselineSnapshotDigest: sendBaseline.baseline.snapshotDigest,
    postSendDeltaDigest: DELTA_DIGEST,
    operationUserEvidenceDigest: EVIDENCE_DIGEST,
    userTurnId: "user-turn-1",
    observedAt: send.receiptAt ?? base.updatedAt
  };
  return {
    ...base,
    ownershipBaseline: base.ownershipBaseline ?? sendBaseline,
    ownershipBaselines: base.ownershipBaselines ?? { [send.actionId]: sendBaseline },
    submissionWitness: base.submissionWitness ?? sendWitness,
    submissionWitnesses: base.submissionWitnesses ?? { [send.actionId]: sendWitness }
  };
}

function completedState(): OperationStateV1 {
  return {
    ...generatingState(),
    phase: "completed",
    revision: 5,
    updatedAt: AT_3,
    receipt: {
      schemaVersion: "chatgpt.browser_control.operation_receipt.v1",
      operationId: OPERATION_ID,
      requestDigest: PARENT_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      userTurnId: "user-turn-1",
      userTurnEvidenceDigest: EVIDENCE_DIGEST,
      assistantTurnId: ASSISTANT_ID,
      ownershipEvidenceDigest: EVIDENCE_DIGEST,
      responseDigest: EVIDENCE_DIGEST,
      responseBytes: 1,
      finishReason: "stop",
      contentAvailable: true,
      artifacts: [],
      completedAt: AT_3
    }
  };
}

function sendAction(): OperationActionRecordV1 {
  return {
    actionId: SEND_ID,
    kind: "send",
    repeatPolicy: "observe_only_after_intent",
    requestDigest: PARENT_DIGEST,
    targetDigest: TARGET_DIGEST,
    intentRevision: 1,
    intentAt: AT,
    outcome: "satisfied",
    receiptRevision: 2,
    receiptAt: AT_2,
    evidenceDigest: EVIDENCE_DIGEST
  };
}

function controlAction(): OperationActionRecordV1 {
  return {
    actionId: CONTROL_ID,
    kind: "stop",
    repeatPolicy: "observe_only_after_intent",
    requestDigest: CONTROL_DIGEST,
    targetDigest: TARGET_DIGEST,
    intentRevision: 4,
    intentAt: AT_2
  };
}

function handleFor(state: OperationStateV1): OperationHandleV1 {
  return {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: state.operationId,
    requestDigest: state.requestDigest,
    surface: state.surface,
    revision: state.revision,
    phase: state.phase,
    mutationBoundary: state.mutationBoundary,
    targetBindingDigest: TARGET_DIGEST
  };
}
