// A Vite page proxies `/api`-style paths to a backend on this machine. When
// the page is a sandbox and the backend is not under pyric, or is in live
// mode, the backend's Firebase calls reach production (#2304). The Vite
// plugin asks each loopback `server.proxy` target for its process health once
// the dev server listens, and again on the first proxied response for a
// target that did not answer. The host's `/__pyric/health` lists each
// verdict as `proxyTargets`.
//
// One backend script, `backend.mjs`, with no Firebase import, runs three
// ways: under `pyric run --sandbox` this host (`same`), under
// `@pyric/live/register` (`other-mode`), and bare (`not-pyric`). The sandbox
// page's config also has a `ws:` context on the live backend, which once
// stopped the dev server at start; the dev server stays up and asks it over
// HTTP. The `same` backend starts after the host, so its verdict comes from
// the first proxied request. A live page proxied to the sandbox backend
// lists it as `other-mode`; it starts once the sandbox page stops, since one
// hosted dev server owns a project's state.
//
// The scenario asserts health data only, never the warning lines.
import assert from 'node:assert/strict';
import { scenario, sessionHeaders, sleep, type App, type AppProcess } from '../driver.ts';

const PROJECT = 'demo-proxy-mismatch';

interface ProxyTargetReport { context: string; verdict: string }
interface Host { url: string; process: AppProcess }

/** Starts the app's Vite dev server with `config`, and waits until its host health answers. */
async function startVite(app: App, env: Record<string, string>, config?: string): Promise<Host> {
  const port = await app.freePort();
  const configArgs = config === undefined ? [] : ['--config', config];
  const args = ['node_modules/vite/bin/vite.js', ...configArgs, '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  const process = app.commandProcess('node', args, { env });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (!process.running) throw new Error(`vite exited (code ${await process.exited}) before it served ${url}:\n${process.output}`);
    const answered = await fetch(`${url}/__pyric/health`).then((response) => response.ok, () => false);
    if (answered) return { url, process };
    if (Date.now() > deadline) throw new Error(`vite did not serve ${url}/__pyric/health within 90s:\n${process.output}`);
    await sleep(250);
  }
}

async function proxyTargets(app: App, url: string, authenticated: boolean): Promise<ProxyTargetReport[] | undefined> {
  const health = await (await fetch(`${url}/__pyric/health`, authenticated ? { headers: sessionHeaders(app, url) } : undefined)).json() as { proxyTargets?: ProxyTargetReport[] };
  return health.proxyTargets;
}

function verdicts(reports: ProxyTargetReport[] | undefined): Record<string, string> | undefined {
  if (reports === undefined) return undefined;
  return Object.fromEntries(reports.map((report) => [report.context, report.verdict]));
}

/** Waits until the host's health lists `expected` as its proxy verdicts. */
async function waitForVerdicts(app: App, host: Host, expected: Record<string, string>, authenticated = false): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const listed = verdicts(await proxyTargets(app, host.url, authenticated));
    const matches = JSON.stringify(listed) === JSON.stringify(expected);
    if (matches) return;
    if (Date.now() > deadline) assert.deepEqual(listed, expected, 'the health proxyTargets verdicts');
    await sleep(200);
  }
}

/** Starts `backend.mjs` with `command`, and waits until it listens. */
async function startBackend(start: (env: Record<string, string>) => AppProcess, name: string, port: number): Promise<AppProcess> {
  const backend = start({ BACKEND_NAME: name, BACKEND_PORT: String(port) });
  await backend.waitForLog(new RegExp(`${name} backend listening on ${port}`));
  return backend;
}

export default scenario(async (app) => {
  // The live register reads the project from the checkout.
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  const ports = { SAME_PORT: String(await app.freePort()), LIVE_PORT: String(await app.freePort()), PLAIN_PORT: String(await app.freePort()) };

  await app.step('start the backend under @pyric/live/register and the backend started bare', async () => {
    await startBackend((env) => app.commandProcess('node', ['--import', '@pyric/live/register', 'backend.mjs'], { env }), 'live', Number(ports.LIVE_PORT));
    await startBackend((env) => app.commandProcess('node', ['backend.mjs'], { env }), 'plain', Number(ports.PLAIN_PORT));
  });

  const sandbox = await app.step('start the sandbox page, with a ws: proxy context among its four', () => startVite(app, ports));

  await app.step('the sandbox host lists /live and /socket as other-mode and /plain as not-pyric, and stays up', async () => {
    await waitForVerdicts(app, sandbox, { '/same': 'not-pyric', '/live': 'other-mode', '/plain': 'not-pyric', '/socket': 'other-mode' });
    assert.ok(sandbox.process.running, sandbox.process.output);
  });

  await app.step('start the /same backend under pyric run --sandbox this host, after the host', async () => {
    await startBackend((env) => app.pyricProcess(['run', '--sandbox', sandbox.url, '--', 'node', 'backend.mjs'], { env }), 'same', Number(ports.SAME_PORT));
  });

  await app.step('the first proxied request to /same gives it its verdict: same', async () => {
    const response = await fetch(`${sandbox.url}/same/ping`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { backend: 'same', path: '/same/ping' });
    await waitForVerdicts(app, sandbox, { '/same': 'same', '/live': 'other-mode', '/plain': 'not-pyric', '/socket': 'other-mode' });
  });

  // One hosted dev server owns a project's state, so the live page starts
  // after the sandbox page stops. The backend stays a sandbox process.
  await app.step('stop the sandbox page', () => sandbox.process.stop());

  await app.step('the live page lists its proxy to the sandbox backend as other-mode', async () => {
    const live = await startVite(app, { SAME_PORT: ports.SAME_PORT }, 'vite.live.config.js');
    await waitForVerdicts(app, live, { '/api': 'other-mode' }, true);
  });
});
