// Runs #949's reproduction: a hosted Vite dev server, and an API server
// attached to it through `node --import @pyric/cli/register` with
// PYRIC_SANDBOX=remote:<url> (`remote-admin-ticks.mjs`). The fixture lets a
// few ticks land, edits `vite.config.mjs` so Vite restarts, and reports what
// the API server saw after the restart. The argument is a project directory
// holding a `vite.config.mjs` that adds `pyric({ hosted: true })`. Prints one
// JSON report; assertions stay in the test.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServer, createLogger } from 'vite';

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

const report = { events: [] };
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

const client = spawn(
  process.execPath,
  ['--import', '@pyric/cli/register', new URL('./remote-admin-ticks.mjs', import.meta.url).pathname],
  { cwd: root, env: { ...process.env, PYRIC_SANDBOX: `remote:${base}` }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let stderr = '';
let buffered = '';
client.stderr.on('data', chunk => { stderr += chunk; });
client.stdout.on('data', chunk => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) if (line.trim() !== '') report.events.push({ ...JSON.parse(line), afterRestart: report.restarted === true });
});
const okTicks = (afterRestart) => report.events.filter(e => e.kind === 'tick' && e.ok && e.afterRestart === afterRestart);

try {
  report.tickedBefore = await waitFor(() => okTicks(false).length >= 2, 15_000);
  const before = await instanceId();
  appendFileSync(join(root, 'vite.config.mjs'), '\n// edited\n');
  report.restarted = await waitFor(async () => {
    const current = await instanceId();
    return current !== null && current !== before;
  }, 15_000);
  report.tickedAfter = await waitFor(() => okTicks(true).length >= 2, 10_000);
  const lastTick = okTicks(true).at(-1)?.n;
  report.listenedAfter = await waitFor(
    () => report.events.some(e => e.kind === 'value' && e.afterRestart && e.value === lastTick),
    5_000,
  );
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error);
} finally {
  client.kill();
  await new Promise(resolve => client.once('exit', resolve));
  await server.close();
}
report.clientStderr = stderr;
console.log(JSON.stringify(report));
