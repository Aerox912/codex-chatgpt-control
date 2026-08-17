import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadLike } from "../../src/browser/downloads.js";
import type { PageLike } from "../../src/types.js";
import {
  createOperationBrowserAdapter,
  OperationBrowserAdapterError,
  type OperationBrowserAdapterOptions,
  type OperationBrowserTargetProbe
} from "../../src/operations/browser-adapter.js";
import {
  TURN_OWNERSHIP_SCHEMA_VERSION,
  type OwnershipBaseline,
  type OwnershipTargetEvidence
} from "../../src/operations/turn-ownership.js";
import type {
  SubmissionExpectedEnvelope,
  SubmissionFinalTransactionResult
} from "../../src/operations/submission.js";
import type { SendOncePreconditionObservation } from "../../src/operations/send-once.js";
import type { OperationTargetResolutionRequest } from "../../src/operations/service.js";
import type {
  ControlSteerExecutePreparedRequest,
  ControlSteerPhaseResult,
  ControlSteerPrepareRequest,
  ControlSteerRecoverRequest,
  ControlSteerVerifyRequest,
  ControlSteerPrepared
} from "../../src/operations/control.js";
import { CONTROL_COORDINATOR_SCHEMA_VERSION } from "../../src/operations/control.js";
import { ProcessTabCoordinator } from "../../src/runtime/tab-coordinator.js";
import type { OperationFileIdentity } from "../../src/operations/file-identity.js";

const OPERATION_1 = "11111111-1111-4111-8111-111111111111";
const OPERATION_2 = "22222222-2222-4222-8222-222222222222";
const REQUEST_DIGEST = `hmac-sha256:${"1".repeat(64)}`;
const CONFIG_DIGEST = `hmac-sha256:${"2".repeat(64)}`;
const COMPOSER_DIGEST = `hmac-sha256:${"3".repeat(64)}`;
const EVIDENCE_DIGEST = `hmac-sha256:${"4".repeat(64)}`;
const USER_EVIDENCE = `hmac-sha256:${"5".repeat(64)}`;
const ASSISTANT_EVIDENCE = `hmac-sha256:${"6".repeat(64)}`;
const TARGET_DIGEST = `hmac-sha256:${"7".repeat(64)}`;
const ESTABLISHMENT_ACTION = "55555555-5555-4555-8555-555555555555";
const CONTROL_ACTION = "66666666-6666-4666-8666-666666666666";
const STEER_REQUEST_DIGEST = `hmac-sha256:${"8".repeat(64)}`;
const STEER_PREPARED_DIGEST = `hmac-sha256:${"9".repeat(64)}`;

const digest = (domain: string, material: unknown): string => {
  const text = `${domain}:${JSON.stringify(material)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hmac-sha256:${hash.toString(16).padStart(8, "0").repeat(8)}`;
};

function identity(value: string): { status: "available"; value: string } {
  return { status: "available", value };
}

function targetEvidence(
  tabId = "tab-1",
  claim = "claim-1",
  conversationId = `conversation-${tabId}`
): OwnershipTargetEvidence {
  return {
    provider: identity("provider-1"),
    browser: identity("browser-1"),
    tab: identity(tabId),
    thread: identity(`thread-${tabId}`),
    conversation: identity(conversationId),
    canonicalThreadUrl: identity(`https://opaque.invalid/thread/${"a".repeat(64)}`),
    authoritativeTabClaim: identity(claim),
    coordinationScope: "provider"
  };
}

const capabilities = {
  stableProviderId: true,
  stableBrowserId: true,
  stableTabId: true,
  authoritativeTabClaim: true,
  concurrentTabs: true
} as const;

function baseOptions(overrides: Partial<OperationBrowserAdapterOptions> = {}): OperationBrowserAdapterOptions {
  const page: PageLike = { evaluate: emptyEvaluate, getByRole: () => ({ count: async () => 0 }) };
  return {
    page,
    owner: { backendSessionId: "backend-session-1" },
    coordinator: new ProcessTabCoordinator(),
    evidenceDigest: digest,
    targetEvidence: targetEvidence(),
    authoritativeClaim: { token: "claim-1", epoch: 1 },
    capabilities,
    observeCurrentTarget: ({ target }) => ({
      evidence: targetEvidence(target.tabId),
      authoritativeClaim: { token: target.tabId === "tab-1" ? "claim-1" : `claim-${target.tabId}`, epoch: 1 }
    }),
    ...overrides
  };
}

function resolutionRequest(
  operationId: string,
  target: OperationTargetResolutionRequest["target"] = { type: "selected_tab" }
): OperationTargetResolutionRequest {
  return {
    operationId,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    target,
    signal: new AbortController().signal
  };
}

function exactStage() {
  return { status: "exact" as const, evidenceDigest: EVIDENCE_DIGEST };
}

async function emptyEvaluate<T, A = unknown>(
  _fn: (arg: A) => T | Promise<T>,
  _arg?: A
): Promise<T> {
  return {} as T;
}

function expectedEnvelope(targetBindingDigest: string): SubmissionExpectedEnvelope {
  return {
    surface: "chat",
    targetBindingDigest,
    configurationReceiptDigest: CONFIG_DIGEST,
    composerReceiptDigest: COMPOSER_DIGEST,
    attachmentManifest: { count: 0, orderPolicy: "exact", identities: [] }
  };
}

function recoveredTarget(lifecycle: "fixed" | "new_established" = "new_established") {
  const canonicalThreadUrl = `https://opaque.invalid/thread/${"a".repeat(64)}`;
  const base = {
    providerId: "provider-1",
    browserId: "browser-1",
    tabId: "tab-1",
    coordinationScope: "provider" as const,
    tabClaimEvidenceDigest: digest("codex-chatgpt-control/tab-claim-evidence/v1", { token: "claim-1", epoch: 1 }),
    canonicalThreadUrl,
    conversationId: "conversation-tab-1",
    userTurnBaselineDigest: USER_EVIDENCE,
    assistantTurnBaselineDigest: ASSISTANT_EVIDENCE,
    configurationReceiptDigest: CONFIG_DIGEST,
    evidenceProfile: {
      providerIdentity: "required" as const,
      stableTabId: "required" as const,
      stableConversationId: "required" as const,
      stableUserTurnId: "required" as const,
      authoritativeTabClaim: "required" as const,
      replacementTabRecovery: false
    }
  };
  if (lifecycle === "fixed") return Object.freeze(base);
  return Object.freeze({
    ...base,
    targetLifecycle: "new_established" as const,
    newTargetAnchorDigest: EVIDENCE_DIGEST,
    blankTaskEvidenceDigest: CONFIG_DIGEST,
    targetEstablishment: {
      targetBindingDigest: TARGET_DIGEST,
      anchorDigest: EVIDENCE_DIGEST,
      causalSendActionId: ESTABLISHMENT_ACTION,
      conversationId: base.conversationId,
      canonicalThreadUrl,
      userTurnId: "user-turn-1",
      userTurnEvidenceDigest: USER_EVIDENCE,
      postSendDeltaDigest: EVIDENCE_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: "2026-08-16T23:00:00.000Z"
    }
  });
}

