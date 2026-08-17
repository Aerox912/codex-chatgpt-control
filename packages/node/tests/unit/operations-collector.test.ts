import { describe, expect, it, vi } from "vitest";
import {
  COLLECTOR_SCHEMA_VERSION,
  COLLECTOR_TERMINAL_SCHEMA_VERSION,
  collectOperation,
  type CollectorArtifact,
  type CollectorDurableSnapshot,
  type CollectorObservation,
  type CollectorPorts
} from "../../src/operations/collector.js";
import {
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
  type OperationHandleV1,
  type OperationStateV1
} from "../../src/operations/types.js";
import {
  TURN_OWNERSHIP_SCHEMA_VERSION,
  type OwnershipBaseline,
  type OwnershipBinding,
  type OwnershipSnapshot,
  type OwnershipTargetEvidence,
  type OwnershipTurn
} from "../../src/operations/turn-ownership.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const WORK_ACTION_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_DIGEST = digest("r");
const WORK_REQUEST_DIGEST = digest("w");
const TARGET_DIGEST = digest("t");
const BASELINE_DIGEST = digest("b");
const WORK_BASELINE_DIGEST = digest("c");
const SNAPSHOT_DIGEST = digest("s");
const WORK_SNAPSHOT_DIGEST = digest("k");
const USER_DIGEST = digest("u");
const WORK_USER_DIGEST = digest("2");
const ASSISTANT_DIGEST = digest("a");
const WORK_DELTA_DIGEST = digest("3");
const TEXT_DIGEST = digest("x");
const ARTIFACT_DIGEST = digest("f");
const AT = "2026-08-16T12:00:00.000Z";

