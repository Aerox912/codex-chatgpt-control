import { describe, expect, it } from "vitest";
import type {
  OperationActionRecordV1,
  OperationReceiptV1,
  OperationStateV1
} from "../../src/operations/types.js";
import {
  OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION
} from "../../src/operations/types.js";
import type { OperationOwnershipBaselineV1 } from "../../src/operations/types.js";
import { TURN_OWNERSHIP_SCHEMA_VERSION, type OwnershipBaseline } from "../../src/operations/turn-ownership.js";
import {
  runAtomicSubmission,
  type SubmissionAttachmentObservation,
  type SubmissionExpectedEnvelope,
  type SubmissionFinalTransactionResult,
  type SubmissionHandoffResult,
  type SubmissionOperationSnapshot,
  type SubmissionPersistenceRequest,
  type SubmissionPorts,
  type SubmissionStageObservation
} from "../../src/operations/submission.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const SEND_ID = "22222222-2222-4222-8222-222222222222";
const HANDOFF_ID = "33333333-3333-4333-8333-333333333333";
const STOP_ID = "44444444-4444-4444-8444-444444444444";
const USER_TURN_ID = "user-turn-1";
const DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const DIGEST_B = `hmac-sha256:${"b".repeat(64)}`;
const DIGEST_C = `hmac-sha256:${"c".repeat(64)}`;
const AT = "2026-08-16T12:00:00.000Z";

type Fake = SubmissionPorts & {
  calls: string[];
  sendPhases: string[];
  intentKinds: string[];
  finalModes: string[];
  finalRequests: Parameters<SubmissionPorts["executeFinalTabTransaction"]>[0][];
  sendCalls: number;
  legacyBaselineCalls: number;
  persisted: SubmissionPersistenceRequest[];
  stageObservations: SubmissionStageObservation[];
  attachmentObservations: SubmissionAttachmentObservation[];
  handoffResults: SubmissionHandoffResult[];
  handoffRequests: Parameters<SubmissionPorts["executeFileHandoffOnce"]>[0][];
  finalResults: SubmissionFinalTransactionResult[];
  privatePaths: string[];
};

function fakePorts(overrides: Partial<{
  stage: SubmissionStageObservation;
  attachments: SubmissionAttachmentObservation[];
  handoffs: SubmissionHandoffResult[];
  finals: SubmissionFinalTransactionResult[];
  persistIntentError: boolean;
  persistSendIntentError: boolean;
  persistReceiptError: boolean;
  sendCountOnFinal: boolean;
  onIntent: (kind: "file_handoff" | "send") => void;
}> = {}): Fake {
  let pendingVerification: SubmissionFinalTransactionResult | undefined;
  const fake: Fake = {
    calls: [],
    sendPhases: [],
    intentKinds: [],
    finalModes: [],
    finalRequests: [],
    sendCalls: 0,
    legacyBaselineCalls: 0,
    persisted: [],
    stageObservations: [],
    attachmentObservations: [...(overrides.attachments ?? [])],
    handoffResults: [...(overrides.handoffs ?? [])],
    handoffRequests: [],
    finalResults: [...(overrides.finals ?? [])],
    privatePaths: ["/private/input/secret.txt"],
    async observeStaging(): Promise<SubmissionStageObservation> {
      fake.calls.push("observeStaging");
      const value = overrides.stage ?? { status: "exact", evidenceDigest: DIGEST };
      fake.stageObservations.push(value);
      return value;
    },
    async persistActionIntent(request: Parameters<SubmissionPorts["persistActionIntent"]>[0]) {
      fake.calls.push(`persistIntent:${request.kind}`);
      fake.intentKinds.push(request.kind);
      overrides.onIntent?.(request.kind);
      if (overrides.persistIntentError || (request.kind === "send" && overrides.persistSendIntentError)) throw new Error("journal unavailable");
    },
    async executeFileHandoffOnce(request: Parameters<SubmissionPorts["executeFileHandoffOnce"]>[0]): Promise<SubmissionHandoffResult> {
      fake.calls.push("handoff");
      fake.handoffRequests.push(request);
      const value: SubmissionHandoffResult = fake.handoffResults.shift() ?? { status: "satisfied", evidenceDigest: DIGEST_B };
      return value;
    },
    async observeAttachments(): Promise<SubmissionAttachmentObservation> {
      fake.calls.push("observeAttachments");
      const value: SubmissionAttachmentObservation = fake.attachmentObservations.shift() ?? { status: "exact", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] };
      return value;
    },
    async executeFinalTabTransaction(request: Parameters<SubmissionPorts["executeFinalTabTransaction"]>[0]) {
      fake.calls.push(`final:${request.mode}`);
      fake.finalModes.push(request.mode);
      fake.finalRequests.push(request);
      if (request.mode === "mutate_once" && overrides.sendCountOnFinal !== false) fake.sendCalls += 1;
      const value = fake.finalResults.shift() ?? {
        status: "submitted",
        targetBindingDigest: DIGEST,
        evidenceDigest: DIGEST_C,
        postSendDeltaDigest: DIGEST_B,
        userTurnId: USER_TURN_ID,
        userTurnEvidenceDigest: DIGEST_C
      } satisfies SubmissionFinalTransactionResult;
      return value;
    },
    async prepareSend() {
      fake.sendPhases.push("prepare");
      return {
        status: "prepared" as const,
        prepared: {
          prepared: Object.freeze({ opaque: true }),
          baseline: ownershipBaseline().baseline,
          evidenceDigest: DIGEST
        }
      };
    },
    async persistPreparedSend(request) {
      fake.sendPhases.push("persist");
      fake.calls.push("persistIntent:send");
      fake.intentKinds.push("send");
      overrides.onIntent?.("send");
      if (overrides.persistSendIntentError) return { status: "uncertain" as const, evidenceDigest: DIGEST_C };
      return { status: "committed" as const, executeAllowed: true };
    },
    async executePreparedSend(request) {
      fake.sendPhases.push("execute");
      const value = await fake.executeFinalTabTransaction({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        surface: request.surface,
        actionId: request.actionId,
        mode: "mutate_once",
        expected: request.expected,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
      });
      if (value.status === "blocked") return { status: "blocked" as const, result: value };
      if (value.status === "uncertain") return { status: "activation_threw" as const, activation: "activation_threw" as const, mutationMayHaveOccurred: true };
      pendingVerification = value;
      return { status: "activated" as const, activation: "activated" as const, mutationMayHaveOccurred: true };
    },
    async verifyPreparedSend(request) {
      fake.sendPhases.push("verify");
      if (pendingVerification !== undefined) {
        const value = pendingVerification;
        pendingVerification = undefined;
        return value;
      }
      const value = await fake.executeFinalTabTransaction({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        surface: request.surface,
        actionId: request.actionId,
        mode: "observe_only",
        expected: request.expected,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
      });
      return value;
    },
    async recoverSend(request) {
      fake.sendPhases.push("recover");
      return await fake.executeFinalTabTransaction({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        surface: request.surface,
        actionId: request.actionId,
        mode: "observe_only",
        expected: request.expected,
        durableBaseline: request.durableBaseline,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt })
      });
    },
    async persistOwnershipBaseline() {
      fake.legacyBaselineCalls += 1;
    },
    async persistReceiptEvidence(request: SubmissionPersistenceRequest) {
      fake.calls.push(`persist:${request.kind}`);
      fake.persisted.push(request);
      if (overrides.persistReceiptError) throw new Error("journal unavailable");
    }
  };
  return fake;
}

