/**
 * The sandbox clock's own contract, independent of any service.
 *
 * Three modes and what each promises:
 *   wall   - `now()` is the real clock, byte for byte.
 *   fixed  - `set(epochMs)` pins an instant and freezes it there.
 *   offset - `advance(ms)` from wall shifts the clock and lets it keep flowing.
 */
import { afterEach, describe, it, expect, setSystemTime } from 'bun:test';

import { getClock, initializeSandbox } from 'pyric/sandbox';
import { SandboxClock } from '../../src/sandbox/clock.js';

const HOUR_MS = 60 * 60 * 1000;
const WALL_MS = Date.UTC(2031, 0, 1);

// The host wall clock can step backward (WSL2 does, by about 1.5 s), so a test
// that brackets a reading between two real `Date.now()` calls fails at random.
// Every test here that reads the wall clock holds it with `setSystemTime`.
afterEach(() => {
  setSystemTime();
});

describe('SandboxClock', () => {
  it('starts on the wall clock', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    expect(clock.mode).toBe('wall');
    expect(clock.now()).toBe(WALL_MS);
  });

  it('freezes at the instant `set` names', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    clock.set(Date.UTC(2040, 0, 1));
    expect(clock.mode).toBe('fixed');
    expect(clock.now()).toBe(Date.UTC(2040, 0, 1));
    setSystemTime(WALL_MS + HOUR_MS);
    expect(clock.now()).toBe(Date.UTC(2040, 0, 1));
  });

  it('advances a frozen clock without thawing it', () => {
    const clock = new SandboxClock();
    clock.set(Date.UTC(2031, 0, 1));
    clock.advance(HOUR_MS);
    expect(clock.mode).toBe('fixed');
    expect(clock.now()).toBe(Date.UTC(2031, 0, 1) + HOUR_MS);
  });

  it('advances a wall clock into an offset that keeps flowing', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    expect(clock.mode).toBe('offset');
    expect(clock.now()).toBe(WALL_MS + HOUR_MS);
    setSystemTime(WALL_MS + 15);
    expect(clock.now()).toBe(WALL_MS + 15 + HOUR_MS);
  });

  it('accumulates successive advances', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    clock.advance(HOUR_MS);
    expect(clock.now()).toBe(WALL_MS + 2 * HOUR_MS);
  });

  it('returns to the wall clock on reset', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    clock.set(Date.UTC(2040, 0, 1));
    clock.reset();
    expect(clock.mode).toBe('wall');
    expect(clock.now()).toBe(WALL_MS);
  });

  it('rejects an instant that is not a finite epoch millisecond', () => {
    const clock = new SandboxClock();
    expect(() => clock.set(Number.NaN)).toThrow();
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('captures and restores its state', () => {
    const clock = new SandboxClock();
    clock.set(Date.UTC(2031, 0, 1));
    const state = clock.capture();

    const restored = new SandboxClock();
    restored.restore(state);
    expect(restored.mode).toBe('fixed');
    expect(restored.now()).toBe(Date.UTC(2031, 0, 1));
  });

  it('restores a wall-clock state as the wall clock', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    clock.restore(new SandboxClock().capture());
    expect(clock.mode).toBe('wall');
    expect(clock.now()).toBe(WALL_MS);
  });
});