describe("collect-only operation orchestration", () => {
  it("keeps durable content/format/artifact policy immutable after restart", async () => {
    const durablePolicy = {
      responseContent: "metadata" as const,
      responseFormat: "text" as const,
      artifacts: "transfer" as const
    };
    const durable = makeDurable({ state: makeState({ capturePolicy: durablePolicy }) });
    const restarted = structuredClone(durable);
    expect(restarted.state.capturePolicy).toEqual(durablePolicy);
    expect(JSON.stringify(restarted)).not.toContain("outputDirectory");

    const escalatedContent = await collectOperation(handle(), makePorts(restarted, { snapshot: makeSnapshot() }), {
      responseContent: "include",
      responseFormat: "text"
    });
    expect(codeOf(escalatedContent)).toBe("operation_request_mismatch");

    const mismatchedFormat = await collectOperation(handle(), makePorts(restarted, { snapshot: makeSnapshot() }), {
      responseContent: "metadata",
      responseFormat: "markdown"
    });
    expect(codeOf(mismatchedFormat)).toBe("operation_request_mismatch");
  });

  it("exposes no mutation port and never accepts a page-wide latest fallback", async () => {
    const oldUser = user("old-user", digest("o"), 0);
    const operationUser = user("operation-user", USER_DIGEST, 1);
    const oldAssistant = assistant("old-assistant", oldUser.stableId!, "terminal", 0);
    const unrelatedLatest = assistant("latest-unrelated", oldUser.stableId!, "terminal", 1);
    const baseline = makeBaseline({ userTurns: [oldUser], assistantTurns: [oldAssistant] });
    const durable = makeDurable({
      baseline,
      state: makeStateWithBaseline(baseline)
    });
    const ports = makePorts(durable, {
      snapshot: makeSnapshot({
        userTurns: [oldUser, operationUser],
        assistantTurns: [oldAssistant, unrelatedLatest],
        postSendDelta: {
          baselineSnapshotDigest: BASELINE_DIGEST,
          addedUserEvidenceDigests: [operationUser.evidenceDigest],
          deltaDigest: digest("d")
        },
        terminalState: "terminal"
      }),
      terminal: terminal({
        userTurnId: operationUser.stableId!,
        assistantTurnId: unrelatedLatest.stableId!,
        userTurnEvidenceDigest: operationUser.evidenceDigest,
        assistantTurnEvidenceDigest: unrelatedLatest.evidenceDigest,
        assistantOrdinal: 1,
        branchStableId: unrelatedLatest.branchStableId!
      })
    });

    expect(Object.keys(ports).sort()).toEqual(["observe", "persistProgress", "persistTerminal", "readDurable", "sleep"]);
    expect("send" in ports).toBe(false);
    const result = await collectOperation(handle(), ports);
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" ? result.blocker.code : undefined).toBe("turn_ownership_ambiguous");
    expect(JSON.stringify(result)).not.toContain("latest-unrelated");
  });

  it.each([
    ["text", [] as CollectorArtifact[]],
    ["image", [artifact("image", ARTIFACT_DIGEST)]],
    ["file", [artifact("file", ARTIFACT_DIGEST)]],
    ["mixed", [artifact("image", ARTIFACT_DIGEST, 0), artifact("file", digest("g"), 1)]]
  ])("returns the exact owned terminal turn with %s artifact parity and redacted text metadata", async (_kind, artifacts) => {
    const durable = makeDurable();
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0, {
      artifactEvidenceDigests: artifacts.map(item => item.sourceIdentityDigest)
    });
    const ports = makePorts(durable, {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: {
          baselineSnapshotDigest: BASELINE_DIGEST,
          addedUserEvidenceDigests: [currentUser.evidenceDigest],
          deltaDigest: digest("d")
        }
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        artifacts,
        text: { digest: TEXT_DIGEST, bytes: 11, chars: 11 }
      })
    });

    const result = await collectOperation(handle(), ports);
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.turn).toMatchObject({
      userTurnId: currentUser.stableId,
      assistantTurnId: currentAssistant.stableId,
      userOrdinal: 0,
      assistantOrdinal: 0,
      assistantEvidenceDigest: currentAssistant.evidenceDigest
    });
    expect(result.response.text).toEqual({ digest: TEXT_DIGEST, bytes: 11, chars: 11 });
    expect(result.response.artifacts).toEqual(artifacts.map(item => ({
      ...item,
      sha256: item.contentDigest?.slice("sha256:".length),
      status: "available" as const
    })));
    expect(JSON.stringify(result)).not.toContain("secret response");
    expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it("persists the redacted terminal receipt before returning raw text from the live turn", async () => {
    const durable = makeDurable();
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0);
    const observation: CollectorObservation = {
      schemaVersion: COLLECTOR_SCHEMA_VERSION,
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: delta(currentUser)
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        branchStableId: currentAssistant.branchStableId!,
        text: { digest: TEXT_DIGEST, bytes: 15, chars: 15 },
        responseFormat: "markdown",
        rawText: "secret response"
      })
    };
    let persistedRequest: Parameters<CollectorPorts["persistTerminal"]>[0] | undefined;
    const persistTerminal = vi.fn(async (request: Parameters<CollectorPorts["persistTerminal"]>[0]) => {
      persistedRequest = request;
      expect(JSON.stringify(request)).not.toContain("secret response");
      return completeDurable(request.durable, request.receipt);
    });
    const ports: CollectorPorts = { ...makePorts(durable, observation), persistTerminal };

    const result = await collectOperation(handle(), ports, { responseContent: "include", responseFormat: "markdown" });
    expect(result.kind).toBe("completed");
    expect(ports.persistTerminal).toHaveBeenCalledTimes(1);
    expect(persistedRequest?.receipt).toMatchObject({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      userTurnId: currentUser.stableId,
      assistantTurnId: currentAssistant.stableId,
      responseDigest: TEXT_DIGEST,
      responseBytes: 15,
      responseFormat: "markdown",
      contentAvailable: true
    });
    if (result.kind !== "completed") return;
    expect(result.response).toMatchObject({ rawContentAvailable: true, rawText: "secret response", responseFormat: "markdown" });
  });

  it.each([
    ["transferred", { outputKey: "artifact-0.bin", bytes: 4, sha256: "c".repeat(64) }],
    ["partial", { blockerCode: "output_collision" }],
    ["blocked", { blockerCode: "destination_unavailable" }]
  ] as const)("accepts a convergent %s artifact transfer receipt without changing terminal evidence", async (status, enrichment) => {
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0, {
      artifactEvidenceDigests: [ARTIFACT_DIGEST]
    });
    const durable = makeDurable();
    const observation = {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: delta(currentUser)
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        branchStableId: currentAssistant.branchStableId!,
        artifacts: [artifact("file", ARTIFACT_DIGEST)]
      })
    } satisfies Omit<CollectorObservation, "schemaVersion">;
    const ports: CollectorPorts = {
      ...makePorts(durable, observation),
      persistTerminal: vi.fn(async ({ durable: current, receipt }) => completeDurable(current, {
        ...receipt,
        artifacts: [{ ...receipt.artifacts[0]!, status, ...enrichment }]
      }))
    };

    const result = await collectOperation(handle(), ports);
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.response.artifacts).toEqual([{
      kind: "file",
      ordinal: 0,
      sourceIdentityDigest: ARTIFACT_DIGEST,
      contentDigest: `sha256:${"c".repeat(64)}`,
      sha256: "c".repeat(64),
      bytes: 4,
      mimeType: "application/octet-stream",
      status,
      ...(status === "transferred" ? { outputKey: "artifact-0.bin" } : {}),
      ...(status === "partial" ? { blockerCode: "output_collision" } : {}),
      ...(status === "blocked" ? { blockerCode: "destination_unavailable" } : {})
    }]);
  });

  it.each([
    ["changes non-artifact terminal evidence", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, finishReason: "length" })],
    ["drops an observed artifact", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, artifacts: [] })],
    ["adds an unobserved artifact", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, artifacts: [...receipt.artifacts, { ...receipt.artifacts[0]!, artifactKey: "artifact-1", ordinal: 1 }] })],
    ["reorders observed artifacts", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, artifacts: [receipt.artifacts[1]!, receipt.artifacts[0]!] })],
    ["changes an artifact identity", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, artifacts: receipt.artifacts.map((item, index) => index === 0 ? { ...item, sourceIdentityDigest: digest("z") } : item) })],
    ["contradicts an observed artifact byte count", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, artifacts: receipt.artifacts.map((item, index) => index === 0 ? { ...item, status: "transferred" as const, outputKey: "artifact-0.bin", bytes: 5 } : item) })],
    ["contradicts an observed artifact digest", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, artifacts: receipt.artifacts.map((item, index) => index === 0 ? { ...item, status: "transferred" as const, outputKey: "artifact-0.bin", sha256: "d".repeat(64) } : item) })],
    ["changes an available artifact without a transfer", (receipt: NonNullable<OperationStateV1["receipt"]>) => ({ ...receipt, artifacts: receipt.artifacts.map((item, index) => index === 0 ? { ...item, status: "available" as const, outputKey: "unexpected.bin" } : item) })]
  ] as const)("rejects persisted receipt that %s", async (_description, mutate) => {
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0, {
      artifactEvidenceDigests: [ARTIFACT_DIGEST, digest("g")]
    });
    const durable = makeDurable();
    const observation = {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: delta(currentUser)
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        branchStableId: currentAssistant.branchStableId!,
        artifacts: [artifact("file", ARTIFACT_DIGEST), artifact("image", digest("g"), 1)]
      })
    } satisfies Omit<CollectorObservation, "schemaVersion">;
    const ports: CollectorPorts = {
      ...makePorts(durable, observation),
      persistTerminal: vi.fn(async ({ durable: current, receipt }) => completeDurable(current, mutate(receipt)))
    };

    const result = await collectOperation(handle(), ports);
    expect(codeOf(result)).toBe("operation_receipt_indeterminate");
  });

  it("fails closed when the observed format disagrees with immutable collection intent", async () => {
    const durable = makeDurable();
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0);
    const ports = makePorts(durable, {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: delta(currentUser)
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        branchStableId: currentAssistant.branchStableId!,
        responseFormat: "text"
      })
    });

    const result = await collectOperation(handle(), ports, { responseFormat: "markdown" });
    expect(codeOf(result)).toBe("port_protocol_violation");
    expect(ports.persistTerminal).not.toHaveBeenCalled();
  });

  it("does not reinterpret a legacy Markdown operation as an explicit text request", async () => {
    const durable = makeDurable();
    const ports = makePorts(durable, { snapshot: makeSnapshot() });
    const result = await collectOperation(handle(), ports, { responseFormat: "text" });
    expect(codeOf(result)).toBe("operation_request_mismatch");
    expect(ports.observe).not.toHaveBeenCalled();
  });

  it.each(["ready", "send_pending"] as const)(
    "uses collect-only recovery when Send intent is durable but phase is still %s",
    async phase => {
      const currentUser = user("operation-user", USER_DIGEST, 0);
      const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0);
      const durable = makeDurable({ state: makeState({ phase }) });
      const ports = makePorts(durable, {
        snapshot: makeSnapshot({
          userTurns: [currentUser],
          assistantTurns: [currentAssistant],
          terminalState: "terminal",
          postSendDelta: delta(currentUser)
        }),
        terminal: terminal({
          userTurnId: currentUser.stableId!,
          assistantTurnId: currentAssistant.stableId!,
          userTurnEvidenceDigest: currentUser.evidenceDigest,
          assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
          branchStableId: currentAssistant.branchStableId!
        })
      });

      const result = await collectOperation(handle({ phase }), ports);
      expect(result.kind).toBe("completed");
      expect(ports.persistTerminal).toHaveBeenCalledTimes(1);
      expect("send" in ports).toBe(false);
    }
  );

  it("fails closed when terminal receipt persistence fails or is indeterminate", async () => {
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0);
    const observation = {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: delta(currentUser)
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        branchStableId: currentAssistant.branchStableId!
      })
    } satisfies Omit<CollectorObservation, "schemaVersion">;
    const failedPersist = vi.fn(async () => {
      throw Object.assign(new Error("journal unavailable"), { code: "operation_receipt_persistence_failed" });
    });
    const failed: CollectorPorts = { ...makePorts(makeDurable(), observation), persistTerminal: failedPersist };
    expect(codeOf(await collectOperation(handle(), failed))).toBe("operation_receipt_persistence_failed");
    expect(failed.persistTerminal).toHaveBeenCalledTimes(1);

    const indeterminatePersist = vi.fn(async () => {
      throw new Error("connection lost after commit");
    });
    const indeterminate: CollectorPorts = { ...makePorts(makeDurable(), observation), persistTerminal: indeterminatePersist };
    expect(codeOf(await collectOperation(handle(), indeterminate))).toBe("operation_receipt_indeterminate");
    expect(indeterminate.persistTerminal).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate or malformed terminal artifacts before persistence", async () => {
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0, {
      artifactEvidenceDigests: [ARTIFACT_DIGEST, digest("g")]
    });
    const base = {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: delta(currentUser)
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        branchStableId: currentAssistant.branchStableId!,
        artifacts: [artifact("file", ARTIFACT_DIGEST, 0), artifact("image", digest("g"), 0)]
      })
    } satisfies Omit<CollectorObservation, "schemaVersion">;
    const duplicate = makePorts(makeDurable(), base);
    expect(codeOf(await collectOperation(handle(), duplicate))).toBe("port_protocol_violation");
    expect(duplicate.persistTerminal).not.toHaveBeenCalled();

    const malformed = makePorts(makeDurable(), {
      ...base,
      terminal: {
        ...base.terminal,
        artifacts: [{ ...base.terminal!.artifacts[0]!, unexpected: "private" }]
      }
    } as unknown as Omit<CollectorObservation, "schemaVersion">);
    expect(codeOf(await collectOperation(handle(), malformed))).toBe("port_protocol_violation");
    expect(malformed.persistTerminal).not.toHaveBeenCalled();
  });

  it("keeps exact ownership across repeated evidence instead of selecting a newer latest turn", async () => {
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0);
    const durable = makeDurable();
    const observation = {
      schemaVersion: COLLECTOR_SCHEMA_VERSION,
      snapshot: makeSnapshot({
        snapshotDigest: SNAPSHOT_DIGEST,
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "terminal",
        postSendDelta: {
          baselineSnapshotDigest: BASELINE_DIGEST,
          addedUserEvidenceDigests: [currentUser.evidenceDigest],
          deltaDigest: digest("d")
        }
      }),
      terminal: terminal({
        userTurnId: currentUser.stableId!,
        assistantTurnId: currentAssistant.stableId!,
        userTurnEvidenceDigest: currentUser.evidenceDigest,
        assistantTurnEvidenceDigest: currentAssistant.evidenceDigest,
        branchStableId: currentAssistant.branchStableId!
      })
    } satisfies CollectorObservation;
    const ports = makePorts(durable, observation);
    const first = await collectOperation(handle(), ports);
    const second = await collectOperation(handle(), ports);
    expect(first).toEqual(second);
    expect(first.kind === "completed" ? first.turn.assistantTurnId : undefined).toBe("assistant-1");
    expect(ports.observe).toHaveBeenCalledTimes(2);
  });

  it("fails closed for human insertion, regeneration siblings, replacement ambiguity, and incomplete snapshots", async () => {
    const oldUser = user("old-user", digest("o"), 0);
    const operationUser = user("operation-user", USER_DIGEST, 1);
    const oldAssistant = assistant("old-assistant", oldUser.stableId!, "terminal", 0);
    const operationAssistant = assistant("assistant-1", operationUser.stableId!, "terminal", 1);
    const human = user("human-user", digest("h"), 1);
    const baseline = makeBaseline({ userTurns: [oldUser], assistantTurns: [oldAssistant] });
    const base = makeDurable({
      baseline,
      state: makeStateWithBaseline(baseline)
    });
    const common = {
      userTurns: [oldUser, operationUser],
      assistantTurns: [oldAssistant, operationAssistant],
      terminalState: "terminal" as const,
      postSendDelta: {
        baselineSnapshotDigest: BASELINE_DIGEST,
        addedUserEvidenceDigests: [operationUser.evidenceDigest],
        deltaDigest: digest("d")
      }
    };
    const terminalObservation = terminal({
      userTurnId: operationUser.stableId!,
      assistantTurnId: operationAssistant.stableId!,
      userTurnEvidenceDigest: operationUser.evidenceDigest,
      assistantTurnEvidenceDigest: operationAssistant.evidenceDigest,
      branchStableId: operationAssistant.branchStableId!
    });

    const operationAfterHuman = user("operation-user", USER_DIGEST, 2);

    const humanResult = await collectOperation(handle(), makePorts(base, {
      snapshot: makeSnapshot({ ...common, userTurns: [oldUser, human, operationAfterHuman], postSendDelta: { ...common.postSendDelta!, addedUserEvidenceDigests: [human.evidenceDigest, operationAfterHuman.evidenceDigest] } }),
      terminal: terminalObservation
    }));
    expect(codeOf(humanResult)).toBe("concurrent_user_turn");

    const sibling = assistant("assistant-sibling", operationUser.stableId!, "terminal", 2);
    const regenerationResult = await collectOperation(handle(), makePorts(base, {
      snapshot: makeSnapshot({ ...common, assistantTurns: [oldAssistant, operationAssistant, sibling] }),
      terminal: terminalObservation
    }));
    expect(codeOf(regenerationResult)).toBe("regeneration_ambiguous");

    const replacementTarget = makeTarget({ tab: { status: "available", value: "replacement-tab" }, authoritativeTabClaim: { status: "available", value: "replacement-claim" } });
    const replacementResult = await collectOperation(handle(), makePorts(base, {
      snapshot: makeSnapshot({ ...common, target: replacementTarget, userTurns: [oldUser], assistantTurns: [oldAssistant] })
    }));
    expect(codeOf(replacementResult)).toBe("target_binding_mismatch");

    const incompleteResult = await collectOperation(handle(), makePorts(base, {
      snapshot: makeSnapshot({ ...common, completeness: "incomplete" })
    }));
    expect(codeOf(incompleteResult)).toBe("incomplete_snapshot");
  });

  it("durably advances an exactly owned generating turn before returning pending", async () => {
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "generating", 0);
    const durable = makeDurable({
      state: makeState({ phase: "submitted" })
    });
    const ports = makePorts(durable, {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "generating",
        postSendDelta: delta(currentUser)
      })
    });

    const result = await collectOperation(handle({ phase: "submitted" }), ports);

    expect(result).toMatchObject({ kind: "pending", phase: "generating" });
    expect(ports.persistProgress).toHaveBeenCalledTimes(1);
    expect(ports.persistProgress).toHaveBeenCalledWith(expect.objectContaining({
      phase: "generating",
      evidenceDigest: SNAPSHOT_DIGEST
    }));
  });

  it("fails closed when proven progress cannot be persisted", async () => {
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "generating", 0);
    const ports = makePorts(makeDurable({ state: makeState({ phase: "submitted" }) }), {
      snapshot: makeSnapshot({
        userTurns: [currentUser],
        assistantTurns: [currentAssistant],
        terminalState: "generating",
        postSendDelta: delta(currentUser)
      })
    });
    (ports.persistProgress as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("private journal failure"));

    const result = await collectOperation(handle({ phase: "submitted" }), ports);

    expect(codeOf(result)).toBe("operation_progress_persistence_failed");
    expect(JSON.stringify(result)).not.toContain("private journal failure");
  });

  it("polls with bounded attempts and sleeps only after the observation transaction ends", async () => {
    const durable = makeDurable();
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const generatingAssistant = assistant("assistant-1", currentUser.stableId!, "generating", 0);
    const terminalAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0);
    const events: string[] = [];
    let observationCount = 0;
    const ports: CollectorPorts = {
      readDurable: vi.fn(async () => durable),
      observe: vi.fn(async () => {
        events.push("observe:start");
        const result = observationCount++ === 0
          ? { snapshot: makeSnapshot({ userTurns: [currentUser], assistantTurns: [generatingAssistant], terminalState: "generating", postSendDelta: delta(currentUser) }) }
          : { snapshot: makeSnapshot({ snapshotDigest: digest("q"), userTurns: [currentUser], assistantTurns: [terminalAssistant], terminalState: "terminal", postSendDelta: delta(currentUser) }), terminal: terminal({ userTurnId: currentUser.stableId!, assistantTurnId: terminalAssistant.stableId!, userTurnEvidenceDigest: currentUser.evidenceDigest, assistantTurnEvidenceDigest: terminalAssistant.evidenceDigest, branchStableId: terminalAssistant.branchStableId! }) };
        events.push("observe:end");
        return { schemaVersion: COLLECTOR_SCHEMA_VERSION, ...result } satisfies CollectorObservation;
      }),
      persistProgress: vi.fn(async ({ durable: current, phase }) => progressDurable(current, phase)),
      persistTerminal: vi.fn(async ({ durable: current, receipt }) => completeDurable(current, receipt)),
      sleep: vi.fn(async () => {
        expect(events.at(-1)).toBe("observe:end");
        events.push("sleep");
      })
    };
    const result = await collectOperation(handle(), ports, { wait: true, maxAttempts: 2, pollIntervalMs: 1, timeoutMs: 1000 });
    expect(result.kind).toBe("completed");
    expect(ports.observe).toHaveBeenCalledTimes(2);
    expect(ports.sleep).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["observe:start", "observe:end", "sleep", "observe:start", "observe:end"]);
  });

  it("returns deterministic cancellation and timeout blockers without touching the browser", async () => {
    const durable = makeDurable();
    const controller = new AbortController();
    const ports = makePorts(durable, { snapshot: makeSnapshot() });
    controller.abort();
    const cancelled = await collectOperation(handle(), ports, { signal: controller.signal });
    expect(codeOf(cancelled)).toBe("operation_cancelled");
    expect(ports.readDurable).not.toHaveBeenCalled();
    expect(ports.observe).not.toHaveBeenCalled();

    const timeout = await collectOperation(handle(), makePorts(durable, { snapshot: makeSnapshot() }), { wait: true, timeoutMs: 1, maxAttempts: 3, now: () => 100 });
    expect(codeOf(timeout)).toBe("operation_timeout");
  });

  it("treats the contract-valid zero timeout as an immediate timeout without touching durable state or the browser", async () => {
    const ports = makePorts(makeDurable(), { snapshot: makeSnapshot() });

    const result = await collectOperation(handle(), ports, { timeoutMs: 0 });

    expect(codeOf(result)).toBe("operation_timeout");
    expect(ports.readDurable).not.toHaveBeenCalled();
    expect(ports.observe).not.toHaveBeenCalled();
  });

  it("honours cancellation between bounded observation transactions", async () => {
    const durable = makeDurable();
    const controller = new AbortController();
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "generating", 0);
    const ports: CollectorPorts = {
      readDurable: vi.fn(async () => durable),
      observe: vi.fn(async () => ({
        schemaVersion: COLLECTOR_SCHEMA_VERSION,
        snapshot: makeSnapshot({ userTurns: [currentUser], assistantTurns: [currentAssistant], terminalState: "generating", postSendDelta: delta(currentUser) })
      })),
      persistProgress: vi.fn(async ({ durable: current, phase }) => progressDurable(current, phase)),
      persistTerminal: vi.fn(async ({ durable: current, receipt }) => completeDurable(current, receipt)),
      sleep: vi.fn(async (_milliseconds, signal) => {
        expect(signal.aborted).toBe(false);
        controller.abort();
      })
    };
    const result = await collectOperation(handle(), ports, { signal: controller.signal, wait: true, maxAttempts: 4, pollIntervalMs: 1 });
    expect(codeOf(result)).toBe("operation_cancelled");
    expect(ports.observe).toHaveBeenCalledTimes(1);
  });

  it("rejects raw response content and malformed adapter shapes", async () => {
    const durable = makeDurable();
    const currentUser = user("operation-user", USER_DIGEST, 0);
    const currentAssistant = assistant("assistant-1", currentUser.stableId!, "terminal", 0);
    const raw = {
      schemaVersion: COLLECTOR_SCHEMA_VERSION,
      snapshot: makeSnapshot({ userTurns: [currentUser], assistantTurns: [currentAssistant], terminalState: "terminal", postSendDelta: delta(currentUser) }),
      terminal: terminal({ userTurnId: currentUser.stableId!, assistantTurnId: currentAssistant.stableId!, userTurnEvidenceDigest: currentUser.evidenceDigest, assistantTurnEvidenceDigest: currentAssistant.evidenceDigest, branchStableId: currentAssistant.branchStableId!, text: "secret response" as unknown as { digest: string; bytes: number; chars: number } })
    } as unknown as CollectorObservation;
    const result = await collectOperation(handle(), makePorts(durable, raw));
    expect(codeOf(result)).toBe("port_protocol_violation");
    expect(JSON.stringify(result)).not.toContain("secret response");
  });

  it("does not echo malformed handle data and maps only known durable lookup failures", async () => {
    const privateValue = "private prompt disguised as an id";
    const invalid = await collectOperation({
      ...handle(),
      operationId: privateValue,
      requestDigest: privateValue
    }, makePorts(makeDurable(), { snapshot: makeSnapshot() }));
    expect(invalid.kind).toBe("blocked");
    expect(JSON.stringify(invalid)).not.toContain(privateValue);

    const ports: CollectorPorts = {
      readDurable: vi.fn(async () => {
        throw Object.assign(new Error("must not escape"), { code: "operation_receipt_expired" });
      }),
      observe: vi.fn(async () => ({ schemaVersion: COLLECTOR_SCHEMA_VERSION, snapshot: makeSnapshot() })),
      persistProgress: vi.fn(async ({ durable: current, phase }) => progressDurable(current, phase)),
      persistTerminal: vi.fn(async ({ durable: current, receipt }) => completeDurable(current, receipt)),
      sleep: vi.fn(async () => undefined)
    };
    const expired = await collectOperation(handle(), ports);
    expect(codeOf(expired)).toBe("operation_receipt_expired");
    expect(ports.observe).not.toHaveBeenCalled();
    expect(JSON.stringify(expired)).not.toContain("must not escape");
  });

  it("rejects a durable submission target that disagrees with the ownership binding", async () => {
    const state = makeState();
    const action = state.actions[ACTION_ID]!;
    const durable = makeDurable({
      state: {
        ...state,
        actions: { [ACTION_ID]: { ...action, targetDigest: digest("z") } }
      }
    });
    const result = await collectOperation(handle(), makePorts(durable, { snapshot: makeSnapshot() }));
    expect(codeOf(result)).toBe("port_protocol_violation");
  });

  it("rejects a collector witness that adds a stable user ID absent from durable state", async () => {
    const durable = makeDurable({
      submissionWitness: {
        actionId: ACTION_ID,
        actionKind: "send",
        baselineSnapshotDigest: BASELINE_DIGEST,
        postSendDeltaDigest: digest("d"),
        operationUserEvidenceDigest: USER_DIGEST,
        userTurnStableId: "operation-user"
      }
    });
    const result = await collectOperation(handle(), makePorts(durable, { snapshot: makeSnapshot() }));
    expect(codeOf(result)).toBe("port_protocol_violation");
  });

  it("rejects a collector witness whose baseline digest is not the durable witness digest", async () => {
    const durable = makeDurable({
      submissionWitness: {
        actionId: ACTION_ID,
        actionKind: "send",
        baselineSnapshotDigest: digest("c"),
        postSendDeltaDigest: digest("d"),
        operationUserEvidenceDigest: USER_DIGEST
      }
    });
    const result = await collectOperation(handle(), makePorts(durable, { snapshot: makeSnapshot() }));
    expect(codeOf(result)).toBe("port_protocol_violation");
  });

  it("accepts the latest Work binding only with its keyed baseline and witness", async () => {
    const durable = makeWorkDurable();
    const ports = makePorts(durable, { snapshot: makeWorkSnapshot() });
    const result = await collectOperation(workHandle(), ports);

    expect(result).toMatchObject({
      kind: "pending",
      phase: "generating",
      mutationBoundary: "control_may_have_occurred"
    });
    expect(ports.observe).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a Work witness key is missing instead of falling back to Send", async () => {
    const durable = makeWorkDurable();
    const submissionWitnesses = { ...durable.state.submissionWitnesses };
    delete submissionWitnesses[WORK_ACTION_ID];
    const state = { ...durable.state, submissionWitnesses };
    const result = await collectOperation(
      workHandle(),
      makePorts({ ...durable, state }, { snapshot: makeWorkSnapshot() })
    );

    expect(codeOf(result)).toBe("port_protocol_violation");
  });

  it("fails closed when keyed Work evidence disagrees with the projected witness or baseline", async () => {
    const durable = makeWorkDurable();
    const witness = durable.state.submissionWitnesses![WORK_ACTION_ID]!;
    const mismatchedWitnessState = {
      ...durable.state,
      submissionWitnesses: {
        ...durable.state.submissionWitnesses,
        [WORK_ACTION_ID]: { ...witness, postSendDeltaDigest: digest("m") }
      }
    };
    const witnessResult = await collectOperation(
      workHandle(),
      makePorts({ ...durable, state: mismatchedWitnessState }, { snapshot: makeWorkSnapshot() })
    );
    expect(codeOf(witnessResult)).toBe("port_protocol_violation");

    const baseline = durable.state.ownershipBaselines![WORK_ACTION_ID]!;
    const mismatchedBaselineState = {
      ...durable.state,
      ownershipBaselines: {
        ...durable.state.ownershipBaselines,
        [WORK_ACTION_ID]: {
          ...baseline,
          baseline: { ...baseline.baseline, userTurns: [] }
        }
      }
    };
    const baselineResult = await collectOperation(
      workHandle(),
      makePorts({ ...durable, state: mismatchedBaselineState }, { snapshot: makeWorkSnapshot() })
    );
    expect(codeOf(baselineResult)).toBe("port_protocol_violation");
  });

  it("fails closed on hostile binding or baseline records before keyed projection", async () => {
    const durable = makeWorkDurable();
    const hostileBaseline = new Proxy(durable.baseline, {
      get(target, property, receiver) {
        if (property === "snapshotDigest") throw new Error("hostile baseline accessor");
        return Reflect.get(target, property, receiver);
      }
    });
    const baselineResult = await collectOperation(
      workHandle(),
      makePorts({ ...durable, baseline: hostileBaseline }, { snapshot: makeWorkSnapshot() })
    );
    expect(codeOf(baselineResult)).toBe("port_protocol_violation");
    expect(JSON.stringify(baselineResult)).not.toContain("hostile baseline accessor");

    const hostileBinding = new Proxy(durable.binding, {
      get(target, property, receiver) {
        if (property === "actionId") throw new Error("hostile binding accessor");
        return Reflect.get(target, property, receiver);
      }
    });
    const bindingResult = await collectOperation(
      workHandle(),
      makePorts({ ...durable, binding: hostileBinding }, { snapshot: makeWorkSnapshot() })
    );
    expect(codeOf(bindingResult)).toBe("port_protocol_violation");
    expect(JSON.stringify(bindingResult)).not.toContain("hostile binding accessor");
  });

  it("returns a redacted durable receipt without re-opening the browser", async () => {
    const receipt = {
      schemaVersion: "chatgpt.browser_control.operation_receipt.v1" as const,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      userTurnId: "operation-user",
      userTurnEvidenceDigest: USER_DIGEST,
      assistantTurnId: "assistant-1",
      ownershipEvidenceDigest: ASSISTANT_DIGEST,
      responseDigest: TEXT_DIGEST,
      responseBytes: 12,
      finishReason: "stop",
      contentAvailable: true,
      artifacts: [],
      completedAt: AT
    };
    const durable = makeDurable({ state: makeState({ phase: "completed", revision: 4, receipt }) });
    const ports = makePorts(durable, { snapshot: makeSnapshot() });
    const result = await collectOperation(handle({ phase: "completed", revision: 4 }), ports);
    expect(result.kind).toBe("completed");
    expect(ports.observe).not.toHaveBeenCalled();
    expect(result.kind === "completed" ? result.response.text : undefined).toEqual({ digest: TEXT_DIGEST, bytes: 12 });
    expect(result.kind === "completed" ? result.response.rawContentAvailable : undefined).toBe(false);
    expect(result.kind === "completed" ? result.response.rawText : undefined).toBeUndefined();
  });
});

