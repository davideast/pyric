import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

// The app's own list of the Firebase services live mode does not serve, which
// load unobserved from its installed SDK. The scenario changes it between
// starts through PASS_THROUGH.
const passThrough = JSON.parse(process.env.PASS_THROUGH ?? '["firebase/functions", "firebase/remote-config"]');
const redirectsFirestoreRow = process.env.REDIRECT_FIRESTORE_ROW === "1";

const requireFromHere = createRequire(import.meta.url);
const firebaseRoot = dirname(requireFromHere.resolve("firebase/package.json"));
const firestoreLiteEntry = join(firebaseRoot, "firestore/lite/dist/esm/index.esm.js");

const redirectFirestoreRowPlugin = {
  name: "redirect-firestore-row",
  enforce: "pre",
  resolveId(source) {
    if (source === "firebase/firestore") {
      return firestoreLiteEntry;
    }
    return null;
  },
};

const plugins = [pyricLive({ project: "demo-live-pass-through", passThrough })];
if (redirectsFirestoreRow) {
  plugins.push(redirectFirestoreRowPlugin);
}

export default defineConfig({
  plugins,
});
