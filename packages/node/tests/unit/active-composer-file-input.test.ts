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

  it("uses the unique general file input inside the current semantic composer form", () => {
    const imageCaptureClick = vi.fn();
    const photosVideoClick = vi.fn();
    const photosClick = vi.fn();
    const filesClick = vi.fn();
    const inputs = [
      { id: "", disabled: false, multiple: false, getAttribute: (name: string) => name === "accept" ? "image/*" : null, click: imageCaptureClick },
      { id: "", disabled: false, multiple: true, getAttribute: (name: string) => name === "accept" ? "image/*,video/*" : null, click: photosVideoClick },
      { id: "", disabled: false, multiple: true, getAttribute: (name: string) => name === "accept" ? "image/*" : null, click: photosClick },
      { id: "", disabled: false, multiple: true, getAttribute: () => null, click: filesClick }
    ];
    const form = {
      contains: (element: unknown) => inputs.includes(element as typeof inputs[number]),
      querySelectorAll: () => inputs
    };
    const body = {
      parentElement: form,
      contains: () => false,
      querySelectorAll: () => []
    };
    const editor = {
      hidden: false,
      parentElement: body,
      closest: (selector: string) => selector === "form" ? form : null,
      getBoundingClientRect: () => ({ width: 300, height: 40 })
    };
    const result = runInNewContext(ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION, {
      document: {
        querySelectorAll: (selector: string) => selector === "input[type='file']"
          ? inputs
          : selector.includes("[contenteditable='true'][role='textbox']") ? [editor] : []
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    });

    expect(result).toEqual({ ok: true });
    expect(filesClick).toHaveBeenCalledOnce();
    expect(imageCaptureClick).not.toHaveBeenCalled();
    expect(photosVideoClick).not.toHaveBeenCalled();
    expect(photosClick).not.toHaveBeenCalled();
  });

  it("refuses a body-level generic file input outside the semantic composer form", () => {
    const click = vi.fn();
    const foreignInput = {
      id: "",
      disabled: false,
      multiple: true,
      getAttribute: () => null,
      click
    };
    let form: any;
    let prompt: any;
    const body = {
      parentElement: null,
      contains: (element: unknown) => element === form || element === prompt || element === foreignInput
    };
    form = {
      parentElement: body,
      contains: (element: unknown) => element === prompt,
      querySelectorAll: () => []
    };
    prompt = {
      hidden: false,
      parentElement: form,
      closest: (selector: string) => selector === "form" ? form : null,
      getBoundingClientRect: () => ({ width: 300, height: 40 })
    };
    const result = runInNewContext(ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION, {
      document: {
        querySelectorAll: (selector: string) => selector === "input[type='file']"
          ? [foreignInput]
          : selector.includes("[contenteditable='true'][role='textbox']") ? [prompt] : []
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    });

    expect(result).toMatchObject({ ok: false });
    expect(click).not.toHaveBeenCalled();
  });
  it("fails closed when the current layout has multiple visible editors", () => {
    const click = vi.fn();
    const input = { id: "", disabled: false, multiple: true, getAttribute: () => null, click };
    const outer = { contains: (element: unknown) => element === input, querySelectorAll: () => [input] };
    const body = { parentElement: outer, contains: () => false, querySelectorAll: () => [] };
    const editor = () => ({
      hidden: false,
      parentElement: body,
      closest: () => null,
      getBoundingClientRect: () => ({ width: 300, height: 40 })
    });
    const result = runInNewContext(ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION, {
      document: {
        querySelectorAll: (selector: string) => selector === "input[type='file']"
          ? [input]
          : selector.includes("[contenteditable='true'][role='textbox']") ? [editor(), editor()] : []
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    });

    expect(result).toMatchObject({ ok: false });
    expect(click).not.toHaveBeenCalled();
  });
});
