import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import type {
  AskAndDownloadWorkflowArgs,
  AskInThreadWorkflowArgs,
  AskWithFilesWorkflowArgs,
  AskWorkflowArgs,
  NamedWorkflowInvocation,
  RunMessagesArgs,
  WorkflowThread
} from "../client.js";
import type { DoctorArgs, DoctorReport } from "../commands/doctor.js";
import type { RunReportData, RunReportOptions } from "../commands/reports.js";
import type { CommandDescriptor } from "../commands/registry.js";
import { createChatGPTAgent } from "../runner/agent.js";
import type { ChatGPTResponsesCreateArgs } from "../runner/responses.js";
import type { ChatGPTRunStream, ChatGPTRunStreamEvent } from "../runner/stream.js";
import type {
  ChatGPTAgent,
  ChatGPTAgentConfig,
  ChatGPTResponse,
  ChatGPTRunInput,
  ChatGPTRunResult
} from "../runner/types.js";
import type {
  OperationCollectRequestV1,
  OperationControlRequestV1,
  OperationInspectRequestV1,
  OperationSubmitRequestV1
} from "../operations/types.js";
import {
  OperationWireRequestError,
  validateOperationCollectRequest as validateWireCollectRequest,
  validateOperationControlRequest as validateWireControlRequest,
  validateOperationInspectRequest as validateWireInspectRequest,
  validateOperationSubmitRequest as validateWireSubmitRequest
} from "../operations/wire-requests.js";
import {
  validateOperationCollectWireResult,
  validateOperationControlWireResult,
  validateOperationInspectWireResult,
  validateOperationSubmitWireResult,
  type OperationCollectWireResult,
  type OperationControlWireResult,
  type OperationInspectWireResult,
  type OperationSubmitWireResult
} from "../operations/wire-results.js";
import type { ReportRedactionOptions } from "../safety/report-redaction.js";
import type {
  ArtifactDownloadArgs,
  ArtifactWaitArgs,
  ApplyConfigurationData,
  ApplyConfigurationArgs,
  BootstrapArgs,
  ChatGPTExperience,
  CommandResult,
  ConfigurationInspectionData,
  CopyResponseArgs,
  DetectExperienceArgs,
  DetectExperienceData,
  DownloadLatestArgs,
  GetModeArgs,
  GetModeData,
  InspectConfigurationArgs,
  ListArtifactsArgs,
  MessageStatusArgs,
  StopGenerationArgs,
  StopGenerationData,
  NewThreadArgs,
  OpenThreadArgs,
  OpenExperienceData,
  ReadLatestArgs,
  ReadWorkLatestArgs,
  ReadWorkLatestData,
  SearchThreadsArgs,
  SelectToolArgs,
  SequencePlan,
  SetModeArgs,
  StartWorkArgs,
  StartWorkData,
  SteerWorkArgs,
  SteerWorkData,
  WaitArgs,
  WorkStatusArgs,
  WorkStatusData,
  WorkWaitArgs,
  WorkWaitData
} from "../types.js";
import {
  BACKEND_REQUEST_SCHEMA_VERSION,
  BACKEND_RESPONSE_SCHEMA_VERSION,
  BACKEND_EVENT_SCHEMA_VERSION,
  BACKEND_HELLO_COMMAND,
  BACKEND_CONTROL_REQUEST_ID_PREFIX,
  BACKEND_NDJSON_FRAME_LIMIT_BYTES,
  isValidBackendRequestId,
  type BackendCommand,
  type BackendCompatibilityReport,
  type BackendEvent,
  type BackendRequest,
  type BackendResponse
} from "./protocol.js";
import type {
  BackendCompatibilityExpectedIdentity
} from "./compatibility.js";
import {
  blockedCompatibilityReport,
  compatibilityReportFromHello,
  compatibilityReportFromLegacy,
  validateBackendCompatibilityReport
} from "./compatibility.js";

export type BackendTransport = {
  request(request: BackendRequest): Promise<BackendResponse>;
  stream(request: BackendRequest): AsyncIterable<BackendEvent>;
  /** Cancel locally pending delivery without claiming that the backend stopped. */
  cancel?: (requestId: string, reason?: Error) => boolean;
  close?: () => Promise<void> | void;
  /** Last bounded compatibility result for the current backend generation. */
  getCompatibilityReport?: () => BackendCompatibilityReport | undefined;
};

export class BackendClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable: boolean
  ) {
    super(message);
    this.name = "BackendClientError";
  }
}

export type ChatGPTBackendRunner = {
  run<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): Promise<ChatGPTRunResult<TOutput>>;
  plan<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): Promise<SequencePlan>;
  stream<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): ChatGPTRunStream<TOutput>;
};

/**
 * The backend operations facade deliberately uses the versioned wire request
 * envelopes as its direct payloads.  There is no `{ request: ... }` wrapper:
 * this keeps the Node, Python, and backend transports on one canonical shape
 * and makes accidental extra fields observable at the boundary.
 */
export type ChatGPTBackendOperations = {
  submit(request: OperationSubmitRequestV1): Promise<OperationSubmitWireResult>;
  collect(request: OperationCollectRequestV1): Promise<OperationCollectWireResult>;
  inspect(request: OperationInspectRequestV1): Promise<OperationInspectWireResult>;
  control(request: OperationControlRequestV1): Promise<OperationControlWireResult>;
};

export type ChatGPTBackendClient = {
  agent<TOutput = string>(config: ChatGPTAgentConfig<TOutput>): ChatGPTAgent<TOutput>;
  run<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): Promise<ChatGPTRunResult<TOutput>>;
  runner: ChatGPTBackendRunner;
  compatibility(): BackendCompatibilityReport | undefined;
  operations: ChatGPTBackendOperations;
  responses: {
    create(args: ChatGPTResponsesCreateArgs | Record<string, unknown>): Promise<ChatGPTResponse>;
  };
  commands(filter?: { layer?: CommandDescriptor["layer"] }): Promise<CommandDescriptor[]>;
  describe(name: string): Promise<CommandDescriptor | undefined>;
  help(topic?: string): Promise<string>;
  ask(args: AskWorkflowArgs): Promise<CommandResult<unknown>>;
  askInThread(args: AskInThreadWorkflowArgs): Promise<CommandResult<unknown>>;
  askWithFiles(args: AskWithFilesWorkflowArgs): Promise<CommandResult<unknown>>;
  askAndDownload(args: AskAndDownloadWorkflowArgs): Promise<CommandResult<unknown>>;
  runMessages(args: RunMessagesArgs): Promise<CommandResult<unknown>>;
  openThread(thread: WorkflowThread): Promise<CommandResult<unknown>>;
  readLatest(args?: ReadLatestArgs): Promise<CommandResult<unknown>>;
  copyLatest(args?: CopyResponseArgs): Promise<CommandResult<unknown>>;
  downloadLatest(args: DownloadLatestArgs): Promise<CommandResult<unknown>>;
  artifacts: {
    listLatest(args?: ListArtifactsArgs): Promise<CommandResult<unknown>>;
    wait(args?: ArtifactWaitArgs): Promise<CommandResult<unknown>>;
    downloadLatest(args: ArtifactDownloadArgs): Promise<CommandResult<unknown>>;
  };
  runPlan(plan: SequencePlan | NamedWorkflowInvocation): Promise<CommandResult<unknown>>;
  doctor(args?: DoctorArgs): Promise<CommandResult<DoctorReport>>;
  createReport(result: CommandResult<unknown>, args?: RunReportOptions): Promise<CommandResult<RunReportData>>;
  reports: {
    create(result: CommandResult<unknown>, args?: RunReportOptions): Promise<CommandResult<RunReportData>>;
    redact(value: unknown, args?: ReportRedactionOptions): Promise<CommandResult<unknown>>;
    summarize(result: CommandResult<unknown>, args?: ReportRedactionOptions): Promise<CommandResult<unknown>>;
  };
  session: {
    bootstrap(args?: BootstrapArgs): Promise<CommandResult<unknown>>;
  };
  experience: {
    detect(args?: DetectExperienceArgs): Promise<CommandResult<DetectExperienceData>>;
    open(args: { experience: Exclude<ChatGPTExperience, "unknown">; timeoutMs?: number }): Promise<CommandResult<OpenExperienceData>>;
  };
  configuration: {
    inspect(args?: InspectConfigurationArgs): Promise<CommandResult<ConfigurationInspectionData>>;
    apply(args: ApplyConfigurationArgs): Promise<CommandResult<ApplyConfigurationData>>;
  };
  work: {
    start(args: StartWorkArgs): Promise<CommandResult<StartWorkData>>;
    status(args?: WorkStatusArgs): Promise<CommandResult<WorkStatusData>>;
    wait(args?: WorkWaitArgs): Promise<CommandResult<WorkWaitData>>;
    steer(args: SteerWorkArgs): Promise<CommandResult<SteerWorkData>>;
    readLatest(args?: ReadWorkLatestArgs): Promise<CommandResult<ReadWorkLatestData>>;
    artifacts: {
      listLatest(args?: ListArtifactsArgs): Promise<CommandResult<unknown>>;
      wait(args?: ArtifactWaitArgs): Promise<CommandResult<unknown>>;
      downloadLatest(args: ArtifactDownloadArgs): Promise<CommandResult<unknown>>;
    };
  };
  threads: {
    "new"(args?: NewThreadArgs): Promise<CommandResult<unknown>>;
    search(args: SearchThreadsArgs): Promise<CommandResult<unknown>>;
    open(args: OpenThreadArgs): Promise<CommandResult<unknown>>;
  };
  messages: {
    compose(args: { text: string; mode?: "replace" | "append"; timeoutMs?: number }): Promise<CommandResult<unknown>>;
    submit(args?: { text?: string; previousTurnCount?: number; timeoutMs?: number }): Promise<CommandResult<unknown>>;
    ask(args: { text: string; wait?: boolean | WaitArgs; read?: boolean | ReadLatestArgs; timeoutMs?: number }): Promise<CommandResult<unknown>>;
    wait(args?: WaitArgs): Promise<CommandResult<unknown>>;
    readLatest(args?: ReadLatestArgs): Promise<CommandResult<unknown>>;
    status(args?: MessageStatusArgs): Promise<CommandResult<unknown>>;
    stop(args: StopGenerationArgs): Promise<CommandResult<StopGenerationData>>;
    waitAndRead(args?: WaitArgs & ReadLatestArgs): Promise<CommandResult<unknown>>;
  };
  files: {
    attach(args: { paths: string[]; timeoutMs?: number }): Promise<CommandResult<unknown>>;
    downloadLatest(args: DownloadLatestArgs): Promise<CommandResult<unknown>>;
  };
  modes: {
    set(args: SetModeArgs): Promise<CommandResult<unknown>>;
    get(args?: GetModeArgs): Promise<CommandResult<GetModeData>>;
  };
  tools: {
    select(args: SelectToolArgs): Promise<CommandResult<unknown>>;
  };
  response: {
    copy(args?: CopyResponseArgs): Promise<CommandResult<unknown>>;
  };
  close(): Promise<void>;
};

