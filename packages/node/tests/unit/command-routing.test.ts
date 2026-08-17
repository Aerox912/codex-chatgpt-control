import { describe, expect, it } from "vitest";
import { BackendSession } from "../../src/backend/session.js";
import { BACKEND_REQUEST_SCHEMA_VERSION, backendCommands, type BackendRequest } from "../../src/backend/protocol.js";
import { commandDescriptors } from "../../src/commands/registry.js";
import {
  COMMAND_ROUTING_GAPS,
  COMMAND_ROUTING_INVENTORY,
  assertOperationAwareDispatchAllowed,
  classifyCommandRouting,
  commandRoutingDisposition,
  commandRoutingInventory,
  hasOperationIdentity,
  isBrowserFreeCommand,
  isCoordinatorRoutedCommand,
  routeCommandExecution,
  routeCommandRuntimeEnv,
  routeCommandBrowserTransaction
} from "../../src/runtime/command-routing.js";
import type { PageLike } from "../../src/types.js";

describe("command routing inventory", () => {
  it("classifies every registered descriptor and backend command exactly once", () => {
    const names = [
      ...commandDescriptors().map(descriptor => descriptor.name),
      ...backendCommands
    ];
    const expected = [...new Set(names)].sort();
    const inventory = commandRoutingInventory();

    expect(Object.keys(inventory).sort()).toEqual(expected);
    for (const name of expected) {
      expect(classifyCommandRouting(name)).toBe(inventory[name]);
      expect([
        "browser_free",
        "operation_opt_in",
        "legacy_page_facade",
        "legacy_browser_unrouted",
        "coordinator_entrypoint"
      ]).toContain(inventory[name]);
    }

    expect(COMMAND_ROUTING_INVENTORY.browserFree).toContain("operations.inspect");
    expect(COMMAND_ROUTING_INVENTORY.operationOptIn).toContain("ask");
    expect(COMMAND_ROUTING_INVENTORY.legacyPageFacade).toContain("messages.stop");
    expect(COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted).toEqual([]);
    expect(COMMAND_ROUTING_INVENTORY.coordinatorEntrypoint).toEqual([]);
  });

  it("collapses the explicit inventory into browser-free or coordinator-routed", () => {
    const names = [...new Set([
      ...commandDescriptors().map(descriptor => descriptor.name),
      ...backendCommands
    ])];

    expect(COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted).toEqual([]);
    for (const name of names) {
      expect(commandRoutingDisposition(name)).toBeDefined();
      expect(isBrowserFreeCommand(name) || isCoordinatorRoutedCommand(name)).toBe(true);
      expect(isBrowserFreeCommand(name) && isCoordinatorRoutedCommand(name)).toBe(false);
    }
  });

  it("keeps a complete machine-readable migration gap inventory", () => {
    const gapCommands = COMMAND_ROUTING_GAPS.map(gap => gap.command).sort();
    expect(gapCommands).toEqual([...COMMAND_ROUTING_INVENTORY.legacyBrowserUnrouted].sort());
    expect(new Set(gapCommands).size).toBe(gapCommands.length);
    for (const gap of COMMAND_ROUTING_GAPS) {
      expect(gap.status).toBe("legacy_browser_unrouted");
      expect(gap.requiredSeam).toBe("bounded_tab_transaction");
      expect(gap.owner.length).toBeGreaterThan(0);
      expect(gap.reason).toBe("legacy_command_dispatch_has_no_operation_aware_tab_seam");
    }
  });

  it("fails closed for a command that is not in the explicit inventory", async () => {
    expect(classifyCommandRouting("future.command")).toBeUndefined();
    await expect(routeCommandBrowserTransaction("future.command", undefined, () => "unreachable"))
      .rejects.toMatchObject({ code: "unclassified_command" });
  });

  it("rejects an unclassified backend dispatch before creating a client facade", async () => {
    const response = await new BackendSession().dispatch({
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      command: "future.command",
      payload: {}
    } as unknown as BackendRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        message: "Backend command routing classification is unavailable."
      }
    });
  });
});

