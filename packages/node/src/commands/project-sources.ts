import { localeLabels, anyLabelPattern } from "../dom/locale-labels.js";
import { resultError, resultOk } from "../errors.js";
import type {
  BootstrapArgs,
  CommandResult,
  FileChooserLike,
  LocatorLike,
  PageLike,
  ProjectSource,
  ProjectSourcesAddArgs,
  ProjectSourcesAddData,
  ProjectSourcesAddPlanData,
  ProjectSourcesListArgs,
  ProjectSourcesListData,
  ProjectSourcesPlanAddArgs,
  ProjectSourcesUrl,
  ProjectSourceUploadBatch,
  RuntimeEnv
} from "../types.js";
import { contextFromPage } from "./context.js";
import { preflightFiles } from "./files.js";
import { bootstrap } from "./session.js";
import { coordinatedEventRegistrationBarrier } from "../runtime/coordinated-page.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const DEFAULT_PROJECT_SOURCE_BATCH_SIZE = 10;
const PROJECT_SOURCE_CANDIDATE_LIMIT = 20;
// The chooser transition is a short UI handoff. It must not inherit the much
// longer file-handoff/refresh timeout: doing so can leave a rejected browser
// event pending for minutes and can make us try a second UI path after an
// ambiguous first action. The public timeout can shorten this budget, but
// never extend it.
const PROJECT_SOURCE_CHOOSER_TRANSITION_TIMEOUT_MS = 2500;
const PROJECT_SOURCE_CHOOSER_POLL_INTERVAL_MS = 25;

type SafeCandidate = NonNullable<NonNullable<CommandResult["blocker"]>["candidates"]>[number];

type ProjectSourcesSnapshot = {
  sources: ProjectSource[];
  uiPresent: boolean;
  candidates: SafeCandidate[];
};

export function normalizeProjectSourcesUrl(value: string): ProjectSourcesUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ChatGPT Project URL must be an absolute URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("ChatGPT Project URL must use https.");
  }
  if (parsed.hostname !== "chatgpt.com") {
    throw new Error("ChatGPT Project URL must be on chatgpt.com.");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const gIndex = segments.indexOf("g");
  const handle = gIndex >= 0 ? segments[gIndex + 1] : undefined;
  if (handle === undefined || !handle.startsWith("g-p-")) {
    throw new Error("ChatGPT Project URL must include a Project path such as /g/g-p-.../project.");
  }

  const { projectId, projectSlug } = splitProjectHandle(handle);
  const normalized: ProjectSourcesUrl = {
    projectId,
    url: `${CHATGPT_ORIGIN}/g/${handle}/project`
  };
  if (projectSlug !== undefined) {
    normalized.projectSlug = projectSlug;
  }
  return normalized;
}

export async function buildProjectSourceAddPlan(
  env: RuntimeEnv,
  args: ProjectSourcesPlanAddArgs
): Promise<CommandResult<ProjectSourcesAddPlanData>> {
  let project: ProjectSourcesUrl;
  try {
    project = normalizeProjectSourcesUrl(args.projectUrl);
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)));
  }

  const preflightArgs: Parameters<typeof preflightFiles>[1] = { paths: args.files };
  if (args.maxBytesPerFile !== undefined) preflightArgs.maxBytesPerFile = args.maxBytesPerFile;
  if (args.maxTotalBytes !== undefined) preflightArgs.maxTotalBytes = args.maxTotalBytes;
  const preflight = await preflightFiles(env, preflightArgs);
  if (!preflight.ok || preflight.data === undefined) {
    return preflight as CommandResult<ProjectSourcesAddPlanData>;
  }

  const files = preflight.data.files.map((file, index) => ({
    ...file,
    displayPath: args.files[index] ?? file.path
  }));
  const batchSize = normalizedBatchSize(args.batchSize);
  const batches: ProjectSourceUploadBatch[] = [];
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batchFiles = files.slice(offset, offset + batchSize);
    batches.push({
      index: batches.length,
      files: batchFiles,
      totalBytes: batchFiles.reduce((sum, file) => sum + file.bytes, 0)
    });
  }

  return resultOk({
    ...project,
    projectUrl: project.url,
    operation: "append_add",
    dryRun: true,
    files,
    batches,
    totalBytes: preflight.data.totalBytes
  }, { timestamp: preflight.context.timestamp }, preflight.warnings);
}

export async function listProjectSources(
  env: RuntimeEnv,
  args: ProjectSourcesListArgs
): Promise<CommandResult<ProjectSourcesListData>> {
  const opened = await openProjectSourcesUI(env, args);
  if (!opened.ok || opened.data === undefined) {
    return opened as CommandResult<ProjectSourcesListData>;
  }

  return readProjectSourcesFromCurrentPage(env, opened.data, "project_sources_list_unavailable");
}

