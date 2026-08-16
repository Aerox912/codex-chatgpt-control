import { describe, expect, it } from "vitest";
import { readPageState } from "../../src/browser/page-state.js";
import type { PageLike } from "../../src/types.js";

describe("readPageState", () => {
  it("does not treat signed-in settings text as a login blocker", async () => {
    const state = await readPageState(textPage(
      "Chat history New chat Search chats Library Projects Security and login"
    ));

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
  });

  it("still reports login blockers when signed-in markers are absent", async () => {
    const state = await readPageState(textPage("Welcome back Log in Sign up"));

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("does not let the logged-out shell's generic navigation markers mask the login wall", async () => {
    const state = await readPageState(textPage(
      "New chat Search chats Chat with ChatGPT Log in Log in Sign up for free"
    ));

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("ignores hidden stale system blockers in serialized DOM fallback", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/c/test",
      title: async () => "ChatGPT",
      content: async () => [
        "<main>",
        "<nav>New chat Search chats</nav>",
        '<div role="alert" aria-hidden="true">You have reached your usage limit</div>',
        '<div data-testid="conversation-turn-1">',
        '<div data-message-author-role="assistant">Current answer</div>',
        "</div>",
        "</main>"
      ].join("")
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
    expect(state.visibleText).not.toContain("usage limit");
  });

  it("does not classify nested assistant message text as a serialized-DOM blocker", async () => {
    let contentReads = 0;
    const state = await readPageState({
      url: () => "https://chatgpt.com/c/test",
      title: async () => "ChatGPT",
      content: async () => {
        contentReads += 1;
        return [
          "<main>",
          "<nav>New chat Search chats</nav>",
          '<div data-testid="conversation-turn-1">',
          '<div data-message-author-role="assistant">',
          "<div><p>Please verify you are human in your own browser</p></div>",
          "</div>",
          "</div>",
          "</main>"
        ].join("");
      }
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
    expect(contentReads).toBe(1);
  });

  it("still reports a visible system blocker beside serialized conversation turns", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/c/test",
      title: async () => "ChatGPT",
      content: async () => [
        "<main>",
        "<nav>New chat Search chats</nav>",
        '<div data-testid="conversation-turn-1">',
        '<div data-message-author-role="assistant">Current answer</div>',
        "</div>",
        '<div role="alert"><div>You have reached your usage limit</div></div>',
        "</main>"
      ].join("")
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker?.kind).toBe("rate_limit");
  });

  it("ignores a system blocker nested under a hidden serialized wrapper", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/c/test",
      title: async () => "ChatGPT",
      content: async () => [
        "<main>",
        "<nav>New chat Search chats</nav>",
        '<div data-message-author-role="assistant">Current answer</div>',
        '<div aria-hidden="true">',
        "<div>Stale overlay</div>",
        '<div role="alert">You have reached your usage limit</div>',
        "</div>",
        "</main>"
      ].join("")
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
    expect(state.visibleText).not.toContain("usage limit");
  });

  it.each([
    '<script>window.payload = "<div role=\'alert\' aria-label=\'You have reached your usage limit\'>";</script>',
    '<template><div role="alert" aria-label="You have reached your usage limit"></div></template>'
  ])("ignores non-rendered serialized blocker markup", async nonRenderedMarkup => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/c/test",
      title: async () => "ChatGPT",
      content: async () => [
        "<main>",
        "<nav>New chat Search chats</nav>",
        '<div data-message-author-role="assistant">Current answer</div>',
        nonRenderedMarkup,
        "</main>"
      ].join("")
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
    expect(state.visibleText).not.toContain("usage limit");
  });
});

function textPage(text: string): PageLike {
  return {
    url: () => "https://chatgpt.com/",
    title: () => Promise.resolve("ChatGPT"),
    evaluate: async <T>() => text as T
  };
}
