import { defineConfig } from "vite";
import { pyricLive } from "@pyric/live/vite";

// The app's own list of the Firebase services live mode does not serve, which
// load unobserved from its installed SDK. The scenario changes it between
// starts through PASS_THROUGH.
const passThrough = JSON.parse(process.env.PASS_THROUGH ?? '["firebase/storage", "firebase/ai"]');

export default defineConfig({
  plugins: [pyricLive({ project: "demo-live-pass-through", passThrough })],
});
