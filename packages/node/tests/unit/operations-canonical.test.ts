import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, hmacDigest, operationRequestDigest } from "../../src/operations/canonical.js";
import type { OperationRequestIdentityInput } from "../../src/operations/types.js";

const KEY = Buffer.alloc(32, 0x11);

type DigestVector = Readonly<{
  keyHex: string;
  input: OperationRequestIdentityInput & Readonly<{
    files: Array<{ displayName: string; bytes: number; contentSha256: string }>;
    capturePolicy: Readonly<{
      responseContent: string;
      responseFormat: string;
      artifacts: string;
      outputDirectory: string;
    }>;
  }>;
  expected: Readonly<{
    canonicalInput: string;
    promptDigest: string;
    displayNameDigest: string;
    contentDigest: string;
    requestDigest: string;
  }>;
}>;

describe("operation canonical identity", () => {
  it("orders object keys deterministically without changing array order", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: 2 }, list: ["b", "a"] })).toBe(
      '{"a":{"b":2,"d":4},"list":["b","a"],"z":1}'
    );
    expect(canonicalJson({ a: { b: 2, d: 4 }, list: ["b", "a"], z: 1 })).toBe(
      canonicalJson({ z: 1, list: ["b", "a"], a: { d: 4, b: 2 } })
    );
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
  });

  it("retains an own __proto__ data key in canonical JSON and request identity", () => {
    const firstConfiguration = Object.create(null) as Record<string, unknown>;
    const secondConfiguration = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(firstConfiguration, "__proto__", {
      value: "first-value",
      enumerable: true,
      writable: true,
      configurable: true
    });
    Object.defineProperty(secondConfiguration, "__proto__", {
      value: "second-value",
      enumerable: true,
      writable: true,
      configurable: true
    });

    expect(canonicalJson(firstConfiguration)).toBe('{"__proto__":"first-value"}');
    expect(canonicalJson(secondConfiguration)).toBe('{"__proto__":"second-value"}');
    expect(canonicalJson(firstConfiguration)).not.toBe(canonicalJson(secondConfiguration));

    const input = {
      operationId: "11111111-1111-4111-8111-111111111111",
      surface: "chat" as const,
      target: { type: "new" },
      prompt: "private prompt"
    };
    const firstDigest = operationRequestDigest(KEY, { ...input, configuration: { additional: firstConfiguration } });
    const secondDigest = operationRequestDigest(KEY, { ...input, configuration: { additional: secondConfiguration } });
    expect(firstDigest).not.toBe(secondDigest);
  });

  it("rejects accessor-backed records without invoking the getter", () => {
    let reads = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("hostile canonical getter");
      }
    });

    expect(() => canonicalJson(hostile)).toThrow("own data properties");
    expect(reads).toBe(0);
  });

  it("rejects accessor-backed arrays before reading an index", () => {
    let reads = 0;
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        throw new Error("hostile array getter");
      }
    });
    hostile.length = 1;

    expect(() => canonicalJson(hostile)).toThrow("own data properties");
    expect(reads).toBe(0);
  });

  it("rejects sparse, custom, symbol-keyed, and exotic arrays", () => {
    expect(() => canonicalJson(new Array(1))).toThrow(/sparse/);

    const custom: unknown[] = ["ok"];
    Object.defineProperty(custom, "extra", { value: "not-json", enumerable: true });
    expect(() => canonicalJson(custom)).toThrow(/sparse or custom/);

    const symbolArray: unknown[] = ["ok"];
    Object.defineProperty(symbolArray, Symbol("secret"), { value: "not-json", enumerable: true });
    expect(() => canonicalJson(symbolArray)).toThrow(/symbol/);

    class ArraySubclass extends Array<unknown> {}
    expect(() => canonicalJson(new ArraySubclass("ok"))).toThrow(/standard arrays/);
  });

  it("rejects reflection failures without echoing proxy error text", () => {
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("attacker-only-reflection-secret");
      }
    });

    let error: unknown;
    try {
      canonicalJson(hostile);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Canonical JSON input could not be inspected safely.");
    expect((error as Error).message).not.toContain("attacker-only-reflection-secret");
  });

  it("rejects reserved marker lookalikes so special encodings cannot collide", () => {
    expect(canonicalJson(undefined)).toBe('{"$undefined":true}');
    expect(() => canonicalJson({ $undefined: true })).toThrow(/reserved marker/);

    expect(canonicalJson(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      '{"$date":"2026-01-01T00:00:00.000Z"}'
    );
    expect(() => canonicalJson({ $date: "2026-01-01T00:00:00.000Z" })).toThrow(/reserved marker/);

    expect(canonicalJson(new Uint8Array([0x78]))).toBe('{"$bytes":"eA=="}');
    expect(() => canonicalJson({ $bytes: "eA==" })).toThrow(/reserved marker/);
  });

  it("bounds canonical graph depth, width, and encoded bytes", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 34; index += 1) deep = { value: deep };
    expect(() => canonicalJson(deep)).toThrow(/bounded graph/);

    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 32_769; index += 1) wide[`key-${index}`] = true;
    expect(() => canonicalJson(wide)).toThrow(/bounded property/);

    expect(() => canonicalJson("x".repeat(17 * 1024 * 1024))).toThrow(/bounded byte/);
  });

  it("represents undefined explicitly and rejects non-finite numbers", () => {
    expect(canonicalJson({ present: undefined })).toBe('{"present":{"$undefined":true}}');
    expect(() => canonicalJson(Number.NaN)).toThrow("non-finite");
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow("non-finite");
  });

  it("rejects cycles and non-plain object instances instead of silently collapsing them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cyclic");
    expect(() => canonicalJson(new Map([["private", "value"]]))).toThrow("plain objects");
  });

  it("domain-separates keyed digests", () => {
    expect(hmacDigest(KEY, "one", "same")).not.toBe(hmacDigest(KEY, "two", "same"));
    expect(hmacDigest(KEY, "one", "same")).not.toBe(hmacDigest(Buffer.alloc(32, 0x22), "one", "same"));
    expect(hmacDigest(KEY, "one", "same")).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
  });

  it("matches the fixed cross-language operation request digest vector", () => {
    const vector = JSON.parse(readFileSync(new URL(
      "../../contracts/v1/vectors/operation-request-digest-v1.json",
      import.meta.url
    ), "utf8")) as DigestVector;
    const key = Buffer.from(vector.keyHex, "hex");
    const file = vector.input.files[0]!;
    const promptDigest = hmacDigest(
      key,
      "codex-chatgpt-control/prompt/v1",
      vector.input.prompt
    );
    const displayNameDigest = hmacDigest(
      key,
      "codex-chatgpt-control/file-display-name/v1",
      file.displayName.normalize("NFC")
    );
    const contentDigest = hmacDigest(
      key,
      "codex-chatgpt-control/file-content-sha256/v1",
      file.contentSha256.toLowerCase()
    );
    const canonicalInput = canonicalJson({
      schemaVersion: "chatgpt.browser_control.operation_request_identity.v1",
      operationId: vector.input.operationId,
      surface: vector.input.surface,
      target: vector.input.target,
      prompt: {
        digest: promptDigest,
        bytes: Buffer.byteLength(vector.input.prompt, "utf8")
      },
      configuration: vector.input.configuration,
      tools: vector.input.tools,
      files: [{ displayNameDigest, bytes: file.bytes, contentDigest }],
      capturePolicy: {
        responseContent: vector.input.capturePolicy.responseContent,
        responseFormat: vector.input.capturePolicy.responseFormat,
        artifacts: vector.input.capturePolicy.artifacts
      },
      behavior: vector.input.behavior
    });

    expect(promptDigest).toBe(vector.expected.promptDigest);
    expect(displayNameDigest).toBe(vector.expected.displayNameDigest);
    expect(contentDigest).toBe(vector.expected.contentDigest);
    expect(canonicalInput).toBe(vector.expected.canonicalInput);
    expect(operationRequestDigest(key, vector.input)).toBe(vector.expected.requestDigest);
  });

  it("builds a stable request digest without embedding private prompt or names", () => {
    const input = {
      operationId: "11111111-1111-4111-8111-111111111111",
      surface: "chat" as const,
      target: { type: "new" },
      prompt: "private prompt words",
      configuration: { model: "Sol", effort: "High" },
      files: [{
        displayName: "secret-name.txt",
        bytes: 12,
        contentSha256: "a".repeat(64)
      }]
    };

    const first = operationRequestDigest(KEY, input);
    const reordered = operationRequestDigest(KEY, {
      ...input,
      configuration: { effort: "High", model: "Sol" }
    });
    expect(first).toBe(reordered);
    expect(first).not.toContain("private");
    expect(first).not.toContain("secret-name");
    expect(operationRequestDigest(KEY, { ...input, prompt: "different" })).not.toBe(first);
  });

  it("binds transactional response format into immutable request identity", () => {
    const input = {
      operationId: "11111111-1111-4111-8111-111111111111",
      surface: "chat" as const,
      target: { type: "conversation_id", conversationId: "conversation-1" },
      prompt: "private prompt",
      capturePolicy: { responseContent: "metadata", artifacts: "receipt_only" }
    };
    const implicitMarkdown = operationRequestDigest(KEY, input);
    const explicitMarkdown = operationRequestDigest(KEY, {
      ...input,
      capturePolicy: { ...input.capturePolicy, responseFormat: "markdown" }
    });
    const text = operationRequestDigest(KEY, {
      ...input,
      capturePolicy: { ...input.capturePolicy, responseFormat: "text" }
    });
    expect(implicitMarkdown).toBe(explicitMarkdown);
    expect(text).not.toBe(implicitMarkdown);
  });

  it("normalizes capture defaults and excludes request-local output authority from durable identity", () => {
    const input = {
      operationId: "11111111-1111-4111-8111-111111111111",
      surface: "chat" as const,
      target: { type: "conversation_id", conversationId: "conversation-1" },
      prompt: "private prompt"
    };
    const implicitDefaults = operationRequestDigest(KEY, input);
    const explicitDefaults = operationRequestDigest(KEY, {
      ...input,
      capturePolicy: {
        responseContent: "include",
        responseFormat: "markdown",
        artifacts: "receipt_only"
      }
    });
    expect(implicitDefaults).toBe(explicitDefaults);

    const firstDestination = operationRequestDigest(KEY, {
      ...input,
      capturePolicy: {
        responseContent: "include",
        responseFormat: "markdown",
        artifacts: "transfer",
        outputDirectory: "/private/first-destination"
      }
    });
    const secondDestination = operationRequestDigest(KEY, {
      ...input,
      capturePolicy: {
        responseContent: "include",
        responseFormat: "markdown",
        artifacts: "transfer",
        outputDirectory: "/private/second-destination"
      }
    });
    expect(firstDestination).toBe(secondDestination);
    expect(firstDestination).not.toBe(implicitDefaults);
  });
});
