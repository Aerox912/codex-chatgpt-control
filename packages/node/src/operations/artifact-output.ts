import { constants as fsConstants, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isOwnedProviderChunk, MAX_PROVIDER_CHUNK_BYTES } from "./artifact-stream.js";

const OUTPUT_KEY_PREFIX = "artifact-";
const OUTPUT_KEY_DIGEST_LENGTH = 48;
const TEMP_TOKEN_BYTES = 16;
const MAX_HINT_LENGTH = 32;
const MAX_IDENTITY_BYTES = 4096;
const MAX_OUTPUT_DIRECTORY_BYTES = 4096;
const DEFAULT_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_DEADLINE_AT = Date.UTC(2100, 0, 1);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PROVIDER_READ_TIMEOUT_MS = MAX_TIMEOUT_MS;
const PROVIDER_CLEANUP_TIMEOUT_MS = MAX_TIMEOUT_MS;
// Built-in 64 KiB adapters need at most 8,192 chunks for the 512 MiB artifact
// cap. A generous 8x margin still prevents an unbounded stream of tiny or
// empty chunks from consuming CPU forever while retaining O(1) state.
const MAX_PROVIDER_CHUNKS = 65_536;
// Crash-leftover discovery is an untrusted directory enumeration. Keep the
// hard ceiling independent of the artifact byte/chunk limits so an ordinary
// large destination remains usable without permitting an unbounded preflight.
const MAX_TEMP_SCAN_ENTRIES = 65_536;
const MAX_GRAPH_DEPTH = 16;
const MAX_GRAPH_NODES = 1_024;
const POSIX_FILE_MODE = 0o600;
const EMPTY_SHA256 = createHash("sha256").digest("hex");

/** Fault boundaries are intentionally coarse: they model durable transitions,
 * rather than exposing implementation-specific filesystem calls. */
export type ArtifactOutputFaultPoint =
  | "before_temp_open"
  | "after_temp_open"
  | "before_write"
  | "after_write"
  | "before_file_sync"
  | "after_file_sync"
  | "before_final_link"
  | "after_final_link"
  | "before_temp_cleanup"
  | "after_temp_cleanup"
  | "before_directory_sync"
  | "after_directory_sync";

export type ArtifactOutputEntropy = (byteLength: number) => Uint8Array | Promise<Uint8Array>;

export type ArtifactOutputHooks = {
  entropy?: ArtifactOutputEntropy;
  faultInjector?: (point: ArtifactOutputFaultPoint) => void | Promise<void>;
};

export type ArtifactOutputKeyInput = {
  /** Opaque operation identity. It is hashed and never copied to the key. */
  operationId: string;
  /** Opaque source/artifact identity. It is hashed and never copied to the key. */
  artifactIdentity: string;
  /** Optional public filename extension, with or without a leading dot. */
  extensionHint?: string;
  /** Optional public MIME hint used only for vetted extension selection. */
  mimeTypeHint?: string;
};

export type ArtifactOutputCommitOptions = ArtifactOutputKeyInput & {
  /** Already-authorized destination. It must be absolute, existing, and real. */
  outputDirectory: string;
  source: AsyncIterable<Uint8Array>;
  /** Durable browser/download receipt used to reconcile crash leftovers. */
  expected?: Readonly<{ bytes: number; sha256: string }>;
  maxBytes?: number;
  signal?: AbortSignal;
  hooks?: ArtifactOutputHooks;
  /** Optional absolute deadline for the local effect. */
  deadlineAt?: number;
  /** Optional relative deadline, evaluated by `now` at invocation start. */
  timeoutMs?: number;
  /** Injectable monotonic-ish wall clock used only for bounded checks. */
  now?: () => number;
};

export type ArtifactOutputStatus = "committed" | "reconciled" | "collision" | "blocked";

export type ArtifactOutputReason =
  | "created"
  | "recovered_after_crash"
  | "already_present"
  | "existing_mismatch"
  | "existing_target_not_regular"
  | "destination_invalid"
  | "ambiguous_temp"
  | "byte_limit_exceeded"
  | "source_aborted"
  | "source_invalid"
  | "source_mismatch"
  | "source_read_failed"
  | "write_failed"
  | "file_sync_failed"
  | "commit_indeterminate"
  | "directory_sync_failed"
  | "temp_cleanup_pending"
  | "temp_cleanup_ambiguous"
  | "entropy_failed"
  | "operation_timeout"
  | "clock_invalid";

/**
 * A redacted, receipt-ready output result. The destination path and all
 * source content are deliberately absent. For a blocked stream result,
 * bytes/sha256 describe only the observed prefix (never a claimed final
 * artifact); consumers must only create a durable transfer receipt for
 * committed or reconciled results.
 */
export type ArtifactOutputResult = {
  outputKey: string;
  bytes: number;
  sha256: string;
  status: ArtifactOutputStatus;
  reason: ArtifactOutputReason;
};

export class ArtifactOutputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ArtifactOutputError";
  }
}

type SecureDirectory = {
  requested: string;
  canonical: string;
  device: bigint;
  inode: bigint;
};

type TempOwnership = {
  path: string;
  device: bigint;
  inode: bigint;
  /** Retained capability; path re-resolution is never used for installation. */
  handle: FileHandle;
};

type StreamedArtifact = {
  bytes: number;
  sha256: string;
};

type OutputRuntime = {
  readonly now: () => number;
  readonly signal?: AbortSignal;
  deadlineAt?: number;
  lastNow?: number;
  clockFaulted: boolean;
  localEffectInFlight: boolean;
  localEffectUncertain: boolean;
  localEffectPromise: Promise<unknown> | undefined;
  providerBoundary?: "timeout" | "aborted";
  providerUncertain: boolean;
};

/**
 * Derive one deterministic, path-safe output component from opaque identities.
 * The only human-readable portion is the vetted public extension.
 */
export function deriveOperationOutputKey(input: ArtifactOutputKeyInput): string {
  const captured = snapshotKeyInput(input);
  validateOpaqueIdentity(captured.operationId, "operationId");
  validateOpaqueIdentity(captured.artifactIdentity, "artifactIdentity");
  const extension = normalizeExtension(captured.extensionHint, captured.mimeTypeHint);
  const digest = outputIdentityDigest(captured, extension);
  return `${OUTPUT_KEY_PREFIX}${digest.slice(0, OUTPUT_KEY_DIGEST_LENGTH)}${extension === "" ? "" : `.${extension}`}`;
}

/**
 * Stream one artifact into an operation-owned temporary file, then install it
 * from the retained source descriptor into an exclusive destination file.
 * Existing byte-identical finals are reconciled; any other existing target is
 * never overwritten.
 */
