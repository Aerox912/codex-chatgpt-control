import {
  ProcessTabCoordinator,
  type CoordinatorAcquisitionContext,
  type CoordinatorPriority,
  type TabResourceKey
} from "./tab-coordinator.js";
import type { OperationRuntimeContext } from "./operation-context.js";
import {
  coordinateRuntimeEnv,
  type CoordinatedBrowserOptions
} from "./coordinated-browser.js";
import type { RuntimeEnv } from "../types.js";

/**
 * Routing keeps the implementation classes visible while also exposing a
 * binary browser-free/coordinator-routed disposition for the acceptance
 * contract. Legacy command implementations still run directly, but their
 * page and browser method calls use the bounded coordinated runtime facade.
 * That does not make the whole command or its polling loop one coordinator
 * transaction.
 *
 * `operation_opt_in` means that an explicit caller-owned operation identity is
 * handled by an operation-aware public facade. It does not authorize wrapping
 * the whole public command in a coordinator callback.
 */
export type CommandRoutingClass =
  | "browser_free"
  | "operation_opt_in"
  | "legacy_page_facade"
  | "legacy_browser_unrouted"
  | "coordinator_entrypoint";

/** The complete routing inventory is intentionally explicit and reviewable. */
export const COMMAND_ROUTING_INVENTORY = Object.freeze({
  browserFree: Object.freeze([
    "backend.version",
    "backend.health",
    "backend.capabilities",
    "backend.hello",
    "runner.plan",
    "createReport",
    "reports.create",
    "reports.redact",
    "reports.summarize",
    "commands",
    "describe",
    "help",
    "redacted-run-report",
    "files.preflight",
    "projects.sources.planAdd",
    "operations.inspect"
  ] as const),
  /**
   * These commands opt into the operation facade only when an operation
   * identity is present. With no identity they retain their legacy path.
   */
  operationOptIn: Object.freeze([
    "runner.run",
    "runner.stream",
    "responses.create",
    "ask",
    "askInThread",
    "askWithFiles",
    "askAndDownload",
    "work.start",
    "work.steer",
    "operations.submit",
    "operations.collect",
    "operations.control"
  ] as const),
  /**
   * Legacy commands retain their public workflow and now receive a
   * coordinator-backed PageLike/BrowserLike facade. This is a method-level
   * guarantee: it does not turn the whole command or its polling loop into a
   * single actor callback.
   */
  legacyPageFacade: Object.freeze([
    "runMessages",
    "openThread",
    "copyLatest",
    "readLatest",
    "downloadLatest",
    "runPlan",
    "new-ask-read",
    "find-open-ask-read",
    "find-open-copy-latest",
    "attach-ask-read",
    "ask-and-download",
    "two-turn",
    "doctor-upload",
    "doctor",
    "session.bootstrap",
    "experience.detect",
    "experience.open",
    "configuration.inspect",
    "configuration.apply",
    "work.status",
    "work.wait",
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
    "files.attach",
    "files.downloadLatest",
    "projects.sources.list",
    "projects.sources.add",
    "response.copy",
    "modes.set",
    "modes.get",
    "tools.select"
  ] as const),
  /**
   * Browser acquisition seams not covered by the facade remain explicit
   * migration gaps. The current command surface has none; discovery is
   * coordinated in browser/attach.ts.
   */
  legacyBrowserUnrouted: Object.freeze([] as const),
  /**
   * No backend or sequence command currently invokes
   * routeCommandBrowserTransaction. Keep this category explicit so a future
   * migration cannot silently turn a classification into an enforcement
   * claim. A command may enter this list only after its own bounded DOM seam
   * is implemented and tested.
   */
  coordinatorEntrypoint: Object.freeze([] as const)
});

type InventoryCommand =
  | typeof COMMAND_ROUTING_INVENTORY.browserFree[number]
  | typeof COMMAND_ROUTING_INVENTORY.operationOptIn[number]
  | typeof COMMAND_ROUTING_INVENTORY.legacyPageFacade[number]
  | typeof COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted[number]
  | typeof COMMAND_ROUTING_INVENTORY.coordinatorEntrypoint[number];

type LegacyBrowserCommand = typeof COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted[number];
type LegacyPageFacadeCommand = typeof COMMAND_ROUTING_INVENTORY.legacyPageFacade[number];

