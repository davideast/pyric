import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DependencyStore, type RunNpm } from './dependency-store.ts';
import {
  debugLogTail,
  isTransientNetworkFailure,
  NESTED_INSTALL_ATTEMPT_MS,
  NESTED_SCENARIO_TIMEOUT_MS,
  npmInstall,
  npmInstallArgs,
  retryOnceOnTimeout,
  runCommand,
  runTimedCommand,
  shouldRetryOnline,
  type CommandResult,
  type TimedResult,
} from './install.ts';
import { dependencySetKey, SharedInstalls } from './shared-installs.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-install-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ETARGET_OUTPUT = 'npm error code ETARGET\nnpm error notarget No matching version found for caniuse-lite@^1.0.30001819.\n';

describe('the retry after stale npm metadata', () => {
  test('an install that fails with ETARGET or ENOVERSIONS is retried online', () => {
    expect(shouldRetryOnline({ code: 1, output: ETARGET_OUTPUT })).toBe(true);
    expect(shouldRetryOnline({ code: 1, output: 'npm ERR! code ENOVERSIONS\nnpm ERR! No versions available for caniuse-lite\n' })).toBe(true);
  });

  test('any other failure, and a success, is not', () => {
    expect(shouldRetryOnline({ code: 1, output: 'npm error code E404\nnpm error 404 Not Found\n' })).toBe(false);
    expect(shouldRetryOnline({ code: 1, output: 'npm error code ECONNRESET\n' })).toBe(false);
    expect(shouldRetryOnline({ code: 0, output: 'mentions code ETARGET in a warning\n' })).toBe(false);
  });

  test('npmInstall retries once with --prefer-online and reports the retry (#1485)', async () => {
    const calls: string[][] = [];
    const reported: string[] = [];
    const results: CommandResult[] = [{ code: 1, output: ETARGET_OUTPUT }, { code: 0, output: 'added 205 packages\n' }];
    const result = await npmInstall('/cache', async (args) => {
      calls.push(args);
      return results.shift() ?? { code: 1, output: 'called too often' };
    }, undefined, { report: (line) => reported.push(line) });
    expect(calls).toEqual([npmInstallArgs('/cache'), npmInstallArgs('/cache', 'online')]);
    expect(calls[1]).toContain('--prefer-online');
    expect(calls[1]).not.toContain('--prefer-offline');
    expect(result.code).toBe(0);
    expect(result.output).toContain(ETARGET_OUTPUT);
    expect(result.output).toContain('retrying once with --prefer-online');
    expect(result.output).toContain('added 205 packages');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^\[runner\] retried npm install with --prefer-online after stale cached metadata \(exit 1\), \d+\.\d s$/);
  });

  test('npmInstall does not retry or report a failure that stale metadata does not explain', async () => {
    let calls = 0;
    const reported: string[] = [];
    const result = await npmInstall('/cache', async () => {
      calls += 1;
      return { code: 1, output: 'npm error code E404\n' };
    }, undefined, { report: (line) => reported.push(line) });
    expect({ calls, code: result.code, reported }).toEqual({ calls: 1, code: 1, reported: [] });
  });
});

/** Builds a minimal gzipped ustar tarball holding `package/package.json` for a local stand-in registry. */
function minimalTarball(name: string, version: string): Buffer {
  const body = Buffer.from(`${JSON.stringify({ name, version })}\n`, 'utf8');
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]));
}

