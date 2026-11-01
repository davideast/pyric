import { defineConfig } from "vite";
import { pyric } from "@pyric/cli/vite";

// The plugin's default plane (the SharedWorker) with the scripted engine. The
// two entries answer the page's two prompts, so the streaming call has more
// than one chunk to stream.
export default defineConfig({
  plugins: [
    pyric({
      ai: {
        engine: {
          kind: "scripted",
          script: [
            { match: "Summarise this report.", respond: { text: "The report is ready for review." } },
            { match: "Stream a short reply.", respond: { chunks: ["Requests stay ", "on this machine, ", "chunk by chunk."] } },
          ],
        },
      },
    }),
  ],
});