/**
 * The operation-aware public dispatch seams currently implemented by the
 * client/backend path. This is separate from the coordinator entrypoint
 * inventory: these commands route into the operation facade, whose adapter
 * owns its own short tab transactions, rather than calling the generic helper
 * below around the whole command.
 */
export const OPERATION_AWARE_DISPATCH_COMMANDS = Object.freeze([
  ...COMMAND_ROUTING_INVENTORY.operationOptIn
] as const);

export type CommandRoutingGap = Readonly<{
  command: LegacyBrowserCommand;
  status: "legacy_browser_unrouted";
  owner: string;
  requiredSeam: "bounded_tab_transaction";
  reason: "legacy_command_dispatch_has_no_operation_aware_tab_seam";
}>;

/**
 * Precise migration ownership for every legacy browser command. The values
 * intentionally name source seams rather than claiming that the command is
 * safe merely because it appears in the inventory.
 */
const LEGACY_PAGE_FACADE_OWNERS: Readonly<Record<LegacyPageFacadeCommand, string>> = Object.freeze({
  runMessages: "src/client.ts -> src/commands/sequence.ts",
  openThread: "src/client.ts -> src/commands/sequence.ts -> src/commands/threads.ts",
  copyLatest: "src/client.ts -> src/commands/response-actions.ts",
  readLatest: "src/client.ts -> src/commands/messages.ts",
  downloadLatest: "src/client.ts -> src/commands/files.ts",
  runPlan: "src/client.ts -> src/commands/sequence.ts",
  "new-ask-read": "src/client.ts -> src/commands/sequence.ts -> src/commands/messages.ts",
  "find-open-ask-read": "src/client.ts -> src/commands/sequence.ts -> src/commands/messages.ts",
  "find-open-copy-latest": "src/client.ts -> src/commands/sequence.ts -> src/commands/response-actions.ts",
  "attach-ask-read": "src/client.ts -> src/commands/sequence.ts -> src/commands/files.ts",
  "ask-and-download": "src/client.ts -> src/commands/sequence.ts -> src/commands/files.ts",
  "two-turn": "src/client.ts -> src/commands/sequence.ts -> src/commands/messages.ts",
  "doctor-upload": "src/client.ts -> src/commands/doctor.ts",
  doctor: "src/commands/doctor.ts",
  "session.bootstrap": "src/commands/session.ts",
  "experience.detect": "src/commands/experience.ts",
  "experience.open": "src/commands/experience.ts",
  "configuration.inspect": "src/commands/configuration.ts",
  "configuration.apply": "src/commands/configuration.ts",
  "work.status": "src/commands/work.ts",
  "work.wait": "src/commands/work.ts",
  "work.readLatest": "src/commands/work.ts",
  "threads.new": "src/commands/threads.ts",
  "threads.search": "src/commands/threads.ts",
  "threads.open": "src/commands/threads.ts",
  "messages.compose": "src/commands/messages.ts",
  "messages.submit": "src/commands/messages.ts",
  "messages.ask": "src/commands/messages.ts",
  "messages.wait": "src/commands/messages.ts",
  "messages.readLatest": "src/commands/messages.ts",
  "messages.status": "src/commands/messages.ts",
  "messages.stop": "src/commands/messages.ts",
  "messages.waitAndRead": "src/commands/messages.ts",
  "artifacts.listLatest": "src/commands/artifacts.ts",
  "artifacts.wait": "src/commands/artifacts.ts",
  "artifacts.downloadLatest": "src/commands/artifacts.ts",
  "files.attach": "src/commands/files.ts",
  "files.downloadLatest": "src/commands/files.ts",
  "projects.sources.list": "src/commands/project-sources.ts",
  "projects.sources.add": "src/commands/project-sources.ts",
  "response.copy": "src/commands/response-actions.ts",
  "modes.set": "src/commands/modes.ts",
  "modes.get": "src/commands/modes.ts",
  "tools.select": "src/commands/modes.ts"
});

export const COMMAND_ROUTING_GAPS: readonly CommandRoutingGap[] = Object.freeze(
  COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted.map(command => Object.freeze({
    command,
    status: "legacy_browser_unrouted" as const,
    owner: LEGACY_PAGE_FACADE_OWNERS[command as LegacyPageFacadeCommand] ?? "src/browser/attach.ts -> coordinated browser/page facade",
    requiredSeam: "bounded_tab_transaction" as const,
    reason: "legacy_command_dispatch_has_no_operation_aware_tab_seam" as const
  }))
);

