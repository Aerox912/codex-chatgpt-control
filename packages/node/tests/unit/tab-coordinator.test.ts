import { describe, expect, it } from "vitest";
import {
  CoordinatorAbortedError,
  CoordinatorDeadlineExceededError,
  CoordinatorQueueFullError,
  InvalidCoordinatorRequestError,
  InvalidResourceKeyError,
  ProcessTabCoordinator,
  ReentrantAcquisitionError,
  createBrowserResourceKey,
  createTabResourceKey,
  getProcessTabCoordinator
} from "../../src/runtime/tab-coordinator.js";

const owner = (backendSessionId: string, operationId?: string) => ({
  backendSessionId,
  ...(operationId === undefined ? {} : { operationId })
});

const waitForTurn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("ProcessTabCoordinator resource identity", () => {
  it("shares one default coordinator across client and service callers in the process", () => {
    expect(getProcessTabCoordinator()).toBe(getProcessTabCoordinator());
  });

  it("rejects empty and unknown provider, browser, and tab identities", () => {
    expect(() => createBrowserResourceKey("", "browser")).toThrow(InvalidResourceKeyError);
    expect(() => createBrowserResourceKey("provider", "unknown")).toThrow(InvalidResourceKeyError);
    expect(() => createTabResourceKey("provider", "browser", " ")).toThrow(InvalidResourceKeyError);
    expect(() => createTabResourceKey("provider", "browser", "N/A")).toThrow(InvalidResourceKeyError);
  });

  it("creates stable opaque keys without delimiter collisions", () => {
    expect(createBrowserResourceKey("provider:x", "browser:y")).toBe(
      createBrowserResourceKey({ providerId: "provider:x", browserId: "browser:y" })
    );
    expect(createTabResourceKey("provider", "browser", "tab:1")).not.toBe(
      createTabResourceKey("provider", "browser", "tab:2")
    );
  });
});

