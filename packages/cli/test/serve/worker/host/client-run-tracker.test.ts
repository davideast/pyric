import { describe, expect, it } from 'bun:test';
import { createClientRunTracker } from '../../../../src/serve/worker/host/client-run-tracker.js';
import type { HostCtx, PortLike } from '../../../../src/serve/worker/host-context.js';

function fakePort(): PortLike {
  return { postMessage() {} };
}

describe('createClientRunTracker', () => {
  it('sweeps closed ports under a label only when another port with the same label is open', () => {
    const tracker = createClientRunTracker();
    const ctx = {} as HostCtx;
    const p1 = fakePort();
    const p2 = fakePort();

    expect(tracker.claim(ctx, p1, 'run-a')).toEqual([]);
    expect(tracker.close(ctx, p1)).toEqual([]);
    expect(tracker.claim(ctx, p2, 'run-a')).toEqual([p1]);
  });

  it('keeps two open ports with the same label independent and supports resume + forget', () => {
    const tracker = createClientRunTracker();
    const ctx = {} as HostCtx;
    const p1 = fakePort();
    const p2 = fakePort();

    expect(tracker.claim(ctx, p1, 'run-b')).toEqual([]);
    expect(tracker.close(ctx, p1)).toEqual([]);
    tracker.resume(ctx, p1);
    expect(tracker.claim(ctx, p2, 'run-b')).toEqual([]);

    expect(tracker.close(ctx, p1)).toEqual([p1]);
    tracker.forget(ctx, p2);
  });
});