const commandRoutingClasses = new Map<string, CommandRoutingClass>();
for (const name of COMMAND_ROUTING_INVENTORY.browserFree) {
  if (commandRoutingClasses.has(name)) throw new Error("Duplicate command routing inventory entry.");
  commandRoutingClasses.set(name, "browser_free");
}
for (const name of COMMAND_ROUTING_INVENTORY.operationOptIn) {
  if (commandRoutingClasses.has(name)) throw new Error("Duplicate command routing inventory entry.");
  commandRoutingClasses.set(name, "operation_opt_in");
}
for (const name of COMMAND_ROUTING_INVENTORY.legacyPageFacade) {
  if (commandRoutingClasses.has(name)) throw new Error("Duplicate command routing inventory entry.");
  commandRoutingClasses.set(name, "legacy_page_facade");
}
for (const name of COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted) {
  if (commandRoutingClasses.has(name)) throw new Error("Duplicate command routing inventory entry.");
  commandRoutingClasses.set(name, "legacy_browser_unrouted");
}
for (const name of COMMAND_ROUTING_INVENTORY.coordinatorEntrypoint) {
  if (commandRoutingClasses.has(name)) throw new Error("Duplicate command routing inventory entry.");
  commandRoutingClasses.set(name, "coordinator_entrypoint");
}

/** Return undefined for a command that has not been explicitly classified. */
export function classifyCommandRouting(command: string): CommandRoutingClass | undefined {
  return commandRoutingClasses.get(command);
}

export function isBrowserFreeCommand(command: string): boolean {
  return classifyCommandRouting(command) === "browser_free";
}

export function isOperationOptInCommand(command: string): boolean {
  return classifyCommandRouting(command) === "operation_opt_in";
}

export function isLegacyBrowserUnroutedCommand(command: string): boolean {
  return classifyCommandRouting(command) === "legacy_browser_unrouted";
}

export function isLegacyPageFacadeCommand(command: string): boolean {
  return classifyCommandRouting(command) === "legacy_page_facade";
}

export function isCoordinatorEntrypointCommand(command: string): boolean {
  return classifyCommandRouting(command) === "coordinator_entrypoint";
}

/**
 * The public acceptance contract intentionally collapses the implementation
 * classes into the two meaningful routing dispositions.  `operation_opt_in`
 * is coordinator-routed by its operation adapter; the legacy page facade is
 * coordinator-routed by the bounded environment adapter below.  An explicit
 * `legacy_browser_unrouted` entry is a migration gap and therefore has no
 * safe disposition.
 */
export type CommandRoutingDisposition = "browser_free" | "coordinator_routed";

export function commandRoutingDisposition(command: string): CommandRoutingDisposition | undefined {
  const classification = classifyCommandRouting(command);
  if (classification === undefined || classification === "legacy_browser_unrouted") return undefined;
  return classification === "browser_free" ? "browser_free" : "coordinator_routed";
}

export function isCoordinatorRoutedCommand(command: string): boolean {
  return commandRoutingDisposition(command) === "coordinator_routed";
}

/** Options for the bounded legacy command adapter. */
export type CommandRoutingAdapterOptions = Readonly<Pick<CoordinatedBrowserOptions, "coordinator" | "owner">>;

/**
 * Prepare the environment for one command invocation.
 *
 * This is deliberately an adapter rather than a whole-command coordinator
 * transaction.  `coordinateRuntimeEnv` returns PageLike/BrowserLike facades
 * whose individual browser calls acquire the process-scoped actor for a
 * bounded operation and release it before the next await.  Consequently a
 * command may wait for generation, poll, write a journal, or invoke caller
 * code without retaining a tab actor.  The coordinated browser/page values
 * are copied back into the supplied invocation environment so legacy command
 * mutations (notably `session.bootstrap`) remain visible to later sequence
 * steps. Calling this on an already-coordinated environment is idempotent
 * through the wrapper caches.
 */
