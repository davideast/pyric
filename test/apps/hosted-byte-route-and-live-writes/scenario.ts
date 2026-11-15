// End-to-end verification against packed CLI and live-host binaries:
// 1. Hosted sandbox with `--session-token --allowed-host` refuses unauthenticated
//    byte-route probes on the allowed host even with query tokens, and returns
//    uniform 403 on loopback for unauthenticated missing vs existing objects.
// 2. Live host (`pyric-live`) refuses Storage resumable upload session creation,
//    RTDB onDisconnect writes, and direct HTTP byte-route uploads with
//    PYRIC_LIVE_REFUSED, leaving RTDB unchanged after client disconnect.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { scenario, sleep, type AppProcess } from '../driver.ts';
import { get } from '../peer-client.ts';

interface ServePointer {
  url: string;
  token: string;
  instanceId: string;
}

interface SeedReport {
  bucket: string;
  path: string;
}

interface LiveProbeReport {
  resumableCode: string;
  resumableUploadBypassed: boolean;
  disconnectSetCode: string;
  disconnectUpdateCode: string;
  disconnectRemoveCode: string;
}

interface RtdbCheckReport {
  dcSetExists: boolean;
  dcUpdateExists: boolean;
}

function lastJson<T>(output: string, script: string): T {
  const line = output.trim().split('\n').findLast((text) => text.startsWith('{'));
  assert.ok(line, `${script} printed no JSON report:\n${output}`);
  return JSON.parse(line) as T;
}

async function waitForServePointer(dir: string, expectedPort: number, child: AppProcess): Promise<ServePointer> {
  const pointerPath = join(dir, '.pyric', 'serve.json');
  const deadline = Date.now() + 30_000;
  for (;;) {
    assert.ok(child.running, `${child.name} exited before writing serve.json:\n${child.output}`);
    if (existsSync(pointerPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pointerPath, 'utf8')) as Partial<ServePointer>;
        if (
          typeof parsed.url === 'string'
          && Number(new URL(parsed.url).port) === expectedPort
          && typeof parsed.token === 'string'
          && typeof parsed.instanceId === 'string'
        ) {
          return { url: parsed.url, token: parsed.token, instanceId: parsed.instanceId };
        }
      } catch {
        // Retry until serve.json finishes writing.
      }
    }
    assert.ok(Date.now() < deadline, `timed out waiting for serve.json on port ${expectedPort}:\n${child.output}`);
    await sleep(150);
  }
}

