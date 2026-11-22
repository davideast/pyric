/**
 * Regression tests for #1500: Studio data routes (`/__pyric/workspace*`,
 * `/__pyric/projects*`) and the hosted Storage byte route (`/__pyric/storage/*`)
 * accept requests originating from a learned Next.js dev-server port behind
 * `withPyric()` `/__pyric/:path*` rewrites while rejecting unlearned local
 * ports, foreign cross-origin requests, and forged cross-site `x-forwarded-host`
 * headers with 403.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppPorts } from '../../src/serve/app-ports.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { diskProjectStore, diskWorkspace } from '../../src/serve/studio/index.js';

const handles: ServeHandle[] = [];
const mounts: Array<{ close(): Promise<void> }> = [];
const proxyServers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (proxyServers.length > 0) {
    const s = proxyServers.pop();
    if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (mounts.length > 0) {
    const m = mounts.pop();
    if (m !== undefined) await m.close();
  }
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function rawHttp(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Minimal Next.js `/__pyric/:path*` rewrite proxy forwarding `x-forwarded-host`. */
async function startNextRewriteProxy(targetPort: number): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const incomingHost = req.headers.host ?? '';
      const forwardedHeaders: Record<string, string | string[]> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (val !== undefined && key.toLowerCase() !== 'host') {
          forwardedHeaders[key] = val;
        }
      }
      forwardedHeaders['host'] = `127.0.0.1:${targetPort}`;
      forwardedHeaders['x-forwarded-host'] = incomingHost;
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url ?? '/',
          method: req.method ?? 'GET',
          headers: forwardedHeaders,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        res.writeHead(502).end(err.message);
      });
      if (chunks.length > 0) upstream.write(Buffer.concat(chunks));
      upstream.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxyServers.push(server);
  return (server.address() as AddressInfo).port;
}

