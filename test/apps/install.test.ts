import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmInstall, npmInstallArgs, shouldRetryOnline, type CommandResult } from './install.ts';
import { dependencySetKey, linkTree, SharedInstalls } from './shared-installs.ts';

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

  test('npmInstall retries once with --prefer-online and says so in the output', async () => {
    const calls: string[][] = [];
    const results: CommandResult[] = [{ code: 1, output: ETARGET_OUTPUT }, { code: 0, output: 'added 205 packages\n' }];
    const result = await npmInstall('/cache', async (args) => {
      calls.push(args);
      return results.shift() ?? { code: 1, output: 'called too often' };
    });
    expect(calls).toEqual([npmInstallArgs('/cache'), npmInstallArgs('/cache', 'online')]);
    expect(calls[1]).toContain('--prefer-online');
    expect(calls[1]).not.toContain('--prefer-offline');
    expect(result.code).toBe(0);
    expect(result.output).toContain(ETARGET_OUTPUT);
    expect(result.output).toContain('retrying once with --prefer-online');
    expect(result.output).toContain('added 205 packages');
  });

  test('npmInstall does not retry a failure that stale metadata does not explain', async () => {
    let calls = 0;
    const result = await npmInstall('/cache', async () => {
      calls += 1;
      return { code: 1, output: 'npm error code E404\n' };
    });
    expect(calls).toBe(1);
    expect(result.code).toBe(1);
  });
});

describe('dependency sets', () => {
  const manifest = (fields: Record<string, unknown>) => JSON.stringify({ private: true, type: 'module', ...fields });

  test('apps that install the same packages share a set, whatever else their manifests hold', () => {
    const cli = 'file:/work/dist/packages/pyric-cli-0.1.0-alpha.28.tgz';
    const a = dependencySetKey(manifest({ name: 'a', dependencies: { vite: '7.3.2', '@pyric/cli': cli }, overrides: { '@pyric/cli': cli }, scripts: { dev: 'vite' } }), undefined);
    const b = dependencySetKey(manifest({ name: 'b', dependencies: { '@pyric/cli': cli, vite: '7.3.2' }, overrides: { '@pyric/cli': cli } }), undefined);
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  test('a different version, dev dependency, override or .npmrc is a different set', () => {
    const base = { dependencies: { vite: '7.3.2' } };
    const key = dependencySetKey(manifest(base), undefined);
    expect(dependencySetKey(manifest({ dependencies: { vite: '7.3.1' } }), undefined)).not.toBe(key);
    expect(dependencySetKey(manifest({ ...base, devDependencies: { typescript: '5.9.3' } }), undefined)).not.toBe(key);
    expect(dependencySetKey(manifest({ ...base, overrides: { esbuild: '0.25.0' } }), undefined)).not.toBe(key);
    expect(dependencySetKey(manifest(base), 'registry=https://example.test/\n')).not.toBe(key);
  });

  test('an app whose install runs its own scripts, or links its own directories, installs alone', () => {
    expect(dependencySetKey(manifest({ dependencies: { vite: '7.3.2' }, scripts: { postinstall: 'node setup.js' } }), undefined)).toBeUndefined();
    expect(dependencySetKey(manifest({ workspaces: ['server'] }), undefined)).toBeUndefined();
    expect(dependencySetKey(manifest({ dependencies: { server: 'file:./server' } }), undefined)).toBeUndefined();
    expect(dependencySetKey(manifest({ dependencies: { shared: 'file:../shared' } }), undefined)).toBeUndefined();
    expect(dependencySetKey(manifest({ dependencies: { lib: 'link:lib' } }), undefined)).toBeUndefined();
  });
});

describe('linking an installed tree into an app', () => {
  test('files are hard links to the installed files, and symlinks stay symlinks', () => {
    const from = tempDir();
    const to = join(tempDir(), 'node_modules');
    mkdirSync(join(from, 'vite/bin'), { recursive: true });
    mkdirSync(join(from, '.bin'));
    writeFileSync(join(from, 'vite/bin/vite.js'), 'console.log("vite")\n');
    symlinkSync('../vite/bin/vite.js', join(from, '.bin/vite'));
    linkTree(from, to);
    expect(statSync(join(to, 'vite/bin/vite.js')).ino).toBe(statSync(join(from, 'vite/bin/vite.js')).ino);
    expect(lstatSync(join(to, '.bin/vite')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(to, '.bin/vite'))).toBe('../vite/bin/vite.js');
    expect(readFileSync(join(to, '.bin/vite'), 'utf8')).toBe('console.log("vite")\n');
  });
});

describe('one install per dependency set', () => {
  function appDir(name: string, dependencies: Record<string, string>): string {
    const dir = join(tempDir(), name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, name, dependencies }));
    return dir;
  }

  test('apps with the same set install once, even when they ask at the same time, and each gets the tree', async () => {
    const installs: string[] = [];
    const shared = new SharedInstalls(tempDir(), async (cwd) => {
      installs.push(cwd);
      await new Promise((resolve) => setTimeout(resolve, 10));
      mkdirSync(join(cwd, 'node_modules/vite'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules/vite/package.json'), '{"name":"vite"}');
      writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3}');
      return { code: 0, output: 'added 1 package\n' };
    });
    const apps = ['one', 'two', 'three'].map((name) => appDir(name, { vite: '7.3.2' }));
    const results = await Promise.all(apps.map((dir) => shared.install(dir)));
    expect(installs).toHaveLength(1);
    for (const [index, dir] of apps.entries()) {
      expect(results[index]?.code).toBe(0);
      expect(existsSync(join(dir, 'node_modules/vite/package.json'))).toBe(true);
      expect(readFileSync(join(dir, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}');
    }
    expect(results[1]?.output).toContain('shared install');
  });

  test('a different set installs on its own, and a failed install fails every app that shares it', async () => {
    let installs = 0;
    const shared = new SharedInstalls(tempDir(), async () => {
      installs += 1;
      return { code: 1, output: 'npm error code E404\n' };
    });
    const results = await Promise.all([
      shared.install(appDir('a', { vite: '7.3.2' })),
      shared.install(appDir('b', { vite: '7.3.2' })),
      shared.install(appDir('c', { vite: '7.3.1' })),
    ]);
    expect(installs).toBe(2);
    expect(results.map((result) => result.code)).toEqual([1, 1, 1]);
  });
});
