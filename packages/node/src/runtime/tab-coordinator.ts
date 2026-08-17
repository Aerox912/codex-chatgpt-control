import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** A stable provider/browser identity.  Ephemeral tab labels are not accepted. */
export type StableBrowserIdentity = Readonly<{
  providerId: string;
  browserId: string;
}>;

/** A stable provider/browser/tab identity.  The tab id must come from the provider. */
export type StableTabIdentity = Readonly<StableBrowserIdentity & {
  tabId: string;
}>;

declare const browserResourceKeyBrand: unique symbol;
declare const tabResourceKeyBrand: unique symbol;

/** Opaque key for the short browser acquisition actor. */
export type BrowserResourceKey = string & {
  readonly [browserResourceKeyBrand]: "BrowserResourceKey";
};

/** Opaque key for the process-scoped tab actor. */
export type TabResourceKey = string & {
  readonly [tabResourceKeyBrand]: "TabResourceKey";
};

export type CoordinatorResourceKind = "browser" | "tab";
export type CoordinatorPriority = "read" | "mutation" | "control";

export type CoordinatorOwner = Readonly<{
  /** Backend process/session that owns this SDK call. */
  backendSessionId: string;
  /** Optional operation or caller id used only for diagnostics. */
  ownerId?: string;
  operationId?: string;
}>;

export type CoordinatorTimingDiagnostics = {
  readonly requestId: string;
  readonly resourceKind: CoordinatorResourceKind;
  readonly resourceKey: string;
  readonly priority: CoordinatorPriority;
  readonly owner: CoordinatorOwner;
  readonly label?: string;
  readonly enqueuedAt: number;
  readonly deadlineAt?: number;
  startedAt?: number;
  /** Time the hierarchical browser gate admitted the callback. */
  admittedAt?: number;
  settledAt?: number;
  queueDelayMs?: number;
  /** Time spent waiting at the parent browser gate after this actor started. */
  admissionDelayMs?: number;
  executionMs?: number;
  totalMs?: number;
  queuedCancellation?: boolean;
  queuedDeadlineExceeded?: boolean;
  aborted?: boolean;
  deadlineExceededInFlight?: boolean;
  quarantinedUntilSettled?: boolean;
  outcome?: "fulfilled" | "rejected";
};

export type CoordinatorAcquisitionContext = Readonly<{
  resourceKind: CoordinatorResourceKind;
  resourceKey: string;
  acquisitionToken: string;
  owner: CoordinatorOwner;
  priority: CoordinatorPriority;
  signal: AbortSignal;
  timing: CoordinatorTimingDiagnostics;
}>;

export type CoordinatorQueueDiagnostics = Readonly<{
  resourceKind: CoordinatorResourceKind;
  resourceKey: string;
  queueDepth: number;
  active: boolean;
  activeRequestId?: string;
  activeOwner?: CoordinatorOwner;
  completedCount: number;
  rejectedCount: number;
  lastCompleted?: CoordinatorTimingDiagnostics;
  lastRejected?: CoordinatorTimingDiagnostics;
  /** Present while a deadline-aborted callback is still settling. */
  quarantinedUntilSettled?: CoordinatorTimingDiagnostics;
  /**
   * The browser-level parent gate for tab diagnostics, or the gate backing a
   * browser actor's own diagnostics.  This is intentionally a detached
   * summary: callers must not be able to mutate scheduler state through
   * diagnostics.
   */
  browserGate?: CoordinatorBrowserGateDiagnostics;
}>;

export type CoordinatorBrowserGateDiagnostics = Readonly<{
  resourceKind: "browser";
  resourceKey: BrowserResourceKey;
  queueDepth: number;
  active: boolean;
  activeSharedCount: number;
  queuedExclusiveCount: number;
  queuedSharedCount: number;
  rejectedCount: number;
  activeExclusiveRequestId?: string;
  activeExclusiveOwner?: CoordinatorOwner;
}>;

export type CoordinatorRequestOptions = Readonly<{
  owner: CoordinatorOwner;
  priority?: CoordinatorPriority;
  signal?: AbortSignal;
  /** An absolute epoch-millisecond deadline. */
  deadlineAt?: number;
  /** A relative deadline. Cannot be combined with deadlineAt. */
  timeoutMs?: number;
  label?: string;
  /** Explicit parent context for re-entry detection across async boundaries. */
  acquisitionContext?: CoordinatorAcquisitionContext;
}>;

export type TabCoordinatorOptions = Readonly<{
  /** Maximum number of queued (not active) calls per resource actor. */
  maxQueueSize?: number;
  /** Maximum consecutive reads before a waiting mutation is selected. */
  maxConsecutiveReads?: number;
  /** Maximum consecutive mutations before a waiting control is selected. */
  maxConsecutiveMutations?: number;
  /** Maximum consecutive controls before a waiting mutation is selected. */
  maxConsecutiveControls?: number;
  /** A waiting request older than this is selected by age, regardless of priority. */
  maxWaitMs?: number;
  /** Maximum consecutive browser-exclusive turns before a queued shared turn. */
  maxConsecutiveBrowserExclusives?: number;
  /** Maximum number of detached idle diagnostics retained for later inspection. */
  maxIdleDiagnostics?: number;
  now?: () => number;
}>;

