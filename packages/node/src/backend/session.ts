import { randomUUID } from "node:crypto";
import { createChatGPT, type ChatGPTClient, type ChatGPTClientOptions } from "../client.js";
import type { ChatGPTAgentConfig, ChatGPTRunInput } from "../runner/types.js";
import type { OperationClientSubmitOptions, OperationClientCollectOptions, OperationClientControlOptions } from "../operations/client.js";
import type { OperationSubmitResult, OperationInspectResult } from "../operations/service.js";
import type { CollectorResult } from "../operations/collector.js";
import type { ControlResult } from "../operations/control.js";
import type {
  OperationCollectRequestV1,
  OperationControlRequestV1,
  OperationHandleV1,
  OperationInspectRequestV1,
  OperationSubmitRequestV1
} from "../operations/types.js";
import {
  toOperationCollectWireResult,
  toOperationControlWireResult,
  toOperationInspectWireResult,
  toOperationSubmitWireResult
} from "../operations/wire-results.js";
import {
  OperationWireRequestError,
  validateOperationCollectRequest as validateWireCollectRequest,
  validateOperationControlRequest as validateWireControlRequest,
  validateOperationInspectRequest as validateWireInspectRequest,
  validateOperationSubmitRequest as validateWireSubmitRequest
} from "../operations/wire-requests.js";
import {
  assertOperationAwareDispatchAllowed,
  classifyCommandRouting,
  commandRoutingDisposition,
  CommandRoutingError
} from "../runtime/command-routing.js";
import type {
  ArtifactDownloadArgs,
  ArtifactWaitArgs,
  CopyResponseArgs,
  CommandResult,
  DownloadLatestArgs,
  ListArtifactsArgs,
  ReadLatestArgs,
  SequencePlan
} from "../types.js";
import {
  BACKEND_REQUEST_SCHEMA_VERSION,
  backendCommands,
  backendResponseError,
  backendEvent,
  backendEventCompleted,
  backendResponseOk,
  ProtocolError,
  type BackendEvent,
  type BackendCapabilities,
  type BackendCommand,
  type BackendRuntimeIdentity,
  type BackendRequest,
  type BackendResponse
} from "./protocol.js";

// A stdio backend process owns one identity. BackendSession objects created by
// that process share it unless an embedding explicitly injects a diagnostic
// identity (for example, a test or a separately fenced runtime).
const PROCESS_BACKEND_SESSION_ID = randomUUID();
const MAX_IDENTITY_FIELD_LENGTH = 512;

export type BackendSessionOptions = ChatGPTClientOptions & {
  /**
   * Optional build metadata injected by a packaged backend. Unknown values are
   * deliberately retained as "unknown" instead of being guessed.
   */
  backendIdentity?: Partial<Omit<BackendRuntimeIdentity, "protocolVersion" | "runtime">>;
};

/**
 * Structural declaration keeps this backend lane additive while the public
 * ChatGPTClient facade is assembled. The actual object is created once by
 * createChatGPT and owns the stable journal/service for the client lifetime.
 */
type BackendOperationsFacade = {
  submit(request: OperationSubmitRequestV1, options?: OperationClientSubmitOptions): Promise<OperationSubmitResult>;
  collect(handle: OperationHandleV1, options?: OperationClientCollectOptions): Promise<CollectorResult>;
  inspect(handle: OperationHandleV1): Promise<OperationInspectResult>;
  control(request: OperationControlRequestV1, options?: OperationClientControlOptions): Promise<ControlResult>;
};

type ChatGPTClientWithOperations = ChatGPTClient & {
  operations?: BackendOperationsFacade;
};

export class BackendSession {
  private clientInstance: ChatGPTClient | undefined;
  private readonly identity: BackendRuntimeIdentity;

  constructor(private readonly options: BackendSessionOptions = {}) {
    this.identity = backendRuntimeIdentity(options.backendIdentity);
  }

