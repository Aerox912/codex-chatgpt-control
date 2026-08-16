import { mkdtemp, writeFile } from "node:fs/promises";
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
    expect((capabilities.result as { commands: string[] }).commands).toContain("responses.create");
    expect((capabilities.result as { commands: string[] }).commands).toContain("files.preflight");
    expect((capabilities.result as { commands: string[] }).commands).toContain("projects.sources.add");
    expect((capabilities.result as { commands: string[] }).commands).toContain("messages.stop");
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
