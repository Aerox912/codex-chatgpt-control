import { describe, expect, it, vi } from "vitest";
import { createChatGPT } from "../../src/client.js";
import {
  createChatGPTBackendClient,
  StdioBackendTransport,
  type BackendTransport
} from "../../src/backend/client.js";
import { BackendSession } from "../../src/backend/session.js";
import {
  BACKEND_CONTROL_REQUEST_ID_PREFIX,
  BACKEND_REQUEST_SCHEMA_VERSION,
  BACKEND_RESPONSE_SCHEMA_VERSION,
  type BackendEvent,
  type BackendCompatibilityReport,
  type BackendRequest,
  type BackendResponse
} from "../../src/backend/protocol.js";
import type { ChatGPTInterruption } from "../../src/runner/types.js";
import {
  OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
  type OperationCollectRequestV1,
  type OperationHandleV1,
  OPERATION_REQUEST_SCHEMA_VERSION,
  type OperationSubmitRequestV1
} from "../../src/operations/types.js";

describe("ChatGPT backend client", () => {
  it("rejects unsafe persistent transport options before spawning", () => {
    for (const options of [
      { command: [] },
      { command: [""] },
      { command: ["   "] },
      { command: [process.execPath], timeoutMs: 0 },
      { command: [process.execPath], handshakeTimeoutMs: -1 },
      { command: [process.execPath], maxInFlight: 1 },
      { command: [process.execPath], maxInFlight: 0 },
      { command: [process.execPath], streamQueueLimit: 0 },
      { command: [process.execPath], streamQueueBytesLimit: 0 },
      { command: [process.execPath], writeQueueLimit: 0 },
      { command: [process.execPath], writeQueueBytesLimit: 0 },
      { command: [process.execPath], lateOutputGraceMs: 0 },
      { command: [process.execPath], tombstoneLimit: 0 },
      { command: [process.execPath], quarantineLimit: 0 },
      { command: [process.execPath], frameLimitBytes: 0 },
      { command: [process.execPath], frameLimitBytes: 16 * 1024 * 1024 + 1 }
    ]) {
      expect(() => new StdioBackendTransport(options)).toThrowError(/invalid_backend_options|must/);
    }
    expect(() => new StdioBackendTransport({
      command: [process.execPath],
      maxInFlight: 2,
      streamQueueBytesLimit: 16 * 1024 * 1024,
      writeQueueBytesLimit: 16 * 1024 * 1024
    })).not.toThrow();
  });

  it("rejects an empty direct transport request id before writing", async () => {
    const transport = new StdioBackendTransport({ command: [process.execPath, "-e", childScript("default")] });
    try {
      await expect(transport.request(backendRequest(""))).rejects.toMatchObject({
        code: "missing_request_id",
        recoverable: false
      });
    } finally {
      await transport.close();
    }
  });

  it("rejects oversized and transport-reserved request ids before spawning", async () => {
    const transport = new StdioBackendTransport({ command: [process.execPath, "-e", childScript("default")] });
    try {
      await expect(transport.request(backendRequest("x".repeat(4097)))).rejects.toMatchObject({
        code: "invalid_request_id",
        recoverable: false
      });
      await expect(transport.request(backendRequest("__backend_control__caller"))).rejects.toMatchObject({
        code: "reserved_request_id",
        recoverable: false
      });
    } finally {
      await transport.close();
    }
  });

  it("sends backend request envelopes", async () => {
    const transport = new RecordingTransport({
      ok: true,
      result: {
        ok: true,
        status: "ok",
        output_text: "hi",
        finalOutput: "hi",
        output: [],
        newItems: [],
        interruptions: [],
        state: { id: "state-1", resumable: false },
        activeAgentName: "reviewer",
        lastAgentName: "reviewer",
        warnings: [],
        context: { timestamp: "2026-06-06T00:00:00.000Z" }
      }
    });
    const chatgpt = createChatGPTBackendClient(transport);
    const agent = chatgpt.agent({ name: "reviewer", instructions: "Review deeply." });

    await chatgpt.runner.run(agent, "reply with hi");

    expect(transport.requests).toEqual([
      expect.objectContaining({
        schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        command: "runner.run",
        payload: {
          agent: expect.objectContaining({
            name: "reviewer",
            instructions: "Review deeply.",
            instructionsMode: "visible_prefix"
          }),
          input: "reply with hi"
        }
      })
    ]);
  });

  it("maps the Python-parity stop shape to the exact backend payload", async () => {
    const transport = new RecordingTransport({
      ok: true,
      result: {
        ok: false,
        status: "needs_confirmation",
        warnings: [],
        context: { timestamp: "2026-06-06T00:00:00.000Z" }
      }
    });
    const chatgpt = createChatGPTBackendClient(transport);

    await chatgpt.messages.stop({ confirmStop: true, timeoutMs: 250 });

    expect(transport.requests[0]).toMatchObject({
      command: "messages.stop",
      payload: { confirmStop: true, timeoutMs: 250 }
    });
  });

  it("exposes strict transactional operations on one canonical direct payload shape", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    const request: OperationSubmitRequestV1 = {
      schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
      operationId,
      surface: "chat",
      prompt: "Reply with hi.",
      target: { type: "new" }
    };
    const transport = new RecordingTransport({
      ok: true,
      result: {
        schemaVersion: "chatgpt.browser_control.operation_submit_result.v1",
        status: "accepted",
        operationId,
        requestDigest: "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        handle: {
          schemaVersion: "chatgpt.browser_control.operation_handle.v1",
          operationId,
          requestDigest: "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          surface: "chat",
          revision: 1,
          phase: "prepared",
          mutationBoundary: "none"
        }
      }
    });
    const backend = createChatGPTBackendClient(transport);

    await expect(backend.operations.submit(request)).resolves.toMatchObject({
      schemaVersion: "chatgpt.browser_control.operation_submit_result.v1",
      status: "accepted",
      operationId
    });
    expect(transport.requests[0]).toMatchObject({
      command: "operations.submit",
      payload: request
    });
  });

  it("forwards the bounded collect poll interval and validates it before transport", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    const requestDigest = "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const handle: OperationHandleV1 = {
      schemaVersion: "chatgpt.browser_control.operation_handle.v1",
      operationId,
      requestDigest,
      surface: "chat",
      revision: 4,
      phase: "generating",
      mutationBoundary: "send_may_have_occurred",
      targetBindingDigest: "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    };
    const request: OperationCollectRequestV1 = {
      schemaVersion: OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
      handle,
      wait: true,
      pollIntervalMs: 0
    };
    const transport = new RecordingTransport({
      ok: true,
      result: {
        schemaVersion: "chatgpt.browser_control.operation_collect_result.v1",
        status: "pending",
        operationId,
        requestDigest,
        handle
      }
    });
    const backend = createChatGPTBackendClient(transport);

    await expect(backend.operations.collect(request)).resolves.toMatchObject({
      status: "pending",
      operationId,
      handle
    });
    expect(transport.requests[0]).toMatchObject({
      command: "operations.collect",
      payload: request
    });

    for (const pollIntervalMs of [true, 1.5, -1, 60_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(backend.operations.collect({
        ...request,
        pollIntervalMs
      } as unknown as OperationCollectRequestV1)).rejects.toMatchObject({
        code: "invalid_operation_request"
      });
    }
    await expect(backend.operations.collect({
      ...request,
      poll_interval_ms: 250
    } as unknown as OperationCollectRequestV1)).rejects.toMatchObject({
      code: "invalid_operation_request"
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("rejects wrapped or extra-field operation requests before transport", async () => {
    const transport = new RecordingTransport({ ok: true, result: {} });
    const backend = createChatGPTBackendClient(transport);
    const request = {
      schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
      operationId: "11111111-1111-4111-8111-111111111111",
      surface: "chat",
      prompt: "Reply with hi.",
      target: { type: "new" },
      unexpected: true
    } as unknown as OperationSubmitRequestV1;

    await expect(backend.operations.submit(request)).rejects.toMatchObject({
      code: "invalid_operation_request"
    });
    await expect(backend.operations.submit({ request } as unknown as OperationSubmitRequestV1)).rejects.toMatchObject({
      code: "invalid_operation_request"
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects an invalid operation result after the backend response envelope", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    const transport = new RecordingTransport({ ok: true, result: {
      schemaVersion: "chatgpt.browser_control.operation_submit_result.v1",
      status: "accepted",
      operationId,
      requestDigest: "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      handle: {
        schemaVersion: "chatgpt.browser_control.operation_handle.v1",
        operationId,
        requestDigest: "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        surface: "chat",
        revision: 1,
        phase: "prepared",
        mutationBoundary: "none",
        extra: "must reject"
      }
    }});
    const backend = createChatGPTBackendClient(transport);
    const request: OperationSubmitRequestV1 = {
      schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
      operationId,
      surface: "chat",
      prompt: "Reply with hi.",
      target: { type: "new" }
    };

    await expect(backend.operations.submit(request)).rejects.toMatchObject({
      code: "invalid_operation_result",
      recoverable: true
    });
  });

  it("matches in-process runner plans", async () => {
    const options = deterministicOptions();
    const inProcess = createChatGPT(options);
    const backend = createChatGPTBackendClient(new SessionTransport(new BackendSession(options)));
    const agentConfig = { name: "reviewer", instructions: "Review deeply." };
    const input = {
      input: "Assess the SDK shape.",
      thread: { type: "conversationId" as const, conversationId: "abc-123" },
      response: { format: "markdown" as const }
    };

    const inProcessPlan = inProcess.runner.plan(inProcess.agent(agentConfig), input);
    const backendPlan = await backend.runner.plan(backend.agent(agentConfig), input);

    expect(backendPlan).toEqual(inProcessPlan);
  });

  it("matches in-process unsupported Responses adapter output", async () => {
    const options = deterministicOptions({ maxPromptsPerRun: 0 });
    const inProcess = createChatGPT(options);
    const backend = createChatGPTBackendClient(new SessionTransport(new BackendSession(options)));
    const args = { input: "hi", model: "gpt-5.5" };

    await expect(backend.responses.create(args)).resolves.toEqual(await inProcess.responses.create(args));
  });

  it("matches in-process command descriptors", async () => {
    const options = deterministicOptions();
    const inProcess = createChatGPT(options);
    const backend = createChatGPTBackendClient(new SessionTransport(new BackendSession(options)));

    await expect(backend.commands()).resolves.toEqual(inProcess.commands());
    await expect(backend.describe("runner.run")).resolves.toEqual(inProcess.describe("runner.run"));
    await expect(backend.help("runner.run")).resolves.toEqual(inProcess.help("runner.run"));
  });

  it("streams milestone events and final result from the backend", async () => {
    const options = deterministicOptions({ maxPromptsPerRun: 0 });
    const inProcess = createChatGPT(options);
    const backend = createChatGPTBackendClient(new SessionTransport(new BackendSession(options)));
    const inProcessAgent = inProcess.agent({ name: "stream-agent" });
    const backendAgent = backend.agent({ name: "stream-agent" });

    const expectedStream = inProcess.runner.run(inProcessAgent, "reply with hi", { stream: true });
    const expectedNames: string[] = [];
    for await (const event of expectedStream) expectedNames.push(event.name);

    const stream = backend.runner.stream(backendAgent, "reply with hi");
    const actualNames: string[] = [];
    for await (const event of stream) actualNames.push(event.name);

    expect(actualNames).toEqual(expectedNames);
    const expectedResult = await expectedStream.completed;
    await expect(stream.completed).resolves.toMatchObject({
      ok: expectedResult.ok,
      status: expectedResult.status,
      output_text: expectedResult.output_text,
      interruptions: expectedResult.interruptions.map(stableInterruption)
    });
  });

  it("performs one transport-owned hello before multiplexing requests", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("default")]
    });
    try {
      const first = await transport.request(backendRequest("req_one"));
      const second = await transport.request(backendRequest("req_two"));

      expect(first).toMatchObject({ ok: true, result: { helloCount: 1 } });
      expect(second).toMatchObject({ ok: true, result: { helloCount: 1 } });
    } finally {
      await transport.close();
    }
  });

  it("retains bounded provenance diagnostics without treating build drift as protocol failure", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("default")],
      expectedIdentity: {
        packageName: "fixture-backend",
        packageVersion: "0.0.0",
        runtime: "node",
        runtimeVersion: process.version,
        buildDigest: "expected-build"
      }
    });
    try {
      await expect(transport.request(backendRequest("req_compatibility"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_compatibility" }
      });
      const report = transport.getCompatibilityReport();
      expect(report).toMatchObject({
        schemaVersion: "chatgpt.browser_control.backend_compatibility.v1",
        status: "warning",
        mode: "multiplexed",
        packageVersion: "0.0.0",
        buildDigest: "fixture-build"
      });
      expect(report?.warnings).toEqual([
        expect.objectContaining({
          code: "build_digest_mismatch",
          field: "buildDigest",
          expected: "expected-build",
          received: "fixture-build"
        })
      ]);
      expect(report?.warnings).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "package_version_mismatch" })
      ]));
    } finally {
      await transport.close();
    }
  });

  it("projects retained compatibility into doctor without browser access", async () => {
    const report: BackendCompatibilityReport = {
      schemaVersion: "chatgpt.browser_control.backend_compatibility.v1",
      status: "warning",
      mode: "multiplexed",
      packageVersion: "0.5.1-alpha.2",
      buildDigest: "backend-build",
      warnings: [{
        code: "build_digest_mismatch",
        field: "buildDigest",
        expected: "expected-build",
        received: "backend-build",
        message: "Backend build digest differs from the expected runtime."
      }]
    };
    const transport = new RecordingTransport({
      ok: true,
      result: {
        ok: true,
        status: "ok",
        warnings: [],
        context: { timestamp: "2026-06-06T00:00:00.000Z" },
        data: { ready: true, checks: {} }
      }
    }, report);
    const backend = createChatGPTBackendClient(transport);

    await expect(backend.doctor({ check: ["compatibility"] })).resolves.toMatchObject({
      data: {
        ready: true,
        checks: {
          compatibility: {
            status: "unknown",
            code: "build_digest_mismatch",
            details: report
          }
        }
      }
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ command: "doctor", payload: { check: ["compatibility"] } });
  });

  it("accepts a truthful modern single-flight capability and serializes it", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("modern-single-flight")]
    });
    try {
      const first = transport.request(backendRequest("req_single_one"));
      const second = transport.request(backendRequest("req_single_two"));
      await expect(first).resolves.toMatchObject({ ok: true, result: { maxHealthInFlight: 1 } });
      await expect(second).resolves.toMatchObject({ ok: true, result: { maxHealthInFlight: 1 } });
    } finally {
      await transport.close();
    }
  });

  it("demultiplexes out-of-order unary and stream output", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("outoforder")]
    });
    try {
      const stream = transport.stream(backendRequest("req_stream", "runner.stream"));
      const unary = transport.request(backendRequest("req_unary"));
      const events = [] as BackendEvent[];
      for await (const event of stream) events.push(event);
      const response = await unary;

      expect(response).toMatchObject({ ok: true, result: { id: "req_unary" } });
      expect(events).toEqual([
        expect.objectContaining({ requestId: "req_stream", type: "run_item_stream_event" }),
        expect.objectContaining({ requestId: "req_stream", type: "completed" })
      ]);
    } finally {
      await transport.close();
    }
  });

  it("rejects duplicate active ids before writing either duplicate", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("hold")]
    });
    try {
      const pending = transport.request(backendRequest("req_duplicate"));
      await expect(transport.request(backendRequest("req_duplicate"))).rejects.toMatchObject({
        code: "duplicate_request_id",
        recoverable: false
      });
      await expect(pending).resolves.toMatchObject({ ok: true, result: { id: "req_duplicate" } });

      const stream = transport.stream(backendRequest("req_cross_kind", "runner.stream"));
      await expect(transport.request(backendRequest("req_cross_kind"))).rejects.toMatchObject({
        code: "duplicate_request_id",
        recoverable: false
      });
      for await (const _event of stream) {
        // Drain the stream so the child route can settle before teardown.
      }
    } finally {
      await transport.close();
    }
  });

  it("allows a request id to be reused after a terminal response", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("default")]
    });
    try {
      await expect(transport.request(backendRequest("req_reusable"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_reusable" }
      });
      await expect(transport.request(backendRequest("req_reusable"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_reusable" }
      });
    } finally {
      await transport.close();
    }
  });

  it("counts handshake control routes in the aggregate admission bound", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("hold-hello")],
      maxInFlight: 2,
      handshakeTimeoutMs: 500
    });
    try {
      const first = transport.request(backendRequest("req_control_bound_first"));
      await expect(transport.request(backendRequest("req_control_bound_second"))).rejects.toMatchObject({
        code: "backend_in_flight_limit",
        recoverable: true
      });
      await expect(first).resolves.toMatchObject({
        ok: true,
        result: { id: "req_control_bound_first" }
      });
    } finally {
      await transport.close();
    }
  });

  it("keeps a control headroom slot for synchronously-created streams", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("default")],
      maxInFlight: 2
    });
    const drain = async (stream: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> => {
      const events: BackendEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    };
    try {
      // stream() defers negotiation, so both calls happen before the first
      // microtask. The second caller must be rejected before reserving its id,
      // while the first caller still has the final slot for backend.hello.
      const first = transport.stream(backendRequest("req_headroom_first", "runner.stream"));
      const second = transport.stream(backendRequest("req_headroom_second", "runner.stream"));

      let secondError: unknown;
      try {
        await drain(second);
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toMatchObject({
        code: "backend_in_flight_limit",
        recoverable: true
      });
      expect((secondError as Error).message).not.toContain("req_headroom_second");

      await expect(drain(first)).resolves.toEqual([
        expect.objectContaining({ requestId: "req_headroom_first", type: "run_item_stream_event" }),
        expect.objectContaining({ requestId: "req_headroom_first", type: "completed" })
      ]);
      // The rejected caller did not poison negotiation or reserve its id.
      await expect(transport.request(backendRequest("req_headroom_retry"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_headroom_retry" }
      });
    } finally {
      await transport.close();
    }
  });

  it("preserves the full configured bound while a hello control route is active", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("hold-hello")],
      maxInFlight: 4,
      handshakeTimeoutMs: 500
    });
    try {
      const first = transport.request(backendRequest("req_active_control_first"));
      const second = transport.request(backendRequest("req_active_control_second"));
      const third = transport.request(backendRequest("req_active_control_third"));
      await expect(transport.request(backendRequest("req_active_control_fourth"))).rejects.toMatchObject({
        code: "backend_in_flight_limit",
        recoverable: true
      });

      await expect(first).resolves.toMatchObject({ ok: true, result: { id: "req_active_control_first" } });
      await expect(second).resolves.toMatchObject({ ok: true, result: { id: "req_active_control_second" } });
      await expect(third).resolves.toMatchObject({ ok: true, result: { id: "req_active_control_third" } });
      // The fourth caller was rejected before reservation and can reuse its
      // id once the active routes, including hello, have retired.
      await expect(transport.request(backendRequest("req_active_control_fourth"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_active_control_fourth" }
      });
    } finally {
      await transport.close();
    }
  });

  it("restores virtual headroom between sequential legacy probes", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("legacy")],
      maxInFlight: 2,
      handshakeTimeoutMs: 500
    });
    const internals = transport as unknown as {
      releaseRequestId: (requestId: string, tombstone: unknown) => void;
    };
    const originalRelease = internals.releaseRequestId.bind(transport);
    const gapCallers: Array<Promise<unknown>> = [];
    const releaseSpy = vi.spyOn(internals, "releaseRequestId").mockImplementation((requestId, tombstone) => {
      originalRelease(requestId, tombstone);
      if (requestId.startsWith(BACKEND_CONTROL_REQUEST_ID_PREFIX)) {
        const index = gapCallers.length;
        gapCallers.push(new Promise(resolve => {
          queueMicrotask(() => {
            void transport.request(backendRequest(`req_legacy_gap_${index}`)).then(resolve, resolve);
          });
        }));
      }
    });
    try {
      await expect(transport.request(backendRequest("req_legacy_gap_primary"))).resolves.toMatchObject({
        ok: true,
        result: { legacy: true, legacyProbeCount: 2 }
      });
      const gapResults = await Promise.all(gapCallers);
      expect(gapResults).toHaveLength(3);
      expect(gapResults).toEqual([
        expect.objectContaining({ code: "backend_in_flight_limit", recoverable: true }),
        expect.objectContaining({ code: "backend_in_flight_limit", recoverable: true }),
        expect.objectContaining({ code: "backend_in_flight_limit", recoverable: true })
      ]);
    } finally {
      releaseSpy.mockRestore();
      await transport.close();
    }
  });

  it("re-establishes handshake headroom after a child recycle", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("exit")],
      maxInFlight: 2,
      handshakeTimeoutMs: 500
    });
    const drain = async (stream: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> => {
      const events: BackendEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    };
    try {
      await expect(transport.request(backendRequest("req_exit"))).rejects.toMatchObject({
        code: "backend_exited",
        recoverable: true
      });

      const first = transport.stream(backendRequest("req_recycle_headroom_first", "runner.stream"));
      const second = transport.stream(backendRequest("req_recycle_headroom_second", "runner.stream"));
      await expect(drain(second)).rejects.toMatchObject({
        code: "backend_in_flight_limit",
        recoverable: true
      });
      await expect(drain(first)).resolves.toEqual([
        expect.objectContaining({ requestId: "req_recycle_headroom_first", type: "run_item_stream_event" }),
        expect.objectContaining({ requestId: "req_recycle_headroom_first", type: "completed" })
      ]);
    } finally {
      await transport.close();
    }
  });

  it("bounds mixed pending routes before reservation and recovers after terminal release", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("hold")],
      maxInFlight: 2
    });
    try {
      await expect(transport.request(backendRequest("req_bound_ready"))).resolves.toMatchObject({ ok: true });
      const first = transport.request(backendRequest("req_bound_first"));
      const second = transport.request(backendRequest("req_bound_second"));
      await expect(transport.request(backendRequest("req_bound_rejected"))).rejects.toMatchObject({
        code: "backend_in_flight_limit",
        recoverable: true
      });
      await expect(first).resolves.toMatchObject({ ok: true, result: { id: "req_bound_first" } });
      await expect(second).resolves.toMatchObject({ ok: true, result: { id: "req_bound_second" } });
      // Saturation rejects before reserving the requestId, so the same caller
      // route can be retried after another route releases its terminal slot.
      await expect(transport.request(backendRequest("req_bound_rejected"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_bound_rejected" }
      });
    } finally {
      await transport.close();
    }
  });

  it("counts a stream and a legacy serialized waiter in the same aggregate bound", async () => {
    const streamTransport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("hold-stream")],
      maxInFlight: 2
    });
    try {
      await expect(streamTransport.request(backendRequest("req_stream_bound_ready"))).resolves.toMatchObject({ ok: true });
      const stream = streamTransport.stream(backendRequest("req_stream_bound", "runner.stream"));
      const unary = streamTransport.request(backendRequest("req_stream_bound_unary"));
      await expect(streamTransport.request(backendRequest("req_stream_bound_rejected"))).rejects.toMatchObject({
        code: "backend_in_flight_limit",
        recoverable: true
      });
      expect(streamTransport.cancel("req_stream_bound")).toBe(true);
      await expect((async () => {
        for await (const _event of stream) {
          // The stream is intentionally cancelled to release its aggregate slot.
        }
      })()).rejects.toMatchObject({ code: "backend_request_cancelled" });
      await expect(unary).resolves.toMatchObject({ ok: true, result: { id: "req_stream_bound_unary" } });
    } finally {
      await streamTransport.close();
    }

    const legacy = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("legacy-serial")],
      maxInFlight: 2
    });
    try {
      await expect(legacy.request(backendRequest("req_legacy_bound_ready"))).resolves.toMatchObject({ ok: true });
      const first = legacy.request(backendRequest("req_legacy_bound_first"));
      const second = legacy.request(backendRequest("req_legacy_bound_second"));
      await expect(legacy.request(backendRequest("req_legacy_bound_rejected"))).rejects.toMatchObject({
        code: "backend_in_flight_limit",
        recoverable: true
      });
      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(second).resolves.toMatchObject({ ok: true });
    } finally {
      await legacy.close();
    }
  });

  it("falls back to legacy backends that reject backend.hello", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("legacy")]
    });
    try {
      await expect(transport.request(backendRequest("req_legacy"))).resolves.toMatchObject({
        ok: true,
        result: { legacy: true, legacyProbeCount: 2 }
      });
    } finally {
      await transport.close();
    }
  });

  it("fails closed when a modern backend rejects hello negotiation", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("reject")]
    });
    try {
      await expect(transport.request(backendRequest("req_rejected"))).rejects.toMatchObject({
        code: "backend_hello_rejected",
        recoverable: false
      });
    } finally {
      await transport.close();
    }
  });

  it("fails closed when a modern hello omits required capabilities", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("malformed")]
    });
    try {
      await expect(transport.request(backendRequest("req_malformed"))).rejects.toMatchObject({
        code: "backend_hello_rejected",
        recoverable: false
      });
    } finally {
      await transport.close();
    }
  });

  it("fails closed when modern hello identity disagrees with nested capabilities", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("identity-mismatch")]
    });
    try {
      await expect(transport.request(backendRequest("req_identity_mismatch"))).rejects.toMatchObject({
        code: "backend_hello_rejected",
        recoverable: false
      });
    } finally {
      await transport.close();
    }
  });

  it("accepts modern hello with the explicit tab capability shape", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("modern-explicit-tabs")]
    });
    try {
      await expect(transport.request(backendRequest("req_explicit_tabs"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_explicit_tabs" }
      });
    } finally {
      await transport.close();
    }
  });

  it("rejects inconsistent deprecated tab aliases", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("tab-alias-mismatch")]
    });
    try {
      await expect(transport.request(backendRequest("req_tab_alias_mismatch"))).rejects.toMatchObject({
        code: "backend_hello_rejected",
        recoverable: false
      });
    } finally {
      await transport.close();
    }
  });

  it("rejects legacy fallback when either compatibility probe fails", async () => {
    for (const mode of ["legacy-probe-unknown", "legacy-probe-malformed", "legacy-probe-missing-command"] as const) {
      const transport = new StdioBackendTransport({
        command: [process.execPath, "-e", childScript(mode)]
      });
      try {
        await expect(transport.request(backendRequest(`req_${mode}`))).rejects.toMatchObject({
          code: "backend_hello_rejected",
          recoverable: false
        });
      } finally {
        await transport.close();
      }
    }
  });

  it("serializes requests after selecting legacy single-flight mode", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("legacy-serial")]
    });
    try {
      const first = transport.request(backendRequest("req_legacy_one"));
      const second = transport.request(backendRequest("req_legacy_two"));
      await expect(first).resolves.toMatchObject({
        ok: true,
        result: { maxHealthInFlight: 1 }
      });
      await expect(second).resolves.toMatchObject({
        ok: true,
        result: { maxHealthInFlight: 1 }
      });
    } finally {
      await transport.close();
    }
  });

  it("recycles a legacy sidecar when a single-flight stream times out", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("legacy-timeout")],
      timeoutMs: 15,
      handshakeTimeoutMs: 500
    });
    try {
      const stream = transport.stream(backendRequest("req_legacy_stream", "runner.stream"));
      await expect((async () => {
        for await (const _event of stream) {
          // This legacy stream intentionally never emits a terminal event.
        }
      })()).rejects.toMatchObject({
        code: "backend_timeout"
      });
    } finally {
      await transport.close();
    }
  });

  it("tombstones timed-out ids, discards late output, and keeps the route healthy", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("timeout")],
      timeoutMs: 100,
      handshakeTimeoutMs: 1_000
    });
    try {
      await expect(transport.request(backendRequest("req_slow"))).rejects.toMatchObject({
        code: "backend_timeout"
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      await expect(transport.request(backendRequest("req_fast"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_fast" }
      });
      await new Promise(resolve => setTimeout(resolve, 350));
      await expect(transport.request(backendRequest("req_slow"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_slow" }
      });
    } finally {
      await transport.close();
    }
  });

  it("recycles after an unresolved tombstone grace while healthy routes settle first", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("no-terminal")],
      timeoutMs: 100,
      handshakeTimeoutMs: 1_000,
      lateOutputGraceMs: 150
    });
    try {
      await expect(transport.request(backendRequest("req_stuck"))).rejects.toMatchObject({ code: "backend_timeout" });
      await expect(transport.request(backendRequest("req_healthy"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_healthy" }
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      await expect(transport.request(backendRequest("req_after_recycle"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_recycle", healthCount: 1 }
      });
    } finally {
      await transport.close();
    }
  });

  it("quarantines unknown ids without taking down healthy pending requests", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("unknown")]
    });
    try {
      await expect(transport.request(backendRequest("req_known"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_known" }
      });
    } finally {
      await transport.close();
    }
  });

  it("supports local cancellation while discarding the backend's eventual response", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("cancel")]
    });
    try {
      const pending = transport.request(backendRequest("req_cancel"));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(transport.cancel("req_cancel")).toBe(true);
      await expect(pending).rejects.toMatchObject({ code: "backend_request_cancelled" });
      await new Promise(resolve => setTimeout(resolve, 60));
      await expect(transport.request(backendRequest("req_after_cancel"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_cancel" }
      });
    } finally {
      await transport.close();
    }
  });

  it("bounds one abandoned stream without blocking unrelated unary work", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("overflow")],
      streamQueueLimit: 1
    });
    try {
      const stream = transport.stream(backendRequest("req_overflow", "runner.stream"));
      await expect(transport.request(backendRequest("req_after_overflow"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_overflow" }
      });
      await expect((async () => {
        for await (const _event of stream) {
          // The bounded queue may yield its first event before reporting overflow.
        }
      })()).rejects.toMatchObject({
        code: "backend_stream_overflow"
      });
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("bounds direct stream buffering by encoded bytes and releases the route", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("flood")],
      streamQueueLimit: 256,
      streamQueueBytesLimit: 64
    });
    try {
      const stream = transport.stream(backendRequest("req_byte_overflow", "runner.stream"));
      await expect((async () => {
        for await (const _event of stream) {
          // The byte bound should terminate the producer before the count bound.
        }
      })()).rejects.toMatchObject({ code: "backend_stream_overflow" });
      await expect(transport.request(backendRequest("req_after_stream_byte_overflow"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_stream_byte_overflow" }
      });
    } finally {
      await transport.close();
    }
  });

  it("does not write a timed-out route that was admitted behind a blocked write", async () => {
    vi.useFakeTimers();
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("observe")],
      timeoutMs: 20,
      handshakeTimeoutMs: 500,
      writeQueueBytesLimit: 8_000
    });
    const internals = transport as unknown as {
      writeLine: (...args: unknown[]) => Promise<void>;
      admitWrite: (requestId: string, line: string, child: unknown) => unknown;
      pendingResponses: Map<string, { timeout: NodeJS.Timeout }>;
    };
    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => {
      releaseBlockedWrite = resolve;
    });
    let blockedWriteStarted!: () => void;
    const blockedWriteStartedPromise = new Promise<void>(resolve => {
      blockedWriteStarted = resolve;
    });
    let queuedWriteAdmitted!: () => void;
    const queuedWriteAdmittedPromise = new Promise<void>(resolve => {
      queuedWriteAdmitted = resolve;
    });
    const originalWriteLine = internals.writeLine.bind(transport);
    const originalAdmitWrite = internals.admitWrite.bind(transport);
    const writeLineSpy = vi.spyOn(internals, "writeLine").mockImplementation(async (...args) => {
      const request = JSON.parse(String(args[1])) as { requestId?: string };
      if (request.requestId === "req_hold") {
        blockedWriteStarted();
        await blockedWrite;
      }
      await originalWriteLine(args[0], args[1]);
    });
    const admitWriteSpy = vi.spyOn(internals, "admitWrite").mockImplementation((requestId, line, child) => {
      const admission = originalAdmitWrite(requestId, line, child);
      if (requestId === "req_queued") queuedWriteAdmitted();
      return admission;
    });
    try {
      await expect(transport.request(backendRequest("req_initial"))).resolves.toMatchObject({ ok: true });

      const held = transport.request({
        ...backendRequest("req_hold"),
        payload: { value: "hold" }
      });
      await blockedWriteStartedPromise;
      const heldPending = internals.pendingResponses.get("req_hold");
      if (heldPending === undefined) throw new Error("Expected blocked request to be pending");
      clearTimeout(heldPending.timeout);

      const queued = transport.request({
        ...backendRequest("req_queued"),
        payload: { value: "queued" }
      });
      await queuedWriteAdmittedPromise;
      const queuedRejection = expect(queued).rejects.toMatchObject({ code: "backend_timeout" });
      await vi.advanceTimersByTimeAsync(21);
      await queuedRejection;

      releaseBlockedWrite();
      await expect(held).resolves.toMatchObject({ ok: true });
      await expect(transport.request(backendRequest("req_probe"))).resolves.toMatchObject({
        ok: true,
        result: {
          seenRequestIds: expect.arrayContaining(["req_initial", "req_hold", "req_probe"])
        }
      });
      const probe = await transport.request(backendRequest("req_probe_two"));
      expect(probe).toMatchObject({ ok: true, result: { seenRequestIds: expect.not.arrayContaining(["req_queued"]) } });
    } finally {
      writeLineSpy.mockRestore();
      admitWriteSpy.mockRestore();
      releaseBlockedWrite();
      await transport.close();
      vi.useRealTimers();
    }
  });

  it("does not write a cancelled stream route that was admitted behind a blocked write", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("observe")],
      handshakeTimeoutMs: 500,
      writeQueueBytesLimit: 8_000
    });
    const internals = transport as unknown as {
      writeLine: (...args: unknown[]) => Promise<void>;
      admitWrite: (requestId: string, line: string, child: unknown) => unknown;
    };
    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => {
      releaseBlockedWrite = resolve;
    });
    let blockedWriteStarted!: () => void;
    const blockedWriteStartedPromise = new Promise<void>(resolve => {
      blockedWriteStarted = resolve;
    });
    let streamWriteAdmitted!: () => void;
    const streamWriteAdmittedPromise = new Promise<void>(resolve => {
      streamWriteAdmitted = resolve;
    });
    const originalWriteLine = internals.writeLine.bind(transport);
    const originalAdmitWrite = internals.admitWrite.bind(transport);
    const writeLineSpy = vi.spyOn(internals, "writeLine").mockImplementation(async (...args) => {
      const request = JSON.parse(String(args[1])) as { requestId?: string };
      if (request.requestId === "req_hold_stream") {
        blockedWriteStarted();
        await blockedWrite;
      }
      await originalWriteLine(args[0], args[1]);
    });
    const admitWriteSpy = vi.spyOn(internals, "admitWrite").mockImplementation((requestId, line, child) => {
      const admission = originalAdmitWrite(requestId, line, child);
      if (requestId === "req_stream_queued") streamWriteAdmitted();
      return admission;
    });
    try {
      await expect(transport.request(backendRequest("req_initial_stream"))).resolves.toMatchObject({ ok: true });
      const held = transport.request(backendRequest("req_hold_stream"));
      await blockedWriteStartedPromise;

      const stream = transport.stream(backendRequest("req_stream_queued", "runner.stream"));
      const streamResult = (async () => {
        for await (const _event of stream) {
          // Cancellation should settle the queue before the route is written.
        }
      })();
      await streamWriteAdmittedPromise;
      expect(transport.cancel("req_stream_queued")).toBe(true);
      await expect(streamResult).rejects.toMatchObject({ code: "backend_request_cancelled" });

      releaseBlockedWrite();
      await expect(held).resolves.toMatchObject({ ok: true });
      await expect(transport.request(backendRequest("req_probe_stream"))).resolves.toMatchObject({
        ok: true,
        result: {
          seenRequestIds: expect.not.arrayContaining(["req_stream_queued"])
        }
      });
    } finally {
      writeLineSpy.mockRestore();
      admitWriteSpy.mockRestore();
      releaseBlockedWrite();
      await transport.close();
    }
  });

  it("rejects outbound byte-limit overflow and releases the route admission", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("observe")],
      writeQueueBytesLimit: 8_000
    });
    const internals = transport as unknown as {
      writeLine: (...args: unknown[]) => Promise<void>;
    };
    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => {
      releaseBlockedWrite = resolve;
    });
    let blockedWriteStarted!: () => void;
    const blockedWriteStartedPromise = new Promise<void>(resolve => {
      blockedWriteStarted = resolve;
    });
    const originalWriteLine = internals.writeLine.bind(transport);
    const writeLineSpy = vi.spyOn(internals, "writeLine").mockImplementation(async (...args) => {
      const request = JSON.parse(String(args[1])) as { requestId?: string };
      if (request.requestId === "req_hold_bytes") {
        blockedWriteStarted();
        await blockedWrite;
      }
      await originalWriteLine(args[0], args[1]);
    });
    try {
      await expect(transport.request(backendRequest("req_initial_bytes"))).resolves.toMatchObject({ ok: true });
      const held = transport.request({
        ...backendRequest("req_hold_bytes"),
        payload: { value: "x".repeat(5_500) }
      });
      await blockedWriteStartedPromise;
      const overflow = transport.request({
        ...backendRequest("req_overflow_bytes"),
        payload: { value: "x".repeat(5_500) }
      });
      await expect(overflow).rejects.toMatchObject({
        code: "backend_write_queue_overflow",
        recoverable: true
      });
      releaseBlockedWrite();
      await expect(held).resolves.toMatchObject({ ok: true });
      await expect(transport.request(backendRequest("req_after_byte_overflow"))).resolves.toMatchObject({ ok: true });
    } finally {
      writeLineSpy.mockRestore();
      releaseBlockedWrite();
      await transport.close();
    }
  });

  it("retains cancelled queued admissions until the blocked write chain drains", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("observe")],
      writeQueueLimit: 3,
      writeQueueBytesLimit: 64_000
    });
    const internals = transport as unknown as {
      writeLine: (...args: unknown[]) => Promise<void>;
      admitWrite: (requestId: string, line: string, child: unknown) => unknown;
    };
    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => {
      releaseBlockedWrite = resolve;
    });
    let blockedWriteStarted!: () => void;
    const blockedWriteStartedPromise = new Promise<void>(resolve => {
      blockedWriteStarted = resolve;
    });
    const admittedWaiters = new Map<string, () => void>();
    const originalWriteLine = internals.writeLine.bind(transport);
    const originalAdmitWrite = internals.admitWrite.bind(transport);
    const writeLineSpy = vi.spyOn(internals, "writeLine").mockImplementation(async (...args) => {
      const request = JSON.parse(String(args[1])) as { requestId?: string };
      if (request.requestId === "req_churn_block") {
        blockedWriteStarted();
        await blockedWrite;
      }
      await originalWriteLine(args[0], args[1]);
    });
    const admitWriteSpy = vi.spyOn(internals, "admitWrite").mockImplementation((requestId, line, child) => {
      const admission = originalAdmitWrite(requestId, line, child);
      admittedWaiters.get(requestId)?.();
      admittedWaiters.delete(requestId);
      return admission;
    });
    const waitForAdmission = (requestId: string): Promise<void> => new Promise(resolve => {
      admittedWaiters.set(requestId, resolve);
    });
    try {
      await expect(transport.request(backendRequest("req_churn_initial"))).resolves.toMatchObject({ ok: true });
      const blocked = transport.request(backendRequest("req_churn_block"));
      await blockedWriteStartedPromise;

      for (const requestId of ["req_churn_one", "req_churn_two"]) {
        const pending = transport.request(backendRequest(requestId));
        await waitForAdmission(requestId);
        const rejection = expect(pending).rejects.toMatchObject({ code: "backend_request_cancelled" });
        expect(transport.cancel(requestId)).toBe(true);
        await rejection;
      }

      const overBudget = transport.request(backendRequest("req_churn_over_budget"));
      await expect(overBudget).rejects.toMatchObject({
        code: "backend_write_queue_overflow",
        recoverable: true
      });

      releaseBlockedWrite();
      await expect(blocked).resolves.toMatchObject({ ok: true });
      await expect(transport.request(backendRequest("req_churn_after_drain"))).resolves.toMatchObject({
        ok: true,
        result: {
          seenRequestIds: expect.not.arrayContaining(["req_churn_one", "req_churn_two", "req_churn_over_budget"])
        }
      });
    } finally {
      writeLineSpy.mockRestore();
      admitWriteSpy.mockRestore();
      releaseBlockedWrite();
      await transport.close();
    }
  });

  it("detaches a permanently blocked stdin callback before starting a replacement child", async () => {
    vi.useFakeTimers();
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("observe")],
      timeoutMs: 20,
      handshakeTimeoutMs: 500,
      writeQueueLimit: 4,
      writeQueueBytesLimit: 64_000
    });
    const internals = transport as unknown as {
      writeLine: (...args: unknown[]) => Promise<void>;
    };
    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => {
      releaseBlockedWrite = resolve;
    });
    let blockedWriteStarted!: () => void;
    const blockedWriteStartedPromise = new Promise<void>(resolve => {
      blockedWriteStarted = resolve;
    });
    const originalWriteLine = internals.writeLine.bind(transport);
    const writeLineSpy = vi.spyOn(internals, "writeLine").mockImplementation(async (...args) => {
      const request = JSON.parse(String(args[1])) as { requestId?: string };
      if (request.requestId === "req_stuck_write") {
        blockedWriteStarted();
        await blockedWrite;
      }
      await originalWriteLine(args[0], args[1]);
    });
    try {
      await expect(transport.request(backendRequest("req_before_stuck"))).resolves.toMatchObject({ ok: true });
      const stuck = transport.request(backendRequest("req_stuck_write"));
      await blockedWriteStartedPromise;
      const timeout = expect(stuck).rejects.toMatchObject({ code: "backend_timeout" });
      await vi.advanceTimersByTimeAsync(21);
      await timeout;

      // The old write tail is still blocked, but the replacement child must
      // get an independent handshake/write path instead of inheriting it.
      await expect(transport.request(backendRequest("req_after_stuck_recycle"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_stuck_recycle" }
      });
    } finally {
      releaseBlockedWrite();
      writeLineSpy.mockRestore();
      await transport.close();
      vi.useRealTimers();
    }
  });

  it("fails closed instead of stacking generations around two unresolved stdin tails", async () => {
    vi.useFakeTimers();
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("observe")],
      timeoutMs: 20,
      handshakeTimeoutMs: 500,
      writeQueueLimit: 6,
      writeQueueBytesLimit: 64_000
    });
    const internals = transport as unknown as {
      writeLine: (...args: unknown[]) => Promise<void>;
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>(resolve => {
      secondStarted = resolve;
    });
    const originalWriteLine = internals.writeLine.bind(transport);
    const writeLineSpy = vi.spyOn(internals, "writeLine").mockImplementation(async (...args) => {
      const request = JSON.parse(String(args[1])) as { requestId?: string };
      if (request.requestId === "req_first_stuck") {
        firstStarted();
        await firstGate;
      }
      if (request.requestId === "req_second_stuck") {
        secondStarted();
        await secondGate;
      }
      await originalWriteLine(args[0], args[1]);
    });
    try {
      await expect(transport.request(backendRequest("req_before_two_stuck"))).resolves.toMatchObject({ ok: true });
      const first = transport.request(backendRequest("req_first_stuck"));
      await firstStartedPromise;
      const firstTimeout = expect(first).rejects.toMatchObject({ code: "backend_timeout" });
      await vi.advanceTimersByTimeAsync(21);
      await firstTimeout;

      await expect(transport.request(backendRequest("req_between_stuck"))).resolves.toMatchObject({ ok: true });
      const second = transport.request(backendRequest("req_second_stuck"));
      await secondStartedPromise;
      const secondTimeout = expect(second).rejects.toMatchObject({ code: "backend_timeout" });
      await vi.advanceTimersByTimeAsync(21);
      await secondTimeout;

      await expect(transport.request(backendRequest("req_after_two_stuck"))).rejects.toMatchObject({
        code: "backend_write_teardown_pending",
        recoverable: true
      });
    } finally {
      releaseFirst();
      releaseSecond();
      writeLineSpy.mockRestore();
      await transport.close();
      vi.useRealTimers();
    }
  });

  it("does not block a third child when the replacement exits without an active write", async () => {
    vi.useFakeTimers();
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("exit")],
      timeoutMs: 20,
      handshakeTimeoutMs: 500,
      writeQueueLimit: 6,
      writeQueueBytesLimit: 64_000
    });
    const internals = transport as unknown as {
      writeLine: (...args: unknown[]) => Promise<void>;
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>(resolve => {
      secondStarted = resolve;
    });
    const originalWriteLine = internals.writeLine.bind(transport);
    const writeLineSpy = vi.spyOn(internals, "writeLine").mockImplementation(async (...args) => {
      const request = JSON.parse(String(args[1])) as { requestId?: string };
      if (request.requestId === "req_first_generation_stuck") {
        firstStarted();
        await firstGate;
      }
      if (request.requestId === "req_second_generation_stuck") {
        secondStarted();
        await secondGate;
      }
      await originalWriteLine(args[0], args[1]);
    });
    try {
      await expect(transport.request(backendRequest("req_first_generation_before"))).resolves.toMatchObject({ ok: true });
      const first = transport.request(backendRequest("req_first_generation_stuck"));
      await firstStartedPromise;
      const firstTimeout = expect(first).rejects.toMatchObject({ code: "backend_timeout" });
      await vi.advanceTimersByTimeAsync(21);
      await firstTimeout;

      await expect(transport.request(backendRequest("req_replacement_traffic"))).resolves.toMatchObject({ ok: true });
      await expect(transport.request(backendRequest("req_exit"))).rejects.toMatchObject({
        code: "backend_exited"
      });
      // The replacement child had no active admission when it exited. The
      // first detached tail remains charged, but it must not brick recovery.
      await expect(transport.request(backendRequest("req_third_generation"))).resolves.toMatchObject({ ok: true });

      const second = transport.request(backendRequest("req_second_generation_stuck"));
      await secondStartedPromise;
      const secondTimeout = expect(second).rejects.toMatchObject({ code: "backend_timeout" });
      await vi.advanceTimersByTimeAsync(21);
      await secondTimeout;
      await expect(transport.request(backendRequest("req_after_genuine_second_stuck"))).rejects.toMatchObject({
        code: "backend_write_teardown_pending",
        recoverable: true
      });
    } finally {
      releaseFirst();
      releaseSecond();
      writeLineSpy.mockRestore();
      await transport.close();
      vi.useRealTimers();
    }
  });

  it("propagates high-level iterator break to transport cancellation", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("hold-stream")]
    });
    const backend = createChatGPTBackendClient(transport);
    try {
      const stream = backend.runner.stream(backend.agent({ name: "break-agent" }), "hello");
      for await (const _event of stream) break;
      await expect(stream.completed).rejects.toMatchObject({ code: "backend_request_cancelled" });
      await expect(transport.request(backendRequest("req_after_break"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_break" }
      });
    } finally {
      await backend.close();
    }
  });

  it("cancels a direct transport stream when its iterator returns", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("hold-stream")]
    });
    try {
      const stream = transport.stream(backendRequest("req_direct_return", "runner.stream"));
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      await iterator.return?.();
      await expect(transport.request(backendRequest("req_after_direct_return"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_direct_return" }
      });
    } finally {
      await transport.close();
    }
  });

  it("bounds an undrained high-level stream and isolates the route", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("flood")]
    });
    const backend = createChatGPTBackendClient(transport);
    try {
      const stream = backend.runner.stream(backend.agent({ name: "flood-agent" }), "hello");
      await expect(stream.completed).rejects.toMatchObject({ code: "backend_stream_overflow" });
      await expect(transport.request(backendRequest("req_after_flood"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_flood" }
      });
    } finally {
      await backend.close();
    }
  });

  it("bounds high-level stream adaptation by encoded bytes", async () => {
    const backend = createChatGPTBackendClient(new LargeStreamTransport());
    const stream = backend.runner.stream(backend.agent({ name: "large-stream-agent" }), "hello");
    await expect(stream.completed).rejects.toMatchObject({ code: "backend_stream_overflow" });
  });

  it("fails all pending routes when the backend process exits", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("exit")]
    });
    try {
      await expect(transport.request(backendRequest("req_exit"))).rejects.toMatchObject({
        code: "backend_exited",
        recoverable: true
      });
    } finally {
      await transport.close();
    }
  });

  it("makes close terminal instead of lazily restarting the sidecar", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("default")]
    });
    await transport.close();
    await expect(transport.request(backendRequest("req_after_close"))).rejects.toMatchObject({
      code: "backend_closed"
    });
  });

  it("bounds outbound frames and keeps the sidecar usable after an unsent oversize", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("default")],
      frameLimitBytes: 4096
    });
    try {
      await expect(transport.request({
        ...backendRequest("req_oversized"),
        payload: { value: "x".repeat(5000) }
      })).rejects.toMatchObject({ code: "backend_frame_too_large" });
      await expect(transport.request(backendRequest("req_after_oversized"))).resolves.toMatchObject({
        ok: true,
        result: { id: "req_after_oversized" }
      });
    } finally {
      await transport.close();
    }
  });

  it("terminates on oversized and unterminated inbound frames", async () => {
    const oversized = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("oversized-response")],
      frameLimitBytes: 4096
    });
    try {
      await expect(oversized.request(backendRequest("req_oversized_response"))).rejects.toMatchObject({
        code: "backend_frame_too_large"
      });
    } finally {
      await oversized.close();
    }

    const unterminated = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("unterminated-response")],
      frameLimitBytes: 4096
    });
    try {
      await expect(unterminated.request(backendRequest("req_unterminated_response"))).rejects.toMatchObject({
        code: "backend_unterminated_frame"
      });
    } finally {
      await unterminated.close();
    }

    const invalidEncoding = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("invalid-encoding-response")],
      frameLimitBytes: 4096
    });
    try {
      await expect(invalidEncoding.request(backendRequest("req_invalid_encoding_response"))).rejects.toMatchObject({
        code: "backend_invalid_encoding"
      });
    } finally {
      await invalidEncoding.close();
    }
  });

  it("redacts backend stderr from public process errors", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("stderr")]
    });
    try {
      let error: unknown;
      try {
        await transport.request(backendRequest("req_stderr"));
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "backend_exited" });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("secret-stderr-payload");
      expect((error as Error).message).toContain("stderr_present=true");
    } finally {
      await transport.close();
    }
  });

  it("wakes mixed legacy unary and stream waiters exactly once on process failure", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("legacy-mixed-exit")],
      timeoutMs: 100,
      handshakeTimeoutMs: 500
    });
    try {
      const stream = transport.stream(backendRequest("req_mixed_stream", "runner.stream"));
      const streamResult = (async () => {
        for await (const _event of stream) {
          // The legacy sidecar exits before the stream can emit a terminal event.
        }
      })();
      await new Promise(resolve => setTimeout(resolve, 5));
      const unary = transport.request(backendRequest("req_exit"));
      await expect(unary).rejects.toMatchObject({ code: "backend_exited" });
      await expect(streamResult).rejects.toMatchObject({ code: "backend_exited" });
    } finally {
      await transport.close();
    }
  });

  it("rejects and clears pending requests when stdio backend times out", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", "process.stdin.resume();"],
      timeoutMs: 20,
      handshakeTimeoutMs: 100
    });
    const backend = createChatGPTBackendClient(transport);

    await expect(backend.commands()).rejects.toMatchObject({
      code: "backend_timeout",
      recoverable: true
    });
    await backend.close();
  });

  it("rejects malformed stdio backend protocol lines immediately", async () => {
    const backend = createChatGPTBackendClient(new StdioBackendTransport({
      command: [process.execPath, "-e", [
        "process.stdin.once('data', () => {",
        "console.log(JSON.stringify({ schemaVersion: 'wrong.v1', requestId: 'req_1' }));",
        "});"
      ].join("")]
    }));

    await expect(backend.commands()).rejects.toMatchObject({
      code: "unsupported_backend_schema"
    });
    await backend.close();
  });

  it("rejects backend responses without requestId immediately", async () => {
    const backend = createChatGPTBackendClient(new StdioBackendTransport({
      command: [process.execPath, "-e", [
        "process.stdin.once('data', () => {",
        "console.log(JSON.stringify({ schemaVersion: 'chatgpt.browser_control.backend_response.v1', ok: true, result: [] }));",
        "});"
      ].join("")]
    }));

    await expect(backend.commands()).rejects.toMatchObject({
      code: "missing_backend_request_id"
    });
    await backend.close();
  });

  it("rejects events sent for non-streaming requests", async () => {
    const backend = createChatGPTBackendClient(new StdioBackendTransport({
      command: [process.execPath, "-e", [
        "process.stdin.once('data', line => {",
        "const request = JSON.parse(String(line));",
        "console.log(JSON.stringify({ schemaVersion: 'chatgpt.browser_control.backend_event.v1', requestId: request.requestId, type: 'completed', result: {} }));",
        "});"
      ].join("")]
    }));

    await expect(backend.commands()).rejects.toMatchObject({
      code: "unexpected_backend_event"
    });
    await backend.close();
  });

  it("terminates when a unary response is sent for a streaming request", async () => {
    const transport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("response-on-stream")]
    });
    try {
      const stream = transport.stream(backendRequest("req_response_on_stream", "runner.stream"));
      await expect((async () => {
        for await (const _event of stream) {
          // The response-on-stream violation should terminate the sidecar.
        }
      })()).rejects.toMatchObject({ code: "unexpected_backend_response" });
    } finally {
      await transport.close();
    }
  });

  it("terminates on malformed response and event payloads", async () => {
    const responseTransport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("malformed-response")]
    });
    try {
      await expect(responseTransport.request(backendRequest("req_bad_response"))).rejects.toMatchObject({
        code: "invalid_backend_response"
      });
    } finally {
      await responseTransport.close();
    }

    const eventTransport = new StdioBackendTransport({
      command: [process.execPath, "-e", childScript("malformed-event")]
    });
    try {
      const stream = eventTransport.stream(backendRequest("req_bad_event", "runner.stream"));
      await expect((async () => {
        for await (const _event of stream) {
          // malformed event should terminate before yielding.
        }
      })()).rejects.toMatchObject({ code: "invalid_backend_event" });
    } finally {
      await eventTransport.close();
    }
  });
});

