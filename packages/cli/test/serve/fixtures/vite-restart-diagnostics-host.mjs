// Drives a real Node + Vite `{ hosted: true }` restart while continuously
// posting browser connection reports to `/__pyric/diagnostics` (#2098).
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createLogger, createServer } from 'vite';

const root = process.argv[2];
if (!root) throw new Error('Usage: vite-restart-diagnostics-host.mjs <root>');

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const port = await freePort();
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.mjs'),
  customLogger: createLogger('silent'),
  server: { port, host: '127.0.0.1', strictPort: true },
  optimizeDeps: { noDiscovery: true },
});
await server.listen();

const base = `http://127.0.0.1:${port}`;
const reportBody = JSON.stringify({
  version: 1,
  clientId: 'tab-restart-live',
  sequence: 1,
  realm: 'page',
  pageOrigin: base,
  events: [
    {
      at: 1,
      phase: 'socket-close',
      connectionId: 'c1',
      endpoint: `ws://127.0.0.1:${port}/__pyric/sandbox`,
      code: 1006,
    },
  ],
});

async function readInstanceId() {
  const res = await fetch(`${base}/__pyric/health`, { signal: AbortSignal.timeout(5000) });
  if (res.status !== 200) return null;
  const json = await res.json();
  return json?.instanceId ?? null;
}

const beforeId = await readInstanceId();
const statuses = [];
let running = true;

const poster = (async () => {
  while (running) {
    try {
      const res = await fetch(`${base}/__pyric/diagnostics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: reportBody,
        signal: AbortSignal.timeout(5000),
      });
      statuses.push(res.status);
    } catch (error) {
      const code = error?.cause?.code;
      const transientSocketReset = code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'ECONNREFUSED';
      if (!transientSocketReset) {
        statuses.push(-1);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
})();

try {
  await server.restart();
  let afterId = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    afterId = await readInstanceId().catch(() => null);
    if (afterId && afterId !== beforeId) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  running = false;
  await poster;
  process.stdout.write(
    `${JSON.stringify({
      beforeId,
      afterId,
      replacedInstance: Boolean(beforeId && afterId && beforeId !== afterId),
      statuses,
    })}\n`,
  );
} finally {
  running = false;
  await server.close();
}
