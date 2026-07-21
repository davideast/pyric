/**
 * ─── Scenario 8: list-methods-concat-removeall-toset ──────────────────────────
 * Targets Item 5.2 of the rebuild plan — List.concat / removeAll / toSet.
 * Pre-fix all three threw UnsupportedError. toSet bridges into Set.* (5.1)
 * — a few cases chain through to verify the produced Set is fully usable.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 5.2',
  rationale: 'Sim must implement List.concat/removeAll/toSet; pre-fix all three threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // concat — basic
    match /concatAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(request.resource.data.b).size() == 4;
    }
    // concat — preserves order
    match /concatOrderAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['c'])[2] == 'c';
    }
    // concat — does NOT dedupe
    match /concatNoDedupAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['a','b']).size() == 4;
    }
    // removeAll — basic
    match /removeAllAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll(['b']).size() == 2;
    }
    // removeAll — removes all matching occurrences
    match /removeAllManyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll(['b']).size() == 2;
    }
    // removeAll — empty arg → identity
    match /removeAllEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll([]).size() == 3;
    }
    // toSet — dedupes
    match /toSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().size() == 3;
    }
    // toSet — chains to Set.difference (5.1 + 5.2 wiring)
    match /toSetChainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().difference(['a']).hasOnly(['b','c']);
    }
    // DENY witness — concat with wrong expected size
    match /concatDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['c']).size() == 99;
    }
  }
}`,
  cases: [
    {
      description: 'list concat → size 4 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatAllow/d1',
      auth: { uid: 'alice' },
      data: { a: ['x', 'y'], b: ['p', 'q'] },
    },
    {
      description: 'list concat preserves order ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatOrderAllow/d2',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
    {
      description: 'list concat does NOT dedupe ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatNoDedupAllow/d3',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
    {
      description: 'list removeAll basic ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllAllow/d4',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c'] },
    },
    {
      description: 'list removeAll removes all occurrences ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllManyAllow/d5',
      auth: { uid: 'alice' },
      data: { a: ['b', 'a', 'b', 'c'] },
    },
    {
      description: 'list removeAll empty arg → identity ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllEmptyAllow/d6',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c'] },
    },
    {
      description: 'list toSet dedupes ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'toSetAllow/d7',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c', 'a', 'b'] },
    },
    {
      description: 'list toSet().difference chain (5.1 wiring) ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'toSetChainAllow/d8',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c', 'a'] },
    },
    {
      description: 'list concat with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'concatDeny/d9',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
  ],
  group: 'stress',
};
