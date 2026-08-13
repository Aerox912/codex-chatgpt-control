import { resultError, resultOk } from "../errors.js";
import type {
  ChatGPTProjectColor,
  ChatGPTProjectIcon,
  ChatGPTProjectRef,
  ChatGPTProjectTarget,
  CommandResult,
  LocatorLike,
  PageLike,
  RuntimeEnv,
  WorkspaceProjectOptions
} from "../types.js";
import { contextFromPage } from "./context.js";

const CHATGPT_HOME = "https://chatgpt.com/";
const PROJECT_ICON_SELECTOR = '[data-testid="project-folder-icon"]';
const PROJECT_PAGE_PATTERN = /\/g\/(g-p-[^/]+)\/project(?:[/?#]|$)/i;

const COLOR_LABELS: Record<ChatGPTProjectColor, string> = {
  default: "Default color, black in light mode, white in dark mode",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink"
};

const SPECIAL_CASING: Record<string, string> = {
  ai: "AI",
  api: "API",
  chatgpt: "ChatGPT",
  cli: "CLI",
  codex: "Codex",
  gpt: "GPT",
  mcp: "MCP",
  rws: "RWS",
  sdk: "SDK",
  ui: "UI",
  ux: "UX"
};

type ResolvedProjectTarget = ChatGPTProjectTarget & {
  icon: ChatGPTProjectIcon;
  color: ChatGPTProjectColor;
};

class ProjectSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSelectorError";
  }
}

export function projectNameFromWorkspacePath(workspacePath: string): string {
  const segments = workspacePath.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  const leaf = segments.at(-1)?.replace(/^\.+/, "") ?? "";
  if (leaf.length === 0) {
    throw new Error("workspaceProject.path must end in a project directory name.");
  }
  return formatProjectName(leaf);
}

export function workspaceProjectTarget(options: WorkspaceProjectOptions): ChatGPTProjectTarget {
  const explicitName = options.name?.trim();
  const name = explicitName !== undefined && explicitName.length > 0
    ? explicitName
    : options.path === undefined
      ? undefined
      : projectNameFromWorkspacePath(options.path);
  if (name === undefined || name.length === 0) {
    throw new Error("workspaceProject requires a non-empty name or path.");
  }

  const suggested = suggestProjectAppearance(name);
  const target: ChatGPTProjectTarget = {
    name,
    icon: options.icon ?? suggested.icon,
    color: options.color ?? suggested.color
  };
  if (options.confirmCreation !== undefined) {
    target.confirmCreation = options.confirmCreation;
  }
  return target;
}

export function suggestProjectAppearance(name: string): {
  icon: ChatGPTProjectIcon;
  color: ChatGPTProjectColor;
} {
  const normalized = normalizeProjectName(name);
  if (matchesAny(normalized, ["codex", "chatgpt", "code", "sdk", "api", "plugin", "agent", "repo"])) {
    return { icon: "Code Brackets", color: "purple" };
  }
  if (matchesAny(normalized, ["terminal", "cli", "shell", "console"])) {
    return { icon: "Terminal", color: "red" };
  }
  if (matchesAny(normalized, ["document", "docs", "write", "writing", "blog", "content"])) {
    return { icon: "Writing", color: "orange" };
  }
  if (matchesAny(normalized, ["finance", "trade", "trading", "analytics", "metrics", "data"])) {
    return { icon: "Bar Chart", color: "green" };
  }
  if (matchesAny(normalized, ["mind", "brain", "intelligence", "research"])) {
    return { icon: "Brain", color: "purple" };
  }
  if (matchesAny(normalized, ["design", "art", "image", "visual", "brand"])) {
    return { icon: "Palette", color: "pink" };
  }
  if (matchesAny(normalized, ["travel", "trip", "flight"])) {
    return { icon: "Plane", color: "blue" };
  }
  if (matchesAny(normalized, ["health", "medical", "doctor"])) {
    return { icon: "Stethoscope", color: "green" };
  }
  if (matchesAny(normalized, ["test", "lab", "experiment"])) {
    return { icon: "Flask", color: "blue" };
  }
  if (matchesAny(normalized, ["game", "video", "movie"])) {
    return { icon: "Popcorn", color: "orange" };
  }
  if (matchesAny(normalized, ["infra", "system", "tool", "control"])) {
    return { icon: "Wrench", color: "blue" };
  }
  return { icon: "Folder", color: "blue" };
}

