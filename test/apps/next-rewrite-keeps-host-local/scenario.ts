// A dev server in front of the sandbox host does not make its clients local.
// `withPyric` rewrites `/__pyric/*` to the host, so the host sees Next's own
// loopback connection for every request. Under `pyric sandbox -- next dev
// --hostname 0.0.0.0`, on the Node host and on the in-page sandbox, a client on
// a non-loopback address gets the answers it would get from the host directly,
// and sending headers of its own does not change them. A client on loopback,
// and a page Next serves it, keep working through the same rewrite. A plain
// proxy started under `pyric sandbox -- node`, and a Vite `server.proxy`, behave
// the same way.
//
// The non-loopback client needs an address on this machine other than
// 127.0.0.0/8. In an offline network namespace, add one first:
// `ip addr add 10.203.0.1/32 dev lo`.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { scenario, sleep, type App, type AppProcess } from '../driver.ts';
import { get, nonLoopbackAddress, post, statusOf, upgrades } from '../peer-client.ts';

const RULES_MARKER = 'marker-in-the-rules-text';
const CLIENT_HEADER_SETS: Record<string, string>[] = [
  {},
  { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' },
  { 'x-pyric-remote-peer': '0' },
];
const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'scenario', version: '1' } },
});

async function waitForAnswer(port: number, running: () => boolean): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    assert.ok(running(), 'pyric sandbox exited before the server in front of it answered');
    try {
      const answer = await get({ address: '127.0.0.1', port, path: '/__pyric/init.json', host: `localhost:${port}` });
      if (answer.status === 200) return;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, `port ${port} did not answer /__pyric/init.json within 180s`);
    await sleep(500);
  }
}

/** Every way a client on another machine is still taken for a local one, through the server on `port`. */
async function localAnswersToRemote(remote: string, port: number, hosted: boolean): Promise<string[]> {
  const host = `localhost:${port}`;
  const found: string[] = [];
  for (const headers of CLIENT_HEADER_SETS) {
    const from = { address: remote, port, host, localAddress: remote, headers };
    const label = `with ${JSON.stringify(headers)}`;
    const note = (what: string, ok: boolean) => { if (!ok) found.push(`${label}: ${what}`); };

    const init = await get({ ...from, path: '/__pyric/init.json' });
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    note('init.json did not mark a remote peer', payload.remotePeer === true);
    note('init.json carried the session token', payload.sessionToken === undefined);
    note('init.json carried the rules text', !init.body.includes(RULES_MARKER));

    const refusedReads = ['/__pyric/health', '/__pyric/diagnostics', '/__pyric/workspace/list', '/__pyric/events'];
    if (hosted) refusedReads.push('/__pyric/state');
    for (const path of refusedReads) {
      const status = await statusOf({ ...from, path });
      note(`${path} answered ${status}`, status === 403);
    }
    const mcp = await post({ ...from, path: '/__pyric/mcp', body: MCP_INITIALIZE, headers: { ...headers, accept: 'application/json, text/event-stream' } });
    note(`MCP initialize answered ${mcp.status}`, mcp.status === 403);
    const denials = await post({ ...from, path: '/__pyric/denials', body: '{}' });
    note(`the denial relay answered ${denials.status}`, denials.status === 403);
    if (hosted) {
      const method = await post({ ...from, path: '/__pyric/hosted/method', body: '{}' });
      note(`the service command route answered ${method.status}`, method.status === 403);
    }
    note('the bridge socket opened', !(await upgrades({ address: remote, port, host, localAddress: remote, path: '/__pyric/sandbox', headers })));
  }
  return found;
}

