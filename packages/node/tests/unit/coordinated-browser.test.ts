import { describe, expect, it } from "vitest";
import type { BrowserLike, PageLike } from "../../src/types.js";
import {
  MAX_BROWSER_TAB_CANDIDATES,
  coordinateRuntimeEnv,
  createCoordinatedBrowser,
  createCoordinatedPageForBrowser,
  unwrapCoordinatedBrowser
} from "../../src/runtime/coordinated-browser.js";
import { createCoordinatedPage, unwrapCoordinatedPage } from "../../src/runtime/coordinated-page.js";
import { ProcessTabCoordinator } from "../../src/runtime/tab-coordinator.js";

const waitForTurn = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
};

const owner = (id: string) => ({ backendSessionId: "session", ownerId: id });

describe("coordinated browser runtime facade", () => {
  it("serializes browser methods across separate clients sharing one browser", async () => {
    const gate = deferred();
    const events: string[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      tabs: {
        selected: async () => {
          events.push("selected:start");
          await gate.promise;
          events.push("selected:end");
          return { id: "tab-a" };
        }
      }
    };
    const coordinator = new ProcessTabCoordinator();
    const first = createCoordinatedBrowser(browser, { coordinator, owner: owner("client-a") });
    const second = createCoordinatedBrowser(browser, { coordinator, owner: owner("client-b") });
    expect(unwrapCoordinatedBrowser(first)).toBe(browser);
    const firstCall = first.tabs!.selected!();
    await waitForTurn();
    const secondCall = second.tabs!.selected!();
    await waitForTurn();
    expect(events).toEqual(["selected:start"]);
    gate.resolve();
    await Promise.all([firstCall, secondCall]);
    expect(events).toEqual(["selected:start", "selected:end", "selected:start", "selected:end"]);
  });

  it("orders browser acquisition against page DOM calls on the same conservative resource", async () => {
    const browserGate = deferred();
    const pageGate = deferred();
    const events: string[] = [];
    const rawPage: PageLike = {
      url: async () => {
        events.push("page:url");
        return "https://chatgpt.com/";
      },
      evaluate: async <T>() => {
        events.push("page:evaluate:start");
        await pageGate.promise;
        events.push("page:evaluate:end");
        return "ok" as T;
      }
    };
    const browser: BrowserLike = {
      name: "chrome",
      tabs: { selected: async () => {
        events.push("browser:selected:start");
        await browserGate.promise;
        events.push("browser:selected:end");
        return rawPage;
      } }
    };
    const coordinator = new ProcessTabCoordinator();
    const coordinatedBrowser = createCoordinatedBrowser(browser, { coordinator, owner: owner("browser") });
    const page = createCoordinatedPageForBrowser(rawPage, coordinatedBrowser, {
      coordinator,
      owner: owner("page")
    });
    const browserCall = coordinatedBrowser.tabs!.selected!();
    await waitForTurn();
    const pageCall = page.evaluate!(() => "ok");
    await waitForTurn();
    expect(events).toEqual(["browser:selected:start"]);
    browserGate.resolve();
    await browserCall;
    await waitForTurn();
    expect(events).toEqual(["browser:selected:start", "browser:selected:end", "page:evaluate:start"]);
    pageGate.resolve();
    await pageCall;
    expect(events).toEqual(["browser:selected:start", "browser:selected:end", "page:evaluate:start", "page:evaluate:end"]);
  });

  it("does not claim different-tab concurrency when provider capabilities are unknown", async () => {
    const firstGate = deferred();
    const events: string[] = [];
    const browser: BrowserLike = { name: "codex-unknown" };
    const firstRaw: PageLike = {
      evaluate: async <T>() => {
        events.push("tab-a:start");
        await firstGate.promise;
        events.push("tab-a:end");
        return "a" as T;
      }
    };
    const secondRaw: PageLike = {
      evaluate: async <T>() => {
        events.push("tab-b");
        return "b" as T;
      }
    };
    const coordinator = new ProcessTabCoordinator();
    const first = createCoordinatedPageForBrowser(firstRaw, browser, { coordinator, owner: owner("a") });
    const second = createCoordinatedPageForBrowser(secondRaw, browser, { coordinator, owner: owner("b") });
    const firstCall = first.evaluate!(() => "a");
    await waitForTurn();
    const secondCall = second.evaluate!(() => "b");
    await waitForTurn();
    expect(events).toEqual(["tab-a:start"]);
    firstGate.resolve();
    await Promise.all([firstCall, secondCall]);
    expect(events).toEqual(["tab-a:start", "tab-a:end", "tab-b"]);
  });

  it("bounds owner-specific browser wrappers and keeps recent affinities hot", () => {
    const browser: BrowserLike = { name: "chrome", tabs: {} };
    const coordinator = new ProcessTabCoordinator();
    const first = createCoordinatedBrowser(browser, { coordinator, owner: owner("operation-0") });
    let latest: BrowserLike | undefined;
    for (let index = 1; index <= 300; index += 1) {
      latest = createCoordinatedBrowser(browser, {
        coordinator,
        owner: owner(`operation-${index}`)
      });
    }
    expect(latest).toBeDefined();
    expect(createCoordinatedBrowser(browser, {
      coordinator,
      owner: owner("operation-300")
    })).toBe(latest);
    // The first affinity is outside the bounded 256-entry LRU after the
    // stress loop, so it is rebuilt instead of retained forever.
    expect(createCoordinatedBrowser(browser, {
      coordinator,
      owner: owner("operation-0")
    })).not.toBe(first);
  });

  it("fails closed before mapping an oversized provider tab candidate list", async () => {
    const pages = Array.from(
      { length: MAX_BROWSER_TAB_CANDIDATES + 1 },
      (_, index): PageLike => ({ id: `tab-${index}` })
    );
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => pages.map(page => ({ id: page.id! })),
        claimTab: async () => pages[0]!
      },
      tabs: { list: async () => pages }
    };
    const coordinated = createCoordinatedBrowser(browser, {
      coordinator: new ProcessTabCoordinator(),
      owner: owner("candidate-bound")
    });

    await expect(coordinated.tabs!.list!()).rejects.toMatchObject({
      code: "coordinated_browser_invalid"
    });
    await expect(coordinated.user!.openTabs!()).rejects.toMatchObject({
      code: "coordinated_browser_invalid"
    });
  });

  it("keeps timeout polling outside the browser actor and preserves runtime snapshots", async () => {
    const timeoutGate = deferred();
    let countCalls = 0;
    const rawPage: PageLike = {
      waitForTimeout: async () => timeoutGate.promise,
      locator: () => ({ count: async () => {
        countCalls += 1;
        return 1;
      } })
    };
    const browser: BrowserLike = { name: "chrome" };
    const coordinator = new ProcessTabCoordinator();
    const env = coordinateRuntimeEnv({ browser, page: rawPage }, { coordinator, owner: owner("runtime") });
    expect(env.browser).toBe(createCoordinatedBrowser(browser, { coordinator, owner: owner("runtime") }));
    expect(unwrapCoordinatedPage(env.page!)).toBe(rawPage);
    const sleep = env.page!.waitForTimeout!(0);
    await env.page!.locator!("button").count!();
    expect(countCalls).toBe(1);
    timeoutGate.resolve();
    await sleep;
  });
});