function rawMethod(opts: {
  port: number;
  method: string;
  path: string;
  host: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: { host: opts.host },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export default scenario(async (app) => {
  const sandboxPort = await app.freePort();
  let sandboxProc: AppProcess | undefined;

  const sandboxPointer = await app.step('start hosted sandbox with --session-token and --allowed-host', async () => {
    sandboxProc = app.pyricProcess([
      'sandbox',
      '--hosted',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(sandboxPort),
      '--session-token',
      '--allowed-host',
      'app.example.test',
    ]);
    return waitForServePointer(app.dir, sandboxPort, sandboxProc);
  });

  const seeded = await app.step('seed a private storage object with a download token', async () => {
    const res = await app.serverScript('seed-object.mjs', [], {
      env: { PYRIC_SANDBOX: `remote:${sandboxPointer.url}` },
    });
    return lastJson<SeedReport>(res.output, 'seed-object.mjs');
  });

  const bucketEnc = encodeURIComponent(seeded.bucket);
  const existingPath = `/__pyric/storage/v0/b/${bucketEnc}/o/${encodeURIComponent(seeded.path)}`;
  const missingPath = `/__pyric/storage/v0/b/${bucketEnc}/o/${encodeURIComponent('items/missing.txt')}`;

  await app.step('unauthenticated --allowed-host requests are refused by the host guard even with query tokens', async () => {
    const allowedHost = `app.example.test:${sandboxPort}`;
    const probes = [
      `${existingPath}?alt=media`,
      `${existingPath}?alt=media&token=`,
      `${existingPath}?alt=media&token=wrong`,
      `${existingPath}?alt=media&token=tok-valid-1`,
      `${missingPath}?alt=media&token=wrong`,
      `/__pyric/storage/v0/b/${bucketEnc}/o?name=items%2Frecord-1.txt&upload_id=u1&upload_token=wrong`,
    ];
    for (const path of probes) {
      const answer = await get({ address: '127.0.0.1', port: sandboxPort, path, host: allowedHost });
      assert.equal(answer.status, 403, `allowed-host ${path} returned ${answer.status}: ${answer.body}`);
      assert.match(answer.body, /Forbidden: invalid host or origin/, `allowed-host ${path} body: ${answer.body}`);
    }

    const authedExisting = await get({
      address: '127.0.0.1',
      port: sandboxPort,
      path: `${existingPath}?alt=media`,
      host: allowedHost,
      headers: { 'x-pyric-session-token': sandboxPointer.token },
    });
    assert.equal(authedExisting.status, 200, authedExisting.body);
    assert.equal(authedExisting.body, 'record-data');

    const authedMissing = await get({
      address: '127.0.0.1',
      port: sandboxPort,
      path: `${missingPath}?alt=media`,
      host: allowedHost,
      headers: { 'x-pyric-session-token': sandboxPointer.token },
    });
    assert.equal(authedMissing.status, 404, authedMissing.body);
  });

  await app.step('unauthenticated loopback requests receive uniform 403 for missing and existing objects', async () => {
    const loopbackHost = `127.0.0.1:${sandboxPort}`;
    const forgedExisting = await get({
      address: '127.0.0.1',
      port: sandboxPort,
      path: `${existingPath}?alt=media&token=wrong`,
      host: loopbackHost,
    });
    const forgedMissing = await get({
      address: '127.0.0.1',
      port: sandboxPort,
      path: `${missingPath}?alt=media&token=wrong`,
      host: loopbackHost,
    });
    assert.equal(forgedExisting.status, 403, forgedExisting.body);
    assert.equal(forgedMissing.status, 403, forgedMissing.body);
    assert.equal(forgedMissing.body, forgedExisting.body);

    const validDownload = await get({
      address: '127.0.0.1',
      port: sandboxPort,
      path: `${existingPath}?alt=media&token=tok-valid-1`,
      host: loopbackHost,
    });
    assert.equal(validDownload.status, 200, validDownload.body);
    assert.equal(validDownload.body, 'record-data');

    const sdkMissing = await get({
      address: '127.0.0.1',
      port: sandboxPort,
      path: `${missingPath}?alt=media`,
      host: loopbackHost,
      headers: { 'x-pyric-session-token': sandboxPointer.token },
    });
    assert.equal(sdkMissing.status, 404, sdkMissing.body);
  });

  await app.step('stop hosted sandbox before starting live host', async () => {
    await sandboxProc?.stop();
  });

  const livePort = await app.freePort();
  let liveProc: AppProcess | undefined;

  const livePointer = await app.step('start pyric-live read-only host', async () => {
    liveProc = app.commandProcess('node', [
      'node_modules/.bin/pyric-live',
      '--port',
      String(livePort),
      '--host',
      '127.0.0.1',
      '--no-open',
    ]);
    return waitForServePointer(app.dir, livePort, liveProc);
  });

  await app.step('pyric-live refuses resumable upload sessions and RTDB onDisconnect writes', async () => {
    const probe = await app.serverScript('probe-live.mjs', [], {
      env: { PYRIC_SANDBOX: `remote:${livePointer.url}` },
    });
    const report = lastJson<LiveProbeReport>(probe.output, 'probe-live.mjs');
    assert.equal(report.resumableUploadBypassed, false, JSON.stringify(report));
    assert.equal(report.resumableCode, 'PYRIC_LIVE_REFUSED', JSON.stringify(report));
    assert.equal(report.disconnectSetCode, 'PYRIC_LIVE_REFUSED', JSON.stringify(report));
    assert.equal(report.disconnectUpdateCode, 'PYRIC_LIVE_REFUSED', JSON.stringify(report));
    assert.equal(report.disconnectRemoveCode, 'PYRIC_LIVE_REFUSED', JSON.stringify(report));

    await sleep(250);
    const rtdb = await app.serverScript('check-live-rtdb.mjs', [], {
      env: { PYRIC_SANDBOX: `remote:${livePointer.url}` },
    });
    const check = lastJson<RtdbCheckReport>(rtdb.output, 'check-live-rtdb.mjs');
    assert.equal(check.dcSetExists, false, JSON.stringify(check));
    assert.equal(check.dcUpdateExists, false, JSON.stringify(check));
  });

  await app.step('pyric-live refuses direct HTTP byte-route uploads while health stays reachable', async () => {
    const uploadPath = '/__pyric/storage/v0/b/demo-guards.appspot.com/o?name=items%2Fdirect.txt&upload_id=u1&upload_token=t1';
    const liveHost = `127.0.0.1:${livePort}`;
    for (const method of ['PUT', 'POST']) {
      const answer = await rawMethod({
        port: livePort,
        method,
        path: uploadPath,
        host: liveHost,
        body: 'direct-payload',
      });
      assert.equal(answer.status, 403, `${method} answered ${answer.status}: ${answer.body}`);
      assert.match(answer.body, /PYRIC_LIVE_REFUSED/, `${method} body: ${answer.body}`);
    }

    const health = await get({
      address: '127.0.0.1',
      port: livePort,
      path: '/__pyric/health',
      host: liveHost,
      headers: { 'x-pyric-session-token': livePointer.token },
    });
    assert.equal(health.status, 200, health.body);
  });

  await app.step('stop pyric-live host', async () => {
    await liveProc?.stop();
  });
});