export function createChatGPTBackendClient(transport: BackendTransport): ChatGPTBackendClient {
  let nextRequestId = 0;
  const requestIdPrefix = `req_${process.pid}_${randomUUID()}`;

  const allocateRequestId = (): string => `${requestIdPrefix}_${++nextRequestId}`;

  const request = async <TResult>(command: BackendCommand, payload: Record<string, unknown> = {}): Promise<TResult> => {
    const response = await transport.request({
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      requestId: allocateRequestId(),
      command,
      payload
    });
    return unwrapResponse<TResult>(response);
  };

  const operations: ChatGPTBackendOperations = {
    submit: async operationRequest => {
      validateOperationSubmitRequest(operationRequest);
      return parseOperationResult(
        await request<unknown>("operations.submit", operationRequest as unknown as Record<string, unknown>),
        validateOperationSubmitWireResult
      );
    },
    collect: async operationRequest => {
      validateOperationCollectRequest(operationRequest);
      return parseOperationResult(
        await request<unknown>("operations.collect", operationRequest as unknown as Record<string, unknown>),
        validateOperationCollectWireResult
      );
    },
    inspect: async operationRequest => {
      validateOperationInspectRequest(operationRequest);
      const result = parseOperationResult(
        await request<unknown>("operations.inspect", operationRequest as unknown as Record<string, unknown>),
        validateOperationInspectWireResult
      );
      return attachOperationCompatibility(result, transport);
    },
    control: async operationRequest => {
      validateOperationControlRequest(operationRequest);
      return parseOperationResult(
        await request<unknown>("operations.control", operationRequest as unknown as Record<string, unknown>),
        validateOperationControlWireResult
      );
    }
  };

  const compatibility = (): BackendCompatibilityReport | undefined => {
    const report = transport.getCompatibilityReport?.();
    if (report === undefined) return undefined;
    try {
      return validateBackendCompatibilityReport(report);
    } catch {
      return undefined;
    }
  };

  const runner: ChatGPTBackendRunner = {
    run: (agent, input) => request("runner.run", { agent, input }),
    plan: (agent, input) => request("runner.plan", { agent, input }),
    stream: (agent, input) => {
      const requestId = allocateRequestId();
      return streamFromBackendEvents(transport.stream({
        schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        requestId,
        command: "runner.stream",
        payload: { agent, input }
      }), () => transport.cancel?.(requestId));
    }
  };

  return {
    agent: config => createChatGPTAgent(config),
    run: runner.run,
    runner,
    compatibility,
    operations,
    responses: {
      create: args => request("responses.create", args as Record<string, unknown>)
    },
    commands: filter => request("commands", filter === undefined ? {} : { filter }),
    describe: name => request("describe", { name }),
    help: topic => request("help", topic === undefined ? {} : { topic }),
    ask: args => request("ask", args as Record<string, unknown>),
    askInThread: args => request("askInThread", args as Record<string, unknown>),
    askWithFiles: args => request("askWithFiles", args as Record<string, unknown>),
    askAndDownload: args => request("askAndDownload", args as Record<string, unknown>),
    runMessages: args => request("runMessages", args as unknown as Record<string, unknown>),
    openThread: thread => request("openThread", thread as unknown as Record<string, unknown>),
    readLatest: args => request("readLatest", args as Record<string, unknown> | undefined ?? {}),
    copyLatest: args => request("copyLatest", args as Record<string, unknown> | undefined ?? {}),
    downloadLatest: args => request("downloadLatest", args as unknown as Record<string, unknown>),
    runPlan: plan => request("runPlan", plan as unknown as Record<string, unknown>),
    doctor: async args => {
      const result = await request<CommandResult<DoctorReport>>("doctor", args as Record<string, unknown> | undefined ?? {});
      return attachDoctorCompatibility(result, args, compatibility());
    },
    createReport: (result, args) => request("createReport", args === undefined ? { result } : { result, args }),
    reports: {
      create: (result, args) => request("reports.create", args === undefined ? { result } : { result, args }),
      redact: (value, args) => request("reports.redact", args === undefined ? { value } : { value, args }),
      summarize: (result, args) => request("reports.summarize", args === undefined ? { result } : { result, args })
    },
    session: {
      bootstrap: args => request("session.bootstrap", args as Record<string, unknown> | undefined ?? {})
    },
    experience: {
      detect: args => request("experience.detect", args as Record<string, unknown> | undefined ?? {}),
      open: args => request("experience.open", args as Record<string, unknown>)
    },
    configuration: {
      inspect: args => request("configuration.inspect", args as Record<string, unknown> | undefined ?? {}),
      apply: args => request("configuration.apply", args as unknown as Record<string, unknown>)
    },
    work: {
      start: args => request("work.start", args as unknown as Record<string, unknown>),
      status: args => request("work.status", args as Record<string, unknown> | undefined ?? {}),
      wait: args => request("work.wait", args as Record<string, unknown> | undefined ?? {}),
      steer: args => request("work.steer", args as unknown as Record<string, unknown>),
      readLatest: args => request("work.readLatest", args as Record<string, unknown> | undefined ?? {}),
      artifacts: {
        listLatest: args => request("artifacts.listLatest", args as Record<string, unknown> | undefined ?? {}),
        wait: args => request("artifacts.wait", args as Record<string, unknown> | undefined ?? {}),
        downloadLatest: args => request("artifacts.downloadLatest", args as unknown as Record<string, unknown>)
      }
    },
    threads: {
      new: args => request("threads.new", args as Record<string, unknown> | undefined ?? {}),
      search: args => request("threads.search", args as unknown as Record<string, unknown>),
      open: args => request("threads.open", args as unknown as Record<string, unknown>)
    },
    messages: {
      compose: args => request("messages.compose", args),
      submit: args => request("messages.submit", args as Record<string, unknown> | undefined ?? {}),
      ask: args => request("messages.ask", args as Record<string, unknown>),
      wait: args => request("messages.wait", args as Record<string, unknown> | undefined ?? {}),
      readLatest: args => request("messages.readLatest", args as Record<string, unknown> | undefined ?? {}),
      status: args => request("messages.status", args as Record<string, unknown> | undefined ?? {}),
      stop: args => request("messages.stop", args as unknown as Record<string, unknown>),
      waitAndRead: args => request("messages.waitAndRead", args as Record<string, unknown>)
    },
    artifacts: {
      listLatest: args => request("artifacts.listLatest", args as Record<string, unknown> | undefined ?? {}),
      wait: args => request("artifacts.wait", args as Record<string, unknown> | undefined ?? {}),
      downloadLatest: args => request("artifacts.downloadLatest", args as unknown as Record<string, unknown>)
    },
    files: {
      attach: args => request("files.attach", args),
      downloadLatest: args => request("files.downloadLatest", args as unknown as Record<string, unknown>)
    },
    modes: {
      set: args => request("modes.set", args as Record<string, unknown>),
      get: args => request("modes.get", args as Record<string, unknown> | undefined ?? {})
    },
    tools: {
      select: args => request("tools.select", args as Record<string, unknown>)
    },
    response: {
      copy: args => request("response.copy", args as Record<string, unknown> | undefined ?? {})
    },
    close: async () => {
      await transport.close?.();
    }
  };
}

export type StdioBackendTransportOptions = {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Aggregate bound for caller routes plus transport control routes. */
  maxInFlight?: number;
  streamQueueLimit?: number;
  streamQueueBytesLimit?: number;
  writeQueueLimit?: number;
  writeQueueBytesLimit?: number;
  lateOutputGraceMs?: number;
  tombstoneLimit?: number;
  quarantineLimit?: number;
  frameLimitBytes?: number;
  /** Optional caller provenance used only for bounded compatibility diagnostics. */
  expectedIdentity?: BackendCompatibilityExpectedIdentity;
};

const DEFAULT_BACKEND_TIMEOUT_MS = 600_000;
const DEFAULT_BACKEND_HANDSHAKE_TIMEOUT_MS = 10_000;
// One slot is reserved for the first caller while the transport performs its
// hello/legacy probes. A lower bound of two keeps that control route inside
// the aggregate bound instead of making the first request impossible.
const MIN_BACKEND_IN_FLIGHT_LIMIT = 2;
const DEFAULT_BACKEND_MAX_IN_FLIGHT = 256;
const DEFAULT_BACKEND_STREAM_QUEUE_LIMIT = 256;
const DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT = 16 * 1024 * 1024;
const DEFAULT_BACKEND_WRITE_QUEUE_LIMIT = 256;
const DEFAULT_BACKEND_WRITE_QUEUE_BYTES_LIMIT = 16 * 1024 * 1024;
const DEFAULT_BACKEND_LATE_OUTPUT_GRACE_MS = 5_000;
const DEFAULT_BACKEND_TOMBSTONE_LIMIT = 256;
const DEFAULT_BACKEND_QUARANTINE_LIMIT = 256;
const MAX_BACKEND_BUFFER_LIMIT = 1_000_000;
const MAX_BACKEND_STREAM_QUEUE_BYTES_LIMIT = 64 * 1024 * 1024;
const MAX_BACKEND_WRITE_QUEUE_BYTES_LIMIT = 64 * 1024 * 1024;
const MAX_BACKEND_TIMER_MS = 2_147_483_647;
const MAX_BACKEND_IDENTITY_FIELD_LENGTH = 512;
const REQUIRED_NEGOTIATION_COMMANDS = [
  "backend.hello",
  "backend.version",
  "backend.capabilities",
  "backend.health",
  "runner.run",
  "runner.stream"
] as const;
const LEGACY_HELLO_ERROR_CODES = new Set(["unknown_command"]);

