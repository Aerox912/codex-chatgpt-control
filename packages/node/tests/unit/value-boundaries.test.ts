import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isByteArrayView, isPlainDataRecord } from "../../src/runtime/value-boundaries.js";

describe("isByteArrayView", () => {
  it("accepts one-byte typed arrays from a foreign realm", () => {
    const foreignBytes = runInNewContext("new Uint8Array([1, 2, 3])") as unknown;

    expect(foreignBytes instanceof Uint8Array).toBe(false);
    expect(isByteArrayView(foreignBytes)).toBe(true);
  });

  it("rejects wider views, DataView, and non-views", () => {
    expect(isByteArrayView(new Uint16Array([1, 2]))).toBe(false);
    expect(isByteArrayView(new DataView(new ArrayBuffer(4)))).toBe(false);
    expect(isByteArrayView({ BYTES_PER_ELEMENT: 1, length: 2, byteLength: 2 })).toBe(false);
  });
});

describe("isPlainDataRecord", () => {
  it("accepts ordinary data records from a foreign realm", () => {
    const foreignRecord = runInNewContext("({ nested: { value: 1 } })") as unknown;

    expect(isPlainDataRecord(foreignRecord)).toBe(true);
  });

  it("rejects arrays, custom-class instances, and accessors", () => {
    const foreignClass = runInNewContext("new (class Example { constructor() { this.value = 1; } })()") as unknown;
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "private" });

    expect(isPlainDataRecord([])).toBe(false);
    expect(isPlainDataRecord(foreignClass)).toBe(false);
    expect(isPlainDataRecord(accessor)).toBe(false);
  });
});
