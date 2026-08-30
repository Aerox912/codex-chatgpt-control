import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPluginPreferences,
  importChatGPTControl,
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

  it("loads the packaged runtime with durable preparation and exact Project routing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-control-packaged-project-"));
    const captured: Array<{ target?: unknown }> = [];
    try {
      const runtime = await importChatGPTControl({
        cacheBust: true,
        preferencesPath: join(dir, "missing-preferences.json")
      });
      const chatgpt = runtime.createChatGPT({
        workspaceProject: {
          name: "Pokémon Burning Scales",
          path: String.raw`E:\Different\Workspace\Path`
        },
        operations: {
          stateRoot: dir,
          adapterFactory: async (context: { request: { target?: unknown } }) => {
            captured.push(context.request);
            throw new Error("packaged test stops before browser mutation");
          }
        }
      }) as {
        operations: {
          prepare(request: Record<string, unknown>): Promise<{
            handle: { operationId: string; phase: string; mutationBoundary: string };
          }>;
        };
        ask(args: Record<string, unknown>): Promise<{ status: string }>;
      };
      const schemaVersion = runtime.OPERATION_REQUEST_SCHEMA_VERSION as string;

      const projectPageMatchesTarget = runtime.projectPageMatchesTarget as (
        page: unknown,
        name: string
      ) => Promise<boolean>;
      const projectPage = packagedProjectPageFixture();
      expect(await projectPageMatchesTarget(
        projectPage,
        "Poke\u0301mon Burning Scales"
      )).toBe(true);
      const openOrCreateProjectForNewThread = runtime.openOrCreateProjectForNewThread as (
        env: { page: unknown },
        target: { name: string },
        timeoutMs: number
      ) => Promise<Record<string, unknown>>;
      expect(await openOrCreateProjectForNewThread(
        { page: projectPage },
        { name: "Poke\u0301mon Burning Scales" },
        250
      )).toMatchObject({
        ok: true,
        data: { name: "Poke\u0301mon Burning Scales", created: false }
      });

      const detectExperienceFromSnapshot = runtime.detectExperienceFromSnapshot as (
        snapshot: Record<string, unknown>
      ) => Record<string, unknown>;
      const detected = detectExperienceFromSnapshot({
        url: "https://chatgpt.com/g/g-p-packaged-project/project",
        composerLabels: ["New chat in Pokémon Burning Scales"],
        mainControls: ["Chat", "Pro"],
        mainText: "",
        selectedSurfaceLabels: []
      });
      expect(detected).toMatchObject({
        experience: "chat",
        selectorProfile: "project_chat_v1",
        confidence: "high"
      });

      const configurationInspectionFromSurface = runtime.configurationInspectionFromSurface as (
        experience: string,
        selectorProfile: string,
        evidence: unknown,
        panel: unknown,
        menuItems: unknown
      ) => Record<string, unknown>;
      const inspection = configurationInspectionFromSurface(
        detected.experience as string,
        detected.selectorProfile as string,
        detected.evidence,
        { openerLabel: "Pro", axisRows: [], advancedVisible: false },
        [
          { label: "Medium", normalized: "medium", role: "menuitemradio" },
          { label: "Pro", normalized: "pro", role: "menuitemradio", checked: true }
        ]
      );
      expect(inspection).toMatchObject({
        experience: "chat",
        selectorProfile: "project_chat_v1",
        active: { effort: "Pro" },
        verified: true
      });

      const prepared = await chatgpt.operations.prepare({
        schemaVersion,
        operationId: "20202020-2020-4020-8020-202020202020",
        surface: "chat",
        prompt: "not sent",
        target: { type: "project", name: "Pokémon Burning Scales" }
      });
      expect(prepared.handle).toMatchObject({
        operationId: "20202020-2020-4020-8020-202020202020",
        phase: "prepared",
        mutationBoundary: "none"
      });
      expect(captured).toHaveLength(0);

      const result = await chatgpt.ask({
        operationId: "21212121-2121-4121-8121-212121212121",
        prompt: "not sent",
        wait: false,
        read: false
      });
      expect(result.status).toBe("blocked");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.target).toEqual({
        type: "project",
        name: "Pokémon Burning Scales",
        icon: "Folder",
        color: "blue"
      });
      expect(captured[0]?.target).not.toEqual({ type: "new" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function packagedProjectPageFixture() {
  type FixtureLocator = {
    count(): Promise<number>;
    first(): FixtureLocator;
    nth(index: number): FixtureLocator;
    getAttribute(name: string): Promise<string | null>;
  };
  const locator = (count: number, accessibleName?: string): FixtureLocator => {
    const value: FixtureLocator = {
      count: async () => count,
      first: () => value,
      nth: () => value,
      getAttribute: async name => name === "aria-label" ? accessibleName ?? null : null
    };
    return value;
  };
  const empty = locator(0);
  const composer = locator(1, "New chat in Pokémon Burning Scales");
  return {
    url: () => "https://chatgpt.com/g/g-p-packaged-project/project",
    getByRole: (role: string, options?: { name?: string | RegExp }) => {
      if (role !== "textbox" || !(options?.name instanceof RegExp)) return empty;
      return options.name.test("New chat in Pokémon Burning Scales") ? composer : empty;
    }
  };
}
