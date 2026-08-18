import type { BrowserLike, BrowserUserTabInfo, PageLike, RuntimeEnv } from "../types.js";
import {
  createBrowserResourceKey,
  getProcessTabCoordinator,
  type BrowserResourceKey,
  type CoordinatorOwner,
  type CoordinatorPriority,
  type ProcessTabCoordinator
} from "./tab-coordinator.js";
import {
  createCoordinatedPage,
  unwrapCoordinatedPage
} from "./coordinated-page.js";

const MAX_PROTO_DEPTH = 12;
const MAX_CACHED_BROWSER_AFFINITIES = 256;
export const MAX_BROWSER_TAB_CANDIDATES = 256;
const UNKNOWN_BROWSER_ID = "codex-process-browser";
const DEFAULT_BACKEND_SESSION_ID = "legacy-runtime";

type ObjectLike = object | ((...args: never[]) => unknown);
type AnyFunction = (...args: any[]) => any;

export type CoordinatedBrowserOptions = Readonly<{
  coordinator?: ProcessTabCoordinator;
  owner?: CoordinatorOwner;
}>;

type NormalizedOptions = Readonly<{
  coordinator: ProcessTabCoordinator;
  owner: CoordinatorOwner;
}>;

type BrowserState = Readonly<{
  rawBrowser: BrowserLike;
  browserResource: BrowserResourceKey;
  options: NormalizedOptions;
}>;

export class CoordinatedBrowserError extends Error {
  readonly code = "coordinated_browser_invalid";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoordinatedBrowserError";
  }
}

const browserResourceCache = new WeakMap<ObjectLike, BrowserResourceKey>();
const browserWrappers = new WeakMap<ObjectLike, WeakMap<ProcessTabCoordinator, Map<string, BrowserLike>>>();
const rawBrowsers = new WeakMap<ObjectLike, BrowserLike>();

function isObjectLike(value: unknown): value is ObjectLike {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function invalid(message: string, cause?: unknown): never {
  throw new CoordinatedBrowserError(message, cause === undefined ? undefined : { cause });
}

function readDataMember<T>(value: ObjectLike, key: PropertyKey, label: string): T | undefined {
  let current: ObjectLike | null = value;
  for (let depth = 0; current !== null && depth < MAX_PROTO_DEPTH; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch (error) {
      return invalid(`Cannot inspect ${label}: provider descriptor access failed`, error);
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) return invalid(`Cannot use ${label}: accessor-backed provider members are not supported`);
      return descriptor.value as T;
    }
    try {
      const prototype = Object.getPrototypeOf(current);
      current = isObjectLike(prototype) ? prototype : null;
    } catch (error) {
      return invalid(`Cannot inspect ${label}: provider prototype access failed`, error);
    }
  }
  if (current !== null) return invalid(`Cannot inspect ${label}: provider prototype depth exceeded`);
  return undefined;
}

function optionalCallable(value: ObjectLike, key: PropertyKey, label: string): AnyFunction | undefined {
  const member = readDataMember<unknown>(value, key, label);
  if (member === undefined) return undefined;
  if (typeof member !== "function") return invalid(`${label} is not callable`);
  return member as AnyFunction;
}

function normalizeOwner(owner: CoordinatorOwner | undefined): CoordinatorOwner {
  const ownerRecord = owner === undefined ? undefined : (isObjectLike(owner) ? owner : invalid("coordinated browser owner metadata is invalid"));
  const backendSessionIdValue = ownerRecord === undefined
    ? DEFAULT_BACKEND_SESSION_ID
    : readDataMember<unknown>(ownerRecord, "backendSessionId", "owner.backendSessionId");
  if (typeof backendSessionIdValue !== "string" || backendSessionIdValue.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(backendSessionIdValue)) {
    return invalid("coordinated browser owner metadata is invalid");
  }
  const ownerIdValue = ownerRecord === undefined ? undefined : readDataMember<unknown>(ownerRecord, "ownerId", "owner.ownerId");
  const operationIdValue = ownerRecord === undefined ? undefined : readDataMember<unknown>(ownerRecord, "operationId", "owner.operationId");
  if (
    (ownerIdValue !== undefined && (typeof ownerIdValue !== "string" || ownerIdValue.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(ownerIdValue)))
    || (operationIdValue !== undefined && (typeof operationIdValue !== "string" || operationIdValue.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(operationIdValue)))
  ) {
    return invalid("coordinated browser owner metadata is invalid");
  }
  return Object.freeze({
    backendSessionId: backendSessionIdValue.trim(),
    ...(ownerIdValue === undefined ? {} : { ownerId: ownerIdValue.trim() }),
    ...(operationIdValue === undefined ? {} : { operationId: operationIdValue.trim() })
  });
}

