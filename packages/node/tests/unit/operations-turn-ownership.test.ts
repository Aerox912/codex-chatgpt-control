import { describe, expect, it } from "vitest";
import {
  TURN_OWNERSHIP_SCHEMA_VERSION,
  classifyTurnOwnership,
  ownershipEvidenceJson,
  type OwnershipBaseline,
  type OwnershipBinding,
  type OwnershipCursor,
  type OwnershipSnapshot,
  type OwnershipTargetEvidence,
  type OwnershipTurn
} from "../../src/operations/turn-ownership.js";

const digest = (letter: string): string => `hmac-sha256:${letter.repeat(64)}`;
const OPERATION = "operation-1";
const ACTION = "action-1";
const BASELINE_DIGEST = digest("b");
const DELTA_DIGEST = digest("d");

const target = (overrides: Partial<OwnershipTargetEvidence> = {}): OwnershipTargetEvidence => ({
  provider: { status: "available", value: "codex-chrome" },
  browser: { status: "available", value: "browser-1" },
  tab: { status: "available", value: "tab-1" },
  thread: { status: "available", value: "thread-1" },
  conversation: { status: "available", value: "conversation-1" },
  canonicalThreadUrl: { status: "available", value: "https://chatgpt.com/c/conversation-1" },
  authoritativeTabClaim: { status: "available", value: "claim-1" },
  coordinationScope: "process",
  ...overrides
});

const binding = (overrides: Partial<OwnershipBinding> = {}): OwnershipBinding => ({
  schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
  operationId: OPERATION,
  targetBindingDigest: digest("t"),
  target: target(),
  evidenceProfile: {
    stableConversationId: "required",
    stableUserTurnId: "required",
    stableAssistantTurnId: "required",
    stableBranchId: "required",
    authoritativeTabClaim: "required"
  },
  replacementTabRecovery: true,
  actionId: ACTION,
  actionKind: "send",
  ...overrides
});

const user = (id: string, evidence = digest("u"), ordinal = 0, extras: Partial<OwnershipTurn> = {}): OwnershipTurn => ({
  stableId: id,
  evidenceDigest: evidence,
  structureDigest: digest("s"),
  ordinal,
  ...extras
});

const assistant = (
  id: string,
  parentStableId: string,
  state: "generating" | "terminal" = "generating",
  ordinal = 0,
  extras: Partial<OwnershipTurn> = {}
): OwnershipTurn => ({
  stableId: id,
  evidenceDigest: digest(state === "generating" ? "g" : "z"),
  structureDigest: digest("a"),
  ordinal,
  parentStableId,
  branchStableId: `branch-${id}`,
  state,
  ...extras
});

const baseline = (overrides: Partial<OwnershipBaseline> = {}): OwnershipBaseline => ({
  schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
  snapshotDigest: BASELINE_DIGEST,
  target: target(),
  userTurns: [],
  assistantTurns: [],
  completeness: "complete",
  ...overrides
});

const snapshot = (overrides: Partial<OwnershipSnapshot> = {}): OwnershipSnapshot => ({
  schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
  snapshotDigest: digest("p"),
  target: target(),
  userTurns: [],
  assistantTurns: [],
  completeness: "complete",
  terminalState: "idle",
  ...overrides
});

const submission = (overrides: Partial<Parameters<typeof classifyTurnOwnership>[0]["submissionWitness"]> = {}) => ({
  actionId: ACTION,
  actionKind: "send" as const,
  baselineSnapshotDigest: BASELINE_DIGEST,
  postSendDeltaDigest: DELTA_DIGEST,
  operationUserEvidenceDigest: digest("u"),
  ...overrides
});

const classify = (input: Partial<Parameters<typeof classifyTurnOwnership>[0]> = {}) => classifyTurnOwnership({
  binding: binding(),
  baseline: baseline(),
  snapshot: snapshot(),
  ...input
});

const submittedUserSnapshot = (turn = user("user-1"), overrides: Partial<OwnershipSnapshot> = {}) => snapshot({
  snapshotDigest: digest("q"),
  userTurns: [turn],
  postSendDelta: {
    baselineSnapshotDigest: BASELINE_DIGEST,
    addedUserEvidenceDigests: [turn.evidenceDigest],
    deltaDigest: DELTA_DIGEST
  },
  ...overrides
});

