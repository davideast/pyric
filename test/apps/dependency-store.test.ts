import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pinPyricPackages, runCommand, runTimedCommand, type Tarballs, type TimedResult } from './install.ts';
import {
  changedThirdPartyEntries,
  DependencyStore,
  readPackedPackage,
  storeKey,
  type Lockfile,
  type PackedPackage,
  type Platform,
  type RunNpm,
} from './dependency-store.ts';
import { SharedInstalls } from './shared-installs.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-store-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLATFORM: Platform = { nodeMajor: '24', npm: '11.13.0', os: 'linux', arch: 'x64' };

/** A gzipped tar of `files`, the shape `npm pack` writes. */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

interface FakeManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

function packageTarball(manifest: FakeManifest, source: string): Buffer {
  return tarGz({ 'package/package.json': JSON.stringify(manifest), 'package/index.js': source });
}

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** Writes the fake Pyric packages at `version` into `dir`, named as `npm pack` names them. */
function fakePyric(dir: string, version: string): Tarballs {
  mkdirSync(dir, { recursive: true });
  const manifests: FakeManifest[] = [
    { name: 'pyric', version, dependencies: { 'fake-b': '^1.0.0' } },
    { name: 'pyric-admin', version, dependencies: { pyric: `^${version}` } },
  ];
  const tarballs: Tarballs = new Map();
  for (const manifest of manifests) {
    const file = join(dir, `${manifest.name}-${version}.tgz`);
    writeFileSync(file, packageTarball(manifest, `module.exports = ${JSON.stringify(version)};\n`));
    tarballs.set(manifest.name, file);
  }
  return tarballs;
}

function packedOf(tarballs: Tarballs): PackedPackage[] {
  return [...tarballs.values()].map(readPackedPackage);
}

/** A set's directory as SharedInstalls writes it, its Pyric packages pinned to `tarballs`. */
function setDir(tarballs: Tarballs, dependencies: Record<string, string> = { 'fake-a': '^1.0.0', 'pyric-admin': '^0.1.0' }): string {
  const dir = join(tempDir(), 'app');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies }));
  pinPyricPackages(dir, tarballs);
  return dir;
}

function packed(name: string, version: string, dependencies: Record<string, string> = {}, extra: Partial<PackedPackage['manifest']> = {}): PackedPackage {
  return { name, file: `/packs/${version}/${name}-${version}.tgz`, integrity: `sha512-${name}-${version}`, manifest: { name, version, dependencies, ...extra } };
}

function manifestPinnedTo(version: string, dependencies: Record<string, string> = { firebase: '^12.0.0' }): string {
  const file = (name: string) => `file:/packs/${version}/${name}-${version}.tgz`;
  return JSON.stringify({
    name: 'app',
    private: true,
    dependencies: { ...dependencies, '@pyric/cli': file('pyric-cli') },
    overrides: { pyric: file('pyric'), 'pyric-admin': file('pyric-admin'), '@pyric/cli': file('pyric-cli') },
  });
}

function publishedAt(version: string, pyricDependencies: Record<string, string> = { zod: '^3.23.0' }): PackedPackage[] {
  return [
    packed('pyric', version, pyricDependencies),
    packed('pyric-admin', version, { pyric: `^${version}` }),
    packed('@pyric/cli', version, { pyric: `^${version}`, ws: '^8.18.0' }, { peerDependencies: { vite: '^7.0.0' } }),
  ];
}

