import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

// The live page proxies its API to the backend that runs under
// `pyric run --sandbox`, a sandbox process behind a live page.
export default defineConfig({
  plugins: [pyricLive({ project: "demo-proxy-mismatch" })],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${process.env.SAME_PORT}`,
    },
  },
});
