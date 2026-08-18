export const BACKEND_REQUEST_SCHEMA_VERSION = "chatgpt.browser_control.backend_request.v1" as const;
export const BACKEND_RESPONSE_SCHEMA_VERSION = "chatgpt.browser_control.backend_response.v1" as const;
export const BACKEND_EVENT_SCHEMA_VERSION = "chatgpt.browser_control.backend_event.v1" as const;
export const BACKEND_HELLO_COMMAND = "backend.hello" as const;
export const BACKEND_UNKNOWN_ID_QUARANTINE_LIMIT = 256;
export const BACKEND_UNKNOWN_ID_QUARANTINE_TTL_MS = 60_000;
/** Maximum encoded NDJSON frame size, excluding the trailing newline. */
export const BACKEND_NDJSON_FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
/** Maximum requestId length accepted on any backend protocol message. */
export const BACKEND_REQUEST_ID_MAX_LENGTH = 4096;
/** Reserved for transport-owned hello/legacy control probes. */
export const BACKEND_CONTROL_REQUEST_ID_PREFIX = "__backend_control__";
export const BACKEND_COMPATIBILITY_SCHEMA_VERSION =
  "chatgpt.browser_control.backend_compatibility.v1" as const;

/** A bounded, redacted comparison retained by a lifecycle-owned backend transport. */
export type BackendCompatibilityWarningCode =
  | "package_name_mismatch"
  | "package_version_mismatch"
  | "runtime_mismatch"
  | "runtime_version_mismatch"
  | "build_digest_mismatch"
  | "provenance_unknown"
  | "legacy_backend"
  | "negotiation_rejected";

export type BackendCompatibilityWarning = Readonly<{
  code: BackendCompatibilityWarningCode;
  field?: "packageName" | "packageVersion" | "runtime" | "runtimeVersion" | "buildDigest";
  expected?: string;
  received?: string;
  message: string;
}>;

export type BackendCompatibilityReport = Readonly<{
  schemaVersion: typeof BACKEND_COMPATIBILITY_SCHEMA_VERSION;
  status: "compatible" | "warning" | "unknown" | "blocked";
  mode: "multiplexed" | "single-flight" | "legacy" | "unknown";
  protocolVersion?: string;
  backendSessionId?: string;
  packageName?: string;
  packageVersion?: string;
  runtime?: string;
  runtimeVersion?: string;
  buildDigest?: string;
  warnings: readonly BackendCompatibilityWarning[];
}>;

export const backendCommands = [
  "backend.version",
  "backend.health",
  "backend.capabilities",
  "backend.hello",
  "runner.run",
  "runner.plan",
  "runner.stream",
  "responses.create",
  "ask",
  "askInThread",
  "askWithFiles",
  "askAndDownload",
  "runMessages",
  "openThread",
  "readLatest",
  "copyLatest",
  "downloadLatest",
  "runPlan",
  "doctor",
  "createReport",
  "reports.create",
  "reports.redact",
  "reports.summarize",
  "commands",
  "describe",
  "help",
  "session.bootstrap",
  "experience.detect",
  "experience.open",
  "configuration.inspect",
  "configuration.apply",
  "work.start",
  "work.status",
  "work.wait",
  "work.steer",
  "work.readLatest",
  "threads.new",
  "threads.search",
  "threads.open",
  "messages.compose",
  "messages.submit",
  "messages.ask",
  "messages.wait",
  "messages.readLatest",
  "messages.status",
  "messages.stop",
  "messages.waitAndRead",
  "artifacts.listLatest",
  "artifacts.wait",
  "artifacts.downloadLatest",
  "files.preflight",
  "files.attach",
  "files.downloadLatest",
  "projects.sources.list",
  "projects.sources.planAdd",
  "projects.sources.add",
  "modes.set",
  "modes.get",
  "tools.select",
  "response.copy",
  "operations.submit",
  "operations.collect",
  "operations.inspect",
  "operations.control"
] as const;

export type BackendCommand = typeof backendCommands[number];

export type BackendRequest = {
  schemaVersion: typeof BACKEND_REQUEST_SCHEMA_VERSION;
  requestId?: string;
  command: BackendCommand;
  payload: Record<string, unknown>;
};

export type BackendProtocolErrorCode =
  | "invalid_request"
  | "unsupported_schema_version"
  | "unknown_command";

