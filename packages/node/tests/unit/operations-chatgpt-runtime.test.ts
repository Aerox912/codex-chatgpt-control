import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserLike, PageLike, RuntimeEnv } from "../../src/types.js";
import {
  createChatGPTOperationAdapterFactory,
  createChatGPTOperationHandleAdapterFactory,
  createChatGPTOperationSubmitRecoveryAdapterFactory,
  createChatGPTOperationControlAdapterFactory
} from "../../src/operations/chatgpt-runtime.js";
import type { OperationAdapterFactoryContext } from "../../src/operations/client.js";
import { fingerprintOperationFile } from "../../src/operations/file-identity.js";
import { coordinatedBrowserResource, createCoordinatedBrowser } from "../../src/runtime/coordinated-browser.js";
import { ProcessTabCoordinator } from "../../src/runtime/tab-coordinator.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_DIGEST = `hmac-sha256:${"1".repeat(64)}`;
const EVIDENCE_DIGEST = `hmac-sha256:${"2".repeat(64)}`;

const waitForTurn = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
};

type FakePage = PageLike & {
  id: string;
  currentUrl: string;
  surface: "chat" | "work";
  evaluateCount: number;
};

function page(
  id: string,
  currentUrl: string,
  surface: FakePage["surface"] = "chat"
): FakePage {
  const result: FakePage = {
    id,
    currentUrl,
    surface,
    evaluateCount: 0,
    url: () => result.currentUrl,
    title: async () => "ChatGPT",
    waitForTimeout: async () => undefined,
    waitForEvent: async () => undefined,
    evaluate: async <T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> => {
      result.evaluateCount += 1;
      const source = fn.toString();
      if (source.includes("allowBlankTask") && (arg as unknown as { allowBlankTask?: boolean } | undefined)?.allowBlankTask !== true) {
        const conversationId = parseConversationId(result.currentUrl) ?? "conversation-1";
        return {
          canonicalUrl: result.currentUrl,
          conversationId,
          threadId: `thread-${conversationId}`,
          turns: [
            {
              role: "user",
              stableId: "user-1",
              ordinal: 0,
              text: "existing user turn",
              structure: { tag: "div", childCount: 1, artifactCount: 0 },
              artifacts: []
            },
            {
              role: "assistant",
              stableId: "assistant-1",
              parentStableId: "user-1",
              branchStableId: "branch-1",
              ordinal: 0,
              text: "generating assistant turn",
              state: "generating",
              structure: { tag: "div", childCount: 1, artifactCount: 0 },
              artifacts: []
            }
          ],
          completeness: "complete",
          terminalState: "generating"
        } as T;
      }
      if (source.includes("allowBlankTask") && (arg as unknown as { allowBlankTask?: boolean } | undefined)?.allowBlankTask === true) {
        const conversationId = parseConversationId(result.currentUrl);
        return {
          canonicalUrl: result.currentUrl,
          ...(conversationId === undefined ? {} : { conversationId, threadId: `thread-${conversationId}` }),
          turns: [],
          completeness: "complete",
          terminalState: "idle"
        } as T;
      }
      if (source.includes("surfaceOptionLabels")) {
        return {
          composerLabels: [result.surface === "work" ? "Work on anything" : "Chat with ChatGPT"],
          mainControls: [],
          mainText: "",
          selectedSurfaceLabels: [result.surface === "work" ? "Work" : "Chat"]
        } as T;
      }
      if (source.includes("wantedLabels")) {
        result.surface = "work";
        return true as T;
      }
      return {
        visibleText: "Chat with ChatGPT New chat",
        blockerText: "",
        hasConversationMessages: false
      } as T;
    }
  };
  return result;
}

