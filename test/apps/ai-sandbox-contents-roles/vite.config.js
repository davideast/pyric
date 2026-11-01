import { pyric } from "@pyric/cli/vite";

// The scenario runs the page once on the SharedWorker sandbox and once on the
// Node host (`hosted: true`), selected by SCENARIO_HOSTED.
export default {
  plugins: [pyric({ hosted: process.env.SCENARIO_HOSTED === "1" })],
};
