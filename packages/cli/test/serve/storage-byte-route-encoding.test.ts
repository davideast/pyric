/**
 * Malformed percent-encoding handling on the Storage HTTP byte route (#1959):
 *   1. `targetOf` treats invalid percent-escapes (`%E0%A4%A`, `%ZZ`, truncated `%`,
 *      lone surrogates) in bucket or object segments as non-matching paths and
 *      returns `undefined` instead of throwing `URIError`.
 *   2. Direct `allowsOrigin` checks return `false` without throwing on malformed
 *      escapes or non-byte-route pathnames.
 *   3. Both standalone `createStorageByteRoute` and full `startServe` (which runs
 *      `storageAllowsOrigin` in `bridge-mount.ts` before `storageHttp`) answer
 *      malformed escapes with `4xx` (`404` on allowed loopback with or without
 *      `x-pyric-session-token`, `403` on foreign origins), never `500`.
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

const MALFORMED_BYTE_ROUTE_PATHS = [
  '/__pyric/storage/v0/b/%E0%A4%A/o/x',
  '/__pyric/storage/v0/b/%ZZ/o/x',
  '/__pyric/storage/v0/b/trail%/o/x',
  '/__pyric/storage/v0/b/%E0%A4%A/o',
  '/__pyric/storage/v0/b/bucket-a/o/%E0%A4%A',
  '/__pyric/storage/v0/b/bucket-a/o/%ZZ',
  '/__pyric/storage/v0/b/bucket-a/o/foo%',
  '/__pyric/storage/v0/b/bucket-a/o/foo%2',
  '/__pyric/storage/v0/b/bucket-a/o/%ED%A0%80',
];

describe('storage byte-route malformed percent-encoding (#1959)', () => {
  it('answers 404 without throwing URIError on standalone route and keeps valid escapes working', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-byte-route-enc-'));
    dirs.push(fixtureDir);
    const storedFile = join(fixtureDir, 'caf-note.txt');
    const storedBody = 'hello-utf8';
    writeFileSync(storedFile, storedBody);

    let touchedBackend = false;
    const decodedObjectPath = 'items/hello world \u00e9.txt';
    const byteRoute = createStorageByteRoute({
      storage: {
        async objectFile(bucket, path) {
          touchedBackend = true;
          if (bucket === 'team-bucket' && path === decodedObjectPath) {
            return {
              file: storedFile,
              size: Buffer.byteLength(storedBody),
              mime: 'text/plain',
              metadata: {
                fullPath: path,
                name: 'hello world \u00e9.txt',
                bucket,
                generation: '1',
                metageneration: '1',
                contentType: 'text/plain',
                size: Buffer.byteLength(storedBody),
                timeCreated: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                downloadTokens: 'dl-tok-1',
              },
            };
          }
          return undefined;
        },
        async appendUpload() {
          touchedBackend = true;
          throw new Error('unexpected appendUpload');
        },
        async uploadProgress() {
          touchedBackend = true;
          return undefined;
        },
      },
      sessionToken: 'session-secret',
      uploadToken: () => 'up-tok',
      sessions: {
        get: () => ({ token: 'sess-tok', origin: 'https://app.example.test' }),
        async open() {
          touchedBackend = true;
          return 'u1';
        },
        async finish() {
          touchedBackend = true;
          return {};
        },
      },
    });

    for (const rawPath of [
      ...MALFORMED_BYTE_ROUTE_PATHS,
      '/not-a-byte-route/storage/v0/b/bucket-a/o',
    ]) {
      const candidateUrl = new URL(`http://127.0.0.1${rawPath}?upload_id=s1&upload_token=sess-tok`);
      expect(byteRoute.allowsOrigin(candidateUrl, 'https://app.example.test')).toBe(false);
    }

    const server = await startStaticServer({
      publicDir: null,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: (req, res, url) => byteRoute(req, res, url),
      logger: silentServeLogger(),
    });
    staticHandles.push(server);

    for (const path of MALFORMED_BYTE_ROUTE_PATHS) {
      const withoutToken = await rawHttpRequest({
        port: server.port,
        path: `${path}?alt=media`,
        headers: { host: `127.0.0.1:${server.port}` },
      });
      expect(withoutToken.status, `GET without token ${path}`).toBe(404);
      expect(withoutToken.body).toBe('Not a byte route path.');

      const withToken = await rawHttpRequest({
        port: server.port,
        path: `${path}?alt=media`,
        headers: {
          host: `127.0.0.1:${server.port}`,
          'x-pyric-session-token': 'session-secret',
        },
      });
      expect(withToken.status, `GET with token ${path}`).toBe(404);
      expect(withToken.body).toBe('Not a byte route path.');
    }

    const malformedPut = await rawHttpRequest({
      port: server.port,
      method: 'PUT',
      path: '/__pyric/storage/v0/b/%E0%A4%A/o?name=x&upload_id=s1&upload_token=sess-tok',
      headers: { host: `127.0.0.1:${server.port}`, 'content-length': '4' },
      body: 'abcd',
    });
    expect(malformedPut.status).toBe(404);
    expect(touchedBackend).toBe(false);

    const validEncoded = await rawHttpRequest({
      port: server.port,
      path: '/__pyric/storage/v0/b/team%2Dbucket/o/items%2Fhello%20world%20%C3%A9.txt?alt=media&token=dl-tok-1',
      headers: { host: `127.0.0.1:${server.port}` },
    });
    expect(validEncoded.status).toBe(200);
    expect(validEncoded.body).toBe(storedBody);
  });

  it('answers 404 (and 403 on foreign origins), never 500, through live startServe with or without session token', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-byte-route-serve-'));
    dirs.push(cwd);
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ storage: { rules: 'storage.rules' } }));
    writeFileSync(
      join(cwd, 'storage.rules'),
      [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /{allPaths=**} { allow read, write: if true; }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
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

    for (const path of MALFORMED_BYTE_ROUTE_PATHS) {
      const unauthed = await rawHttpRequest({
        port,
        path: `${path}?alt=media`,
        headers: { host: `127.0.0.1:${port}` },
      });
      expect(unauthed.status, `unauthed startServe ${path}`).toBe(404);

      const authedHeaders: Record<string, string> = { host: `127.0.0.1:${port}` };
      if (runtime.sessionToken !== undefined) {
        authedHeaders['x-pyric-session-token'] = runtime.sessionToken;
      }
      const authed = await rawHttpRequest({
        port,
        path: `${path}?alt=media`,
        headers: authedHeaders,
      });
      expect(authed.status, `authed startServe ${path}`).toBe(404);
    }

    const foreignOrigin = await rawHttpRequest({
      port,
      method: 'OPTIONS',
      path: '/__pyric/storage/v0/b/%E0%A4%A/o?upload_id=s1&upload_token=tok',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.example.test',
      },
    });
    expect(foreignOrigin.status).toBe(403);
  }, 30_000);
});
