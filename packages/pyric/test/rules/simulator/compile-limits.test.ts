/**
 * The Firestore simulator refuses a ruleset production rejects at compile
 * time, and evaluates one production compiles, for every probe in the Rules
 * Test API compile-limit capture.
 */
import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../../src/rules/api/firestore.js';
import { RulesCompileError } from '../../../src/rules/api/errors.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { simulateDeployedRules } from '../../../src/firestore/sandbox/rules-simulator.js';
import type { TestCase } from '../../../src/rules/test/spec.js';
import { compileLimitProbes } from '../compile-limits-probes.js';

const probes = compileLimitProbes().filter((p) => p.service === 'firestore');

/** The capture's two cases: uid a is granted by a working probe, uid b is denied. */
function cases(path: string): TestCase[] {
  return [
    { description: 'uid a', expectation: 'ALLOW', method: 'get', path: `${path}/d1`, auth: { uid: 'a' } },
    { description: 'uid b', expectation: 'DENY', method: 'get', path: `${path}/d1`, auth: { uid: 'b' } },
  ] as TestCase[];
}

function compileError(source: string): RulesCompileError {
  try {
    firestoreRules(source);
  } catch (e) {
    if (e instanceof RulesCompileError) return e;
    throw e;
  }
  throw new Error('firestoreRules accepted the ruleset');
}

describe('Firestore simulator: production compile limits', () => {
  test('the capture holds the three rejected shapes and the 21-function control', () => {
    const shapes = new Set(probes.filter((p) => !p.compiles).map((p) => p.shape));
    expect([...shapes].sort()).toEqual(['and-nesting', 'call-depth', 'call-depth-uncalled', 'let-count', 'paren-literal', 'paren-nesting']);
    expect(probes.some((p) => p.shape === 'call-depth' && p.n === 21 && p.compiles && !p.range)).toBe(true);
  });

  for (const probe of probes.filter((p) => !p.compiles)) {
    test(`${probe.label}: firestoreRules throws with production's errors`, () => {
      const error = compileError(probe.source);
      expect(error.issues.map((i) => i.message)).toEqual(probe.errors);
      expect(error.issues.every((i) => i.severity === 'error' && i.origin === 'parse')).toBe(true);
    });

    test(`${probe.label}: simulate and the sandbox refuse it with production's first error`, () => {
      const handler = new SimulateFirestoreRulesHandler();
      const direct = handler.simulate(probe.source, cases('p'));
      expect(direct.success).toBe(false);
      if (direct.success) return;
      expect(direct.error.code).toBe('PARSE_FAILED');
      expect(direct.error.message).toContain(probe.errors[0]!);

      const rules = new RulesState(probe.source);
      expect(rules.ast()).toBeNull();
      const deployed = simulateDeployedRules(rules, handler, cases('p'), {});
      expect(deployed.success).toBe(false);
      if (!deployed.success) expect(deployed.error.message).toContain(probe.errors[0]!);
    });
  }

  for (const probe of probes.filter((p) => p.compiles)) {
    test(`${probe.label}: compiles and evaluates as production does`, () => {
      const summary = firestoreRules(probe.source).simulate(cases('p'));
      // A bare `true` grants both uids; every other probe grants only uid a.
      const expected = probe.shape === 'paren-literal' ? ['ALLOW', 'ALLOW'] : ['ALLOW', 'DENY'];
      expect(summary.cases.map((c) => c.decision)).toEqual(expected);
    });
  }
});

// The Rules Test API rejects a second definition of one function name in one
// match block or in service scope with "Function f is already defined.". A
// nested match block function that shadows an outer one compiles.
describe('Firestore simulator: a function defined twice in one scope', () => {
  const duplicates: ReadonlyArray<readonly [string, string, string]> = [
    ['one match block', `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function f() { return true; }
    function f() { return false; }
    match /p/{id} { allow read: if f(); }
  }
}`, 'Function f is already defined.'],
    ['service scope', `rules_version = '2';
service cloud.firestore {
  function g() { return true; }
  function g() { return false; }
  match /databases/{database}/documents {
    match /p/{id} { allow read: if g(); }
  }
}`, 'Function g is already defined.'],
  ];

  for (const [scope, source, message] of duplicates) {
    test(`${scope}: firestoreRules, simulate and the sandbox refuse it with production's error`, () => {
      expect(compileError(source).issues.map((i) => i.message)).toEqual([message]);

      const handler = new SimulateFirestoreRulesHandler();
      const direct = handler.simulate(source, cases('p'));
      expect(direct.success).toBe(false);
      if (!direct.success) expect(direct.error.message).toContain(message);

      const rules = new RulesState(source);
      expect(rules.ast()).toBeNull();
      const deployed = simulateDeployedRules(rules, handler, cases('p'), {});
      expect(deployed.success).toBe(false);
      if (!deployed.success) expect(deployed.error.message).toContain(message);
    });
  }

  test('a nested match block function that shadows an outer one compiles', () => {
    const summary = firestoreRules(`rules_version = '2';
service cloud.firestore {
  function f() { return false; }
  match /databases/{database}/documents {
    function f() { return request.auth.uid == 'a'; }
    match /p/{id} { allow read: if f(); }
  }
}`).simulate(cases('p'));
    expect(summary.cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY']);
  });
});
