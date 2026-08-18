import { describe, expect, it } from "vitest";
import { executeStep, resolveVariableReference, runSequenceWithExecutor } from "../../src/commands/sequence.js";
import type { CommandResult } from "../../src/types.js";

describe("runSequence", () => {
  it("stops after a failed step and returns prior successful results", async () => {
    const result = await runSequenceWithExecutor({
      name: "stop-example",
      policy: { stopOnError: true, returnPartial: true },
      steps: [
        { id: "find", command: "threads.search", args: { query: "Naming" } },
        { id: "open", command: "threads.open", args: { conversationId: "missing" } },
        { id: "ask", command: "messages.ask", args: { text: "hi" } }
      ]
    }, async step => {
      if (step.id === "open") {
        return { ok: false, status: "not_found", warnings: [], context: { timestamp: "t" } };
      }
      return { ok: true, status: "ok", data: { id: step.id }, warnings: [], context: { timestamp: "t" } };
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("partial");
    expect(result.steps?.map(step => step.id)).toEqual(["find", "open"]);
    expect((result.data as Record<string, unknown>).find).toEqual({ id: "find" });
  });

  it("resolves safe variable paths", () => {
    const previous = new Map<string, CommandResult<unknown>>();
    previous.set("find", {
      ok: true,
      status: "ok",
      data: { results: [{ conversationId: "abc" }] },
      warnings: [],
      context: { timestamp: "t" }
    });

    expect(resolveVariableReference("${find.data.results[0].conversationId}", previous)).toBe("abc");
  });

  it("exposes assistant response text at the top level of workflow results", async () => {
    const result = await runSequenceWithExecutor({
      name: "ask-example",
      steps: [
        { id: "bootstrap", command: "session.bootstrap" },
        { id: "ask", command: "messages.ask", args: { text: "hi" } }
      ]
    }, async step => ({
      ok: true,
      status: "ok",
      data: step.id === "ask" ? { prompt: "hi", responseText: "hello" } : {},
      warnings: [],
      context: { timestamp: "t" }
    }));

    expect(result.output_text).toBe("hello");
    expect((result.data as { responseText?: string }).responseText).toBe("hello");
  });

  it("preserves partial assistant response text when a step stops early", async () => {
    const result = await runSequenceWithExecutor({
      name: "partial-ask-example",
      steps: [
        { id: "ask", command: "messages.ask", args: { text: "hi" } }
      ]
    }, async () => ({
      ok: false,
      status: "partial",
      data: { prompt: "hi", responseText: "I will now produce the list.", complete: false },
      warnings: ["Timed out after receiving partial assistant text."],
      context: { timestamp: "t" }
    }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("partial");
    expect(result.output_text).toBe("I will now produce the list.");
    expect((result.data as { ask?: { responseText?: string } }).ask?.responseText).toBe("I will now produce the list.");
    expect(result.steps?.[0]?.status).toBe("partial");
  });

  it("rejects unsafe variable paths", () => {
    expect(() => resolveVariableReference("${input.__proto__.polluted}", new Map(), {})).toThrow("Unsafe");
  });

  it("routes messages.stop through the confirmation-gated sequence primitive", async () => {
    const result = await executeStep(
      { id: "stop", command: "messages.stop", args: {} },
      {},
      new Map()
    );

    expect(result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      blocker: { code: "stop_generation_confirmation_required" }
    });
  });

  it("fails closed when a runtime caller supplies an unclassified command", async () => {
    const result = await executeStep(
      { id: "future", command: "future.command" } as unknown as Parameters<typeof executeStep>[0],
      {},
      new Map()
    );

    expect(result).toMatchObject({
      ok: false,
      status: "error",
      error: {
        name: "CommandRoutingError",
        message: "The command has no explicit browser-routing classification."
      }
    });
  });

  it("fails closed before a legacy sequence handler sees an operation identity", async () => {
    const sensitivePrompt = "sequence prompt must stay out of routing errors";
    const result = await executeStep(
      {
        id: "status",
        command: "messages.status",
        args: {
          operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          prompt: sensitivePrompt
        }
      } as unknown as Parameters<typeof executeStep>[0],
      {},
      new Map()
    );

    expect(result).toMatchObject({
      ok: false,
      status: "error",
      error: {
        name: "CommandRoutingError",
        message: "An operation identity was supplied to a legacy browser command without an operation-aware dispatch seam."
      }
    });
    expect(JSON.stringify(result)).not.toContain(sensitivePrompt);
  });
});
