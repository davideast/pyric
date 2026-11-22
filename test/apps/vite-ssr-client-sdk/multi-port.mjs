// Multi-server port handover and outside-cwd worker-thread SSR (#1144, #1145):
// runs from a working directory outside the Vite project root so .pyric/serve.json
// discovery from process.cwd() cannot find the host, starts a SharedWorker dev
// server and then two hosted dev servers on distinct ports in the same process,
// drives both main-thread SSR (existing default app + named app) and a
// worker-thread SSR runner, and lets the process exit on its own.
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createServer } from "vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
const workerFile = join(appRoot, "worker-ssr.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function runWorkerOnce(tag) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { tag } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

// 1. SharedWorker dev server on port 1: SSR refuses with failed-precondition.
const swPort = await freePort();
process.env.PYRIC_TEST_HOSTED = "0";
const swServer = await createServer({
  root: appRoot,
  configFile: join(appRoot, "vite.config.js"),
  server: { port: swPort, strictPort: true, host: "127.0.0.1" },
  logLevel: "warn",
});
await swServer.listen();
const swMod = await swServer.ssrLoadModule("/src/ssr.js");
const swRun = await swMod.run("sw-first");
const swWorker = await runWorkerOnce("sw-worker");
await swServer.close();

// 2. First hosted dev server on port 2: main-thread SSR + worker SSR succeed.
let h1Port = await freePort();
while (h1Port === swPort) h1Port = await freePort();
delete process.env.PYRIC_TEST_HOSTED;
const h1Server = await createServer({
  root: appRoot,
  configFile: join(appRoot, "vite.config.js"),
  server: { port: h1Port, strictPort: true, host: "127.0.0.1" },
  logLevel: "warn",
});
await h1Server.listen();
const h1Mod = await h1Server.ssrLoadModule("/src/ssr.js");
const h1Run = await h1Mod.run("hosted-1");
const h1Worker = await runWorkerOnce("hosted-1-worker");
await h1Server.close();

// 3. Second hosted dev server on port 3: same process's client apps follow the new port.
let h2Port = await freePort();
while (h2Port === swPort || h2Port === h1Port) h2Port = await freePort();
const h2Server = await createServer({
  root: appRoot,
  configFile: join(appRoot, "vite.config.js"),
  server: { port: h2Port, strictPort: true, host: "127.0.0.1" },
  logLevel: "warn",
});
await h2Server.listen();
const h2Mod = await h2Server.ssrLoadModule("/src/ssr.js");
const h2Run = await h2Mod.run("hosted-2");
const h2Admin = await (await h2Server.ssrLoadModule("/src/ssr-admin.js")).read(h2Run.uid, "hosted-2");
const h2Worker = await runWorkerOnce("hosted-2-worker");
await h2Server.close();

console.log(
  `multi-port ${JSON.stringify({
    ports: [swPort, h1Port, h2Port],
    swAuthCode: swRun.outcomes["auth.signIn"]?.code ?? null,
    swWorkerAdminCode: swWorker.outcomes["worker.adminDatabase"]?.code ?? null,
    h1: {
      db: h1Run.outcomes["database.readBack"],
      fs: h1Run.outcomes["firestore.readBack"],
      st: h1Run.outcomes["storage.readBack"],
      workerAdminDb: h1Worker.outcomes["worker.adminDatabase"],
    },
    h2: {
      db: h2Run.outcomes["database.readBack"],
      fs: h2Run.outcomes["firestore.readBack"],
      st: h2Run.outcomes["storage.readBack"],
      adminDb: h2Admin.outcomes["admin.database"],
      adminFs: h2Admin.outcomes["admin.firestore"],
      workerAdminDb: h2Worker.outcomes["worker.adminDatabase"],
    },
  })}`,
);
