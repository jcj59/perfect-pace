import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { precachePlugin } from "./precache-plugin.ts";

/**
 * The build's git commit, shown in "Report a problem" diagnostics. Turbo never caches the web
 * build (`turbo.json`), so this is always the commit being built.
 */
function appVersion(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return process.env["GITHUB_SHA"]?.slice(0, 7) || "unknown";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precachePlugin()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  // The core worker is an ES module (`new Worker(..., { type: "module" })`).
  worker: { format: "es" },
  build: {
    // MapLibre GL alone is about 1 MB minified; it loads in its own chunk, beside the panel.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // The service worker is its own entry, served at the root so its scope is the whole app.
      input: { index: "index.html", sw: "src/sw/sw.ts" },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  server: {
    // `pnpm dev` runs the Worker on 8787 alongside Vite; API calls go there.
    proxy: { "/api": "http://localhost:8787" },
  },
});
