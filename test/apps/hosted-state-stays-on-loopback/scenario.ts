// The hosted sandbox keeps project state on this machine. `pyric sandbox
// --hosted --host 0.0.0.0` listens on every interface. A client that reaches
// it from a non-loopback address, naming a loopback Host, gets the page init
// payload without the session token, so it cannot open the routes that token
// unlocks. A client on loopback still gets the token, and with it the
// workspace routes refuse `.pyric/`, `.env*` files and `node_modules`, also
// through a symlink inside the project. The app's own Vite dev server, with
// the pyric plugin, refuses a symlink into `.pyric/` and one to `.env`.
//
// The non-loopback client needs an address on this machine other than
// 127.0.0.0/8. CI runners and workstations have one. In an offline network
// namespace, add one first: `ip addr add 10.203.0.1/32 dev lo`.
import assert from 'node:assert/strict';
import { symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { scenario, sleep, type AppProcess } from '../driver.ts';

interface Answer {
  status: number;
  body: string;
}

/** An IPv4 address of this machine outside 127.0.0.0/8, or null. */
function nonLoopbackAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      const isOtherIpv4 = entry.family === 'IPv4' && !entry.address.startsWith('127.');
      if (isOtherIpv4) return entry.address;
    }
  }
  return null;
}

/** GET `path` from `address`, sending `host` as the Host header and connecting from `localAddress`. */
function get(input: { address: string; port: number; path: string; host: string; localAddress?: string; headers?: Record<string, string> }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: input.address,
      port: input.port,
      path: input.path,
      localAddress: input.localAddress,
      headers: { host: input.host, ...(input.headers ?? {}) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForInit(port: number, running: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert.ok(running(), 'pyric sandbox exited before it served /__pyric/init.json');
    try {
      const answer = await get({ address: '127.0.0.1', port, path: '/__pyric/init.json', host: `localhost:${port}` });
      if (answer.status === 200) return;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, `pyric sandbox did not answer /__pyric/init.json within 60s`);
    await sleep(250);
  }
}

export default scenario(async (app) => {
  const remote = nonLoopbackAddress();
  assert.ok(remote !== null, 'this machine has no IPv4 address outside 127.0.0.0/8; add one, for example `ip addr add 10.203.0.1/32 dev lo`');
  const port = await app.freePort();
  const host = `localhost:${port}`;

  await app.step('the project holds an env file, dependencies and links into its state', () => {
    writeFileSync(join(app.dir, '.env'), 'API_KEY=not-for-the-network\n');
    symlinkSync(join(app.dir, '.pyric', 'state'), join(app.dir, 'state-link'));
    symlinkSync(join(app.dir, '.env'), join(app.dir, 'env-link'));
    writeFileSync(join(app.dir, '.envrc'), 'export API_KEY=not-for-the-network\n');
  });

  let sandbox: AppProcess | undefined;
  await app.step('pyric sandbox --hosted listens on every interface', async () => {
    const child = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--host', '0.0.0.0', '--port', String(port)]);
    sandbox = child;
    await waitForInit(port, () => child.running);
  });

  await app.step('a client on another address that names a loopback Host gets no session token', async () => {
    const answer = await get({ address: remote, port, path: '/__pyric/init.json', host, localAddress: remote });
    assert.equal(answer.status, 200, answer.body);
    const init = JSON.parse(answer.body) as { sessionToken?: unknown };
    assert.equal(init.sessionToken, undefined, `a client at ${remote} received the session token`);
  });

  const token = await app.step('a client on loopback still gets the session token', async () => {
    const answer = await get({ address: '127.0.0.1', port, path: '/__pyric/init.json', host });
    const init = JSON.parse(answer.body) as { sessionToken?: unknown };
    assert.equal(typeof init.sessionToken, 'string', answer.body);
    return init.sessionToken as string;
  });

  await app.step('the workspace routes refuse project state, env files and dependencies', async () => {
    const headers = { 'x-pyric-session-token': token };
    const read = (query: string) => get({ address: '127.0.0.1', port, path: `/__pyric/workspace${query}`, host, headers });
    const refused = [
      '?path=.pyric/state/hosted/state.sqlite',
      '?path=state-link/hosted/state.sqlite',
      '?path=.env',
      '?path=env-link',
      '?path=.envrc',
      '?path=node_modules/@pyric/cli/package.json',
      '/list?dir=.pyric/state',
      '/list?dir=state-link',
      '/list?dir=node_modules',
    ];
    for (const query of refused) {
      const answer = await read(query);
      assert.equal(answer.status, 403, `${query} answered ${answer.status}: ${answer.body.slice(0, 200)}`);
      assert.ok(!answer.body.includes('API_KEY'), `${query} returned the env file`);
    }
    const listing = await read('/list');
    assert.equal(listing.status, 200, listing.body);
    const paths = (JSON.parse(listing.body) as Array<{ path: string }>).map((entry) => entry.path);
    for (const hidden of ['.pyric', '.env', '.envrc', 'node_modules', 'state-link', 'env-link']) {
      assert.ok(!paths.includes(hidden), `the workspace listing shows ${hidden}: ${paths.join(', ')}`);
    }
    const rules = await read('?path=firestore.rules');
    assert.equal(rules.status, 200, rules.body);
    assert.match(rules.body, /cloud\.firestore/);
  });

  await app.step('pyric sandbox stops', async () => {
    await sandbox?.stop();
  });

  await app.step('the Vite dev server refuses links into project state and to the env file', async () => {
    const vite = await app.devServer();
    for (const path of ['/state-link/hosted/state.sqlite', '/state-link/hosted/state.sqlite?raw', '/env-link', '/env-link?raw']) {
      const response = await fetch(`${vite.url}${path}`);
      const body = await response.text();
      assert.equal(response.status, 403, `${path} answered ${response.status}: ${body.slice(0, 200)}`);
      assert.ok(!body.includes('API_KEY'), `${path} returned the env file`);
    }
    assert.equal((await fetch(`${vite.url}/`)).status, 200);
  });
});
