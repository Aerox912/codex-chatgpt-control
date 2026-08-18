import { describe, expect, it } from "vitest";
import { attachChatGPTBrowser } from "../../src/browser/attach.js";
import { unwrapCoordinatedBrowser } from "../../src/runtime/coordinated-browser.js";
import { unwrapCoordinatedPage } from "../../src/runtime/coordinated-page.js";
import type { BrowserLike, PageLike } from "../../src/types.js";

function pageFixture(id: string): PageLike {
  return {
    id,
    url: () => "https://chatgpt.com/c/attach-test",
    title: async () => "ChatGPT",
    evaluate: async <T>() => ({
      visibleText: "",
      blockerText: "",
      hasConversationMessages: false
    }) as T
  };
}

describe("ChatGPT browser attachment coordination", () => {
  it("normalizes receiver-bound browser bridge proxies before coordination", async () => {
    const rawPage = pageFixture("private-field-tab");
    let createCalls = 0;
    class BridgeTabs {
      readonly #page: PageLike;

      constructor(page: PageLike) {
        this.#page = page;
      }

      async new(): Promise<PageLike> {
        createCalls += 1;
        return this.#page;
      }
    }
    const target = new BridgeTabs(rawPage);
    const tabs = new Proxy(target, {
      get(receiver, property) {
        const value = Reflect.get(receiver, property, receiver);
        return typeof value === "function" ? value.bind(receiver) : value;
      }
    });
    const agent = {
      browsers: {
        list: async () => [{ id: "extension", type: "extension" }],
        get: async () => ({ name: "chrome", tabs })
      }
    };

    const attached = await attachChatGPTBrowser({ agent }, { preferExistingTab: false });

    expect(createCalls).toBe(1);
    expect(attached.tabId).toBe("private-field-tab");
    expect(await attached.page.url!()).toBe("https://chatgpt.com/c/attach-test");
  });

  it("wraps the selected page and browser acquisition result without leaking raw identity", async () => {
    const rawPage = pageFixture("attach-tab");
    const rawBrowser: BrowserLike = {
      name: "chrome",
      tabs: { selected: async () => rawPage }
    };
    const attached = await attachChatGPTBrowser({ browser: rawBrowser }, { preferExistingTab: true });
    expect(attached.browser).not.toBe(rawBrowser);
    expect(attached.page).not.toBe(rawPage);
    expect(unwrapCoordinatedBrowser(attached.browser)).toBe(rawBrowser);
    expect(unwrapCoordinatedPage(attached.page)).toBe(rawPage);
    expect(attached.tabId).toBe("attach-tab");
  });

  it("wraps pages returned by create and claim paths as well as selected paths", async () => {
    const createdPage = pageFixture("created-tab");
    const claimedPage = pageFixture("claimed-tab");
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [{ id: "claimed-tab", url: "https://chatgpt.com/c/attach-test" }],
        claimTab: async () => claimedPage
      },
      tabs: {
        create: async () => createdPage
      }
    };
    const claimed = await attachChatGPTBrowser({ browser }, {
      existingTab: true
    });
    expect(unwrapCoordinatedPage(claimed.page)).toBe(claimedPage);
    expect(claimed.tabId).toBe("claimed-tab");

    const created = await attachChatGPTBrowser({ browser: {
      name: "chrome",
      tabs: { create: async () => createdPage }
    } }, { preferExistingTab: false });
    expect(unwrapCoordinatedPage(created.page)).toBe(createdPage);
    expect(created.tabId).toBe("created-tab");
  });
});
