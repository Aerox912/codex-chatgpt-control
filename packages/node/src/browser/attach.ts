import { BrowserBridgeUnavailableError, ChatGPTControlError, LoginRequiredError } from "../errors.js";
import type { BootstrapArgs, BrowserLike, BrowserUserTabInfo, ExistingTabDiagnostics, ExistingTabPolicy, ExistingTabTarget, PageLike, RuntimeEnv } from "../types.js";
import { CHATGPT_HOME, isChatGPTUrl } from "./chatgpt-url.js";
import { parseConversationId, readPageState } from "./page-state.js";
import {
  createCoordinatedBrowser,
  createCoordinatedPageForBrowser,
  unwrapCoordinatedBrowser,
  type CoordinatedBrowserOptions
} from "../runtime/coordinated-browser.js";
import {
  normalizeBrowserProvider as normalizeBrowser,
  normalizePageProvider as normalizePage,
  unwrapPageProvider
} from "./provider-normalization.js";

const MAX_EXISTING_TAB_DIAGNOSTIC_CANDIDATES = 10;
const MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH = 240;

type ExistingTabSelectionOutcome = {
  page?: PageLike;
  diagnostics?: ExistingTabDiagnostics;
};

export type AttachedBrowser = {
  browser: BrowserLike;
  page: PageLike;
  browserName: string;
  tabId?: string;
};

export async function attachChatGPTBrowser(
  env: RuntimeEnv,
  args: BootstrapArgs = {},
  coordination?: CoordinatedBrowserOptions
): Promise<AttachedBrowser> {
  const browser = await getBrowser(env, coordination);
  const page = await getOrCreateChatGPTPage(browser, env, args, coordination);
  await assertPageOnChatGPTOrigin(page);
  const state = await readPageState(page);
  if (!isChatGPTUrl(state.url)) throw unsafeChatGPTOriginError();

  if (state.blocker?.kind === "login_required") {
    throw new LoginRequiredError(state.blocker.visibleText);
  }

  const attached: AttachedBrowser = {
    browser,
    page,
    browserName: browser.name ?? "chrome"
  };

  const tabId = tabIdFromPage(page);
  if (tabId !== undefined) {
    attached.tabId = tabId;
  }

  return attached;
}

/** Resolve the configured provider browser without selecting, claiming, or creating a tab. */
export async function resolveChatGPTBrowser(
  env: RuntimeEnv,
  coordination?: CoordinatedBrowserOptions
): Promise<BrowserLike> {
  return await getBrowser(env, coordination);
}

async function getBrowser(
  env: RuntimeEnv,
  coordination?: CoordinatedBrowserOptions
): Promise<BrowserLike> {
  if (env.browser !== undefined) {
    if (unwrapCoordinatedBrowser(env.browser) !== env.browser) {
      return env.browser;
    }
    const normalized = normalizeBrowser(env.browser);
    if (normalized !== undefined) {
      return createCoordinatedBrowser(normalized, coordination);
    }
  }

  const anyEnv = env as Record<string, unknown>;
  const agent = env.agent ?? anyEnv.agent ?? (globalThis as Record<string, unknown>).agent;
  const browsers = (agent as { browsers?: unknown } | undefined)?.browsers;

  if (browsers !== undefined && typeof browsers === "object") {
    const maybeBrowser = await tryBrowserGet(browsers, "iab")
      ?? await tryBrowserGetPreferredListed(browsers)
      ?? await tryBrowserGet(browsers, "extension")
      ?? await tryBrowserGet(browsers, "chrome");

    if (maybeBrowser !== undefined) {
      return createCoordinatedBrowser(maybeBrowser, coordination);
    }
  }

  throw new BrowserBridgeUnavailableError();
}

async function tryBrowserGet(browsers: unknown, name: string): Promise<BrowserLike | undefined> {
  const get = (browsers as { get?: (browserName: string) => Promise<unknown> | unknown }).get;
  if (typeof get !== "function") {
    return undefined;
  }

  try {
    const browser = await get.call(browsers, name);
    const normalized = normalizeBrowser(browser);
    if (normalized !== undefined && normalized.name === undefined) {
      normalized.name = browserNameFromSelector(name);
    }
    return normalized;
  } catch {
    return undefined;
  }
}

