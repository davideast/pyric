/**
 * Executes the Realtime Database snippets published in the Secure docs and the
 * improve-firebase skill, and pins the outputs those pages print. A change to
 * the engine that alters a printed verdict, reason, or lint code fails here
 * before the page goes stale.
 */
import { describe, expect, test } from 'bun:test';
import { assertCase, explainCase, renderRtdbCoverage, rtdbRules, type RtdbCase } from 'pyric/rules';
import { initializeSandbox, type RtdbDenialContext } from 'pyric/sandbox';
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

/** The coverage report the test-suite page prints for its six cases. */
const COVERAGE = [
  'Rule coverage: database.rules.json',
  '  6 of 6 rules evaluated, 0 never evaluated, 0 unsupported',
  '  .read: 2 of 2',
  '  .write: 2 of 2',
  '  .validate: 2 of 2',
  '',
  '/ .read (line 3): deny (allow 0, deny 3, error 0)',
  '/ .write (line 4): deny (allow 0, deny 3, error 0)',
  '/records/$recordId .read (line 7): mixed (allow 1, deny 2, error 0)',
  '/records/$recordId .write (line 8): mixed (allow 2, deny 1, error 0)',
  '/records/$recordId .validate (line 9): allow (allow 2, deny 0, error 0)',
  '/records/$recordId/title .validate (line 11): mixed (allow 1, deny 1, error 0)',
].join('\n');

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
        '  rules evaluated:',
        '    / .read -> DENY: false',
        "    /records/$recordId .read -> DENY: auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists()) ($recordId = r1)",
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
    const denials: Array<{ matchedPath?: string; reason?: string; trace?: string[] }> = [];
    const printed: string[] = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'operation' && e.service === 'rtdb' && e.result === 'deny') {
        printed.push(`${e.method} ${e.path} ${e.auth?.uid}`);
        printed.push(`${e.rules?.matchedPath} ${e.rules?.matchedRule}`);
        printed.push(`${e.rules?.reason}`);
        denials.push({
          matchedPath: e.rules?.matchedPath,
          reason: e.rules?.reason,
          trace: e.rules?.rtdbTrace?.map((t) => `${t.path} .${t.kind} -> ${t.verdict}`),
        });
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
        trace: ['/ .read -> DENY', '/records/$recordId .read -> DENY'],
      },
    ]);
    expect(printed).toEqual([
      'get /records/r1 mallory',
      "/records/$recordId auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists())",
      "No 'read' rule grants access; the deepest, at '/records/$recordId', evaluated to false",
    ]);

    const { matchedPath, reason, rtdbTrace, request } = (error as unknown as { denialContext: RtdbDenialContext })
      .denialContext;
    expect(matchedPath).toBe('/records/$recordId');
    expect(reason).toBe(denials[0].reason);
    expect(rtdbTrace?.length).toBe(2);
    expect(request).toEqual({ method: 'get', path: '/records/r1' });
  });

  test('an update case judges every path it writes', () => {
    const twoOwners = {
      records: {
        r1: { ownerId: 'alice', title: 'Quarterly plan' },
        r2: { ownerId: 'bob', title: 'Roadmap' },
      },
    };
    const summary = rules.simulate([
      { description: 'owner retitles her record', expectation: 'ALLOW', operation: 'update', path: '/records', auth: 'alice', data: twoOwners, newData: { 'r1/title': 'Final plan' } },
      { description: "an update that also retitles another owner's record", expectation: 'DENY', operation: 'update', path: '/records', auth: 'alice', data: twoOwners, newData: { 'r1/title': 'Final plan', 'r2/title': 'Mine now' } },
    ]);
    expect([summary.passed, summary.failed, summary.unsupported]).toEqual([2, 0, 0]);
  });

  test('a read case with a query evaluates query rules', () => {
    const listed = rtdbRules({
      rules: {
        records: {
          '.indexOn': ['ownerId'],
          '.read': "auth != null && query.orderByChild == 'ownerId' && query.equalTo == auth.uid",
        },
      },
    });
    const summary = listed.simulate([
      { description: 'alice lists her own records', expectation: 'ALLOW', operation: 'read', path: '/records', auth: 'alice', query: { orderByChild: 'ownerId', equalTo: 'alice' } },
      { description: 'alice cannot read every record', expectation: 'DENY', operation: 'read', path: '/records', auth: 'alice' },
    ]);
    expect([summary.passed, summary.failed, summary.unsupported]).toEqual([2, 0, 0]);
    expect(summary.coverage.uncovered).toEqual([]);
    expect(summary.coverage.missingIndexes).toEqual([]);
  });

  test('coverage prints each rule node with its line', () => {
    const summary = rules.simulate(cases);
    const source = JSON.stringify(rules.toJSON(), null, 2);
    expect(renderRtdbCoverage(rules.coverage(summary.cases, { file: 'database.rules.json', source }))).toBe(COVERAGE);
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
        d: { '.read': 'auth.uid', '.write': "auth != null && 'a' == 'b'" },
        e: { '.read': 'auth != null && data.val() > true', '.write': 'auth != null && data.child(1).exists()' },
        f: { '.read': 'auth != null && 1.foo == 1', '.write': "auth != null && auth.uid() == 'x'" },
        g: { '.read': 'auth != null && data.val()[data.val()] == 1', '.write': "auth != null && ['a'] == 1" },
        h: { '.read': "auth != null && data.val().matches(/x/g)", '.write': "auth != null && $nope == 'x'" },
      },
    }).lint();
    const codes = (severity: string) => [...new Set(issues.filter((i) => i.severity === severity).map((i) => i.code))].sort();
    expect(codes('error')).toEqual(
      expect.arrayContaining([
        'INVALID_ARGUMENT',
        'INVALID_OPERAND',
        'INVALID_PROPERTY_ACCESS',
        'INVALID_REGEX',
        'NEWDATA_IN_READ',
        'NOT_A_FUNCTION',
        'NOT_AN_OBJECT',
        'NOT_BOOLEAN',
        'NO_SUCH_MEMBER',
        'PARSE_ERROR',
        'UNEXPECTED_ARRAY',
        'UNKNOWN_IDENTIFIER',
      ]),
    );
    expect(codes('warning')).toEqual(
      expect.arrayContaining(['CONSTANT_COMPARISON', 'DATA_IN_WRITE', 'HARDCODED_FALSE', 'HARDCODED_TRUE']),
    );
    const notBoolean = issues.find((i) => i.code === 'NOT_BOOLEAN')!;
    expect(notBoolean).toMatchObject({ path: '/d', rule: '.read', message: 'Expression must evaluate to a boolean.' });
  });

  test('lint reports the shape codes, with no rule, and the inferred forms as warnings', () => {
    const issues = rtdbRules({
      rules: {
        rooms: { $x: { '.read': 'auth != null' }, $y: {} },
        n: { '.read': 5 },
        i: { '.indexOn': 5 },
        'k#': {},
        s: { child: 'x' },
        w: { '.indexOn': [1] },
        'k.v': {},
      },
    }).lint();
    const shape = issues.filter((i) =>
      ['MULTIPLE_WILDCARDS', 'RULE_NOT_EXPRESSION', 'INDEX_ON_SHAPE', 'INVALID_KEY', 'EXPECTED_OBJECT'].includes(i.code),
    );
    expect(shape.map((i) => `${i.code} ${i.severity} ${i.path}`).sort()).toEqual([
      'EXPECTED_OBJECT error /s',
      'INDEX_ON_SHAPE error /i',
      'INDEX_ON_SHAPE warning /w',
      'INVALID_KEY error /',
      'INVALID_KEY warning /',
      'MULTIPLE_WILDCARDS error /rooms',
      'RULE_NOT_EXPRESSION error /n',
    ]);
    for (const issue of shape) expect(issue.rule).toBeUndefined();
  });

  test('simulate does not run the deploy check: a .read of auth.uid grants a signed-in reader', () => {
    const [result] = rtdbRules({ rules: { x: { '.read': 'auth.uid' } } }).simulate([
      { expectation: 'DENY', operation: 'read', path: '/x', auth: 'a' },
    ]).cases;
    expect(result.decision).toBe('ALLOW');
  });

  test('a null operand of an ordering operator fails the rule', () => {
    const [result] = rtdbRules({ rules: { s: { '.read': "data.child('n').val() > 1" } } }).simulate([
      { expectation: 'DENY', operation: 'read', path: '/s' },
    ]).cases;
    expect(result.decision).toBe('DENY');
    expect(result.reason).toBe(
      "No 'read' rule grants access; the deepest, at '/s', failed at evaluation: Invalid > expression: left operand must be a number or string.",
    );
  });

  test('a request with no rule of its kind is denied by default', () => {
    const [result] = rtdbRules({ rules: { open: { '.read': 'auth != null' } } }).simulate([
      { expectation: 'DENY', operation: 'write', path: '/open', auth: 'a', newData: 1 },
    ]).cases;
    expect([result.matchedPath, result.matchedRule, result.reason]).toEqual([
      '',
      '',
      "No 'write' rule on '/open' or its ancestors grants access; denied by default",
    ]);
  });

  test('ruleset lint reports the security codes the lint page lists', () => {
    const exposed = rtdbRules({
      rules: {
        '.read': true,
        records: { $id: { '.write': "auth != null && newData.val() != null", '.validate': "newData.hasChild('title')", title: { '.validate': 'newData.isString()' } } },
        open: { '.write': true },
        anon: { '.write': "newData.isString() && newData.val().length < 10" },
        deletable: { '.write': 'auth != null', '.validate': "data.exists() && newData.isString()" },
        shielded: { '.read': true, inner: { '.read': false } },
      },
    }).lint();
    const security = issues_codes(exposed).filter((c) => c.startsWith('RTDB-SEC-'));
    expect(security).toEqual(['RTDB-SEC-1', 'RTDB-SEC-2', 'RTDB-SEC-3', 'RTDB-SEC-4', 'RTDB-SEC-5', 'RTDB-SEC-6', 'RTDB-SEC-7']);
    const finding = exposed.find((i) => i.code === 'RTDB-SEC-7')!;
    expect(finding.severity).toBe('warning');
    expect(finding.rule).toBe('.validate');
    expect(typeof finding.fix).toBe('string');
    expect(exposed.find((i) => i.code === 'RTDB-SEC-1')!.severity).toBe('error');
  });

  test('the trace lists the rules the simulator ran, root first', () => {
    const [result] = rules.simulate([cases[5]]).cases;
    expect(result.trace.map((t) => `${t.path} .${t.kind} -> ${t.verdict}`)).toEqual([
      '/ .write -> DENY',
      '/records/$recordId .write -> ALLOW',
      '/records/$recordId .validate -> ALLOW',
      '/records/$recordId/title .validate -> DENY',
    ]);
  });

  test('the lint page prints each trace step with its condition', () => {
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
      { expectation: 'DENY', operation: 'write', path: '/records/r1', auth: 'alice', newData: { ownerId: 'alice', title: 'x'.repeat(81) } },
    ]);
    expect(results[0].trace.map((step) => `${step.path} .${step.kind} -> ${step.verdict}: ${step.conditionText}`)).toEqual([
      '/ .write -> DENY: false',
      '/records/$recordId .write -> ALLOW: auth != null',
      "/records/$recordId .validate -> ALLOW: newData.hasChildren(['ownerId', 'title'])",
      '/records/$recordId/title .validate -> DENY: newData.isString() && newData.val().length <= 80',
    ]);
    expect(results[0].trace[3].pathVariableBindings).toEqual({ $recordId: 'r1' });
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

function issues_codes(issues: Array<{ code: string }>): string[] {
  return [...new Set(issues.map((i) => i.code))].sort();
}

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