export function projectNamesMatch(expected: string, candidate: string): boolean {
  return normalizeProjectName(expected) === normalizeProjectName(candidate);
}

export async function openOrCreateProjectForNewThread(
  env: RuntimeEnv,
  input: ChatGPTProjectTarget,
  timeoutMs = 30000
): Promise<CommandResult<ChatGPTProjectRef>> {
  const page = env.page;
  if (page === undefined) {
    return resultError(new Error("No active ChatGPT page is available for project routing."), {});
  }

  let project: ResolvedProjectTarget;
  try {
    project = resolveProjectTarget(input);
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
  }

  try {
    const currentUrl = await pageUrl(page);
    if (currentUrl !== undefined && PROJECT_PAGE_PATTERN.test(currentUrl) && await projectComposerVisible(page, project.name)) {
      return resultOk(projectRef(project, normalizeProjectPageUrl(currentUrl), false), await contextFromPage(page));
    }

    await page.goto?.(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout?.(500);
    if (!await revealProjectList(page)) {
      throw new ProjectSelectorError("ChatGPT Projects were not available in the visible sidebar.");
    }

    const row = await findProjectRow(page, project.name);
    if (row !== undefined) {
      const url = await resolveProjectPageUrl(page, row, timeoutMs);
      if (url === undefined) {
        throw new ProjectSelectorError(`The matching ChatGPT Project "${project.name}" was visible, but its project home URL could not be resolved.`);
      }
      await openProjectPage(page, url, project.name, timeoutMs);
      return resultOk(projectRef(project, url, false), await contextFromPage(page));
    }

    if (project.confirmCreation !== true) {
      return {
        ok: false,
        status: "needs_confirmation",
        warnings: [],
        blocker: {
          kind: "confirmation",
          code: "chatgpt_project_creation_confirmation_required",
          fieldPath: "project.confirmCreation",
          message: `No matching ChatGPT Project exists. Creating "${project.name}" with the ${project.color} ${project.icon} icon changes visible ChatGPT account state. Re-run with confirmCreation: true after user approval.`,
          remediation: [
            {
              label: "Confirm ChatGPT Project creation",
              instruction: `Ask the user to approve creating the ChatGPT Project "${project.name}" with the ${project.color} ${project.icon} icon.`,
              userActionRequired: true
            }
          ],
          resumable: true
        },
        context: await contextFromPage(page)
      };
    }

    const createdUrl = await createProject(page, project, timeoutMs);
    return resultOk(projectRef(project, createdUrl, true), await contextFromPage(page));
  } catch (error) {
    if (error instanceof ProjectSelectorError) {
      return projectSelectorFailure(page, error.message);
    }
    return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
  }
}

function formatProjectName(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map(word => SPECIAL_CASING[word.toLowerCase()] ?? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ");
}

function normalizeProjectName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function matchesAny(normalizedName: string, terms: string[]): boolean {
  return terms.some(term => normalizedName.includes(normalizeProjectName(term)));
}

function resolveProjectTarget(input: ChatGPTProjectTarget): ResolvedProjectTarget {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error("project.name must be non-empty.");
  }
  const suggested = suggestProjectAppearance(name);
  return {
    name,
    icon: input.icon ?? suggested.icon,
    color: input.color ?? suggested.color,
    ...(input.confirmCreation === undefined ? {} : { confirmCreation: input.confirmCreation })
  };
}

async function revealProjectList(page: PageLike): Promise<boolean> {
  if (await locatorCount(page.getByRole?.("button", { name: "New project", exact: true })) === 0) {
    const more = page.getByText?.("More", { exact: true });
    if (await locatorCount(more) > 0) {
      await more?.first?.().click?.();
      await page.waitForTimeout?.(200);
      await page.locator?.("body").press?.("Escape");
    }
  }

  const projects = page.getByRole?.("button", { name: "Projects", exact: true });
  if (await locatorCount(projects) > 0) {
    const projectsButton = projects?.first?.();
    const expanded = await projectsButton?.getAttribute?.("aria-expanded");
    if (expanded === "false") {
      await projectsButton?.click?.();
      await page.waitForTimeout?.(150);
    }
  }
  return await locatorCount(page.getByRole?.("button", { name: "New project", exact: true })) > 0;
}

async function findProjectRow(page: PageLike, name: string): Promise<LocatorLike | undefined> {
  for (let pass = 0; pass < 8; pass += 1) {
    const row = await findVisibleProjectRow(page, name);
    if (row !== undefined) return row;

    const showMore = page.getByRole?.("button", { name: "Show more", exact: true });
    if (await locatorCount(showMore) === 0) return undefined;
    await showMore?.last?.().click?.();
    await page.waitForTimeout?.(200);
  }
  return findVisibleProjectRow(page, name);
}

async function findVisibleProjectRow(page: PageLike, name: string): Promise<LocatorLike | undefined> {
  const icons = page.locator?.(PROJECT_ICON_SELECTOR);
  const iconCount = await locatorCount(icons);
  for (let index = 0; index < iconCount; index += 1) {
    const row = icons?.nth?.(index).locator?.("xpath=ancestor::*[@role='button'][1]");
    const text = (await row?.innerText?.())?.trim();
    if (text !== undefined && projectNamesMatch(name, text)) return row;
  }

  const buttons = page.getByRole?.("button", { name: new RegExp(escapeRegex(name), "i") });
  const buttonCount = await locatorCount(buttons);
  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons?.nth?.(index);
    const text = (await button?.innerText?.())?.trim();
    if (text !== undefined && projectNamesMatch(name, text)) return button;
  }
  return undefined;
}