// The sandbox clock stands in for Firebase's servers, whose clock never steps
// back. A host clock that does (WSL2 steps back about 1.5 s) must not move a
// `serverTimestamp()` or `request.time` backward (#1255).
describe('when the host clock steps backward', () => {
  const STEP_BACK_MS = 1500;

  it('holds a wall clock at its last reading until the host catches up', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    expect(clock.now()).toBe(WALL_MS);

    setSystemTime(WALL_MS - STEP_BACK_MS);
    expect(clock.now()).toBe(WALL_MS);

    setSystemTime(WALL_MS + 10);
    expect(clock.now()).toBe(WALL_MS + 10);
  });

  it('holds an offset clock at its last reading until the host catches up', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    expect(clock.now()).toBe(WALL_MS + HOUR_MS);

    setSystemTime(WALL_MS - STEP_BACK_MS);
    expect(clock.now()).toBe(WALL_MS + HOUR_MS);

    setSystemTime(WALL_MS + 10);
    expect(clock.now()).toBe(WALL_MS + HOUR_MS + 10);
  });

  it('still moves back when the caller advances by a negative delta', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    expect(clock.now()).toBe(WALL_MS);

    clock.advance(-HOUR_MS);
    expect(clock.now()).toBe(WALL_MS - HOUR_MS);
  });

  it('advances forward from the held reading, not from the host clock', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    expect(clock.now()).toBe(WALL_MS);

    setSystemTime(WALL_MS - STEP_BACK_MS);
    clock.advance(1000);
    expect(clock.now()).toBe(WALL_MS + 1000);

    setSystemTime(WALL_MS + 10);
    expect(clock.now()).toBe(WALL_MS + 1010);
  });

  it('advances back exactly that far below the held reading', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    expect(clock.now()).toBe(WALL_MS + HOUR_MS);

    setSystemTime(WALL_MS - STEP_BACK_MS);
    clock.advance(-1000);
    expect(clock.now()).toBe(WALL_MS + HOUR_MS - 1000);
  });

  it('drops the held reading on reset', () => {
    setSystemTime(WALL_MS);
    const clock = new SandboxClock();
    expect(clock.now()).toBe(WALL_MS);

    setSystemTime(WALL_MS - STEP_BACK_MS);
    clock.reset();
    expect(clock.now()).toBe(WALL_MS - STEP_BACK_MS);
  });

  it('never decreases across many readings on a host that keeps stepping back', () => {
    const clock = new SandboxClock();
    let host = WALL_MS;
    let previous = Number.NEGATIVE_INFINITY;
    for (let step = 0; step < 20; step += 1) {
      const isStepBack = step % 3 === 2;
      host += isStepBack ? -STEP_BACK_MS : 400;
      setSystemTime(host);
      const reading = clock.now();
      expect(reading).toBeGreaterThanOrEqual(previous);
      previous = reading;
    }
  });
});

describe('getClock', () => {
  it('returns the same clock for the same sandbox', () => {
    const sandbox = initializeSandbox();
    expect(getClock(sandbox)).toBe(getClock(sandbox));
  });

  it('gives each sandbox its own clock', () => {
    const first = initializeSandbox();
    const second = initializeSandbox();
    getClock(first).set(Date.UTC(2031, 0, 1));
    expect(getClock(first).now()).toBe(Date.UTC(2031, 0, 1));
    expect(getClock(second).mode).toBe('wall');
  });

  it('keeps the clock across a reset so a pinned instant survives', () => {
    const sandbox = initializeSandbox();
    getClock(sandbox).set(Date.UTC(2031, 0, 1));
    sandbox.reset();
    expect(getClock(sandbox).now()).toBe(Date.UTC(2031, 0, 1));
  });

  it('refuses a handle that initializeSandbox did not produce', () => {
    expect(() => getClock({} as never)).toThrow(/initializeSandbox/);
  });
});

describe('watching the clock for a move', () => {
  it('reports the new state on every move', () => {
    const sandbox = initializeSandbox();
    const seen: string[] = [];
    const stop = getClock(sandbox).onChange((state) => seen.push(state.mode));

    getClock(sandbox).set(Date.UTC(2031, 0, 1));
    getClock(sandbox).advance(1000);
    getClock(sandbox).reset();
    getClock(sandbox).restore({ mode: 'offset', fixedAt: 0, offsetMs: 500 });
    stop();
    getClock(sandbox).set(Date.UTC(2032, 0, 1));

    expect(seen).toEqual(['fixed', 'fixed', 'wall', 'offset']);
  });

  it('carries the instant the pin names', () => {
    const sandbox = initializeSandbox();
    const pinned = Date.UTC(2031, 0, 1);
    let fixedAt = 0;
    getClock(sandbox).onChange((state) => {
      fixedAt = state.fixedAt;
    });

    getClock(sandbox).set(pinned);

    expect(fixedAt).toBe(pinned);
  });
});
