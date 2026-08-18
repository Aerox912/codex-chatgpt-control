import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tabIdFromPage } from "../../browser/attach.js";
import { redactReportValue } from "../../safety/report-redaction.js";
import type {
  LiveSmokeBrowser,
  LiveSmokeCleanupResult,
  LiveSmokeContext,
  LiveSmokeRunResult,
  LiveSmokeScenario,
  LiveSmokeScenarioResult
} from "./types.js";

const CLEANUP_TIMEOUT_MS = 10_000;

type BrowserTabBaseline =
  | { ok: true; ids: ReadonlySet<string> }
  | { ok: false; reason: string };

export function envFlag(name: string): boolean {
  const value = readEnv(name);
  return value === "1" || value?.toLowerCase() === "true";
}

export function envText(name: string): string | undefined {
  const value = readEnv(name)?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function contextEnvFlag(context: LiveSmokeContext, name: string): boolean {
  const value = contextEnvText(context, name);
  return value === "1" || value?.toLowerCase() === "true";
}

export function contextEnvText(context: LiveSmokeContext, name: string): string | undefined {
  const value = context.env?.[name]?.trim() ?? envText(name);
  return value && value.length > 0 ? value : undefined;
}

function readEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

export async function runScenario(
  scenario: LiveSmokeScenario,
  context: LiveSmokeContext
): Promise<LiveSmokeScenarioResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const tabBaseline = await snapshotBrowserTabIds(context.browser);

  let result: LiveSmokeScenarioResult;
  if (!scenario.enabled(context)) {
    result = {
      name: scenario.name,
      status: "skip",
      required: scenario.required,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      details: { reason: "scenario disabled" }
    };
  } else {
    try {
      result = await scenario.run(context);
    } catch (error) {
      result = {
        name: scenario.name,
        status: "fail",
        required: scenario.required,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  const cleanup = await finalizeBrowserTabs(
    context.cleanupBrowser ?? context.browser,
    context.browser,
    tabBaseline
  );
  return { ...result, cleanup };
}

export async function runLiveSmoke(
  context: LiveSmokeContext,
  scenarios: LiveSmokeScenario[]
): Promise<LiveSmokeRunResult> {
  const results: LiveSmokeScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, context);
    results.push(result);
    console.log(JSON.stringify(redactLiveSmokeResult(result), null, 2));
  }

  const reportPath = await writeReport(context.reportDir, results);
  const failures = requiredFailures(results);
  console.log(JSON.stringify({ reportPath, requiredFailures: failures.map(failure => failure.name) }, null, 2));
  return { reportPath, results, requiredFailures: failures };
}

export async function writeReport(reportDir: string, results: LiveSmokeScenarioResult[]): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const path = join(reportDir, `${stamp}-live-smoke.json`);
  const summary = {
    total: results.length,
    passed: results.filter(result => result.status === "pass").length,
    failed: results.filter(result => result.status === "fail").length,
    skipped: results.filter(result => result.status === "skip").length,
    requiredFailures: requiredFailures(results).map(result => result.name)
  };
  await writeFile(path, `${JSON.stringify({ summary, results: results.map(redactLiveSmokeResult) }, null, 2)}\n`, "utf8");
  return path;
}

export function redactLiveSmokeResult(result: LiveSmokeScenarioResult): LiveSmokeScenarioResult {
  const redacted = redactReportValue(result, { includeContent: false }) as LiveSmokeScenarioResult;
  return {
    ...redacted,
    name: result.name,
    status: result.status,
    required: result.required,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs
  };
}

export function requiredFailures(results: LiveSmokeScenarioResult[]): LiveSmokeScenarioResult[] {
  return results.filter(result => result.required && result.status !== "pass");
}

export function filterScenarios(
  scenarios: LiveSmokeScenario[],
  namesCsv: string | undefined
): LiveSmokeScenario[] {
  if (namesCsv === undefined || namesCsv.trim().length === 0) {
    return scenarios;
  }

  const wanted = new Set(
    namesCsv.split(",")
      .map(name => name.trim())
      .filter(Boolean)
  );
  return scenarios.filter(scenario => wanted.has(scenario.name));
}

async function finalizeBrowserTabs(
  finalizerBrowser: LiveSmokeBrowser | undefined,
  behaviorBrowser: LiveSmokeBrowser | undefined,
  baseline: BrowserTabBaseline
): Promise<LiveSmokeCleanupResult> {
  const finalizerTabs = finalizerBrowser?.tabs;
  const finalize = finalizerTabs?.finalize;
  if (typeof finalize !== "function") {
    return closeNewExactTabs(behaviorBrowser, baseline);
  }

  try {
    await withTimeout(
      finalize.call(finalizerTabs, { keep: [] }),
      CLEANUP_TIMEOUT_MS,
      `browser.tabs.finalize timed out after ${CLEANUP_TIMEOUT_MS}ms`
    );
    return { attempted: true, ok: true };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function snapshotBrowserTabIds(browser: LiveSmokeBrowser | undefined): Promise<BrowserTabBaseline> {
  const tabs = browser?.tabs;
  const list = tabs?.list;
  if (tabs === undefined || typeof list !== "function") {
    return { ok: false, reason: "browser.tabs.list unavailable" };
  }
  try {
    const pages = await list.call(tabs);
    const ids = new Set<string>();
    for (const page of pages) {
      const id = tabIdFromPage(page);
      if (id === undefined) {
        return { ok: false, reason: "browser.tabs.list returned a tab without an exact id" };
      }
      ids.add(id);
    }
    return { ok: true, ids };
  } catch (error) {
    return {
      ok: false,
      reason: `browser.tabs.list failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function closeNewExactTabs(
  browser: LiveSmokeBrowser | undefined,
  baseline: BrowserTabBaseline
): Promise<LiveSmokeCleanupResult> {
  if (!baseline.ok) {
    return { attempted: false, ok: false, reason: baseline.reason };
  }
  const tabs = browser?.tabs;
  const list = tabs?.list;
  const get = tabs?.get;
  if (tabs === undefined || typeof list !== "function" || typeof get !== "function") {
    return {
      attempted: false,
      ok: false,
      reason: "browser.tabs.finalize unavailable and exact tabs.list/get cleanup is unavailable"
    };
  }

  try {
    const pages = await list.call(tabs);
    const newTabIds: string[] = [];
    for (const page of pages) {
      const id = tabIdFromPage(page);
      if (id === undefined) {
        throw new Error("browser.tabs.list returned a tab without an exact id");
      }
      if (!baseline.ids.has(id) && !newTabIds.includes(id)) {
        newTabIds.push(id);
      }
    }

    for (const id of newTabIds) {
      const page = await get.call(tabs, id);
      if (tabIdFromPage(page) !== id) {
        throw new Error(`browser.tabs.get did not preserve exact cleanup affinity for tab ${id}`);
      }
      if (typeof page.close !== "function") {
        throw new Error(`browser tab ${id} does not expose close()`);
      }
      await withTimeout(
        Promise.resolve(page.close()),
        CLEANUP_TIMEOUT_MS,
        `browser tab ${id} close timed out after ${CLEANUP_TIMEOUT_MS}ms`
      );
    }
    return { attempted: true, ok: true, closedTabCount: newTabIds.length };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
