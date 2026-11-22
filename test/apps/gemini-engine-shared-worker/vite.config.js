import { defineConfig } from "vite";
import { pyric } from "@pyric/cli/vite";

// The report's config (#1575, #1584, #1591). The scenario points the gemini
// engine at a local stand-in for the Gemini API, so no request reaches Google.
const geminiEngine = {
  kind: "gemini",
  baseUrl: process.env.GEMINI_STAND_IN_URL,
};
if (process.env.GEMINI_CONFIG_API_KEY) {
  geminiEngine.apiKey = process.env.GEMINI_CONFIG_API_KEY;
}

export default defineConfig({
  plugins: [
    pyric({
      hosted: process.env.HOSTED === "1",
      functions: false,
      ui: false,
      ai: { engine: geminiEngine },
    }),
  ],
});
