import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { startServe } from '../../src/cli/serve.js';
import { silentServeLogger, startStaticServer } from '../../src/serve/server.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { allocateFreeVitePort } from './free-vite-port.ts';
import {
  cleanupLoopbackSecurityFixtures,
  createProject,
  dirs,
  rawHttpRequest,
  runtimes,
  staticHandles,
  tryWsUpgrade,
  viteServers,
} from './loopback-route-security-support.ts';

afterEach(cleanupLoopbackSecurityFixtures);

describe('loopback route security hardening on Vite and token boundaries (ADR 0024 Decision 5)', () => {
  it('refuses non-loopback and tunnel Hosts on unauthenticated Vite /__pyric/* routes under both server.allowedHosts: true and explicit server.allowedHosts', async () => {
    const cwd = createProject();
    writeFileSync(join(cwd, 'index.html'), '<!doctype html><html><head></head><body>vite ok</body></html>');
    const viteServer = await createViteServer({
      configFile: false,
      root: cwd,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: await allocateFreeVitePort(),
        allowedHosts: true,
      },
      plugins: [pyric({ bridge: { disableAuditLog: true }, ui: false })],
    });
    await viteServer.listen();
    viteServers.push(viteServer);
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('expected bound TCP port');
    const port = address.port;

    // Fetch local HTML to obtain the generation's stamped session token and cookie.
    const localHtml = await fetch(`http://127.0.0.1:${port}/`);
    expect(localHtml.status).toBe(200);
    const setCookie = localHtml.headers.get('set-cookie') ?? '';
    const htmlBody = await localHtml.text();
    const token = htmlBody.match(/"sessionToken":"([^"]+)"/)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(10);
    const cookie = setCookie.split(';')[0] ?? '';

    // Vite's public page honors server.allowedHosts: true without stamping session capabilities.
    const tunnelPage = await rawHttpRequest({
      port,
      path: '/',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(tunnelPage.status).toBe(200);
    expect(tunnelPage.body).not.toContain(token);
    expect(tunnelPage.headers['set-cookie']).toBeUndefined();

    // Foreign iframe and subresource fetches never bootstrap session capabilities on Vite HTML.
    const crossPortIframe = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    });
    expect(crossPortIframe.status).toBe(200);
    expect(crossPortIframe.body).not.toContain(token);
    expect(crossPortIframe.headers['set-cookie']).toBeUndefined();

    const foreignSubresource = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'empty',
      },
    });
    expect(foreignSubresource.status).toBe(200);
    expect(foreignSubresource.body).not.toContain(token);
    expect(foreignSubresource.headers['set-cookie']).toBeUndefined();

    // Top-level document navigations and same-origin iframes still bootstrap cleanly.
    const topLevelNav = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(topLevelNav.status).toBe(200);
    expect(topLevelNav.body).toContain(token);
    expect(String(topLevelNav.headers['set-cookie'] ?? '')).toContain(`__pyric_session_${port}=`);

    const sameOriginIframe = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    });
    expect(sameOriginIframe.status).toBe(200);
    expect(sameOriginIframe.body).toContain(token);
    expect(String(sameOriginIframe.headers['set-cookie'] ?? '')).toContain(`__pyric_session_${port}=`);

    // ...while Pyric's local surfaces still enforce loopback Host unconditionally.
    for (const path of ['/__pyric/init.json', '/__pyric/health', '/__pyric/diagnostics', '/__pyric/mcp', '/__pyric/flow/manifest.json']) {
      const headers: Record<string, string> = {
        host: 'app.evil.test',
        cookie,
        'x-pyric-session-token': token,
      };
      if (path === '/__pyric/mcp') {
        headers['content-type'] = 'application/json';
      }
      const res = await rawHttpRequest({
        port,
        path,
        method: path === '/__pyric/mcp' ? 'POST' : 'GET',
        headers,
        body: path === '/__pyric/mcp' ? '{}' : undefined,
      });
      expect(res.status, `Vite allowedHosts:true rebound Host on ${path}`).toBe(403);
    }

    expect(
      await tryWsUpgrade(`ws://127.0.0.1:${port}/__pyric/sandbox`, {
        Host: 'app.evil.test',
        Origin: `http://127.0.0.1:${port}`,
        'x-pyric-session-token': token,
      }),
    ).toBe(false);
    await viteServers.pop()?.close();

    // Vite opt-in pyric({ sessionToken: true }) enforces 401 on unauthenticated loopback routes.
    const strictCwd = createProject();
    writeFileSync(join(strictCwd, 'index.html'), '<!doctype html><html><head></head><body>strict vite</body></html>');
    const strictVite = await createViteServer({
      configFile: false,
      root: strictCwd,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: await allocateFreeVitePort(),
        allowedHosts: ['preview.tunnel.example'],
      },
      plugins: [pyric({ sessionToken: true, bridge: { disableAuditLog: true }, ui: false })],
    });
    await strictVite.listen();
    viteServers.push(strictVite);
    const strictAddr = strictVite.httpServer?.address();
    if (!strictAddr || typeof strictAddr === 'string') throw new Error('expected bound TCP port');
    expect((await fetch(`http://127.0.0.1:${strictAddr.port}/__pyric/diagnostics`)).status).toBe(401);
    expect(
      (
        await rawHttpRequest({
          port: strictAddr.port,
          path: '/__pyric/init.json',
          headers: { host: 'preview.tunnel.example' },
        })
      ).status,
    ).toBe(403);
  }, 30_000);

  it('requires session token on flow bundles, refuses unauthenticated storage existence probes, and fails closed in Vite middlewareMode / pre-middleware SSR', async () => {
    const cwd = createProject();
    writeFileSync(
      join(cwd, 'storage.rules'),
      "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /items/{id} { allow read, write: if true; }\n  }\n}\n",
    );
    writeFileSync(join(cwd, 'custom-flow.js'), "export const flowLabel = 'internal-flow-module';\n");
    const rawHtml = '<!doctype html><html><head><title>App</title></head><body><div id="app"></div></body></html>';
    writeFileSync(join(cwd, 'index.html'), rawHtml);

    const customSsrPlugin = {
      name: 'custom-ssr-shell',
      enforce: 'pre' as const,
      configureServer(srv: import('vite').ViteDevServer) {
        srv.middlewares.use(async (req, res, next) => {
          if (req.url === '/ssr-page') {
            const html = await srv.transformIndexHtml(req.url, rawHtml);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
            return;
          }
          next();
        });
      },
    };

    const ssrVite = await createViteServer({
      configFile: false,
      root: cwd,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: await allocateFreeVitePort(),
        allowedHosts: ['tunnel.example'],
      },
      plugins: [
        customSsrPlugin,
        pyric({
          bridge: { disableAuditLog: true },
          sessionToken: true,
          ui: false,
          flow: {
            treatments: [{ id: 'org:custom-one', label: 'Custom One', module: './custom-flow.js' }],
          },
        }),
      ],
    });
    await ssrVite.listen();
    viteServers.push(ssrVite);
    const addr = ssrVite.httpServer?.address();
    if (!addr || typeof addr === 'string') throw new Error('expected bound TCP port');
    const port = addr.port;

    const flowManifest = await rawHttpRequest({
      port,
      path: '/__pyric/flow/manifest.json',
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(flowManifest.status).toBe(401);

    const flowBundle = await rawHttpRequest({
      port,
      path: '/__pyric/flow/custom/org%3Acustom-one.js',
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(flowBundle.status).toBe(401);

    const storageTunnel = await rawHttpRequest({
      port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media',
      headers: { host: 'tunnel.example' },
    });
    expect(storageTunnel.status).toBe(403);

    const { createStorageByteRoute } = await import('../../src/serve/hosted/storage-byte-route.js');
    let probedObjectFile = false;
    const byteRoute = createStorageByteRoute({
      storage: {
        async objectFile() {
          probedObjectFile = true;
          return undefined;
        },
        async appendUpload() {
          throw new Error('unexpected');
        },
        async uploadProgress() {
          return undefined;
        },
      },
      sessionToken: 'byte-route-secret',
      uploadToken: () => undefined,
    });
    const byteServer = await startStaticServer({
      publicDir: null,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: (req, res, url) => byteRoute(req, res, url),
      logger: silentServeLogger(),
    });
    staticHandles.push(byteServer);

    const storageLoopbackNoToken = await rawHttpRequest({
      port: byteServer.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media',
      headers: { host: `127.0.0.1:${byteServer.port}` },
    });
    expect(storageLoopbackNoToken.status).toBe(403);
    expect(storageLoopbackNoToken.body).not.toContain('No such object.');
    expect(probedObjectFile).toBe(false);

    const storageEmptyDownloadToken = await rawHttpRequest({
      port: byteServer.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media&token=',
      headers: { host: `127.0.0.1:${byteServer.port}` },
    });
    expect(storageEmptyDownloadToken.status).toBe(403);
    expect(storageEmptyDownloadToken.body).not.toContain('No such object.');
    expect(probedObjectFile).toBe(false);

    const storageSdkAuthed = await rawHttpRequest({
      port: byteServer.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media',
      headers: {
        host: `127.0.0.1:${byteServer.port}`,
        'x-pyric-session-token': 'byte-route-secret',
      },
    });
    expect(storageSdkAuthed.status).toBe(404);

    const remoteSsr = await rawHttpRequest({
      port,
      path: '/ssr-page',
      headers: {
        host: 'tunnel.example',
        origin: 'https://other.example',
        'sec-fetch-site': 'cross-site',
        'x-pyric-remote-peer': '1',
      },
    });
    expect(remoteSsr.status).toBe(200);
    expect(remoteSsr.body).not.toContain('"sessionToken"');
    expect(remoteSsr.body).not.toContain('data-project-key=');

    const localSsr = await rawHttpRequest({
      port,
      path: '/ssr-page',
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(localSsr.status).toBe(200);
    expect(localSsr.body).toContain('"sessionToken"');

    const middlewareVite = await createViteServer({
      configFile: false,
      root: cwd,
      logLevel: 'silent',
      appType: 'custom',
      server: {
        middlewareMode: true,
        allowedHosts: ['tunnel.example'],
      },
      plugins: [pyric({ sessionToken: true, ui: false })],
    });
    viteServers.push(middlewareVite);
    const middlewareRendered = await middlewareVite.transformIndexHtml('/', rawHtml);
    expect(middlewareRendered).not.toContain('"sessionToken"');
  }, 30_000);

  it('scopes resolveSessionTokenForTarget to matching loopback ports and project boundaries, and replaces symlinks atomically in writeMode600FileSync', () => {
    const {
      resolveSessionTokenForTarget,
      writeMode600FileSync,
    } = require('../../src/serve/local-session-token.js') as typeof import('../../src/serve/local-session-token.js');

    const root = mkdtempSync(join(tmpdir(), 'pyric-token-scope-'));
    dirs.push(root);
    const siblingWebPyric = join(root, 'web', '.pyric');
    const otherProject = join(root, 'other-project');
    mkdirSync(siblingWebPyric, { recursive: true });
    mkdirSync(otherProject, { recursive: true });
    writeFileSync(join(otherProject, 'package.json'), '{"name":"other-project"}\n');
    writeFileSync(
      join(siblingWebPyric, 'serve.json'),
      JSON.stringify({
        url: 'http://127.0.0.1:3473',
        port: 3473,
        pid: process.pid,
        instanceId: 'inst-a',
        token: 'tok-project-a',
      }),
    );

    expect(
      resolveSessionTokenForTarget({
        cwd: otherProject,
        url: 'http://127.0.0.2:4999',
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveSessionTokenForTarget({
        cwd: join(root, 'web'),
        url: 'http://remote.example:3473',
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveSessionTokenForTarget({
        cwd: join(root, 'web'),
        url: 'http://127.0.0.2:3473',
        env: {},
      }),
    ).toBe('tok-project-a');

    const externalTarget = join(root, 'external-note.txt');
    writeFileSync(externalTarget, 'UNCHANGED');
    const pointerDir = join(otherProject, '.pyric');
    mkdirSync(pointerDir, { recursive: true });
    const symlinkPointer = join(pointerDir, 'serve.json');
    const { lstatSync, symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(externalTarget, symlinkPointer);

    writeMode600FileSync(symlinkPointer, '{"token":"fresh-secret"}\n');
    expect(readFileSync(externalTarget, 'utf8')).toBe('UNCHANGED');
    expect(lstatSync(symlinkPointer).isSymbolicLink()).toBe(false);
    expect(readFileSync(symlinkPointer, 'utf8')).toContain('fresh-secret');
  });

  it('rejects wildcard 0.0.0.0 Host, scheme-mismatched Origin, forged Origin + cross-site Sec-Fetch-Site, foreign OPTIONS preflights, and sibling ports on extra allowedHosts', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      sessionToken: true,
      ui: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const port = runtime.handle.port;
    const token = runtime.sessionToken;

    // 1. Wildcard Host 0.0.0.0:<port> is never accepted as loopback.
    for (const path of ['/', '/__pyric/init.json', '/__pyric/ui/studio', '/__pyric/mcp']) {
      const res = await rawHttpRequest({
        port,
        path,
        method: path === '/__pyric/mcp' ? 'POST' : 'GET',
        headers: {
          host: `0.0.0.0:${port}`,
          'x-pyric-session-token': token,
        },
        body: path === '/__pyric/mcp' ? '{}' : undefined,
      });
      expect(res.status, `0.0.0.0 Host on ${path}`).toBe(403);
    }

    // 2. Scheme-mismatched Origin (https://localhost:<port> against http server) is rejected with 403.
    const schemeMismatch = await rawHttpRequest({
      port,
      path: '/__pyric/diagnostics',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `https://127.0.0.1:${port}`,
        'x-pyric-session-token': token,
      },
    });
    expect(schemeMismatch.status).toBe(403);

    // 3. Same-origin Origin paired with Sec-Fetch-Site: cross-site or same-site is rejected with 403.
    for (const site of ['cross-site', 'same-site'] as const) {
      const forged = await rawHttpRequest({
        port,
        path: '/__pyric/diagnostics',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'sec-fetch-site': site,
          'x-pyric-session-token': token,
        },
      });
      expect(forged.status, `Origin + Sec-Fetch-Site:${site}`).toBe(403);
    }

    // 4. Foreign OPTIONS preflights are rejected with 403 across local surfaces.
    for (const path of ['/__pyric/init.json', '/__pyric/flow/manifest.json', '/__pyric/mcp', '/__pyric/ui/studio']) {
      const preflight = await rawHttpRequest({
        port,
        path,
        method: 'OPTIONS',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: 'https://attacker.example',
          'sec-fetch-site': 'cross-site',
          'x-pyric-session-token': token,
        },
      });
      expect(preflight.status, `OPTIONS ${path}`).toBe(403);
    }

    // 5. Extra allowedHosts entry does not admit sibling ports on Origin.
    const siblingPortTunnel = await rawHttpRequest({
      port,
      path: '/__pyric/init.json',
      headers: {
        host: `tunnel.example:${port}`,
        origin: `http://tunnel.example:${port + 1}`,
        'sec-fetch-site': 'same-site',
        'x-pyric-session-token': token,
      },
    });
    expect(siblingPortTunnel.status).toBe(403);
  }, 30_000);
});
