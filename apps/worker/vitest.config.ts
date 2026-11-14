import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Integration tests run inside workerd via Miniflare, with the real wrangler.jsonc bindings
// (including the built web assets, so `@pp/web` must be built first; turbo handles that).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