function digest(letter: string): string {
  const nibble = /^[0-9a-f]$/.test(letter) ? letter : (letter.charCodeAt(0) % 16).toString(16);
  return `hmac-sha256:${nibble.repeat(64)}`;
}

function handle(overrides: Partial<OperationHandleV1> = {}): OperationHandleV1 {
  return {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    revision: 3,
    phase: "generating",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: TARGET_DIGEST,
    ...overrides
  };
}

function workHandle(overrides: Partial<OperationHandleV1> = {}): OperationHandleV1 {
  return handle({
    surface: "work",
    revision: 5,
    phase: "generating",
    mutationBoundary: "control_may_have_occurred",
    ...overrides
  });
}

function makeState(overrides: Partial<OperationStateV1> = {}): OperationStateV1 {
  const ownershipBaseline = {
    schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    actionId: ACTION_ID,
    baseline: makeBaseline(),
    observedAt: AT
  } as const;
  const submissionWitness = {
    schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
    actionId: ACTION_ID,
    actionKind: "send" as const,
    targetBindingDigest: TARGET_DIGEST,
    baselineSnapshotDigest: BASELINE_DIGEST,
    postSendDeltaDigest: digest("d"),
    operationUserEvidenceDigest: USER_DIGEST,
    observedAt: AT
  };
  return {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    phase: "generating",
    mutationBoundary: "send_may_have_occurred",
    revision: 3,
    createdAt: AT,
    updatedAt: AT,
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
        authoritativeTabClaim: "required",
        replacementTabRecovery: true
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
        intentAt: AT,
        outcome: "satisfied",
        receiptRevision: 3,
        receiptAt: AT,
        evidenceDigest: digest("e")
      }
    },
    ownershipBaseline,
    ownershipBaselines: { [ACTION_ID]: ownershipBaseline },
    submissionWitness,
    submissionWitnesses: { [ACTION_ID]: submissionWitness },
    ...overrides
  };
}