export async function commitOperationOutput(options: ArtifactOutputCommitOptions): Promise<ArtifactOutputResult> {
  const captured = snapshotCommitOptions(options);
  const outputKey = deriveOperationOutputKey(keyInput(captured));
  const empty = { bytes: 0, sha256: EMPTY_SHA256 };
  validateCommitOptions(captured);
  const runtime = createRuntime(captured);
  let boundary: "preflight" | "temp" | "stream" | "link" | "directory" = "preflight";
  try {
    checkRuntime(runtime);
  } catch (error) {
    return result(outputKey, empty, "blocked", runtimeReason(error));
  }

  let directory: SecureDirectory;
  try {
    directory = await secureOutputDirectory(captured.outputDirectory, runtime);
  } catch (error) {
    return result(outputKey, empty, "blocked", runtimeReason(error, "destination_invalid"));
  }

  const finalPath = safeChildPath(directory.canonical, outputKey);
  const tempPrefix = `.${outputKey}.partial-`;
  let preflight: ArtifactOutputResult | undefined;
  try {
    preflight = await reconcilePreexistingOutput(directory, finalPath, tempPrefix, outputKey, captured.expected, captured.hooks, runtime);
  } catch (error) {
    return result(outputKey, empty, "blocked", runtimeReason(error, "destination_invalid"));
  }
  if (preflight !== undefined) {
    return preflight;
  }

  let temp: TempOwnership | undefined;
  let stream: StreamedArtifact = empty;
  let finalInstalled = false;
  try {
    boundary = "temp";
    temp = await createOwnedTemp(directory, tempPrefix, captured.hooks, runtime);
    try {
      await inject(captured.hooks, "after_temp_open", runtime);
    } catch (error) {
      rethrowRuntimeFailure(error);
      throw new ArtifactOutputError("temp_open_failed", "Operation-owned temporary output could not be created.");
    }
    boundary = "stream";
    stream = await writeSource(temp, captured, runtime);
    if (captured.expected !== undefined
      && (stream.bytes !== captured.expected.bytes || stream.sha256 !== captured.expected.sha256)) {
      throw new StreamOutcome("blocked", "source_mismatch", stream.bytes, stream.sha256);
    }
    boundary = "link";
    finalInstalled = await installOrReconcile(directory, finalPath, temp, stream, captured.hooks, runtime);
    if (finalInstalled) {
      const cleanup = await cleanupOwnedTemp(directory, temp, captured.hooks, runtime);
      if (runtime.localEffectUncertain) {
        return result(outputKey, stream, "blocked", "commit_indeterminate");
      }
      boundary = "directory";
      try {
        await syncDirectory(directory, captured.hooks, runtime);
      } catch {
        return result(outputKey, stream, "blocked", "commit_indeterminate");
      }
      if (cleanup === "ambiguous") {
        return result(outputKey, stream, "blocked", "temp_cleanup_ambiguous");
      }
      if (cleanup === "pending") {
        // The final hard link is durable, but cleanup requires a later
        // receipt-bound reconciliation before this destination is reused.
        return result(outputKey, stream, "committed", "temp_cleanup_pending");
      }
      return result(outputKey, stream, "committed", "created");
    }

    // installOrReconcile returns false only when an existing target was
    // reconciled or rejected; it communicates the exact result through the
    // private marker below.
    throw new ArtifactOutputError("internal_install_result", "Unexpected artifact install result.");
  } catch (error) {
    if (isInstallOutcome(error)) {
      if (isStreamOutcome(error)) {
        stream = { bytes: error.bytes, sha256: error.sha256 };
      }
      if (runtime.localEffectUncertain) {
        return result(outputKey, stream, "blocked", "commit_indeterminate");
      }
      if (temp !== undefined) {
        const cleanup = await cleanupOwnedTemp(
          directory,
          temp,
          captured.hooks,
          runtime,
          isStreamOutcome(error) && error.retainForRecovery
        );
        try {
          await syncDirectory(directory, captured.hooks, runtime);
        } catch {
          return result(outputKey, stream, "blocked", "commit_indeterminate");
        }
        if (cleanup === "ambiguous") return result(outputKey, stream, "blocked", "temp_cleanup_ambiguous");
        // Preserve the primary install outcome. The temp remains as crash
        // evidence, but replacing a useful source/collision reason with a
        // cleanup detail would make the durable blocker less actionable.
        if (cleanup === "pending") {
          return result(outputKey, stream, error.status, runtime.providerUncertain ? "commit_indeterminate" : error.reason);
        }
      }
      if (runtime.providerUncertain) return result(outputKey, stream, "blocked", "commit_indeterminate");
      return result(outputKey, stream, error.status, error.reason);
    }

    const classified = classifyFailure(error);
    if (runtime.localEffectUncertain) {
      return result(outputKey, stream, "blocked", "commit_indeterminate");
    }
    if (temp !== undefined) {
      const cleanup = await cleanupOwnedTemp(directory, temp, captured.hooks, runtime);
      if (cleanup === "ambiguous") {
        return result(outputKey, stream, "blocked", "temp_cleanup_ambiguous");
      }
      if (cleanup === "pending") {
        return result(outputKey, stream, "blocked", runtime.providerUncertain ? "commit_indeterminate" : classified);
      }
      try {
        await syncDirectory(directory, captured.hooks, runtime);
      } catch {
        return result(outputKey, stream, "blocked", "commit_indeterminate");
      }
    }
    if (runtime.providerUncertain) return result(outputKey, stream, "blocked", "commit_indeterminate");
    if (boundary === "link" || boundary === "directory" || finalInstalled) {
      return result(outputKey, stream, "blocked", classified === "operation_timeout" || classified === "clock_invalid"
        ? "commit_indeterminate"
        : classified);
    }
    return result(outputKey, stream, "blocked", classified);
  } finally {
    // Installation and cleanup may return a durable blocker while the source
    // capability still exists. Release the retained descriptor on every path;
    // the pathname is intentionally not used as a fallback close mechanism.
    if (temp !== undefined) await closeTempHandle(temp);
  }
}

class InstallOutcome extends Error {
  constructor(
    readonly status: ArtifactOutputStatus,
    readonly reason: ArtifactOutputReason
  ) {
    super(reason);
    this.name = "InstallOutcome";
  }
}

class StreamOutcome extends InstallOutcome {
  constructor(
    status: ArtifactOutputStatus,
    reason: ArtifactOutputReason,
    readonly bytes: number,
    readonly sha256: string,
    /** The retained temp contains a verified complete prefix suitable for
     * receipt-bound recovery, even though the surrounding effect failed. */
    readonly retainForRecovery = false
  ) {
    super(status, reason);
    this.name = "StreamOutcome";
  }
}

function result(
  outputKey: string,
  stream: StreamedArtifact,
  status: ArtifactOutputStatus,
  reason: ArtifactOutputReason
): ArtifactOutputResult {
  return { outputKey, bytes: stream.bytes, sha256: stream.sha256, status, reason };
}

function keyInput(value: ArtifactOutputCommitOptions): ArtifactOutputKeyInput {
  return {
    operationId: value.operationId,
    artifactIdentity: value.artifactIdentity,
    ...(value.extensionHint === undefined ? {} : { extensionHint: value.extensionHint }),
    ...(value.mimeTypeHint === undefined ? {} : { mimeTypeHint: value.mimeTypeHint })
  };
}

function snapshotKeyInput(value: ArtifactOutputKeyInput): ArtifactOutputKeyInput {
  const record = ownDataRecord(value, "key input", ["operationId", "artifactIdentity", "extensionHint", "mimeTypeHint"]);
  const operationId = readData(record, "operationId");
  const artifactIdentity = readData(record, "artifactIdentity");
  const extensionHint = readData(record, "extensionHint");
  const mimeTypeHint = readData(record, "mimeTypeHint");
  if (typeof operationId !== "string" || typeof artifactIdentity !== "string"
    || (extensionHint !== undefined && typeof extensionHint !== "string")
    || (mimeTypeHint !== undefined && typeof mimeTypeHint !== "string")) {
    throw new ArtifactOutputError("invalid_output_key_input", "Artifact output identity input is invalid.");
  }
  return Object.freeze({
    operationId,
    artifactIdentity,
    ...(extensionHint === undefined ? {} : { extensionHint }),
    ...(mimeTypeHint === undefined ? {} : { mimeTypeHint })
  });
}