async function tryBrowserGetFirst(browsers: unknown): Promise<BrowserLike | undefined> {
  const list = (browsers as { list?: () => Promise<unknown[]> | unknown[] }).list;
  const get = (browsers as { get?: (browserName: string) => Promise<unknown> | unknown }).get;

  if (typeof list !== "function" || typeof get !== "function") {
    return undefined;
  }

  try {
    const names = await list.call(browsers);
    const first = names.find(name => typeof name === "string") as string | undefined;
    if (first === undefined) {
      return undefined;
    }
    const browser = await get.call(browsers, first);
    return normalizeBrowser(browser);
  } catch {
    return undefined;
  }
}

async function tryBrowserGetPreferredListed(browsers: unknown): Promise<BrowserLike | undefined> {
  const list = (browsers as { list?: () => Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>> }).list;
  const get = (browsers as { get?: (browserName: string) => Promise<unknown> | unknown }).get;

  if (typeof list !== "function" || typeof get !== "function") {
    return undefined;
  }

  try {
    const available = await list.call(browsers);
    const preferred = available.find(browser => browser.type === "iab")
      ?? available.find(browser => browser.type === "extension")
      ?? available.find(browser => typeof browser.name === "string" && /chrome/i.test(browser.name))
      ?? available[0];
    const id = preferred?.id;
    if (typeof id !== "string") {
      return undefined;
    }
    const browser = await get.call(browsers, id);
    const normalized = normalizeBrowser(browser);
    if (normalized !== undefined && normalized.name === undefined) {
      normalized.name = browserNameFromSelector(
        preferred?.type === "iab" ? "iab" : preferred?.type === "extension" ? "extension" : id
      );
    }
    return normalized;
  } catch {
    return undefined;
  }
}

function browserNameFromSelector(selector: string): string {
  if (selector === "iab") return "iab";
  if (selector === "extension" || selector === "chrome") return "chrome";
  return selector;
}

async function getOrCreateChatGPTPage(
  browser: BrowserLike,
  env: RuntimeEnv,
  args: BootstrapArgs,
  coordination?: CoordinatedBrowserOptions
): Promise<PageLike> {
  const targetUrl = args.url ?? CHATGPT_HOME;
  assertSafeChatGPTNavigation(targetUrl);
  const explicitExistingPolicy = normalizeExplicitExistingTabPolicy(args);

  if (env.page !== undefined) {
    // An invocation can begin with a page captured before browser discovery.
    // Rebind it to the discovered browser-wide actor, unwrapping only through
    // the explicit seam so a page is never nested under two coordinators.
    const cached = createCoordinatedPageForBrowser(normalizePage(env.page), browser, coordination);
    if (await cachedPageMatchesBootstrapArgs(cached, args, explicitExistingPolicy)) {
      return cached;
    }
  }

  if (explicitExistingPolicy !== undefined) {
    const existing = await selectExistingTab(browser, explicitExistingPolicy);
    if (existing.page !== undefined) {
      return existing.page;
    }

    const ifMissing = explicitExistingPolicy.ifMissing ?? "block";
    if (ifMissing === "block") {
      throw new ExistingTabSelectionError(
        "No already-open ChatGPT tab matched the requested existing-tab target.",
        "existing_tab_not_found",
        existing.diagnostics?.candidateTabs,
        existing.diagnostics
      );
    }
    const missingUrl = ifMissing === "open"
      ? urlFromExistingTarget(explicitExistingPolicy.target) ?? targetUrl
      : targetUrl;
    const created = await createTab(browser, missingUrl);
    if (created !== undefined) {
      return created;
    }
    throw new BrowserBridgeUnavailableError("Codex can access a browser object, but no tab creation API was found.");
  }

  if (args.preferExistingTab !== false) {
    const existing = await findExistingChatGPTTab(browser);
    if (existing !== undefined) {
      return existing;
    }
  }

  const created = await createTab(browser, targetUrl);
  if (created !== undefined) {
    return created;
  }

  throw new BrowserBridgeUnavailableError("Codex can access a browser object, but no tab creation API was found.");
}

async function cachedPageMatchesBootstrapArgs(
  page: PageLike,
  args: BootstrapArgs,
  explicitExistingPolicy: ExistingTabPolicy | undefined
): Promise<boolean> {
  if (explicitExistingPolicy !== undefined) {
    return pageMatchesExistingTarget(page, explicitExistingPolicy);
  }

  if (args.preferExistingTab === false) {
    return false;
  }

  const currentUrl = await Promise.resolve(page.url?.()).catch(() => undefined);
  if (!isChatGPTUrl(currentUrl)) {
    return false;
  }

  if (args.url !== undefined) {
    return urlMatches(currentUrl, args.url);
  }

  return true;
}

