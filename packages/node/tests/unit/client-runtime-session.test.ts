import { describe, expect, it, vi } from "vitest";
import { createChatGPT } from "../../src/client.js";
import type { BrowserLike, PageLike, SequencePlan } from "../../src/types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function overlapPlan(): SequencePlan {
  return {
    name: "runtime-session-overlap",
    policy: { stopOnError: true, returnPartial: true },
    steps: [
      { id: "bootstrap", command: "session.bootstrap", args: { preferExistingTab: true } },
      { id: "status", command: "messages.status", args: {} }
    ]
  };
}

function pageFor(
  id: string,
  options: { blockSecondSurface?: Deferred<void>; onSecondSurface?: () => void } = {}
): PageLike & { statusCalls: number } {
  let surfaceCalls = 0;
  const page = {
    id,
    statusCalls: 0,
    url: () => `https://chatgpt.com/c/${id}`,
    title: async () => `Chat ${id}`,
    evaluate: async <T>(fn: unknown): Promise<T> => {
      const source = String(fn);
      if (source.includes("blockerText") || source.includes("document.body?.innerText")) {
        surfaceCalls += 1;
        if (surfaceCalls === 2 && options.blockSecondSurface !== undefined) {
          options.onSecondSurface?.();
          await options.blockSecondSurface.promise;
        }
        return {
          visibleText: "",
          blockerText: "",
          hasConversationMessages: false
        } as T;
      }
      if (source.includes("__combinedWaitSnapshot")) {
        page.statusCalls += 1;
        return {
          turnCount: 0,
          assistantTurnCount: 0,
          text: { length: 0, hash: "811c9dc5", transient: false },
          generation: { observed: true, active: false, stopped: false, signals: [] },
          hasResponseActions: false
        } as T;
      }
      if (source.includes("querySelectorAll")) return 0 as T;
      return undefined as T;
    }
  } satisfies PageLike & { statusCalls: number };
  return page;
}

describe("createChatGPT RuntimeEnvSession integration", () => {
  it("keeps a multi-step invocation on its captured page while another invocation bootstraps", async () => {
    const releaseFirst = deferred<void>();
    const firstSurfaceStarted = deferred<void>();
    const firstPage = pageFor("first", {
      blockSecondSurface: releaseFirst,
      onSecondSurface: () => firstSurfaceStarted.resolve()
    });
    const secondPage = pageFor("second");
    let selectedCalls = 0;
    const browser: BrowserLike = {
      tabs: {
        selected: vi.fn(async () => {
          selectedCalls += 1;
          return selectedCalls === 1 ? firstPage : secondPage;
        })
      }
    };
    const chatgpt = createChatGPT({ browser });

    const firstInvocation = chatgpt.runPlan(overlapPlan());
    // The first bootstrap has assigned its page to the invocation-local env,
    // but is paused before its second page-state read. The browser-wide
    // coordinator deliberately keeps the second same-browser invocation
    // queued until this short DOM call settles.
    await firstSurfaceStarted.promise;
    const secondInvocation = chatgpt.runPlan(overlapPlan());
    releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([firstInvocation, secondInvocation]);

    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult.ok).toBe(true);
    expect(selectedCalls).toBe(2);
    // Each status step must use the page captured by its own workflow. With
    // the old shared env, the first status would run on secondPage instead.
    expect(firstPage.statusCalls).toBe(1);
    expect(secondPage.statusCalls).toBe(1);
  });
});
