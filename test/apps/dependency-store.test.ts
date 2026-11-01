import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { pinPyricPackages, runCommand, runTimedCommand, type Tarballs, type TimedResult } from './install.ts';
import {
  changedThirdPartyEntries,
  DependencyStore,
  nestedProjectManifest,
  readPackedPackage,
  storeKey,
  type Lockfile,
  type PackedPackage,
  type ProvidedSet,
  type Platform,
  type RunNpm,
} from './dependency-store.ts';
import { NESTED_PROJECTS, type NestedProject } from './nested-projects.ts';
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

function packageTarball(manifest: FakeManifest, source: string, extra: Record<string, string> = {}): Buffer {
  const files = Object.fromEntries(Object.entries(extra).map(([path, text]) => [`package/${path}`, text]));
  return tarGz({ 'package/package.json': JSON.stringify(manifest), 'package/index.js': source, ...files });
}

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** One build of the fake Pyric packages, by package name: what each one's index.js says, and the files it gains. */
interface FakeBuild {
  labels?: Record<string, string>;
  extra?: Record<string, Record<string, string>>;
}

/** Writes the fake Pyric packages at `version` into `dir`, named as `npm pack` names them. */
function fakePyric(dir: string, version: string, build: FakeBuild = {}): Tarballs {
  mkdirSync(dir, { recursive: true });
  const manifests: FakeManifest[] = [
    // The set asks for fake-b@^1, so npm nests pyric's fake-b@2 under node_modules/pyric.
    { name: 'pyric', version, dependencies: { 'fake-b': '^2.0.0' } },
    { name: 'pyric-admin', version, dependencies: { pyric: `^${version}` } },
  ];
  const tarballs: Tarballs = new Map();
  for (const manifest of manifests) {
    const file = join(dir, `${manifest.name}-${version}.tgz`);
    const source = `module.exports = ${JSON.stringify(build.labels?.[manifest.name] ?? version)};\n`;
    writeFileSync(file, packageTarball(manifest, source, build.extra?.[manifest.name]));
    tarballs.set(manifest.name, file);
  }
  return tarballs;
}

function packedOf(tarballs: Tarballs): PackedPackage[] {
  return [...tarballs.values()].map(readPackedPackage);
}

/** A set's directory as SharedInstalls writes it, its Pyric packages pinned to `tarballs`. */
function setDir(tarballs: Tarballs, dependencies: Record<string, string> = { 'fake-a': '^1.0.0', 'fake-b': '^1.0.0', 'pyric-admin': '^0.1.0' }): string {
  const dir = join(tempDir(), 'app');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies }));
  pinPyricPackages(dir, tarballs);
  return dir;
}

