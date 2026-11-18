import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleWorker, cacheKey } from '../../src/serve/bundler.js';
import {
  NO_CACHE_MARKER,
  SALTED_WORKER_MARKER,
  createNoCacheGenerationDir,
  disposeNoCacheGenerationDir,
  evictServeCache,
  evictViteWorkerCache,
  isAllowlistedPyricCacheRoot,
  isDefaultViteWorkerCacheRoot,
  markSaltedWorkerDir,
  touchBundleCacheDir,
} from '../../src/serve/bundle-cache-evict.js';
import { createViteWorkerRuntime } from '../../src/serve/vite-worker-runtime.js';
import { LOCK_DIR } from '../../src/serve/worker-build-lock.js';

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeAllowlistedCacheRoot(suffix: string): string {
  const cacheParent = join(homedir(), '.cache');
  mkdirSync(cacheParent, { recursive: true });
  const dir = mkdtempSync(join(cacheParent, `pyric-ut-${suffix}-`));
  tempRoots.push(dir);
  return dir;
}

function setAgeMs(path: string, nowMs: number, ageMs: number): void {
  const secs = (nowMs - ageMs) / 1000;
  utimesSync(path, secs, secs);
}

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withEnvAsync<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('bundle cache eviction (serve-cache and vite-worker)', () => {
  it('produces identical cacheKey across distinct project directories with identical firebase package.json', () => {
    const root = makeTempRoot('pyric-cachekey-fb-');
    const entryPath = join(root, 'entry.ts');
    writeFileSync(entryPath, 'export const ok = 1;');

    const projectA = join(root, 'proj-a');
    const projectB = join(root, 'proj-b');
    const fbManifest = JSON.stringify({ name: 'firebase', version: '12.19.0', main: 'index.js' });
    for (const proj of [projectA, projectB]) {
      mkdirSync(join(proj, 'node_modules', 'firebase'), { recursive: true });
      writeFileSync(join(proj, 'node_modules', 'firebase', 'package.json'), fbManifest);
    }

    const keyA = cacheKey({ entries: { app: entryPath }, projectFirebase: { projectDir: projectA } }, '1.0.0');
    const keyB = cacheKey({ entries: { app: entryPath }, projectFirebase: { projectDir: projectB } }, '1.0.0');
    expect(keyA).toBe(keyB);
  });

  it('evicts stale marker-verified serve-cache entries and .no-cache-* builds while preserving unmarked dirs and symlinks', () => {
    const root = makeTempRoot('pyric-evict-serve-');
    const externalTarget = makeTempRoot('pyric-serve-ext-');
    const nowMs = 1_800_000_000_000;
    const minAgeMs = 7_200_000;

    for (let i = 0; i < 5; i += 1) {
      const entry = join(root, `0.1.0-hash${i}`);
      mkdirSync(join(entry, 'sdk'), { recursive: true });
      writeFileSync(join(entry, 'sdk', '.complete'), 'done');
      setAgeMs(entry, nowMs, (i + 1) * 3_600_000);
    }
    const unrelatedDir = join(root, 'unrelated-daemon.sock.d');
    mkdirSync(unrelatedDir, { recursive: true });
    writeFileSync(join(unrelatedDir, 'ipc.sock'), 'socket');
    setAgeMs(unrelatedDir, nowMs, 10 * 3_600_000);

    mkdirSync(join(externalTarget, 'sdk'), { recursive: true });
    writeFileSync(join(externalTarget, 'sdk', '.complete'), 'done');
    setAgeMs(externalTarget, nowMs, 10 * 3_600_000);
    const symlinkEntry = join(root, '0.1.0-symlink');
    symlinkSync(externalTarget, symlinkEntry);

    const incompleteNoCache = join(root, '.no-cache-0.1.0-incomplete');
    const unmarkedNoCache = join(root, '.no-cache-0.1.0-unmarked');
    const liveCompletedNoCache = join(root, '.no-cache-0.1.0-live-complete');
    const expiredCompletedNoCache = join(root, '.no-cache-0.1.0-expired-complete');
    const freshNoCache = join(root, '.no-cache-0.1.0-fresh');
    mkdirSync(incompleteNoCache);
    writeFileSync(join(incompleteNoCache, NO_CACHE_MARKER), '1');
    mkdirSync(unmarkedNoCache);
    mkdirSync(join(liveCompletedNoCache, 'sdk'), { recursive: true });
    writeFileSync(join(liveCompletedNoCache, 'sdk', '.complete'), 'done');
    mkdirSync(join(expiredCompletedNoCache, 'sdk'), { recursive: true });
    writeFileSync(join(expiredCompletedNoCache, 'sdk', '.complete'), 'done');
    mkdirSync(freshNoCache);
    writeFileSync(join(freshNoCache, NO_CACHE_MARKER), '1');
    setAgeMs(incompleteNoCache, nowMs, 600_000);
    setAgeMs(unmarkedNoCache, nowMs, 10 * 3_600_000);
    setAgeMs(liveCompletedNoCache, nowMs, 600_000);
    setAgeMs(expiredCompletedNoCache, nowMs, 3 * 3_600_000);
    setAgeMs(freshNoCache, nowMs, 10_000);

    touchBundleCacheDir(join(root, '0.1.0-hash4'), nowMs);

    const removed = evictServeCache(root, '0.1.0-current', 60_000, {
      maxEntries: 3,
      minAgeMs,
      nowMs,
      allowCustomRootForTesting: true,
    });

    expect(removed.sort()).toEqual([
      '.no-cache-0.1.0-expired-complete',
      '.no-cache-0.1.0-incomplete',
      '0.1.0-hash1',
      '0.1.0-hash2',
      '0.1.0-hash3',
    ]);
    expect(existsSync(unmarkedNoCache)).toBe(true);
    expect(existsSync(liveCompletedNoCache)).toBe(true);
    expect(existsSync(freshNoCache)).toBe(true);
    expect(existsSync(join(root, '0.1.0-hash4'))).toBe(true);
    expect(existsSync(join(root, '0.1.0-hash0'))).toBe(true);
    expect(existsSync(unrelatedDir)).toBe(true);
    expect(lstatSync(symlinkEntry).isSymbolicLink()).toBe(true);
    expect(existsSync(externalTarget)).toBe(true);

    // disposeNoCacheGenerationDir requires non-symlink directory + marker.
    disposeNoCacheGenerationDir(unmarkedNoCache);
    expect(existsSync(unmarkedNoCache)).toBe(true);
    const ownedGen = createNoCacheGenerationDir(root, '0.1.0-owned');
    expect(existsSync(join(ownedGen, NO_CACHE_MARKER))).toBe(true);
    disposeNoCacheGenerationDir(ownedGen);
    expect(existsSync(ownedGen)).toBe(false);
  });

  it('evicts overflow vite-worker bundles and expired salted bundles while skipping locked builds, unrelated dirs, and symlinks', () => {
    const root = makeTempRoot('pyric-evict-worker-');
    const externalTarget = makeTempRoot('pyric-worker-ext-');
    const nowMs = 1_800_000_000_000;

    for (let i = 0; i < 4; i += 1) {
      const entry = join(root, `unsalted-${i}`);
      mkdirSync(entry);
      writeFileSync(join(entry, '.worker-complete'), `hash-${i}`);
      setAgeMs(entry, nowMs, (i + 3) * 3_600_000);
    }
    writeFileSync(join(root, 'unsalted-3', LOCK_DIR), 'locked');
    setAgeMs(join(root, 'unsalted-3'), nowMs, 10 * 3_600_000);

    const unrelatedDir = join(root, 'unrelated-daemon.sock.d');
    mkdirSync(unrelatedDir);
    writeFileSync(join(unrelatedDir, 'ipc.sock'), 'socket');
    setAgeMs(unrelatedDir, nowMs, 10 * 3_600_000);

    writeFileSync(join(externalTarget, '.worker-complete'), 'external');
    setAgeMs(externalTarget, nowMs, 10 * 3_600_000);
    const symlinkEntry = join(root, 'unsalted-symlink');
    symlinkSync(externalTarget, symlinkEntry);

    for (let i = 0; i < 4; i += 1) {
      const saltedDir = join(root, `key-salt${i}`);
      mkdirSync(saltedDir);
      markSaltedWorkerDir(saltedDir);
      setAgeMs(saltedDir, nowMs, (i + 1) * 3_600_000);
    }

    const deadProjSalted = join(root, 'key-deadproj');
    mkdirSync(deadProjSalted);
    markSaltedWorkerDir(deadProjSalted, JSON.stringify({ projectKey: join(root, 'deleted-app') }));
    setAgeMs(deadProjSalted, nowMs, 1_000);

    const liveProjSalted = join(root, 'key-liveproj');
    mkdirSync(liveProjSalted);
    markSaltedWorkerDir(liveProjSalted, JSON.stringify({ projectKey: root }));
    setAgeMs(liveProjSalted, nowMs, 1_000);

    const removed = evictViteWorkerCache(root, 'unsalted-current', {
      maxEntries: 2,
      saltedMaxEntries: 2,
      minAgeMs: 7_200_000,
      saltedMinAgeMs: 1_800_000,
      nowMs,
      allowCustomRootForTesting: true,
    });

    expect(removed.sort()).toEqual([
      'key-deadproj',
      'key-salt1',
      'key-salt2',
      'key-salt3',
      'unsalted-1',
      'unsalted-2',
    ]);
    expect(existsSync(join(root, 'unsalted-3'))).toBe(true);
    expect(existsSync(join(root, 'unsalted-0'))).toBe(true);
    expect(existsSync(join(root, 'key-liveproj'))).toBe(true);
    expect(existsSync(join(root, 'key-salt0'))).toBe(true);
    expect(existsSync(unrelatedDir)).toBe(true);
    expect(lstatSync(symlinkEntry).isSymbolicLink()).toBe(true);
    expect(existsSync(externalTarget)).toBe(true);
  });

  it('allows eviction only inside ~/.pyric/<subroot> or ~/.cache/pyric-* and refuses /tmp, tmpdir(), /run, /dev/shm, XDG_RUNTIME_DIR, and $HOME', () => {
    const nonAllowlistedSubdir = makeTempRoot('pyric-non-allowlisted-');
    const fakeXdgRuntime = makeTempRoot('pyric-fake-xdg-runtime-');
    const linkParent = makeTempRoot('pyric-link-parent-');
    const symlinkToTmp = join(linkParent, 'tmp-link');
    symlinkSync(nonAllowlistedSubdir, symlinkToTmp);
    const allowlistedCacheDir = makeAllowlistedCacheRoot('allowlist');
    const nowMs = 1_800_000_000_000;

    for (const base of [nonAllowlistedSubdir, fakeXdgRuntime, allowlistedCacheDir]) {
      const workerDir = join(base, 'pyric-worker-old');
      const serveDir = join(base, '0.1.0-old');
      const unrelatedSocketDir = join(base, 'unrelated-daemon.sock.d');
      mkdirSync(workerDir);
      writeFileSync(join(workerDir, '.worker-complete'), 'abc');
      mkdirSync(join(serveDir, 'sdk'), { recursive: true });
      writeFileSync(join(serveDir, 'sdk', '.complete'), 'done');
      mkdirSync(unrelatedSocketDir);
      for (const d of [workerDir, serveDir, unrelatedSocketDir]) {
        setAgeMs(d, nowMs, 10 * 3_600_000);
      }
    }

    // Without allowCustomRootForTesting, even a subdirectory under tmpdir() is refused by the allowlist.
    expect(isAllowlistedPyricCacheRoot(nonAllowlistedSubdir)).toBe(false);
    expect(isAllowlistedPyricCacheRoot(tmpdir())).toBe(false);
    expect(isAllowlistedPyricCacheRoot('/tmp')).toBe(false);
    expect(isAllowlistedPyricCacheRoot(homedir())).toBe(false);
    expect(isAllowlistedPyricCacheRoot(join(homedir(), '.pyric'))).toBe(false);
    expect(isAllowlistedPyricCacheRoot(join(homedir(), '.cache'))).toBe(false);
    expect(isAllowlistedPyricCacheRoot(allowlistedCacheDir)).toBe(true);

    expect(evictViteWorkerCache(nonAllowlistedSubdir, 'current', { maxEntries: 1, minAgeMs: 1, nowMs })).toEqual([]);
    expect(evictServeCache(nonAllowlistedSubdir, 'current', 1, { maxEntries: 1, minAgeMs: 1, nowMs })).toEqual([]);
    expect(existsSync(join(nonAllowlistedSubdir, 'pyric-worker-old'))).toBe(true);
    expect(existsSync(join(nonAllowlistedSubdir, '0.1.0-old'))).toBe(true);

    // Even with allowCustomRootForTesting: true, the second-layer denylist refuses TMPDIR, XDG_RUNTIME_DIR, /, /tmp, /run, /dev/shm, $HOME, ~/.pyric, and ~/.cache.
    withEnv(
      { TMPDIR: nonAllowlistedSubdir, TEMP: nonAllowlistedSubdir, TMP: nonAllowlistedSubdir, XDG_RUNTIME_DIR: fakeXdgRuntime },
      () => {
        for (const candidate of [
          nonAllowlistedSubdir,
          symlinkToTmp,
          fakeXdgRuntime,
          '/',
          '/tmp',
          '/run',
          '/dev/shm',
          homedir(),
          join(homedir(), '.pyric'),
          join(homedir(), '.cache'),
        ]) {
          expect(
            evictViteWorkerCache(candidate, 'current', {
              maxEntries: 1,
              minAgeMs: 1,
              nowMs,
              allowCustomRootForTesting: true,
            }),
          ).toEqual([]);
          expect(
            evictServeCache(candidate, 'current', 1, {
              maxEntries: 1,
              minAgeMs: 1,
              nowMs,
              allowCustomRootForTesting: true,
            }),
          ).toEqual([]);
        }
      },
    );
    expect(existsSync(join(nonAllowlistedSubdir, 'pyric-worker-old'))).toBe(true);
    expect(existsSync(join(fakeXdgRuntime, 'pyric-worker-old'))).toBe(true);

    // Inside allowlisted ~/.cache/pyric-*, marker-verified entries are evicted while unrelated dirs remain untouched.
    expect(evictViteWorkerCache(allowlistedCacheDir, 'current', { maxEntries: 1, minAgeMs: 1, nowMs })).toEqual([
      'pyric-worker-old',
    ]);
    expect(evictServeCache(allowlistedCacheDir, 'current', 1, { maxEntries: 1, minAgeMs: 1, nowMs })).toEqual([
      '0.1.0-old',
    ]);
    expect(existsSync(join(allowlistedCacheDir, 'unrelated-daemon.sock.d'))).toBe(true);
    expect(isDefaultViteWorkerCacheRoot(join(homedir(), '.pyric', 'vite-worker'))).toBe(true);
    expect(isDefaultViteWorkerCacheRoot(tmpdir())).toBe(false);
  });

  it('gates sibling eviction in bundleWorker on noCache=false, allowlisted root, and worker markers', async () => {
    const nonAllowlistedParent = makeTempRoot('pyric-bundle-worker-tmp-');
    const allowlistedParent = makeAllowlistedCacheRoot('bundle-worker');
    const entryDir = makeTempRoot('pyric-bundle-worker-entry-');
    const externalTarget = makeTempRoot('pyric-bundle-worker-ext-');
    const entryPath = join(entryDir, 'entry.ts');
    writeFileSync(entryPath, 'globalThis.workerEpoch = __PYRIC_WORKER_VERSION__;');

    const nowMs = Date.now();
    for (const parent of [nonAllowlistedParent, allowlistedParent]) {
      const oldWorker = join(parent, 'old-worker');
      const unrelatedDir = join(parent, 'unrelated-daemon.sock.d');
      mkdirSync(oldWorker);
      writeFileSync(join(oldWorker, '.worker-complete'), 'stale-hash');
      mkdirSync(unrelatedDir);
      writeFileSync(join(unrelatedDir, 'ipc.sock'), 'socket');
      setAgeMs(oldWorker, nowMs, 4 * 3_600_000);
      setAgeMs(unrelatedDir, nowMs, 4 * 3_600_000);
    }
    writeFileSync(join(externalTarget, '.worker-complete'), 'external-hash');
    setAgeMs(externalTarget, nowMs, 4 * 3_600_000);
    const symWorker = join(allowlistedParent, 'sym-worker');
    symlinkSync(externalTarget, symWorker);

    await withEnvAsync({ PYRIC_VITE_WORKER_MAX_ENTRIES: '1' }, async () => {
      // 1. Non-allowlisted parent (e.g. under tmpdir()) never evicts siblings even with evictCache: true.
      await bundleWorker({
        outDir: join(nonAllowlistedParent, 'tmp-evict-run'),
        evictCache: true,
        minify: false,
        entryPath,
      });
      expect(existsSync(join(nonAllowlistedParent, 'old-worker'))).toBe(true);
      expect(existsSync(join(nonAllowlistedParent, 'unrelated-daemon.sock.d'))).toBe(true);

      // 2. Allowlisted parent with noCache: true never evicts siblings.
      await bundleWorker({
        outDir: join(allowlistedParent, 'nocache-run'),
        noCache: true,
        evictCache: true,
        minify: false,
        entryPath,
      });
      expect(existsSync(join(allowlistedParent, 'old-worker'))).toBe(true);

      // 3. Allowlisted parent without evictCache opt-in never evicts siblings.
      await bundleWorker({
        outDir: join(allowlistedParent, 'custom-run'),
        minify: false,
        entryPath,
      });
      expect(existsSync(join(allowlistedParent, 'old-worker'))).toBe(true);

      // 4. Allowlisted parent with evictCache: true evicts only old worker-marked dirs, keeping unrelated dirs and symlinks.
      await bundleWorker({
        outDir: join(allowlistedParent, 'managed-run'),
        evictCache: true,
        minify: false,
        entryPath,
      });
      expect(existsSync(join(allowlistedParent, 'old-worker'))).toBe(false);
      expect(existsSync(join(allowlistedParent, 'unrelated-daemon.sock.d'))).toBe(true);
      expect(lstatSync(symWorker).isSymbolicLink()).toBe(true);
      expect(existsSync(externalTarget)).toBe(true);
    });
  }, 30_000);

  it('stamps .salted-worker on salted prepare() and checks marker + lstat in runtime.dispose()', async () => {
    const root = makeAllowlistedCacheRoot('worker-dispose');
    const externalTarget = makeTempRoot('pyric-dispose-ext-');
    writeFileSync(join(externalTarget, SALTED_WORKER_MARKER), '1');

    const runtime = createViteWorkerRuntime({
      cacheRoot: root,
      cacheKey: 'sharedhash',
      bundle: async ({ outDir }) => {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'worker.js'), '// worker');
        return { outFile: join(outDir, 'worker.js'), epoch: '0123456789abcdef' };
      },
    });

    await runtime.prepare();
    const sharedDir = runtime.status().sdkDir;
    expect(existsSync(sharedDir)).toBe(true);
    runtime.dispose?.();
    expect(existsSync(sharedDir)).toBe(true);

    await runtime.prepare('boot-salt-1');
    const saltedDir = runtime.status().sdkDir;
    expect(saltedDir).not.toBe(sharedDir);
    expect(existsSync(join(saltedDir, SALTED_WORKER_MARKER))).toBe(true);
    runtime.dispose?.();
    expect(existsSync(saltedDir)).toBe(false);
    expect(runtime.status()).toEqual({ sdkDir: sharedDir, ready: false, epoch: null });

    // Without .salted-worker marker, dispose() refuses deletion.
    await runtime.prepare('boot-salt-unmarked');
    const unmarkedSaltedDir = runtime.status().sdkDir;
    rmSync(join(unmarkedSaltedDir, SALTED_WORKER_MARKER), { force: true });
    runtime.dispose?.();
    expect(existsSync(unmarkedSaltedDir)).toBe(true);

    // Symlinked salted dir is never followed or deleted by dispose().
    await runtime.prepare('boot-salt-symlink');
    const symSaltedDir = runtime.status().sdkDir;
    rmSync(symSaltedDir, { recursive: true, force: true });
    symlinkSync(externalTarget, symSaltedDir);
    runtime.dispose?.();
    expect(lstatSync(symSaltedDir).isSymbolicLink()).toBe(true);
    expect(existsSync(externalTarget)).toBe(true);
  });
});