  async dispatch(request: BackendRequest): Promise<BackendResponse> {
    try {
      const result = await dispatchBackendCommand(request, payload => this.hello(payload), this.identity, () => this.client());
      return backendResponseOk(request.requestId, result);
    } catch (error) {
      return backendResponseError(request.requestId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async *stream(request: BackendRequest): AsyncIterable<BackendEvent> {
    try {
      assertCommandRoutingClassified(request.command);
      assertBackendOperationRoutingAllowed(request.command, request.payload);
      if (request.command !== "runner.stream") {
        const response = await this.dispatch(request);
        if (response.ok) {
          yield backendEventCompleted(request.requestId, response.result);
        } else {
          yield backendEvent(request.requestId, { type: "error", error: response.error });
        }
        return;
      }

      const payload = request.payload;
      const agent = this.client().agent(agentConfig(payload));
      const stream = this.client().runner.run(agent, runInput(payload), { stream: true });
      for await (const event of stream) {
        yield backendEvent(request.requestId, {
          type: "run_item_stream_event",
          name: event.name,
          item: event.item as unknown as Record<string, unknown>
        });
      }
      yield backendEventCompleted(request.requestId, await stream.completed);
    } catch (error) {
      // Runner/provider errors may contain prompt or page content. Only an
      // explicit ProtocolError carries a reviewed wire-safe message.
      const protocolError = error instanceof ProtocolError
        ? error
        : new ProtocolError("invalid_request", "Backend stream failed safely.", false);
      yield backendEvent(request.requestId, {
        type: "error",
        error: {
          code: protocolError.code,
          message: protocolError.message,
          recoverable: protocolError.recoverable
        }
      });
    }
  }

  private hello(payload: Record<string, unknown>): BackendRuntimeIdentity & {
    accepted: boolean;
    capabilities: BackendCapabilities;
  } {
    const requestedProtocol = payload.protocolVersion;
    const hasRequestedCapabilities = Object.hasOwn(payload, "capabilities");
    const baseCapabilities = backendCapabilities(this.identity);
    const requestedCapabilities = isRecord(payload.capabilities) ? payload.capabilities : undefined;
    const capabilities = intersectCapabilities(baseCapabilities, requestedCapabilities);
    const accepted = (requestedProtocol === undefined || requestedProtocol === this.identity.protocolVersion)
      && (!hasRequestedCapabilities
        || (requestedCapabilities !== undefined
          && requestedCapabilitiesSatisfied(baseCapabilities, capabilities, requestedCapabilities)));
    return {
      ...this.identity,
      accepted,
      capabilities
    };
  }

  private client(): ChatGPTClient {
    this.clientInstance ??= createChatGPT(this.options);
    return this.clientInstance;
  }
}

async function dispatchBackendCommand(
  request: BackendRequest,
  hello: (payload: Record<string, unknown>) => unknown,
  identity: BackendRuntimeIdentity,
  clientFactory: () => ChatGPTClient
): Promise<unknown> {
  assertCommandRoutingClassified(request.command);
  assertBackendOperationRoutingAllowed(request.command, request.payload);
  const payload = request.payload;
  const client = new Proxy({} as ChatGPTClient, {
    get: (_target, property, receiver) => Reflect.get(clientFactory(), property, receiver)
  });

  switch (request.command) {
    case "backend.hello":
      return hello(payload);
    case "backend.version":
      return {
        name: "codex-chatgpt-control-backend",
        ...identity
      };
    case "backend.health":
      return {
        ok: true,
        status: "ok",
        timestamp: new Date().toISOString()
      };
    case "backend.capabilities":
      return backendCapabilities(identity);
    case "runner.run": {
      const agent = client.agent(agentConfig(payload));
      return client.runner.run(agent, runInput(payload));
    }
    case "runner.plan": {
      const agent = client.agent(agentConfig(payload));
      return client.runner.plan(agent, runInput(payload));
    }
    case "responses.create":
      return client.responses.create(payload);
    case "commands":
      return client.commands(commandFilter(payload));
    case "describe":
      return client.describe(requiredString(payload, "name"));
    case "help":
      return client.help(optionalString(payload, "topic"));
    case "doctor":
      return client.doctor(payload);
    case "ask":
      return client.ask(payload as Parameters<ChatGPTClient["ask"]>[0]);
    case "askInThread":
      return client.askInThread(payload as Parameters<ChatGPTClient["askInThread"]>[0]);
    case "askWithFiles":
      return client.askWithFiles(payload as Parameters<ChatGPTClient["askWithFiles"]>[0]);
    case "askAndDownload":
      return client.askAndDownload(payload as Parameters<ChatGPTClient["askAndDownload"]>[0]);
    case "runMessages":
      return client.runMessages(payload as Parameters<ChatGPTClient["runMessages"]>[0]);
    case "openThread":
      return client.openThread(payload as Parameters<ChatGPTClient["openThread"]>[0]);
    case "readLatest":
      return client.readLatest(emptyToUndefined(payload) as ReadLatestArgs | undefined);
    case "copyLatest":
      return client.copyLatest(emptyToUndefined(payload) as CopyResponseArgs | undefined);
    case "downloadLatest":
      return client.downloadLatest(payload as DownloadLatestArgs);
    case "runPlan":
      return client.runPlan(runPlanPayload(payload));
    case "createReport":
      return client.createReport(
        requiredRecord(payload, "result") as CommandResult<unknown>,
        optionalRecord(payload, "args") as Parameters<ChatGPTClient["createReport"]>[1]
      );
    case "reports.create":
      return client.reports.create(
        requiredRecord(payload, "result") as CommandResult<unknown>,
        optionalRecord(payload, "args") as Parameters<ChatGPTClient["reports"]["create"]>[1]
      );
    case "reports.redact":
      return client.reports.redact(
        payload.value,
        optionalRecord(payload, "args") as Parameters<ChatGPTClient["reports"]["redact"]>[1]
      );
    case "reports.summarize":
      return client.reports.summarize(
        requiredRecord(payload, "result") as CommandResult<unknown>,
        optionalRecord(payload, "args") as Parameters<ChatGPTClient["reports"]["summarize"]>[1]
      );
    case "session.bootstrap":
      return client.session.bootstrap(emptyToUndefined(payload));
    case "experience.detect":
      return client.experience.detect(emptyToUndefined(payload));
    case "experience.open":
      return client.experience.open(payload as Parameters<ChatGPTClient["experience"]["open"]>[0]);
    case "configuration.inspect":
      return client.configuration.inspect(emptyToUndefined(payload));
    case "configuration.apply":
      return client.configuration.apply(payload as Parameters<ChatGPTClient["configuration"]["apply"]>[0]);
    case "work.start":
      return client.work.start(payload as Parameters<ChatGPTClient["work"]["start"]>[0]);
    case "work.status":
      return client.work.status(emptyToUndefined(payload));
    case "work.wait":
      return client.work.wait(emptyToUndefined(payload));
    case "work.steer":
      return client.work.steer(payload as Parameters<ChatGPTClient["work"]["steer"]>[0]);
    case "work.readLatest":
      return client.work.readLatest(emptyToUndefined(payload));
    case "threads.new":
      return client.threads.new(emptyToUndefined(payload));
    case "threads.search":
      return client.threads.search(payload as Parameters<ChatGPTClient["threads"]["search"]>[0]);
    case "threads.open":
      return client.threads.open(payload as Parameters<ChatGPTClient["threads"]["open"]>[0]);
    case "messages.compose":
      return client.messages.compose(payload as Parameters<ChatGPTClient["messages"]["compose"]>[0]);
    case "messages.submit":
      return client.messages.submit(emptyToUndefined(payload));
    case "messages.ask":
      return client.messages.ask(payload as Parameters<ChatGPTClient["messages"]["ask"]>[0]);
    case "messages.wait":
      return client.messages.wait(emptyToUndefined(payload));
    case "messages.readLatest":
      return client.messages.readLatest(emptyToUndefined(payload));
    case "messages.status":
      return client.messages.status(emptyToUndefined(payload));
    case "messages.stop":
      return client.messages.stop(payload as Parameters<ChatGPTClient["messages"]["stop"]>[0]);
    case "messages.waitAndRead":
      return client.messages.waitAndRead(payload as Parameters<ChatGPTClient["messages"]["waitAndRead"]>[0]);
    case "artifacts.listLatest":
      return client.artifacts.listLatest(emptyToUndefined(payload) as ListArtifactsArgs | undefined);
    case "artifacts.wait":
      return client.artifacts.wait(emptyToUndefined(payload) as ArtifactWaitArgs | undefined);
    case "artifacts.downloadLatest":
      return client.artifacts.downloadLatest(payload as ArtifactDownloadArgs);
    case "files.preflight":
      return client.files.preflight(payload as Parameters<ChatGPTClient["files"]["preflight"]>[0]);
    case "files.attach":
      return client.files.attach(payload as Parameters<ChatGPTClient["files"]["attach"]>[0]);
    case "files.downloadLatest":
      return client.files.downloadLatest(payload as Parameters<ChatGPTClient["files"]["downloadLatest"]>[0]);
    case "projects.sources.list":
      return client.projects.sources.list(payload as Parameters<ChatGPTClient["projects"]["sources"]["list"]>[0]);
    case "projects.sources.planAdd":
      return client.projects.sources.planAdd(payload as Parameters<ChatGPTClient["projects"]["sources"]["planAdd"]>[0]);
    case "projects.sources.add":
      return client.projects.sources.add(payload as Parameters<ChatGPTClient["projects"]["sources"]["add"]>[0]);
    case "modes.set":
      return client.modes.set(payload as Parameters<ChatGPTClient["modes"]["set"]>[0]);
    case "modes.get":
      return client.modes.get(emptyToUndefined(payload));
    case "tools.select":
      return client.tools.select(payload as Parameters<ChatGPTClient["tools"]["select"]>[0]);
    case "response.copy":
      return client.response.copy(emptyToUndefined(payload));
    case "operations.submit":
      return dispatchOperationSubmit(client as ChatGPTClientWithOperations, payload);
    case "operations.collect":
      return dispatchOperationCollect(client as ChatGPTClientWithOperations, payload);
    case "operations.inspect":
      return dispatchOperationInspect(client as ChatGPTClientWithOperations, payload);
    case "operations.control":
      return dispatchOperationControl(client as ChatGPTClientWithOperations, payload);
  }
}

function assertCommandRoutingClassified(command: string): void {
  if (classifyCommandRouting(command) === undefined) {
    throw new ProtocolError("invalid_request", "Backend command routing classification is unavailable.", false);
  }
  if (commandRoutingDisposition(command) === undefined) {
    // A known legacy browser command may only be admitted once its bounded
    // coordinator seam is present. Keep this static: command payloads can
    // contain prompts, local paths, or operation handles.
    throw new ProtocolError("invalid_request", "Backend command has no bounded coordinator route.", false);
  }
}

function assertBackendOperationRoutingAllowed(command: string, payload: Record<string, unknown>): void {
  try {
    assertOperationAwareDispatchAllowed(command, payload);
  } catch (error) {
    if (error instanceof CommandRoutingError) {
      // Keep the protocol error static. Operation payloads can contain raw
      // prompts, instructions, file paths, or handles and must never be
      // echoed as part of a routing failure.
      throw new ProtocolError("invalid_request", error.message, false);
    }
    throw error;
  }
}

function backendCapabilities(identity: BackendRuntimeIdentity): BackendCapabilities {
  return {
    ...identity,
    protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
    commands: [...backendCommands],
    transports: ["stdio"],
    streaming: {
      modes: ["ndjson"],
      tokenDeltas: false
    },
    supportedProtocolVersions: [BACKEND_REQUEST_SCHEMA_VERSION],
    requestIds: {
      required: true,
      scope: "connection"
    },
    multiplexing: {
      unary: true,
      streams: true
    },
    cancellation: {
      supported: false,
      requests: false,
      streams: false
    },
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
  };
}

async function dispatchOperationSubmit(
  client: ChatGPTClientWithOperations,
  payload: Record<string, unknown>
): Promise<unknown> {
  const operations = requireOperations(client);
  const request = operationSubmitRequest(payload);
  const result = await runOperationSafely(() => operations.submit(request));
  const inspected = await runOperationSafely(() => operations.inspect(result.handle));
  return operationWireSafely(() => toOperationSubmitWireResult(result, inspected.state.receipt));
}

async function dispatchOperationCollect(
  client: ChatGPTClientWithOperations,
  payload: Record<string, unknown>
): Promise<unknown> {
  const operations = requireOperations(client);
  const request = operationCollectRequest(payload);
  const result = await runOperationSafely(() => operations.collect(request.handle, {
    ...(request.wait === undefined ? {} : { wait: request.wait }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.pollIntervalMs === undefined ? {} : { pollIntervalMs: request.pollIntervalMs }),
    ...(request.responseContent === undefined ? {} : { responseContent: request.responseContent })
  }));
  // The caller's locator is never returned as authoritative state. Reloading
  // after the attempt obtains a fresh, authenticated handle for the wire
  // envelope and keeps collection's browser-free terminal path intact.
  const inspected = await runOperationSafely(() => operations.inspect(request.handle));
  return operationWireSafely(() => toOperationCollectWireResult(inspected.handle, result, inspected.state.receipt));
}

async function dispatchOperationInspect(
  client: ChatGPTClientWithOperations,
  payload: Record<string, unknown>
): Promise<unknown> {
  const operations = requireOperations(client);
  const request = operationInspectRequest(payload);
  // OperationClient.inspect is explicitly browser-free. Keep this command on
  // that path; no adapter factory or browser bridge is consulted here.
  const result = await runOperationSafely(() => operations.inspect(request.handle));
  return operationWireSafely(() => toOperationInspectWireResult(result));
}

async function dispatchOperationControl(
  client: ChatGPTClientWithOperations,
  payload: Record<string, unknown>
): Promise<unknown> {
  const operations = requireOperations(client);
  const request = operationControlRequest(payload);
  const result = await runOperationSafely(() => operations.control(request));
  const inspected = await runOperationSafely(() => operations.inspect(request.parent));
  return operationWireSafely(() => toOperationControlWireResult(result, inspected.handle));
}

function requireOperations(client: ChatGPTClientWithOperations): BackendOperationsFacade {
  const operations = client.operations;
  if (
    operations === undefined
    || typeof operations !== "object"
    || typeof operations.submit !== "function"
    || typeof operations.collect !== "function"
    || typeof operations.inspect !== "function"
    || typeof operations.control !== "function"
  ) {
    throw new ProtocolError("invalid_request", "Transactional browser operations are unavailable in this backend.", false);
  }
  return operations;
}

function operationSubmitRequest(payload: Record<string, unknown>): OperationSubmitRequestV1 {
  return validateOperationPayload(payload, validateWireSubmitRequest);
}

function operationCollectRequest(payload: Record<string, unknown>): OperationCollectRequestV1 {
  return validateOperationPayload(payload, validateWireCollectRequest);
}

function operationInspectRequest(payload: Record<string, unknown>): OperationInspectRequestV1 {
  return validateOperationPayload(payload, validateWireInspectRequest);
}

function operationControlRequest(payload: Record<string, unknown>): OperationControlRequestV1 {
  return validateOperationPayload(payload, validateWireControlRequest);
}

function validateOperationPayload<TRequest>(
  payload: Record<string, unknown>,
  validator: (value: unknown) => void
): TRequest {
  try {
    validator(payload);
    return payload as TRequest;
  } catch (error) {
    if (error instanceof OperationWireRequestError) throw invalidOperationPayload();
    throw error;
  }
}

function invalidOperationPayload(): ProtocolError {
  // Do not include the offending value: it may contain a prompt or local path.
  return new ProtocolError("invalid_request", "Transactional operation payload is invalid.", false);
}

async function runOperationSafely<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    // Operation adapters and journal errors can contain raw prompts, paths,
    // URLs, or provider-private diagnostics. None may cross the backend wire.
    throw new ProtocolError("invalid_request", "Transactional browser operation could not complete safely.", false);
  }
}

function operationWireSafely<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("invalid_request", "Transactional browser operation could not complete safely.", false);
  }
}