describe("transactional operation-aware submission", () => {
  it("has no browser or persistence side effect when cancelled before preparation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakePorts();
    const result = await runAtomicSubmission(snapshot(), expected(), fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "cancelled", blocker: { code: "operation_cancelled" } });
    expect(fake.sendPhases).toEqual([]);
    expect(fake.sendCalls).toBe(0);
    expect(fake.legacyBaselineCalls).toBe(0);
  });

  it("does not activate when preparation succeeds but atomic persistence does not commit", async () => {
    const fake = fakePorts();
    (fake as unknown as { persistPreparedSend: SubmissionPorts["persistPreparedSend"] }).persistPreparedSend = async () => ({
      status: "not_committed",
      blockerCode: "journal_unavailable",
      evidenceDigest: DIGEST_C
    });
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "journal_unavailable" } });
    expect(fake.sendPhases).toEqual(["prepare"]);
    expect(fake.sendCalls).toBe(0);
    expect(fake.legacyBaselineCalls).toBe(0);
  });

  it("rejects unsupported fields in prepared Send phase results", async () => {
    const fake = fakePorts();
    (fake as unknown as { prepareSend: SubmissionPorts["prepareSend"] }).prepareSend = async () => ({
      status: "prepared",
      prepared: {
        prepared: Object.freeze({ opaque: true }),
        baseline: ownershipBaseline().baseline,
        evidenceDigest: DIGEST
      },
      unexpected: "private"
    } as unknown as Awaited<ReturnType<NonNullable<SubmissionPorts["prepareSend"]>>>);
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "port_protocol_violation" } });
    expect(fake.sendPhases).toEqual([]);
    expect(fake.sendCalls).toBe(0);
  });

  it("quarantines a persistence commit-then-throw without guessing or executing", async () => {
    const fake = fakePorts();
    let committed = false;
    (fake as unknown as { persistPreparedSend: SubmissionPorts["persistPreparedSend"] }).persistPreparedSend = async () => {
      committed = true;
      throw new Error("append acknowledged after local failure");
    };
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(committed).toBe(true);
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "journal_unavailable", mutationBoundary: "send_may_have_occurred" } });
    expect(fake.sendPhases).toEqual(["prepare"]);
    expect(fake.sendCalls).toBe(0);
    expect(fake.legacyBaselineCalls).toBe(0);
  });

  it("does not execute after an atomic commit when cancellation arrives before mutation", async () => {
    const controller = new AbortController();
    const fake = fakePorts({ onIntent: kind => { if (kind === "send") controller.abort(); } });
    const result = await runAtomicSubmission(snapshot(), expected(), fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "operation_cancelled", mutationBoundary: "send_may_have_occurred" } });
    expect(fake.sendPhases).toEqual(["prepare", "persist"]);
    expect(fake.sendCalls).toBe(0);
    expect(fake.legacyBaselineCalls).toBe(0);
  });

  it("keeps the four Send phases ordered and never sends raw private material to atomic persistence", async () => {
    const fake = fakePorts();
    let persisted: unknown;
    const originalPersist = fake.persistPreparedSend!;
    (fake as unknown as { persistPreparedSend: SubmissionPorts["persistPreparedSend"] }).persistPreparedSend = async request => {
      persisted = request;
      return await originalPersist(request);
    };
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result.kind).toBe("submitted");
    expect(fake.sendPhases).toEqual(["prepare", "persist", "execute", "verify"]);
    expect(fake.legacyBaselineCalls).toBe(0);
    expect(JSON.stringify(persisted)).not.toContain("private");
    expect(JSON.stringify(persisted)).not.toContain("secret.txt");
    expect(JSON.stringify(persisted)).not.toContain("prompt");
  });

  it("reconciles an execute acts-then-throws result without a second execution", async () => {
    const fake = fakePorts({ finals: [
      { status: "uncertain", quarantine: "caller", evidenceDigest: DIGEST_C },
      {
        status: "already_submitted",
        targetBindingDigest: DIGEST,
        evidenceDigest: DIGEST_C,
        postSendDeltaDigest: DIGEST_B,
        userTurnId: USER_TURN_ID,
        userTurnEvidenceDigest: DIGEST_C
      }
    ] });
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "already_submitted", userTurnId: USER_TURN_ID });
    expect(fake.sendPhases).toEqual(["prepare", "persist", "execute", "verify"]);
    expect(fake.sendCalls).toBe(1);
  });

  it("keeps an ambiguity after execute and before verify observation-only", async () => {
    const fake = fakePorts({ finals: [
      { status: "submitted", targetBindingDigest: DIGEST, evidenceDigest: DIGEST_C, postSendDeltaDigest: DIGEST_B, userTurnId: USER_TURN_ID, userTurnEvidenceDigest: DIGEST_C },
      { status: "uncertain", quarantine: "provider", evidenceDigest: DIGEST_C }
    ] });
    (fake as unknown as { verifyPreparedSend: SubmissionPorts["verifyPreparedSend"] }).verifyPreparedSend = async request => {
      fake.sendPhases.push("verify");
      return { status: "uncertain", quarantine: "provider", evidenceDigest: DIGEST_C };
    };
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "ambiguous_submit" } });
    expect(fake.sendPhases).toEqual(["prepare", "persist", "execute", "verify"]);
    expect(fake.sendCalls).toBe(1);
  });

  it("recovers an atomic action baseline without preparing or executing again", async () => {
    const fake = fakePorts({ finals: [{
      status: "already_submitted",
      targetBindingDigest: DIGEST,
      evidenceDigest: DIGEST_C,
      postSendDeltaDigest: DIGEST_B,
      userTurnId: USER_TURN_ID,
      userTurnEvidenceDigest: DIGEST_C
    }] });
    const result = await runAtomicSubmission(snapshot({
      actions: { [SEND_ID]: sendAction() },
      phase: "send_pending",
      mutationBoundary: "send_may_have_occurred",
      ownershipBaseline: ownershipBaseline()
    }), expected(), fake);
    expect(result).toMatchObject({ kind: "already_submitted", userTurnId: USER_TURN_ID });
    expect(fake.sendPhases).toEqual(["recover"]);
    expect(fake.sendCalls).toBe(0);
    expect(fake.legacyBaselineCalls).toBe(0);
  });

  it("runs the no-file happy path with one final Send transaction", async () => {
    const fake = fakePorts();
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "submitted", operationId: OPERATION_ID, targetBindingDigest: DIGEST });
    expect(fake.calls).toEqual(["observeStaging", "persist:phase", "persistIntent:send", "final:mutate_once", "persist:receipt"]);
    expect(fake.sendCalls).toBe(1);
    expect(fake.persisted.every(value => JSON.stringify(value).includes("private") === false)).toBe(true);
  });

  it("propagates caller cancellation and deadline to the short final transaction", async () => {
    const fake = fakePorts();
    const controller = new AbortController();
    const deadlineAt = Date.now() + 5_000;
    const result = await runAtomicSubmission(snapshot(), expected(), fake, {
      signal: controller.signal,
      deadlineAt
    });

    expect(result).toMatchObject({ kind: "submitted" });
    expect(fake.finalRequests).toHaveLength(1);
    expect(fake.finalRequests[0]).toMatchObject({ signal: controller.signal, deadlineAt });
  });

  it("starts new snapshots prepared and does not duplicate ready persistence on resume", async () => {
    expect(snapshot().state.phase).toBe("prepared");
    const fake = fakePorts();
    const result = await runAtomicSubmission(snapshot({ phase: "ready" }), expected(), fake);
    expect(result.kind).toBe("submitted");
    expect(fake.calls).toEqual(["observeStaging", "persistIntent:send", "final:mutate_once", "persist:receipt"]);
    expect(fake.persisted.some(value => value.kind === "phase")).toBe(false);
  });

  it("rejects non-repeatable actions in the wrong phase and rejects incoherent action IDs", async () => {
    const preparedSend = await runAtomicSubmission(snapshot({
      actions: { [SEND_ID]: sendAction() },
      mutationBoundary: "send_may_have_occurred"
    }), expected(), fakePorts());
    expect(preparedSend).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const pendingSend = await runAtomicSubmission(snapshot({
      phase: "handoff_pending",
      mutationBoundary: "handoff_may_have_occurred",
      actions: { [SEND_ID]: sendAction() }
    }), expected(), fakePorts());
    expect(pendingSend).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const missingHandoffId = await runAtomicSubmission({
      ...fileSnapshot({ actions: { [HANDOFF_ID]: handoffAction() }, phase: "handoff_pending", mutationBoundary: "handoff_may_have_occurred" }),
      actionIds: { sendActionId: SEND_ID }
    }, expectedWithFile(), fakePorts());
    expect(missingHandoffId).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const unusedHandoffId = await runAtomicSubmission(snapshot({}, { fileHandoffActionId: HANDOFF_ID }), expected(), fakePorts());
    expect(unusedHandoffId).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const readyUnreceiptedHandoff = await runAtomicSubmission(fileSnapshot({
      phase: "ready",
      mutationBoundary: "handoff_may_have_occurred",
      actions: { [HANDOFF_ID]: handoffAction() }
    }), expectedWithFile(), fakePorts());
    expect(readyUnreceiptedHandoff).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
  });

  it("persists file intent before one handoff and waits outside the final tab transaction", async () => {
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "exact", evidenceDigest: DIGEST_B, count: 1, orderPolicy: "exact", identityDigests: [DIGEST_C] }
      ]
    });
    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake);
    expect(result.kind).toBe("submitted");
    expect(fake.calls).toEqual([
      "observeStaging",
      "observeAttachments",
      "persistIntent:file_handoff",
      "handoff",
      "observeAttachments",
      "persist:phase",
      "persistIntent:send",
      "final:mutate_once",
      "persist:receipt"
    ]);
    expect(fake.sendCalls).toBe(1);
    expect(fake.intentKinds).toEqual(["file_handoff", "send"]);
  });

  it("retries only read-only post-handoff observations until provider readiness settles", async () => {
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "delayed", evidenceDigest: DIGEST_B },
        { status: "ambiguous", evidenceDigest: DIGEST_B },
        { status: "exact", evidenceDigest: DIGEST_B, count: 1, orderPolicy: "exact", identityDigests: [DIGEST_C] }
      ]
    });

    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake);

    expect(result.kind).toBe("submitted");
    expect(fake.calls.filter(call => call === "handoff")).toHaveLength(1);
    expect(fake.calls.filter(call => call === "observeAttachments")).toHaveLength(4);
    expect(fake.sendCalls).toBe(1);
  });

  it("allows a recovered handoff with an exact postcondition to persist readiness and continue", async () => {
    const fake = fakePorts({
      attachments: [{ status: "exact", evidenceDigest: DIGEST_B, count: 1, orderPolicy: "exact", identityDigests: [DIGEST_C] }]
    });
    const result = await runAtomicSubmission(fileSnapshot({
      actions: { [HANDOFF_ID]: handoffAction() },
      phase: "handoff_pending",
      mutationBoundary: "handoff_may_have_occurred"
    }), expectedWithFile(), fake);
    expect(result.kind).toBe("submitted");
    expect(fake.calls).toEqual([
      "observeStaging",
      "observeAttachments",
      "persist:phase",
      "persistIntent:send",
      "final:mutate_once",
      "persist:receipt"
    ]);
    expect(fake.persisted[0]).toMatchObject({ kind: "phase", actionId: HANDOFF_ID, actionOutcome: "satisfied", mutationBoundary: "handoff_may_have_occurred" });
  });

  it("recovers the committed prefix after handoff intent fsync but before its phase event", async () => {
    const fake = fakePorts({
      attachments: [{ status: "exact", evidenceDigest: DIGEST_B, count: 1, orderPolicy: "exact", identityDigests: [DIGEST_C] }]
    });
    const result = await runAtomicSubmission(fileSnapshot({
      actions: { [HANDOFF_ID]: handoffAction() },
      phase: "prepared",
      mutationBoundary: "handoff_may_have_occurred"
    }), expectedWithFile(), fake);

    expect(result.kind).toBe("submitted");
    expect(fake.calls).not.toContain("handoff");
    expect(fake.persisted[0]).toMatchObject({
      kind: "phase",
      actionId: HANDOFF_ID,
      actionOutcome: "satisfied",
      mutationBoundary: "handoff_may_have_occurred"
    });
    expect(fake.sendCalls).toBe(1);
  });

  it("treats a recovered handoff intent as observation-only after a crash", async () => {
    const fake = fakePorts({ attachments: [{ status: "mismatch", evidenceDigest: DIGEST_B }] });
    const result = await runAtomicSubmission(fileSnapshot({ actions: { [HANDOFF_ID]: handoffAction() }, phase: "handoff_pending", mutationBoundary: "handoff_may_have_occurred" }), expectedWithFile(), fake);
    expect(result.kind).toBe("uncertain");
    expect((result as Extract<typeof result, { kind: "uncertain" }>).blocker.code).toBe("ambiguous_file_handoff");
    expect(fake.calls).not.toContain("handoff");
    expect(fake.sendCalls).toBe(0);
  });

  it("never retries a file handoff that acts then throws", async () => {
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "mismatch", evidenceDigest: DIGEST_B }
      ],
      handoffs: [{ status: "uncertain", quarantine: "caller" }]
    });
    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake);
    expect(result.kind).toBe("uncertain");
    expect(fake.calls.filter(call => call === "handoff")).toHaveLength(1);
    expect(fake.sendCalls).toBe(0);
  });

  it("preserves a deterministic changed-file blocker after the durable handoff intent", async () => {
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "absent", evidenceDigest: DIGEST_C, count: 0, orderPolicy: "exact", identityDigests: [] }
      ],
      handoffs: [{ status: "not_satisfied", blockerCode: "input_file_changed", evidenceDigest: DIGEST_C }]
    });
    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake);
    expect(result).toMatchObject({
      kind: "blocked",
      blocker: {
        code: "input_file_changed",
        mutationBoundary: "handoff_may_have_occurred",
        observationRequired: true
      }
    });
    expect(fake.calls.filter(call => call === "handoff")).toHaveLength(1);
    expect(fake.sendCalls).toBe(0);
  });

  it("stops after delayed or ambiguous attachment postconditions", async () => {
    const fake = fakePorts({
      attachments: [
        { status: "delayed", evidenceDigest: DIGEST_B },
        { status: "ambiguous", evidenceDigest: DIGEST_C }
      ],
      handoffs: [{ status: "uncertain", evidenceDigest: DIGEST_C, quarantine: "provider" }]
    });
    const result = await runAtomicSubmission(fileSnapshot({
      actions: { [HANDOFF_ID]: handoffAction() },
      phase: "handoff_pending",
      mutationBoundary: "handoff_may_have_occurred"
    }), expectedWithFile(), fake);
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "ambiguous_file_handoff" } });
    expect(fake.sendCalls).toBe(0);
  });

  it("does not retry or continue after cancellation during the one handoff", async () => {
    const controller = new AbortController();
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "mismatch", evidenceDigest: DIGEST_C }
      ],
      handoffs: [{ status: "uncertain", evidenceDigest: DIGEST_C, quarantine: "provider" }]
    });
    const originalHandoff = fake.executeFileHandoffOnce;
    (fake as unknown as { executeFileHandoffOnce: SubmissionPorts["executeFileHandoffOnce"] }).executeFileHandoffOnce = async request => {
      const result = await originalHandoff(request);
      controller.abort();
      return result;
    };
    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "operation_cancelled" } });
    expect(fake.calls.filter(call => call === "handoff")).toHaveLength(1);
    expect(fake.finalModes).toEqual([]);
  });

  it("threads the caller cancellation envelope through the one-shot handoff request", async () => {
    const controller = new AbortController();
    const deadlineAt = Date.now() + 1_000;
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "mismatch", evidenceDigest: DIGEST_C }
      ],
      handoffs: [{ status: "uncertain", quarantine: "caller" }]
    });

    await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake, {
      signal: controller.signal,
      deadlineAt
    });

    expect(fake.handoffRequests).toHaveLength(1);
    expect(fake.handoffRequests[0]?.signal).toBe(controller.signal);
    expect(fake.handoffRequests[0]?.deadlineAt).toBe(deadlineAt);
  });

  it("does not execute a handoff when cancellation races immediately after durable intent", async () => {
    const controller = new AbortController();
    const fake = fakePorts({
      attachments: [{ status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] }],
      onIntent: kind => { if (kind === "file_handoff") controller.abort(); }
    });
    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "operation_cancelled", mutationBoundary: "handoff_may_have_occurred" } });
    expect(fake.calls).not.toContain("handoff");
    expect(fake.sendCalls).toBe(0);
  });

  it("keeps the handoff boundary observable when cancellation follows a successful handoff", async () => {
    const controller = new AbortController();
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "exact", evidenceDigest: DIGEST_B, count: 1, orderPolicy: "exact", identityDigests: [DIGEST_C] }
      ]
    });
    const originalHandoff = fake.executeFileHandoffOnce;
    (fake as unknown as { executeFileHandoffOnce: SubmissionPorts["executeFileHandoffOnce"] }).executeFileHandoffOnce = async request => {
      const result = await originalHandoff(request);
      controller.abort();
      return result;
    };
    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake, { signal: controller.signal });
    expect(result).toMatchObject({
      kind: "cancelled",
      blocker: { code: "operation_cancelled", mutationBoundary: "handoff_may_have_occurred", observationRequired: true }
    });
    expect(fake.calls).not.toContain("final:mutate_once");
  });

  it("keeps the handoff boundary observable when later Send intent persistence fails", async () => {
    const fake = fakePorts({
      attachments: [
        { status: "absent", evidenceDigest: DIGEST_B, count: 0, orderPolicy: "exact", identityDigests: [] },
        { status: "exact", evidenceDigest: DIGEST_B, count: 1, orderPolicy: "exact", identityDigests: [DIGEST_C] }
      ],
      persistSendIntentError: true
    });
    const result = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake);
    expect(result).toMatchObject({
      kind: "uncertain",
      blocker: { code: "journal_unavailable", mutationBoundary: "send_may_have_occurred", observationRequired: true }
    });
    expect(fake.calls).not.toContain("final:mutate_once");
  });

  it("treats configuration drift as a blocker without staging mutation", async () => {
    const fake = fakePorts({
      stage: { status: "mismatch", reason: "configuration", evidenceDigest: DIGEST_B }
    });
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "configuration_drift" } });
    expect(fake.calls).toEqual(["observeStaging"]);
    expect(fake.sendCalls).toBe(0);
  });

  it("does not retry Send after an acts-then-throws outcome", async () => {
    const fake = fakePorts({ finals: [
      { status: "uncertain", quarantine: "caller", evidenceDigest: DIGEST_C },
      { status: "uncertain", quarantine: "provider", evidenceDigest: DIGEST_C }
    ] });
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "ambiguous_submit" } });
    expect(fake.finalModes).toEqual(["mutate_once", "observe_only"]);
    expect(fake.sendCalls).toBe(1);
  });

  it("does not execute Send when cancellation races immediately after durable Send intent", async () => {
    const controller = new AbortController();
    const fake = fakePorts({ onIntent: kind => { if (kind === "send") controller.abort(); } });
    const result = await runAtomicSubmission(snapshot(), expected(), fake, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "operation_cancelled", mutationBoundary: "send_may_have_occurred" } });
    expect(fake.finalModes).toEqual([]);
    expect(fake.sendCalls).toBe(0);
  });

  it("does not invoke Send when the final transaction reports missing or disabled Send", async () => {
    const fake = fakePorts({
      sendCountOnFinal: false,
      finals: [{ status: "blocked", blockerCode: "send_control_unavailable", evidenceDigest: DIGEST_C }]
    });
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "send_control_unavailable" } });
    expect(fake.sendCalls).toBe(0);
    expect(fake.finalModes).toEqual(["mutate_once"]);
  });

  it("fails closed on final configuration, composer, target, and concurrent-turn drift", async () => {
    for (const blockerCode of ["configuration_drift", "composer_drift", "target_binding_mismatch", "concurrent_user_turn"] as const) {
      const fake = fakePorts({ sendCountOnFinal: false, finals: [{ status: "blocked", blockerCode }] });
      const result = await runAtomicSubmission(snapshot(), expected(), fake);
      expect(result).toMatchObject({ kind: "blocked", blocker: { code: blockerCode } });
      expect(fake.sendCalls).toBe(0);
    }
  });

  it("allows cancellation before mutation but not overlap or retry once intent is durable", async () => {
    const before = new AbortController();
    before.abort();
    const beforeFake = fakePorts();
    const beforeResult = await runAtomicSubmission(snapshot(), expected(), beforeFake, { signal: before.signal });
    expect(beforeResult.kind).toBe("cancelled");
    expect(beforeFake.calls).toEqual([]);

    const during = new AbortController();
    const duringFake = fakePorts({ finals: [
      { status: "uncertain", evidenceDigest: DIGEST_C, quarantine: "provider" },
      { status: "uncertain", evidenceDigest: DIGEST_C, quarantine: "provider" }
    ] });
    const originalFinal = duringFake.executeFinalTabTransaction;
    (duringFake as unknown as { executeFinalTabTransaction: SubmissionPorts["executeFinalTabTransaction"] }).executeFinalTabTransaction = async request => {
      const result = await originalFinal(request);
      if (request.mode === "mutate_once") during.abort();
      return result;
    };
    const duringResultPromise = runAtomicSubmission(snapshot(), expected(), duringFake, { signal: during.signal });
    const duringResult = await duringResultPromise;
    expect(duringResult).toMatchObject({ kind: "uncertain", blocker: { code: "operation_cancelled" } });
    expect(duringFake.sendCalls).toBe(1);
    expect(duringFake.finalModes).toEqual(["mutate_once", "observe_only"]);
  });

  it("returns a protocol blocker for malformed port observations and never mutates", async () => {
    const fake = fakePorts();
    (fake as unknown as { observeStaging: SubmissionPorts["observeStaging"] }).observeStaging = async () => {
      fake.calls.push("observeStaging");
      return { status: "exact", evidenceDigest: "raw private prompt" } as unknown as SubmissionStageObservation;
    };
    const result = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "port_protocol_violation" } });
    expect(fake.sendCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reconciles an existing Send intent without invoking Send again", async () => {
    const fake = fakePorts({ finals: [{
      status: "already_submitted",
      targetBindingDigest: DIGEST,
      evidenceDigest: DIGEST_C,
      postSendDeltaDigest: DIGEST_B,
      userTurnId: USER_TURN_ID,
      userTurnEvidenceDigest: DIGEST_C
    }] });
    const result = await runAtomicSubmission(snapshot({
      actions: { [SEND_ID]: sendAction() },
      phase: "send_pending",
      mutationBoundary: "send_may_have_occurred",
      ownershipBaseline: ownershipBaseline()
    }), expected(), fake);
    expect(result).toMatchObject({ kind: "already_submitted", userTurnId: USER_TURN_ID });
    expect(fake.finalModes).toEqual(["observe_only"]);
    expect(fake.calls).toEqual(["final:observe_only", "persist:receipt"]);
    expect(fake.sendCalls).toBe(0);
  });

  it("does not persist a submitted receipt when target establishment returns no durable proof", async () => {
    const establishment = {
      targetBindingDigest: DIGEST,
      anchorDigest: DIGEST_B,
      causalSendActionId: SEND_ID,
      conversationId: "conversation-new",
      canonicalThreadUrl: "https://opaque.invalid/thread/" + "d".repeat(64),
      userTurnId: USER_TURN_ID,
      userTurnEvidenceDigest: DIGEST_C,
      postSendDeltaDigest: DIGEST_B,
      evidenceDigest: DIGEST_C
    } as const;
    const fake = fakePorts({ finals: [{
      status: "already_submitted",
      targetBindingDigest: DIGEST,
      evidenceDigest: DIGEST_C,
      postSendDeltaDigest: DIGEST_B,
      userTurnId: USER_TURN_ID,
      userTurnEvidenceDigest: DIGEST_C,
      targetEstablishment: establishment
    }] });
    (fake as unknown as { establishTarget: SubmissionPorts["establishTarget"] }).establishTarget = async () => undefined;
    const pendingTarget: NonNullable<OperationStateV1["target"]> = {
      providerId: "codex-chrome",
      browserId: "browser-1",
      tabId: "tab-1",
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
      newTargetAnchorDigest: DIGEST_B,
      blankTaskEvidenceDigest: DIGEST_C
    };
    const result = await runAtomicSubmission(snapshot({
      target: pendingTarget,
      actions: { [SEND_ID]: sendAction() },
      phase: "send_pending",
      mutationBoundary: "send_may_have_occurred",
      ownershipBaseline: ownershipBaseline(pendingTarget)
    }), expected(), fake);
    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "journal_unavailable" } });
    expect(fake.finalModes).toEqual(["observe_only"]);
    expect(fake.calls).not.toContain("persist:receipt");
    expect(fake.sendCalls).toBe(0);
  });

  it("reconciles an operation after a control action without treating the advanced boundary as corruption", async () => {
    const fake = fakePorts({ finals: [{
      status: "already_submitted",
      targetBindingDigest: DIGEST,
      evidenceDigest: DIGEST_C,
      postSendDeltaDigest: DIGEST_B,
      userTurnId: USER_TURN_ID,
      userTurnEvidenceDigest: DIGEST_C,
      assistantTurnId: "assistant-turn-1"
    }] });
    const result = await runAtomicSubmission(snapshot({
      actions: {
        [SEND_ID]: {
          ...sendAction(),
          outcome: "satisfied",
          receiptRevision: 3,
          receiptAt: AT,
          evidenceDigest: DIGEST_C
        },
        [STOP_ID]: {
          actionId: STOP_ID,
          kind: "stop",
          repeatPolicy: "observe_only_after_intent",
          requestDigest: DIGEST_B,
          targetDigest: DIGEST,
          intentRevision: 5,
          intentAt: AT,
          outcome: "satisfied",
          receiptRevision: 6,
          receiptAt: AT,
          evidenceDigest: DIGEST_C
        }
      },
      phase: "generating",
      revision: 6,
      mutationBoundary: "control_may_have_occurred",
      ownershipBaseline: ownershipBaseline()
    }), expected(), fake);

    expect(result).toMatchObject({ kind: "already_submitted", userTurnId: USER_TURN_ID });
    expect(fake.finalModes).toEqual(["observe_only"]);
    expect(fake.sendCalls).toBe(0);
  });

  it("returns an idempotent terminal receipt without touching the browser", async () => {
    const fake = fakePorts();
    const result = await runAtomicSubmission(snapshot({
      phase: "completed",
      revision: 4,
      mutationBoundary: "send_may_have_occurred",
      actions: {
        [SEND_ID]: {
          ...sendAction(),
          outcome: "satisfied",
          receiptRevision: 3,
          receiptAt: AT,
          evidenceDigest: DIGEST_C
        }
      },
      receipt: {
        schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
        operationId: OPERATION_ID,
        requestDigest: DIGEST,
        targetBindingDigest: DIGEST,
        userTurnId: USER_TURN_ID,
        assistantTurnId: "assistant-turn-1",
        ownershipEvidenceDigest: DIGEST_C,
        userTurnEvidenceDigest: DIGEST_B,
        contentAvailable: false,
        finishReason: "stop",
        artifacts: [],
        completedAt: AT
      } as OperationReceiptV1
    }), expected(), fake);
    expect(result.kind).toBe("completed_receipt");
    expect(result).toMatchObject({ kind: "completed_receipt", userTurnEvidenceDigest: DIGEST_B });
    expect(fake.calls).toEqual([]);
  });

  it("validates terminal receipt schema, response pairing, and artifact branches before recovery", async () => {
    const validReceipt = (): OperationReceiptV1 => ({
      schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: DIGEST,
      targetBindingDigest: DIGEST,
      userTurnId: USER_TURN_ID,
      assistantTurnId: "assistant-turn-1",
      ownershipEvidenceDigest: DIGEST_C,
      userTurnEvidenceDigest: DIGEST_B,
      responseDigest: DIGEST_B,
      responseBytes: 12,
      contentAvailable: true,
      finishReason: "stop",
      artifacts: [{
        schemaVersion: "chatgpt.browser_control.operation_artifact_receipt.v1",
        operationId: OPERATION_ID,
        artifactKey: "artifact-1",
        assistantTurnId: "assistant-turn-1",
        sourceIdentityDigest: DIGEST_C,
        kind: "file",
        ordinal: 0,
        outputKey: "result.txt",
        mimeType: "text/plain",
        bytes: 12,
        sha256: "d".repeat(64),
        status: "transferred"
      }],
      completedAt: AT
    });
    const completed = (receipt: OperationReceiptV1): SubmissionOperationSnapshot => snapshot({
      phase: "completed",
      revision: 4,
      mutationBoundary: "send_may_have_occurred",
      actions: {
        [SEND_ID]: {
          ...sendAction(),
          outcome: "satisfied",
          receiptRevision: 3,
          receiptAt: AT,
          evidenceDigest: DIGEST_C
        }
      },
      receipt
    });

    const valid = await runAtomicSubmission(completed(validReceipt()), expected(), fakePorts());
    expect(valid).toMatchObject({ kind: "completed_receipt", userTurnEvidenceDigest: DIGEST_B });

    const badResponsePair = validReceipt();
    delete (badResponsePair as Partial<OperationReceiptV1>).responseBytes;
    expect(await runAtomicSubmission(completed(badResponsePair), expected(), fakePorts())).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const badSchema = validReceipt();
    (badSchema as { schemaVersion: string }).schemaVersion = "wrong.v1";
    expect(await runAtomicSubmission(completed(badSchema), expected(), fakePorts())).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const badArtifact = validReceipt();
    const badArtifactEntry = badArtifact.artifacts[0]!;
    delete badArtifactEntry.outputKey;
    delete badArtifactEntry.bytes;
    delete badArtifactEntry.sha256;
    expect(await runAtomicSubmission(completed(badArtifact), expected(), fakePorts())).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const duplicateOrdinal = validReceipt();
    duplicateOrdinal.artifacts = [duplicateOrdinal.artifacts[0]!, { ...duplicateOrdinal.artifacts[0]!, artifactKey: "artifact-2" }];
    expect(await runAtomicSubmission(completed(duplicateOrdinal), expected(), fakePorts())).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const oversizedArtifacts = validReceipt();
    oversizedArtifacts.artifacts = Array.from({ length: 33 }, (_, ordinal) => ({
      ...oversizedArtifacts.artifacts[0]!,
      artifactKey: `artifact-${ordinal}`,
      ordinal
    }));
    expect(await runAtomicSubmission(completed(oversizedArtifacts), expected(), fakePorts())).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
  });

  it("rejects stale handles, target mismatches, reordered attachments, and unsafe raw identities", async () => {
    const staleBase = snapshot({ revision: 2 });
    const stale = {
      ...staleBase,
      handle: { ...staleBase.handle, revision: 1 }
    };
    const staleResult = await runAtomicSubmission(stale, expected(), fakePorts());
    expect(staleResult).toMatchObject({ kind: "blocked", blocker: { code: "stale_handle" } });

    const targetResult = await runAtomicSubmission(snapshot(), { ...expected(), targetBindingDigest: DIGEST_B }, fakePorts());
    expect(targetResult).toMatchObject({ kind: "blocked", blocker: { code: "target_binding_mismatch" } });

    const fake = fakePorts({ attachments: [{
      status: "exact",
      evidenceDigest: DIGEST_B,
      count: 1,
      orderPolicy: "exact",
      identityDigests: [DIGEST_B]
    }] });
    const reordered = await runAtomicSubmission(fileSnapshot(), expectedWithFile(), fake);
    expect(reordered).toMatchObject({ kind: "blocked", blocker: { code: "port_protocol_violation" } });
    expect(fake.sendCalls).toBe(0);
    expect(JSON.stringify(fake.calls)).not.toContain("secret.txt");
  });

  it("rejects raw expected fields, uppercase digests, duplicate manifests, and non-UUID action IDs", async () => {
    const rawExpected = { ...expected(), prompt: "private prompt", path: "/private/file.txt" } as unknown as SubmissionExpectedEnvelope;
    const rawFake = fakePorts();
    expect((await runAtomicSubmission(snapshot(), rawExpected, rawFake)).kind).toBe("blocked");
    expect(rawFake.calls).toEqual([]);

    const uppercase = { ...expected(), configurationReceiptDigest: DIGEST_B.toUpperCase() };
    expect((await runAtomicSubmission(snapshot(), uppercase, fakePorts())).kind).toBe("blocked");

    const duplicate = {
      ...expected(),
      attachmentManifest: {
        count: 2,
        orderPolicy: "exact" as const,
        identities: [{ ordinal: 0, identityDigest: DIGEST_C }, { ordinal: 1, identityDigest: DIGEST_C }]
      }
    };
    expect((await runAtomicSubmission(snapshot(), duplicate, fakePorts())).kind).toBe("blocked");

    expect((await runAtomicSubmission(snapshot({}), expected(), fakePorts())).kind).toBe("submitted");
    const invalidAction = await runAtomicSubmission({ ...snapshot(), actionIds: { sendActionId: "send-not-uuid", fileHandoffActionId: HANDOFF_ID } }, expected(), fakePorts());
    expect(invalidAction).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
  });

  it("rejects malformed options, unsafe fallback identities, and inconsistent target coordination evidence", async () => {
    const malformedSignal = await runAtomicSubmission(snapshot(), expected(), fakePorts(), {
      signal: {} as AbortSignal
    });
    expect(malformedSignal).toMatchObject({ kind: "blocked", blocker: { code: "port_protocol_violation" } });

    const hugeDeadline = await runAtomicSubmission(snapshot(), expected(), fakePorts(), {
      deadlineAt: Number.MAX_SAFE_INTEGER
    });
    expect(hugeDeadline).toMatchObject({ kind: "blocked", blocker: { code: "port_protocol_violation" } });

    const malformedOperation = {
      ...snapshot(),
      state: { ...snapshot().state, operationId: "private/raw-operation-id" }
    } as unknown as SubmissionOperationSnapshot;
    const fallback = await runAtomicSubmission(malformedOperation, expected(), fakePorts());
    expect(fallback.operationId).toBe("invalid-operation");
    expect(fallback.requestDigest).toBe(DIGEST);
    expect(fallback.targetBindingDigest).toBe(DIGEST);
    expect(fallback.requestDigest).not.toMatch(/^hmac-sha256:0+$/u);
    expect(fallback.targetBindingDigest).not.toMatch(/^hmac-sha256:0+$/u);
    expect(JSON.stringify(fallback)).not.toContain("private");

    const mismatchedExpected = await runAtomicSubmission(
      malformedOperation,
      { ...expected(), targetBindingDigest: DIGEST_B },
      fakePorts()
    );
    expect(mismatchedExpected).toMatchObject({
      kind: "blocked",
      targetBindingDigest: DIGEST
    });
    expect(mismatchedExpected.targetBindingDigest).not.toBe(DIGEST_B);

    let stateReads = 0;
    const hostile = { ...snapshot() } as SubmissionOperationSnapshot;
    Object.defineProperty(hostile, "state", {
      enumerable: true,
      get() {
        stateReads += 1;
        throw new Error("hostile state getter");
      }
    });
    const hostileResult = await runAtomicSubmission(hostile, expected(), fakePorts());
    expect(stateReads).toBe(0);
    expect(hostileResult).toMatchObject({
      kind: "blocked",
      blocker: { code: "operation_state_corrupt" },
      operationId: "invalid-operation",
      requestDigest: "invalid-digest"
    });
    expect("targetBindingDigest" in hostileResult).toBe(false);
    expect(JSON.stringify(hostileResult)).not.toContain("hmac-sha256:000000");

    const credentialedTarget = await runAtomicSubmission(snapshot({
      target: { ...snapshot().state.target!, canonicalThreadUrl: "https://user:secret@example.test/c/thread" }
    }), expected(), fakePorts());
    expect(credentialedTarget).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });

    const providerWithoutClaim = await runAtomicSubmission(snapshot({
      target: {
        ...snapshot().state.target!,
        coordinationScope: "provider",
        evidenceProfile: { ...snapshot().state.target!.evidenceProfile, authoritativeTabClaim: "unavailable" }
      }
    }), expected(), fakePorts());
    expect(providerWithoutClaim).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
  });

  it("passes a sanitized cloned envelope to the final port", async () => {
    const input = expected();
    const fake = fakePorts();
    let passed: SubmissionExpectedEnvelope | undefined;
    const originalFinal = fake.executeFinalTabTransaction;
    (fake as unknown as { executeFinalTabTransaction: SubmissionPorts["executeFinalTabTransaction"] }).executeFinalTabTransaction = async request => {
      passed = request.expected;
      (request.expected.attachmentManifest.identities as SubmissionExpectedEnvelope["attachmentManifest"]["identities"] & { push: (value: unknown) => number }).push({ identityDigest: DIGEST_B, ordinal: 0 });
      return originalFinal(request);
    };
    const result = await runAtomicSubmission(snapshot(), input, fake);
    expect(result.kind).toBe("submitted");
    expect(passed).not.toBe(input);
    expect(input.attachmentManifest.identities).toHaveLength(0);
    expect(JSON.stringify(passed)).not.toContain("prompt");
  });

  it("rejects extra fields in a port observation and includes the exact target in blocker persistence", async () => {
    const fake = fakePorts({
      stage: { status: "mismatch", reason: "configuration", evidenceDigest: DIGEST_B }
    });
    (fake as unknown as { observeStaging: SubmissionPorts["observeStaging"] }).observeStaging = async () => {
      fake.calls.push("observeStaging");
      return {
        status: "exact",
        evidenceDigest: DIGEST,
        prompt: "private prompt"
      } as unknown as SubmissionStageObservation;
    };
    const malformed = await runAtomicSubmission(snapshot(), expected(), fake);
    expect(malformed).toMatchObject({ kind: "blocked", blocker: { code: "port_protocol_violation" } });
    expect(fake.calls).toEqual(["observeStaging"]);

    const blockedFake = fakePorts({
      sendCountOnFinal: false,
      finals: [{ status: "blocked", blockerCode: "configuration_drift", evidenceDigest: DIGEST_C }]
    });
    const blocked = await runAtomicSubmission(snapshot(), expected(), blockedFake);
    expect(blocked).toMatchObject({ kind: "blocked", blocker: { code: "configuration_drift" } });
    expect(blockedFake.persisted.at(-1)).toMatchObject({ kind: "blocker", targetBindingDigest: DIGEST });
  });

  it("rejects a durable receipt outside completed or without a satisfied Send action", async () => {
    const receipt = {
      schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: DIGEST,
      targetBindingDigest: DIGEST,
      userTurnId: USER_TURN_ID,
      assistantTurnId: "assistant-turn-1",
      ownershipEvidenceDigest: DIGEST_C,
      userTurnEvidenceDigest: DIGEST_B,
      contentAvailable: false,
      finishReason: "stop",
      artifacts: [],
      completedAt: AT
    } as OperationReceiptV1;
    const wrongPhase = await runAtomicSubmission(snapshot({ receipt, phase: "ready", mutationBoundary: "none" }), expected(), fakePorts());
    expect(wrongPhase).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
    const wrongAction = await runAtomicSubmission(snapshot({
      receipt,
      phase: "completed",
      revision: 4,
      mutationBoundary: "send_may_have_occurred",
      actions: { [SEND_ID]: sendAction() }
    }), expected(), fakePorts());
    expect(wrongAction).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
  });
});

