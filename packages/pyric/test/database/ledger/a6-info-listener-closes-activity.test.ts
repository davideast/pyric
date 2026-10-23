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

/** Ids of every activity in the journal, taken before the test opens its own. */
function journalIds(): ReadonlySet<string> {
  return new Set(sdkActivity.records().map((record) => record.id));
}

/**
 * The journal is process-global, and earlier test files can leave listeners
 * live. Count only the activities this test opened: records absent from the
 * `before` snapshot. A wall-clock cutoff is not enough, because the wall clock
 * can step backward between files and make an older record look new.
 */
function liveDatabaseActivities(target: string, before: ReadonlySet<string>): number {
  return sdkActivity.records().filter((record) =>
    !before.has(record.id) && record.service === 'database' && record.target === target && LIVE.has(record.status)).length;
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
    const before = journalIds();
    const unsubscribe = onValue(ref(rtdb, 'rooms/lobby'), () => {});
    expect(liveDatabaseActivities('/rooms/lobby', before)).toBe(1);
    unsubscribe();
    expect(liveDatabaseActivities('/rooms/lobby', before)).toBe(0);
  });

  it('/.info/connected releases its activity on unsubscribe', () => {
    const rtdb = openSandbox();
    const before = journalIds();
    const unsubscribe = onValue(ref(rtdb, '.info/connected'), () => {});
    expect(liveDatabaseActivities('/.info/connected', before)).toBe(1);
    unsubscribe();
    expect(liveDatabaseActivities('/.info/connected', before)).toBe(0);
  });

  it('/.info releases its activity on unsubscribe', () => {
    const rtdb = openSandbox();
    const before = journalIds();
    const unsubscribe = onValue(ref(rtdb, '.info'), () => {});
    expect(liveDatabaseActivities('/.info', before)).toBe(1);
    unsubscribe();
    expect(liveDatabaseActivities('/.info', before)).toBe(0);
  });
});
