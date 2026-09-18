/**
 * Ledger A6: a Realtime Database listener on `/.info/connected` or `/.info`
 * opens an SDK activity like every other `onValue` and must release it on
 * unsubscribe. The activity journal is the observable surface: after
 * unsubscribe, no database activity for that target may remain live.
 *
 * A control case on an ordinary path proves the surface works.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { sdkActivity } from '../../../src/sandbox/internal/sdk-activity.js';
import { getDatabase, onValue, ref } from '../../../src/database/index.js';
import { setRules } from '../../../src/database/sandbox-controls.js';

const LIVE = new Set(['pending', 'active']);

function liveDatabaseActivities(target: string): number {
  return sdkActivity.records().filter((record) =>
    record.service === 'database' && record.target === target && LIVE.has(record.status)).length;
}

function openSandbox() {
  const sandbox = initializeSandbox();
  const rtdb = getDatabase(sandbox);
  setRules(rtdb, { rules: { '.read': true, '.write': true } });
  return rtdb;
}

describe('ledger A6: connection-metadata listeners release their activity', () => {
  it('control: an ordinary onValue releases its activity on unsubscribe', () => {
    const rtdb = openSandbox();
    const unsubscribe = onValue(ref(rtdb, 'rooms/lobby'), () => {});
    expect(liveDatabaseActivities('/rooms/lobby')).toBe(1);
    unsubscribe();
    expect(liveDatabaseActivities('/rooms/lobby')).toBe(0);
  });

  it('/.info/connected releases its activity on unsubscribe', () => {
    const rtdb = openSandbox();
    const unsubscribe = onValue(ref(rtdb, '.info/connected'), () => {});
    expect(liveDatabaseActivities('/.info/connected')).toBe(1);
    unsubscribe();
    expect(liveDatabaseActivities('/.info/connected')).toBe(0);
  });

  it('/.info releases its activity on unsubscribe', () => {
    const rtdb = openSandbox();
    const unsubscribe = onValue(ref(rtdb, '.info'), () => {});
    unsubscribe();
    expect(liveDatabaseActivities('/.info')).toBe(0);
  });
});