export async function addProjectSources(
  env: RuntimeEnv,
  args: ProjectSourcesAddArgs
): Promise<CommandResult<ProjectSourcesAddData | ProjectSourcesAddPlanData>> {
  const plan = await buildProjectSourceAddPlan(env, args);
  if (!plan.ok || plan.data === undefined) {
    return plan as unknown as CommandResult<ProjectSourcesAddData | ProjectSourcesAddPlanData>;
  }

  if (args.confirmMutation !== true) {
    return {
      ok: false,
      status: "needs_confirmation",
      data: plan.data,
      warnings: plan.warnings,
      blocker: {
        kind: "confirmation",
        code: "project_sources_add_confirmation_required",
        fieldPath: "confirmMutation",
        message: "Adding files to a ChatGPT Project Sources list mutates visible project state. Re-run with confirmMutation: true after user approval.",
        remediation: [
          {
            label: "Confirm Project Sources add",
            instruction: "Ask the user to confirm this append-only Project Sources add operation for the listed local file names.",
            userActionRequired: true
          }
        ],
        resumable: true
      },
      context: plan.context
    };
  }

  const opened = await openProjectSourcesUI(env, args);
  if (!opened.ok || opened.data === undefined) {
    return opened as unknown as CommandResult<ProjectSourcesAddData | ProjectSourcesAddPlanData>;
  }

  const before = await readProjectSourcesFromCurrentPage(env, opened.data, "project_sources_list_unavailable");
  if (!before.ok || before.data === undefined) {
    return before as unknown as CommandResult<ProjectSourcesAddData | ProjectSourcesAddPlanData>;
  }

  const page = env.page;
  if (page === undefined) {
    return resultError(new Error("No active ChatGPT Project page is available for Project Sources upload."), opened.context);
  }

  for (const batch of plan.data.batches) {
    const upload = await uploadProjectSourceBatch(page, batch, args.timeoutMs ?? 120000);
    if (!upload.ok) {
      return upload as CommandResult<ProjectSourcesAddData>;
    }
  }

  await page.waitForTimeout?.(1000);
  const after = await readProjectSourcesFromCurrentPage(env, opened.data, "project_sources_after_add_unavailable");
  if (!after.ok || after.data === undefined) {
    return after as unknown as CommandResult<ProjectSourcesAddData | ProjectSourcesAddPlanData>;
  }

  return resultOk({
    ...plan.data,
    dryRun: false,
    before: before.data.sources,
    after: after.data.sources,
    added: diffProjectSourceNames(before.data.sources, after.data.sources)
  }, await contextFromPage(page), [...plan.warnings, ...before.warnings, ...after.warnings]);
}

export function diffProjectSourceNames(before: ProjectSource[], after: ProjectSource[]): ProjectSource[] {
  const remaining = new Map<string, number>();
  for (const source of before) {
    const key = sourceNameKey(source.name);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const added: ProjectSource[] = [];
  for (const source of after) {
    const key = sourceNameKey(source.name);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      added.push(source);
    }
  }
  return added;
}

export function extractProjectSourcesFromHtml(html: string): ProjectSource[] {
  const sources: ProjectSource[] = [];
  const sourceBlockPattern = /<(?:div|li|article|tr)\b(?<attrs>[^>]*(?:data-testid|aria-label|class)=["'][^"']*source[^"']*["'][^>]*)>(?<body>[\s\S]*?)<\/(?:div|li|article|tr)>/gi;

  for (const match of html.matchAll(sourceBlockPattern)) {
    const body = match.groups?.body ?? "";
    const texts = extractChildTexts(body, ["span", "td", "button", "a"]);
    const name = texts.map(sourceNameFromCandidateText).find((text): text is string => text !== undefined);
    if (name === undefined) {
      continue;
    }
    const statusText = texts.find(text => text !== name && normalizeProjectSourceStatus(text) !== "unknown");
    sources.push({ name, status: normalizeProjectSourceStatus(statusText ?? "") });
  }

  sources.push(...extractSourcesSectionRowsFromHtml(html));

  return dedupeAdjacentSources(sources);
}

export function safeProjectSourceCandidatesFromHtml(html: string): SafeCandidate[] {
  const candidates: SafeCandidate[] = [];
  const interactivePattern = /<(button|a)\b(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/\1>/gi;

  for (const match of html.matchAll(interactivePattern)) {
    const tag = match[1]?.toLowerCase();
    const attrs = match.groups?.attrs ?? "";
    const text = normalizeText(stripTags(match.groups?.body ?? ""));
    const label = normalizeText(attr(attrs, "aria-label") ?? attr(attrs, "title") ?? text);
    if (label.length === 0 || label.length > 120) {
      continue;
    }
    const roleAttr = attr(attrs, "role");
    const role = roleAttr ?? (tag === "a" ? "link" : "button");
    candidates.push({ label, role });
  }

  return dedupeCandidates(candidates).slice(0, PROJECT_SOURCE_CANDIDATE_LIMIT);
}

async function openProjectSourcesUI(
  env: RuntimeEnv,
  args: ProjectSourcesListArgs | ProjectSourcesAddArgs
): Promise<CommandResult<ProjectSourcesUrl>> {
  let project: ProjectSourcesUrl;
  try {
    project = normalizeProjectSourcesUrl(args.projectUrl);
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)));
  }

  if (env.page === undefined) {
    const boot = await bootstrap(env, bootstrapArgsForProject(project.url, args));
    if (!boot.ok) {
      return boot as unknown as CommandResult<ProjectSourcesUrl>;
    }
  }

  const page = env.page;
  if (page === undefined) {
    return resultError(new Error("No active ChatGPT page is available."), { timestamp: new Date().toISOString() });
  }

  try {
    const currentUrl = await Promise.resolve(page.url?.()).catch(() => undefined);
    if (!sameProjectPageUrl(currentUrl, project.url) && typeof page.goto === "function") {
      await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs ?? 30000 });
      await page.waitForTimeout?.(500);
    }
    await clickSourcesTabIfAvailable(page, args.timeoutMs ?? 30000);
    return resultOk(project, await contextFromPage(page));
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
  }
}

