import { describe, expect, it, vi } from "vitest";
import type { PageLike } from "../../src/types.js";
import {
  createRuntimeOperationBrowserAdapter,
  OperationRuntimeAdapterError,
  type OperationRuntimeAdapterOptions,
  type OperationRuntimeBrowserCapture
} from "../../src/operations/runtime-adapter.js";
import type { OperationTargetResolutionRequest } from "../../src/operations/service.js";
import type { OwnershipTargetEvidence } from "../../src/operations/turn-ownership.js";
import { ProcessTabCoordinator } from "../../src/runtime/tab-coordinator.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_DIGEST = `hmac-sha256:${"1".repeat(64)}`;
const EVIDENCE_DIGEST = `hmac-sha256:${"2".repeat(64)}`;
const TARGET_DIGEST = `hmac-sha256:${"3".repeat(64)}`;
const CONFIG_DIGEST = `hmac-sha256:${"4".repeat(64)}`;
const COMPOSER_DIGEST = `hmac-sha256:${"5".repeat(64)}`;
const USER_EVIDENCE = `hmac-sha256:${"6".repeat(64)}`;
const ASSISTANT_EVIDENCE = `hmac-sha256:${"7".repeat(64)}`;
const ESTABLISHMENT_ACTION = "33333333-3333-4333-8333-333333333333";

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

function targetEvidence(tabId = "tab-1"): OwnershipTargetEvidence {
  return {
    provider: identity("provider-1"),
    browser: identity("browser-1"),
    tab: identity(tabId),
    thread: identity(`thread-${tabId}`),
    conversation: identity(`conversation-${tabId}`),
    canonicalThreadUrl: identity(`https://opaque.invalid/thread/${"a".repeat(64)}`),
    authoritativeTabClaim: identity(`claim-${tabId}`),
    coordinationScope: "process"
  };
}

const page: PageLike = {
  evaluate: async <T, A = unknown>(_fn: (arg: A) => T | Promise<T>, _arg?: A) => ({}) as T
};

function resolutionRequest(operationId = OPERATION_ID): OperationTargetResolutionRequest {
  return {
    operationId,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    target: { type: "selected_tab" },
    signal: new AbortController().signal
  };
}

function stageRequest(operationId = OPERATION_ID) {
  return {
    operationId,
    requestDigest: REQUEST_DIGEST,
    surface: "chat" as const,
    targetBindingDigest: TARGET_DIGEST,
    configurationReceiptDigest: CONFIG_DIGEST,
    composerReceiptDigest: COMPOSER_DIGEST
  };
}

function currentTarget(target: OwnershipTargetEvidence) {
  return {
    evidence: target,
    authoritativeClaim: {
      token: target.authoritativeTabClaim.status === "available" ? target.authoritativeTabClaim.value : "claim-tab-1",
      epoch: 1
    }
  };
}

function recoveredTarget() {
  const canonicalThreadUrl = `https://opaque.invalid/thread/${"a".repeat(64)}`;
  return Object.freeze({
    providerId: "provider-1",
    browserId: "browser-1",
    tabId: "tab-1",
    coordinationScope: "process" as const,
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
      authoritativeTabClaim: "unavailable" as const,
      replacementTabRecovery: false
    },
    targetLifecycle: "new_established" as const,
    newTargetAnchorDigest: EVIDENCE_DIGEST,
    blankTaskEvidenceDigest: CONFIG_DIGEST,
    targetEstablishment: {
      targetBindingDigest: TARGET_DIGEST,
      anchorDigest: EVIDENCE_DIGEST,
      causalSendActionId: ESTABLISHMENT_ACTION,
      conversationId: "conversation-tab-1",
      canonicalThreadUrl,
      userTurnId: "user-turn-1",
      userTurnEvidenceDigest: USER_EVIDENCE,
      postSendDeltaDigest: EVIDENCE_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: "2026-08-16T23:00:00.000Z"
    }
  });
}

