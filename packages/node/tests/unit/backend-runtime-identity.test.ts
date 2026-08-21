import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { detectPackagedBackendIdentity } from "../../src/backend/runtime-identity.js";

describe("packaged backend runtime identity", () => {
  it("reports the exact loaded artifact digest and nearest package metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "backend-runtime-identity-"));
    const dist = join(root, "dist", "src", "scripts");
    await mkdir(dist, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "example-control", version: "1.2.3" }));
    const artifact = join(dist, "backend.js");
    const bytes = "console.log('exact artifact');\n";
    await writeFile(artifact, bytes);

    const identity = await detectPackagedBackendIdentity(pathToFileURL(artifact));
    expect(identity).toEqual({
      packageName: "example-control",
      packageVersion: "1.2.3",
      buildDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    });
  });

  it("discovers plugin metadata for a regular entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "backend-plugin-identity-"));
    const runtime = join(root, "runtime", "node");
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await mkdir(runtime, { recursive: true });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "codex-chatgpt-control",
      version: "0.5.1-alpha.3"
    }));
    const entry = join(runtime, "backend.mjs");
    const bytes = "export {};\n";
    await writeFile(entry, bytes);

    const identity = await detectPackagedBackendIdentity(pathToFileURL(entry));
    expect(identity).toEqual({
      packageName: "codex-chatgpt-control",
      packageVersion: "0.5.1-alpha.3",
      buildDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    });
  });

  it.skipIf(process.platform === "win32")("refuses to hash a symlinked entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "backend-plugin-identity-"));
    const runtime = join(root, "runtime", "node");
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await mkdir(runtime, { recursive: true });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "codex-chatgpt-control",
      version: "0.5.1-alpha.3"
    }));
    const target = join(runtime, "target.mjs");
    const entry = join(runtime, "backend.mjs");
    await writeFile(target, "export {};\n");
    await symlink(target, entry);

    const identity = await detectPackagedBackendIdentity(pathToFileURL(entry));
    expect(identity).toEqual({
      packageName: "codex-chatgpt-control",
      packageVersion: "0.5.1-alpha.3"
    });
  });
});