describe("classification versus coordinator execution", () => {
  it("orders legacy browser calls through one process-scoped actor", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let callCount = 0;
    const rawPage: PageLike = {
      content: async () => {
        const call = ++callCount;
        events.push(`start:${call}`);
        if (call === 1) {
          await new Promise<void>(resolve => { releaseFirst = resolve; });
        }
        events.push(`end:${call}`);
        return "<main />";
      }
    };

    const first = routeCommandExecution("messages.status", { page: rawPage }, routed => routed.page!.content!());
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = routeCommandExecution("messages.status", { page: rawPage }, routed => routed.page!.content!());
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events).toEqual(["start:1"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["<main />", "<main />"]);
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("keeps the coordinated facade on the mutable legacy invocation environment", () => {
    const rawPage: PageLike = { content: async () => "<main />" };
    const env = { page: rawPage };
    const routed = routeCommandRuntimeEnv("messages.status", env);

    expect(routed).toBe(env);
    expect(env.page).not.toBe(rawPage);
  });

  it("coordinates the legacy path of operation-opt-in commands", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let callCount = 0;
    const rawPage: PageLike = {
      content: async () => {
        const call = ++callCount;
        events.push(`start:${call}`);
        if (call === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
        events.push(`end:${call}`);
        return "<main />";
      }
    };

    const first = routeCommandExecution("work.start", { page: rawPage }, routed => routed.page!.content!());
    await new Promise<void>(resolve => queueMicrotask(resolve));
    const second = routeCommandExecution("work.start", { page: rawPage }, routed => routed.page!.content!());
    await new Promise<void>(resolve => queueMicrotask(resolve));

    expect(events).toEqual(["start:1"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["<main />", "<main />"]);
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("does not retain a tab actor while a legacy caller callback is waiting", async () => {
    const events: string[] = [];
    let releaseCallback!: () => void;
    const rawPage: PageLike = {
      content: async () => {
        events.push("browser-call");
        return "<main />";
      }
    };

    const waiting = routeCommandExecution("messages.status", { page: rawPage }, async routed => {
      events.push("callback-enter");
      await new Promise<void>(resolve => { releaseCallback = resolve; });
      return routed.page!.content!();
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const other = routeCommandExecution("messages.status", { page: rawPage }, routed => routed.page!.content!());
    await expect(other).resolves.toBe("<main />");
    expect(events).toEqual(["callback-enter", "browser-call"]);

    releaseCallback();
    await expect(waiting).resolves.toBe("<main />");
    expect(events).toEqual(["callback-enter", "browser-call", "browser-call"]);
  });

  it("does not turn a legacy classification into coordinator execution", async () => {
    let callbackInvoked = false;
    expect(classifyCommandRouting("messages.status")).toBe("legacy_page_facade");

    await expect(routeCommandBrowserTransaction("messages.status", undefined, () => {
      callbackInvoked = true;
      return "unreachable";
    })).rejects.toMatchObject({ code: "legacy_page_facade" });

    expect(callbackInvoked).toBe(false);
  });

  it("does not wrap operation-facade commands in a whole-command transaction", async () => {
    let callbackInvoked = false;
    expect(classifyCommandRouting("operations.submit")).toBe("operation_opt_in");

    await expect(routeCommandBrowserTransaction("operations.submit", undefined, () => {
      callbackInvoked = true;
      return "unreachable";
    })).rejects.toMatchObject({ code: "operation_facade_managed" });

    expect(callbackInvoked).toBe(false);
  });

  it("bypasses the coordinator for browser-free commands", async () => {
    let callbackAcquisition: unknown = "unset";
    await expect(routeCommandBrowserTransaction("files.preflight", undefined, acquisition => {
      callbackAcquisition = acquisition;
      return "preflight";
    })).resolves.toBe("preflight");
    expect(callbackAcquisition).toBeUndefined();
  });

  it("fails closed before a legacy handler sees an operation identity", async () => {
    const sensitivePrompt = "do not echo this operation prompt";
    const response = await new BackendSession().dispatch({
      schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
      command: "messages.status",
      payload: {
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        prompt: sensitivePrompt
      }
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        message: "An operation identity was supplied to a legacy browser command without an operation-aware dispatch seam."
      }
    });
    expect(JSON.stringify(response)).not.toContain(sensitivePrompt);
  });

  it("detects operation identity without invoking caller accessors", () => {
    let reads = 0;
    const payload = Object.defineProperty({}, "prompt", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private getter must not run");
      }
    });

    expect(hasOperationIdentity(payload)).toBe(true);
    expect(() => assertOperationAwareDispatchAllowed("messages.status", payload))
      .toThrow(/operation identity was supplied/i);
    expect(reads).toBe(0);
  });

  it("fails closed when an operation locator is hidden beyond the traversal bound", () => {
    let payload: Record<string, unknown> = { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    for (let depth = 0; depth < 10; depth += 1) payload = { nested: payload };

    expect(hasOperationIdentity(payload)).toBe(true);
    expect(() => assertOperationAwareDispatchAllowed("messages.status", payload))
      .toThrow(/operation identity was supplied/i);
  });
});
