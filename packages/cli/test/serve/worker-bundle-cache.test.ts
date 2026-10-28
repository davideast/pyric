/**
 * Builders sharing one SharedWorker cache directory, as every project on a
 * machine shares `~/.pyric/vite-worker/<hash>`. Building in place let one
 * builder read another's half-written `worker.js`: it threw "omitted its
 * epoch placeholder" or returned an epoch no file on disk carried (#1214).
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { bundleWorker } from '../../src/serve/bundler.js';
import { withWorkerBuildLock } from '../../src/serve/worker-build-lock.js';

interface Fixture {
  root: string;
  outDir: string;
  /** A one-line worker entry whose output differs per `variant`, as real builds sometimes do. */
  entry(variant?: number): string;
}

function workerFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'pyric-worker-cache-'));
  return {
    root,
    outDir: join(root, 'cache'),
    entry(variant = 0) {
      const entryPath = join(root, `worker-${variant}.ts`);
      writeFileSync(entryPath, `globalThis.variant = ${variant};\nglobalThis.workerEpoch = __PYRIC_WORKER_VERSION__;`);
      return entryPath;
    },
  };
}

function onDisk(outDir: string): { epoch: string; worker: string } {
  return {
    epoch: readFileSync(join(outDir, '.worker-epoch'), 'utf8'),
    worker: readFileSync(join(outDir, 'worker.js'), 'utf8'),
  };
}

function readPidNamespace(): string | undefined {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}

/** Where an owner's pid can be checked from this process: this host, this pid namespace. */
const thisPidNamespace = { host: hostname(), pidNamespace: readPidNamespace() };

/** The pid of a process that has already exited. */
function exitedPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

function writeLock(outDir: string, owner: object | null): string {
  const lockDir = join(outDir, '.worker-build.lock');
  mkdirSync(lockDir, { recursive: true });
  if (owner) writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner));
  return lockDir;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a SharedWorker cache directory shared by concurrent builders', () => {
  it('gives every concurrent builder the bundle that is on disk, even when builds differ', async () => {
    const fixture = workerFixture();
    const entries = [1, 2, 3, 4].map((variant) => fixture.entry(variant));

    const results = await Promise.allSettled(entries.map((entryPath) => bundleWorker({ outDir: fixture.outDir, entryPath })));

    const failures = results.flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []));
    expect(failures).toEqual([]);
    const epochs = new Set(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.epoch] : [])));
    const published = onDisk(fixture.outDir);
    expect([...epochs]).toEqual([published.epoch]);
    expect(published.worker).toContain(published.epoch);
    expect(published.worker).not.toContain('PYRIC_EPOCH_HERE');
  }, 60_000);

  it('rebuilds a cache whose epoch file names a different worker', async () => {
    const fixture = workerFixture();
    const entryPath = fixture.entry();
    await bundleWorker({ outDir: fixture.outDir, entryPath });
    writeFileSync(join(fixture.outDir, '.worker-epoch'), '0123456789abcdef');

    const reread = await bundleWorker({ outDir: fixture.outDir, entryPath });

    expect(reread.epoch).not.toBe('0123456789abcdef');
    expect(onDisk(fixture.outDir).worker).toContain(reread.epoch);
  }, 30_000);

  it('removes staging directories and abandoned locks that killed builders left', async () => {
    const fixture = workerFixture();
    const leftStaging = join(dirname(fixture.outDir), '.cache.worker-killed');
    const leftLock = join(fixture.outDir, '.worker-build.lock.abandoned-killed');
    mkdirSync(leftStaging, { recursive: true });
    mkdirSync(leftLock, { recursive: true });
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    utimesSync(leftStaging, twoMinutesAgo, twoMinutesAgo);

    await bundleWorker({ outDir: fixture.outDir, entryPath: fixture.entry() });

    expect(existsSync(leftStaging)).toBe(false);
    expect(existsSync(leftLock)).toBe(false);
  }, 30_000);

  it('leaves a staging directory a live builder may still be writing to', async () => {
    const fixture = workerFixture();
    const liveStaging = join(dirname(fixture.outDir), '.cache.worker-live');
    mkdirSync(liveStaging, { recursive: true });

    await bundleWorker({ outDir: fixture.outDir, entryPath: fixture.entry() });

    expect(existsSync(liveStaging)).toBe(true);
  }, 30_000);
});

