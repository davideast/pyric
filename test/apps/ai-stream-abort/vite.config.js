import { defineConfig } from "vite";
import { pyric } from "@pyric/cli/vite";

export default defineConfig({
  plugins: [
    pyric({
      hosted: process.env.HOSTED === "1",
      functions: false,
      ui: false,
      ai: {
        engine: {
          kind: "gemini",
          baseUrl: process.env.GEMINI_STAND_IN_URL,
        },
      },
    }),
  ],
});
