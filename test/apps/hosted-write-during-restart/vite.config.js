import { pyric } from "@pyric/cli/vite";

export default {
  plugins: [pyric({ hosted: true })],
  // Vite's client connects to a port nothing serves, gives up, and so never
  // reloads the page after a restart. `hmr: false` would also stop an edit to
  // this file from restarting the server.
  server: { port: 5181, strictPort: true, hmr: { clientPort: 1 } },
};
