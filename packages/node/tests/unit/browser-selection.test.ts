import { describe, expect, it } from "vitest";
import { bootstrap } from "../../src/commands/session.js";
import type { BrowserLike, PageLike } from "../../src/types.js";

describe("automatic browser selection", () => {
  it("prefers the in-app browser selector", async () => {
    const requested: string[] = [];
    const inAppBrowser = fakeBrowser("Codex In-app Browser", "iab-tab");
    const chrome = fakeBrowser("chrome", "chrome-tab");
    const agent = {
      browsers: {
        get: async (selector: string) => {
          requested.push(selector);
          if (selector === "iab") return inAppBrowser;
          if (selector === "extension" || selector === "chrome") return chrome;
          throw new Error(`Unknown browser selector: ${selector}`);
        }
      }
    };

    const result = await bootstrap({ agent }, { preferExistingTab: false });

    expect(result.ok).toBe(true);
    expect(result.data?.browserName).toBe("Codex In-app Browser");
    expect(result.context.tabId).toBe("iab-tab");
    expect(requested).toEqual(["iab"]);
  });

  it("prefers a listed in-app browser when the stable selector is unavailable", async () => {
    const requested: string[] = [];
    const inAppBrowser = fakeBrowser("Codex In-app Browser", "listed-iab-tab");
    const chrome = fakeBrowser("chrome", "chrome-tab");
    const agent = {
      browsers: {
        list: async () => [
          { id: "chrome-id", type: "extension", name: "Google Chrome" },
          { id: "iab-id", type: "iab", name: "Codex In-app Browser" }
        ],
        get: async (selector: string) => {
          requested.push(selector);
          if (selector === "iab") throw new Error("Stable selector unavailable");
          if (selector === "iab-id") return inAppBrowser;
          if (selector === "chrome-id") return chrome;
          throw new Error(`Unknown browser selector: ${selector}`);
        }
      }
    };

    const result = await bootstrap({ agent }, { preferExistingTab: false });

    expect(result.ok).toBe(true);
    expect(result.data?.browserName).toBe("Codex In-app Browser");
    expect(result.context.tabId).toBe("listed-iab-tab");
    expect(requested).toEqual(["iab", "iab-id"]);
  });

  it("falls back to the Chrome extension when no in-app browser is available", async () => {
    const requested: string[] = [];
    const chrome = fakeBrowser("chrome", "chrome-tab");
    const agent = {
      browsers: {
        list: async () => [
          { id: "chrome-id", type: "extension", name: "Google Chrome" }
        ],
        get: async (selector: string) => {
          requested.push(selector);
          if (selector === "iab") throw new Error("In-app browser unavailable");
          if (selector === "chrome-id") return chrome;
          throw new Error(`Unknown browser selector: ${selector}`);
        }
      }
    };

    const result = await bootstrap({ agent }, { preferExistingTab: false });

    expect(result.ok).toBe(true);
    expect(result.data?.browserName).toBe("chrome");
    expect(result.context.tabId).toBe("chrome-tab");
    expect(requested).toEqual(["iab", "chrome-id"]);
  });

  it("preserves an explicitly supplied browser", async () => {
    const requested: string[] = [];
    const explicitChrome = fakeBrowser("chrome", "explicit-chrome-tab");
    const agent = {
      browsers: {
        get: async (selector: string) => {
          requested.push(selector);
          return fakeBrowser("Codex In-app Browser", "unexpected-iab-tab");
        }
      }
    };

    const result = await bootstrap({ agent, browser: explicitChrome }, { preferExistingTab: false });

    expect(result.ok).toBe(true);
    expect(result.data?.browserName).toBe("chrome");
    expect(result.context.tabId).toBe("explicit-chrome-tab");
    expect(requested).toEqual([]);
  });
});

function fakeBrowser(name: string, tabId: string): BrowserLike {
  return {
    name,
    tabs: {
      new: async (url?: string) => fakeChatGPTPage(tabId, url ?? "https://chatgpt.com/")
    }
  };
}

function fakeChatGPTPage(id: string, url: string): PageLike {
  return {
    id,
    url: () => url,
    goto: async () => undefined,
    title: async () => "ChatGPT",
    content: async () => "<main>New chat Search chats Chat with ChatGPT</main>",
    locator: () => ({ count: async () => 0 }),
    waitForEvent: async () => ({})
  } as PageLike;
}
