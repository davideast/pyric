/**
 * A rules change re-checks every active listener's read access. A query
 * listener is checked with its own query, and an admin listener, which
 * bypasses rules, is left alone.
 */
import { describe, expect, test } from 'bun:test';
import { getAdminDatabase, getDatabase, onChildAdded, onValue, orderByChild, query, ref, set } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { setData, setRules } from 'pyric/sandbox/database';

const QUERY_GATED = {
  rules: {
    scores: { '.read': "query.orderByChild == 'score'", '.indexOn': 'score' },
  },
};

describe('a rules change re-checks listeners', () => {
  test('a query listener is checked with its own query and survives', () => {
    const sandbox = initializeSandbox();
    setData(sandbox, { '/scores/a': { score: 1 } });
    setRules(sandbox, QUERY_GATED);
    const errors: unknown[] = [];
    const seen: unknown[] = [];
    onValue(query(ref(getDatabase(sandbox), 'scores'), orderByChild('score')), (snap) => seen.push(snap.val()), (error) => errors.push(error));
    expect(seen).toHaveLength(1);
    setRules(sandbox, QUERY_GATED);
    expect(errors).toEqual([]);
  });

  test('a query child listener is checked with its own query and survives', () => {
    const sandbox = initializeSandbox();
    setData(sandbox, { '/scores/a': { score: 1 } });
    setRules(sandbox, QUERY_GATED);
    const errors: unknown[] = [];
    const keys: unknown[] = [];
    onChildAdded(query(ref(getDatabase(sandbox), 'scores'), orderByChild('score')), (snap) => keys.push(snap.key), (error) => errors.push(error));
    expect(keys).toEqual(['a']);
    setRules(sandbox, QUERY_GATED);
    expect(errors).toEqual([]);
  });

  test('an admin listener survives rules that deny reads', async () => {
    const sandbox = initializeSandbox();
    setData(sandbox, { '/status/alice': 'online' });
    setRules(sandbox, { rules: { '.read': true, '.write': true } });
    const adminDb = getAdminDatabase(sandbox);
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    onValue(ref(adminDb, 'status/alice'), (snap) => seen.push(snap.val()), (error) => errors.push(error));
    setRules(sandbox, { rules: { '.read': false, '.write': false } });
    await set(ref(adminDb, 'status/alice'), 'away');
    expect(errors).toEqual([]);
    expect(seen).toEqual(['online', 'away']);
  });
});
