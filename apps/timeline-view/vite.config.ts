import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemonToken = process.env.METAFLOW_AUTH_TOKEN?.trim();
const daemonProxy = {
  target: "http://127.0.0.1:3111",
  ...(daemonToken ? { headers: { authorization: `Bearer ${daemonToken}` } } : {}),
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ambient": daemonProxy,
      "/metaflow": daemonProxy,
    },
  },
  build: { target: "es2022", sourcemap: true },
});