function deterministicOptions(limits: { maxPromptsPerRun?: number } = {}) {
  return {
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    limits
  };
}

function backendRequest(requestId: string, command: BackendRequest["command"] = "backend.health"): BackendRequest {
  return {
    schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
    requestId,
    command,
    payload: {}
  };
}

function childScript(mode: string): string {
  return `
const readline = require("node:readline");
const mode = ${JSON.stringify(mode)};
const responseSchema = "${BACKEND_RESPONSE_SCHEMA_VERSION}";
const eventSchema = "chatgpt.browser_control.backend_event.v1";
let helloCount = 0;
let legacyProbeCount = 0;
let healthCount = 0;
let healthInFlight = 0;
let maxHealthInFlight = 0;
let delayedTimeoutResponseSent = false;
let overflowCompleted = false;
let pendingOverflowHealth;
const seenRequestIds = [];
const write = value => process.stdout.write(JSON.stringify(value) + "\\n");
const ok = (request, result) => write({ schemaVersion: responseSchema, requestId: request.requestId, ok: true, result });
const error = (request, code, message) => write({ schemaVersion: responseSchema, requestId: request.requestId, ok: false, error: { code, message, recoverable: false } });
const event = (request, value) => write({ schemaVersion: eventSchema, requestId: request.requestId, ...value });
const helloResult = {
  accepted: true,
  backendSessionId: "fixture-backend-session",
  packageName: "fixture-backend",
  packageVersion: "0.0.0",
  runtime: "node",
  runtimeVersion: process.version,
  buildDigest: "fixture-build",
  protocolVersion: "chatgpt.browser_control.backend_request.v1",
  capabilities: {
    backendSessionId: "fixture-backend-session",
    packageName: "fixture-backend",
    packageVersion: "0.0.0",
    runtime: "node",
    runtimeVersion: process.version,
    buildDigest: "fixture-build",
    protocolVersion: "chatgpt.browser_control.backend_request.v1",
    commands: ["backend.hello", "backend.version", "backend.capabilities", "backend.health", "runner.run", "runner.stream"],
    transports: ["stdio"],
    streaming: { modes: ["ndjson"], tokenDeltas: false },
    supportedProtocolVersions: ["chatgpt.browser_control.backend_request.v1"],
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
};
const health = request => {
  healthCount += 1;
  if (mode === "malformed-response") {
    write({ schemaVersion: responseSchema, requestId: request.requestId, ok: false, error: { code: "bad" } });
    return;
  }
  if (mode === "oversized-response") {
    ok(request, { id: request.requestId, padding: "x".repeat(5000) });
    return;
  }
  if (mode === "unterminated-response") {
    process.stdout.write(JSON.stringify({ schemaVersion: responseSchema, requestId: request.requestId, ok: true, result: {} }));
    return setTimeout(() => process.exit(0), 5);
  }
  if (mode === "invalid-encoding-response") {
    process.stdout.write(Buffer.from([0xff, 0x0a]));
    return;
  }
  if (mode === "legacy-serial" || mode === "modern-single-flight") {
    healthInFlight += 1;
    maxHealthInFlight = Math.max(maxHealthInFlight, healthInFlight);
    return setTimeout(() => {
      ok(request, { id: request.requestId, maxHealthInFlight });
      healthInFlight -= 1;
    }, 25);
  }
  const result = {
    id: request.requestId,
    helloCount,
    healthCount,
    ...(mode === "observe" ? { seenRequestIds: [...seenRequestIds] } : {})
  };
  if (mode === "no-terminal" && request.requestId === "req_stuck") return;
  if (mode === "stderr") {
    process.stderr.write("secret-stderr-payload");
    return setTimeout(() => process.exit(0), 5);
  }
  if (mode === "timeout" && request.requestId === "req_slow" && !delayedTimeoutResponseSent) {
    delayedTimeoutResponseSent = true;
    return setTimeout(() => ok(request, result), 250);
  }
  if (mode === "cancel" && request.requestId === "req_cancel") return setTimeout(() => ok(request, result), 45);
  if (mode === "overflow" && request.requestId === "req_after_overflow" && !overflowCompleted) {
    pendingOverflowHealth = { request, result };
    return;
  }
  if (mode === "unknown" && request.requestId === "req_known") write({ schemaVersion: responseSchema, requestId: "unknown_backend_id", ok: true, result: {} });
  if (mode === "exit" && request.requestId === "req_exit") return setTimeout(() => process.exit(0), 5);
  if (mode === "legacy-mixed-exit" && request.requestId === "req_exit") return setTimeout(() => process.exit(0), 5);
  const delay = mode === "outoforder" ? 5 : mode === "hold" ? 30 : 0;
  return setTimeout(() => ok(request, mode === "legacy" ? { legacy: true, legacyProbeCount } : result), delay);
};
const stream = request => {
  if (mode === "malformed-event") {
    event(request, { type: "error", error: { code: "bad" } });
    return;
  }
  if (mode === "response-on-stream") {
    ok(request, { id: request.requestId });
    return;
  }
  if (mode === "legacy-timeout" || mode === "legacy-mixed-exit") {
    if (mode === "legacy-mixed-exit") setTimeout(() => process.exit(0), 5);
    return;
  }
  if (mode === "overflow") {
    for (let index = 0; index < 3; index += 1) {
      event(request, { type: "run_item_stream_event", name: "message_completed", item: { index } });
    }
    overflowCompleted = true;
    if (pendingOverflowHealth !== undefined) {
      ok(pendingOverflowHealth.request, pendingOverflowHealth.result);
      pendingOverflowHealth = undefined;
    }
    return;
  }
  if (mode === "flood") {
    for (let index = 0; index < 400; index += 1) {
      event(request, { type: "run_item_stream_event", name: "message_completed", item: { index } });
    }
    return;
  }
  const delay = mode === "outoforder" ? 20 : mode === "hold-stream" ? 200 : 0;
  setTimeout(() => event(request, { type: "run_item_stream_event", name: "message_completed", item: { type: "message.completed" } }), delay);
  setTimeout(() => event(request, { type: "completed", result: { id: request.requestId } }), delay + 5);
};
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  seenRequestIds.push(request.requestId);
  if (request.command === "backend.hello") {
    helloCount += 1;
    if (mode === "legacy" || mode === "legacy-serial" || mode === "legacy-timeout"
      || mode === "legacy-mixed-exit" || mode === "legacy-probe-unknown" || mode === "legacy-probe-malformed"
      || mode === "legacy-probe-missing-command") {
      error(request, "unknown_command", "Unknown backend command: backend.hello");
    }
    else if (mode === "hold-hello") return setTimeout(() => ok(request, helloResult), 30);
    else if (mode === "reject") ok(request, { accepted: false });
    else if (mode === "malformed") ok(request, { accepted: true });
    else if (mode === "identity-mismatch") {
      ok(request, {
        ...helloResult,
        capabilities: { ...helloResult.capabilities, backendSessionId: "different-session" }
      });
    }
    else if (mode === "modern-single-flight") {
      ok(request, {
        ...helloResult,
        capabilities: { ...helloResult.capabilities, multiplexing: { unary: false, streams: false } }
      });
    }
    else if (mode === "tab-alias-mismatch") {
      ok(request, {
        ...helloResult,
        capabilities: { ...helloResult.capabilities, tabs: { ...helloResult.capabilities.tabs, concurrent: true } }
      });
    }
    else if (mode === "modern-explicit-tabs") {
      const { stableIdentity, coordination, concurrent, ...explicitTabs } = helloResult.capabilities.tabs;
      ok(request, {
        ...helloResult,
        capabilities: { ...helloResult.capabilities, tabs: explicitTabs }
      });
    }
    else ok(request, helloResult);
    return;
  }
  if ((mode === "legacy" || mode === "legacy-serial" || mode === "legacy-timeout"
    || mode === "legacy-mixed-exit" || mode === "legacy-probe-unknown" || mode === "legacy-probe-malformed"
    || mode === "legacy-probe-missing-command")
    && (request.command === "backend.version" || request.command === "backend.capabilities")) {
    legacyProbeCount += 1;
    if (mode === "legacy-probe-unknown") {
      error(request, "unknown_command", "Unknown legacy probe command");
      return;
    }
    if (mode === "legacy-probe-malformed" && request.command === "backend.capabilities") {
      ok(request, { protocolVersion: "wrong.v1", commands: [] });
      return;
    }
    if (request.command === "backend.version") {
      ok(request, { name: "legacy-backend", runtime: "node", protocolVersion: "chatgpt.browser_control.backend_request.v1" });
    } else {
      ok(request, {
        protocolVersion: "chatgpt.browser_control.backend_request.v1",
        commands: mode === "legacy-probe-missing-command"
          ? ["backend.version", "backend.health", "backend.capabilities", "runner.stream"]
          : ["backend.version", "backend.health", "backend.capabilities", "runner.run", "runner.stream"],
        transports: ["stdio"],
        streaming: { modes: ["ndjson"], tokenDeltas: false }
      });
    }
    return;
  }
  if (request.command === "runner.stream") return stream(request);
  if (request.command === "backend.health") return health(request);
  error(request, "unknown_command", "Unknown backend command");
});
`;
}