function snapshotCommitOptions(value: ArtifactOutputCommitOptions): ArtifactOutputCommitOptions {
  const record = ownDataRecord(value, "commit options", [
    "operationId", "artifactIdentity", "extensionHint", "mimeTypeHint", "outputDirectory", "source",
    "expected", "maxBytes", "signal", "hooks", "deadlineAt", "timeoutMs", "now"
  ]);
  const operationId = readData(record, "operationId");
  const artifactIdentity = readData(record, "artifactIdentity");
  const extensionHint = readData(record, "extensionHint");
  const mimeTypeHint = readData(record, "mimeTypeHint");
  const outputDirectory = readData(record, "outputDirectory");
  const source = readData(record, "source");
  const expected = snapshotExpected(readData(record, "expected"));
  const maxBytes = readData(record, "maxBytes");
  const signal = readData(record, "signal");
  const hooks = snapshotHooks(readData(record, "hooks"));
  const deadlineAt = readData(record, "deadlineAt");
  const timeoutMs = readData(record, "timeoutMs");
  const now = readData(record, "now");
  if (typeof operationId !== "string" || typeof artifactIdentity !== "string"
    || (extensionHint !== undefined && typeof extensionHint !== "string")
    || (mimeTypeHint !== undefined && typeof mimeTypeHint !== "string")
    || typeof outputDirectory !== "string"
    || !isAsyncIterable(source)
    || (maxBytes !== undefined && typeof maxBytes !== "number")
    || (signal !== undefined && !isGenuineAbortSignal(signal))
    || (deadlineAt !== undefined && typeof deadlineAt !== "number")
    || (timeoutMs !== undefined && typeof timeoutMs !== "number")
    || (now !== undefined && typeof now !== "function")) {
    throw new ArtifactOutputError("invalid_commit_options", "Artifact output commit options are invalid.");
  }
  if (byteLength(operationId) > MAX_IDENTITY_BYTES || byteLength(artifactIdentity) > MAX_IDENTITY_BYTES
    || byteLength(outputDirectory) > MAX_OUTPUT_DIRECTORY_BYTES
    || (extensionHint !== undefined && byteLength(extensionHint) > MAX_HINT_LENGTH * 4)
    || (mimeTypeHint !== undefined && byteLength(mimeTypeHint) > 127 * 4)) {
    throw new ArtifactOutputError("invalid_commit_options", "Artifact output commit options exceed their bounded limits.");
  }
  const captured: ArtifactOutputCommitOptions = {
    operationId,
    artifactIdentity,
    ...(extensionHint === undefined ? {} : { extensionHint }),
    ...(mimeTypeHint === undefined ? {} : { mimeTypeHint }),
    outputDirectory,
    source: source as AsyncIterable<Uint8Array>,
    ...(expected === undefined ? {} : { expected }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(signal === undefined ? {} : { signal }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(now === undefined ? {} : { now: now as () => number })
  };
  return Object.freeze(captured);
}

function snapshotExpected(value: unknown): Readonly<{ bytes: number; sha256: string }> | undefined {
  if (value === undefined) return undefined;
  const record = ownDataRecord(value, "expected artifact", ["bytes", "sha256"]);
  const bytes = readData(record, "bytes");
  const sha256 = readData(record, "sha256");
  if (typeof bytes !== "number" || typeof sha256 !== "string") throw new ArtifactOutputError("invalid_expected_artifact", "Expected artifact receipt is invalid.");
  return Object.freeze({ bytes, sha256 });
}

function snapshotHooks(value: unknown): ArtifactOutputHooks | undefined {
  if (value === undefined) return undefined;
  const record = ownDataRecord(value, "output hooks", ["entropy", "faultInjector"]);
  const entropy = readData(record, "entropy");
  const faultInjector = readData(record, "faultInjector");
  if (entropy !== undefined && typeof entropy !== "function") throw new ArtifactOutputError("invalid_output_hooks", "Artifact output hooks are invalid.");
  if (faultInjector !== undefined && typeof faultInjector !== "function") throw new ArtifactOutputError("invalid_output_hooks", "Artifact output hooks are invalid.");
  const hooks: ArtifactOutputHooks = {};
  if (entropy !== undefined) hooks.entropy = entropy as ArtifactOutputEntropy;
  if (faultInjector !== undefined) hooks.faultInjector = faultInjector as NonNullable<ArtifactOutputHooks["faultInjector"]>;
  return Object.freeze(hooks);
}

function ownDataRecord(value: unknown, label: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ArtifactOutputError("invalid_output_options", `${label} is invalid.`);
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowedKeys.includes(key)) throw new ArtifactOutputError("invalid_output_options", `${label} contains unsupported fields.`);
    }
  } catch (error) {
    if (isArtifactOutputError(error)) throw error;
    throw new ArtifactOutputError("invalid_output_options", `${label} is invalid.`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.includes(key) || !("value" in descriptor)) throw new ArtifactOutputError("invalid_output_options", `${label} contains accessor-backed fields.`);
  }
  assertGraphBounds(value);
  return value as Record<string, unknown>;
}

function readData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function assertGraphBounds(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (value === null || typeof value !== "object" || typeof value === "function") return;
  if (seen.has(value)) return;
  if (depth > MAX_GRAPH_DEPTH) {
    throw new ArtifactOutputError("invalid_output_options", "Artifact output options exceed their graph bound.");
  }
  seen.add(value);
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw new ArtifactOutputError("invalid_output_options", "Artifact output options are invalid."); }
  if (seen.size > MAX_GRAPH_NODES) throw new ArtifactOutputError("invalid_output_options", "Artifact output options exceed their graph bound.");
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) throw new ArtifactOutputError("invalid_output_options", "Artifact output options contain accessor-backed data.");
    assertGraphBounds(descriptor.value, seen, depth + 1);
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const method = findDataMethod(value, Symbol.asyncIterator);
  return typeof method === "function";
}

function safeAsyncIterator(value: AsyncIterable<Uint8Array>): AsyncIterator<Uint8Array> {
  const method = findDataMethod(value, Symbol.asyncIterator);
  if (typeof method !== "function") throw new ArtifactOutputError("invalid_artifact_source", "Artifact source is invalid.");
  const iterator = Reflect.apply(method, value, []);
  if (iterator === null || (typeof iterator !== "object" && typeof iterator !== "function")) throw new ArtifactOutputError("invalid_artifact_source", "Artifact source is invalid.");
  const next = findDataMethod(iterator, "next");
  if (typeof next !== "function") throw new ArtifactOutputError("invalid_artifact_source", "Artifact source is invalid.");
  const safe: AsyncIterator<Uint8Array> = {
    next: (...args: [] | [unknown]) => Reflect.apply(next, iterator, args)
  };
  const close = findDataMethod(iterator, "return");
  if (typeof close === "function") {
    safe.return = (...args: [] | [unknown]) => Reflect.apply(close, iterator, args);
  }
  return safe;
}

function findDataMethod(value: object, key: string | symbol): unknown {
  let current: object | null = value;
  while (current !== null) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(current, key); } catch { return undefined; }
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
    try { current = Object.getPrototypeOf(current); } catch { return undefined; }
  }
  return undefined;
}

function createRuntime(options: ArtifactOutputCommitOptions): OutputRuntime {
  const now = options.now ?? Date.now;
  let initial: number;
  try {
    initial = readClock(now);
  } catch {
    const runtime: OutputRuntime = {
      now,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      clockFaulted: true,
      localEffectInFlight: false,
      localEffectUncertain: false,
      providerUncertain: false,
      localEffectPromise: undefined
    };
    if (options.deadlineAt !== undefined) runtime.deadlineAt = options.deadlineAt;
    return runtime;
  }

  let deadlineAt = options.deadlineAt;
  if (options.timeoutMs !== undefined) {
    const relative = initial + options.timeoutMs;
    if (!Number.isFinite(relative) || relative > MAX_DEADLINE_AT) {
      const runtime: OutputRuntime = {
        now,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        lastNow: initial,
        clockFaulted: true,
        localEffectInFlight: false,
        localEffectUncertain: false,
        providerUncertain: false,
        localEffectPromise: undefined
      };
      if (deadlineAt !== undefined) runtime.deadlineAt = deadlineAt;
      return runtime;
    }
    deadlineAt = deadlineAt === undefined ? relative : Math.min(deadlineAt, relative);
  }
  const runtime: OutputRuntime = {
    now,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    lastNow: initial,
    clockFaulted: false,
    localEffectInFlight: false,
    localEffectUncertain: false,
    providerUncertain: false,
    localEffectPromise: undefined
  };
  if (deadlineAt !== undefined) runtime.deadlineAt = deadlineAt;
  return runtime;
}

function checkRuntime(runtime: OutputRuntime): void {
  if (runtime.clockFaulted) {
    throw new ArtifactOutputError("clock_invalid", "The operation clock is invalid.");
  }
  let current: number;
  try {
    current = readClock(runtime.now);
  } catch {
    runtime.clockFaulted = true;
    throw new ArtifactOutputError("clock_invalid", "The operation clock is invalid.");
  }
  if (runtime.lastNow !== undefined && current < runtime.lastNow) {
    runtime.clockFaulted = true;
    throw new ArtifactOutputError("clock_invalid", "The operation clock moved backwards.");
  }
  runtime.lastNow = current;
  if (runtime.deadlineAt !== undefined && current >= runtime.deadlineAt) {
    throw new ArtifactOutputError("operation_timeout", "The operation deadline expired.");
  }
}

function readClock(now: () => number): number {
  const value = Reflect.apply(now, undefined, []);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DEADLINE_AT) {
    throw new Error("invalid clock");
  }
  return value;
}

async function bounded<T>(runtime: OutputRuntime, operation: () => T | PromiseLike<T>): Promise<T> {
  checkRuntime(runtime);
  try {
    // Provider callbacks may mutate state after they resolve or reject.  Keep
    // effect authority until the callback has actually settled, then classify
    // a crossed deadline rather than returning while it remains in flight.
    const value = await Promise.resolve().then(operation);
    checkRuntime(runtime);
    return value;
  } catch (error) {
    try {
      checkRuntime(runtime);
    } catch (runtimeError) {
      throw runtimeError;
    }
    throw error;
  }
}

type ProviderBoundary = "timeout" | "aborted";

type ProviderBoundaryWait = Readonly<{
  promise: Promise<ProviderBoundary>;
  cancel: () => void;
}>;

type ProviderSettlement<T> =
  | Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "error"; error: unknown }>;

/**
 * Install a real wake-up for provider boundaries.  `now` remains the
 * authoritative validation clock, while the timer ensures a provider that
 * never settles cannot keep a request pending beyond an explicit deadline.
 * Long absolute deadlines are scheduled in Node's bounded timer-sized
 * pieces; a single oversized delay would otherwise wrap and fire early.
 */