function normalizeOptions(options: CoordinatedBrowserOptions | undefined): NormalizedOptions {
  const value = options === undefined
    ? undefined
    : (isObjectLike(options) ? options : invalid("coordinated browser options are invalid"));
  const coordinatorValue = value === undefined
    ? undefined
    : readDataMember<unknown>(value, "coordinator", "options.coordinator");
  const ownerValue = value === undefined
    ? undefined
    : readDataMember<unknown>(value, "owner", "options.owner");
  const coordinator = coordinatorValue ?? getProcessTabCoordinator();
  if (!isObjectLike(coordinator)) return invalid("coordinated browser coordinator is invalid");
  if (
    typeof readDataMember<unknown>(coordinator, "withBrowserAcquisition", "coordinator.withBrowserAcquisition") !== "function"
    || typeof readDataMember<unknown>(coordinator, "withTabTransaction", "coordinator.withTabTransaction") !== "function"
  ) {
    return invalid("coordinated browser coordinator is missing transaction methods");
  }
  return Object.freeze({ coordinator: coordinator as ProcessTabCoordinator, owner: normalizeOwner(ownerValue as CoordinatorOwner | undefined) });
}

function stableBrowserResource(browser: BrowserLike | undefined): BrowserResourceKey {
  if (browser !== undefined && isObjectLike(browser)) {
    const existing = browserResourceCache.get(browser);
    if (existing !== undefined) return existing;
    let browserName: unknown;
    try {
      browserName = readDataMember<unknown>(browser, "name", "browser.name");
    } catch {
      browserName = undefined;
    }
    const normalizedName = typeof browserName === "string"
      && browserName.trim().length > 0
      && browserName.trim().length <= 128
      && !/[\u0000-\u001f\u007f]/u.test(browserName)
      ? browserName.trim().slice(0, 128)
      : undefined;
    // Names are provider-level identities, not tab labels. Unknown/current
    // Codex bridge objects all deliberately share one conservative fallback.
    const browserId = normalizedName === undefined
      ? UNKNOWN_BROWSER_ID
      : `codex-${normalizedName}`;
    const key = createBrowserResourceKey("codex", browserId);
    browserResourceCache.set(browser, key);
    return key;
  }
  return createBrowserResourceKey("codex", UNKNOWN_BROWSER_ID);
}

export function coordinatedBrowserResource(browser?: BrowserLike): Readonly<{
  kind: "browser";
  key: BrowserResourceKey;
}> {
  return { kind: "browser", key: stableBrowserResource(browser) };
}

function invoke<T>(fn: AnyFunction, receiver: ObjectLike, args: readonly unknown[]): T {
  try {
    return Reflect.apply(fn, receiver, args) as T;
  } catch (error) {
    throw error;
  }
}

function absorbRejection<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function route<T>(state: BrowserState, priority: CoordinatorPriority, label: string, callback: () => T | PromiseLike<T>): Promise<T> {
  const requestOptions = { owner: state.options.owner, priority, label } as const;
  const pending = state.options.coordinator.withBrowserAcquisition(state.browserResource, requestOptions, () => callback());
  return absorbRejection(pending);
}

function pageFor(state: BrowserState, value: unknown): PageLike {
  if (!isObjectLike(value)) return invalid("browser provider returned an invalid page object");
  const rawPage = unwrapCoordinatedPage(value as PageLike);
  return createCoordinatedPage(rawPage, {
    coordinator: state.options.coordinator,
    resource: { kind: "browser", key: state.browserResource },
    owner: state.options.owner
  });
}

function pageResult(state: BrowserState, value: unknown): PageLike {
  if (isObjectLike(value)) return pageFor(state, value);
  return invalid("browser provider returned an invalid page object");
}

function callAndMap<T, R>(
  state: BrowserState,
  receiver: ObjectLike,
  method: AnyFunction,
  args: readonly unknown[],
  priority: CoordinatorPriority,
  label: string,
  mapper: (value: T) => R
): Promise<R> {
  const pending = route(state, priority, label, async () => mapper(await invoke<T>(method, receiver, args)));
  return absorbRejection(pending);
}

