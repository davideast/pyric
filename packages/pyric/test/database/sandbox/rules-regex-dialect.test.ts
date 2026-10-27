/**
 * The in-page sandbox enforces `matches()` in production's regex dialect
 * (#1247 SP-2b, SP-8), through the public `pyric/database` entry points the
 * SharedWorker and Node hosts also serve. Verdicts are the production
 * observations r47 and r50 under packages/conformance/observations/rtdb-rules/.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, sandbox, set } from 'pyric/database';

const RULES = {
  rules: {
    notword: { '.write': true, '.validate': 'newData.isString() && !newData.val().matches(/\\bcat\\b/)' },
    notlook: { '.write': true, '.validate': 'newData.isString() && !newData.val().matches(/^(?!admin).*$/)' },
    dot: { '.write': true, '.validate': 'newData.isString() && newData.val().matches(/^a.b$/)' },
  },
};

function openDatabase() {
  const box = initializeSandbox();
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), RULES);
  return getDatabase(box.withAuth({ uid: 'u' }));
}

describe('RTDB matches() in the in-page sandbox', () => {
  test('!matches() over \\b and a negative lookahead grants as production does (r50)', async () => {
    const db = openDatabase();
    await expect(set(ref(db, 'notword'), 'a cat sat')).resolves.toBeUndefined();
    await expect(set(ref(db, 'notlook'), 'guest')).resolves.toBeUndefined();
    await expect(set(ref(db, 'notword'), 'bcatb')).rejects.toThrow(/permission/i);
  });

  test('. matches a newline and a carriage return (r47, r50)', async () => {
    const db = openDatabase();
    await expect(set(ref(db, 'dot'), 'a\nb')).resolves.toBeUndefined();
    await expect(set(ref(db, 'dot'), 'a\rb')).resolves.toBeUndefined();
    await expect(set(ref(db, 'dot'), 'ab')).rejects.toThrow(/permission/i);
  });
});
