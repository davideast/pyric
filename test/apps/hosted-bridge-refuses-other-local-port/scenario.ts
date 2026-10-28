// The Node host answers only pages of its own app. `pyric sandbox --hosted
// --bridge` runs on one port. A page served on a second localhost port opens
// `/__pyric/sandbox`, attaches, and asks for an admin write and read. It also
// sends a no-cors text/plain POST to `/__pyric/hosted/method` carrying the
// host's real instance id and project directory. Both origins are loopback,
// so only the port tells them apart. The host refuses both, while the page it
// serves on its own port still attaches and a CLI command with no Origin
// still writes. Before each socket, the other page also sends a CORS request
// that names its own port in `x-forwarded-host`, the header a dev-server
// proxy sets, so the host must not take that port as the app's. The same
// holds for the Vite plugin's hosted mount, whose dev server answers the
// CORS preflight for localhost origins.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { scenario, sleep, type App, type AppProcess } from '../driver.ts';

interface SocketAttempt {
  attached: boolean;
  wrote: boolean;
  readBack: unknown;
  note: string;
}

interface MethodCall {
  instanceId: string;
  projectDir: string;
  key: string;
  args: Record<string, unknown>;
}

/** Runs in the page: open the bridge socket, attach, write `path` as admin, and read it back. */
async function trySocket(input: { url: string; path: string }): Promise<SocketAttempt> {
  return await new Promise<SocketAttempt>((resolve) => {
    const result: SocketAttempt = { attached: false, wrote: false, readBack: null, note: '' };
    const finish = (note: string) => {
      result.note = note;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish('timed out'), 10_000);
    const socket = new WebSocket(input.url);
    const pending = new Map<string, (frame: { ok?: boolean; value?: unknown; error?: unknown }) => void>();
    let next = 0;
    const op = (body: Record<string, unknown>) => new Promise<{ ok?: boolean; value?: unknown; error?: unknown }>((done) => {
      next += 1;
      const id = `op-${next}`;
      pending.set(id, done);
      socket.send(JSON.stringify({ type: 'worker-op', id, op: body }));
    });
    socket.onerror = () => finish('socket refused');
    socket.onclose = () => finish('socket closed');
    socket.onmessage = async (event) => {
      const frame = JSON.parse(String(event.data)) as { type?: string; id?: string };
      if (frame.type === 'worker-res' && frame.id !== undefined) pending.get(frame.id)?.(frame);
      if (frame.type !== 'attach-ack') return;
      result.attached = true;
      const write = await op({ method: 'admin.setDocument', path: input.path, data: { from: 'other page' }, actAs: { mode: 'admin' } });
      result.wrote = write.ok === true;
      const read = await op({ method: 'admin.getDocument', path: input.path, actAs: { mode: 'admin' } });
      result.readBack = read.value ?? read.error ?? null;
      finish('done');
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
  });
}

/** Runs in the page: a POST a page can send without a preflight. */
async function tryMethod(input: { url: string; body: string }): Promise<string> {
  try {
    await fetch(input.url, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: input.body });
    return 'sent';
  } catch (error) {
    return `threw ${String(error)}`;
  }
}

/** Runs in the page: a CORS request naming the page's own port as the proxy's. */
async function tryNamingOwnPort(input: { url: string; forwardedHost: string }): Promise<string> {
  try {
    const response = await fetch(input.url, { headers: { 'x-forwarded-host': input.forwardedHost } });
    return `answered ${response.status}`;
  } catch (error) {
    return `threw ${String(error)}`;
  }
}

/** A direct command from Node, with no Origin, the way `pyric` calls the host. */
async function callMethod(base: string, call: MethodCall): Promise<string> {
  const response = await fetch(`${base}/__pyric/hosted/method`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  });
  return `${response.status} ${await response.text()}`;
}

async function startOtherPortServer(port: number): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>other</title><p>Another local app.</p>');
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

async function waitForHost(base: string, running: () => boolean): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert.ok(running(), 'pyric sandbox exited before it served /__pyric/health');
    try {
      const health = await (await fetch(`${base}/__pyric/health`)).json() as { instanceId?: string };
      if (typeof health.instanceId === 'string') return health.instanceId;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, `pyric sandbox did not answer ${base}/__pyric/health within 60s`);
    await sleep(250);
  }
}

