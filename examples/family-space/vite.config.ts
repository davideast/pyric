import { diagnosticServer } from "./scripts/diagnostic-server";
import { defineConfig } from "vite";
import { pyric } from "@pyric/cli/vite";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
const remoteHost = process.env.FAMILY_REMOTE_HOST;
export default defineConfig({
  plugins: [
    diagnosticServer(),
    {
      name: "kin-preview-runtime",
      resolveId(id) {
        if (id === "virtual:kin-preview-runtime") return "\0" + id;
      },
      load(id) {
        if (id === "\0virtual:kin-preview-runtime") {
          this.addWatchFile(
            fileURLToPath(new URL("./src/apps/runtime/preview-runtime.tsx", import.meta.url)),
          );
          const result = buildSync({
            entryPoints: [
              fileURLToPath(new URL("./src/apps/runtime/preview-runtime.tsx", import.meta.url)),
            ],
            bundle: true,
            write: false,
            format: "iife",
            minify: true,
            define: { "process.env.NODE_ENV": '"production"' },
          });
          return "export default " + JSON.stringify(result.outputFiles[0].text);
        }
      },
    },
    pyric({
      seed: "seed.json",
      bridge: true,
      runtimeChip: true,
      // AI mode and provider come from .env.local (Pyric’s standard env configuration).
      ai: {},
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.FAMILY_PORT ?? 5227),
    strictPort: true,
    allowedHosts: remoteHost ? [remoteHost] : [],
    hmr: remoteHost
      ? {
          protocol: "wss",
          host: remoteHost,
          clientPort: Number(process.env.FAMILY_REMOTE_PORT ?? 8458),
        }
      : undefined,
  },
});
