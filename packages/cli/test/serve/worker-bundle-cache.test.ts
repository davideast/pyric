/**
 * Builders sharing one SharedWorker cache directory, as every project on a
 * machine shares `~/.pyric/vite-worker/<hash>`. Building in place let one
 * builder read another's half-written `worker.js`: it threw "omitted its
 * epoch placeholder" or returned an epoch no file on disk carried.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { bundleWorker } from '../../src/serve/bundler.js';
import { withWorkerBuildLock } from '../../src/serve/worker-bundle-cache.js';

/** A one-line worker entry: fast to build, and it still carries the epoch slot. */
function workerFixture(): { root: string; entryPath: string; outDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pyric-worker-cache-'));
  const entryPath = join(root, 'worker.ts');
  writeFileSync(entryPath, 'globalThis.workerEpoch = __PYRIC_WORKER_VERSION__;');
  return { root, entryPath, outDir: join(root, 'cache') };
}

function publishedEpoch(outDir: string): { epoch: string; worker: string } {
  return {
    epoch: readFileSync(join(outDir, '.worker-epoch'), 'utf8'),
    worker: readFileSync(join(outDir, 'worker.js'), 'utf8'),
  };
}

/** The pid of a process that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid;
}

describe('a SharedWorker cache directory shared by concurrent builders', () => {
  it('gives every concurrent builder the bundle that is on disk', async () => {
    const { entryPath, outDir } = workerFixture();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => bundleWorker({ outDir, entryPath })));

    const failures = results.flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []));
    expect(failures).toEqual([]);
    const epochs = new Set(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.epoch] : [])));
    const onDisk = publishedEpoch(outDir);
    expect([...epochs]).toEqual([onDisk.epoch]);
    expect(onDisk.worker).toContain(onDisk.epoch);
    expect(onDisk.worker).not.toContain('PYRIC_EPOCH_HERE');
  }, 60_000);

  it('rebuilds a cache whose epoch file names a different worker', async () => {
    const { entryPath, outDir } = workerFixture();
    await bundleWorker({ outDir, entryPath });
    writeFileSync(join(outDir, '.worker-epoch'), '0123456789abcdef');

    const reread = await bundleWorker({ outDir, entryPath });

    expect(reread.epoch).not.toBe('0123456789abcdef');
    expect(publishedEpoch(outDir).worker).toContain(reread.epoch);
  }, 30_000);

  it('takes over a build lock whose holder has exited', async () => {
    const { entryPath, outDir } = workerFixture();
    const lockDir = join(outDir, '.worker-build.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: exitedPid(), host: hostname(), token: 'gone' }));

    const built = await bundleWorker({ outDir, entryPath });

    expect(publishedEpoch(outDir).worker).toContain(built.epoch);
    expect(existsSync(lockDir)).toBe(false);
  }, 30_000);

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
});