function intersectCapabilities(
  base: BackendCapabilities,
  requested: Record<string, unknown> | undefined
): BackendCapabilities {
  if (requested === undefined) return base;
  const requestedStreaming = isRecord(requested.streaming) ? requested.streaming : undefined;
  const requestedRequestIds = isRecord(requested.requestIds) ? requested.requestIds : undefined;
  const requestedMultiplexing = isRecord(requested.multiplexing) ? requested.multiplexing : undefined;
  const requestedCancellation = isRecord(requested.cancellation) ? requested.cancellation : undefined;
  const requestedTabs = isRecord(requested.tabs) ? requested.tabs : undefined;
  const intersectedCommands = Array.isArray(requested.commands)
    ? base.commands.filter(command => includesString(requested.commands, command))
    : base.commands;
  const commands = intersectedCommands.length > 0 ? intersectedCommands : base.commands;
  const intersectedTransports = Array.isArray(requested.transports)
    ? base.transports.filter(transport => includesString(requested.transports, transport))
    : base.transports;
  const transports = intersectedTransports.length > 0 ? intersectedTransports : base.transports;
  const intersectedModes = requestedStreaming !== undefined && Array.isArray(requestedStreaming.modes)
    ? base.streaming.modes.filter(mode => includesString(requestedStreaming.modes, mode))
    : base.streaming.modes;
  const modes = intersectedModes.length > 0 ? intersectedModes : base.streaming.modes;
  const intersectedProtocolVersions = Array.isArray(requested.supportedProtocolVersions)
    ? base.supportedProtocolVersions.filter(version => includesString(requested.supportedProtocolVersions, version))
    : base.supportedProtocolVersions;
  const requestIdScope = requestedRequestIds?.scope === undefined || requestedRequestIds.scope === base.requestIds.scope
    ? base.requestIds.scope
    : "none";
  const coordinationScope = requestedTabs?.coordinationScope === undefined
    || requestedTabs.coordinationScope === base.tabs.coordinationScope
    ? base.tabs.coordinationScope
    : "none";
  const stableProviderIdentity = base.tabs.stableProviderIdentity && requestedTabs?.stableProviderIdentity !== false;
  const stableBrowserIdentity = base.tabs.stableBrowserIdentity && requestedTabs?.stableBrowserIdentity !== false;
  const stableTabIdentity = base.tabs.stableTabIdentity && requestedTabs?.stableTabIdentity !== false;
  const authoritativeClaim = base.tabs.authoritativeClaim && requestedTabs?.authoritativeClaim !== false;
  const fencing = base.tabs.fencing && requestedTabs?.fencing !== false;
  const concurrentTabs = base.tabs.concurrentTabs && requestedTabs?.concurrentTabs !== false;
  return {
    ...base,
    supportedProtocolVersions: intersectedProtocolVersions.length > 0
      ? intersectedProtocolVersions
      : base.supportedProtocolVersions,
    commands,
    transports,
    streaming: {
      modes,
      tokenDeltas: base.streaming.tokenDeltas && requestedStreaming?.tokenDeltas !== false
    },
    requestIds: {
      required: base.requestIds.required && requestedRequestIds?.required !== false,
      scope: requestIdScope
    },
    multiplexing: {
      unary: base.multiplexing.unary && requestedMultiplexing?.unary !== false,
      streams: base.multiplexing.streams && requestedMultiplexing?.streams !== false
    },
    cancellation: {
      supported: base.cancellation.supported && requestedCancellation?.supported === true,
      requests: base.cancellation.requests && requestedCancellation?.requests === true,
      streams: base.cancellation.streams && requestedCancellation?.streams === true
    },
    tabs: {
      ...base.tabs,
      stableProviderIdentity,
      stableBrowserIdentity,
      stableTabIdentity,
      coordinationScope,
      authoritativeClaim,
      fencing,
      concurrentTabs,
      stableIdentity: stableProviderIdentity && stableBrowserIdentity && stableTabIdentity,
      coordination: coordinationScope !== "none",
      concurrent: concurrentTabs
    }
  };
}

