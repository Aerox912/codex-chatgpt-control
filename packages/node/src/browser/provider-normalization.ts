import type { BrowserLike, BrowserUserTabInfo, PageLike } from "../types.js";
import { unwrapCoordinatedPage } from "../runtime/coordinated-page.js";

const rawPageProviders = new WeakMap<object, PageLike>();

export function normalizeBrowserProvider(browser: unknown): BrowserLike | undefined {
  if (browser === undefined || browser === null || typeof browser !== "object") {
    return undefined;
  }

  // Browsers returned by the Codex bridge are capability proxies. Reading a
  // method normally returns a receiver-safe callable, while extracting the
  // same function from its prototype loses the proxy's private-field binding.
  // Normalize that trusted bridge result into a plain BrowserLike before the
  // descriptor-only coordination facade inspects it.
  const rawBrowser = browser as Record<PropertyKey, unknown>;
  const normalized: BrowserLike = {};
  const name = providerValue(rawBrowser, "name");
  if (typeof name === "string") normalized.name = name;

  const rawUser = providerValue(rawBrowser, "user");
  if (isProviderRecord(rawUser)) {
    const openTabs = providerCallable(rawUser, "openTabs");
    const claimTab = providerCallable(rawUser, "claimTab");
    normalized.user = {
      ...(openTabs === undefined ? {} : {
        openTabs: async () => await openTabs() as BrowserUserTabInfo[]
      }),
      ...(claimTab === undefined ? {} : {
        claimTab: async (tab: string | BrowserUserTabInfo) => normalizePageProvider(await claimTab(tab))
      })
    };
  }

  const rawTabs = providerValue(rawBrowser, "tabs");
  if (isProviderRecord(rawTabs)) {
    const create = providerCallable(rawTabs, "create");
    const newer = providerCallable(rawTabs, "new");
    const selected = providerCallable(rawTabs, "selected");
    const list = providerCallable(rawTabs, "list");
    const get = providerCallable(rawTabs, "get");
    const finalize = providerCallable(rawTabs, "finalize");
    normalized.tabs = {
      ...(create === undefined ? {} : {
        create: async (url: string) => normalizePageProvider(await create(url))
      }),
      ...(newer === undefined ? {} : {
        new: async (url?: string) => normalizePageProvider(await newer(...(url === undefined ? [] : [url])))
      }),
      ...(selected === undefined ? {} : {
        selected: async () => {
          const page = await selected();
          return page === undefined ? undefined : normalizePageProvider(page);
        }
      }),
      ...(list === undefined ? {} : {
        list: async () => {
          const pages = await list();
          return Array.isArray(pages) ? pages.map(normalizePageProvider) : pages as PageLike[];
        }
      }),
      ...(get === undefined ? {} : {
        get: async (id: string) => normalizePageProvider(await get(id))
      }),
      ...(finalize === undefined ? {} : {
        finalize: async (options: { keep?: unknown[] }) => { await finalize(options); }
      })
    };
  }

  const newPage = providerCallable(rawBrowser, "newPage");
  if (newPage !== undefined) {
    normalized.newPage = async () => normalizePageProvider(await newPage());
  }
  return normalized;
}

export function normalizePageProvider(pageOrTab: unknown): PageLike {
  if (isPageWrapper(pageOrTab)) return pageOrTab;
  if (!isProviderRecord(pageOrTab)) return pageOrTab as PageLike;
  const maybe = pageOrTab;
  const embedded = providerValue(maybe, "playwright") ?? providerValue(maybe, "page");
  const primary = isProviderRecord(embedded) ? embedded : maybe;
  const normalized: Record<string, unknown> = {};

  for (const property of ["id", "tabId"] as const) {
    const value = providerValue(maybe, property) ?? providerValue(primary, property);
    if (typeof value === "string") normalized[property] = value;
  }
  for (const property of ["keyboard", "mouse", "cua", "capabilities"] as const) {
    const value = providerValue(primary, property) ?? providerValue(maybe, property);
    if (isProviderRecord(value)) normalized[property] = value;
  }
  if (isProviderRecord(embedded)) normalized.playwright = embedded;

  for (const method of [
    "url", "goto", "title", "locator", "getByRole", "getByPlaceholder",
    "getByText", "waitForTimeout", "waitForEvent", "evaluate", "content", "close"
  ] as const) {
    const callable = providerCallable(primary, method) ?? providerCallable(maybe, method);
    if (callable !== undefined) normalized[method] = (...args: unknown[]) => invokeWithProviderDeadline(callable, args);
  }

  const stringUrl = providerValue(maybe, "url");
  if (normalized.url === undefined && typeof stringUrl === "string") {
    normalized.url = () => stringUrl;
  }
  const stringTitle = providerValue(maybe, "title");
  if (normalized.title === undefined && typeof stringTitle === "string") {
    normalized.title = async () => stringTitle;
  }
  const normalizedPage = normalized as PageLike;
  if (pageOrTab !== null && (typeof pageOrTab === "object" || typeof pageOrTab === "function")) {
    rawPageProviders.set(normalizedPage as object, pageOrTab as PageLike);
  }
  return normalizedPage;
}

export function unwrapPageProvider(page: PageLike): PageLike {
  const uncoordinated = unwrapCoordinatedPage(page);
  return rawPageProviders.get(uncoordinated as object) ?? uncoordinated;
}

type ProviderCallable = (...args: unknown[]) => unknown;

function invokeWithProviderDeadline(callable: ProviderCallable, args: unknown[]): unknown {
  const result = callable(...args);
  const timeoutMs = timeoutFromLastArgument(args);
  if (timeoutMs === undefined || !isPromiseLike(result)) return result;

  // Settle the provider wrapper just before the outer coordinator deadline so
  // a non-cooperative bridge promise cannot quarantine the browser-wide actor.
  const deadlineMarginMs = Math.min(250, timeoutMs / 4);
  const providerDeadlineMs = Math.max(0, timeoutMs - deadlineMarginMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Browser provider operation timed out.")), providerDeadlineMs);
  });
  return Promise.race([Promise.resolve(result), deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function timeoutFromLastArgument(args: unknown[]): number | undefined {
  const options = args.at(-1);
  if (options === null || typeof options !== "object") return undefined;
  const timeoutMs = (options as { timeoutMs?: unknown }).timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

function isProviderRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function providerValue(value: Record<PropertyKey, unknown>, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key, value);
  } catch {
    return undefined;
  }
}

function providerCallable(value: Record<PropertyKey, unknown>, key: PropertyKey): ProviderCallable | undefined {
  const candidate = providerValue(value, key);
  if (typeof candidate !== "function") return undefined;
  return (...args: unknown[]) => Reflect.apply(candidate, value, args);
}

function isPageWrapper(value: unknown): value is PageLike {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return unwrapCoordinatedPage(value as PageLike) !== value;
}