describe("ProcessTabCoordinator scheduling", () => {
  const tabA = createTabResourceKey("chatgpt", "browser-1", "tab-a");
  const tabB = createTabResourceKey("chatgpt", "browser-1", "tab-b");

  it("excludes same-tab transactions while allowing different tabs to overlap", async () => {
    const coordinator = new ProcessTabCoordinator();
    const firstGate = deferred();
    const events: string[] = [];

    const first = coordinator.withTabTransaction(tabA, { owner: owner("session-a"), priority: "mutation" }, async () => {
      events.push("a:first:start");
      await firstGate.promise;
      events.push("a:first:end");
    });
    await waitForTurn();

    const sameTab = coordinator.withTabTransaction(tabA, { owner: owner("session-b"), priority: "read" }, async () => {
      events.push("a:same:start");
    });
    const differentTab = coordinator.withTabTransaction(tabB, { owner: owner("session-c"), priority: "read" }, async () => {
      events.push("b:start");
    });

    await waitForTurn();
    expect(events).toEqual(["a:first:start", "b:start"]);
    expect(coordinator.getTabDiagnostics(tabA).active).toBe(true);
    expect(coordinator.getTabDiagnostics(tabA).queueDepth).toBe(1);

    firstGate.resolve();
    await Promise.all([first, sameTab, differentTab]);
    expect(events).toEqual(["a:first:start", "b:start", "a:first:end", "a:same:start"]);
  });

  it("bounds read bursts so a waiting mutation is selected", async () => {
    const coordinator = new ProcessTabCoordinator({
      maxConsecutiveReads: 3,
      maxWaitMs: 60_000
    });
    const gate = deferred();
    const order: string[] = [];

    const blocker = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "read" }, async () => {
      order.push("blocker");
      await gate.promise;
    });
    await waitForTurn();

    const reads = Array.from({ length: 5 }, (_, index) => coordinator.withTabTransaction(
      tabA,
      { owner: owner("session"), priority: "read" },
      async () => { order.push(`read-${index}`); }
    ));
    const mutation = coordinator.withTabTransaction(
      tabA,
      { owner: owner("session"), priority: "mutation" },
      async () => { order.push("mutation"); }
    );

    gate.resolve();
    await Promise.all([blocker, mutation, ...reads]);
    expect(order.slice(0, 4)).toEqual(["blocker", "read-0", "read-1", "mutation"]);
  });

  it("lets controls cut through mutations but bounds a continuous control burst", async () => {
    const coordinator = new ProcessTabCoordinator({
      maxConsecutiveControls: 2,
      maxWaitMs: 60_000
    });
    const gate = deferred();
    const order: string[] = [];
    const blocker = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "mutation" }, async () => {
      await gate.promise;
      order.push("blocker");
    });
    await waitForTurn();

    const mutations = Array.from({ length: 4 }, (_, index) => coordinator.withTabTransaction(
      tabA,
      { owner: owner("session"), priority: "mutation" },
      async () => { order.push(`mutation-${index}`); }
    ));
    const controls = Array.from({ length: 3 }, (_, index) => coordinator.withTabTransaction(
      tabA,
      { owner: owner("session"), priority: "control" },
      async () => { order.push(`control-${index}`); }
    ));

    gate.resolve();
    await Promise.all([blocker, ...mutations, ...controls]);
    expect(order.slice(1, 5)).toEqual(["control-0", "control-1", "mutation-0", "control-2"]);
  });

  it("rejects a bounded queue without invoking the rejected callback", async () => {
    const coordinator = new ProcessTabCoordinator({ maxQueueSize: 1 });
    const gate = deferred();
    let invoked = false;
    const active = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "mutation" }, async () => {
      await gate.promise;
    });
    await waitForTurn();
    const queued = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "read" }, async () => {});
    const rejected = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "read" }, async () => {
      invoked = true;
    });
    await expect(rejected).rejects.toBeInstanceOf(CoordinatorQueueFullError);
    expect(invoked).toBe(false);
    expect(coordinator.getTabDiagnostics(tabA)).toMatchObject({
      queueDepth: 1,
      rejectedCount: 1,
      lastRejected: { outcome: "rejected", totalMs: expect.any(Number) }
    });
    gate.resolve();
    await Promise.all([active, queued]);
  });

  it("removes queued work on cancellation", async () => {
    const coordinator = new ProcessTabCoordinator();
    const gate = deferred();
    const active = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "mutation" }, async () => {
      await gate.promise;
    });
    await waitForTurn();
    const controller = new AbortController();
    let invoked = false;
    const queued = coordinator.withTabTransaction(
      tabA,
      { owner: owner("session"), signal: controller.signal },
      async () => { invoked = true; }
    );
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(CoordinatorAbortedError);
    expect(invoked).toBe(false);
    expect(coordinator.getTabDiagnostics(tabA)).toMatchObject({
      queueDepth: 0,
      rejectedCount: 1,
      lastRejected: { outcome: "rejected", queuedCancellation: true, totalMs: expect.any(Number) }
    });
    gate.resolve();
    await active;
  });

  it("removes queued work when its deadline expires", async () => {
    const coordinator = new ProcessTabCoordinator();
    const gate = deferred();
    const active = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "mutation" }, async () => {
      await gate.promise;
    });
    await waitForTurn();
    let invoked = false;
    const queued = coordinator.withTabTransaction(
      tabA,
      { owner: owner("session"), priority: "read", timeoutMs: 10 },
      async () => { invoked = true; }
    );
    await expect(queued).rejects.toBeInstanceOf(CoordinatorDeadlineExceededError);
    expect(invoked).toBe(false);
    expect(coordinator.getTabDiagnostics(tabA)).toMatchObject({
      queueDepth: 0,
      rejectedCount: 1,
      lastRejected: { outcome: "rejected", queuedDeadlineExceeded: true, totalMs: expect.any(Number) }
    });
    gate.resolve();
    await active;
  });

  it("rejects re-entry using the async context and explicit context token", async () => {
    const coordinator = new ProcessTabCoordinator();
    let context!: Parameters<NonNullable<Parameters<typeof coordinator.withTabTransaction>[2]>>[0];
    const nested = coordinator.withTabTransaction(tabA, { owner: owner("session"), priority: "mutation" }, async (current) => {
      context = current;
      await expect(
        coordinator.withTabTransaction(tabA, { owner: owner("session"), acquisitionContext: current }, async () => {})
      ).rejects.toBeInstanceOf(ReentrantAcquisitionError);
    });
    await expect(nested).resolves.toBeUndefined();
    expect(context.acquisitionToken).toMatch(/[0-9a-f-]{10,}/u);
  });

  it("rejects nested acquisition of a different actor before it can deadlock", async () => {
    const coordinator = new ProcessTabCoordinator();
    await coordinator.withTabTransaction(tabA, { owner: owner("session") }, async () => {
      await expect(
        coordinator.withTabTransaction(tabB, { owner: owner("session") }, async () => {})
      ).rejects.toBeInstanceOf(ReentrantAcquisitionError);
    });
  });

  it("rejects stale and forged explicit acquisition contexts", async () => {
    const coordinator = new ProcessTabCoordinator();
    let context!: Parameters<NonNullable<Parameters<typeof coordinator.withTabTransaction>[2]>>[0];
    await coordinator.withTabTransaction(tabA, { owner: owner("session") }, async (current) => {
      context = current;
    });

    await expect(
      coordinator.withTabTransaction(tabA, { owner: owner("session"), acquisitionContext: context }, async () => {})
    ).rejects.toBeInstanceOf(InvalidCoordinatorRequestError);
    await expect(
      coordinator.withTabTransaction(
        tabA,
        {
          owner: owner("session"),
          acquisitionContext: { ...context, acquisitionToken: "forged-token" }
        },
        async () => {}
      )
    ).rejects.toBeInstanceOf(InvalidCoordinatorRequestError);
  });

  it("rejects malformed resource keys even when their TypeScript brand is forged", async () => {
    const coordinator = new ProcessTabCoordinator();
    const forged = "tab:not-enough-parts" as typeof tabA;
    expect(() =>
      coordinator.withTabTransaction(forged, { owner: owner("session") }, async () => {})
    ).toThrow(InvalidResourceKeyError);
    const alternateEncoding = "tab:chatgpt:browser-1:%74ab-a" as typeof tabA;
    expect(() =>
      coordinator.withTabTransaction(alternateEncoding, { owner: owner("session") }, async () => {})
    ).toThrow(InvalidResourceKeyError);
  });

  it("returns detached timing diagnostics that cannot corrupt actor state", async () => {
    const coordinator = new ProcessTabCoordinator();
    let callbackTiming!: Parameters<NonNullable<Parameters<typeof coordinator.withTabTransaction>[2]>>[0]["timing"];
    await coordinator.withTabTransaction(tabA, { owner: owner("session") }, async (context) => {
      callbackTiming = context.timing;
      expect(Object.isFrozen(context.timing)).toBe(true);
      expect(Object.isFrozen(context.timing.owner)).toBe(true);
    });

    expect(() => {
      (callbackTiming as { enqueuedAt: number }).enqueuedAt = -1;
    }).toThrow(TypeError);
    const first = coordinator.getTabDiagnostics(tabA);
    expect(first.lastCompleted?.enqueuedAt).toBeGreaterThanOrEqual(0);
    if (first.lastCompleted !== undefined) {
      (first.lastCompleted as { enqueuedAt: number }).enqueuedAt = -2;
      (first.lastCompleted.owner as { backendSessionId: string }).backendSessionId = "tampered";
    }
    const second = coordinator.getTabDiagnostics(tabA);
    expect(second.lastCompleted?.enqueuedAt).toBeGreaterThanOrEqual(0);
    expect(second.lastCompleted?.owner.backendSessionId).toBe("session");
  });

  it("exposes cross-session ownership and queue timing diagnostics", async () => {
    const coordinator = new ProcessTabCoordinator();
    const gate = deferred();
    const first = coordinator.withTabTransaction(tabA, { owner: owner("session-a"), priority: "mutation" }, async () => {
      await gate.promise;
    });
    await waitForTurn();
    const second = coordinator.withTabTransaction(tabA, { owner: owner("session-b", "operation-2"), priority: "control" }, async (context) => {
      expect(context.owner.backendSessionId).toBe("session-b");
      expect(context.owner.operationId).toBe("operation-2");
    });
    const whileQueued = coordinator.getTabDiagnostics(tabA);
    expect(whileQueued.activeOwner?.backendSessionId).toBe("session-a");
    expect(whileQueued.queueDepth).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(coordinator.getTabDiagnostics(tabA).lastCompleted?.owner.backendSessionId).toBe("session-b");
    expect(coordinator.getTabDiagnostics(tabA).lastCompleted?.queueDelayMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps an actor occupied until an in-flight deadline callback settles", async () => {
    const coordinator = new ProcessTabCoordinator();
    const gate = deferred();
    const callbackStarted = deferred();
    const events: string[] = [];
    const first = coordinator.withTabTransaction(
      tabA,
      { owner: owner("session-a"), priority: "mutation", timeoutMs: 10 },
      async () => {
        events.push("first:start");
        callbackStarted.resolve();
        await gate.promise;
        events.push("first:settled");
      }
    ).catch((error: unknown) => error);
    await callbackStarted.promise;
    await sleep(25);
    const firstError = await first;
    expect(firstError).toBeInstanceOf(CoordinatorDeadlineExceededError);
    expect((firstError as CoordinatorDeadlineExceededError).phase).toBe("in_flight");
    expect(Object.isFrozen((firstError as CoordinatorDeadlineExceededError).diagnostics)).toBe(true);
    expect(() => {
      ((firstError as CoordinatorDeadlineExceededError).diagnostics as { enqueuedAt: number }).enqueuedAt = -1;
    }).toThrow(TypeError);
    expect(events).toEqual(["first:start"]);
    expect(coordinator.getTabDiagnostics(tabA).active).toBe(true);
    expect(coordinator.getTabDiagnostics(tabA).quarantinedUntilSettled?.deadlineExceededInFlight).toBe(true);

    const second = coordinator.withTabTransaction(tabA, { owner: owner("session-b"), priority: "control" }, async () => {
      events.push("second:start");
    });
    await sleep(5);
    expect(events).toEqual(["first:start"]);
    expect(coordinator.getTabDiagnostics(tabA).active).toBe(true);
    expect(coordinator.getTabDiagnostics(tabA).quarantinedUntilSettled?.deadlineExceededInFlight).toBe(true);

    gate.resolve();
    await second;
    expect(events).toEqual(["first:start", "first:settled", "second:start"]);
    expect(coordinator.getTabDiagnostics(tabA)).toMatchObject({
      active: false,
      completedCount: 1,
      rejectedCount: 1,
      lastRejected: { outcome: "rejected", deadlineExceededInFlight: true }
    });
  });

  it("keeps an actor occupied until an in-flight abort callback settles", async () => {
    const coordinator = new ProcessTabCoordinator();
    const gate = deferred();
    const started = deferred();
    const controller = new AbortController();
    const events: string[] = [];
    const first = coordinator.withTabTransaction(
      tabA,
      { owner: owner("session-a"), priority: "mutation", signal: controller.signal },
      async () => {
        events.push("first:start");
        started.resolve();
        await gate.promise;
        events.push("first:settled");
      }
    ).catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    const firstError = await first;
    expect(firstError).toBeInstanceOf(CoordinatorAbortedError);
    expect((firstError as CoordinatorAbortedError).phase).toBe("in_flight");
    expect(events).toEqual(["first:start"]);
    expect(coordinator.getTabDiagnostics(tabA).active).toBe(true);

    const second = coordinator.withTabTransaction(tabA, { owner: owner("session-b"), priority: "control" }, async () => {
      events.push("second:start");
    });
    await waitForTurn();
    expect(events).toEqual(["first:start"]);
    expect(coordinator.getTabDiagnostics(tabA).active).toBe(true);
    gate.resolve();
    await second;
    expect(events).toEqual(["first:start", "first:settled", "second:start"]);
  });

  it("reclaims idle actor and gate entries while retaining bounded diagnostics", async () => {
    const coordinator = new ProcessTabCoordinator({ maxIdleDiagnostics: 2 });
    const internals = coordinator as unknown as {
      tabActors: Map<string, unknown>;
      browserActors: Map<string, unknown>;
      browserGates: Map<string, unknown>;
      idleDiagnostics: Map<string, unknown>;
    };
    const keys = Array.from({ length: 5 }, (_, index) => createTabResourceKey(
      "chatgpt",
      `browser-${index}`,
      `tab-${index}`
    ));

    for (const [index, key] of keys.entries()) {
      await coordinator.withTabTransaction(key, { owner: owner(`session-${index}`) }, async () => {});
    }

    expect(internals.tabActors.size).toBe(0);
    expect(internals.browserActors.size).toBe(0);
    expect(internals.browserGates.size).toBe(0);
    expect(internals.idleDiagnostics.size).toBe(2);
    expect(coordinator.getTabDiagnostics(keys.at(-1)!)).toMatchObject({
      completedCount: 1,
      lastCompleted: { outcome: "fulfilled" }
    });
    const evicted = coordinator.getTabDiagnostics(keys[0]!);
    expect(evicted.completedCount).toBe(0);
    expect(evicted.lastCompleted).toBeUndefined();
  });

  it("keeps actor and parent gate registries through active work", async () => {
    const coordinator = new ProcessTabCoordinator();
    const internals = coordinator as unknown as {
      tabActors: Map<string, unknown>;
      browserGates: Map<string, unknown>;
    };
    const gate = deferred();
    const started = deferred();
    const key = createTabResourceKey("chatgpt", "browser-active", "tab-active");
    const pending = coordinator.withTabTransaction(key, { owner: owner("session") }, async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    expect(internals.tabActors.has(key)).toBe(true);
    expect(internals.browserGates.has(createBrowserResourceKey("chatgpt", "browser-active"))).toBe(true);

    gate.resolve();
    await pending;
    expect(internals.tabActors.has(key)).toBe(false);
    expect(internals.browserGates.has(createBrowserResourceKey("chatgpt", "browser-active"))).toBe(false);
  });

  it("does not replace a gate while same-tab work is queued behind an active turn", async () => {
    const coordinator = new ProcessTabCoordinator();
    const internals = coordinator as unknown as {
      browserGates: Map<string, unknown>;
    };
    const browser = createBrowserResourceKey("chatgpt", "browser-queued");
    const key = createTabResourceKey("chatgpt", "browser-queued", "tab-queued");
    const firstGate = deferred();
    const firstStarted = deferred();
    const first = coordinator.withTabTransaction(key, { owner: owner("session-a") }, async () => {
      firstStarted.resolve();
      await firstGate.promise;
    });
    await firstStarted.promise;
    const originalGate = internals.browserGates.get(browser);
    expect(originalGate).toBeDefined();

    const second = coordinator.withTabTransaction(key, { owner: owner("session-b") }, async () => {
      expect(internals.browserGates.get(browser)).toBe(originalGate);
    });
    await waitForTurn();
    expect(coordinator.getTabDiagnostics(key).browserGate).toMatchObject({
      activeSharedCount: 1,
      queuedSharedCount: 1
    });

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(internals.browserGates.has(browser)).toBe(false);
  });

  it("bounds accepted parent-gate reservations across distinct tab actors", async () => {
    const coordinator = new ProcessTabCoordinator({ maxQueueSize: 2 });
    const browser = createBrowserResourceKey("chatgpt", "browser-bounded");
    const release = deferred();
    const first = coordinator.withTabTransaction(
      createTabResourceKey("chatgpt", "browser-bounded", "tab-1"),
      { owner: owner("session-1") },
      async () => { await release.promise; }
    );
    const second = coordinator.withTabTransaction(
      createTabResourceKey("chatgpt", "browser-bounded", "tab-2"),
      { owner: owner("session-2") },
      async () => { await release.promise; }
    );
    const rejected = coordinator.withTabTransaction(
      createTabResourceKey("chatgpt", "browser-bounded", "tab-3"),
      { owner: owner("session-3") },
      async () => { throw new Error("must not run"); }
    );

    await expect(rejected).rejects.toBeInstanceOf(CoordinatorQueueFullError);
    expect(coordinator.getBrowserDiagnostics(browser).browserGate).toMatchObject({
      queueDepth: 0,
      activeSharedCount: 2,
      rejectedCount: 1
    });
    release.resolve();
    await Promise.all([first, second]);
  });
});