function requestedCapabilitiesSatisfied(
  base: BackendCapabilities,
  intersection: BackendCapabilities,
  requested: Record<string, unknown>
): boolean {
  if (!requestedCapabilitiesShapeValid(requested)) return false;
  if ((Array.isArray(requested.commands) && requested.commands.length === 0)
    || (Array.isArray(requested.transports) && requested.transports.length === 0)
    || (Array.isArray(requested.supportedProtocolVersions) && requested.supportedProtocolVersions.length === 0)) return false;
  if (Array.isArray(requested.commands)
    && requested.commands.some(command => typeof command !== "string" || !base.commands.includes(command as BackendCommand))) return false;
  if (Array.isArray(requested.transports)
    && requested.transports.some(transport => typeof transport !== "string" || !base.transports.includes(transport as "stdio" | "http"))) return false;
  const requestedStreaming = isRecord(requested.streaming) ? requested.streaming : undefined;
  if (requested.streaming !== undefined && requestedStreaming === undefined) return false;
  if (requestedStreaming
    && Array.isArray(requestedStreaming.modes)) {
    if (requestedStreaming.modes.length === 0
      || requestedStreaming.modes.some(mode => typeof mode !== "string" || !base.streaming.modes.includes(mode as "ndjson" | "sse"))) return false;
  }
  if (requestedStreaming?.tokenDeltas === true && !intersection.streaming.tokenDeltas) return false;
  if (Array.isArray(requested.supportedProtocolVersions)
    && requested.supportedProtocolVersions.some(version => typeof version !== "string" || !base.supportedProtocolVersions.includes(version))) return false;
  const requestedRequestIds = isRecord(requested.requestIds) ? requested.requestIds : undefined;
  if (requested.requestIds !== undefined && requestedRequestIds === undefined) return false;
  if (requestedRequestIds
    && ((requestedRequestIds.required === true && !intersection.requestIds.required)
      || (requestedRequestIds.scope !== undefined && requestedRequestIds.scope !== intersection.requestIds.scope))) return false;
  const requestedMultiplexing = isRecord(requested.multiplexing) ? requested.multiplexing : undefined;
  if (requested.multiplexing !== undefined && requestedMultiplexing === undefined) return false;
  if (requestedMultiplexing
    && ((requestedMultiplexing.unary === true && !intersection.multiplexing.unary)
      || (requestedMultiplexing.streams === true && !intersection.multiplexing.streams))) return false;
  const requestedCancellation = isRecord(requested.cancellation) ? requested.cancellation : undefined;
  if (requested.cancellation !== undefined && requestedCancellation === undefined) return false;
  if (requestedCancellation
    && ((requestedCancellation.supported === true && !intersection.cancellation.supported)
      || (requestedCancellation.requests === true && !intersection.cancellation.requests)
      || (requestedCancellation.streams === true && !intersection.cancellation.streams))) return false;
  const requestedTabs = isRecord(requested.tabs) ? requested.tabs : undefined;
  if (requested.tabs !== undefined && requestedTabs === undefined) return false;
  if (requestedTabs
    && ((requestedTabs.stableProviderIdentity === true && !intersection.tabs.stableProviderIdentity)
      || (requestedTabs.stableBrowserIdentity === true && !intersection.tabs.stableBrowserIdentity)
      || (requestedTabs.stableTabIdentity === true && !intersection.tabs.stableTabIdentity)
      || (requestedTabs.authoritativeClaim === true && !intersection.tabs.authoritativeClaim)
      || (requestedTabs.fencing === true && !intersection.tabs.fencing)
      || (requestedTabs.concurrentTabs === true && !intersection.tabs.concurrentTabs)
      || (requestedTabs.stableIdentity === true && !intersection.tabs.stableIdentity)
      || (requestedTabs.coordination === true && !intersection.tabs.coordination)
      || (requestedTabs.concurrent === true && !intersection.tabs.concurrent)
      || (requestedTabs.coordinationScope !== undefined && requestedTabs.coordinationScope !== intersection.tabs.coordinationScope)
      || !requestedDeprecatedTabAliasesConsistent(requestedTabs))) return false;
  return true;
}

