import { defineConfig } from "vite";
import { pyric } from "@pyric/cli/vite";

const remoteHost = process.env.TEAMS_REMOTE_HOST;

export default defineConfig({
  plugins: [
    pyric({
      seed: "seed.json",
      bridge: true,
      runtimeChip: true,
      ai: { model: "ornith:9b" },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.TEAMS_PORT ?? 5217),
    strictPort: true,
    allowedHosts: remoteHost ? [remoteHost] : [],
    hmr: remoteHost ? {
      protocol: "wss",
      host: remoteHost,
      clientPort: Number(process.env.TEAMS_REMOTE_PORT ?? 8457),
    } : undefined,
  },
});
