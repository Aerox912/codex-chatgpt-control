import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendSession } from "../../src/backend/session.js";
import {
  BACKEND_REQUEST_SCHEMA_VERSION,
  type BackendCommand,
  type BackendResponse,
  type BackendResponseOk,
  parseBackendRequest
} from "../../src/backend/protocol.js";
import type { LocatorLike, PageLike } from "../../src/types.js";
import { OperationJournal } from "../../src/operations/journal.js";
import {
  OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
  OPERATION_INSPECT_REQUEST_SCHEMA_VERSION,
  OPERATION_REQUEST_SCHEMA_VERSION,
  type OperationSubmitRequestV1
} from "../../src/operations/types.js";

describe("backend dispatch", () => {
  it("reports backend version, health, and capabilities", async () => {
    const session = deterministicSession();

    await expect(send(session, "backend.version")).resolves.toMatchObject({
      ok: true,
      result: {
        name: "codex-chatgpt-control-backend",
        runtime: "node"
      }
    });

    await expect(send(session, "backend.health")).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        status: "ok"
      }
    });

    const capabilities = await send(session, "backend.capabilities");
    expectOk(capabilities);
    expect(capabilities).toMatchObject({
      ok: true,
      result: {
        protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        transports: ["stdio"],
        streaming: { modes: ["ndjson"], tokenDeltas: false }
      }
    });
    expect((capabilities.result as { commands: string[] }).commands).toContain("runner.run");
    expect((capabilities.result as { commands: string[] }).commands).toContain("backend.hello");
    expect((capabilities.result as { commands: string[] }).commands).toContain("responses.create");
    expect((capabilities.result as { commands: string[] }).commands).toContain("files.preflight");
    expect((capabilities.result as { commands: string[] }).commands).toContain("projects.sources.add");
    expect((capabilities.result as { commands: string[] }).commands).toContain("messages.stop");
    expect((capabilities.result as { commands: string[] }).commands).toEqual(expect.arrayContaining([
      "operations.submit",
      "operations.collect",
      "operations.inspect",
      "operations.control"
    ]));
    expect(capabilities).toMatchObject({
      ok: true,
      result: {
        requestIds: { required: true, scope: "connection" },
        multiplexing: { unary: true, streams: true },
        cancellation: { supported: false, requests: false, streams: false },
        supportedProtocolVersions: [BACKEND_REQUEST_SCHEMA_VERSION],
        tabs: {
          stableProviderIdentity: false,
          stableBrowserIdentity: false,
          stableTabIdentity: false,
          coordinationScope: "none",
          authoritativeClaim: false,
          fencing: false,
          concurrentTabs: false
        }
      }
    });

    const hello = await send(session, "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      capabilities: { requestIds: { required: true, scope: "connection" } }
    });
    expectOk(hello);
    expect(hello.result).toMatchObject({
      accepted: true,
      backendSessionId: expect.any(String),
      packageName: "codex-chatgpt-control",
      packageVersion: "unknown",
      runtime: "node",
      runtimeVersion: process.version,
      buildDigest: "unknown",
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      capabilities: expect.objectContaining({
        multiplexing: { unary: true, streams: true }
      })
    });

    const secondHello = await send(new BackendSession({ now: () => new Date("2026-06-06T00:00:00.000Z") }), "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION
    });
    expectOk(secondHello);
    expect(secondHello.result).toMatchObject({ backendSessionId: expect.any(String) });
    const firstSessionId = (hello.result as { backendSessionId: string }).backendSessionId;
    expect((secondHello.result as { backendSessionId: string }).backendSessionId).toBe(firstSessionId);

    const explicitSession = new BackendSession({
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      backendIdentity: { backendSessionId: "explicit-session-id" }
    });
    const explicitHello = await send(explicitSession, "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION
    });
    expect(explicitHello).toMatchObject({ ok: true, result: { backendSessionId: "explicit-session-id" } });
  });

  it("intersects requested hello capabilities without initializing the browser client", async () => {
    let browserReads = 0;
    const options: ConstructorParameters<typeof BackendSession>[0] = {
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      get browser() {
        browserReads += 1;
        return undefined as never;
      }
    };
    const session = new BackendSession(options);
    const hello = await send(session, "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      capabilities: {
        commands: ["backend.health"],
        transports: ["stdio"],
        streaming: { modes: ["ndjson"], tokenDeltas: false },
        supportedProtocolVersions: [BACKEND_REQUEST_SCHEMA_VERSION],
        requestIds: { required: false, scope: "connection" },
        multiplexing: { unary: false, streams: false }
      }
    });
    expectOk(hello);
    expect(hello.result).toMatchObject({
      accepted: true,
      capabilities: {
        commands: ["backend.health"],
        multiplexing: { unary: false, streams: false }
      }
    });
    await expect(send(session, "backend.health")).resolves.toMatchObject({ ok: true });
    expect(browserReads).toBe(0);
  });

  it("rejects malformed or unsatisfied hello capability requests", async () => {
    const session = deterministicSession();

    const malformed = await send(session, "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      capabilities: "not-an-object"
    });
    expectOk(malformed);
    expect(malformed.result).toMatchObject({ accepted: false });

    const unsupported = await send(session, "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      capabilities: {
        streaming: { modes: ["ndjson"], tokenDeltas: true },
        requestIds: { required: true, scope: "process" }
      }
    });
    expectOk(unsupported);
    expect(unsupported.result).toMatchObject({
      accepted: false,
      capabilities: {
        streaming: { tokenDeltas: false },
        requestIds: { scope: "none" }
      }
    });

    const inconsistentAliases = await send(session, "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      capabilities: {
        tabs: {
          stableProviderIdentity: false,
          stableBrowserIdentity: false,
          stableTabIdentity: false,
          coordinationScope: "none",
          authoritativeClaim: false,
          fencing: false,
          concurrentTabs: false,
          concurrent: true
        }
      }
    });
    expectOk(inconsistentAliases);
    expect(inconsistentAliases.result).toMatchObject({ accepted: false });

    const malformedIdentity = await send(session, "backend.hello", {
      protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      capabilities: { runtime: "python" }
    });
    expectOk(malformedIdentity);
    expect(malformedIdentity.result).toMatchObject({ accepted: false });
  });

  it("rejects malformed runtime identity overrides", () => {
    for (const packageName of ["", " leading", "x".repeat(513), "bad\nvalue"]) {
      expect(() => new BackendSession({ backendIdentity: { packageName } })).toThrow(/backend identity/);
    }
  });

  it("requires the exact boolean stop confirmation at the backend boundary", async () => {
    let generating = true;
    let clicks = 0;
    const locator: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      evaluate: async <T>(): Promise<T> => true as T,
      click: async () => { clicks += 1; generating = false; }
    };
    const page: PageLike = {
      url: () => "https://chatgpt.com/c/backend-stop",
      title: async () => "ChatGPT",
      content: async () => generating
        ? '<form><textarea></textarea><button aria-label="Stop answering"></button></form>'
        : '<main><div data-message-author-role="assistant">Partial response.</div></main>',
      getByRole: () => locator,
      waitForTimeout: async () => undefined
    };
    const session = new BackendSession({ page, now: () => new Date("2026-06-06T00:00:00.000Z") });

    for (const payload of [{}, { confirmStop: false }, { confirmStop: 1 }, { confirmStop: "true" }]) {
      const response = await send(session, "messages.stop", payload);
      expectOk(response);
      expect(response.result).toMatchObject({
        ok: false,
        status: "needs_confirmation",
        blocker: { code: "stop_generation_confirmation_required" }
      });
    }
    expect(clicks).toBe(0);

    const confirmed = await send(session, "messages.stop", { confirmStop: true, timeoutMs: 250 });
    expectOk(confirmed);
    expect(confirmed.result).toMatchObject({
      ok: true,
      data: { wasGenerating: true, stopped: true }
    });
    expect(clicks).toBe(1);
  });

  it("dispatches runner.plan through the public ChatGPT client", async () => {
    const response = await send(deterministicSession(), "runner.plan", {
      agent: { name: "reviewer", instructions: "Review deeply." },
      input: {
        input: "Assess the SDK shape.",
        thread: { type: "conversationId", conversationId: "abc-123" },
        response: { format: "markdown" }
      }
    });

    expect(response.ok).toBe(true);
    expectOk(response);
    expect(response.result).toMatchObject({
      name: "agent-run:reviewer",
      steps: [
        { command: "session.bootstrap" },
        { command: "threads.open", args: { conversationId: "abc-123" } },
        { command: "messages.ask" }
      ]
    });
  });

  it("dispatches runner.run and preserves structured browser-control results", async () => {
    const response = await send(deterministicSession({ maxPromptsPerRun: 0 }), "runner.run", {
      agent: { name: "reviewer" },
      input: "reply with hi"
    });

    expect(response.ok).toBe(true);
    expectOk(response);
    expect(response.result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      activeAgentName: "reviewer",
      output: [
        {
          type: "run.blocked",
          blocker: expect.objectContaining({
            kind: "confirmation",
            code: "run_budget_exceeded"
          })
        }
      ]
    });
  });

  it("dispatches responses.create without submitting unsupported calls", async () => {
    const response = await send(deterministicSession({ maxPromptsPerRun: 0 }), "responses.create", {
      input: "hi",
      model: "gpt-5.5"
    });

    expect(response.ok).toBe(true);
    expectOk(response);
    expect(response.result).toMatchObject({
      object: "chatgpt.browser.response",
      status: "unsupported",
      browser_control: {
        unsupported: [
          expect.objectContaining({ path: "model" })
        ]
      }
    });
  });

  it("dispatches command registry helpers", async () => {
    const session = deterministicSession();

    const commands = await send(session, "commands");
    expect(commands.ok).toBe(true);
    expectOk(commands);
    expect(commands.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "runner.run" })
    ]));

    const describe = await send(session, "describe", { name: "runner.run" });
    expectOk(describe);
    expect(describe).toMatchObject({
      ok: true,
      result: expect.objectContaining({
        name: "runner.run",
        layer: "workflow"
      })
    });

    const help = await send(session, "help", { topic: "runner.run" });
    expect(help.ok).toBe(true);
    expectOk(help);
    expect(help.result).toContain("runner.run");
  });

  it("dispatches doctor checks as typed command results", async () => {
    const reportDir = await mkdtemp(join(tmpdir(), "chatgpt-backend-doctor-"));
    const file = join(reportDir, "spec.md");
    await writeFile(file, "hello");
    const response = await send(deterministicSession(), "doctor", {
      check: ["bridge", "upload", "localization", "reports", "file_preflight"],
      files: [file],
      report: { destDir: reportDir }
    });

    expect(response.ok).toBe(true);
    expectOk(response);
    expect(response.result).toMatchObject({
      ok: true,
      status: "ok",
      data: {
        ready: false,
        checks: {
          bridge: {
            status: "blocked"
          },
          upload: {
            status: "unknown"
          },
          localization: {
            status: "unknown"
          },
          reports: {
            status: "ok"
          },
          file_preflight: {
            status: "ok",
            details: {
              pathCount: 1,
              totalBytes: 5
            }
          }
        }
      }
    });
  });

  it("dispatches files.preflight without requiring browser state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-backend-file-preflight-"));
    const file = join(dir, "spec.md");
    await writeFile(file, "hello");

    const response = await send(deterministicSession(), "files.preflight", {
      paths: [file]
    });

    expect(response.ok).toBe(true);
    expectOk(response);
    expect(response.result).toMatchObject({
      ok: true,
      status: "ok",
      data: {
        totalBytes: 5,
        files: [
          {
            path: file,
            name: "spec.md",
            bytes: 5,
            extension: ".md",
            mimeType: "text/markdown",
            category: "text"
          }
        ]
      }
    });
  });

  it("dispatches Project Sources dry-run and confirmation-gated add without browser mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-backend-project-sources-"));
    const file = join(dir, "brief.md");
    await writeFile(file, "hello");

    const plan = await send(deterministicSession(), "projects.sources.planAdd", {
      projectUrl: "https://chatgpt.com/g/g-p-example/project",
      files: [file]
    });
    expectOk(plan);
    expect(plan.result).toMatchObject({
      ok: true,
      status: "ok",
      data: {
        projectUrl: "https://chatgpt.com/g/g-p-example/project",
        operation: "append_add",
        dryRun: true,
        totalBytes: 5,
        files: [{ name: "brief.md", bytes: 5 }],
        batches: [{ index: 0, files: [{ name: "brief.md" }] }]
      }
    });

    const add = await send(deterministicSession(), "projects.sources.add", {
      projectUrl: "https://chatgpt.com/g/g-p-example/project",
      files: [file]
    });
    expectOk(add);
    expect(add.result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      blocker: {
        kind: "confirmation",
        code: "project_sources_add_confirmation_required"
      }
    });
  });

  it("keeps transactional operation failures free of request secrets", async () => {
    const prompt = "private prompt that must never be echoed";
    const path = "/private/user/secret/attachment.pdf";
    const response = await send(deterministicSession(), "operations.submit", {
      schemaVersion: "chatgpt.browser_control.operation_request.v1",
      operationId: "not-a-uuid",
      surface: "chat",
      prompt,
      target: { type: "new" },
      files: [{ path }]
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).not.toContain(prompt);
    expect(response.error.message).not.toContain(path);
    expect([
      "Transactional operation payload is invalid.",
      "Transactional browser operations are unavailable in this backend.",
      "Transactional browser operation could not complete safely."
    ]).toContain(response.error.message);
  });

  it("dispatches browser-free operations.inspect through the stable client facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-backend-operations-"));
    try {
      const journal = await OperationJournal.open({ stateRoot: root });
      const request: OperationSubmitRequestV1 = {
        schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
        operationId: "33333333-3333-4333-8333-333333333333",
        surface: "chat",
        prompt: "private backend prompt",
        target: { type: "new" },
        files: [{ path: "/private/backend/secret.txt" }]
      };
      const manifest = [{
        displayName: "secret.txt",
        bytes: 7,
        contentSha256: "c".repeat(64)
      }];
      const requestDigest = journal.submitRequestDigest(request, manifest);
      const loaded = await journal.create({
        type: "operation_created",
        operationId: request.operationId,
        requestDigest,
        surface: request.surface,
        createdAt: "2026-06-06T00:00:00.000Z"
      });
      const session = new BackendSession({ operations: { stateRoot: root } });
      const response = await send(session, "operations.inspect", {
        schemaVersion: OPERATION_INSPECT_REQUEST_SCHEMA_VERSION,
        handle: journal.handleFromState(loaded.state)
      });

      expectOk(response);
      expect(response.result).toMatchObject({
        schemaVersion: "chatgpt.browser_control.operation_inspect_result.v1",
        status: "pending",
        operationId: request.operationId,
        requestDigest,
        handle: {
          operationId: request.operationId,
          requestDigest
        }
      });
      const encoded = JSON.stringify(response.result);
      expect(encoded).not.toContain("private backend prompt");
      expect(encoded).not.toContain("/private/backend/secret.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards a validated collect poll interval through backend dispatch", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const session = new BackendSession();
    (session as unknown as { clientInstance: unknown }).clientInstance = {
      operations: {
        submit: async () => { throw new Error("unused"); },
        collect: async (_handle: unknown, options: Record<string, unknown>) => {
          capturedOptions = options;
          throw new Error("stop after capture");
        },
        inspect: async () => { throw new Error("unused"); },
        control: async () => { throw new Error("unused"); }
      }
    };

    const response = await send(session, "operations.collect", {
      schemaVersion: OPERATION_COLLECT_REQUEST_SCHEMA_VERSION,
      handle: {
        schemaVersion: "chatgpt.browser_control.operation_handle.v1",
        operationId: "33333333-3333-4333-8333-333333333333",
        requestDigest: "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        surface: "chat",
        revision: 3,
        phase: "generating",
        mutationBoundary: "send_may_have_occurred",
        targetBindingDigest: "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      wait: true,
      pollIntervalMs: 250
    });

    expect(capturedOptions).toEqual({ wait: true, pollIntervalMs: 250 });
    expect(response).toMatchObject({
      ok: false,
      error: { message: "Transactional browser operation could not complete safely." }
    });
  });
});

function deterministicSession(limits: { maxPromptsPerRun?: number } = {}): BackendSession {
  return new BackendSession({
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    limits
  });
}

async function send(session: BackendSession, command: BackendCommand, payload: Record<string, unknown> = {}) {
  return session.dispatch(parseBackendRequest({
    schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
    requestId: `req_${command}`,
    command,
    payload
  }));
}

function expectOk(response: BackendResponse): asserts response is BackendResponseOk {
  if (!response.ok) {
    throw new Error(`Expected backend response to be ok, got ${response.error.code}: ${response.error.message}`);
  }
}