export class StdioBackendTransport implements BackendTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: Readable | undefined;
  private pendingResponses = new Map<string, PendingResponse>();
  private pendingStreams = new Map<string, PendingStream>();
  private waitingRequests = new Map<string, WaitingCancellation>();
  private waitingStreams = new Map<string, WaitingCancellation>();
  // A caller route remains in this set while it waits for handshake or a
  // legacy single-flight slot. Once promoted, activeRequestIds owns its
  // admission through the terminal response/event.
  private waitingAdmissionIds = new Set<string>();
  private activeRequestIds = new Set<string>();
  // Control routes are a subset of activeRequestIds. Keeping this explicit
  // lets admission reserve virtual handshake headroom between sequential
  // legacy probes while still using the full bound during an active probe.
  private activeControlRequestIds = new Set<string>();
  private activeWrites = new Set<WriteAdmission>();
  private writeQueueCount = 0;
  private writeQueueBytes = 0;
  private tombstones = new Map<string, TombstoneRoute>();
  private quarantinedRequestIds = new Map<string, number>();
  // Keep one lifecycle tail across child generations. A reset while an old
  // stdin write is unresolved would orphan its queued line closures and let
  // repeated recycle cycles accumulate memory outside the admission budget.
  private writeTail: Promise<void> = Promise.resolve();
  private retiredWriteTail: Promise<void> | undefined;
  private recycleBlockedByWriteTeardown = false;
  private legacyTail: Promise<void> = Promise.resolve();
  private handshakeState: "unknown" | "ready" | "single-flight" | "legacy" | "blocked" = "unknown";
  private handshakePromise: Promise<void> | undefined;
  private handshakeGeneration = 0;
  private readonly requestIdPrefix = `transport_${process.pid}_${randomUUID()}`;
  private handshakeError: BackendClientError | undefined;
  private compatibilityReport: BackendCompatibilityReport | undefined;
  private protocolQuarantined = false;
  private quarantineRecycleTimer: NodeJS.Timeout | undefined;
  private tombstoneRecycleTimer: NodeJS.Timeout | undefined;
  private stderrBytes = 0;
  private stderrTruncated = false;
  private closed = false;

  constructor(private readonly options: StdioBackendTransportOptions) {
    validateTransportOptions(options);
  }

  async request(request: BackendRequest): Promise<BackendResponse> {
    const requestId = requireRequestId(request);
    this.reserveWaitingAdmission(requestId);
    return new Promise<BackendResponse>((resolve, reject) => {
      let settled = false;
      const cancelWaiting: WaitingCancellation = error => {
        if (settled) return false;
        settled = true;
        this.waitingRequests.delete(requestId);
        this.releaseWaitingAdmission(requestId);
        this.releaseRequestId(requestId, undefined);
        reject(error);
        return true;
      };
      this.waitingRequests.set(requestId, cancelWaiting);
      void (async () => {
        let legacyRelease: (() => void) | undefined;
        try {
          await this.ensureHandshake();
          if (settled) return;
          this.promoteWaitingAdmission(requestId);
          legacyRelease = isSingleFlightState(this.handshakeState)
            ? await this.acquireLegacySlot()
            : undefined;
          if (settled) {
            legacyRelease?.();
            return;
          }
          this.assertCanIssue();
          this.waitingRequests.delete(requestId);
          const response = await this.issueResponse(request, legacyRelease !== undefined);
          legacyRelease?.();
          if (settled) return;
          settled = true;
          resolve(response);
        } catch (error) {
          if (settled) return;
          settled = true;
          this.waitingRequests.delete(requestId);
          // If the request never reached stdin there is no late output to
          // guard against, so release the reservation without a tombstone.
          legacyRelease?.();
          this.releaseWaitingAdmission(requestId);
          this.releaseRequestId(requestId, undefined);
          reject(error);
        }
      })();
    });
  }

  stream(request: BackendRequest): AsyncIterable<BackendEvent> {
    const requestId = requireRequestId(request);
    const queue = new AsyncQueue<BackendEvent>(
      this.options.streamQueueLimit ?? DEFAULT_BACKEND_STREAM_QUEUE_LIMIT,
      () => {
        this.cancel(requestId, new BackendClientError(
          "backend_stream_iterator_closed",
          `Backend stream requestId ${requestId} was abandoned by its iterator.`,
          true
        ));
      },
      this.options.streamQueueBytesLimit ?? DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT
    );
    try {
      this.reserveWaitingAdmission(requestId);
    } catch (error) {
      queue.fail(error);
      return queue;
    }
    let settled = false;
    const cancelWaiting: WaitingCancellation = error => {
      if (settled) return false;
      settled = true;
      this.waitingStreams.delete(requestId);
      this.releaseWaitingAdmission(requestId);
      this.releaseRequestId(requestId, undefined);
      queue.fail(error);
      return true;
    };
    this.waitingStreams.set(requestId, cancelWaiting);
    void Promise.resolve().then(() => this.ensureHandshake())
      .then(() => {
        if (settled) return;
        const legacyReleasePromise = isSingleFlightState(this.handshakeState)
          ? this.acquireLegacySlot()
          : Promise.resolve(undefined);
        return legacyReleasePromise.then(legacyRelease => {
          if (settled) {
            legacyRelease?.();
            return;
          }
          try {
            this.promoteWaitingAdmission(requestId);
            this.assertCanIssue();
          } catch (error) {
            legacyRelease?.();
            throw error;
          }
          this.waitingStreams.delete(requestId);
          return this.issueStream(request, queue, legacyRelease);
        });
      })
      .catch(error => {
        if (settled) return;
        settled = true;
        this.waitingStreams.delete(requestId);
        this.releaseWaitingAdmission(requestId);
        this.releaseRequestId(requestId, undefined);
        queue.fail(error);
      });
    return queue;
  }

  cancel(requestId: string, reason?: Error): boolean {
    const cancellationError = reason ?? new BackendClientError(
      "backend_request_cancelled",
      `Backend request ${requestId} was cancelled locally.`,
      true
    );
    const waitingRequest = this.waitingRequests.get(requestId);
    if (waitingRequest !== undefined) return waitingRequest(cancellationError);
    const waitingStream = this.waitingStreams.get(requestId);
    if (waitingStream !== undefined) return waitingStream(cancellationError);
    const response = this.pendingResponses.get(requestId);
    if (response !== undefined) {
      const writeStarted = this.hasStartedWrite(requestId);
      this.clearResponse(requestId, true);
      response.reject(cancellationError);
      if (writeStarted) this.terminate(cancellationError);
      return true;
    }
    const stream = this.pendingStreams.get(requestId);
    if (stream !== undefined) {
      const writeStarted = this.hasStartedWrite(requestId);
      this.clearStream(requestId, true);
      stream.queue.fail(cancellationError);
      if (writeStarted) this.terminate(cancellationError);
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child === undefined) {
      this.failAll(new BackendClientError("backend_closed", "Backend transport was closed.", true));
      return;
    }
    this.terminate(new BackendClientError("backend_closed", "Backend transport was closed.", true), child);
  }

  private start(): void {
    if (this.closed) {
      throw new BackendClientError("backend_closed", "Backend transport is closed.", true);
    }
    if (this.recycleBlockedByWriteTeardown) {
      throw new BackendClientError(
        "backend_write_teardown_pending",
        "Backend transport cannot start a new child while a previous stdin write is unresolved.",
        true
      );
    }
    if (this.child !== undefined) return;
    const [command, ...args] = this.options.command;
    if (command === undefined) {
      throw new BackendClientError("invalid_backend_command", "Stdio backend command must not be empty.", false);
    }

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.handshakeState = "unknown";
    this.handshakeError = undefined;
    this.compatibilityReport = undefined;
    // A new child generation starts before its first hello route is charged.
    // Normal teardown calls failAll(), but keep the control subset explicit
    // here as a defensive reset for a child that never reached that path.
    this.activeControlRequestIds.clear();
    this.protocolQuarantined = false;
    this.clearQuarantineRecycleTimer();
    this.clearTombstoneRecycleTimer();
    this.tombstones.clear();
    this.quarantinedRequestIds.clear();
    // Do not reset writeTail here. If an old child has not settled its stdin
    // callback yet, new-generation writes remain bounded behind that one
    // lifecycle tail instead of creating an untracked queue.
    this.legacyTail = Promise.resolve();
    this.stderrBytes = 0;
    this.stderrTruncated = false;
    this.stdout = child.stdout;
    void this.readStdout(child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      if (this.child !== child) return;
      const bytes = Buffer.byteLength(String(chunk));
      this.stderrBytes = Math.min(MAX_BACKEND_BUFFER_LIMIT, this.stderrBytes + bytes);
      if (this.stderrBytes >= MAX_BACKEND_BUFFER_LIMIT) this.stderrTruncated = true;
    });
    child.on("error", error => {
      if (this.child !== child) return;
      this.handleProcessFailure(child, error);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      const suffix = this.stderrBytes > 0
        ? ` stderr_present=true stderr_bytes=${this.stderrBytes}${this.stderrTruncated ? " stderr_truncated=true" : ""}`
        : "";
      this.handleProcessFailure(child, new BackendClientError(
        "backend_exited",
        `Backend process exited with code ${String(code)} signal ${String(signal)}.${suffix}`,
        true
      ));
    });
  }

  private async readStdout(child: ChildProcessWithoutNullStreams): Promise<void> {
    try {
      for await (const line of readBoundedNdjsonLines(child.stdout, this.frameLimitBytes())) {
        if (this.child !== child) return;
        this.handleLine(line);
      }
      // Node emits the child exit event after stdout closes in the normal
      // process-failure path; let that authoritative lifecycle signal carry
      // the public error instead of racing it with a synthetic EOF failure.
    } catch (error) {
      if (this.child !== child) return;
      const protocolError = error instanceof BackendFrameError
        ? new BackendClientError(error.code, error.message, true)
        : new BackendClientError("invalid_backend_framing", "Backend stdout framing failed.", true);
      this.terminate(protocolError, child);
    }
  }

  private ensureHandshake(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new BackendClientError("backend_closed", "Backend transport is closed.", true));
    }
    if (this.handshakeState === "ready" || isSingleFlightState(this.handshakeState)) return Promise.resolve();
    if (this.handshakeState === "blocked") {
      return Promise.reject(this.handshakeError ?? new BackendClientError(
        "backend_hello_rejected",
        "Backend hello negotiation has blocked this backend transport.",
        false
      ));
    }
    if (this.handshakePromise !== undefined) return this.handshakePromise;

    this.start();
    const requestId = `${BACKEND_CONTROL_REQUEST_ID_PREFIX}${this.requestIdPrefix}_hello_${++this.handshakeGeneration}`;
    this.reserveRequestId(requestId, true);
    const request: BackendRequest = {
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      requestId,
      command: BACKEND_HELLO_COMMAND,
      payload: {
        protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        capabilities: {
          commands: [...REQUIRED_NEGOTIATION_COMMANDS],
          transports: ["stdio"],
          streaming: { modes: ["ndjson"], tokenDeltas: false },
          supportedProtocolVersions: [BACKEND_REQUEST_SCHEMA_VERSION],
          requestIds: { required: true, scope: "connection" },
          multiplexing: { unary: true, streams: true },
          cancellation: { supported: false, requests: false, streams: false },
          tabs: {
            stableProviderIdentity: false,
            stableBrowserIdentity: false,
            stableTabIdentity: false,
            coordinationScope: "none",
            authoritativeClaim: false,
            fencing: false,
            concurrentTabs: false,
            stableIdentity: false,
            coordination: false,
            concurrent: false
          }
        }
      }
    };

    this.handshakePromise = this.issueResponse(request, true, true)
      .then(response => {
        if (!response.ok && LEGACY_HELLO_ERROR_CODES.has(response.error.code)) {
          return this.negotiateLegacyBackend();
        }
        if (!response.ok) {
          this.compatibilityReport = blockedCompatibilityReport();
          throw new BackendClientError(response.error.code, response.error.message, response.error.recoverable);
        }
        if (!isNegotiatedHello(response.result, request.payload)) {
          this.compatibilityReport = blockedCompatibilityReport();
          throw new BackendClientError(
            "backend_hello_rejected",
            "Backend hello negotiation was malformed or did not advertise the required transport capabilities.",
            false
          );
        }
        const multiplexed = negotiatedMultiplexing(response.result);
        this.compatibilityReport = compatibilityReportFromHello(
          response.result as Record<string, unknown>,
          this.options.expectedIdentity,
          multiplexed ? "multiplexed" : "single-flight"
        );
        this.handshakeState = multiplexed ? "ready" : "single-flight";
      })
      .catch(error => {
        if (error instanceof BackendClientError && error.code === "backend_hello_rejected") {
          // A failed negotiation is not a usable legacy/modern route. Kill
          // the sidecar before caching the rejection so stray output cannot
          // keep a rejected process alive or be mistaken for a later session.
          this.terminate(error);
          this.handshakeError = error;
          this.handshakeState = "blocked";
        } else {
          this.handshakeState = "unknown";
        }
        throw error;
      })
      .finally(() => {
        this.handshakePromise = undefined;
        this.maybeRecycleQuarantined();
      });
    return this.handshakePromise;
  }

  private async negotiateLegacyBackend(): Promise<void> {
    const probes = new Map<string, BackendResponse>();
    for (const command of ["backend.version", "backend.capabilities"] as const) {
      const requestId = `${BACKEND_CONTROL_REQUEST_ID_PREFIX}${this.requestIdPrefix}_legacy_${++this.handshakeGeneration}`;
      this.reserveRequestId(requestId, true);
      const response = await this.issueResponse({
        schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        requestId,
        command,
        payload: {}
      }, true, true);
      if (!response.ok) {
        throw new BackendClientError(
          "backend_hello_rejected",
          `Legacy backend ${command} probe did not return a successful compatible result.`,
          false
        );
      }
      probes.set(command, response);
    }
    const versionProbe = probes.get("backend.version");
    const capabilitiesProbe = probes.get("backend.capabilities");
    const version = versionProbe?.ok === true ? versionProbe.result : undefined;
    const capabilities = capabilitiesProbe?.ok === true ? capabilitiesProbe.result : undefined;
    if (!isCompatibleLegacyVersion(version) || !isCompatibleLegacyCapabilities(capabilities)) {
      this.compatibilityReport = blockedCompatibilityReport();
      throw new BackendClientError(
        "backend_hello_rejected",
        "Legacy backend probes did not advertise a compatible protocol and command set.",
        false
      );
    }
    this.compatibilityReport = compatibilityReportFromLegacy(
      version as Record<string, unknown>,
      this.options.expectedIdentity
    );
    this.handshakeState = "legacy";
  }

  getCompatibilityReport(): BackendCompatibilityReport | undefined {
    return this.compatibilityReport;
  }

  private issueResponse(
    request: BackendRequest,
    fatalOnTimeout: boolean,
    handshake = false
  ): Promise<BackendResponse> {
    const requestId = requireRequestId(request);
    return new Promise<BackendResponse>((resolve, reject) => {
      const timeout = this.createDeadline(requestId, fatalOnTimeout, handshake);
      this.pendingResponses.set(requestId, { resolve, reject, timeout, fatalOnTimeout });
      void this.write(request, handshake).catch(error => {
        const pending = this.pendingResponses.get(requestId);
        if (pending === undefined) return;
        this.clearResponse(requestId, !isDefinitelyUnsentWriteError(error));
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async issueStream(
    request: BackendRequest,
    queue: AsyncQueue<BackendEvent>,
    legacyRelease?: () => void
  ): Promise<void> {
    const requestId = requireRequestId(request);
    const timeout = this.createDeadline(requestId, legacyRelease !== undefined, false);
    this.pendingStreams.set(requestId, {
      queue,
      timeout,
      fatalOnTimeout: legacyRelease !== undefined,
      ...(legacyRelease === undefined ? {} : { legacyRelease })
    });
    try {
      await this.write(request);
    } catch (error) {
      const pending = this.pendingStreams.get(requestId);
      if (pending !== undefined) {
        this.clearStream(requestId, !isDefinitelyUnsentWriteError(error));
        pending.queue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private write(request: BackendRequest, control = false): Promise<void> {
    const requestId = requireRequestId(request);
    const child = this.child;
    if (child === undefined || this.closed) {
      return Promise.reject(new BackendClientError("backend_closed", "Backend process is not running.", true));
    }
    let line: string;
    try {
      line = `${JSON.stringify(request)}\n`;
    } catch {
      return Promise.reject(new BackendClientError("invalid_backend_request", "Backend request could not be encoded as JSON.", false));
    }
    if (Buffer.byteLength(line, "utf8") > this.frameLimitBytes()) {
      return Promise.reject(new BackendClientError(
        "backend_frame_too_large",
        `Backend request frame exceeds the ${this.frameLimitBytes()} byte limit.`,
        false
      ));
    }
    let admission: WriteAdmission;
    try {
      admission = this.admitWrite(requestId, line, child);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const next = this.writeTail.then(() => {
      if (admission.released) {
        throw new BackendClientError(
          "backend_request_cancelled",
          `Backend request ${requestId} was cancelled before it could be written.`,
          true
        );
      }
      if (!control) this.assertCanIssue();
      if (this.child !== admission.child) {
        throw new BackendClientError("backend_closed", "Backend process is not running.", true);
      }
      if (!this.isWriteRouteActive(requestId)) {
        throw new BackendClientError(
          "backend_request_cancelled",
          `Backend request ${requestId} was cancelled before it could be written.`,
          true
        );
      }
      admission.started = true;
      return this.writeLine(child, line).finally(() => this.releaseWrite(admission));
    }).catch(error => {
      this.releaseWrite(admission);
      throw error;
    });
    this.writeTail = next.catch(() => {});
    return next;
  }

  private admitWrite(requestId: string, line: string, child: ChildProcessWithoutNullStreams): WriteAdmission {
    const bytes = Buffer.byteLength(line, "utf8");
    const countLimit = this.options.writeQueueLimit ?? DEFAULT_BACKEND_WRITE_QUEUE_LIMIT;
    const bytesLimit = this.options.writeQueueBytesLimit ?? DEFAULT_BACKEND_WRITE_QUEUE_BYTES_LIMIT;
    if (this.writeQueueCount >= countLimit || this.writeQueueBytes > bytesLimit - bytes) {
      throw new BackendClientError(
        "backend_write_queue_overflow",
        "Backend outbound request buffering exceeded its bounded limit.",
        true
      );
    }
    const admission: WriteAdmission = { requestId, bytes, child, started: false, released: false };
    this.activeWrites.add(admission);
    this.writeQueueCount += 1;
    this.writeQueueBytes += bytes;
    return admission;
  }

  private releaseWrite(admission: WriteAdmission): void {
    if (admission.released) return;
    admission.released = true;
    if (!this.activeWrites.delete(admission)) return;
    this.writeQueueCount = Math.max(0, this.writeQueueCount - 1);
    this.writeQueueBytes = Math.max(0, this.writeQueueBytes - admission.bytes);
    this.maybeUnblockWriteTeardown();
  }

  private retireWriteLifecycle(retiredChild: ChildProcessWithoutNullStreams): void {
    if (![...this.activeWrites].some(admission => admission.child === retiredChild)) return;
    if (this.retiredWriteTail === undefined) {
      const retiredTail = this.writeTail;
      this.retiredWriteTail = retiredTail;
      // Detach this child generation so a replacement child never inherits a
      // permanently blocked stdin callback. The detached tail remains bounded
      // by the charged admissions until its callbacks settle.
      this.writeTail = Promise.resolve();
      void retiredTail.then(
        () => this.finishRetiredWriteTail(retiredTail),
        () => this.finishRetiredWriteTail(retiredTail)
      );
      return;
    }

    // A second recycle while the detached generation is still unresolved may
    // not create another orphaned tail. Leave the current tail attached and
    // fail closed until both generations settle.
    this.recycleBlockedByWriteTeardown = true;
    void this.writeTail.then(
      () => this.maybeUnblockWriteTeardown(),
      () => this.maybeUnblockWriteTeardown()
    );
  }

  private finishRetiredWriteTail(retiredTail: Promise<void>): void {
    if (this.retiredWriteTail === retiredTail) this.retiredWriteTail = undefined;
    this.maybeUnblockWriteTeardown();
  }

  private maybeUnblockWriteTeardown(): void {
    if (!this.recycleBlockedByWriteTeardown) return;
    if (this.retiredWriteTail !== undefined || this.activeWrites.size > 0) return;
    this.recycleBlockedByWriteTeardown = false;
  }

  private isWriteRouteActive(requestId: string): boolean {
    return this.pendingResponses.has(requestId) || this.pendingStreams.has(requestId);
  }

  private hasStartedWrite(requestId: string): boolean {
    return [...this.activeWrites].some(admission => admission.requestId === requestId && admission.started);
  }

  private writeLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
    if (this.child !== child) {
      return Promise.reject(new BackendClientError("backend_closed", "Backend process is not running.", true));
    }
    if (Buffer.byteLength(line, "utf8") > this.frameLimitBytes()) {
      return Promise.reject(new BackendClientError(
        "backend_frame_too_large",
        `Backend request frame exceeds the ${this.frameLimitBytes()} byte limit.`,
        false
      ));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error): void => finish(error);
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        child.stdin.off("error", onError);
        if (error !== undefined && error !== null) reject(error);
        else resolve();
      };
      child.stdin.once("error", onError);
      try {
        child.stdin.write(line, error => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.terminate(new BackendClientError(
        "invalid_backend_json",
        "Backend emitted an invalid JSON frame.",
        true
      ));
      return;
    }

    if (!isRecord(value)) {
      this.terminate(new BackendClientError("invalid_backend_message", "Backend protocol line must be a JSON object.", true));
      return;
    }
    if (value.schemaVersion === BACKEND_RESPONSE_SCHEMA_VERSION) {
      try {
        this.handleResponse(parseBackendResponseMessage(value));
      } catch (error) {
        this.terminate(asProtocolClientError(error));
      }
      return;
    }
    if (value.schemaVersion === BACKEND_EVENT_SCHEMA_VERSION) {
      try {
        this.handleEvent(parseBackendEventMessage(value));
      } catch (error) {
        this.terminate(asProtocolClientError(error));
      }
      return;
    }
    this.terminate(new BackendClientError(
      "unsupported_backend_schema",
      "Backend emitted an unsupported protocol schema.",
      true
    ));
  }

  private handleResponse(response: BackendResponse): void {
    const requestId = response.requestId;
    if (requestId === undefined) {
      this.terminate(new BackendClientError("missing_backend_request_id", "Backend response is missing requestId.", true));
      return;
    }
    const pending = this.pendingResponses.get(requestId);
    if (pending === undefined) {
      const stream = this.pendingStreams.get(requestId);
      if (stream !== undefined) {
        this.terminate(new BackendClientError(
          "unexpected_backend_response",
          `Backend sent a response for streaming requestId ${requestId}.`,
          true
        ));
        return;
      }
      if (this.consumeTombstoneResponse(requestId)) return;
      this.discardLateOrQuarantine(requestId);
      return;
    }
    if (typeof response.ok !== "boolean") {
      this.clearResponse(requestId, true);
      pending.reject(new BackendClientError(
        "invalid_backend_response",
        `Backend response for requestId ${requestId} is missing boolean ok.`,
        true
      ));
      return;
    }
    this.clearResponse(requestId, false);
    pending.resolve(response);
  }

  private handleEvent(event: BackendEvent): void {
    const requestId = event.requestId;
    if (requestId === undefined) {
      this.terminate(new BackendClientError("missing_backend_request_id", "Backend event is missing requestId.", true));
      return;
    }
    const pending = this.pendingStreams.get(requestId);
    if (pending === undefined) {
      const response = this.pendingResponses.get(requestId);
      if (response !== undefined) {
        this.terminate(new BackendClientError(
          "unexpected_backend_event",
          `Backend sent an event for non-streaming requestId ${requestId}.`,
          true
        ));
        return;
      }
      if (this.consumeTombstoneEvent(requestId, event.type)) return;
      this.discardLateOrQuarantine(requestId);
      return;
    }
    if (typeof event.type !== "string") {
      pending.queue.fail(new BackendClientError(
        "invalid_backend_event",
        `Backend event for requestId ${requestId} is missing type.`,
        true
      ));
      this.clearStream(requestId, true);
      return;
    }
    if (!pending.queue.push(event)) {
      pending.queue.fail(new BackendClientError(
        "backend_stream_overflow",
        `Backend stream requestId ${requestId} exceeded its bounded event queue.`,
        true
      ));
      this.clearStream(requestId, true);
      return;
    }
    if (event.type === "completed") {
      pending.queue.finish();
      this.clearStream(requestId, false);
    }
    if (event.type === "error") {
      pending.queue.fail(new BackendClientError(event.error.code, event.error.message, event.error.recoverable));
      this.clearStream(requestId, false);
    }
  }

  private failAll(error: Error): void {
    // Keep active write admissions charged until their tail entries settle.
    // Clearing them here would make a blocked old-generation tail invisible
    // to the next generation and defeat the aggregate memory bound.
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingResponses.clear();
    for (const pending of this.pendingStreams.values()) {
      clearTimeout(pending.timeout);
      pending.queue.fail(error);
      pending.legacyRelease?.();
    }
    this.pendingStreams.clear();
    for (const cancelWaiting of this.waitingRequests.values()) cancelWaiting(error);
    this.waitingRequests.clear();
    for (const cancelWaiting of this.waitingStreams.values()) cancelWaiting(error);
    this.waitingStreams.clear();
    this.waitingAdmissionIds.clear();
    this.activeRequestIds.clear();
    this.activeControlRequestIds.clear();
  }

  private clearResponse(requestId: string, tombstone: boolean): void {
    const pending = this.pendingResponses.get(requestId);
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(requestId);
      this.releaseRequestId(requestId, tombstone ? "unary" : undefined);
      this.maybeRecycleQuarantined();
    }
  }

  private clearStream(requestId: string, tombstone: boolean): void {
    const pending = this.pendingStreams.get(requestId);
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      this.pendingStreams.delete(requestId);
      pending.legacyRelease?.();
      this.releaseRequestId(requestId, tombstone ? "stream" : undefined);
      this.maybeRecycleQuarantined();
    }
  }

  private createDeadline(requestId: string, fatalOnTimeout: boolean, handshake: boolean): NodeJS.Timeout {
    const timeoutMs = handshake
      ? this.options.handshakeTimeoutMs ?? DEFAULT_BACKEND_HANDSHAKE_TIMEOUT_MS
      : this.options.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
    return setTimeout(() => {
      const error = new BackendClientError(
        "backend_timeout",
        `Backend request ${requestId} timed out after ${timeoutMs}ms.`,
        true
      );
      const response = this.pendingResponses.get(requestId);
      if (response !== undefined) {
        const writeStarted = this.hasStartedWrite(requestId);
        this.clearResponse(requestId, true);
        response.reject(error);
        if (response.fatalOnTimeout || writeStarted) this.terminate(error);
        return;
      }
      const stream = this.pendingStreams.get(requestId);
      if (stream !== undefined) {
        const writeStarted = this.hasStartedWrite(requestId);
        this.clearStream(requestId, true);
        stream.queue.fail(error);
        if (stream.fatalOnTimeout || writeStarted) this.terminate(error);
      }
    }, timeoutMs);
  }

  private acquireLegacySlot(): Promise<() => void> {
    const previous = this.legacyTail;
    let releasePrevious!: () => void;
    this.legacyTail = new Promise<void>(resolve => {
      releasePrevious = resolve;
    });
    return previous.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releasePrevious();
      };
    });
  }

  private reserveWaitingAdmission(requestId: string): void {
    this.validateRequestId(requestId);
    this.assertAdmissionCapacity(false);
    this.waitingAdmissionIds.add(requestId);
  }

  private releaseWaitingAdmission(requestId: string): void {
    this.waitingAdmissionIds.delete(requestId);
  }

  private promoteWaitingAdmission(requestId: string): void {
    if (!this.waitingAdmissionIds.delete(requestId)) {
      throw new BackendClientError(
        "backend_request_cancelled",
        `Backend request ${requestId} was cancelled before it could be issued.`,
        true
      );
    }
    try {
      this.reserveRequestId(requestId);
    } catch (error) {
      // Keep the admission state truthful if promotion fails after the
      // caller's waiting slot has been removed.
      this.releaseRequestId(requestId, undefined);
      throw error;
    }
  }

  private reserveRequestId(requestId: string, control = false): void {
    this.pruneIdState();
    this.validateRequestId(requestId, control);
    this.assertAdmissionCapacity(control);
    this.activeRequestIds.add(requestId);
    if (control) this.activeControlRequestIds.add(requestId);
  }

  private validateRequestId(requestId: string, control = false): void {
    if (this.closed) {
      throw new BackendClientError("backend_closed", "Backend transport is closed.", true);
    }
    if (!isValidBackendRequestId(requestId)) {
      throw new BackendClientError(
        "invalid_request_id",
        "Backend requestId must be a bounded, non-empty string without control characters.",
        false
      );
    }
    if (!control && requestId.startsWith(BACKEND_CONTROL_REQUEST_ID_PREFIX)) {
      throw new BackendClientError(
        "reserved_request_id",
        "Backend requestId uses a transport-reserved control namespace.",
        false
      );
    }
    if (this.protocolQuarantined) {
      throw new BackendClientError(
        "backend_protocol_quarantined",
        "Backend transport is quarantined after an unknown requestId; wait for it to recycle before sending new work.",
        true
      );
    }
    if (this.activeRequestIds.has(requestId)) {
      throw new BackendClientError(
        "duplicate_request_id",
        `Backend requestId ${requestId} is already active.`,
        false
      );
    }
    if (this.waitingAdmissionIds.has(requestId)) {
      throw new BackendClientError(
        "duplicate_request_id",
        `Backend requestId ${requestId} is already waiting for admission.`,
        false
      );
    }
    if (this.tombstones.has(requestId)) {
      throw new BackendClientError(
        "request_id_reused",
        `Backend requestId ${requestId} was recently completed or cancelled and cannot be reused yet.`,
        false
      );
    }
    if (this.quarantinedRequestIds.has(requestId)) {
      throw new BackendClientError(
        "request_id_quarantined",
        `Backend requestId ${requestId} was quarantined after an unknown backend message and cannot be reused yet.`,
        false
      );
    }
  }

  private assertAdmissionCapacity(control = false): void {
    // Before the first handshake control route exists, leave one aggregate
    // slot free for that route. This matters for streams, whose handshake is
    // deliberately deferred to a microtask and can therefore have multiple
    // callers reserved synchronously. The same virtual slot is restored
    // between sequential legacy probes. Once a control route is active (or
    // negotiation has completed), caller routes use the full configured bound.
    const limit = !control
      && this.handshakeState === "unknown"
      && this.activeControlRequestIds.size === 0
      ? this.maxInFlight() - 1
      : this.maxInFlight();
    if (this.waitingAdmissionIds.size + this.activeRequestIds.size >= limit) {
      throw new BackendClientError(
        "backend_in_flight_limit",
        "Backend transport reached its bounded in-flight route limit.",
        true
      );
    }
  }

  private releaseRequestId(requestId: string, tombstone: TombstoneKind | undefined): void {
    this.activeRequestIds.delete(requestId);
    this.activeControlRequestIds.delete(requestId);
    if (tombstone === undefined) return;
    const kind = tombstone;
    if (this.tombstones.size >= this.tombstoneLimit() && !this.tombstones.has(requestId)) {
      this.terminate(new BackendClientError(
        "backend_tombstone_limit",
        "Backend transport recycled because its late-output tombstone bound was reached.",
        true
      ));
      return;
    }
    this.tombstones.set(requestId, {
      kind,
      expiresAt: Date.now() + this.lateOutputGraceMs()
    });
    this.scheduleTombstoneRecycle();
  }

  private discardLateOrQuarantine(requestId: string): void {
    this.pruneIdState();
    if (this.tombstones.has(requestId) || this.quarantinedRequestIds.has(requestId)) return;
    if (this.quarantinedRequestIds.size >= this.quarantineLimit()) {
      this.terminate(new BackendClientError(
        "backend_quarantine_limit",
        "Backend transport recycled because its unknown-requestId quarantine bound was reached.",
        true
      ));
      return;
    }
    this.quarantinedRequestIds.set(requestId, Date.now() + this.lateOutputGraceMs());
    this.protocolQuarantined = true;
    this.scheduleQuarantineRecycle();
  }

  private consumeTombstoneResponse(requestId: string): boolean {
    const route = this.tombstones.get(requestId);
    if (route === undefined) return false;
    if (route.kind !== "unary") {
      this.terminate(new BackendClientError(
        "unexpected_backend_response",
        `Backend sent a unary response for tombstoned stream requestId ${requestId}.`,
        true
      ));
      return true;
    }
    this.tombstones.delete(requestId);
    this.clearTombstoneRecycleTimer();
    this.scheduleTombstoneRecycleIfNeeded();
    return true;
  }

  private consumeTombstoneEvent(requestId: string, type: BackendEvent["type"]): boolean {
    const route = this.tombstones.get(requestId);
    if (route === undefined) return false;
    if (route.kind !== "stream") {
      this.terminate(new BackendClientError(
        "unexpected_backend_event",
        `Backend sent a stream event for tombstoned unary requestId ${requestId}.`,
        true
      ));
      return true;
    }
    if (type === "completed" || type === "error") {
      this.tombstones.delete(requestId);
      this.clearTombstoneRecycleTimer();
      this.scheduleTombstoneRecycleIfNeeded();
    }
    return true;
  }

  private lateOutputGraceMs(): number {
    return this.options.lateOutputGraceMs ?? DEFAULT_BACKEND_LATE_OUTPUT_GRACE_MS;
  }

  private tombstoneLimit(): number {
    return this.options.tombstoneLimit ?? DEFAULT_BACKEND_TOMBSTONE_LIMIT;
  }

  private quarantineLimit(): number {
    return this.options.quarantineLimit ?? DEFAULT_BACKEND_QUARANTINE_LIMIT;
  }

  private frameLimitBytes(): number {
    return this.options.frameLimitBytes ?? BACKEND_NDJSON_FRAME_LIMIT_BYTES;
  }

  private maxInFlight(): number {
    return this.options.maxInFlight ?? DEFAULT_BACKEND_MAX_IN_FLIGHT;
  }

  private assertCanIssue(): void {
    if (this.closed) {
      throw new BackendClientError("backend_closed", "Backend transport is closed.", true);
    }
    if (this.protocolQuarantined) {
      throw new BackendClientError(
        "backend_protocol_quarantined",
        "Backend transport is quarantined after an unknown requestId; wait for it to recycle before sending new work.",
        true
      );
    }
    if (this.handshakeState === "blocked") {
      throw this.handshakeError ?? new BackendClientError(
        "backend_hello_rejected",
        "Backend hello negotiation has blocked this backend transport.",
        false
      );
    }
    if (this.child === undefined) {
      throw new BackendClientError("backend_closed", "Backend process is not running.", true);
    }
  }

  private scheduleTombstoneRecycle(): void {
    if (this.tombstoneRecycleTimer !== undefined) return;
    const nextExpiry = Math.min(...[...this.tombstones.values()].map(route => route.expiresAt));
    const delay = Math.max(1, nextExpiry - Date.now());
    this.tombstoneRecycleTimer = setTimeout(() => {
      this.tombstoneRecycleTimer = undefined;
      const expired = [...this.tombstones.values()].some(route => route.expiresAt <= Date.now());
      if (expired) {
        this.terminate(new BackendClientError(
          "backend_late_output_timeout",
          "Backend transport recycled because a timed-out or cancelled route did not produce its terminal output within the bounded grace period.",
          true
        ));
        return;
      }
      this.scheduleTombstoneRecycle();
    }, delay);
    this.tombstoneRecycleTimer.unref?.();
  }

  private scheduleTombstoneRecycleIfNeeded(): void {
    if (this.tombstones.size === 0) return;
    this.scheduleTombstoneRecycle();
  }

  private clearTombstoneRecycleTimer(): void {
    if (this.tombstoneRecycleTimer === undefined) return;
    clearTimeout(this.tombstoneRecycleTimer);
    this.tombstoneRecycleTimer = undefined;
  }

  private scheduleQuarantineRecycle(): void {
    if (this.quarantineRecycleTimer === undefined) {
      this.quarantineRecycleTimer = setTimeout(() => {
        this.quarantineRecycleTimer = undefined;
        this.recycleQuarantinedTransport();
      }, this.lateOutputGraceMs());
      this.quarantineRecycleTimer.unref?.();
    }
    this.maybeRecycleQuarantined();
  }

  private maybeRecycleQuarantined(): void {
    if (!this.protocolQuarantined || this.handshakePromise !== undefined) return;
    if (this.pendingResponses.size > 0
      || this.pendingStreams.size > 0
      || this.waitingRequests.size > 0
      || this.waitingStreams.size > 0) return;
    this.recycleQuarantinedTransport();
  }

  private recycleQuarantinedTransport(): void {
    if (!this.protocolQuarantined) return;
    this.protocolQuarantined = false;
    this.clearQuarantineRecycleTimer();
    const child = this.child;
    if (child !== undefined) {
      this.terminate(new BackendClientError(
        "backend_protocol_quarantined",
        "Backend transport was recycled after an unknown requestId.",
        true
      ), child);
    }
  }

  private clearQuarantineRecycleTimer(): void {
    if (this.quarantineRecycleTimer === undefined) return;
    clearTimeout(this.quarantineRecycleTimer);
    this.quarantineRecycleTimer = undefined;
  }

  private pruneIdState(): void {
    // Tombstones are safety routes, not cache entries. They are removed only
    // by the expected late terminal message or by process recycle.
  }

  private handleProcessFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.stdout?.destroy();
    this.stdout = undefined;
    this.handshakeState = "unknown";
    this.handshakeError = undefined;
    this.protocolQuarantined = false;
    this.clearQuarantineRecycleTimer();
    this.clearTombstoneRecycleTimer();
    this.tombstones.clear();
    this.quarantinedRequestIds.clear();
    this.retireWriteLifecycle(child);
    this.failAll(error);
  }

  private terminate(error: Error, expectedChild = this.child): void {
    const child = expectedChild;
    if (child === undefined) {
      this.failAll(error);
      return;
    }
    if (this.child === child) {
      this.child = undefined;
      this.stdout?.destroy();
      this.stdout = undefined;
      this.handshakeState = "unknown";
      this.handshakeError = undefined;
      this.retireWriteLifecycle(child);
    }
    this.protocolQuarantined = false;
    this.clearQuarantineRecycleTimer();
    this.clearTombstoneRecycleTimer();
    this.tombstones.clear();
    this.quarantinedRequestIds.clear();
    child.removeAllListeners("error");
    child.removeAllListeners("exit");
    child.kill();
    this.failAll(error);
  }
}

function unwrapResponse<TResult>(response: BackendResponse): TResult {
  if (response.ok) return response.result as TResult;
  throw new BackendClientError(response.error.code, response.error.message, response.error.recoverable);
}

function attachOperationCompatibility(
  result: OperationInspectWireResult,
  transport: BackendTransport
): OperationInspectWireResult {
  const report = transport.getCompatibilityReport?.();
  if (report === undefined) return result;
  try {
    return {
      ...result,
      compatibility: validateBackendCompatibilityReport(report)
    };
  } catch {
    return result;
  }
}

function attachDoctorCompatibility(
  result: CommandResult<DoctorReport>,
  args: DoctorArgs | undefined,
  report: BackendCompatibilityReport | undefined
): CommandResult<DoctorReport> {
  if (report === undefined || (args?.check !== undefined && !args.check.includes("compatibility"))) return result;
  if (result.data === undefined) return result;
  const check = compatibilityCheckFromReport(report);
  return {
    ...result,
    data: {
      ...result.data,
      checks: { ...result.data.checks, compatibility: check },
      ready: result.data.ready && check.status !== "blocked"
    }
  };
}

function compatibilityCheckFromReport(report: BackendCompatibilityReport): NonNullable<DoctorReport["checks"]["compatibility"]> {
  const warning = report.warnings[0];
  return {
    status: report.status === "blocked" ? "blocked" : report.status === "warning" ? "unknown" : report.status === "compatible" ? "ok" : "unknown",
    message: warning?.message ?? "Backend protocol and advertised capabilities are compatible.",
    ...(warning?.code === undefined ? {} : { code: warning.code }),
    details: report
  };
}

function parseOperationResult<TResult>(
  value: unknown,
  validator: (candidate: unknown) => TResult
): TResult {
  try {
    return validator(value);
  } catch {
    // Result validation errors must not leak provider text, prompts, paths, or
    // opaque journal diagnostics through the backend facade.
    throw new BackendClientError(
      "invalid_operation_result",
      "Backend returned an invalid transactional operation result.",
      true
    );
  }
}

function validateOperationSubmitRequest(value: unknown): asserts value is OperationSubmitRequestV1 {
  validateOperationRequestForClient(value, validateWireSubmitRequest);
}

function validateOperationCollectRequest(value: unknown): asserts value is OperationCollectRequestV1 {
  validateOperationRequestForClient(value, validateWireCollectRequest);
}

function validateOperationInspectRequest(value: unknown): asserts value is OperationInspectRequestV1 {
  validateOperationRequestForClient(value, validateWireInspectRequest);
}

function validateOperationControlRequest(value: unknown): asserts value is OperationControlRequestV1 {
  validateOperationRequestForClient(value, validateWireControlRequest);
}

function validateOperationRequestForClient(value: unknown, validator: (candidate: unknown) => void): void {
  try {
    validator(value);
  } catch (error) {
    if (error instanceof OperationWireRequestError) throw invalidOperationRequest();
    throw error;
  }
}

function invalidOperationRequest(): BackendClientError {
  return new BackendClientError(
    "invalid_operation_request",
    "Transactional operation request is invalid.",
    false
  );
}

function streamFromBackendEvents<TOutput>(
  events: AsyncIterable<BackendEvent>,
  onReturn?: () => boolean | void
): ChatGPTRunStream<TOutput> {
  let returnRequested = false;
  let sourceReturned = false;
  const sourceIterator = events[Symbol.asyncIterator]();
  const returnSource = (): void => {
    if (sourceReturned) return;
    sourceReturned = true;
    try {
      const result = sourceIterator.return?.();
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      // A source iterator's cleanup must not turn caller cancellation into a
      // second observable stream failure.
    }
  };
  const cancel = (): void => {
    if (returnRequested) return;
    returnRequested = true;
    onReturn?.();
    returnSource();
  };
  const queue = new AsyncQueue<ChatGPTRunStreamEvent>(
    DEFAULT_BACKEND_STREAM_QUEUE_LIMIT,
    cancel,
    DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT
  );
  let resolveCompleted!: (result: ChatGPTRunResult<TOutput>) => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<ChatGPTRunResult<TOutput>>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  void (async () => {
    try {
      while (true) {
        const next = await sourceIterator.next();
        if (next.done) break;
        const event = next.value;
        if (event.type === "run_item_stream_event") {
          if (!queue.push({
            type: "run_item_stream_event",
            name: event.name as ChatGPTRunStreamEvent["name"],
            item: event.item as ChatGPTRunStreamEvent["item"]
          })) {
            cancel();
            throw new BackendClientError(
              "backend_stream_overflow",
              "High-level backend stream buffering exceeded its bounded event queue.",
              true
            );
          }
          continue;
        }
        if (event.type === "completed") {
          resolveCompleted(event.result as ChatGPTRunResult<TOutput>);
          queue.finish();
          returnSource();
          return;
        }
        if (event.type === "error") {
          throw new BackendClientError(event.error.code, event.error.message, event.error.recoverable);
        }
      }
      throw new BackendClientError("stream_incomplete", "Backend stream ended before a completed event.", true);
    } catch (error) {
      returnSource();
      queue.fail(error);
      rejectCompleted(error);
    }
  })();

  return {
    completed,
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator]()
  };
}

