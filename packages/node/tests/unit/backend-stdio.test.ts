import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BackendSession } from "../../src/backend/session.js";
import { runBackendStdioServer } from "../../src/backend/stdio-server.js";
import {
  BACKEND_EVENT_SCHEMA_VERSION,
  BACKEND_RESPONSE_SCHEMA_VERSION,
  BACKEND_REQUEST_SCHEMA_VERSION,
  type BackendEvent,
  type BackendResponse,
  type BackendRequest
} from "../../src/backend/protocol.js";

describe("backend stdio server", () => {
  it("writes one NDJSON response for one NDJSON request", async () => {
    const server = startServer();

    server.input.write(`${JSON.stringify(request("backend.health"))}\n`);
    server.input.end();

    await server.done;
    expect(server.stdoutLines()).toEqual([
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          ok: true,
          status: "ok"
        })
      })
    ]);
  });

  it("handles multiple requests in one long-lived session", async () => {
    const server = startServer();

    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_health"))}\n`);
    server.input.write(`${JSON.stringify(request("backend.capabilities", {}, "req_capabilities"))}\n`);
    server.input.end();

    await server.done;
    const lines = server.stdoutLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ requestId: "req_health", ok: true });
    expect(lines[1]).toMatchObject({
      requestId: "req_capabilities",
      ok: true,
      result: expect.objectContaining({
        commands: expect.arrayContaining(["runner.run"])
      })
    });
  });

  it("returns protocol errors for invalid JSON and keeps processing", async () => {
    const server = startServer();

    server.input.write("not-json\n");
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_after_error"))}\n`);
    server.input.end();

    await server.done;
    const lines = server.stdoutLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        recoverable: false
      }
    });
    expect(lines[1]).toMatchObject({
      requestId: "req_after_error",
      ok: true
    });
  });

  it("streams milestone events and a final completed event", async () => {
    const server = startServer(new BackendSession({
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      limits: { maxPromptsPerRun: 0 }
    }));

    server.input.write(`${JSON.stringify(request("runner.stream", {
      agent: { name: "reviewer" },
      input: "reply with hi"
    }, "req_stream"))}\n`);
    server.input.end();

    await server.done;
    const lines = server.stdoutLines();
    expect(lines).toEqual([
      expect.objectContaining({
        requestId: "req_stream",
        type: "run_item_stream_event",
        name: "run_blocked",
        item: expect.objectContaining({ type: "run.blocked" })
      }),
      expect.objectContaining({
        requestId: "req_stream",
        type: "completed",
        result: expect.objectContaining({
          status: "needs_confirmation",
          output_text: ""
        })
      })
    ]);
  });

  it("does not block later requests behind a long-running stream", async () => {
    const server = startServer(new SlowStreamSession());

    server.input.write(`${JSON.stringify(request("runner.stream", {}, "req_stream"))}\n`);
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_health"))}\n`);
    server.input.end();

    await server.done;
    const lines = server.stdoutLines();
    expect(lines[0]).toMatchObject({
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      requestId: "req_health",
      ok: true
    });
    expect(lines.map(line => line.requestId)).toEqual(["req_health", "req_stream", "req_stream"]);
  });

  it("fails closed on an overlapping unary duplicate without settling the original", async () => {
    const session = new BlockingSession("unary");
    const server = startServer(session);

    server.input.write(`${JSON.stringify(request("backend.health", { prompt: "do not echo this" }, "req_duplicate"))}\n`);
    await session.firstStarted;
    server.input.write(`${JSON.stringify(request("backend.health", { prompt: "second secret" }, "req_duplicate"))}\n`);
    await server.inputClosed;
    expect(session.dispatchCount).toBe(1);
    expect(server.stdoutLines()).toEqual([]);

    session.releaseFirst();
    await server.done;
    expect(session.dispatchCount).toBe(1);
    expect(server.stdoutLines()).toEqual([
      expect.objectContaining({
        requestId: "req_duplicate",
        ok: true
      })
    ]);
  });

  it("drops an overlapping stream duplicate while preserving the unary route", async () => {
    const session = new BlockingSession("unary");
    const server = startServer(session);

    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_cross_kind"))}\n`);
    await session.firstStarted;
    server.input.write(`${JSON.stringify(request("runner.stream", {}, "req_cross_kind"))}\n`);
    await server.inputClosed;
    expect(session.streamCount).toBe(0);
    expect(server.stdoutLines()).toEqual([]);

    session.releaseFirst();
    await server.done;
    expect(session.dispatchCount).toBe(1);
    expect(session.streamCount).toBe(0);
    expect(server.stdoutLines()).toEqual([
      expect.objectContaining({
        requestId: "req_cross_kind",
        ok: true
      })
    ]);
  });

  it("fails closed before parsing a malformed duplicate request", async () => {
    const session = new BlockingSession("unary");
    const server = startServer(session);

    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_malformed_duplicate"))}\n`);
    await session.firstStarted;
    server.input.write(`${JSON.stringify({
      ...request("backend.health", {}, "req_malformed_duplicate"),
      command: "not-a-backend-command"
    })}\n`);
    await server.inputClosed;
    expect(session.dispatchCount).toBe(1);
    expect(server.stdoutLines()).toEqual([]);

    session.releaseFirst();
    await server.done;
    expect(server.stdoutLines()).toEqual([
      expect.objectContaining({
        requestId: "req_malformed_duplicate",
        ok: true
      })
    ]);
  });

  it("fails closed on an active duplicate before a maxInFlight slot opens", async () => {
    const session = new BlockingSession("unary");
    const server = startServer(session, { maxInFlight: 1 });

    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_slot_duplicate"))}\n`);
    await session.firstStarted;
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_slot_duplicate"))}\n`);
    await server.inputClosed;
    expect(session.dispatchCount).toBe(1);
    expect(server.stdoutLines()).toEqual([]);

    session.releaseFirst();
    await server.done;
    expect(session.dispatchCount).toBe(1);
    expect(server.stdoutLines()).toEqual([
      expect.objectContaining({
        requestId: "req_slot_duplicate",
        ok: true
      })
    ]);
  });

  it("allows sequential reuse after the previous route's terminal response settles", async () => {
    const session = new CountingSession();
    const server = startServer(session);

    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_reusable"))}\n`);
    await server.waitForStdoutLines(1);
    await new Promise(resolve => setImmediate(resolve));
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_reusable"))}\n`);
    server.input.end();

    await server.done;
    expect(session.maxInFlight).toBe(1);
    expect(server.stdoutLines()).toHaveLength(2);
    expect(server.stdoutLines().every(line => line.ok === true)).toBe(true);
  });

  it("keeps distinct requestIds concurrent and permits out-of-order unary responses", async () => {
    const session = new OutOfOrderSession();
    const server = startServer(session);

    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_slow"))}\n`);
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_fast"))}\n`);
    server.input.end();

    await server.done;
    expect(session.maxInFlight).toBe(2);
    expect(server.stdoutLines().map(line => line.requestId)).toEqual(["req_fast", "req_slow"]);
  });

  it("releases a requestId after a handler failure so it can be reused", async () => {
    const session = new FailOnceSession();
    const server = startServer(session);

    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_fail_once"))}\n`);
    await server.waitForStdoutLines(1);
    expect(server.stdoutLines()[0]).toMatchObject({
      requestId: "req_fail_once",
      ok: false,
      // Arbitrary handler text is deliberately redacted at the protocol
      // boundary; requestId remains stable so the route can be reused.
      error: {
        code: "invalid_request",
        message: "Backend command failed safely.",
        recoverable: false
      }
    });
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_fail_once"))}\n`);
    server.input.end();

    await server.done;
    expect(session.dispatchCount).toBe(2);
    expect(server.stdoutLines()).toHaveLength(2);
    expect(server.stdoutLines()[1]).toMatchObject({ requestId: "req_fail_once", ok: true });
  });

  it("bounds inbound frames and rejects an unterminated frame without emitting a response", async () => {
    const oversized = startServer(undefined, { frameLimitBytes: 64 });
    oversized.input.write("x".repeat(128));
    oversized.input.write("\n");
    oversized.input.end();
    await oversized.done;
    expect(oversized.stdoutLines()).toEqual([]);

    const unterminated = startServer(undefined, { frameLimitBytes: 4096 });
    unterminated.input.write(JSON.stringify(request("backend.health")));
    unterminated.input.end();
    await unterminated.done;
    expect(unterminated.stdoutLines()).toEqual([]);

    const invalidEncoding = startServer();
    invalidEncoding.input.write(Buffer.from([0xff, 0x0a]));
    invalidEncoding.input.end();
    await invalidEncoding.done;
    expect(invalidEncoding.stdoutLines()).toEqual([]);
  });

  it("closes the server route when an outbound frame exceeds the bound", async () => {
    const session = new OversizedSession();
    const server = startServer(session, { frameLimitBytes: 256 });
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_oversized"))}\n`);
    server.input.write(`${JSON.stringify(request("backend.health", {}, "req_after_output_failure"))}\n`);
    server.input.end();

    await server.done;
    expect(server.stdoutLines()).toEqual([]);
    expect(session.dispatchCount).toBe(1);
  });

  it("bounds in-flight server tasks while retaining concurrent dispatch below the bound", async () => {
    const session = new CountingSession();
    const server = startServer(session, { maxInFlight: 2 });
    for (let index = 0; index < 5; index += 1) {
      server.input.write(`${JSON.stringify(request("backend.health", {}, `req_health_${index}`))}\n`);
    }
    server.input.end();

    await server.done;
    expect(session.maxInFlight).toBeGreaterThan(1);
    expect(session.maxInFlight).toBeLessThanOrEqual(2);
    expect(server.stdoutLines()).toHaveLength(5);
  });
});

