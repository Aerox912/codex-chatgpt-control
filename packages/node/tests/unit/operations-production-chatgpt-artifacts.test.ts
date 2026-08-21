import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadLike } from "../../src/browser/downloads.js";
import type { PageLike } from "../../src/types.js";
import type { ArtifactTransferSourceRequest } from "../../src/operations/artifact-transfer.js";
import {
  createProductionChatGPTArtifacts,
  type ProductionChatGPTArtifactsOptions
} from "../../src/operations/production-chatgpt-artifacts.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_DIGEST = digest("request", "request");
const TARGET_DIGEST = digest("target", "target");
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const DESTINATION_DIGEST = digest("destination", "destination");
const TURN_ID = "assistant-turn-opaque-1";
const SOURCE_IDENTITY = "artifact-provider-opaque-id";
const PAYLOAD = Buffer.from("artifact payload\n", "utf8");
const SECRET_NAME = "private-label-never-returned.txt";
const SECRET_PATH = "/private/secret/never-returned.txt";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(path => rm(path, { recursive: true, force: true })));
  temporaryRoots.clear();
});

type Facts = {
  kind: "file" | "image" | "other";
  ordinal: number;
  identity: string;
  contentDigest?: string;
  bytes?: number;
  mimeType?: string;
};

type FakePage = PageLike & {
  evaluateCalls: number;
  evaluateCallbacks: Array<(arg: unknown) => unknown>;
  evaluateArguments: unknown[];
  waitForEventCalls: number;
  clickCalls: number;
  events: string[];
  releaseDownload?: (download: DownloadLike) => void;
  releaseClickEvaluate?: () => void;
};

function digest(domain: string, material: unknown): string {
  return `hmac-sha256:${createHash("sha256").update(`${domain}:${JSON.stringify(material)}`, "utf8").digest("hex")}`;
}

function artifactIdentityDigest(facts: Facts): string {
  return digest("browser-observation-artifact", {
    operationId: OPERATION_ID,
    turnId: TURN_ID,
    ordinal: facts.ordinal,
    kind: facts.kind,
    identity: facts.identity,
    ...(facts.contentDigest === undefined ? {} : { contentDigest: facts.contentDigest }),
    ...(facts.bytes === undefined ? {} : { bytes: facts.bytes }),
    ...(facts.mimeType === undefined ? {} : { mimeType: facts.mimeType })
  });
}

function request(overrides: Partial<ArtifactTransferSourceRequest> = {}): ArtifactTransferSourceRequest {
  return {
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    assistantTurnId: TURN_ID,
    sourceIdentityDigest: SOURCE_IDENTITY,
    kind: "file",
    ordinal: 0,
    transferActionId: ACTION_ID,
    destinationIdentityDigest: DESTINATION_DIGEST,
    ...overrides
  };
}

async function root(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `production-chatgpt-artifact-${label}-`));
  temporaryRoots.add(path);
  return path;
}

function facts(overrides: Partial<Facts> = {}): Facts {
  const result: Facts = {
    kind: "file",
    ordinal: 0,
    identity: SOURCE_IDENTITY,
    contentDigest: "a".repeat(64),
    bytes: PAYLOAD.byteLength,
    mimeType: "text/plain",
    ...overrides
  };
  return result;
}

function downloadFixture(options: Readonly<{
  payload?: Uint8Array;
  saveAsRejects?: boolean;
  onSaveAs?: () => void;
  path?: string;
}> = {}): DownloadLike {
  const payload = Uint8Array.from(options.payload ?? PAYLOAD);
  if (options.saveAsRejects === true) {
    return {
      saveAs: async () => {
        options.onSaveAs?.();
        throw new Error(`${SECRET_PATH} saveAs rejected`);
      }
    };
  }
  const stream = async function*(): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < payload.byteLength; offset += 64 * 1024) {
      yield payload.subarray(offset, Math.min(payload.byteLength, offset + (64 * 1024)));
    }
  };
  return {
    createReadStream: async () => stream(),
    ...(options.path === undefined ? {} : { path: async () => options.path ?? null })
  };
}

function pathOnlyDownload(path: string): DownloadLike {
  return { path: async () => path };
}