function requireRequestId(request: BackendRequest): string {
  if (typeof request.requestId !== "string" || request.requestId.length === 0) {
    throw new BackendClientError("missing_request_id", "Backend transport requests require requestId.", false);
  }
  if (!isValidBackendRequestId(request.requestId)) {
    throw new BackendClientError("invalid_request_id", "Backend transport requestId is malformed or exceeds its bound.", false);
  }
  return request.requestId;
}

function parseBackendResponseMessage(value: Record<string, unknown>): BackendResponse {
  requireExactSchema(value, BACKEND_RESPONSE_SCHEMA_VERSION, "response");
  const requestId = requireMessageRequestId(value);
  const ok = value.ok;
  if (typeof ok !== "boolean") {
    throw new BackendClientError("invalid_backend_response", "Backend response ok must be a boolean.", true);
  }
  if (ok) {
    ensureAllowedKeys(value, ["schemaVersion", "requestId", "ok", "result"]);
    if (!Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) {
      throw new BackendClientError(
        "invalid_backend_response",
        `Backend response for requestId ${requestId} must contain exactly one result branch.`,
        true
      );
    }
    return value as BackendResponse;
  }
  ensureAllowedKeys(value, ["schemaVersion", "requestId", "ok", "error"]);
  if (!isRecord(value.error)
    || typeof value.error.code !== "string"
    || value.error.code.length === 0
    || typeof value.error.message !== "string"
    || value.error.message.length === 0
    || typeof value.error.recoverable !== "boolean"
    || Object.hasOwn(value, "result")) {
    throw new BackendClientError(
      "invalid_backend_response",
      `Backend error payload for requestId ${requestId} is malformed.`,
      true
    );
  }
  ensureAllowedKeys(value.error, ["code", "message", "recoverable"]);
  return value as BackendResponse;
}

