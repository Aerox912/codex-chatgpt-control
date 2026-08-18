import { beforeEach, describe, expect, it, vi } from "vitest";

const canaryMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  resolveBrowser: vi.fn(),
  runSmoke: vi.fn()
}));

vi.mock("../../src/browser/attach.js", () => ({
  resolveChatGPTBrowser: canaryMocks.resolveBrowser
}));

vi.mock("../../src/scripts/capture-surface-profile.js", () => ({
  main: canaryMocks.capture
}));

vi.mock("../../src/scripts/live-smoke/harness.js", () => ({
  filterScenarios: (scenarios: Array<{ name: string }>, namesCsv: string) => {
    const names = new Set(namesCsv.split(","));
    return scenarios.filter(scenario => names.has(scenario.name));
  },
  runLiveSmoke: canaryMocks.runSmoke
}));

vi.mock("../../src/scripts/live-smoke/scenarios.js", () => ({
  requiredScenarios: [
    { name: "chat-work-expansion" },
    { name: "configuration-mutate-restore" },
    { name: "download-generated-file" }
  ],
  optionalScenarios: [{ name: "attach-one-file" }]
}));

import { runReleaseCanary } from "../../src/scripts/release-canary-module.js";

describe("release canary", () => {
  beforeEach(() => {
    canaryMocks.capture.mockReset();
    canaryMocks.resolveBrowser.mockReset();
    canaryMocks.runSmoke.mockReset();
  });

  it("requires a bridge-hosted runtime before touching ChatGPT", async () => {
    await expect(runReleaseCanary({}, { tabId: "dedicated-tab" })).rejects.toThrow("bridge-hosted");
  });

  it("requires exact dedicated-tab affinity", async () => {
    await expect(runReleaseCanary({ agent: {} }, { tabId: "  " })).rejects.toThrow("exact dedicated ChatGPT tab id");
  });

  it("uses agent acquisition for behavior and reserves the caller browser for cleanup", async () => {
    const close = vi.fn(async () => undefined);
    const managedBrowser = {
      tabs: {
        get: vi.fn(async () => ({ close }))
      }
    };
    const rawBrowser = { tabs: { finalize: vi.fn(async () => undefined) } };
    canaryMocks.resolveBrowser.mockResolvedValue(managedBrowser);
    canaryMocks.capture.mockResolvedValue(0);
    canaryMocks.runSmoke.mockResolvedValue({
      reportPath: "/tmp/redacted-live-smoke.json",
      requiredFailures: [],
      results: [
        { name: "chat-work-expansion", status: "pass", cleanup: { attempted: true, ok: true } },
        { name: "configuration-mutate-restore", status: "pass", cleanup: { attempted: true, ok: true } },
        { name: "download-generated-file", status: "pass", cleanup: { attempted: true, ok: true } },
        { name: "attach-one-file", status: "pass", cleanup: { attempted: true, ok: true } }
      ]
    });

    const result = await runReleaseCanary(
      { agent: { browsers: {} }, browser: rawBrowser as never },
      { tabId: "dedicated-tab", reportDir: "/tmp/canary", includeUpload: true }
    );

    expect(result.ok).toBe(true);
    expect(canaryMocks.resolveBrowser).toHaveBeenCalledWith({ agent: { browsers: {} } });
    expect(canaryMocks.capture).toHaveBeenCalledTimes(2);
    for (const call of canaryMocks.capture.mock.calls) {
      expect(call[1]).toEqual({ agent: { browsers: {} } });
      expect(call[1]).not.toHaveProperty("browser");
    }
    expect(managedBrowser.tabs.get).toHaveBeenCalledWith("dedicated-tab");
    expect(close).toHaveBeenCalledTimes(1);
    expect(canaryMocks.runSmoke.mock.calls[0]?.[0]).toMatchObject({
      agent: { browsers: {} },
      browser: managedBrowser,
      cleanupBrowser: rawBrowser
    });
    expect(canaryMocks.runSmoke.mock.calls[0]?.[0].browser).not.toBe(rawBrowser);
    expect(canaryMocks.runSmoke.mock.calls[0]?.[0].cleanupBrowser).not.toBe(managedBrowser);
  });

  it("fails the release gate when behavior passes but exact tab cleanup does not", async () => {
    canaryMocks.resolveBrowser.mockResolvedValue({
      tabs: { get: vi.fn(async () => ({ close: vi.fn(async () => undefined) })) }
    });
    canaryMocks.capture.mockResolvedValue(0);
    canaryMocks.runSmoke.mockResolvedValue({
      reportPath: "/tmp/redacted-live-smoke.json",
      requiredFailures: [],
      results: [
        { name: "chat-work-expansion", status: "pass", cleanup: { attempted: true, ok: true } },
        {
          name: "configuration-mutate-restore",
          status: "pass",
          cleanup: { attempted: false, ok: false, reason: "exact cleanup unavailable" }
        },
        { name: "download-generated-file", status: "pass", cleanup: { attempted: true, ok: true } }
      ]
    });

    const result = await runReleaseCanary(
      { agent: { browsers: {} } },
      { tabId: "dedicated-tab", reportDir: "/tmp/canary" }
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["configuration-mutate-restore:cleanup"]);
  });
});
