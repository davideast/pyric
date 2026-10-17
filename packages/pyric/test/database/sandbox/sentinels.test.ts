import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import {
  get,
  getDatabase,
  ref,
  sandbox,
  serverTimestamp as dbServerTimestamp,
  set,
} from '../../../src/database/index.js';
import { serverTimestamp as rulesServerTimestamp } from '../../../src/rules/index.js';
import {
  isServerTimestampSentinel,
  resolveSentinels,
} from '../../../src/database/sandbox/sentinels.js';

describe('sentinels', () => {
  test('isServerTimestampSentinel only matches the RTDB {".sv": "timestamp"} marker', () => {
    expect(isServerTimestampSentinel(dbServerTimestamp())).toBe(true);
    expect(isServerTimestampSentinel(rulesServerTimestamp())).toBe(false);
    expect(isServerTimestampSentinel({ __type: 'serverTimestamp' })).toBe(false);
    expect(isServerTimestampSentinel({ createdAt: 123 })).toBe(false);
    expect(isServerTimestampSentinel(null)).toBe(false);
  });

  test('a sandbox client set() of { __type: "serverTimestamp" } stores the map unchanged', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box);
    sandbox.setRules(db, { rules: { '.read': true, '.write': true } });
    await set(ref(db, 'x'), { __type: 'serverTimestamp' });
    const snap = await get(ref(db, 'x'));
    expect(snap.val()).toEqual({ __type: 'serverTimestamp' });

    const now = 1779075391118;
    expect(resolveSentinels({ __type: 'serverTimestamp' }, now)).toEqual({
      __type: 'serverTimestamp',
    });
  });
});
