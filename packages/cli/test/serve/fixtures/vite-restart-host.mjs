// Drives Vite dev-server restarts on Node, where the hosted sandbox runs.
// Each argument is a project directory holding a `vite.config.mjs` that adds
// `pyric()`. The fixture starts one server per project, restarts the first one
// through `server.restart()` and through an edit to its config file, and prints
// one JSON report. Assertions stay in the test.
import { appendFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServer, createLogger } from 'vite';

const roots = process.argv.slice(2);

async function freePort() {
  const probe = createNetServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function capturingLogger(errors) {
  const logger = createLogger('silent');
  return {
    ...logger,
    error(message) { errors.push(String(message)); },
    warn() {},
    info() {},
  };
}

// A pooled keep-alive socket to the closed server resets once; retry on a new one.
async function fetchOnce(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    } catch (error) {
      const isReset = error?.cause?.code === 'ECONNRESET' || error?.cause?.code === 'UND_ERR_SOCKET';
      const retries = isReset && attempt < 3;
      if (!retries) throw error;
    }
  }
}

async function fetchJson(url, init) {
  const response = await fetchOnce(url, init);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function startProject(root) {
  const errors = [];
  const port = await freePort();
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.mjs'),
    customLogger: capturingLogger(errors),
    server: { port, host: '127.0.0.1', strictPort: true },
    optimizeDeps: { noDiscovery: true },
  });
  await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const instanceId = async () => (await fetchJson(`${base}/__pyric/health`)).body?.instanceId ?? null;
  const method = async (key, args) => {
    const id = await instanceId();
    return await fetchJson(`${base}/__pyric/hosted/method`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: id, projectDir: root, key, args }),
    });
  };
  const init = async () => (await fetchJson(`${base}/__pyric/init.json`)).status;
  return { root, server, errors, instanceId, method, init };
}

async function waitForNewInstance(project, previous, deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const current = await project.instanceId();
      const replaced = current !== null && current !== previous;
      if (replaced) return current;
    } catch {
      // The server is between generations.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

const report = {};
const projects = [];
try {
  for (const root of roots) projects.push(await startProject(root));
  const [first, ...others] = projects;
  const hosted = process.env.PYRIC_RESTART_HOSTED === '1';

  const startingInstance = await first.instanceId();
  if (hosted) report.write = (await first.method('database.set', { path: 'notes/a', value: 'before restart' })).body;
  const othersBefore = [];
  for (const other of others) {
    othersBefore.push(await other.instanceId());
    if (hosted) await other.method('database.set', { path: 'notes/a', value: `kept in ${other.root}` });
  }

  await first.server.restart();
  report.afterRestart = {
    errors: [...first.errors],
    init: await first.init(),
    replacedInstance: (await first.instanceId()) !== startingInstance,
    read: hosted ? (await first.method('database.get', { path: 'notes/a' })).body : null,
  };

  const restartedInstance = await first.instanceId();
  appendFileSync(join(first.root, 'vite.config.mjs'), '\n// edited\n');
  const editedInstance = await waitForNewInstance(first, restartedInstance, 15_000);
  report.afterConfigEdit = {
    errors: [...first.errors],
    replacedInstance: editedInstance !== null,
    init: await first.init(),
    read: hosted ? (await first.method('database.get', { path: 'notes/a' })).body : null,
  };

  report.others = [];
  for (const [index, other] of others.entries()) {
    report.others.push({
      sameInstance: (await other.instanceId()) === othersBefore[index],
      errors: [...other.errors],
      read: hosted ? (await other.method('database.get', { path: 'notes/a' })).body : null,
    });
  }
} catch (error) {
  report.failure = error instanceof Error ? `${error.stack} cause: ${error.cause?.message ?? error.cause}` : String(error);
  report.errorsAtFailure = projects.map(project => project.errors);
} finally {
  for (const project of projects) {
    try {
      await project.server.close();
    } catch (error) {
      report.closeFailure = error instanceof Error ? error.message : String(error);
    }
  }
}
console.log(JSON.stringify(report));
