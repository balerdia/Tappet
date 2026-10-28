import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Keep the browser's Host header, so the API builds sign-in callbacks
    // for this address (:5173) rather than its own.
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
