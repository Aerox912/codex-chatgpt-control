import {
  createBrowserResourceKey,
  createTabResourceKey,
  type BrowserResourceKey,
  type TabResourceKey
} from "./tab-coordinator.js";

/**
 * An operation context owns one page reference for the lifetime of an
 * operation.  It deliberately does not accept a RuntimeEnv: a mutable
 * `RuntimeEnv.page` can be replaced by another request while a command is
 * awaiting a browser call.  Contexts instead capture a page once and expose
 * an explicit affinity check at every adapter boundary.
 */

const INVALID_ID_VALUES = new Set(["unknown", "undefined", "null", "n/a", "na"]);
const UNKNOWN_PROVIDER_ID = "operation-context-provider-identity-unavailable";
const UNKNOWN_BROWSER_ID = "operation-context-browser-identity-unavailable";
const MAX_ID_LENGTH = 512;
const MAX_DIGEST_LENGTH = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HMAC_DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;

type PlainRecord = Record<string, unknown>;

export type OperationRuntimeCoordinationScope = "tab" | "provider";

export type OperationRuntimeClaimReason = "missing" | "unsupported" | "unverifiable";

export type OperationRuntimeAuthoritativeClaim = Readonly<
  | {
      status: "available";
      token: string;
      epoch: number;
    }
  | {
      status: "unavailable";
      reason: OperationRuntimeClaimReason;
    }
>;

/**
 * Capabilities are provider-advertised facts.  Missing fields intentionally
 * mean false; an older or partial provider must never be treated as
 * concurrent-tab safe by inference.
 */
export type OperationRuntimeCapabilities = Readonly<{
  stableProviderId: boolean;
  stableBrowserId: boolean;
  stableTabId: boolean;
  authoritativeTabClaim: boolean;
  concurrentTabs: boolean;
}>;

export type OperationRuntimeOwner = Readonly<{
  backendSessionId: string;
  operationId: string;
}>;

export type OperationRuntimeContextInput<Page extends object = object> = Readonly<{
  providerId?: string;
  browserId?: string;
  tabId?: string;
  page: Page;
  authoritativeClaim?: OperationRuntimeAuthoritativeClaim;
  owner: OperationRuntimeOwner;
  capabilities?: Partial<OperationRuntimeCapabilities>;
  targetBindingDigest: string;
  /** Reject construction if an exact tab-scoped owner cannot be proven. */
  requireExactTabOwnership?: boolean;
}>;

export type OperationRuntimeContextChildOptions = Readonly<{
  operationId?: string;
  targetBindingDigest?: string;
}>;

export type OperationRuntimeAffinityObservation = Readonly<{
  tabId?: string;
  authoritativeClaim?: OperationRuntimeAuthoritativeClaim;
}>;

export type OperationRuntimeResourceSelection = Readonly<{
  scope: OperationRuntimeCoordinationScope;
  resourceKind: "tab" | "browser";
  resourceKey: TabResourceKey | BrowserResourceKey;
  exactTabOwnership: boolean;
  downgraded: boolean;
  downgradeReasons: readonly OperationRuntimeDowngradeReason[];
}>;

export type OperationRuntimeDowngradeReason =
  | "provider_identity_unavailable"
  | "browser_identity_unavailable"
  | "tab_identity_unavailable"
  | "provider_identity_not_advertised"
  | "browser_identity_not_advertised"
  | "tab_identity_not_advertised"
  | "authoritative_claim_unavailable"
  | "authoritative_claim_not_advertised"
  | "concurrent_tabs_not_advertised";

export type OperationRuntimeContextDiagnostics = Readonly<{
  status: "ready";
  scope: OperationRuntimeCoordinationScope;
  resourceKind: "tab" | "browser";
  exactTabOwnership: boolean;
  downgraded: boolean;
  downgradeReasons: readonly OperationRuntimeDowngradeReason[];
  identities: Readonly<{
    provider: "available" | "unavailable";
    browser: "available" | "unavailable";
    tab: "available" | "unavailable";
  }>;
  page: "bound";
  authoritativeClaim: "available" | "unavailable";
  owner: "bound";
  targetBinding: "bound";
}>;

