/** Repository convenience launcher. Application code uses firebase/*; Vite injects Pyric. */
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
});
await server.listen();
server.printUrls();