function recoveryOptions(
  capture: OperationRuntimeAdapterOptions["capture"],
  overrides: Partial<OperationRuntimeAdapterOptions> = {}
): OperationRuntimeAdapterOptions {
  return options(capture, {
    recovery: Object.freeze({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat" as const,
      target: recoveredTarget(),
      targetRequest: Object.freeze({ type: "tab_id" as const, tabId: "tab-1" })
    }),
    ...overrides
  });
}

function recoveryCollectorRequest(signal: AbortSignal = new AbortController().signal) {
  return {
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    signal
  };
}

function options(
  capture: OperationRuntimeAdapterOptions["capture"],
  overrides: Partial<OperationRuntimeAdapterOptions> = {}
): OperationRuntimeAdapterOptions {
  return {
    owner: { backendSessionId: "backend-session-1" },
    evidenceDigest: digest,
    capture,
    coordinator: new ProcessTabCoordinator(),
    ...overrides
  };
}

function captureWithStage(stage: () => Promise<unknown> | unknown = () => ({ status: "exact", evidenceDigest: EVIDENCE_DIGEST })): OperationRuntimeBrowserCapture {
  const evidence = targetEvidence();
  return {
    page,
    targetEvidence: evidence,
    authoritativeClaim: { token: "claim-tab-1", epoch: 1 },
    observeCurrentTarget: () => currentTarget(evidence),
    primitives: {
      submission: {
        observeStaging: async () => await stage() as never
      }
    }
  };
}

