/** `pyric dev` static server (plan step 1.3) — real HTTP over ephemeral
 *  ports: static files, traversal, SPA rewrite, seams, port scan-forward. */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentTypeFor,
  isAllowedHost,
  isAllowedOrigin,
  isAllowedUpgrade,
  loopbackHosts,
  resolveStaticFile,
  silentServeLogger,
  startStaticServer,
  type ServeHandle,
} from '../../src/serve/server.js';

describe('loopback host binding', () => {
  it('binds both localhost families', () => {
    expect(loopbackHosts('localhost')).toEqual(['127.0.0.1', '::1']);
  });

  it('binds an explicit host only to itself', () => {
    expect(loopbackHosts('0.0.0.0')).toEqual(['0.0.0.0']);
    expect(loopbackHosts('192.168.1.5')).toEqual(['192.168.1.5']);
    expect(loopbackHosts('127.0.0.1')).toEqual(['127.0.0.1']);
  });
});

function fixtureSite(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-site-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><head></head><body>home</body>');
  writeFileSync(join(dir, 'app.js'), 'export const x = 1;');
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'index.html'), '<!doctype html><body>nested</body>');
  return dir;
}

const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
});

async function start(opts: Partial<Parameters<typeof startStaticServer>[0]> & { publicDir: string }) {
  const h = await startStaticServer({ port: 0, logger: silentServeLogger(), ...opts });
  handles.push(h);
  return h;
}

describe('resolveStaticFile', () => {
  it('serves files, directory index, and refuses traversal', () => {
    const site = fixtureSite();
    expect(resolveStaticFile(site, '/app.js')).toContain('app.js');
    expect(resolveStaticFile(site, '/nested')).toContain('nested/index.html');
    expect(resolveStaticFile(site, '/../../../etc/passwd')).toBeNull();
    expect(resolveStaticFile(site, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStaticFile(site, '/nested/%E0%A4%A')).toBeNull();
    expect(resolveStaticFile(site, '/missing.js')).toBeNull();
  });
});

describe('static server', () => {
  it('serves files with content types; 404s missing; 405s non-GET', async () => {
    const h = await start({ publicDir: fixtureSite() });
    const index = await fetch(h.url + '/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('home');
    const js = await fetch(h.url + '/app.js');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(h.url + '/nope.js')).status).toBe(404);
    expect((await fetch(h.url + '/', { method: 'POST', body: 'x' })).status).toBe(405);
  });

  it('SPA rewrite serves index.html for extension-less misses when enabled', async () => {
    const site = fixtureSite();
    const on = await start({ publicDir: site, spaRewrite: true });
    expect(await (await fetch(on.url + '/some/route')).text()).toContain('home');
    expect((await fetch(on.url + '/some/asset.png')).status).toBe(404); // extensions never rewrite
    const off = await start({ publicDir: site });
    expect((await fetch(off.url + '/some/route')).status).toBe(404);
  });

  it('transformHtml applies to served HTML only', async () => {
    const h = await start({
      publicDir: fixtureSite(),
      transformHtml: (html) => html.replace('</head>', '<script>/*injected*/</script></head>'),
    });
    expect(await (await fetch(h.url + '/')).text()).toContain('/*injected*/');
    expect(await (await fetch(h.url + '/app.js')).text()).not.toContain('/*injected*/');
  });

  it('namespaceHandler owns /__pyric/* and wins over static', async () => {
    const h = await start({
      publicDir: fixtureSite(),
      namespaceHandler: (_req, res, url) => {
        if (url.pathname === '/__pyric/init.json') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          return true;
        }
        return false;
      },
    });
    const hit = await fetch(h.url + '/__pyric/init.json');
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ ok: true });
    expect((await fetch(h.url + '/__pyric/unknown')).status).toBe(404); // falls through
  });

  it('port scan-forward retries past EADDRINUSE (deterministic fake)', async () => {
    // Real-socket conflict tests are runtime-dependent (bun permits same-port
    // rebinds on macOS; node — the npx production runtime — raises
    // EADDRINUSE). Drive the exported scan logic with a fake listener.
    const { listenWithScan } = await import('../../src/serve/server.js');
    let bound = -1;
    const taken = new Set([5000, 5001]);
    let errCb: ((e: NodeJS.ErrnoException) => void) | null = null;
    const fake = {
      listen(port: number, _host: string, cb: () => void) {
        if (taken.has(port)) {
          queueMicrotask(() => errCb?.(Object.assign(new Error('in use'), { code: 'EADDRINUSE' })));
        } else {
          bound = port;
          queueMicrotask(cb);
        }
        return this;
      },
      once(_e: 'error', cb: (e: NodeJS.ErrnoException) => void) { errCb = cb; return this; },
      removeListener() { errCb = null; return this; },
      address() { return { port: bound }; },
    };
    const port = await listenWithScan(fake, 'localhost', 5000, 10, silentServeLogger());
    expect(port).toBe(5002); // skipped both taken ports
    // and the limit is enforced:
    const all = { ...fake, listen(port: number, _h: string, _cb: () => void) { queueMicrotask(() => errCb?.(Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))); return this; } };
    await expect(listenWithScan(all, 'localhost', 5000, 2, silentServeLogger())).rejects.toThrow();
  });
});

