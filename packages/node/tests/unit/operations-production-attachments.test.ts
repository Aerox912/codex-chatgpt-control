import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { FileChooserLike, LocatorLike, PageLike } from "../../src/types.js";
import {
  createProductionAttachmentPrimitive,
  type ProductionAttachmentActivation,
  type ProductionAttachmentPreparationResult,
  type ProductionAttachmentSurfaceRead
} from "../../src/operations/production-attachments.js";
import type { OperationFileIdentity } from "../../src/operations/file-identity.js";
import type { SubmissionAttachmentRequest, SubmissionHandoffRequest } from "../../src/operations/submission.js";
import type { OperationTargetBindingV1 } from "../../src/operations/types.js";
import { createCoordinatedPage } from "../../src/runtime/coordinated-page.js";
import { ProcessTabCoordinator, createTabResourceKey } from "../../src/runtime/tab-coordinator.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_DIGEST = digest("request", "request-1");
const TARGET_DIGEST = digest("target", "target-1");
const CONTENT_A = "a".repeat(64);
const CONTENT_B = "b".repeat(64);
const IDENTITY_A = digest("identity", "a");
const IDENTITY_B = digest("identity", "b");
const SECRET_PATH = "/private/secret/never-returned.pdf";
const SECRET_NAME = "never-returned.pdf";

const target: OperationTargetBindingV1 = {
  providerId: "provider-1",
  browserId: "browser-1",
  tabId: "tab-1",
  coordinationScope: "process",
  conversationId: "conversation-1",
  canonicalThreadUrl: "https://opaque.invalid/thread/" + "1".repeat(64),
  evidenceProfile: {
    providerIdentity: "required",
    stableTabId: "required",
    stableConversationId: "required",
    stableUserTurnId: "unavailable",
    authoritativeTabClaim: "unavailable",
    replacementTabRecovery: false
  }
};

