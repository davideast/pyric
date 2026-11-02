/** The hosting plane never serves what production Hosting's default `ignore`
 *  leaves out of a deploy: dot files and directories, `node_modules`, and the
 *  root `firebase.json` (#1779). Pure path decisions first, then the real
 *  static server over raw HTTP request targets, which `fetch` would normalize. */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHostingIgnoredDecodedPath, isHostingIgnoredPathname, isHostingIgnoredRealFile } from '../../src/serve/hosting-ignore.js';
import { resolveHostingFile, silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

describe('isHostingIgnoredPathname', () => {
  const ignored = [
    '/.pyric/state/hosted/state.sqlite',
    '/.pyric',
    '/.pyric/',
    '/.env',
    '/.firebaserc',
    '/.git/config',
    '/assets/.env.local',
    '/a/b/.hidden/file.txt',
    '/node_modules/@pyric/cli/package.json',
    '/web/node_modules/x.js',
    '/firebase.json',
    // Percent-encoded periods and slashes.
    '/%2epyric/state/hosted/state.sqlite',
    '/%2Epyric/state/hosted/state.sqlite',
    '/%2e%70yric/state/hosted/state.sqlite',
    '/assets%2f.pyric%2fstate%2fhosted%2fstate.sqlite',
    '/assets/..%2f.pyric/state/hosted/state.sqlite',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/node%5fmodules/x.js',
    '/firebase%2ejson',
    // Doubled and backslashed separators.
    '//.pyric/state/hosted/state.sqlite',
    '/assets//.pyric//state',
    '/assets\\.pyric\\state',
    '/assets%5c.pyric%5cstate',
    '/assets%5cindex.html',
    // Case variants a case-insensitive disk opens as the ignored name.
    '/NODE_MODULES/x.js',
    '/Node_Modules/x.js',
    '/FIREBASE.JSON',
    '/Firebase.json',
    // Malformed escapes and NUL fail closed.
    '/%E0%A4%A',
    '/%',
    '/index.html%00.js',
    // Names Windows opens as another entry: a trailing period or space, an
    // alternate data stream, and an 8.3 short name.
    '/node_modules./x.js',
    '/firebase.json.',
    '/firebase.json%20',
    '/assets./app.js',
    '/firebase.json::$DATA',
    '/index.html:stream',
    '/PYRIC~1/state/hosted/state.sqlite',
    '/NODE_M~1/x.js',
    '/assets/FIREBA~1.JSO',
  ];
  for (const pathname of ignored) {
    it(`ignores ${pathname}`, () => {
      expect(isHostingIgnoredPathname(pathname)).toBe(true);
    });
  }

  const served = [
    '/',
    '/index.html',
    '/assets/app.js',
    '/nested/',
    '/a.b/c.d',
    '/pyric/state.json',
    '/assets/firebase.json',
    '/node_modules_backup/x.js',
    '/my.node_modules/x.js',
    '/%252epyric/state',
    '/files/report%20final.pdf',
    '/assets/app~x/x.js',
    '/assets/longername~1/x.js',
  ];
  for (const pathname of served) {
    it(`serves ${pathname}`, () => {
      expect(isHostingIgnoredPathname(pathname)).toBe(false);
    });
  }

  it('checks decoded paths by segment', () => {
    expect(isHostingIgnoredDecodedPath('/assets/.well-known/x')).toBe(true);
    expect(isHostingIgnoredDecodedPath('/assets/well-known/x')).toBe(false);
    expect(isHostingIgnoredDecodedPath('')).toBe(false);
  });
});

/** A project served as its own hosting root, the shape a project with no `hosting` block gets. */
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-hosting-ignore-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><head></head><body>home</body>');
  writeFileSync(join(dir, 'firebase.json'), '{}');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  mkdirSync(join(dir, '.pyric', 'state', 'hosted'), { recursive: true });
  writeFileSync(join(dir, '.pyric', 'state', 'hosted', 'state.sqlite'), 'users and data');
  mkdirSync(join(dir, '.pyric', 'site'), { recursive: true });
  writeFileSync(join(dir, '.pyric', 'site', 'index.html'), '<!doctype html><body>hidden index</body>');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'export {};');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'export const x = 1;');
  return dir;
}

