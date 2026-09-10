/**
 * The sandbox clock's own contract, independent of any service.
 *
 * Three modes and what each promises:
 *   wall   - `now()` is the real clock, byte for byte.
 *   fixed  - `set(epochMs)` pins an instant and freezes it there.
 *   offset - `advance(ms)` from wall shifts the clock and lets it keep flowing.
 */
import { describe, it, expect } from 'bun:test';

import { getClock, initializeSandbox } from 'pyric/sandbox';
import { SandboxClock } from '../../src/sandbox/clock.js';

const HOUR_MS = 60 * 60 * 1000;

describe('SandboxClock', () => {
  it('starts on the wall clock', () => {
    const clock = new SandboxClock();
    expect(clock.mode).toBe('wall');
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
  });

  it('freezes at the instant `set` names', async () => {
    const clock = new SandboxClock();
    clock.set(Date.UTC(2031, 0, 1));
    expect(clock.mode).toBe('fixed');
    expect(clock.now()).toBe(Date.UTC(2031, 0, 1));
    await Bun.sleep(15);
    expect(clock.now()).toBe(Date.UTC(2031, 0, 1));
  });

  it('advances a frozen clock without thawing it', () => {
    const clock = new SandboxClock();
    clock.set(Date.UTC(2031, 0, 1));
    clock.advance(HOUR_MS);
    expect(clock.mode).toBe('fixed');
    expect(clock.now()).toBe(Date.UTC(2031, 0, 1) + HOUR_MS);
  });

  it('advances a wall clock into an offset that keeps flowing', async () => {
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    expect(clock.mode).toBe('offset');
    const first = clock.now();
    expect(first - Date.now()).toBeGreaterThan(HOUR_MS - 50);
    await Bun.sleep(15);
    expect(clock.now()).toBeGreaterThan(first);
  });

  it('accumulates successive advances', () => {
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    clock.advance(HOUR_MS);
    expect(clock.now() - Date.now()).toBeGreaterThan(2 * HOUR_MS - 50);
  });

  it('returns to the wall clock on reset', () => {
    const clock = new SandboxClock();
    clock.set(Date.UTC(2031, 0, 1));
    clock.reset();
    expect(clock.mode).toBe('wall');
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
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
    const clock = new SandboxClock();
    clock.advance(HOUR_MS);
    clock.restore(new SandboxClock().capture());
    expect(clock.mode).toBe('wall');
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
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
