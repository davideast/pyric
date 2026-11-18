import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELD_SLOT_ENV, processStartOf } from '../../scripts/lib/heavy-run-slots.ts';
import {
  pruneDependencyStore,
  pruneScenarioNpmCache,
  touchDependencyStoreEntry,
} from './dependency-store-evict.ts';

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

describe('dependency-store and scenario npm-cache eviction', () => {
  it('prunes stale .warm-* directories, outdated store formats, and LRU overflow entries while keeping recently touched entries', () => {
    const storeDir = makeTempRoot('pyric-deps-evict-');
    const nowMs = 1_800_000_000_000;

    const staleWarm = join(storeDir, '.warm-abc-123');
    const activeWarm = join(storeDir, '.warm-abc-456');
    mkdirSync(staleWarm);
    mkdirSync(activeWarm);
    setAgeMs(staleWarm, nowMs, 3 * 3_600_000);
    setAgeMs(activeWarm, nowMs, 60_000);

    const oldFormat = join(storeDir, 'entry-old-format');
    mkdirSync(oldFormat);
    writeFileSync(join(oldFormat, 'store.json'), JSON.stringify({ format: 0 }));
    setAgeMs(join(oldFormat, 'store.json'), nowMs, 4 * 3_600_000);
    setAgeMs(oldFormat, nowMs, 4 * 3_600_000);

    for (let i = 0; i < 4; i += 1) {
      const entry = join(storeDir, `entry-${i}`);
      mkdirSync(entry);
      writeFileSync(join(entry, 'store.json'), JSON.stringify({ format: 1 }));
      setAgeMs(join(entry, 'store.json'), nowMs, (i + 3) * 3_600_000);
      setAgeMs(entry, nowMs, (i + 3) * 3_600_000);
    }

    touchDependencyStoreEntry(join(storeDir, 'entry-3'), nowMs);

    const removed = pruneDependencyStore(storeDir, 1, {
      maxEntries: 2,
      minIdleMs: 7_200_000,
      staleWarmMs: 7_200_000,
      nowMs,
    });

    expect(removed.sort()).toEqual([
      '.warm-abc-123',
      'entry-1',
      'entry-2',
      'entry-old-format',
    ]);
    expect(existsSync(activeWarm)).toBe(true);
    expect(existsSync(join(storeDir, 'entry-3'))).toBe(true);
    expect(existsSync(join(storeDir, 'entry-0'))).toBe(true);
  });

  it('prunes expired _logs entries and cleans oversized _cacache only when online without a sibling heavy-run slot', () => {
    const npmCache = makeTempRoot('pyric-npm-cache-');
    const slotsDir = makeTempRoot('pyric-heavy-slots-');
    const nowMs = 1_800_000_000_000;
    const logsDir = join(npmCache, '_logs');
    const cacacheDir = join(npmCache, '_cacache', 'content-v2');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(cacacheDir, { recursive: true });

    const oldLog = join(logsDir, '2026-11-01T00_00_00_000Z-debug-0.log');
    const freshLog = join(logsDir, '2026-11-18T11_00_00_000Z-debug-0.log');
    writeFileSync(oldLog, 'old debug log');
    writeFileSync(freshLog, 'fresh debug log');
    writeFileSync(join(cacacheDir, 'blob.bin'), 'x'.repeat(2_048));
    setAgeMs(oldLog, nowMs, 48 * 3_600_000);
    setAgeMs(freshLog, nowMs, 600_000);

    const ownSlotPath = join(slotsDir, 'slot-0.lock');
    const siblingSlotPath = join(slotsDir, 'slot-1.lock');
    const liveHolder = {
      pid: process.pid,
      processStart: processStartOf(process.pid),
      host: hostname(),
      cwd: npmCache,
      command: 'bun test/apps/run.ts',
      takenAt: nowMs,
      token: 'live-holder-token',
    };
    writeFileSync(ownSlotPath, JSON.stringify(liveHolder));
    writeFileSync(siblingSlotPath, JSON.stringify({ ...liveHolder, token: 'sibling-token' }));

    const cleaned: string[] = [];
    const baseEnv = {
      PYRIC_HEAVY_RUN_DIR: slotsDir,
      [HELD_SLOT_ENV]: ownSlotPath,
    };

    // Offline mode never cleans _cacache.
    const offlineRemoved = pruneScenarioNpmCache(npmCache, {
      maxLogAgeMs: 24 * 3_600_000,
      maxCacheBytes: 1_024,
      offline: true,
      env: baseEnv,
      cleanCache: (dir) => cleaned.push(dir),
      nowMs,
    });
    expect(offlineRemoved).toEqual(['2026-11-01T00_00_00_000Z-debug-0.log']);
    expect(cleaned).toEqual([]);

    // Active sibling heavy-run slot defers _cacache clean.
    const siblingRemoved = pruneScenarioNpmCache(npmCache, {
      maxLogAgeMs: 24 * 3_600_000,
      maxCacheBytes: 1_024,
      offline: false,
      env: baseEnv,
      cleanCache: (dir) => cleaned.push(dir),
      nowMs,
    });
    expect(siblingRemoved).toEqual([]);
    expect(cleaned).toEqual([]);

    // Once sibling slot is gone, oversized _cacache is cleaned.
    rmSync(siblingSlotPath, { force: true });
    const onlineRemoved = pruneScenarioNpmCache(npmCache, {
      maxLogAgeMs: 24 * 3_600_000,
      maxCacheBytes: 1_024,
      offline: false,
      env: baseEnv,
      cleanCache: (dir) => cleaned.push(dir),
      nowMs,
    });
    expect(onlineRemoved).toEqual(['_cacache']);
    expect(cleaned).toEqual([npmCache]);
    expect(existsSync(freshLog)).toBe(true);
  });
});