function recoveryContext(
  target = recoveredTarget(),
  signal: AbortSignal = new AbortController().signal
) {
  return Object.freeze({
    operationId: OPERATION_1,
    requestDigest: REQUEST_DIGEST,
    surface: "chat" as const,
    target,
    signal
  });
}

function collectorReadRequest(signal: AbortSignal = new AbortController().signal) {
  return {
    operationId: OPERATION_1,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    submissionActionId: ESTABLISHMENT_ACTION,
    signal
  };
}

function exactPrecondition(targetBindingDigest: string): SendOncePreconditionObservation {
  return {
    status: "exact",
    targetBindingDigest,
    configurationReceiptDigest: CONFIG_DIGEST,
    composerReceiptDigest: COMPOSER_DIGEST,
    attachments: { count: 0, orderPolicy: "exact", identityDigests: [] },
    baseline: { userTurnEvidenceDigest: USER_EVIDENCE },
    evidenceDigest: EVIDENCE_DIGEST
  };
}

function exactPreconditionWithOwnership(targetBindingDigest: string): SendOncePreconditionObservation {
  const baseline = ownershipBaseline();
  return {
    status: "exact",
    targetBindingDigest,
    configurationReceiptDigest: CONFIG_DIGEST,
    composerReceiptDigest: COMPOSER_DIGEST,
    attachments: { count: 0, orderPolicy: "exact", identityDigests: [] },
    baseline: {
      userTurnEvidenceDigest: baseline.snapshotDigest,
      ownershipBaseline: baseline
    },
    evidenceDigest: EVIDENCE_DIGEST
  };
}

function ownershipBaseline(): OwnershipBaseline {
  return {
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest: digest("ownership-baseline", { operationId: OPERATION_1 }),
    target: targetEvidence(),
    userTurns: [],
    assistantTurns: [],
    completeness: "complete"
  };
}

function steerPrepared(targetBindingDigest = TARGET_DIGEST): ControlSteerPrepared {
  return {
    schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
    parentOperationId: OPERATION_1,
    parentRequestDigest: REQUEST_DIGEST,
    parentTargetBindingDigest: targetBindingDigest,
    controlActionId: CONTROL_ACTION,
    action: "steer",
    requestDigest: STEER_REQUEST_DIGEST,
    expectedAssistantTurnId: "assistant-turn-1",
    assistantBranchId: "assistant-branch-1",
    assistantParentTurnId: "assistant-parent-1",
    baselineSnapshotDigest: EVIDENCE_DIGEST,
    preparedDigest: STEER_PREPARED_DIGEST,
    baseline: ownershipBaseline()
  };
}