function parseBackendEventMessage(value: Record<string, unknown>): BackendEvent {
  requireExactSchema(value, BACKEND_EVENT_SCHEMA_VERSION, "event");
  const requestId = requireMessageRequestId(value);
  const type = value.type;
  if (typeof type !== "string") {
    throw new BackendClientError("invalid_backend_event", `Backend event for requestId ${requestId} is missing type.`, true);
  }
  switch (type) {
    case "run_item_stream_event":
      ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "name", "item"]);
      if (typeof value.name !== "string"
        || value.name.length === 0
        || !isRecord(value.item)) {
        throw new BackendClientError(
          "invalid_backend_event",
          `Backend run-item event for requestId ${requestId} is malformed.`,
          true
        );
      }
      break;
    case "agent_updated_stream_event":
      ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "agent"]);
      if (!isRecord(value.agent)) {
        throw new BackendClientError(
          "invalid_backend_event",
          `Backend agent-update event for requestId ${requestId} is malformed.`,
          true
        );
      }
      break;
    case "completed":
      ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "result"]);
      if (!Object.hasOwn(value, "result")) {
        throw new BackendClientError(
          "invalid_backend_event",
          `Backend completed event for requestId ${requestId} is missing result.`,
          true
        );
      }
      break;
    case "error":
      ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "error"]);
      if (!isRecord(value.error)
        || typeof value.error.code !== "string"
        || value.error.code.length === 0
        || typeof value.error.message !== "string"
        || value.error.message.length === 0
        || typeof value.error.recoverable !== "boolean") {
        throw new BackendClientError(
          "invalid_backend_event",
          `Backend error event for requestId ${requestId} is malformed.`,
          true
        );
      }
      ensureAllowedKeys(value.error, ["code", "message", "recoverable"]);
      break;
    default:
      throw new BackendClientError(
        "invalid_backend_event",
        `Backend event for requestId ${requestId} has unsupported type ${type}.`,
        true
      );
  }
  return value as BackendEvent;
}