const INVALID_ID_VALUES = new Set(["unknown", "undefined", "null", "n/a", "na"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function validateStableId(label: string, value: string): string {
  if (typeof value !== "string") {
    throw new InvalidResourceKeyError(`${label} must be a non-empty stable string`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    INVALID_ID_VALUES.has(normalized.toLowerCase()) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new InvalidResourceKeyError(`${label} must be a known stable identifier`);
  }
  return normalized;
}

function validateOwner(owner: CoordinatorOwner): CoordinatorOwner {
  if (!owner || typeof owner !== "object") {
    throw new InvalidCoordinatorRequestError("owner metadata is required");
  }
  const backendSessionId = validateStableId("owner.backendSessionId", owner.backendSessionId);
  const ownerId = owner.ownerId === undefined ? undefined : validateStableId("owner.ownerId", owner.ownerId);
  const operationId = owner.operationId === undefined ? undefined : validateStableId("owner.operationId", owner.operationId);
  return Object.freeze({
    backendSessionId,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(operationId === undefined ? {} : { operationId })
  });
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function createBrowserResourceKey(
  identity: StableBrowserIdentity
): BrowserResourceKey;
export function createBrowserResourceKey(providerId: string, browserId: string): BrowserResourceKey;
export function createBrowserResourceKey(
  providerOrIdentity: StableBrowserIdentity | string,
  browserId?: string
): BrowserResourceKey {
  if (
    providerOrIdentity === null ||
    typeof providerOrIdentity !== "string" && typeof providerOrIdentity !== "object"
  ) {
    throw new InvalidResourceKeyError("browser identity must contain stable providerId and browserId");
  }
  const providerId = typeof providerOrIdentity === "string" ? providerOrIdentity : providerOrIdentity.providerId;
  const resolvedBrowserId = typeof providerOrIdentity === "string" ? browserId : providerOrIdentity.browserId;
  const provider = validateStableId("providerId", providerId);
  const browser = validateStableId("browserId", resolvedBrowserId as string);
  return `browser:${encodeKeyPart(provider)}:${encodeKeyPart(browser)}` as BrowserResourceKey;
}

export function createTabResourceKey(
  identity: StableTabIdentity
): TabResourceKey;
export function createTabResourceKey(providerId: string, browserId: string, tabId: string): TabResourceKey;
export function createTabResourceKey(
  providerOrIdentity: StableTabIdentity | string,
  browserId?: string,
  tabId?: string
): TabResourceKey {
  if (
    providerOrIdentity === null ||
    typeof providerOrIdentity !== "string" && typeof providerOrIdentity !== "object"
  ) {
    throw new InvalidResourceKeyError("tab identity must contain stable providerId, browserId, and tabId");
  }
  const providerId = typeof providerOrIdentity === "string" ? providerOrIdentity : providerOrIdentity.providerId;
  const resolvedBrowserId = typeof providerOrIdentity === "string" ? browserId : providerOrIdentity.browserId;
  const resolvedTabId = typeof providerOrIdentity === "string" ? tabId : providerOrIdentity.tabId;
  const provider = validateStableId("providerId", providerId);
  const browser = validateStableId("browserId", resolvedBrowserId as string);
  const tab = validateStableId("tabId", resolvedTabId as string);
  return `tab:${encodeKeyPart(provider)}:${encodeKeyPart(browser)}:${encodeKeyPart(tab)}` as TabResourceKey;
}

export class CoordinatorError extends Error {
  readonly code: string;
  readonly diagnostics?: CoordinatorTimingDiagnostics | CoordinatorQueueDiagnostics;

  constructor(
    code: string,
    message: string,
    diagnostics?: CoordinatorTimingDiagnostics | CoordinatorQueueDiagnostics
  ) {
    super(message);
    this.name = "CoordinatorError";
    this.code = code;
    // Errors can be returned while an in-flight callback remains quarantined.
    // Never expose the actor's live timing object to a caller that could
    // mutate scheduler state before that callback settles.
    if (diagnostics !== undefined) this.diagnostics = freezeCoordinatorDiagnostics(diagnostics);
  }
}

export class InvalidResourceKeyError extends CoordinatorError {
  constructor(message: string) {
    super("invalid_resource_key", message);
    this.name = "InvalidResourceKeyError";
  }
}

export class InvalidCoordinatorRequestError extends CoordinatorError {
  constructor(message: string) {
    super("invalid_request", message);
    this.name = "InvalidCoordinatorRequestError";
  }
}

export class CoordinatorQueueFullError extends CoordinatorError {
  constructor(diagnostics: CoordinatorQueueDiagnostics) {
    super(
      "queue_full",
      `The ${diagnostics.resourceKind} coordinator queue is full (${diagnostics.queueDepth} pending requests)`,
      diagnostics
    );
    this.name = "CoordinatorQueueFullError";
  }
}

export type CoordinatorCancellationPhase = "queued" | "in_flight";

export class CoordinatorAbortedError extends CoordinatorError {
  readonly phase: CoordinatorCancellationPhase;

  constructor(phase: CoordinatorCancellationPhase, diagnostics: CoordinatorTimingDiagnostics) {
    super("aborted", `Coordinator request was aborted while ${phase}`, diagnostics);
    this.name = "CoordinatorAbortedError";
    this.phase = phase;
  }
}

export class CoordinatorDeadlineExceededError extends CoordinatorError {
  readonly phase: CoordinatorCancellationPhase;

  constructor(phase: CoordinatorCancellationPhase, diagnostics: CoordinatorTimingDiagnostics) {
    super("deadline_exceeded", `Coordinator deadline exceeded while ${phase}`, diagnostics);
    this.name = "CoordinatorDeadlineExceededError";
    this.phase = phase;
  }
}

export class ReentrantAcquisitionError extends CoordinatorError {
  readonly resourceKind: CoordinatorResourceKind;
  readonly resourceKey: string;

  constructor(context: CoordinatorAcquisitionContext) {
    super(
      "reentrant_acquisition",
      `Re-entrant ${context.resourceKind} acquisition rejected for ${context.resourceKey}; use a short callback and release the actor before reacquiring`,
      context.timing
    );
    this.name = "ReentrantAcquisitionError";
    this.resourceKind = context.resourceKind;
    this.resourceKey = context.resourceKey;
  }
}

type InternalResourceKey = BrowserResourceKey | TabResourceKey;
type Callback<T, Context extends CoordinatorAcquisitionContext> = (context: Context) => T | PromiseLike<T>;
type AdmissionLease = () => void;

/**
 * Admission is deliberately internal to the actor.  The actor remains the
 * owner of queue/deadline/quarantine state while a hierarchical browser gate
 * decides whether the callback may touch the provider/browser resource.
 */
type ResourceAdmission = {
  onAccepted: () => void;
  onStarted: (context: CoordinatorAcquisitionContext) => Promise<AdmissionLease>;
  onAbandoned: () => void;
  onSettled: () => void;
};

type PendingRequest = {
  requestId: string;
  sequence: number;
  priority: CoordinatorPriority;
  owner: CoordinatorOwner;
  label?: string;
  enqueuedAt: number;
  deadlineAt?: number;
  callback: Callback<unknown, CoordinatorAcquisitionContext>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timing: CoordinatorTimingDiagnostics;
  controller: AbortController;
  externalSignal?: AbortSignal;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  started: boolean;
  settled: boolean;
  /** Whether the public promise has already been resolved or rejected. */
  callerSettled: boolean;
  cancelled: boolean;
  inFlightError?: CoordinatorAbortedError | CoordinatorDeadlineExceededError;
  context?: CoordinatorAcquisitionContext;
  admission: ResourceAdmission;
};

type ActorOptions = {
  resourceKind: CoordinatorResourceKind;
  resourceKey: InternalResourceKey;
  maxQueueSize: number;
  maxConsecutiveReads: number;
  maxConsecutiveMutations: number;
  maxConsecutiveControls: number;
  maxWaitMs: number;
  now: () => number;
};

const acquisitionContexts = new AsyncLocalStorage<CoordinatorAcquisitionContext>();
const activeAcquisitionTokens = new Set<string>();

function cloneTiming(timing: CoordinatorTimingDiagnostics): CoordinatorTimingDiagnostics {
  return {
    ...timing,
    owner: { ...timing.owner }
  };
}

function cloneBrowserGateDiagnostics(
  diagnostics: CoordinatorBrowserGateDiagnostics
): CoordinatorBrowserGateDiagnostics {
  return {
    ...diagnostics,
    ...(diagnostics.activeExclusiveOwner === undefined ? {} : {
      activeExclusiveOwner: { ...diagnostics.activeExclusiveOwner }
    })
  };
}

function cloneQueueDiagnostics(diagnostics: CoordinatorQueueDiagnostics): CoordinatorQueueDiagnostics {
  return {
    ...diagnostics,
    ...(diagnostics.activeOwner === undefined ? {} : { activeOwner: { ...diagnostics.activeOwner } }),
    ...(diagnostics.lastCompleted === undefined ? {} : { lastCompleted: cloneTiming(diagnostics.lastCompleted) }),
    ...(diagnostics.lastRejected === undefined ? {} : { lastRejected: cloneTiming(diagnostics.lastRejected) }),
    ...(diagnostics.quarantinedUntilSettled === undefined ? {} : {
      quarantinedUntilSettled: cloneTiming(diagnostics.quarantinedUntilSettled)
    }),
    ...(diagnostics.browserGate === undefined ? {} : {
      browserGate: cloneBrowserGateDiagnostics(diagnostics.browserGate)
    })
  };
}

function freezeTiming(timing: CoordinatorTimingDiagnostics): CoordinatorTimingDiagnostics {
  return Object.freeze({
    ...timing,
    owner: Object.freeze({ ...timing.owner })
  });
}

function freezeCoordinatorDiagnostics(
  diagnostics: CoordinatorTimingDiagnostics | CoordinatorQueueDiagnostics
): CoordinatorTimingDiagnostics | CoordinatorQueueDiagnostics {
  if ("requestId" in diagnostics) return freezeTiming(diagnostics);
  return Object.freeze({
    ...diagnostics,
    ...(diagnostics.activeOwner === undefined ? {} : {
      activeOwner: Object.freeze({ ...diagnostics.activeOwner })
    }),
    ...(diagnostics.lastCompleted === undefined ? {} : {
      lastCompleted: freezeTiming(diagnostics.lastCompleted)
    }),
    ...(diagnostics.lastRejected === undefined ? {} : {
      lastRejected: freezeTiming(diagnostics.lastRejected)
    }),
    ...(diagnostics.quarantinedUntilSettled === undefined ? {} : {
      quarantinedUntilSettled: freezeTiming(diagnostics.quarantinedUntilSettled)
    }),
    ...(diagnostics.browserGate === undefined ? {} : {
      browserGate: Object.freeze({
        ...diagnostics.browserGate,
        ...(diagnostics.browserGate.activeExclusiveOwner === undefined ? {} : {
          activeExclusiveOwner: Object.freeze({ ...diagnostics.browserGate.activeExclusiveOwner })
        })
      })
    })
  });
}

function validateResourceKey(kind: CoordinatorResourceKind, value: InternalResourceKey): void {
  if (typeof value !== "string") {
    throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
  }
  parseResourceIdentity(kind, value);
}

type ParsedResourceIdentity = Readonly<{
  providerId: string;
  browserId: string;
  tabId?: string;
}>;

/**
 * Decode only the canonical keys produced by the factories above.  In
 * particular, do not derive a browser key by splitting a caller-provided tab
 * key and interpolating strings: the encoded parts must round-trip exactly
 * through the stable-id validators first.
 */
function parseResourceIdentity(
  kind: CoordinatorResourceKind,
  value: InternalResourceKey
): ParsedResourceIdentity {
  const parts = value.split(":");
  const expectedParts = kind === "browser" ? 3 : 4;
  if (parts.length !== expectedParts || parts[0] !== kind) {
    throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
  }
  const decode = (encoded: string, label: string): string => {
    if (encoded.length === 0) {
      throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
    }
    // Reject alternate encodings (for example %62 for b) so this parser is a
    // canonical identity boundary rather than permissive string guesswork.
    if (encodeKeyPart(decoded) !== encoded) {
      throw new InvalidResourceKeyError(`${kind} resource key must be created by the coordinator key factory`);
    }
    return validateStableId(label, decoded);
  };
  const providerId = decode(parts[1]!, "providerId");
  const browserId = decode(parts[2]!, "browserId");
  if (kind === "browser") return { providerId, browserId };
  return { providerId, browserId, tabId: decode(parts[3]!, "tabId") };
}

function browserKeyForResource(
  kind: CoordinatorResourceKind,
  resourceKey: InternalResourceKey
): BrowserResourceKey {
  const identity = parseResourceIdentity(kind, resourceKey);
  return createBrowserResourceKey(identity.providerId, identity.browserId);
}

function validatePriority(priority: CoordinatorPriority | undefined): CoordinatorPriority {
  if (priority === undefined) return "read";
  if (priority !== "read" && priority !== "mutation" && priority !== "control") {
    throw new InvalidCoordinatorRequestError(`Unsupported coordinator priority: ${String(priority)}`);
  }
  return priority;
}

function validatePositiveInteger(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidCoordinatorRequestError(`${label} must be a positive integer`);
  }
  return value;
}

type BrowserGateWaiterKind = "exclusive" | "shared";

type BrowserGateWaiter = {
  readonly requestId: string;
  readonly sequence: number;
  readonly kind: BrowserGateWaiterKind;
  started: boolean;
  acquired: boolean;
  settled: boolean;
  context?: CoordinatorAcquisitionContext;
  resolve?: (lease: AdmissionLease) => void;
  reject?: (reason?: unknown) => void;
  promise?: Promise<AdmissionLease>;
  abortListener?: () => void;
};

/**
 * One gate per provider/browser.  Browser acquisitions are exclusive.  Tab
 * transactions are shared leases, but only while no exclusive browser waiter
 * exists.  This gives the browser actor a bounded writer turn even when tab
 * actors for many different tabs are active concurrently.
 */
class BrowserGate {
  private readonly queue: BrowserGateWaiter[] = [];
  private readonly activeShared = new Set<BrowserGateWaiter>();
  private activeExclusive?: BrowserGateWaiter;
  private sequence = 0;
  private drainScheduled = false;
  private rejectedCount = 0;
  private consecutiveExclusive = 0;
  /**
   * Shared admissions are reserved when their tab actor accepts a request,
   * not only when that actor reaches its execution turn.  Without this
   * counter a gate could look idle while another tab still had queued work
   * holding a closure over the old gate, allowing a replacement gate to be
   * created for the same browser.
   */
  private acceptedSharedReservations = 0;
  private pendingSharedReservations = 0;

  constructor(
    private readonly resourceKey: BrowserResourceKey,
    private readonly maxQueueSize: number,
    private readonly maxConsecutiveExclusives: number
  ) {}

  createExclusiveAdmission(): ResourceAdmission {
    let waiter: BrowserGateWaiter | undefined;
    return {
      onAccepted: () => {
        if (waiter !== undefined) {
          throw new InvalidCoordinatorRequestError("browser admission was accepted more than once");
        }
        waiter = this.reserve("exclusive");
      },
      onStarted: (context) => {
        if (waiter === undefined) {
          return Promise.reject(new InvalidCoordinatorRequestError("browser admission was not accepted"));
        }
        return this.start(waiter, context);
      },
      onAbandoned: () => {
        if (waiter !== undefined) this.cancel(waiter);
        waiter = undefined;
      },
      onSettled: () => {
        if (waiter !== undefined) this.settle(waiter);
        waiter = undefined;
      }
    };
  }

  createSharedAdmission(): ResourceAdmission {
    let waiter: BrowserGateWaiter | undefined;
    let accepted = false;
    let started = false;
    return {
      onAccepted: () => {
        if (accepted) {
          throw new InvalidCoordinatorRequestError("tab admission was accepted more than once");
        }
        this.assertReservationCapacity();
        accepted = true;
        started = false;
        this.acceptedSharedReservations += 1;
        this.pendingSharedReservations += 1;
      },
      onStarted: (context) => {
        if (!accepted || waiter !== undefined) {
          return Promise.reject(new InvalidCoordinatorRequestError("tab admission was accepted more than once"));
        }
        // Convert the already-counted pending reservation into a concrete gate
        // waiter without briefly double-counting it against the browser-wide
        // queue bound. Restore the reservation if allocation fails so the
        // actor's settlement path can release it exactly once.
        this.pendingSharedReservations -= 1;
        try {
          waiter = this.reserve("shared");
          started = true;
        } catch (error) {
          this.pendingSharedReservations += 1;
          throw error;
        }
        return this.start(waiter, context);
      },
      onAbandoned: () => {
        if (waiter !== undefined) this.cancel(waiter);
        waiter = undefined;
        if (accepted) {
          this.acceptedSharedReservations -= 1;
          if (!started) this.pendingSharedReservations -= 1;
        }
        accepted = false;
        started = false;
      },
      onSettled: () => {
        if (waiter !== undefined) this.settle(waiter);
        waiter = undefined;
        if (accepted) {
          this.acceptedSharedReservations -= 1;
          if (!started) this.pendingSharedReservations -= 1;
        }
        accepted = false;
        started = false;
      }
    };
  }

  isIdle(): boolean {
    return this.queue.length === 0 &&
      this.activeExclusive === undefined &&
      this.activeShared.size === 0 &&
      this.acceptedSharedReservations === 0;
  }

  snapshot(): CoordinatorBrowserGateDiagnostics {
    return {
      resourceKind: "browser",
      resourceKey: this.resourceKey,
      queueDepth: this.queue.length + this.pendingSharedReservations,
      active: this.activeExclusive !== undefined || this.activeShared.size > 0,
      activeSharedCount: this.activeShared.size,
      queuedExclusiveCount: this.queue.filter((waiter) => waiter.kind === "exclusive").length,
      queuedSharedCount: this.queue.filter((waiter) => waiter.kind === "shared").length + this.pendingSharedReservations,
      rejectedCount: this.rejectedCount,
      ...(this.activeExclusive === undefined ? {} : {
        activeExclusiveRequestId: this.activeExclusive.requestId,
        ...(this.activeExclusive.context === undefined ? {} : {
          activeExclusiveOwner: { ...this.activeExclusive.context.owner }
        })
      })
    };
  }

  private queueSnapshot(): CoordinatorQueueDiagnostics {
    return {
      resourceKind: "browser",
      resourceKey: this.resourceKey,
      queueDepth: this.queue.length + this.pendingSharedReservations,
      active: this.activeExclusive !== undefined || this.activeShared.size > 0,
      ...(this.activeExclusive === undefined ? {} : { activeRequestId: this.activeExclusive.requestId }),
      completedCount: 0,
      rejectedCount: this.rejectedCount
    };
  }

  private reserve(kind: BrowserGateWaiterKind): BrowserGateWaiter {
    this.assertReservationCapacity();
    const waiter: BrowserGateWaiter = {
      requestId: randomUUID(),
      sequence: ++this.sequence,
      kind,
      started: false,
      acquired: false,
      settled: false
    };
    this.queue.push(waiter);
    return waiter;
  }

  private assertReservationCapacity(): void {
    if (this.queue.length + this.pendingSharedReservations < this.maxQueueSize) return;
    this.rejectedCount += 1;
    throw new CoordinatorQueueFullError(this.queueSnapshot());
  }

  private start(waiter: BrowserGateWaiter, context: CoordinatorAcquisitionContext): Promise<AdmissionLease> {
    if (waiter.settled) {
      return Promise.reject(new InvalidCoordinatorRequestError("coordinator admission is no longer active"));
    }
    if (waiter.started) {
      return Promise.reject(new InvalidCoordinatorRequestError("coordinator admission was started more than once"));
    }
    waiter.started = true;
    waiter.context = context;
    waiter.promise = new Promise<AdmissionLease>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    const onAbort = (): void => {
      if (waiter.acquired || waiter.settled) return;
      const reason = context.signal.reason;
      const error = reason instanceof CoordinatorDeadlineExceededError || reason instanceof CoordinatorAbortedError
        ? reason
        : new CoordinatorAbortedError("in_flight", context.timing);
      this.cancel(waiter, error);
    };
    waiter.abortListener = onAbort;
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    this.scheduleDrain();
    return waiter.promise;
  }

  private hasExclusiveWaiter(): boolean {
    return this.queue.some((waiter) => waiter.kind === "exclusive");
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.activeExclusive !== undefined) return;

    // A queued exclusive request freezes new shared leases until every
    // already-active tab lease has released.  This is the writer gate that
    // prevents a stream of other tabs from starving browser-level controls.
    if (this.activeShared.size > 0 && this.hasExclusiveWaiter()) return;

    const exclusive = this.queue
      .filter((waiter) => waiter.kind === "exclusive" && waiter.started)
      .sort((left, right) => left.sequence - right.sequence)[0];

    const shared = this.queue.filter((waiter) => waiter.kind === "shared" && waiter.started);
    if (
      shared.length > 0 &&
      this.consecutiveExclusive >= this.maxConsecutiveExclusives
    ) {
      // A browser-exclusive waiter has writer preference so new tab work
      // cannot continually extend an existing shared turn.  Bound that
      // preference as well: after the configured number of exclusive turns,
      // admit the already queued shared batch.  New shared reservations remain
      // blocked while the batch is active because hasExclusiveWaiter() is
      // still true.
      for (const waiter of shared) this.grant(waiter);
      this.consecutiveExclusive = 0;
      return;
    }

    if (exclusive !== undefined && this.activeShared.size === 0) {
      this.grant(exclusive);
      this.consecutiveExclusive += 1;
      return;
    }

    // A reserved browser request may not have reached its ResourceActor
    // execution turn yet.  It still blocks readers, so that handoff cannot
    // be overtaken by a tab started in the meantime.
    if (this.hasExclusiveWaiter()) return;

    for (const waiter of [...this.queue]) {
      if (waiter.kind === "shared" && waiter.started) this.grant(waiter);
    }
  }

  private grant(waiter: BrowserGateWaiter): void {
    const index = this.queue.indexOf(waiter);
    if (index < 0 || waiter.settled || !waiter.started) return;
    this.queue.splice(index, 1);
    waiter.acquired = true;
    if (waiter.kind === "exclusive") this.activeExclusive = waiter;
    else this.activeShared.add(waiter);
    this.detachAbortListener(waiter);
    waiter.resolve?.(() => this.release(waiter));
  }

  private release(waiter: BrowserGateWaiter): void {
    if (waiter.settled) return;
    if (!waiter.acquired) {
      this.cancel(waiter);
      return;
    }
    waiter.acquired = false;
    waiter.settled = true;
    if (waiter.kind === "exclusive") {
      if (this.activeExclusive === waiter) delete this.activeExclusive;
    } else {
      this.activeShared.delete(waiter);
    }
    this.detachAbortListener(waiter);
    this.scheduleDrain();
  }

  private settle(waiter: BrowserGateWaiter): void {
    if (waiter.settled) return;
    if (waiter.acquired) {
      this.release(waiter);
      return;
    }
    this.cancel(waiter);
  }

  private cancel(waiter: BrowserGateWaiter, reason?: unknown): void {
    if (waiter.settled || waiter.acquired) return;
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    waiter.settled = true;
    this.detachAbortListener(waiter);
    if (waiter.started) {
      waiter.reject?.(reason ?? new CoordinatorAbortedError("in_flight", waiter.context!.timing));
    }
    this.scheduleDrain();
  }

  private detachAbortListener(waiter: BrowserGateWaiter): void {
    if (waiter.abortListener !== undefined && waiter.context !== undefined) {
      waiter.context.signal.removeEventListener("abort", waiter.abortListener);
      delete waiter.abortListener;
    }
  }
}

class ResourceActor {
  private readonly queue: PendingRequest[] = [];
  private active?: PendingRequest;
  private sequence = 0;
  private drainScheduled = false;
  private consecutive: Record<CoordinatorPriority, number> = { read: 0, mutation: 0, control: 0 };
  private completedCount: number;
  private rejectedCount: number;
  private lastCompleted?: CoordinatorTimingDiagnostics;
  private lastRejected?: CoordinatorTimingDiagnostics;
  private quarantinedUntilSettled?: CoordinatorTimingDiagnostics;

  constructor(
    private readonly options: ActorOptions,
    initialDiagnostics?: CoordinatorQueueDiagnostics,
    private readonly onIdle?: (actor: ResourceActor) => void
  ) {
    this.completedCount = initialDiagnostics?.completedCount ?? 0;
    this.rejectedCount = initialDiagnostics?.rejectedCount ?? 0;
    if (initialDiagnostics?.lastCompleted !== undefined) {
      this.lastCompleted = cloneTiming(initialDiagnostics.lastCompleted);
    }
    if (initialDiagnostics?.lastRejected !== undefined) {
      this.lastRejected = cloneTiming(initialDiagnostics.lastRejected);
    }
    if (initialDiagnostics?.quarantinedUntilSettled !== undefined) {
      this.quarantinedUntilSettled = cloneTiming(initialDiagnostics.quarantinedUntilSettled);
    }
  }

  isIdle(): boolean {
    return this.active === undefined && this.queue.length === 0 && this.quarantinedUntilSettled === undefined;
  }

  private notifyIfIdle(): void {
    if (this.isIdle()) this.onIdle?.(this);
  }

  snapshot(): CoordinatorQueueDiagnostics {
    return {
      resourceKind: this.options.resourceKind,
      resourceKey: this.options.resourceKey,
      queueDepth: this.queue.length,
      active: this.active !== undefined,
      ...(this.active === undefined ? {} : {
        activeRequestId: this.active.requestId,
        activeOwner: this.active.owner
      }),
      completedCount: this.completedCount,
      rejectedCount: this.rejectedCount,
      ...(this.lastCompleted === undefined ? {} : { lastCompleted: cloneTiming(this.lastCompleted) }),
      ...(this.lastRejected === undefined ? {} : { lastRejected: cloneTiming(this.lastRejected) }),
      ...(this.quarantinedUntilSettled === undefined ? {} : {
        quarantinedUntilSettled: cloneTiming(this.quarantinedUntilSettled)
      })
    };
  }

  enqueue<T>(
    request: Omit<PendingRequest, "sequence" | "started" | "settled" | "callerSettled" | "cancelled" | "resolve" | "reject">,
    externalSignal?: AbortSignal
  ): Promise<T> {
    if (this.queue.length >= this.options.maxQueueSize) {
      this.rejectedCount += 1;
      request.timing.outcome = "rejected";
      request.timing.settledAt = this.options.now();
      request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
      this.lastRejected = request.timing;
      this.notifyIfIdle();
      return Promise.reject(new CoordinatorQueueFullError(this.snapshot()));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        ...request,
        ...(externalSignal === undefined ? {} : { externalSignal }),
        sequence: ++this.sequence,
        resolve: (value: unknown) => resolve(value as T),
        reject,
        started: false,
        settled: false,
        callerSettled: false,
        cancelled: false
      };
      if (externalSignal !== undefined) {
        const onAbort = (): void => this.handleAbort(pending, externalSignal.reason);
        pending.abortListener = onAbort;
        externalSignal.addEventListener("abort", onAbort, { once: true });
        if (externalSignal.aborted) {
          this.handleAbort(pending, externalSignal.reason);
          return;
        }
      }
      if (pending.deadlineAt !== undefined && pending.deadlineAt <= this.options.now()) {
        this.handleDeadline(pending);
        return;
      }
      try {
        pending.admission.onAccepted();
      } catch (error) {
        this.clearDeadline(pending);
        this.detachAbortListener(pending);
        pending.settled = true;
        pending.callerSettled = true;
        pending.timing.outcome = "rejected";
        pending.timing.settledAt = this.options.now();
        pending.timing.totalMs = pending.timing.settledAt - pending.timing.enqueuedAt;
        pending.admission.onAbandoned();
        this.rejectedCount += 1;
        this.lastRejected = pending.timing;
        pending.reject(error);
        this.notifyIfIdle();
        return;
      }
      this.queue.push(pending);
      this.armDeadline(pending);
      this.scheduleDrain();
    });
  }

  private armDeadline(request: PendingRequest): void {
    if (request.deadlineAt === undefined) return;
    const tick = (): void => {
      if (request.settled || request.cancelled) return;
      const remaining = request.deadlineAt! - this.options.now();
      if (remaining <= 0) {
        this.handleDeadline(request);
        return;
      }
      request.deadlineTimer = setTimeout(tick, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    tick();
  }

  private clearDeadline(request: PendingRequest): void {
    if (request.deadlineTimer !== undefined) {
      clearTimeout(request.deadlineTimer);
      delete request.deadlineTimer;
    }
  }

  private detachAbortListener(request: PendingRequest): void {
    if (request.abortListener !== undefined && request.externalSignal !== undefined) {
      request.externalSignal.removeEventListener("abort", request.abortListener);
      delete request.abortListener;
    }
  }

  private handleAbort(request: PendingRequest, reason: unknown): void {
    if (request.settled) return;
    if (!request.started) {
      request.cancelled = true;
      request.timing.queuedCancellation = true;
      this.removeQueued(request);
      request.admission.onAbandoned();
      request.settled = true;
      request.callerSettled = true;
      request.timing.outcome = "rejected";
      request.timing.settledAt = this.options.now();
      request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
      this.rejectedCount += 1;
      this.lastRejected = request.timing;
      request.reject(new CoordinatorAbortedError("queued", request.timing));
      this.scheduleDrain();
      this.notifyIfIdle();
      return;
    }
    request.timing.aborted = true;
    request.timing.quarantinedUntilSettled = true;
    this.quarantinedUntilSettled = request.timing;
    request.inFlightError ??= new CoordinatorAbortedError("in_flight", request.timing);
    if (!request.callerSettled) {
      request.callerSettled = true;
      request.reject(request.inFlightError);
    }
    request.controller.abort(reason ?? new Error("The caller aborted the coordinator request"));
  }

  private handleDeadline(request: PendingRequest): void {
    if (request.settled) return;
    if (!request.started) {
      request.cancelled = true;
      request.timing.queuedDeadlineExceeded = true;
      this.removeQueued(request);
      request.admission.onAbandoned();
      request.settled = true;
      request.callerSettled = true;
      request.timing.outcome = "rejected";
      request.timing.settledAt = this.options.now();
      request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
      this.rejectedCount += 1;
      this.lastRejected = request.timing;
      request.reject(new CoordinatorDeadlineExceededError("queued", request.timing));
      this.scheduleDrain();
      this.notifyIfIdle();
      return;
    }
    request.timing.deadlineExceededInFlight = true;
    request.timing.quarantinedUntilSettled = true;
    this.quarantinedUntilSettled = request.timing;
    request.inFlightError ??= new CoordinatorDeadlineExceededError("in_flight", request.timing);
    if (!request.callerSettled) {
      request.callerSettled = true;
      request.reject(request.inFlightError);
    }
    request.controller.abort(new CoordinatorDeadlineExceededError("in_flight", request.timing));
  }

  private removeQueued(request: PendingRequest): void {
    const index = this.queue.indexOf(request);
    if (index >= 0) this.queue.splice(index, 1);
    this.clearDeadline(request);
    this.detachAbortListener(request);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.active !== undefined) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.active !== undefined) return;
    let request = this.selectNext();
    while (request !== undefined && request.cancelled) request = this.selectNext();
    if (request === undefined) return;
    request.started = true;
    request.timing.startedAt = this.options.now();
    request.timing.queueDelayMs = request.timing.startedAt - request.timing.enqueuedAt;
    // Keep the deadline timer and external abort listener attached while the
    // callback is in flight.  The actor remains active until it settles.
    this.active = request;
    const acquisitionToken = randomUUID();
    const context: CoordinatorAcquisitionContext = Object.freeze({
      resourceKind: this.options.resourceKind,
      resourceKey: this.options.resourceKey,
      acquisitionToken,
      owner: request.owner,
      priority: request.priority,
      signal: request.controller.signal,
      timing: freezeTiming(request.timing)
    });
    request.context = context;
    void this.execute(request, context);
  }

  private async execute(request: PendingRequest, context: CoordinatorAcquisitionContext): Promise<void> {
    activeAcquisitionTokens.add(context.acquisitionToken);
    let admissionLease: AdmissionLease | undefined;
    try {
      admissionLease = await acquisitionContexts.run(context, () => request.admission.onStarted(context));
      request.timing.admittedAt = this.options.now();
      request.timing.admissionDelayMs = request.timing.admittedAt - (request.timing.startedAt ?? request.timing.admittedAt);
      const value = await acquisitionContexts.run(context, () => request.callback(context));
      if (request.inFlightError !== undefined) {
        throw request.inFlightError;
      }
      if (!request.callerSettled) {
        request.callerSettled = true;
        request.resolve(value);
      }
      request.timing.outcome = "fulfilled";
    } catch (error) {
      if (!request.callerSettled) {
        request.callerSettled = true;
        request.reject(request.inFlightError ?? error);
      }
      request.timing.outcome = "rejected";
    } finally {
      admissionLease?.();
      request.admission.onSettled();
      activeAcquisitionTokens.delete(context.acquisitionToken);
      request.settled = true;
      this.clearDeadline(request);
      this.detachAbortListener(request);
      request.timing.settledAt = this.options.now();
      request.timing.executionMs = request.timing.settledAt - (request.timing.admittedAt ?? request.timing.startedAt ?? request.timing.settledAt);
      request.timing.totalMs = request.timing.settledAt - request.timing.enqueuedAt;
      if (request.timing.outcome === "fulfilled") {
        this.completedCount += 1;
        this.lastCompleted = request.timing;
      } else {
        this.rejectedCount += 1;
        this.lastRejected = request.timing;
      }
      if (this.quarantinedUntilSettled === request.timing) delete this.quarantinedUntilSettled;
      delete this.active;
      this.scheduleDrain();
      this.notifyIfIdle();
    }
  }

  private selectNext(): PendingRequest | undefined {
    this.removeExpiredQueued();
    if (this.queue.length === 0) return undefined;
    const now = this.options.now();
    const aged = this.queue
      .filter((request) => now - request.enqueuedAt >= this.options.maxWaitMs)
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (aged !== undefined) {
      this.queue.splice(this.queue.indexOf(aged), 1);
      this.recordSelection(aged.priority);
      return aged;
    }
    const controls = this.queue.filter((request) => request.priority === "control");
    const mutations = this.queue.filter((request) => request.priority === "mutation");
    const reads = this.queue.filter((request) => request.priority === "read");
    let selected: PendingRequest | undefined;
    if (
      controls.length > 0 &&
      (mutations.length === 0 || this.consecutive.control < this.options.maxConsecutiveControls)
    ) {
      selected = controls[0];
    } else if (
      mutations.length > 0 &&
      (reads.length === 0 || (
        this.consecutive.read >= this.options.maxConsecutiveReads &&
        this.consecutive.mutation < this.options.maxConsecutiveMutations
      ))
    ) {
      selected = mutations[0];
    } else if (reads.length > 0) {
      selected = reads[0];
    } else if (mutations.length > 0) {
      selected = mutations[0];
    } else {
      selected = controls[0];
    }
    if (selected === undefined) return undefined;
    this.queue.splice(this.queue.indexOf(selected), 1);
    this.recordSelection(selected.priority);
    return selected;
  }

  private recordSelection(priority: CoordinatorPriority): void {
    for (const candidate of ["read", "mutation", "control"] as const) {
      this.consecutive[candidate] = candidate === priority ? this.consecutive[candidate] + 1 : 0;
    }
  }

  private removeExpiredQueued(): void {
    const now = this.options.now();
    for (const request of [...this.queue]) {
      if (request.deadlineAt !== undefined && request.deadlineAt <= now) this.handleDeadline(request);
    }
  }
}

