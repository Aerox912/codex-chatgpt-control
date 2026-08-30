import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendSession } from "../../src/backend/session.js";
import {
  BACKEND_REQUEST_SCHEMA_VERSION,
  parseBackendRequest
} from "../../src/backend/protocol.js";
import {
  OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
  OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_INSPECT_REQUEST_SCHEMA_VERSION,
  OPERATION_REQUEST_SCHEMA_VERSION,
  type OperationCollectRequestV1,
  type OperationControlRequestV1,
  type OperationHandleV1,
  type OperationInspectRequestV1,
  type OperationSubmitRequestV1
} from "../../src/operations/types.js";
import {
  OperationWireRequestError,
  validateOperationCollectRequest,
  validateOperationControlRequest,
  validateOperationInspectRequest,
  validateOperationSubmitRequest
} from "../../src/operations/wire-requests.js";

describe("transactional operation wire request validators", () => {
  it("accepts the direct v1 request envelopes", () => {
    const submit = submitRequest();
    const collect: OperationCollectRequestV1 = {
      schemaVersion: OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
      handle: handle(),
      pollIntervalMs: 250
    };
    const inspect: OperationInspectRequestV1 = {
      schemaVersion: OPERATION_INSPECT_REQUEST_SCHEMA_VERSION,
      handle: handle()
    };
    const control: OperationControlRequestV1 = {
      schemaVersion: OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
      controlActionId: "22222222-2222-4222-8222-222222222222",
      parent: { ...handle(), phase: "generating", targetBindingDigest: digest("d") },
      action: "stop",
      expectedAssistantTurnId: "assistant-turn-1"
    };

    expect(() => validateOperationSubmitRequest(submit)).not.toThrow();
    expect(() => validateOperationCollectRequest(collect)).not.toThrow();
    expect(() => validateOperationInspectRequest(inspect)).not.toThrow();
    expect(() => validateOperationControlRequest(control)).not.toThrow();
  });

  it("bounds collect polling and rejects unsupported aliases", () => {
    const collect = {
      schemaVersion: OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
      handle: handle(),
      pollIntervalMs: 0
    } satisfies OperationCollectRequestV1;
    expect(() => validateOperationCollectRequest(collect)).not.toThrow();
    expect(() => validateOperationCollectRequest({ ...collect, pollIntervalMs: 60_000 })).not.toThrow();

    for (const pollIntervalMs of [true, 1.5, -1, 60_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateOperationCollectRequest({ ...collect, pollIntervalMs } as unknown as OperationCollectRequestV1))
        .toThrowError(OperationWireRequestError);
    }
    expect(() => validateOperationCollectRequest({
      ...collect,
      poll_interval_ms: 250
    } as unknown as OperationCollectRequestV1)).toThrowError(OperationWireRequestError);
  });

  it("accepts multiline prompt content on submit and steer envelopes", () => {
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      prompt: "First line\n\tindented code\r\nlast line"
    })).not.toThrow();
    expect(() => validateOperationControlRequest({
      schemaVersion: OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
      controlActionId: "22222222-2222-4222-8222-222222222222",
      parent: { ...handle(), phase: "generating", targetBindingDigest: digest("d") },
      action: "steer",
      expectedAssistantTurnId: "assistant-turn-1",
      steerPrompt: "Change direction:\n\tuse the second approach."
    })).not.toThrow();
  });

  it("accepts an exact Project target and rejects non-canonical creation authority", () => {
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      target: {
        type: "project",
        name: "Pokémon Burning Scales",
        icon: "Folder",
        color: "blue",
        confirmCreation: true
      }
    })).not.toThrow();
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      target: {
        type: "project",
        name: "Pokémon Burning Scales",
        confirmCreation: false
      }
    } as unknown as OperationSubmitRequestV1)).toThrowError(OperationWireRequestError);
  });

  it("rejects wrapper envelopes and unknown fields as closed shapes", () => {
    const submit = submitRequest();
    const collect: OperationCollectRequestV1 = {
      schemaVersion: OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
      handle: handle()
    };
    const inspect: OperationInspectRequestV1 = {
      schemaVersion: OPERATION_INSPECT_REQUEST_SCHEMA_VERSION,
      handle: handle()
    };
    const control: OperationControlRequestV1 = {
      schemaVersion: OPERATION_CONTROL_REQUEST_SCHEMA_VERSION,
      controlActionId: "22222222-2222-4222-8222-222222222222",
      parent: { ...handle(), phase: "generating", targetBindingDigest: digest("d") },
      action: "stop",
      expectedAssistantTurnId: "assistant-turn-1"
    };

    for (const [validator, request] of [
      [validateOperationSubmitRequest, submit],
      [validateOperationCollectRequest, collect],
      [validateOperationInspectRequest, inspect],
      [validateOperationControlRequest, control]
    ] as const) {
      expect(() => validator({ request })).toThrowError(OperationWireRequestError);
      expect(() => validator({ ...request, unexpected: true })).toThrowError(OperationWireRequestError);
    }
  });

  it("does not execute accessors and never includes request values in validation errors", () => {
    let reads = 0;
    const request = submitRequest() as Record<string, unknown>;
    Object.defineProperty(request, "prompt", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private prompt should not be read");
      }
    });

    let error: unknown;
    try {
      validateOperationSubmitRequest(request);
    } catch (caught) {
      error = caught;
    }

    expect(reads).toBe(0);
    expect(error).toBeInstanceOf(OperationWireRequestError);
    expect(error).toMatchObject({
      code: "invalid_operation_request",
      message: "Transactional operation request is invalid.",
      recoverable: false
    });
    expect(String(error)).not.toContain("private prompt");
  });

  it("enforces prompt, file, and JSON bounds", () => {
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      prompt: "x".repeat(8 * 1024 * 1024 + 1)
    })).toThrowError(OperationWireRequestError);
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      files: [{ path: "/tmp/" + "x".repeat(4096) }]
    })).toThrowError(OperationWireRequestError);
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      timeoutMs: -1
    })).toThrowError(OperationWireRequestError);
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      configuration: { additional: { value: Number.NaN } }
    })).toThrowError(OperationWireRequestError);
  });

  it("applies UTF-8 byte budgets consistently to bounded text and additional JSON", () => {
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      files: [{ path: "🙂".repeat(1025) }]
    })).toThrowError(OperationWireRequestError);
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      configuration: { model: "🙂".repeat(65) }
    })).toThrowError(OperationWireRequestError);
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      configuration: { additional: { value: "x".repeat(1024 * 1024 + 1) } }
    })).toThrowError(OperationWireRequestError);
    expect(() => validateOperationSubmitRequest({
      ...submitRequest(),
      prompt: "\ud800"
    })).toThrowError(OperationWireRequestError);
  });

  it("rejects server-side request wrappers before operation dispatch", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "chatgpt-operation-wire-"));
    try {
      const session = new BackendSession({ operations: { stateRoot } });
      const response = await session.dispatch(parseBackendRequest({
        schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        requestId: "req_operation_wrapper",
        command: "operations.inspect",
        payload: { request: { handle: "private handle payload" } }
      }));

      expect(response).toMatchObject({
        ok: false,
        requestId: "req_operation_wrapper",
        error: {
          code: "invalid_request",
          message: "Transactional operation payload is invalid.",
          recoverable: false
        }
      });
      expect(JSON.stringify(response)).not.toContain("private handle payload");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

function submitRequest(): OperationSubmitRequestV1 {
  return {
    schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
    operationId: "11111111-1111-4111-8111-111111111111",
    surface: "chat",
    prompt: "Reply with hi.",
    target: { type: "new" }
  };
}

function handle(): OperationHandleV1 {
  return {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: "11111111-1111-4111-8111-111111111111",
    requestDigest: digest("a"),
    surface: "chat",
    revision: 1,
    phase: "prepared",
    mutationBoundary: "none"
  };
}

function digest(letter: string): string {
  return `hmac-sha256:${letter.repeat(64)}`;
}
