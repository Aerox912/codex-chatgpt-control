import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION } from "../../src/browser/active-composer-file-input.js";

describe("ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION", () => {
  it("ignores historical textbox forms when #upload-files is unique", () => {
    const click = vi.fn();
    const uploadInput = {
      id: "upload-files",
      disabled: false,
      getAttribute: () => null,
      click
    };
    const historicalEditors = [{}, {}];
    const selectors: string[] = [];

    const result = runInNewContext(ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION, {
      document: {
        querySelectorAll: (selector: string) => {
          selectors.push(selector);
          if (selector === "input[type='file']") return [uploadInput];
          if (selector.includes("textarea")) return historicalEditors;
          return [];
        }
      }
    });

    expect(result).toEqual({ ok: true });
    expect(click).toHaveBeenCalledOnce();
    expect(selectors).not.toContain("textarea, [contenteditable='true'], [role='textbox']");
  });

  it("falls back to the unique visible prompt composer", () => {
    const click = vi.fn();
    const uploadInput = {
      id: "composer-file-input",
      disabled: false,
      getAttribute: (name: string) => name === "accept" ? "*/*" : null,
      click
    };
    const composer = {
      contains: (element: unknown) => element === uploadInput
    };
    const prompt = {
      hidden: false,
      closest: (selector: string) => selector.includes("[hidden]") ? null : selector === "form" ? composer : null,
      getBoundingClientRect: () => ({ width: 200, height: 40 })
    };

    const result = runInNewContext(ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION, {
      document: {
        querySelectorAll: (selector: string) => {
          if (selector === "input[type='file']") return [uploadInput];
          if (selector.includes("#prompt-textarea")) return [prompt];
          return [];
        }
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    });

    expect(result).toEqual({ ok: true });
    expect(click).toHaveBeenCalledOnce();
  });
});
