/**
 * End-to-end proxy integration tests verifying that rewrite rules produced by
 * `withPyric()` forward `/__pyric/functions/*`, emulator callable paths, and
 * `firebase.json` Hosting function rewrites cleanly to Pyric's real
 * `startStaticServer` + `createFunctionsHttpGateway`, while preserving user
 * static/route precedence and enforcing private-invoker and remote-peer guards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withPyric } from '../../src/next/index.js';
import type { NextRewriteRule } from '../../src/next/hosting-rewrites.js';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import { FUNCTION_TARGET_HEADER } from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import { hostingRewrites } from '../../src/functions/http/rewrites.js';
import { clearRegisterActive, markRegisterActive } from '../../src/register/activation.js';
import { createAppPorts } from '../../src/serve/app-ports.js';
import {
  getHeader,
  isAllowedOriginOnPorts,
  isForeignFetchSite,
  requestSocketScheme,
} from '../../src/serve/loopback-guard.js';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { REMOTE_PEER_HEADER } from '../../src/serve/peer.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const nextPkgDir = resolve(repoRoot, 'examples/nextjs-sandbox-app/node_modules/next');
const hasInstalledNext = existsSync(resolve(nextPkgDir, 'package.json'));

const servers: Server[] = [];
const handles: ServeHandle[] = [];
const tempDirs: string[] = [];

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
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
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
          resolveReq({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', rejectReq);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function startChildFunctionServer(expectedToken: string): Promise<number> {
  const child = createServer((req, res) => {
    if (req.headers[CHILD_TOKEN_HEADER] !== expectedToken) {
      res.writeHead(403).end('missing child token');
      return;
    }
    const exportName = req.headers[FUNCTION_TARGET_HEADER] ?? 'unknown';
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        fn: exportName,
        url: req.url,
        originalUrl: req.headers['x-original-url'] ?? null,
        cookie: req.headers.cookie ?? null,
      }),
    );
  });
  await new Promise<void>((r) => child.listen(0, '127.0.0.1', r));
  servers.push(child);
  return (child.address() as AddressInfo).port;
}

async function startNextRewriteSimulator(input: {
  rewrites: {
    beforeFiles: NextRewriteRule[];
    afterFiles: NextRewriteRule[];
    fallback: NextRewriteRule[];
  };
  staticRoutes: ReadonlyMap<string, string>;
}): Promise<number> {
  const req = createRequire(import.meta.url);
  const { getPathMatch } = req(resolve(nextPkgDir, 'dist/shared/lib/router/utils/path-match.js'));
  const { prepareDestination } = req(resolve(nextPkgDir, 'dist/shared/lib/router/utils/prepare-destination.js'));

  const compileRules = (rules: NextRewriteRule[]) =>
    rules.map((rule) => ({
      rule,
      match: getPathMatch(rule.source) as (pathname: string) => false | Record<string, string | string[]>,
    }));

  const before = compileRules(input.rewrites.beforeFiles);
  const after = compileRules(input.rewrites.afterFiles);
  const fallback = compileRules(input.rewrites.fallback);

  const matchBucket = (
    bucket: ReturnType<typeof compileRules>,
    pathname: string,
    search: string,
  ): URL | null => {
    for (const entry of bucket) {
      const params = entry.match(pathname);
      if (!params) continue;
      const prepared = prepareDestination({
        appendParamsToQuery: false,
        destination: entry.rule.destination,
        params,
        query: {},
      }) as { newUrl: string };
      const destOrigin = new URL(entry.rule.destination).origin;
      const newPath = prepared.newUrl.length > 0 ? prepared.newUrl : '/';
      return new URL(`${newPath}${search}`, destOrigin);
    }
    return null;
  };

  const proxy = createServer((reqMsg, res) => {
    const chunks: Buffer[] = [];
    reqMsg.on('data', (chunk: Buffer) => chunks.push(chunk));
    reqMsg.on('end', () => {
      const parsed = new URL(reqMsg.url ?? '/', 'http://localhost');
      const forward = (dest: URL): void => {
        const forwardedHeaders: Record<string, string | string[]> = {};
        for (const [key, val] of Object.entries(reqMsg.headers)) {
          if (val !== undefined && key.toLowerCase() !== 'host') {
            forwardedHeaders[key] = val;
          }
        }
        forwardedHeaders.host = dest.host;
        if (reqMsg.headers.host !== undefined) {
          forwardedHeaders['x-forwarded-host'] = reqMsg.headers.host;
        }
        const upstream = httpRequest(
          {
            hostname: dest.hostname,
            port: Number(dest.port),
            path: `${dest.pathname}${dest.search}`,
            method: reqMsg.method ?? 'GET',
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
      };

      const beforeTarget = matchBucket(before, parsed.pathname, parsed.search);
      if (beforeTarget !== null) {
        forward(beforeTarget);
        return;
      }
      const staticBody = input.staticRoutes.get(parsed.pathname);
      if (staticBody !== undefined) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(staticBody);
        return;
      }
      const afterTarget = matchBucket(after, parsed.pathname, parsed.search);
      if (afterTarget !== null) {
        forward(afterTarget);
        return;
      }
      const fallbackTarget = matchBucket(fallback, parsed.pathname, parsed.search);
      if (fallbackTarget !== null) {
        forward(fallbackTarget);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('next-404');
    });
  });

  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  servers.push(proxy);
  return (proxy.address() as AddressInfo).port;
}

describe('Next.js withPyric Functions proxy integration', () => {
  const savedSandbox = process.env.PYRIC_SANDBOX;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedCwd = process.cwd();

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    markRegisterActive();
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    clearRegisterActive();
    if (savedSandbox === undefined) delete process.env.PYRIC_SANDBOX;
    else process.env.PYRIC_SANDBOX = savedSandbox;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    while (servers.length > 0) {
      const s = servers.pop();
      if (s !== undefined) await new Promise<void>((r) => s.close(() => r()));
    }
    while (handles.length > 0) {
      const h = handles.pop();
      if (h !== undefined) await h.stop();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d !== undefined) rmSync(d, { recursive: true, force: true });
    }
  });

  it('proxies /__pyric/functions/*, Hosting rewrites, and emulator paths while enforcing private-invoker and remote-peer guards', async () => {
    if (!hasInstalledNext) return;

    const projectDir = makeTempDir('pyric-next-fn-int-');
    const sdkDir = join(projectDir, 'sdk');
    const functionsDir = join(projectDir, 'functions');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(functionsDir, { recursive: true });
    writeFileSync(join(projectDir, 'next.config.mjs'), 'export default {};\n');
    writeFileSync(join(functionsDir, 'package.json'), JSON.stringify({ name: 'int-fns', main: 'index.js' }));
    writeFileSync(join(functionsDir, 'index.js'), 'exports.api = () => {};\n');
    const firebaseJson = {
      functions: { source: 'functions' },
      hosting: {
        rewrites: [
          { source: '/api/**', function: 'api' },
          { source: '/private/**', function: 'secretFn' },
        ],
      },
    };
    writeFileSync(join(projectDir, 'firebase.json'), JSON.stringify(firebaseJson, null, 2));
    writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));

    const childToken = 'child-secret-token';
    const childPort = await startChildFunctionServer(childToken);
    const appPorts = createAppPorts('localhost');
    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-proj',
      rewrites: hostingRewrites(firebaseJson),
      initial: {
        kind: 'ready',
        http: {
          port: childPort,
          token: childToken,
          functions: [
            { exportName: 'api', kind: 'http', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false },
            { exportName: 'secretFn', kind: 'http', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: true },
            { exportName: 'greet', kind: 'callable', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false },
          ],
        },
      },
      plane: 'pyric-sandbox',
    });

    const initPayload = (): InitPayload => ({
      rules: null,
      rulesHash: null,
      bridgeUrl: null,
      seed: null,
      hosted: true,
      projectKey: projectDir,
    });
    const ns = createPyricNamespace({
      boundHost: 'localhost',
      appPorts,
      sdkDir,
      initPayload,
    });
    const allowsAppOrigin = (req: Parameters<typeof getHeader>[0]): boolean => {
      const ports = appPorts.forRequest(req as never);
      const scheme = requestSocketScheme(req);
      return (
        isAllowedOriginOnPorts(getHeader(req, 'origin'), 'localhost', [], ports, scheme) &&
        !isForeignFetchSite(req, 'localhost', ports, scheme, [])
      );
    };

    const sandboxServer = await startStaticServer({
      publicDir: null,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: async (req, res, url) => {
        appPorts.learn(req);
        return ns(req, res, url);
      },
      functionsHandler: (req, res) => gateway.handle(req, res, allowsAppOrigin),
      logger: silentServeLogger(),
    });
    handles.push(sandboxServer);

    process.env.PYRIC_SANDBOX = `remote:http://127.0.0.1:${sandboxServer.port}`;
    process.chdir(projectDir);
    const nextConfig = await withPyric({})('phase-development-server', {});
    const resolvedRewrites = await nextConfig.rewrites();

    const nextPort = await startNextRewriteSimulator({
      rewrites: resolvedRewrites,
      staticRoutes: new Map([['/api/local-next', 'next-route-handler']]),
    });
    const nextOrigin = `http://localhost:${nextPort}`;

    // 1. Teach appPorts the Next.js port via a same-origin /__pyric/init.json request.
    const initRes = await rawHttp({
      port: nextPort,
      path: '/__pyric/init.json',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(initRes.status).toBe(200);

    // 2. /__pyric/functions/* strips its prefix and hits the Functions gateway directly.
    const prefixRes = await rawHttp({
      port: nextPort,
      path: '/__pyric/functions/demo-proj/us-central1/api/items?page=2',
      headers: { Host: `localhost:${nextPort}` },
    });
    expect(prefixRes.status).toBe(200);
    expect(JSON.parse(prefixRes.body)).toMatchObject({
      fn: 'api',
      url: '/items?page=2',
    });

    // 3. firebase.json Hosting function rewrite forwards original URL and filters cookies to __session.
    const hostingRes = await rawHttp({
      port: nextPort,
      path: '/api/orders?limit=5',
      headers: {
        Host: `localhost:${nextPort}`,
        Cookie: 'other=drop; __session=keep-me',
      },
    });
    expect(hostingRes.status).toBe(200);
    expect(JSON.parse(hostingRes.body)).toEqual({
      fn: 'api',
      url: '/api/orders?limit=5',
      originalUrl: '/api/orders?limit=5',
      cookie: '__session=keep-me',
    });

    // 4. Next.js static/API routes win over Hosting function rewrites (afterFiles semantics).
    const staticRouteRes = await rawHttp({
      port: nextPort,
      path: '/api/local-next',
      headers: { Host: `localhost:${nextPort}` },
    });
    expect(staticRouteRes.status).toBe(200);
    expect(staticRouteRes.body).toBe('next-route-handler');

    // 5. Emulator / callable path proxies cleanly through Next.js.
    const callableRes = await rawHttp({
      port: nextPort,
      path: '/demo-proj/us-central1/greet',
      method: 'POST',
      headers: {
        Host: `localhost:${nextPort}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: { name: 'Ada' } }),
    });
    expect(callableRes.status).toBe(200);
    expect(JSON.parse(callableRes.body)).toMatchObject({ fn: 'greet' });

    // 6. Private-invoker function allows Next's learned origin and refuses foreign origin with 403.
    const allowedPrivate = await rawHttp({
      port: nextPort,
      path: '/private/data',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: nextOrigin,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(allowedPrivate.status).toBe(200);
    expect(JSON.parse(allowedPrivate.body)).toMatchObject({ fn: 'secretFn' });

    const foreignPrivate = await rawHttp({
      port: nextPort,
      path: '/private/data',
      headers: {
        Host: `localhost:${nextPort}`,
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(foreignPrivate.status).toBe(403);

    // 7. Remote-marked peer forwarded through Next rewrite is refused by Functions request guard (403).
    const remoteMarked = await rawHttp({
      port: nextPort,
      path: '/__pyric/functions/demo-proj/us-central1/api/items',
      headers: {
        Host: `localhost:${nextPort}`,
        [REMOTE_PEER_HEADER]: '1',
      },
    });
    expect(remoteMarked.status).toBe(403);
  });
});