function makeDeadline(options: CoordinatorRequestOptions, now: number): number | undefined {
  if (options.deadlineAt !== undefined && options.timeoutMs !== undefined) {
    throw new InvalidCoordinatorRequestError("Use deadlineAt or timeoutMs, not both");
  }
  if (options.deadlineAt !== undefined) {
    if (!Number.isFinite(options.deadlineAt)) throw new InvalidCoordinatorRequestError("deadlineAt must be finite");
    return options.deadlineAt;
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new InvalidCoordinatorRequestError("timeoutMs must be a non-negative finite number");
    }
    return now + options.timeoutMs;
  }
  return undefined;
}

/**
 * Process-local actors for short browser acquisition and tab transactions.
 *
 * The class intentionally coordinates only cooperating callers in this
 * process.  It does not advertise provider-level or cross-process tab
 * concurrency; a provider claim/fencing capability must be integrated before
 * those guarantees can be made.  Callback code should perform one short
 * browser operation.  Polling, sleeps, journal I/O, hashing, and report work
 * belong outside this API so no scheduler actor is held by those waits.
 */
export class ProcessTabCoordinator {
  private readonly browserActors = new Map<string, ResourceActor>();
  private readonly tabActors = new Map<string, ResourceActor>();
  private readonly browserGates = new Map<string, BrowserGate>();
  private readonly idleDiagnostics = new Map<string, CoordinatorQueueDiagnostics>();
  private readonly options: Required<Omit<TabCoordinatorOptions, "now">> & { now: () => number };

