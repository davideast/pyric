import { describe, expect, it } from 'bun:test';
import {
  PYRIC_WORKER_GENERATION_KEY,
  preflightWorkerEpochStorage,
  rememberWorkerEpoch,
  workerNameForEpoch,
} from '../../../src/serve/runtime/worker-generation.js';
import { createWorkerReplacement } from '../../../src/serve/runtime/worker-replacement.js';

describe('page worker replacement', () => {
  it('requests retirement and reloads once when the worker broadcasts replacement', async () => {
    let notify: ((epoch: string) => void) | undefined;
    let retireCalls = 0;
    let reloads = 0;
    const scheduled: Array<() => void> = [];
    const prepared: string[] = [];
    let preflights = 0;
    const replacement = createWorkerReplacement({
      targetEpoch: '0123456789abcdef',
      retire: async () => { retireCalls += 1; },
      subscribeReload: (listener) => {
        notify = listener;
        return () => { notify = undefined; };
      },
      preflight: () => { preflights += 1; },
      commitGeneration: (epoch) => { prepared.push(epoch); },
      reload: () => { reloads += 1; },
      schedule: (run) => { scheduled.push(run); },
    });

    await replacement.request();
    notify?.('0123456789abcdef');
    notify?.('0123456789abcdef');

    expect(retireCalls).toBe(1);
    expect(preflights).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(prepared).toEqual(['0123456789abcdef']);
    scheduled[0]?.();
    expect(reloads).toBe(1);
    replacement.dispose();
  });

  it('does not retire the live worker when successor identity cannot be prepared', async () => {
    let retireCalls = 0;
    const replacement = createWorkerReplacement({
      targetEpoch: '0123456789abcdef',
      retire: async () => { retireCalls += 1; },
      subscribeReload: () => () => {},
      preflight: () => { throw new Error('origin storage unavailable'); },
      commitGeneration() {},
      reload() {},
    });

    await expect(replacement.request()).rejects.toThrow('origin storage unavailable');
    expect(retireCalls).toBe(0);
  });

  it('does not publish successor identity when retirement fails', async () => {
    let commits = 0;
    const replacement = createWorkerReplacement({
      targetEpoch: '0123456789abcdef',
      retire: async () => { throw new Error('drain timed out'); },
      subscribeReload: () => () => {},
      preflight() {},
      commitGeneration: () => { commits += 1; },
      reload() {},
    });

    await expect(replacement.request()).rejects.toThrow('drain timed out');
    expect(commits).toBe(0);
  });

  it('keeps tabs opened during drain on the active generation', async () => {
    const values = new Map([[PYRIC_WORKER_GENERATION_KEY, 'aaaaaaaaaaaaaaaa']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    let finishRetirement: (() => void) | undefined;
    const retirement = new Promise<void>((resolve) => { finishRetirement = resolve; });
    const replacement = createWorkerReplacement({
      targetEpoch: 'bbbbbbbbbbbbbbbb',
      retire: () => retirement,
      subscribeReload: () => () => {},
      preflight: () => preflightWorkerEpochStorage(storage),
      commitGeneration: (epoch) => rememberWorkerEpoch(epoch, storage),
      reload() {},
    });

    const request = replacement.request();
    expect(workerNameForEpoch('bbbbbbbbbbbbbbbb', storage)).toBe(
      'pyric-shared-worker:aaaaaaaaaaaaaaaa',
    );

    finishRetirement?.();
    await request;
  });
});