function armProviderBoundary(runtime: OutputRuntime, fallbackTimeoutMs?: number): ProviderBoundaryWait | undefined {
  const signal = runtime.signal;
  let remaining: number | undefined;
  if (runtime.deadlineAt !== undefined) {
    const baseline = runtime.lastNow ?? readClock(runtime.now);
    remaining = runtime.deadlineAt - baseline;
  } else if (fallbackTimeoutMs !== undefined) {
    remaining = fallbackTimeoutMs;
  }
  if (signal === undefined && remaining === undefined) return undefined;

  let resolveBoundary!: (boundary: ProviderBoundary) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const promise = new Promise<ProviderBoundary>(resolve => {
    resolveBoundary = resolve;
  });
  const listener = () => trigger("aborted");
  const removeListener = () => {
    if (signal === undefined) return;
    try { signal.removeEventListener("abort", listener); } catch { /* fail closed below */ }
  };
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  function trigger(boundary: ProviderBoundary): void {
    if (cancelled) return;
    cancelled = true;
    clearTimer();
    removeListener();
    runtime.providerBoundary = boundary;
    runtime.providerUncertain = true;
    resolveBoundary(boundary);
  }
  const schedule = (delay: number): void => {
    if (cancelled) return;
    const boundedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      if (delay > MAX_TIMER_DELAY_MS) {
        schedule(delay - MAX_TIMER_DELAY_MS);
      } else {
        trigger("timeout");
      }
    }, boundedDelay);
  };

  if (signal !== undefined) {
    if (isSignalAborted(signal)) {
      trigger("aborted");
      return { promise, cancel: () => undefined };
    }
    try {
      signal.addEventListener("abort", listener, { once: true });
    } catch {
      trigger("aborted");
      return { promise, cancel: () => undefined };
    }
    // Close the race where abort happens between the state check and listener
    // registration.  A genuine signal is the only source of this value.
    if (isSignalAborted(signal)) trigger("aborted");
  }
  if (!cancelled && remaining !== undefined) {
    if (!Number.isFinite(remaining) || remaining <= 0) trigger("timeout");
    else schedule(remaining);
  }
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clearTimer();
      removeListener();
    }
  };
}

async function awaitProviderPromise<T>(
  runtime: OutputRuntime,
  operationPromise: PromiseLike<T>,
  fallbackTimeoutMs?: number
): Promise<T> {
  const boundary = armProviderBoundary(runtime, fallbackTimeoutMs);
  const settled: Promise<ProviderSettlement<T>> = Promise.resolve(operationPromise).then(
    value => ({ kind: "value" as const, value }),
    error => ({ kind: "error" as const, error })
  );
  let outcome: ProviderSettlement<T> | ProviderBoundary;
  try {
    outcome = boundary === undefined
      ? await settled
      : await Promise.race([settled, boundary.promise]);
  } finally {
    boundary?.cancel();
  }
  if (outcome === "timeout" || outcome === "aborted") {
    throw new ArtifactOutputError(
      outcome === "timeout" ? "operation_timeout" : "source_aborted",
      outcome === "timeout" ? "The artifact source exceeded its operation deadline." : "The artifact source was aborted."
    );
  }
  if (outcome.kind === "error") throw outcome.error;
  checkRuntime(runtime);
  return outcome.value;
}

async function providerEffect<T>(
  runtime: OutputRuntime,
  operation: () => T | PromiseLike<T>,
  fallbackTimeoutMs?: number
): Promise<T> {
  checkRuntime(runtime);
  return await awaitProviderPromise(runtime, Promise.resolve().then(operation), fallbackTimeoutMs);
}

/**
 * Await a filesystem effect to settlement.  A deadline crossing is observed
 * only after the syscall settles, and the caller quarantines the residue
 * before returning an indeterminate result.
 */
async function localEffect<T>(runtime: OutputRuntime, operation: () => T | PromiseLike<T>): Promise<T> {
  checkRuntime(runtime);
  const operationPromise = Promise.resolve().then(operation);
  runtime.localEffectInFlight = true;
  runtime.localEffectPromise = operationPromise;
  try {
    const value = await operationPromise;
    try {
      checkRuntime(runtime);
    } catch (error) {
      if (isRuntimeFailure(error)) runtime.localEffectUncertain = true;
      throw error;
    }
    return value;
  } catch (error) {
    if (isRuntimeFailure(error)) {
      runtime.localEffectUncertain = true;
    } else {
      try {
        checkRuntime(runtime);
      } catch (runtimeError) {
        if (isRuntimeFailure(runtimeError)) runtime.localEffectUncertain = true;
        throw runtimeError;
      }
    }
    throw error;
  } finally {
    runtime.localEffectInFlight = false;
    if (runtime.localEffectPromise === operationPromise) runtime.localEffectPromise = undefined;
  }
}

function isRuntimeFailure(error: unknown): boolean {
  return isRuntimeArtifactError(error);
}

async function nextWithDeadline(iterator: AsyncIterator<Uint8Array>, runtime: OutputRuntime): Promise<IteratorResult<Uint8Array>> {
  // A source read is an external/provider effect.  Unlike local fsync/write
  // calls, it must be interruptible at the configured boundary; a never
  // settling `next()` is quarantined and cannot retain the transaction.
  const raw = await providerEffect(runtime, () => iterator.next(), PROVIDER_READ_TIMEOUT_MS);
  if (raw === null || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new ArtifactOutputError("invalid_artifact_source", "Artifact source iterator result is invalid.");
  }
  const done = readDataProperty(raw, "done");
  if (!done.found || typeof done.value !== "boolean") {
    throw new ArtifactOutputError("invalid_artifact_source", "Artifact source iterator result is invalid.");
  }
  if (done.value) return { done: true, value: undefined };
  const value = readDataProperty(raw, "value");
  return { done: false, value: value.found ? value.value as Uint8Array : undefined as never };
}

async function closeAsyncIterator(iterator: AsyncIterator<Uint8Array>, runtime: OutputRuntime): Promise<void> {
  const close = iterator.return;
  if (typeof close !== "function") return;
  const operation = Promise.resolve().then(() => close.call(iterator));
  // If a preceding provider boundary already fired, issue best-effort close
  // but do not await a provider that is now quarantined.  The settlement
  // observer prevents a late rejection from becoming an unhandled promise.
  void operation.then(() => undefined, () => undefined);
  if (runtime.providerBoundary !== undefined || runtime.clockFaulted) return;
  // A settled provider read can advance the injected clock beyond its
  // deadline before this finally block runs. Give an already-queued close one
  // microtask to settle, but never wait on a new provider effect after the
  // deadline. This preserves the precise `operation_timeout` result for a
  // source that did settle, while a genuinely pending close remains
  // quarantined.
  if (runtime.deadlineAt !== undefined && runtime.lastNow !== undefined && runtime.lastNow >= runtime.deadlineAt) {
    let tick: ReturnType<typeof setTimeout> | undefined;
    const closeSettled = operation.then(() => true, () => true);
    const grace = new Promise<boolean>(resolve => {
      tick = setTimeout(() => resolve(false), 0);
    });
    const settled = await Promise.race([closeSettled, grace]);
    if (tick !== undefined) clearTimeout(tick);
    if (!settled) runtime.providerUncertain = true;
    return;
  }
  try {
    // Cleanup has a bounded grace period even when the caller did not provide
    // a deadline.  When a request deadline exists, armProviderBoundary uses
    // that earlier boundary instead of extending the operation.
    await awaitProviderPromise(runtime, operation, PROVIDER_CLEANUP_TIMEOUT_MS);
  } catch {
    // The primary source/output outcome remains authoritative. A timeout or
    // cleanup failure is quarantined and never triggers a source retry.
    runtime.providerUncertain = true;
  }
}

function readDataProperty(value: object, key: string | symbol): { found: boolean; value?: unknown } {
  let current: object | null = value;
  while (current !== null) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(current, key); } catch {
      throw new ArtifactOutputError("invalid_artifact_source", "Artifact source iterator result is invalid.");
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) throw new ArtifactOutputError("invalid_artifact_source", "Artifact source iterator result is invalid.");
      return { found: true, value: descriptor.value };
    }
    try { current = Object.getPrototypeOf(current); } catch {
      throw new ArtifactOutputError("invalid_artifact_source", "Artifact source iterator result is invalid.");
    }
  }
  return { found: false };
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted === true;
  } catch {
    // A genuine signal whose implementation is no longer readable is not a
    // safe write authority; fail closed as an aborted stream.
    return true;
  }
}