  constructor(options: TabCoordinatorOptions = {}) {
    this.options = {
      maxQueueSize: validatePositiveInteger("maxQueueSize", options.maxQueueSize ?? 64),
      maxConsecutiveReads: validatePositiveInteger("maxConsecutiveReads", options.maxConsecutiveReads ?? 4),
      maxConsecutiveMutations: validatePositiveInteger("maxConsecutiveMutations", options.maxConsecutiveMutations ?? 4),
      maxConsecutiveControls: validatePositiveInteger("maxConsecutiveControls", options.maxConsecutiveControls ?? 4),
      maxWaitMs: (() => {
        const value = options.maxWaitMs ?? 1_000;
        if (!Number.isFinite(value) || value < 0) throw new InvalidCoordinatorRequestError("maxWaitMs must be non-negative");
        return value;
      })(),
      maxConsecutiveBrowserExclusives: validatePositiveInteger(
        "maxConsecutiveBrowserExclusives",
        options.maxConsecutiveBrowserExclusives ?? 4
      ),
      maxIdleDiagnostics: validatePositiveInteger(
        "maxIdleDiagnostics",
        options.maxIdleDiagnostics ?? 256
      ),
      now: options.now ?? (() => Date.now())
    };
  }

  withBrowserAcquisition<T>(
    resourceKey: BrowserResourceKey,
    options: CoordinatorRequestOptions,
    callback: Callback<T, CoordinatorAcquisitionContext>
  ): Promise<T> {
    return this.enqueue("browser", resourceKey, options, callback);
  }