function requestedCapabilitiesShapeValid(requested: Record<string, unknown>): boolean {
  if (!optionalStringArray(requested.commands)
    || !optionalStringArray(requested.transports)
    || !optionalStringArray(requested.supportedProtocolVersions)) return false;
  for (const field of ["backendSessionId", "packageName", "packageVersion", "runtimeVersion", "buildDigest"] as const) {
    if (Object.hasOwn(requested, field) && !optionalIdentityString(requested[field])) return false;
  }
  if (Object.hasOwn(requested, "runtime") && requested.runtime !== "node") return false;
  if (Object.hasOwn(requested, "protocolVersion")
    && requested.protocolVersion !== BACKEND_REQUEST_SCHEMA_VERSION) return false;

  if (Object.hasOwn(requested, "streaming")) {
    if (!isRecord(requested.streaming)
      || !optionalStringArray(requested.streaming.modes)
      || !optionalBoolean(requested.streaming.tokenDeltas)) return false;
  }
  if (Object.hasOwn(requested, "requestIds")) {
    if (!isRecord(requested.requestIds)
      || !optionalBoolean(requested.requestIds.required)
      || (requested.requestIds.scope !== undefined
        && requested.requestIds.scope !== "connection"
        && requested.requestIds.scope !== "process"
        && requested.requestIds.scope !== "none")) return false;
  }
  if (Object.hasOwn(requested, "multiplexing")) {
    if (!isRecord(requested.multiplexing)
      || !optionalBoolean(requested.multiplexing.unary)
      || !optionalBoolean(requested.multiplexing.streams)) return false;
  }
  if (Object.hasOwn(requested, "cancellation")) {
    if (!isRecord(requested.cancellation)
      || !optionalBoolean(requested.cancellation.supported)
      || !optionalBoolean(requested.cancellation.requests)
      || !optionalBoolean(requested.cancellation.streams)) return false;
  }
  if (Object.hasOwn(requested, "tabs")) {
    if (!isRecord(requested.tabs)
      || !optionalBoolean(requested.tabs.stableProviderIdentity)
      || !optionalBoolean(requested.tabs.stableBrowserIdentity)
      || !optionalBoolean(requested.tabs.stableTabIdentity)
      || (requested.tabs.coordinationScope !== undefined
        && requested.tabs.coordinationScope !== "none"
        && requested.tabs.coordinationScope !== "process"
        && requested.tabs.coordinationScope !== "provider")
      || !optionalBoolean(requested.tabs.authoritativeClaim)
      || !optionalBoolean(requested.tabs.fencing)
      || !optionalBoolean(requested.tabs.concurrentTabs)
      || !optionalBoolean(requested.tabs.stableIdentity)
      || !optionalBoolean(requested.tabs.coordination)
      || !optionalBoolean(requested.tabs.concurrent)) return false;
  }
  return true;
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(item => typeof item === "string"));
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function optionalIdentityString(value: unknown): value is string | undefined {
  return value === undefined
    || (typeof value === "string"
      && value.length > 0
      && value.length <= MAX_IDENTITY_FIELD_LENGTH
      && value.trim() === value
      && !/[\u0000-\u001f\u007f]/u.test(value));
}

