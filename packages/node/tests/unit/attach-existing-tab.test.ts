import { describe, expect, it } from "vitest";
import { bootstrap } from "../../src/commands/session.js";
import type { BrowserLike, PageLike } from "../../src/types.js";

describe("existing browser tab bootstrap", () => {
  it("claims the most recent open user ChatGPT tab for selected existing-tab mode", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("user-tab-1", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "selected", host: "chatgpt" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("user-tab-1");
    expect(result.context.conversationId).toBe("abc-123");
    expect(claimed).toEqual([
      { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("prefers the user-open selected tab over a stale controlled selection for explicit reuse", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      tabs: {
        selected: async () => fakeChatGPTPage(
          "controlled-stale",
          "https://chatgpt.com/c/controlled-stale",
          "Controlled stale"
        ),
        list: async () => [
          fakeChatGPTPage("controlled-stale", "https://chatgpt.com/c/controlled-stale", "Controlled stale")
        ]
      },
      user: {
        openTabs: async () => [
          { id: "user-current", url: "https://chatgpt.com/c/user-current", title: "User current" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("user-current", "https://chatgpt.com/c/user-current", "User current");
        }
      }
    };

    const result = await bootstrap({ browser }, { existingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("user-current");
    expect(claimed).toHaveLength(1);
  });

  it("blocks instead of creating a replacement when existingTab true has no open match", async () => {
    let created = false;
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [],
        claimTab: async () => {
          throw new Error("claimTab should not run");
        }
      },
      tabs: {
        list: async () => [],
        create: async () => {
          created = true;
          return fakeChatGPTPage("created", "https://chatgpt.com/", "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, { existingTab: true });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      blocker: { code: "existing_tab_not_found" }
    });
    expect(created).toBe(false);
  });

  it("uses user-open ChatGPT tabs for default preferred existing-tab discovery", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("user-tab-1", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      },
      tabs: {
        list: async () => []
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("user-tab-1");
    expect(claimed).toEqual([
      { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("uses user-open Chrome tabs when controlled tab enumeration is unavailable", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "user-only", url: "https://chatgpt.com/c/user-only", title: "User-only APIs" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("user-only", "https://chatgpt.com/c/user-only", "User-only APIs");
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("user-only");
    expect(claimed).toHaveLength(1);
  });

  it.each([
    "https://evil.example/?next=https://chatgpt.com/c/abc",
    "https://evil.example/chatgpt.com/c/abc",
    "https://chatgpt.com.evil.example/c/abc",
    "https://notchatgpt.com/c/abc"
  ])("does not reuse a lookalike controlled URL: %s", async lookalike => {
    const created: string[] = [];
    const lookalikePage = fakeChatGPTPage("lookalike", lookalike, "Lookalike");
    const browser: BrowserLike = {
      name: "chrome",
      tabs: {
        selected: async () => lookalikePage,
        list: async () => [lookalikePage],
        create: async url => {
          created.push(url);
          return fakeChatGPTPage("fresh", url, "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("fresh");
    expect(created).toEqual(["https://chatgpt.com/"]);
  });

  it("blocks when a newly created page redirects away from ChatGPT", async () => {
    let currentUrl = "about:blank";
    const page: PageLike = {
      id: "redirected-new-page",
      url: () => currentUrl,
      goto: async () => {
        currentUrl = "https://evil.example/private/path?next=secret";
      },
      title: async () => "Redirected"
    };
    const browser: BrowserLike = {
      name: "chrome",
      newPage: async () => page
    };

    const result = await bootstrap({ browser }, { preferExistingTab: false });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      blocker: {
        kind: "selector_drift",
        code: "unsafe_chatgpt_origin"
      },
      error: { recoverable: false }
    });
    expect(result.blocker?.visibleText).toBe("Observed browser origin: https://evil.example");
    expect(result.blocker?.visibleText).not.toContain("next=");
  });

  it("replaces a cached page that drifted away from ChatGPT", async () => {
    let cachedUrl = "https://chatgpt.com/c/preflight";
    const cached = fakeChatGPTPage("cached", cachedUrl, "Preflight");
    cached.url = () => cachedUrl;
    const fresh = fakeChatGPTPage("fresh", "https://chatgpt.com/", "ChatGPT");
    const created: string[] = [];
    const browser: BrowserLike = {
      name: "iab",
      tabs: {
        create: async url => {
          created.push(url);
          return fresh;
        }
      }
    };
    const env = { browser, page: cached };

    cachedUrl = "about:blank";
    const result = await bootstrap(env, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("fresh");
    expect(created).toEqual(["https://chatgpt.com/"]);
    expect(env.page).not.toBe(cached);
  });

  it("does not reuse a valid cached page when a fresh tab is requested", async () => {
    const cached = fakeChatGPTPage("cached", "https://chatgpt.com/c/preflight", "Preflight");
    const fresh = fakeChatGPTPage("fresh", "https://chatgpt.com/", "ChatGPT");
    const created: string[] = [];
    const browser: BrowserLike = {
      name: "iab",
      tabs: {
        create: async url => {
          created.push(url);
          return fresh;
        }
      }
    };

    const result = await bootstrap({ browser, page: cached }, { preferExistingTab: false });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("fresh");
    expect(created).toEqual(["https://chatgpt.com/"]);
  });

  it("blocks when a claimed ChatGPT tab changes origin during the claim", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "claim-race", url: "https://chatgpt.com/c/claim-race", title: "Claim race" }
        ],
        claimTab: async () => fakeChatGPTPage("claim-race", "https://evil.example/", "Redirected")
      }
    };

    const result = await bootstrap({ browser }, { existingTab: true });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      blocker: {
        kind: "selector_drift",
        code: "unsafe_chatgpt_origin"
      },
      error: { recoverable: false }
    });
  });

  it.each([
    "http://chatgpt.com/c/abc",
    "https://chatgpt.com:444/c/abc",
    "https://user@chatgpt.com/c/abc",
    "file://chatgpt.com/c/abc"
  ])("does not reuse a ChatGPT hostname through a disallowed URL form: %s", async unsafeUrl => {
    const created: string[] = [];
    const unsafePage = fakeChatGPTPage("unsafe", unsafeUrl, "Unsafe");
    const browser: BrowserLike = {
      name: "chrome",
      tabs: {
        selected: async () => unsafePage,
        list: async () => [unsafePage],
        create: async url => {
          created.push(url);
          return fakeChatGPTPage("fresh", url, "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("fresh");
    expect(created).toEqual(["https://chatgpt.com/"]);
  });

  it("falls back to a fresh tab when implicit user-tab reuse is already claimed", async () => {
    const created: string[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "claimed-tab", url: "https://chatgpt.com/c/abc-123", title: "Already Claimed" }
        ],
        claimTab: async () => {
          throw new Error("Tab claimed-tab is already part of browser session existing-session");
        }
      },
      tabs: {
        create: async url => {
          created.push(url);
          return fakeChatGPTPage("fresh-tab", url, "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("fresh-tab");
    expect(created).toEqual(["https://chatgpt.com/"]);
  });

  it("claims an exact open user ChatGPT tab by conversation id without navigating", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "other", url: "https://chatgpt.com/c/other", title: "Other Chat" },
          { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("target", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("target");
    expect(claimed).toEqual([
      { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("does not require sidebar signed-in chrome for narrow conversation tabs", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "narrow", url: "https://chatgpt.com/c/abc-123", title: "ChatGPT" }
        ],
        claimTab: async () => fakeNarrowChatGPTPage("narrow", "https://chatgpt.com/c/abc-123", "ChatGPT")
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("narrow");
    expect(result.context.conversationId).toBe("abc-123");
    expect(result.data?.loggedIn).toBe(false);
  });

  it("does not hang when a claimed user tab exposes a stalled DOM evaluator", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "image-tab", url: "https://chatgpt.com/c/abc-123", title: "Image Request" }
        ],
        claimTab: async () => ({
          id: "image-tab",
          url: () => "https://chatgpt.com/c/abc-123",
          title: async () => "Image Request",
          playwright: {
            evaluate: async () => new Promise(() => {})
          }
        })
      }
    };

    const result = await Promise.race([
      bootstrap({ browser }, {
        existingTab: {
          target: { type: "conversationId", conversationId: "abc-123" },
          ifMissing: "block"
        }
      }),
      new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 3500))
    ]);

    expect(result).not.toBe("hung");
    expect(result).toMatchObject({
      ok: true,
      data: {
        tabId: "image-tab",
        url: "https://chatgpt.com/c/abc-123"
      },
      context: {
        conversationId: "abc-123",
        tabId: "image-tab"
      }
    });
  });

  it("does not let a stale cached page bypass an explicit existing-tab claim", async () => {
    const claimed: unknown[] = [];
    const stalePage = {
      id: "stale",
      url: () => undefined as unknown as string,
      title: async () => "Stale tab",
      content: async () => "",
      locator: () => ({ count: async () => 0 })
    } as PageLike;
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("target", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      }
    };

    const result = await bootstrap({ browser, page: stalePage }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("target");
    expect(result.context.conversationId).toBe("abc-123");
    expect(claimed).toEqual([
      { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("blocks when an explicit existing conversation target is not open", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "other", url: "https://chatgpt.com/c/other", title: "Other Chat" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          throw new Error("claimTab should not be called for a missing existing-tab target.");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blocker).toMatchObject({
      kind: "not_found",
      code: "existing_tab_not_found"
    });
    expect(result.blocker?.diagnostics?.existingTab).toEqual({
      requestedTarget: {
        type: "conversationId",
        conversationId: "abc-123"
      },
      userOpenTabsAvailable: true,
      chatgptTabCount: 1,
      mismatchReason: "conversation_id_mismatch",
      candidateTabs: [
        {
          id: "other",
          url: "https://chatgpt.com/c/other",
          title: "Other Chat",
          conversationId: "other"
        }
      ]
    });
    expect(claimed).toEqual([]);
    expect(JSON.stringify(result.blocker?.diagnostics)).not.toContain("say hi");
  });

  it("reports user-open tab enumeration failures without losing the failure reason", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => {
          throw new Error("user tabs unavailable");
        },
        claimTab: async () => {
          throw new Error("claimTab should not be called when openTabs fails.");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.blocker?.diagnostics?.existingTab).toEqual({
      requestedTarget: {
        type: "conversationId",
        conversationId: "abc-123"
      },
      userOpenTabsAvailable: false,
      chatgptTabCount: 0,
      mismatchReason: "user_open_tabs_unavailable",
      candidateTabs: []
    });
  });

  it("caps and truncates existing-tab diagnostic candidates", async () => {
    const longTitle = `SDK Review ${"x".repeat(280)}`;
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => Array.from({ length: 12 }, (_, index) => ({
          id: `tab-${index + 1}`,
          url: `https://chatgpt.com/c/other-${index + 1}`,
          title: index === 0 ? longTitle : `Other Chat ${index + 1}`
        })),
        claimTab: async () => {
          throw new Error("claimTab should not be called for a missing existing-tab target.");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    const diagnostics = result.blocker?.diagnostics?.existingTab;
    expect(result.ok).toBe(false);
    expect(diagnostics?.candidateTabs).toHaveLength(10);
    expect(diagnostics?.omittedCandidateCount).toBe(2);
    expect(diagnostics?.candidateTabs[0]?.title).toHaveLength(240);
    expect(diagnostics?.candidateTabs[0]?.title?.endsWith("…")).toBe(true);
    expect(diagnostics?.candidateTabs[9]).toMatchObject({
      id: "tab-10",
      conversationId: "other-10"
    });
  });

  it("blocks ambiguous title matches with metadata-only candidates by default", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "one", url: "https://chatgpt.com/c/one", title: "SDK Review" },
          { id: "two", url: "https://chatgpt.com/c/two", title: "SDK Review" }
        ],
        claimTab: async () => fakeChatGPTPage("one", "https://chatgpt.com/c/one", "SDK Review")
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "title", title: "SDK Review" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blocker).toMatchObject({
      kind: "not_found",
      code: "existing_tab_ambiguous"
    });
    expect(result.blocker?.candidates?.map(candidate => candidate.label)).toEqual([
      "tab one - SDK Review - https://chatgpt.com/c/one",
      "tab two - SDK Review - https://chatgpt.com/c/two"
    ]);
    expect(result.blocker?.diagnostics?.existingTab).toMatchObject({
      requestedTarget: {
        type: "title",
        title: "SDK Review"
      },
      userOpenTabsAvailable: true,
      chatgptTabCount: 2,
      mismatchReason: "multiple_candidates",
      candidateTabs: [
        {
          id: "one",
          url: "https://chatgpt.com/c/one",
          title: "SDK Review",
          conversationId: "one"
        },
        {
          id: "two",
          url: "https://chatgpt.com/c/two",
          title: "SDK Review",
          conversationId: "two"
        }
      ]
    });
  });
});

function fakeChatGPTPage(id: string, url: string, title: string): PageLike {
  return {
    id,
    url: () => url,
    title: async () => title,
    content: async () => "<main>New chat Search chats Chat with ChatGPT</main>",
    locator: () => ({ count: async () => 0 }),
    waitForEvent: async () => ({})
  } as PageLike;
}

function fakeNarrowChatGPTPage(id: string, url: string, title: string): PageLike {
  return {
    id,
    url: () => url,
    title: async () => title,
    content: async () => [
      "<main>",
      "<a>Skip to content</a>",
      "<div data-message-author-role=\"user\">say hi</div>",
      "<div data-message-author-role=\"assistant\">hi</div>",
      "<footer>ChatGPT is AI and can make mistakes. Check important info.</footer>",
      "</main>"
    ].join(""),
    locator: () => ({ count: async () => 0 }),
    waitForEvent: async () => ({})
  } as PageLike;
}
