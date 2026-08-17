import { describe, expect, it } from "vitest";
import {
  OPERATION_STAGING_RECEIPT_SCHEMA_VERSION,
  runOperationStaging,
  type OperationStagingIntentPersistenceRequest,
  type OperationStagingIntentResult,
  type OperationStagingKind,
  type OperationStagingMutationResult,
  type OperationStagingObservation,
  type OperationStagingPorts,
  type OperationStagingReceipt,
  type OperationStagingReceiptPersistenceRequest,
  type OperationStagingRequest
} from "../../src/operations/staging.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `hmac-sha256:${"b".repeat(64)}`;
const DESIRED_DIGEST = `hmac-sha256:${"c".repeat(64)}`;
const CURRENT_DIGEST = `hmac-sha256:${"d".repeat(64)}`;
const EVIDENCE_DIGEST = `hmac-sha256:${"e".repeat(64)}`;
const AT = Date.parse("2026-08-16T12:00:00.000Z");

type FakeOptions = Readonly<{
  initial?: OperationStagingObservation;
  observations?: OperationStagingObservation[];
  intent?: OperationStagingIntentResult;
  mutationResult?: OperationStagingMutationResult;
  mutationError?: Error;
  receiptError?: Error;
  abortOnIntent?: AbortController;
}>;

type Fake = OperationStagingPorts & {
  calls: string[];
  callbackRequests: Array<Readonly<Record<string, unknown>>>;
  persistedIntents: OperationStagingIntentPersistenceRequest[];
  persistedReceipts: OperationStagingReceiptPersistenceRequest[];
  mutationCount: number;
};

function request(kind: OperationStagingKind = "configuration_set"): OperationStagingRequest {
  return {
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    actionId: ACTION_ID,
    kind,
    desiredStateDigest: DESIRED_DIGEST
  };
}

function observation(
  status: "satisfied" | "not_satisfied" = "not_satisfied",
  overrides: Partial<Extract<OperationStagingObservation, { status: "satisfied" | "not_satisfied" }>> = {}
): Extract<OperationStagingObservation, { status: "satisfied" | "not_satisfied" }> {
  return {
    status,
    desiredStateDigest: DESIRED_DIGEST,
    currentStateDigest: status === "satisfied" ? DESIRED_DIGEST : CURRENT_DIGEST,
    evidenceDigest: EVIDENCE_DIGEST,
    ...overrides
  };
}

function fakePorts(options: FakeOptions = {}): Fake {
  const reads = [...(options.observations ?? [])];
  const mutationCounter = { value: 0 };
  const fake: Partial<Fake> = {
    calls: [],
    callbackRequests: [],
    persistedIntents: [],
    persistedReceipts: [],
    mutationCount: mutationCounter.value
  };
  const ports: OperationStagingPorts = {
    readCurrent: async requestValue => {
      fake.calls!.push("readCurrent");
      fake.callbackRequests!.push(requestValue);
      return options.initial ?? observation();
    },
    persistIntent: async requestValue => {
      fake.calls!.push("persistIntent");
      fake.persistedIntents!.push(requestValue);
      options.abortOnIntent?.abort();
      return options.intent ?? { status: "created" };
    },
    mutateOnce: async requestValue => {
      fake.calls!.push("mutateOnce");
      fake.callbackRequests!.push(requestValue);
      mutationCounter.value += 1;
      if (options.mutationError !== undefined) throw options.mutationError;
      return options.mutationResult ?? { status: "started" };
    },
    observe: async requestValue => {
      fake.calls!.push("observe");
      fake.callbackRequests!.push(requestValue);
      return reads.shift() ?? observation("satisfied");
    },
    persistReceipt: async requestValue => {
      fake.calls!.push("persistReceipt");
      if (options.receiptError !== undefined) throw options.receiptError;
      fake.persistedReceipts!.push(requestValue);
    }
  };
  const result = Object.assign(ports, fake) as Fake;
  Object.defineProperty(result, "mutationCount", {
    configurable: true,
    enumerable: true,
    get: () => mutationCounter.value
  });
  return result;
}

