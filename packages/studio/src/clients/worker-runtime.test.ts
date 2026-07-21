import { describe, expect, it } from 'bun:test';
import type { ClientDb } from '@pyric/cli/serve/worker';
import { createStudioWorkerRuntime } from './worker-runtime.js';

describe('Studio worker replacement', () => {
  it('shows a stale generation, retires it explicitly, then reloads onto the announced generation', async () => {
    const values = new Map<string, string>();
    let announce: ((epoch: string) => void) | undefined;
    let retiredEpoch: string | null = null;
    let reloads = 0;
    const scheduled: Array<() => void> = [];
    const runtime = createStudioWorkerRuntime({
      db: {} as ClientDb,
      servedEpoch: '0123456789abcdef',
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: (key) => { values.delete(key); },
      },
      readVersion: async () => 'fedcba9876543210',
      retire: async (epoch) => { retiredEpoch = epoch; },
      subscribeReload: (listener) => {
        announce = listener;
        return () => {};
      },
      preflight: () => {},
      remember: (epoch) => { values.set('pyric:worker-generation', epoch); },
      reload: () => { reloads += 1; },
      schedule: (run) => { scheduled.push(run); },
    });

    await Promise.resolve();
    expect(runtime.getSnapshot()).toMatchObject({
      runningEpoch: 'fedcba9876543210',
      updateAvailable: true,
      updating: false,
    });

    await runtime.update();
    expect(String(retiredEpoch)).toBe('0123456789abcdef');
    expect(runtime.getSnapshot().updating).toBe(true);

    announce?.('0123456789abcdef');
    expect(values.get('pyric:worker-generation')).toBe('0123456789abcdef');
    expect(reloads).toBe(0);
    scheduled[0]?.();
    expect(reloads).toBe(1);
  });
});
