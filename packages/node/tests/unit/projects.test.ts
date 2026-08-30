import { describe, expect, it } from "vitest";
import {
  openOrCreateProjectForNewThread,
  projectContextMatches,
  projectNameFromWorkspacePath,
  projectNamesMatch,
  suggestProjectAppearance,
  workspaceProjectTarget
} from "../../src/commands/projects.js";
import { newThread } from "../../src/commands/threads.js";
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

  it("recognizes project home and project conversation URLs without prefix collisions", () => {
    const project = "https://chatgpt.com/g/g-p-abc123/project";

    expect(projectContextMatches(project, project)).toBe(true);
    expect(projectContextMatches(project, "https://chatgpt.com/g/g-p-abc123-codex-control/c/conversation")).toBe(true);
    expect(projectContextMatches(project, "https://chatgpt.com/g/g-p-abc1234/project")).toBe(false);
    expect(projectContextMatches(project, "https://chatgpt.com/work")).toBe(false);
  });

  it("blocks an unconfirmed global Chat thread before touching the browser", async () => {
    const result = await newThread({}, { project: false });

    expect(result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      blocker: {
        kind: "confirmation",
        code: "chatgpt_global_project_opt_out_confirmation_required",
        fieldPath: "confirmGlobal",
        resumable: true
      }
    });
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
    expect(fake.navigations[0]).toBe("https://chatgpt.com/projects");
  });

  it("resolves a full-list Project card link directly from the Projects index", async () => {
    const fake = projectPage({ existingProject: true, projectCardIsLink: true });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control" },
      250
    );

    expect(result).toMatchObject({ ok: true, data: { created: false } });
    expect(fake.navigations).toEqual([
      "https://chatgpt.com/projects",
      "https://chatgpt.com/g/g-p-test/project"
    ]);
  });

  it("matches and opens a full-list Project grid row without opening the sidebar", async () => {
    const fake = projectPage({ existingProject: true, projectsIndexGrid: true });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control" },
      250
    );

    expect(result).toMatchObject({ ok: true, data: { created: false } });
    expect(fake.navigations).toEqual(["https://chatgpt.com/projects"]);
    expect(fake.actions).toContain("open-project-row");
    expect(fake.actions).not.toContain("open-sidebar");
  });

  it("opens the compact sidebar before locating an existing project", async () => {
    const fake = projectPage({
      existingProject: true,
      sidebarHidden: true,
      directProjectSection: true,
      projectsIndexRedirectsHome: true
    });
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
    expect(fake.actions).toEqual(["open-sidebar"]);
    expect(fake.actions).not.toContain("create-project");
  });

  it("uses Show more until a compact-sidebar project becomes visible", async () => {
    const fake = projectPage({
      existingProject: true,
      sidebarHidden: true,
      directProjectSection: true,
      projectsIndexRedirectsHome: true,
      projectRevealAfter: 2
    });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control" },
      250
    );

    expect(result).toMatchObject({ ok: true, data: { created: false } });
    expect(fake.actions).toEqual(["open-sidebar", "show-more", "show-more"]);
    expect(fake.actions).not.toContain("create-project");
  });

  it("waits for hydrating Project controls instead of clicking a transient More control", async () => {
    const fake = projectPage({
      directProjectSection: true,
      existingProject: true,
      projectControlsHydrateAfter: 3
    });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control" },
      250
    );

    expect(result).toMatchObject({ ok: true, data: { created: false } });
    expect(fake.actions).not.toContain("open-more");
  });

  it("waits for a hydrating matching project before considering creation", async () => {
    const fake = projectPage({
      directProjectSection: true,
      existingProject: true,
      projectHydratesAfter: 3
    });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control", confirmCreation: true },
      250
    );

    expect(result).toMatchObject({ ok: true, data: { created: false } });
    expect(fake.actions).not.toContain("create-project");
  });

  it("blocks instead of choosing between duplicate normalized Project names", async () => {
    const fake = projectPage({
      directProjectSection: true,
      existingProject: true,
      matchingProjectCount: 2,
      projectsIndexGrid: true
    });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control", confirmCreation: true },
      250
    );

    expect(result).toMatchObject({
      ok: false,
      status: "unsupported",
      blocker: {
        kind: "selector_drift",
        code: "chatgpt_project_routing_selector_drift"
      }
    });
    expect(result.blocker?.message).toContain("2 visible Projects");
    expect(result.blocker?.message).toContain("does not authorize a global fallback");
    expect(result.blocker?.fieldPath).toBe("project");
    expect(fake.actions).not.toContain("create-project");
  });

  it("skips a Project icon whose button or link ancestor is absent", async () => {
    const fake = projectPage({
      directProjectSection: true,
      existingProject: true,
      orphanProjectIcon: true
    });

    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control" },
      250
    );

    expect(result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      blocker: { code: "chatgpt_project_creation_confirmation_required" }
    });
    expect(fake.actions).not.toContain("create-project");
  });

  it("blocks instead of creating a duplicate when Show more cannot be exhausted", async () => {
    const fake = projectPage({
      directProjectSection: true,
      projectsIndexRedirectsHome: true,
      projectRevealAfter: 101
    });
    const result = await openOrCreateProjectForNewThread(
      { page: fake.page },
      { name: "Codex ChatGPT Control", confirmCreation: true },
      250
    );

    expect(result).toMatchObject({
      ok: false,
      status: "unsupported",
      blocker: {
        kind: "selector_drift",
        code: "chatgpt_project_routing_selector_drift"
      }
    });
    expect(result.blocker?.message).toContain("stopped before treating");
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
    const fake = projectPage({ directProjectSection: true });
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

function projectPage(options: {
  directProjectSection?: boolean;
  existingProject?: boolean;
  matchingProjectCount?: number;
  orphanProjectIcon?: boolean;
  projectControlsHydrateAfter?: number;
  projectCardIsLink?: boolean;
  projectHydratesAfter?: number;
  projectRevealAfter?: number;
  projectsIndexRedirectsHome?: boolean;
  projectsIndexGrid?: boolean;
  sidebarHidden?: boolean;
} = {}): { page: PageLike; actions: string[]; navigations: string[] } {
  const actions: string[] = [];
  const navigations: string[] = [];
  let currentUrl = "https://chatgpt.com/";
  let createDialogOpen = false;
  let customizeDialogOpen = false;
  let projectName = "Codex ChatGPT Control";
  let sidebarOpen = options.sidebarHidden !== true;
  let showMoreClicks = 0;
  let waits = 0;

  const projectVisible = (): boolean =>
    sidebarOpen &&
    waits >= (options.projectControlsHydrateAfter ?? 0) &&
    options.existingProject === true &&
    waits >= (options.projectHydratesAfter ?? 0) &&
    showMoreClicks >= (options.projectRevealAfter ?? 0);

  const empty = locator({ count: 0 });
  const projectLink = locator({ count: 1, href: "/g/g-p-test/c/example" });
  const projectItem = locator({
    count: 1,
    locator: selector => selector.includes('/g/g-p-') ? projectLink : empty
  });
  const projectRow = locator({
    count: () => projectVisible() ? 1 : 0,
    text: "Codex ChatGPT Control",
    ...(options.projectCardIsLink === true ? { href: "/g/g-p-test/project" } : {}),
    locator: selector => selector.includes("ancestor::li") ? projectItem : projectRow
  });
  const orphanProjectAncestor = locator({ count: 0, throwOnInnerText: true });
  const projectIcons = locator({
    count: () => projectVisible() && options.projectsIndexGrid !== true ? (options.matchingProjectCount ?? 1) : 0,
    nth: () => locator({
      count: 1,
      locator: () => options.orphanProjectIcon === true ? orphanProjectAncestor : projectRow
    })
  });
  const projectNameCell = locator({ count: 1, text: "Codex ChatGPT Control" });
  const otherGridCell = locator({ count: 1, text: "Yesterday" });
  const projectGridCells = locator({
    count: 3,
    text: "Codex ChatGPT Control",
    nth: index => index === 0 ? projectNameCell : otherGridCell
  });
  const projectGridRow = locator({
    count: 1,
    text: "Codex ChatGPT Control Yesterday",
    click: () => {
      currentUrl = "https://chatgpt.com/g/g-p-test/project";
      actions.push("open-project-row");
    },
    getByRole: role => role === "gridcell" ? projectGridCells : empty
  });
  const projectGridHeader = locator({ count: 1, text: "Name Modified" });
  const projectGridRows = locator({
    count: () => options.projectsIndexGrid === true && projectVisible()
      ? 1 + (options.matchingProjectCount ?? 1)
      : 0,
    nth: index => index === 0 ? projectGridHeader : projectGridRow
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
    goto: async url => {
      currentUrl = url === "https://chatgpt.com/projects" && options.projectsIndexRedirectsHome === true
        ? "https://chatgpt.com/"
        : url;
      navigations.push(url);
    },
    waitForTimeout: async () => { waits += 1; },
    locator: selector => {
      if (selector === '[data-testid="project-folder-icon"]') return projectIcons;
      return empty;
    },
    getByText: text => {
      if (text === "Projects" && options.directProjectSection === true) {
        return locator({
          count: () => sidebarOpen && waits >= (options.projectControlsHydrateAfter ?? 0) ? 1 : 0,
          text: "Projects"
        });
      }
      if (text === "More" && options.directProjectSection === true) {
        return locator({
          count: () => sidebarOpen && waits < (options.projectControlsHydrateAfter ?? 0) ? 1 : 0,
          click: () => actions.push("open-more")
        });
      }
      return empty;
    },
    getByRole: (role, query) => {
      const name = query?.name;
      if (role === "button" && name === "Open sidebar") {
        return locator({
          count: () => sidebarOpen ? 0 : 1,
          click: () => {
            sidebarOpen = true;
            actions.push("open-sidebar");
          }
        });
      }
      if (role === "button" && name === "New project") {
        return locator({
          count: () => sidebarOpen && waits >= (options.projectControlsHydrateAfter ?? 0) ? 1 : 0,
          click: () => { createDialogOpen = true; }
        });
      }
      if (role === "button" && name === "New") {
        return locator({
          count: () => currentUrl === "https://chatgpt.com/projects" ? 1 : 0,
          click: () => { createDialogOpen = true; }
        });
      }
      if (role === "heading" && name === "Projects") {
        return locator({ count: () => currentUrl === "https://chatgpt.com/projects" ? 1 : 0 });
      }
      if (role === "row") return projectGridRows;
      if (role === "button" && name === "Show more") {
        return locator({
          count: () => sidebarOpen && showMoreClicks < (options.projectRevealAfter ?? 0) ? 1 : 0,
          click: () => {
            showMoreClicks += 1;
            actions.push("show-more");
          }
        });
      }
      if (role === "dialog" && name === "Create project") return createDialog;
      if (role === "textbox" && name instanceof RegExp && name.test(`New chat in ${projectName}`)) {
        return locator({ count: currentUrl.includes("/g/g-p-test/project") ? 1 : 0 });
      }
      return empty;
    }
  };

  return { page, actions, navigations };
}

type LocatorOptions = {
  count: number | (() => number);
  text?: string;
  href?: string;
  click?: () => void;
  fill?: (value: string) => void;
  locator?: (selector: string) => LocatorLike;
  nth?: (index: number) => LocatorLike;
  throwOnInnerText?: boolean;
  getByRole?: (role: string, options?: Record<string, unknown>) => LocatorLike;
};

function locator(options: LocatorOptions): LocatorLike {
  return {
    count: async () => typeof options.count === "function" ? options.count() : options.count,
    click: async () => { options.click?.(); },
    fill: async value => { options.fill?.(value); },
    innerText: async () => {
      if (options.throwOnInnerText === true) throw new Error("innerText must not run for a zero-count locator");
      return options.text ?? "";
    },
    getAttribute: async name => name === "href" ? options.href ?? null : null,
    locator: selector => options.locator?.(selector) ?? locator({ count: 0 }),
    nth: index => options.nth?.(index) ?? locator({ count: 0 }),
    first() { return this; },
    last() { return this; },
    getByRole: (role, query) => options.getByRole?.(role, query) ?? locator({ count: 0 })
  };
}
