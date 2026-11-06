import { pyric } from "@pyric/cli/vite";

// The Node host by default; STORAGE_PER_BUCKET_PLANE=shared-worker serves the
// SharedWorker plane, whose pages fall back to the in-page sandbox when asked.
const hosted = process.env.STORAGE_PER_BUCKET_PLANE !== "shared-worker";

export default {
  plugins: [pyric({ hosted })],
};
