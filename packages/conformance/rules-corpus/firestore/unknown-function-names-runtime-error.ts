/**
 * ─── Scenario: unknown-function-names-runtime-error ──────────────────────────
 * Production compiles a ruleset that calls a name the Firestore rules library
 * does not define (`debug()`, `Map.hasAny()`, `Map.hasOnly()`, an unknown
 * method or global) and fails the call at evaluation with "Function not found
 * error". The failure is an ordinary evaluation error: it denies on its own
 * and is absorbed by `|| true`, like any other runtime error. The acceptance
 * probes for firestore.function.debug, firestore.method.map.hasAny and
 * firestore.method.map.hasOnly record the rejection message; these cases
 * record the verdicts, with and without absorption.
 */
import type { ScenarioRecord } from './types.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /debug/{id} {
      allow get: if debug(resource.data.a) == 1;
    }
    match /debugAbsorbed/{id} {
      allow get: if debug(resource.data.a) == 1 || true;
    }
    match /hasAny/{id} {
      allow get: if resource.data.hasAny(['a']);
    }
    match /hasAnyAbsorbed/{id} {
      allow get: if resource.data.hasAny(['a']) || true;
    }
    match /hasOnly/{id} {
      allow get: if resource.data.hasOnly(['a']);
    }
    match /hasOnlyAbsorbed/{id} {
      allow get: if resource.data.hasOnly(['a']) || true;
    }
    match /hasOnlyFalseAnd/{id} {
      allow get: if !(resource.data.hasOnly(['a']) && false);
    }
    match /unknownMethod/{id} {
      allow get: if resource.data.a.frobnicate() || true;
    }
    match /unknownGlobal/{id} {
      allow get: if frobnicate(resource.data.a) || true;
    }
  }
}`;

function getCase(collection: string, expectation: 'ALLOW' | 'DENY', description: string) {
  return {
    description,
    expectation,
    method: 'get' as const,
    path: `${collection}/d1`,
    resource: { a: 1 },
  };
}

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'Coverage: unknown function names',
  rationale:
    'An unknown function or method name compiles and fails at evaluation; the error denies alone and is absorbed by || true and by && false.',
  rules: RULES,
  cases: [
    getCase('debug', 'DENY', 'debug() call DENY (function not found)'),
    getCase('debugAbsorbed', 'ALLOW', 'debug() || true ALLOW (error absorbed)'),
    getCase('hasAny', 'DENY', 'map.hasAny DENY (function not found)'),
    getCase('hasAnyAbsorbed', 'ALLOW', 'map.hasAny || true ALLOW (error absorbed)'),
    getCase('hasOnly', 'DENY', 'map.hasOnly DENY (function not found)'),
    getCase('hasOnlyAbsorbed', 'ALLOW', 'map.hasOnly || true ALLOW (error absorbed)'),
    getCase('hasOnlyFalseAnd', 'ALLOW', '!(map.hasOnly && false) ALLOW (error absorbed by && false)'),
    getCase('unknownMethod', 'ALLOW', 'unknown method || true ALLOW (error absorbed)'),
    getCase('unknownGlobal', 'ALLOW', 'unknown global || true ALLOW (error absorbed)'),
  ],
};
