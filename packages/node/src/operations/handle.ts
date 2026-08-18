import { hmacDigest, operationRequestDigest } from "./canonical.js";
import { assertOperationId } from "./state-machine.js";
import { basename } from "node:path";
import {
  OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_REQUEST_SCHEMA_VERSION,
  type OperationControlRequestV1,
  type OperationHandleV1,
  type OperationStateV1,
  type OperationSubmitRequestV1
} from "./types.js";
import type { OperationFileManifestEntryV1 } from "./file-identity.js";

const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_INPUT_FILES = 256;
const MAX_TOOLS = 256;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_KEYS = 10_000;
const MAX_JSON_STRING_BYTES = 8 * 1024 * 1024;
const MAX_JSON_KEY_BYTES = 4096;
const RESERVED_CANONICAL_KEYS = new Set(["$undefined", "$date", "$bytes"]);

type SnapshotStore = WeakMap<object, Map<string, unknown>>;

// Snapshots are authority-boundary material. Keep them only for the duration
// of one synchronous top-level validation/digest call; retaining them globally
// would make a later mutation of a caller-owned object invisible. A fresh store
// is installed for every exported entrypoint and restored for reentrant calls.
let activeSnapshots: SnapshotStore | undefined;

function withSnapshotContext<T>(callback: () => T): T {
  const previous = activeSnapshots;
  activeSnapshots = new WeakMap<object, Map<string, unknown>>();
  try {
    return callback();
  } finally {
    activeSnapshots = previous;
  }
}

export class OperationHandleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OperationHandleError";
  }
}

export function operationSubmitRequestDigest(
  key: Uint8Array,
  request: OperationSubmitRequestV1,
  files: readonly OperationFileManifestEntryV1[]
): string {
  return withSnapshotContext(() => operationSubmitRequestDigestImpl(key, request, files));
}

