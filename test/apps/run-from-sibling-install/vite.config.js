import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const tools = createRequire(new URL("./tools/package.json", import.meta.url));
const { pyric } = await import(pathToFileURL(tools.resolve("@pyric/cli/vite")).href);

export default {
  plugins: [pyric({ hosted: true })],
};