function expected(): SubmissionExpectedEnvelope {
  return {
    surface: "chat",
    targetBindingDigest: DIGEST,
    configurationReceiptDigest: DIGEST_B,
    composerReceiptDigest: DIGEST_C,
    attachmentManifest: { count: 0, orderPolicy: "exact", identities: [] }
  };
}

function expectedWithFile(): SubmissionExpectedEnvelope {
  return {
    ...expected(),
    attachmentManifest: { count: 1, orderPolicy: "exact", identities: [{ ordinal: 0, identityDigest: DIGEST_C }] }
  };
}

function fileSnapshot(overrides: Partial<OperationStateV1> = {}): SubmissionOperationSnapshot {
  return snapshot(overrides, { fileHandoffActionId: HANDOFF_ID });
}

function ownershipBaseline(
  stateTarget: NonNullable<OperationStateV1["target"]> = snapshot().state.target!
): OperationOwnershipBaselineV1 {
  const available = (value: string) => ({ status: "available" as const, value });
  const unavailable = (reason: "not_exposed" | "not_observed" | "redacted" = "not_observed") => ({
    status: "unavailable" as const,
    reason
  });
  const baselineTarget: OwnershipBaseline["target"] = {
    provider: available(stateTarget.providerId),
    browser: available(stateTarget.browserId),
    tab: available(stateTarget.tabId),
    thread: stateTarget.targetLifecycle === "new_pending" ? unavailable() : available("thread-1"),
    conversation: stateTarget.conversationId === undefined ? unavailable() : available(stateTarget.conversationId),
    canonicalThreadUrl: stateTarget.canonicalThreadUrl === undefined ? unavailable() : available(stateTarget.canonicalThreadUrl),
    authoritativeTabClaim: unavailable("not_exposed"),
    coordinationScope: stateTarget.coordinationScope
  };
  return {
    schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: DIGEST,
    targetBindingDigest: DIGEST,
    actionId: SEND_ID,
    baseline: {
      schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
      snapshotDigest: DIGEST_B,
      target: baselineTarget,
      userTurns: [],
      assistantTurns: [],
      completeness: "complete"
    },
    observedAt: AT
  };
}