describe('the store key', () => {
  const base = { manifest: manifestPinnedTo('0.1.0-alpha.1'), packed: publishedAt('0.1.0-alpha.1'), platform: PLATFORM };

  test('ignores the tarballs\' path and version', () => {
    expect(storeKey({ ...base, manifest: manifestPinnedTo('0.1.0-alpha.2'), packed: publishedAt('0.1.0-alpha.2') })).toBe(storeKey(base));
  });

  test('changes with a third-party range in the app', () => {
    expect(storeKey({ ...base, manifest: manifestPinnedTo('0.1.0-alpha.1', { firebase: '^12.1.0' }) })).not.toBe(storeKey(base));
  });

  test('changes with a published package\'s third-party dependency', () => {
    expect(storeKey({ ...base, packed: publishedAt('0.1.0-alpha.1', { zod: '^4.0.0' }) })).not.toBe(storeKey(base));
  });

  test('changes with the Node major, the npm version, the OS and the architecture', () => {
    const keys = [
      storeKey(base),
      storeKey({ ...base, platform: { ...PLATFORM, nodeMajor: '22' } }),
      storeKey({ ...base, platform: { ...PLATFORM, npm: '11.14.0' } }),
      storeKey({ ...base, platform: { ...PLATFORM, os: 'darwin' } }),
      storeKey({ ...base, platform: { ...PLATFORM, arch: 'arm64' } }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('changes with the project name and its .npmrc', () => {
    const renamed = JSON.stringify({ ...JSON.parse(base.manifest), name: 'other' });
    expect(storeKey({ ...base, manifest: renamed })).not.toBe(storeKey(base));
    expect(storeKey({ ...base, npmrc: 'legacy-peer-deps=true\n' })).not.toBe(storeKey(base));
  });
});

describe('a packed package', () => {
  test('is read from its tarball: its manifest, and the integrity npm records', () => {
    const tarballs = fakePyric(tempDir(), '0.1.0-alpha.7');
    const file = tarballs.get('pyric') ?? '';
    const read = readPackedPackage(file);
    expect(read.name).toBe('pyric');
    expect(read.manifest.version).toBe('0.1.0-alpha.7');
    expect(read.manifest.dependencies).toEqual({ 'fake-b': '^1.0.0' });
    expect(read.integrity).toBe(integrityOf(readFileSync(file)));
  });
});

describe('the third-party check', () => {
  const lock = (entries: Record<string, object>) => ({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...entries } });
  const pyricNames = new Set(['pyric', '@pyric/cli']);

  test('ignores Pyric entries and the root, and names every third-party entry added, removed or changed', () => {
    const before = lock({
      'node_modules/pyric': { version: '1' },
      'node_modules/@pyric/cli': { version: '1' },
      'node_modules/zod': { version: '3.23.0', integrity: 'sha512-z' },
      'node_modules/ws': { version: '8.18.0' },
      'node_modules/@pyric/cli/node_modules/esbuild': { version: '0.28.0' },
    });
    const after = lock({
      'node_modules/pyric': { version: '2' },
      'node_modules/@pyric/cli': { version: '2' },
      'node_modules/zod': { integrity: 'sha512-z', version: '3.23.0' },
      'node_modules/@pyric/cli/node_modules/esbuild': { version: '0.28.1' },
      'node_modules/left-pad': { version: '1.3.0' },
    });
    expect(changedThirdPartyEntries(before, after, pyricNames)).toEqual([
      'node_modules/@pyric/cli/node_modules/esbuild',
      'node_modules/left-pad',
      'node_modules/ws',
    ]);
  });
});

/** An npm stand-in: a warm writes a tree and a lockfile; the offline install runs `onOffline`. */
function scriptedNpm(options: { warmDelayMs?: number; onOffline?: (cwd: string) => void } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runNpm: RunNpm = async (args, { cwd }) => {
    calls.push({ args, cwd });
    if (args.includes('--offline')) {
      options.onOffline?.(cwd);
      return { code: 0, output: 'changed 2 packages\n', timedOut: false };
    }
    await new Promise((resolve) => setTimeout(resolve, options.warmDelayMs ?? 0));
    mkdirSync(join(cwd, 'node_modules/fake-a'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules/fake-a/package.json'), '{"name":"fake-a","version":"1.0.0"}');
    const packages = {
      '': { name: 'app' },
      'node_modules/fake-a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fake-a/-/fake-a-1.0.0.tgz' },
      'node_modules/pyric': { version: '0.1.0-alpha.1', resolved: 'file:old.tgz', integrity: 'sha512-pyric-0.1.0-alpha.1' },
    };
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: 'app', lockfileVersion: 3, packages }));
    return { code: 0, output: 'added 2 packages\n', timedOut: false } satisfies TimedResult;
  };
  return { calls, runNpm, warms: () => calls.filter((call) => !call.args.includes('--offline')).length };
}

function scriptedSetDir(version: string): string {
  const dir = join(tempDir(), 'app');
  mkdirSync(dir, { recursive: true });
  const file = `file:/packs/${version}/pyric-${version}.tgz`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies: { 'fake-a': '^1.0.0', pyric: file }, overrides: { pyric: file } }));
  return dir;
}

function scriptedStore(storeDir: string, npm: ReturnType<typeof scriptedNpm>, version = '0.1.0-alpha.1', offline = false): DependencyStore {
  return new DependencyStore({ dir: storeDir, offline, packed: [packed('pyric', version)], platform: PLATFORM, npmCache: join(storeDir, '..', 'npm-cache'), runNpm: npm.runNpm });
}