function requestedDeprecatedTabAliasesConsistent(tabs: Record<string, unknown>): boolean {
  const hasStableFields = ["stableProviderIdentity", "stableBrowserIdentity", "stableTabIdentity"]
    .every(field => Object.hasOwn(tabs, field));
  const expectedStableIdentity = hasStableFields
    && tabs.stableProviderIdentity === true
    && tabs.stableBrowserIdentity === true
    && tabs.stableTabIdentity === true;
  const expectedCoordination = tabs.coordinationScope !== undefined && tabs.coordinationScope !== "none";
  const expectedConcurrent = tabs.concurrentTabs === true;
  return (!Object.hasOwn(tabs, "stableIdentity")
      || !hasStableFields
      || tabs.stableIdentity === expectedStableIdentity)
    && (!Object.hasOwn(tabs, "coordination")
      || tabs.coordination === expectedCoordination)
    && (!Object.hasOwn(tabs, "concurrent")
      || tabs.concurrent === expectedConcurrent);
}

function includesString(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function backendRuntimeIdentity(
  rawOverrides: BackendSessionOptions["backendIdentity"] = {}
): BackendRuntimeIdentity {
  const overrides = validateIdentityOverrides(rawOverrides);
  return {
    backendSessionId: identityString(overrides.backendSessionId ?? PROCESS_BACKEND_SESSION_ID, "backendSessionId"),
    packageName: identityString(
      overrides.packageName ?? process.env.CHATGPT_BROWSER_CONTROL_PACKAGE_NAME ?? "codex-chatgpt-control",
      "packageName"
    ),
    packageVersion: identityString(
      overrides.packageVersion ?? process.env.CHATGPT_BROWSER_CONTROL_PACKAGE_VERSION ?? "unknown",
      "packageVersion"
    ),
    runtime: "node",
    runtimeVersion: identityString(
      overrides.runtimeVersion ?? process.env.CHATGPT_BROWSER_CONTROL_RUNTIME_VERSION ?? process.version,
      "runtimeVersion"
    ),
    buildDigest: identityString(
      overrides.buildDigest
        ?? process.env.CHATGPT_BROWSER_CONTROL_BUILD_DIGEST
        ?? process.env.CHATGPT_BROWSER_CONTROL_BUILD_SHA
        ?? "unknown",
      "buildDigest"
    ),
    protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION
  };
}

function validateIdentityOverrides(
  value: BackendSessionOptions["backendIdentity"]
): NonNullable<BackendSessionOptions["backendIdentity"]> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("backendIdentity must be an object when provided.");
  const allowed = new Set(["backendSessionId", "packageName", "packageVersion", "runtimeVersion", "buildDigest"]);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError("backendIdentity contains unsupported fields.");
  }
  for (const [key, field] of Object.entries(value)) {
    identityString(field, key);
  }
  return value as NonNullable<BackendSessionOptions["backendIdentity"]>;
}