async function resolveProjectPageUrl(page: PageLike, row: LocatorLike, timeoutMs: number): Promise<string | undefined> {
  await row.click?.({ force: true });
  await page.waitForTimeout?.(150);
  const item = row.locator?.("xpath=ancestor::li[1]");
  const projectLinks = item?.locator?.('a[href*="/g/g-p-"]');
  if (await locatorCount(projectLinks) > 0) {
    const href = await projectLinks?.first?.()?.getAttribute?.("href");
    const projectUrl = href === null || href === undefined ? undefined : projectPageUrlFromHref(href);
    if (projectUrl !== undefined) return projectUrl;
  }

  const home = item?.getByRole?.("button", { name: "Open project home", exact: true });
  if (await locatorCount(home) > 0) {
    await home?.click?.({ force: true });
    return waitForAnyProjectPageUrl(page, timeoutMs);
  }
  return undefined;
}

async function openProjectPage(page: PageLike, url: string, name: string, timeoutMs: number): Promise<void> {
  if (normalizeProjectPageUrl((await pageUrl(page)) ?? "") !== url) {
    await page.goto?.(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }
  if (!await waitForProjectHome(page, name, timeoutMs)) {
    throw new ProjectSelectorError(`ChatGPT opened the Project URL for "${name}", but its new-chat composer did not become visible.`);
  }
}

async function createProject(page: PageLike, project: ResolvedProjectTarget, timeoutMs: number): Promise<string> {
  const createButton = page.getByRole?.("button", { name: "New project", exact: true });
  if (await locatorCount(createButton) !== 1) {
    throw new ProjectSelectorError("The visible New project control was missing or ambiguous.");
  }
  await createButton?.click?.();

  const dialog = page.getByRole?.("dialog", { name: "Create project", exact: true });
  if (!await waitForLocator(dialog, page, 3000)) {
    throw new ProjectSelectorError("The Create project dialog did not open.");
  }
  const nameInput = dialog?.getByRole?.("textbox", { name: "Project name", exact: true });
  if (await locatorCount(nameInput) !== 1) {
    throw new ProjectSelectorError("The Project name field was missing or ambiguous.");
  }
  await nameInput?.fill?.(project.name);

  const appearanceButton = dialog?.getByRole?.("button", { name: /Open project icon and color menu/i });
  if (await locatorCount(appearanceButton) !== 1) {
    throw new ProjectSelectorError("The project icon and color control was missing or ambiguous.");
  }
  await appearanceButton?.click?.();

  const customize = dialog?.getByRole?.("dialog", { name: "Customize Project Icon", exact: true });
  if (!await waitForLocator(customize, page, 3000)) {
    throw new ProjectSelectorError("The project icon and color menu did not open.");
  }
  const color = customize?.getByRole?.("radio", { name: COLOR_LABELS[project.color], exact: true });
  const icon = customize?.getByRole?.("radio", { name: project.icon, exact: true });
  if (await locatorCount(color) !== 1 || await locatorCount(icon) !== 1) {
    throw new ProjectSelectorError(`The requested ${project.color} ${project.icon} project appearance was not available.`);
  }
  await color?.click?.({ force: true });
  await icon?.click?.({ force: true });
  const done = customize?.getByRole?.("button", { name: "Done", exact: true });
  if (await locatorCount(done) !== 1) {
    throw new ProjectSelectorError("The project appearance confirmation control was missing or ambiguous.");
  }
  await done?.click?.();

  const submit = dialog?.getByRole?.("button", { name: "Create project", exact: true });
  if (await locatorCount(submit) !== 1) {
    throw new ProjectSelectorError("The Create project confirmation control was missing or ambiguous.");
  }
  await submit?.click?.();
  if (!await waitForProjectHome(page, project.name, timeoutMs)) {
    throw new ProjectSelectorError(`ChatGPT did not verify the new Project "${project.name}" after creation.`);
  }
  const url = await pageUrl(page);
  if (url === undefined || !PROJECT_PAGE_PATTERN.test(url)) {
    throw new ProjectSelectorError(`ChatGPT created "${project.name}", but its Project URL could not be verified.`);
  }
  return normalizeProjectPageUrl(url);
}

async function waitForProjectHome(page: PageLike, name: string, timeoutMs: number): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 250));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const url = await pageUrl(page);
    if (url !== undefined && PROJECT_PAGE_PATTERN.test(url) && await projectComposerVisible(page, name)) return true;
    await page.waitForTimeout?.(250);
  }
  return false;
}