describe('the bounded retry after a transient npm network failure', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('recognizes dropped sockets and 5xx registry failures, not bad dependencies or timeouts', () => {
    const transient = ['npm error code ECONNRESET\n', 'npm error errno ETIMEDOUT\n', 'npm error code EAI_AGAIN\n', 'npm error code E503\n', 'npm error network request failed, reason: socket hang up\n'];
    for (const output of transient) expect(isTransientNetworkFailure({ code: 1, output })).toBe(true);
    expect(isTransientNetworkFailure({ code: 1, output: 'npm error code E404\n404 Not Found\n' })).toBe(false);
    expect(isTransientNetworkFailure({ code: 1, output: ETARGET_OUTPUT })).toBe(false);
    expect(isTransientNetworkFailure({ code: 1, output: 'npm error code ERESOLVE\n' })).toBe(false);
    expect(isTransientNetworkFailure({ code: 0, output: 'warn ECONNRESET\n' })).toBe(false);
    expect(isTransientNetworkFailure({ code: null, output: 'npm error code ECONNRESET\n', timedOut: true })).toBe(false);
  });

  test('npmInstall retries once on ECONNRESET, reports the retry (#1485), stops after two attempts, and never retries E404', async () => {
    const recovered: CommandResult[] = [{ code: 1, output: 'npm error code ECONNRESET\n' }, { code: 0, output: 'added 1 package\n' }];
    const reported: string[] = [];
    let calls = 0;
    const ok = await npmInstall('/cache', async () => {
      calls += 1;
      return recovered.shift() ?? { code: 1, output: 'called too often' };
    }, undefined, { networkRetryDelayMs: 0, report: (line) => reported.push(line) });
    expect(calls).toBe(2);
    expect(ok.code).toBe(0);
    expect(ok.output).toContain('npm error code ECONNRESET');
    expect(ok.output).toContain('infrastructure retry: npm install hit a transient network error');
    expect(ok.output).toContain('added 1 package');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^\[runner\] infrastructure retry: retried npm install after transient network error \(exit 1\), \d+\.\d s$/);

    let persistentCalls = 0;
    const failed = await npmInstall('/cache', async () => {
      persistentCalls += 1;
      return { code: 1, output: `attempt ${persistentCalls}: npm error code ECONNRESET\n` };
    }, undefined, { networkRetryDelayMs: 0 });
    expect(persistentCalls).toBe(2);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain('attempt 1: npm error code ECONNRESET');
    expect(failed.output).toContain('attempt 2: npm error code ECONNRESET');

    let badDepCalls = 0;
    const badDep = await npmInstall('/cache', async () => {
      badDepCalls += 1;
      return { code: 1, output: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.example/missing-pkg\n' };
    }, undefined, { networkRetryDelayMs: 0 });
    expect(badDepCalls).toBe(1);
    expect(badDep.code).toBe(1);
    expect(badDep.output).toContain('npm error code E404');
  });

  test('real npm recovers when a local registry resets the first connection, and still fails once on a missing package', async () => {
    const tgz = minimalTarball('demo-pkg', '1.0.0');
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    let dropFirst = true;
    const server = createServer((req, res) => {
      if (req.url === '/demo-pkg' && dropFirst) {
        dropFirst = false;
        req.socket.destroy();
        return;
      }
      if (req.url === '/demo-pkg') {
        const port = (server.address() as AddressInfo).port;
        const doc = {
          name: 'demo-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'demo-pkg',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/demo-pkg-1.0.0.tgz`, integrity },
            },
          },
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
        return;
      }
      if (req.url === '/demo-pkg-1.0.0.tgz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tgz);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const okDir = join(tempDir(), 'ok-app');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(join(okDir, 'package.json'), JSON.stringify({ name: 'ok-app', private: true, dependencies: { 'demo-pkg': '1.0.0' } }));
    let okCalls = 0;
    const okResult = await npmInstall(join(tempDir(), 'cache-ok'), (args) => {
      okCalls += 1;
      return runCommand('npm', [...args, `--registry=${registry}`, '--fetch-retries=0'], { cwd: okDir });
    }, undefined, { networkRetryDelayMs: 0 });
    expect(okCalls).toBe(2);
    expect(okResult.code).toBe(0);
    expect(okResult.output).toContain('ECONNRESET');
    expect(existsSync(join(okDir, 'node_modules/demo-pkg/package.json'))).toBe(true);

    const badDir = join(tempDir(), 'bad-app');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'package.json'), JSON.stringify({ name: 'bad-app', private: true, dependencies: { 'missing-pkg': '1.0.0' } }));
    let badCalls = 0;
    const badResult = await npmInstall(join(tempDir(), 'cache-bad'), (args) => {
      badCalls += 1;
      return runCommand('npm', [...args, `--registry=${registry}`, '--fetch-retries=0'], { cwd: badDir });
    }, undefined, { networkRetryDelayMs: 0 });
    expect(badCalls).toBe(1);
    expect(badResult.code).toBe(1);
    expect(badResult.output).toContain('E404');
  }, 30_000);
});

