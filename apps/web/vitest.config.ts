import { defineConfig } from "vitest/config";

// Unit tests for the store, the sheet math and the worker bridge. The UI itself is covered by E2E.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("test") },
  test: { include: ["test/**/*.test.ts"] },
});