function makeStateWithBaseline(baseline: OwnershipBaseline): OperationStateV1 {
  const state = makeState();
  const ownershipBaseline = { ...state.ownershipBaseline!, baseline };
  const submissionWitness = {
    ...state.submissionWitness!,
    baselineSnapshotDigest: baseline.snapshotDigest
  };
  return {
    ...state,
    ownershipBaseline,
    ownershipBaselines: { [ACTION_ID]: ownershipBaseline },
    submissionWitness,
    submissionWitnesses: { [ACTION_ID]: submissionWitness }
  };
}

function makeTarget(overrides: Partial<OwnershipTargetEvidence> = {}): OwnershipTargetEvidence {
  return {
    provider: { status: "available", value: "provider-1" },
    browser: { status: "available", value: "browser-1" },
    tab: { status: "available", value: "tab-1" },
    thread: { status: "available", value: "thread-1" },
    conversation: { status: "available", value: "conversation-1" },
    canonicalThreadUrl: { status: "available", value: "https://chatgpt.com/c/conversation-1" },
    authoritativeTabClaim: { status: "available", value: "claim-1" },
    coordinationScope: "process",
    ...overrides
  };
}

function makeBinding(overrides: Partial<OwnershipBinding> = {}): OwnershipBinding {
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    targetBindingDigest: TARGET_DIGEST,
    target: makeTarget(),
    evidenceProfile: {
      stableConversationId: "required",
      stableUserTurnId: "required",
      stableAssistantTurnId: "required",
      stableBranchId: "required",
      authoritativeTabClaim: "required"
    },
    replacementTabRecovery: true,
    actionId: ACTION_ID,
    actionKind: "send",
    ...overrides
  };
}