function pageFixture(options: Readonly<{
  pageFacts?: Facts;
  clickResult?: boolean;
  releaseOnFalse?: boolean;
  clickRejects?: boolean;
  staleDownload?: boolean;
  neverDownload?: boolean;
  neverClickEvaluate?: boolean;
  download?: DownloadLike;
  clickGate?: Promise<void>;
}> = {}): FakePage {
  const page: FakePage = {
    evaluateCalls: 0,
    evaluateCallbacks: [],
    evaluateArguments: [],
    waitForEventCalls: 0,
    clickCalls: 0,
    events: [],
    waitForEvent: () => {
      page.waitForEventCalls += 1;
      page.events.push("waitForEvent");
      if (options.staleDownload === true) return Promise.resolve(options.download ?? downloadFixture());
      if (options.neverDownload === true) return new Promise<DownloadLike>(() => undefined);
      return new Promise<DownloadLike>(resolve => {
        page.releaseDownload = resolve;
      });
    },
    evaluate: async <T, A = unknown>(_fn: (arg: A) => T | Promise<T>, _args?: A): Promise<T> => {
      page.evaluateCalls += 1;
      page.evaluateCallbacks.push(_fn as (arg: unknown) => unknown);
      page.evaluateArguments.push(_args);
      if (page.evaluateCalls === 1) {
        return (options.pageFacts ?? facts()) as T;
      }
      page.clickCalls += 1;
      page.events.push("click");
      if (options.clickGate !== undefined) await options.clickGate;
      if (options.neverClickEvaluate === true) {
        return await new Promise<T>((_resolve, reject) => {
          page.releaseClickEvaluate = () => reject(new Error("late click bridge rejection"));
        });
      }
      if (options.clickRejects === true) {
        page.releaseDownload?.(options.download ?? downloadFixture());
        throw new Error("bridge click rejected after delivering the gesture");
      }
      if (options.clickResult === false) {
        if (options.releaseOnFalse === true) page.releaseDownload?.(options.download ?? downloadFixture());
        return false as T;
      }
      page.releaseDownload?.(options.download ?? downloadFixture());
      return true as T;
    }
  };
  return page;
}

function makeProvider(
  tempDirectory: string,
  page: FakePage,
  overrides: Partial<ProductionChatGPTArtifactsOptions> = {}
) {
  const options: ProductionChatGPTArtifactsOptions = {
    page,
    evidenceDigest: digest,
    tempDirectory,
    timeoutMs: 200,
    ...overrides
  };
  return createProductionChatGPTArtifacts(options);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(Uint8Array.from(chunk));
  return chunks;
}

type SyntheticElement = {
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  firstChild: SyntheticElement | null;
  nextSibling: SyntheticElement | null;
  parentNode: SyntheticElement | null;
  firstElementChild: SyntheticElement | null;
  nextElementSibling: SyntheticElement | null;
  parentElement: SyntheticElement | null;
  nodeType: number;
  tagName: string;
  closest: () => SyntheticElement;
  matches: (selector: string) => boolean;
  click?: () => void;
  querySelectorAll: () => never;
};