function parseConversationId(value: string): string | undefined {
  const match = /^https:\/\/chatgpt\.com\/c\/([^/?#]+)/u.exec(value);
  return match?.[1];
}

type FakeBrowser = BrowserLike & {
  name: string;
  selectedPage?: FakePage;
  pages: Map<string, FakePage>;
  listCalls: number;
  selectedCalls: number;
  createCalls: string[];
};

function browser(initial: FakePage, selected = initial): FakeBrowser {
  const result: FakeBrowser = {
    name: "chrome",
    selectedPage: selected,
    pages: new Map([[initial.id, initial], [selected.id, selected]]),
    listCalls: 0,
    selectedCalls: 0,
    createCalls: [],
    tabs: {
      list: () => {
        result.listCalls += 1;
        return [...result.pages.values()];
      },
      selected: () => {
        result.selectedCalls += 1;
        return result.selectedPage;
      },
      get: (id: string) => {
        const found = result.pages.get(id);
        if (found === undefined) throw new Error("tab not found");
        return found;
      },
      create: (url: string) => {
        result.createCalls.push(url);
        const created = page(`created-${result.createCalls.length}`, url);
        result.pages.set(created.id, created);
        result.selectedPage = created;
        return created;
      }
    }
  };
  return result;
}

function digest(): string {
  return EVIDENCE_DIGEST;
}

function env(browserValue: BrowserLike): RuntimeEnv {
  return { browser: browserValue };
}

function request(target: OperationAdapterFactoryContext["request"]["target"], surface: "chat" | "work" = "chat") {
  return Object.freeze({
    schemaVersion: "chatgpt.browser_control.operation_request.v1" as const,
    operationId: OPERATION_ID,
    surface,
    prompt: "private prompt",
    target
  });
}

function context(
  requestValue: OperationAdapterFactoryContext["request"],
  files: OperationAdapterFactoryContext["files"] = []
): OperationAdapterFactoryContext {
  return Object.freeze({ request: requestValue, files, signal: new AbortController().signal });
}

function factory(browserValue: BrowserLike) {
  return createChatGPTOperationAdapterFactory({
    env: env(browserValue),
    owner: { backendSessionId: "backend-session-1" },
    evidenceDigest: digest,
    coordinator: new ProcessTabCoordinator()
  });
}

describe("default ChatGPT operation runtime", () => {
  it("does not attach until the operation adapter resolves its target", async () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
    const browserValue = browser(current);
    const adapterFactory = factory(browserValue);
    const adapterPromise = adapterFactory(context(request({ type: "conversation_id", conversationId: "conversation-1" })));

    expect(browserValue.listCalls).toBe(0);
    const adapter = await adapterPromise;
    expect(browserValue.listCalls).toBe(0);
    await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "conversation_id", conversationId: "conversation-1" },
      signal: new AbortController().signal
    });
    expect(browserValue.listCalls).toBeGreaterThan(0);
  });

  it("snapshots request data before the adapter closure can observe caller mutation", async () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
    const browserValue = browser(current);
    const mutableRequest = {
      schemaVersion: "chatgpt.browser_control.operation_request.v1" as const,
      operationId: OPERATION_ID,
      surface: "chat" as const,
      prompt: "prompt before mutation",
      target: { type: "conversation_id" as const, conversationId: "conversation-1" }
    };
    const adapterPromise = factory(browserValue)({
      request: mutableRequest,
      files: [],
      signal: new AbortController().signal
    });
    mutableRequest.prompt = "prompt after mutation";
    mutableRequest.target = { type: "conversation_id", conversationId: "conversation-2" };

    const adapter = await adapterPromise;
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "conversation_id", conversationId: "conversation-1" },
      signal: new AbortController().signal
    });
    expect(result.target.conversationId).toBe("conversation-1");
    expect(browserValue.createCalls).toEqual([]);
  });

  it("binds the default file handoff to the service's keyed manifest identity", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "chatgpt-operation-runtime-"));
    try {
      const sourcePath = join(temporary, "private-input.txt");
      await writeFile(sourcePath, "request-owned attachment\n", { mode: 0o600 });
      const identity = await fingerprintOperationFile(sourcePath);
      const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
      const browserValue = browser(current);
      let handoffCalls = 0;
      let capturedSignal: AbortSignal | undefined;
      const requestedSignal = new AbortController().signal;
      const adapterFactory = createChatGPTOperationAdapterFactory({
        env: env(browserValue),
        owner: { backendSessionId: "backend-session-files" },
        evidenceDigest: digest,
        coordinator: new ProcessTabCoordinator(),
        primitives: primitiveContext => {
          capturedSignal = primitiveContext.signal;
          return {
            submission: {
              handoffFiles: async (handoff, files) => {
                handoffCalls += 1;
                expect(handoff.manifest.identities).toEqual([
                  { ordinal: 0, identityDigest: EVIDENCE_DIGEST }
                ]);
                expect(files).toHaveLength(1);
                expect(files[0]?.sourcePath).toBe(sourcePath);
                return { status: "satisfied", evidenceDigest: EVIDENCE_DIGEST };
              },
              observeAttachments: async () => ({
                status: "exact",
                evidenceDigest: EVIDENCE_DIGEST,
                count: 1,
                orderPolicy: "exact",
                identityDigests: [EVIDENCE_DIGEST]
              })
            }
          };
        }
      });
      const adapter = await adapterFactory({
        request: {
          ...request({ type: "conversation_id", conversationId: "conversation-1" }),
          files: [{ path: sourcePath }]
        },
        files: [identity],
        signal: requestedSignal
      });
      await adapter.resolveTarget({
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        target: { type: "conversation_id", conversationId: "conversation-1" },
        signal: requestedSignal
      });
      const result = await adapter.submission.executeFileHandoffOnce({
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        surface: "chat",
        actionId: "22222222-2222-4222-8222-222222222222",
        targetBindingDigest: EVIDENCE_DIGEST,
        manifest: {
          count: 1,
          orderPolicy: "exact",
          identities: [{ ordinal: 0, identityDigest: EVIDENCE_DIGEST }]
        }
      });

      expect(result).toEqual({ status: "satisfied", evidenceDigest: EVIDENCE_DIGEST });
      expect(handoffCalls).toBe(1);
      expect(capturedSignal).toBe(requestedSignal);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("binds exact conversation targets with stable browser/tab identities and process concurrency", async () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
    const browserValue = browser(current);
    const adapter = await factory(browserValue)(context(request({ type: "conversation_id", conversationId: "conversation-1" })));
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "conversation_id", conversationId: "conversation-1" },
      signal: new AbortController().signal
    });

    expect(result.target).toMatchObject({
      providerId: "chatgpt",
      browserId: coordinatedBrowserResource(browserValue).key,
      tabId: "tab-1",
      coordinationScope: "process",
      conversationId: "conversation-1"
    });
    expect(result.target.tabClaimEvidenceDigest).toBeUndefined();
  });

  it("proves an exact selected tab instead of accepting an arbitrary user-open ChatGPT tab", async () => {
    const selected = page("selected-tab", "https://chatgpt.com/c/selected-conversation");
    const other = page("other-tab", "https://chatgpt.com/c/other-conversation");
    const browserValue = browser(other, selected);
    browserValue.pages.set(other.id, other);
    const adapter = await factory(browserValue)(context(request({ type: "selected_tab" })));
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "selected_tab" },
      signal: new AbortController().signal
    });

    expect(browserValue.selectedCalls).toBeGreaterThan(0);
    expect(result.target.tabId).toBe("selected-tab");
    expect(result.target.conversationId).toBe("selected-conversation");
  });

  it("keeps selected-tab URL validation inside the browser gate before mutations can overlap", async () => {
    const selected = page("selected-gated", "https://chatgpt.com/c/selected-gated");
    const urlGate = deferred<void>();
    let urlStarted!: () => void;
    const urlStartedPromise = new Promise<void>(resolve => { urlStarted = resolve; });
    selected.url = async () => {
      urlStarted();
      await urlGate.promise;
      return selected.currentUrl;
    };
    const browserValue = browser(selected);
    const coordinator = new ProcessTabCoordinator();
    const adapterFactory = createChatGPTOperationAdapterFactory({
      env: env(browserValue),
      owner: { backendSessionId: "backend-session-1" },
      evidenceDigest: digest,
      coordinator
    });
    const adapter = await adapterFactory(context(request({ type: "selected_tab" })));
    const targetResolution = adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "selected_tab" },
      signal: new AbortController().signal
    });
    await urlStartedPromise;

    const coordinated = createCoordinatedBrowser(browserValue, {
      coordinator,
      owner: { backendSessionId: "backend-session-1", operationId: OPERATION_ID }
    });
    const competingMutation = coordinated.tabs!.create!("https://chatgpt.com/");
    await waitForTurn();
    expect(browserValue.createCalls).toEqual([]);

    urlGate.resolve();
    await Promise.all([targetResolution, competingMutation]);
    expect(browserValue.createCalls).toEqual(["https://chatgpt.com/"]);
  });

  it("resolves the provider browser lazily before proving an exact selected tab", async () => {
    const selected = page("selected-tab", "https://chatgpt.com/c/selected-conversation");
    const browserValue = browser(selected);
    const coordinator = new ProcessTabCoordinator();
    const adapterFactory = createChatGPTOperationAdapterFactory({
      env: {
        agent: {
          browsers: {
            list: async () => [{ id: "extension", type: "extension" }],
            get: async () => browserValue
          }
        }
      },
      owner: { backendSessionId: "backend-session-provider" },
      evidenceDigest: digest,
      coordinator
    });
    const adapter = await adapterFactory(context(request({ type: "selected_tab" })));
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "selected_tab" },
      signal: new AbortController().signal
    });

    expect(result.target.tabId).toBe("selected-tab");
    expect(browserValue.selectedCalls).toBeGreaterThan(0);
    expect(coordinator.getBrowserDiagnostics(coordinatedBrowserResource(browserValue).key).completedCount)
      .toBeGreaterThan(0);
  });

  it("rejects unknown factory and capability fields before browser access", () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
    const browserValue = browser(current);
    expect(() => createChatGPTOperationAdapterFactory({
      env: env(browserValue),
      owner: { backendSessionId: "backend-session-1" },
      evidenceDigest: digest,
      unexpected: true
    } as never)).toThrow();
    expect(() => createChatGPTOperationAdapterFactory({
      env: env(browserValue),
      owner: { backendSessionId: "backend-session-1" },
      evidenceDigest: digest,
      capabilities: { concurrentTabs: true, unexpected: true }
    } as never)).toThrow();
    expect(browserValue.selectedCalls).toBe(0);
    expect(browserValue.createCalls).toEqual([]);
  });

  it("rejects a tab whose live URL no longer matches a requested URL", async () => {
    const wrong = page("tab-1", "https://chatgpt.com/c/wrong-conversation");
    const browserValue = browser(wrong);
    browserValue.tabs = {
      list: () => [{ id: "tab-1", url: "https://chatgpt.com/c/requested-conversation" } as unknown as PageLike],
      get: () => wrong
    };
    const adapter = await factory(browserValue)(context(request({
      type: "url",
      url: "https://chatgpt.com/c/requested-conversation"
    })));

    await expect(adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "url", url: "https://chatgpt.com/c/requested-conversation" },
      signal: new AbortController().signal
    })).rejects.toThrow();
    expect(browserValue.createCalls).toEqual([]);
  });

  it("rejects an existing tab whose conversation does not match the exact conversation target", async () => {
    const wrong = page("tab-1", "https://chatgpt.com/c/wrong-conversation");
    const browserValue = browser(wrong);
    browserValue.tabs = {
      list: () => [{ id: "tab-1", url: "https://chatgpt.com/c/requested-conversation" } as unknown as PageLike],
      get: () => wrong
    };
    const adapter = await factory(browserValue)(context(request({
      type: "conversation_id",
      conversationId: "requested-conversation"
    })));

    await expect(adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "conversation_id", conversationId: "requested-conversation" },
      signal: new AbortController().signal
    })).rejects.toThrow();
    expect(browserValue.createCalls).toEqual([]);
  });

  it("proves a blank new target and retains no conversation identity before Send", async () => {
    const home = page("new-tab", "https://chatgpt.com/");
    const browserValue = browser(home);
    browserValue.pages.clear();
    const adapter = await factory(browserValue)(context(request({ type: "new" })));
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "new" },
      signal: new AbortController().signal
    });

    expect(browserValue.createCalls).toEqual(["https://chatgpt.com/"]);
    expect(result.target).toMatchObject({
      providerId: "chatgpt",
      tabId: "created-1",
      targetLifecycle: "new_pending"
    });
    expect(result.target.conversationId).toBeUndefined();
    expect(result.target.newTargetAnchorDigest).toMatch(/^hmac-sha256:/u);
    expect(result.target.blankTaskEvidenceDigest).toMatch(/^hmac-sha256:/u);
  });

  it("uses the bounded surface helper for a fresh Work target and rechecks the surface", async () => {
    const home = page("new-tab", "https://chatgpt.com/");
    const browserValue = browser(home);
    browserValue.pages.clear();
    const adapter = await factory(browserValue)(context(request({ type: "new" }, "work")));
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "work",
      target: { type: "new" },
      signal: new AbortController().signal
    });

    expect(result.target.targetLifecycle).toBe("new_pending");
    expect(browserValue.pages.get("created-1")?.surface).toBe("work");
  });

  it("recovers a pending new submit through its exact durable tab without opening another", async () => {
    const pending = page("pending-tab", "https://chatgpt.com/");
    const browserValue = browser(pending);
    const anchorDigest = `hmac-sha256:${"8".repeat(64)}`;
    const target = {
      providerId: "chatgpt",
      browserId: coordinatedBrowserResource(browserValue).key,
      tabId: "pending-tab",
      coordinationScope: "process" as const,
      targetLifecycle: "new_pending" as const,
      newTargetAnchorDigest: anchorDigest,
      blankTaskEvidenceDigest: anchorDigest,
      evidenceProfile: {
        providerIdentity: "required" as const,
        stableTabId: "required" as const,
        stableConversationId: "unavailable" as const,
        stableUserTurnId: "unavailable" as const,
        authoritativeTabClaim: "unavailable" as const,
        replacementTabRecovery: false
      }
    };
    const recoveryFactory = createChatGPTOperationSubmitRecoveryAdapterFactory({
      env: env(browserValue),
      owner: { backendSessionId: "backend-session-pending" },
      evidenceDigest: digest,
      coordinator: new ProcessTabCoordinator()
    });
    const adapter = await recoveryFactory({
      request: request({ type: "new" }),
      files: [],
      signal: new AbortController().signal,
      handle: {} as never,
      state: {} as never,
      target,
      durable: {} as never
    });
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "new" },
      signal: new AbortController().signal
    });

    expect(result.target).toMatchObject({
      providerId: "chatgpt",
      tabId: "pending-tab",
      targetLifecycle: "new_pending"
    });
    expect(browserValue.selectedCalls).toBe(0);
    expect(browserValue.createCalls).toEqual([]);
  });

  it("recovers only the durable tab binding", async () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
    const browserValue = browser(current);
    const target = {
      providerId: "chatgpt",
      browserId: coordinatedBrowserResource(browserValue).key,
      tabId: "tab-1",
      coordinationScope: "process" as const,
      canonicalThreadUrl: `https://opaque.invalid/thread/${"2".repeat(64)}`,
      conversationId: "conversation-1",
      evidenceProfile: {
        providerIdentity: "required" as const,
        stableTabId: "required" as const,
        stableConversationId: "required" as const,
        stableUserTurnId: "unavailable" as const,
        authoritativeTabClaim: "unavailable" as const,
        replacementTabRecovery: false
      }
    };
    const handleFactory = createChatGPTOperationHandleAdapterFactory({
      env: env(browserValue),
      owner: { backendSessionId: "backend-session-1" },
      evidenceDigest: digest,
      coordinator: new ProcessTabCoordinator()
    });
    const adapter = await handleFactory(Object.freeze({
      schemaVersion: "chatgpt.browser_control.operation_handle.v1" as const,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat" as const,
      revision: 1,
      phase: "generating" as const,
      mutationBoundary: "send_may_have_occurred" as const,
      targetBindingDigest: EVIDENCE_DIGEST,
      handle: {} as never,
      state: {} as never,
      target
    }));
    const result = await adapter.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "tab_id", tabId: "tab-1" },
      signal: new AbortController().signal
    });
    expect(result.target.tabId).toBe("tab-1");
    expect(browserValue.selectedCalls).toBe(0);
    expect(adapter.artifacts).toBeUndefined();
  });

  it("fails closed for symbol-keyed or prototype-only target snapshot data", async () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
    const browserValue = browser(current);
    const handleFactory = createChatGPTOperationHandleAdapterFactory({
      env: env(browserValue),
      owner: { backendSessionId: "backend-session-snapshot" },
      evidenceDigest: digest,
      coordinator: new ProcessTabCoordinator()
    });
    const baseContext = {
      schemaVersion: "chatgpt.browser_control.operation_handle.v1" as const,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat" as const,
      revision: 1,
      phase: "generating" as const,
      mutationBoundary: "send_may_have_occurred" as const,
      targetBindingDigest: EVIDENCE_DIGEST,
      handle: {} as never,
      state: {} as never
    };
    const prototypeOnlyTarget: Record<string, unknown> = {};
    Object.defineProperty(prototypeOnlyTarget, "__proto__", {
      configurable: true,
      enumerable: true,
      value: {
        providerId: "chatgpt",
        browserId: coordinatedBrowserResource(browserValue).key,
        tabId: "tab-1",
        coordinationScope: "process"
      },
      writable: true
    });
    await expect(handleFactory({ ...baseContext, target: prototypeOnlyTarget } as never)).rejects.toThrow();

    const symbolTarget = {
      providerId: "chatgpt",
      browserId: coordinatedBrowserResource(browserValue).key,
      tabId: "tab-1",
      coordinationScope: "process"
    } as Record<string, unknown>;
    Object.defineProperty(symbolTarget, Symbol("unreviewed"), {
      enumerable: true,
      value: "must-not-be-dropped"
    });
    await expect(handleFactory({ ...baseContext, target: symbolTarget } as never)).rejects.toThrow();
  });

  it("creates a fresh exact-tab control closure without exposing the steer prompt", async () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1", "work");
    const browserValue = browser(current);
    const target = {
      providerId: "chatgpt",
      browserId: coordinatedBrowserResource(browserValue).key,
      tabId: "tab-1",
      coordinationScope: "process" as const,
      canonicalThreadUrl: `https://opaque.invalid/thread/${"3".repeat(64)}`,
      conversationId: "conversation-1",
      evidenceProfile: {
        providerIdentity: "required" as const,
        stableTabId: "required" as const,
        stableConversationId: "required" as const,
        stableUserTurnId: "required" as const,
        authoritativeTabClaim: "unavailable" as const,
        replacementTabRecovery: false
      }
    };
    const handle = {
      schemaVersion: "chatgpt.browser_control.operation_handle.v1" as const,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "work" as const,
      revision: 3,
      phase: "generating" as const,
      mutationBoundary: "send_may_have_occurred" as const,
      targetBindingDigest: EVIDENCE_DIGEST
    };
    const controlRequest = {
      schemaVersion: "chatgpt.browser_control.operation_control_request.v1" as const,
      controlActionId: "22222222-2222-4222-8222-222222222222",
      parent: handle,
      action: "steer" as const,
      expectedAssistantTurnId: "assistant-1",
      steerPrompt: "private steer prompt"
    };
    const factory = createChatGPTOperationControlAdapterFactory({
      env: env(browserValue),
      owner: { backendSessionId: "backend-session-control" },
      evidenceDigest: digest,
      coordinator: new ProcessTabCoordinator()
    });
    const adapter = await factory({
      request: controlRequest,
      handle,
      state: {
        schemaVersion: "chatgpt.browser_control.operation_state.v1",
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        surface: "work",
        phase: "generating",
        mutationBoundary: "send_may_have_occurred",
        revision: 3,
        target
      } as never,
      target,
      durable: { ...handle, handle, state: {} as never, target } as never
    });

    expect(browserValue.listCalls).toBe(0);
    expect(Object.keys(adapter.control ?? {})).toEqual([
      "postconditionRetry",
      "observeTurn",
      "executeOnce",
      "observePostcondition",
      "prepareSteer",
      "executeSteerPrepared",
      "verifySteer",
      "recoverSteer"
    ]);
    expect(adapter.control?.postconditionRetry).toEqual({ maxAttempts: 32, intervalMs: 250 });
    const phase = await adapter.control!.prepareSteer!({
      schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1",
      parentOperationId: OPERATION_ID,
      parentRequestDigest: REQUEST_DIGEST,
      parentTargetBindingDigest: EVIDENCE_DIGEST,
      controlActionId: controlRequest.controlActionId,
      requestDigest: `hmac-sha256:${"4".repeat(64)}`,
      expectedAssistantTurnId: "assistant-1",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000
    });
    expect(JSON.stringify(phase)).not.toContain("private steer prompt");
    expect(current.evaluateCount).toBeGreaterThan(0);
  });

  it("exposes artifact transfer only for an absolute request-local transfer capture", async () => {
    const current = page("tab-1", "https://chatgpt.com/c/conversation-1");
    const browserValue = browser(current);
    const transferable = await factory(browserValue)(context({
      ...request({ type: "conversation_id", conversationId: "conversation-1" }),
      capture: {
        responseContent: "metadata",
        artifacts: "transfer",
        outputDirectory: "/tmp/chatgpt-operation-artifacts"
      }
    }));
    await transferable.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "conversation_id", conversationId: "conversation-1" },
      signal: new AbortController().signal
    });
    expect(transferable.artifacts).toBeDefined();
    expect(typeof transferable.artifacts?.transfer).toBe("function");

    const missingDestination = await factory(browserValue)(context({
      ...request({ type: "conversation_id", conversationId: "conversation-1" }),
      capture: { responseContent: "metadata", artifacts: "transfer" }
    }));
    await missingDestination.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "conversation_id", conversationId: "conversation-1" },
      signal: new AbortController().signal
    });
    expect(missingDestination.artifacts).toBeUndefined();

    const relativeDestination = await factory(browserValue)(context({
      ...request({ type: "conversation_id", conversationId: "conversation-1" }),
      capture: {
        responseContent: "metadata",
        artifacts: "transfer",
        outputDirectory: "relative-output"
      }
    }));
    await relativeDestination.resolveTarget({
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      target: { type: "conversation_id", conversationId: "conversation-1" },
      signal: new AbortController().signal
    });
    expect(relativeDestination.artifacts).toBeUndefined();
  });
});