function normalizeExplicitExistingTabPolicy(args: BootstrapArgs): ExistingTabPolicy | undefined {
  if (args.existingTab === undefined) {
    return undefined;
  }
  if (args.existingTab === true) {
    return {
      target: { type: "selected", host: "chatgpt" },
      ifMissing: "block",
      ifMultiple: "first",
      requireChatGPT: true
    };
  }
  if (args.existingTab === false) {
    return undefined;
  }
  return {
    requireChatGPT: true,
    ifMissing: "block",
    ifMultiple: args.existingTab.target?.type === "selected" ? "first" : "block",
    ...args.existingTab
  };
}

async function selectExistingTab(browser: BrowserLike, policy: ExistingTabPolicy): Promise<ExistingTabSelectionOutcome> {
  const userMatch = await selectExistingUserTab(browser, policy, shouldCollectExistingTabDiagnostics(policy));
  if (userMatch.page !== undefined) {
    return userMatch;
  }

  if (policy.target?.type === "selected" && typeof browser.tabs?.selected === "function") {
    const selected = await Promise.resolve(browser.tabs.selected.call(browser.tabs)).catch(() => undefined);
    if (selected !== undefined) {
      const normalized = normalizePage(selected);
      if (await pageMatchesExistingTarget(normalized, policy)) {
        return { page: normalized };
      }
    }
  }

  if (policy.target?.type === "tabId" && typeof browser.tabs?.get === "function") {
    const tab = await Promise.resolve(browser.tabs.get.call(browser.tabs, policy.target.tabId)).catch(() => undefined);
    if (tab !== undefined) {
      const normalized = normalizePage(tab);
      if (await pageMatchesExistingTarget(normalized, policy)) {
        return { page: normalized };
      }
    }
  }

  if (typeof browser.tabs?.list === "function") {
    const controlled = await Promise.resolve(browser.tabs.list.call(browser.tabs)).catch(() => []);
    const matches: PageLike[] = [];
    for (const candidate of controlled) {
      const page = await hydrateTab(browser, candidate);
      if (await pageMatchesExistingTarget(page, policy)) matches.push(page);
    }
    if (matches.length === 1 || (matches.length > 1 && (policy.ifMultiple ?? "block") === "first")) {
      return { page: matches[0]! };
    }
    if (matches.length > 1) {
      throw new ExistingTabSelectionError(
        "Multiple already-controlled ChatGPT tabs matched the requested existing-tab target.",
        "existing_tab_ambiguous"
      );
    }
  }

  return userMatch.diagnostics === undefined
    ? { diagnostics: diagnosticsForUnavailableUserTabs(policy) }
    : userMatch;
}

async function selectExistingUserTab(
  browser: BrowserLike,
  policy: ExistingTabPolicy,
  collectDiagnostics: boolean
): Promise<ExistingTabSelectionOutcome> {
  const openTabs = browser.user?.openTabs;
  const claimTab = browser.user?.claimTab;
  if (typeof openTabs !== "function" || typeof claimTab !== "function") {
    return {};
  }

  const tabs = await Promise.resolve(openTabs.call(browser.user)).catch(() => undefined);
  if (tabs === undefined) {
    return collectDiagnostics
      ? { diagnostics: diagnosticsForUnavailableUserTabs(policy, "user_open_tabs_unavailable") }
      : {};
  }
  const matches = tabs.filter(tab => userTabMatchesTarget(tab, policy));
  const diagnostics = collectDiagnostics ? diagnosticsForUserTabs(policy, tabs, matches) : undefined;

  if (matches.length === 0) {
    return diagnostics === undefined ? {} : { diagnostics };
  }

  if (matches.length > 1 && (policy.ifMultiple ?? "block") !== "first") {
    throw new ExistingTabSelectionError(
      "Multiple already-open ChatGPT tabs matched the requested existing-tab target.",
      "existing_tab_ambiguous",
      matches,
      diagnostics
    );
  }

  const selected = matches[0]!;
  const page = normalizePage(await claimTab.call(browser.user, selected));
  await assertPageOnChatGPTOrigin(page);
  return diagnostics === undefined ? { page } : { page, diagnostics };
}

