import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";

// Pyric is pinned in the rules/ package beside this app, never in the app's
// own install, so the plugin loads from there, as the sandbox launcher loads
// @pyric/cli/vite. Cloud Messaging is a live row, so it needs no list entry.
const rules = createRequire(new URL("../rules/package.json", import.meta.url));
const { pyricLive } = await import(pathToFileURL(rules.resolve("@pyric/live/vite")).href);

export default defineConfig({
  plugins: [pyricLive()],
});