export function routeCommandRuntimeEnv(
  command: string,
  env: RuntimeEnv,
  options?: CommandRoutingAdapterOptions
): RuntimeEnv {
  const classification = classifyCommandRouting(command);
  if (classification === undefined) {
    throw new CommandRoutingError("unclassified_command");
  }
  if (classification === "legacy_browser_unrouted") {
    throw new CommandRoutingError("legacy_command_unrouted");
  }
  if (classification === "browser_free") {
    // Browser-free work must not even inspect provider members.
    return env;
  }
  // An operation-opt-in command still has a supported legacy path when its
  // caller omits an operation identity. Coordinate that path as well. When an
  // operation identity is present the public client dispatches through the
  // operation facade, whose capture boundary deliberately unwraps these
  // compatibility facades before establishing its exact tab resource. This
  // therefore cannot nest the operation's own coordinator transaction.
  const coordinated = coordinateRuntimeEnv(env, options);
  try {
    if (coordinated.browser !== undefined && env.browser !== coordinated.browser) {
      env.browser = coordinated.browser;
    }
    if (coordinated.page !== undefined && env.page !== coordinated.page) {
      env.page = coordinated.page;
    }
  } catch {
    // A caller may pass a frozen compatibility snapshot. Preserve the
    // command's ability to use the coordinated facade even though later
    // legacy mutations cannot be committed to that snapshot.
    return coordinated;
  }
  return env;
}

/**
 * Run one command with the bounded legacy environment adapter.
 *
 * The callback is invoked outside any coordinator callback.  The returned
 * PageLike/BrowserLike values enforce short method-level transactions, so a
 * caller callback or a generation/poll sleep cannot deadlock a nested actor.
 */
export function routeCommandExecution<T>(
  command: string,
  env: RuntimeEnv,
  callback: (routedEnv: RuntimeEnv) => T | PromiseLike<T>,
  options?: CommandRoutingAdapterOptions
): Promise<T> {
  if (typeof callback !== "function") {
    return Promise.reject(new CommandRoutingError("coordinator_context_required"));
  }
  return Promise.resolve().then(() => callback(routeCommandRuntimeEnv(command, env, options)));
}

export type CommandRoutingContext<Page extends object = object> = Readonly<{
  coordinator: ProcessTabCoordinator;
  runtimeContext: OperationRuntimeContext<Page>;
  priority?: CoordinatorPriority;
  signal?: AbortSignal;
  deadlineAt?: number;
  timeoutMs?: number;
  label?: string;
}>;

export type CommandRoutingErrorCode =
  | "unclassified_command"
  | "coordinator_context_required"
  | "exact_ownership_unavailable"
  | "legacy_command_unrouted"
  | "legacy_page_facade"
  | "operation_facade_managed"
  | "operation_routing_unavailable";

/** Stable error for callers that try to route without enough ownership proof. */
export class CommandRoutingError extends Error {
  readonly code: CommandRoutingErrorCode;

  constructor(code: CommandRoutingErrorCode) {
    super(commandRoutingErrorMessage(code));
    this.name = "CommandRoutingError";
    this.code = code;
  }
}

/**
 * Execute one already-bounded browser transaction for an explicit coordinator
 * entrypoint. The callback is intentionally the transaction boundary, not
 * the command or request boundary. Callers must keep generation waits,
 * polling sleeps, file hashing/transfers, journal writes, and report/caller
 * callbacks outside this helper.
 */
