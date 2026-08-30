import {
  OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
  OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_INSPECT_REQUEST_SCHEMA_VERSION,
  OPERATION_REQUEST_SCHEMA_VERSION,
  type OperationCollectRequestV1,
  type OperationControlRequestV1,
  type OperationInspectRequestV1,
  type OperationSubmitRequestV1
} from "./types.js";

const PROJECT_ICONS = new Set([
  "Folder", "Currency Dollar", "Book", "Graduation Cap", "Pencil", "Writing", "Code Brackets", "Terminal",
  "Music", "Popcorn", "Customize", "Palette", "Stethoscope", "Health", "Lotus", "Suitcase", "Bar Chart",
  "Kettlebell", "Dumbbell", "Logs", "Balancing Scale", "Globe Spin", "Plane", "Globe", "Wrench", "Paw",
  "Flask", "Brain", "Heart", "Plant"
]);
const PROJECT_COLORS = new Set(["default", "red", "orange", "yellow", "green", "blue", "purple", "pink"]);

/**
 * Raised by the closed runtime validators in this module.
 *
 * The message intentionally contains no field name or value. Operation
 * requests can contain prompts and local paths, and validation failures must
 * be safe to send across a backend boundary.
 */
export class OperationWireRequestError extends Error {
  readonly code = "invalid_operation_request" as const;
  readonly recoverable = false as const;

  constructor() {
    super("Transactional operation request is invalid.");
    this.name = "OperationWireRequestError";
  }
}

/** Validate the canonical direct v1 submit payload. */
export function validateOperationSubmitRequest(value: unknown): asserts value is OperationSubmitRequestV1 {
  const request = operationRecord(value);
  operationExactKeys(request, [
    "schemaVersion", "operationId", "surface", "prompt", "target", "configuration", "files", "capture", "timeoutMs"
  ]);
  operationConst(propertyValue(request, "schemaVersion"), OPERATION_REQUEST_SCHEMA_VERSION);
  operationId(propertyValue(request, "operationId"));
  operationSurface(propertyValue(request, "surface"));
  operationText(propertyValue(request, "prompt"), 8 * 1024 * 1024, false);
  validateOperationTarget(propertyValue(request, "target"));
  const configuration = propertyValue(request, "configuration");
  if (configuration !== undefined) validateOperationConfiguration(configuration);
  const files = propertyValue(request, "files");
  if (files !== undefined) {
    const entries = arrayValues(files, 256);
    for (const file of entries) {
      const entry = operationRecord(file);
      operationExactKeys(entry, ["path", "displayName"]);
      operationText(propertyValue(entry, "path"), 4096, true);
      const displayName = propertyValue(entry, "displayName");
      if (displayName !== undefined) operationText(displayName, 512, true);
    }
  }
  const capture = propertyValue(request, "capture");
  if (capture !== undefined) validateOperationCapture(capture);
  validateOperationTimeout(propertyValue(request, "timeoutMs"));
}

/** Validate the canonical direct v1 collect payload. */
export function validateOperationCollectRequest(value: unknown): asserts value is OperationCollectRequestV1 {
  const request = operationRecord(value);
  operationExactKeys(request, ["schemaVersion", "handle", "wait", "timeoutMs", "pollIntervalMs", "responseContent"]);
  operationConst(propertyValue(request, "schemaVersion"), OPERATION_COLLECT_REQUEST_SCHEMA_VERSION);
  validateOperationHandlePayload(propertyValue(request, "handle"));
  const wait = propertyValue(request, "wait");
  if (wait !== undefined && typeof wait !== "boolean") throw invalidOperationRequest();
  validateOperationTimeout(propertyValue(request, "timeoutMs"));
  const pollIntervalMs = propertyValue(request, "pollIntervalMs");
  if (
    pollIntervalMs !== undefined
    && (typeof pollIntervalMs !== "number" || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000)
  ) {
    throw invalidOperationRequest();
  }
  const responseContent = propertyValue(request, "responseContent");
  if (responseContent !== undefined && responseContent !== "include" && responseContent !== "metadata") {
    throw invalidOperationRequest();
  }
}

/** Validate the canonical direct v1 inspect payload. */
export function validateOperationInspectRequest(value: unknown): asserts value is OperationInspectRequestV1 {
  const request = operationRecord(value);
  operationExactKeys(request, ["schemaVersion", "handle"]);
  operationConst(propertyValue(request, "schemaVersion"), OPERATION_INSPECT_REQUEST_SCHEMA_VERSION);
  validateOperationHandlePayload(propertyValue(request, "handle"));
}

