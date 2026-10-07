/**
 * The public `pyric/rules` front door.
 *
 * Exercises both constructors, the tolerant free `lint`, the assertion
 * adapter, and the structured trace shapes — the whole curated surface a
 * consumer sees. Uses the owner's canonical two-case `notes/n1` scenario:
 * an owner-scoped notes collection where the owner may read and a stranger
 * may not.
 */
import { describe, test, expect } from 'bun:test';
import {
  firestoreRules,
  rtdbRules,
  lint,
  assertCase,
  explainCase,
  RulesCompileError,
  RulesAssertionError,
  RulesUnsupportedError,
  serverTimestamp,
  timestamp,
  defineRtdbRules,
  allow,
  deny,
  expr,
  type FirestoreCase,
  type RtdbCase,
  type RuleIssue,
} from 'pyric/rules';

const NOTES_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow read, write: if request.auth != null
        && request.auth.uid == resource.data.owner;
      allow create: if request.auth != null
        && request.auth.uid == request.resource.data.owner;
    }
  }
}`;

const MISSING_RESOURCE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /documents/{id} {
      allow get, update, delete: if resource != null;
    }
    match /nullGuard/{id} {
      allow get: if resource == null;
    }
  }
}`;

// The owner's canonical two-case scenario for the note `notes/n1`.
const N1_OWNER: FirestoreCase = {
  description: 'owner reads their own note',
  expectation: 'ALLOW',
  method: 'get',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  resource: { owner: 'alice', body: 'hello' },
};
const N1_STRANGER: FirestoreCase = {
  description: 'stranger cannot read the note',
  expectation: 'DENY',
  method: 'get',
  path: 'notes/n1',
  auth: { uid: 'mallory' },
  resource: { owner: 'alice', body: 'hello' },
};

describe('firestoreRules constructor', () => {
  test('compiles good source and simulates both canonical cases', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const summary = ruleset.simulate([N1_OWNER, N1_STRANGER]);

    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.unsupported).toBe(0);
    expect(summary.cases).toHaveLength(2);

    const [owner, stranger] = summary.cases;
    expect(owner.passed).toBe(true);
    expect(owner.decision).toBe('ALLOW');
    expect(stranger.passed).toBe(true);
    expect(stranger.decision).toBe('DENY');
  });

  test('simulate never throws on a failing case — the miss is data', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    // Assert the wrong expectation: the stranger is denied, but claim ALLOW.
    const wrong: FirestoreCase = { ...N1_STRANGER, expectation: 'ALLOW' };
    const summary = ruleset.simulate([wrong]);
    expect(summary.failed).toBe(1);
    expect(summary.cases[0].passed).toBe(false);
    expect(summary.cases[0].decision).toBe('DENY');
  });

  test('a missing document never satisfies a resource existence guard', () => {
    const summary = firestoreRules(MISSING_RESOURCE_RULES).simulate([
      {
        description: 'missing document get',
        expectation: 'DENY',
        method: 'get',
        path: 'documents/missing-get',
      },
      {
        description: 'missing document update',
        expectation: 'DENY',
        method: 'update',
        path: 'documents/missing-update',
        data: { value: 'after' },
      },
      {
        description: 'missing document delete',
        expectation: 'DENY',
        method: 'delete',
        path: 'documents/missing-delete',
      },
      {
        description: 'existing document get',
        expectation: 'ALLOW',
        method: 'get',
        path: 'documents/existing',
        resource: { value: 'before' },
      },
    ]);

    expect(summary.cases.map((result) => result.decision)).toEqual([
      'DENY',
      'DENY',
      'DENY',
      'ALLOW',
    ]);
  });

  test('a missing document does not make resource comparable to null', () => {
    const summary = firestoreRules(MISSING_RESOURCE_RULES).simulate([
      {
        description: 'missing document null comparison',
        expectation: 'DENY',
        method: 'get',
        path: 'nullGuard/missing',
      },
    ]);

    expect(summary.cases[0].decision).toBe('DENY');
  });

  test('throws RulesCompileError with .issues on unparseable source', () => {
    let thrown: unknown;
    try {
      firestoreRules('service cloud.firestore { this is not rules }');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RulesCompileError);
    const err = thrown as RulesCompileError;
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.issues[0].origin).toBe('parse');
    expect(err.issues[0].severity).toBe('error');
  });

  test('explain returns a structured trace for a single case', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const explanation = ruleset.explain(N1_STRANGER);
    expect(explanation.decision).toBe('DENY');
    expect(explanation.passed).toBe(true);
    expect(Array.isArray(explanation.trace)).toBe(true);
    // The trace carries per-rule evaluations with a machine-readable verdict.
    expect(explanation.trace.length).toBeGreaterThan(0);
    for (const entry of explanation.trace) {
      expect(['ALLOW', 'DENY', 'UNSUPPORTED', 'ERROR']).toContain(entry.verdict);
      expect(Array.isArray(entry.operations)).toBe(true);
    }
    // Path resolution is present as plain data.
    expect(explanation.pathResolution?.requestPath).toBe('notes/n1');
  });

  test('lint() on a compiled ruleset returns unified issues (no parse errors)', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const issues = ruleset.lint();
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) {
      expect(issue.origin === 'lint' || issue.origin === 'validate').toBe(true);
    }
  });

  test('toJSON returns the parsed ruleset as plain data', () => {
    const ast = firestoreRules(NOTES_RULES).toJSON();
    expect(ast.service.match).toBeDefined();
    expect(JSON.parse(JSON.stringify(ast))).toBeTruthy();
  });
});