  withTabTransaction<T>(
    resourceKey: TabResourceKey,
    options: CoordinatorRequestOptions,
    callback: Callback<T, CoordinatorAcquisitionContext>
  ): Promise<T> {
    return this.enqueue("tab", resourceKey, options, callback);
  }

  getBrowserDiagnostics(resourceKey: BrowserResourceKey): CoordinatorQueueDiagnostics {
    validateResourceKey("browser", resourceKey);
    const actor = this.browserActors.get(resourceKey);
    const diagnostics = actor?.snapshot()
      ?? this.idleDiagnostics.get(this.diagnosticsKey("browser", resourceKey))
      ?? this.emptyDiagnostics("browser", resourceKey);
    const gate = this.browserGates.get(resourceKey);
    return cloneQueueDiagnostics(
      gate === undefined ? diagnostics : { ...diagnostics, browserGate: gate.snapshot() }
    );
  }

  getTabDiagnostics(resourceKey: TabResourceKey): CoordinatorQueueDiagnostics {
    validateResourceKey("tab", resourceKey);
    const diagnostics = this.tabActors.get(resourceKey)?.snapshot()
      ?? this.idleDiagnostics.get(this.diagnosticsKey("tab", resourceKey))
      ?? this.emptyDiagnostics("tab", resourceKey);
    const gate = this.browserGates.get(browserKeyForResource("tab", resourceKey));
    return cloneQueueDiagnostics(
      gate === undefined ? diagnostics : { ...diagnostics, browserGate: gate.snapshot() }
    );
  }

