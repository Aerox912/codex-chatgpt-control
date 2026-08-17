import { constants as fsConstants, type BigIntStats } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";

const DEFAULT_HASH_CHUNK_BYTES = 64 * 1024;

export type OperationFileManifestEntryV1 = {
  displayName: string;
  bytes: number;
  contentSha256: string;
};

export type OperationFileIdentity = {
  /** Ephemeral local input. This value must never be written to the journal. */
  sourcePath: string;
  manifest: OperationFileManifestEntryV1;
  proof: {
    device: string;
    inode: string;
    size: string;
    modifiedNs: string;
    changedNs: string;
  };
};

export type OperationFileHashOptions = {
  signal?: AbortSignal;
  chunkBytes?: number;
  onChunk?: (bytes: number) => void;
};

export class OperationFileIdentityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OperationFileIdentityError";
  }
}

export async function fingerprintOperationFile(
  sourcePath: string,
  displayName?: string,
  options: OperationFileHashOptions = {}
): Promise<OperationFileIdentity> {
  if (
    typeof sourcePath !== "string"
    || sourcePath.length === 0
    || sourcePath.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(sourcePath)
  ) {
    throw new OperationFileIdentityError("invalid_file_path", "Operation input path must be a bounded local path without control characters.");
  }
  const canonicalPath = resolve(sourcePath);
  const normalizedDisplayName = validateDisplayName(displayName ?? basename(canonicalPath));
  const hashed = await hashRegularFile(canonicalPath, options);
  return {
    sourcePath: canonicalPath,
    manifest: {
      displayName: normalizedDisplayName,
      bytes: safeByteCount(hashed.stats.size),
      contentSha256: hashed.sha256
    },
    proof: fileProof(hashed.stats)
  };
}

/**
 * Re-open and stream the file immediately before handoff. The unavoidable gap
 * between this check and the browser accepting the file remains explicit; DOM
 * attachment labels must never be presented as proof of the content hash.
 */
export async function revalidateOperationFile(
  identity: OperationFileIdentity,
  options: OperationFileHashOptions = {}
): Promise<void> {
  const current = await fingerprintOperationFile(identity.sourcePath, identity.manifest.displayName, options);
  if (
    current.manifest.bytes !== identity.manifest.bytes ||
    current.manifest.contentSha256 !== identity.manifest.contentSha256 ||
    current.proof.device !== identity.proof.device ||
    current.proof.inode !== identity.proof.inode
  ) {
    throw new OperationFileIdentityError(
      "operation_file_changed",
      "An operation input file changed after its immutable request identity was established."
    );
  }
}

async function hashRegularFile(
  sourcePath: string,
  options: OperationFileHashOptions
): Promise<{ sha256: string; stats: BigIntStats }> {
  assertNotAborted(options.signal);
  const chunkBytes = options.chunkBytes ?? DEFAULT_HASH_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 16 * 1024 * 1024) {
    throw new OperationFileIdentityError("invalid_hash_chunk_size", "chunkBytes must be between 1 and 16777216 bytes.");
  }

  let pathMetadata: BigIntStats;
  try {
    pathMetadata = await lstat(sourcePath, { bigint: true });
  } catch (error) {
    throw localFileError(error, "operation_file_unavailable", "The operation input file is unavailable.");
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new OperationFileIdentityError("operation_file_not_regular", "Operation input must be a regular, non-symlinked file.");
  }

  let handle;
  try {
    handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw localFileError(error, "operation_file_unavailable", "The operation input file could not be opened safely.");
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      throw new OperationFileIdentityError("operation_file_changed", "The operation input file changed while it was being opened.");
    }

    const digest = createHash("sha256");
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: chunkBytes,
      signal: options.signal
    });
    try {
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        digest.update(bytes);
        options.onChunk?.(bytes.byteLength);
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new OperationFileIdentityError("file_hash_aborted", "Operation file hashing was cancelled.");
      }
      throw localFileError(error, "operation_file_read_failed", "The operation input file could not be read completely.");
    }

    const after = await handle.stat({ bigint: true });
    if (!sameOpenFileSnapshot(before, after)) {
      throw new OperationFileIdentityError("operation_file_changed", "The operation input file changed while it was being hashed.");
    }
    return { sha256: digest.digest("hex"), stats: after };
  } finally {
    await handle.close();
  }
}

function validateDisplayName(displayName: string): string {
  if (typeof displayName !== "string") {
    throw new OperationFileIdentityError("invalid_file_display_name", "Operation file displayName must be one safe path-free name.");
  }
  const normalized = displayName.normalize("NFC");
  if (
    normalized.length === 0
    || normalized.length > 512
    || normalized === "."
    || normalized === ".."
    || /[\\/\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new OperationFileIdentityError("invalid_file_display_name", "Operation file displayName must be one safe path-free name.");
  }
  return normalized;
}

function sameOpenFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fileProof(stats: BigIntStats): OperationFileIdentity["proof"] {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: stats.size.toString(),
    modifiedNs: stats.mtimeNs.toString(),
    changedNs: stats.ctimeNs.toString()
  };
}

function safeByteCount(size: bigint): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OperationFileIdentityError("operation_file_too_large", "Operation input size exceeds the supported safe integer range.");
  }
  return Number(size);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OperationFileIdentityError("file_hash_aborted", "Operation file hashing was cancelled.");
  }
}

function localFileError(error: unknown, code: string, fallback: string): OperationFileIdentityError {
  if (error instanceof OperationFileIdentityError) return error;
  const suffix = error instanceof Error && "code" in error
    ? ` (${String((error as NodeJS.ErrnoException).code)})`
    : "";
  return new OperationFileIdentityError(code, `${fallback}${suffix}`);
}