export function routeCommandBrowserTransaction<T, Page extends object = object>(
  command: string,
  context: CommandRoutingContext<Page> | undefined,
  callback: (acquisition: CoordinatorAcquisitionContext | undefined) => T | PromiseLike<T>
): Promise<T> {
  const classification = classifyCommandRouting(command);
  if (classification === undefined) {
    return Promise.reject(new CommandRoutingError("unclassified_command"));
  }
  if (typeof callback !== "function") {
    return Promise.reject(new CommandRoutingError("coordinator_context_required"));
  }
  if (classification === "browser_free") {
    return Promise.resolve().then(() => callback(undefined));
  }
  if (classification === "legacy_browser_unrouted") {
    return Promise.reject(new CommandRoutingError("legacy_command_unrouted"));
  }
  if (classification === "legacy_page_facade") {
    return Promise.reject(new CommandRoutingError("legacy_page_facade"));
  }
  if (classification === "operation_opt_in") {
    return Promise.reject(new CommandRoutingError("operation_facade_managed"));
  }
  if (context === undefined) {
    return Promise.reject(new CommandRoutingError("coordinator_context_required"));
  }

  const resource = context.runtimeContext.coordinatorResource();
  if (!resource.exactTabOwnership || resource.resourceKind !== "tab") {
    return Promise.reject(new CommandRoutingError("exact_ownership_unavailable"));
  }

  const requestOptions = {
    // The immutable operation context is the sole owner authority. Do not
    // allow a caller-supplied diagnostic owner to acquire the exact tab under
    // different ownership metadata.
    owner: context.runtimeContext.owner,
    ...(context.priority === undefined ? {} : { priority: context.priority }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
    ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
    ...(context.label === undefined ? {} : { label: context.label })
  };
  if (resource.resourceKind === "tab") {
    return context.coordinator.withTabTransaction(resource.resourceKey as TabResourceKey, requestOptions, callback);
  }
  // The exact-ownership check above currently makes this branch unreachable;
  // retain the defensive fallback so a future resource implementation cannot
  // accidentally run a tab transaction against the browser actor.
  return Promise.reject(new CommandRoutingError("exact_ownership_unavailable"));
}

/** Return a readonly snapshot useful for diagnostics and inventory tests. */
export function commandRoutingInventory(): Readonly<Record<string, CommandRoutingClass>> {
  return Object.freeze(Object.fromEntries(commandRoutingClasses.entries()));
}

/**
 * Return true when a request carries one of the reserved caller-owned
 * operation identity fields. This is intentionally structural and never
 * reads or serializes prompt/instruction values.
 */
export function hasOperationIdentity(value: unknown): boolean {
  try {
    return hasOperationIdentityInner(value, new Set<object>(), 0);
  } catch {
    // Routing inspection is a caller-controlled boundary. Proxies, accessors,
    // and descriptor traps must never be invoked merely to decide whether a
    // legacy browser handler is safe. An unreadable shape could conceal an
    // operation locator, so fail closed and keep it away from the legacy path.
    return true;
  }
}

/**
 * Backend and sequence dispatchers call this before direct command dispatch.
 * Legacy callers without an operation identity remain byte-for-byte on the
 * existing path. An operation-aware request is allowed only for explicitly
 * migrated facade commands (or browser-free diagnostics); all other browser
 * commands fail before their handler can touch the browser.
 */
export function assertOperationAwareDispatchAllowed(command: string, payload: unknown): void {
  const classification = classifyCommandRouting(command);
  if (classification === undefined) {
    throw new CommandRoutingError("unclassified_command");
  }
  if (!hasOperationIdentity(payload)) return;
  if (
    classification === "browser_free"
    || classification === "operation_opt_in"
    || classification === "coordinator_entrypoint"
  ) return;
  throw new CommandRoutingError("operation_routing_unavailable");
}

function commandRoutingErrorMessage(code: CommandRoutingErrorCode): string {
  switch (code) {
    case "unclassified_command":
      return "The command has no explicit browser-routing classification.";
    case "coordinator_context_required":
      return "An operation runtime context is required for a bounded coordinator browser transaction.";
    case "exact_ownership_unavailable":
      return "Exact claimed-tab ownership is required for a bounded coordinator browser transaction.";
    case "legacy_command_unrouted":
      return "This legacy browser command has no bounded coordinator transaction seam.";
    case "legacy_page_facade":
      return "This legacy browser command coordinates individual PageLike/BrowserLike calls and cannot be wrapped as a whole-command transaction.";
    case "operation_facade_managed":
      return "This operation-aware command is managed by its operation facade and cannot be wrapped as a whole-command transaction.";
    case "operation_routing_unavailable":
      return "An operation identity was supplied to a legacy browser command without an operation-aware dispatch seam.";
  }
}

function hasOperationIdentityInner(value: unknown, seen: Set<object>, depth: number): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  if (depth > 8) return true;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "operationId" || key === "controlActionId" || key === "handle" || key === "parentHandle") {
      return true;
    }
    if (!("value" in descriptor)) return true;
    if (hasOperationIdentityInner(descriptor.value, seen, depth + 1)) return true;
  }
  return false;
}

// Keep this alias available to type-level consumers without making the
// inventory object part of the public wire descriptor shape.
export type ClassifiedCommand = InventoryCommand;