export default scenario(async (app) => {
  // The refusals this app checks for: the other page's service command, and
  // the request that names its own port, which no route answers.
  app.expectHostError(/^403 POST \/__pyric\/hosted\/method$/);
  app.expectHostError(/^\d+ GET \/__pyric\/not-a-route$/);
  const hostPort = await app.freePort();
  const otherPort = await app.freePort();
  const base = `http://localhost:${hostPort}`;
  const socketUrl = `ws://localhost:${hostPort}/__pyric/sandbox`;
  const projectDir = realpathSync(app.dir);

  let sandbox: AppProcess | undefined;
  const instanceId = await app.step('pyric sandbox --hosted --bridge serves the project', async () => {
    const host = app.pyricProcess(['sandbox', '--hosted', '--bridge', '--no-open', '--port', String(hostPort)]);
    sandbox = host;
    return await waitForHost(base, () => host.running);
  });

  const other = await app.step('another local app serves a page on a second port', () => startOtherPortServer(otherPort));
  try {
    const page = await app.step('the other page opens', () => app.page(`http://localhost:${otherPort}/`));

    await app.step('the host refuses the other page\'s bridge socket', async () => {
      const forwardedHost = `localhost:${otherPort}`;
      await page.evaluate(tryNamingOwnPort, { url: `${base}/__pyric/not-a-route`, forwardedHost });
      const attempt = await page.evaluate(trySocket, { url: socketUrl, path: 'scratch/socket' });
      assert.deepEqual(
        { attached: attempt.attached, wrote: attempt.wrote },
        { attached: false, wrote: false },
        `the page on port ${otherPort} attached to the host on port ${hostPort}: ${JSON.stringify(attempt)}`,
      );
    });

    await app.step('the host refuses the other page\'s service command', async () => {
      const body = JSON.stringify({
        instanceId, projectDir, key: 'firestore.setDoc', args: { path: 'scratch/method', data: { from: 'other page' } },
      });
      assert.equal(await page.evaluate(tryMethod, { url: `${base}/__pyric/hosted/method`, body }), 'sent');
      // Give a command that got through time to land before reading.
      await sleep(1_000);
      for (const path of ['scratch/socket', 'scratch/method']) {
        const read = await callMethod(base, { instanceId, projectDir, key: 'firestore.getDoc', args: { path } });
        assert.ok(read.startsWith('200 '), read);
        assert.ok(!read.includes('other page'), `the other page wrote ${path}: ${read}`);
      }
    });

    await app.step('a direct command with no Origin still writes', async () => {
      const write = await callMethod(base, {
        instanceId, projectDir, key: 'firestore.setDoc', args: { path: 'scratch/direct', data: { from: 'cli' } },
      });
      assert.match(write, /^200 .*"ok":true/, write);
      const read = await callMethod(base, { instanceId, projectDir, key: 'firestore.getDoc', args: { path: 'scratch/direct' } });
      assert.ok(read.includes('cli'), read);
    });

    await app.step('the page the host serves on its own port still attaches', async () => {
      const own = await app.page(`${base}/`);
      const attempt = await own.evaluate(trySocket, { url: socketUrl, path: 'scratch/own' });
      assert.equal(attempt.attached, true, JSON.stringify(attempt));
      await own.close();
    });

    await app.step('pyric sandbox stops', async () => {
      await sandbox?.stop();
    });

    const vite = await app.step('the Vite plugin\'s hosted dev server serves the project', () => app.devServer());

    await app.step('the Vite host refuses the other page\'s bridge socket after a CORS request naming its port', async () => {
      const forwardedHost = `localhost:${otherPort}`;
      const sent = await page.evaluate(tryNamingOwnPort, { url: `${vite.url}/__pyric/not-a-route`, forwardedHost });
      // Vite answers the preflight for a localhost origin, so the request reaches the plugin.
      assert.match(sent, /^answered /, sent);
      const viteSocket = `ws://127.0.0.1:${vite.port}/__pyric/sandbox`;
      const attempt = await page.evaluate(trySocket, { url: viteSocket, path: 'scratch/vite-socket' });
      assert.deepEqual(
        { attached: attempt.attached, wrote: attempt.wrote },
        { attached: false, wrote: false },
        `the page on port ${otherPort} attached to the Vite host on port ${vite.port}: ${JSON.stringify(attempt)}`,
      );
    });

    await app.step('the page the Vite host serves still attaches', async () => {
      const own = await app.page(`${vite.url}/`);
      const attempt = await own.evaluate(trySocket, { url: `ws://127.0.0.1:${vite.port}/__pyric/sandbox`, path: 'scratch/vite-own' });
      assert.equal(attempt.attached, true, JSON.stringify(attempt));
      await own.close();
    });
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});
