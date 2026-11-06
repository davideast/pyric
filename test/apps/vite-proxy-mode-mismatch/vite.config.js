import { defineConfig } from "vite";
import { pyric } from "@pyric/cli/vite";

// The sandbox page proxies its API calls to three backends on this machine:
// one under `pyric run --sandbox` this host, one under @pyric/live/register,
// and one started bare. `/socket` is a WebSocket context on the live backend,
// as an app with socket.io writes one. The scenario picks each port.
const backend = (variable) => `http://127.0.0.1:${process.env[variable]}`;

export default defineConfig({
  plugins: [pyric({ hosted: true })],
  server: {
    proxy: {
      "/same": backend("SAME_PORT"),
      "/live": backend("LIVE_PORT"),
      "/plain": { target: backend("PLAIN_PORT"), changeOrigin: true },
      "/socket": { target: `ws://127.0.0.1:${process.env.LIVE_PORT}`, ws: true },
    },
  },
});
