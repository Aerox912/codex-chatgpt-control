import { describe, expect, it } from "vitest";
import {
  BACKEND_EVENT_SCHEMA_VERSION,
  BACKEND_REQUEST_SCHEMA_VERSION,
  BACKEND_RESPONSE_SCHEMA_VERSION,
  ProtocolError,
  backendEvent,
  backendEventCompleted,
  backendResponseError,
  backendResponseOk,
  parseBackendRequest
} from "../../src/backend/protocol.js";

describe("backend protocol", () => {
  it("parses valid request envelopes", () => {
    const request = parseBackendRequest({
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      requestId: "req_123",
      command: "runner.run",
      payload: {
        agent: { name: "reviewer" },
        input: "reply with hi"
      }
    });

    expect(request).toEqual({
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      requestId: "req_123",
      command: "runner.run",
      payload: {
        agent: { name: "reviewer" },
        input: "reply with hi"
      }
    });
  });

  it("parses the additive backend hello command", () => {
    const request = parseBackendRequest({
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      requestId: "req_hello",
      command: "backend.hello",
      payload: {
        protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        capabilities: {
          requestIds: { required: true, scope: "connection" }
        }
      }
    });

    expect(request.command).toBe("backend.hello");
    expect(request.payload).toMatchObject({
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION
    });
  });

  it("parses the additive transactional operation commands", () => {
    for (const command of [
      "operations.submit",
      "operations.collect",
      "operations.inspect",
      "operations.control"
    ] as const) {
      const request = parseBackendRequest({
        schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        requestId: `req_${command}`,
        command,
        payload: {}
      });
      expect(request.command).toBe(command);
    }
  });

  it("rejects unknown schema versions", () => {
    expect(() => parseBackendRequest({
      schemaVersion: "chatgpt.browser_control.backend_request.v0",
      requestId: "req_123",
      command: "runner.run",
      payload: {}
    })).toThrow(new ProtocolError(
      "unsupported_schema_version",
      "Unsupported backend request schemaVersion: chatgpt.browser_control.backend_request.v0",
      false
    ));
  });

  it("rejects unknown commands", () => {
    expect(() => parseBackendRequest({
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      requestId: "req_123",
      command: "runner.nope",
      payload: {}
    })).toThrow(new ProtocolError("unknown_command", "Unknown backend command: runner.nope", false));
  });

  it("bounds request ids and rejects control characters", () => {
    for (const requestId of ["x".repeat(4097), "req\nunsafe", "  req"]) {
      expect(() => parseBackendRequest({
        schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        requestId,
        command: "backend.health",
        payload: {}
      })).toThrow(new ProtocolError(
        "invalid_request",
        "Backend request requestId must be a non-empty string when provided.",
        false
      ));
    }
  });

  it("serializes successful responses with request id", () => {
    expect(backendResponseOk("req_123", { status: "ok" })).toEqual({
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      requestId: "req_123",
      ok: true,
      result: { status: "ok" }
    });
  });

  it("serializes protocol errors", () => {
    expect(backendResponseError("req_123", new ProtocolError("invalid_request", "Bad request.", false))).toEqual({
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      requestId: "req_123",
      ok: false,
      error: {
        code: "invalid_request",
        message: "Bad request.",
        recoverable: false
      }
    });
  });

  it("redacts arbitrary error messages at the backend boundary", () => {
    const secret = "private prompt and /private/local/path";
    const response = backendResponseError("req_123", new Error(secret));

    expect(response.error).toEqual({
      code: "invalid_request",
      message: "Backend command failed safely.",
      recoverable: false
    });
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it("serializes stream milestone events", () => {
    expect(backendEvent("req_123", {
      type: "run_item_stream_event",
      name: "message_completed",
      item: { type: "message.completed", role: "assistant", output_text: "hi", format: "markdown" }
    })).toEqual({
      schemaVersion: BACKEND_EVENT_SCHEMA_VERSION,
      requestId: "req_123",
      type: "run_item_stream_event",
      name: "message_completed",
      item: { type: "message.completed", role: "assistant", output_text: "hi", format: "markdown" }
    });
  });

  it("serializes final completed events", () => {
    expect(backendEventCompleted("req_123", { status: "ok", output_text: "hi" })).toEqual({
      schemaVersion: BACKEND_EVENT_SCHEMA_VERSION,
      requestId: "req_123",
      type: "completed",
      result: { status: "ok", output_text: "hi" }
    });
  });
});
