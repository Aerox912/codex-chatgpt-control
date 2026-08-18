import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createChatGPT } from "../../src/client.js";
import { startWork, steerWork } from "../../src/commands/work.js";
import type { OperationBrowserAdapter } from "../../src/operations/service.js";
import {
  OPERATION_HANDLE_SCHEMA_VERSION,
  type OperationHandleV1,
  type OperationSubmitRequestV1
} from "../../src/operations/types.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CONTROL_ID = "22222222-2222-4222-8222-222222222222";

describe("transactional Work client path", () => {
  it("maps an explicit Work start into operations.run and preserves a durable blocker identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-work-transactional-start-"));
    const input = join(root, "brief.md");
    await writeFile(input, "private file contents");
    const captured: OperationSubmitRequestV1[] = [];
    const resolveTarget = vi.fn(async () => {
      const error = new Error("private provider details must not cross the result boundary") as Error & { code: string };
      error.code = "browser_bridge_unavailable";
      throw error;
    });
    const adapterFactory = vi.fn(async ({ request }: { request: OperationSubmitRequestV1 }) => {
      captured.push(request);
      return unavailableAfterTargetAdapter(resolveTarget);
    });
    const chatgpt = createChatGPT({ operations: { stateRoot: root, adapterFactory } });

    try {
      const result = await chatgpt.work.start({
        operationId: OPERATION_ID,
        prompt: "private Work prompt that must not echo",
        newTask: false,
        files: [input],
        configuration: { model: "GPT-5.6 Sol", effort: "High", speed: "Fast" },
        wait: false,
        read: false
      });

      expect(result.status).toBe("blocked");
      expect(result.data?.operationId).toBe(OPERATION_ID);
      expect(result.data?.handle).toMatchObject({ operationId: OPERATION_ID, surface: "work" });
      expect(result.blocker?.code).toBe("browser_bridge_unavailable");
      expect(JSON.stringify(result)).not.toContain("private Work prompt");
      expect(JSON.stringify(result)).not.toContain("private provider details");
      expect(adapterFactory).toHaveBeenCalledTimes(1);
      expect(resolveTarget).toHaveBeenCalledTimes(1);
      expect(captured[0]).toMatchObject({
        operationId: OPERATION_ID,
        surface: "work",
        prompt: "private Work prompt that must not echo",
        target: { type: "selected_tab" },
        configuration: {
          experience: "work",
          model: "GPT-5.6 Sol",
          additional: { effort: "High", speed: "Fast" }
        },
        files: [{ path: input }],
        capture: { responseContent: "metadata", artifacts: "receipt_only" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy Work start path untouched when operationId is absent", async () => {
    const adapterFactory = vi.fn(async () => {
      throw new Error("the legacy path must not construct an operation adapter");
    });
    const chatgpt = createChatGPT({ operations: { adapterFactory } });

    // This validates routing without touching a browser: the legacy command
    // reports its normal bootstrap blocker, while the operations factory is
    // never consulted.
    const result = await chatgpt.work.start({ prompt: "legacy Work prompt", wait: false, read: false });

    expect(result.status).not.toBe("unsupported");
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("rejects Work steer unless the exact Work handle, control ID, and turn are supplied", async () => {
    const adapterFactory = vi.fn(async () => {
      throw new Error("validation must finish before any adapter or browser work");
    });
    const chatgpt = createChatGPT({ operations: { adapterFactory } });
    const handle: OperationHandleV1 = {
      schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: `hmac-sha256:${"a".repeat(64)}`,
      surface: "chat",
      revision: 3,
      phase: "generating",
      mutationBoundary: "send_may_have_occurred",
      targetBindingDigest: `hmac-sha256:${"b".repeat(64)}`
    };

    const result = await chatgpt.work.steer({
      operationId: OPERATION_ID,
      handle,
      controlActionId: CONTROL_ID,
      expectedAssistantTurnId: "assistant-turn-1",
      prompt: "private steer instruction"
    });

    expect(result.status).toBe("unsupported");
    expect(result.blocker?.fieldPath).toBe("handle.surface");
    expect(result.data?.operationId).toBe(OPERATION_ID);
    expect(JSON.stringify(result)).not.toContain("private steer instruction");
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("does not accept wait/read on transactional steer, avoiding an unbound follow-up read", async () => {
    const adapterFactory = vi.fn(async () => {
      throw new Error("validation must finish before any adapter or browser work");
    });
    const chatgpt = createChatGPT({ operations: { adapterFactory } });
    const handle = workHandle();

    const result = await chatgpt.work.steer({
      operationId: OPERATION_ID,
      handle,
      controlActionId: CONTROL_ID,
      expectedAssistantTurnId: "assistant-turn-1",
      prompt: "private steer instruction",
      read: true
    });

    expect(result.status).toBe("unsupported");
    expect(result.blocker?.fieldPath).toBe("read");
    expect(JSON.stringify(result)).not.toContain("private steer instruction");
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("fails closed when a low-level Work command is given transactional identity", async () => {
    const start = await startWork({}, {
      operationId: OPERATION_ID,
      prompt: "private prompt"
    });
    const steer = await steerWork({}, {
      operationId: OPERATION_ID,
      controlActionId: CONTROL_ID,
      expectedAssistantTurnId: "assistant-turn-1",
      prompt: "private steer"
    });

    expect(start.blocker?.code).toBe("transactional_work_requires_client");
    expect(steer.blocker?.code).toBe("transactional_work_requires_client");
    expect(JSON.stringify(start)).not.toContain("private prompt");
    expect(JSON.stringify(steer)).not.toContain("private steer");
  });
});

function workHandle(): OperationHandleV1 {
  return {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: `hmac-sha256:${"a".repeat(64)}`,
    surface: "work",
    revision: 3,
    phase: "generating",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: `hmac-sha256:${"b".repeat(64)}`
  };
}

function unavailableAfterTargetAdapter(
  resolveTarget: OperationBrowserAdapter["resolveTarget"]
): OperationBrowserAdapter {
  const unavailable = async (): Promise<never> => {
    throw new Error("browser mutation must not run after target resolution failure");
  };
  return {
    resolveTarget,
    submission: {
      observeStaging: unavailable,
      executeFileHandoffOnce: unavailable,
      observeAttachments: unavailable,
      prepareSend: unavailable,
      executePreparedSend: unavailable,
      verifyPreparedSend: unavailable,
      recoverSend: unavailable,
      // Compatibility-only legacy surface. The transactional path must not
      // call this mutation-capable method.
      executeFinalTabTransaction: unavailable
    },
    collector: {
      readContext: unavailable,
      observe: unavailable,
      sleep: unavailable
    }
  };
}
