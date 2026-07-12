/**
 * ─── Scenario 5: map-get-string-and-list-form ─────────────────────────────────
 * Targets Item 3 of the rebuild plan — `Map.get(key, default)`, including
 * list-form for nested traversal. Pre-fix the simulator threw
 * UnsupportedError on `m.get(...)`, so every ALLOW case was a SIM_BUG via
 * silent DENY. Production behavior was locked in by the 0.H parity probe:
 * production *always* returns `default` on any walk failure (missing key,
 * missing intermediate, non-map intermediate). It never returns null from
 * a walk failure. This scenario mirrors all 8 probe scenarios as a parity
 * check against prod, plus a DENY witness for a present-key compare.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 3',
  rationale: 'Sim must implement Map.get(key, default) including list-form nested traversal; pre-fix it threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Single-key form, key present → returns value
    match /singleKeyPresentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get('a', 'DEF') == 'X';
    }
    // Single-key form, key absent → returns default
    match /singleKeyAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get('z', 'DEF') == 'DEF';
    }
    // List-form, full path present → returns leaf
    match /listLeafPresentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b','c'], 'DEF') == 'X';
    }
    // List-form, leaf missing under existing parent → returns default
    match /listLeafAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b','z'], 'DEF') == 'DEF';
    }
    // List-form, intermediate missing → returns default
    match /listMidAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','z','c'], 'DEF') == 'DEF';
    }
    // List-form, top-level key missing → returns default
    match /listParentAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['z','b','c'], 'DEF') == 'DEF';
    }
    // List-form, intermediate is a string (cannot descend) → returns default
    match /listMidStringAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b'], 'DEF') == 'DEF';
    }
    // List-form, intermediate is an int (cannot descend) → returns default
    match /listMidIntAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b'], 'DEF') == 'DEF';
    }
    // DENY witness — present-key compare against wrong value should fail
    match /singleKeyPresentDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get('a', 'DEF') == 'WRONG';
    }
  }
}`,
  cases: [
    {
      description: 'single-key present → returns value ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'singleKeyPresentAllow/d1',
      auth: { uid: 'alice' },
      data: { m: { a: 'X' } },
    },
    {
      description: 'single-key absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'singleKeyAbsentAllow/d2',
      auth: { uid: 'alice' },
      data: { m: { a: 'X' } },
    },
    {
      description: 'list-form leaf present → returns leaf ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listLeafPresentAllow/d3',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form leaf absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listLeafAbsentAllow/d4',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form intermediate absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidAbsentAllow/d5',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form top-level absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listParentAbsentAllow/d6',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form intermediate is string → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidStringAllow/d7',
      auth: { uid: 'alice' },
      data: { m: { a: 'leaf-string' } },
    },
    {
      description: 'list-form intermediate is int → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidIntAllow/d8',
      auth: { uid: 'alice' },
      data: { m: { a: 7 } },
    },
    {
      description: 'present-key compare against wrong value DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'singleKeyPresentDeny/d9',
      auth: { uid: 'alice' },
      data: { m: { a: 'X' } },
    },
  ],
  group: 'stress',
};