function bootstrapArgsForProject(
  url: string,
  args: ProjectSourcesListArgs | ProjectSourcesAddArgs
): BootstrapArgs {
  const boot: BootstrapArgs = { url };
  if (args.preferExistingTab !== undefined) {
    boot.preferExistingTab = args.preferExistingTab;
  }

  if (args.existingTab === true) {
    boot.existingTab = {
      target: { type: "url", url },
      ifMissing: "block",
      ifMultiple: "block",
      requireChatGPT: true
    };
  } else if (args.existingTab !== undefined) {
    boot.existingTab = args.existingTab;
  }

  return boot;
}

async function readProjectSourcesFromCurrentPage(
  env: RuntimeEnv,
  project: ProjectSourcesUrl,
  driftCode: string
): Promise<CommandResult<ProjectSourcesListData>> {
  const page = env.page;
  if (page === undefined) {
    return resultError(new Error("No active ChatGPT Project page is available for Project Sources listing."), project);
  }

  const snapshot = await readProjectSourcesSnapshot(page);
  if (snapshot.uiPresent) {
    return resultOk({ ...project, sources: snapshot.sources }, await contextFromPage(page));
  }

  return {
    ok: false,
    status: "unsupported",
    warnings: [],
    blocker: {
      kind: "selector_drift",
      code: driftCode,
      message: "The visible ChatGPT Project Sources UI could not be identified without reading source contents.",
      candidates: snapshot.candidates,
      resumable: true
    },
    context: await contextFromPage(page)
  };
}

