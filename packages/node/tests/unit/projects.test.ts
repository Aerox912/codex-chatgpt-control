import { describe, expect, it } from "vitest";
import {
  openOrCreateProjectForNewThread,
  projectNameFromWorkspacePath,
  projectNamesMatch,
  suggestProjectAppearance,
  workspaceProjectTarget
} from "../../src/commands/projects.js";
import type { LocatorLike, PageLike } from "../../src/types.js";

describe("ChatGPT Project routing", () => {
  it("derives a readable project name and fitting code icon from the workspace", () => {
    expect(projectNameFromWorkspacePath(String.raw`C:\Users\you\codex-chatgpt-control`)).toBe("Codex ChatGPT Control");
    expect(projectNameFromWorkspacePath(String.raw`C:\Users\you\.agent-system`)).toBe("Agent System");
    expect(workspaceProjectTarget({ path: String.raw`C:\Users\you\codex-chatgpt-control` })).toEqual({
      name: "Codex ChatGPT Control",
      icon: "Code Brackets",
      color: "purple"
    });
    expect(workspaceProjectTarget({ name: "AI civilization platform" }).name).toBe("AI civilization platform");
    expect(suggestProjectAppearance("documentation-notes")).toEqual({ icon: "Writing", color: "orange" });
  });

  it("matches equivalent project punctuation and casing without fuzzy collisions", () => {
    expect(projectNamesMatch("codex-chatgpt-control", "Codex ChatGPT Control")).toBe(true);
    expect(projectNamesMatch("Codex ChatGPT Control", "Codex ChatGPT Controller")).toBe(false);
    expect(projectNamesMatch("プロジェクト", "项目")).toBe(false);
  });

  it("opens an existing matching project without creating account state", async () => {
    const fake = projectPage({ existingProject: true });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control" },
      250
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        name: "Codex ChatGPT Control",
        url: "https://chatgpt.com/g/g-p-test/project",
        created: false
      }
    });
    expect(result.data).not.toHaveProperty("icon");
    expect(result.data).not.toHaveProperty("color");
    expect(fake.actions).not.toContain("create-project");
  });

  it("returns a resumable confirmation blocker before creating a missing project", async () => {
    const fake = projectPage();
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control" },
      250
    );

    expect(result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      blocker: {
        kind: "confirmation",
        code: "chatgpt_project_creation_confirmation_required",
        fieldPath: "project.confirmCreation",
        resumable: true
      }
    });
    expect(fake.actions).not.toContain("create-project");
  });

  it("creates the confirmed project with the suggested icon and verifies its composer", async () => {
    const fake = projectPage();
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control", confirmCreation: true },
      250
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        name: "Codex ChatGPT Control",
        url: "https://chatgpt.com/g/g-p-test/project",
        created: true,
        icon: "Code Brackets",
        color: "purple"
      }
    });
    expect(fake.actions).toEqual(expect.arrayContaining([
      "fill:Codex ChatGPT Control",
      "color:Purple",
      "icon:Code Brackets",
      "create-project"
    ]));
  });
});

function projectPage(options: { existingProject?: boolean } = {}): { page: PageLike; actions: string[] } {
  const actions: string[] = [];
  let currentUrl = "https://chatgpt.com/";
  let createDialogOpen = false;
  let customizeDialogOpen = false;
  let projectName = "Codex ChatGPT Control";

  const empty = locator({ count: 0 });
  const projectLink = locator({ count: 1, href: "/g/g-p-test/c/example" });
  const projectItem = locator({
    count: 1,
    locator: selector => selector.includes('/g/g-p-') ? projectLink : empty
  });
  const projectRow = locator({
    count: options.existingProject === true ? 1 : 0,
    text: "Codex ChatGPT Control",
    locator: selector => selector.includes("ancestor::li") ? projectItem : projectRow
  });
  const projectIcons = locator({
    count: options.existingProject === true ? 1 : 0,
    nth: () => locator({ count: 1, locator: () => projectRow })
  });

  const customizeDialog = locator({
    count: () => customizeDialogOpen ? 1 : 0,
    getByRole: (role, query) => {
      const name = query?.name;
      if (role === "radio" && typeof name === "string") {
        return locator({
          count: 1,
          click: () => actions.push(name === "Purple" ? "color:Purple" : `icon:${name}`)
        });
      }
      if (role === "button" && name === "Done") {
        return locator({ count: 1, click: () => { customizeDialogOpen = false; } });
      }
      return empty;
    }
  });

  const createDialog = locator({
    count: () => createDialogOpen ? 1 : 0,
    getByRole: (role, query) => {
      const name = query?.name;
      if (role === "textbox" && name === "Project name") {
        return locator({ count: 1, fill: value => { projectName = value; actions.push(`fill:${value}`); } });
      }
      if (role === "button" && name instanceof RegExp) {
        return locator({ count: 1, click: () => { customizeDialogOpen = true; } });
      }
      if (role === "dialog" && name === "Customize Project Icon") return customizeDialog;
      if (role === "button" && name === "Create project") {
        return locator({
          count: 1,
          click: () => {
            actions.push("create-project");
            createDialogOpen = false;
            currentUrl = "https://chatgpt.com/g/g-p-test/project";
          }
        });
      }
      return empty;
    }
  });

  const page: PageLike = {
    url: () => currentUrl,
    title: async () => "ChatGPT",
    goto: async url => { currentUrl = url; },
    waitForTimeout: async () => undefined,
    locator: selector => {
      if (selector === '[data-testid="project-folder-icon"]') return projectIcons;
      return empty;
    },
    getByText: () => empty,
    getByRole: (role, query) => {
      const name = query?.name;
      if (role === "button" && name === "New project") {
        return locator({ count: 1, click: () => { createDialogOpen = true; } });
      }
      if (role === "dialog" && name === "Create project") return createDialog;
      if (role === "textbox" && name instanceof RegExp && name.test(`New chat in ${projectName}`)) {
        return locator({ count: currentUrl.includes("/g/g-p-test/project") ? 1 : 0 });
      }
      return empty;
    }
  };

  return { page, actions };
}

type LocatorOptions = {
  count: number | (() => number);
  text?: string;
  href?: string;
  click?: () => void;
  fill?: (value: string) => void;
  locator?: (selector: string) => LocatorLike;
  nth?: (index: number) => LocatorLike;
  getByRole?: (role: string, options?: Record<string, unknown>) => LocatorLike;
};

function locator(options: LocatorOptions): LocatorLike {
  return {
    count: async () => typeof options.count === "function" ? options.count() : options.count,
    click: async () => { options.click?.(); },
    fill: async value => { options.fill?.(value); },
    innerText: async () => options.text ?? "",
    getAttribute: async name => name === "href" ? options.href ?? null : null,
    locator: selector => options.locator?.(selector) ?? locator({ count: 0 }),
    nth: index => options.nth?.(index) ?? locator({ count: 0 }),
    first() { return this; },
    last() { return this; },
    getByRole: (role, query) => options.getByRole?.(role, query) ?? locator({ count: 0 })
  };
}
