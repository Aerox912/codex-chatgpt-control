import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationJournal } from "../../src/operations/journal.js";
import {
  assertOperationEventShape,
  reduceOperationEvents
} from "../../src/operations/state-machine.js";
import {
  OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
  OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
  type OperationEventV1,
  type OperationOwnershipBaselineV1,
  type OperationTargetBindingV1
} from "../../src/operations/types.js";
import { TURN_OWNERSHIP_SCHEMA_VERSION, type OwnershipBaseline } from "../../src/operations/turn-ownership.js";
import { runSendOnce, type SendOnceObservers } from "../../src/operations/send-once.js";
import type { LocatorLike, PageLike } from "../../src/types.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const SEND_ID = "22222222-2222-4222-8222-222222222222";
const STEER_ID = "33333333-3333-4333-8333-333333333333";
const AT = "2026-08-16T12:00:00.000Z";
const digest = (n: string): string => `hmac-sha256:${(/^[0-9a-f]$/.test(n) ? n : (n.charCodeAt(0) % 16).toString(16)).repeat(64)}`;

function target(): OperationTargetBindingV1 {
  return {
    providerId: "provider-1",
    browserId: "browser-1",
    tabId: "tab-1",
    coordinationScope: "process",
    conversationId: "conversation-1",
    canonicalThreadUrl: "https://chatgpt.com/c/conversation-1",
    evidenceProfile: {
      providerIdentity: "required",
      stableTabId: "required",
      stableConversationId: "required",
      stableUserTurnId: "required",
      authoritativeTabClaim: "unavailable",
      replacementTabRecovery: false
    }
  };
}

function ownershipTarget() {
  return {
    provider: { status: "available" as const, value: "provider-1" },
    browser: { status: "available" as const, value: "browser-1" },
    tab: { status: "available" as const, value: "tab-1" },
    thread: { status: "available" as const, value: "thread-1" },
    conversation: { status: "available" as const, value: "conversation-1" },
    canonicalThreadUrl: { status: "available" as const, value: "https://chatgpt.com/c/conversation-1" },
    authoritativeTabClaim: { status: "unavailable" as const, reason: "not_exposed" as const },
    coordinationScope: "process" as const
  };
}

function baseline(): OwnershipBaseline {
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest: digest("b"),
    target: ownershipTarget(),
    userTurns: [],
    assistantTurns: [],
    completeness: "complete"
  };
}

function prefix(): OperationEventV1[] {
  const requestDigest = digest("r");
  const bound = target();
  const targetBindingDigest = digest("t");
  return [
    { type: "operation_created", operationId: OPERATION_ID, requestDigest, surface: "chat", createdAt: AT },
    { type: "target_bound", target: bound, observedAt: AT },
    { type: "phase_changed", from: "prepared", to: "ready", mutationBoundary: "none", evidenceDigest: digest("e"), observedAt: AT },
    { type: "action_intent", action: { actionId: SEND_ID, kind: "send", repeatPolicy: "observe_only_after_intent", requestDigest, targetDigest: targetBindingDigest }, intentAt: AT }
  ];
}

function durableBaseline(): OperationOwnershipBaselineV1 {
  return {
    schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: digest("r"),
    targetBindingDigest: digest("t"),
    actionId: SEND_ID,
    baseline: baseline(),
    observedAt: AT
  };
}

function atomicPrepared(
  actionId: string,
  kind: "send" | "work_steer",
  actionRequestDigest: string,
  parentActionId?: string
): Extract<OperationEventV1, { type: "action_prepared" }> {
  return {
    type: "action_prepared",
    action: {
      actionId,
      kind,
      repeatPolicy: "observe_only_after_intent",
      requestDigest: actionRequestDigest,
      targetDigest: digest("t"),
      ...(parentActionId === undefined ? {} : { parentActionId })
    },
    intentAt: AT,
    baseline: {
      ...durableBaseline(),
      actionId,
      requestDigest: digest("r"),
      observedAt: AT
    }
  };
}