async function readProjectSourcesSnapshot(page: PageLike): Promise<ProjectSourcesSnapshot> {
  if (typeof page.evaluate === "function") {
    try {
      const raw = await page.evaluate(() => {
        const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
        const textOf = (element: Element) => normalize((element as HTMLElement).innerText ?? element.textContent ?? "");
        const statusFor = (text: string) => {
          if (/\b(ready|added|available|synced)\b/i.test(text)) return "ready";
          if (/\b(processing|uploading|adding|pending|in progress)\b/i.test(text)) return "processing";
          if (/\b(failed|error|unsupported)\b/i.test(text)) return "failed";
          return "unknown";
        };
        const excludedLabel = (text: string) => /^(ready|processing|uploading|failed|error|add sources?|sources?|newest|all|source actions)$/i.test(text)
          || /^(sort|filter) sources?:/i.test(text);
        const sourceNameFromCandidate = (text: string) => {
          const normalized = normalize(text).replace(/\s+(Document|File|PDF|Image|Spreadsheet|Text|Code|CSV|Markdown)\s+·.*$/i, "");
          if (normalized.length === 0 || normalized.length > 160 || excludedLabel(normalized)) return undefined;
          return normalized;
        };
        const sourceNodes = Array.from(document.querySelectorAll([
          "li[data-testid*='source' i]",
          "article[data-testid*='source' i]",
          "tr[data-testid*='source' i]",
          "div[data-testid*='source' i]",
          "li[aria-label*='source' i]",
          "article[aria-label*='source' i]",
          "tr[aria-label*='source' i]",
          "div[aria-label*='source' i]",
          "li[class*='source' i]",
          "article[class*='source' i]",
          "tr[class*='source' i]",
          "div[class*='source' i]"
        ].join(", "))).filter(node => {
          const tag = node.tagName.toLowerCase();
          const role = node.getAttribute("role") ?? "";
          return tag !== "button"
            && tag !== "a"
            && !/^(button|tab|menuitem|option|dialog|menu)$/i.test(role)
            && node.closest("[role='dialog'], [role='menu']") === null;
        });
        const sourcesFromNodes = sourceNodes.flatMap(node => {
          const children = Array.from(node.querySelectorAll("span, td, button, a"))
            .map(textOf)
            .filter(Boolean);
          const name = children.map(sourceNameFromCandidate).find(Boolean);
          if (!name) return [];
          const statusText = children.find(child => child !== name && statusFor(child) !== "unknown") ?? "";
          return [{ name, status: statusFor(statusText) }];
        });
        const sourcesFromSection = Array.from(document.querySelectorAll("section[aria-label]"))
          .filter(section => /sources?/i.test(section.getAttribute("aria-label") ?? "") && section.closest("[role='dialog'], [role='menu']") === null)
          .flatMap(section => Array.from(section.querySelectorAll("[aria-label], button")).flatMap(element => {
            const role = element.getAttribute("role") ?? "";
            if (/^(tab|menuitem|option)$/i.test(role)) return [];
            const aria = normalize(element.getAttribute("aria-label") ?? "");
            const text = textOf(element);
            const name = sourceNameFromCandidate(aria) ?? sourceNameFromCandidate(text);
            if (!name) return [];
            const status = statusFor(text);
            return [{ name, status }];
          }));
        const sources = [...sourcesFromNodes, ...sourcesFromSection];
        const candidates = Array.from(document.querySelectorAll("[role='tab'], button, a"))
          .map(element => {
            const label = normalize(element.getAttribute("aria-label") ?? element.getAttribute("title") ?? textOf(element));
            const role = element.getAttribute("role") ?? (element.tagName.toLowerCase() === "a" ? "link" : "button");
            return { label, role };
          })
          .filter(candidate => candidate.label.length > 0 && candidate.label.length <= 120)
          .slice(0, 20);
        const activeSourceTab = Array.from(document.querySelectorAll("[role='tab'], button"))
          .some(element => {
            const label = textOf(element) || element.getAttribute("aria-label") || "";
            return /sources?/i.test(label) && element.getAttribute("aria-selected") === "true";
          });
        const emptyState = /\bno sources\b/i.test(document.body?.innerText ?? "");
        return {
          sources,
          uiPresent: sources.length > 0 || activeSourceTab || emptyState,
          candidates
        };
      });
      return normalizeSnapshot(raw);
    } catch {
      // Fall through to HTML extraction.
    }
  }

  if (typeof page.content === "function") {
    const html = await page.content();
    const sources = extractProjectSourcesFromHtml(html);
    const activeSourceTab = /role=["']tab["'][^>]*aria-selected=["']true["'][^>]*>\s*Sources\s*</i.test(html)
      || /aria-label=["']Sources["'][^>]*aria-selected=["']true["']/i.test(html);
    const emptyState = /\bno sources\b/i.test(stripInteractiveHtml(html));
    return {
      sources,
      uiPresent: sources.length > 0 || activeSourceTab || emptyState,
      candidates: safeProjectSourceCandidatesFromHtml(html)
    };
  }

  return { sources: [], uiPresent: false, candidates: [] };
}

function normalizeSnapshot(raw: unknown): ProjectSourcesSnapshot {
  if (raw === null || typeof raw !== "object") {
    return { sources: [], uiPresent: false, candidates: [] };
  }
  const record = raw as Record<string, unknown>;
  const sources = Array.isArray(record.sources)
    ? record.sources.flatMap(item => isRecord(item) && typeof item.name === "string"
      ? [{ name: normalizeText(item.name), status: normalizeProjectSourceStatus(String(item.status ?? "")) }]
      : [])
    : [];
  const candidates = Array.isArray(record.candidates)
    ? dedupeCandidates(record.candidates.flatMap(item => {
      if (!isRecord(item) || typeof item.label !== "string") {
        return [];
      }
      const candidate: SafeCandidate = { label: normalizeText(item.label) };
      if (typeof item.role === "string") {
        candidate.role = item.role;
      }
      return [candidate];
    }))
    : [];
  return {
    sources: dedupeAdjacentSources(sources.filter(source => source.name.length > 0)),
    uiPresent: record.uiPresent === true,
    candidates: candidates.slice(0, PROJECT_SOURCE_CANDIDATE_LIMIT)
  };
}

async function uploadProjectSourceBatch(
  page: PageLike,
  batch: ProjectSourceUploadBatch,
  timeoutMs: number
): Promise<CommandResult<unknown>> {
  const paths = batch.files.map(file => file.path);

  try {
    const directInput = page.locator?.("input[type='file']");
    if (directInput !== undefined && typeof directInput.setInputFiles === "function" && await locatorCount(directInput) > 0) {
      await directInput.setInputFiles(paths);
      return resultOk({ files: batch.files.map(file => ({ name: file.name, bytes: file.bytes })) }, await contextFromPage(page));
    }

    if (typeof page.waitForEvent !== "function") {
      throw new Error("The active Project Sources page does not expose file chooser events.");
    }

    const chooserTransitionTimeoutMs = Math.min(timeoutMs, PROJECT_SOURCE_CHOOSER_TRANSITION_TIMEOUT_MS);
    const chooserDeadline = Date.now() + chooserTransitionTimeoutMs;
    // Validate the first visible mutation before subscribing to the chooser.
    // A missing or ambiguous control must not leave a 2.5s bridge waiter alive.
    const addSource = await waitForUniqueVisibleProjectSourceControl(
      page,
      localeLabels.projectSourcesAddSource,
      "button",
      chooserDeadline
    );
    if (addSource.kind !== "ready") {
      throw new Error(projectSourceControlDiscoveryMessage(addSource, "button", localeLabels.projectSourcesAddSource));
    }

    const remainingChooserTimeoutMs = chooserDeadline - Date.now();
    if (remainingChooserTimeoutMs <= 0) {
      throw new Error("Project Sources Add source control was not ready before the chooser transition deadline.");
    }

    // Start exactly one handled waiter synchronously immediately before the
    // first visible mutation. The listener is therefore installed before the
    // click can deliver a chooser event, while synchronous bridge throws are
    // converted into an already-handled terminal outcome.
    const chooserWait = startFileChooserWait(page, remainingChooserTimeoutMs);

    // Fence coordinated provider registration and drain already-scheduled
    // settlement before crossing the first visible mutation boundary.
    const beforeAddOutcome = await settleChooserBeforeMutation(chooserWait, chooserDeadline);
    if (beforeAddOutcome !== undefined) {
      throw chooserOutcomeError(beforeAddOutcome, undefined, "Add source");
    }

    let addSourceError: unknown;
    try {
      await clickProjectSourceControlLocator(page, addSource.locator, chooserDeadline);
    } catch (error) {
      addSourceError = error;
    }

    // A click can deliver the browser gesture and still reject at the bridge
    // boundary. Reconcile a late chooser success instead of issuing a second
    // Add/Upload action. A rejection is returned deterministically as the
    // chooser outcome, with the click failure retained as context.
    if (addSourceError !== undefined) {
      const outcome = await awaitFileChooserOutcome(chooserWait, chooserDeadline);
      if (outcome.kind === "success") {
        await setProjectSourceChooserFiles(outcome.chooser, paths, timeoutMs);
        return resultOk({ files: batch.files.map(file => ({ name: file.name, bytes: file.bytes })) }, await contextFromPage(page));
      }
      throw chooserOutcomeError(outcome, addSourceError, "Add source");
    }

    // Let a chooser event delivered during the Add click finish its handled
    // microtask before deciding whether the optional menu path is necessary.
    await Promise.resolve();
    const afterAddOutcome = chooserWait.outcome;
    if (afterAddOutcome?.kind === "success") {
      await setProjectSourceChooserFiles(afterAddOutcome.chooser, paths, timeoutMs);
      return resultOk({ files: batch.files.map(file => ({ name: file.name, bytes: file.bytes })) }, await contextFromPage(page));
    }
    if (afterAddOutcome?.kind === "rejected") {
      throw chooserOutcomeError(afterAddOutcome, undefined, "Add source");
    }

    const uploadControl = await waitForChooserOrUploadControl(
      page,
      localeLabels.projectSourcesUploadFiles,
      "button",
      chooserWait,
      chooserDeadline
    );
    if (uploadControl.kind === "chooser") {
      if (uploadControl.outcome.kind === "success") {
        await setProjectSourceChooserFiles(uploadControl.outcome.chooser, paths, timeoutMs);
        return resultOk({ files: batch.files.map(file => ({ name: file.name, bytes: file.bytes })) }, await contextFromPage(page));
      }
      throw chooserOutcomeError(uploadControl.outcome, undefined, "Add source");
    }
    if (uploadControl.kind !== "ready") {
      throw new Error(uploadControl.kind === "timeout"
        ? uploadControl.message
        : projectSourceControlDiscoveryMessage(uploadControl, "button", localeLabels.projectSourcesUploadFiles));
    }

    // Final settled-outcome gate: discovery may have yielded while the
    // chooser promise settled. Do not click Upload when the original waiter
    // has already produced either terminal outcome.
    await Promise.resolve();
    const settledBeforeUpload = chooserWait.outcome;
    if (settledBeforeUpload?.kind === "success") {
      await setProjectSourceChooserFiles(settledBeforeUpload.chooser, paths, timeoutMs);
      return resultOk({ files: batch.files.map(file => ({ name: file.name, bytes: file.bytes })) }, await contextFromPage(page));
    }
    if (settledBeforeUpload?.kind === "rejected") {
      throw chooserOutcomeError(settledBeforeUpload, undefined, "Add source");
    }

    let uploadError: unknown;
    try {
      await clickProjectSourceControlLocator(page, uploadControl.locator, chooserDeadline);
    } catch (error) {
      uploadError = error;
    }

    const outcome = await awaitFileChooserOutcome(chooserWait, chooserDeadline);
    if (outcome.kind === "success") {
      await setProjectSourceChooserFiles(outcome.chooser, paths, timeoutMs);
      return resultOk({ files: batch.files.map(file => ({ name: file.name, bytes: file.bytes })) }, await contextFromPage(page));
    }
    throw chooserOutcomeError(outcome, uploadError, "Upload files");
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: {
        kind: "permission",
        code: "project_sources_upload_unavailable",
        message: `Project Sources file upload could not be completed through visible file chooser controls: ${error instanceof Error ? error.message : String(error)}`,
        remediation: [
          {
            label: "Use visible Project Sources UI",
            instruction: "Open the Project Sources tab, click Add source, choose the local file upload option, and retry after the browser file chooser is available.",
            userActionRequired: true
          }
        ],
        resumable: true
      },
      context: await contextFromPage(page)
    };
  }
}

async function clickSourcesTabIfAvailable(page: PageLike, timeoutMs: number): Promise<void> {
  try {
    await clickProjectSourceControl(page, localeLabels.projectSourcesTab, "tab", timeoutMs);
  } catch {
    // Listing will report selector_drift with safe candidates if the tab is not discoverable.
  }
}

async function clickProjectSourceControl(
  page: PageLike,
  labels: readonly string[],
  role: "button" | "tab",
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // The Sources tab is a navigation aid, not part of the chooser transition.
  // Keep its best-effort lookup bounded to one DOM observation so a page that
  // lacks the tab still reaches the existing selector-drift fallback promptly.
  const candidate = await discoverUniqueVisibleProjectSourceControl(page, labels, role);
  if (candidate.kind !== "ready") {
    throw new Error(projectSourceControlDiscoveryMessage(candidate, role, labels));
  }
  await clickProjectSourceControlLocator(page, candidate.locator, deadline);
  if (role === "tab") {
    await page.waitForTimeout?.(250);
  }
}

type FileChooserOutcome =
  | { kind: "success"; chooser: FileChooserLike }
  | { kind: "rejected"; error: unknown };

type FileChooserWait = {
  promise: Promise<FileChooserOutcome>;
  outcome?: FileChooserOutcome;
  registration?: Promise<void>;
};

function startFileChooserWait(page: PageLike, timeoutMs: number): FileChooserWait {
  const wait: FileChooserWait = {
    promise: Promise.resolve({
      kind: "rejected" as const,
      error: new Error("Project Sources file chooser wait was not initialized.")
    })
  };

  let rawWait: unknown;
  try {
    // Invoke waitForEvent in this call stack. Deferring registration through a
    // Promise.resolve().then() can let an immediately-triggered Add click race
    // the listener and lose the chooser event.
    rawWait = page.waitForEvent?.("filechooser", { timeout: timeoutMs, timeoutMs });
  } catch (error) {
    const outcome: FileChooserOutcome = { kind: "rejected", error };
    wait.outcome = outcome;
    wait.promise = Promise.resolve(outcome);
    return wait;
  }

  const registration = coordinatedEventRegistrationBarrier(rawWait);
  if (registration !== undefined) wait.registration = registration;
  wait.promise = Promise.resolve(rawWait).then(
    rawChooser => {
      const outcome: FileChooserOutcome = isProjectSourceFileChooserLike(rawChooser)
        ? { kind: "success", chooser: rawChooser }
        : {
          kind: "rejected",
          error: new Error("Project Sources file chooser did not expose setFiles().")
        };
      wait.outcome = outcome;
      return outcome;
    },
    error => {
      const outcome: FileChooserOutcome = { kind: "rejected", error };
      wait.outcome = outcome;
      return outcome;
    }
  );
  return wait;
}

/**
 * Prove that a coordinated event listener finished registration before a
 * click. One host turn then drains any outcome that was already scheduled;
 * such an outcome cannot causally belong to the not-yet-issued click and
 * therefore blocks the handoff.
 */
async function settleChooserBeforeMutation(
  chooserWait: FileChooserWait,
  deadline: number
): Promise<FileChooserOutcome | { kind: "timeout" } | undefined> {
  if (chooserWait.outcome !== undefined) return chooserWait.outcome;
  if (chooserWait.registration !== undefined) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { kind: "timeout" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const registered = await Promise.race([
      chooserWait.registration.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), remainingMs); })
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (!registered) return { kind: "timeout" };
  }
  if (chooserWait.outcome !== undefined) return chooserWait.outcome;
  if (deadline <= Date.now()) return { kind: "timeout" };
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (chooserWait.outcome !== undefined) return chooserWait.outcome;
  return deadline <= Date.now() ? { kind: "timeout" } : undefined;
}

