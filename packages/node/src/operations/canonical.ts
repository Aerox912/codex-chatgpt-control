import { createHmac } from "node:crypto";
import type { OperationRequestIdentityInput } from "./types.js";

const DIGEST_PREFIX = "hmac-sha256:";

// Canonicalization is used on durable, authenticated material. Keep the
// limits deliberately generous for normal operation records, but make a
// caller/provider supplied graph incapable of consuming unbounded memory.
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_PROPERTIES = 32_768;
const MAX_CANONICAL_ARRAY_LENGTH = 32_768;
const MAX_CANONICAL_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_KEY_BYTES = 4096;
const SAFE_CANONICAL_ERROR = "Canonical JSON input could not be inspected safely.";
const RESERVED_CANONICAL_KEYS = new Set(["$undefined", "$date", "$bytes"]);

type CanonicalBudget = {
  nodes: number;
  properties: number;
  bytes: number;
};

type DescriptorMap = Record<string | symbol, PropertyDescriptor>;

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength"
)?.get;

export function canonicalJson(value: unknown): string {
  const budget: CanonicalBudget = { nodes: 0, properties: 0, bytes: 0 };
  const canonical = canonicalValue(value, new WeakSet<object>(), budget, 0);
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(canonical);
  } catch {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
  if (typeof encoded !== "string") throw new TypeError(SAFE_CANONICAL_ERROR);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_BYTES) {
    throw new TypeError("Canonical JSON exceeds the bounded byte limit.");
  }
  return encoded;
}

export function hmacDigest(key: Uint8Array, domain: string, value: unknown): string {
  const hmac = createHmac("sha256", key);
  hmac.update(`${domain}\0`, "utf8");
  hmac.update(canonicalJson(value), "utf8");
  return `${DIGEST_PREFIX}${hmac.digest("hex")}`;
}

export function operationRequestDigest(key: Uint8Array, input: OperationRequestIdentityInput): string {
  const inputValues = safeRecordValues(input, [
    "operationId", "surface", "target", "prompt", "configuration", "tools", "files", "capturePolicy", "behavior"
  ]);
  const operationId = inputValues.get("operationId");
  const surface = inputValues.get("surface");
  const target = inputValues.get("target");
  const prompt = inputValues.get("prompt");
  const configuration = inputValues.get("configuration");
  const tools = inputValues.get("tools");
  const files = inputValues.get("files");
  const capturePolicy = inputValues.get("capturePolicy");
  const behavior = inputValues.get("behavior");

  if (typeof prompt !== "string") throw new TypeError(SAFE_CANONICAL_ERROR);
  const fileProjection: {
    displayNameDigest: string;
    bytes: number;
    contentDigest: string;
  }[] = [];
  if (files !== undefined) {
    for (const file of safeArrayElements(files)) {
      fileProjection.push(canonicalFileProjection(key, file));
    }
  }

  return hmacDigest(key, "codex-chatgpt-control/operation-request/v1", {
    schemaVersion: "chatgpt.browser_control.operation_request_identity.v1",
    operationId,
    surface,
    target,
    prompt: {
      digest: hmacDigest(key, "codex-chatgpt-control/prompt/v1", prompt),
      bytes: Buffer.byteLength(prompt, "utf8")
    },
    configuration,
    tools,
    files: fileProjection,
    // Capture format is part of the immutable request identity. Older
    // request records omitted it, so canonicalize an omitted/undefined value
    // to the historical default instead of allowing an equivalent request to
    // hash differently after a restart.
    capturePolicy: canonicalCapturePolicy(capturePolicy),
    behavior
  });
}