describe('resolveHostingFile', () => {
  it('resolves served files and refuses ignored ones', () => {
    const root = projectRoot();
    expect(resolveHostingFile(root, '/assets/app.js')).toContain('app.js');
    expect(resolveHostingFile(root, '/')).toContain('index.html');
    expect(resolveHostingFile(root, '/.pyric/state/hosted/state.sqlite')).toBeNull();
    expect(resolveHostingFile(root, '/%2epyric/site')).toBeNull();
    expect(resolveHostingFile(root, '/node_modules/pkg/index.js')).toBeNull();
    expect(resolveHostingFile(root, '/firebase.json')).toBeNull();
    expect(resolveHostingFile(root, '/.env')).toBeNull();
  });

  it('refuses a symlink in the public directory that resolves to an ignored path', () => {
    const root = projectRoot();
    symlinkSync(join(root, '.pyric', 'state'), join(root, 'data'));
    symlinkSync(join(root, '.env'), join(root, 'env.txt'));
    symlinkSync(join(root, 'node_modules', 'pkg', 'index.js'), join(root, 'assets', 'pkg.js'));
    expect(resolveHostingFile(root, '/data/hosted/state.sqlite')).toBeNull();
    expect(resolveHostingFile(root, '/env.txt')).toBeNull();
    expect(resolveHostingFile(root, '/assets/pkg.js')).toBeNull();
  });

  it('refuses a symlink that leaves the public directory, and keeps one that stays inside', () => {
    const root = projectRoot();
    const outside = mkdtempSync(join(tmpdir(), 'pyric-hosting-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secret.txt'));
    symlinkSync(join(root, 'assets'), join(root, 'static'));
    expect(resolveHostingFile(root, '/secret.txt')).toBeNull();
    expect(resolveHostingFile(root, '/static/app.js')).toContain('app.js');
  });

  it('checks real paths against a public directory reached through a symlink', () => {
    const root = projectRoot();
    const linkedRoot = join(mkdtempSync(join(tmpdir(), 'pyric-hosting-link-')), 'site');
    symlinkSync(root, linkedRoot);
    expect(resolveHostingFile(linkedRoot, '/assets/app.js')).toContain('app.js');
    expect(isHostingIgnoredRealFile(linkedRoot, join(linkedRoot, '.pyric', 'state', 'hosted', 'state.sqlite'))).toBe(true);
    expect(isHostingIgnoredRealFile(linkedRoot, join(linkedRoot, 'missing.js'))).toBe(true);
  });
});

const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
});

/** Send `target` as the raw request target, so no client normalizes it first. */
function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method: 'GET', headers: { host: 'localhost' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static server over a project root', () => {
  const refused = [
    '/.pyric/state/hosted/state.sqlite',
    '/%2epyric/state/hosted/state.sqlite',
    '/%2Epyric/state/hosted/state.sqlite',
    '//.pyric/state/hosted/state.sqlite',
    '/assets/..%2f.pyric/state/hosted/state.sqlite',
    '/assets/../.pyric/state/hosted/state.sqlite',
    '/assets/%2e%2e/.pyric/state/hosted/state.sqlite',
    '/.pyric/site/',
    '/.env',
    '/node_modules/pkg/index.js',
    '/firebase.json',
  ];

  for (const target of refused) {
    it(`answers 404 for ${target}`, async () => {
      const h = await startStaticServer({ publicDir: projectRoot(), port: 0, host: '127.0.0.1', logger: silentServeLogger() });
      handles.push(h);
      const response = await rawGet(h.port, target);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain('users and data');
    });
  }

  it('answers 404 for state reached through a symlink in the public directory', async () => {
    const root = projectRoot();
    symlinkSync(join(root, '.pyric', 'state'), join(root, 'data'));
    const h = await startStaticServer({ publicDir: root, port: 0, host: '127.0.0.1', logger: silentServeLogger() });
    handles.push(h);
    const response = await rawGet(h.port, '/data/hosted/state.sqlite');
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('users and data');
  });

  it('serves no static file at all with no public directory', async () => {
    const h = await startStaticServer({ publicDir: null, port: 0, host: '127.0.0.1', logger: silentServeLogger() });
    handles.push(h);
    expect((await rawGet(h.port, '/index.html')).status).toBe(404);
    expect((await rawGet(h.port, '/.pyric/state/hosted/state.sqlite')).status).toBe(404);
  });

  it('still serves the project files production would deploy', async () => {
    const h = await startStaticServer({ publicDir: projectRoot(), port: 0, host: '127.0.0.1', logger: silentServeLogger() });
    handles.push(h);
    expect((await rawGet(h.port, '/assets/app.js')).status).toBe(200);
    expect((await rawGet(h.port, '/')).body).toContain('home');
  });

  it('falls back to index.html, never the ignored file, under the SPA rewrite', async () => {
    const h = await startStaticServer({ publicDir: projectRoot(), port: 0, host: '127.0.0.1', spaRewrite: true, logger: silentServeLogger() });
    handles.push(h);
    const response = await rawGet(h.port, '/.pyric/site');
    expect(response.body).toContain('home');
    expect(response.body).not.toContain('hidden index');
    expect((await rawGet(h.port, '/.pyric/state/hosted/state.sqlite')).status).toBe(404);
  });
});
