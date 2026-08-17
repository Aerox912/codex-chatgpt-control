import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendSessionOptions } from "./session.js";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_BACKEND_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_ANCESTORS = 8;
const MAX_IDENTITY_FIELD_LENGTH = 512;

type PackageMetadata = Readonly<{
  packageName?: string;
  packageVersion?: string;
}>;

/**
 * Resolve truthful provenance for the exact backend entry artifact.
 *
 * The digest is computed from the loaded file, so copied/sanitized plugin
 * bundles do not accidentally inherit the source bundle's identity. Package
 * metadata is discovered from a bounded ancestor walk and is optional:
 * unknown is preferable to guessing when a custom embedding has no manifest.
 */
export async function detectPackagedBackendIdentity(
  moduleUrl: string | URL
): Promise<BackendSessionOptions["backendIdentity"]> {
  const artifactPath = modulePath(moduleUrl);
  const [metadata, buildDigest] = await Promise.all([
    findPackageMetadata(dirname(artifactPath)),
    digestArtifact(artifactPath)
  ]);
  return {
    ...(metadata.packageName === undefined ? {} : { packageName: metadata.packageName }),
    ...(metadata.packageVersion === undefined ? {} : { packageVersion: metadata.packageVersion }),
    ...(buildDigest === undefined ? {} : { buildDigest })
  };
}

function modulePath(moduleUrl: string | URL): string {
  try {
    const url = moduleUrl instanceof URL ? moduleUrl : new URL(moduleUrl);
    if (url.protocol !== "file:") throw new TypeError("Backend module URL must use file protocol.");
    return resolve(fileURLToPath(url));
  } catch (error) {
    throw new TypeError(
      `Backend module URL is invalid: ${error instanceof Error ? error.message : "unknown URL error"}`
    );
  }
}

async function digestArtifact(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size > MAX_BACKEND_ARTIFACT_BYTES) {
      return undefined;
    }
    const bytes = await handle.readFile();
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function findPackageMetadata(start: string): Promise<PackageMetadata> {
  let current = resolve(start);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    for (const candidate of [join(current, "package.json"), join(current, ".codex-plugin", "plugin.json")]) {
      const parsed = await readBoundedJson(candidate);
      if (parsed === undefined) continue;
      const packageName = identityField(parsed.name);
      const packageVersion = identityField(parsed.version);
      if (packageName !== undefined || packageVersion !== undefined) {
        return {
          ...(packageName === undefined ? {} : { packageName }),
          ...(packageVersion === undefined ? {} : { packageVersion })
        };
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {};
}

async function readBoundedJson(path: string): Promise<Record<string, unknown> | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size > MAX_METADATA_BYTES) return undefined;
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function identityField(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTITY_FIELD_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
