import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey } from '../../src/serve/bundler.js';
import {
  evictServeCache,
  evictStandaloneTempDirs,
  evictViteWorkerCache,
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

function setAgeMs(path: string, nowMs: number, ageMs: number): void {
  const secs = (nowMs - ageMs) / 1000;
  utimesSync(path, secs, secs);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('bundle cache eviction (serve-cache, vite-worker, standalone)', () => {
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

  it('evicts stale overflow serve-cache entries and incomplete .no-cache-* builds while keeping live completed .no-cache-* servers', () => {
    const root = makeTempRoot('pyric-evict-serve-');
    const nowMs = 1_800_000_000_000;
    const minAgeMs = 7_200_000;

    for (let i = 0; i < 5; i += 1) {
      const entry = join(root, `0.1.0-hash${i}`);
      mkdirSync(entry, { recursive: true });
      setAgeMs(entry, nowMs, (i + 1) * 3_600_000);
    }
    const incompleteNoCache = join(root, '.no-cache-0.1.0-incomplete');
    const liveCompletedNoCache = join(root, '.no-cache-0.1.0-live-complete');
    const expiredCompletedNoCache = join(root, '.no-cache-0.1.0-expired-complete');
    const freshNoCache = join(root, '.no-cache-0.1.0-fresh');
    mkdirSync(incompleteNoCache);
    mkdirSync(join(liveCompletedNoCache, 'sdk'), { recursive: true });
    writeFileSync(join(liveCompletedNoCache, 'sdk', '.complete'), 'done');
    mkdirSync(join(expiredCompletedNoCache, 'sdk'), { recursive: true });
    writeFileSync(join(expiredCompletedNoCache, 'sdk', '.complete'), 'done');
    mkdirSync(freshNoCache);
    setAgeMs(incompleteNoCache, nowMs, 600_000);
    setAgeMs(liveCompletedNoCache, nowMs, 600_000);
    setAgeMs(expiredCompletedNoCache, nowMs, 3 * 3_600_000);
    setAgeMs(freshNoCache, nowMs, 10_000);

    // Touch hash4 so it becomes brand-new and survives LRU pruning.
    touchBundleCacheDir(join(root, '0.1.0-hash4'), nowMs);

    const removed = evictServeCache(root, '0.1.0-current', 60_000, {
      maxEntries: 3,
      minAgeMs,
      nowMs,
    });

    expect(removed.sort()).toEqual([
      '.no-cache-0.1.0-expired-complete',
      '.no-cache-0.1.0-incomplete',
      '0.1.0-hash1',
      '0.1.0-hash2',
      '0.1.0-hash3',
    ]);
    expect(existsSync(liveCompletedNoCache)).toBe(true);
    expect(existsSync(freshNoCache)).toBe(true);
    expect(existsSync(join(root, '0.1.0-hash4'))).toBe(true);
    expect(existsSync(join(root, '0.1.0-hash0'))).toBe(true);
  });

  it('evicts overflow vite-worker bundles and expired salted bundles while skipping locked builds', () => {
    const root = makeTempRoot('pyric-evict-worker-');
    const nowMs = 1_800_000_000_000;

    for (let i = 0; i < 4; i += 1) {
      const entry = join(root, `unsalted-${i}`);
      mkdirSync(entry);
      setAgeMs(entry, nowMs, (i + 3) * 3_600_000);
    }
    writeFileSync(join(root, 'unsalted-3', LOCK_DIR), 'locked');
    setAgeMs(join(root, 'unsalted-3'), nowMs, 10 * 3_600_000);

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
  });

  it('disposes salted vite-worker directories on runtime.dispose() without deleting shared unsalted cache', async () => {
    const root = makeTempRoot('pyric-worker-dispose-');
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
    expect(existsSync(saltedDir)).toBe(true);
    runtime.dispose?.();
    expect(existsSync(saltedDir)).toBe(false);
    expect(runtime.status()).toEqual({ sdkDir: sharedDir, ready: false, epoch: null });
  });

  it('evicts superseded standalone pyric-serve-* temp dirs older than minAgeMs', () => {
    const fakeTmp = makeTempRoot('pyric-standalone-tmp-');
    const nowMs = 1_800_000_000_000;
    const oldStand = join(fakeTmp, 'pyric-serve-0.1.0-oldasset');
    const recentStand = join(fakeTmp, 'pyric-serve-0.1.0-recentasset');
    const currentStand = join(fakeTmp, 'pyric-serve-0.1.0-currentasset');
    const unrelated = join(fakeTmp, 'other-dir');
    for (const d of [oldStand, recentStand, currentStand, unrelated]) {
      mkdirSync(d);
    }
    setAgeMs(oldStand, nowMs, 3 * 3_600_000);
    setAgeMs(recentStand, nowMs, 600_000);
    setAgeMs(unrelated, nowMs, 10 * 3_600_000);

    const removed = evictStandaloneTempDirs(
      fakeTmp,
      'pyric-serve-0.1.0-currentasset',
      7_200_000,
      nowMs,
    );
    expect(removed).toEqual(['pyric-serve-0.1.0-oldasset']);
    expect(existsSync(recentStand)).toBe(true);
    expect(existsSync(currentStand)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});