describe("durable pre-Send ownership baseline", () => {
  it("is appended after the causal intent and survives authenticated snapshot reload", async () => {
    const events = [...prefix(), { type: "ownership_baseline", baseline: durableBaseline() } satisfies OperationEventV1];
    const state = reduceOperationEvents(events);
    expect(state.ownershipBaseline?.baseline.snapshotDigest).toBe(digest("b"));
    expect(state.ownershipBaselines?.[SEND_ID]?.baseline.snapshotDigest).toBe(digest("b"));
    expect(state.submissionWitness).toBeUndefined();

    const root = await mkdtemp(join(tmpdir(), "codex-durable-baseline-"));
    try {
      const journal = await OperationJournal.open({ stateRoot: root });
      let loaded = await journal.create(events[0]! as Extract<OperationEventV1, { type: "operation_created" }>);
      for (const event of events.slice(1)) loaded = await journal.append(OPERATION_ID, loaded.state.revision, event);
      const snapshot = await journal.refreshSnapshot(OPERATION_ID);
      const reloaded = await journal.readSnapshot(OPERATION_ID);
      expect(snapshot.state.ownershipBaseline).toEqual(reloaded.state.ownershipBaseline);
      expect(snapshot.state.ownershipBaselines).toEqual(reloaded.state.ownershipBaselines);
      expect((await journal.load(OPERATION_ID)).state.ownershipBaseline).toEqual(loaded.state.ownershipBaseline);
      expect((await journal.load(OPERATION_ID)).state.ownershipBaselines).toEqual(loaded.state.ownershipBaselines);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects baseline writes before the action intent, conflicting duplicates, and private fields", () => {
    const beforeIntent = [
      prefix()[0]!,
      prefix()[1]!,
      prefix()[2]!,
      { type: "ownership_baseline", baseline: durableBaseline() } satisfies OperationEventV1
    ];
    expect(() => reduceOperationEvents(beforeIntent)).toThrow(/causal action intent|action intent/i);

    const event = { type: "ownership_baseline", baseline: durableBaseline() } satisfies OperationEventV1;
    const conflicting = { ...event, baseline: { ...event.baseline, targetBindingDigest: digest("x") } };
    expect(() => reduceOperationEvents([...prefix(), event, conflicting])).toThrow(/only one|duplicate|target/i);

    const hostile = { ...event, baseline: { ...event.baseline, baseline: { ...event.baseline.baseline, prompt: "secret" } } };
    expect(() => assertOperationEventShape(hostile)).toThrow();
  });

  it("rejects a baseline whose coordination scope differs from the durable target", () => {
    const event = {
      type: "ownership_baseline",
      baseline: {
        ...durableBaseline(),
        baseline: {
          ...durableBaseline().baseline,
          target: {
            ...ownershipTarget(),
            coordinationScope: "provider" as const,
            authoritativeTabClaim: { status: "available" as const, value: "claim-1" }
          }
        }
      }
    } satisfies OperationEventV1;
    expect(() => reduceOperationEvents([...prefix(), event])).toThrow(/target mismatch|coordination|disagrees/i);
  });

  it("atomically prepares Send and persists exactly one per-action baseline", () => {
    const atomic = atomicPrepared(SEND_ID, "send", digest("r"));
    const state = reduceOperationEvents([
      prefix()[0]!,
      prefix()[1]!,
      prefix()[2]!,
      atomic
    ]);
    expect(state.actions[SEND_ID]).toMatchObject({ kind: "send", intentAt: AT });
    expect(state.ownershipBaselines?.[SEND_ID]).toEqual(atomic.baseline);
    expect(state.ownershipBaseline).toEqual(atomic.baseline);
  });

  it("keeps the Send compatibility projection while recording Work-steer child-digest baselines", () => {
    const send = atomicPrepared(SEND_ID, "send", digest("r"));
    const steer = atomicPrepared(STEER_ID, "work_steer", digest("c"), SEND_ID);
    const state = reduceOperationEvents([
      prefix()[0]!,
      prefix()[1]!,
      prefix()[2]!,
      send,
      { type: "phase_changed", from: "ready", to: "send_pending", mutationBoundary: "send_may_have_occurred", causeActionId: SEND_ID, observedAt: AT },
      { type: "action_receipt", actionId: SEND_ID, outcome: "satisfied", evidenceDigest: digest("e"), observedAt: AT },
      {
        type: "submission_witness",
        witness: {
          schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
          actionId: SEND_ID,
          actionKind: "send",
          targetBindingDigest: digest("t"),
          baselineSnapshotDigest: digest("b"),
          postSendDeltaDigest: digest("d"),
          operationUserEvidenceDigest: digest("u"),
          userTurnId: "user-1",
          observedAt: AT
        }
      },
      { type: "phase_changed", from: "send_pending", to: "submitted", mutationBoundary: "send_may_have_occurred", causeActionId: SEND_ID, evidenceDigest: digest("e"), observedAt: AT },
      { type: "phase_changed", from: "submitted", to: "generating", mutationBoundary: "send_may_have_occurred", evidenceDigest: digest("e"), observedAt: AT },
      steer
    ]);
    expect(state.actions[STEER_ID]).toMatchObject({ kind: "work_steer", requestDigest: digest("c"), parentActionId: SEND_ID });
    expect(state.ownershipBaselines?.[STEER_ID]?.requestDigest).toBe(digest("r"));
    expect(state.ownershipBaseline?.actionId).toBe(SEND_ID);
    expect(state.ownershipBaseline?.requestDigest).toBe(digest("r"));
  });

  it("rejects atomic baseline mismatches, unsupported action kinds, timestamp drift, and accessors", () => {
    const valid = atomicPrepared(SEND_ID, "send", digest("r"));
    const prefixEvents = [prefix()[0]!, prefix()[1]!, prefix()[2]!];
    expect(() => reduceOperationEvents([...prefixEvents, {
      ...valid,
      baseline: { ...valid.baseline, actionId: "44444444-4444-4444-8444-444444444444" }
    }])).toThrow(/name the prepared action|action mismatch/i);
    expect(() => reduceOperationEvents([...prefixEvents, {
      ...valid,
      baseline: { ...valid.baseline, observedAt: "2026-08-16T12:00:01.000Z" }
    }])).toThrow(/equal.*intentAt|timestamp/i);
    expect(() => reduceOperationEvents([...prefixEvents, {
      ...valid,
      action: { ...valid.action, kind: "status_read" as const, repeatPolicy: "read_only" as const }
    }])).toThrow(/only for send or work_steer|requires a durable target/i);
    const accessor = structuredClone(valid) as Record<string, unknown>;
    Object.defineProperty(accessor, "baseline", { enumerable: true, get: () => { throw new Error("must not execute"); } });
    expect(() => reduceOperationEvents([...prefixEvents, accessor as unknown as OperationEventV1])).toThrow(/unsafe accessor|unsafe property/i);
  });

  it("does not accept a post-Send witness that disagrees with a durable baseline", () => {
    const baselineEvent = { type: "ownership_baseline", baseline: durableBaseline() } satisfies OperationEventV1;
    const witness = {
      type: "submission_witness",
      witness: {
        schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
        actionId: SEND_ID,
        actionKind: "send" as const,
        targetBindingDigest: digest("t"),
        baselineSnapshotDigest: digest("b"),
        postSendDeltaDigest: digest("d"),
        operationUserEvidenceDigest: digest("u"),
        userTurnId: "user-1",
        observedAt: AT
      }
    } satisfies OperationEventV1;
    const state = reduceOperationEvents([...prefix(), baselineEvent, witness]);
    expect(state.submissionWitness?.postSendDeltaDigest).toBe(digest("d"));
    const mismatched = { ...witness, witness: { ...witness.witness, actionId: "33333333-3333-4333-8333-333333333333" } };
    expect(() => reduceOperationEvents([...prefix(), baselineEvent, mismatched])).toThrow(/action|baseline/i);
  });

  it("persists the baseline before the only activation and fails closed when persistence rejects", async () => {
    const phases: string[] = [];
    let clicks = 0;
    const locator: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      evaluate: async <T>() => true as T,
      click: async () => { clicks += 1; phases.push("click"); }
    };
    const page: PageLike = { getByRole: () => locator };
    const expected = {
      surface: "chat" as const,
      targetBindingDigest: digest("t"),
      configurationReceiptDigest: digest("c"),
      composerReceiptDigest: digest("m"),
      attachmentManifest: { count: 0, orderPolicy: "exact" as const, identities: [] }
    };
    const full = baseline();
    const exact = {
      status: "exact" as const,
      targetBindingDigest: digest("t"),
      configurationReceiptDigest: digest("c"),
      composerReceiptDigest: digest("m"),
      attachments: { count: 0, orderPolicy: "exact" as const, identityDigests: [] },
      baseline: { userTurnEvidenceDigest: full.snapshotDigest, ownershipBaseline: full },
      evidenceDigest: digest("e")
    };
    const observers: SendOnceObservers = {
      observePrecondition: async () => exact,
      observePostcondition: async () => ({
        status: "submitted" as const,
        targetBindingDigest: digest("t"),
        evidenceDigest: digest("s"),
        userTurnId: "user-1",
        userTurnEvidenceDigest: digest("u"),
        postSendDeltaDigest: digest("d")
      })
    };
    const result = await runSendOnce({
      page,
      operationId: OPERATION_ID,
      requestDigest: digest("r"),
      surface: "chat",
      actionId: SEND_ID,
      mode: "mutate_once",
      expected,
      observers,
      persistPreSendBaseline: async value => {
        expect(value.snapshotDigest).toBe(full.snapshotDigest);
        phases.push("baseline");
      }
    });
    expect(result.status).toBe("submitted");
    expect(phases).toEqual(["baseline", "click"]);
    expect(clicks).toBe(1);

    clicks = 0;
    const rejected = await runSendOnce({
      page,
      operationId: OPERATION_ID,
      requestDigest: digest("r"),
      surface: "chat",
      actionId: SEND_ID,
      mode: "mutate_once",
      expected,
      observers,
      persistPreSendBaseline: async () => { throw new Error("append failed"); }
    });
    expect(rejected).toEqual({ status: "blocked", blockerCode: "journal_unavailable" });
    expect(clicks).toBe(0);
  });

  it("uses the service-projected durable baseline for observe-only recovery", async () => {
    let preconditionCalls = 0;
    let observedBaseline: OwnershipBaseline | undefined;
    const locator: LocatorLike = { count: async () => 0, isVisible: async () => false };
    const observers: SendOnceObservers = {
      observePrecondition: async () => { preconditionCalls += 1; throw new Error("must not read a new baseline"); },
      observePostcondition: async request => {
        observedBaseline = request.baseline.ownershipBaseline;
        return {
          status: "already_submitted" as const,
          targetBindingDigest: digest("t"),
          evidenceDigest: digest("s"),
          userTurnId: "user-1",
          userTurnEvidenceDigest: digest("u"),
          postSendDeltaDigest: digest("d")
        };
      }
    };
    const expected = {
      surface: "chat" as const,
      targetBindingDigest: digest("t"),
      configurationReceiptDigest: digest("c"),
      composerReceiptDigest: digest("m"),
      attachmentManifest: { count: 0, orderPolicy: "exact" as const, identities: [] }
    };
    const result = await runSendOnce({
      page: { getByRole: () => locator },
      operationId: OPERATION_ID,
      requestDigest: digest("r"),
      surface: "chat",
      actionId: SEND_ID,
      mode: "observe_only",
      expected,
      observers,
      durableBaseline: baseline()
    });
    expect(result.status).toBe("already_submitted");
    expect(preconditionCalls).toBe(0);
    expect(observedBaseline?.snapshotDigest).toBe(baseline().snapshotDigest);
  });
});