function identityString(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_IDENTITY_FIELD_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`backend identity ${label} must be a bounded, non-empty string.`);
  }
  return value;
}

function agentConfig(payload: Record<string, unknown>): ChatGPTAgentConfig {
  return requiredRecord(payload, "agent") as ChatGPTAgentConfig;
}

function runInput(payload: Record<string, unknown>): ChatGPTRunInput {
  if (!Object.hasOwn(payload, "input")) {
    throw new ProtocolError("invalid_request", "Backend runner command requires payload.input.", false);
  }
  return payload.input as ChatGPTRunInput;
}

function runPlanPayload(payload: Record<string, unknown>): SequencePlan | Parameters<ChatGPTClient["runPlan"]>[0] {
  if (isRecord(payload.plan)) return payload.plan as SequencePlan;
  return payload as Parameters<ChatGPTClient["runPlan"]>[0];
}

function commandFilter(payload: Record<string, unknown>): Parameters<ChatGPTClient["commands"]>[0] {
  if (isRecord(payload.filter)) return payload.filter as Parameters<ChatGPTClient["commands"]>[0];
  return Object.keys(payload).length === 0 ? undefined : payload as Parameters<ChatGPTClient["commands"]>[0];
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError("invalid_request", `Backend command requires payload.${key} as a non-empty string.`, false);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProtocolError("invalid_request", `Backend command payload.${key} must be a string when provided.`, false);
  }
  return value;
}

function requiredRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key];
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_request", `Backend command requires payload.${key} as an object.`, false);
  }
  return value;
}

function optionalRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_request", `Backend command payload.${key} must be an object when provided.`, false);
  }
  return value;
}

function emptyToUndefined(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(payload).length === 0 ? undefined : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