/** Validate the canonical direct v1 control payload. */
export function validateOperationControlRequest(value: unknown): asserts value is OperationControlRequestV1 {
  const request = operationRecord(value);
  operationExactKeys(request, [
    "schemaVersion", "controlActionId", "parent", "action", "expectedAssistantTurnId", "steerPrompt", "timeoutMs"
  ]);
  operationConst(propertyValue(request, "schemaVersion"), OPERATION_CONTROL_REQUEST_SCHEMA_VERSION);
  operationId(propertyValue(request, "controlActionId"));
  const parent = validateOperationHandlePayload(propertyValue(request, "parent"));
  if (propertyValue(parent, "phase") !== "generating" || propertyValue(parent, "targetBindingDigest") === undefined) {
    throw invalidOperationRequest();
  }
  const action = propertyValue(request, "action");
  if (action !== "stop" && action !== "steer") throw invalidOperationRequest();
  operationOpaqueId(propertyValue(request, "expectedAssistantTurnId"), 512);
  const steerPrompt = propertyValue(request, "steerPrompt");
  if (action === "steer") {
    if (steerPrompt === undefined) throw invalidOperationRequest();
    operationText(steerPrompt, 8 * 1024 * 1024, true);
  } else if (steerPrompt !== undefined) {
    throw invalidOperationRequest();
  }
  validateOperationTimeout(propertyValue(request, "timeoutMs"));
}

function validateOperationTarget(value: unknown): void {
  const target = operationRecord(value);
  const type = propertyValue(target, "type");
  if (typeof type !== "string") throw invalidOperationRequest();
  switch (type) {
    case "new":
    case "selected_tab":
      operationExactKeys(target, ["type"]);
      return;
    case "project":
      operationExactKeys(target, ["type", "name", "icon", "color", "confirmCreation"]);
      operationText(propertyValue(target, "name"), 512, true);
      if (propertyValue(target, "icon") !== undefined) {
        operationText(propertyValue(target, "icon"), 256, true);
        if (!PROJECT_ICONS.has(propertyValue(target, "icon") as string)) throw invalidOperationRequest();
      }
      if (propertyValue(target, "color") !== undefined) {
        operationText(propertyValue(target, "color"), 32, true);
        if (!PROJECT_COLORS.has(propertyValue(target, "color") as string)) throw invalidOperationRequest();
      }
      if (propertyValue(target, "confirmCreation") !== undefined && propertyValue(target, "confirmCreation") !== true) {
        throw invalidOperationRequest();
      }
      return;
    case "tab_id":
      operationExactKeys(target, ["type", "tabId"]);
      operationOpaqueId(propertyValue(target, "tabId"), 512);
      return;
    case "conversation_id":
      operationExactKeys(target, ["type", "conversationId"]);
      operationOpaqueId(propertyValue(target, "conversationId"), 512);
      return;
    case "url": {
      operationExactKeys(target, ["type", "url"]);
      const url = propertyValue(target, "url");
      operationText(url, 4096, true);
      if (typeof url !== "string" || /[\u0000-\u001f\u007f]/u.test(url)) {
        throw invalidOperationRequest();
      }
      try {
        const parsed = new URL(url as string);
        if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
          throw new Error("invalid");
        }
      } catch {
        throw invalidOperationRequest();
      }
      return;
    }
    default:
      throw invalidOperationRequest();
  }
}

function validateOperationConfiguration(value: unknown): void {
  const configuration = operationRecord(value);
  operationExactKeys(configuration, ["experience", "model", "modelVersion", "reasoning", "mode", "tools", "additional"]);
  const experience = propertyValue(configuration, "experience");
  if (experience !== undefined && experience !== "chat" && experience !== "work") throw invalidOperationRequest();
  for (const field of ["model", "modelVersion", "reasoning", "mode"] as const) {
    const requested = propertyValue(configuration, field);
    if (requested !== undefined) operationText(requested, 256, true);
  }
  const tools = propertyValue(configuration, "tools");
  if (tools !== undefined) {
    for (const tool of arrayValues(tools, 256)) operationText(tool, 256, true);
  }
  const additional = propertyValue(configuration, "additional");
  if (additional !== undefined) {
    if (!isPlainRecord(additional)) throw invalidOperationRequest();
    validateOperationJson(additional);
  }
}

function validateOperationCapture(value: unknown): void {
  const capture = operationRecord(value);
  operationExactKeys(capture, ["responseContent", "responseFormat", "artifacts", "outputDirectory"]);
  const responseContent = propertyValue(capture, "responseContent");
  const responseFormat = propertyValue(capture, "responseFormat");
  const artifacts = propertyValue(capture, "artifacts");
  const outputDirectory = propertyValue(capture, "outputDirectory");
  if (responseContent !== "include" && responseContent !== "metadata") throw invalidOperationRequest();
  if (responseFormat !== undefined && responseFormat !== "markdown" && responseFormat !== "text") throw invalidOperationRequest();
  if (artifacts !== "receipt_only" && artifacts !== "transfer") throw invalidOperationRequest();
  if (outputDirectory !== undefined) operationText(outputDirectory, 4096, true);
  if (artifacts === "transfer" && outputDirectory === undefined) throw invalidOperationRequest();
  if (artifacts === "receipt_only" && outputDirectory !== undefined) throw invalidOperationRequest();
}

