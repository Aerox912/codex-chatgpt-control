import type { BrowserLike, ClipboardLike, PageLike, RuntimeEnv } from "../types.js";

/** The mutable fields carried between invocations of a legacy RuntimeEnv. */
export type RuntimeEnvSessionMutableField = "browser" | "page" | "expectedTabId";

const MUTABLE_FIELDS = Object.freeze([
  "browser",
  "page",
  "expectedTabId"
] as const satisfies readonly RuntimeEnvSessionMutableField[]);

const BASE_FIELDS = Object.freeze([
  "agent",
  "clipboard",
  "now"
] as const);

const ALLOWED_OPTION_FIELDS = new Set<string>([...BASE_FIELDS, ...MUTABLE_FIELDS]);

const STATIC_ERROR_MESSAGES = Object.freeze({
  invalid_options: "RuntimeEnvSession options are invalid.",
  invalid_capture: "RuntimeEnvSession capture contains an unsupported value.",
  capture_closed: "RuntimeEnvSession capture is already closed.",
  commit_conflict: "RuntimeEnvSession commit conflicts with a newer invocation.",
  revision_exhausted: "RuntimeEnvSession revision capacity is exhausted."
} as const);

export type RuntimeEnvSessionErrorCode = keyof typeof STATIC_ERROR_MESSAGES;

/**
 * Errors intentionally have a fixed message.  In particular, no browser,
 * page, tab id, caller object, or native error is interpolated into a
 * RuntimeEnvSession diagnostic.
 */
export class RuntimeEnvSessionError extends Error {
  readonly code: RuntimeEnvSessionErrorCode;

  constructor(code: RuntimeEnvSessionErrorCode) {
    super(STATIC_ERROR_MESSAGES[code]);
    this.name = "RuntimeEnvSessionError";
    this.code = code;
  }
}

/** Initial provider/base and mutable snapshot values for a new session. */
export type RuntimeEnvSessionOptions = Readonly<{
  agent?: unknown;
  browser?: BrowserLike;
  page?: PageLike;
  clipboard?: ClipboardLike;
  now?: () => Date;
  expectedTabId?: string;
}>;

type RuntimeEnvBase = {
  agent: unknown;
  clipboard: ClipboardLike | undefined;
  now: (() => Date) | undefined;
};
type RuntimeEnvSnapshot = {
  browser: BrowserLike | undefined;
  page: PageLike | undefined;
  expectedTabId: string | undefined;
};
type RuntimeEnvSessionState = RuntimeEnvSnapshot & { revision: number };

export type RuntimeEnvSessionFieldPresence = "set" | "unset";

export type RuntimeEnvSessionDiagnostics = Readonly<{
  revision: number;
  captures: number;
  openCaptures: number;
  base: Readonly<{
    agent: RuntimeEnvSessionFieldPresence;
    clipboard: RuntimeEnvSessionFieldPresence;
    now: RuntimeEnvSessionFieldPresence;
  }>;
  snapshot: Readonly<{
    browser: RuntimeEnvSessionFieldPresence;
    page: RuntimeEnvSessionFieldPresence;
    expectedTabId: RuntimeEnvSessionFieldPresence;
  }>;
}>;

export type RuntimeEnvSessionCaptureStatus = "open" | "committed" | "abandoned";

export type RuntimeEnvSessionCaptureDiagnostics = Readonly<{
  status: RuntimeEnvSessionCaptureStatus;
  revision: number;
}>;

export type RuntimeEnvSessionCommitResult = Readonly<{
  revision: number;
  /** Fields the invocation changed relative to its captured snapshot. */
  changedFields: readonly RuntimeEnvSessionMutableField[];
  /** Fields that changed the session's durable snapshot in this commit. */
  appliedFields: readonly RuntimeEnvSessionMutableField[];
  /** True when a stale capture was accepted by same-value convergence. */
  converged: boolean;
}>;

/**
 * One invocation's isolated mutable RuntimeEnv and its one-shot lifecycle.
 * The RuntimeEnv itself is deliberately mutable for legacy command
 * compatibility.  Its provider/base fields are non-writable; only the
 * browser/page/tab snapshot fields may be changed before commit.
 */
export type RuntimeEnvSessionCapture = Readonly<{
  env: RuntimeEnv;
  revision: number;
  commit: () => RuntimeEnvSessionCommitResult;
  abandon: () => void;
  diagnostics: () => RuntimeEnvSessionCaptureDiagnostics;
}>;

export type RuntimeEnvSessionRunCallback<T> = (env: RuntimeEnv) => T | PromiseLike<T>;

type RuntimeEnvSessionOptionKey = keyof RuntimeEnvSessionOptions;
type DescriptorMap = Record<string, PropertyDescriptor>;

function invalidOptions(): RuntimeEnvSessionError {
  return new RuntimeEnvSessionError("invalid_options");
}