function operationSubmitRequestDigestImpl(
  key: Uint8Array,
  request: OperationSubmitRequestV1,
  files: readonly OperationFileManifestEntryV1[]
): string {
  if (!request || typeof request !== "object") {
    throw new OperationHandleError("invalid_operation_request", "Operation request must be an object.");
  }
  assertExactKeys(request, "operation request", [
    "schemaVersion", "operationId", "surface", "prompt", "target", "configuration", "files", "capture", "timeoutMs"
  ]);
  const operationId = readData(request, "operationId");
  const schemaVersion = readData(request, "schemaVersion");
  const surface = readData(request, "surface");
  const prompt = readData(request, "prompt");
  const target = readData(request, "target");
  const configuration = readData(request, "configuration");
  const capture = readData(request, "capture");
  const timeoutMs = readData(request, "timeoutMs");
  const requestedFilesValue = readData(request, "files");
  assertId(operationId, "operationId");
  if (schemaVersion !== OPERATION_REQUEST_SCHEMA_VERSION) {
    throw new OperationHandleError("unsupported_operation_request", "Operation request schemaVersion is unsupported.");
  }
  if (surface !== "chat" && surface !== "work") {
    throw new OperationHandleError("invalid_operation_surface", "Operation surface must be chat or work.");
  }
  if (typeof prompt !== "string") {
    throw new OperationHandleError("invalid_operation_prompt", "Operation prompt must be a string.");
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new OperationHandleError("invalid_operation_prompt", "Operation prompt exceeds the bounded request limit.");
  }
  validateTargetRequest(target as OperationSubmitRequestV1["target"]);
  validateConfigurationRequest(configuration as OperationSubmitRequestV1["configuration"]);
  validateCapturePolicy(capture as OperationSubmitRequestV1["capture"]);
  validateTimeout(timeoutMs as number | undefined, "timeoutMs");
  const manifestEntries = readArrayEntries(files, "invalid_operation_file_manifest", "Operation file manifest", MAX_INPUT_FILES);
  if (manifestEntries.length > MAX_INPUT_FILES) {
    throw new OperationHandleError("invalid_operation_file_manifest", "Operation file manifest exceeds the bounded input-file limit.");
  }
  const requestedFiles = requestedFilesValue === undefined
    ? []
    : readArrayEntries(requestedFilesValue, "operation_file_manifest_mismatch", "Operation file request list", MAX_INPUT_FILES);
  if (requestedFiles.length > MAX_INPUT_FILES || requestedFiles.length !== manifestEntries.length) {
    throw new OperationHandleError("operation_file_manifest_mismatch", "Operation file manifest must match the request file list exactly.");
  }
  for (const [index, file] of manifestEntries.entries()) {
    assertExactKeys(file, "operation file manifest entry", ["displayName", "bytes", "contentSha256"], "invalid_operation_file_manifest");
    const displayName = readData(file, "displayName");
    const byteCount = readData(file, "bytes");
    const contentSha256 = readData(file, "contentSha256");
    if (
      typeof displayName !== "string" ||
      displayName.length === 0 ||
      displayName.length > 512 ||
      /[\\/\u0000-\u001f\u007f]/u.test(displayName) ||
      !Number.isSafeInteger(byteCount) ||
      (byteCount as number) < 0 ||
      typeof contentSha256 !== "string" ||
      !SHA256_PATTERN.test(contentSha256)
    ) {
      throw new OperationHandleError("invalid_operation_file_manifest", "Operation file manifest contains invalid size or SHA-256 data.");
    }
    const requested = requestedFiles[index];
    assertExactKeys(requested, "operation file request", ["path", "displayName"], "invalid_operation_file_request");
    const requestedPath = readData(requested, "path");
    const requestedDisplayName = readData(requested, "displayName");
    if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(requestedPath)) {
      throw new OperationHandleError("invalid_operation_file_request", "Operation file request requires a non-empty local path.");
    }
    if (requestedDisplayName !== undefined) validateBoundedString(requestedDisplayName, "files[].displayName");
    const expectedDisplayName = ((requestedDisplayName as string | undefined) ?? basename(requestedPath)).normalize("NFC");
    if (displayName !== expectedDisplayName) {
      throw new OperationHandleError("operation_file_manifest_mismatch", "Operation file manifest order or display name does not match the request.");
    }
  }
  return operationRequestDigest(key, {
    operationId,
    surface,
    target,
    prompt,
    configuration,
    tools: configuration === undefined ? undefined : readData(configuration as object, "tools"),
    files: manifestEntries as OperationFileManifestEntryV1[],
    capturePolicy: capture,
    behavior: {
      // Timeout is deliberately absent: changing a local wait budget must not
      // turn the same user intent into a different durable operation.
      operationRequestSchemaVersion: schemaVersion
    }
  });
}

export function operationControlRequestDigest(key: Uint8Array, request: OperationControlRequestV1): string {
  return withSnapshotContext(() => operationControlRequestDigestImpl(key, request));
}

