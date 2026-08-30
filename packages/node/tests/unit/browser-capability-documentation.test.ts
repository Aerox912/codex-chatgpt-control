import { describe, expect, it, vi } from "vitest";
import { authorizeBrowserCdp } from "../../src/browser/capability-documentation.js";

describe("Browser capability documentation", () => {
  it("reads the required CDP documentation once before authorizing commands", async () => {
    const get = vi.fn(async () => "CDP documentation");
    const agent = { documentation: { get } };

    await expect(authorizeBrowserCdp(agent)).resolves.toBe(true);
    await expect(authorizeBrowserCdp(agent)).resolves.toBe(true);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("capabilities/tab/cdp");
  });

  it("fails closed when the host documentation surface is unavailable", async () => {
    await expect(authorizeBrowserCdp({})).resolves.toBe(false);
    await expect(authorizeBrowserCdp({
      documentation: { get: async () => { throw new Error("unavailable"); } }
    })).resolves.toBe(false);
  });
});
