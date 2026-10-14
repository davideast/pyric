// A server process attached to a hosted Vite dev server through
// `remoteSandbox()` (what `PYRIC_SANDBOX=remote:<url>` installs) keeps working
// across a restart from a config edit (#949). The argument is a project
// directory holding a `vite.config.mjs` that adds `pyric({ hosted: true })`.
// Prints one JSON report; assertions stay in the test.
import { appendFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServer, createLogger } from 'vite';
import { remoteSandbox } from '@pyric/cli/remote';

const root = process.argv[2];

async function freePort() {
  const probe = createNetServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitFor(condition, deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (await condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

const report = { values: [], listenerErrors: [], failedWritesAfterRestart: 0 };
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.mjs'),
  customLogger: { ...createLogger('silent'), error() {}, warn() {}, info() {} },
  server: { port, host: '127.0.0.1', strictPort: true },
  optimizeDeps: { noDiscovery: true },
});
await server.listen();
const instanceId = async () => {
  try {
    return (await (await fetch(`${base}/__pyric/health`, { signal: AbortSignal.timeout(2000) })).json()).instanceId ?? null;
  } catch {
    return null;
  }
};

const sandbox = remoteSandbox({ url: base });
try {
  sandbox.rtdb.onValue(
    'ticks',
    snapshot => report.values.push(snapshot.value),
    error => report.listenerErrors.push(`${error.code} ${error.message}`),
  );
  await sandbox.rtdb.set('ticks', 'before restart');
  report.listenedBefore = await waitFor(() => report.values.includes('before restart'), 5_000);

  const before = await instanceId();
  appendFileSync(join(root, 'vite.config.mjs'), '\n// edited\n');
  report.restarted = await waitFor(async () => {
    const current = await instanceId();
    return current !== null && current !== before;
  }, 15_000);

  report.wroteAfterRestart = await waitFor(async () => {
    try {
      await sandbox.rtdb.set('ticks', 'after restart');
      return true;
    } catch {
      report.failedWritesAfterRestart += 1;
      return false;
    }
  }, 10_000);
  report.readAfterRestart = report.wroteAfterRestart ? await sandbox.rtdb.get('ticks') : null;
  report.listenedAfter = await waitFor(() => report.values.includes('after restart'), 5_000);
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error);
} finally {
  sandbox.close();
  await server.close();
}
console.log(JSON.stringify(report));
