/**
 * End-to-end regression tests for #1813 (remote clients never receive the raw
 * local project directory path / developer username across HTML, Studio shell,
 * `/__pyric/init.json`, WS `attach-ack`, or `/__pyric/state`) and #1591
 * (defensive `/__pyric/init.json` sanitization of Gemini `apiKey`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { injectServeTags } from '../../src/serve/html-injection.js';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import { opaqueProjectKey } from '../../src/serve/project-key.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { createStateStore } from '../../src/serve/state-store.js';
import { UNLOCK_PATH } from '../../src/serve/unlock-route.js';
import { attachViteHtmlSessionBootstrap, currentViteHtmlPeerContext } from '../../src/serve/vite-generation-middleware.js';

const handles: ServeHandle[] = [];
const attachments: Array<{ close(): Promise<void> }> = [];
const mounts: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (attachments.length > 0) {
    const a = attachments.pop();
    if (a !== undefined) await a.close();
  }
  while (mounts.length > 0) {
    const m = mounts.pop();
    if (m !== undefined) await m.close();
  }
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) {
      for (const s of h.servers) {
        s.closeAllConnections?.();
        s.unref();
      }
      if (h.servers.every((s) => s.listening)) {
        await Promise.race([
          h.stop(),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 250);
            timer.unref();
          }),
        ]);
      }
    }
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
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        agent: false,
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

function extractSetCookie(headers: IncomingHttpHeaders): string {
  const value = headers['set-cookie'];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function extractDataProjectKey(html: string): string | null {
  const match = /data-project-key="([^"]+)"/.exec(html);
  return match === null ? null : (match[1] ?? null);
}

function extractWorkerInit(html: string): { projectKey?: string | null; hosted?: boolean } | null {
  const match = /globalThis\.__PYRIC_WORKER_INIT__=([^;]+);/.exec(html);
  if (match === null || match[1] === undefined) return null;
  return JSON.parse(match[1]) as { projectKey?: string | null; hosted?: boolean };
}

function connectAttachAck(
  port: number,
  headers: Record<string, string>,
): Promise<{ projectKey?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__pyric/sandbox`, { headers });
    let settled = false;
    let ack: { projectKey?: string } | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error('timed out waiting for attach-ack'));
    }, 5_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; projectKey?: string };
      if (msg.type === 'attach-ack' && ack === undefined) {
        ack = msg;
        ws.close();
      }
    });
    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    ws.on('close', (code, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ack !== undefined) {
        resolve(ack);
        return;
      }
      reject(new Error(`ws closed before attach-ack: ${code} ${reason.toString()}`));
    });
  });
}

describe('remote hosted projectKey redaction (#1813) and init.json AI sanitization (#1591)', () => {
  it('replaces raw project path with one consistent opaque key across HTML, Studio shell, init.json, and WS attach-ack for authenticated remote clients while keeping loopback raw and unauthenticated remote stripped', async () => {
    const root = makeTempDir('pyric-1813-secret-dev-user-');
    const rawProjectDir = join(root, 'secret-dev-user-repo');
    const sdkDir = join(root, 'sdk');
    const siteDir = join(root, 'site');
    mkdirSync(rawProjectDir, { recursive: true });
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(join(siteDir, 'studio'), { recursive: true });
    writeFileSync(join(rawProjectDir, 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
    writeFileSync(join(siteDir, 'studio-routes.json'), JSON.stringify({ routes: ['studio'] }));
    writeFileSync(
      join(siteDir, 'studio', 'index.html'),
      '<!doctype html><html><head></head><body>studio</body></html>',
    );

    const state = createStateStore(rawProjectDir);
    await state.writeSection('auth', { users: [] });

    const token = 'token-1813-remote-project-key';
    const leakedApiKey = 'AIzaSy-must-not-reach-init-1591';
    const remoteAccess = { allowedHosts: ['devbox.example.com'], trustProxy: false as const };
    const expectedOpaque = opaqueProjectKey(rawProjectDir);
    expect(expectedOpaque).toMatch(/^project-[0-9a-f]{24}$/);
    expect(expectedOpaque).not.toContain('secret-dev-user');

    const initPayload = (): InitPayload => ({
      rules: null,
      rulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: 'ws://127.0.0.1/__pyric/sandbox',
      seed: null,
      hosted: true,
      projectKey: rawProjectDir,
      ai: { engine: { kind: 'gemini', apiKey: leakedApiKey, baseUrl: 'http://127.0.0.1:49999' } },
    });

    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      siteUiDir: siteDir,
      initPayload,
      state,
      sessionToken: token,
      remoteAccess,
    });
    const mount = createBridgeMount({
      projectKey: rawProjectDir,
      hosted: true,
      disableAuditLog: true,
      sessionToken: token,
      remoteAccess,
      upgradeGuard: { boundHost: '127.0.0.1', allowedHosts: ['devbox.example.com'] },
    });
    mounts.push(mount);

    const server = await startStaticServer({
      publicDir: rawProjectDir,
      port: 0,
      host: '127.0.0.1',
      remoteAccess,
      sessionToken: token,
      namespaceHandler: async (req, res, url) => (await mount.handler(req, res, url)) || ns(req, res, url),
      transformHtml: (html, ctx) => {
        const htmlHosted =
          ctx.remoteClient === true
            ? { projectKey: opaqueProjectKey(rawProjectDir) }
            : { projectKey: rawProjectDir };
        return injectServeTags(html, {
          hosted: htmlHosted,
          sessionToken: ctx.localPeer ? token : undefined,
          remotePeer: !ctx.localPeer,
        });
      },
      logger: silentServeLogger(),
    });
    handles.push(server);
    attachments.push(
      mount.attachHost({
        servers: server.servers,
        projectDir: rawProjectDir,
        origin: () => ({ host: '127.0.0.1', port: server.port }),
        closeOnServerClose: true,
      }),
    );

    const remoteHost = `devbox.example.com:${server.port}`;
    const remoteOrigin = `http://${remoteHost}`;
    const loopbackHost = `127.0.0.1:${server.port}`;

    // 1. Unauthenticated remote HTML stays stripped (no projectKey, no raw path).
    const unauthedRemoteHtml = await rawHttp({
      port: server.port,
      path: '/',
      headers: { Host: remoteHost },
    });
    expect(unauthedRemoteHtml.status).toBe(200);
    expect(unauthedRemoteHtml.body).not.toContain(rawProjectDir);
    expect(unauthedRemoteHtml.body).not.toContain('secret-dev-user');
    expect(extractDataProjectKey(unauthedRemoteHtml.body)).toBeNull();
    expect(extractWorkerInit(unauthedRemoteHtml.body)?.projectKey).toBeNull();

    // 2. Unlock via /__pyric/unlock to authenticate remote browser session.
    const unlockRes = await rawHttp({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: remoteHost,
        Origin: remoteOrigin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    expect(unlockRes.status).toBe(200);
    const cookie = extractSetCookie(unlockRes.headers).split(';', 1)[0] ?? '';

    // 3. Authenticated remote HTML, Studio shell, init.json, WS attach-ack all agree on expectedOpaque.
    const authedRemoteHtml = await rawHttp({
      port: server.port,
      path: '/',
      headers: { Host: remoteHost, Cookie: cookie },
    });
    expect(authedRemoteHtml.status).toBe(200);
    expect(authedRemoteHtml.body).not.toContain(rawProjectDir);
    expect(authedRemoteHtml.body).not.toContain('secret-dev-user');
    expect(extractDataProjectKey(authedRemoteHtml.body)).toBe(expectedOpaque);
    expect(extractWorkerInit(authedRemoteHtml.body)?.projectKey).toBe(expectedOpaque);

    const authedRemoteStudio = await rawHttp({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: { Host: remoteHost, Origin: remoteOrigin, Cookie: cookie },
    });
    expect(authedRemoteStudio.status).toBe(200);
    expect(authedRemoteStudio.body).not.toContain(rawProjectDir);
    expect(authedRemoteStudio.body).not.toContain('secret-dev-user');
    expect(extractDataProjectKey(authedRemoteStudio.body)).toBe(expectedOpaque);
    expect(extractWorkerInit(authedRemoteStudio.body)?.projectKey).toBe(expectedOpaque);

    const authedRemoteInit = await rawHttp({
      port: server.port,
      path: '/__pyric/init.json',
      headers: { Host: remoteHost, Origin: remoteOrigin, Cookie: cookie },
    });
    expect(authedRemoteInit.status).toBe(200);
    expect(authedRemoteInit.body).not.toContain(rawProjectDir);
    expect(authedRemoteInit.body).not.toContain('secret-dev-user');
    expect(authedRemoteInit.body).not.toContain(leakedApiKey);
    const remoteInitJson = JSON.parse(authedRemoteInit.body) as InitPayload;
    expect(remoteInitJson.projectKey).toBe(expectedOpaque);
    expect(remoteInitJson.ai).toEqual({ engine: { kind: 'gemini' } });

    const remoteAck = await connectAttachAck(server.port, {
      Host: remoteHost,
      Origin: remoteOrigin,
      Cookie: cookie,
    });
    expect(remoteAck.projectKey).toBe(expectedOpaque);

    // 4. GET /__pyric/state omits x-pyric-project-dir on remote requests, keeps it on loopback.
    const remoteState = await rawHttp({
      port: server.port,
      path: '/__pyric/state',
      headers: { Host: remoteHost, Origin: remoteOrigin, Cookie: cookie },
    });
    expect(remoteState.status).toBe(200);
    expect(remoteState.headers['x-pyric-project-dir']).toBeUndefined();

    const localState = await rawHttp({
      port: server.port,
      path: '/__pyric/state',
      headers: { Host: loopbackHost, 'x-pyric-session-token': token },
    });
    expect(localState.status).toBe(200);
    expect(localState.headers['x-pyric-project-dir']).toBe(rawProjectDir);

    // 5. Loopback HTML, Studio, init.json, and WS attach-ack keep raw projectKey while still sanitizing Gemini apiKey.
    const localHtml = await rawHttp({
      port: server.port,
      path: '/',
      headers: { Host: loopbackHost },
    });
    expect(extractDataProjectKey(localHtml.body)).toBe(rawProjectDir);
    expect(extractWorkerInit(localHtml.body)?.projectKey).toBe(rawProjectDir);

    const localInit = await rawHttp({
      port: server.port,
      path: '/__pyric/init.json',
      headers: { Host: loopbackHost, 'x-pyric-session-token': token },
    });
    expect(localInit.status).toBe(200);
    expect(localInit.body).not.toContain(leakedApiKey);
    const localInitJson = JSON.parse(localInit.body) as InitPayload;
    expect(localInitJson.projectKey).toBe(rawProjectDir);
    expect(localInitJson.ai).toEqual({ engine: { kind: 'gemini' } });

    const localAck = await connectAttachAck(server.port, {
      Host: loopbackHost,
      Origin: `http://${loopbackHost}`,
      'x-pyric-session-token': token,
    });
    expect(localAck.projectKey).toBe(rawProjectDir);
  });

  it('marks Vite HTML peer context with remoteClient accurately for loopback, authenticated remote, and unauthenticated remote requests (#1813)', () => {
    const projectDir = makeTempDir('pyric-vite-1813-secret-user-');

    const middlewares: Array<(req: IncomingMessage, res: ServerResponse, next: () => void) => void> = [];
    const fakeServer = {
      config: {
        root: projectDir,
        server: { host: '127.0.0.1', allowedHosts: [] as string[] },
        logger: { info() {}, warn() {}, error() {} },
      },
      middlewares: {
        use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) {
          middlewares.push(fn);
        },
      },
    };
    const token = 'vite-token-1813';
    attachViteHtmlSessionBootstrap(fakeServer as never, () => token, () => ({
      allowedHosts: ['devbox.example.com'],
      remoteAccess: { allowedHosts: ['devbox.example.com'] },
    }));

    const middleware = middlewares[0];
    if (middleware === undefined) throw new Error('expected Vite HTML middleware');

    let remotePeerCtx: { localPeer: boolean; remoteClient: boolean } | undefined;
    middleware(
      {
        method: 'GET',
        url: '/',
        headers: {
          host: 'devbox.example.com:5173',
          accept: 'text/html',
          'x-pyric-session-token': token,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173 },
      } as unknown as IncomingMessage,
      { getHeader: () => undefined, setHeader: () => {} } as unknown as ServerResponse,
      () => {
        remotePeerCtx = currentViteHtmlPeerContext();
      },
    );
    expect(remotePeerCtx).toEqual({ localPeer: true, remoteClient: true });

    let unauthedRemoteCtx: { localPeer: boolean; remoteClient: boolean } | undefined;
    middleware(
      {
        method: 'GET',
        url: '/',
        headers: {
          host: 'devbox.example.com:5173',
          accept: 'text/html',
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173 },
      } as unknown as IncomingMessage,
      { getHeader: () => undefined, setHeader: () => {} } as unknown as ServerResponse,
      () => {
        unauthedRemoteCtx = currentViteHtmlPeerContext();
      },
    );
    expect(unauthedRemoteCtx).toEqual({ localPeer: false, remoteClient: true });

    let loopbackCtx: { localPeer: boolean; remoteClient: boolean } | undefined;
    middleware(
      {
        method: 'GET',
        url: '/',
        headers: {
          host: '127.0.0.1:5173',
          accept: 'text/html',
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173 },
      } as unknown as IncomingMessage,
      { getHeader: () => undefined, setHeader: () => {} } as unknown as ServerResponse,
      () => {
        loopbackCtx = currentViteHtmlPeerContext();
      },
    );
    expect(loopbackCtx).toEqual({ localPeer: true, remoteClient: false });
  });
});