function stableInterruption(interruption: ChatGPTInterruption): Record<string, unknown> {
  const expected: Record<string, unknown> = {
    ...interruption,
    id: expect.any(String),
    resume: { ...interruption.resume }
  };
  const resume = expected.resume as Record<string, unknown>;
  if (resume.stateId !== undefined) {
    resume.stateId = expect.any(String);
  }
  return expected;
}

type RecordingResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; recoverable: boolean } };

class RecordingTransport implements BackendTransport {
  readonly requests: BackendRequest[] = [];

  constructor(
    private readonly response: RecordingResponse,
    private readonly compatibilityReport?: BackendCompatibilityReport
  ) {}

  getCompatibilityReport(): BackendCompatibilityReport | undefined {
    return this.compatibilityReport;
  }

  async request(request: BackendRequest): Promise<BackendResponse> {
    this.requests.push(request);
    const response = {
      schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
      ...this.response
    } as BackendResponse;
    if (request.requestId !== undefined) response.requestId = request.requestId;
    return response;
  }

  async *stream(_request: BackendRequest): AsyncIterable<BackendEvent> {
    throw new Error("RecordingTransport.stream is not implemented for this test.");
  }
}

class LargeStreamTransport implements BackendTransport {
  async request(_request: BackendRequest): Promise<BackendResponse> {
    throw new Error("LargeStreamTransport.request is not implemented for this test.");
  }

  async *stream(request: BackendRequest): AsyncIterable<BackendEvent> {
    if (request.requestId === undefined) throw new Error("LargeStreamTransport requires requestId");
    const item = { padding: "x".repeat(9 * 1024 * 1024) };
    yield {
      schemaVersion: "chatgpt.browser_control.backend_event.v1",
      requestId: request.requestId,
      type: "run_item_stream_event",
      name: "message_completed",
      item
    };
    yield {
      schemaVersion: "chatgpt.browser_control.backend_event.v1",
      requestId: request.requestId,
      type: "run_item_stream_event",
      name: "message_completed",
      item
    };
  }
}

class SessionTransport implements BackendTransport {
  constructor(private readonly session: BackendSession) {}

  async request(request: BackendRequest): Promise<BackendResponse> {
    return this.session.dispatch(request);
  }

  stream(request: BackendRequest): AsyncIterable<BackendEvent> {
    return this.session.stream(request);
  }
}