describe('the store', () => {
  test('offline, a miss fails at once with the key and the app, and never runs npm', async () => {
    const npm = scriptedNpm();
    const storeDir = join(tempDir(), 'deps');
    const store = scriptedStore(storeDir, npm, '0.1.0-alpha.1', true);
    const dir = scriptedSetDir('0.1.0-alpha.1');
    const result = await store.provide(dir, 'storage-rules-lookup-paths');
    expect(result.code).not.toBe(0);
    expect(result.retryable).toBe(false);
    expect(result.output).toContain(store.keyOf(dir));
    expect(result.output).toContain('storage-rules-lookup-paths');
    expect(result.output).toContain('PYRIC_APPS_OFFLINE');
    expect(npm.calls).toHaveLength(0);
    expect(existsSync(join(storeDir, store.keyOf(dir)))).toBe(false);
  });

  test('two runs warming one key at once leave one complete entry', async () => {
    const storeDir = join(tempDir(), 'deps');
    const npm = scriptedNpm({ warmDelayMs: 50 });
    const [one, two] = [scriptedStore(storeDir, npm), scriptedStore(storeDir, npm)];
    const dirs = [scriptedSetDir('0.1.0-alpha.1'), scriptedSetDir('0.1.0-alpha.1')];
    const results = await Promise.all([one.provide(dirs[0] ?? ''), two.provide(dirs[1] ?? '')]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(npm.warms()).toBe(2);
    const key = one.keyOf(dirs[0] ?? '');
    expect(readdirSync(storeDir)).toEqual([key]);
    for (const file of ['package.json', 'package-lock.json', 'node_modules/fake-a/package.json', 'store.json']) {
      expect(existsSync(join(storeDir, key, file))).toBe(true);
    }
    for (const dir of dirs) expect(existsSync(join(dir, 'node_modules/fake-a/package.json'))).toBe(true);
    // A third run finds the entry and does not warm.
    const third = await scriptedStore(storeDir, npm).provide(scriptedSetDir('0.1.0-alpha.1'));
    expect(third.code).toBe(0);
    expect(third.source).toContain('from the store');
    expect(npm.warms()).toBe(2);
  });

  test('a set whose install changes a third-party lockfile entry fails, naming the entry', async () => {
    const storeDir = join(tempDir(), 'deps');
    const npm = scriptedNpm({
      onOffline: (cwd) => {
        const lockfile = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> };
        const fakeA = lockfile.packages['node_modules/fake-a'];
        if (fakeA) fakeA.version = '1.0.1';
        writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lockfile));
      },
    });
    await scriptedStore(storeDir, npm).provide(scriptedSetDir('0.1.0-alpha.1'));
    const result = await scriptedStore(storeDir, npm, '0.1.0-alpha.2').provide(scriptedSetDir('0.1.0-alpha.2'));
    expect(result.code).not.toBe(0);
    expect(result.retryable).toBe(false);
    expect(result.output).toContain('node_modules/fake-a');
  });

  test('a set whose Pyric packages changed restamps the lockfile and installs them offline', async () => {
    const storeDir = join(tempDir(), 'deps');
    const npm = scriptedNpm();
    await scriptedStore(storeDir, npm).provide(scriptedSetDir('0.1.0-alpha.1'));
    const dir = scriptedSetDir('0.1.0-alpha.2');
    const result = await scriptedStore(storeDir, npm, '0.1.0-alpha.2').provide(dir);
    expect(result.code).toBe(0);
    const offline = npm.calls.filter((call) => call.args.includes('--offline'));
    expect(offline).toHaveLength(1);
    expect(offline[0]?.cwd).toBe(dir);
    // An empty npm cache of its own, never the warm's.
    const cache = offline[0]?.args[offline[0].args.indexOf('--cache') + 1];
    expect(cache).toBeDefined();
    expect(cache).not.toBe(join(storeDir, '..', 'npm-cache'));
    const lockfile = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; integrity?: string; resolved?: string }> };
    expect(lockfile.packages['node_modules/pyric']).toMatchObject({
      version: '0.1.0-alpha.2',
      integrity: 'sha512-pyric-0.1.0-alpha.2',
      resolved: `file:${relative(dir, '/packs/0.1.0-alpha.2/pyric-0.1.0-alpha.2.tgz')}`,
    });
    expect(lockfile.packages['node_modules/fake-a']?.version).toBe('1.0.0');
  });
});