describe('contentTypeFor', () => {
  it('maps common extensions and defaults to octet-stream', () => {
    expect(contentTypeFor('a.wasm')).toBe('application/wasm');
    expect(contentTypeFor('a.weird')).toBe('application/octet-stream');
  });
});

describe('isAllowedHost (DNS-rebinding guard)', () => {
  it('allows loopback hostnames + the bound host, with/without port', () => {
    expect(isAllowedHost('localhost:5000', 'localhost')).toBe(true);
    expect(isAllowedHost('127.0.0.1:8080', 'localhost')).toBe(true);
    expect(isAllowedHost('[::1]:5000', 'localhost')).toBe(true);
    expect(isAllowedHost('0.0.0.0', '0.0.0.0')).toBe(true);
    expect(isAllowedHost('my-box.local', 'my-box.local')).toBe(true); // bound host
    expect(isAllowedHost(undefined, 'localhost')).toBe(true); // non-browser, no Host
  });

  it('rejects a rebinding Host and honors --allowed-host', () => {
    expect(isAllowedHost('attacker.com', 'localhost')).toBe(false);
    expect(isAllowedHost('attacker.com:5000', 'localhost')).toBe(false);
    expect(isAllowedHost('app.test:5000', 'localhost', ['app.test'])).toBe(true);
  });

  it('blocks a forged Host over real HTTP; loopback still 200', async () => {
    const site = fixtureSite();
    const h = await start({ publicDir: site });
    const ok = await fetch(h.url + '/app.js'); // Host: localhost:PORT
    expect(ok.status).toBe(200);
    const blocked = await fetch(h.url + '/app.js', { headers: { host: 'evil.example.com' } });
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toContain('evil.example.com');
  });
});

describe('isAllowedOrigin (WS cross-origin hijack guard)', () => {
  it('allows loopback origins + the bound host + --allowed-host', () => {
    expect(isAllowedOrigin('http://localhost:5000', 'localhost')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8080', 'localhost')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:5173', 'localhost')).toBe(true);
    expect(isAllowedOrigin('http://my-box.local:5000', 'my-box.local')).toBe(true);
    expect(isAllowedOrigin('http://app.test:5000', 'localhost', ['app.test'])).toBe(true);
    expect(isAllowedOrigin(undefined, 'localhost')).toBe(true); // non-browser peer
  });

  it('rejects a cross-origin or malformed Origin', () => {
    expect(isAllowedOrigin('http://attacker.com', 'localhost')).toBe(false);
    expect(isAllowedOrigin('https://attacker.com:5000', 'localhost')).toBe(false);
    expect(isAllowedOrigin('null', 'localhost')).toBe(false); // sandboxed iframe / opaque
    expect(isAllowedOrigin('not a url', 'localhost')).toBe(false);
  });
});

describe('isAllowedUpgrade (combined Host + Origin guard)', () => {
  it('passes only when BOTH Host and Origin are allowlisted', () => {
    expect(isAllowedUpgrade({ host: 'localhost:5000', origin: 'http://localhost:5000' }, 'localhost')).toBe(true);
    // A rebinding Host with an otherwise-fine (absent) Origin still fails.
    expect(isAllowedUpgrade({ host: 'attacker.com:5000' }, 'localhost')).toBe(false);
    // A loopback Host but a cross-origin Origin (the hijack) fails.
    expect(isAllowedUpgrade({ host: 'localhost:5000', origin: 'http://attacker.com' }, 'localhost')).toBe(false);
    // Non-browser peer (no Host, no Origin) is allowed.
    expect(isAllowedUpgrade({}, 'localhost')).toBe(true);
    // --allowed-host threads through to both checks.
    expect(isAllowedUpgrade({ host: 'app.test:5000', origin: 'http://app.test:5000' }, 'localhost', ['app.test'])).toBe(true);
  });
});