export type OperationRuntimeContextCapture<Page extends object = object> = Readonly<{
  page: Page;
  providerId?: string;
  browserId?: string;
  tabId?: string;
  authoritativeClaim: OperationRuntimeAuthoritativeClaim;
  owner: OperationRuntimeOwner;
  capabilities: OperationRuntimeCapabilities;
  coordinationScope: OperationRuntimeCoordinationScope;
  targetBindingDigest: string;
  resource: OperationRuntimeResourceSelection;
  assertPageAffinity: (
    page: unknown,
    observation?: OperationRuntimeAffinityObservation
  ) => OperationRuntimeAffinityResult;
}>;

export type OperationRuntimeAffinityResult = Readonly<{
  pageMatches: true;
  tabMatches: boolean;
  claimMatches: boolean;
  exactTabOwnership: boolean;
}>;

export type OperationRuntimeContextErrorCode =
  | "invalid_context"
  | "exact_ownership_unavailable"
  | "page_affinity_mismatch"
  | "tab_affinity_mismatch"
  | "claim_drift";

/** Error diagnostics contain statuses only; no IDs, digests, claim tokens, or page values. */
export class OperationRuntimeContextError extends Error {
  readonly code: OperationRuntimeContextErrorCode;
  readonly diagnostics?: OperationRuntimeContextDiagnostics;

  constructor(
    code: OperationRuntimeContextErrorCode,
    message: string,
    diagnostics?: OperationRuntimeContextDiagnostics
  ) {
    super(message);
    this.name = "OperationRuntimeContextError";
    this.code = code;
    if (diagnostics !== undefined) this.diagnostics = diagnostics;
  }
}

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertRecord(value: unknown, label: string): asserts value is PlainRecord {
  if (!isRecord(value)) throw invalid(`${label} must be a plain object`);
  try {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw invalid(`${label} must not contain accessor properties`);
      }
    }
  } catch (error) {
    if (error instanceof OperationRuntimeContextError) throw error;
    throw invalid(`${label} must be a stable plain object`);
  }
}

function assertExactKeys(value: PlainRecord, label: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  try {
    for (const key of Object.keys(value)) {
      if (key.startsWith("_") || !allowedSet.has(key)) {
        throw invalid(`${label} contains an unsupported field`);
      }
    }
  } catch (error) {
    if (error instanceof OperationRuntimeContextError) throw error;
    throw invalid(`${label} contains unsupported fields`);
  }
}

function invalid(message: string): OperationRuntimeContextError {
  // Do not interpolate caller-controlled values into context errors.  This
  // protects diagnostics from leaking IDs, paths, digests, or page metadata.
  return new OperationRuntimeContextError("invalid_context", message);
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${label} must be a boolean`);
  return value;
}

function validateRequiredString(value: unknown, label: string, maxLength = MAX_ID_LENGTH): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    INVALID_ID_VALUES.has(normalized.toLowerCase()) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw invalid(`${label} must be a known stable value`);
  }
  return normalized;
}

function validateTargetBindingDigest(value: unknown, label = "targetBindingDigest"): string {
  const digest = validateRequiredString(value, label, MAX_DIGEST_LENGTH);
  if (!HMAC_DIGEST_PATTERN.test(digest)) throw invalid(`${label} must be a canonical HMAC digest`);
  return digest;
}

function normalizeOptionalIdentity(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${label} must be a string when present`);
  const normalized = value.trim();
  if (normalized.length === 0 || INVALID_ID_VALUES.has(normalized.toLowerCase())) return undefined;
  if (normalized.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalid(`${label} is not a valid stable identity`);
  }
  return normalized;
}

