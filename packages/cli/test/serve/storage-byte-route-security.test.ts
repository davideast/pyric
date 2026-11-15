/**
 * Storage byte-route host-guard and existence-oracle security invariants:
 *   1. Query parameters (`?token=`, `?upload_token=`) never widen `--allowed-host`
 *      for unauthenticated requests; the host guard refuses them with `403` before
 *      reaching the Storage byte-route handler.
 *   2. On loopback without SDK authorization, missing objects and wrong download
 *      tokens return the same `403` refusal so callers cannot probe existence;
 *      valid download tokens still return `200`, and SDK-authorized requests
 *      still receive `404` for missing objects.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { createStorageByteRoute } from '../../src/serve/hosted/storage-byte-route.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

function rawHttpRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const runtimes: ServeRuntime[] = [];
const staticHandles: ServeHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (runtime !== undefined) await runtime.handle.stop();
  }
  while (staticHandles.length > 0) {
    const handle = staticHandles.pop();
    if (handle !== undefined) await handle.stop();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-byte-route-sec-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ storage: { rules: 'storage.rules' } }));
  writeFileSync(
    join(dir, 'storage.rules'),
    [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{allPaths=**} { allow read, write: if false; }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('storage byte-route host guard and existence-oracle security', () => {
  it('refuses unauthenticated --allowed-host byte-route requests even with query tokens', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['app.example.test'],
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      sessionToken: true,
      ui: false,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const port = runtime.handle.port;
    const token = runtime.sessionToken;

    const probes = [
      '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media',
      '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media&token=',
      '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media&token=wrong',
      '/__pyric/storage/v0/b/bucket-a/o/items%2Fmissing?alt=media&token=wrong',
      '/__pyric/storage/v0/b/bucket-a/o?name=items%2Fitem-1&upload_id=u1&upload_token=wrong',
    ];

    for (const path of probes) {
      const res = await rawHttpRequest({
        port,
        path,
        headers: { host: `app.example.test:${port}` },
      });
      expect(res.status, `unauthenticated allowed-host ${path}`).toBe(403);
      expect(res.body, `host-guard body for ${path}`).toContain('Forbidden: invalid host or origin');
    }

    // Authenticated callers with the session token can still reach the byte route on --allowed-host.
    const authed = await rawHttpRequest({
      port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fmissing?alt=media',
      headers: {
        host: `app.example.test:${port}`,
        'x-pyric-session-token': token,
      },
    });
    expect(authed.status).toBe(404);
  }, 30_000);

  it('returns uniform 403 for missing objects and invalid tokens when unauthenticated on loopback', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-byte-route-obj-'));
    dirs.push(fixtureDir);
    const objectPath = join(fixtureDir, 'item-1.txt');
    const objectBytes = 'stored-payload';
    writeFileSync(objectPath, objectBytes);

    let probedObjectFile = false;
    const byteRoute = createStorageByteRoute({
      storage: {
        async objectFile(bucket, path) {
          probedObjectFile = true;
          if (bucket === 'bucket-a' && path === 'items/item-1.txt') {
            return {
              file: objectPath,
              size: Buffer.byteLength(objectBytes),
              mime: 'text/plain',
              metadata: {
                fullPath: path,
                name: 'item-1.txt',
                bucket,
                generation: '1',
                metageneration: '1',
                contentType: 'text/plain',
                size: Buffer.byteLength(objectBytes),
                timeCreated: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                downloadTokens: 'valid-tok-1',
              },
            };
          }
          return undefined;
        },
        async appendUpload() {
          throw new Error('unexpected appendUpload');
        },
        async uploadProgress() {
          return undefined;
        },
      },
      sessionToken: 'session-secret',
      uploadToken: () => undefined,
    });

    const server = await startStaticServer({
      publicDir: null,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: (req, res, url) => byteRoute(req, res, url),
      logger: silentServeLogger(),
    });
    staticHandles.push(server);

    const noToken = await rawHttpRequest({
      port: server.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1.txt?alt=media',
      headers: { host: `127.0.0.1:${server.port}` },
    });
    expect(noToken.status).toBe(403);
    expect(probedObjectFile).toBe(false);

    const emptyToken = await rawHttpRequest({
      port: server.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1.txt?alt=media&token=',
      headers: { host: `127.0.0.1:${server.port}` },
    });
    expect(emptyToken.status).toBe(403);
    expect(probedObjectFile).toBe(false);

    const forgedExisting = await rawHttpRequest({
      port: server.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1.txt?alt=media&token=wrong',
      headers: { host: `127.0.0.1:${server.port}` },
    });
    const forgedMissing = await rawHttpRequest({
      port: server.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fmissing.txt?alt=media&token=wrong',
      headers: { host: `127.0.0.1:${server.port}` },
    });
    expect(forgedExisting.status).toBe(403);
    expect(forgedMissing.status).toBe(403);
    expect(forgedMissing.body).toBe(forgedExisting.body);
    expect(forgedMissing.body).not.toContain('No such object.');

    const validDownload = await rawHttpRequest({
      port: server.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1.txt?alt=media&token=valid-tok-1',
      headers: { host: `127.0.0.1:${server.port}` },
    });
    expect(validDownload.status).toBe(200);
    expect(validDownload.body).toBe(objectBytes);

    const sdkAuthedMissing = await rawHttpRequest({
      port: server.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fmissing.txt?alt=media',
      headers: {
        host: `127.0.0.1:${server.port}`,
        'x-pyric-session-token': 'session-secret',
      },
    });
    expect(sdkAuthedMissing.status).toBe(404);
  });
});
