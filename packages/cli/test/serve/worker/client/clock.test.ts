/** The page's mirror of the sandbox clock. */
import { describe, expect, it } from 'bun:test';
import {
  mirroredClockState,
  receiveClockState,
  sandboxNow,
} from '../../../../src/serve/worker/client/clock.js';

describe('the page mirror of the sandbox clock', () => {
  it('reads the wall clock until the host says otherwise', () => {
    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });

    expect(mirroredClockState().mode).toBe('wall');
    expect(Math.abs(sandboxNow() - Date.now())).toBeLessThan(1000);
  });

  it('reports the pinned instant under a fixed clock', () => {
    const pinned = Date.UTC(2031, 0, 1);
    receiveClockState({ mode: 'fixed', fixedAt: pinned, offsetMs: 0 });

    expect(sandboxNow()).toBe(pinned);

    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
  });

  it('shifts the wall clock by the offset under an offset clock', () => {
    const hour = 60 * 60 * 1000;
    receiveClockState({ mode: 'offset', fixedAt: 0, offsetMs: hour });

    expect(Math.abs(sandboxNow() - (Date.now() + hour))).toBeLessThan(1000);

    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
  });
});
