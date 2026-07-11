/**
 * The public `pyric/rules` front door.
 *
 * Exercises both constructors, the tolerant free `lint`, the assertion
 * adapters, and the structured trace shapes — the whole curated surface a
 * consumer sees. Uses the owner's canonical two-case `notes/n1` scenario:
 * an owner-scoped notes collection where the owner may read and a stranger
 * may not.
 */
import { describe, test, expect } from 'bun:test';
import {
  firestoreRules,
  rtdbRules,
  lint,
  eachCase,
  assertCase,
  explainCase,
  RulesCompileError,
  RulesAssertionError,
  serverTimestamp,
  timestamp,
  defineRtdbRules,
  allow,
  deny,
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

describe('assertion adapters (eachCase / assertCase / explainCase)', () => {
  test('eachCase yields one runnable per case; run() passes for good cases', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const runners = eachCase(ruleset, [N1_OWNER, N1_STRANGER]);
    expect(runners).toHaveLength(2);
    expect(runners[0].name).toBe(N1_OWNER.description);
    for (const r of runners) expect(() => r.run()).not.toThrow();
  });

  test('eachCase accepts a source string directly', () => {
    const runners = eachCase(NOTES_RULES, [N1_OWNER]);
    expect(() => runners[0].run()).not.toThrow();
  });

  test('run() throws RulesAssertionError with the explainCase trace on a miss', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const wrong: FirestoreCase = { ...N1_STRANGER, expectation: 'ALLOW' };
    const [runner] = eachCase(ruleset, [wrong]);
    let thrown: unknown;
    try {
      runner.run();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RulesAssertionError);
    expect((thrown as Error).message).toContain('expected ALLOW, got DENY');
  });

  test('assertCase(result) throws on a failed result and passes a good one', () => {
    const ruleset = firestoreRules(NOTES_RULES);
    const good = ruleset.simulate([N1_OWNER]).cases[0];
    expect(() => assertCase(good)).not.toThrow();

    const bad = ruleset.simulate([{ ...N1_STRANGER, expectation: 'ALLOW' }]).cases[0];
    expect(() => assertCase(bad)).toThrow(RulesAssertionError);
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

  test('accepts compiled { rules } JSON (round-trip only)', () => {
    const compiled = { rules: { '.read': true, '.write': false } };
    const ruleset = rtdbRules(compiled);
    expect(ruleset.toJSON()).toEqual(compiled);
    expect(ruleset.lint()).toEqual([]);
  });

  test('lint() surfaces check findings as unified issues', () => {
    const ruleset = rtdbRules(def);
    const issues = ruleset.lint();
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) expect(issue.origin).toBe('validate');
  });

  test('simulate() runs RTDB cases and never throws', () => {
    const ruleset = rtdbRules(def);
    const cases: RtdbCase[] = [
      {
        description: 'anyone reads a note',
        expect: 'allow',
        operation: 'read',
        path: '/notes/n1',
        auth: { uid: 'alice' },
      },
      {
        description: 'nobody writes a note',
        expect: 'deny',
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
