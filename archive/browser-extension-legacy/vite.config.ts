import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src",
  base: "./",
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "sidepanel.html",
    },
  },
});