describe('Next.js rewrite dev-server port acceptance on Studio data and Storage byte routes (#1500)', () => {
  it('learns Next rewrite port on cold start, serves Studio workspace/projects and Storage bytes, and rejects unlearned local ports and foreign origins with 403', async () => {
    const root = makeTempDir('pyric-1500-next-rewrite-');
    const sdkDir = join(root, 'sdk');
    const projectsDir = join(root, '.pyric', 'projects');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>');
    writeFileSync(join(root, 'notes.txt'), 'initial-content');

    const token = 'next-rewrite-session-token-1500';
    const appPorts = createAppPorts('localhost');

    const initPayload = (): InitPayload => ({
      rules: null,
      rulesHash: null,
      storageRules: 'rules_version = "2"; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }',
      storageRulesHash: 'storage-1500',
      bridgeUrl: null,
      seed: null,
      hosted: true,
      projectKey: root,
    });

    const ns = createPyricNamespace({
      boundHost: 'localhost',
      appPorts,
      sdkDir,
      initPayload,
      sessionToken: token,
      studio: {
        workspace: diskWorkspace(root),
        projects: diskProjectStore(projectsDir),
      },
    });
    const mount = createBridgeMount({
      projectKey: root,
      hosted: true,
      disableAuditLog: true,
      sessionToken: token,
      appPorts,
      learnsProxyPorts: true,
      upgradeGuard: { boundHost: 'localhost' },
    });
    mounts.push(mount);

    const sandboxServer = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      sessionToken: token,
      namespaceHandler: async (req, res, url) => {
        appPorts.learn(req);
        if (await mount.handler(req, res, url)) return true;
        return ns(req, res, url);
      },
      logger: silentServeLogger(),
    });
    handles.push(sandboxServer);

    const nextPort = await startNextRewriteProxy(sandboxServer.port);
    const nextOrigin = `http://localhost:${nextPort}`;
    const unlearnedPort = nextPort === 41234 ? 41235 : 41234;
    const unlearnedOrigin = `http://localhost:${unlearnedPort}`;
    const foreignOrigin = 'https://evil.example';

    // 1. Cold-start learning via first proxied same-origin Studio request through Next rewrite.
    const wsList = await rawHttp({
      port: nextPort,
      path: '/__pyric/workspace/list',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-origin',
        'x-pyric-session-token': token,
      },
    });
    expect(wsList.status).toBe(200);
    expect(wsList.body).toContain('notes.txt');

    // 2. Studio workspace read/write and projects routes accept the learned Next port
    //    both via the rewrite proxy (same-origin) and directly (same-site).
    const wsRead = await rawHttp({
      port: nextPort,
      path: '/__pyric/workspace?path=notes.txt',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-origin',
        'x-pyric-session-token': token,
      },
    });
    expect(wsRead.status).toBe(200);
    expect(wsRead.body).toContain('initial-content');

    const wsWrite = await rawHttp({
      port: nextPort,
      path: '/__pyric/workspace?path=notes.txt',
      method: 'PUT',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        'x-pyric-session-token': token,
        'x-pyric-writer': 'tab-next-1500',
      },
      body: JSON.stringify({ content: 'updated-via-next-rewrite' }),
    });
    expect(wsWrite.status).toBe(204);

    const projectsList = await rawHttp({
      port: sandboxServer.port,
      path: '/__pyric/projects',
      headers: {
        Host: `localhost:${sandboxServer.port}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-site',
        'x-pyric-session-token': token,
      },
    });
    expect(projectsList.status).toBe(200);

    // 3. Storage byte route guard in bridge-mount.ts admits the learned Next dev-server port
    //    (passes origin + Sec-Fetch-Site guard -> 404 from absent runtime, never 403).
    const storageViaRewrite = await rawHttp({
      port: nextPort,
      path: '/__pyric/storage/v0/b/default-bucket/o/hello.txt?alt=media',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-origin',
        'x-pyric-session-token': token,
      },
    });
    expect(storageViaRewrite.status).toBe(404);

    const storageDirectSameSite = await rawHttp({
      port: sandboxServer.port,
      path: '/__pyric/storage/v0/b/default-bucket/o/hello.txt?alt=media',
      headers: {
        Host: `localhost:${sandboxServer.port}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-site',
        'x-pyric-session-token': token,
      },
    });
    expect(storageDirectSameSite.status).toBe(404);

    // 4. Negative: forged cross-site x-forwarded-host does NOT teach unlearnedPort, and unlearnedPort is 403.
    const forgedLearn = await rawHttp({
      port: sandboxServer.port,
      path: '/__pyric/workspace/list',
      headers: {
        Host: `localhost:${sandboxServer.port}`,
        'X-Forwarded-Host': `localhost:${unlearnedPort}`,
        Origin: unlearnedOrigin,
        'Sec-Fetch-Site': 'same-site',
        'x-pyric-session-token': token,
      },
    });
    expect(forgedLearn.status).toBe(403);

    for (const badOrigin of [unlearnedOrigin, foreignOrigin]) {
      const badWs = await rawHttp({
        port: sandboxServer.port,
        path: '/__pyric/workspace?path=notes.txt',
        headers: {
          Host: `localhost:${sandboxServer.port}`,
          Origin: badOrigin,
          'Sec-Fetch-Site': 'same-site',
          'x-pyric-session-token': token,
        },
      });
      expect(badWs.status).toBe(403);

      const badProjects = await rawHttp({
        port: sandboxServer.port,
        path: '/__pyric/projects',
        headers: {
          Host: `localhost:${sandboxServer.port}`,
          Origin: badOrigin,
          'Sec-Fetch-Site': 'same-site',
          'x-pyric-session-token': token,
        },
      });
      expect(badProjects.status).toBe(403);

      const badStorage = await rawHttp({
        port: sandboxServer.port,
        path: '/__pyric/storage/v0/b/default-bucket/o/hello.txt?alt=media',
        headers: {
          Host: `localhost:${sandboxServer.port}`,
          Origin: badOrigin,
          'Sec-Fetch-Site': 'same-site',
          'x-pyric-session-token': token,
        },
      });
      expect(badStorage.status).toBe(403);
    }

    // 5. Negative: missing session token is still 401 on Studio data routes through Next rewrite.
    const noTokenWs = await rawHttp({
      port: nextPort,
      path: '/__pyric/workspace/list',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(noTokenWs.status).toBe(401);
  });
});
