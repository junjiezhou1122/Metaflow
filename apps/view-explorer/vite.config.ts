import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["graphology", "graphology-layout-forceatlas2", "graphology-layout-noverlap"],
  },
  server: {
    proxy: {
      "/ambient": "http://127.0.0.1:3111",
      "/metaflow": "http://127.0.0.1:3111",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("graphology-layout-")) return "layout";
          if (id.includes("node_modules/graphology") || id.includes("node_modules/sigma")) return "graph";
          return undefined;
        },
      },
    },
  },
});
