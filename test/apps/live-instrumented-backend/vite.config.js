import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

// The page and its Node backend run against one live project.
export default defineConfig({
  plugins: [pyricLive({ project: "demo-instrumented-backend" })],
});