function validateOperationHandlePayload(value: unknown): Record<string, unknown> {
  const handle = operationRecord(value);
  operationExactKeys(handle, [
    "schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary", "targetBindingDigest"
  ]);
  operationConst(propertyValue(handle, "schemaVersion"), OPERATION_HANDLE_SCHEMA_VERSION);
  operationId(propertyValue(handle, "operationId"));
  operationDigest(propertyValue(handle, "requestDigest"));
  operationSurface(propertyValue(handle, "surface"));
  const revision = propertyValue(handle, "revision");
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw invalidOperationRequest();
  if (!OPERATION_PHASES.has(propertyValue(handle, "phase") as string)
    || !OPERATION_BOUNDARIES.has(propertyValue(handle, "mutationBoundary") as string)) {
    throw invalidOperationRequest();
  }
  const targetBindingDigest = propertyValue(handle, "targetBindingDigest");
  if (targetBindingDigest !== undefined) operationDigest(targetBindingDigest);
  return handle;
}

function validateOperationTimeout(value: unknown): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) throw invalidOperationRequest();
}

function validateOperationJson(
  value: unknown,
  depth = 0,
  budget = { nodes: 0, utf8Bytes: 0 }
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_OPERATION_JSON_NODES || depth > MAX_OPERATION_JSON_DEPTH) throw invalidOperationRequest();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    addOperationJsonBytes(budget, value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidOperationRequest();
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of arrayValues(value, MAX_OPERATION_JSON_NODES)) validateOperationJson(entry, depth + 1, budget);
    return;
  }
  if (!isPlainRecord(value)) throw invalidOperationRequest();
  const record = operationRecord(value);
  for (const key of ownStringKeys(record)) {
    operationText(key, 256, false);
    if (/[\u0000-\u001f\u007f]/u.test(key)) throw invalidOperationRequest();
    addOperationJsonBytes(budget, key);
    validateOperationJson(propertyValue(record, key), depth + 1, budget);
  }
}

function addOperationJsonBytes(budget: { utf8Bytes: number }, value: string): void {
  if (!isWellFormedUnicode(value)) throw invalidOperationRequest();
  budget.utf8Bytes += Buffer.byteLength(value, "utf8");
  if (!Number.isSafeInteger(budget.utf8Bytes) || budget.utf8Bytes > MAX_OPERATION_JSON_UTF8_BYTES) {
    throw invalidOperationRequest();
  }
}

function operationRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalidOperationRequest();
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalidOperationRequest();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw invalidOperationRequest();
      }
    }
  } catch (error) {
    if (error instanceof OperationWireRequestError) throw error;
    throw invalidOperationRequest();
  }
  return value;
}

function operationExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (ownStringKeys(value).some(key => !allowedSet.has(key))) throw invalidOperationRequest();
}

function ownStringKeys(value: object): string[] {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw invalidOperationRequest();
    return keys as string[];
  } catch (error) {
    if (error instanceof OperationWireRequestError) throw error;
    throw invalidOperationRequest();
  }
}

function propertyValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return undefined;
    if (!("value" in descriptor) || descriptor.enumerable !== true) throw invalidOperationRequest();
    return descriptor.value;
  } catch (error) {
    if (error instanceof OperationWireRequestError) throw error;
    throw invalidOperationRequest();
  }
}

function arrayValues(value: unknown, maxLength: number): unknown[] {
  if (!Array.isArray(value)) throw invalidOperationRequest();
  try {
    const length = value.length;
    if (length > maxLength) throw invalidOperationRequest();
    const keys = Reflect.ownKeys(value);
    const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    if (keys.some(key => typeof key !== "string" || !allowed.has(key))) throw invalidOperationRequest();
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw invalidOperationRequest();
      }
      values.push(descriptor.value);
    }
    return values;
  } catch (error) {
    if (error instanceof OperationWireRequestError) throw error;
    throw invalidOperationRequest();
  }
}

function operationConst(value: unknown, expected: string): void {
  if (value !== expected) throw invalidOperationRequest();
}

function operationSurface(value: unknown): void {
  if (value !== "chat" && value !== "work") throw invalidOperationRequest();
}

function operationId(value: unknown): void {
  if (typeof value !== "string" || !OPERATION_UUID_PATTERN.test(value)) throw invalidOperationRequest();
}

function operationDigest(value: unknown): void {
  if (typeof value !== "string" || !OPERATION_DIGEST_PATTERN.test(value)) throw invalidOperationRequest();
}

function operationText(value: unknown, maxBytes: number, nonEmpty: boolean): void {
  if (typeof value !== "string"
    || (nonEmpty && value.length === 0)
    || !isWellFormedUnicode(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) throw invalidOperationRequest();
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function operationOpaqueId(value: unknown, maxBytes: number): void {
  operationText(value, maxBytes, true);
  if (typeof value !== "string"
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidOperationRequest();
}

function invalidOperationRequest(): OperationWireRequestError {
  return new OperationWireRequestError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

const OPERATION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATION_DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const OPERATION_PHASES = new Set([
  "prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed", "uncertain"
]);
const OPERATION_BOUNDARIES = new Set(["none", "handoff_may_have_occurred", "send_may_have_occurred", "control_may_have_occurred"]);
const MAX_OPERATION_JSON_DEPTH = 16;
const MAX_OPERATION_JSON_NODES = 10_000;
const MAX_OPERATION_JSON_UTF8_BYTES = 1024 * 1024;