describe('the infrastructure retry of a nested install that hangs (#1476)', () => {
  const timedOut = (output: string): TimedResult => ({ code: null, output, timedOut: true });
  const finished = (code: number, output: string): TimedResult => ({ code, output, timedOut: false });

  async function retried(results: TimedResult[]) {
    const lines: string[] = [];
    let attempts = 0;
    let resets = 0;
    const result = await retryOnceOnTimeout(
      async () => {
        attempts += 1;
        return results.shift() ?? finished(1, 'called too often');
      },
      { what: 'chat: npm install in my-chat', reset: async () => { resets += 1; }, report: (line) => lines.push(line) },
    );
    return { result, lines, attempts, resets };
  }

  test('an attempt that finishes runs once and prints one line, so every run can be counted', async () => {
    const { result, lines, attempts, resets } = await retried([finished(0, 'added 412 packages\n')]);
    expect(attempts).toBe(1);
    expect(resets).toBe(0);
    expect(result).toEqual(finished(0, 'added 412 packages\n'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[runner\] chat: npm install in my-chat exited 0 in \d+ s, 1 attempt$/);
  });

  test('a failed attempt is never retried, whatever its exit code', async () => {
    const { result, lines, attempts } = await retried([finished(1, 'npm error code E404\n')]);
    expect(attempts).toBe(1);
    expect(result.code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('exited 1');
    expect(lines[0]).not.toContain('retry');
  });

  test('an attempt that times out is reset and tried once more, and both are printed as an infrastructure retry', async () => {
    const { result, lines, attempts, resets } = await retried([timedOut('stalled\n'), finished(0, 'added 412 packages\n')]);
    expect(attempts).toBe(2);
    expect(resets).toBe(1);
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('stalled\n');
    expect(result.output).toContain('[runner] infrastructure retry');
    expect(result.output).toContain('added 412 packages\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[runner\] infrastructure retry: chat: npm install in my-chat timed out after \d+ s; trying it once more$/);
    expect(lines[1]).toMatch(/^\[runner\] chat: npm install in my-chat exited 0 in \d+ s, 2 attempts \(1 infrastructure retry\)$/);
  });

  test('a second timeout is not retried again, and the result says it timed out', async () => {
    const { result, lines, attempts } = await retried([timedOut('stalled\n'), timedOut('stalled again\n'), finished(0, 'never')]);
    expect(attempts).toBe(2);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain('stalled again\n');
    expect(lines[1]).toContain('timed out in');
    expect(lines[1]).toContain('2 attempts (1 infrastructure retry)');
  });

  test('npmInstall keeps the timeout flag of the attempt it returns', async () => {
    const result = await npmInstall('/cache', async () => timedOut('stalled\n'));
    expect(result.timedOut).toBe(true);
  });

  test('the nested install has its own debug log directory and a fetch timeout below the attempt limit', () => {
    const args = npmInstallArgs('/cache', 'offline', '/logs');
    expect(args).toContain('--logs-dir=/logs');
    expect(args).toContain('--progress=false');
    expect(args).toContain('--update-notifier=false');
    const fetchTimeout = Number(args.find((arg) => arg.startsWith('--fetch-timeout='))?.split('=')[1]);
    expect(fetchTimeout).toBeGreaterThan(0);
    expect(fetchTimeout).toBeLessThan(NESTED_INSTALL_ATTEMPT_MS);
    expect(NESTED_INSTALL_ATTEMPT_MS).toBe(180_000);
    expect(NESTED_SCENARIO_TIMEOUT_MS).toBe(450_000);
    expect(2 * NESTED_INSTALL_ATTEMPT_MS).toBeLessThan(NESTED_SCENARIO_TIMEOUT_MS);
    expect(npmInstallArgs('/cache').some((arg) => arg.startsWith('--logs-dir'))).toBe(false);
  });

  test('the end of the newest npm debug log is read, and no log reads as a note', () => {
    const logs = tempDir();
    expect(debugLogTail(join(logs, 'missing'), 3)).toContain('no npm debug log');
    writeFileSync(join(logs, '2026-10-28T12_00_00_000Z-debug-0.log'), 'old 1\nold 2\n');
    const lines = Array.from({ length: 10 }, (_, index) => `${index} silly fetch manifest pkg-${index}`);
    writeFileSync(join(logs, '2026-10-28T12_05_00_000Z-debug-0.log'), `${lines.join('\n')}\n`);
    const tail = debugLogTail(logs, 3);
    expect(tail).toContain('2026-10-28T12_05_00_000Z-debug-0.log');
    expect(tail).toContain('9 silly fetch manifest pkg-9');
    expect(tail).toContain('7 silly fetch manifest pkg-7');
    expect(tail).not.toContain('6 silly');
    expect(tail).not.toContain('old');
  });

  test('startTimeoutAfter holds the timeout clock until a stand-in finishes setup or exits (#2853)', async () => {
    const work = tempDir();
    const waitForReadyLine = (child: ChildProcess) => new Promise<void>((resolve) => {
      let seen = '';
      const done = () => {
        child.stdout?.off('data', onData);
        child.off('close', done);
        child.off('error', done);
        resolve();
      };
      const onData = (chunk: unknown) => {
        seen += String(chunk);
        if (seen.includes('ready\n')) done();
      };
      child.stdout?.on('data', onData);
      child.once('close', done);
      child.once('error', done);
    });

    const hung = await runTimedCommand(
      'sh',
      ['-c', 'sleep 0.15; printf "log-ready\\n" > debug.log; printf "ready\\n"; sleep 10'],
      { cwd: work, env: { PATH: process.env.PATH }, timeoutMs: 50, startTimeoutAfter: waitForReadyLine },
    );
    expect(hung.timedOut).toBe(true);
    expect(readFileSync(join(work, 'debug.log'), 'utf8')).toBe('log-ready\n');

    const passed = await runTimedCommand(
      'sh',
      ['-c', 'sleep 0.15; printf "done\\n"'],
      { cwd: work, env: { PATH: process.env.PATH }, timeoutMs: 50, startTimeoutAfter: waitForReadyLine },
    );
    expect(passed).toEqual({ code: 0, output: 'done\n', timedOut: false });
  });
});

describe('dependency sets', () => {
  const manifest = (fields: Record<string, unknown>) => JSON.stringify({ private: true, type: 'module', ...fields });

  test('apps that install the same packages under the same project name share a set, whatever else their manifests hold', () => {
    const cli = 'file:/work/dist/packages/pyric-cli-0.1.0-alpha.28.tgz';
    const a = dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { vite: '7.3.2', '@pyric/cli': cli }, overrides: { '@pyric/cli': cli }, scripts: { dev: 'vite' } }) });
    const b = dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { '@pyric/cli': cli, vite: '7.3.2' }, overrides: { '@pyric/cli': cli } }) });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  test('a different version, dev dependency, override or .npmrc is a different set', () => {
    const base = { dependencies: { vite: '7.3.2' } };
    const key = dependencySetKey({ name: 'app', manifest: manifest(base) });
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { vite: '7.3.1' } }) })).not.toBe(key);
    expect(dependencySetKey({ name: 'app', manifest: manifest({ ...base, devDependencies: { typescript: '5.9.3' } }) })).not.toBe(key);
    expect(dependencySetKey({ name: 'app', manifest: manifest({ ...base, overrides: { esbuild: '0.25.0' } }) })).not.toBe(key);
    expect(dependencySetKey({ name: 'app', manifest: manifest(base), npmrc: 'registry=https://example.test/\n' })).not.toBe(key);
    expect(dependencySetKey({ name: 'my-app', manifest: manifest(base) })).not.toBe(key);
  });

  test('an app whose install runs its own scripts, depends on a path, or ships a lockfile installs alone', () => {
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { vite: '7.3.2' }, scripts: { postinstall: 'node setup.js' } }) })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ workspaces: ['server'] }) })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { server: 'file:./server' } }) })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { shared: 'file:../shared' } }) })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { lib: 'link:lib' } }) })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { shared: '../shared' } }) })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { tools: 'file:/work/tools' } }) })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ overrides: { vite: { esbuild: 'file:./vendor/esbuild' } } }) })).toBeUndefined();
    for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish', 'dependencies']) {
      expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { vite: '7.3.2' }, scripts: { [script]: 'node setup.js' } }) })).toBeUndefined();
    }
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { vite: '7.3.2' } }), lockfile: true })).toBeUndefined();
    expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { vite: '7.3.2' } }), bindingGyp: true })).toBeUndefined();
    for (const field of ['peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'engines', 'os', 'cpu']) {
      expect(dependencySetKey({ name: 'app', manifest: manifest({ dependencies: { vite: '7.3.2' }, [field]: {} }) })).toBeUndefined();
    }
  });
});