function isGenuineAbortSignal(value: unknown): value is AbortSignal {
  try {
    return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
  } catch {
    return false;
  }
}

function isValidDeadline(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DEADLINE_AT;
}

function isValidTimeout(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TIMEOUT_MS;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateCommitOptions(options: ArtifactOutputCommitOptions): void {
  validateOpaqueIdentity(options.operationId, "operationId");
  validateOpaqueIdentity(options.artifactIdentity, "artifactIdentity");
  normalizeExtension(options.extensionHint, options.mimeTypeHint);
  if (!isAbsolute(options.outputDirectory)) {
    throw new ArtifactOutputError("output_directory_not_absolute", "Output directory must be absolute.");
  }
  if (byteLength(options.outputDirectory) > MAX_OUTPUT_DIRECTORY_BYTES || options.outputDirectory.includes("\u0000")) {
    throw new ArtifactOutputError("invalid_output_directory", "Output directory is invalid.");
  }
  if (!isAsyncIterable(options.source)) {
    throw new ArtifactOutputError("invalid_artifact_source", "Artifact source must be an async iterable of byte chunks.");
  }
  validateMaxBytes(options.maxBytes);
  if (options.expected !== undefined) {
    if (!Number.isSafeInteger(options.expected.bytes) || options.expected.bytes < 0
      || !/^[0-9a-f]{64}$/.test(options.expected.sha256)
      || options.expected.bytes > (options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES)) {
      throw new ArtifactOutputError("invalid_expected_artifact", "Expected artifact receipt must contain a bounded byte count and lowercase SHA-256.");
    }
  }
  if (options.signal !== undefined && !isGenuineAbortSignal(options.signal)) {
    throw new ArtifactOutputError("invalid_abort_signal", "Abort signal is invalid.");
  }
  if (options.deadlineAt !== undefined && !isValidDeadline(options.deadlineAt)) {
    throw new ArtifactOutputError("invalid_deadline", "deadlineAt must be a bounded timestamp.");
  }
  if (options.timeoutMs !== undefined && !isValidTimeout(options.timeoutMs)) {
    throw new ArtifactOutputError("invalid_deadline", "timeoutMs must be a bounded duration.");
  }
}

function validateMaxBytes(value: number | undefined): void {
  const max = value ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(max) || max < 0 || max > MAX_MAX_ARTIFACT_BYTES) {
    throw new ArtifactOutputError("invalid_artifact_byte_limit", "maxBytes must be a bounded non-negative safe integer.");
  }
}

async function secureOutputDirectory(requested: string, runtime: OutputRuntime): Promise<SecureDirectory> {
  checkRuntime(runtime);
  let metadata: BigIntStats;
  try {
    metadata = await lstat(requested, { bigint: true });
  } catch {
    throw new ArtifactOutputError("destination_invalid", "Output directory is unavailable.");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ArtifactOutputError("destination_invalid", "Output directory must be a real directory.");
  }
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new ArtifactOutputError("destination_invalid", "Output directory could not be resolved.");
  }
  const canonicalMetadata = await lstat(canonical, { bigint: true });
  if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isDirectory()) {
    throw new ArtifactOutputError("destination_invalid", "Output directory must resolve to a real directory.");
  }
  checkRuntime(runtime);
  return { requested, canonical, device: canonicalMetadata.dev, inode: canonicalMetadata.ino };
}

async function assertDirectoryStable(directory: SecureDirectory, runtime: OutputRuntime): Promise<void> {
  checkRuntime(runtime);
  let metadata: BigIntStats;
  try {
    metadata = await lstat(directory.canonical, { bigint: true });
  } catch {
    throw new ArtifactOutputError("destination_invalid", "Output directory is unavailable.");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== directory.device || metadata.ino !== directory.inode) {
    throw new ArtifactOutputError("destination_invalid", "Output directory changed during the local effect.");
  }
  checkRuntime(runtime);
}

function safeChildPath(directory: string, outputKey: string): string {
  const candidate = resolve(directory, outputKey);
  const remainder = relative(directory, candidate);
  if (remainder.length === 0 || remainder.startsWith(`..${sep}`) || remainder === ".." || isAbsolute(remainder) || remainder.includes(sep)) {
    throw new ArtifactOutputError("unsafe_output_key", "Output key must resolve to one child beneath the destination.");
  }
  return candidate;
}

async function matchingTemps(directory: SecureDirectory, prefix: string, runtime: OutputRuntime): Promise<string[] | undefined> {
  try {
    checkScanRuntime(runtime);
    await assertDirectoryStable(directory, runtime);
  } catch (error) {
    rethrowRuntimeFailure(error);
    return undefined;
  }
  let handle;
  try {
    handle = await opendir(directory.canonical);
  } catch (error) {
    rethrowRuntimeFailure(error);
    return undefined;
  }
  const matches: string[] = [];
  let scannedEntries = 0;
  try {
    checkScanRuntime(runtime);
    for await (const entry of handle) {
      checkScanRuntime(runtime);
      scannedEntries += 1;
      if (scannedEntries > MAX_TEMP_SCAN_ENTRIES) {
        // An overfull destination is ambiguous: do not inspect a target or
        // consume the source after the bounded prefix. The finally block
        // closes the directory capability before this safe blocker returns.
        return undefined;
      }
      if (!entry.name.startsWith(prefix)) continue;
      matches.push(safeChildPath(directory.canonical, entry.name));
      if (matches.length > 1) break;
    }
  } catch (error) {
    rethrowRuntimeFailure(error);
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    checkScanRuntime(runtime);
    await assertDirectoryStable(directory, runtime);
  } catch (error) {
    // A clock failure or deadline is not an ambiguous directory listing.
    // Preserve it for the caller's redacted bounded outcome.
    // (Other directory races remain the ambiguity blocker.)
    rethrowRuntimeFailure(error);
    return undefined;
  }
  return matches;
}

function checkScanRuntime(runtime: OutputRuntime): void {
  checkRuntime(runtime);
  if (isSignalAborted(runtime.signal)) {
    throw new ArtifactOutputError("source_aborted", "The artifact source was aborted.");
  }
}

async function reconcilePreexistingOutput(
  directory: SecureDirectory,
  finalPath: string,
  tempPrefix: string,
  outputKey: string,
  expected: Readonly<{ bytes: number; sha256: string }> | undefined,
  hooks: ArtifactOutputHooks | undefined,
  runtime: OutputRuntime
): Promise<ArtifactOutputResult | undefined> {
  const temps = await matchingTemps(directory, tempPrefix, runtime);
  const empty = { bytes: 0, sha256: EMPTY_SHA256 };
  if (temps === undefined || temps.length > 1) {
    return result(outputKey, expected ?? empty, "blocked", "ambiguous_temp");
  }

  const tempPath = temps[0];
  if (tempPath === undefined) {
    if (expected === undefined) return undefined;
    await assertDirectoryStable(directory, runtime);
    const existing = await inspectExistingFinal(finalPath, expected, runtime);
    if (existing === "same") return result(outputKey, expected, "reconciled", "already_present");
    if (existing === "different") return result(outputKey, expected, "collision", "existing_mismatch");
    if (existing === "not_regular") return result(outputKey, expected, "blocked", "existing_target_not_regular");
    return undefined;
  }

  // A crash-leftover filename is not enough to prove content ownership.  It
  // can only be reused when a durable upstream receipt supplies exact bytes
  // and SHA-256 and the open-file snapshot remains stable while hashing.
  if (expected === undefined) {
    // A failed effect may retain a receipt-bound temp because no final was
    // proven. If a regular final already exists, leave that evidence untouched
    // and continue to normal exclusive collision reconciliation after consuming
    // the new source. An orphan temp with no final remains ambiguous and must
    // block rather than being guessed at.
    const existing = await inspectExistingFinalKind(finalPath, runtime);
    if (existing === "regular") return undefined;
    if (existing === "not_regular") return result(outputKey, empty, "blocked", "existing_target_not_regular");
    return result(outputKey, empty, "blocked", "ambiguous_temp");
  }
  let metadata: BigIntStats;
  try {
    await assertDirectoryStable(directory, runtime);
    metadata = await lstat(tempPath, { bigint: true });
  } catch (error) {
    rethrowRuntimeFailure(error);
    return result(outputKey, expected, "blocked", "ambiguous_temp");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) return result(outputKey, expected, "blocked", "ambiguous_temp");
  let temp: TempOwnership | undefined;
  try {
    const handle = await open(tempPath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(metadata, opened) || !opened.isFile()) {
      await handle.close().catch(() => undefined);
      return result(outputKey, expected, "blocked", "ambiguous_temp");
    }
    temp = { path: tempPath, device: opened.dev, inode: opened.ino, handle };
    if (!(await retainedTempMatches(temp, expected, runtime))) {
      return result(outputKey, expected, "blocked", "ambiguous_temp");
    }

    let status: ArtifactOutputStatus;
    let reason: ArtifactOutputReason;
    try {
      const installed = await installOrReconcile(directory, finalPath, temp, expected, hooks, runtime);
      if (!installed) return result(outputKey, expected, "blocked", "commit_indeterminate");
      status = "committed";
      reason = "recovered_after_crash";
    } catch (error) {
      if (!isInstallOutcome(error)) return result(outputKey, expected, "blocked", "commit_indeterminate");
      status = error.status;
      reason = error.reason;
    }

    // Preserve a verified temp when the final target conflicts. Deleting it
    // would discard the only crash-recovery evidence and could make a later
    // user-resolved retry repeat the transfer.
    if (status !== "committed" && status !== "reconciled") return result(outputKey, expected, status, reason);
    const cleanup = await cleanupOwnedTemp(directory, temp, hooks, runtime);
    if (runtime.localEffectUncertain) return result(outputKey, expected, "blocked", "commit_indeterminate");
    try {
      await syncDirectory(directory, hooks, runtime);
    } catch {
      return result(outputKey, expected, "blocked", "commit_indeterminate");
    }
    if (cleanup === "ambiguous") return result(outputKey, expected, "blocked", "temp_cleanup_ambiguous");
    if (cleanup === "pending") {
      // The final copy is durable and receipt-bound, but cleanup was
      // intentionally quarantined (for example, a verified recovery temp).
      return result(outputKey, expected, status, "temp_cleanup_pending");
    }
    return result(outputKey, expected, status, reason);
  } catch {
    return result(outputKey, expected, "blocked", "ambiguous_temp");
  } finally {
    if (temp !== undefined) await closeTempHandle(temp);
  }
}

