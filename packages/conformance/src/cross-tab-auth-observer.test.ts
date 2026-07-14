import { describe, expect, it } from 'bun:test';
import {
  authStorageSignalMatches,
  observeCrossTabAuthAfterPersistenceSignal,
} from './cross-tab-auth-observer.js';

describe('cross-tab Auth production observation', () => {
  it('accepts only the expected app key carrying the source uid', () => {
    const expectedKey = 'firebase:authUser:api-key:[DEFAULT]';
    const sourceUid = 'source-user';
    expect(authStorageSignalMatches(
      { key: 'firebase:authUser:api-key:other-app', newValue: JSON.stringify({ uid: sourceUid }) },
      expectedKey,
      sourceUid,
    )).toBe(false);
    expect(authStorageSignalMatches(
      { key: expectedKey, newValue: JSON.stringify({ uid: 'different-user' }) },
      expectedKey,
      sourceUid,
    )).toBe(false);
    expect(authStorageSignalMatches(
      { key: expectedKey, newValue: JSON.stringify({ uid: sourceUid }) },
      expectedKey,
      sourceUid,
    )).toBe(true);
  });

  it('waits from the persistence signal and catches propagation later than the old fixed delay', async () => {
    let elapsed = 0;
    let persistenceSignalObserved = false;
    const sourceUid = 'source-user';

    const state = await observeCrossTabAuthAfterPersistenceSignal({
      sourceUid,
      quietWindowMs: 5_000,
      pollIntervalMs: 250,
      waitForPersistenceSignal: async () => { persistenceSignalObserved = true; },
      readState: async () => ({
        currentUid: elapsed >= 3_000 ? sourceUid : null,
        events: elapsed >= 3_000 ? [null, sourceUid] : [null],
      }),
      sleep: async (ms) => { elapsed += ms; },
      now: () => elapsed,
    });

    expect(persistenceSignalObserved).toBe(true);
    expect(state.currentUid).toBe(sourceUid);
    expect(state.events).toContain(sourceUid);
    expect(elapsed).toBe(3_000);
  });
});