describe("lazy runtime operation browser adapter", () => {
  it("lazily captures exactly once for pre-resolve collect/control recovery and preserves the full target", async () => {
    const capture = vi.fn((request: Parameters<OperationRuntimeAdapterOptions["capture"]>[0]) => {
      expect(request.operationId).toBe(OPERATION_ID);
      expect(request.requestDigest).toBe(REQUEST_DIGEST);
      expect(request.surface).toBe("chat");
      expect(request.target).toEqual({ type: "tab_id", tabId: "tab-1" });
      const evidence = targetEvidence();
      return {
        page,
        observeCurrentTarget: () => currentTarget(evidence),
        primitives: {
          collector: {
            readContext: async (_request: unknown, _page: PageLike, target: unknown) => {
              expect(target).toEqual(recoveredTarget());
              return {} as never;
            }
          },
          control: {
            observeTurn: async () => ({ status: "terminal" as const, assistantTurnId: "assistant-1" })
          }
        }
      } satisfies OperationRuntimeBrowserCapture;
    });
    const adapter = createRuntimeOperationBrowserAdapter(recoveryOptions(capture));

    await adapter.collector.readContext(recoveryCollectorRequest());
    await adapter.control!.observeTurn({
      operationId: OPERATION_ID,
      parentRequestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      expectedAssistantTurnId: "assistant-1",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000
    });

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent recovery calls for another authenticated identity before capture", async () => {
    const capture = vi.fn(() => {
      const evidence = targetEvidence();
      return {
        page,
        observeCurrentTarget: () => currentTarget(evidence),
        primitives: { collector: { readContext: async () => ({}) as never } }
      } satisfies OperationRuntimeBrowserCapture;
    });
    const adapter = createRuntimeOperationBrowserAdapter(recoveryOptions(capture));
    const wrong = recoveryCollectorRequest();
    wrong.operationId = "22222222-2222-4222-8222-222222222222";
    await expect(adapter.collector.readContext(wrong)).rejects.toMatchObject({ code: "capture_incomplete" });
    expect(capture).not.toHaveBeenCalled();
    await adapter.collector.readContext(recoveryCollectorRequest());
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does not invoke any mutation primitive while recovering a target", async () => {
    const mutation = vi.fn(async () => ({
      status: "satisfied" as const,
      assistantTurnId: "assistant-1",
      evidenceDigest: EVIDENCE_DIGEST
    }));
    const capture = vi.fn(() => {
      const evidence = targetEvidence();
      return {
        page,
        observeCurrentTarget: () => currentTarget(evidence),
        primitives: {
          collector: { readContext: async () => ({}) as never },
          control: { executeOnce: mutation }
        }
      } satisfies OperationRuntimeBrowserCapture;
    });
    const adapter = createRuntimeOperationBrowserAdapter(recoveryOptions(capture));
    await adapter.collector.readContext(recoveryCollectorRequest());
    expect(mutation).not.toHaveBeenCalled();
  });

  it("snapshots a proxied runtime recovery/options object without invoking get traps", async () => {
    const getTrap = vi.fn(() => {
      throw new Error("runtime option get trap");
    });
    const raw = recoveryOptions(() => {
      const evidence = targetEvidence();
      return {
        page,
        observeCurrentTarget: () => currentTarget(evidence),
        primitives: { collector: { readContext: async () => ({}) as never } }
      } satisfies OperationRuntimeBrowserCapture;
    });
    const proxiedRecovery = new Proxy(raw.recovery!, { get: getTrap });
    const proxiedOptions = new Proxy({ ...raw, recovery: proxiedRecovery }, { get: getTrap });
    const adapter = createRuntimeOperationBrowserAdapter(proxiedOptions);

    await adapter.collector.readContext(recoveryCollectorRequest());
    expect(getTrap).not.toHaveBeenCalled();
  });

  it("does not capture or touch a browser before target resolution", async () => {
    const capture = vi.fn(() => captureWithStage());
    const adapter = createRuntimeOperationBrowserAdapter(options(capture));

    expect(capture).not.toHaveBeenCalled();
    await expect(adapter.submission.observeStaging(stageRequest())).resolves.toMatchObject({
      status: "unavailable"
    });
    expect(capture).not.toHaveBeenCalled();

    await adapter.resolveTarget(resolutionRequest());
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("returns exact unavailable protocol results for every phased Send port before initialization", async () => {
    const capture = vi.fn(() => captureWithStage());
    const adapter = createRuntimeOperationBrowserAdapter(options(capture));

    await expect(adapter.submission.prepareSend({} as never)).resolves.toEqual({
      status: "blocked",
      result: { status: "blocked", blockerCode: "target_evidence_unavailable" }
    });
    await expect(adapter.submission.executePreparedSend({} as never)).resolves.toEqual({
      status: "blocked",
      result: { status: "blocked", blockerCode: "target_evidence_unavailable" }
    });
    await expect(adapter.submission.verifyPreparedSend({} as never)).resolves.toEqual({
      status: "blocked",
      blockerCode: "target_evidence_unavailable"
    });
    await expect(adapter.submission.recoverSend({} as never)).resolves.toEqual({
      status: "blocked",
      blockerCode: "target_evidence_unavailable"
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("uses the recovery target for recoverSend without invoking the legacy final transaction", async () => {
    const capture = vi.fn(() => {
      const evidence = targetEvidence();
      return {
        page,
        observeCurrentTarget: () => currentTarget(evidence),
        // No Send observers are wired: the composed phase adapter must return
        // its deterministic provider-unavailable result after recovery.
        primitives: { collector: { readContext: async () => ({}) as never } }
      } satisfies OperationRuntimeBrowserCapture;
    });
    const adapter = createRuntimeOperationBrowserAdapter(recoveryOptions(capture));

    const result = await adapter.submission.recoverSend({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: ESTABLISHMENT_ACTION,
      expected: {} as never,
      durableBaseline: {} as never
    } as never);

    expect(result).toEqual({ status: "uncertain", quarantine: "provider" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("delegates the prepared Send phase to the composed adapter primitive", async () => {
    const evidence = targetEvidence();
    const observePrecondition = vi.fn(async () => ({
      status: "mismatch" as const,
      code: "composer_drift" as const,
      evidenceDigest: EVIDENCE_DIGEST
    }));
    const capture = vi.fn(() => ({
      page,
      targetEvidence: evidence,
      authoritativeClaim: { token: "claim-tab-1", epoch: 1 },
      observeCurrentTarget: () => currentTarget(evidence),
      primitives: {
        submission: {
          sendObservers: {
            observePrecondition,
            observePostcondition: async () => ({ status: "uncertain" as const, quarantine: "provider" as const })
          }
        }
      }
    } satisfies OperationRuntimeBrowserCapture));
    const adapter = createRuntimeOperationBrowserAdapter(options(capture));

    await adapter.resolveTarget(resolutionRequest());
    const result = await adapter.submission.prepareSend({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: ESTABLISHMENT_ACTION,
      expected: {
        surface: "chat",
        targetBindingDigest: TARGET_DIGEST,
        configurationReceiptDigest: CONFIG_DIGEST,
        composerReceiptDigest: COMPOSER_DIGEST,
        attachmentManifest: { count: 0, orderPolicy: "exact", identities: [] }
      }
    });

    expect(result).toEqual({
      status: "blocked",
      result: { status: "blocked", blockerCode: "composer_drift", evidenceDigest: EVIDENCE_DIGEST }
    });
    expect(observePrecondition).toHaveBeenCalledTimes(1);
  });

  it("captures one immutable page/context and delegates through the composed adapter", async () => {
    const capture = vi.fn(() => captureWithStage());
    const adapter = createRuntimeOperationBrowserAdapter(options(capture));

    await adapter.resolveTarget(resolutionRequest());
    await adapter.resolveTarget(resolutionRequest());
    const result = await adapter.submission.observeStaging(stageRequest());

    expect(capture).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "exact", evidenceDigest: EVIDENCE_DIGEST });
  });

  it("fails closed when capture omits exact target evidence", async () => {
    const capture = vi.fn(() => ({ page }));
    const adapter = createRuntimeOperationBrowserAdapter(options(capture));

    await expect(adapter.resolveTarget(resolutionRequest())).rejects.toMatchObject({
      code: "target_evidence_unavailable"
    });
    await expect(adapter.resolveTarget(resolutionRequest())).rejects.toBeInstanceOf(OperationRuntimeAdapterError);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("rejects accessor-backed captures without invoking private getters", async () => {
    let reads = 0;
    const captureResult = { page } as Record<string, unknown>;
    Object.defineProperty(captureResult, "targetEvidence", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("private target getter");
      }
    });
    const adapter = createRuntimeOperationBrowserAdapter(options(() => captureResult as unknown as OperationRuntimeBrowserCapture));

    await expect(adapter.resolveTarget(resolutionRequest())).rejects.toMatchObject({
      code: "capture_incomplete"
    });
    expect(reads).toBe(0);
  });

  it("preserves own __proto__ data keys while cloning a recovered target", async () => {
    const target = { ...recoveredTarget() } as Record<string, unknown>;
    Object.defineProperty(target, "__proto__", {
      value: "recovered-target-marker",
      enumerable: true,
      writable: true,
      configurable: true
    });
    const evidence = targetEvidence();
    const capture = vi.fn(() => ({
      page,
      observeCurrentTarget: () => currentTarget(evidence),
      primitives: {
        collector: {
          readContext: async (_request: unknown, _page: PageLike, recovered: unknown) => {
            const record = recovered as Record<string, unknown>;
            expect(Object.getPrototypeOf(record)).toBe(null);
            expect(Object.prototype.hasOwnProperty.call(record, "__proto__")).toBe(true);
            expect(record["__proto__"]).toBe("recovered-target-marker");
            return {} as never;
          }
        }
      }
    } satisfies OperationRuntimeBrowserCapture));
    const adapter = createRuntimeOperationBrowserAdapter(recoveryOptions(capture, {
      recovery: Object.freeze({
        ...recoveryOptions(capture).recovery!,
        target: target as ReturnType<typeof recoveredTarget>
      })
    }));

    await adapter.collector.readContext(recoveryCollectorRequest());
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("preserves a redacted capture blocker code without reading provider diagnostics", async () => {
    const providerError = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(providerError, "code", {
      value: "browser_bridge_unavailable",
      enumerable: true
    });
    Object.defineProperty(providerError, "message", {
      get: () => {
        throw new Error("provider diagnostics must not be read");
      }
    });
    const adapter = createRuntimeOperationBrowserAdapter(options(async () => {
      throw providerError;
    }));

    await expect(adapter.resolveTarget(resolutionRequest())).rejects.toMatchObject({
      code: "browser_bridge_unavailable"
    });
  });

  it("rejects a resolver that tries to replace the captured page", async () => {
    const otherPage: PageLike = { ...page };
    const evidence = targetEvidence();
    const adapter = createRuntimeOperationBrowserAdapter(options(() => ({
      page,
      resolveTargetEvidence: () => ({ page: otherPage, evidence })
    })));

    await expect(adapter.resolveTarget(resolutionRequest())).rejects.toMatchObject({
      code: "page_affinity_mismatch"
    });
  });

  it("returns redacted unsupported-operation blockers when safe primitives are not wired", async () => {
    const evidence = targetEvidence();
    const adapter = createRuntimeOperationBrowserAdapter(options(() => ({
      page,
      targetEvidence: evidence,
      authoritativeClaim: { token: "claim-tab-1", epoch: 1 },
      observeCurrentTarget: () => currentTarget(evidence)
    }), { exposeControl: true }));

    await adapter.resolveTarget(resolutionRequest());
    await expect(adapter.submission.executeFinalTabTransaction({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "22222222-2222-4222-8222-222222222222",
      mode: "mutate_once",
      expected: {
        surface: "chat",
        targetBindingDigest: TARGET_DIGEST,
        configurationReceiptDigest: CONFIG_DIGEST,
        composerReceiptDigest: COMPOSER_DIGEST,
        attachmentManifest: { count: 0, orderPolicy: "exact", identities: [] }
      }
    })).resolves.toMatchObject({
      status: "blocked",
      blockerCode: "target_evidence_unavailable"
    });
    await expect(adapter.control!.executeOnce({} as never)).resolves.toMatchObject({
      status: "uncertain",
      blockerCode: "send_control_unavailable"
    });
  });

  it("does not hold a coordinator actor across the adapter's external sleep", async () => {
    const evidence = targetEvidence();
    let active = 0;
    let maxActive = 0;
    const adapter = createRuntimeOperationBrowserAdapter(options(() => ({
      page,
      targetEvidence: evidence,
      authoritativeClaim: { token: "claim-tab-1", epoch: 1 },
      observeCurrentTarget: () => currentTarget(evidence),
      primitives: {
        submission: {
          observeStaging: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return { status: "exact", evidenceDigest: EVIDENCE_DIGEST };
          }
        },
        collector: {
          sleep: async milliseconds => {
            await new Promise(resolve => setTimeout(resolve, milliseconds));
          }
        }
      }
    })));

    await adapter.resolveTarget(resolutionRequest());
    await Promise.all([
      adapter.submission.observeStaging(stageRequest()),
      adapter.collector.sleep(5, new AbortController().signal),
      adapter.submission.observeStaging(stageRequest())
    ]);

    // Two short observations are serialized on the process-scoped actor; the
    // collector sleep is an independent timer and does not enter that actor.
    expect(maxActive).toBe(1);
  });

  it("exposes captured artifact transfer only on a request-local submit adapter", async () => {
    const evidence = targetEvidence();
    const artifactPrimitive = {
      acquireDownload: vi.fn(async () => ({}) as never),
      materializeDownload: vi.fn(async () => (async function* () { yield new Uint8Array(); })())
    };
    const capture = vi.fn(() => ({
      page,
      targetEvidence: evidence,
      observeCurrentTarget: () => currentTarget(evidence),
      outputDirectory: "/tmp/request-local-artifacts",
      primitives: { artifacts: artifactPrimitive }
    } satisfies OperationRuntimeBrowserCapture));
    const adapter = createRuntimeOperationBrowserAdapter(options(capture, { exposeArtifacts: true }));

    expect(adapter.artifacts).toBeDefined();
    await adapter.resolveTarget(resolutionRequest());
    expect(typeof adapter.artifacts?.transfer).toBe("function");

    const recoveryCapture = vi.fn(() => ({
      page,
      observeCurrentTarget: () => currentTarget(evidence),
      primitives: { artifacts: artifactPrimitive }
    } satisfies OperationRuntimeBrowserCapture));
    const recovered = createRuntimeOperationBrowserAdapter(recoveryOptions(recoveryCapture, {
      primitives: { artifacts: artifactPrimitive }
    }));
    expect(recovered.artifacts).toBeUndefined();
  });
});