function invalidCapture(): RuntimeEnvSessionError {
  return new RuntimeEnvSessionError("invalid_capture");
}

function readDataOptions(options: unknown): DescriptorMap {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidOptions();
  }

  let descriptors: PropertyDescriptorMap;
  try {
    // Reading descriptors does not invoke accessor values.  A hostile proxy
    // may still reject reflection; that is converted to the fixed error.
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch {
    throw invalidOptions();
  }

  const result: DescriptorMap = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !ALLOWED_OPTION_FIELDS.has(key)) {
      throw invalidOptions();
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
      throw invalidOptions();
    }
    result[key] = descriptor;
  }
  return result;
}

function readOption<T>(descriptors: DescriptorMap, key: RuntimeEnvSessionOptionKey): T | undefined {
  return descriptors[key]?.value as T | undefined;
}

type ValidatedOptions = RuntimeEnvBase & RuntimeEnvSnapshot;

function validateOptions(options: unknown): ValidatedOptions {
  const descriptors = readDataOptions(options);
  const expectedTabId = readOption<string>(descriptors, "expectedTabId");
  if (expectedTabId !== undefined && typeof expectedTabId !== "string") throw invalidOptions();

  const now = readOption<() => Date>(descriptors, "now");
  if (now !== undefined && typeof now !== "function") throw invalidOptions();

  return {
    agent: readOption<unknown>(descriptors, "agent"),
    browser: readOption<BrowserLike>(descriptors, "browser"),
    page: readOption<PageLike>(descriptors, "page"),
    clipboard: readOption<ClipboardLike>(descriptors, "clipboard"),
    now,
    expectedTabId
  };
}

function presence(value: unknown): RuntimeEnvSessionFieldPresence {
  return value === undefined ? "unset" : "set";
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function freezeFields<T extends readonly unknown[]>(fields: T): T {
  return Object.freeze([...fields]) as T;
}

function createInvocationEnv(base: RuntimeEnvBase, snapshot: RuntimeEnvSnapshot): RuntimeEnv {
  const env: RuntimeEnv = {};

  // Base/provider references are copied once and cannot be overwritten by a
  // legacy command.  Snapshot values are writable and are committed through
  // the owning session's CAS path only.
  for (const key of BASE_FIELDS) {
    Object.defineProperty(env, key, {
      configurable: false,
      enumerable: true,
      value: base[key],
      writable: false
    });
  }
  for (const key of MUTABLE_FIELDS) {
    Object.defineProperty(env, key, {
      configurable: false,
      enumerable: true,
      value: snapshot[key],
      writable: true
    });
  }
  return env;
}

function readInvocationSnapshot(env: RuntimeEnv): RuntimeEnvSnapshot {
  const snapshot = {} as RuntimeEnvSnapshot;
  for (const key of MUTABLE_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(env, key);
    } catch {
      throw invalidCapture();
    }
    // The fields are installed as data properties.  Treat any attempted
    // descriptor/prototype tampering as invalid without invoking a getter.
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
      throw invalidCapture();
    }
    const value = descriptor.value;
    if (key === "expectedTabId" && value !== undefined && typeof value !== "string") {
      throw invalidCapture();
    }
    (snapshot as { [K in RuntimeEnvSessionMutableField]: unknown })[key] = value;
  }
  return snapshot;
}

function freezeCommitResult(
  revision: number,
  changedFields: readonly RuntimeEnvSessionMutableField[],
  appliedFields: readonly RuntimeEnvSessionMutableField[],
  converged: boolean
): RuntimeEnvSessionCommitResult {
  return Object.freeze({
    revision,
    changedFields: freezeFields(changedFields),
    appliedFields: freezeFields(appliedFields),
    converged
  });
}

/**
 * Owns the mutable browser/page/tab snapshot used by invocation-scoped
 * RuntimeEnv captures.  It intentionally performs no browser locking or
 * command dispatch; this is the synchronous in-process snapshot/CAS boundary
 * used by `createChatGPT` to isolate concurrent legacy invocations.
 */
export class RuntimeEnvSession {
  private readonly base: RuntimeEnvBase;
  private state: RuntimeEnvSessionState;
  private captureCount = 0;
  private openCaptureCount = 0;

  constructor(options?: RuntimeEnvSessionOptions) {
    const validated = validateOptions(options);
    this.base = Object.freeze({
      agent: validated.agent,
      clipboard: validated.clipboard,
      now: validated.now
    });
    this.state = {
      browser: validated.browser,
      page: validated.page,
      expectedTabId: validated.expectedTabId,
      revision: 0
    };
  }

  /** Current revision; no browser or page value is exposed. */
  get revision(): number {
    return this.state.revision;
  }

