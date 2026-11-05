import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Pyric is installed in the rules/ package beside this app, never in the
// app's own install, so the plugin loads from there.
const rules = createRequire(new URL("../rules/package.json", import.meta.url));
const { pyricLive } = await import(pathToFileURL(rules.resolve("@pyric/live/vite")).href);

export default {
  plugins: [pyricLive()],
};
