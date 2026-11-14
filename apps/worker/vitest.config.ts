import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Integration tests run inside workerd via Miniflare, with the real wrangler.jsonc bindings
// (including the built web assets, so `@pp/web` must be built first; turbo handles that).
// `ORS_API_KEY` is a fake key: upstream calls are answered from test/fixtures/ors.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ORS_API_KEY: "test-ors-key" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