function uncertainObservation(code = "browser_bridge_unavailable"): OperationStagingObservation {
  return {
    status: "uncertain",
    desiredStateDigest: DESIRED_DIGEST,
    blockerCode: code,
    evidenceDigest: EVIDENCE_DIGEST
  };
}

describe("operation-aware set-to-value staging", () => {
  it.each<OperationStagingKind>([
    "configuration_set",
    "tool_set",
    "composer_set",
    "power_select"
  ])("supports %s with a desired state that is already satisfied", async kind => {
    const fake = fakePorts({ initial: observation("satisfied") });
    const result = await runOperationStaging(request(kind), fake, { now: () => AT });

    expect(result.kind).toBe("completed");
    expect(result.stagingKind).toBe(kind);
    expect(fake.calls).toEqual(["readCurrent", "persistIntent", "observe", "persistReceipt"]);
    expect(fake.mutationCount).toBe(0);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({
      schemaVersion: OPERATION_STAGING_RECEIPT_SCHEMA_VERSION,
      outcome: "satisfied",
      mutation: "not_attempted",
      actionId: ACTION_ID,
      kind,
      desiredStateDigest: DESIRED_DIGEST
    });
  });

  it("reads exact state, persists intent, mutates once, and reconciles the exact postcondition", async () => {
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      observations: [observation("not_satisfied"), observation("satisfied")]
    });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result.kind).toBe("completed");
    expect(fake.calls).toEqual(["readCurrent", "persistIntent", "observe", "mutateOnce", "observe", "persistReceipt"]);
    expect(fake.mutationCount).toBe(1);
    expect(fake.persistedIntents[0]).toEqual({ identity: request() });
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "satisfied", mutation: "attempted" });
  });

  it("does not persist raw desired values, prompts, paths, or content in callback requests", async () => {
    const fake = fakePorts({ initial: observation("satisfied") });
    const result = await runOperationStaging(request("composer_set"), fake, { now: () => AT });
    expect(result.kind).toBe("completed");
    const serialized = JSON.stringify({ intents: fake.persistedIntents, receipts: fake.persistedReceipts, requests: fake.callbackRequests });
    expect(serialized).not.toContain("private prompt text");
    expect(serialized).not.toContain("/example/user/file.txt");
    expect(serialized).not.toContain("private response content");
    expect(Object.keys(fake.persistedIntents[0] ?? {})).toEqual(["identity"]);
    expect(Object.isFrozen(fake.persistedIntents[0]?.identity)).toBe(true);
  });

  it("never retries after an acts-then-throws callback", async () => {
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      mutationError: new Error("bridge rejected after provider accepted"),
      observations: [observation("not_satisfied"), observation("satisfied")]
    });
    const result = await runOperationStaging(request("tool_set"), fake, { now: () => AT });

    expect(result.kind).toBe("completed");
    expect(fake.calls).toEqual(["readCurrent", "persistIntent", "observe", "mutateOnce", "observe", "persistReceipt"]);
    expect(fake.mutationCount).toBe(1);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "satisfied", mutation: "attempted" });
  });

  it("records drift without retrying a set-to-value mutation", async () => {
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      observations: [
        observation("not_satisfied"),
        observation("not_satisfied", { currentStateDigest: CURRENT_DIGEST })
      ]
    });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result.kind).toBe("blocked");
    expect(result).toMatchObject({ blocker: { code: "staging_not_satisfied", observationRequired: true } });
    expect(fake.mutationCount).toBe(1);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "not_satisfied", mutation: "attempted" });
  });

  it("avoids mutation when post-intent reconciliation proves the value is now satisfied", async () => {
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      observations: [observation("satisfied")]
    });
    const result = await runOperationStaging(request("composer_set"), fake, { now: () => AT });

    expect(result.kind).toBe("completed");
    expect(fake.calls).toEqual(["readCurrent", "persistIntent", "observe", "persistReceipt"]);
    expect(fake.mutationCount).toBe(0);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "satisfied", mutation: "not_attempted" });
  });

  it("does not trust a satisfied read that becomes stale while the intent is persisted", async () => {
    const fake = fakePorts({
      initial: observation("satisfied"),
      observations: [observation("not_satisfied"), observation("satisfied")]
    });

    const result = await runOperationStaging(request("composer_set"), fake, { now: () => AT });

    expect(result.kind).toBe("completed");
    expect(fake.calls).toEqual(["readCurrent", "persistIntent", "observe", "mutateOnce", "observe", "persistReceipt"]);
    expect(fake.mutationCount).toBe(1);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "satisfied", mutation: "attempted" });
  });

  it("refuses an unavailable exact read before recording intent or mutating", async () => {
    const fake = fakePorts({ initial: uncertainObservation() });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "browser_bridge_unavailable" } });
    expect(fake.calls).toEqual(["readCurrent"]);
    expect(fake.persistedIntents).toHaveLength(0);
    expect(fake.mutationCount).toBe(0);
  });

  it("honours cancellation before browser access", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakePorts();
    const result = await runOperationStaging(request(), fake, { signal: controller.signal, now: () => AT });
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_cancelled", mutation: "not_attempted" } });
    expect(fake.calls).toEqual([]);
  });

  it("persists a not-satisfied receipt when cancellation arrives after intent but before mutation", async () => {
    const controller = new AbortController();
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      abortOnIntent: controller
    });
    const result = await runOperationStaging(request(), fake, { signal: controller.signal, now: () => AT });

    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_cancelled", mutation: "not_attempted" } });
    expect(fake.calls).toEqual(["readCurrent", "persistIntent", "persistReceipt"]);
    expect(fake.mutationCount).toBe(0);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "not_satisfied", mutation: "not_attempted", blockerCode: "operation_cancelled" });
  });

  it("settles an uncertain receipt when cancellation prevents postcondition observation", async () => {
    const controller = new AbortController();
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      mutationError: new Error("cancelled bridge call"),
      observations: [observation("not_satisfied"), uncertainObservation("operation_cancelled")]
    });
    const result = await runOperationStaging(request(), fake, {
      signal: controller.signal,
      now: () => AT
    });

    expect(result.kind).toBe("uncertain");
    expect(result).toMatchObject({ blocker: { code: "operation_cancelled", mutation: "attempted" } });
    expect(fake.mutationCount).toBe(1);
    expect(fake.persistedReceipts[0]?.receipt).toMatchObject({ outcome: "uncertain", mutation: "attempted", blockerCode: "operation_cancelled" });
  });

  it("honours an expired deadline before the one-shot mutation", async () => {
    const fake = fakePorts({ initial: observation("not_satisfied") });
    let clockReads = 0;
    const result = await runOperationStaging(request(), fake, {
      deadlineAt: AT + 1,
      now: () => {
        const read = clockReads++;
        return read === 0 ? AT - 1 : read === 1 ? AT : AT + 1;
      }
    });

    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_timeout", mutation: "not_attempted" } });
    expect(fake.calls).toEqual(["readCurrent"]);
    expect(fake.mutationCount).toBe(0);
  });

  it("reconciles an existing unsettled action observation-only", async () => {
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      intent: { status: "existing_unsettled" },
      observations: [observation("satisfied")]
    });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result.kind).toBe("completed");
    expect(fake.calls).toEqual(["readCurrent", "persistIntent", "observe", "persistReceipt"]);
    expect(fake.mutationCount).toBe(0);
  });

  it("returns an existing settled receipt idempotently without another observation or mutation", async () => {
    const settled: OperationStagingReceipt = {
      schemaVersion: OPERATION_STAGING_RECEIPT_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      actionId: ACTION_ID,
      kind: "power_select",
      desiredStateDigest: DESIRED_DIGEST,
      outcome: "satisfied",
      mutation: "attempted",
      currentStateDigest: DESIRED_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: "2026-08-16T12:00:00.000Z"
    };
    const fake = fakePorts({
      initial: observation("satisfied"),
      intent: { status: "existing_settled", receipt: settled }
    });
    const result = await runOperationStaging(request("power_select"), fake, { now: () => AT });

    expect(result).toMatchObject({ kind: "completed", receipt: settled, stagingKind: "power_select" });
    expect(fake.calls).toEqual(["readCurrent", "persistIntent"]);
    expect(fake.mutationCount).toBe(0);
    expect(fake.persistedReceipts).toHaveLength(0);
  });

  it("fails closed on malformed observations and never mutates", async () => {
    const fake = fakePorts({
      initial: {
        status: "satisfied",
        desiredStateDigest: DESIRED_DIGEST,
        currentStateDigest: DESIRED_DIGEST,
        evidenceDigest: EVIDENCE_DIGEST,
        prompt: "private prompt text"
      } as unknown as OperationStagingObservation
    });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "port_protocol_violation", mutation: "not_attempted" } });
    expect(fake.calls).toEqual(["readCurrent"]);
    expect(fake.mutationCount).toBe(0);
    expect(fake.persistedIntents).toHaveLength(0);
  });

  it("rejects an observation bound to a different desired value before intent", async () => {
    const fake = fakePorts({
      initial: {
        status: "not_satisfied",
        desiredStateDigest: TARGET_DIGEST,
        currentStateDigest: CURRENT_DIGEST,
        evidenceDigest: EVIDENCE_DIGEST
      } as unknown as OperationStagingObservation
    });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "target_binding_mismatch", mutation: "not_attempted" } });
    expect(fake.calls).toEqual(["readCurrent"]);
    expect(fake.persistedIntents).toHaveLength(0);
    expect(fake.mutationCount).toBe(0);
  });

  it("records a protocol violation after a malformed mutation result without retrying", async () => {
    const fake = fakePorts({
      initial: observation("not_satisfied"),
      mutationResult: { status: "toggle_again" } as unknown as OperationStagingMutationResult,
      observations: [observation("not_satisfied"), observation("satisfied")]
    });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result.kind).toBe("completed");
    expect(result.receipt).toMatchObject({ outcome: "satisfied", mutation: "attempted", blockerCode: "port_protocol_violation" });
    expect(fake.mutationCount).toBe(1);
    expect(fake.calls.filter(call => call === "mutateOnce")).toHaveLength(1);
  });

  it("returns uncertainty when the journal cannot durably persist the receipt", async () => {
    const fake = fakePorts({ initial: observation("satisfied"), receiptError: new Error("disk unavailable") });
    const result = await runOperationStaging(request(), fake, { now: () => AT });

    expect(result).toMatchObject({ kind: "uncertain", blocker: { code: "journal_unavailable", observationRequired: true } });
    expect("receipt" in result).toBe(false);
    expect(fake.mutationCount).toBe(0);
  });

  it("rejects binding-shape violations before invoking a port", async () => {
    const fake = fakePorts();
    const malformed = { ...request(), requestDigest: "not-a-digest" } as unknown as OperationStagingRequest;
    const result = await runOperationStaging(malformed, fake, { now: () => AT });
    expect(result).toMatchObject({ kind: "blocked", blocker: { code: "operation_state_corrupt" } });
    expect(fake.calls).toEqual([]);
  });

  it("does not invoke accessor-backed identity or fabricate valid digest evidence", async () => {
    let operationReads = 0;
    const hostile = { ...request() } as OperationStagingRequest;
    Object.defineProperty(hostile, "operationId", {
      enumerable: true,
      get() {
        operationReads += 1;
        throw new Error("hostile operation getter");
      }
    });
    const fake = fakePorts();
    const result = await runOperationStaging(hostile, fake, { now: () => AT });

    expect(operationReads).toBe(0);
    expect(result).toMatchObject({
      kind: "blocked",
      blocker: { code: "port_protocol_violation" },
      operationId: "invalid-operation",
      actionId: ACTION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      desiredStateDigest: DESIRED_DIGEST
    });
    expect(result.requestDigest).not.toMatch(/^hmac-sha256:0+$/u);
    expect(result.targetBindingDigest).not.toMatch(/^hmac-sha256:0+$/u);
    expect(result.desiredStateDigest).not.toMatch(/^hmac-sha256:0+$/u);
    expect(fake.calls).toEqual([]);

    const missing = await runOperationStaging({} as OperationStagingRequest, fakePorts(), { now: () => AT });
    expect(missing).toMatchObject({
      kind: "blocked",
      operationId: "invalid-operation",
      actionId: "invalid-action",
      requestDigest: "invalid-digest",
      targetBindingDigest: "invalid-digest",
      desiredStateDigest: "invalid-desired-state-digest"
    });
    expect(JSON.stringify(missing)).not.toContain("hmac-sha256:000000");
  });
});
