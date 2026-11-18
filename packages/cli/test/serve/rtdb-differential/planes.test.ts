import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaneRunner } from './differential.js';
import { generateSequence } from './generator.js';
import { scratchRoot } from './planes.js';
import { portPair, tick } from './served-plane.js';

describe('RTDB differential scratch storage and Node plane isolation', () => {
  test('scratchRoot prefers /dev/shm on Linux when writable and falls back to tmpdir otherwise', () => {
    expect(
      scratchRoot({
        platform: 'linux',
        shmDir: '/dev/shm',
        checkWritable: () => {},
        fallbackTmpDir: () => '/fallback/tmp',
      }),
    ).toBe('/dev/shm');

    expect(
      scratchRoot({
        platform: 'linux',
        shmDir: '/dev/shm',
        checkWritable: () => {
          throw new Error('EACCES');
        },
        fallbackTmpDir: () => '/fallback/tmp',
      }),
    ).toBe('/fallback/tmp');

    expect(
      scratchRoot({
        platform: 'darwin',
        shmDir: '/dev/shm',
        checkWritable: () => {},
        fallbackTmpDir: () => '/var/folders/tmp',
      }),
    ).toBe('/var/folders/tmp');
  });

  test('Node plane keeps SQLite state under the runner scratch root without touching OS tmpdir', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'pyric-rtdb-planes-test-'));
    const customScratch = join(outer, 'shm');
    const readOnlyOsTmp = join(outer, 'os-tmp');
    mkdirSync(customScratch, { recursive: true });
    mkdirSync(readOnlyOsTmp, { recursive: true });
    chmodSync(readOnlyOsTmp, 0o555);

    const prevTmpDir = process.env.TMPDIR;
    try {
      const runner = await createPlaneRunner({ chunks: 1, scratchRoot: customScratch });
      try {
        expect(readdirSync(customScratch).length).toBe(1);
        process.env.TMPDIR = readOnlyOsTmp;
        const outcomes = await runner.run('node', [generateSequence(1, { minSteps: 6, maxSteps: 6 })]);
        expect(outcomes).toHaveLength(1);
        expect('fatal' in outcomes[0]!).toBe(false);
        expect(readdirSync(readOnlyOsTmp)).toEqual([]);
      } finally {
        if (prevTmpDir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prevTmpDir;
        runner.dispose();
      }
      expect(readdirSync(customScratch)).toEqual([]);
    } finally {
      chmodSync(readOnlyOsTmp, 0o755);
      if (existsSync(outer)) rmSync(outer, { recursive: true, force: true });
    }
  }, 60_000);

  test('portPair delivers structured-cloned messages asynchronously in FIFO order', async () => {
    const { page, host } = portPair();
    const received: Array<{ seq: number; items: string[] }> = [];
    let synchronousDelivery = false;

    host.onmessage = (event) => {
      received.push(event.data as { seq: number; items: string[] });
    };

    const first = { seq: 1, items: ['a'] };
    page.postMessage(first);
    first.items.push('mutated-after-send');
    page.postMessage({ seq: 2, items: ['b'] });
    page.postMessage({ seq: 3, items: ['c'] });

    if (received.length > 0) synchronousDelivery = true;
    await Promise.resolve();
    if (received.length > 0) synchronousDelivery = true;

    await tick();
    expect(synchronousDelivery).toBe(false);
    expect(received).toEqual([
      { seq: 1, items: ['a'] },
      { seq: 2, items: ['b'] },
      { seq: 3, items: ['c'] },
    ]);
  });
});