function requireExactSchema(value: Record<string, unknown>, schemaVersion: string, kind: string): void {
  if (value.schemaVersion !== schemaVersion) {
    throw new BackendClientError(
      "unsupported_backend_schema",
      `Backend emitted an unsupported ${kind} protocol schema.`,
      true
    );
  }
}

function requireMessageRequestId(value: Record<string, unknown>): string {
  if (!isValidBackendRequestId(value.requestId)) {
    throw new BackendClientError("missing_backend_request_id", "Backend protocol message requires a bounded requestId.", true);
  }
  return value.requestId;
}

function ensureAllowedKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) {
    throw new BackendClientError("invalid_backend_message", "Backend protocol message contains unsupported fields.", true);
  }
}

function isBoundedIdentityField(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_BACKEND_IDENTITY_FIELD_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function asProtocolClientError(error: unknown): BackendClientError {
  if (error instanceof BackendClientError) return error;
  return new BackendClientError("invalid_backend_message", "Backend protocol message validation failed.", true);
}

function isCompatibleLegacyVersion(value: unknown): boolean {
  return isRecord(value)
    && value.protocolVersion === BACKEND_REQUEST_SCHEMA_VERSION
    && typeof value.name === "string"
    && value.name.length > 0
    && typeof value.runtime === "string"
    && value.runtime.length > 0;
}

function isCompatibleLegacyCapabilities(value: unknown): boolean {
  if (!isRecord(value)
    || value.protocolVersion !== BACKEND_REQUEST_SCHEMA_VERSION
    || !Array.isArray(value.commands)
    || value.commands.some(command => typeof command !== "string")) return false;
  const commands = value.commands as string[];
  const requiredCommands = [
    "backend.version",
    "backend.health",
    "backend.capabilities",
    "runner.run",
    "runner.stream"
  ];
  if (requiredCommands.some(command => !commands.includes(command))) return false;
  if (!Array.isArray(value.transports)
    || value.transports.some(transport => transport !== "stdio" && transport !== "http")
    || !value.transports.includes("stdio")) return false;
  return isRecord(value.streaming)
    && Array.isArray(value.streaming.modes)
    && value.streaming.modes.every(mode => mode === "ndjson" || mode === "sse")
    && value.streaming.modes.includes("ndjson")
    && value.streaming.tokenDeltas === false;
}

function isNegotiatedHello(value: unknown, requestPayload: Record<string, unknown>): value is {
  accepted: true;
  capabilities: Record<string, unknown>;
} {
  if (!isRecord(value) || value.accepted !== true || !isRecord(value.capabilities)) return false;
  const identityFields = [
    "backendSessionId",
    "packageName",
    "packageVersion",
    "runtime",
    "runtimeVersion",
    "buildDigest",
    "protocolVersion"
  ];
  if (identityFields.some(field => !isBoundedIdentityField(value[field]))) return false;

  const capabilities = value.capabilities;
  if (capabilities.protocolVersion !== BACKEND_REQUEST_SCHEMA_VERSION) return false;
  if (value.protocolVersion !== capabilities.protocolVersion
    || value.backendSessionId !== capabilities.backendSessionId
    || value.packageName !== capabilities.packageName
    || value.packageVersion !== capabilities.packageVersion
    || value.runtime !== capabilities.runtime
    || value.runtimeVersion !== capabilities.runtimeVersion
    || value.buildDigest !== capabilities.buildDigest) return false;
  if (!Array.isArray(capabilities.supportedProtocolVersions)
    || !capabilities.supportedProtocolVersions.includes(BACKEND_REQUEST_SCHEMA_VERSION)) return false;
  if (["backendSessionId", "packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest"]
    .some(field => !isBoundedIdentityField(capabilities[field]))) return false;
  const requestedCapabilities = requestPayload.capabilities;
  if (!isRecord(requestedCapabilities)) return false;
  const supportedCommands = capabilities.commands;
  const requestedCommands = requestedCapabilities.commands;
  if (!Array.isArray(supportedCommands)
    || supportedCommands.length === 0
    || supportedCommands.some(command => typeof command !== "string")
    || !Array.isArray(requestedCommands)
    || requestedCommands.some(command => typeof command !== "string" || !supportedCommands.includes(command))) return false;
  if (!Array.isArray(capabilities.transports)
    || capabilities.transports.some(transport => transport !== "stdio" && transport !== "http")
    || !capabilities.transports.includes("stdio")) return false;
  if (!isRecord(capabilities.streaming)
    || !Array.isArray(capabilities.streaming.modes)
    || capabilities.streaming.modes.some(mode => mode !== "ndjson" && mode !== "sse")
    || !capabilities.streaming.modes.includes("ndjson")
    || capabilities.streaming.tokenDeltas !== false) return false;

  const requestIds = capabilities.requestIds;
  if (!isRecord(requestIds)
    || requestIds.required !== true
    || (requestIds.scope !== "connection" && requestIds.scope !== "process")) return false;
  const multiplexing = capabilities.multiplexing;
  if (!isRecord(multiplexing)
    || typeof multiplexing.unary !== "boolean"
    || typeof multiplexing.streams !== "boolean") return false;
  const cancellation = capabilities.cancellation;
  if (!isRecord(cancellation)
    || typeof cancellation.supported !== "boolean"
    || typeof cancellation.requests !== "boolean"
    || typeof cancellation.streams !== "boolean") return false;
  const tabs = capabilities.tabs;
  if (!isRecord(tabs)
    || typeof tabs.stableProviderIdentity !== "boolean"
    || typeof tabs.stableBrowserIdentity !== "boolean"
    || typeof tabs.stableTabIdentity !== "boolean"
    || (tabs.coordinationScope !== "none" && tabs.coordinationScope !== "process" && tabs.coordinationScope !== "provider")
    || typeof tabs.authoritativeClaim !== "boolean"
    || typeof tabs.fencing !== "boolean"
    || typeof tabs.concurrentTabs !== "boolean"
    || !consistentDeprecatedTabAliases(tabs)) return false;
  return true;
}

function negotiatedMultiplexing(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.capabilities) || !isRecord(value.capabilities.multiplexing)) return false;
  return value.capabilities.multiplexing.unary === true && value.capabilities.multiplexing.streams === true;
}