  private getActor(kind: CoordinatorResourceKind, key: InternalResourceKey): ResourceActor {
    const actors = kind === "browser" ? this.browserActors : this.tabActors;
    let actor = actors.get(key);
    if (actor === undefined) {
      actor = this.createActor(kind, key);
      actors.set(key, actor);
    }
    return actor;
  }

  private createActor(kind: CoordinatorResourceKind, key: InternalResourceKey): ResourceActor {
    const actors = kind === "browser" ? this.browserActors : this.tabActors;
    const diagnosticsKey = this.diagnosticsKey(kind, key);
    const initialDiagnostics = this.idleDiagnostics.get(diagnosticsKey);
    let actor!: ResourceActor;
    actor = new ResourceActor(
      {
        resourceKind: kind,
        resourceKey: key,
        maxQueueSize: this.options.maxQueueSize,
        maxConsecutiveReads: this.options.maxConsecutiveReads,
        maxConsecutiveMutations: this.options.maxConsecutiveMutations,
        maxConsecutiveControls: this.options.maxConsecutiveControls,
        maxWaitMs: this.options.maxWaitMs,
        now: this.options.now
      },
      initialDiagnostics,
      (idleActor) => this.onActorIdle(kind, key, idleActor)
    );
    // The callback runs only after a later asynchronous request turn, but
    // retaining this identity check makes cleanup safe if a caller creates a
    // replacement actor after an idle notification has been queued.
    if (actors.get(key) === undefined) this.idleDiagnostics.delete(diagnosticsKey);
    return actor;
  }