function normalizeCapabilities(value: unknown): OperationRuntimeCapabilities {
  if (value === undefined) {
    return Object.freeze({
      stableProviderId: false,
      stableBrowserId: false,
      stableTabId: false,
      authoritativeTabClaim: false,
      concurrentTabs: false
    });
  }
  assertRecord(value, "capabilities");
  assertExactKeys(value, "capabilities", [
    "stableProviderId",
    "stableBrowserId",
    "stableTabId",
    "authoritativeTabClaim",
    "concurrentTabs"
  ]);
  return Object.freeze({
    stableProviderId: value.stableProviderId === undefined ? false : validateBoolean(value.stableProviderId, "capabilities.stableProviderId"),
    stableBrowserId: value.stableBrowserId === undefined ? false : validateBoolean(value.stableBrowserId, "capabilities.stableBrowserId"),
    stableTabId: value.stableTabId === undefined ? false : validateBoolean(value.stableTabId, "capabilities.stableTabId"),
    authoritativeTabClaim: value.authoritativeTabClaim === undefined ? false : validateBoolean(value.authoritativeTabClaim, "capabilities.authoritativeTabClaim"),
    concurrentTabs: value.concurrentTabs === undefined ? false : validateBoolean(value.concurrentTabs, "capabilities.concurrentTabs")
  });
}

function normalizeOwner(value: unknown): OperationRuntimeOwner {
  assertRecord(value, "owner");
  assertExactKeys(value, "owner", ["backendSessionId", "operationId"]);
  const backendSessionId = validateRequiredString(value.backendSessionId, "owner.backendSessionId");
  const operationId = validateRequiredString(value.operationId, "owner.operationId");
  if (!UUID_PATTERN.test(backendSessionId)) throw invalid("owner.backendSessionId must be a canonical UUID");
  if (!UUID_PATTERN.test(operationId)) throw invalid("owner.operationId must be a canonical UUID");
  return Object.freeze({
    backendSessionId,
    operationId
  });
}

function normalizeClaim(value: unknown): OperationRuntimeAuthoritativeClaim {
  if (value === undefined) return Object.freeze({ status: "unavailable", reason: "missing" });
  assertRecord(value, "authoritativeClaim");
  if (value.status === "available") {
    assertExactKeys(value, "authoritativeClaim", ["status", "token", "epoch"]);
    if (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) {
      throw invalid("authoritativeClaim.epoch must be a non-negative safe integer");
    }
    return Object.freeze({
      status: "available" as const,
      token: validateRequiredString(value.token, "authoritativeClaim.token"),
      epoch: value.epoch as number
    });
  }
  if (value.status === "unavailable") {
    assertExactKeys(value, "authoritativeClaim", ["status", "reason"]);
    if (value.reason !== "missing" && value.reason !== "unsupported" && value.reason !== "unverifiable") {
      throw invalid("authoritativeClaim.reason is invalid");
    }
    return Object.freeze({ status: "unavailable" as const, reason: value.reason });
  }
  throw invalid("authoritativeClaim.status is invalid");
}

function claimMatches(
  expected: OperationRuntimeAuthoritativeClaim,
  observed: OperationRuntimeAuthoritativeClaim | undefined
): boolean {
  if (expected.status === "unavailable") return true;
  return observed?.status === "available"
    && observed.token === expected.token
    && observed.epoch === expected.epoch;
}

function cloneClaim(claim: OperationRuntimeAuthoritativeClaim): OperationRuntimeAuthoritativeClaim {
  return claim.status === "available"
    ? Object.freeze({ status: "available" as const, token: claim.token, epoch: claim.epoch })
    : Object.freeze({ status: "unavailable" as const, reason: claim.reason });
}

function createFallbackBrowserKey(providerId: string | undefined, browserId: string | undefined): BrowserResourceKey {
  if (providerId === undefined || browserId === undefined) {
    return createBrowserResourceKey(UNKNOWN_PROVIDER_ID, UNKNOWN_BROWSER_ID);
  }
  return createBrowserResourceKey(
    providerId,
    browserId
  );
}