function makeBaseline(overrides: Partial<OwnershipBaseline> = {}): OwnershipBaseline {
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest: BASELINE_DIGEST,
    target: makeTarget(),
    userTurns: [],
    assistantTurns: [],
    completeness: "complete",
    ...overrides
  };
}

function makeWorkTarget(): OwnershipTargetEvidence {
  return makeTarget({ canonicalThreadUrl: { status: "unavailable", reason: "redacted" } });
}

function makeWorkBaseline(): OwnershipBaseline {
  return makeBaseline({
    snapshotDigest: WORK_BASELINE_DIGEST,
    target: makeWorkTarget(),
    userTurns: [user("user-parent-1", digest("p"), 0)],
    assistantTurns: [assistant("assistant-1", "user-parent-1", "generating", 0, {
      branchStableId: "branch-steer-1",
      evidenceDigest: digest("a")
    })]
  });
}

function makeSnapshot(overrides: Partial<OwnershipSnapshot> = {}): OwnershipSnapshot {
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest: SNAPSHOT_DIGEST,
    target: makeTarget(),
    userTurns: [],
    assistantTurns: [],
    completeness: "complete",
    terminalState: "idle",
    ...overrides
  };
}

function makeWorkSnapshot(): OwnershipSnapshot {
  const baseline = makeWorkBaseline();
  const operationUser = user("user-steer", WORK_USER_DIGEST, 1);
  const operationAssistant = assistant("assistant-steer", operationUser.stableId!, "generating", 1, {
    branchStableId: "branch-steer-1"
  });
  return makeSnapshot({
    snapshotDigest: WORK_SNAPSHOT_DIGEST,
    target: makeWorkTarget(),
    userTurns: [...baseline.userTurns, operationUser],
    assistantTurns: [...baseline.assistantTurns, operationAssistant],
    terminalState: "generating",
    postSendDelta: {
      baselineSnapshotDigest: WORK_BASELINE_DIGEST,
      addedUserEvidenceDigests: [WORK_USER_DIGEST],
      deltaDigest: WORK_DELTA_DIGEST
    }
  });
}

