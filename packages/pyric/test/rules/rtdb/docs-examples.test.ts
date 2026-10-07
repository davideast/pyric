/**
 * Executes the Realtime Database snippets published in the Secure docs and the
 * improve-firebase skill, and pins the outputs those pages print. A change to
 * the engine that alters a printed verdict, reason, or lint code fails here
 * before the page goes stale.
 */
import { describe, expect, test } from 'bun:test';
import { assertCase, explainCase, rtdbRules, type RtdbCase } from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  get,
  limitToFirst,
  onValue,
  orderByChild,
  query,
  ref,
  set,
  sandbox as databaseSandbox,
} from 'pyric/database';

const rules = rtdbRules({
  rules: {
    '.read': false,
    '.write': false,
    records: {
      $recordId: {
        '.read':
          "auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists())",
        '.write':
          "auth != null && (data.exists() ? data.child('ownerId').val() === auth.uid : newData.child('ownerId').val() === auth.uid)",
        '.validate': "newData.hasChildren(['ownerId', 'title'])",
        title: { '.validate': 'newData.isString() && newData.val().length <= 80' },
      },
    },
  },
});

const stored = {
  records: { r1: { ownerId: 'alice', title: 'Quarterly plan', reviewers: { rita: true } } },
};
const revised = { ownerId: 'alice', title: 'Revised plan', reviewers: { rita: true } };

const cases: RtdbCase[] = [
  { description: 'owner writes', expectation: 'ALLOW', operation: 'write', path: '/records/r1', auth: 'alice', data: stored, newData: revised },
  { description: 'reviewer reads', expectation: 'ALLOW', operation: 'read', path: '/records/r1', auth: 'rita', data: stored },
  { description: 'reviewer cannot write', expectation: 'DENY', operation: 'write', path: '/records/r1', auth: 'rita', data: stored, newData: revised },
  { description: 'unrelated user cannot read', expectation: 'DENY', operation: 'read', path: '/records/r1', auth: 'mallory', data: stored },
  { description: 'signed-out user cannot read', expectation: 'DENY', operation: 'read', path: '/records/r1', auth: null, data: stored },
  { description: 'title over 80 characters', expectation: 'DENY', operation: 'write', path: '/records/r1', auth: 'alice', data: stored, newData: { ...revised, title: 'x'.repeat(81) } },
];

describe('docs: test Realtime Database rules', () => {
  test('the suite reports six passing cases', () => {
    const summary = rules.simulate(cases);
    expect(`${summary.passed} passed, ${summary.failed} failed, ${summary.unsupported} unsupported`).toBe(
      '6 passed, 0 failed, 0 unsupported',
    );
  });

  for (const c of cases) test(c.description!, () => assertCase(rules, c));

  test('a failing case names the deciding rule', () => {
    const miss: RtdbCase = { ...cases[3], description: 'unrelated user reads', expectation: 'ALLOW' };
    expect(() => assertCase(rules, miss)).toThrow(
      [
        'FAIL: unrelated user reads',
        '  read /records/r1 (expected ALLOW, got DENY)',
        "  matched auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists()) @ /records/$recordId",
        "  reason: No 'read' rule grants access; the deepest, at '/records/$recordId', evaluated to false",
      ].join('\n'),
    );
    expect(explainCase(rules.simulate([miss]).cases[0])).toContain('FAIL: unrelated user reads');
  });

  test('a validation failure names the validate rule', () => {
    const result = rules.simulate([cases[5]]).cases[0];
    expect(result.matchedPath).toBe('/records/$recordId/title');
    expect(result.matchedRule).toBe('newData.isString() && newData.val().length <= 80');
    expect(result.reason).toBe('Validation rule evaluated to false');
  });

  test('the sandbox rejects the unrelated user with PERMISSION_DENIED and records the rule', async () => {
    const sandbox = initializeSandbox();
    databaseSandbox.setRules(getDatabase(sandbox), rules.toJSON());
    const alice = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const mallory = getDatabase(sandbox.withAuth({ uid: 'mallory' }));
    const denials: Array<{ matchedPath?: string; reason?: string }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'operation' && e.service === 'rtdb' && e.result === 'deny') {
        denials.push({ matchedPath: e.rules?.matchedPath, reason: e.rules?.reason });
      }
    });

    await set(ref(alice, 'records/r1'), { ownerId: 'alice', title: 'Plan' });
    const error = await get(ref(mallory, 'records/r1')).catch((e: unknown) => e as Error & { code?: string });
    expect((error as Error).message).toBe('PERMISSION_DENIED: Permission denied');
    expect((error as { code?: string }).code).toBe('PERMISSION_DENIED');
    expect(denials).toEqual([
      {
        matchedPath: '/records/$recordId',
        reason: "No 'read' rule grants access; the deepest, at '/records/$recordId', evaluated to false",
      },
    ]);
  });
});

