import { describe, expect, it } from "vitest";
import { composerTextbox } from "../../src/dom/selectors.js";
import type { LocatorLike, PageLike } from "../../src/types.js";

describe("DOM selectors", () => {
  it("matches the workspace-specific Project composer label", () => {
    let capturedName: unknown;
    const expected: LocatorLike = { count: async () => 1 };
    const page: PageLike = {
      getByRole: (_role, options = {}) => {
        capturedName = options.name;
        return expected;
      }
    };

    expect(composerTextbox(page)).toBe(expected);
    expect(capturedName).toBeInstanceOf(RegExp);
    expect((capturedName as RegExp).test("New chat in Codex ChatGPT Control")).toBe(true);
    expect((capturedName as RegExp).test("Chat with ChatGPT")).toBe(true);
    expect((capturedName as RegExp).test("Work on anything")).toBe(true);
  });
});