function packed(name: string, version: string, dependencies: Record<string, string> = {}, extra: Partial<PackedPackage['manifest']> = {}): PackedPackage {
  return { name, file: `/packs/${version}/${name}-${version}.tgz`, integrity: `sha512-${name}-${version}`, manifest: { name, version, dependencies, ...extra }, files: new Map() };
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

  test('changes when a published package gains or drops a dependency on another Pyric package', () => {
    const [pyric, , cli] = base.packed;
    const adminAlone = [pyric, packed('pyric-admin', '0.1.0-alpha.1', {}), cli].filter((pack) => pack !== undefined);
    expect(storeKey({ ...base, packed: adminAlone })).not.toBe(storeKey(base));
  });

  test('changes with a published package\'s peerDependenciesMeta and bundleDependencies', () => {
    const withExtra = (extra: Partial<PackedPackage['manifest']>) => base.packed.map((pack) => (pack.name === '@pyric/cli' ? { ...pack, manifest: { ...pack.manifest, ...extra } } : pack));
    const optionalPeer = storeKey({ ...base, packed: withExtra({ peerDependenciesMeta: { vite: { optional: true } } }) });
    const bundled = storeKey({ ...base, packed: withExtra({ bundleDependencies: ['ws'] }) });
    // A Pyric peer turning optional counts too: its meta is not replaced by the placeholder.
    const optionalPyricPeer = storeKey({ ...base, packed: withExtra({ peerDependencies: { vite: '^7.0.0', pyric: '^0.1.0-alpha.1' }, peerDependenciesMeta: { pyric: { optional: true } } }) });
    const requiredPyricPeer = storeKey({ ...base, packed: withExtra({ peerDependencies: { vite: '^7.0.0', pyric: '^0.1.0-alpha.1' } }) });
    expect(new Set([storeKey(base), optionalPeer, bundled, optionalPyricPeer, requiredPyricPeer]).size).toBe(5);
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
    expect(read.manifest.dependencies).toEqual({ 'fake-b': '^2.0.0' });
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

/**
 * An npm stand-in: a warm writes a tree and a lockfile; the offline install
 * runs `onOffline`, installs pyric unless `installsPyric` is false, and exits
 * `offlineCode`. Its pyric package holds no files, as the store's `packed` says.
 */
function scriptedNpm(options: { warmDelayMs?: number; onOffline?: (cwd: string) => void; offlineCode?: number; installsPyric?: boolean } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runNpm: RunNpm = async (args, { cwd }) => {
    calls.push({ args, cwd });
    if (args.includes('--offline')) {
      options.onOffline?.(cwd);
      if (options.installsPyric !== false) mkdirSync(join(cwd, 'node_modules/pyric'), { recursive: true });
      const code = options.offlineCode ?? 0;
      return { code, output: code === 0 ? 'changed 2 packages\n' : 'npm error code ENOTCACHED\n', timedOut: false };
    }
    await new Promise((resolve) => setTimeout(resolve, options.warmDelayMs ?? 0));
    mkdirSync(join(cwd, 'node_modules/fake-a'), { recursive: true });
    mkdirSync(join(cwd, 'node_modules/pyric'), { recursive: true });
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
    expect(result.output).toContain(`delete ${join(storeDir, scriptedStore(storeDir, npm).keyOf(scriptedSetDir('0.1.0-alpha.1')))}`);
  });

  test('a failed offline install names the entry to delete, since a later run would fail the same way', async () => {
    const storeDir = join(tempDir(), 'deps');
    const npm = scriptedNpm({ offlineCode: 1 });
    await scriptedStore(storeDir, npm).provide(scriptedSetDir('0.1.0-alpha.1'));
    const dir = scriptedSetDir('0.1.0-alpha.2');
    const store = scriptedStore(storeDir, npm, '0.1.0-alpha.2');
    const result = await store.provide(dir);
    expect(result.code).not.toBe(0);
    expect(result.retryable).toBe(false);
    expect(result.output).toContain('ENOTCACHED');
    expect(result.output).toContain(`delete ${join(storeDir, store.keyOf(dir))}`);
  });

  test('an offline install that exits 0 but leaves a Pyric package other than this run\'s fails, naming the package (#1596)', async () => {
    const storeDir = join(tempDir(), 'deps');
    await scriptedStore(storeDir, scriptedNpm()).provide(scriptedSetDir('0.1.0-alpha.1'));
    // As npm answered in the report: "up to date", exit 0, and nothing extracted.
    const npm = scriptedNpm({ installsPyric: false });
    const result = await scriptedStore(storeDir, npm, '0.1.0-alpha.2').provide(scriptedSetDir('0.1.0-alpha.2'));
    expect(result.code).not.toBe(0);
    expect(result.retryable).toBe(false);
    expect(result.output).toContain('do not hold this run\'s tarballs');
    expect(result.output).toContain('node_modules/pyric: not installed');
  });

  test('an entry whose lockfile names this run\'s tarball but whose copy lacks its dist gets that tarball installed offline (#1585)', async () => {
    const storeDir = join(tempDir(), 'deps');
    // The tarball holds dist/index.js; the entry's copy, as the warm writes it, holds nothing.
    const pyric = { ...packed('pyric', '0.1.0-alpha.1'), files: new Map([['dist/index.js', 3]]) };
    const npm = scriptedNpm({
      onOffline: (cwd) => {
        mkdirSync(join(cwd, 'node_modules/pyric/dist'), { recursive: true });
        writeFileSync(join(cwd, 'node_modules/pyric/dist/index.js'), 'abc');
      },
    });
    const store = new DependencyStore({ dir: storeDir, offline: false, packed: [pyric], platform: PLATFORM, npmCache: join(storeDir, '..', 'npm-cache'), runNpm: npm.runNpm });
    const dir = scriptedSetDir('0.1.0-alpha.1');
    const result = await store.provide(dir);
    expect(result.code).toBe(0);
    expect(result.source).toContain('installed offline (pyric), as the entry\'s own copies did not match its lockfile (node_modules/pyric: missing dist/index.js)');
    expect(npm.calls.filter((call) => call.args.includes('--offline'))).toHaveLength(1);
    expect(readFileSync(join(dir, 'node_modules/pyric/dist/index.js'), 'utf8')).toBe('abc');
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
  /** Whether `pid` is a live process: present in /proc and not a zombie. */
  function isAlive(pid: number): boolean {
    const stat = join('/proc', String(pid), 'stat');
    if (!existsSync(stat)) return false;
    const state = readFileSync(stat, 'utf8').split(') ')[1]?.[0];
    return state !== 'Z';
  }

  test.if(process.platform === 'linux')('a command past its limit is stopped with its whole group, a grandchild that ignores SIGTERM too', async () => {
    const work = tempDir();
    const [childFile, grandchildFile] = [join(work, 'child.pid'), join(work, 'grandchild.pid')];
    // The grandchild ignores SIGTERM, so only the SIGKILL after the grace period ends it.
    writeFileSync(join(work, 'grandchild.sh'), `trap '' TERM\necho $$ > ${grandchildFile}\nwhile :; do sleep 0.05; done\n`);
    const script = `echo $$ > ${childFile}; sh ${join(work, 'grandchild.sh')} & wait`;
    const result = await runTimedCommand('sh', ['-c', script], { cwd: work, timeoutMs: 500 });
    const pids = [Number(readFileSync(childFile, 'utf8')), Number(readFileSync(grandchildFile, 'utf8'))];
    try {
      expect(new Set(pids).size).toBe(2);
      expect(result.timedOut).toBe(true);
      expect(result.code).toBeNull();
      expect(result.output).toContain('sh stopped after 0.5 s');
      // The default grace before SIGKILL is 1 s; allow time for the kernel and the reaper.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(pids.filter(isAlive)).toEqual([]);
    } finally {
      // A failing run must not leave its processes behind.
      for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
    }
  }, 10_000);

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

/** Every file under `dir`, but a nested `node_modules`, with a hash of its contents. */
function filesIn(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(path);
      if (entry.isFile()) files[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return files;
}

/** The files a tarball holds under `package/`, with a hash of each, extracted by tar. */
async function tarballFiles(file: string): Promise<Record<string, string>> {
  const out = tempDir();
  const extracted = await runCommand('tar', ['-xzf', file, '-C', out], { cwd: out });
  expect(extracted.code).toBe(0);
  return filesIn(join(out, 'package'));
}

describe('a set materialized from the store, with real npm', () => {
  let registry: { server: HttpServer; url: string };
  let counter: { server: TcpServer; url: string; connections: () => number };
  /** One store entry, warmed once from the first build at 0.1.0-alpha.1, that every test here materializes from. */
  let work: string;
  let first: Tarballs;
  let warmed: ProvidedSet;
  const storeDir = () => join(work, 'deps');
  const npmCache = () => join(work, 'npm-cache');
  beforeAll(async () => {
    registry = await startRegistry([
      { name: 'fake-a', version: '1.0.0', dependencies: { 'fake-c': '^2.0.0' } },
      { name: 'fake-b', version: '1.0.0' },
      { name: 'fake-b', version: '2.0.0' },
      { name: 'fake-c', version: '2.0.0' },
    ]);
    counter = await startCounter();
    // Not tempDir(): that one is removed after each test, and this entry serves them all.
    work = mkdtempSync(join(tmpdir(), 'pyric-store-test-'));
    first = fakePyric(join(work, 'packs-1'), '0.1.0-alpha.1');
    warmed = await new DependencyStore({ dir: storeDir(), offline: false, packed: packedOf(first), platform: PLATFORM, npmCache: npmCache(), runNpm: onlineNpm }).provide(setDir(first));
    if (warmed.code !== 0) console.error(warmed.output);
  });
  afterAll(() => {
    registry.server.close();
    counter.server.close();
    rmSync(work, { recursive: true, force: true });
  });

  const onlineNpm: RunNpm = (args, { cwd, timeoutMs }) => runTimedCommand('npm', args, { cwd, timeoutMs, env: { ...process.env, npm_config_registry: registry.url, npm_config_update_notifier: 'false' } });

  test('equals a fresh install for the third-party packages, installed with no network and an empty npm cache', async () => {
    const second = fakePyric(join(tempDir(), 'packs-2'), '0.1.0-alpha.2');
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
    const store = new DependencyStore({ dir: storeDir(), offline: true, packed: packedOf(second), platform: PLATFORM, npmCache: npmCache(), runNpm: isolatedNpm, offlineRegistry: counter.url });
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
    const freshInstall = await runCommand('npm', ['install', '--no-audit', '--no-fund', '--cache', join(tempDir(), 'fresh-cache')], { cwd: fresh, env: { ...process.env, npm_config_registry: registry.url, npm_config_update_notifier: 'false' } });
    expect(freshInstall.code).toBe(0);

    const pyricNames = new Set(second.keys());
    expect(thirdPartyFiles(materialized, pyricNames)).toEqual(thirdPartyFiles(fresh, pyricNames));
    expect(Object.keys(thirdPartyFiles(fresh, pyricNames))).toContain('fake-c/package.json');
    const lockOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as Lockfile;
    expect(changedThirdPartyEntries(lockOf(materialized), lockOf(fresh), pyricNames)).toEqual([]);
    expect(lockOf(materialized).packages?.['node_modules/pyric']).toEqual(lockOf(fresh).packages?.['node_modules/pyric']);
  }, 120_000);

  /**
   * The offline install, after a copy that left the hidden lockfile older than
   * the directories copied after it, as a copy of a large tree does. npm then
   * rejects the hidden lockfile and reads the tree from disk.
   */
  const staleHiddenLockfileNpm: RunNpm = (args, options) => {
    const hidden = join(options.cwd, 'node_modules', '.package-lock.json');
    if (args.includes('--offline') && existsSync(hidden)) utimesSync(hidden, new Date(0), new Date(0));
    return onlineNpm(args, options);
  };

  test('installs this run\'s tarballs over an entry warmed from an earlier build at the same version (#1596)', async () => {
    expect(warmed.code).toBe(0);
    // A source change since the entry was warmed, at the same version. Only pyric
    // changes: pyric-admin's tarball is the same bytes as the entry's.
    const current = fakePyric(join(tempDir(), 'packs'), '0.1.0-alpha.1', { labels: { pyric: 'current build' }, extra: { pyric: { 'dist/ai/broker/gemini-upstream.js': 'export const upstream = true;\n' } } });
    expect(readPackedPackage(current.get('pyric-admin') ?? '').integrity).toBe(readPackedPackage(first.get('pyric-admin') ?? '').integrity);
    const store = new DependencyStore({ dir: storeDir(), offline: true, packed: packedOf(current), platform: PLATFORM, npmCache: npmCache(), runNpm: staleHiddenLockfileNpm, offlineRegistry: counter.url });
    const materialized = setDir(current);
    const result = await store.provide(materialized, 'fake-app');
    if (result.code !== 0) console.error(result.output);
    expect(result.code).toBe(0);
    for (const [name, file] of current) {
      expect({ name, files: filesIn(join(materialized, 'node_modules', name)) }).toEqual({ name, files: await tarballFiles(file) });
    }
    // Only the package whose tarball changed is installed again.
    expect(result.source).toContain('its Pyric packages installed offline (pyric)');
    // pyric's nested fake-b@2 is kept through the install: the offline install has no way to fetch it.
    const versionAt = (path: string) => (JSON.parse(readFileSync(join(materialized, path, 'package.json'), 'utf8')) as { version: string }).version;
    expect(versionAt('node_modules/pyric/node_modules/fake-b')).toBe('2.0.0');
    expect(versionAt('node_modules/fake-b')).toBe('1.0.0');
  }, 120_000);
});

const appsDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(appsDir, '..', '..');

/** The paths a module passes to `installProject`: a string literal, or a const the module defines. */
function installedPaths(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/installProject\(\s*([^)]*?)\s*\)/g)].map(([, arg = '']) => {
    const literal = arg.match(/^(['"`])([^'"`]+)\1$/)?.[2];
    const constant = text.match(new RegExp(`const ${arg}\\s*=\\s*['"]([^'"]+)['"]`))?.[1];
    const path = literal ?? constant;
    if (path === undefined) throw new Error(`${relative(repoRoot, file)} passes installProject a path this test cannot read: ${arg}`);
    return path;
  });
}

/** Each app's nested installs: its scenario's own calls, and those of the helper modules it imports, such as chat-template.ts. */
function scenarioInstalls(): Array<{ app: string; path: string }> {
  const apps = readdirSync(appsDir).filter((name) => existsSync(join(appsDir, name, 'scenario.ts')));
  return apps.flatMap((app) => {
    const scenario = join(appsDir, app, 'scenario.ts');
    const helpers = [...readFileSync(scenario, 'utf8').matchAll(/from '\.\.\/([\w-]+\.ts)'/g)].map(([, name = '']) => name).filter((name) => name !== 'driver.ts');
    const paths = [scenario, ...helpers.map((name) => join(appsDir, name))].flatMap(installedPaths);
    return [...new Set(paths)].map((path) => ({ app, path }));
  });
}

const byAppAndPath = (a: { app: string; path: string }, b: { app: string; path: string }) => `${a.app}/${a.path}`.localeCompare(`${b.app}/${b.path}`);

/** The nested project that `template` scaffolds. */
function templateProject(template: 'chat' | 'node'): NestedProject {
  const project = NESTED_PROJECTS.find((entry) => 'template' in entry.manifest && entry.manifest.template === template);
  if (project === undefined) throw new Error(`no nested project uses the ${template} template`);
  return project;
}

describe('nested projects (#1514)', () => {
  test('the list names every project a scenario installs, directly or through a helper, and nothing else', () => {
    const installed = scenarioInstalls().sort(byAppAndPath);
    const declared = NESTED_PROJECTS.map(({ app, path }) => ({ app, path })).sort(byAppAndPath);
    expect(installed).toEqual(declared);
    expect(installed.map(({ app }) => app)).toEqual(expect.arrayContaining(['create-pyric-chat-app-check', 'create-pyric-chat-node-host', 'create-pyric-node-template', 'run-from-sibling-install']));
  });

  test('a project copied from its app names a directory with a package.json', () => {
    const copied = NESTED_PROJECTS.flatMap((project) => ('dir' in project.manifest ? [join(appsDir, project.app, project.manifest.dir, 'package.json')] : []));
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.filter((file) => !existsSync(file))).toEqual([]);
  });

  const PUBLISHED = ['pyric', 'pyric-admin', '@pyric/cli', '@pyric/ui', 'create-pyric'];
  /** The published tarballs under `dir`, as the runner maps them. */
  const tarballsIn = (dir: string): Tarballs => new Map(PUBLISHED.map((name) => [name, join(dir, `${name.replace('@', '').replace('/', '-')}.tgz`)]));
  const packedPackages = PUBLISHED.map((name) => packed(name, '0.1.0-alpha.1'));
  /** create-pyric from source, so the test needs no build. */
  const createPyric = [process.execPath, join(repoRoot, 'packages', 'create-pyric', 'src', 'bin.ts')];

  async function templateKey(project: NestedProject, tarballs: Tarballs): Promise<string> {
    const manifest = await nestedProjectManifest(project, { appsDir, createPyric, tarballs });
    return storeKey({ ...manifest, packed: packedPackages, platform: PLATFORM });
  }

  test.each(['chat', 'node'] as const)('the %s template keeps its key across two scaffolds, with tarballs in different places', async (template) => {
    const project = templateProject(template);
    const first = await templateKey(project, tarballsIn('/run-one/dist/packages'));
    const second = await templateKey(project, tarballsIn('/run-two/dist/packages'));
    expect(second).toBe(first);
    const scaffolded = await nestedProjectManifest(project, { appsDir, createPyric, tarballs: tarballsIn('/run-one/dist/packages') });
    const manifest = JSON.parse(scaffolded.manifest) as { name?: string; overrides?: Record<string, string> };
    expect(manifest.name).toBe(project.path);
    expect(Object.keys(manifest.overrides ?? {}).sort()).toEqual([...PUBLISHED].sort());
  }, 30_000);

  test('the chat and node templates have different keys', async () => {
    const tarballs = tarballsIn('/run-one/dist/packages');
    const keys = await Promise.all((['chat', 'node'] as const).map((template) => templateKey(templateProject(template), tarballs)));
    expect(new Set(keys).size).toBe(2);
  }, 30_000);
});