describe('docs: how the simulator evaluates rules', () => {
  test('equality is strict', () => {
    const strict = rtdbRules({
      rules: { scores: { $id: { '.read': true, '.write': true, '.validate': "newData.val() == '5'" } } },
    });
    const [string, number] = strict.simulate([
      { expectation: 'ALLOW', operation: 'write', path: '/scores/a', newData: '5' },
      { expectation: 'DENY', operation: 'write', path: '/scores/a', newData: 5 },
    ]).cases;
    expect(string.decision).toBe('ALLOW');
    expect(number.decision).toBe('DENY');
    expect(number.reason).toBe('Validation rule evaluated to false');
  });

  test('a validate rule that errors rejects the write and names the error', () => {
    const names = rtdbRules({
      rules: { names: { $id: { '.read': true, '.write': true, '.validate': "newData.val().toUpperCase() == 'ADA'" } } },
    });
    const [ok, error] = names.simulate([
      { expectation: 'ALLOW', operation: 'write', path: '/names/a', newData: 'ada' },
      { expectation: 'DENY', operation: 'write', path: '/names/a', newData: 7 },
    ]).cases;
    expect(ok.decision).toBe('ALLOW');
    expect(error.decision).toBe('DENY');
    expect(error.reason).toBe(
      "Validation rule at '/names/$id' failed at evaluation: Method 'toUpperCase' is not defined on number.",
    );
  });

  test('a read rule that errors does not grant and the cascade continues', () => {
    const cascade = rtdbRules({
      rules: { docs: { '.read': 'data.child("n").val().toUpperCase() == "A"', $id: { '.read': 'auth != null' } } },
    });
    const data = { docs: { n: 5, d1: { x: 1 } } };
    const [signedIn, signedOut] = cascade.simulate([
      { expectation: 'ALLOW', operation: 'read', path: '/docs/d1', auth: 'u', data },
      { expectation: 'DENY', operation: 'read', path: '/docs/d1', auth: null, data },
    ]).cases;
    expect(signedIn.decision).toBe('ALLOW');
    expect(signedOut.decision).toBe('DENY');
  });

  test('a now-gated rule follows the pinned instant', () => {
    const offers = rtdbRules({ rules: { offers: { $id: { '.read': "data.child('expiresAt').val() > now" } } } });
    const data = { offers: { o1: { expiresAt: 1_800_000_000_000 } } };
    const [before, after] = offers.simulate([
      { expectation: 'ALLOW', operation: 'read', path: '/offers/o1', data, now: 1_700_000_000_000 },
      { expectation: 'DENY', operation: 'read', path: '/offers/o1', data, now: 1_900_000_000_000 },
    ]).cases;
    expect(before.decision).toBe('ALLOW');
    expect(after.decision).toBe('DENY');
  });

  test('lint reports the documented codes', () => {
    const issues = rtdbRules({
      rules: {
        a: { '.read': 'auth !=', '.write': false },
        b: { '.read': 'newData.exists()', '.write': 'data.exists()', '.validate': 'frob > 1' },
        c: { '.read': 'data.nope()', '.write': true },
      },
    }).lint();
    const bySeverity = (severity: string) => [...new Set(issues.filter((i) => i.severity === severity).map((i) => i.code))].sort();
    expect(bySeverity('error')).toEqual(['NEWDATA_IN_READ', 'PARSE_ERROR', 'UNKNOWN_IDENTIFIER', 'UNKNOWN_METHOD']);
    expect(bySeverity('warning')).toEqual(['DATA_IN_WRITE', 'HARDCODED_FALSE', 'HARDCODED_TRUE']);
  });

  test('the simulate example in the lint page reports the title rule', () => {
    const page = rtdbRules({
      rules: {
        '.read': false,
        '.write': false,
        records: {
          $recordId: {
            '.read': "auth != null && data.child('ownerId').val() === auth.uid",
            '.validate': "newData.hasChildren(['ownerId', 'title'])",
            '.write': 'auth != null',
            title: { '.validate': 'newData.isString() && newData.val().length <= 80' },
          },
        },
      },
    });
    const { cases: results } = page.simulate([
      {
        description: 'a title over 80 characters is rejected',
        expectation: 'DENY',
        operation: 'write',
        path: '/records/r1',
        auth: 'alice',
        newData: { ownerId: 'alice', title: 'x'.repeat(81) },
      },
    ]);
    expect(results[0].passed).toBe(true);
    expect(results[0].matchedPath).toBe('/records/$recordId/title');
    expect(results[0].matchedRule).toBe('newData.isString() && newData.val().length <= 80');
    expect(results[0].reason).toBe('Validation rule evaluated to false');
  });
});

describe('docs: .indexOn', () => {
  const warnings: string[] = [];
  const seed = () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    databaseSandbox.setRules(db, { rules: { projects: { '.read': true } } });
    databaseSandbox.setData(db, { projects: { a: { budget: 5 }, b: { budget: 9 } } });
    return db;
  };

  test('get() rejects and a limited listener delivers the filtered data with a warning', async () => {
    const db = seed();
    await expect(get(query(ref(db, 'projects'), orderByChild('budget')))).rejects.toThrow(
      'Index not defined, add ".indexOn": "budget", for path "/projects", to the rules',
    );

    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    const values: unknown[] = [];
    const stop = onValue(query(ref(db, 'projects'), orderByChild('budget'), limitToFirst(1)), (s) => { values.push(s.val()); });
    stop();
    console.warn = original;

    expect(values).toEqual([{ a: { budget: 5 } }]);
    expect(warnings.join('\n')).toContain(
      'Using an unspecified index. Your data will be downloaded and filtered on the client. ' +
        'Consider adding ".indexOn": "budget" at /projects to your security rules for better performance.',
    );
  });
});