describe('a warm that times out', () => {
  test('a command past its limit is stopped with its group, and the result says so', async () => {
    const result = await runTimedCommand('sleep', ['5'], { cwd: tmpdir(), timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.output).toContain('sleep stopped after 0.2 s');
  });

  test('is worth retrying, and leaves no entry and no partial build behind', async () => {
    const storeDir = join(tempDir(), 'deps');
    const runNpm: RunNpm = async () => ({ code: null, output: 'npm stalled\n', timedOut: true });
    const store = new DependencyStore({ dir: storeDir, offline: false, packed: [packed('pyric', '0.1.0-alpha.1')], platform: PLATFORM, npmCache: join(storeDir, '..', 'npm-cache'), runNpm });
    const result = await store.provide(scriptedSetDir('0.1.0-alpha.1'));
    expect(result.code).not.toBe(0);
    expect(result.retryable).toBe(true);
    expect(result.output).toContain('npm stalled');
    expect(readdirSync(storeDir)).toEqual([]);
  });
});

describe('one runner line per set', () => {
  test('names the set, where its tree came from, and its seconds, once per set', async () => {
    const lines: string[] = [];
    let calls = 0;
    const shared = new SharedInstalls(tempDir(), async () => ({ code: 1, output: 'never\n' }), {
      installSet: async (dir) => {
        calls += 1;
        mkdirSync(join(dir, 'node_modules'), { recursive: true });
        return { code: 0, output: '', source: 'from the store (entry abc)', retryable: true };
      },
      report: (line) => lines.push(line),
    });
    const apps = ['one', 'two'].map((name) => {
      const dir = join(tempDir(), name, 'app');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { vite: '7.3.2' } }));
      return dir;
    });
    await Promise.all(apps.map((dir, index) => shared.install(dir, `app-${index}`)));
    expect(calls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[runner\] dependency set [0-9a-f]+ for app-0: from the store \(entry abc\), \d+\.\d s$/);
  });

  test('a failure the store marks as not worth retrying is not retried', async () => {
    let calls = 0;
    const shared = new SharedInstalls(tempDir(), async () => ({ code: 1, output: 'never\n' }), {
      installSet: async () => {
        calls += 1;
        return { code: 1, output: 'no store entry\n', source: 'missing from the store', retryable: false };
      },
    });
    const dir = join(tempDir(), 'one', 'app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { vite: '7.3.2' } }));
    const result = await shared.install(dir);
    expect(result.code).toBe(1);
    expect(calls).toBe(1);
  });
});

/** A registry on localhost that serves `packages`, for real npm installs with no outside network. */
function startRegistry(packages: FakeManifest[]): Promise<{ server: HttpServer; url: string }> {
  const tarballs = new Map<string, Buffer>();
  const documents = new Map<string, object>();
  const server = createHttpServer((request, response) => {
    const path = decodeURIComponent(request.url ?? '/').slice(1);
    const tarball = tarballs.get(path);
    if (tarball) return void response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tarball);
    const document = documents.get(path);
    if (document) return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(document));
    response.writeHead(404).end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      for (const manifest of packages) {
        const bytes = packageTarball(manifest, 'module.exports = 1;\n');
        const file = `${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`;
        tarballs.set(file, bytes);
        const dist = { tarball: `${url}/${file}`, integrity: integrityOf(bytes), shasum: createHash('sha1').update(bytes).digest('hex') };
        const existing = (documents.get(manifest.name) ?? { name: manifest.name, 'dist-tags': {}, versions: {} }) as { 'dist-tags': Record<string, string>; versions: Record<string, object> };
        existing.versions[manifest.version] = { ...manifest, dist };
        existing['dist-tags'].latest = manifest.version;
        documents.set(manifest.name, existing);
      }
      resolve({ server, url: `${url}/` });
    });
  });
}

