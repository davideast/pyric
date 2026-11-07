import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

// The backend verifies App Check tokens and sends push notifications with
// firebase-admin services live mode does not observe, so the app lists them.
// The scenario changes the list between starts through PASS_THROUGH.
const passThrough = JSON.parse(process.env.PASS_THROUGH ?? '["firebase-admin/app-check", "firebase-admin/messaging"]');

export default defineConfig({
  plugins: [pyricLive({ project: "demo-admin-subpaths", passThrough })],
});
