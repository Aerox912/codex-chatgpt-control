import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fingerprintOperationFile,
  revalidateOperationFile
} from "../../src/operations/file-identity.js";

describe("operation file identity", () => {
  it("hashes in bounded chunks and returns a normalized manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-operation-file-hash-"));
    const path = join(root, "input.bin");
    const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    await writeFile(path, content);
    const chunks: number[] = [];

    const identity = await fingerprintOperationFile(path, "Cafe\u0301.bin", {
      chunkBytes: 32 * 1024,
      onChunk: bytes => chunks.push(bytes)
    });

    expect(identity.manifest).toEqual({
      displayName: "Café.bin",
      bytes: content.byteLength,
      contentSha256: createHash("sha256").update(content).digest("hex")
    });
    expect(chunks.length).toBeGreaterThan(2);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(32 * 1024);
    expect(JSON.stringify(identity.manifest)).not.toContain(path);
  });

  it("revalidates the exact inode and content immediately before handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-operation-file-revalidate-"));
    const path = join(root, "input.txt");
    await writeFile(path, "first");
    const identity = await fingerprintOperationFile(path);
    await revalidateOperationFile(identity);

    await writeFile(path, "other");
    await expect(revalidateOperationFile(identity)).rejects.toMatchObject({ code: "operation_file_changed" });
  });

  it("rejects symlinks and path-bearing display names", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-operation-file-symlink-"));
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "safe");
    if (process.platform !== "win32") {
      await symlink(target, link);
      await expect(fingerprintOperationFile(link)).rejects.toMatchObject({ code: "operation_file_not_regular" });
    }
    await expect(fingerprintOperationFile(target, "../private.txt")).rejects.toMatchObject({
      code: "invalid_file_display_name"
    });
    await expect(fingerprintOperationFile(target, "x".repeat(513))).rejects.toMatchObject({
      code: "invalid_file_display_name"
    });
    await expect(fingerprintOperationFile(target, "private\nname.txt")).rejects.toMatchObject({
      code: "invalid_file_display_name"
    });
  });

  it("rejects malformed source paths before path helpers can echo them", async () => {
    await expect(fingerprintOperationFile("private\0path")).rejects.toMatchObject({ code: "invalid_file_path" });
    await expect(fingerprintOperationFile("x".repeat(4097))).rejects.toMatchObject({ code: "invalid_file_path" });
  });

  it("honors cancellation before opening a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-operation-file-abort-"));
    const path = join(root, "input.txt");
    await writeFile(path, "safe");
    const controller = new AbortController();
    controller.abort();
    await expect(fingerprintOperationFile(path, "input.txt", { signal: controller.signal })).rejects.toMatchObject({
      code: "file_hash_aborted"
    });
  });

  it("does not expose a private local path in read failures", async () => {
    const privatePath = join(tmpdir(), "definitely-missing-private-name.txt");
    try {
      await fingerprintOperationFile(privatePath);
      throw new Error("Expected fingerprinting to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "operation_file_unavailable" });
      expect(String(error)).not.toContain(privatePath);
      expect(String(error)).not.toContain("definitely-missing-private-name");
    }
  });
});
