import { afterEach, describe, expect, it, vi } from "vitest";
import { countPageMessages, extractMessagesFromHtml, readLatestMessage, readLatestMessageText, readLatestMessageTextSnapshot, readMessages } from "../../src/dom/messages.js";
import { readWaitDomSnapshot, waitTextMetadata } from "../../src/dom/wait-snapshot.js";
import { latestAssistantTurnHasResponseActions } from "../../src/dom/generation-state.js";
import type { PageLike } from "../../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function currentPage(options: { emptyMarkdown?: boolean; olderActions?: boolean } = {}): PageLike {
  const makeNode = (role: string, text: string) => {
    const attrs = { "data-chatgpt-search-unit-key": `fallback-turn-0:0:${role}`, "data-chatgpt-search-message-ids": "fixture-message" };
    const content = { innerText: text, textContent: text, innerHTML: `<p>${text}</p>` };
    const node = {
      tagName: "DIV", parentElement: null as unknown,
      innerText: role === "assistant" ? `ChatGPT said: ${text}` : text,
      textContent: text, innerHTML: `<h4 data-conversation-role="assistant">ChatGPT said:</h4><p>${text}</p>`, outerHTML: "<div></div>",
      getAttribute: (name: string) => attrs[name as keyof typeof attrs] ?? null,
      hasAttribute: (name: string) => name in attrs,
      closest: () => null,
      querySelector: (selector: string) => selector.includes("data-conversation-role") ? { textContent: "ChatGPT said:" }
        : role === "user" && selector.includes("user-message-bubble") ? content
        : role === "assistant" && selector.includes("markdown-text-style") ? (options.emptyMarkdown ? { ...content, innerText: "", textContent: "", innerHTML: "" } : content) : null,
      querySelectorAll: (_selector: string): unknown[] => []
    };
    return node;
  };
  const user = makeNode("user", "Reply exactly CURRENT_OK.");
  const assistant = makeNode("assistant", options.emptyMarkdown ? "canary.csv Spreadsheet" : "CURRENT_OK");
  const action = { innerText: "", textContent: "", getAttribute: (name: string) => name === "aria-label" ? "More actions" : null };
  const owner = {
    tagName: "DIV", parentElement: null,
    querySelectorAll: (selector: string) => selector === "button" ? [action]
      : selector.includes("data-chatgpt-search-unit-key") ? (options.olderActions ? [makeNode("assistant", "old"), assistant] : [assistant]) : []
  };
  assistant.parentElement = owner;
  const nodes = [user, assistant];
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      if (!selector.includes("data-chatgpt-search-unit-key")) return [];
      if (selector.includes(":user") && !selector.includes(":assistant")) return [user];
      if (selector.includes(":assistant") && !selector.includes(":user")) return [assistant];
      return nodes;
    }
  });
  vi.stubGlobal("window", { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) });
  return { evaluate: async (fn, arg) => fn(arg as never) } as PageLike;
}

describe("current search-unit message containers", () => {
  it("preserves semantic formatting in serialized current messages and excludes unowned markers", () => {
    const html = '<aside><div data-chatgpt-search-unit-key="sidebar:assistant" data-chatgpt-search-message-ids="outside"><p>outside</p></div></aside>'
      + '<main><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="user"><h4>You said:</h4><div data-user-message-bubble="true">Hello</div></div>'
      + '<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="assistant"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-markdown-text-style="assistant-message"><p><strong>Ready</strong></p><pre><code>value = 1</code></pre></div></div>'
      + '<div data-chatgpt-search-unit-key="quoted:assistant"><p>unqualified</p></div></main>';
    const messages = extractMessagesFromHtml(html, { format: "all" });
    expect(messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.text).toBe("Hello");
    expect(messages[1]?.markdown).toContain("**Ready**");
    expect(messages[1]?.codeBlocks?.[0]?.text).toBe("value = 1");
    expect(messages[1]?.visibleText).not.toContain("ChatGPT said:");
  });

  it("retains a serialized file-only response when the markdown container is empty", () => {
    const messages = extractMessagesFromHtml('<main><div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="file"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-markdown-text-style="assistant-message"></div><span>canary.csv</span><span>Spreadsheet</span></div></main>', { format: "normalized_text" });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("canary.csv");
    expect(messages[0]?.text).not.toContain("ChatGPT said:");
  });
  it("counts and reads roles without including the accessible assistant heading", async () => {
    const page = currentPage();
    expect(await countPageMessages(page)).toBe(2);
    expect(await countPageMessages(page, "assistant")).toBe(1);
    expect(await readLatestMessageText(page, "user")).toBe("Reply exactly CURRENT_OK.");
    expect(await readLatestMessageText(page, "assistant")).toBe("CURRENT_OK");
    expect(await readLatestMessageTextSnapshot(page, "user")).toEqual({ turnCount: 2, latestText: "Reply exactly CURRENT_OK." });
    expect((await readLatestMessage(page, "assistant", "normalized_text"))?.text).toBe("CURRENT_OK");
    expect((await readMessages(page, { format: "normalized_text" })).map(message => message.text)).toEqual(["Reply exactly CURRENT_OK.", "CURRENT_OK"]);
  });

  it("keeps file-only responses observable when their markdown body is empty", async () => {
    const page = currentPage({ emptyMarkdown: true });
    expect(await readLatestMessageText(page, "assistant")).toBe("canary.csv Spreadsheet");
    expect((await readLatestMessage(page, "assistant", "normalized_text"))?.text).not.toContain("ChatGPT said:");
  });

  it("uses one combined wait snapshot and the owned response-action ancestor", async () => {
    const page = currentPage();
    const snapshot = await readWaitDomSnapshot(page);
    expect(snapshot).toMatchObject({ turnCount: 2, assistantTurnCount: 1, latestAssistantTurnIndex: 2, text: waitTextMetadata("CURRENT_OK"), hasResponseActions: true });
    expect(await latestAssistantTurnHasResponseActions(page)).toBe(true);
  });

  it("does not borrow an older assistant's actions after crossing turn ownership", async () => {
    const page = currentPage({ olderActions: true });
    expect((await readWaitDomSnapshot(page))?.hasResponseActions).toBe(false);
    expect(await latestAssistantTurnHasResponseActions(page)).toBe(false);
  });
});
