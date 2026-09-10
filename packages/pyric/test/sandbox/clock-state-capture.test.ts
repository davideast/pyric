/**
 * The clock travels with a captured state.
 *
 * A checkpoint restore and a branch fork both carry the clock, because a
 * restore that silently returned to the wall clock would change the verdict of
 * every `request.time` rule the restored state was written under, and a fork
 * that did the same would diff against a base evaluated at a different instant.
 * Applying a state that names no clock returns the target to the wall clock,
 * the same total-replace rule every other service in the state follows.
 */
import { describe, it, expect } from 'bun:test';

import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { applyFullState, captureFullState, fork } from 'pyric/sandbox';

const FUTURE = Date.UTC(2031, 5, 1);

describe('captureFullState records the clock', () => {
  it('captures a pinned instant', async () => {
    const sandbox = initializeSandbox();
    getClock(sandbox).set(FUTURE);

    const state = await captureFullState(sandbox);
    expect(state.clock).toEqual({ mode: 'fixed', fixedAt: FUTURE, offsetMs: 0 });
  });

  it('captures an offset', async () => {
    const sandbox = initializeSandbox();
    getClock(sandbox).advance(3600_000);

    const state = await captureFullState(sandbox);
    expect(state.clock).toEqual({ mode: 'offset', fixedAt: 0, offsetMs: 3600_000 });
  });

  it('captures the wall clock as the wall clock', async () => {
    const sandbox = initializeSandbox();
    const state = await captureFullState(sandbox);
    expect(state.clock).toEqual({ mode: 'wall', fixedAt: 0, offsetMs: 0 });
  });
});

describe('applyFullState installs the captured clock', () => {
  it('pins the target to the state it applies', async () => {
    const source = initializeSandbox();
    getClock(source).set(FUTURE);
    const state = await captureFullState(source);

    const target = initializeSandbox();
    await applyFullState(target, state);
    expect(getClock(target).now()).toBe(FUTURE);
  });

  it('returns the target to the wall clock when the state names none', async () => {
    const source = initializeSandbox();
    const state = await captureFullState(source);
    delete state.clock;

    const target = initializeSandbox();
    getClock(target).set(FUTURE);
    await applyFullState(target, state);
    expect(getClock(target).mode).toBe('wall');
  });
});

describe('a forked branch carries the clock', () => {
  it('evaluates on the same instant its base was pinned to', async () => {
    const base = initializeSandbox();
    getClock(base).set(FUTURE);

    const branch = await fork(await captureFullState(base));
    expect(getClock(branch.sandbox).now()).toBe(FUTURE);
  });
});
