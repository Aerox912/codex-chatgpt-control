import { describe, expect, it } from "vitest";
import {
  RuntimeEnvSession,
  RuntimeEnvSessionError,
  createRuntimeEnvSession
} from "../../src/runtime/runtime-session.js";

type BrowserMarker = { readonly browser: string };
type PageMarker = { readonly page: string };

const browserA = { browser: "a" } as BrowserMarker;
const browserB = { browser: "b" } as BrowserMarker;
const pageA = { page: "a" } as PageMarker;
const pageB = { page: "b" } as PageMarker;
const pageC = { page: "c" } as PageMarker;

function session(options: Record<string, unknown> = {}): RuntimeEnvSession {
  return createRuntimeEnvSession(options as never);
}

function expectSessionError(action: () => unknown, code: RuntimeEnvSessionError["code"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeEnvSessionError);
  expect((caught as RuntimeEnvSessionError).code).toBe(code);
}

describe("RuntimeEnvSession", () => {
  it("creates distinct invocation environments and isolates uncommitted writes", () => {
    const runtime = session({ browser: browserA as never, page: pageA as never, expectedTabId: "tab-a" });
    const first = runtime.capture();
    const second = runtime.capture();

    expect(first.env).not.toBe(second.env);
    expect(first.env.page).toBe(pageA);
    expect(second.env.page).toBe(pageA);
    first.env.page = pageB as never;
    first.env.expectedTabId = "tab-b";

    expect(second.env.page).toBe(pageA);
    expect(second.env.expectedTabId).toBe("tab-a");
    expect(runtime.diagnostics()).toMatchObject({ revision: 0, captures: 2, openCaptures: 2 });

    first.abandon();
    second.abandon();
  });

  it("keeps provider/base fields immutable while allowing snapshot fields to change", () => {
    const agent = { provider: "agent" };
    const clipboard = { read: async () => "", waitForChange: async () => undefined };
    const now = () => new Date(0);
    const runtime = session({ agent, clipboard, now, page: pageA as never });
    const capture = runtime.capture();

    expect(capture.env.agent).toBe(agent);
    expect(capture.env.clipboard).toBe(clipboard);
    expect(capture.env.now).toBe(now);
    expect(Reflect.set(capture.env, "agent", { provider: "other" })).toBe(false);
    expect(Reflect.set(capture.env, "clipboard", undefined)).toBe(false);
    expect(Reflect.set(capture.env, "now", undefined)).toBe(false);
    expect(() => {
      capture.env.page = pageB as never;
    }).not.toThrow();
    expect(capture.env.page).toBe(pageB);
    capture.abandon();
  });

  it("commits browser, page, and expected tab as one snapshot update", () => {
    const runtime = session({ browser: browserA as never, page: pageA as never, expectedTabId: "tab-a" });
    const capture = runtime.capture();
    capture.env.browser = browserB as never;
    capture.env.page = pageB as never;
    capture.env.expectedTabId = "tab-b";

    expect(capture.commit()).toEqual({
      revision: 1,
      changedFields: ["browser", "page", "expectedTabId"],
      appliedFields: ["browser", "page", "expectedTabId"],
      converged: false
    });
    const next = runtime.capture();
    expect(next.env.browser).toBe(browserB);
    expect(next.env.page).toBe(pageB);
    expect(next.env.expectedTabId).toBe("tab-b");
    next.abandon();
  });

  it("accepts stale same-value convergence without another revision", () => {
    const runtime = session({ page: pageA as never });
    const first = runtime.capture();
    const second = runtime.capture();
    first.env.page = pageB as never;
    second.env.page = pageB as never;
    expect(first.commit().revision).toBe(1);

    expect(second.commit()).toEqual({
      revision: 1,
      changedFields: ["page"],
      appliedFields: [],
      converged: true
    });
    expect(runtime.revision).toBe(1);
  });

  it.each([
    ["browser", browserB as never],
    ["page", pageB as never],
    ["expectedTabId", "tab-b"]
  ] as const)("rejects stale conflicting %s writes", (field, value) => {
    const runtime = session({ browser: browserA as never, page: pageA as never, expectedTabId: "tab-a" });
    const first = runtime.capture();
    const second = runtime.capture();
    const third = runtime.capture();
    if (field === "browser") first.env.browser = value as never;
    else if (field === "page") first.env.page = value as never;
    else first.env.expectedTabId = value;
    expect(first.commit().revision).toBe(1);
    if (field === "browser") second.env.browser = browserC() as never;
    else if (field === "page") second.env.page = pageC as never;
    else second.env.expectedTabId = "tab-c";
    expectSessionError(() => second.commit(), "commit_conflict");
    expect(runtime.revision).toBe(1);
    third.abandon();
  });

  it("accepts a stale read-only commit without clobbering newer state", () => {
    const runtime = session({ page: pageA as never });
    const readOnly = runtime.capture();
    const writer = runtime.capture();
    writer.env.page = pageB as never;
    writer.commit();

    expect(readOnly.commit()).toEqual({
      revision: 1,
      changedFields: [],
      appliedFields: [],
      converged: false
    });
    const next = runtime.capture();
    expect(next.env.page).toBe(pageB);
    next.abandon();
  });

  it("consumes captures exactly once and reports lifecycle safely", () => {
    const runtime = session();
    const commit = runtime.capture();
    expect(commit.diagnostics()).toEqual({ status: "open", revision: 0 });
    commit.commit();
    expect(commit.diagnostics()).toEqual({ status: "committed", revision: 0 });
    expectSessionError(() => commit.commit(), "capture_closed");
    expectSessionError(() => commit.abandon(), "capture_closed");

    const abandon = runtime.capture();
    abandon.abandon();
    expect(abandon.diagnostics()).toEqual({ status: "abandoned", revision: 0 });
    expectSessionError(() => abandon.commit(), "capture_closed");
    expectSessionError(() => abandon.abandon(), "capture_closed");
    expect(runtime.diagnostics()).toMatchObject({ captures: 2, openCaptures: 0 });
  });

  it("does not publish a callback's half-established state when run fails", async () => {
    const runtime = session({ page: pageA as never });
    const failure = new Error("caller failure with private details");
    await expect(runtime.run(async (env) => {
      env.page = pageB as never;
      throw failure;
    })).rejects.toBe(failure);

    const next = runtime.capture();
    expect(next.env.page).toBe(pageA);
    next.abandon();
    expect(runtime.diagnostics()).toMatchObject({ revision: 0, captures: 2, openCaptures: 0 });
  });

  it("commits run's snapshot after a successful callback", async () => {
    const runtime = session({ page: pageA as never });
    await expect(runtime.run(async (env) => {
      env.page = pageB as never;
      env.expectedTabId = "tab-b";
      return "done";
    })).resolves.toBe("done");

    const next = runtime.capture();
    expect(next.env.page).toBe(pageB);
    expect(next.env.expectedTabId).toBe("tab-b");
    next.abandon();
  });

  it("does not reject a completed callback when a newer invocation wins the snapshot race", async () => {
    const runtime = session({ page: pageA as never });
    const releaseOlder = deferred<void>();
    const olderStarted = deferred<void>();

    const older = runtime.run(async env => {
      env.page = pageB as never;
      olderStarted.resolve();
      await releaseOlder.promise;
      return "older-completed";
    });
    await olderStarted.promise;
    await runtime.run(async env => {
      env.page = pageC as never;
      return "newer-completed";
    });
    releaseOlder.resolve();

    await expect(older).resolves.toBe("older-completed");
    const next = runtime.capture();
    expect(next.env.page).toBe(pageC);
    next.abandon();
  });

  it("rejects accessor options without reading their values", () => {
    let reads = 0;
    const options = {};
    Object.defineProperty(options, "page", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("must not run");
      }
    });
    expectSessionError(() => new RuntimeEnvSession(options), "invalid_options");
    expect(reads).toBe(0);
  });

  it("does not invoke a proxy get trap or stringify hostile values", () => {
    let gets = 0;
    const page = new Proxy(pageC, {
      get: () => {
        gets += 1;
        throw new Error("must not run");
      }
    });
    const runtime = new RuntimeEnvSession({ page: page as never });
    expect(runtime.diagnostics().snapshot.page).toBe("set");
    const capture = runtime.capture();
    capture.env.page = pageA as never;
    capture.commit();
    expect(gets).toBe(0);

    const options = { expectedTabId: {} };
    let caught: unknown;
    try {
      new RuntimeEnvSession(options as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeEnvSessionError);
    expect((caught as Error).message).toBe("RuntimeEnvSession options are invalid.");
    expect((caught as Error).message).not.toContain("[object Object]");
  });

  it("freezes diagnostics and never exposes snapshot objects", () => {
    const runtime = session({ browser: browserA as never, page: pageA as never, expectedTabId: "secret-tab" });
    const diagnostics = runtime.diagnostics();
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.base)).toBe(true);
    expect(Object.isFrozen(diagnostics.snapshot)).toBe(true);
    expect(diagnostics.snapshot).toEqual({
      browser: "set",
      browserKind: "unset",
      page: "set",
      expectedTabId: "set"
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret-tab");
    expect(JSON.stringify(diagnostics)).not.toContain('"browser":{');
  });
});

function browserC(): BrowserMarker {
  return { browser: "c" };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}