function steerPhaseIdentity(prepared: ControlSteerPrepared) {
  return {
    schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
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

function preparedSteerResult(prepared: ControlSteerPrepared): ControlSteerPhaseResult {
  return {
    ...steerPhaseIdentity(prepared),
    phase: "prepare",
    status: "prepared",
    observationRequired: false,
    mutationBoundary: "none",
    prepared
  };
}

function executedSteerResult(prepared: ControlSteerPrepared): ControlSteerPhaseResult {
  return {
    ...steerPhaseIdentity(prepared),
    phase: "execute_prepared",
    status: "executed",
    observationRequired: true,
    mutationBoundary: "control_may_have_occurred"
  };
}

function satisfiedSteerResult(prepared: ControlSteerPrepared, phase: "verify" | "recovery" = "verify"): ControlSteerPhaseResult {
  const receipt = {
    schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
    baselineSnapshotDigest: prepared.baselineSnapshotDigest,
    preparedDigest: prepared.preparedDigest,
    assistantTurnId: prepared.expectedAssistantTurnId,
    assistantBranchId: prepared.assistantBranchId,
    assistantParentTurnId: prepared.assistantParentTurnId,
    userTurnId: "user-turn-1",
    userTurnEvidenceDigest: USER_EVIDENCE,
    postSendDeltaDigest: EVIDENCE_DIGEST,
    evidenceDigest: EVIDENCE_DIGEST
  };
  return {
    ...steerPhaseIdentity(prepared),
    phase,
    status: "satisfied",
    observationRequired: false,
    mutationBoundary: "control_may_have_occurred",
    receipt
  };
}

type SteerAdapter = {
  prepareSteer(request: ControlSteerPrepareRequest): Promise<ControlSteerPhaseResult>;
  executeSteerPrepared(request: ControlSteerExecutePreparedRequest): Promise<ControlSteerPhaseResult>;
  verifySteer(request: ControlSteerVerifyRequest): Promise<ControlSteerPhaseResult>;
  recoverSteer(request: ControlSteerRecoverRequest): Promise<ControlSteerPhaseResult>;
};

function steerAdapter(adapter: ReturnType<typeof createOperationBrowserAdapter>): SteerAdapter {
  return adapter.control as unknown as SteerAdapter;
}

function steerPrepareRequest(signal: AbortSignal = new AbortController().signal): ControlSteerPrepareRequest {
  return {
    schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
    parentOperationId: OPERATION_1,
    parentRequestDigest: REQUEST_DIGEST,
    parentTargetBindingDigest: TARGET_DIGEST,
    controlActionId: CONTROL_ACTION,
    requestDigest: STEER_REQUEST_DIGEST,
    expectedAssistantTurnId: "assistant-turn-1",
    signal,
    deadlineAt: Date.now() + 1_000
  };
}

function submitted(targetBindingDigest: string): SubmissionFinalTransactionResult {
  return {
    status: "already_submitted",
    targetBindingDigest,
    evidenceDigest: EVIDENCE_DIGEST,
    userTurnId: "user-turn-1",
    userTurnEvidenceDigest: USER_EVIDENCE,
    postSendDeltaDigest: EVIDENCE_DIGEST,
    assistantTurnId: "assistant-turn-1"
  };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("composed operation browser adapter", () => {
  it("hydrates one complete new-established target lazily for collect/control without invoking mutation primitives", async () => {
    const observer = vi.fn(async ({ target }: { target: unknown }) => ({
      evidence: targetEvidence(),
      authoritativeClaim: { token: "claim-1", epoch: 1 }
    }));
    const readContext = vi.fn(async (_request: unknown, _page: PageLike, target: unknown) => {
      expect(target).toEqual(recoveredTarget());
      return {} as never;
    });
    const mutation = vi.fn(async () => ({
      status: "satisfied" as const,
      assistantTurnId: "assistant-turn-1",
      evidenceDigest: EVIDENCE_DIGEST
    }));
    const adapter = createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: observer,
      recovery: recoveryContext(),
      collector: { readContext },
      control: {
        executeOnce: mutation
      }
    }));

    const request = collectorReadRequest();
    await adapter.collector.readContext(request);
    await adapter.collector.readContext(request);

    // One initial proof plus one short revalidation per collect call; the
    // adapter never performs a second hydration/capture.
    expect(observer).toHaveBeenCalledTimes(3);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("fails closed when restart hydration observes a different tab and does not install a binding", async () => {
    const observer = vi.fn(async () => ({
      evidence: targetEvidence("tab-2", "claim-2", "conversation-tab-2"),
      authoritativeClaim: { token: "claim-2", epoch: 1 }
    }));
    const readContext = vi.fn(async () => ({}) as never);
    const adapter = createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: observer,
      recovery: recoveryContext(),
      collector: { readContext }
    }));

    await expect(adapter.collector.readContext(collectorReadRequest())).rejects.toMatchObject({
      code: "target_binding_mismatch"
    });
    expect(readContext).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("rejects pending new-target recovery before any browser observation", async () => {
    const observer = vi.fn(async () => ({ evidence: targetEvidence() }));
    const pending = Object.freeze({
      ...recoveredTarget("fixed"),
      targetLifecycle: "new_pending" as const,
      conversationId: undefined,
      canonicalThreadUrl: undefined,
      evidenceProfile: {
        ...recoveredTarget("fixed").evidenceProfile,
        stableConversationId: "unavailable" as const,
        stableUserTurnId: "unavailable" as const
      }
    });
    expect(() => createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: observer,
      recovery: recoveryContext(pending as never),
      collector: { readContext: async () => ({}) as never }
    }))).toThrow();
    expect(observer).not.toHaveBeenCalled();
  });

  it("rejects hostile recovery target accessors without invoking the getter", async () => {
    let getterCalls = 0;
    const hostileTarget = { ...recoveredTarget() } as Record<string, unknown>;
    Object.defineProperty(hostileTarget, "providerId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("provider identity getter");
      }
    });
    expect(() => createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: vi.fn(async () => ({ evidence: targetEvidence(), authoritativeClaim: { token: "claim-1", epoch: 1 } })),
      recovery: recoveryContext(hostileTarget as never),
      collector: { readContext: async () => ({}) as never }
    }))).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("preserves own __proto__ data keys while cloning a recovered target", async () => {
    const target = { ...recoveredTarget() } as Record<string, unknown>;
    Object.defineProperty(target, "__proto__", {
      value: "recovered-target-marker",
      enumerable: true,
      writable: true,
      configurable: true
    });
    const observer = vi.fn(async () => ({
      evidence: targetEvidence(),
      authoritativeClaim: { token: "claim-1", epoch: 1 }
    }));
    const readContext = vi.fn(async (_request: unknown, _page: PageLike, recovered: unknown) => {
      const record = recovered as Record<string, unknown>;
      expect(Object.getPrototypeOf(record)).toBe(null);
      expect(Object.prototype.hasOwnProperty.call(record, "__proto__")).toBe(true);
      expect(record["__proto__"]).toBe("recovered-target-marker");
      return {} as never;
    });
    const adapter = createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: observer,
      recovery: recoveryContext(target as ReturnType<typeof recoveredTarget>),
      collector: { readContext }
    }));

    await adapter.collector.readContext(collectorReadRequest());
    expect(observer).toHaveBeenCalledTimes(2);
    expect(readContext).toHaveBeenCalledTimes(1);
  });

  it("snapshots proxied adapter and recovery options through descriptors without invoking get traps", async () => {
    const getTrap = vi.fn(() => {
      throw new Error("adapter option get trap");
    });
    const rawRecovery = recoveryContext();
    const proxiedRecovery = new Proxy(rawRecovery, { get: getTrap });
    const rawOptions = baseOptions({
      recovery: proxiedRecovery,
      observeCurrentTarget: async () => ({
        evidence: targetEvidence(),
        authoritativeClaim: { token: "claim-1", epoch: 1 }
      }),
      collector: { readContext: async () => ({}) as never }
    });
    const adapter = createOperationBrowserAdapter(new Proxy(rawOptions, { get: getTrap }));

    await adapter.collector.readContext(collectorReadRequest());
    expect(getTrap).not.toHaveBeenCalled();
  });

  it("shares one in-flight hydration across concurrent collect/control calls", async () => {
    let release!: () => void;
    let firstObservation = true;
    const observer = vi.fn(() => firstObservation
      ? new Promise<{ evidence: OwnershipTargetEvidence; authoritativeClaim: { token: string; epoch: number } }>(resolve => {
        firstObservation = false;
        release = () => resolve({ evidence: targetEvidence(), authoritativeClaim: { token: "claim-1", epoch: 1 } });
      })
      : Promise.resolve({ evidence: targetEvidence(), authoritativeClaim: { token: "claim-1", epoch: 1 } }));
    const readContext = vi.fn(async () => ({}) as never);
    const observeTurn = vi.fn(async () => ({ status: "terminal" as const, assistantTurnId: "assistant-turn-1" }));
    const adapter = createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: observer,
      recovery: recoveryContext(),
      collector: { readContext },
      control: { observeTurn }
    }));
    const collectPromise = adapter.collector.readContext(collectorReadRequest());
    const controlPromise = adapter.control!.observeTurn({
      operationId: OPERATION_1,
      parentRequestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      expectedAssistantTurnId: "assistant-turn-1",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });
    await Promise.resolve();
    expect(observer).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([collectPromise, controlPromise]);
    expect(readContext).toHaveBeenCalledTimes(1);
    expect(observeTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects a resolver that tries to replace the captured page and redacts its failure", async () => {
    const page = {} as PageLike;
    const otherPage = {} as PageLike;
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      resolveTargetEvidence: () => ({ page: otherPage, evidence: targetEvidence() })
    }));

    await expect(adapter.resolveTarget(resolutionRequest(OPERATION_1))).rejects.toMatchObject({
      code: "page_affinity_mismatch"
    });
    await expect(adapter.resolveTarget(resolutionRequest(OPERATION_1))).rejects.not.toThrow(/otherPage|claim-1|opaque/);
  });

  it("rejects accessor-backed resolver and current-target results without invoking getters", async () => {
    const page = baseOptions().page;
    let resolverGetterCalls = 0;
    const resolverResult = { evidence: targetEvidence() } as Record<string, unknown>;
    Object.defineProperty(resolverResult, "evidence", {
      enumerable: true,
      get: () => {
        resolverGetterCalls += 1;
        throw new Error("hostile resolver getter");
      }
    });
    const resolverAdapter = createOperationBrowserAdapter(baseOptions({
      resolveTargetEvidence: () => resolverResult as unknown as OperationBrowserTargetProbe
    }));
    await expect(resolverAdapter.resolveTarget(resolutionRequest(OPERATION_1))).rejects.toMatchObject({
      code: "target_evidence_unavailable"
    });
    expect(resolverGetterCalls).toBe(0);

    let currentGetterCalls = 0;
    const currentResult = { evidence: targetEvidence() } as Record<string, unknown>;
    Object.defineProperty(currentResult, "evidence", {
      enumerable: true,
      get: () => {
        currentGetterCalls += 1;
        throw new Error("hostile current getter");
      }
    });
    const currentAdapter = createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: () => currentResult as unknown as ReturnType<NonNullable<OperationBrowserAdapterOptions["observeCurrentTarget"]>>
    }));
    await currentAdapter.resolveTarget(resolutionRequest(OPERATION_1));
    const stage = await currentAdapter.submission.observeStaging({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      targetBindingDigest: TARGET_DIGEST,
      configurationReceiptDigest: CONFIG_DIGEST,
      composerReceiptDigest: COMPOSER_DIGEST
    });
    expect(stage).toMatchObject({ status: "unavailable", reason: "target" });
    expect(currentGetterCalls).toBe(0);
  });

  it("serializes same-tab work but permits different tabs when the provider advertises fencing", async () => {
    let active = 0;
    let maxActive = 0;
    const adapter = createOperationBrowserAdapter(baseOptions({
      resolveTargetEvidence: request => {
        const tabId = request.target.type === "tab_id" ? request.target.tabId : "tab-1";
        return {
          evidence: targetEvidence(tabId, `claim-${tabId}`),
          authoritativeClaim: { token: `claim-${tabId}`, epoch: 1 },
          capabilities
        } satisfies OperationBrowserTargetProbe;
      },
      observeCurrentTarget: ({ target }) => ({
        evidence: targetEvidence(target.tabId, `claim-${target.tabId}`),
        authoritativeClaim: { token: `claim-${target.tabId}`, epoch: 1 }
      }),
      submission: {
        observeStaging: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 15));
          active -= 1;
          return exactStage();
        }
      }
    }));

    await adapter.resolveTarget(resolutionRequest(OPERATION_1, { type: "tab_id", tabId: "tab-1" }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_2, { type: "tab_id", tabId: "tab-2" }));
    const results = await Promise.all([
      adapter.submission.observeStaging({
        operationId: OPERATION_1,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        targetBindingDigest: TARGET_DIGEST,
        configurationReceiptDigest: CONFIG_DIGEST,
        composerReceiptDigest: COMPOSER_DIGEST
      }),
      adapter.submission.observeStaging({
        operationId: OPERATION_2,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        targetBindingDigest: TARGET_DIGEST,
        configurationReceiptDigest: CONFIG_DIGEST,
        composerReceiptDigest: COMPOSER_DIGEST
      })
    ]);

    expect(results.every(result => result.status === "exact")).toBe(true);
    expect(maxActive).toBe(2);
  });

  it("downgrades absent concurrent-tab capability to one browser actor", async () => {
    let active = 0;
    let maxActive = 0;
    const adapter = createOperationBrowserAdapter(baseOptions({
      capabilities: { ...capabilities, concurrentTabs: false },
      resolveTargetEvidence: request => {
        const tabId = request.target.type === "tab_id" ? request.target.tabId : "tab-1";
        return { evidence: { ...targetEvidence(tabId, `claim-${tabId}`), coordinationScope: "provider" }, authoritativeClaim: { token: `claim-${tabId}`, epoch: 1 } };
      },
      observeCurrentTarget: ({ target }) => ({ evidence: { ...targetEvidence(target.tabId, `claim-${target.tabId}`), coordinationScope: "provider" }, authoritativeClaim: { token: `claim-${target.tabId}`, epoch: 1 } }),
      submission: {
        observeStaging: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 15));
          active -= 1;
          return exactStage();
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1, { type: "tab_id", tabId: "tab-1" }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_2, { type: "tab_id", tabId: "tab-2" }));
    await Promise.all([
      adapter.submission.observeStaging({ operationId: OPERATION_1, requestDigest: REQUEST_DIGEST, surface: "chat", targetBindingDigest: TARGET_DIGEST, configurationReceiptDigest: CONFIG_DIGEST, composerReceiptDigest: COMPOSER_DIGEST }),
      adapter.submission.observeStaging({ operationId: OPERATION_2, requestDigest: REQUEST_DIGEST, surface: "chat", targetBindingDigest: TARGET_DIGEST, configurationReceiptDigest: CONFIG_DIGEST, composerReceiptDigest: COMPOSER_DIGEST })
    ]);
    expect(maxActive).toBe(1);
  });

  it("revalidates file identity before handoff and refuses a changed file without invoking the browser", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "operation-browser-adapter-"));
    temporaryRoots.push(root);
    const sourcePath = join(root, "input.txt");
    await writeFile(sourcePath, "before");
    const identity = await import("../../src/operations/file-identity.js").then(module => module.fingerprintOperationFile(sourcePath));
    const manifestDigest = digest("file-manifest", identity.manifest);
    let handoffs = 0;
    let targetReads = 0;
    const adapter = createOperationBrowserAdapter(baseOptions({
      files: [identity],
      fileManifestDigest: (_ordinal, manifest) => digest("file-manifest", manifest),
      observeCurrentTarget: async ({ target }) => {
        targetReads += 1;
        if (targetReads === 1) await writeFile(sourcePath, "after");
        return { evidence: targetEvidence(target.tabId), authoritativeClaim: { token: "claim-1", epoch: 1 } };
      },
      submission: {
        handoffFiles: async () => {
          handoffs += 1;
          return { status: "satisfied", evidenceDigest: EVIDENCE_DIGEST };
        }
      }
    }));
    const resolved = await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const result = await adapter.submission.executeFileHandoffOnce({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "33333333-3333-4333-8333-333333333333",
      // The service supplies its canonical durable target digest to this
      // port. The adapter's local bind digest is intentionally a different
      // evidence domain and is not compared here.
      targetBindingDigest: TARGET_DIGEST,
      manifest: {
        count: 1,
        orderPolicy: "exact",
        identities: [{ ordinal: 0, identityDigest: manifestDigest }]
      }
    });
    expect(result).toMatchObject({ status: "not_satisfied", blockerCode: "input_file_changed" });
    expect(handoffs).toBe(0);
  });

  it("forwards the caller deadline and coordinator abort to the one-shot handoff", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "operation-browser-adapter-abort-"));
    temporaryRoots.push(root);
    const sourcePath = join(root, "input.txt");
    await writeFile(sourcePath, "before");
    const identity = await import("../../src/operations/file-identity.js").then(module => module.fingerprintOperationFile(sourcePath));
    const manifestDigest = digest("file-manifest", identity.manifest);
    let handoffs = 0;
    let receivedSignal: AbortSignal | undefined;
    let receivedDeadline: number | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const adapter = createOperationBrowserAdapter(baseOptions({
      transactionTimeoutMs: 250,
      files: [identity],
      fileManifestDigest: (_ordinal, manifest) => digest("file-manifest", manifest),
      submission: {
        handoffFiles: async request => {
          handoffs += 1;
          receivedSignal = request.signal;
          receivedDeadline = request.deadlineAt;
          markStarted();
          await new Promise<void>(resolve => {
            if (request.signal?.aborted) {
              resolve();
              return;
            }
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "satisfied", evidenceDigest: EVIDENCE_DIGEST };
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));

    const requestedDeadlineAt = Date.now() + 25;
    const resultPromise = adapter.submission.executeFileHandoffOnce({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "33333333-3333-4333-8333-333333333333",
      targetBindingDigest: TARGET_DIGEST,
      manifest: {
        count: 1,
        orderPolicy: "exact",
        identities: [{ ordinal: 0, identityDigest: manifestDigest }]
      },
      deadlineAt: requestedDeadlineAt
    });
    await started;
    await expect(resultPromise).resolves.toMatchObject({ status: "uncertain", quarantine: "caller" });
    expect(handoffs).toBe(1);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedDeadline).toBeLessThanOrEqual(requestedDeadlineAt);
  });

  it("does not activate Send on observe-only reconciliation, even when called repeatedly", async () => {
    let clicks = 0;
    let postconditions = 0;
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({ click: async () => { clicks += 1; } })
    };
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      submission: {
        sendObservers: {
          observePrecondition: async request => exactPrecondition(request.expected.targetBindingDigest),
          observePostcondition: async request => {
            postconditions += 1;
            return submitted(request.expected.targetBindingDigest);
          }
        }
      }
    }));
    const resolved = await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const expected = expectedEnvelope(TARGET_DIGEST);
    const request = {
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat" as const,
      actionId: "44444444-4444-4444-8444-444444444444",
      mode: "observe_only" as const,
      expected
    };
    await expect(adapter.submission.executeFinalTabTransaction(request)).resolves.toMatchObject({ status: "already_submitted" });
    await expect(adapter.submission.executeFinalTabTransaction(request)).resolves.toMatchObject({ status: "already_submitted" });
    expect(resolved.target).toBeDefined();
    expect(clicks).toBe(0);
    expect(postconditions).toBe(2);
  });

  it("forwards the durable pre-Send baseline hooks without moving persistence after activation", async () => {
    const events: string[] = [];
    let preconditionReads = 0;
    const baseline = ownershipBaseline();
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        evaluate: async <T>() => true as T,
        click: async () => { events.push("click"); }
      })
    };
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      submission: {
        sendObservers: {
          observePrecondition: async request => {
            preconditionReads += 1;
            return {
              ...exactPrecondition(request.expected.targetBindingDigest),
              baseline: {
                userTurnEvidenceDigest: baseline.snapshotDigest,
                ownershipBaseline: baseline
              }
            };
          },
          observePostcondition: async request => submitted(request.expected.targetBindingDigest)
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));

    await expect(adapter.submission.executeFinalTabTransaction({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "44444444-4444-4444-8444-444444444444",
      mode: "mutate_once",
      expected: expectedEnvelope(TARGET_DIGEST),
      persistPreSendBaseline: async observed => {
        expect(observed).toEqual(baseline);
        events.push("baseline");
      }
    })).resolves.toMatchObject({ status: "already_submitted" });
    expect(events).toEqual(["baseline", "click"]);
    expect(preconditionReads).toBe(2);

    preconditionReads = 0;
    events.length = 0;
    await expect(adapter.submission.executeFinalTabTransaction({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "44444444-4444-4444-8444-444444444444",
      mode: "observe_only",
      expected: expectedEnvelope(TARGET_DIGEST),
      durableBaseline: baseline
    })).resolves.toMatchObject({ status: "already_submitted" });
    expect(preconditionReads).toBe(0);
    expect(events).toEqual([]);
  });

  it("uses the active phase ports in order and releases the actor between verification probes", async () => {
    const events: string[] = [];
    let probeCount = 0;
    let adapter: ReturnType<typeof createOperationBrowserAdapter>;
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        evaluate: async <T>() => true as T,
        click: async () => { events.push("click"); }
      })
    };
    adapter = createOperationBrowserAdapter(baseOptions({
      page,
      submission: {
        observeStaging: async () => {
          events.push("stage");
          return exactStage();
        },
        sendObservers: {
          observePrecondition: async () => {
            events.push("precondition");
            return exactPreconditionWithOwnership(TARGET_DIGEST);
          },
          observePostcondition: async request => {
            events.push(`probe:${request.attempt}`);
            probeCount += 1;
            return probeCount === 1
              ? { result: { status: "blocked", blockerCode: "target_evidence_unavailable" }, retryable: true }
              : submitted(TARGET_DIGEST);
          },
          sleep: async () => {
            await adapter.submission.observeStaging({
              operationId: OPERATION_1,
              requestDigest: REQUEST_DIGEST,
              surface: "chat",
              targetBindingDigest: TARGET_DIGEST,
              configurationReceiptDigest: CONFIG_DIGEST,
              composerReceiptDigest: COMPOSER_DIGEST
            });
            events.push("sleep");
          },
          maxPostconditionAttempts: 3,
          postconditionIntervalMs: 0
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const expected = expectedEnvelope(TARGET_DIGEST);
    const actionId = "44444444-4444-4444-8444-444444444444";

    const prepared = await adapter.submission.prepareSend({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId,
      expected
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    events.push("persist");

    const execution = await adapter.submission.executePreparedSend({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId,
      expected,
      prepared: prepared.prepared
    });
    expect(execution).toMatchObject({ status: "activated", mutationMayHaveOccurred: true });
    if (execution.status !== "activated") return;

    const verification = await adapter.submission.verifyPreparedSend({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId,
      expected,
      prepared: prepared.prepared,
      activation: execution.activation,
      mutationMayHaveOccurred: true
    });
    expect(verification).toMatchObject({ status: "already_submitted" });
    expect(events).toEqual(["precondition", "persist", "precondition", "click", "probe:1", "stage", "sleep", "probe:2"]);
  });

  it("reports acts-then-throws as activation_threw and verifies without a second click", async () => {
    let clicks = 0;
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        evaluate: async <T>() => true as T,
        click: async () => {
          clicks += 1;
          throw new Error("bridge acknowledgement lost");
        }
      })
    };
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      submission: {
        sendObservers: {
          observePrecondition: async () => exactPreconditionWithOwnership(TARGET_DIGEST),
          observePostcondition: async () => submitted(TARGET_DIGEST)
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const expected = expectedEnvelope(TARGET_DIGEST);
    const actionId = "44444444-4444-4444-8444-444444444444";
    const prepared = await adapter.submission.prepareSend({ operationId: OPERATION_1, requestDigest: REQUEST_DIGEST, surface: "chat", actionId, expected });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const execution = await adapter.submission.executePreparedSend({ operationId: OPERATION_1, requestDigest: REQUEST_DIGEST, surface: "chat", actionId, expected, prepared: prepared.prepared });
    expect(execution).toMatchObject({ status: "activation_threw", activation: "activation_threw", mutationMayHaveOccurred: true });
    const verification = await adapter.submission.verifyPreparedSend({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId,
      expected,
      prepared: prepared.prepared,
      activation: "activation_threw",
      mutationMayHaveOccurred: true
    });
    expect(verification).toMatchObject({ status: "already_submitted" });
    expect(clicks).toBe(1);
  });

  it("recovers from a durable baseline without preparing or activating Send", async () => {
    let clicks = 0;
    const page: PageLike = { evaluate: emptyEvaluate, getByRole: () => ({ click: async () => { clicks += 1; } }) };
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      recovery: recoveryContext(),
      submission: {
        sendObservers: {
          observePrecondition: async () => {
            throw new Error("recovery must not prepare");
          },
          observePostcondition: async request => submitted(request.expected.targetBindingDigest)
        }
      }
    }));
    const result = await adapter.submission.recoverSend({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "44444444-4444-4444-8444-444444444444",
      expected: expectedEnvelope(TARGET_DIGEST),
      durableBaseline: ownershipBaseline()
    });
    expect(result).toMatchObject({ status: "already_submitted" });
    expect(clicks).toBe(0);
  });

  it("releases the same-tab actor between Send probes so a status read can interleave", async () => {
    const events: string[] = [];
    let probes = 0;
    let adapter: ReturnType<typeof createOperationBrowserAdapter>;
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        evaluate: async <T>() => true as T,
        click: async () => undefined
      })
    };
    adapter = createOperationBrowserAdapter(baseOptions({
      page,
      submission: {
        observeStaging: async () => exactStage(),
        sendObservers: {
          observePrecondition: async request => exactPrecondition(request.expected.targetBindingDigest),
          observePostcondition: async request => {
            probes += 1;
            events.push(`post:${request.attempt}`);
            return probes === 1
              ? { result: { status: "blocked", blockerCode: "target_evidence_unavailable" }, retryable: true }
              : submitted(request.expected.targetBindingDigest);
          },
          sleep: async () => {
            const status = await adapter.submission.observeStaging({
              operationId: OPERATION_1,
              requestDigest: REQUEST_DIGEST,
              surface: "chat",
              targetBindingDigest: TARGET_DIGEST,
              configurationReceiptDigest: CONFIG_DIGEST,
              composerReceiptDigest: COMPOSER_DIGEST
            });
            expect(status).toMatchObject({ status: "exact" });
            events.push("status");
          },
          maxPostconditionAttempts: 3,
          postconditionIntervalMs: 0
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));

    const result = await adapter.submission.executeFinalTabTransaction({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "44444444-4444-4444-8444-444444444444",
      mode: "mutate_once",
      expected: expectedEnvelope(TARGET_DIGEST)
    });

    expect(result).toMatchObject({ status: "already_submitted" });
    expect(events).toEqual(["post:1", "status", "post:2"]);
  });

  it("passes each postcondition probe its own coordinator cancellation signal", async () => {
    let probeSignalAborted = false;
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        evaluate: async <T>() => true as T,
        click: async () => undefined
      })
    };
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      transactionTimeoutMs: 5,
      submission: {
        sendObservers: {
          observePrecondition: async request => exactPrecondition(request.expected.targetBindingDigest),
          observePostcondition: async request => await new Promise<SubmissionFinalTransactionResult>(resolve => {
            const fallback = setTimeout(() => resolve(submitted(request.expected.targetBindingDigest)), 50);
            request.signal?.addEventListener("abort", () => {
              clearTimeout(fallback);
              probeSignalAborted = true;
              resolve({ status: "blocked", blockerCode: "target_evidence_unavailable" });
            }, { once: true });
          })
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));

    await expect(adapter.submission.executeFinalTabTransaction({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "44444444-4444-4444-8444-444444444444",
      mode: "mutate_once",
      expected: expectedEnvelope(TARGET_DIGEST)
    })).resolves.toMatchObject({ status: "uncertain" });
    expect(probeSignalAborted).toBe(true);
  });

  it("runs Work-steer phases in order, exposes active actor context, and coexists with Send preparation", async () => {
    const events: string[] = [];
    let mutations = 0;
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({ count: async () => 1, isVisible: async () => true, click: async () => undefined })
    };
    const prepared = steerPrepared();
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      submission: {
        sendObservers: {
          observePrecondition: async request => {
            events.push("send-prepare");
            return exactPreconditionWithOwnership(request.expected.targetBindingDigest);
          },
          observePostcondition: async request => submitted(request.expected.targetBindingDigest)
        }
      },
      control: {
        prepareSteer: async (request, activePage, activeTarget) => {
          events.push("steer-prepare");
          expect(activePage).toBe(page);
          expect(activeTarget.tabId).toBe("tab-1");
          expect(request.signal).toBeInstanceOf(AbortSignal);
          expect(request.deadlineAt).toBeLessThanOrEqual(Date.now() + 1_000);
          expect("prompt" in request).toBe(false);
          return preparedSteerResult(prepared);
        },
        executeSteerPrepared: async (request, activePage, activeTarget) => {
          events.push("steer-execute");
          expect(activePage).toBe(page);
          expect(activeTarget.tabId).toBe("tab-1");
          mutations += 1;
          return executedSteerResult(request.prepared);
        },
        verifySteer: async (request, activePage, activeTarget) => {
          events.push("steer-verify");
          expect(activePage).toBe(page);
          expect(activeTarget.tabId).toBe("tab-1");
          return satisfiedSteerResult(request.prepared);
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const control = steerAdapter(adapter);

    const preparedResult = await control.prepareSteer(steerPrepareRequest());
    expect(preparedResult).toMatchObject({ phase: "prepare", status: "prepared" });
    const sendPrepared = await adapter.submission.prepareSend({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "44444444-4444-4444-8444-444444444444",
      expected: expectedEnvelope(TARGET_DIGEST)
    });
    expect(sendPrepared.status).toBe("prepared");
    expect(events).toEqual(["steer-prepare", "send-prepare"]);

    const executeResult = await control.executeSteerPrepared({
      schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
      prepared,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });
    expect(executeResult).toMatchObject({ phase: "execute_prepared", status: "executed" });
    const verifyResult = await control.verifySteer({
      schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
      prepared,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });
    expect(verifyResult).toMatchObject({ phase: "verify", status: "satisfied" });
    expect(events).toEqual(["steer-prepare", "send-prepare", "steer-execute", "steer-verify"]);
    expect(mutations).toBe(1);
  });

  it("converges an acts-then-throws Work-steer mutation through recovery without executing again", async () => {
    let executeCalls = 0;
    let recoverCalls = 0;
    const prepared = steerPrepared();
    const adapter = createOperationBrowserAdapter(baseOptions({
      control: {
        executeSteerPrepared: async () => {
          executeCalls += 1;
          throw new Error("provider acknowledgement lost");
        },
        recoverSteer: async request => {
          recoverCalls += 1;
          return satisfiedSteerResult(request.prepared, "recovery");
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const control = steerAdapter(adapter);
    const execution = await control.executeSteerPrepared({
      schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
      prepared,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });
    expect(execution).toMatchObject({
      phase: "execute_prepared",
      status: "uncertain",
      mutationBoundary: "control_may_have_occurred",
      observationRequired: true
    });
    const recovery = await control.recoverSteer({
      schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
      prepared,
      baseline: prepared.baseline,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });
    expect(recovery).toMatchObject({ phase: "recovery", status: "satisfied" });
    expect(executeCalls).toBe(1);
    expect(recoverCalls).toBe(1);
  });

  it("hydrates restart recovery observation-only and never calls prepare or execute", async () => {
    let prepares = 0;
    let executes = 0;
    let recoveries = 0;
    const prepared = steerPrepared();
    const observer = vi.fn(async () => ({
      evidence: targetEvidence(),
      authoritativeClaim: { token: "claim-1", epoch: 1 }
    }));
    const adapterOptions = baseOptions();
    const adapter = createOperationBrowserAdapter({
      ...adapterOptions,
      observeCurrentTarget: observer,
      recovery: recoveryContext(),
      control: {
        prepareSteer: async () => {
          prepares += 1;
          return preparedSteerResult(prepared);
        },
        executeSteerPrepared: async request => {
          executes += 1;
          return executedSteerResult(request.prepared);
        },
        recoverSteer: async (request, activePage) => {
          recoveries += 1;
          expect(activePage).toBe(adapterOptions.page);
          return satisfiedSteerResult(request.prepared, "recovery");
        }
      }
    });
    const control = steerAdapter(adapter);
    const recovery = await control.recoverSteer({
      schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
      prepared,
      baseline: prepared.baseline,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });
    expect(recovery).toMatchObject({ phase: "recovery", status: "satisfied" });
    expect(prepares).toBe(0);
    expect(executes).toBe(0);
    expect(recoveries).toBe(1);
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("fails Work-steer closed on target mismatch without invoking the provider mutation", async () => {
    let executeCalls = 0;
    const adapter = createOperationBrowserAdapter(baseOptions({
      observeCurrentTarget: ({ target }) => ({
        evidence: targetEvidence(target.tabId === "tab-1" ? "tab-2" : target.tabId, "claim-tab-2"),
        authoritativeClaim: { token: "claim-tab-2", epoch: 1 }
      }),
      control: {
        executeSteerPrepared: async request => {
          executeCalls += 1;
          return executedSteerResult(request.prepared);
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const result = await steerAdapter(adapter).executeSteerPrepared({
      schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
      prepared: steerPrepared(),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });
    expect(result).toMatchObject({
      phase: "execute_prepared",
      status: "uncertain",
      blockerCode: "target_binding_mismatch",
      mutationBoundary: "control_may_have_occurred"
    });
    expect(executeCalls).toBe(0);
  });

  it("awaits an in-flight Work-steer provider after coordinator timeout before releasing the actor", async () => {
    const events: string[] = [];
    const prepared = steerPrepared();
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({ count: async () => 1, isVisible: async () => true, click: async () => undefined })
    };
    let adapter!: ReturnType<typeof createOperationBrowserAdapter>;
    const adapterOptions = baseOptions({
      page,
      transactionTimeoutMs: 5,
      submission: {
        observeStaging: async () => {
          events.push("staging");
          return exactStage();
        }
      },
      control: {
        executeSteerPrepared: async request => {
          events.push("mutation-start");
          await new Promise<void>(resolve => {
            if (request.signal.aborted) {
              resolve();
              return;
            }
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          events.push("mutation-settled");
          throw new Error("late provider acknowledgement");
        }
      }
    });
    adapter = createOperationBrowserAdapter(adapterOptions);
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const result = await steerAdapter(adapter).executeSteerPrepared({
      schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
      prepared,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5
    });
    expect(result).toMatchObject({ phase: "execute_prepared", status: "uncertain" });
    expect(events).toEqual(["mutation-start", "mutation-settled"]);
    await expect(adapter.submission.observeStaging({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      targetBindingDigest: TARGET_DIGEST,
      configurationReceiptDigest: CONFIG_DIGEST,
      composerReceiptDigest: COMPOSER_DIGEST
    })).resolves.toMatchObject({ status: "exact" });
    expect(events).toEqual(["mutation-start", "mutation-settled", "staging"]);
  });

  it("does not return or re-enter the same tab while an activation call is in flight", async () => {
    let releaseClick!: () => void;
    let markClickStarted!: () => void;
    const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
    const clickStarted = new Promise<void>(resolve => { markClickStarted = resolve; });
    let stagingStarted = false;
    const coordinator = new ProcessTabCoordinator();
    const page: PageLike = {
      evaluate: emptyEvaluate,
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        evaluate: async <T>() => true as T,
        click: async () => {
          markClickStarted();
          await clickGate;
        }
      })
    };
    const adapter = createOperationBrowserAdapter(baseOptions({
      page,
      coordinator,
      transactionTimeoutMs: 20,
      submission: {
        observeStaging: async () => {
          stagingStarted = true;
          return exactStage();
        },
        sendObservers: {
          observePrecondition: async request => exactPrecondition(request.expected.targetBindingDigest),
          observePostcondition: async request => submitted(request.expected.targetBindingDigest)
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));

    const send = adapter.submission.executeFinalTabTransaction({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "44444444-4444-4444-8444-444444444444",
      mode: "mutate_once",
      expected: expectedEnvelope(TARGET_DIGEST)
    });
    await clickStarted;
    let sendSettled = false;
    void send.then(() => { sendSettled = true; });
    const recovery = adapter.submission.observeStaging({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      targetBindingDigest: TARGET_DIGEST,
      configurationReceiptDigest: CONFIG_DIGEST,
      composerReceiptDigest: COMPOSER_DIGEST
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(sendSettled).toBe(false);
    expect(stagingStarted).toBe(false);

    releaseClick();
    const sendResult = await send;
    expect(["submitted", "already_submitted", "uncertain"]).toContain(sendResult.status);
    await expect(recovery).resolves.toMatchObject({ status: "exact" });
    expect(stagingStarted).toBe(true);
  });

  it("does not manufacture an all-zero digest for unavailable staging evidence", async () => {
    const adapter = createOperationBrowserAdapter(baseOptions({
      submission: {}
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const result = await adapter.submission.observeStaging({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      targetBindingDigest: TARGET_DIGEST,
      configurationReceiptDigest: CONFIG_DIGEST,
      composerReceiptDigest: COMPOSER_DIGEST
    });
    expect(result).toEqual({ status: "unavailable", reason: "unknown" });
    expect(JSON.stringify(result)).not.toContain("0000000000000000000000000000000000000000000000000000000000000000");
  });

  it("never includes raw paths, prompts, or claim tokens in adapter diagnostics", async () => {
    const secretPath = "/private/secret/prompt.txt";
    const adapter = createOperationBrowserAdapter(baseOptions({
      resolveTargetEvidence: () => {
        throw new Error(`provider failed for ${secretPath} with prompt=private prompt claim=claim-secret`);
      }
    }));
    let failure: unknown;
    try {
      await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OperationBrowserAdapterError);
    expect(JSON.stringify(failure)).not.toContain(secretPath);
    expect(JSON.stringify(failure)).not.toContain("private prompt");
    expect(JSON.stringify(failure)).not.toContain("claim-secret");
  });

  it("releases the tab actor before materializing an artifact stream", async () => {
    const outputDirectory = await mkdtemp(join("/tmp", "operation-artifact-adapter-"));
    temporaryRoots.push(outputDirectory);
    const coordinator = new ProcessTabCoordinator();
    const events: string[] = [];
    let adapter!: ReturnType<typeof createOperationBrowserAdapter>;
    let stagingProbe: Promise<unknown> | undefined;
    let acquiredRequest: unknown;
    let actorAvailableDuringMaterialize = false;
    const acquireDownload = vi.fn(async (...args: unknown[]) => {
      acquiredRequest = args[0];
      events.push("acquire");
      return {} as never;
    });
    const materializeDownload = vi.fn(async () => {
      events.push("materialize-start");
      const probe = adapter.submission.observeStaging({
        operationId: OPERATION_1,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        targetBindingDigest: TARGET_DIGEST,
        configurationReceiptDigest: CONFIG_DIGEST,
        composerReceiptDigest: COMPOSER_DIGEST
      });
      stagingProbe = probe;
      const available = await Promise.race([
        probe.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))
      ]);
      actorAvailableDuringMaterialize = available;
      events.push("materialize-end");
      return (async function* () {
        yield Uint8Array.from([1, 2, 3]);
      })();
    });
    const adapterOptions = baseOptions({
      coordinator,
      outputDirectory,
      artifacts: { acquireDownload, materializeDownload },
      submission: { observeStaging: async () => exactStage() }
    });
    adapter = createOperationBrowserAdapter(adapterOptions);
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));
    const result = await adapter.artifacts!.transfer({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      assistantTurnId: "assistant-turn-1",
      sourceIdentityDigest: EVIDENCE_DIGEST,
      kind: "file",
      ordinal: 0,
      transferActionId: CONTROL_ACTION,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000,
      journal: {
        readActionState: async () => undefined,
        persistIntent: async () => undefined,
        persistReceipt: async () => undefined
      }
    });
    await stagingProbe;

    expect(result.outcome).toBe("satisfied");
    expect(acquireDownload).toHaveBeenCalledTimes(1);
    expect(acquiredRequest).toMatchObject({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      assistantTurnId: "assistant-turn-1",
      sourceIdentityDigest: EVIDENCE_DIGEST,
      kind: "file",
      ordinal: 0,
      transferActionId: CONTROL_ACTION
    });
    expect(materializeDownload).toHaveBeenCalledTimes(1);
    expect(actorAvailableDuringMaterialize).toBe(true);
    expect(events).toEqual(["acquire", "materialize-start", "materialize-end"]);
  });

  it("keeps a same-tab mutation held until a late artifact click evaluator settles", async () => {
    const outputDirectory = await mkdtemp(join("/tmp", "operation-artifact-adapter-settlement-"));
    temporaryRoots.push(outputDirectory);
    const coordinator = new ProcessTabCoordinator();
    const events: string[] = [];
    let releaseClick!: () => void;
    let markClickStarted!: () => void;
    const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
    const clickStarted = new Promise<void>(resolve => { markClickStarted = resolve; });
    let stagingStarted = false;
    const download: DownloadLike = {
      createReadStream: async () => (async function* () {
        yield Uint8Array.from([1, 2, 3]);
      })()
    };
    const acquireDownload = vi.fn(async () => {
      events.push("click-start");
      markClickStarted();
      await clickGate;
      events.push("click-settled");
      return download;
    });
    const materializeDownload = vi.fn(async () => (async function* () {
      yield Uint8Array.from([1, 2, 3]);
    })());
    const adapter = createOperationBrowserAdapter(baseOptions({
      coordinator,
      transactionTimeoutMs: 100,
      outputDirectory,
      artifacts: { acquireDownload, materializeDownload },
      submission: {
        observeStaging: async () => {
          stagingStarted = true;
          events.push("staging");
          return exactStage();
        }
      }
    }));
    await adapter.resolveTarget(resolutionRequest(OPERATION_1));

    const transfer = adapter.artifacts!.transfer({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      assistantTurnId: "assistant-turn-late-click",
      sourceIdentityDigest: EVIDENCE_DIGEST,
      kind: "file",
      ordinal: 0,
      transferActionId: "77777777-7777-4777-8777-777777777777",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 25,
      journal: {
        readActionState: async () => undefined,
        persistIntent: async () => undefined,
        persistReceipt: async () => undefined
      }
    });
    await clickStarted;
    const staging = adapter.submission.observeStaging({
      operationId: OPERATION_1,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      targetBindingDigest: TARGET_DIGEST,
      configurationReceiptDigest: CONFIG_DIGEST,
      composerReceiptDigest: COMPOSER_DIGEST
    });

    // The coordinator deadline may settle the caller-facing transfer result,
    // but it must not release the actor while the click evaluator is pending.
    await expect(transfer).resolves.toMatchObject({ outcome: "uncertain" });
    expect(stagingStarted).toBe(false);
    expect(events).toEqual(["click-start"]);

    releaseClick();
    await expect(staging).resolves.toMatchObject({ status: "exact" });
    expect(stagingStarted).toBe(true);
    expect(events).toEqual(["click-start", "click-settled", "staging"]);
  });
});