function makeWorkState(): OperationStateV1 {
  const base = makeState();
  const sendBaseline = base.ownershipBaseline!;
  const sendWitness = base.submissionWitness!;
  const workBaseline = makeWorkBaseline();
  const workWitness = {
    schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
    actionId: WORK_ACTION_ID,
    actionKind: "work_steer" as const,
    targetBindingDigest: TARGET_DIGEST,
    baselineSnapshotDigest: WORK_BASELINE_DIGEST,
    postSendDeltaDigest: WORK_DELTA_DIGEST,
    operationUserEvidenceDigest: WORK_USER_DIGEST,
    userTurnId: "user-steer",
    observedAt: AT
  };
  const workBaselineRecord = {
    schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    actionId: WORK_ACTION_ID,
    baseline: workBaseline,
    observedAt: AT
  };
  return {
    ...base,
    surface: "work",
    mutationBoundary: "control_may_have_occurred",
    revision: 5,
    actions: {
      ...base.actions,
      [WORK_ACTION_ID]: {
        actionId: WORK_ACTION_ID,
        kind: "work_steer",
        repeatPolicy: "observe_only_after_intent",
        requestDigest: WORK_REQUEST_DIGEST,
        targetDigest: TARGET_DIGEST,
        parentActionId: ACTION_ID,
        intentRevision: 4,
        intentAt: AT,
        outcome: "satisfied",
        receiptRevision: 5,
        receiptAt: AT,
        evidenceDigest: digest("v")
      }
    },
    ownershipBaselines: {
      [ACTION_ID]: sendBaseline,
      [WORK_ACTION_ID]: workBaselineRecord
    },
    submissionWitnesses: {
      [ACTION_ID]: sendWitness,
      [WORK_ACTION_ID]: workWitness
    }
  };
}

