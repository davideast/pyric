/**
 * ─── Scenario 6: range-slice-list-and-string ──────────────────────────────────
 * Targets Item 4 of the rebuild plan — range slice `[i:j]` for List and
 * String. Pre-fix the simulator threw a parse error on slice syntax (the
 * grammar's `bracketAccess` only matched a single Expr). This scenario
 * exercises the documented surface: j-exclusive sub-list / substring,
 * OOB rejection behavior, empty slice (i==j), and DENY witnesses.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 4',
  rationale: 'Sim must parse and evaluate range slice [i:j] for List and String; pre-fix grammar rejected the syntax outright.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // List slice — mid range
    match /listMidAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[1:3].size() == 2;
    }
    // List slice — value at slice index
    match /listValueAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[1:3][0] == 'b';
    }
    // List slice — full length
    match /listFullAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[0:4].size() == 4;
    }
    // List slice — i==j → empty
    match /listEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[2:2].size() == 0;
    }
    // List slice — end OOB is an evaluation error
    match /listClampAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[1:99].size() == 3;
    }
    // String slice — substring
    match /strSubAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[6:11] == 'world';
    }
    // String slice — prefix
    match /strPrefAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[0:5] == 'hello';
    }
    // String slice — empty (i==j)
    match /strEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[3:3] == '';
    }
    // String slice — end OOB is an evaluation error
    match /strClampAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[6:99] == 'world';
    }
    // DENY witness — list slice with wrong expected size
    match /listSliceDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[0:2].size() == 5;
    }
  }
}`,
  cases: [
    {
      description: 'list mid-slice → sub-list of size 2 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidAllow/d1',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'list slice indexing → element at slice[0] ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listValueAllow/d2',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'list full-length slice → size 4 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listFullAllow/d3',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'list slice [i:i] → empty ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listEmptyAllow/d4',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      // Immutable production-observation join key; the captured verdict is
      // DENY because production rejects the out-of-bounds end.
      description: 'list slice end OOB clamps to length ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'listClampAllow/d5',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'string mid-substring ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'strSubAllow/d6',
      auth: { uid: 'alice' },
      data: { s: 'hello world' },
    },
    {
      description: 'string prefix substring ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'strPrefAllow/d7',
      auth: { uid: 'alice' },
      data: { s: 'hello world' },
    },
    {
      description: 'string slice [i:i] → empty string ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'strEmptyAllow/d8',
      auth: { uid: 'alice' },
      data: { s: 'hello' },
    },
    {
      // Immutable production-observation join key; the captured verdict is
      // DENY because production rejects the out-of-bounds end.
      description: 'string slice end OOB clamps to length ALLOW',
      expectation: 'DENY',
      method: 'create',
      path: 'strClampAllow/d9',
      auth: { uid: 'alice' },
      data: { s: 'hello world' },
    },
    {
      description: 'list slice with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'listSliceDeny/d10',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c'] },
    },
  ],
  group: 'stress',
};