function consistentDeprecatedTabAliases(tabs: Record<string, unknown>): boolean {
  const expectedStableIdentity = tabs.stableProviderIdentity === true
    && tabs.stableBrowserIdentity === true
    && tabs.stableTabIdentity === true;
  const expectedCoordination = tabs.coordinationScope !== "none";
  const expectedConcurrent = tabs.concurrentTabs === true;
  return (tabs.stableIdentity === undefined || tabs.stableIdentity === expectedStableIdentity)
    && (tabs.coordination === undefined || tabs.coordination === expectedCoordination)
    && (tabs.concurrent === undefined || tabs.concurrent === expectedConcurrent);
}

type PendingResponse = {
  resolve: (response: BackendResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  fatalOnTimeout: boolean;
};

type WriteAdmission = {
  requestId: string;
  bytes: number;
  child: ChildProcessWithoutNullStreams;
  started: boolean;
  released: boolean;
};

type PendingStream = {
  queue: AsyncQueue<BackendEvent>;
  timeout: NodeJS.Timeout;
  fatalOnTimeout: boolean;
  legacyRelease?: () => void;
};

type WaitingCancellation = (error: Error) => boolean;

type TombstoneKind = "unary" | "stream";

type TombstoneRoute = {
  kind: TombstoneKind;
  expiresAt: number;
};

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<() => void> = [];
  private queuedBytes = 0;
  private done = false;
  private error: unknown;
  private returnCalled = false;

  constructor(
    private readonly maxValues = Number.POSITIVE_INFINITY,
    private readonly onReturn?: () => void,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: T) => number = boundedValueBytes
  ) {}

  push(value: T): boolean {
    if (this.done || this.error !== undefined) return false;
    if (this.values.length >= this.maxValues) return false;
    const valueBytes = this.sizeOf(value);
    if (!Number.isFinite(valueBytes) || valueBytes < 0 || this.queuedBytes > this.maxBytes - valueBytes) return false;
    this.values.push(value);
    this.queuedBytes += valueBytes;
    this.wake();
    return true;
  }

  finish(): void {
    if (this.done || this.error !== undefined) return;
    this.done = true;
    this.wake();
  }

  fail(error: unknown): void {
    if (this.done || this.error !== undefined) return;
    this.values.length = 0;
    this.queuedBytes = 0;
    this.error = error;
    this.wake();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: () => this.nextValue(),
      return: async () => {
        if (!this.returnCalled) {
          this.returnCalled = true;
          this.onReturn?.();
        }
        this.values.length = 0;
        this.queuedBytes = 0;
        this.done = true;
        this.wake();
        return { done: true, value: undefined as never };
      },
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  }

  private async nextValue(): Promise<IteratorResult<T>> {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) {
        this.queuedBytes = Math.max(0, this.queuedBytes - this.sizeOf(value));
        return { done: false, value };
      }
      if (this.error !== undefined) throw this.error;
      if (this.done) return { done: true, value: undefined as never };
      await new Promise<void>(resolve => {
        this.waiters.push(resolve);
      });
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

function boundedValueBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSingleFlightState(state: "unknown" | "ready" | "single-flight" | "legacy" | "blocked"): boolean {
  return state === "single-flight" || state === "legacy";
}

function isDefinitelyUnsentWriteError(error: unknown): boolean {
  return error instanceof BackendClientError
    && (error.code === "backend_frame_too_large"
      || error.code === "invalid_backend_request"
      || error.code === "backend_protocol_quarantined"
      || error.code === "backend_closed"
      || error.code === "backend_write_queue_overflow"
      || error.code === "backend_request_cancelled");
}

class BackendFrameError extends Error {
  constructor(
    public readonly code: "backend_frame_too_large" | "backend_unterminated_frame" | "backend_invalid_encoding",
    message: string
  ) {
    super(message);
    this.name = "BackendFrameError";
  }
}

async function* readBoundedNdjsonLines(input: Readable, limitBytes: number): AsyncIterable<string> {
  let buffered = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    buffered = buffered.length === 0 ? Buffer.from(bytes) : Buffer.concat([buffered, bytes]);
    let newlineIndex = buffered.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const frame = buffered.subarray(0, newlineIndex);
      buffered = buffered.subarray(newlineIndex + 1);
      if (frame.length > limitBytes) {
        throw new BackendFrameError(
          "backend_frame_too_large",
          `Backend frame exceeds the ${limitBytes} byte limit.`
        );
      }
      const body = frame.length > 0 && frame[frame.length - 1] === 0x0d
        ? frame.subarray(0, frame.length - 1)
        : frame;
      try {
        yield decoder.decode(body);
      } catch {
        throw new BackendFrameError("backend_invalid_encoding", "Backend stdout contained invalid UTF-8.");
      }
      newlineIndex = buffered.indexOf(0x0a);
    }
    if (buffered.length > limitBytes) {
      throw new BackendFrameError(
        "backend_frame_too_large",
        `Backend frame exceeds the ${limitBytes} byte limit.`
      );
    }
  }
  if (buffered.length > 0) {
    throw new BackendFrameError(
      "backend_unterminated_frame",
      "Backend stdout ended with an unterminated NDJSON frame."
    );
  }
}

function validateTransportOptions(options: StdioBackendTransportOptions): void {
  if (!Array.isArray(options.command)
    || options.command.length === 0
    || options.command.some(part => typeof part !== "string")
    || options.command[0]?.trim().length === 0) {
    throw new BackendClientError("invalid_backend_options", "Stdio backend command must contain a non-empty executable.", false);
  }
  for (const [name, value] of [
    ["timeoutMs", options.timeoutMs],
    ["handshakeTimeoutMs", options.handshakeTimeoutMs],
    ["maxInFlight", options.maxInFlight],
    ["streamQueueLimit", options.streamQueueLimit],
    ["streamQueueBytesLimit", options.streamQueueBytesLimit],
    ["writeQueueLimit", options.writeQueueLimit],
    ["writeQueueBytesLimit", options.writeQueueBytesLimit],
    ["lateOutputGraceMs", options.lateOutputGraceMs],
    ["tombstoneLimit", options.tombstoneLimit],
    ["quarantineLimit", options.quarantineLimit],
    ["frameLimitBytes", options.frameLimitBytes]
  ] as const) {
    const max = name === "timeoutMs" || name === "handshakeTimeoutMs" || name === "lateOutputGraceMs"
      ? MAX_BACKEND_TIMER_MS
      : name === "frameLimitBytes" ? BACKEND_NDJSON_FRAME_LIMIT_BYTES
        : name === "streamQueueBytesLimit" ? MAX_BACKEND_STREAM_QUEUE_BYTES_LIMIT
          : name === "writeQueueBytesLimit" ? MAX_BACKEND_WRITE_QUEUE_BYTES_LIMIT
          : MAX_BACKEND_BUFFER_LIMIT;
    const minimum = name === "maxInFlight" ? MIN_BACKEND_IN_FLIGHT_LIMIT : 1;
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > max)) {
      throw new BackendClientError(
        "invalid_backend_options",
        `Stdio backend option ${name} must be a safe integer at least ${minimum}.`,
        false
      );
    }
  }
  if (options.expectedIdentity !== undefined) {
    if (options.expectedIdentity === null || typeof options.expectedIdentity !== "object" || Array.isArray(options.expectedIdentity)) {
      throw new BackendClientError("invalid_backend_options", "Stdio backend expectedIdentity must be an object.", false);
    }
    const allowed = new Set(["backendSessionId", "packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest"]);
    if (Object.keys(options.expectedIdentity).some(key => !allowed.has(key))) {
      throw new BackendClientError("invalid_backend_options", "Stdio backend expectedIdentity contains unsupported fields.", false);
    }
    for (const value of Object.values(options.expectedIdentity)) {
      if (!isBoundedIdentityField(value)) {
        throw new BackendClientError("invalid_backend_options", "Stdio backend expectedIdentity fields must be bounded strings.", false);
      }
    }
  }
}