function userTabMatchesTarget(tab: BrowserUserTabInfo, policy: ExistingTabPolicy): boolean {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  const requireChatGPT = policy.requireChatGPT ?? targetRequiresChatGPT(target);
  if (requireChatGPT && !isChatGPTUrl(tab.url)) {
    return false;
  }

  switch (target.type) {
    case "selected":
      return target.host === undefined || target.host === "chatgpt" ? isChatGPTUrl(tab.url) : true;
    case "tabId":
      return tab.id === target.tabId;
    case "conversationId":
    case "conversation_id":
      return parseConversationId(tab.url ?? "") === target.conversationId;
    case "url":
      return urlMatches(tab.url, target.url);
    case "title":
      return titleMatches(tab.title, target.title, target.exact ?? true);
  }
}

function diagnosticsForUserTabs(
  policy: ExistingTabPolicy,
  tabs: BrowserUserTabInfo[],
  matches: BrowserUserTabInfo[]
): ExistingTabDiagnostics {
  const chatgptTabs = tabs.filter(tab => isChatGPTUrl(tab.url));
  const candidateTabs = matches.length > 1 ? matches : chatgptTabs;
  const cappedTabs = candidateTabs.slice(0, MAX_EXISTING_TAB_DIAGNOSTIC_CANDIDATES);
  const diagnostics: ExistingTabDiagnostics = {
    requestedTarget: diagnosticTarget(policy.target ?? { type: "selected", host: "chatgpt" }),
    userOpenTabsAvailable: true,
    chatgptTabCount: chatgptTabs.length,
    mismatchReason: matches.length > 1 ? "multiple_candidates" : mismatchReasonForNoMatches(policy, tabs, chatgptTabs),
    candidateTabs: cappedTabs.map(diagnosticCandidate)
  };
  const omittedCandidateCount = candidateTabs.length - cappedTabs.length;
  if (omittedCandidateCount > 0) diagnostics.omittedCandidateCount = omittedCandidateCount;
  return diagnostics;
}

function shouldCollectExistingTabDiagnostics(policy: ExistingTabPolicy): boolean {
  return (policy.ifMissing ?? "block") === "block" || (policy.ifMultiple ?? "block") !== "first";
}

function diagnosticsForUnavailableUserTabs(
  policy: ExistingTabPolicy,
  mismatchReason: ExistingTabDiagnostics["mismatchReason"] | undefined = undefined
): ExistingTabDiagnostics {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  return {
    requestedTarget: diagnosticTarget(target),
    userOpenTabsAvailable: false,
    chatgptTabCount: 0,
    mismatchReason: mismatchReason ?? (target.type === "tabId" ? "explicit_tab_id_not_open" : "selected_tab_unavailable"),
    candidateTabs: []
  };
}

function diagnosticTarget(target: ExistingTabTarget): ExistingTabDiagnostics["requestedTarget"] {
  switch (target.type) {
    case "selected": {
      const value: ExistingTabDiagnostics["requestedTarget"] = { type: target.type };
      if (target.host !== undefined) value.host = target.host;
      return value;
    }
    case "tabId":
      return { type: target.type, tabId: target.tabId };
    case "conversationId":
    case "conversation_id":
      return { type: target.type, conversationId: target.conversationId };
    case "url":
      return { type: target.type, url: target.url };
    case "title": {
      const value: ExistingTabDiagnostics["requestedTarget"] = { type: target.type, title: target.title };
      if (target.exact !== undefined) value.exact = target.exact;
      return value;
    }
  }
}

function diagnosticCandidate(tab: BrowserUserTabInfo): ExistingTabDiagnostics["candidateTabs"][number] {
  const candidate: ExistingTabDiagnostics["candidateTabs"][number] = { id: tab.id };
  if (tab.url !== undefined) {
    candidate.url = truncateDiagnosticField(tab.url);
    const conversationId = parseConversationId(tab.url);
    if (conversationId !== undefined) candidate.conversationId = conversationId;
  }
  if (tab.title !== undefined) candidate.title = truncateDiagnosticField(tab.title);
  if (tab.lastOpened !== undefined) candidate.lastOpened = truncateDiagnosticField(tab.lastOpened);
  if (tab.tabGroup !== undefined) candidate.tabGroup = truncateDiagnosticField(tab.tabGroup);
  return candidate;
}

