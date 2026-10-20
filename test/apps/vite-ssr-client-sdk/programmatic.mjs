// A framework CLI's shape: create the dev server through Vite's API, render
// once on the server, close the server, and let the process end on its own.
// SSR used RTDB, which holds a production Node process until goOffline() or
// deleteApp(); closing the dev server must release it. No process.exit.
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "warn" });
await server.listen();
const mod = await server.ssrLoadModule("/src/ssr.js");
const { outcomes } = await mod.run("programmatic");
console.log(`programmatic.database ${JSON.stringify(outcomes["database.ownPath"])}`);
await server.close();
console.log("programmatic closed");
