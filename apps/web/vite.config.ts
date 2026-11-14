import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The core worker is an ES module (`new Worker(..., { type: "module" })`).
  worker: { format: "es" },
  build: {
    // MapLibre GL alone is about 1 MB minified; it loads in its own chunk, beside the panel.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    // `pnpm dev` runs the Worker on 8787 alongside Vite; API calls go there.
    proxy: { "/api": "http://localhost:8787" },
  },
});