  private diagnosticsKey(kind: CoordinatorResourceKind, key: InternalResourceKey): string {
    return `${kind}:${key}`;
  }

  private emptyDiagnostics(kind: CoordinatorResourceKind, key: InternalResourceKey): CoordinatorQueueDiagnostics {
    return {
      resourceKind: kind,
      resourceKey: key,
      queueDepth: 0,
      active: false,
      completedCount: 0,
      rejectedCount: 0
    };
  }

  private onActorIdle(kind: CoordinatorResourceKind, key: InternalResourceKey, actor: ResourceActor): void {
    const actors = kind === "browser" ? this.browserActors : this.tabActors;
    if (actors.get(key) !== actor || !actor.isIdle()) return;
    const browserKey = kind === "browser" ? key as BrowserResourceKey : browserKeyForResource("tab", key);
    // Keep a browser actor discoverable while its parent gate still carries a
    // shared or exclusive lease.  Otherwise a diagnostics lookup could
    // create a replacement actor during an in-flight sibling-tab operation.
    if (kind === "browser") {
      const gate = this.browserGates.get(browserKey);
      if (gate !== undefined && !gate.isIdle()) return;
    }
    this.idleDiagnostics.delete(this.diagnosticsKey(kind, key));
    this.idleDiagnostics.set(this.diagnosticsKey(kind, key), cloneQueueDiagnostics(actor.snapshot()));
    while (this.idleDiagnostics.size > this.options.maxIdleDiagnostics) {
      const oldest = this.idleDiagnostics.keys().next().value;
      if (oldest === undefined) break;
      this.idleDiagnostics.delete(oldest);
    }
    actors.delete(key);
    this.maybeCleanupGate(browserKey);
  }

