import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runServeDiagnostics } from '../../src/cli/serve-diagnostics.js';
import { discoverServe, readProjectPointer } from '../../src/serve/discovery.js';
import { liveHostProjectRoot, probeLiveHostUrl } from '../../src/serve/live-host.js';
import {
  resolveSessionTokenForTarget,
  writeMode600FileSync,
  writeOwnedSessionFile,
} from '../../src/serve/local-session-token.js';

const LIVE_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'live');

const tempDirs: string[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  while (httpServers.length > 0) {
    const srv = httpServers.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('session token port scoping, symlink containment, and workspace boundary parity', () => {
  it('suppresses PYRIC_SESSION_TOKEN on mismatched ports across boundHostUrl, disk pointer mismatch, PYRIC_SANDBOX=remote:<url>, PYRIC_SANDBOX_PORT, PYRIC_WORKER_INIT_HOST, and bare PYRIC_SANDBOX=remote (with or without disk pointer)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-session-port-scope-'));
    tempDirs.push(root);
    const emptyDir = mkdtempSync(join(tmpdir(), 'pyric-session-empty-'));
    tempDirs.push(emptyDir);
    mkdirSync(join(root, '.pyric'), { recursive: true });
    writeFileSync(
      join(root, '.pyric', 'serve.json'),
      JSON.stringify({
        pid: process.pid,
        port: 4111,
        url: 'http://127.0.0.1:4111',
        token: 'DISK_POINTER_4111_TOKEN',
      }),
    );

    // Matching port 4111 resolves token cleanly via explicit boundHostUrl.
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:4111',
        boundHostUrl: 'http://127.0.0.1:4111',
        env: {
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBe('ENV_ONLY_SECRET_TOKEN');

    // Mismatched port under explicit boundHostUrl (distinct envToken, empty cwd so tokenMismatchedOnDisk is false).
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:5999',
        boundHostUrl: 'http://127.0.0.1:4111',
        env: {
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBeUndefined();

    // Disk pointer on port 4111 holding the same token suppresses PYRIC_SESSION_TOKEN on port 5999 even with no env host.
    expect(
      resolveSessionTokenForTarget({
        cwd: root,
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_SESSION_TOKEN: 'DISK_POINTER_4111_TOKEN',
        },
      }),
    ).toBeUndefined();

    // Mismatched port under PYRIC_SANDBOX=remote:<url>.
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_SANDBOX: 'remote:http://127.0.0.1:4111',
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBeUndefined();

    // Mismatched port under PYRIC_SANDBOX_PORT.
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_SANDBOX: 'remote',
          PYRIC_SANDBOX_PORT: '4111',
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBeUndefined();

    // Mismatched port under PYRIC_WORKER_INIT_HOST.
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_WORKER_INIT_HOST: 'http://127.0.0.1:4111',
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBeUndefined();

    // Bare PYRIC_SANDBOX=remote with distinct envToken vs disk pointer on port 4111 rejects port 5999.
    expect(
      resolveSessionTokenForTarget({
        cwd: root,
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_SANDBOX: 'remote',
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBeUndefined();

    // Bare PYRIC_SANDBOX=remote with empty cwd (no disk pointer) or omitted cwd fails closed rather than leaking.
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_SANDBOX: 'remote',
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBeUndefined();
    expect(
      resolveSessionTokenForTarget({
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_SANDBOX: 'remote',
          PYRIC_SESSION_TOKEN: 'ENV_ONLY_SECRET_TOKEN',
        },
      }),
    ).toBeUndefined();

    // Matching port under PYRIC_SANDBOX=remote + PYRIC_SANDBOX_PORT without disk pointer succeeds.
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:4111',
        env: {
          PYRIC_SANDBOX: 'remote',
          PYRIC_SANDBOX_PORT: '4111',
          PYRIC_SESSION_TOKEN: 'SANDBOX_PORT_4111_TOKEN',
        },
      }),
    ).toBe('SANDBOX_PORT_4111_TOKEN');

    // Non-loopback or unparseable host bindings fail closed rather than leaking PYRIC_SESSION_TOKEN.
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:5999',
        boundHostUrl: 'https://remote.example:4111',
        env: {
          PYRIC_SESSION_TOKEN: 'NON_LOOPBACK_ENV_TOKEN',
        },
      }),
    ).toBeUndefined();
    expect(
      resolveSessionTokenForTarget({
        cwd: emptyDir,
        url: 'http://127.0.0.1:5999',
        env: {
          PYRIC_SANDBOX_PORT: 'not-a-port',
          PYRIC_SESSION_TOKEN: 'INVALID_PORT_ENV_TOKEN',
        },
      }),
    ).toBeUndefined();
  });

  it('refuses writing session token files through existing, dangling, nested, or ancestor symlinked directories while still replacing a leaf symlink atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-symlink-dir-'));
    tempDirs.push(root);
    const externalDir = join(root, 'external-target');
    const projectDir = join(root, 'project-with-symlink');
    mkdirSync(externalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    symlinkSync(externalDir, join(projectDir, '.pyric'), 'dir');

    expect(() =>
      writeMode600FileSync(join(projectDir, '.pyric', 'serve.json'), '{"token":"secret"}\n'),
    ).toThrow(/symbolic link/i);
    const cleanup = writeOwnedSessionFile(projectDir, { port: 4111, token: 'secret-session' });
    cleanup();
    expect(existsSync(join(externalDir, 'serve.json'))).toBe(false);
    expect(existsSync(join(externalDir, 'session.json'))).toBe(false);

    // Dangling .pyric symlink is also rejected without creating the external target.
    const danglingTarget = join(root, 'dangling-external');
    const danglingProject = join(root, 'project-dangling-symlink');
    mkdirSync(danglingProject, { recursive: true });
    symlinkSync(danglingTarget, join(danglingProject, '.pyric'), 'dir');
    expect(() =>
      writeMode600FileSync(join(danglingProject, '.pyric', 'serve.json'), '{"token":"secret"}\n'),
    ).toThrow(/symbolic link/i);
    expect(existsSync(danglingTarget)).toBe(false);

    // Nested symlinked subdirectory under .pyric is rejected as well.
    const nestedProject = join(root, 'project-nested-symlink');
    mkdirSync(join(nestedProject, '.pyric'), { recursive: true });
    symlinkSync(externalDir, join(nestedProject, '.pyric', 'nested'), 'dir');
    expect(() =>
      writeMode600FileSync(join(nestedProject, '.pyric', 'nested', 'serve.json'), '{"token":"secret"}\n'),
    ).toThrow(/symbolic link/i);
    expect(existsSync(join(externalDir, 'serve.json'))).toBe(false);

    // Intermediate symlinked directory above a missing leaf directory (even without a .pyric segment) is rejected.
    const linkedParent = join(root, 'linked-parent');
    symlinkSync(externalDir, linkedParent, 'dir');
    expect(() =>
      writeMode600FileSync(join(linkedParent, 'missing-child', 'token.json'), '{"token":"secret"}\n'),
    ).toThrow(/symbolic link/i);
    expect(existsSync(join(externalDir, 'missing-child'))).toBe(false);

    // Leaf symlink inside a real .pyric directory is still atomically replaced without touching its target.
    const realProjectDir = join(root, 'project-real');
    mkdirSync(join(realProjectDir, '.pyric'), { recursive: true });
    const untouchedTarget = join(externalDir, 'keep.txt');
    writeFileSync(untouchedTarget, 'DO_NOT_OVERWRITE');
    const leafPath = join(realProjectDir, '.pyric', 'serve.json');
    symlinkSync(untouchedTarget, leafPath);

    writeMode600FileSync(leafPath, '{"token":"atomic-ok"}\n');
    expect(readFileSync(untouchedTarget, 'utf8')).toBe('DO_NOT_OVERWRITE');
    expect(lstatSync(leafPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(leafPath, 'utf8')).toContain('atomic-ok');
  });

  it('stops pointer and live-host discovery at .git / firebase.json / pyric.json boundaries while resolving workspace tokens from subpackages in pyric.json monorepos', async () => {
    const reposRoot = mkdtempSync(join(tmpdir(), 'pyric-sibling-repos-'));
    tempDirs.push(reposRoot);
    const siblingWeb = join(reposRoot, 'web');
    const otherRepo = join(reposRoot, 'other-repo');
    mkdirSync(join(siblingWeb, '.pyric'), { recursive: true });
    mkdirSync(join(otherRepo, '.git'), { recursive: true });
    writeFileSync(join(otherRepo, 'firebase.json'), '{}\n');

    const seenHeaders: Array<string | undefined> = [];
    const mockHost = createServer((req, res) => {
      if (req.url === '/__pyric/health') {
        seenHeaders.push(req.headers['x-pyric-session-token'] as string | undefined);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'sandbox', instanceId: 'inst-sibling' }));
        return;
      }
      if (req.url === '/__pyric/diagnostics') {
        seenHeaders.push(req.headers['x-pyric-session-token'] as string | undefined);
        if (req.headers['x-pyric-session-token'] !== 'SIBLING_WEB_TOKEN') {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: 1, server: { http: 'responding' }, clients: [] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockHost.listen(0, '127.0.0.1', resolve));
    httpServers.push(mockHost);
    const hostPort = (mockHost.address() as AddressInfo).port;
    const hostUrl = `http://127.0.0.1:${hostPort}`;

    writeFileSync(
      join(siblingWeb, '.pyric', 'serve.json'),
      JSON.stringify({
        pid: process.pid,
        port: hostPort,
        url: hostUrl,
        instanceId: 'inst-sibling',
        token: 'SIBLING_WEB_TOKEN',
      }),
    );

    expect(readProjectPointer(otherRepo)).toBeNull();
    expect(await discoverServe(otherRepo, () => {}, [])).toBeNull();
    expect(resolveSessionTokenForTarget({ cwd: otherRepo, url: hostUrl, env: {} })).toBeUndefined();
    let otherDiagOut = '';
    const otherDiagCode = await runServeDiagnostics(parseArgs(['serve', 'diagnostics']), {
      cwd: otherRepo,
      stdout: { write: (chunk) => { otherDiagOut += chunk; } },
    });
    expect(otherDiagCode).toBe(2);
    expect(otherDiagOut).toContain('"http": "unknown"');

    // Monorepo configured with pyric.json resolves workspace token from packages/api,
    // while a standalone nested git repo inside that monorepo never climbs past its own .git!
    const monorepoRoot = join(reposRoot, 'monorepo');
    const childPkg = join(monorepoRoot, 'packages', 'api');
    const appsWeb = join(monorepoRoot, 'apps', 'web');
    const nestedGitRepo = join(monorepoRoot, 'nested-git');
    mkdirSync(join(monorepoRoot, '.pyric'), { recursive: true });
    mkdirSync(join(appsWeb, '.pyric'), { recursive: true });
    mkdirSync(childPkg, { recursive: true });
    mkdirSync(join(nestedGitRepo, '.git'), { recursive: true });
    writeFileSync(join(monorepoRoot, 'pyric.json'), JSON.stringify({ sessionToken: true }));
    writeFileSync(join(childPkg, 'package.json'), JSON.stringify({ name: '@org/api', private: true }));
    writeFileSync(
      join(monorepoRoot, '.pyric', 'serve.json'),
      JSON.stringify({
        pid: process.pid,
        port: hostPort,
        url: hostUrl,
        instanceId: 'inst-sibling',
        token: 'SIBLING_WEB_TOKEN',
      }),
    );
    writeFileSync(
      join(appsWeb, '.pyric', 'serve.json'),
      JSON.stringify({
        pid: process.pid,
        port: hostPort,
        url: hostUrl,
        instanceId: 'inst-sibling',
        token: 'OUTER_LIVE_WEB_TOKEN',
      }),
    );

    expect(liveHostProjectRoot(nestedGitRepo)).toBe(nestedGitRepo);
    seenHeaders.length = 0;
    await probeLiveHostUrl(hostUrl, nestedGitRepo, { liveRoot: LIVE_PKG_ROOT, env: {} });
    expect(seenHeaders).not.toContain('OUTER_LIVE_WEB_TOKEN');
    expect(seenHeaders).not.toContain('SIBLING_WEB_TOKEN');

    expect(resolveSessionTokenForTarget({ cwd: childPkg, url: hostUrl, env: {} })).toBe('SIBLING_WEB_TOKEN');
    const discoveredFromChild = await discoverServe(childPkg, () => {}, []);
    expect(discoveredFromChild?.token).toBe('SIBLING_WEB_TOKEN');

    let diagOut = '';
    const exitCode = await runServeDiagnostics(parseArgs(['serve', 'diagnostics', '--url', hostUrl]), {
      cwd: childPkg,
      stdout: { write: (chunk) => { diagOut += chunk; } },
    });
    expect(exitCode).toBe(0);
    expect(diagOut).toContain('"http": "responding"');
  });
});
