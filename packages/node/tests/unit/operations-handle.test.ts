import { describe, expect, it } from "vitest";
import {
  OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_REQUEST_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  type OperationControlRequestV1,
  type OperationJsonValue,
  type OperationStateV1,
  type OperationSubmitRequestV1
} from "../../src/operations/types.js";
import {
  operationControlRequestDigest,
  operationHandleFromState,
  operationSubmitRequestDigest,
  validateOperationHandle
} from "../../src/operations/handle.js";

const KEY = Buffer.alloc(32, 0x19);
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CONTROL_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const AT = "2026-08-16T12:00:00.000Z";

describe("operation handles and request identity", () => {
  it("excludes timeout from immutable submit identity but binds intent-bearing fields", () => {
    const request = submitRequest();
    const files = [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }];
    const first = operationSubmitRequestDigest(KEY, request, files);
    expect(operationSubmitRequestDigest(KEY, { ...request, timeoutMs: 1 }, files)).toBe(first);
    expect(operationSubmitRequestDigest(KEY, { ...request, prompt: "different" }, files)).not.toBe(first);
    expect(operationSubmitRequestDigest(KEY, { ...request, target: { type: "new" } }, files)).not.toBe(first);
  });

  it("binds the exact Project alias and creation authority into request identity", () => {
    const request = submitRequest();
    const files = [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }];
    const existingOnly = operationSubmitRequestDigest(KEY, {
      ...request,
      target: { type: "project", name: "Pokémon Burning Scales" }
    }, files);
    expect(operationSubmitRequestDigest(KEY, {
      ...request,
      target: { type: "project", name: "Pokémon Burning Scales", confirmCreation: true }
    }, files)).not.toBe(existingOnly);
    expect(operationSubmitRequestDigest(KEY, {
      ...request,
      target: { type: "project", name: "Pokemon Burning Scales" }
    }, files)).not.toBe(existingOnly);
  });

  it("does not retain a caller snapshot across separate digest invocations", () => {
    const request = submitRequest();
    const files = [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }];
    const first = operationSubmitRequestDigest(KEY, request, files);
    request.prompt = "mutated after the first digest";
    const second = operationSubmitRequestDigest(KEY, request, files);
    expect(second).not.toBe(first);

    request.capture = { responseContent: "include", artifacts: "transfer", outputDirectory: "/tmp/output" };
    const third = operationSubmitRequestDigest(KEY, request, files);
    expect(third).not.toBe(second);
  });

  it("accepts stale locator fields but rejects tampered durable bindings", () => {
    const state = boundState();
    const handle = operationHandleFromState(KEY, state);
    const advanced = { ...state, revision: 5, phase: "generating" as const };
    const checked = validateOperationHandle(KEY, handle, advanced);
    expect(checked.stale).toBe(true);
    expect(checked.current.phase).toBe("generating");

    expect(() => validateOperationHandle(KEY, { ...handle, requestDigest: DIGEST.replace(/a$/, "b") }, state))
      .toThrow(/durable operation binding/);
    expect(() => validateOperationHandle(KEY, { ...handle, targetBindingDigest: `hmac-sha256:${"f".repeat(64)}` }, state))
      .toThrow(/target binding/);
    expect(() => validateOperationHandle(KEY, { ...handle, phase: "completed" }, state))
      .toThrow(/state fields disagree/);
  });

  it("does not retain a handle snapshot across separate validation invocations", () => {
    const state = boundState();
    const handle = operationHandleFromState(KEY, state);
    expect(() => validateOperationHandle(KEY, handle, state)).not.toThrow();
    handle.requestDigest = DIGEST.replace(/a$/, "b");
    expect(() => validateOperationHandle(KEY, handle, state)).toThrow(/durable operation binding/);
  });

  it("allows a stale pre-binding locator to advance to the durable target", () => {
    const unbound = { ...boundState(), revision: 1, phase: "prepared" as const, mutationBoundary: "none" as const };
    delete unbound.target;
    const preBinding = operationHandleFromState(KEY, unbound);
    const checked = validateOperationHandle(KEY, preBinding, boundState());
    expect(checked.stale).toBe(true);
    expect(checked.current.targetBindingDigest).toMatch(/^hmac-sha256:/);
  });

  it("keeps the target/action digest bit-for-bit stable across new-target establishment", () => {
    const pendingTarget = {
      providerId: "codex-chrome",
      browserId: "extension",
      tabId: "tab-new",
      coordinationScope: "process" as const,
      evidenceProfile: {
        providerIdentity: "required" as const,
        stableTabId: "required" as const,
        stableConversationId: "unavailable" as const,
        stableUserTurnId: "unavailable" as const,
        authoritativeTabClaim: "unavailable" as const,
        replacementTabRecovery: false
      },
      targetLifecycle: "new_pending" as const,
      newTargetAnchorDigest: DIGEST,
      blankTaskEvidenceDigest: DIGEST
    };
    const pending = { ...boundState(), phase: "send_pending" as const, target: pendingTarget };
    const pendingHandle = operationHandleFromState(KEY, pending);
    const established = {
      ...pending,
      target: {
        ...pendingTarget,
        targetLifecycle: "new_established" as const,
        conversationId: "conversation-new",
        canonicalThreadUrl: "https://chatgpt.com/c/conversation-new",
        evidenceProfile: {
          ...pendingTarget.evidenceProfile,
          stableConversationId: "required" as const,
          stableUserTurnId: "required" as const
        },
        targetEstablishment: {
          targetBindingDigest: pendingHandle.targetBindingDigest!,
          anchorDigest: DIGEST,
          causalSendActionId: OPERATION_ID,
          conversationId: "conversation-new",
          canonicalThreadUrl: "https://chatgpt.com/c/conversation-new",
          userTurnId: "user-new",
          userTurnEvidenceDigest: DIGEST,
          evidenceDigest: DIGEST,
          observedAt: AT
        }
      }
    };
    const establishedHandle = operationHandleFromState(KEY, established);
    expect(pendingHandle.targetBindingDigest).toBe(establishedHandle.targetBindingDigest);
    expect(establishedHandle.targetBindingDigest).toBe(pendingHandle.targetBindingDigest);
  });

  it("rejects unknown request fields, non-finite configuration, and non-canonical file hashes", () => {
    const request = submitRequest();
    const files = [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }];
    expect(() => operationSubmitRequestDigest(KEY, { ...request, rawPromptCopy: "private" } as OperationSubmitRequestV1, files))
      .toThrow(/unsupported field/);
    expect(() => operationSubmitRequestDigest(KEY, {
      ...request,
      configuration: { ...request.configuration, additional: { temperature: Number.NaN } }
    }, files)).toThrow(/non-finite/);
    expect(() => operationSubmitRequestDigest(KEY, request, [{ ...files[0]!, contentSha256: "B".repeat(64) }]))
      .toThrow(/invalid size or SHA-256/);
  });

  it("rejects direct request accessors, symbols, and proxies without invoking getters", () => {
    const request = submitRequest();
    let reads = 0;
    Object.defineProperty(request, "prompt", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("hostile request getter");
      }
    });
    expect(() => operationSubmitRequestDigest(KEY, request, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/unsafe property/);
    expect(reads).toBe(0);

    const symbolRequest = submitRequest() as OperationSubmitRequestV1 & Record<symbol, unknown>;
    symbolRequest[Symbol("secret")] = "private";
    expect(() => operationSubmitRequestDigest(KEY, symbolRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/symbol/);

    const hostile = new Proxy(submitRequest(), {
      ownKeys: () => {
        throw new Error("attacker-only-request-secret");
      }
    });
    let proxyError: unknown;
    try {
      operationSubmitRequestDigest(KEY, hostile, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]);
    } catch (error) {
      proxyError = error;
    }
    expect(proxyError).toBeInstanceOf(Error);
    expect((proxyError as Error).message).not.toContain("attacker-only-request-secret");
  });

  it("uses one request snapshot for omitted optional fields", () => {
    const request = submitRequest();
    delete request.timeoutMs;
    let optionalReads = 0;
    const proxy = new Proxy(request, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "timeoutMs") {
          optionalReads += 1;
          throw new Error("optional field trap");
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });

    expect(() => operationSubmitRequestDigest(KEY, proxy, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .not.toThrow();
    expect(optionalReads).toBe(0);
  });

  it("restores the outer snapshot after a reentrant reflection failure", () => {
    const files = [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }];
    const request = submitRequest();
    let nested = false;
    const proxy = new Proxy(request, {
      ownKeys(target) {
        if (!nested) {
          nested = true;
          expect(operationSubmitRequestDigest(KEY, submitRequest(), files)).toMatch(/^hmac-sha256:/);
        }
        void target;
        throw new Error("reentrant reflection secret");
      }
    });

    expect(() => operationSubmitRequestDigest(KEY, proxy, files)).toThrow(/could not be inspected safely/);
    const fresh = submitRequest();
    fresh.prompt = "after reentrant failure";
    expect(operationSubmitRequestDigest(KEY, fresh, files)).toMatch(/^hmac-sha256:/);
  });

  it("rejects target accessors before operation-handle projection reads them", () => {
    const state = boundState();
    const target = state.target!;
    let reads = 0;
    Object.defineProperty(target, "targetLifecycle", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("target lifecycle getter");
      }
    });
    state.target = target;

    expect(() => operationHandleFromState(KEY, state)).toThrow(/unsafe property/);
    expect(reads).toBe(0);
  });

  it("validates additional JSON through descriptors without invoking object or array getters", () => {
    const objectAdditional: Record<string, unknown> = {};
    let objectReads = 0;
    Object.defineProperty(objectAdditional, "secret", {
      enumerable: true,
      get: () => {
        objectReads += 1;
        throw new Error("hostile additional getter");
      }
    });
    const objectRequest = submitRequest();
    objectRequest.configuration = { ...objectRequest.configuration, additional: objectAdditional as unknown as { [key: string]: OperationJsonValue } };
    expect(() => operationSubmitRequestDigest(KEY, objectRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/unsafe property/);
    expect(objectReads).toBe(0);

    const arrayAdditional: unknown[] = [];
    let arrayReads = 0;
    Object.defineProperty(arrayAdditional, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        arrayReads += 1;
        throw new Error("hostile additional array getter");
      }
    });
    arrayAdditional.length = 1;
    const arrayRequest = submitRequest();
    arrayRequest.configuration = { ...arrayRequest.configuration, additional: { entries: arrayAdditional as unknown as OperationJsonValue } };
    expect(() => operationSubmitRequestDigest(KEY, arrayRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/unsafe entry|unsafe property/);
    expect(arrayReads).toBe(0);

    const symbolAdditional = Object.create(null) as Record<string | symbol, unknown>;
    symbolAdditional[Symbol("secret")] = "private";
    const symbolRequest = submitRequest();
    symbolRequest.configuration = {
      ...symbolRequest.configuration,
      additional: symbolAdditional as unknown as { [key: string]: OperationJsonValue }
    };
    expect(() => operationSubmitRequestDigest(KEY, symbolRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/symbol/);
  });

  it("rejects sparse, custom, cyclic, reserved-marker, and oversized additional JSON", () => {
    const sparse: unknown[] = new Array(1);
    const sparseRequest = submitRequest();
    sparseRequest.configuration = { ...sparseRequest.configuration, additional: sparse as unknown as { [key: string]: OperationJsonValue } };
    expect(() => operationSubmitRequestDigest(KEY, sparseRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/sparse/);

    const custom: unknown[] = ["ok"];
    Object.defineProperty(custom, "extra", { value: "private", enumerable: true });
    const customRequest = submitRequest();
    customRequest.configuration = { ...customRequest.configuration, additional: custom as unknown as { [key: string]: OperationJsonValue } };
    expect(() => operationSubmitRequestDigest(KEY, customRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/custom/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicRequest = submitRequest();
    cyclicRequest.configuration = { ...cyclicRequest.configuration, additional: cyclic as unknown as { [key: string]: OperationJsonValue } };
    expect(() => operationSubmitRequestDigest(KEY, cyclicRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/cyclic/);

    const reservedRequest = submitRequest();
    reservedRequest.configuration = { ...reservedRequest.configuration, additional: { $undefined: true } };
    expect(() => operationSubmitRequestDigest(KEY, reservedRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/invalid object key/);

    let deep: unknown = "leaf";
    for (let index = 0; index < 18; index += 1) deep = { value: deep };
    const deepRequest = submitRequest();
    deepRequest.configuration = { ...deepRequest.configuration, additional: deep as unknown as { [key: string]: OperationJsonValue } };
    expect(() => operationSubmitRequestDigest(KEY, deepRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/nesting/);

    const bytesRequest = submitRequest();
    bytesRequest.configuration = { ...bytesRequest.configuration, additional: "x".repeat(9 * 1024 * 1024) as unknown as { [key: string]: OperationJsonValue } };
    expect(() => operationSubmitRequestDigest(KEY, bytesRequest, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]))
      .toThrow(/byte/);
  });

  it("does not echo an unsupported target discriminator", () => {
    const request = submitRequest();
    const hostileType = "attacker-target-secret";
    request.target = { type: hostileType } as never;
    let error: unknown;
    try {
      operationSubmitRequestDigest(KEY, request, [{ displayName: "input.txt", bytes: 4, contentSha256: "b".repeat(64) }]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(hostileType);
  });

  it("rejects malformed handle extras and uppercase durable digests", () => {
    const state = boundState();
    const handle = operationHandleFromState(KEY, state);
    expect(() => validateOperationHandle(KEY, { ...handle, hidden: true } as typeof handle, state)).toThrow(/unsupported field/);
    expect(() => validateOperationHandle(KEY, { ...handle, requestDigest: `hmac-sha256:${"A".repeat(64)}` }, state))
      .toThrow(/requestDigest is invalid/);
  });

  it("binds control identity to the exact parent turn and keyed steer prompt", () => {
    const parent = operationHandleFromState(KEY, { ...boundState(), phase: "generating" });
    const request: OperationControlRequestV1 = {
      schemaVersion: OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
      controlActionId: CONTROL_ID,
      parent,
      action: "steer",
      expectedAssistantTurnId: "assistant-1",
      steerPrompt: "private corrective direction",
      timeoutMs: 100
    };
    const digest = operationControlRequestDigest(KEY, request);
    expect(digest).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(digest).not.toContain("private");
    expect(operationControlRequestDigest(KEY, { ...request, timeoutMs: 900 })).toBe(digest);
    expect(operationControlRequestDigest(KEY, { ...request, expectedAssistantTurnId: "assistant-2" })).not.toBe(digest);
  });
});

function submitRequest(): OperationSubmitRequestV1 {
  return {
    schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    surface: "chat",
    prompt: "private user intent",
    target: { type: "conversation_id", conversationId: "conversation-1" },
    configuration: { model: "Sol", reasoning: "High", tools: ["search"] },
    files: [{ path: "/private/input.txt", displayName: "input.txt" }],
    capture: { responseContent: "metadata", artifacts: "receipt_only" },
    timeoutMs: 100
  };
}

function boundState(): OperationStateV1 {
  return {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: DIGEST,
    surface: "chat",
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    revision: 4,
    createdAt: AT,
    updatedAt: AT,
    target: {
      providerId: "codex-chrome",
      browserId: "extension",
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
    actions: {}
  };
}
