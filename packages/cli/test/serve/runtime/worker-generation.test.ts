import { describe, expect, it } from 'bun:test';
import {
  PYRIC_WORKER_GENERATION_KEY,
  preflightWorkerEpochStorage,
  rememberWorkerEpoch,
  workerNameForEpoch,
} from '../../../src/serve/runtime/worker-generation.js';

describe('worker generation identity', () => {
  it('seeds a versioned name instead of reconnecting to a legacy unversioned worker', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    expect(workerNameForEpoch('0123456789abcdef', storage)).toBe(
      'pyric-shared-worker:0123456789abcdef',
    );
    expect(values.get(PYRIC_WORKER_GENERATION_KEY)).toBe('0123456789abcdef');
    expect(workerNameForEpoch('0123456789abcdef', storage)).toBe(
      'pyric-shared-worker:0123456789abcdef',
    );
  });

  it('keeps the origin on its remembered generation when a newer epoch is served', () => {
    const storage = {
      getItem: () => '0123456789abcdef',
      setItem() {},
    };
    expect(workerNameForEpoch('fedcba9876543210', storage)).toBe(
      'pyric-shared-worker:0123456789abcdef',
    );
  });

  it('lets a fresh tab join the origin-wide remembered generation', () => {
    const originValues = new Map([[PYRIC_WORKER_GENERATION_KEY, '0123456789abcdef']]);
    const freshTabStorage = {
      getItem: (key: string) => originValues.get(key) ?? null,
      setItem: (key: string, value: string) => { originValues.set(key, value); },
    };

    expect(workerNameForEpoch('0123456789abcdef', freshTabStorage)).toBe(
      'pyric-shared-worker:0123456789abcdef',
    );
  });

  it('still avoids the legacy worker when origin storage is unavailable', () => {
    expect(workerNameForEpoch('0123456789abcdef', undefined)).toBe(
      'pyric-shared-worker:0123456789abcdef',
    );
    expect(workerNameForEpoch('dev', undefined)).toBe('pyric-shared-worker');
  });

  it('fails before retirement when origin storage cannot persist the successor', () => {
    expect(() => rememberWorkerEpoch('0123456789abcdef', undefined)).toThrow(
      'origin storage is unavailable',
    );
  });

  it('preflights storage without publishing a successor generation', () => {
    const values = new Map([[PYRIC_WORKER_GENERATION_KEY, '0123456789abcdef']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    preflightWorkerEpochStorage(storage);
    expect(workerNameForEpoch(null, storage)).toBe('pyric-shared-worker:0123456789abcdef');
  });
});
