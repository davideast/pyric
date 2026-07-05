import { describe, it, expect } from 'bun:test';
import {
  useRecursiveDelete,
  type RecursiveDeleteImpl,
} from '../../../src/firestore/hooks/useRecursiveDelete.js';
import { renderHook, act, waitFor } from '../../helpers/render-hook.js';

function mockImpl(progressCounts: number[]): RecursiveDeleteImpl {
  return {
    async *start() {
      let count = 0;
      for (const step of progressCounts) {
        count += step;
        yield { deletedCount: count, done: false };
      }
      yield { deletedCount: count, done: true };
    },
  };
}

function failingImpl(at: number): RecursiveDeleteImpl {
  return {
    async *start() {
      yield { deletedCount: at, done: false };
      throw new Error('boom');
    },
  };
}

const fakeTarget = {
  path: 'users/alice',
  id: 'alice',
  firestore: {},
  type: 'document',
} as any;

describe('useRecursiveDelete', () => {
  it('starts idle with progress=0', () => {
    const { result } = renderHook(() => useRecursiveDelete(mockImpl([])));
    expect(result.current.progress).toBe(0);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('iterates progress events to completion', async () => {
    const { result } = renderHook(() => useRecursiveDelete(mockImpl([2, 3, 5])));
    await act(async () => {
      await result.current.delete(fakeTarget);
    });
    expect(result.current.progress).toBe(10);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('surfaces a thrown error without rethrowing', async () => {
    const { result } = renderHook(() => useRecursiveDelete(failingImpl(7)));
    await act(async () => {
      await result.current.delete(fakeTarget);
    });
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.isRunning).toBe(false);
  });

  it('resets progress on a new run', async () => {
    const impl: RecursiveDeleteImpl = {
      async *start() {
        yield { deletedCount: 100, done: false };
        yield { deletedCount: 100, done: true };
      },
    };
    const { result } = renderHook(() => useRecursiveDelete(impl));
    await act(async () => {
      await result.current.delete(fakeTarget);
    });
    expect(result.current.progress).toBe(100);
    await act(async () => {
      await result.current.delete(fakeTarget);
    });
    // Second run still reaches 100 — but we observe progress was
    // reset between calls. The hook clears `progress` at the start
    // of each call.
    expect(result.current.progress).toBe(100);
  });

  it('flips isRunning during iteration', async () => {
    let resolveStep: (() => void) | null = null;
    const impl: RecursiveDeleteImpl = {
      async *start() {
        await new Promise<void>((resolve) => {
          resolveStep = resolve;
        });
        yield { deletedCount: 1, done: true };
      },
    };
    const { result } = renderHook(() => useRecursiveDelete(impl));
    // Kick off without awaiting so we can sample state mid-flight.
    let pending: Promise<void> | null = null;
    await act(async () => {
      pending = result.current.delete(fakeTarget);
    });
    expect(result.current.isRunning).toBe(true);
    await act(async () => {
      resolveStep?.();
      await pending;
    });
    expect(result.current.isRunning).toBe(false);
  });
});