function operationControlRequestDigestImpl(key: Uint8Array, request: OperationControlRequestV1): string {
  if (!request || typeof request !== "object") {
    throw new OperationHandleError("invalid_operation_control_request", "Operation control request must be an object.");
  }
  assertExactKeys(request, "operation control request", [
    "schemaVersion", "controlActionId", "parent", "action", "expectedAssistantTurnId", "steerPrompt", "timeoutMs"
  ]);
  const controlActionId = readData(request, "controlActionId");
  const schemaVersion = readData(request, "schemaVersion");
  const parent = readData(request, "parent");
  const action = readData(request, "action");
  const expectedAssistantTurnId = readData(request, "expectedAssistantTurnId");
  const steerPromptValue = readData(request, "steerPrompt");
  const timeoutMs = readData(request, "timeoutMs");
  assertId(controlActionId, "controlActionId");
  if (schemaVersion !== OPERATION_CONTROL_REQUEST_SCHEMA_VERSION) {
    throw new OperationHandleError("unsupported_operation_control_request", "Operation control schemaVersion is unsupported.");
  }
  validateHandleShape(parent as OperationHandleV1);
  const parentRecord = parent as object;
  const parentPhase = readData(parentRecord, "phase");
  const parentTargetBindingDigest = readData(parentRecord, "targetBindingDigest");
  if (parentPhase !== "generating" || parentTargetBindingDigest === undefined) {
    throw new OperationHandleError(
      "invalid_operation_control_target",
      "Operation control requires a generating parent handle with an exact target binding."
    );
  }
  if (
    typeof expectedAssistantTurnId !== "string" ||
    expectedAssistantTurnId.trim().length === 0 ||
    expectedAssistantTurnId.length > 512
  ) {
    throw new OperationHandleError("invalid_operation_control_target", "Operation control requires an exact assistant turn ID.");
  }
  if (action !== "stop" && action !== "steer") {
    throw new OperationHandleError("invalid_operation_control_request", "Operation control action must be stop or steer.");
  }
  if (action === "steer" && (typeof steerPromptValue !== "string" || steerPromptValue.length === 0)) {
    throw new OperationHandleError("invalid_operation_control_request", "A steer control requires steerPrompt.");
  }
  if (steerPromptValue !== undefined && (typeof steerPromptValue !== "string" || Buffer.byteLength(steerPromptValue, "utf8") > MAX_PROMPT_BYTES)) {
    throw new OperationHandleError("invalid_operation_control_request", "steerPrompt exceeds the bounded request limit.");
  }
  if (action === "stop" && steerPromptValue !== undefined) {
    throw new OperationHandleError("invalid_operation_control_request", "A stop control must not include steerPrompt.");
  }
  validateTimeout(timeoutMs as number | undefined, "timeoutMs");
  const steerPrompt = steerPromptValue === undefined
    ? undefined
    : {
        digest: hmacDigest(key, "codex-chatgpt-control/control-steer-prompt/v1", steerPromptValue as string),
        bytes: Buffer.byteLength(steerPromptValue as string, "utf8")
      };
  const parentOperationId = readData(parentRecord, "operationId");
  const parentRequestDigest = readData(parentRecord, "requestDigest");
  return hmacDigest(key, "codex-chatgpt-control/operation-control-request/v1", {
    schemaVersion: OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
    controlActionId,
    parentOperationId,
    parentRequestDigest,
    parentTargetBindingDigest,
    expectedAssistantTurnId,
    action,
    steerPrompt
  });
}

export function operationHandleFromState(key: Uint8Array, state: OperationStateV1): OperationHandleV1 {
  return withSnapshotContext(() => operationHandleFromStateImpl(key, state));
}

function operationHandleFromStateImpl(key: Uint8Array, state: OperationStateV1): OperationHandleV1 {
  const stateRecord = state as unknown as object;
  snapshotRecord(stateRecord, "operation state", "invalid_operation_handle");
  const operationId = readData(stateRecord, "operationId");
  const requestDigest = readData(stateRecord, "requestDigest");
  const surface = readData(stateRecord, "surface");
  const revision = readData(stateRecord, "revision");
  const phase = readData(stateRecord, "phase");
  const mutationBoundary = readData(stateRecord, "mutationBoundary");
  const target = readData(stateRecord, "target");
  const handle: OperationHandleV1 = {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: operationId as string,
    requestDigest: requestDigest as string,
    surface: surface as OperationHandleV1["surface"],
    revision: revision as number,
    phase: phase as OperationHandleV1["phase"],
    mutationBoundary: mutationBoundary as OperationHandleV1["mutationBoundary"]
  };
  if (target !== undefined) {
    handle.targetBindingDigest = hmacDigest(
      key,
      "codex-chatgpt-control/operation-target-binding/v1",
      operationTargetBindingProjectionImpl(target as NonNullable<OperationStateV1["target"]>)
    );
  }
  return handle;
}

/**
 * Return only the immutable target material used for action/handle binding.
 * A provider-assigned identity may be added to a new target after Send, but
 * it must never change the digest that authorizes the original action.
 */
