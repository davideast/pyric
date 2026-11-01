// `reproduce` installs an app the builder wrote, so its install must never
// fall back to the host. These tests run a real `npm install --offline` on a
// builder-style package.json against an empty cache (no network is needed:
// npm fails before it would reach for one). The sandbox's `enter` is replaced
// by one that runs the command as given, so no bwrap is needed either.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../apps/install.ts';
import { ColdCacheRefused, installApp, nextAfterSandboxInstall } from './app-install.ts';
import type { EgressNamespace } from './namespace.ts';
import { layOutReproApp, SET_ASIDE_NPMRC } from './repro-app.ts';
import { createRunDirs } from './scratch.ts';

const passthrough: EgressNamespace = {
  pid: 0,
  enter: (command, args) => ({ command, args: [...args] }),
  stop: async () => {},
};

const savedCache = process.env.PYRIC_APPS_NPM_CACHE;
afterEach(() => {
  if (savedCache === undefined) delete process.env.PYRIC_APPS_NPM_CACHE;
  else process.env.PYRIC_APPS_NPM_CACHE = savedCache;
});

describe('nextAfterSandboxInstall', () => {
  const cold = { code: 1, output: 'npm error code ENOTCACHED' };
  test('a cold cache installs outside only where that is allowed', () => {
    expect(nextAfterSandboxInstall(cold, 'allowed')).toBe('install-outside');
    expect(nextAfterSandboxInstall(cold, 'forbidden')).toBe('refuse-cold-cache');
    expect(nextAfterSandboxInstall({ code: 0, output: '' }, 'forbidden')).toBe('done');
    expect(nextAfterSandboxInstall({ code: 1, output: 'npm error code E404' }, 'forbidden')).toBe('fail');
  });
});

describe('installApp with the outside install forbidden', () => {
  test('a builder package.json with an uncached dependency is refused, and nothing installs on the host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-install-'));
    process.env.PYRIC_APPS_NPM_CACHE = join(root, 'empty-cache');
    mkdirSync(process.env.PYRIC_APPS_NPM_CACHE);
    const dirs = createRunDirs(join(root, 'run'));
    writeFileSync(join(dirs.app, 'package.json'), JSON.stringify({ private: true, dependencies: { 'left-pad': '1.3.0' } }));
    const install = installApp(passthrough, dirs, 'test', () => {}, 'forbidden');
    await expect(install).rejects.toBeInstanceOf(ColdCacheRefused);
    expect(readFileSync(join(dirs.logs, '00-npm-install-sandbox.log'), 'utf8')).toContain('ENOTCACHED');
    expect(existsSync(join(dirs.logs, '00-npm-install-outside.log'))).toBe(false);
    expect(existsSync(join(dirs.app, 'node_modules', 'left-pad'))).toBe(false);
  }, 120_000);
});

async function appArchive(root: string, files: (app: string) => void): Promise<string> {
  const source = join(root, 'source');
  const app = join(source, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ private: true, dependencies: {} }));
  files(app);
  const archive = join(root, 'app.tgz');
  const tar = await runCommand('tar', ['-czf', archive, '-C', source, 'app'], { cwd: root });
  if (tar.code !== 0) throw new Error(tar.output);
  return archive;
}

describe('the builder\'s .npmrc', () => {
  const script = join(import.meta.dir, 'fixtures', 'repros', 'behaves.mjs');

  test('is set aside before the install, so its registry and helpers never apply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repro-npmrc-'));
    const npmrc = 'registry=http://127.0.0.1:9/\n';
    const archive = await appArchive(root, (app) => writeFileSync(join(app, '.npmrc'), npmrc));
    const dirs = createRunDirs(join(root, 'try'));
    await layOutReproApp({ dirs, appArchive: archive, tarballs: new Map(), run: 'r1-1', script });
    expect(existsSync(join(dirs.app, '.npmrc'))).toBe(false);
    expect(readFileSync(join(dirs.app, SET_ASIDE_NPMRC), 'utf8')).toBe(npmrc);
    const config = await runCommand('npm', ['config', 'get', 'registry'], { cwd: dirs.app });
    expect(config.output).not.toContain('127.0.0.1:9');
  }, 60_000);

  test('a link in its place is renamed, and what it points at is never touched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repro-npmrc-'));
    const outside = join(root, 'host-file');
    writeFileSync(outside, 'host\n');
    const archive = await appArchive(root, (app) => symlinkSync(outside, join(app, '.npmrc')));
    const dirs = createRunDirs(join(root, 'try'));
    await layOutReproApp({ dirs, appArchive: archive, tarballs: new Map(), run: 'r1-1', script });
    expect(existsSync(join(dirs.app, '.npmrc'))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('host\n');
  }, 60_000);
});