describe('one install per dependency set', () => {
  /** An app prepared the way the runner prepares one: <work dir>/app, its package.json without a name. */
  function appDir(name: string, dependencies: Record<string, string>): string {
    const dir = join(tempDir(), name, 'app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies }));
    return dir;
  }

  test('apps with the same set install once, even when they ask at the same time, and each gets the tree', async () => {
    const installs: string[] = [];
    const reported: string[] = [];
    const shared = new SharedInstalls(tempDir(), async (cwd) => {
      installs.push(cwd);
      await new Promise((resolve) => setTimeout(resolve, 10));
      mkdirSync(join(cwd, 'node_modules/vite'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules/vite/package.json'), '{"name":"vite"}');
      writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3}');
      return { code: 0, output: 'added 1 package\n' };
    }, { report: (line) => reported.push(line) });
    const apps = ['one', 'two', 'three'].map((name) => appDir(name, { vite: '7.3.2' }));
    const results = await Promise.all(apps.map((dir) => shared.install(dir)));
    expect(installs).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^\[runner\] dependency set [0-9a-f]{16}: installed in place, \d+\.\d s$/);
    for (const [index, dir] of apps.entries()) {
      expect(results[index]?.code).toBe(0);
      expect(existsSync(join(dir, 'node_modules/vite/package.json'))).toBe(true);
      expect(readFileSync(join(dir, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}');
    }
    expect(results[1]?.output).toContain('shared install');
    // The set is installed under the apps' project name, so the lockfile names the app, not the set.
    const setManifest = JSON.parse(readFileSync(join(installs[0] ?? '', 'package.json'), 'utf8')) as { name?: string };
    expect(setManifest.name).toBe('app');
  });

  test('a different set installs on its own', async () => {
    const installs: string[] = [];
    const shared = new SharedInstalls(tempDir(), async (cwd) => {
      installs.push(cwd);
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      return { code: 0, output: '' };
    });
    await Promise.all([
      shared.install(appDir('a', { vite: '7.3.2' })),
      shared.install(appDir('b', { vite: '7.3.2' })),
      shared.install(appDir('c', { vite: '7.3.1' })),
    ]);
    expect(installs).toHaveLength(2);
  });

  test('a set\'s install is tried twice, and when both fail every app in the set fails with its log, without installing again', async () => {
    const apps = [appDir('a', { vite: '7.3.2' }), appDir('b', { vite: '7.3.2' }), appDir('c', { vite: '7.3.2' })];
    const installs: string[] = [];
    const shared = new SharedInstalls(tempDir(), async (cwd) => {
      installs.push(cwd);
      return { code: 1, output: 'npm error code ECONNRESET\n' };
    });
    const results = await Promise.all(apps.map((dir) => shared.install(dir)));
    expect(installs).toHaveLength(2);
    expect(installs.every((cwd) => !apps.includes(cwd))).toBe(true);
    expect(results.map((result) => result.code)).toEqual([1, 1, 1]);
    for (const result of results) {
      expect(result.output).toContain('trying it once more');
      expect(result.output.split('npm error code ECONNRESET')).toHaveLength(3);
    }
  });

  test('a set\'s install that fails once and then succeeds serves every app and reports the retry (#1485)', async () => {
    let attempts = 0;
    const reported: string[] = [];
    const shared = new SharedInstalls(tempDir(), async (cwd) => {
      attempts += 1;
      if (attempts === 1) return { code: 1, output: 'npm error code ECONNRESET\n' };
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      return { code: 0, output: 'added 1 package\n' };
    }, { report: (line) => reported.push(line) });
    const results = await Promise.all([appDir('a', { vite: '7.3.2' }), appDir('b', { vite: '7.3.2' })].map((dir) => shared.install(dir)));
    expect(attempts).toBe(2);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(reported).toHaveLength(2);
    expect(reported[0]).toMatch(/^\[runner\] retried the shared install for [0-9a-f]{16} after exit 1, \d+\.\d s$/);
    expect(reported[1]).toMatch(/^\[runner\] dependency set [0-9a-f]{16}: installed in place, \d+\.\d s$/);
  });

  test('a copy that fails keeps the shared install\'s npm output in the app\'s log', async () => {
    // The set's install reports success but leaves no node_modules to copy.
    const shared = new SharedInstalls(tempDir(), async () => ({ code: 0, output: 'added 205 packages\n' }));
    const result = await shared.install(appDir('a', { vite: '7.3.2' }));
    expect(result.code).toBe(1);
    expect(result.output).toContain('added 205 packages');
    expect(result.output).toContain('failed');
  });

  test('a non-transient failure such as E404 fails on attempt 1 without retrying', async () => {
    let calls = 0;
    const shared = new SharedInstalls(tempDir(), async () => {
      calls += 1;
      return { code: 1, output: 'npm error code E404\n' };
    });
    const result = await shared.install(appDir('a', { vite: '7.3.2' }));
    expect(calls).toBe(1);
    expect(result.code).toBe(1);
    expect(result.output).toContain('npm error code E404');
  });
});

describe('consistent single-retry bounds across npmInstall, DependencyStore, and SharedInstalls', () => {
  const PLATFORM = { nodeMajor: '22', npm: '10.9.0', os: 'linux', arch: 'x64' };
  const PACKED = [{ name: 'pyric', file: '/packed/pyric.tgz', integrity: 'sha512-demo', manifest: { name: 'pyric', version: '0.1.0-alpha.1' }, files: new Map<string, number>() }];

  function makeApp(name: string, fields: Record<string, unknown>): string {
    const dir = join(tempDir(), name, 'app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, ...fields }));
    return dir;
  }

  function makeStore(runNpm: RunNpm): DependencyStore {
    const base = tempDir();
    return new DependencyStore({ dir: join(base, 'deps'), offline: false, packed: PACKED, platform: PLATFORM, npmCache: join(base, 'npm-cache'), runNpm, networkRetryDelayMs: 0 });
  }

  test('npmInstall shares one network retry budget across --prefer-offline and --prefer-online', async () => {
    const exhausted: CommandResult[] = [
      { code: 1, output: 'attempt 1: npm error code ECONNRESET\n' },
      { code: 1, output: ETARGET_OUTPUT },
      { code: 1, output: 'attempt 3: npm error code ECONNRESET\n' },
      { code: 0, output: 'should never run\n' },
    ];
    let exhaustedCalls = 0;
    const failed = await npmInstall('/cache', async () => {
      exhaustedCalls += 1;
      return exhausted.shift() ?? { code: 1, output: 'called too often' };
    }, undefined, { networkRetryDelayMs: 0 });
    expect({ exhaustedCalls, code: failed.code, retryable: failed.retryable }).toEqual({ exhaustedCalls: 3, code: 1, retryable: false });

    const recoversOnline: CommandResult[] = [
      { code: 1, output: ETARGET_OUTPUT },
      { code: 1, output: 'online 1: npm error code ECONNRESET\n' },
      { code: 0, output: 'added 1 package\n' },
    ];
    let onlineCalls = 0;
    const ok = await npmInstall('/cache', async () => {
      onlineCalls += 1;
      return recoversOnline.shift() ?? { code: 1, output: 'called too often' };
    }, undefined, { networkRetryDelayMs: 0 });
    expect({ onlineCalls, code: ok.code }).toEqual({ onlineCalls: 3, code: 0 });
  });

  test('SharedInstalls over DependencyStore runs 2 npm calls on ECONNRESET, 3 on ECONNRESET+ETARGET+ECONNRESET, 1 on E404/ERESOLVE, and 2 on timeout', async () => {
    const fail = (output: string): TimedResult => ({ code: 1, output, timedOut: false });
    const hung = (output: string): TimedResult => ({ code: null, output, timedOut: true });
    const cases: Array<{ label: string; responses: TimedResult[]; expectedCalls: number }> = [
      { label: 'persistent-econnreset', responses: [fail('npm error code ECONNRESET\n'), fail('npm error code ECONNRESET\n'), fail('extra\n')], expectedCalls: 2 },
      { label: 'econnreset-etarget-econnreset', responses: [fail('npm error code ECONNRESET\n'), fail(ETARGET_OUTPUT), fail('npm error code ECONNRESET\n'), fail('extra\n')], expectedCalls: 3 },
      { label: 'bad-dep-e404', responses: [fail('npm error code E404\n'), fail('extra\n')], expectedCalls: 1 },
      { label: 'bad-dep-eresolve', responses: [fail('npm error code ERESOLVE\n'), fail('extra\n')], expectedCalls: 1 },
      { label: 'timed-out-warm', responses: [hung('stalled 1\n'), hung('stalled 2\n'), hung('extra\n')], expectedCalls: 2 },
    ];
    for (const entry of cases) {
      let calls = 0;
      const store = makeStore(async () => {
        calls += 1;
        return entry.responses.shift() ?? fail('called too often\n');
      });
      const shared = new SharedInstalls(tempDir(), async () => ({ code: 1, output: 'unused\n' }), {
        installSet: (dir, app) => store.provide(dir, app),
      });
      const result = await shared.install(makeApp(entry.label, { dependencies: { vite: '7.3.2' } }), 'demo');
      expect({ label: entry.label, calls, failed: result.code !== 0 }).toEqual({ label: entry.label, calls: entry.expectedCalls, failed: true });
    }
  });

  test('default SharedInstalls wired with npmInstall does not stack retries on shared or standalone apps', async () => {
    const runPath = async (fields: Record<string, unknown>, output: string): Promise<number> => {
      let calls = 0;
      const installIn = () => npmInstall('/cache', async () => {
        calls += 1;
        return { code: 1, output };
      }, undefined, { networkRetryDelayMs: 0 });
      const shared = new SharedInstalls(tempDir(), installIn);
      const result = await shared.install(makeApp('app', fields));
      expect(result.code).toBe(1);
      return calls;
    };
    const sharedFields = { dependencies: { vite: '7.3.2' } };
    const aloneFields = { dependencies: { vite: '7.3.2' }, scripts: { postinstall: 'node setup.js' } };
    expect(await runPath(sharedFields, 'npm error code ECONNRESET\n')).toBe(2);
    expect(await runPath(sharedFields, 'npm error code E404\n')).toBe(1);
    expect(await runPath(aloneFields, 'npm error code ECONNRESET\n')).toBe(2);
    expect(await runPath(aloneFields, 'npm error code E404\n')).toBe(1);
  });
});
