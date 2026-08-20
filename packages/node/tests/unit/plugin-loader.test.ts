import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPluginPreferences,
  loadPluginPreferences
} from "../../../../plugins/codex-chatgpt-control/runtime/import-chatgpt-control.mjs";

describe("Codex plugin preferences", () => {
  it("derives the workspace Project from the bridge-hosted workspace by default", () => {
    const bridgeGlobal = globalThis as typeof globalThis & { nodeRepl?: { cwd?: string } };
    const previousNodeRepl = bridgeGlobal.nodeRepl;
    bridgeGlobal.nodeRepl = { cwd: String.raw`C:\Users\you\codex-chatgpt-control` };
    try {
      const applied = applyPluginPreferences({ reporting: { enabled: true } }, {});
      expect(applied).toMatchObject({
        workspaceProject: {
          path: String.raw`C:\Users\you\codex-chatgpt-control`
        }
      });
    } finally {
      if (previousNodeRepl === undefined) delete bridgeGlobal.nodeRepl;
      else bridgeGlobal.nodeRepl = previousNodeRepl;
    }
  });

  it("turns durable workspace auto-create approval into a client default", () => {
    const applied = applyPluginPreferences(
      { workspaceProject: { path: String.raw`C:\Users\you\future-project` } },
      { workspaceProjects: { autoCreate: true } }
    );

    expect(applied).toMatchObject({
      workspaceProject: {
        path: String.raw`C:\Users\you\future-project`,
        confirmCreation: true
      }
    });
  });

  it("preserves explicit per-run safety choices and fails closed on invalid preferences", async () => {
    const explicit = { workspaceProject: { path: "/repo", confirmCreation: false } };
    expect(applyPluginPreferences(explicit, { workspaceProjects: { autoCreate: true } })).toBe(explicit);
    const global = { workspaceProject: false as const };
    expect(applyPluginPreferences(global)).toBe(global);

    const dir = await mkdtemp(join(tmpdir(), "chatgpt-control-preferences-"));
    const path = join(dir, "preferences.json");
    try {
      await writeFile(path, "not json", "utf8");
      expect(await loadPluginPreferences({ path })).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