function snapshot(overrides: Partial<OperationStateV1> = {}, actionIds: Partial<{ fileHandoffActionId: string }> = {}): SubmissionOperationSnapshot {
  const state: OperationStateV1 = {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: DIGEST,
    surface: "chat",
    phase: "prepared",
    mutationBoundary: "none",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    target: {
      providerId: "codex-chrome",
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
    actions: {},
    ...overrides
  };
  const handle = {
    schemaVersion: "chatgpt.browser_control.operation_handle.v1",
    operationId: OPERATION_ID,
    requestDigest: DIGEST,
    surface: "chat",
    revision: state.revision,
    phase: state.phase,
    mutationBoundary: state.mutationBoundary,
    targetBindingDigest: DIGEST
  } as const;
  return {
    state,
    handle: { ...handle },
    actionIds: { sendActionId: SEND_ID, ...actionIds }
  };
}

function sendAction(): OperationActionRecordV1 {
  return {
    actionId: SEND_ID,
    kind: "send",
    repeatPolicy: "observe_only_after_intent",
    requestDigest: DIGEST,
    targetDigest: DIGEST,
    intentRevision: 2,
    intentAt: AT
  };
}

function handoffAction(): OperationActionRecordV1 {
  return {
    actionId: HANDOFF_ID,
    kind: "file_handoff",
    repeatPolicy: "observe_only_after_intent",
    requestDigest: DIGEST,
    targetDigest: DIGEST,
    intentRevision: 2,
    intentAt: AT
  };
}