function makeWorkDurable(overrides: Partial<CollectorDurableSnapshot> = {}): CollectorDurableSnapshot {
  const state = makeWorkState();
  const workBaseline = state.ownershipBaselines![WORK_ACTION_ID]!.baseline;
  return {
    state,
    binding: makeBinding({
      target: makeWorkTarget(),
      actionId: WORK_ACTION_ID,
      actionKind: "work_steer"
    }),
    baseline: workBaseline,
    submissionWitness: {
      actionId: WORK_ACTION_ID,
      actionKind: "work_steer",
      baselineSnapshotDigest: WORK_BASELINE_DIGEST,
      postSendDeltaDigest: WORK_DELTA_DIGEST,
      operationUserEvidenceDigest: WORK_USER_DIGEST,
      userTurnStableId: "user-steer"
    },
    ...overrides
  };
}

function makeDurable(overrides: Partial<CollectorDurableSnapshot> = {}): CollectorDurableSnapshot {
  return {
    state: makeState(),
    binding: makeBinding(),
    baseline: makeBaseline(),
    submissionWitness: {
      actionId: ACTION_ID,
      actionKind: "send",
      baselineSnapshotDigest: BASELINE_DIGEST,
      postSendDeltaDigest: digest("d"),
      operationUserEvidenceDigest: USER_DIGEST
    },
    ...overrides
  };
}