function startServer(
  session = new BackendSession({ now: () => new Date("2026-06-06T00:00:00.000Z") }),
  options: { maxInFlight?: number; frameLimitBytes?: number } = {}
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  let stdout = "";
  let stderrText = "";

  output.setEncoding("utf8");
  output.on("data", chunk => {
    stdout += chunk as string;
  });
  stderr.setEncoding("utf8");
  stderr.on("data", chunk => {
    stderrText += chunk as string;
  });

  const inputClosed = new Promise<void>(resolve => input.once("close", resolve));
  const done = runBackendStdioServer({
    input,
    output,
    error: stderr,
    session,
    ...options
  });

  const stdoutLines = () => stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  return {
    input,
    done,
    inputClosed,
    stdoutLines,
    waitForStdoutLines: async (count: number): Promise<void> => {
      const deadline = Date.now() + 1_000;
      while (stdoutLines().length < count) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} stdout lines.`);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    },
    stderrText: () => stderrText
  };
}

function request(command: string, payload: Record<string, unknown> = {}, requestId = `req_${command}`) {
  return {
    schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
    requestId,
    command,
    payload
  };
}

class SlowStreamSession extends BackendSession {
  override async dispatch(request: BackendRequest): Promise<BackendResponse> {
    return {
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ok: true as const,
      result: { ok: true, status: "ok" }
    } satisfies BackendResponse;
  }

  override async *stream(request: BackendRequest): AsyncIterable<BackendEvent> {
    await new Promise(resolve => setTimeout(resolve, 50));
    yield {
      schemaVersion: BACKEND_EVENT_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      type: "run_item_stream_event" as const,
      name: "message_completed",
      item: { type: "message.completed" }
    } satisfies BackendEvent;
    yield {
      schemaVersion: BACKEND_EVENT_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      type: "completed" as const,
      result: { ok: true, status: "ok" }
    } satisfies BackendEvent;
  }
}

class CountingSession extends BackendSession {
  active = 0;
  maxInFlight = 0;

  override async dispatch(request: BackendRequest): Promise<BackendResponse> {
    this.active += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.active);
    await new Promise(resolve => setTimeout(resolve, 15));
    this.active -= 1;
    return {
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ok: true as const,
      result: { ok: true, status: "ok" }
    } satisfies BackendResponse;
  }
}

class BlockingSession extends BackendSession {
  readonly firstStarted: Promise<void>;
  private resolveFirstStarted!: () => void;
  private resolveFirst!: () => void;
  private readonly firstReleased: Promise<void>;
  dispatchCount = 0;
  streamCount = 0;

  constructor(private readonly firstKind: "unary" | "stream") {
    super({ now: () => new Date("2026-06-06T00:00:00.000Z") });
    this.firstStarted = new Promise(resolve => {
      this.resolveFirstStarted = resolve;
    });
    this.firstReleased = new Promise(resolve => {
      this.resolveFirst = resolve;
    });
  }

  releaseFirst(): void {
    this.resolveFirst();
  }

  override async dispatch(request: BackendRequest): Promise<BackendResponse> {
    this.dispatchCount += 1;
    if (this.firstKind === "unary" && this.dispatchCount === 1) {
      this.resolveFirstStarted();
      await this.firstReleased;
    }
    return {
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ok: true as const,
      result: { ok: true, status: "ok" }
    } satisfies BackendResponse;
  }

  override async *stream(request: BackendRequest): AsyncIterable<BackendEvent> {
    this.streamCount += 1;
    if (this.firstKind === "stream" && this.streamCount === 1) {
      this.resolveFirstStarted();
      await this.firstReleased;
    }
    yield {
      schemaVersion: BACKEND_EVENT_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      type: "completed" as const,
      result: { ok: true, status: "ok" }
    } satisfies BackendEvent;
  }
}

class OutOfOrderSession extends BackendSession {
  active = 0;
  maxInFlight = 0;

  override async dispatch(request: BackendRequest): Promise<BackendResponse> {
    this.active += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.active);
    if (request.requestId === "req_slow") await new Promise(resolve => setTimeout(resolve, 20));
    this.active -= 1;
    return {
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ok: true as const,
      result: { requestId: request.requestId }
    } satisfies BackendResponse;
  }
}

class FailOnceSession extends BackendSession {
  dispatchCount = 0;

  override async dispatch(request: BackendRequest): Promise<BackendResponse> {
    this.dispatchCount += 1;
    if (this.dispatchCount === 1) throw new Error("synthetic handler failure");
    return {
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ok: true as const,
      result: { ok: true, status: "ok" }
    } satisfies BackendResponse;
  }
}

class OversizedSession extends BackendSession {
  dispatchCount = 0;

  override async dispatch(request: BackendRequest): Promise<BackendResponse> {
    this.dispatchCount += 1;
    return {
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ok: true,
      result: { padding: "x".repeat(1024) }
    };
  }
}
