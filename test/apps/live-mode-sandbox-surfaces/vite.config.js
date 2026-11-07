import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

// The live host serves the project the replay recorded.
export default defineConfig({
  plugins: [pyricLive({ project: "demo-live-traffic" })],
});