function computeResource(
  providerId: string | undefined,
  browserId: string | undefined,
  tabId: string | undefined,
  claim: OperationRuntimeAuthoritativeClaim,
  capabilities: OperationRuntimeCapabilities
): OperationRuntimeResourceSelection {
  const providerAvailable = providerId !== undefined;
  const browserAvailable = browserId !== undefined;
  const tabAvailable = tabId !== undefined;
  const reasons: OperationRuntimeDowngradeReason[] = [];
  if (!providerAvailable) reasons.push("provider_identity_unavailable");
  if (!browserAvailable) reasons.push("browser_identity_unavailable");
  if (!tabAvailable) reasons.push("tab_identity_unavailable");
  if (!capabilities.stableProviderId) reasons.push("provider_identity_not_advertised");
  if (!capabilities.stableBrowserId) reasons.push("browser_identity_not_advertised");
  if (!capabilities.stableTabId) reasons.push("tab_identity_not_advertised");
  if (claim.status !== "available") reasons.push("authoritative_claim_unavailable");
  if (!capabilities.authoritativeTabClaim) reasons.push("authoritative_claim_not_advertised");
  if (!capabilities.concurrentTabs) reasons.push("concurrent_tabs_not_advertised");

  const exactTabOwnership = providerAvailable
    && browserAvailable
    && tabAvailable
    && capabilities.stableProviderId
    && capabilities.stableBrowserId
    && capabilities.stableTabId
    && capabilities.authoritativeTabClaim
    && claim.status === "available";
  if (exactTabOwnership && capabilities.concurrentTabs) {
    return Object.freeze({
      scope: "tab",
      resourceKind: "tab",
      resourceKey: createTabResourceKey(providerId as string, browserId as string, tabId as string),
      exactTabOwnership: true,
      downgraded: false,
      downgradeReasons: Object.freeze([])
    });
  }
  return Object.freeze({
    scope: "provider",
    resourceKind: "browser",
    resourceKey: createFallbackBrowserKey(providerId, browserId),
    exactTabOwnership,
    downgraded: true,
    downgradeReasons: Object.freeze([...new Set(reasons)])
  });
}

function redactedDiagnostics(
  resource: OperationRuntimeResourceSelection,
  providerId: string | undefined,
  browserId: string | undefined,
  tabId: string | undefined,
  claim: OperationRuntimeAuthoritativeClaim
): OperationRuntimeContextDiagnostics {
  return Object.freeze({
    status: "ready",
    scope: resource.scope,
    resourceKind: resource.resourceKind,
    exactTabOwnership: resource.exactTabOwnership,
    downgraded: resource.downgraded,
    downgradeReasons: Object.freeze([...resource.downgradeReasons]),
    identities: Object.freeze({
      provider: providerId === undefined ? "unavailable" : "available",
      browser: browserId === undefined ? "unavailable" : "available",
      tab: tabId === undefined ? "unavailable" : "available"
    }),
    page: "bound",
    authoritativeClaim: claim.status,
    owner: "bound",
    targetBinding: "bound"
  });
}

function validateAffinityObservation(value: unknown): OperationRuntimeAffinityObservation {
  if (value === undefined) return Object.freeze({});
  assertRecord(value, "affinity observation");
  assertExactKeys(value, "affinity observation", ["tabId", "authoritativeClaim"]);
  const tabId = normalizeOptionalIdentity(value.tabId, "affinity observation.tabId");
  const authoritativeClaim = value.authoritativeClaim === undefined
    ? undefined
    : normalizeClaim(value.authoritativeClaim);
  return Object.freeze({
    ...(tabId === undefined ? {} : { tabId }),
    ...(authoritativeClaim === undefined ? {} : { authoritativeClaim })
  });
}

/**
 * Immutable operation-scoped browser context.  A context is intentionally
 * independent from RuntimeEnv and can be passed to a future command adapter
 * without changing legacy command behavior.
 */
