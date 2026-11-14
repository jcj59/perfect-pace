import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `pnpm dev` runs the Worker on 8787 alongside Vite; API calls go there.
    proxy: { "/api": "http://localhost:8787" },
  },
});
