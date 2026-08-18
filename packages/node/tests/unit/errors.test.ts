import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { nodeErrorCode } from "../../src/errors.js";

describe("nodeErrorCode", () => {
  it("accepts an own errno code from a foreign Error realm", () => {
    const foreignError = runInNewContext(
      "Object.assign(new Error('missing'), { code: 'ENOENT' })"
    ) as unknown;

    expect(foreignError instanceof Error).toBe(false);
    expect(nodeErrorCode(foreignError)).toBe("ENOENT");
  });

  it("does not trust inherited codes or invoke accessors", () => {
    const inherited = Object.create({ code: "ENOENT" });
    const accessor = {};
    Object.defineProperty(accessor, "code", {
      configurable: true,
      get() {
        throw new Error("must not run");
      }
    });

    expect(nodeErrorCode(inherited)).toBeUndefined();
    expect(nodeErrorCode(accessor)).toBeUndefined();
    expect(nodeErrorCode(null)).toBeUndefined();
  });
});