async function awaitFileChooserOutcome(
  chooserWait: FileChooserWait,
  deadline: number
): Promise<FileChooserOutcome | { kind: "timeout" }> {
  if (chooserWait.outcome !== undefined) {
    return chooserWait.outcome;
  }

  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    return { kind: "timeout" };
  }

  return new Promise(resolve => {
    let finished = false;
    const finish = (outcome: FileChooserOutcome | { kind: "timeout" }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), remainingMs);
    // The chooser promise is always handled and never rejects. The timer is
    // cleared when the event wins, avoiding a dangling transition timer.
    void chooserWait.promise.then(outcome => finish(outcome));
  });
}

type ProjectSourceControlDiscovery =
  | { kind: "ready"; locator: LocatorLike }
  | { kind: "absent" }
  | { kind: "invalid"; message: string };

function projectSourceControlDiscoveryMessage(
  discovery: Exclude<ProjectSourceControlDiscovery, { kind: "ready" }>,
  role: "button" | "tab",
  labels: readonly string[]
): string {
  if (discovery.kind === "invalid") {
    return discovery.message;
  }
  return `Project Sources ${role} was not uniquely visible for labels: ${labels.join(", ")}`;
}

async function waitForUniqueVisibleProjectSourceControl(
  page: PageLike,
  labels: readonly string[],
  role: "button" | "tab",
  deadline: number
): Promise<ProjectSourceControlDiscovery> {
  while (true) {
    const candidate = await discoverUniqueVisibleProjectSourceControl(page, labels, role);
    if (candidate.kind !== "absent") {
      return candidate;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        kind: "invalid",
        message: `Project Sources ${role} was not uniquely visible before the chooser transition deadline for labels: ${labels.join(", ")}`
      };
    }
    await waitForProjectSourceTransitionTick(page, Math.min(PROJECT_SOURCE_CHOOSER_POLL_INTERVAL_MS, remainingMs));
  }
}

