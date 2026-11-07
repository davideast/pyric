import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

// The page's API is the notes server on this machine, behind `/api`.
export default defineConfig({
  plugins: [pyricLive()],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${process.env.NOTES_API_PORT}`,
    },
  },
});
