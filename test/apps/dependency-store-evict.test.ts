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
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  evictServeCache,
  evictViteWorkerCache,
} from '../../packages/cli/src/serve/bundle-cache-evict.ts';
import { evictStandaloneServeCache } from '../../packages/cli/src/serve/standalone-cache-evict.ts';
import { HELD_SLOT_ENV, processStartOf } from '../../scripts/lib/heavy-run-slots.ts';
import {
  JOB_TMP_MARKER,
  createPrivateJobTmpDir,
  reapDeadPrivateJobTmpDirs,
  removePrivateJobTmpDir,
} from '../../scripts/lib/private-job-tmpdir.ts';
import {
  WARM_ENTRY_MARKER,
  isAllowlistedScenarioCacheRoot,
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

function makeAllowlistedCacheRoot(suffix: string): string {
  const parent = join(homedir(), '.cache');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `pyric-ut-${suffix}-`));
  tempRoots.push(dir);
  return dir;
}

function makeNonPyricCacheRoot(suffix: string): string {
  const parent = join(homedir(), '.cache');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `other-tool-ut-${suffix}-`));
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

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('dependency-store, scenario npm-cache, and private-job-tmpdir eviction', () => {
  it('prunes marker-verified stale .warm-* directories, outdated store formats, and LRU overflow entries while skipping unmarked dirs and symlinks', () => {
    const storeDir = makeAllowlistedCacheRoot('deps-evict');
    const externalTarget = makeTempRoot('pyric-deps-ext-');
    const nowMs = 1_800_000_000_000;

    const staleWarm = join(storeDir, '.warm-0123456789abcdef01234567-123');
    const unmarkedWarm = join(storeDir, '.warm-unmarked-999');
    const activeWarm = join(storeDir, '.warm-0123456789abcdef01234567-456');
    mkdirSync(staleWarm);
    writeFileSync(join(staleWarm, WARM_ENTRY_MARKER), '0123456789abcdef01234567\n');
    mkdirSync(unmarkedWarm);
    mkdirSync(activeWarm);
    writeFileSync(join(activeWarm, WARM_ENTRY_MARKER), '0123456789abcdef01234567\n');
    setAgeMs(staleWarm, nowMs, 3 * 3_600_000);
    setAgeMs(unmarkedWarm, nowMs, 10 * 3_600_000);
    setAgeMs(activeWarm, nowMs, 60_000);

    const unmarkedDir = join(storeDir, 'unrelated-daemon.sock.d');
    mkdirSync(unmarkedDir);
    writeFileSync(join(unmarkedDir, 'ipc.sock'), 'active');
    setAgeMs(unmarkedDir, nowMs, 10 * 3_600_000);

    writeFileSync(join(externalTarget, 'store.json'), JSON.stringify({ format: 1 }));
    setAgeMs(join(externalTarget, 'store.json'), nowMs, 10 * 3_600_000);
    setAgeMs(externalTarget, nowMs, 10 * 3_600_000);
    const symlinkEntry = join(storeDir, 'entry-symlink');
    symlinkSync(externalTarget, symlinkEntry);

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
      '.warm-0123456789abcdef01234567-123',
      'entry-1',
      'entry-2',
      'entry-old-format',
    ]);
    expect(existsSync(activeWarm)).toBe(true);
    expect(existsSync(unmarkedWarm)).toBe(true);
    expect(existsSync(unmarkedDir)).toBe(true);
    expect(lstatSync(symlinkEntry).isSymbolicLink()).toBe(true);
    expect(existsSync(externalTarget)).toBe(true);
    expect(existsSync(join(storeDir, 'entry-3'))).toBe(true);
    expect(existsSync(join(storeDir, 'entry-0'))).toBe(true);
  });

  it('prunes expired _logs/*.log files and cleans oversized _cacache only inside allowlisted roots when online without a sibling heavy-run slot', () => {
    const npmCache = makeAllowlistedCacheRoot('npm-cache');
    const slotsDir = makeTempRoot('pyric-heavy-slots-');
    const nowMs = 1_800_000_000_000;
    const logsDir = join(npmCache, '_logs');
    const cacacheDir = join(npmCache, '_cacache', 'content-v2');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(cacacheDir, { recursive: true });

    const oldLog = join(logsDir, '2026-11-01T00_00_00_000Z-debug-0.log');
    const freshLog = join(logsDir, '2026-11-18T11_00_00_000Z-debug-0.log');
    const nonLogFile = join(logsDir, 'keep.txt');
    writeFileSync(oldLog, 'old debug log');
    writeFileSync(freshLog, 'fresh debug log');
    writeFileSync(nonLogFile, 'keep');
    writeFileSync(join(cacacheDir, 'blob.bin'), 'x'.repeat(2_048));
    setAgeMs(oldLog, nowMs, 48 * 3_600_000);
    setAgeMs(freshLog, nowMs, 600_000);
    setAgeMs(nonLogFile, nowMs, 48 * 3_600_000);

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

    const offlineRemoved = pruneScenarioNpmCache(npmCache, {
      maxLogAgeMs: 24 * 3_600_000,
      maxCacheBytes: 1_024,
      offline: true,
      env: baseEnv,
      cleanCache: (dir) => cleaned.push(dir),
      nowMs,
    });
    expect(offlineRemoved).toEqual(['2026-11-01T00_00_00_000Z-debug-0.log']);
    expect(existsSync(nonLogFile)).toBe(true);
    expect(cleaned).toEqual([]);

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
    expect(existsSync(nonLogFile)).toBe(true);
  });

  it('reaps dead-PID marker-verified job tmpdirs inside allowlisted PYRIC_TEST_TMP_ROOT while skipping unmarked dirs, live-PID dirs, and symlinks', () => {
    const tmpParent = makeAllowlistedCacheRoot('job-tmp-parent');
    const externalTarget = makeTempRoot('pyric-job-tmp-ext-');
    writeFileSync(join(externalTarget, JOB_TMP_MARKER), '2147483646\n');

    const env = { ...process.env, PYRIC_TEST_TMP_ROOT: tmpParent };
    const liveDir = createPrivateJobTmpDir('live-job', env);
    expect(liveDir.startsWith(join(tmpParent, 'live-job-'))).toBe(true);

    const deadDir = join(tmpParent, 'dead-job-1');
    mkdirSync(deadDir);
    writeFileSync(join(deadDir, JOB_TMP_MARKER), '2147483646\n');

    const unmarkedDir = join(tmpParent, 'unmarked-job');
    mkdirSync(unmarkedDir);
    writeFileSync(join(unmarkedDir, 'keep.txt'), 'keep');

    const symlinkDir = join(tmpParent, 'symlink-job');
    symlinkSync(externalTarget, symlinkDir);

    const reaped = reapDeadPrivateJobTmpDirs(env);
    expect(reaped).toEqual(['dead-job-1']);
    expect(existsSync(deadDir)).toBe(false);
    expect(existsSync(liveDir)).toBe(true);
    expect(existsSync(unmarkedDir)).toBe(true);
    expect(lstatSync(symlinkDir).isSymbolicLink()).toBe(true);
    expect(existsSync(externalTarget)).toBe(true);

    expect(removePrivateJobTmpDir(unmarkedDir, env)).toBe(false);
    expect(removePrivateJobTmpDir(symlinkDir, env)).toBe(false);
    expect(removePrivateJobTmpDir(liveDir, env)).toBe(true);
    expect(existsSync(liveDir)).toBe(false);
  });

  it('refuses /tmp, tmpdir(), $HOME, ~/.pyric, ~/.cache, /run, /dev/shm, XDG_RUNTIME_DIR, and non-allowlisted directories across all cache and job-tmp evictors', () => {
    const tmpChild = makeTempRoot('pyric-refuse-tmp-child-');
    const fakeXdgRuntime = makeTempRoot('pyric-refuse-xdg-');
    const nonPyricCache = makeNonPyricCacheRoot('refuse');
    const nowMs = 1_800_000_000_000;

    for (const root of [tmpChild, fakeXdgRuntime, nonPyricCache]) {
      const storeEntry = join(root, 'entry-old');
      mkdirSync(storeEntry);
      writeFileSync(join(storeEntry, 'store.json'), JSON.stringify({ format: 0 }));
      setAgeMs(storeEntry, nowMs, 10 * 3_600_000);
      setAgeMs(storeEntry, nowMs, 10 * 3_600_000);

      mkdirSync(join(root, '_logs'), { recursive: true });
      const oldLog = join(root, '_logs', 'debug.log');
      writeFileSync(oldLog, 'log');
      setAgeMs(oldLog, nowMs, 48 * 3_600_000);

      writeFileSync(join(root, JOB_TMP_MARKER), '2147483646\n');
      const deadJob = join(root, 'job-dead-123');
      mkdirSync(deadJob);
      writeFileSync(join(deadJob, JOB_TMP_MARKER), '2147483646\n');
    }

    expect(isAllowlistedScenarioCacheRoot('/tmp')).toBe(false);
    expect(isAllowlistedScenarioCacheRoot(tmpdir())).toBe(false);
    expect(isAllowlistedScenarioCacheRoot(tmpChild)).toBe(false);
    expect(isAllowlistedScenarioCacheRoot(homedir())).toBe(false);
    expect(isAllowlistedScenarioCacheRoot(join(homedir(), '.pyric'))).toBe(false);
    expect(isAllowlistedScenarioCacheRoot(join(homedir(), '.cache'))).toBe(false);
    expect(isAllowlistedScenarioCacheRoot(nonPyricCache)).toBe(false);

    const cleanedNpm: string[] = [];
    withEnv({ XDG_RUNTIME_DIR: fakeXdgRuntime }, () => {
      for (const forbidden of [
        '/tmp',
        tmpdir(),
        tmpChild,
        homedir(),
        join(homedir(), '.pyric'),
        join(homedir(), '.cache'),
        nonPyricCache,
        '/run',
        '/dev/shm',
        fakeXdgRuntime,
      ]) {
        expect(pruneDependencyStore(forbidden, 1, { maxEntries: 0, minIdleMs: 1, staleWarmMs: 1, nowMs })).toEqual([]);
        expect(
          pruneScenarioNpmCache(forbidden, {
            maxLogAgeMs: 1,
            maxCacheBytes: 1,
            offline: false,
            cleanCache: (d) => cleanedNpm.push(d),
            nowMs,
          }),
        ).toEqual([]);
        expect(evictServeCache(forbidden, 'keep', 1, { maxEntries: 0, minAgeMs: 1, nowMs })).toEqual([]);
        expect(evictViteWorkerCache(forbidden, 'keep', { maxEntries: 0, minAgeMs: 1, nowMs })).toEqual([]);
        expect(evictStandaloneServeCache(forbidden, 'keep', { maxEntries: 0, minAgeMs: 1, nowMs })).toEqual([]);
        expect(removePrivateJobTmpDir(forbidden)).toBe(false);
        expect(
          removePrivateJobTmpDir(forbidden, {
            ...process.env,
            PYRIC_TEST_TMP_ROOT: dirname(forbidden),
          }),
        ).toBe(false);
        expect(
          removePrivateJobTmpDir(join(forbidden, 'job-dead-123'), {
            ...process.env,
            PYRIC_TEST_TMP_ROOT: forbidden,
          }),
        ).toBe(false);
        expect(
          reapDeadPrivateJobTmpDirs({
            ...process.env,
            PYRIC_TEST_TMP_ROOT: forbidden,
          }),
        ).toEqual([]);
      }
    });

    expect(cleanedNpm).toEqual([]);
    for (const root of [tmpChild, fakeXdgRuntime, nonPyricCache]) {
      expect(existsSync(join(root, 'entry-old'))).toBe(true);
      expect(existsSync(join(root, '_logs', 'debug.log'))).toBe(true);
      expect(existsSync(join(root, 'job-dead-123'))).toBe(true);
    }
  });
});