function digest(domain: string, material: unknown): string {
  const text = `${domain}:${JSON.stringify(material)}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return `hmac-sha256:${hash.toString(16).padStart(8, "0").repeat(8).slice(0, 64)}`;
}

function identity(sourcePath: string, displayName: string, contentSha256: string, bytes: number): OperationFileIdentity {
  return {
    sourcePath,
    manifest: { displayName, contentSha256, bytes },
    proof: { device: "1", inode: "2", size: String(bytes), modifiedNs: "3", changedNs: "4" }
  };
}

const fileA = identity(SECRET_PATH, SECRET_NAME, CONTENT_A, 10);
const fileB = identity("/private/secret/also-hidden.txt", "also-hidden.txt", CONTENT_B, 20);

function identityDigest(_ordinal: number, manifest: OperationFileIdentity["manifest"]): string {
  return manifest.contentSha256 === CONTENT_A ? IDENTITY_A : IDENTITY_B;
}

function manifest(entries: readonly string[] = [IDENTITY_A]): SubmissionHandoffRequest["manifest"] {
  return {
    count: entries.length,
    orderPolicy: "exact",
    identities: entries.map((identityDigest, ordinal) => ({ identityDigest, ordinal }))
  };
}

function handoffRequest(overrides: Partial<SubmissionHandoffRequest> = {}): SubmissionHandoffRequest {
  return {
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    actionId: ACTION_ID,
    targetBindingDigest: TARGET_DIGEST,
    manifest: manifest(),
    ...overrides
  };
}

function attachmentRequest(overrides: Partial<SubmissionAttachmentRequest> = {}): SubmissionAttachmentRequest {
  return {
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    targetBindingDigest: TARGET_DIGEST,
    manifest: manifest(),
    ...overrides
  };
}

type FakePage = PageLike & {
  waitForEventCalls: number;
  clickCalls: number;
  setFilesCalls: number;
  events: string[];
  paths: string[][];
};

function pageFixture(options: Readonly<{
  chooser: "delayed" | "rejected" | "never";
  clickRejects?: boolean;
  setFilesRejects?: boolean;
  candidateCount?: number;
  visible?: boolean;
}>): FakePage {
  const events: string[] = [];
  let chooserResolve: ((value: FileChooserLike) => void) | undefined;
  let chooserReject: ((reason?: unknown) => void) | undefined;
  const paths: string[][] = [];
  let page: FakePage;
  const chooser: FileChooserLike = {
    setFiles: async incoming => {
      events.push("setFiles");
      page.setFilesCalls += 1;
      paths.push([...incoming]);
      if (options.setFilesRejects) throw new Error("bridge setFiles rejected after acting");
    }
  };
  const activation: LocatorLike = {
    count: async () => 1,
    isVisible: async () => options.visible ?? true,
    click: async () => {
      events.push("click");
      page.clickCalls += 1;
      if (options.chooser === "delayed") {
        queueMicrotask(() => chooserResolve?.(chooser));
      }
      if (options.clickRejects) throw new Error("bridge click rejected after acting");
    }
  };
  page = {
    waitForEvent: (event: string) => {
      expect(event).toBe("filechooser");
      page.waitForEventCalls += 1;
      events.push("waitForEvent");
      if (options.chooser === "rejected") return Promise.reject(new Error("chooser rejected"));
      if (options.chooser === "never") return new Promise<FileChooserLike>((resolve, reject) => {
        chooserResolve = resolve;
        chooserReject = reject;
      });
      return new Promise<FileChooserLike>((resolve, reject) => {
        chooserResolve = resolve;
        chooserReject = reject;
      });
    },
    locator: () => activation,
    waitForEventCalls: 0,
    clickCalls: 0,
    setFilesCalls: 0,
    events,
    paths
  };
  void chooserReject;
  return page;
}

function activationFor(page: FakePage, candidateCount = 1, visible = true): ProductionAttachmentActivation {
  const locator = page.locator?.("button");
  if (locator === undefined) throw new Error("fixture locator missing");
  return { locator, candidateCount, capabilityKey: "chat.attachments.upload" };
}

function makePrimitive(options: Readonly<{
  files?: readonly OperationFileIdentity[];
  page?: FakePage;
  revalidateFile?: (file: OperationFileIdentity) => Promise<void>;
  observeSurface?: (readRequest: SubmissionAttachmentRequest) => Promise<ProductionAttachmentSurfaceRead>;
  resolveActivation?: (handoffRequest: SubmissionHandoffRequest, page: Readonly<PageLike>) => Promise<ProductionAttachmentActivation | undefined>;
  prepareActivation?: (handoffRequest: SubmissionHandoffRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1, options: Readonly<{ timeoutMs: number }>) => Promise<ProductionAttachmentPreparationResult>;
  timeoutMs?: number;
}> = {}) {
  const page = options.page ?? pageFixture({ chooser: "delayed" });
  const evidenceInputs: unknown[] = [];
  const primitive = createProductionAttachmentPrimitive({
    evidenceDigest: (domain, material) => {
      evidenceInputs.push({ domain, material });
      return digest(domain, material);
    },
    files: options.files ?? [fileA],
    identityDigest,
    revalidateFile: options.revalidateFile ?? (async () => undefined),
    observeSurface: options.observeSurface ?? (async request => ({
      status: "exact",
      source: "live_surface",
      count: request.manifest.count,
      identityDigests: request.manifest.identities.map(entry => entry.identityDigest),
      providerEvidenceDigest: digest("surface", request.manifest.identities.map(entry => entry.identityDigest))
    })),
    resolveActivation: options.resolveActivation ?? (async (_request, rawPage) => activationFor(rawPage as FakePage)),
    ...(options.prepareActivation === undefined ? {} : { prepareActivation: options.prepareActivation }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  return { primitive, page, evidenceInputs };
}

describe("production attachment primitive", () => {
  it("accepts native chooser, click, and setFiles promises from a foreign realm", async () => {
    const ForeignPromise = runInNewContext("Promise") as PromiseConstructor;
    let resolveChooser: ((chooser: FileChooserLike) => void) | undefined;
    let clickCalls = 0;
    let setFilesCalls = 0;
    const chooser: FileChooserLike = {
      setFiles: () => new ForeignPromise<void>(resolve => {
        setFilesCalls += 1;
        resolve();
      })
    };
    const activation: LocatorLike = {
      count: () => ForeignPromise.resolve(1),
      isVisible: () => ForeignPromise.resolve(true),
      click: () => new ForeignPromise<void>(resolve => {
        clickCalls += 1;
        queueMicrotask(() => resolveChooser?.(chooser));
        resolve();
      })
    };
    const page = {
      waitForEvent: () => new ForeignPromise<FileChooserLike>(resolve => {
        resolveChooser = resolve;
      }),
      locator: () => activation,
      waitForEventCalls: 0,
      clickCalls: 0,
      setFilesCalls: 0,
      events: [],
      paths: []
    } as unknown as FakePage;
    const { primitive } = makePrimitive({
      page,
      revalidateFile: () => ForeignPromise.resolve(),
      resolveActivation: () => ForeignPromise.resolve({
        locator: activation,
        candidateCount: 1,
        capabilityKey: "chat.attachments.upload"
      })
    });

    const result = await primitive.handoffFiles(handoffRequest(), page, target);

    expect(result.status).toBe("satisfied");
    expect(clickCalls).toBe(1);
    expect(setFilesCalls).toBe(1);
  });

  it("preserves a proxied file chooser's private-field method binding", async () => {
    const page = pageFixture({ chooser: "delayed" });
    let resolveChooser: ((chooser: FileChooserLike) => void) | undefined;
    class PrivateChooser {
      #calls = 0;
      readonly paths: string[][] = [];

      get calls(): number {
        return this.#calls;
      }

      async setFiles(paths: string[]): Promise<void> {
        this.#calls += 1;
        this.paths.push([...paths]);
      }
    }
    const rawChooser = new PrivateChooser();
    const chooser = new Proxy(rawChooser, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as FileChooserLike;
    page.waitForEvent = () => new Promise<FileChooserLike>(resolve => {
      resolveChooser = resolve;
    });
    page.locator = () => ({
      count: async () => 1,
      isVisible: async () => true,
      click: async () => {
        page.clickCalls += 1;
        resolveChooser?.(chooser);
      }
    });
    const { primitive } = makePrimitive({ page });

    const result = await primitive.handoffFiles(handoffRequest(), page, target);

    expect(result.status).toBe("satisfied");
    expect(rawChooser.calls).toBe(1);
    expect(rawChooser.paths).toEqual([[SECRET_PATH]]);
  });

  it("registers one handled chooser waiter before one visible activation and one setFiles", async () => {
    const page = pageFixture({ chooser: "delayed" });
    const events: string[] = [];
    const { primitive } = makePrimitive({
      page,
      resolveActivation: async request => {
        void request;
        events.push("resolveActivation");
        return activationFor(page);
      },
      revalidateFile: async () => { events.push("revalidate"); }
    });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result.status).toBe("satisfied");
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(1);
    expect(page.setFilesCalls).toBe(1);
    expect(page.paths).toEqual([[SECRET_PATH]]);
    expect(page.events).toEqual(["waitForEvent", "click", "setFiles"]);
    expect(events).toEqual(["revalidate", "resolveActivation"]);
    expect(JSON.stringify(result)).not.toContain(SECRET_PATH);
    expect(JSON.stringify(result)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(result)).not.toContain(CONTENT_A);
  });

  it("supports one provider-owned hidden-control gesture after chooser registration", async () => {
    const page = pageFixture({ chooser: "delayed" });
    const events: string[] = [];
    const locator = page.locator?.("input[type='file']");
    if (locator?.click === undefined) throw new Error("fixture click missing");
    const { primitive } = makePrimitive({
      page,
      resolveActivation: async () => ({
        activate: async options => {
          expect(options.timeoutMs).toBeGreaterThan(0);
          events.push("activate");
          await locator.click?.({ timeoutMs: options.timeoutMs });
        },
        candidateCount: 1,
        capabilityKey: "chat.attachments.hidden-input"
      })
    });

    const result = await primitive.handoffFiles(handoffRequest(), page, target);

    expect(result.status).toBe("satisfied");
    expect(events).toEqual(["activate"]);
    expect(page.events).toEqual(["waitForEvent", "click", "setFiles"]);
    expect(page.setFilesCalls).toBe(1);
  });

  it("rejects ambiguous activation shapes before any provider gesture", async () => {
    const page = pageFixture({ chooser: "delayed" });
    const locator = page.locator?.("input[type='file']");
    if (locator === undefined) throw new Error("fixture locator missing");
    let providerCalls = 0;
    const { primitive } = makePrimitive({
      page,
      resolveActivation: async () => ({
        locator,
        activate: () => { providerCalls += 1; },
        candidateCount: 1,
        capabilityKey: "chat.attachments.invalid"
      } as unknown as ProductionAttachmentActivation),
      timeoutMs: 20
    });

    const result = await primitive.handoffFiles(handoffRequest(), page, target);

    expect(result).toEqual({ status: "not_satisfied", blockerCode: "selector_drift" });
    expect(providerCalls).toBe(0);
    expect(page.clickCalls).toBe(0);
    expect(page.setFilesCalls).toBe(0);
  });

  it("captures callbacks and evidence before the caller can mutate the options object", async () => {
    const page = pageFixture({ chooser: "delayed" });
    let oldResolveCalls = 0;
    let oldEvidenceCalls = 0;
    let options: {
      evidenceDigest: (domain: string, material: unknown) => string;
      files: readonly OperationFileIdentity[];
      identityDigest: (ordinal: number, manifest: OperationFileIdentity["manifest"]) => string;
      revalidateFile: (file: OperationFileIdentity) => Promise<void>;
      observeSurface: (request: SubmissionAttachmentRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ProductionAttachmentSurfaceRead>;
      resolveActivation: (request: SubmissionHandoffRequest, page: Readonly<PageLike>, target: OperationTargetBindingV1) => Promise<ProductionAttachmentActivation | undefined>;
    } = {
      evidenceDigest: (domain, material) => {
        oldEvidenceCalls += 1;
        return digest(domain, material);
      },
      files: [fileA],
      identityDigest,
      revalidateFile: async () => undefined,
      observeSurface: async request => ({
        status: "exact",
        source: "live_surface",
        count: request.manifest.count,
        identityDigests: [IDENTITY_A],
        providerEvidenceDigest: digest("surface", IDENTITY_A)
      }),
      resolveActivation: async () => {
        oldResolveCalls += 1;
        return activationFor(page);
      }
    };
    const primitive = createProductionAttachmentPrimitive(options);
    options.evidenceDigest = () => { throw new Error("mutated evidence callback"); };
    options.resolveActivation = async () => undefined;
    options.observeSurface = async () => ({ status: "unavailable", source: "live_surface" });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result.status).toBe("satisfied");
    expect(oldResolveCalls).toBe(1);
    expect(oldEvidenceCalls).toBe(1);
  });

  it("does not activate after an immediately rejected chooser", async () => {
    const page = pageFixture({ chooser: "rejected" });
    let resolveCalls = 0;
    const { primitive } = makePrimitive({
      page,
      resolveActivation: async () => {
        resolveCalls += 1;
        return activationFor(page);
      }
    });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result).toEqual({ status: "not_satisfied", blockerCode: "ambiguous_file_handoff" });
    expect(page.waitForEventCalls).toBe(1);
    expect(resolveCalls).toBe(0);
    expect(page.clickCalls).toBe(0);
    expect(page.setFilesCalls).toBe(0);
  });

  it("fences coordinated chooser registration before an uncoordinated provider locator can mutate", async () => {
    const coordinator = new ProcessTabCoordinator();
    const key = createTabResourceKey(target.providerId, target.browserId, target.tabId);
    let releaseHold!: () => void;
    let markHoldStarted!: () => void;
    const holdGate = new Promise<void>(resolve => { releaseHold = resolve; });
    const holdStarted = new Promise<void>(resolve => { markHoldStarted = resolve; });
    const held = coordinator.withTabTransaction(key, {
      owner: { backendSessionId: "other-session", operationId: "other-operation" },
      priority: "mutation",
      label: "hold-before-registration"
    }, async () => {
      markHoldStarted();
      await holdGate;
    });
    await holdStarted;

    let registrations = 0;
    let clicks = 0;
    let setFilesCalls = 0;
    let resolveChooser: ((chooser: FileChooserLike) => void) | undefined;
    const chooser: FileChooserLike = {
      setFiles: async () => { setFilesCalls += 1; }
    };
    const rawPage: PageLike = {
      waitForEvent: () => {
        registrations += 1;
        return new Promise<FileChooserLike>(resolve => { resolveChooser = resolve; });
      }
    };
    const page = createCoordinatedPage(rawPage, {
      coordinator,
      resource: { kind: "tab", key },
      owner: { backendSessionId: "operation-session", operationId: OPERATION_ID },
      defaultTimeoutMs: 1_000
    });
    const activation: ProductionAttachmentActivation = {
      // Deliberately not a coordinated locator. The primitive itself must
      // fence page.waitForEvent registration before invoking this provider.
      locator: {
        count: async () => 1,
        isVisible: async () => true,
        click: async () => {
          clicks += 1;
          resolveChooser?.(chooser);
        }
      },
      candidateCount: 1,
      capabilityKey: "chat.attachments.upload"
    };
    const primitive = createProductionAttachmentPrimitive({
      evidenceDigest: digest,
      files: [fileA],
      identityDigest,
      revalidateFile: async () => undefined,
      observeSurface: async () => ({ status: "unavailable", source: "live_surface" }),
      resolveActivation: async () => activation,
      timeoutMs: 1_000
    });

    const pending = primitive.handoffFiles(handoffRequest(), page, target);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(registrations).toBe(0);
    expect(clicks).toBe(0);

    releaseHold();
    await held;
    const result = await pending;
    expect(result.status).toBe("satisfied");
    expect(registrations).toBe(1);
    expect(clicks).toBe(1);
    expect(setFilesCalls).toBe(1);
  });

  it("does not feed files to a chooser that settled before this operation activated", async () => {
    const page = pageFixture({ chooser: "delayed" });
    let staleChooserSetFilesCalls = 0;
    page.waitForEvent = async () => ({
      setFiles: async () => { staleChooserSetFilesCalls += 1; }
    });
    let resolveCalls = 0;
    const { primitive } = makePrimitive({
      page,
      resolveActivation: async () => {
        resolveCalls += 1;
        return activationFor(page);
      }
    });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result).toEqual({ status: "not_satisfied", blockerCode: "ambiguous_file_handoff" });
    expect(resolveCalls).toBe(0);
    expect(staleChooserSetFilesCalls).toBe(0);
    expect(page.setFilesCalls).toBe(0);
  });

  it("reconciles an activation that acts before its click promise rejects", async () => {
    const page = pageFixture({ chooser: "delayed", clickRejects: true });
    const { primitive } = makePrimitive({ page });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result.status).toBe("satisfied");
    expect(page.clickCalls).toBe(1);
    expect(page.setFilesCalls).toBe(1);
  });

  it("models Chat's plus-menu preparation as one awaited durable handoff mutation before final upload discovery", async () => {
    const page = pageFixture({ chooser: "delayed" });
    const phases: string[] = [];
    const { primitive } = makePrimitive({
      page,
      prepareActivation: async (_request, _page, _target, options) => {
        phases.push(`prepare:${options.timeoutMs > 0 ? "bounded" : "unbounded"}`);
        return { status: "prepared", providerEvidenceDigest: digest("prepared", "plus-menu") };
      },
      resolveActivation: async () => {
        phases.push("resolve-final-upload");
        return activationFor(page);
      }
    });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result.status).toBe("satisfied");
    expect(phases).toEqual(["prepare:bounded", "resolve-final-upload"]);
    expect(page.events).toEqual(["waitForEvent", "click", "setFiles"]);
    expect(page.clickCalls).toBe(1);
    expect(page.setFilesCalls).toBe(1);
  });

  it("quarantines a setFiles rejection and never retries the non-repeatable handoff", async () => {
    const page = pageFixture({ chooser: "delayed", setFilesRejects: true });
    const { primitive } = makePrimitive({ page });
    const first = await primitive.handoffFiles(handoffRequest(), page, target);
    const second = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(first).toEqual({ status: "uncertain", quarantine: "provider" });
    expect(second).toEqual({ status: "uncertain", quarantine: "caller" });
    expect(page.clickCalls).toBe(1);
    expect(page.setFilesCalls).toBe(1);
  });

  it("awaits late mutating bridge promises instead of releasing the actor on a local timer", async () => {
    const page = pageFixture({ chooser: "delayed" });
    let resolveChooser: (() => void) | undefined;
    const chooser: FileChooserLike = {
      setFiles: async () => {
        page.setFilesCalls += 1;
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
    };
    page.waitForEvent = () => new Promise<FileChooserLike>(resolve => {
      resolveChooser = () => resolve(chooser);
    });
    page.locator = () => ({
      count: async () => 1,
      isVisible: async () => true,
      click: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        resolveChooser?.();
      }
    });
    // Leave enough pre-mutation budget for CI scheduling while keeping each
    // 25 ms native mutation well beyond the provider's local 10 ms budget.
    const { primitive } = makePrimitive({ page, timeoutMs: 10 });
    const startedAt = Date.now();
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(result.status).toBe("satisfied");
    expect(page.setFilesCalls).toBe(1);
  });

  it("quarantines a caller abort during click and never repeats the handoff", async () => {
    let resolveChooser!: (chooser: FileChooserLike) => void;
    let markClickStarted!: () => void;
    let releaseClick!: () => void;
    const clickStarted = new Promise<void>(resolve => { markClickStarted = resolve; });
    const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
    let clickCalls = 0;
    let setFilesCalls = 0;
    const chooser: FileChooserLike = {
      setFiles: async () => { setFilesCalls += 1; }
    };
    const activation: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      click: async () => {
        clickCalls += 1;
        markClickStarted();
        await clickGate;
        resolveChooser(chooser);
      }
    };
    const page: FakePage = {
      waitForEvent: () => new Promise<FileChooserLike>(resolve => { resolveChooser = resolve; }),
      locator: () => activation,
      waitForEventCalls: 0,
      clickCalls: 0,
      setFilesCalls: 0,
      events: [],
      paths: []
    };
    const { primitive } = makePrimitive({ page, timeoutMs: 500 });
    const controller = new AbortController();
    const pending = primitive.handoffFiles(handoffRequest({ signal: controller.signal }), page, target);
    await clickStarted;
    controller.abort();
    releaseClick();

    await expect(pending).resolves.toEqual({ status: "uncertain", quarantine: "caller" });
    await expect(primitive.handoffFiles(handoffRequest(), page, target)).resolves.toEqual({
      status: "uncertain",
      quarantine: "caller"
    });
    expect(clickCalls).toBe(1);
    expect(setFilesCalls).toBe(0);
  });

  it("quarantines a caller abort during setFiles and never repeats the handoff", async () => {
    let resolveChooser!: (chooser: FileChooserLike) => void;
    let markSetFilesStarted!: () => void;
    let releaseSetFiles!: () => void;
    const setFilesStarted = new Promise<void>(resolve => { markSetFilesStarted = resolve; });
    const setFilesGate = new Promise<void>(resolve => { releaseSetFiles = resolve; });
    let setFilesCalls = 0;
    const chooser: FileChooserLike = {
      setFiles: async () => {
        setFilesCalls += 1;
        markSetFilesStarted();
        await setFilesGate;
      }
    };
    const activation: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      click: async () => { resolveChooser(chooser); }
    };
    const page: FakePage = {
      waitForEvent: () => new Promise<FileChooserLike>(resolve => { resolveChooser = resolve; }),
      locator: () => activation,
      waitForEventCalls: 0,
      clickCalls: 0,
      setFilesCalls: 0,
      events: [],
      paths: []
    };
    const { primitive } = makePrimitive({ page, timeoutMs: 500 });
    const controller = new AbortController();
    const pending = primitive.handoffFiles(handoffRequest({ signal: controller.signal }), page, target);
    await setFilesStarted;
    controller.abort();
    releaseSetFiles();

    await expect(pending).resolves.toEqual({ status: "uncertain", quarantine: "caller" });
    await expect(primitive.handoffFiles(handoffRequest(), page, target)).resolves.toEqual({
      status: "uncertain",
      quarantine: "caller"
    });
    expect(setFilesCalls).toBe(1);
  });

  it("bounds a chooser event that never settles after activation without a late setFiles continuation", async () => {
    const page = pageFixture({ chooser: "never" });
    const { primitive } = makePrimitive({ page, timeoutMs: 5 });

    const startedAt = Date.now();
    const first = await primitive.handoffFiles(handoffRequest(), page, target);
    const elapsed = Date.now() - startedAt;
    const second = await primitive.handoffFiles(handoffRequest(), page, target);

    expect(first).toEqual({ status: "uncertain", quarantine: "provider" });
    expect(second).toEqual({ status: "uncertain", quarantine: "caller" });
    expect(elapsed).toBeLessThan(500);
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(1);
    expect(page.setFilesCalls).toBe(0);
  });

  it("revalidates identities immediately before arming the chooser and fails closed on mutation", async () => {
    const page = pageFixture({ chooser: "delayed" });
    const events: string[] = [];
    const { primitive } = makePrimitive({
      page,
      revalidateFile: async () => {
        events.push("revalidate");
        throw new Error("file changed");
      },
      resolveActivation: async () => {
        events.push("resolve");
        return activationFor(page);
      }
    });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result).toEqual({ status: "not_satisfied", blockerCode: "input_file_changed" });
    expect(events).toEqual(["revalidate"]);
    expect(page.waitForEventCalls).toBe(0);
    expect(page.clickCalls).toBe(0);
  });

  it.each([
    ["duplicate", [IDENTITY_A, IDENTITY_A]],
    ["reordered", [IDENTITY_B, IDENTITY_A]],
    ["missing", []]
  ])("rejects a %s or incomplete manifest without browser mutation", async (_label, identities) => {
    const page = pageFixture({ chooser: "delayed" });
    const { primitive } = makePrimitive({ files: [fileA, fileB], page });
    const result = await primitive.handoffFiles(handoffRequest({ manifest: manifest(identities) }), page, target);
    expect(result).toEqual({ status: "not_satisfied", blockerCode: "attachment_manifest_mismatch" });
    expect(page.waitForEventCalls).toBe(0);
    expect(page.clickCalls).toBe(0);
  });

  it("requires one visible candidate and bounds candidate counts", async () => {
    const page = pageFixture({ chooser: "delayed", candidateCount: 2, visible: false });
    const { primitive } = makePrimitive({
      page,
      resolveActivation: async () => activationFor(page, 2, false)
    });
    const result = await primitive.handoffFiles(handoffRequest(), page, target);
    expect(result).toEqual({ status: "not_satisfied", blockerCode: "selector_drift" });
    expect(page.clickCalls).toBe(0);
    expect(page.setFilesCalls).toBe(0);
  });

  it("only accepts exact identities exposed by the live surface and never uses filename as SHA evidence", async () => {
    const { primitive, evidenceInputs } = makePrimitive({
      observeSurface: async () => ({
        status: "exact",
        source: "live_surface",
        count: 1,
        identityDigests: [IDENTITY_A],
        providerEvidenceDigest: digest("surface", IDENTITY_A)
      })
    });
    const result = await primitive.observeAttachments(attachmentRequest(), {}, target);
    expect(result.status).toBe("exact");
    expect((result as { identityDigests?: readonly string[] }).identityDigests).toEqual([IDENTITY_A]);
    expect(JSON.stringify(evidenceInputs)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(evidenceInputs)).not.toContain(CONTENT_A);
  });

  it("treats an identity-proven empty live surface as the precondition for a non-empty handoff", async () => {
    const providerEvidenceDigest = digest("surface", "empty-live-surface");
    const { primitive, evidenceInputs } = makePrimitive({
      observeSurface: async () => ({
        status: "absent",
        source: "live_surface",
        count: 0,
        identityDigests: [],
        providerEvidenceDigest
      })
    });

    const result = await primitive.observeAttachments(attachmentRequest(), {}, target);

    expect(result).toMatchObject({
      status: "absent",
      count: 0,
      orderPolicy: "exact",
      identityDigests: []
    });
    expect(evidenceInputs).toContainEqual(expect.objectContaining({
      domain: "attachment-surface",
      material: expect.objectContaining({ providerEvidenceDigest })
    }));
  });

  it("does not turn a filename-like observation into exact content identity", async () => {
    const { primitive } = makePrimitive({
      observeSurface: async () => ({
        status: "exact",
        source: "live_surface",
        count: 1,
        identityDigests: [SECRET_NAME],
        providerEvidenceDigest: digest("surface", SECRET_NAME)
      } as unknown as ProductionAttachmentSurfaceRead)
    });
    const result = await primitive.observeAttachments(attachmentRequest(), {}, target);
    expect(["ambiguous", "mismatch", "unavailable"]).toContain(result.status);
  });

  it("fails closed on accessor-backed request, page, and identity inputs without invoking getters", async () => {
    let requestGetterCalls = 0;
    const request = handoffRequest();
    Object.defineProperty(request, "requestDigest", {
      configurable: true,
      enumerable: true,
      get: () => {
        requestGetterCalls += 1;
        throw new Error("request getter invoked");
      }
    });
    const page = pageFixture({ chooser: "delayed" });
    let pageGetterCalls = 0;
    Object.defineProperty(page, "waitForEvent", {
      configurable: true,
      enumerable: true,
      get: () => {
        pageGetterCalls += 1;
        throw new Error("page getter invoked");
      }
    });
    const { primitive } = makePrimitive({ page });
    const result = await primitive.handoffFiles(request, page, target);
    expect(result.status).toBe("not_satisfied");
    expect(requestGetterCalls).toBe(0);
    expect(pageGetterCalls).toBe(0);

    let identityGetterCalls = 0;
    const hostileIdentity = {
      ...fileA,
      get sourcePath(): string {
        identityGetterCalls += 1;
        throw new Error("identity getter invoked");
      }
    } as unknown as OperationFileIdentity;
    expect(() => makePrimitive({ files: [hostileIdentity] })).toThrow();
    expect(identityGetterCalls).toBe(0);
  });

  it("accepts the adapter-shaped call only for the exact immutable identity list", async () => {
    const page = pageFixture({ chooser: "delayed" });
    const { primitive } = makePrimitive({ page });
    const altered = identity("/private/other.pdf", SECRET_NAME, CONTENT_A, 10);
    const rejected = await primitive.handoffFilesForAdapter(handoffRequest(), [altered], page, target);
    expect(rejected).toEqual({ status: "not_satisfied", blockerCode: "attachment_manifest_mismatch" });
    expect(page.waitForEventCalls).toBe(0);

    const accepted = await primitive.handoffFilesForAdapter(handoffRequest(), [fileA], page, target);
    expect(accepted.status).toBe("satisfied");
    expect(page.setFilesCalls).toBe(1);
  });
});