export function operationTargetBindingProjection(
  target: NonNullable<OperationStateV1["target"]>
): unknown {
  return withSnapshotContext(() => operationTargetBindingProjectionImpl(target));
}

function operationTargetBindingProjectionImpl(
  target: NonNullable<OperationStateV1["target"]>
): unknown {
  const targetRecord = target as unknown as object;
  const values = snapshotRecord(targetRecord, "operation target", "invalid_operation_handle");
  const lifecycle = values.get("targetLifecycle") as "fixed" | "new_pending" | "new_established" | undefined ?? "fixed";
  if (lifecycle !== "new_pending" && lifecycle !== "new_established") return target;
  const immutableAnchor = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of values) {
    if (key === "targetLifecycle" || key === "canonicalThreadUrl" || key === "conversationId" || key === "targetEstablishment") continue;
    Object.defineProperty(immutableAnchor, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  const evidenceProfile = values.get("evidenceProfile");
  const evidenceValues = snapshotRecord(evidenceProfile, "operation target evidence profile", "invalid_operation_handle");
  const evidence = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of evidenceValues) {
    Object.defineProperty(evidence, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return {
    targetLifecycle: "new",
    ...immutableAnchor,
    evidenceProfile: {
      ...evidence,
      // Provider conversation/user-turn availability is established after
      // Send and therefore is not part of the pre-Send action anchor.
      stableConversationId: "unavailable",
      stableUserTurnId: "unavailable"
    }
  };
}

export function validateOperationHandle(
  key: Uint8Array,
  handle: OperationHandleV1,
  state: OperationStateV1
): { stale: boolean; current: OperationHandleV1 } {
  return withSnapshotContext(() => validateOperationHandleImpl(key, handle, state));
}

function validateOperationHandleImpl(
  key: Uint8Array,
  handle: OperationHandleV1,
  state: OperationStateV1
): { stale: boolean; current: OperationHandleV1 } {
  const stateRecord = state as unknown as object;
  snapshotRecord(stateRecord, "operation state", "invalid_operation_handle");
  const stateOperationId = readData(stateRecord, "operationId");
  const stateRequestDigest = readData(stateRecord, "requestDigest");
  const stateSurface = readData(stateRecord, "surface");
  const stateRevision = readData(stateRecord, "revision");
  const statePhase = readData(stateRecord, "phase");
  const stateMutationBoundary = readData(stateRecord, "mutationBoundary");
  validateHandleShape(handle);
  const handleOperationId = readData(handle, "operationId");
  const handleRequestDigest = readData(handle, "requestDigest");
  const handleSurface = readData(handle, "surface");
  const handleRevision = readData(handle, "revision");
  const handleBoundary = readData(handle, "mutationBoundary");
  const handlePhase = readData(handle, "phase");
  const handleTargetBindingDigest = readData(handle, "targetBindingDigest");
  if (handleOperationId !== stateOperationId || handleRequestDigest !== stateRequestDigest || handleSurface !== stateSurface) {
    throw new OperationHandleError("operation_handle_mismatch", "Operation handle does not match the durable operation binding.");
  }
  if (!Number.isSafeInteger(handleRevision) || (handleRevision as number) < 1) {
    throw new OperationHandleError("invalid_operation_handle", "Operation handle revision must be a positive safe integer.");
  }
  if ((handleRevision as number) > (stateRevision as number)) {
    throw new OperationHandleError("operation_handle_ahead", "Operation handle claims a revision newer than durable state.");
  }
  if (BOUNDARY_RANK[handleBoundary as OperationHandleV1["mutationBoundary"]] > BOUNDARY_RANK[stateMutationBoundary as OperationHandleV1["mutationBoundary"]]) {
    throw new OperationHandleError("operation_handle_state_mismatch", "Operation handle claims a mutation boundary ahead of durable state.");
  }
  if ((handleRevision as number) < (stateRevision as number) && !phaseCanReach(handlePhase as OperationHandleV1["phase"], statePhase as OperationHandleV1["phase"])) {
    throw new OperationHandleError("operation_handle_state_mismatch", "Operation handle phase cannot precede the current durable phase.");
  }
  const current = operationHandleFromStateImpl(key, state);
  if (
    handleTargetBindingDigest !== current.targetBindingDigest
    && !(handleTargetBindingDigest === undefined && (handleRevision as number) < (stateRevision as number))
  ) {
    throw new OperationHandleError("operation_handle_target_mismatch", "Operation handle target binding does not match durable state.");
  }
  if (
    handleRevision === stateRevision &&
    (handlePhase !== statePhase || handleBoundary !== stateMutationBoundary)
  ) {
    throw new OperationHandleError("operation_handle_state_mismatch", "Operation handle state fields disagree at the same revision.");
  }
  return { stale: (handleRevision as number) < (stateRevision as number), current };
}

const OPERATION_PHASES = new Set<OperationHandleV1["phase"]>([
  "prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed", "uncertain"
]);

const BOUNDARY_RANK: Record<OperationHandleV1["mutationBoundary"], number> = {
  none: 0,
  handoff_may_have_occurred: 1,
  send_may_have_occurred: 2,
  control_may_have_occurred: 3
};

const PHASE_EDGES: Record<OperationHandleV1["phase"], readonly OperationHandleV1["phase"][]> = {
  prepared: ["handoff_pending", "ready", "uncertain"],
  handoff_pending: ["ready", "uncertain"],
  ready: ["send_pending", "uncertain"],
  send_pending: ["submitted", "uncertain"],
  submitted: ["generating", "capturing", "uncertain"],
  generating: ["capturing", "uncertain"],
  capturing: ["completed", "uncertain"],
  completed: [],
  uncertain: ["ready", "submitted", "generating", "capturing", "completed"]
};

function validateHandleShape(handle: OperationHandleV1): void {
  if (!handle || typeof handle !== "object") {
    throw new OperationHandleError("invalid_operation_handle", "Operation handle must be an object.");
  }
  assertExactKeys(handle, "operation handle", [
    "schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary", "targetBindingDigest"
  ]);
  const schemaVersion = readData(handle, "schemaVersion");
  const operationId = readData(handle, "operationId");
  const requestDigest = readData(handle, "requestDigest");
  const surface = readData(handle, "surface");
  const revision = readData(handle, "revision");
  const phase = readData(handle, "phase");
  const mutationBoundary = readData(handle, "mutationBoundary");
  const targetBindingDigest = readData(handle, "targetBindingDigest");
  if (schemaVersion !== OPERATION_HANDLE_SCHEMA_VERSION) {
    throw new OperationHandleError("unsupported_operation_handle", "Operation handle schemaVersion is unsupported.");
  }
  assertId(operationId, "operationId");
  if (typeof requestDigest !== "string" || !DIGEST_PATTERN.test(requestDigest)) {
    throw new OperationHandleError("invalid_operation_handle", "Operation handle requestDigest is invalid.");
  }
  if (surface !== "chat" && surface !== "work") {
    throw new OperationHandleError("invalid_operation_handle", "Operation handle surface is invalid.");
  }
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new OperationHandleError("invalid_operation_handle", "Operation handle revision must be a positive safe integer.");
  }
  if (
    typeof phase !== "string"
    || !OPERATION_PHASES.has(phase as OperationHandleV1["phase"])
    || typeof mutationBoundary !== "string"
    || !(mutationBoundary in BOUNDARY_RANK)
  ) {
    throw new OperationHandleError("invalid_operation_handle", "Operation handle progress fields are invalid.");
  }
  if (targetBindingDigest !== undefined && (typeof targetBindingDigest !== "string" || !DIGEST_PATTERN.test(targetBindingDigest))) {
    throw new OperationHandleError("invalid_operation_handle", "Operation handle targetBindingDigest is invalid.");
  }
}

function phaseCanReach(from: OperationHandleV1["phase"], to: OperationHandleV1["phase"]): boolean {
  if (from === to) return true;
  const seen = new Set<OperationHandleV1["phase"]>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of PHASE_EDGES[current]) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function validateTargetRequest(target: OperationSubmitRequestV1["target"]): void {
  snapshotRecord(target, "operation target", "invalid_operation_target");
  const type = readData(target, "type");
  if (typeof type !== "string") {
    throw new OperationHandleError("invalid_operation_target", "Operation target is invalid.");
  }
  if (type === "new" || type === "selected_tab") {
    assertExactKeys(target, "operation target", ["type"]);
    return;
  }
  if (type === "tab_id") {
    assertExactKeys(target, "operation target", ["type", "tabId"]);
    return validateBoundedString(readData(target, "tabId"), "target.tabId");
  }
  if (type === "conversation_id") {
    assertExactKeys(target, "operation target", ["type", "conversationId"]);
    return validateBoundedString(readData(target, "conversationId"), "target.conversationId");
  }
  if (type === "url") {
    assertExactKeys(target, "operation target", ["type", "url"]);
    const url = readData(target, "url");
    validateBoundedString(url, "target.url", 4096);
    let parsed: URL;
    try {
      parsed = new URL(url as string);
    } catch {
      throw new OperationHandleError("invalid_operation_target", "Operation URL target must be an absolute HTTP(S) URL.");
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "") {
      throw new OperationHandleError("invalid_operation_target", "Operation URL target must be HTTP(S) and contain no credentials.");
    }
    return;
  }
  throw new OperationHandleError(
    "invalid_operation_target",
    "Unsupported operation target type."
  );
}

function validateConfigurationRequest(configuration: OperationSubmitRequestV1["configuration"]): void {
  if (configuration === undefined) return;
  assertExactKeys(
    configuration,
    "operation configuration",
    ["experience", "model", "modelVersion", "reasoning", "mode", "tools", "additional"],
    "invalid_operation_configuration"
  );
  const experience = readData(configuration, "experience");
  const model = readData(configuration, "model");
  const modelVersion = readData(configuration, "modelVersion");
  const reasoning = readData(configuration, "reasoning");
  const mode = readData(configuration, "mode");
  const tools = readData(configuration, "tools");
  const additional = readData(configuration, "additional");
  if (experience !== undefined && experience !== "chat" && experience !== "work") {
    throw new OperationHandleError("invalid_operation_configuration", "Configuration experience must be chat or work.");
  }
  for (const [label, value] of [
    ["model", model],
    ["modelVersion", modelVersion],
    ["reasoning", reasoning],
    ["mode", mode]
  ] as const) {
    if (value !== undefined) validateBoundedString(value, `configuration.${label}`);
  }
  if (tools !== undefined) {
    const entries = readArrayEntries(tools, "invalid_operation_configuration", "Configuration tools", MAX_TOOLS);
    if (entries.length > MAX_TOOLS) {
      throw new OperationHandleError("invalid_operation_configuration", "Configuration tools must be an array.");
    }
    for (const tool of entries) validateBoundedString(tool, "configuration.tools[]");
  }
  if (additional !== undefined) {
    validateJsonValue(additional, "configuration.additional");
  }
}

function validateCapturePolicy(capture: OperationSubmitRequestV1["capture"]): void {
  if (capture === undefined) return;
  assertExactKeys(
    capture,
    "operation capture policy",
    ["responseContent", "responseFormat", "artifacts", "outputDirectory"],
    "invalid_operation_capture"
  );
  const responseContent = readData(capture, "responseContent");
  const responseFormat = readData(capture, "responseFormat");
  const artifacts = readData(capture, "artifacts");
  const outputDirectory = readData(capture, "outputDirectory");
  if (responseContent !== "include" && responseContent !== "metadata") {
    throw new OperationHandleError("invalid_operation_capture", "Capture responseContent is invalid.");
  }
  if (responseFormat !== undefined && responseFormat !== "markdown" && responseFormat !== "text") {
    throw new OperationHandleError("invalid_operation_capture", "Capture responseFormat is invalid.");
  }
  if (artifacts !== "receipt_only" && artifacts !== "transfer") {
    throw new OperationHandleError("invalid_operation_capture", "Capture artifacts policy is invalid.");
  }
  if (outputDirectory !== undefined && (
    typeof outputDirectory !== "string"
    || outputDirectory.length === 0
    || outputDirectory.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(outputDirectory)
  )) {
    throw new OperationHandleError("invalid_operation_capture", "Capture outputDirectory must be a non-empty path.");
  }
  if (artifacts === "transfer" && outputDirectory === undefined) {
    throw new OperationHandleError("invalid_operation_capture", "Artifact transfer requires outputDirectory.");
  }
  if (artifacts === "receipt_only" && outputDirectory !== undefined) {
    throw new OperationHandleError("invalid_operation_capture", "outputDirectory is only valid when artifacts are transferred.");
  }
}

function validateTimeout(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new OperationHandleError("invalid_operation_timeout", `${label} must be a non-negative safe integer.`);
  }
}