async function discoverUniqueVisibleProjectSourceControl(
  page: PageLike,
  labels: readonly string[],
  role: "button" | "tab"
): Promise<ProjectSourceControlDiscovery> {
  const pattern = anyLabelPattern(labels);
  const primary = page.getByRole?.(role, { name: pattern });
  const candidate = primary !== undefined && await locatorCount(primary) > 0
    ? primary
    : page.locator?.(
      labels
        .map(label => `button[aria-label*='${cssString(label)}'], [role='${role}'][aria-label*='${cssString(label)}']`)
        .join(", ")
    );

  if (candidate === undefined) {
    return { kind: "absent" };
  }

  const count = await locatorCount(candidate);
  if (count === 0) {
    return { kind: "absent" };
  }
  if (count !== 1) {
    return {
      kind: "invalid",
      message: `Project Sources ${role} was not uniquely available for labels: ${labels.join(", ")} (found ${count} controls).`
    };
  }
  if (typeof candidate.isVisible !== "function") {
    return {
      kind: "invalid",
      message: `Project Sources ${role} visibility could not be verified for labels: ${labels.join(", ")}.`
    };
  }
  if (!await candidate.isVisible().catch(() => false)) {
    return {
      kind: "invalid",
      message: `Project Sources ${role} was present but hidden for labels: ${labels.join(", ")}.`
    };
  }
  return { kind: "ready", locator: candidate };
}

