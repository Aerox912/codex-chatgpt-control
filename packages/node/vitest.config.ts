import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Transactional journal/service tests intentionally exercise real fsync
    // and subprocess boundaries. Hosted CI filesystems can exceed Vitest's
    // generic five-second default without violating any production deadline.
    testTimeout: 15_000
  }
});
