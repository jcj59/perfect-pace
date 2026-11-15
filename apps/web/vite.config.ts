import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { precachePlugin } from "./precache-plugin.ts";

export default defineConfig({
  plugins: [react(), tailwindcss(), precachePlugin()],
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