export class OperationRuntimeContext<Page extends object = object> {
  readonly providerId: string | undefined;
  readonly browserId: string | undefined;
  readonly tabId: string | undefined;
  readonly page: Page;
  readonly authoritativeClaim: OperationRuntimeAuthoritativeClaim;
  readonly owner: OperationRuntimeOwner;
  readonly capabilities: OperationRuntimeCapabilities;
  readonly coordinationScope: OperationRuntimeCoordinationScope;
  readonly targetBindingDigest: string;

  #resourceSelection: OperationRuntimeResourceSelection;
  #diagnosticsView: OperationRuntimeContextDiagnostics;

  private constructor(
    providerId: string | undefined,
    browserId: string | undefined,
    tabId: string | undefined,
    page: Page,
    authoritativeClaim: OperationRuntimeAuthoritativeClaim,
    owner: OperationRuntimeOwner,
    capabilities: OperationRuntimeCapabilities,
    targetBindingDigest: string,
    requireExactTabOwnership: boolean
  ) {
    this.providerId = providerId;
    this.browserId = browserId;
    this.tabId = tabId;
    this.page = page;
    this.authoritativeClaim = cloneClaim(authoritativeClaim);
    this.owner = Object.freeze({ ...owner });
    this.capabilities = Object.freeze({ ...capabilities });
    this.targetBindingDigest = targetBindingDigest;
    this.#resourceSelection = computeResource(providerId, browserId, tabId, this.authoritativeClaim, this.capabilities);
    this.coordinationScope = this.#resourceSelection.scope;
    this.#diagnosticsView = redactedDiagnostics(
      this.#resourceSelection,
      providerId,
      browserId,
      tabId,
      this.authoritativeClaim
    );
    if (requireExactTabOwnership && !this.#resourceSelection.exactTabOwnership) {
      throw new OperationRuntimeContextError(
        "exact_ownership_unavailable",
        "Exact tab ownership is unavailable for this context.",
        this.#diagnosticsView
      );
    }
    Object.freeze(this);
  }

  /** Fail-closed context construction with deterministic provider-wide fallback. */
  static create<Page extends object = object>(
    input: OperationRuntimeContextInput<Page>
  ): OperationRuntimeContext<Page> {
    assertRecord(input, "operation context");
    assertExactKeys(input, "operation context", [
      "providerId",
      "browserId",
      "tabId",
      "page",
      "authoritativeClaim",
      "owner",
      "capabilities",
      "targetBindingDigest",
      "requireExactTabOwnership"
    ]);
    if (typeof input.page !== "object" || input.page === null || Array.isArray(input.page)) {
      throw invalid("page must be a non-null object");
    }
    const requireExactTabOwnership = input.requireExactTabOwnership === undefined
      ? false
      : validateBoolean(input.requireExactTabOwnership, "requireExactTabOwnership");
    const context = new OperationRuntimeContext(
      normalizeOptionalIdentity(input.providerId, "providerId"),
      normalizeOptionalIdentity(input.browserId, "browserId"),
      normalizeOptionalIdentity(input.tabId, "tabId"),
      input.page,
      normalizeClaim(input.authoritativeClaim),
      normalizeOwner(input.owner),
      normalizeCapabilities(input.capabilities),
      validateTargetBindingDigest(input.targetBindingDigest),
      requireExactTabOwnership
    );
    return context;
  }

  /** Alias for adapters that prefer a factory-style name. */
  static bind<Page extends object = object>(
    input: OperationRuntimeContextInput<Page>
  ): OperationRuntimeContext<Page> {
    return OperationRuntimeContext.create(input);
  }

  /** The exact coordinator actor resource; never returns tab scope after downgrade. */
  coordinatorResource(): OperationRuntimeResourceSelection {
    return this.#resourceSelection;
  }

  /** Status-only diagnostics suitable for logs and blockers. */
  diagnostics(): OperationRuntimeContextDiagnostics {
    return this.#diagnosticsView;
  }

  /**
   * Create a child operation view without permitting a new page, tab, claim, or
   * capability to be smuggled into the existing ownership domain.
   */
  child(options: OperationRuntimeContextChildOptions = {}): OperationRuntimeContext<Page> {
    assertRecord(options, "child options");
    assertExactKeys(options, "child options", ["operationId", "targetBindingDigest"]);
    const operationId = options.operationId === undefined
      ? this.owner.operationId
      : validateRequiredString(options.operationId, "child options.operationId");
    if (!UUID_PATTERN.test(operationId)) throw invalid("child options.operationId must be a canonical UUID");
    const targetBindingDigest = options.targetBindingDigest === undefined
      ? this.targetBindingDigest
      : validateTargetBindingDigest(options.targetBindingDigest, "child options.targetBindingDigest");
    return new OperationRuntimeContext(
      this.providerId,
      this.browserId,
      this.tabId,
      this.page,
      this.authoritativeClaim,
      Object.freeze({ backendSessionId: this.owner.backendSessionId, operationId }),
      this.capabilities,
      targetBindingDigest,
      false
    );
  }

  /**
   * Capture an immutable page-aware view.  It retains the same page identity;
   * it cannot be used to replace this context's page or ownership metadata.
   */
  capture(): OperationRuntimeContextCapture<Page> {
    const context = this;
    return Object.freeze({
      page: this.page,
      ...(this.providerId === undefined ? {} : { providerId: this.providerId }),
      ...(this.browserId === undefined ? {} : { browserId: this.browserId }),
      ...(this.tabId === undefined ? {} : { tabId: this.tabId }),
      authoritativeClaim: cloneClaim(this.authoritativeClaim),
      owner: Object.freeze({ ...this.owner }),
      capabilities: Object.freeze({ ...this.capabilities }),
      coordinationScope: this.coordinationScope,
      targetBindingDigest: this.targetBindingDigest,
      resource: this.#resourceSelection,
      assertPageAffinity: (page: unknown, observation?: OperationRuntimeAffinityObservation) =>
        context.assertPageAffinity(page, observation)
    });
  }

  /**
   * Verify both page object identity and all available stable ownership
   * evidence.  A context with an exact tab binding requires an explicit
   * observed stable tab ID and (when bound) the current authoritative claim.
   */
  assertPageAffinity(
    page: unknown,
    observation?: OperationRuntimeAffinityObservation
  ): OperationRuntimeAffinityResult {
    if (page !== this.page) {
      throw new OperationRuntimeContextError(
        "page_affinity_mismatch",
        "The supplied page is not the page bound to this operation context.",
        this.#diagnosticsView
      );
    }
    const observed = validateAffinityObservation(observation);
    const needsTabEvidence = this.tabId !== undefined;
    if (needsTabEvidence && (observed.tabId === undefined || observed.tabId !== this.tabId)) {
      throw new OperationRuntimeContextError(
        "tab_affinity_mismatch",
        "The supplied tab evidence does not match the operation context.",
        this.#diagnosticsView
      );
    }
    if (this.authoritativeClaim.status === "available" && !claimMatches(this.authoritativeClaim, observed.authoritativeClaim)) {
      throw new OperationRuntimeContextError(
        "claim_drift",
        "The authoritative tab claim no longer matches the operation context.",
        this.#diagnosticsView
      );
    }
    return Object.freeze({
      pageMatches: true as const,
      tabMatches: !needsTabEvidence || observed.tabId === this.tabId,
      claimMatches: claimMatches(this.authoritativeClaim, observed.authoritativeClaim),
      exactTabOwnership: this.#resourceSelection.exactTabOwnership
    });
  }
}

export function createOperationRuntimeContext<Page extends object = object>(
  input: OperationRuntimeContextInput<Page>
): OperationRuntimeContext<Page> {
  return OperationRuntimeContext.create(input);
}