function validateBoundedString(value: unknown, label: string, maxLength = 512): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OperationHandleError("invalid_operation_request", `${label} must be a bounded non-empty string.`);
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new OperationHandleError("invalid_operation_id", `${label} is invalid.`);
  }
  try {
    assertOperationId(value, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${label} is invalid.`;
    throw new OperationHandleError("invalid_operation_id", message);
  }
}

function assertExactKeys(
  value: unknown,
  label: string,
  allowed: readonly string[],
  code = "invalid_operation_request"
): asserts value is Record<string, unknown> {
  const values = snapshotRecord(value, label, code);
  const allowedSet = new Set(allowed);
  for (const key of values.keys()) {
    if (!allowedSet.has(key)) {
      throw new OperationHandleError("invalid_operation_request", `${label} contains an unsupported field.`);
    }
  }
}

function validateJsonValue(value: unknown, label: string): void {
  const budget = { nodes: 0, bytes: 0 };
  const active = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): void => {
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES) throw new OperationHandleError("invalid_operation_configuration", `${label} exceeds the bounded node limit.`);
    if (depth > MAX_JSON_DEPTH) throw new OperationHandleError("invalid_operation_configuration", `${label} exceeds the bounded nesting limit.`);
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "string") {
      budget.bytes += Buffer.byteLength(candidate, "utf8");
      if (budget.bytes > MAX_JSON_STRING_BYTES) throw new OperationHandleError("invalid_operation_configuration", `${label} exceeds the bounded byte limit.`);
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new OperationHandleError("invalid_operation_configuration", `${label} contains a non-finite number.`);
      return;
    }
    if (candidate === undefined || typeof candidate !== "object") {
      throw new OperationHandleError("invalid_operation_configuration", `${label} contains an unsupported value.`);
    }
    let isArray = false;
    try {
      isArray = Array.isArray(candidate);
    } catch {
      throw new OperationHandleError("invalid_operation_configuration", `${label} contains an inaccessible value.`);
    }
    const object = candidate as object;
    if (active.has(object)) throw new OperationHandleError("invalid_operation_configuration", `${label} contains a cyclic value.`);
    active.add(object);
    try {
      if (isArray) {
        const entries = readArrayEntries(candidate, "invalid_operation_configuration", label, MAX_JSON_NODES);
        for (const entry of entries) visit(entry, depth + 1);
        return;
      }
      try {
        const values = snapshotRecord(candidate, label, "invalid_operation_configuration");
        for (const [key, entry] of values) {
          if (
            key.length > 256
            || Buffer.byteLength(key, "utf8") > MAX_JSON_KEY_BYTES
            || /[\u0000-\u001f\u007f]/u.test(key)
            || RESERVED_CANONICAL_KEYS.has(key)
          ) {
            throw new OperationHandleError("invalid_operation_configuration", `${label} contains an invalid object key.`);
          }
          budget.bytes += Buffer.byteLength(key, "utf8");
          if (budget.bytes > MAX_JSON_STRING_BYTES) throw new OperationHandleError("invalid_operation_configuration", `${label} exceeds the bounded byte limit.`);
          visit(entry, depth + 1);
        }
        return;
      } catch (error) {
        if (error instanceof OperationHandleError && error.code === "invalid_operation_configuration") throw error;
        throw new OperationHandleError("invalid_operation_configuration", `${label} contains an unsupported value.`);
      }
    } finally {
      active.delete(object);
    }
  };
  visit(value, 0);
}

function snapshotRecord(value: unknown, label: string, code = "invalid_operation_request"): Map<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new OperationHandleError(code, `${label} must be a plain object.`);
  }
  const store = activeSnapshots;
  if (store === undefined) throw new OperationHandleError(code, "Operation data context is unavailable.");
  const cached = store.get(value);
  if (cached !== undefined) return cached;
  let prototype: object | null;
  let descriptors: Record<string | symbol, PropertyDescriptor>;
  let keys: (string | symbol)[];
  try {
    if (Array.isArray(value)) throw new Error("array");
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string | symbol, PropertyDescriptor>;
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw new OperationHandleError(code, `${label} could not be inspected safely.`);
  }
  if (keys.length > MAX_JSON_KEYS) throw new OperationHandleError(code, `${label} exceeds the bounded key limit.`);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OperationHandleError(code, `${label} must be a plain object.`);
  }
  const values = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new OperationHandleError(code, `${label} contains an unsupported symbol field.`);
    }
    const descriptor = descriptorFromMap(descriptors, key, label, code);
    if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new OperationHandleError(code, `${label} contains an unsafe property.`);
    }
    values.set(key, descriptor.value);
  }
  store.set(value, values);
  return values;
}

function readData(value: object, key: string): unknown {
  const store = activeSnapshots;
  if (store === undefined) throw new OperationHandleError("invalid_operation_request", "Operation data context is unavailable.");
  const snapshot = store.get(value);
  if (snapshot !== undefined) return snapshot.get(key);
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new OperationHandleError("invalid_operation_request", "Operation data could not be read safely.");
  }
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new OperationHandleError("invalid_operation_request", "Operation data contains an unsafe property.");
  }
  return descriptor.value;
}

function readArrayEntries(value: unknown, code: string, label: string, maxLength: number): unknown[] {
  if (value === null || typeof value !== "object") {
    throw new OperationHandleError(code, `${label} must be an array.`);
  }
  let isArray = false;
  let prototype: object | null;
  let descriptors: Record<string | symbol, PropertyDescriptor>;
  let keys: (string | symbol)[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string | symbol, PropertyDescriptor>;
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw new OperationHandleError(code, `${label} could not be inspected safely.`);
  }
  if (!isArray || prototype !== Array.prototype) throw new OperationHandleError(code, `${label} must be a standard array.`);
  const lengthDescriptor = descriptorFromMap(descriptors, "length", label, code);
  if (
    !("value" in lengthDescriptor)
    || lengthDescriptor.get !== undefined
    || lengthDescriptor.set !== undefined
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maxLength
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.configurable !== false
  ) {
    throw new OperationHandleError(code, `${label} contains an invalid length.`);
  }
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1) throw new OperationHandleError(code, `${label} must not be sparse or custom.`);
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "length" && parseArrayIndex(key) === undefined)) {
      throw new OperationHandleError(code, `${label} must not contain custom fields.`);
    }
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptorFromMap(descriptors, String(index), label, code);
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
      throw new OperationHandleError(code, `${label} contains an unsafe entry.`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function descriptorFromMap(
  descriptors: Record<string | symbol, PropertyDescriptor>,
  key: string,
  label: string,
  code = "invalid_operation_request"
): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(descriptors, key);
  } catch {
    throw new OperationHandleError(code, `${label} could not be inspected safely.`);
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new OperationHandleError(code, `${label} contains an invalid property.`);
  }
  return descriptor.value as PropertyDescriptor;
}

function parseArrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || index > 4_294_967_294 || String(index) !== key) return undefined;
  return index;
}
