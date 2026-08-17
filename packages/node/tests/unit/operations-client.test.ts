import { describe, expect, it, vi } from "vitest";
import {
  OperationClient,
  OperationClientError,
  type OperationControlAdapterFactoryContext,
  type OperationFileFingerprinter,
  type OperationServicePort
} from "../../src/operations/client.js";
import { OperationFileIdentityError, type OperationFileIdentity } from "../../src/operations/file-identity.js";
import type { OperationBrowserAdapter } from "../../src/operations/service.js";
import {
  OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_REQUEST_SCHEMA_VERSION,
  type OperationControlRequestV1,
  type OperationHandleV1,
  type OperationTargetBindingV1,
  type OperationSubmitRequestV1
} from "../../src/operations/types.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_DIGEST = `hmac-sha256:${"1".repeat(64)}`;
const SECOND_REQUEST_DIGEST = `hmac-sha256:${"5".repeat(64)}`;
const THIRD_REQUEST_DIGEST = `hmac-sha256:${"7".repeat(64)}`;
const TARGET_DIGEST = `hmac-sha256:${"2".repeat(64)}`;
const CONTENT_A = "a".repeat(64);
const CONTENT_B = "b".repeat(64);
const SIGNAL = new AbortController().signal;

describe("OperationClient", () => {
  it("fingerprints files in exact request order and keeps raw paths in the adapter closure", async () => {
    const request = submitRequest({
      files: [
        { path: "/private/first.txt", displayName: "first.txt" },
        { path: "/private/second.txt", displayName: "second.txt" }
      ],
      capture: { responseContent: "metadata", artifacts: "transfer", outputDirectory: "/private/out" }
    });
    const before = structuredClone(request);
    const fingerprintCalls: string[] = [];
    const closurePaths: string[] = [];
    const revalidated: string[] = [];
    const fingerprint = fakeFingerprinter((sourcePath, displayName) => {
      fingerprintCalls.push(sourcePath);
      return identity(sourcePath, displayName ?? "fallback.txt", sourcePath.includes("first") ? CONTENT_A : CONTENT_B);
    });
    const adapter = makeAdapter();
    const factory = vi.fn(({ request: closureRequest, files }) => {
      closurePaths.push(...files.map((file: OperationFileIdentity) => file.sourcePath));
      expect(closureRequest.files?.map((file: { path: string }) => file.path)).toEqual([
        "/private/first.txt",
        "/private/second.txt"
      ]);
      return adapter;
    });
    const service = fakeService();
    const client = new OperationClient(service, adapter, {
      fingerprint,
      revalidate: async file => {
        revalidated.push(file.sourcePath);
      },
      adapterFactory: factory
    });

    const result = await client.submit(request, { signal: SIGNAL, deadlineAt: 1234 });

    expect(result).not.toBe(service.submitResult);
    expect(fingerprintCalls).toEqual(["/private/first.txt", "/private/second.txt"]);
    expect(revalidated).toEqual([]);
    expect(closurePaths).toEqual(["/private/first.txt", "/private/second.txt"]);
    expect(service.submitFiles).toEqual([
      { displayName: "first.txt", bytes: 5, contentSha256: CONTENT_A },
      { displayName: "second.txt", bytes: 6, contentSha256: CONTENT_B }
    ]);
    expect(service.submitFiles).not.toBe(request.files);
    expect(service.submitFiles.every(file => Object.isFrozen(file))).toBe(true);
    expect(service.submitRequest.files?.map(file => file.path)).toEqual([
      "operation-input-1",
      "operation-input-2"
    ]);
    expect(service.submitRequest.capture?.outputDirectory).toBe("operation-output");
    expect(request).toEqual(before);
    expect(request.files?.[0]).not.toBe(service.submitRequest.files?.[0]);
    expect(service.submitOptions).toMatchObject({ signal: SIGNAL, deadlineAt: 1234 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("fails before adapter or service use when a file cannot be fingerprinted", async () => {
    const privatePath = "/private/secret/missing.txt";
    const adapter = makeAdapter();
    const service = fakeService();
    const fingerprint: OperationFileFingerprinter = async () => {
      throw new OperationFileIdentityError(
        "operation_file_unavailable",
        `could not read ${privatePath}`
      );
    };
    const factory = vi.fn(() => adapter);
    const client = new OperationClient(service, adapter, { fingerprint, adapterFactory: factory });

    await expect(client.submit(submitRequest({ files: [{ path: privatePath }] }))).rejects.toMatchObject({
      code: "operation_file_unavailable"
    });
    expect(service.submit).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(String(await captureError(client.submit(submitRequest({ files: [{ path: privatePath }] }))))).not.toContain(privatePath);
  });

  it("does not execute hostile signal or file-identity accessors", async () => {
    let abortedReads = 0;
    const hostileSignal = Object.defineProperty({}, "aborted", {
      enumerable: true,
      get() {
        abortedReads += 1;
        throw new Error("private signal state");
      }
    }) as AbortSignal;
    const service = fakeService();
    const client = new OperationClient(service, makeAdapter());
    await expect(client.submit(submitRequest(), { signal: hostileSignal })).rejects.toMatchObject({ code: "invalid_signal" });
    expect(abortedReads).toBe(0);
    expect(service.submit).not.toHaveBeenCalled();

    let manifestReads = 0;
    const fingerprint = vi.fn(async () => Object.defineProperty({
      sourcePath: "/private/input.txt",
      proof: {}
    }, "manifest", {
      enumerable: true,
      get() {
        manifestReads += 1;
        throw new Error("private file identity");
      }
    }) as unknown as OperationFileIdentity);
    const identityService = fakeService();
    const identityClient = new OperationClient(identityService, makeAdapter(), { fingerprint });
    await expect(identityClient.submit(submitRequest({ files: [{ path: "/private/input.txt" }] })))
      .rejects.toMatchObject({ code: "invalid_file_identity" });
    expect(manifestReads).toBe(0);
    expect(identityService.submit).not.toHaveBeenCalled();
  });

  it("rejects symbol-bearing request graphs instead of silently dropping fields", async () => {
    const request = submitRequest() as OperationSubmitRequestV1 & Record<symbol, unknown>;
    request[Symbol("hidden")] = "private";
    const service = fakeService();
    const client = new OperationClient(service, makeAdapter());
    await expect(client.submit(request)).rejects.toMatchObject({ code: "invalid_operation_request" });
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("revalidates a changed identity immediately before the handoff callback", async () => {
    const adapter = makeAdapter();
    const baseService = fakeService();
    const changed = vi.fn(async () => {
      throw new OperationFileIdentityError("operation_file_changed", "private path changed");
    });
    const factory = vi.fn(() => adapter);
    const submit = vi.fn(async (...args: Parameters<OperationServicePort["submit"]>) => {
      const [, , operationAdapter] = args;
      await operationAdapter.submission.executeFileHandoffOnce({} as never);
      return baseService.submitResult as never;
    });
    const service = Object.assign(baseService, { submit }) as unknown as OperationServicePort;
    const client = new OperationClient(service, adapter, {
      fingerprint: fakeFingerprinter((sourcePath, displayName) => identity(sourcePath, displayName ?? "input.txt", CONTENT_A)),
      revalidate: changed,
      adapterFactory: factory
    });

    await expect(client.submit(submitRequest({ files: [{ path: "/private/input.txt" }] }))).rejects.toMatchObject({
      code: "operation_file_changed"
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(service.submit).toHaveBeenCalledTimes(1);
    expect(adapter.submission.executeFileHandoffOnce).not.toHaveBeenCalled();
  });

  it("captures every Send phase as an immutable bound method and never revalidates files there", async () => {
    const source = makeAdapter();
    const factoryAdapter = makeAdapter();
    const prepare = vi.fn(async () => ({
      status: "blocked" as const,
      result: { status: "blocked" as const, blockerCode: "target_evidence_unavailable" as const }
    }));
    const execute = vi.fn(async () => ({
      status: "blocked" as const,
      result: { status: "blocked" as const, blockerCode: "target_evidence_unavailable" as const }
    }));
    const verify = vi.fn(async () => ({
      status: "blocked" as const,
      blockerCode: "target_evidence_unavailable" as const
    }));
    const recover = vi.fn(async () => ({
      status: "blocked" as const,
      blockerCode: "target_evidence_unavailable" as const
    }));
    const mutableSubmission = factoryAdapter.submission as unknown as Record<string, unknown>;
    mutableSubmission.prepareSend = prepare;
    mutableSubmission.executePreparedSend = execute;
    mutableSubmission.verifyPreparedSend = verify;
    mutableSubmission.recoverSend = recover;

    const baseService = fakeService();
    const submit = vi.fn(async (...args: Parameters<OperationServicePort["submit"]>) => {
      const operationAdapter = args[2];
      // The factory result is mutable, but the client must retain the
      // descriptor-validated functions captured before this replacement.
      mutableSubmission.prepareSend = vi.fn(async () => {
        throw new Error("replaced prepare");
      });
      mutableSubmission.executePreparedSend = vi.fn(async () => {
        throw new Error("replaced execute");
      });
      mutableSubmission.verifyPreparedSend = vi.fn(async () => {
        throw new Error("replaced verify");
      });
      mutableSubmission.recoverSend = vi.fn(async () => {
        throw new Error("replaced recover");
      });

      await operationAdapter.submission.prepareSend({} as never);
      await operationAdapter.submission.executePreparedSend({} as never);
      await operationAdapter.submission.verifyPreparedSend({} as never);
      await operationAdapter.submission.recoverSend({} as never);
      return baseService.submitResult as never;
    });
    const service = Object.assign(baseService, { submit }) as unknown as OperationServicePort;
    const revalidate = vi.fn(async () => undefined);
    const client = new OperationClient(service, source, {
      fingerprint: fakeFingerprinter((sourcePath, displayName) => identity(sourcePath, displayName ?? "input.txt", CONTENT_A)),
      revalidate,
      adapterFactory: () => factoryAdapter
    });

    await client.submit(submitRequest({ files: [{ path: "/private/input.txt" }] }));

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    // Only the actual file-handoff boundary performs file revalidation.
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("forwards collect, inspect, control, and run without mutating caller inputs", async () => {
    const adapter = makeAdapter();
    const service = fakeService();
    const client = new OperationClient(service, adapter, {
      fingerprint: fakeFingerprinter((sourcePath, displayName) => identity(sourcePath, displayName ?? "input.txt", CONTENT_A)),
      revalidate: async () => undefined
    });
    const handle = operationHandle({ phase: "generating" });
    const control = controlRequest(handle);
    const controlBefore = structuredClone(control);
    const collectOptions = {
      signal: SIGNAL,
      wait: false,
      timeoutMs: 22,
      maxAttempts: 3,
      pollIntervalMs: 4,
      responseContent: "metadata" as const,
      responseFormat: "text" as const,
      now: () => 100
    };
    const controlOptions = { signal: SIGNAL, deadlineAt: 4567, now: () => 200 };
    const runRequest = submitRequest();

    const collected = await client.collect(handle, collectOptions);
    const inspected = await client.inspect(handle);
    const controlled = await client.control(control, controlOptions);
    const run = await client.run(runRequest, {
      signal: SIGNAL,
      deadlineAt: 9876,
      wait: false,
      timeoutMs: 33,
      maxAttempts: 5,
      pollIntervalMs: 6,
      responseContent: "include",
      responseFormat: "markdown" as const,
      now: () => 300
    });

    expect(collected).not.toBe(service.collectResult);
    expect(inspected).not.toBe(service.inspectResult);
    expect(controlled).not.toBe(service.controlResult);
    expect(run).not.toBe(service.runResult);
    expect(service.collectHandle).not.toBe(handle);
    expect(service.collectOptions).toMatchObject({
      signal: SIGNAL,
      wait: false,
      timeoutMs: 22,
      maxAttempts: 3,
      pollIntervalMs: 4,
      responseContent: "metadata",
      responseFormat: "text"
    });
    expect(service.inspectHandle).not.toBe(handle);
    expect(service.controlRequest).not.toBe(control);
    expect(service.controlOptions).toMatchObject({ signal: SIGNAL, deadlineAt: 4567 });
    expect(service.runOptions).toMatchObject({
      signal: SIGNAL,
      deadlineAt: 9876,
      wait: false,
      timeoutMs: 33,
      maxAttempts: 5,
      pollIntervalMs: 6,
      responseContent: "include",
      responseFormat: "markdown"
    });
    expect(control).toEqual(controlBefore);
    expect(runRequest).toEqual(submitRequest());
  });

  it("bounds request adapters with an LRU and recreates evicted handles", async () => {
    const adapter = makeAdapter();
    const baseService = fakeService();
    const firstHandle = operationHandle({ operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST });
    const secondHandle = operationHandle({ operationId: SECOND_OPERATION_ID, requestDigest: SECOND_REQUEST_DIGEST });
    const submitResults = [
      submitResultForHandle(firstHandle),
      submitResultForHandle(secondHandle)
    ];
    const submit = vi.fn(async () => submitResults.shift());
    const service = Object.assign(baseService, { submit }) as unknown as OperationServicePort & typeof baseService;
    const handleAdapterFactory = vi.fn(async (handle: OperationHandleV1) => {
      expect(Object.isFrozen(handle)).toBe(true);
      return makeAdapter();
    });
    const client = new OperationClient(service, adapter, {
      adapterFactory: vi.fn(() => adapter),
      handleAdapterFactory,
      maxCachedAdapters: 1
    });

    await client.submit(submitRequest({ operationId: OPERATION_ID }));
    await client.submit(submitRequest({ operationId: SECOND_OPERATION_ID }));
    await client.collect(firstHandle);
    await client.collect(secondHandle);

    expect(handleAdapterFactory).toHaveBeenCalledTimes(2);
    expect(handleAdapterFactory.mock.calls[0]?.[0]).toMatchObject({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST
    });
    expect(handleAdapterFactory.mock.calls[1]?.[0]).toMatchObject({
      operationId: SECOND_OPERATION_ID,
      requestDigest: SECOND_REQUEST_DIGEST
    });
    expect(() => new OperationClient(fakeService(), adapter, { maxCachedAdapters: 0 })).toThrowError(
      expect.objectContaining({ code: "invalid_adapter_cache_size" })
    );
    expect(() => new OperationClient(fakeService(), adapter, { maxCachedAdapters: 257 })).toThrowError(
      expect.objectContaining({ code: "invalid_adapter_cache_size" })
    );
  });

  it("promotes a handle on access before evicting the least recently used adapter", async () => {
    const baseService = fakeService();
    const handles = [
      operationHandle({ operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST }),
      operationHandle({ operationId: SECOND_OPERATION_ID, requestDigest: SECOND_REQUEST_DIGEST }),
      operationHandle({ operationId: THIRD_OPERATION_ID, requestDigest: THIRD_REQUEST_DIGEST })
    ];
    const submitResults = handles.map(handle => submitResultForHandle(handle));
    const submit = vi.fn(async () => submitResults.shift());
    const service = Object.assign(baseService, { submit }) as unknown as OperationServicePort & typeof baseService;
    const handleAdapterFactory = vi.fn(async () => makeAdapter());
    const client = new OperationClient(service, makeAdapter(), {
      adapterFactory: vi.fn(() => makeAdapter()),
      handleAdapterFactory,
      maxCachedAdapters: 2
    });

    await client.submit(submitRequest({ operationId: OPERATION_ID }));
    await client.submit(submitRequest({ operationId: SECOND_OPERATION_ID }));
    await client.collect(handles[0]!); // Promote operation 1 over operation 2.
    await client.submit(submitRequest({ operationId: THIRD_OPERATION_ID })); // Evicts operation 2.
    await client.collect(handles[0]!);
    expect(handleAdapterFactory).toHaveBeenCalledTimes(0);
    await client.collect(handles[1]!);
    expect(handleAdapterFactory).toHaveBeenCalledTimes(1);
  });

  it("drops cached adapters after terminal submit and run results", async () => {
    const terminalHandle = operationHandle({ phase: "completed" });
    const terminalSubmit = terminalSubmitResult(terminalHandle);
    const submitService = fakeService();
    const submit = vi.fn(async () => terminalSubmit);
    const submitWithFactory = vi.fn(async () => makeAdapter());
    const submitHandleFactory = vi.fn(async () => makeAdapter());
    const submitClient = new OperationClient(
      Object.assign(submitService, { submit }) as unknown as OperationServicePort,
      makeAdapter(),
      { adapterFactory: submitWithFactory, handleAdapterFactory: submitHandleFactory }
    );

    await submitClient.submit(submitRequest());
    await submitClient.collect(terminalHandle);
    expect(submitHandleFactory).toHaveBeenCalledTimes(0);

    const runService = fakeService();
    const run = vi.fn(async () => ({ submit: terminalSubmit }));
    const runWithFactory = vi.fn(async () => makeAdapter());
    const runHandleFactory = vi.fn(async () => makeAdapter());
    const runClient = new OperationClient(
      Object.assign(runService, { run }) as unknown as OperationServicePort,
      makeAdapter(),
      { adapterFactory: runWithFactory, handleAdapterFactory: runHandleFactory }
    );

    await runClient.run(submitRequest());
    await runClient.collect(terminalHandle);
    expect(runHandleFactory).toHaveBeenCalledTimes(0);
  });

  it("drops cached adapters after a terminal collect result", async () => {
    const handle = operationHandle({ phase: "submitted" });
    const service = fakeService();
    const collectResults = [completedCollectResult(handle), service.collectResult];
    const collect = vi.fn(async () => collectResults.shift());
    const handleAdapterFactory = vi.fn(async () => makeAdapter());
    const client = new OperationClient(
      Object.assign(service, { collect }) as unknown as OperationServicePort,
      makeAdapter(),
      { adapterFactory: vi.fn(() => makeAdapter()), handleAdapterFactory }
    );

    await client.submit(submitRequest());
    await client.collect(handle);
    await client.collect(handle);

    expect(handleAdapterFactory).toHaveBeenCalledTimes(1);
  });

  it("uses the frozen handle factory for collect-only recovery while inspect stays browser-free", async () => {
    const adapter = makeAdapter();
    const recreated = makeAdapter();
    const service = fakeService();
    const handle = operationHandle();
    const handleAdapterFactory = vi.fn(async (factoryHandle: OperationHandleV1) => {
      expect(Object.isFrozen(factoryHandle)).toBe(true);
      expect(factoryHandle).toEqual(handle);
      const context = factoryHandle as OperationHandleV1 & {
        handle: OperationHandleV1;
        state: { target: OperationTargetBindingV1 };
        target: OperationTargetBindingV1;
      };
      expect(context.handle).toEqual(handle);
      expect(Object.isFrozen(context.handle)).toBe(true);
      expect(Object.isFrozen(context.state)).toBe(true);
      expect(Object.isFrozen(context.state.target)).toBe(true);
      expect(context.target).toEqual(context.state.target);
      expect(JSON.stringify(factoryHandle)).not.toContain("private");
      return recreated;
    });
    const client = new OperationClient(service, adapter, { handleAdapterFactory });

    await client.inspect(handle);
    expect(handleAdapterFactory).not.toHaveBeenCalled();
    await client.collect(handle);

    expect(handleAdapterFactory).toHaveBeenCalledTimes(1);
    expect(service.collectAdapter).not.toBe(adapter);
  });

  it("reconstructs a fixed target from a fresh durable context after restart", async () => {
    const source = makeAdapter();
    const recreated = makeAdapter();
    const handle = operationHandle({ phase: "generating", revision: 4 });
    const target = durableTarget({ providerId: "provider-fixed", browserId: "browser-fixed", tabId: "tab-fixed" });
    const service = fakeService();
    const inspect = vi.fn(async () => ({ handle, state: durableState(handle, target) }));
    const handleAdapterFactory = vi.fn(async (context: {
      handle: OperationHandleV1;
      state: Record<string, unknown>;
      target: OperationTargetBindingV1;
    }) => {
      expect(context.handle).toEqual(handle);
      expect(context.target).toEqual(target);
      expect((context.state.target as OperationTargetBindingV1).tabId).toBe("tab-fixed");
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.target)).toBe(true);
      return recreated;
    });
    const client = new OperationClient(
      Object.assign(service, { inspect }) as unknown as OperationServicePort,
      source,
      { handleAdapterFactory }
    );

    await client.collect(handle);

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(handleAdapterFactory).toHaveBeenCalledTimes(1);
    expect(service.collectAdapter).not.toBe(source);
  });

  it("reconstructs a new-established target with provider conversation identity", async () => {
    const source = makeAdapter();
    const recreated = makeAdapter();
    const handle = operationHandle({ phase: "submitted", revision: 7 });
    const digest = `hmac-sha256:${"8".repeat(64)}`;
    const target = durableTarget({
      providerId: "provider-new",
      browserId: "browser-new",
      tabId: "tab-new",
      conversationId: "conversation-new",
      canonicalThreadUrl: "https://chatgpt.com/c/conversation-new",
      targetLifecycle: "new_established",
      newTargetAnchorDigest: digest,
      blankTaskEvidenceDigest: digest,
      targetEstablishment: {
        targetBindingDigest: TARGET_DIGEST,
        anchorDigest: digest,
        causalSendActionId: "55555555-5555-4555-8555-555555555555",
        conversationId: "conversation-new",
        canonicalThreadUrl: "https://chatgpt.com/c/conversation-new",
        userTurnId: "user-new",
        userTurnEvidenceDigest: digest,
        evidenceDigest: digest,
        observedAt: "2026-08-16T12:00:00.000Z"
      }
    });
    const service = fakeService();
    const inspect = vi.fn(async () => ({ handle, state: durableState(handle, target) }));
    const handleAdapterFactory = vi.fn(async (context: {
      handle: OperationHandleV1;
      target: OperationTargetBindingV1;
    }) => {
      expect(context.handle.targetBindingDigest).toBe(TARGET_DIGEST);
      expect(context.target.targetLifecycle).toBe("new_established");
      expect(context.target.conversationId).toBe("conversation-new");
      expect(context.target.canonicalThreadUrl).toBe("https://chatgpt.com/c/conversation-new");
      return recreated;
    });
    const client = new OperationClient(
      Object.assign(service, { inspect }) as unknown as OperationServicePort,
      source,
      { handleAdapterFactory }
    );

    await client.collect(handle);

    expect(handleAdapterFactory).toHaveBeenCalledTimes(1);
    expect(service.collectAdapter).not.toBe(source);
  });

  it("rejects pending new targets before factory or browser use", async () => {
    const source = makeAdapter();
    const handle = operationHandle({ phase: "send_pending", revision: 3 });
    const digest = `hmac-sha256:${"9".repeat(64)}`;
    const target = durableTarget({
      targetLifecycle: "new_pending",
      canonicalThreadUrl: undefined,
      conversationId: undefined,
      newTargetAnchorDigest: digest,
      blankTaskEvidenceDigest: digest,
      evidenceProfile: {
        providerIdentity: "required",
        stableTabId: "required",
        stableConversationId: "unavailable",
        stableUserTurnId: "unavailable",
        authoritativeTabClaim: "unavailable",
        replacementTabRecovery: false
      }
    } as unknown as Partial<OperationTargetBindingV1>);
    const service = fakeService();
    const inspect = vi.fn(async () => ({ handle, state: durableState(handle, target) }));
    const handleAdapterFactory = vi.fn(async () => makeAdapter());
    const client = new OperationClient(
      Object.assign(service, { inspect }) as unknown as OperationServicePort,
      source,
      { handleAdapterFactory }
    );

    await expect(client.collect(handle)).rejects.toMatchObject({ code: "new_target_not_established" });
    expect(handleAdapterFactory).not.toHaveBeenCalled();
    expect(service.collect).not.toHaveBeenCalled();
  });

  it("rejects a durable target-binding change across a newer handle revision", async () => {
    const requested = operationHandle({ revision: 2, targetBindingDigest: TARGET_DIGEST });
    const changed = operationHandle({
      revision: 3,
      targetBindingDigest: `hmac-sha256:${"9".repeat(64)}`
    });
    const service = fakeService();
    const inspect = vi.fn(async () => ({ handle: changed, state: durableState(changed) }));
    const factory = vi.fn(async () => makeAdapter());
    const client = new OperationClient(
      Object.assign(service, { inspect }) as unknown as OperationServicePort,
      makeAdapter(),
      { handleAdapterFactory: factory }
    );

    await expect(client.collect(requested)).rejects.toMatchObject({ code: "invalid_operation_handle" });
    expect(factory).not.toHaveBeenCalled();
    expect(service.collect).not.toHaveBeenCalled();
  });

  it("rejects an ahead locator before it reaches the reconstruction factory", async () => {
    const source = makeAdapter();
    const current = operationHandle({ revision: 2 });
    const ahead = operationHandle({ revision: 99 });
    const service = fakeService();
    const inspect = vi.fn(async () => ({ handle: current, state: durableState(current) }));
    const handleAdapterFactory = vi.fn(async () => makeAdapter());
    const client = new OperationClient(
      Object.assign(service, { inspect }) as unknown as OperationServicePort,
      source,
      { handleAdapterFactory }
    );

    await expect(client.collect(ahead)).rejects.toMatchObject({ code: "invalid_operation_handle" });
    const tampered = operationHandle({ revision: current.revision, phase: "completed" });
    await expect(client.collect(tampered)).rejects.toMatchObject({ code: "invalid_operation_handle" });
    expect(handleAdapterFactory).not.toHaveBeenCalled();
    expect(service.collect).not.toHaveBeenCalled();
  });

  it("does not execute hostile inspect getters and returns a bounded static error", async () => {
    const source = makeAdapter();
    const handle = operationHandle();
    let stateGetterRead = false;
    const hostile = {
      handle,
      get state(): never {
        stateGetterRead = true;
        throw new Error("private response and prompt");
      }
    };
    const service = fakeService();
    const inspect = vi.fn(async () => hostile);
    const handleAdapterFactory = vi.fn(async () => makeAdapter());
    const client = new OperationClient(
      Object.assign(service, { inspect }) as unknown as OperationServicePort,
      source,
      { handleAdapterFactory }
    );

    const error = await captureError(client.collect(handle));
    expect(error).toMatchObject({ code: "invalid_operation_state" });
    expect(error.message).not.toContain("private response");
    expect(stateGetterRead).toBe(false);
    expect(handleAdapterFactory).not.toHaveBeenCalled();
  });

  it("rejects hostile factory adapters without executing adapter getters", async () => {
    const source = makeAdapter();
    const handle = operationHandle();
    const service = fakeService();
    let submissionGetterRead = false;
    const hostile = makeAdapter() as OperationBrowserAdapter & Record<string, unknown>;
    Object.defineProperty(hostile, "submission", {
      enumerable: true,
      get() {
        submissionGetterRead = true;
        throw new Error("private provider state");
      }
    });
    const handleAdapterFactory = vi.fn(async () => hostile);
    const client = new OperationClient(service, source, { handleAdapterFactory });

    const error = await captureError(client.collect(handle));
    expect(error).toMatchObject({ code: "adapter_unavailable" });
    expect(error.message).not.toContain("private provider");
    expect(submissionGetterRead).toBe(false);
    expect(service.collect).not.toHaveBeenCalled();
  });

  it("normalizes handle-factory failures to a static facade error", async () => {
    const source = makeAdapter();
    const handle = operationHandle();
    const service = fakeService();
    const handleAdapterFactory = vi.fn(async () => {
      throw new Error("private prompt /private/input.txt");
    });
    const client = new OperationClient(service, source, { handleAdapterFactory });

    const error = await captureError(client.collect(handle));
    expect(error).toMatchObject({ code: "adapter_unavailable" });
    expect(error.message).not.toContain("private prompt");
    expect(error.message).not.toContain("/private/input.txt");
  });

  it("uses a fresh authenticated control factory even when a submit adapter is cached", async () => {
    const submitAdapter = makeAdapter();
    const firstControlAdapter = makeAdapter();
    const secondControlAdapter = makeAdapter();
    const service = fakeService();
    const controlContexts: OperationControlAdapterFactoryContext[] = [];
    const controlAdapters = [firstControlAdapter, secondControlAdapter];
    const controlFactory = vi.fn(async (context: OperationControlAdapterFactoryContext) => {
      controlContexts.push(context);
      return controlAdapters.shift()!;
    });
    const client = new OperationClient(service, submitAdapter, {
      adapterFactory: vi.fn(() => submitAdapter),
      controlAdapterFactory: controlFactory
    });
    const request = steerControlRequest(operationHandle({ phase: "generating" }));

    // This creates the bounded submit adapter cache entry. Control must not
    // reuse it because only the control factory can hold steerPrompt.
    await client.submit(submitRequest());
    await client.control(request);
    await client.control(request);

    expect(controlFactory).toHaveBeenCalledTimes(2);
    expect(service.controlAdapter).toBeDefined();
    expect(service.controlAdapter).not.toBe(submitAdapter);
    expect(service.controlAdapter).not.toBe(firstControlAdapter);
    const firstContext = controlContexts[0] as any;
    const secondContext = controlContexts[1] as any;
    expect(firstContext?.request).toEqual(request);
    expect(firstContext?.request).not.toBe(request);
    expect(Object.isFrozen(firstContext?.request)).toBe(true);
    expect(Object.isFrozen(firstContext)).toBe(true);
    expect(Object.keys(firstContext ?? {})).toEqual(["request"]);
    expect(Object.getOwnPropertyDescriptor(firstContext, "handle")?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(firstContext, "state")?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(firstContext, "target")?.enumerable).toBe(false);
    expect(firstContext?.handle).toEqual(request.parent);
    expect(firstContext?.state.target).toEqual(firstContext?.target);
    expect(firstContext?.durable).toEqual(expect.objectContaining({ operationId: request.parent.operationId }));
    expect(JSON.stringify(firstContext?.durable)).not.toContain(request.steerPrompt);
    expect(secondContext).not.toBe(firstContext);
    expect(service.control).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a control-factory error without invoking the service or echoing prompt data", async () => {
    const fallback = makeAdapter();
    const service = fakeService();
    const prompt = "private steer prompt that must never be echoed";
    const client = new OperationClient(service, fallback, {
      controlAdapterFactory: async () => {
        throw new Error(`${prompt} /private/secret`);
      }
    });

    const error = await captureError(client.control(steerControlRequest(operationHandle({ phase: "generating" }), prompt)));
    expect(error).toMatchObject({ code: "adapter_unavailable" });
    expect(error.message).not.toContain(prompt);
    expect(error.message).not.toContain("/private/secret");
    expect(service.control).not.toHaveBeenCalled();
    expect(service.controlAdapter).toBeUndefined();
  });

  it("rejects hostile control-factory adapter accessors before browser mutation", async () => {
    const fallback = makeAdapter();
    const hostile = makeAdapter() as OperationBrowserAdapter & Record<string, unknown>;
    let controlGetterRead = false;
    Object.defineProperty(hostile, "control", {
      enumerable: true,
      get() {
        controlGetterRead = true;
        throw new Error("private provider state");
      }
    });
    const service = fakeService();
    const client = new OperationClient(service, fallback, {
      controlAdapterFactory: async () => hostile
    });

    const error = await captureError(client.control(steerControlRequest(operationHandle({ phase: "generating" }))));
    expect(error).toMatchObject({ code: "adapter_unavailable" });
    expect(error.message).not.toContain("private provider");
    expect(controlGetterRead).toBe(false);
    expect(service.control).not.toHaveBeenCalled();
  });

  it("captures Work phases and artifact transfer by own data descriptor", async () => {
    const source = makeAdapter() as OperationBrowserAdapter & Record<string, unknown>;
    const control = {
      observeTurn: vi.fn(),
      executeOnce: vi.fn(),
      observePostcondition: vi.fn()
    } as Record<string, unknown>;
    const transfer = vi.fn(async () => ({ status: "transferred" } as never));
    const artifacts = { transfer };
    const phaseMethods = {
      prepareSteer: vi.fn(async () => ({ status: "prepared" } as never)),
      executeSteerPrepared: vi.fn(async () => ({ status: "executed" } as never)),
      verifySteer: vi.fn(async () => ({ status: "satisfied" } as never)),
      recoverSteer: vi.fn(async () => ({ status: "satisfied" } as never))
    };
    Object.assign(control, phaseMethods);
    (source as unknown as Record<string, unknown>).control = control;
    (source as unknown as Record<string, unknown>).artifacts = artifacts;
    const baseService = fakeService();
    const submit = vi.fn(async (...args: Parameters<OperationServicePort["submit"]>) => {
      const guarded = args[2] as unknown as {
        control: {
          prepareSteer(request: unknown): Promise<unknown>;
          executeSteerPrepared(request: unknown): Promise<unknown>;
          verifySteer(request: unknown): Promise<unknown>;
          recoverSteer(request: unknown): Promise<unknown>;
        };
        artifacts: { transfer: (request: unknown) => Promise<unknown> };
      };
      // Replace the provider surface after validation. Every guarded call
      // must still target the captured original function.
      control.prepareSteer = vi.fn(async () => { throw new Error("replaced prepare"); });
      control.executeSteerPrepared = vi.fn(async () => { throw new Error("replaced execute"); });
      control.verifySteer = vi.fn(async () => { throw new Error("replaced verify"); });
      control.recoverSteer = vi.fn(async () => { throw new Error("replaced recover"); });
      artifacts.transfer = vi.fn(async () => { throw new Error("replaced transfer"); });
      await guarded.control.prepareSteer({});
      await guarded.control.executeSteerPrepared({});
      await guarded.control.verifySteer({});
      await guarded.control.recoverSteer({});
      await guarded.artifacts.transfer({});
      return baseService.submitResult as never;
    });
    const service = Object.assign(baseService, { submit }) as unknown as OperationServicePort;
    const client = new OperationClient(service, makeAdapter(), {
      adapterFactory: async () => source
    });

    await client.submit(submitRequest());

    expect(phaseMethods.prepareSteer).toHaveBeenCalledTimes(1);
    expect(phaseMethods.executeSteerPrepared).toHaveBeenCalledTimes(1);
    expect(phaseMethods.verifySteer).toHaveBeenCalledTimes(1);
    expect(phaseMethods.recoverSteer).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("rejects partially supplied optional Work or artifact capabilities", async () => {
    const partialWork = makeAdapter() as OperationBrowserAdapter & Record<string, unknown>;
    (partialWork as unknown as Record<string, unknown>).control = {
      observeTurn: vi.fn(),
      executeOnce: vi.fn(),
      observePostcondition: vi.fn(),
      prepareSteer: vi.fn()
    } as unknown as OperationBrowserAdapter["control"];
    const partialWorkClient = new OperationClient(fakeService(), makeAdapter(), {
      adapterFactory: async () => partialWork
    });
    await expect(partialWorkClient.submit(submitRequest())).rejects.toMatchObject({ code: "adapter_unavailable" });

    const partialArtifacts = makeAdapter() as OperationBrowserAdapter & Record<string, unknown>;
    (partialArtifacts as unknown as Record<string, unknown>).artifacts = {};
    const partialArtifactsClient = new OperationClient(fakeService(), makeAdapter(), {
      adapterFactory: async () => partialArtifacts
    });
    await expect(partialArtifactsClient.submit(submitRequest())).rejects.toMatchObject({ code: "adapter_unavailable" });
  });

  it("does not pass a rejected or tampered handle to the handle adapter factory", async () => {
    const adapter = makeAdapter();
    const baseService = fakeService();
    const inspect = vi.fn(async () => {
      throw new Error("operation handle rejected");
    });
    const handleAdapterFactory = vi.fn(async () => makeAdapter());
    const service = Object.assign(baseService, { inspect }) as unknown as OperationServicePort;
    const client = new OperationClient(service, adapter, { handleAdapterFactory });

    await expect(client.collect(operationHandle({ revision: 999 }))).rejects.toThrow("operation handle rejected");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(handleAdapterFactory).not.toHaveBeenCalled();
  });

  it("does not add prompt or path values to facade errors", async () => {
    const prompt = "private prompt that must not be echoed";
    const privatePath = "/private/secret/input.txt";
    const adapter = makeAdapter();
    const service = fakeService();
    const client = new OperationClient(service, adapter, {
      fingerprint: async () => {
        throw new Error(`failed for ${privatePath} while handling ${prompt}`);
      }
    });

    const error = await captureError(client.submit(submitRequest({ prompt, files: [{ path: privatePath }] })));
    expect(error).toBeInstanceOf(OperationClientError);
    expect(error.message).not.toContain(prompt);
    expect(error.message).not.toContain(privatePath);
  });

  it("validates optional staging ports without enumerating unrelated adapter properties", async () => {
    const adapter = makeAdapter() as OperationBrowserAdapter & Record<string, unknown>;
    let unrelatedGetterRead = false;
    Object.defineProperty(adapter, "privateProviderState", {
      enumerable: true,
      get() {
        unrelatedGetterRead = true;
        throw new Error("private provider diagnostic");
      }
    });
    const client = new OperationClient(fakeService(), makeAdapter(), {
      adapterFactory: async () => adapter
    });

    await expect(client.submit(submitRequest())).resolves.toMatchObject({
      submission: { kind: "submitted" }
    });
    expect(unrelatedGetterRead).toBe(false);

    const malformed = {
      ...makeAdapter(),
      staging: { readCurrent: async () => ({}) }
    } as unknown as OperationBrowserAdapter;
    const malformedClient = new OperationClient(fakeService(), makeAdapter(), {
      adapterFactory: async () => malformed
    });
    await expect(malformedClient.submit(submitRequest())).rejects.toMatchObject({
      code: "adapter_unavailable"
    });

    const missingPhase = makeAdapter() as OperationBrowserAdapter & {
      submission: OperationBrowserAdapter["submission"] & Record<string, unknown>;
    };
    delete (missingPhase.submission as unknown as Record<string, unknown>).prepareSend;
    const missingPhaseClient = new OperationClient(fakeService(), makeAdapter(), {
      adapterFactory: async () => missingPhase
    });
    await expect(missingPhaseClient.submit(submitRequest())).rejects.toMatchObject({
      code: "adapter_unavailable"
    });
  });
});

function submitRequest(overrides: Partial<OperationSubmitRequestV1> = {}): OperationSubmitRequestV1 {
  return {
    schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    surface: "chat",
    prompt: "reply with one word",
    target: { type: "selected_tab" },
    ...overrides
  };
}

function operationHandle(overrides: Partial<OperationHandleV1> = {}): OperationHandleV1 {
  return {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    revision: 1,
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: TARGET_DIGEST,
    ...overrides
  };
}

function durableTarget(overrides: Partial<OperationTargetBindingV1> = {}): OperationTargetBindingV1 {
  return {
    providerId: "chatgpt",
    browserId: "browser-1",
    tabId: "tab-1",
    coordinationScope: "process",
    canonicalThreadUrl: "https://chatgpt.com/c/conversation-1",
    conversationId: "conversation-1",
    evidenceProfile: {
      providerIdentity: "required",
      stableTabId: "required",
      stableConversationId: "required",
      stableUserTurnId: "required",
      authoritativeTabClaim: "unavailable",
      replacementTabRecovery: false
    },
    ...overrides
  };
}

function durableState(
  handle: OperationHandleV1,
  target: OperationTargetBindingV1 = durableTarget()
): Record<string, unknown> {
  return {
    schemaVersion: "chatgpt.browser_control.operation.v1",
    operationId: handle.operationId,
    requestDigest: handle.requestDigest,
    surface: handle.surface,
    phase: handle.phase,
    mutationBoundary: handle.mutationBoundary,
    revision: handle.revision,
    target
  };
}

function controlRequest(parent: OperationHandleV1): OperationControlRequestV1 {
  return {
    schemaVersion: OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
    controlActionId: "33333333-3333-4333-8333-333333333333",
    parent,
    action: "stop",
    expectedAssistantTurnId: "assistant-1"
  };
}

function steerControlRequest(
  parent: OperationHandleV1,
  steerPrompt = "private steer prompt"
): OperationControlRequestV1 {
  return {
    ...controlRequest(parent),
    action: "steer",
    steerPrompt
  };
}

function submitResultForHandle(handle: OperationHandleV1, kind: "submitted" | "completed_receipt" = "submitted"): unknown {
  return {
    handle,
    submission: {
      kind,
      operationId: handle.operationId,
      requestDigest: handle.requestDigest,
      surface: handle.surface,
      targetBindingDigest: handle.targetBindingDigest ?? TARGET_DIGEST,
      actionId: "44444444-4444-4444-8444-444444444444",
      evidenceDigest: `hmac-sha256:${"3".repeat(64)}`,
      userTurnId: "user-1",
      userTurnEvidenceDigest: `hmac-sha256:${"4".repeat(64)}`,
      ...(kind === "completed_receipt" ? { assistantTurnId: "assistant-1" } : {})
    }
  };
}

function terminalSubmitResult(handle: OperationHandleV1): unknown {
  return submitResultForHandle(handle, "completed_receipt");
}

function completedCollectResult(handle: OperationHandleV1): unknown {
  return {
    kind: "completed",
    operationId: handle.operationId,
    requestDigest: handle.requestDigest,
    targetBindingDigest: handle.targetBindingDigest ?? TARGET_DIGEST,
    attempts: 1,
    turn: {
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
      userTurnEvidenceDigest: `hmac-sha256:${"4".repeat(64)}`,
      ownershipEvidenceDigest: `hmac-sha256:${"6".repeat(64)}`
    },
    response: {
      contentAvailable: false,
      rawContentAvailable: false,
      artifacts: [],
      finishReason: "stop"
    }
  };
}

function identity(sourcePath: string, displayName: string, contentSha256: string): OperationFileIdentity {
  return {
    sourcePath,
    manifest: { displayName, bytes: displayName === "first.txt" ? 5 : displayName === "second.txt" ? 6 : 4, contentSha256 },
    proof: { device: "1", inode: sourcePath, size: "4", modifiedNs: "5", changedNs: "6" }
  };
}

function fakeFingerprinter(
  create: (sourcePath: string, displayName?: string) => OperationFileIdentity
): OperationFileFingerprinter {
  return async (sourcePath, displayName) => create(sourcePath, displayName);
}

function makeAdapter(): OperationBrowserAdapter {
  return {
    resolveTarget: vi.fn(),
    submission: {
      observeStaging: vi.fn(),
      executeFileHandoffOnce: vi.fn(),
      observeAttachments: vi.fn(),
      prepareSend: vi.fn(),
      executePreparedSend: vi.fn(),
      verifyPreparedSend: vi.fn(),
      recoverSend: vi.fn(),
      executeFinalTabTransaction: vi.fn()
    },
    collector: {
      readContext: vi.fn(),
      observe: vi.fn(),
      sleep: vi.fn()
    }
  } as unknown as OperationBrowserAdapter;
}

function fakeService(): OperationServicePort & {
  submitResult: unknown;
  submitRequest: OperationSubmitRequestV1;
  submitFiles: readonly unknown[];
  submitOptions: unknown;
  collectResult: unknown;
  collectHandle: OperationHandleV1;
  collectAdapter: OperationBrowserAdapter;
  collectOptions: unknown;
  inspectResult: unknown;
  inspectHandle: OperationHandleV1;
  controlResult: unknown;
  controlRequest: OperationControlRequestV1;
  controlAdapter: OperationBrowserAdapter;
  controlOptions: unknown;
  runResult: unknown;
  runOptions: unknown;
} {
  const submitResult = {
    handle: operationHandle({ phase: "submitted" }),
    submission: {
      kind: "submitted",
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      targetBindingDigest: TARGET_DIGEST,
      actionId: "44444444-4444-4444-8444-444444444444",
      evidenceDigest: `hmac-sha256:${"3".repeat(64)}`,
      userTurnId: "user-1",
      userTurnEvidenceDigest: `hmac-sha256:${"4".repeat(64)}`
    }
  };
  const collectResult = {
    kind: "pending",
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    attempts: 1
  };
  const inspectResult = {
    handle: operationHandle({ phase: "submitted" }),
    state: durableState(operationHandle({ phase: "submitted" }))
  };
  const controlResult = {
    kind: "blocked",
    controlActionId: "33333333-3333-4333-8333-333333333333",
    parentOperationId: OPERATION_ID,
    parentRequestDigest: REQUEST_DIGEST,
    parentTargetBindingDigest: TARGET_DIGEST,
    requestDigest: REQUEST_DIGEST,
    action: "stop",
    expectedAssistantTurnId: "assistant-1",
    blocker: { code: "operation_timeout", observationRequired: false, mutationBoundary: "none" }
  };
  const runResult = { submit: submitResult, collect: collectResult };
  const service = {
    submitResult,
    submitRequest: undefined as unknown as OperationSubmitRequestV1,
    submitFiles: [] as readonly unknown[],
    submitOptions: undefined as unknown,
    collectResult,
    collectHandle: undefined as unknown as OperationHandleV1,
    collectAdapter: undefined as unknown as OperationBrowserAdapter,
    collectOptions: undefined as unknown,
    inspectResult,
    inspectHandle: undefined as unknown as OperationHandleV1,
    controlResult,
    controlRequest: undefined as unknown as OperationControlRequestV1,
    controlAdapter: undefined as unknown as OperationBrowserAdapter,
    controlOptions: undefined as unknown,
    runResult,
    runOptions: undefined as unknown,
    submit: vi.fn(async (request: OperationSubmitRequestV1, files: readonly unknown[], _adapter: OperationBrowserAdapter, options: unknown) => {
      service.submitRequest = request;
      service.submitFiles = files;
      service.submitOptions = options;
      return submitResult;
    }),
    collect: vi.fn(async (handle: OperationHandleV1, adapter: OperationBrowserAdapter, options: unknown) => {
      service.collectHandle = handle;
      service.collectAdapter = adapter;
      service.collectOptions = options;
      return collectResult;
    }),
    inspect: vi.fn(async (handle: OperationHandleV1) => {
      service.inspectHandle = handle;
      return { ...inspectResult, handle, state: durableState(handle) };
    }),
    control: vi.fn(async (request: OperationControlRequestV1, adapter: OperationBrowserAdapter, options: unknown) => {
      service.controlRequest = request;
      service.controlAdapter = adapter;
      service.controlOptions = options;
      return controlResult;
    }),
    run: vi.fn(async (_request: OperationSubmitRequestV1, _files: readonly unknown[], _adapter: OperationBrowserAdapter, options: unknown) => {
      service.runOptions = options;
      return runResult;
    })
  };
  return service as unknown as OperationServicePort & typeof service;
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the promise to reject.");
}