describe('the SharedWorker build lock', () => {
  it('a builder whose lock is taken over mid-build, and whose staging directory is removed, still resolves', async () => {
    // A builder in another pid namespace looks exited, so its lock can be taken
    // while it builds. The new holder may remove its staging directory.
    const fixture = workerFixture();
    const lockDir = join(fixture.outDir, '.worker-build.lock');
    let builds = 0;

    const built = await bundleWorker({
      outDir: fixture.outDir,
      entryPath: fixture.entry(),
      async buildInto(stagingDir, build) {
        builds += 1;
        const isFirstBuild = builds === 1;
        if (!isFirstBuild) return build();
        renameSync(lockDir, `${lockDir}.abandoned-taken`);
        writeLock(fixture.outDir, { pid: process.pid, ...thisPidNamespace, token: 'other-builder' });
        rmSync(stagingDir, { recursive: true, force: true });
        // The other builder finishes without publishing and releases its lock.
        setTimeout(() => rmSync(lockDir, { recursive: true, force: true }), 200);
        // Reading its own output now fails, as the first build's did in the report.
        return readFileSync(join(stagingDir, 'worker.js'), 'utf8');
      },
    });

    expect(builds).toBe(2);
    expect(onDisk(fixture.outDir).worker).toContain(built.epoch);
  }, 30_000);

  it('takes over a lock whose holder has exited', async () => {
    const fixture = workerFixture();
    const lockDir = writeLock(fixture.outDir, { pid: exitedPid(), ...thisPidNamespace, token: 'gone' });

    const built = await bundleWorker({ outDir: fixture.outDir, entryPath: fixture.entry() });

    expect(onDisk(fixture.outDir).worker).toContain(built.epoch);
    expect(existsSync(lockDir)).toBe(false);
  }, 30_000);

  it('does not take over a lock from another pid namespace until it goes stale', async () => {
    // A builder in a container sharing the home directory has a pid this process
    // cannot see. It looks exited, but it may still be building.
    const { outDir } = workerFixture();
    writeLock(outDir, { pid: exitedPid(), host: hostname(), pidNamespace: 'pid:[elsewhere]', token: 'theirs' });
    const started = Date.now();

    await withWorkerBuildLock(outDir, async () => 'ran', { staleMs: 400, pollMs: 10 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it('takes over a lock whose holder died before writing its owner', async () => {
    const fixture = workerFixture();
    const lockDir = writeLock(fixture.outDir, null);
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    utimesSync(lockDir, twoMinutesAgo, twoMinutesAgo);

    const built = await bundleWorker({ outDir: fixture.outDir, entryPath: fixture.entry() });

    expect(onDisk(fixture.outDir).worker).toContain(built.epoch);
  }, 30_000);

  it('keeps a live holder slower than the stale time, because it refreshes the lock', async () => {
    const { outDir } = workerFixture();
    const options = { staleMs: 200, heartbeatMs: 40, pollMs: 10 };
    let inside = 0;
    let mostInside = 0;
    const hold = (ms: number) =>
      withWorkerBuildLock(
        outDir,
        async (lock) => {
          inside++;
          mostInside = Math.max(mostInside, inside);
          await delay(ms);
          const stillHeld = lock.isHeld();
          inside--;
          return stillHeld;
        },
        options,
      );

    const slow = hold(600);
    await delay(50);
    const fast = hold(100);

    expect(await Promise.all([slow, fast])).toEqual([true, true]);
    expect(mostInside).toBe(1);
  });

  it('tells a holder it lost the lock once another process took it over', async () => {
    const { outDir } = workerFixture();

    const stillHeld = await withWorkerBuildLock(outDir, async (lock) => {
      writeFileSync(join(outDir, '.worker-build.lock', 'owner.json'), JSON.stringify({ pid: 1, host: 'other', token: 'theirs' }));
      return lock.isHeld();
    });

    expect(stillHeld).toBe(false);
    expect(existsSync(join(outDir, '.worker-build.lock'))).toBe(true);
  });

  it('names the lock when a live holder outlasts the wait', async () => {
    const { outDir } = workerFixture();
    let releaseHolder = (): void => {};
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withWorkerBuildLock(outDir, () => holderDone);

    const waiter = withWorkerBuildLock(outDir, async () => 'ran', { waitMs: 200, pollMs: 20 });

    await expect(waiter).rejects.toThrow('.worker-build.lock');
    releaseHolder();
    await holder;
    await expect(withWorkerBuildLock(outDir, async () => 'ran')).resolves.toBe('ran');
  });

  it('fails at once, naming the lock, when an abandoned lock cannot be moved (EPERM)', async () => {
    const { outDir } = workerFixture();
    const lockDir = writeLock(outDir, { pid: exitedPid(), ...thisPidNamespace, token: 'gone' });
    const refuse = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    const started = Date.now();

    const waiter = withWorkerBuildLock(outDir, async () => 'ran', { waitMs: 5_000, renameLock: refuse });

    await expect(waiter).rejects.toThrow(`cannot remove the abandoned SharedWorker build lock ${lockDir}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 10_000);

  it('keeps waiting, with timers running, when an abandoned lock vanishes before it moves', async () => {
    const { outDir } = workerFixture();
    writeLock(outDir, { pid: exitedPid(), ...thisPidNamespace, token: 'gone' });
    const vanished = () => {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
    };
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);

    const waiter = withWorkerBuildLock(outDir, async () => 'ran', { waitMs: 200, pollMs: 20, renameLock: vanished });

    await expect(waiter).rejects.toThrow('waited');
    clearInterval(ticker);
    expect(ticks).toBeGreaterThan(5);
  });
});