export class ProtocolError extends Error {
  constructor(
    public readonly code: BackendProtocolErrorCode,
    message: string,
    public readonly recoverable: boolean
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type BackendResponseOk<TResult = unknown> = {
  schemaVersion: typeof BACKEND_RESPONSE_SCHEMA_VERSION;
  requestId?: string;
  ok: true;
  result: TResult;
};

export type BackendResponseError = {
  schemaVersion: typeof BACKEND_RESPONSE_SCHEMA_VERSION;
  requestId?: string;
  ok: false;
  error: {
    code: BackendProtocolErrorCode | string;
    message: string;
    recoverable: boolean;
  };
};

export type BackendResponse<TResult = unknown> = BackendResponseOk<TResult> | BackendResponseError;

export type BackendCapabilities = {
  protocolVersion: typeof BACKEND_REQUEST_SCHEMA_VERSION;
  backendSessionId: string;
  packageName: string;
  packageVersion: string;
  runtime: "node";
  runtimeVersion: string;
  buildDigest: string;
  supportedProtocolVersions: string[];
  commands: BackendCommand[];
  transports: Array<"stdio" | "http">;
  streaming: {
    modes: Array<"ndjson" | "sse">;
    tokenDeltas: false;
  };
  requestIds: {
    required: boolean;
    scope: "connection" | "process" | "none";
  };
  multiplexing: {
    unary: boolean;
    streams: boolean;
  };
  cancellation: {
    supported: boolean;
    requests: boolean;
    streams: boolean;
  };
  tabs: {
    stableProviderIdentity: boolean;
    stableBrowserIdentity: boolean;
    stableTabIdentity: boolean;
    coordinationScope: "none" | "process" | "provider";
    authoritativeClaim: boolean;
    fencing: boolean;
    concurrentTabs: boolean;
    /** Deprecated aliases retained for older capability consumers. */
    stableIdentity?: boolean;
    coordination?: boolean;
    concurrent?: boolean;
  };
};

export type BackendRuntimeIdentity = {
  backendSessionId: string;
  packageName: string;
  packageVersion: string;
  runtime: "node";
  runtimeVersion: string;
  buildDigest: string;
  protocolVersion: typeof BACKEND_REQUEST_SCHEMA_VERSION;
};

export type BackendHelloPayload = {
  protocolVersion?: string;
  capabilities?: Partial<BackendCapabilities>;
};

export type BackendHelloResult = BackendRuntimeIdentity & {
  accepted: boolean;
  capabilities: BackendCapabilities;
};

export type BackendRunItemStreamEvent = {
  type: "run_item_stream_event";
  name: string;
  item: Record<string, unknown>;
};

export type BackendAgentUpdatedStreamEvent = {
  type: "agent_updated_stream_event";
  agent: Record<string, unknown>;
};

export type BackendCompletedEvent = {
  type: "completed";
  result: unknown;
};

export type BackendErrorEvent = {
  type: "error";
  error: {
    code: string;
    message: string;
    recoverable: boolean;
  };
};

export type BackendEventPayload =
  | BackendRunItemStreamEvent
  | BackendAgentUpdatedStreamEvent
  | BackendCompletedEvent
  | BackendErrorEvent;

export type BackendEvent = BackendEventPayload & {
  schemaVersion: typeof BACKEND_EVENT_SCHEMA_VERSION;
  requestId?: string;
};

const commandSet = new Set<string>(backendCommands);

export function parseBackendRequest(raw: unknown): BackendRequest {
  if (!isRecord(raw)) {
    throw new ProtocolError("invalid_request", "Backend request must be an object.", false);
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== BACKEND_REQUEST_SCHEMA_VERSION) {
    throw new ProtocolError(
      "unsupported_schema_version",
      `Unsupported backend request schemaVersion: ${String(schemaVersion)}`,
      false
    );
  }

  const command = raw.command;
  if (typeof command !== "string" || !commandSet.has(command)) {
    throw new ProtocolError("unknown_command", `Unknown backend command: ${String(command)}`, false);
  }

  const request: BackendRequest = {
    schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
    command: command as BackendCommand,
    payload: normalizePayload(raw.payload)
  };

  if (raw.requestId !== undefined) {
    if (!isValidBackendRequestId(raw.requestId)) {
      throw new ProtocolError("invalid_request", "Backend request requestId must be a non-empty string when provided.", false);
    }
    request.requestId = raw.requestId;
  }

  return request;
}

export function isValidBackendRequestId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= BACKEND_REQUEST_ID_MAX_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function backendResponseOk<TResult>(requestId: string | undefined, result: TResult): BackendResponseOk<TResult> {
  const response: BackendResponseOk<TResult> = {
    schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
    ok: true,
    result
  };
  if (requestId !== undefined) response.requestId = requestId;
  return response;
}

export function backendResponseError(requestId: string | undefined, error: ProtocolError | Error): BackendResponseError {
  // Arbitrary command/provider errors can contain prompts, local paths, page
  // text, or bridge diagnostics. Only deliberately constructed ProtocolError
  // messages are safe to cross the backend boundary.
  const protocolError = error instanceof ProtocolError;
  const response: BackendResponseError = {
    schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
    ok: false,
    error: {
      code: protocolError ? error.code : "invalid_request",
      message: protocolError ? error.message : "Backend command failed safely.",
      recoverable: protocolError ? error.recoverable : false
    }
  };
  if (requestId !== undefined) response.requestId = requestId;
  return response;
}

export function backendEvent(requestId: string | undefined, payload: BackendEventPayload): BackendEvent {
  const event: BackendEvent = {
    schemaVersion: BACKEND_EVENT_SCHEMA_VERSION,
    ...payload
  };
  if (requestId !== undefined) event.requestId = requestId;
  return event;
}

export function backendEventCompleted(requestId: string | undefined, result: unknown): BackendEvent {
  return backendEvent(requestId, { type: "completed", result });
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_request", "Backend request payload must be an object when provided.", false);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
