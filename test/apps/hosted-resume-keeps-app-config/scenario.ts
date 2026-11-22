// #1222: when a client's first WebSocket drops right after `attach-ack` --
// before the Node host reads the client's `appConfig` -- the client resumes
// on the same `hostInstanceId` and `resumeToken`. That resumed session must
// still deliver `appConfig` so the host learns the app's `projectId` /
// `databaseURL` and maps `https://<projectId>.firebaseio.com` to the default
// RTDB rules instead of refusing it as an unconfigured instance.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { scenario, sleep, type AppProcess } from '../driver.ts';
import { get } from '../peer-client.ts';

async function waitForHostReady(
  port: number,
  appDir: string,
  child: AppProcess,
): Promise<void> {
  const pointerPath = join(appDir, '.pyric', 'serve.json');
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert.ok(
      child.running,
      `pyric sandbox exited before finishing startup:\n${child.output}`,
    );
    const hasBanner =
      existsSync(pointerPath) && child.output.includes('PYRIC_SANDBOX=remote');
    if (hasBanner) {
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
    }
    assert.ok(
      Date.now() < deadline,
      `pyric sandbox did not finish starting within 60s:\n${child.output}`,
    );
    await sleep(200);
  }
}

function rewriteHttpHeaderPort(chunk: Buffer, proxyPort: number, hostPort: number): {
  bytes: Buffer;
  isWsUpgrade: boolean;
} {
  const headEnd = chunk.indexOf('\r\n\r\n');
  if (headEnd < 0) return { bytes: chunk, isWsUpgrade: false };
  const rawHead = chunk.subarray(0, headEnd).toString('latin1');
  const isWsUpgrade = /upgrade:\s*websocket/i.test(rawHead);
  const lines = rawHead.split('\r\n').filter(line => {
    if (!isWsUpgrade) return true;
    return !line.toLowerCase().startsWith('sec-websocket-extensions:');
  });
  const rewritten = lines
    .join('\r\n')
    .replaceAll(`:${proxyPort}`, `:${hostPort}`);
  const tail = chunk.subarray(headEnd);
  return {
    bytes: Buffer.concat([Buffer.from(rewritten, 'latin1'), tail]),
    isWsUpgrade,
  };
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
    await waitForHostReady(hostPort, app.dir, child);
  });

  let wsUpgrades = 0;
  let droppedFirstBeforeAppConfig = false;

  const proxy = createServer((clientSocket) => {
    const upstream = connect({ host: '127.0.0.1', port: hostPort });
    clientSocket.setNoDelay(true);
    upstream.setNoDelay(true);

    let inspectedFirstChunk = false;
    let isFirstWs = false;
    let sawAttachAckOnFirstWs = false;
    let upstreamText = '';

    clientSocket.on('data', (chunk: Buffer) => {
      if (!inspectedFirstChunk) {
        inspectedFirstChunk = true;
        const rewritten = rewriteHttpHeaderPort(chunk, proxyPort, hostPort);
        if (rewritten.isWsUpgrade) {
          wsUpgrades += 1;
          if (wsUpgrades === 1) {
            isFirstWs = true;
          }
        }
        upstream.write(rewritten.bytes);
        return;
      }
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
        { env: { PYRIC_SANDBOX: 'remote' }, timeoutMs: 30_000 },
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