async function projectComposerVisible(page: PageLike, name: string): Promise<boolean> {
  const composer = page.getByRole?.("textbox", { name: new RegExp(`^New chat in ${escapeRegex(name)}$`, "i") });
  return await locatorCount(composer) > 0;
}

async function waitForAnyProjectPageUrl(page: PageLike, timeoutMs: number): Promise<string | undefined> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 250));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const url = await pageUrl(page);
    if (url !== undefined && PROJECT_PAGE_PATTERN.test(url)) return normalizeProjectPageUrl(url);
    await page.waitForTimeout?.(250);
  }
  return undefined;
}

async function waitForLocator(locator: LocatorLike | undefined, page: PageLike, timeoutMs: number): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await locatorCount(locator) > 0) return true;
    await page.waitForTimeout?.(100);
  }
  return false;
}

function projectPageUrlFromHref(href: string): string | undefined {
  try {
    const parsed = new URL(href, CHATGPT_HOME);
    if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") return undefined;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const gIndex = segments.indexOf("g");
    const handle = gIndex >= 0 ? segments[gIndex + 1] : undefined;
    if (handle === undefined || !handle.startsWith("g-p-")) return undefined;
    return `${CHATGPT_HOME}g/${handle}/project`;
  } catch {
    return undefined;
  }
}

function normalizeProjectPageUrl(value: string): string {
  return projectPageUrlFromHref(value) ?? value;
}

async function pageUrl(page: PageLike): Promise<string | undefined> {
  return page.url === undefined ? undefined : Promise.resolve(page.url());
}

async function locatorCount(locator: LocatorLike | undefined): Promise<number> {
  if (locator?.count === undefined) return 0;
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

function projectRef(project: ResolvedProjectTarget, url: string, created: boolean): ChatGPTProjectRef {
  const ref: ChatGPTProjectRef = {
    name: project.name,
    url,
    created
  };
  if (created) {
    ref.icon = project.icon;
    ref.color = project.color;
  }
  return ref;
}

async function projectSelectorFailure(page: PageLike, message: string): Promise<CommandResult<ChatGPTProjectRef>> {
  return {
    ok: false,
    status: "unsupported",
    warnings: [],
    blocker: {
      kind: "selector_drift",
      code: "chatgpt_project_routing_selector_drift",
      message,
      remediation: [
        {
          label: "Review visible Projects UI",
          instruction: "Open ChatGPT Projects and verify the project list, Create project dialog, and project new-chat composer are still available.",
          userActionRequired: true
        }
      ],
      resumable: false
    },
    context: await contextFromPage(page)
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
