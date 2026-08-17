/**
 * Internal source-to-file streaming boundary.
 *
 * A provider owns the bytes it yields.  The local output sink must therefore
 * copy a chunk before its first asynchronous effect.  The transfer wrapper
 * already crosses that ownership boundary before it hands a source to the
 * output sink; the weak set lets the sink use that defensive copy directly
 * instead of allocating a second full-sized copy.
 *
 * This module is intentionally not re-exported from the public operations
 * barrel.  Its marker is an implementation detail, not a wire/API contract.
 */

/**
 * Keep one hostile provider allocation well below the 512 MiB artifact cap.
 * Built-in download adapters yield 64 KiB chunks and are unaffected.
 */
export const MAX_PROVIDER_CHUNK_BYTES = 8 * 1024 * 1024;

const ownedChunks = new WeakSet<Uint8Array>();

export function copyProviderChunk(value: unknown, maxBytes = MAX_PROVIDER_CHUNK_BYTES): Uint8Array {
  const allowedBytes = Number.isSafeInteger(maxBytes) && maxBytes >= 0
    ? Math.min(maxBytes, MAX_PROVIDER_CHUNK_BYTES)
    : -1;
  if (!(value instanceof Uint8Array)
    || allowedBytes < 0
    || value.byteLength > allowedBytes) {
    throw new Error("provider chunk is invalid or oversized");
  }
  const copy = new Uint8Array(value);
  ownedChunks.add(copy);
  return copy;
}

export function isOwnedProviderChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && ownedChunks.has(value);
}