describe("ProcessTabCoordinator browser acquisition", () => {
  const tabA = createTabResourceKey("chatgpt", "browser-1", "tab-a");
  const tabB = createTabResourceKey("chatgpt", "browser-1", "tab-b");

  it("serializes acquisition per browser identity", async () => {
    const coordinator = new ProcessTabCoordinator();
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const gate = deferred();
    const events: string[] = [];
    const first = coordinator.withBrowserAcquisition(browser, { owner: owner("session-a"), priority: "mutation" }, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    await waitForTurn();
    const second = coordinator.withBrowserAcquisition(browser, { owner: owner("session-b"), priority: "mutation" }, async () => {
      events.push("second:start");
    });
    await waitForTurn();
    expect(events).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("excludes browser acquisitions from tab leases for the same provider and browser", async () => {
    const coordinator = new ProcessTabCoordinator();
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const tabGate = deferred();
    const browserGate = deferred();
    const events: string[] = [];

    const firstTab = coordinator.withTabTransaction(
      tabA,
      { owner: owner("session-a"), priority: "read" },
      async () => {
        events.push("tab:first:start");
        await tabGate.promise;
        events.push("tab:first:end");
      }
    );
    await waitForTurn();

    const exclusive = coordinator.withBrowserAcquisition(
      browser,
      { owner: owner("session-b"), priority: "control" },
      async () => {
        events.push("browser:start");
        await browserGate.promise;
        events.push("browser:end");
      }
    );
    const secondTab = coordinator.withTabTransaction(
      tabB,
      { owner: owner("session-c"), priority: "read" },
      async () => { events.push("tab:second:start"); }
    );
    await waitForTurn();
    expect(events).toEqual(["tab:first:start"]);

    tabGate.resolve();
    await waitForTurn();
    expect(events).toEqual(["tab:first:start", "tab:first:end", "browser:start"]);

    browserGate.resolve();
    await Promise.all([firstTab, exclusive, secondTab]);
    expect(events).toEqual([
      "tab:first:start",
      "tab:first:end",
      "browser:start",
      "browser:end",
      "tab:second:start"
    ]);
    expect(coordinator.getBrowserDiagnostics(browser).lastCompleted).toMatchObject({
      admissionDelayMs: expect.any(Number),
      executionMs: expect.any(Number)
    });
  });

  it("gives a queued browser waiter the next turn before new tab readers", async () => {
    const coordinator = new ProcessTabCoordinator();
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const firstTabGate = deferred();
    const browserGate = deferred();
    const events: string[] = [];

    const firstTab = coordinator.withTabTransaction(tabA, { owner: owner("session-a") }, async () => {
      events.push("tab:first");
      await firstTabGate.promise;
    });
    await waitForTurn();
    const exclusive = coordinator.withBrowserAcquisition(browser, { owner: owner("session-b"), priority: "control" }, async () => {
      events.push("browser");
      await browserGate.promise;
    });
    const secondTab = coordinator.withTabTransaction(tabB, { owner: owner("session-c") }, async () => {
      events.push("tab:second");
    });
    firstTabGate.resolve();
    await waitForTurn();
    expect(events).toEqual(["tab:first", "browser"]);
    browserGate.resolve();
    await Promise.all([firstTab, exclusive, secondTab]);
    expect(events).toEqual(["tab:first", "browser", "tab:second"]);
  });

  it("exposes parent browser-gate occupancy and queued exclusive diagnostics", async () => {
    const coordinator = new ProcessTabCoordinator();
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const tabGate = deferred();
    const browserGate = deferred();
    const activeTab = coordinator.withTabTransaction(tabA, { owner: owner("session-a") }, async () => {
      await tabGate.promise;
    });
    await waitForTurn();

    const browserRequest = coordinator.withBrowserAcquisition(browser, { owner: owner("session-b") }, async () => {
      await browserGate.promise;
    });
    await waitForTurn();

    expect(coordinator.getTabDiagnostics(tabA).browserGate).toMatchObject({
      resourceKind: "browser",
      resourceKey: browser,
      active: true,
      activeSharedCount: 1,
      queuedExclusiveCount: 1,
      queuedSharedCount: 0
    });
    expect(coordinator.getBrowserDiagnostics(browser).browserGate).toMatchObject({
      active: true,
      activeSharedCount: 1,
      queuedExclusiveCount: 1
    });

    tabGate.resolve();
    await waitForTurn();
    expect(coordinator.getBrowserDiagnostics(browser).browserGate).toMatchObject({
      activeExclusiveRequestId: expect.any(String),
      activeExclusiveOwner: { backendSessionId: "session-b" },
      activeSharedCount: 0
    });
    browserGate.resolve();
    await Promise.all([activeTab, browserRequest]);
  });

  it("bounds browser-exclusive preference so shared turns cannot starve", async () => {
    const coordinator = new ProcessTabCoordinator({ maxConsecutiveBrowserExclusives: 2 });
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const firstGate = deferred();
    const events: string[] = [];
    const first = coordinator.withBrowserAcquisition(browser, { owner: owner("session-1") }, async () => {
      events.push("browser-1");
      await firstGate.promise;
    });
    await waitForTurn();

    const second = coordinator.withBrowserAcquisition(browser, { owner: owner("session-2") }, async () => {
      events.push("browser-2");
    });
    const third = coordinator.withBrowserAcquisition(browser, { owner: owner("session-3") }, async () => {
      events.push("browser-3");
    });
    const shared = coordinator.withTabTransaction(tabA, { owner: owner("session-tab") }, async () => {
      events.push("tab");
    });

    firstGate.resolve();
    await Promise.all([first, second, third, shared]);
    expect(events).toEqual(["browser-1", "browser-2", "tab", "browser-3"]);
  });

  it("cancels a browser waiter blocked behind a tab without leaking the gate lease", async () => {
    const coordinator = new ProcessTabCoordinator();
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const tabGate = deferred();
    const controller = new AbortController();
    let browserInvoked = false;
    const activeTab = coordinator.withTabTransaction(tabA, { owner: owner("session-a") }, async () => {
      await tabGate.promise;
    });
    await waitForTurn();
    const blockedBrowser = coordinator.withBrowserAcquisition(
      browser,
      { owner: owner("session-b"), signal: controller.signal },
      async () => { browserInvoked = true; }
    );
    controller.abort();
    await expect(blockedBrowser).rejects.toBeInstanceOf(CoordinatorAbortedError);
    expect(browserInvoked).toBe(false);

    tabGate.resolve();
    await activeTab;
    await coordinator.withTabTransaction(tabB, { owner: owner("session-c") }, async () => {});
    expect(coordinator.getBrowserDiagnostics(browser).active).toBe(false);
  });

  it("expires a browser waiter at the hierarchical gate deadline", async () => {
    const coordinator = new ProcessTabCoordinator();
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const tabGate = deferred();
    let browserInvoked = false;
    const activeTab = coordinator.withTabTransaction(tabA, { owner: owner("session-a") }, async () => {
      await tabGate.promise;
    });
    await waitForTurn();
    const blockedBrowser = coordinator.withBrowserAcquisition(
      browser,
      { owner: owner("session-b"), timeoutMs: 10 },
      async () => { browserInvoked = true; }
    );
    await expect(blockedBrowser).rejects.toBeInstanceOf(CoordinatorDeadlineExceededError);
    expect(browserInvoked).toBe(false);
    tabGate.resolve();
    await activeTab;
    await coordinator.withTabTransaction(tabB, { owner: owner("session-c") }, async () => {});
    expect(coordinator.getBrowserDiagnostics(browser).active).toBe(false);
  });

  it("releases an exclusive browser lease when its callback throws", async () => {
    const coordinator = new ProcessTabCoordinator();
    const browser = createBrowserResourceKey("chatgpt", "browser-1");
    const failure = new Error("browser callback failed");
    const failed = coordinator.withBrowserAcquisition(browser, { owner: owner("session-a") }, async () => {
      throw failure;
    });
    await expect(failed).rejects.toBe(failure);
    await expect(
      coordinator.withTabTransaction(tabA, { owner: owner("session-b") }, async () => "after-failure")
    ).resolves.toBe("after-failure");
  });
});