function syntheticProbeDom(options: Readonly<{
  artifactCount: number;
  trailingElements?: number;
  noiseNodes?: number;
  nestedTurns?: ReadonlyArray<Readonly<{
    turnId: string;
    role: "assistant" | "user";
    artifactIdentity: string;
  }>>;
  sentinel?: boolean;
}>): {
  document: { firstChild: SyntheticElement; firstElementChild: SyntheticElement; querySelectorAll: () => never };
  counters: { artifactMatches: number; sentinelTouched: boolean; clickedIdentities: string[] };
} {
  const counters = { artifactMatches: 0, sentinelTouched: false, clickedIdentities: [] as string[] };
  let root!: SyntheticElement;
  const makeNode = (
    values: Record<string, string>,
    tagName: string,
    artifact: boolean,
    nodeType = 1
  ): SyntheticElement => {
    const node: SyntheticElement = {
      getAttribute: name => values[name] ?? null,
      hasAttribute: name => Object.prototype.hasOwnProperty.call(values, name),
      firstChild: null,
      nextSibling: null,
      parentNode: null,
      firstElementChild: null,
      nextElementSibling: null,
      parentElement: null,
      nodeType,
      tagName,
      closest: () => root,
      matches: selector => {
        if (artifact && selector.includes("[data-file-id]")) counters.artifactMatches += 1;
        return (artifact && selector.includes("[data-file-id]"))
          || (!artifact && values["data-message-id"] !== undefined && selector.includes("[data-message-id]"));
      },
      ...(artifact ? {
        click: () => {
          const identity = values["data-file-id"];
          if (identity !== undefined) counters.clickedIdentities.push(identity);
        }
      } : {}),
      querySelectorAll: () => { throw new Error("unbounded selector traversal"); }
    };
    return node;
  };
  const linkChildren = (parent: SyntheticElement, children: SyntheticElement[]): void => {
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      child.parentElement = parent;
      child.parentNode = parent;
      child.nextSibling = children[index + 1] ?? null;
      child.nextElementSibling = children[index + 1] ?? null;
    }
    parent.firstChild = children[0] ?? null;
    parent.firstElementChild = children[0] ?? null;
  };
  const role = makeNode({ "data-message-author-role": "assistant" }, "DIV", false);
  const artifacts = Array.from({ length: options.artifactCount }, (_, index) => makeNode({
    "data-file-id": `artifact-${index}`,
    "data-content-sha256": "a".repeat(64),
    "data-bytes": "1",
    "data-mime-type": "text/plain"
  }, "A", true));
  root = makeNode({ "data-message-id": TURN_ID }, "DIV", false);
  const nested = (options.nestedTurns ?? []).map(turn => {
    const nestedRoot = makeNode({ "data-message-id": turn.turnId }, "DIV", false);
    const nestedRole = makeNode({ "data-message-author-role": turn.role }, "DIV", false);
    const nestedArtifact = makeNode({
      "data-file-id": turn.artifactIdentity,
      "data-content-sha256": "a".repeat(64),
      "data-bytes": "1",
      "data-mime-type": "text/plain"
    }, "A", true);
    linkChildren(nestedRoot, [nestedRole, nestedArtifact]);
    return nestedRoot;
  });
  const children: SyntheticElement[] = [role, ...artifacts];
  children.splice(1, 0, ...nested);
  for (let index = 0; index < (options.trailingElements ?? 0); index += 1) {
    children.push(makeNode({}, "DIV", false));
  }
  for (let index = 0; index < (options.noiseNodes ?? 0); index += 1) {
    children.push(makeNode({}, index % 2 === 0 ? "#text" : "#comment", false, index % 2 === 0 ? 3 : 8));
  }
  if (options.sentinel === true) {
    const sentinel = makeNode({}, "DIV", false);
    sentinel.matches = () => {
      counters.sentinelTouched = true;
      throw new Error("traversed past bounded DOM cap");
    };
    children.push(sentinel);
  }
  linkChildren(root, children);
  return {
    document: {
      firstChild: root,
      firstElementChild: root,
      querySelectorAll: () => { throw new Error("unbounded selector traversal"); }
    },
    counters
  };
}

function serializedProbe(page: FakePage): (args: unknown) => unknown {
  return Function(
    `"use strict"; return (${page.evaluateCallbacks[0]!.toString()});`
  )() as (args: unknown) => unknown;
}

