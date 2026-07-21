/**
 * ─── Scenario 7: set-algebra-difference-union-intersection ────────────────────
 * Targets Item 5.1 of the rebuild plan — Set.difference / union /
 * intersection. The hosted production Test API accepts the ruleset but reports
 * Function-not-found evaluation errors for all three methods. The scenario
 * retains intended-positive shapes, a Set-argument case, and a negative control
 * so that limitation is distinguishable from working algebra.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 5.1',
  rationale: 'Hosted production diagnostics report Function not found for Set.difference/union/intersection; retain intended-positive, Set-argument, and negative-control cases without claiming algebra conformance.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // difference — items in this not in other (list arg)
    match /diffListAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a','b']).hasOnly(['c']);
    }
    // difference — Set arg via .keys()
    match /diffSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.keys().difference(request.resource.data.b.keys()).hasOnly(['x']);
    }
    // union — items in either
    match /unionAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c','d']).size() == 4;
    }
    // union — overlap dedupes
    match /unionDedupAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['b','c']).size() == 3;
    }
    // intersection — items in both
    match /interAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().intersection(['b','c','d']).hasOnly(['b','c']);
    }
    // intersection — empty when no overlap
    match /interEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().intersection(['x','y']).size() == 0;
    }
    // chained: union then difference
    match /chainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c']).difference(['a']).hasOnly(['b','c']);
    }
    // DENY witness — wrong size after difference
    match /diffDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a']).size() == 99;
    }
  }
}`,
  cases: [
    {
      description: 'set difference (list arg) → hasOnly([c]) ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'diffListAllow/d1',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    },
    {
      description: 'set difference (set arg) → hasOnly([x]) ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'diffSetAllow/d2',
      auth: { uid: 'alice' },
      data: { a: { x: 1, y: 2 }, b: { y: 2, z: 3 } },
    },
    {
      description: 'set union → size 4 ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'unionAllow/d3',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'set union dedupes overlap → size 3 ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'unionDedupAllow/d4',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'set intersection → hasOnly([b,c]) ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'interAllow/d5',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    },
    {
      description: 'set intersection no overlap → empty ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'interEmptyAllow/d6',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'chained union+difference → hasOnly([b,c]) ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'chainAllow/d7',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'difference with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'diffDeny/d8',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
  ],
  group: 'stress',
};
