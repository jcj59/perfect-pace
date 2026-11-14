import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    benchmark: { include: ["bench/**/*.bench.ts"] },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // Coverage floor for @pp/core. CI fails below it.
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
