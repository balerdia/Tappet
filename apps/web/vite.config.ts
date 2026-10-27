import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One .env at the repo root serves the API and the web app.
  envDir: "../..",
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
