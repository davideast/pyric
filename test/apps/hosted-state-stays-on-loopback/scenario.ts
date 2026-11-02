// The hosted sandbox keeps project state on this machine. `pyric sandbox
// --hosted --host 0.0.0.0` listens on every interface. A client that reaches
// it from a non-loopback address gets the static site: the page init payload
// holds no users, seed, project directory or token, and the state, MCP,
// service command and socket routes refuse it, whatever Host it names. A client
// on loopback keeps all of that, and even with the token the workspace routes
// refuse `.pyric/`, env files and `node_modules`, also through a symlink inside
// the project. The app's own Vite dev server, with the pyric plugin, refuses a
// symlink into `.pyric/`, one to `.env`, those same paths under a `base`, and a
// path that does not decode.
//
// The non-loopback client needs an address on this machine other than
// 127.0.0.0/8. CI runners and workstations have one. In an offline network
// namespace, add one first: `ip addr add 10.203.0.1/32 dev lo`.
import assert from 'node:assert/strict';
import { realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
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

/** Whether the server completes a WebSocket upgrade on `path`, read from the raw response line. */
function upgrades(input: { address: string; port: number; path: string; host: string; localAddress?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: input.address, port: input.port, localAddress: input.localAddress });
    const finish = (opened: boolean) => {
      socket.destroy();
      resolve(opened);
    };
    socket.setTimeout(5_000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.once('data', (chunk) => finish(chunk.toString('latin1').startsWith('HTTP/1.1 101')));
    socket.write([
      `GET ${input.path} HTTP/1.1`,
      `Host: ${input.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'));
  });
}

/** POST `body` from `localAddress`, naming `host`. */
function post(input: { address: string; port: number; path: string; host: string; localAddress?: string; body: string; headers?: Record<string, string> }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({
      method: 'POST',
      host: input.address,
      port: input.port,
      path: input.path,
      localAddress: input.localAddress,
      headers: { host: input.host, 'content-type': 'application/json', ...(input.headers ?? {}) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(input.body);
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
    writeFileSync(join(app.dir, 'seed.json'), JSON.stringify({ 'private/doc': { secret: 'seeded-value' } }));
  });

  let sandbox: AppProcess | undefined;
  await app.step('pyric sandbox --hosted listens on every interface', async () => {
    const child = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--host', '0.0.0.0', '--allowed-host', remote, '--seed', 'seed.json', '--port', String(port)]);
    sandbox = child;
    await waitForInit(port, () => child.running);
  });

  await app.step('a client on another address that names a loopback Host gets no session token', async () => {
    const answer = await get({ address: remote, port, path: '/__pyric/init.json', host, localAddress: remote });
    assert.equal(answer.status, 200, answer.body);
    const init = JSON.parse(answer.body) as Record<string, unknown>;
    assert.equal(init.sessionToken, undefined, `a client at ${remote} received the session token`);
    for (const field of ['activityToken', 'authUsers', 'seedState', 'projectKey']) {
      assert.equal(init[field], undefined, `a client at ${remote} received ${field}`);
    }
    assert.equal(init.seed, null);
    assert.ok(!answer.body.includes('seeded-value'), answer.body);
  });

  await app.step('a client on another address gets the static site and is refused everywhere else', async () => {
    const page = await get({ address: remote, port, path: '/', host, localAddress: remote });
    assert.equal(page.status, 200, page.body);
    for (const named of [host, `${remote}:${port}`]) {
      const from = { address: remote, port, host: named, localAddress: remote };
      for (const path of ['/__pyric/state', '/__pyric/workspace/list', '/__pyric/health', '/__pyric/diagnostics']) {
        const answer = await get({ ...from, path });
        assert.equal(answer.status, 403, `${path} answered ${answer.status}: ${answer.body.slice(0, 200)}`);
      }
      const mcp = await post({ ...from, path: '/__pyric/mcp', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
      assert.equal(mcp.status, 403, `MCP answered ${mcp.status}: ${mcp.body.slice(0, 200)}`);
      const method = await post({ ...from, path: '/__pyric/hosted/method', body: '{}' });
      assert.equal(method.status, 403, `the service command route answered ${method.status}`);
      assert.equal(await upgrades({ ...from, path: '/__pyric/sandbox' }), false, 'the bridge socket opened');
    }
  });

  await app.step('a page opened from another address loads, and its Firestore call says why it has no data', async () => {
    // The driver's browser resolves only loopback names, so this one adds this machine's other address.
    const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ${remote}`] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://${remote}:${port}/remote-page.html`);
      await page.waitForFunction(() => 'outcome' in window, undefined, { timeout: 30_000 });
      const outcome = await page.evaluate(() => (window as unknown as { outcome: string }).outcome);
      assert.match(outcome, /^refused: .*own machine/, outcome);
    } finally {
      await browser.close();
    }
  });

  const token = await app.step('a client on loopback still gets the session token', async () => {
    const answer = await get({ address: '127.0.0.1', port, path: '/__pyric/init.json', host });
    const init = JSON.parse(answer.body) as { sessionToken?: unknown };
    assert.equal(typeof init.sessionToken, 'string', answer.body);
    return init.sessionToken as string;
  });

  await app.step('a client on another address is refused even holding the token', async () => {
    const answer = await get({
      address: remote, port, path: '/__pyric/workspace?path=firestore.rules', host, localAddress: remote,
      headers: { 'x-pyric-session-token': token },
    });
    assert.equal(answer.status, 403, answer.body.slice(0, 200));
  });

  await app.step('a client on loopback keeps the socket and MCP', async () => {
    assert.equal(await upgrades({ address: '127.0.0.1', port, path: '/__pyric/sandbox', host }), true);
    const mcp = await post({
      address: '127.0.0.1', port, path: '/__pyric/mcp', host,
      headers: { accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'scenario', version: '1' } } }),
    });
    assert.equal(mcp.status, 200, mcp.body.slice(0, 200));
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
    const bad = await get({ address: '127.0.0.1', port: vite.port, path: '/nope%ZZ/../env-link', host: `localhost:${vite.port}` });
    assert.equal(bad.status, 403, bad.body.slice(0, 200));
    assert.ok(!bad.body.includes('API_KEY'), 'a path that does not decode returned the env file');
    assert.equal((await fetch(`${vite.url}/`)).status, 200);
    await vite.process.stop();
  });

  await app.step('the same links stay refused under a configured base', async () => {
    const config = app.readFile('vite.config.js');
    app.writeFile('vite.config.js', config.replace('export default {', 'export default {\n  base: "/app/",'));
    const vite = await app.devServer();
    const fsLink = `/app/@fs${join(realpathSync(app.dir), 'env-link')}?raw`;
    for (const path of ['/app/env-link', '/app/env-link?raw', '/app/state-link/hosted/state.sqlite', fsLink]) {
      const answer = await get({ address: '127.0.0.1', port: vite.port, path, host: `localhost:${vite.port}` });
      assert.equal(answer.status, 403, `${path} answered ${answer.status}: ${answer.body.slice(0, 200)}`);
      assert.ok(!answer.body.includes('API_KEY'), `${path} returned the env file`);
    }
  });
});
