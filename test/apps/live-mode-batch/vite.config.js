import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

export default defineConfig({
  plugins: [pyricLive()],
});