function boundedTabCandidates(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) return invalid(`${label} returned an invalid tab list`);
  if (value.length > MAX_BROWSER_TAB_CANDIDATES) {
    return invalid(`${label} exceeded the bounded tab candidate limit`);
  }
  return value;
}

function wrapUser(rawUser: ObjectLike, state: BrowserState): NonNullable<BrowserLike["user"]> {
  const openTabs = optionalCallable(rawUser, "openTabs", "browser.user.openTabs");
  const claimTab = optionalCallable(rawUser, "claimTab", "browser.user.claimTab");
  return {
    ...(openTabs === undefined ? {} : {
      openTabs: (): Promise<BrowserUserTabInfo[]> => callAndMap<unknown, BrowserUserTabInfo[]>(state, rawUser, openTabs, [], "read", "browser.user.openTabs", value =>
        boundedTabCandidates(value, "browser.user.openTabs") as BrowserUserTabInfo[]
      )
    }),
    ...(claimTab === undefined ? {} : {
      claimTab: (tab: string | BrowserUserTabInfo): Promise<PageLike> => callAndMap<unknown, PageLike>(
        state,
        rawUser,
        claimTab,
        [tab],
        "mutation",
        "browser.user.claimTab",
        value => pageResult(state, value)
      )
    })
  };
}

function wrapTabs(rawTabs: ObjectLike, state: BrowserState): NonNullable<BrowserLike["tabs"]> {
  const selected = optionalCallable(rawTabs, "selected", "browser.tabs.selected");
  const list = optionalCallable(rawTabs, "list", "browser.tabs.list");
  const get = optionalCallable(rawTabs, "get", "browser.tabs.get");
  const create = optionalCallable(rawTabs, "create", "browser.tabs.create");
  const newer = optionalCallable(rawTabs, "new", "browser.tabs.new");
  const finalize = optionalCallable(rawTabs, "finalize", "browser.tabs.finalize");
  return {
    ...(selected === undefined ? {} : {
      selected: (): Promise<PageLike | undefined> => callAndMap(state, rawTabs, selected, [], "read", "browser.tabs.selected", value =>
        value === undefined ? undefined : pageFor(state, value)
      )
    }),
    ...(list === undefined ? {} : {
      list: (): Promise<PageLike[]> => callAndMap(state, rawTabs, list, [], "read", "browser.tabs.list", value =>
        boundedTabCandidates(value, "browser.tabs.list").map(item => pageFor(state, item))
      )
    }),
    ...(get === undefined ? {} : {
      get: (id: string): Promise<PageLike> => callAndMap(state, rawTabs, get, [id], "read", "browser.tabs.get", value => pageFor(state, value))
    }),
    ...(create === undefined ? {} : {
      create: (url: string): Promise<PageLike> => callAndMap(state, rawTabs, create, [url], "mutation", "browser.tabs.create", value => pageFor(state, value))
    }),
    ...(newer === undefined ? {} : {
      new: (url?: string): Promise<PageLike> => callAndMap(state, rawTabs, newer, url === undefined ? [] : [url], "mutation", "browser.tabs.new", value => pageFor(state, value))
    }),
    ...(finalize === undefined ? {} : {
      finalize: (options: { keep?: unknown[] }): Promise<void> => route(state, "control", "browser.tabs.finalize", () => invoke<Promise<void>>(finalize, rawTabs, [options]))
    })
  };
}

function makeBrowserState(rawBrowser: BrowserLike, options: NormalizedOptions): BrowserState {
  return Object.freeze({ rawBrowser, browserResource: stableBrowserResource(rawBrowser), options });
}

function buildBrowser(state: BrowserState): BrowserLike {
  const rawBrowser = state.rawBrowser as ObjectLike;
  const name = readDataMember<unknown>(rawBrowser, "name", "browser.name");
  const rawUser = readDataMember<unknown>(rawBrowser, "user", "browser.user");
  const rawTabs = readDataMember<unknown>(rawBrowser, "tabs", "browser.tabs");
  const newPage = optionalCallable(rawBrowser, "newPage", "browser.newPage");
  const wrapper: BrowserLike = {
    ...(typeof name === "string" ? { name } : {}),
    ...(rawUser === undefined ? {} : {
      user: wrapUser(isObjectLike(rawUser) ? rawUser : invalid("browser.user must be an object"), state)
    }),
    ...(rawTabs === undefined ? {} : {
      tabs: wrapTabs(isObjectLike(rawTabs) ? rawTabs : invalid("browser.tabs must be an object"), state)
    }),
    ...(newPage === undefined ? {} : {
      newPage: (): Promise<PageLike> => callAndMap<unknown, PageLike>(state, rawBrowser, newPage, [], "mutation", "browser.newPage", value => pageFor(state, value))
    })
  };
  rawBrowsers.set(wrapper as ObjectLike, state.rawBrowser);
  return wrapper;
}