async function createOwnedTemp(directory: SecureDirectory, prefix: string, hooks: ArtifactOutputHooks | undefined, runtime: OutputRuntime): Promise<TempOwnership> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = await entropyHex(hooks?.entropy, runtime);
    const tempPath = safeChildPath(directory.canonical, `${prefix}${token}.tmp`);
    try {
      await inject(hooks, "before_temp_open", runtime);
    } catch (error) {
      rethrowRuntimeFailure(error);
      throw new ArtifactOutputError("temp_open_failed", "Operation-owned temporary output could not be created.");
    }
    let handle;
    try {
      await assertDirectoryStable(directory, runtime);
      handle = await open(tempPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), POSIX_FILE_MODE);
    } catch (error) {
      rethrowRuntimeFailure(error);
      if (isErrno(error, "EEXIST")) continue;
      throw new ArtifactOutputError("temp_open_failed", "Operation-owned temporary output could not be created.");
    }
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) {
        throw new ArtifactOutputError("temp_open_failed", "Operation-owned temporary output is not a regular file.");
      }
      // Keep this descriptor open through streaming and installation. The
      // temp pathname may be replaced after this point; the retained handle
      // remains the only source capability used by the commit phase.
      return { path: tempPath, device: stats.dev, inode: stats.ino, handle };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  throw new ArtifactOutputError("temp_open_failed", "Could not obtain a collision-resistant temporary output name.");
}

async function writeSource(temp: TempOwnership, options: ArtifactOutputCommitOptions, runtime: OutputRuntime): Promise<StreamedArtifact> {
  const handle = temp.handle;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const digest = createHash("sha256");
  let bytes = 0;
  let chunkCount = 0;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let iteratorDone = false;
  try {
    checkRuntime(runtime);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== temp.device || opened.ino !== temp.inode) {
      throw new ArtifactOutputError("write_failed", "Operation-owned temporary output changed before writing.");
    }
    if (isSignalAborted(options.signal)) {
      throw new StreamOutcome("blocked", "source_aborted", bytes, digest.copy().digest("hex"));
    }
    iterator = safeAsyncIterator(options.source);
    while (true) {
      const next = await nextWithDeadline(iterator, runtime);
      if (next.done) {
        iteratorDone = true;
        break;
      }
      chunkCount += 1;
      if (chunkCount > MAX_PROVIDER_CHUNKS) {
        throw new StreamOutcome("blocked", "source_invalid", bytes, digest.copy().digest("hex"));
      }
      const chunk = next.value;
      if (isSignalAborted(options.signal)) {
        throw new StreamOutcome("blocked", "source_aborted", bytes, digest.copy().digest("hex"));
      }
      if (!(chunk instanceof Uint8Array)) {
        throw new StreamOutcome("blocked", "source_invalid", bytes, digest.copy().digest("hex"));
      }
      // Reject an oversized provider allocation before copying it.  The
      // artifact-wide limit is intentionally much larger, but allowing one
      // untrusted chunk to approach that limit defeats streaming's memory
      // bound and can trigger a second full-sized copy.
      if (chunk.byteLength > MAX_PROVIDER_CHUNK_BYTES) {
        throw new StreamOutcome("blocked", "source_invalid", bytes, digest.copy().digest("hex"));
      }
      if (chunk.byteLength > maxBytes - bytes) {
        throw new StreamOutcome("blocked", "byte_limit_exceeded", bytes, digest.copy().digest("hex"));
      }
      // Copy synchronously before the first hook/write await.  A transfer
      // source has already crossed this ownership boundary in safeSource;
      // use its private copy directly to avoid a redundant full-chunk copy.
      // Direct callers still receive the defensive Buffer copy here.
      const buffer = isOwnedProviderChunk(chunk)
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(chunk);
      try {
        await inject(options.hooks, "before_write", runtime);
      } catch (error) {
        rethrowRuntimeFailure(error);
        throw new StreamOutcome("blocked", "write_failed", bytes, digest.copy().digest("hex"));
      }
      let written = 0;
      while (written < buffer.byteLength) {
        let count: number;
        try {
          count = (await localEffect(runtime, () => handle.write(buffer, written, buffer.byteLength - written, bytes + written))).bytesWritten;
        } catch (error) {
          rethrowRuntimeFailure(error);
          throw new StreamOutcome("blocked", "write_failed", bytes, digest.copy().digest("hex"));
        }
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw new StreamOutcome("blocked", "write_failed", bytes, digest.copy().digest("hex"));
        }
        written += count;
      }
      digest.update(buffer);
      bytes += buffer.byteLength;
      try {
        await inject(options.hooks, "after_write", runtime);
      } catch (error) {
        rethrowRuntimeFailure(error);
        throw new StreamOutcome("blocked", "write_failed", bytes, digest.copy().digest("hex"));
      }
    }
    try {
      await inject(options.hooks, "before_file_sync", runtime);
    } catch (error) {
      rethrowRuntimeFailure(error);
      throw new StreamOutcome("blocked", "file_sync_failed", bytes, digest.copy().digest("hex"), true);
    }
    try {
      await localEffect(runtime, () => handle.sync());
    } catch (error) {
      rethrowRuntimeFailure(error);
      throw new StreamOutcome("blocked", "file_sync_failed", bytes, digest.copy().digest("hex"), true);
    }
    try {
      await inject(options.hooks, "after_file_sync", runtime);
    } catch (error) {
      rethrowRuntimeFailure(error);
      throw new StreamOutcome("blocked", "file_sync_failed", bytes, digest.copy().digest("hex"), true);
    }
    return { bytes, sha256: digest.digest("hex") };
  } catch (error) {
    if (isInstallOutcome(error) || isArtifactOutputError(error)) throw error;
    throw new StreamOutcome("blocked", "source_read_failed", bytes, digest.copy().digest("hex"));
  } finally {
    if (iterator !== undefined && !iteratorDone) await closeAsyncIterator(iterator, runtime);
    // The descriptor is deliberately retained for installOrReconcile(). The
    // outer commit finally block closes it after cleanup/reconciliation.
  }
}