function makePorts(durable: CollectorDurableSnapshot, observation: Omit<CollectorObservation, "schemaVersion"> | CollectorObservation): CollectorPorts {
  const normalizedObservation: CollectorObservation = {
    schemaVersion: COLLECTOR_SCHEMA_VERSION,
    ...observation
  };
  return {
    readDurable: vi.fn(async () => durable),
    observe: vi.fn(async () => normalizedObservation),
    persistProgress: vi.fn(async ({ durable: current, phase }) => progressDurable(current, phase)),
    persistTerminal: vi.fn(async ({ durable: current, receipt }) => completeDurable(current, receipt)),
    sleep: vi.fn(async () => undefined)
  };
}

function progressDurable(
  durable: CollectorDurableSnapshot,
  phase: "submitted" | "generating"
): CollectorDurableSnapshot {
  return {
    ...durable,
    state: {
      ...durable.state,
      phase,
      revision: durable.state.revision + 1
    }
  };
}

function completeDurable(durable: CollectorDurableSnapshot, receipt: NonNullable<OperationStateV1["receipt"]>): CollectorDurableSnapshot {
  return {
    ...durable,
    state: {
      ...durable.state,
      phase: "completed",
      revision: durable.state.revision + 2,
      updatedAt: receipt.completedAt,
      receipt
    }
  };
}

function user(stableId: string, evidenceDigest: string, ordinal: number, extras: Partial<OwnershipTurn> = {}): OwnershipTurn {
  return { stableId, evidenceDigest, structureDigest: digest("q"), ordinal, ...extras };
}

function assistant(stableId: string, parentStableId: string, state: "generating" | "terminal", ordinal: number, extras: Partial<OwnershipTurn> = {}): OwnershipTurn {
  return {
    stableId,
    evidenceDigest: state === "terminal" ? ASSISTANT_DIGEST : digest("z"),
    structureDigest: digest("v"),
    ordinal,
    parentStableId,
    branchStableId: `branch-${stableId}`,
    state,
    ...extras
  };
}

function delta(turn: OwnershipTurn) {
  return {
    baselineSnapshotDigest: BASELINE_DIGEST,
    addedUserEvidenceDigests: [turn.evidenceDigest],
    deltaDigest: digest("d")
  };
}

function artifact(kind: CollectorArtifact["kind"], sourceIdentityDigest: string, ordinal = 0): CollectorArtifact {
  return { kind, ordinal, sourceIdentityDigest, contentDigest: `sha256:${"c".repeat(64)}`, bytes: 4, mimeType: kind === "image" ? "image/png" : "application/octet-stream" };
}

function terminal(overrides: Partial<CollectorObservation["terminal"]> = {}): NonNullable<CollectorObservation["terminal"]> {
  return {
    schemaVersion: COLLECTOR_TERMINAL_SCHEMA_VERSION,
    userTurnId: "operation-user",
    assistantTurnId: "assistant-1",
    userTurnEvidenceDigest: USER_DIGEST,
    assistantTurnEvidenceDigest: ASSISTANT_DIGEST,
    userOrdinal: 0,
    assistantOrdinal: 0,
    branchStableId: "branch-assistant-1",
    artifacts: [],
    finishReason: "stop",
    ...overrides
  };
}

function codeOf(result: Awaited<ReturnType<typeof collectOperation>>): string | undefined {
  return result.kind === "blocked" ? result.blocker.code : undefined;
}