function browserCache(rawBrowser: ObjectLike, coordinator: ProcessTabCoordinator): Map<string, BrowserLike> {
  let byCoordinator = browserWrappers.get(rawBrowser);
  if (byCoordinator === undefined) {
    byCoordinator = new WeakMap<ProcessTabCoordinator, Map<string, BrowserLike>>();
    browserWrappers.set(rawBrowser, byCoordinator);
  }
  let byOwner = byCoordinator.get(coordinator);
  if (byOwner === undefined) {
    byOwner = new Map<string, BrowserLike>();
    byCoordinator.set(coordinator, byOwner);
  }
  return byOwner;
}

function cacheBrowser(cache: Map<string, BrowserLike>, affinity: string, browser: BrowserLike): void {
  // Owner affinity includes operationId. Touching on a hit and evicting the
  // oldest entry keeps a long-lived runtime from retaining one strong wrapper
  // and its provider graph per operation forever.
  cache.delete(affinity);
  cache.set(affinity, browser);
  while (cache.size > MAX_CACHED_BROWSER_AFFINITIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function ownerCacheKey(owner: CoordinatorOwner): string {
  return [owner.backendSessionId, owner.ownerId ?? "", owner.operationId ?? ""]
    .map(value => encodeURIComponent(value))
    .join(":");
}

/** Wrap a browser using one browser-wide actor; no per-tab capability is inferred. */
export function createCoordinatedBrowser(browser: BrowserLike, options?: CoordinatedBrowserOptions): BrowserLike {
  if (!isObjectLike(browser)) return invalid("browser must be a provider BrowserLike object");
  const rawBrowser = (rawBrowsers.get(browser as ObjectLike) ?? browser) as BrowserLike;
  const normalized = normalizeOptions(options);
  const cache = browserCache(rawBrowser as ObjectLike, normalized.coordinator);
  const key = ownerCacheKey(normalized.owner);
  const existing = cache.get(key);
  if (existing !== undefined) {
    cacheBrowser(cache, key, existing);
    return existing;
  }
  const wrapper = buildBrowser(makeBrowserState(rawBrowser, normalized));
  cacheBrowser(cache, key, wrapper);
  return wrapper;
}

/** Wrap one initial/captured page with the browser-wide legacy actor. */
export function createCoordinatedPageForBrowser(
  page: PageLike,
  browser?: BrowserLike,
  options?: CoordinatedBrowserOptions
): PageLike {
  const normalized = normalizeOptions(options);
  const rawBrowser = browser === undefined ? undefined : (rawBrowsers.get(browser as ObjectLike) ?? browser);
  const resource = { kind: "browser", key: stableBrowserResource(rawBrowser) } as const;
  return createCoordinatedPage(unwrapCoordinatedPage(page), {
    coordinator: normalized.coordinator,
    resource,
    owner: normalized.owner
  });
}

/** Make a fresh RuntimeEnv snapshot with only browser/page values coordinated. */
export function coordinateRuntimeEnv(env: RuntimeEnv, options?: CoordinatedBrowserOptions): RuntimeEnv {
  const normalized = normalizeOptions(options);
  const browser = env.browser === undefined ? undefined : createCoordinatedBrowser(env.browser, normalized);
  const page = env.page === undefined ? undefined : createCoordinatedPageForBrowser(env.page, browser, normalized);
  return {
    ...(env.agent === undefined ? {} : { agent: env.agent }),
    ...(browser === undefined ? {} : { browser }),
    ...(page === undefined ? {} : { page }),
    ...(env.clipboard === undefined ? {} : { clipboard: env.clipboard }),
    ...(env.now === undefined ? {} : { now: env.now }),
    ...(env.expectedTabId === undefined ? {} : { expectedTabId: env.expectedTabId })
  };
}

export function unwrapCoordinatedBrowser(browser: BrowserLike): BrowserLike {
  if (!isObjectLike(browser)) return browser;
  return rawBrowsers.get(browser as ObjectLike) ?? browser;
}