/** A TCP listener that counts connections, so a test can show npm made none. */
function startCounter(): Promise<{ server: TcpServer; url: string; connections: () => number }> {
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/`, connections: () => connections });
    });
  });
}

/** Whether this machine lets an unprivileged process enter a network namespace with no network. */
async function canUnshareNetwork(): Promise<boolean> {
  try {
    const result = await runCommand('unshare', ['-rn', 'true'], { cwd: tmpdir() });
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Every file under `node_modules` that is not a Pyric package's, with a hash of its contents. */
function thirdPartyFiles(projectDir: string, pyricNames: Set<string>): Record<string, string> {
  const root = join(projectDir, 'node_modules');
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = relative(root, path);
      const isPyric = pyricNames.has(name);
      const isHiddenLockfile = name === '.package-lock.json';
      if (isPyric || isHiddenLockfile) continue;
      if (entry.isDirectory()) walk(path);
      else files[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return files;
}

describe('a set materialized from the store, with real npm', () => {
  let registry: { server: HttpServer; url: string };
  let counter: { server: TcpServer; url: string; connections: () => number };
  beforeAll(async () => {
    registry = await startRegistry([
      { name: 'fake-a', version: '1.0.0', dependencies: { 'fake-c': '^2.0.0' } },
      { name: 'fake-b', version: '1.0.0' },
      { name: 'fake-c', version: '2.0.0' },
    ]);
    counter = await startCounter();
  });
  afterAll(() => {
    registry.server.close();
    counter.server.close();
  });

  const onlineNpm: RunNpm = (args, { cwd, timeoutMs }) => runTimedCommand('npm', args, { cwd, timeoutMs, env: { ...process.env, npm_config_registry: registry.url, npm_config_update_notifier: 'false' } });

  test('equals a fresh install for the third-party packages, installed with no network and an empty npm cache', async () => {
    const work = tempDir();
    const storeDir = join(work, 'deps');
    const npmCache = join(work, 'npm-cache');
    const first = fakePyric(join(work, 'packs-1'), '0.1.0-alpha.1');
    const second = fakePyric(join(work, 'packs-2'), '0.1.0-alpha.2');

    const warmed = await new DependencyStore({ dir: storeDir, offline: false, packed: packedOf(first), platform: PLATFORM, npmCache, runNpm: onlineNpm }).provide(setDir(first));
    if (warmed.code !== 0) console.error(warmed.output);
    expect(warmed.code).toBe(0);
    expect(warmed.source).toContain('warmed');

    // The next run's tarballs, installed with no network at all where the machine allows it.
    const unshare = await canUnshareNetwork();
    const offlineCalls: string[][] = [];
    const isolatedNpm: RunNpm = (args, options) => {
      offlineCalls.push(args);
      const isOffline = args.includes('--offline');
      if (isOffline && unshare) return runTimedCommand('unshare', ['-rn', 'npm', ...args], { cwd: options.cwd, timeoutMs: options.timeoutMs });
      return onlineNpm(args, options);
    };
    const store = new DependencyStore({ dir: storeDir, offline: true, packed: packedOf(second), platform: PLATFORM, npmCache, runNpm: isolatedNpm, offlineRegistry: counter.url });
    const materialized = setDir(second);
    const result = await store.provide(materialized, 'fake-app');
    if (result.code !== 0) console.error(result.output);
    expect(result.code).toBe(0);
    expect(result.source).toContain('from the store');
    expect(counter.connections()).toBe(0);
    expect(offlineCalls).toHaveLength(1);
    expect(offlineCalls[0]).toContain('--offline');
    expect(offlineCalls[0]).toContain(`--registry=${counter.url}`);
    const installedPyric = JSON.parse(readFileSync(join(materialized, 'node_modules/pyric/package.json'), 'utf8')) as { version: string };
    expect(installedPyric.version).toBe('0.1.0-alpha.2');

    // A fresh install of the same set from the registry.
    const fresh = setDir(second);
    const freshInstall = await runCommand('npm', ['install', '--no-audit', '--no-fund', '--cache', join(work, 'fresh-cache')], { cwd: fresh, env: { ...process.env, npm_config_registry: registry.url, npm_config_update_notifier: 'false' } });
    expect(freshInstall.code).toBe(0);

    const pyricNames = new Set(second.keys());
    expect(thirdPartyFiles(materialized, pyricNames)).toEqual(thirdPartyFiles(fresh, pyricNames));
    expect(Object.keys(thirdPartyFiles(fresh, pyricNames))).toContain('fake-c/package.json');
    const lockOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as Lockfile;
    expect(changedThirdPartyEntries(lockOf(materialized), lockOf(fresh), pyricNames)).toEqual([]);
    expect(lockOf(materialized).packages?.['node_modules/pyric']).toEqual(lockOf(fresh).packages?.['node_modules/pyric']);
  }, 120_000);
});