async function installOrReconcile(
  directory: SecureDirectory,
  finalPath: string,
  temp: TempOwnership,
  stream: StreamedArtifact,
  hooks: ArtifactOutputHooks | undefined,
  runtime: OutputRuntime
): Promise<boolean> {
  await assertDirectoryStable(directory, runtime);
  if (!(await retainedTempIsStable(temp, stream.bytes, runtime))) {
    throw new InstallOutcome("blocked", "commit_indeterminate");
  }
  try {
    await inject(hooks, "before_final_link", runtime);
    await assertDirectoryStable(directory, runtime);
    // Re-validate the retained descriptor after the hook. A replacement of
    // temp.path cannot affect the descriptor, while a source mutation is
    // detected before any final destination is opened.
    if (!(await retainedTempIsStable(temp, stream.bytes, runtime))) {
      throw new InstallOutcome("blocked", "commit_indeterminate");
    }
  } catch {
    throw new InstallOutcome("blocked", "commit_indeterminate");
  }

  let destination: FileHandle | undefined;
  try {
    // The destination is created exclusively and never opened through a
    // pre-existing pathname. Copying from the retained source descriptor is
    // O(1) memory and cannot be redirected by replacing temp.path after the
    // source validation above.
    destination = await localEffect(runtime, () => open(
      finalPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      POSIX_FILE_MODE
    ));
    // Opening through the canonical pathname is followed by another identity
    // check before any bytes are copied. If the parent directory changed in
    // the open race, fail closed and leave the unclaimed empty destination as
    // crash evidence rather than writing into an unverified directory.
    await assertDirectoryStable(directory, runtime);
    if (!(await destinationPathMatches(finalPath, destination, undefined, runtime))) {
      throw new InstallOutcome("blocked", "commit_indeterminate");
    }
    await copyRetainedTemp(temp, destination, stream, runtime);
    await inject(hooks, "after_final_link", runtime);
    await assertDirectoryStable(directory, runtime);
    // The hook is an adversarial boundary: a same-user replacement can occur
    // after the copy/fsync. Re-read the retained destination and prove that
    // finalPath still names that exact descriptor before reporting success.
    // Pure Node cannot atomically bind a pathname to this descriptor; a
    // separate same-UID process can still replace the path after this final
    // check, which is the documented residual platform boundary.
    await verifyDestination(destination, finalPath, stream, runtime);
    return true;
  } catch (error) {
    await destination?.close().catch(() => undefined);
    if (!isErrno(error, "EEXIST")) {
      throw new InstallOutcome("blocked", "commit_indeterminate");
    }
    const existing = await inspectExistingFinal(finalPath, stream, runtime);
    if (existing === "not_regular") {
      throw new InstallOutcome("blocked", "existing_target_not_regular");
    }
    if (existing === "same") {
      throw new InstallOutcome("reconciled", "already_present");
    }
    if (existing === "different") {
      throw new InstallOutcome("collision", "existing_mismatch");
    }
    throw new InstallOutcome("blocked", "commit_indeterminate");
  } finally {
    await destination?.close().catch(() => undefined);
  }
}

async function retainedTempIsStable(temp: TempOwnership, expectedBytes: number, runtime: OutputRuntime): Promise<boolean> {
  try {
    checkRuntime(runtime);
    const metadata = await temp.handle.stat({ bigint: true });
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.dev === temp.device
      && metadata.ino === temp.inode
      && metadata.size === BigInt(expectedBytes);
  } catch (error) {
    rethrowRuntimeFailure(error);
    return false;
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

async function retainedTempMatches(
  temp: TempOwnership,
  expected: Readonly<{ bytes: number; sha256: string }>,
  runtime: OutputRuntime
): Promise<boolean> {
  try {
    checkRuntime(runtime);
    const before = await temp.handle.stat({ bigint: true });
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.dev !== temp.device
      || before.ino !== temp.inode
      || before.size !== BigInt(expected.bytes)) return false;
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected.bytes)));
    let position = 0;
    while (position < expected.bytes) {
      const length = Math.min(buffer.byteLength, expected.bytes - position);
      const read = await temp.handle.read(buffer, 0, length, position);
      if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > length) return false;
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await temp.handle.stat({ bigint: true });
    checkRuntime(runtime);
    return sameFileIdentity(before, after)
      && before.size === after.size
      && before.mtimeNs === after.mtimeNs
      && before.ctimeNs === after.ctimeNs
      && position === expected.bytes
      && digest.digest("hex") === expected.sha256;
  } catch (error) {
    rethrowRuntimeFailure(error);
    return false;
  }
}

async function closeTempHandle(temp: TempOwnership): Promise<void> {
  await temp.handle.close().catch(() => undefined);
}

async function copyRetainedTemp(
  temp: TempOwnership,
  destination: FileHandle,
  expected: StreamedArtifact,
  runtime: OutputRuntime
): Promise<void> {
  const source = temp.handle;
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected.bytes)));
  let position = 0;
  try {
    checkRuntime(runtime);
    while (position < expected.bytes) {
      const length = Math.min(buffer.byteLength, expected.bytes - position);
      const read = await localEffect(runtime, () => source.read(buffer, 0, length, position));
      if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > length) {
        throw new ArtifactOutputError("copy_failed", "Operation-owned source could not be copied safely.");
      }
      let written = 0;
      while (written < read.bytesRead) {
        const result = await localEffect(runtime, () => destination.write(
          buffer,
          written,
          read.bytesRead - written,
          position + written
        ));
        if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
          throw new ArtifactOutputError("copy_failed", "Final artifact copy did not complete.");
        }
        written += result.bytesWritten;
      }
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    if (position !== expected.bytes || digest.digest("hex") !== expected.sha256) {
      throw new ArtifactOutputError("copy_mismatch", "Final artifact copy did not match the verified source.");
    }
    await localEffect(runtime, () => destination.sync());
    if (!(await retainedTempIsStable(temp, expected.bytes, runtime))) {
      throw new ArtifactOutputError("copy_source_changed", "Verified artifact source changed during final installation.");
    }
  } catch (error) {
    rethrowRuntimeFailure(error);
    throw error;
  }
}

async function inspectExistingFinalKind(
  finalPath: string,
  runtime: OutputRuntime
): Promise<"regular" | "not_regular" | "unavailable"> {
  try {
    checkRuntime(runtime);
    const metadata = await lstat(finalPath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) return "not_regular";
    return "regular";
  } catch (error) {
    rethrowRuntimeFailure(error);
    return "unavailable";
  }
}

async function destinationPathMatches(
  finalPath: string,
  destination: FileHandle,
  expectedBytes: number | undefined,
  runtime: OutputRuntime
): Promise<boolean> {
  try {
    checkRuntime(runtime);
    const pathMetadata = await lstat(finalPath, { bigint: true });
    const descriptorMetadata = await destination.stat({ bigint: true });
    return sameFileIdentity(pathMetadata, descriptorMetadata)
      && (expectedBytes === undefined || descriptorMetadata.size === BigInt(expectedBytes));
  } catch (error) {
    rethrowRuntimeFailure(error);
    return false;
  }
}

async function verifyDestination(
  destination: FileHandle,
  finalPath: string,
  expected: StreamedArtifact,
  runtime: OutputRuntime
): Promise<void> {
  if (!(await destinationPathMatches(finalPath, destination, expected.bytes, runtime))) {
    throw new InstallOutcome("blocked", "commit_indeterminate");
  }
  const before = await destination.stat({ bigint: true });
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected.bytes)));
  let position = 0;
  while (position < expected.bytes) {
    const length = Math.min(buffer.byteLength, expected.bytes - position);
    const read = await destination.read(buffer, 0, length, position);
    if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > length) {
      throw new InstallOutcome("blocked", "commit_indeterminate");
    }
    digest.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  const after = await destination.stat({ bigint: true });
  const digestHex = digest.digest("hex");
  const pathMatches = await destinationPathMatches(finalPath, destination, expected.bytes, runtime);
  if (!sameFileIdentity(before, after)
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
    || position !== expected.bytes
    || digestHex !== expected.sha256
    || !pathMatches) {
    throw new InstallOutcome("blocked", "commit_indeterminate");
  }
}

