import { describe, expect, it } from "vitest";
import { visibleLabelMatches } from "../../src/dom/label-match.js";
import { enumerateVisibleMenuItems, extractMenuItemsFromText, findUniqueMenuItem } from "../../src/dom/menus.js";
import type { PageLike } from "../../src/types.js";

describe("menu helpers", () => {
  it("normalizes bullet-separated menu labels", () => {
    expect(extractMenuItemsFromText("Latest • Instant • Extended").map(item => item.normalized)).toEqual([
      "latest",
      "instant",
      "extended"
    ]);
  });

  it("returns a unique fuzzy match", () => {
    const items = extractMenuItemsFromText("Web search\nDeep research\nCreate image");
    expect(findUniqueMenuItem(items, "deep")?.label).toBe("Deep research");
  });

  it("does not let short Pro matching select project menu rows", () => {
    const items = extractMenuItemsFromText("Move to project");
    expect(findUniqueMenuItem(items, "Pro")).toBeUndefined();
  });

  it("matches short labels only on token boundaries", () => {
    expect(visibleLabelMatches("Pro", "Pro")).toBe(true);
    expect(visibleLabelMatches("Pro Extended", "Pro")).toBe(true);
    expect(visibleLabelMatches("Move to project", "Pro")).toBe(false);
    expect(visibleLabelMatches("Projects", "Pro")).toBe(false);
  });

  it("matches CJK labels by exact alias or meaningful substring only", () => {
    expect(visibleLabelMatches("专业", "专业")).toBe(true);
    expect(visibleLabelMatches("专业模式", "专业")).toBe(true);
    expect(visibleLabelMatches("项目", "专业")).toBe(false);
  });

  it("scopes enumeration to open menu containers when any exist", async () => {
    const page = containerScopedPage({
      containerItems: ["Instant", "Thinking", "Pro"],
      strayItems: ["Recent thread row", "Sidebar option"]
    });

    const items = await enumerateVisibleMenuItems(page);

    expect(items.map(item => item.label)).toEqual(["Instant", "Thinking", "Pro"]);
  });

  it("keeps unscoped enumeration when no menu container is present", async () => {
    const page = containerScopedPage({
      containerItems: [],
      strayItems: ["Instant", "Thinking"]
    });

    const items = await enumerateVisibleMenuItems(page);

    expect(items.map(item => item.label)).toEqual(["Instant", "Thinking"]);
  });

  it("falls back to the unscoped list when containers hold no role items", async () => {
    const page = containerScopedPage({
      containerItems: [],
      strayItems: ["Instant", "Thinking"],
      emptyContainer: true
    });

    const items = await enumerateVisibleMenuItems(page);

    expect(items.map(item => item.label)).toEqual(["Instant", "Thinking"]);
  });

  it("excludes role items inside inert hidden menu panels", async () => {
    const page = containerScopedPage({
      containerItems: ["Advanced"],
      hiddenContainerItems: ["Model GPT-5.6 Sol", "Effort Light", "Speed Standard"],
      strayItems: []
    });

    const items = await enumerateVisibleMenuItems(page);

    expect(items.map(item => item.label)).toEqual(["Advanced"]);
  });

  it("excludes positive-size model rows clipped inside an inactive carousel pane", async () => {
    const page = containerScopedPage({
      containerItems: ["Select model", "Power"],
      clippedContainerItems: ["GPT-5.6 Sol", "GPT-5.5"],
      strayItems: []
    });

    const items = await enumerateVisibleMenuItems(page);

    expect(items.map(item => item.label)).toEqual(["Select model", "Power"]);
  });
});

function containerScopedPage({
  containerItems,
  clippedContainerItems = [],
  hiddenContainerItems = [],
  strayItems,
  emptyContainer = false
}: {
  containerItems: string[];
  clippedContainerItems?: string[];
  hiddenContainerItems?: string[];
  strayItems: string[];
  emptyContainer?: boolean;
}): PageLike {
  const scopedNodes = containerItems.map(label => fakeRoleNode(label));
  const clippedScopedNodes = clippedContainerItems.map(label => fakeRoleNode(label, false, true));
  const hiddenScopedNodes = hiddenContainerItems.map(label => fakeRoleNode(label, true));
  const strayNodes = strayItems.map(label => fakeRoleNode(label));
  const containers = containerItems.length > 0 || clippedContainerItems.length > 0 || hiddenContainerItems.length > 0 || emptyContainer
    ? [{ contains: (node: unknown) => [...scopedNodes, ...clippedScopedNodes, ...hiddenScopedNodes].includes(node as ReturnType<typeof fakeRoleNode>) }]
    : [];

  return {
    evaluate: async <T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A) => {
      const previousDocument = globalThis.document;
      const previousWindow = globalThis.window;
      try {
        globalThis.document = {
          querySelectorAll: (selector: string) => {
            if (selector.includes("menuitem") || selector.includes("option")) {
              return [...scopedNodes, ...clippedScopedNodes, ...hiddenScopedNodes, ...strayNodes];
            }
            if (selector.includes("[role='menu']")) {
              return containers;
            }
            return [];
          }
        } as unknown as Document;
        globalThis.window = {
          innerWidth: 1000,
          innerHeight: 800,
          getComputedStyle: (element: unknown) => ({
            display: "block",
            visibility: "visible",
            opacity: "1",
            pointerEvents: "auto",
            overflow: (element as { clipped?: boolean } | undefined)?.clipped === true ? "hidden" : "visible",
            overflowX: (element as { clipped?: boolean } | undefined)?.clipped === true ? "hidden" : "visible",
            overflowY: "visible"
          })
        } as unknown as Window & typeof globalThis;
        return await fn(arg as A);
      } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
      }
    }
  };
}

function fakeRoleNode(label: string, hidden = false, clipped = false): {
  getAttribute: (name: string) => string | undefined;
  hasAttribute: (name: string) => boolean;
  innerText: string;
  parentElement: unknown;
  textContent: string;
  getBoundingClientRect: () => { width: number; height: number; left: number; right: number; top: number; bottom: number };
} {
  const clippingParent = clipped
    ? {
        clipped: true,
        getAttribute: () => undefined,
        hasAttribute: () => false,
        getBoundingClientRect: () => ({ width: 200, height: 100, left: 0, right: 200, top: 0, bottom: 100 }),
        parentElement: null
      }
    : null;
  const hiddenParent = hidden
    ? {
        getAttribute: () => undefined,
        hasAttribute: (name: string) => name === "inert",
        parentElement: null
      }
    : clippingParent;
  return {
    getAttribute: () => undefined,
    hasAttribute: () => false,
    innerText: label,
    parentElement: hiddenParent,
    textContent: label,
    getBoundingClientRect: () => clipped
      ? { width: 100, height: 40, left: 300, right: 400, top: 20, bottom: 60 }
      : { width: 100, height: 40, left: 20, right: 120, top: 20, bottom: 60 }
  };
}