async function waitForChooserOrUploadControl(
  page: PageLike,
  labels: readonly string[],
  role: "button" | "tab",
  chooserWait: FileChooserWait,
  deadline: number
): Promise<ProjectSourceControlDiscovery | { kind: "chooser"; outcome: FileChooserOutcome } | { kind: "timeout"; message: string }> {
  while (true) {
    if (chooserWait.outcome !== undefined) {
      return { kind: "chooser", outcome: chooserWait.outcome };
    }

    const candidate = await discoverUniqueVisibleProjectSourceControl(page, labels, role);
    if (candidate.kind !== "absent") {
      // A chooser rejection may race the final control observation. Prefer the
      // already-settled browser outcome over reporting stale menu ambiguity.
      if (chooserWait.outcome !== undefined) {
        return { kind: "chooser", outcome: chooserWait.outcome };
      }
      return candidate;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        kind: "timeout",
        message: `Project Sources file chooser did not settle and Upload control did not become uniquely visible before the ${PROJECT_SOURCE_CHOOSER_TRANSITION_TIMEOUT_MS}ms chooser transition deadline.`
      };
    }
    await waitForChooserOrTransitionTick(page, chooserWait, Math.min(PROJECT_SOURCE_CHOOSER_POLL_INTERVAL_MS, remainingMs));
  }
}

async function waitForChooserOrTransitionTick(
  page: PageLike,
  chooserWait: FileChooserWait,
  waitMs: number
): Promise<void> {
  if (chooserWait.outcome !== undefined) return;
  await Promise.race([
    chooserWait.promise.then(() => undefined),
    waitForProjectSourceTransitionTick(page, waitMs)
  ]);
}

async function waitForProjectSourceTransitionTick(page: PageLike, waitMs: number): Promise<void> {
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(waitMs);
    return;
  }
  await new Promise<void>(resolve => setTimeout(resolve, waitMs));
}

async function clickProjectSourceControlLocator(
  page: PageLike,
  locator: LocatorLike,
  deadline: number
): Promise<void> {
  if (typeof locator.click !== "function") {
    throw new Error("Project Sources control does not expose click().");
  }
  const remainingMs = Math.max(1, deadline - Date.now());
  await locator.click({ timeout: Math.min(remainingMs, 10_000) });
}

async function setProjectSourceChooserFiles(
  chooser: FileChooserLike,
  paths: string[],
  timeoutMs: number
): Promise<void> {
  await chooser.setFiles(paths, { timeoutMs });
}

function chooserOutcomeError(
  outcome: FileChooserOutcome | { kind: "timeout" },
  clickError: unknown,
  controlLabel: string
): Error {
  if (outcome.kind === "rejected") {
    const chooserMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const clickMessage = clickError === undefined
      ? ""
      : ` ${controlLabel} click also failed: ${clickError instanceof Error ? clickError.message : String(clickError)}`;
    return new Error(`Project Sources file chooser was rejected: ${chooserMessage}.${clickMessage}`);
  }
  if (outcome.kind === "timeout") {
    const clickMessage = clickError === undefined
      ? ""
      : ` ${controlLabel} click failed: ${clickError instanceof Error ? clickError.message : String(clickError)}.`;
    return new Error(`Project Sources file chooser did not settle before the ${PROJECT_SOURCE_CHOOSER_TRANSITION_TIMEOUT_MS}ms chooser transition deadline.${clickMessage}`);
  }
  return new Error(`Project Sources file chooser settled before the ${controlLabel} click; no file handoff was attempted.`);
}