/** What a client on this machine keeps through the same server. */
async function assertOpenFromLoopback(port: number): Promise<void> {
  const host = `localhost:${port}`;
  const from = { address: '127.0.0.1', port, host };
  const init = await get({ ...from, path: '/__pyric/init.json' });
  const payload = JSON.parse(init.body) as Record<string, unknown>;
  assert.equal(typeof payload.sessionToken, 'string', init.body.slice(0, 300));
  assert.ok(init.body.includes(RULES_MARKER), 'a local client lost the rules text');
  assert.equal(payload.remotePeer, undefined);
  assert.equal((await get({ ...from, path: '/__pyric/health' })).status, 200);
  const mcp = await post({ ...from, path: '/__pyric/mcp', body: MCP_INITIALIZE, headers: { accept: 'application/json, text/event-stream' } });
  assert.equal(mcp.status, 200, mcp.body.slice(0, 200));
  assert.equal(await upgrades({ ...from, path: '/__pyric/sandbox' }), true, 'a local client lost the bridge socket');
}

async function runNextCase(app: App, remote: string, name: string, hosted: boolean, found: string[]): Promise<void> {
  const sandboxPort = await app.freePort();
  const nextPort = await app.freePort();
  const sandboxArgs = ['sandbox', '--no-open', '--port', String(sandboxPort)];
  if (hosted) sandboxArgs.push('--hosted');
  const nextArgs = ['next', 'dev', '--port', String(nextPort), '--hostname', '0.0.0.0'];
  const env = { PATH: `${join(app.dir, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`, NEXT_TELEMETRY_DISABLED: '1' };

  let sandbox: AppProcess | undefined;
  await app.step(`${name}: Next listens on every interface`, async () => {
    const child = app.pyricProcess([...sandboxArgs, '--', ...nextArgs], { env });
    sandbox = child;
    await waitForAnswer(nextPort, () => child.running);
  });
  await app.step(`${name}: ask through the rewrite from another address`, async () => {
    for (const line of await localAnswersToRemote(remote, nextPort, hosted)) found.push(`${name}: ${line}`);
  });
  await app.step(`${name}: a client on loopback keeps the routes through the rewrite`, () =>
    assertOpenFromLoopback(nextPort));
  await app.step(`${name}: a page Next serves still reaches the sandbox`, async () => {
    const page = await app.page(`http://127.0.0.1:${nextPort}/`);
    await page.waitForFunction(() => document.querySelector('#items-status')?.textContent === 'Listening', undefined, { timeout: 90_000 });
    await page.close();
  });
  await app.step(`${name}: pyric sandbox stops`, async () => {
    await sandbox?.stop();
  });
}

/** A server other than Next, under `pyric sandbox`, that forwards `/__pyric/*` to the host. */
async function runProxyCase(app: App, remote: string, name: string, command: (port: number) => string[], found: string[]): Promise<void> {
  const sandboxPort = await app.freePort();
  const proxyPort = await app.freePort();
  const env = { PATH: `${join(app.dir, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` };
  let sandbox: AppProcess | undefined;
  await app.step(`${name}: listens on every interface`, async () => {
    const child = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--port', String(sandboxPort), '--', ...command(proxyPort)], { env });
    sandbox = child;
    await waitForAnswer(proxyPort, () => child.running);
  });
  await app.step(`${name}: ask from another address`, async () => {
    for (const line of await localAnswersToRemote(remote, proxyPort, true)) found.push(`${name}: ${line}`);
  });
  await app.step(`${name}: a client on loopback keeps the routes`, () =>
    assertOpenFromLoopback(proxyPort));
  await app.step(`${name}: stops`, async () => {
    await sandbox?.stop();
  });
}

export default scenario(async (app) => {
  const remote = nonLoopbackAddress();
  assert.ok(remote !== null, 'this machine has no IPv4 address outside 127.0.0.0/8; add one, for example `ip addr add 10.203.0.1/32 dev lo`');
  const found: string[] = [];
  await runNextCase(app, remote, 'pyric sandbox --hosted -- next dev', true, found);
  await runNextCase(app, remote, 'pyric sandbox -- next dev', false, found);
  await runProxyCase(app, remote, 'a plain proxy', (port) => ['node', 'forwarding-proxy.mjs', String(port)], found);
  await runProxyCase(app, remote, 'a Vite server.proxy', (port) => ['vite', '--port', String(port), '--strictPort', '--host', '0.0.0.0'], found);
  await app.step('a client on another address got the answers it gets from the host directly', () => {
    assert.deepEqual(found, []);
  });
});
