import { pyric } from "@pyric/cli/vite";

// The Node host by default; SANDBOX_APP_CHECK_PLANE=shared-worker serves the
// SharedWorker plane, whose pages fall back to the in-page sandbox when asked.
const hosted = process.env.SANDBOX_APP_CHECK_PLANE !== "shared-worker";

export default {
  plugins: [pyric({ hosted })],
  server: { port: 5184, strictPort: true },
};
