import { defineConfig } from "vite";
import { pyric } from "@pyric/cli/vite";

// The report's config (#1575, #1584). The scenario points the gemini engine at
// a local stand-in for the Gemini API, so no request reaches Google.
export default defineConfig({
  plugins: [
    pyric({
      hosted: process.env.HOSTED === "1",
      functions: false,
      ui: false,
      ai: { engine: { kind: "gemini", baseUrl: process.env.GEMINI_STAND_IN_URL } },
    }),
  ],
});