  /** Return frozen, redacted state diagnostics. */
  diagnostics(): RuntimeEnvSessionDiagnostics {
    return Object.freeze({
      revision: this.state.revision,
      captures: this.captureCount,
      openCaptures: this.openCaptureCount,
      base: Object.freeze({
        agent: presence(this.base.agent),
        clipboard: presence(this.base.clipboard),
        now: presence(this.base.now)
      }),
      snapshot: Object.freeze({
        browser: presence(this.state.browser),
        page: presence(this.state.page),
        expectedTabId: presence(this.state.expectedTabId)
      })
    });
  }

  capture(): RuntimeEnvSessionCapture {
    const capturedRevision = this.state.revision;
    const baseline: RuntimeEnvSnapshot = {
      browser: this.state.browser,
      page: this.state.page,
      expectedTabId: this.state.expectedTabId
    };
    const env = createInvocationEnv(this.base, baseline);
    let status: RuntimeEnvSessionCaptureStatus = "open";
    this.captureCount += 1;
    this.openCaptureCount += 1;

    const close = (nextStatus: Exclude<RuntimeEnvSessionCaptureStatus, "open">): void => {
      if (status !== "open") throw new RuntimeEnvSessionError("capture_closed");
      status = nextStatus;
      this.openCaptureCount -= 1;
    };

    const commit = (): RuntimeEnvSessionCommitResult => {
      // A commit attempt is one-shot, including invalid captures and CAS
      // conflicts.  Retrying a mutated stale environment would be ambiguous.
      close("committed");
      const candidate = readInvocationSnapshot(env);
      const changedFields = MUTABLE_FIELDS.filter((key) => !sameValue(candidate[key], baseline[key]));

      // Read-only invocations never clobber a newer snapshot, regardless of
      // how many commits occurred after this capture was made.
      if (changedFields.length === 0) {
        return freezeCommitResult(this.state.revision, changedFields, [], false);
      }

      const stale = capturedRevision !== this.state.revision;
      if (stale) {
        // Merge only fields intentionally changed by this invocation.  A
        // stale commit converges only if each such field already has the same
        // reference/value in the current session state.
        for (const key of changedFields) {
          if (!sameValue(candidate[key], this.state[key])) {
            throw new RuntimeEnvSessionError("commit_conflict");
          }
        }
      }

      const appliedFields = changedFields.filter((key) => !sameValue(candidate[key], this.state[key]));
      if (appliedFields.length === 0) {
        return freezeCommitResult(this.state.revision, changedFields, appliedFields, stale);
      }
      if (this.state.revision >= Number.MAX_SAFE_INTEGER) {
        throw new RuntimeEnvSessionError("revision_exhausted");
      }

      // The state object is replaced once, after every field has passed the
      // CAS checks.  Consumers can therefore never observe a partial tuple.
      const nextState: RuntimeEnvSessionState = {
        browser: this.state.browser,
        page: this.state.page,
        expectedTabId: this.state.expectedTabId,
        revision: this.state.revision + 1
      };
      for (const key of appliedFields) {
        if (key === "browser") nextState.browser = candidate.browser;
        else if (key === "page") nextState.page = candidate.page;
        else nextState.expectedTabId = candidate.expectedTabId;
      }
      this.state = nextState;
      return freezeCommitResult(this.state.revision, changedFields, appliedFields, stale);
    };

    const abandon = (): void => {
      close("abandoned");
    };

    const diagnostics = (): RuntimeEnvSessionCaptureDiagnostics => Object.freeze({
      status,
      revision: capturedRevision
    });

    return Object.freeze({
      env,
      revision: capturedRevision,
      commit,
      abandon,
      diagnostics
    });
  }

  /** Capture, run one invocation, and publish its snapshot only on success. */
  async run<T>(callback: RuntimeEnvSessionRunCallback<T>): Promise<T> {
    if (typeof callback !== "function") throw new RuntimeEnvSessionError("invalid_options");
    const capture = this.capture();
    try {
      const result = await callback(capture.env);
      try {
        capture.commit();
      } catch (error) {
        // The snapshot is only a convenience default for a later invocation;
        // it is not part of the browser command's outcome. A newer invocation
        // may legitimately publish a different tab while this callback is in
        // flight. Never turn an already-completed browser action into a
        // rejected promise (and a tempting caller retry) merely because that
        // stale convenience snapshot could not be published.
        if (!(error instanceof RuntimeEnvSessionError) || error.code !== "commit_conflict") {
          throw error;
        }
      }
      return result;
    } catch (error) {
      // Preserve the callback/commit error exactly.  Abandon is best effort
      // and has a fixed error if the callback already closed the capture.
      try {
        capture.abandon();
      } catch {
        // The original callback or commit error is the useful result.
      }
      throw error;
    }
  }
}

export function createRuntimeEnvSession(options?: RuntimeEnvSessionOptions): RuntimeEnvSession {
  return new RuntimeEnvSession(options);
}