async function inspectExistingFinal(finalPath: string, expected: StreamedArtifact, runtime: OutputRuntime): Promise<"same" | "different" | "not_regular" | "unavailable"> {
  let metadata: BigIntStats;
  try {
    checkRuntime(runtime);
    metadata = await lstat(finalPath, { bigint: true });
  } catch (error) {
    rethrowRuntimeFailure(error);
    return isErrno(error, "ENOENT") ? "unavailable" : "unavailable";
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) return "not_regular";
  if (metadata.size < 0n || metadata.size > BigInt(Number.MAX_SAFE_INTEGER) || Number(metadata.size) !== expected.bytes) return "different";
  let handle;
  try {
    handle = await open(finalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return "unavailable";
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== metadata.dev || before.ino !== metadata.ino) return "unavailable";
    const digest = createHash("sha256");
    let bytes = 0;
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    try {
      for await (const chunk of stream) {
        checkRuntime(runtime);
        const buffer = chunk as Buffer;
        digest.update(buffer);
        bytes += buffer.byteLength;
        if (bytes > expected.bytes) return "different";
      }
    } catch (error) {
      rethrowRuntimeFailure(error);
      return "unavailable";
    }
    const after = await handle.stat({ bigint: true });
    checkRuntime(runtime);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      return "unavailable";
    }
    return bytes === expected.bytes && digest.digest("hex") === expected.sha256 ? "same" : "different";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function cleanupOwnedTemp(
  directory: SecureDirectory,
  temp: TempOwnership,
  hooks: ArtifactOutputHooks | undefined,
  runtime: OutputRuntime,
  preserveForRecovery = false
): Promise<"clean" | "pending" | "ambiguous"> {
  if (runtime.localEffectInFlight || runtime.localEffectUncertain) return "pending";
  // Release the retained source descriptor before pathname cleanup. This is
  // required on Windows, where an open handle can prevent unlink; the handle
  // is no longer needed once installation/error classification has finished.
  await closeTempHandle(temp);
  try {
    await inject(hooks, "before_temp_cleanup", runtime);
    await assertDirectoryStable(directory, runtime);
  } catch {
    return "pending";
  }
  let metadata: BigIntStats;
  try {
    metadata = await lstat(temp.path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "clean";
    return "pending";
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.dev !== temp.device || metadata.ino !== temp.inode) {
    return "ambiguous";
  }
  if (preserveForRecovery) {
    // The source bytes/hash were complete at the failed boundary. Keep this
    // verified temp for a later receipt-bound recovery instead of forcing an
    // unrepeatable provider transfer to run again.
    return "pending";
  }
  // Node does not expose unlinkat(2) through fs/promises. Use one synchronous
  // identity-check/unlink critical section so no same-process callback can
  // replace the pathname between the lstat and unlink. A separate same-UID
  // process can still race this pathname operation; that residual platform
  // boundary is intentionally not described as absolute TOCTOU protection.
  try {
    checkRuntime(runtime);
    unlinkSync(temp.path);
    await inject(hooks, "after_temp_cleanup", runtime);
    return "clean";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "clean";
    return "pending";
  }
}

async function syncDirectory(directory: SecureDirectory, hooks: ArtifactOutputHooks | undefined, runtime: OutputRuntime): Promise<void> {
  await inject(hooks, "before_directory_sync", runtime);
  await assertDirectoryStable(directory, runtime);
  let handle;
  try {
    handle = await open(directory.canonical, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }
  try {
    try {
      await localEffect(runtime, () => handle.sync());
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  } finally {
    // Do not release the directory handle until the fsync effect has settled.
    await handle.close().catch(() => undefined);
  }
  await inject(hooks, "after_directory_sync", runtime);
  await assertDirectoryStable(directory, runtime);
}

async function entropyHex(entropy: ArtifactOutputEntropy | undefined, runtime: OutputRuntime): Promise<string> {
  try {
    checkRuntime(runtime);
    const value = entropy === undefined
      ? randomBytes(TEMP_TOKEN_BYTES)
      : await bounded(runtime, () => entropy(TEMP_TOKEN_BYTES));
    if (!(value instanceof Uint8Array) || value.byteLength < TEMP_TOKEN_BYTES) {
      throw new Error("invalid entropy");
    }
    return Buffer.from(value.subarray(0, TEMP_TOKEN_BYTES)).toString("hex");
  } catch (error) {
    rethrowRuntimeFailure(error);
    throw new ArtifactOutputError("entropy_failed", "Temporary output entropy could not be obtained.");
  }
}

async function inject(hooks: ArtifactOutputHooks | undefined, point: ArtifactOutputFaultPoint, runtime: OutputRuntime): Promise<void> {
  checkRuntime(runtime);
  const callback = hooks?.faultInjector;
  if (callback !== undefined) await bounded(runtime, () => callback(point));
  checkRuntime(runtime);
}

function outputIdentityDigest(input: ArtifactOutputKeyInput, extension: string): string {
  const hash = createHash("sha256");
  hash.update("codex-chatgpt-control/artifact-output/v1\0", "utf8");
  updateLengthPrefixed(hash, input.operationId);
  updateLengthPrefixed(hash, input.artifactIdentity);
  updateLengthPrefixed(hash, extension);
  updateLengthPrefixed(hash, normalizeMime(input.mimeTypeHint) ?? "");
  return hash.digest("hex");
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(String(bytes.byteLength), "utf8");
  hash.update(":", "utf8");
  hash.update(bytes);
  hash.update("\0", "utf8");
}

function validateOpaqueIdentity(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > MAX_IDENTITY_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArtifactOutputError("invalid_opaque_identity", `${name} must be a non-empty opaque identity.`);
  }
}

function normalizeExtension(extensionHint: string | undefined, mimeTypeHint: string | undefined): string {
  const normalizedMime = normalizeMime(mimeTypeHint);
  if (extensionHint !== undefined) {
    if (typeof extensionHint !== "string") throw new ArtifactOutputError("invalid_extension_hint", "Extension hint must be a string.");
    let extension = extensionHint.trim().toLowerCase();
    if (extension.startsWith(".")) extension = extension.slice(1);
    if (extension.length === 0 || byteLength(extension) > MAX_HINT_LENGTH || !/^[a-z0-9](?:[a-z0-9-]{0,31})$/.test(extension)) {
      throw new ArtifactOutputError("invalid_extension_hint", "Extension hint is not a vetted public extension.");
    }
    return extension;
  }
  if (normalizedMime !== undefined) return MIME_EXTENSIONS[normalizedMime] ?? "";
  return "";
}

function normalizeMime(mimeTypeHint: string | undefined): string | undefined {
  if (mimeTypeHint === undefined) return undefined;
  if (typeof mimeTypeHint !== "string") throw new ArtifactOutputError("invalid_mime_type_hint", "MIME type hint must be a string.");
  const mime = mimeTypeHint.trim().toLowerCase();
  if (mime.length === 0 || byteLength(mime) > 127 || !/^[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}$/.test(mime)) {
    throw new ArtifactOutputError("invalid_mime_type_hint", "MIME type hint is not valid.");
  }
  return mime;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "application/gzip": "gz",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "audio/mpeg": "mp3",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
  "video/mp4": "mp4"
};

function classifyFailure(error: unknown): ArtifactOutputReason {
  if (isArtifactOutputError(error)) {
    switch (error.code) {
      case "operation_timeout": return "operation_timeout";
      case "clock_invalid": return "clock_invalid";
      case "source_aborted": return "source_aborted";
      case "destination_invalid": return "destination_invalid";
      case "invalid_artifact_source": return "source_invalid";
      case "file_sync_failed": return "file_sync_failed";
      case "write_failed":
      case "temp_open_failed": return "write_failed";
      case "entropy_failed": return "entropy_failed";
      default: return "source_read_failed";
    }
  }
  if (isInstallOutcome(error)) return error.reason;
  return "source_read_failed";
}

function runtimeReason(error: unknown, fallback: ArtifactOutputReason = "destination_invalid"): ArtifactOutputReason {
  if (isArtifactOutputError(error)) {
    if (error.code === "operation_timeout") return "operation_timeout";
    if (error.code === "clock_invalid") return "clock_invalid";
    if (error.code === "source_aborted") return "source_aborted";
  }
  return fallback;
}

function rethrowRuntimeFailure(error: unknown): void {
  if (isRuntimeArtifactError(error) || (isArtifactOutputError(error) && error.code === "destination_invalid")) {
    throw error;
  }
}

function isArtifactOutputError(error: unknown): error is ArtifactOutputError {
  try {
    return error instanceof ArtifactOutputError;
  } catch {
    return false;
  }
}

function isInstallOutcome(error: unknown): error is InstallOutcome {
  try {
    return error instanceof InstallOutcome;
  } catch {
    return false;
  }
}

function isStreamOutcome(error: unknown): error is StreamOutcome {
  try {
    return error instanceof StreamOutcome;
  } catch {
    return false;
  }
}

function isRuntimeArtifactError(error: unknown): error is ArtifactOutputError {
  if (!isArtifactOutputError(error)) return false;
  try {
    return error.code === "operation_timeout" || error.code === "clock_invalid" || error.code === "source_aborted";
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === code;
  } catch {
    return false;
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (isErrno(error, "EPERM")) return process.platform === "win32";
  return ["EINVAL", "ENOTSUP", "EISDIR", "ENOSYS", "EBADF"].some(code => isErrno(error, code));
}