function truncateDiagnosticField(value: string): string {
  return value.length <= MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH
    ? value
    : `${value.slice(0, MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH - 1)}…`;
}

function mismatchReasonForNoMatches(
  policy: ExistingTabPolicy,
  tabs: BrowserUserTabInfo[],
  chatgptTabs: BrowserUserTabInfo[]
): ExistingTabDiagnostics["mismatchReason"] {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  if (tabs.length === 0) return "no_candidate";
  if (chatgptTabs.length === 0 && (policy.requireChatGPT ?? targetRequiresChatGPT(target))) {
    return "non_chatgpt_tab";
  }
  switch (target.type) {
    case "tabId":
      return tabs.some(tab => tab.id === target.tabId) ? "non_chatgpt_tab" : "explicit_tab_id_not_open";
    case "conversationId":
    case "conversation_id":
      return "conversation_id_mismatch";
    case "url":
      return "url_mismatch";
    case "title":
      return "title_mismatch";
    case "selected":
      return "selected_tab_unavailable";
  }
}

async function pageMatchesExistingTarget(page: PageLike, policy: ExistingTabPolicy): Promise<boolean> {
  const url = await Promise.resolve(page.url?.()).catch(() => undefined);
  const title = await Promise.resolve(page.title?.()).catch(() => undefined);
  const tab: BrowserUserTabInfo = { id: tabIdFromPage(page) ?? "" };
  if (url !== undefined) tab.url = url;
  if (title !== undefined) tab.title = title;
  return userTabMatchesTarget(tab, policy);
}

async function findExistingChatGPTTab(browser: BrowserLike): Promise<PageLike | undefined> {
  // Reuse a tab already controlled by this browser session before attempting
  // to claim an external user tab. Claiming a tab that is still associated
  // with an interrupted host call can otherwise wait on a stale control lock
  // until the next bounded browser call is killed.
  const selected = browser.tabs?.selected;
  if (typeof selected === "function") {
    try {
      const current = await selected.call(browser.tabs);
      if (current !== undefined) {
        const normalized = normalizePage(current);
        try {
          if (isChatGPTUrl(await normalized.url?.())) {
            return normalized;
          }
        } catch {
          // Continue to full tab list.
        }
      }
    } catch {
      // No selected tab is a normal fresh-browser state.
    }
  }

  const list = browser.tabs?.list;
  if (typeof list === "function") {
    const tabs = await list.call(browser.tabs);
    const normalized = await Promise.all(tabs.map(tab => hydrateTab(browser, tab)));
    for (const tab of normalized) {
      try {
        if (isChatGPTUrl(await tab.url?.())) {
          return tab;
        }
      } catch {
        // Keep looking.
      }
    }
  }

  const userTab = await selectExistingUserTab(browser, {
    target: { type: "selected", host: "chatgpt" },
    ifMultiple: "first",
    requireChatGPT: true
  }, false).catch(error => {
    if (error instanceof ChatGPTControlError
      && error.blockerDetails.code === "unsafe_chatgpt_origin") {
      throw error;
    }
    return { page: undefined };
  });
  if (userTab.page !== undefined) {
    return userTab.page;
  }
  return undefined;
}

class ExistingTabSelectionError extends ChatGPTControlError {
  constructor(
    message: string,
    code: string,
    candidates: BrowserUserTabInfo[] = [],
    diagnostics?: ExistingTabDiagnostics
  ) {
    const details: ConstructorParameters<typeof ChatGPTControlError>[4] = {
      code,
      candidates: candidates.map(tab => ({ label: userTabCandidateLabel(tab) })),
      remediation: [
        {
          label: "Choose an exact tab",
          instruction: "Use the selected tab, a ChatGPT conversation URL, conversation ID, or a tab id returned by openTabs().",
          userActionRequired: false
        },
        {
          label: "Allow opening",
          instruction: "Rerun with open-if-missing only if it is acceptable to open or create a ChatGPT tab instead of reusing an already-open one.",
          userActionRequired: false
        }
      ]
    };
    if (diagnostics !== undefined) details.diagnostics = { existingTab: diagnostics };
    super(message, "not_found", true, undefined, details);
  }
}

