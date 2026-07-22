/**
 * ─── Scenario 7: set-algebra-difference-union-intersection ────────────────────
 * Targets Item 5.1 of the rebuild plan — Set.difference / union /
 * intersection. The hosted production Test API accepts the ruleset but reports
 * Function-not-found evaluation errors when the receiver is Map.keys() (a
 * List), while explicit List.toSet() receivers implement all three methods.
 * The paired shapes make the receiver-type boundary distinguishable.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 5.1',
  rationale: 'Production distinguishes Map.keys() List receivers (no set algebra) from explicit List.toSet() Set receivers (difference/union/intersection supported); paired cases lock the boundary.',
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
    // Positive Set witnesses — explicit toSet() receivers.
    match /toSetDiffAllow/{id} {
      allow create: if [1, 2].toSet().difference([1].toSet()).hasOnly([2]);
    }
    match /toSetUnionAllow/{id} {
      allow create: if [1].toSet().union([2].toSet()).hasOnly([1, 2]);
    }
    match /toSetInterAllow/{id} {
      allow create: if [1, 2].toSet().intersection([2].toSet()).hasOnly([2]);
    }
    match /toSetDiffDeny/{id} {
      allow create: if [1, 2].toSet().difference([1].toSet()).size() == 99;
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
    {
      description: 'explicit toSet difference ALLOW', expectation: 'ALLOW', method: 'create',
      path: 'toSetDiffAllow/d9', auth: null, data: {},
    },
    {
      description: 'explicit toSet union ALLOW', expectation: 'ALLOW', method: 'create',
      path: 'toSetUnionAllow/d10', auth: null, data: {},
    },
    {
      description: 'explicit toSet intersection ALLOW', expectation: 'ALLOW', method: 'create',
      path: 'toSetInterAllow/d11', auth: null, data: {},
    },
    {
      description: 'explicit toSet difference wrong size DENY', expectation: 'DENY', method: 'create',
      path: 'toSetDiffDeny/d12', auth: null, data: {},
    },
  ],
  group: 'stress',
};
