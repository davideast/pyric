/** The page's mirror of the sandbox clock. */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  mirroredClockState,
  receiveClockState,
  sandboxNow,
} from '../../../../src/serve/worker/client/clock.js';

// The real wall clock can step back (WSL2 does, by about 1.5 s), so the
// wall-clock cases hold it with `setSystemTime` and compare exactly.
const WALL_MS = Date.UTC(2031, 0, 1);
// The mirror is module state, and it carries its held reading between two
// flowing states, so each test passes through a fixed state to drop it.
afterEach(() => {
  setSystemTime();
  receiveClockState({ mode: 'fixed', fixedAt: 0, offsetMs: 0 });
  receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
});

describe('the page mirror of the sandbox clock', () => {
  it('reads the wall clock until the host says otherwise', () => {
    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
    setSystemTime(WALL_MS);

    expect(mirroredClockState().mode).toBe('wall');
    expect(sandboxNow()).toBe(WALL_MS);
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
    setSystemTime(WALL_MS);

    expect(sandboxNow()).toBe(WALL_MS + hour);

    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
  });

  // The page mints push ids and upload stamps from this mirror, so it must
  // agree with the worker's clock, which never steps back with the host (#1255).
  it('holds its last reading when the host clock steps backward', () => {
    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
    setSystemTime(WALL_MS);
    expect(sandboxNow()).toBe(WALL_MS);

    setSystemTime(WALL_MS - 1500);
    expect(sandboxNow()).toBe(WALL_MS);

    setSystemTime(WALL_MS + 10);
    expect(sandboxNow()).toBe(WALL_MS + 10);
  });

  it('carries its held reading through an advance the host announces', () => {
    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
    setSystemTime(WALL_MS);
    expect(sandboxNow()).toBe(WALL_MS);

    setSystemTime(WALL_MS - 1500);
    receiveClockState({ mode: 'offset', fixedAt: 0, offsetMs: 1000 });
    expect(sandboxNow()).toBe(WALL_MS + 1000);

    receiveClockState({ mode: 'fixed', fixedAt: 0, offsetMs: 0 });
    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
  });

  it('holds an offset reading when the host clock steps backward', () => {
    const hour = 60 * 60 * 1000;
    receiveClockState({ mode: 'offset', fixedAt: 0, offsetMs: hour });
    setSystemTime(WALL_MS);
    expect(sandboxNow()).toBe(WALL_MS + hour);

    setSystemTime(WALL_MS - 1500);
    expect(sandboxNow()).toBe(WALL_MS + hour);

    receiveClockState({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
  });
});