describe("turn ownership classifier", () => {
  it("reports no operation turn without treating the latest page item as owned", () => {
    const result = classify();
    expect(result.status).toBe("no_operation_turn");
    expect(result.recoveryObservation).toEqual({ status: "not_observed" });
  });

  it("proves a clean user -> generating -> terminal progression", () => {
    const first = classify({ snapshot: submittedUserSnapshot() , submissionWitness: submission() });
    expect(first.status).toBe("owned_user_turn");
    expect(first.cursor?.phase).toBe("owned_user_turn");

    const generating = classify({
      snapshot: submittedUserSnapshot(user("user-1", digest("u"), 0), {
        snapshotDigest: digest("g"),
        assistantTurns: [assistant("assistant-1", "user-1")],
        terminalState: "generating"
      }),
      submissionWitness: submission(),
      ...(first.cursor === undefined ? {} : { prior: first.cursor })
    });
    expect(generating.status).toBe("owned_assistant_generating");
    expect(generating.recoveryObservation.status).toBe("owned_assistant_generating");

    const terminal = classify({
      snapshot: submittedUserSnapshot(user("user-1", digest("u"), 0), {
        snapshotDigest: digest("e"),
        assistantTurns: [assistant("assistant-1", "user-1", "terminal")],
        terminalState: "terminal"
      }),
      submissionWitness: submission(),
      ...(generating.cursor === undefined ? {} : { prior: generating.cursor })
    });
    expect(terminal.status).toBe("owned_assistant_terminal");
    expect(terminal.cursor?.assistantTurnId).toBe("assistant-1");

    const repeated = classify({
      snapshot: submittedUserSnapshot(user("user-1", digest("u"), 0), {
        snapshotDigest: digest("e"),
        assistantTurns: [assistant("assistant-1", "user-1", "terminal")],
        terminalState: "terminal"
      }),
      submissionWitness: submission(),
      ...(terminal.cursor === undefined ? {} : { prior: terminal.cursor })
    });
    expect(repeated.status).toBe("owned_assistant_terminal");
    expect(repeated.cursor).toEqual(terminal.cursor);
  });

  it.each([
    ["text", []],
    ["image", [digest("i")]],
    ["file", [digest("f")]],
    ["mixed", [digest("i"), digest("f")]]
  ])("keeps %s turns on the same ownership path", (_kind, artifactEvidenceDigests) => {
    const result = classify({
      snapshot: submittedUserSnapshot(user("user-1"), {
        assistantTurns: [assistant("assistant-1", "user-1", "terminal", 0, { artifactEvidenceDigests })],
        terminalState: "terminal"
      }),
      submissionWitness: submission()
    });
    expect(result.status).toBe("owned_assistant_terminal");
    expect(result.evidence.assistantTurn?.artifactEvidenceDigests).toEqual(artifactEvidenceDigests);
  });

  it("uses stable identity rather than repeated identical content evidence", () => {
    const old = user("old-user", digest("u"));
    const fresh = user("new-user", digest("u"), 1);
    const result = classify({
      baseline: baseline({ userTurns: [old] }),
      snapshot: snapshot({
        snapshotDigest: digest("q"),
        userTurns: [old, fresh],
        postSendDelta: {
          baselineSnapshotDigest: BASELINE_DIGEST,
          addedUserEvidenceDigests: [fresh.evidenceDigest],
          deltaDigest: DELTA_DIGEST
        }
      }),
      submissionWitness: submission({ operationUserEvidenceDigest: fresh.evidenceDigest, userTurnStableId: fresh.stableId! })
    });
    expect(result.status).toBe("owned_user_turn");
    expect(result.recoveryObservation).toMatchObject({ status: "owned_user_turn", userTurnId: "new-user" });
  });

  it("fails closed for a human inserted before the operation turn or after it", () => {
    const old = user("old-user", digest("o"));
    const oldAfterInsertion = user("old-user", digest("o"), 1);
    const humanBefore = user("human-before", digest("h"), 0);
    const operation = user("operation-user", digest("u"), 1);
    const operationAfterInsertion = user("operation-user", digest("u"), 2);
    const before = classify({
      baseline: baseline({ userTurns: [old] }),
      snapshot: snapshot({ userTurns: [humanBefore, oldAfterInsertion, operationAfterInsertion], postSendDelta: {
        baselineSnapshotDigest: BASELINE_DIGEST,
        addedUserEvidenceDigests: [humanBefore.evidenceDigest, operation.evidenceDigest],
        deltaDigest: digest("x")
      }}),
      submissionWitness: submission({ postSendDeltaDigest: digest("x"), operationUserEvidenceDigest: operation.evidenceDigest })
    });
    expect(before.status).toBe("concurrent_user_turn");
    expect(before.reason).toBe("intervening_user_turn");

    const humanAfter = user("human-after", digest("h"), 2);
    const after = classify({
      baseline: baseline({ userTurns: [old] }),
      snapshot: snapshot({ userTurns: [old, operation, humanAfter], postSendDelta: {
        baselineSnapshotDigest: BASELINE_DIGEST,
        addedUserEvidenceDigests: [operation.evidenceDigest, humanAfter.evidenceDigest],
        deltaDigest: digest("y")
      }}),
      submissionWitness: submission({ postSendDeltaDigest: digest("y"), operationUserEvidenceDigest: operation.evidenceDigest })
    });
    expect(after.status).toBe("concurrent_user_turn");
    expect(after.reason).toBe("multiple_new_user_turns");
  });

  it("rejects multiple new user turns even when one matches the witness", () => {
    const operation = user("operation-user", digest("u"));
    const human = user("human-user", digest("h"), 1);
    const result = classify({
      snapshot: snapshot({ userTurns: [operation, human], postSendDelta: {
        baselineSnapshotDigest: BASELINE_DIGEST,
        addedUserEvidenceDigests: [operation.evidenceDigest, human.evidenceDigest],
        deltaDigest: digest("m")
      }}),
      submissionWitness: submission({ postSendDeltaDigest: digest("m") })
    });
    expect(result.status).toBe("concurrent_user_turn");
  });

  it("rejects regeneration siblings and never picks an arbitrary branch", () => {
    const result = classify({
      snapshot: submittedUserSnapshot(user("user-1"), {
        assistantTurns: [
          assistant("assistant-a", "user-1", "terminal"),
          assistant("assistant-b", "user-1", "terminal", 1)
        ],
        terminalState: "terminal"
      }),
      submissionWitness: submission()
    });
    expect(result.status).toBe("regeneration_ambiguous");
    expect(result.cursor).toBeUndefined();
  });

  it("rejects missing stable IDs according to the evidence profile", () => {
    const noUserId = user("user-1");
    delete (noUserId as { stableId?: string }).stableId;
    const result = classify({
      binding: binding({ evidenceProfile: { ...binding().evidenceProfile, stableUserTurnId: "unavailable" } }),
      snapshot: submittedUserSnapshot(noUserId),
      submissionWitness: submission()
    });
    expect(result.status).toBe("ownership_ambiguous");
    expect(result.reason).toBe("stable_user_turn_id_unavailable");

    const missingBranch = assistant("assistant-1", "user-1", "generating");
    delete (missingBranch as { branchStableId?: string }).branchStableId;
    const assistantResult = classify({
      snapshot: submittedUserSnapshot(user("user-1"), { assistantTurns: [missingBranch], terminalState: "generating" }),
      submissionWitness: submission()
    });
    expect(assistantResult.status).toBe("ownership_ambiguous");
    expect(assistantResult.reason).toBe("stable_branch_identity_unavailable");
  });

  it("allows replacement-tab recovery only with stable conversation and owned user evidence", () => {
    const result = classify({
      snapshot: submittedUserSnapshot(user("user-1"), { target: target({ tab: { status: "available", value: "tab-replacement" }, authoritativeTabClaim: { status: "available", value: "claim-replacement" } }) }),
      submissionWitness: submission()
    });
    expect(result.status).toBe("owned_user_turn");
    expect(result.evidence.target.replacedTab).toBe(true);

    const noUser = classify({
      snapshot: snapshot({ target: target({ tab: { status: "available", value: "tab-replacement" }, authoritativeTabClaim: { status: "available", value: "claim-replacement" } }) })
    });
    expect(noUser.status).toBe("target_mismatch");
    expect(noUser.reason).toBe("replacement_tab_requires_owned_user");

    const noConversation = classify({
      snapshot: submittedUserSnapshot(user("user-1"), { target: target({
        tab: { status: "available", value: "tab-replacement" },
        conversation: { status: "unavailable", reason: "not_exposed" },
        authoritativeTabClaim: { status: "available", value: "claim-replacement" }
      }) }),
      submissionWitness: submission()
    });
    expect(noConversation.status).toBe("target_evidence_unavailable");
  });

  it("never treats a replacement tab as a valid pre-Send baseline", () => {
    const result = classify({
      baseline: baseline({ target: target({ tab: { status: "available", value: "tab-replacement" } }) }),
      snapshot: submittedUserSnapshot(),
      submissionWitness: submission()
    });
    expect(result.status).toBe("target_mismatch");
    expect(result.reason).toBe("baseline_target_mismatch");
  });

  it("accepts one authenticated conversation establishment after a blank new-target baseline", () => {
    const unavailable = { status: "unavailable" as const, reason: "not_observed" as const };
    const pendingTarget = target({
      thread: unavailable,
      conversation: unavailable,
      canonicalThreadUrl: unavailable,
      authoritativeTabClaim: { status: "unavailable", reason: "not_exposed" }
    });
    const establishedTarget = target({
      authoritativeTabClaim: { status: "unavailable", reason: "not_exposed" }
    });
    const establishedBinding = binding({
      target: establishedTarget,
      evidenceProfile: {
        ...binding().evidenceProfile,
        authoritativeTabClaim: "unavailable"
      },
      replacementTabRecovery: false
    });
    const operationUser = user("user-1");
    const establishedSnapshot = submittedUserSnapshot(operationUser, {
      target: establishedTarget,
      assistantTurns: [assistant("assistant-1", "user-1")],
      terminalState: "generating"
    });
    const establishedBaseline = baseline({ target: pendingTarget });

    const result = classify({
      binding: establishedBinding,
      baseline: establishedBaseline,
      snapshot: establishedSnapshot,
      submissionWitness: submission()
    });
    expect(result.status).toBe("owned_assistant_generating");

    const noWitness = classify({
      binding: establishedBinding,
      baseline: establishedBaseline,
      snapshot: establishedSnapshot
    });
    expect(noWitness.status).toBe("target_evidence_unavailable");

    const wrongTab = classify({
      binding: establishedBinding,
      baseline: establishedBaseline,
      snapshot: submittedUserSnapshot(operationUser, {
        target: target({
          tab: { status: "available", value: "other-tab" },
          authoritativeTabClaim: { status: "unavailable", reason: "not_exposed" }
        })
      }),
      submissionWitness: submission()
    });
    expect(wrongTab.status).toBe("target_mismatch");
  });

  it("rejects provider, conversation, thread, and tab drift", () => {
    for (const drift of [
      { provider: { status: "available", value: "other-provider" } },
      { conversation: { status: "available", value: "other-conversation" } },
      { thread: { status: "available", value: "other-thread" } },
      { tab: { status: "available", value: "other-tab" } }
    ] satisfies Array<Partial<OwnershipTargetEvidence>>) {
      const result = classify({ snapshot: submittedUserSnapshot(user("user-1"), { target: target(drift) }), submissionWitness: submission() });
      expect(["target_mismatch", "owned_user_turn"]).toContain(result.status);
      if (drift.tab !== undefined) expect(result.status).toBe("owned_user_turn");
      else expect(result.status).toBe("target_mismatch");
    }
  });

  it("returns target evidence unavailable instead of guessing when identities are unavailable", () => {
    const result = classify({ snapshot: snapshot({ target: target({ provider: { status: "unavailable", reason: "not_observed" } }) }) });
    expect(result.status).toBe("target_evidence_unavailable");
    expect(result.recoveryObservation.status).toBe("ambiguous");
  });

  it("rejects missing or mismatched exact post-Send evidence", () => {
    const noWitness = classify({ snapshot: submittedUserSnapshot() });
    expect(noWitness.status).toBe("ownership_ambiguous");
    expect(noWitness.reason).toBe("post_send_delta_missing");

    const missingDelta = classify({ snapshot: snapshot({ userTurns: [user("user-1")] }), submissionWitness: submission() });
    expect(missingDelta.status).toBe("ownership_ambiguous");
    expect(missingDelta.reason).toBe("post_send_delta_missing");

    const mismatch = classify({ snapshot: submittedUserSnapshot(), submissionWitness: submission({ postSendDeltaDigest: digest("x") }) });
    expect(mismatch.status).toBe("ownership_ambiguous");
    expect(mismatch.reason).toBe("post_send_delta_mismatch");

    const baselineMismatch = classify({ snapshot: submittedUserSnapshot(), submissionWitness: submission({ baselineSnapshotDigest: digest("x") }) });
    expect(baselineMismatch.status).toBe("ownership_ambiguous");
    expect(baselineMismatch.reason).toBe("post_send_delta_mismatch");

    const deltaWithoutTurn = classify({ snapshot: snapshot({ postSendDelta: {
      baselineSnapshotDigest: BASELINE_DIGEST,
      addedUserEvidenceDigests: [digest("u")],
      deltaDigest: DELTA_DIGEST
    }}) });
    expect(deltaWithoutTurn.status).toBe("ownership_ambiguous");
    expect(deltaWithoutTurn.reason).toBe("post_send_delta_mismatch");
  });

  it("fails closed for truncated, out-of-order, and changed snapshots", () => {
    expect(classify({ snapshot: submittedUserSnapshot(user("user-1"), { completeness: "truncated" }), submissionWitness: submission() }).status).toBe("ownership_ambiguous");
    expect(classify({ snapshot: submittedUserSnapshot(user("user-1"), { completeness: "out_of_order" }), submissionWitness: submission() }).reason).toBe("out_of_order_snapshot");

    const old = user("old-user", digest("o"));
    const changed = user("old-user", digest("x"));
    const result = classify({ baseline: baseline({ userTurns: [old] }), snapshot: snapshot({ userTurns: [changed] }) });
    expect(result.reason).toBe("baseline_turn_changed");
  });

  it("rejects unexpected assistants and parent drift", () => {
    const noUser = classify({ snapshot: snapshot({ assistantTurns: [assistant("assistant-1", "missing-user")], terminalState: "generating" }) });
    expect(noUser.status).toBe("ownership_ambiguous");
    expect(noUser.reason).toBe("unexpected_new_assistant_turn");

    const wrongParent = classify({
      snapshot: submittedUserSnapshot(user("user-1"), { assistantTurns: [assistant("assistant-1", "other-user")], terminalState: "generating" }),
      submissionWitness: submission()
    });
    expect(wrongParent.reason).toBe("assistant_parent_mismatch");
  });

  it("rejects cursor drift and preserves idempotence without latest-page fallback", () => {
    const first = classify({ snapshot: submittedUserSnapshot(), submissionWitness: submission() });
    const cursor = first.cursor as OwnershipCursor;
    const drifted = classify({
      snapshot: submittedUserSnapshot(user("user-2", digest("x"))),
      submissionWitness: submission(),
      prior: cursor
    });
    expect(drifted.reason).toBe("prior_owned_turn_missing");

    const mismatch = classify({
      snapshot: submittedUserSnapshot(),
      submissionWitness: submission(),
      prior: { ...cursor, targetBindingDigest: digest("x") }
    });
    expect(mismatch.reason).toBe("prior_cursor_mismatch");
  });

  it("allows generating evidence to evolve but freezes the terminal assistant evidence", () => {
    const ownedUser = classify({ snapshot: submittedUserSnapshot(), submissionWitness: submission() });
    const generatingOne = classify({
      snapshot: submittedUserSnapshot(user("user-1"), {
        snapshotDigest: digest("g"),
        assistantTurns: [assistant("assistant-1", "user-1", "generating", 0, { evidenceDigest: digest("j") })],
        terminalState: "generating"
      }),
      submissionWitness: submission(),
      prior: ownedUser.cursor!
    });
    expect(generatingOne.status).toBe("owned_assistant_generating");

    const generatingTwo = classify({
      snapshot: submittedUserSnapshot(user("user-1"), {
        snapshotDigest: digest("k"),
        assistantTurns: [assistant("assistant-1", "user-1", "generating", 0, { evidenceDigest: digest("l"), structureDigest: digest("m") })],
        terminalState: "generating"
      }),
      submissionWitness: submission(),
      prior: generatingOne.cursor!
    });
    expect(generatingTwo.status).toBe("owned_assistant_generating");

    const terminal = classify({
      snapshot: submittedUserSnapshot(user("user-1"), {
        snapshotDigest: digest("n"),
        assistantTurns: [assistant("assistant-1", "user-1", "terminal", 0, { evidenceDigest: digest("o"), structureDigest: digest("p") })],
        terminalState: "terminal"
      }),
      submissionWitness: submission(),
      prior: generatingTwo.cursor!
    });
    expect(terminal.status).toBe("owned_assistant_terminal");

    const changedTerminal = classify({
      snapshot: submittedUserSnapshot(user("user-1"), {
        snapshotDigest: digest("q"),
        assistantTurns: [assistant("assistant-1", "user-1", "terminal", 0, { evidenceDigest: digest("r"), structureDigest: digest("p") })],
        terminalState: "terminal"
      }),
      submissionWitness: submission(),
      prior: terminal.cursor!
    });
    expect(changedTerminal.status).toBe("ownership_ambiguous");
    expect(changedTerminal.reason).toBe("prior_owned_turn_changed");
  });

  it("rejects unknown fields and malformed cursor enums at the privacy boundary", () => {
    const withRawPrompt = submittedUserSnapshot() as OwnershipSnapshot & { rawPrompt: string };
    withRawPrompt.rawPrompt = "private text";
    expect(() => classify({ snapshot: withRawPrompt, submissionWitness: submission() })).toThrow(/unsupported field rawPrompt/);

    const first = classify({ snapshot: submittedUserSnapshot(), submissionWitness: submission() });
    const malformed = { ...first.cursor, phase: "latest_turn", assistantTurnId: "assistant-1", assistantBranchId: "branch-1", assistantEvidenceDigest: digest("a"), assistantStructureDigest: digest("b") } as unknown as OwnershipCursor;
    expect(() => classify({ snapshot: submittedUserSnapshot(), submissionWitness: submission(), prior: malformed })).toThrow(/phase is invalid/);
  });

  it("validates duplicate IDs, duplicate id-less evidence, and hard caps", () => {
    const duplicate = user("same", digest("u"), 1);
    expect(() => classify({ snapshot: snapshot({ userTurns: [user("same"), duplicate] }) })).toThrow(/Duplicate stable turn ID/);

    const idlessA = user("idless-a", digest("x"));
    const idlessB = user("idless-b", digest("x"), 1);
    delete (idlessA as { stableId?: string }).stableId;
    delete (idlessB as { stableId?: string }).stableId;
    expect(() => classify({ snapshot: snapshot({ userTurns: [idlessA, idlessB] }) })).toThrow(/Duplicate id-less turn evidence/);

    const tooMany = Array.from({ length: 257 }, (_, index) => user(`u-${index}`, digest("a"), index));
    expect(() => classify({ snapshot: snapshot({ userTurns: tooMany }) })).toThrow(/bounded array cap/);
  });

  it("emits canonical redacted evidence material with no raw content fields", () => {
    const result = classify({ snapshot: submittedUserSnapshot(), submissionWitness: submission() });
    const json = ownershipEvidenceJson(result.evidence);
    expect(json).toContain("operation-1");
    expect(json).toContain("hmac-sha256:");
    expect(json).not.toMatch(/prompt|content|rawText|textContent/i);
    expect(result.evidence.userTurn).not.toHaveProperty("stableId");
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.cursor)).toBe(true);
  });

  it("does not authorize terminal capture when the terminal state disagrees", () => {
    const result = classify({
      snapshot: submittedUserSnapshot(user("user-1"), {
        assistantTurns: [assistant("assistant-1", "user-1", "terminal")],
        terminalState: "generating"
      }),
      submissionWitness: submission()
    });
    expect(result.status).toBe("ownership_ambiguous");
    expect(result.reason).toBe("terminal_state_mismatch");
  });
});
