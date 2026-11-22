// #1222: when a client's first WebSocket drops right after `attach-ack` --
// before the Node host reads the client's `appConfig` -- the client resumes
// on the same `hostInstanceId` and `resumeToken`. That resumed session must
// still deliver `appConfig` so the host learns the app's `projectId` /
// `databaseURL` and maps `https://<projectId>.firebaseio.com` to the default
// RTDB rules instead of refusing it as an unconfigured instance.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { scenario, sleep, type AppProcess } from '../driver.ts';
import { get } from '../peer-client.ts';

async function waitForHostReady(port: number, running: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert.ok(running(), 'pyric sandbox exited before serving /__pyric/init.json');
    try {
      const res = await get({
        address: '127.0.0.1',
        port,
        path: '/__pyric/init.json',
        host: `127.0.0.1:${port}`,
      });
      if (res.status === 200) return;
    } catch {
      // Host not listening yet.
    }
    assert.ok(Date.now() < deadline, 'pyric sandbox did not serve /__pyric/init.json within 60s');
    await sleep(200);
  }
}

export default scenario(async (app) => {
  const hostPort = await app.freePort();
  const proxyPort = await app.freePort();
  let sandbox: AppProcess | undefined;

  await app.step('start pyric sandbox --hosted with no .firebaserc projectId', async () => {
    const child = app.pyricProcess([
      'sandbox',
      '--hosted',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(hostPort),
    ]);
    sandbox = child;
    await waitForHostReady(hostPort, () => child.running);
  });

  let wsUpgrades = 0;
  let droppedFirstBeforeAppConfig = false;

  const proxy = createHttpServer(async (req, res) => {
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') {
          headers[k] = v.replaceAll(`:${proxyPort}`, `:${hostPort}`);
        }
      }
      headers.host = `127.0.0.1:${hostPort}`;
      const upstreamRes = await fetch(`http://127.0.0.1:${hostPort}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
      });
      const text = (await upstreamRes.text()).replaceAll(`:${hostPort}`, `:${proxyPort}`);
      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
      });
      res.end(text);
    } catch (err) {
      res.writeHead(502);
      res.end(String(err));
    }
  });

  proxy.on('upgrade', (req, clientSocket, head) => {
    wsUpgrades += 1;
    const isFirstWs = wsUpgrades === 1;
    const upstream = connect({ host: '127.0.0.1', port: hostPort });
    clientSocket.setNoDelay(true);
    upstream.setNoDelay(true);

    let sawAttachAckOnFirstWs = false;
    let upstreamText = '';

    upstream.once('connect', () => {
      const headerLines = [`GET ${req.url ?? '/__pyric/sandbox'} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? '';
        const value = (req.rawHeaders[i + 1] ?? '').replaceAll(`:${proxyPort}`, `:${hostPort}`);
        headerLines.push(`${name}: ${value}`);
      }
      headerLines.push('', '');
      upstream.write(headerLines.join('\r\n'));
      if (head.length > 0) upstream.write(head);
    });

    clientSocket.on('data', (chunk: Buffer) => {
      if (isFirstWs && sawAttachAckOnFirstWs) {
        // Drop WebSocket #1 before forwarding its post-attach-ack frames
        // (`appConfig` + initial RTDB op) to the Node host.
        droppedFirstBeforeAppConfig = true;
        clientSocket.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(chunk);
    });

    upstream.on('data', (chunk: Buffer) => {
      clientSocket.write(chunk);
      if (isFirstWs && !sawAttachAckOnFirstWs) {
        upstreamText += chunk.toString('latin1');
        if (upstreamText.includes('"attach-ack"')) {
          sawAttachAckOnFirstWs = true;
        }
      }
    });

    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(proxyPort, '127.0.0.1', () => resolve());
  });

  try {
    await app.step('route .pyric/serve.json through the early-drop proxy and run SDK client', async () => {
      const pointerPath = join(app.dir, '.pyric', 'serve.json');
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
      const patched: Record<string, unknown> = { ...pointer, port: proxyPort };
      for (const [key, val] of Object.entries(patched)) {
        if (typeof val === 'string') {
          patched[key] = val.replaceAll(`:${hostPort}`, `:${proxyPort}`);
        }
      }
      writeFileSync(pointerPath, JSON.stringify(patched, null, 2), { mode: 0o600 });

      const run = await app.command(
        'node',
        ['--import', '@pyric/cli/register', 'client.mjs'],
        { timeoutMs: 30_000 },
      );
      assert.equal(run.code, 0, run.output);
      assert.equal(droppedFirstBeforeAppConfig, true, 'proxy did not trigger early first-socket drop');
      assert.ok(wsUpgrades >= 2, `expected at least 2 WebSocket attaches, saw ${wsUpgrades}`);
      assert.match(run.output, /RESULT:"configured-after-resume"/, run.output);
    });
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await sandbox?.stop();
  }
});