  private getBrowserGate(kind: CoordinatorResourceKind, resourceKey: InternalResourceKey): BrowserGate {
    const browserKey = browserKeyForResource(kind, resourceKey);
    let gate = this.browserGates.get(browserKey);
    if (gate === undefined) {
      gate = new BrowserGate(
        browserKey,
        this.options.maxQueueSize,
        this.options.maxConsecutiveBrowserExclusives
      );
      this.browserGates.set(browserKey, gate);
    }
    return gate;
  }

  private maybeCleanupGate(browserKey: BrowserResourceKey): void {
    const gate = this.browserGates.get(browserKey);
    if (gate === undefined || !gate.isIdle()) return;
    const browserActor = this.browserActors.get(browserKey);
    if (browserActor !== undefined && !browserActor.isIdle()) return;
    if (browserActor !== undefined) {
      // The browser actor may have completed before the last tab lease.  Its
      // idle callback intentionally deferred eviction so the parent gate
      // remained visible; finish that deterministic handoff now.
      this.onActorIdle("browser", browserKey, browserActor);
      if (this.browserActors.has(browserKey)) return;
    }
    this.browserGates.delete(browserKey);
  }

  private enqueue<T>(
    kind: CoordinatorResourceKind,
    resourceKey: InternalResourceKey,
    requestOptions: CoordinatorRequestOptions,
    callback: Callback<T, CoordinatorAcquisitionContext>
  ): Promise<T> {
    if (typeof callback !== "function") throw new InvalidCoordinatorRequestError("callback is required");
    validateResourceKey(kind, resourceKey);
    const stored = acquisitionContexts.getStore();
    const current = stored !== undefined && activeAcquisitionTokens.has(stored.acquisitionToken) ? stored : undefined;
    const explicit = requestOptions.acquisitionContext;
    if (explicit !== undefined && !activeAcquisitionTokens.has(explicit.acquisitionToken)) {
      return Promise.reject(new InvalidCoordinatorRequestError("acquisitionContext is stale or does not belong to an active coordinator callback"));
    }
    if (current !== undefined && explicit !== undefined && current.acquisitionToken !== explicit.acquisitionToken) {
      return Promise.reject(new InvalidCoordinatorRequestError("acquisitionContext cannot override the active async coordinator context"));
    }
    const parent = current ?? explicit;
    if (parent !== undefined) {
      // Nested acquisition of any coordinator actor can deadlock when another
      // caller acquires the same resources in the opposite order. Callers must
      // finish one short browser transaction before requesting another.
      return Promise.reject(new ReentrantAcquisitionError(parent));
    }
    const owner = validateOwner(requestOptions.owner);
    const priority = validatePriority(requestOptions.priority);
    const now = this.options.now();
    const deadlineAt = makeDeadline(requestOptions, now);
    const browserKey = browserKeyForResource(kind, resourceKey);
    const gate = this.getBrowserGate(kind, resourceKey);
    const admission = kind === "browser"
      ? gate.createExclusiveAdmission()
      : gate.createSharedAdmission();
    const timing: CoordinatorTimingDiagnostics = {
      requestId: randomUUID(),
      resourceKind: kind,
      resourceKey,
      priority,
      owner,
      ...(requestOptions.label === undefined ? {} : { label: requestOptions.label }),
      enqueuedAt: now,
      ...(deadlineAt === undefined ? {} : { deadlineAt })
    };
    const controller = new AbortController();
    const request: Omit<PendingRequest, "sequence" | "started" | "settled" | "callerSettled" | "cancelled" | "resolve" | "reject"> = {
      requestId: timing.requestId,
      priority,
      owner,
      ...(requestOptions.label === undefined ? {} : { label: requestOptions.label }),
      enqueuedAt: now,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      callback,
      timing,
      controller,
      admission
    };
    const actor = this.getActor(kind, resourceKey);
    const result = actor.enqueue<T>(request, requestOptions.signal);
    // Queue-full and already-aborted requests may never call admission's
    // accepted hook.  Remove a gate created solely for that rejected request,
    // while leaving any active/queued parent work untouched.
    this.maybeCleanupGate(browserKey);
    return result;
  }
}

/** Explicit factory to make process/runtime ownership visible at call sites. */
export function createProcessTabCoordinator(options?: TabCoordinatorOptions): ProcessTabCoordinator {
  return new ProcessTabCoordinator(options);
}

let defaultProcessCoordinator: ProcessTabCoordinator | undefined;

/**
 * Return the lifecycle-wide coordinator used by default SDK/runtime services.
 *
 * Constructing a coordinator per client would make each queue internally
 * correct while allowing two clients in the same backend process to overlap
 * on the same tab.  Callers that need deterministic test limits may still
 * inject an explicitly constructed coordinator; production integration should
 * use this shared instance.
 */
export function getProcessTabCoordinator(): ProcessTabCoordinator {
  defaultProcessCoordinator ??= new ProcessTabCoordinator();
  return defaultProcessCoordinator;
}