function canonicalFileProjection(key: Uint8Array, value: unknown): {
  displayNameDigest: string;
  bytes: number;
  contentDigest: string;
} {
  const values = safeRecordValues(value, ["displayName", "bytes", "contentSha256"]);
  const displayName = values.get("displayName");
  const bytes = values.get("bytes");
  const contentSha256 = values.get("contentSha256");
  if (
    typeof displayName !== "string"
    || !Number.isSafeInteger(bytes)
    || typeof contentSha256 !== "string"
  ) {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
  const byteCount = bytes as number;
  return {
    displayNameDigest: hmacDigest(
      key,
      "codex-chatgpt-control/file-display-name/v1",
      displayName.normalize("NFC")
    ),
    bytes: byteCount,
    contentDigest: hmacDigest(
      key,
      "codex-chatgpt-control/file-content-sha256/v1",
      contentSha256.toLowerCase()
    )
  };
}

function canonicalCapturePolicy(value: unknown): unknown {
  if (value === undefined) {
    return {
      responseContent: "include",
      responseFormat: "markdown",
      artifacts: "receipt_only"
    };
  }
  const values = safeRecordValues(value, ["responseContent", "responseFormat", "artifacts", "outputDirectory"]);
  // Request-local destination authority is deliberately excluded from durable
  // operation identity. A transfer action binds its exact destination with
  // a separate keyed identity and receipt; retaining an absolute path here
  // would also make the same durable transfer obligation depend on
  // process-local spelling. Project only the closed, path-free capture
  // contract and expand every historical default so omitted and explicit
  // defaults hash identically.
  return {
    responseContent: values.get("responseContent") ?? "include",
    responseFormat: values.get("responseFormat") ?? "markdown",
    artifacts: values.get("artifacts") ?? "receipt_only"
  };
}

function canonicalValue(value: unknown, ancestors: WeakSet<object>, budget: CanonicalBudget, depth: number): unknown {
  consumeNode(budget, depth);
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    consumeBytes(budget, value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Canonical JSON does not support ${typeof value} values.`);
  }
  if (typeof value !== "object") throw new TypeError(SAFE_CANONICAL_ERROR);

  const object = value as object;
  if (ancestors.has(object)) {
    throw new TypeError("Canonical JSON does not support cyclic values.");
  }
  ancestors.add(object);
  try {
    const prototype = safeGetPrototype(object);
    let isArray = false;
    try {
      isArray = Array.isArray(object);
    } catch {
      throw new TypeError(SAFE_CANONICAL_ERROR);
    }
    if (isArray) {
      if (prototype !== Array.prototype) throw new TypeError("Canonical JSON supports only standard arrays.");
      return canonicalArray(object, ancestors, budget, depth);
    }
    if (prototype === Date.prototype) return canonicalDate(object, budget);
    if (prototype === Uint8Array.prototype) return canonicalBytes(object, budget);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON supports only plain objects, arrays, dates, and byte arrays.");
    }
    return canonicalObject(object, ancestors, budget, depth);
  } finally {
    ancestors.delete(object);
  }
}

function canonicalObject(value: object, ancestors: WeakSet<object>, budget: CanonicalBudget, depth: number): Record<string, unknown> {
  const descriptors = safeDescriptors(value);
  const keys = descriptorKeys(descriptors);
  if (keys.length > MAX_CANONICAL_PROPERTIES) throw new TypeError("Canonical JSON exceeds the bounded property limit.");
  const result = Object.create(null) as Record<string, unknown>;
  const stringKeys = [] as string[];
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("Canonical JSON does not support symbol properties.");
    stringKeys.push(key);
  }
  stringKeys.sort();
  for (const key of stringKeys) {
    if (RESERVED_CANONICAL_KEYS.has(key)) {
      throw new TypeError("Canonical JSON contains a reserved marker key.");
    }
    const descriptor = descriptorValue(descriptors, key);
    assertDataDescriptor(descriptor);
    if (descriptor.enumerable !== true) throw new TypeError("Canonical JSON supports only enumerable own data properties.");
    consumeProperty(budget, key);
    Object.defineProperty(result, key, {
      value: canonicalValue(descriptor.value, ancestors, budget, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return result;
}

function canonicalArray(value: object, ancestors: WeakSet<object>, budget: CanonicalBudget, depth: number): unknown[] {
  const descriptors = safeDescriptors(value);
  const keys = descriptorKeys(descriptors);
  const lengthDescriptor = descriptorValue(descriptors, "length");
  assertDataDescriptor(lengthDescriptor);
  if (lengthDescriptor.enumerable !== false || lengthDescriptor.configurable !== false || typeof lengthDescriptor.value !== "number") {
    throw new TypeError("Canonical JSON contains an invalid array length.");
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CANONICAL_ARRAY_LENGTH) {
    throw new TypeError("Canonical JSON contains an oversized array.");
  }
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("Canonical JSON does not support symbol properties.");
  }
  if (keys.length !== length + 1) throw new TypeError("Canonical JSON does not support sparse or custom arrays.");
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "length" && parseArrayIndex(key) === undefined)) {
      throw new TypeError("Canonical JSON does not support sparse or custom arrays.");
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptorValue(descriptors, String(index));
    assertDataDescriptor(descriptor);
    if (descriptor.enumerable !== true) throw new TypeError("Canonical JSON supports only enumerable array entries.");
    consumeProperty(budget, String(index));
    result.push(canonicalValue(descriptor.value, ancestors, budget, depth + 1));
  }
  return result;
}

function canonicalDate(value: object, budget: CanonicalBudget): { $date: string } {
  const descriptors = safeDescriptors(value);
  if (descriptorKeys(descriptors).length !== 0) throw new TypeError("Canonical JSON does not support custom date properties.");
  let iso: string;
  try {
    iso = Date.prototype.toISOString.call(value);
  } catch {
    throw new TypeError("Canonical JSON contains an invalid date.");
  }
  consumeBytes(budget, iso);
  return { $date: iso };
}

function canonicalBytes(value: object, budget: CanonicalBudget): { $bytes: string } {
  if (TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) throw new TypeError(SAFE_CANONICAL_ERROR);
  let byteLength: number;
  try {
    // This internal-slot check rejects a Proxy around a typed array without
    // reading any caller-controlled property or invoking a getter.
    byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
  } catch {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_CANONICAL_BYTES) {
    throw new TypeError("Canonical JSON contains an oversized byte array.");
  }
  const descriptors = safeDescriptors(value);
  const keys = descriptorKeys(descriptors);
  if (keys.length !== byteLength) throw new TypeError("Canonical JSON does not support custom byte-array properties.");
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    const key = String(index);
    const descriptor = descriptorValue(descriptors, key);
    assertDataDescriptor(descriptor);
    if (descriptor.enumerable !== true || typeof descriptor.value !== "number" || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) {
      throw new TypeError("Canonical JSON contains an invalid byte-array entry.");
    }
    bytes[index] = descriptor.value;
    consumeProperty(budget, key);
  }
  const encoded = Buffer.from(bytes).toString("base64");
  consumeBytes(budget, encoded);
  return { $bytes: encoded };
}

function safeRecordValues(value: unknown, allowed: readonly string[]): Map<string, unknown> {
  if (value === null || typeof value !== "object") throw new TypeError(SAFE_CANONICAL_ERROR);
  const prototype = safeGetPrototype(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(SAFE_CANONICAL_ERROR);
  const descriptors = safeDescriptors(value);
  const allowedSet = new Set(allowed);
  const values = new Map<string, unknown>();
  for (const key of descriptorKeys(descriptors)) {
    if (typeof key !== "string") throw new TypeError("Canonical JSON does not support symbol properties.");
    if (!allowedSet.has(key)) throw new TypeError("Canonical JSON contains an unsupported field.");
    const descriptor = descriptorValue(descriptors, key);
    assertDataDescriptor(descriptor);
    if (descriptor.enumerable !== true) throw new TypeError(SAFE_CANONICAL_ERROR);
    values.set(key, descriptor.value);
  }
  return values;
}

function safeArrayElements(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") throw new TypeError(SAFE_CANONICAL_ERROR);
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
  if (!isArray || safeGetPrototype(value) !== Array.prototype) throw new TypeError(SAFE_CANONICAL_ERROR);
  const descriptors = safeDescriptors(value);
  const lengthDescriptor = descriptorValue(descriptors, "length");
  assertDataDescriptor(lengthDescriptor);
  if (typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_CANONICAL_ARRAY_LENGTH) {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
  const length = lengthDescriptor.value;
  const keys = descriptorKeys(descriptors);
  if (keys.length !== length + 1) throw new TypeError(SAFE_CANONICAL_ERROR);
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "length" && parseArrayIndex(key) === undefined)) {
      throw new TypeError(SAFE_CANONICAL_ERROR);
    }
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptorValue(descriptors, String(index));
    assertDataDescriptor(descriptor);
    if (descriptor.enumerable !== true) throw new TypeError(SAFE_CANONICAL_ERROR);
    values.push(descriptor.value);
  }
  return values;
}

function safeGetPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
}

function safeDescriptors(value: object): DescriptorMap {
  let descriptors: DescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
  } catch {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
  return descriptors;
}

function descriptorKeys(descriptors: DescriptorMap): (string | symbol)[] {
  try {
    return Reflect.ownKeys(descriptors);
  } catch {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
}

function descriptorValue(descriptors: DescriptorMap, key: string | symbol): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(descriptors, key);
  } catch {
    throw new TypeError(SAFE_CANONICAL_ERROR);
  }
  if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(SAFE_CANONICAL_ERROR);
  return descriptor.value as PropertyDescriptor;
}

function assertDataDescriptor(descriptor: PropertyDescriptor): void {
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new TypeError("Canonical JSON supports only own data properties.");
  }
}

function parseArrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || index > 4_294_967_294 || String(index) !== key) return undefined;
  return index;
}

function consumeNode(budget: CanonicalBudget, depth: number): void {
  if (depth > MAX_CANONICAL_DEPTH || ++budget.nodes > MAX_CANONICAL_NODES) {
    throw new TypeError("Canonical JSON exceeds the bounded graph limit.");
  }
}

function consumeProperty(budget: CanonicalBudget, key: string): void {
  if (++budget.properties > MAX_CANONICAL_PROPERTIES) throw new TypeError("Canonical JSON exceeds the bounded property limit.");
  const bytes = Buffer.byteLength(key, "utf8");
  if (bytes > MAX_CANONICAL_KEY_BYTES) throw new TypeError("Canonical JSON contains an oversized property name.");
  consumeBytes(budget, key);
}

function consumeBytes(budget: CanonicalBudget, value: string): void {
  budget.bytes += Buffer.byteLength(value, "utf8");
  if (budget.bytes > MAX_CANONICAL_BYTES) throw new TypeError("Canonical JSON exceeds the bounded byte limit.");
}