describe('tolerant lint(source)', () => {
  test('never throws on garbage and reports a parse error', () => {
    const issues: RuleIssue[] = lint('service cloud.firestore { garbage');
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.some((i) => i.origin === 'parse')).toBe(true);
  });

  test('accepts an empty string without throwing', () => {
    expect(() => lint('')).not.toThrow();
    expect(Array.isArray(lint(''))).toBe(true);
  });

  test('parseable source yields lint/validate issues, not parse errors', () => {
    const issues = lint(NOTES_RULES);
    expect(issues.every((i) => i.origin !== 'parse')).toBe(true);
  });
});

describe('assertion adapter (assertCase / explainCase)', () => {
  test('assertCase(ruleset, oneCase) passes silently for good cases — runner wiring', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    for (const c of [N1_OWNER, N1_STRANGER]) {
      expect(() => assertCase(ruleset, c)).not.toThrow();
    }
  });

  test('assertCase(source, oneCase) accepts Firestore source directly', () => {
    expect(() => assertCase(NOTES_RULES, N1_OWNER)).not.toThrow();
  });

  test('assertCase(ruleset, oneCase) throws RulesAssertionError with the explainCase trace on a miss', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const wrong: FirestoreCase = { ...N1_STRANGER, expectation: 'ALLOW' };
    let thrown: unknown;
    try {
      assertCase(ruleset, wrong);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RulesAssertionError);
    expect((thrown as Error).message).toContain('expected ALLOW, got DENY');
    expect((thrown as Error).message).toContain('notes/n1');
  });

  test('assertCase throws RulesUnsupportedError on a simulator abstention', () => {
    // foo.bar() is not a real rules namespace — the simulator abstains
    // (UNSUPPORTED) rather than deciding, and the adapter surfaces that as
    // its own error type so a runner can skip instead of fail.
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read: if foo.bar();
    }
  }
}`);
    const abstain: FirestoreCase = {
      description: 'unsupported namespace abstains',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'alice' },
    };
    expect(() => assertCase(ruleset, abstain)).toThrow(RulesUnsupportedError);
    // The result form throws the same way.
    const result = ruleset.simulate([abstain]).cases[0];
    expect(() => assertCase(result)).toThrow(RulesUnsupportedError);
  });

  test('assertCase(result) throws on a failed result and passes a good one', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const good = ruleset.simulate([N1_OWNER]).cases[0];
    expect(() => assertCase(good)).not.toThrow();

    const bad = ruleset.simulate([{ ...N1_STRANGER, expectation: 'ALLOW' }]).cases[0];
    expect(() => assertCase(bad)).toThrow(RulesAssertionError);
  });

  test('assertCase(rtdbRuleset, oneCase) covers the RTDB overload', () => {
    const ruleset = rtdbRules({
      paths: { '/notes/$noteId': { read: allow(), write: deny() } },
    });
    const readCase: RtdbCase = {
      description: 'anyone reads a note',
      expectation: 'ALLOW',
      operation: 'read',
      path: '/notes/n1',
      auth: { uid: 'alice' },
    };
    expect(() => assertCase(ruleset, readCase)).not.toThrow();
    const wrong: RtdbCase = { ...readCase, expectation: 'DENY' };
    expect(() => assertCase(ruleset, wrong)).toThrow(RulesAssertionError);
  });

  test('explainCase renders a readable multi-line trace', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const result = ruleset.simulate([N1_OWNER]).cases[0];
    const text = explainCase(result);
    expect(typeof text).toBe('string');
    expect(text).toContain('notes/n1');
    expect(text).toContain('PASS');
  });
});

describe('rtdbRules constructor', () => {
  const def = {
    paths: {
      '/notes/$noteId': { read: allow(), write: deny() },
    },
  };

  test('accepts an RtdbRulesDefinition and compiles to rules.json', () => {
    const ruleset = rtdbRules(def);
    const json = ruleset.toJSON();
    expect(json.rules).toBeDefined();
  });

  test('accepts the value defineRtdbRules returns', () => {
    const doc = defineRtdbRules(def);
    const ruleset = rtdbRules(doc);
    expect(ruleset.toJSON().rules).toBeDefined();
  });

  test('simulates compiled { rules } JSON directly', () => {
    const compiled = { rules: { '.read': 'auth != null', '.write': false } };
    const ruleset = rtdbRules(compiled);
    expect(ruleset.toJSON()).toEqual(compiled);
    expect(ruleset.simulate([
      {
        description: 'signed-in user reads',
        expectation: 'ALLOW',
        operation: 'read',
        path: '/notes/n1',
        auth: { uid: 'alice' },
      },
      {
        description: 'anonymous user cannot read',
        expectation: 'DENY',
        operation: 'read',
        path: '/notes/n1',
        auth: null,
      },
    ]).cases.map((result) => result.decision)).toEqual(['ALLOW', 'DENY']);
  });

  test('lint() surfaces check findings and security findings as unified issues', () => {
    const ruleset = rtdbRules(def);
    const issues = ruleset.lint();
    expect(issues).toEqual([
      expect.objectContaining({ code: 'HARDCODED_TRUE', origin: 'lint', path: '/notes/$noteId', rule: '.read' }),
      expect.objectContaining({ code: 'HARDCODED_FALSE', origin: 'lint', path: '/notes/$noteId', rule: '.write' }),
      expect.objectContaining({ code: 'RTDB-SEC-2', origin: 'validate', path: '/notes/$noteId', rule: '.read' }),
    ]);
  });

  test('lint() on compiled { rules } JSON reports an expression that does not parse', () => {
    const json = { rules: { notes: { $id: { '.write': 'auth != null && (' } } } };
    const issues = rtdbRules(json).lint();
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'PARSE_ERROR',
      severity: 'error',
      path: '/notes/$id',
    }));
  });

  test('lint() on compiled { rules } JSON reports what lint() on the definition it came from reports', () => {
    const withFindings = {
      paths: {
        '/notes/$noteId': { read: expr('true'), write: expr('auth != null && (') },      },
    };
    const fromDefinition = rtdbRules(withFindings).lint();
    const fromJson = rtdbRules(rtdbRules(withFindings).toJSON()).lint();
    expect(fromDefinition.some((issue) => issue.severity === 'error')).toBe(true);
    expect(fromDefinition.some((issue) => issue.severity === 'warning')).toBe(true);
    expect(fromJson).toEqual(fromDefinition);
  });

  test('lint() on JSON whose rules key is not an object reports a compile error', () => {
    const issues = rtdbRules({ rules: 5 as unknown as Record<string, unknown> }).lint();
    expect(issues).toEqual([expect.objectContaining({ code: 'COMPILE_ERROR', severity: 'error', path: '/' })]);
  });

  test('simulate() runs RTDB cases and never throws', () => {
    const ruleset = rtdbRules(def);
    const cases: RtdbCase[] = [
      {
        description: 'anyone reads a note',
        expectation: 'ALLOW',
        operation: 'read',
        path: '/notes/n1',
        auth: { uid: 'alice' },
      },
      {
        description: 'nobody writes a note',
        expectation: 'DENY',
        operation: 'write',
        path: '/notes/n1',
        auth: { uid: 'alice' },
        newData: { owner: 'alice' },
      },
    ];
    const summary = ruleset.simulate(cases);
    expect(summary.cases).toHaveLength(2);
    expect(summary.passed + summary.failed + summary.unsupported).toBe(2);
  });

  test('a definition handle compiles the definition once across lint, simulate, explain, and toJSON', () => {
    let compiles = 0;
    const handle = rtdbRules(defineRtdbRules({
      paths: (ctx) => {
        compiles++;
        ctx.path('/notes/$noteId', { read: allow(), write: expr('auth != null') });
      },
    }));
    const cases: RtdbCase[] = Array.from({ length: 5 }, (_, i) => ({
      expectation: i % 2 === 0 ? 'ALLOW' : 'DENY',
      operation: 'write',
      path: `/notes/n${i}`,
      auth: i % 2 === 0 ? 'u' : null,
      newData: { body: 'x' },
    }));
    expect(handle.simulate(cases).passed).toBe(cases.length);
    handle.simulate(cases);
    handle.lint();
    handle.explain(cases[0]!);
    handle.toJSON();
    expect(compiles).toBe(1);
  });

  test('a definition handle and the JSON handle made from it return the same simulate verdicts', () => {
    const definition = {
      paths: {
        '/notes/$noteId': {
          read: expr('auth != null'),
          write: expr("auth != null && newData.child('owner').val() === auth.uid"),
          validate: expr("newData.hasChildren(['owner'])"),
        },
      },
    };
    const fromDefinition = rtdbRules(defineRtdbRules(definition));
    const fromJson = rtdbRules(fromDefinition.toJSON());
    const cases: RtdbCase[] = [
      { expectation: 'ALLOW', operation: 'read', path: '/notes/n1', auth: 'u' },
      { expectation: 'DENY', operation: 'read', path: '/notes/n1', auth: null },
      { expectation: 'ALLOW', operation: 'write', path: '/notes/n1', auth: 'u', newData: { owner: 'u' } },
      { expectation: 'DENY', operation: 'write', path: '/notes/n1', auth: 'u', newData: { owner: 'v' } },
      { expectation: 'DENY', operation: 'write', path: '/notes/n1', auth: 'u', newData: { body: 'x' } },
    ];
    const definitionSummary = fromDefinition.simulate(cases);
    expect(definitionSummary.passed).toBe(cases.length);
    expect(fromJson.simulate(cases)).toEqual(definitionSummary);
  });

  test('simulate() honors an explicit now against a now-gated rule', () => {
    const gated = {
      paths: {
        '/events/$eventId': { read: expr('now > 1000'), write: deny() },
      },
    };
    const ruleset = rtdbRules(gated);
    const before = ruleset.simulate([
      {
        expectation: 'DENY',
        operation: 'read',
        path: '/events/e1',
        auth: { uid: 'alice' },
        now: 500,
      },
    ]).cases[0]!;
    const after = ruleset.simulate([
      {
        expectation: 'ALLOW',
        operation: 'read',
        path: '/events/e1',
        auth: { uid: 'alice' },
        now: 1500,
      },
    ]).cases[0]!;
    expect(before.decision).toBe('DENY');
    expect(after.decision).toBe('ALLOW');
  });
});

describe('value helpers', () => {
  test('serverTimestamp and timestamp produce case-ready values', () => {
    const st = serverTimestamp();
    expect(st).toEqual({ __type: 'serverTimestamp' });
    const ts = timestamp('2026-01-01T00:00:00Z');
    expect(ts).toBeTruthy();
    // A rule comparing data.createdAt to request.time resolves the sentinel.
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /logs/{id} {
      allow create: if request.resource.data.at == request.time;
    }
  }
}`);
    const summary = ruleset.simulate([
      {
        description: 'serverTimestamp resolves to request.time',
        expectation: 'ALLOW',
        method: 'create',
        path: 'logs/l1',
        auth: { uid: 'alice' },
        data: { at: serverTimestamp() },
      },
    ]);
    expect(summary.passed).toBe(1);
  });
});