function targetRequiresChatGPT(target: ExistingTabTarget): boolean {
  switch (target.type) {
    case "selected":
      return target.host === "chatgpt";
    case "tabId":
    case "title":
      return true;
    case "conversationId":
    case "conversation_id":
    case "url":
      return true;
  }
}

export { isChatGPTUrl } from "./chatgpt-url.js";

function urlMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualConversationId = parseConversationId(actual);
  const expectedConversationId = parseConversationId(expected);
  if (actualConversationId !== undefined || expectedConversationId !== undefined) {
    return actualConversationId !== undefined && actualConversationId === expectedConversationId;
  }
  return normalizeUrl(actual) === normalizeUrl(expected);
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function titleMatches(actual: string | undefined, expected: string, exact: boolean): boolean {
  if (actual === undefined) {
    return false;
  }
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  return exact ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function urlFromExistingTarget(target: ExistingTabTarget | undefined): string | undefined {
  if (target === undefined) {
    return undefined;
  }
  switch (target.type) {
    case "url":
      return target.url;
    case "conversationId":
    case "conversation_id":
      return new URL(`/c/${target.conversationId}`, CHATGPT_HOME).toString();
    case "selected":
    case "tabId":
    case "title":
      return undefined;
  }
}

function userTabCandidateLabel(tab: BrowserUserTabInfo): string {
  return `tab ${tab.id} - ${tab.title ?? "Untitled"} - ${tab.url ?? "unknown URL"}`;
}

async function createTab(browser: BrowserLike, url: string): Promise<PageLike | undefined> {
  assertSafeChatGPTNavigation(url);
  if (typeof browser.tabs?.create === "function") {
    const tab = await browser.tabs.create(url);
    const page = await hydrateTab(browser, tab);
    await ensurePageAt(page, url);
    return page;
  }

  if (typeof browser.tabs?.new === "function") {
    const tab = await browser.tabs.new(url);
    const page = await hydrateTab(browser, tab);
    await ensurePageAt(page, url);
    return page;
  }

  if (typeof browser.newPage === "function") {
    const page = normalizePage(await browser.newPage());
    if (typeof page.goto === "function") {
      await page.goto(url);
    }
    await assertPageOnChatGPTOrigin(page);
    return page;
  }

  return undefined;
}

function assertSafeChatGPTNavigation(url: string): void {
  if (isChatGPTUrl(url)) return;
  throw unsafeChatGPTOriginError(
    "ChatGPT navigation requires HTTPS on an allowlisted ChatGPT origin with the default port.",
  );
}

async function ensurePageAt(page: PageLike, url: string): Promise<void> {
  const currentUrl = await Promise.resolve(page.url?.()).catch(() => "");
  if (isChatGPTUrl(currentUrl)) {
    return;
  }
  if (typeof page.goto === "function") {
    await page.goto(url);
  }
  await assertPageOnChatGPTOrigin(page);
}

async function assertPageOnChatGPTOrigin(page: PageLike): Promise<void> {
  const actualUrl = await Promise.resolve(page.url?.()).catch(() => undefined);
  if (!isChatGPTUrl(actualUrl)) throw unsafeChatGPTOriginError(undefined, actualUrl);
}

function unsafeChatGPTOriginError(
  message = "The browser did not remain on a supported ChatGPT origin after navigation or attachment.",
  actualUrl?: string
): ChatGPTControlError {
  const observedOrigin = sanitizedOriginEvidence(actualUrl);
  return new ChatGPTControlError(
    message,
    "selector_drift",
    false,
    observedOrigin === undefined ? undefined : `Observed browser origin: ${observedOrigin}`,
    { code: "unsafe_chatgpt_origin" }
  );
}

function sanitizedOriginEvidence(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return undefined;
  }
}

async function hydrateTab(browser: BrowserLike, pageOrTab: unknown): Promise<PageLike> {
  const maybe = pageOrTab as Record<string, unknown>;
  if (maybe.playwright === undefined && typeof maybe.id === "string" && typeof browser.tabs?.get === "function") {
    try {
      return normalizePage(await browser.tabs.get(maybe.id));
    } catch {
      return normalizePage(pageOrTab);
    }
  }
  return normalizePage(pageOrTab);
}

export function tabIdFromPage(page: PageLike): string | undefined {
  const maybe = unwrapPageProvider(page) as Record<string, unknown>;
  const id = maybe.id ?? maybe.tabId;
  return typeof id === "string" ? id : undefined;
}
