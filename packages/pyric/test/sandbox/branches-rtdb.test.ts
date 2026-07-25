/**
 * Test verifying Realtime Database rules and tree state persistence across throwaway forks.
 * Reproduces the NO_ACTIVE_RULES exception when simulation forks omit RTDB rules and state.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, fork } from '../../src/sandbox/index.js';
import { setRules, getActiveRules, setData, snapshotState } from '../../src/database/sandbox-controls.js';

describe('branches — RTDB simulation fork', () => {
  it('clones Realtime Database active rules and data tree into throwaway forks without throwing NO_ACTIVE_RULES', () => {
    const live = initializeSandbox();
    const rules = { rules: { '.read': true, '.write': true } };
    const seedData = { rooms: { general: { name: 'General' } } };

    setRules(live, rules);
    setData(live, seedData);

    const snap = live.snapshot();
    const branch = fork(snap);

    const branchedRules = getActiveRules(branch.sandbox);
    const isNull = branchedRules === null;
    const isUndefined = branchedRules === undefined;
    let hasNoRules = isNull;
    if (isUndefined) {
      hasNoRules = true;
    }
    if (hasNoRules) {
      throw new Error('NO_ACTIVE_RULES: No RTDB rules are loaded in the local sandbox.');
    }

    expect(branchedRules).toEqual(rules);
    expect(snapshotState(branch.sandbox)).toEqual(seedData);
  });
});