describe("production ChatGPT artifact source", () => {
  it("keeps browser acquisition and local materialization in separate phases", async () => {
    const parent = await root("phase-boundary");
    const observed = facts();
    let localCalls = 0;
    const download: DownloadLike = {
      createReadStream: async () => {
        localCalls += 1;
        return (async function*(): AsyncGenerator<Uint8Array> {
          yield PAYLOAD;
        })();
      }
    };
    const page = pageFixture({ pageFacts: observed, download });
    const provider = makeProvider(parent, page);

    const acquired = await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    // This is the browser-actor handoff point: no local save/read/cleanup has
    // started and no provider temporary directory exists yet.
    expect(acquired).toBe(download);
    expect(localCalls).toBe(0);
    expect(await readdir(parent)).toEqual([]);
    expect(page.events).toEqual(["waitForEvent", "click"]);

    const source = await provider.materializeDownload(acquired);
    expect(localCalls).toBe(1);
    expect(Buffer.concat((await collect(source)).map(chunk => Buffer.from(chunk)))).toEqual(PAYLOAD);
    expect(await readdir(parent)).toEqual([]);
  });

  it("executes the serialized browser callback in an isolated realm with no module closure", async () => {
    const parent = await root("isolated-callback");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);
    await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));

    expect(page.evaluateCallbacks).toHaveLength(2);
    const reconstructed = Function(
      `"use strict"; return (${page.evaluateCallbacks[0]!.toString()});`
    )() as (args: unknown) => unknown;
    let isolatedClicks = 0;
    const attributes = (values: Record<string, string>) => ({
      getAttribute: (name: string) => values[name] ?? null,
      hasAttribute: (name: string) => Object.prototype.hasOwnProperty.call(values, name),
      firstChild: null,
      nextSibling: null,
      parentNode: null,
      firstElementChild: null,
      nextElementSibling: null,
      parentElement: null,
      nodeType: 1,
      querySelectorAll: () => { throw new Error("unbounded selector traversal"); }
    });
    let rootNode: Record<string, unknown>;
    const roleNode = {
      ...attributes({ "data-message-author-role": "assistant" }),
      tagName: "DIV",
      closest: () => rootNode,
      matches: () => false
    };
    const artifactNode = {
      ...attributes({
        "data-file-id": SOURCE_IDENTITY,
        "data-content-sha256": observed.contentDigest!,
        "data-bytes": String(observed.bytes),
        "data-mime-type": observed.mimeType!
      }),
      tagName: "A",
      closest: () => rootNode,
      matches: (selector: string) => selector.includes("[data-file-id]"),
      click: () => { isolatedClicks += 1; }
    };
    rootNode = {
      ...attributes({ "data-message-id": TURN_ID }),
      tagName: "DIV",
      closest: () => rootNode,
      matches: (selector: string) => selector.includes("[data-message-id]")
    };
    (roleNode as unknown as { parentElement: Record<string, unknown> | null }).parentElement = rootNode;
    (roleNode as unknown as { parentNode: Record<string, unknown> | null }).parentNode = rootNode;
    (roleNode as unknown as { nextElementSibling: Record<string, unknown> | null }).nextElementSibling = artifactNode;
    (roleNode as unknown as { nextSibling: Record<string, unknown> | null }).nextSibling = artifactNode;
    (artifactNode as unknown as { parentElement: Record<string, unknown> | null }).parentElement = rootNode;
    (artifactNode as unknown as { parentNode: Record<string, unknown> | null }).parentNode = rootNode;
    (rootNode as unknown as { firstElementChild: Record<string, unknown> | null }).firstElementChild = roleNode;
    (rootNode as unknown as { firstChild: Record<string, unknown> | null }).firstChild = roleNode;
    const documentFixture = {
      firstChild: rootNode,
      firstElementChild: rootNode,
      querySelectorAll: () => { throw new Error("unbounded selector traversal"); }
    };
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: documentFixture
    });
    try {
      expect(reconstructed(page.evaluateArguments[0])).toEqual(observed);
      expect(reconstructed(page.evaluateArguments[1])).toBe(true);
      expect(isolatedClicks).toBe(1);
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previousDocument);
    }
  });

  it("accepts exactly the artifact cap but stops before materializing an over-limit match", async () => {
    const parent = await root("bounded-artifacts");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);
    await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const callback = serializedProbe(page);
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
      const exact = syntheticProbeDom({ artifactCount: 2 });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: exact.document
      });
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 1,
        maxArtifacts: 2,
        mode: "read"
      })).toMatchObject({ identity: "artifact-1", ordinal: 1 });

      const over = syntheticProbeDom({ artifactCount: 3, sentinel: true });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: over.document
      });
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 0,
        maxArtifacts: 2,
        mode: "read"
      })).toBeUndefined();
      expect(over.counters.artifactMatches).toBe(3);
      // Per-owner overflow is recorded while the bounded traversal continues;
      // this lets unrelated turns remain eligible without page-wide fallback.
      expect(over.counters.sentinelTouched).toBe(true);
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previousDocument);
    }
  });

  it("counts text and comments in one global traversal budget at the exact cap", async () => {
    const parent = await root("bounded-text-comments");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);
    await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const callback = serializedProbe(page);
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
      const exact = syntheticProbeDom({ artifactCount: 1, noiseNodes: 4_093 });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: exact.document
      });
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 0,
        maxArtifacts: 1,
        mode: "read"
      })).toMatchObject({ identity: "artifact-0", ordinal: 0 });
      expect(exact.counters.artifactMatches).toBe(1);

      const over = syntheticProbeDom({ artifactCount: 1, noiseNodes: 4_093, sentinel: true });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: over.document
      });
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 0,
        maxArtifacts: 1,
        mode: "read"
      })).toBeUndefined();
      expect(over.counters.artifactMatches).toBe(1);
      expect(over.counters.sentinelTouched).toBe(false);
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previousDocument);
    }
  });

  it("attributes nested turn artifacts to their exact owner instead of outer range containment", async () => {
    const parent = await root("nested-turn-ownership");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);
    await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const callback = serializedProbe(page);
    const dom = syntheticProbeDom({
      artifactCount: 2,
      nestedTurns: [
        { turnId: "nested-human-turn", role: "user", artifactIdentity: "nested-human-artifact" },
        { turnId: "nested-assistant-turn", role: "assistant", artifactIdentity: "nested-assistant-artifact" }
      ]
    });
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: dom.document
    });
    try {
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 1,
        maxArtifacts: 4,
        mode: "read"
      })).toMatchObject({ identity: "artifact-1", ordinal: 1 });
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 1,
        maxArtifacts: 4,
        mode: "click",
        expected: {
          kind: "file",
          ordinal: 1,
          identity: "artifact-1",
          contentDigest: "a".repeat(64),
          bytes: 1,
          mimeType: "text/plain"
        }
      })).toBe(true);
      expect(dom.counters.clickedIdentities).toEqual(["artifact-1"]);
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previousDocument);
    }
  });

  it("keeps the artifact bound per owner when unrelated turns have earlier artifacts", async () => {
    const parent = await root("per-owner-artifact-cap");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);
    await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const callback = serializedProbe(page);
    const dom = syntheticProbeDom({
      artifactCount: 1,
      nestedTurns: [
        { turnId: "history-turn-1", role: "assistant", artifactIdentity: "history-artifact-1" },
        { turnId: "history-turn-2", role: "assistant", artifactIdentity: "history-artifact-2" },
        { turnId: "history-turn-3", role: "assistant", artifactIdentity: "history-artifact-3" }
      ]
    });
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: dom.document
    });
    try {
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 0,
        maxArtifacts: 1,
        mode: "read"
      })).toMatchObject({ identity: "artifact-0", ordinal: 0 });
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previousDocument);
    }
  });

  it("fails closed at the visited-node cap without falling back to a page-wide selector", async () => {
    const parent = await root("bounded-document");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);
    await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const callback = serializedProbe(page);
    const dom = syntheticProbeDom({ artifactCount: 1, trailingElements: 4_093, sentinel: true });
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: dom.document
    });
    try {
      expect(callback({
        assistantTurnId: TURN_ID,
        kind: "file",
        ordinal: 0,
        maxArtifacts: 1,
        mode: "read"
      })).toBeUndefined();
      expect(dom.counters.sentinelTouched).toBe(false);
      expect(dom.counters.artifactMatches).toBe(1);
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previousDocument);
    }
  });

  it("accepts local materialization only for a download acquired by this provider instance", async () => {
    const parent = await root("capability-fence");
    const page = pageFixture();
    const provider = makeProvider(parent, page);
    await expect(provider.materializeDownload(downloadFixture())).rejects.toThrow("source is unavailable");
    expect(await readdir(parent)).toEqual([]);
  });

  it("proves one exact turn/kind/ordinal identity, arms one waiter, clicks once, and cleans its temporary path", async () => {
    const parent = await root("success");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);

    const source = await provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const first = await collect(source);
    expect(Buffer.concat(first.map(chunk => Buffer.from(chunk)))).toEqual(PAYLOAD);
    // Download capabilities are intentionally one-shot. A second iterator
    // cannot replay private bytes after the file handle and temp are closed.
    const second = await collect(source);
    expect(second).toEqual([]);
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(1);
    expect(page.evaluateCalls).toBe(2);
    expect(page.events).toEqual(["waitForEvent", "click"]);
    expect(await readdir(parent)).toEqual([]);
  });

  it("returns defensive one-shot chunks and never exposes path, name, or content metadata", async () => {
    const parent = await root("defensive");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const provider = makeProvider(parent, page);
    const source = await provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const first = await collect(source);
    first[0]?.fill?.(0xff);
    expect(await collect(source)).toEqual([]);
    expect(JSON.stringify(source)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(source)).not.toContain(SECRET_PATH);
    expect(JSON.stringify(source)).not.toContain(PAYLOAD.toString("utf8"));
  });

  it("streams a large download in bounded chunks and cleans on iterator return", async () => {
    const parent = await root("bounded-stream");
    const payload = Buffer.alloc((64 * 1024 * 2) + 17, 0x5a);
    const observed = facts({ bytes: payload.byteLength });
    const page = pageFixture({
      pageFacts: observed,
      download: downloadFixture({ payload })
    });
    const provider = makeProvider(parent, page, { maxBytes: payload.byteLength + 1 });
    const source = await provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    // Capability-based streams do not create operation-owned filesystem
    // paths, so there is no temporary residue even before iteration starts.
    expect((await readdir(parent)).some(name => name.startsWith(".chatgpt-artifact-"))).toBe(false);
    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBe(64 * 1024);
    await iterator.return?.();
    expect(await readdir(parent)).toEqual([]);

    const secondPage = pageFixture({
      pageFacts: observed,
      download: downloadFixture({ payload })
    });
    const secondProvider = makeProvider(parent, secondPage, { maxBytes: payload.byteLength + 1 });
    const complete = await secondProvider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const chunks = await collect(complete);
    expect(chunks.every(chunk => chunk.byteLength <= 64 * 1024)).toBe(true);
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(payload);
    expect(await readdir(parent)).toEqual([]);
  });

  it.each([
    ["wrong digest", { sourceIdentityDigest: digest("wrong", "identity") }],
    ["wrong kind", { sourceIdentityDigest: artifactIdentityDigest(facts()), kind: "image" as const }],
    ["wrong ordinal", { sourceIdentityDigest: artifactIdentityDigest(facts()), ordinal: 1 }]
  ])("rejects %s before arming a download or clicking", async (_label, overrides) => {
    const parent = await root("identity");
    const page = pageFixture();
    const provider = makeProvider(parent, page);
    await expect(provider.openSource(request(overrides))).rejects.toThrow("source is unavailable");
    expect(page.waitForEventCalls).toBe(0);
    expect(page.clickCalls).toBe(0);
    expect(page.evaluateCalls).toBe(1);
  });

  it("rejects a stale/preexisting download event without treating it as causal", async () => {
    const parent = await root("stale");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed, staleDownload: true });
    const provider = makeProvider(parent, page);
    await expect(provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }))).rejects.toThrow("source is unavailable");
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(0);
    expect(await readdir(parent)).toEqual([]);
  });

  it("does not retry a false/mutated click even when a download event is possible", async () => {
    const parent = await root("false-click");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed, clickResult: false, releaseOnFalse: true });
    const provider = makeProvider(parent, page, { timeoutMs: 30 });
    await expect(provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }))).rejects.toThrow("source is unavailable");
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(1);
    expect(page.evaluateCalls).toBe(2);
    expect(await readdir(parent)).toEqual([]);
  });

  it("settles a never-delivered download at the bounded blocker with one waiter, one click, and no temp residue", async () => {
    const parent = await root("never-download");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed, neverDownload: true });
    const provider = makeProvider(parent, page, { timeoutMs: 20 });
    await expect(provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }))).rejects.toThrow("source is unavailable");
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(1);
    expect(await readdir(parent)).toEqual([]);
  });

  it("holds a never-settling click evaluation until its late rejection and never retries", async () => {
    const parent = await root("never-click-evaluate");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed, neverClickEvaluate: true });
    const provider = makeProvider(parent, page, { timeoutMs: 5 });
    const pending = provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(page.clickCalls).toBe(1);
    expect(page.events).toEqual(["waitForEvent", "click"]);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    page.releaseClickEvaluate?.();
    await expect(pending).rejects.toThrow("source is unavailable");
    expect(page.waitForEventCalls).toBe(1);
    expect(page.evaluateCalls).toBe(2);
    expect(await readdir(parent)).toEqual([]);
  });

  it("reconciles a download delivered before late click rejection through the original waiter", async () => {
    const parent = await root("late-click-download");
    const observed = facts();
    const download = downloadFixture();
    const page = pageFixture({ pageFacts: observed, neverClickEvaluate: true, download });
    const provider = makeProvider(parent, page, { timeoutMs: 5 });
    const pending = provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(page.clickCalls).toBe(1);
    page.releaseDownload?.(download);
    // The waiter may already be fulfilled, but the mutation promise still
    // owns the actor until its bridge settlement is authoritative.
    page.releaseClickEvaluate?.();
    const source = await pending;
    expect(Buffer.concat((await collect(source)).map(chunk => Buffer.from(chunk)))).toEqual(PAYLOAD);
    expect(page.waitForEventCalls).toBe(1);
    expect(page.evaluateCalls).toBe(2);
    expect(await readdir(parent)).toEqual([]);
  });

  it("reconciles a click that rejects after delivering its download, without retrying", async () => {
    const parent = await root("click-throw");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed, clickRejects: true });
    const provider = makeProvider(parent, page);
    const source = await provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    expect(Buffer.concat((await collect(source)).map(chunk => Buffer.from(chunk)))).toEqual(PAYLOAD);
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(1);
    expect(await readdir(parent)).toEqual([]);
  });

  it("does not retry when download materialization rejects and cleans every temporary outcome", async () => {
    const parent = await root("download-reject");
    const observed = facts();
    const onSaveAs = vi.fn();
    const page = pageFixture({
      pageFacts: observed,
      download: downloadFixture({ saveAsRejects: true, onSaveAs })
    });
    const provider = makeProvider(parent, page);
    await expect(provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }))).rejects.toThrow("source is unavailable");
    expect(page.waitForEventCalls).toBe(1);
    expect(page.clickCalls).toBe(1);
    expect(onSaveAs).not.toHaveBeenCalled();
    expect(await readdir(parent)).toEqual([]);
  });

  it("bounds a never-settling createReadStream call without creating local residue", async () => {
    vi.useFakeTimers();
    try {
      const parent = await root("never-stream-call");
      const observed = facts();
      const download: DownloadLike = {
        createReadStream: async () => await new Promise<AsyncIterable<Uint8Array>>(() => undefined)
      };
      const page = pageFixture({ pageFacts: observed, download });
      const provider = makeProvider(parent, page, { timeoutMs: 5 });
      const acquired = await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
      const pending = provider.materializeDownload(acquired);
      const settled = pending.then(() => "resolved", () => "rejected");
      await vi.advanceTimersByTimeAsync(5);
      expect(await settled).toBe("rejected");
      expect(await readdir(parent)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a never-settling provider iterator and observes one cleanup attempt", async () => {
    vi.useFakeTimers();
    try {
      const parent = await root("never-stream-next");
      const observed = facts();
      let nextCalls = 0;
      let returnCalls = 0;
      const download: DownloadLike = {
        createReadStream: async () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async (): Promise<IteratorResult<Uint8Array>> => {
                nextCalls += 1;
                return await new Promise<IteratorResult<Uint8Array>>(() => undefined);
              },
              return: async (): Promise<IteratorResult<Uint8Array>> => {
                returnCalls += 1;
                return { done: true, value: undefined };
              }
            };
          }
        })
      };
      const page = pageFixture({ pageFacts: observed, download });
      const provider = makeProvider(parent, page, { timeoutMs: 5 });
      const acquired = await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
      const source = await provider.materializeDownload(acquired);
      const pending = source[Symbol.asyncIterator]().next();
      const settled = pending.then(() => "resolved", () => "rejected");
      await vi.advanceTimersByTimeAsync(5);
      expect(await settled).toBe("rejected");
      expect(nextCalls).toBe(1);
      expect(returnCalls).toBe(1);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports a path-only download in the local phase", async () => {
    const parent = await root("path-fallback");
    const sourcePath = join(parent, "browser-owned-source.bin");
    await writeFile(sourcePath, PAYLOAD);
    const observed = facts();
    const page = pageFixture({ pageFacts: observed, download: pathOnlyDownload(sourcePath) });
    const provider = makeProvider(parent, page);
    const acquired = await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    const source = await provider.materializeDownload(acquired);
    expect(Buffer.concat((await collect(source)).map(chunk => Buffer.from(chunk)))).toEqual(PAYLOAD);
    expect(await readdir(parent)).toEqual(["browser-owned-source.bin"]);
  });

  const assertInvalidPathCleanup = async (
    setup: (parent: string) => Promise<{ path: string; remaining: string[] }>
  ) => {
    const parent = await root("path-invalid");
    const configured = await setup(parent);
    const observed = facts();
    const page = pageFixture({ pageFacts: observed, download: pathOnlyDownload(configured.path) });
    const provider = makeProvider(parent, page);
    const acquired = await provider.acquireDownload(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    await expect(provider.materializeDownload(acquired)).rejects.toThrow("source is unavailable");
    expect((await readdir(parent)).sort()).toEqual(configured.remaining.sort());
  };

  it.skipIf(process.platform === "win32")("fails closed for a symlink path and still cleans the provider temp directory", async () => {
    await assertInvalidPathCleanup(async parent => {
      const target = join(parent, "real-source.bin");
      const link = join(parent, "linked-source.bin");
      await writeFile(target, PAYLOAD);
      await symlink(target, link);
      return { path: link, remaining: ["linked-source.bin", "real-source.bin"] };
    });
  });

  it("fails closed for a non-file path and still cleans the provider temp directory", async () => {
    await assertInvalidPathCleanup(async parent => {
      const directory = join(parent, "source-directory");
      await mkdir(directory);
      return { path: directory, remaining: ["source-directory"] };
    });
  });

  it("snapshots options and request fields before caller mutation", async () => {
    const parent = await root("snapshot");
    const observed = facts();
    const page = pageFixture({ pageFacts: observed });
    const mutableOptions: ProductionChatGPTArtifactsOptions = {
      page,
      evidenceDigest: digest,
      tempDirectory: parent,
      timeoutMs: 200
    };
    const provider = createProductionChatGPTArtifacts(mutableOptions);
    const mutableRequest = request({ sourceIdentityDigest: artifactIdentityDigest(observed) });
    (mutableOptions as { tempDirectory?: string }).tempDirectory = "/private/attacker/path";
    const pending = provider.openSource(mutableRequest);
    (mutableRequest as { sourceIdentityDigest: string }).sourceIdentityDigest = digest("wrong", "after-call");
    const source = await pending;
    expect(Buffer.concat((await collect(source)).map(chunk => Buffer.from(chunk)))).toEqual(PAYLOAD);
    expect(await readdir(parent)).toEqual([]);
  });

  it("awaits a hanging click to settlement instead of releasing the actor on a timeout race", async () => {
    const parent = await root("settlement");
    const observed = facts();
    let releaseClick!: () => void;
    const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
    const page = pageFixture({ pageFacts: observed, clickGate });
    const provider = makeProvider(parent, page, { timeoutMs: 20 });
    const pending = provider.openSource(request({ sourceIdentityDigest: artifactIdentityDigest(observed) }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(page.clickCalls).toBe(1);
    releaseClick();
    const source = await pending;
    expect(Buffer.concat((await collect(source)).map(chunk => Buffer.from(chunk)))).toEqual(PAYLOAD);
    expect(await readdir(parent)).toEqual([]);
  });

  it("fails closed on unknown and accessor-backed construction graphs without invoking accessors", () => {
    expect(() => createProductionChatGPTArtifacts({
      evidenceDigest: digest,
      unexpected: true
    } as unknown as ProductionChatGPTArtifactsOptions)).toThrow("source is unavailable");
    let getterCalls = 0;
    const hostile = {
      evidenceDigest: digest,
      get tempDirectory(): string {
        getterCalls += 1;
        throw new Error("secret getter invoked");
      }
    } as unknown as ProductionChatGPTArtifactsOptions;
    expect(() => createProductionChatGPTArtifacts(hostile)).toThrow("source is unavailable");
    expect(getterCalls).toBe(0);
  });
});