function isProjectSourceFileChooserLike(value: unknown): value is FileChooserLike {
  return value !== null
    && typeof value === "object"
    && typeof (value as FileChooserLike).setFiles === "function";
}

async function locatorCount(locator: LocatorLike): Promise<number> {
  if (typeof locator.count !== "function") {
    return 0;
  }
  return locator.count();
}

function normalizedBatchSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PROJECT_SOURCE_BATCH_SIZE;
  }
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PROJECT_SOURCE_BATCH_SIZE;
}

function splitProjectHandle(handle: string): { projectId: string; projectSlug?: string } {
  const match = /^(g-p-[0-9a-f]{16,})(?:-(.+))?$/i.exec(handle);
  if (match === null) {
    return { projectId: handle };
  }
  const result: { projectId: string; projectSlug?: string } = { projectId: match[1]! };
  if (match[2] !== undefined && match[2].length > 0) {
    result.projectSlug = match[2];
  }
  return result;
}

function sameProjectPageUrl(current: string | undefined, expected: string): boolean {
  if (current === undefined) {
    return false;
  }
  try {
    const currentUrl = new URL(current);
    const expectedUrl = new URL(expected);
    return currentUrl.origin === expectedUrl.origin
      && trimTrailingSlash(currentUrl.pathname) === trimTrailingSlash(expectedUrl.pathname);
  } catch {
    return false;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function sourceNameKey(value: string): string {
  return normalizeText(value).toLocaleLowerCase();
}

function extractChildTexts(html: string, tags: string[]): string[] {
  const tagPattern = tags.join("|");
  const pattern = new RegExp(`<(${tagPattern})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "gi");
  return Array.from(html.matchAll(pattern))
    .map(match => normalizeText(stripTags(match[2] ?? "")))
    .filter(Boolean);
}

function extractAttrValues(html: string, name: string): string[] {
  const pattern = new RegExp(`${name}=["']([^"']+)["']`, "gi");
  return Array.from(html.matchAll(pattern))
    .map(match => normalizeText(match[1] ?? ""))
    .filter(Boolean);
}

function looksLikeSourceName(text: string): boolean {
  return text.length > 0
    && text.length <= 160
    && !/^(ready|processing|uploading|failed|error|add sources?|sources?|newest|all|source actions)$/i.test(text)
    && !/^(sort|filter) sources?:/i.test(text);
}

function sourceNameFromCandidateText(text: string): string | undefined {
  const name = normalizeText(text)
    .replace(/\s+(Document|File|PDF|Image|Spreadsheet|Text|Code|CSV|Markdown)\s+·.*$/i, "");
  return looksLikeSourceName(name) ? name : undefined;
}

function extractSourcesSectionRowsFromHtml(html: string): ProjectSource[] {
  const sources: ProjectSource[] = [];
  const sectionPattern = /<section\b(?<attrs>[^>]*aria-label=["']Sources["'][^>]*)>(?<body>[\s\S]*?)<\/section>/gi;
  for (const match of html.matchAll(sectionPattern)) {
    const body = match.groups?.body ?? "";
    const texts = [
      ...extractAttrValues(body, "aria-label"),
      ...extractChildTexts(body, ["button"])
    ];
    for (const text of texts) {
      const name = sourceNameFromCandidateText(text);
      if (name !== undefined) {
        sources.push({ name, status: normalizeProjectSourceStatus(text) });
      }
    }
  }
  return dedupeAdjacentSources(sources);
}

function normalizeProjectSourceStatus(value: string): ProjectSource["status"] {
  if (/\b(ready|added|available|synced)\b/i.test(value)) return "ready";
  if (/\b(processing|uploading|adding|pending|in progress)\b/i.test(value)) return "processing";
  if (/\b(failed|error|unsupported)\b/i.test(value)) return "failed";
  return "unknown";
}

function dedupeAdjacentSources(sources: ProjectSource[]): ProjectSource[] {
  const deduped: ProjectSource[] = [];
  for (const source of sources) {
    const previous = deduped.at(-1);
    if (previous?.name === source.name && previous.status === source.status) {
      continue;
    }
    deduped.push(source);
  }
  return deduped;
}

function dedupeCandidates(candidates: SafeCandidate[]): SafeCandidate[] {
  const seen = new Set<string>();
  const deduped: SafeCandidate[] = [];
  for (const candidate of candidates) {
    const label = normalizeText(candidate.label);
    if (label.length === 0) {
      continue;
    }
    const role = candidate.role === undefined ? undefined : normalizeText(candidate.role);
    const key = `${role ?? ""}\0${label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const item: SafeCandidate = { label };
    if (role !== undefined && role.length > 0) {
      item.role = role;
    }
    deduped.push(item);
  }
  return deduped;
}

function attr(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}=["']([^"']+)["']`, "i");
  return pattern.exec(attrs)?.[1];
}

function stripInteractiveHtml(html: string): string {
  return html.replace(/<(button|a)\b[\s\S]*?<\/\1>/gi, " ");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
